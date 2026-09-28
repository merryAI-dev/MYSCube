import { describe, expect, it, vi } from 'vitest';
import { runConversationTurn } from './conversation-agent.mjs';
import { attachCompletionContent, getNativeMessageContent } from './model-turn-history.mjs';
import { compileTableQuery } from './table-query.mjs';

const datasetId = 'synthetic_records', version = 'a'.repeat(64), evidenceId = '11111111-1111-4111-8111-111111111111';
const context = { datasetIds: [datasetId], filters: { cic: 'CIC4' }, evidenceIds: [], period: { start: '2026-09-01', end: '2026-09-30', label: '종료일 기준 9월', basis: 'explicit_request' } };
const interpretation = { summary: '요청한 날짜와 조직의 사본 문서 수', context, ambiguities: [] };
const plan = { kind: 'table', datasetId, aggregate: { op: 'count_rows' }, filters: [
  { field: 'contract_end', op: 'gte', value: context.period.start }, { field: 'contract_end', op: 'lte', value: context.period.end }, { field: 'cic', op: 'eq', value: 'CIC4' },
] };
const query = { action: 'query_table', interpretation, plan };
const invalid = { ...query, plan: { ...plan, filters: plan.filters.filter(filter => filter.op !== 'lte') } };
const answer = { action: 'answer', interpretation, answer: '확인한 사본의 근거를 표시합니다.', evidenceIds: [evidenceId] };
const response = step => ({ tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify(step) } }] });
function fixture(steps) {
  const catalog = { items: [{ datasetId, version, tableQuery: { schemaVersion: 1 }, schema: [{ name: 'contract_end', type: 'date' }, { name: 'cic', type: 'string' }] }] };
  const snapshots = [], remaining = [...steps];
  const complete = vi.fn(async request => {
    snapshots.push({ messages: structuredClone(request.messages), native: request.messages.map(getNativeMessageContent), tools: structuredClone(request.tools) });
    const next = remaining.shift();
    if (!next) throw new Error('Unexpected additional completion');
    return next;
  });
  const evidence = { evidenceId, rows: [{ row_count: '2' }], columns: [{ name: 'row_count', type: 'integer' }] };
  const compiled = [];
  const analytics = { catalog: vi.fn(async () => catalog), queryPlan: vi.fn(async (_context, actualPlan) => {
    compiled.push(compileTableQuery({ plan: actualPlan, catalogItems: catalog.items })); return evidence;
  }), evidence: vi.fn(async () => evidence) };
  const authorize = vi.fn(async () => {});
  return { snapshots, complete, analytics, authorize, compiled, evidence,
    args: { context: { analyticsScope: { datasetIds: [datasetId] } }, message: '종료일이 2026년 9월인 CIC4의 문서 수를 보여 주세요.',
      workContext: structuredClone(context), complete, analytics, authorize, signal: new AbortController().signal, now: () => '2026-09-28T00:00:00Z' } };
}

