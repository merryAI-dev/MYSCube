import { z } from 'zod';
import { asyncHandler, assertActorRoleAllowed, createHttpError, encryptAuditEmail, ROUTE_ROLES } from '../bff-utils.mjs';
import { parseWithSchema } from '../schemas.mjs';
import { buildRequestFingerprint, sha256, stableStringify } from '../utils.mjs';
import { extractTenantIdFromClaims, isAllowedEmail, parseAllowedEmailDomains } from '../auth.mjs';

const text = (value) => typeof value === 'string' ? value.trim() : '';
const email = (value) => text(value).toLowerCase();
const commandSchema = z.object({
  personId: z.string().trim().min(1).max(200).regex(/^[^/]+$/),
  expectedAuthUid: z.string().trim().min(1).max(128).regex(/^[^/]+$/),
  expectedPersonVersion: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1).max(500),
}).strict();

export function personLinkVersion(person) {
  return sha256(stableStringify({
    uid: text(person.uid), email: email(person.email), name: text(person.name),
    nickname: text(person.nickname), updatedAt: person.updatedAt || null,
  }));
}

function authIssue(user, identityKey, allowedDomains) {
  if (!user || !text(user.uid) || email(user.email) !== identityKey) return 'auth_identity_missing';
  if (!isAllowedEmail(identityKey, allowedDomains)) return 'email_domain_not_allowed';
  if (user.disabled) return 'auth_identity_disabled';
  if (!user.emailVerified || !user.providerData?.some((provider) => (
    provider.providerId === 'google.com' && email(provider.email) === identityKey
  ))) return 'auth_identity_unverified';
  return null;
}

const messages = {
  email_domain_not_allowed: '허용된 회사 이메일 계정만 인력 명부에 연결할 수 있습니다.',
  auth_identity_missing: '로그인 계정을 찾을 수 없습니다. 먼저 회사 Google 계정으로 로그인해 주세요.',
  auth_identity_disabled: '사용 중지된 로그인 계정은 연결할 수 없습니다.',
  auth_identity_unverified: '회사 Google 계정의 이메일 인증을 확인한 뒤 연결해 주세요.',
};

async function readAuth(authAdminService, identityKey) {
  if (!authAdminService?.getUserByEmail) throw createHttpError(503, '로그인 확인 서비스를 사용할 수 없습니다.', 'auth_admin_unavailable');
  try { return await authAdminService.getUserByEmail(identityKey); }
  catch (error) { if (error.code === 'auth/user-not-found') return null; throw error; }
}

function requireAdmin(actor, actorId, people) {
  if (actor.uid !== actorId || actor.role !== 'admin' || actor.status !== 'ACTIVE'
    || people.filter((person) => text(person.data.uid) === actorId).length !== 1) {
    throw createHttpError(403, '현재 관리자와 인력 명부의 연결을 확인할 수 없습니다.', 'member_authority_required');
  }
}

