import { randomUUID } from 'node:crypto';
import {
  PROJECT_REQUEST_ROUTE_ROLES,
  assertActorRoleAllowed,
  asyncHandler,
  createHttpError,
  encryptAuditEmail,
  readOptionalText,
} from '../bff-utils.mjs';
import {
  assertEditLeaseActorAccessInTransaction,
  assertOwnedInTransaction,
  buildActiveEditLeaseDocument,
  buildEditLeaseAuditEntry,
  isInvalidOrClosedTransactionError,
  resolveEditLeaseDocumentId,
} from '../edit-lease.mjs';
import {
  parseWithSchema,
  projectDraftAttachmentDeleteSchema,
  projectRegistrationDraftAttachmentSchema,
  projectRegistrationDraftAttachmentUploadUrlSchema,
  projectRegistrationDraftCreateSchema,
  projectRegistrationDraftAliasSchema,
  projectRegistrationDraftPatchSchema,
  projectRegistrationDraftSubmitSchema,
} from '../schemas.mjs';
import { buildRequestFingerprint, sha256 } from '../utils.mjs';
import { DRAFT_ATTACHMENT_CLEANUP_EVENT_TYPE, createOutboxEvent } from '../outbox.mjs';
import { buildProjectRegistrationCanonicalDocuments } from './projects.mjs';
import {
  PROJECT_REGISTRATION_DOCUMENT_KINDS,
  missingProjectRegistrationRequiredDocumentKind,
  projectDocumentValidationError,
} from '../project-document-validation.mjs';

const RESOURCE_TYPE = 'project-registration';
const DOCUMENT_FIELD_BY_KIND = {
  contract: 'contractDocument',
  customer_business_registration: 'customerBusinessRegistrationDocument',
  quote: 'quoteDocument',
  proposal: 'proposalDocument',
  proposal_word_original: 'proposalWordOriginalDocument',
  proposal_ppt_original: 'proposalPptOriginalDocument',
  presentation_ppt_original: 'presentationPptOriginalDocument',
  rfp_request_evidence: 'rfpRequestEvidenceDocument',
};
const MAX_DRAFT_DOCUMENT_BYTES = 900 * 1024;
const MAX_ATTACHMENT_REFS = 100;
const MAX_DRAFT_PAYLOAD_DEPTH = 20;
const MAX_FIRESTORE_FIELD_NAME_BYTES = 1_500;

function requiredText(value, fieldName) {
  const normalized = readOptionalText(value);
  if (!normalized) throw createHttpError(400, `${fieldName} is required`, 'draft_request_invalid');
  return normalized;
}

function assertProjectAttachment(buffer, mimeType, fileName, documentKind) {
  const error = projectDocumentValidationError({ buffer, mimeType, fileName, documentKind });
  if (error) throw createHttpError(422, error, 'draft_attachment_invalid');
}

function documentId(value, fieldName) {
  const normalized = requiredText(value, fieldName);
  if (normalized.includes('/') || Buffer.byteLength(normalized, 'utf8') > 1_500) {
    throw createHttpError(400, `${fieldName} is invalid`, 'draft_request_invalid');
  }
  return normalized;
}

function positiveFence(value) {
  const fence = Number(value);
  if (!Number.isSafeInteger(fence) || fence < 1) {
    throw createHttpError(400, 'x-edit-fence must be a positive safe integer', 'draft_request_invalid');
  }
  return fence;
}

function isFirestoreTransactionConflict(error) {
  return error?.code === 10 || error?.code === '10' || error?.code === 'ABORTED'
    || /transaction.*aborted|aborted.*transaction/i.test(String(error?.message || ''));
}

function clockDate(clock) {
  const date = new Date(clock());
  if (!Number.isFinite(date.getTime())) throw new Error('Project registration draft clock returned an invalid time');
  return date;
}

function safeLegacyOwnerId(actorId) {
  const normalized = actorId
    .replace(/[^A-Za-z0-9가-힣._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'unknown';
}

function ownerId(draft = {}) {
  return readOptionalText(draft.ownerUid) || readOptionalText(draft.ownerId);
}

async function assertActiveRegistrationMembersInTransaction({ tx, db, tenantId, payload, actorId }) {
  const registeredById = documentId(
    readOptionalText(payload?.registeredById) || readOptionalText(payload?.managerId) || actorId,
    'registeredById',
  );
  const executiveApproverId = documentId(payload?.executiveApproverId, 'executiveApproverId');
  const selectedMembers = [registeredById, executiveApproverId];
  const memberSnaps = await Promise.all(selectedMembers.map((uid) => (
    tx.get(db.doc(`orgs/${tenantId}/members/${uid}`))
  )));
  const everyMemberIsActive = memberSnaps.every((snap, index) => {
    const member = snap.exists ? (snap.data() || {}) : {};
    return snap.exists
      && readOptionalText(member.uid) === selectedMembers[index]
      && readOptionalText(member.status).toUpperCase() === 'ACTIVE';
  });
  if (!everyMemberIsActive) {
    throw createHttpError(403, '같은 조직의 활성 구성원만 최종 보고자 (실무책임자)와 최종 결재자 (총괄책임자)로 선택할 수 있습니다.', 'forbidden');
  }
}

function attachmentRefs(draft = {}) {
  return Array.isArray(draft.attachmentRefs) ? draft.attachmentRefs : [];
}

function replacementDocumentKinds(documentKind) {
  return [documentKind];
}

function payloadWithoutAttachment(payload, documentKind, removedAttachments) {
  const next = { ...(payload || {}) };
  const field = DOCUMENT_FIELD_BY_KIND[documentKind];
  const removedPaths = new Set(removedAttachments.map((attachment) => readOptionalText(attachment?.path)).filter(Boolean));
  if (field && removedPaths.has(readOptionalText(next[field]?.path))) {
    next[field] = null;
  }
  if (documentKind === 'contract') next.contractAnalysis = null;
  return next;
}

function relocationAttachmentRefs(draft, current) {
  const prefix = `orgs/${current.tenantId}/project-registration-drafts/${current.draftId}/`;
  return attachmentRefs(draft).map((attachment) => {
    const documentKind = readOptionalText(attachment?.documentKind);
    const path = readOptionalText(attachment?.path);
    const objectName = path.startsWith(prefix) ? path.slice(prefix.length) : '';
    if (
      !PROJECT_REGISTRATION_DOCUMENT_KINDS.includes(documentKind)
      || !objectName
      || objectName.includes('/')
      || objectName === '.'
      || objectName === '..'
    ) {
      throw createHttpError(
        422,
        'Draft attachment path is outside the current private draft prefix',
        'draft_attachment_invalid',
      );
    }
    return {
      ...(readOptionalText(attachment?.attachmentId) ? { attachmentId: readOptionalText(attachment.attachmentId) } : {}),
      documentKind,
      path,
      name: readOptionalText(attachment?.name) || objectName,
      size: Number.isSafeInteger(attachment?.size) && attachment.size >= 0 ? attachment.size : 0,
      contentType: readOptionalText(attachment?.contentType) || 'application/octet-stream',
      ...(readOptionalText(attachment?.uploadedAt) ? { uploadedAt: readOptionalText(attachment.uploadedAt) } : {}),
    };
  });
}

function draftContract(draft = {}) {
  return {
    draftId: readOptionalText(draft.resourceId),
    resourceType: RESOURCE_TYPE,
    resourceId: readOptionalText(draft.resourceId),
    draftRevision: Number.isInteger(draft.draftRevision) ? draft.draftRevision : 0,
    payload: draft.payload && typeof draft.payload === 'object' && !Array.isArray(draft.payload)
      ? draft.payload
      : {},
    attachmentRefs: attachmentRefs(draft),
    stepIndex: Number.isInteger(draft.stepIndex) && draft.stepIndex >= 0 ? draft.stepIndex : 0,
    ...(readOptionalText(draft.alias) ? { alias: readOptionalText(draft.alias) } : {}),
    status: readOptionalText(draft.status) || 'ACTIVE',
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    ...(draft.submittedAt ? { submittedAt: draft.submittedAt } : {}),
  };
}

function assertDraftSize(draft) {
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(draft), 'utf8');
  } catch {
    throw createHttpError(422, 'Draft payload cannot be serialized', 'draft_payload_invalid');
  }
  if (bytes > MAX_DRAFT_DOCUMENT_BYTES) {
    throw createHttpError(413, 'Draft payload is too large', 'draft_payload_too_large');
  }
}

