import { Firestore } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { copyLogPage } from './copy-feed.mjs';
import { createWorkbenchApp } from './app.mjs';
import { observationId } from '../bff/reliability-model.mjs';
import { createCopiedLogSummary } from './copied-log-summary.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('independent source copy to historical summary HTTP evidence', () => {
  const source = new Firestore({ projectId: 'demo-summary-qa-source' });
  const db = new Firestore({ projectId: 'demo-summary-qa-target' });
  const tenantId = 'summary-qa', actorId = 'alice', base = `orgs/${tenantId}`;
  const now = () => '2026-09-23T12:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: source.projectId,
    WORKBENCH_MODEL_PROJECT_ID: 'demo-summary-qa-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-summary-qa-business-model',
    WORKBENCH_COPY_ENABLED: 'true', WORKBENCH_COPY_SOURCE_PROJECT_ID: source.projectId, WORKBENCH_TENANT_ID: tenantId };
  const app = () => createWorkbenchApp({ db, env, now, authMode: 'headers' });
  const summary = () => request(app()).get('/api/v1/product-operations/summary?days=7').set({ 'x-actor-id': actorId, 'x-tenant-id': tenantId });
  const copy = (kind = 'reliability_operations') => copyLogPage({ source, db, env, kind, now });
  async function put(overrides: Record<string, unknown> = {}) {
    const row = { operationId: randomUUID(), operationKey: 'registration.submit', actorId, mode: 'manual',
      environment: 'live', metricVersion: 1, day: '2026-09-20', createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: now(), outcome: 'saved', clientStarted: true, serverObserved: true,
      followup: 'not_applicable', requestId: 'synthetic-request', releaseSha: 'a'.repeat(40), ...overrides };
    const id = observationId(tenantId, actorId, row.operationKey, row.operationId);
    await source.doc(`${base}/reliability_operations/${id}`).set(row);
    return { id, row };
  }
  beforeEach(async () => {
    await source.recursiveDelete(source.doc(base)); await db.recursiveDelete(db.doc(base));
    await db.doc(`${base}/members/${actorId}`).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now() });
  });
  afterAll(async () => {
    await source.recursiveDelete(source.doc(base)); await db.recursiveDelete(db.doc(base));
    await source.terminate(); await db.terminate();
  });
  it('does not substitute unrelated isolated daily aggregates or interpret missing collection as a zero error rate', async () => {
    await db.doc(`${base}/reliability_daily/fake`).set({ day: '2026-09-23', environment: 'isolated', metricVersion: 1,
      operationKey: 'registration.submit', mode: 'manual', counts: { total: 200, saved: 200 } });
    const response = await summary();
    expect(response.status).toBe(200); expect(response.body.historicalOnly).toBe(true);
    expect(response.body.counts.total).toBe(0); expect(response.body.observedSystemFailureRate).toBeNull();
    expect(response.body.httpRequests.status).toBe('not_collected');
  });
  it('uses source day and environment, keeps one logical attempt across repeated copies and updates, and never writes the source', async () => {
    expect(source.projectId).not.toBe(db.projectId);
    const original = await put({ outcome: 'pending' });
    const sourceBefore = await source.doc(`${base}/reliability_operations/${original.id}`).get();
    await copy(); await copy();
    const sourceAfter = await sourceBefore.ref.get();
    expect(sourceAfter.data()).toEqual(sourceBefore.data()); expect(sourceAfter.updateTime?.isEqual(sourceBefore.updateTime!)).toBe(true);
    let response = await summary();
    expect(response.status).toBe(200); expect(response.body.counts.total).toBe(1); expect(response.body.counts.pending).toBe(1);
    expect(response.body.rows[0].day).toBe('2026-09-20');
    expect(response.body.rows[0].environment).toBe('live');
    expect(response.body.sourceEnvironments).toEqual(['live']);
    expect(response.body.collection.completeness).toBe('not_guaranteed');
    await sourceBefore.ref.update({ outcome: 'saved' }); await copy();
    response = await summary();
    expect(response.body.counts.total).toBe(1); expect(response.body.counts.pending).toBe(0); expect(response.body.counts.saved).toBe(1);
    expect((await db.collection(`${base}/reliability_operations`).get()).size).toBe(1);
    expect(response.body.rows[0].day).toBe('2026-09-20');
  });
  it('does not move old operations into the period just because they were updated recently', async () => {
    await put({ day: '2026-08-01', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: now() });
    await copy(); const response = await summary();
    expect(response.status).toBe(200); expect(response.body.counts.total).toBe(0); expect(response.body.observedSystemFailureRate).toBeNull();
  });
  it('keeps client errors out of the logical attempt denominator and withholds rates for an incomplete copy', async () => {
    await put({ outcome: 'system_failed' }); await copy();
    await source.doc(`${base}/client_error_events/synthetic-error`).set({ actorId, createdAt: now(), extra: { errorCode: 'synthetic_failure' } });
    await copy('client_error_events');
    await db.doc(`${base}/workbench_copy_state/reliability_operations`).update({ hasMore: true });
    const response = await summary();
    expect(response.status).toBe(200); expect(response.body.counts.total).toBe(1); expect(response.body.counts.system_failed).toBe(1);
    expect(response.body.clientErrors.count).toBe(1);
    expect(response.body.observedSystemFailureRate).toBeNull(); expect(response.body.httpRequests.status).toBe('not_collected');
  });
  it('keeps environments separate and never publishes a mixed-environment rate', async () => {
    await put({ environment: 'live', outcome: 'system_failed' });
    await put({ environment: 'preview', outcome: 'saved' }); await copy();
    const response = await summary();
    expect(response.status).toBe(200); expect(response.body.sourceEnvironments.sort()).toEqual(['live', 'preview']);
    expect(response.body.rows).toHaveLength(2); expect(response.body.observedSystemFailureRate).toBeNull();
    expect(response.body.rows.find((row: any) => row.environment === 'live').counts.system_failed).toBe(1);
    expect(response.body.rows.find((row: any) => row.environment === 'preview').counts.saved).toBe(1);
  });
  it('marks duplicate noncanonical identities and contradictory source dates invalid instead of increasing the denominator', async () => {
    const original = await put();
    await source.doc(`${base}/reliability_operations/duplicate`).set(original.row);
    await put({ day: '2026-09-21', createdAt: '2026-09-20T00:00:00.000Z' }); await copy();
    const response = await summary();
    expect(response.status).toBe(200); expect(response.body.counts.total).toBe(1);
    expect(response.body.invalidRecords).toBe(2); expect(response.body.observedSystemFailureRate).toBeNull();
  });
  it('replaces a schema-one target with the same source revision and refuses to report a stale copy rate', async () => {
    const original = await put({ outcome: 'system_failed' }); await copy();
    const ref = db.doc(`${base}/reliability_operations/${original.id}`), existing = (await ref.get()).data()!;
    await ref.set({ actorId, updatedAt: now(), copySourceUpdatedAt: existing.copySourceUpdatedAt });
    await copy(); expect((await ref.get()).data()?.copySchemaVersion).toBe(2);
    let response = await summary(); expect(response.body.counts.total).toBe(1);
    expect(response.body.observedSystemFailureRate).toBe(1);
    await db.doc(`${base}/workbench_copy_state/reliability_operations`).update({ capturedAt: '2026-09-23T11:50:00.000Z' });
    response = await summary(); expect(response.body.observedSystemFailureRate).toBeNull();
  });
  it('does not expose historical data to a member whose persisted authorization was revoked', async () => {
    await put(); await copy(); await db.doc(`${base}/members/${actorId}`).update({ status: 'INACTIVE' });
    const response = await summary(); expect(response.status).toBe(403); expect(response.body.counts).toBeUndefined();
  });
  it('does not treat a server outcome without server confirmation as a valid copied attempt', async () => {
    await put({ outcome: 'system_failed', serverObserved: false }); await copy();
    const response = await summary(); expect(response.status).toBe(200);
    expect(response.body.invalidRecords).toBe(1); expect(response.body.counts.total).toBe(0);
    expect(response.body.observedSystemFailureRate).toBeNull();
  });
  it('does not certify a schema-one copy marker merely because individual rows were upgraded', async () => {
    await put({ outcome: 'system_failed' }); await copy();
    await db.doc(`${base}/workbench_copy_state/reliability_operations`).update({ copySchemaVersion: 1 });
    const response = await summary(); expect(response.status).toBe(200);
    expect(response.body.counts.total).toBe(1); expect(response.body.collection.status).not.toBe('snapshot_ready');
    expect(response.body.observedSystemFailureRate).toBeNull();
  });
  it('withholds the rate when the actual Firestore query reaches its bounded scan limit', async () => {
    await put(); await put({ outcome: 'system_failed' }); await copy();
    const read = createCopiedLogSummary({ db, env, now, maxRecords: 1, authorize: async () => {} });
    const result = await read({ tenantId, actorId, actorRole: 'admin' });
    expect(result.truncated).toBe(true); expect(result.counts.total).toBe(1);
    expect(result.observedSystemFailureRate).toBeNull(); expect(result.rows.every((row: any) => row.observedSystemFailureRate === null)).toBe(true);
  });
  it('rechecks persisted permission after the read snapshot before releasing the summary', async () => {
    await put(); await copy(); let checks = 0;
    const read = createCopiedLogSummary({ db, env, now, authorize: async () => {
      const ref = db.doc(`${base}/members/${actorId}`), member = (await ref.get()).data();
      if (member?.status !== 'ACTIVE') throw Object.assign(new Error('revoked'), { statusCode: 403 });
      if (++checks === 1) await ref.update({ status: 'INACTIVE' });
    } });
    await expect(read({ tenantId, actorId, actorRole: 'admin' })).rejects.toMatchObject({ statusCode: 403 });
  });
});
