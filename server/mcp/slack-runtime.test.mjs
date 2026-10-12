import { it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import * as runtime from './slack-runtime.mjs';
import { memoryDb, statusOverview } from './slack-test-store.mjs';

it('parses only the explicit Korean month-close preview command in KST', () => {
  expect(runtime.parseMonthClosePreviewCommand('<@UBOT> 월결산 리마인드 미리보기 2026-10 제출 2026-10-10 23:59 승인 2026-10-13 23:59')).toEqual({ input: {
    yearMonth: '2026-10', submissionDeadlineAt: '2026-10-10T23:59:00+09:00', approvalDeadlineAt: '2026-10-13T23:59:00+09:00',
  } });
  expect(runtime.parseMonthClosePreviewCommand('<@UBOT> 월결산 리마인드 미리보기 2026-10 제출 2026-10-10 23:59 승인 2026-10-13 23:59 *다음을 사용하여 보냄* <@U0BHJEU5REW>')).toEqual({ input: {
    yearMonth: '2026-10', submissionDeadlineAt: '2026-10-10T23:59:00+09:00', approvalDeadlineAt: '2026-10-13T23:59:00+09:00',
  } });
  for (const suffix of [
    '\n임의 후행 명령',
    '\n2026-11 제출 2026-11-10 23:59 승인 2026-11-13 23:59',
    ' *다음을 사용하여 보냄* <@UOTHER>',
    ' *다음을 사용하여 보냄* <@U0BHJEU5REW|ChatGPT>',
    ' *다음을 사용하여 보냄* <@U0BHJEU5REW> 추가 텍스트',
    '\n*다음을 사용하여 보냄* <@U0BHJEU5REW>',
  ]) expect(runtime.parseMonthClosePreviewCommand(`월결산 리마인드 미리보기 2026-10 제출 2026-10-10 23:59 승인 2026-10-13 23:59${suffix}`)).toEqual({ error: 'month_close_preview_usage' });
  expect(runtime.parseMonthClosePreviewCommand('월결산 현황')).toBeNull();
  expect(runtime.parseMonthClosePreviewCommand('월결산 리마인드 미리보기')).toEqual({ error: 'month_close_preview_usage' });
  expect(runtime.parseMonthClosePreviewCommand('월결산 리마인드 미리보기 2026-10 제출 2026-09-31 23:59 승인 2026-10-13 23:59')).toEqual({ error: 'month_close_preview_usage' });
  expect(runtime.parseMonthClosePreviewCommand('월결산 리마인드 미리보기 2026-10 제출 2026-10-10 18:00 승인 2026-10-09 18:00')).toEqual({ error: 'month_close_preview_usage' });
});

it('delivers an authorized month-close preview only to the verified requester without invoking the model', async () => {
  const { db, records } = memoryDb();
  const identity = { teamId: 'T099F304GAY', channelId: 'C0BQ6980HR6', slackUserId: 'UQA', threadTs: '1.1' };
  records.set('orgs/mysc/members/member', { email: 'qa@mysc.co.kr', role: 'finance', status: 'ACTIVE' });
  records.set('orgs/mysc/projects/a', { name: 'A사업', cic: 'CIC1', department: 'CIC1', managerId: 'manager-a', status: 'IN_PROGRESS', contractEnd: '2026-12-31' });
  records.set('orgs/mysc/persons/person-a', { uid: 'manager-a', name: '담당자' });
  records.set('settlement_agent_jobs/first', { ...identity, status: 'queued', attempts: 0, conversationId: 'thread', createdAt: new Date().toISOString(),
    question: '월결산 리마인드 미리보기 2026-10 제출 2026-10-10 23:59 승인 2026-10-13 23:59 *다음을 사용하여 보냄* <@U0BHJEU5REW>' });
  records.set('settlement_agent_threads/thread', { ...identity, queue: ['first'], turns: [] });
  const calls = []; const completeFactory = vi.fn(); const observed = [];
  const fetchImpl = vi.fn(async (url, options) => {
    if (url.includes('users.info')) return Response.json({ ok: true, user: { team_id: identity.teamId, profile: { email: 'qa@mysc.co.kr' } } });
    calls.push({ method: url.split('/').at(-1), body: JSON.parse(options.body) });
    if (calls.length === 1) return Response.json({ ok: false, error: 'invalid_blocks' });
    return Response.json({ ok: true, channel: 'DQA', ts: '2.1', message_ts: '3.1' });
  });
  const worker = runtime.createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture' }, completeFactory, fetchImpl,
    readOverview: async (request) => { observed.push(request); return statusOverview(request); } });
  await worker();
  expect(completeFactory).not.toHaveBeenCalled();
  expect(observed[0].context).toMatchObject({ actorId: 'member', actorRole: 'finance', authSource: 'slack_verified' });
  const delivery = calls.at(-1);
  expect(delivery.body).toMatchObject({ channel: identity.slackUserId });
  for (const call of calls) {
    expect(call.method).toBe('chat.postMessage');
    expect(call.body).toMatchObject({ channel: identity.slackUserId });
    expect(call.body).not.toHaveProperty('user');
    expect(call.body).not.toHaveProperty('thread_ts');
  }
  expect(delivery.body.text).toContain('월결산 미리보기입니다. 실제 정기 공지는 발송되지 않습니다.');
  expect(delivery.body.text).toContain('노출 범위: 요청자 개인 DM');
  expect(calls).toHaveLength(2);
  expect(records.get('settlement_agent_threads/thread').turns).toEqual([]);
  expect(records.get('settlement_agent_jobs/first').answer).toBe('[private answer omitted]');
  expect(records.get('settlement_agent_jobs/first')).toMatchObject({
    answerDelivery: 'private', deliveryMethod: 'chat.postMessage', answerChannelId: 'DQA', answerTs: '2.1',
    deliveryFallback: { method: 'chat.postMessage', code: 'invalid_blocks', definitive: true },
  });
  expect(JSON.stringify([...records].filter(([key]) => key.includes('/trace/')))).not.toContain('A사업');
});

