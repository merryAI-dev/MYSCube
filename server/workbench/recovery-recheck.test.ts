import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchTransport } from '../../workbench/transport';

async function fixture() {
  let actor = 'original-owner';
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new Error('response lost after commit'); });
  const transport = createWorkbenchTransport({ actor: () => actor, token: async () => 'synthetic-token', fetchImpl });
  await expect(transport.request('/html-work-pages', 'POST', { source: 'saved content' })).rejects.toThrow('저장 결과');
  return { transport, fetchImpl, record: transport.pending()[0], actor: (value: string) => { actor = value; } };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('recovery rechecks the exact unresolved request before loading', () => {
  it('reads again after a successful list and preserves the key on a new 403', async () => {
    const { transport, fetchImpl, record } = await fixture();
    fetchImpl.mockResolvedValueOnce(response({ state: 'completed', body: { version: 1 } }));
    const listed = (await transport.recover())[0];
    fetchImpl.mockResolvedValueOnce(response({ message: '현재 조회 권한이 없습니다.' }, 403));
    await expect(transport.recoverOne(listed)).rejects.toThrow('조회 권한');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(transport.pending()).toEqual([record]);
    const request = fetchImpl.mock.calls.at(-1);
    expect(String(request?.[0])).toContain(`/workbench-requests/${record.key}?`);
    expect(request?.[1]?.method).toBe('GET');
  });
  it('uses only the freshly returned body and never acknowledges it automatically', async () => {
    const { transport, fetchImpl, record } = await fixture();
    fetchImpl.mockResolvedValue(response({ state: 'completed', body: { version: 1, checked: 'current' }, key: 'server-must-not-replace-local-key', path: '/another-path' }));
    const result = await transport.recoverOne({ ...record, body: { checked: 'stale' } } as typeof record);
    expect(result.body).toEqual({ version: 1, checked: 'current' });
    expect(result.key).toBe(record.key); expect(result.path).toBe(record.path);
    expect(transport.pending()).toEqual([record]);
    transport.acknowledge(result); expect(transport.pending()).toHaveLength(0);
  });
  it('does not query a changed locator, changed body fingerprint or another current owner', async () => {
    const { transport, fetchImpl, record, actor } = await fixture();
    for (const changed of [{ ...record, key: crypto.randomUUID() }, { ...record, path: '/react-work-pages' }, { ...record, method: 'PUT' }, { ...record, fingerprint: 'f'.repeat(64) }]) {
      await expect(transport.recoverOne(changed)).rejects.toThrow('현재 계정');
    }
    actor('different-owner'); await expect(transport.recoverOne(record)).rejects.toThrow('현재 계정');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    actor('original-owner'); expect(transport.pending()).toEqual([record]);
  });
  it('discards the response if the owner changes while rechecking', async () => {
    const { transport, fetchImpl, record, actor } = await fixture();
    fetchImpl.mockImplementationOnce(async () => { actor('different-owner'); return response({ state: 'completed', body: { private: 'original owner' } }); });
    await expect(transport.recoverOne(record)).rejects.toThrow('계정이 바뀌었습니다');
    actor('original-owner'); expect(transport.pending()).toEqual([record]);
  });
  it('discards a late response after another action has already resolved the request', async () => {
    const { transport, fetchImpl, record } = await fixture();
    fetchImpl.mockImplementationOnce(async () => { transport.acknowledge(record); return response({ state: 'completed', body: { version: 1 } }); });
    await expect(transport.recoverOne(record)).rejects.toThrow('확인 상태가 바뀌었습니다');
    expect(transport.pending()).toHaveLength(0);
  });
  it('keeps the request when the server returns an unknown state', async () => {
    const { transport, fetchImpl, record } = await fixture();
    fetchImpl.mockResolvedValueOnce(response({ state: 'unknown', body: { version: 1 } }));
    await expect(transport.recoverOne(record)).rejects.toThrow('저장 결과의 상태');
    expect(transport.pending()).toEqual([record]);
  });
});
