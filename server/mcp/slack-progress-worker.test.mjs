import { it, expect, vi } from 'vitest';
import { createSlackWorker } from './slack-runtime.mjs';
import { memoryDb, statusOverview } from './slack-test-store.mjs';

function fixture({ question = '전체 등록 사업 2026년 9월 주정산 여부만', jobPatch = {}, send = async () => {}, readOverview = statusOverview, env = {}, completeFactory, hermesRunner } = {}) {
  const { db, records } = memoryDb();
  records.set('orgs/mysc/members/qa', { email: 'qa@mysc.co.kr', role: 'finance', status: 'ACTIVE' });
  records.set('orgs/mysc/projects/a', { name: 'A사업' });
  records.set('settlement_agent_jobs/j', { status: 'queued', attempts: 0, createdAt: '2026-09-28T00:00:00Z',
    teamId: 'T099F304GAY', channelId: 'C0BQ6980HR6', slackUserId: 'UQA', threadTs: '1.1', progressTs: '2.1', question, ...jobPatch });
  const calls = [];
  const worker = createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture', ...env }, readOverview, completeFactory, hermesRunner,
    fetchImpl: async (url, options) => {
      if (url.includes('users.info')) return Response.json({ ok: true, user: { team_id: 'T099F304GAY', profile: { email: 'qa@mysc.co.kr' } } });
      const call = { method: url.split('/').at(-1), ...JSON.parse(options.body) };
      calls.push(call);
      const custom = await send(call);
      if (custom instanceof Response) return custom;
      return Response.json({ ok: true, ts: '2.1', message_ts: '3.1' });
    },
  });
  return { worker, calls, records };
}

it('never sends the verified final answer before an in-flight progress update finishes', async () => {
  let release;
  const { worker, calls, records } = fixture({ send: (call) => call.text.startsWith('⏳')
    ? new Promise((resolve) => { release = resolve; }) : undefined });
  const work = worker();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(calls).toHaveLength(1);
  expect(records.get('settlement_agent_jobs/j').status).toBe('running');
  release(); await work;
  const final = calls.find((call) => call.method === 'chat.postMessage');
  expect(final.text).toContain('[정산 완료 여부]');
  expect(final).not.toHaveProperty('ts');
  expect(final.thread_ts).toBe('1.1');
  expect(calls.at(-1)).toMatchObject({ method: 'chat.update', ts: '2.1' });
  expect(records.get('settlement_agent_jobs/j').status).toBe('succeeded');
});

it('progress transport failure does not suppress the verified final answer', async () => {
  const { worker, calls, records } = fixture({ send: async (call) => {
    if (call.text.startsWith('⏳')) throw new Error('timeout');
  } });
  await worker();
  const final = calls.find((call) => call.method === 'chat.postMessage');
  expect(final.text).toContain('1주차: 승인 완료 1개');
  expect(final).not.toHaveProperty('ts');
  expect(records.get('settlement_agent_jobs/j').status).toBe('succeeded');
});

it('keeps private failure details out of the public terminal receipt', async () => {
  const { worker, calls, records } = fixture({ question: 'A사업 비교해줘' });
  await worker();
  const final = calls.find((call) => call.method === 'chat.postEphemeral');
  expect(final).toBeDefined();
  expect(final).not.toHaveProperty('ts');
  expect(final.thread_ts).toBe('1.1');
  expect(calls.at(-1)).toMatchObject({ method: 'chat.update', ts: '2.1' });
  expect(calls.at(-1).text).toBe('요청 처리가 끝났습니다. 자세한 안내는 요청자에게만 표시됩니다.');
  expect(calls.at(-1).text).not.toMatch(/model_not_configured|승인 완료/);
  expect(records.get('settlement_agent_jobs/j').status).toBe('succeeded');
});

it.each(['sending', 'running'])('recovers abandoned %s without erasing potentially delivered answers', async (status) => {
  const { worker, calls, records } = fixture({ jobPatch: { status, leaseId: 'old', leaseUntil: Date.now() - 1, attempts: 3 } });
  await worker();
  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe('chat.update');
  expect(calls[0].text).toMatch(/전달 여부를 확인하지 못했습니다|Slack에서 거부되었습니다/);
  expect(calls[0].text).not.toContain('승인 완료');
  expect(records.get('settlement_agent_jobs/j').status).toBe(status === 'sending' ? 'delivery_unknown' : 'failed');
});

