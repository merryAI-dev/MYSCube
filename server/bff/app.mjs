import express from 'express';
import { randomUUID } from 'node:crypto';
import { assertProjectDocumentOriginals } from './project-document-validation.mjs';
import { createFirestoreDb, isFirestoreEmulatorEnabled, resolveProjectId } from './firestore.mjs';
import {
  createFirebaseAuthAdminService,
  createFirebaseTokenVerifier,
  resolveFirebaseAuthProjectId,
  resolveAuthMode,
  resolveRequestIdentity,
} from './auth.mjs';
import { createIdempotencyService } from './idempotency.mjs';
import { createAuditChainService } from './audit-chain.mjs';
import { createEditLeaseService } from './edit-lease.mjs';
import {
  DRAFT_ATTACHMENT_CLEANUP_EVENT_TYPE,
  createOutboxEvent,
  enqueueOutboxEventInTransaction,
  processOutboxBatch,
  processOutboxEventById,
} from './outbox.mjs';
import {
  createWorkQueueJob,
  enqueueReplayJobs,
  enqueueWorkQueueJobsInTransaction,
  processWorkQueueBatch,
} from './work-queue.mjs';
import {
  listSupportedViews,
} from './projections.mjs';
import {
  runPayrollWorker,
} from './payroll-worker.mjs';
import {
  resolveAffectedViews,
  resolveRelationRules,
  resolveRelationRulesPolicyPath,
} from './relation-rules.mjs';
import { createPiiProtector } from './pii-protection.mjs';
import { actorHasPermission, canActorAssignRole, loadRbacPolicy } from './rbac-policy.mjs';
import {
  createRequestId,
} from './utils.mjs';
import {
  clientErrorIngestSchema,
  commentCreateSchema,
  evidenceCreateSchema,
  evidenceDriveOverrideSchema,
  evidenceDriveUploadSchema,
  genericWriteSchema,
  googleSheetImportAnalyzeSchema,
  googleSheetImportPreviewSchema,
  ledgerUpsertSchema,
  memberRoleUpdateSchema,
  parseWithSchema,
  projectSheetSourceUploadSchema,
  projectRequestContractAnalyzeSchema,
  projectRequestContractUploadSchema,
  projectDriveRootLinkSchema,
  projectUpsertSchema,
  transactionStateSchema,
  transactionUpsertSchema,
} from './schemas.mjs';
import {
  assertTransitionAllowed,
  normalizeState,
} from './state-policy.mjs';
import { mountGuideChatRoutes } from './guide-chat.mjs';
import { mountClaudeSdkHelpRoutes } from './claude-sdk-help.mjs';
import {
  DriveServiceError,
  createGoogleDriveService,
  extractDriveFolderId,
  inferEvidenceCategoryFromFileName,
  resolveEvidenceSyncPatch,
} from './google-drive.mjs';
import {
  GoogleSheetsServiceError,
  createGoogleSheetsService,
} from './google-sheets.mjs';
import { createGoogleSheetMigrationAiService } from './google-sheet-migration-ai.mjs';
import { createProjectRequestContractAiService } from './project-request-contract-ai.mjs';
import {
  createDraftAttachmentCleanupOutboxHandler,
  createProjectRequestContractStorageService,
} from './project-request-contract-storage.mjs';
import { createProjectSheetSourceStorageService } from './project-sheet-source-storage.mjs';
import { createBusinessCardGeminiAiService } from './business-card-gemini-ai.mjs';
import { createBusinessCardStorageService } from './business-card-storage.mjs';
import { extractTextFromPdfBuffer } from './pdf-text.mjs';
import { createSlackAlertService } from './slack-alerts.mjs';
import {
  buildCashflowWeeklyDigestMessage,
  decodeStoredName,
  kstDayWindow,
  kstTimeLabel,
  selectCompletedInWindow,
} from './cashflow-weekly-digest.mjs';
import { updateCounterpartyHistory, lookupCounterpartyHistory } from './counterparty-budget-history.mjs';
import {
  assertBffRuntimeSafety,
  evaluateWorkerAuthorization,
  resolveBffRuntimeSafetyConfig,
  resolveBffWorkerAuthPolicy,
} from './runtime-safety.mjs';

import {
  createProjectRegistrationSubmittedOutboxHandler,
  mountProjectRoutes,
} from './routes/projects.mjs';
import { mountLedgerRoutes } from './routes/ledgers.mjs';
import { mountTransactionRoutes } from './routes/transactions.mjs';
import { mountAuditRoutes } from './routes/audit.mjs';
import { mountMemberRoutes } from './routes/members.mjs';
import { mountPersonRoutes } from './routes/persons.mjs';
import { mountPersonProfessionalProfileRoutes } from './routes/person-professional-profiles.mjs';
import { createPersonHrEvidenceStorageService } from './person-hr-evidence-storage.mjs';
import { mountCashflowExportRoutes } from './routes/cashflow-exports.mjs';
import { mountJvmWeeklyApiRoutes } from './routes/jvm-weekly-api.mjs';
import { createMcpOAuthService, mountMcpOAuthRoutes } from './mcp-oauth.mjs';
import { mountCashflowSheetLabRoutes } from './routes/cashflow-sheet-lab.mjs';
import { mountCashflowLaborRiskRoutes } from './routes/cashflow-labor-risk.mjs';
import { mountCashflowPeriodPolicyRoutes } from './routes/cashflow-period-policy.mjs';
import { createCashflowPeriodPolicyService } from './cashflow-period-policy-service.mjs';
import { createCashflowPeriodPolicyFirestoreAdapter } from './cashflow-period-policy-firestore-adapter.mjs';
import { mountParticipationDashboardRoutes } from './routes/participation-dashboard.mjs';
import { mountParticipationRosterRoutes } from './routes/participation-roster.mjs';
import {
  PARTICIPATION_ROSTER_CHANGED_EVENT_TYPE,
  createParticipationRosterChangedOutboxHandler,
} from './participation-roster-worker.mjs';
import { mountBusinessCardRoutes } from './routes/business-cards.mjs';
import { mountEditLeaseRoutes } from './routes/edit-leases.mjs';
import {
  createProjectRegistrationDraftService,
  mountProjectRegistrationDraftRoutes,
} from './routes/project-registration-drafts.mjs';
import {
  createProjectInfoDraftService,
  createProjectInfoSubmittedOutboxHandler,
  mountProjectInfoDraftRoutes,
} from './routes/project-info-drafts.mjs';
import {
  createCashflowEditDraftService,
  mountCashflowEditDraftRoutes,
} from './routes/cashflow-edit-drafts.mjs';
import { createHttpError, resolveErrorResponse } from './bff-utils.mjs';
import { getProfessionalProfileCatalog } from './professional-profile.mjs';