function invalidDraftPayload() {
  throw createHttpError(422, 'Draft payload contains unsupported JSON data', 'draft_payload_invalid');
}

function assertDraftPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalidDraftPayload();
  let rootPrototype;
  try {
    rootPrototype = Object.getPrototypeOf(payload);
  } catch {
    invalidDraftPayload();
  }
  if (rootPrototype !== Object.prototype && rootPrototype !== null) invalidDraftPayload();

  const activeAncestors = new WeakSet();
  const stack = [{ value: payload, depth: 0, parentIsArray: false, exiting: false }];

  while (stack.length > 0) {
    const frame = stack.pop();
    const { value, depth, parentIsArray, exiting } = frame;
    if (exiting) {
      activeAncestors.delete(value);
      continue;
    }
    if (depth > MAX_DRAFT_PAYLOAD_DEPTH) invalidDraftPayload();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) invalidDraftPayload();
      continue;
    }
    if (!value || typeof value !== 'object') invalidDraftPayload();
    if (activeAncestors.has(value)) invalidDraftPayload();

    if (Array.isArray(value)) {
      if (parentIsArray) invalidDraftPayload();
      let ownKeys;
      try {
        ownKeys = Reflect.ownKeys(value);
      } catch {
        invalidDraftPayload();
      }
      if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) invalidDraftPayload();
      activeAncestors.add(value);
      stack.push({ value, depth, parentIsArray, exiting: true });
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const key = String(index);
        let descriptor;
        try {
          descriptor = Object.getOwnPropertyDescriptor(value, key);
        } catch {
          invalidDraftPayload();
        }
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidDraftPayload();
        stack.push({ value: descriptor.value, depth: depth + 1, parentIsArray: true, exiting: false });
      }
      continue;
    }

    let prototype;
    let ownKeys;
    try {
      prototype = Object.getPrototypeOf(value);
      ownKeys = Reflect.ownKeys(value);
    } catch {
      invalidDraftPayload();
    }
    if (prototype !== Object.prototype && prototype !== null) invalidDraftPayload();
    const entries = [];
    for (const key of ownKeys) {
      if (
        typeof key !== 'string'
        || key === '__proto__'
        || Buffer.byteLength(key, 'utf8') > MAX_FIRESTORE_FIELD_NAME_BYTES
      ) {
        invalidDraftPayload();
      }
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        invalidDraftPayload();
      }
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidDraftPayload();
      entries.push(descriptor.value);
    }
    activeAncestors.add(value);
    stack.push({ value, depth, parentIsArray, exiting: true });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      stack.push({ value: entries[index], depth: depth + 1, parentIsArray: false, exiting: false });
    }
  }
}

function readDraftPayload(input, { allowMissing = false } = {}) {
  const hasPayload = Boolean(input && typeof input === 'object' && Object.hasOwn(input, 'payload'));
  if (!hasPayload) {
    if (allowMissing) return {};
    invalidDraftPayload();
  }
  const payload = input.payload;
  assertDraftPayload(payload);
  return payload;
}

function idempotencyError(lock) {
  if (lock.mode === 'conflict') {
    return createHttpError(409, lock.reason, 'idempotency_conflict');
  }
  if (lock.mode === 'in_progress') {
    return createHttpError(409, lock.reason, 'idempotency_in_progress');
  }
  return null;
}

function defaultDraftId() {
  return `prd_${randomUUID().replace(/-/g, '')}`;
}

function defaultAttachmentId() {
  return `att_${randomUUID().replace(/-/g, '')}`;
}

