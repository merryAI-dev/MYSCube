import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mountMemberPersonLinkRoutes, personLinkVersion } from './member-person-link.mjs';
import { createIdempotencyService } from '../idempotency.mjs';

function harness({ retryTransaction = false, authSequence = null, oldAuth = null, oldAuthError = null, authPatch = {}, patch = {}, contextPatch = {}, failAudit = false, allowedEmailDomains = ['example.com'] } = {}) {
  let authReads = 0;
  const store = new Map(Object.entries({
    'orgs/t/members/a': { uid: 'a', role: 'admin', status: 'ACTIVE', email: 'admin@example.com', tenantId: 't' },
    'orgs/t/persons/admin': { uid: 'a' },
    'orgs/t/persons/p': { name: 'Synthetic Staff', nickname: 'Test', email: '', uid: null, tenantId: 't' },
    ...patch,
  }).filter(([, value]) => value !== null));
  const db = {
    doc: (path) => ({ path, get: async () => ({ exists: store.has(path), data: () => store.get(path) }) }),
    collection: (path) => ({ get: async () => ({ docs: [...store].filter(([key]) => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')).map(([key, data]) => ({ id: key.split('/').at(-1), data: () => data })) }) }),
    async runTransaction(fn) {
      if (retryTransaction) await fn({ get: (ref) => ref.get(), set: () => {} });
      const pending = [];
      const result = await fn({ get: (ref) => ref.get(), set: (ref, value, options) => pending.push(() => store.set(ref.path, options?.merge ? { ...store.get(ref.path), ...value } : value)) });
      pending.forEach((write) => write());
      return result;
    },
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.context = { tenantId: 't', actorId: 'a', actorRole: req.header('role') || 'admin', actorEmail: 'admin@example.com', authSource: 'firebase', requestId: 'request-test', idempotencyKey: req.header('idempotency-key') || 'link-test', ...contextPatch }; next(); });
  mountMemberPersonLinkRoutes(app, {
    db, allowedEmailDomains, now: () => '2026-10-29T00:00:00Z', idempotencyService: createIdempotencyService(db), piiProtector: { encryptText: async () => ({ ciphertext: 'synthetic-encrypted-email' }) },
    auditChainService: { async appendManyInTransaction(tx, entries) { if (failAudit) throw new Error('synthetic failure'); tx.set(db.doc('audit/test'), entries[0]); } },
    authAdminService: { async getUser() { if (oldAuthError) throw oldAuthError; if (typeof oldAuth === 'function') return oldAuth(); if (oldAuth) return oldAuth; throw Object.assign(new Error('absent'), { code: 'auth/user-not-found' }); }, async getUserByEmail() { return { uid: 'u', email: 'staff@example.com', emailVerified: true, disabled: false, providerData: [{ providerId: 'google.com', email: 'staff@example.com' }], ...authPatch, ...(authSequence?.[authReads++] || {}) }; } },
  });
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' }));
  const body = (id = 'p') => ({ personId: id, expectedAuthUid: 'u', expectedPersonVersion: personLinkVersion(store.get(`orgs/t/persons/${id}`) || {}), reason: 'Synthetic identity verification by admin' });
  const post = (payload = body(), key = 'link-test') => request(app).post('/api/v1/admin/auth-governance/users/staff%40example.com/link-person').set('idempotency-key', key).send(payload);
  return { app, store, body, post };
}

describe('admin verified person linking', () => {
  it('lists candidates without selecting by name or granting membership', async () => {
    const h = harness(); const before = [...h.store];
    const response = await request(h.app).get('/api/v1/admin/auth-governance/people-link-candidates?identityKey=staff@example.com');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ authVerified: true, linkedPersonId: null, emailMatchPersonIds: [] });
    expect(response.body.people.find((p) => p.personId === 'p')).toMatchObject({ linkedUid: null, expectedPersonVersion: h.body().expectedPersonVersion });
    expect([...h.store]).toEqual(before);
  });
  it('links the explicit person, records audit, and leaves role/claims separate', async () => {
    const h = harness(); const response = await h.post();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ personId: 'p', status: 'LINKED', permissionSyncRequired: true });
    expect(h.store.get('orgs/t/persons/p')).toMatchObject({ uid: 'u', email: 'staff@example.com', identityLink: { confirmedBy: 'a' } });
    expect(h.store.get('audit/test')).toMatchObject({ action: 'IDENTITY_LINK', entityId: 'p' });
    expect(h.store.has('orgs/t/members/u')).toBe(false);
  });
  it('replays a committed response after client response loss without another audit', async () => {
    const h = harness(); const body = h.body(); const first = await h.post(body); const audit = h.store.get('audit/test');
    const replay = await h.post(body);
    expect(replay.status).toBe(200); expect(replay.headers['x-idempotency-replayed']).toBe('1'); expect(replay.body).toEqual(first.body);
    expect(h.store.get('audit/test')).toBe(audit);
  });
  it('accepts an already-linked identity with a current version and new key', async () => {
    const h = harness(); await h.post(); const response = await h.post(h.body(), 'second');
    expect(response.status).toBe(200); expect(response.body.alreadyLinked).toBe(true);
  });
  it('rejects altered payload with an already used key', async () => {
    const h = harness(); await h.post(); const response = await h.post({ ...h.body(), reason: 'Different reason' });
    expect(response.body.error).toBe('idempotency_conflict');
  });
  it.each([
    [{ emailVerified: false }, 'auth_identity_unverified'],
    [{ disabled: true }, 'auth_identity_disabled'],
    [{ providerData: [{ providerId: 'password', email: 'staff@example.com' }] }, 'auth_identity_unverified'],
    [{ email: 'other@example.com' }, 'auth_identity_missing'],
    [{ customClaims: { tenantId: 'other' } }, 'member_identity_conflict'],
    [{ customClaims: { orgId: 'other' } }, 'member_identity_conflict'],
  ])('rejects ineligible Auth identity %j', async (authPatch, code) => {
    const h = harness({ authPatch }); const before = [...h.store]; const response = await h.post();
    expect(response.status).toBe(409); expect(response.body.error).toBe(code); expect([...h.store]).toEqual(before);
  });
  it.each([
    [{ 'orgs/t/persons/p': { uid: 'other' } }, 'people_uid_conflict'],
    [{ 'orgs/t/persons/duplicate': { uid: 'u' } }, 'people_uid_ambiguous'],
    [{ 'orgs/t/persons/p': { email: 'other@example.com' } }, 'people_email_conflict'],
    [{ 'orgs/t/persons/duplicate': { email: ' STAFF@example.com ' } }, 'people_email_ambiguous'],
    [{ 'orgs/t/members/other': { uid: 'other', email: 'staff@example.com' } }, 'member_identity_conflict'],
    [{ 'orgs/t/members/u': { uid: 'other', email: 'staff@example.com' } }, 'member_identity_conflict'],
    [{ 'orgs/t/persons/p': { tenantId: 'other' } }, 'member_identity_conflict'],
  ])('rejects conflicting stored identity %j', async (patch, code) => {
    const h = harness({ patch }); const before = [...h.store]; const response = await h.post();
    expect(response.status).toBe(409); expect(response.body.error).toBe(code); expect([...h.store]).toEqual(before);
  });
  it('requires a current person version and does not overwrite a concurrent edit', async () => {
    const h = harness(); const body = h.body(); h.store.get('orgs/t/persons/p').name = 'Changed';
    expect((await h.post(body)).body.error).toBe('people_identity_changed');
  });
  it('rejects absent person without creating a new record', async () => {
    const h = harness(); expect((await h.post(h.body('missing'))).body.error).toBe('people_not_found');
    expect(h.store.has('orgs/t/persons/missing')).toBe(false);
  });
  it('rolls back identity and idempotency if audit fails', async () => {
    const h = harness({ failAudit: true }); const before = [...h.store];
    expect((await h.post()).status).toBe(500); expect([...h.store]).toEqual(before);
  });
  it.each([
    { 'orgs/t/members/a': { uid: 'a', role: 'pm', status: 'ACTIVE', email: 'admin@example.com', tenantId: 't' } },
    { 'orgs/t/members/a': { uid: 'a', role: 'admin', status: 'INACTIVE', email: 'admin@example.com', tenantId: 't' } },
    { 'orgs/t/members/a': null },
    { 'orgs/t/members/a': { uid: 'other', role: 'admin', status: 'ACTIVE', email: 'admin@example.com', tenantId: 't' } },
    { 'orgs/t/members/a': { uid: 'a', role: 'admin', status: 'ACTIVE', email: 'other@example.com', tenantId: 't' } },
    { 'orgs/t/members/a': { uid: 'a', role: 'admin', status: 'ACTIVE', tenantId: 't' } },
    { 'orgs/t/members/a': { role: 'admin', status: 'ACTIVE', email: 'admin@example.com', tenantId: 't' } },
    { 'orgs/t/members/a': { uid: 'a', status: 'ACTIVE', email: 'admin@example.com', tenantId: 't' } },
    { 'orgs/t/members/a': { uid: 'a', role: 'admin', email: 'admin@example.com', tenantId: 't' } },
    { 'orgs/t/members/a': { uid: 'a', role: 'admin', status: 'ACTIVE', email: 'admin@example.com', tenantId: 'other' } },
  ])('rejects invalid current actor authority, including replay %j', async (patch) => {
    const h = harness(); const body = h.body(); await h.post(body);
    for (const [key, value] of Object.entries(patch)) if (value === null) h.store.delete(key); else h.store.set(key, value);
    expect((await request(h.app).get('/api/v1/admin/auth-governance/people-link-candidates?identityKey=staff@example.com')).status).toBe(403);
    expect((await h.post(body)).status).toBe(403);
  });
  it('rejects role granting fields in the link command', async () => {
    const h = harness(); expect((await h.post({ ...h.body(), role: 'admin' })).status).toBe(400);
  });
  it('allows a canonical Firebase admin without People membership to list and link', async () => {
    const h = harness({ patch: { 'orgs/t/persons/admin': null } });
    const response = await request(h.app).get('/api/v1/admin/auth-governance/people-link-candidates?identityKey=staff@example.com');
    expect(response.status).toBe(200);
    expect((await h.post()).status).toBe(200);
    expect(h.store.has('orgs/t/persons/admin')).toBe(false);
    expect(h.store.has('orgs/t/members/u')).toBe(false);
  });
  it('accepts an older canonical member without tenantId using the tenant-scoped document path', async () => {
    const h = harness({ patch: { 'orgs/t/members/a': { uid: 'a', email: 'ADMIN@example.com', role: 'admin', status: 'ACTIVE' }, 'orgs/t/persons/admin': null } });
    expect((await h.post()).status).toBe(200);
  });
  it.each([
    { authSource: 'headers' }, { authSource: undefined }, { actorEmail: '' }, { actorEmail: 'different@example.com' },
  ])('rejects unauthenticated or mismatched actor context %j on both routes', async (contextPatch) => {
    const h = harness({ contextPatch }); const before = [...h.store];
    expect((await request(h.app).get('/api/v1/admin/auth-governance/people-link-candidates?identityKey=staff@example.com')).status).toBe(403);
    expect((await h.post()).status).toBe(403);
    expect([...h.store]).toEqual(before);
  });
  it('does not silently link a recreated account with the same email', async () => {
    const h = harness({ authPatch: { uid: 'replacement-uid' } });
    expect((await h.post()).body.error).toBe('auth_identity_changed');
    expect(h.store.get('orgs/t/persons/p').uid).toBe(null);
  });
  it('rejects verified accounts outside the existing company domain policy', async () => {
    const h = harness({ allowedEmailDomains: ['mysc.co.kr'] });
    expect((await h.post()).body.error).toBe('email_domain_not_allowed');
    expect(h.store.get('orgs/t/persons/p').uid).toBe(null);
  });
});

