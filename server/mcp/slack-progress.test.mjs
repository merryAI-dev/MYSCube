import { afterEach, it, expect, vi } from 'vitest';
import { createSlackProgress } from './slack-progress.mjs';
import { memoryDb } from './slack-test-store.mjs';

afterEach(() => vi.useRealTimers());
function setup(send = vi.fn(async () => {})) {
  const { db, records } = memoryDb();
  const job = { id: 'j', channelId: 'C1', progressTs: '1.1', leaseId: 'lease', leaseUntil: Date.now() + 180000, status: 'running' };
  records.set('settlement_agent_jobs/j', structuredClone(job));
  return { records, send, progress: createSlackProgress({ job, db, send }) };
}

it('coalesces actual stages, throttles updates, ignores arbitrary prose, and cancels pending updates on close', async () => {
  vi.useFakeTimers();
  const { progress, send } = setup();
  progress.show('READ_PROJECTS');
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].text).toContain('등록 사업 목록');
  progress.show('READ_ACCOUNTING');
  progress.show('READ_SETTLEMENT');
  progress.show('999개 승인 완료');
  await vi.advanceTimersByTimeAsync(1499);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0].text).toContain('주정산·월결산 상태');
  progress.show('PREPARE_ANSWER');
  await progress.close();
  await vi.advanceTimersByTimeAsync(5000);
  progress.show('READ_ACCOUNTING');
  expect(send).toHaveBeenCalledTimes(2);
});

it('waits for the in-flight update before final delivery can proceed', async () => {
  vi.useFakeTimers();
  let release;
  const send = vi.fn(() => new Promise((resolve) => { release = resolve; }));
  const { progress } = setup(send);
  progress.show('READ_SETTLEMENT');
  await vi.advanceTimersByTimeAsync(0);
  let closed = false;
  const close = progress.close().then(() => { closed = true; });
  await vi.advanceTimersByTimeAsync(5000);
  expect(closed).toBe(false);
  release(); await close;
  expect(closed).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
});

it('checks current lease before a delayed update and prevents stale workers from overwriting', async () => {
  vi.useFakeTimers();
  const { progress, send, records } = setup();
  progress.show('READ_PROJECTS'); await vi.advanceTimersByTimeAsync(0);
  progress.show('READ_SETTLEMENT');
  records.get('settlement_agent_jobs/j').leaseId = 'new-owner';
  await vi.advanceTimersByTimeAsync(1500);
  expect(send).toHaveBeenCalledTimes(1);
  await progress.close();
});

it('stops progress on rate limits without throwing into the query and supports missing receipts', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => { throw new Error('slack_ratelimited'); });
  const { progress } = setup(send);
  progress.show('READ_PROJECTS'); await vi.advanceTimersByTimeAsync(0);
  progress.show('READ_SETTLEMENT'); await vi.advanceTimersByTimeAsync(5000);
  await expect(progress.close()).resolves.toEqual({ canReplaceReceipt: false });
  expect(send).toHaveBeenCalledTimes(1);
  const absent = createSlackProgress({ job: {}, db: {}, send });
  absent.show('READ_PROJECTS'); await absent.close();
  expect(send).toHaveBeenCalledTimes(1);
});

it('bounds a stalled lease lookup and cannot send after the lookup times out', async () => {
  vi.useFakeTimers();
  let resolveRead;
  const send = vi.fn();
  const progress = createSlackProgress({ job: { id: 'j', progressTs: '1.1', leaseId: 'lease' }, send,
    db: { doc: () => ({ get: () => new Promise((resolve) => { resolveRead = resolve; }) }) } });
  progress.show('READ_PROJECTS');
  await vi.advanceTimersByTimeAsync(800);
  await progress.close();
  resolveRead({ data: () => ({ status: 'running', leaseId: 'lease', leaseUntil: Date.now() + 10000 }) });
  await vi.advanceTimersByTimeAsync(0);
  expect(send).not.toHaveBeenCalled();
});
