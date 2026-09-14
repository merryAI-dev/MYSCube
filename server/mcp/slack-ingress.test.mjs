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
describe('Slack ingress', () => {
  it('rejects replay and modified content', () => {
    const req = request({ text: 'hello' });
    expect(verifySlackRequest({ ...req, secret, now })).toBe(true);
    expect(verifySlackRequest({ ...req, secret, now: now + 301000 })).toBe(false);
    expect(verifySlackRequest({ ...req, body: Buffer.from('{}'), secret, now })).toBe(false);
  });
  it('persists before ACK and treats duplicate event as one job', async () => {
    const jobs = new Map();
    const db = { doc: (id) => ({ create: async (value) => {
      if (jobs.has(id)) throw Object.assign(new Error(), { code: 6 });
      jobs.set(id, value);
    } }) };
    const handler = createSlackIngress({ db, secret, teamId: 'T1', now: () => now });
    const req = request({ team_id: 'T1', event_id: 'Ev1', type: 'event_callback', event: { type: 'app_mention', user: 'U1', text: '정산 확인', channel: 'C0BQ6980HR6', ts: '1.1' } });
    for (let i = 0; i < 2; i++) { const res = response(); await handler(req, res); expect(res.code).toBe(200); }
    expect(jobs.size).toBe(1);
  });
  it('does not ACK failed persistence', async () => {
    const handler = createSlackIngress({ db: { doc: () => ({ create: async () => { throw new Error(); } }) }, secret, teamId: 'T1', now: () => now });
    const res = response();
    await handler(request({ team_id: 'T1', event_id: 'Ev1', type: 'event_callback', event: { type: 'app_mention', user: 'U1', text: '조회', channel: 'C0BQ6980HR6', ts: '1' } }), res);
    expect(res.code).toBe(503);
  });
});
