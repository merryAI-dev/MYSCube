import { describe, expect, it, vi } from 'vitest';
import { runConversationTurn } from './conversation-agent.mjs';

const apiId = '11111111-1111-4111-8111-111111111111';
const evidenceId = '22222222-2222-4222-8222-222222222222';
const selected = { datasetIds: ['weekly_submission'], filters: {}, evidenceIds: [], period: { start: '2026-09-01', end: '2026-09-30', label: '9월', basis: 'explicit_request' } };
const interpretation = { summary: '선택한 API 조건으로 조회', context: selected, ambiguities: [] };
const plan = { datasetId: 'weekly_submission', definitionVersion: '1', select: ['project_id', 'status'], filters: [{ field: 'status', op: 'eq', value: 'PENDING_APPROVAL' }], time: { yearMonth: '2026-09', weekScope: 'all' } };
const api = { id: apiId, version: 2, kind: 'analytics-copy', enabled: true, parameters: { month: { type: 'string', required: true, label: '조회 월' } }, plan: { ...plan, time: { ...plan.time, yearMonth: { $input: 'month' } } } };
const query = { action: 'query_api', interpretation, apiId, apiVersion: 2, input: { month: '2026-09' } };
const result = { evidenceId, rows: [{ project_id: 'verified', status: 'PENDING_APPROVAL' }] };
const tool = (step) => ({ tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify(step) } }] });
function fixture(step = query, apis = [api]) {
  const complete = vi.fn().mockResolvedValueOnce(tool(step)).mockResolvedValue(tool({ action: 'answer', interpretation, answer: '조회 결과입니다.', evidenceIds: [evidenceId] }));
  const analytics = { catalog: vi.fn(async () => ({ items: [{ datasetId: 'weekly_submission', version: 'a'.repeat(64) }] })), queryPlan: vi.fn(async () => result) };
  return { complete, analytics, args: { context: { analyticsScope: { datasetIds: ['weekly_submission'] } }, message: '선택한 API 조건으로 조회해 주세요.',
    complete, analytics, registeredApis: apis, screenBuilder: vi.fn(), authorize: vi.fn(async () => {}), signal: new AbortController().signal } };
}

describe('registered API query uses server-owned plans', () => {
  it('resolves the exact selected version and inputs before using the ordinary evidence query path', async () => {
    const f = fixture();
    await expect(runConversationTurn(f.args)).resolves.toMatchObject({ status: 'answered', evidence: [result] });
    expect(f.analytics.queryPlan).toHaveBeenCalledExactlyOnceWith(f.args.context, plan, { datasetVersions: { weekly_submission: 'a'.repeat(64) }, signal: f.args.signal });
    expect(api.plan.time.yearMonth).toEqual({ $input: 'month' });
  });
  it.each([
    { ...query, apiVersion: 1 }, { ...query, apiId: evidenceId },
  ])('never resolves unselected API identities: %j', async (step) => {
    const f = fixture(step);
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'react_screen_binding_mismatch' });
    expect(f.complete).toHaveBeenCalledTimes(1); expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it.each([{ ...api, kind: 'external-read' }, { ...api, enabled: false }])('rejects unsupported or disabled definitions before any query', async (definition) => {
    const f = fixture(query, [definition]);
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'react_screen_binding_mismatch' });
    expect(f.complete).toHaveBeenCalledTimes(1); expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it.each([{ month: 2026 }, { month: '2026-09', extra: 'not registered' }, {}])('validates required declared parameter values without guessing: %j', async (input) => {
    const f = fixture({ ...query, input });
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'registered_api_input_invalid' });
    expect(f.complete).toHaveBeenCalledTimes(1); expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it.each(['plan', 'sql', 'columns'])('rejects a model-provided %s override instead of merging it into the definition', async (field) => {
    const step = { ...query, [field]: field === 'plan' ? plan : 'override' }, f = fixture(step);
    f.complete.mockResolvedValue(tool(step));
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_plan_invalid' });
    expect(f.complete).toHaveBeenCalledTimes(2); expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('keeps dataset and stated period checks for server-resolved plans', async () => {
    for (const definition of [{ ...api, plan: { ...api.plan, datasetId: 'private' } }, { ...api, plan: { ...api.plan, time: { yearMonth: '2026-10', weekScope: 'all' } } }]) {
      const f = fixture(query, [definition]);
      await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_plan_context_mismatch' });
      expect(f.analytics.queryPlan).not.toHaveBeenCalled();
    }
  });
});
