import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { buildSemanticQueryGuide } from './semantic-query-guide.mjs';
import { compileSemanticQuery, SemanticQueryPlanSchema, SEMANTIC_SELECTION_POLICY } from './semantic-query.mjs';
import { SEMANTIC_DEFINITIONS } from './semantic-catalog.mjs';
import { executeAnalyticsQuery } from './analytics-engine.mjs';
import { buildEvaluationDatasets } from './evaluation/acceptance-cases.mjs';

const itemsFor = (datasets) => datasets.map((dataset) => ({ datasetId: dataset.datasetId, ...dataset.manifest, schema: dataset.schema, version: 'a'.repeat(64) }));
const items = itemsFor(buildEvaluationDatasets());
const weeklyPlan = { datasetId: 'weekly_submission', definitionVersion: '1', select: ['project_id', 'status'], time: { yearMonth: '2026-09', weekScope: 'all' } };
const inflowPlan = { datasetId: 'cashflow_inflow', definitionVersion: '1', measures: ['total_amount', 'known_amount_total'], time: { yearMonth: '2026-09', weekNo: 1 },
  filters: [{ field: 'mode', op: 'eq', value: 'actual' }, { field: 'receipt_scope', op: 'eq', value: 'sales' }, { field: 'currency', op: 'eq', value: 'KRW' }] };

