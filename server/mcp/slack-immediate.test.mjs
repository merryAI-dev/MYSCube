import { it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createSlackIngress } from './slack-ingress.mjs';
import { createSlackWorker } from './slack-runtime.mjs';
import { memoryDb, statusOverview } from './slack-test-store.mjs';

function signed(text, ts = '1790565660.1', threadTs) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = Buffer.from(JSON.stringify({ type: 'event_callback', team_id: 'T099F304GAY', event_id: ts, event: {
    type: threadTs ? 'message' : 'app_mention', user: 'UQA', channel: 'C0BQ6980HR6', ts, thread_ts: threadTs, text,
  } }));
  const signature = `v0=${createHmac('sha256', 'fixture').update(`v0:${timestamp}:`).update(body).digest('hex')}`;
  return { body, get: (name) => name.endsWith('timestamp') ? timestamp : signature };
}
const response = () => ({ status() { return this; }, json(value) { this.value = value; return this; } });

it('ACKs without waiting for execution, persists before scheduling, and deduplicates wakeup', async () => {
  const { db, records } = memoryDb();
  let finish;
  const onQueued = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  const deferred = [];
  const defer = (promise) => { expect([...records.values()].some((row) => row.status === 'queued')).toBe(true); deferred.push(promise); };
  const handler = createSlackIngress({ db, secret: 'fixture', teamId: 'T099F304GAY', defer, onQueued });
  const req = signed('CFO 브리핑 해줘');
  const res = response();
  await handler(req, res);
  expect(res.value.ok).toBe(true);
  expect(onQueued).toHaveBeenCalledTimes(1);
  await handler(req, response());
  expect(deferred).toHaveLength(1);
  finish(); await deferred[0];
  await handler({ ...req, body: Buffer.from('{}') }, response());
  expect(deferred).toHaveLength(1);
});

it('delivers corrected status directly, updates progress, and drains a reply queued during the first read', async () => {
  const { db, records } = memoryDb();
  records.set('orgs/mysc/members/qa', { email: 'qa@mysc.co.kr', role: 'finance', status: 'ACTIVE' });
  records.set('orgs/mysc/projects/a', { name: 'A사업' });
  const deferred = [];
  const posts = [];
  const fetchImpl = vi.fn(async (url, options) => {
    if (url.includes('users.info')) return Response.json({ ok: true, user: { team_id: 'T099F304GAY', profile: { email: 'qa@mysc.co.kr' } } });
    posts.push({ method: url.split('/').at(-1), ...JSON.parse(options.body) });
    return Response.json({ ok: true, ts: `${posts.length}.1` });
  });
  const completeFactory = vi.fn(() => { throw new Error('model must not run'); });
  const readSnapshot = vi.fn(() => { throw new Error('financial reads forbidden'); });
  let handler;
  let reads = 0;
  const worker = createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture' }, fetchImpl, completeFactory, readSnapshot,
    readOverview: async (req) => {
      expect(req.context.actorRole).toBe('auditor');
      if (++reads === 1) {
        expect(req.body.yearMonth).toBe('2026-09');
        await handler(signed('전체 등록 사업 2026년 10월 주정산 여부만', '1790565660.2', '1790565660.1'), response());
        await deferred[1];
      }
      return statusOverview(req);
    },
  });
  handler = createSlackIngress({ db, secret: 'fixture', teamId: 'T099F304GAY', botToken: 'fixture', fetchImpl,
    defer: (promise) => deferred.push(promise), onQueued: (jobId) => worker({ jobId }) });
  await handler(signed('어 미안 전체 등록된 사업의 2026년 9월 주정산 결과를 여부만 이야기해줘'), response());
  await deferred[0];
  expect(reads).toBe(2);
  expect(completeFactory).not.toHaveBeenCalled();
  expect(readSnapshot).not.toHaveBeenCalled();
  const answers = posts.filter((post) => post.method === 'chat.update' && post.text.includes('[정산 완료 여부]'));
  expect(posts.some((post) => post.method === 'chat.update' && post.text.startsWith('⏳'))).toBe(true);
  expect(answers).toHaveLength(2);
  expect(answers[0].text).toContain('1주차: 승인 완료 1개');
  expect(answers[1].text).toContain('주정산: 2026-10');
  expect(answers[0].text).not.toMatch(/입금|출금|원\(KRW\)/);
  const jobs = [...records].filter(([key]) => /^settlement_agent_jobs\/[^/]+$/.test(key)).map(([, value]) => value);
  expect(jobs.every((job) => job.status === 'succeeded')).toBe(true);
  expect(jobs[0].answer).toContain('1주차: 승인 완료 1개');
  expect(await worker()).toEqual({ processed: 0 });
});

it('does not run disabled workers and retains durable recovery after a rejected background run', async () => {
  const { db, records } = memoryDb();
  const readOverview = vi.fn();
  const worker = createSlackWorker({ db, env: { BFF_WORKERS_ENABLED: 'false' }, readOverview });
  const deferred = [];
  const handler = createSlackIngress({ db, secret: 'fixture', teamId: 'T099F304GAY', defer: (promise) => deferred.push(promise), onQueued: (jobId) => worker({ jobId }) });
  await handler(signed('CFO 브리핑 해줘'), response()); await deferred[0];
  expect([...records.values()].some((row) => row.status === 'queued')).toBe(true);
  expect(readOverview).not.toHaveBeenCalled();
  const rejected = [];
  const broken = createSlackIngress({ db, secret: 'fixture', teamId: 'T099F304GAY', defer: (promise) => rejected.push(promise),
    onQueued: async () => { throw new Error('worker offline'); } });
  await broken(signed('CFO 브리핑 해줘', '1790565660.3'), response()); await rejected[0];
  expect([...records.values()].filter((row) => row.status === 'queued')).toHaveLength(2);
});

it('blocks an adversarial financial tool call on a narrow status request after CFO history', async () => {
  const { db, records } = memoryDb();
  records.set('orgs/mysc/members/qa', { email: 'qa@mysc.co.kr', role: 'finance', status: 'ACTIVE' });
  const handler = createSlackIngress({ db, secret: 'fixture', teamId: 'T099F304GAY' });
  await handler(signed('A사업 2026년 9월 주정산 여부만 알려줘'), response());
  const thread = [...records.values()].find((row) => Array.isArray(row.turns));
  thread.turns.push({ question: 'CFO 브리핑 해줘', answer: '이전 금액 보고서', jobId: 'old' });
  const readSnapshot = vi.fn();
  let financialToolExposed = false;
  const worker = createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture', SETTLEMENT_AGENT_GEMINI_API_KEY: 'fixture' }, readSnapshot,
    fetchImpl: async (url) => Response.json(url.includes('users.info')
      ? { ok: true, user: { team_id: 'T099F304GAY', profile: { email: 'qa@mysc.co.kr' } } } : { ok: true, ts: '9.1' }),
    completeFactory: () => async ({ tools }) => {
      financialToolExposed ||= tools.some((tool) => ['accounting_report', 'cfo_brief'].includes(tool.function.name));
      return { tool_calls: [{ id: 'bad', function: { name: 'accounting_report', arguments: '{"yearMonth":"2026-09"}' } }] };
    },
  });
  await worker();
  expect(financialToolExposed).toBe(false);
  expect(readSnapshot).not.toHaveBeenCalled();
  const job = [...records.values()].find((row) => row.question === 'A사업 2026년 9월 주정산 여부만 알려줘' && row.status);
  expect(job.answer).not.toMatch(/계획:|실적:|원\(KRW\)/);
});
