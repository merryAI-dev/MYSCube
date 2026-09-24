import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { createReactPageService, reactHash } from './react-pages.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { compileReactPreview } from './react-compiler.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('React page atomic mutation receipts on the real Firestore emulator', () => {
  const db = new Firestore({ projectId: 'demo-react-mutation-receipt' }), tenantId = 'react-mutation-receipt';
  const now = () => '2026-09-23T12:00:00.000Z';
  const core = createIsolatedWorkbenchCore({ db, now, env: { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-other-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-react-mutation-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-other-model' } });
  const compile = vi.fn(compileReactPreview), apis = { get: vi.fn() };
  const service = createReactPageService({ db, now, authorize: core.authorize, apis, compile });
  const context = (key: string, actorId = 'admin-a') => ({ tenantId, actorId, actorRole: 'admin', idempotencyKey: key });
  const source = (text: string) => ({ title: text, code: `export default function App(){return <main>${text}</main>}` });
  const body = (title = '첫 저장', expectedVersion = 0) => ({ source: source(title), apis: [], expectedVersion });
  beforeEach(async () => { await db.recursiveDelete(db.doc(`orgs/${tenantId}`)); compile.mockClear(); for (const id of ['admin-a', 'admin-b']) await db.doc(`orgs/${tenantId}/members/${id}`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now(), analyticsDatasetIds: [], analyticsScopeRevision: 'v1' }); });
  afterAll(async () => { await db.recursiveDelete(db.doc(`orgs/${tenantId}`)); await db.terminate(); });
  it('replays a lost create response once, rejects payload changes, and resolves the immutable saved version after later edits', async () => {
    const first = await service.save(context('create-key'), null, body());
    const replay = await service.save(context('create-key'), null, body());
    expect(replay).toEqual(first); expect(compile).toHaveBeenCalledTimes(1);
    expect((await service.list(context('list'))).items).toHaveLength(1);
    const receipt = (await db.doc(`orgs/${tenantId}/workbench_mutation_results/${reactHash('create-key')}`).get()).data();
    expect(receipt).toMatchObject({ actorId: 'admin-a', tenantId, pageId: first.id, version: 1, sourceHash: first.sourceHash, apis: [] });
    await expect(service.save(context('create-key'), null, body('바꾼 내용'))).rejects.toMatchObject({ code: 'react_operation_conflict' });
    const second = await service.save(context('edit-key'), first.id, body('두 번째', 1));
    expect((await service.save(context('edit-key'), first.id, body('두 번째', 1))).version).toBe(2);
    expect((await service.mutationResult(context('create-key'))).version).toBe(1);
    expect((await service.get(context('read'), second.id)).version).toBe(2);
    expect(compile).toHaveBeenCalledTimes(2);
  });
  it('replays restore without adding another revision and rejects another actor or revoked scope', async () => {
    const first = await service.save(context('create'), null, body());
    await service.save(context('edit'), first.id, body('수정', 1));
    const restored = await service.restore(context('restore'), first.id, { expectedVersion: 2, version: 1 });
    expect(restored.version).toBe(3); expect(restored.source).toEqual(first.source);
    expect(await service.restore(context('restore'), first.id, { expectedVersion: 2, version: 1 })).toEqual(restored);
    expect((await service.history(context('history'), first.id)).items).toHaveLength(3);
    await expect(service.mutationResult(context('restore', 'admin-b'))).rejects.toMatchObject({ code: 'react_operation_forbidden' });
    await db.doc(`orgs/${tenantId}/members/admin-a`).update({ status: 'INACTIVE' });
    await expect(service.mutationResult(context('restore'))).rejects.toMatchObject({ statusCode: 403 });
  });
});
