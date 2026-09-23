import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { applyPermissionCopy, copyLogPage } from './copy-feed.mjs';
const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('independent copy ordering and historical coverage QA', () => {
  const source = new Firestore({ projectId: 'demo-copy-qa-source' }), db = new Firestore({ projectId: 'demo-copy-qa-target' });
  const tenantId = 'copy-qa', root = `orgs/${tenantId}`, now = () => '2026-09-23T12:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: source.projectId, WORKBENCH_MODEL_PROJECT_ID: 'demo-copy-qa-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-copy-qa-business-model', WORKBENCH_COPY_ENABLED: 'true', WORKBENCH_COPY_SOURCE_PROJECT_ID: source.projectId, WORKBENCH_TENANT_ID: tenantId };
  const feed = (members: any[], capturedAt = now()) => ({ version: 1, sourceProjectId: source.projectId, tenantId, capturedAt, sourceRevision: JSON.stringify(members), membershipComplete: true, members });
  const admin = { id: 'alice', role: 'admin', status: 'ACTIVE', datasetIds: ['weekly'] };
  const run = (src: any = source) => copyLogPage({ source: src, db, env, kind: 'client_error_events', now });
  beforeEach(async () => { await source.recursiveDelete(source.doc(root)); await db.recursiveDelete(db.doc(root)); });
  afterAll(async () => { await source.recursiveDelete(source.doc(root)); await db.recursiveDelete(db.doc(root)); await source.terminate(); await db.terminate(); });
  it('rejects conflicting equal-time permissions rather than restoring a revoked grant', async () => {
    await applyPermissionCopy({ db, env, input: feed([]), now });
    await expect(applyPermissionCopy({ db, env, input: feed([admin]), now })).rejects.toMatchObject({ code: 'workbench_copy_ambiguous' });
    expect((await db.doc(`${root}/members/alice`).get()).exists).toBe(false);
  });
  it('also rejects equal instants with different valid ISO serialization', async () => {
    await applyPermissionCopy({ db, env, input: feed([]), now });
    await expect(applyPermissionCopy({ db, env, input: feed([admin], '2026-09-23T12:00:00Z'), now })).rejects.toMatchObject({ code: 'workbench_copy_ambiguous' });
  });
  it('sweeps late older-timestamp logs and revisits updates behind the incremental cursor', async () => {
    await source.doc(`${root}/client_error_events/z-current`).set({ createdAt: now(), actorId: 'alice', extra: { code: 'ORIGINAL' } });
    await run();
    await source.doc(`${root}/client_error_events/a-late`).set({ createdAt: '2026-09-20T12:00:00.000Z', actorId: 'alice', extra: { code: 'LATE' } });
    await source.doc(`${root}/client_error_events/z-current`).update({ 'extra.code': 'UPDATED' });
    await run();
    expect((await db.doc(`${root}/client_error_events/a-late`).get()).data()?.extra.code).toBe('LATE');
    expect((await db.doc(`${root}/client_error_events/z-current`).get()).data()?.extra.code).toBe('UPDATED');
    expect((await db.doc(`${root}/workbench_copy_state/client_error_events`).get()).data()?.cursor.id).toBe('z-current');
  });
  it('commits only one cursor generation when two workers read the same starting marker', async () => {
    await source.doc(`${root}/client_error_events/event-a`).set({ createdAt: now(), actorId: 'alice', extra: { code: 'OK' } });
    let reads = 0; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const wrap = (query: any): any => new Proxy(query, { get(target, key) {
      if (key === 'get') return async () => { const snapshot = await target.get(); if (++reads === 4) release(); await barrier; return snapshot; };
      const value = Reflect.get(target, key); return typeof value === 'function' ? (...args: any[]) => wrap(value.apply(target, args)) : value;
    } });
    const wrapped = { projectId: source.projectId, collection: (path: string) => wrap(source.collection(path)) };
    const results = await Promise.allSettled([run(wrapped), run(wrapped)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed: any = results.find(result => result.status === 'rejected'); expect(failed.reason.code).toBe('workbench_copy_concurrent');
    expect((await db.doc(`${root}/workbench_copy_state/client_error_events`).get()).data()?.generation).toBe(1);
    expect((await db.collection(`${root}/client_error_events`).get()).size).toBe(1);
  });
});
