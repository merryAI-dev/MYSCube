import { it, expect } from 'vitest';
import { createAgentTrace, verifyAgentTrace } from './agent-trace.mjs';

it('detects changed, deleted and reordered audit events; refuses a failed audit write', async () => {
  const records = [];
  const trace = createAgentTrace({ db: { doc: (path) => ({ path }), runTransaction: async (fn) => fn({
    get: async () => ({ data: () => ({ leaseId: 'l', leaseUntil: Date.now() + 10000 }) }),
    create: (_, value) => records.push(value), update: () => {}, set: () => {},
  }) }, jobId: 'j', leaseId: 'l' });
  await trace({ type: 'start', question: '지난달 미완료 건' });
  await trace({ type: 'decision', state: 'SUBMITTED' });
  const anchor = { count: records.length, hash: records.at(-1).hash };
  expect(verifyAgentTrace(records, anchor)).toBe(true);
  expect(verifyAgentTrace(records.map((row) => Object.fromEntries(Object.entries(row).reverse())), anchor)).toBe(true);
  expect(verifyAgentTrace(records.slice(1), anchor)).toBe(false);
  expect(verifyAgentTrace(records.slice(0, -1), anchor)).toBe(false);
  expect(verifyAgentTrace([], anchor)).toBe(false);
  expect(verifyAgentTrace([...records].reverse(), anchor)).toBe(false);
  const changed = structuredClone(records);
  changed[1].event.state = 'LOCKED';
  expect(verifyAgentTrace(changed, anchor)).toBe(false);
  const broken = createAgentTrace({ db: { runTransaction: async () => { throw new Error('offline'); } }, jobId: 'j', leaseId: 'l' });
  await expect(broken({ type: 'start' })).rejects.toThrow('offline');
});