it('repairs only the receipt of a terminal separately-posted answer without resending it', async () => {
  const { worker, calls, records } = fixture({ jobPatch: { status: 'succeeded', leaseId: 'done', leaseUntil: Date.now() + 60_000,
    deliveryMethod: 'chat.postMessage', answerDelivery: 'public', receiptStatus: 'failed' } });
  expect(await worker()).toEqual({ processed: 0 });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: 'chat.update', ts: '2.1' });
  expect(calls[0].text).toContain('결과는 아래 답변');
  expect(calls.some((call) => call.method === 'chat.postMessage')).toBe(false);
  expect(records.get('settlement_agent_jobs/j').receiptStatus).toBe('succeeded');
  expect(records.get('settlement_agent_jobs/j').receiptFailure).toBeNull();
});

it('does not retry legacy, foreign, exhausted or definitively rejected terminal receipts', async () => {
  const { worker, calls, records } = fixture({ jobPatch: { status: 'succeeded', leaseId: 'done', leaseUntil: Date.now() + 60_000,
    deliveryMethod: 'chat.update', answerDelivery: 'public', receiptStatus: 'failed' } });
  records.set('settlement_agent_jobs/definitive', { ...records.get('settlement_agent_jobs/j'), deliveryMethod: 'chat.postMessage',
    receiptFailure: { definitive: true }, teamId: 'T099F304GAY', channelId: 'C0BQ6980HR6' });
  records.set('settlement_agent_jobs/exhausted', { ...records.get('settlement_agent_jobs/j'), deliveryMethod: 'chat.postMessage',
    receiptRepairAttempts: 3, teamId: 'T099F304GAY', channelId: 'C0BQ6980HR6' });
  records.set('settlement_agent_jobs/foreign', { ...records.get('settlement_agent_jobs/j'), deliveryMethod: 'chat.postMessage',
    teamId: 'TOTHER', channelId: 'COTHER' });
  expect(await worker()).toEqual({ processed: 0 });
  expect(calls).toHaveLength(0);
});

it('keeps a successful final delivery terminal when receipt updates fail and records that failure', async () => {
  let receiptAttempts = 0;
  const { worker, calls, records } = fixture({ send: async (call) => {
    if (call.method === 'chat.update' && !call.text.startsWith('⏳')) { receiptAttempts++; throw new Error('receipt transport lost'); }
  } });
  await worker();
  expect(calls.filter((call) => call.method === 'chat.postMessage')).toHaveLength(1);
  expect(receiptAttempts).toBe(2);
  expect(records.get('settlement_agent_jobs/j')).toMatchObject({ status: 'succeeded', receiptStatus: 'failed',
    receiptFailure: { method: 'chat.update', code: 'transport_error', definitive: false } });
});


it('marks an uncertain post without retrying the business answer and replaces only the receipt', async () => {
  let finalCalls = 0;
  const { worker, calls, records } = fixture({ send: async (call) => {
    if (call.text.includes('[정산 완료 여부]')) { finalCalls++; throw new Error('response lost after delivery'); }
  } });
  await worker();
  expect(finalCalls).toBe(1);
  expect(calls.at(-1)).toMatchObject({ method: 'chat.update', ts: '2.1' });
  expect(calls.at(-1).text).toContain('전달 여부를 확인하지 못했습니다');
  expect(records.get('settlement_agent_jobs/j')).toMatchObject({ status: 'delivery_unknown', answerDelivery: 'public',
    deliveryMethod: 'chat.postMessage', deliveryFailure: { method: 'chat.postMessage', code: 'transport_error', definitive: false } });
});

