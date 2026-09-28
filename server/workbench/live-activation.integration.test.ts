import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createWorkbenchApp } from './app.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createMyscubeLiveApiAdapter } from './myscube-live-api.mjs';
import { createHttpError } from '../bff/bff-utils.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('explicit live activation and credential saturation through authenticated HTTP', () => {
  const db = new Firestore({ projectId: `live-activation-${randomUUID().slice(0, 8)}` });
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'untouched-business', WORKBENCH_MODEL_PROJECT_ID: 'isolated-model', PRODUCTION_MODEL_PROJECT_ID: 'untouched-model', WORKBENCH_TENANT_ID: 'mysc' };
  const claims = (uid: string) => ({ uid, exp: Math.floor(Date.now() / 1000) + 3600 });
  const verifyToken = async (bearer: string) => {
    if (!/^Bearer actor-\d+$/.test(bearer || '')) throw createHttpError(401, '다시 로그인해 주세요.', 'unauthorized');
    return claims(bearer.slice(7));
  };
  const headers = (actor: string) => ({ authorization: `Bearer ${actor}`, 'idempotency-key': randomUUID() });
  const seed = async (count: number) => {
    const batch = db.batch();
    for (let i = 0; i < count; i++) batch.set(db.doc(`orgs/mysc/members/actor-${i}`), { role: 'admin', status: 'ACTIVE', permissionsCapturedAt: new Date().toISOString(), analyticsDatasetIds: [], analyticsScopeRevision: 'capture-v1' });
    await batch.commit();
  };
  afterAll(async () => { await db.recursiveDelete(db.doc('orgs/mysc')); await db.terminate(); });
  it.each([undefined, 'false', '', 'TRUE', 'true'])('activates only for explicit true, preserving the original env (%s)', async flag => {
    await seed(1);
    const configured = { ...env, ...(flag === undefined ? {} : { WORKBENCH_MYSCUBE_LIVE_ENABLED: flag }) };
    const factory = vi.fn(options => createMyscubeLiveApiAdapter(options));
    const app = createWorkbenchApp({ db, env: configured, verifyToken, liveAdapterFactory: factory });
    try {
      const response = await request(app).get('/api/v1/workbench-apis/endpoints').set(headers('actor-0'));
      expect(response.status).toBe(200);
      expect(response.body.items.filter((item: any) => item.id.startsWith('myscube-'))).toHaveLength(flag === 'true' ? 2 : 0);
      expect(factory).toHaveBeenCalledTimes(flag === 'true' ? 1 : 0);
      if (flag === 'true') expect(factory.mock.calls[0][0].env).toBe(configured);
    } finally { app.locals.clearLiveCredentials(); }
  });
  it('allows persisted conversation and source saves for the 101st caller without evicting existing credentials', async () => {
    await seed(101);
    const configured = { ...env, WORKBENCH_MYSCUBE_LIVE_ENABLED: 'true' };
    let credentials: any;
    const app = createWorkbenchApp({ db, env: configured, verifyToken, liveAdapterFactory: (options: any) => { credentials = options.credentialProvider; return createMyscubeLiveApiAdapter(options); } });
    const core = createIsolatedWorkbenchCore({ db, env: configured });
    const context = async (actorId: string) => { const value: any = { tenantId: 'mysc', actorId, actorRole: 'admin' }; await core.authorize(value); return value; };
    try {
      for (let i = 0; i < 100; i++) {
        const response = await request(app).get('/api/v1/workbench-apis/endpoints').set(headers(`actor-${i}`));
        expect(response.status, `actor-${i}`).toBe(200);
      }
      const last = headers('actor-100');
      const conversation = await request(app).post('/api/v1/react-work-pages/conversations').set(last).send({ title: '보관 포화에서도 저장되는 대화' });
      expect(conversation.status, JSON.stringify(conversation.body)).toBe(201);
      const saved = await request(app).post('/api/v1/react-work-pages').set(headers('actor-100')).send({ expectedVersion: 0, apis: [], source: { title: '보관 포화 저장 회귀', workspace: { schemaVersion: 1, entry: 'App.tsx', packageSetId: 'react18-tailwind4-v1', files: { 'App.tsx': 'export default function App(){return <p>저장 확인</p>}' } } } });
      expect(saved.status, JSON.stringify(saved.body)).toBe(201);
      const reopened = await request(app).get(`/api/v1/react-work-pages/${saved.body.id}`).set(headers('actor-100'));
      expect(reopened.status).toBe(200); expect(reopened.body.version).toBe(1); expect(reopened.body.source).toEqual(saved.body.source);
      await expect(credentials(await context('actor-100'))).rejects.toMatchObject({ statusCode: 401, code: 'myscube_live_auth_required' });
      expect(await credentials(await context('actor-0'))).toBe('Bearer actor-0');
      expect((await request(app).get('/api/v1/workbench-apis/endpoints').set(headers('actor-0'))).status).toBe(200);
      expect(await credentials(await context('actor-0'))).toBe('Bearer actor-0');
      expect((await request(app).get('/api/v1/workbench-apis/endpoints').set({ authorization: 'Bearer invalid' })).status).toBe(401);
      await db.doc('orgs/mysc/members/actor-100').update({ status: 'INACTIVE' });
      expect((await request(app).post('/api/v1/react-work-pages/conversations').set(headers('actor-100')).send({ title: '금지' })).status).toBe(403);
    } finally { app.locals.clearLiveCredentials(); }
  });
  it('does not swallow credential validation errors', async () => {
    await seed(1);
    const app = createWorkbenchApp({ db, env: { ...env, WORKBENCH_MYSCUBE_LIVE_ENABLED: 'true' }, verifyToken: async () => ({ ...claims('actor-0'), exp: 1 }) });
    try { expect((await request(app).get('/api/v1/workbench-apis/endpoints').set(headers('actor-0'))).status).toBe(401); }
    finally { app.locals.clearLiveCredentials(); }
  });
});
