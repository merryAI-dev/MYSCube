import { describe, expect, it, vi } from 'vitest';
import { runConversationTurn, seoulCalendar } from './conversation-agent.mjs';

const prior = { period: { start: '2026-09-01', end: '2026-09-30', label: '2026년 9월', basis: 'explicit_request' }, datasetIds: ['cashflow'], filters: { cic: 'CIC4' }, evidenceIds: ['old-evidence'] };
const interpretation = (context = prior, ambiguities = []) => ({ summary: '요청 해석', context, ambiguities });
const response = (step) => ({ tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify(step) } }] });
function fixture(steps) {
  const complete = vi.fn();
  for (const step of steps) complete.mockResolvedValueOnce(response(step));
  const analytics = { catalog: vi.fn().mockResolvedValue({ datasets: [{ id: 'cashflow' }] }), queryPlan: vi.fn().mockResolvedValue({ evidenceId: 'new-evidence', rows: [], columns: [] }), evidence: vi.fn().mockResolvedValue({ evidenceId: 'old-evidence', rows: [], columns: [] }) };
  const authorize = vi.fn().mockResolvedValue(undefined);
  const qa = vi.fn(); const bindHtml = vi.fn();
  const args = { context: { actorId: 'a', tenantId: 't', analyticsScope: { datasetIds: ['cashflow'] } }, message: 'CIC2는?', workContext: structuredClone(prior),
    history: [], complete, analytics, authorize, qa, bindHtml, signal: new AbortController().signal, now: () => '2026-09-30T15:00:00.000Z' };
  return { args, complete, analytics, authorize, qa, bindHtml };
}
const plan = (overrides = {}) => ({ datasetId: 'cashflow', definitionVersion: '1', select: ['project_id'], time: { yearMonth: '2026-09', weekScope: 'all' }, ...overrides });
const ambiguity = { field: 'year', reason: '자료에 여러 연도가 있습니다.', question: '어느 연도 9월인가요?', options: [{ id: '2025', label: '2025년' }, { id: '2026', label: '2026년' }] };