function defaultProjectId(timestamp) {
  return `p${timestamp.getTime()}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function defaultProjectRequestId(timestamp) {
  return `pr-${timestamp.getTime()}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function uniqueText(values) {
  return [...new Set(values.map(readOptionalText).filter(Boolean))];
}

function buildActorMemberAssignment(member, current, project, timestamp) {
  const profile = member?.portalProfile && typeof member.portalProfile === 'object'
    ? member.portalProfile
    : {};
  const projectIds = uniqueText([
    ...(Array.isArray(member?.projectIds) ? member.projectIds : []),
    member?.projectId,
    ...(Array.isArray(profile.projectIds) ? profile.projectIds : []),
    profile.projectId,
    project.id,
  ]);
  const projectNames = {
    ...(profile.projectNames && typeof profile.projectNames === 'object' ? profile.projectNames : {}),
    ...(member?.projectNames && typeof member.projectNames === 'object' ? member.projectNames : {}),
    [project.id]: project.name,
  };
  return {
    projectId: project.id,
    projectIds,
    projectNames,
    defaultWorkspace: 'portal',
    lastWorkspace: 'portal',
    lastLoginAt: timestamp,
    portalProfile: {
      ...profile,
      projectId: project.id,
      projectIds,
      projectNames,
      updatedAt: timestamp,
      updatedByUid: current.actorId,
      updatedByName: current.actorDisplayName,
    },
    updatedAt: timestamp,
  };
}

function draftAudit(current, actorRole, action, revision, timestamp, metadata = {}) {
  return {
    tenantId: current.tenantId,
    entityType: 'project_registration_draft',
    entityId: current.draftId,
    action,
    actorId: current.actorId,
    actorRole,
    actorEmailEnc: current.actorEmailEnc,
    requestId: current.requestId,
    details: `Project registration draft ${action.toLowerCase()}`,
    metadata: {
      source: 'bff',
      resourceType: RESOURCE_TYPE,
      resourceId: current.draftId,
      sessionIdHash: sha256(`${current.tenantId}:${current.sessionId}`),
      draftRevision: revision,
      ...metadata,
    },
    timestamp,
  };
}

function attachmentCleanupEvent(createEvent, current, paths, timestamp) {
  const uniquePaths = [...new Set(paths.map(readOptionalText).filter(Boolean))];
  if (uniquePaths.length === 0) return null;
  return createEvent({
    tenantId: current.tenantId,
    requestId: current.requestId,
    eventType: DRAFT_ATTACHMENT_CLEANUP_EVENT_TYPE,
    entityType: 'project_registration_draft',
    entityId: current.draftId,
    payload: { draftId: current.draftId, paths: uniquePaths },
    createdAt: timestamp,
  });
}

export function createProjectRegistrationDraftService({
  db,
  now = () => new Date().toISOString(),
  createDraftId = defaultDraftId,
  createLeaseId = randomUUID,
  createAttachmentId = defaultAttachmentId,
  createProjectId = defaultProjectId,
  createProjectRequestId = defaultProjectRequestId,
  createRegistrationOutboxEvent = createOutboxEvent,
  createAttachmentCleanupOutboxEvent = createOutboxEvent,
  auditChainService,
  idempotencyService,
  draftStorageService,
  rbacPolicy,
} = {}) {
  if (!db || typeof db.runTransaction !== 'function') throw new Error('Firestore is required for project registration drafts');
  if (!auditChainService || typeof auditChainService.appendManyInTransaction !== 'function') {
    throw new Error('Atomic audit chain service is required for project registration drafts');
  }
  if (!idempotencyService?.checkInTransaction || !idempotencyService?.completeInTransaction) {
    throw new Error('Atomic idempotency service is required for project registration drafts');
  }
  if (!rbacPolicy) throw new Error('RBAC policy is required for project registration drafts');

  function context(input, { draftRequired = true, sessionRequired = true, idempotencyRequired = true } = {}) {
    const tenantId = documentId(input?.tenantId, 'tenantId');
    const actorId = documentId(input?.actorId, 'actorId');
    const draftId = draftRequired ? documentId(input?.draftId, 'draftId') : undefined;
    return {
      tenantId,
      actorId,
      draftId,
      actorDisplayName: readOptionalText(input?.actorDisplayName) || '사용자',
      actorEmail: readOptionalText(input?.actorEmail),
      actorEmailEnc: readOptionalText(input?.actorEmailEnc) || undefined,
      requestId: readOptionalText(input?.requestId) || 'project-registration-draft-request',
      idempotencyKey: idempotencyRequired ? requiredText(input?.idempotencyKey, 'idempotencyKey') : undefined,
      sessionId: sessionRequired ? documentId(input?.sessionId, 'sessionId') : undefined,
    };
  }

  function draftRef(current) {
    return db.doc(`orgs/${current.tenantId}/projectRequestDrafts/${current.draftId}`);
  }

  function leaseRef(current) {
    return db.doc(
      `orgs/${current.tenantId}/editLeases/${resolveEditLeaseDocumentId(RESOURCE_TYPE, current.draftId)}`,
    );
  }

  async function actorAccess(tx, current) {
    return assertEditLeaseActorAccessInTransaction({
      tx,
      db,
      tenantId: current.tenantId,
      actorId: current.actorId,
      rbacPolicy,
    });
  }

  async function ownedDraft(tx, current) {
    const access = await actorAccess(tx, current);
    const ref = draftRef(current);
    const snap = await tx.get(ref);
    const draft = snap.exists ? (snap.data() || {}) : null;
    if (!draft || ownerId(draft) !== current.actorId) {
      throw createHttpError(404, 'Project registration draft not found', 'not_found');
    }
    return { ...access, ref, draft };
  }

  async function checkIdempotency(tx, current, requestFingerprint, nowDate) {
    return idempotencyService.checkInTransaction(tx, {
      tenantId: current.tenantId,
      idempotencyKey: current.idempotencyKey,
      requestFingerprint,
      actorId: current.actorId,
      nowDate,
    });
  }

  function completeIdempotency(tx, current, lock, { method, path, status, body, ttlSeconds }, nowDate) {
    idempotencyService.completeInTransaction(tx, {
      ref: lock.ref,
      tenantId: current.tenantId,
      idempotencyKey: current.idempotencyKey,
      requestFingerprint: lock.requestFingerprint,
      responseStatus: status,
      responseBody: body,
      actorId: current.actorId,
      requestId: current.requestId,
      method,
      path,
      nowDate,
      ...(ttlSeconds ? { ttlSeconds } : {}),
    });
  }

  function assertActive(draft) {
    if (draft.status !== 'ACTIVE') {
      throw createHttpError(409, 'Project registration draft is not active', 'draft_not_active');
    }
  }

  async function runFinalSubmitTransaction(callback) {
    try {
      return await db.runTransaction(callback);
    } catch (error) {
      if (!isInvalidOrClosedTransactionError(error)) throw error;
      return db.runTransaction(callback);
    }
  }

  function assertRevision(draft, expectedDraftRevision) {
    const actual = Number.isInteger(draft.draftRevision) ? draft.draftRevision : 0;
    if (actual !== expectedDraftRevision) {
      throw createHttpError(
        409,
        `Draft revision mismatch: expected ${expectedDraftRevision}, actual ${actual}`,
        'draft_version_conflict',
      );
    }
    return actual;
  }

  return {
    async create(input) {
      const current = context(input, { draftRequired: false });
      current.draftId = documentId(createDraftId(), 'draftId');
      const generatedLeaseId = documentId(createLeaseId(), 'leaseId');
      const payload = readDraftPayload(input, { allowMissing: true });
      assertDraftSize({ payload });
      const stepIndex = Number.isInteger(input?.stepIndex) && input.stepIndex >= 0 ? input.stepIndex : 0;
      const method = 'POST';
      const path = '/api/v1/project-registration-drafts';
      const requestFingerprint = buildRequestFingerprint({
        method,
        path,
        body: { actorId: current.actorId, sessionId: current.sessionId, payload, stepIndex },
      });
      const targetDraftRef = draftRef(current);
      const targetLeaseRef = leaseRef(current);
      const legacyRef = db.doc(
        `orgs/${current.tenantId}/projectRequestDrafts/registration-${safeLegacyOwnerId(current.actorId)}`,
      );

      return db.runTransaction(async (tx) => {
        const nowDate = clockDate(now);
        const timestamp = nowDate.toISOString();
        const { actorRole } = await actorAccess(tx, current);
        const lock = await checkIdempotency(tx, current, requestFingerprint, nowDate);
        if (lock.mode === 'replay') return { status: lock.status, body: lock.body, replayed: true };
        const lockError = idempotencyError(lock);
        if (lockError) throw lockError;

        const legacySnap = await tx.get(legacyRef);
        const legacy = legacySnap.exists ? (legacySnap.data() || {}) : null;
        const adoptLegacy = legacy
          && ownerId(legacy) === current.actorId
          && readOptionalText(legacy.status).toUpperCase() === 'DRAFT'
          && readOptionalText(legacy.migrationStatus).toUpperCase() !== 'ADOPTED';
        const adoptedPayload = adoptLegacy
          ? (legacy.payload && typeof legacy.payload === 'object' ? legacy.payload : legacy.payloadSnapshot)
          : null;
        const adoptedAttachments = adoptLegacy
          ? (Array.isArray(legacy.attachmentRefs)
            ? legacy.attachmentRefs
            : (Array.isArray(legacy.attachments) ? legacy.attachments : []))
          : [];
        const draft = {
          ownerUid: current.actorId,
          ownerId: current.actorId,
          tenantId: current.tenantId,
          resourceType: RESOURCE_TYPE,
          resourceId: current.draftId,
          draftRevision: 0,
          payload: adoptedPayload && typeof adoptedPayload === 'object' && !Array.isArray(adoptedPayload)
            ? adoptedPayload
            : payload,
          attachmentRefs: adoptedAttachments,
          stepIndex: adoptLegacy && Number.isInteger(legacy.stepIndex) && legacy.stepIndex >= 0
            ? legacy.stepIndex
            : stepIndex,
          status: 'ACTIVE',
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        assertDraftSize(draft);
        const lease = buildActiveEditLeaseDocument({
          tenantId: current.tenantId,
          resourceType: RESOURCE_TYPE,
          resourceId: current.draftId,
          actorId: current.actorId,
          actorDisplayName: current.actorDisplayName,
          sessionId: current.sessionId,
          leaseId: generatedLeaseId,
          serverNow: nowDate,
        });
        const body = {
          draft: draftContract(draft),
          lease: {
            serverNow: timestamp,
            state: 'ACTIVE',
            canEdit: true,
            expiresAt: lease.expiresAt,
            leaseId: lease.leaseId,
            fence: lease.fence,
          },
        };
        await auditChainService.appendManyInTransaction(tx, [
          draftAudit(current, actorRole, 'PROJECT_REGISTRATION_DRAFT_CREATE', 0, timestamp, {
            adoptedLegacy: Boolean(adoptLegacy),
          }),
          buildEditLeaseAuditEntry({
            ...current,
            resourceType: RESOURCE_TYPE,
            resourceId: current.draftId,
          }, actorRole, 'acquire', {
            state: 'ACTIVE',
            fence: lease.fence,
            resultCode: 'edit_lease_acquired',
            timestamp,
          }),
        ]);
        tx.create(targetDraftRef, draft);
        tx.create(targetLeaseRef, lease);
        if (adoptLegacy) {
          tx.set(legacyRef, {
            migrationStatus: 'ADOPTED',
            adoptedByDraftId: current.draftId,
            adoptedAt: timestamp,
            updatedAt: timestamp,
          }, { merge: true });
        }
        completeIdempotency(tx, current, lock, { method, path, status: 201, body }, nowDate);
        return { status: 201, body, replayed: false };
      });
    },

    async get(input) {
      const current = context(input, { sessionRequired: false, idempotencyRequired: false });
      return db.runTransaction(async (tx) => {
        const { draft } = await ownedDraft(tx, current);
        return { draft: draftContract(draft) };
      });
    },

    /** 내가 임시저장한 진행 중 등록 초안 목록. 이어서 작성할 초안을 고르는 용도라 요약만 준다. */
    async listMine(input) {
      const current = context(input, { draftRequired: false, sessionRequired: false, idempotencyRequired: false });
      const snapshot = await db.collection(`orgs/${current.tenantId}/projectRequestDrafts`)
        .where('ownerUid', '==', current.actorId)
        .limit(100)
        .get();
      const drafts = snapshot.docs
        .map((doc) => doc.data() || {})
        .filter((draft) => draft.status === 'ACTIVE' && readOptionalText(draft.resourceType) === RESOURCE_TYPE)
        .map((draft) => ({
          draftId: readOptionalText(draft.resourceId),
          alias: readOptionalText(draft.alias),
          name: readOptionalText(draft.payload?.name),
          updatedAt: readOptionalText(draft.updatedAt),
          stepIndex: Number.isInteger(draft.stepIndex) && draft.stepIndex >= 0 ? draft.stepIndex : 0,
        }))
        .filter((draft) => draft.draftId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return { drafts };
    },

    /** 임시저장 이름(별칭). 제출 payload 와 분리된 표시용 필드라 리비전을 올리지 않는다. */
    async setAlias(input) {
      const current = context(input, { idempotencyRequired: false });
      const leaseId = documentId(input?.leaseId, 'leaseId');
      const fence = positiveFence(input?.fence);
      const alias = String(input?.alias ?? '').trim().slice(0, 60);
      return db.runTransaction(async (tx) => {
        const nowDate = clockDate(now);
        const { ref, draft } = await ownedDraft(tx, current);
        assertActive(draft);
        await assertOwnedInTransaction({
          tx,
          leaseRef: leaseRef(current),
          tenantId: current.tenantId,
          resourceType: RESOURCE_TYPE,
          resourceId: current.draftId,
          actorId: current.actorId,
          sessionId: current.sessionId,
          leaseId,
          fence,
          serverNow: nowDate,
        });
        const next = { ...draft, alias, updatedAt: nowDate.toISOString() };
        tx.set(ref, next);
        return { status: 200, body: { draft: draftContract(next) }, replayed: false };
      });
    },

    /** 임시저장 소프트 삭제. 목록에서 사라지고 첨부는 outbox 로 정리한다. 제출본은 지울 수 없다. */
    async discard(input) {
      const current = context(input, { sessionRequired: false, idempotencyRequired: false });
      return db.runTransaction(async (tx) => {
        const nowDate = clockDate(now);
        const timestamp = nowDate.toISOString();
        const { ref, draft } = await ownedDraft(tx, current);
        if (readOptionalText(draft.status) === 'SUBMITTED') {
          throw createHttpError(409, '제출 완료된 임시저장은 삭제할 수 없습니다.', 'draft_already_submitted');
        }
        if (readOptionalText(draft.status) === 'DISCARDED') {
          return { status: 200, body: { draftId: current.draftId, status: 'DISCARDED' }, replayed: false, outboxId: null };
        }
        const next = { ...draft, status: 'DISCARDED', discardedAt: timestamp, updatedAt: timestamp };
        tx.set(ref, next);
        const cleanupEvent = attachmentCleanupEvent(
          createAttachmentCleanupOutboxEvent,
          current,
          attachmentRefs(draft).map((attachment) => attachment?.path),
          timestamp,
        );
        if (cleanupEvent) {
          tx.create(db.doc(`outbox/${documentId(cleanupEvent.id, 'outboxEvent.id')}`), cleanupEvent);
        }
        return {
          status: 200,
          body: { draftId: current.draftId, status: 'DISCARDED' },
          replayed: false,
          outboxId: cleanupEvent?.id || null,
        };
      });
    },

    async readAttachment(input) {
      if (!draftStorageService?.downloadDraftAttachment) {
        throw new Error('Draft attachment storage service is required');
      }
      const current = context(input, { sessionRequired: false, idempotencyRequired: false });
      const documentKind = requiredText(input?.documentKind, 'documentKind');
      if (!PROJECT_REGISTRATION_DOCUMENT_KINDS.includes(documentKind)) {
        throw createHttpError(400, 'documentKind is invalid', 'draft_attachment_invalid');
      }
      const attachment = await db.runTransaction(async (tx) => {
        const { draft } = await ownedDraft(tx, current);
        const match = attachmentRefs(draft).findLast((item) => item?.documentKind === documentKind);
        if (!match || !readOptionalText(match.path)) {
          throw createHttpError(404, 'Project registration draft attachment not found', 'not_found');
        }
        return match;
      });
      const downloaded = await draftStorageService.downloadDraftAttachment({
        tenantId: current.tenantId,
        draftId: current.draftId,
        path: attachment.path,
      });
      return { ...downloaded, name: readOptionalText(attachment.name) || 'attachment.pdf' };
    },

    async update(input) {
      const current = context(input);
      const leaseId = documentId(input?.leaseId, 'leaseId');
      const fence = positiveFence(input?.fence);
      const expectedDraftRevision = Number(input?.expectedDraftRevision);
      if (!Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 0) {
        throw createHttpError(400, 'expectedDraftRevision must be a non-negative integer', 'draft_request_invalid');
      }
      const payload = readDraftPayload(input);
      assertDraftSize({ payload });
      const method = 'PATCH';
      const path = `/api/v1/project-registration-drafts/${current.draftId}`;
      const requestFingerprint = buildRequestFingerprint({
        method,
        path,
        body: {
          actorId: current.actorId,
          sessionId: current.sessionId,
          leaseId,
          fence,
          expectedDraftRevision,
          payload,
          stepIndex: input?.stepIndex ?? null,
        },
      });

      return db.runTransaction(async (tx) => {
        const nowDate = clockDate(now);
        const timestamp = nowDate.toISOString();
        const { actorRole, ref, draft } = await ownedDraft(tx, current);
        const lock = await checkIdempotency(tx, current, requestFingerprint, nowDate);
        if (lock.mode === 'replay') return { status: lock.status, body: lock.body, replayed: true };
        const lockError = idempotencyError(lock);
        if (lockError) throw lockError;
        assertActive(draft);
        await assertOwnedInTransaction({
          tx,
          leaseRef: leaseRef(current),
          tenantId: current.tenantId,
          resourceType: RESOURCE_TYPE,
          resourceId: current.draftId,
          actorId: current.actorId,
          sessionId: current.sessionId,
          leaseId,
          fence,
          serverNow: nowDate,
        });
        const revision = assertRevision(draft, expectedDraftRevision) + 1;
        if (payload.registrationRequirementsVersion === 2) {
          const missingDocumentKind = missingProjectRegistrationRequiredDocumentKind(attachmentRefs(draft), payload);
          if (missingDocumentKind) {
            throw createHttpError(
              422,
              `Project registration required attachment is missing: ${missingDocumentKind}`,
              'project_registration_invalid',
            );
          }
        }
        const next = {
          ...draft,
          payload,
          stepIndex: Number.isInteger(input?.stepIndex) && input.stepIndex >= 0
            ? input.stepIndex
            : (Number.isInteger(draft.stepIndex) ? draft.stepIndex : 0),
          draftRevision: revision,
          updatedAt: timestamp,
        };
        assertDraftSize(next);
        const body = { draft: draftContract(next) };
        await auditChainService.appendManyInTransaction(tx, [
          draftAudit(current, actorRole, 'PROJECT_REGISTRATION_DRAFT_SAVE', revision, timestamp, { fence }),
        ]);
        tx.set(ref, next);
        completeIdempotency(tx, current, lock, { method, path, status: 200, body }, nowDate);
        return { status: 200, body, replayed: false };
      });
    },

    async submit(input) {
      const current = context(input);
      const leaseId = documentId(input?.leaseId, 'leaseId');
      const fence = positiveFence(input?.fence);
      const expectedDraftRevision = Number(input?.expectedDraftRevision);
      if (!Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 0) {
        throw createHttpError(400, 'expectedDraftRevision must be a non-negative integer', 'draft_request_invalid');
      }
      const identityDate = clockDate(now);
      const projectId = documentId(createProjectId(identityDate), 'projectId');
      const projectRequestId = documentId(createProjectRequestId(identityDate), 'projectRequestId');
      const method = 'POST';
      const path = `/api/v1/project-registration-drafts/${current.draftId}/submit`;
      const requestFingerprint = buildRequestFingerprint({
        method,
        path,
        body: {
          actorId: current.actorId,
          sessionId: current.sessionId,
          leaseId,
          fence,
          expectedDraftRevision,
        },
      });
      const outboxTemplate = createRegistrationOutboxEvent({
        tenantId: current.tenantId,
        requestId: current.requestId,
        eventType: 'project.registration.submitted',
        entityType: 'project',
        entityId: projectId,
        payload: {
          projectId,
          projectRequestId,
          draftId: current.draftId,
          actorId: current.actorId,
          attachmentRefs: [],
        },
        createdAt: identityDate.toISOString(),
      });
      const projectRef = db.doc(`orgs/${current.tenantId}/projects/${projectId}`);
      const projectRequestRef = db.doc(`orgs/${current.tenantId}/project_requests/${projectRequestId}`);
      const outboxRef = db.doc(`outbox/${documentId(outboxTemplate?.id, 'outboxEvent.id')}`);

      try {
        return await runFinalSubmitTransaction(async (tx) => {
        const submissionDate = clockDate(now);
        const timestamp = submissionDate.toISOString();
        const { actorRole, member, ref, draft } = await ownedDraft(tx, current);
        const lock = await checkIdempotency(tx, current, requestFingerprint, submissionDate);
        if (lock.mode === 'replay') return { status: lock.status, body: lock.body, replayed: true };
        const lockError = idempotencyError(lock);
        if (lockError) throw lockError;

        assertRevision(draft, expectedDraftRevision);
        assertActive(draft);
        const lease = await assertOwnedInTransaction({
          tx,
          leaseRef: leaseRef(current),
          tenantId: current.tenantId,
          resourceType: RESOURCE_TYPE,
          resourceId: current.draftId,
          actorId: current.actorId,
          sessionId: current.sessionId,
          leaseId,
          fence,
          serverNow: submissionDate,
        });
        const attachments = relocationAttachmentRefs(draft, current);
        const outboxEvent = {
          ...outboxTemplate,
          payload: {
            ...(outboxTemplate.payload || {}),
            attachmentRefs: attachments,
          },
          createdAt: timestamp,
          nextAttemptAt: timestamp,
          updatedAt: timestamp,
        };
        const canonical = buildProjectRegistrationCanonicalDocuments({
          tenantId: current.tenantId,
          projectId,
          projectRequestId,
          sourceDraftId: current.draftId,
          payload: draft.payload,
          attachmentRefs: [],
          requirementsAttachmentRefs: attachments,
          actorId: current.actorId,
          actorName: current.actorDisplayName,
          actorEmail: current.actorEmail,
          timestamp,
        });
        await assertActiveRegistrationMembersInTransaction({
          tx,
          db,
          tenantId: current.tenantId,
          payload: draft.payload,
          actorId: current.actorId,
        });
        const [projectSnap, projectRequestSnap] = await Promise.all([
          tx.get(projectRef),
          tx.get(projectRequestRef),
        ]);
        if (projectSnap.exists || projectRequestSnap.exists) {
          throw createHttpError(409, 'Generated project registration ID already exists', 'canonical_id_conflict');
        }

        const nextRevision = expectedDraftRevision + 1;
        const submittedDraft = {
          ownerUid: current.actorId,
          ownerId: current.actorId,
          tenantId: current.tenantId,
          resourceType: RESOURCE_TYPE,
          resourceId: current.draftId,
          draftRevision: nextRevision,
          status: 'SUBMITTED',
          createdAt: draft.createdAt || timestamp,
          updatedAt: timestamp,
          submittedAt: timestamp,
          submittedProjectId: projectId,
          submittedProjectRequestId: projectRequestId,
          submittedOutboxId: outboxEvent.id,
        };
        const releasedLease = {
          ...lease,
          state: 'RELEASED',
          releasedAt: timestamp,
          releaseReason: 'FINAL_SUBMIT',
          updatedAt: timestamp,
        };
        const body = {
          status: 'SUBMITTED',
          projectId,
          projectRequestId,
          projectVersion: canonical.project.version,
          draftId: current.draftId,
          draftRevision: nextRevision,
          submittedAt: timestamp,
          lease: { state: 'RELEASED', canEdit: false },
          outbox: { id: outboxEvent.id, status: outboxEvent.status || 'PENDING' },
        };
        await auditChainService.appendManyInTransaction(tx, [
          draftAudit(current, actorRole, 'PROJECT_REGISTRATION_SUBMIT', nextRevision, timestamp, {
            fence,
            projectId,
            projectRequestId,
            outboxId: outboxEvent.id,
          }),
          buildEditLeaseAuditEntry({
            ...current,
            resourceType: RESOURCE_TYPE,
            resourceId: current.draftId,
          }, actorRole, 'release', {
            state: 'RELEASED',
            fence,
            resultCode: 'edit_lease_released_on_submit',
            timestamp,
          }),
        ]);
        tx.create(projectRef, canonical.project);
        tx.create(projectRequestRef, canonical.projectRequest);
        tx.set(db.doc(`orgs/${current.tenantId}/members/${current.actorId}`), buildActorMemberAssignment(
          member,
          current,
          canonical.project,
          timestamp,
        ), { merge: true });
        tx.set(ref, submittedDraft);
        tx.set(leaseRef(current), releasedLease);
        tx.create(outboxRef, outboxEvent);
        completeIdempotency(tx, current, lock, {
          method,
          path,
          status: 201,
          body,
          ttlSeconds: 86_400,
        }, submissionDate);
        return { status: 201, body, replayed: false };
        });
      } catch (error) {
        if (isFirestoreTransactionConflict(error) || isInvalidOrClosedTransactionError(error)) {
          throw createHttpError(409, 'Another final submission won the project registration race.', 'canonical_submit_conflict');
        }
        throw error;
      }
    },

    async addAttachment(input) {
      if (!draftStorageService?.uploadDraftAttachment || !draftStorageService?.deleteDraftAttachment) {
        throw new Error('Draft attachment storage service is required');
      }
      const current = context(input);
      const leaseId = documentId(input?.leaseId, 'leaseId');
      const fence = positiveFence(input?.fence);
      const expectedDraftRevision = Number(input?.expectedDraftRevision);
      if (!Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 0) {
        throw createHttpError(400, 'expectedDraftRevision must be a non-negative integer', 'draft_request_invalid');
      }
      let buffer = Buffer.isBuffer(input?.buffer)
        ? input.buffer
        : (input?.buffer instanceof Uint8Array ? Buffer.from(input.buffer) : null);
      // 큰 파일은 서명 URL 로 스토리지에 직접 올라온다(Vercel 본문 4.5MB 우회). 여기서는
      // 그 경로를 읽어 같은 검증·저장 경로를 태운다 - 전송 수단만 다르고 계약은 같다.
      const incomingPath = !buffer && input?.storagePath ? String(input.storagePath) : null;
      if (incomingPath) {
        if (!draftStorageService?.readIncomingUpload) {
          throw createHttpError(503, '대용량 첨부 업로드가 아직 켜져 있지 않습니다.', 'draft_attachment_direct_unavailable');
        }
        try {
          ({ buffer } = await draftStorageService.readIncomingUpload({
            tenantId: current.tenantId, draftId: current.draftId, path: incomingPath,
          }));
        } catch {
          throw createHttpError(422, '업로드된 파일을 찾지 못했습니다. 다시 업로드해 주세요.', 'draft_attachment_incoming_missing');
        }
      }
      if (!buffer || buffer.byteLength < 1) {
        throw createHttpError(400, 'Attachment content is required', 'draft_attachment_invalid');
      }
      if (Number(input?.fileSize) !== buffer.byteLength) {
        throw createHttpError(422, 'Attachment size does not match its content', 'draft_attachment_size_mismatch');
      }
      const fileName = requiredText(input?.fileName, 'fileName');
      const mimeType = requiredText(input?.mimeType, 'mimeType');
      const documentKind = requiredText(input?.documentKind, 'documentKind');
      if (!PROJECT_REGISTRATION_DOCUMENT_KINDS.includes(documentKind)) {
        throw createHttpError(400, 'documentKind is invalid', 'draft_attachment_invalid');
      }
      const replacedDocumentKinds = replacementDocumentKinds(documentKind);
      assertProjectAttachment(buffer, mimeType, fileName, documentKind);
      const attachmentId = documentId(createAttachmentId(), 'attachmentId');
      const method = 'POST';
      const path = `/api/v1/project-registration-drafts/${current.draftId}/attachments`;
      const requestFingerprint = buildRequestFingerprint({
        method,
        path,
        body: {
          actorId: current.actorId,
          sessionId: current.sessionId,
          leaseId,
          fence,
          expectedDraftRevision,
          documentKind,
          fileName,
          mimeType,
          fileSize: buffer.byteLength,
          contentHash: sha256(buffer),
        },
      });

      const preflight = await db.runTransaction(async (tx) => {
        const nowDate = clockDate(now);
        const { draft } = await ownedDraft(tx, current);
        const lock = await checkIdempotency(tx, current, requestFingerprint, nowDate);
        if (lock.mode === 'replay') return { outcome: { status: lock.status, body: lock.body, replayed: true } };
        const lockError = idempotencyError(lock);
        if (lockError) throw lockError;
        assertActive(draft);
        await assertOwnedInTransaction({
          tx,
          leaseRef: leaseRef(current),
          tenantId: current.tenantId,
          resourceType: RESOURCE_TYPE,
          resourceId: current.draftId,
          actorId: current.actorId,
          sessionId: current.sessionId,
          leaseId,
          fence,
          serverNow: nowDate,
        });
        assertRevision(draft, expectedDraftRevision);
        if (
          attachmentRefs(draft).length >= MAX_ATTACHMENT_REFS
          && !attachmentRefs(draft).some((attachment) => replacedDocumentKinds.includes(attachment?.documentKind))
        ) {
          throw createHttpError(422, 'Draft attachment limit exceeded', 'draft_attachment_limit_exceeded');
        }
        return { outcome: null };
      });
      if (preflight.outcome) return preflight.outcome;

      let uploaded;
      const cleanup = async () => {
        if (!uploaded?.path) return;
        try {
          await draftStorageService.deleteDraftAttachment({
            tenantId: current.tenantId,
            draftId: current.draftId,
            path: uploaded.path,
          });
        } catch {
          // eslint-disable-next-line no-console
          console.warn('[bff] draft attachment cleanup failed', {
            requestId: current.requestId,
            errorCode: 'draft_attachment_cleanup_failed',
          });
        }
      };

      try {
        uploaded = await draftStorageService.uploadDraftAttachment({
          tenantId: current.tenantId,
          draftId: current.draftId,
          attachmentId,
          fileName,
          mimeType,
          fileSize: buffer.byteLength,
          buffer,
          actorId: current.actorId,
        });
        const storagePath = readOptionalText(uploaded?.path);
        const expectedPrefix = `orgs/${current.tenantId}/project-registration-drafts/${current.draftId}/`;
        if (!storagePath.startsWith(expectedPrefix)) {
          throw new Error('Draft storage returned a path outside the private draft prefix');
        }
        const attachment = {
          attachmentId,
          documentKind,
          path: storagePath,
          name: fileName,
          size: buffer.byteLength,
          contentType: mimeType,
          uploadedAt: readOptionalText(uploaded?.uploadedAt) || clockDate(now).toISOString(),
        };

        let replacedAttachments = [];
        const outcome = await db.runTransaction(async (tx) => {
          const nowDate = clockDate(now);
          const timestamp = nowDate.toISOString();
          const { actorRole, ref, draft } = await ownedDraft(tx, current);
          const lock = await checkIdempotency(tx, current, requestFingerprint, nowDate);
          if (lock.mode === 'replay') return { status: lock.status, body: lock.body, replayed: true };
          const lockError = idempotencyError(lock);
          if (lockError) throw lockError;
          assertActive(draft);
          await assertOwnedInTransaction({
            tx,
            leaseRef: leaseRef(current),
            tenantId: current.tenantId,
            resourceType: RESOURCE_TYPE,
            resourceId: current.draftId,
            actorId: current.actorId,
            sessionId: current.sessionId,
            leaseId,
            fence,
            serverNow: nowDate,
          });
          const revision = assertRevision(draft, expectedDraftRevision) + 1;
          replacedAttachments = attachmentRefs(draft)
            .filter((currentAttachment) => replacedDocumentKinds.includes(currentAttachment?.documentKind));
          const next = {
            ...draft,
            payload: payloadWithoutAttachment(draft.payload, documentKind, replacedAttachments),
            attachmentRefs: [
              ...attachmentRefs(draft).filter(
                (currentAttachment) => !replacedDocumentKinds.includes(currentAttachment?.documentKind),
              ),
              attachment,
            ],
            draftRevision: revision,
            updatedAt: timestamp,
          };
          assertDraftSize(next);
          const body = { draft: draftContract(next), attachment };
          await auditChainService.appendManyInTransaction(tx, [
            draftAudit(current, actorRole, 'PROJECT_REGISTRATION_DRAFT_ATTACHMENT_ADD', revision, timestamp, {
              fence,
              attachmentId,
            }),
          ]);
          tx.set(ref, next);
          completeIdempotency(tx, current, lock, { method, path, status: 200, body }, nowDate);
          const cleanupEvent = attachmentCleanupEvent(
            createAttachmentCleanupOutboxEvent,
            current,
            replacedAttachments
              .filter((replaced) => readOptionalText(replaced?.path) && replaced.path !== attachment.path)
              .map((replaced) => replaced.path),
            timestamp,
          );
          if (cleanupEvent) {
            tx.create(db.doc(`outbox/${documentId(cleanupEvent.id, 'outboxEvent.id')}`), cleanupEvent);
          }
          return { status: 200, body, replayed: false };
        });
        if (outcome.replayed) await cleanup();
        else {
          await Promise.all(replacedAttachments.map(async (replaced) => {
            if (!readOptionalText(replaced?.path) || replaced.path === attachment.path) return;
            try {
              await draftStorageService.deleteDraftAttachment({
                tenantId: current.tenantId,
                draftId: current.draftId,
                path: replaced.path,
              });
            } catch {
              // eslint-disable-next-line no-console
              console.warn('[bff] replaced draft attachment cleanup failed', {
                requestId: current.requestId,
                errorCode: 'draft_attachment_replacement_cleanup_failed',
              });
            }
          }));
        }
        if (incomingPath) {
          await draftStorageService.deleteIncomingUpload?.({
            tenantId: current.tenantId, draftId: current.draftId, path: incomingPath,
          }).catch(() => {});
        }
        return outcome;
      } catch (error) {
        await cleanup();
        throw error;
      }
    },

    /** 서명 URL 발급. 소유권(리스)·역할·이름/종류를 먼저 확인하고 10분짜리 PUT URL 을 준다. */
    async issueAttachmentUploadUrl(input) {
      if (!draftStorageService?.createIncomingUploadUrl) {
        throw createHttpError(503, '대용량 첨부 업로드가 아직 켜져 있지 않습니다.', 'draft_attachment_direct_unavailable');
      }
      const current = context(input);
      const leaseId = documentId(input?.leaseId, 'leaseId');
      const fence = positiveFence(input?.fence);
      const documentKind = requiredText(input?.documentKind, 'documentKind');
      if (!PROJECT_REGISTRATION_DOCUMENT_KINDS.includes(documentKind)) {
        throw createHttpError(400, 'documentKind is invalid', 'draft_attachment_invalid');
      }
      const fileName = requiredText(input?.fileName, 'fileName');
      const mimeType = requiredText(input?.mimeType, 'mimeType');
      await db.runTransaction(async (tx) => {
        const nowDate = clockDate(now);
        const { draft } = await ownedDraft(tx, current);
        assertActive(draft);
        await assertOwnedInTransaction({
          tx,
          leaseRef: leaseRef(current),
          tenantId: current.tenantId,
          resourceType: RESOURCE_TYPE,
          resourceId: current.draftId,
          actorId: current.actorId,
          sessionId: current.sessionId,
          leaseId,
          fence,
          serverNow: nowDate,
        });
      });
      const session = await draftStorageService.createIncomingUploadUrl({
        tenantId: current.tenantId, draftId: current.draftId, fileName, mimeType,
      });
      return { status: 200, body: { uploadUrl: session.uploadUrl, storagePath: session.path, expiresAt: session.expiresAt } };
    },

    async removeAttachment(input) {
      if (!draftStorageService?.deleteDraftAttachment) {
        throw new Error('Draft attachment storage service is required');
      }
      const current = context(input);
      const leaseId = documentId(input?.leaseId, 'leaseId');
      const fence = positiveFence(input?.fence);
      const expectedDraftRevision = Number(input?.expectedDraftRevision);
      if (!Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 0) {
        throw createHttpError(400, 'expectedDraftRevision must be a non-negative integer', 'draft_request_invalid');
      }
      const documentKind = requiredText(input?.documentKind, 'documentKind');
      if (!PROJECT_REGISTRATION_DOCUMENT_KINDS.includes(documentKind)) {
        throw createHttpError(400, 'documentKind is invalid', 'draft_attachment_invalid');
      }
      const method = 'DELETE';
      const path = `/api/v1/project-registration-drafts/${current.draftId}/attachments/${documentKind}`;
      const requestFingerprint = buildRequestFingerprint({
        method,
        path,
        body: {
          actorId: current.actorId,
          sessionId: current.sessionId,
          leaseId,
          fence,
          expectedDraftRevision,
          documentKind,
        },
      });

      const result = await db.runTransaction(async (tx) => {
        const nowDate = clockDate(now);
        const timestamp = nowDate.toISOString();
        const { actorRole, ref, draft } = await ownedDraft(tx, current);
        const lock = await checkIdempotency(tx, current, requestFingerprint, nowDate);
        if (lock.mode === 'replay') {
          return { outcome: { status: lock.status, body: lock.body, replayed: true }, removedAttachments: [] };
        }
        const lockError = idempotencyError(lock);
        if (lockError) throw lockError;
        assertActive(draft);
        await assertOwnedInTransaction({
          tx,
          leaseRef: leaseRef(current),
          tenantId: current.tenantId,
          resourceType: RESOURCE_TYPE,
          resourceId: current.draftId,
          actorId: current.actorId,
          sessionId: current.sessionId,
          leaseId,
          fence,
          serverNow: nowDate,
        });
        const revision = assertRevision(draft, expectedDraftRevision) + 1;
        const removedAttachments = attachmentRefs(draft)
          .filter((attachment) => attachment?.documentKind === documentKind && readOptionalText(attachment?.path));
        if (removedAttachments.length === 0) {
          throw createHttpError(404, 'Project registration draft attachment not found', 'not_found');
        }
        const next = {
          ...draft,
          payload: payloadWithoutAttachment(draft.payload, documentKind, removedAttachments),
          attachmentRefs: attachmentRefs(draft).filter((attachment) => attachment?.documentKind !== documentKind),
          draftRevision: revision,
          updatedAt: timestamp,
        };
        assertDraftSize(next);
        const body = { draft: draftContract(next) };
        await auditChainService.appendManyInTransaction(tx, [
          draftAudit(current, actorRole, 'PROJECT_REGISTRATION_DRAFT_ATTACHMENT_REMOVE', revision, timestamp, {
            fence,
            documentKind,
            attachmentIds: removedAttachments.map((attachment) => readOptionalText(attachment?.attachmentId)).filter(Boolean),
          }),
        ]);
        tx.set(ref, next);
        completeIdempotency(tx, current, lock, { method, path, status: 200, body }, nowDate);
        const cleanupEvent = attachmentCleanupEvent(
          createAttachmentCleanupOutboxEvent,
          current,
          removedAttachments.map((attachment) => attachment.path),
          timestamp,
        );
        if (cleanupEvent) {
          tx.create(db.doc(`outbox/${documentId(cleanupEvent.id, 'outboxEvent.id')}`), cleanupEvent);
        }
        return { outcome: { status: 200, body, replayed: false }, removedAttachments };
      });

      await Promise.all(result.removedAttachments.map(async (attachment) => {
        try {
          await draftStorageService.deleteDraftAttachment({
            tenantId: current.tenantId,
            draftId: current.draftId,
            path: attachment.path,
          });
        } catch {
          console.warn('[bff] removed draft attachment cleanup failed', {
            requestId: current.requestId,
            errorCode: 'draft_attachment_remove_cleanup_failed',
          });
        }
      }));
      return result.outcome;
    },
  };
}

function requireHeader(req, name) {
  return requiredText(req.header(name), name);
}

function routeDraftId(req) {
  return documentId(req.params?.draftId, 'draftId');
}

function routeSession(req) {
  return documentId(requireHeader(req, 'x-edit-session-id'), 'sessionId');
}

function routeOwnership(req) {
  return {
    sessionId: routeSession(req),
    leaseId: documentId(requireHeader(req, 'x-edit-lease-id'), 'leaseId'),
    fence: positiveFence(requireHeader(req, 'x-edit-fence')),
  };
}

async function routeContext(req, piiProtector) {
  const actorEmailEnc = piiProtector
    ? await encryptAuditEmail(piiProtector, req.context?.actorEmail)
    : undefined;
  return {
    tenantId: req.context?.tenantId,
    actorId: req.context?.actorId,
    actorRole: req.context?.actorRole,
    actorDisplayName: req.context?.actorName,
    actorEmail: req.context?.actorEmail,
    actorEmailEnc,
    requestId: req.context?.requestId,
    idempotencyKey: req.context?.idempotencyKey,
  };
}

function sendOutcome(res, outcome) {
  if (outcome.replayed) res.setHeader('x-idempotency-replayed', '1');
  res.status(outcome.status).json(outcome.body);
}

function sendPrivateDraftAttachment(res, attachment) {
  const buffer = Buffer.isBuffer(attachment?.buffer)
    ? attachment.buffer
    : Buffer.from(attachment?.buffer || []);
  const contentType = readOptionalText(attachment?.contentType);
  res.setHeader('content-type', /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(contentType)
    ? contentType
    : 'application/octet-stream');
  res.setHeader('content-length', String(buffer.byteLength));
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(readOptionalText(attachment?.name) || 'attachment.pdf')}`);
  res.status(200).send(buffer);
}

function decodeBase64(value, expectedSize) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw createHttpError(400, 'contentBase64 is invalid', 'draft_attachment_invalid');
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.byteLength !== expectedSize) {
    throw createHttpError(422, 'Attachment size does not match its content', 'draft_attachment_size_mismatch');
  }
  return buffer;
}

export function mountProjectRegistrationDraftRoutes(app, {
  enabled = false,
  projectRegistrationDraftService,
  piiProtector,
  processOutboxEventInline,
} = {}) {
  if (!enabled) return;
  if (!projectRegistrationDraftService) throw new Error('Project registration draft routes require a service');

  app.post('/api/v1/project-registration-drafts', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'create a project registration draft');
    const parsed = parseWithSchema(projectRegistrationDraftCreateSchema, req.body);
    const current = await routeContext(req, piiProtector);
    sendOutcome(res, await projectRegistrationDraftService.create({
      ...current,
      sessionId: routeSession(req),
      ...parsed,
    }));
  }));

  app.get('/api/v1/project-registration-drafts', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'list project registration drafts');
    const current = await routeContext(req, piiProtector);
    res.status(200).json(await projectRegistrationDraftService.listMine(current));
  }));

  app.patch('/api/v1/project-registration-drafts/:draftId/alias', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'rename a project registration draft');
    const parsed = parseWithSchema(projectRegistrationDraftAliasSchema, req.body);
    sendOutcome(res, await projectRegistrationDraftService.setAlias({
      ...await routeContext(req, piiProtector),
      ...routeOwnership(req),
      draftId: routeDraftId(req),
      ...parsed,
    }));
  }));

  app.delete('/api/v1/project-registration-drafts/:draftId', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'discard a project registration draft');
    const outcome = await projectRegistrationDraftService.discard({
      ...await routeContext(req, piiProtector),
      draftId: routeDraftId(req),
    });
    // 첨부 정리도 같은 요청에서 처리한다. 실패해도 크론이 안전망.
    if (outcome.outboxId && processOutboxEventInline) {
      await processOutboxEventInline(outcome.outboxId).catch(() => {});
    }
    sendOutcome(res, outcome);
  }));

  app.get('/api/v1/project-registration-drafts/:draftId', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'read a project registration draft');
    const current = await routeContext(req, piiProtector);
    res.status(200).json(await projectRegistrationDraftService.get({
      ...current,
      draftId: routeDraftId(req),
    }));
  }));

  app.get('/api/v1/project-registration-drafts/:draftId/attachments/:documentKind', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'read a project registration draft attachment');
    const current = await routeContext(req, piiProtector);
    sendPrivateDraftAttachment(res, await projectRegistrationDraftService.readAttachment({
      ...current,
      draftId: routeDraftId(req),
      documentKind: requiredText(req.params?.documentKind, 'documentKind'),
    }));
  }));

  app.patch('/api/v1/project-registration-drafts/:draftId', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'save a project registration draft');
    const parsed = parseWithSchema(projectRegistrationDraftPatchSchema, req.body);
    const current = await routeContext(req, piiProtector);
    sendOutcome(res, await projectRegistrationDraftService.update({
      ...current,
      ...routeOwnership(req),
      draftId: routeDraftId(req),
      ...parsed,
    }));
  }));

  app.post('/api/v1/project-registration-drafts/:draftId/attachments', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'attach a project registration draft file');
    const parsed = parseWithSchema(projectRegistrationDraftAttachmentSchema, req.body);
    const current = await routeContext(req, piiProtector);
    sendOutcome(res, await projectRegistrationDraftService.addAttachment({
      ...current,
      ...routeOwnership(req),
      draftId: routeDraftId(req),
      ...parsed,
      buffer: parsed.contentBase64 ? decodeBase64(parsed.contentBase64, parsed.fileSize) : undefined,
    }));
  }));

  app.post('/api/v1/project-registration-drafts/:draftId/attachments/upload-url', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'request a project registration draft upload URL');
    const parsed = parseWithSchema(projectRegistrationDraftAttachmentUploadUrlSchema, req.body);
    sendOutcome(res, await projectRegistrationDraftService.issueAttachmentUploadUrl({
      ...await routeContext(req, piiProtector),
      ...routeOwnership(req),
      draftId: routeDraftId(req),
      ...parsed,
    }));
  }));

  app.delete('/api/v1/project-registration-drafts/:draftId/attachments/:documentKind', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'remove a project registration draft file');
    const parsed = parseWithSchema(projectDraftAttachmentDeleteSchema, req.body);
    const current = await routeContext(req, piiProtector);
    sendOutcome(res, await projectRegistrationDraftService.removeAttachment({
      ...current,
      ...routeOwnership(req),
      draftId: routeDraftId(req),
      documentKind: requiredText(req.params?.documentKind, 'documentKind'),
      ...parsed,
    }));
  }));

  app.post('/api/v1/project-registration-drafts/:draftId/submit', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'submit a project registration draft');
    const parsed = parseWithSchema(projectRegistrationDraftSubmitSchema, req.body);
    const current = await routeContext(req, piiProtector);
    const outcome = await projectRegistrationDraftService.submit({
      ...current,
      ...routeOwnership(req),
      draftId: routeDraftId(req),
      ...parsed,
    });
    // 첨부 공개 이관을 같은 요청 안에서 처리한다. 실패해도 크론이 안전망이라 응답은 성공 그대로.
    const outboxId = !outcome.replayed ? outcome.body?.outbox?.id : null;
    if (outboxId && processOutboxEventInline) {
      await processOutboxEventInline(outboxId).catch((error) => {
        console.warn('[bff] inline registration submit outbox processing failed', {
          outboxId, errorCode: 'submit_outbox_inline_failed', message: error?.message,
        });
      });
    }
    sendOutcome(res, outcome);
  }));
}
