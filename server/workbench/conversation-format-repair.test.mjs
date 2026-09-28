import { describe, expect, it, vi } from 'vitest';
import { runConversationTurn } from './conversation-agent.mjs';

const context = { datasetIds: ['weekly_submission'], filters: {}, evidenceIds: [] };
const interpretation = { summary: '요청한 제출 상태 확인', context, ambiguities: [] };
const plan = { datasetId: 'weekly_submission', definitionVersion: '1', select: ['project_id'], time: { yearMonth: '2026-09', weekScope: 'all' } };
const answer = { action: 'answer', interpretation, answer: '확인할 수 있는 자료의 범위를 안내합니다.', evidenceIds: [] };
const query = { action: 'query', interpretation, plan };
const response = (step) => ({ tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify(step) } }] });
function fixture(responses) {
  const snapshots = [];
  const complete = vi.fn(async (request) => {
    snapshots.push(structuredClone({ messages: request.messages, tools: request.tools }));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const analytics = { catalog: vi.fn(async () => ({ semantic: { items: [] } })),
    queryPlan: vi.fn(async () => ({ evidenceId: 'verified-evidence', rows: [{ project_id: 'verified-project' }], columns: ['project_id'] })) };
  const authorize = vi.fn(async () => {});
  const args = { context: { analyticsScope: { datasetIds: ['weekly_submission'] } }, workContext: context, message: '자료를 확인해 주세요.',
    history: [{ role: 'user', content: '앞선 요청' }], complete, analytics, authorize, signal: new AbortController().signal,
    now: () => '2026-09-24T00:00:00Z' };
  return { args, complete, analytics, authorize, snapshots };
}

describe('bounded conversation format repair without changing domain validation', () => {
  it.each([
    { tool_calls: [{ function: { name: 'workbench_step', arguments: '{' } }] },
    response({ ...answer, action: 'respond' }),
    response({ action: 'answer', interpretation, evidenceIds: [] }),
    Object.assign(new Error('provider returned text'), { code: 'html_model_action_invalid' }),
  ])('requests one corrected response for invalid formatting: %j', async (invalid) => {
    const f = fixture([invalid, response(answer)]);
    await expect(runConversationTurn(f.args)).resolves.toMatchObject({ status: 'answered', answer: answer.answer });
    expect(f.complete).toHaveBeenCalledTimes(2);
    expect(f.analytics.queryPlan).not.toHaveBeenCalled();
    expect(f.snapshots[1].tools).toEqual(f.snapshots[0].tools);
    expect(f.snapshots[1].messages).toContainEqual({ role: 'user', content: '앞선 요청' });
    expect(f.snapshots[1].messages.at(-1).content).toContain('한 번만');
    expect(f.snapshots[1].messages.at(-1).content).not.toContain('provider returned text');
  });
  it('does not coerce an action alias or keep retrying a second invalid response', async () => {
    const invalid = response({ ...query, action: 'query.plan' });
    const f = fixture([invalid, invalid, response(query)]);
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_plan_invalid' });
    expect(f.complete).toHaveBeenCalledTimes(2);
    expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('retains executed query evidence and does not replay the query to repair an answer', async () => {
    const validAnswer = { ...answer, evidenceIds: ['verified-evidence'] };
    const f = fixture([response(query), response({ ...validAnswer, action: 'respond' }), response(validAnswer)]);
    const result = await runConversationTurn(f.args);
    expect(result).toMatchObject({ status: 'answered', evidence: [{ evidenceId: 'verified-evidence' }] });
    expect(f.analytics.queryPlan).toHaveBeenCalledTimes(1);
    expect(f.snapshots[2].messages.some(({ content }) => content.includes('verified-project'))).toBe(true);
    expect(f.snapshots[2].tools).toEqual(f.snapshots[0].tools);
  });
  it.each(['html_model_request_rejected', 'html_model_unavailable'])('does not retry provider/transport errors: %s', async (code) => {
    const failure = Object.assign(new Error('provider failed'), { code });
    const f = fixture([failure, response(answer)]);
    await expect(runConversationTurn(f.args)).rejects.toBe(failure);
    expect(f.complete).toHaveBeenCalledTimes(1);
  });
  it('keeps semantic and permission failures outside format repair', async () => {
    const f = fixture([response(query), response(answer)]);
    const failure = Object.assign(new Error('unknown filter'), { code: 'semantic_filter_not_allowed' });
    f.analytics.queryPlan.mockRejectedValueOnce(failure);
    await expect(runConversationTurn(f.args)).rejects.toBe(failure);
    expect(f.complete).toHaveBeenCalledTimes(1);
    const forbidden = fixture([response({ ...query, interpretation: { ...interpretation, context: { ...context, datasetIds: ['private'] } } }), response(answer)]);
    await expect(runConversationTurn(forbidden.args)).rejects.toMatchObject({ code: 'conversation_dataset_forbidden' });
    expect(forbidden.complete).toHaveBeenCalledTimes(1);
    expect(forbidden.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('checks authorization before a format retry can execute', async () => {
    const f = fixture([response({ ...answer, action: 'respond' }), response(answer)]);
    let checks = 0;
    f.authorize.mockImplementation(async () => { if (++checks === 5) throw Object.assign(new Error('revoked'), { statusCode: 403 }); });
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.complete).toHaveBeenCalledTimes(1);
  });
  it('uses the existing deadline while waiting for the corrected response', async () => {
    const f = fixture([response({ ...answer, action: 'respond' })]);
    const controller = new AbortController();
    f.args.signal = controller.signal;
    f.complete.mockImplementationOnce(async () => response({ ...answer, action: 'respond' })).mockImplementationOnce(async () => {
      controller.abort();
      return new Promise(() => {});
    });
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_deadline' });
    expect(f.complete).toHaveBeenCalledTimes(2);
    expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('passes the original edit request to the React author without static HTML runtime instructions', async () => {
    const f = fixture([response({ action: 'build_screen', interpretation, purpose: 'layout_only',
      request: '제목과 간격을 바꿔 주세요.', evidenceIds: [], bindings: [] })]);
    const message = '제목을 작업 현황으로 바꾸고 카운터 동작과 다른 파일을 유지해 주세요.';
    const screenBuilder = vi.fn(async () => ({ status: 'source', source: { title: '작업 현황' } }));
    await runConversationTurn({ ...f.args, message, screenBuilder });
    expect(screenBuilder.mock.calls[0][0]).toMatchObject({ request: '제목과 간격을 바꿔 주세요.', businessContext: { originalRequest: message, clarificationReply: null } });
    const system = f.snapshots[0].messages[0].content;
    expect(system).toContain('React+Tailwind workspace');
    expect(system).not.toContain('자체 작성 예제 A');
    expect(system).not.toContain('event handler/form은 금지');
    expect(f.snapshots[0].tools[0].function.parameters.oneOf.map(branch => branch.properties.action.const)).toContain('build_screen');
    expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('retains the pending original request and its clarification for the author', async () => {
    const f = fixture([response({ action: 'build_screen', interpretation, purpose: 'layout_only', request: '선택한 제목으로 변경', evidenceIds: [], bindings: [] })]);
    const screenBuilder = vi.fn(async () => ({ status: 'source' }));
    await runConversationTurn({ ...f.args, message: '작업 현황으로 해줘', pendingClarification: { originalMessage: '제목만 변경하고 나머지 동작은 유지해줘' }, screenBuilder });
    expect(screenBuilder.mock.calls[0][0].businessContext).toMatchObject({ originalRequest: '제목만 변경하고 나머지 동작은 유지해줘', clarificationReply: '작업 현황으로 해줘' });
  });
});
