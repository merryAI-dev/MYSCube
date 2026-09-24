import { createHash, randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorkbenchApp } from './app.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createReactPageService } from './react-pages.mjs';
import { compileReactPreview } from './react-compiler.mjs';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const stable = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

suite('independent canonical workspace persistence and genuine legacy receipts', () => {
  const db = new Firestore({ projectId: 'demo-workspace-independent-qa' });
  const tenantId = 'workspace-independent-qa', actorId = 'workspace-author', root = `orgs/${tenantId}`;
  const now = () => '2026-09-24T09:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-untouched-business',
    WORKBENCH_MODEL_PROJECT_ID: 'demo-workspace-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-untouched-model' };
  const core = createIsolatedWorkbenchCore({ db, env, now });
  const app = createWorkbenchApp({ db, env, now, authMode: 'headers' });
  const pages = createReactPageService({ db, now, authorize: core.authorize, apis: { get: async () => { throw new Error('No API fixture should be invoked'); } } });
  const collection = db.collection(`${root}/react_work_pages/${hash(actorId)}/pages`);
  const headers = (key = randomUUID()) => ({ 'x-tenant-id': tenantId, 'x-actor-id': actorId, 'idempotency-key': key });
  const context = async (rawKey = randomUUID()) => {
    const value: any = { tenantId, actorId, actorRole: 'admin' };
    await core.authorize(value);
    value.idempotencyKey = hash(`${rawKey}:${value.analyticsScope.fingerprint}`);
    return value;
  };
  const source = () => ({ title: '여러 파일 실제 저장', workspace: { schemaVersion: 1, entry: 'App.tsx', packageSetId: 'react18-tailwind4-v1', files: {
    'App.tsx': "import Card from './components/Card'; export default function App(){return <Card label='확인'/>}",
    'components/Card.tsx': "import {suffix} from '../lib/text'; export default function Card({label}:{label:string}){return <h1>{label+suffix}</h1>}",
    'lib/text.ts': "export const suffix: string = ' 완료';",
  } } });
  beforeEach(async () => {
    await db.recursiveDelete(db.doc(root));
    await db.doc(`${root}/members/${actorId}`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now(), analyticsDatasetIds: [], analyticsScopeRevision: '1' });
  });
  afterAll(async () => { await db.recursiveDelete(db.doc(root)); await db.terminate(); });

  it('reads and replays raw legacy hash/receipt without rewriting; only explicit save and restore create canonical revisions', async () => {
    const key = randomUUID(), ctx = await context(key), id = randomUUID();
    const legacy = { title: '예전 단일 파일', code: 'export default function App(){return <h1>기존 원문</h1>}' };
    const compiled = await compileReactPreview(legacy);
    // The old storage contract predates workspaceHash, irrespective of the current compiler output shape.
    const { workspaceHash: _newIdentity, ...artifact } = compiled;
    artifact.sourceHash = hash(legacy.code);
    const record = { id, version: 1, source: legacy, sourceHash: hash(legacy.code), artifact, apis: [], updatedAt: now(), updatedBy: actorId, restoredFrom: null };
    const input = { expectedVersion: 0, source: legacy, apis: [] };
    const receipt = { kind: 'react-page', actorId, tenantId, scopeFingerprint: ctx.analyticsScope.fingerprint,
      pageId: id, version: 1, payloadHash: hash(stable({ id: null, request: input, restoredFrom: null })), sourceHash: hash(legacy.code), apis: [], completedAt: now() };
    await collection.doc(id).set(record); await collection.doc(id).collection('versions').doc('1').set(record);
    const receiptRef = db.doc(`${root}/workbench_mutation_results/${hash(ctx.idempotencyKey)}`); await receiptRef.set(receipt);
    const before = (await collection.doc(id).get()).updateTime;
    const got = await request(app).get(`/api/v1/react-work-pages/${id}`).set(headers());
    expect(got.status).toBe(200); expect(got.body.source).toEqual(legacy); expect(got.body.sourceHash).toBe(hash(legacy.code));
    expect(await pages.save(ctx, null, input)).toEqual(record);
    const recovered = await request(app).get(`/api/v1/workbench-requests/${key}`).query({ path: '/react-work-pages', method: 'POST' }).set(headers());
    expect(recovered.status).toBe(200); expect(recovered.body).toMatchObject({ state: 'completed', body: record });
    expect((await pages.history(ctx, id)).items).toHaveLength(1);
    expect((await collection.doc(id).get()).updateTime?.isEqual(before!)).toBe(true);
    expect((await receiptRef.get()).data()).toEqual(receipt);
    const saved = await pages.save(await context(), id, { expectedVersion: 1, source: source(), apis: [] });
    expect(saved.version).toBe(2); expect(saved.source.workspace.files).toEqual(source().workspace.files);
    const restored = await pages.restore(await context(), id, { expectedVersion: 2, version: 1 });
    expect(restored).toMatchObject({ version: 3, restoredFrom: 1, source: { workspace: { files: { 'App.tsx': legacy.code } } } });
    expect(restored.sourceHash).not.toBe(record.sourceHash);
    expect((await collection.doc(id).collection('versions').doc('1').get()).data()).toEqual(record);
  });

  it('persists three files through real HTTP, recovers exact receipt and replays without a second document/version', async () => {
    const key = randomUUID(), body = { expectedVersion: 0, source: source(), apis: [] };
    const saved = await request(app).post('/api/v1/react-work-pages').set(headers(key)).send(body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const canonical = JSON.stringify({ schemaVersion: 1, entry: 'App.tsx', packageSetId: 'react18-tailwind4-v1', files: Object.fromEntries(Object.entries(body.source.workspace.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) });
    expect(saved.body.sourceHash).toBe(hash(canonical));
    expect(saved.body.artifact).toMatchObject({ sourceHash: hash(canonical), workspaceHash: hash(canonical) });
    const recovery = await request(app).get(`/api/v1/workbench-requests/${key}`).query({ path: '/react-work-pages', method: 'POST' }).set(headers());
    expect(recovery.body).toMatchObject({ state: 'completed', body: { id: saved.body.id, source: body.source, version: 1 } });
    const replay = await request(app).post('/api/v1/react-work-pages').set(headers(key)).send(body);
    expect(replay.status).toBe(201); expect(replay.body.id).toBe(saved.body.id);
    expect((await collection.get()).size).toBe(1);
    expect((await collection.doc(saved.body.id).collection('versions').get()).size).toBe(1);
    expect((await request(app).get(`/api/v1/react-work-pages/${saved.body.id}`).set(headers())).body.source).toEqual(body.source);
  });

  it('rejects helper-only corruption and artifact workspace identity mismatch on persisted reads', async () => {
    const saved = await pages.save(await context(), null, { expectedVersion: 0, source: source(), apis: [] });
    const target = collection.doc(saved.id), original = (await target.get()).data()!;
    const tampered = structuredClone(original); tampered.source.workspace.files['lib/text.ts'] = "export const suffix = '변조';";
    await target.set(tampered);
    await expect(pages.get(await context(), saved.id)).rejects.toMatchObject({ code: 'react_page_integrity_failed' });
    await target.set({ ...original, artifact: { ...original.artifact, workspaceHash: 'f'.repeat(64) } });
    await expect(pages.get(await context(), saved.id)).rejects.toMatchObject({ code: 'react_page_integrity_failed' });
    expect((await pages.get(await context(), saved.id, 1)).source).toEqual(source());
  });

  it('rejects stale editor CAS without writing a new version or mutation receipt', async () => {
    const first = await pages.save(await context(), null, { expectedVersion: 0, source: source(), apis: [] });
    const edited = source(); edited.workspace.files['lib/text.ts'] = "export const suffix: string = ' 수정';";
    await pages.save(await context(), first.id, { expectedVersion: 1, source: edited, apis: [] });
    const loser = await context();
    await expect(pages.save(loser, first.id, { expectedVersion: 1, source: source(), apis: [] })).rejects.toMatchObject({ code: 'react_page_conflict' });
    expect((await collection.doc(first.id).collection('versions').get()).size).toBe(2);
    expect((await db.doc(`${root}/workbench_mutation_results/${hash(loser.idempotencyKey)}`).get()).exists).toBe(false);
    expect((await pages.get(await context(), first.id)).source).toEqual(edited);
  });
});
