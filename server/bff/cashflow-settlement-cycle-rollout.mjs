import { requireCashflowSettlementCycleReadContext } from './cashflow/settlement-cycle/jvm-anti-corruption-adapter.mjs';
import {
  CASHFLOW_SETTLEMENT_CYCLE_CUTOFF_MONTH,
  isHistoricalCashflowSettlementCycle,
} from './cashflow/settlement-cycle/contract.mjs';
import { sha256, stableStringify } from './utils.mjs';

const CONTRACT_VERSION = 'cashflow-cumulative-close-v2';
const MIGRATE_COMMAND = 'cashflowSettlementCycle.migrateHeadV2';
const NORMALIZE_COMMAND = 'cashflowSettlementCycle.normalizeLegacyActiveRequest';
const ACTIVE_REQUEST_STATES = new Set([
  'BUILDING', 'PENDING', 'PENDING_APPROVAL', 'APPROVING', 'UNCERTAIN', 'REOPEN_REQUESTED',
]);
const ACTIVE_COORDINATOR_STATES = new Set(['PENDING_APPROVAL', 'REOPENED', 'REOPEN_REQUESTED']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ROOT_HASH = /^sha256:[a-f0-9]{64}$/;
const YEAR_MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const ROLLOUT_COUNT_NAMES = [
  'legacyHeads', 'canonicalHeads', 'recoverableHeads', 'invalidHeads',
  'unresolvedRequests', 'legacyActiveRequests', 'coordinators', 'activeCoordinators',
  'invalidCoordinators', 'historicalActiveRequests', 'normalizationCandidates',
  'canonicalActiveRequests', 'invalidActiveRequests', 'genericMonthDocuments',
];
const CUTOVER_BLOCKER_NAMES = [
  'legacyHeads', 'invalidHeads', 'normalizationCandidates',
  'invalidActiveRequests', 'invalidCoordinators',
];
const HEAD_MIGRATION_BLOCKER_NAMES = [
  'invalidHeads', 'invalidActiveRequests', 'invalidCoordinators',
];

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function dataOf(document) {
  return document?.data && typeof document.data === 'function'
    ? document.data() || {}
    : document?.data || {};
}

function parseCsv(value) {
  return [...new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function isExactHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && url.pathname === '/'
      && !url.search
      && !url.hash
      && url.origin === value;
  } catch {
    return false;
  }
}

export function parseSettlementCycleRolloutArgs(args) {
  const options = {
    apply: false,
    verifyCutover: false,
    allowProjects: [],
    normalizeProjects: [],
  };
  const valueFlags = new Map([
    ['--firebase-project', 'firebaseProjectId'],
    ['--confirm-project', 'confirmProjectId'],
    ['--tenant', 'tenantId'],
    ['--confirm-tenant', 'confirmTenantId'],
    ['--allow-projects', 'allowProjects'],
    ['--normalize-projects', 'normalizeProjects'],
    ['--people-uid', 'actorUid'],
    ['--reason', 'reason'],
    ['--jvm-base-url', 'jvmBaseUrl'],
    ['--jvm-audience', 'jvmAudience'],
    ['--output', 'outputPath'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--verify-cutover') {
      options.verifyCutover = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    const field = valueFlags.get(arg);
    if (!field || index + 1 >= args.length) throw new Error(`Unknown or incomplete option: ${arg}`);
    const value = args[index + 1];
    index += 1;
    options[field] = ['allowProjects', 'normalizeProjects'].includes(field) ? parseCsv(value) : value;
  }
  return options;
}

export function validateSettlementCycleRolloutOptions(source) {
  const options = {
    ...source,
    firebaseProjectId: text(source.firebaseProjectId),
    confirmProjectId: text(source.confirmProjectId),
    tenantId: text(source.tenantId),
    confirmTenantId: text(source.confirmTenantId),
    actorUid: text(source.actorUid),
    reason: text(source.reason),
    jvmBaseUrl: text(source.jvmBaseUrl).replace(/\/$/, ''),
    jvmAudience: text(source.jvmAudience || source.jvmBaseUrl).replace(/\/$/, ''),
    allowProjects: parseCsv(source.allowProjects),
    normalizeProjects: parseCsv(source.normalizeProjects),
  };
  if (!SAFE_ID.test(options.firebaseProjectId)) throw new Error('--firebase-project is required and must be exact.');
  if (!SAFE_ID.test(options.tenantId)) throw new Error('--tenant is required and must be exact.');
  if (options.verifyCutover && !isExactHttpsOrigin(options.jvmBaseUrl)) {
    throw new Error('--verify-cutover requires an exact HTTPS --jvm-base-url origin.');
  }
  if (options.verifyCutover && !isExactHttpsOrigin(options.jvmAudience)) {
    throw new Error('--verify-cutover requires an exact HTTPS --jvm-audience origin.');
  }
  if (options.verifyCutover && !SAFE_ID.test(options.actorUid)) {
    throw new Error('--verify-cutover requires an exact active --people-uid.');
  }
  if (options.verifyCutover && (options.normalizeProjects.length === 0
    || options.normalizeProjects.some((projectId) => projectId === '*' || !SAFE_ID.test(projectId)))) {
    throw new Error('--verify-cutover requires exact --normalize-projects without wildcard.');
  }
  if (!options.apply) return options;
  if (options.confirmProjectId !== options.firebaseProjectId) {
    throw new Error('--confirm-project must exactly match --firebase-project.');
  }
  if (options.confirmTenantId !== options.tenantId) {
    throw new Error('--confirm-tenant must exactly match --tenant.');
  }
  if (options.allowProjects.length === 0
    || options.allowProjects.some((projectId) => projectId === '*' || !SAFE_ID.test(projectId))) {
    throw new Error('--allow-projects must contain exact project IDs and cannot use wildcard.');
  }
  if (!SAFE_ID.test(options.actorUid)) throw new Error('--people-uid must be an exact active People UID.');
  if (!options.reason || options.reason.length > 1_000) {
    throw new Error('--reason is required and must be 1..1000 characters.');
  }
  if (!isExactHttpsOrigin(options.jvmBaseUrl)) {
    throw new Error('--jvm-base-url must be an exact HTTPS origin for apply.');
  }
  if (!isExactHttpsOrigin(options.jvmAudience)) {
    throw new Error('--jvm-audience must be an exact HTTPS origin for apply.');
  }
  return { ...options, verifyCutover: true };
}

function coordinatorIsInvalid(record) {
  if (text(record.documentType) !== 'ACTIVE_COORDINATOR'
    || !SAFE_ID.test(text(record.projectId))
    || !Number.isSafeInteger(record.workflowRevision)
    || record.workflowRevision < 0) return true;
  const state = text(record.activeState);
  const activeCycle = text(record.activeCycleYearMonth);
  const activeRequest = text(record.activeRequestId);
  if (state === 'INACTIVE') return Boolean(activeCycle || activeRequest);
  return !ACTIVE_COORDINATOR_STATES.has(state)
    || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(activeCycle)
    || activeRequest !== `${text(record.projectId)}-${activeCycle}`;
}

function canonicalActiveRequest(documentId, record) {
  const projectId = text(record.projectId);
  const cycleYearMonth = text(record.cycleYearMonth);
  return text(record.documentType) === 'REQUEST'
    && text(record.contractVersion) === CONTRACT_VERSION
    && SAFE_ID.test(projectId)
    && YEAR_MONTH.test(cycleYearMonth)
    && text(record.monthCloseTargetYearMonth) === previousYearMonth(cycleYearMonth)
    && text(record.requestId) === documentId
    && documentId === `${projectId}-${cycleYearMonth}`;
}

function requestCycle(record) {
  return text(record.cycleYearMonth) || text(record.yearMonth);
}

function historicalActiveRequest(documentId, record) {
  const projectId = text(record.projectId);
  const cycleYearMonth = requestCycle(record);
  return SAFE_ID.test(projectId)
    && YEAR_MONTH.test(cycleYearMonth)
    && isHistoricalCashflowSettlementCycle(cycleYearMonth)
    && text(record.contractVersion) === CONTRACT_VERSION
    && text(record.requestId) === documentId
    && documentId === `${projectId}-${cycleYearMonth}`;
}

function normalizationCandidate(documentId, record) {
  const projectId = text(record.projectId);
  const cycleYearMonth = requestCycle(record);
  const revision = Number(record.revision);
  const manifestHash = text(record.manifestHash);
  const requestedAt = text(record.requestedAt);
  const requestedByUid = text(record.requestedByUid);
  if (text(record.documentType)
    || text(record.contractVersion) !== CONTRACT_VERSION
    || !SAFE_ID.test(projectId)
    || cycleYearMonth !== CASHFLOW_SETTLEMENT_CYCLE_CUTOFF_MONTH
    || text(record.yearMonth) !== cycleYearMonth
    || text(record.requestId) !== documentId
    || documentId !== `${projectId}-${cycleYearMonth}`
    || text(record.throughMonth) !== previousYearMonth(cycleYearMonth)
    || text(record.status) !== 'PENDING'
    || !Number.isSafeInteger(revision) || revision < 1
    || !ROOT_HASH.test(manifestHash)
    || !ISO_INSTANT.test(requestedAt)
    || !SAFE_ID.test(requestedByUid)) return null;
  return {
    projectId,
    requestId: documentId,
    cycleYearMonth,
    monthCloseTargetYearMonth: previousYearMonth(cycleYearMonth),
    expectedRequestRevision: revision,
    expectedManifestHash: manifestHash,
    requestedAt,
    requestedByUid,
  };
}

function previousYearMonth(value) {
  if (!YEAR_MONTH.test(text(value))) return '';
  const [year, month] = value.split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

function nextYearMonth(value) {
  if (!YEAR_MONTH.test(text(value))) return '';
  const [year, month] = value.split('-').map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

function canonicalHeadProjectionTarget(projectId, record, allowLegacyTargetRequest = false) {
  if (text(record.contractVersion) !== CONTRACT_VERSION
    || text(record.projectId) !== projectId
    || text(record.fromMonth) !== '2023-01'
    || !Number.isSafeInteger(record.revision)
    || record.revision <= 0
    || typeof record.authorityExists !== 'boolean'
    || !Array.isArray(record.closedRanges)) return null;
  if (record.authorityExists === false) {
    return text(record.status) === 'OPEN' && record.closedRanges.length === 0
      ? { canonical: true, target: null }
      : null;
  }
  if (!['CLOSED', 'REOPEN_REQUESTED'].includes(text(record.status))
    || !ROOT_HASH.test(text(record.rootHash))
    || !YEAR_MONTH.test(text(record.closedThrough))
    || nextYearMonth(record.closedThrough) !== text(record.settlementMonth)
    || record.closedRanges.length === 0) return null;
  let expectedFrom = null;
  for (const range of record.closedRanges) {
    if (!range || typeof range !== 'object' || Array.isArray(range)
      || !YEAR_MONTH.test(text(range.affectedThroughMonth))
      || (expectedFrom === null
        ? !['2023-01', `${text(range.affectedThroughMonth).slice(0, 4)}-01`].includes(text(range.affectedFromMonth))
        : text(range.affectedFromMonth) !== expectedFrom)
      || text(range.affectedThroughMonth) < text(range.affectedFromMonth)
      || nextYearMonth(range.affectedThroughMonth) !== text(range.closedByCycleYearMonth)
      || !SAFE_ID.test(text(range.approvalVersionId))
      || !SAFE_ID.test(text(range.requestId))
      || !Number.isSafeInteger(range.ledgerRevision)
      || range.ledgerRevision <= 0
      || !ROOT_HASH.test(text(range.rootHash))) return null;
    expectedFrom = nextYearMonth(range.affectedThroughMonth);
  }
  const latest = record.closedRanges.at(-1);
  const cycleRequestId = `${projectId}-${text(latest.closedByCycleYearMonth)}`;
  const targetRequestId = `${projectId}-${text(latest.affectedThroughMonth)}`;
  if (text(latest.affectedThroughMonth) !== text(record.closedThrough)
    || text(latest.rootHash) !== text(record.rootHash)
    || (text(latest.requestId) !== cycleRequestId
      && (!allowLegacyTargetRequest || text(latest.requestId) !== targetRequestId))) return null;
  return {
    canonical: true,
    target: {
      projectId,
      cycleYearMonth: text(latest.closedByCycleYearMonth),
      requestId: text(latest.requestId),
    },
  };
}

function validLegacyHead(projectId, record) {
  return SAFE_ID.test(projectId)
    && text(record.contractVersion) === CONTRACT_VERSION
    && text(record.projectId) === projectId
    && text(record.status) === 'CLOSED'
    && text(record.fromMonth) === '2023-01'
    && YEAR_MONTH.test(text(record.closedThrough))
    && nextYearMonth(record.closedThrough) === text(record.settlementMonth)
    && Number.isSafeInteger(record.revision)
    && record.revision > 0
    && SAFE_ID.test(text(record.requestId))
    && Number.isSafeInteger(record.requestRevision)
    && record.requestRevision > 0
    && ROOT_HASH.test(text(record.rootHash))
    && !Object.hasOwn(record, 'authorityExists')
    && !Object.hasOwn(record, 'closedRanges');
}

function normalizedClosedRanges(record) {
  return Array.isArray(record.closedRanges)
    ? record.closedRanges.map((range) => ({
      affectedFromMonth: text(range?.affectedFromMonth),
      affectedThroughMonth: text(range?.affectedThroughMonth),
      closedByCycleYearMonth: text(range?.closedByCycleYearMonth),
      approvalVersionId: text(range?.approvalVersionId),
      requestId: text(range?.requestId),
      ledgerRevision: Number.isSafeInteger(range?.ledgerRevision) ? range.ledgerRevision : null,
      rootHash: text(range?.rootHash),
    }))
    : null;
}

function normalizedHeadState(document) {
  const record = dataOf(document);
  return {
    projectId: text(document.id),
    tenantId: text(record.tenantId),
    contractVersion: text(record.contractVersion),
    authorityExists: typeof record.authorityExists === 'boolean' ? record.authorityExists : null,
    status: text(record.status),
    revision: Number.isSafeInteger(record.revision) ? record.revision : null,
    fromMonth: text(record.fromMonth),
    closedThrough: text(record.closedThrough),
    settlementMonth: text(record.settlementMonth),
    rootHash: text(record.rootHash),
    requestId: text(record.requestId),
    requestRevision: Number.isSafeInteger(record.requestRevision) ? record.requestRevision : null,
    approvalId: text(record.approvalId),
    operationId: text(record.operationId),
    migratedAt: text(record.migratedAt),
    migratedByUid: text(record.migratedByUid),
    closedRanges: normalizedClosedRanges(record),
  };
}

function recoverableMigratedHead(projectId, record, projection) {
  const ranges = Array.isArray(record.closedRanges) ? record.closedRanges : [];
  const range = ranges[0];
  const migratedAt = text(record.migratedAt);
  const migratedByUid = text(record.migratedByUid);
  const tenantId = text(record.tenantId);
  if (!projection?.target
    || text(record.status) !== 'CLOSED'
    || ranges.length !== 1
    || !ISO_INSTANT.test(migratedAt)
    || !Number.isFinite(Date.parse(migratedAt))
    || !SAFE_ID.test(migratedByUid)
    || !SAFE_ID.test(tenantId)
    || !Number.isSafeInteger(record.revision)
    || record.revision <= 1
    || !Number.isSafeInteger(record.requestRevision)
    || record.requestRevision <= 0
    || text(record.requestId) !== text(range?.requestId)
    || text(record.rootHash) !== text(range?.rootHash)) return null;
  return {
    projectId,
    expectedHeadRevision: record.revision,
    expectedHeadRootHash: text(record.rootHash),
    tenantId,
  };
}

function normalizedRequestState(document) {
  const record = dataOf(document);
  return {
    documentId: text(document.id),
    documentType: text(record.documentType),
    contractVersion: text(record.contractVersion),
    projectId: text(record.projectId),
    requestId: text(record.requestId),
    yearMonth: text(record.yearMonth),
    cycleYearMonth: text(record.cycleYearMonth),
    monthCloseTargetYearMonth: text(record.monthCloseTargetYearMonth),
    throughMonth: text(record.throughMonth),
    status: text(record.status),
    revision: Number.isSafeInteger(record.revision) ? record.revision : null,
    evidenceRevision: Number.isSafeInteger(record.evidenceRevision) ? record.evidenceRevision : null,
    workflowRevision: Number.isSafeInteger(record.workflowRevision) ? record.workflowRevision : null,
    ledgerRevision: Number.isSafeInteger(record.ledgerRevision) ? record.ledgerRevision : null,
    manifestHash: text(record.manifestHash),
    activeState: text(record.activeState),
    activeCycleYearMonth: text(record.activeCycleYearMonth),
    activeRequestId: text(record.activeRequestId),
  };
}

function normalizedSettlementState(document) {
  const record = dataOf(document);
  const month = record?.periods?.MONTH;
  return {
    documentId: text(document.id),
    projectId: text(record.projectId),
    yearMonth: text(record.yearMonth),
    month: month && typeof month === 'object' && !Array.isArray(month)
      ? {
        status: text(month.status),
        revision: Number.isSafeInteger(month.revision) ? month.revision : null,
        submittedAt: text(month.submittedAt),
        submittedBy: text(month.submittedBy),
        approvedAt: text(month.approvedAt),
        approvedBy: text(month.approvedBy),
      }
      : null,
  };
}

function protectedSettlementStatus(document) {
  const seconds = document?.updateTime?.seconds;
  const nanoseconds = document?.updateTime?.nanoseconds;
  return {
    documentId: typeof document?.id === 'string' ? document.id : '',
    dataHash: `sha256:${sha256(stableStringify(dataOf(document)))}`,
    updateTime: Number.isSafeInteger(seconds) && Number.isSafeInteger(nanoseconds)
      ? { seconds, nanoseconds }
      : null,
  };
}

export function buildSettlementCycleRolloutInventory({ requests = [], heads = [], settlements = [] }) {
  const legacyHeads = [];
  const recoverableHeads = [];
  const invalidHeads = [];
  const verificationTargets = [];
  const headCycleByProject = new Map();
  let canonicalHeadCount = 0;
  for (const document of heads) {
    const record = dataOf(document);
    const projectId = text(document.id);
    const canonical = canonicalHeadProjectionTarget(projectId, record);
    const recoverable = recoverableMigratedHead(
      projectId, record, canonical || canonicalHeadProjectionTarget(projectId, record, true),
    );
    if (canonical) {
      canonicalHeadCount += 1;
      if (canonical.target) {
        verificationTargets.push(canonical.target);
        headCycleByProject.set(projectId, canonical.target.cycleYearMonth);
      }
      if (recoverable) recoverableHeads.push(recoverable);
    } else if (recoverable) {
      recoverableHeads.push(recoverable);
    } else if (validLegacyHead(projectId, record)) {
      legacyHeads.push({
        projectId,
        expectedHeadRevision: record.revision,
        expectedHeadRootHash: text(record.rootHash),
      });
    } else {
      invalidHeads.push({ projectId, reason: 'HEAD_SCHEMA_INVALID' });
    }
  }

  const unresolvedRequests = [];
  const legacyActiveRequests = [];
  const historicalActiveRequests = [];
  const normalizationCandidates = [];
  const canonicalActiveRequests = [];
  const invalidActiveRequests = [];
  const invalidCoordinators = [];
  const activeCoordinatorRecords = [];
  let coordinatorCount = 0;
  let activeCoordinatorCount = 0;
  for (const document of requests) {
    const record = dataOf(document);
    const documentType = text(record.documentType);
    if (documentType === 'ACTIVE_COORDINATOR') {
      coordinatorCount += 1;
      if (ACTIVE_COORDINATOR_STATES.has(text(record.activeState))) {
        activeCoordinatorCount += 1;
        activeCoordinatorRecords.push({
          projectId: text(record.projectId),
          cycleYearMonth: text(record.activeCycleYearMonth),
          requestId: text(record.activeRequestId),
          workflowRevision: Number(record.workflowRevision),
        });
      }
      if (coordinatorIsInvalid(record)) invalidCoordinators.push({ id: document.id, projectId: text(record.projectId) });
      continue;
    }
    const status = text(record.status);
    if (ACTIVE_REQUEST_STATES.has(status)) {
      unresolvedRequests.push({ requestId: document.id, projectId: text(record.projectId), status });
      if (!canonicalActiveRequest(document.id, record)) {
        legacyActiveRequests.push({ requestId: document.id, projectId: text(record.projectId), status });
      }
      const historical = historicalActiveRequest(document.id, record);
      const candidate = normalizationCandidate(document.id, record);
      if (historical) {
        historicalActiveRequests.push({
          requestId: document.id,
          projectId: text(record.projectId),
          status,
          revision: Number(record.revision),
          dataHash: `sha256:${sha256(stableStringify(record))}`,
        });
      } else if (candidate) {
        normalizationCandidates.push(candidate);
      } else if (canonicalActiveRequest(document.id, record)) {
        const active = {
          projectId: text(record.projectId),
          requestId: document.id,
          cycleYearMonth: requestCycle(record),
          monthCloseTargetYearMonth: text(record.monthCloseTargetYearMonth),
          workflowRevision: Number(record.workflowRevision),
          evidenceRevision: Number(record.evidenceRevision),
          manifestHash: text(record.manifestHash),
          requestedAt: text(record.requestedAt),
          requestedByUid: text(record.requestedByUid),
          status,
        };
        canonicalActiveRequests.push(active);
        verificationTargets.push({
          projectId: active.projectId,
          cycleYearMonth: active.cycleYearMonth,
          requestId: active.requestId,
          expectedBusinessState: status === 'PENDING' || status === 'PENDING_APPROVAL'
            ? 'SUBMITTED' : status,
          expectedRequestStatus: status,
        });
      } else {
        invalidActiveRequests.push({ requestId: document.id, projectId: text(record.projectId), status });
      }
    }
    if (documentType === 'REQUEST'
      && text(record.contractVersion) === CONTRACT_VERSION
      && status === 'APPROVED') {
      const headCycle = headCycleByProject.get(text(record.projectId));
      // 프로젝트 헤드가 이미 더 나중 사이클을 닫았다면 지난 사이클의 승인 요청은
      // 현재 프로젝션과 대조할 대상이 아니다 (헤드 대상이 최신 사이클을 대표한다).
      if (!headCycle || text(record.cycleYearMonth) >= headCycle) {
        verificationTargets.push({
          projectId: text(record.projectId),
          cycleYearMonth: text(record.cycleYearMonth),
          requestId: text(record.requestId) || text(document.id),
        });
      }
    }
  }

  const targetMap = new Map();
  for (const target of verificationTargets) {
    targetMap.set(`${target.projectId}\n${target.cycleYearMonth}\n${target.requestId}`, target);
  }
  const genericMonthDocuments = settlements.filter((document) => {
    const month = dataOf(document)?.periods?.MONTH;
    return month && typeof month === 'object' && !Array.isArray(month);
  }).length;

  return {
    counts: {
      legacyHeads: legacyHeads.length,
      canonicalHeads: canonicalHeadCount,
      recoverableHeads: recoverableHeads.length,
      invalidHeads: invalidHeads.length,
      unresolvedRequests: unresolvedRequests.length,
      legacyActiveRequests: legacyActiveRequests.length,
      coordinators: coordinatorCount,
      activeCoordinators: activeCoordinatorCount,
      invalidCoordinators: invalidCoordinators.length,
      historicalActiveRequests: historicalActiveRequests.length,
      normalizationCandidates: normalizationCandidates.length,
      canonicalActiveRequests: canonicalActiveRequests.length,
      invalidActiveRequests: invalidActiveRequests.length,
      genericMonthDocuments,
    },
    legacyHeads: legacyHeads.sort((left, right) => left.projectId.localeCompare(right.projectId)),
    recoverableHeads: recoverableHeads.sort((left, right) => left.projectId.localeCompare(right.projectId)),
    invalidHeads: invalidHeads.sort((left, right) => left.projectId.localeCompare(right.projectId)),
    unresolvedRequests: unresolvedRequests.sort((left, right) => left.requestId.localeCompare(right.requestId)),
    legacyActiveRequests: legacyActiveRequests.sort((left, right) => left.requestId.localeCompare(right.requestId)),
    invalidCoordinators: invalidCoordinators.sort((left, right) => left.id.localeCompare(right.id)),
    historicalActiveRequests: historicalActiveRequests.sort((left, right) => left.requestId.localeCompare(right.requestId)),
    normalizationCandidates: normalizationCandidates.sort((left, right) => left.requestId.localeCompare(right.requestId)),
    canonicalActiveRequests: canonicalActiveRequests.sort((left, right) => left.requestId.localeCompare(right.requestId)),
    activeCoordinatorRecords: activeCoordinatorRecords.sort((left, right) => left.requestId.localeCompare(right.requestId)),
    invalidActiveRequests: invalidActiveRequests.sort((left, right) => left.requestId.localeCompare(right.requestId)),
    verificationTargets: [...targetMap.values()].sort((left, right) => (
      left.projectId.localeCompare(right.projectId)
      || left.cycleYearMonth.localeCompare(right.cycleYearMonth)
    )),
    protectedSettlementStatuses: settlements.map(protectedSettlementStatus)
      .sort((left, right) => left.documentId.localeCompare(right.documentId)),
    canonicalState: {
      heads: heads.map(normalizedHeadState).sort((left, right) => left.projectId.localeCompare(right.projectId)),
      requests: requests.map(normalizedRequestState)
        .sort((left, right) => left.documentId.localeCompare(right.documentId)),
      settlements: settlements.map(normalizedSettlementState)
        .sort((left, right) => left.documentId.localeCompare(right.documentId)),
    },
  };
}

export async function readSettlementCycleRolloutInventory({ db, tenantId }) {
  const basePath = `orgs/${tenantId}`;
  const paths = [
    `${basePath}/cashflow_month_close_requests`,
    `${basePath}/cashflow_cumulative_close_heads`,
    `${basePath}/cashflow_settlement_statuses`,
  ];
  const queries = paths.map((path) => db.collection(path));
  const [requests, heads, settlements] = await db.runTransaction(
    (transaction) => Promise.all(queries.map((query) => transaction.get(query))),
    { readOnly: true },
  );
  return buildSettlementCycleRolloutInventory({
    requests: requests.docs,
    heads: heads.docs,
    settlements: settlements.docs,
  });
}

export function settlementCycleRequestNormalizationCandidates(inventory) {
  const pending = Array.isArray(inventory?.normalizationCandidates)
    ? inventory.normalizationCandidates : [];
  const completed = (Array.isArray(inventory?.canonicalActiveRequests)
    ? inventory.canonicalActiveRequests : [])
    .filter((row) => row.cycleYearMonth === CASHFLOW_SETTLEMENT_CYCLE_CUTOFF_MONTH
      && row.monthCloseTargetYearMonth === previousYearMonth(row.cycleYearMonth)
      && row.status === 'PENDING_APPROVAL'
      && Number.isSafeInteger(row.workflowRevision) && row.workflowRevision > 0
      && Number.isSafeInteger(row.evidenceRevision) && row.evidenceRevision > 0
      && ROOT_HASH.test(row.manifestHash)
      && ISO_INSTANT.test(row.requestedAt)
      && SAFE_ID.test(row.requestedByUid))
    .map((row) => ({
      projectId: row.projectId,
      requestId: row.requestId,
      cycleYearMonth: row.cycleYearMonth,
      monthCloseTargetYearMonth: row.monthCloseTargetYearMonth,
      expectedRequestRevision: row.evidenceRevision,
      expectedManifestHash: row.manifestHash,
      requestedAt: row.requestedAt,
      requestedByUid: row.requestedByUid,
      workflowRevision: row.workflowRevision,
      alreadyNormalized: true,
    }));
  return [...pending, ...completed]
    .sort((left, right) => left.projectId.localeCompare(right.projectId));
}

export async function verifySettlementCycleProjections({ targets = [], readProjection, readAlignedRequest }) {
  if (typeof readProjection !== 'function' || typeof readAlignedRequest !== 'function') {
    throw new Error('Settlement-cycle projection and BFF aligned-request readers are required.');
  }
  const projections = [];
  for (const target of targets) {
    const response = await readProjection({
      projectId: target.projectId,
      cycleYearMonth: target.cycleYearMonth,
    });
    const projection = response?.settlementCycle;
    if (text(projection?.cycleYearMonth) !== target.cycleYearMonth) {
      throw new Error(`Settlement-cycle projection identity mismatch for ${target.projectId}`);
    }
    let context;
    try {
      context = requireCashflowSettlementCycleReadContext(response, {
        projectId: target.projectId,
        cycleYearMonth: target.cycleYearMonth,
      });
    } catch {
      throw new Error(`Settlement-cycle projection contract is invalid for ${target.projectId}`);
    }
    const requestId = context.requestId;
    if (requestId !== target.requestId) {
      throw new Error(`Settlement-cycle projection identity mismatch for ${target.projectId}`);
    }
    const aligned = await readAlignedRequest({ projectId: target.projectId, context });
    if (!aligned
      || text(aligned.requestId) !== target.requestId
      || text(aligned.cycleYearMonth || aligned.yearMonth) !== context.requestCycleYearMonth
      || text(aligned.monthCloseTargetYearMonth || aligned.throughMonth) !== context.requestTargetYearMonth
      || text(aligned.status) !== text(target.expectedRequestStatus || 'APPROVED')) {
      throw new Error(`Settlement-cycle BFF read alignment mismatch for ${target.projectId}`);
    }
    const businessState = text(projection?.businessState);
    const health = text(projection?.health);
    if (!businessState || !health) {
      throw new Error(`Settlement-cycle projection is incomplete for ${target.projectId}`);
    }
    projections.push({
      projectId: target.projectId,
      cycleYearMonth: target.cycleYearMonth,
      requestId,
      businessState,
      health,
    });
  }
  return projections;
}

export async function createSettlementCycleJvmOperations({ client, tenantId, actorUid }) {
  if (!client || typeof client.requestJson !== 'function') {
    throw new Error('A JVM client is required.');
  }
  const context = {
    tenantId,
    actorId: actorUid,
    actorRole: 'admin',
    requestId: `settlement-cycle-rollout:${actorUid}`,
  };
  const health = await client.requestJson({
    context,
    method: 'GET',
    path: '/api/v1/health',
    command: 'settlement_cycle_rollout_health',
    retry: false,
    mutation: false,
  });
  if (!Array.isArray(health?.capabilities)
    || !health.capabilities.includes('settlement-cycle-v1')) {
    throw new Error('The JVM settlement-cycle-v1 capability is not available.');
  }
  return {
    migrate: ({ projectId, body }) => client.requestJson({
      context,
      method: 'POST',
      path: `/api/v1/cashflow/${encodeURIComponent(projectId)}/settlement-cycle/migrate-head-v2`,
      command: MIGRATE_COMMAND,
      body,
      retry: false,
      mutation: true,
    }),
    normalize: ({ projectId, body }) => client.requestJson({
      context,
      method: 'POST',
      path: `/api/v1/cashflow/${encodeURIComponent(projectId)}/settlement-cycle/normalize-legacy-active-request`,
      command: NORMALIZE_COMMAND,
      body,
      retry: false,
      mutation: true,
    }),
    readProjection: ({ projectId, cycleYearMonth }) => client.requestJson({
      context,
      method: 'GET',
      path: `/api/v1/cashflow/${encodeURIComponent(projectId)}/month-close/dashboard-source?yearMonth=${encodeURIComponent(cycleYearMonth)}&settlementCycle=true`,
      command: 'cashflowSettlementCycle.readProjection',
      retry: false,
      mutation: false,
    }),
  };
}

export function buildSettlementCycleHeadMigrationBody({
  tenantId, projectId, expectedHeadRevision, expectedHeadRootHash, reason,
  dryRun = false, expectedMigrationFingerprint = '',
}) {
  const digest = text(expectedHeadRootHash).replace(/^sha256:/, '').slice(0, 16);
  return {
    idempotencyKey: `settlement-cycle-v3:${tenantId}:${projectId}:r${expectedHeadRevision}:${digest}`,
    expectedHeadRevision,
    expectedHeadRootHash,
    reason: text(reason),
    dryRun,
    expectedMigrationFingerprint,
  };
}

export function buildSettlementCycleRequestNormalizationBody({
  tenantId, projectId, cycleYearMonth, expectedRequestRevision, expectedManifestHash, reason,
  dryRun = false, expectedMigrationFingerprint = '',
}) {
  const digest = text(expectedManifestHash).replace(/^sha256:/, '').slice(0, 16);
  return {
    idempotencyKey: `settlement-cycle-normalize-v1:${tenantId}:${projectId}:r${expectedRequestRevision}:${digest}`,
    cycleYearMonth,
    expectedRequestRevision,
    expectedManifestHash,
    reason: text(reason),
    dryRun,
    expectedMigrationFingerprint,
  };
}

function migrationResponseIsValid({ projectId, row, response, expected, dryRun }) {
  const migrationRequired = response?.migrationRequired;
  return response?.ok === true
    && text(response.commandName) === MIGRATE_COMMAND
    && text(response.projectId) === projectId
    && typeof migrationRequired === 'boolean'
    && Number(response.headRevision) === row.expectedHeadRevision + (migrationRequired ? 1 : 0)
    && (dryRun || migrationRequired)
    && YEAR_MONTH.test(text(response.closedThrough))
    && nextYearMonth(response.closedThrough) === text(response.cycleYearMonth)
    && SAFE_ID.test(text(response.approvalVersionId))
    && ROOT_HASH.test(text(response.migrationFingerprint))
    && (dryRun ? !text(response.auditId) : Boolean(text(response.auditId)))
    && (!expected || (
      text(response.closedThrough) === text(expected.closedThrough)
      && text(response.cycleYearMonth) === text(expected.cycleYearMonth)
      && text(response.approvalVersionId) === text(expected.approvalVersionId)
      && Number(response.headRevision) === Number(expected.headRevision)
      && text(response.migrationFingerprint) === text(expected.migrationFingerprint)
    ));
}

export async function executeSettlementCycleHeadMigrations({ inventory, options, migrate }) {
  if (!options.apply) return [];
  const blockers = HEAD_MIGRATION_BLOCKER_NAMES
    .filter((name) => Number(inventory?.counts?.[name] || 0) !== 0)
    .map((name) => `${name}=${inventory.counts[name]}`);
  if (blockers.length > 0) {
    throw new Error(`Settlement-cycle migration is not ready: ${blockers.join(', ')}`);
  }
  const legacyByProject = new Map((inventory.legacyHeads || []).map((row) => [row.projectId, row]));
  const migratedByProject = new Map((inventory.recoverableHeads || []).map((row) => [row.projectId, row]));
  const activeRequests = inventory.canonicalActiveRequests || [];
  const activeCoordinators = inventory.activeCoordinatorRecords || [];
  if (activeRequests.length || activeCoordinators.length) {
    const activeKeys = activeRequests
      .map((row) => `${row.projectId}\n${row.cycleYearMonth}\n${row.requestId}\n${row.workflowRevision}`).sort();
    const coordinatorKeys = activeCoordinators
      .map((row) => `${row.projectId}\n${row.cycleYearMonth}\n${row.requestId}\n${row.workflowRevision}`).sort();
    if (legacyByProject.size || stableStringify(activeKeys) !== stableStringify(coordinatorKeys)
      || stableStringify([...migratedByProject.keys()].sort())
        !== stableStringify([...options.allowProjects].sort())
      || [...migratedByProject.values()].some(({ tenantId }) => tenantId !== options.tenantId)) {
      throw new Error('Settlement-cycle migration resume order is invalid.');
    }
    return [];
  }
  const plans = options.allowProjects.map((projectId) => {
    const legacy = legacyByProject.get(projectId);
    const migrated = migratedByProject.get(projectId);
    if (legacy && migrated) {
      throw new Error(`Allowlisted project has ambiguous migration evidence: ${projectId}`);
    }
    const row = legacy || migrated;
    if (!row) throw new Error(`Allowlisted project is not eligible for migration or replay: ${projectId}`);
    if (migrated && migrated.tenantId !== options.tenantId) {
      throw new Error(`Allowlisted migrated head is bound to a different tenant: ${projectId}`);
    }
    return { projectId, row, body: buildSettlementCycleHeadMigrationBody({
      tenantId: options.tenantId,
      actorUid: options.actorUid,
      reason: options.reason,
      ...row,
    }) };
  });
  for (const plan of plans) {
    const response = await migrate({
      projectId: plan.projectId,
      body: { ...plan.body, dryRun: true },
    });
    if (!migrationResponseIsValid({ ...plan, response, dryRun: true })) {
      throw new Error(`JVM returned an invalid migration dry-run response for ${plan.projectId}`);
    }
    plan.migrationFingerprint = text(response.migrationFingerprint);
    plan.migrationRequired = response.migrationRequired;
    plan.dryRunResponse = response;
  }
  const results = [];
  for (const plan of plans.filter(({ migrationRequired }) => migrationRequired)) {
    const body = {
      ...plan.body,
      expectedMigrationFingerprint: plan.migrationFingerprint,
    };
    const response = await migrate({ projectId: plan.projectId, body });
    if (!migrationResponseIsValid({
      ...plan, response, expected: plan.dryRunResponse, dryRun: false,
    })) {
      throw new Error(`JVM returned an invalid migration response for ${plan.projectId}`);
    }
    results.push({
      projectId: plan.projectId,
      cycleYearMonth: text(response.cycleYearMonth),
      headRevision: response.headRevision,
      auditId: response.auditId,
    });
  }
  return results;
}

function normalizationResponseIsValid({ projectId, row, response, expected, dryRun }) {
  const migrationRequired = response?.migrationRequired;
  return response?.ok === true
    && text(response.commandName) === NORMALIZE_COMMAND
    && text(response.projectId) === projectId
    && text(response.cycleYearMonth) === row.cycleYearMonth
    && text(response.monthCloseTargetYearMonth) === row.monthCloseTargetYearMonth
    && text(response.requestId) === row.requestId
    && Number.isSafeInteger(response.workflowRevision) && response.workflowRevision > 0
    && (!row.workflowRevision || response.workflowRevision === row.workflowRevision)
    && Number(response.evidenceRevision) === row.expectedRequestRevision
    && typeof migrationRequired === 'boolean'
    && (dryRun || migrationRequired)
    && ROOT_HASH.test(text(response.migrationFingerprint))
    && (dryRun ? !text(response.auditId) : Boolean(text(response.auditId)))
    && (!expected || (
      Number(response.workflowRevision) === Number(expected.workflowRevision)
      && Number(response.evidenceRevision) === Number(expected.evidenceRevision)
      && text(response.migrationFingerprint) === text(expected.migrationFingerprint)
    ));
}

export async function executeSettlementCycleRequestNormalizations({
  inventory, expectedCandidates = settlementCycleRequestNormalizationCandidates(inventory), options, normalize,
}) {
  if (!options.apply) return [];
  const blockerNames = [
    'legacyHeads', 'invalidHeads',
    'invalidActiveRequests', 'invalidCoordinators',
  ];
  const blockers = blockerNames
    .filter((name) => Number(inventory?.counts?.[name] || 0) !== 0)
    .map((name) => `${name}=${inventory.counts[name]}`);
  if (blockers.length > 0) {
    throw new Error(`Settlement-cycle request normalization is not ready: ${blockers.join(', ')}`);
  }
  const currentCandidates = settlementCycleRequestNormalizationCandidates(inventory);
  if (stableStringify(expectedCandidates) !== stableStringify(currentCandidates)) {
    throw new Error('Settlement-cycle request normalization evidence changed after head migration.');
  }
  const completedKeys = currentCandidates.filter(({ alreadyNormalized }) => alreadyNormalized)
    .map((row) => `${row.projectId}\n${row.cycleYearMonth}\n${row.requestId}\n${row.workflowRevision}`)
    .sort();
  const coordinatorKeys = (inventory?.activeCoordinatorRecords || [])
    .map((row) => `${row.projectId}\n${row.cycleYearMonth}\n${row.requestId}\n${row.workflowRevision}`)
    .sort();
  if (stableStringify(completedKeys) !== stableStringify(coordinatorKeys)) {
    throw new Error('Settlement-cycle normalized request coordinator changed.');
  }
  const candidates = new Map(expectedCandidates.map((row) => [row.projectId, row]));
  if (candidates.size !== expectedCandidates.length
    || stableStringify([...candidates.keys()].sort())
      !== stableStringify([...options.normalizeProjects].sort())) {
    throw new Error('Request normalization candidates do not match the exact allowlist.');
  }
  const plans = options.normalizeProjects.map((projectId) => {
    const row = candidates.get(projectId);
    if (!row) throw new Error(`Allowlisted project is not eligible for request normalization: ${projectId}`);
    return { projectId, row, body: buildSettlementCycleRequestNormalizationBody({
      tenantId: options.tenantId,
      projectId,
      reason: options.reason,
      ...row,
    }) };
  });
  for (const plan of plans) {
    const response = await normalize({
      projectId: plan.projectId,
      body: { ...plan.body, dryRun: true },
    });
    if (!normalizationResponseIsValid({ ...plan, response, dryRun: true })) {
      throw new Error(`JVM returned an invalid request normalization dry-run response for ${plan.projectId}`);
    }
    plan.dryRunResponse = response;
    plan.migrationRequired = response.migrationRequired;
  }
  const results = [];
  for (const plan of plans.filter(({ migrationRequired }) => migrationRequired)) {
    const response = await normalize({
      projectId: plan.projectId,
      body: {
        ...plan.body,
        expectedMigrationFingerprint: text(plan.dryRunResponse.migrationFingerprint),
      },
    });
    if (!normalizationResponseIsValid({
      ...plan, response, expected: plan.dryRunResponse, dryRun: false,
    })) {
      throw new Error(`JVM returned an invalid request normalization response for ${plan.projectId}`);
    }
    results.push({
      projectId: plan.projectId,
      cycleYearMonth: text(response.cycleYearMonth),
      requestId: text(response.requestId),
      workflowRevision: response.workflowRevision,
      auditId: response.auditId,
    });
  }
  return results;
}

export function assertSettlementCycleCutoverReady(inventory, projections, expectedActiveProjects = []) {
  const counts = inventory?.counts || {};
  const blockers = CUTOVER_BLOCKER_NAMES
    .map((name) => [name, counts[name]])
    .filter(([, count]) => Number(count || 0) !== 0);
  const invalidProjections = invalidProjectionCount(inventory, projections);
  const activeRequests = (inventory?.canonicalActiveRequests || []).map((record) => (
    `${record.projectId}\n${record.cycleYearMonth}\n${record.requestId}\n${record.workflowRevision}`
  )).sort();
  const activeCoordinators = (inventory?.activeCoordinatorRecords || []).map((record) => (
    `${record.projectId}\n${record.cycleYearMonth}\n${record.requestId}\n${record.workflowRevision}`
  )).sort();
  const activeMismatch = stableStringify(activeRequests) !== stableStringify(activeCoordinators);
  // 허용 목록은 전환 시점(CUTOFF 월 이하)에 검토한 진행 중 요청만 대상으로 한다.
  // 그 이후 사이클의 정상 진행 요청은 코디네이터 일치(activeMismatch)로 이미 검증한다.
  const activeProjects = (inventory?.canonicalActiveRequests || [])
    .filter(({ cycleYearMonth }) => text(cycleYearMonth) <= CASHFLOW_SETTLEMENT_CYCLE_CUTOFF_MONTH)
    .map(({ projectId }) => projectId).sort();
  const expectedActiveProjectSet = new Set(expectedActiveProjects);
  const unexpectedActive = expectedActiveProjects.length > 0
    && activeProjects.some((projectId) => !expectedActiveProjectSet.has(projectId));
  if (blockers.length > 0 || invalidProjections > 0 || activeMismatch || unexpectedActive) {
    const detail = [
      ...blockers.map(([name, count]) => `${name}=${count}`),
      ...(invalidProjections ? [`invalidProjections=${invalidProjections}`] : []),
      ...(activeMismatch ? ['activeCoordinatorMismatch=1'] : []),
      ...(unexpectedActive ? ['unexpectedActiveRequests=1'] : []),
    ].join(', ');
    throw new Error(`Settlement-cycle frontend cutover is not ready: ${detail}`);
  }
  return { ready: true, verifiedProjects: (inventory?.verificationTargets || []).length };
}

export function assertSettlementCycleInventoryStable(before, after) {
  if (settlementCycleRolloutFingerprint(before) !== settlementCycleRolloutFingerprint(after)) {
    throw new Error('Settlement-cycle canonical storage changed during cutover verification.');
  }
  return { stable: true };
}

export function assertProtectedSettlementStatusesUnchanged(before, after, documentIds = []) {
  const protectedIds = new Set(documentIds);
  const selected = (inventory) => (inventory?.protectedSettlementStatuses || [])
    .filter(({ documentId }) => protectedIds.size === 0 || protectedIds.has(documentId));
  if (stableStringify(selected(before)) !== stableStringify(selected(after))) {
    throw new Error('Protected cashflow settlement status documents changed during migration.');
  }
  return { stable: true };
}

export function settlementCycleRolloutFingerprint(value) {
  return sha256(stableStringify(value));
}

function aggregateRolloutCounts(inventory) {
  const source = inventory?.counts || {};
  const counts = Object.fromEntries(ROLLOUT_COUNT_NAMES.map((name) => [name, Number(source[name] || 0)]));
  return { ...counts, migrationCandidates: counts.legacyHeads + counts.recoverableHeads };
}

function invalidProjectionCount(inventory, projections) {
  const projectionMap = new Map((projections || []).map((projection) => [
    `${text(projection.projectId)}\n${text(projection.cycleYearMonth)}\n${text(projection.requestId)}`,
    projection,
  ]));
  return (inventory?.verificationTargets || []).filter((target) => {
    const projection = projectionMap.get(
      `${text(target.projectId)}\n${text(target.cycleYearMonth)}\n${text(target.requestId)}`,
    );
    return !projection
      || text(projection.businessState) !== text(target.expectedBusinessState || 'LOCKED')
      || text(projection.health) !== 'OK';
  }).length;
}

export function settlementCycleRolloutAuditSummary(report) {
  const before = aggregateRolloutCounts(report?.before);
  const after = aggregateRolloutCounts(report?.after);
  const blockers = Object.fromEntries(CUTOVER_BLOCKER_NAMES
    .map((name) => [name, after[name]])
    .filter(([, count]) => count !== 0));
  const invalidProjections = invalidProjectionCount(report?.after, report?.projections);
  if (invalidProjections > 0) blockers.invalidProjections = invalidProjections;
  const protectedSettlementStatuses = report?.before?.protectedSettlementStatuses || [];
  return {
    counts: {
      before,
      migrations: Array.isArray(report?.migrations) ? report.migrations.length : 0,
      normalizations: Array.isArray(report?.normalizations) ? report.normalizations.length : 0,
      after,
      projections: Array.isArray(report?.projections) ? report.projections.length : 0,
      verifiedProjects: Number(report?.cutover?.verifiedProjects || 0),
    },
    blockers,
    protectedSettlementStatuses: {
      count: protectedSettlementStatuses.length,
      fingerprint: settlementCycleRolloutFingerprint(protectedSettlementStatuses),
    },
    fingerprint: settlementCycleRolloutFingerprint(report),
  };
}
