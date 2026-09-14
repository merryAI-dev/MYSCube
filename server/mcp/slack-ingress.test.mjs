import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createSlackIngress, verifySlackRequest } from './slack-ingress.mjs';

const now = 1789340000000;
const secret = 'test-only-signing-secret';
function request(payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const timestamp = String(now / 1000);
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
  return { body, get: (name) => name.endsWith('timestamp') ? timestamp : signature, timestamp, signature };
}
function response() {
  return { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
function store() {
  const documents = new Map();
  return { documents, doc: (path) => ({ path }), runTransaction: async (fn) => fn({
    get: async (ref) => ({ exists: documents.has(ref.path), data: () => documents.get(ref.path) }),
    set: (ref, value) => documents.set(ref.path, value), create: (ref, value) => documents.set(ref.path, value),
  }) };
}
describe('Slack ingress', () => {
  it('rejects replay and modified content', () => {
    const req = request({ text: 'hello' });
    expect(verifySlackRequest({ ...req, secret, now })).toBe(true);
    expect(verifySlackRequest({ ...req, secret, now: now + 301000 })).toBe(false);
    expect(verifySlackRequest({ ...req, body: Buffer.from('{}'), secret, now })).toBe(false);
  });
  it('persists before ACK and treats duplicate event as one job', async () => {
    const db = store();
    const handler = createSlackIngress({ db, secret, teamId: 'T1', now: () => now });
    const req = request({ team_id: 'T1', event_id: 'Ev1', type: 'event_callback', event: { type: 'app_mention', user: 'U1', text: '정산 확인', channel: 'C0BQ6980HR6', ts: '1.1' } });
    for (let i = 0; i < 2; i++) { const res = response(); await handler(req, res); expect(res.code).toBe(200); }
    expect([...db.documents.keys()].filter((key) => key.startsWith('settlement_agent_jobs/'))).toHaveLength(1);
  });
  it('queues multi-turn comments only for an established same-user thread and deduplicates event types', async () => {
    const db = store();
    const handler = createSlackIngress({ db, secret, teamId: 'T1', now: () => now });
    const send = async (event, eventId) => {
      const res = response();
      await handler(request({ team_id: 'T1', event_id: eventId, type: 'event_callback', event: { user: 'U1', channel: 'C0BQ6980HR6', ...event } }), res);
      return res;
    };
    await send({ type: 'message', text: 'general', ts: '1.1' }, 'E0');
    expect(db.documents.size).toBe(0);
    await send({ type: 'app_mention', text: 'AXR 9월 조회', ts: '1.1' }, 'E1');
    await send({ type: 'message', text: '8월도 조회', ts: '2.1', thread_ts: '1.1' }, 'E2');
    await send({ type: 'app_mention', text: '8월도 조회', ts: '2.1', thread_ts: '1.1' }, 'E3');
    await send({ type: 'message', text: '다른 사용자', user: 'U2', ts: '3.1', thread_ts: '1.1' }, 'E4');
    await send({ type: 'message', text: 'bot', bot_id: 'B1', ts: '4.1', thread_ts: '1.1' }, 'E5');
    const jobs = [...db.documents.values()].filter((v) => v.status === 'queued');
    expect(jobs).toHaveLength(2);
    expect(jobs[0].conversationId).toBe(jobs[1].conversationId);
    expect(jobs[0].createdAt < jobs[1].createdAt).toBe(true);
    const thread = db.documents.get(`settlement_agent_threads/${jobs[0].conversationId}`);
    expect(thread.queue).toHaveLength(2);
  });
  it('does not ACK failed persistence', async () => {
    const handler = createSlackIngress({ db: { doc: () => ({ create: async () => { throw new Error(); } }) }, secret, teamId: 'T1', now: () => now });
    const res = response();
    await handler(request({ team_id: 'T1', event_id: 'Ev1', type: 'event_callback', event: { type: 'app_mention', user: 'U1', text: '조회', channel: 'C0BQ6980HR6', ts: '1.1' } }), res);
    expect(res.code).toBe(503);
  });
});
