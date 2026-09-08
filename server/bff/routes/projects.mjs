import express from 'express';
import { randomUUID } from 'node:crypto';
import { projectDocumentValidationError } from '../project-document-validation.mjs';
import { createOutboxEvent } from '../outbox.mjs';
import {
  DriveServiceError,
  extractDriveFolderId,
} from '../google-drive.mjs';
import { GoogleSheetsServiceError } from '../google-sheets.mjs';
import { extractTextFromPdfBuffer } from '../pdf-text.mjs';
import { normalizeProjectRevenueFields } from '../project-financials.mjs';
import {
  normalizeBasis,
  normalizeSettlementSystemCode,
  resolveParticipationSettlementSystem,
  SETTLEMENT_SYSTEM_CODES,
} from '../participation-settlement-system.mjs';
import { stableStringify } from '../utils.mjs';
import {
  PROJECT_INFO_DOCUMENT_KINDS,
  PROJECT_REGISTRATION_DOCUMENT_KINDS,
  PROJECT_DOCUMENT_FIELD_BY_KIND,
  PROJECT_DOCUMENT_LABEL_BY_FIELD,
  PROJECT_REGISTRATION_REQUIRED_DOCUMENT_KINDS,
  missingProjectRegistrationRequiredDocumentKind,
  assertProjectDocumentOriginals,
  assertNoActiveProjectInfoDraft,
} from '../project-document-validation.mjs';
import {
  asyncHandler, createMutatingRoute, assertActorRoleAllowed,
  ROUTE_ROLES, PROJECT_REQUEST_ROUTE_ROLES, createHttpError, encryptAuditEmail,
  parseLimit, parseCursor, buildListResponse,
  ensureDocumentExists, upsertVersionedDoc, mergeSystemManagedDoc,
  stripServerManagedFields, stripExpectedVersion, stripUndefinedDeep, readOptionalText, decodeHeaderValue,
  normalizeRole,
} from '../bff-utils.mjs';
import {
  parseWithSchema,
  projectUpsertSchema,
  googleSheetImportPreviewSchema,
  googleSheetImportAnalyzeSchema,
  projectSheetSourceUploadSchema,
  projectRequestContractAnalyzeSchema,
  projectRequestContractUploadSchema,
  projectDriveRootLinkSchema,
  projectRestoreSchema,
  projectTrashSchema,
  projectExecutiveReviewSchema,
  projectExecutiveResubmitSchema,
  projectManagementPlanningReviewSchema,
} from '../schemas.mjs';

