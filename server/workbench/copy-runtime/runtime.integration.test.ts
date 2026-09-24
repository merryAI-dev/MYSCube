import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScheduledCopy, runCopyChild } from './runtime.mjs';
import { applyPermissionCopy, readPermissionCopy, copyLogPage } from '../copy-feed.mjs';
import { createIsolatedWorkbenchCore } from '../core.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('scheduled copy target lock with real Firestore transactions', () => {
  const db = new Firestore({ projectId: 'demo-copy-runtime' }), source = new Firestore({ projectId: 'demo-copy-source' });
  const tenantId = `copy-runtime-${randomUUID()}`, root = `orgs/${tenantId}`, lock = db.doc(`${root}/workbench_copy_runtime/scheduled`);
  let instant = '2026-09-24T01:00:00.000Z';
  const now = () => instant;
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: source.projectId, WORKBENCH_MODEL_PROJECT_ID: 'demo-copy-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-existing-model',
    WORKBENCH_TENANT_ID: tenantId, WORKBENCH_COPY_SOURCE_PROJECT_ID: source.projectId, WORKBENCH_COPY_DATASET_GRANTS: '{"synthetic-admin":["weekly_submission"]}', WORKBENCH_AI_ENABLED: 'false', WORKBENCH_COPY_ENABLED: 'true', WORKBENCH_COPY_SOURCE_READ_APPROVED: 'true',
    CLOUD_RUN_JOB: 'axr-copy-worker', CLOUD_RUN_EXECUTION: 'axr-copy-worker-aaa', CLOUD_RUN_TASK_COUNT: '1', CLOUD_RUN_TASK_INDEX: '0', CLOUD_RUN_TASK_ATTEMPT: '0' };
  beforeEach(async () => { instant = '2026-09-24T01:00:00.000Z'; await db.recursiveDelete(db.doc(root)); await source.recursiveDelete(source.doc(root)); });
  afterAll(async () => { await db.recursiveDelete(db.doc(root)); await source.recursiveDelete(source.doc(root)); await db.terminate(); await source.terminate(); });

  it('allows only one of simultaneous executions to start its source worker', async () => {
    let finish!: (value: unknown) => void;
    const runWorker = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const first = runScheduledCopy({ db, env, now, runWorker });
    await vi.waitFor(() => expect(runWorker).toHaveBeenCalledTimes(1));
    expect(await runScheduledCopy({ db, env: { ...env, CLOUD_RUN_EXECUTION: 'axr-copy-worker-bbb' }, now, runWorker })).toMatchObject({ status: 'blocked_active', sourceReadStarted: false });
    expect(runWorker).toHaveBeenCalledTimes(1);
    finish({ outcome: 'complete', childClosed: true });
    expect(await first).toMatchObject({ status: 'complete' });
    expect(await runScheduledCopy({ db, env, now, runWorker })).toMatchObject({ status: 'backoff', sourceReadStarted: false });
    expect(runWorker).toHaveBeenCalledTimes(1);
  });
  it('retains an unconfirmed child lock forever until explicit operator recovery', async () => {
    const runWorker = vi.fn(async () => ({ outcome: 'termination_unconfirmed', childClosed: false }));
    expect(await runScheduledCopy({ db, env, now, runWorker })).toMatchObject({ status: 'termination_unconfirmed', lockRetained: true });
    instant = '2026-10-24T01:00:00.000Z';
    expect(await runScheduledCopy({ db, env, now, runWorker })).toMatchObject({ status: 'blocked_active', sourceReadStarted: false });
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect((await lock.get()).data()?.active).toBe(true);
  });
  it.each(['2026-09-24T01:00:00.500Z', '2026-09-24T01:01:59.500Z'])('allows the next window after %s while blocking duplicate reads in one window', async start => {
    const runWorker = vi.fn(async () => ({ outcome: 'complete', childClosed: true }));
    instant = start;
    expect(await runScheduledCopy({ db, env, now, runWorker })).toMatchObject({ status: 'complete', notBefore: '2026-09-24T01:02:00.000Z' });
    instant = '2026-09-24T01:01:59.999Z';
    expect(await runScheduledCopy({ db, env, now, runWorker })).toMatchObject({ status: 'backoff', sourceReadStarted: false });
    instant = '2026-09-24T01:02:00.250Z';
    expect(await runScheduledCopy({ db, env, now, runWorker })).toMatchObject({ status: 'complete', notBefore: '2026-09-24T01:04:00.000Z' });
    expect(runWorker).toHaveBeenCalledTimes(2);
  });
  it('uses persisted 120, 240 and 480 second failure backoff without immediate retries', async () => {
    const runWorker = vi.fn(async () => ({ outcome: 'worker_failed', childClosed: true }));
    for (const seconds of [120, 240, 480, 480]) {
      const before = Date.parse(instant);
      const result = await runScheduledCopy({ db, env, now, runWorker });
      expect(result.status).toBe('failed');
      expect(Date.parse(result.notBefore) - before).toBe(seconds * 1000);
      expect(await runScheduledCopy({ db, env, now, runWorker })).toMatchObject({ status: 'backoff' });
      instant = result.notBefore;
    }
    expect(runWorker).toHaveBeenCalledTimes(4);
  });
  it('does not unlock a substituted owner or run without approved source access', async () => {
    const runWorker = vi.fn(async () => { await lock.update({ owner: 'different-owner' }); return { outcome: 'complete', childClosed: true }; });
    expect(await runScheduledCopy({ db, env: { ...env, WORKBENCH_COPY_SOURCE_READ_APPROVED: 'false' }, now, runWorker })).toEqual({ status: 'disabled', sourceReadStarted: false });
    expect(runWorker).not.toHaveBeenCalled();
    expect((await lock.get()).exists).toBe(false);
    expect(await runScheduledCopy({ db, env, now, runWorker })).toMatchObject({ status: 'lock_changed', lockRetained: true });
    expect((await lock.get()).data()?.active).toBe(true);
  });
  it('copies actual synthetic source records through the existing functions and stops access after five minutes', async () => {
    const original = { role: 'admin', status: 'ACTIVE', email: 'synthetic-only@example.test' };
    await source.doc(`${root}/members/synthetic-admin`).set(original);
    await source.doc(`${root}/client_error_events/synthetic-error`).set({ actorId: 'synthetic-admin', createdAt: instant, extra: { status: 500 }, message: 'must-not-copy' });
    const runWorker = async () => {
      await applyPermissionCopy({ db, env, input: await readPermissionCopy({ source, env, now }), now });
      for (const kind of ['client_error_events', 'reliability_operations']) await copyLogPage({ source, db, env, kind, now });
      return { outcome: 'complete', childClosed: true };
    };
    expect(await runScheduledCopy({ db, env, now, runWorker })).toMatchObject({ status: 'complete' });
    const core = createIsolatedWorkbenchCore({ db, env, now });
    expect(await core.authorize({ tenantId, actorId: 'synthetic-admin', actorRole: 'admin' })).toMatchObject({ datasetIds: ['weekly_submission'] });
    expect((await source.doc(`${root}/members/synthetic-admin`).get()).data()).toEqual(original);
    expect((await db.doc(`${root}/client_error_events/synthetic-error`).get()).data()).not.toHaveProperty('message');
    instant = '2026-09-24T01:05:00.001Z';
    await expect(core.authorize({ tenantId, actorId: 'synthetic-admin', actorRole: 'admin' })).rejects.toMatchObject({ code: 'workbench_permissions_stale' });
  });
  it('runs the real unchanged copy-worker Node entrypoint against emulator projects', async () => {
    instant = new Date().toISOString();
    await source.doc(`${root}/members/synthetic-admin`).set({ role: 'admin', status: 'ACTIVE' });
    const runWorker = (options: { env: Record<string, string>; signal?: AbortSignal }) => runCopyChild({ ...options, env: { ...options.env, FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST! } });
    expect(await runScheduledCopy({ db, env, now: () => new Date().toISOString(), runWorker })).toMatchObject({ status: 'complete', lockRetained: false });
    const copied = (await db.doc(`${root}/members/synthetic-admin`).get()).data();
    expect(copied).toMatchObject({ role: 'admin', status: 'ACTIVE', analyticsDatasetIds: ['weekly_submission'], permissionSourceProjectId: source.projectId });
    expect(Number.isFinite(Date.parse(copied?.permissionsCapturedAt))).toBe(true);
    expect((await db.doc(`${root}/workbench_copy_state/reliability_operations`).get()).data()?.generation).toBe(1);
    expect((await lock.get()).data()?.active).toBe(false);
  });
});