it('lets an ACTIVE viewer post a month-close preview only to the approved request thread and verifies its permalink', async () => {
  const { db, records } = memoryDb();
  const identity = { teamId: 'T099F304GAY', channelId: 'C0C6DLPBJ00', slackUserId: 'UQA', threadTs: '1791782928.927269' };
  records.set('orgs/mysc/members/member', { email: 'qa@mysc.co.kr', role: 'viewer', status: 'ACTIVE' });
  records.set('orgs/mysc/projects/a', { name: 'A사업', cic: 'CIC1', department: 'CIC1', managerId: 'manager-a', status: 'IN_PROGRESS', contractEnd: '2026-12-31' });
  records.set('orgs/mysc/persons/person-a', { uid: 'manager-a', name: '담당자' });
  records.set('settlement_agent_jobs/first', { ...identity, status: 'queued', attempts: 0, conversationId: 'thread', createdAt: new Date().toISOString(),
    question: '월결산 리마인드 미리보기 2026-10 제출 2026-10-10 23:59 승인 2026-10-13 23:59' });
  records.set('settlement_agent_threads/thread', { ...identity, queue: ['first'], turns: [] });
  const calls = [];
  const worker = runtime.createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture' },
    readOverview: async (request) => statusOverview(request), fetchImpl: async (url, options) => {
      if (url.includes('users.info')) return Response.json({ ok: true, user: { team_id: identity.teamId, profile: { email: 'qa@mysc.co.kr' } } });
      const call = { method: url.split('/').at(-1), body: JSON.parse(options.body) }; calls.push(call);
      if (call.method === 'chat.getPermalink') return Response.json({ ok: true, permalink: 'https://themysc.slack.com/archives/C0C6DLPBJ00/p1791783205202689' });
      return Response.json({ ok: true, channel: identity.channelId, ts: '1791783205.202689' });
    } });
  await worker();
  expect(calls[0]).toMatchObject({ method: 'chat.postMessage', body: { channel: identity.channelId, thread_ts: identity.threadTs } });
  expect(calls[0].body).not.toHaveProperty('user');
  expect(calls[0].body.text).toContain('노출 범위: 이 요청 스레드의 채널 구성원');
  expect(calls[0].body.text).toContain('월결산 리마인드 채널 미리보기');
  expect(calls[1]).toEqual({ method: 'chat.getPermalink', body: { channel: identity.channelId, message_ts: '1791783205.202689' } });
  expect(records.get('settlement_agent_jobs/first')).toMatchObject({ status: 'succeeded', answerDelivery: 'public', deliveryMethod: 'chat.postMessage',
    answer: '[private answer omitted]', historyVisibility: 'private', answerChannelId: identity.channelId, answerTs: '1791783205.202689',
    answerPermalink: 'https://themysc.slack.com/archives/C0C6DLPBJ00/p1791783205202689' });
  expect(records.get('settlement_agent_threads/thread').turns).toEqual([]);
});

