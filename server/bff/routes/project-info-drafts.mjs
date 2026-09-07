import { randomUUID } from 'node:crypto';
import {
  PROJECT_REQUEST_ROUTE_ROLES,
  assertActorRoleAllowed,
  asyncHandler,
  createHttpError,
  encryptAuditEmail,
  readOptionalText,
  stripUndefinedDeep,
} from '../bff-utils.mjs';
import {
  assertEditLeaseActorAccessInTransaction,
  assertOwnedInTransaction,
  buildEditLeaseAuditEntry,
  resolveEditLeaseDocumentId,
} from '../edit-lease.mjs';
import {
  parseWithSchema,
  projectDraftAttachmentDeleteSchema,
  projectInfoDraftAttachmentSchema,
  projectInfoDraftAttachmentUploadUrlSchema,
  projectInfoDraftOpenSchema,
  projectInfoDraftPatchSchema,
  projectInfoDraftRebaseSchema,
  projectInfoDraftSubmitSchema,
} from '../schemas.mjs';
import { buildRequestFingerprint, sha256 } from '../utils.mjs';
import {
  DRAFT_ATTACHMENT_CLEANUP_EVENT_TYPE,
  createOutboxEvent as createOutboxEventRecord,
} from '../outbox.mjs';
import {
  buildProjectInfoChangeSubmission,
  buildProjectInfoDraftSeed,
} from './projects.mjs';
import {
  PROJECT_INFO_DOCUMENT_KINDS,
  projectDocumentValidationError,
} from '../project-document-validation.mjs';

const RESOURCE_TYPE = 'project-info';
// Every member works across all projects; see CROSS_PROJECT_ROLES in src/app/platform/rbac.ts.
const CROSS_PROJECT_ROLES = new Set(['admin', 'finance', 'pm', 'viewer']);
const DOCUMENT_KINDS = PROJECT_INFO_DOCUMENT_KINDS;
const DOCUMENT_FIELD_BY_KIND = {
  contract: 'contractDocument',
  customer_business_registration: 'customerBusinessRegistrationDocument',
  quote: 'quoteDocument',
  proposal: 'proposalDocument',
  proposal_word_original: 'proposalWordOriginalDocument',
  proposal_ppt_original: 'proposalPptOriginalDocument',
  presentation_ppt_original: 'presentationPptOriginalDocument',
  rfp_request_evidence: 'rfpRequestEvidenceDocument',
  performance_certificate: 'performanceCertificateDocument',
  tax_invoice: 'taxInvoiceDocument',
  final_settlement_report: 'finalSettlementReportDocument',
  final_report: 'finalReportDocument',
};
const MAX_DRAFT_BYTES = 900 * 1024;
const MAX_ATTACHMENT_REFS = 100;
const MAX_PAYLOAD_DEPTH = 20;

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
  if (
    normalized.includes('/')
    || normalized === '.'
    || normalized === '..'
    || Buffer.byteLength(normalized, 'utf8') > 512
  ) {
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

function clockDate(now) {
  const date = new Date(now());
  if (!Number.isFinite(date.getTime())) throw new Error('Project information draft clock returned an invalid time');
  return date;
}

function draftDocumentId(projectId, actorId) {
  const id = `v1_${Buffer.from(JSON.stringify([RESOURCE_TYPE, projectId, actorId]), 'utf8').toString('base64url')}`;
  if (Buffer.byteLength(id, 'utf8') > 1_500) {
    throw createHttpError(400, 'Project information draft ID is too long', 'draft_request_invalid');
  }
  return id;
}

function draftIdFromTrustedAttachmentPath(tenantId, path) {
  const normalizedPath = readOptionalText(path);
  const prefix = `orgs/${tenantId}/project-registration-drafts/`;
  const relative = normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : '';
  const [draftId, objectName, ...extra] = relative.split('/');
  if (
    extra.length
    || !draftId
    || !objectName
    || draftId === '.'
    || draftId === '..'
    || !/^[A-Za-z0-9._-]+$/.test(draftId)
  ) return '';
  return draftId;
}

function memberProjectIds(member = {}) {
  const profile = member.portalProfile && typeof member.portalProfile === 'object'
    ? member.portalProfile
    : {};
  return new Set([
    member.projectId,
    ...(Array.isArray(member.projectIds) ? member.projectIds : []),
    profile.projectId,
    ...(Array.isArray(profile.projectIds) ? profile.projectIds : []),
  ].map(readOptionalText).filter(Boolean));
}

function projectOwnerIds(project = {}) {
  return new Set([project.registeredById, project.managerId].map(readOptionalText).filter(Boolean));
}

function draftAttachments(draft = {}) {
  return Array.isArray(draft.attachmentRefs) ? draft.attachmentRefs : [];
}

function publicAttachmentRefs(draft = {}) {
  return draftAttachments(draft).map((attachment) => Object.fromEntries(
    Object.entries(attachment || {}).filter(([key]) => key !== 'inheritedFromProjectRequest'),
  ));
}

function resumableDraftAttachments(tenantId, projectId, draftId, request = {}) {
  if (
    readOptionalText(request.requestKind) !== 'CHANGE'
    || !['PENDING', 'REJECTED'].includes(readOptionalText(request.status))
  ) return [];
  const source = request.proposedSnapshot && typeof request.proposedSnapshot === 'object'
    ? request.proposedSnapshot
    : request.payload;
  const before = request.beforeSnapshot && typeof request.beforeSnapshot === 'object'
    ? request.beforeSnapshot
    : {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
  return Object.entries(DOCUMENT_FIELD_BY_KIND).flatMap(([documentKind, field]) => {
    const document = source[field];
    const path = readOptionalText(document?.path);
    const permanentPrefix = `orgs/${tenantId}/project-registration-documents/${projectId}/`;
    const changedPermanentDocument = path.startsWith(permanentPrefix)
      && path !== readOptionalText(before?.[field]?.path);
    if (
      !path
      || (
        draftIdFromTrustedAttachmentPath(tenantId, path) !== draftId
        && !changedPermanentDocument
      )
    ) return [];
    const attachmentId = readOptionalText(document?.attachmentId);
    return [{
      ...(attachmentId ? { attachmentId } : {}),
      documentKind,
      path,
      name: readOptionalText(document?.name),
      size: Number.isSafeInteger(document?.size) && document.size >= 0 ? document.size : 0,
      contentType: readOptionalText(document?.contentType) || 'application/octet-stream',
      ...(readOptionalText(document?.uploadedAt) ? { uploadedAt: readOptionalText(document.uploadedAt) } : {}),
      inheritedFromProjectRequest: true,
    }];
  });
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

function draftContract(draft = {}) {
  return {
    projectId: readOptionalText(draft.resourceId),
    resourceType: RESOURCE_TYPE,
    resourceId: readOptionalText(draft.resourceId),
    draftRevision: Number.isInteger(draft.draftRevision) ? draft.draftRevision : 0,
    baseCanonicalVersion: Number.isInteger(draft.baseCanonicalVersion) ? draft.baseCanonicalVersion : 1,
    payload: draft.payload && typeof draft.payload === 'object' && !Array.isArray(draft.payload)
      ? draft.payload
      : {},
    attachmentRefs: publicAttachmentRefs(draft),
    stepIndex: Number.isInteger(draft.stepIndex) && draft.stepIndex >= 0 ? draft.stepIndex : 0,
    status: readOptionalText(draft.status) || 'ACTIVE',
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    ...(draft.submittedAt ? { submittedAt: draft.submittedAt } : {}),
  };
}

function invalidPayload() {
  throw createHttpError(422, 'Draft payload contains unsupported JSON data', 'draft_payload_invalid');
}

function assertPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalidPayload();
  const ancestors = new WeakSet();
  const stack = [{ value: payload, depth: 0, parentArray: false, exit: false }];
  while (stack.length) {
    const frame = stack.pop();
    if (frame.exit) {
      ancestors.delete(frame.value);
      continue;
    }
    const { value, depth, parentArray } = frame;
    if (depth > MAX_PAYLOAD_DEPTH) invalidPayload();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) invalidPayload();
      continue;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) invalidPayload();
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (parentArray) invalidPayload();
      ancestors.add(value);
      stack.push({ ...frame, exit: true });
      for (let index = value.length - 1; index >= 0; index -= 1) {
        if (!Object.hasOwn(value, index)) invalidPayload();
        stack.push({ value: value[index], depth: depth + 1, parentArray: true, exit: false });
      }
      continue;
    }
    if (prototype !== Object.prototype && prototype !== null) invalidPayload();
    ancestors.add(value);
    stack.push({ ...frame, exit: true });
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || key === '__proto__' || Buffer.byteLength(key, 'utf8') > 1_500) invalidPayload();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidPayload();
      stack.push({ value: descriptor.value, depth: depth + 1, parentArray: false, exit: false });
    }
  }
}

