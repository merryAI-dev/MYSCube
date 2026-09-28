import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { issueDateColumnChoice, anchorDateColumnChoice, selectDateColumnChoice, dateBasisDisplay, publicDateTurn, assertDateBasisPlan } from './date-column-choice.mjs';
import { runConversationTurn } from './conversation-agent.mjs';

const period = { start: '2026-09-01', end: '2026-09-30', label: '9월', basis: 'explicit_request' };
const item = { datasetId: 'project_dates', version: 'a'.repeat(64), tableQuery: { schemaVersion: 1 }, schema: [
  { name: 'name', type: 'string' }, { name: 'contract_start', type: 'date', label: '계약 시작일' }, { name: 'contract_end', type: 'date', label: '계약 종료일' }, { name: 'updated_at', type: 'timestamp' },
] };
const context = { analyticsScope: { datasetIds: [item.datasetId, 'other_dates'], fingerprint: 'b'.repeat(64) } };
const interpreted = (range = period, datasetId = item.datasetId) => ({ summary: '사본 날짜 조회', ambiguities: [], context: { datasetIds: [datasetId], filters: {}, evidenceIds: [], ...(range ? { period: range } : {}) } });
const plan = (field = 'contract_end', range = period) => ({ kind: 'table', datasetId: item.datasetId, select: ['name'], filters: range ? [{ field, op: 'gte', value: range.start }, { field, op: 'lte', value: range.end }] : [] });
const response = step => ({ tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify(step) } }] });
function fixture(range = period) {
  const sessionId = randomUUID(), pending = anchorDateColumnChoice(issueDateColumnChoice({ datasetId: item.datasetId, catalogItems: [item], message: '날짜 조회', period: range }),
    { sessionId, turnId: randomUUID(), version: 1, scopeFingerprint: context.analyticsScope.fingerprint });
  const args = { pending, selection: { clarificationId: pending.id, optionId: pending.options[1].id }, context, sessionId, version: 1, turnId: randomUUID(), at: '2026-09-28T00:00:00.000Z', catalogItems: [item] };
  return { pending, args, basis: selectDateColumnChoice(args) };
}
function runner(steps, options = {}) {
  const { pending, basis } = fixture();
  const remaining = [...steps], evidenceId = randomUUID();
  const analytics = { catalog: vi.fn(async () => ({ items: [item] })), queryPlan: vi.fn(async () => ({ evidenceId, datasetVersions: { [item.datasetId]: item.version }, rows: [{ name: '합성 종료 사업' }], columns: [{ name: 'name', type: 'string' }] })) };
  const complete = vi.fn(async () => { const step = remaining.shift(); if (!step) throw new Error('unexpected completion'); return response(step === 'answer' ? { action: 'answer', interpretation: interpreted(), answer: '확인한 자료', evidenceIds: [evidenceId] } : step); });
  return { analytics, complete, pending, basis, args: { context, message: '계약 종료일', workContext: {}, dateBasis: basis, selectedDateBasis: basis,
    signal: new AbortController().signal, authorize: async () => {}, complete, analytics, ...options } };
}

