import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyPermissionCopy, readPermissionCopy, copyLogPage, sanitizeCopiedLog } from './copy-feed.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('Independent permission and sanitized log feed', () => {
  const source = new Firestore({ projectId: 'demo-copy-source' }), db = new Firestore({ projectId: 'demo-copy-target' });
  const tenantId = `copy-${randomUUID()}`, root = `orgs/${tenantId}`;
  let instant = '2026-09-23T09:00:00.000Z'; const now = () => instant;
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: source.projectId, WORKBENCH_MODEL_PROJECT_ID: 'demo-copy-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-existing-model',
    WORKBENCH_COPY_ENABLED: 'true', WORKBENCH_COPY_SOURCE_PROJECT_ID: source.projectId, WORKBENCH_TENANT_ID: tenantId, WORKBENCH_COPY_DATASET_GRANTS: JSON.stringify({ alice: ['weekly_submission'] }) };
  beforeEach(async () => { instant = '2026-09-23T09:00:00.000Z'; await source.recursiveDelete(source.doc(root)); await db.recursiveDelete(db.doc(root)); });
  afterAll(async () => { await source.recursiveDelete(source.doc(root)); await db.recursiveDelete(db.doc(root)); await source.terminate(); await db.terminate(); });
  it('refreshes stable scope, revokes removed members and fails closed after supply stops without writing the source', async () => {
    const member = { role: 'admin', status: 'ACTIVE', email: 'not-copied@example.test' };
    await source.doc(`${root}/members/alice`).set(member);
    const feed = await readPermissionCopy({ source, env, now });
    await applyPermissionCopy({ db, env, input: feed, now });
    const core = createIsolatedWorkbenchCore({ env, db, now });
    const first = await core.authorize({ tenantId, actorId: 'alice', actorRole: 'admin' });
    expect(first.datasetIds).toEqual(['weekly_submission']);
    expect((await db.doc(`${root}/members/alice`).get()).data()).not.toHaveProperty('email');
    instant = '2026-09-23T09:01:00.000Z';
    await applyPermissionCopy({ db, env, input: await readPermissionCopy({ source, env, now }), now });
    expect((await core.authorize({ tenantId, actorId: 'alice', actorRole: 'admin' })).fingerprint).toBe(first.fingerprint);
    instant = '2026-09-23T09:07:00.000Z';
    await expect(core.authorize({ tenantId, actorId: 'alice', actorRole: 'admin' })).rejects.toMatchObject({ code: 'workbench_permissions_stale' });
    await applyPermissionCopy({ db, env, input: { ...feed, capturedAt: now(), members: [] }, now });
    await expect(core.authorize({ tenantId, actorId: 'alice', actorRole: 'admin' })).rejects.toMatchObject({ code: 'workbench_permissions_stale' });
    expect((await source.doc(`${root}/members/alice`).get()).data()).toEqual(member);
  });
  it('rejects partial, stale, wrong-source and replayed older permission snapshots', async () => {
    const feed = { version: 1, sourceProjectId: source.projectId, tenantId, capturedAt: now(), sourceRevision: '1', membershipComplete: true, members: [] };
    await applyPermissionCopy({ db, env, input: feed, now });
    for (const input of [{ ...feed, membershipComplete: false }, { ...feed, sourceProjectId: db.projectId }, { ...feed, capturedAt: '2026-09-23T08:00:00.000Z' }]) await expect(applyPermissionCopy({ db, env, input, now })).rejects.toBeDefined();
    instant = '2026-09-23T09:01:00.000Z';
    await applyPermissionCopy({ db, env, input: { ...feed, capturedAt: now(), sourceRevision: '2' }, now });
    await expect(applyPermissionCopy({ db, env, input: feed, now })).rejects.toMatchObject({ code: 'workbench_copy_out_of_order' });
  });
  it('copies bounded metadata with durable cursor, preserves zero/null and excludes raw messages and tokens', async () => {
    const raw = { actorId: 'alice', createdAt: now(), occurredAt: now(), clientRequestId: 'req1', release: 'a'.repeat(40), message: 'private raw input', email: 'private@example.test', extra: { code: 'draft_conflict', status: 409, token: 'secret-token' } };
    await source.doc(`${root}/client_error_events/one`).set(raw);
    expect(await copyLogPage({ source, db, env, kind: 'client_error_events', now })).toEqual({ count: 1, hasMore: false });
    const copy = (await db.doc(`${root}/client_error_events/one`).get()).data();
    expect(copy?.extra).toEqual({ code: 'draft_conflict', status: 409 }); expect(JSON.stringify(copy)).not.toMatch(/private|secret-token/);
    expect(await copyLogPage({ source, db, env, kind: 'client_error_events', now })).toEqual({ count: 0, hasMore: false });
    expect((await source.doc(`${root}/client_error_events/one`).get()).data()).toEqual(raw);
  });
});

describe('log copy field boundaries', () => {
  it('rejects unsupported collections and redacts malformed identity/release fields', () => {
    expect(() => sanitizeCopiedLog('users', {})).toThrow();
    expect(sanitizeCopiedLog('client_error_events', { actorId: 'name@example.test', release: 'main', extra: {} })).toMatchObject({ actorId: null, release: null, extra: { code: null, status: null } });
  });
});