it('does not fall back to DM when the approved preview thread post fails', async () => {
  const { db, records } = memoryDb();
  const identity = { teamId: 'T099F304GAY', channelId: 'C0C6DLPBJ00', slackUserId: 'UQA', threadTs: '1.1' };
  records.set('orgs/mysc/members/member', { email: 'qa@mysc.co.kr', role: 'finance', status: 'ACTIVE' });
  records.set('orgs/mysc/projects/a', { name: 'A사업', cic: 'CIC1', department: 'CIC1', managerId: 'manager-a', status: 'IN_PROGRESS', contractEnd: '2026-12-31' });
  records.set('orgs/mysc/persons/person-a', { uid: 'manager-a', name: '담당자' });
  records.set('settlement_agent_jobs/first', { ...identity, status: 'queued', attempts: 0, conversationId: 'thread', createdAt: new Date().toISOString(),
    question: '월결산 리마인드 미리보기 2026-10 제출 2026-10-10 23:59 승인 2026-10-13 23:59' });
  records.set('settlement_agent_threads/thread', { ...identity, queue: ['first'], turns: [] });
  const calls = [];
  const worker = runtime.createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture' }, readOverview: async (request) => statusOverview(request),
    fetchImpl: async (url, options) => {
      if (url.includes('users.info')) return Response.json({ ok: true, user: { team_id: identity.teamId, profile: { email: 'qa@mysc.co.kr' } } });
      calls.push({ method: url.split('/').at(-1), body: JSON.parse(options.body) });
      throw new TypeError('network down');
    } });
  await worker();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: 'chat.postMessage', body: { channel: identity.channelId, thread_ts: identity.threadTs } });
  expect(calls[0].body.channel).not.toBe(identity.slackUserId);
  expect(records.get('settlement_agent_jobs/first')).toMatchObject({ status: 'delivery_unknown', answerDelivery: 'public',
    deliveryFailure: { code: 'transport_error', definitive: false }, answer: '[private answer omitted]' });
});

it('rechecks ACTIVE membership immediately before an approved-channel preview is exposed', async () => {
  const { db, records } = memoryDb();
  const identity = { teamId: 'T099F304GAY', channelId: 'C0C6DLPBJ00', slackUserId: 'UQA', threadTs: '1.1' };
  records.set('orgs/mysc/members/member', { email: 'qa@mysc.co.kr', role: 'admin', status: 'ACTIVE' });
  records.set('orgs/mysc/projects/a', { name: 'A사업', cic: 'CIC1', department: 'CIC1', managerId: 'manager-a', status: 'IN_PROGRESS', contractEnd: '2026-12-31' });
  records.set('orgs/mysc/persons/person-a', { uid: 'manager-a', name: '담당자' });
  records.set('settlement_agent_jobs/first', { ...identity, status: 'queued', attempts: 0, conversationId: 'thread', createdAt: new Date().toISOString(),
    question: '월결산 리마인드 미리보기 2026-10 제출 2026-10-10 23:59 승인 2026-10-13 23:59' });
  records.set('settlement_agent_threads/thread', { ...identity, queue: ['first'], turns: [] });
  const calls = [];
  const worker = runtime.createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture' },
    readOverview: async (request) => {
      records.set('orgs/mysc/members/member', { email: 'qa@mysc.co.kr', role: 'viewer', status: 'INACTIVE' });
      return statusOverview(request);
    }, fetchImpl: async (url, options) => {
      if (url.includes('users.info')) return Response.json({ ok: true, user: { team_id: identity.teamId, profile: { email: 'qa@mysc.co.kr' } } });
      calls.push({ method: url.split('/').at(-1), body: JSON.parse(options.body) });
      return Response.json({ ok: true, message_ts: '2.1' });
    } });
  await worker();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: 'chat.postEphemeral', body: { channel: identity.channelId, user: identity.slackUserId, thread_ts: identity.threadTs } });
  expect(calls[0].body.text).toContain('활성 계정과 Slack 이메일 연결');
  expect(calls[0].body.text).not.toContain('A사업');
  expect(records.get('settlement_agent_jobs/first')).toMatchObject({ status: 'succeeded', answerDelivery: 'private', deliveryMethod: 'chat.postEphemeral',
    answer: '[private answer omitted]', historyVisibility: 'private' });
  expect(records.get('settlement_agent_jobs/first')).not.toHaveProperty('answerPermalink');
});