describe('independent conversation agent QA (synthetic completion, no real model)', () => {
  it.each([
    { action: 'query', plan: plan() },
    { action: 'investigate', input: { question: '오류', area: 'approval' } },
    { action: 'answer', answer: '추정 답변', evidenceIds: [] },
    { action: 'render', answer: '변경', title: '화면', html: '<html></html>', bindings: [] },
  ])('clarifies $action with ambiguity without running business tools or replacing prior context', async (action) => {
    const f = fixture([{ ...action, interpretation: interpretation({ ...prior, filters: { cic: 'CIC2' } }, [ambiguity]) }]);
    const result = await runConversationTurn(f.args);
    expect(result).toMatchObject({ status: 'clarification_required', context: prior, answer: ambiguity.question });
    expect(result).not.toHaveProperty('proposal');
    expect(f.analytics.queryPlan).not.toHaveBeenCalled(); expect(f.qa).not.toHaveBeenCalled(); expect(f.bindHtml).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('confidence');
  });

  it('supplies existing period and server Korean calendar while a clear followup changes only CIC', async () => {
    const next = { ...prior, period: { ...prior.period, basis: 'conversation' }, filters: { cic: 'CIC2' } };
    const f = fixture([{ action: 'query', plan: plan({ filters: [{ field: 'cic', op: 'eq', value: 'CIC2' }] }), interpretation: interpretation(next) },
      { action: 'answer', answer: '조회한 근거입니다.', evidenceIds: ['new-evidence'], interpretation: interpretation(next) }]);
    const result = await runConversationTurn(f.args);
    expect(result).toMatchObject({ status: 'answered', context: { period: next.period, filters: { cic: 'CIC2' }, evidenceIds: ['new-evidence'] } });
    const system = f.complete.mock.calls[0][0].messages[0].content;
    expect(system).toContain('2026-09-01'); expect(system).toContain('2026-10-01'); expect(system).toContain('Asia/Seoul');
    expect(f.analytics.queryPlan).toHaveBeenCalledTimes(1);
  });

  it('resolves Korean month/year boundaries and leap days from the supplied clock', () => {
    expect(seoulCalendar('2026-12-31T15:00:00Z')).toMatchObject({ today: '2027-01-01', thisMonth: { start: '2027-01-01', end: '2027-01-31' }, previousMonth: { start: '2026-12-01', end: '2026-12-31' } });
    expect(seoulCalendar('2024-02-01T00:00:00Z').thisMonth.end).toBe('2024-02-29');
    expect(() => seoulCalendar('not-a-date')).toThrow();
  });

  it.each([
    { start: '2026-02-30', end: '2026-03-01' }, { start: '2026-09-30', end: '2026-09-01' }, { start: '2026-13-01', end: '2026-13-31' },
  ])('rejects malformed or reversed period $start before SQL execution', async (dates) => {
    const f = fixture([{ action: 'query', plan: plan(), interpretation: interpretation({ ...prior, period: { ...prior.period, ...dates } }) }]);
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_period_invalid' });
    expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });

  it('rejects invented evidence and does not load it by ID', async () => {
    const f = fixture([{ action: 'answer', interpretation: interpretation(), answer: '확인 완료', evidenceIds: ['foreign-evidence'] }]);
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_evidence_invalid' });
    expect(f.analytics.evidence).not.toHaveBeenCalled();
  });

  it('rejects a dataset outside the server scope before any SQL runs', async () => {
    const f = fixture([{ action: 'query', interpretation: interpretation({ ...prior, datasetIds: ['private_dataset'] }), plan: plan({ datasetId: 'private_dataset' }) }]);
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_dataset_forbidden' });
    expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });

  it('stops after permission revocation during model completion', async () => {
    const f = fixture([]);
    f.complete.mockImplementation(async () => { f.authorize.mockRejectedValue(Object.assign(new Error('revoked'), { statusCode: 403 })); return response({ action: 'query', interpretation: interpretation(), plan: plan() }); });
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });

  it('rejects a model confidence field instead of using an unverified threshold', async () => {
    const f = fixture([{ action: 'query', confidence: .99, interpretation: interpretation(), plan: plan() }]);
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_plan_invalid' });
    expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });

  it.each([
    { datasetId: 'different_dataset' },
    { time: { yearMonth: '2025-09', weekScope: 'all' } },
  ])('rejects a plan that differs from its claimed context: %j', async (overrides) => {
    const f = fixture([{ action: 'query', plan: plan(overrides), interpretation: interpretation() }]);
    f.args.context.analyticsScope.datasetIds.push('different_dataset');
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_plan_context_mismatch' });
    expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });

  it('rejects raw SQL as a model action before executing an analytics plan', async () => {
    const f = fixture([{ action: 'query', sql: 'SELECT * FROM cashflow', interpretation: interpretation() }]);
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_plan_invalid' });
    expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });

  it('turns compiler missing conditions into a saved clarification without replacing previous context', async () => {
    const f = fixture([{ action: 'query', plan: plan({ time: {} }), interpretation: interpretation() }]);
    f.analytics.queryPlan.mockRejectedValue(Object.assign(new Error('period required'), { code: 'semantic_clarification_required', details: { missingFields: [ambiguity] } }));
    const result = await runConversationTurn(f.args);
    expect(result).toMatchObject({ status: 'clarification_required', answer: ambiguity.question, context: prior });
    expect(result).not.toHaveProperty('evidence');
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.bindHtml).not.toHaveBeenCalled();
  });

  it('settles an aborted turn even if its provider ignores AbortSignal', async () => {
    const f = fixture([]); const controller = new AbortController();
    f.complete.mockImplementation(() => new Promise(() => {}));
    const pending = runConversationTurn({ ...f.args, signal: controller.signal }).then(() => 'completed', () => 'aborted');
    const timer = setTimeout(() => controller.abort(), 5);
    const deadline = new Promise((resolve) => setTimeout(() => resolve('still_pending'), 80));
    try { expect(await Promise.race([pending, deadline])).toBe('aborted'); }
    finally { clearTimeout(timer); }
    expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
});