describe('server-issued date choice and exact query enforcement', () => {
  it('issues only approved date columns with opaque IDs and removes private provenance from public turns', () => {
    const { pending, basis } = fixture();
    expect(pending.dateColumn.options.map(option => option.field)).toEqual(['contract_start', 'contract_end']);
    expect(pending.options.map(option => option.label)).toEqual(['계약 시작일', '계약 종료일']);
    expect(pending.options[0].id).toMatch(/^[a-f0-9-]{36}$/);
    const publicTurn = publicDateTurn({ selection: basis, result: { clarification: pending, dateBasisProvenance: [{ selectedTurnId: basis.selectedTurnId }] } });
    expect(publicTurn.selection).toBeUndefined(); expect(publicTurn.result.dateBasisProvenance).toBeUndefined();
    expect(publicTurn.result.clarification.dateColumn).toBeUndefined(); expect(publicTurn.result.clarification.issued).toBeUndefined();
    expect(publicTurn.result.clarification.options).toEqual(pending.options);
  });
  it.each(['option', 'clarification', 'session', 'version', 'scope', 'schema'])('rejects changed %s without selecting a basis', kind => {
    const { args } = fixture();
    if (kind === 'option') args.selection.optionId = randomUUID();
    if (kind === 'clarification') args.selection.clarificationId = randomUUID();
    if (kind === 'session') args.sessionId = randomUUID();
    if (kind === 'version') args.version = 2;
    if (kind === 'scope') args.context = { analyticsScope: { ...context.analyticsScope, fingerprint: 'c'.repeat(64) } };
    if (kind === 'schema') args.catalogItems = [{ ...item, schema: item.schema.slice(0, 2) }];
    expect(() => selectDateColumnChoice(args)).toThrow(expect.objectContaining({ statusCode: 409 }));
  });
  it('allows a new data version with the same definition and marks a changed definition stale', () => {
    const { args, basis } = fixture(); args.catalogItems = [{ ...item, version: 'c'.repeat(64) }];
    expect(selectDateColumnChoice(args).definitionHash).toBe(basis.definitionHash);
    expect(dateBasisDisplay(basis, context, args.catalogItems)).toEqual({ dateBasis: { datasetId: item.datasetId, field: 'contract_end', label: '계약 종료일' } });
    expect(dateBasisDisplay(basis, context, [{ ...item, schema: item.schema.slice(0, 2) }])).toHaveProperty('dateBasisNotice');
    expect(dateBasisDisplay(basis, { analyticsScope: { ...context.analyticsScope, fingerprint: 'c'.repeat(64) } }, [item])).toEqual({});
  });
  it('excludes timestamp-only catalogs instead of guessing a timezone or date', () => {
    expect(() => issueDateColumnChoice({ datasetId: item.datasetId, catalogItems: [{ ...item, schema: [item.schema[3]] }], message: '날짜' })).toThrow(expect.objectContaining({ code: 'conversation_date_columns_unavailable' }));
  });
  it('preserves the chosen period even when the model drops context.period', () => {
    const { basis } = fixture();
    expect(() => assertDateBasisPlan({ basis, selected: basis, plan: plan(), queryContext: {}, previous: {}, catalogItems: [item] })).not.toThrow();
    expect(() => assertDateBasisPlan({ basis, selected: basis, plan: plan('contract_end', null), queryContext: {}, previous: {}, catalogItems: [item] })).toThrow(expect.objectContaining({ code: 'conversation_date_basis_mismatch' }));
  });
  it('rejects a changed period on the selecting turn but permits a later period-only change', () => {
    const { basis } = fixture(), october = { ...period, start: '2026-10-01', end: '2026-10-31' };
    const args = { basis, plan: plan('contract_end', october), queryContext: { period: october }, previous: { period }, catalogItems: [item] };
    expect(() => assertDateBasisPlan({ ...args, selected: basis })).toThrow(expect.objectContaining({ code: 'conversation_date_period_missing' }));
    expect(() => assertDateBasisPlan(args)).not.toThrow();
  });
  it('does not execute an unbounded request after a date basis instead of silently adding its old range', async () => {
    const step = { action: 'query_table', interpretation: interpreted(null), plan: plan('contract_end', null) };
    const f = runner([step], { selectedDateBasis: null, message: '기간 없이 전체 사업을 보여줘', workContext: { period } });
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_date_basis_mismatch' }); expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('blocks the wrong field and selecting-turn dataset switches before SQL', async () => {
    for (const actualPlan of [plan('contract_start'), { ...plan(), datasetId: 'other_dates' }]) {
      const f = runner([{ action: 'query_table', interpretation: interpreted(), plan: actualPlan }]);
      await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_date_basis_mismatch' }); expect(f.analytics.queryPlan).not.toHaveBeenCalled();
    }
  });
  it('rechecks schema immediately after model completion and refuses a changed definition', async () => {
    const f = runner([{ action: 'query_table', interpretation: interpreted(), plan: plan() }]);
    f.analytics.catalog.mockResolvedValueOnce({ items: [item] }).mockResolvedValue({ items: [{ ...item, schema: item.schema.slice(0, 2) }] });
    await expect(runConversationTurn(f.args)).rejects.toMatchObject({ code: 'conversation_date_choice_stale' });
    expect(f.analytics.catalog).toHaveBeenCalledTimes(2); expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('uses the rechecked current copy pin and records server-only provenance for the actual evidence', async () => {
    const f = runner([{ action: 'query_table', interpretation: interpreted(), plan: plan() }, 'answer']), observed = vi.fn();
    f.analytics.catalog.mockResolvedValueOnce({ items: [item] }).mockResolvedValue({ items: [{ ...item, version: 'c'.repeat(64) }] });
    await runConversationTurn({ ...f.args, onQuery: observed });
    expect(f.analytics.queryPlan).toHaveBeenCalledWith(context, plan(), expect.objectContaining({ datasetVersions: { [item.datasetId]: 'c'.repeat(64) } }));
    expect(observed).toHaveBeenCalledWith({ datasetId: item.datasetId, dateBasisProvenance: expect.objectContaining({ field: 'contract_end', selectedTurnId: f.basis.selectedTurnId, definitionHash: f.basis.definitionHash, datasetVersion: 'c'.repeat(64) }) });
  });
  it('does not turn a free-text option label or model explicit_request into a confirmed choice', async () => {
    const f = runner([{ action: 'query_table', interpretation: interpreted(), plan: plan() }]);
    const result = await runConversationTurn({ ...f.args, dateBasis: null, selectedDateBasis: null, pendingClarification: f.pending });
    expect(result.clarification).toEqual(f.pending); expect(result.answer).toContain('아직 선택되지'); expect(f.analytics.queryPlan).not.toHaveBeenCalled();
  });
});