it('blocks Merryhere reservation and account operations in the approved READ channel before model or provider use', async () => {
  for (const question of ['회의실 계정 연결', '회의실 예약 확정 abcdefabcdefabcdefabcdef', '내일 3시 회의실 예약해줘']) {
    const { db, records } = memoryDb();
    const identity = { teamId: 'T099F304GAY', channelId: 'C0C6DLPBJ00', slackUserId: 'UQA', threadTs: '1.1' };
    records.set('orgs/mysc/members/member', { email: 'qa@mysc.co.kr', role: 'pm', status: 'ACTIVE' });
    records.set('settlement_agent_jobs/first', { ...identity, status: 'queued', attempts: 0, conversationId: 'thread', createdAt: new Date().toISOString(), question });
    records.set('settlement_agent_threads/thread', { ...identity, queue: ['first'], turns: [] });
    const completeFactory = vi.fn(); const calls = [];
    const worker = runtime.createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture' }, completeFactory,
      fetchImpl: async (url, options) => {
        if (url.includes('users.info')) return Response.json({ ok: true, user: { team_id: identity.teamId, profile: { email: 'qa@mysc.co.kr' } } });
        calls.push({ method: url.split('/').at(-1), body: JSON.parse(options.body) });
        return Response.json({ ok: true, channel: identity.channelId, ts: '2.1', message_ts: '2.1' });
      } });
    await worker();
    expect(completeFactory).not.toHaveBeenCalled();
    expect(calls.find((call) => call.method === 'chat.postMessage').body.text).toContain('READ 전용');
    expect([...records.keys()].some((key) => key.startsWith('merryhere_'))).toBe(false);
  }
});

it('renders approved-channel READ help without model use and states sensitive-data exclusions', async () => {
  const { db, records } = memoryDb();
  const identity = { teamId: 'T099F304GAY', channelId: 'C0C6DLPBJ00', slackUserId: 'UQA', threadTs: '1.1' };
  records.set('orgs/mysc/members/member', { email: 'qa@mysc.co.kr', role: 'pm', status: 'ACTIVE' });
  records.set('settlement_agent_jobs/first', { ...identity, status: 'queued', attempts: 0, conversationId: 'thread', createdAt: new Date().toISOString(), question: '도움말' });
  records.set('settlement_agent_threads/thread', { ...identity, queue: ['first'], turns: [] });
  const completeFactory = vi.fn(); const calls = [];
  const worker = runtime.createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture' }, completeFactory,
    fetchImpl: async (url, options) => {
      if (url.includes('users.info')) return Response.json({ ok: true, user: { team_id: identity.teamId, profile: { email: 'qa@mysc.co.kr' } } });
      calls.push({ method: url.split('/').at(-1), body: JSON.parse(options.body) });
      return Response.json({ ok: true, channel: identity.channelId, ts: '2.1', message_ts: '2.1' });
    } });
  await worker();
  expect(completeFactory).not.toHaveBeenCalled();
  const text = calls.find((call) => call.method === 'chat.postMessage').body.text;
  expect(text).toContain('#1_ax위원회_myscubebot');
  expect(text).toContain('개인 급여·HR');
  expect(text).toContain('쓰기·예약·승인·삭제·권한 변경');
  expect(text).not.toContain('merryhere_rooms');
});