function formatSeoulDate(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function parseLimit(raw, fallback = 50, max = 200) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function parseCursor(raw) {
  const cursor = typeof raw === 'string' ? raw.trim() : '';
  return cursor || undefined;
}

function parseBearerToken(rawAuthorization) {
  const value = typeof rawAuthorization === 'string' ? rawAuthorization.trim() : '';
  if (!value) return '';
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function readOptionalText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveProjectRegistrationSlackConfig(options = {}, env = process.env) {
  const webhookUrl = readOptionalText(options.projectRegistrationSlackWebhookUrl)
    || readOptionalText(env.PROJECT_REGISTRATION_SLACK_WEBHOOK_URL)
    || undefined;
  const botToken = readOptionalText(options.projectRegistrationSlackBotToken)
    || readOptionalText(env.PROJECT_REGISTRATION_SLACK_BOT_TOKEN)
    || readOptionalText(env.SLACK_ALERT_BOT_TOKEN)
    || undefined;
  const channelId = readOptionalText(options.projectRegistrationSlackChannelId)
    || readOptionalText(env.PROJECT_REGISTRATION_SLACK_CHANNEL_ID)
    || readOptionalText(env.SLACK_ALERT_CHANNEL_ID)
    || 'C09BJ767XCM';

  return { webhookUrl, botToken, channelId };
}

function resolveCashflowSlackConfig(options = {}, env = process.env) {
  return {
    botToken: readOptionalText(options.cashflowSlackBotToken)
      || readOptionalText(env.CASHFLOW_SLACK_BOT_TOKEN)
      || readOptionalText(env.SLACK_ALERT_BOT_TOKEN)
      || undefined,
    channelId: readOptionalText(options.cashflowSlackChannelId)
      || readOptionalText(env.CASHFLOW_SLACK_CHANNEL_ID)
      || 'C0BQ6980HR6',
  };
}

function truncateText(value, maxLength = 500) {
  const text = readOptionalText(value);
  if (!text) return '';
  if (!Number.isFinite(maxLength) || maxLength <= 1 || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function decodeHeaderValue(value) {
  const text = readOptionalText(value);
  if (!text) return '';
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function parseAllowedOrigins(value) {
  const rawValue = String(value || '');
  const parsed = rawValue
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (parsed.length > 0) {
    return parsed;
  }

  return ['http://127.0.0.1:5173', 'http://localhost:5173'];
}

function isKnownMyscPreviewOrigin(origin) {
  return /^https:\/\/inner-platform(?:-[a-z0-9-]+)?-merryai-devs-projects\.vercel\.app$/i.test(origin);
}

function isKnownMyscVercelOrigin(origin, deployEnv = 'local') {
  const normalized = readOptionalText(origin);
  if (!normalized) return false;
  if (deployEnv === 'live') return false;
  return isKnownMyscPreviewOrigin(normalized);
}

function buildListResponse(items, limit) {
  const nextCursor = items.length === limit ? items[items.length - 1]?.id || null : null;
  return {
    items,
    count: items.length,
    nextCursor,
  };
}

function normalizeEntityType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

const ENTITY_COLLECTIONS = {
  project: 'projects',
  ledger: 'ledgers',
  transaction: 'transactions',
  expense_set: 'expense_sets',
  expense_sets: 'expense_sets',
  change_request: 'change_requests',
  change_requests: 'change_requests',
  member: 'members',
};

function resolveEntityCollectionName(entityType) {
  const normalized = normalizeEntityType(entityType);
  return ENTITY_COLLECTIONS[normalized] || '';
}

function resolveEntityDocPath(tenantId, entityType, entityId) {
  const collectionName = resolveEntityCollectionName(entityType);
  if (!collectionName) {
    throw createHttpError(400, `Unsupported entityType: ${entityType}`);
  }
  const normalizedId = typeof entityId === 'string' ? entityId.trim() : '';
  if (!normalizedId) {
    throw createHttpError(400, 'entityId is required');
  }
  return `orgs/${tenantId}/${collectionName}/${normalizedId}`;
}

function flattenObjectPaths(value, basePath = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return basePath ? [basePath] : [];
  }

  const keys = Object.keys(value);
  if (!keys.length) {
    return basePath ? [basePath] : [];
  }

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

function readByPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined;
    return acc[key];
  }, obj);
}

function detectChangedFields(current, patch) {
  const paths = flattenObjectPaths(patch);
  return paths.filter((path) => {
    const before = readByPath(current, path);
    const after = readByPath(patch, path);
    return JSON.stringify(before) !== JSON.stringify(after);
  });
}

function stripExpectedVersion(payload) {
  const cloned = { ...payload };
  delete cloned.expectedVersion;
  return cloned;
}

function toDriveEvidenceDocId(fileId) {
  const normalized = readOptionalText(fileId).replace(/[^A-Za-z0-9_-]/g, '_');
  return normalized ? `evdrv_${normalized}` : `evdrv_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function chunkArray(items, chunkSize) {
  const result = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    result.push(items.slice(index, index + chunkSize));
  }
  return result;
}

const SERVER_MANAGED_FIELDS = new Set([
  'tenantId',
  'version',
  'createdBy',
  'createdAt',
  'updatedBy',
  'updatedAt',
  'submittedBy',
  'submittedAt',
  'approvedBy',
  'approvedAt',
  'rejectedReason',
  'uploadedBy',
  'uploadedAt',
  'authorId',
]);

function stripServerManagedFields(payload) {
  const sanitized = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (SERVER_MANAGED_FIELDS.has(key)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function assertReasonForRejected(state, reason) {
  if (state === 'REJECTED' && (!reason || !reason.trim())) {
    throw createHttpError(400, 'REJECTED transition requires a rejection reason');
  }
}

function normalizeRole(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'viewer' ? 'pm' : normalized;
}

function mapClientErrorSeverity(level) {
  const normalized = readOptionalText(level).toLowerCase();
  if (normalized === 'fatal') return 'CRITICAL';
  if (normalized === 'warning') return 'WARNING';
  if (normalized === 'info') return 'INFO';
  return 'ERROR';
}

const ALL_INTERNAL_ROUTE_ROLES = ['admin', 'finance', 'pm', 'viewer', 'auditor', 'tenant_admin', 'support', 'security'];
const CORE_WRITE_ROUTE_ROLES = ['admin', 'finance', 'pm', 'auditor', 'tenant_admin', 'support', 'security'];

const ROUTE_ROLES = {
  readCore: ALL_INTERNAL_ROUTE_ROLES,
  writeCore: CORE_WRITE_ROUTE_ROLES,
  writeTransaction: ALL_INTERNAL_ROUTE_ROLES,
  writeProjectDrive: ALL_INTERNAL_ROUTE_ROLES,
  writeEvidenceDrive: ALL_INTERNAL_ROUTE_ROLES,
  auditRead: ['admin', 'finance', 'auditor', 'tenant_admin', 'support', 'security'],
  memberWrite: ['admin', 'tenant_admin'],
};

async function encryptAuditEmail(piiProtector, email) {
  if (!email) return undefined;
  const encrypted = await piiProtector.encryptText(email);
  return encrypted?.ciphertext || undefined;
}

async function ensureDocumentExists(db, path, notFoundMessage) {
  const snap = await db.doc(path).get();
  if (!snap.exists) {
    throw createHttpError(404, notFoundMessage, 'not_found');
  }
  return snap.data();
}

function stripUndefinedDeep(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripUndefinedDeep(entry))
      .filter((entry) => entry !== undefined);
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

function resolveAutoLedgerName(project) {
  const accountType = readOptionalText(project?.accountType);
  if (accountType === 'DEDICATED') return '전용통장 원장';
  if (accountType === 'OPERATING') return '운영통장 원장';
  return '기본 원장';
}

async function upsertVersionedDoc({
  db,
  path,
  payload,
  tenantId,
  actorId,
  now,
  expectedVersion,
  outboxEvent,
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
        ...payload,
        tenantId,
        version: nextVersion,
        createdBy: actorId,
        createdAt: now,
        updatedBy: actorId,
        updatedAt: now,
      };

      tx.set(ref, stripUndefinedDeep(document), { merge: true });
      if (outboxEvent) {
        enqueueOutboxEventInTransaction(tx, db, outboxEvent);
      }
      return { created: true, version: nextVersion, data: stripUndefinedDeep(document) };
    }

    const current = snap.data() || {};
    const currentVersion = Number.isInteger(current.version) && current.version > 0 ? current.version : 1;

    if (expectedVersion === undefined) {
      throw createHttpError(409, `expectedVersion is required for update (current=${currentVersion})`, 'version_required');
    }

    if (expectedVersion !== currentVersion) {
      throw createHttpError(
        409,
        `Version mismatch: expected ${expectedVersion}, actual ${currentVersion}`,
        'version_conflict',
      );
    }

    const nextVersion = currentVersion + 1;
    const document = {
      ...current,
      ...payload,
      tenantId,
      version: nextVersion,
      createdBy: current.createdBy || actorId,
      createdAt: current.createdAt || now,
      updatedBy: actorId,
      updatedAt: now,
    };

    tx.set(ref, stripUndefinedDeep(document), { merge: true });
    if (outboxEvent) {
      enqueueOutboxEventInTransaction(tx, db, outboxEvent);
    }
    return { created: false, version: nextVersion, data: stripUndefinedDeep(document) };
  });
}

async function mergeSystemManagedDoc({
  db,
  path,
  patch,
  tenantId,
  actorId,
  now,
  notFoundMessage,
}) {
  const ref = db.doc(path);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw createHttpError(404, notFoundMessage || `Document not found: ${path}`, 'not_found');
    }

    const current = snap.data() || {};
    const currentVersion = Number.isInteger(current.version) && current.version > 0 ? current.version : 1;
    const nextVersion = currentVersion + 1;
    const document = {
      ...current,
      ...patch,
      tenantId,
      version: nextVersion,
      createdBy: current.createdBy || actorId,
      createdAt: current.createdAt || now,
      updatedBy: actorId,
      updatedAt: now,
    };

    tx.set(ref, stripUndefinedDeep(document), { merge: true });
    return { version: nextVersion, data: stripUndefinedDeep(document) };
  });
}

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function assertActorRoleAllowed(req, allowedRoles, action) {
  const actorRole = normalizeRole(req.context?.actorRole);
  if (!actorRole || !allowedRoles.includes(actorRole)) {
    throw createHttpError(
      403,
      `Role '${actorRole || 'unknown'}' is not allowed to ${action}`,
      'forbidden',
    );
  }
}

function assertActorPermissionAllowed(policy, req, requiredPermission, action) {
  const actorRole = normalizeRole(req.context?.actorRole);
  if (!actorRole || !actorHasPermission(policy, { actorRole, permission: requiredPermission })) {
    throw createHttpError(
      403,
      `Role '${actorRole || 'unknown'}' lacks permission '${requiredPermission}' to ${action}`,
      'forbidden',
    );
  }
}

export async function resolveApiRequestContext(req, {
  authMode,
  verifyToken,
  resolveMemberIdentity,
  resolveMcpAccessToken,
} = {}) {
  const requestId = req.header('x-request-id') || createRequestId();
  const mcpReadPath = req.path === '/mcp/cashflow/weekly-overview';
  const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase()) && !mcpReadPath;
  const idempotencyKey = req.header('idempotency-key') || '';

  if (isMutating && !idempotencyKey.trim()) {
    throw createHttpError(400, 'idempotency-key header is required for mutating requests');
  }

  const identity = mcpReadPath && typeof resolveMcpAccessToken === 'function'
    ? await resolveMcpAccessToken(req.header('authorization'))
    : await resolveRequestIdentity({ authMode, verifyToken, readHeaderValue: (name) => req.header(name) });

  let actorRole = identity.actorRole;
  let actorEmail = identity.actorEmail;
  let actorName = identity.actorName;

  if (identity.source === 'firebase') {
    if (typeof resolveMemberIdentity !== 'function') {
      throw createHttpError(
        503,
        'Organization membership verification is unavailable',
        'member_resolver_unavailable',
      );
    }
    const memberIdentity = await resolveMemberIdentity({
      tenantId: identity.tenantId,
      actorId: identity.actorId,
    });
    const memberHasStatus = memberIdentity
      ? Object.prototype.hasOwnProperty.call(memberIdentity, 'status')
      : false;
    if (!memberIdentity || (memberHasStatus && memberIdentity.status !== 'ACTIVE')) {
      throw createHttpError(
        403,
        'Active organization membership is required',
        'member_inactive',
      );
    }
    actorRole = normalizeRole(memberIdentity.role) || undefined;
    actorEmail = actorEmail || readOptionalText(memberIdentity?.email).toLowerCase() || undefined;
    actorName = actorName || readOptionalText(memberIdentity?.name) || undefined;
  }

  return {
    tenantId: identity.tenantId,
    actorId: identity.actorId,
    actorRole,
    actorEmail,
    actorName,
    authSource: identity.source,
    requestId,
    idempotencyKey: idempotencyKey.trim() || undefined,
  };
}

function createApiContextMiddleware({ authMode, verifyToken, resolveMemberIdentity, resolveMcpAccessToken }) {
  return asyncHandler(async (req, res, next) => {
    req.context = await resolveApiRequestContext(req, {
      authMode,
      verifyToken,
      resolveMemberIdentity,
      resolveMcpAccessToken,
    });
    res.setHeader('x-request-id', req.context.requestId);
    next();
  });
}

function createMutatingRoute(idempotencyService, routeHandler) {
  return asyncHandler(async (req, res) => {
    const { tenantId, idempotencyKey, actorId, requestId } = req.context;

    const lock = await idempotencyService.begin({
      tenantId,
      idempotencyKey,
      method: req.method,
      path: req.path,
      body: req.body,
      actorId,
      requestId,
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
        tenantId,
        idempotencyKey,
        requestFingerprint: lock.requestFingerprint,
        responseStatus: status,
        responseBody: body,
        requestId,
      });

      res.status(status).json(body);
    } catch (error) {
      await idempotencyService.fail({
        tenantId,
        idempotencyKey,
        requestFingerprint: lock.requestFingerprint,
        requestId,
        error,
      });
      throw error;
    }
  });
}

export function createBffApp(options = {}) {
  const app = express();
  const env = options.env || process.env;
  const now = options.now || (() => new Date().toISOString());
  const projectId = options.projectId || resolveProjectId(env);
  const allowedOrigins = parseAllowedOrigins(options.allowedOrigins || env.BFF_ALLOWED_ORIGINS);
  const workerAuthPolicy = options.workerAuthPolicy || resolveBffWorkerAuthPolicy({
    workerSecret: options.workerSecret,
  }, env);
  const runtimeSafetyConfig = resolveBffRuntimeSafetyConfig({
    projectId,
    allowedOrigins,
    workerSecret: options.workerSecret,
    workerSecrets: options.workerSecrets,
    firestoreEmulator: options.firestoreEmulator,
  }, env);

  assertBffRuntimeSafety(runtimeSafetyConfig);

  const editLeasesOptionSet = typeof options.editLeasesEnabled === 'boolean';
  const editLeasesEnabled = editLeasesOptionSet
    ? options.editLeasesEnabled
    : readOptionalText(env.BFF_EDIT_LEASES_ENABLED).toLowerCase() === 'true';
  const maintenanceReadOnly = readOptionalText(env.BFF_MAINTENANCE_READ_ONLY).toLowerCase() === 'true';
  const localTestInjection = options.editLeasesEnabled === true && runtimeSafetyConfig.deployEnv === 'local';
  if (editLeasesEnabled && runtimeSafetyConfig.deployEnv !== 'live' && !localTestInjection) {
    const error = new Error('Edit leases environment flag requires a deployed runtime');
    error.code = 'unsafe_bff_runtime';
    throw error;
  }

  const createDb = options.createDb || createFirestoreDb;
  const db = options.db || createDb({ projectId });
  const authProjectId = resolveFirebaseAuthProjectId(options, env, projectId);
  const authAppName = authProjectId === projectId ? undefined : `auth:${authProjectId}`;
  const authMode = options.authMode || resolveAuthMode();
  const verifyToken = options.tokenVerifier || createFirebaseTokenVerifier({ projectId: authProjectId, appName: authAppName });
  const authAdminService = options.authAdminService || createFirebaseAuthAdminService({ projectId: authProjectId, appName: authAppName });
  const idempotencyService = createIdempotencyService(db);
  const auditChainService = createAuditChainService(db, { now });
  const piiProtector = options.piiProtector || createPiiProtector();
  const rbacPolicy = options.rbacPolicy || loadRbacPolicy();
  const professionalProfileCatalog = options.professionalProfileCatalog || getProfessionalProfileCatalog();
  const editLeaseService = options.editLeaseService || (editLeasesEnabled
    ? createEditLeaseService({
      db,
      now,
      createLeaseId: options.createEditLeaseId || randomUUID,
      auditChainService,
      idempotencyService,
      rbacPolicy,
    })
    : null);
  const driveService = options.driveService || createGoogleDriveService();
  const googleSheetsService = options.googleSheetsService || createGoogleSheetsService();
  const googleSheetMigrationAiService = options.googleSheetMigrationAiService || createGoogleSheetMigrationAiService();
  const projectRequestContractAiService = options.projectRequestContractAiService || createProjectRequestContractAiService();
  const projectRequestContractStorageService = options.projectRequestContractStorageService || createProjectRequestContractStorageService({ projectId });
  // 인사정보 증빙 저장소. 실패해도 명부·프로필은 살아 있어야 하므로 생성 실패를 삼킨다.
  const personHrEvidenceStorageService = options.personHrEvidenceStorageService
    || (() => {
      try {
        return createPersonHrEvidenceStorageService({});
      } catch {
        return null;
      }
    })();
  const projectRegistrationDraftStorageService = options.projectRegistrationDraftStorageService
    || projectRequestContractStorageService;
  const projectRegistrationDraftService = options.projectRegistrationDraftService || (editLeasesEnabled
    ? createProjectRegistrationDraftService({
      db,
      now,
      createDraftId: options.createProjectRegistrationDraftId || randomUUID,
      createLeaseId: options.createProjectRegistrationLeaseId || randomUUID,
      createAttachmentId: options.createProjectRegistrationAttachmentId || randomUUID,
      createProjectId: options.createProjectRegistrationProjectId,
      createProjectRequestId: options.createProjectRegistrationRequestId,
      createRegistrationOutboxEvent: options.createProjectRegistrationOutboxEvent,
      auditChainService,
      idempotencyService,
      draftStorageService: projectRegistrationDraftStorageService,
      rbacPolicy,
    })
    : null);
  const projectInfoDraftService = options.projectInfoDraftService || (editLeasesEnabled
    ? createProjectInfoDraftService({
      db,
      now,
      createAttachmentId: options.createProjectInfoAttachmentId,
      createOutboxEvent: options.createProjectInfoOutboxEvent,
      auditChainService,
      idempotencyService,
      draftStorageService: projectRegistrationDraftStorageService,
      rbacPolicy,
    })
    : null);
  const cashflowEditDraftService = options.cashflowEditDraftService || (editLeasesEnabled
    ? createCashflowEditDraftService({
      db,
      now,
      auditChainService,
      idempotencyService,
      rbacPolicy,
    })
    : null);
  const projectSheetSourceStorageService = options.projectSheetSourceStorageService || createProjectSheetSourceStorageService({ projectId });
  const businessCardStorageService = options.businessCardStorageService || createBusinessCardStorageService({ projectId });
  const businessCardGeminiAiService = options.businessCardGeminiAiService || createBusinessCardGeminiAiService();
  const relationRulesPolicyPath = options.relationRulesPolicyPath || resolveRelationRulesPolicyPath();
  const workQueueBatchSizeRaw = Number.parseInt(process.env.BFF_WORK_QUEUE_BATCH || '100', 10);
  const workQueueMaxAttemptsRaw = Number.parseInt(process.env.BFF_WORK_QUEUE_MAX_ATTEMPTS || '6', 10);
  const outboxBatchSizeRaw = Number.parseInt(process.env.BFF_OUTBOX_BATCH || '50', 10);
  const outboxMaxAttemptsRaw = Number.parseInt(process.env.BFF_OUTBOX_MAX_ATTEMPTS || '8', 10);
  const clientErrorBatchSizeRaw = Number.parseInt(process.env.BFF_CLIENT_ERROR_SLACK_BATCH || '20', 10);
  const clientErrorMaxAttemptsRaw = Number.parseInt(process.env.BFF_CLIENT_ERROR_SLACK_MAX_ATTEMPTS || '5', 10);
  const workQueueBatchSize = Number.isFinite(workQueueBatchSizeRaw) && workQueueBatchSizeRaw > 0 ? workQueueBatchSizeRaw : 100;
  const workQueueMaxAttempts = Number.isFinite(workQueueMaxAttemptsRaw) && workQueueMaxAttemptsRaw > 0 ? workQueueMaxAttemptsRaw : 6;
  const outboxBatchSize = Number.isFinite(outboxBatchSizeRaw) && outboxBatchSizeRaw > 0 ? outboxBatchSizeRaw : 50;
  const outboxMaxAttempts = Number.isFinite(outboxMaxAttemptsRaw) && outboxMaxAttemptsRaw > 0 ? outboxMaxAttemptsRaw : 8;
  const clientErrorBatchSize = Number.isFinite(clientErrorBatchSizeRaw) && clientErrorBatchSizeRaw > 0 ? clientErrorBatchSizeRaw : 20;
  const clientErrorMaxAttempts = Number.isFinite(clientErrorMaxAttemptsRaw) && clientErrorMaxAttemptsRaw > 0 ? clientErrorMaxAttemptsRaw : 5;
  const slackAlertService = options.slackAlertService || createSlackAlertService();
  const projectRegistrationSlackService = options.projectRegistrationSlackService
    || createSlackAlertService(resolveProjectRegistrationSlackConfig(options));
  const cashflowSlackService = options.cashflowSlackService
    || createSlackAlertService(resolveCashflowSlackConfig(options));
  const projectRegistrationOutboxHandler = options.projectRegistrationOutboxHandler
    || createProjectRegistrationSubmittedOutboxHandler({
      db,
      driveService,
      projectRegistrationSlackService,
      projectRegistrationAttachmentStorageService: projectRegistrationDraftStorageService,
      now,
    });
  const projectInfoOutboxHandler = options.projectInfoOutboxHandler
    || createProjectInfoSubmittedOutboxHandler({
      db,
      driveService,
      projectRegistrationAttachmentStorageService: projectRegistrationDraftStorageService,
      now,
    });
  const draftAttachmentCleanupOutboxHandler = options.draftAttachmentCleanupOutboxHandler
    || createDraftAttachmentCleanupOutboxHandler({
      draftStorageService: projectRegistrationDraftStorageService,
    });
  const participationRosterOutboxHandler = options.participationRosterOutboxHandler
    || createParticipationRosterChangedOutboxHandler({ db, googleSheetsService, now });
  // outbox 소비의 단일 핸들러 맵. 크론 배치와 인라인 처리(명단 갱신 즉시 실행)가 같은 맵을
  // 쓴다 - 두 경로가 다른 맵을 들면 한쪽만 아는 이벤트 타입이 생긴다.
  const outboxEventHandlers = {
    'project.registration.submitted': projectRegistrationOutboxHandler,
    'project.info.submitted': projectInfoOutboxHandler,
    [DRAFT_ATTACHMENT_CLEANUP_EVENT_TYPE]: draftAttachmentCleanupOutboxHandler,
    [PARTICIPATION_ROSTER_CHANGED_EVENT_TYPE]: participationRosterOutboxHandler,
  };
  // 명단 갱신은 사람이 버튼을 누르고 결과를 기다리는 동작이다. 매일 1회 크론만 기다리게
  // 하면 버튼이 거짓말이 된다 - enqueue 직후 같은 요청 안에서 인라인 처리한다.
  const processRosterEventInline = (eventId) => processOutboxEventById(db, eventId, {
    now,
    eventHandlers: outboxEventHandlers,
    maxAttempts: outboxMaxAttempts,
  });
  // 등록/수정 최종 제출의 첨부 공개 이관도 같은 이유로 인라인 처리한다. 크론(새벽 1회)만
  // 기다리면 결재 문서의 서류 7종이 하루 종일 '미제출'로 보이고 승인도 막힌다.
  const processSubmitOutboxInline = processRosterEventInline;

  async function resolveMemberIdentity({ tenantId, actorId }) {
    const normalizedTenantId = readOptionalText(tenantId);
    const normalizedActorId = readOptionalText(actorId);
    if (!normalizedTenantId || !normalizedActorId) return null;

    const snap = await db.doc(`orgs/${normalizedTenantId}/members/${normalizedActorId}`).get();
    if (!snap.exists) return null;

    const data = snap.data() || {};
    return {
      role: normalizeRole(data.role),
      ...(Object.prototype.hasOwnProperty.call(data, 'status') ? { status: data.status } : {}),
      email: readOptionalText(data.email).toLowerCase() || undefined,
      name: readOptionalText(data.name) || undefined,
    };
  }

  app.disable('x-powered-by');
  app.use(express.json({ limit: process.env.BFF_JSON_LIMIT || '25mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.use((req, res, next) => {
    const requestOrigin = req.header('origin') || '';
    const allowAnyOrigin = allowedOrigins.includes('*');
    const isAllowedOrigin = allowAnyOrigin
      || !requestOrigin
      || allowedOrigins.includes(requestOrigin)
      || isKnownMyscVercelOrigin(requestOrigin, runtimeSafetyConfig.deployEnv);

    if (!isAllowedOrigin) {
      res.status(403).json({
        error: 'origin_not_allowed',
        message: `Origin is not allowed: ${requestOrigin}`,
      });
      return;
    }

    if (requestOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowAnyOrigin ? '*' : requestOrigin);
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-tenant-id, x-actor-id, x-actor-role, x-actor-email, x-actor-name, x-request-id, idempotency-key, x-edit-session-id, x-edit-lease-id, x-edit-fence, x-google-access-token, x-file-name, x-file-type, x-file-size');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');

    if (req.method.toUpperCase() === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use((req, res, next) => {
    const requestId = req.header('x-request-id') || createRequestId();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  });

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const statusCode = res.statusCode || 0;
      const payload = {
        severity: statusCode >= 500 ? 'ERROR' : (statusCode >= 400 ? 'WARNING' : 'INFO'),
        message: 'bff.request',
        service: 'mysc-bff',
        method: req.method,
        path: req.path,
        statusCode,
        latencyMs: durationMs,
        requestId: req.requestId || req.context?.requestId,
        tenantId: req.context?.tenantId || null,
        actorId: req.context?.actorId || null,
        errorCode: res.locals.errorCode || null,
      };
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(payload));
    });
    next();
  });

  app.use((req, res, next) => {
    if (maintenanceReadOnly && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())) {
      res.locals.errorCode = 'maintenance_read_only';
      res.status(503).json({
        error: 'maintenance_read_only',
        message: 'The service is temporarily read-only for data maintenance.',
      });
      return;
    }
    next();
  });

  async function loadTenantRules(tenantId) {
    return resolveRelationRules({
      db,
      tenantId,
      policyPath: relationRulesPolicyPath,
    });
  }

  async function processQueueSync(tenantId, eventId) {
    return processWorkQueueBatch(db, {
      tenantId,
      eventId,
      limit: workQueueBatchSize,
      maxAttempts: workQueueMaxAttempts,
      now,
    });
  }

  function assertInternalWorkerAuthorized(req) {
    const headerSecret = readOptionalText(req.header('x-worker-secret'));
    const bearerSecret = parseBearerToken(req.header('authorization'));
    const result = evaluateWorkerAuthorization({ headerSecret, bearerSecret }, workerAuthPolicy);
    if (!result.ok) {
      throw createHttpError(result.statusCode, result.message, result.code);
    }
  }


  app.get('/api/v1/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'mysc-bff',
      projectId,
      authMode,
      firestoreEmulator: isFirestoreEmulatorEnabled(),
      timestamp: now(),
    });
  });

  const runOutboxWorker = asyncHandler(async (req, res) => {
    assertInternalWorkerAuthorized(req);
    const limit = parseLimit(req.body?.limit ?? req.query?.limit, outboxBatchSize, 500);
    const maxAttempts = parseLimit(req.body?.maxAttempts ?? req.query?.maxAttempts, outboxMaxAttempts, 50);

    const result = await processOutboxBatch(db, {
      limit,
      maxAttempts,
      now,
      eventHandlers: outboxEventHandlers,
    });

    res.status(200).json({
      ok: true,
      worker: 'outbox',
      projectId,
      ...result,
    });
  });
  // Vercel Cron runs internal worker endpoints via GET.
  app.get('/api/internal/workers/outbox/run', runOutboxWorker);
  app.post('/api/internal/workers/outbox/run', runOutboxWorker);

  const runWorkQueueWorker = asyncHandler(async (req, res) => {
    assertInternalWorkerAuthorized(req);
    const limit = parseLimit(req.body?.limit ?? req.query?.limit, workQueueBatchSize, 500);
    const maxAttempts = parseLimit(req.body?.maxAttempts ?? req.query?.maxAttempts, workQueueMaxAttempts, 50);
    const tenantId = readOptionalText(req.body?.tenantId ?? req.query?.tenantId) || undefined;
    const eventId = readOptionalText(req.body?.eventId ?? req.query?.eventId) || undefined;

    const result = await processWorkQueueBatch(db, {
      tenantId,
      eventId,
      limit,
      maxAttempts,
      now,
    });

    res.status(200).json({
      ok: true,
      worker: 'work_queue',
      projectId,
      tenantId: tenantId || null,
      eventId: eventId || null,
      ...result,
    });
  });
  // Vercel Cron runs internal worker endpoints via GET.
  app.get('/api/internal/workers/work-queue/run', runWorkQueueWorker);
  app.post('/api/internal/workers/work-queue/run', runWorkQueueWorker);

  const runPayrollWorkerRoute = asyncHandler(async (req, res) => {
    assertInternalWorkerAuthorized(req);
    const tenantId = readOptionalText(req.body?.tenantId ?? req.query?.tenantId) || undefined;
    const monthsAheadRaw = Number.parseInt(String(req.body?.monthsAhead ?? req.query?.monthsAhead ?? '1'), 10);
    const leadDaysRaw = Number.parseInt(String(req.body?.leadBusinessDays ?? req.query?.leadBusinessDays ?? '3'), 10);
    const matchWindowRaw = Number.parseInt(String(req.body?.matchWindowDays ?? req.query?.matchWindowDays ?? '2'), 10);
    const monthsAhead = Number.isFinite(monthsAheadRaw) && monthsAheadRaw >= 0 && monthsAheadRaw <= 6 ? monthsAheadRaw : 1;
    const leadBusinessDays = Number.isFinite(leadDaysRaw) && leadDaysRaw >= 0 && leadDaysRaw <= 10 ? leadDaysRaw : 3;
    const matchWindowDays = Number.isFinite(matchWindowRaw) && matchWindowRaw >= 0 && matchWindowRaw <= 10 ? matchWindowRaw : 2;

    const result = await runPayrollWorker(db, {
      tenantId,
      nowIso: now(),
      monthsAhead,
      leadBusinessDays,
      matchWindowDays,
    });

    res.status(200).json({
      ok: true,
      worker: 'payroll',
      projectId,
      ...result,
    });
  });
  app.get('/api/internal/workers/payroll/run', runPayrollWorkerRoute);
  app.post('/api/internal/workers/payroll/run', runPayrollWorkerRoute);


  const runClientErrorSlackWorkerRoute = asyncHandler(async (req, res) => {
    assertInternalWorkerAuthorized(req);
    const limit = parseLimit(req.body?.limit ?? req.query?.limit, clientErrorBatchSize, 100);
    const maxAttempts = parseLimit(req.body?.maxAttempts ?? req.query?.maxAttempts, clientErrorMaxAttempts, 20);

    if (!slackAlertService.enabled) {
      res.status(200).json({
        ok: true,
        worker: 'client_errors',
        enabled: false,
        reason: 'slack_webhook_not_configured',
        processed: 0,
        delivered: 0,
        failed: 0,
      });
      return;
    }

    const pendingSnap = await db
      .collectionGroup('client_error_events')
      .where('slackStatus', '==', 'pending')
      .limit(limit)
      .get();

    let processed = 0;
    let delivered = 0;
    let failed = 0;

    for (const docSnap of pendingSnap.docs) {
      processed += 1;
      const event = docSnap.data() || {};
      const nextAttemptCount = Number.isInteger(event.slackAttemptCount) ? event.slackAttemptCount + 1 : 1;
      const attemptedAt = now();

      try {
        await slackAlertService.notifyClientError(event);
        await docSnap.ref.set({
          slackStatus: 'sent',
          slackAttemptCount: nextAttemptCount,
          slackLastAttemptAt: attemptedAt,
          slackNotifiedAt: attemptedAt,
          slackLastError: null,
          updatedAt: attemptedAt,
        }, { merge: true });
        delivered += 1;
      } catch (error) {
        const exhausted = nextAttemptCount >= maxAttempts;
        await docSnap.ref.set({
          slackStatus: exhausted ? 'failed' : 'pending',
          slackAttemptCount: nextAttemptCount,
          slackLastAttemptAt: attemptedAt,
          slackLastError: truncateText(error instanceof Error ? error.message : String(error), 500),
          updatedAt: attemptedAt,
        }, { merge: true });
        failed += 1;
      }
    }

    res.status(200).json({
      ok: true,
      worker: 'client_errors',
      enabled: true,
      processed,
      delivered,
      failed,
      pending: pendingSnap.size,
    });
  });
  app.get('/api/internal/workers/client-errors/run', runClientErrorSlackWorkerRoute);
  app.post('/api/internal/workers/client-errors/run', runClientErrorSlackWorkerRoute);

  // 주정산 완료를 하루치로 모아 알린다. JVM 이 쓴 완료 기록을 읽기만 하고 상태를 바꾸지 않는다.
  const runCashflowWeeklyDigestWorkerRoute = asyncHandler(async (req, res) => {
    assertInternalWorkerAuthorized(req);
    const tenantId = readOptionalText(req.body?.tenantId ?? req.query?.tenantId) || 'mysc';

    if (!cashflowSlackService.enabled) {
      res.status(200).json({
        ok: true,
        worker: 'cashflow_weekly_digest',
        enabled: false,
        reason: 'cashflow_slack_not_configured',
        completed: 0,
        delivered: 0,
      });
      return;
    }

    const at = now();
    const window = kstDayWindow(at);
    const snapshot = await db
      .collection(`orgs/${tenantId}/cashflow_weekly_update_completions`)
      .where('completedAt', '>=', window.startAt)
      .where('completedAt', '<', window.endAt)
      .get();
    const completions = selectCompletedInWindow(snapshot.docs.map((doc) => doc.data() || {}), window);

    const projectIds = [...new Set(completions.map((item) => readOptionalText(item.projectId)).filter(Boolean))];
    const memberUids = [...new Set(completions.map((item) => readOptionalText(item.completedByUid)).filter(Boolean))];
    const [projectSnapshots, memberSnapshots] = await Promise.all([
      Promise.all(projectIds.map((id) => db.doc(`orgs/${tenantId}/projects/${id}`).get())),
      Promise.all(memberUids.map((uid) => db.doc(`orgs/${tenantId}/members/${uid}`).get())),
    ]);
    const projectNames = new Map(projectSnapshots.map((snap, index) => {
      const project = snap.exists ? snap.data() || {} : {};
      return [projectIds[index], readOptionalText(project.name)
        || readOptionalText(project.officialContractName)
        || readOptionalText(project.projectCode)
        || projectIds[index]];
    }));
    // 이름은 members 를 먼저 본다. 완료 기록의 completedByName 은 URL 인코딩된 채로 저장돼 있다.
    const memberProfiles = new Map(memberSnapshots.map((snap, index) => {
      const member = snap.exists ? snap.data() || {} : {};
      return [memberUids[index], {
        name: readOptionalText(member.name),
        slackUserId: readOptionalText(member.slackUserId),
      }];
    }));

    const entries = completions.map((item) => {
      const profile = memberProfiles.get(readOptionalText(item.completedByUid)) || {};
      return {
        projectName: projectNames.get(readOptionalText(item.projectId)) || readOptionalText(item.projectId),
        completedByName: profile.name || decodeStoredName(item.completedByName),
        slackUserId: profile.slackUserId || '',
      };
    });
    const message = buildCashflowWeeklyDigestMessage({
      date: window.date,
      timeLabel: kstTimeLabel(at),
      entries,
    });
    if (message) {
      await cashflowSlackService.notifyMessage(message);
    }

    res.status(200).json({
      ok: true,
      worker: 'cashflow_weekly_digest',
      enabled: true,
      tenantId,
      date: window.date,
      completed: entries.length,
      delivered: message ? 1 : 0,
    });
  });
  app.get('/api/internal/workers/cashflow-weekly-digest/run', runCashflowWeeklyDigestWorkerRoute);
  app.post('/api/internal/workers/cashflow-weekly-digest/run', runCashflowWeeklyDigestWorkerRoute);

  app.post('/api/v1/client-errors', asyncHandler(async (req, res) => {
    req.context = await resolveApiRequestContext(req, {
      authMode: authMode === 'headers' ? 'headers' : 'firebase_optional',
      verifyToken,
      resolveMemberIdentity,
    });
    res.setHeader('x-request-id', req.context.requestId);

    const parsed = parseWithSchema(clientErrorIngestSchema, req.body, 'Invalid client error payload');
    const { tenantId, actorId, actorRole, actorEmail, authSource, requestId } = req.context;
    const timestamp = now();
    const eventId = `cerr_${timestamp.replace(/[^0-9]/g, '').slice(0, 14)}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const slackEligible = slackAlertService.shouldAlertClientError(parsed);

    const initialSlackStatus = !slackEligible
      ? 'skipped'
      : (slackAlertService.enabled ? 'pending' : 'disabled');

    const event = stripUndefinedDeep({
      id: eventId,
      tenantId,
      actorId,
      actorRole,
      actorEmail,
      authSource,
      requestId,
      eventType: parsed.eventType || 'exception',
      level: parsed.level || 'error',
      source: parsed.source,
      name: parsed.name,
      message: parsed.message,
      stack: parsed.stack,
      route: parsed.route,
      href: parsed.href,
      clientRequestId: parsed.clientRequestId,
      fingerprint: parsed.fingerprint,
      tags: parsed.tags,
      extra: parsed.extra,
      userAgent: readOptionalText(req.header('user-agent')),
      occurredAt: parsed.occurredAt || timestamp,
      slackEligible,
      slackStatus: initialSlackStatus,
      slackAttemptCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    });

    const eventRef = db.doc(`orgs/${tenantId}/client_error_events/${eventId}`);
    await eventRef.set(event, { merge: false });

    console.error(JSON.stringify(stripUndefinedDeep({
      severity: mapClientErrorSeverity(event.level),
      message: 'client.error',
      eventId,
      tenantId,
      actorId,
      actorRole,
      actorEmailMasked: piiProtector.maskEmail(actorEmail || ''),
      authSource,
      requestId,
      clientRequestId: event.clientRequestId,
      source: event.source,
      route: event.route,
      href: event.href,
      errorName: event.name,
      errorMessage: event.message,
      fingerprint: event.fingerprint,
      userAgent: event.userAgent,
      tagKeys: Object.keys(event.tags || {}),
      extraKeys: Object.keys(event.extra || {}),
      occurredAt: event.occurredAt,
      createdAt: event.createdAt,
    })));

    let slackStatus = event.slackStatus;
    if (slackEligible && slackAlertService.enabled) {
      const attemptedAt = now();
      try {
        await slackAlertService.notifyClientError(event);
        slackStatus = 'sent';
        await eventRef.set({
          slackStatus,
          slackAttemptCount: 1,
          slackLastAttemptAt: attemptedAt,
          slackNotifiedAt: attemptedAt,
          slackLastError: null,
          updatedAt: attemptedAt,
        }, { merge: true });
      } catch (error) {
        slackStatus = 'failed';
        const slackLastError = truncateText(error instanceof Error ? error.message : String(error), 500);
        await eventRef.set({
          slackStatus,
          slackAttemptCount: 1,
          slackLastAttemptAt: attemptedAt,
          slackLastError,
          updatedAt: attemptedAt,
        }, { merge: true });
        console.error(JSON.stringify(stripUndefinedDeep({
          severity: 'ERROR',
          message: 'client.error.slack_delivery_failed',
          eventId,
          tenantId,
          requestId,
          slackLastError,
        })));
      }
    }

    res.status(200).json({
      ok: true,
      id: eventId,
      tenantId,
      receivedAt: timestamp,
      slackStatus,
    });
  }));

  const mcpOAuthService = options.mcpOAuthService || createMcpOAuthService({
    db,
    issuer: options.mcpOAuthIssuer || process.env.MYSCUBE_MCP_OAUTH_ISSUER || 'https://myscube.myscguard.app',
    publicOrigin: options.mcpPublicOrigin || process.env.MYSCUBE_MCP_PUBLIC_ORIGIN || 'https://myscube.myscguard.app',
    now,
  });
  mountMcpOAuthRoutes(app, {
    service: mcpOAuthService,
    resolveFirebaseContext: async (req) => resolveRequestIdentity({
      authMode: 'firebase_required', verifyToken, readHeaderValue: (name) => req.header(name),
    }),
  });

  app.use('/api/v1', createApiContextMiddleware({
    authMode, verifyToken, resolveMemberIdentity,
    resolveMcpAccessToken: (authorization) => mcpOAuthService.resolveAccessToken(authorization),
  }));

  app.post('/api/v1/write', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.writeCore, 'write data');
    const { tenantId, actorId, actorRole, actorEmail, requestId } = req.context;
    const timestamp = now();
    const parsed = parseWithSchema(genericWriteSchema, req.body, 'Invalid write payload');

    const entityType = normalizeEntityType(parsed.entityType);
    const payloadPatch = stripServerManagedFields(parsed.patch || {});
    const expectedProjectDocuments = entityType === 'project' ? payloadPatch.expectedProjectDocuments : undefined;
    if (entityType === 'project') delete payloadPatch.expectedProjectDocuments;
    const patchId = typeof payloadPatch.id === 'string' ? payloadPatch.id.trim() : '';
    const bodyEntityId = typeof parsed.entityId === 'string' ? parsed.entityId.trim() : '';
    const entityId = bodyEntityId || patchId;

    if (!entityId) {
      throw createHttpError(400, 'entityId is required (either entityId or patch.id)');
    }
    if (bodyEntityId && patchId && bodyEntityId !== patchId) {
      throw createHttpError(400, 'entityId and patch.id do not match');
    }

    payloadPatch.id = entityId;
    const docPath = resolveEntityDocPath(tenantId, entityType, entityId);
    const rules = await loadTenantRules(tenantId);
    const eventId = `ce_${timestamp.replace(/[^0-9]/g, '').slice(0, 14)}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

    const result = await db.runTransaction(async (tx) => {
      const ref = db.doc(docPath);
      const snap = await tx.get(ref);
      const current = snap.exists ? (snap.data() || {}) : {};
      const currentVersion = Number.isInteger(current.version) && current.version > 0 ? current.version : 0;
      const expectedVersion = parsed.expectedVersion;

      if (!snap.exists) {
        if (expectedVersion !== undefined && expectedVersion !== 0) {
          throw createHttpError(
            409,
            `Version mismatch: expected ${expectedVersion}, actual 0`,
            'version_conflict',
          );
        }
      } else {
        if (expectedVersion === undefined) {
          throw createHttpError(
            409,
            `expectedVersion is required for update (current=${currentVersion})`,
            'version_required',
          );
        }
        if (expectedVersion !== currentVersion) {
          throw createHttpError(
            409,
            `Version mismatch: expected ${expectedVersion}, actual ${currentVersion}`,
            'version_conflict',
          );
        }
      }

      const changedProjectDocuments = entityType === 'project'
        ? assertProjectDocumentOriginals(snap.exists ? current : null, payloadPatch, expectedProjectDocuments)
        : {};
      const changedFields = detectChangedFields(current, payloadPatch);
      const nextVersion = currentVersion + 1;
      const document = {
        ...current,
        ...payloadPatch,
        id: entityId,
        tenantId,
        version: nextVersion,
        createdBy: current.createdBy || actorId,
        createdAt: current.createdAt || timestamp,
        updatedBy: actorId,
        updatedAt: timestamp,
      };
      tx.set(ref, document, { merge: true });
      if (Object.keys(changedProjectDocuments).length) tx.update(ref, changedProjectDocuments);

      const changeEvent = {
        id: eventId,
        tenantId,
        requestId,
        entityType,
        entityId,
        version: nextVersion,
        changedFields,
        actorId,
        actorRole: actorRole || null,
        actorEmail: actorEmail || null,
        createdAt: timestamp,
      };
      tx.set(db.doc(`orgs/${tenantId}/change_events/${eventId}`), changeEvent, { merge: true });

      const affectedViews = resolveAffectedViews(rules, {
        entityType,
        changedFields,
      });
      const jobs = affectedViews.map((viewName) => createWorkQueueJob({
        tenantId,
        eventId,
        entityType,
        entityId,
        viewName,
        dedupeKey: `${tenantId}:${entityType}:${entityId}:${nextVersion}:${viewName}`,
        payload: {
          changedFields,
          version: nextVersion,
        },
        createdAt: timestamp,
      }));
      enqueueWorkQueueJobsInTransaction(tx, db, jobs);

      return {
        created: !snap.exists,
        version: nextVersion,
        changedFields,
        affectedViews,
      };
    });

    const actorEmailEnc = await encryptAuditEmail(piiProtector, actorEmail);
    await auditChainService.append({
      tenantId,
      entityType,
      entityId,
      action: result.created ? 'CREATE' : 'UPSERT',
      actorId,
      actorRole,
      actorEmailEnc,
      requestId,
      details: `Generic write: ${entityType}/${entityId}`,
      metadata: {
        source: 'bff.write',
        version: result.version,
        changedFields: result.changedFields,
        affectedViews: result.affectedViews,
        eventId,
      },
      timestamp,
    });

    let queueResult = null;
    const syncEnabled = parsed.options?.sync !== false;
    if (syncEnabled && result.affectedViews.length) {
      queueResult = await processQueueSync(tenantId, eventId);
    }

    return {
      status: result.created ? 201 : 200,
      body: {
        eventId,
        tenantId,
        entityType,
        entityId,
        version: result.version,
        changedFields: result.changedFields,
        affectedViews: result.affectedViews,
        queue: queueResult,
      },
    };
  }));

  app.get('/api/v1/views/:viewName', asyncHandler(async (req, res) => {
    const { tenantId } = req.context;
    assertActorRoleAllowed(req, ROUTE_ROLES.readCore, 'read projection views');
    const viewName = normalizeEntityType(req.params.viewName);
    const supported = listSupportedViews();
    if (!supported.includes(viewName)) {
      throw createHttpError(404, `Unsupported view: ${viewName}`, 'not_found');
    }

    const snap = await db.doc(`orgs/${tenantId}/views/${viewName}`).get();
    const data = snap.exists ? (snap.data() || {}) : {
      tenantId,
      view: viewName,
      updatedAt: null,
    };

    if (viewName === 'project_financials' && typeof req.query.projectId === 'string') {
      const projects = Array.isArray(data.projects) ? data.projects : [];
      const projectId = req.query.projectId.trim();
      const item = projects.find((project) => project.projectId === projectId) || null;
      res.status(200).json({
        view: viewName,
        projectId,
        item,
        updatedAt: data.updatedAt || null,
      });
      return;
    }

    if (viewName === 'member_workload' && typeof req.query.memberId === 'string') {
      const members = Array.isArray(data.members) ? data.members : [];
      const memberId = req.query.memberId.trim();
      const item = members.find((member) => member.memberId === memberId) || null;
      res.status(200).json({
        view: viewName,
        memberId,
        item,
        updatedAt: data.updatedAt || null,
      });
      return;
    }

    res.status(200).json(data);
  }));

  app.get('/api/v1/queue/jobs', asyncHandler(async (req, res) => {
    const { tenantId } = req.context;
    assertActorRoleAllowed(req, ROUTE_ROLES.auditRead, 'read queue jobs');
    const limit = parseLimit(req.query.limit, 50, 200);
    const statusFilter = typeof req.query.status === 'string'
      ? req.query.status.trim().toUpperCase()
      : '';
    const eventIdFilter = typeof req.query.eventId === 'string' ? req.query.eventId.trim() : '';

    const scanLimit = Math.max(limit * 6, 200);
    const snap = await db.collection('work_queue').limit(scanLimit).get();
    const items = snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((item) => item.tenantId === tenantId)
      .filter((item) => (statusFilter ? String(item.status || '').toUpperCase() === statusFilter : true))
      .filter((item) => (eventIdFilter ? item.eventId === eventIdFilter : true))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, limit);

    res.status(200).json({
      items,
      count: items.length,
    });
  }));

  app.post('/api/v1/queue/replay/:eventId', createMutatingRoute(idempotencyService, async (req) => {
    assertActorRoleAllowed(req, ROUTE_ROLES.writeCore, 'replay queue event');
    const { tenantId } = req.context;
    const eventId = req.params.eventId;
    const timestamp = now();

    const eventSnap = await db.doc(`orgs/${tenantId}/change_events/${eventId}`).get();
    if (!eventSnap.exists) {
      throw createHttpError(404, `Change event not found: ${eventId}`, 'not_found');
    }

    const event = eventSnap.data() || {};
    const rules = await loadTenantRules(tenantId);
    const affectedViews = resolveAffectedViews(rules, {
      entityType: event.entityType,
      changedFields: Array.isArray(event.changedFields) ? event.changedFields : [],
    });

    const replayViews = affectedViews.length ? affectedViews : ['alerts'];
    const jobs = await enqueueReplayJobs(db, {
      tenantId,
      eventId,
      entityType: event.entityType,
      entityId: event.entityId,
      views: replayViews,
      createdAt: timestamp,
    });

    const queueResult = await processQueueSync(tenantId, eventId);
    return {
      status: 200,
      body: {
        eventId,
        queued: jobs.length,
        affectedViews: replayViews,
        queue: queueResult,
      },
    };
  }));

  // ── Domain route modules ──────────────────────────────────────────────────
  mountEditLeaseRoutes(app, {
    enabled: editLeasesEnabled,
    editLeaseService,
    piiProtector,
  });
  mountProjectRegistrationDraftRoutes(app, {
    enabled: editLeasesEnabled,
    projectRegistrationDraftService,
    piiProtector,
    processOutboxEventInline: processSubmitOutboxInline,
  });
  mountProjectInfoDraftRoutes(app, {
    enabled: editLeasesEnabled,
    projectInfoDraftService,
    piiProtector,
  });
  mountCashflowEditDraftRoutes(app, {
    enabled: editLeasesEnabled,
    cashflowEditDraftService,
    piiProtector,
  });
  mountProjectRoutes(app, {
    db, now, idempotencyService, auditChainService, piiProtector,
    driveService, googleSheetsService, googleSheetMigrationAiService,
    projectRequestContractAiService, projectRequestContractStorageService,
    projectSheetSourceStorageService, projectRegistrationSlackService,
  });
  mountCashflowExportRoutes(app, {
    db,
    rbacPolicy,
    idempotencyService,
    now,
    legacyCashflowWritesEnabled: options.legacyCashflowWritesEnabled,
  });
  const cashflowSheetLabRoutes = mountCashflowSheetLabRoutes(app, {
    db,
    googleSheetsService,
    env,
    javaWeeklyClient: options.javaWeeklyClient,
  });
  mountCashflowLaborRiskRoutes(app, {
    db,
    now,
  });
  const cashflowPeriodPolicyPersistencePort = options.cashflowPeriodPolicyPersistencePort
    || createCashflowPeriodPolicyFirestoreAdapter({ db, auditChainService });
  const cashflowPeriodPolicyService = options.cashflowPeriodPolicyService
    || createCashflowPeriodPolicyService({
      persistencePort: cashflowPeriodPolicyPersistencePort,
      now,
    });
  mountCashflowPeriodPolicyRoutes(app, {
    service: cashflowPeriodPolicyService,
    idempotencyService,
  });
  mountParticipationDashboardRoutes(app, {
    db,
    now,
    googleSheetsService,
    idempotencyService,
  });
  mountParticipationRosterRoutes(app, {
    db, now, idempotencyService, processRosterEventInline,
  });
  mountJvmWeeklyApiRoutes(app, {
    db,
    idempotencyService,
    env,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    jvmWeeklyApiBaseUrl: options.jvmWeeklyApiBaseUrl,
    jvmWeeklyApiServiceToken: options.jvmWeeklyApiServiceToken,
    jvmWeeklyApiIdTokenAudience: options.jvmWeeklyApiIdTokenAudience,
    jvmWeeklyAuthMode: options.jvmWeeklyAuthMode,
    jvmWeeklyWorkspaceEmailDomain: options.jvmWeeklyWorkspaceEmailDomain,
    cashflowSlackService,
    mcpOAuthService,
  });
  mountLedgerRoutes(app, { db, now, idempotencyService, auditChainService, piiProtector });
  mountTransactionRoutes(app, { db, now, idempotencyService, auditChainService, piiProtector, rbacPolicy, driveService });
  mountAuditRoutes(app, { db, auditChainService });
  mountBusinessCardRoutes(app, {
    db,
    now,
    idempotencyService,
    auditChainService,
    piiProtector,
    rbacPolicy,
    businessCardStorageService,
    businessCardGeminiAiService,
  });
  mountMemberRoutes(app, {
    db,
    now,
    idempotencyService,
    auditChainService,
    piiProtector,
    rbacPolicy,
    authAdminService,
  });

  mountPersonRoutes(app, {
    db,
    now,
    idempotencyService,
    auditChainService,
    piiProtector,
    rbacPolicy,
  });
  mountPersonProfessionalProfileRoutes(app, {
    db,
    now,
    idempotencyService,
    auditChainService,
    piiProtector,
    rbacPolicy,
    evidenceStorageService: personHrEvidenceStorageService,
    catalog: professionalProfileCatalog,
  });

  // ── Guide Q&A chatbot ──
  mountGuideChatRoutes(app, {
    db, now, idempotencyService, asyncHandler, createMutatingRoute, assertActorRoleAllowed,
  });

  // ── Claude SDK helper chatbot ──
  mountClaudeSdkHelpRoutes(app, {
    idempotencyService,
    asyncHandler,
    createMutatingRoute,
    assertActorRoleAllowed,
  });

  app.use((error, req, res, _next) => {
    const { statusCode, code: errorCode, message } = resolveErrorResponse(error);
    res.locals.errorCode = errorCode;

    if (statusCode >= 500) {
      // One greppable line carrying the route and requestId, so a failure reported from
      // the browser can be matched to this log without scanning the whole stream.
      // eslint-disable-next-line no-console
      console.error('[bff] unhandled error', JSON.stringify({
        method: req.method,
        path: req.originalUrl || req.url,
        requestId: req.requestId || req.context?.requestId || null,
        tenantId: req.context?.tenantId || null,
        name: error?.name || null,
        message: error?.message || String(error),
        code: error?.code || null,
      }), error?.stack || error);
    }

    res.status(statusCode).json({
      error: errorCode,
      message,
      requestId: req.requestId || req.context?.requestId,
      ...(statusCode < 500 && error?.details ? { details: error.details } : {}),
    });
  });

  return app;
}
