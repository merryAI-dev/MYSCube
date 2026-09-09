import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createBffApp } from './app.mjs';
import { EDIT_LEASE_TTL_MS, resolveEditLeaseDocumentId } from './edit-lease.mjs';
import { createFirestoreDb } from './firestore.mjs';

const describeIfEmulator = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

describeIfEmulator('edit leases (Firestore emulator)', () => {
  const projectId = 'demo-bff-it';
  const tenantId = 'edit-leases-it';
  const actorId = 'actor-a';
  let nowMs = Date.parse('2026-07-10T00:00:00.000Z');
  const db = createFirestoreDb({ projectId });
  const api = request(createBffApp({
    projectId,
    db,
    authMode: 'headers',
    now: () => new Date(nowMs).toISOString(),
    editLeasesEnabled: true,
    env: {
      ...process.env,
      BFF_DEPLOY_ENV: 'local',
      BFF_SCHEDULER_OWNER: 'disabled',
    },
  }));

  const baseHeaders = {
    'x-tenant-id': tenantId,
    'x-actor-id': actorId,
    'x-actor-role': 'pm',
    'x-actor-name': 'Actor A',
  };

  async function clearCollection(path: string) {
    const snap = await db.collection(path).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }

  async function clearData() {
    await Promise.all([
      'editLeases',
      'projects',
      'members',
      'projectRequestDrafts',
      'audit_logs',
      'audit_chain',
      'idempotency_keys',
    ].map((collection) => clearCollection(`orgs/${tenantId}/${collection}`)));
  }

  async function resetData() {
    await clearData();
    const batch = db.batch();
    batch.set(db.doc(`orgs/${tenantId}/members/${actorId}`), {
      uid: actorId,
      role: 'pm',
      status: 'ACTIVE',
      projectIds: ['project-a', 'project-b'],
    });
    batch.set(db.doc(`orgs/${tenantId}/projects/project-a`), { id: 'project-a' });
    batch.set(db.doc(`orgs/${tenantId}/projects/project-b`), { id: 'project-b' });
    batch.set(db.doc(`orgs/${tenantId}/projectRequestDrafts/draft-a`), { ownerUid: actorId, status: 'ACTIVE' });
    await batch.commit();
    nowMs = Date.parse('2026-07-10T00:00:00.000Z');
  }

  function acquire(resourceType: string, resourceId: string, sessionId: string, key: string) {
    return api
      .post(`/api/v1/edit-leases/${resourceType}/${resourceId}/acquire`)
      .set({
        ...baseHeaders,
        'x-edit-session-id': sessionId,
        'idempotency-key': key,
      })
      .send({});
  }

  // Firestore emulator cold-start cleanup can exceed the shared 30s hook limit.
  beforeEach(resetData, 60_000);
  afterAll(clearData, 60_000);

  it('serializes concurrent same-actor tabs so exactly one acquires the resource', async () => {
    const responses = await Promise.all([
      acquire('project-info', 'project-a', 'session-a', 'idem-race-a'),
      acquire('project-info', 'project-a', 'session-b', 'idem-race-b'),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 423]);
    const conflict = responses.find((response) => response.status === 423)!;
    expect(conflict.body.details).toEqual({
      holderDisplayName: 'Actor A',
      sameActor: true,
      expiresAt: '2026-07-10T00:30:00.000Z',
      holderVersion: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(conflict.body)).not.toMatch(/actor-a|session-[ab]|leaseId|fence|@/i);
    const audits = await db.collection(`orgs/${tenantId}/audit_logs`).get();
    expect(audits.docs.map((doc) => doc.data().action).sort()).toEqual([
      'EDIT_LEASE_ACQUIRE',
      'EDIT_LEASE_CONFLICT',
    ]);
    expect(JSON.stringify(audits.docs.map((doc) => doc.data()))).not.toMatch(/session-[ab]|leaseId/i);
  });

  it('allows a project and an owned registration draft to acquire independently', async () => {
    const responses = await Promise.all([
      acquire('cashflow', 'project-b', 'session-project', 'idem-independent-project'),
      acquire('project-registration', 'draft-a', 'session-draft', 'idem-independent-draft'),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses[0].body.leaseId).not.toBe(responses[1].body.leaseId);
  });

  it('reacquires at exact expiry and rejects the previous fence', async () => {
    const first = await acquire('project-info', 'project-a', 'session-old', 'idem-expiry-old');
    expect(first.status).toBe(200);
    nowMs += EDIT_LEASE_TTL_MS;

    const second = await acquire('project-info', 'project-a', 'session-new', 'idem-expiry-new');
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ fence: first.body.fence + 1 });
    expect(second.body.leaseId).not.toBe(first.body.leaseId);
    const auditActions = (await db
      .collection(`orgs/${tenantId}/audit_logs`)
      .orderBy('chainSeq', 'asc')
      .get()).docs.map((doc) => doc.data().action);
    expect(auditActions).toEqual([
      'EDIT_LEASE_ACQUIRE',
      'EDIT_LEASE_EXPIRE',
      'EDIT_LEASE_ACQUIRE',
    ]);

    const stale = await api
      .post('/api/v1/edit-leases/project-info/project-a/extend')
      .set({
        ...baseHeaders,
        'x-edit-session-id': 'session-old',
        'x-edit-lease-id': first.body.leaseId,
        'x-edit-fence': String(first.body.fence),
        'idempotency-key': 'idem-expiry-stale',
      })
      .send({});

    expect(stale.status).toBe(423);
    expect(stale.body.error).toBe('edit_lease_held');
  });

  it('replays extend exactly once without moving expiry or appending another audit', async () => {
    const acquired = await acquire('project-info', 'project-a', 'session-a', 'idem-extend-acquire');
    expect(acquired.status).toBe(200);
    nowMs += 60_000;

    const headers = {
      ...baseHeaders,
      'x-edit-session-id': 'session-a',
      'x-edit-lease-id': acquired.body.leaseId,
      'x-edit-fence': String(acquired.body.fence),
      'idempotency-key': 'idem-extend-retry',
    };
    const first = await api
      .post('/api/v1/edit-leases/project-info/project-a/extend')
      .set(headers)
      .send({});
    expect(first.status).toBe(200);

    const auditSnapshot = await db.collection(`orgs/${tenantId}/audit_logs`).get();
    const auditCount = auditSnapshot.size;
    expect(JSON.stringify(auditSnapshot.docs.map((doc) => doc.data())))
      .not.toMatch(new RegExp(`session-a|${acquired.body.leaseId}`, 'i'));
    nowMs += 60_000;
    const replay = await api
      .post('/api/v1/edit-leases/project-info/project-a/extend')
      .set(headers)
      .send({});

    expect(replay.status).toBe(200);
    expect(replay.headers['x-idempotency-replayed']).toBe('1');
    expect(replay.body).toEqual(first.body);
    expect((await db.collection(`orgs/${tenantId}/audit_logs`).get()).size).toBe(auditCount);
    const lease = await db.doc(
      `orgs/${tenantId}/editLeases/${resolveEditLeaseDocumentId('project-info', 'project-a')}`,
    ).get();
    expect(lease.data()?.expiresAt).toBe(first.body.expiresAt);
  });

  it('replays release exactly instead of treating the retry as expired', async () => {
    const acquired = await acquire('project-info', 'project-a', 'session-a', 'idem-release-acquire');
    expect(acquired.status).toBe(200);
    const headers = {
      ...baseHeaders,
      'x-edit-session-id': 'session-a',
      'x-edit-lease-id': acquired.body.leaseId,
      'x-edit-fence': String(acquired.body.fence),
      'idempotency-key': 'idem-release-retry',
    };

    const first = await api
      .post('/api/v1/edit-leases/project-info/project-a/release')
      .set(headers)
      .send({});
    const replay = await api
      .post('/api/v1/edit-leases/project-info/project-a/release')
      .set(headers)
      .send({});

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers['x-idempotency-replayed']).toBe('1');
    expect(replay.body).toEqual(first.body);
    const audits = await db.collection(`orgs/${tenantId}/audit_logs`).get();
    expect(audits.docs.filter((doc) => doc.data().action === 'EDIT_LEASE_RELEASE')).toHaveLength(1);
  });

  it('rejects cross-tab idempotency key reuse without exposing lease details', async () => {
    const acquired = await acquire('project-info', 'project-a', 'session-a', 'idem-cross-tab-acquire');
    expect(acquired.status).toBe(200);
    const shared = {
      ...baseHeaders,
      'x-edit-lease-id': acquired.body.leaseId,
      'x-edit-fence': String(acquired.body.fence),
      'idempotency-key': 'idem-cross-tab-shared',
    };
    const first = await api
      .post('/api/v1/edit-leases/project-info/project-a/extend')
      .set({ ...shared, 'x-edit-session-id': 'session-a' })
      .send({});
    expect(first.status).toBe(200);

    const conflict = await api
      .post('/api/v1/edit-leases/project-info/project-a/extend')
      .set({ ...shared, 'x-edit-session-id': 'session-b' })
      .send({});

    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: 'idempotency_conflict' });
    expect(JSON.stringify(conflict.body)).not.toMatch(/leaseId|session-[ab]|fence|expiresAt/i);

    const staleFence = await api
      .post('/api/v1/edit-leases/project-info/project-a/extend')
      .set({
        ...shared,
        'x-edit-session-id': 'session-a',
        'x-edit-fence': String(acquired.body.fence + 1),
      })
      .send({});
    expect(staleFence.status).toBe(409);
    expect(staleFence.body).toMatchObject({ error: 'idempotency_conflict' });
    expect(JSON.stringify(staleFence.body)).not.toMatch(/leaseId|session-a|fence|expiresAt/i);

    await db.doc(`orgs/${tenantId}/members/actor-b`).set({
      uid: 'actor-b',
      role: 'pm',
      status: 'ACTIVE',
      projectIds: ['project-a'],
    });
    const otherActor = await api
      .post('/api/v1/edit-leases/project-info/project-a/extend')
      .set({
        ...shared,
        'x-actor-id': 'actor-b',
        'x-actor-name': 'Actor B',
        'x-edit-session-id': 'session-a',
      })
      .send({});
    expect(otherActor.status).toBe(409);
    expect(otherActor.body).toMatchObject({ error: 'idempotency_conflict' });
    expect(JSON.stringify(otherActor.body)).not.toMatch(/leaseId|session-a|fence|expiresAt/i);
  });

  it('checks current member access before replaying a completed command', async () => {
    const acquired = await acquire('project-info', 'project-a', 'session-a', 'idem-revoked-acquire');
    expect(acquired.status).toBe(200);
    const headers = {
      ...baseHeaders,
      'x-edit-session-id': 'session-a',
      'x-edit-lease-id': acquired.body.leaseId,
      'x-edit-fence': String(acquired.body.fence),
      'idempotency-key': 'idem-revoked-replay',
    };
    const first = await api
      .post('/api/v1/edit-leases/project-info/project-a/extend')
      .set(headers)
      .send({});
    expect(first.status).toBe(200);
    await db.doc(`orgs/${tenantId}/members/${actorId}`).set({ status: 'INACTIVE' }, { merge: true });

    const replay = await api
      .post('/api/v1/edit-leases/project-info/project-a/extend')
      .set(headers)
      .send({});

    expect(replay.status).toBe(403);
    expect(replay.headers['x-idempotency-replayed']).toBeUndefined();
  });

  it('persists and audits an expired lease only once across repeated status reads', async () => {
    const acquired = await acquire('project-info', 'project-a', 'session-a', 'idem-expire-once-acquire');
    expect(acquired.status).toBe(200);
    nowMs += EDIT_LEASE_TTL_MS;
    const headers = { ...baseHeaders, 'x-edit-session-id': 'session-a' };

    const first = await api
      .get('/api/v1/edit-leases/project-info/project-a')
      .set(headers);
    const second = await api
      .get('/api/v1/edit-leases/project-info/project-a')
      .set(headers);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.state).toBe('EXPIRED');
    expect(second.body).toEqual(first.body);
    const lease = await db.doc(
      `orgs/${tenantId}/editLeases/${resolveEditLeaseDocumentId('project-info', 'project-a')}`,
    ).get();
    expect(lease.data()?.state).toBe('EXPIRED');
    const audits = await db.collection(`orgs/${tenantId}/audit_logs`).get();
    expect(audits.docs.filter((doc) => doc.data().action === 'EDIT_LEASE_EXPIRE')).toHaveLength(1);
  });
});
