import { createHmac, randomUUID } from 'node:crypto';

const base = process.env.SETTLEMENT_CANARY_BASE_URL || 'https://myscube.myscguard.app';
const secret = process.env.SLACK_SIGNING_SECRET;
if (!secret) throw new Error('Signing secret is required');
async function request(path, options = {}) {
  return fetch(`${base}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { ...options.headers, ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {}) },
  });
}
async function signed(path, body, type, tampered = false) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  return request(path, { method: 'POST', body: tampered ? `${body} ` : body,
    headers: { 'content-type': type, 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature },
  });
}
const challenge = randomUUID();
const json = JSON.stringify({ type: 'url_verification', challenge });
const response = await signed('/api/slack/events', json, 'application/json');
if (response.status !== 200 || (await response.json()).challenge !== challenge) throw new Error(`Slack JSON signature probe failed: ${response.status}`);
if ((await signed('/api/slack/events', json, 'application/json', true)).status !== 401) throw new Error('Tampered JSON was not rejected');
const form = 'payload=%7B%7D';
const feedback = await signed('/api/slack/interactions', form, 'application/x-www-form-urlencoded');
if (feedback.status !== 403 || (await feedback.json()).error !== 'feedback_not_allowed') throw new Error(`Slack form signature probe failed: ${feedback.status}`);
if ((await signed('/api/slack/interactions', form, 'application/x-www-form-urlencoded', true)).status !== 401) throw new Error('Tampered form was not rejected');
const worker = await request('/api/internal/workers/settlement-agent/run');
if (worker.status !== 401 || (await worker.json()).error !== 'unauthorized_worker') throw new Error(`Worker auth probe failed: ${worker.status}`);
console.log(JSON.stringify({ signedJson: true, signedForm: true, tamperingRejected: true, workerAuthRequired: true, businessWrites: false }));
