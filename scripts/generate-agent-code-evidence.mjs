import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const definitions = [
  { topic: 'accounting', path: 'server/bff/cashflow-coordinates.mjs', anchor: 'export function weekOrdinal(', lines: 7 },
  { topic: 'accounting', path: 'server/bff/cashflow-coordinates.mjs', anchor: 'export const ANNUAL_COLUMNS_BEFORE', lines: 3 },
  { topic: 'sheet_validation', path: 'server/bff/routes/jvm-weekly-api.mjs', anchor: '    sheetRuleWarnings.push(...sheetControlBlockers(sheetFacts));', lines: 2 },
  { topic: 'sheet_validation', path: 'server/bff/routes/jvm-weekly-api.mjs', anchor: '  if (projectionRows.length !== 19 || actualRows.length !== 19)', lines: 14 },
  { topic: 'sheet_validation', path: 'server/bff/cashflow-sheet-snapshot.mjs', anchor: '    matches: value === null || computed === null ? null : value === computed,', lines: 1 },
  { topic: 'connectivity', path: 'server/bff/cashflow-project-scope.mjs', anchor: 'export function isProjectInActorScope(', lines: 5 },
  { topic: 'agent_runtime', path: 'server/mcp/settlement-agent.mjs', anchor: '    if (!calls?.length)', lines: 5 },
  { topic: 'agent_runtime', path: 'server/mcp/hermes-harness.mjs', anchor: "        await record({ type: 'answer_policy'", lines: 5 },
];

export function buildCodeEvidence(readSource = (path) => readFileSync(new URL(path, root), 'utf8')) {
  return definitions.map(({ topic, path, anchor, lines: count }) => {
    const source = readSource(path);
    const lines = source.split('\n');
    const matches = lines.flatMap((line, index) => line.startsWith(anchor) ? [index] : []);
    if (matches.length !== 1) throw new Error(`Code evidence anchor mismatch: ${path}`);
    const start = matches[0];
    return { topic, path, sourceSha256: createHash('sha256').update(source).digest('hex'),
      startLine: start + 1, endLine: start + count, excerpt: lines.slice(start, start + count).join('\n') };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = new URL('server/mcp/code-evidence.generated.mjs', root);
  const content = `// Generated from allowlisted source files. Run node scripts/generate-agent-code-evidence.mjs after source changes.\nexport const CODE_EVIDENCE = ${JSON.stringify(buildCodeEvidence(), null, 2)};\n`;
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== content) throw new Error('Code evidence is stale. Run node scripts/generate-agent-code-evidence.mjs.');
  } else writeFileSync(target, content);
}
