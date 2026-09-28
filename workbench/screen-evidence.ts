import type * as z from 'zod/v4';
import type { ScreenQueryExpectationSchema } from '../shared/workbench-screen-bindings.mjs';
export type ScreenQueryExpectation = z.infer<typeof ScreenQueryExpectationSchema>;

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);

export function queryPlanIdentity(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const plan = value as Record<string, unknown>;
  return canonical({ ...plan, filters: Array.isArray(plan.filters) ? [...plan.filters].sort((a, b) => canonical(a).localeCompare(canonical(b))) : [] });
}

export function compareScreenEvidence(expected: ScreenQueryExpectation, actual: { kind?: string; apiId?: string; apiVersion?: number; definitionHash?: string; endpointHash?: string; input?: unknown; datasetVersions?: unknown; semantic?: { appliedPlan?: unknown; definitionVersions?: unknown } }) {
  if (expected.plan.kind === 'external-read') {
    if (actual.kind !== 'registered-api' || !actual.definitionHash || !actual.endpointHash || !actual.input) return 'unverified';
    return actual.apiId === expected.apiId && actual.apiVersion === expected.apiVersion && actual.definitionHash === expected.plan.definitionHash
      && actual.endpointHash === expected.plan.endpointHash && canonical(actual.input) === canonical(expected.input) ? 'matched' : 'criteria-changed';
  }
  if (!actual.semantic?.appliedPlan || !actual.semantic.definitionVersions || !actual.datasetVersions) return 'unverified';
  if (queryPlanIdentity(expected.plan) !== queryPlanIdentity(actual.semantic.appliedPlan)
    || canonical(expected.definitionVersions) !== canonical(actual.semantic.definitionVersions)) return 'criteria-changed';
  return canonical(expected.datasetVersions) === canonical(actual.datasetVersions) ? 'matched' : 'data-updated';
}
