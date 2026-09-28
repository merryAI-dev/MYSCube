import { describe, expect, it } from 'vitest';
import { compileTableQuery, buildTableQueryGuide } from './table-query.mjs';
import { compileAnalyticsPlan } from './analytics-plan.mjs';
import { compileSemanticQuery } from './semantic-query.mjs';
import { executeAnalyticsQuery } from './analytics-engine.mjs';
import { SEMANTIC_DEFINITIONS } from './semantic-catalog.mjs';
import { validateReactScreenBindings } from './react-screen-bindings.mjs';

const schema = [
  { name: 'id', type: 'string' }, { name: 'status', type: 'string' }, { name: 'name', type: 'string' },
  { name: 'contract_end', type: 'date' }, { name: 'updated_at', type: 'timestamp' }, { name: 'budget', type: 'decimal', scale: 0 },
];
const item = () => ({ datasetId: 'copied_projects', version: 'a'.repeat(64), sourceRevision: 'synthetic-v1', tableQuery: { schemaVersion: 1 }, schema: structuredClone(schema) });
const rows = [
  { id: 'a', status: 'RAW', name: '합성 A', contract_end: '2026-09-30', updated_at: '2026-09-30T14:59:59Z', budget: '0' },
  { id: 'b', status: 'RAW', name: '', contract_end: '2026-10-01', updated_at: '2026-09-30T15:00:00Z', budget: null },
  { id: 'c', status: null, name: "' OR 1=1 --", contract_end: null, updated_at: null, budget: '10' },
];
const plan = (extra = {}) => ({ kind: 'table', datasetId: 'copied_projects', select: ['id'], ...extra });
const compile = value => compileTableQuery({ plan: value, catalogItems: [item()] });
const run = async value => {
  const compiled = compile(value);
  const result = await executeAnalyticsQuery({ sql: compiled.sql, datasets: [{ datasetId: 'copied_projects', schema, rows }] });
  return { ...result, compiled };
};

