import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
  });
});