function assertDraftSize(value) {
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    invalidPayload();
  }
  if (bytes > MAX_DRAFT_BYTES) {
    throw createHttpError(413, 'Draft payload is too large', 'draft_payload_too_large');
  }
}

function assertActive(draft) {
  if (draft.status !== 'ACTIVE') {
    throw createHttpError(409, 'Project information draft is not active', 'draft_not_active');
  }
}

// Firestore returns map keys in its own order, so a draft read back from storage
// and a freshly computed snapshot can hold identical values in a different key
// order. Compare by value, not by serialization order.
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((sorted, key) => {
      // An optional field the other side simply omits is not a change the owner made.
      if (value[key] === undefined || value[key] === null || value[key] === '') return sorted;
      sorted[key] = stableValue(value[key]);
      return sorted;
    }, {});
  }
  // "not set", "cleared" and "empty text" mean the same thing to the person editing.
  if (value === undefined || value === null || value === '') return null;
  return value;
}

function sameFieldValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

// Three-way merge between the canonical values the draft started from (base),
// the owner's edits (mine), and the canonical values now (theirs). Only fields
// that both sides moved in different directions are reported as conflicts;
// everything else resolves without asking the owner.
export function mergeProjectInfoDraftFields({ base, mine, theirs }) {
  const asFields = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const baseFields = asFields(base);
  const mineFields = asFields(mine);
  const theirsFields = asFields(theirs);
  // Drafts opened before rebase support have no base, so nothing can be
  // auto-merged and every difference must be confirmed by the owner.
  const hasBase = base !== null && base !== undefined;
  const merged = { ...mineFields };
  const autoMerged = [];
  const conflicts = [];
  Array.from(new Set([
    ...Object.keys(baseFields),
    ...Object.keys(mineFields),
    ...Object.keys(theirsFields),
  ])).sort().forEach((field) => {
    const baseValue = baseFields[field];
    const mineValue = mineFields[field];
    const theirsValue = theirsFields[field];
    if (sameFieldValue(mineValue, theirsValue)) return;
    if (hasBase && sameFieldValue(mineValue, baseValue)) {
      merged[field] = theirsValue;
      autoMerged.push({ field, value: theirsValue ?? null });
      return;
    }
    if (hasBase && sameFieldValue(theirsValue, baseValue)) return;
    conflicts.push({
      field,
      base: hasBase ? (baseValue ?? null) : null,
      mine: mineValue ?? null,
      theirs: theirsValue ?? null,
    });
  });
  return { merged, autoMerged, conflicts };
}

function assertRevision(draft, expected) {
  const actual = Number.isInteger(draft.draftRevision) ? draft.draftRevision : 0;
  if (actual !== expected) {
    throw createHttpError(
      409,
      `Draft revision mismatch: expected ${expected}, actual ${actual}`,
      'draft_version_conflict',
    );
  }
  return actual;
}

function idempotencyError(lock) {
  if (lock.mode === 'conflict') return createHttpError(409, lock.reason, 'idempotency_conflict');
  if (lock.mode === 'in_progress') return createHttpError(409, lock.reason, 'idempotency_in_progress');
  return null;
}

function auditEntry(current, actorRole, action, revision, timestamp, metadata = {}) {
  return {
    tenantId: current.tenantId,
    entityType: 'project_info_draft',
    entityId: current.draftDocumentId,
    action,
    actorId: current.actorId,
    actorRole,
    actorEmailEnc: current.actorEmailEnc,
    requestId: current.requestId,
    details: `Project information draft: ${action}`,
    metadata: {
      source: 'bff', resourceType: RESOURCE_TYPE, resourceId: current.projectId,
      sessionIdHash: sha256(`${current.tenantId}:${current.sessionId}`), draftRevision: revision,
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
    entityType: 'project_info_draft',
    entityId: current.draftDocumentId,
    payload: { draftId: current.draftDocumentId, projectId: current.projectId, paths: uniquePaths },
    createdAt: timestamp,
  });
}

export function createProjectInfoSubmittedOutboxHandler({
  db,
  driveService,
  projectRegistrationAttachmentStorageService,
  now = () => new Date().toISOString(),
}) {
  return async (event) => {
    const outboxId = readOptionalText(event?.id);
    const tenantId = readOptionalText(event?.tenantId);
    const projectId = readOptionalText(event?.payload?.projectId);
    const projectRequestId = readOptionalText(event?.payload?.projectRequestId);
    const requestVersion = Number(event?.payload?.requestVersion);
    const targetProjectVersion = Number(event?.payload?.targetProjectVersion);
    if (
      !outboxId
      || !tenantId
      || !projectId
      || !projectRequestId
      || !Number.isSafeInteger(requestVersion)
      || requestVersion < 1
      || !Number.isSafeInteger(targetProjectVersion)
      || targetProjectVersion < 1
    ) throw new Error('Project information outbox identity is missing');
    const requestRef = db.doc(`orgs/${tenantId}/project_requests/${projectRequestId}`);
    const projectRef = db.doc(`orgs/${tenantId}/projects/${projectId}`);
    const outboxRef = db.doc(`outbox/${outboxId}`);
    const currentDelivery = async (tx) => {
      const [requestSnap, projectSnap, outboxSnap] = await Promise.all([
        tx.get(requestRef), tx.get(projectRef), tx.get(outboxRef),
      ]);
      if (!requestSnap.exists || !projectSnap.exists || !outboxSnap.exists) {
        throw new Error('Project information delivery records are missing');
      }
      const outbox = outboxSnap.data() || {};
      if (event.claimToken && (outbox.status !== 'PROCESSING' || outbox.claimToken !== event.claimToken)) {
        throw new Error('Project information outbox claim is no longer current');
      }
      const request = requestSnap.data() || {};
      if (readOptionalText(request.requestKind) !== 'CHANGE' || readOptionalText(request.targetProjectId) !== projectId) {
        throw new Error('Project information request does not match its project');
      }
      const current = readOptionalText(request.submittedOutboxId) === outboxId
        && Number(request.requestVersion) === requestVersion
        && Number(request.targetProjectVersion) === targetProjectVersion;
      return current ? { request, project: projectSnap.data() || {} } : null;
    };
    const delivery = await db.runTransaction(currentDelivery);
    if (!delivery || (
      readOptionalText(delivery.request.driveArchiveFolderId)
      && readOptionalText(delivery.request.driveArchivedAt)
    )) return;
    if (!driveService?.getConfig?.().enabled) return;
    if (
      typeof driveService.ensureProjectChangeRequestFolder !== 'function'
      || typeof driveService.listFolderFiles !== 'function'
      || typeof driveService.uploadFileToFolder !== 'function'
    ) throw new Error('Project information Drive archive is not configured');

    const source = delivery.request.proposedSnapshot && typeof delivery.request.proposedSnapshot === 'object'
      ? delivery.request.proposedSnapshot
      : delivery.request.payload || {};
    const documents = Object.entries(DOCUMENT_FIELD_BY_KIND).flatMap(([documentKind, field]) => {
      const document = source[field];
      const path = readOptionalText(document?.path);
      return path ? [{ documentKind, path, document }] : [];
    });
    if (documents.length > 0 && typeof projectRegistrationAttachmentStorageService?.downloadProjectRegistrationAttachment !== 'function') {
      throw new Error('Project information attachment download is not configured');
    }
    const ensured = await driveService.ensureProjectChangeRequestFolder({
      tenantId,
      projectId,
      projectName: readOptionalText(delivery.project.name) || projectId,
      projectFolderId: readOptionalText(delivery.project.evidenceDriveRootFolderId),
      requestId: projectRequestId,
      requestVersion,
      requestedAt: readOptionalText(delivery.request.requestedAt),
    });
    const folder = ensured?.folder;
    const folderId = readOptionalText(folder?.id);
    if (!folderId) throw new Error('Project information Drive archive folder was not created');
    const existingFiles = await driveService.listFolderFiles({ folderId });
    const existingKeys = new Set((Array.isArray(existingFiles) ? existingFiles : [])
      .map((file) => readOptionalText(file?.appProperties?.archiveFileKey))
      .filter(Boolean));
    const archiveProperties = {
      managedBy: 'mysc-platform', tenantId, projectId,
      requestId: projectRequestId, requestVersion: String(requestVersion),
    };
    const summary = [
      `프로젝트 변경 요청: ${projectRequestId}`,
      `요청 버전: ${requestVersion}`,
      `요청자: ${readOptionalText(delivery.request.requestedByName) || readOptionalText(delivery.request.requestedBy) || '확인 불가'}`,
      `요청 시각: ${readOptionalText(delivery.request.requestedAt) || '확인 불가'}`,
      `변경 항목: ${(Array.isArray(delivery.request.changedFields) ? delivery.request.changedFields : []).join(', ') || '없음'}`,
    ].join('\n');
    const archiveFiles = [
      {
        key: 'request-json', fileName: '요청내용.json', mimeType: 'application/json',
        contentBase64: Buffer.from(`${JSON.stringify(delivery.request, null, 2)}\n`, 'utf8').toString('base64'),
      },
      {
        key: 'request-summary', fileName: '요청요약.txt', mimeType: 'text/plain',
        contentBase64: Buffer.from(`${summary}\n`, 'utf8').toString('base64'),
      },
      ...documents.map(({ documentKind, path, document }) => ({
        key: `document-${documentKind}`,
        fileName: `${documentKind}_${(readOptionalText(document.name) || path.split('/').at(-1) || 'attachment').replace(/[\\/]/g, '_')}`,
        mimeType: readOptionalText(document.contentType) || 'application/octet-stream',
        path,
      })),
    ];
    for (const file of archiveFiles) {
      if (existingKeys.has(file.key)) continue;
      let contentBase64 = file.contentBase64;
      let mimeType = file.mimeType;
      if (file.path) {
        const downloaded = await projectRegistrationAttachmentStorageService.downloadProjectRegistrationAttachment({
          tenantId, projectId, path: file.path,
        });
        const buffer = Buffer.isBuffer(downloaded?.buffer)
          ? downloaded.buffer
          : downloaded?.buffer instanceof Uint8Array ? Buffer.from(downloaded.buffer) : null;
        if (!buffer?.length) throw new Error('Project information Drive archive attachment is empty');
        contentBase64 = buffer.toString('base64');
        mimeType = readOptionalText(downloaded.contentType) || mimeType;
      }
      const uploaded = await driveService.uploadFileToFolder({
        folderId,
        fileName: file.fileName,
        mimeType,
        contentBase64,
        appProperties: { ...archiveProperties, archiveFileKey: file.key },
      });
      if (!readOptionalText(uploaded?.id)) throw new Error('Project information Drive archive upload was not created');
    }

    await db.runTransaction(async (tx) => {
      const latest = await currentDelivery(tx);
      if (!latest || (
        readOptionalText(latest.request.driveArchiveFolderId)
        && readOptionalText(latest.request.driveArchivedAt)
      )) return;
      const timestamp = new Date(now()).toISOString();
      tx.set(requestRef, {
        driveArchiveFolderId: folderId,
        driveArchiveFolderLink: readOptionalText(folder.webViewLink)
          || `https://drive.google.com/drive/folders/${folderId}`,
        driveArchivedAt: timestamp,
        updatedAt: timestamp,
      }, { merge: true });
    });
  };
}