it('offers only the explicit READ tool allowlist to the model in the approved channel', async () => {
  const { db, records } = memoryDb();
  const identity = { teamId: 'T099F304GAY', channelId: 'C0C6DLPBJ00', slackUserId: 'UQA', threadTs: '1.1' };
  records.set('orgs/mysc/members/member', { email: 'qa@mysc.co.kr', role: 'pm', status: 'ACTIVE' });
  records.set('settlement_agent_jobs/first', { ...identity, status: 'queued', attempts: 0, conversationId: 'thread', createdAt: new Date().toISOString(), question: '이번 달 회사 현황을 요약해줘' });
  records.set('settlement_agent_threads/thread', { ...identity, queue: ['first'], turns: [] });
  let names = [];
  const completeFactory = () => async ({ tools }) => {
    names = tools.map((tool) => tool.function.name);
    return { content: '조회 가능한 범위에서 정리했습니다.' };
  };
  const worker = runtime.createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture', SETTLEMENT_AGENT_GEMINI_API_KEY: 'fixture' }, completeFactory,
    readSnapshot: async () => ({}), fetchImpl: async (url, options) => {
      if (url.includes('users.info')) return Response.json({ ok: true, user: { team_id: identity.teamId, profile: { email: 'qa@mysc.co.kr' } } });
      return Response.json({ ok: true, channel: identity.channelId, ts: '2.1', message_ts: '2.1' });
    } });
  await worker();
  expect(names).toEqual(expect.arrayContaining(['cashflow_status', 'settlement_status_report', 'settlement_report', 'reformat_report',
    'accounting_read', 'accounting_report', 'accounting_compare', 'cfo_brief', 'agent_diagnostics', 'system_knowledge', 'agent_capabilities', 'project_search']));
  expect(names).not.toContain('merryhere_rooms');
  expect(names.every((name) => ['cashflow_status', 'settlement_status_report', 'settlement_report', 'reformat_report', 'accounting_read',
    'accounting_report', 'accounting_compare', 'cfo_brief', 'agent_diagnostics', 'system_knowledge', 'agent_capabilities', 'project_search',
    'clarify_request', 'observe_feedback'].includes(name))).toBe(true);
});

it.each([
  ['rejects a non-DM Slack response', async () => Response.json({ ok: true, channel: 'COTHER', ts: '2.1' }), 'failed', 'invalid_response'],
  ['keeps an ambiguous DM transport failure private', async () => { throw new TypeError('network down'); }, 'delivery_unknown', 'transport_error'],
])('%s without a public fallback', async (_label, deliver, status, code) => {
  const { db, records } = memoryDb();
  const identity = { teamId: 'T099F304GAY', channelId: 'C0BQ6980HR6', slackUserId: 'UQA', threadTs: '1.1' };
  records.set('orgs/mysc/members/member', { email: 'qa@mysc.co.kr', role: 'finance', status: 'ACTIVE' });
  records.set('orgs/mysc/projects/a', { name: 'A사업', cic: 'CIC1', department: 'CIC1', managerId: 'manager-a', status: 'IN_PROGRESS', contractEnd: '2026-12-31' });
  records.set('orgs/mysc/persons/person-a', { uid: 'manager-a', name: '담당자' });
  records.set('settlement_agent_jobs/first', { ...identity, status: 'queued', attempts: 0, conversationId: 'thread', createdAt: new Date().toISOString(),
    question: '월결산 리마인드 미리보기 2026-10 제출 2026-10-10 23:59 승인 2026-10-13 23:59' });
  records.set('settlement_agent_threads/thread', { ...identity, queue: ['first'], turns: [] });
  const calls = [];
  const worker = runtime.createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture' },
    readOverview: async (request) => statusOverview(request), fetchImpl: async (url, options) => {
      if (url.includes('users.info')) return Response.json({ ok: true, user: { team_id: identity.teamId, profile: { email: 'qa@mysc.co.kr' } } });
      calls.push({ method: url.split('/').at(-1), body: JSON.parse(options.body) });
      return deliver();
    } });
  await worker();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: 'chat.postMessage', body: { channel: identity.slackUserId } });
  expect(calls[0].body).not.toHaveProperty('thread_ts');
  expect(records.get('settlement_agent_jobs/first')).toMatchObject({ status, deliveryFailure: { code }, answer: '[private answer omitted]' });
  expect(records.get('settlement_agent_jobs/first')).not.toHaveProperty('answerChannelId');
});

