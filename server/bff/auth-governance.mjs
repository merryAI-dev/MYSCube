import { createHttpError, normalizeRole, readOptionalText } from './bff-utils.mjs';

export const DEFAULT_BOOTSTRAP_ADMIN_EMAILS = [
  'mwbyun1220@mysc.co.kr',
];

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeStatus(value) {
  const normalized = readOptionalText(value).toUpperCase();
  if (normalized === 'ACTIVE' || normalized === 'INACTIVE' || normalized === 'PENDING') return normalized;
  return undefined;
}

function buildLegacyMemberDocId(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return '';
  return normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function toMergeKey({ email, uid }) {
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) return normalizedEmail;
  const normalizedUid = readOptionalText(uid);
  return normalizedUid ? `uid:${normalizedUid}` : '';
}

function classifyMemberDoc(doc) {
  const data = doc?.data || {};
  const email = normalizeEmail(data.email);
  const docId = readOptionalText(doc.docId);
  const expectedLegacyId = buildLegacyMemberDocId(email);
  const uid = readOptionalText(data.uid || docId);
  return {
    docId,
    tenantId: readOptionalText(data.tenantId),
    uid,
    email,
    role: normalizeRole(data.role || ''),
    status: normalizeStatus(data.status) || null,
    name: readOptionalText(data.name),
    data,
    isLegacy: !!expectedLegacyId && docId === expectedLegacyId,
  };
}

function pickCanonicalMember(memberDocs, authUid) {
  if (!Array.isArray(memberDocs) || memberDocs.length === 0) return null;
  const normalizedAuthUid = readOptionalText(authUid);
  if (normalizedAuthUid) {
    const exact = memberDocs.find((doc) => doc.docId === normalizedAuthUid)
      || memberDocs.find((doc) => !doc.isLegacy && doc.uid === normalizedAuthUid);
    if (exact) return exact;
  }
  return memberDocs.find((doc) => !doc.isLegacy) || null;
}

function pickBaseMemberData(entry) {
  return {
    ...(entry.legacyMembers[0]?.data || {}),
    ...(entry.canonicalMember?.data || {}),
  };
}

function computeEffectiveRole(entry) {
  return (
    normalizeRole(entry.canonicalMember?.role || '')
    || normalizeRole(entry.legacyMembers[0]?.role || '')
    || normalizeRole(entry.claimRole || '')
    || (entry.bootstrapAdmin ? 'admin' : '')
    || 'pm'
  );
}

function computeDriftFlags(entry) {
  const flags = [];
  if (!entry.authUid) flags.push('missing_auth');
  if (!entry.canonicalMember) flags.push('missing_canonical_member');
  if (!entry.canonicalMember && entry.legacyMembers.length > 0) flags.push('legacy_only');
  const canonical = entry.canonicalMember;
  const conflictingDocs = entry.allMemberDocs.filter((doc) => doc.docId !== canonical?.docId && !(
    doc.isLegacy && doc.uid === doc.docId && canonical?.docId === entry.authUid && doc.data.canonicalUid === entry.authUid
    && canonical.uid === entry.authUid && doc.email === canonical.email
    && doc.role === canonical.role && doc.status === canonical.status
    && doc.data.tenantId === canonical.data.tenantId
  ));
  if (conflictingDocs.length > 0 && entry.allMemberDocs.length > 1) flags.push('duplicate_member_docs');

  const canonicalRole = normalizeRole(entry.canonicalMember?.role || '');
  const legacyRole = normalizeRole(entry.legacyMembers[0]?.role || '');
  if (canonicalRole && legacyRole && canonicalRole !== legacyRole) flags.push('legacy_role_mismatch');

  if (entry.authUid && entry.effectiveRole && (normalizeRole(entry.claimRole || '') !== normalizeRole(entry.effectiveRole) || entry.claimTenantId !== canonical?.data.tenantId)) {
    flags.push('claim_mismatch');
  }

  if (entry.bootstrapAdmin && entry.effectiveRole !== 'admin') {
    flags.push('bootstrap_admin_not_adopted');
  }

  return flags;
}

export function parseBootstrapAdminEmails(env = process.env) {
  const csv = typeof env.BOOTSTRAP_ADMIN_EMAILS === 'string'
    ? env.BOOTSTRAP_ADMIN_EMAILS
    : (typeof env.VITE_BOOTSTRAP_ADMIN_EMAILS === 'string' ? env.VITE_BOOTSTRAP_ADMIN_EMAILS : '');
  const single = typeof env.BOOTSTRAP_ADMIN_EMAIL === 'string'
    ? env.BOOTSTRAP_ADMIN_EMAIL
    : (typeof env.VITE_BOOTSTRAP_ADMIN_EMAIL === 'string' ? env.VITE_BOOTSTRAP_ADMIN_EMAIL : '');

  return Array.from(new Set([
    ...DEFAULT_BOOTSTRAP_ADMIN_EMAILS,
    ...String(csv || '').split(','),
    single,
  ].map(normalizeEmail).filter(Boolean)));
}

