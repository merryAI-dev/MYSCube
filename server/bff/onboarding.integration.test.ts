import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createBffApp } from './app.mjs';
import { createFirestoreDb } from './firestore.mjs';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const emulatorSuite = emulatorHost ? describe : describe.skip;

emulatorSuite('approved onboarding identity link (Firestore transactions)', () => {
  const projectId = 'demo-bff-it';
  const tenantId = `onboard-${randomUUID().slice(0, 8)}`;
  const adminUid = 'approved-admin';
  const adminEmail = 'admin@example.test';
  const targetUid = 'verified-staff';
  const targetEmail = 'staff@example.test';
  let db: ReturnType<typeof createFirestoreDb>;
  let api: ReturnType<typeof request>;
  let authUser: Record<string, any>;
  const setCustomUserClaims = vi.fn(async () => {});
  const headers = { 'x-tenant-id': tenantId, authorization: 'Bearer synthetic-admin-token' };
  const path = `/api/v1/admin/auth-governance/users/${encodeURIComponent(targetEmail)}/link-person`;
  const personRef = (id = 'person-a') => db.doc(`orgs/${tenantId}/persons/${id}`);

  function makeApi(database: typeof db = db) {
    return request(createBffApp({
      projectId, db: database, authMode: 'firebase_required',
      tokenVerifier: async (token: string) => {
        if (token !== 'synthetic-admin-token') throw new Error('Invalid synthetic token');
        return { uid: adminUid, email: adminEmail, tenantId, email_verified: true };
      },
      authAdminService: {
        getUser: async () => { throw Object.assign(new Error('absent'), { code: 'auth/user-not-found' }); },
        getUserByEmail: async () => authUser,
        listUsers: async () => ({ users: [authUser] }),
        setCustomUserClaims,
      },
    }));
  }

  async function candidate(id = 'person-a') {
    const result = await api.get('/api/v1/admin/auth-governance/people-link-candidates')
      .query({ identityKey: targetEmail }).set(headers);
    expect(result.status).toBe(200);
    const selected = result.body.people.find((item: any) => item.personId === id);
    expect(selected).toBeTruthy();
    return { personId: id, expectedAuthUid: result.body.authUid, expectedPersonVersion: selected.expectedPersonVersion, reason: 'Administrator verified personnel identity' };
  }

  const post = (body: object, key = randomUUID(), client = api) => client.post(path)
    .set({ ...headers, 'idempotency-key': key }).send(body);

  beforeAll(() => {
    if (!projectId.startsWith('demo-') || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(emulatorHost || '')) {
      throw new Error('Onboarding tests require a demo project and loopback Firestore emulator');
    }
    db = createFirestoreDb({ projectId, appName: `onboarding-tests-${randomUUID()}` });
    vi.stubEnv('BFF_ALLOWED_EMAIL_DOMAINS', 'example.test');
  });

  beforeEach(async () => {
    await db.recursiveDelete(db.doc(`orgs/${tenantId}`));
    setCustomUserClaims.mockClear();
    authUser = {
      uid: targetUid, email: targetEmail, emailVerified: true, disabled: false,
      providerData: [{ providerId: 'google.com', email: targetEmail }], customClaims: {},
    };
    await db.doc(`orgs/${tenantId}/members/${adminUid}`).set({ uid: adminUid, email: adminEmail, role: 'admin', status: 'ACTIVE' });
    await personRef().set({ personId: 'person-a', name: 'Synthetic Staff', nickname: 'Fixture', email: '', uid: null });
    api = makeApi();
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (db) { await db.recursiveDelete(db.doc(`orgs/${tenantId}`)); await db.terminate(); }
    vi.unstubAllEnvs();
  });

  it('links the explicit verified person and stores audit evidence without creating access', async () => {
    const response = await post(await candidate());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ personId: 'person-a', uid: targetUid, status: 'LINKED', permissionSyncRequired: true });
    expect((await personRef().get()).data()).toMatchObject({ uid: targetUid, email: targetEmail,
      identityLink: { confirmedBy: adminUid, authProvider: 'google.com', reason: 'Administrator verified personnel identity' } });
    expect((await db.doc(`orgs/${tenantId}/members/${targetUid}`).get()).exists).toBe(false);
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    const audit = await db.collection(`orgs/${tenantId}/audit_logs`).get();
    expect(audit.size).toBe(1);
    expect(audit.docs[0].data()).toMatchObject({ action: 'IDENTITY_LINK', entityId: 'person-a', userId: adminUid });
    expect((await db.collection(`orgs/${tenantId}/persons`).where('uid', '==', adminUid).get()).empty).toBe(true);
  });

  it.each([
    ['uid', 'different-admin'], ['email', 'different@example.test'], ['tenantId', 'other'],
    ['role', 'pm'], ['status', 'INACTIVE'],
  ])('denies a mismatched canonical administrator %s', async (field, value) => {
    const body = await candidate();
    await db.doc(`orgs/${tenantId}/members/${adminUid}`).update({ [field]: value });
    expect((await api.get('/api/v1/admin/auth-governance/people-link-candidates').query({ identityKey: targetEmail }).set(headers)).status).toBe(403);
    expect((await post(body)).status).toBe(403);
    expect((await personRef().get()).data()?.uid).toBeNull();
    expect((await db.collection(`orgs/${tenantId}/audit_logs`).get()).empty).toBe(true);
  });

  it('rejects absent or invalid bearer identity rather than trusting actor headers', async () => {
    const body = await candidate();
    for (const authorization of ['', 'Bearer invalid-token']) {
      const response = await api.post(path).set({ ...headers, authorization, 'x-actor-id': adminUid, 'x-actor-role': 'admin', 'idempotency-key': randomUUID() }).send(body);
      expect(response.status).toBe(401);
    }
    expect((await personRef().get()).data()?.uid).toBeNull();
  });

  it('rejects missing canonical membership even with an otherwise valid token', async () => {
    const body = await candidate();
    await db.doc(`orgs/${tenantId}/members/${adminUid}`).delete();
    expect((await api.get('/api/v1/admin/auth-governance/people-link-candidates').query({ identityKey: targetEmail }).set(headers)).status).toBe(403);
    expect((await post(body)).status).toBe(403);
    expect((await personRef().get()).data()?.uid).toBeNull();
  });

  it('does not relax the separate deep-sync People authority requirement', async () => {
    const linked = await post(await candidate());
    expect(linked.status).toBe(200);
    const response = await api.post(`/api/v1/admin/auth-governance/users/${encodeURIComponent(targetEmail)}/deep-sync`)
      .set({ ...headers, 'idempotency-key': randomUUID() }).send({ role: 'pm', reason: 'Synthetic separate permission request' });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('member_authority_required');
    expect((await db.doc(`orgs/${tenantId}/members/${targetUid}`).get()).exists).toBe(false);
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('replays a completed operation and rejects reuse with a changed payload', async () => {
    const body = await candidate();
    const first = await post(body, 'repeat-link');
    const replay = await post(body, 'repeat-link');
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers['x-idempotency-replayed']).toBe('1');
    expect(replay.body).toEqual(first.body);
    expect((await post({ ...body, reason: 'different reason' }, 'repeat-link')).status).toBe(409);
    expect((await db.collection(`orgs/${tenantId}/audit_logs`).get()).size).toBe(1);
    const linkedAgain = await post(await candidate());
    expect(linkedAgain.status).toBe(200);
    expect(linkedAgain.body.alreadyLinked).toBe(true);
    expect((await db.collection(`orgs/${tenantId}/audit_logs`).get()).size).toBe(1);
  });

  it.each([
    ['disabled', { disabled: true }],
    ['unverified', { emailVerified: false }],
    ['non-Google', { providerData: [{ providerId: 'password', email: targetEmail }] }],
  ])('denies %s identities without changing the person', async (_name, patch) => {
    const body = await candidate();
    authUser = { ...authUser, ...patch };
    expect((await post(body)).status).toBe(409);
    expect((await personRef().get()).data()?.uid).toBeNull();
    expect((await db.collection(`orgs/${tenantId}/audit_logs`).get()).empty).toBe(true);
  });

  it.each([
    ['conflicting target UID', { uid: 'another-account' }, null],
    ['conflicting target email', { email: 'other@example.test' }, null],
    ['duplicate UID', {}, { uid: targetUid, email: '' }],
    ['duplicate normalized email', {}, { uid: null, email: ' STAFF@EXAMPLE.TEST ' }],
  ])('rejects %s rather than overwriting identity', async (_name, patch, other) => {
    await personRef().set(patch, { merge: true });
    if (other) await personRef('person-b').set(other);
    const before = (await personRef().get()).data();
    expect((await post(await candidate())).status).toBe(409);
    expect((await personRef().get()).data()).toEqual(before);
    expect((await db.collection(`orgs/${tenantId}/audit_logs`).get()).empty).toBe(true);
  });

  it('rejects absent and stale person selections', async () => {
    const body = await candidate();
    expect((await post({ ...body, personId: 'missing-person' })).status).toBe(404);
    await personRef().update({ nickname: 'Changed after review' });
    const stale = await post(body);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('people_identity_changed');
    expect((await personRef().get()).data()?.uid).toBeNull();
  });

  it('allows only one of two concurrent people to acquire the same UID', async () => {
    await personRef('person-b').set({ personId: 'person-b', name: 'Another Fixture', email: '', uid: null });
    const [a, b] = await Promise.all([candidate(), candidate('person-b')]);
    const results = await Promise.all([post(a, 'concurrent-a'), post(b, 'concurrent-b')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await db.collection(`orgs/${tenantId}/persons`).where('uid', '==', targetUid).get()).size).toBe(1);
    expect((await db.collection(`orgs/${tenantId}/audit_logs`).get()).size).toBe(1);
    expect((await db.doc(`orgs/${tenantId}/members/${targetUid}`).get()).exists).toBe(false);
  });

  it('rechecks persisted administrator authority before writing or replaying', async () => {
    const body = await candidate();
    expect((await post(body, 'revoked-replay')).status).toBe(200);
    await db.doc(`orgs/${tenantId}/members/${adminUid}`).update({ status: 'INACTIVE' });
    expect((await post(body, 'revoked-replay')).status).toBe(403);
    expect((await db.collection(`orgs/${tenantId}/audit_logs`).get()).size).toBe(1);
  });

  it('rejects revocation between authentication middleware and the linking transaction', async () => {
    const body = await candidate();
    const original = db.runTransaction.bind(db);
    const spy = vi.spyOn(db, 'runTransaction').mockImplementationOnce((async (operation: any, options: any) => {
      await db.doc(`orgs/${tenantId}/members/${adminUid}`).update({ status: 'INACTIVE' });
      return original(operation, options);
    }) as any);
    const result = await post(body, 'late-revocation');
    spy.mockRestore();
    expect(result.status).toBe(403);
    expect(result.body.error).toBe('member_authority_required');
    expect((await personRef().get()).data()?.uid).toBeNull();
    expect((await db.collection(`orgs/${tenantId}/audit_logs`).get()).empty).toBe(true);
    expect((await db.collection(`orgs/${tenantId}/idempotency_keys`).get()).empty).toBe(true);
  });

  it('rolls back identity and idempotency completion when the audit transaction fails', async () => {
    const body = await candidate();
    const original = db.runTransaction.bind(db);
    const spy = vi.spyOn(db, 'runTransaction').mockImplementation(((operation: any, options: any) => original(async (tx: any) => {
      const originalGet = tx.get.bind(tx);
      tx.get = (ref: any, ...args: any[]) => {
        if (ref.path === `orgs/${tenantId}/audit_chain/head`) throw new Error('Synthetic audit failure');
        return originalGet(ref, ...args);
      };
      return operation(tx);
    }, options)) as any);
    expect((await post(body, 'audit-failure')).status).toBe(500);
    spy.mockRestore();
    expect((await personRef().get()).data()?.uid).toBeNull();
    expect((await db.collection(`orgs/${tenantId}/audit_logs`).get()).empty).toBe(true);
    expect((await db.collection(`orgs/${tenantId}/idempotency_keys`).get()).empty).toBe(true);
    expect((await post(body, 'audit-failure')).status).toBe(200);
    expect((await personRef().get()).data()?.uid).toBe(targetUid);
  });
  it('atomically migrates a synthetic legacy link once under competing requests without granting roles', async () => {
    const oldUid = targetEmail.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    await personRef().update({ email: targetEmail, uid: oldUid });
    const legacyRef = db.doc(`orgs/${tenantId}/members/${oldUid}`);
    const legacy = { uid: oldUid, email: targetEmail, role: 'pm', tenantId };
    await legacyRef.set(legacy);
    const body = { ...await candidate(), legacyMigration: { expectedLegacyUid: oldUid, confirmed: true } };
    const responses = await Promise.all([post(body, 'migration-a'), post(body, 'migration-b')]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await personRef().get()).data()?.uid).toBe(targetUid);
    expect((await legacyRef.get()).data()).toEqual(legacy);
    expect((await db.doc(`orgs/${tenantId}/members/${targetUid}`).get()).exists).toBe(false);
    const audit = await db.collection(`orgs/${tenantId}/audit_logs`).get();
    expect(audit.size).toBe(1);
    expect(audit.docs[0].data()).toMatchObject({ action: 'IDENTITY_LINK_MIGRATION' });
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

});
