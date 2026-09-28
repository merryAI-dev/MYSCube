import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), identity: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('./react-compiler-cache.mjs', async importOriginal => ({ ...await importOriginal(), reactCompilerCacheIdentity: mocks.identity }));
import { compileReactPreview } from './react-compiler.mjs';
import { fixtureArtifact, fixtureSource } from './react-contract-fixtures.mjs';

let serial = 0, cacheContext;
const identity = { hash: 'a'.repeat(64), packageSetHash: 'a'.repeat(64) };
const tick = () => new Promise(resolve => setImmediate(resolve));
function child() {
  const value = new EventEmitter(); value.pid = 99999999; value.stdout = new EventEmitter(); value.stdin = new EventEmitter(); value.stdin.end = vi.fn(); mocks.spawn.mockReturnValueOnce(value); return value;
}
async function compiled(source = fixtureSource(), options = {}) {
  const process = child(), pending = compileReactPreview(source, { cacheContext, ...options }); await tick();
  process.stdout.emit('data', JSON.stringify({ ok: true, artifact: fixtureArtifact(source) })); process.emit('close', 0);
  return pending;
}
beforeEach(() => { cacheContext = { tenantId: 'synthetic-cache-lifecycle', actorId: `actor-${++serial}`, analyticsScope: { fingerprint: 'b'.repeat(64) } }; mocks.identity.mockResolvedValue(identity); vi.spyOn(process, 'kill').mockImplementation(() => true); });
afterEach(() => { vi.restoreAllMocks(); mocks.spawn.mockReset(); mocks.identity.mockReset(); });

describe('completed-only compiler reuse preserves process boundaries', () => {
  it('does not spawn for a completed hit and never exposes its stored object', async () => {
    const first = await compiled(); first.bundle = 'poison';
    const second = await compileReactPreview(fixtureSource(), { cacheContext });
    expect(second).toEqual(fixtureArtifact()); expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); controller.abort();
    await expect(compileReactPreview(fixtureSource(), { cacheContext, signal: controller.signal })).rejects.toMatchObject({ code: 'react_compile_cancelled' });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it('pins the pre-await source and API snapshot for the child and cache key', async () => {
    const source = fixtureSource(), expected = structuredClone(source), apis = [{ id: 'api', version: 1, definition: { kind: 'analytics-copy', parameters: {}, plan: { datasetId: 'first' } } }];
    let release; mocks.identity.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const process = child(), result = compileReactPreview(source, { apis, cacheContext });
    source.title = 'mutated'; source.workspace.files['App.tsx'] = 'mutated'; apis[0].definition.plan.datasetId = 'mutated'; release(identity); await tick();
    expect(JSON.parse(process.stdin.end.mock.calls[0][0])).toMatchObject({ source: expected, apis: [{ definition: { plan: { datasetId: 'first' } } }] });
    process.stdout.emit('data', JSON.stringify({ ok: true, artifact: fixtureArtifact(expected) })); process.emit('close', 0); await result;
    await compileReactPreview(expected, { apis: [{ id: 'api', version: 1, kind: 'analytics-copy', parameters: {}, plan: { datasetId: 'first' } }], cacheContext });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it('checks cancellation again after reading the identity for a completed hit', async () => {
    await compiled(); let release;
    mocks.identity.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const controller = new AbortController(), pending = compileReactPreview(fixtureSource(), { cacheContext, signal: controller.signal }).catch(error => error);
    controller.abort(); release(identity);
    expect(await pending).toMatchObject({ code: 'react_compile_cancelled' }); expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it('recompiles edited source and API semantics instead of reusing a same-looking artifact', async () => {
    const source = fixtureSource(), api = { id: 'api', version: 1, definition: { kind: 'analytics-copy', parameters: {}, plan: { datasetId: 'first' } } };
    await compiled(source, { apis: [api] });
    for (const mutate of [item => { item.id = 'other'; }, item => { item.version++; }, item => { item.definition.plan.datasetId = 'second'; },
      item => { item.definition.parameters = { count: { type: 'integer', required: false } }; },
      item => { item.responseKind = 'external-read'; item.responseSchema = { type: 'string' }; }]) {
      const changed = structuredClone(api); mutate(changed); await compiled(source, { apis: [changed] });
    }
    const changedSource = structuredClone(source); changedSource.workspace.files['App.tsx'] += '\n'; await compiled(changedSource, { apis: [api] });
    expect(mocks.spawn).toHaveBeenCalledTimes(7);
  });
  it('does not coalesce in-flight work or release admission before child close', async () => {
    const process = child(), pending = compileReactPreview(fixtureSource(), { cacheContext }); await tick();
    await expect(compileReactPreview(fixtureSource(), { cacheContext })).rejects.toMatchObject({ code: 'react_compile_busy' });
    process.stdout.emit('data', JSON.stringify({ ok: true, artifact: fixtureArtifact() }));
    await expect(compileReactPreview(fixtureSource(), { cacheContext })).rejects.toMatchObject({ code: 'react_compile_busy' });
    process.emit('close', 0); await pending;
    expect(await compileReactPreview(fixtureSource(), { cacheContext })).toEqual(fixtureArtifact()); expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it.each(['worker-failure', 'invalid-shape', 'wrong-hash', 'abort'])('does not cache %s or a late success after failure', async kind => {
    const process = child(), controller = new AbortController(), pending = compileReactPreview(fixtureSource(), { cacheContext, signal: controller.signal }).catch(error => error); await tick();
    const artifact = fixtureArtifact(); if (kind === 'invalid-shape') delete artifact.typecheck; if (kind === 'wrong-hash') artifact.bundle += 'bad'; if (kind === 'abort') controller.abort();
    process.stdout.emit('data', JSON.stringify({ ok: kind !== 'worker-failure', artifact })); process.emit('close', 0);
    expect(await pending).toMatchObject({ code: kind === 'abort' ? 'react_compile_cancelled' : kind === 'worker-failure' ? 'react_compile_failed' : 'react_compile_artifact_invalid' });
    await compiled(); expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });
  it('ignores existing entries on changed or unreadable compiler identity and never caches a mismatched package identity', async () => {
    await compiled(); mocks.identity.mockResolvedValue({ ...identity, hash: 'c'.repeat(64) }); await compiled();
    mocks.identity.mockRejectedValue(new Error('unreadable identity')); await compiled(); await compiled();
    mocks.identity.mockResolvedValue({ ...identity, packageSetHash: 'd'.repeat(64) }); await compiled(); await compiled();
    expect(mocks.spawn).toHaveBeenCalledTimes(6);
  });
  it('does not reuse missing scopes or share results across tenants, actors or scopes', async () => {
    await compiled();
    for (const changed of [undefined, {}, { ...cacheContext, tenantId: 'other' }, { ...cacheContext, actorId: 'other' }, { ...cacheContext, analyticsScope: { fingerprint: 'c'.repeat(64) } }]) await compiled(fixtureSource(), { cacheContext: changed });
    await compiled(fixtureSource(), { cacheContext: undefined });
    expect(mocks.spawn).toHaveBeenCalledTimes(7);
  });
});
