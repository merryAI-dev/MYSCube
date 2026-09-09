/**
 * bff-utils.mjs
 * Pure utility functions and constants shared across BFF route modules.
 * Extracted from app.mjs to eliminate duplication.
 */

import { randomUUID } from 'node:crypto';
import { enqueueOutboxEventInTransaction } from './outbox.mjs';
import { actorHasPermission } from './rbac-policy.mjs';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

// 이 함수로 만든 오류는 문구를 개발자가 직접 정한 것이므로 그대로 응답에 실어도 안전하다.
// 예상하지 못한 예외(TypeError, Firestore 오류 등)는 이 표식이 없으므로 5xx에서 계속 가려진다.
// app.mjs 의 최종 오류 핸들러가 이 표식을 읽는다.
export function createHttpError(statusCode, message, code = 'request_error') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.expose = true;
  return error;
}

// 최종 오류 응답의 상태·코드·문구를 결정한다. app.mjs 의 오류 핸들러가 이 결과를 그대로 내보낸다.
// 판단 기준은 하나다. 문구를 개발자가 직접 정한 오류인가(createHttpError), 아니면 예상하지 못한
// 예외인가. 후자는 내부 정보를 담을 수 있으므로 5xx에서 가린다.
export function resolveErrorResponse(error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  const exposeMessage = statusCode < 500 || error?.expose === true;
  return {
    statusCode,
    code: error?.code || (statusCode >= 500 ? 'internal_error' : 'request_error'),
    message: exposeMessage ? (error?.message || 'Request failed') : 'Internal server error',
    exposed: exposeMessage,
  };
}

export function parseLimit(raw, fallback = 50, max = 200) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

export function parseCursor(raw) {
  const cursor = typeof raw === 'string' ? raw.trim() : '';
  return cursor || undefined;
}

export function buildListResponse(items, limit) {
  const nextCursor = items.length === limit ? items[items.length - 1]?.id || null : null;
  return { items, count: items.length, nextCursor };
}

// ── String helpers ────────────────────────────────────────────────────────────

export function readOptionalText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function truncateText(value, maxLength = 500) {
  const text = readOptionalText(value);
  if (!text) return '';
  if (!Number.isFinite(maxLength) || maxLength <= 1 || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

export function decodeHeaderValue(value) {
  const text = readOptionalText(value);
  if (!text) return '';
  try { return decodeURIComponent(text); } catch { return text; }
}

export function normalizeRole(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'viewer' ? 'pm' : normalized;
}

export function normalizeEntityType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// ── Entity path helpers ───────────────────────────────────────────────────────

export const ENTITY_COLLECTIONS = {
  project: 'projects',
  ledger: 'ledgers',
  transaction: 'transactions',
  expense_set: 'expense_sets',
  expense_sets: 'expense_sets',
  change_request: 'change_requests',
  change_requests: 'change_requests',
  member: 'members',
};

export function resolveEntityCollectionName(entityType) {
  return ENTITY_COLLECTIONS[normalizeEntityType(entityType)] || '';
}

export function resolveEntityDocPath(tenantId, entityType, entityId) {
  const collectionName = resolveEntityCollectionName(entityType);
  if (!collectionName) throw createHttpError(400, `Unsupported entityType: ${entityType}`);
  const normalizedId = typeof entityId === 'string' ? entityId.trim() : '';
  if (!normalizedId) throw createHttpError(400, 'entityId is required');
  return `orgs/${tenantId}/${collectionName}/${normalizedId}`;
}

// ── Object diff helpers ───────────────────────────────────────────────────────

export function flattenObjectPaths(value, basePath = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return basePath ? [basePath] : [];
  }
  const keys = Object.keys(value);
  if (!keys.length) return basePath ? [basePath] : [];
  const paths = [];
  for (const key of keys) {
    const nextPath = basePath ? `${basePath}.${key}` : key;
    const nextValue = value[key];
    if (nextValue && typeof nextValue === 'object' && !Array.isArray(nextValue)) {
      paths.push(...flattenObjectPaths(nextValue, nextPath));
    } else {
      paths.push(nextPath);
    }
  }
  return paths;
}

export function readByPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined;
    return acc[key];
  }, obj);
}

export function detectChangedFields(current, patch) {
  const paths = flattenObjectPaths(patch);
  return paths.filter((path) => {
    const before = readByPath(current, path);
    const after = readByPath(patch, path);
    return JSON.stringify(before) !== JSON.stringify(after);
  });
}

