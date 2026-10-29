import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mountMemberPersonLinkRoutes, personLinkVersion } from './member-person-link.mjs';
import { createIdempotencyService } from '../idempotency.mjs';

function harness({ authPatch = {}, patch = {}, failAudit = false, allowedEmailDomains = ['example.com'] } = {}) {
  const store = new Map(Object.entries({
    'orgs/t/members/a': { uid: 'a', role: 'admin', status: 'ACTIVE' },
    'orgs/t/persons/admin': { uid: 'a' },
    'orgs/t/persons/p': { name: 'Synthetic Staff', nickname: 'Test', email: '', uid: null, tenantId: 't' },
    ...patch,
  }).filter(([, value]) => value !== null));
  const db = {
    doc: (path) => ({ path, get: async () => ({ exists: store.has(path), data: () => store.get(path) }) }),
    collection: (path) => ({ get: async () => ({ docs: [...store].filter(([key]) => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')).map(([key, data]) => ({ id: key.split('/').at(-1), data: () => data })) }) }),
    async runTransaction(fn) {
      const pending = [];
      const result = await fn({ get: (ref) => ref.get(), set: (ref, value, options) => pending.push(() => store.set(ref.path, options?.merge ? { ...store.get(ref.path), ...value } : value)) });
      pending.forEach((write) => write());
      return result;
    },
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.context = { tenantId: 't', actorId: 'a', actorRole: req.header('role') || 'admin', actorEmail: '', requestId: 'request-test', idempotencyKey: req.header('idempotency-key') || 'link-test' }; next(); });
  mountMemberPersonLinkRoutes(app, {
    db, allowedEmailDomains, now: () => '2026-10-29T00:00:00Z', idempotencyService: createIdempotencyService(db),
    auditChainService: { async appendManyInTransaction(tx, entries) { if (failAudit) throw new Error('synthetic failure'); tx.set(db.doc('audit/test'), entries[0]); } },
    authAdminService: { async getUserByEmail() { return { uid: 'u', email: 'staff@example.com', emailVerified: true, disabled: false, providerData: [{ providerId: 'google.com', email: 'staff@example.com' }], ...authPatch }; } },
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
    { 'orgs/t/members/a': { uid: 'a', role: 'pm', status: 'ACTIVE' } },
    { 'orgs/t/members/a': { uid: 'a', role: 'admin', status: 'INACTIVE' } },
    { 'orgs/t/persons/admin': null },
    { 'orgs/t/persons/admin2': { uid: 'a' } },
  ])('rejects invalid current actor authority, including replay %j', async (patch) => {
    const h = harness(); const body = h.body(); await h.post(body);
    for (const [key, value] of Object.entries(patch)) if (value === null) h.store.delete(key); else h.store.set(key, value);
    expect((await h.post(body)).status).toBe(403);
  });
  it('rejects role granting fields in the link command', async () => {
    const h = harness(); expect((await h.post({ ...h.body(), role: 'admin' })).status).toBe(400);
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
