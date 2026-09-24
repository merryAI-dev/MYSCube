import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveWorkbenchRuntime } from '../runtime-config.mjs';

export const COPY_RUNTIME_LIMITS = Object.freeze({ workerMs: 75000, killGraceMs: 2000, closeGraceMs: 3000, scheduleWindowMs: 120000, minimumBackoffMs: 120000, maximumBackoffMs: 480000 });
const id = /^[a-zA-Z0-9_-]{1,128}$/;
const datasetId = /^[a-z][a-z0-9_]{0,62}$/;
const workerPath = fileURLToPath(new URL('../copy-worker.mjs', import.meta.url));
const environmentNames = ['WORKBENCH_PROJECT_ID', 'PRODUCTION_PROJECT_ID', 'WORKBENCH_MODEL_PROJECT_ID', 'PRODUCTION_MODEL_PROJECT_ID', 'WORKBENCH_TENANT_ID', 'WORKBENCH_COPY_SOURCE_PROJECT_ID', 'WORKBENCH_COPY_DATASET_GRANTS', 'WORKBENCH_COPY_ENABLED', 'WORKBENCH_COPY_SOURCE_READ_APPROVED', 'WORKBENCH_AI_ENABLED'];

export function validateCopyEnvironment(env, { executionRequired = true } = {}) {
  const runtime = resolveWorkbenchRuntime(env);
  if (env.WORKBENCH_AI_ENABLED !== 'false' || !id.test(env.WORKBENCH_TENANT_ID || '')
    || env.WORKBENCH_COPY_SOURCE_PROJECT_ID !== runtime.productionProjectId
    || !['true', 'false'].includes(env.WORKBENCH_COPY_ENABLED)
    || !['true', 'false'].includes(env.WORKBENCH_COPY_SOURCE_READ_APPROVED)) throw new Error('Invalid dedicated copy configuration.');
  for (const name of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'NODE_OPTIONS', 'WORKBENCH_GEMINI_API_KEY', 'WORKBENCH_GIT_TOKEN', 'WORKBENCH_GITHUB_APP_PRIVATE_KEY', 'GOOGLE_API_KEY']) {
    if (env[name]) throw new Error('Credentials or runtime overrides are forbidden in the copy job.');
  }
  if (typeof env.WORKBENCH_COPY_DATASET_GRANTS !== 'string' || Buffer.byteLength(env.WORKBENCH_COPY_DATASET_GRANTS) > 32000) throw new Error('Explicit bounded dataset grants are required.');
  const grants = JSON.parse(env.WORKBENCH_COPY_DATASET_GRANTS);
  if (!grants || typeof grants !== 'object' || Array.isArray(grants) || Object.keys(grants).length > 200) throw new Error('Invalid dataset grants.');
  for (const [actor, datasets] of Object.entries(grants)) {
    if (!id.test(actor) || !Array.isArray(datasets) || datasets.length > 20 || !datasets.every(value => typeof value === 'string' && datasetId.test(value)) || new Set(datasets).size !== datasets.length) throw new Error('Invalid dataset grants.');
  }
  if (executionRequired && (!id.test(env.CLOUD_RUN_EXECUTION || '') || !id.test(env.CLOUD_RUN_JOB || '') || env.CLOUD_RUN_TASK_COUNT !== '1' || env.CLOUD_RUN_TASK_INDEX !== '0' || env.CLOUD_RUN_TASK_ATTEMPT !== '0')) throw new Error('One non-retrying Cloud Run task is required.');
  const childEnvironment = Object.fromEntries(environmentNames.map(name => [name, env[name]]));
  Object.assign(childEnvironment, { NODE_ENV: 'production', PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', TMPDIR: '/tmp' });
  return Object.freeze({ ...runtime, tenantId: env.WORKBENCH_TENANT_ID, executionId: env.CLOUD_RUN_EXECUTION || null, jobName: env.CLOUD_RUN_JOB || null,
    enabled: env.WORKBENCH_COPY_ENABLED === 'true' && env.WORKBENCH_COPY_SOURCE_READ_APPROVED === 'true', childEnvironment: Object.freeze(childEnvironment) });
}

export function runCopyChild({ env, signal, spawnChild = spawn, limits = COPY_RUNTIME_LIMITS }) {
  const workerMs = Math.min(limits.workerMs, COPY_RUNTIME_LIMITS.workerMs), killGraceMs = Math.min(limits.killGraceMs, COPY_RUNTIME_LIMITS.killGraceMs), closeGraceMs = Math.min(limits.closeGraceMs, COPY_RUNTIME_LIMITS.closeGraceMs);
  if (![workerMs, killGraceMs, closeGraceMs].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid copy deadline.');
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ outcome: 'cancelled', childClosed: true });
    let child, reason = null, stopping = false, settled = false, deadline, killTimer, closeTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      for (const timer of [deadline, killTimer, closeTimer]) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const stop = (value) => {
      if (stopping || settled) return;
      stopping = true;
      reason ||= value;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        closeTimer = setTimeout(() => finish({ outcome: 'termination_unconfirmed', childClosed: false }), closeGraceMs);
      }, killGraceMs);
    };
    const abort = () => stop('cancelled');
    try {
      child = spawnChild(process.execPath, [workerPath], { env, stdio: ['ignore', 'ignore', 'ignore'], shell: false });
    } catch { return finish({ outcome: 'spawn_failed', childClosed: true }); }
    child.once('error', () => { reason ||= 'spawn_failed'; });
    child.once('close', (code) => finish({ outcome: reason || (code === 0 ? 'complete' : 'worker_failed'), childClosed: true }));
    signal?.addEventListener('abort', abort, { once: true });
    deadline = setTimeout(() => stop('timeout'), workerMs);
    if (signal?.aborted) abort();
  });
}

