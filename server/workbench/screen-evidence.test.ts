import { describe, expect, it } from 'vitest';
import { compareScreenEvidence, type ScreenQueryExpectation } from '../../workbench/screen-evidence';

const expected: ScreenQueryExpectation = {
  apiId: '11111111-1111-4111-8111-111111111111', apiVersion: 1,
  evidenceId: '22222222-2222-4222-8222-222222222222', input: { month: '2026-09' },
  plan: { time: { yearMonth: '2026-09' }, filters: [{ field: 'status', op: 'eq', value: 'PENDING_APPROVAL' }, { field: 'project_id', op: 'eq', value: '사업' }], select: ['project_id', 'status'] },
  datasetVersions: { weekly: 'a'.repeat(64) }, definitionVersions: { weekly: { id: 'weekly_submission', version: '1', hash: 'b'.repeat(64) } },
};
const actual = () => ({ datasetVersions: expected.datasetVersions, semantic: { appliedPlan: structuredClone(expected.plan), definitionVersions: expected.definitionVersions } });

describe('trusted runtime query evidence is compared with the proposal criteria', () => {
  it('matches equivalent AND filter order without ignoring selected column order', () => {
    const value = actual(); value.semantic.appliedPlan.filters = [...expected.plan.filters as unknown[]].reverse();
    expect(compareScreenEvidence(expected, value)).toBe('matched');
    value.semantic.appliedPlan.select = ['status', 'project_id'];
    expect(compareScreenEvidence(expected, value)).toBe('criteria-changed');
  });
  it('identifies another month even when the dataset version is the same', () => {
    const value = actual(); value.semantic.appliedPlan.time = { yearMonth: '2026-10' };
    expect(compareScreenEvidence(expected, value)).toBe('criteria-changed');
  });
  it('identifies changed meaning despite an unchanged public definition version', () => {
    const value = actual(); value.semantic.definitionVersions = { weekly: { id: 'weekly_submission', version: '1', hash: 'c'.repeat(64) } };
    expect(compareScreenEvidence(expected, value)).toBe('criteria-changed');
  });
  it('distinguishes a refreshed data copy from changed query criteria', () => {
    expect(compareScreenEvidence(expected, { ...actual(), datasetVersions: { weekly: 'd'.repeat(64) } })).toBe('data-updated');
  });
  it('never treats missing provenance as verified', () => {
    expect(compareScreenEvidence(expected, {})).toBe('unverified');
    expect(compareScreenEvidence(expected, { semantic: { appliedPlan: expected.plan } })).toBe('unverified');
  });
});
