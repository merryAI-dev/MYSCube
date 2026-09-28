import { describe, expect, it } from 'vitest';
import { validateExistingWorkbenchCandidate } from './validate-candidate.mjs';
const approved = { WORKBENCH_SERVICE: 'myscube-axr-workbench', WORKBENCH_PROJECT_ID: 'demo-workbench', WORKBENCH_MODEL_PROJECT_ID: 'demo-workbench-model', PRODUCTION_PROJECT_ID: 'demo-business', PRODUCTION_MODEL_PROJECT_ID: 'demo-business-model', WORKBENCH_AUTH_PROJECT_ID: 'demo-identity', WORKBENCH_AUTH_API_KEY: 'synthetic-key-at-least-twenty', WORKBENCH_AUTH_DOMAIN: 'demo-identity.firebaseapp.com' };
function service(overrides = {}) { return { metadata: { name: approved.WORKBENCH_SERVICE }, spec: { template: { spec: { containers: [{ env: Object.entries({ ...approved, WORKBENCH_TENANT_ID: 'qa', WORKBENCH_AI_ENABLED: 'false', ...overrides }).filter(([key]) => !['WORKBENCH_SERVICE', 'WORKBENCH_AUTH_API_KEY', 'WORKBENCH_AUTH_DOMAIN'].includes(key)).map(([name, value]) => ({ name, value })) }] } } } }; }
describe('existing Cloud Run candidate read-only preflight', () => {
  it('accepts consistent pre-existing settings without exposing values or creating configuration', () => {
    const original = service(); const before = JSON.stringify(original); const result = validateExistingWorkbenchCandidate(original, approved);
    expect(result).toEqual({ ready: true, existingServiceVerified: true, runtimeConfigurationValidated: true, authConfigurationValidated: true }); expect(JSON.stringify(original)).toBe(before); expect(JSON.stringify(result)).not.toContain('synthetic-key');
  });
  it('rejects missing frontend settings, invalid auth domain and server/frontend identity mismatch', () => {
    for (const key of ['WORKBENCH_AUTH_API_KEY','WORKBENCH_AUTH_PROJECT_ID','WORKBENCH_AUTH_DOMAIN']) expect(() => validateExistingWorkbenchCandidate(service(), { ...approved, [key]: '' })).toThrow();
    expect(() => validateExistingWorkbenchCandidate(service(), { ...approved, WORKBENCH_AUTH_DOMAIN: 'https://wrong.test/path' })).toThrow();
    expect(() => validateExistingWorkbenchCandidate(service({ WORKBENCH_AUTH_PROJECT_ID: 'demo-other-identity' }), approved)).toThrow();
  });
  it('rejects missing server identifiers, production sharing, wrong service and duplicate environment names', () => {
    expect(() => validateExistingWorkbenchCandidate(service({ WORKBENCH_PROJECT_ID: '' }), approved)).toThrow();
    expect(() => validateExistingWorkbenchCandidate(service({ WORKBENCH_PROJECT_ID: approved.PRODUCTION_PROJECT_ID }), { ...approved, WORKBENCH_PROJECT_ID: approved.PRODUCTION_PROJECT_ID })).toThrow();
    expect(() => validateExistingWorkbenchCandidate({ ...service(), metadata: { name: 'production-api' } }, approved)).toThrow();
    const duplicate = service(); duplicate.spec.template.spec.containers[0].env.push({ name: 'WORKBENCH_TENANT_ID', value: 'second' }); expect(() => validateExistingWorkbenchCandidate(duplicate, approved)).toThrow();
  });
  it('rejects emulator, forbidden credentials and unsupported Cloud Run React activation', () => {
    for (const values of [{ WORKBENCH_AUTH_MODE: 'emulator' }, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, { JVM_WEEKLY_INTERNAL_API_TOKEN: '' }, { WORKBENCH_REMOTE_RUNTIME_ENABLED: 'true' }, { WORKBENCH_REACT_RUNTIME_URL: 'https://runtime.test/runtime' }]) expect(() => validateExistingWorkbenchCandidate(service(values), approved)).toThrow();
  });
  it('refuses a host-only listener configuration on Cloud Run', () => {
    expect(() => validateExistingWorkbenchCandidate(service({ WORKBENCH_BIND_HOST: '127.0.0.1' }), approved)).toThrow();
    expect(validateExistingWorkbenchCandidate(service({ WORKBENCH_BIND_HOST: '0.0.0.0' }), approved).ready).toBe(true);
  });
  it('checks dedicated model credential presence without reading or printing an existing secret reference', () => {
    expect(() => validateExistingWorkbenchCandidate(service({ WORKBENCH_AI_ENABLED: 'true' }), approved)).toThrow();
    const configured = service({ WORKBENCH_AI_ENABLED: 'true' }); configured.spec.template.spec.containers[0].env.push({ name: 'WORKBENCH_GEMINI_API_KEY', valueFrom: { secretKeyRef: { name: 'existing-dedicated-model', key: 'latest' } } });
    expect(validateExistingWorkbenchCandidate(configured, approved).ready).toBe(true);
  });
});