export async function runScheduledCopy({ db, env, now = () => new Date().toISOString(), runWorker = runCopyChild, signal }) {
  const config = validateCopyEnvironment(env);
  if (db.projectId !== config.projectId) throw new Error('Copy lock must use the isolated target project.');
  if (!config.enabled) return { status: 'disabled', sourceReadStarted: false };
  const lock = db.doc(`orgs/${config.tenantId}/workbench_copy_runtime/scheduled`);
  const owner = randomUUID(), startedAt = now();
  const acquired = await db.runTransaction(async tx => {
    const previous = (await tx.get(lock)).data();
    if (previous && (previous.sourceProjectId !== config.productionProjectId || previous.targetProjectId !== config.projectId)) throw new Error('Copy lock project identity changed.');
    if (previous?.active) return { status: 'blocked_active', executionId: previous.executionId };
    if (previous?.notBefore && Date.parse(previous.notBefore) > Date.parse(startedAt)) return { status: 'backoff', notBefore: previous.notBefore };
    const failures = Number.isSafeInteger(previous?.consecutiveFailures) && previous.consecutiveFailures > 0 ? Math.min(previous.consecutiveFailures, 3) : 0;
    tx.set(lock, { schemaVersion: 1, owner, active: true, executionId: config.executionId, jobName: config.jobName, sourceProjectId: config.productionProjectId,
      targetProjectId: config.projectId, startedAt, consecutiveFailures: failures });
    return { status: 'acquired', failures };
  });
  if (acquired.status !== 'acquired') return { ...acquired, sourceReadStarted: false };
  let result;
  const attempted = !signal?.aborted;
  try { result = attempted ? await runWorker({ env: config.childEnvironment, signal }) : { outcome: 'cancelled', childClosed: true }; }
  catch { result = { outcome: 'termination_unconfirmed', childClosed: false }; }
  if (!result?.childClosed) return { status: 'termination_unconfirmed', sourceReadStarted: true, lockRetained: true };
  const finishedAt = now(), success = result.outcome === 'complete';
  const failures = success ? 0 : Math.min(acquired.failures + 1, 3);
  const nextWindow = (Math.floor(Date.parse(startedAt) / COPY_RUNTIME_LIMITS.scheduleWindowMs) + 1) * COPY_RUNTIME_LIMITS.scheduleWindowMs;
  const delay = Math.min(COPY_RUNTIME_LIMITS.minimumBackoffMs * 2 ** (failures - 1), COPY_RUNTIME_LIMITS.maximumBackoffMs);
  const notBefore = new Date(success ? nextWindow : Math.max(nextWindow, Date.parse(finishedAt) + delay)).toISOString();
  const released = await db.runTransaction(async tx => {
    const current = (await tx.get(lock)).data();
    if (!current?.active || current.owner !== owner) return false;
    tx.update(lock, { active: false, finishedAt, notBefore, consecutiveFailures: failures, lastOutcome: success ? 'complete' : 'failed' });
    return true;
  });
  return { status: released ? (success ? 'complete' : 'failed') : 'lock_changed', sourceReadStarted: attempted && result.outcome !== 'spawn_failed', notBefore, lockRetained: !released };
}
