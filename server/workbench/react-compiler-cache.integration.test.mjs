import { createHash, randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async importOriginal => { const actual = await importOriginal(); return { ...actual, spawn: vi.fn(actual.spawn) }; });
import { spawn } from 'node:child_process';
import { createWorkbenchApp } from './app.mjs';
import { ReactCompiledArtifactSchema } from '../../shared/workbench-react-workspace.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('completed compiler reuse through actual generation, authenticated HTTP and emulator persistence', () => {
  const db = new Firestore({ projectId: 'demo-compiler-cache' }), tenantId = `compiler-cache-${randomUUID()}`, root = `orgs/${tenantId}`;
  const now = () => '2026-09-28T01:00:00.000Z', actorId = 'synthetic-author', apiId = randomUUID();
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-untouched-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-cache-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-untouched-model',
    WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'offline-fixture-only', WORKBENCH_AUTH_MODE: 'emulator', WORKBENCH_APP_ORIGIN: 'http://127.0.0.1:4178', WORKBENCH_REACT_RUNTIME_URL: 'http://127.0.0.1:8792/runtime' };
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const definition = { kind: 'analytics-copy', enabled: true, name: '합성 사본 연결', description: '캐시 경계 검사용 공개 합성 정의', parameters: {}, plan: { kind: 'table', datasetId: 'synthetic_records', aggregate: { op: 'count_rows' } } };
  const apiRef = db.doc(`${root}/workbench_api_owners/${hash(actorId)}/apis/${apiId}`), member = db.doc(`${root}/members/${actorId}`);
  const source = { title: '합성 연결 화면', workspace: { schemaVersion: 1, entry: 'App.tsx', packageSetId: 'react18-tailwind4-v1', files: {
    'App.tsx': `import {useState} from 'react';export default function App(){const [n,setN]=useState(0);return <button className="p-4" onClick={()=>{void window.workbench.callApi('${apiId}',{}).then(value=>setN(value.rows.length))}}>조회 {n}</button>}`,
  } } };
  const refs = [{ id: apiId, version: 1 }], body = { source, apis: refs };
  const completion = vi.fn(async () => ({ tool_calls: [{ function: { name: 'render_react_source', arguments: JSON.stringify({ ...source, workspace: { ...source.workspace, files: Object.entries(source.workspace.files).map(([path, content]) => ({ path, content })) } }) } }] }));
  const headers = () => ({ 'x-tenant-id': tenantId, 'x-actor-id': actorId, 'idempotency-key': randomUUID() });
  let revoke = false, generation = 0;
  const created = [], closed = [];
  const broker = { create: vi.fn(async (_context, input) => {
    created.push(input); if (revoke) await member.update({ status: 'INACTIVE' });
    return { sessionId: randomUUID(), frame: { pngBase64: 'synthetic-protocol-fixture', width: 1100, height: 700, sequence: 1 }, expiresAt: '2026-09-28T01:05:00.000Z' };
  }), close: vi.fn(async (_context, id) => { closed.push(id); }), frame: vi.fn(), event: vi.fn(), revokeOwner: vi.fn(), closeAll() {} };
  const app = createWorkbenchApp({ db, env, now, authMode: 'headers', reactCompletionFactory: () => completion });
  const remote = createWorkbenchApp({ db, env: { ...env, WORKBENCH_REMOTE_RUNTIME_ENABLED: 'true' }, now, authMode: 'headers', reactCompletionFactory: () => completion, remoteBrokerFactory: () => broker });
  const compiles = () => spawn.mock.calls.filter(([, args]) => args?.some(arg => typeof arg === 'string' && arg.endsWith('/react-compiler-worker.mjs'))).length;
  beforeEach(async () => {
    await db.recursiveDelete(db.doc(root)); spawn.mockClear(); completion.mockClear(); broker.create.mockClear(); broker.close.mockClear(); created.length = 0; closed.length = 0; revoke = false;
    await member.set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now(), analyticsDatasetIds: ['synthetic_records'], analyticsScopeRevision: String(++generation) });
    const registered = { id: apiId, version: 1, definition, definitionHash: hash(definition), updatedAt: now(), updatedBy: actorId };
    await apiRef.set(registered); await apiRef.collection('versions').doc('1').set(registered);
  });
  afterAll(async () => { remote.locals.remoteRuntime.closeAll(); await db.recursiveDelete(db.doc(root)); await db.terminate(); });
  it('runs one real compiler child across generated flattened APIs, local/remote preview records and persisted save', async () => {
    const generated = await request(app).post('/api/v1/react-work-pages/generate').set(headers()).send({ prompt: '연결한 API로 조회하는 합성 화면을 만들어 주세요.', apis: refs });
    expect(generated.status, JSON.stringify(generated.body)).toBe(200); expect(generated.body.source).toEqual(source);
    const artifact = ReactCompiledArtifactSchema.parse(generated.body.artifact);
    expect(compiles()).toBe(1); expect(completion).toHaveBeenCalledTimes(1);
    const preview = await request(app).post('/api/v1/react-work-pages/preview').set(headers()).send(body);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200); const { executionId, ...previewArtifact } = preview.body;
    expect(executionId).toMatch(/^[a-f0-9-]{36}$/); expect(previewArtifact).toEqual(artifact);
    const remoteResult = await request(remote).post('/api/v1/react-work-pages/remote').set(headers()).send(body);
    expect(remoteResult.status, JSON.stringify(remoteResult.body)).toBe(200); expect(created[0].artifact).toEqual(artifact);
    const saved = await request(app).post('/api/v1/react-work-pages').set(headers()).send({ ...body, expectedVersion: 0 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201); expect(saved.body.artifact).toEqual(artifact); expect(compiles()).toBe(1);
    const reopened = await request(app).get(`/api/v1/react-work-pages/${saved.body.id}`).set(headers());
    expect(reopened.body.source).toEqual(source); expect(reopened.body.artifact).toEqual(artifact); expect(reopened.body.version).toBe(1);
  });
  it('shares a completed persistent-conversation proposal with preview/save without trusting a client cache field', async () => {
    const session = await request(app).post('/api/v1/react-work-pages/conversations').set(headers()).send({ title: '합성 대화' }); expect(session.status).toBe(201);
    const turn = await request(app).post(`/api/v1/react-work-pages/conversations/${session.body.id}/turns`).set(headers()).send({ expectedVersion: 0, requestId: randomUUID(), message: '연결 API의 화면을 만들어 주세요.', mode: 'react', apis: refs });
    expect(turn.status, JSON.stringify(turn.body)).toBe(200); expect(turn.body.result.source).toEqual(source); expect(compiles()).toBe(1);
    const preview = await request(app).post('/api/v1/react-work-pages/preview').set(headers()).send(body); expect(preview.status).toBe(200);
    const saved = await request(app).post('/api/v1/react-work-pages').set(headers()).send({ ...body, expectedVersion: 0 }); expect(saved.status).toBe(201);
    expect(compiles()).toBe(1);
    const forged = await request(remote).post('/api/v1/react-work-pages/remote').set(headers()).send({ ...body, cacheContext: { tenantId, actorId } });
    expect(forged.status).toBe(400); expect(broker.create).not.toHaveBeenCalled();
  });
  it('still checks permission and API availability before and after a cache-hit remote creation', async () => {
    expect((await request(remote).post('/api/v1/react-work-pages/remote').set(headers()).send(body)).status).toBe(200);
    revoke = true;
    const revokedDuring = await request(remote).post('/api/v1/react-work-pages/remote').set(headers()).send(body);
    expect(revokedDuring.status).toBe(403); expect(revokedDuring.body).not.toHaveProperty('frame'); expect(closed).toHaveLength(1); expect(compiles()).toBe(1);
    const revokedBefore = await request(remote).post('/api/v1/react-work-pages/remote').set(headers()).send(body);
    expect(revokedBefore.status, JSON.stringify(revokedBefore.body)).toBe(403); expect(broker.create).toHaveBeenCalledTimes(2); expect(broker.revokeOwner).toHaveBeenCalled();
    await member.update({ status: 'ACTIVE' }); const disabled = { ...definition, enabled: false }; await apiRef.update({ definition: disabled, definitionHash: hash(disabled) });
    const unavailable = await request(remote).post('/api/v1/react-work-pages/remote').set(headers()).send(body);
    expect(unavailable.status).toBe(409); expect(broker.create).toHaveBeenCalledTimes(2); expect(compiles()).toBe(1);
  });
  it('keeps the existing request admission limit on warm compiler hits', async () => {
    for (let i = 0; i < 12; i++) {
      const response = await request(remote).post('/api/v1/react-work-pages/remote').set(headers()).send(body);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    const denied = await request(remote).post('/api/v1/react-work-pages/remote').set(headers()).send(body);
    expect(denied.status).toBe(429); expect(broker.create).toHaveBeenCalledTimes(12); expect(compiles()).toBe(1);
  });
});