export function mergeAuthGovernanceDirectory({ authUsers = [], memberDocs = [], bootstrapAdminEmails = [] }) {
  const bootstrapSet = new Set((bootstrapAdminEmails || []).map(normalizeEmail).filter(Boolean));
  const buckets = new Map();

  for (const authUser of authUsers) {
    const entry = {
      uid: readOptionalText(authUser.uid),
      email: normalizeEmail(authUser.email),
      displayName: readOptionalText(authUser.displayName),
      disabled: Boolean(authUser.disabled),
      customClaims: authUser.customClaims || {},
    };
    const key = toMergeKey({ email: entry.email, uid: entry.uid });
    if (!key) continue;
    const current = buckets.get(key) || { authUser: null, memberDocs: [] };
    current.authUser = entry;
    buckets.set(key, current);
  }

  for (const rawDoc of memberDocs) {
    const doc = classifyMemberDoc(rawDoc);
    const key = toMergeKey({ email: doc.email, uid: doc.uid });
    if (!key) continue;
    const current = buckets.get(key) || { authUser: null, memberDocs: [] };
    current.memberDocs.push(doc);
    buckets.set(key, current);
  }

  for (const email of bootstrapSet) {
    const key = toMergeKey({ email });
    if (!buckets.has(key)) {
      buckets.set(key, { authUser: null, memberDocs: [] });
    }
  }

  const entries = Array.from(buckets.entries()).map(([identityKey, bucket]) => {
    const authUser = bucket.authUser;
    const canonicalMember = pickCanonicalMember(bucket.memberDocs, authUser?.uid);
    const legacyMembers = bucket.memberDocs.filter((doc) => canonicalMember?.docId !== doc.docId && doc.isLegacy);
    const email = normalizeEmail(authUser?.email || canonicalMember?.email || legacyMembers[0]?.email || identityKey.replace(/^uid:/, ''));
    const entry = {
      identityKey,
      email,
      authUid: authUser?.uid || null,
      displayName: readOptionalText(authUser?.displayName || canonicalMember?.name || legacyMembers[0]?.name) || email,
      authDisabled: Boolean(authUser?.disabled),
      bootstrapAdmin: bootstrapSet.has(email),
      claimRole: normalizeRole(authUser?.customClaims?.role || '') || null,
      claimTenantId: readOptionalText(authUser?.customClaims?.tenantId) || null,
      canonicalMember,
      legacyMembers,
      allMemberDocs: bucket.memberDocs,
      effectiveRole: 'pm',
    };
    entry.effectiveRole = computeEffectiveRole(entry);
    entry.driftFlags = computeDriftFlags(entry);
    entry.needsDeepSync = entry.driftFlags.length > 0;
    return entry;
  });

  return entries.sort((a, b) => a.email.localeCompare(b.email, 'en'));
}

export function buildDeepSyncPlan({
  entry,
  targetRole,
  tenantId,
  actorId,
  timestamp,
  reason,
}) {
  const normalizedRole = normalizeRole(targetRole);
  if (!normalizedRole) {
    throw createHttpError(400, 'target role is required', 'invalid_role');
  }

  const email = normalizeEmail(entry?.email);
  if (!email) {
    throw createHttpError(400, 'email is required for deep sync', 'invalid_identity');
  }

  const base = pickBaseMemberData(entry);
  const canonicalDocId = readOptionalText(entry?.authUid || entry?.canonicalMember?.docId || base.uid || buildLegacyMemberDocId(email));
  const canonicalUid = readOptionalText(entry?.authUid || entry?.canonicalMember?.uid || canonicalDocId);
  const displayName = readOptionalText(entry?.displayName || base.name || email);
  const status = normalizeStatus(base.status) || 'ACTIVE';
  const normalizedReason = readOptionalText(reason);
  if (!normalizedReason) {
    throw createHttpError(400, 'Role change reason is required', 'role_change_reason_required');
  }

  const canonicalPatch = {
    ...base,
    uid: canonicalUid,
    // The member ledger owns the display name. A role change must not rewrite it with the
    // Google account name, so it is only seeded when the ledger has nothing yet.
    ...(readOptionalText(base.name) ? {} : { name: displayName }),
    email,
    role: normalizedRole,
    tenantId,
    status,
    updatedAt: timestamp,
    updatedBy: actorId,
    roleChangedAt: timestamp,
    roleChangedBy: actorId,
    roleChangeReason: normalizedReason,
  };

  const legacyPatches = (entry?.legacyMembers || [])
    .filter((member) => member.docId !== canonicalDocId)
    .map((member) => ({
      docId: member.docId,
      patch: {
        ...member.data,
        uid: member.uid || member.docId,
        canonicalUid,
        ...(readOptionalText(member.data?.name) ? {} : { name: displayName }),
        email,
        role: normalizedRole,
        tenantId,
        status: normalizeStatus(member.status) || status,
        updatedAt: timestamp,
        updatedBy: actorId,
        roleChangedAt: timestamp,
        roleChangedBy: actorId,
        roleChangeReason: normalizedReason,
      },
    }));

  return {
    identityKey: entry.identityKey,
    email,
    canonicalDocId,
    canonicalPatch,
    legacyPatches,
    claims: canonicalUid && entry?.authUid
      ? { role: normalizedRole, tenantId }
      : null,
  };
}