it('persists a definitive Slack rejection and exposes no business answer in the receipt', async () => {
  const { worker, calls, records } = fixture({ send: async (call) => call.method === 'chat.postMessage'
    ? Response.json({ ok: false, error: 'not_in_channel' }) : undefined });
  await worker();
  expect(calls.filter((call) => call.method === 'chat.postMessage')).toHaveLength(1);
  expect(calls.at(-1).text).toContain('Slack에서 거부되었습니다');
  expect(calls.at(-1).text).not.toContain('승인 완료');
  expect(records.get('settlement_agent_jobs/j')).toMatchObject({ status: 'failed',
    deliveryFailure: { method: 'chat.postMessage', code: 'not_in_channel', definitive: true } });
});

it('treats Slack internal errors as uncertain and never retries the business answer', async () => {
  const { worker, calls, records } = fixture({ send: async (call) => call.method === 'chat.postMessage'
    ? Response.json({ ok: false, error: 'internal_error' }) : undefined });
  await worker();
  expect(calls.filter((call) => call.method === 'chat.postMessage')).toHaveLength(1);
  expect(records.get('settlement_agent_jobs/j')).toMatchObject({ status: 'delivery_unknown',
    deliveryFailure: { code: 'internal_error', definitive: false } });
});

it.each([
  [{ ok: true }, 'invalid_response'],
  [{ ok: false, error: 'secret_or_new_slack_error' }, 'unavailable'],
])('does not claim delivery from an unusable Slack response', async (response, code) => {
  const { worker, calls, records } = fixture({ send: async (call) => call.method === 'chat.postMessage'
    ? Response.json(response) : undefined });
  await worker();
  expect(calls.filter((call) => call.method === 'chat.postMessage')).toHaveLength(1);
  expect(records.get('settlement_agent_jobs/j')).toMatchObject({ status: 'delivery_unknown',
    deliveryFailure: { code, definitive: false } });
  expect(JSON.stringify(records.get('settlement_agent_jobs/j'))).not.toContain('secret_or_new_slack_error');
});

it('retries a definitive block rejection once with a minimal text-only post', async () => {
  let posts = 0;
  const { worker, calls, records } = fixture({ send: async (call) => {
    if (call.method === 'chat.postMessage' && ++posts === 1) return Response.json({ ok: false, error: 'invalid_blocks' });
  } });
  await worker();
  const finals = calls.filter((call) => call.method === 'chat.postMessage');
  expect(finals).toHaveLength(2);
  expect(finals[0].blocks.length).toBeGreaterThan(0);
  expect(finals[1]).not.toHaveProperty('blocks');
  expect(records.get('settlement_agent_jobs/j')).toMatchObject({ status: 'succeeded',
    deliveryFallback: { method: 'chat.postMessage', code: 'invalid_blocks', definitive: true } });
});


it.each(['baseline', 'hermes'])('publishes actual tool stages on the %s path while the read is pending', async (variant) => {
  let turn = 0;
  const { worker, calls } = fixture({ question: `[${variant}] A사업 2026년 9월 주정산 여부만`,
    env: { SETTLEMENT_AGENT_GEMINI_API_KEY: 'fixture', SETTLEMENT_HERMES_URL: 'https://fixture.run.app' },
    readOverview: async (input) => { await new Promise((resolve) => setTimeout(resolve, 1700)); return statusOverview(input); },
    completeFactory: () => async () => turn++ ? { content: '999개 승인 완료' } : { tool_calls: [{ id: 'lookup', function: {
      name: 'settlement_status_report', arguments: JSON.stringify({ kind: 'week', yearMonth: '2026-09', projectIds: ['a'] }),
    } }] },
    hermesRunner: async ({ tools, signal }) => {
      const tool = tools.find((item) => item.name === 'settlement_status_report');
      const result = await tool.execute({ kind: 'week', yearMonth: '2026-09', projectIds: ['a'] }, { signal });
      return { status: 'answered', answer: tool.render(result) };
    },
  });
  await worker();
  expect(calls.some((call) => call.text.startsWith('⏳') && call.text.includes('주정산·월결산 상태'))).toBe(true);
  const final = calls.find((call) => call.method === 'chat.postMessage');
  expect(final.text).toContain('1주차: 승인 완료 1개');
  expect(final.text).not.toContain('999');
});
