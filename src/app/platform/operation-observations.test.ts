import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

describe('scoped operation observation delivery', () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    vi.resetModules(); storage = new Map();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) });
  });
  afterEach(() => vi.unstubAllGlobals());
  const event = { operationId: 'b9bf1270-158c-49ef-8a9a-26976085bd63', operationKey: 'registration.submit' as const, mode: 'manual' as const, phase: 'started' as const };
  it('retains rejected delivery, rehydrates after reload and retries with current identity only', async () => {
    let module = await import('./operation-observations');
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false });
    const context = { tenantId: 'tenant', actor: { id: 'a' }, baseUrl: '', fetchImpl };
    module.enqueueOperationObservation(context, event);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(storage.get('mysc-operation-observations:tenant:a')!)).toEqual([event]);
    vi.resetModules(); module = await import('./operation-observations');
    fetchImpl.mockResolvedValue({ ok: true });
    await module.flushOperationObservations({ ...context, actor: { id: 'b' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await module.flushOperationObservations(context);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(storage.get('mysc-operation-observations:tenant:a')!)).toEqual([]);
    expect(new Headers(fetchImpl.mock.calls[1][1].headers).get('x-actor-id')).toBe('a');
  });
  it('serializes delivery and keeps memory authoritative if browser storage fails', async () => {
    const module = await import('./operation-observations');
    let finish: (value: { ok: boolean }) => void = () => {};
    const fetchImpl = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue({ ok: true });
    const context = { tenantId: 'tenant', actor: { id: 'a' }, baseUrl: '', fetchImpl };
    module.enqueueOperationObservation(context, event);
    vi.stubGlobal('sessionStorage', { getItem: () => JSON.stringify([event]), setItem: () => { throw new Error('full'); } });
    module.enqueueOperationObservation(context, { ...event, phase: 'unknown' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    finish({ ok: true });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await module.flushOperationObservations(context);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(module.getOperationQueueHealth().pending).toBe(0);
  });
});
