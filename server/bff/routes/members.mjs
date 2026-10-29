import { canActorAssignRole } from '../rbac-policy.mjs';
import { createOutboxEvent, enqueueOutboxEventInTransaction } from '../outbox.mjs';
import {
  asyncHandler, createMutatingRoute, assertActorRoleAllowed,
  ROUTE_ROLES, createHttpError, normalizeRole, encryptAuditEmail, readOptionalText,
} from '../bff-utils.mjs';
import {
  parseWithSchema, memberBulkDeepSyncSchema, memberDeepSyncSchema, memberRoleUpdateSchema,
} from '../schemas.mjs';
import {
  buildDeepSyncPlan,
  mergeAuthGovernanceDirectory,
  parseBootstrapAdminEmails,
} from '../auth-governance.mjs';
import { buildRequestFingerprint, stableStringify } from '../utils.mjs';
import { mountMemberPersonLinkRoutes } from './member-person-link.mjs';

async function listAllAuthUsers(authAdminService) {
  if (!authAdminService || typeof authAdminService.listUsers !== 'function') {
    throw createHttpError(503, '로그인 확인 서비스가 설정되지 않았습니다. 담당자에게 문의해 주세요.', 'auth_admin_unavailable');
  }

  const users = [];
  let pageToken;
  do {
    const page = await authAdminService.listUsers(1000, pageToken);
    for (const user of page.users || []) {
      users.push({
        uid: user.uid,
        email: user.email || '',
        displayName: user.displayName || '',
        disabled: Boolean(user.disabled),
        customClaims: user.customClaims || {},
      });
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

async function listMemberDocs(db, tenantId) {
  const snap = await db.collection(`orgs/${tenantId}/members`).get();
  return snap.docs.map((doc) => ({
    docId: doc.id,
    data: doc.data() || {},
  }));
}

async function listProjectPermissionDocs(db, tenantId) {
  const snap = await db.collection(`orgs/${tenantId}/projects`).get();
  return snap.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      id: String(data.id || doc.id || '').trim(),
      name: String(data.name || data.shortName || data.id || doc.id || '').trim(),
      registeredById: String(data.registeredById || '').trim(),
      managerId: String(data.managerId || '').trim(),
      executiveApproverId: String(data.executiveApproverId || '').trim(),
      trashedAt: data.trashedAt || null,
    };
  }).filter((project) => project.id && !project.trashedAt);
}

function textList(values) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}

export function buildMemberPermissionOverview(entry, projects) {
  const member = {
    ...(entry.legacyMembers[0]?.data || {}),
    ...(entry.canonicalMember?.data || {}),
  };
  const profile = member.portalProfile && typeof member.portalProfile === 'object'
    ? member.portalProfile
    : {};
  const assignedIds = new Set(textList([
    member.projectId,
    ...(Array.isArray(member.projectIds) ? member.projectIds : []),
    profile.projectId,
    ...(Array.isArray(profile.projectIds) ? profile.projectIds : []),
  ]));
  const actorId = String(entry.authUid || entry.canonicalMember?.uid || member.uid || '').trim();
  const canonicalDocId = readOptionalText(entry.canonicalMember?.docId);
  const canonicalUid = readOptionalText(entry.canonicalMember?.uid || entry.canonicalMember?.data?.uid);
  const isActive = !entry.authDisabled
    && Boolean(actorId)
    && canonicalDocId === actorId
    && canonicalUid === actorId
    && readOptionalText(entry.canonicalMember?.data?.status).toUpperCase() === 'ACTIVE';
  const runtimeRole = normalizeRole(entry.canonicalMember?.data?.role);
  // Every member works across all projects; see CROSS_PROJECT_ROLES in src/app/platform/rbac.ts.
  const crossProject = true;
  const organizationHeadProjects = projects.filter((project) => actorId && project.executiveApproverId === actorId);
  const accessibleProjects = projects.filter((project) => (
    crossProject
    || assignedIds.has(project.id)
    || (actorId && (project.registeredById === actorId || project.managerId === actorId || project.executiveApproverId === actorId))
  ));

  return {
    isActive,
    accessibleProjects: accessibleProjects.map(({ id, name }) => ({ id, name })),
    organizationHeadProjects: organizationHeadProjects.map(({ id, name }) => ({ id, name })),
    canRequestCashflowClose: isActive && accessibleProjects.length > 0,
    canApproveProjectRegistration: isActive && organizationHeadProjects.length > 0,
    canDecideCashflowReopen: isActive && (runtimeRole === 'admin' || organizationHeadProjects.length > 0),
  };
}

