import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { createAnalyticsService } from './analytics-service.mjs';
import { sha256 } from './analytics-contract.mjs';
import { buildCashflowInflowDataset } from './cashflow-inflow-copy.mjs';
import { makeInflowFixtureMatrix } from './cashflow-inflow-fixture.mjs';
import { LINE_ROWS, weekColumnFor } from '../bff/cashflow-coordinates.mjs';
import { resolveHtmlBindings } from './html-bindings.mjs';
import { runConversationTurn, seoulCalendar } from './conversation-agent.mjs';
import { importAnalyticsSnapshot } from './analytics-import.mjs';
import request from 'supertest';
import { createWorkbenchApp } from './app.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('S17 persisted inflow evidence and bounded conversational interpretation', () => {
  const db = new Firestore({ projectId: 'demo-inflow-evidence' });
  const context = { tenantId: 'inflow-it', actorId: 'admin-a', actorRole: 'admin', analyticsScope: { fingerprint: sha256('inflow-test-grant'), datasetIds: ['cashflow_inflow'] } };
  const root = `orgs/${context.tenantId}`;
  const now = () => '2026-09-23T12:00:00.000Z';
  const service = () => createAnalyticsService({ db, now });
  const plan = { datasetId: 'cashflow_inflow', definitionVersion: '1', measures: ['total_amount', 'known_amount_total'], time: { yearMonth: '2026-09', weekNo: 1 }, filters: [
    { field: 'mode', op: 'eq', value: 'actual' }, { field: 'receipt_scope', op: 'eq', value: 'sales_with_vat' }, { field: 'currency', op: 'eq', value: 'KRW' },
  ] };
  const selected = { period: { start: '2026-09-01', end: '2026-09-06', label: '2026년 9월 1정산주', basis: 'explicit_request' }, datasetIds: ['cashflow_inflow'], filters: { mode: 'actual', receipt_scope: 'sales_with_vat', currency: 'KRW', period_basis: 'finance_week' }, evidenceIds: [] };
  const makeCopy = (amount = '100', capturedAt = '2026-09-23T10:00:00.000Z') => {
    const matrix = makeInflowFixtureMatrix(2026, '0'); const col = weekColumnFor(2026, '2026-09', 1);
    matrix[LINE_ROWS.actual[3]][col] = amount; matrix[LINE_ROWS.actual[4]][col] = '10';
    return buildCashflowInflowDataset({ yearMonth: '2026-09', weekNos: [1], capturedAt, targets: [
      { projectId: 'good', spreadsheetId: 'sheet-good', sheetName: '사업비', currency: 'KRW', weeklyYear: 2026, capturedAt, matrix },
      { projectId: 'unavailable', spreadsheetId: 'sheet-unavailable', sheetName: '사업비', currency: 'KRW', weeklyYear: 2026, failure: 'UNAVAILABLE' },
    ] });
  };
  const html = '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>입금 확인</title></head><body><h1>입금 확인</h1><section data-binding="inflow"></section></body></html>';
  const tool = (value: any) => ({ tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify(value) } }] });
  beforeEach(async () => { await db.recursiveDelete(db.doc(root)); });
  afterAll(async () => { await db.recursiveDelete(db.doc(root)); await db.terminate(); });

  it('imports copied sheet matrices through the authorized offline importer without granting a Sheets connection', async () => {
    const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-inflow-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-inflow-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-business-model', WORKBENCH_IMPORT_ENABLED: 'true' };
    let grants = 0;
    const input = { yearMonth: '2026-09', weekNos: [1], capturedAt: now(), targets: [{ projectId: 'a', spreadsheetId: 'sheet-a', sheetName: '사업비', currency: 'KRW', weeklyYear: 2026, matrix: makeInflowFixtureMatrix(2026, '0') }] };
    const authorize = async () => { grants++; };
    await expect(importAnalyticsSnapshot({ env: { ...env, WORKBENCH_IMPORT_ENABLED: 'false' }, db, context, authorize, now, format: 'sheets-inflow', input })).rejects.toMatchObject({ code: 'analytics_import_disabled' });
    expect(grants).toBe(0);
    const imported = await importAnalyticsSnapshot({ env, db, context, authorize, now, format: 'sheets-inflow', input });
    expect(imported.rowCount).toBe(6); expect(grants).toBe(2);
    expect((await service().queryPlan(context, plan)).rows[0]).toMatchObject({ total_amount: '0', missing_cell_count: '0' });
  });

  it('stores coverage and raw provenance, computes a partial amount, and reopens pinned evidence after a newer copy', async () => {
    const first = await service().importDataset(context, makeCopy());
    const catalog = await service().catalog(context);
    expect(catalog.semantic.items[0].definition.id).toBe('cashflow_inflow');
    expect(catalog.items[0].timeCoverage).toEqual({ yearMonth: '2026-09', weekNos: [1] });
    const evidence = await service().queryPlan(context, plan);
    expect(evidence.rows[0]).toMatchObject({ total_amount: null, known_amount_total: '110', project_count: '2', missing_observation_count: '1', expected_cell_count: '4', confirmed_cell_count: '2', missing_cell_count: '2' });
    expect(evidence.metadata.resultScope).toContain('2026-09-01 ~ 2026-09-06');
    expect(evidence.metadata.resultScope).toContain('실제 입금');
    expect(evidence.metadata.resultScope).toContain('부분합');
    const amountsByProject = await service().queryPlan(context, { ...plan, measures: undefined, select: ['known_amount'] });
    expect(amountsByProject.columns.map((column: any) => column.name)).toEqual(expect.arrayContaining(['project_id', 'missing_cells', 'source_status', 'week_start', 'week_end']));
    expect(amountsByProject.rows.find((row: any) => row.project_id === 'unavailable')).toMatchObject({ known_amount: null, missing_cells: '2' });
    const bound = resolveHtmlBindings({ title: '입금 확인', html, bindings: { inflow: { kind: 'table', evidenceId: evidence.evidenceId } } }, [evidence]);
    expect(bound.source.html).toContain('확인된 항목 부분합');
    expect(bound.source.html).toContain('>110<'); expect(bound.source.html).toContain('자료 없음');
    const raw = await service().queryPlan(context, { ...plan, measures: undefined, select: ['project_id', 'source_cells', 'captured_at', 'source_revision', 'week_start', 'week_end'] });
    const record: any = raw.rows.find((row: any) => row.project_id === 'good');
    expect(JSON.parse(record.source_cells)[0]).toMatchObject({ rawValue: '100', amount: '100', state: 'VALUE' });
    const second = await service().importDataset(context, makeCopy('200', '2026-09-23T11:00:00.000Z'));
    expect(second.version).not.toBe(first.version);
    expect((await service().queryPlan(context, plan)).rows[0].known_amount_total).toBe('210');
    expect((await service().queryPlan(context, plan, { datasetVersions: { cashflow_inflow: first.version } })).rows[0].known_amount_total).toBe('110');
    expect(await service().evidence(context, evidence.evidenceId)).toEqual(evidence);
    expect(resolveHtmlBindings({ title: '입금 확인', html, bindings: bound.bindings }, [await service().evidence(context, evidence.evidenceId)]).source.html).toBe(bound.source.html);
    await expect(service().evidence({ ...context, actorId: 'other' }, evidence.evidenceId)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects a financial amount card that hides coverage, while allowing the amount alongside the evidence table', async () => {
    await service().importDataset(context, makeCopy());
    const evidence = await service().queryPlan(context, plan);
    const card = html.replace('<section data-binding="inflow"></section>', '<span data-binding="amount"></span>');
    const bindings = { amount: { kind: 'value', evidenceId: evidence.evidenceId, column: 'known_amount_total', row: 0 } };
    expect(() => resolveHtmlBindings({ title: '입금 확인', html: card, bindings }, [evidence])).toThrow('binding_coverage_required');
    const withTable = card.replace('</body>', '<section data-binding="inflow"></section></body>');
    expect(resolveHtmlBindings({ title: '입금 확인', html: withTable, bindings: { ...bindings, inflow: { kind: 'table', evidenceId: evidence.evidenceId } } }, [evidence]).source.html).toContain('확인이 필요한 항목 수');
  });

  it('uses native persisted evidence in the conversation, with a fixture planner rather than claiming model accuracy', async () => {
    await service().importDataset(context, makeCopy());
    let calls = 0;
    const result = await runConversationTurn({ context, message: '정산주 기준 실제 입금 매출과 부가세 포함해서 보여줘', workContext: selected,
      complete: async ({ messages }: any) => {
        calls++;
        const response = messages.findLast((message: any) => message.content.startsWith('조회 도구 결과'));
        const interpretation = { summary: '2026년 9월 1정산주 매출·매출부가세 실제 입금', context: selected, ambiguities: [] };
        if (!response) return tool({ action: 'query', interpretation, plan });
        const evidence = JSON.parse(response.content.slice(response.content.indexOf(':') + 1));
        return tool({ action: 'render', interpretation, title: '입금 확인', answer: '조회하지 못한 사업이 있어 전체 합계는 계산할 수 없습니다. 확인된 항목 부분합과 누락을 표에 표시했습니다.', html, bindings: [{ id: 'inflow', kind: 'table', evidenceId: evidence.evidenceId }] });
      }, analytics: service(), qa: () => { throw new Error('QA tool not needed'); }, authorize: async () => {}, bindHtml: resolveHtmlBindings, signal: new AbortController().signal, now });
    expect(calls).toBe(2); expect(result.status).toBe('preview_ready');
    expect(result.proposal.html).toContain('>110<');
    expect(result.evidence[0].rows[0].total_amount).toBeNull();
    expect(result.context.filters.period_basis).toBe('finance_week');
  });

  it('blocks calendar-week reinterpretation and missing-copy fallback before query execution', async () => {
    await service().importDataset(context, makeCopy());
    await expect(service().queryPlan(context, { ...plan, time: { yearMonth: '2026-09', weekScope: 'all' } })).rejects.toMatchObject({ code: 'semantic_period_copy_missing' });
    const calendar = { ...selected, period: { ...selected.period, start: '2026-08-31' }, filters: { ...selected.filters, period_basis: 'calendar_week' } };
    let queries = 0;
    await expect(runConversationTurn({ context, message: '달력주로', workContext: selected, complete: async () => tool({ action: 'query', plan, interpretation: { summary: '달력주', context: calendar, ambiguities: [] } }),
      analytics: { ...service(), queryPlan: async () => { queries++; throw new Error('must not query'); } }, qa: async () => {}, authorize: async () => {}, bindHtml: resolveHtmlBindings, signal: new AbortController().signal, now })).rejects.toMatchObject({ code: 'conversation_plan_context_mismatch' });
    expect(queries).toBe(0);
    const clock = seoulCalendar('2026-08-31T23:30:00Z');
    expect(clock.today).toBe('2026-09-01');
    expect(clock.financeWeeks.thisWeek).toMatchObject({ weekStart: '2026-09-01', weekEnd: '2026-09-06' });
    expect(clock.financeWeeks.previousWeek).toMatchObject({ weekStart: '2026-08-24', weekEnd: '2026-08-31' });
  });

  it('reads canonical evidence outside the generated iframe and rejects revoked or other-owner requests', async () => {
    const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-inflow-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-inflow-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-business-model' };
    const granted: any = { tenantId: context.tenantId, actorId: 'admin-a', actorRole: 'admin' };
    for (const actor of ['admin-a', 'admin-b']) await db.doc(`${root}/members/${actor}`).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now(), analyticsDatasetIds: ['cashflow_inflow'], analyticsScopeRevision: 'v1' });
    const core = createIsolatedWorkbenchCore({ db, env, now });
    await core.authorize(granted);
    await service().importDataset(granted, makeCopy());
    const evidence = await service().queryPlan(granted, plan);
    const app = createWorkbenchApp({ db, env, now, authMode: 'headers' });
    const read = (actor = 'admin-a') => request(app).get(`/api/v1/html-work-pages/evidence/${evidence.evidenceId}`).set('x-tenant-id', context.tenantId).set('x-actor-id', actor);
    const response = await read();
    expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.rows[0]).toMatchObject({ total_amount: null, known_amount_total: '110', missing_observation_count: '1' });
    expect(response.body.semantic.definitionVersions.cashflow_inflow.id).toBe('cashflow_inflow');
    expect([403, 404]).toContain((await read('admin-b')).status);
    await db.doc(`${root}/members/admin-a`).update({ analyticsDatasetIds: [], analyticsScopeRevision: 'v2' });
    const revoked = await read();
    expect([403, 404]).toContain(revoked.status); expect(revoked.body.rows).toBeUndefined();
  });
});
