import { createHmac } from 'node:crypto';
import { it, expect, vi } from 'vitest';
import { createFeedbackIngress, slackText, selectSlackHarness, feedbackScopeKey } from './slack-runtime.mjs';

it('keeps baseline by default and routes explicit Hermes threads without semantic guessing', () => {
  expect(selectSlackHarness('헤르메스가 뭐야?')).toEqual({ variant: 'baseline', question: '헤르메스가 뭐야?' });
  expect(selectSlackHarness('[Hermes] 월결산 조회')).toEqual({ variant: 'hermes', question: '월결산 조회' });
  expect(selectSlackHarness('두 줄로', [{ question: '[Hermes] 월결산' }]).variant).toBe('hermes');
  expect(selectSlackHarness('[Baseline] 같은 질문', [{ question: '[Hermes] 월결산' }])).toEqual({ variant: 'baseline', question: '같은 질문' });
  let turns = [{ question: '[Hermes] 월결산', experimentVariant: 'hermes' }];
  for (let i = 0; i < 10; i++) {
    const selected = selectSlackHarness('다시 요약해줘', turns);
    expect(selected.variant).toBe('hermes');
    turns = [...turns, { question: selected.question, experimentVariant: selected.variant }].slice(-6);
  }
  const identity = { teamId: 'T1', slackUserId: 'U1' };
  const scope = { question: '월결산', tool: 'settlement_report', input: {} };
  expect(feedbackScopeKey(identity, { ...scope, experimentVariant: 'hermes' })).not.toBe(feedbackScopeKey(identity, { ...scope, experimentVariant: 'baseline' }));
});

it('formats the reported CIC answer for Slack without changing facts or activating mentions', () => {
  const input = '2026년 8월 기준 **CIC2**(총 4건)입니다.\n\n---\n\n### :bar_chart: 월결산 현황\n\n* **CIC2**: **4건** (미신청 4건)\n* **DXR팀**: **3건**\n\n### :bulb: 안내\n* **조회 범위**: 64개 사업, 미완료 24건\n<!channel> <@UOTHER>';
  const result = slackText(input);
  expect(result).toBe('2026년 8월 기준 *CIC2*(총 4건)입니다.\n\n:bar_chart: 월결산 현황\n\n• *CIC2*: *4건* (미신청 4건)\n• *DXR팀*: *3건*\n\n:bulb: 안내\n• *조회 범위*: 64개 사업, 미완료 24건\n&lt;!channel&gt; &lt;@UOTHER&gt;');
  expect(slackText('📌 *이미 Slack 강조*\n`**원문**`\n```\n### 원문\n---\n```\n잔액 -3,686,331원')).toBe('📌 *이미 Slack 강조*\n`**원문**`\n```\n### 원문\n---\n```\n잔액 -3,686,331원');
  expect(slackText('### **CIC2** 월결산 현황\n### C#\n### 월결산 `CIC2` 안내\n  - 하위 사업\n```\n### 원문\n---\n**원문**')).toBe('*CIC2* 월결산 현황\nC#\n월결산 `CIC2` 안내\n  • 하위 사업\n```\n### 원문\n---\n**원문**');
});

it.each(['yes', 'no'])('replaces buttons with persisted %s feedback without hiding the public answer', async (choice) => {
  const documents = new Map([['settlement_agent_jobs/job1', {
    status: 'succeeded', slackUserId: 'U1', teamId: 'T1', channelId: 'C1', answerTs: '1.2',
    answer: '📌 **월결산: 확정** <!channel> <@UOTHER>', scopes: [{ key: 'scope1' }],
  }]]);
  const db = { doc: (path) => ({ path, get: async () => ({ data: () => documents.get(path) }) }),
    runTransaction: async (fn) => fn({ get: async (ref) => ({ data: () => documents.get(ref.path) }),
      set: (ref, value) => documents.set(ref.path, value) }),
  };
  const fetchImpl = vi.fn(async (url, options) => {
    expect(documents.get('settlement_agent_jobs/job1/feedback/U1').value).toBe(choice === 'yes' ? 1 : 0);
    expect(url).toBe('https://hooks.slack.com/actions/T1/test');
    const body = JSON.parse(options.body);
    expect(body.replace_original).toBe(true);
    expect(body.response_type).toBeUndefined();
    expect(body.blocks.some((block) => block.type === 'actions')).toBe(false);
    expect(body.text).toContain('월결산: 확정');
    expect(body.text).not.toContain('<!channel>');
    expect(body.blocks[0].text).toEqual({ type: 'mrkdwn', text: '📌 *월결산: 확정* &lt;!channel&gt; &lt;@UOTHER&gt;', verbatim: true });
    expect(body.text).toContain(choice === 'yes' ? '감사합니다' : '스레드');
    expect(options.redirect).toBe('error');
    return new Response('ok');
  });
  const handler = createFeedbackIngress({ db, secret: 'fixture', teamId: 'T1', channelId: 'C1', fetchImpl });
  const payload = { team: { id: 'T1' }, user: { id: 'U1' }, channel: { id: 'C1' }, container: { message_ts: '1.2' },
    response_url: 'https://hooks.slack.com/actions/T1/test', actions: [{ action_id: `settlement_scope_${choice}`, value: 'job1', action_ts: '2.1' }] };
  const send = async () => {
    const body = Buffer.from(new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac('sha256', 'fixture').update(`v0:${timestamp}:`).update(body).digest('hex')}`;
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ body, get: (name) => name.endsWith('timestamp') ? timestamp : signature }, res);
    return res;
  };
  expect((await send()).code).toBe(200);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  payload.user.id = 'UOTHER';
  expect((await send()).code).toBe(403);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  payload.user.id = 'U1';
  payload.response_url = 'https://example.com/actions/T1/test';
  expect((await send()).code).toBe(503);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  payload.response_url = 'https://hooks.slack.com/actions/T1/test';
  fetchImpl.mockRejectedValueOnce(new Error('timeout'));
  expect((await send()).code).toBe(503);
  expect(documents.has('settlement_agent_jobs/job1/feedback/U1')).toBe(true);
});