it('excludes legacy unlabelled/private preview turns from a later general model context', async () => {
  const { db, records } = memoryDb();
  records.set('settlement_agent_jobs/follow-up', { status: 'queued', attempts: 0, conversationId: 'thread', teamId: 'T099F304GAY',
    channelId: 'C0BQ6980HR6', slackUserId: 'UQA', threadTs: '1.1', question: '일반 후속 질문' });
  records.set('settlement_agent_threads/thread', { teamId: 'T099F304GAY', channelId: 'C0BQ6980HR6', slackUserId: 'UQA', threadTs: '1.1',
    queue: ['follow-up'], turns: [
      { jobId: 'legacy-private', question: '월결산 리마인드 미리보기 2026-10 제출 2026-10-10 23:59 승인 2026-10-13 23:59', answer: '민감 사업명과 담당자' },
      { contextVisibility: 'private', jobId: 'private', question: 'preview', answer: '다른 민감 결과' },
      { contextVisibility: 'conversation', jobId: 'public', question: '공개 질문', answer: '공개 답변' },
    ] });
  const claimed = await runtime.claimSlackJob({ db, jobId: 'follow-up' });
  expect(claimed.turns).toEqual([{ contextVisibility: 'conversation', jobId: 'public', question: '공개 질문', answer: '공개 답변' }]);
  expect(JSON.stringify(claimed.turns)).not.toMatch(/민감|preview/);
});

it('denies the private month-close preview before any canonical read for non-admin/finance members', async () => {
  const { db, records } = memoryDb();
  const identity = { teamId: 'T099F304GAY', channelId: 'C0BQ6980HR6', slackUserId: 'UQA', threadTs: '1.1' };
  records.set('orgs/mysc/members/member', { email: 'qa@mysc.co.kr', role: 'viewer', status: 'ACTIVE' });
  records.set('settlement_agent_jobs/first', { ...identity, status: 'queued', attempts: 0, conversationId: 'thread', createdAt: new Date().toISOString(),
    question: '월결산 리마인드 미리보기 2026-10 제출 2026-10-10 23:59 승인 2026-10-13 23:59' });
  records.set('settlement_agent_threads/thread', { ...identity, queue: ['first'], turns: [] });
  const calls = []; const readOverview = vi.fn();
  const worker = runtime.createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture' }, readOverview, fetchImpl: async (url, options) => {
    if (url.includes('users.info')) return Response.json({ ok: true, user: { team_id: identity.teamId, profile: { email: 'qa@mysc.co.kr' } } });
    calls.push({ method: url.split('/').at(-1), body: JSON.parse(options.body) });
    return Response.json({ ok: true, channel: 'DQA', ts: '2.1', message_ts: '3.1' });
  } });
  await worker();
  expect(readOverview).not.toHaveBeenCalled();
  const delivery = calls.find((call) => call.method === 'chat.postMessage');
  expect(delivery.body).toMatchObject({ channel: identity.slackUserId });
  expect(delivery.body).not.toHaveProperty('thread_ts');
  expect(delivery.body.text).toContain('admin 또는 finance 역할만');
  expect(calls.filter((call) => call.method === 'chat.postMessage')).toHaveLength(1);
});

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
  data.set('settlement_agent_budgets/2026-09', { reservedKrw: 30000, attempts: 60 });
  for (let i = 60; i < 200; i++) await runtime.reserveAgentBudget(db, '2026-09');
  expect(data.get('settlement_agent_budgets/2026-09')).toMatchObject({ reservedKrw: 100000, attempts: 200 });
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

it.each(['C0AAC4AHTN1', 'C0C6DLPBJ00'])('serves allowed channel %s and replies there', async (channelId) => {
  const { db, records } = memoryDb();
  const identity = { teamId: 'T099F304GAY', channelId, slackUserId: 'UQA', threadTs: '1.1' };
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
  expect(delivery.body.channel).toBe(channelId);
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
