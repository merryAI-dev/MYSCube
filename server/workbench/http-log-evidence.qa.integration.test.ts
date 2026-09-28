import { Firestore } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { importHttpLogExport } from './http-log-import.mjs';
import { createWorkbenchApp } from './app.mjs';
import { createHttpLogEvidence } from './http-log-evidence.mjs';
import { createBffApp } from '../bff/app.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('independent imported HTTP summary and source revision QA path', () => {
  const db = new Firestore({ projectId: 'demo-http-evidence-qa' }), tenantId = 'http-evidence-qa', actorId = 'alice', root = `orgs/${tenantId}`;
  const now = () => '2026-09-23T12:00:00.000Z', release = 'b'.repeat(40), receivedAt = '2026-09-22T15:00:01.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-business-http-qa', WORKBENCH_MODEL_PROJECT_ID: 'demo-http-model-qa',
    PRODUCTION_MODEL_PROJECT_ID: 'demo-business-model-qa', WORKBENCH_HTTP_LOG_IMPORT_ENABLED: 'true', WORKBENCH_HTTP_LOG_SOURCE_PROJECT_ID: 'prj_http_fixture', WORKBENCH_TENANT_ID: tenantId };
  const defaultCode = async (_input: any) => ({ items: [], status: 'test_fixture', revision: null });
  const readCode = vi.fn(defaultCode);
  const app = () => createWorkbenchApp({ db, env, now, authMode: 'headers', readCode });
  const headers = () => ({ 'x-tenant-id': tenantId, 'x-actor-id': actorId, 'idempotency-key': randomUUID() });
  function entry(id: string, payload: Record<string, unknown> = {}, at = '2026-09-22T15:00:00.000Z') {
    return { id, deploymentId: 'dpl_test', source: 'lambda', host: 'fixture.invalid', timestamp: Date.parse(at), projectId: env.WORKBENCH_HTTP_LOG_SOURCE_PROJECT_ID,
      level: 'error', type: 'stdout', environment: 'production', message: JSON.stringify({ message: 'bff.request', service: 'mysc-bff', method: 'POST',
        path: '/api/v1/project-registration-drafts/private-id/submit', statusCode: 500, latencyMs: 12, tenantId, actorId,
        requestId: 'caller-controlled', errorCode: 'synthetic_failure', deployEnvironment: 'live', releaseSha: release, ...payload }) };
  }
  const load = (entries: any[]) => importHttpLogExport({ db, env, now, input: { schemaVersion: 1, sourceSystem: 'vercel', sourceProjectId: env.WORKBENCH_HTTP_LOG_SOURCE_PROJECT_ID,
    tenantId, exportedAt: now(), period: { from: '2026-09-22T00:00:00.000Z', to: now() }, coverage: 'partial', entries } });
  const qa = (body: any = { question: '이 오류의 코드 근거', area: 'approval', eventId: 'browser-event' }) => request(app()).post('/api/v1/qa-evidence/query').set(headers()).send(body);
  beforeEach(async () => {
    readCode.mockReset(); readCode.mockImplementation(defaultCode); await db.recursiveDelete(db.doc(root));
    await db.doc(`${root}/members/${actorId}`).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now() });
    await db.doc(`${root}/client_error_events/browser-event`).set({ actorId, createdAt: receivedAt, occurredAt: receivedAt,
      clientRequestId: 'caller-controlled', requestId: 'ingest-only', ingestRelease: 'c'.repeat(40), extra: { code: 'synthetic_failure', status: 500 } });
  });
  afterAll(async () => { await db.recursiveDelete(db.doc(root)); await db.terminate(); });
  it('reports imported response samples across the Seoul day boundary without asserting an overall error rate', async () => {
    await load([entry('a', {}, '2026-09-22T14:59:59.000Z'), entry('b', { statusCode: 200 }, '2026-09-22T15:00:00.000Z')]);
    const response = await request(app()).get('/api/v1/product-operations/summary?days=7').set(headers());
    expect(response.status).toBe(200); const http = response.body.httpRequests;
    expect(http.counts).toMatchObject({ total: 2, status2xx: 1, status5xx: 1 });
    expect(http.rows.map((row: any) => row.day)).toEqual(['2026-09-22', '2026-09-23']);
    expect(http.rate).toBeNull(); expect(http.overallRate).toBeNull(); expect(http.provenance).toBe('operator_export_unverified');
  });
  it('uses the exact imported request SHA as a candidate and never substitutes the ingest release', async () => {
    await load([entry('a')]); const response = await qa();
    expect(response.status).toBe(200); expect(response.body.correlation).toBe('REQUEST_METADATA_CANDIDATE');
    expect(readCode).toHaveBeenCalledWith(expect.objectContaining({ sha: release, area: 'approval' }));
    expect(response.body.httpCoverage.provenance).toBe('operator_export_unverified');
  });
  it('withholds the SHA for repeated request IDs and for a request-ID-only question', async () => {
    await load([entry('a'), entry('b')]); let response = await qa();
    expect(response.status).toBe(200); expect(response.body.correlation).toBe('NOT_ESTABLISHED');
    expect(readCode.mock.calls.at(-1)?.[0]?.sha).toBeFalsy();
    response = await qa({ question: '요청 조회', area: 'approval', requestId: 'caller-controlled' });
    expect(response.status).toBe(200); expect(readCode.mock.calls.at(-1)?.[0]?.sha).toBeFalsy();
  });
  it('does not use another actor or an absent source release to select code', async () => {
    await load([entry('other-actor', { actorId: 'bob' }), entry('missing-sha', { releaseSha: undefined })]);
    const response = await qa(); expect(response.status).toBe(200);
    expect(readCode.mock.calls.at(-1)?.[0]?.sha).toBeFalsy();
  });
  it('blocks a persisted revoked member and never invokes code retrieval', async () => {
    await load([entry('a')]); await db.doc(`${root}/members/${actorId}`).update({ status: 'INACTIVE' });
    const response = await qa(); expect(response.status).toBe(403); expect(readCode).not.toHaveBeenCalled();
    expect(response.body.httpLogs).toBeUndefined();
  });
  it('marks a bounded actual Firestore read partial and retains no global rate', async () => {
    await load([entry('a'), entry('b')]);
    const reader = createHttpLogEvidence({ db, env, now, authorize: async () => {}, maxRecords: 1 });
    const result = await reader.summary({ tenantId, actorId, actorRole: 'admin' }, { from: '2026-09-17', to: '2026-09-23', queriedAt: now() });
    expect(result.truncated).toBe(true); expect(result.status).toBe('partial'); expect(result.counts.total).toBe(1); expect(result.rate).toBeNull();
  });
  it('rejects an observation cloned under a different document ID instead of double counting', async () => {
    await load([entry('a')]); const original = (await db.collection(`${root}/workbench_http_requests`).get()).docs[0];
    await original.ref.parent.doc('copied-under-wrong-identity').set(original.data());
    const response = await request(app()).get('/api/v1/product-operations/summary?days=7').set(headers());
    expect(response.status).toBe(200); expect(response.body.httpRequests.counts.total).toBe(1);
    expect(response.body.httpRequests.invalidRecords).toBe(1); expect(response.body.httpRequests.status).toBe('partial');
  });
  it('accepts a real existing BFF finish payload without requiring route-specific telemetry fields', async () => {
    const sourceDb = new Firestore({ projectId: 'demo-http-producer-qa' });
    const lines: string[] = []; const spy = vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.map(String).join(' ')); });
    try {
      const producer = createBffApp({ projectId: sourceDb.projectId, db: sourceDb, authMode: 'headers', workerSecret: 'synthetic-worker-secret' });
      const response = await request(producer).get('/api/v1/projects?limit=1').set({ ...headers(), 'x-actor-role': 'admin' });
      expect(response.status).toBe(200);
      const emitted = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).find(item => item?.message === 'bff.request');
      expect(emitted).toMatchObject({ method: 'GET', path: '/api/v1/projects', tenantId, statusCode: 200 });
      expect(emitted.operationKey).toBeUndefined(); expect(emitted.deployEnvironment).toBeUndefined();
      await load([{ ...entry('real-producer'), environment: 'preview', message: JSON.stringify(emitted) }]);
      const summary = await request(app()).get('/api/v1/product-operations/summary?days=7').set(headers());
      expect(summary.status).toBe(200); expect(summary.body.httpRequests.counts).toMatchObject({ total: 1, status2xx: 1 });
      expect(summary.body.httpRequests.rows[0].environment).toBe('preview');
      expect((await sourceDb.collection(`${root}/projects`).get()).size).toBe(0);
    } finally { spy.mockRestore(); await sourceDb.recursiveDelete(sourceDb.doc(root)); await sourceDb.terminate(); }
  });
  it('withholds the entire actual QA response when persisted membership is revoked during code retrieval', async () => {
    await load([entry('a')]);
    readCode.mockImplementation(async () => {
      await db.doc(`${root}/members/${actorId}`).update({ status: 'INACTIVE' });
      return { items: [], status: 'test_fixture', revision: null };
    });
    const response = await qa();
    expect(response.status).toBe(403); expect(readCode).toHaveBeenCalledTimes(1);
    expect(response.body.httpLogs).toBeUndefined(); expect(response.body.github).toBeUndefined(); expect(response.body.facts).toBeUndefined();
  });
  it('rejects a completed HTTP summary when persisted membership changes after its first authorization', async () => {
    await load([entry('a')]); let checks = 0;
    const reader = createHttpLogEvidence({ db, env, now, authorize: async () => {
      const ref = db.doc(`${root}/members/${actorId}`), member = (await ref.get()).data();
      if (member?.status !== 'ACTIVE') throw Object.assign(new Error('revoked'), { statusCode: 403 });
      if (++checks === 1) await ref.update({ status: 'INACTIVE' });
    } });
    await expect(reader.summary({ tenantId, actorId, actorRole: 'admin' }, { from: '2026-09-17', to: '2026-09-23', queriedAt: now() }))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});
