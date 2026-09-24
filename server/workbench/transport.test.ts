import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchTransport } from '../../workbench/transport';

const memory = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) || null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); }, data }; };
describe('Workbench logical write transport', () => {
  it('retains the same operation after a lost response and a new client instance without storing source', async () => {
    const storage = memory(), keys: string[] = []; let lost = true;
    const fetchImpl = vi.fn(async (_url, init) => { keys.push(init.headers['Idempotency-Key']); if (lost) { lost = false; throw new Error('lost'); } return new Response(JSON.stringify({ id: 'saved-once', version: 1 })); });
    const options = { storage, fetchImpl, actor: () => 'owner', token: async () => undefined };
    await expect(createWorkbenchTransport(options).request('/react-work-pages', 'POST', { secretSource: 'private-value' })).rejects.toThrow('저장 결과');
    expect([...storage.data.values()].join('')).not.toContain('private-value');
    const next = createWorkbenchTransport(options);
    expect(await next.request('/react-work-pages', 'POST', { secretSource: 'private-value' })).toMatchObject({ version: 1 });
    expect(keys[0]).toBe(keys[1]); expect(next.pending()).toEqual([]);
  });
  it('blocks a changed write until the earlier result is explicitly recovered', async () => {
    const fetchImpl = vi.fn(async () => { throw Error('lost'); });
    const transport = createWorkbenchTransport({ fetchImpl, actor: () => 'owner', token: async () => undefined });
    await expect(transport.request('/react-work-pages', 'POST', { code: 'A' })).rejects.toThrow();
    await expect(transport.request('/react-work-pages', 'POST', { code: 'B' })).rejects.toThrow('이전 저장 결과');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('bounds a stuck token or request and never sends after the deadline', async () => {
    let release: (value: string) => void = () => {};
    const token = new Promise<string>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn();
    const transport = createWorkbenchTransport({ fetchImpl, actor: () => 'owner', token: () => token, timeoutMs: 10 });
    await expect(transport.request('/react-work-pages', 'POST', {})).rejects.toThrow('저장 결과');
    release('private-token'); await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchImpl).not.toHaveBeenCalled(); expect(transport.pending()).toHaveLength(1);
  });
  it('does not expose responses to a different signed-in account', async () => {
    let actor = 'A'; const storage = memory();
    const transport = createWorkbenchTransport({ storage, actor: () => actor, token: async () => undefined, fetchImpl: async () => { actor = 'B'; return new Response(JSON.stringify({ private: 'A' })); } });
    await expect(transport.request('/react-work-pages', 'POST', {})).rejects.toThrow('계정이 바뀌어');
    expect(transport.pending()).toEqual([]); actor = 'A'; expect(transport.pending()).toHaveLength(1);
  });
  it('returns completed recovery without discarding its key until explicitly acknowledged', async () => {
    let lost = true;
    const transport = createWorkbenchTransport({ actor: () => 'A', token: async () => undefined, fetchImpl: async () => { if (lost) { lost = false; throw Error('lost'); } return new Response(JSON.stringify({ state: 'completed', body: { version: 1 } })); } });
    await expect(transport.request('/react-work-pages', 'POST', {})).rejects.toThrow();
    const recovered = await transport.recover(); expect(recovered[0].body).toEqual({ version: 1 }); expect(transport.pending()).toHaveLength(1);
    transport.acknowledge(recovered[0]); expect(transport.pending()).toEqual([]);
  });
  it('does not expose a recovered source when the signed-in account changes during recovery', async () => {
    let actor = 'A', attempt = 0;
    const transport = createWorkbenchTransport({ actor: () => actor, token: async () => undefined, fetchImpl: async () => {
      if (++attempt === 1) throw Error('lost');
      actor = 'B'; return new Response(JSON.stringify({ state: 'completed', recoveredAfterScopeChange: true, body: { source: 'A private source' } }));
    } });
    await expect(transport.request('/html-work-pages', 'POST', {})).rejects.toThrow();
    await expect(transport.recover()).rejects.toThrow('계정이 바뀌었습니다');
    expect(transport.pending()).toEqual([]); actor = 'A'; expect(transport.pending()).toHaveLength(1);
  });
});
