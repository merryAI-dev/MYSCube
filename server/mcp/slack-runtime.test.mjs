import { it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import * as runtime from './slack-runtime.mjs';
import { memoryDb } from './slack-test-store.mjs';

it('accepts only the dedicated scheduler bearer and fails closed when disabled', () => {
  const check = runtime.verifySettlementWorkerToken;
  expect(typeof check).toBe('function');
  expect(check({ authorization: 'Bearer dedicated', secret: 'dedicated' })).toBe(true);
  for (const authorization of ['', 'Bearer generic-cron', 'dedicated']) expect(check({ authorization, secret: 'dedicated' })).toBe(false);
  expect(check({ authorization: 'Bearer dedicated', secret: '' })).toBe(false);
  expect(check({ authorization: 'Bearer dedicated', secret: 'dedicated', disabled: true })).toBe(false);
});

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
  expect(await runtime.saveSlackFeedback({ db, payload, teamId: 'TABC', channelIds: new Set(['CABC']) })).toBe(true);
  expect(documents.get('settlement_agent_feedback/scope1').value).toBe(1);
  payload.user.id = 'UOTHER';
  expect(await runtime.saveSlackFeedback({ db, payload, teamId: 'TABC', channelIds: new Set(['CABC']) })).toBe(false);
  payload.user.id = 'UABC';
  payload.actions[0] = { action_id: 'settlement_scope_no', value: 'job1', action_ts: '2.0' };
  await runtime.saveSlackFeedback({ db, payload, teamId: 'TABC', channelIds: new Set(['CABC']) });
  expect(documents.get('settlement_agent_feedback/scope1').value).toBe(1);
  expect(documents.get('settlement_agent_jobs/job1/feedback/UABC').value).toBe(1);
});

it('serves the second allowed channel and replies there, not the hardcoded default', async () => {
  const { db, records } = memoryDb();
  const identity = { teamId: 'T099F304GAY', channelId: 'C0AAC4AHTN1', slackUserId: 'UQA', threadTs: '1.1' };
  records.set('orgs/mysc/members/member', { email: 'qa@mysc.co.kr', role: 'finance', status: 'ACTIVE' });
  records.set('settlement_agent_jobs/first', { ...identity, status: 'queued', attempts: 0, conversationId: 'thread', createdAt: new Date().toISOString(), question: '정산 상태 확인해줘' });
  records.set('settlement_agent_threads/thread', { ...identity, queue: ['first'], turns: [] });
  const calls = [];
  const fetchImpl = vi.fn(async (url, options) => {
    if (url.includes('users.info')) return Response.json({ ok: true, user: { team_id: identity.teamId, profile: { email: 'qa@mysc.co.kr' } } });
    calls.push({ url, body: options?.body ? JSON.parse(options.body) : null });
    return Response.json({ ok: true, ts: '2.1', message_ts: '3.1' });
  });
  const worker = runtime.createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture' }, completeFactory: () => vi.fn(), fetchImpl });
  await worker();
  const delivery = calls.find((call) => call.url.endsWith('chat.postMessage') || call.url.endsWith('chat.postEphemeral'));
  expect(delivery.body.channel).toBe('C0AAC4AHTN1');
  expect(records.get('settlement_agent_jobs/first')).toMatchObject({ status: 'succeeded' });
});

it('refuses a channel outside the allow list without contacting Slack or the model', async () => {
  const { db, records } = memoryDb();
  const identity = { teamId: 'T099F304GAY', channelId: 'CUNKNOWN', slackUserId: 'UQA', threadTs: '1.1' };
  records.set('orgs/mysc/members/member', { email: 'qa@mysc.co.kr', role: 'finance', status: 'ACTIVE' });
  records.set('settlement_agent_jobs/first', { ...identity, status: 'queued', attempts: 0, conversationId: 'thread', createdAt: new Date().toISOString(), question: '정산 상태 확인해줘' });
  records.set('settlement_agent_threads/thread', { ...identity, queue: ['first'], turns: [] });
  const completeFactory = vi.fn();
  const fetchImpl = vi.fn(async (url) => url.includes('users.info')
    ? Response.json({ ok: true, user: { team_id: identity.teamId, profile: { email: 'qa@mysc.co.kr' } } })
    : Response.json({ ok: true, ts: '2.1', message_ts: '3.1' }));
  const worker = runtime.createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture' }, completeFactory, fetchImpl });
  await worker();
  expect(completeFactory).not.toHaveBeenCalled();
  expect(records.get('settlement_agent_jobs/first').answer).toContain('조회 도중 처리를 마치지 못했');
});

it('validates interactive raw form signatures before parsing payload', async () => {
  expect(typeof runtime.createFeedbackIngress).toBe('function');
  const body = Buffer.from('payload={}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = 'test';
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
  let status = 200;
  const res = { status: (s) => { status = s; return res; }, json: (v) => v };
  const handler = runtime.createFeedbackIngress({ db: {}, secret, teamId: 'TABC', channelIds: ['CABC'] });
  await handler({ body, get: (h) => h === 'x-slack-request-timestamp' ? timestamp : signature }, res);
  expect(status).toBe(403);
  await handler({ body: Buffer.from('tampered'), get: (h) => h === 'x-slack-request-timestamp' ? timestamp : signature }, res);
  expect(status).toBe(401);
});