describe('one pre-query context correction within existing conversation limits', () => {
  it('executes only the corrected plan with the same requested filters and source pin', async () => {
    const f = fixture([response(invalid), response(query), response(answer)]);
    await expect(runConversationTurn(f.args)).resolves.toMatchObject({ status: 'answered', evidence: [f.evidence] });
    expect(f.complete).toHaveBeenCalledTimes(3);
    expect(f.analytics.queryPlan).toHaveBeenCalledExactlyOnceWith(f.args.context, plan, { datasetVersions: { [datasetId]: version }, signal: f.args.signal });
    expect(f.compiled).toHaveLength(1); expect(f.compiled[0].sql).toContain('"contract_end" <= DATE \'2026-09-30\''); expect(f.compiled[0].sql).toContain('"cic" = \'CIC4\'');
    expect(f.snapshots[1].tools).toEqual(f.snapshots[0].tools);
    expect(f.snapshots[1].messages.at(-2).content).toContain('"executed":false');
    expect(f.snapshots[1].messages.at(-1).content).toContain('조건을 삭제하거나 조회 범위를 넓히거나 다른 조건으로 바꾸지 마세요');
    expect(f.snapshots[1].messages).toContainEqual({ role: 'user', content: f.args.message });
  });
  it('propagates the second mismatch without executing either plan or performing another completion', async () => {
    const f = fixture([response(invalid), response(invalid), response(query)]);
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ statusCode: 400, code: 'conversation_plan_context_mismatch' });
    expect(f.complete).toHaveBeenCalledTimes(2); expect(f.analytics.queryPlan).not.toHaveBeenCalled(); expect(f.compiled).toEqual([]);
  });
  it('keeps prior successful evidence usable instead of replaying its query', async () => {
    const f = fixture([response(query), response(invalid), response(answer)]);
    const result = await runConversationTurn(f.args);
    expect(result).toMatchObject({ status: 'answered', evidence: [f.evidence] }); expect(f.analytics.queryPlan).toHaveBeenCalledTimes(1);
    expect(f.snapshots[2].messages.some(message => message.content.includes('"row_count":"2"'))).toBe(true);
    expect(f.analytics.evidence).not.toHaveBeenCalled();
  });
  it('can use authorized evidence from the persisted prior context after an unexecuted mismatch', async () => {
    const f = fixture([response(invalid), response(answer)]); f.args.workContext.evidenceIds = [evidenceId];
    await expect(runConversationTurn(f.args)).resolves.toMatchObject({ status: 'answered', evidence: [f.evidence] });
    expect(f.analytics.queryPlan).not.toHaveBeenCalled(); expect(f.analytics.evidence).toHaveBeenCalledExactlyOnceWith(f.args.context, evidenceId);
  });
  it('allows clarification without changing the previous context or executing an invalid plan', async () => {
    const ambiguity = { field: 'date_basis', reason: '날짜 기준을 확인해야 합니다.', question: '어느 날짜 기준인가요?', options: [] };
    const f = fixture([response(invalid), response({ action: 'clarify', interpretation: { ...interpretation, ambiguities: [ambiguity] } })]);
    await expect(runConversationTurn(f.args)).resolves.toMatchObject({ status: 'clarification_required', context: f.args.workContext, answer: ambiguity.question });
    expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('preserves the native failed function call and returns its own validation result with the exact provider ID', async () => {
    const content = { role: 'model', parts: [{ text: 'private native context', thought: true, thoughtSignature: 'opaque-signature' },
      { functionCall: { id: 'native-query-call', name: 'workbench_step', args: invalid }, thoughtSignature: 'opaque-call-signature' }] };
    const failed = attachCompletionContent(response(invalid), content);
    const f = fixture([failed, response(query), response(answer)]); await runConversationTurn(f.args);
    const second = f.snapshots[1], native = second.native.filter(Boolean);
    expect(native[0]).toEqual(content);
    expect(native[1]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'workbench_step', id: 'native-query-call', response: { result: {
      status: 'validation_failed', code: 'conversation_plan_context_mismatch', message: '설명한 날짜 범위와 실제 표 조회 조건이 다릅니다. 날짜 항목과 범위를 확인해 주세요.', executed: false,
    } } } }] });
    expect(JSON.stringify(second.messages)).not.toContain('opaque'); expect(JSON.stringify(second.messages)).not.toContain('native-query-call');
    expect(f.analytics.queryPlan).toHaveBeenCalledTimes(1);
  });
  it.each([
    { code: 'workbench_scope_changed', statusCode: 403 }, { code: 3, statusCode: 503 },
    { code: 'table_filter_operator_invalid', statusCode: 422 }, { code: 'conversation_plan_context_mismatch', statusCode: 400 },
  ])('does not retry failures from the actual analytics operation: %j', async failure => {
    const f = fixture([response(query), response(query)]), error = Object.assign(new Error('Original operation error'), failure);
    f.analytics.queryPlan.mockRejectedValueOnce(error);
    await expect(runConversationTurn(f.args)).rejects.toBe(error);
    expect(f.complete).toHaveBeenCalledTimes(1); expect(f.analytics.queryPlan).toHaveBeenCalledTimes(1);
  });
  it('does not repair an unauthorized dataset or malformed context date', async () => {
    for (const invalidContext of [{ ...context, datasetIds: ['private_dataset'] }, { ...context, period: { ...context.period, start: '2026-02-30' } }]) {
      const f = fixture([response({ ...query, interpretation: { ...interpretation, context: invalidContext } }), response(query)]);
      await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: invalidContext.datasetIds[0] === 'private_dataset' ? 'conversation_dataset_forbidden' : 'conversation_period_invalid' });
      expect(f.complete).toHaveBeenCalledTimes(1); expect(f.analytics.queryPlan).not.toHaveBeenCalled();
    }
  });
  it('checks authorization again before the corrective completion and never retries the revocation', async () => {
    const f = fixture([response(invalid), response(query)]); let checks = 0;
    const denied = Object.assign(new Error('revoked'), { statusCode: 403, code: 'workbench_scope_changed' });
    f.authorize.mockImplementation(async () => { if (++checks === 5) throw denied; });
    await expect(runConversationTurn(f.args)).rejects.toBe(denied);
    expect(f.complete).toHaveBeenCalledTimes(1); expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('keeps the three-attempt query budget including the invalid attempt', async () => {
    const f = fixture([response(invalid), response(query), response(query), response(query)]);
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_query_limit' });
    expect(f.complete).toHaveBeenCalledTimes(4); expect(f.analytics.queryPlan).toHaveBeenCalledTimes(2);
  });
  it('uses the original signal when the corrective provider ignores cancellation', async () => {
    const f = fixture([response(invalid)]), controller = new AbortController(); f.args.signal = controller.signal;
    f.complete.mockImplementationOnce(async () => response(invalid)).mockImplementationOnce(async ({ signal }) => {
      expect(signal).toBe(controller.signal); controller.abort(); return new Promise(() => {});
    });
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_deadline' });
    expect(f.complete).toHaveBeenCalledTimes(2); expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
});