describe('schema-bound table plans preserve stored values without defining business meaning', () => {
  it('derives guide fields from the enabled physical schema and never exposes unknown datasets', () => {
    const first = item();
    const guide = buildTableQueryGuide({ catalogItems: [first, { ...item(), datasetId: 'disabled', tableQuery: undefined }, { ...item(), datasetId: 'semantic', semanticDefinitionId: 'weekly_submission' }] });
    expect(guide.datasets.map(value => value.datasetId)).toEqual(['copied_projects']);
    expect(guide.datasets[0].fields.map(field => field.name)).toEqual(schema.map(field => field.name));
    first.schema.push({ name: 'approved_extra', type: 'boolean' });
    const changed = buildTableQueryGuide({ catalogItems: [first] });
    expect(changed.datasets[0].fields.at(-1)).toMatchObject({ name: 'approved_extra', operators: ['eq', 'ne', 'in', 'not_in', 'is_null', 'is_not_null'] });
    expect(changed.datasets[0].definitionHash).not.toBe(guide.datasets[0].definitionHash);
  });
  it('retains original semantic compilation byte for byte', () => {
    const definition = SEMANTIC_DEFINITIONS[0];
    const legacy = { datasetId: 'weekly', version: 'b'.repeat(64), semanticDefinitionId: definition.id, semanticDefinitionVersion: definition.version, schema: Object.values(definition.fields).filter((field, index, all) => all.findIndex(other => other.physicalColumn === field.physicalColumn) === index).map(field => ({ name: field.physicalColumn, type: field.type })) };
    const input = { plan: { datasetId: 'weekly', definitionVersion: '1', select: ['project_id', 'status'], time: { yearMonth: '2026-09', weekScope: 'all' } }, catalogItems: [legacy] };
    expect(compileAnalyticsPlan(input)).toEqual(compileSemanticQuery(input));
    expect(() => compileAnalyticsPlan({ ...input, plan: { ...input.plan, kind: 'table' } })).toThrow();
  });
  it('treats allowed prototype-like column names as data when deriving labels', () => {
    const source = item(); source.schema.push({ name: 'constructor', type: 'string' });
    expect(compileTableQuery({ plan: plan({ select: ['constructor'] }), catalogItems: [source] }).columnLabels).toEqual({ constructor: 'constructor' });
  });
  it.each([
    plan({ sql: 'SELECT * FROM secrets' }), plan({ select: ['not_approved'] }), plan({ select: ['Status'] }), plan({ select: ['id;drop'] }),
    plan({ aggregate: { op: 'count_rows' } }), plan({ select: undefined, aggregate: { op: 'sum', field: 'budget' } }),
    plan({ select: undefined, aggregate: { op: 'count_rows', field: 'id' } }), plan({ select: undefined, aggregate: { op: 'count_distinct' } }),
    plan({ select: undefined, aggregate: { op: 'count_rows' }, distinct: false }), plan({ groupBy: ['status'] }),
    plan({ select: ['id', 'id'] }), plan({ orderBy: [{ field: 'status', direction: 'asc' }] }), plan({ limit: 501 }),
    plan({ filters: [{ field: 'status', op: 'gt', value: 'RAW' }] }), plan({ filters: [{ field: 'budget', op: 'eq', value: 0 }] }),
    plan({ filters: [{ field: 'contract_end', op: 'eq', value: '2026-02-30' }] }), plan({ filters: [{ field: 'updated_at', op: 'eq', value: '2026-09-30T15:00:00+09:00' }] }),
    plan({ filters: [{ field: 'name', op: 'eq', value: null }] }), plan({ filters: [{ field: 'name', op: 'is_null', value: '' }] }),
    plan({ filters: [{ field: 'name', op: 'in', value: 'RAW' }] }), plan({ filters: [{ field: 'name', op: 'eq', value: ['RAW'] }] }),
    plan({ joins: ['other'] }), plan({ time: { yearMonth: '2026-09' } }),
  ])('rejects invalid or unapproved plans without SQL fallback (%#)', value => expect(() => compile(value)).toThrow());
  it.each([
    value => { delete value.tableQuery; }, value => { value.tableQuery.schemaVersion = 2; },
    value => { value.semanticDefinitionId = 'weekly_submission'; }, value => { value.semanticDefinitionVersion = '1'; },
    value => { value.schema.push(value.schema[0]); }, value => { value.schema[0].name = 'ID'; },
    value => { delete value.schema.at(-1).scale; }, value => { value.schema[0].scale = 0; },
    value => { value.version = 'not-a-pin'; },
  ])('rejects disabled, ambiguous, malformed or unversioned schemas (%#)', mutate => {
    const value = item(); mutate(value);
    expect(() => compileTableQuery({ plan: plan(), catalogItems: [value] })).toThrow();
    expect(buildTableQueryGuide({ catalogItems: [value] }).datasets).toEqual([]);
  });
  it('executes an SQL-looking value as one literal and preserves null, empty and zero', async () => {
    const injected = await run(plan({ select: ['id', 'name'], filters: [{ field: 'name', op: 'eq', value: "' OR 1=1 --" }] }));
    expect(injected.rows).toEqual([{ id: 'c', name: "' OR 1=1 --" }]);
    expect(injected.compiled.sql).toContain("''' OR 1=1 --'");
    expect((await run(plan({ select: ['id', 'budget'], orderBy: [{ field: 'id', direction: 'asc' }] }))).rows).toEqual([{ id: 'a', budget: '0' }, { id: 'b', budget: null }, { id: 'c', budget: '10' }]);
    expect((await run(plan({ filters: [{ field: 'name', op: 'eq', value: '' }] }))).rows).toEqual([{ id: 'b' }]);
    expect((await run(plan({ filters: [{ field: 'status', op: 'is_null' }] }))).rows).toEqual([{ id: 'c' }]);
  });
  it('executes generic row grouping and distinct counts without converting status meanings', async () => {
    const groups = await run(plan({ select: undefined, aggregate: { op: 'count_rows' }, groupBy: ['status'], orderBy: [{ field: 'status', direction: 'asc' }] }));
    expect(groups.rows).toEqual([{ status: 'RAW', row_count: '2' }, { status: null, row_count: '1' }]);
    expect((await run(plan({ select: undefined, aggregate: { op: 'count_distinct', field: 'status' } }))).rows).toEqual([{ distinct_count: '1', missing_count: '1' }]);
    expect((await run(plan({ select: ['status'], distinct: true, orderBy: [{ field: 'status', direction: 'asc' }] }))).rows).toEqual([{ status: 'RAW' }, { status: null }]);
    expect(groups.compiled).toMatchObject({ kind: 'table', definitionVersions: { copied_projects: { id: 'stored_table', version: '1' } } });
  });
  it('executes exact date and UTC timestamp boundaries without inventing a business month', async () => {
    expect((await run(plan({ filters: [{ field: 'contract_end', op: 'gte', value: '2026-09-01' }, { field: 'contract_end', op: 'lt', value: '2026-10-01' }] }))).rows).toEqual([{ id: 'a' }]);
    expect((await run(plan({ filters: [{ field: 'updated_at', op: 'gte', value: '2026-09-30T15:00:00Z' }] }))).rows).toEqual([{ id: 'b' }]);
  });
  it('uses the same typed authority for registered API and screen evidence', () => {
    const compiled = compile(plan());
    const apiId = '11111111-1111-4111-8111-111111111111', evidenceId = '22222222-2222-4222-8222-222222222222';
    const input = { bindings: [{ apiId, apiVersion: 1, input: {}, evidenceId }], apis: [{ id: apiId, version: 1, definition: { kind: 'analytics-copy', parameters: {}, plan: plan() } }], catalog: { items: [item()] }, evidence: [{ evidenceId, datasetVersions: compiled.datasetVersions, semantic: compiled }] };
    expect(validateReactScreenBindings(input)[0]).toMatchObject({ plan: { kind: 'table' }, definitionVersions: compiled.definitionVersions, datasetVersions: compiled.datasetVersions });
    input.catalog.items[0].schema[0].type = 'integer';
    expect(() => validateReactScreenBindings(input)).toThrow(expect.objectContaining({ code: 'react_screen_binding_mismatch' }));
  });
});
