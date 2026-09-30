import { it, expect, vi } from 'vitest';
import { createSlackWorker } from './slack-runtime.mjs';
import { memoryDb, connectMerryhere, TEST_MERRYHERE_KEY } from './slack-test-store.mjs';

async function fixture({ question, turns = [], connected = true, alertFails = false }) {
  const { db, records } = memoryDb();
  const identity = { teamId: 'T099F304GAY', channelId: 'C0BQ6980HR6', slackUserId: 'UQA', threadTs: '1.1' };
  records.set('orgs/mysc/members/member', { email: 'qa@mysc.co.kr', role: 'finance', status: 'ACTIVE' });
  if (connected) await connectMerryhere(db, 'member', { loginId: 'fixture@example.test', password: 'private-password' });
  const enqueue = (id) => {
    records.set(`settlement_agent_jobs/${id}`, { ...identity, status: 'queued', attempts: 0, conversationId: 'thread', createdAt: new Date().toISOString(), question });
    records.set('settlement_agent_threads/thread', { ...identity, queue: [id], turns });
  };
  enqueue('first');
  const complete = vi.fn(async () => ({ content: 'fixture answer' }));
  const calls = [];
  const fetchImpl = vi.fn(async (url, options) => {
    if (url.includes('users.info')) return Response.json({ ok: true, user: { team_id: identity.teamId, profile: { email: 'qa@mysc.co.kr' } } });
    if (url.startsWith('https://slack.com/')) {
      const body = JSON.parse(options.body); calls.push(body);
      return Response.json(body.channel === 'COPS' && alertFails ? { ok: false, error: 'channel_not_found' } : { ok: true, ts: '2.1', message_ts: '3.1' });
    }
    return new Response('<html>provider markup changed</html>');
  });
  const worker = createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture', SLACK_ALERT_CHANNEL_ID: 'COPS', SETTLEMENT_AGENT_GEMINI_API_KEY: 'fixture',
    MERRYHERE_CREDENTIAL_KEY: TEST_MERRYHERE_KEY },
    readSnapshot: async () => ({}), completeFactory: () => complete, fetchImpl });
  return { worker, records, complete, calls, enqueue };
}

const context = { query: { date: '2026-09-30' }, missing: ['meridiem'], requestedAction: 'explore' };
const turns = [{ question: '내일 6시 회의실', answer: '오전 오후?', bookingContext: context }, { question: '정산 상태', answer: '확인 결과', bookingContext: null }];

it('restores the latest room context across an intervening turn and restricts unresolved followups to the room tool', async () => {
  const f = await fixture({ question: '오후 6시', turns });
  let capturedTools, capturedMessages;
  f.complete.mockImplementation(async ({ tools, messages }) => {
    capturedTools = tools; capturedMessages = messages;
    return { tool_calls: [{ id: 'rooms', function: { name: 'merryhere_rooms', arguments: JSON.stringify({ action: 'explore', inherit: true, query: { start: '18:00' }, missing: [] }) } }] };
  });
  await f.worker();
  const system = capturedMessages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  expect(system).toContain('merryhere_rooms');
  expect(system).not.toMatch(/CFO|정산 도우미|accounting_report|월결산/);
  expect(capturedTools.find(t => t.function.name === 'merryhere_rooms').function.description).toMatch(/현재 한국 시각: \d{4}-\d{2}-\d{2}\([월화수목금토일]\) \d{2}:\d{2}/);
  expect(capturedTools.map(t => t.function.name)).toEqual(['merryhere_rooms']);
  expect(capturedTools[0].function.description).toContain('2026-09-30');
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.records.get('settlement_agent_jobs/first').bookingContext.query).toMatchObject({ date: '2026-09-30', start: '18:00' });
});

it('does not block a financial topic switch on a missing room account or force a room-only toolset', async () => {
  const f = await fixture({ question: '에코 사업 9월과 8월 실적 비교해줘', turns, connected: false });
  let capturedTools, capturedMessages;
  f.complete.mockImplementation(async ({ tools, messages }) => {
    capturedTools = tools; capturedMessages = messages;
    return { content: 'fixture answer' };
  });
  await f.worker();
  expect(capturedTools.map(t => t.function.name)).toContain('accounting_compare');
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.records.get('settlement_agent_jobs/first').answer).not.toContain('서버 자동 로그인 설정');
});

it.each([false, true])('alerts on provider markup drift and preserves the failure reply when alert delivery fails=%s', async (alertFails) => {
  const f = await fixture({ question: '회의실 알려줘', alertFails });
  f.complete.mockResolvedValue({ tool_calls: [{ id: 'rooms', function: { name: 'merryhere_rooms', arguments: JSON.stringify({ action: 'explore', inherit: false, query: {}, missing: [] }) } }] });
  await f.worker();
  expect(f.records.get('settlement_agent_jobs/first').answer).toContain('응답 형식이 예상과 달라');
  expect(f.records.get('merryhere_provider_alerts/page_changed').status).toBe(alertFails ? 'failed' : 'sent');
  f.enqueue('second'); await f.worker();
  expect(f.calls.filter(body => body.channel === 'COPS')).toHaveLength(1);
  if (alertFails) {
    const alert = f.records.get('merryhere_provider_alerts/page_changed');
    f.records.set('merryhere_provider_alerts/page_changed', { ...alert, nextAttemptAt: Date.now() - 1 });
    f.enqueue('third'); await f.worker();
    expect(f.calls.filter(body => body.channel === 'COPS')).toHaveLength(2);
  }
  expect(JSON.stringify([...f.records])).not.toContain('private-password');
  expect(JSON.stringify(f.calls)).not.toContain('private-password');
});
