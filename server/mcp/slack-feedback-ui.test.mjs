import { createHmac } from 'node:crypto';
import { it, expect, vi } from 'vitest';
import { createFeedbackIngress } from './slack-runtime.mjs';

it.each(['yes', 'no'])('replaces buttons with persisted %s feedback without hiding the public answer', async (choice) => {
  const documents = new Map([['settlement_agent_jobs/job1', {
    status: 'succeeded', slackUserId: 'U1', teamId: 'T1', channelId: 'C1', answerTs: '1.2',
    answer: '📌 *월결산: 확정* <!channel> <@UOTHER>', scopes: [{ key: 'scope1' }],
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