function trimSlackText(value, maxLength = 200) {
  const text = readOptionalText(value);
  if (!text) return '-';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatKrw(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `${value.toLocaleString('ko-KR')}원`;
}

function formatProjectPeriod(start, end) {
  const normalizedStart = readOptionalText(start);
  const normalizedEnd = readOptionalText(end);
  if (normalizedStart && normalizedEnd) return `${normalizedStart} ~ ${normalizedEnd}`;
  return normalizedStart || normalizedEnd || '-';
}

const PROJECT_TYPE_SLACK_LABELS = {
  C1: 'C-1 컨설팅',
  A1: 'A-1 액셀러레이팅 - 국내일반',
  A2: 'A-2 액셀러레이팅 - 글로벌',
  I1: 'I-1 투자조합운용',
  I2: 'I-2 투자조합운용 - GP관리보수',
  I3: 'I-3 투자조합운용 - LP수익',
  D1: 'D-1 개발협력사업 - AVPN 포함',
  S1: 'S-1 공간사업 - 메리히어',
  S2: 'S-2 공간사업 - 공간운영 용역사업',
  E1: 'E-1 교육사업 - 단기 워크숍 등',
  P1: 'P-1 출판사업',
  Z1: 'Z-1 기타사업',
};

export function formatProjectTypeSlackLabel(value) {
  const normalized = normalizeProjectType(readOptionalText(value));
  return PROJECT_TYPE_SLACK_LABELS[normalized] || normalized;
}

function formatOptionalProjectAmount(value, explicit) {
  if (explicit === false) return '-';
  return Number.isFinite(value) ? formatKrw(value) : '-';
}

function normalizeProjectCode(value) {
  return readOptionalText(value).toUpperCase().replace(/\s+/g, '');
}

function requireProjectCode(value) {
  const projectCode = normalizeProjectCode(value);
  if (!projectCode) {
    throw createHttpError(422, 'projectCode is required when agreeing a project', 'missing_project_code');
  }
  if (projectCode.length > 64 || !/^[A-Z0-9_-]+$/.test(projectCode)) {
    throw createHttpError(422, 'projectCode must use letters, numbers, hyphens, or underscores', 'invalid_project_code');
  }
  return projectCode;
}

function hasLegacyPlanningAgreement(project) {
  return Array.isArray(project?.executiveReviewHistory)
    && project.executiveReviewHistory.some((entry) => readOptionalText(entry?.status) === 'PLANNING_AGREED');
}

function isManagementPlanningRevisionRejected(project) {
  return readOptionalText(project?.executiveReviewStatus) === 'APPROVED'
    && readOptionalText(project?.managementPlanningReviewStatus) === 'REVISION_REJECTED';
}

function isExecutiveRevisionRejected(project) {
  const status = readOptionalText(project?.executiveReviewStatus);
  return status === 'REVISION_REJECTED' || status === 'DUPLICATE_DISCARDED';
}

function buildManagementPlanningResubmissionPatch() {
  return {
    managementPlanningReviewStatus: 'PENDING',
    managementPlanningReviewedAt: null,
    managementPlanningReviewedById: null,
    managementPlanningReviewedByName: null,
    managementPlanningReviewComment: null,
  };
}

export function buildProjectRegistrationSlackPayload(projectRequest) {
  const payload = projectRequest?.payload && typeof projectRequest.payload === 'object'
    ? projectRequest.payload
    : {};
  const projectName = trimSlackText(payload.name, 120);
  const officialContractName = trimSlackText(payload.officialContractName, 220);
  const clientOrg = trimSlackText(payload.clientOrg, 160);
  const department = trimSlackText(payload.department, 120);
  const managerName = trimSlackText(payload.managerName, 120);
  const teamName = trimSlackText(payload.teamName, 120);
  const financialInputFlags = payload.financialInputFlags && typeof payload.financialInputFlags === 'object'
    ? payload.financialInputFlags
    : {};
  const requester = trimSlackText(projectRequest?.requestedByName, 120);
  const requesterEmail = trimSlackText(projectRequest?.requestedByEmail, 160);
  const projectId = trimSlackText(projectRequest?.approvedProjectId, 120);
  const purpose = trimSlackText(payload.projectPurpose, 280);
  const lines = [
    '*[InnerPlatform] 프로젝트 등록 요청 접수*',
    `프로젝트명: \`${projectName}\``,
    `공식 계약명: ${officialContractName}`,
    `계약 대상: ${clientOrg}`,
    `담당조직(CIC): ${department}`,
    `PM: ${managerName}`,
    `팀/인력: ${teamName}`,
    `계약 기간: ${formatProjectPeriod(payload.contractStart, payload.contractEnd)}`,
    `계약금액: ${formatOptionalProjectAmount(payload.contractAmount, financialInputFlags.contractAmount)}`,
    `프로젝트 목적: ${purpose}`,
    `요청자: ${requester} (${requesterEmail})`,
    `projectId: \`${projectId}\``,
  ];

  return {
    text: `[InnerPlatform] 프로젝트 등록 요청 접수: ${projectName}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: lines.join('\n'),
        },
      },
    ],
  };
}

function buildProjectCreatedSlackPayload(project, context = {}) {
  const payload = project && typeof project === 'object' ? project : {};
  const projectName = trimSlackText(payload.name, 120);
  const officialContractName = trimSlackText(payload.officialContractName, 220);
  const clientOrg = trimSlackText(payload.clientOrg, 160);
  const department = trimSlackText(payload.department, 120);
  const managerName = trimSlackText(payload.managerName, 120);
  const teamName = trimSlackText(payload.teamName, 120);
  const actorId = trimSlackText(context.actorId, 120);
  const actorEmail = trimSlackText(context.actorEmail, 160);
  const tenantId = trimSlackText(context.tenantId, 120);
  const projectId = trimSlackText(payload.id, 120);
  const purpose = trimSlackText(payload.projectPurpose || payload.description, 280);
  const financialInputFlags = payload.financialInputFlags && typeof payload.financialInputFlags === 'object'
    ? payload.financialInputFlags
    : {};
  const lines = [
    '*[InnerPlatform] 프로젝트 등록 완료*',
    `프로젝트명: \`${projectName}\``,
    `공식 계약명: ${officialContractName}`,
    `계약 대상: ${clientOrg}`,
    `담당조직(CIC): ${department}`,
    `프로젝트 유형: ${formatProjectTypeSlackLabel(payload.type)}`,
    `PM: ${managerName}`,
    `팀/인력: ${teamName}`,
    `계약 기간: ${formatProjectPeriod(payload.contractStart, payload.contractEnd)}`,
    `계약금액: ${formatOptionalProjectAmount(payload.contractAmount, financialInputFlags.contractAmount)}`,
    `프로젝트 목적: ${purpose}`,
    `등록자: ${actorId} (${actorEmail})`,
    `tenantId: \`${tenantId}\``,
    `projectId: \`${projectId}\``,
  ];

  return {
    text: `[InnerPlatform] 프로젝트 등록 완료: ${projectName}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: lines.join('\n'),
        },
      },
    ],
  };
}

function formatExecutiveReviewSlackLabel(status) {
  if (status === 'PLANNING_AGREED') return '경영기획실 합의 완료';
  if (status === 'APPROVED') return '승인 완료';
  if (status === 'REVISION_REJECTED') return '수정 요청 후 반려';
  if (status === 'DUPLICATE_DISCARDED') return '중복·폐기';
  return '검토 대기';
}

function buildProjectExecutiveReviewSlackPayload({ project, projectRequest, reviewStatus, reviewComment, reviewerName }) {
  const payload = project && typeof project === 'object' ? project : {};
  const requestPayload = projectRequest?.payload && typeof projectRequest.payload === 'object'
    ? projectRequest.payload
    : {};
  const projectName = trimSlackText(payload.name || requestPayload.name, 120);
  const officialContractName = trimSlackText(payload.officialContractName || requestPayload.officialContractName, 220);
  const clientOrg = trimSlackText(payload.clientOrg || requestPayload.clientOrg, 160);
  const department = trimSlackText(payload.department || requestPayload.department, 120);
  const requester = trimSlackText(projectRequest?.requestedByName, 120);
  const requestId = trimSlackText(projectRequest?.id, 120);
  const projectId = trimSlackText(payload.id, 120);
  const projectCode = trimSlackText(payload.projectCode, 120);
  const decisionLabel = formatExecutiveReviewSlackLabel(reviewStatus);
  const reason = trimSlackText(reviewComment, 280);
  const reviewer = trimSlackText(reviewerName, 120);
  const lines = [
    '*[InnerPlatform] 프로젝트 등록 처리 결과*',
    `프로젝트명: \`${projectName}\``,
    `프로젝트 코드: ${projectCode}`,
    `공식 계약명: ${officialContractName}`,
    `계약 대상: ${clientOrg}`,
    `담당조직(CIC): ${department}`,
    `결정: ${decisionLabel}`,
    `사유: ${reason}`,
    `검토자: ${reviewer}`,
    `요청자: ${requester}`,
    `requestId: \`${requestId}\``,
    `projectId: \`${projectId}\``,
  ];

  return {
    text: `[InnerPlatform] 프로젝트 등록 처리 결과: ${decisionLabel} · ${projectName}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: lines.join('\n'),
        },
      },
    ],
  };
}

function buildProjectCodeRegisteredSlackPayload({ project, projectRequest, projectCode, reviewerName }) {
  const payload = project && typeof project === 'object' ? project : {};
  const requestPayload = projectRequest?.payload && typeof projectRequest.payload === 'object'
    ? projectRequest.payload
    : {};
  const projectName = trimSlackText(payload.name || requestPayload.name, 120);
  const officialContractName = trimSlackText(payload.officialContractName || requestPayload.officialContractName, 220);
  const clientOrg = trimSlackText(payload.clientOrg || requestPayload.clientOrg, 160);
  const department = trimSlackText(payload.department || requestPayload.department, 120);
  const requester = trimSlackText(projectRequest?.requestedByName, 120);
  const requestId = trimSlackText(projectRequest?.id, 120);
  const projectId = trimSlackText(payload.id, 120);
  const code = trimSlackText(projectCode || payload.projectCode, 120);
  const reviewer = trimSlackText(reviewerName, 120);
  const lines = [
    '*[InnerPlatform] 프로젝트 코드 등록 완료*',
    `프로젝트명: \`${projectName}\``,
    `프로젝트 코드: ${code}`,
    `공식 계약명: ${officialContractName}`,
    `계약 대상: ${clientOrg}`,
    `담당조직(CIC): ${department}`,
    `처리자: ${reviewer}`,
    `요청자: ${requester}`,
    `requestId: \`${requestId}\``,
    `projectId: \`${projectId}\``,
  ];

  return {
    text: `[InnerPlatform] 프로젝트 코드 등록 완료: ${code} · ${projectName}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }],
  };
}

function assertProjectRequestMatchesProject(request, projectId) {
  const normalizedProjectId = readOptionalText(projectId);
  const requestProjectIds = [request?.approvedProjectId, request?.targetProjectId]
    .map(readOptionalText)
    .filter(Boolean);
  if (
    !normalizedProjectId
    || requestProjectIds.length === 0
    || requestProjectIds.some((requestProjectId) => requestProjectId !== normalizedProjectId)
  ) {
    const requestProjectId = requestProjectIds.join(', ') || '(missing)';
    throw createHttpError(
      409,
      `Project request does not belong to project: ${requestProjectId} != ${normalizedProjectId}`,
      'request_project_mismatch',
    );
  }
}

export async function resolveProjectRequestDocuments({ db, tenantId, requestId, projectId }) {
  const refs = [];
  const requestSnapshots = [];

  let request = null;
  let resolvedRequestId = readOptionalText(requestId);

  if (resolvedRequestId) {
    for (const collectionName of ['project_requests', 'projectRequests']) {
      const ref = db.doc(`orgs/${tenantId}/${collectionName}/${resolvedRequestId}`);
      const snap = await ref.get();
      refs.push(ref);
      requestSnapshots.push(snap.exists ? stableStringify(snap.data() || {}) : null);
      if (snap.exists) {
        request = request || { ...(snap.data() || {}), id: ref.id || resolvedRequestId };
      }
    }
    if (!request) {
      throw createHttpError(404, `Project request not found: ${resolvedRequestId}`, 'not_found');
    }
    assertProjectRequestMatchesProject(request, projectId);
    return { request, requestId: resolvedRequestId, refs, requestSnapshots };
  }

  const requests = await queryProjectRequestsByProjectIds({ db, tenantId, projectIds: [projectId] });
  if (requests.length) {
    return resolveProjectRequestDocuments({ db, tenantId, requestId: requests[0].id, projectId });
  }
  return { request: null, requestId: null, refs, requestSnapshots };
}

export async function mergeProjectAndRequestDocs({
  db,
  projectPath,
  buildProjectPatch,
  buildRequestPatch,
  requestRefs,
  requestSnapshots,
  enforceChangeRequestVersion = false,
  writeProject = true,
  tenantId,
  actorId,
  now,
  notFoundMessage,
  stageTransactionWrites,
}) {
  const projectRef = db.doc(projectPath);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(projectRef);
    if (!snap.exists) throw createHttpError(404, notFoundMessage || `Document not found: ${projectPath}`, 'not_found');

    const resolvedRequestRefs = Array.isArray(requestRefs) ? requestRefs : [];
    const requestSnaps = await Promise.all(resolvedRequestRefs.map((ref) => tx.get(ref)));
    const existingRequestIndexes = requestSnaps.flatMap((requestSnap, index) => requestSnap.exists ? [index] : []);
    if ((enforceChangeRequestVersion || requestSnapshots) && existingRequestIndexes.length > 1) {
      throw createHttpError(409, 'Duplicate project request collections must be reconciled', 'request_collection_conflict');
    }
    if (requestSnapshots && requestSnaps.some((requestSnap, index) => (
      (requestSnap.exists ? stableStringify(requestSnap.data() || {}) : null) !== requestSnapshots[index]
    ))) {
      throw createHttpError(409, 'Project request changed before approval', 'canonical_version_conflict');
    }
    const currentRequestIndex = existingRequestIndexes[0] ?? -1;
    const currentRequestSnap = currentRequestIndex >= 0 ? requestSnaps[currentRequestIndex] : null;
    const currentRequestRef = currentRequestIndex >= 0 ? resolvedRequestRefs[currentRequestIndex] : null;
    const currentRequest = currentRequestSnap
      ? { ...(currentRequestSnap.data() || {}), id: currentRequestRef.id || currentRequestRef.path.split('/').at(-1) }
      : null;

    const current = snap.data() || {};
    const currentVersion = Number.isInteger(current.version) && current.version > 0 ? current.version : 1;
    const nextVersion = currentVersion + 1;
    if (enforceChangeRequestVersion && resolvedRequestRefs.length > 0 && !currentRequest) {
      throw createHttpError(409, 'Project request changed before approval', 'canonical_version_conflict');
    }
    if (enforceChangeRequestVersion && isProjectChangeRequest(currentRequest)) {
      const baseProjectVersion = Number(currentRequest.baseProjectVersion);
      const targetProjectVersion = Number(currentRequest.targetProjectVersion);
      if (
        readOptionalText(currentRequest.status) !== 'PENDING'
        || !Number.isSafeInteger(baseProjectVersion)
        || baseProjectVersion < 1
        || !Number.isSafeInteger(targetProjectVersion)
        || targetProjectVersion !== baseProjectVersion + 1
        || baseProjectVersion !== currentVersion
        || targetProjectVersion !== nextVersion
      ) {
        throw createHttpError(
          409,
          `Canonical version mismatch: request ${baseProjectVersion}->${targetProjectVersion}, actual ${currentVersion}`,
          'canonical_version_conflict',
        );
      }
    }
    const projectPatch = await buildProjectPatch(current, currentRequest, nextVersion, tx);
    const document = writeProject
      ? {
          ...current, ...projectPatch, tenantId, version: nextVersion,
          createdBy: current.createdBy || actorId, createdAt: current.createdAt || now,
          updatedBy: actorId, updatedAt: now,
        }
      : current;
    const sanitizedProject = stripUndefinedDeep(document);

    const requestPatch = buildRequestPatch?.(current, currentRequest, nextVersion) || null;
    const sanitizedRequestPatch = requestPatch ? stripUndefinedDeep(requestPatch) : null;
    if (writeProject && typeof stageTransactionWrites === 'function') {
      await stageTransactionWrites({
        tx,
        document: sanitizedProject,
        current,
        currentRequest,
        requestPatch: sanitizedRequestPatch,
      });
    }

    if (writeProject) tx.set(projectRef, sanitizedProject, { merge: true });
    if (requestPatch && currentRequestRef) {
      tx.set(currentRequestRef, sanitizedRequestPatch, { merge: true });
    }

    return {
      version: writeProject ? nextVersion : currentVersion,
      data: sanitizedProject,
      request: currentRequest,
    };
  });
}

export async function readProjectRequestById(db, tenantId, requestId) {
  const normalizedRequestId = readOptionalText(requestId);
  if (!normalizedRequestId) return null;
  for (const collectionName of ['project_requests', 'projectRequests']) {
    const snap = await db.doc(`orgs/${tenantId}/${collectionName}/${normalizedRequestId}`).get();
    if (snap.exists) {
      return { ...(snap.data() || {}), id: normalizedRequestId };
    }
  }
  return null;
}

function formatProjectRequestTeamMember(member) {
  const name = readOptionalText(member?.memberName);
  const nickname = readOptionalText(member?.memberNickname);
  const role = readOptionalText(member?.role);
  const participationRate = Number.isFinite(Number(member?.participationRate))
    ? Math.max(0, Math.round(Number(member.participationRate)))
    : 0;
  const laborAllocationStartMonth = normalizeMonth(member?.laborAllocationStartMonth);
  const laborAllocationEndMonth = normalizeMonth(member?.laborAllocationEndMonth);
  const identity = nickname || name || '-';
  const rolePart = role ? ` · ${role}` : '';
  const ratePart = participationRate > 0 ? ` · ${participationRate}%` : '';
  const periodPart = laborAllocationStartMonth || laborAllocationEndMonth
    ? ` · 인건비 ${laborAllocationStartMonth || '-'}~${laborAllocationEndMonth || '-'}`
    : '';
  const documentOnlyPart = typeof member?.isDocumentOnly === 'boolean'
    ? ` · ${member.isDocumentOnly ? '서류상 인력' : '실제 참여'}`
    : '';
  return `${identity}${rolePart}${ratePart}${periodPart}${documentOnlyPart}`;
}

function normalizeProjectContractType(value) {
  const text = readOptionalText(value);
  if (!text) return '계약서(날인)';
  if (text === '계약서') return '계약서(날인)';
  if (text === '협약서') return '협약서(날인)';
  if (text === '발주기관 전자시스템') return '전자계약 시스템';
  if (text === '일반') return '기타';
  return text;
}

function normalizeProjectStatus(value) {
  return ['CONTRACT_PENDING', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED_PENDING_PAYMENT'].includes(value)
    ? value
    : 'CONTRACT_PENDING';
}

function normalizeProjectPhase(value) {
  return value === 'PROSPECT' || value === 'CONFIRMED' ? value : 'CONFIRMED';
}

function decodeCheckoutBase64(value, expectedSize) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw createHttpError(400, 'contentBase64 is invalid', 'checkout_attachment_invalid');
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.byteLength !== expectedSize) {
    throw createHttpError(422, 'Attachment size does not match its content', 'checkout_attachment_size_mismatch');
  }
  return buffer;
}

async function readProjectAttachmentMember({ db, tenantId, actorId, tx }) {
  const normalizedActorId = readOptionalText(actorId);
  if (!normalizedActorId || normalizedActorId.includes('/')) {
    throw createHttpError(403, 'Project attachment access denied', 'forbidden');
  }
  const memberRef = db.doc(`orgs/${tenantId}/members/${normalizedActorId}`);
  const memberSnap = tx ? await tx.get(memberRef) : await memberRef.get();
  const member = memberSnap.exists ? (memberSnap.data() || {}) : null;
  if (
    !member
    || readOptionalText(member.uid) !== normalizedActorId
    || readOptionalText(member.status).toUpperCase() !== 'ACTIVE'
  ) {
    throw createHttpError(403, 'Project attachment access denied', 'forbidden');
  }
  return member;
}

function hasProjectRequestAccess({ actorId, member, projectId, project }) {
  const profile = member?.portalProfile && typeof member.portalProfile === 'object'
    ? member.portalProfile
    : {};
  const assignedProjectIds = new Set([
    member?.projectId,
    ...(Array.isArray(member?.projectIds) ? member.projectIds : []),
    profile.projectId,
    ...(Array.isArray(profile.projectIds) ? profile.projectIds : []),
  ].map(readOptionalText).filter(Boolean));
  return ['admin', 'finance'].includes(normalizeRole(member?.role))
    || assignedProjectIds.has(readOptionalText(projectId))
    || [
      project?.createdBy,
      project?.registeredById,
      project?.managerId,
      project?.executiveApproverId,
    ].map(readOptionalText).includes(readOptionalText(actorId));
}

function sortProjectRequests(requests) {
  return requests.sort((left, right) => (
    String(right.requestedAt || '').localeCompare(String(left.requestedAt || ''))
    || String(left.id).localeCompare(String(right.id))
  ));
}

const PROJECT_REQUEST_QUERY_LIMIT = 500;

function getBoundedProjectRequestSnapshot(query) {
  return query.limit(PROJECT_REQUEST_QUERY_LIMIT).get();
}

function parseProjectRequestQueryProjectIds(value) {
  const projectIds = Array.isArray(value)
    ? Array.from(new Set(value.map(readOptionalText).filter(Boolean)))
    : [];
  if (projectIds.length > 200 || projectIds.some((projectId) => projectId.includes('/'))) {
    throw createHttpError(400, 'Project request query is invalid', 'project_request_query_invalid');
  }
  return projectIds;
}

async function preferCanonicalProjectRequests({ db, tenantId, canonicalRequests, legacyRequests }) {
  const unprobedLegacyIds = Array.from(legacyRequests.keys()).filter((id) => !canonicalRequests.has(id));
  const canonicalProbes = await Promise.all(unprobedLegacyIds.map(async (id) => {
    const snap = await db.doc(`orgs/${tenantId}/project_requests/${id}`).get();
    return snap.exists ? [id, { ...(snap.data() || {}), id }] : null;
  }));
  canonicalProbes.forEach((entry) => {
    if (entry) canonicalRequests.set(entry[0], entry[1]);
  });
  return sortProjectRequests(Array.from(new Set([
    ...canonicalRequests.keys(),
    ...legacyRequests.keys(),
  ])).map((id) => canonicalRequests.get(id) || legacyRequests.get(id)));
}

async function queryProjectRequestsByProjectIds({ db, tenantId, projectIds }) {
  const normalizedProjectIds = Array.from(new Set((Array.isArray(projectIds) ? projectIds : [])
    .map(readOptionalText)
    .filter((projectId) => projectId && !projectId.includes('/'))));
  if (!normalizedProjectIds.length) return [];
  const projectIdChunks = [];
  for (let index = 0; index < normalizedProjectIds.length; index += 30) {
    projectIdChunks.push(normalizedProjectIds.slice(index, index + 30));
  }
  const queryCollection = async (collectionName) => {
    const collectionRef = db.collection(`orgs/${tenantId}/${collectionName}`);
    const snapshots = await Promise.all(projectIdChunks.flatMap((projectIdChunk) => [
      getBoundedProjectRequestSnapshot(collectionRef.where('approvedProjectId', 'in', projectIdChunk)),
      getBoundedProjectRequestSnapshot(collectionRef.where('targetProjectId', 'in', projectIdChunk)),
    ]));
    const rows = new Map();
    snapshots.forEach((snapshot) => {
      snapshot.docs.forEach((doc) => rows.set(doc.id, { ...(doc.data() || {}), id: doc.id }));
    });
    return rows;
  };
  const [canonicalRequests, legacyRequests] = await Promise.all([
    queryCollection('project_requests'),
    queryCollection('projectRequests'),
  ]);
  const requests = await preferCanonicalProjectRequests({ db, tenantId, canonicalRequests, legacyRequests });
  const requestedProjectIds = new Set(normalizedProjectIds);
  return requests.filter((request) => [request.approvedProjectId, request.targetProjectId]
    .map(readOptionalText)
    .some((projectId) => requestedProjectIds.has(projectId)));
}

async function readPendingProjectChangeRequests({ db, tenantId, actorId, projectIds }) {
  const member = await readProjectAttachmentMember({ db, tenantId, actorId });
  if (!['admin', 'finance'].includes(normalizeRole(member?.role))) {
    const projectSnapshots = await Promise.all(projectIds.map((projectId) => (
      db.doc(`orgs/${tenantId}/projects/${projectId}`).get()
    )));
    if (projectSnapshots.some((snapshot, index) => (
      !snapshot.exists
      || !hasProjectRequestAccess({
        actorId,
        member,
        projectId: projectIds[index],
        project: snapshot.data() || {},
      })
    ))) {
      throw createHttpError(403, 'Project request access denied', 'forbidden');
    }
  }
  const requests = await queryProjectRequestsByProjectIds({ db, tenantId, projectIds });
  return requests
    .filter((request) => readOptionalText(request.requestKind) === 'CHANGE'
      && readOptionalText(request.status) === 'PENDING')
    .map((request) => ({
      id: request.id,
      requestKind: 'CHANGE',
      targetProjectId: readOptionalText(request.targetProjectId) || null,
      approvedProjectId: readOptionalText(request.approvedProjectId) || null,
      status: 'PENDING',
      requestedAt: readOptionalText(request.requestedAt) || null,
      baseProjectVersion: Number.isInteger(request.baseProjectVersion) ? request.baseProjectVersion : null,
      targetProjectVersion: Number.isInteger(request.targetProjectVersion) ? request.targetProjectVersion : null,
    }));
}

async function readAssignedProjectRequests({ db, tenantId, actorId }) {
  await readProjectAttachmentMember({ db, tenantId, actorId });
  const normalizedActorId = readOptionalText(actorId);
  const assignedProjects = await db.collection(`orgs/${tenantId}/projects`)
    .where('executiveApproverId', '==', normalizedActorId)
    .get();
  const assignedProjectIds = new Set(assignedProjects.docs.map((doc) => doc.id));
  const projectIdChunks = [];
  const projectIds = Array.from(assignedProjectIds);
  for (let index = 0; index < projectIds.length; index += 30) {
    projectIdChunks.push(projectIds.slice(index, index + 30));
  }

  const queryCollection = async (collectionName) => {
    const collectionRef = db.collection(`orgs/${tenantId}/${collectionName}`);
    const queries = [
      collectionRef.where('payload.executiveApproverId', '==', normalizedActorId),
      collectionRef.where('proposedSnapshot.executiveApproverId', '==', normalizedActorId),
      ...projectIdChunks.flatMap((projectIdChunk) => [
        collectionRef.where('approvedProjectId', 'in', projectIdChunk),
        collectionRef.where('targetProjectId', 'in', projectIdChunk),
      ]),
    ];
    const snapshots = await Promise.all(queries.map(getBoundedProjectRequestSnapshot));
    const rows = new Map();
    snapshots.forEach((snapshot) => {
      snapshot.docs.forEach((doc) => rows.set(doc.id, { ...(doc.data() || {}), id: doc.id }));
    });
    return rows;
  };

  const [canonicalRequests, legacyRequests] = await Promise.all([
    queryCollection('project_requests'),
    queryCollection('projectRequests'),
  ]);
  const projectRequests = await preferCanonicalProjectRequests({
    db,
    tenantId,
    canonicalRequests,
    legacyRequests,
  });
  const isAssignedRequest = (projectRequest) => {
    const payload = resolveProjectRequestPayloadForReview(projectRequest);
    const requestApproverId = readOptionalText(payload?.executiveApproverId);
    if (requestApproverId) return requestApproverId === normalizedActorId;
    if (projectRequestRequiresDesignatedApprover(projectRequest)) return false;
    const projectId = readOptionalText(projectRequest.targetProjectId || projectRequest.approvedProjectId);
    return assignedProjectIds.has(projectId);
  };
  const assigned = projectRequests.filter(isAssignedRequest);

  const projectRequestsForLatest = await queryProjectRequestsByProjectIds({
    db,
    tenantId,
    projectIds: projectRequests.map((projectRequest) => projectRequest.targetProjectId || projectRequest.approvedProjectId),
  });
  const latestRequests = new Map();
  projectRequestsForLatest.forEach((projectRequest) => {
    const projectId = readOptionalText(projectRequest.targetProjectId || projectRequest.approvedProjectId);
    if (projectId && !latestRequests.has(projectId)) latestRequests.set(projectId, projectRequest);
  });
  const inaccessibleProjectIds = new Set(Array.from(latestRequests.entries())
    .filter(([, projectRequest]) => !isAssignedRequest(projectRequest))
    .map(([projectId]) => projectId));
  const items = sortProjectRequests(assigned
    .filter((projectRequest) => !inaccessibleProjectIds.has(readOptionalText(projectRequest.targetProjectId || projectRequest.approvedProjectId)))
    .map((projectRequest) => projectRequestForReview(projectRequest, tenantId)));
  const projects = new Map(assignedProjects.docs.map((doc) => [
    doc.id,
    { id: doc.id, ...(doc.data() || {}) },
  ]));
  inaccessibleProjectIds.forEach((projectId) => projects.delete(projectId));
  const missingProjectIds = Array.from(new Set(items
    .map((item) => readOptionalText(item.targetProjectId || item.approvedProjectId))
    .filter((projectId) => projectId && !projects.has(projectId))));
  const missingProjectSnapshots = await Promise.all(missingProjectIds.map((projectId) => (
    db.doc(`orgs/${tenantId}/projects/${projectId}`).get()
  )));
  missingProjectSnapshots.forEach((snapshot, index) => {
    if (snapshot.exists) {
      const projectId = missingProjectIds[index];
      projects.set(projectId, { id: projectId, ...(snapshot.data() || {}) });
    }
  });

  return {
    items,
    projects: Array.from(projects.values()).sort((left, right) => String(left.id).localeCompare(String(right.id))),
  };
}

function sendPrivateProjectAttachment(res, downloaded, attachment, objectName) {
  const buffer = Buffer.isBuffer(downloaded?.buffer)
    ? downloaded.buffer
    : Buffer.from(downloaded?.buffer || []);
  const fileName = readOptionalText(attachment?.name) || objectName;
  const contentType = readOptionalText(downloaded?.contentType);
  res.setHeader('content-type', /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(contentType)
    ? contentType
    : 'application/octet-stream');
  res.setHeader('content-length', String(buffer.byteLength));
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.status(200).send(buffer);
}

function normalizeProjectType(value) {
  return ['C1', 'A1', 'A2', 'I1', 'I2', 'I3', 'D1', 'S1', 'S2', 'E1', 'P1', 'Z1'].includes(value)
    ? value
    : 'D1';
}

const REGISTRATION_PROJECT_TYPES = new Set(['C1', 'A1', 'A2', 'I1', 'I2', 'I3', 'D1', 'S1', 'S2', 'E1', 'P1', 'Z1']);
const REGISTRATION_REQUIRED_DOCUMENT_KINDS = PROJECT_REGISTRATION_REQUIRED_DOCUMENT_KINDS;
const PRIVATE_DOCUMENT_KINDS = PROJECT_INFO_DOCUMENT_KINDS;
const REGISTRATION_AMOUNT_FIELDS = ['contractAmount', 'salesVatAmount', 'totalRevenueAmount', 'totalActualCost', 'supportAmount'];
const REGISTRATION_PAYMENT_FIELDS = ['contract', 'interim', 'final'];
const REGISTRATION_FINANCIAL_FLAG_FIELDS = ['contractAmount', 'salesVatAmount', 'totalRevenueAmount', 'totalActualCost', 'supportAmount'];
const REGISTRATION_SETTLEMENT_TYPES = new Set(['TYPE1', 'TYPE2', 'TYPE3', 'TYPE4', 'TYPE5', 'NONE']);
const REGISTRATION_INTEREST_REFUND_POLICIES = new Set([
  'REFUND', 'USE_AS_PROJECT_EXPENSE', 'MYSC_REVENUE', 'REVIEW_LATER',
]);
const REGISTRATION_SETTLEMENT_BASES = new Set([
  'SUPPLY_AMOUNT', '공급가액', 'SUPPLY_PRICE', '공급대가', 'OTHER', '기타', 'NONE',
]);
const REGISTRATION_V2_SETTLEMENT_BASES = new Set([
  'SUPPLY_AMOUNT', '공급가액', 'SUPPLY_PRICE', '공급대가', 'NONE',
]);
const REGISTRATION_ACCOUNT_TYPES = new Set(['DEDICATED', 'OPERATING', 'NONE', 'OTHER']);
const LABOR_SETTLEMENT_BASES = new Set([
  'INCLUDE_ACTUAL_SALARY', 'EXCLUDE_ACTUAL_SALARY', 'FIXED_AMOUNT', 'NONE',
]);
const PROJECT_TEAM_MEMBER_ROLES = new Set([
  '총괄책임자', '실무책임자', '운영매니저', '정산지원', '사업 최종 책임자',
]);

function invalidRegistration(message) {
  throw createHttpError(422, message, 'project_registration_invalid');
}

function isRealIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function assertRegistrationAmount(value, fieldName, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) invalidRegistration(`Project registration ${fieldName} is required`);
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    invalidRegistration(`Project registration ${fieldName} must be a non-negative integer`);
  }
}

function assertRegistrationFinancials(payload, type) {
  for (const field of REGISTRATION_AMOUNT_FIELDS) {
    assertRegistrationAmount(payload[field], field, { required: field === 'contractAmount' && type !== 'I1' });
  }

  if (payload.paymentPlan !== undefined && payload.paymentPlan !== null) {
    if (typeof payload.paymentPlan !== 'object' || Array.isArray(payload.paymentPlan)) {
      invalidRegistration('Project registration paymentPlan is invalid');
    }
    for (const field of REGISTRATION_PAYMENT_FIELDS) {
      assertRegistrationAmount(payload.paymentPlan[field], `paymentPlan.${field}`, { required: true });
    }
  }
  if (payload.laborTransferPlan !== undefined && payload.laborTransferPlan !== null) {
    if (typeof payload.laborTransferPlan !== 'object' || Array.isArray(payload.laborTransferPlan)) {
      invalidRegistration('Project registration laborTransferPlan is invalid');
    }
    if (!['UNDECIDED', 'MONTHLY_WEEK_3', 'PAYMENT_MILESTONE'].includes(readOptionalText(payload.laborTransferPlan.mode))) {
      invalidRegistration('Project registration laborTransferPlan.mode is invalid');
    }
    if (!payload.laborTransferPlan.milestoneAmounts || typeof payload.laborTransferPlan.milestoneAmounts !== 'object') {
      invalidRegistration('Project registration laborTransferPlan.milestoneAmounts is invalid');
    }
    for (const field of REGISTRATION_PAYMENT_FIELDS) {
      assertRegistrationAmount(payload.laborTransferPlan.milestoneAmounts[field], `laborTransferPlan.milestoneAmounts.${field}`, { required: true });
    }
  }

  if (payload.financialInputFlags !== undefined && payload.financialInputFlags !== null) {
    if (typeof payload.financialInputFlags !== 'object' || Array.isArray(payload.financialInputFlags)) {
      invalidRegistration('Project registration financialInputFlags is invalid');
    }
    for (const field of REGISTRATION_FINANCIAL_FLAG_FIELDS) {
      if (
        Object.prototype.hasOwnProperty.call(payload.financialInputFlags, field)
        && typeof payload.financialInputFlags[field] !== 'boolean'
      ) {
        invalidRegistration(`Project registration financialInputFlags.${field} must be boolean`);
      }
    }
  }

  if (type !== 'I1') {
    const contractStart = readOptionalText(payload.contractStart);
    const contractEnd = readOptionalText(payload.contractEnd);
    // 종료 기간 없음(무기한)은 명시 플래그가 있을 때만 - 종료일이 함께 오면 모순이라 거부한다.
    if (payload.contractEndUndecided === true) {
      if (!isRealIsoDate(contractStart) || contractEnd) {
        invalidRegistration('Project registration contract dates are invalid');
      }
    } else if (!isRealIsoDate(contractStart) || !isRealIsoDate(contractEnd) || contractStart > contractEnd) {
      invalidRegistration('Project registration contract dates are invalid');
    }
  }
}

function assertRegistrationTeamMembers(value, {
  participationSheetLinked = false,
  contractStartMonth = '',
  contractEndMonth = '',
} = {}) {
  if (!Array.isArray(value)) invalidRegistration('Project registration teamMembersDetailed is invalid');
  value.forEach((member, index) => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) {
      invalidRegistration(`Project registration teamMembersDetailed.${index} is invalid`);
    }
    const isSheetBacked = Object.hasOwn(member, 'monthlyRates');
    if (!isSheetBacked && !readOptionalText(member.memberName)) {
      invalidRegistration(`Project registration teamMembersDetailed.${index}.memberName is required`);
    }
    if (isSheetBacked && ![
      member.personId,
      member.memberName,
      member.memberNickname,
    ].some(readOptionalText)) {
      invalidRegistration(`Project registration teamMembersDetailed.${index} identity is required`);
    }
    if (!isSheetBacked && !PROJECT_TEAM_MEMBER_ROLES.has(readOptionalText(member.role))) {
      invalidRegistration(`Project registration teamMembersDetailed.${index}.role is invalid`);
    }
    if (
      typeof member.participationRate !== 'number'
      || !Number.isFinite(member.participationRate)
      || member.participationRate < 0
      || member.participationRate > 100
    ) {
      invalidRegistration(`Project registration teamMembersDetailed.${index}.participationRate is invalid`);
    }
    if (member.isDocumentOnly !== undefined && typeof member.isDocumentOnly !== 'boolean') {
      invalidRegistration(`Project registration teamMembersDetailed.${index}.isDocumentOnly is invalid`);
    }
    for (const field of ['laborAllocationStartMonth', 'laborAllocationEndMonth']) {
      if (member[field] && !normalizeExpectedMonth(member[field])) {
        invalidRegistration(`Project registration teamMembersDetailed.${index}.${field} is invalid`);
      }
    }
    if (
      member.laborAllocationStartMonth
      && member.laborAllocationEndMonth
      && member.laborAllocationStartMonth > member.laborAllocationEndMonth
    ) {
      invalidRegistration(`Project registration teamMembersDetailed.${index} labor allocation period is invalid`);
    }
    if (isSheetBacked) {
      normalizeProjectTeamMemberMonthlyRates(member, index, { contractStartMonth, contractEndMonth });
    }
  });
  const isEntirelySheetBacked = participationSheetLinked
    && value.every((member) => Object.hasOwn(member || {}, 'monthlyRates'));
  if (!isEntirelySheetBacked && !value.some((member) => readOptionalText(member?.role) === '운영매니저')) {
    invalidRegistration('Project registration requires at least one operating manager');
  }
  const invalidSettlementSupport = value.some((member) => {
    if (Object.hasOwn(member || {}, 'monthlyRates')) return false;
    if (readOptionalText(member?.role) !== '정산지원') return false;
    const memberName = readOptionalText(member?.memberName);
    const memberNickname = readOptionalText(member?.memberNickname);
    const allowed = ['송성미', '최지윤'].includes(memberName) || ['도담', '써니'].includes(memberNickname);
    return !allowed;
  });
  if (invalidSettlementSupport) {
    invalidRegistration('Project registration settlement support must be 도담 or 써니');
  }
}

function assertParticipationSheetLinkForTeamMembers(
  teamMembers,
  participationSheetLink,
  { required = false } = {},
) {
  const sheetBackedRows = (Array.isArray(teamMembers) ? teamMembers : [])
    .filter((member) => Object.hasOwn(member || {}, 'monthlyRates'));
  const containsSheetBackedRows = sheetBackedRows.length > 0;
  if ((required || containsSheetBackedRows) && !readOptionalText(participationSheetLink)) {
    invalidRegistration('Project registration participationSheetLink is required for sheet-backed team members');
  }
  for (const [index, member] of sheetBackedRows.entries()) {
    if (![member?.personId, member?.memberName, member?.memberNickname].some(readOptionalText)) {
      invalidRegistration(`Project registration sheet-backed team member ${index} identity is required`);
    }
  }
  const monthOwners = new Map();
  for (const [index, member] of sheetBackedRows.entries()) {
    const monthlyRates = member?.monthlyRates;
    if (!monthlyRates || typeof monthlyRates !== 'object' || Array.isArray(monthlyRates)) continue;
    const personId = readOptionalText(member?.personId);
    const nickname = readOptionalText(member?.memberNickname);
    const name = readOptionalText(member?.memberName);
    const placeholderNickname = ['미정', '채용예정'].some((prefix) => nickname.startsWith(prefix));
    const sheetIdentity = placeholderNickname && name ? name : (nickname || name);
    const normalizedSheetIdentity = normalizeSyncKeySegment(sheetIdentity);
    for (const yearMonth of Object.keys(monthlyRates)) {
      const owners = monthOwners.get(yearMonth) || [];
      const rate = monthlyRates[yearMonth];
      const duplicate = rate !== null && owners.some((owner) => (
        owner.rate !== null
        && (owner.personId && personId
          ? owner.personId === personId
          : owner.sheetIdentity === normalizedSheetIdentity)
      ));
      if (duplicate) {
        invalidRegistration(
          `Project registration duplicate monthlyRates ownership for ${yearMonth}`,
        );
      }
      owners.push({ index, personId, sheetIdentity: normalizedSheetIdentity, rate });
      monthOwners.set(yearMonth, owners);
    }
  }
}

function assertRegistrationV2PaymentPlan(payload) {
  const paymentPlan = payload.paymentPlan && typeof payload.paymentPlan === 'object'
    ? payload.paymentPlan
    : {};
  const expectedMonths = payload.paymentExpectedMonths;
  if (expectedMonths !== undefined && (!expectedMonths || typeof expectedMonths !== 'object' || Array.isArray(expectedMonths))) {
    invalidRegistration('Project registration paymentExpectedMonths is invalid');
  }
  for (const field of REGISTRATION_PAYMENT_FIELDS) {
    if (registrationAmount(paymentPlan[field]) > 0 && !normalizeExpectedMonth(expectedMonths?.[field])) {
      invalidRegistration(`Project registration paymentExpectedMonths.${field} is required`);
    }
  }
  const contractAmount = registrationAmount(payload.contractAmount);
  const paymentTotal = REGISTRATION_PAYMENT_FIELDS.reduce(
    (sum, field) => sum + registrationAmount(paymentPlan[field]),
    0,
  );
  const advanceAndInterim = registrationAmount(paymentPlan.contract) + registrationAmount(paymentPlan.interim);
  if (
    contractAmount > 0
    && paymentTotal > 0
    && advanceAndInterim / contractAmount < 0.7
    && !readOptionalText(payload.advanceInterimBelow70Reason)
  ) {
    invalidRegistration('Project registration advance/interim below 70% reason is required');
  }
}

function registrationAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
}

function normalizeLaborSettlementBasis(value) {
  const normalized = readOptionalText(value);
  return LABOR_SETTLEMENT_BASES.has(normalized) ? normalized : 'NONE';
}

function normalizeExpectedMonth(value) {
  const normalized = readOptionalText(value);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(normalized) ? normalized : '';
}

function normalizePaymentExpectedMonths(value) {
  return {
    contract: normalizeExpectedMonth(value?.contract),
    interim: normalizeExpectedMonth(value?.interim),
    final: normalizeExpectedMonth(value?.final),
  };
}

function normalizeSettlementSystemOther(value) {
  return readOptionalText(value).replace(/\s+/g, ' ');
}

function assertProjectPaymentExtensions(payload) {
  const settlementSystem = readOptionalText(payload?.settlementSystem);
  const settlementSystemOther = normalizeSettlementSystemOther(payload?.settlementSystemOther);
  if (settlementSystem && !SETTLEMENT_SYSTEM_CODES.has(settlementSystem)) {
    invalidRegistration('Project registration settlementSystem is invalid');
  }
  if (settlementSystem === 'OTHER' && !settlementSystemOther) {
    invalidRegistration('Project registration settlementSystemOther is required');
  }
  if (settlementSystemOther.length > 100) {
    invalidRegistration('Project registration settlementSystemOther is too long');
  }
  if (!Array.isArray(payload?.financialYears)) return;
  for (const row of payload.financialYears) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.paymentExpectedMonths === undefined) continue;
    if (!row.paymentExpectedMonths || typeof row.paymentExpectedMonths !== 'object' || Array.isArray(row.paymentExpectedMonths)) {
      invalidRegistration('Project registration financialYears paymentExpectedMonths is invalid');
    }
    for (const field of REGISTRATION_PAYMENT_FIELDS) {
      const rawMonth = readOptionalText(row.paymentExpectedMonths[field]);
      if (rawMonth && !normalizeExpectedMonth(rawMonth)) {
        invalidRegistration(`Project registration financialYears.${row.year}.paymentExpectedMonths.${field} is invalid`);
      }
      if (registrationAmount(row.paymentPlan?.[field]) > 0 && !normalizeExpectedMonth(rawMonth)) {
        invalidRegistration(`Project registration financialYears.${row.year}.paymentExpectedMonths.${field} is required`);
      }
    }
  }
}

function normalizeLaborTransferPlan(_value) {
  return {
    mode: 'MONTHLY_WEEK_3',
    milestoneAmounts: {
      contract: 0,
      interim: 0,
      final: 0,
    },
  };
}

function registrationSlug(value, fallback) {
  return readOptionalText(value)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 50) || fallback;
}

function registrationFinancialInputFlags(value = {}, amounts = {}) {
  return {
    contractAmount: value?.contractAmount === true || registrationAmount(amounts.contractAmount) > 0,
    salesVatAmount: value?.salesVatAmount === true || registrationAmount(amounts.salesVatAmount) > 0,
    totalRevenueAmount: value?.totalRevenueAmount === true || registrationAmount(amounts.totalRevenueAmount) > 0,
    totalActualCost: value?.totalActualCost === true || registrationAmount(amounts.totalActualCost) > 0,
    supportAmount: value?.supportAmount === true || registrationAmount(amounts.supportAmount) > 0,
  };
}

function registrationSettlementSheetPolicy(value, fundInputMode) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const preset = ['STANDARD', 'DIRECT_ENTRY', 'BALANCE_TRACKING'].includes(source.preset)
    ? source.preset
    : (fundInputMode === 'DIRECT_ENTRY' ? 'DIRECT_ENTRY' : 'STANDARD');
  const boolean = (key, fallback) => typeof source[key] === 'boolean' ? source[key] : fallback;
  const defaultReadOnly = preset === 'BALANCE_TRACKING'
    ? ['balance', 'expenseAmount', 'bankAmount', 'vatIn']
    : (preset === 'DIRECT_ENTRY' ? ['balance'] : []);
  const readOnlyDerivedFields = Array.isArray(source.readOnlyDerivedFields)
    ? source.readOnlyDerivedFields.filter((field) => ['balance', 'expenseAmount', 'bankAmount', 'vatIn'].includes(field))
    : defaultReadOnly;
  return {
    preset,
    allowAdjustmentRows: boolean('allowAdjustmentRows', preset !== 'STANDARD'),
    allowRowDelete: boolean('allowRowDelete', preset !== 'BALANCE_TRACKING'),
    autoComputeBalance: boolean('autoComputeBalance', true),
    autoComputeExpenseFromBank: boolean('autoComputeExpenseFromBank', preset === 'STANDARD'),
    autoComputeBankFromExpense: boolean('autoComputeBankFromExpense', true),
    requireCounterparty: boolean('requireCounterparty', true),
    requireNoteForAdjustment: boolean('requireNoteForAdjustment', true),
    requireEvidenceBeforeSubmit: boolean('requireEvidenceBeforeSubmit', false),
    preserveExplicitZero: boolean('preserveExplicitZero', true),
    readOnlyDerivedFields: [...new Set(readOnlyDerivedFields)],
  };
}

function registrationPrivateDocuments(attachmentRefs) {
  const latest = new Map();
  for (const attachment of Array.isArray(attachmentRefs) ? attachmentRefs : []) {
    const documentKind = readOptionalText(attachment?.documentKind);
    const path = readOptionalText(attachment?.path);
    if (!PRIVATE_DOCUMENT_KINDS.includes(documentKind) || !path) continue;
    latest.set(documentKind, stripUndefinedDeep({
      documentKind,
      path,
      name: readOptionalText(attachment?.name),
      size: Number.isSafeInteger(attachment?.size) && attachment.size >= 0 ? attachment.size : 0,
      contentType: readOptionalText(attachment?.contentType),
      uploadedAt: readOptionalText(attachment?.uploadedAt),
      attachmentId: readOptionalText(attachment?.attachmentId),
      visibility: 'PRIVATE',
    }));
  }
  return Object.fromEntries(Object.entries(PROJECT_DOCUMENT_FIELD_BY_KIND).map(([kind, field]) => [field, latest.get(kind) || null]));
}

function registrationRequirementsVersion(value) {
  if (value === undefined || value === null || value === '') return 1;
  if (value === 1 || value === 2) return value;
  invalidRegistration('Project registration requirements version is unsupported');
}

function normalizeRegistrationFinancialYears(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const year = Number(row?.year);
    if (!Number.isSafeInteger(year) || year < 2000 || year > 2099) return [];
    const contractAmount = registrationAmount(row?.contractAmount);
    const totalRevenueAmount = registrationAmount(row?.totalRevenueAmount);
    return [{
      year,
      contractAmount,
      salesVatAmount: registrationAmount(row?.salesVatAmount),
      totalRevenueAmount,
      totalActualCost: registrationAmount(row?.totalActualCost),
      supportAmount: registrationAmount(row?.supportAmount),
      profitRate: contractAmount > 0 ? Math.min(1, totalRevenueAmount / contractAmount) : 0,
      confirmed: row?.confirmed === true,
      ...(row?.paymentPlan && typeof row.paymentPlan === 'object' && !Array.isArray(row.paymentPlan) ? {
        paymentPlan: {
          contract: registrationAmount(row.paymentPlan.contract),
          interim: registrationAmount(row.paymentPlan.interim),
          final: registrationAmount(row.paymentPlan.final),
        },
      } : {}),
      ...(row?.paymentExpectedMonths && typeof row.paymentExpectedMonths === 'object' && !Array.isArray(row.paymentExpectedMonths) ? {
        paymentExpectedMonths: normalizePaymentExpectedMonths(row.paymentExpectedMonths),
      } : {}),
      ...(Object.hasOwn(row || {}, 'advanceInterimBelow70Reason') ? {
        advanceInterimBelow70Reason: readOptionalText(row.advanceInterimBelow70Reason),
      } : {}),
      ...(typeof row?.isSettled === 'boolean' ? { isSettled: row.isSettled } : {}),
    }];
  });
}

function normalizeRegistrationConfirmations(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const driveUrl = (input, fieldName) => {
    const normalized = readOptionalText(input);
    if (!normalized) return '';
    try {
      const url = new URL(normalized);
      if ((url.protocol === 'http:' || url.protocol === 'https:')
        && (url.hostname === 'drive.google.com' || url.hostname === 'docs.google.com')) return normalized;
    } catch {
      // handled below
    }
    invalidRegistration(`Project registration registrationConfirmations.${fieldName} must be a Google Drive or Docs URL`);
  };
  return {
    laborIncludesFourInsurance: typeof source.laborIncludesFourInsurance === 'boolean'
      ? source.laborIncludesFourInsurance
      : null,
    laborIncludesRetirementPay: typeof source.laborIncludesRetirementPay === 'boolean'
      ? source.laborIncludesRetirementPay
      : null,
    customerSettlementBasisConfirmed: source.customerSettlementBasisConfirmed === true,
    modusignContractUsed: typeof source.modusignContractUsed === 'boolean' ? source.modusignContractUsed : null,
    originalContractSubmitted: typeof source.originalContractSubmitted === 'boolean'
      ? source.originalContractSubmitted
      : null,
    proposalPptOriginal: driveUrl(source.proposalPptOriginal, 'proposalPptOriginal'),
    presentationPptOriginal: driveUrl(source.presentationPptOriginal, 'presentationPptOriginal'),
  };
}

function normalizeRegistrationOptionalDocumentNotes(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    proposalWordOriginal: readOptionalText(source.proposalWordOriginal),
    proposalPptOriginal: readOptionalText(source.proposalPptOriginal),
    presentationPptOriginal: readOptionalText(source.presentationPptOriginal),
  };
}

function normalizeProjectCheckout(value, settlementApplicable = true) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    finalPaymentReceived: source.finalPaymentReceived === true,
    bankBalanceZero: source.bankBalanceZero === true,
    performanceCertificateReceived: source.performanceCertificateReceived === true,
    performanceCertificateDocumentApplicable: source.performanceCertificateDocumentApplicable === true,
    taxInvoiceEvidenceConfirmed: source.taxInvoiceEvidenceConfirmed === true,
    finalSettlementReportConfirmed: settlementApplicable && source.finalSettlementReportConfirmed === true,
    usbEvidenceSubmitted: settlementApplicable && source.usbEvidenceSubmitted === true,
    evidenceDeletedAfterUsb: settlementApplicable && source.evidenceDeletedAfterUsb === true,
  };
}

function assertProjectCheckoutPayload(payload, attachmentRefs, currentProject) {
  const status = normalizeProjectStatus(readOptionalText(currentProject?.status || payload?.status));
  if (!['COMPLETED', 'COMPLETED_PENDING_PAYMENT'].includes(status)) return;
  if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'checkout')) {
    invalidRegistration('Completed project checkout is required');
  }
  const checkout = payload?.checkout;
  if (!checkout || typeof checkout !== 'object' || Array.isArray(checkout)) {
    invalidRegistration('Completed project checkout is required');
  }
  const fields = [
    'finalPaymentReceived',
    'bankBalanceZero',
    'performanceCertificateReceived',
    'taxInvoiceEvidenceConfirmed',
    'finalSettlementReportConfirmed',
    'usbEvidenceSubmitted',
    'evidenceDeletedAfterUsb',
  ];
  for (const field of fields) {
    if (typeof checkout[field] !== 'boolean') invalidRegistration(`Completed project checkout.${field} must be boolean`);
  }
  if (
    Object.hasOwn(checkout, 'performanceCertificateDocumentApplicable')
    && typeof checkout.performanceCertificateDocumentApplicable !== 'boolean'
  ) invalidRegistration('Completed project checkout.performanceCertificateDocumentApplicable must be boolean');
  const registrationVersion = registrationRequirementsVersion(
    payload?.registrationRequirementsVersion ?? currentProject?.registrationRequirementsVersion,
  );
  const settlementApplicable = registrationVersion === 2
    ? normalizeBasis(readOptionalText(payload?.basis ?? currentProject?.basis)) !== 'NONE'
    : normalizeSettlementType(readOptionalText(payload?.settlementType ?? currentProject?.settlementType)) !== 'NONE';
  if (settlementApplicable && checkout.evidenceDeletedAfterUsb && !checkout.usbEvidenceSubmitted) {
    invalidRegistration('Completed project evidence cannot be marked deleted before USB submission');
  }
  const attachedKinds = new Set((Array.isArray(attachmentRefs) ? attachmentRefs : [])
    .map((attachment) => readOptionalText(attachment?.documentKind))
    .filter(Boolean));
  const hasDocument = (field, kind) => Boolean(currentProject?.[field]?.path) || attachedKinds.has(kind);
  if (checkout.performanceCertificateDocumentApplicable && !hasDocument('performanceCertificateDocument', 'performance_certificate')) {
    invalidRegistration('Completed project performance certificate PDF is required when applicable');
  }
  if (checkout.taxInvoiceEvidenceConfirmed && !hasDocument('taxInvoiceDocument', 'tax_invoice')) {
    invalidRegistration('Completed project tax invoice PDF is required when confirmed');
  }
  if (settlementApplicable && checkout.finalSettlementReportConfirmed && !hasDocument('finalSettlementReportDocument', 'final_settlement_report')) {
    invalidRegistration('Completed project final settlement report PDF is required when confirmed');
  }
}

function assertRegistrationV2Requirements(payload, attachmentRefs, validateAttachments = true) {
  if (registrationRequirementsVersion(payload.registrationRequirementsVersion) !== 2) return;
  for (const field of ['officialContractName', 'clientOrg', 'projectPurpose', 'description']) {
    if (!readOptionalText(payload[field])) {
      invalidRegistration(`Project registration ${field} is required`);
    }
  }
  const settlementType = readOptionalText(payload.settlementType);
  const basis = readOptionalText(payload.basis);
  const accountType = readOptionalText(payload.accountType);
  const settlementSystem = readOptionalText(payload.settlementSystem);
  const laborSettlementBasis = readOptionalText(payload.laborSettlementBasis);
  const interestRefundPolicy = readOptionalText(payload.interestRefundPolicy);
  if (!REGISTRATION_SETTLEMENT_TYPES.has(settlementType)) {
    invalidRegistration('Project registration settlementType is invalid');
  }
  if (!REGISTRATION_SETTLEMENT_BASES.has(basis)) {
    invalidRegistration('Project registration basis is invalid');
  }
  if (!REGISTRATION_V2_SETTLEMENT_BASES.has(basis)) {
    invalidRegistration('Project registration basis is invalid for requirements version 2');
  }
  const settlementDetailsEnabled = normalizeBasis(basis) !== 'NONE';
  if (settlementDetailsEnabled && accountType && !REGISTRATION_ACCOUNT_TYPES.has(accountType)) {
    invalidRegistration('Project registration accountType is invalid');
  }
  if (settlementDetailsEnabled && settlementSystem && !SETTLEMENT_SYSTEM_CODES.has(settlementSystem)) {
    invalidRegistration('Project registration settlementSystem is invalid');
  }
  assertProjectPaymentExtensions(payload);
  if (settlementDetailsEnabled && laborSettlementBasis && !LABOR_SETTLEMENT_BASES.has(laborSettlementBasis)) {
    invalidRegistration('Project registration laborSettlementBasis is invalid');
  }
  if (interestRefundPolicy && !REGISTRATION_INTEREST_REFUND_POLICIES.has(interestRefundPolicy)) {
    invalidRegistration('Project registration interestRefundPolicy is invalid');
  }
  assertRegistrationV2PaymentPlan(payload);
  const confirmations = normalizeRegistrationConfirmations(payload.registrationConfirmations);
  if (confirmations.modusignContractUsed === null) {
    invalidRegistration('Project registration modusignContractUsed is required');
  }
  if (confirmations.modusignContractUsed === false && confirmations.originalContractSubmitted !== true) {
    invalidRegistration('Project registration originalContractSubmitted is required without Modusign');
  }

  if (validateAttachments) {
    const missingDocumentKind = missingProjectRegistrationRequiredDocumentKind(attachmentRefs, payload);
    if (missingDocumentKind) {
      invalidRegistration(`Project registration required attachment is missing: ${missingDocumentKind}`);
    }
  }

  const contractStart = readOptionalText(payload.contractStart);
  const contractEnd = readOptionalText(payload.contractEnd);
  const contractEndUndecided = payload.contractEndUndecided === true;
  if (contractEndUndecided) {
    if (!isRealIsoDate(contractStart) || contractEnd) {
      invalidRegistration('Project registration v2 contract dates are invalid');
    }
  } else if (!isRealIsoDate(contractStart) || !isRealIsoDate(contractEnd) || contractStart > contractEnd) {
    invalidRegistration('Project registration v2 contract dates are invalid');
  }
  const startYear = Number(contractStart.slice(0, 4));
  // 종료 기간 없음이면 재무 계획은 시작연도~현재 연도까지를 요구한다.
  const endYear = contractEndUndecided
    ? Math.max(startYear, new Date().getFullYear())
    : Number(contractEnd.slice(0, 4));
  if (endYear - startYear > 20) {
    invalidRegistration('Project registration financialYears are invalid');
  }
  if (endYear > startYear) {
    if (!Array.isArray(payload.financialYears)) {
      invalidRegistration('Project registration financialYears are invalid');
    }
    const rows = new Map();
    for (const row of payload.financialYears) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        invalidRegistration('Project registration financial year row is invalid');
      }
      const year = row.year;
      if (!Number.isSafeInteger(year) || year < startYear || year > endYear || rows.has(year)) {
        invalidRegistration('Project registration financial year coverage is invalid');
      }
      for (const field of REGISTRATION_AMOUNT_FIELDS) {
        assertRegistrationAmount(row[field], `financialYears.${year}.${field}`, { required: true });
      }
      if (row.paymentPlan !== undefined) {
        if (!row.paymentPlan || typeof row.paymentPlan !== 'object' || Array.isArray(row.paymentPlan)) {
          invalidRegistration(`Project registration financialYears.${year}.paymentPlan is invalid`);
        }
        for (const field of REGISTRATION_PAYMENT_FIELDS) {
          assertRegistrationAmount(row.paymentPlan[field], `financialYears.${year}.paymentPlan.${field}`, { required: true });
        }
      }
      if (row.isSettled !== undefined && typeof row.isSettled !== 'boolean') {
        invalidRegistration(`Project registration financialYears.${year}.isSettled must be boolean`);
      }
      if (typeof row.profitRate !== 'number' || !Number.isFinite(row.profitRate) || row.profitRate < 0 || row.profitRate > 1) {
        invalidRegistration(`Project registration financialYears.${year}.profitRate must be between 0 and 1`);
      }
      // 계약서 대조 확인 체크는 위저드에서 걷어냈다(2b62f0a9). 서버가 confirmed 를 계속
      // 요구하면 모든 신규 등록이 영구히 막히므로 요구하지 않는다. 필드 자체는 이력용으로 남는다.
      rows.set(year, row);
    }
    for (let year = startYear; year <= endYear; year += 1) {
      if (!rows.has(year)) invalidRegistration(`Project registration financial year is missing: ${year}`);
    }
    if (rows.size !== endYear - startYear + 1) {
      invalidRegistration('Project registration financial year coverage is invalid');
    }
    for (const field of REGISTRATION_AMOUNT_FIELDS) {
      const annualTotal = [...rows.values()].reduce((sum, row) => sum + row[field], 0);
      if (!Number.isSafeInteger(annualTotal) || annualTotal !== payload[field]) {
        invalidRegistration(`Project registration financialYears ${field} total does not match`);
      }
    }
  }

}

const REGISTRATION_REQUIREMENT_DOCUMENT_FIELDS = Object.fromEntries(PROJECT_REGISTRATION_DOCUMENT_KINDS.map((kind) => [kind, PROJECT_DOCUMENT_FIELD_BY_KIND[kind]]));

const PROJECT_INFO_DOCUMENT_FIELDS = Object.values(PROJECT_DOCUMENT_FIELD_BY_KIND);

function trustedStoredChangeRequestDocuments(previousRequest) {
  if (
    readOptionalText(previousRequest?.requestKind) !== 'CHANGE'
    || !['PENDING', 'REJECTED'].includes(readOptionalText(previousRequest?.status))
  ) return {};
  const source = previousRequest?.proposedSnapshot && typeof previousRequest.proposedSnapshot === 'object'
    ? previousRequest.proposedSnapshot
    : previousRequest?.payload;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  return Object.fromEntries(PROJECT_INFO_DOCUMENT_FIELDS.flatMap((field) => (
    readOptionalText(source[field]?.path) ? [[field, source[field]]] : []
  )));
}

function trustedRegistrationRequirementAttachments(
  currentProject,
  payload,
  attachmentRefs,
  trustedStoredDocuments = {},
) {
  const privateAttachments = new Map((Array.isArray(attachmentRefs) ? attachmentRefs : [])
    .flatMap((attachment) => {
      const documentKind = readOptionalText(attachment?.documentKind);
      const path = readOptionalText(attachment?.path);
      return documentKind && path ? [[documentKind, { documentKind, path }]] : [];
    }));
  const payloadDocument = (field) => {
    if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, field)) return undefined;
    const path = readOptionalText(payload[field]?.path);
    if (!path) return null;
    const canonicalPath = readOptionalText(currentProject?.[field]?.path);
    if (canonicalPath && path === canonicalPath) return { path: canonicalPath };
    const storedPath = readOptionalText(trustedStoredDocuments?.[field]?.path);
    return storedPath && path === storedPath ? { path: storedPath } : null;
  };
  const canonicalFields = {
    ...REGISTRATION_REQUIREMENT_DOCUMENT_FIELDS,
  };
  return Object.entries(canonicalFields).flatMap(([documentKind, field]) => {
    const privateAttachment = privateAttachments.get(documentKind);
    if (privateAttachment) return [privateAttachment];
    const proposedDocument = payloadDocument(field);
    if (proposedDocument !== undefined) {
      return proposedDocument ? [{ documentKind, path: proposedDocument.path }] : [];
    }
    const canonicalPath = readOptionalText(currentProject?.[field]?.path);
    return canonicalPath ? [{ documentKind, path: canonicalPath }] : [];
  });
}

function assertTrustedProjectInfoDocumentReferences(
  currentProject,
  payload,
  attachmentRefs,
  trustedStoredDocuments = {},
) {
  const privateDocuments = registrationPrivateDocuments(attachmentRefs);
  for (const field of PROJECT_INFO_DOCUMENT_FIELDS) {
    if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, field)) continue;
    const candidate = payload[field];
    if (candidate === null || candidate === undefined) continue;
    if (privateDocuments[field]) continue;
    const candidatePath = readOptionalText(candidate?.path);
    const canonicalPath = readOptionalText(currentProject?.[field]?.path);
    const storedPath = readOptionalText(trustedStoredDocuments?.[field]?.path);
    if (candidatePath && (candidatePath === canonicalPath || candidatePath === storedPath)) continue;
    invalidRegistration(`Project information document path is not trusted: ${field}`);
  }
}


export const PROJECT_STAFFING_ROLE_MAX_LENGTH = 20;
export const PROJECT_STAFFING_OTHERS_MAX = 10;

/** 기타 역할명 표기 통일. src/app/platform/project-editor.ts 의 같은 이름 함수와 같은 규칙이다. */
export function normalizeProjectStaffingRoleName(value) {
  return readOptionalText(value).replace(/\s+/g, ' ').slice(0, PROJECT_STAFFING_ROLE_MAX_LENGTH);
}

/** 실제 투입인력 정규화. personId 없는 슬롯은 미정(null) - 명부 밖 인물은 담지 않는다. */
function normalizeProjectStaffingForWrite(value) {
  const source = value && typeof value === 'object' ? value : {};
  const slot = (input) => {
    if (!input || typeof input !== 'object') return null;
    const personId = readOptionalText(input.personId);
    if (!personId) return null;
    return {
      personId,
      name: readOptionalText(input.name),
      nickname: readOptionalText(input.nickname),
    };
  };
  const operators = (Array.isArray(source.operators) ? source.operators : [])
    .map((item) => slot(item))
    .filter(Boolean);
  // 기타 역할: 역할명이 비면 담지 않는다 - 사람만 있고 역할이 없으면 읽는 쪽이 뜻을 알 수 없다.
  const others = [];
  for (const item of Array.isArray(source.others) ? source.others : []) {
    const role = normalizeProjectStaffingRoleName(item && typeof item === 'object' ? item.role : '');
    if (!role) continue;
    others.push({ role, slot: slot(item && typeof item === 'object' ? item.slot : null) });
    if (others.length >= PROJECT_STAFFING_OTHERS_MAX) break;
  }
  return {
    lead: slot(source.lead),
    pm: slot(source.pm),
    operators,
    others,
    settlementSupport: readOptionalText(source.settlementSupport),
  };
}

function assertRegistrationPayload(payload, { participationSheetLinkRequired = true } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    invalidRegistration('Project registration payload is invalid');
  }
  const type = readOptionalText(payload.type);
  const managerName = readOptionalText(payload.registeredByName) || readOptionalText(payload.managerName);
  const executiveApproverId = readOptionalText(payload.executiveApproverId);
  const executiveApproverName = readOptionalText(payload.executiveApproverName);
  if (
    !readOptionalText(payload.name)
    || !readOptionalText(payload.department)
    || !managerName
    || !executiveApproverId
    || !executiveApproverName
    || !REGISTRATION_PROJECT_TYPES.has(type)
  ) {
    invalidRegistration('Project registration is missing required fields');
  }
  assertRegistrationFinancials(payload, type);
  if (registrationRequirementsVersion(payload.registrationRequirementsVersion) === 2) {
    const participationSheetLinked = Boolean(readOptionalText(payload.participationSheetLink));
    assertParticipationSheetLinkForTeamMembers(
      payload.teamMembersDetailed,
      payload.participationSheetLink,
      { required: participationSheetLinkRequired },
    );
    assertRegistrationTeamMembers(payload.teamMembersDetailed, {
      participationSheetLinked,
      contractStartMonth: readOptionalText(payload.contractStart).slice(0, 7),
      contractEndMonth: readOptionalText(payload.contractEnd).slice(0, 7),
    });
  }
  if (
    type !== 'I1'
    && (
      payload.financialInputFlags?.contractAmount !== true
    )
  ) {
    invalidRegistration('Project registration financial fields are incomplete');
  }
}

function participationSheetFieldsChanged(payload = {}, currentProject = {}) {
  const linkChanged = Object.hasOwn(payload, 'participationSheetLink')
    && readOptionalText(payload.participationSheetLink) !== readOptionalText(currentProject.participationSheetLink);
  const teamChanged = Object.hasOwn(payload, 'teamMembersDetailed')
    && stableStringify(Array.isArray(payload.teamMembersDetailed) ? payload.teamMembersDetailed : [])
      !== stableStringify(Array.isArray(currentProject.teamMembersDetailed) ? currentProject.teamMembersDetailed : []);
  const periodChanged = ['contractStart', 'contractEnd'].some((field) => (
    Object.hasOwn(payload, field)
    && readOptionalText(payload[field]) !== readOptionalText(currentProject[field])
  ));
  return linkChanged || teamChanged || periodChanged;
}

export function buildProjectRegistrationCanonicalDocuments({
  tenantId,
  projectId,
  projectRequestId,
  sourceDraftId,
  payload,
  attachmentRefs,
  requirementsAttachmentRefs = attachmentRefs,
  actorId,
  actorName,
  actorEmail,
  timestamp,
}) {
  assertRegistrationPayload(payload);
  if (registrationRequirementsVersion(payload.registrationRequirementsVersion) !== 2) {
    invalidRegistration('New project registration requires requirements version 2');
  }
  if (readOptionalText(payload.settlementType) === 'NONE') {
    invalidRegistration('Project registration settlementType NONE is not available in requirements version 2');
  }
  assertRegistrationV2Requirements(payload, requirementsAttachmentRefs);
  const ownerId = readOptionalText(payload.registeredById) || readOptionalText(payload.managerId) || actorId;
  const ownerName = readOptionalText(payload.registeredByName) || readOptionalText(payload.managerName) || actorName;
  const ownerEmail = readOptionalText(payload.registeredByEmail) || (ownerId === actorId ? readOptionalText(actorEmail) : '');
  const fundInputMode = normalizeProjectFundInputMode(readOptionalText(payload.fundInputMode));
  const settlementType = normalizeSettlementType(readOptionalText(payload.settlementType));
  const basis = normalizeBasis(readOptionalText(payload.basis));
  const settlementDetailsEnabled = basis !== 'NONE';
  const documents = registrationPrivateDocuments(attachmentRefs);
  const teamMembersDetailed = normalizeProjectTeamMembersDetailed(payload.teamMembersDetailed, {
    contractStartMonth: readOptionalText(payload.contractStart).slice(0, 7),
    contractEndMonth: readOptionalText(payload.contractEnd).slice(0, 7),
  });
  const requestPayload = stripUndefinedDeep({
    name: readOptionalText(payload.name),
    officialContractName: readOptionalText(payload.officialContractName),
    type: normalizeProjectType(readOptionalText(payload.type)),
    status: normalizeProjectStatus(readOptionalText(payload.status)),
    phase: normalizeProjectPhase(readOptionalText(payload.phase)),
    description: readOptionalText(payload.description),
    clientOrg: readOptionalText(payload.clientOrg),
    businessManagementGoogleFolderLink: readOptionalText(payload.businessManagementGoogleFolderLink) || undefined,
    participationSheetLink: readOptionalText(payload.participationSheetLink) || undefined,
    staffing: normalizeProjectStaffingForWrite(payload.staffing),
    department: normalizeProjectOrganizationLabel(payload.department),
    groupwareName: readOptionalText(payload.groupwareName) || undefined,
    currency: normalizeProjectCurrency(readOptionalText(payload.currency)),
    contractAmount: registrationAmount(payload.contractAmount),
    salesVatAmount: registrationAmount(payload.salesVatAmount),
    totalRevenueAmount: registrationAmount(payload.totalRevenueAmount),
    totalActualCost: registrationAmount(payload.totalActualCost),
    supportAmount: registrationAmount(payload.supportAmount),
    financialInputFlags: registrationFinancialInputFlags(payload.financialInputFlags, payload),
    registrationRequirementsVersion: registrationRequirementsVersion(payload.registrationRequirementsVersion),
    financialYears: normalizeRegistrationFinancialYears(payload.financialYears),
    registrationOptionalDocumentNotes: normalizeRegistrationOptionalDocumentNotes(
      payload.registrationOptionalDocumentNotes,
    ),
    registrationConfirmations: normalizeRegistrationConfirmations(payload.registrationConfirmations),
    checkout: normalizeProjectCheckout(payload.checkout, settlementDetailsEnabled),
    contractStart: readOptionalText(payload.contractStart),
    contractEnd: readOptionalText(payload.contractEnd),
    contractEndUndecided: payload.contractEndUndecided === true ? true : undefined,
    contractType: normalizeProjectContractType(payload.contractType),
    settlementType,
    basis,
    accountType: !settlementDetailsEnabled ? 'NONE' : normalizeAccountType(readOptionalText(payload.accountType)),
    settlementSystem: !settlementDetailsEnabled ? 'NONE' : normalizeSettlementSystemCode(payload.settlementSystem),
    settlementSystemOther: settlementDetailsEnabled && normalizeSettlementSystemCode(payload.settlementSystem) === 'OTHER'
      ? normalizeSettlementSystemOther(payload.settlementSystemOther)
      : undefined,
    laborSettlementBasis: !settlementDetailsEnabled
      ? 'NONE'
      : normalizeLaborSettlementBasis(payload.laborSettlementBasis),
    laborTransferPlan: normalizeLaborTransferPlan(payload.laborTransferPlan),
    fundInputMode,
    settlementSheetPolicy: registrationSettlementSheetPolicy(payload.settlementSheetPolicy, fundInputMode),
    paymentPlan: {
      contract: registrationAmount(payload.paymentPlan?.contract),
      interim: registrationAmount(payload.paymentPlan?.interim),
      final: registrationAmount(payload.paymentPlan?.final),
    },
    paymentExpectedMonths: normalizePaymentExpectedMonths(payload.paymentExpectedMonths),
    finalPaymentExpectedWeek: readOptionalText(payload.finalPaymentExpectedWeek),
    interestRefundPolicy: readOptionalText(payload.interestRefundPolicy) || undefined,
    quoteSubmissionDeferred: payload.quoteSubmissionDeferred === true,
    advanceInterimBelow70Reason: readOptionalText(payload.advanceInterimBelow70Reason),
    paymentPlanDesc: readOptionalText(payload.paymentPlanDesc),
    settlementGuide: readOptionalText(payload.settlementGuide),
    finalPaymentNote: readOptionalText(payload.finalPaymentNote),
    projectPurpose: readOptionalText(payload.projectPurpose),
    registeredById: ownerId,
    registeredByName: ownerName,
    registeredByEmail: ownerEmail,
    executiveApproverId: readOptionalText(payload.executiveApproverId),
    executiveApproverName: readOptionalText(payload.executiveApproverName),
    executiveApproverEmail: readOptionalText(payload.executiveApproverEmail),
    managerId: ownerId,
    managerName: ownerName,
    teamName: readOptionalText(payload.teamName),
    teamMembers: teamMembersDetailed.map(formatProjectRequestTeamMember).join(', '),
    teamMembersDetailed,
    participantCondition: readOptionalText(payload.participantCondition),
    note: readOptionalText(payload.note),
    ...documents,
    contractAnalysis: payload.contractAnalysis && typeof payload.contractAnalysis === 'object'
      ? payload.contractAnalysis
      : null,
  });
  const projectPatch = buildProjectPatchFromChangeRequestPayload(requestPayload, {});
  const project = stripUndefinedDeep({
    id: projectId,
    slug: registrationSlug(requestPayload.name, projectId),
    orgId: tenantId,
    tenantId,
    registrationSource: 'pm_portal',
    executiveReviewStatus: 'PENDING',
    executiveReviewHistory: [{
      status: 'PENDING',
      previousStatus: null,
      reviewedAt: timestamp,
      reviewedById: actorId,
      reviewedByName: actorName,
      reviewComment: 'PM 신규 등록',
    }],
    managementPlanningReviewStatus: 'PENDING',
    managementPlanningReviewHistory: [],
    registeredAt: timestamp,
    ...projectPatch,
    quoteDocument: documents.quoteDocument,
    proposalDocument: documents.proposalDocument,
    proposalWordOriginalDocument: documents.proposalWordOriginalDocument,
    proposalPptOriginalDocument: documents.proposalPptOriginalDocument,
    presentationPptOriginalDocument: documents.presentationPptOriginalDocument,
    rfpRequestEvidenceDocument: documents.rfpRequestEvidenceDocument,
    customerBusinessRegistrationDocument: documents.customerBusinessRegistrationDocument,
    taxInvoiceAmount: 0,
    isSettled: false,
    confirmerName: '',
    lastCheckedAt: '',
    cashflowDiffNote: '',
    version: 1,
    createdBy: actorId,
    createdAt: timestamp,
    updatedBy: actorId,
    updatedAt: timestamp,
  });
  const projectRequest = stripUndefinedDeep({
    id: projectRequestId,
    sourceDraftId,
    tenantId,
    requestKind: 'REGISTRATION',
    requestVersion: 1,
    status: 'PENDING',
    reviewOutcome: null,
    payload: requestPayload,
    requestedBy: actorId,
    requestedByName: actorName,
    requestedByEmail: readOptionalText(actorEmail),
    requestedAt: timestamp,
    reviewedBy: null,
    reviewedByName: null,
    reviewedAt: null,
    approvedProjectId: projectId,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return { project, projectRequest };
}

function normalizeSettlementType(value) {
  return ['TYPE1', 'TYPE2', 'TYPE3', 'TYPE4', 'TYPE5'].includes(value) ? value : 'NONE';
}

function normalizeAccountType(value) {
  return value === 'DEDICATED' || value === 'OPERATING' || value === 'OTHER' ? value : 'NONE';
}

function normalizeProjectFundInputMode(value) {
  return value === 'DIRECT_ENTRY' ? 'DIRECT_ENTRY' : 'BANK_UPLOAD';
}

function normalizeProjectCurrency(value) {
  return value === 'USD' ? 'USD' : 'KRW';
}

export function normalizeProjectOrganizationLabel(value) {
  const normalized = readOptionalText(value);
  if (!normalized || normalized === '미지정') return '';
  const teamMatch = normalized.match(/^([a-z]{2,10})\s*team$/i);
  if (teamMatch) return `${teamMatch[1].toUpperCase()}팀`;
  if (/^cic\s*\d+$/i.test(normalized)) return normalized.toUpperCase().replace(/\s+/g, '');
  return normalized;
}

export function buildProjectRequestPayloadFromProject(project, existingPayload = {}) {
  const { finalPaymentExpectedWeek: _historicalWeek, ...existingRequestPayload } = existingPayload && typeof existingPayload === 'object'
    ? existingPayload
    : {};
  const teamMembersDetailed = Array.isArray(project?.teamMembersDetailed) && project.teamMembersDetailed.length > 0
    ? project.teamMembersDetailed
    : (Array.isArray(existingPayload.teamMembersDetailed) ? existingPayload.teamMembersDetailed : []);
  const teamMembers = teamMembersDetailed.length > 0
    ? teamMembersDetailed.map(formatProjectRequestTeamMember).join(', ')
    : readOptionalText(existingPayload.teamMembers);
  const hasProjectField = (key) => Object.prototype.hasOwnProperty.call(project || {}, key);
  const pickText = (key) => hasProjectField(key)
    ? readOptionalText(project?.[key])
    : readOptionalText(existingPayload[key]);
  const pickValue = (key) => hasProjectField(key) ? project?.[key] : existingPayload[key];
  const pickNumber = (key) => Number.isFinite(project?.[key]) ? project[key] : existingPayload[key];
  const settlementType = normalizeSettlementType(pickText('settlementType'));
  const basis = normalizeBasis(pickText('basis'));
  const settlementDetailsEnabled = Number(pickValue('registrationRequirementsVersion')) === 2
    ? basis !== 'NONE'
    : settlementType !== 'NONE';

  return {
    ...existingRequestPayload,
    name: pickText('name'),
    officialContractName: pickText('officialContractName'),
    type: normalizeProjectType(pickText('type')),
    status: normalizeProjectStatus(pickText('status')),
    phase: normalizeProjectPhase(pickText('phase')),
    description: pickText('description'),
    clientOrg: pickText('clientOrg'),
    businessManagementGoogleFolderLink: pickText('businessManagementGoogleFolderLink'),
    participationSheetLink: pickText('participationSheetLink'),
    staffing: normalizeProjectStaffingForWrite(pickValue('staffing')),
    department: pickText('department'),
    groupwareName: pickText('groupwareName'),
    currency: normalizeProjectCurrency(pickText('currency')),
    contractAmount: pickNumber('contractAmount'),
    salesVatAmount: pickNumber('salesVatAmount'),
    totalRevenueAmount: pickNumber('totalRevenueAmount'),
    totalActualCost: pickNumber('totalActualCost'),
    supportAmount: pickNumber('supportAmount'),
    financialInputFlags: project?.financialInputFlags || existingPayload.financialInputFlags || undefined,
    registrationRequirementsVersion: pickValue('registrationRequirementsVersion'),
    financialYears: normalizeRegistrationFinancialYears(pickValue('financialYears')),
    registrationConfirmations: pickValue('registrationConfirmations'),
    registrationOptionalDocumentNotes: pickValue('registrationOptionalDocumentNotes'),
    checkout: pickValue('checkout'),
    contractStart: pickText('contractStart'),
    contractEnd: pickText('contractEnd'),
    contractEndUndecided: pickValue('contractEndUndecided') === true ? true : undefined,
    contractType: normalizeProjectContractType(pickText('contractType')),
    settlementType,
    basis: Number(pickValue('registrationRequirementsVersion')) === 2 || settlementDetailsEnabled ? basis : 'NONE',
    accountType: !settlementDetailsEnabled ? 'NONE' : normalizeAccountType(pickText('accountType')),
    settlementSystem: !settlementDetailsEnabled ? 'NONE' : normalizeSettlementSystemCode(pickText('settlementSystem')),
    settlementSystemOther: settlementDetailsEnabled && normalizeSettlementSystemCode(pickText('settlementSystem')) === 'OTHER'
      ? normalizeSettlementSystemOther(pickText('settlementSystemOther'))
      : undefined,
    laborSettlementBasis: !settlementDetailsEnabled
      ? 'NONE'
      : normalizeLaborSettlementBasis(pickText('laborSettlementBasis')),
    laborTransferPlan: normalizeLaborTransferPlan(pickValue('laborTransferPlan')),
    fundInputMode: normalizeProjectFundInputMode(pickText('fundInputMode')),
    settlementSheetPolicy: pickValue('settlementSheetPolicy') || undefined,
    paymentPlan: pickValue('paymentPlan') || { contract: 0, interim: 0, final: 0 },
    paymentExpectedMonths: normalizePaymentExpectedMonths(pickValue('paymentExpectedMonths')),
    finalPaymentExpectedWeek: pickText('finalPaymentExpectedWeek'),
    interestRefundPolicy: pickText('interestRefundPolicy') || undefined,
    quoteSubmissionDeferred: pickValue('quoteSubmissionDeferred') === true,
    advanceInterimBelow70Reason: pickText('advanceInterimBelow70Reason'),
    paymentPlanDesc: pickText('paymentPlanDesc'),
    settlementGuide: pickText('settlementGuide'),
    finalPaymentNote: pickText('finalPaymentNote'),
    projectPurpose: pickText('projectPurpose'),
    registeredById: pickText('registeredById'),
    registeredByName: pickText('registeredByName'),
    registeredByEmail: pickText('registeredByEmail'),
    executiveApproverId: pickText('executiveApproverId'),
    executiveApproverName: pickText('executiveApproverName'),
    executiveApproverEmail: pickText('executiveApproverEmail'),
    managerId: pickText('managerId'),
    managerName: pickText('managerName'),
    teamName: pickText('teamName'),
    teamMembers,
    teamMembersDetailed,
    participantCondition: pickText('participantCondition'),
    note: pickText('note'),
    ...Object.fromEntries(PROJECT_INFO_DOCUMENT_FIELDS.map((field) => [field, project?.[field] === undefined ? existingPayload[field] ?? null : project[field]])),
    contractAnalysis: project?.contractAnalysis ?? existingPayload.contractAnalysis ?? null,
  };
}

function resolveProjectCicFromPayload(payload, currentProject = {}) {
  return normalizeProjectOrganizationLabel(
    readOptionalText(payload?.cic)
    || readOptionalText(payload?.department)
    || readOptionalText(currentProject?.cic)
    || readOptionalText(currentProject?.department),
  );
}

function resolveProjectDepartmentFromPayload(payload, currentProject = {}) {
  return normalizeProjectOrganizationLabel(
    readOptionalText(payload?.department)
    || readOptionalText(currentProject?.department)
    || readOptionalText(payload?.cic)
    || readOptionalText(currentProject?.cic),
  );
}

function buildProjectPatchFromChangeRequestPayloadInternal(payload = {}, currentProject = {}, {
  validateParticipationSheetLink = true,
} = {}) {
  const managerId = readOptionalText(payload.registeredById)
    || readOptionalText(payload.managerId)
    || readOptionalText(currentProject.registeredById)
    || readOptionalText(currentProject.managerId);
  const managerName = readOptionalText(payload.registeredByName)
    || readOptionalText(payload.managerName)
    || readOptionalText(currentProject.registeredByName)
    || readOptionalText(currentProject.managerName);
  const effectiveParticipationSheetLink = Object.hasOwn(payload, 'participationSheetLink')
    ? readOptionalText(payload.participationSheetLink)
    : readOptionalText(currentProject.participationSheetLink);
  const effectiveContractStart = readOptionalText(payload.contractStart) || readOptionalText(currentProject.contractStart);
  const effectiveContractEnd = readOptionalText(payload.contractEnd) || readOptionalText(currentProject.contractEnd);
  const registrationVersion = registrationRequirementsVersion(
    Object.hasOwn(payload, 'registrationRequirementsVersion')
      ? payload.registrationRequirementsVersion
      : currentProject.registrationRequirementsVersion,
  );
  const currentRegistrationVersion = registrationRequirementsVersion(
    currentProject.registrationRequirementsVersion,
  );
  const updatesTeamMembers = Object.hasOwn(payload, 'teamMembersDetailed');
  const updatesParticipationSheet = participationSheetFieldsChanged(payload, currentProject);
  if (validateParticipationSheetLink) {
    assertParticipationSheetLinkForTeamMembers(
      payload.teamMembersDetailed,
      effectiveParticipationSheetLink,
      {
        required: registrationVersion === 2
          && (updatesParticipationSheet || currentRegistrationVersion !== 2),
      },
    );
  }
  const teamMembersDetailed = updatesTeamMembers
    ? normalizeProjectTeamMembersDetailed(payload.teamMembersDetailed, {
        contractStartMonth: effectiveContractStart.slice(0, 7),
        contractEndMonth: effectiveContractEnd.slice(0, 7),
      })
    : undefined;
  const settlementType = normalizeSettlementType(readOptionalText(payload.settlementType));
  const basis = normalizeBasis(readOptionalText(payload.basis));
  const settlementDetailsEnabled = registrationVersion === 2 ? basis !== 'NONE' : settlementType !== 'NONE';
  const historicalFinancialWeeks = new Map((Array.isArray(currentProject.financialYears) ? currentProject.financialYears : [])
    .map((row) => [row?.year, readOptionalText(row?.finalPaymentExpectedWeek)]));
  const financialYears = normalizeRegistrationFinancialYears(payload.financialYears).map((row) => ({
    ...row,
    ...(historicalFinancialWeeks.get(row.year) ? { finalPaymentExpectedWeek: historicalFinancialWeeks.get(row.year) } : {}),
  }));
  return normalizeProjectRevenueFields(stripUndefinedDeep({
    name: readOptionalText(payload.name) || readOptionalText(currentProject.name),
    officialContractName: readOptionalText(payload.officialContractName),
    type: normalizeProjectType(readOptionalText(payload.type)),
    status: normalizeProjectStatus(readOptionalText(payload.status) || currentProject.status),
    phase: normalizeProjectPhase(readOptionalText(payload.phase) || currentProject.phase),
    description: readOptionalText(payload.description),
    clientOrg: readOptionalText(payload.clientOrg),
    businessManagementGoogleFolderLink: readOptionalText(payload.businessManagementGoogleFolderLink) || undefined,
    participationSheetLink: readOptionalText(payload.participationSheetLink) || undefined,
    staffing: Object.hasOwn(payload, 'staffing')
      ? normalizeProjectStaffingForWrite(payload.staffing)
      : (currentProject.staffing || undefined),
    department: resolveProjectDepartmentFromPayload(payload, currentProject),
    cic: resolveProjectCicFromPayload(payload, currentProject),
    groupwareName: readOptionalText(payload.groupwareName) || readOptionalText(currentProject.groupwareName) || undefined,
    currency: normalizeProjectCurrency(readOptionalText(payload.currency)),
    contractAmount: Number.isFinite(Number(payload.contractAmount)) ? Math.max(0, Math.round(Number(payload.contractAmount))) : 0,
    salesVatAmount: Number.isFinite(Number(payload.salesVatAmount)) ? Math.max(0, Math.round(Number(payload.salesVatAmount))) : 0,
    totalRevenueAmount: Number.isFinite(Number(payload.totalRevenueAmount)) ? Math.max(0, Math.round(Number(payload.totalRevenueAmount))) : 0,
    totalActualCost: Number.isFinite(Number(payload.totalActualCost)) ? Math.max(0, Math.round(Number(payload.totalActualCost))) : 0,
    supportAmount: Number.isFinite(Number(payload.supportAmount)) ? Math.max(0, Math.round(Number(payload.supportAmount))) : 0,
    financialInputFlags: payload.financialInputFlags,
    registrationRequirementsVersion: registrationVersion,
    financialYears,
    ...(Object.hasOwn(payload, 'registrationConfirmations') ? {
      registrationConfirmations: normalizeRegistrationConfirmations(payload.registrationConfirmations),
    } : {}),
    registrationOptionalDocumentNotes: normalizeRegistrationOptionalDocumentNotes(
      payload.registrationOptionalDocumentNotes,
    ),
    checkout: normalizeProjectCheckout(payload.checkout, settlementDetailsEnabled),
    contractStart: readOptionalText(payload.contractStart),
    contractEnd: readOptionalText(payload.contractEnd),
    contractEndUndecided: Object.hasOwn(payload, 'contractEndUndecided')
      ? (payload.contractEndUndecided === true ? true : undefined)
      : (currentProject.contractEndUndecided === true ? true : undefined),
    contractType: normalizeProjectContractType(payload.contractType),
    settlementType,
    basis: registrationVersion === 2 || settlementDetailsEnabled ? basis : 'NONE',
    accountType: !settlementDetailsEnabled ? 'NONE' : normalizeAccountType(readOptionalText(payload.accountType)),
    settlementSystem: !settlementDetailsEnabled ? 'NONE' : normalizeSettlementSystemCode(payload.settlementSystem),
    settlementSystemOther: settlementDetailsEnabled && normalizeSettlementSystemCode(payload.settlementSystem) === 'OTHER'
      ? normalizeSettlementSystemOther(payload.settlementSystemOther)
      : undefined,
    laborSettlementBasis: !settlementDetailsEnabled
      ? 'NONE'
      : normalizeLaborSettlementBasis(payload.laborSettlementBasis),
    laborTransferPlan: normalizeLaborTransferPlan(payload.laborTransferPlan),
    fundInputMode: normalizeProjectFundInputMode(readOptionalText(payload.fundInputMode)),
    settlementSheetPolicy: payload.settlementSheetPolicy,
    paymentPlan: payload.paymentPlan || currentProject.paymentPlan || { contract: 0, interim: 0, final: 0 },
    paymentExpectedMonths: normalizePaymentExpectedMonths(
      payload.paymentExpectedMonths || currentProject.paymentExpectedMonths,
    ),
    finalPaymentExpectedWeek: readOptionalText(payload.finalPaymentExpectedWeek),
    interestRefundPolicy: readOptionalText(payload.interestRefundPolicy)
      || readOptionalText(currentProject.interestRefundPolicy)
      || undefined,
    quoteSubmissionDeferred: payload.quoteSubmissionDeferred === true,
    advanceInterimBelow70Reason: readOptionalText(payload.advanceInterimBelow70Reason),
    paymentPlanDesc: readOptionalText(payload.paymentPlanDesc),
    settlementGuide: readOptionalText(payload.settlementGuide),
    ...(Object.hasOwn(payload, 'finalPaymentNote') ? {
      finalPaymentNote: readOptionalText(payload.finalPaymentNote),
    } : {}),
    projectPurpose: readOptionalText(payload.projectPurpose),
    registeredById: managerId,
    registeredByName: managerName,
    registeredByEmail: readOptionalText(payload.registeredByEmail) || readOptionalText(currentProject.registeredByEmail),
    executiveApproverId: readOptionalText(payload.executiveApproverId) || readOptionalText(currentProject.executiveApproverId),
    executiveApproverName: readOptionalText(payload.executiveApproverName) || readOptionalText(currentProject.executiveApproverName),
    executiveApproverEmail: readOptionalText(payload.executiveApproverEmail) || readOptionalText(currentProject.executiveApproverEmail),
    managerId,
    managerName,
    teamName: readOptionalText(payload.teamName),
    ...(updatesTeamMembers ? { teamMembersDetailed } : {}),
    participantCondition: readOptionalText(payload.participantCondition),
    note: readOptionalText(payload.note),
    ...Object.fromEntries(PROJECT_INFO_DOCUMENT_FIELDS.map((field) => [field, payload[field] === undefined ? currentProject[field] ?? null : payload[field] || null])),
    contractAnalysis: payload.contractAnalysis || null,
    budgetCurrentYear: Number.isFinite(Number(payload.contractAmount))
      ? Math.max(0, Math.round(Number(payload.contractAmount)))
      : currentProject.budgetCurrentYear,
  }), 'totalRevenueAmount');
}

export function buildProjectPatchFromChangeRequestPayload(payload = {}, currentProject = {}) {
  return buildProjectPatchFromChangeRequestPayloadInternal(payload, currentProject);
}

const PROJECT_INFO_CHANGE_LABELS = {
  name: '프로젝트명',
  officialContractName: '공식 계약명',
  clientOrg: '계약 대상',
  businessManagementGoogleFolderLink: '사업관리 구글폴더링크',
  participationSheetLink: '참여율 시트 링크',
  department: '담당조직(CIC)',
  type: '프로젝트 유형',
  status: '프로젝트 진행 상태',
  phase: '프로젝트 구분',
  groupwareName: '그룹웨어명',
  contractType: '계약서 유형',
  contractStart: '계약 시작일',
  contractEnd: '계약 종료일',
  contractEndUndecided: '종료 기간 없음',
  currency: '통화',
  contractAmount: '계약금액',
  salesVatAmount: '총매출부가세',
  totalRevenueAmount: '총수익',
  totalActualCost: '총실비(원가)',
  supportAmount: '총지원금',
  settlementType: '정산 유형',
  basis: '정산 기준',
  accountType: '통장 유형',
  settlementSystem: '정산 시스템',
  settlementSystemOther: '기타 정산 시스템',
  settlementGuide: '정산 가이드',
  laborSettlementBasis: '인건비 정산 기준',
  laborTransferPlan: 'MYSC 인건비 이관 계획',
  fundInputMode: '자금 입력 방식',
  registeredByName: '최종 보고자 (실무책임자)',
  executiveApproverName: '최종 결재자 (총괄책임자)',
  teamName: '사내기업팀',
  teamMembersDetailed: '서류상 참여인력',
  staffing: '실제 투입인력',
  participantCondition: '참여 조건',
  paymentPlan: '입금 분할',
  paymentExpectedMonths: '입금 예상월',
  finalPaymentExpectedWeek: '최종 입금 예상 주차',
  interestRefundPolicy: '이자 반납 여부',
  quoteSubmissionDeferred: '산출내역서 이후 제출',
  advanceInterimBelow70Reason: '선금·중도금 70% 미만 사유',
  paymentPlanDesc: '입금 계획',
  finalPaymentNote: '최종 입금 메모',
  projectPurpose: '프로젝트 목적',
  description: '주요 내용',
  note: '비고',
  registrationOptionalDocumentNotes: '원본 파일 미첨부 사유',
  financialYears: '연도별 재무',
  registrationConfirmations: '등록 확인사항',
  checkout: '종료사업 체크아웃',
  ...PROJECT_DOCUMENT_LABEL_BY_FIELD,
};

const PROJECT_INFO_PAYLOAD_FIELDS = [
  'name', 'officialContractName', 'type', 'status', 'phase', 'description', 'clientOrg', 'businessManagementGoogleFolderLink',
  'participationSheetLink',
  'department', 'groupwareName', 'currency', 'contractAmount', 'salesVatAmount',
  'totalRevenueAmount', 'totalActualCost', 'supportAmount', 'financialInputFlags', 'registrationRequirementsVersion',
  'financialYears', 'registrationConfirmations', 'registrationOptionalDocumentNotes', 'checkout', 'contractStart', 'contractEnd', 'contractEndUndecided',
  'contractType', 'settlementType', 'basis', 'accountType', 'settlementSystem', 'settlementSystemOther',
  'laborSettlementBasis', 'laborTransferPlan', 'fundInputMode', 'settlementSheetPolicy', 'paymentPlan',
  'paymentExpectedMonths', 'finalPaymentExpectedWeek', 'interestRefundPolicy', 'quoteSubmissionDeferred',
  'advanceInterimBelow70Reason', 'paymentPlanDesc', 'settlementGuide',
  'finalPaymentNote', 'projectPurpose', 'registeredById', 'registeredByName',
  'registeredByEmail', 'executiveApproverId', 'executiveApproverName', 'executiveApproverEmail',
  'managerId', 'managerName', 'teamName', 'teamMembers',
  'teamMembersDetailed', 'staffing', 'participantCondition', 'note', ...PROJECT_INFO_DOCUMENT_FIELDS,
  'contractAnalysis',
];

function projectInfoChangeValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? '예' : '아니오';
  if (typeof value === 'object') {
    if (readOptionalText(value?.name)) return readOptionalText(value.name);
    return JSON.stringify(value);
  }
  return String(value);
}

function projectStaffingChangeValue(value) {
  const staffing = normalizeProjectStaffingForWrite(value);
  const slotLabel = (slot) => (slot ? (slot.nickname || slot.name || slot.personId) : '미정');
  return [
    `총괄 ${slotLabel(staffing.lead)}`,
    `실무 ${slotLabel(staffing.pm)}`,
    `운영 ${staffing.operators.length ? staffing.operators.map((slot) => slot.nickname || slot.name || slot.personId).join('·') : '미정'}`,
    ...(staffing.others.length
      ? [staffing.others.map((item) => `${item.role} ${slotLabel(item.slot)}`).join(' / ')]
      : []),
    `정산지원 ${staffing.settlementSupport || '해당 없음'}`,
  ].join(' / ');
}

function projectInfoChanges(beforeSnapshot, proposedSnapshot) {
  return Object.entries(PROJECT_INFO_CHANGE_LABELS).flatMap(([key, label]) => {
    const format = key === 'staffing' ? projectStaffingChangeValue : projectInfoChangeValue;
    const before = format(beforeSnapshot[key]);
    const after = format(proposedSnapshot[key]);
    return before === after ? [] : [{ key, label, before, after }];
  });
}

function projectInfoPayloadWithDocuments(
  payload,
  project,
  attachmentRefs,
  trustedStoredDocuments = {},
  { validateParticipationSheetLink = true } = {},
) {
  const privateDocuments = registrationPrivateDocuments(attachmentRefs);
  const effectiveDocument = (field) => {
    if (privateDocuments[field]) return privateDocuments[field];
    if (Object.hasOwn(payload, field)) {
      const payloadPath = readOptionalText(payload[field]?.path);
      const canonicalPath = readOptionalText(project[field]?.path);
      if (payloadPath && canonicalPath && payloadPath === canonicalPath) return project[field];
      const storedPath = readOptionalText(trustedStoredDocuments[field]?.path);
      return payloadPath && storedPath && payloadPath === storedPath ? trustedStoredDocuments[field] : null;
    }
    return project[field] || null;
  };
  const normalizedPatch = buildProjectPatchFromChangeRequestPayloadInternal(payload, project, {
    validateParticipationSheetLink,
  });
  const proposedWithLegacyFallback = buildProjectRequestPayloadFromProject({ ...project, ...normalizedPatch }, payload);
  const proposed = Object.fromEntries(PROJECT_INFO_PAYLOAD_FIELDS.flatMap((field) => (
    Object.hasOwn(proposedWithLegacyFallback, field) ? [[field, proposedWithLegacyFallback[field]]] : []
  )));
  const contractDocument = effectiveDocument('contractDocument');
  const contractWasReplaced = Boolean(
    readOptionalText(contractDocument?.path)
    && readOptionalText(contractDocument?.path) !== readOptionalText(project.contractDocument?.path),
  );
  const contractAnalysis = Object.hasOwn(payload, 'contractAnalysis')
    ? payload.contractAnalysis
    : (contractWasReplaced ? null : project.contractAnalysis);
  return stripUndefinedDeep({
    ...proposed,
    ...Object.fromEntries(PROJECT_INFO_DOCUMENT_FIELDS.map((field) => [field, effectiveDocument(field)])),
    contractAnalysis: contractAnalysis && typeof contractAnalysis === 'object'
      ? contractAnalysis
      : null,
  });
}

export function buildProjectInfoDraftSeed(project, previousRequest) {
  const isResumableChange = readOptionalText(previousRequest?.requestKind) === 'CHANGE'
    && ['PENDING', 'REJECTED'].includes(readOptionalText(previousRequest?.status));
  const pendingPayload = isResumableChange
    ? (previousRequest.proposedSnapshot || previousRequest.payload)
    : null;
  if (pendingPayload && typeof pendingPayload === 'object' && !Array.isArray(pendingPayload)) {
    return projectInfoPayloadWithDocuments(
      pendingPayload,
      project,
      [],
      trustedStoredChangeRequestDocuments(previousRequest),
      { validateParticipationSheetLink: false },
    );
  }
  return projectInfoPayloadWithDocuments(
    buildProjectRequestPayloadFromProject(project),
    project,
    [],
    {},
    { validateParticipationSheetLink: false },
  );
}

export function buildProjectInfoChangeSubmission({
  tenantId,
  project,
  previousRequest,
  payload,
  attachmentRefs,
  actorId,
  actorName,
  actorEmail,
  timestamp,
  resubmit = false,
  reviewComment,
}) {
  const trustedStoredDocuments = trustedStoredChangeRequestDocuments(previousRequest);
  assertRegistrationPayload(payload, {
    participationSheetLinkRequired: registrationRequirementsVersion(payload.registrationRequirementsVersion) === 2
      && (
        registrationRequirementsVersion(project.registrationRequirementsVersion) !== 2
        || participationSheetFieldsChanged(payload, project)
      ),
  });
  if (registrationRequirementsVersion(payload.registrationRequirementsVersion) !== 2) {
    invalidRegistration('Project information changes require registration requirements version 2');
  }
  assertTrustedProjectInfoDocumentReferences(
    project,
    payload,
    attachmentRefs,
    trustedStoredDocuments,
  );
  assertRegistrationV2Requirements(
    payload,
    trustedRegistrationRequirementAttachments(project, payload, attachmentRefs, trustedStoredDocuments),
    false,
  );
  const beforeSnapshot = projectInfoPayloadWithDocuments(
    buildProjectRequestPayloadFromProject(project, previousRequest?.payload),
    project,
    [],
    {},
    { validateParticipationSheetLink: false },
  );
  const proposedSnapshot = projectInfoPayloadWithDocuments(
    payload,
    project,
    attachmentRefs,
    trustedStoredDocuments,
  );
  assertProjectCheckoutPayload(payload, attachmentRefs, proposedSnapshot);
  const changedFields = projectInfoChanges(beforeSnapshot, proposedSnapshot);
  const currentVersion = Number.isInteger(project.version) && project.version > 0 ? project.version : 1;
  const requestVersion = Number.isInteger(previousRequest?.requestVersion) && previousRequest.requestVersion > 0
    ? previousRequest.requestVersion + 1
    : 1;
  const managementPlanningResubmission = isManagementPlanningRevisionRejected(project);
  const executiveResubmission = isExecutiveRevisionRejected(project);
  const rejectedChangeRequest = isProjectChangeRequest(previousRequest)
    && readOptionalText(previousRequest?.status) === 'REJECTED';
  if (resubmit && !managementPlanningResubmission && !executiveResubmission && !rejectedChangeRequest) {
    throw createHttpError(409, 'Project is not awaiting resubmission', 'invalid_resubmit_state');
  }
  const projectRequestId = `change-${readOptionalText(project.id)}`;
  const projectRequest = stripUndefinedDeep({
    id: projectRequestId,
    tenantId,
    requestKind: 'CHANGE',
    targetProjectId: project.id,
    approvedProjectId: project.id,
    baseProjectVersion: currentVersion,
    targetProjectVersion: currentVersion + 1,
    requestVersion,
    beforeSnapshot,
    proposedSnapshot,
    changedFields,
    humanSummary: `${actorName || '요청자'}가 요청한 프로젝트 변경입니다. 기준 프로젝트 v${currentVersion} · 요청 v${requestVersion}`,
    status: 'PENDING',
    reviewOutcome: null,
    payload: proposedSnapshot,
    requestedBy: actorId,
    requestedByName: actorName,
    requestedByEmail: readOptionalText(actorEmail),
    requestedAt: timestamp,
    reviewedBy: null,
    reviewedByName: null,
    reviewedAt: null,
    reviewComment: readOptionalText(reviewComment) || null,
    rejectedReason: null,
    createdAt: previousRequest?.createdAt || timestamp,
    updatedAt: timestamp,
  });
  return { projectRequest };
}

function isProjectChangeRequest(request) {
  return readOptionalText(request?.requestKind) === 'CHANGE';
}

function projectRequestRequiresDesignatedApprover(request) {
  return isProjectChangeRequest(request)
    || (readOptionalText(request?.requestKind) === 'REGISTRATION'
      && registrationRequirementsVersion(request?.payload?.registrationRequirementsVersion) === 2);
}

function projectRequestForReview(request, tenantId) {
  return { ...request, attachmentReviewStatus: projectRequestAttachmentsArePublished(request, tenantId) ? 'READY' : 'REPAIR_REQUIRED' };
}

function resolveProjectRequestPayloadForReview(request) {
  if (isProjectChangeRequest(request) && request?.proposedSnapshot && typeof request.proposedSnapshot === 'object') {
    return request.proposedSnapshot;
  }
  return request?.payload || {};
}

function isCanonicalProjectRequestDocument(document, tenantId, projectId) {
  if (!projectId || projectId.includes('/')) return false;
  const prefix = `orgs/${tenantId}/project-registration-documents/${projectId}/`;
  const path = readOptionalText(document?.path);
  const objectName = path.startsWith(prefix) ? path.slice(prefix.length) : '';
  return Boolean(objectName && !objectName.includes('/') && !['.', '..'].includes(objectName));
}

function projectRequestAttachmentsArePublished(request, tenantId) {
  const payload = resolveProjectRequestPayloadForReview(request);
  if (projectRequestRequiresDesignatedApprover(request)
    && !PROJECT_INFO_DOCUMENT_FIELDS.every((field) => payload?.[field] == null
      || isCanonicalProjectRequestDocument(payload[field], tenantId, readOptionalText(request?.targetProjectId || request?.approvedProjectId)))) {
    return false;
  }
  const privatePrefix = `orgs/${tenantId}/project-registration-drafts/`;
  const hasUnpublishedAttachment = PROJECT_INFO_DOCUMENT_FIELDS.some((field) => (
    readOptionalText(payload?.[field]?.path).startsWith(privatePrefix)
  ));
  const registrationIsAwaitingPublication = readOptionalText(request?.requestKind) === 'REGISTRATION'
    && registrationRequirementsVersion(payload?.registrationRequirementsVersion) === 2
    && !hasCanonicalRegistrationV2Documents(request, payload, tenantId);
  return !hasUnpublishedAttachment && !registrationIsAwaitingPublication;
}

function assertProjectRequestAttachmentsPublished(request, tenantId) {
  if (!projectRequestAttachmentsArePublished(request, tenantId)) {
    throw createHttpError(
      409,
      'Submitted attachments are still being prepared for review',
      'project_attachments_processing',
    );
  }
}

async function assertProjectChangeRequestAttachmentsStored(request, tenantId, storageService) {
  if (!projectRequestRequiresDesignatedApprover(request)) return;
  const projectId = readOptionalText(request?.targetProjectId || request?.approvedProjectId);
  const payload = resolveProjectRequestPayloadForReview(request);
  const documents = PROJECT_INFO_DOCUMENT_FIELDS
    .map((field) => payload?.[field])
    .filter((document) => document != null);
  if (documents.length === 0) return;
  try {
    if (!projectId || typeof storageService?.inspectProjectRegistrationAttachment !== 'function') {
      throw new Error('Project attachment storage inspection is not configured');
    }
    await Promise.all(documents.map(async (document) => {
      if (!isCanonicalProjectRequestDocument(document, tenantId, projectId)) throw new Error('Project attachment path is invalid');
      const stored = await storageService.inspectProjectRegistrationAttachment({
        tenantId,
        projectId,
        path: document.path,
      });
      if (
        readOptionalText(stored?.path) !== readOptionalText(document?.path)
        || readOptionalText(stored?.attachmentId) !== readOptionalText(document?.attachmentId)
        || Number(stored?.size) !== Number(document?.size)
        || readOptionalText(stored?.contentType) !== readOptionalText(document?.contentType)
      ) throw new Error('Project attachment metadata does not match');
    }));
  } catch {
    throw createHttpError(
      422,
      '제출 파일을 확인할 수 없습니다. 다시 첨부해 주세요.',
      'project_attachment_unavailable',
    );
  }
}

function hasCanonicalRegistrationV2Documents(request, payload, tenantId) {
  const projectId = readOptionalText(request?.approvedProjectId || request?.targetProjectId);
  if (!projectId || projectId.includes('/')) return false;
  const isCanonicalDocument = (field) => isCanonicalProjectRequestDocument(payload?.[field], tenantId, projectId);
  const allExistingDocumentsAreCanonical = PROJECT_INFO_DOCUMENT_FIELDS.every((field) => (
    payload?.[field] == null || isCanonicalDocument(field)
  ));
  if (!allExistingDocumentsAreCanonical) return false;
  const hasRequiredDocument = (kind) => (
    isCanonicalDocument(REGISTRATION_REQUIREMENT_DOCUMENT_FIELDS[kind])
      || (kind === 'quote' && payload?.quoteSubmissionDeferred === true)
  );
  if (REGISTRATION_REQUIRED_DOCUMENT_KINDS.every(hasRequiredDocument)) return true;

  // Preserve approval of registrations already submitted under the former alternative-document contract.
  if (!['contract', 'customer_business_registration', 'quote'].every(hasRequiredDocument)) return false;
  const hasProposal = isCanonicalDocument(REGISTRATION_REQUIREMENT_DOCUMENT_FIELDS.proposal);
  const hasRfpEvidence = isCanonicalDocument(REGISTRATION_REQUIREMENT_DOCUMENT_FIELDS.rfp_request_evidence);
  if (hasProposal === hasRfpEvidence) return false;
  const optionalNotes = normalizeRegistrationOptionalDocumentNotes(payload.registrationOptionalDocumentNotes);
  return [
    ['proposal_word_original', 'proposalWordOriginal'],
    ['proposal_ppt_original', 'proposalPptOriginal'],
    ['presentation_ppt_original', 'presentationPptOriginal'],
  ].every(([documentKind, noteField]) => (
    isCanonicalDocument(REGISTRATION_REQUIREMENT_DOCUMENT_FIELDS[documentKind])
      || Boolean(optionalNotes[noteField])
  ));
}

function normalizeParticipationRate(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function normalizeMonth(value) {
  const text = readOptionalText(value);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text) ? text : '';
}

function normalizeProjectTeamMemberMonthlyRates(member, index = null, {
  contractStartMonth = '',
  contractEndMonth = '',
} = {}) {
  if (!Object.hasOwn(member || {}, 'monthlyRates')) return undefined;
  const source = member?.monthlyRates;
  const field = index === null
    ? 'teamMembersDetailed.monthlyRates'
    : `teamMembersDetailed.${index}.monthlyRates`;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    invalidRegistration(`Project registration ${field} is invalid`);
  }
  const start = normalizeMonth(member?.laborAllocationStartMonth);
  const end = normalizeMonth(member?.laborAllocationEndMonth);
  const normalizedContractStart = normalizeMonth(contractStartMonth);
  const normalizedContractEnd = normalizeMonth(contractEndMonth);
  const effectiveEnd = end && normalizedContractEnd
    ? (end < normalizedContractEnd ? end : normalizedContractEnd)
    : (end || normalizedContractEnd);
  if (!start || (end && start > end)) {
    invalidRegistration(`Project registration ${field} requires a valid labor allocation period`);
  }
  if (
    (normalizedContractStart && start < normalizedContractStart)
    || (normalizedContractEnd && start > normalizedContractEnd)
    || (end && normalizedContractStart && end < normalizedContractStart)
    || (end && normalizedContractEnd && end > normalizedContractEnd)
  ) {
    invalidRegistration(`Project registration ${field} is outside the project contract period`);
  }
  const normalized = {};
  for (const [yearMonth, rate] of Object.entries(source)) {
    if (!normalizeMonth(yearMonth)) {
      invalidRegistration(`Project registration ${field}.${yearMonth} is invalid`);
    }
    if (yearMonth < start || (effectiveEnd && yearMonth > effectiveEnd)) {
      invalidRegistration(`Project registration ${field}.${yearMonth} is outside the labor allocation period`);
    }
    if (rate !== null && (
      typeof rate !== 'number'
      || !Number.isFinite(rate)
      || rate < 0
      || rate > 100
    )) {
      invalidRegistration(`Project registration ${field}.${yearMonth} is invalid`);
    }
    normalized[yearMonth] = rate;
  }
  return normalized;
}

function normalizeProjectTeamMembersDetailed(value, {
  contractStartMonth = '',
  contractEndMonth = '',
} = {}) {
  return (Array.isArray(value) ? value : [])
    .map((member) => {
      const normalized = {
        personId: readOptionalText(member?.personId),
        memberName: readOptionalText(member?.memberName),
        memberNickname: readOptionalText(member?.memberNickname),
        role: readOptionalText(member?.role),
        participationRate: normalizeParticipationRate(member?.participationRate),
      };
      if (!normalized.personId) delete normalized.personId;
      if (typeof member?.isDocumentOnly === 'boolean') normalized.isDocumentOnly = member.isDocumentOnly;
      const laborAllocationStartMonth = normalizeMonth(member?.laborAllocationStartMonth);
      const laborAllocationEndMonth = normalizeMonth(member?.laborAllocationEndMonth);
      if (laborAllocationStartMonth) normalized.laborAllocationStartMonth = laborAllocationStartMonth;
      if (laborAllocationEndMonth) normalized.laborAllocationEndMonth = laborAllocationEndMonth;
      const monthlyRates = normalizeProjectTeamMemberMonthlyRates(member, null, {
        contractStartMonth,
        contractEndMonth,
      });
      if (monthlyRates !== undefined) normalized.monthlyRates = monthlyRates;
      return normalized;
    })
    .filter((member) => (
      member.memberName
      || member.memberNickname
      || member.role
      || member.participationRate > 0
      || member.laborAllocationStartMonth
      || member.laborAllocationEndMonth
      || Object.hasOwn(member, 'monthlyRates')
    ));
}

function normalizeSyncKeySegment(value, fallback = 'na') {
  const normalized = String(value || '')
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

/**
 * 참여행 연결 키를 팀원 명단 전체에서 한 번에 만든다. 키는 **사람만으로** 만든다.
 *
 * 예전에는 `닉네임__역할` 이었다. 사업의 역할명을 고치면 키가 통째로 바뀌고, 참여행 문서 ID 가
 * 이 키로 만들어지므로 같은 사람의 참여행 연결이 끊겼다(라이브 26건 중 16건이 이 경우).
 * 참여율은 사람 단위로 합산해 보여주므로 키가 역할까지 구분할 이유가 없다.
 *
 * 다만 한 사업에 같은 사람이 두 역할로 올라 있으면 그때만 역할을 덧붙인다 - 키가 겹치면
 * 참여행 문서 하나가 다른 하나를 덮어써 참여율이 조용히 사라지기 때문이다.
 */
export function buildProjectTeamMemberSyncKeys(teamMembers) {
  const members = Array.isArray(teamMembers) ? teamMembers : [];
  const descriptors = members.map((member) => {
    const isSheetBacked = Object.hasOwn(member || {}, 'monthlyRates');
    const nickname = readOptionalText(member?.memberNickname);
    const name = readOptionalText(member?.memberName);
    const placeholderNickname = ['미정', '채용예정'].some((prefix) => nickname.startsWith(prefix));
    return {
      isSheetBacked,
      person: normalizeSyncKeySegment(
        isSheetBacked && placeholderNickname && name ? name : (nickname || name),
        'member',
      ),
    };
  });
  const occurrences = new Map();
  for (const descriptor of descriptors) {
    if (descriptor.isSheetBacked) continue;
    occurrences.set(descriptor.person, (occurrences.get(descriptor.person) || 0) + 1);
  }
  const candidates = descriptors.map(({ person, isSheetBacked }, index) => {
    const stintStart = normalizeMonth(members[index]?.laborAllocationStartMonth);
    if (isSheetBacked) return `${person}__${stintStart || 'stint'}`;
    if (occurrences.get(person) === 1) return person;
    return `${person}__${normalizeSyncKeySegment(members[index]?.role, 'role')}`;
  });
  const candidateOccurrences = new Map();
  for (const candidate of candidates) {
    candidateOccurrences.set(candidate, (candidateOccurrences.get(candidate) || 0) + 1);
  }
  const seen = new Map();
  return candidates.map((candidate, index) => {
    if (
      candidateOccurrences.get(candidate) === 1
      || !readOptionalText(members[index]?.memberNickname || members[index]?.memberName)
    ) return candidate;
    const ordinal = (seen.get(candidate) || 0) + 1;
    seen.set(candidate, ordinal);
    return `${candidate}__${ordinal}`;
  });
}

export function resolveProjectTeamMemberLookupKeys(member) {
  return Array.from(new Set([
    readOptionalText(member?.memberNickname),
    readOptionalText(member?.memberName),
  ]
    .filter(Boolean)
    .map((value) => value.toLowerCase())));
}

export async function tryRenameManagedProjectRootFolder({
  driveService,
  projectId,
  projectName,
  existingFolderId,
  logger = console,
}) {
  if (
    !driveService
    || typeof driveService.renameManagedProjectRootFolder !== 'function'
    || !readOptionalText(existingFolderId)
  ) {
    return null;
  }

  try {
    return await driveService.renameManagedProjectRootFolder({
      projectId,
      projectName,
      existingFolderId,
    });
  } catch (error) {
    logger.error('[BFF] managed project root rename skipped:', error);
    return null;
  }
}

export async function tryEnsureProjectRootFolder({
  driveService,
  tenantId,
  projectId,
  projectName,
  existingFolderId,
  logger = console,
}) {
  if (
    !driveService
    || typeof driveService.ensureProjectRootFolder !== 'function'
  ) {
    return null;
  }

  try {
    return await driveService.ensureProjectRootFolder({
      tenantId,
      projectId,
      projectName,
      existingFolderId,
    });
  } catch (error) {
    logger.error('[BFF] managed project root provision skipped:', error);
    return null;
  }
}

export async function syncProjectParticipationEntries({
  db,
  tenantId,
  project,
  now,
  transaction = null,
}) {
  const teamMembers = normalizeProjectTeamMembersDetailed(project?.teamMembersDetailed, {
    contractStartMonth: readOptionalText(project?.contractStart).slice(0, 7),
    contractEndMonth: readOptionalText(project?.contractEnd).slice(0, 7),
  });
  const partEntriesRef = db.collection(`orgs/${tenantId}/partEntries`);
  const existingQuery = partEntriesRef.where('projectId', '==', project.id);
  const existingSnap = transaction
    ? await transaction.get(existingQuery)
    : await existingQuery.get();
  const existingSyncEntries = existingSnap.docs.filter((doc) => doc.data()?.source === 'PROJECT_TEAM_SYNC');

  const membersRef = db.collection(`orgs/${tenantId}/members`);
  const memberSnap = transaction
    ? await transaction.get(membersRef)
    : await membersRef.get();
  const members = memberSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
  const memberByIdentity = new Map();
  for (const member of members) {
    for (const key of [readOptionalText(member?.nickname), readOptionalText(member?.name)]) {
      if (key) memberByIdentity.set(key.toLowerCase(), member);
    }
  }

  const desiredEntries = new Map();
  const teamMemberSyncKeys = buildProjectTeamMemberSyncKeys(teamMembers);
  for (const [index, member] of teamMembers.entries()) {
    const personId = readOptionalText(member?.personId);
    if (!personId && !member.memberName && !member.memberNickname) continue;
    const key = teamMemberSyncKeys[index];
    const matchedMember = resolveProjectTeamMemberLookupKeys(member)
      .map((lookupKey) => memberByIdentity.get(lookupKey))
      .find(Boolean);
    const memberId = readOptionalText(matchedMember?.uid || matchedMember?.id)
      || `project-team:${key}`;
    const memberName = readOptionalText(matchedMember?.name)
      || member.memberNickname
      || member.memberName;
    const entryId = `pte-${project.id}-${key}`;
    const entry = {
      id: entryId,
      ...(personId ? { personId } : {}),
      memberId,
      memberName,
      projectId: project.id,
      projectName: project.name,
      projectShortName: readOptionalText(project.shortName) || undefined,
      rate: member.participationRate,
      settlementSystem: resolveParticipationSettlementSystem(project),
      clientOrg: readOptionalText(project.clientOrg),
      periodStart: member.laborAllocationStartMonth || readOptionalText(project.contractStart).slice(0, 7),
      periodEnd: member.laborAllocationEndMonth || readOptionalText(project.contractEnd).slice(0, 7),
      isDocumentOnly: member.isDocumentOnly === true,
      note: member.role,
      source: 'PROJECT_TEAM_SYNC',
      projectTeamMemberKey: key,
      updatedAt: now,
    };
    if (Object.hasOwn(member, 'monthlyRates')) {
      entry.monthlyRates = member.monthlyRates;
    }
    desiredEntries.set(entryId, entry);
  }

  const writer = transaction || db.batch();
  for (const [entryId, entry] of desiredEntries.entries()) {
    writer.set(partEntriesRef.doc(entryId), {
      ...entry,
      tenantId,
    });
  }
  for (const doc of existingSyncEntries) {
    if (desiredEntries.has(doc.id)) continue;
    writer.delete(doc.ref);
  }
  if (!transaction) await writer.commit();

}

export function createProjectRegistrationSubmittedOutboxHandler({
  db,
  driveService,
  projectRegistrationSlackService,
  projectRegistrationAttachmentStorageService,
  now = () => new Date().toISOString(),
}) {
  function assertAttachmentPublicationPending(project, request) {
    if (request.requestKind !== 'REGISTRATION' || request.status !== 'PENDING'
      || project.executiveReviewStatus !== 'PENDING' || project.managementPlanningReviewStatus !== 'PENDING') {
      throw new Error('Project registration has progressed beyond attachment publication');
    }
  }

  function assertCurrentClaim(outbox, event) {
    if (
      event?.claimToken
      && (outbox?.status !== 'PROCESSING' || outbox?.claimToken !== event.claimToken)
    ) {
      throw new Error('Project registration outbox claim is no longer current');
    }
  }

  async function mutateSideEffects(event, mutate) {
    const ref = db.doc(`outbox/${event.id}`);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Project registration outbox event is missing');
      const outbox = snap.data() || {};
      assertCurrentClaim(outbox, event);
      const current = outbox.sideEffects && typeof outbox.sideEffects === 'object'
        ? outbox.sideEffects
        : {};
      const next = await mutate({ ...current }, tx);
      if (!next) return false;
      tx.set(ref, { sideEffects: next }, { merge: true });
      return true;
    });
  }

  return async (event) => {
    const tenantId = readOptionalText(event?.tenantId);
    const projectId = readOptionalText(event?.payload?.projectId) || readOptionalText(event?.entityId);
    const projectRequestId = readOptionalText(event?.payload?.projectRequestId);
    if (!tenantId || !projectId || !projectRequestId) {
      throw new Error('Project registration outbox event is missing canonical IDs');
    }

    const projectRef = db.doc(`orgs/${tenantId}/projects/${projectId}`);
    const requestRef = db.doc(`orgs/${tenantId}/project_requests/${projectRequestId}`);
    let [projectSnap, requestSnap] = await Promise.all([projectRef.get(), requestRef.get()]);
    if (!projectSnap.exists || !requestSnap.exists) {
      throw new Error('Project registration canonical documents are missing');
    }
    let project = { id: projectId, ...(projectSnap.data() || {}) };
    const projectRequest = { id: projectRequestId, ...(requestSnap.data() || {}) };
    if (readOptionalText(projectRequest.approvedProjectId) !== projectId) {
      throw new Error('Project registration request does not match its project');
    }

    const timestamp = new Date(now()).toISOString();
    const attachmentRefs = Array.isArray(event?.payload?.attachmentRefs)
      ? event.payload.attachmentRefs
      : [];
    if (attachmentRefs.length === 0) {
      await mutateSideEffects(event, (sideEffects) => {
        if (['DONE', 'SKIPPED'].includes(sideEffects.registrationAttachments)) return null;
        return {
          ...sideEffects,
          registrationAttachments: 'SKIPPED',
          registrationAttachmentsAt: timestamp,
        };
      });
    } else {
      const draftId = readOptionalText(event?.payload?.draftId);
      if (!draftId || typeof projectRegistrationAttachmentStorageService?.relocateDraftAttachments !== 'function') {
        throw new Error('Project registration attachment relocation is not configured');
      }
      const attachmentIdempotencyKey = `outbox:${event.id}:registrationAttachments`;
      const shouldRelocate = await mutateSideEffects(event, async (sideEffects, tx) => {
        if (sideEffects.registrationAttachments === 'DONE') return null;
        assertAttachmentPublicationPending(project, projectRequest);
        await assertNoActiveProjectInfoDraft({ tx, db, tenantId, projectId });
        return {
          ...sideEffects,
          registrationAttachments: 'PROCESSING',
          registrationAttachmentsIdempotencyKey: attachmentIdempotencyKey,
          registrationAttachmentsClaimToken: event.claimToken || null,
          registrationAttachmentsProcessingAt: timestamp,
        };
      });
      if (shouldRelocate) {
        const changeRequestRef = db.doc(`orgs/${tenantId}/project_requests/change-${projectId}`);
        if ((await changeRequestRef.get()).exists) {
          throw new Error('A project change request supersedes registration attachment publication');
        }
        const requestSnapshot = stableStringify(requestSnap.data() || {});
        const relocated = await projectRegistrationAttachmentStorageService.relocateDraftAttachments({
          tenantId,
          draftId,
          projectId,
          attachmentRefs,
        });
        if (!Array.isArray(relocated) || relocated.length !== attachmentRefs.length) {
          throw new Error('Project registration attachment relocation returned an incomplete result');
        }
        const canonicalPrefix = `orgs/${tenantId}/project-registration-documents/${projectId}/`;
        for (const attachment of relocated) {
          const path = readOptionalText(attachment?.path);
          const objectName = path.startsWith(canonicalPrefix) ? path.slice(canonicalPrefix.length) : '';
          if (!PRIVATE_DOCUMENT_KINDS.includes(readOptionalText(attachment?.documentKind)) || !objectName || objectName.includes('/')) {
            throw new Error('Project registration attachment relocation returned an invalid path');
          }
        }
        const documents = Object.fromEntries(Object.entries(registrationPrivateDocuments(relocated)).filter(([, document]) => document !== null));
        await db.runTransaction(async (tx) => {
          const outboxRef = db.doc(`outbox/${event.id}`);
          const [currentProjectSnap, currentRequestSnap, outboxSnap, changeRequestSnap] = await Promise.all([
            tx.get(projectRef),
            tx.get(requestRef),
            tx.get(outboxRef),
            tx.get(changeRequestRef),
          ]);
          if (!currentProjectSnap.exists || !currentRequestSnap.exists || !outboxSnap.exists) {
            throw new Error('Project registration delivery records are missing');
          }
          const outbox = outboxSnap.data() || {};
          assertCurrentClaim(outbox, event);
          const sideEffects = outbox.sideEffects && typeof outbox.sideEffects === 'object'
            ? outbox.sideEffects
            : {};
          if (sideEffects.registrationAttachments === 'DONE') return;
          await assertNoActiveProjectInfoDraft({ tx, db, tenantId, projectId });
          if (changeRequestSnap.exists) {
            throw new Error('A project change request supersedes registration attachment publication');
          }
          if (sideEffects.registrationAttachmentsIdempotencyKey !== attachmentIdempotencyKey) {
            throw new Error('Project registration attachment delivery claim changed');
          }
          const currentRequest = currentRequestSnap.data() || {};
          const currentProject = currentProjectSnap.data() || {};
          assertAttachmentPublicationPending(currentProject, currentRequest);
          if (stableStringify(currentRequest) !== requestSnapshot) {
            throw new Error('Project registration request changed during attachment publication');
          }
          if (readOptionalText(currentRequest.approvedProjectId) !== projectId) {
            throw new Error('Project registration request does not match its project');
          }
          for (const [field, document] of Object.entries(documents)) {
            for (const existing of [currentProject[field], currentRequest.payload?.[field]]) {
              if (existing != null && stableStringify(existing) !== stableStringify(document)) {
                throw new Error('Project registration attachment was replaced before publication');
              }
            }
          }
          tx.set(projectRef, {
            ...documents,
            registrationAttachmentsPublishedAt: timestamp,
          }, { merge: true });
          tx.set(requestRef, {
            payload: {
              ...(currentRequest.payload && typeof currentRequest.payload === 'object' ? currentRequest.payload : {}),
              ...documents,
            },
            registrationAttachmentsPublishedAt: timestamp,
            updatedAt: timestamp,
          }, { merge: true });
          tx.set(outboxRef, {
            sideEffects: {
              ...sideEffects,
              registrationAttachments: 'DONE',
              registrationAttachmentsAt: timestamp,
              registrationAttachmentsClaimToken: null,
            },
          }, { merge: true });
        });
      }
      [projectSnap, requestSnap] = await Promise.all([projectRef.get(), requestRef.get()]);
      project = { id: projectId, ...(projectSnap.data() || {}) };
    }

    const driveConfig = typeof driveService?.getConfig === 'function' ? driveService.getConfig() : null;
    const driveEnabled = typeof driveService?.ensureProjectRootFolder === 'function'
      && (driveConfig ? Boolean(driveConfig.enabled && driveConfig.defaultParentFolderId) : true);
    if (!readOptionalText(project.evidenceDriveRootFolderId) && driveEnabled) {
      const folder = await driveService.ensureProjectRootFolder({
        tenantId,
        projectId,
        projectName: project.name || projectId,
        existingFolderId: project.evidenceDriveRootFolderId,
      });
      if (!readOptionalText(folder?.id)) throw new Error('Project registration Drive root was not created');
      const drivePatch = stripUndefinedDeep({
        evidenceDriveSharedDriveId: folder.driveId,
        evidenceDriveRootFolderId: folder.id,
        evidenceDriveRootFolderName: folder.name,
        evidenceDriveRootFolderLink: folder.webViewLink,
        evidenceDriveProvisionedAt: timestamp,
      });
      await projectRef.set(drivePatch, { merge: true });
      project = { ...project, ...drivePatch };
    }
    await mutateSideEffects(event, (sideEffects) => ({
      ...sideEffects,
      registrationDrive: readOptionalText(project.evidenceDriveRootFolderId) ? 'DONE' : 'SKIPPED',
      registrationDriveAt: timestamp,
    }));

    await db.runTransaction(async (tx) => {
      const outboxRef = db.doc(`outbox/${event.id}`);
      const [currentProjectSnap, outboxSnap] = await Promise.all([
        tx.get(projectRef),
        tx.get(outboxRef),
      ]);
      if (!currentProjectSnap.exists || !outboxSnap.exists) {
        throw new Error('Project registration delivery records are missing');
      }
      assertCurrentClaim(outboxSnap.data() || {}, event);
      await syncProjectParticipationEntries({
        db,
        transaction: tx,
        tenantId,
        project: { id: projectId, ...(currentProjectSnap.data() || {}) },
        now: timestamp,
      });
    });

    if (!projectRegistrationSlackService?.enabled) {
      await mutateSideEffects(event, (sideEffects) => {
        if (['DONE', 'SKIPPED'].includes(sideEffects.registrationSlack)) return null;
        return { ...sideEffects, registrationSlack: 'SKIPPED', registrationSlackAt: timestamp };
      });
      return;
    }
    if (typeof projectRegistrationSlackService.notifyMessage !== 'function') {
      throw new Error('Project registration Slack delivery is not configured');
    }
    const slackIdempotencyKey = `outbox:${event.id}:registrationSlack`;
    const shouldNotify = await mutateSideEffects(event, (sideEffects) => {
      if (sideEffects.registrationSlack === 'DONE') return null;
      return {
        ...sideEffects,
        registrationSlack: 'PROCESSING',
        registrationSlackIdempotencyKey: slackIdempotencyKey,
        registrationSlackClaimToken: event.claimToken || null,
        registrationSlackProcessingAt: timestamp,
      };
    });
    if (!shouldNotify) return;
    const slackPayload = buildProjectRegistrationSlackPayload(projectRequest);
    const delivery = { idempotencyKey: slackIdempotencyKey };
    if (typeof projectRegistrationSlackService.notifyMessageWithIdempotency === 'function') {
      await projectRegistrationSlackService.notifyMessageWithIdempotency(slackPayload, delivery);
    } else {
      await projectRegistrationSlackService.notifyMessage(slackPayload, delivery);
    }
    const markedDone = await mutateSideEffects(event, (sideEffects) => {
      if (sideEffects.registrationSlackIdempotencyKey !== slackIdempotencyKey) {
        throw new Error('Project registration Slack delivery claim changed');
      }
      return {
        ...sideEffects,
        registrationSlack: 'DONE',
        registrationSlackAt: timestamp,
        registrationSlackClaimToken: null,
      };
    });
    if (!markedDone) throw new Error('Project registration Slack delivery was not recorded');
  };
}

async function updateProjectTrashState({
  db,
  tenantId,
  projectId,
  actorId,
  actorEmail,
  now,
  expectedVersion,
  patch,
}) {
  const ref = db.doc(`orgs/${tenantId}/projects/${projectId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw createHttpError(404, `Project not found: ${projectId}`, 'not_found');
    }

    const current = snap.data() || {};
    const currentVersion = Number.isInteger(current.version) && current.version > 0 ? current.version : 1;
    if (expectedVersion !== currentVersion) {
      throw createHttpError(409, `Version mismatch: expected ${expectedVersion}, actual ${currentVersion}`, 'version_conflict');
    }

    const document = {
      ...current,
      ...patch,
      tenantId,
      version: currentVersion + 1,
      createdBy: current.createdBy || actorId,
      createdAt: current.createdAt || now,
      updatedBy: actorId,
      updatedAt: now,
    };

    tx.set(ref, document, { merge: true });
    return { version: currentVersion + 1, data: document };
  });
}

