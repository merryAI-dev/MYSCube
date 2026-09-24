import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReactWorkspaceSchema, ReactSourceSchema, canonicalWorkspace, normalizeReactSource, reactSourceIdentity, editorIdentity } from '../../shared/workbench-react-workspace.mjs';

const source = normalizeReactSource({ title: '검토 화면', code: 'export default function App() { return <main />; }' });
const hash = (value) => createHash('sha256').update(value).digest('hex');

describe('canonical React workspace contract', () => {
  it('has order-independent identity without normalizing any source bytes', () => {
    const files = { 'App.tsx': source.workspace.files['App.tsx'], 'lib/format.ts': 'export const total = 0;\n' };
    const workspace = { ...source.workspace, files };
    const identity = canonicalWorkspace(workspace);
    expect(canonicalWorkspace({ ...workspace, files: Object.fromEntries(Object.entries(files).reverse()) })).toBe(identity);
    expect(canonicalWorkspace({ ...workspace, files: { ...files, 'lib/format.ts': files['lib/format.ts'] + '\n' } })).not.toBe(identity);
    expect(canonicalWorkspace({ ...workspace, entry: 'lib/format.ts' })).not.toBe(identity);
    expect(canonicalWorkspace({ ...workspace, files: { 'App.tsx': files['App.tsx'] } })).not.toBe(identity);
    expect(ReactWorkspaceSchema.safeParse({ ...workspace, packageSetId: 'unapproved' }).success).toBe(false);
  });

  it.each(['../escape.ts', '/etc/passwd.ts', 'C:/escape.ts', 'a\\escape.ts', 'https://host/file.ts', 'a/../../x.ts', 'types.d.ts', 'node_modules/x.ts', '__proto__/x.ts', 'a//b.ts', 'a./b.ts', 'manifest.json'])('rejects unsafe file path %s', (path) => {
    expect(ReactWorkspaceSchema.safeParse({ ...source.workspace, files: { ...source.workspace.files, [path]: '' } }).success).toBe(false);
  });

  it('rejects ambiguous names, missing entry and oversized multibyte content', () => {
    for (const files of [{ 'App.tsx': '', 'app.tsx': '' }, { 'Other.tsx': '' }, { 'App.tsx': '가'.repeat(60001) }]) {
      expect(ReactWorkspaceSchema.safeParse({ ...source.workspace, files }).success).toBe(false);
    }
    const files = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`File${i}.ts`, '']));
    expect(ReactWorkspaceSchema.safeParse({ ...source.workspace, entry: 'File0.ts', files }).success).toBe(false);
    expect(ReactSourceSchema.safeParse({ ...source, code: 'duplicate source of truth' }).success).toBe(false);
  });

  it('retains the legacy immutable hash while explicit normalization creates a new workspace identity', () => {
    const legacy = { title: source.title, code: source.workspace.files['App.tsx'] };
    expect(hash(reactSourceIdentity(legacy))).toBe(hash(legacy.code));
    expect(normalizeReactSource(legacy)).toEqual(source);
    expect(hash(reactSourceIdentity(source))).not.toBe(hash(legacy.code));
    expect(legacy).toEqual({ title: source.title, code: source.workspace.files['App.tsx'] });
  });

  it('includes title and pinned API versions in proposal conflict checks', () => {
    const refs = [{ id: '11111111-1111-4111-8111-111111111111', version: 1 }];
    expect(editorIdentity(source, refs)).not.toBe(editorIdentity({ ...source, title: '변경 제목' }, refs));
    expect(editorIdentity(source, refs)).not.toBe(editorIdentity(source, [{ ...refs[0], version: 2 }]));
    expect(editorIdentity(source, refs)).not.toBe(editorIdentity(source, []));
  });

  it('derives the frontend declaration from the runtime schema without divergent hand-written types', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axr-contract-types-'));
    try {
      execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', 'shared/workbench-react-workspace.mjs', '--allowJs', '--declaration', '--emitDeclarationOnly', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--outDir', directory], { timeout: 15000 });
      expect(await readFile(join(directory, 'workbench-react-workspace.d.mts'), 'utf8')).toBe(await readFile(new URL('../../shared/workbench-react-workspace.d.mts', import.meta.url), 'utf8'));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
