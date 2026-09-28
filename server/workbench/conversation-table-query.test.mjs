import { describe, expect, it, vi } from 'vitest';
import { runConversationTurn } from './conversation-agent.mjs';
const evidenceId = '22222222-2222-4222-8222-222222222222';
const plan = { kind: 'table', datasetId: 'projects_inventory_v1', aggregate: { op: 'count_rows' }, groupBy: ['cic'] };
const ctx = { datasetIds: [plan.datasetId], filters: {}, evidenceIds: [] };
const interpretation = { summary: '저장된 조직별 사업 문서 수', context: ctx, ambiguities: [] };
const tool = step => ({ tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify(step) } }] });
const catalog = { items: [{ datasetId: plan.datasetId, version: 'a'.repeat(64), tableQuery: { schemaVersion: 1 }, schema: [{ name: 'cic', type: 'string' }, { name: 'contract_end', type: 'date' }, { name: 'contract_start', type: 'date' }, { name: 'status', type: 'string' }] }] };
function fixture(step = { action: 'query_table', interpretation, plan }) {
  const result = { evidenceId, rows: [{ cic: null, row_count: '1' }] };
  const complete = vi.fn().mockResolvedValueOnce(tool(step)).mockResolvedValue(tool({ action: 'answer', interpretation, answer: '저장된 조직별 문서 수입니다. 조직 누락도 함께 표시합니다.', evidenceIds: [evidenceId] }));
  const analytics = { catalog: vi.fn(async () => catalog), queryPlan: vi.fn(async () => result) };
  return { complete, analytics, args: { context: { analyticsScope: { datasetIds: [plan.datasetId] } }, message: '사업 문서 수를 저장된 조직별로 보여줘.', complete, analytics, authorize: vi.fn(async () => {}), signal: new AbortController().signal } };
}
describe('conversation composes approved stored-table questions', () => {
  it('queries an unregistered question through the ordinary pinned evidence path without a dedicated API', async () => {
    const f = fixture();
    const result = await runConversationTurn(f.args);
    expect(result.status).toBe('answered'); expect(result.evidence[0].rows).toEqual([{ cic: null, row_count: '1' }]);
    expect(f.analytics.queryPlan).toHaveBeenCalledExactlyOnceWith(f.args.context, plan, { datasetVersions: { projects_inventory_v1: 'a'.repeat(64) }, signal: f.args.signal });
    expect(f.complete.mock.calls[0][0].messages[0].content).toContain('승인된 원문 표 조회 계약');
  });
  it('rejects an unrelated stated date range instead of silently ignoring it', async () => {
    const f = fixture({ action: 'query_table', plan, interpretation: { ...interpretation, context: { ...ctx, period: { start: '2026-09-01', end: '2026-09-30', label: '계약 종료일', basis: 'explicit_request' } } } });
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_plan_context_mismatch' });
    expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('allows an exact date-field range and keeps table queries separate from finance-week semantics', async () => {
    const query = { ...plan, filters: [{ field: 'contract_end', op: 'gte', value: '2026-09-01' }, { field: 'contract_end', op: 'lte', value: '2026-09-30' }] };
    const f = fixture({ action: 'query_table', plan: query, interpretation: { ...interpretation, context: { ...ctx, period: { start: '2026-09-01', end: '2026-09-30', label: '계약 종료일', basis: 'explicit_request' } } } });
    await expect(runConversationTurn(f.args)).resolves.toMatchObject({ status: 'answered' });
    expect(f.analytics.queryPlan.mock.calls[0][1]).toEqual(query);
  });
  it.each([
    [{ field: 'status', op: 'eq', value: '2026-09-01' }],
    [{ field: 'contract_start', op: 'gte', value: '2026-09-01' }, { field: 'contract_end', op: 'lte', value: '2026-09-01' }],
  ].map(filters => [filters]))('rejects nondate fields and mixed date columns as period evidence: %j', async filters => {
    const f = fixture({ action: 'query_table', plan: { ...plan, filters }, interpretation: { ...interpretation, context: { ...ctx, period: { start: '2026-09-01', end: '2026-09-01', label: '날짜 조건', basis: 'explicit_request' } } } });
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_plan_context_mismatch' });
    expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('accepts an exact single date on an approved date column', async () => {
    const f = fixture({ action: 'query_table', plan: { ...plan, filters: [{ field: 'contract_end', op: 'eq', value: '2026-09-01' }] }, interpretation: { ...interpretation, context: { ...ctx, period: { start: '2026-09-01', end: '2026-09-01', label: '계약 종료일', basis: 'explicit_request' } } } });
    await expect(runConversationTurn(f.args)).resolves.toMatchObject({ status: 'answered' });
  });
  it('keeps an ambiguous question pending without a data query', async () => {
    const f = fixture({ action: 'clarify', interpretation: { ...interpretation, ambiguities: [{ field: 'date_basis', reason: '어떤 업무 날짜인지 불명확합니다.', question: '계약 시작일과 종료일 중 어느 날짜 기준인가요?', options: [] }] } });
    await expect(runConversationTurn(f.args)).resolves.toMatchObject({ status: 'clarification_required' });
    expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('rejects changed authorization after the tool result and never answers with revoked rows', async () => {
    const f = fixture(); let count = 0;
    f.args.authorize = vi.fn(async () => { if (++count === 6) throw Object.assign(new Error('revoked'), { code: 'workbench_scope_changed' }); });
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'workbench_scope_changed' });
    expect(f.complete).toHaveBeenCalledTimes(1);
  });
});
