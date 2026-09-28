import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createWorkbenchApp } from './app.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('Remote preview HTTP contract with real compiler and permission store (broker protocol fixture)', () => {
  const db = new Firestore({ projectId: 'demo-remote-http' }), tenantId = `remote-${randomUUID()}`, root = `orgs/${tenantId}`;
  const now = () => '2026-09-23T10:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-business-source', WORKBENCH_MODEL_PROJECT_ID: 'demo-remote-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-business-model', WORKBENCH_REMOTE_RUNTIME_ENABLED: 'true' };
  const headers = () => ({ 'x-tenant-id': tenantId, 'x-actor-id': 'A', 'idempotency-key': randomUUID() });
  const input = { source: { title: '실행 경계', code: "import React from 'react';export default function App(){return <h1>실행 경계</h1>}" }, apis: [] };
  let received: any, revoke = false, closed: string[] = [], sequence = 0;
  const id = randomUUID(), frame = () => ({ pngBase64: 'fixture', width: 1100, height: 700, sequence: ++sequence });
  const app = createWorkbenchApp({ db, env, now, authMode: 'headers', remoteBrokerFactory: () => ({
    create: async (_context: any, value: any) => { received = value; if (revoke) await db.doc(`${root}/members/A`).update({ status: 'INACTIVE' }); return { sessionId: id, frame: frame(), expiresAt: '2026-09-23T10:05:00.000Z' }; },
    frame: async () => frame(), event: async () => frame(), close: async (_context: any, value: string) => { closed.push(value); }, closeAll() {},
  }) });
  beforeEach(async () => { closed = []; revoke = false; await db.doc(`${root}/members/A`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now(), analyticsDatasetIds: [], analyticsScopeRevision: '1' }); });
  afterAll(async () => { app.locals.remoteRuntime.closeAll(); await db.recursiveDelete(db.doc(root)); await db.terminate(); });
  it('compiles source server-side, pins its hash and wraps create/frame/event responses consistently', async () => {
    const previousSessionId = randomUUID();
    const created = await request(app).post('/api/v1/react-work-pages/remote').set(headers()).send({ ...input, previousSessionId });
    expect(created.status).toBe(200); expect(created.body).toMatchObject({ sessionId: id, frame: { sequence: 1 }, evidence: {} });
    expect(received.sourceHash).toBe(received.artifact.sourceHash); expect(received.sourceHash).toMatch(/^[a-f0-9]{64}$/); expect(received.previousSessionId).toBe(previousSessionId);
    expect((await request(app).get(`/api/v1/react-work-pages/remote/${id}`).set(headers())).body).toMatchObject({ sessionId: id, frame: { sequence: 2 }, evidence: {} });
    expect((await request(app).post(`/api/v1/react-work-pages/remote/${id}/events`).set(headers()).send({ type: 'click', x: 20, y: 20 })).body).toMatchObject({ sessionId: id, frame: { sequence: 3 }, evidence: {} });
    expect((await request(app).post('/api/v1/react-work-pages/remote').set(headers()).send({ ...input, artifact: { bundle: 'forged' } })).status).toBe(400);
  });
  it('closes a newly created candidate if access is revoked during execution preparation', async () => {
    revoke = true;
    const response = await request(app).post('/api/v1/react-work-pages/remote').set(headers()).send(input);
    expect(response.status).toBe(403); expect(closed).toEqual([id]); expect(response.body).not.toHaveProperty('frame');
  });
  it('passes the accessible view choice through the authenticated compiler route and rejects unknown modes', async () => {
    const created = await request(app).post('/api/v1/react-work-pages/remote').set(headers()).send({ ...input, viewMode: 'dom' });
    expect(created.status).toBe(200);
    expect(received.viewMode).toBe('dom');
    expect(received.sourceHash).toBe(received.artifact.sourceHash);
    received = null;
    const invalid = await request(app).post('/api/v1/react-work-pages/remote').set(headers()).send({ ...input, viewMode: 'html' });
    expect(invalid.status).toBe(400);
    expect(received).toBeNull();
    const legacy = await request(app).post('/api/v1/react-work-pages/remote').set(headers()).send(input);
    expect(legacy.status).toBe(200);
    expect(received.viewMode).toBeUndefined();
    for (const injection of [{ apiBudgets: {} }, { timeoutMs: 55000 }, { apis: [{ id: randomUUID(), version: 1, timeoutMs: 55000 }] }]) {
      received = null;
      expect((await request(app).post('/api/v1/react-work-pages/remote').set(headers()).send({ ...input, ...injection })).status).toBe(400);
      expect(received).toBeNull();
    }
  });
});


