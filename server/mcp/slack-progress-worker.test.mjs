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
      await send(call);
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
  expect(calls.at(-1).text).toContain('[정산 완료 여부]');
  expect(records.get('settlement_agent_jobs/j').status).toBe('succeeded');
});

it('progress transport failure does not suppress the verified final answer', async () => {
  const { worker, calls, records } = fixture({ send: async (call) => {
    if (call.text.startsWith('⏳')) throw new Error('timeout');
  } });
  await worker();
  expect(calls.at(-1).text).toContain('1주차: 승인 완료 1개');
  expect(calls.at(-1).method).toBe('chat.postMessage');
  expect(records.get('settlement_agent_jobs/j').status).toBe('succeeded');
});

it('keeps private failure details out of the public terminal receipt', async () => {
  const { worker, calls, records } = fixture({ question: 'A사업 비교해줘' });
  await worker();
  expect(calls.some((call) => call.method === 'chat.postEphemeral')).toBe(true);
  expect(calls.at(-1)).toMatchObject({ method: 'chat.update', ts: '2.1' });
  expect(calls.at(-1).text).toBe('요청 처리가 끝났습니다. 자세한 안내는 요청자에게만 표시됩니다.');
  expect(calls.at(-1).text).not.toMatch(/model_not_configured|승인 완료/);
  expect(records.get('settlement_agent_jobs/j').status).toBe('succeeded');
});

it.each(['sending', 'running'])('recovers abandoned %s without erasing potentially delivered answers', async (status) => {
  const { worker, calls, records } = fixture({ jobPatch: { status, leaseId: 'old', leaseUntil: Date.now() - 1, attempts: 3 } });
  await worker();
  expect(calls).toHaveLength(status === 'sending' ? 0 : 1);
  if (status !== 'sending') {
    expect(calls[0].method).toBe('chat.update');
    expect(calls[0].text).toContain('처리 또는 응답 전달 상태');
    expect(calls[0].text).not.toContain('승인 완료');
  }
  expect(records.get('settlement_agent_jobs/j').status).toBe(status === 'sending' ? 'delivery_unknown' : 'failed');
});


it('preserves a remotely delivered final answer if the update response is lost', async () => {
  let remoteText;
  const { worker, calls, records } = fixture({ send: async (call) => {
    remoteText = call.text;
    if (call.text.includes('[정산 완료 여부]')) throw new Error('response lost after delivery');
  } });
  await worker();
  expect(remoteText).toContain('[정산 완료 여부]');
  expect(calls.at(-1).text).toBe(remoteText);
  expect(records.get('settlement_agent_jobs/j')).toMatchObject({ status: 'delivery_unknown', answerDelivery: 'update' });
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
  expect(calls.at(-1).text).toContain('1주차: 승인 완료 1개');
  expect(calls.at(-1).text).not.toContain('999');
});
