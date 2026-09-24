import { describe, expect, it } from 'vitest';
import { compileSemanticQuery } from './semantic-query.mjs';
import { validateReactScreenBindings } from './react-screen-bindings.mjs';

const apiId = '11111111-1111-4111-8111-111111111111';
const evidenceId = '22222222-2222-4222-8222-222222222222';
const schema = ['project_id:string', 'year_month:string', 'week_no:integer', 'status:string', 'revision:integer', 'submitted_at:timestamp', 'approved_at:timestamp', 'health:string'].map((pair) => {
  const [name, type] = pair.split(':'); return { name, type };
});
const item = { datasetId: 'weekly_submission', semanticDefinitionId: 'weekly_submission', semanticDefinitionVersion: '1', version: 'a'.repeat(64), schema };
const plan = { datasetId: item.datasetId, definitionVersion: '1', select: ['project_id', 'status'], time: { yearMonth: '2026-09', weekScope: 'all' },
  filters: [{ field: 'project_id', op: 'eq', value: '합성 사업' }, { field: 'status', op: 'eq', value: 'PENDING_APPROVAL' }] };
function fixture() {
  const semantic = compileSemanticQuery({ plan, catalogItems: [item] });
  return {
    bindings: [{ apiId, apiVersion: 2, input: { month: '2026-09' }, evidenceId }],
    apis: [{ id: apiId, version: 2, definition: { kind: 'analytics-copy', parameters: { month: { type: 'string', required: true, label: '정산 월' } }, plan: { ...plan, time: { ...plan.time, yearMonth: { $input: 'month' } } } } }],
    catalog: { items: [structuredClone(item)] },
    evidence: [{ evidenceId, semantic, datasetVersions: semantic.datasetVersions, rows: [{ project_id: '합성 사업', status: 'PENDING_APPROVAL' }] }],
  };
}
describe('React screen connections preserve the actual query meaning', () => {
  it('returns verified API inputs and semantic identity without copying result rows', () => {
    const result = validateReactScreenBindings(fixture());
    expect(result[0]).toMatchObject({ apiId, apiVersion: 2, input: { month: '2026-09' }, evidenceId, datasetVersions: { weekly_submission: 'a'.repeat(64) } });
    expect(result[0]).not.toHaveProperty('rows');
  });
  it('accepts equivalent AND filter ordering but preserves displayed column ordering', () => {
    const value = fixture(); value.apis[0].definition.plan.filters = [...plan.filters].reverse();
    expect(validateReactScreenBindings(value)).toHaveLength(1);
    value.apis[0].definition.plan.select = [...plan.select].reverse();
    expect(() => validateReactScreenBindings(value)).toThrow(expect.objectContaining({ code: 'react_screen_binding_mismatch' }));
  });
  it.each([
    (value) => { value.bindings[0].input.month = '2026-10'; },
    (value) => { value.bindings[0].apiVersion = 3; },
    (value) => { value.bindings[0].evidenceId = apiId; },
    (value) => { value.catalog.items[0].version = 'b'.repeat(64); },
    (value) => { value.evidence[0].semantic.definitionVersions.weekly_submission.hash = 'b'.repeat(64); },
    (value) => { value.apis[0].definition.plan.limit = 3; },
    (value) => { value.apis[0].definition.kind = 'external-read'; },
    (value) => { value.bindings.push(value.bindings[0]); },
  ])('rejects incompatible evidence, API scope, meaning or revision before generating source', (mutate) => {
    const value = fixture(); mutate(value);
    expect(() => validateReactScreenBindings(value)).toThrow(expect.objectContaining({ code: 'react_screen_binding_mismatch' }));
  });
  it('rejects unknown API parameters instead of dropping them', () => {
    const value = fixture(); value.bindings[0].input.secret = 'not-allowed';
    expect(() => validateReactScreenBindings(value)).toThrow(expect.objectContaining({ code: 'registered_api_input_invalid' }));
  });
});