// ── Payload sanitizers ────────────────────────────────────────────────────────

export function stripExpectedVersion(payload) {
  const cloned = { ...payload };
  delete cloned.expectedVersion;
  return cloned;
}

export const SERVER_MANAGED_FIELDS = new Set([
  'tenantId', 'version', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt',
  'submittedBy', 'submittedAt', 'approvedBy', 'approvedAt', 'rejectedReason',
  'uploadedBy', 'uploadedAt', 'authorId',
]);

export function stripServerManagedFields(payload) {
  const sanitized = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (SERVER_MANAGED_FIELDS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export function stripUndefinedDeep(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefinedDeep(entry)).filter((entry) => entry !== undefined);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        const cleaned = stripUndefinedDeep(entry);
        return cleaned === undefined ? [] : [[key, cleaned]];
      }),
    );
  }
  return value;
}

// ── Domain helpers ────────────────────────────────────────────────────────────

export function assertReasonForRejected(state, reason) {
  if (state === 'REJECTED' && (!reason || !reason.trim())) {
    throw createHttpError(400, 'REJECTED transition requires a rejection reason');
  }
}

export function toDriveEvidenceDocId(fileId) {
  const normalized = readOptionalText(fileId).replace(/[^A-Za-z0-9_-]/g, '_');
  return normalized ? `evdrv_${normalized}` : `evdrv_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function chunkArray(items, chunkSize) {
  const result = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    result.push(items.slice(index, index + chunkSize));
  }
  return result;
}

export function resolveAutoLedgerName(project) {
  const accountType = readOptionalText(project?.accountType);
  if (accountType === 'DEDICATED') return '전용통장 원장';
  if (accountType === 'OPERATING') return '운영통장 원장';
  return '기본 원장';
}

// ── RBAC constants ────────────────────────────────────────────────────────────

export const ALL_INTERNAL_ROUTE_ROLES = ['admin', 'finance', 'pm', 'viewer', 'auditor', 'tenant_admin', 'support', 'security'];
export const CORE_WRITE_ROUTE_ROLES = ['admin', 'finance', 'pm', 'auditor', 'tenant_admin', 'support', 'security'];
export const PROJECT_REQUEST_ROUTE_ROLES = [...CORE_WRITE_ROUTE_ROLES, 'viewer'];

export const ROUTE_ROLES = {
  readCore: ALL_INTERNAL_ROUTE_ROLES,
  writeCore: CORE_WRITE_ROUTE_ROLES,
  writeCashflowWeek: ALL_INTERNAL_ROUTE_ROLES,
  writeTransaction: ALL_INTERNAL_ROUTE_ROLES,
  writeProjectDrive: ALL_INTERNAL_ROUTE_ROLES,
  writeEvidenceDrive: ALL_INTERNAL_ROUTE_ROLES,
  auditRead: ['admin', 'finance', 'auditor', 'tenant_admin', 'support', 'security'],
  memberWrite: ['admin', 'tenant_admin'],
  // 인력 명부는 재경팀이 실제로 기입한다. 계정 권한(memberWrite)과는 민감도가 달라 따로 둔다.
  personWrite: ['admin', 'tenant_admin', 'finance'],
};

// ── Audit helpers ─────────────────────────────────────────────────────────────

export async function encryptAuditEmail(piiProtector, email) {
  if (!email) return undefined;
  const encrypted = await piiProtector.encryptText(email);
  return encrypted?.ciphertext || undefined;
}

// ── Firestore helpers ─────────────────────────────────────────────────────────

export async function ensureDocumentExists(db, path, notFoundMessage) {
  const snap = await db.doc(path).get();
  if (!snap.exists) throw createHttpError(404, notFoundMessage, 'not_found');
  return snap.data();
}

export async function upsertVersionedDoc({
  db,
  path,
  payload,
  tenantId,
  actorId,
  now,
  expectedVersion,
  outboxEvent,
  stageTransactionWrites,
}) {
  const ref = db.doc(path);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);

    if (!snap.exists) {
      if (expectedVersion !== undefined && expectedVersion !== 0) {
        throw createHttpError(409, `Version mismatch: expected ${expectedVersion}, actual 0`, 'version_conflict');
      }
      const nextVersion = 1;
      const document = {
        ...payload, tenantId, version: nextVersion,
        createdBy: actorId, createdAt: now, updatedBy: actorId, updatedAt: now,
      };
      const sanitizedDocument = stripUndefinedDeep(document);
      if (typeof stageTransactionWrites === 'function') {
        await stageTransactionWrites({ tx, document: sanitizedDocument, current: null, created: true });
      }
      tx.set(ref, sanitizedDocument, { merge: true });
      if (outboxEvent) enqueueOutboxEventInTransaction(tx, db, outboxEvent);
      return { created: true, version: nextVersion, data: sanitizedDocument };
    }

    const current = snap.data() || {};
    const currentVersion = Number.isInteger(current.version) && current.version > 0 ? current.version : 1;

    if (expectedVersion === undefined) {
      throw createHttpError(409, `expectedVersion is required for update (current=${currentVersion})`, 'version_required');
    }
    if (expectedVersion !== currentVersion) {
      throw createHttpError(409, `Version mismatch: expected ${expectedVersion}, actual ${currentVersion}`, 'version_conflict');
    }

    const nextVersion = currentVersion + 1;
    const document = {
      ...current, ...payload, tenantId, version: nextVersion,
      createdBy: current.createdBy || actorId, createdAt: current.createdAt || now,
      updatedBy: actorId, updatedAt: now,
    };
    const sanitizedDocument = stripUndefinedDeep(document);
    if (typeof stageTransactionWrites === 'function') {
      await stageTransactionWrites({ tx, document: sanitizedDocument, current, created: false });
    }
    tx.set(ref, sanitizedDocument, { merge: true });
    if (outboxEvent) enqueueOutboxEventInTransaction(tx, db, outboxEvent);
    return { created: false, version: nextVersion, data: sanitizedDocument };
  });
}

export async function mergeSystemManagedDoc({ db, path, patch, tenantId, actorId, now, notFoundMessage }) {
  const ref = db.doc(path);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw createHttpError(404, notFoundMessage || `Document not found: ${path}`, 'not_found');

    const current = snap.data() || {};
    const currentVersion = Number.isInteger(current.version) && current.version > 0 ? current.version : 1;
    const nextVersion = currentVersion + 1;
    const document = {
      ...current, ...patch, tenantId, version: nextVersion,
      createdBy: current.createdBy || actorId, createdAt: current.createdAt || now,
      updatedBy: actorId, updatedAt: now,
    };
    tx.set(ref, stripUndefinedDeep(document), { merge: true });
    return { version: nextVersion, data: stripUndefinedDeep(document) };
  });
}

// ── Express middleware factories ──────────────────────────────────────────────

export function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

export function assertActorRoleAllowed(req, allowedRoles, action) {
  const actorRole = normalizeRole(req.context?.actorRole);
  if (!actorRole || !allowedRoles.includes(actorRole)) {
    throw createHttpError(403, `Role '${actorRole || 'unknown'}' is not allowed to ${action}`, 'forbidden');
  }
}

export function assertActorPermissionAllowed(policy, req, requiredPermission, action) {
  const actorRole = normalizeRole(req.context?.actorRole);
  if (!actorRole || !actorHasPermission(policy, { actorRole, permission: requiredPermission })) {
    throw createHttpError(403, `Role '${actorRole || 'unknown'}' lacks permission '${requiredPermission}' to ${action}`, 'forbidden');
  }
}

export function createMutatingRoute(idempotencyService, routeHandler) {
  return asyncHandler(async (req, res) => {
    const { tenantId, idempotencyKey, actorId, requestId } = req.context;

    const lock = await idempotencyService.begin({
      tenantId, idempotencyKey, method: req.method, path: req.path,
      body: req.body, actorId, requestId,
    });

    if (lock.mode === 'replay') {
      res.setHeader('x-idempotency-replayed', '1');
      res.status(lock.status).json(lock.body);
      return;
    }
    if (lock.mode === 'conflict') {
      res.status(409).json({ error: 'idempotency_conflict', message: lock.reason });
      return;
    }
    if (lock.mode === 'in_progress') {
      res.status(409).json({ error: 'idempotency_in_progress', message: lock.reason });
      return;
    }

    try {
      const result = await routeHandler(req, res);
      const status = result?.status ?? 200;
      const body = result?.body ?? null;
      await idempotencyService.complete({
        tenantId, idempotencyKey, requestFingerprint: lock.requestFingerprint,
        responseStatus: status, responseBody: body, requestId,
      });
      res.status(status).json(body);
    } catch (error) {
      await idempotencyService.fail({
        tenantId, idempotencyKey, requestFingerprint: lock.requestFingerprint, requestId, error,
      });
      throw error;
    }
  });
}
