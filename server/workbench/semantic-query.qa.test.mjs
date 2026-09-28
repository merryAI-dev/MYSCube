import { describe, expect, it } from 'vitest';
import { SEMANTIC_DEFINITIONS, resolveSemanticCatalog, validateSemanticDataset } from './semantic-catalog.mjs';
import { compileSemanticQuery } from './semantic-query.mjs';
import { executeAnalyticsQuery } from './analytics-engine.mjs';

const schema = ['project_id:string', 'year_month:string', 'week_no:integer', 'status:string', 'revision:integer', 'submitted_at:timestamp', 'approved_at:timestamp', 'health:string'].map((pair) => {
  const [name, type] = pair.split(':'); return { name, type };
});
const row = (project, week, status, extra = {}) => ({ project_id: project, year_month: '2026-09', week_no: week, status, revision: 0, submitted_at: null, approved_at: null, health: 'OK', ...extra });
const rows = [row('같은 사업', 1, 'WAITING_FOR_UPDATE'), row('같은 사업', 2, 'PENDING_APPROVAL'), row('같은 사업', 3, 'COMPLETED'), row('같은 사업', 4, 'WAITING_FOR_UPDATE', { health: 'RECONCILING' }), row('누락 사업', 1, null, { revision: null, health: 'UNAVAILABLE' })];
const manifest = { semanticDefinitionId: 'weekly_submission', semanticDefinitionVersion: '1' };
const dataset = { datasetId: 'weekly_submission', manifest, schema, rows };
const item = { ...manifest, datasetId: dataset.datasetId, version: 'a'.repeat(64), schema };
const plan = { datasetId: dataset.datasetId, definitionVersion: '1', select: ['project_id', 'status', 'recorded_status', 'revision'], time: { yearMonth: '2026-09', weekScope: 'all' } };
const compile = (overrides = {}, items = [item]) => compileSemanticQuery({ plan: { ...plan, ...overrides }, catalogItems: items });
const execute = async (input, data = dataset) => executeAnalyticsQuery({ sql: input.sql, datasets: [data] });

describe('semantic data-path QA: actual native computation, not model assertions', () => {
  it('counts unique projects separately from project-week observations and unknown states', async () => {
    const compiled = compile({ select: undefined, measures: ['project_count', 'observation_count', 'missing_status_count'] });
    expect((await execute(compiled)).rows).toEqual([{ project_count: '2', observation_count: '5', missing_status_count: '2' }]);
    expect(compiled.definitionVersions.weekly_submission).toMatchObject({ id: 'weekly_submission', version: '1' });
    expect(compiled.sourceRefs.length).toBeGreaterThan(0);
  });
  it('keeps approval pending separate and does not trust raw status when source health is uncertain', async () => {
    const result = await execute(compile({ select: ['week_no', 'status', 'recorded_status', 'revision'], filters: [{ field: 'project_id', op: 'eq', value: '같은 사업' }], orderBy: [{ field: 'week_no', direction: 'asc' }] }));
    expect(result.rows).toEqual([
      { week_no: '1', status: 'WAITING_FOR_UPDATE', recorded_status: 'WAITING_FOR_UPDATE', revision: '0' },
      { week_no: '2', status: 'PENDING_APPROVAL', recorded_status: 'PENDING_APPROVAL', revision: '0' },
      { week_no: '3', status: 'COMPLETED', recorded_status: 'COMPLETED', revision: '0' },
      { week_no: '4', status: null, recorded_status: 'WAITING_FOR_UPDATE', revision: '0' },
    ]);
    const missing = await execute(compile({ select: ['project_id', 'revision'], filters: [{ field: 'status', op: 'is_null' }] }));
    expect(missing.rows).toEqual([{ project_id: '같은 사업', revision: '0' }, { project_id: '누락 사업', revision: null }]);
  });
  it('escapes filter values as values without widening the query', async () => {
    const attack = "x' OR 1=1 --";
    const data = { ...dataset, rows: [...rows, row(attack, 1, 'COMPLETED')] };
    const result = await execute(compile({ select: ['project_id'], filters: [{ field: 'project_id', op: 'eq', value: attack }] }), data);
    expect(result.rows).toEqual([{ project_id: attack }]);
  });
  it.each([
    [{ definitionVersion: 'unregistered' }, 'semantic_definition_version_mismatch'],
    [{ measures: ['non_submission_count'], select: undefined }, 'semantic_metric_unknown'],
    [{ select: ['secret'] }, 'semantic_field_unknown'],
    [{ filters: [{ field: 'status', op: 'eq', value: 'NOT_SUBMITTED' }] }, 'semantic_filter_value_invalid'],
    [{ filters: [{ field: 'recorded_status', op: 'eq', value: 'COMPLETED' }] }, 'semantic_filter_not_allowed'],
    [{ filters: [{ field: 'revision', op: 'eq', value: '0' }] }, 'semantic_filter_value_invalid'],
    [{ filters: [{ field: 'year_month', op: 'eq', value: '2026-08' }] }, 'semantic_time_filter_conflict'],
    [{ time: { yearMonth: '2026-09', weekNo: 1, weekScope: 'all' } }, 'semantic_time_conflict'],
    [{ sql: 'SELECT * FROM weekly_submission' }, 'semantic_plan_invalid'],
    [{ joins: ['other_tenant'] }, 'semantic_plan_invalid'],
  ])('rejects an unsupported interpretation before execution: %j', (overrides, code) => {
    expect(() => compile(overrides)).toThrow(expect.objectContaining({ code }));
  });
  it('returns concrete questions for missing period/scope, instead of guessing a year or all weeks', () => {
    try { compile({ time: undefined }); throw new Error('should reject'); }
    catch (error) {
      expect(error.code).toBe('semantic_clarification_required');
      expect(error.details.missingFields.map((field) => field.field)).toEqual(['time.yearMonth', 'time.weekNo']);
      expect(error.details.missingFields.every((field) => field.question.length > 0)).toBe(true);
    }
  });
  it('preserves undefined legacy copies but excludes them from executable definitions', () => {
    const legacy = { datasetId: 'legacy', version: 'b'.repeat(64), schema };
    expect(resolveSemanticCatalog({ catalogItems: [item, legacy] })).toMatchObject({ items: [{ datasetId: item.datasetId }], unavailable: [{ datasetId: 'legacy', code: 'semantic_definition_required' }] });
    expect(() => compile({}, [{ ...item, semanticDefinitionVersion: '2' }])).toThrow(expect.objectContaining({ code: 'semantic_definition_unknown' }));
    expect(() => compile({}, [{ ...item, schema: schema.filter((column) => column.name !== 'health') }])).toThrow(expect.objectContaining({ code: 'semantic_schema_mismatch' }));
  });
  it('rejects history mixed with current rows instead of double counting revisions', () => {
    expect(validateSemanticDataset(dataset)).toMatchObject({ id: 'weekly_submission', version: '1' });
    expect(() => validateSemanticDataset({ ...dataset, rows: [...rows, { ...rows[0], revision: 3 }] })).toThrow(expect.objectContaining({ code: 'semantic_grain_duplicate' }));
    expect(() => validateSemanticDataset({ ...dataset, rows: [{ ...rows[0], week_no: 6 }] })).toThrow(expect.objectContaining({ code: 'semantic_value_invalid' }));
    expect(Object.isFrozen(SEMANTIC_DEFINITIONS[0].fields.status)).toBe(true);
  });
});
