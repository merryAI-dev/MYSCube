import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkbenchApp } from './app.mjs';
import { normalizeReactSource, MAX_REACT_DIAGNOSTICS } from '../../shared/workbench-react-workspace.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('actual compiler diagnostics through the authenticated HTTP boundary', () => {
  const db = new Firestore({ projectId: 'demo-react-diagnostics-http' });
  const tenantId = 'diagnostics-http', actorId = 'diagnostics-author';
  const now = () => '2026-09-24T09:00:00.000Z';
  const app = createWorkbenchApp({ db, now, authMode: 'headers', env: {
    WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-original-untouched',
    WORKBENCH_MODEL_PROJECT_ID: 'demo-diagnostics-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-original-model',
  } });
  beforeAll(async () => {
    await db.recursiveDelete(db.doc(`orgs/${tenantId}`));
    await db.doc(`orgs/${tenantId}/members/${actorId}`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now(), analyticsDatasetIds: [], analyticsScopeRevision: '1' });
  });
  afterAll(async () => { await db.recursiveDelete(db.doc(`orgs/${tenantId}`)); await db.terminate(); });
  it('reports bounded file/line diagnostics without persisting an invalid workspace', async () => {
    const source = normalizeReactSource({ title: '타입 오류 확인', code: 'export default function App(){return <main/>;}' });
    source.workspace.files['lib/broken.ts'] = Array.from({ length: 55 }, (_, i) => `export const value${i}: number = '틀린 형식';`).join('\n');
    const response = await request(app).post('/api/v1/react-work-pages')
      .set({ 'x-tenant-id': tenantId, 'x-actor-id': actorId, 'idempotency-key': randomUUID() })
      .send({ source, expectedVersion: 0, apis: [] });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ error: 'react_compile_failed', details: { stage: 'type', truncated: true } });
    expect(response.body.details.diagnostics).toHaveLength(MAX_REACT_DIAGNOSTICS);
    expect(response.body.details.diagnostics[0]).toMatchObject({ file: 'lib/broken.ts', line: 1, code: 2322 });
    expect(JSON.stringify(response.body)).not.toMatch(/\/Users\/|\/private\/|node_modules/);
    const pages = await db.collectionGroup('pages').get();
    expect(pages.docs.filter((item) => item.ref.path.startsWith(`orgs/${tenantId}/react_work_pages/`))).toHaveLength(0);
  });
});