/** 이 프로젝트를 만든 등록(REGISTRATION) 요청이 아직 검토 대기면 그 참조를 돌려준다. */
async function findPendingRegistrationRequestRef(db, tenantId, projectId) {
  const snapshot = await db.collection(`orgs/${tenantId}/project_requests`)
    .where('approvedProjectId', '==', projectId)
    .limit(5)
    .get();
  const match = snapshot.docs.find((doc) => {
    const request = doc.data() || {};
    return readOptionalText(request.requestKind) === 'REGISTRATION'
      && readOptionalText(request.status) === 'PENDING';
  });
  return match ? db.doc(`orgs/${tenantId}/project_requests/${match.id}`) : null;
}

export function createProjectInfoDraftService({
  db,
  now = () => new Date().toISOString(),
  createAttachmentId = () => `att_${randomUUID().replace(/-/g, '')}`,
  createOutboxEvent = createOutboxEventRecord,
  createAttachmentCleanupOutboxEvent = createOutboxEventRecord,
  auditChainService,
  idempotencyService,
  draftStorageService,
  rbacPolicy,
} = {}) {
  if (!db?.runTransaction) throw new Error('Firestore is required for project information drafts');
  if (!auditChainService?.appendManyInTransaction) throw new Error('Atomic audit chain service is required');
  if (!idempotencyService?.checkInTransaction || !idempotencyService?.completeInTransaction) {
    throw new Error('Atomic idempotency service is required');
  }
  if (!rbacPolicy) throw new Error('RBAC policy is required');

  function context(input, { ownership = true, idempotency = true } = {}) {
    const tenantId = documentId(input?.tenantId, 'tenantId');
    const actorId = documentId(input?.actorId, 'actorId');
    const projectId = documentId(input?.projectId, 'projectId');
    const sessionId = ownership ? documentId(input?.sessionId, 'sessionId') : undefined;
    return {
      tenantId, actorId, projectId, sessionId,
      leaseId: ownership ? documentId(input?.leaseId, 'leaseId') : undefined,
      fence: ownership ? positiveFence(input?.fence) : undefined,
      actorDisplayName: readOptionalText(input?.actorDisplayName) || '사용자',
      actorEmail: readOptionalText(input?.actorEmail),
      actorEmailEnc: readOptionalText(input?.actorEmailEnc) || undefined,
      requestId: readOptionalText(input?.requestId) || 'project-info-draft-request',
      idempotencyKey: idempotency ? requiredText(input?.idempotencyKey, 'idempotencyKey') : undefined,
      draftDocumentId: draftDocumentId(projectId, actorId),
    };
  }

  const refs = (current) => ({
    member: db.doc(`orgs/${current.tenantId}/members/${current.actorId}`),
    project: db.doc(`orgs/${current.tenantId}/projects/${current.projectId}`),
    draft: db.doc(`orgs/${current.tenantId}/privateEditDrafts/${current.draftDocumentId}`),
    lease: db.doc(`orgs/${current.tenantId}/editLeases/${resolveEditLeaseDocumentId(RESOURCE_TYPE, current.projectId)}`),
    request: db.doc(`orgs/${current.tenantId}/project_requests/change-${current.projectId}`),
  });

  async function accessProject(tx, current) {
    const { actorRole, member } = await assertEditLeaseActorAccessInTransaction({
      tx, db, tenantId: current.tenantId, actorId: current.actorId, rbacPolicy,
    });
    const ref = refs(current).project;
    const snap = await tx.get(ref);
    if (!snap.exists) throw createHttpError(404, 'Project not found', 'not_found');
    const project = snap.data() || {};
    if (
      !CROSS_PROJECT_ROLES.has(actorRole)
      && !memberProjectIds(member).has(current.projectId)
      && !projectOwnerIds(project).has(current.actorId)
    ) {
      throw createHttpError(403, 'Project assignment is required', 'forbidden');
    }
    return { actorRole, member, projectRef: ref, project };
  }

  async function ownedDraft(tx, current) {
    const access = await accessProject(tx, current);
    const ref = refs(current).draft;
    const snap = await tx.get(ref);
    const draft = snap.exists ? (snap.data() || {}) : null;
    if (!draft || readOptionalText(draft.ownerUid) !== current.actorId) {
      throw createHttpError(404, 'Project information draft not found', 'not_found');
    }
    return { ...access, draftRef: ref, draft };
  }

  async function checkIdempotency(tx, current, fingerprint, nowDate) {
    return idempotencyService.checkInTransaction(tx, {
      tenantId: current.tenantId,
      idempotencyKey: current.idempotencyKey,
      requestFingerprint: fingerprint,
      actorId: current.actorId,
      nowDate,
    });
  }

  function completeIdempotency(tx, current, lock, response, nowDate) {
    idempotencyService.completeInTransaction(tx, {
      ref: lock.ref,
      tenantId: current.tenantId,
      idempotencyKey: current.idempotencyKey,
      requestFingerprint: lock.requestFingerprint,
      responseStatus: response.status,
      responseBody: response.body,
      actorId: current.actorId,
      requestId: current.requestId,
      method: response.method,
      path: response.path,
      nowDate,
      ...(response.ttlSeconds ? { ttlSeconds: response.ttlSeconds } : {}),
    });
  }

  async function assertLease(tx, current, nowDate) {
    return assertOwnedInTransaction({
      tx,
      leaseRef: refs(current).lease,
      tenantId: current.tenantId,
      resourceType: RESOURCE_TYPE,
      resourceId: current.projectId,
      actorId: current.actorId,
      sessionId: current.sessionId,
      leaseId: current.leaseId,
      fence: current.fence,
      serverNow: nowDate,
    });
  }

  async function assertSubmittedAttachmentsStored(current, draft) {
    const attachments = draftAttachments(draft);
    if (attachments.length === 0) return;
    if (typeof draftStorageService?.inspectProjectRegistrationAttachment !== 'function') {
      throw new Error('Project registration attachment inspection is required');
    }
    try {
      await Promise.all(attachments.map(async (attachment) => {
        const stored = await draftStorageService.inspectProjectRegistrationAttachment({
          tenantId: current.tenantId,
          projectId: current.projectId,
          path: attachment.path,
        });
        if (
          readOptionalText(stored?.path) !== readOptionalText(attachment?.path)
          || readOptionalText(stored?.attachmentId) !== readOptionalText(attachment?.attachmentId)
          || Number(stored?.size) !== Number(attachment?.size)
          || readOptionalText(stored?.contentType) !== readOptionalText(attachment?.contentType)
        ) throw new Error('Project information attachment metadata does not match');
      }));
    } catch {
      throw createHttpError(
        422,
        '제출 파일을 확인할 수 없습니다. 다시 첨부해 주세요.',
        'project_attachment_unavailable',
      );
    }
  }

  return {
    async open(input) {
      const current = context(input);
      const method = 'POST';
      const path = `/api/v1/project-info-drafts/${current.projectId}/open`;
      const fingerprint = buildRequestFingerprint({
        method, path,
        body: { actorId: current.actorId, sessionId: current.sessionId, leaseId: current.leaseId, fence: current.fence },
      });
      return db.runTransaction(async (tx) => {
        const nowDate = clockDate(now);
        const timestamp = nowDate.toISOString();
        const { actorRole, project } = await accessProject(tx, current);
        const draftRef = refs(current).draft;
        const requestRef = refs(current).request;
        const [draftSnap, requestSnap] = await Promise.all([tx.get(draftRef), tx.get(requestRef)]);
        const lock = await checkIdempotency(tx, current, fingerprint, nowDate);
        if (lock.mode === 'replay') return { status: lock.status, body: lock.body, replayed: true };
        const lockError = idempotencyError(lock);
        if (lockError) throw lockError;
        await assertLease(tx, current, nowDate);
        const existing = draftSnap.exists ? (draftSnap.data() || {}) : null;
        const previousRequest = requestSnap.exists ? (requestSnap.data() || {}) : {};
        let draft = existing;
        if (existing?.status !== 'ACTIVE' || readOptionalText(existing.ownerUid) !== current.actorId) {
          const seed = buildProjectInfoDraftSeed(project, previousRequest);
          draft = {
            ownerUid: current.actorId,
            tenantId: current.tenantId,
            resourceType: RESOURCE_TYPE,
            resourceId: current.projectId,
            draftRevision: 0,
            baseCanonicalVersion: Number.isInteger(project.version) && project.version > 0 ? project.version : 1,
            // Frozen copy of the canonical values this draft started from, so a
            // later rebase can tell "the user changed it" from "someone else did".
            baseSnapshot: seed,
            payload: seed,
            attachmentRefs: resumableDraftAttachments(
              current.tenantId,
              current.projectId,
              current.draftDocumentId,
              previousRequest,
            ),
            stepIndex: 0,
            status: 'ACTIVE',
            createdAt: timestamp,
            updatedAt: timestamp,
          };
        }
        assertDraftSize(draft);
        const body = { draft: draftContract(draft) };
        if (draft !== existing) {
          await auditChainService.appendManyInTransaction(tx, [
            auditEntry(current, actorRole, 'PROJECT_INFO_DRAFT_OPEN', 0, timestamp, { fence: current.fence }),
          ]);
          tx.set(draftRef, draft);
        }
        completeIdempotency(tx, current, lock, { method, path, status: 200, body }, nowDate);
        return { status: 200, body, replayed: false };
      });
    },

    async withdraw(input) {
      const current = context(input);
      // 신규 등록 검토 대기 건도 회수할 수 있어야 한다. change-{projectId} 문서가 없으면
      // 이 프로젝트를 만든 등록 요청을 찾아 그쪽 분기로 회수한다(조회는 트랜잭션 밖, 검증은 안).
      const registrationRequestRef = await findPendingRegistrationRequestRef(db, current.tenantId, current.projectId);
      const method = 'POST';
      const path = `/api/v1/project-info-drafts/${current.projectId}/withdraw`;
      const fingerprint = buildRequestFingerprint({
        method, path,
        body: {
          actorId: current.actorId, sessionId: current.sessionId,
          leaseId: current.leaseId, fence: current.fence,
        },
      });
      return db.runTransaction(async (tx) => {
        const nowDate = clockDate(now);
        const timestamp = nowDate.toISOString();
        const { actorRole, project, draftRef, draft } = await ownedDraft(tx, current);
        const requestRef = refs(current).request;
        const requestSnap = await tx.get(requestRef);
        const lock = await checkIdempotency(tx, current, fingerprint, nowDate);
        if (lock.mode === 'replay') return { status: lock.status, body: lock.body, replayed: true };
        const lockError = idempotencyError(lock);
        if (lockError) throw lockError;
        await assertLease(tx, current, nowDate);
        const request = requestSnap.exists ? (requestSnap.data() || {}) : null;
        if (!request || readOptionalText(request.requestKind) !== 'CHANGE') {
          if (!registrationRequestRef) {
            throw createHttpError(409, 'No change request to withdraw', 'request_not_withdrawable');
          }
          // ── 등록(REGISTRATION) 회수 ──
          const registrationSnap = await tx.get(registrationRequestRef);
          const registration = registrationSnap.exists ? (registrationSnap.data() || {}) : null;
          if (
            !registration
            || readOptionalText(registration.requestKind) !== 'REGISTRATION'
            || readOptionalText(registration.status) !== 'PENDING'
          ) {
            throw createHttpError(409, 'No change request to withdraw', 'request_not_withdrawable');
          }
          if (readOptionalText(registration.requestedBy) !== current.actorId) {
            throw createHttpError(403, 'Only the requester can withdraw this change request', 'request_owner_mismatch');
          }
          const sourceDraftId = readOptionalText(registration.sourceDraftId);
          if (!sourceDraftId) {
            throw createHttpError(409, '등록 임시저장을 찾지 못해 회수할 수 없습니다.', 'request_not_withdrawable');
          }
          const registrationDraftRef = db.doc(`orgs/${current.tenantId}/projectRequestDrafts/${sourceDraftId}`);
          const registrationDraftSnap = await tx.get(registrationDraftRef);
          const registrationDraft = registrationDraftSnap.exists ? (registrationDraftSnap.data() || {}) : null;
          if (!registrationDraft) {
            throw createHttpError(409, '등록 임시저장을 찾지 못해 회수할 수 없습니다.', 'request_not_withdrawable');
          }
          // 제출 이벤트가 원본(사설 경로) 첨부 목록을 들고 있다 - 이관은 복사라 원본이 남아 있다.
          const submittedOutboxId = readOptionalText(registrationDraft.submittedOutboxId);
          const outboxSnap = submittedOutboxId ? await tx.get(db.doc(`outbox/${submittedOutboxId}`)) : null;
          const restoredAttachmentRefs = Array.isArray(outboxSnap?.data?.()?.payload?.attachmentRefs)
            ? outboxSnap.data().payload.attachmentRefs
            : [];

          const withdrawnRegistration = stripUndefinedDeep({
            ...registration,
            status: 'WITHDRAWN',
            withdrawnAt: timestamp,
            withdrawnBy: current.actorId,
            withdrawnByName: current.actorDisplayName || null,
            updatedAt: timestamp,
          });
          // 검토 대기 프로젝트는 폐기 상태로 내려 결재 대기열에서 뺀다. 사유는 이력에 남는다.
          const discardedProject = stripUndefinedDeep({
            ...project,
            executiveReviewStatus: 'DUPLICATE_DISCARDED',
            executiveReviewHistory: [
              ...(Array.isArray(project.executiveReviewHistory) ? project.executiveReviewHistory : []),
              {
                status: 'DUPLICATE_DISCARDED',
                previousStatus: 'PENDING',
                reviewedAt: timestamp,
                reviewedById: current.actorId,
                reviewedByName: current.actorDisplayName || null,
                reviewComment: '요청자가 등록 요청을 회수했습니다. 등록 임시저장으로 복원되었습니다.',
              },
            ],
            version: (Number.isInteger(project.version) && project.version > 0 ? project.version : 1) + 1,
            updatedBy: current.actorId,
            updatedAt: timestamp,
          });
          const restoredRegistrationDraft = stripUndefinedDeep({
            ...registrationDraft,
            status: 'ACTIVE',
            payload: registration.payload && typeof registration.payload === 'object'
              ? registration.payload
              : (registrationDraft.payload || {}),
            attachmentRefs: restoredAttachmentRefs,
            stepIndex: 0,
            draftRevision: (Number.isInteger(registrationDraft.draftRevision) ? registrationDraft.draftRevision : 0) + 1,
            submittedAt: null,
            submittedProjectId: null,
            submittedProjectRequestId: null,
            submittedOutboxId: null,
            updatedAt: timestamp,
          });
          await auditChainService.appendManyInTransaction(tx, [
            auditEntry(current, actorRole, 'PROJECT_INFO_DRAFT_WITHDRAW', 0, timestamp, {
              fence: current.fence,
              projectRequestId: readOptionalText(registration.id) || null,
              requestKind: 'REGISTRATION',
              registrationDraftId: sourceDraftId,
            }),
          ]);
          tx.set(registrationRequestRef, withdrawnRegistration);
          tx.set(projectRef, discardedProject);
          tx.set(registrationDraftRef, restoredRegistrationDraft);
          const registrationBody = {
            withdrawn: true,
            kind: 'REGISTRATION',
            registrationDraftId: sourceDraftId,
          };
          completeIdempotency(tx, current, lock, { method, path, status: 200, body: registrationBody }, nowDate);
          return { status: 200, body: registrationBody, replayed: false };
        }
        // A decided request is history; only one still awaiting a decision can be pulled back.
        if (readOptionalText(request.status) !== 'PENDING') {
          throw createHttpError(
            409,
            `Change request is already ${readOptionalText(request.status) || 'resolved'}`,
            'request_not_withdrawable',
          );
        }
        if (readOptionalText(request.requestedBy) !== current.actorId) {
          throw createHttpError(403, 'Only the requester can withdraw this change request', 'request_owner_mismatch');
        }
        const actualVersion = Number.isInteger(project.version) && project.version > 0 ? project.version : 1;
        const withdrawnRequest = stripUndefinedDeep({
          ...request,
          status: 'WITHDRAWN',
          withdrawnAt: timestamp,
          withdrawnBy: current.actorId,
          withdrawnByName: current.actorDisplayName || null,
          updatedAt: timestamp,
        });
        // Hand the submitted payload back to the owner, rebased onto the unchanged project
        // so the very next submit does not trip the canonical version gate again.
        const restoredDraft = stripUndefinedDeep({
          ...draft,
          status: 'ACTIVE',
          payload: request.payload && typeof request.payload === 'object' ? request.payload : draft.payload,
          baseSnapshot: buildProjectInfoDraftSeed({ ...project, id: current.projectId }, {}),
          baseCanonicalVersion: actualVersion,
          draftRevision: (Number.isInteger(draft.draftRevision) ? draft.draftRevision : 0) + 1,
          attachmentRefs: resumableDraftAttachments(
            current.tenantId,
            current.projectId,
            current.draftDocumentId,
            request,
          ),
          submittedAt: null,
          submittedProjectRequestId: null,
          submittedProjectVersion: null,
          submittedOutboxId: null,
          updatedAt: timestamp,
        });
        assertDraftSize(restoredDraft);
        await auditChainService.appendManyInTransaction(tx, [
          auditEntry(current, actorRole, 'PROJECT_INFO_DRAFT_WITHDRAW', restoredDraft.draftRevision, timestamp, {
            fence: current.fence,
            projectRequestId: readOptionalText(request.id) || null,
            canonicalVersion: actualVersion,
          }),
        ]);
        tx.set(requestRef, withdrawnRequest);
        tx.set(draftRef, restoredDraft);
        const body = {
          withdrawn: true,
          draft: draftContract(restoredDraft),
          canonicalVersion: actualVersion,
          executiveReviewStatus: readOptionalText(project.executiveReviewStatus) || 'PENDING',
        };
        completeIdempotency(tx, current, lock, { method, path, status: 200, body }, nowDate);
        return { status: 200, body, replayed: false };
      });
    },

    async rebase(input) {
      const current = context(input);
      const expectedDraftRevision = Number(input?.expectedDraftRevision);
      if (!Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 0) {
        throw createHttpError(400, 'Draft rebase version is invalid', 'draft_request_invalid');
      }
      const resolutions = input?.resolutions && typeof input.resolutions === 'object'
        ? input.resolutions
        : null;
      const method = 'POST';
      const path = `/api/v1/project-info-drafts/${current.projectId}/rebase`;
      const fingerprint = buildRequestFingerprint({
        method, path,
        body: {
          actorId: current.actorId, sessionId: current.sessionId, leaseId: current.leaseId,
          fence: current.fence, expectedDraftRevision, resolutions,
        },
      });
      return db.runTransaction(async (tx) => {
        const nowDate = clockDate(now);
        const timestamp = nowDate.toISOString();
        const { actorRole, project, draftRef, draft } = await ownedDraft(tx, current);
        const requestSnap = await tx.get(refs(current).request);
        const previousRequest = requestSnap.exists ? (requestSnap.data() || {}) : {};
        const lock = await checkIdempotency(tx, current, fingerprint, nowDate);
        if (lock.mode === 'replay') return { status: lock.status, body: lock.body, replayed: true };
        const lockError = idempotencyError(lock);
        if (lockError) throw lockError;
        assertActive(draft);
        assertRevision(draft, expectedDraftRevision);
        await assertLease(tx, current, nowDate);
        const actualVersion = Number.isInteger(project.version) && project.version > 0 ? project.version : 1;
        const theirs = buildProjectInfoDraftSeed(project, previousRequest);
        const { merged, autoMerged, conflicts } = mergeProjectInfoDraftFields({
          base: draft.baseSnapshot ?? null,
          mine: draft.payload,
          theirs,
        });
        // Without resolutions this is a preview: report the merge outcome and write nothing.
        if (!resolutions) {
          const body = {
            rebased: false,
            baseCanonicalVersion: Number.isInteger(draft.baseCanonicalVersion) ? draft.baseCanonicalVersion : 1,
            canonicalVersion: actualVersion,
            autoMerged,
            conflicts,
          };
          completeIdempotency(tx, current, lock, { method, path, status: 200, body }, nowDate);
          return { status: 200, body, replayed: false };
        }
        const unresolved = conflicts.filter((conflict) => (
          resolutions[conflict.field] !== 'MINE' && resolutions[conflict.field] !== 'THEIRS'
        ));
        if (unresolved.length > 0) {
          throw createHttpError(
            422,
            `Unresolved rebase conflicts: ${unresolved.map((conflict) => conflict.field).join(', ')}`,
            'draft_rebase_unresolved',
          );
        }
        conflicts.forEach((conflict) => {
          merged[conflict.field] = resolutions[conflict.field] === 'THEIRS' ? conflict.theirs : conflict.mine;
        });
        // `merged` and `theirs` are computed rather than literal, so an absent optional
        // field can arrive here as undefined, which Firestore rejects on write.
        const nextDraft = stripUndefinedDeep({
          ...draft,
          payload: merged,
          baseSnapshot: theirs,
          baseCanonicalVersion: actualVersion,
          draftRevision: expectedDraftRevision + 1,
          updatedAt: timestamp,
        });
        assertDraftSize(nextDraft);
        await auditChainService.appendManyInTransaction(tx, [
          auditEntry(current, actorRole, 'PROJECT_INFO_DRAFT_REBASE', nextDraft.draftRevision, timestamp, {
            fence: current.fence,
            baseCanonicalVersion: actualVersion,
            autoMergedFields: autoMerged.map((entry) => entry.field),
            resolvedFields: conflicts.map((conflict) => ({
              field: conflict.field,
              resolution: resolutions[conflict.field],
            })),
          }),
        ]);
        tx.set(draftRef, nextDraft);
        const body = {
          rebased: true,
          draft: draftContract(nextDraft),
          canonicalVersion: actualVersion,
          autoMerged,
          conflicts,
        };
        completeIdempotency(tx, current, lock, { method, path, status: 200, body }, nowDate);
        return { status: 200, body, replayed: false };
      });
    },

    async get(input) {
      const current = context(input, { ownership: false, idempotency: false });
      return db.runTransaction(async (tx) => {
        const { draft } = await ownedDraft(tx, current);
        return { draft: draftContract(draft) };
      });
    },

    async readAttachment(input) {
      if (!draftStorageService) {
        throw new Error('Draft attachment storage service is required');
      }
      const current = context(input, { ownership: false, idempotency: false });
      const documentKind = requiredText(input?.documentKind, 'documentKind');
      if (!DOCUMENT_KINDS.includes(documentKind)) {
        throw createHttpError(400, 'documentKind is invalid', 'draft_attachment_invalid');
      }
      const field = DOCUMENT_FIELD_BY_KIND[documentKind];
      const stored = await db.runTransaction(async (tx) => {
        const { draft, project } = await ownedDraft(tx, current);
        const match = draftAttachments(draft).findLast((item) => item?.documentKind === documentKind);
        if (match && readOptionalText(match.path)) {
          const permanentPrefix = `orgs/${current.tenantId}/project-registration-documents/${current.projectId}/`;
          return readOptionalText(match.path).startsWith(permanentPrefix)
            ? { source: 'project', attachment: match }
            : { source: 'draft', attachment: match };
        }

        const payloadDocument = draft.payload?.[field];
        const payloadPath = readOptionalText(payloadDocument?.path);
        const canonicalDocument = project?.[field];
        if (payloadPath && payloadPath === readOptionalText(canonicalDocument?.path)) {
          return { source: 'project', attachment: canonicalDocument };
        }

        const requestSnap = await tx.get(refs(current).request);
        const previousRequest = requestSnap.exists ? (requestSnap.data() || {}) : {};
        const resumableChange = readOptionalText(previousRequest.requestKind) === 'CHANGE'
          && ['PENDING', 'REJECTED'].includes(readOptionalText(previousRequest.status));
        const requestDocument = resumableChange
          ? (previousRequest.proposedSnapshot?.[field] || previousRequest.payload?.[field])
          : null;
        if (payloadPath && payloadPath === readOptionalText(requestDocument?.path)) {
          const sourceDraftId = draftIdFromTrustedAttachmentPath(current.tenantId, payloadPath);
          return sourceDraftId
            ? { source: 'draft', draftId: sourceDraftId, attachment: requestDocument }
            : { source: 'project', attachment: requestDocument };
        }

        throw createHttpError(404, 'Project information draft attachment not found', 'not_found');
      });
      const downloaded = stored.source === 'draft'
        ? await draftStorageService.downloadDraftAttachment({
          tenantId: current.tenantId,
          draftId: stored.draftId || current.draftDocumentId,
          path: stored.attachment.path,
        })
        : await draftStorageService.downloadProjectRegistrationAttachment({
          tenantId: current.tenantId,
          projectId: current.projectId,
          path: stored.attachment.path,
        });
      return { ...downloaded, name: readOptionalText(stored.attachment.name) || 'attachment.pdf' };
    },

    async update(input) {
      const current = context(input);
      const expectedDraftRevision = Number(input?.expectedDraftRevision);
      const payload = input?.payload;
      if (!Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 0) {
        throw createHttpError(400, 'expectedDraftRevision is invalid', 'draft_request_invalid');
      }
      assertPayload(payload);
      assertDraftSize({ payload });
      const method = 'PATCH';
      const path = `/api/v1/project-info-drafts/${current.projectId}`;
      const fingerprint = buildRequestFingerprint({
        method, path,
        body: {
          actorId: current.actorId, sessionId: current.sessionId, leaseId: current.leaseId,
          fence: current.fence, expectedDraftRevision, payload, stepIndex: input?.stepIndex ?? null,
        },
      });
      return db.runTransaction(async (tx) => {
        const nowDate = clockDate(now);
        const timestamp = nowDate.toISOString();
        const { actorRole, draftRef, draft } = await ownedDraft(tx, current);
        const lock = await checkIdempotency(tx, current, fingerprint, nowDate);
        if (lock.mode === 'replay') return { status: lock.status, body: lock.body, replayed: true };
        const lockError = idempotencyError(lock);
        if (lockError) throw lockError;
        assertActive(draft);
        await assertLease(tx, current, nowDate);
        const revision = assertRevision(draft, expectedDraftRevision) + 1;
        const next = {
          ...draft,
          payload,
          draftRevision: revision,
          stepIndex: Number.isInteger(input?.stepIndex) && input.stepIndex >= 0 ? input.stepIndex : draft.stepIndex,
          updatedAt: timestamp,
        };
        assertDraftSize(next);
        const body = { draft: draftContract(next) };
        await auditChainService.appendManyInTransaction(tx, [
          auditEntry(current, actorRole, 'PROJECT_INFO_DRAFT_SAVE', revision, timestamp, { fence: current.fence }),
        ]);
        tx.set(draftRef, next);
        completeIdempotency(tx, current, lock, { method, path, status: 200, body }, nowDate);
        return { status: 200, body, replayed: false };
      });
    },

    async addAttachment(input) {
      if (
        !draftStorageService?.uploadProjectRegistrationAttachment
        || !draftStorageService?.deleteProjectRegistrationAttachment
      ) {
        throw new Error('Draft attachment storage service is required');
      }
      const current = context(input);
      const expectedDraftRevision = Number(input?.expectedDraftRevision);
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
            tenantId: current.tenantId, draftId: current.draftDocumentId, path: incomingPath,
          }));
        } catch {
          throw createHttpError(422, '업로드된 파일을 찾지 못했습니다. 다시 업로드해 주세요.', 'draft_attachment_incoming_missing');
        }
      }
      if (!Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 0 || !buffer?.length) {
        throw createHttpError(400, 'Attachment request is invalid', 'draft_attachment_invalid');
      }
      if (Number(input?.fileSize) !== buffer.byteLength) {
        throw createHttpError(422, 'Attachment size does not match its content', 'draft_attachment_size_mismatch');
      }
      const documentKind = requiredText(input?.documentKind, 'documentKind');
      if (!DOCUMENT_KINDS.includes(documentKind)) {
        throw createHttpError(400, 'documentKind is invalid', 'draft_attachment_invalid');
      }
      const replacedDocumentKinds = replacementDocumentKinds(documentKind);
      const fileName = requiredText(input?.fileName, 'fileName');
      const mimeType = requiredText(input?.mimeType, 'mimeType');
      assertProjectAttachment(buffer, mimeType, fileName, documentKind);
      const attachmentId = documentId(createAttachmentId(), 'attachmentId');
      const method = 'POST';
      const path = `/api/v1/project-info-drafts/${current.projectId}/attachments`;
      const fingerprint = buildRequestFingerprint({
        method, path,
        body: {
          actorId: current.actorId, sessionId: current.sessionId, leaseId: current.leaseId,
          fence: current.fence, expectedDraftRevision, documentKind, fileName, mimeType,
          fileSize: buffer.byteLength, contentHash: sha256(buffer),
        },
      });
      const preflight = await db.runTransaction(async (tx) => {
        const nowDate = clockDate(now);
        const { draft } = await ownedDraft(tx, current);
        const lock = await checkIdempotency(tx, current, fingerprint, nowDate);
        if (lock.mode === 'replay') return { status: lock.status, body: lock.body, replayed: true };
        const lockError = idempotencyError(lock);
        if (lockError) throw lockError;
        assertActive(draft);
        await assertLease(tx, current, nowDate);
        assertRevision(draft, expectedDraftRevision);
        const replacesExistingKind = draftAttachments(draft)
          .some((attachment) => replacedDocumentKinds.includes(attachment.documentKind));
        if (draftAttachments(draft).length >= MAX_ATTACHMENT_REFS && !replacesExistingKind) {
          throw createHttpError(422, 'Draft attachment limit exceeded', 'draft_attachment_limit_exceeded');
        }
        return null;
      });
      if (preflight) return preflight;

      let uploaded;
      const cleanup = async () => {
        if (!uploaded?.path) return;
        try {
          await draftStorageService.deleteProjectRegistrationAttachment({
            tenantId: current.tenantId,
            projectId: current.projectId,
            draftId: current.draftDocumentId,
            path: uploaded.path,
          });
        } catch {
          console.warn('[bff] project info draft attachment cleanup failed', {
            requestId: current.requestId, errorCode: 'draft_attachment_cleanup_failed',
          });
        }
      };
      try {
        uploaded = await draftStorageService.uploadProjectRegistrationAttachment({
          tenantId: current.tenantId,
          projectId: current.projectId,
          draftId: current.draftDocumentId,
          attachmentId,
          fileName,
          mimeType,
          fileSize: buffer.byteLength,
          buffer,
          actorId: current.actorId,
        });
        const prefix = `orgs/${current.tenantId}/project-registration-documents/${current.projectId}/`;
        const storagePath = readOptionalText(uploaded?.path);
        if (!storagePath.startsWith(prefix)) throw new Error('Draft storage returned a path outside the private project prefix');
        const attachment = {
          attachmentId, documentKind, path: storagePath, name: fileName, size: buffer.byteLength,
          contentType: mimeType, uploadedAt: readOptionalText(uploaded.uploadedAt) || clockDate(now).toISOString(),
        };
        let replacedAttachments = [];
        const outcome = await db.runTransaction(async (tx) => {
          const nowDate = clockDate(now);
          const timestamp = nowDate.toISOString();
          const { actorRole, draftRef, draft } = await ownedDraft(tx, current);
          const lock = await checkIdempotency(tx, current, fingerprint, nowDate);
          if (lock.mode === 'replay') return { status: lock.status, body: lock.body, replayed: true };
          const lockError = idempotencyError(lock);
          if (lockError) throw lockError;
          assertActive(draft);
          await assertLease(tx, current, nowDate);
          const revision = assertRevision(draft, expectedDraftRevision) + 1;
          replacedAttachments = draftAttachments(draft)
            .filter((currentAttachment) => replacedDocumentKinds.includes(currentAttachment.documentKind));
          const next = {
            ...draft,
            payload: payloadWithoutAttachment(draft.payload, documentKind, replacedAttachments),
            attachmentRefs: [
              ...draftAttachments(draft).filter((currentAttachment) => !replacedDocumentKinds.includes(currentAttachment.documentKind)),
              attachment,
            ],
            draftRevision: revision,
            updatedAt: timestamp,
          };
          assertDraftSize(next);
          const body = { draft: draftContract(next), attachment };
          await auditChainService.appendManyInTransaction(tx, [
            auditEntry(current, actorRole, 'PROJECT_INFO_DRAFT_ATTACHMENT_ADD', revision, timestamp, {
              fence: current.fence, attachmentId,
            }),
          ]);
          tx.set(draftRef, next);
          completeIdempotency(tx, current, lock, { method, path, status: 200, body }, nowDate);
          const cleanupEvent = attachmentCleanupEvent(
            createAttachmentCleanupOutboxEvent,
            current,
            replacedAttachments
              .filter((replaced) => (
                replaced?.inheritedFromProjectRequest !== true
                && readOptionalText(replaced?.path)
                && replaced.path !== attachment.path
              ))
              .map((replaced) => replaced.path),
            timestamp,
          );
          if (cleanupEvent) {
            tx.create(db.doc(`outbox/${documentId(cleanupEvent.id, 'outboxId')}`), cleanupEvent);
          }
          return { status: 200, body, replayed: false };
        });
        if (outcome.replayed) await cleanup();
        else {
          await Promise.all(replacedAttachments.map(async (replaced) => {
            if (
              replaced?.inheritedFromProjectRequest === true
              || !readOptionalText(replaced?.path)
              || replaced.path === attachment.path
            ) return;
            try {
              await draftStorageService.deleteProjectRegistrationAttachment({
                tenantId: current.tenantId,
                projectId: current.projectId,
                draftId: current.draftDocumentId,
                path: replaced.path,
              });
            } catch {
              console.warn('[bff] replaced project info draft attachment cleanup failed', {
                requestId: current.requestId, errorCode: 'draft_attachment_replacement_cleanup_failed',
              });
            }
          }));
        }
        if (incomingPath) {
          await draftStorageService.deleteIncomingUpload?.({
            tenantId: current.tenantId, draftId: current.draftDocumentId, path: incomingPath,
          }).catch(() => {});
        }
        return outcome;
      } catch (error) {
        await cleanup();
        throw error;
      }
    },

    /** 서명 URL 발급. 소유권(리스)·역할·이름/종류/크기를 먼저 확인하고 10분짜리 PUT URL 을 준다. */
    async issueAttachmentUploadUrl(input) {
      if (!draftStorageService?.createIncomingUploadUrl) {
        throw createHttpError(503, '대용량 첨부 업로드가 아직 켜져 있지 않습니다.', 'draft_attachment_direct_unavailable');
      }
      const current = context(input);
      const documentKind = requiredText(input?.documentKind, 'documentKind');
      if (!DOCUMENT_KINDS.includes(documentKind)) {
        throw createHttpError(400, 'documentKind is invalid', 'draft_attachment_invalid');
      }
      const fileName = requiredText(input?.fileName, 'fileName');
      const mimeType = requiredText(input?.mimeType, 'mimeType');
      await db.runTransaction(async (tx) => {
        const nowDate = clockDate(now);
        const { draft } = await ownedDraft(tx, current);
        assertActive(draft);
        await assertLease(tx, current, nowDate);
      });
      const session = await draftStorageService.createIncomingUploadUrl({
        tenantId: current.tenantId, draftId: current.draftDocumentId, fileName, mimeType,
      });
      return { status: 200, body: { uploadUrl: session.uploadUrl, storagePath: session.path, expiresAt: session.expiresAt } };
    },

    async removeAttachment(input) {
      if (!draftStorageService?.deleteProjectRegistrationAttachment) {
        throw new Error('Draft attachment storage service is required');
      }
      const current = context(input);
      const expectedDraftRevision = Number(input?.expectedDraftRevision);
      if (!Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 0) {
        throw createHttpError(400, 'expectedDraftRevision is invalid', 'draft_request_invalid');
      }
      const documentKind = requiredText(input?.documentKind, 'documentKind');
      if (!DOCUMENT_KINDS.includes(documentKind)) {
        throw createHttpError(400, 'documentKind is invalid', 'draft_attachment_invalid');
      }
      const method = 'DELETE';
      const path = `/api/v1/project-info-drafts/${current.projectId}/attachments/${documentKind}`;
      const fingerprint = buildRequestFingerprint({
        method,
        path,
        body: {
          actorId: current.actorId,
          sessionId: current.sessionId,
          leaseId: current.leaseId,
          fence: current.fence,
          expectedDraftRevision,
          documentKind,
        },
      });

      const result = await db.runTransaction(async (tx) => {
        const nowDate = clockDate(now);
        const timestamp = nowDate.toISOString();
        const { actorRole, draftRef, draft } = await ownedDraft(tx, current);
        const lock = await checkIdempotency(tx, current, fingerprint, nowDate);
        if (lock.mode === 'replay') {
          return { outcome: { status: lock.status, body: lock.body, replayed: true }, removedAttachments: [] };
        }
        const lockError = idempotencyError(lock);
        if (lockError) throw lockError;
        assertActive(draft);
        await assertLease(tx, current, nowDate);
        const revision = assertRevision(draft, expectedDraftRevision) + 1;
        const removedAttachments = draftAttachments(draft)
          .filter((attachment) => attachment?.documentKind === documentKind && readOptionalText(attachment?.path));
        if (removedAttachments.length === 0) {
          throw createHttpError(404, 'Project information draft attachment not found', 'not_found');
        }
        const next = {
          ...draft,
          payload: payloadWithoutAttachment(draft.payload, documentKind, removedAttachments),
          attachmentRefs: draftAttachments(draft).filter((attachment) => attachment?.documentKind !== documentKind),
          draftRevision: revision,
          updatedAt: timestamp,
        };
        assertDraftSize(next);
        const body = { draft: draftContract(next) };
        await auditChainService.appendManyInTransaction(tx, [
          auditEntry(current, actorRole, 'PROJECT_INFO_DRAFT_ATTACHMENT_REMOVE', revision, timestamp, {
            fence: current.fence,
            documentKind,
            attachmentIds: removedAttachments.map((attachment) => readOptionalText(attachment?.attachmentId)).filter(Boolean),
          }),
        ]);
        tx.set(draftRef, next);
        completeIdempotency(tx, current, lock, { method, path, status: 200, body }, nowDate);
        const cleanupEvent = attachmentCleanupEvent(
          createAttachmentCleanupOutboxEvent,
          current,
          removedAttachments
            .filter((attachment) => attachment?.inheritedFromProjectRequest !== true)
            .map((attachment) => attachment.path),
          timestamp,
        );
        if (cleanupEvent) {
          tx.create(db.doc(`outbox/${documentId(cleanupEvent.id, 'outboxId')}`), cleanupEvent);
        }
        return { outcome: { status: 200, body, replayed: false }, removedAttachments };
      });

      await Promise.all(result.removedAttachments.map(async (attachment) => {
        if (attachment?.inheritedFromProjectRequest === true) return;
        try {
          await draftStorageService.deleteProjectRegistrationAttachment({
            tenantId: current.tenantId,
            projectId: current.projectId,
            draftId: current.draftDocumentId,
            path: attachment.path,
          });
        } catch {
          console.warn('[bff] removed project info draft attachment cleanup failed', {
            requestId: current.requestId,
            errorCode: 'draft_attachment_remove_cleanup_failed',
          });
        }
      }));
      return result.outcome;
    },

    async submit(input) {
      const current = context(input);
      const expectedDraftRevision = Number(input?.expectedDraftRevision);
      const expectedVersion = Number(input?.expectedVersion);
      if (!Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 0 || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
        throw createHttpError(400, 'Draft submit version is invalid', 'draft_request_invalid');
      }
      const method = 'POST';
      const path = `/api/v1/project-info-drafts/${current.projectId}/submit`;
      const fingerprint = buildRequestFingerprint({
        method, path,
        body: {
          actorId: current.actorId, sessionId: current.sessionId, leaseId: current.leaseId,
          fence: current.fence, expectedDraftRevision, expectedVersion,
          resubmit: input?.resubmit === true, reviewComment: readOptionalText(input?.reviewComment) || null,
        },
      });
      const eventTemplate = createOutboxEvent({
        tenantId: current.tenantId,
        requestId: current.requestId,
        eventType: 'project.info.submitted',
        entityType: 'project',
        entityId: current.projectId,
        payload: {},
        createdAt: clockDate(now).toISOString(),
      });
      const outboxRef = db.doc(`outbox/${documentId(eventTemplate.id, 'outboxId')}`);
      const outcome = await db.runTransaction(async (tx) => {
        const nowDate = clockDate(now);
        const timestamp = nowDate.toISOString();
        const { actorRole, projectRef, project, draftRef, draft } = await ownedDraft(tx, current);
        const requestRef = refs(current).request;
        const requestSnap = await tx.get(requestRef);
        const previousRequest = requestSnap.exists ? (requestSnap.data() || {}) : null;
        const lock = await checkIdempotency(tx, current, fingerprint, nowDate);
        if (lock.mode === 'replay') return { status: lock.status, body: lock.body, replayed: true };
        const lockError = idempotencyError(lock);
        if (lockError) throw lockError;
        assertActive(draft);
        assertRevision(draft, expectedDraftRevision);
        const lease = await assertLease(tx, current, nowDate);
        const actualVersion = Number.isInteger(project.version) && project.version > 0 ? project.version : 1;
        if (draft.baseCanonicalVersion !== actualVersion || expectedVersion !== actualVersion) {
          throw createHttpError(
            409,
            `Canonical version mismatch: expected ${expectedVersion}, actual ${actualVersion}`,
            'canonical_version_conflict',
          );
        }
        await assertSubmittedAttachmentsStored(current, draft);
        const nextVersion = actualVersion + 1;
        const { projectRequest } = buildProjectInfoChangeSubmission({
          tenantId: current.tenantId,
          project: { ...project, id: current.projectId },
          previousRequest,
          payload: draft.payload,
          attachmentRefs: draftAttachments(draft),
          actorId: current.actorId,
          actorName: current.actorDisplayName,
          actorEmail: current.actorEmail,
          timestamp,
          resubmit: input?.resubmit === true,
          reviewComment: input?.reviewComment,
        });
        const submittedProjectRequest = {
          ...projectRequest,
          submittedOutboxId: eventTemplate.id,
        };
        const revision = expectedDraftRevision + 1;
        const submittedDraft = {
          ownerUid: current.actorId,
          tenantId: current.tenantId,
          resourceType: RESOURCE_TYPE,
          resourceId: current.projectId,
          draftRevision: revision,
          baseCanonicalVersion: actualVersion,
          status: 'SUBMITTED',
          createdAt: draft.createdAt || timestamp,
          updatedAt: timestamp,
          submittedAt: timestamp,
          submittedProjectRequestId: projectRequest.id,
          submittedProjectVersion: nextVersion,
          submittedOutboxId: eventTemplate.id,
        };
        const releasedLease = {
          ...lease,
          state: 'RELEASED',
          releasedAt: timestamp,
          releaseReason: 'FINAL_SUBMIT',
          updatedAt: timestamp,
        };
        const outboxEvent = {
          ...eventTemplate,
          payload: {
            projectId: current.projectId,
            projectRequestId: submittedProjectRequest.id,
            requestVersion: submittedProjectRequest.requestVersion,
            targetProjectVersion: submittedProjectRequest.targetProjectVersion,
          },
          createdAt: timestamp,
          nextAttemptAt: timestamp,
          updatedAt: timestamp,
        };
        const body = {
          status: 'SUBMITTED',
          projectId: current.projectId,
          projectRequestId: projectRequest.id,
          projectVersion: actualVersion,
          draftRevision: revision,
          submittedAt: timestamp,
          lease: { state: 'RELEASED', canEdit: false },
          outbox: { id: outboxEvent.id, status: outboxEvent.status || 'PENDING' },
        };
        await auditChainService.appendManyInTransaction(tx, [
          auditEntry(current, actorRole, 'PROJECT_INFO_DRAFT_SUBMIT', revision, timestamp, {
            fence: current.fence,
            projectRequestId: projectRequest.id,
            projectVersion: actualVersion,
            targetProjectVersion: nextVersion,
          }),
          buildEditLeaseAuditEntry({ ...current, resourceType: RESOURCE_TYPE, resourceId: current.projectId }, actorRole, 'release', {
            state: 'RELEASED', fence: current.fence, resultCode: 'edit_lease_released_on_submit', timestamp,
          }),
        ]);
        tx.set(requestRef, submittedProjectRequest);
        tx.set(draftRef, submittedDraft);
        tx.set(refs(current).lease, releasedLease);
        tx.create(outboxRef, outboxEvent);
        completeIdempotency(tx, current, lock, { method, path, status: 200, body, ttlSeconds: 86_400 }, nowDate);
        return { status: 200, body, replayed: false };
      });
      return outcome;
    },
  };
}

