import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createAnalyticsExecutor, executeAnalyticsQuery } from './analytics-engine.mjs';

const key = (letter) => letter.repeat(64);
const input = { sql: 'select id from sales', datasets: [{ datasetId: 'sales', schema: [{ name: 'id', type: 'integer' }], rows: [{ id: 1 }] }] };
function harness() {
  const workers = [];
  const spawnWorker = vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = vi.fn();
    child.finish = (result = { rows: [{ id: '1' }] }) => { child.stdout.write(JSON.stringify({ ok: true, result })); child.emit('close', 0); };
    workers.push(child); return child;
  });
  return { workers, spawnWorker, execute: createAnalyticsExecutor({ spawnWorker }) };
}

describe('bounded, actor-fair single-worker analytics queue', () => {
  it('runs distinct actors FIFO only after worker close; one actor cannot occupy the waiting slot', async () => {
    const h = harness();
    const a = h.execute(input, { actorKey: key('a') });
    await expect(h.execute(input, { actorKey: key('a') })).rejects.toMatchObject({ code: 'analytics_query_busy' });
    const b = h.execute(input, { actorKey: key('b') });
    await expect(h.execute(input, { actorKey: key('c') })).rejects.toMatchObject({ code: 'analytics_query_busy' });
    expect(h.workers).toHaveLength(1);
    h.workers[0].finish({ actor: 'a' });
    expect(h.workers).toHaveLength(2);
    expect(h.workers[0].kill).not.toHaveBeenCalled();
    h.workers[0].emit('close', 0);
    expect(h.workers).toHaveLength(2);
    h.workers[1].finish({ actor: 'b' });
    expect(await a).toEqual({ actor: 'a' }); expect(await b).toEqual({ actor: 'b' });
    expect(h.spawnWorker.mock.calls[0][1][0]).toBe('--max-old-space-size=64');
    expect(h.spawnWorker.mock.calls[0][2].env).toEqual({ TZ: 'UTC', LANG: 'C.UTF-8' });
  });
  it('cancels a waiting request without killing active work and frees its actor reservation', async () => {
    const h = harness(), controller = new AbortController();
    const a = h.execute(input, { actorKey: key('a') });
    const b = h.execute(input, { actorKey: key('b'), signal: controller.signal });
    const rejected = expect(b).rejects.toMatchObject({ code: 'analytics_query_cancelled' });
    controller.abort(); await rejected;
    const replacement = h.execute(input, { actorKey: key('b') });
    expect(h.workers[0].kill).not.toHaveBeenCalled();
    h.workers[0].finish(); h.workers[1].finish(); await Promise.all([a, replacement]);
  });
  it('expires waiting requests within their original budget without terminating the active worker', async () => {
    const h = harness(); const a = h.execute(input, { actorKey: key('a') });
    await expect(h.execute(input, { actorKey: key('b'), timeoutMs: 15 })).rejects.toMatchObject({ code: 'analytics_query_timeout' });
    expect(h.workers).toHaveLength(1); expect(h.workers[0].kill).not.toHaveBeenCalled();
    const c = h.execute(input, { actorKey: key('c') }); h.workers[0].finish(); h.workers[1].finish(); await Promise.all([a, c]);
  });
  it('does not reset the deadline when a queued request starts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const h = harness(); const a = h.execute(input, { actorKey: key('a') });
      const b = h.execute(input, { actorKey: key('b'), timeoutMs: 70 });
      const expired = expect(b).rejects.toMatchObject({ code: 'analytics_query_timeout' });
      await vi.advanceTimersByTimeAsync(45); h.workers[0].finish(); await a;
      await vi.advanceTimersByTimeAsync(25); await expired;
      expect(h.workers[1].kill).toHaveBeenCalledWith('SIGKILL'); h.workers[1].emit('close', null);
    } finally { vi.useRealTimers(); }
  });
  it('keeps active reservation after abort until actual child close; a waiting actor proceeds afterwards', async () => {
    const h = harness(), controller = new AbortController();
    const a = h.execute(input, { actorKey: key('a'), signal: controller.signal });
    const aborted = expect(a).rejects.toMatchObject({ code: 'analytics_query_cancelled' });
    const b = h.execute(input, { actorKey: key('b') }); controller.abort(); await aborted;
    expect(h.workers).toHaveLength(1);
    await expect(h.execute(input, { actorKey: key('a') })).rejects.toMatchObject({ code: 'analytics_query_busy' });
    h.workers[0].emit('close', null); expect(h.workers).toHaveLength(2); h.workers[1].finish(); await b;
  });
  it('rejects a late worker close even when a blocked event loop has not fired its timer', async () => {
    const h = harness(), first = h.execute(input, { actorKey: key('a'), timeoutMs: 5 });
    const expired = expect(first).rejects.toMatchObject({ code: 'analytics_query_timeout' });
    const second = h.execute(input, { actorKey: key('b') });
    const until = performance.now() + 25; while (performance.now() < until) {}
    h.workers[0].finish(); await expired;
    expect(h.workers).toHaveLength(2); h.workers[1].finish(); await second;
  });
  it('checks the same deadline again after parsing a worker result', async () => {
    const h = harness(), first = h.execute(input, { actorKey: key('a'), timeoutMs: 20 });
    const expired = expect(first).rejects.toMatchObject({ code: 'analytics_query_timeout' });
    const parse = JSON.parse;
    const spy = vi.spyOn(JSON, 'parse').mockImplementationOnce(value => {
      const result = parse(value); const until = performance.now() + 30; while (performance.now() < until) {}
      return result;
    });
    try { h.workers[0].finish(); await expired; }
    finally { spy.mockRestore(); }
  });
  it('retains timed-out active capacity until close even when kill reports an error', async () => {
    const h = harness(); const a = h.execute(input, { actorKey: key('a'), timeoutMs: 10 });
    const expired = expect(a).rejects.toMatchObject({ code: 'analytics_query_timeout' });
    h.workers[0].kill.mockImplementation(() => { throw Error('synthetic kill error'); });
    const b = h.execute(input, { actorKey: key('b') }); await expired;
    expect(h.workers).toHaveLength(1);
    await expect(h.execute(input)).rejects.toMatchObject({ code: 'analytics_query_busy' });
    h.workers[0].emit('close', null); expect(h.workers).toHaveLength(2); h.workers[1].finish(); await b;
  });
  it('preserves immediate busy rejection for anonymous callers and rejects forged key shapes', async () => {
    const h = harness(); const first = h.execute(input);
    await expect(h.execute(input, { actorKey: key('b') })).rejects.toMatchObject({ code: 'analytics_query_busy' });
    await expect(h.execute(input)).rejects.toMatchObject({ code: 'analytics_query_busy' });
    await expect(h.execute(input, { actorKey: 'untrusted-label' })).rejects.toThrow('Invalid analytics actor key');
    h.workers[0].finish(); await first;
  });
  it('recovers from synchronous spawn failure and waits for close after a stdin error', async () => {
    const h = harness(); h.spawnWorker.mockImplementationOnce(() => { throw Error('synthetic spawn'); });
    await expect(h.execute(input, { actorKey: key('a') })).rejects.toMatchObject({ code: 'analytics_engine_unavailable' });
    const a = h.execute(input, { actorKey: key('a') }); const failed = expect(a).rejects.toMatchObject({ code: 'analytics_engine_unavailable' });
    const b = h.execute(input, { actorKey: key('b') }); h.workers[0].stdin.emit('error', Error('synthetic broken pipe')); await failed;
    expect(h.workers).toHaveLength(1); h.workers[0].emit('close', 1); h.workers[1].finish(); await b;
  });
  it('does not spawn if cancellation happens while the abort handler is registered', async () => {
    const h = harness(), controller = new AbortController();
    const add = controller.signal.addEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => { add(...args); controller.abort(); };
    await expect(h.execute(input, { actorKey: key('a'), signal: controller.signal })).rejects.toMatchObject({ code: 'analytics_query_cancelled' });
    expect(h.workers).toHaveLength(0);
    const next = h.execute(input, { actorKey: key('a') }); h.workers[0].finish(); await next;
  });
  it('snapshots queued input and executes real DuckDB requests for two actors without increasing concurrency', async () => {
    const h = harness(); const a = h.execute(input, { actorKey: key('a') }); const mutable = structuredClone(input);
    const b = h.execute(mutable, { actorKey: key('b') }); mutable.sql = 'DELETE FROM sales';
    h.workers[0].finish(); expect(h.workers[1].stdin.read().toString()).toContain('select id from sales'); h.workers[1].finish(); await Promise.all([a, b]);
    const actual = await Promise.all([executeAnalyticsQuery(input, { actorKey: key('a') }), executeAnalyticsQuery(input, { actorKey: key('b') })]);
    expect(actual.map(result => result.rows)).toEqual([[{ id: '1' }], [{ id: '1' }]]);
  });
});
