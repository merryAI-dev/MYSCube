#!/usr/bin/env node
// Enforces the Firestore ownership manifest: one owner per collection, only the owner writes it,
// and agent code (server/mcp) touches nothing but agent-owned data.
//
// Existing violations are frozen in the baseline so only NEW ones fail; fix one and delete its
// baseline entry. Detection is regex-based (see scripts/lib/firestore-ownership.mjs), so entries
// marked "manual" were confirmed by reading the code and are never reported as stale.
//
//   node scripts/verify-firestore-ownership.mjs                    verify
//   node scripts/verify-firestore-ownership.mjs --update-baseline  freeze current violations
//   node scripts/verify-firestore-ownership.mjs --report           print the access matrix as JSON
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  walk, scan, evaluate, compareToBaseline, violationKey,
} from './lib/firestore-ownership.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(repoRoot, 'policies/firestore-ownership.json');
const baselinePath = resolve(repoRoot, 'policies/firestore-ownership.baseline.json');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const manifest = readJson(manifestPath);
const actorFiles = Object.fromEntries(Object.entries(manifest.actors).map(([actor, spec]) => [
  actor, spec.roots.flatMap((root) => walk(root, spec.extensions, repoRoot)),
]));
const findings = scan(actorFiles);
const { violations, unregistered } = evaluate(findings, manifest);
const baseline = readJson(baselinePath);

if (process.argv.includes('--report')) {
  const matrix = {};
  for (const f of findings) {
    const row = (matrix[f.collection] ??= { owner: manifest.collections[f.collection]?.owner ?? null });
    row[f.actor] = row[f.actor] === 'write' || f.kind === 'write' ? 'write' : 'read';
  }
  console.log(JSON.stringify({ matrix, violations, baseline: baseline.violations }, null, 2));
  process.exit(0);
}

if (process.argv.includes('--update-baseline')) {
  const manual = baseline.violations.filter((v) => v.manual);
  const detected = violations.filter((v) => !manual.some((m) => violationKey(m) === violationKey(v)));
  writeFileSync(baselinePath, `${JSON.stringify({ ...baseline, violations: [...manual, ...detected] }, null, 2)}\n`);
  console.log(`baseline updated: ${manual.length} manual + ${detected.length} detected`);
  process.exit(0);
}

const { added, stale } = compareToBaseline(violations, baseline);
const staleDetected = stale.filter((v) => !v.manual);
let failed = false;

if (unregistered.length) {
  failed = true;
  console.error(`Collections missing from policies/firestore-ownership.json:\n  ${unregistered.join('\n  ')}`);
}
for (const v of added) {
  failed = true;
  const why = v.rule === 'single-writer'
    ? `${v.actor} writes ${v.collection}, owned by ${v.owner}`
    : `agent code touches ${v.collection}, owned by ${v.owner}; go through a BFF tool endpoint`;
  console.error(`NEW ${v.rule}: ${why}\n  ${v.file}`);
}
if (staleDetected.length) {
  console.warn(`${staleDetected.length} baseline entries no longer occur; remove them:`);
  for (const v of staleDetected) console.warn(`  ${v.rule} ${v.actor} ${v.collection} ${v.file}`);
}
if (failed) process.exit(1);
console.log(`firestore ownership ok (${Object.keys(manifest.collections).length} collections, `
  + `${baseline.violations.length} known violations)`);