suite('trusted company budget from persisted registered versions over HTTP', () => {
  const db = new Firestore({ projectId: 'demo-remote-api-budget' }), tenantId = `budget-${randomUUID()}`, root = `orgs/${tenantId}`;
  const now = () => new Date().toISOString();
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-untouched-source', WORKBENCH_MODEL_PROJECT_ID: 'demo-budget-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-untouched-model', WORKBENCH_REMOTE_RUNTIME_ENABLED: 'true', WORKBENCH_REMOTE_RUNTIME_DRIVER: 'docker-host', WORKBENCH_MYSCUBE_LIVE_ENABLED: 'true', WORKBENCH_MYSCUBE_COMPANY_SUMMARY_ENABLED: 'true', WORKBENCH_TENANT_ID: tenantId };
  const headers = () => ({ authorization: 'Bearer synthetic-budget-actor', 'idempotency-key': randomUUID() });
  const definition = (version = 1, enabled = true) => ({ name: '합성 회사 집계', description: '시간 예산 계약 검증', kind: 'external-read', enabled, parameters: {}, endpointId: 'myscube-company-cashflow-summary', endpointVersion: version });
  const endpoint = (id: string, version: number) => ({ id, version, parameters: {}, contractHash: 'b'.repeat(64), responseSchema: { type: 'object', properties: { value: { type: 'string', maxLength: 20 } }, required: ['value'], additionalProperties: false } });
  let received: any;
  const invoke = vi.fn(async (_context: unknown, _id: string, _version: number, _input: unknown, _options: { signal?: AbortSignal }) => ({ truncated: false, data: { value: 'synthetic' }, metadata: { source: 'fixture', endpointId: 'myscube-company-cashflow-summary', endpointVersion: 1, asOf: now(), resultScope: 'fixture' } }));
  const app = createWorkbenchApp({ db, env, now, verifyToken: async () => ({ uid: 'A', exp: Math.floor(Date.now() / 1000) + 3600 }),
    liveAdapterFactory: () => ({ list: () => ({ items: [] }), get: (_context: any, id: string, version: number) => endpoint(id, version), invoke }),
    remoteBrokerFactory: () => ({ create: async (_context: any, value: any) => { received = value; return { sessionId: randomUUID(), frame: { sequence: 1, pngBase64: 'fixture', width: 640, height: 480 }, expiresAt: new Date(Date.now() + 300000).toISOString() }; }, closeAll() {}, revokeOwner() {} }),
  });
  beforeEach(async () => { await db.doc(`${root}/members/A`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now(), analyticsDatasetIds: [], analyticsScopeRevision: '1' }); });
  afterAll(async () => { app.locals.remoteRuntime.closeAll(); app.locals.clearLiveCredentials(); await db.recursiveDelete(db.doc(root)); await db.terminate(); });
  it('uses authorized immutable endpoint pins, rejects disabled/latest and revoked access, and preserves exact versions', async () => {
    const saved = await request(app).post('/api/v1/workbench-apis').set(headers()).send({ expectedVersion: 0, definition: definition() });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201); const id = saved.body.id;
    const source = { title: '합성 시간 예산', code: 'export default function App(){return <h1>합성 검증</h1>}' };
    const preview = (version: number) => request(app).post('/api/v1/react-work-pages/remote').set(headers()).send({ source, apis: [{ id, version }] });
    expect((await preview(1)).status).toBe(200); expect(received.apiBudgets).toEqual({ [id]: 55000 });
    env.WORKBENCH_MYSCUBE_COMPANY_SUMMARY_ENABLED = 'false'; expect((await preview(1)).status).toBe(200); expect(received.apiBudgets).toEqual({ [id]: 10000 });
    env.WORKBENCH_MYSCUBE_COMPANY_SUMMARY_ENABLED = 'true';
    expect((await request(app).put(`/api/v1/workbench-apis/${id}`).set(headers()).send({ expectedVersion: 1, definition: definition(2) })).status).toBe(200);
    expect((await preview(2)).status).toBe(200); expect(received.apiBudgets).toEqual({ [id]: 10000 });
    expect((await preview(1)).status).toBe(200); expect(received.apiBudgets).toEqual({ [id]: 55000 });
    expect((await request(app).put(`/api/v1/workbench-apis/${id}`).set(headers()).send({ expectedVersion: 2, definition: definition(2, false) })).status).toBe(200);
    received = null; expect((await preview(1)).status).toBe(409); expect(received).toBeNull();
    await db.doc(`${root}/members/A`).update({ status: 'INACTIVE' }); expect((await preview(1)).status).toBe(403); expect(received).toBeNull(); expect(invoke).not.toHaveBeenCalled();
  });
  it('uses the same server-only budget for registered API tests and rejects client timeout injection', async () => {
    const saved = await request(app).post('/api/v1/workbench-apis').set(headers()).send({ expectedVersion: 0, definition: definition() });
    expect(saved.status).toBe(201); const id = saved.body.id;
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const call = () => request(app).post(`/api/v1/workbench-apis/${id}/test`).set(headers()).send({ version: 1, input: {} });
      invoke.mockImplementationOnce(async (_context, _id, _version, _input, { signal }) => { await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 11200); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('synthetic deadline')); }, { once: true }); }); return { truncated: false, data: { value: 'synthetic delayed' }, metadata: { source: 'fixture', endpointId: 'myscube-company-cashflow-summary', endpointVersion: 1, asOf: now(), resultScope: 'fixture' } }; });
      const first = await call(); expect(first.status, JSON.stringify(first.body)).toBe(200); expect(timeout).toHaveBeenCalledWith(55000);
      timeout.mockClear(); env.WORKBENCH_MYSCUBE_COMPANY_SUMMARY_ENABLED = 'false';
      expect((await call()).status).toBe(200); expect(timeout).toHaveBeenCalledWith(10000); expect(timeout).not.toHaveBeenCalledWith(55000);
      timeout.mockClear(); expect((await request(app).post(`/api/v1/workbench-apis/${id}/test`).set(headers()).send({ version: 1, input: {}, timeoutMs: 55000 })).status).toBe(400); expect(timeout).not.toHaveBeenCalledWith(55000);
    } finally { timeout.mockRestore(); env.WORKBENCH_MYSCUBE_COMPANY_SUMMARY_ENABLED = 'true'; }
  });
});