export function mountProjectRoutes(app, {
  db, now, idempotencyService, auditChainService, piiProtector,
  driveService,
  googleSheetsService,
  googleSheetMigrationAiService,
  projectRequestContractAiService,
  projectRequestContractStorageService,
  projectSheetSourceStorageService,
  projectRegistrationSlackService,
}) {
  // ── GET /api/v1/projects ─────────────────────────────────────────────────────
  app.get('/api/v1/projects', asyncHandler(async (req, res) => {
    const { tenantId } = req.context;
    assertActorRoleAllowed(req, ROUTE_ROLES.readCore, 'read projects');
    const limit = parseLimit(req.query.limit, 50, 200);
    const cursor = parseCursor(req.query.cursor);

    let query = db.collection(`orgs/${tenantId}/projects`).orderBy('__name__').limit(limit);
    if (cursor) query = query.startAfter(cursor);

    const snap = await query.get();
    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(buildListResponse(items, limit));
  }));

  /*
   * 기타 역할명 목록. 별도의 사전 컬렉션을 두지 않는다 - 역할명의 원천은 프로젝트 문서이고,
   * 사전을 따로 쓰기 시작하면 두 곳이 조용히 갈린다. 여기서는 이미 저장된 값을 모아 준다.
   * staffing 필드만 select 해서 문서 전체를 읽지 않는다.
   */
  app.get('/api/v1/projects/staffing-roles', asyncHandler(async (req, res) => {
    const { tenantId } = req.context;
    assertActorRoleAllowed(req, ROUTE_ROLES.readCore, 'read project staffing roles');
    const snap = await db.collection(`orgs/${tenantId}/projects`).select('staffing').get();
    const counts = new Map();
    for (const doc of snap.docs) {
      const others = doc.data()?.staffing?.others;
      if (!Array.isArray(others)) continue;
      for (const item of others) {
        const role = normalizeProjectStaffingRoleName(item && typeof item === 'object' ? item.role : '');
        if (!role) continue;
        counts.set(role, (counts.get(role) || 0) + 1);
      }
    }
    // 많이 쓰인 역할이 먼저. 같은 횟수면 가나다순 - 목록 순서가 매번 바뀌면 고르기 어렵다.
    const roles = [...counts.entries()]
      .sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0], 'ko-KR'))
      .map(([role]) => role);
    res.setHeader('cache-control', 'private, max-age=60');
    res.status(200).json({ roles });
  }));

  app.get('/api/v1/project-requests/assigned-to-me', asyncHandler(async (req, res) => {
    const { tenantId, actorId } = req.context;
    const { items, projects } = await readAssignedProjectRequests({ db, tenantId, actorId });
    res.setHeader('cache-control', 'private, no-store');
    res.status(200).json({ items, projects });
  }));

  app.post('/api/v1/project-requests/pending-changes', asyncHandler(async (req, res) => {
    const { tenantId, actorId } = req.context;
    const projectIds = parseProjectRequestQueryProjectIds(req.body?.projectIds);
    const items = await readPendingProjectChangeRequests({ db, tenantId, actorId, projectIds });
    res.setHeader('cache-control', 'private, no-store');
    res.status(200).json({ items });
  }));

  app.post('/api/v1/project-requests/review-inbox', asyncHandler(async (req, res) => {
    const { tenantId, actorId } = req.context;
    assertActorRoleAllowed(req, ['admin', 'finance'], 'read the project review inbox');
    await readProjectAttachmentMember({ db, tenantId, actorId });
    const projectIds = parseProjectRequestQueryProjectIds(req.body?.projectIds);
    const items = (await queryProjectRequestsByProjectIds({ db, tenantId, projectIds }))
      .map((projectRequest) => projectRequestForReview(projectRequest, tenantId));
    res.setHeader('cache-control', 'private, no-store');
    res.status(200).json({ items });
  }));

  app.get('/api/v1/projects/:projectId/latest-request', asyncHandler(async (req, res) => {
    const { tenantId, actorId } = req.context;
    const projectId = readOptionalText(req.params.projectId);
    if (!projectId || projectId.includes('/')) {
      throw createHttpError(400, 'Project request lookup is invalid', 'project_request_query_invalid');
    }
    const member = await readProjectAttachmentMember({ db, tenantId, actorId });
    const projectSnap = await db.doc(`orgs/${tenantId}/projects/${projectId}`).get();
    if (!projectSnap.exists) throw createHttpError(404, `Project not found: ${projectId}`, 'not_found');
    const project = projectSnap.data() || {};
    if (!hasProjectRequestAccess({ actorId, member, projectId, project })) {
      throw createHttpError(403, 'Project request access denied', 'forbidden');
    }
    const items = await queryProjectRequestsByProjectIds({ db, tenantId, projectIds: [projectId] });
    res.setHeader('cache-control', 'private, no-store');
    res.status(200).json({ item: items[0] ? projectRequestForReview(items[0], tenantId) : null });
  }));

  app.get('/api/v1/projects/:projectId/attachments/:documentKind', asyncHandler(async (req, res) => {
    const { tenantId, actorId } = req.context;
    const projectId = readOptionalText(req.params.projectId);
    const documentKind = readOptionalText(req.params.documentKind);
    const field = Object.hasOwn(PROJECT_DOCUMENT_FIELD_BY_KIND, documentKind) ? PROJECT_DOCUMENT_FIELD_BY_KIND[documentKind] : undefined;
    if (!projectId || !field) {
      throw createHttpError(400, 'Project attachment request is invalid', 'project_attachment_invalid');
    }
    const member = await readProjectAttachmentMember({ db, tenantId, actorId });
    const profile = member?.portalProfile && typeof member.portalProfile === 'object'
      ? member.portalProfile
      : {};
    const storedRole = normalizeRole(member?.role);
    const assignedProjectIds = new Set([
      member?.projectId,
      ...(Array.isArray(member?.projectIds) ? member.projectIds : []),
      profile.projectId,
      ...(Array.isArray(profile.projectIds) ? profile.projectIds : []),
    ].map(readOptionalText).filter(Boolean));
    const projectSnap = await db.doc(`orgs/${tenantId}/projects/${projectId}`).get();
    if (!projectSnap.exists) throw createHttpError(404, `Project not found: ${projectId}`, 'not_found');
    const project = projectSnap.data() || {};
    if (
      !['admin', 'finance'].includes(storedRole)
      && !assignedProjectIds.has(projectId)
      && readOptionalText(project.executiveApproverId) !== actorId
    ) {
      throw createHttpError(403, 'Project attachment access denied', 'forbidden');
    }
    const attachment = project[field];
    const path = readOptionalText(attachment?.path);
    const expectedPrefix = `orgs/${tenantId}/project-registration-documents/${projectId}/`;
    const objectName = path.startsWith(expectedPrefix) ? path.slice(expectedPrefix.length) : '';
    if (!objectName || objectName.includes('/')) {
      throw createHttpError(409, 'Project attachment is not ready', 'project_attachment_not_ready');
    }
    if (typeof projectRequestContractStorageService?.downloadProjectRegistrationAttachment !== 'function') {
      throw new Error('Project registration attachment storage is not configured');
    }
    const downloaded = await projectRequestContractStorageService.downloadProjectRegistrationAttachment({
      tenantId,
      projectId,
      path,
    });
    sendPrivateProjectAttachment(res, downloaded, attachment, objectName);
  }));

  /*
   * 종료사업 체크아웃 증빙 업로드.
   *
   * 초안·편집 리스를 거치지 않는다. 이미 승인이 끝난 사업의 마무리 증빙인데 수정 초안으로
   * 올리면 제출 시 `executiveReviewReopens` 가 조직장 결재를 다시 연다. 마무리 서류를
   * 붙였다고 결재가 풀리면 안 된다.
   *
   * 그래서 여기서는 문서 칸 하나와 version 만 올린다. 결재 관련 필드는 쓰지 않는다.
   */
  app.post('/api/v1/projects/:projectId/checkout-attachments/:documentKind', asyncHandler(async (req, res) => {
    const { tenantId, actorId, actorRole } = req.context;
    assertActorRoleAllowed(req, ROUTE_ROLES.writeCore, 'upload checkout attachments');
    const projectId = readOptionalText(req.params.projectId);
    const documentKind = readOptionalText(req.params.documentKind);
    // 체크아웃 증빙만 받는다. 등록 서류는 이 경로로 바꿀 수 없다.
    const field = {
      performance_certificate: 'performanceCertificateDocument',
      tax_invoice: 'taxInvoiceDocument',
      final_settlement_report: 'finalSettlementReportDocument',
      final_report: 'finalReportDocument',
    }[documentKind];
    if (!projectId || !field) {
      throw createHttpError(400, 'Checkout attachment request is invalid', 'checkout_attachment_invalid');
    }

    const fileName = readOptionalText(req.body?.fileName);
    const mimeType = readOptionalText(req.body?.mimeType) || 'application/pdf';
    const fileSize = Number(req.body?.fileSize);
    const contentBase64 = readOptionalText(req.body?.contentBase64);
    if (!fileName || !contentBase64 || !Number.isFinite(fileSize) || fileSize <= 0) {
      throw createHttpError(400, 'Checkout attachment payload is invalid', 'checkout_attachment_invalid');
    }
    const buffer = decodeCheckoutBase64(contentBase64, fileSize);
    const validationError = projectDocumentValidationError({ buffer, mimeType, fileName, documentKind });
    if (validationError) {
      throw createHttpError(422, validationError, 'checkout_attachment_rejected');
    }

    const projectRef = db.doc(`orgs/${tenantId}/projects/${projectId}`);
    const projectSnap = await projectRef.get();
    if (!projectSnap.exists) throw createHttpError(404, `Project not found: ${projectId}`, 'not_found');
    const project = projectSnap.data() || {};

    const member = await readProjectAttachmentMember({ db, tenantId, actorId });
    const profile = member?.portalProfile && typeof member.portalProfile === 'object' ? member.portalProfile : {};
    const storedRole = normalizeRole(member?.role) || normalizeRole(actorRole);
    const assignedProjectIds = new Set([
      member?.projectId,
      ...(Array.isArray(member?.projectIds) ? member.projectIds : []),
      profile.projectId,
      ...(Array.isArray(profile.projectIds) ? profile.projectIds : []),
    ].map(readOptionalText).filter(Boolean));
    if (
      !['admin', 'finance'].includes(storedRole)
      && !assignedProjectIds.has(projectId)
      && readOptionalText(project.executiveApproverId) !== actorId
    ) {
      throw createHttpError(403, 'Checkout attachment access denied', 'forbidden');
    }

    if (typeof projectRequestContractStorageService?.uploadProjectRegistrationAttachment !== 'function') {
      throw new Error('Project registration attachment storage is not configured');
    }
    const attachmentId = `att_${randomUUID().replace(/-/g, '')}`;
    const uploaded = await projectRequestContractStorageService.uploadProjectRegistrationAttachment({
      tenantId, projectId, attachmentId, fileName, mimeType, buffer,
    });

    const timestamp = now();
    const attachment = {
      attachmentId,
      documentKind,
      path: readOptionalText(uploaded?.path),
      name: readOptionalText(uploaded?.name) || fileName,
      size: buffer.byteLength,
      contentType: mimeType,
      uploadedAt: readOptionalText(uploaded?.uploadedAt) || timestamp,
    };
    const version = await db.runTransaction(async (tx) => {
      const snap = await tx.get(projectRef);
      if (!snap.exists) throw createHttpError(404, `Project not found: ${projectId}`, 'not_found');
      const current = snap.data() || {};
      const nextVersion = Number(current.version || 0) + 1;
      tx.update(projectRef, {
        [field]: attachment,
        version: nextVersion,
        updatedAt: timestamp,
        updatedBy: actorId,
      });
      return nextVersion;
    });

    res.status(200).json({ id: projectId, tenantId, version, updatedAt: timestamp, documentKind, attachment });
  }));

  app.get('/api/v1/project-requests/:requestId/attachments/:documentKind', asyncHandler(async (req, res) => {
    const { tenantId, actorId } = req.context;
    const requestId = readOptionalText(req.params.requestId);
    const documentKind = readOptionalText(req.params.documentKind);
    const field = Object.hasOwn(PROJECT_DOCUMENT_FIELD_BY_KIND, documentKind) ? PROJECT_DOCUMENT_FIELD_BY_KIND[documentKind] : undefined;
    if (!requestId || requestId.includes('/') || !field) {
      throw createHttpError(400, 'Project request attachment is invalid', 'project_request_attachment_invalid');
    }
    const member = await readProjectAttachmentMember({ db, tenantId, actorId });
    const projectRequest = await readProjectRequestById(db, tenantId, requestId);
    if (!projectRequest) throw createHttpError(404, `Project request not found: ${requestId}`, 'not_found');
    const projectId = readOptionalText(projectRequest.targetProjectId || projectRequest.approvedProjectId);
    const payload = resolveProjectRequestPayloadForReview(projectRequest);
    const storedRole = normalizeRole(member.role);
    const requestApproverId = readOptionalText(payload?.executiveApproverId);
    if (!['admin', 'finance'].includes(storedRole)) {
      let isDesignatedApprover = requestApproverId === actorId;
      if (!requestApproverId && projectId && !projectRequestRequiresDesignatedApprover(projectRequest)) {
        const projectSnap = await db.doc(`orgs/${tenantId}/projects/${projectId}`).get();
        isDesignatedApprover = projectSnap.exists
          && readOptionalText(projectSnap.data()?.executiveApproverId) === actorId;
      }
      if (!isDesignatedApprover) {
        throw createHttpError(403, 'Project attachment access denied', 'forbidden');
      }
    }
    const attachment = payload?.[field];
    const path = readOptionalText(attachment?.path);
    const expectedPrefix = `orgs/${tenantId}/project-registration-documents/${projectId}/`;
    const objectName = projectId && path.startsWith(expectedPrefix) ? path.slice(expectedPrefix.length) : '';
    if (!objectName || objectName.includes('/')) {
      throw createHttpError(409, 'Project request attachment is not ready', 'project_request_attachment_not_ready');
    }
    if (typeof projectRequestContractStorageService?.downloadProjectRegistrationAttachment !== 'function') {
      throw new Error('Project registration attachment storage is not configured');
    }
    const downloaded = await projectRequestContractStorageService.downloadProjectRegistrationAttachment({
      tenantId,
      projectId,
      path,
    });
    sendPrivateProjectAttachment(res, downloaded, attachment, objectName);
  }));

  // ── POST /api/v1/projects ────────────────────────────────────────────────────
  app.post('/api/v1/projects', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.writeCore, 'write projects');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const timestamp = now();
    const parsed = parseWithSchema(projectUpsertSchema, req.body, 'Invalid project payload');
    const { expectedProjectDocuments } = parsed;
    delete parsed.expectedProjectDocuments;
    const expectedVersion = parsed.expectedVersion;
    const driveConfig = typeof driveService?.getConfig === 'function' ? driveService.getConfig() : null;
    const projectRef = db.doc(`orgs/${tenantId}/projects/${parsed.id.trim()}`);
    const existingProjectSnap = await projectRef.get();
    const existingProject = existingProjectSnap.exists ? (existingProjectSnap.data() || {}) : null;
    if (!existingProject && normalizeRole(actorRole) === 'pm') {
      throw createHttpError(
        403,
        'PM project creation requires the project registration draft flow',
        'project_registration_draft_required',
      );
    }

    assertProjectPaymentExtensions(parsed);
    const hasSettlementSystem = Object.hasOwn(parsed, 'settlementSystem');
    const settlementSystem = hasSettlementSystem ? normalizeSettlementSystemCode(parsed.settlementSystem) : undefined;
    const financialYears = Array.isArray(parsed.financialYears)
      ? parsed.financialYears.map((row) => ({
        ...row,
        ...(row?.paymentExpectedMonths !== undefined ? {
          paymentExpectedMonths: normalizePaymentExpectedMonths(row.paymentExpectedMonths),
        } : {}),
        ...(Object.hasOwn(row || {}, 'advanceInterimBelow70Reason') ? {
          advanceInterimBelow70Reason: readOptionalText(row.advanceInterimBelow70Reason),
        } : {}),
      }))
      : parsed.financialYears;

    const effectiveParticipationSheetLink = Object.hasOwn(parsed, 'participationSheetLink')
      ? readOptionalText(parsed.participationSheetLink)
      : readOptionalText(existingProject?.participationSheetLink);
    const effectiveRegistrationVersion = registrationRequirementsVersion(
      Object.hasOwn(parsed, 'registrationRequirementsVersion')
        ? parsed.registrationRequirementsVersion
        : existingProject?.registrationRequirementsVersion,
    );
    const existingRegistrationVersion = registrationRequirementsVersion(
      existingProject?.registrationRequirementsVersion,
    );
    const updatesTeamMembers = Object.hasOwn(parsed, 'teamMembersDetailed');
    const updatesParticipationSheet = participationSheetFieldsChanged(parsed, existingProject || {});
    assertParticipationSheetLinkForTeamMembers(
      parsed.teamMembersDetailed,
      effectiveParticipationSheetLink,
      {
        required: effectiveRegistrationVersion === 2 && (
          !existingProject
          || existingRegistrationVersion !== 2
          || updatesParticipationSheet
        ),
      },
    );

    const projectPayload = normalizeProjectRevenueFields({
      ...stripServerManagedFields(stripExpectedVersion(parsed)),
      id: parsed.id.trim(),
      name: parsed.name.trim(),
      orgId: tenantId,
      currency: normalizeProjectCurrency(parsed.currency),
      ...(updatesTeamMembers ? {
        teamMembersDetailed: normalizeProjectTeamMembersDetailed(parsed.teamMembersDetailed, {
          contractStartMonth: readOptionalText(parsed.contractStart || existingProject?.contractStart).slice(0, 7),
          contractEndMonth: readOptionalText(parsed.contractEnd || existingProject?.contractEnd).slice(0, 7),
        }),
      } : {}),
      ...(hasSettlementSystem ? {
        settlementSystem,
        settlementSystemOther: settlementSystem === 'OTHER'
          ? normalizeSettlementSystemOther(parsed.settlementSystemOther)
          : undefined,
      } : {}),
      ...(Array.isArray(financialYears) ? { financialYears } : {}),
    }, 'totalRevenueAmount');

    const shouldProvisionProjectDriveRoot = !!(
      driveService
      && typeof driveService.ensureProjectRootFolder === 'function'
      && (driveConfig ? driveConfig.enabled && driveConfig.defaultParentFolderId : true)
      && !projectPayload.evidenceDriveRootFolderId
    );

    if (shouldProvisionProjectDriveRoot) {
      const folder = await tryEnsureProjectRootFolder({
        driveService,
        tenantId,
        projectId: projectPayload.id,
        projectName: projectPayload.name || projectPayload.id,
        existingFolderId: projectPayload.evidenceDriveRootFolderId,
      });
      if (folder) {
        projectPayload.evidenceDriveSharedDriveId = folder.driveId || projectPayload.evidenceDriveSharedDriveId || undefined;
        projectPayload.evidenceDriveRootFolderId = folder.id;
        projectPayload.evidenceDriveRootFolderName = folder.name;
        projectPayload.evidenceDriveRootFolderLink = folder.webViewLink || projectPayload.evidenceDriveRootFolderLink || undefined;
        projectPayload.evidenceDriveProvisionedAt = timestamp;
      }
    }

    const outboxEvent = createOutboxEvent({
      tenantId,
      requestId,
      eventType: 'project.upsert',
      entityType: 'project',
      entityId: projectPayload.id,
      payload: { name: projectPayload.name, expectedVersion: expectedVersion ?? null },
      createdAt: timestamp,
    });

    const result = await upsertVersionedDoc({
      db,
      path: `orgs/${tenantId}/projects/${projectPayload.id}`,
      payload: projectPayload,
      tenantId,
      actorId,
      now: timestamp,
      expectedVersion,
      outboxEvent,
      stageTransactionWrites: async ({ tx, document, current }) => {
        const changedDocuments = assertProjectDocumentOriginals(current, projectPayload, expectedProjectDocuments);
        if (updatesTeamMembers && Array.isArray(projectPayload.teamMembersDetailed)) {
          await syncProjectParticipationEntries({
            db,
            transaction: tx,
            tenantId,
            project: document,
            now: timestamp,
          });
        }
        if (Object.keys(changedDocuments).length) tx.update(projectRef, changedDocuments);
      },
    });

    const existingName = readOptionalText(existingProject?.name);
    const renamedProjectRoot = (
      !result.created
      && existingName
      && existingName !== projectPayload.name
    )
      ? await tryRenameManagedProjectRootFolder({
        driveService,
        projectId: projectPayload.id,
        projectName: projectPayload.name,
        existingFolderId: result.data.evidenceDriveRootFolderId,
      })
      : null;

    if (renamedProjectRoot?.name && renamedProjectRoot.name !== readOptionalText(result.data.evidenceDriveRootFolderName)) {
      const renamed = await mergeSystemManagedDoc({
        db,
        path: `orgs/${tenantId}/projects/${projectPayload.id}`,
        patch: {
          evidenceDriveRootFolderName: renamedProjectRoot.name,
          evidenceDriveRootFolderLink: renamedProjectRoot.webViewLink || undefined,
        },
        tenantId,
        actorId,
        now: timestamp,
        notFoundMessage: `Project not found: ${projectPayload.id}`,
      });
      result.version = renamed.version;
      result.data = renamed.data;
    }

    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    await auditChainService.append({
      tenantId,
      entityType: 'project',
      entityId: projectPayload.id,
      action: result.created ? 'CREATE' : 'UPSERT',
      actorId,
      actorRole,
      actorEmailEnc,
      requestId,
      details: `프로젝트 업데이트: ${projectPayload.name}`,
      metadata: { source: 'bff', version: result.version, outboxId: outboxEvent.id },
      timestamp,
    });

    const registrationSource = readOptionalText(result.data.registrationSource);
    if (
      result.created
      && registrationSource === 'pm_portal'
      && projectRegistrationSlackService?.enabled
      && typeof projectRegistrationSlackService.notifyMessage === 'function'
    ) {
      try {
        await projectRegistrationSlackService.notifyMessage(buildProjectCreatedSlackPayload(result.data, {
          tenantId,
          actorId,
          actorEmail,
        }));
      } catch (error) {
        console.error('[BFF] project registration Slack notification failed:', error);
      }
    }

    return {
      status: result.created ? 201 : 200,
      body: {
        id: projectPayload.id,
        tenantId,
        evidenceDriveRootFolderId: result.data.evidenceDriveRootFolderId || null,
        evidenceDriveRootFolderName: result.data.evidenceDriveRootFolderName || null,
        evidenceDriveRootFolderLink: result.data.evidenceDriveRootFolderLink || null,
        evidenceDriveSharedDriveId: result.data.evidenceDriveSharedDriveId || null,
        version: result.version,
        updatedAt: result.data.updatedAt,
      },
    };
  }));

  app.post('/api/v1/projects/:projectId/trash', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.writeCore, 'trash project');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const { projectId } = req.params;
    const timestamp = now();
    const parsed = parseWithSchema(projectTrashSchema, req.body, 'Invalid project trash payload');
    const result = await updateProjectTrashState({
      db,
      tenantId,
      projectId,
      actorId,
      actorEmail,
      now: timestamp,
      expectedVersion: parsed.expectedVersion,
      patch: {
        trashedAt: timestamp,
        trashedById: actorId,
        trashedByEmail: actorEmail || null,
        trashedReason: readOptionalText(parsed.reason) || null,
      },
    });

    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    await auditChainService.append({
      tenantId,
      entityType: 'project',
      entityId: projectId,
      action: 'TRASH',
      actorId,
      actorRole,
      actorEmailEnc,
      requestId,
      details: `프로젝트 휴지통 이동: ${result.data.name || projectId}`,
      metadata: {
        source: 'bff',
        version: result.version,
        trashedAt: result.data.trashedAt,
        reason: result.data.trashedReason || null,
      },
      timestamp,
    });

    return {
      status: 200,
      body: {
        id: projectId,
        tenantId,
        version: result.version,
        updatedAt: result.data.updatedAt,
        trashedAt: result.data.trashedAt,
      },
    };
  }));

  app.post('/api/v1/projects/:projectId/restore', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.writeCore, 'restore project');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const { projectId } = req.params;
    const timestamp = now();
    const parsed = parseWithSchema(projectRestoreSchema, req.body, 'Invalid project restore payload');
    const result = await updateProjectTrashState({
      db,
      tenantId,
      projectId,
      actorId,
      actorEmail,
      now: timestamp,
      expectedVersion: parsed.expectedVersion,
      patch: {
        trashedAt: null,
        trashedById: null,
        trashedByEmail: null,
        trashedReason: null,
      },
    });

    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    await auditChainService.append({
      tenantId,
      entityType: 'project',
      entityId: projectId,
      action: 'RESTORE',
      actorId,
      actorRole,
      actorEmailEnc,
      requestId,
      details: `프로젝트 복구: ${result.data.name || projectId}`,
      metadata: {
        source: 'bff',
        version: result.version,
      },
      timestamp,
    });

    return {
      status: 200,
      body: {
        id: projectId,
        tenantId,
        version: result.version,
        updatedAt: result.data.updatedAt,
      },
    };
  }));

  // ── Google Sheet import ──────────────────────────────────────────────────────
  app.post('/api/v1/projects/:projectId/google-sheet-import/preview', asyncHandler(async (req, res) => {
    const { tenantId } = req.context;
    assertActorRoleAllowed(req, ROUTE_ROLES.readCore, 'preview google sheet import');
    const { projectId } = req.params;
    const parsed = parseWithSchema(googleSheetImportPreviewSchema, req.body, 'Invalid google sheet preview payload');
    const googleAccessToken = readOptionalText(req.header('x-google-access-token'));

    await ensureDocumentExists(db, `orgs/${tenantId}/projects/${projectId}`, `Project not found: ${projectId}`);

    try {
      const preview = await googleSheetsService.previewSpreadsheet({
        value: parsed.value,
        sheetName: parsed.sheetName,
        accessToken: googleAccessToken || undefined,
      });
      res.status(200).json(preview);
    } catch (error) {
      if (error instanceof GoogleSheetsServiceError) throw createHttpError(error.statusCode, error.message, error.code);
      throw error;
    }
  }));

  app.post('/api/v1/projects/:projectId/google-sheet-import/analyze', asyncHandler(async (req, res) => {
    const { tenantId } = req.context;
    assertActorRoleAllowed(req, ROUTE_ROLES.readCore, 'analyze google sheet import');
    const { projectId } = req.params;
    const parsed = parseWithSchema(googleSheetImportAnalyzeSchema, req.body, 'Invalid google sheet analysis payload');

    await ensureDocumentExists(db, `orgs/${tenantId}/projects/${projectId}`, `Project not found: ${projectId}`);

    const analysis = await googleSheetMigrationAiService.analyzePreview({
      spreadsheetTitle: parsed.spreadsheetTitle,
      selectedSheetName: parsed.selectedSheetName,
      matrix: parsed.matrix,
    });
    res.status(200).json(analysis);
  }));

  // ── Sheet source upload ──────────────────────────────────────────────────────
  app.post('/api/v1/projects/:projectId/sheet-sources/upload', asyncHandler(async (req, res) => {
    const { tenantId, actorId } = req.context;
    assertActorRoleAllowed(req, ROUTE_ROLES.writeCore, 'upload project sheet source');
    const { projectId } = req.params;
    const parsed = parseWithSchema(projectSheetSourceUploadSchema, req.body, 'Invalid project sheet source upload payload');

    await ensureDocumentExists(db, `orgs/${tenantId}/projects/${projectId}`, `Project not found: ${projectId}`);

    const uploaded = await projectSheetSourceStorageService.uploadSource({
      tenantId, actorId, projectId,
      sourceType: parsed.sourceType,
      fileName: parsed.fileName,
      mimeType: parsed.mimeType,
      fileSize: parsed.fileSize,
      contentBase64: parsed.contentBase64,
    });

    const timestamp = uploaded.uploadedAt || now();
    const previewMatrix = parsed.previewMatrix || [];
    const metadata = {
      tenantId, projectId,
      sourceType: parsed.sourceType,
      sheetName: parsed.sheetName,
      fileName: uploaded.name,
      storagePath: uploaded.path,
      downloadURL: uploaded.downloadURL,
      contentType: uploaded.contentType,
      uploadedAt: timestamp,
      rowCount: parsed.rowCount,
      columnCount: parsed.columnCount,
      matchedColumns: parsed.matchedColumns || [],
      unmatchedColumns: parsed.unmatchedColumns || [],
      previewMatrix,
      ...(parsed.applyTarget ? { applyTarget: parsed.applyTarget } : {}),
      updatedAt: timestamp,
      updatedBy: actorId,
    };
    const firestoreMetadata = {
      ...metadata,
      previewMatrixRows: previewMatrix.map((cells) => ({ cells })),
    };
    delete firestoreMetadata.previewMatrix;

    await db.doc(`orgs/${tenantId}/projects/${projectId}/sheet_sources/${parsed.sourceType}`).set(firestoreMetadata, { merge: true });
    res.status(200).json(metadata);
  }));

  // ── Project request contract ─────────────────────────────────────────────────
  app.post('/api/v1/project-requests/contract/analyze', asyncHandler(async (req, res) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.readCore, 'analyze project request contract');
    const parsed = parseWithSchema(projectRequestContractAnalyzeSchema, req.body, 'Invalid project request contract analysis payload');
    const analysis = await projectRequestContractAiService.analyzeContract({
      fileName: parsed.fileName,
      documentText: parsed.documentText || '',
    });
    res.status(200).json(analysis);
  }));

  app.post('/api/v1/project-requests/contract/upload', asyncHandler(async (req, res) => {
    const { tenantId, actorId } = req.context;
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'upload project request contract');
    const parsed = parseWithSchema(projectRequestContractUploadSchema, req.body, 'Invalid project request contract upload payload');
    const uploaded = await projectRequestContractStorageService.uploadContract({
      tenantId, actorId,
      fileName: parsed.fileName,
      mimeType: parsed.mimeType,
      fileSize: parsed.fileSize,
      contentBase64: parsed.contentBase64,
    });
    res.status(200).json(uploaded);
  }));

  app.post(
    '/api/v1/project-requests/contract/process',
    express.raw({ type: ['application/octet-stream', 'application/pdf'], limit: process.env.BFF_JSON_LIMIT || '25mb' }),
    asyncHandler(async (req, res) => {
      const { tenantId, actorId } = req.context;
      assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'process project request contract');
      const fileName = decodeHeaderValue(req.header('x-file-name')) || 'contract.pdf';
      const mimeType = readOptionalText(req.header('x-file-type')) || req.header('content-type') || 'application/pdf';
      const fileSizeHeader = Number.parseInt(readOptionalText(req.header('x-file-size')), 10);
      const fileBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);

      if (!fileBuffer.byteLength) {
        throw createHttpError(400, 'Contract upload body is empty', 'empty_contract_upload');
      }

      const contractDocument = await projectRequestContractStorageService.uploadContract({
        tenantId, actorId, fileName, mimeType,
        fileSize: Number.isFinite(fileSizeHeader) ? fileSizeHeader : fileBuffer.byteLength,
        buffer: fileBuffer,
      });

      let documentText = '';
      try {
        documentText = await extractTextFromPdfBuffer(fileBuffer);
      } catch (error) {
        console.warn('[BFF] contract pdf text extraction failed:', error);
      }

      const analysis = await projectRequestContractAiService.analyzeContract({
        fileName,
        documentText: documentText || fileName,
      });

      res.status(200).json({ contractDocument, analysis });
    }),
  );

  app.post('/api/v1/project-requests/:requestId/notify-registration', createMutatingRoute(idempotencyService, async (req) => {
    const { tenantId } = req.context;
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'notify project registration');
    const requestId = readOptionalText(req.params.requestId);

    if (!requestId) {
      throw createHttpError(400, 'project request id is required', 'missing_project_request_id');
    }

    if (!projectRegistrationSlackService?.enabled || typeof projectRegistrationSlackService.notifyMessage !== 'function') {
      return {
        status: 200,
        body: {
          ok: true,
          enabled: false,
          delivered: false,
          reason: 'slack_not_configured',
          requestId,
        },
      };
    }

    const projectRequest = await readProjectRequestById(db, tenantId, requestId);
    if (!projectRequest) {
      throw createHttpError(404, `Project request not found: ${requestId}`, 'not_found');
    }

    await projectRegistrationSlackService.notifyMessage(buildProjectRegistrationSlackPayload(projectRequest));

    return {
      status: 200,
      body: {
        ok: true,
        enabled: true,
        delivered: true,
        requestId,
        projectId: readOptionalText(projectRequest.approvedProjectId) || null,
      },
    };
  }));

  app.post('/api/v1/projects/:projectId/executive-review', createMutatingRoute(idempotencyService, async (req) => {
    const { tenantId, actorId, actorEmail, actorName } = req.context;
    assertActorRoleAllowed(req, PROJECT_REQUEST_ROUTE_ROLES, 'review project executive status');
    const projectId = readOptionalText(req.params.projectId);
    if (!projectId) {
      throw createHttpError(400, 'project id is required', 'missing_project_id');
    }

    const parsed = parseWithSchema(projectExecutiveReviewSchema, req.body, 'Invalid executive review payload');
    if (parsed.reviewStatus === 'PLANNING_AGREED') {
      throw createHttpError(
        409,
        'New planning agreements must be completed after organization-head approval',
        'legacy_planning_agreement_read_only',
      );
    }
    const projectPath = `orgs/${tenantId}/projects/${projectId}`;
    const reviewerName = readOptionalText(actorName) || readOptionalText(actorEmail) || actorId;
    const now = new Date().toISOString();
    await ensureDocumentExists(db, projectPath, `Project not found: ${projectId}`);
    const { request, requestId: resolvedRequestId, refs, requestSnapshots } = await resolveProjectRequestDocuments({
      db,
      tenantId,
      requestId: parsed.requestId,
      projectId,
    });
    if (projectRequestRequiresDesignatedApprover(request)
      && readOptionalText(resolveProjectRequestPayloadForReview(request)?.executiveApproverId) !== actorId) {
      throw createHttpError(403, 'Only the designated executive approver can review this project', 'executive_approver_mismatch');
    }
    if (parsed.reviewStatus === 'APPROVED') {
      assertProjectRequestAttachmentsPublished(request, tenantId);
      await assertProjectChangeRequestAttachmentsStored(
        request,
        tenantId,
        projectRequestContractStorageService,
      );
    }

    const projectResult = await mergeProjectAndRequestDocs({
      db,
      projectPath,
      buildProjectPatch: async (currentProject, currentRequest, _nextVersion, tx) => {
        const member = await readProjectAttachmentMember({ db, tenantId, actorId, tx });
        if (!PROJECT_REQUEST_ROUTE_ROLES.includes(normalizeRole(member.role))) {
          throw createHttpError(403, 'Project review access denied', 'forbidden');
        }
        const reviewRequest = currentRequest;
        const pendingChangeRequest = isProjectChangeRequest(reviewRequest)
          && readOptionalText(reviewRequest?.status) === 'PENDING';
        const previousStatus = pendingChangeRequest
          ? 'PENDING'
          : (readOptionalText(currentProject.executiveReviewStatus) || 'PENDING');
        const currentHistory = Array.isArray(currentProject.executiveReviewHistory) ? currentProject.executiveReviewHistory : [];
        const isLegacyPlanningAgreement = previousStatus === 'PLANNING_AGREED';
        const requestPayload = resolveProjectRequestPayloadForReview(reviewRequest);
        const requestApproverId = readOptionalText(requestPayload?.executiveApproverId);
        const requiresDesignatedApprover = projectRequestRequiresDesignatedApprover(reviewRequest);
        const designatedApproverId = requiresDesignatedApprover || (!isLegacyPlanningAgreement && requestApproverId)
          ? requestApproverId
          : readOptionalText(currentProject.executiveApproverId);
        if (!pendingChangeRequest && !['PENDING', 'PLANNING_AGREED'].includes(previousStatus)) {
          throw createHttpError(409, 'Project is not awaiting an organization-head decision', 'invalid_executive_review_state');
        }
        if ((requiresDesignatedApprover || designatedApproverId) && designatedApproverId !== actorId) {
          throw createHttpError(403, 'Only the designated executive approver can review this project', 'executive_approver_mismatch');
        }
        if (parsed.reviewStatus === 'APPROVED') {
          assertProjectRequestAttachmentsPublished(reviewRequest, tenantId);
        }
        const legacyProjectCode = isLegacyPlanningAgreement ? requireProjectCode(currentProject.projectCode) : null;
        const submittedCode = normalizeProjectCode(parsed.projectCode);
        if (isLegacyPlanningAgreement && submittedCode && requireProjectCode(submittedCode) !== legacyProjectCode) {
          throw createHttpError(422, 'projectCode cannot change after planning agreement', 'project_code_locked');
        }
        if (!isLegacyPlanningAgreement && submittedCode) {
          throw createHttpError(422, 'projectCode is issued by management planning after approval', 'project_code_management_only');
        }
        const isApprovedChangeRequest = parsed.reviewStatus === 'APPROVED' && isProjectChangeRequest(reviewRequest);
        const requestChanges = Array.isArray(reviewRequest?.changedFields) ? reviewRequest.changedFields : [];
        const payloadPatch = isApprovedChangeRequest
          ? buildProjectPatchFromChangeRequestPayload(requestPayload, currentProject)
          : {};
        return {
          ...payloadPatch,
          executiveReviewStatus: parsed.reviewStatus,
          executiveReviewedAt: now,
          executiveReviewedById: actorId,
          executiveReviewedByName: reviewerName,
          executiveReviewComment: readOptionalText(parsed.reviewComment) || null,
          ...(legacyProjectCode ? { projectCode: legacyProjectCode, projectCodeKey: legacyProjectCode } : {}),
          ...(parsed.reviewStatus === 'APPROVED' && !isLegacyPlanningAgreement && !readOptionalText(currentProject.managementPlanningReviewStatus) ? {
            managementPlanningReviewStatus: 'PENDING',
            managementPlanningReviewHistory: Array.isArray(currentProject.managementPlanningReviewHistory)
              ? currentProject.managementPlanningReviewHistory
              : [],
          } : {}),
          executiveReviewHistory: [
            ...currentHistory,
            {
              status: parsed.reviewStatus,
              previousStatus,
              reviewedAt: now,
              reviewedById: actorId,
              reviewedByName: reviewerName,
              reviewComment: readOptionalText(parsed.reviewComment) || null,
              ...(legacyProjectCode ? { projectCode: legacyProjectCode } : {}),
              ...(requestChanges.length > 0 ? { changes: requestChanges } : {}),
            },
          ],
          ...(parsed.reviewStatus === 'DUPLICATE_DISCARDED' ? {
            trashedAt: now,
            trashedById: actorId,
            trashedByEmail: readOptionalText(actorEmail) || null,
            trashedReason: readOptionalText(parsed.reviewComment),
          } : {}),
        };
      },
      buildRequestPatch: (_currentProject, currentRequest, nextVersion) => (
        !resolvedRequestId
          ? null
          : ({
        status: parsed.reviewStatus === 'APPROVED' ? 'APPROVED' : 'REJECTED',
        reviewOutcome: parsed.reviewStatus,
        reviewedBy: actorId,
        reviewedByName: reviewerName,
        reviewedAt: now,
        reviewComment: readOptionalText(parsed.reviewComment) || null,
        rejectedReason: parsed.reviewStatus === 'APPROVED' ? null : (readOptionalText(parsed.reviewComment) || null),
        approvedProjectId: projectId,
        targetProjectId: projectId,
        ...(parsed.reviewStatus === 'APPROVED' && isProjectChangeRequest(currentRequest || request) ? {
          approvedSnapshot: resolveProjectRequestPayloadForReview(currentRequest || request),
          approvedProjectVersion: nextVersion,
        } : {}),
        updatedAt: now,
          })
      ),
      requestRefs: resolvedRequestId ? refs : [],
      requestSnapshots,
      enforceChangeRequestVersion: isProjectChangeRequest(request),
      writeProject: parsed.reviewStatus === 'APPROVED' || !isProjectChangeRequest(request),
      tenantId,
      actorId,
      now,
      notFoundMessage: `Project not found: ${projectId}`,
      stageTransactionWrites: parsed.reviewStatus === 'APPROVED'
        ? async ({ tx, document, currentRequest }) => {
            if (!isProjectChangeRequest(currentRequest || request)) return;
            await syncProjectParticipationEntries({
              db,
              transaction: tx,
              tenantId,
              project: document,
              now,
            });
            tx.update(db.doc(projectPath), Object.fromEntries(PROJECT_INFO_DOCUMENT_FIELDS.map((field) => [field, document[field] ?? null])));
          }
        : undefined,
    });

    let slackDelivered = false;
    let slackReason = null;
    if (!projectRegistrationSlackService?.enabled || typeof projectRegistrationSlackService.notifyMessage !== 'function') {
      slackReason = 'slack_not_configured';
    } else {
      try {
        await projectRegistrationSlackService.notifyMessage(buildProjectExecutiveReviewSlackPayload({
          project: projectResult.data,
          projectRequest: projectResult.request || request,
          reviewStatus: parsed.reviewStatus,
          reviewComment: parsed.reviewComment,
          reviewerName,
        }));
        slackDelivered = true;
      } catch (error) {
        console.error('[BFF] executive review Slack notification failed:', error);
        slackReason = error instanceof Error ? error.message : 'slack_delivery_failed';
      }
    }

    return {
      status: 200,
      body: {
        ok: true,
        projectId,
        requestId: resolvedRequestId || null,
        reviewStatus: parsed.reviewStatus,
        reviewedAt: now,
        slackDelivered,
        slackReason,
      },
    };
  }));

  app.post('/api/v1/projects/:projectId/management-planning-review', createMutatingRoute(idempotencyService, async (req) => {
    const { tenantId, actorId, actorEmail, actorName } = req.context;
    assertActorRoleAllowed(req, ['admin', 'finance'], 'review project management planning status');
    const projectId = readOptionalText(req.params.projectId);
    if (!projectId) {
      throw createHttpError(400, 'project id is required', 'missing_project_id');
    }

    const parsed = parseWithSchema(
      projectManagementPlanningReviewSchema,
      req.body,
      'Invalid management planning review payload',
    );
    const projectPath = `orgs/${tenantId}/projects/${projectId}`;
    const reviewerName = readOptionalText(actorName) || readOptionalText(actorEmail) || actorId;
    const now = new Date().toISOString();
    const projectCode = parsed.reviewStatus === 'AGREED' ? requireProjectCode(parsed.projectCode) : null;
    const projectCodeClaimRef = projectCode
      ? db.doc(`orgs/${tenantId}/projectCodeClaims/${projectCode}`)
      : null;
    await ensureDocumentExists(db, projectPath, `Project not found: ${projectId}`);
    const { request, requestId: resolvedRequestId, refs, requestSnapshots } = await resolveProjectRequestDocuments({
      db,
      tenantId,
      requestId: parsed.requestId,
      projectId,
    });
    if (parsed.reviewStatus === 'AGREED') {
      assertProjectRequestAttachmentsPublished(request, tenantId);
      await assertProjectChangeRequestAttachmentsStored(request, tenantId, projectRequestContractStorageService);
    }
    let projectCodeClaimWrite = null;
    const projectResult = await mergeProjectAndRequestDocs({
      db,
      projectPath,
      buildProjectPatch: async (currentProject, currentRequest, _nextVersion, tx) => {
        projectCodeClaimWrite = null;
        const member = await readProjectAttachmentMember({ db, tenantId, actorId, tx });
        if (!['admin', 'finance'].includes(normalizeRole(member.role))) {
          throw createHttpError(403, 'Project management planning review access denied', 'forbidden');
        }
        const reviewRequest = currentRequest;
        const projectApproved = readOptionalText(currentProject.executiveReviewStatus) === 'APPROVED';
        const requestApproved = readOptionalText(reviewRequest?.status) === 'APPROVED';
        const hasExecutiveApproval = isProjectChangeRequest(reviewRequest)
          ? projectApproved && requestApproved
          : projectRequestRequiresDesignatedApprover(reviewRequest) ? projectApproved : projectApproved || requestApproved;
        if (!hasExecutiveApproval) {
          throw createHttpError(409, 'Organization-head approval is required before management planning review', 'executive_review_required');
        }
        if (hasLegacyPlanningAgreement(currentProject)) {
          throw createHttpError(
            409,
            'Legacy planning agreements are already finalised and cannot be reviewed again',
            'legacy_planning_agreement_already_finalized',
          );
        }
        const previousStatus = readOptionalText(currentProject.managementPlanningReviewStatus) || 'PENDING';
        if (!['PENDING', 'REVISION_REJECTED'].includes(previousStatus)) {
          throw createHttpError(409, 'Project is not awaiting management planning review', 'invalid_management_planning_review_state');
        }
        const currentHistory = Array.isArray(currentProject.managementPlanningReviewHistory)
          ? currentProject.managementPlanningReviewHistory
          : [];
        const isAgreed = parsed.reviewStatus === 'AGREED';
        if (isAgreed) assertProjectRequestAttachmentsPublished(reviewRequest, tenantId);
        if (isAgreed && projectCode && projectCodeClaimRef) {
          const existingProjectCode = normalizeProjectCode(currentProject.projectCode);
          if (existingProjectCode && existingProjectCode !== projectCode) {
            throw createHttpError(422, 'projectCode cannot change after it is assigned', 'project_code_locked');
          }
          const codeSnap = await tx.get(projectCodeClaimRef);
          const claim = codeSnap.exists ? (codeSnap.data() || {}) : {};
          if (codeSnap.exists && readOptionalText(claim.projectId) !== projectId) {
            throw createHttpError(409, 'Project code is already assigned to another project', 'project_code_conflict');
          }
          const projectsWithCodes = await tx.get(db.collection(`orgs/${tenantId}/projects`));
          const legacyConflict = projectsWithCodes.docs.find((projectDoc) => {
            if (projectDoc.id === projectId) return false;
            const candidate = projectDoc.data() || {};
            return [candidate.projectCodeKey, candidate.projectCode]
              .map(normalizeProjectCode)
              .includes(projectCode);
          });
          if (legacyConflict) {
            throw createHttpError(409, 'Project code is already assigned to another project', 'project_code_conflict');
          }
          projectCodeClaimWrite = {
            ref: projectCodeClaimRef,
            value: {
            tenantId,
            projectId,
            projectCode,
            projectCodeKey: projectCode,
            createdAt: readOptionalText(claim.createdAt) || now,
            updatedAt: now,
            },
          };
        }

        return {
          managementPlanningReviewStatus: parsed.reviewStatus,
          managementPlanningReviewedAt: now,
          managementPlanningReviewedById: actorId,
          managementPlanningReviewedByName: reviewerName,
          managementPlanningReviewComment: readOptionalText(parsed.reviewComment) || null,
          ...(projectCode ? { projectCode, projectCodeKey: projectCode } : {}),
          managementPlanningReviewHistory: [
            ...currentHistory,
            {
              status: parsed.reviewStatus,
              previousStatus,
              reviewedAt: now,
              reviewedById: actorId,
              reviewedByName: reviewerName,
              reviewComment: readOptionalText(parsed.reviewComment) || null,
              ...(projectCode ? { projectCode } : {}),
            },
          ],
        };
      },
      buildRequestPatch: (_currentProject, currentRequest, nextVersion) => {
        if (!resolvedRequestId) return null;
        if (isProjectChangeRequest(currentRequest || request)) return null;
        const isAgreed = parsed.reviewStatus === 'AGREED';
        const reviewComment = readOptionalText(parsed.reviewComment);
        if (!isAgreed) {
          return {
            status: 'PENDING',
            reviewOutcome: null,
            reviewedBy: null,
            reviewedByName: null,
            reviewedAt: null,
            reviewComment,
            rejectedReason: reviewComment,
            approvedProjectId: projectId,
            targetProjectId: projectId,
            updatedAt: now,
          };
        }
        return {
          status: 'APPROVED',
          reviewOutcome: 'APPROVED',
          reviewedBy: actorId,
          reviewedByName: reviewerName,
          reviewedAt: now,
          reviewComment: reviewComment || null,
          rejectedReason: null,
          approvedProjectId: projectId,
          targetProjectId: projectId,
          ...(isProjectChangeRequest(currentRequest || request)
            && readOptionalText((currentRequest || request)?.status) === 'PENDING' ? {
              approvedSnapshot: resolveProjectRequestPayloadForReview(currentRequest || request),
              approvedProjectVersion: nextVersion,
            } : {}),
          updatedAt: now,
        };
      },
      requestRefs: resolvedRequestId ? refs : [],
      requestSnapshots,
      tenantId,
      actorId,
      now,
      notFoundMessage: `Project not found: ${projectId}`,
      stageTransactionWrites: async ({ tx }) => {
        if (projectCodeClaimWrite) {
          tx.set(projectCodeClaimWrite.ref, projectCodeClaimWrite.value, { merge: true });
        }
      },
    });

    let slackDelivered = false;
    let slackReason = null;
    if (parsed.reviewStatus === 'AGREED') {
      if (!projectRegistrationSlackService?.enabled || typeof projectRegistrationSlackService.notifyMessage !== 'function') {
        slackReason = 'slack_not_configured';
      } else {
        try {
          await projectRegistrationSlackService.notifyMessage(buildProjectCodeRegisteredSlackPayload({
            project: projectResult.data,
            projectRequest: projectResult.request || request,
            projectCode,
            reviewerName,
          }));
          slackDelivered = true;
        } catch (error) {
          console.error('[BFF] project code Slack notification failed:', error);
          slackReason = error instanceof Error ? error.message : 'slack_delivery_failed';
        }
      }
    }

    return {
      status: 200,
      body: {
        ok: true,
        projectId,
        requestId: resolvedRequestId || null,
        reviewStatus: parsed.reviewStatus,
        projectCode,
        reviewedAt: now,
        slackDelivered,
        slackReason,
      },
    };
  }));

  app.post('/api/v1/projects/:projectId/executive-review/resubmit', createMutatingRoute(idempotencyService, async (req) => {
    const { tenantId, actorId, actorEmail } = req.context;
    assertActorRoleAllowed(req, ROUTE_ROLES.writeCore, 'resubmit project for executive review');
    const projectId = readOptionalText(req.params.projectId);
    if (!projectId) {
      throw createHttpError(400, 'project id is required', 'missing_project_id');
    }

    const parsed = parseWithSchema(projectExecutiveResubmitSchema, req.body, 'Invalid executive resubmit payload');
    const projectPath = `orgs/${tenantId}/projects/${projectId}`;
    const reviewerName = readOptionalText(parsed.reviewerName) || readOptionalText(actorEmail) || actorId;
    const now = new Date().toISOString();
    await ensureDocumentExists(db, projectPath, `Project not found: ${projectId}`);
    const { request, requestId: resolvedRequestId, refs } = await resolveProjectRequestDocuments({
      db,
      tenantId,
      requestId: parsed.requestId,
      projectId,
    });

    await mergeProjectAndRequestDocs({
      db,
      projectPath,
      buildProjectPatch: (currentProject) => {
        const previousStatus = readOptionalText(currentProject.executiveReviewStatus) || 'PENDING';
        if (isManagementPlanningRevisionRejected(currentProject)) {
          return buildManagementPlanningResubmissionPatch();
        }
        if (previousStatus !== 'REVISION_REJECTED') {
          throw createHttpError(409, 'Project is not awaiting resubmission', 'invalid_resubmit_state');
        }
        const currentHistory = Array.isArray(currentProject.executiveReviewHistory) ? currentProject.executiveReviewHistory : [];
        return {
          executiveReviewStatus: 'PENDING',
          executiveReviewedAt: now,
          executiveReviewedById: actorId,
          executiveReviewedByName: reviewerName,
          executiveReviewComment: readOptionalText(parsed.reviewComment) || null,
          executiveReviewHistory: [
            ...currentHistory,
            {
              status: 'PENDING',
              previousStatus,
              reviewedAt: now,
              reviewedById: actorId,
              reviewedByName: reviewerName,
              reviewComment: readOptionalText(parsed.reviewComment) || null,
            },
          ],
        };
      },
      buildRequestPatch: () => {
        if (!resolvedRequestId) return null;
        const requestPayload = resolveProjectRequestPayloadForReview(request);
        return {
          status: 'PENDING',
          reviewOutcome: null,
          reviewedBy: null,
          reviewedByName: null,
          reviewedAt: null,
          reviewComment: null,
          rejectedReason: null,
          approvedProjectId: projectId,
          targetProjectId: projectId,
          payload: requestPayload,
          ...(isProjectChangeRequest(request) ? { proposedSnapshot: requestPayload } : {}),
          updatedAt: now,
        };
      },
      requestRefs: resolvedRequestId ? refs : [],
      tenantId,
      actorId,
      now,
      notFoundMessage: `Project not found: ${projectId}`,
    });

    return {
      status: 200,
      body: {
        ok: true,
        projectId,
        requestId: resolvedRequestId || null,
        reviewStatus: 'PENDING',
        reviewedAt: now,
      },
    };
  }));

  // ── Evidence drive root (project-level) ─────────────────────────────────────
  app.post('/api/v1/projects/:projectId/evidence-drive/root/provision', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.writeProjectDrive, 'provision evidence drive root');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const { projectId } = req.params;
    const timestamp = now();

    const project = await ensureDocumentExists(db, `orgs/${tenantId}/projects/${projectId}`, `Project not found: ${projectId}`);

    let folder;
    try {
      folder = await driveService.ensureProjectRootFolder({
        tenantId, projectId,
        projectName: project.name || projectId,
        existingFolderId: project.evidenceDriveRootFolderId,
      });
    } catch (error) {
      if (error instanceof DriveServiceError) throw createHttpError(error.statusCode, error.message, error.code);
      throw error;
    }

    const result = await mergeSystemManagedDoc({
      db,
      path: `orgs/${tenantId}/projects/${projectId}`,
      patch: {
        evidenceDriveSharedDriveId: folder.driveId || project.evidenceDriveSharedDriveId || undefined,
        evidenceDriveRootFolderId: folder.id,
        evidenceDriveRootFolderName: folder.name,
        evidenceDriveRootFolderLink: folder.webViewLink || undefined,
        evidenceDriveProvisionedAt: timestamp,
      },
      tenantId,
      actorId,
      now: timestamp,
      notFoundMessage: `Project not found: ${projectId}`,
    });

    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    await auditChainService.append({
      tenantId,
      entityType: 'project',
      entityId: projectId,
      action: 'UPSERT',
      actorId,
      actorRole,
      actorEmailEnc,
      requestId,
      details: `프로젝트 증빙 루트 폴더 연결: ${folder.name}`,
      metadata: { source: 'bff', folderId: folder.id, folderName: folder.name, driveId: folder.driveId || null },
      timestamp,
    });

    return {
      status: 200,
      body: {
        projectId,
        folderId: folder.id,
        folderName: folder.name,
        webViewLink: folder.webViewLink || null,
        sharedDriveId: folder.driveId || null,
        version: result.version,
        updatedAt: result.data.updatedAt,
      },
    };
  }));

  app.post('/api/v1/projects/:projectId/evidence-drive/root/link', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.writeProjectDrive, 'link evidence drive root');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const { projectId } = req.params;
    const timestamp = now();
    const parsed = parseWithSchema(projectDriveRootLinkSchema, req.body, 'Invalid evidence drive root payload');
    const folderId = extractDriveFolderId(parsed.value);

    if (!folderId) {
      throw createHttpError(400, 'Google Drive 폴더 링크 또는 폴더 ID를 입력해 주세요.', 'invalid_drive_folder_link');
    }

    const project = await ensureDocumentExists(db, `orgs/${tenantId}/projects/${projectId}`, `Project not found: ${projectId}`);

    let folder;
    try {
      folder = await driveService.getFile(folderId);
    } catch (error) {
      if (error instanceof DriveServiceError) throw createHttpError(error.statusCode, error.message, error.code);
      throw error;
    }

    if (!folder) {
      throw createHttpError(404, `Google Drive 폴더를 찾을 수 없습니다: ${folderId}`, 'drive_folder_not_found');
    }
    if (folder.mimeType !== 'application/vnd.google-apps.folder') {
      throw createHttpError(400, '입력한 링크가 폴더가 아닙니다. Shared Drive 폴더 링크를 입력해 주세요.', 'drive_folder_required');
    }

    const result = await mergeSystemManagedDoc({
      db,
      path: `orgs/${tenantId}/projects/${projectId}`,
      patch: {
        evidenceDriveSharedDriveId: folder.driveId || project.evidenceDriveSharedDriveId || undefined,
        evidenceDriveRootFolderId: folder.id,
        evidenceDriveRootFolderName: folder.name,
        evidenceDriveRootFolderLink: folder.webViewLink || parsed.value,
        evidenceDriveProvisionedAt: timestamp,
      },
      tenantId,
      actorId,
      now: timestamp,
      notFoundMessage: `Project not found: ${projectId}`,
    });

    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    await auditChainService.append({
      tenantId,
      entityType: 'project',
      entityId: projectId,
      action: 'UPSERT',
      actorId,
      actorRole,
      actorEmailEnc,
      requestId,
      details: `프로젝트 증빙 루트 폴더 수동 연결: ${folder.name}`,
      metadata: { source: 'bff', folderId: folder.id, folderName: folder.name, driveId: folder.driveId || null, inputValue: parsed.value },
      timestamp,
    });

    return {
      status: 200,
      body: {
        projectId,
        folderId: folder.id,
        folderName: folder.name,
        webViewLink: folder.webViewLink || parsed.value,
        sharedDriveId: folder.driveId || null,
        version: result.version,
        updatedAt: result.data.updatedAt,
      },
    };
  }));
}
