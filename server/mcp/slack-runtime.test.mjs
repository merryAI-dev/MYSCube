import { it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import * as runtime from './slack-runtime.mjs';

it('reserves budget atomically per attempt and prevents terminal job overwrite', async () => {
  const data = new Map([['settlement_agent_jobs/j', { status: 'succeeded', leaseId: 'lease', leaseUntil: Date.now() + 10000 }]]);
  const db = { doc: (path) => ({ path }), runTransaction: async (fn) => fn({
    get: async (ref) => ({ data: () => data.get(ref.path) }),
    set: (ref, value) => data.set(ref.path, value), update: (ref, value) => data.set(ref.path, { ...data.get(ref.path), ...value }),
  }) };
  expect(typeof runtime.reserveAgentBudget).toBe('function');
  for (let i = 0; i < 60; i++) await runtime.reserveAgentBudget(db, '2026-09');
  await expect(runtime.reserveAgentBudget(db, '2026-09')).rejects.toThrow('budget');
  await expect(runtime.updateClaimedJob({ db, job: { id: 'j', leaseId: 'lease' }, patch: { status: 'failed' } })).rejects.toThrow('lease');
});

it('accepts only signed feedback bound to the persisted answer and requesting user', async () => {
  expect(typeof runtime.saveSlackFeedback).toBe('function');
  const documents = new Map([['settlement_agent_jobs/job1', { status: 'succeeded', slackUserId: 'UABC', teamId: 'TABC', channelId: 'CABC', answerTs: '1.2', scopes: [{ key: 'scope1' }] }]]);
  const db = { doc: (path) => ({ path }), runTransaction: async (fn) => fn({
    get: async (ref) => ({ exists: documents.has(ref.path), data: () => documents.get(ref.path) }),
    set: (ref, data) => documents.set(ref.path, data),
  }) };
  const payload = { team: { id: 'TABC' }, user: { id: 'UABC' }, channel: { id: 'CABC' }, container: { message_ts: '1.2' }, actions: [{ action_id: 'settlement_scope_yes', value: 'job1', action_ts: '2.1' }] };
  expect(await runtime.saveSlackFeedback({ db, payload, teamId: 'TABC', channelId: 'CABC' })).toBe(true);
  expect(documents.get('settlement_agent_feedback/scope1').value).toBe(1);
  payload.user.id = 'UOTHER';
  expect(await runtime.saveSlackFeedback({ db, payload, teamId: 'TABC', channelId: 'CABC' })).toBe(false);
  payload.user.id = 'UABC';
  payload.actions[0] = { action_id: 'settlement_scope_no', value: 'job1', action_ts: '2.0' };
  await runtime.saveSlackFeedback({ db, payload, teamId: 'TABC', channelId: 'CABC' });
  expect(documents.get('settlement_agent_feedback/scope1').value).toBe(1);
  expect(documents.get('settlement_agent_jobs/job1/feedback/UABC').value).toBe(1);
});

it('validates interactive raw form signatures before parsing payload', async () => {
  expect(typeof runtime.createFeedbackIngress).toBe('function');
  const body = Buffer.from('payload={}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = 'test';
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
  let status = 200;
  const res = { status: (s) => { status = s; return res; }, json: (v) => v };
  const handler = runtime.createFeedbackIngress({ db: {}, secret, teamId: 'TABC', channelId: 'CABC' });
  await handler({ body, get: (h) => h === 'x-slack-request-timestamp' ? timestamp : signature }, res);
  expect(status).toBe(403);
  await handler({ body: Buffer.from('tampered'), get: (h) => h === 'x-slack-request-timestamp' ? timestamp : signature }, res);
  expect(status).toBe(401);
});
