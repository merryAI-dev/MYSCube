import { describe, expect, it } from 'vitest';
import { createCompletedReactArtifactCache, snapshotReactCompilerInput, reactCompilerCacheNamespace, reactCompilerCacheKey, REACT_COMPILER_CACHE_LIMITS } from './react-compiler-cache.mjs';
import { fixtureSource, fixtureArtifact } from './react-contract-fixtures.mjs';

const context = { tenantId: 'synthetic-cache', actorId: 'author', analyticsScope: { fingerprint: 'a'.repeat(64) } };
const identity = { hash: 'b'.repeat(64), packageSetHash: 'c'.repeat(64) };
const api = { id: 'synthetic-api', version: 1, definition: { kind: 'external-read', parameters: { count: { type: 'integer', required: true, label: '건수', example: 1 } }, endpointId: 'example', endpointVersion: 1, enabled: true, name: '합성 연결', description: '공개 합성 형식' },
  responseKind: 'external-read', responseSchema: { type: 'object', properties: { total: { type: 'integer' } }, required: ['total'] } };
const key = (source = fixtureSource(), apis = [api], compiler = identity) => reactCompilerCacheKey(snapshotReactCompilerInput(source, apis), compiler);

describe('bounded completed compiler artifact storage and exact input identity', () => {
  it('namespaces by the complete server owner and scope and disables caching without it', () => {
    const owner = reactCompilerCacheNamespace(context);
    expect(owner).toMatch(/^[a-f0-9]{64}$/);
    for (const changed of [{ ...context, tenantId: 'other' }, { ...context, actorId: 'other' }, { ...context, analyticsScope: { fingerprint: 'b'.repeat(64) } }]) expect(reactCompilerCacheNamespace(changed)).not.toBe(owner);
    for (const invalid of [undefined, {}, { ...context, actorId: '' }, { ...context, actorId: ' ' }, { ...context, tenantId: 'a/b' }, { ...context, analyticsScope: { fingerprint: 'client-string' } }, { ...context, tenantId: 1 }]) expect(reactCompilerCacheNamespace(invalid)).toBeNull();
  });
  it('uses one immutable normalized full API contract for records and generation flattening', () => {
    const source = fixtureSource(), apis = [structuredClone(api)];
    const snapshot = snapshotReactCompilerInput(source, apis);
    const flattened = { id: api.id, version: api.version, ...api.definition, responseKind: api.responseKind, responseSchema: api.responseSchema };
    expect(snapshotReactCompilerInput(source, [flattened])).toBe(snapshot);
    source.title = 'changed'; source.workspace.files['App.tsx'] = 'changed'; apis[0].definition.parameters.count.type = 'string';
    expect(JSON.parse(snapshot)).toEqual({ source: fixtureSource(), apis: [api] });
    const untyped = { id: 'analytics', version: 2, definition: { kind: 'analytics-copy', parameters: {}, plan: { kind: 'table', datasetId: 'approved', filters: [{ field: 'status', op: 'eq', value: 'A' }] } } };
    const original = key(fixtureSource(), [untyped]); untyped.definition.plan.filters[0].value = 'B';
    expect(key(fixtureSource(), [untyped])).not.toBe(original);
    expect(() => snapshotReactCompilerInput(fixtureSource(), [{ ...api, definition: null }])).toThrow();
  });
  it('normalizes only top-level registry provenance across conversation and registry API representations', () => {
    const source = fixtureSource(), metadata = { definitionHash: 'd'.repeat(64), endpointHash: 'e'.repeat(64) };
    const record = { ...structuredClone(api), ...metadata };
    const flattened = { id: api.id, version: api.version, ...structuredClone(api.definition), responseKind: api.responseKind, responseSchema: structuredClone(api.responseSchema), ...metadata };
    const snapshot = snapshotReactCompilerInput(source, [record]);
    expect(snapshotReactCompilerInput(source, [flattened])).toBe(snapshot);
    expect(snapshotReactCompilerInput(source, [{ ...flattened, definitionHash: 'f'.repeat(64), endpointHash: null }])).toBe(snapshot);
    expect(JSON.parse(snapshot).apis).toEqual([api]);
    expect(key(source, [flattened])).toBe(key(source, [record]));
    flattened.responseSchema.properties.total.type = 'string'; expect(key(source, [flattened])).not.toBe(key(source, [record]));
    expect(key(source, [{ ...api, definition: { ...api.definition, definitionHash: 'nested-policy' } }])).not.toBe(key(source, [api]));
    expect(key(source, [{ ...flattened, futurePolicy: 'must-remain-in-definition' }])).not.toBe(key(source, [flattened]));
    expect(JSON.parse(snapshotReactCompilerInput(source, [{ ...record, parameters: { forged: { type: 'string' } } }])).apis[0].definition).toEqual(api.definition);
  });
  it('misses edited files, title, entry, legacy identity, every API contract dimension and compiler identity', () => {
    const source = fixtureSource(), original = key(source);
    const changed = structuredClone(source); changed.workspace.files['App.tsx'] += '\n'; expect(key(changed)).not.toBe(original);
    expect(key({ ...source, title: '새 제목' })).not.toBe(original);
    expect(key({ title: source.title, code: source.workspace.files['App.tsx'] })).not.toBe(original);
    const entries = structuredClone(source); entries.workspace.files['Other.tsx'] = entries.workspace.files['App.tsx'];
    const otherEntry = structuredClone(entries); otherEntry.workspace.entry = 'Other.tsx'; expect(key(entries)).not.toBe(key(otherEntry));
    for (const mutate of [item => { item.id = 'another'; }, item => { item.version++; }, item => { item.definition.parameters.count.type = 'number'; },
      item => { item.definition.parameters.count.enum = [1, 2]; }, item => { item.responseSchema.properties.total.type = 'string'; },
      item => { item.responseKind = 'analytics-copy'; }, item => { item.definition.endpointVersion++; }, item => { item.definition.enabled = false; }]) {
      const changedApi = structuredClone(api); mutate(changedApi); expect(key(source, [changedApi])).not.toBe(original);
    }
    expect(key(source, [], identity)).not.toBe(original);
    expect(key(source, [api], { ...identity, hash: 'd'.repeat(64) })).not.toBe(original);
    expect(key(source, [api], { ...identity, packageSetHash: 'e'.repeat(64) })).not.toBe(original);
  });
  it('returns independent clones, scopes lookups, and expires without extending the five-minute TTL', () => {
    let elapsed = 0; const cache = createCompletedReactArtifactCache({ now: () => elapsed });
    const artifact = fixtureArtifact(); cache.set('owner', 'key', artifact); artifact.bundle = 'poisoned';
    const first = cache.get('owner', 'key'); first.typecheck.status = 'poisoned';
    expect(cache.get('owner', 'key')).toEqual(fixtureArtifact()); expect(cache.get('other', 'key')).toBeNull();
    elapsed = REACT_COMPILER_CACHE_LIMITS.ttlMs - 1; expect(cache.get('owner', 'key')).not.toBeNull();
    elapsed++; expect(cache.get('owner', 'key')).toBeNull();
  });
  it('evicts the least recently used owner entry without consuming another owner allocation', () => {
    const cache = createCompletedReactArtifactCache(), artifact = fixtureArtifact();
    cache.set('other', 'key', artifact);
    for (let i = 0; i < 4; i++) cache.set('owner', String(i), artifact);
    cache.get('owner', '0'); cache.set('owner', '4', artifact);
    expect(cache.get('owner', '1')).toBeNull(); expect(cache.get('owner', '0')).not.toBeNull(); expect(cache.get('other', 'key')).not.toBeNull();
  });
  it('enforces the global entry and byte caps, including serialized identity overhead', () => {
    const cache = createCompletedReactArtifactCache(), artifact = fixtureArtifact();
    for (let i = 0; i < 33; i++) cache.set(`owner${i}`, 'key', artifact);
    expect(cache.get('owner0', 'key')).toBeNull(); expect(cache.get('owner1', 'key')).not.toBeNull();
    const bounded = createCompletedReactArtifactCache();
    for (let i = 0; i < 9; i++) bounded.set(`owner${i}`, 'key', { content: 'x'.repeat(1024 * 1024) });
    expect(bounded.get('owner0', 'key')).toBeNull(); expect(bounded.get('owner1', 'key')).toBeNull(); expect(bounded.get('owner2', 'key')).not.toBeNull();
    bounded.set('owner2', 'oversize', { content: 'x'.repeat(REACT_COMPILER_CACHE_LIMITS.bytes) });
    expect(bounded.get('owner2', 'oversize')).toBeNull(); expect(bounded.get('owner2', 'key')).not.toBeNull();
  });
});