function requireHeader(req, name) {
  return requiredText(req.header(name), name);
}

function routeProjectId(req) {
  return documentId(req.params?.projectId, 'projectId');
}

function routeOwnership(req) {
  return {
    sessionId: documentId(requireHeader(req, 'x-edit-session-id'), 'sessionId'),
    leaseId: documentId(requireHeader(req, 'x-edit-lease-id'), 'leaseId'),
    fence: positiveFence(requireHeader(req, 'x-edit-fence')),
  };
}

async function routeContext(req, piiProtector) {
  return {
    tenantId: req.context?.tenantId,
    actorId: req.context?.actorId,
    actorRole: req.context?.actorRole,
    actorDisplayName: req.context?.actorName,
    actorEmail: req.context?.actorEmail,
    actorEmailEnc: piiProtector ? await encryptAuditEmail(piiProtector, req.context?.actorEmail) : undefined,
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

export function mountProjectInfoDraftRoutes(app, {
  enabled = false,
  projectInfoDraftService,
  piiProtector,
  processOutboxEventInline,
} = {}) {
  if (!enabled) return;
  if (!projectInfoDraftService) throw new Error('Project information draft routes require a service');

  app.get('/api/v1/project-info-drafts/:projectId', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'read a project information draft');
    res.status(200).json(await projectInfoDraftService.get({
      ...await routeContext(req, piiProtector), projectId: routeProjectId(req),
    }));
  }));

  app.get('/api/v1/project-info-drafts/:projectId/attachments/:documentKind', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'read a project information draft attachment');
    sendPrivateDraftAttachment(res, await projectInfoDraftService.readAttachment({
      ...await routeContext(req, piiProtector),
      projectId: routeProjectId(req),
      documentKind: requiredText(req.params?.documentKind, 'documentKind'),
    }));
  }));

  app.post('/api/v1/project-info-drafts/:projectId/open', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'open a project information draft');
    parseWithSchema(projectInfoDraftOpenSchema, req.body);
    sendOutcome(res, await projectInfoDraftService.open({
      ...await routeContext(req, piiProtector), ...routeOwnership(req), projectId: routeProjectId(req),
    }));
  }));

  app.patch('/api/v1/project-info-drafts/:projectId', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'save a project information draft');
    const parsed = parseWithSchema(projectInfoDraftPatchSchema, req.body);
    sendOutcome(res, await projectInfoDraftService.update({
      ...await routeContext(req, piiProtector), ...routeOwnership(req), projectId: routeProjectId(req), ...parsed,
    }));
  }));

  app.post('/api/v1/project-info-drafts/:projectId/attachments/upload-url', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'request a project information draft upload URL');
    const parsed = parseWithSchema(projectInfoDraftAttachmentUploadUrlSchema, req.body);
    sendOutcome(res, await projectInfoDraftService.issueAttachmentUploadUrl({
      ...await routeContext(req, piiProtector), ...routeOwnership(req), projectId: routeProjectId(req),
      ...parsed,
    }));
  }));

  app.post('/api/v1/project-info-drafts/:projectId/attachments', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'attach a project information draft file');
    const parsed = parseWithSchema(projectInfoDraftAttachmentSchema, req.body);
    sendOutcome(res, await projectInfoDraftService.addAttachment({
      ...await routeContext(req, piiProtector), ...routeOwnership(req), projectId: routeProjectId(req),
      ...parsed,
      buffer: parsed.contentBase64 ? decodeBase64(parsed.contentBase64, parsed.fileSize) : undefined,
    }));
  }));

  app.delete('/api/v1/project-info-drafts/:projectId/attachments/:documentKind', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'remove a project information draft file');
    const parsed = parseWithSchema(projectDraftAttachmentDeleteSchema, req.body);
    sendOutcome(res, await projectInfoDraftService.removeAttachment({
      ...await routeContext(req, piiProtector),
      ...routeOwnership(req),
      projectId: routeProjectId(req),
      documentKind: requiredText(req.params?.documentKind, 'documentKind'),
      ...parsed,
    }));
  }));

  app.post('/api/v1/project-info-drafts/:projectId/withdraw', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'withdraw a project change request');
    parseWithSchema(projectInfoDraftOpenSchema, req.body);
    sendOutcome(res, await projectInfoDraftService.withdraw({
      ...await routeContext(req, piiProtector), ...routeOwnership(req), projectId: routeProjectId(req),
    }));
  }));

  app.post('/api/v1/project-info-drafts/:projectId/rebase', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'rebase a project information draft');
    const parsed = parseWithSchema(projectInfoDraftRebaseSchema, req.body);
    sendOutcome(res, await projectInfoDraftService.rebase({
      ...await routeContext(req, piiProtector), ...routeOwnership(req), projectId: routeProjectId(req), ...parsed,
    }));
  }));

  app.post('/api/v1/project-info-drafts/:projectId/submit', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'submit a project information draft');
    const parsed = parseWithSchema(projectInfoDraftSubmitSchema, req.body);
    const outcome = await projectInfoDraftService.submit({
      ...await routeContext(req, piiProtector), ...routeOwnership(req), projectId: routeProjectId(req), ...parsed,
    });
    // 첨부 공개 이관을 같은 요청 안에서 처리한다. 실패해도 크론이 안전망이라 응답은 성공 그대로.
    const outboxId = !outcome.replayed ? outcome.body?.outbox?.id : null;
    if (outboxId && processOutboxEventInline) {
      await processOutboxEventInline(outboxId).catch((error) => {
        console.warn('[bff] inline info submit outbox processing failed', {
          outboxId, errorCode: 'submit_outbox_inline_failed', message: error?.message,
        });
      });
    }
    sendOutcome(res, outcome);
  }));
}
