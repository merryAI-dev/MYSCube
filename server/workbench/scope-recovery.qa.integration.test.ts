import express from 'express';
import { mountRequestRecovery } from './request-recovery.mjs';
import { createReactPageService } from './react-pages.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createWorkbenchApp } from './app.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createAnalyticsService } from './analytics-service.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('independent current-scope API recovery guards', () => {
  const db = new Firestore({ projectId: 'demo-scope-recovery-qa' }), tenantId = 'scope-recovery-qa', root = `orgs/${tenantId}`;
  const now = () => '2026-09-23T12:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-business-other', WORKBENCH_MODEL_PROJECT_ID: 'demo-operation-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-other-model' };
  const app = createWorkbenchApp({ db, env, now, authMode: 'headers' }), core = createIsolatedWorkbenchCore({ db, env, now });
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const headers = (key = randomUUID(), actorId = 'A') => ({ 'x-tenant-id': tenantId, 'x-actor-id': actorId, 'idempotency-key': key });
  const bodies = {
    'html-work-pages': { expectedVersion: 0, source: { title: '권한 변경 HTML', html: '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><h1>개인 원문</h1></body></html>' }, referenceIds: [] },
    'react-work-pages': { expectedVersion: 0, source: { title: '권한 변경 React', code: 'export default function App(){return <h1>개인 React 원문</h1>}' }, apis: [] },
    'workbench-apis': { expectedVersion: 0, definition: { name: '권한 변경 API', description: '주정산 조회 사본', kind: 'analytics-copy', enabled: true, parameters: {}, plan: { datasetId: 'weekly_submission', definitionVersion: '1', measures: ['project_count'], time: { yearMonth: '2026-09', weekNo: 1 } } } },
  };
  const collection = (kind: keyof typeof bodies) => kind === 'workbench-apis'
    ? db.collection(`${root}/workbench_api_owners/${hash(JSON.stringify('A'))}/apis`)
    : db.collection(`${root}/${kind === 'html-work-pages' ? 'html_work_pages' : 'react_work_pages'}/${hash('A')}/pages`);
  const recover = (key: string, path: string, actor = 'A', method = 'POST') => request(app).get(`/api/v1/workbench-requests/${key}`).query({ method, path }).set(headers(randomUUID(), actor));
  beforeEach(async () => {
    await db.recursiveDelete(db.doc(root));
    for (const actorId of ['A', 'B']) await db.doc(`${root}/members/${actorId}`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now(), analyticsDatasetIds: ['weekly_submission'], analyticsScopeRevision: '1' });
    const context = { tenantId, actorId: 'A', actorRole: 'admin' }; await core.authorize(context);
    await createAnalyticsService({ db, now }).importDataset(context, { datasetId: 'weekly_submission', manifest: { semanticDefinitionId: 'weekly_submission', semanticDefinitionVersion: '1', sourceRevision: 'scope-fixture', asOf: now(), capturedAt: now(), completeness: 'complete', coverage: { description: '격리된 권한 변경 검증용 사본', expectedRows: 1 } },
      schema: [{ name: 'project_id', type: 'string' }, { name: 'year_month', type: 'string' }, { name: 'week_no', type: 'integer' }, { name: 'status', type: 'string' }, { name: 'revision', type: 'integer' }, { name: 'submitted_at', type: 'timestamp' }, { name: 'approved_at', type: 'timestamp' }, { name: 'health', type: 'string' }],
      rows: [{ project_id: 'fixture', year_month: '2026-09', week_no: 1, status: 'PENDING_APPROVAL', revision: 1, submitted_at: now(), approved_at: null, health: 'OK' }] });
  });
  afterAll(async () => { await db.recursiveDelete(db.doc(root)); await db.terminate(); });

  async function registered(name: string) {
    const body = structuredClone(bodies['workbench-apis']); body.definition.name = name;
    const response = await request(app).post('/api/v1/workbench-apis').set(headers()).send(body); expect(response.status).toBe(201); return response.body;
  }
  it('keeps the entire React source hidden when one of two pinned APIs becomes inaccessible', async () => {
    const first = await registered('첫 API'), second = await registered('둘째 API');
    const key = randomUUID(), path = '/react-work-pages';
    const body = { ...bodies['react-work-pages'], apis: [{ id: first.id, version: 1 }, { id: second.id, version: 1 }] };
    const page = await request(app).post(`/api/v1${path}`).set(headers(key)).send(body); expect(page.status).toBe(201);
    await collection('workbench-apis').doc(second.id).update({ definition: { ...second.definition, enabled: false }, definitionHash: hash(JSON.stringify({ ...second.definition, enabled: false })) });
    await db.doc(`${root}/members/A`).update({ analyticsScopeRevision: '2' });
    const result = await recover(key, path); expect(result.status).toBe(200); expect(result.body.state).toBe('scope_changed'); expect(result.body.body).toBeUndefined();
    expect((await collection('react-work-pages').get()).size).toBe(1); expect((await collection('react-work-pages').doc(page.body.id).collection('versions').get()).size).toBe(1);
    expect((await request(app).post(`/api/v1${path}`).set(headers(key)).send(body)).status).toBe(409);
  });
  it('does not recover a registered API whose latest version was disabled even though the saved version was enabled', async () => {
    const key = randomUUID(), path = '/workbench-apis';
    const first = await request(app).post(`/api/v1${path}`).set(headers(key)).send(bodies['workbench-apis']); expect(first.status).toBe(201);
    const disabled = await request(app).put(`/api/v1${path}/${first.body.id}`).set(headers()).send({ expectedVersion: 1, definition: { ...first.body.definition, enabled: false } }); expect(disabled.status).toBe(200);
    await db.doc(`${root}/members/A`).update({ analyticsScopeRevision: '2' });
    const result = await recover(key, path); expect(result.body.state).toBe('scope_changed'); expect(result.body.body).toBeUndefined();
    expect((await collection('workbench-apis').doc(first.body.id).collection('versions').get()).size).toBe(2);
  });
  it('discards the recovered source when persisted authorization is revoked between version read and final response', async () => {
    const key = randomUUID(), path = '/react-work-pages';
    const saved = await request(app).post(`/api/v1${path}`).set(headers(key)).send(bodies['react-work-pages']); expect(saved.status).toBe(201);
    await db.doc(`${root}/members/A`).update({ analyticsScopeRevision: '2' });
    const pages = createReactPageService({ db, now, authorize: core.authorize, apis: { get: () => { throw new Error('No API should be requested for this source'); } } });
    const checkedPages = { ...pages, validateApis: async (context: any, refs: any[]) => { await pages.validateApis(context, refs); await db.doc(`${root}/members/A`).update({ status: 'INACTIVE' }); } };
    const isolated = express();
    const asyncHandler = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
    isolated.use(asyncHandler(async (req: any, _res: any, next: any) => { req.context = { tenantId, actorId: 'A', actorRole: 'admin' }; await core.authorize(req.context); next(); }));
    mountRequestRecovery(isolated, { db, core, pages: checkedPages, apis: {}, htmlPages: {}, asyncHandler });
    isolated.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ error: error.code }));
    const response = await request(isolated).get(`/api/v1/workbench-requests/${key}`).query({ method: 'POST', path });
    expect(response.status).toBe(200); expect(response.body.state).toBe('scope_changed'); expect(response.body.body).toBeUndefined();
    expect((await collection('react-work-pages').doc(saved.body.id).collection('versions').get()).size).toBe(1);
  });

});
