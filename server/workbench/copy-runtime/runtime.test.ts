import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createCopyDeploymentPlan } from './plan.mjs';
import { validateCopyEnvironment, runCopyChild } from './runtime.mjs';

const env = { WORKBENCH_PROJECT_ID: 'demo-copy-runtime', PRODUCTION_PROJECT_ID: 'demo-copy-source', WORKBENCH_MODEL_PROJECT_ID: 'demo-copy-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-existing-model',
  WORKBENCH_TENANT_ID: 'synthetic', WORKBENCH_COPY_SOURCE_PROJECT_ID: 'demo-copy-source', WORKBENCH_COPY_DATASET_GRANTS: '{}', WORKBENCH_AI_ENABLED: 'false', WORKBENCH_COPY_ENABLED: 'true', WORKBENCH_COPY_SOURCE_READ_APPROVED: 'true',
  CLOUD_RUN_JOB: 'axr-copy-worker', CLOUD_RUN_EXECUTION: 'axr-copy-worker-abc', CLOUD_RUN_TASK_COUNT: '1', CLOUD_RUN_TASK_INDEX: '0', CLOUD_RUN_TASK_ATTEMPT: '0' };
const plan = { projectId: env.WORKBENCH_PROJECT_ID, productionProjectId: env.PRODUCTION_PROJECT_ID, modelProjectId: env.WORKBENCH_MODEL_PROJECT_ID, productionModelProjectId: env.PRODUCTION_MODEL_PROJECT_ID, region: 'asia-northeast3', tenantId: 'synthetic', image: `asia-northeast3-docker.pkg.dev/demo-copy-runtime/releases/workbench@sha256:${'a'.repeat(64)}`, grants: {}, sourceReadApproved: false };

describe('dedicated scheduled copy contract', () => {
  it('passes only the bounded copy environment to its fixed worker', () => {
    const parsed = validateCopyEnvironment({ ...env, UNRELATED_VALUE: 'do-not-forward' });
    expect(parsed.enabled).toBe(true);
    expect(parsed.childEnvironment).not.toHaveProperty('UNRELATED_VALUE');
    expect(parsed.childEnvironment).not.toHaveProperty('CLOUD_RUN_EXECUTION');
    expect(Object.isFrozen(parsed.childEnvironment)).toBe(true);
  });
  it('requires source approval independently of copy enablement', () => {
    expect(validateCopyEnvironment({ ...env, WORKBENCH_COPY_SOURCE_READ_APPROVED: 'false' }).enabled).toBe(false);
    expect(validateCopyEnvironment({ ...env, WORKBENCH_COPY_ENABLED: 'false' }).enabled).toBe(false);
  });
  it.each(['GOOGLE_APPLICATION_CREDENTIALS', 'FIRESTORE_EMULATOR_HOST', 'NODE_OPTIONS', 'WORKBENCH_GEMINI_API_KEY', 'WORKBENCH_GITHUB_APP_PRIVATE_KEY'])('rejects credentials or overrides: %s', name => {
    expect(() => validateCopyEnvironment({ ...env, [name]: 'forbidden' })).toThrow();
  });
  it('rejects source swaps, multi-task jobs and malformed grants', () => {
    for (const patch of [{ WORKBENCH_COPY_SOURCE_PROJECT_ID: 'demo-other' }, { CLOUD_RUN_TASK_COUNT: '2' }, { CLOUD_RUN_TASK_ATTEMPT: '1' }, { WORKBENCH_COPY_DATASET_GRANTS: '[]' }, { WORKBENCH_COPY_DATASET_GRANTS: '{"actor":["../all"]}' }]) expect(() => validateCopyEnvironment({ ...env, ...patch })).toThrow();
  });
  it('prints disabled preparation and withholds activation without source approval', () => {
    const output = createCopyDeploymentPlan(plan);
    expect(JSON.parse(output.environmentFile.content).WORKBENCH_COPY_ENABLED).toBe('false');
    expect(output.prepare[0]).toContain("'--task-timeout=100s'");
    expect(output.prepare[0]).toContain("'--args=server/workbench/copy-runtime/run.mjs'");
    expect(output.prepare[0]).not.toContain('--execute-now');
    expect(output.activation.join()).not.toContain('gcloud');
    const approved = createCopyDeploymentPlan({ ...plan, sourceReadApproved: true });
    expect(approved.activation.join()).toContain("'--schedule=*/2 * * * *'");
    expect(approved.activation.join()).toContain('--oauth-service-account-email=axr-copy-scheduler@');
    expect(approved.activation.join()).toContain('--max-retry-attempts=0');
    expect(approved.activation.join()).not.toContain('oidc');
  });
  it('rejects mutable images, secrets and wrong project image references', () => {
    for (const patch of [{ image: plan.image.replace(/@.*/, ':latest') }, { image: plan.image.replace('demo-copy-runtime', 'another-project') }, { secret: 'bad' }]) expect(() => createCopyDeploymentPlan({ ...plan, ...patch })).toThrow();
  });
  it('waits for actual child close after TERM and KILL', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    let finished = false;
    const pending = runCopyChild({ env: {}, spawnChild: () => child, limits: { workerMs: 10, killGraceMs: 10, closeGraceMs: 100 } }).then(result => { finished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(child.kill.mock.calls.map(args => args[0])).toEqual(['SIGTERM', 'SIGKILL']);
    expect(finished).toBe(false);
    child.emit('close', null, 'SIGKILL');
    expect(await pending).toEqual({ outcome: 'timeout', childClosed: true });
  });
  it('does not claim child termination if kill has not produced close', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    expect(await runCopyChild({ env: {}, spawnChild: () => child, limits: { workerMs: 5, killGraceMs: 5, closeGraceMs: 5 } })).toEqual({ outcome: 'termination_unconfirmed', childClosed: false });
  });
  it('does not spawn an already cancelled task, and handles synchronous spawn failure', async () => {
    const spawnChild = vi.fn(() => { throw new Error('private detail'); });
    expect(await runCopyChild({ env: {}, signal: AbortSignal.abort(), spawnChild })).toEqual({ outcome: 'cancelled', childClosed: true });
    expect(spawnChild).not.toHaveBeenCalled();
    expect(await runCopyChild({ env: {}, spawnChild })).toEqual({ outcome: 'spawn_failed', childClosed: true });
  });
  it('keeps the existing worker single-process, one-pass and bounded', async () => {
    const worker = await readFile(new URL('../copy-worker.mjs', import.meta.url), 'utf8');
    const feed = await readFile(new URL('../copy-feed.mjs', import.meta.url), 'utf8');
    expect(worker).not.toMatch(/child_process|spawn\(|fork\(|exec\(/);
    expect(worker).toContain("['client_error_events', 'reliability_operations']");
    expect(feed).toContain(".select('role', 'status').limit(201)");
    expect(feed).toContain('query.limit(100).get(), sweep.limit(100).get()');
  });
});
