import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import request from 'supertest';
import { createWorkbenchApp } from './app.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createAnalyticsService } from './analytics-service.mjs';
import { createAnalyticsExecutor } from './analytics-engine.mjs';
import { buildEvaluationDatasets, EVALUATION_PRESETS } from './evaluation/acceptance-cases.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('two actor HTTP queries, native FIFO execution and persisted private evidence', () => {
  const db = new Firestore({ projectId: 'demo-analytics-queue' });
  const source = new Firestore({ projectId: 'demo-analytics-queue-source' });
  const tenantId = `queue-${randomUUID()}`, prefix = `orgs/${tenantId}`;
  const now = () => '2026-09-28T10:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: source.projectId, WORKBENCH_MODEL_PROJECT_ID: 'demo-queue-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-original-model' };
  const core = createIsolatedWorkbenchCore({ db, env, now });
  const headers = (actor: string) => ({ 'x-tenant-id': tenantId, 'x-actor-id': actor, 'idempotency-key': randomUUID() });
  const context = (actor: string) => ({ tenantId, actorId: actor, actorRole: 'admin' });
  const member = (actor: string) => db.doc(`${prefix}/members/${actor}`);
  beforeEach(async () => {
    await db.recursiveDelete(db.doc(prefix));
    for (const actor of ['a', 'b']) await member(actor).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now(), analyticsDatasetIds: ['weekly_submission'], analyticsScopeRevision: 'v1' });
    await source.doc(`${prefix}/projects/original`).set({ original: true });
  });
  afterAll(async () => { await db.recursiveDelete(db.doc(prefix)); await source.recursiveDelete(source.doc(prefix)); await Promise.all([db.terminate(), source.terminate()]); });
  async function prepare() {
    let release = () => {}, entered = 0, sawFirst!: () => void, sawSecond!: () => void;
    const firstEntered = new Promise<void>(resolve => { sawFirst = resolve; });
    const secondEntered = new Promise<void>(resolve => { sawSecond = resolve; });
    let spawned = 0;
    const executor = createAnalyticsExecutor({ spawnWorker: (...args: any[]) => {
      const child = (spawn as any)(...args);
      if (++spawned === 1) { const end = child.stdin.end.bind(child.stdin); child.stdin.end = (...values: any[]) => { release = () => end(...values); return child.stdin; }; }
      return child;
    } });
    const analytics = createAnalyticsService({ db, now, execute: (input: any, options: any) => {
      const result = executor(input, options); entered++; if (entered === 1) sawFirst(); if (entered === 2) sawSecond(); return result;
    } });
    const app = createWorkbenchApp({ db, env, now, authMode: 'headers', analytics });
    const apis: Record<string, string> = {}, versions: Record<string, string> = {}, datasets: Record<string, any> = {};
    for (const actor of ['a', 'b']) {
      const ctx = context(actor); await core.authorize(ctx);
      const dataset = structuredClone(buildEvaluationDatasets('complete')[0]); dataset.rows[1].project_id = `private-${actor}`; datasets[actor] = dataset;
      versions[actor] = (await analytics.importDataset(ctx, dataset)).version;
      const response = await request(app).post('/api/v1/workbench-apis').set(headers(actor)).send({ expectedVersion: 0, definition: EVALUATION_PRESETS['september-pending'].definition });
      expect(response.status).toBe(201); apis[actor] = response.body.id;
    }
    const invoke = (actor: string) => request(app).post(`/api/v1/workbench-apis/${apis[actor]}/test`).set(headers(actor)).send({ version: 1, input: {} }).then(value => value);
    return { app, analytics, firstEntered, secondEntered, release: () => release(), invoke, versions, datasets, apis, spawned: () => spawned };
  }
  it('serializes two real HTTP/API/DuckDB queries and persists each actor’s own result', async () => {
    const h = await prepare(), before = await source.doc(`${prefix}/projects/original`).get();
    const a = h.invoke('a'); await h.firstEntered; const b = h.invoke('b'); await h.secondEntered;
    expect(h.spawned()).toBe(1); h.release();
    const results = await Promise.all([a, b]); expect(results.map(value => value.status)).toEqual([200, 200]); expect(h.spawned()).toBe(2);
    for (const [index, actor] of ['a', 'b'].entries()) {
      const response = results[index]; expect(response.body.rows).toEqual([{ project_id: `private-${actor}`, status: 'PENDING_APPROVAL' }]);
      const ctx = context(actor); await core.authorize(ctx);
      const evidence = await h.analytics.evidence(ctx, response.body.evidenceId); expect(evidence.rows).toEqual(response.body.rows); expect(evidence.datasetVersions.weekly_submission).toBe(h.versions[actor]);
      const other = await request(h.app).get(`/api/v1/html-work-pages/evidence/${response.body.evidenceId}`).set(headers(actor === 'a' ? 'b' : 'a'));
      expect(other.status).toBe(404); expect(other.body.rows).toBeUndefined();
      const owner = createHash('sha256').update(JSON.stringify(actor)).digest('hex');
      const receipts = await db.collection(`${prefix}/workbench_api_owners/${owner}/apis/${h.apis[actor]}/calls`).get(); expect(receipts.docs.map(doc => doc.get('state'))).toEqual(['completed']);
    }
    const after = await source.doc(`${prefix}/projects/original`).get(); expect(after.data()).toEqual(before.data()); expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true);
  });
  it.each(['membership', 'scope'])('does not expose a result after queued %s revocation', async (change) => {
    const h = await prepare(); const a = h.invoke('a'); await h.firstEntered; const b = h.invoke('b'); await h.secondEntered;
    await member('b').update(change === 'membership' ? { status: 'INACTIVE' } : { analyticsDatasetIds: [], analyticsScopeRevision: 'revoked-v2' });
    h.release(); const [first, revoked] = await Promise.all([a, b]); expect(first.status).toBe(200); expect(revoked.status).toBe(403); expect(revoked.body.rows).toBeUndefined(); expect(revoked.body.evidenceId).toBeUndefined();
    const owner = createHash('sha256').update(JSON.stringify('b')).digest('hex');
    const receipts = await db.collection(`${prefix}/workbench_api_owners/${owner}/apis/${h.apis.b}/calls`).get(); expect(receipts.docs.map(doc => doc.get('state'))).toEqual(['failed']);
    const evidenceRead = await request(h.app).get(`/api/v1/html-work-pages/evidence/${first.body.evidenceId}`).set(headers('b')); expect(evidenceRead.status).toBeGreaterThanOrEqual(400); expect(evidenceRead.body.rows).toBeUndefined();
  });
  it('keeps the captured data version when a newer copy arrives during FIFO waiting', async () => {
    const h = await prepare(); const a = h.invoke('a'); await h.firstEntered; const b = h.invoke('b'); await h.secondEntered;
    const ctx = context('b'); await core.authorize(ctx); const updated = structuredClone(h.datasets.b); updated.rows[1].project_id = 'newer-private-b'; updated.manifest.capturedAt = '2026-09-28T10:00:00.000Z'; updated.manifest.sourceRevision = 'new-version';
    const newer = await h.analytics.importDataset(ctx, updated); expect(newer.version).not.toBe(h.versions.b);
    h.release(); const results = await Promise.all([a, b]); expect(results.map(value => value.status)).toEqual([200, 200]);
    expect(results[1].body.rows[0].project_id).toBe('private-b'); const evidence = await h.analytics.evidence(ctx, results[1].body.evidenceId); expect(evidence.datasetVersions.weekly_submission).toBe(h.versions.b);
  });
});
