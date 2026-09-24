import { createHash, randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorkbenchApp } from './app.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createReactPageService } from './react-pages.mjs';
import { ReactPageMutationResponseSchema, ReactRevisionSchema, ReactPageListSchema, ReactHistorySchema, ReactExecutionArtifactSchema } from '../../shared/workbench-react-workspace.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('React shared contracts across genuine HTTP and persisted emulator reads', () => {
  const db = new Firestore({ projectId: 'demo-react-contract' }), tenantId = 'react-contract', actorId = 'contract-author';
  const root = `orgs/${tenantId}`, now = () => '2026-09-24T09:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-untouched-source', WORKBENCH_MODEL_PROJECT_ID: 'demo-react-contract-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-untouched-model',
    WORKBENCH_AUTH_MODE: 'emulator', WORKBENCH_REACT_RUNTIME_URL: 'http://127.0.0.1:8792/runtime', WORKBENCH_APP_ORIGIN: 'http://127.0.0.1:4178' };
  const app = createWorkbenchApp({ db, env, now, authMode: 'headers' });
  const headers = (key = randomUUID()) => ({ 'x-tenant-id': tenantId, 'x-actor-id': actorId, 'idempotency-key': key });
  const input = { expectedVersion: 0, source: { title: '응답 계약 검사', workspace: { schemaVersion: 1, entry: 'App.tsx', packageSetId: 'react18-tailwind4-v1', files: { 'App.tsx': 'export default function App(){return <h1>응답 계약</h1>}' } } }, apis: [] };
  beforeEach(async () => { await db.recursiveDelete(db.doc(root)); await db.doc(`${root}/members/${actorId}`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now(), analyticsDatasetIds: [], analyticsScopeRevision: '1' }); });
  afterAll(async () => { await db.recursiveDelete(db.doc(root)); await db.terminate(); });
  it('serves distinct strict save, page, list, history, restore, preview and receipt shapes', async () => {
    const key = randomUUID();
    const saved = await request(app).post('/api/v1/react-work-pages').set(headers(key)).send(input);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const parsed = ReactPageMutationResponseSchema.parse(saved.body);
    expect(parsed.schemaVersion).toBe(1); expect(parsed.artifact.schemaVersion).toBe(1);
    const get = await request(app).get(`/api/v1/react-work-pages/${parsed.id}`).set(headers());
    expect(ReactRevisionSchema.parse(get.body).source).toEqual(input.source);
    const list = await request(app).get('/api/v1/react-work-pages').set(headers());
    expect(ReactPageListSchema.parse(list.body).items[0].source).toEqual({ title: input.source.title });
    expect(list.body.items[0]).not.toHaveProperty('artifact');
    const history = await request(app).get(`/api/v1/react-work-pages/${parsed.id}/versions`).set(headers());
    expect(ReactHistorySchema.parse(history.body).items[0].restoredFrom).toBe(null);
    const recovery = await request(app).get(`/api/v1/workbench-requests/${key}`).query({ path: '/react-work-pages', method: 'POST' }).set(headers());
    expect(ReactPageMutationResponseSchema.parse(recovery.body.body).version).toBe(1);
    const restored = await request(app).post(`/api/v1/react-work-pages/${parsed.id}/restore`).set(headers()).send({ expectedVersion: 1, version: 1 });
    expect(ReactPageMutationResponseSchema.parse(restored.body)).toMatchObject({ version: 2, restoredFrom: 1 });
    const preview = await request(app).post('/api/v1/react-work-pages/preview').set(headers()).send({ source: input.source, apis: [] });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(ReactExecutionArtifactSchema.parse(preview.body).executionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(parsed.artifact).not.toHaveProperty('executionId');
  });
  it('does not return or replay structurally corrupted stored artifacts even when content hashes still match', async () => {
    const key = randomUUID(), saved = await request(app).post('/api/v1/react-work-pages').set(headers(key)).send(input);
    expect(saved.status).toBe(201);
    const owner = createHash('sha256').update(actorId).digest('hex');
    const ref = db.doc(`${root}/react_work_pages/${owner}/pages/${saved.body.id}`), original = (await ref.get()).data()!;
    for (const altered of [
      { ...original, artifact: { ...original.artifact, typecheck: { ...original.artifact.typecheck, status: 'not-checked' } } },
      { ...original, artifact: { ...original.artifact, dependencies: [] } },
      { ...original, schemaVersion: 999 },
      { ...original, executionId: randomUUID() },
    ]) {
      await ref.set(altered);
      const response = await request(app).get(`/api/v1/react-work-pages/${saved.body.id}`).set(headers());
      expect(response.status).toBe(409); expect(JSON.stringify(response.body)).toContain('react_page_integrity_failed'); expect(response.body).not.toHaveProperty('source');
    }
    await ref.set(original);
    const version = ref.collection('versions').doc('1'); await version.set({ ...original, artifact: { ...original.artifact, schemaVersion: 999 } });
    const core = createIsolatedWorkbenchCore({ db, env, now });
    const context = { tenantId, actorId, actorRole: 'admin', idempotencyKey: '' };
    const scope = await core.authorize(context); context.idempotencyKey = createHash('sha256').update(`${key}:${scope.fingerprint}`).digest('hex');
    const pages = createReactPageService({ db, now, authorize: core.authorize, apis: { get: async () => { throw new Error('No API registered'); } } });
    await expect(pages.save(context, null, input)).rejects.toMatchObject({ code: 'react_page_integrity_failed' });
    const recovery = await request(app).get(`/api/v1/workbench-requests/${key}`).query({ path: '/react-work-pages', method: 'POST' }).set(headers());
    expect(recovery.body).not.toHaveProperty('body');
    expect((await ref.collection('versions').get()).size).toBe(1);
  });
});
