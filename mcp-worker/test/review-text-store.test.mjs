import { describe, expect, it } from 'vitest';
import { createTextStore, MAX_CACHED_TEXT_BYTES, TEXT_TTL_SECONDS } from '../src/review/text-store.mjs';
import { memoryKv } from './ema-support.mjs';

const sha = 'a'.repeat(64);
const text = { kind: 'contract', name: '계약서.pdf', sha256: sha, pageCount: 2, pages: ['1쪽', '2쪽'], quality: 'ok' };

describe('attachment text store', () => {
  it('lets the user who fetched the file read the cached text, and nobody else', async () => {
    const kv = memoryKv();
    const store = createTextStore(kv);
    expect(await store.put('u1', text)).toEqual({ cached: true });
    expect(await store.get('u1', sha)).toEqual(text);
    expect(await store.hasGrant('u1', sha)).toBe(true);
    expect(await store.get('u2', sha)).toBeNull();
    expect(await store.hasGrant('u2', sha)).toBe(false);
  });

  it('uses review: keys that never collide with the OAuth library keys', async () => {
    const kv = memoryKv();
    await createTextStore(kv).put('u1', text);
    const keys = [...kv.map.keys()];
    expect(keys.sort()).toEqual([`review:grant:u1:${sha}`, `review:text:${sha}`]);
    expect(keys.some((key) => /^(grant|token|client):/u.test(key))).toBe(false);
  });

  it('sets a one-hour TTL and also refuses expired values on read', async () => {
    const kv = memoryKv();
    const puts = [];
    const spying = { ...kv, put: async (key, value, options) => { puts.push(options); return kv.put(key, value, options); } };
    let t = 0;
    const store = createTextStore(spying, { now: () => t });
    await store.put('u1', text);
    expect(puts.every((options) => options.expirationTtl === TEXT_TTL_SECONDS)).toBe(true);
    t = TEXT_TTL_SECONDS * 1000 - 1;
    expect(await store.get('u1', sha)).not.toBeNull();
    t = TEXT_TTL_SECONDS * 1000;
    expect(await store.get('u1', sha)).toBeNull();
    expect(await store.hasGrant('u1', sha)).toBe(false);
  });

  it('rejects malformed hashes and user ids, and never stores under them', async () => {
    const kv = memoryKv();
    const store = createTextStore(kv);
    await expect(store.put('u1', { ...text, sha256: 'not-a-hash' })).rejects.toThrow('text_store_invalid_key');
    await expect(store.put('u1:evil', text)).rejects.toThrow('text_store_invalid_key');
    expect(await store.get('u1', '../x')).toBeNull();
    expect(kv.map.size).toBe(0);
  });

  it('grants but does not cache text too large for KV', async () => {
    const kv = memoryKv();
    const store = createTextStore(kv);
    const big = { ...text, pages: ['가'.repeat(Math.ceil(MAX_CACHED_TEXT_BYTES / 3) + 10)] };
    expect(await store.put('u1', big)).toEqual({ cached: false });
    expect(await store.hasGrant('u1', sha)).toBe(true);
    expect(await store.get('u1', sha)).toBeNull();
  });

  it('refuses a cached record whose hash does not match its key', async () => {
    const kv = memoryKv();
    const store = createTextStore(kv);
    await store.put('u1', text);
    const record = JSON.parse(await kv.get(`review:text:${sha}`));
    await kv.put(`review:text:${sha}`, JSON.stringify({ ...record, sha256: 'b'.repeat(64) }));
    expect(await store.get('u1', sha)).toBeNull();
  });
});