function buildGovernanceSummary(entries) {
  return {
    total: entries.length,
    needsDeepSync: entries.filter((entry) => entry.needsDeepSync).length,
    missingAuth: entries.filter((entry) => entry.driftFlags.includes('missing_auth')).length,
    missingCanonicalMember: entries.filter((entry) => entry.driftFlags.includes('missing_canonical_member')).length,
    duplicateMemberDocs: entries.filter((entry) => entry.driftFlags.includes('duplicate_member_docs')).length,
    bootstrapCandidates: entries.filter((entry) => entry.bootstrapAdmin).length,
  };
}

function bulkDeepSyncFailure(error) {
  const errorCode = typeof error?.code === 'string' ? error.code : 'internal_error';
  const messages = {
    forbidden: '이 권한을 지정할 수 없습니다. 관리자 권한을 확인해 주세요.',
    member_authority_required: '현재 관리자 권한을 확인할 수 없습니다. 다시 로그인한 뒤 시도해 주세요.',
    last_admin_lockout: '마지막 관리자의 권한은 변경할 수 없습니다.',
    people_uid_unlinked: '대상 구성원이 People 명부의 UID와 연결되지 않았습니다.',
    people_uid_ambiguous: '대상 UID에 둘 이상의 People 레코드가 연결되어 있습니다.',
    auth_governance_target_changed: '대상 구성원 정보가 방금 변경되었습니다. 목록을 새로고침한 뒤 다시 시도해 주세요.',
    not_found: '대상 구성원을 찾지 못했습니다. 목록을 새로고침한 뒤 다시 시도해 주세요.',
  };
  return {
    status: 'FAILED',
    errorCode,
    message: messages[errorCode] || '이 구성원의 권한을 반영하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  };
}

function activeCanonicalAdminUids(adminsSnapshot) {
  return Array.from(new Set((adminsSnapshot?.docs || []).flatMap((doc) => {
    const admin = doc.data() || {};
    const uid = readOptionalText(admin.uid);
    return doc.id === uid && readOptionalText(admin.status).toUpperCase() === 'ACTIVE'
      ? [uid]
      : [];
  })));
}

function requireActorPeopleAuthority(actorPeopleSnapshot) {
  if (actorPeopleSnapshot?.size !== 1) {
    throw createHttpError(403, '현재 관리자 권한을 확인할 수 없습니다. 다시 로그인한 뒤 시도해 주세요.', 'member_authority_required');
  }
}

async function exactPeopleLinkedUidsInTransaction({
  db,
  tx,
  tenantId,
  uids,
  prefetched = new Map(),
}) {
  const uniqueUids = Array.from(new Set(uids.filter(Boolean)));
  const missingUids = uniqueUids.filter((uid) => !prefetched.has(uid));
  const missingSnapshots = await Promise.all(missingUids.map((uid) => tx.get(
    db.collection(`orgs/${tenantId}/persons`).where('uid', '==', uid).limit(2),
  )));
  const snapshotsByUid = new Map(prefetched);
  missingUids.forEach((uid, index) => snapshotsByUid.set(uid, missingSnapshots[index]));
  return new Set(uniqueUids.filter((uid) => snapshotsByUid.get(uid)?.size === 1));
}

export function mountMemberRoutes(app, {
  db, now, idempotencyService, auditChainService, piiProtector, rbacPolicy, authAdminService,
}) {
  mountMemberPersonLinkRoutes(app, { db, now, idempotencyService, auditChainService, piiProtector, authAdminService });
  const loadGovernanceDirectory = async (tenantId) => {
    const [authUsers, memberDocs] = await Promise.all([
      listAllAuthUsers(authAdminService),
      listMemberDocs(db, tenantId),
    ]);
    return mergeAuthGovernanceDirectory({
      authUsers,
      memberDocs,
      bootstrapAdminEmails: parseBootstrapAdminEmails(process.env),
    });
  };

  const executeDeepSync = async ({ context, entry, identityKey, targetRole, reason }) => {
    const { tenantId, actorId, actorRole, actorEmail, requestId } = context;
    if (!entry) {
      throw createHttpError(404, `Auth governance user not found: ${identityKey}`, 'not_found');
    }
    if (!reason) {
      throw createHttpError(400, 'Role change reason is required', 'role_change_reason_required');
    }
    if (!canActorAssignRole(rbacPolicy, { actorRole, targetRole })) {
      throw createHttpError(403, `Role '${actorRole || 'unknown'}' cannot assign '${targetRole}'`, 'forbidden');
    }

    const timestamp = now();
    const plan = buildDeepSyncPlan({
      entry,
      targetRole,
      tenantId,
      actorId,
      timestamp,
      reason,
    });
    const outboxEvent = createOutboxEvent({
      tenantId,
      requestId,
      eventType: 'member.role_changed',
      entityType: 'member',
      entityId: plan.canonicalDocId,
      payload: {
        actorRole: actorRole || null,
        targetRole,
        reason,
        source: 'auth_governance_deep_sync',
      },
      createdAt: timestamp,
    });
    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    const canonicalRef = db.doc(`orgs/${tenantId}/members/${plan.canonicalDocId}`);
    const actorRef = db.doc(`orgs/${tenantId}/members/${actorId}`);
    const actorPeopleQuery = db.collection(`orgs/${tenantId}/persons`)
      .where('uid', '==', actorId)
      .limit(2);
    const targetPeopleQuery = db.collection(`orgs/${tenantId}/persons`)
      .where('uid', '==', plan.canonicalPatch.uid)
      .limit(2);
    const adminsQuery = db.collection(`orgs/${tenantId}/members`).where('role', '==', 'admin');
    const expectedTargetDocs = new Map(
      (entry.allMemberDocs || []).map((member) => [
        readOptionalText(member.docId),
        stableStringify(member.data || {}),
      ]).filter(([docId]) => docId),
    );
    if (!expectedTargetDocs.has(plan.canonicalDocId)) {
      expectedTargetDocs.set(plan.canonicalDocId, null);
    }
    const targetDocEntries = [...expectedTargetDocs.entries()].map(([docId, fingerprint]) => ({
      docId,
      fingerprint,
      ref: db.doc(`orgs/${tenantId}/members/${docId}`),
    }));
    const claimsPending = Boolean(plan.claims && entry.authUid);
    const authClaimsSync = claimsPending ? {
      status: 'PENDING',
      role: targetRole,
      tenantId,
      requestedAt: timestamp,
      requestedBy: actorId,
      requestId,
    } : null;
    const operationPath = `/api/v1/admin/auth-governance/users/${encodeURIComponent(identityKey)}/deep-sync`;
    const operationIdempotencyKey = `${context.idempotencyKey}:identity:${identityKey}`;
    const operationFingerprint = buildRequestFingerprint({
      method: 'POST',
      path: operationPath,
      body: { role: targetRole, reason },
    });
    const committedResult = {
      identityKey,
      email: plan.email,
      canonicalDocId: plan.canonicalDocId,
      role: targetRole,
      mirroredLegacyCount: plan.legacyPatches.length,
      claimsUpdated: false,
      claimsSyncStatus: claimsPending ? 'PENDING' : 'NOT_APPLICABLE',
      updatedAt: timestamp,
    };

    const transactionResult = await db.runTransaction(async (tx) => {
      const idempotency = await idempotencyService.checkInTransaction(tx, {
        tenantId,
        idempotencyKey: operationIdempotencyKey,
        requestFingerprint: operationFingerprint,
        actorId,
        nowDate: new Date(timestamp),
      });
      if (idempotency.mode === 'replay') return { replayed: true, body: idempotency.body };
      if (idempotency.mode === 'conflict' || idempotency.mode === 'in_progress') {
        throw createHttpError(409, idempotency.reason, `idempotency_${idempotency.mode}`);
      }
      const [actorSnapshot, actorPeopleSnapshot, adminsSnapshot, targetPeopleSnapshot, ...targetSnapshots] = await Promise.all([
        tx.get(actorRef),
        tx.get(actorPeopleQuery),
        tx.get(adminsQuery),
        tx.get(targetPeopleQuery),
        ...targetDocEntries.map(({ ref }) => tx.get(ref)),
      ]);
      const actor = actorSnapshot.exists ? actorSnapshot.data() || {} : {};
      if (
        readOptionalText(actor.uid) !== actorId
        || readOptionalText(actor.status).toUpperCase() !== 'ACTIVE'
        || normalizeRole(actor.role) !== 'admin'
      ) {
        throw createHttpError(403, '현재 관리자 권한을 확인할 수 없습니다. 다시 로그인한 뒤 시도해 주세요.', 'member_authority_required');
      }
      requireActorPeopleAuthority(actorPeopleSnapshot);
      if (targetPeopleSnapshot.size !== 1) {
        throw createHttpError(
          409,
          targetPeopleSnapshot.size > 1 ? 'People UID is ambiguous' : 'People UID is not linked',
          targetPeopleSnapshot.size > 1 ? 'people_uid_ambiguous' : 'people_uid_unlinked',
        );
      }
      const targetChanged = targetDocEntries.some(({ fingerprint }, index) => {
        const snapshot = targetSnapshots[index];
        const currentFingerprint = snapshot.exists ? stableStringify(snapshot.data() || {}) : null;
        return currentFingerprint !== fingerprint;
      });
      if (targetChanged) {
        throw createHttpError(
          409,
          'Auth governance target changed after it was loaded',
          'auth_governance_target_changed',
        );
      }
      if (targetRole !== 'admin') {
        const changedDocIds = new Set([plan.canonicalDocId, ...plan.legacyPatches.map((legacy) => legacy.docId)]);
        const activeAdminUids = activeCanonicalAdminUids(adminsSnapshot);
        const peopleLinkedAdminUids = await exactPeopleLinkedUidsInTransaction({
          db,
          tx,
          tenantId,
          uids: activeAdminUids,
          prefetched: new Map([
            [actorId, actorPeopleSnapshot],
            [plan.canonicalPatch.uid, targetPeopleSnapshot],
          ]),
        });
        const exactActiveAdminUids = activeAdminUids.filter((uid) => peopleLinkedAdminUids.has(uid));
        const changesActiveAdmin = exactActiveAdminUids.some((uid) => changedDocIds.has(uid));
        const remainingAdmins = exactActiveAdminUids.filter((uid) => !changedDocIds.has(uid));
        if (changesActiveAdmin && remainingAdmins.length === 0) {
          throw createHttpError(409, 'Cannot remove the last remaining admin', 'last_admin_lockout');
        }
      }

      await auditChainService.appendManyInTransaction(tx, [{
        tenantId,
        entityType: 'member',
        entityId: plan.canonicalDocId,
        action: 'ROLE_CHANGE',
        actorId,
        actorRole: 'admin',
        actorEmailEnc,
        requestId,
        details: `구성원 deep sync: ${entry.effectiveRole} -> ${targetRole}`,
        metadata: {
          source: 'auth_governance_deep_sync',
          previousRole: entry.effectiveRole,
          nextRole: targetRole,
          identityKey,
          canonicalDocId: plan.canonicalDocId,
          mirroredLegacyCount: plan.legacyPatches.length,
          claimsSyncStatus: claimsPending ? 'PENDING' : 'NOT_APPLICABLE',
          reason,
          outboxId: outboxEvent.id,
        },
        timestamp,
      }]);
      tx.set(canonicalRef, {
        ...plan.canonicalPatch,
        ...(authClaimsSync ? { authClaimsSync } : {}),
      }, { merge: true });
      for (const legacy of plan.legacyPatches) {
        tx.set(db.doc(`orgs/${tenantId}/members/${legacy.docId}`), legacy.patch, { merge: true });
      }
      enqueueOutboxEventInTransaction(tx, db, outboxEvent);
      idempotencyService.completeInTransaction(tx, {
        ref: idempotency.ref,
        tenantId,
        idempotencyKey: operationIdempotencyKey,
        requestFingerprint: operationFingerprint,
        responseStatus: 200,
        responseBody: committedResult,
        actorId,
        requestId,
        method: 'POST',
        path: operationPath,
        nowDate: new Date(timestamp),
      });
      return { replayed: false, body: committedResult };
    });
    if (transactionResult.replayed) return transactionResult.body;

    let claimsUpdated = false;
    if (claimsPending) {
      try {
        await authAdminService.setCustomUserClaims(entry.authUid, plan.claims);
        claimsUpdated = true;
        await canonicalRef.set({
          authClaimsSync: {
            ...authClaimsSync,
            status: 'SYNCED',
            syncedAt: timestamp,
          },
        }, { merge: true });
      } catch {
        claimsUpdated = false;
      }
    }

    const result = {
      ...committedResult,
      claimsUpdated,
      claimsSyncStatus: claimsPending ? (claimsUpdated ? 'SYNCED' : 'PENDING') : 'NOT_APPLICABLE',
    };
    if (claimsPending) {
      try {
        await idempotencyService.complete({
          tenantId,
          idempotencyKey: operationIdempotencyKey,
          requestFingerprint: operationFingerprint,
          responseStatus: 200,
          responseBody: result,
          requestId,
        });
      } catch {
        // The committed PENDING response remains replay-safe and visible for a later retry.
      }
    }
    return result;
  };

  app.get('/api/v1/admin/auth-governance/users', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.memberWrite, 'read auth governance users');
    const { tenantId } = req.context;
    const [authUsers, memberDocs, projects] = await Promise.all([
      listAllAuthUsers(authAdminService),
      listMemberDocs(db, tenantId),
      listProjectPermissionDocs(db, tenantId),
    ]);
    const directory = mergeAuthGovernanceDirectory({
      authUsers,
      memberDocs,
      bootstrapAdminEmails: parseBootstrapAdminEmails(process.env),
    });
    const items = directory.map((entry) => ({
      ...entry,
      permissionOverview: buildMemberPermissionOverview(entry, projects),
    }));
    res.status(200).json({
      items,
      summary: buildGovernanceSummary(items),
    });
  }));

  app.patch('/api/v1/members/:memberId/role', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.memberWrite, 'update member roles');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const { memberId } = req.params;
    const timestamp = now();
    const parsed = parseWithSchema(memberRoleUpdateSchema, req.body, 'Invalid role update payload');
    const targetRole = normalizeRole(parsed.role);
    const reason = parsed.reason?.trim() || '';

    if (!canActorAssignRole(rbacPolicy, { actorRole, targetRole })) {
      throw createHttpError(403, `Role '${actorRole || 'unknown'}' cannot assign '${targetRole}'`, 'forbidden');
    }

    const memberRef = db.doc(`orgs/${tenantId}/members/${memberId}`);
    const actorRef = db.doc(`orgs/${tenantId}/members/${actorId}`);
    const actorPeopleQuery = db.collection(`orgs/${tenantId}/persons`).where('uid', '==', actorId).limit(2);
    const peopleQuery = db.collection(`orgs/${tenantId}/persons`).where('uid', '==', memberId).limit(2);
    const adminsQuery = db.collection(`orgs/${tenantId}/members`).where('role', '==', 'admin');
    const outboxEvent = createOutboxEvent({
      tenantId,
      requestId,
      eventType: 'member.role_changed',
      entityType: 'member',
      entityId: memberId,
      payload: {
        actorRole: actorRole || null,
        targetRole,
        reason: reason || null,
      },
      createdAt: timestamp,
    });
    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);

    const result = await db.runTransaction(async (tx) => {
      const [snap, actorSnap, actorPeopleSnap, peopleSnap, adminsSnap] = await Promise.all([
        tx.get(memberRef),
        tx.get(actorRef),
        tx.get(actorPeopleQuery),
        tx.get(peopleQuery),
        tx.get(adminsQuery),
      ]);
      if (!snap.exists) {
        throw createHttpError(404, `Member not found: ${memberId}`, 'not_found');
      }

      const current = snap.data() || {};
      const actor = actorSnap.exists ? actorSnap.data() || {} : {};
      if (
        readOptionalText(actor.uid) !== actorId
        || readOptionalText(actor.status).toUpperCase() !== 'ACTIVE'
        || normalizeRole(actor.role) !== normalizeRole(actorRole)
      ) {
        throw createHttpError(403, '현재 관리자 권한을 확인할 수 없습니다. 다시 로그인한 뒤 시도해 주세요.', 'member_authority_required');
      }
      requireActorPeopleAuthority(actorPeopleSnap);
      if (
        readOptionalText(current.uid) !== memberId
        || readOptionalText(current.status).toUpperCase() !== 'ACTIVE'
      ) {
        throw createHttpError(409, '대상 구성원의 활성 People UID 연결을 확인할 수 없습니다.', 'member_uid_invalid');
      }
      if (peopleSnap.size !== 1) {
        throw createHttpError(
          409,
          peopleSnap.size > 1 ? 'People UID is ambiguous' : 'People UID is not linked',
          peopleSnap.size > 1 ? 'people_uid_ambiguous' : 'people_uid_unlinked',
        );
      }
      const previousRole = normalizeRole(current.role || 'viewer');

      if (previousRole === targetRole) return { previousRole, changed: false };
      if (!reason) {
        throw createHttpError(400, 'Role change reason is required', 'role_change_reason_required');
      }

      if (previousRole === 'admin' && targetRole !== 'admin') {
        const activeAdminUids = activeCanonicalAdminUids(adminsSnap);
        const peopleLinkedAdminUids = await exactPeopleLinkedUidsInTransaction({
          db,
          tx,
          tenantId,
          uids: activeAdminUids,
          prefetched: new Map([
            [actorId, actorPeopleSnap],
            [memberId, peopleSnap],
          ]),
        });
        const activeExactAdminCount = activeAdminUids.filter((uid) => peopleLinkedAdminUids.has(uid)).length;
        if (activeExactAdminCount <= 1) {
          throw createHttpError(409, 'Cannot remove the last remaining admin', 'last_admin_lockout');
        }
      }

      await auditChainService.appendManyInTransaction(tx, [{
        tenantId,
        entityType: 'member',
        entityId: memberId,
        action: 'ROLE_CHANGE',
        actorId,
        actorRole,
        actorEmailEnc,
        requestId,
        details: `멤버 권한 변경: ${previousRole} -> ${targetRole}`,
        metadata: {
          source: 'bff',
          previousRole,
          nextRole: targetRole,
          reason,
          outboxId: outboxEvent.id,
        },
        timestamp,
      }]);
      tx.set(memberRef, {
        tenantId,
        role: targetRole,
        updatedAt: timestamp,
        updatedBy: actorId,
        roleChangedAt: timestamp,
        roleChangedBy: actorId,
        roleChangeReason: reason,
      }, { merge: true });
      enqueueOutboxEventInTransaction(tx, db, outboxEvent);

      return { previousRole, changed: true };
    });

    return {
      status: 200,
      body: {
        id: memberId,
        previousRole: result.previousRole,
        role: targetRole,
        changed: result.changed,
        updatedAt: timestamp,
      },
    };
  }));

  app.post('/api/v1/admin/auth-governance/users/deep-sync-bulk', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.memberWrite, 'bulk deep sync auth governance users');
    const parsed = parseWithSchema(memberBulkDeepSyncSchema, req.body, 'Invalid auth governance bulk sync payload');
    const directory = await loadGovernanceDirectory(req.context.tenantId);
    const entries = new Map(directory.map((entry) => [entry.identityKey, entry]));
    const outcomes = [];

    for (const item of parsed.items) {
      const identityKey = item.identityKey.trim().toLowerCase();
      try {
        const result = await executeDeepSync({
          context: req.context,
          entry: entries.get(identityKey),
          identityKey,
          targetRole: normalizeRole(item.role),
          reason: parsed.reason,
        });
        outcomes.push({ identityKey, status: 'SUCCEEDED', result });
      } catch (error) {
        outcomes.push({ identityKey, ...bulkDeepSyncFailure(error) });
      }
    }

    const succeeded = outcomes.filter(({ status }) => status === 'SUCCEEDED');
    return {
      status: 200,
      body: {
        outcomes,
        summary: {
          total: outcomes.length,
          succeeded: succeeded.length,
          failed: outcomes.length - succeeded.length,
          pendingClaimsSync: succeeded.filter(({ result }) => result.claimsSyncStatus === 'PENDING').length,
        },
      },
    };
  }));

  app.post('/api/v1/admin/auth-governance/users/:identityKey/deep-sync', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.memberWrite, 'deep sync auth governance user');
    const parsed = parseWithSchema(memberDeepSyncSchema, req.body, 'Invalid auth governance sync payload');
    const identityKey = decodeURIComponent(req.params.identityKey || '').trim().toLowerCase();
    const directory = await loadGovernanceDirectory(req.context.tenantId);
    const body = await executeDeepSync({
      context: req.context,
      entry: directory.find((item) => item.identityKey === identityKey),
      identityKey,
      targetRole: normalizeRole(parsed.role),
      reason: parsed.reason?.trim() || '',
    });
    return { status: 200, body };
  }));
}
