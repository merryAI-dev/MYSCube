import { describe, expect, it } from 'vitest';
import { createTextStore, MAX_CACHED_TEXT_BYTES, TEXT_TTL_SECONDS } from '../src/review/text-store.mjs';
import { memoryKv } from './ema-support.mjs';

const sha = 'a'.repeat(64);
const text = { kind: 'contract', name: '계약서.pdf', sha256: sha, pageCount: 2, pages: ['1쪽', '2쪽'], quality: 'ok' };
const scope = { subjectKey: 'request/p1/r1/', kind: 'contract', path: 'orgs/mysc/project-registration-documents/p1/c.pdf' };

describe('attachment text store', () => {
  it('lets the user who fetched the file read the cached text, and nobody else', async () => {
    const kv = memoryKv();
    const store = createTextStore(kv);
    expect(await store.put('u1', text, scope)).toEqual({ cached: true });
    expect(await store.get('u1', sha, scope)).toEqual(text);
    expect(await store.get('u2', sha, scope)).toBeNull();
  });

  it('uses review: keys that never collide with the OAuth library keys', async () => {
    const kv = memoryKv();
    await createTextStore(kv).put('u1', text, scope);
    const keys = [...kv.map.keys()];
    expect(keys.some((key) => key.startsWith(`review:grant:u1:${sha}:s_`))).toBe(true);
    expect(keys).toContain(`review:text:${sha}`);
    expect(keys.some((key) => /^(grant|token|client):/u.test(key))).toBe(false);
  });

  it('sets a one-hour TTL and also refuses expired values on read', async () => {
    const kv = memoryKv();
    const puts = [];
    const spying = { ...kv, put: async (key, value, options) => { puts.push(options); return kv.put(key, value, options); } };
    let t = 0;
    const store = createTextStore(spying, { now: () => t });
    await store.put('u1', text, scope);
    expect(puts.every((options) => options.expirationTtl === TEXT_TTL_SECONDS)).toBe(true);
    t = TEXT_TTL_SECONDS * 1000 - 1;
    expect(await store.get('u1', sha, scope)).not.toBeNull();
    t = TEXT_TTL_SECONDS * 1000;
    expect(await store.get('u1', sha, scope)).toBeNull();
  });

  it('rejects malformed hashes and user ids, and never stores under them', async () => {
    const kv = memoryKv();
    const store = createTextStore(kv);
    await expect(store.put('u1', { ...text, sha256: 'not-a-hash' }, scope)).rejects.toThrow('text_store_invalid_key');
    await expect(store.put('u1:evil', text, scope)).rejects.toThrow('text_store_invalid_key');
    expect(await store.get('u1', '../x', scope)).toBeNull();
    expect(kv.map.size).toBe(0);
  });

  it('does not cache text too large for KV', async () => {
    const kv = memoryKv();
    const store = createTextStore(kv);
    const big = { ...text, pages: ['가'.repeat(Math.ceil(MAX_CACHED_TEXT_BYTES / 3) + 10)] };
    expect(await store.put('u1', big, scope)).toEqual({ cached: false });
    expect(await store.get('u1', sha, scope)).toBeNull();
  });

  it('refuses a cached record whose hash does not match its key', async () => {
    const kv = memoryKv();
    const store = createTextStore(kv);
    await store.put('u1', text, scope);
    const record = JSON.parse(await kv.get(`review:text:${sha}`));
    await kv.put(`review:text:${sha}`, JSON.stringify({ ...record, sha256: 'b'.repeat(64) }));
    expect(await store.get('u1', sha, scope)).toBeNull();
  });
});

describe('grant scope (code review #1)', () => {
  it('serves cached text only for the same subject, document kind and attachment path', async () => {
    const store = createTextStore(memoryKv());
    await store.put('u1', text, scope);
    expect(await store.get('u1', sha, scope)).toEqual(text);
    expect(await store.get('u1', sha, { ...scope, subjectKey: 'request/p2/r9/' })).toBeNull();
    expect(await store.get('u1', sha, { ...scope, kind: 'quote' })).toBeNull();
    // 작성자가 첨부를 바꾸면 경로가 바뀐다.
    expect(await store.get('u1', sha, { ...scope, path: 'orgs/mysc/project-registration-documents/p1/new.pdf' })).toBeNull();
    await expect(store.put('u1', text, { subjectKey: 'x', kind: 'contract' })).rejects.toThrow('text_store_invalid_scope');
  });
});

describe('shared text across kinds (2nd review #7)', () => {
  it('serves the same file to different users under different kinds without overwriting each other', async () => {
    const store = createTextStore(memoryKv());
    await store.put('u1', text, scope);
    await store.put('u2', { ...text, kind: 'quote' }, { ...scope, kind: 'quote' });
    expect((await store.get('u1', sha, scope))?.kind).toBe('contract');
    expect((await store.get('u2', sha, { ...scope, kind: 'quote' }))?.kind).toBe('quote');
    // 경로를 넘기면 받았을 때의 경로와 같아야 하고, 넘기지 않으면(쪽 넘김) 대상·종류만 본다.
    expect(await store.get('u1', sha, { subjectKey: scope.subjectKey, kind: 'contract' })).not.toBeNull();
    expect(await store.get('u1', sha, { ...scope, path: 'orgs/mysc/project-registration-documents/p1/other.pdf' })).toBeNull();
  });
});
