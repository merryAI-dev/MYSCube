import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import request from 'supertest';
import { createWorkbenchApp } from './app.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createAnalyticsService } from './analytics-service.mjs';
import { createMyscubeLiveApiAdapter } from './myscube-live-api.mjs';
import { createHttpError } from '../bff/bff-utils.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('independent authenticated live API persistence and deferred renderer bridge', () => {
  const db = new Firestore({ projectId: `demo-live-qa-${randomUUID().slice(0, 8)}` });
  const tenantId = 'mysc', actorId = 'qa-admin', prefix = `orgs/${tenantId}`;
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-untouched-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-live-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-other-model', WORKBENCH_TENANT_ID: tenantId, WORKBENCH_MYSCUBE_LIVE_ENABLED: 'true', WORKBENCH_REMOTE_RUNTIME_ENABLED: 'true', WORKBENCH_REMOTE_RUNTIME_DRIVER: 'docker-host' };
  const tokens = { initial: 'Bearer qa-secret-canary-initial', rotated: 'Bearer qa-secret-canary-rotated', other: 'Bearer qa-secret-canary-other' };
  let app: any, callApi: any, core: any, analytics: any, revoked: Set<string>, sent: any[], verifyCount: number;
  let transportHook: null | (() => Promise<void>);
  const headers = (token = tokens.initial) => ({ authorization: token, 'idempotency-key': randomUUID() });
  const ctx = () => ({ tenantId, actorId, actorRole: 'admin' });
  const raw = () => ({ items: [{ id: 'synthetic-project', name: '합성 사업', status: 'RAW', cic: null, contractStart: '', contractEnd: null, contractEndUndecided: false, updatedAt: null, trashedAt: '', ownerEmail: 'must-not-expose@example.invalid' }], count: 1, nextCursor: null });
  beforeEach(async () => {
    await db.recursiveDelete(db.doc(prefix)); revoked = new Set(); sent = []; verifyCount = 0; transportHook = null;
    for (const id of [actorId, 'other-admin']) await db.doc(`${prefix}/members/${id}`).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: new Date().toISOString(), analyticsDatasetIds: [], analyticsScopeRevision: 'live-qa-v1' });
    core = createIsolatedWorkbenchCore({ db, env }); analytics = createAnalyticsService({ db });
    app = createWorkbenchApp({ db, env, verifyToken: async (bearer: string) => {
      verifyCount++; if (!Object.values(tokens).includes(bearer) || revoked.has(bearer)) throw createHttpError(401, '다시 로그인해 주세요.', 'unauthorized');
      return { uid: bearer === tokens.other ? 'other-admin' : actorId, exp: Math.floor(Date.now() / 1000) + 3600 };
    }, liveAdapterFactory: (options: any) => createMyscubeLiveApiAdapter({ ...options, resolveDns: async () => [{ address: '8.8.8.8', family: 4 }], transport: async (options: any) => {
      sent.push(options); await transportHook?.(); return raw();
    } }), remoteBrokerFactory: (options: any) => { callApi = options.callApi; return { closeAll() {}, revokeOwner() {}, activeSessions: 0, reservedSessions: 0, cleanupStatus: [] }; } });
  });
  afterEach(() => app.locals.remoteRuntime.shutdown());
  afterAll(async () => { await db.recursiveDelete(db.doc(prefix)); await db.terminate(); });
  async function register() {
    const endpoints = await request(app).get('/api/v1/workbench-apis/endpoints').set(headers()); expect(endpoints.status).toBe(200);
    const endpoint = endpoints.body.items.find((item: any) => item.id === 'myscube-projects'); expect(endpoint).toBeTruthy();
    const definition = { kind: 'external-read', name: '실시간 합성 API', description: '인증 위임 회귀', enabled: true, endpointId: endpoint.id, endpointVersion: endpoint.version, parameters: endpoint.parameters };
    const key = randomUUID(); const first = await request(app).post('/api/v1/workbench-apis').set({ ...headers(), 'idempotency-key': key }).send({ expectedVersion: 0, definition }); expect(first.status).toBe(201);
    const repeated = await request(app).post('/api/v1/workbench-apis').set({ ...headers(), 'idempotency-key': key }).send({ expectedVersion: 0, definition }); expect(repeated.status).toBe(201); expect(repeated.body.id).toBe(first.body.id);
    return first.body;
  }
  it('persists exact immutable API and actual live evidence without credential or excluded fields', async () => {
    const api = await register(); const output = await request(app).post(`/api/v1/workbench-apis/${api.id}/test`).set(headers()).send({ version: 1, input: { limit: 20 } });
    expect(output.status).toBe(200); expect(sent).toHaveLength(1); expect(sent[0].url.origin).toBe('https://myscube.myscguard.app'); expect(sent[0].url.pathname).toBe('/api/v1/projects'); expect(sent[0].headers.Authorization).toBe(tokens.initial); expect(verifyCount).toBeGreaterThan(4);
    expect(output.body.data.items[0]).toMatchObject({ document_id: null, contract_start_raw: '', contract_start: null, contract_end: null, contract_end_undecided: false, cic: null, trashed_at_raw: '' });
    expect(output.body.metadata.resultScope).toBe('THIS_PAGE_ONLY'); expect(output.body.evidenceId).toMatch(/^[a-f0-9-]{36}$/);
    const context = ctx(); await core.authorize(context); const evidence = await analytics.evidence(context, output.body.evidenceId);
    expect(evidence).toMatchObject({ kind: 'registered-api', apiId: api.id, apiVersion: 1, definitionHash: api.definitionHash, endpointHash: api.endpointHash, input: { limit: 20 }, data: output.body.data, truncated: false });
    const publicEvidence = await request(app).get(`/api/v1/html-work-pages/evidence/${output.body.evidenceId}`).set(headers()); expect(publicEvidence.status).toBe(200); expect(publicEvidence.body).toMatchObject({ kind: 'registered-api', apiId: api.id, apiVersion: 1, definitionHash: api.definitionHash, endpointHash: api.endpointHash, input: { limit: 20 }, data: output.body.data });
    const owner = createHash('sha256').update(JSON.stringify(actorId)).digest('hex'), ref = db.doc(`${prefix}/workbench_api_owners/${owner}/apis/${api.id}`);
    expect((await ref.collection('versions').get()).size).toBe(1); const calls = await ref.collection('calls').get(); expect(calls.size).toBe(1); expect(calls.docs[0].data()).toMatchObject({ state: 'completed', evidenceId: output.body.evidenceId });
    const persisted: unknown[] = []; async function walk(ref: any) { const snap = await ref.get(); if (snap.exists) persisted.push(snap.data()); for (const collection of await ref.listCollections()) for (const doc of (await collection.get()).docs) await walk(doc.ref); }
    await walk(db.doc(prefix)); const all = JSON.stringify({ persisted, output: output.body, api });
    for (const token of Object.values(tokens)) expect(all).not.toContain(token); expect(all).not.toContain('must-not-expose');
    const other = await request(app).post(`/api/v1/workbench-apis/${api.id}/test`).set(headers(tokens.other)).send({ version: 1, input: {} }); expect(other.status).toBeGreaterThanOrEqual(400); expect(sent).toHaveLength(1); expect(other.body).not.toHaveProperty('data');
  });
  it('uses a newer validated HTTP credential for the existing renderer callback and fails closed after revocation', async () => {
    const api = await register(), context: any = ctx(); await core.authorize(context); context.remoteEvidence = {};
    const refreshed = await request(app).get('/api/v1/workbench-apis').set(headers(tokens.rotated)); expect(refreshed.status).toBe(200);
    const output = await callApi(context, { apiId: api.id, apiVersion: 1, input: { limit: 1 } });
    expect(sent[0].headers.Authorization).toBe(tokens.rotated); expect(context.remoteEvidence[api.id]).toEqual({ evidenceId: output.evidenceId }); expect(JSON.stringify(context)).not.toContain('qa-secret');
    expect((await analytics.evidence(context, output.evidenceId)).data).toEqual(output.data);
    revoked.add(tokens.rotated); await expect(callApi(context, { apiId: api.id, apiVersion: 1, input: {} })).rejects.toMatchObject({ statusCode: 401 }); expect(sent).toHaveLength(1);
  });
  it('discards the upstream result if membership is revoked during the actual request', async () => {
    const api = await register(), context: any = ctx(); await core.authorize(context); transportHook = async () => { await db.doc(`${prefix}/members/${actorId}`).update({ status: 'INACTIVE' }); };
    const result = await request(app).post(`/api/v1/workbench-apis/${api.id}/test`).set(headers()).send({ version: 1, input: {} }); expect(result.status).toBe(403); expect(sent).toHaveLength(1); expect(result.body).not.toHaveProperty('data'); expect(result.body).not.toHaveProperty('evidenceId');
    const owner = createHash('sha256').update(JSON.stringify(actorId)).digest('hex'); const calls = await db.collection(`${prefix}/workbench_api_owners/${owner}/apis/${api.id}/calls`).get(); expect(calls.docs.map(doc => doc.data().state)).toEqual(['failed']);
    expect((await db.collection(`${prefix}/axr_analytics/${context.analyticsScope.fingerprint}/evidence`).get()).size).toBe(0);
  });
});
