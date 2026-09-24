import { randomUUID, createHash } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createWorkbenchApp } from './app.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createReactPageService } from './react-pages.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('lost-response recovery through real owner-bound HTTP and atomic persistence', () => {
  const db = new Firestore({ projectId: 'demo-request-recovery' }), tenantId = `recover-${randomUUID()}`, root = `orgs/${tenantId}`;
  const now = () => '2026-09-23T09:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-existing-data', WORKBENCH_MODEL_PROJECT_ID: 'demo-recovery-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-existing-model' };
  const core = createIsolatedWorkbenchCore({ db, env, now }), app = createWorkbenchApp({ db, env, now, authMode: 'headers' });
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const headers = (actor = 'A', key = randomUUID()) => ({ 'x-tenant-id': tenantId, 'x-actor-id': actor, 'idempotency-key': key });
  const input = { expectedVersion: 0, source: { title: '저장 복구', code: "import React from 'react';export default function App(){return <h1>복구</h1>}" }, apis: [] };
  beforeEach(async () => { await db.recursiveDelete(db.doc(root)); for (const actor of ['A', 'B']) await db.doc(`${root}/members/${actor}`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now(), analyticsDatasetIds: [], analyticsScopeRevision: '1' }); });
  afterAll(async () => { await db.recursiveDelete(db.doc(root)); await db.terminate(); });
  const recover = (key: string, actor = 'A') => request(app).get(`/api/v1/workbench-requests/${key}`).query({ method: 'POST', path: '/react-work-pages' }).set(headers(actor));
  it('finds a page committed before the transport receipt, and retries as exactly one version', async () => {
    const key = randomUUID(), context: any = { tenantId, actorId: 'A', actorRole: 'admin' }; await core.authorize(context);
    context.idempotencyKey = hash(`${key}:${context.analyticsScope.fingerprint}`);
    const pages = createReactPageService({ db, now, authorize: core.authorize, apis: { get: async () => {} } });
    const committed = await pages.save(context, null, input);
    const restored = await recover(key); expect(restored.status).toBe(200); expect(restored.body).toMatchObject({ state: 'completed', body: { id: committed.id, version: 1 } });
    const retried = await request(app).post('/api/v1/react-work-pages').set(headers('A', key)).send(input);
    expect(retried.status).toBe(201); expect(retried.body.id).toBe(committed.id);
    const all = await request(app).get('/api/v1/react-work-pages').set(headers()); expect(all.body.items).toHaveLength(1);
    const history = await request(app).get(`/api/v1/react-work-pages/${committed.id}/versions`).set(headers()); expect(history.body.items).toHaveLength(1);
  });
  it('denies another account, revalidates current scope, and refuses inactive members', async () => {
    const key = randomUUID(); expect((await request(app).post('/api/v1/react-work-pages').set(headers('A', key)).send(input)).status).toBe(201);
    expect((await recover(key, 'B')).body).toEqual({ state: 'not_found' });
    await db.doc(`${root}/members/A`).update({ analyticsScopeRevision: '2' });
    expect((await recover(key)).body).toMatchObject({ state: 'completed', recoveredAfterScopeChange: true });
    await db.doc(`${root}/members/A`).update({ status: 'INACTIVE' });
    expect((await recover(key)).status).toBe(403);
  });
});