describe('schema-derived semantic query guidance', () => {
  it('shares executable selection policy and the original typed time schema without adding enum aliases', () => {
    const guide = buildSemanticQueryGuide({ catalogItems: items });
    expect(guide.selection).toBe(SEMANTIC_SELECTION_POLICY);
    expect(guide.time.parameters).toEqual(z.toJSONSchema(SemanticQueryPlanSchema).properties.time.properties);
    expect(guide.time.parameters.weekScope.const).toBe('all');
    expect(guide.time.parameters.weekNo).toMatchObject({ type: 'integer', minimum: 1, maximum: 5 });
    expect(guide.selection).toEqual({ exactlyOneOf: ['select', 'measures'], groupByRequires: 'measures' });
    expect(Buffer.byteLength(JSON.stringify(guide))).toBeLessThan(7000);
  });
  it('places bound period fields only in time and distinguishes context-only criteria from executable filters', () => {
    const guide = buildSemanticQueryGuide({ catalogItems: items });
    for (const dataset of guide.datasets) {
      expect(dataset.time.bindings).toEqual({ yearMonth: 'year_month', weekNo: 'week_no' });
      expect(dataset.time.excludedFromFilters).toEqual(['year_month', 'week_no']);
      expect(dataset.filterFields.map(({ field }) => field)).not.toContain('year_month');
      expect(dataset.filterFields.map(({ field }) => field)).not.toContain('week_no');
      expect(dataset.filterFields.map(({ field }) => field)).not.toContain('period_basis');
    }
    const cash = guide.datasets.find(({ datasetId }) => datasetId === 'cashflow_inflow');
    expect(cash.context).toEqual({ mirrorRequiredFilterValues: ['mode', 'receipt_scope', 'currency'], only: { period_basis: 'finance_week' } });
    expect(cash.filterFields.filter(({ required }) => required).map(({ field, required }) => ({ field, required }))).toEqual(['mode', 'receipt_scope', 'currency'].map((field) => ({ field, required: { operator: 'eq', count: 1, arrayValueAllowed: false } })));
    expect(cash.filterFields.filter(({ required }) => required).every(({ operators }) => JSON.stringify(operators) === '["eq"]')).toBe(true);
    expect(cash.filterFields.map(({ field }) => field)).not.toContain('amount');
    expect(cash.measures.find(({ id }) => id === 'total_amount').companions).toContain('missing_cell_count');
  });
  it('publishes only bound accessible copies and ignores caller-supplied definition objects', () => {
    const corrupted = { ...items[1], schema: items[1].schema.filter(({ name }) => name !== 'amount') };
    const forged = { ...items[0], definition: { fields: { secret: { filterable: true } } } };
    const guide = buildSemanticQueryGuide({ catalogItems: [forged, corrupted, { datasetId: 'legacy', schema: items[0].schema }] });
    expect(guide.datasets.map(({ datasetId }) => datasetId)).toEqual(['weekly_submission']);
    expect(JSON.stringify(guide)).not.toContain('secret');
    expect(buildSemanticQueryGuide({ catalogItems: [] }).datasets).toEqual([]);
    expect(buildSemanticQueryGuide({ catalogItems: [{ ...items[0], version: 'unversioned' }] }).datasets).toEqual([]);
  });
  it('tracks trusted definition field names, operators, enums and grouping changes in both guide and compiler', () => {
    const definition = structuredClone(SEMANTIC_DEFINITIONS[0]);
    definition.version = 'guide-fixture';
    definition.fields.period_month = definition.fields.year_month;
    delete definition.fields.year_month;
    definition.grain.keys = definition.grain.keys.map((key) => key === 'year_month' ? 'period_month' : key);
    definition.timeFields.yearMonth = 'period_month';
    definition.fields.status.allowedOperators = ['eq'];
    definition.fields.status.enumValues = ['PENDING_APPROVAL'];
    definition.fields.revision.filterable = false;
    definition.fields.health.groupable = false;
    const item = { ...items[0], semanticDefinitionVersion: definition.version };
    const options = { catalogItems: [item], definitionRegistry: [definition] };
    const guide = buildSemanticQueryGuide(options).datasets[0];
    expect(guide.time.bindings.yearMonth).toBe('period_month');
    expect(guide.filterFields.map(({ field }) => field)).not.toContain('period_month');
    expect(guide.filterFields.map(({ field }) => field)).not.toContain('revision');
    expect(guide.groupByFields).not.toContain('health');
    expect(guide.filterFields.find(({ field }) => field === 'status')).toMatchObject({ operators: ['eq'], enumValues: ['PENDING_APPROVAL'] });
    const plan = { ...weeklyPlan, definitionVersion: definition.version, filters: [{ field: 'status', op: 'eq', value: 'PENDING_APPROVAL' }] };
    expect(compileSemanticQuery({ ...options, plan }).sql).toContain('"year_month"');
    expect(() => compileSemanticQuery({ ...options, plan: { ...plan, filters: [{ field: 'status', op: 'ne', value: 'PENDING_APPROVAL' }] } })).toThrow(expect.objectContaining({ code: 'semantic_filter_operator_invalid' }));
  });
  it.each([
    [{ select: undefined }, 'semantic_selection_invalid'],
    [{ measures: ['project_count'] }, 'semantic_selection_invalid'],
    [{ groupBy: ['status'] }, 'semantic_selection_invalid'],
    [{ time: { yearMonth: '2026-09', weekNo: 1, weekScope: 'specific' } }, 'semantic_plan_invalid'],
    [{ time: { yearMonth: '2026-09', weekNo: 1, weekScope: 'specified' } }, 'semantic_plan_invalid'],
    [{ time: { yearMonth: '2026-09', weekNo: 1, weekScope: 'all' } }, 'semantic_time_conflict'],
    [{ filters: [{ field: 'year_month', op: 'eq', value: '2026-09' }] }, 'semantic_time_filter_conflict'],
    [{ filters: [{ field: 'period_basis', op: 'eq', value: 'finance_week' }] }, 'semantic_field_unknown'],
  ])('keeps invalid plans invalid instead of translating or dropping their conditions: %j', (overrides, code) => {
    expect(() => compileSemanticQuery({ plan: { ...weeklyPlan, ...overrides }, catalogItems: items })).toThrow(expect.objectContaining({ code }));
  });
  it('retains the rejection of repeated inflow period filters and omitted business criteria', () => {
    expect(() => compileSemanticQuery({ plan: { ...inflowPlan, filters: [...inflowPlan.filters, { field: 'week_no', op: 'eq', value: 1 }] }, catalogItems: items })).toThrow(expect.objectContaining({ code: 'semantic_filter_not_allowed' }));
    expect(() => compileSemanticQuery({ plan: { ...inflowPlan, filters: inflowPlan.filters.slice(1) }, catalogItems: items })).toThrow(expect.objectContaining({ code: 'semantic_clarification_required' }));
  });
  it.each([['zero', '0', '0'], ['empty', null, '1']])('executes a guided inflow plan over the unchanged %s fixture without merging zero and unknown', async (scenario, amount, missing) => {
    const datasets = buildEvaluationDatasets(scenario);
    const guide = buildSemanticQueryGuide({ catalogItems: itemsFor(datasets) }).datasets.find(({ datasetId }) => datasetId === inflowPlan.datasetId);
    expect(inflowPlan.filters.every(({ field }) => guide.filterFields.some((item) => item.field === field))).toBe(true);
    const compiled = compileSemanticQuery({ plan: inflowPlan, catalogItems: itemsFor(datasets) });
    const result = await executeAnalyticsQuery({ sql: compiled.sql, datasets });
    expect(result.rows[0]).toMatchObject({ total_amount: amount, missing_cell_count: missing });
  });
  it('executes permitted official status filters separately and allows grouped measures only in aggregate mode', async () => {
    const datasets = buildEvaluationDatasets();
    const compiled = compileSemanticQuery({ plan: { ...weeklyPlan, filters: [{ field: 'status', op: 'eq', value: 'PENDING_APPROVAL' }] }, catalogItems: items });
    expect((await executeAnalyticsQuery({ sql: compiled.sql, datasets })).rows).toEqual([{ project_id: 'synthetic-pending', status: 'PENDING_APPROVAL' }]);
    const grouped = compileSemanticQuery({ plan: { ...weeklyPlan, select: undefined, measures: ['observation_count'], groupBy: ['status'], orderBy: [{ field: 'status', direction: 'asc' }] }, catalogItems: items });
    expect((await executeAnalyticsQuery({ sql: grouped.sql, datasets })).rows).toEqual([
      { status: 'COMPLETED', observation_count: '1' }, { status: 'PENDING_APPROVAL', observation_count: '1' },
      { status: 'WAITING_FOR_UPDATE', observation_count: '1' }, { status: null, observation_count: '1' },
    ]);
  });
});
