// Static scan of which runtime touches which Firestore collection, and whether it writes.
// Heuristic by design: regexes over source text, no AST. It resolves literal paths,
// `*_COLLECTION_ID` constants and one level of path-helper functions, and detects a write
// only when the reference (or the variable it was assigned to) is passed to
// set/update/create/delete. A ref handed to another function that writes is not seen.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const TEST_FILE = /\.test\.|\/test\/|Test\.java$/;
const CONST_RE = /\b([A-Z][A-Z0-9_]*COLLECTION(?:_ID|_NAME)?)\s*=\s*['"]([A-Za-z_]\w*)['"]/g;
const WRITE_VERBS = '(?:set|update|create|delete)';
const NON_COLLECTION = new Set(['orgs']);
// The JVM persistence class writes through its own wrappers rather than calling tx.set at each site.
const JAVA_WRITE_WRAPPER = '(?<![.\\w])(?:set|create|replaceDocument|replacePrivateDraftDocument)';

export function walk(root, extensions, repoRoot) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'target') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (extensions.some((ext) => name.endsWith(ext)) && !TEST_FILE.test(full)) {
        out.push({ path: relative(repoRoot, full), text: readFileSync(full, 'utf8') });
      }
    }
  };
  visit(join(repoRoot, root));
  return out;
}

function collectConstants(files) {
  const constants = new Map();
  for (const { text } of files) {
    for (const match of text.matchAll(CONST_RE)) constants.set(match[1], match[2]);
  }
  return constants;
}

function collectionsInLine(line, constants) {
  const found = new Set();
  const orgPath = /orgs\/(?:\$\{[^}]+\}|"\s*\+\s*[^+]+?\s*\+\s*"|\w+)\/(?:\$\{(\w+)\}|([A-Za-z_]\w*))/g;
  for (const match of line.matchAll(orgPath)) {
    const name = match[1] ? constants.get(match[1]) : match[2];
    if (name) found.add(name);
  }
  for (const match of line.matchAll(/\.collection\(\s*[`'"]([A-Za-z_]\w*)[`'"]/g)) found.add(match[1]);
  for (const match of line.matchAll(/\.(?:doc|document)\(\s*[`'"]([A-Za-z_]\w*)\//g)) found.add(match[1]);
  for (const name of NON_COLLECTION) found.delete(name);
  return found;
}

// name -> collection for functions that only build a path, e.g. cashflowMonthCloseRequestPath().
function collectPathHelpers(files, constants) {
  const helpers = new Map();
  const jsHelper = /(?:function\s+(\w+)|const\s+(\w+)\s*=)\s*\([^)]*\)\s*(?:=>)?\s*\{?\s*return\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
  for (const { path, text } of files) {
    if (path.endsWith('.java')) {
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        const method = /\b(?:DocumentReference|CollectionReference)\s+(\w+)\s*\(/.exec(line);
        if (!method) return;
        const cols = collectionsInLine(lines.slice(index, index + 8).join(' '), constants);
        if (cols.size === 1) helpers.set(method[1], [...cols][0]);
      });
      continue;
    }
    for (const match of text.matchAll(jsHelper)) {
      const cols = collectionsInLine(match[3], constants);
      if (cols.size === 1) helpers.set(match[1] || match[2], [...cols][0]);
    }
  }
  return helpers;
}

function referencesInFile(file, constants, helpers) {
  const lines = file.text.split('\n');
  const refs = [];
  lines.forEach((line, index) => {
    const cols = collectionsInLine(line, constants);
    for (const [name, col] of helpers) {
      if (line.includes(`${name}(`) && !/(?:function\s+|Reference\s+)\w+\s*\(/.test(line)) cols.add(col);
    }
    for (const collection of cols) refs.push({ collection, index });
  });
  return { lines, refs };
}

function isWrite({ lines, index }, fileText, isJava) {
  const window = [lines[index - 2], lines[index - 1], lines[index], lines[index + 1]].join('\n');
  const assignment = /(?:const|let|var|DocumentReference|CollectionReference)\s+(\w+)\s*=\s*[^;]*$/.exec(
    [lines[index - 1], lines[index]].join('\n'),
  );
  if (assignment) {
    const name = assignment[1];
    const wrapper = isJava ? `|${JAVA_WRITE_WRAPPER}\\(\\s*${name}\\b` : '';
    const viaVar = new RegExp(
      `\\b${name}\\.${WRITE_VERBS}\\(|\\b(?:transaction|tx|batch)\\.${WRITE_VERBS}\\(\\s*${name}\\b${wrapper}`,
    );
    return viaVar.test(fileText);
  }
  const wrapper = isJava ? `|${JAVA_WRITE_WRAPPER}\\(` : '';
  return new RegExp(`\\b(?:transaction|tx|batch)\\.${WRITE_VERBS}\\(|\\)\\s*\\.${WRITE_VERBS}\\(${wrapper}`).test(window);
}

export function scan(actorFiles) {
  const all = Object.values(actorFiles).flat();
  const constants = collectConstants(all);
  const helpers = collectPathHelpers(all, constants);
  const findings = new Map();
  for (const [actor, files] of Object.entries(actorFiles)) {
    for (const file of files) {
      const { lines, refs } = referencesInFile(file, constants, helpers);
      for (const ref of refs) {
        const kind = isWrite({ lines, index: ref.index }, file.text, file.path.endsWith('.java')) ? 'write' : 'read';
        const key = `${actor}|${ref.collection}|${file.path}|${kind}`;
        findings.set(key, { actor, collection: ref.collection, file: file.path, kind });
      }
    }
  }
  return [...findings.values()].sort((a, b) => a.collection.localeCompare(b.collection)
    || a.actor.localeCompare(b.actor) || a.file.localeCompare(b.file));
}

// Rules: a collection has one owner and only the owner writes it; agents touch only agent-owned data.
export function evaluate(findings, manifest) {
  const violations = [];
  const unregistered = new Set();
  for (const finding of findings) {
    const entry = manifest.collections[finding.collection];
    if (!entry) { unregistered.add(finding.collection); continue; }
    if (finding.kind === 'write' && finding.actor !== entry.owner) {
      violations.push({ ...finding, rule: 'single-writer', owner: entry.owner });
    } else if (finding.actor === 'agent' && entry.owner !== 'agent') {
      violations.push({ ...finding, rule: 'agent-isolation', owner: entry.owner });
    }
  }
  return { violations, unregistered: [...unregistered].sort() };
}

export const violationKey = (v) => `${v.rule}|${v.actor}|${v.collection}|${v.file}|${v.kind}`;

export function compareToBaseline(violations, baseline) {
  const known = new Set(baseline.violations.map(violationKey));
  const current = new Set(violations.map(violationKey));
  return {
    added: violations.filter((v) => !known.has(violationKey(v))),
    stale: baseline.violations.filter((v) => !current.has(violationKey(v))),
  };
}
