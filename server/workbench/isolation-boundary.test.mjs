import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('legacy service has no Workbench execution dependency', () => {
  it('keeps Workbench routes, admission and response persistence out of the legacy BFF', () => {
    const app = source('server/bff/app.mjs');
    for (const module of [
      'workbench-admission', 'workbench-assistant', 'personal-work-pages',
      'cashflow-evidence-query', 'insight-cashflow-report', 'qa-evidence',
      'reliability-service', 'reliability-middleware',
    ]) expect(app.includes(`./${module}.mjs`), `Legacy BFF must not load ${module}`).toBe(false);
    for (const symbol of [
      'mountWorkbenchAssistantRoutes', 'mountPersonalWorkPageRoutes', 'mountCashflowEvidenceRoutes',
      'mountInsightCashflowReport', 'mountQaEvidenceRoutes', 'mountReliabilityRoutes',
      'createReliabilityService', 'reliabilityResponseMiddleware', 'workbenchAdmissionMiddleware',
    ]) expect(app.includes(symbol), `Legacy BFF must not execute ${symbol}`).toBe(false);
    expect(/(?:from\s*|import\s*\()\s*['"][^'"]*\/workbench\//.test(app)).toBe(false);
    // Existing request-log classification is allowed: it does not call the new service.
  });

  it.each([
    'src/app/platform/api-client.ts',
    'src/app/components/layout/AppLayout.tsx',
    'src/app/components/portal/PortalLayout.tsx',
  ])('does not collect or flush Workbench observations from %s', (path) => {
    const text = source(path);
    expect(/operation-observations|enqueueOperationObservation|flushOperationObservations|useObservationRetry/.test(text)).toBe(false);
    expect(text.includes('/product-operations/observations')).toBe(false);
  });

  it.each([
    '.github/workflows/production-deploy.yml',
    'scripts/deploy-vercel-production-candidate.mjs',
  ])('deploys the legacy service without Workbench flags, credentials or gates: %s', (path) => {
    const text = source(path);
    expect(/PRODUCT_WORKBENCH_|WORKBENCH_GEMINI_API_KEY|WORKBENCH_MODEL_PROJECT_ID|WORKBENCH_BASELINE_HOST/.test(text)).toBe(false);
    expect(text.includes('verify-workbench-isolation')).toBe(false);
    expect(/Verify Workbench isolation/i.test(text)).toBe(false);
  });
});

describe('standalone Workbench startup fails closed at resource boundaries', () => {
  let resolveWorkbenchRuntime;
  beforeAll(async () => {
    ({ resolveWorkbenchRuntime } = await import('./runtime-config.mjs'));
  });
  const valid = () => ({
    WORKBENCH_PROJECT_ID: 'isolated-axr-data',
    PRODUCTION_PROJECT_ID: 'existing-business-project',
    WORKBENCH_MODEL_PROJECT_ID: 'isolated-axr-model',
    PRODUCTION_MODEL_PROJECT_ID: 'existing-settlement-model',
    WORKBENCH_AI_ENABLED: 'false',
  });

  it('accepts explicit independent projects without requiring a model key while AI is disabled', () => {
    expect(resolveWorkbenchRuntime(valid())).toMatchObject({
      projectId: 'isolated-axr-data', productionProjectId: 'existing-business-project',
      modelProjectId: 'isolated-axr-model', productionModelProjectId: 'existing-settlement-model',
    });
  });

  it.each(['WORKBENCH_PROJECT_ID', 'PRODUCTION_PROJECT_ID', 'WORKBENCH_MODEL_PROJECT_ID', 'PRODUCTION_MODEL_PROJECT_ID'])('requires explicit %s rather than falling back to ambient credentials', (key) => {
    const env = valid(); delete env[key];
    expect(() => resolveWorkbenchRuntime(env)).toThrow();
    expect(() => resolveWorkbenchRuntime({ ...valid(), [key]: '   ' })).toThrow();
  });

  it('rejects the production database even when a different model project is configured', () => {
    expect(() => resolveWorkbenchRuntime({ ...valid(), WORKBENCH_PROJECT_ID: valid().PRODUCTION_PROJECT_ID })).toThrow();
    expect(() => resolveWorkbenchRuntime({ ...valid(), WORKBENCH_PROJECT_ID: ` ${valid().PRODUCTION_PROJECT_ID} ` })).toThrow();
  });

  it('rejects shared model quota even when the database and API key differ', () => {
    expect(() => resolveWorkbenchRuntime({ ...valid(), WORKBENCH_MODEL_PROJECT_ID: valid().PRODUCTION_MODEL_PROJECT_ID,
      WORKBENCH_GEMINI_API_KEY: 'fixture-distinct-key' })).toThrow();
  });

  it.each([
    ['SETTLEMENT_AGENT_GEMINI_API_KEY', 'fixture-legacy-key'],
    ['JVM_WEEKLY_API_BASE_URL', 'https://legacy-jvm.invalid'],
  ])('rejects inherited legacy connectivity %s even when new AI is disabled', (key, value) => {
    expect(() => resolveWorkbenchRuntime({ ...valid(), [key]: value })).toThrow();
  });

  it('requires an independent key only when model execution is enabled', () => {
    expect(() => resolveWorkbenchRuntime({ ...valid(), WORKBENCH_AI_ENABLED: 'true' })).toThrow();
    expect(resolveWorkbenchRuntime({ ...valid(), WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'fixture-independent-key' }))
      .toMatchObject({ modelProjectId: 'isolated-axr-model' });
  });
});