export function mountMemberPersonLinkRoutes(app, {
  db, now, authAdminService, auditChainService, idempotencyService, piiProtector,
  allowedEmailDomains = parseAllowedEmailDomains(process.env.BFF_ALLOWED_EMAIL_DOMAINS),
}) {
  app.get('/api/v1/admin/auth-governance/people-link-candidates', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.memberWrite, 'read person link candidates');
    const identityKey = email(req.query.identityKey);
    if (!identityKey || !identityKey.includes('@')) throw createHttpError(400, '로그인 이메일을 선택해 주세요.', 'invalid_identity');
    const { tenantId, actorId } = req.context;
    const [user, actorSnapshot, peopleSnapshot] = await Promise.all([
      readAuth(authAdminService, identityKey), db.doc(`orgs/${tenantId}/members/${actorId}`).get(),
      db.collection(`orgs/${tenantId}/persons`).get(),
    ]);
    const people = peopleSnapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() || {} }));
    requireAdmin(actorSnapshot.exists ? actorSnapshot.data() || {} : {}, actorId, people);
    const authTenant = extractTenantIdFromClaims(user?.customClaims);
    const issue = authIssue(user, identityKey, allowedEmailDomains)
      || (authTenant && authTenant !== tenantId ? 'member_identity_conflict' : null);
    const linked = people.filter((person) => text(person.data.uid) === user?.uid);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ identityKey, authUid: user?.uid || null, authVerified: !issue, authIssue: issue,
      linkedPersonId: linked.length === 1 ? linked[0].id : null,
      emailMatchPersonIds: people.filter((person) => email(person.data.email) === identityKey).map((person) => person.id),
      people: people.map(({ id, data }) => ({ personId: id, name: text(data.name), nickname: text(data.nickname),
        email: email(data.email), linkedUid: text(data.uid) || null, expectedPersonVersion: personLinkVersion(data) })),
    });
  }));

  app.post('/api/v1/admin/auth-governance/users/:identityKey/link-person', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.memberWrite, 'link verified person identity');
    const parsed = parseWithSchema(commandSchema, req.body, '인력 명부와 연결 근거를 확인해 주세요.');
    const identityKey = email(req.params.identityKey);
    const user = await readAuth(authAdminService, identityKey);
    const issue = authIssue(user, identityKey, allowedEmailDomains);
    if (issue) throw createHttpError(409, messages[issue], issue);
    if (user.uid !== parsed.expectedAuthUid) throw createHttpError(409, '로그인 계정이 변경되었습니다. 최신 계정을 다시 확인해 주세요.', 'auth_identity_changed');
    const { tenantId, actorId, actorEmail, requestId, idempotencyKey } = req.context;
    const authTenant = extractTenantIdFromClaims(user.customClaims);
    if (authTenant && authTenant !== tenantId) throw createHttpError(409, '다른 조직에 연결된 로그인 계정입니다.', 'member_identity_conflict');
    if (!text(idempotencyKey)) throw createHttpError(400, 'idempotency-key is required', 'idempotency_key_required');
    const timestamp = new Date(now()).toISOString();
    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    const requestFingerprint = buildRequestFingerprint({ method: 'POST', path: req.path, body: parsed });
    const result = await db.runTransaction(async (tx) => {
      const [actorSnapshot, peopleSnapshot, membersSnapshot, lock] = await Promise.all([
        tx.get(db.doc(`orgs/${tenantId}/members/${actorId}`)),
        tx.get(db.collection(`orgs/${tenantId}/persons`)),
        tx.get(db.collection(`orgs/${tenantId}/members`)),
        idempotencyService.checkInTransaction(tx, { tenantId, actorId, idempotencyKey, requestFingerprint, nowDate: new Date(timestamp) }),
      ]);
      const people = peopleSnapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() || {} }));
      requireAdmin(actorSnapshot.exists ? actorSnapshot.data() || {} : {}, actorId, people);
      if (lock.mode === 'conflict' || lock.mode === 'in_progress') throw createHttpError(409, lock.reason, `idempotency_${lock.mode}`);
      if (lock.mode === 'replay') return { replayed: true, body: lock.body };
      const person = people.find(({ id }) => id === parsed.personId);
      if (!person) throw createHttpError(404, '선택한 인력 명부가 없습니다.', 'people_not_found');
      if (text(person.data.tenantId) && person.data.tenantId !== tenantId) throw createHttpError(409, '인력 명부의 조직이 일치하지 않습니다.', 'member_identity_conflict');
      if (personLinkVersion(person.data) !== parsed.expectedPersonVersion) throw createHttpError(409, '인력 명부가 변경되었습니다. 최신 내용을 확인해 주세요.', 'people_identity_changed');
      if (text(person.data.uid) && text(person.data.uid) !== user.uid) throw createHttpError(409, '이미 다른 로그인 계정에 연결된 인력입니다.', 'people_uid_conflict');
      if (people.some(({ id, data }) => id !== person.id && text(data.uid) === user.uid)) throw createHttpError(409, '이 로그인 계정이 다른 인력 명부에 연결돼 있습니다.', 'people_uid_ambiguous');
      if (email(person.data.email) && email(person.data.email) !== identityKey) throw createHttpError(409, '명부 이메일과 로그인 이메일이 다릅니다. 본인 확인 후 명부를 먼저 정정해 주세요.', 'people_email_conflict');
      if (people.some(({ id, data }) => id !== person.id && email(data.email) === identityKey)) throw createHttpError(409, '같은 이메일의 인력 명부가 여러 건입니다. 중복을 확인해 주세요.', 'people_email_ambiguous');
      const legacyId = identityKey.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      if (membersSnapshot.docs.some((doc) => {
        const member = doc.data() || {};
        return (doc.id === user.uid && ((text(member.uid) && member.uid !== user.uid) || (email(member.email) && email(member.email) !== identityKey)))
          || (doc.id !== user.uid && email(member.email) === identityKey
            && (doc.id !== legacyId || (text(member.uid) && member.uid !== user.uid && member.uid !== legacyId)));
      })) throw createHttpError(409, '직원 권한 기록에 다른 계정 연결이 있습니다. 관리자 확인이 필요합니다.', 'member_identity_conflict');
      const alreadyLinked = text(person.data.uid) === user.uid && email(person.data.email) === identityKey;
      const body = { identityKey, personId: person.id, uid: user.uid, status: 'LINKED', alreadyLinked, permissionSyncRequired: true };
      if (!alreadyLinked) {
        await auditChainService.appendManyInTransaction(tx, [{ tenantId, entityType: 'person', entityId: person.id,
          action: 'IDENTITY_LINK', actorId, actorRole: 'admin', actorEmailEnc, requestId,
          details: '관리자 확인으로 인력 명부와 검증된 로그인 계정을 연결했습니다.',
          metadata: { source: 'auth_governance_person_link', reason: parsed.reason, previousUid: text(person.data.uid) || null,
            nextUid: user.uid, previousPersonVersion: parsed.expectedPersonVersion, identityKey }, timestamp,
        }]);
        tx.set(db.doc(`orgs/${tenantId}/persons/${person.id}`), {
          uid: user.uid, email: identityKey, updatedAt: timestamp, updatedBy: actorId,
          identityLink: { verifiedEmail: identityKey, authProvider: 'google.com', confirmedBy: actorId, confirmedAt: timestamp, requestId, reason: parsed.reason },
        }, { merge: true });
      }
      idempotencyService.completeInTransaction(tx, { ref: lock.ref, tenantId, actorId, idempotencyKey, requestFingerprint,
        responseStatus: 200, responseBody: body, requestId, method: 'POST', path: req.path, nowDate: new Date(timestamp) });
      return { replayed: false, body };
    });
    if (result.replayed) res.setHeader('x-idempotency-replayed', '1');
    res.json(result.body);
  }));
}