const legacyPatch = {
  'orgs/t/persons/p': { name: 'Synthetic Staff', email: 'staff@example.com', uid: 'staff_example_com', tenantId: 't' },
  'orgs/t/members/staff_example_com': { email: 'staff@example.com', uid: 'staff_example_com', role: 'pm', tenantId: 't' },
};
const migrationBody = (h) => ({ ...h.body(), legacyMigration: { expectedLegacyUid: 'staff_example_com', confirmed: true } });
describe('explicit legacy UID migration', () => {
  it('migrates only People and audits before/after, preserves legacy role and replays', async () => {
    const h = harness({ patch: legacyPatch }); const body = migrationBody(h); const legacy = h.store.get('orgs/t/members/staff_example_com');
    const directory = await request(h.app).get('/api/v1/admin/auth-governance/people-link-candidates?identityKey=staff@example.com');
    expect(directory.body.people.find(p => p.personId === 'p').legacyMigrationEligible).toBe(true);
    const response = await h.post(body); expect(response.status).toBe(200);
    expect(h.store.get('orgs/t/persons/p').uid).toBe('u');
    expect(h.store.get('orgs/t/members/staff_example_com')).toEqual(legacy); expect(h.store.has('orgs/t/members/u')).toBe(false);
    expect(h.store.get('audit/test')).toMatchObject({ action: 'IDENTITY_LINK_MIGRATION', metadata: { previousUid: 'staff_example_com', nextUid: 'u', migration: true } });
    const audit = h.store.get('audit/test'); expect((await h.post(body)).headers['x-idempotency-replayed']).toBe('1'); expect(h.store.get('audit/test')).toBe(audit);
  });
  it.each([{ uid: 'staff_example_com' }, { uid: 'staff_example_com', disabled: true }])('rejects any existing old Auth', async oldAuth => {
    const h = harness({ patch: legacyPatch, oldAuth }); const before = [...h.store];
    expect((await h.post(migrationBody(h))).body.error).toBe('legacy_auth_exists'); expect([...h.store]).toEqual(before);
  });
  it('fails closed on old Auth lookup error and rolls back audit failures', async () => {
    for (const options of [{ oldAuthError: new Error('lookup unavailable') }, { failAudit: true }]) {
      const h = harness({ patch: legacyPatch, ...options }); const before = [...h.store];
      expect((await h.post(migrationBody(h))).status).toBe(500); expect([...h.store]).toEqual(before);
    }
  });
  it('requires explicit true migration confirmation; normal link still refuses overwrite', async () => {
    const h = harness({ patch: legacyPatch });
    expect((await h.post()).body.error).toBe('people_uid_conflict');
    expect((await h.post({ ...h.body(), legacyMigration: { expectedLegacyUid: 'staff_example_com', confirmed: false } })).status).toBe(400);
  });
  it.each([
    [{ 'orgs/t/persons/p': { email: 'staff@example.com', uid: 'arbitrary-real-uid' } }, 'legacy_identity_changed'],
    [{ 'orgs/t/persons/p': { email: '', uid: 'staff_example_com' } }, 'legacy_identity_changed'],
    [{ 'orgs/t/persons/duplicate': { uid: 'staff_example_com' } }, 'people_uid_ambiguous'],
    [{ 'orgs/t/persons/duplicate': { uid: 'u' } }, 'people_uid_ambiguous'],
    [{ 'orgs/t/persons/duplicate': { email: 'STAFF@example.com' } }, 'people_email_ambiguous'],
    [{ 'orgs/t/members/staff_example_com': null }, 'legacy_identity_changed'],
  ])('rejects conflicting migration %j', async (patch, code) => {
    const h = harness({ patch: { ...legacyPatch, ...patch } }); const before = [...h.store];
    expect((await h.post(migrationBody(h))).body.error).toBe(code); expect([...h.store]).toEqual(before);
  });
  it('rejects stale version and revoked actor without writes', async () => {
    const h = harness({ patch: legacyPatch }); const body = migrationBody(h);
    h.store.set('orgs/t/persons/p', { ...h.store.get('orgs/t/persons/p'), updatedAt: 'changed' });
    expect((await h.post(body)).body.error).toBe('people_identity_changed');
    h.store.set('orgs/t/members/a', { ...h.store.get('orgs/t/members/a'), status: 'INACTIVE' });
    expect((await h.post(migrationBody(h))).status).toBe(403); expect(h.store.has('audit/test')).toBe(false);
  });
});

describe('migration Auth revalidation', () => {
  it.each([{ uid: 'recreated' }, { disabled: true }, { emailVerified: false }, { providerData: [] }, { customClaims: { tenantId: 'elsewhere' } }])('rejects target change before commit %j', async changed => {
    const h = harness({ patch: legacyPatch, authSequence: [{}, changed] }); const before = [...h.store];
    expect((await h.post(migrationBody(h))).body.error).toBe('auth_identity_changed'); expect([...h.store]).toEqual(before);
  });
  it('checks old Auth again on a transaction retry and commits nothing if it appeared', async () => {
    let reads = 0;
    const h = harness({ patch: legacyPatch, retryTransaction: true, oldAuth: () => { if (++reads === 1) throw Object.assign(new Error('absent'), { code: 'auth/user-not-found' }); return { uid: 'staff_example_com' }; } });
    const before = [...h.store]; expect((await h.post(migrationBody(h))).body.error).toBe('legacy_auth_exists'); expect(reads).toBe(2); expect([...h.store]).toEqual(before);
  });
});
