import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { closeWorkbenchServer } from './shutdown.mjs';

async function listener(handler = (_req, res) => res.end('ready')) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server;
}
describe('Workbench graceful shutdown', () => {
  it('does not finish or terminate the database before container deletion succeeds', async () => {
    const server = await listener(), db = { terminate: vi.fn(async () => {}) };
    const runtime = { reservedSessions: 1, closeAll: vi.fn() };
    let finished = false;
    const closing = closeWorkbenchServer({ server, db, remoteRuntime: runtime, timeoutMs: 1000 }).then((code) => { finished = true; return code; });
    await vi.waitFor(() => expect(runtime.closeAll).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(finished).toBe(false); expect(db.terminate).not.toHaveBeenCalled();
    runtime.reservedSessions = 0;
    expect(await closing).toBe(0); expect(db.terminate).toHaveBeenCalledOnce(); expect(server.listening).toBe(false);
  });
  it('returns failure on unresolved tombstones without claiming database termination', async () => {
    const server = await listener(), db = { terminate: vi.fn(async () => {}) };
    expect(await closeWorkbenchServer({ server, db, remoteRuntime: { reservedSessions: 1, closeAll() {} }, timeoutMs: 40 })).toBe(1);
    expect(db.terminate).not.toHaveBeenCalled();
  });
  it('prefers shutdown to prevent new renderer allocation during drain', async () => {
    const runtime = { reservedSessions: 0, shutdown: vi.fn(), closeAll: vi.fn() };
    expect(await closeWorkbenchServer({ server: await listener(), db: { terminate: async () => {} }, remoteRuntime: runtime })).toBe(0);
    expect(runtime.shutdown).toHaveBeenCalledOnce(); expect(runtime.closeAll).not.toHaveBeenCalled();
  });
  it('bounds active HTTP requests by the same deadline', async () => {
    let received;
    const requestStarted = new Promise(resolve => { received = resolve; });
    const server = await listener(() => received());
    const pending = fetch(`http://127.0.0.1:${server.address().port}/pending`).catch(() => null);
    await requestStarted;
    const db = { terminate: vi.fn(async () => {}) };
    expect(await closeWorkbenchServer({ server, db, timeoutMs: 40 })).toBe(1);
    await pending; expect(db.terminate).not.toHaveBeenCalled();
  });
  it('bounds database termination and treats a termination failure as failure', async () => {
    expect(await closeWorkbenchServer({ server: await listener(), db: { terminate: () => new Promise(() => {}) }, timeoutMs: 40 })).toBe(1);
    expect(await closeWorkbenchServer({ server: await listener(), db: { terminate: async () => { throw new Error('unavailable'); } }, timeoutMs: 1000 })).toBe(1);
  });
});
