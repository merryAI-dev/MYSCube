import { createHash, randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createWorkbenchApp } from './app.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createAnalyticsService } from './analytics-service.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('durable raw request identities cannot create a second write after permission changes', () => {
  const db = new Firestore({ projectId: 'demo-operation-scopes' }), tenantId = 'operation-scopes', root = `orgs/${tenantId}`;
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

  it.each(Object.keys(bodies) as Array<keyof typeof bodies>)('%s refuses another write after a scope change but recovers the exact version under current permissions', async (kind) => {
    const key = randomUUID(), path = `/${kind}`;
    const first = await request(app).post(`/api/v1${path}`).set(headers(key)).send(bodies[kind]); expect(first.status).toBe(201);
    expect((await recover(key, path)).body).toMatchObject({ state: 'completed', body: { id: first.body.id, version: 1 } });
    expect((await recover(key, path, 'B')).body).toEqual({ state: 'not_found' });
    await db.doc(`${root}/members/A`).update({ analyticsScopeRevision: '2' });
    const repeated = await request(app).post(`/api/v1${path}`).set(headers(key)).send(bodies[kind]);
    expect(repeated.status).toBe(409); expect(repeated.body.error).toBe('workbench_operation_scope_changed');
    expect(repeated.body.source).toBeUndefined(); expect(repeated.body.definition).toBeUndefined(); expect(repeated.headers['x-idempotency-replayed']).toBeUndefined();
    const recovered = await recover(key, path); expect(recovered.status).toBe(200); expect(recovered.body).toMatchObject({ state: 'completed', recoveredAfterScopeChange: true, body: { id: first.body.id, version: 1 } });
    expect(recovered.body.body.source || recovered.body.body.definition).toEqual(first.body.source || first.body.definition);
    expect((await request(app).post(`/api/v1${path}`).set(headers(key)).send(bodies[kind])).body.error).toBe('workbench_operation_scope_changed');
    expect((await collection(kind).get()).size).toBe(1); expect((await collection(kind).doc(first.body.id).collection('versions').get()).size).toBe(1);
    const locators = await db.collection(`${root}/workbench_operation_scopes`).get(); expect(locators.size).toBe(1);
    const value = locators.docs[0].data(); expect(Object.keys(value).sort()).toEqual(['actorId', 'createdAt', 'method', 'path', 'payloadHash', 'scopeFingerprint', 'tenantId']);
    expect(value.payloadHash).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(value)).not.toContain(key); expect(JSON.stringify(value)).not.toContain('개인 원문');
  });

  it.each(['html-work-pages', 'react-work-pages'] as const)('%s update and restoration replay remain bound to the original scope', async (kind) => {
    const initial = await request(app).post(`/api/v1/${kind}`).set(headers()).send(bodies[kind]); expect(initial.status).toBe(201);
    const editKey = randomUUID(), editPath = `/${kind}/${initial.body.id}`, editBody = { ...bodies[kind], expectedVersion: 1 };
    expect((await request(app).put(`/api/v1${editPath}`).set(headers(editKey)).send(editBody)).status).toBe(200);
    const restoreKey = randomUUID(), restorePath = `${editPath}/restore`, restoreBody = { expectedVersion: 2, version: 1 };
    const restored = await request(app).post(`/api/v1${restorePath}`).set(headers(restoreKey)).send(restoreBody); expect(restored.status).toBe(200); expect(restored.body.version).toBe(3);
    await db.doc(`${root}/members/A`).update({ analyticsScopeRevision: '2' });
    expect((await request(app).put(`/api/v1${editPath}`).set(headers(editKey)).send(editBody)).body.error).toBe('workbench_operation_scope_changed');
    expect((await request(app).post(`/api/v1${restorePath}`).set(headers(restoreKey)).send(restoreBody)).body.error).toBe('workbench_operation_scope_changed');
    expect((await recover(editKey, editPath, 'A', 'PUT')).body).toMatchObject({ state: 'completed', recoveredAfterScopeChange: true, body: { version: 2 } });
    expect((await recover(restoreKey, restorePath)).body).toMatchObject({ state: 'completed', recoveredAfterScopeChange: true, body: { version: 3, restoredFrom: 1 } });
    expect((await collection(kind).get()).size).toBe(1); expect((await collection(kind).doc(initial.body.id).collection('versions').get()).size).toBe(3);
  });

  it('binds payload, method and path, rejects invalid raw keys and does not persist source or credentials', async () => {
    const kind = 'html-work-pages', key = randomUUID();
    const first = await request(app).post(`/api/v1/${kind}`).set(headers(key)).send(bodies[kind]); expect(first.status).toBe(201);
    const changed = { ...bodies[kind], source: { ...bodies[kind].source, title: '다른 내용' } };
    expect((await request(app).post(`/api/v1/${kind}`).set(headers(key)).send(changed)).body.error).toBe('workbench_operation_conflict');
    expect((await request(app).put(`/api/v1/${kind}/${first.body.id}`).set(headers(key)).send({ ...bodies[kind], expectedVersion: 1 })).body.error).toBe('workbench_operation_conflict');
    expect((await request(app).post('/api/v1/react-work-pages').set(headers(key)).send(bodies['react-work-pages'])).body.error).toBe('workbench_operation_conflict');
    expect((await recover(key, '/react-work-pages')).body.error).toBe('workbench_recovery_mismatch');
    expect((await request(app).post(`/api/v1/${kind}`).set(headers('not-a-uuid')).send(bodies[kind])).body.error).toBe('workbench_operation_key_invalid');
    expect((await collection(kind).get()).size).toBe(1); expect((await db.collection(`${root}/workbench_operation_scopes`).get()).size).toBe(1);
  });

  it('never falls back to an old response body when the original atomic receipt is missing, legacy or inconsistent', async () => {
    const key = randomUUID(), path = '/html-work-pages';
    const first = await request(app).post(`/api/v1${path}`).set(headers(key)).send(bodies['html-work-pages']); expect(first.status).toBe(201);
    const records = await db.collection(`${root}/workbench_mutation_results`).get(), receiptRef = records.docs[0].ref, original = records.docs[0].data();
    await db.doc(`${root}/members/A`).update({ analyticsScopeRevision: '2' });
    const { operationPayloadHash: _legacyOmitted, ...legacy } = original;
    for (const mismatch of [legacy, { ...original, operationPayloadHash: 'f'.repeat(64) }, { ...original, operationPath: '/react-work-pages' }, { ...original, operationMethod: 'PUT' },
      { ...original, actorId: 'B' }, { ...original, tenantId: 'other' }, { ...original, scopeFingerprint: 'f'.repeat(64) }, { ...original, kind: 'react-page' },
      { ...original, version: 0 }, { ...original, version: 1.5 }, { ...original, pageId: randomUUID() }, { ...original, contentHash: 'f'.repeat(64) }]) {
      await receiptRef.set(mismatch); const result = await recover(key, path); expect(result.status).toBe(200); expect(result.body.state).toBe('scope_changed'); expect(result.body.body).toBeUndefined();
    }
    await receiptRef.delete(); const missing = await recover(key, path); expect(missing.body.state).toBe('scope_changed'); expect(missing.body.body).toBeUndefined();
    expect((await collection('html-work-pages').get()).size).toBe(1); expect((await collection('html-work-pages').doc(first.body.id).collection('versions').get()).size).toBe(1);
  });
});
