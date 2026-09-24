import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ReactArtifactSchema, ReactCompiledArtifactSchema, ReactRevisionSchema, ReactCurrentRevisionSchema, ReactExecutionArtifactSchema,
  ReactPageListSchema, ReactHistorySchema, ReactPageMutationResponseSchema, ReactSaveRequestSchema, ReactRuntimeArtifactSchema, ReactRuntimeArtifactJsonSchema,
  selectReactRuntimeArtifact, REACT_BUILD_DEPENDENCIES, REACT_TYPE_DEPENDENCIES } from '../../shared/workbench-react-workspace.mjs';
import { REACT_DEPENDENCIES } from './react-compiler-packages.mjs';
import { compileReactPreview } from './react-compiler.mjs';
import { fixtureArtifact, fixtureRevision } from './react-contract-fixtures.mjs';
import { checkArtifact } from './remote-runtime/contract.mjs';
import { createReactRuntimeDocument } from './react-compiler-runtime.mjs';

const require = createRequire(import.meta.url), root = fileURLToPath(new URL('../../', import.meta.url));
describe('shared React artifact, persisted revision and HTTP contracts', () => {
  it('accepts the real compiler result and shares the exact pinned package and type identities', async () => {
    const artifact = await compileReactPreview(fixtureRevision().source);
    expect(ReactCompiledArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(artifact.typecheck.dependencies).toEqual(REACT_TYPE_DEPENDENCIES);
    expect(REACT_DEPENDENCIES).toBe(REACT_BUILD_DEPENDENCIES);
    expect(ReactCurrentRevisionSchema.parse({ ...fixtureRevision(), artifact })).toMatchObject({ schemaVersion: 1 });
  });
  it.each([
    ['unknown version', (value) => { value.schemaVersion = 2; }],
    ['missing versioned workspace hash', (value) => { delete value.workspaceHash; }],
    ['missing typecheck', (value) => { delete value.typecheck; }],
    ['invalid source hash', (value) => { value.sourceHash = 'missing'; }],
    ['unknown runtime', (value) => { value.runtimeVersion = 'future-runtime'; }],
    ['missing dependency', (value) => { value.dependencies.pop(); }],
    ['different package version', (value) => { value.dependencies[0].version = '19.0.0'; }],
    ['duplicate package', (value) => { value.dependencies.push(value.dependencies[0]); }],
    ['failed typecheck', (value) => { value.typecheck.status = 'failed'; }],
    ['forged type version', (value) => { value.typecheck.typescriptVersion = '0.0.0'; }],
    ['missing type dependency', (value) => { value.typecheck.dependencies.pop(); }],
    ['unknown field', (value) => { value.secret = 'must-not-cross-boundary'; }],
  ])('rejects %s without downgrading to the legacy branch', (_name, sabotage) => {
    const artifact = fixtureArtifact(); sabotage(artifact);
    expect(ReactArtifactSchema.safeParse(artifact).success).toBe(false);
  });
  it('rejects a byte overflow even when the source character count is below the limit', () => {
    expect(ReactArtifactSchema.safeParse({ ...fixtureArtifact(), bundle: '한'.repeat(80001) }).success).toBe(false);
  });
  it('preserves raw legacy revisions and unversioned typed workspace revisions without migration', () => {
    const current = fixtureRevision(), { schemaVersion: _revisionVersion, ...stage1 } = current;
    const { schemaVersion: _artifactVersion, ...stage1Artifact } = current.artifact;
    stage1.artifact = stage1Artifact;
    expect(ReactRevisionSchema.parse(stage1)).toEqual(stage1);
    const source = { title: '이전 단일 파일', code: 'export default ()=> <div/>' }, compiled = fixtureArtifact(source);
    const { schemaVersion: _version, workspaceHash: _workspace, typecheck: _typecheck, ...artifact } = compiled;
    const legacy = { ...stage1, source, sourceHash: artifact.sourceHash, artifact };
    expect(ReactRevisionSchema.parse(legacy)).toEqual(legacy);
    expect(ReactCurrentRevisionSchema.safeParse(legacy).success).toBe(false);
    const incomplete = structuredClone(stage1); delete incomplete.artifact.typecheck;
    expect(ReactRevisionSchema.safeParse(incomplete).success).toBe(false);
    const forged = structuredClone(stage1); forged.artifact.typecheck.typescriptVersion = '0.0.0';
    expect(ReactRevisionSchema.safeParse(forged).success).toBe(false);
  });
  it.each(['sourceHash', 'workspaceHash', 'revisionVersion', 'restoredFrom', 'unknown'])('rejects a broken persisted %s relationship', (field) => {
    const revision = fixtureRevision();
    if (field === 'sourceHash') revision.artifact.sourceHash = 'f'.repeat(64);
    if (field === 'workspaceHash') revision.artifact.workspaceHash = 'f'.repeat(64);
    if (field === 'revisionVersion') revision.schemaVersion = 2;
    if (field === 'restoredFrom') revision.restoredFrom = 1;
    if (field === 'unknown') revision.executionId = 'not-a-persisted-field';
    expect(ReactRevisionSchema.safeParse(revision).success).toBe(false);
  });
  it('keeps execution handles separate from immutable artifacts and persisted revisions', () => {
    const artifact = fixtureArtifact(), executionId = '0885a647-7d75-46ca-8038-78152972d2ea';
    expect(ReactExecutionArtifactSchema.parse({ ...artifact, executionId }).executionId).toBe(executionId);
    expect(ReactArtifactSchema.safeParse({ ...artifact, executionId }).success).toBe(false);
    expect(ReactExecutionArtifactSchema.safeParse(artifact).success).toBe(false);
    expect(ReactExecutionArtifactSchema.safeParse({ ...artifact, executionId: 'arbitrary' }).success).toBe(false);
  });
  it('derives the restricted renderer protocol and embedded browser validator from the same runtime schema', () => {
    const artifact = fixtureArtifact(), runtime = selectReactRuntimeArtifact(artifact);
    expect(checkArtifact(artifact)).toEqual(runtime);
    expect(checkArtifact(runtime)).toEqual(runtime);
    expect(Object.keys(runtime).sort()).toEqual(ReactRuntimeArtifactJsonSchema.required.slice().sort());
    expect(runtime).not.toHaveProperty('typecheck'); expect(runtime).not.toHaveProperty('sourceHash');
    expect(ReactRuntimeArtifactSchema.safeParse(artifact).success).toBe(false);
    expect(ReactRuntimeArtifactJsonSchema.properties.bundle.maxLength).toBe(240000);
    expect(ReactRuntimeArtifactJsonSchema.properties.runtimeVersion.const).toBe('react-preview-v1');
    for (const rule of Object.values(ReactRuntimeArtifactJsonSchema.properties)) {
      expect(rule.type).toBe('string');
      expect(Object.keys(rule).every((key) => ['type', 'minLength', 'maxLength', 'const', 'pattern'].includes(key))).toBe(true);
    }
    expect(createReactRuntimeDocument({ nonce: 'abcdefghijklmnopqrst', parentOrigin: 'https://fixture.invalid', packageSetHash: artifact.packageSetHash })).toContain(JSON.stringify(ReactRuntimeArtifactJsonSchema));
    expect(() => checkArtifact({ ...runtime, bundle: `${runtime.bundle} altered` })).toThrow();
  });
  it('loads the shared contract from the exact minimal renderer filesystem dependencies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axr-renderer-contract-'));
    try {
      const dockerfile = await readFile(join(root, 'server/workbench/remote-runtime/Dockerfile'), 'utf8');
      expect(dockerfile).toContain('COPY shared/workbench-react-workspace.mjs ./shared/workbench-react-workspace.mjs');
      expect(dockerfile).toContain('COPY --from=builder /opt/axr/node_modules/zod ./node_modules/zod');
      await mkdir(join(directory, 'server/workbench/remote-runtime'), { recursive: true });
      await mkdir(join(directory, 'shared')); await mkdir(join(directory, 'node_modules'));
      await cp(join(root, 'server/workbench/remote-runtime/contract.mjs'), join(directory, 'server/workbench/remote-runtime/contract.mjs'));
      await cp(join(root, 'shared/workbench-react-workspace.mjs'), join(directory, 'shared/workbench-react-workspace.mjs'));
      await cp(dirname(require.resolve('zod/package.json')), join(directory, 'node_modules/zod'), { recursive: true });
      const contract = pathToFileURL(join(directory, 'server/workbench/remote-runtime/contract.mjs')).href;
      const script = `const {checkArtifact}=await import(${JSON.stringify(contract)});console.log(JSON.stringify(checkArtifact(${JSON.stringify(fixtureArtifact())})));`;
      const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, env: {}, timeout: 5000 });
      expect(JSON.parse(result.stdout)).toEqual(selectReactRuntimeArtifact(fixtureArtifact()));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('validates list/history projections without pretending they contain source files or artifacts', () => {
    const { id, version, sourceHash, updatedAt, source } = fixtureRevision();
    const item = { id, version, sourceHash, updatedAt, source: { title: source.title } };
    expect(ReactPageListSchema.parse({ schemaVersion: 1, items: [item], truncated: false }).items).toEqual([item]);
    expect(ReactHistorySchema.parse({ schemaVersion: 1, items: [{ ...item, restoredFrom: null }] }).items).toHaveLength(1);
    expect(ReactRevisionSchema.safeParse(item).success).toBe(false);
    expect(ReactPageListSchema.safeParse({ items: [fixtureRevision()], truncated: false }).success).toBe(false);
    expect(ReactHistorySchema.safeParse({ items: [item] }).success).toBe(false);
  });
  it('accepts an immutable recovery receipt result and a save response with declared Git metadata only', () => {
    const revision = fixtureRevision();
    expect(ReactPageMutationResponseSchema.parse(revision)).toEqual(revision);
    expect(ReactPageMutationResponseSchema.parse({ ...revision, git: { status: 'disabled', message: '연결 전' } }).git.status).toBe('disabled');
    expect(ReactPageMutationResponseSchema.safeParse({ ...revision, git: { status: 'disabled', token: 'invalid' } }).success).toBe(false);
    expect(ReactSaveRequestSchema.safeParse({ expectedVersion: 0, source: revision.source, apis: [], artifact: revision.artifact }).success).toBe(false);
  });
  it('regenerates the checked-in TypeScript declarations byte-for-byte from the shared schemas', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axr-react-contract-'));
    try {
      await promisify(execFile)(process.execPath, [require.resolve('typescript/bin/tsc'), '--allowJs', '--declaration', '--emitDeclarationOnly', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', '--outDir', directory, 'shared/workbench-react-workspace.mjs'], { cwd: root, timeout: 10000 });
      expect(await readFile(join(directory, 'workbench-react-workspace.d.mts'), 'utf8')).toBe(await readFile(join(root, 'shared/workbench-react-workspace.d.mts'), 'utf8'));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
