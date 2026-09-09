import {
  asyncHandler,
  assertActorRoleAllowed,
  createHttpError,
  normalizeRole,
  readOptionalText,
  ROUTE_ROLES,
} from '../bff-utils.mjs';
import {
  isWorkspaceAuthMode,
  isWorkspaceUser,
  resolveJavaWeeklyApiServiceAccountJson,
} from '../java-weekly-auth.mjs';
import { assertCashflowMutationRuntime, createJavaWeeklyClient } from '../java-weekly-client.mjs';
import { createCashflowPerformanceTrace } from '../cashflow-performance.mjs';
import { cashflowAnnualTotalDocPath } from '../cashflow-annual-total.mjs';
import {
  buildCashflowProjectionActualComparison,
  resolveCashflowComparisonAsOf,
} from '../cashflow-comparison.mjs';
import { CASHFLOW_ALL_LINES, CASHFLOW_IN_LINES, CASHFLOW_OUT_LINES, CASHFLOW_MONTH_CELL_COUNT } from '../cashflow-policy.mjs';
import { stableStringify } from '../utils.mjs';
import { cashflowApplyLeaseMs, readCashflowApplyLeaseState } from '../cashflow-apply-lease.mjs';
import { getMonthFinanceWeeks, getYearFinanceWeeks } from '../../../src/app/platform/cashflow-week-core.mjs';
import { WEEKS_PER_MONTH, annualYearsFor, weekOrdinal } from '../cashflow-coordinates.mjs';
import { TENANT_WIDE_PROJECT_ROLES, isProjectInActorScope } from '../cashflow-project-scope.mjs';
import { cashflowCloseHash } from '../cashflow-close-hash.mjs';
import { safeAmount, sumSafe } from '../cashflow-amounts.mjs';
import { cashflowRangeSortKey } from '../cashflow-range.mjs';
import {
  CASHFLOW_MANAGEMENT_CHECK_IDS,
  futurePrepayCheck,
  laborTransferCheck,
  matchingManagementChecks,
  negativeProjectionCheck,
  profitVatAfterDepositCheck,
  validManagementConfirmations,
} from '../cashflow-management-checks.mjs';
import {
  CASHFLOW_CUMULATIVE_CLOSE_CONTRACT,
  CASHFLOW_CUMULATIVE_CLOSE_FROM_MONTH,
  cashflowCumulativeCloseScope,
  cumulativeCloseMonthsOrNull,
  monthsBetween,
  previousYearMonth,
  readCashflowCumulativeCloseAuthority,
} from '../cashflow-close-calendar.mjs';
import {
  cashflowMonthCloseRequestAuditPath,
  cashflowMonthCloseRequestPath,
} from '../cashflow-month-close-withdrawal.mjs';
import { cashflowWeeklyApproverDeadlineAt } from '../cashflow-close-deadline.mjs';
import {
  buildHistoricalCashflowSettlementCycle,
  readAlignedCashflowSettlementCycleRequest,
  requireCashflowSettlementCycleReadContext,
  requireCashflowSettlementStatusesBatchResult,
  requireCashflowSettlementStatusesResult,
} from '../cashflow/settlement-cycle/jvm-anti-corruption-adapter.mjs';
import {
  CASHFLOW_SETTLEMENT_CYCLE_CUTOFF_MONTH,
  isHistoricalCashflowSettlementCycle,
} from '../cashflow/settlement-cycle/contract.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';

const CASHFLOW_LINE_INDEX = new Map(CASHFLOW_ALL_LINES.map((lineId, index) => [lineId, index]));
const CASHFLOW_MONTH_CLOSE_ROUTE_TIMEOUT_MS = 26_000;
const CASHFLOW_MONTH_CLOSE_MUTATION_BUDGET_MS = 12_000;
const CASHFLOW_MONTH_CLOSE_REQUEST_MAX_BYTES = 900_000;
const CASHFLOW_WEEKLY_COMPLETE_ROLES = ['admin', 'finance', 'pm', 'viewer', 'tenant_admin'];
const CASHFLOW_MONTH_WORKFLOW_ROLES = ['admin', 'finance', 'pm', 'viewer'];
const CASHFLOW_APPROVER_LOCKED_COORDINATOR_STATES = ['PENDING_APPROVAL', 'REOPEN_REQUESTED', 'REOPENED'];

function requireExpectedWorkflowRevision(body) {
  const value = body?.expectedWorkflowRevision;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw createHttpError(
      400,
      '확인한 월 결산 처리 순번이 필요합니다.',
      'cashflow_settlement_cycle_revision_required',
    );
  }
  return value;
}

function requireSettlementCycleMutation(body) {
  if (body?.settlementCycle !== true) {
    throw createHttpError(
      409,
      '최신 월 결산 화면으로 새로고침해 주세요.',
      'client_upgrade_required',
    );
  }
}

function requireMutableCashflowSettlementCycle(yearMonth) {
  if (isHistoricalCashflowSettlementCycle(yearMonth)) {
    throw createHttpError(
      409,
      '2026년 9월 이전 월 결산은 이력 조회만 할 수 있습니다.',
      'cashflow_settlement_cycle_historical_read_only',
    );
  }
}

function cashflowSettlementCycleSubmitStageId({ requestId, actorUid, idempotencyKey }) {
  return `stage-${cashflowCloseHash({ requestId, actorUid, idempotencyKey })
    .slice('sha256:'.length, 'sha256:'.length + 40)}`;
}

function cashflowSettlementCycleCoordinatorRef(db, tenantId, projectId) {
  if (!db?.doc) throw new Error('cashflow month-close request store unavailable');
  return db.doc(`orgs/${tenantId}/cashflow_month_close_requests/__active__-${projectId}`);
}

function hasCashflowApproverLockedRequest(snapshot, { tenantId, projectId }) {
  if (!snapshot?.exists) return false;
  const coordinator = snapshot.data() || {};
  const cycleYearMonth = readOptionalText(coordinator.activeCycleYearMonth);
  return coordinator.documentType === 'ACTIVE_COORDINATOR'
    && coordinator.tenantId === tenantId
    && coordinator.projectId === projectId
    && /^20\d{2}-(0[1-9]|1[0-2])$/.test(cycleYearMonth)
    && cycleYearMonth >= CASHFLOW_SETTLEMENT_CYCLE_CUTOFF_MONTH
    && coordinator.activeRequestId === `${projectId}-${cycleYearMonth}`
    && CASHFLOW_APPROVER_LOCKED_COORDINATOR_STATES.includes(coordinator.activeState);
}

async function readCashflowProjectApproverLock({ db, tenantId, projectId }) {
  const snapshot = await cashflowSettlementCycleCoordinatorRef(db, tenantId, projectId).get();
  return hasCashflowApproverLockedRequest(snapshot, { tenantId, projectId });
}

function readWeeklyYear(value) {
  const year = Number(value);
  return Number.isSafeInteger(year) && year >= 2000 && year <= 2099 ? year : null;
}

function cashflowActionRoleAllowed(req, allowedRoles, authMode, workspaceEmailDomain) {
  return (isWorkspaceAuthMode(authMode) && isWorkspaceUser(req.context, workspaceEmailDomain))
    || allowedRoles.includes(normalizeRole(req.context?.actorRole));
}

function cashflowAction(enabled, guide, extra = {}) {
  return { enabled: Boolean(enabled), guide: enabled ? '' : guide, ...extra };
}

function buildCashflowMonthCloseActions({
  req,
  dashboard,
  close,
  requestRecord,
  requestAvailable,
  settlementCycleContext,
  approverLockRead,
  actionAccess,
  authMode,
  workspaceEmailDomain,
}) {
  const actionAllowed = actionAccess.available && actionAccess.allowed;
  const weeklyRoleAllowed = actionAllowed && cashflowActionRoleAllowed(
    req, CASHFLOW_WEEKLY_COMPLETE_ROLES, authMode, workspaceEmailDomain,
  );
  const workflowRoleAllowed = actionAllowed && cashflowActionRoleAllowed(
    req, CASHFLOW_MONTH_WORKFLOW_ROLES, authMode, workspaceEmailDomain,
  );
  const accessGuide = actionAccess.available
    ? '이 프로젝트를 담당하는 활성 구성원만 진행할 수 있습니다.'
    : '작업 권한을 확인하지 못했습니다. 다시 불러온 뒤 진행해 주세요.';
  const requestUnavailableGuide = '승인 요청 상태를 불러오지 못했습니다. 다시 불러온 뒤 진행해 주세요.';
  const currentDeadline = dashboard?.deadlineSummary?.current || null;
  const cumulativeScopeReady = Boolean(dashboard?.cumulativeCloseScope);
  const commandCapabilities = settlementCycleContext.commandCapabilities;
  const monthWorkflowMutable = !isHistoricalCashflowSettlementCycle(
    settlementCycleContext.cycle?.cycleYearMonth,
  );
  const requestCanBeSubmitted = requestAvailable
    && commandCapabilities.SUBMIT_MONTH_CLOSE.allowed;
  const requestEnabled = workflowRoleAllowed
    && requestCanBeSubmitted
    && close?.closeEligible === true
    && dashboard?.validation?.canClose === true
    && cumulativeScopeReady;
  const requestGuide = !requestAvailable
    ? requestUnavailableGuide
    : !actionAllowed
      ? accessGuide
      : !workflowRoleAllowed
      ? '현금흐름 월 결산 요청 권한이 없습니다.'
      : !requestCanBeSubmitted
        ? '이미 진행 중인 월 결산 승인 요청이 있습니다.'
        : !cumulativeScopeReady
          ? '서버의 누적 결산 고정 범위를 확인하지 못했습니다.'
          : dashboard?.validation?.blockers?.[0]?.message
            || '월 결산 가능 상태를 서버에서 확인해 주세요.';

  return {
    completeWeekly: cashflowAction(
      weeklyRoleAllowed && Boolean(currentDeadline) && !readOptionalText(currentDeadline?.completedAt),
      !actionAllowed
        ? accessGuide
        : !weeklyRoleAllowed
        ? '현금흐름 주간 정산 완료 권한이 없습니다.'
        : !currentDeadline
          ? '현재 주간 정산 대상을 서버에서 확인하지 못했습니다.'
          : '이미 완료된 주간 정산입니다.',
    ),
    // 주정산 회수: 완료 요청(SUBMITTED) 상태에서만, 즉시, 사유 없음. 확정(LOCKED) 뒤엔 사유 있는 재오픈만.
    reopenWeekly: cashflowAction(
      weeklyRoleAllowed && Boolean(currentDeadline) && readOptionalText(currentDeadline?.lockState) === 'SUBMITTED',
      !actionAllowed
        ? accessGuide
        : !weeklyRoleAllowed
        ? '현금흐름 주간 정산 회수 권한이 없습니다.'
        : !currentDeadline
          ? '현재 주간 정산 대상을 서버에서 확인하지 못했습니다.'
          : readOptionalText(currentDeadline?.lockState) === 'LOCKED'
            ? '조직장이 확정한 주간 정산은 회수할 수 없습니다. 사유와 함께 재오픈해야 합니다.'
            : '아직 완료 요청되지 않은 주간 정산입니다.',
    ),
    // 주정산 확정: 완료 요청된 주를 프로젝트 조직장이 잠금으로 확정.
    confirmWeekly: cashflowAction(
      weeklyRoleAllowed
        && Boolean(currentDeadline)
        && readOptionalText(currentDeadline?.lockState) === 'SUBMITTED'
        && Boolean(readOptionalText(req.context?.actorId))
        && readOptionalText(dashboard?.project?.executiveApproverId) === readOptionalText(req.context?.actorId),
      !actionAllowed
        ? accessGuide
        : !currentDeadline
          ? '현재 주간 정산 대상을 서버에서 확인하지 못했습니다.'
          : readOptionalText(currentDeadline?.lockState) !== 'SUBMITTED'
            ? '완료 요청된 주간 정산만 확정할 수 있습니다.'
            : '프로젝트 조직장만 주간 정산을 확정할 수 있습니다.',
    ),
    changeExecutiveApprover: cashflowAction(
      requestAvailable
        && approverLockRead.available
        && workflowRoleAllowed
        && monthWorkflowMutable
        && !approverLockRead.locked,
      !requestAvailable
        ? requestUnavailableGuide
        : !monthWorkflowMutable
          ? '2026년 9월 이전 월 결산은 이력 조회만 할 수 있습니다.'
        : !actionAllowed
          ? accessGuide
        : !approverLockRead.available
          ? '승인 요청 전체 상태를 불러오지 못했습니다. 다시 불러온 뒤 진행해 주세요.'
          : !workflowRoleAllowed
            ? '프로젝트 조직장 변경 권한이 없습니다.'
            : '승인 대기 중인 월 결산의 조직장은 변경할 수 없습니다.',
    ),
    requestMonthClose: cashflowAction(requestEnabled, requestGuide, {
      label: !requestAvailable
        ? '월 결산 요청 상태 확인 필요'
        : requestRecord ? '월 결산 재요청' : '월 결산 요청',
    }),
    withdrawMonthClose: cashflowAction(
      requestAvailable
        && workflowRoleAllowed
        && commandCapabilities.WITHDRAW_MONTH_CLOSE.allowed,
      !requestAvailable
        ? requestUnavailableGuide
        : !actionAllowed
          ? accessGuide
        : !workflowRoleAllowed
          ? '월 결산 요청 회수 권한이 없습니다.'
          : '본인이 요청한 검토 전 월 결산만 회수할 수 있습니다.',
    ),
    requestMonthReopen: cashflowAction(
      requestAvailable
        && workflowRoleAllowed
        && commandCapabilities.REQUEST_MONTH_REOPEN.allowed,
      !requestAvailable
        ? requestUnavailableGuide
        : !actionAllowed
          ? accessGuide
        : !workflowRoleAllowed
          ? '월 결산 재오픈 요청 권한이 없습니다.'
          : '승인 완료된 최신 월 결산만 재오픈을 요청할 수 있습니다.',
    ),
    cumulativeScope: {
      ready: cumulativeScopeReady,
      guide: cumulativeScopeReady ? '' : '서버의 누적 결산 고정 범위를 확인하지 못했습니다.',
    },
  };
}

function cashflowRateStatusLabel(percent) {
  if (percent === 100) return 'OK';
  return percent > 100 ? '초과' : '미달';
}

function cashflowAvailableRate(percent) {
  const value = typeof percent === 'number' ? percent : Number.NaN;
  if (!Number.isFinite(value)) {
    return { state: 'UNAVAILABLE', percent: null, barPercent: 0, statusLabel: '확인 필요' };
  }
  return {
    state: 'AVAILABLE',
    percent: value,
    barPercent: Math.min(100, Math.max(0, value)),
    statusLabel: cashflowRateStatusLabel(value),
  };
}

function buildCashflowOperationsSummary(dashboard) {
  if (!dashboard) {
    return {
      status: {
        kind: 'unavailable', tone: 'danger', count: 1, label: '확인 불가',
        detail: '현금흐름 요약을 불러오지 못했습니다. 다시 불러와 주세요.',
      },
      rates: {
        projection: { state: 'UNAVAILABLE', percent: null, barPercent: 0, statusLabel: '확인 필요' },
        actual: { state: 'UNAVAILABLE', percent: null, barPercent: 0, statusLabel: '확인 필요' },
      },
    };
  }
  const blockers = Array.isArray(dashboard.validation?.blockers) ? dashboard.validation.blockers : [];
  const warnings = Array.isArray(dashboard.validation?.warnings) ? dashboard.validation.warnings : [];
  const incompleteWeeks = Array.isArray(dashboard.summary?.settlementIncompleteWeeks)
    ? dashboard.summary.settlementIncompleteWeeks : [];
  const count = blockers.length + warnings.length + (incompleteWeeks.length > 0 ? 1 : 0);
  const kind = blockers.length > 0 ? 'blocked' : count > 0 ? 'review' : 'ready';
  const projection = dashboard.summary?.projectionContractAmount === 0
    ? { state: 'ZERO_CONTRACT', percent: null, barPercent: 0, statusLabel: '계약금액 확인' }
    : cashflowAvailableRate(dashboard.summary?.contractCoveragePercent);
  return {
    status: {
      kind,
      tone: kind === 'blocked' ? 'danger' : kind === 'review' ? 'warning' : 'success',
      count,
      label: kind === 'ready' ? '서버 검증 완료' : `확인 항목 ${count.toLocaleString('ko-KR')}건`,
      detail: kind === 'ready'
        ? '서버 검증 기준으로 확인할 항목이 없습니다.'
        : `서버 확인 항목 ${count.toLocaleString('ko-KR')}건이 있습니다.`,
    },
    rates: {
      projection,
      actual: cashflowAvailableRate(dashboard.summary?.actualProgressPercent),
    },
  };
}

const CASHFLOW_SECTION_ERROR_LABELS = new Map([
  ['cashflow', '현금흐름 원장'],
  ['openingBalances', '이월 잔액'],
  ['projectionActualSummary', 'Projection-Actual 요약'],
  ['monthCloseStatuses', '월 결산 상태'],
  ['monthCloseHistory', '월 결산 이력'],
  ['sheetPublication', '시트 반영 상태'],
  ['deadlineSummary', '주간 정산 이력'],
  ['monthCloseRequest', '월 결산 승인 요청'],
  ['monthCloseApproverLock', '조직장 변경 잠금'],
  ['monthCloseActionAccess', '현금흐름 작업 권한'],
  ['projectMetadata', '프로젝트 등록 정보'],
  ['sheetMirror', '시트 기준값'],
]);

export function cashflowSectionErrorLabel(section) {
  return CASHFLOW_SECTION_ERROR_LABELS.get(readOptionalText(section)) || '일부 정보';
}

// 조회 부가 기능이 실패하면 그 section 만 비우고 나머지는 그린다 (계약). 다만 왜 실패했는지는
// 남겨야 한다 - 화면에 "확인 필요" 만 뜨고 이유가 없으면 진단하려고 소스와 Firestore 를 뒤져야 했다.
// 실는 것은 안정된 error code 뿐이다. 예외 메시지는 사용자 화면에 나가면 안 된다 (계약).
function sectionUnavailable(section, code, error) {
  const cause = readOptionalText(error?.code);
  return cause ? { section, code, cause } : { section, code };
}

function cashflowSectionErrorsForResponse(sectionErrors) {
  return (Array.isArray(sectionErrors) ? sectionErrors : []).map((entry) => ({
    ...entry,
    label: cashflowSectionErrorLabel(entry?.section),
  }));
}

// JVM 이 내는 주간 준수 상태는 ON_TIME · COMPLETED_LATE · MISSED · PENDING 넷이다
// (FirestoreInheritedWeeklyExpensePersistence). 예전 이 표는 존재하지 않는 COMPLETED 를
// 기다리고 ON_TIME 을 몰라서, 기한 내 완료한 주차를 "확인 필요" 로 그렸다.
// lockState 는 확정 버튼과 색상에만 쓴다. 주정산 결과 라벨은 실무자의 완료 여부가 우선이다.
// 빈 값을 여기서 재해석하지 않는다 - 판정 주체는 JVM 이고, 값이 없는 옛 기록을 무엇으로
// 볼지는 JVM 이 정한다(FirestoreInheritedWeeklyExpensePersistence 의 기본값). 그 판정을
// BFF 가 한 번 더 하면 두 곳이 조용히 갈린다.
export function cashflowWeeklyStatusLabel(status, available) {
  if (!available) return '주간 정산 상태 확인 필요';
  if (!status) return '';
  if (status === 'ON_TIME') return '기한 내 완료';
  if (status === 'COMPLETED_LATE') return '기한 후 완료';
  if (status === 'MISSED') return '기한 지남';
  if (status === 'PENDING') return '완료 대기';
  return '주간 정산 상태 확인 필요';
}

function cashflowMonthPresentation(entry, available) {
  const status = available ? readOptionalText(entry?.status) || null : null;
  const known = ['OPEN', 'CLOSED', 'REOPEN_REQUESTED'].includes(status);
  const overdue = known && status !== 'CLOSED' && entry?.closeOverdue === true;
  if (!known) return {
    status: null,
    statusLabel: '월 결산 상태 확인 필요',
    locked: false,
    overdue: false,
    badgeLabel: '월 결산 상태 확인 필요',
    tone: 'unavailable',
  };
  if (status === 'CLOSED') return {
    status,
    statusLabel: '월 결산 완료',
    locked: true,
    overdue: false,
    badgeLabel: '월 결산 완료',
    tone: 'closed',
  };
  if (overdue) return {
    status,
    statusLabel: '월 결산 기한 초과',
    locked: false,
    overdue: true,
    badgeLabel: '월 결산 기한 초과',
    tone: 'danger',
  };
  if (status === 'REOPEN_REQUESTED') return {
    status,
    statusLabel: '재오픈 승인 대기',
    locked: false,
    overdue: false,
    badgeLabel: '재오픈 승인 대기',
    tone: 'warning',
  };
  return {
    status,
    statusLabel: '결산 전',
    locked: false,
    overdue: false,
    badgeLabel: '',
    tone: 'default',
  };
}

export function cashflowWeekSurfaceTone({ month, weeklyStatus, weeklyAvailable, isCurrent, weeklyLockState = '' }) {
  if (month.tone === 'unavailable') return 'unavailable';
  // 월 결산 기한 초과는 배경이 아니라 테두리로 그린다 (week.overdue). 배경 빨강은 주간 놓침만.
  // 같은 빨강 하나로 둘을 그리니 무엇이 늦었는지 화면에서 구분이 안 됐다.
  if (month.tone !== 'default' && month.tone !== 'danger') return month.tone;
  if (!weeklyAvailable) return 'unavailable';
  // 완료 요청만 되고 확정 전이면 노랑. 초록은 조직장이 확정한 뒤.
  if (weeklyLockState === 'SUBMITTED') return 'warning';
  if (weeklyStatus === 'ON_TIME' || weeklyStatus === 'COMPLETED_LATE') return 'success';
  if (weeklyStatus === 'MISSED') return 'danger';
  if (weeklyStatus === 'PENDING') return 'warning';
  if (weeklyStatus) return 'unavailable';
  return isCurrent ? 'current' : 'default';
}

function cashflowSettlementCycleMonthClosePresentation(context, requestRecord) {
  if (context.health !== 'OK' || context.businessState === 'INCONSISTENT') {
    return { statusLabel: '상태 재확인 필요', tone: 'danger' };
  }
  if (context.businessState === 'REOPEN_REQUESTED') {
    return { statusLabel: '재오픈 승인 대기', tone: 'warning' };
  }
  if (context.businessState === 'REOPENED') return { statusLabel: '재결산 필요', tone: 'warning' };
  if (context.businessState === 'REJECTED') return { statusLabel: '월 결산 반려', tone: 'danger' };
  if (context.businessState === 'LOCKED') {
    return {
      status: 'COMPLETED',
      statusLabel: '월 결산 완료',
      tone: 'success',
      approvedAt: readOptionalText(context.cycle.monthCloseSettlement?.approvedAt)
        || readOptionalText(requestRecord?.reviewedAt),
    };
  }
  if (context.businessState === 'SUBMITTED') {
    return { status: 'PENDING_APPROVAL', statusLabel: '조직장 승인 대기', tone: 'warning', approvedAt: '' };
  }
  return { status: 'WAITING_FOR_UPDATE', statusLabel: '결산 전', tone: 'neutral', approvedAt: '' };
}

function buildCashflowMonthClosePresentation({
  dashboard, settlementCycleContext, requestRecord, comparisonBoundary,
}) {
  const weeklyYear = readWeeklyYear(dashboard?.canonical?.weeklyYear);
  const annualYears = weeklyYear === null ? [] : annualYearsFor(weeklyYear);
  const annualBefore = annualYears
    .filter((year) => year < weeklyYear)
    .map((year) => ({ year, label: `${year}년` }));
  const annualAfter = annualYears
    .filter((year) => year > weeklyYear)
    .map((year) => ({ year, label: `${year}년` }));
  const rawWeeks = weeklyYear === null ? [] : getYearFinanceWeeks(weeklyYear);
  const rawAsOfKey = cashflowRangeSortKey(comparisonBoundary?.asOfWeek);
  const effectiveAsOfWeek = rawWeeks
    .filter((week) => cashflowRangeSortKey(week) <= rawAsOfKey)
    .at(-1) || comparisonBoundary?.asOfWeek;
  const monthStatusesAvailable = Array.isArray(dashboard?.monthCloseStatuses);
  const monthStatusByMonth = new Map((monthStatusesAvailable ? dashboard.monthCloseStatuses : [])
    .map((entry) => [readOptionalText(entry?.yearMonth), entry]));
  const weeklyStatusesAvailable = Array.isArray(dashboard?.deadlineSummary?.weeklyStatuses);
  const weeklyStatusByWeek = new Map((weeklyStatusesAvailable ? dashboard.deadlineSummary.weeklyStatuses : [])
    .map((entry) => [`${readOptionalText(entry?.yearMonth)}:${Number(entry?.weekNo)}`, entry]));
  const monthPresentationByMonth = new Map();
  const months = Array.from({ length: 12 }, (_, index) => {
    const yearMonth = weeklyYear === null
      ? ''
      : `${weeklyYear}-${String(index + 1).padStart(2, '0')}`;
    const month = cashflowMonthPresentation(
      monthStatusByMonth.get(yearMonth),
      monthStatusesAvailable && monthStatusByMonth.has(yearMonth),
    );
    monthPresentationByMonth.set(yearMonth, month);
    return {
      yearMonth,
      label: yearMonth ? `${yearMonth.replace('-', '년 ')}월` : '',
      columnCount: rawWeeks.filter((week) => week.yearMonth === yearMonth).length,
      status: month.status,
      locked: month.locked,
      overdue: month.overdue,
      badgeLabel: month.badgeLabel,
      tone: month.tone,
    };
  }).filter((month) => month.yearMonth);
  const weeks = rawWeeks.map((week) => {
    const month = monthPresentationByMonth.get(week.yearMonth)
      || cashflowMonthPresentation(null, false);
    const weeklyEntry = weeklyStatusByWeek.get(`${week.yearMonth}:${week.weekNo}`);
    const weeklyStatus = weeklyStatusesAvailable && weeklyEntry
      ? readOptionalText(weeklyEntry.status) || null
      : null;
    const weeklyLockState = weeklyStatusesAvailable && weeklyEntry ? readOptionalText(weeklyEntry.lockState) : '';
    const weeklyStatusLabel = cashflowWeeklyStatusLabel(weeklyStatus, weeklyStatusesAvailable);
    const isCurrent = week.yearMonth === effectiveAsOfWeek?.yearMonth
      && week.weekNo === effectiveAsOfWeek?.weekNo;
    const statusLabel = month.tone === 'unavailable'
      || month.locked
      || month.overdue
      || month.status === 'REOPEN_REQUESTED'
      ? month.statusLabel
      : weeklyStatusLabel;
    return {
      yearMonth: week.yearMonth,
      weekNo: week.weekNo,
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      label: week.label,
      isCurrent,
      monthStatus: month.status,
      monthStatusLabel: month.statusLabel,
      overdue: month.overdue,
      weeklyStatus,
      weeklyLockState: weeklyLockState || null,
      weeklyStatusLabel,
      statusLabel,
      surfaceTone: cashflowWeekSurfaceTone({ month, weeklyStatus, weeklyAvailable: weeklyStatusesAvailable, isCurrent, weeklyLockState }),
    };
  });
  const asOfYear = Number(readOptionalText(effectiveAsOfWeek?.yearMonth).slice(0, 4));
  const comparisonAnnualBefore = annualBefore.filter(({ year }) => year < asOfYear);
  const comparisonAnnualAfter = annualAfter.filter(({ year }) => year < asOfYear);
  const asOfKey = cashflowRangeSortKey(effectiveAsOfWeek);
  const comparisonWeeks = weeks.filter((week) => cashflowRangeSortKey(week) <= asOfKey);
  const differenceByWeek = new Map();
  for (const row of Array.isArray(dashboard?.sheetFormulaValues?.projectionActualDifferences)
    ? dashboard.sheetFormulaValues.projectionActualDifferences : []) {
    const key = `${readOptionalText(row?.yearMonth)}:${Number(row?.weekNo)}`;
    if (!differenceByWeek.has(key)) {
      differenceByWeek.set(key, Number.isSafeInteger(row?.amount) ? row.amount : null);
    }
  }
  const comparisonCells = comparisonWeeks.map((week) => ({
    yearMonth: week.yearMonth,
    weekNo: week.weekNo,
    weekLabel: week.label,
    weekRange: `${week.weekStart} ~ ${week.weekEnd}`,
    difference: differenceByWeek.get(`${week.yearMonth}:${week.weekNo}`) ?? null,
  }));
  const comparisonYears = [...comparisonAnnualBefore, ...comparisonAnnualAfter];
  const periodStart = comparisonYears[0]?.label
    || (comparisonWeeks[0] ? `${comparisonWeeks[0].yearMonth} ${comparisonWeeks[0].weekNo}주차` : null)
    || `${effectiveAsOfWeek?.yearMonth} ${effectiveAsOfWeek?.weekNo}주차`;
  return {
    asOfDate: readOptionalText(comparisonBoundary?.asOfDate),
    annualBefore,
    annualAfter,
    weeks,
    months,
    comparison: {
      annualBefore: comparisonAnnualBefore,
      annualAfter: comparisonAnnualAfter,
      weeks: comparisonWeeks,
      cells: comparisonCells,
      changed: comparisonCells.some((cell) => cell.difference !== null && cell.difference !== 0),
      periodLabel: `${periodStart} ~ ${effectiveAsOfWeek?.yearMonth} ${effectiveAsOfWeek?.weekNo}주차`,
    },
    monthClose: cashflowSettlementCycleMonthClosePresentation(settlementCycleContext, requestRecord),
    evidenceSource: 'DASHBOARD',
  };
}

function cashflowMonthCloseTimeoutError() {
  return createHttpError(
    504,
    '월 결산 서버 조회 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.',
    'cashflow_month_close_route_timeout',
  );
}

function requireCashflowSettlementCycleApprovalReceipt(result, expected) {
  if (!objectValue(result)
    || result.ok !== true
    || result.commandName !== 'cashflowMonth.close'
    || result.projectId !== expected.projectId
    || result.yearMonth !== expected.cycleYearMonth
    || result.status !== 'CLOSED'
    || !Number.isSafeInteger(result.revision)
    || result.revision !== expected.monthCloseRevision + 1
    || result.requestId !== expected.requestId
    || !Number.isSafeInteger(result.requestRevision)
    || result.requestRevision !== expected.evidenceRevision
    || result.manifestHash !== expected.manifestHash
    || result.rootHash !== expected.manifestHash
    || !Number.isSafeInteger(result.headRevision)
    || result.headRevision < 1
    || !validJvmInstant(result.closedAt)
    || result.closedByUid !== expected.actorUid
    || typeof result.auditId !== 'string'
    || !result.auditId
    || result.auditId.trim() !== result.auditId) {
    throw createHttpError(
      502,
      'JVM 캐시플로 저장 결과를 확인할 수 없습니다.',
      'cashflow_jvm_invalid_response',
    );
  }
  return result;
}

function requireCashflowSettlementCycleReopenReceipt(result, expected) {
  const requestReceipt = expected.decision === '';
  if (!objectValue(result)
    || result.ok !== true
    || result.commandName !== expected.commandName
    || result.projectId !== expected.projectId
    || result.yearMonth !== expected.cycleYearMonth
    || result.status !== expected.status
    || !Number.isSafeInteger(result.revision)
    || result.revision !== expected.ledgerRevision + 1
    || result.requestId !== expected.requestId
    || !Number.isSafeInteger(result.requestRevision)
    || result.requestRevision !== expected.evidenceRevision
    || result.manifestHash !== expected.manifestHash
    || result.rootHash !== expected.manifestHash
    || !Number.isSafeInteger(result.headRevision)
    || result.headRevision < 1
    || typeof result.auditId !== 'string'
    || !result.auditId
    || result.auditId.trim() !== result.auditId
    || (requestReceipt && (result.reopenReason !== expected.reason
      || !validJvmInstant(result.reopenRequestedAt)
      || result.reopenRequestedByUid !== expected.actorUid))
    || (!requestReceipt && (result.reopenDecision !== expected.decision
      || result.reopenDecisionReason !== expected.reason
      || !validJvmInstant(result.reopenDecidedAt)
      || result.reopenDecidedByUid !== expected.actorUid))) {
    throw createHttpError(
      502,
      'JVM 월 결산 재오픈 결과를 확인할 수 없습니다.',
      'cashflow_jvm_invalid_response',
    );
  }
  return result;
}

function assertCashflowMonthReopenAuthorityResult(result, projectId) {
  const availability = readOptionalText(result?.availability);
  const canDecideReopen = result?.canDecideReopen;
  if (
    result?.ok !== true
    || readOptionalText(result.commandName) !== 'cashflowMonth.readReopenAuthority'
    || readOptionalText(result.projectId) !== projectId
    || !['ALLOWED', 'FORBIDDEN', 'UNAVAILABLE'].includes(availability)
    || typeof canDecideReopen !== 'boolean'
    || (availability === 'ALLOWED') !== canDecideReopen
  ) {
    throw createHttpError(
      502,
      'JVM 월 결산 재오픈 권한 결과를 확인할 수 없습니다.',
      'cashflow_jvm_invalid_response',
    );
  }
  return { availability, canDecideReopen };
}

async function withCashflowMonthCloseDeadline(task, timeoutMs) {
  let timeoutId;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(cashflowMonthCloseTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function resolveJavaWeeklyApiBaseUrl(options = {}, env = process.env) {
  return readOptionalText(options.jvmWeeklyApiBaseUrl)
    || readOptionalText(env.JVM_WEEKLY_API_BASE_URL)
    || readOptionalText(env.WEEKLY_API_BASE_URL);
}

function resolveJavaWeeklyApiServiceToken(options = {}, env = process.env) {
  return readOptionalText(options.jvmWeeklyApiServiceToken)
    || readOptionalText(env.JVM_WEEKLY_INTERNAL_API_TOKEN)
    || readOptionalText(env.WEEKLY_API_INTERNAL_TOKEN);
}

function resolveJavaWeeklyApiIdTokenAudience(options = {}, env = process.env) {
  return readOptionalText(options.jvmWeeklyApiIdTokenAudience)
    || readOptionalText(env.JVM_WEEKLY_API_ID_TOKEN_AUDIENCE)
    || readOptionalText(env.WEEKLY_API_ID_TOKEN_AUDIENCE);
}

function resolveJavaWeeklyAuthMode(options = {}, env = process.env) {
  return readOptionalText(options.jvmWeeklyAuthMode)
    || readOptionalText(env.JVM_WEEKLY_AUTH_MODE)
    || readOptionalText(env.WEEKLY_AUTH_MODE)
    || 'strict';
}

function resolveJavaWeeklyWorkspaceEmailDomain(options = {}, env = process.env) {
  const raw = readOptionalText(options.jvmWeeklyWorkspaceEmailDomain)
    || readOptionalText(env.JVM_WEEKLY_WORKSPACE_EMAIL_DOMAIN)
    || readOptionalText(env.WEEKLY_WORKSPACE_EMAIL_DOMAIN)
    || 'mysc.co.kr';
  return raw.replace(/^@+/, '').toLowerCase();
}

function resolveJavaWeeklyFirestoreProjectId(options = {}, env = process.env) {
  return readOptionalText(options.jvmWeeklyFirestoreProjectId)
    || readOptionalText(env.JVM_WEEKLY_FIRESTORE_PROJECT_ID)
    || readOptionalText(env.WEEKLY_FIRESTORE_PROJECT_ID);
}

function resolveBffDataProjectId(env = process.env) {
  return readOptionalText(env.FIREBASE_PROJECT_ID)
    || readOptionalText(env.VITE_FIREBASE_PROJECT_ID)
    || readOptionalText(env.GCLOUD_PROJECT)
    || readOptionalText(env.GOOGLE_CLOUD_PROJECT);
}

function cashflowMonthCloseRequestMonthPath(tenantId, requestId, revision, yearMonth) {
  return `orgs/${tenantId}/cashflow_month_close_request_months/${requestId}-r${revision}-${yearMonth}`;
}


export function buildCashflowMonthCloseRevisionChanges(previousCells, currentCells) {
  const key = (cell) => `${cell.mode}|${cell.weekNo}|${cell.cashflowLine}`;
  const previousByKey = new Map((previousCells || []).map((cell) => [key(cell), cell]));
  const currentByKey = new Map((currentCells || []).map((cell) => [key(cell), cell]));
  const orderedKeys = [
    ...currentByKey.keys(),
    ...[...previousByKey.keys()].filter((cellKey) => !currentByKey.has(cellKey)),
  ];

  return orderedKeys.flatMap((cellKey) => {
    const before = previousByKey.get(cellKey);
    const current = currentByKey.get(cellKey);
    if (before && current && before.cellState === current.cellState && before.amount === current.amount) return [];
    const identity = current || before;
    const previousAmount = before && typeof before.amount === 'number' ? before.amount : null;
    const currentAmount = current && typeof current.amount === 'number' ? current.amount : null;
    return [{
      mode: identity.mode,
      weekNo: identity.weekNo,
      cashflowLine: identity.cashflowLine,
      previousState: before?.cellState || 'MISSING',
      previousAmount,
      currentState: current?.cellState || 'MISSING',
      currentAmount,
      amountDelta: previousAmount === null || currentAmount === null ? null : currentAmount - previousAmount,
    }];
  });
}

function cashflowMonthReopenRequestView(value) {
  const evidence = objectValue(value);
  if (!evidence || Object.keys(evidence).length === 0) return null;
  return {
    reason: readOptionalText(evidence.reason) || null,
    requestedByUid: readOptionalText(evidence.requestedByUid) || null,
    requestedAt: readOptionalText(evidence.requestedAt) || null,
  };
}

function cashflowMonthReopenDecisionView(value) {
  const evidence = objectValue(value);
  if (!evidence || Object.keys(evidence).length === 0) return null;
  const decision = readOptionalText(evidence.decision).toUpperCase();
  return {
    decision: ['APPROVE', 'REJECT'].includes(decision) ? decision : null,
    reason: readOptionalText(evidence.reason) || null,
    decidedByUid: readOptionalText(evidence.decidedByUid) || null,
    decidedAt: readOptionalText(evidence.decidedAt) || null,
  };
}

function cashflowMonthCloseRequestView(
  record,
  partyNames = {},
  { canDecideReopen = false, reopenAuthorityAvailability = '' } = {},
) {
  const reopenAuthority = ['ALLOWED', 'FORBIDDEN', 'UNAVAILABLE'].includes(reopenAuthorityAvailability)
    ? { reopenAuthorityAvailability }
    : {};
  if (record.contractVersion === CASHFLOW_CUMULATIVE_CLOSE_CONTRACT) {
    const scope = record.scope && typeof record.scope === 'object' ? record.scope : {};
    const cycleYearMonth = readOptionalText(scope.cycleYearMonth)
      || readOptionalText(record.cycleYearMonth)
      || record.yearMonth;
    const throughMonth = readOptionalText(scope.throughMonth)
      || readOptionalText(record.throughMonth)
      || record.yearMonth;
    return {
      documentType: 'MONTHLY_CLOSE',
      contractVersion: record.contractVersion,
      requestId: record.requestId,
      projectId: record.projectId,
      yearMonth: cycleYearMonth,
      cycleYearMonth,
      monthCloseTargetYearMonth: throughMonth,
      throughMonth,
      fromMonth: readOptionalText(scope.fromMonth) || record.fromMonth,
      scope: {
        contractVersion: record.contractVersion,
        fromMonth: readOptionalText(scope.fromMonth) || record.fromMonth,
        cycleYearMonth,
        throughMonth,
        monthCount: Number(scope.monthCount ?? record.monthCount),
        weekCount: Number(scope.weekCount ?? record.weekCount),
        cellCount: Number(scope.cellCount ?? record.cellCount),
      },
      status: record.status,
      canDecideReopen: Boolean(canDecideReopen),
      ...reopenAuthority,
      revision: record.revision,
      evidenceRevision: record.evidenceRevision,
      ledgerRevision: record.ledgerRevision,
      workflowRevision: record.workflowRevision,
      manifestHash: record.manifestHash,
      monthCount: record.monthCount,
      weekCount: record.weekCount,
      cellCount: record.cellCount,
      source: objectValue(record.source),
      totals: objectValue(record.totals),
      annualSummaries: Array.isArray(record.annualSummaries) ? record.annualSummaries : [],
      approverUid: record.approverUid,
      approverName: partyNames.approverName || '구성원 이름 확인 불가',
      requestedByUid: record.requestedByUid,
      requestedByName: partyNames.requestedByName || '구성원 이름 확인 불가',
      requestedAt: record.requestedAt,
      reviewedByUid: record.reviewedByUid || null,
      reviewedByName: record.reviewedByUid ? partyNames.reviewedByName || '구성원 이름 확인 불가' : null,
      reviewedAt: record.reviewedAt || null,
      decisionReason: record.decisionReason || null,
      withdrawnAt: record.withdrawnAt || null,
      withdrawReason: record.withdrawReason || null,
      reopenRequest: cashflowMonthReopenRequestView(record.reopenRequest),
      reopenDecision: cashflowMonthReopenDecisionView(record.reopenDecision),
      reviewWarnings: Array.isArray(record.reviewWarnings) ? record.reviewWarnings : [],
      monthSnapshot: null,
      lockRange: {
        fromMonth: readOptionalText(scope.fromMonth) || record.fromMonth,
        fromWeekNo: 1,
        throughMonth,
        throughWeekNo: 5,
      },
      reconciliationEvidence: objectValue(record.reconciliationEvidence),
    };
  }
  return {
    documentType: 'MONTHLY_CLOSE',
    requestId: record.requestId,
    projectId: record.projectId,
    yearMonth: record.yearMonth,
    status: record.status,
    canDecideReopen: Boolean(canDecideReopen),
    ...reopenAuthority,
    revision: record.revision,
    approverUid: record.approverUid,
    approverName: partyNames.approverName || '구성원 이름 확인 불가',
    requestedByUid: record.requestedByUid,
    requestedByName: partyNames.requestedByName || '구성원 이름 확인 불가',
    requestedAt: record.requestedAt,
    reviewedByUid: record.reviewedByUid || null,
    reviewedByName: record.reviewedByUid ? partyNames.reviewedByName || '구성원 이름 확인 불가' : null,
    reviewedAt: record.reviewedAt || null,
    decisionReason: record.decisionReason || null,
    reopenRequest: cashflowMonthReopenRequestView(record.reopenRequest),
    reopenDecision: cashflowMonthReopenDecisionView(record.reopenDecision),
    reviewWarnings: Array.isArray(record.reviewWarnings) ? record.reviewWarnings : [],
    monthSnapshot: objectValue(record.monthSnapshot),
    reconciliationEvidence: objectValue(record.reconciliationEvidence),
  };
}

function cumulativeMonthCloseShard({ requestId, requestRevision, projectId, yearMonth, month, source }) {
  const cells = canonicalMonthCells(month, yearMonth).map(({ mode, weekNo, cashflowLine, cellState, amount }) => ({
    mode, weekNo, cashflowLine, cellState, amount: cellState === 'EMPTY' ? null : amount,
  }));
  const base = {
    contractVersion: CASHFLOW_CUMULATIVE_CLOSE_CONTRACT,
    requestId,
    requestRevision,
    projectId,
    yearMonth,
    cells,
    source,
  };
  return { ...base, shardHash: cashflowCloseHash(base) };
}

function cumulativeMonthCloseManifest({ requestId, requestRevision, projectId, yearMonth, shards }) {
  const manifest = {
    contractVersion: CASHFLOW_CUMULATIVE_CLOSE_CONTRACT,
    requestId,
    requestRevision,
    projectId,
    fromMonth: CASHFLOW_CUMULATIVE_CLOSE_FROM_MONTH,
    yearMonth,
    months: shards.map((shard) => ({ yearMonth: shard.yearMonth, shardHash: shard.shardHash })),
  };
  return { ...manifest, manifestHash: cashflowCloseHash(manifest) };
}

function assertCashflowMonthCloseRequestSize(record) {
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') <= CASHFLOW_MONTH_CLOSE_REQUEST_MAX_BYTES) return;
  throw createHttpError(
    413,
    '월 결산 요청 자료가 너무 큽니다. 시트 범위를 확인해 주세요.',
    'cashflow_month_close_request_too_large',
  );
}

// JVM FirestoreWeeklyProjectAccessRepository.memberDocuments 와 같은 두 경로로 찾는다 —
// uid 문서 1건과 email 로 조회한 최대 3건. 조회는 서비스 계층인 여기서 하고,
// 판정은 순수 모듈(cashflow-project-scope)이 한다.
async function readActorMemberDocuments({ db, tenantId, actorId, actorEmail }) {
  const normalizedTenantId = readOptionalText(tenantId);
  if (!normalizedTenantId) return [];
  const normalizedActorId = readOptionalText(actorId);
  const normalizedEmail = readOptionalText(actorEmail);
  const documents = [];
  if (normalizedActorId && !normalizedActorId.includes('/')) {
    const snapshot = await db.doc(`orgs/${normalizedTenantId}/members/${normalizedActorId}`).get();
    if (snapshot.exists) documents.push(snapshot.data() || {});
  }
  if (normalizedEmail && typeof db.collection === 'function') {
    const snapshot = await db.collection(`orgs/${normalizedTenantId}/members`)
      .where('email', '==', normalizedEmail)
      .limit(3)
      .get();
    for (const doc of snapshot?.docs || []) documents.push(doc.data() || {});
  }
  return documents;
}

// 프로젝트 스코프 인가. 지금까지 이 검사는 JVM 에만 있었고 BFF 는 역할만 봤다.
// BFF 가 Firestore 를 직접 읽는 경로가 늘어날수록 그 비대칭이 우회 통로가 되므로
// 같은 규칙을 BFF 에도 세운다. 판정 규칙은 cashflow-project-scope 가 단일 소유한다.
async function assertCashflowProjectInScope({ db, req, projectId, authMode, workspaceEmailDomain }) {
  if (!db?.doc) return;
  const workspaceUser = isWorkspaceAuthMode(authMode) && isWorkspaceUser(req.context, workspaceEmailDomain);
  const role = readOptionalText(req.context?.actorRole);
  if (workspaceUser || TENANT_WIDE_PROJECT_ROLES.includes(role.toLowerCase())) return;
  const members = await readActorMemberDocuments({
    db,
    tenantId: req.context?.tenantId,
    actorId: req.context?.actorId,
    actorEmail: req.context?.actorEmail,
  });
  if (isProjectInActorScope({ role, members, actorId: req.context?.actorId, projectId, workspaceUser })) return;
  throw createHttpError(403, '이 프로젝트에 접근할 권한이 없습니다.', 'cashflow_project_forbidden');
}

async function readActiveCashflowMember({ db, tenantId, actorId }) {
  const normalizedActorId = readOptionalText(actorId);
  if (!normalizedActorId || normalizedActorId.includes('/')) {
    throw createHttpError(403, '활성 구성원만 월 결산 요청을 조회하거나 검토할 수 있습니다.', 'cashflow_month_close_member_inactive');
  }
  const snapshot = await db.doc(`orgs/${tenantId}/members/${normalizedActorId}`).get();
  const member = snapshot.exists ? snapshot.data() || {} : null;
  if (
    !member
    || readOptionalText(member.uid) !== normalizedActorId
    || readOptionalText(member.status).toUpperCase() !== 'ACTIVE'
  ) {
    throw createHttpError(403, '활성 구성원만 월 결산 요청을 조회하거나 검토할 수 있습니다.', 'cashflow_month_close_member_inactive');
  }
  return member;
}

async function assertCashflowMonthActionAccess({ db, req, projectId, authMode, workspaceEmailDomain }) {
  await readActiveCashflowMember({
    db, tenantId: req.context?.tenantId, actorId: req.context?.actorId,
  });
  await assertCashflowProjectInScope({ db, req, projectId, authMode, workspaceEmailDomain });
}

async function readCashflowRequestPartyNames({ db, tenantId, record }) {
  const member = async (uid) => {
    const normalizedUid = readOptionalText(uid);
    if (!normalizedUid || normalizedUid.includes('/')) return {};
    const snapshot = await db.doc(`orgs/${tenantId}/members/${normalizedUid}`).get();
    const value = snapshot.exists ? snapshot.data() || {} : {};
    return readOptionalText(value.status).toUpperCase() === 'ACTIVE' ? value : {};
  };
  const [requester, approver, reviewer] = await Promise.all([
    member(record.requestedByUid), member(record.approverUid), member(record.reviewedByUid),
  ]);
  const slackUserId = readOptionalText(approver.slackUserId);
  return {
    requestedByName: readOptionalText(requester.name),
    approverName: readOptionalText(approver.name),
    approverSlackUserId: /^[UW][A-Z0-9]{8,}$/.test(slackUserId) ? slackUserId : '',
    reviewedByName: readOptionalText(reviewer.name),
  };
}

async function readCanonicalCashflowApprover({ db, tenantId, projectId }) {
  const projectSnapshot = await db.doc(`orgs/${tenantId}/projects/${projectId}`).get();
  const project = projectSnapshot.exists ? projectSnapshot.data() || {} : null;
  const approverUid = readOptionalText(project?.executiveApproverId);
  if (!project || !approverUid || approverUid.includes('/')) {
    throw createHttpError(409, '프로젝트 조직장을 먼저 지정해 주세요.', 'cashflow_month_close_approver_required');
  }
  await readActiveCashflowMember({ db, tenantId, actorId: approverUid });
  return approverUid;
}

function commandBody(req) {
  const body = {
    ...(req.body && typeof req.body === 'object' ? req.body : {}),
    idempotencyKey: req.context.idempotencyKey,
  };
  delete body.actor;
  delete body.tenantId;
  delete body.actorRole;
  delete body.dataProjectId;
  delete body.sourceSheetKey;
  return body;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function jvmMonthCloseResponseInvalid() {
  return createHttpError(502, 'JVM 월 결산 달력 자료가 올바르지 않습니다.', 'jvm_weekly_response_invalid');
}

function validJvmIsoDate(value) {
  if (typeof value !== 'string' || value.trim() !== value
    || !/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validJvmInstant(value) {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function requireCashflowSettlementCycleSubmitReceipt(result, expected) {
  if (!objectValue(result)
    || result.ok !== true
    || result.commandName !== 'cashflowSettlementCycle.submit'
    || result.projectId !== expected.projectId
    || result.cycleYearMonth !== expected.cycleYearMonth
    || result.monthCloseTargetYearMonth !== expected.monthCloseTargetYearMonth
    || result.requestId !== expected.requestId
    || result.businessState !== 'SUBMITTED'
    || !Number.isSafeInteger(result.workflowRevision)
    || result.workflowRevision !== expected.expectedWorkflowRevision + 1
    || !Number.isSafeInteger(result.evidenceRevision)
    || result.evidenceRevision !== expected.evidenceRevision
    || result.manifestHash !== expected.manifestHash
    || !validJvmInstant(result.submittedAt)
    || result.submittedByUid !== expected.actorUid
    || result.approverUid !== expected.expectedApproverUid
    || result.decidedAt !== ''
    || result.decidedByUid !== ''
    || result.reason !== ''
    || typeof result.auditId !== 'string'
    || result.auditId.length === 0
    || result.auditId.trim() !== result.auditId) {
    throw createHttpError(
      502,
      'JVM 월 결산 접수 결과가 올바르지 않습니다.',
      'cashflow_jvm_invalid_response',
    );
  }
  return result;
}

function requireCashflowSettlementCycleTransitionReceipt(result, expected) {
  if (!objectValue(result)
    || result.ok !== true
    || result.commandName !== 'cashflowSettlementCycle.transition'
    || result.projectId !== expected.projectId
    || result.cycleYearMonth !== expected.cycleYearMonth
    || result.monthCloseTargetYearMonth !== expected.monthCloseTargetYearMonth
    || result.requestId !== expected.requestId
    || result.businessState !== expected.businessState
    || !Number.isSafeInteger(result.workflowRevision)
    || result.workflowRevision !== expected.expectedWorkflowRevision + 1
    || !Number.isSafeInteger(result.evidenceRevision)
    || result.evidenceRevision !== expected.evidenceRevision
    || result.manifestHash !== expected.manifestHash
    || result.submittedAt !== expected.submittedAt
    || result.submittedByUid !== expected.submittedByUid
    || result.approverUid !== expected.approverUid
    || !validJvmInstant(result.decidedAt)
    || result.decidedByUid !== expected.actorUid
    || result.reason !== expected.reason
    || typeof result.auditId !== 'string'
    || result.auditId.length === 0
    || result.auditId.trim() !== result.auditId) {
    throw createHttpError(
      502,
      'JVM 월 결산 전이 결과가 올바르지 않습니다.',
      'cashflow_jvm_invalid_response',
    );
  }
  return result;
}

function readJvmOperationalCycle(source, yearMonth) {
  if (!source || typeof source !== 'object' || !Object.hasOwn(source, 'operationalCycle')) {
    throw jvmMonthCloseResponseInvalid();
  }
  const cycle = objectValue(source.operationalCycle);
  if (!cycle || cycle.cycleYearMonth !== yearMonth
    || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(cycle.targetYearMonth)
    || !validJvmIsoDate(cycle.closeDeadline)
    || typeof cycle.closeEligible !== 'boolean'
    || typeof cycle.late !== 'boolean') {
    throw jvmMonthCloseResponseInvalid();
  }
  return {
    cycleYearMonth: cycle.cycleYearMonth,
    targetYearMonth: cycle.targetYearMonth,
    deadline: cycle.closeDeadline,
    eligible: cycle.closeEligible,
    late: cycle.late,
  };
}

function readJvmMonthCloseCalendar(source, yearMonth) {
  if (!source || typeof source !== 'object' || !Object.hasOwn(source, 'monthCloseCalendar')) {
    throw jvmMonthCloseResponseInvalid();
  }
  const calendar = source.monthCloseCalendar;
  if (!Array.isArray(calendar) || calendar.length !== 12) throw jvmMonthCloseResponseInvalid();
  const expectedYear = yearMonth.slice(0, 4);
  const expectedMonths = Array.from({ length: 12 }, (_unused, index) => (
    `${expectedYear}-${String(index + 1).padStart(2, '0')}`
  ));
  if (calendar.some((item, index) => {
    const value = objectValue(item);
    return !value
      || value.yearMonth !== expectedMonths[index]
      || !validJvmIsoDate(value.closeDeadline)
      || !validJvmInstant(value.closeDeadlineAt)
      || !validJvmInstant(value.approverDeadlineAt);
  })) throw jvmMonthCloseResponseInvalid();
  return new Map(calendar.map((item) => [item.yearMonth, {
    yearMonth: item.yearMonth,
    closeDeadline: item.closeDeadline,
    closeDeadlineAt: item.closeDeadlineAt,
    approverDeadlineAt: item.approverDeadlineAt,
  }]));
}

function amendedSheetFormulaSnapshot(mirror, amendmentEvidence) {
  const sourceRevision = readOptionalText(amendmentEvidence?.sourceRevision);
  const targetRevision = readOptionalText(amendmentEvidence?.resultingTargetRevision);
  const sheetFacts = objectValue(mirror?.sheetFacts);
  const available = Boolean(
    sheetFacts
    && sourceRevision
    && targetRevision
    && readOptionalText(mirror?.sourceRevision) === sourceRevision
    && readOptionalText(mirror?.appliedSourceRevision) === sourceRevision
    && readOptionalText(mirror?.appliedTargetRevision) === targetRevision
  );
  return {
    status: available ? 'AVAILABLE' : 'UNAVAILABLE',
    reason: available ? null : 'AMENDMENT_SHEET_FORMULA_SNAPSHOT_UNAVAILABLE',
    sourceRevision: sourceRevision || null,
    targetRevision: targetRevision || null,
    sheetFacts: available ? sheetFacts : null,
  };
}

function readWeeklyExpenseEditSession(req) {
  const sessionId = readOptionalText(req.header('x-edit-session-id'));
  const leaseId = readOptionalText(req.header('x-edit-lease-id'));
  const fenceText = readOptionalText(req.header('x-edit-fence'));
  const fence = /^[1-9]\d*$/.test(fenceText) ? Number(fenceText) : Number.NaN;
  if (!sessionId || !leaseId || !Number.isSafeInteger(fence)) {
    throw createHttpError(400, 'Weekly expense edit lease headers are required.', 'cashflow_edit_lease_request_invalid');
  }
  const finalizeText = readOptionalText(req.header('x-edit-finalize'));
  if (finalizeText && finalizeText !== 'true') {
    throw createHttpError(400, 'x-edit-finalize must be true when present.', 'cashflow_edit_lease_request_invalid');
  }
  return { sessionId, leaseId, fence, ...(finalizeText === 'true' ? { finalize: true } : {}) };
}

function parseAuditMetadata(value) {
  try {
    return objectValue(JSON.parse(readOptionalText(value) || '{}')) || {};
  } catch {
    return {};
  }
}

const CASHFLOW_ACTIVITY_SOURCES = ['sheet_refresh', 'audit', 'legacy'];
const CASHFLOW_ACTIVITY_COLLECTIONS = {
  sheet_refresh: 'cashflow_sheet_refresh_runs',
  audit: 'weekly_api_audit_events',
  legacy: 'cashflow_events',
};
const CASHFLOW_ACTIVITY_DEFAULT_LIMIT = 50;
const CASHFLOW_ACTIVITY_MAX_CURSOR_LENGTH = 4096;
const CASHFLOW_ACTIVITY_RESPONSE_EVENT_BUDGET_BYTES = 1_750_000;
const CASHFLOW_ACTIVITY_DOCUMENT_ID = Symbol('cashflowActivityDocumentId');

function cashflowActivityMetricNow(performanceNow) {
  try {
    const value = Number(typeof performanceNow === 'function' ? performanceNow() : Date.now());
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function cashflowActivityJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function cashflowActivityJsonArrayBytes(values) {
  return values.reduce(
    (total, value, index) => total + cashflowActivityJsonBytes(value) + (index > 0 ? 1 : 0),
    2,
  );
}

function emitCashflowActivityMetric(performanceLogger, payload) {
  try {
    if (typeof performanceLogger === 'function') {
      performanceLogger(payload);
    } else if (process.env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(payload));
    }
  } catch {
    // Diagnostics must never affect a financial read.
  }
}

function cashflowActivityQueryInvalid() {
  return createHttpError(400, '활동 기록 조회 범위가 올바르지 않습니다.', 'cashflow_activity_query_invalid');
}

function isCashflowActivityCursorInstant(value) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const milliseconds = (match[2] || '').padEnd(3, '0').slice(0, 3);
  return new Date(parsed).toISOString() === `${match[1]}.${milliseconds}Z`;
}

function isCashflowActivityCursorDocumentId(value) {
  return Boolean(value)
    && !value.includes('/')
    && Buffer.byteLength(value, 'utf8') <= 1500;
}

function decodeCashflowActivityCursor(cursor, projectId, source) {
  if (!cursor) return {};
  if (cursor.length > CASHFLOW_ACTIVITY_MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw cashflowActivityQueryInvalid();
  }
  let decoded;
  try {
    decoded = objectValue(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw cashflowActivityQueryInvalid();
  }
  if (
    !decoded
    || decoded.version !== 1
    || readOptionalText(decoded.projectId) !== projectId
    || readOptionalText(decoded.source) !== source
  ) throw cashflowActivityQueryInvalid();
  const rawBoundaries = objectValue(decoded.boundaries);
  if (!rawBoundaries) throw cashflowActivityQueryInvalid();
  const boundaries = {};
  for (const sourceName of source ? [source] : CASHFLOW_ACTIVITY_SOURCES) {
    const rawBoundary = objectValue(rawBoundaries[sourceName]);
    if (!rawBoundary || typeof rawBoundary.done !== 'boolean') throw cashflowActivityQueryInvalid();
    if (rawBoundary.done) {
      boundaries[sourceName] = { done: true };
      continue;
    }
    const createdAt = readOptionalText(rawBoundary.createdAt);
    const id = readOptionalText(rawBoundary.id);
    if (!createdAt && !id) {
      boundaries[sourceName] = { done: false };
      continue;
    }
    if (
      createdAt.length > 128
      || !isCashflowActivityCursorInstant(createdAt)
      || !isCashflowActivityCursorDocumentId(id)
    ) throw cashflowActivityQueryInvalid();
    boundaries[sourceName] = { done: false, createdAt, id };
  }
  return boundaries;
}

function encodeCashflowActivityCursor(projectId, source, boundaries) {
  return Buffer.from(JSON.stringify({
    version: 1,
    projectId,
    source,
    boundaries,
  }), 'utf8').toString('base64url');
}

async function readCashflowActivityDocuments(db, tenantId, collectionId, projectId, limit, boundary) {
  if (boundary?.done || !db?.collection) return { documents: [], exhausted: true, queryCount: 0 };
  let query = db.collection(`orgs/${tenantId}/${collectionId}`)
    .where('projectId', '==', projectId)
    .orderBy('createdAt', 'desc')
    .orderBy('__name__', 'desc');
  if (boundary?.createdAt && boundary?.id) {
    query = query.startAfter(boundary.createdAt, boundary.id);
  }
  const snap = await query.limit(limit).get();
  const documents = snap.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() || {}),
    [CASHFLOW_ACTIVITY_DOCUMENT_ID]: doc.id,
  }));
  return { documents, exhausted: snap.docs.length < limit, queryCount: 1 };
}

function cashflowActivityDocumentId(document) {
  return readOptionalText(document?.[CASHFLOW_ACTIVITY_DOCUMENT_ID]) || readOptionalText(document?.id);
}

function compareCashflowActivityDocuments(left, right) {
  const leftCreatedAt = readOptionalText(left.document.createdAt);
  const rightCreatedAt = readOptionalText(right.document.createdAt);
  if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt < rightCreatedAt ? 1 : -1;
  const leftId = cashflowActivityDocumentId(left.document);
  const rightId = cashflowActivityDocumentId(right.document);
  if (leftId !== rightId) return leftId < rightId ? 1 : -1;
  return CASHFLOW_ACTIVITY_SOURCES.indexOf(left.source) - CASHFLOW_ACTIVITY_SOURCES.indexOf(right.source);
}

function buildCashflowActivityDocumentEvents(source, document, projectId) {
  const events = {
    refresh: [],
    sheetApply: [],
    appliedCell: [],
    close: [],
    legacy: [],
  };
  if (source === 'sheet_refresh') {
    if (readOptionalText(document.status) === 'COMPLETED' && readOptionalText(document.response?.status) === 'FRESH') {
      events.refresh.push({
        id: `sheet-refresh:${document.id}`,
        projectId,
        runId: readOptionalText(document.idempotencyKey) || document.id,
        type: 'sheet_refresh',
        source: 'google_sheet_refresh',
        actorUid: readOptionalText(document.createdBy?.uid),
        actorName: readOptionalText(document.createdBy?.name),
        actorEmail: readOptionalText(document.createdBy?.email),
        createdAt: readOptionalText(document.createdAt),
        sheetName: readOptionalText(document.response?.selectedSheetName),
      });
    }
    return events;
  }
  if (source === 'legacy') {
    events.legacy.push(document);
    return events;
  }

  const commandName = readOptionalText(document.commandName);
  const metadata = parseAuditMetadata(document.metadataJson);
  if (commandName.startsWith('cashflowMonth.')) {
    events.close.push({
      id: `month-close:${document.id}`,
      projectId,
      runId: readOptionalText(document.idempotencyKey) || document.id,
      type: 'month_close',
      source: 'month_close',
      yearMonth: readOptionalText(metadata.yearMonth),
      status: readOptionalText(metadata.status),
      actorUid: readOptionalText(document.actorId),
      actorEmail: readOptionalText(metadata.actorEmail),
      actorName: readOptionalText(metadata.actorName),
      createdAt: readOptionalText(document.createdAt),
    });
    return events;
  }
  if (commandName !== 'weeklyExpense.cashflowSheetLab.apply') return events;

  const projectionLineCount = Object.hasOwn(metadata, 'projectionLineCount')
    ? safeAmount(metadata.projectionLineCount)
    : 0;
  const actualLineCount = Object.hasOwn(metadata, 'actualLineCount')
    ? safeAmount(metadata.actualLineCount)
    : 0;
  events.sheetApply.push({
    id: `sheet-apply:${document.id}`,
    projectId,
    runId: readOptionalText(document.idempotencyKey) || document.id,
    type: 'sheet_apply',
    source: 'google_sheet_apply',
    yearMonth: readOptionalText(metadata.yearMonth),
    year: Number.isSafeInteger(Number(metadata.year)) ? Number(metadata.year) : undefined,
    scope: readOptionalText(metadata.scope) || 'monthly',
    projectionLineCount,
    actualLineCount,
    appliedLineCount: sumSafe([projectionLineCount, actualLineCount]),
    actorUid: readOptionalText(document.actorId),
    actorEmail: readOptionalText(metadata.actorEmail),
    actorName: readOptionalText(metadata.actorName),
    createdAt: readOptionalText(document.createdAt),
  });
  events.appliedCell = (Array.isArray(metadata.appliedCellChanges) ? metadata.appliedCellChanges : [])
    .map((rawChange, index) => {
      const change = objectValue(rawChange) || {};
      const before = objectValue(change.before) || {};
      const after = objectValue(change.after) || {};
      const mode = readOptionalText(change.mode).toLowerCase();
      const beforeState = readOptionalText(before.cellState).toUpperCase();
      const afterState = readOptionalText(after.cellState).toUpperCase();
      const operationId = readOptionalText(change.operationId) || readOptionalText(metadata.operationId) || readOptionalText(document.idempotencyKey);
      return {
        id: `sheet-apply-cell:${document.id}:${index}`,
        projectId,
        runId: readOptionalText(change.idempotencyKey) || readOptionalText(document.idempotencyKey) || operationId || document.id,
        type: mode === 'projection' ? 'projection_amount_change' : 'actual_amount_change',
        source: 'google_sheet_apply',
        sourceDetail: readOptionalText(change.source) || readOptionalText(metadata.source) || readOptionalText(document.sheetKey),
        operation: readOptionalText(change.operationType) || readOptionalText(change.operation) || readOptionalText(metadata.operationType) || readOptionalText(metadata.operation) || commandName,
        operationId,
        auditId: readOptionalText(change.auditId) || document.id,
        sourceRevision: readOptionalText(change.sourceRevision) || readOptionalText(metadata.sourceRevision),
        targetRevision: readOptionalText(change.targetRevision) || readOptionalText(metadata.targetRevision),
        yearMonth: readOptionalText(change.yearMonth),
        weekNo: safeAmount(change.weekNo),
        mode,
        lineId: readOptionalText(change.lineId) || readOptionalText(change.cashflowLine),
        beforeState,
        beforeHadValue: beforeState !== 'EMPTY',
        ...(beforeState !== 'EMPTY' ? { beforeAmount: safeAmount(before.amount) } : {}),
        afterState,
        afterHadValue: afterState !== 'EMPTY',
        ...(afterState !== 'EMPTY' ? { afterAmount: safeAmount(after.amount) } : {}),
        actorUid: readOptionalText(change.actorId) || readOptionalText(change.actorUid) || readOptionalText(document.actorId),
        actorName: readOptionalText(change.actorName) || readOptionalText(metadata.actorName),
        actorEmail: readOptionalText(change.actorEmail) || readOptionalText(metadata.actorEmail),
        reason: readOptionalText(change.reason) || readOptionalText(metadata.reason) || readOptionalText(metadata.amendmentReason),
        createdAt: readOptionalText(document.createdAt),
      };
    });
  return events;
}

function cashflowActivityDocumentEventList(events) {
  return [...events.legacy, ...events.refresh, ...events.sheetApply, ...events.appliedCell, ...events.close];
}

async function readCashflowActivity(db, tenantId, projectId, {
  source = '', limit, boundaries, performanceNow, onSourceMetric = () => {},
}) {
  const selectedSources = source ? [source] : CASHFLOW_ACTIVITY_SOURCES;
  const settled = await Promise.allSettled(selectedSources.map(async (sourceName) => {
    const startedAt = cashflowActivityMetricNow(performanceNow);
    try {
      return {
        source: sourceName,
        page: await readCashflowActivityDocuments(
          db,
          tenantId,
          CASHFLOW_ACTIVITY_COLLECTIONS[sourceName],
          projectId,
          limit,
          boundaries[sourceName],
        ),
        durationMs: Math.max(0, Math.round(cashflowActivityMetricNow(performanceNow) - startedAt)),
      };
    } catch (error) {
      onSourceMetric({
        source: sourceName,
        outcome: 'error',
        queryCount: boundaries[sourceName]?.done ? 0 : 1,
        documentCount: 0,
        documentJsonBytes: 0,
        responseJsonBytes: 0,
        durationMs: Math.max(0, Math.round(cashflowActivityMetricNow(performanceNow) - startedAt)),
      });
      throw error;
    }
  }));
  const pages = {};
  const nextBoundaries = {};
  const errors = [];
  for (let index = 0; index < selectedSources.length; index += 1) {
    const sourceName = selectedSources[index];
    const result = settled[index];
    if (result.status === 'rejected') {
      if (source) throw result.reason;
      errors.push({ source: sourceName, code: 'cashflow_activity_source_unavailable' });
      nextBoundaries[sourceName] = { done: true };
      continue;
    }
    pages[sourceName] = result.value.page;
  }
  const candidateDocuments = selectedSources
    .flatMap((sourceName) => (pages[sourceName]?.documents || []).map((document) => ({ source: sourceName, document })))
    .sort(compareCashflowActivityDocuments)
    .slice(0, limit);
  const selectedDocuments = [];
  const selectedDocumentEvents = [];
  let selectedEventCount = 0;
  let selectedEventJsonBytes = 0;
  for (const entry of candidateDocuments) {
    const documentEvents = buildCashflowActivityDocumentEvents(entry.source, entry.document, projectId);
    const eventList = cashflowActivityDocumentEventList(documentEvents);
    const eventJsonBytes = cashflowActivityJsonArrayBytes(eventList) - 2;
    const separatorBytes = selectedEventCount > 0 && eventList.length > 0 ? 1 : 0;
    if (
      selectedEventCount > 0
      && eventList.length > 0
      && selectedEventJsonBytes + separatorBytes + eventJsonBytes > CASHFLOW_ACTIVITY_RESPONSE_EVENT_BUDGET_BYTES
    ) break;
    selectedDocuments.push(entry);
    selectedDocumentEvents.push(documentEvents);
    selectedEventCount += eventList.length;
    selectedEventJsonBytes += separatorBytes + eventJsonBytes;
  }
  for (const sourceName of selectedSources) {
    if (!pages[sourceName]) continue;
    const selectedForSource = selectedDocuments.filter((entry) => entry.source === sourceName);
    const last = selectedForSource.at(-1)?.document;
    const createdAt = readOptionalText(last?.createdAt);
    if (last && createdAt) {
      nextBoundaries[sourceName] = {
        done: selectedForSource.length === pages[sourceName].documents.length && pages[sourceName].exhausted,
        createdAt,
        id: cashflowActivityDocumentId(last),
      };
    } else if (pages[sourceName].documents.length === 0) {
      nextBoundaries[sourceName] = { done: true };
    } else {
      nextBoundaries[sourceName] = boundaries[sourceName]?.done === false
        ? boundaries[sourceName]
        : { done: false };
    }
  }
  const refreshEvents = selectedDocumentEvents.flatMap((events) => events.refresh);
  const sheetApplyEvents = selectedDocumentEvents.flatMap((events) => events.sheetApply);
  const appliedCellEvents = selectedDocumentEvents.flatMap((events) => events.appliedCell);
  const closeEvents = selectedDocumentEvents.flatMap((events) => events.close);
  const legacyEvents = selectedDocumentEvents.flatMap((events) => events.legacy);
  const responseEventsBySource = {
    sheet_refresh: refreshEvents,
    audit: [...sheetApplyEvents, ...appliedCellEvents, ...closeEvents],
    legacy: legacyEvents,
  };
  for (const sourceName of selectedSources) {
    const page = pages[sourceName];
    if (!page) continue;
    const settledPage = settled.find((entry) => (
      entry.status === 'fulfilled' && entry.value.source === sourceName
    ));
    const responseJsonBytes = cashflowActivityJsonArrayBytes(responseEventsBySource[sourceName]);
    onSourceMetric({
      source: sourceName,
      outcome: 'ok',
      queryCount: page.queryCount,
      documentCount: page.documents.length,
      documentJsonBytes: cashflowActivityJsonArrayBytes(page.documents),
      responseJsonBytes,
      responseBudgetExceeded: responseJsonBytes > CASHFLOW_ACTIVITY_RESPONSE_EVENT_BUDGET_BYTES,
      durationMs: settledPage?.status === 'fulfilled' ? settledPage.value.durationMs : 0,
    });
  }
  return {
    events: [...legacyEvents, ...refreshEvents, ...sheetApplyEvents, ...appliedCellEvents, ...closeEvents]
      .filter((event) => readOptionalText(event.createdAt))
      .sort((left, right) => readOptionalText(right.createdAt).localeCompare(readOptionalText(left.createdAt))),
    errors,
    boundaries: nextBoundaries,
  };
}


function normalizeMonthCloseCell(cell, yearMonth) {
  const value = objectValue(cell);
  if (!value) return null;
  const mode = readOptionalText(value.mode).toLowerCase();
  const weekNo = Number(value.weekNo);
  const cashflowLine = readOptionalText(value.cashflowLine) || readOptionalText(value.lineId);
  const cellState = readOptionalText(value.cellState) || readOptionalText(value.state);
  if (
    !['projection', 'actual'].includes(mode)
    || !Number.isSafeInteger(weekNo)
    || weekNo < 1
    || weekNo > 5
    || !CASHFLOW_ALL_LINES.includes(cashflowLine)
    || !['VALUE', 'ZERO', 'EMPTY'].includes(cellState)
    || (readOptionalText(value.yearMonth) && readOptionalText(value.yearMonth) !== yearMonth)
  ) return null;
  const hasValue = ['VALUE', 'ZERO'].includes(cellState);
  const amount = hasValue ? value.amount : null;
  if (hasValue && (typeof amount !== 'number' || !Number.isSafeInteger(amount))) return null;
  if (cellState === 'ZERO' && amount !== 0) return null;
  return {
    mode,
    weekNo,
    cashflowLine,
    cellState,
    amount,
    sourceCell: readOptionalText(value.sourceCell) || null,
    sourceLabel: readOptionalText(value.sourceLabel) || null,
  };
}

function normalizeMonthCloseCells(cells, yearMonth) {
  return (Array.isArray(cells) ? cells : [])
    .map((cell) => normalizeMonthCloseCell(cell, yearMonth))
    .filter(Boolean);
}

function requireStoredCashflowAmount(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw createHttpError(
      502,
      '현금흐름 금액 중 확인할 수 없는 값이 있습니다. 시트값을 다시 불러와 주세요.',
      'jvm_weekly_cashflow_totals_invalid',
    );
  }
  return value;
}

function completeMonthCloseCells(cells) {
  if (cells.length !== CASHFLOW_MONTH_CELL_COUNT) return false;
  const keys = new Set(cells.map((cell) => `${cell.mode}:${cell.weekNo}:${cell.cashflowLine}`));
  return keys.size === CASHFLOW_MONTH_CELL_COUNT;
}


function indexMonthCells(cells) {
  const indexed = Array(CASHFLOW_ALL_LINES.length * 2 * WEEKS_PER_MONTH);
  for (const cell of Array.isArray(cells) ? cells : []) {
    const lineIndex = CASHFLOW_LINE_INDEX.get(cell?.cashflowLine);
    const modeIndex = cell?.mode === 'projection' ? 0 : cell?.mode === 'actual' ? 1 : -1;
    if (lineIndex === undefined || modeIndex === -1 || !Number.isInteger(cell?.weekNo)) continue;
    indexed[(modeIndex * WEEKS_PER_MONTH + cell.weekNo - 1) * CASHFLOW_ALL_LINES.length + lineIndex] = cell;
  }
  return indexed;
}

function indexedMonthCell(indexed, mode, weekNo, lineId) {
  const modeIndex = mode === 'projection' ? 0 : 1;
  return indexed[(modeIndex * WEEKS_PER_MONTH + weekNo - 1) * CASHFLOW_ALL_LINES.length + CASHFLOW_LINE_INDEX.get(lineId)];
}

function buildMonthModeReadModel(cells, mode, indexed = indexMonthCells(cells)) {
  const rowTotals = Object.fromEntries(CASHFLOW_ALL_LINES.map((lineId) => [lineId, 0]));
  let runningIn = 0;
  let runningOut = 0;
  const weeks = Array.from({ length: WEEKS_PER_MONTH }, (_, index) => {
    const weekNo = index + 1;
    const amounts = Object.fromEntries(CASHFLOW_ALL_LINES.map((lineId) => {
      const cell = indexedMonthCell(indexed, mode, weekNo, lineId);
      return [lineId, ['VALUE', 'ZERO'].includes(cell?.cellState) ? requireStoredCashflowAmount(cell.amount) : 0];
    }));
    for (const lineId of CASHFLOW_ALL_LINES) {
      const next = rowTotals[lineId] + amounts[lineId];
      if (!Number.isSafeInteger(next)) return null;
      rowTotals[lineId] = next;
    }
    const weekIn = sumSafe(CASHFLOW_IN_LINES.map((lineId) => amounts[lineId]));
    const weekOut = sumSafe(CASHFLOW_OUT_LINES.map((lineId) => amounts[lineId]));
    if (weekIn === null || weekOut === null) return null;
    runningIn += weekIn;
    runningOut += weekOut;
    return { weekNo, amounts, totalIn: weekIn, totalOut: weekOut, net: runningIn - runningOut, weekIn, weekOut };
  });
  if (weeks.some((week) => week === null) || !Number.isSafeInteger(runningIn) || !Number.isSafeInteger(runningOut)) {
    return null;
  }
  return {
    rowTotals,
    weeks,
    monthTotals: { totalIn: runningIn, totalOut: runningOut, net: runningIn - runningOut },
  };
}

function canonicalMonthCells(month, yearMonth) {
  return ['projection', 'actual'].flatMap((mode) => {
    const weeks = new Map((Array.isArray(month?.[mode]?.weeks) ? month[mode].weeks : [])
      .map((week) => [Number(week?.weekNo), objectValue(week?.amounts) || {}]));
    return Array.from({ length: 5 }, (_, index) => index + 1).flatMap((weekNo) => {
      const amounts = weeks.get(weekNo) || {};
      return CASHFLOW_ALL_LINES.map((cashflowLine) => {
        const hasValue = Object.hasOwn(amounts, cashflowLine);
        const amount = hasValue ? requireStoredCashflowAmount(amounts[cashflowLine]) : null;
        return {
          yearMonth,
          mode,
          weekNo,
          cashflowLine,
          cellState: hasValue ? (amount === 0 ? 'ZERO' : 'VALUE') : 'EMPTY',
          ...(hasValue ? { amount } : {}),
        };
      });
    });
  });
}

function monthWeeksFromCells(cells, yearMonth) {
  const modes = {
    projection: buildMonthModeReadModel(cells, 'projection'),
    actual: buildMonthModeReadModel(cells, 'actual'),
  };
  const financeWeeks = getMonthFinanceWeeks(yearMonth);
  return Array.from({ length: WEEKS_PER_MONTH }, (_, index) => {
    const weekNo = index + 1;
    const financeWeek = financeWeeks[index];
    return {
      yearMonth,
      weekNo,
      weekStart: financeWeek?.weekStart || '',
      weekEnd: financeWeek?.weekEnd || '',
      projection: modes.projection?.weeks?.[index]?.amounts || {},
      actual: modes.actual?.weeks?.[index]?.amounts || {},
    };
  });
}

function canonicalPinnedSheetWeeks(pinnedSheetCells) {
  const cellsByMonth = new Map();
  for (const sourceCell of Array.isArray(pinnedSheetCells) ? pinnedSheetCells : []) {
    const source = objectValue(sourceCell);
    const yearMonth = readOptionalText(source?.yearMonth);
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth)) continue;
    const cell = normalizeMonthCloseCell(source, yearMonth);
    if (!cell) continue;
    const monthCells = cellsByMonth.get(yearMonth) || [];
    monthCells.push(cell);
    cellsByMonth.set(yearMonth, monthCells);
  }
  return [...cellsByMonth.entries()]
    .filter(([, monthCells]) => completeMonthCloseCells(monthCells))
    .flatMap(([yearMonth, monthCells]) => monthWeeksFromCells(monthCells, yearMonth))
    .sort((left, right) => cashflowRangeSortKey(left) - cashflowRangeSortKey(right));
}

function cashflowMonthsByCoordinate(months, weeklyYear) {
  if (readWeeklyYear(weeklyYear) === null) return [];
  const indexed = Array(12);
  for (const month of Array.isArray(months) ? months : []) {
    const ordinal = weekOrdinal(weeklyYear, readOptionalText(month?.yearMonth), 1);
    if (ordinal !== -1) indexed[Math.trunc(ordinal / WEEKS_PER_MONTH)] = month;
  }
  return indexed;
}

function cashflowWeeksByCoordinate(weeks, weeklyYear, yearMonth) {
  if (readWeeklyYear(weeklyYear) === null) return [];
  const indexed = Array(WEEKS_PER_MONTH);
  for (const week of Array.isArray(weeks) ? weeks : []) {
    const ordinal = weekOrdinal(weeklyYear, yearMonth, week?.weekNo);
    if (ordinal !== -1) indexed[ordinal % WEEKS_PER_MONTH] = week;
  }
  return indexed;
}

function canonicalCashflowWeeks(cashflow, cells, yearMonth, pinnedSheetCells, weeklyYear, monthState) {
  if (readWeeklyYear(weeklyYear) === null) return [];
  const byKey = new Map();
  if (monthState === 'FROZEN_COMPLETE') {
    for (const week of canonicalPinnedSheetWeeks(pinnedSheetCells)) {
      if (weekOrdinal(weeklyYear, week.yearMonth, week.weekNo) !== -1) {
        byKey.set(`${week.yearMonth}:${week.weekNo}`, week);
      }
    }
    return [...byKey.values()].sort((left, right) => cashflowRangeSortKey(left) - cashflowRangeSortKey(right));
  }
  if (monthState === 'MONTH_CELLS') {
    if (weekOrdinal(weeklyYear, yearMonth, 1) !== -1) {
      for (const week of monthWeeksFromCells(cells, yearMonth)) byKey.set(`${yearMonth}:${week.weekNo}`, week);
    }
    return [...byKey.values()].sort((left, right) => cashflowRangeSortKey(left) - cashflowRangeSortKey(right));
  }
  for (const month of Array.isArray(cashflow?.readModel?.months) ? cashflow.readModel.months : []) {
    const monthKey = readOptionalText(month?.yearMonth);
    if (weekOrdinal(weeklyYear, monthKey, 1) === -1) continue;
    const financeWeeks = getMonthFinanceWeeks(monthKey);
    const projectionWeeks = cashflowWeeksByCoordinate(month?.projection?.weeks, weeklyYear, monthKey);
    const actualWeeks = cashflowWeeksByCoordinate(month?.actual?.weeks, weeklyYear, monthKey);
    for (let weekIndex = 0; weekIndex < WEEKS_PER_MONTH; weekIndex += 1) {
      const weekNo = weekIndex + 1;
      const financeWeek = financeWeeks[weekIndex];
      byKey.set(`${monthKey}:${weekNo}`, {
        yearMonth: monthKey,
        weekNo,
        weekStart: financeWeek?.weekStart || '',
        weekEnd: financeWeek?.weekEnd || '',
        projection: projectionWeeks[weekIndex]?.amounts || {},
        actual: actualWeeks[weekIndex]?.amounts || {},
      });
    }
  }
  return [...byKey.values()].sort((left, right) => (
    cashflowRangeSortKey(left) - cashflowRangeSortKey(right)
  ));
}

function cashflowCellKey(yearMonth, cell) {
  return `${yearMonth}:${cell.mode}:${cell.weekNo}:${cell.cashflowLine}`;
}

function canonicalCashflowCellStates(cashflow, cells, yearMonth, pinnedSheetCells, weeklyYear, monthState) {
  if (readWeeklyYear(weeklyYear) === null) return new Map();
  const canonicalMonths = Array.isArray(cashflow?.readModel?.months) ? cashflow.readModel.months : [];
  if (['LIVE_CURRENT', 'LIVE_AMENDED'].includes(monthState)) {
    const canonical = new Map();
    for (const month of canonicalMonths) {
      const monthKey = readOptionalText(month?.yearMonth);
      if (weekOrdinal(weeklyYear, monthKey, 1) === -1) continue;
      for (const mode of ['projection', 'actual']) {
        for (const week of Array.isArray(month?.[mode]?.weeks) ? month[mode].weeks : []) {
          const weekNo = Number(week?.weekNo);
          const amounts = objectValue(week?.amounts);
          if (!Number.isInteger(weekNo) || weekNo < 1 || weekNo > 5) continue;
          for (const lineId of CASHFLOW_ALL_LINES) {
            if (!Object.prototype.hasOwnProperty.call(amounts, lineId)) continue;
            canonical.set(`${monthKey}:${mode}:${weekNo}:${lineId}`, {
              mode,
              weekNo,
              cashflowLine: lineId,
              cellState: 'VALUE',
              amount: requireStoredCashflowAmount(amounts[lineId]),
            });
          }
        }
      }
    }
    return canonical;
  }
  const byKey = new Map();
  const sourceCells = monthState === 'FROZEN_COMPLETE' ? pinnedSheetCells : cells;
  for (const sourceCell of Array.isArray(sourceCells) ? sourceCells : []) {
    const source = objectValue(sourceCell);
    const sourceYearMonth = monthState === 'MONTH_CELLS' ? yearMonth : readOptionalText(source?.yearMonth);
    if (weekOrdinal(weeklyYear, sourceYearMonth, source?.weekNo) === -1) continue;
    const cell = normalizeMonthCloseCell(source, sourceYearMonth);
    if (cell) byKey.set(cashflowCellKey(sourceYearMonth, cell), cell);
  }
  return byKey;
}

export function buildCashflowManagementChecks({
  cashflow, cells, yearMonth, depositScheduleRows, comparisonBoundary, pinnedSheetCells,
  projectionOpeningBalance = 0, weeklyYear = null, monthState = null,
}) {
  const canonicalWeeklyYear = readWeeklyYear(weeklyYear);
  const hasCanonicalSource = canonicalWeeklyYear !== null
    && ['FROZEN_COMPLETE', 'MONTH_CELLS', 'LIVE_CURRENT', 'LIVE_AMENDED'].includes(monthState);
  const weeks = hasCanonicalSource
    ? canonicalCashflowWeeks(cashflow, cells, yearMonth, pinnedSheetCells, canonicalWeeklyYear, monthState)
    : [];
  const cellStates = hasCanonicalSource
    ? canonicalCashflowCellStates(cashflow, cells, yearMonth, pinnedSheetCells, canonicalWeeklyYear, monthState)
    : new Map();
  const asOfKey = cashflowRangeSortKey(comparisonBoundary?.asOfWeek || { yearMonth, weekNo: 5 });
  const deposits = (Array.isArray(depositScheduleRows) ? depositScheduleRows : []).map((row) => ({
    ...row,
    yearMonth: /^20\d{2}-(0[1-9]|1[0-2])$/.test(readOptionalText(row?.yearMonth)) ? row.yearMonth : yearMonth,
  }));
  return [
    laborTransferCheck(weeks, cellStates, yearMonth),
    profitVatAfterDepositCheck(weeks),
    negativeProjectionCheck(weeks, projectionOpeningBalance),
    futurePrepayCheck(weeks, asOfKey),
  ];
}


function actualWrittenProgressPercent(cells, yearMonth, comparisonBoundary) {
  const asOfYearMonth = readOptionalText(comparisonBoundary?.asOfWeek?.yearMonth);
  const asOfWeekNo = Number(comparisonBoundary?.asOfWeek?.weekNo);
  const targetWeekCount = yearMonth < asOfYearMonth ? 5 : yearMonth === asOfYearMonth ? Math.max(0, Math.min(5, asOfWeekNo)) : 0;
  if (targetWeekCount === 0) return 0;
  const target = cells.filter((cell) => cell.mode === 'actual' && cell.weekNo <= targetWeekCount);
  const expected = targetWeekCount * CASHFLOW_ALL_LINES.length;
  if (expected === 0) return 0;
  return Math.round((Math.min(expected, target.length) / expected) * 10_000) / 100;
}

function settlementProgress(comparison, confirmations, yearMonth, comparisonBoundary) {
  const asOfYearMonth = readOptionalText(comparisonBoundary?.asOfWeek?.yearMonth);
  const asOfWeekNo = Number(comparisonBoundary?.asOfWeek?.weekNo);
  const targetWeekCount = yearMonth < asOfYearMonth ? 5 : yearMonth === asOfYearMonth ? Math.max(0, Math.min(5, asOfWeekNo)) : 0;
  if (targetWeekCount === 0) return { percent: 0, completed: 0, total: 0, incompleteWeeks: [] };

  const confirmationKeys = validConfirmationKeys(confirmations);
  const weeks = new Map((Array.isArray(comparison?.weeks) ? comparison.weeks : []).map((week) => [Number(week?.weekNo), week]));
  const incompleteWeeks = [];
  let completed = 0;
  for (let weekNo = 1; weekNo <= targetWeekCount; weekNo += 1) {
    const week = weeks.get(weekNo);
    const lines = Array.isArray(week?.lines) ? week.lines : [];
    const matches = lines.length === CASHFLOW_ALL_LINES.length
      && lines.every((line) => (
        typeof line?.difference === 'number'
        && Number.isSafeInteger(line.difference)
        && line.difference === 0
      ));
    const humanConfirmed = ['projection', 'actual'].every((mode) => (
      CASHFLOW_ALL_LINES.every((cashflowLine) => confirmationKeys.has(`${mode}:${weekNo}:${cashflowLine}`))
    ));
    if (matches || humanConfirmed) {
      completed += 1;
      continue;
    }
    incompleteWeeks.push({
      yearMonth,
      weekNo,
      totalIn: safeAmount(week?.totalIn),
      totalOut: safeAmount(week?.totalOut),
      balance: safeAmount(week?.net),
      reason: lines.length === CASHFLOW_ALL_LINES.length ? 'DIFFERENCE_REVIEW_REQUIRED' : 'SOURCE_INCOMPLETE',
    });
  }
  return {
    percent: Math.round((completed / targetWeekCount) * 10_000) / 100,
    completed,
    total: targetWeekCount,
    incompleteWeeks,
  };
}

function postCloseAdjustment(close, currentSnapshot) {
  const previous = objectValue(close?.previousSnapshot);
  if (!previous || Object.keys(previous).length === 0) return null;
  const amounts = (snapshot) => {
    const result = new Map();
    for (const week of Array.isArray(snapshot?.weeklyTotals) ? snapshot.weeklyTotals : []) {
      const weekNo = Number(week?.weekNo);
      for (const mode of ['projection', 'actual']) {
        const values = objectValue(week?.[mode]) || {};
        for (const lineId of CASHFLOW_ALL_LINES) {
          result.set(
            `${mode}:${weekNo}:${lineId}`,
            Object.hasOwn(values, lineId) ? requireStoredCashflowAmount(values[lineId]) : 0,
          );
        }
      }
    }
    return result;
  };
  const before = amounts(previous);
  const after = amounts(currentSnapshot);
  const changes = [...after.entries()].flatMap(([key, afterAmount]) => {
    const beforeAmount = before.get(key) || 0;
    if (beforeAmount === afterAmount) return [];
    const [mode, weekNo, cashflowLine] = key.split(':');
    return [{ mode, weekNo: Number(weekNo), cashflowLine, beforeAmount, afterAmount }];
  });
  const reopenContext = objectValue(currentSnapshot?.reopenContext) || {};
  const request = objectValue(reopenContext.request) || {};
  const decision = objectValue(reopenContext.decision) || {};
  return {
    reason: readOptionalText(request.reason) || readOptionalText(decision.reason) || '재오픈 후 조정',
    changedCount: changes.length,
    changes: changes.slice(0, 200),
  };
}

function parseCashflowRangeBoundary(value, fieldName) {
  const normalized = readOptionalText(value);
  if (!normalized) return null;
  const match = /^(\d{4}-(?:0[1-9]|1[0-2])):([1-5])$/.exec(normalized);
  if (!match) {
    throw createHttpError(
      400,
      `${fieldName} must use YYYY-MM:week format.`,
      'cashflow_range_invalid',
    );
  }
  return {
    yearMonth: match[1],
    weekNo: Number(match[2]),
  };
}


function cashflowReadModelBoundaries(months) {
  const boundaries = [];
  for (const month of Array.isArray(months) ? months : []) {
    const yearMonth = readOptionalText(month?.yearMonth);
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(yearMonth)) continue;
    const weekNumbers = new Set();
    for (const mode of ['projection', 'actual']) {
      for (const week of Array.isArray(month?.[mode]?.weeks) ? month[mode].weeks : []) {
        const weekNo = Number(week?.weekNo);
        if (Number.isSafeInteger(weekNo) && weekNo >= 1 && weekNo <= 5) weekNumbers.add(weekNo);
      }
    }
    for (const weekNo of weekNumbers) boundaries.push({ yearMonth, weekNo });
  }
  return boundaries.sort((left, right) => cashflowRangeSortKey(left) - cashflowRangeSortKey(right));
}

function resolveCashflowReadModelRange({ months, rawStart, rawEnd, comparisonBoundary }) {
  const knownBoundaries = cashflowReadModelBoundaries(months);
  const fallbackYearMonth = readOptionalText(comparisonBoundary?.asOfWeek?.yearMonth);
  const start = parseCashflowRangeBoundary(rawStart, 'rangeStart')
    || knownBoundaries[0]
    || { yearMonth: fallbackYearMonth, weekNo: 1 };
  const end = parseCashflowRangeBoundary(rawEnd, 'rangeEnd')
    || knownBoundaries.at(-1)
    || { yearMonth: fallbackYearMonth, weekNo: 5 };
  if (!start.yearMonth || !end.yearMonth || cashflowRangeSortKey(start) > cashflowRangeSortKey(end)) {
    throw createHttpError(400, 'rangeStart must be before or equal to rangeEnd.', 'cashflow_range_invalid');
  }
  return { start, end };
}

function buildCashflowRangeTotals(months, mode, range) {
  const startKey = cashflowRangeSortKey(range.start);
  const endKey = cashflowRangeSortKey(range.end);
  const rowTotals = Object.fromEntries(CASHFLOW_ALL_LINES.map((lineId) => [lineId, 0]));
  let totalIn = 0;
  let totalOut = 0;
  for (const month of Array.isArray(months) ? months : []) {
    const yearMonth = readOptionalText(month?.yearMonth);
    for (const week of Array.isArray(month?.[mode]?.weeks) ? month[mode].weeks : []) {
      const weekNo = Number(week?.weekNo);
      if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(yearMonth) || !Number.isSafeInteger(weekNo)) continue;
      const sortKey = cashflowRangeSortKey({ yearMonth, weekNo });
      if (sortKey < startKey || sortKey > endKey) continue;
      const amounts = week?.amounts && typeof week.amounts === 'object' ? week.amounts : {};
      const validatedAmounts = {};
      for (const lineId of CASHFLOW_ALL_LINES) {
        const amount = Object.hasOwn(amounts, lineId) ? requireStoredCashflowAmount(amounts[lineId]) : 0;
        validatedAmounts[lineId] = amount;
        const next = rowTotals[lineId] + amount;
        if (!Number.isSafeInteger(next)) {
          throw createHttpError(502, '합계 금액에 올바르지 않은 값이 있어 화면에 표시할 수 없습니다. 담당자에게 문의해 주세요.', 'jvm_weekly_cashflow_totals_invalid');
        }
        rowTotals[lineId] = next;
      }
      const weekIn = sumSafe(CASHFLOW_IN_LINES.map((lineId) => validatedAmounts[lineId]));
      const weekOut = sumSafe(CASHFLOW_OUT_LINES.map((lineId) => validatedAmounts[lineId]));
      if (weekIn === null || weekOut === null) {
        throw createHttpError(502, '합계 금액에 올바르지 않은 값이 있어 화면에 표시할 수 없습니다. 담당자에게 문의해 주세요.', 'jvm_weekly_cashflow_totals_invalid');
      }
      totalIn += weekIn;
      totalOut += weekOut;
      if (!Number.isSafeInteger(totalIn) || !Number.isSafeInteger(totalOut)) {
        throw createHttpError(502, '합계 금액에 올바르지 않은 값이 있어 화면에 표시할 수 없습니다. 담당자에게 문의해 주세요.', 'jvm_weekly_cashflow_totals_invalid');
      }
    }
  }
  const net = totalIn - totalOut;
  if (!Number.isSafeInteger(net)) {
    throw createHttpError(502, '합계 금액에 올바르지 않은 값이 있어 화면에 표시할 수 없습니다. 담당자에게 문의해 주세요.', 'jvm_weekly_cashflow_totals_invalid');
  }
  return { rowTotals, totalIn, totalOut, net };
}

function cashflowReadModelForYear(readModel, weeklyYear) {
  const canonical = objectValue(readModel);
  if (!canonical || !Array.isArray(canonical.months) || readWeeklyYear(weeklyYear) === null) return null;
  const months = cashflowMonthsByCoordinate(canonical.months, weeklyYear).filter(Boolean);
  const range = {
    start: { yearMonth: `${weeklyYear}-01`, weekNo: 1 },
    end: { yearMonth: `${weeklyYear}-12`, weekNo: WEEKS_PER_MONTH },
  };
  return {
    ...canonical,
    months,
    range: {
      ...range,
      projection: buildCashflowRangeTotals(months, 'projection', range),
      actual: buildCashflowRangeTotals(months, 'actual', range),
    },
  };
}

function frozenCashflowReadModel(ledgerWeeks) {
  const weeks = (Array.isArray(ledgerWeeks) ? ledgerWeeks : [])
    .map((raw) => {
      const source = objectValue(raw);
      const yearMonth = readOptionalText(source?.yearMonth);
      const weekNo = Number(source?.weekNo);
      if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth) || !Number.isSafeInteger(weekNo) || weekNo < 1 || weekNo > 5) {
        return null;
      }
      const modes = {};
      for (const mode of ['projection', 'actual']) {
        const rawAmounts = objectValue(source?.[mode]) || {};
        const amounts = {};
        for (const lineId of CASHFLOW_ALL_LINES) {
          if (!Object.prototype.hasOwnProperty.call(rawAmounts, lineId)) continue;
          amounts[lineId] = requireStoredCashflowAmount(rawAmounts[lineId]);
        }
        modes[mode] = amounts;
      }
      return { yearMonth, weekNo, ...modes };
    })
    .filter(Boolean)
    .sort((left, right) => cashflowRangeSortKey(left) - cashflowRangeSortKey(right));
  if (weeks.length === 0) return null;

  const running = {
    projection: { totalIn: 0, totalOut: 0 },
    actual: { totalIn: 0, totalOut: 0 },
  };
  const months = new Map();
  for (const sourceWeek of weeks) {
    const month = months.get(sourceWeek.yearMonth) || {
      yearMonth: sourceWeek.yearMonth,
      projection: { rowTotals: Object.fromEntries(CASHFLOW_ALL_LINES.map((lineId) => [lineId, 0])), weeks: [], totalIn: 0, totalOut: 0 },
      actual: { rowTotals: Object.fromEntries(CASHFLOW_ALL_LINES.map((lineId) => [lineId, 0])), weeks: [], totalIn: 0, totalOut: 0 },
    };
    for (const mode of ['projection', 'actual']) {
      const amounts = sourceWeek[mode];
      for (const lineId of CASHFLOW_ALL_LINES) {
        const amount = Object.hasOwn(amounts, lineId) ? amounts[lineId] : 0;
        const next = month[mode].rowTotals[lineId] + amount;
        if (!Number.isSafeInteger(next)) {
          throw createHttpError(502, '결산된 달의 항목 합계에 올바르지 않은 값이 있어 화면에 표시할 수 없습니다. 담당자에게 문의해 주세요.', 'jvm_weekly_cashflow_totals_invalid');
        }
        month[mode].rowTotals[lineId] = next;
      }
      const weekIn = sumSafe(CASHFLOW_IN_LINES.map((lineId) => (
        Object.hasOwn(amounts, lineId) ? amounts[lineId] : 0
      )));
      const weekOut = sumSafe(CASHFLOW_OUT_LINES.map((lineId) => (
        Object.hasOwn(amounts, lineId) ? amounts[lineId] : 0
      )));
      if (weekIn === null || weekOut === null) {
        throw createHttpError(502, '결산된 달의 항목 합계에 올바르지 않은 값이 있어 화면에 표시할 수 없습니다. 담당자에게 문의해 주세요.', 'jvm_weekly_cashflow_totals_invalid');
      }
      running[mode].totalIn += weekIn;
      running[mode].totalOut += weekOut;
      month[mode].totalIn += weekIn;
      month[mode].totalOut += weekOut;
      for (const value of [
        running[mode].totalIn,
        running[mode].totalOut,
        month[mode].totalIn,
        month[mode].totalOut,
      ]) {
        if (!Number.isSafeInteger(value)) {
          throw createHttpError(502, '결산된 달의 누적 합계에 올바르지 않은 값이 있어 화면에 표시할 수 없습니다. 담당자에게 문의해 주세요.', 'jvm_weekly_cashflow_totals_invalid');
        }
      }
      month[mode].weeks.push({
        weekNo: sourceWeek.weekNo,
        amounts,
        totalIn: weekIn,
        totalOut: weekOut,
        weekIn,
        weekOut,
        net: running[mode].totalIn - running[mode].totalOut,
      });
    }
    months.set(sourceWeek.yearMonth, month);
  }
  return {
    months: [...months.values()].map((month) => ({
      yearMonth: month.yearMonth,
      projection: {
        rowTotals: month.projection.rowTotals,
        weeks: month.projection.weeks,
        monthTotals: {
          totalIn: month.projection.totalIn,
          totalOut: month.projection.totalOut,
          net: month.projection.weeks.at(-1)?.net ?? 0,
        },
      },
      actual: {
        rowTotals: month.actual.rowTotals,
        weeks: month.actual.weeks,
        monthTotals: {
          totalIn: month.actual.totalIn,
          totalOut: month.actual.totalOut,
          net: month.actual.weeks.at(-1)?.net ?? 0,
        },
      },
    })),
  };
}

function differenceTotals(projection, actual) {
  const difference = (left, right) => (
    safeAmount(left) === null || safeAmount(right) === null
      ? null
      : sumSafe([left, -right])
  );
  return {
    totalIn: difference(projection.totalIn, actual.totalIn),
    totalOut: difference(projection.totalOut, actual.totalOut),
    balance: difference(projection.balance, actual.balance),
  };
}

function dashboardTotals(mode) {
  if (!mode) {
    return { totalIn: null, totalOut: null, balance: null, rowTotals: {}, weeks: [] };
  }
  return {
    totalIn: safeAmount(mode.monthTotals?.totalIn),
    totalOut: safeAmount(mode.monthTotals?.totalOut),
    balance: safeAmount(mode.monthTotals?.net),
    rowTotals: mode.rowTotals || {},
    weeks: mode.weeks || [],
  };
}

function buildCashflowMonthCloseMonthSnapshot({
  projectId, yearMonth, cells, sourceRevision, targetRevision, capturedAt, spreadsheetId, spreadsheetTitle, selectedSheetName,
}) {
  const indexedCells = indexMonthCells(cells);
  const modeSnapshot = (mode) => {
    const totals = dashboardTotals(buildMonthModeReadModel(cells, mode, indexedCells));
    return {
      ...totals,
      weeks: totals.weeks.map((week) => ({
        ...week,
        cells: CASHFLOW_ALL_LINES.map((cashflowLine) => {
          const cell = indexedMonthCell(indexedCells, mode, week.weekNo, cashflowLine);
          return { cashflowLine, cellState: cell.cellState, amount: cell.amount };
        }),
      })),
    };
  };
  const projection = modeSnapshot('projection');
  const actual = modeSnapshot('actual');
  return {
    schemaVersion: 1,
    projectId,
    yearMonth,
    source: {
      sourceRevision,
      targetRevision,
      capturedAt,
      spreadsheetId,
      spreadsheetTitle,
      selectedSheetName,
      spreadsheetUrl: spreadsheetId
        ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`
        : null,
    },
    projection,
    actual,
    difference: differenceTotals(projection, actual),
  };
}

function canonicalWeeklyProjection(cashflow, fallback, weeklyYear) {
  const months = cashflowMonthsByCoordinate(cashflow?.readModel?.months, weeklyYear).filter(Boolean);
  const boundaries = cashflowReadModelBoundaries(months);
  if (boundaries.length === 0) return fallback;
  const totals = buildCashflowRangeTotals(months, 'projection', {
    start: boundaries[0],
    end: boundaries.at(-1),
  });
  const salesAndVatTotal = sumSafe([
    safeAmount(totals.rowTotals?.SALES_IN),
    safeAmount(totals.rowTotals?.SALES_VAT_IN),
  ]);
  if (salesAndVatTotal === null) {
    throw createHttpError(502, 'Projection 합계에 올바르지 않은 값이 있어 화면에 표시할 수 없습니다. 담당자에게 문의해 주세요.', 'jvm_weekly_cashflow_totals_invalid');
  }
  return {
    totalIn: totals.totalIn,
    salesAndVatTotal,
  };
}

function projectFinancialYears(project = {}) {
  const startText = readOptionalText(project.contractStart);
  const endText = readOptionalText(project.contractEnd);
  const startYear = /^\d{4}-/.test(startText) ? Number(startText.slice(0, 4)) : Number.NaN;
  const endYear = /^\d{4}-/.test(endText) ? Number(endText.slice(0, 4)) : Number.NaN;
  if (Number.isSafeInteger(startYear) && Number.isSafeInteger(endYear) && startYear <= endYear && endYear - startYear <= 20) {
    return Array.from({ length: endYear - startYear + 1 }, (_, index) => startYear + index);
  }
  return [...new Set((Array.isArray(project.financialYears) ? project.financialYears : [])
    .map((row) => Number(row?.year))
    .filter(Number.isSafeInteger))].sort((left, right) => left - right);
}

function composeProjectionTotal({ project, cashflow, annualTotals, fallback, weeklyYear }) {
  const canonicalWeeklyYear = readWeeklyYear(weeklyYear);
  if (canonicalWeeklyYear === null) return { ...fallback, years: [] };
  const weekly = canonicalWeeklyProjection(cashflow, fallback, canonicalWeeklyYear);
  const projectYears = projectFinancialYears(project);
  const annualYears = annualYearsFor(canonicalWeeklyYear).filter((year) => projectYears.includes(year));
  const annualByYear = new Map((Array.isArray(annualTotals) ? annualTotals : [])
    .map((row) => [Number(row.year), row]));
  const annual = annualYears.map((year) => {
    const total = annualByYear.get(year);
    const lineAmounts = objectValue(total?.projection?.lineAmounts);
    const salesAndVatTotal = lineAmounts
      ? sumSafe([
        Object.hasOwn(lineAmounts, 'SALES_IN') ? lineAmounts.SALES_IN : 0,
        Object.hasOwn(lineAmounts, 'SALES_VAT_IN') ? lineAmounts.SALES_VAT_IN : 0,
      ])
      : null;
    return {
      year,
      source: total ? 'ANNUAL' : 'MISSING',
      totalIn: safeAmount(total?.projection?.totalIn),
      salesAndVatTotal,
      salesAndVatSource: lineAmounts ? 'ANNUAL_LINES' : 'MISSING',
    };
  });
  return {
    totalIn: sumSafe([weekly.totalIn, ...annual.map((row) => row.totalIn)]),
    salesAndVatTotal: sumSafe([weekly.salesAndVatTotal, ...annual.map((row) => row.salesAndVatTotal)]),
    years: [
      { year: canonicalWeeklyYear, source: 'WEEKLY' },
      ...annual,
    ].sort((left, right) => left.year - right.year),
  };
}

function validConfirmationKeys(confirmations) {
  const keys = new Set();
  for (const confirmation of Array.isArray(confirmations) ? confirmations : []) {
    const mode = readOptionalText(confirmation?.mode).toLowerCase();
    const weekNo = Number(confirmation?.weekNo);
    const cashflowLine = readOptionalText(confirmation?.cashflowLine);
    const decision = readOptionalText(confirmation?.decision).toUpperCase();
    if (
      !['projection', 'actual'].includes(mode)
      || !Number.isSafeInteger(weekNo)
      || weekNo < 1
      || weekNo > 5
      || !CASHFLOW_ALL_LINES.includes(cashflowLine)
      || !['CONFIRMED', 'NOT_APPLICABLE'].includes(decision)
    ) continue;
    keys.add(`${mode}:${weekNo}:${cashflowLine}`);
  }
  return keys;
}

function completeMonthCloseConfirmations(confirmations) {
  const expectedCount = CASHFLOW_MONTH_CELL_COUNT;
  return Array.isArray(confirmations)
    && confirmations.length === expectedCount
    && validConfirmationKeys(confirmations).size === expectedCount;
}

function closeSnapshotCells(snapshot, yearMonth) {
  const pinnedCells = normalizeMonthCloseCells(snapshot?.cells, yearMonth);
  if (pinnedCells.length > 0) return pinnedCells;
  return (Array.isArray(snapshot?.weeklyTotals) ? snapshot.weeklyTotals : []).flatMap((week) => (
    ['projection', 'actual'].flatMap((mode) => CASHFLOW_ALL_LINES.map((cashflowLine) => {
      const amounts = objectValue(week?.[mode]) || {};
      const hasValue = Object.hasOwn(amounts, cashflowLine);
      const amount = hasValue ? requireStoredCashflowAmount(amounts[cashflowLine]) : null;
      return normalizeMonthCloseCell({
        mode,
        weekNo: week?.weekNo,
        cashflowLine,
        cellState: hasValue ? (amount === 0 ? 'ZERO' : 'VALUE') : 'EMPTY',
        ...(hasValue ? { amount } : {}),
      }, yearMonth);
    }))
  )).filter(Boolean);
}

function normalizedMetadataText(value) {
  return readOptionalText(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function projectSheetWarnings(project, metadata) {
  const warnings = [];
  const businessType = normalizedMetadataText(metadata?.businessType?.value);
  const accountType = normalizedMetadataText(metadata?.accountType?.value);
  const settlementStatus = normalizedMetadataText(metadata?.settlementStatus?.value);
  const settlementType = readOptionalText(project?.settlementType).toUpperCase();
  const basis = normalizedMetadataText(project?.basis);
  if (!businessType) {
    warnings.push({ code: 'SHEET_BUSINESS_TYPE_MISSING', message: '시트의 사업 구분을 확인해 주세요.' });
  } else if (
    (settlementType !== 'NONE' && !businessType.includes(settlementType.toLowerCase()))
    || (basis && basis !== 'none' && !businessType.includes(basis))
  ) {
    warnings.push({ code: 'PROJECT_SHEET_BUSINESS_TYPE_MISMATCH', message: '프로젝트 등록 정보와 시트의 사업 구분이 다릅니다.' });
  }
  if (!accountType) {
    warnings.push({ code: 'SHEET_ACCOUNT_TYPE_MISSING', message: '시트의 전용계좌사업 여부를 확인해 주세요.' });
  } else if ((project?.accountType === 'DEDICATED') !== accountType.includes('전용계좌')) {
    warnings.push({ code: 'PROJECT_SHEET_ACCOUNT_TYPE_MISMATCH', message: '프로젝트 등록 정보와 시트의 계좌 구분이 다릅니다.' });
  }
  const expectsSettlement = settlementType !== 'NONE';
  if (!settlementStatus) {
    warnings.push({ code: 'SHEET_SETTLEMENT_STATUS_MISSING', message: '시트의 정산 여부를 확인해 주세요.' });
  } else if (expectsSettlement !== settlementStatus.includes('정산진행')) {
    warnings.push({ code: 'PROJECT_SHEET_SETTLEMENT_STATUS_MISMATCH', message: '프로젝트 등록 정보와 시트의 정산 여부가 다릅니다.' });
  }
  return warnings;
}

function projectMetadata(project) {
  const settlementType = readOptionalText(project?.settlementType).toUpperCase();
  const basis = readOptionalText(project?.basis);
  return {
    businessType: [settlementType && settlementType !== 'NONE' ? settlementType : '', basis && basis !== 'NONE' ? basis : '']
      .filter(Boolean).join(' · ') || '미정',
    accountType: project?.accountType === 'DEDICATED' ? '전용계좌사업' : project?.accountType ? '운영계좌사업' : '미정',
    settlementStatus: !settlementType ? '미정' : settlementType !== 'NONE' ? '정산진행' : '정산없음',
  };
}


// 달력 규칙은 cashflow-close-calendar 에 있다. 여기는 "성립 불가"를 사용자 문구로 바꾼다.
function cumulativeCloseMonths(yearMonth) {
  const months = cumulativeCloseMonthsOrNull(yearMonth);
  if (months === null) {
    throw createHttpError(
      400,
      '누적 월 결산 범위는 2023-01부터 최대 240개월까지 선택할 수 있습니다.',
      'cashflow_month_close_request_invalid',
    );
  }
  return months;
}

function buildCumulativeCloseScope(yearMonth, evidence = null) {
  const contract = cashflowCumulativeCloseScope(yearMonth);
  if (!contract) {
    throw createHttpError(
      400,
      '누적 월 결산 범위는 2023-01부터 최대 240개월까지 선택할 수 있습니다.',
      'cashflow_month_close_request_invalid',
    );
  }
  const { contractVersion, fromMonth, throughMonth } = contract;
  const nestedSource = objectValue(evidence?.source) || {};
  const sourceField = (...keys) => {
    for (const key of keys) {
      const value = readOptionalText(nestedSource[key]) || readOptionalText(evidence?.[key]);
      if (value) return value;
    }
    return null;
  };
  const spreadsheetId = sourceField('spreadsheetId');
  return {
    contractVersion,
    fromMonth,
    throughMonth,
    monthCount: contract.monthCount,
    weekCount: contract.weekCount,
    cellCount: contract.cellCount,
    lockRange: {
      fromMonth: CASHFLOW_CUMULATIVE_CLOSE_FROM_MONTH,
      fromWeekNo: 1,
      throughMonth,
      throughWeekNo: 5,
    },
    source: {
      sourceRevision: sourceField('sourceRevision', 'sourceFingerprint'),
      targetRevision: sourceField('targetRevision', 'targetRevisionAtFetch'),
      capturedAt: sourceField('capturedAt', 'sourceReadAt'),
      spreadsheetId,
      spreadsheetTitle: sourceField('spreadsheetTitle'),
      selectedSheetName: sourceField('selectedSheetName'),
      spreadsheetUrl: sourceField('spreadsheetUrl') || (spreadsheetId
        ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`
        : null),
    },
  };
}

async function readCashflowSheetPublicationState({ db, tenantId, projectId, nowMs = Date.now() }) {
  if (!db?.doc) {
    return { blocked: false, fingerprint: '{}' };
  }
  const snapshot = await db.doc(`orgs/${tenantId}/cashflow_sheet_publications/${projectId}`).get();
  const data = snapshot.exists ? snapshot.data() || {} : {};
  const publication = {
    status: readOptionalText(data.status).toUpperCase(),
    stagedRunId: readOptionalText(data.stagedRunId),
    sourceRevision: readOptionalText(data.sourceRevision),
    targetRevisionAtFetch: readOptionalText(data.targetRevisionAtFetch),
    appliedTargetRevision: readOptionalText(data.appliedTargetRevision),
    applyStartedAt: readOptionalText(data.applyStartedAt),
    applyFailedAt: readOptionalText(data.applyFailedAt),
    appliedAt: readOptionalText(data.appliedAt),
  };
  const lease = readCashflowApplyLeaseState(publication, {
    nowMs,
    leaseMs: cashflowApplyLeaseMs(),
  });
  return {
    blocked: lease.blocked,
    applyStartedAt: publication.applyStartedAt || null,
    leaseExpiresAt: lease.expiresAt,
    fingerprint: stableStringify(publication),
  };
}

function assertCashflowSheetPublicationReady(state) {
  if (!state.blocked) return;
  const error = createHttpError(
    409,
    '시트 값을 MYSCube 시트에 반영 중입니다. 반영이 끝난 뒤 다시 확인해 주세요.',
    'cashflow_sheet_apply_in_progress',
  );
  if (state.leaseExpiresAt) error.details = { leaseExpiresAt: state.leaseExpiresAt };
  throw error;
}



async function readCashflowMonthCloseStatuses({
  db, tenantId, projectId, selectedYear, weeklyYear, cumulativeAuthority, monthCloseCalendar, businessDate = '',
}) {
  const canonicalWeeklyYear = readWeeklyYear(weeklyYear);
  const authority = objectValue(cumulativeAuthority) || {};
  const availability = readOptionalText(authority.availability).toUpperCase();
  const unavailableAuthority = (state, blockerCode, message, sectionCode) => ({
    authority: {
      availability: state,
      status: null,
      fromMonth: null,
      closedThrough: null,
      rootHash: null,
      headRevision: null,
    },
    statuses: null,
    blockers: [{ code: blockerCode, message }],
    sectionErrors: [{ section: 'monthCloseStatuses', code: sectionCode }],
  });

  if (availability === 'INVALID') {
    return unavailableAuthority(
      'INVALID',
      'CUMULATIVE_CLOSE_AUTHORITY_INVALID',
      '누적 월 결산 기준이 손상되었습니다. AXR 관리자에게 복구를 요청해 주세요.',
      'cashflow_cumulative_close_authority_invalid',
    );
  }
  if (availability === 'UNAVAILABLE') {
    return unavailableAuthority(
      'UNAVAILABLE',
      'CUMULATIVE_CLOSE_AUTHORITY_UNAVAILABLE',
      '누적 월 결산 기준을 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.',
      'cashflow_cumulative_close_authority_unavailable',
    );
  }

  let normalizedAuthority = null;
  let authorityView;
  if (availability === 'AVAILABLE') {
    normalizedAuthority = readCashflowCumulativeCloseAuthority({
      ...authority,
      contractVersion: CASHFLOW_CUMULATIVE_CLOSE_CONTRACT,
      tenantId,
      projectId,
      revision: authority.headRevision,
    }, { tenantId, projectId });
    if (!normalizedAuthority) {
      return unavailableAuthority(
        'INVALID',
        'CUMULATIVE_CLOSE_AUTHORITY_INVALID',
        '누적 월 결산 기준이 손상되었습니다. AXR 관리자에게 복구를 요청해 주세요.',
        'cashflow_cumulative_close_authority_invalid',
      );
    }
    authorityView = {
      availability: 'AVAILABLE',
      status: normalizedAuthority.status,
      fromMonth: CASHFLOW_CUMULATIVE_CLOSE_FROM_MONTH,
      closedThrough: normalizedAuthority.closedThrough,
      rootHash: normalizedAuthority.rootHash,
      headRevision: normalizedAuthority.revision,
    };
  } else if (
    availability === 'MISSING'
    && !readOptionalText(authority.status)
    && !readOptionalText(authority.fromMonth)
    && !readOptionalText(authority.closedThrough)
    && !readOptionalText(authority.rootHash)
    && authority.headRevision == null
  ) {
    authorityView = {
      availability: 'MISSING',
      status: null,
      fromMonth: null,
      closedThrough: null,
      rootHash: null,
      headRevision: null,
    };
  } else {
    return unavailableAuthority(
      'INVALID',
      'CUMULATIVE_CLOSE_AUTHORITY_INVALID',
      '누적 월 결산 기준이 손상되었습니다. AXR 관리자에게 복구를 요청해 주세요.',
      'cashflow_cumulative_close_authority_invalid',
    );
  }

  if (canonicalWeeklyYear === null) {
    return {
      authority: authorityView,
      statuses: null,
      blockers: [],
      sectionErrors: [{
        section: 'monthCloseStatuses',
        code: 'cashflow_month_close_period_contract_unavailable',
      }],
    };
  }

  let historyByMonth = null;
  try {
    if (!db?.collection) throw new Error('month close history store unavailable');
    const snapshot = await db.collection(`orgs/${tenantId}/monthly_closes`)
      .where('projectId', '==', projectId)
      .limit(500)
      .get();
    historyByMonth = new Map(snapshot.docs
      .map((doc) => doc.data() || {})
      .map((value) => [readOptionalText(value.yearMonth), value])
      .filter(([yearMonth]) => /^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)));
  } catch {
    if (availability === 'MISSING') {
      return {
        authority: authorityView,
        statuses: null,
        blockers: [{
          code: 'CUMULATIVE_CLOSE_HISTORY_UNAVAILABLE',
          message: '기존 월 결산 이력을 확인하지 못해 최초 상태를 판정할 수 없습니다. 잠시 후 다시 불러와 주세요.',
        }],
        sectionErrors: [{ section: 'monthCloseHistory', code: 'cashflow_month_close_history_unavailable' }],
      };
    }
  }

  if (availability === 'MISSING' && [...historyByMonth.values()].some((value) => (
    readOptionalText(value.status).toUpperCase() !== 'OPEN'
  ))) {
    return {
      authority: authorityView,
      statuses: null,
      blockers: [{
        code: 'CUMULATIVE_CLOSE_MIGRATION_REQUIRED',
        message: '기존 월 결산 이력에 대응하는 누적 마감 기준이 없습니다. AXR 관리자에게 복구를 요청해 주세요.',
      }],
      sectionErrors: [{ section: 'monthCloseStatuses', code: 'cashflow_month_close_migration_required' }],
    };
  }

  const closedThrough = normalizedAuthority?.closedThrough || '';
  const historyUnavailable = historyByMonth === null;
  const statuses = Array.from({ length: 12 }, (_unused, monthIndex) => {
    const yearMonth = `${selectedYear}-${String(monthIndex + 1).padStart(2, '0')}`;
    const calendarItem = monthCloseCalendar.get(yearMonth);
    const status = selectedYear === canonicalWeeklyYear && closedThrough && yearMonth <= closedThrough
      ? 'CLOSED'
      : 'OPEN';
    const history = historyByMonth?.get(yearMonth) || {};
    const snapshotFacts = objectValue(objectValue(history.snapshot)?.sheetFacts);
    const amendmentEvidence = objectValue(history.lastAmendmentEvidence);
    const amendedCurrent = (
      readOptionalText(history.status).toUpperCase() === 'CLOSED'
      && Number(history.amendmentCount) > 0
      && readOptionalText(amendmentEvidence.closeSnapshotHash)
      && readOptionalText(amendmentEvidence.closeSnapshotHash) === readOptionalText(history.snapshotHash)
    );
    const calculationChecks = amendedCurrent
      ? amendmentEvidence.calculationChecks
      : snapshotFacts?.weeklyCalculationChecks;
    return {
      yearMonth,
      status,
      closeDeadline: calendarItem.closeDeadline,
      closeDeadlineAt: calendarItem.closeDeadlineAt,
      approverDeadlineAt: calendarItem.approverDeadlineAt,
      // 기한 자체는 JVM 계약이고, 여기서는 기존 status/history join 에 기준일을 표시한다.
      closeOverdue: /^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(businessDate)
        && status !== 'CLOSED'
        && businessDate > calendarItem.closeDeadline,
      sheetCalculationChecks: historyUnavailable
        ? null
        : Array.isArray(calculationChecks)
          ? calculationChecks.filter((check) => readOptionalText(check?.yearMonth) === yearMonth)
          : [],
    };
  });
  return {
    authority: authorityView,
    statuses,
    blockers: [],
    sectionErrors: historyUnavailable
      ? [{ section: 'monthCloseHistory', code: 'cashflow_month_close_history_unavailable' }]
      : [],
  };
}

function sheetControlBlockers(sheetFacts) {
  if (!objectValue(sheetFacts)) {
    return [{ code: 'SHEET_FACTS_MISSING', message: '시트 검증값이 없습니다. 시트값을 다시 불러와 주세요.' }];
  }
  const blockers = [];
  if (Array.isArray(sheetFacts.issues) && sheetFacts.issues.length > 0) {
    blockers.push({ code: 'SHEET_VALUE_INVALID', message: '시트의 날짜 또는 금액 형식을 확인해 주세요.', details: sheetFacts.issues });
  }
  const controls = objectValue(sheetFacts.controlTotals);
  const projectionRows = Array.isArray(controls?.projection) ? controls.projection : [];
  const actualRows = Array.isArray(controls?.actual) ? controls.actual : [];
  const rows = [...projectionRows, ...actualRows];
  if (projectionRows.length !== 19 || actualRows.length !== 19) {
    blockers.push({
      code: 'SHEET_CONTROL_TOTAL_INCOMPLETE',
      message: 'Projection/Actual BO control total이 불완전합니다. 시트값을 다시 불러와 주세요.',
    });
  } else if (
    typeof controls?.deposit?.matches !== 'boolean'
    || rows.some((row) => typeof row?.matches !== 'boolean')
  ) {
    blockers.push({
      code: 'SHEET_CONTROL_TOTAL_INVALID',
      message: 'Projection/Actual BO control total 검산값이 올바르지 않습니다. 시트값을 다시 불러와 주세요.',
    });
  }
  return blockers;
}

function sheetControlWarnings(sheetFacts) {
  const controls = objectValue(sheetFacts?.controlTotals);
  const rows = [
    ...(Array.isArray(controls?.projection) ? controls.projection : []),
    ...(Array.isArray(controls?.actual) ? controls.actual : []),
  ];
  const comparableRows = rows.filter((row) => typeof row?.matches === 'boolean');
  const depositComparable = typeof controls?.deposit?.matches === 'boolean';
  return (depositComparable && controls.deposit.matches !== true) || comparableRows.some((row) => row.matches !== true)
    ? [{
      code: 'SHEET_CONTROL_TOTAL_MISMATCH',
      message: '전체 주차 합계와 시트 BO control total이 다릅니다.',
      details: {
        deposit: controls?.deposit || null,
        rows: rows.filter((row) => row?.matches !== true),
      },
    }]
    : [];
}

function monthSheetCalculationBlockers(sheetFacts, yearMonth) {
  const checks = (Array.isArray(sheetFacts?.weeklyCalculationChecks) ? sheetFacts.weeklyCalculationChecks : [])
    .filter((check) => readOptionalText(check?.yearMonth) === yearMonth);
  if (checks.length !== 10) {
    return [{
      code: 'SHEET_CALCULATION_CHECK_MISSING',
      message: '시트 합계·잔액 검산값이 없습니다. 시트값을 다시 불러와 주세요.',
    }];
  }
  const invalid = checks.filter((check) => Object.values(check?.matches || {}).some((match) => match === null));
  if (invalid.length > 0) {
    return [{
      code: 'SHEET_CALCULATION_VALUE_INVALID',
      message: '월 결산 대상의 입금·출금 합계 또는 잔액 값을 확인해 주세요.',
      details: invalid.map((check) => ({ mode: check.mode, weekNo: check.weekNo, sourceCells: check.sourceCells })),
    }];
  }
  return [];
}

function monthSheetCalculationWarnings(sheetFacts, yearMonth) {
  const checks = Array.isArray(sheetFacts?.weeklyCalculationChecks)
    ? sheetFacts.weeklyCalculationChecks.filter((check) => readOptionalText(check?.yearMonth) === yearMonth)
    : [];
  const mismatches = checks.filter((check) => Object.values(check?.matches || {}).some((match) => match === false));
  return mismatches.length === 0 ? [] : [{
    code: 'SHEET_CALCULATION_MISMATCH',
    message: '월 결산 대상의 시트 합계 또는 잔액이 항목 합계와 다릅니다.',
    details: mismatches.map((check) => ({ mode: check.mode, weekNo: check.weekNo, matches: check.matches, sourceCells: check.sourceCells })),
  }];
}

function managementReviewWarnings(checks) {
  return (Array.isArray(checks) ? checks : [])
    .filter((check) => readOptionalText(check?.status).toUpperCase() !== 'OK')
    .map((check) => ({
      code: `MANAGEMENT_CHECK_${readOptionalText(check.id).replaceAll('-', '_').toUpperCase()}`,
      message: readOptionalText(check.title),
      details: {
        status: readOptionalText(check.status),
        detail: readOptionalText(check.detail),
        findings: Array.isArray(check.findings) ? check.findings : [],
      },
    }));
}

function sourceDepositRows(sheetFacts, yearMonth) {
  return (Array.isArray(sheetFacts?.depositScheduleRows) ? sheetFacts.depositScheduleRows : [])
    .filter((row) => readOptionalText(row?.yearMonth) === yearMonth)
    .sort((left, right) => Number(left?.weekNo) - Number(right?.weekNo));
}

function matchingDepositSchedule(sourceRows, draftRows) {
  if (sourceRows.length !== 5 || !Array.isArray(draftRows) || draftRows.length !== 5) return false;
  const sourceByWeek = new Map(sourceRows.map((row) => [Number(row?.weekNo), row]));
  return draftRows.every((row) => {
    const source = sourceByWeek.get(Number(row?.weekNo));
    if (!source) return false;
    const sourceAmount = source.expectedDepositAmount == null ? null : Number(source.expectedDepositAmount);
    const draftAmount = row?.expectedDepositAmount == null ? null : Number(row.expectedDepositAmount);
    return readOptionalText(row?.taxInvoiceIssuedDate) === readOptionalText(source?.taxInvoiceIssuedDate)
      && readOptionalText(row?.expectedDepositDate) === readOptionalText(source?.expectedDepositDate)
      && sourceAmount === draftAmount;
  });
}

async function readDocument(db, path) {
  if (!db?.doc) return null;
  const snapshot = await db.doc(path).get();
  return snapshot.exists ? snapshot.data() || {} : null;
}

function sheetFormulaProjectionActualSummary({ projectId, mirror, comparisonBoundary, yearMonth = '' }) {
  if (readOptionalText(mirror?.status) !== 'FRESH'
    || !readOptionalText(mirror?.sourceRevision)
    || readOptionalText(mirror?.sourceRevision) !== readOptionalText(mirror?.appliedSourceRevision)) return null;
  const rows = (Array.isArray(mirror?.sheetFacts?.projectionActualDifferences)
    ? mirror.sheetFacts.projectionActualDifferences
    : [])
    .map((row) => ({
      yearMonth: readOptionalText(row?.yearMonth),
      weekNo: Number(row?.weekNo),
      amount: Number(row?.amount),
    }))
    .filter((row) => /^20\d{2}-(0[1-9]|1[0-2])$/.test(row.yearMonth)
      && Number.isInteger(row.weekNo) && row.weekNo >= 1 && row.weekNo <= 5
      && Number.isSafeInteger(row.amount));
  const asOf = comparisonBoundary?.asOfWeek;
  const latest = rows
    .filter((row) => row.yearMonth < asOf?.yearMonth
      || (row.yearMonth === asOf?.yearMonth && row.weekNo <= asOf?.weekNo))
    .sort((left, right) => left.yearMonth.localeCompare(right.yearMonth) || left.weekNo - right.weekNo)
    .at(-1);
  if (!latest) return null;
  const requestedMonth = yearMonth || latest.yearMonth;
  const periods = ['MONTH', 'WEEK_1', 'WEEK_2', 'WEEK_3', 'WEEK_4', 'WEEK_5'].map((period) => {
    if (period === 'MONTH') return { period, differenceAmount: latest.amount };
    const weekNo = Number(period.slice(-1));
    const value = rows.find((row) => row.yearMonth === requestedMonth && row.weekNo === weekNo);
    return { period, differenceAmount: value?.amount ?? null };
  });
  const fromMonth = `${readWeeklyYear(mirror.weeklyYear) ?? Number(latest.yearMonth.slice(0, 4))}-01`;
  const settlementMatches = latest.amount === 0;
  return {
    projectId,
    source: 'SHEET_FORMULA',
    sourceRevision: readOptionalText(mirror.sourceRevision),
    fromMonth,
    comparisonAsOfWeek: { yearMonth: latest.yearMonth, weekNo: latest.weekNo },
    differenceAmount: latest.amount,
    settlementDifferenceAmount: latest.amount,
    settlementMatches,
    display: {
      periodLabel: `누적 ${fromMonth}~${latest.yearMonth} ${latest.weekNo}주차`,
      statusLabel: settlementMatches ? '일치 · 100%' : '불일치',
      statusTone: settlementMatches ? 'success' : 'danger',
      differenceLabel: `차액 ${latest.amount.toLocaleString('ko-KR')}원`,
    },
    periods,
  };
}

function storedSheetFormulaProjectionActualSummary({ projectId, mirror, comparisonBoundary, yearMonth = '' }) {
  if (mirror?.projectId !== projectId) return null;
  const rawRows = mirror?.sheetFacts?.projectionActualDifferences;
  if (!Array.isArray(rawRows) || rawRows.length === 0) return null;
  const rows = rawRows.map((row) => {
    const rowYearMonth = row?.yearMonth;
    const rowWeekNo = row?.weekNo;
    const rowAmount = row?.amount;
    if (typeof rowYearMonth !== 'string'
      || rowYearMonth.trim() !== rowYearMonth
      || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(rowYearMonth)
      || typeof rowWeekNo !== 'number'
      || !Number.isInteger(rowWeekNo)
      || rowWeekNo < 1
      || rowWeekNo > 5
      || (rowAmount !== null
        && (typeof rowAmount !== 'number' || !Number.isSafeInteger(rowAmount)))) return null;
    return { yearMonth: rowYearMonth, weekNo: rowWeekNo, amount: rowAmount };
  });
  if (rows.some((row) => !row)) return null;
  const keys = rows.map((row) => `${row.yearMonth}:${row.weekNo}`);
  if (new Set(keys).size !== keys.length) return null;

  const asOf = comparisonBoundary?.asOfWeek;
  const latest = rows
    .filter((row) => row.amount !== null
      && (row.yearMonth < asOf?.yearMonth
        || (row.yearMonth === asOf?.yearMonth && row.weekNo <= asOf?.weekNo)))
    .sort((left, right) => left.yearMonth.localeCompare(right.yearMonth) || left.weekNo - right.weekNo)
    .at(-1);
  if (!latest) return null;
  const requestedMonth = yearMonth || latest.yearMonth;
  const periods = ['MONTH', 'WEEK_1', 'WEEK_2', 'WEEK_3', 'WEEK_4', 'WEEK_5'].map((period) => {
    if (period === 'MONTH') return { period, differenceAmount: latest.amount };
    const weekNo = Number(period.slice(-1));
    const value = rows.find((row) => row.yearMonth === requestedMonth && row.weekNo === weekNo);
    return { period, differenceAmount: value?.amount ?? null };
  });
  const fromMonth = `${latest.yearMonth.slice(0, 4)}-01`;
  const settlementMatches = latest.amount === 0;
  return {
    projectId,
    source: 'SHEET_FORMULA',
    sourceRevision: readOptionalText(mirror.sourceRevision),
    fromMonth,
    comparisonAsOfWeek: { yearMonth: latest.yearMonth, weekNo: latest.weekNo },
    differenceAmount: latest.amount,
    settlementDifferenceAmount: latest.amount,
    settlementMatches,
    display: {
      periodLabel: `누적 ${fromMonth}~${latest.yearMonth} ${latest.weekNo}주차`,
      statusLabel: settlementMatches ? '일치 · 100%' : '불일치',
      statusTone: settlementMatches ? 'success' : 'danger',
      differenceLabel: `차액 ${latest.amount.toLocaleString('ko-KR')}원`,
    },
    periods,
  };
}

function storedMirrorCapturedAt(projectId, mirror) {
  if (mirror?.projectId !== projectId) return null;
  return validJvmInstant(mirror?.capturedAt) ? mirror.capturedAt : null;
}

async function readWeeklyOverviewMirrors({ db, tenantId, projectIds, comparisonBoundary, yearMonth }) {
  if (!db?.doc || typeof db.getAll !== 'function') throw new Error('cashflow mirror batch store unavailable');
  const refs = projectIds.map((projectId) => db.doc(`orgs/${tenantId}/cashflow_sheet_mirrors/${projectId}`));
  const snapshots = await db.getAll(...refs, {
    fieldMask: [
      'projectId',
      'weeklyYear',
      'sourceRevision',
      'capturedAt',
      'sheetFacts.projectionActualDifferences',
    ],
  });
  if (!Array.isArray(snapshots) || snapshots.length !== projectIds.length) {
    throw new Error('cashflow mirror batch response invalid');
  }
  return new Map(projectIds.map((projectId, index) => {
    const snapshot = snapshots[index];
    const mirror = snapshot?.exists ? snapshot.data() || {} : null;
    return [projectId, {
      projectionActualSummary: storedSheetFormulaProjectionActualSummary({
        projectId, mirror, comparisonBoundary, yearMonth,
      }),
      sheetCapturedAt: storedMirrorCapturedAt(projectId, mirror),
    }];
  }));
}

async function readSheetFormulaProjectionActualSummaries({ db, req, projectIds, comparisonBoundary, yearMonth, authMode, workspaceEmailDomain }) {
  const tenantId = readOptionalText(req.context?.tenantId);
  const results = await Promise.all(projectIds.map(async (projectId) => {
    await assertCashflowProjectInScope({ db, req, projectId, authMode, workspaceEmailDomain });
    const mirror = await readDocument(db, `orgs/${tenantId}/cashflow_sheet_mirrors/${projectId}`);
    return sheetFormulaProjectionActualSummary({ projectId, mirror, comparisonBoundary, yearMonth });
  }));
  return {
    version: '2',
    items: results.filter(Boolean),
    errors: projectIds.filter((_projectId, index) => !results[index]).map((projectId) => ({ projectId, code: 'SUMMARY_UNAVAILABLE' })),
  };
}

function annualModeFromStoredDocument(document, mode) {
  const lineAmounts = objectValue(document?.[mode]);
  const lineStates = objectValue(document?.[`${mode}States`]);
  if (!lineAmounts || !lineStates || !CASHFLOW_ALL_LINES.every((lineId) => (
    (lineStates[lineId] === 'EMPTY' && !Object.hasOwn(lineAmounts, lineId))
    || (lineStates[lineId] === 'ZERO' && lineAmounts[lineId] === 0)
    || (lineStates[lineId] === 'VALUE' && Number.isSafeInteger(lineAmounts[lineId]))
  ))) {
    throw createHttpError(
      502,
      '연간 현금흐름에 확인할 수 없는 금액이 있습니다. 시트값을 다시 불러온 뒤 확인해 주세요.',
      'jvm_weekly_cashflow_totals_invalid',
    );
  }
  return {
    lineAmounts,
    lineStates,
    totalIn: null,
    totalOut: null,
    net: null,
  };
}

async function readAnnualTotals({ db, tenantId, projectId, weeklyYear }) {
  if (readWeeklyYear(weeklyYear) === null) return null;
  const years = annualYearsFor(weeklyYear);
  const documents = await Promise.all(years.map((year) => (
    readDocument(db, cashflowAnnualTotalDocPath(tenantId, projectId, year))
      .catch(() => null)
  )));
  return years.flatMap((year, index) => {
    const document = documents[index];
    const identityMatches = document?.projectId === projectId && Number(document?.year) === year;
    const projection = identityMatches ? annualModeFromStoredDocument(document, 'projection') : null;
    const actual = identityMatches ? annualModeFromStoredDocument(document, 'actual') : null;
    return projection && actual ? [{ year, projection, actual }] : [];
  });
}

function validOpeningBalanceMode(mode, selectedYear) {
  if (
    !objectValue(mode)
    || !Number.isSafeInteger(mode.amount)
    || !objectValue(mode.lineAmounts)
    || !Array.isArray(mode.sources)
    || !Array.isArray(mode.includedYears)
    || !Array.isArray(mode.excludedWeeklyYears)
  ) return false;
  const canonicalYears = (years) => years.every((year, index) => (
    Number.isSafeInteger(year)
    && year >= 2000
    && year < selectedYear
    && (index === 0 || years[index - 1] < year)
  ));
  if (
    !canonicalYears(mode.includedYears)
    || !canonicalYears(mode.excludedWeeklyYears)
    || mode.includedYears.some((year) => mode.excludedWeeklyYears.includes(year))
    || mode.sources.length !== mode.includedYears.length
  ) return false;
  const aggregate = {};
  for (let index = 0; index < mode.sources.length; index += 1) {
    const source = objectValue(mode.sources[index]);
    const lineAmounts = objectValue(source?.lineAmounts);
    const lineStates = objectValue(source?.lineStates);
    if (
      !Number.isSafeInteger(source?.year)
      || source.year !== mode.includedYears[index]
      || !lineAmounts
      || !lineStates
      || Object.keys(lineStates).length !== CASHFLOW_ALL_LINES.length
      || !CASHFLOW_ALL_LINES.every((lineId) => Object.hasOwn(lineStates, lineId))
    ) return false;
    const amountLines = [];
    for (const lineId of CASHFLOW_ALL_LINES) {
      const state = readOptionalText(lineStates[lineId]);
      if (!['EMPTY', 'ZERO', 'VALUE'].includes(state)) return false;
      if (state === 'VALUE' || state === 'ZERO') amountLines.push(lineId);
      if (state === 'ZERO' && lineAmounts[lineId] !== 0) return false;
    }
    if (
      Object.keys(lineAmounts).length !== amountLines.length
      || !amountLines.every((lineId) => Number.isSafeInteger(lineAmounts[lineId]))
      || !Object.keys(lineAmounts).every((lineId) => amountLines.includes(lineId))
    ) return false;
    for (const lineId of amountLines) {
      aggregate[lineId] = Number(aggregate[lineId] || 0) + lineAmounts[lineId];
      if (!Number.isSafeInteger(aggregate[lineId])) return false;
    }
  }
  if (
    Object.keys(mode.lineAmounts).length !== Object.keys(aggregate).length
    || !Object.keys(mode.lineAmounts).every((lineId) => (
      CASHFLOW_ALL_LINES.includes(lineId)
      && Number.isSafeInteger(mode.lineAmounts[lineId])
      && mode.lineAmounts[lineId] === aggregate[lineId]
    ))
  ) return false;
  const totalIn = CASHFLOW_IN_LINES.reduce((sum, lineId) => sum + (mode.lineAmounts[lineId] || 0), 0);
  const totalOut = CASHFLOW_OUT_LINES.reduce((sum, lineId) => sum + (mode.lineAmounts[lineId] || 0), 0);
  return Number.isSafeInteger(totalIn) && Number.isSafeInteger(totalOut) && mode.amount === totalIn - totalOut;
}

function requireJvmOpeningBalances(source, yearMonth, {
  statusCode = 502,
  code = 'jvm_weekly_opening_balance_invalid',
} = {}) {
  const openingBalances = objectValue(source?.openingBalances);
  const selectedYear = Number(yearMonth.slice(0, 4));
  if (
    Number(openingBalances?.selectedYear) !== selectedYear
    || !validOpeningBalanceMode(openingBalances?.projection, selectedYear)
    || !validOpeningBalanceMode(openingBalances?.actual, selectedYear)
  ) {
    throw createHttpError(statusCode, 'Cashflow opening balance must preserve every annual source row and state.', code);
  }
  return openingBalances;
}

const JVM_DASHBOARD_PARTIAL_SECTIONS = new Map([
  ['cashflow_declared_weekly_year_unavailable', {
    section: 'cashflow',
    blockerCode: 'CASHFLOW_SOURCE_UNAVAILABLE',
    message: '현금흐름 원장을 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.',
  }],
  ['cashflow_declared_weekly_year_missing', {
    section: 'cashflow',
    blockerCode: 'CASHFLOW_SOURCE_UNAVAILABLE',
    message: '현금흐름 원장을 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.',
  }],
  ['cashflow_ledger_source_unavailable', {
    section: 'cashflow',
    blockerCode: 'CASHFLOW_SOURCE_UNAVAILABLE',
    message: '현금흐름 원장을 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.',
  }],
  ['cashflow_opening_balances_unavailable', {
    section: 'openingBalances',
    blockerCode: 'OPENING_BALANCES_UNAVAILABLE',
    message: '이월 잔액을 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.',
  }],
  ['cashflow_projection_actual_summary_unavailable', {
    section: 'projectionActualSummary',
    blockerCode: null,
    message: null,
    expose: false,
  }],
]);

const JVM_DASHBOARD_AUTHORITY_BLOCKERS = new Map([
  ['CUMULATIVE_CLOSE_AUTHORITY_MISSING', '누적 월 결산 기준과 기존 결산 이력이 맞지 않습니다. AXR 현금흐름 기간·마감 정책에서 복구해 주세요.'],
  ['CUMULATIVE_CLOSE_AUTHORITY_INVALID', '누적 월 결산 기준이 손상되었습니다. AXR 현금흐름 기간·마감 정책에서 복구해 주세요.'],
  ['CUMULATIVE_CLOSE_AUTHORITY_UNAVAILABLE', '누적 월 결산 기준을 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.'],
]);

function readJvmDashboardPartialSections(source) {
  const sectionErrors = [];
  const blockers = [];
  for (const raw of Array.isArray(source?.sectionErrors) ? source.sectionErrors : []) {
    const code = readOptionalText(raw?.code);
    const contract = JVM_DASHBOARD_PARTIAL_SECTIONS.get(code);
    if (!contract || readOptionalText(raw?.section) !== contract.section) continue;
    if (contract.expose === false) continue;
    if (!sectionErrors.some((entry) => entry.section === contract.section && entry.code === code)) {
      sectionErrors.push({ section: contract.section, code });
    }
    if (contract.blockerCode && !blockers.some((entry) => entry.code === contract.blockerCode)) {
      blockers.push({ code: contract.blockerCode, message: contract.message });
    }
  }
  for (const raw of Array.isArray(source?.blockers) ? source.blockers : []) {
    const code = readOptionalText(raw?.code);
    const message = JVM_DASHBOARD_AUTHORITY_BLOCKERS.get(code);
    if (message && !blockers.some((entry) => entry.code === code)) {
      blockers.push({ code, message });
    }
  }
  return {
    sectionErrors,
    blockers,
    unavailableSections: new Set(sectionErrors.map((entry) => entry.section)),
  };
}

function requireReviewedOpeningBalances(value, yearMonth) {
  return requireJvmOpeningBalances({ openingBalances: value }, yearMonth, {
    statusCode: 400,
    code: 'cashflow_opening_balance_invalid',
  });
}

function requireUnchangedReviewedOpeningBalances(reviewed, current) {
  if (stableStringify(reviewed) !== stableStringify(current)) {
    throw createHttpError(
      409,
      '검토 후 전년도 이월 항목이 변경되었습니다. 월 결산 화면을 다시 확인해 주세요.',
      'cashflow_opening_balance_stale',
    );
  }
}

function deadlineSummaryFromCompliance(compliance, comparisonBoundary, weeklyYear) {
  const canonicalWeeklyYear = readWeeklyYear(weeklyYear);
  const items = canonicalWeeklyYear === null ? [] : Array.isArray(compliance?.items) ? compliance.items : [];
  const completedLateCount = items.filter((item) => readOptionalText(item?.status) === 'COMPLETED_LATE').length;
  const indexed = Array(12 * WEEKS_PER_MONTH);
  for (const item of items) {
    const ordinal = weekOrdinal(canonicalWeeklyYear, item?.yearMonth, item?.weekNo);
    if (ordinal !== -1) indexed[ordinal] = item;
  }
  const currentOrdinal = canonicalWeeklyYear === null ? -1 : weekOrdinal(
    canonicalWeeklyYear,
    comparisonBoundary?.asOfWeek?.yearMonth,
    comparisonBoundary?.asOfWeek?.weekNo,
  );
  const currentItem = currentOrdinal === -1 ? null : indexed[currentOrdinal] || null;
  // 조직장 승인 마감은 표시 전용(누적 없음). 실무자 마감(JVM 이 준 deadline) + 13시간.
  const current = currentItem
    ? { ...currentItem, approverDeadline: cashflowWeeklyApproverDeadlineAt(currentItem.deadline) }
    : null;
  return {
    trackingStartedAt: null,
    onTimeCount: Number(compliance?.onTimeCount) || 0,
    missedCount: Number(compliance?.missedCount) || 0,
    completedCount: (Number(compliance?.onTimeCount) || 0) + completedLateCount,
    nextCursor: readOptionalText(compliance?.nextCursor) || null,
    current,
    completedWeeks: items.filter((item) => readOptionalText(item.completedAt)),
    weeklyStatuses: items.map((item) => ({
      yearMonth: item.yearMonth,
      weekNo: item.weekNo,
      status: item.status,
      lockState: readOptionalText(item.lockState) || null,
      deadline: item.deadline,
      approverDeadline: cashflowWeeklyApproverDeadlineAt(item.deadline),
      // 완료 정보는 JVM 이 이미 주는 값이다(CashflowWeeklyComplianceHistoryResponse.Item).
      // 여기서 떨어뜨리면 지난 주차가 "언제 완료했는지" 를 화면이 알 길이 없어진다.
      completedAt: readOptionalText(item.completedAt) || null,
      completedBy: readOptionalText(item.completedBy) || null,
      updateResult: item.updateResult,
      operationId: item.operationId,
      auditId: item.auditId,
    })),
  };
}

async function composeCashflowMonthDashboard({
  db, req, projectId, yearMonth, close, cashflow, openingBalances, comparisonBoundary, weeklyCompliance,
  projectionActualSummary, cumulativeAuthority, monthCloseCalendar, sectionErrors = [], sourceBlockers = [],
  weeklyComplianceBoundary = comparisonBoundary,
}) {
  const closedSnapshot = ['CLOSED', 'REOPEN_REQUESTED'].includes(readOptionalText(close?.status))
    ? objectValue(close?.snapshot) || {}
    : null;
  const snapshotCompatibility = objectValue(close?.snapshotCompatibility) || {
    status: closedSnapshot ? 'LEGACY_EVIDENCE_ONLY' : 'LIVE_CURRENT',
    missingEvidence: closedSnapshot ? ['OPENING_BALANCES', 'LEDGER_WEEKS'] : [],
  };
  const legacyEvidenceOnly = snapshotCompatibility.status === 'LEGACY_EVIDENCE_ONLY';
  const amendedCurrent = snapshotCompatibility.status === 'LIVE_AMENDED';
  const amendmentEvidence = objectValue(close?.lastAmendmentEvidence) || {};
  const tenantId = readOptionalText(req.context?.tenantId);
  const businessDate = readOptionalText(close?.evaluatedBusinessDate);
  const selectedYear = Number(yearMonth.slice(0, 4));
  // 읽기는 두 라운드다. 1: 프로젝트·미러 (서로 독립). 2: 월 상태·연간 문서 (weeklyYear 가
  // 미러에서 나오므로 미러 뒤, 둘은 서로 독립이라 함께). 예전엔 넷을 순차 네 라운드로 읽었다.
  const [projectRead, mirrorRead] = await Promise.all([
    closedSnapshot
      ? Promise.resolve({ available: true, value: null })
      : readDocument(db, `orgs/${tenantId}/projects/${projectId}`)
        .then((value) => ({ available: true, value }))
        .catch(() => ({ available: false, value: null })),
    closedSnapshot && !amendedCurrent
      ? Promise.resolve({ available: true, value: null })
      : readDocument(db, `orgs/${tenantId}/cashflow_sheet_mirrors/${projectId}`)
        .then((value) => ({ available: true, value }))
        .catch(() => ({ available: false, value: null })),
  ]);
  if (!projectRead.available) {
    sectionErrors.push({ section: 'projectMetadata', code: 'cashflow_project_metadata_unavailable' });
  }
  if (!mirrorRead.available) {
    sectionErrors.push({ section: 'sheetMirror', code: 'cashflow_sheet_mirror_unavailable' });
  }
  const projectDocument = projectRead.value;
  const mirror = mirrorRead.value;
  const weeklyYear = closedSnapshot
    ? readWeeklyYear(closedSnapshot.weeklyYear) ?? readWeeklyYear(selectedYear)
    : readWeeklyYear(mirror?.weeklyYear);
  const [monthCloseStatusRead, annualTotals] = await Promise.all([
    readCashflowMonthCloseStatuses({
      db, tenantId, projectId, selectedYear, weeklyYear, cumulativeAuthority, monthCloseCalendar, businessDate,
    }),
    readAnnualTotals({ db, tenantId, projectId, weeklyYear }),
  ]);
  monthCloseStatusRead.sectionErrors.forEach((entry) => {
    if (!sectionErrors.some((current) => current.section === entry.section && current.code === entry.code)) {
      sectionErrors.push(entry);
    }
  });
  const monthCloseStatuses = monthCloseStatusRead.statuses;
  let project;
  let sheetFacts;
  let cells;
  let canonicalSource;
  let confirmations;
  let managementConfirmations;
  let depositScheduleRows;
  let openingBalanceCandidate;
  if (amendedCurrent) {
    project = objectValue(closedSnapshot?.project) || {};
    sheetFacts = objectValue(closedSnapshot?.sheetFacts);
    canonicalSource = objectValue(cashflow?.readModel);
    const monthOrdinal = weeklyYear === null ? -1 : weekOrdinal(weeklyYear, yearMonth, 1);
    const currentMonth = monthOrdinal !== -1
      ? cashflowMonthsByCoordinate(canonicalSource?.months, weeklyYear)[Math.trunc(monthOrdinal / WEEKS_PER_MONTH)]
      : null;
    cells = canonicalMonthCells(currentMonth, yearMonth);
    confirmations = Array.isArray(closedSnapshot?.confirmations) ? closedSnapshot.confirmations : [];
    managementConfirmations = Array.isArray(closedSnapshot?.managementConfirmations) ? closedSnapshot.managementConfirmations : [];
    depositScheduleRows = Array.isArray(closedSnapshot?.depositScheduleRows) ? closedSnapshot.depositScheduleRows : [];
    openingBalanceCandidate = openingBalances;
  } else if (closedSnapshot) {
    project = objectValue(closedSnapshot.project) || {};
    sheetFacts = objectValue(closedSnapshot.sheetFacts);
    canonicalSource = frozenCashflowReadModel(closedSnapshot.ledgerWeeks);
    cells = closeSnapshotCells(closedSnapshot, yearMonth);
    confirmations = Array.isArray(closedSnapshot.confirmations) ? closedSnapshot.confirmations : [];
    managementConfirmations = Array.isArray(closedSnapshot.managementConfirmations) ? closedSnapshot.managementConfirmations : [];
    depositScheduleRows = Array.isArray(closedSnapshot.depositScheduleRows) ? closedSnapshot.depositScheduleRows : [];
    openingBalanceCandidate = objectValue(closedSnapshot.openingBalances);
  } else {
    project = objectValue(projectDocument) || {};
    sheetFacts = objectValue(mirror?.sheetFacts);
    canonicalSource = objectValue(cashflow?.readModel);
    cells = normalizeMonthCloseCells(mirror?.cells, yearMonth);
    confirmations = [];
    managementConfirmations = [];
    depositScheduleRows = sourceDepositRows(sheetFacts, yearMonth);
    openingBalanceCandidate = openingBalances;
  }
  const canonicalReadModel = cashflowReadModelForYear(
    canonicalSource,
    weeklyYear,
  );
  const monthCellsAvailable = Boolean(closedSnapshot || mirror);
  const projectionMode = monthCellsAvailable ? buildMonthModeReadModel(cells, 'projection') : null;
  const actualMode = monthCellsAvailable ? buildMonthModeReadModel(cells, 'actual') : null;
  const projection = dashboardTotals(projectionMode);
  const actual = dashboardTotals(actualMode);
  const difference = differenceTotals(projection, actual);
  const comparison = projectionMode && actualMode
    ? buildCashflowProjectionActualComparison({
      projectId,
      readModel: { months: [{ yearMonth, projection: projectionMode, actual: actualMode }] },
    }, comparisonBoundary).months[0] || null
    : null;
  const sourceRows = sourceDepositRows(sheetFacts, yearMonth);
  const formulaSnapshot = amendedCurrent
    ? amendedSheetFormulaSnapshot(mirror, amendmentEvidence)
    : closedSnapshot
      // 결산된 회차는 미러를 읽지 않는다. 값은 닫힌 스냅샷의 sheetFacts 가 전부이므로 상태도 그것으로 정한다.
      // 예전엔 "미러를 읽었나"로 정해서, 값이 응답에 다 있는데도 화면이 연간 열·총계를 확인 불가로 지웠다.
      ? {
        status: sheetFacts ? 'AVAILABLE' : 'UNAVAILABLE',
        reason: sheetFacts ? null : 'CLOSED_SNAPSHOT_SHEET_FACTS_MISSING',
        sourceRevision: readOptionalText(closedSnapshot.sourceFingerprint) || null,
        targetRevision: readOptionalText(closedSnapshot.targetRevision) || null,
        sheetFacts,
      }
      : {
      status: mirror ? 'AVAILABLE' : 'UNAVAILABLE',
      reason: mirror ? null : mirrorRead.available ? 'SHEET_MIRROR_MISSING' : 'SHEET_MIRROR_UNAVAILABLE',
      sourceRevision: readOptionalText(closedSnapshot?.sourceFingerprint) || readOptionalText(mirror?.sourceRevision) || null,
      targetRevision: readOptionalText(closedSnapshot?.targetRevision) || readOptionalText(mirror?.appliedTargetRevision) || null,
      sheetFacts,
    };
  const formulaSheetFacts = formulaSnapshot.sheetFacts;
  const sheetCalculationChecks = Array.isArray(formulaSheetFacts?.weeklyCalculationChecks)
    ? formulaSheetFacts.weeklyCalculationChecks
    : [];
  const sheetFormulaValues = {
    status: formulaSnapshot.status,
    reason: formulaSnapshot.reason,
    sourceRevision: formulaSnapshot.sourceRevision,
    targetRevision: formulaSnapshot.targetRevision,
    weekly: sheetCalculationChecks.filter((check) => Number(String(check?.yearMonth || '').slice(0, 4)) === selectedYear),
    annual: Array.isArray(formulaSheetFacts?.annualCashflowTotals) ? formulaSheetFacts.annualCashflowTotals : [],
    grandTotals: objectValue(formulaSheetFacts?.cashflowGrandTotals) || {},
    projectionActualDifferences: (Array.isArray(formulaSheetFacts?.projectionActualDifferences)
      ? formulaSheetFacts.projectionActualDifferences
      : []).filter((value) => Number(String(value?.yearMonth || '').slice(0, 4)) === selectedYear),
  };
  const directProjectionActualSummary = sheetFormulaProjectionActualSummary({
    projectId,
    mirror: {
      status: closedSnapshot ? 'FRESH' : mirror?.status,
      sourceRevision: closedSnapshot ? (formulaSnapshot.sourceRevision || 'snapshot') : mirror?.sourceRevision,
      appliedSourceRevision: closedSnapshot ? (formulaSnapshot.sourceRevision || 'snapshot') : mirror?.appliedSourceRevision,
      weeklyYear,
      sheetFacts: formulaSheetFacts,
    },
    comparisonBoundary,
    yearMonth,
  });
  const authoritativeOpeningBalances = openingBalanceCandidate
    ? requireJvmOpeningBalances({ openingBalances: openingBalanceCandidate }, yearMonth)
    : null;
  const canonicalComparison = canonicalReadModel
    ? buildCashflowProjectionActualComparison({ projectId, readModel: canonicalReadModel }, comparisonBoundary)
    : null;
  const canonicalWithComparison = canonicalReadModel ? {
    ...canonicalReadModel,
    weeklyYear,
    annualTotals,
    months: canonicalReadModel.months.map((month, monthIndex) => ({
      ...month,
      comparison: canonicalComparison?.months?.[monthIndex] || null,
    })),
  } : null;
  let managementChecks;
  if (amendedCurrent) {
    managementChecks = buildCashflowManagementChecks({
      project,
      cashflow,
      cells,
      yearMonth,
      depositScheduleRows,
      comparisonBoundary,
      pinnedSheetCells: null,
      projectionOpeningBalance: safeAmount(authoritativeOpeningBalances?.projection?.amount),
      weeklyYear,
      monthState: 'LIVE_AMENDED',
    });
  } else if (closedSnapshot) {
    managementChecks = Array.isArray(closedSnapshot.managementChecks) ? closedSnapshot.managementChecks : [];
  } else {
    managementChecks = buildCashflowManagementChecks({
      project,
      cashflow,
      cells,
      yearMonth,
      depositScheduleRows,
      comparisonBoundary,
      pinnedSheetCells: mirror?.cells,
      projectionOpeningBalance: safeAmount(authoritativeOpeningBalances?.projection?.amount),
      weeklyYear,
      monthState: 'LIVE_CURRENT',
    });
  }
  if (sourceBlockers.some((blocker) => blocker.code === 'OPENING_BALANCES_UNAVAILABLE')) {
    managementChecks = managementChecks.map((check) => check.id === 'negative-projection-balance'
      ? {
        ...check,
        status: 'REVIEW_REQUIRED',
        detail: '이월 잔액을 불러오지 못해 Projection 잔액을 판정할 수 없습니다.',
        findings: ['이월 잔액 확인 필요'],
      }
      : check);
  }
  // 준수 이력을 못 읽었으면 요약을 만들지 않는다. 빈 이력으로 만들면 "지각 0회" 라는
  // 틀린 숫자가 표시된다 - 판정 불능과 "문제 없음" 은 다르다.
  const liveDeadlineSummary = weeklyCompliance === null
    ? null
    : deadlineSummaryFromCompliance(weeklyCompliance, weeklyComplianceBoundary, weeklyYear);
  const deadlineSummary = liveDeadlineSummary === null
    ? null
    : closedSnapshot
      ? {
        ...(objectValue(closedSnapshot.deadlineSummary) || {}),
        completedWeeks: liveDeadlineSummary.completedWeeks,
        weeklyStatuses: liveDeadlineSummary.weeklyStatuses,
      }
      : liveDeadlineSummary;
  const blockers = [];
  for (const blocker of [...monthCloseStatusRead.blockers, ...sourceBlockers]) {
    if (!blockers.some((entry) => entry.code === blocker.code)) blockers.push(blocker);
  }
  if (readOptionalText(close?.status) !== 'OPEN') {
    blockers.push({ code: 'MONTH_NOT_OPEN', message: '결산 또는 재오픈 검토 중인 월은 수정할 수 없습니다.' });
    if (weeklyYear === null) blockers.push({
      code: 'SHEET_SOURCE_REQUIRED',
      message: '시트에서 주별 관리 연도를 확인하지 못했습니다. 표준 양식으로 다시 불러와 주세요.',
    });
  } else {
    if (close?.closeEligible === false) {
      blockers.push({ code: 'MONTH_NOT_ENDED', message: '대상 월이 끝난 뒤 월 결산할 수 있습니다.' });
    }
    if (!projectRead.available) blockers.push({
      code: 'PROJECT_SOURCE_UNAVAILABLE',
      message: '프로젝트 등록 정보를 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.',
    });
    else if (!projectDocument) blockers.push({ code: 'PROJECT_NOT_FOUND', message: '프로젝트 등록 정보를 찾을 수 없습니다.' });
    if (!mirrorRead.available) blockers.push({
      code: 'SHEET_SOURCE_UNAVAILABLE',
      message: '시트 기준값을 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.',
    });
    else if (!mirror) blockers.push({ code: 'SHEET_SOURCE_REQUIRED', message: '먼저 시트값을 불러와 주세요.' });
    else if (weeklyYear === null) blockers.push({
      code: 'SHEET_SOURCE_REQUIRED',
      message: '시트에서 주별 관리 연도를 확인하지 못했습니다. 표준 양식으로 다시 불러와 주세요.',
    });
    else if (mirror.status !== 'FRESH') blockers.push({ code: 'SHEET_SOURCE_STALE', message: '시트값을 다시 불러와 주세요.' });
    else if ((mirror.projectId && mirror.projectId !== projectId) || !mirror.yearMonths?.includes(yearMonth)) {
      blockers.push({ code: 'SHEET_SOURCE_SCOPE_MISMATCH', message: '고정한 시트값의 프로젝트 또는 월이 다릅니다.' });
    } else if (readOptionalText(mirror.appliedSourceRevision) !== readOptionalText(mirror.sourceRevision)) {
      blockers.push({ code: 'SHEET_SOURCE_NOT_APPLIED', message: '불러온 값을 MYSCube 시트에 반영해 주세요.' });
    }
    blockers.push(...sheetControlBlockers(sheetFacts));
    blockers.push(...monthSheetCalculationBlockers(sheetFacts, yearMonth));
    if (!completeMonthCloseCells(cells)) blockers.push({ code: 'SHEET_MONTH_INCOMPLETE', message: `선택한 월의 ${CASHFLOW_MONTH_CELL_COUNT}개 캐시플로우 값을 다시 불러와 주세요.` });
    if (!projectionMode || !actualMode) blockers.push({ code: 'AMOUNT_OUT_OF_RANGE', message: '지원 범위를 넘는 금액이 있습니다.' });
  }
  if (weeklyYear !== null && annualTotals.length !== annualYearsFor(weeklyYear).length) {
    blockers.push({ code: 'SHEET_SOURCE_REQUIRED', message: '먼저 시트값을 불러와 주세요.' });
  }
  const contractAmount = !closedSnapshot && !projectDocument
    ? null
    : Object.hasOwn(project, 'contractAmount')
      ? safeAmount(project.contractAmount)
      : 0;
  if ((closedSnapshot || projectDocument) && contractAmount === null) {
    throw createHttpError(
      502,
      '프로젝트 계약금액을 확인할 수 없습니다. 프로젝트 등록값을 확인한 뒤 다시 시도해 주세요.',
      'jvm_weekly_cashflow_totals_invalid',
    );
  }
  const currentMonthProjectionSalesAndVatTotal = sumSafe([
    Object.hasOwn(projection.rowTotals, 'SALES_IN') ? projection.rowTotals.SALES_IN : 0,
    Object.hasOwn(projection.rowTotals, 'SALES_VAT_IN') ? projection.rowTotals.SALES_VAT_IN : 0,
  ]);
  let projectionComposition;
  if (closedSnapshot && !legacyEvidenceOnly) {
    projectionComposition = {
      totalIn: safeAmount(canonicalWithComparison?.range?.projection?.totalIn),
      salesAndVatTotal: canonicalWithComparison?.range?.projection?.rowTotals
        ? sumSafe([
          Object.hasOwn(canonicalWithComparison.range.projection.rowTotals, 'SALES_IN')
            ? canonicalWithComparison.range.projection.rowTotals.SALES_IN
            : 0,
          Object.hasOwn(canonicalWithComparison.range.projection.rowTotals, 'SALES_VAT_IN')
            ? canonicalWithComparison.range.projection.rowTotals.SALES_VAT_IN
            : 0,
        ])
        : null,
      years: Array.isArray(closedSnapshot.projectionYears) ? closedSnapshot.projectionYears : [],
    };
  } else if (legacyEvidenceOnly) {
    projectionComposition = {
      totalIn: projection.totalIn,
      salesAndVatTotal: currentMonthProjectionSalesAndVatTotal,
      years: [],
    };
  } else {
    projectionComposition = composeProjectionTotal({
      project,
      cashflow,
      annualTotals,
      fallback: {
        totalIn: projection.totalIn,
        salesAndVatTotal: currentMonthProjectionSalesAndVatTotal,
      },
      weeklyYear,
    });
  }
  const projectionTotalIn = safeAmount(projectionComposition.totalIn);
  const projectionSalesAndVatTotal = safeAmount(projectionComposition.salesAndVatTotal);
  const contractDifference = projectionSalesAndVatTotal === null || contractAmount === null
    ? null
    : sumSafe([contractAmount, -projectionSalesAndVatTotal]);
  const projectionProgressPercent = projectionSalesAndVatTotal === null || contractAmount === null
    ? null
    : Math.max(0, contractAmount === 0
      ? 100
      : Math.round((projectionSalesAndVatTotal / contractAmount) * 10_000) / 100);
  const requiredCellConfirmationCount = CASHFLOW_MONTH_CELL_COUNT;
  const requiredManagementConfirmationCount = CASHFLOW_MANAGEMENT_CHECK_IDS.length;
  const confirmationProgressPercent = Math.round(
    Math.min(
      1,
      (validConfirmationKeys(confirmations).size + validManagementConfirmations(managementConfirmations).size)
        / (requiredCellConfirmationCount + requiredManagementConfirmationCount),
    ) * 10_000,
  ) / 100;
  const settlement = settlementProgress(comparison, confirmations, yearMonth, comparisonBoundary);
  const source = closedSnapshot ? {
    kind: amendedCurrent ? 'MONTH_CLOSE_AMENDED_CURRENT' : 'MONTH_CLOSE_SNAPSHOT',
    status: readOptionalText(close?.status),
    sourceRevision: amendedCurrent
      ? readOptionalText(amendmentEvidence.sourceRevision)
      : readOptionalText(closedSnapshot?.sourceFingerprint),
    targetRevision: amendedCurrent
      ? readOptionalText(amendmentEvidence.resultingTargetRevision)
      : readOptionalText(closedSnapshot?.targetRevision),
    capturedAt: amendedCurrent
      ? readOptionalText(close?.lastAmendmentAt)
      : readOptionalText(closedSnapshot?.sourceReadAt),
  } : {
    kind: 'PINNED_MIRROR',
    status: !mirrorRead.available ? 'UNAVAILABLE' : readOptionalText(mirror?.status) || 'EMPTY',
    sourceRevision: readOptionalText(mirror?.sourceRevision),
    targetRevision: readOptionalText(mirror?.targetRevisionAtFetch),
    appliedSourceRevision: readOptionalText(mirror?.appliedSourceRevision),
    appliedTargetRevision: readOptionalText(mirror?.appliedTargetRevision),
    capturedAt: readOptionalText(mirror?.capturedAt),
  };
  const warnings = closedSnapshot ? [] : [
    ...projectSheetWarnings(project, sheetFacts?.metadata),
    ...sheetControlWarnings(sheetFacts),
    ...monthSheetCalculationWarnings(sheetFacts, yearMonth),
    ...managementReviewWarnings(managementChecks),
  ];
  if (legacyEvidenceOnly) {
    warnings.push({
      code: 'LEGACY_CLOSE_EVIDENCE_LIMITED',
      message: '이 결산은 이전 형식으로 저장되어 항목별 전년도 이월 근거와 전체 동결 시트를 확인할 수 없습니다. 재오픈 후 시트값을 다시 반영하고 재결산해 주세요.',
      details: { missingEvidence: snapshotCompatibility.missingEvidence || [] },
    });
  }
  if (contractAmount !== null && projectionSalesAndVatTotal !== null && contractAmount !== projectionSalesAndVatTotal) {
    warnings.push({
      code: 'CONTRACT_PROJECTION_MISMATCH',
      message: `계약금액 ${contractAmount.toLocaleString('ko-KR')}원과 전체 사업기간 Projection 매출·매출부가세 ${projectionSalesAndVatTotal.toLocaleString('ko-KR')}원이 다릅니다.`,
    });
  }
  return {
    source,
    cumulativeCloseAuthority: monthCloseStatusRead.authority,
    cumulativeCloseScope: buildCumulativeCloseScope(
      readOptionalText(close?.cycleYearMonth) || yearMonth,
      closedSnapshot || mirror,
    ),
    project,
    projectMetadata: projectMetadata(project),
    sheetMetadata: sheetFacts?.metadata || {},
    sheetCalculationChecks: sheetFormulaValues.weekly,
    sheetFormulaValues,
    sheetControlTotals: {
      deposit: objectValue(sheetFacts?.controlTotals?.deposit) || null,
      unpaid: objectValue(sheetFacts?.controlTotals?.unpaid) || null,
    },
    sheetDepositScheduleRows: sourceRows,
    depositScheduleRows,
    cells,
    confirmations,
    managementChecks,
    managementConfirmations,
    openingBalances: authoritativeOpeningBalances,
    snapshotCompatibility,
    deadlineSummary,
    projectionActualSummary: directProjectionActualSummary,
    monthCloseStatuses,
    postCloseAdjustment: closedSnapshot ? postCloseAdjustment(close, closedSnapshot) : null,
    draftRevision: null,
    totals: { projection, actual, difference },
    comparison,
    summary: {
      projectionProgressPercent,
      projectionTotalIn,
      projectionSalesAndVatTotal,
      contractDifference,
      contractCoveragePercent: projectionProgressPercent,
      projectionContractAmount: contractAmount,
      projectionYears: projectionComposition.years,
      actualProgressPercent: monthCellsAvailable ? actualWrittenProgressPercent(cells, yearMonth, comparisonBoundary) : null,
      confirmationProgressPercent: monthCellsAvailable ? confirmationProgressPercent : null,
      settlementProgressPercent: comparison ? settlement.percent : null,
      settlementDifferenceAmount: directProjectionActualSummary?.settlementDifferenceAmount ?? null,
      settlementMatches: directProjectionActualSummary?.settlementMatches ?? null,
      settlementCompletedWeekCount: settlement.completed,
      settlementTargetWeekCount: settlement.total,
      settlementIncompleteWeeks: settlement.incompleteWeeks,
      comparisonMatches: settlement.total > 0 && settlement.incompleteWeeks.length === 0,
      comparisonAsOfDate: comparisonBoundary.asOfDate,
      comparisonAsOfWeek: comparisonBoundary.asOfWeek,
      evaluatedBusinessDate: readOptionalText(close?.evaluatedBusinessDate) || null,
      cycleYearMonth: readOptionalText(close?.cycleYearMonth) || yearMonth,
      targetYearMonth: readOptionalText(close?.targetYearMonth)
        || buildCumulativeCloseScope(readOptionalText(close?.cycleYearMonth) || yearMonth).throughMonth,
      closeDeadline: readOptionalText(close?.closeDeadline) || null,
      closeDeadlineAt: readOptionalText(close?.closeDeadlineAt) || null,
      approverDeadlineAt: readOptionalText(close?.approverDeadlineAt) || null,
      late: Boolean(close?.late),
    },
    validation: {
      canClose: readOptionalText(close?.status) === 'OPEN' && blockers.length === 0,
      blockers,
      warnings,
    },
    canonical: canonicalWithComparison,
  };
}

async function composeCashflowMonthCloseBody({
  db,
  req,
  projectId,
  cashflow,
  openingBalances,
  comparisonBoundary,
  weeklyCompliance,
  monthCloseTargetYearMonth,
}) {
  const tenantId = readOptionalText(req.context?.tenantId);
  const requested = commandBody(req);
  const yearMonth = monthCloseTargetYearMonth;
  const expectedRevision = Number(requested.expectedRevision);
  const closeInput = objectValue(requested.closeInput);
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw createHttpError(400, 'Cashflow month close scope is invalid.', 'cashflow_month_close_request_invalid');
  }
  if (!closeInput || readOptionalText(closeInput.yearMonth) !== yearMonth) {
    throw createHttpError(400, 'Cashflow month close review input is required.', 'cashflow_month_close_request_invalid');
  }
  if (closeInput.humanReviewed !== true) {
    throw createHttpError(409, '시트값과 결산 항목을 직접 확인한 뒤 결산해 주세요.', 'cashflow_month_close_human_review_required');
  }
  if (!db?.doc) {
    throw createHttpError(503, '월 결산 자료를 보관하는 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.', 'cashflow_month_close_source_unavailable');
  }

  const [mirrorSnap, projectSnap] = await Promise.all([
    db.doc(`orgs/${tenantId}/cashflow_sheet_mirrors/${projectId}`).get(),
    db.doc(`orgs/${tenantId}/projects/${projectId}`).get(),
  ]);
  const mirror = mirrorSnap.exists ? mirrorSnap.data() || {} : null;
  const project = projectSnap.exists ? projectSnap.data() || {} : {};
  const normalizedCells = normalizeMonthCloseCells(closeInput.cells, yearMonth);
  if (!completeMonthCloseCells(normalizedCells)) {
    throw createHttpError(409, `월 결산 대상 ${CASHFLOW_MONTH_CELL_COUNT}개 캐시플로우 값을 다시 확인해 주세요.`, 'cashflow_month_close_cells_incomplete');
  }
  const sourceWarnings = [];
  if (!mirror) {
    sourceWarnings.push({ code: 'SHEET_SOURCE_REQUIRED', message: '먼저 시트값을 불러와 주세요.' });
  } else {
    if (mirror.status !== 'FRESH') {
      sourceWarnings.push({ code: 'SHEET_SOURCE_STALE', message: '시트값을 다시 불러와 주세요.' });
    }
    if ((mirror.projectId && mirror.projectId !== projectId) || !mirror.yearMonths?.includes(yearMonth)) {
      sourceWarnings.push({ code: 'SHEET_SOURCE_SCOPE_MISMATCH', message: '고정한 시트값의 프로젝트 또는 월이 다릅니다.' });
    }
    if (
      readOptionalText(mirror.sourceRevision) !== readOptionalText(closeInput.sourceRevision)
      || readOptionalText(mirror.targetRevisionAtFetch) !== readOptionalText(closeInput.targetRevision)
    ) {
      sourceWarnings.push({
        code: 'SHEET_SOURCE_REVISION_MISMATCH',
        message: '요청에서 확인한 시트 버전과 현재 고정된 시트 버전이 다릅니다.',
        details: {
          requestedSourceRevision: readOptionalText(closeInput.sourceRevision),
          requestedTargetRevision: readOptionalText(closeInput.targetRevision),
          currentSourceRevision: readOptionalText(mirror.sourceRevision),
          currentTargetRevision: readOptionalText(mirror.targetRevisionAtFetch),
        },
      });
    }
    if (readOptionalText(mirror.appliedSourceRevision) !== readOptionalText(mirror.sourceRevision)) {
      sourceWarnings.push({ code: 'SHEET_SOURCE_NOT_APPLIED', message: '불러온 값을 MYSCube 시트에 반영해 주세요.' });
    }
  }
  const sheetBlockers = mirror ? [
    ...sheetControlBlockers(mirror.sheetFacts),
    ...monthSheetCalculationBlockers(mirror.sheetFacts, yearMonth),
  ] : [];
  const depositWarnings = mirror?.sheetFacts
    && !matchingDepositSchedule(sourceDepositRows(mirror.sheetFacts, yearMonth), closeInput.depositScheduleRows)
    ? [{
      code: 'SHEET_DEPOSIT_SCHEDULE_MISMATCH',
      message: '시트 입금 일정과 요청에서 확인한 입금 일정이 다릅니다.',
      details: {
        sourceRows: sourceDepositRows(mirror.sheetFacts, yearMonth),
        requestedRows: Array.isArray(closeInput.depositScheduleRows) ? closeInput.depositScheduleRows : [],
      },
    }]
    : [];
  const managementChecks = buildCashflowManagementChecks({
    project,
    cashflow,
    cells: normalizedCells,
    yearMonth,
    depositScheduleRows: closeInput.depositScheduleRows,
    comparisonBoundary,
    pinnedSheetCells: mirror?.cells,
    projectionOpeningBalance: safeAmount(openingBalances?.projection?.amount),
    weeklyYear: readWeeklyYear(mirror?.weeklyYear),
    monthState: 'LIVE_CURRENT',
  });
  const managementWarnings = matchingManagementChecks(managementChecks, closeInput.managementChecks) ? [] : [{
    code: 'MANAGEMENT_CHECKS_STALE',
    message: '요청에서 확인한 주요 관리 항목 판정과 현재 판정이 다릅니다.',
    details: { requested: closeInput.managementChecks || [], authoritative: managementChecks },
  }];
  if (!completeMonthCloseConfirmations(closeInput.confirmations)) {
    throw createHttpError(409, `월 결산 대상 ${CASHFLOW_MONTH_CELL_COUNT}개 항목을 모두 확인해 주세요.`, 'cashflow_month_close_confirmations_incomplete');
  }
  const deadlineSummary = deadlineSummaryFromCompliance(
    weeklyCompliance,
    comparisonBoundary,
    readWeeklyYear(mirror?.weeklyYear),
  );

  const reviewWarnings = [
    ...sourceWarnings,
    ...sheetBlockers,
    ...depositWarnings,
    ...managementWarnings,
    ...sheetControlWarnings(mirror?.sheetFacts),
    ...monthSheetCalculationWarnings(mirror?.sheetFacts, yearMonth),
    ...managementReviewWarnings(managementChecks),
  ];
  return {
    closeBody: {
      idempotencyKey: requested.idempotencyKey,
      yearMonth,
      expectedRevision,
      expectedDraftRevision: 0,
      humanReviewed: true,
      sourceRevision: closeInput.sourceRevision,
      targetRevision: closeInput.targetRevision,
      depositScheduleRows: closeInput.depositScheduleRows,
      cells: normalizedCells,
      confirmations: closeInput.confirmations,
      managementChecks,
      managementConfirmations: [...validManagementConfirmations(closeInput.managementConfirmations).values()],
      openingBalances,
      deadlineSummary: {
        trackingStartedAt: deadlineSummary.trackingStartedAt,
        missedCount: deadlineSummary.missedCount,
        completedCount: deadlineSummary.completedCount,
        current: deadlineSummary.current,
      },
    },
    reviewWarnings,
    monthSnapshot: buildCashflowMonthCloseMonthSnapshot({
      projectId,
      yearMonth,
      cells: normalizedCells,
      sourceRevision: closeInput.sourceRevision,
      targetRevision: closeInput.targetRevision,
      capturedAt: readOptionalText(mirror?.capturedAt) || null,
      spreadsheetId: readOptionalText(mirror?.spreadsheetId) || null,
      spreadsheetTitle: readOptionalText(mirror?.spreadsheetTitle) || null,
      selectedSheetName: readOptionalText(mirror?.selectedSheetName) || null,
    }),
  };
}

function createJavaMutatingProxyRoute(routeHandler) {
  return asyncHandler(async (req, res) => {
    const result = await routeHandler(req, res);
    const status = result?.status ?? 200;
    const body = result?.body ?? null;
    res.status(status).json(body);
  });
}

function assertWeeklyWorkspaceOrRoleAllowed(req, allowedRoles, action, authMode, workspaceEmailDomain) {
  if (isWorkspaceAuthMode(authMode) && isWorkspaceUser(req.context, workspaceEmailDomain)) return;
  assertActorRoleAllowed(req, allowedRoles, action);
}

export function mountJvmWeeklyApiRoutes(app, {
  db,
  env = process.env,
  fetchImpl = globalThis.fetch,
  jvmWeeklyApiBaseUrl,
  jvmWeeklyApiServiceToken,
  jvmWeeklyApiIdTokenAudience,
  jvmWeeklyApiServiceAccountJson,
  jvmWeeklyApiIdentityTokenResolver,
  jvmWeeklyAuthMode,
  jvmWeeklyWorkspaceEmailDomain,
  jvmWeeklyFirestoreProjectId,
  jvmWeeklyApiTimeoutMs,
  cashflowMonthCloseRouteTimeoutMs,
  performanceLogger,
  performanceNow,
  cashflowSlackService,
  mcpOAuthService,
  now = () => new Date(),
} = {}) {
  const baseUrl = resolveJavaWeeklyApiBaseUrl({ jvmWeeklyApiBaseUrl }, env);
  const serviceToken = resolveJavaWeeklyApiServiceToken({ jvmWeeklyApiServiceToken }, env);
  const idTokenAudience = resolveJavaWeeklyApiIdTokenAudience({ jvmWeeklyApiIdTokenAudience }, env);
  const serviceAccountJson = resolveJavaWeeklyApiServiceAccountJson({ jvmWeeklyApiServiceAccountJson }, env);
  const authMode = resolveJavaWeeklyAuthMode({ jvmWeeklyAuthMode }, env);
  const workspaceEmailDomain = resolveJavaWeeklyWorkspaceEmailDomain({ jvmWeeklyWorkspaceEmailDomain }, env);
  const firestoreProjectId = resolveJavaWeeklyFirestoreProjectId({ jvmWeeklyFirestoreProjectId }, env);
  const bffDataProjectId = resolveBffDataProjectId(env);
  const weeklyExpenseEditLeasesEnabled = readOptionalText(env.BFF_EDIT_LEASES_ENABLED).toLowerCase() === 'true';
  const monthCloseRouteTimeoutMs = Number.isFinite(Number(cashflowMonthCloseRouteTimeoutMs))
    && Number(cashflowMonthCloseRouteTimeoutMs) > 0
    ? Math.min(Number(cashflowMonthCloseRouteTimeoutMs), CASHFLOW_MONTH_CLOSE_ROUTE_TIMEOUT_MS)
    : CASHFLOW_MONTH_CLOSE_ROUTE_TIMEOUT_MS;

  function notifyCashflowSlack(payload) {
    if (!cashflowSlackService?.enabled || typeof cashflowSlackService.notifyMessage !== 'function') return;
    const message = typeof payload === 'string' ? { text: payload } : payload;
    void Promise.resolve().then(() => cashflowSlackService.notifyMessage(message)).catch(() => {});
  }

  function notifyCashflowMonthCloseSlack({ tenantId, record, event }) {
    void Promise.resolve().then(async () => {
      const [projectSnapshot, parties] = await Promise.all([
        db.doc(`orgs/${tenantId}/projects/${record.projectId}`).get(),
        readCashflowRequestPartyNames({ db, tenantId, record }),
      ]);
      const project = projectSnapshot.exists ? projectSnapshot.data() || {} : {};
      const projectName = readOptionalText(project.name)
        || readOptionalText(project.officialContractName)
        || readOptionalText(project.projectCode)
        || record.projectId;
      const person = event === 'APPROVED' ? parties.reviewedByName : parties.requestedByName;
      const personLabel = event === 'APPROVED' ? '승인자' : '요청자';
      const title = event === 'APPROVED' ? '월 결산 승인 완료' : '월 결산 요청';
      const actionLabel = event === 'APPROVED' ? '결재 결과 보기' : '결재 확인하기';
      const approver = parties.approverSlackUserId
        ? `<@${parties.approverSlackUserId}>`
        : parties.approverName || '미지정';
      const url = 'https://myscube.myscguard.app/cashflow/weekly';
      const lines = [
        `*[MYSCube] ${title}*`,
        `프로젝트명: ${projectName}`,
        `대상 월: ${record.yearMonth}`,
        `${personLabel}: ${person || '미확인'}`,
        `조직장: ${approver}`,
        `상태: ${event === 'APPROVED' ? '승인 완료 · 월 잠금 활성화' : '조직장 승인 대기'}`,
      ];
      notifyCashflowSlack({
        text: `[MYSCube] ${title}: ${projectName} · ${record.yearMonth}`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
          { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: actionLabel }, url, action_id: 'cashflow_month_close_open' }] },
        ],
      });
    }).catch(() => {});
  }

  async function readWeeklyCompliance(context, projectId, { limit = 100, cursor = '' } = {}) {
    const query = `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const response = await proxyJavaWeeklyRequest({
      context,
      method: 'GET',
      path: `/api/v1/cashflow/${encodeURIComponent(projectId)}/weekly-update-compliance?${query}`,
    });
    const result = objectValue(response?.weeklyCompliance) || response;
    if (!Array.isArray(result?.items)
      || !Number.isSafeInteger(Number(result?.onTimeCount))
      || !Number.isSafeInteger(Number(result?.missedCount))) {
      throw createHttpError(502, 'JVM 주간 정산 이력을 확인할 수 없습니다.', 'jvm_weekly_response_invalid');
    }
    // 라벨은 여기서 한 번만. 화면이 자기 표를 들고 있으면 대시보드와 어긋난다 (기한 지남 vs 기한 경과·미준수).
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        statusLabel: cashflowWeeklyStatusLabel(readOptionalText(item?.status), true),
      })),
    };
  }
  const javaWeeklyClient = createJavaWeeklyClient({
    env,
    fetchImpl,
    jvmWeeklyApiBaseUrl: baseUrl,
    jvmWeeklyApiServiceToken: serviceToken,
    jvmWeeklyApiIdTokenAudience: idTokenAudience,
    jvmWeeklyApiServiceAccountJson: serviceAccountJson,
    jvmWeeklyApiIdentityTokenResolver,
    jvmWeeklyAuthMode: authMode,
    jvmWeeklyWorkspaceEmailDomain: workspaceEmailDomain,
    jvmWeeklyFirestoreProjectId: firestoreProjectId,
    jvmWeeklyApiTimeoutMs,
    performanceLogger,
    performanceNow,
  });

  function proxyJavaWeeklyRequest(options) {
    return javaWeeklyClient.requestJson(options);
  }

  async function readCanonicalCashflowMonthReopenAuthority(req, projectId) {
    return assertCashflowMonthReopenAuthorityResult(
      await proxyJavaWeeklyRequest({
        context: req.context,
        method: 'GET',
        command: 'cashflowMonth.readReopenAuthority',
        path: `/api/v1/cashflow/${encodeURIComponent(projectId)}/month-close/reopen-authority`,
      }),
      projectId,
    );
  }

  function requireAvailableCashflowMonthReopenAuthority(authority) {
    if (authority.availability === 'UNAVAILABLE') {
      throw createHttpError(
        503,
        '재오픈 권한을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',
        'cashflow_month_reopen_authority_unavailable',
      );
    }
    return authority;
  }

  function assertAlignedCashflowMutation() {
    assertCashflowMutationRuntime({ bffDataProjectId, jvmWeeklyFirestoreProjectId: firestoreProjectId }, env);
  }

  async function proxyMutation(req, path, body, {
    cashflowWrite = false,
    requireWeeklyExpenseLease = false,
    deadlineAtMs,
  } = {}) {
    let editSession;
    let dataProjectId;
    if (cashflowWrite) {
      assertAlignedCashflowMutation();
      if (requireWeeklyExpenseLease) {
        if (!weeklyExpenseEditLeasesEnabled) {
          throw createHttpError(503, '현재 환경에서는 주간 비용을 저장할 수 없습니다. 담당자에게 문의해 주세요.', 'cashflow_edit_leases_disabled');
        }
        editSession = readWeeklyExpenseEditSession(req);
      }
      dataProjectId = bffDataProjectId;
    }
    return proxyJavaWeeklyRequest({
      context: req.context,
      method: 'POST',
      path,
      body,
      editSession,
      dataProjectId,
      deadlineAtMs,
    });
  }

  app.get('/api/v1/weekly-expenses/:projectId/sheets', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.readCore, 'read weekly expense sheets', authMode, workspaceEmailDomain);
    const projectId = encodeURIComponent(readOptionalText(req.params.projectId));
    const result = await proxyJavaWeeklyRequest({
      context: req.context,
      method: 'GET',
      path: `/api/v1/weekly-expenses/${projectId}/sheets`,
    });
    res.status(200).json(result);
  }));

  app.get('/api/v1/weekly-expenses/:projectId/sheets/:sheetKey', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.readCore, 'read weekly expense sheet', authMode, workspaceEmailDomain);
    const projectId = encodeURIComponent(readOptionalText(req.params.projectId));
    const sheetKey = encodeURIComponent(readOptionalText(req.params.sheetKey));
    const result = await proxyJavaWeeklyRequest({
      context: req.context,
      method: 'GET',
      path: `/api/v1/weekly-expenses/${projectId}/sheets/${sheetKey}`,
    });
    res.status(200).json(result);
  }));

  app.post('/api/v1/weekly-expenses/:projectId/sheets/:sheetKey/save-draft', createJavaMutatingProxyRoute(async (req) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.writeCore, 'save weekly expense draft', authMode, workspaceEmailDomain);
    const projectId = encodeURIComponent(readOptionalText(req.params.projectId));
    const sheetKey = encodeURIComponent(readOptionalText(req.params.sheetKey));
    const result = await proxyMutation(
      req,
      `/api/v1/weekly-expenses/${projectId}/sheets/${sheetKey}/save-draft`,
      commandBody(req),
      { cashflowWrite: true, requireWeeklyExpenseLease: true },
    );
    return { status: 200, body: result };
  }));

  app.post('/api/v1/weekly-expenses/:projectId/bank-statements/import-batch', createJavaMutatingProxyRoute(async (req) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.writeCore, 'import weekly expense bank statement batch', authMode, workspaceEmailDomain);
    const projectId = encodeURIComponent(readOptionalText(req.params.projectId));
    const result = await proxyMutation(
      req,
      `/api/v1/weekly-expenses/${projectId}/bank-statements/import-batch`,
      commandBody(req),
      { cashflowWrite: true, requireWeeklyExpenseLease: true },
    );
    return { status: 200, body: result };
  }));

  app.get('/api/v1/weekly-expenses/:projectId/bank-statements/import-lines', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.readCore, 'read weekly expense bank statement import lines', authMode, workspaceEmailDomain);
    const projectId = encodeURIComponent(readOptionalText(req.params.projectId));
    const status = readOptionalText(req.query.status);
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    const result = await proxyJavaWeeklyRequest({
      context: req.context,
      method: 'GET',
      path: `/api/v1/weekly-expenses/${projectId}/bank-statements/import-lines${query}`,
    });
    res.status(200).json(result);
  }));

  app.post('/api/v1/weekly-expenses/:projectId/bank-statements/apply-items', createJavaMutatingProxyRoute(async (req) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.writeCore, 'apply weekly expense bank statement items', authMode, workspaceEmailDomain);
    const projectId = encodeURIComponent(readOptionalText(req.params.projectId));
    const result = await proxyMutation(
      req,
      `/api/v1/weekly-expenses/${projectId}/bank-statements/apply-items`,
      commandBody(req),
      { cashflowWrite: true, requireWeeklyExpenseLease: true },
    );
    return { status: 200, body: result };
  }));

  for (const command of ['cell-patch', 'copy', 'paste', 'cut', 'row-insert', 'row-delete']) {
    app.post(`/api/v1/weekly-expenses/:projectId/sheets/:sheetKey/commands/${command}`, createJavaMutatingProxyRoute(async (req) => {
      assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.writeCore, `run weekly expense ${command}`, authMode, workspaceEmailDomain);
      const projectId = encodeURIComponent(readOptionalText(req.params.projectId));
      const sheetKey = encodeURIComponent(readOptionalText(req.params.sheetKey));
      const result = await proxyMutation(
        req,
        `/api/v1/weekly-expenses/${projectId}/sheets/${sheetKey}/commands/${command}`,
        commandBody(req),
        { cashflowWrite: true, requireWeeklyExpenseLease: true },
      );
      return { status: 200, body: result };
    }));
  }

  app.post('/api/v1/weekly-expenses/:projectId/submit', asyncHandler(async (req) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.writeCore, 'submit weekly expense week', authMode, workspaceEmailDomain);
    throw createHttpError(
      410,
      '주차 제출은 더 이상 사용하지 않습니다. 프로젝트별 월 결산을 이용해 주세요.',
      'weekly_close_disabled_use_month_close',
    );
  }));

  app.post('/api/v1/weekly-expenses/:projectId/close', asyncHandler(async (req) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ['admin', 'finance'], 'close weekly expense week', authMode, workspaceEmailDomain);
    throw createHttpError(
      410,
      '주차 결산은 더 이상 사용하지 않습니다. 프로젝트별 월 결산을 이용해 주세요.',
      'weekly_close_disabled_use_month_close',
    );
  }));

  app.post('/api/v1/weekly-expenses/:projectId/audit-export', createJavaMutatingProxyRoute(async (req) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ['admin', 'finance'], 'create weekly expense audit export', authMode, workspaceEmailDomain);
    const projectId = encodeURIComponent(readOptionalText(req.params.projectId));
    const result = await proxyMutation(req, `/api/v1/weekly-expenses/${projectId}/audit-export`, commandBody(req));
    return { status: 200, body: result };
  }));

  app.post('/api/v1/cashflow/:projectId/projection', asyncHandler(async (_req, _res) => {
    throw createHttpError(
      410,
      'Projection 직접 입력은 사용하지 않습니다. 시트 값 불러오기로 반영해 주세요.',
      'cashflow_projection_sheet_import_only',
    );
  }));

  app.post('/api/v1/cashflow-metadata/:projectId/variance', createJavaMutatingProxyRoute(async (req) => {
    assertWeeklyWorkspaceOrRoleAllowed(
      req,
      ['admin', 'finance', 'pm'],
      'update cashflow variance metadata',
      authMode,
      workspaceEmailDomain,
    );
    const projectId = encodeURIComponent(readOptionalText(req.params.projectId));
    const result = await proxyMutation(
      req,
      `/api/v1/cashflow/${projectId}/variance`,
      commandBody(req),
      { cashflowWrite: true },
    );
    return { status: 200, body: result };
  }));

  app.get('/api/v1/cashflow/:projectId/activity', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.readCore, 'read cashflow activity', authMode, workspaceEmailDomain);
    const projectId = readOptionalText(req.params.projectId);
    const source = readOptionalText(req.query.source);
    if (source && !['legacy', 'sheet_refresh', 'audit'].includes(source)) {
      throw createHttpError(400, '활동 기록 조회 출처가 올바르지 않습니다.', 'cashflow_activity_source_invalid');
    }
    const limit = req.query.limit === undefined ? CASHFLOW_ACTIVITY_DEFAULT_LIMIT : Number(req.query.limit);
    const cursor = readOptionalText(req.query.cursor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CASHFLOW_ACTIVITY_DEFAULT_LIMIT) {
      throw cashflowActivityQueryInvalid();
    }
    const boundaries = decodeCashflowActivityCursor(cursor, projectId, source);
    const requestId = req.context?.requestId || req.requestId || 'unknown';
    const activity = await readCashflowActivity(db, readOptionalText(req.context?.tenantId), projectId, {
      source,
      limit,
      boundaries,
      performanceNow,
      onSourceMetric: (metric) => emitCashflowActivityMetric(performanceLogger, {
        severity: metric.outcome === 'error' ? 'WARNING' : 'INFO',
        message: 'cashflow.performance',
        requestId,
        operation: 'cashflow.activity.read',
        phase: 'activity_source_read',
        ...metric,
      }),
    });
    const selectedSources = source ? [source] : CASHFLOW_ACTIVITY_SOURCES;
    const hasNextPage = selectedSources.some((sourceName) => activity.boundaries[sourceName]?.done === false);
    res.status(200).json({
      projectId,
      ...(source ? { source } : {}),
      events: activity.events,
      errors: activity.errors,
      nextCursor: hasNextPage
        ? encodeCashflowActivityCursor(projectId, source, activity.boundaries)
        : null,
    });
  }));

  app.get('/api/v1/cashflow/:projectId/applied-cell-changes', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.readCore, 'read applied cashflow cell changes', authMode, workspaceEmailDomain);
    const projectId = readOptionalText(req.params.projectId);
    if (!projectId || !readOptionalText(req.context?.tenantId)) {
      throw createHttpError(400, '프로젝트와 워크스페이스를 확인해 주세요.', 'cashflow_applied_cell_changes_context_invalid');
    }
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    const cursor = readOptionalText(req.query.cursor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || cursor.length > 512) {
      throw createHttpError(400, '실제 반영 이력 조회 범위가 올바르지 않습니다.', 'cashflow_applied_cell_changes_query_invalid');
    }
    const query = `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const result = await proxyJavaWeeklyRequest({
      context: req.context,
      method: 'GET',
      path: `/api/v1/cashflow/${encodeURIComponent(projectId)}/applied-cell-changes?${query}`,
    });
    res.status(200).json(result);
  }));

  app.get('/api/v1/cashflow/:projectId/month-close', asyncHandler(async (req, res) => {
    const trace = createCashflowPerformanceTrace({
      requestId: req.context?.requestId || req.requestId,
      operation: 'cashflow.month_close.read',
      ...(performanceLogger ? { logger: performanceLogger } : {}),
      ...(performanceNow ? { now: performanceNow } : {}),
    });
    const body = await withCashflowMonthCloseDeadline(async () => {
      assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.readCore, 'read cashflow month close', authMode, workspaceEmailDomain);
      const rawProjectId = readOptionalText(req.params.projectId);
      const projectId = encodeURIComponent(rawProjectId);
      const yearMonth = readOptionalText(req.query.yearMonth);
      if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth)) {
        throw createHttpError(400, 'Cashflow month close yearMonth must use YYYY-MM.', 'cashflow_month_close_request_invalid');
      }
      const historical = isHistoricalCashflowSettlementCycle(yearMonth);
      await assertCashflowProjectInScope({ db, req, projectId: rawProjectId, authMode, workspaceEmailDomain });
      cumulativeCloseMonths(yearMonth);
      const currentNow = now();
      const localComparisonBoundary = {
        ...resolveCashflowComparisonAsOf('', currentNow),
        asOfMs: currentNow.getTime(),
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const traceAttempt = attempt + 1;
        // 세 읽기는 서로 독립이라 함께 출발한다. 직렬이던 시절에는 왕복 지연이
        // 세 번 겹겹이 쌓였다. publication 은 어차피 대시보드 읽기 뒤(after)에
        // 한 번 더 확인해 변경 여부를 판정하므로, before 를 병렬로 시작해도
        // 읽기 일관성 계약은 그 fingerprint 비교가 그대로 지킨다.
        // 본체는 jvm_dashboard 하나다. publication(시트 반영 배너)과 compliance(주간 준수
        // 이력)는 독립 부가 조회라서, 실패하면 그 섹션만 비우고 화면은 그린다. 부가 조회
        // 실패가 대시보드 전체를 503 으로 만들면 한 하위 시스템 장애가 전 프로젝트 화면을
        // 동시에 죽인다 - 실제로 그렇게 죽었다. 확정(쓰기) 경로는 이 열화를 쓰지 않고
        // 전부 fail-closed 를 유지한다.
        const sectionErrors = [];
        const [publicationBefore, rawSource, weeklyCompliance, approverLockRead, actionAccess] = await Promise.all([
          trace.measure(
            'publication_before',
            () => readCashflowSheetPublicationState({
              db,
              tenantId: req.context.tenantId,
              projectId: rawProjectId,
              nowMs: currentNow.getTime(),
            }).catch((error) => {
              sectionErrors.push(sectionUnavailable('sheetPublication', 'sheet_publication_state_unavailable', error));
              return { blocked: false, fingerprint: null, unavailable: true };
            }),
            { attempt: traceAttempt },
          ),
          trace.measure(
            'jvm_dashboard',
            () => proxyJavaWeeklyRequest({
              context: req.context,
              method: 'GET',
              path: `/api/v1/cashflow/${projectId}/month-close/dashboard-source?yearMonth=${encodeURIComponent(yearMonth)}${historical ? '' : '&settlementCycle=true'}`,
              // 이 읽기는 아래 publication fingerprint 재시도로만 다시 실행한다.
              // 전송 timeout 재시도까지 겹치면 같은 무거운 JVM 읽기가 동시 두 번 돈다.
              retry: false,
            }),
            { attempt: traceAttempt },
          ),
          trace.measure(
            'jvm_compliance',
            () => readWeeklyCompliance(req.context, rawProjectId).catch((error) => {
              sectionErrors.push(sectionUnavailable('deadlineSummary', 'weekly_compliance_unavailable', error));
              return null;
            }),
            { attempt: traceAttempt },
          ),
          readCashflowProjectApproverLock({
            db,
            tenantId: req.context.tenantId,
            projectId: rawProjectId,
          }).then((locked) => ({ available: true, locked })).catch((error) => {
            sectionErrors.push(sectionUnavailable('monthCloseApproverLock', 'cashflow_month_close_approver_lock_unavailable', error));
            return { available: false, locked: true };
          }),
          assertCashflowMonthActionAccess({
            db, req, projectId: rawProjectId, authMode, workspaceEmailDomain,
          }).then(() => ({ available: true, allowed: true })).catch((error) => {
            if (!['cashflow_month_close_member_inactive', 'cashflow_project_forbidden'].includes(readOptionalText(error?.code))) {
              sectionErrors.push(sectionUnavailable('monthCloseActionAccess', 'cashflow_month_close_action_access_unavailable', error));
              return { available: false, allowed: false };
            }
            return { available: true, allowed: false };
          }),
        ]);
        let source = rawSource;
        let settlementCycleContext;
        if (historical) {
          const historicalCycle = buildHistoricalCashflowSettlementCycle(source?.settlementStatuses, {
            projectId: rawProjectId,
            cycleYearMonth: yearMonth,
          });
          source = { ...source, ...historicalCycle };
          settlementCycleContext = {
            cycle: historicalCycle.settlementCycle,
            businessState: historicalCycle.settlementCycle.businessState,
            health: historicalCycle.settlementCycle.health,
            workflowRevision: historicalCycle.settlementCycle.workflowRevision,
            requestId: '',
            requestCycleYearMonth: yearMonth,
            requestTargetYearMonth: previousYearMonth(yearMonth),
            commandCapabilities: historicalCycle.settlementCycle.commandCapabilities,
          };
        } else {
          settlementCycleContext = requireCashflowSettlementCycleReadContext(source, {
            projectId: rawProjectId,
            cycleYearMonth: yearMonth,
          });
        }
        let monthCloseRequestRead;
        if (historical) {
          monthCloseRequestRead = { available: true, record: null };
        } else try {
          const record = await readAlignedCashflowSettlementCycleRequest({
            db,
            tenantId: req.context.tenantId,
            projectId: rawProjectId,
            context: settlementCycleContext,
          });
          monthCloseRequestRead = { available: true, record };
        } catch (error) {
          if (readOptionalText(error?.code) === 'cashflow_settlement_cycle_response_invalid') throw error;
          sectionErrors.push(sectionUnavailable(
            'monthCloseRequest', 'cashflow_month_close_request_unavailable', error,
          ));
          monthCloseRequestRead = { available: false, record: null };
        }
        const monthCloseRequest = monthCloseRequestRead.record;
        const monthCloseRequestPartyNames = monthCloseRequest
          ? await readCashflowRequestPartyNames({
              db,
              tenantId: req.context.tenantId,
              record: monthCloseRequest,
            }).catch((error) => {
              sectionErrors.push(sectionUnavailable(
                'monthCloseRequest', 'cashflow_month_close_party_names_unavailable', error,
              ));
              return {};
            })
          : {};
        const result = objectValue(source?.monthClose);
        const latestRun = objectValue(source?.latestRun);
        const monthStatusEvidence = objectValue(source?.monthStatusEvidence);
        const cashflow = objectValue(source?.cashflow);
        const jvmPartial = readJvmDashboardPartialSections(source);
        for (const entry of jvmPartial.sectionErrors) {
          if (!sectionErrors.some((current) => current.section === entry.section && current.code === entry.code)) {
            sectionErrors.push(entry);
          }
        }
        const snapshotCompatibility = objectValue(source?.snapshotCompatibility) || {
          status: '', missingEvidence: [],
        };
        if (!['LIVE_CURRENT', 'LIVE_AMENDED', 'FROZEN_COMPLETE', 'LEGACY_EVIDENCE_ONLY', 'AUTHORITY_UNAVAILABLE']
          .includes(readOptionalText(snapshotCompatibility.status))) {
          throw createHttpError(502, '월 결산 화면 상태를 확인할 수 없습니다. 잠시 후 다시 불러와 주세요.', 'jvm_weekly_response_invalid');
        }
        result.snapshotCompatibility = snapshotCompatibility;
        const authorityUnavailable = readOptionalText(result?.status) === 'UNAVAILABLE'
          && snapshotCompatibility.status === 'AUTHORITY_UNAVAILABLE';
        const openingBalances = jvmPartial.unavailableSections.has('openingBalances')
          ? null
          : authorityUnavailable
            ? null
          : snapshotCompatibility.status === 'LEGACY_EVIDENCE_ONLY'
          && snapshotCompatibility.missingEvidence?.includes('OPENING_BALANCES')
            ? null
            : requireJvmOpeningBalances(source, settlementCycleContext.cycle.monthCloseTargetYearMonth);
        const authorityIssueCode = readOptionalText(monthStatusEvidence?.issueCode);
        const unavailableStatusMatches = authorityUnavailable
          && monthStatusEvidence?.operationalStatus === null
          && JVM_DASHBOARD_AUTHORITY_BLOCKERS.has(authorityIssueCode)
          && (Array.isArray(source?.blockers) ? source.blockers : [])
            .some((blocker) => readOptionalText(blocker?.code) === authorityIssueCode);
        if (
          readOptionalText(result?.projectId) !== rawProjectId
          || readOptionalText(result?.yearMonth) !== yearMonth
          || readOptionalText(latestRun?.projectId) !== rawProjectId
          || readOptionalText(latestRun?.yearMonth) !== yearMonth
          || readOptionalText(monthStatusEvidence?.authority) !== 'CUMULATIVE_CLOSE_HEAD'
          || (!unavailableStatusMatches
            && readOptionalText(monthStatusEvidence?.operationalStatus) !== readOptionalText(result?.status))
          || readOptionalText(monthStatusEvidence?.latestRunStatus) !== readOptionalText(latestRun?.status)
        ) {
          throw createHttpError(502, '요청한 달과 다른 달의 자료가 도착했습니다. 화면을 새로고침해 주세요.', 'jvm_weekly_project_mismatch');
        }
        result.latestRun = latestRun;
        result.monthStatusEvidence = monthStatusEvidence;
        if (db?.doc
          && readOptionalText(result?.status) === 'OPEN'
          && !cashflow
          && !jvmPartial.unavailableSections.has('cashflow')) {
          throw createHttpError(502, '월 결산 자료 일부가 도착하지 않았습니다. 잠시 후 다시 시도해 주세요.', 'jvm_weekly_response_invalid');
        }
        if (cashflow && readOptionalText(cashflow?.projectId) !== rawProjectId) {
          throw createHttpError(502, '다른 프로젝트의 자료가 도착했습니다. 화면을 새로고침해 주세요.', 'jvm_weekly_project_mismatch');
        }
        const targetYearMonth = settlementCycleContext.cycle.monthCloseTargetYearMonth;
        const monthCloseCalendar = readJvmMonthCloseCalendar(source, targetYearMonth);
        const operationalCycle = readJvmOperationalCycle(source, yearMonth);
        const selectedCalendar = monthCloseCalendar.get(targetYearMonth);
        const settlementMonth = source.settlementStatuses.items
          .find((item) => readOptionalText(item?.period) === 'MONTH');
        if (operationalCycle.targetYearMonth !== targetYearMonth
          || operationalCycle.deadline !== selectedCalendar?.closeDeadline
          || Date.parse(settlementMonth?.deadlineAt) !== Date.parse(selectedCalendar?.closeDeadlineAt)
          || Date.parse(settlementMonth?.approverDeadlineAt) !== Date.parse(selectedCalendar?.approverDeadlineAt)) {
          throw jvmMonthCloseResponseInvalid();
        }
        const cycleBusinessDate = readOptionalText(result?.evaluatedBusinessDate) || localComparisonBoundary.asOfDate;
        let comparisonBoundary;
        try {
          comparisonBoundary = {
            ...resolveCashflowComparisonAsOf(cycleBusinessDate, currentNow),
            asOfMs: currentNow.getTime(),
          };
        } catch {
          throw createHttpError(
            502,
            '월 결산 기준일을 확인할 수 없습니다. 잠시 후 다시 불러와 주세요.',
            'jvm_weekly_response_invalid',
          );
        }
        const cumulativeClose = {
          ...result,
          cycleYearMonth: operationalCycle.cycleYearMonth,
          targetYearMonth: operationalCycle.targetYearMonth,
          evaluatedBusinessDate: cycleBusinessDate,
          closeDeadline: operationalCycle.deadline,
          closeDeadlineAt: selectedCalendar.closeDeadlineAt,
          approverDeadlineAt: selectedCalendar.approverDeadlineAt,
          closeEligible: operationalCycle.eligible,
          late: operationalCycle.late,
          monthState: monthCloseRequest
            ? cashflowMonthCloseRequestView(monthCloseRequest, monthCloseRequestPartyNames)
            : null,
          settlementCycle: settlementCycleContext.cycle,
        };
        const cashflowSourceUnavailable = jvmPartial.unavailableSections.has('cashflow');
        const dashboard = cashflowSourceUnavailable
          ? null
          : await trace.measure(
            'dashboard_compose',
            () => composeCashflowMonthDashboard({
              db,
              req,
              projectId: rawProjectId,
              yearMonth: targetYearMonth,
              close: cumulativeClose,
              cashflow,
              openingBalances,
              comparisonBoundary,
              weeklyCompliance,
              projectionActualSummary: null,
              cumulativeAuthority: objectValue(source?.cumulativeClose),
              monthCloseCalendar,
              sectionErrors,
              sourceBlockers: jvmPartial.blockers,
              weeklyComplianceBoundary: comparisonBoundary,
            }),
            { attempt: traceAttempt },
          );
        // 대시보드는 이미 완성됐다. 이 뒤는 "읽는 동안 시트 반영이 끼어들었는지" 일관성
        // 표시용 확인이라, 실패해도 완성된 응답을 버리지 않는다.
        const publicationAfter = await trace.measure(
          'publication_after',
          () => readCashflowSheetPublicationState({
            db,
            tenantId: req.context.tenantId,
            projectId: rawProjectId,
            nowMs: currentNow.getTime(),
          }).catch(() => {
            if (!sectionErrors.some((entry) => entry.section === 'sheetPublication')) {
              sectionErrors.push({ section: 'sheetPublication', code: 'sheet_publication_state_unavailable' });
            }
            return { blocked: false, fingerprint: null, unavailable: true };
          }),
          { attempt: traceAttempt },
        );
        const pendingApply = publicationAfter.blocked ? {
          startedAt: publicationAfter.applyStartedAt,
          expiresAt: publicationAfter.leaseExpiresAt,
        } : null;
        const publicationStateUnavailable = Boolean(publicationBefore.unavailable || publicationAfter.unavailable);
        const actions = buildCashflowMonthCloseActions({
          req,
          dashboard,
          close: cumulativeClose,
          requestRecord: monthCloseRequest,
          requestAvailable: monthCloseRequestRead.available,
          settlementCycleContext,
          approverLockRead,
          actionAccess,
          authMode,
          workspaceEmailDomain,
        });
        const operationsSummary = buildCashflowOperationsSummary(dashboard);
        const presentation = buildCashflowMonthClosePresentation({
          dashboard,
          settlementCycleContext,
          requestRecord: monthCloseRequest,
          comparisonBoundary,
        });
        if (publicationStateUnavailable
          || publicationBefore.fingerprint === publicationAfter.fingerprint) {
          return {
            ...cumulativeClose,
            ...(dashboard ? { dashboard } : {}),
            ...(!dashboard ? { closeEligible: false } : {}),
            ...(!dashboard && jvmPartial.blockers.length > 0 ? { blockers: jvmPartial.blockers } : {}),
            pendingApply,
            publicationChangedDuringRead: false,
            actions,
            operationsSummary,
            presentation,
            sectionErrors: cashflowSectionErrorsForResponse(sectionErrors),
          };
        }
        if (attempt === 1) {
          return {
            ...cumulativeClose,
            ...(dashboard ? { dashboard } : {}),
            ...(!dashboard ? { closeEligible: false } : {}),
            ...(!dashboard && jvmPartial.blockers.length > 0 ? { blockers: jvmPartial.blockers } : {}),
            pendingApply,
            publicationChangedDuringRead: true,
            actions,
            operationsSummary,
            presentation,
            sectionErrors: cashflowSectionErrorsForResponse(sectionErrors),
          };
        }
      }
    }, monthCloseRouteTimeoutMs);
    // 8초의 정체를 브라우저에서 바로 보게: Network 탭 Timing 에 span 분해가 뜬다. 본문·로직은 그대로.
    res.set('Server-Timing', trace.serverTiming());
    res.status(200).json(body);
  }));

  app.get('/api/v1/cashflow/:projectId/weekly-update-complete', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ['admin', 'finance', 'pm', 'auditor', 'viewer', 'tenant_admin', 'support', 'security'], 'read weekly cashflow update', authMode, workspaceEmailDomain);
    const projectId = readOptionalText(req.params.projectId);
    const yearMonth = readOptionalText(req.query.yearMonth);
    const weekNo = Number(req.query.weekNo);
    if (
      !/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth)
      || !Number.isSafeInteger(weekNo)
      || weekNo < 1
      || weekNo > 5
    ) {
      throw createHttpError(
        400,
        '조회할 주간 정산 연월과 주차를 정확히 입력해 주세요.',
        'cashflow_weekly_update_scope_invalid',
      );
    }
    const result = await proxyJavaWeeklyRequest({
      context: req.context,
      method: 'GET',
      path: `/api/v1/cashflow/${encodeURIComponent(projectId)}/weekly-update-complete?yearMonth=${encodeURIComponent(yearMonth)}&weekNo=${weekNo}`,
    });
    res.status(200).json(result);
  }));

  app.get('/api/v1/cashflow/:projectId/settlement-statuses', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.readCore, 'read cashflow settlement statuses', authMode, workspaceEmailDomain);
    const projectId = readOptionalText(req.params.projectId);
    const yearMonth = readOptionalText(req.query.yearMonth);
    if (!projectId || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth)) {
      throw createHttpError(400, '조회할 결산 연월을 정확히 입력해 주세요.', 'cashflow_settlement_status_scope_invalid');
    }
    const result = await proxyJavaWeeklyRequest({
      context: req.context,
      method: 'GET',
      path: `/api/v1/cashflow/${encodeURIComponent(projectId)}/settlement-statuses?yearMonth=${encodeURIComponent(yearMonth)}${isHistoricalCashflowSettlementCycle(yearMonth) ? '' : '&settlementCycle=true'}`,
    });
    const output = isHistoricalCashflowSettlementCycle(yearMonth)
      ? buildHistoricalCashflowSettlementCycle(result, { projectId, cycleYearMonth: yearMonth }).settlementStatuses
      : requireCashflowSettlementStatusesResult(result, { projectId, yearMonth });
    res.status(200).json(output);
  }));

  app.post('/api/v1/cashflow/settlement-statuses/batch', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.readCore, 'read cashflow settlement statuses', authMode, workspaceEmailDomain);
    const projectIds = req.body?.projectIds;
    const yearMonth = readOptionalText(req.body?.yearMonth);
    if (!Array.isArray(projectIds)
      || projectIds.length < 1
      || projectIds.length > 100
      || projectIds.some((projectId) => typeof projectId !== 'string'
        || projectId.length < 1
        || projectId.length > 120
        || projectId.includes('/')
        || projectId.trim() !== projectId)
      || new Set(projectIds).size !== projectIds.length
      || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth)) {
      throw createHttpError(400, '조회할 프로젝트와 결산 연월을 정확히 입력해 주세요.', 'cashflow_settlement_status_batch_request_invalid');
    }
    const historical = isHistoricalCashflowSettlementCycle(yearMonth);
    const result = await proxyJavaWeeklyRequest({
      context: req.context,
      method: 'POST',
      path: `/api/v1/cashflow/settlement-statuses/batch${historical ? '' : '?settlementCycle=true'}`,
      command: 'read_cashflow_settlement_statuses_batch',
      body: { projectIds, yearMonth },
      mutation: false,
    });
    if (!historical) {
      requireCashflowSettlementStatusesBatchResult(result, { projectIds, yearMonth });
      res.status(200).json(result);
      return;
    }
    const items = Array.isArray(result?.items)
      ? result.items.map((item) => buildHistoricalCashflowSettlementCycle(item, {
          projectId: item?.projectId,
          cycleYearMonth: yearMonth,
        }).settlementStatuses)
      : null;
    if (!items || !Array.isArray(result?.errors)) {
      throw createHttpError(502, '월 결산 사이클 응답의 범위가 올바르지 않습니다.', 'cashflow_settlement_cycle_response_invalid');
    }
    const output = { ...result, items };
    requireCashflowSettlementStatusesBatchResult(output, { projectIds, yearMonth });
    res.status(200).json(output);
  }));

  app.post('/api/v1/cashflow/:projectId/settlement-statuses/transition', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ['admin', 'finance', 'pm', 'viewer', 'tenant_admin'], 'update cashflow settlement status', authMode, workspaceEmailDomain);
    const projectId = readOptionalText(req.params.projectId);
    const requested = commandBody(req);
    const yearMonth = readOptionalText(requested.yearMonth);
    const period = readOptionalText(requested.period).toUpperCase();
    const action = readOptionalText(requested.action).toUpperCase();
    if (!projectId
      || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth)
      || !/^(MONTH|WEEK_[1-5])$/.test(period)
      || !/^(SUBMIT|APPROVE)$/.test(action)) {
      throw createHttpError(400, '결산 대상과 처리 상태를 정확히 입력해 주세요.', 'cashflow_settlement_status_transition_invalid');
    }
    if (period === 'MONTH') {
      throw createHttpError(
        409,
        '월 결산은 전용 승인 절차에서 처리해 주세요.',
        'MONTH_REQUIRES_CLOSE_WORKFLOW',
      );
    }
    if (action === 'SUBMIT') {
      throw createHttpError(403, '실무자 포털에서 정산을 완료한 뒤에만 제출할 수 있습니다.', 'cashflow_settlement_submit_forbidden');
    }
    const result = await proxyMutation(
      req,
      `/api/v1/cashflow/${encodeURIComponent(projectId)}/settlement-statuses/transition`,
      { yearMonth, period, action },
      { cashflowWrite: true },
    );
    res.status(200).json(result);
  }));

  app.get('/api/v1/cashflow/:projectId/weekly-update-compliance', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ['admin', 'finance', 'pm', 'auditor', 'viewer', 'tenant_admin', 'support', 'security'], 'read weekly cashflow compliance', authMode, workspaceEmailDomain);
    const projectId = readOptionalText(req.params.projectId);
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    const cursor = readOptionalText(req.query.cursor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || cursor.length > 512) {
      throw createHttpError(400, '주간 정산 이력 조회 범위가 올바르지 않습니다.', 'cashflow_weekly_compliance_query_invalid');
    }
    const result = await readWeeklyCompliance(req.context, projectId, { limit, cursor });
    res.status(200).json(result);
  }));

  app.post('/api/v1/cashflow/projection-actual-summary/batch', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.readCore, 'read cashflow projection-actual summary', authMode, workspaceEmailDomain);
    const projectIds = req.body?.projectIds;
    const yearMonth = readOptionalText(req.body?.yearMonth);
    if (!Array.isArray(projectIds)
      || projectIds.length < 1
      || projectIds.length > 10
      || projectIds.some((projectId) => typeof projectId !== 'string'
        || projectId.length < 1
        || projectId.length > 120
        || projectId.includes('/')
        || projectId.trim() !== projectId)
      || new Set(projectIds).size !== projectIds.length
      || (yearMonth && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth))) {
      throw createHttpError(400, '현금흐름 요약 조회 범위가 올바르지 않습니다.', 'cashflow_projection_actual_summary_request_invalid');
    }
    res.status(200).json(await readSheetFormulaProjectionActualSummaries({
      db,
      req,
      projectIds,
      yearMonth,
      comparisonBoundary: resolveCashflowComparisonAsOf('', now()),
      authMode,
      workspaceEmailDomain,
    }));
  }));

  async function readWeeklyOverview(req) {
    const trace = createCashflowPerformanceTrace({
      requestId: req.context?.requestId || req.requestId,
      operation: 'cashflow.weekly_overview',
      ...(performanceLogger ? { logger: performanceLogger } : {}),
      ...(performanceNow ? { now: performanceNow } : {}),
    });
    const { projectIds, yearMonth } = trace.measureSync('request_validation', () => {
      assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.readCore, 'read cashflow weekly overview', authMode, workspaceEmailDomain);
      const projectIds = req.body?.projectIds;
      const yearMonth = readOptionalText(req.body?.yearMonth);
      if (!Array.isArray(projectIds)
        || projectIds.length < 1
        || projectIds.length > 100
        || projectIds.some((projectId) => typeof projectId !== 'string'
          || projectId.length < 1
          || projectId.length > 120
          || projectId.includes('/')
          || projectId.trim() !== projectId)
        || new Set(projectIds).size !== projectIds.length
        || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth)) {
        throw createHttpError(400, '조회할 프로젝트와 결산 연월을 정확히 입력해 주세요.', 'cashflow_weekly_overview_request_invalid');
      }
      return { projectIds, yearMonth };
    });
    const monthCloseTargetYearMonth = previousYearMonth(yearMonth);
    const historical = isHistoricalCashflowSettlementCycle(yearMonth);
    const weeklyResult = await trace.measure('java_overview', () => proxyJavaWeeklyRequest({
      context: req.context,
      method: 'POST',
      path: '/api/v1/cashflow/weekly-overview',
      command: 'read_cashflow_weekly_overview',
      body: { projectIds, yearMonth, settlementCycle: !historical },
      mutation: false,
    }), { projectCount: projectIds.length });
    const items = Array.isArray(weeklyResult?.items) ? weeklyResult.items : [];
    const upstreamErrors = Array.isArray(weeklyResult?.errors) ? weeklyResult.errors : null;
    const returnedProjectIds = items.map((item) => item?.projectId);
    const upstreamErrorKeys = upstreamErrors?.map((error) => (
      `${error?.projectId}:${error?.code}`
    ));
    if ((historical ? !['1', '2'].includes(weeklyResult?.version) : weeklyResult?.version !== '2')
      || weeklyResult?.yearMonth !== yearMonth
      || items.length !== projectIds.length
      || returnedProjectIds.some((projectId) => !projectIds.includes(projectId))
      || new Set(returnedProjectIds).size !== returnedProjectIds.length
      || !upstreamErrors
      || upstreamErrors.some((error) => (
        error?.code !== 'SUMMARY_UNAVAILABLE'
        || !projectIds.includes(error?.projectId)
      ))
      || new Set(upstreamErrorKeys).size !== upstreamErrorKeys.length) {
      throw createHttpError(502, '월 결산 사이클 응답의 범위가 올바르지 않습니다.', 'cashflow_settlement_cycle_response_invalid');
    }
    const adaptedItems = items.map((item) => {
      const projectId = item.projectId;
      if (!historical) {
        requireCashflowSettlementCycleReadContext(item, { projectId, cycleYearMonth: yearMonth });
        return item;
      }
      const historicalCycle = buildHistoricalCashflowSettlementCycle(item.settlementStatuses, {
        projectId,
        cycleYearMonth: yearMonth,
      });
      return { ...item, ...historicalCycle };
    });
    let mirrorsByProjectId = new Map();
    let mirrorReadFailed = false;
    try {
      mirrorsByProjectId = await trace.measure('mirror_overview', () => readWeeklyOverviewMirrors({
        db,
        tenantId: req.context.tenantId,
        projectIds,
        comparisonBoundary: resolveCashflowComparisonAsOf('', now()),
        yearMonth,
      }), { projectCount: projectIds.length });
    } catch {
      mirrorReadFailed = true;
    }
    const combined = {
      ...weeklyResult,
      version: '5',
      yearMonth,
      monthCloseTargetYearMonth,
      monthCloseTargetLabel: `${Number(monthCloseTargetYearMonth.slice(5, 7))}월`,
      items: adaptedItems.map((item) => {
        const mirror = mirrorsByProjectId.get(item?.projectId);
        return {
          ...item,
          projectionActualSummary: mirror?.projectionActualSummary || null,
          sheetCapturedAt: mirror?.sheetCapturedAt || null,
        };
      }),
      errors: mirrorReadFailed
        ? projectIds.map((projectId) => ({ projectId, code: 'SUMMARY_UNAVAILABLE' }))
        : [],
    };
    trace.emit('response', {
      outcome: 'ok',
      projectCount: projectIds.length,
      itemCount: Array.isArray(combined.items) ? combined.items.length : 0,
      issueCount: combined.errors.length,
    });
    return combined;
  }

  app.post('/api/v1/cashflow/weekly-overview', asyncHandler(async (req, res) => {
    res.status(200).json(await readWeeklyOverview(req));
  }));

  app.post('/api/v1/mcp/cashflow/weekly-overview', asyncHandler(async (req, res) => {
    res.status(200).json(await readWeeklyOverview(req));
  }));

  function mcpServerFor(context) {
    const server = new McpServer({ name: 'myscube', version: '0.2.0' });
    server.registerTool('cashflow_status', {
      title: 'MYSCube 정산 현황 조회',
      description: '권한이 있는 프로젝트의 월·주 정산 상태와 P/A 차액을 조회합니다. 읽기 전용입니다.',
      inputSchema: { yearMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/), projectIds: z.array(z.string()).min(1).max(100) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ yearMonth, projectIds }) => {
      try {
        const overview = await readWeeklyOverview({ context, body: { yearMonth, projectIds } });
        return { content: [{ type: 'text', text: JSON.stringify(overview) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : '현금흐름 조회에 실패했습니다.' }], isError: true };
      }
    });
    return server;
  }

  app.post('/mcp', asyncHandler(async (req, res) => {
    if (!mcpOAuthService) throw createHttpError(503, 'MCP OAuth가 설정되지 않았습니다.', 'mcp_oauth_unavailable');
    let context;
    try { context = await mcpOAuthService.resolveAccessToken(req.header('authorization')); }
    catch (error) {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource', mcpOAuthService.resource).toString()}"`);
      throw error;
    }
    const server = mcpServerFor(context);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.once('close', () => { void transport.close(); void server.close(); });
  }));

  app.post('/api/v1/cashflow/:projectId/weekly-update-complete', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, CASHFLOW_WEEKLY_COMPLETE_ROLES, 'complete weekly cashflow update', authMode, workspaceEmailDomain);
    const projectId = readOptionalText(req.params.projectId);
    const currentNow = now();
    const boundary = resolveCashflowComparisonAsOf('', currentNow);
    const requested = commandBody(req);
    const requestedYearMonth = readOptionalText(requested.yearMonth);
    const requestedWeekNo = Number(requested.weekNo);
    const updateResult = readOptionalText(requested.updateResult).toUpperCase();
    const ignoreProjectionValidation = requested.ignoreProjectionValidation === true;
    const projectionValidationEvidenceHash = readOptionalText(requested.projectionValidationEvidenceHash);
    const projectionValidationIssueCount = Number(requested.projectionValidationIssueCount || 0);
    const hasExplicitScope = Object.prototype.hasOwnProperty.call(requested, 'yearMonth')
      || Object.prototype.hasOwnProperty.call(requested, 'weekNo');
    if (!['CHANGED', 'NO_CHANGES'].includes(updateResult) || (hasExplicitScope && (
      !/^20\d{2}-(0[1-9]|1[0-2])$/.test(requestedYearMonth)
      || !Number.isSafeInteger(requestedWeekNo)
      || requestedWeekNo < 1
      || requestedWeekNo > 5
    )) || (ignoreProjectionValidation && (
      !/^sha256:[a-f0-9]{64}$/.test(projectionValidationEvidenceHash)
      || !Number.isSafeInteger(projectionValidationIssueCount)
      || projectionValidationIssueCount < 1
      || projectionValidationIssueCount > 256
    ))) {
      throw createHttpError(
        400,
        '주간 정산 대상 연월과 주차를 함께 정확히 입력해 주세요.',
        'cashflow_weekly_update_scope_invalid',
      );
    }
    const requestKey = (
      readOptionalText(req.context.idempotencyKey)
      || readOptionalText(req.context.requestId)
      || String(currentNow.getTime())
    ).slice(0, 96);
    const result = await proxyMutation(
      req,
      `/api/v1/cashflow/${encodeURIComponent(projectId)}/weekly-update-complete`,
      {
        idempotencyKey: `cashflow-weekly:${requestKey}`,
        yearMonth: hasExplicitScope ? requestedYearMonth : boundary.asOfWeek.yearMonth,
        weekNo: hasExplicitScope ? requestedWeekNo : boundary.asOfWeek.weekNo,
        completedAt: currentNow.toISOString(),
        updateResult,
        ignoreProjectionValidation,
        projectionValidationEvidenceHash: ignoreProjectionValidation ? projectionValidationEvidenceHash : '',
        projectionValidationIssueCount: ignoreProjectionValidation ? projectionValidationIssueCount : 0,
      },
      { cashflowWrite: true },
    );
    void Promise.resolve().then(async () => {
      const [projectSnapshot, { requestedByName }] = await Promise.all([
        db.doc(`orgs/${req.context.tenantId}/projects/${projectId}`).get(),
        readCashflowRequestPartyNames({
          db,
          tenantId: req.context.tenantId,
          record: { requestedByUid: req.context.actorId },
        }),
      ]);
      const project = projectSnapshot.exists ? projectSnapshot.data() || {} : {};
      const projectName = readOptionalText(project.name)
        || readOptionalText(project.officialContractName)
        || readOptionalText(project.projectCode)
        || projectId;
      const yearMonth = hasExplicitScope ? requestedYearMonth : boundary.asOfWeek.yearMonth;
      const weekNo = hasExplicitScope ? requestedWeekNo : boundary.asOfWeek.weekNo;
      notifyCashflowSlack(`*[MYSCube] 주정산 완료*\n프로젝트명: ${projectName}\n대상: ${yearMonth} ${weekNo}주차\n처리자: ${requestedByName || '미확인'}`);
    }).catch(() => {});
    res.status(200).json(result);
  }));

  app.post('/api/v1/cashflow/:projectId/weekly-update-complete/reopen', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ['admin', 'finance', 'pm', 'viewer', 'tenant_admin'], 'reopen weekly cashflow update', authMode, workspaceEmailDomain);
    const projectId = readOptionalText(req.params.projectId);
    const requested = commandBody(req);
    const yearMonth = readOptionalText(requested.yearMonth);
    const weekNo = Number(requested.weekNo);
    const reason = readOptionalText(requested.reason);
    if (
      !/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth)
      || !Number.isSafeInteger(weekNo)
      || weekNo < 1
      || weekNo > 5
      || reason.length > 1_000
    ) {
      throw createHttpError(
        400,
        '주간 정산 회수에는 대상 연월과 주차가 필요합니다.',
        'cashflow_weekly_reopen_request_invalid',
      );
    }
    // 화면은 revision 을 모른다. BFF 가 현재 완료 기록에서 읽어 JVM 낙관적 잠금에 넘긴다.
    // 완료 요청(SUBMITTED) 은 사유 없이 회수. 확정(LOCKED) 은 사유가 있어야 재오픈 (조직장·관리자만, JVM 이 검사).
    const completion = await readDocument(
      db,
      `orgs/${req.context.tenantId}/cashflow_weekly_update_completions/${projectId}-${yearMonth}-w${weekNo}`,
    );
    const completionStatus = readOptionalText(completion?.status);
    if (!['SUBMITTED', 'LOCKED'].includes(completionStatus) || !Number.isSafeInteger(Number(completion?.revision))) {
      throw createHttpError(409, '완료 요청되거나 확정된 주간 정산만 되돌릴 수 있습니다.', 'cashflow_weekly_reopen_not_locked');
    }
    if (completionStatus === 'LOCKED' && !reason) {
      throw createHttpError(400, '조직장이 확정한 주간 정산을 되돌리려면 사유가 필요합니다.', 'cashflow_weekly_reopen_reason_required');
    }
    const expectedRevision = Number.isSafeInteger(Number(requested.expectedRevision)) && Number(requested.expectedRevision) >= 1
      ? Number(requested.expectedRevision)
      : Number(completion.revision);
    const result = await proxyMutation(
      req,
      `/api/v1/cashflow/${encodeURIComponent(projectId)}/weekly-update-complete/reopen`,
      { ...requested, yearMonth, weekNo, expectedRevision, ...(reason ? { reason } : {}) },
      { cashflowWrite: true },
    );
    res.status(200).json(result);
  }));

  // 주정산 확정: 완료 요청된 주를 프로젝트 조직장이 잠금으로 확정한다. revision 은 BFF 가 읽어 넘긴다.
  app.post('/api/v1/cashflow/:projectId/weekly-update-complete/confirm', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ['admin', 'finance', 'pm', 'viewer', 'tenant_admin'], 'confirm weekly cashflow update', authMode, workspaceEmailDomain);
    const projectId = readOptionalText(req.params.projectId);
    const requested = commandBody(req);
    const yearMonth = readOptionalText(requested.yearMonth);
    const weekNo = Number(requested.weekNo);
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth) || !Number.isSafeInteger(weekNo) || weekNo < 1 || weekNo > 5) {
      throw createHttpError(400, '주간 정산 확정에는 대상 연월과 주차가 필요합니다.', 'cashflow_weekly_confirm_request_invalid');
    }
    const completion = await readDocument(
      db,
      `orgs/${req.context.tenantId}/cashflow_weekly_update_completions/${projectId}-${yearMonth}-w${weekNo}`,
    );
    if (readOptionalText(completion?.status) !== 'SUBMITTED' || !Number.isSafeInteger(Number(completion?.revision))) {
      throw createHttpError(409, '완료 요청된 주간 정산만 확정할 수 있습니다.', 'cashflow_weekly_confirm_not_submitted');
    }
    const result = await proxyMutation(
      req,
      `/api/v1/cashflow/${encodeURIComponent(projectId)}/weekly-update-complete/confirm`,
      { ...requested, yearMonth, weekNo, expectedRevision: Number(completion.revision) },
      { cashflowWrite: true },
    );
    res.status(200).json(result);
  }));

  async function prepareCashflowMonthClose(req, requestPayload = req.body, idempotencyKey = req.context.idempotencyKey) {
    const routeDeadlineAtMs = Date.now() + monthCloseRouteTimeoutMs;
    const mutationBudgetMs = Math.min(
      CASHFLOW_MONTH_CLOSE_MUTATION_BUDGET_MS,
      Math.max(1, Math.floor(monthCloseRouteTimeoutMs / 2)),
    );
    const preflightTimeoutMs = Math.max(1, monthCloseRouteTimeoutMs - mutationBudgetMs);
    const closeReq = {
      body: requestPayload,
      context: { ...req.context, idempotencyKey },
    };
    const prepared = await withCashflowMonthCloseDeadline(async () => {
      const rawProjectId = readOptionalText(req.params.projectId);
      const projectId = encodeURIComponent(rawProjectId);
      const requested = commandBody(closeReq);
      const cycleYearMonth = readOptionalText(requested.yearMonth);
      const reviewYearMonth = /^20\d{2}-(0[1-9]|1[0-2])$/.test(cycleYearMonth)
        ? previousYearMonth(cycleYearMonth)
        : '';
      if (
        !/^20\d{2}-(0[1-9]|1[0-2])$/.test(cycleYearMonth)
        || !Number.isSafeInteger(Number(requested.expectedRevision))
        || Number(requested.expectedRevision) < 0
        || !objectValue(requested.closeInput)
        || !objectValue(requested.expectedOpeningBalances)
        || readOptionalText(requested.closeInput.yearMonth) !== reviewYearMonth
      ) {
        throw createHttpError(400, 'Cashflow month close review input is required.', 'cashflow_month_close_request_invalid');
      }
      const expectedWorkflowRevision = requireExpectedWorkflowRevision(requested);
      cumulativeCloseMonths(cycleYearMonth);
      const currentNow = now();
      const publicationBefore = await readCashflowSheetPublicationState({
        db,
        tenantId: req.context.tenantId,
        projectId: rawProjectId,
        nowMs: currentNow.getTime(),
      });
      assertCashflowSheetPublicationReady(publicationBefore);
      const comparisonBoundary = {
        ...resolveCashflowComparisonAsOf('', currentNow),
        asOfMs: currentNow.getTime(),
      };
      const source = await proxyJavaWeeklyRequest({
        context: req.context,
        method: 'GET',
        path: `/api/v1/cashflow/${projectId}/month-close/dashboard-source?yearMonth=${encodeURIComponent(cycleYearMonth)}&settlementCycle=true`,
        deadlineAtMs: routeDeadlineAtMs - mutationBudgetMs,
      });
      const settlementCycleContext = requireCashflowSettlementCycleReadContext(source, {
        projectId: rawProjectId,
        cycleYearMonth,
      });
      if (settlementCycleContext.health !== 'OK'
        || settlementCycleContext.workflowRevision !== expectedWorkflowRevision
        || settlementCycleContext.commandCapabilities.SUBMIT_MONTH_CLOSE.allowed !== true) {
        throw createHttpError(
          409,
          '현재 월 결산 회차는 승인 요청을 만들 수 없습니다. 최신 상태를 다시 확인해 주세요.',
          'cashflow_month_close_not_eligible',
        );
      }
      const jvmPartial = readJvmDashboardPartialSections(source);
      if (
        jvmPartial.unavailableSections.has('cashflow')
        || jvmPartial.unavailableSections.has('openingBalances')
      ) {
        throw createHttpError(
          503,
          '월 결산 필수 자료를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.',
          'cashflow_month_close_source_unavailable',
        );
      }
      const weeklyCompliance = await readWeeklyCompliance(req.context, rawProjectId);
      const sourceClose = objectValue(source?.monthClose);
      const cashflow = objectValue(source?.cashflow);
      const currentOpeningBalances = requireJvmOpeningBalances(source, reviewYearMonth);
      const reviewedOpeningBalances = requireReviewedOpeningBalances(requested.expectedOpeningBalances, reviewYearMonth);
      requireUnchangedReviewedOpeningBalances(reviewedOpeningBalances, currentOpeningBalances);
      if (Number(sourceClose?.revision) !== Number(requested.expectedRevision)) {
        throw createHttpError(
          409,
          '월 결산 상태가 변경되었습니다. 최신 자료를 다시 확인해 주세요.',
          'cashflow_month_close_revision_stale',
        );
      }
      if (
        readOptionalText(sourceClose?.projectId) !== rawProjectId
        || readOptionalText(sourceClose?.yearMonth) !== cycleYearMonth
        || !cashflow
        || readOptionalText(cashflow?.projectId) !== rawProjectId
      ) {
        throw createHttpError(502, '월 결산 자료 일부가 도착하지 않았습니다. 잠시 후 다시 시도해 주세요.', 'jvm_weekly_response_invalid');
      }
      const monthCloseCalendar = readJvmMonthCloseCalendar(source, reviewYearMonth);
      const operationalCycle = readJvmOperationalCycle(source, cycleYearMonth);
      const selectedCalendar = monthCloseCalendar.get(reviewYearMonth);
      const settlementMonth = source.settlementStatuses.items
        .find((item) => item.period === 'MONTH');
      if (operationalCycle.targetYearMonth !== reviewYearMonth
        || operationalCycle.deadline !== selectedCalendar?.closeDeadline
        || Date.parse(settlementMonth?.deadlineAt) !== Date.parse(selectedCalendar?.closeDeadlineAt)
        || Date.parse(settlementMonth?.approverDeadlineAt) !== Date.parse(selectedCalendar?.approverDeadlineAt)) {
        throw jvmMonthCloseResponseInvalid();
      }
      const cycleBusinessDate = readOptionalText(sourceClose?.evaluatedBusinessDate) || comparisonBoundary.asOfDate;
      if (readOptionalText(sourceClose?.status) !== 'OPEN' || !operationalCycle.eligible) {
        throw createHttpError(
          409,
          '현재 월 결산 회차는 승인 요청을 만들 수 없습니다. 최신 상태를 다시 확인해 주세요.',
          'cashflow_month_close_not_eligible',
        );
      }
      const validationClose = {
        ...sourceClose,
        cycleYearMonth: operationalCycle.cycleYearMonth,
        targetYearMonth: operationalCycle.targetYearMonth,
        evaluatedBusinessDate: cycleBusinessDate,
        closeDeadline: operationalCycle.deadline,
        closeDeadlineAt: selectedCalendar.closeDeadlineAt,
        approverDeadlineAt: selectedCalendar.approverDeadlineAt,
        closeEligible: operationalCycle.eligible,
        late: operationalCycle.late,
      };
      const validationDashboard = await composeCashflowMonthDashboard({
        db,
        req: closeReq,
        projectId: rawProjectId,
        yearMonth: reviewYearMonth,
        close: validationClose,
        cashflow,
        openingBalances: reviewedOpeningBalances,
        comparisonBoundary,
        weeklyCompliance,
        projectionActualSummary: null,
        cumulativeAuthority: objectValue(source?.cumulativeClose),
        monthCloseCalendar,
        sectionErrors: [],
        sourceBlockers: jvmPartial.blockers,
      });
      if (validationDashboard?.validation?.canClose !== true) {
        throw createHttpError(
          409,
          validationDashboard?.validation?.blockers?.[0]?.message
            || '월 결산 가능 상태를 서버에서 확인해 주세요.',
          'cashflow_month_close_validation_failed',
        );
      }
      const { closeBody, reviewWarnings, monthSnapshot } = await composeCashflowMonthCloseBody({
        db,
        req: closeReq,
        projectId: rawProjectId,
        cashflow,
        openingBalances: reviewedOpeningBalances,
        comparisonBoundary,
        weeklyCompliance,
        monthCloseTargetYearMonth: reviewYearMonth,
      });
      const publicationAfter = await readCashflowSheetPublicationState({
        db,
        tenantId: req.context.tenantId,
        projectId: rawProjectId,
        nowMs: currentNow.getTime(),
      });
      assertCashflowSheetPublicationReady(publicationAfter);
      if (publicationBefore.fingerprint !== publicationAfter.fingerprint) {
        throw createHttpError(
          409,
          '월 결산 검토 중 시트 반영 상태가 변경되었습니다. 다시 확인해 주세요.',
          'cashflow_sheet_publication_changed',
        );
      }
      return {
        projectId,
        rawProjectId,
        cycleYearMonth,
        monthCloseTargetYearMonth: reviewYearMonth,
        expectedWorkflowRevision,
        cashflow,
        sourceCloseStatus: readOptionalText(sourceClose.status),
        closeBody,
        reviewWarnings,
        monthSnapshot,
        publicationFingerprint: publicationAfter.fingerprint,
        shardSource: {
          sourceRevision: readOptionalText(monthSnapshot?.source?.sourceRevision) || null,
          targetRevision: readOptionalText(monthSnapshot?.source?.targetRevision) || null,
          capturedAt: readOptionalText(monthSnapshot?.source?.capturedAt) || null,
          spreadsheetId: readOptionalText(monthSnapshot?.source?.spreadsheetId) || null,
          spreadsheetTitle: readOptionalText(monthSnapshot?.source?.spreadsheetTitle) || null,
          selectedSheetName: readOptionalText(monthSnapshot?.source?.selectedSheetName) || null,
          spreadsheetUrl: readOptionalText(monthSnapshot?.source?.spreadsheetUrl) || null,
        },
        routeDeadlineAtMs,
      };
    }, preflightTimeoutMs);
    return prepared;
  }

  async function stageCumulativeMonthCloseRequest({
    req,
    prepared,
    approverUid,
    expectedApproverUid,
    expectedProjectVersion,
  }) {
    const cycleYearMonth = prepared.cycleYearMonth;
    const monthCloseTargetYearMonth = prepared.monthCloseTargetYearMonth;
    const cumulativeMonths = cumulativeCloseMonths(cycleYearMonth);
    const requestId = `${prepared.rawProjectId}-${cycleYearMonth}`;
    const actorUid = readOptionalText(req.context.actorId);
    const idempotencyKey = readOptionalText(req.context.idempotencyKey);
    const requestFingerprint = cashflowCloseHash(req.body ?? null);
    const stageId = cashflowSettlementCycleSubmitStageId({ requestId, actorUid, idempotencyKey });
    const requestRef = db.doc(cashflowMonthCloseRequestPath(req.context.tenantId, requestId));
    const stageRef = db.doc(`${requestRef.path}/stages/${stageId}`);
    const sourceMonths = new Map((Array.isArray(prepared.cashflow?.readModel?.months)
      ? prepared.cashflow.readModel.months : [])
      .map((month) => [readOptionalText(month?.yearMonth), month]));

    const evidenceFor = (evidenceRevision) => {
      const shards = cumulativeMonths.map((monthKey) => cumulativeMonthCloseShard({
        requestId,
        requestRevision: evidenceRevision,
        projectId: prepared.rawProjectId,
        yearMonth: monthKey,
        month: sourceMonths.get(monthKey),
        source: prepared.shardSource,
      }));
      const manifest = cumulativeMonthCloseManifest({
        requestId,
        requestRevision: evidenceRevision,
        projectId: prepared.rawProjectId,
        yearMonth: cycleYearMonth,
        shards,
      });
      const sumMode = (mode, selectedShards = shards) => selectedShards.reduce((sum, shard) => (
        sum + shard.cells
          .filter((cell) => cell.mode === mode && cell.cellState !== 'EMPTY')
          .reduce((monthSum, cell) => monthSum + Number(cell.amount), 0)
      ), 0);
      const totals = {
        projection: sumMode('projection'),
        actual: sumMode('actual'),
      };
      totals.difference = totals.actual - totals.projection;
      const annualSummaries = [...new Set(shards.map((shard) => Number(shard.yearMonth.slice(0, 4))))]
        .map((year) => {
          const yearShards = shards.filter((shard) => Number(shard.yearMonth.slice(0, 4)) === year);
          const projection = sumMode('projection', yearShards);
          const actual = sumMode('actual', yearShards);
          return { year, monthCount: yearShards.length, projection, actual, difference: actual - projection };
        });
      const payloadFingerprint = cashflowCloseHash({
        contractVersion: CASHFLOW_CUMULATIVE_CLOSE_CONTRACT,
        approverUid,
        cycleYearMonth,
        monthCloseTargetYearMonth,
        expectedRevision: prepared.closeBody.expectedRevision,
        manifestHash: manifest.manifestHash,
      });
      return { shards, manifest, totals, annualSummaries, payloadFingerprint };
    };

    return db.runTransaction(async (transaction) => {
      const [projectSnapshot, approverSnapshot, requesterSnapshot, requestSnapshot, stageSnapshot] = await Promise.all([
        transaction.get(db.doc(`orgs/${req.context.tenantId}/projects/${prepared.rawProjectId}`)),
        transaction.get(db.doc(`orgs/${req.context.tenantId}/members/${approverUid}`)),
        transaction.get(db.doc(`orgs/${req.context.tenantId}/members/${actorUid}`)),
        transaction.get(requestRef),
        transaction.get(stageRef),
      ]);
      const project = projectSnapshot.exists ? projectSnapshot.data() || {} : {};
      const approver = approverSnapshot.exists ? approverSnapshot.data() || {} : {};
      const requester = requesterSnapshot.exists ? requesterSnapshot.data() || {} : {};
      if (project.executiveApproverId !== approverUid
        || approverUid !== expectedApproverUid
        || (Number.isSafeInteger(project.version) ? project.version : 0) !== expectedProjectVersion
        || approver.uid !== approverUid
        || approver.status !== 'ACTIVE') {
        throw createHttpError(
          409,
          '프로젝트 조직장 정보가 변경되었습니다. 다시 요청해 주세요.',
          'cashflow_month_close_approver_stale',
        );
      }
      if (requester.uid !== actorUid || requester.status !== 'ACTIVE') {
        throw createHttpError(
          403,
          '이 프로젝트의 월 결산을 요청할 권한이 없습니다.',
          'cashflow_month_close_project_forbidden',
        );
      }

      const existingRequest = requestSnapshot.exists ? requestSnapshot.data() || {} : null;
      const storedStage = stageSnapshot.exists ? stageSnapshot.data() || {} : null;
      let evidenceRevision;
      if (storedStage) {
        evidenceRevision = storedStage.evidenceRevision;
      } else if (existingRequest) {
        const existingEvidenceRevision = existingRequest.evidenceRevision;
        if (existingRequest.documentType !== 'REQUEST'
          || existingRequest.contractVersion !== CASHFLOW_CUMULATIVE_CLOSE_CONTRACT
          || existingRequest.tenantId !== req.context.tenantId
          || existingRequest.projectId !== prepared.rawProjectId
          || existingRequest.requestId !== requestId
          || existingRequest.yearMonth !== cycleYearMonth
          || existingRequest.cycleYearMonth !== cycleYearMonth
          || existingRequest.monthCloseTargetYearMonth !== monthCloseTargetYearMonth
          || existingRequest.throughMonth !== monthCloseTargetYearMonth
          || !['REJECTED', 'WITHDRAWN', 'REOPENED'].includes(existingRequest.status)
          || !Number.isSafeInteger(existingEvidenceRevision)
          || existingEvidenceRevision < 1) {
          throw createHttpError(
            409,
            '이미 이 월의 결산 요청이 존재합니다.',
            'cashflow_month_close_request_conflict',
          );
        }
        evidenceRevision = existingEvidenceRevision + 1;
      } else {
        evidenceRevision = 1;
      }
      if (!Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1) {
        throw createHttpError(
          409,
          '저장된 월 결산 staging 근거가 변경되었습니다.',
          'cashflow_month_close_request_evidence_tampered',
        );
      }

      const evidence = evidenceFor(evidenceRevision);
      const shardRefs = evidence.shards.map((shard) => db.doc(cashflowMonthCloseRequestMonthPath(
        req.context.tenantId,
        requestId,
        evidenceRevision,
        shard.yearMonth,
      )));
      const shardSnapshots = await Promise.all(shardRefs.map((ref) => transaction.get(ref)));
      if (storedStage) {
        if (storedStage.requestFingerprint !== requestFingerprint) {
          throw createHttpError(
            409,
            '동일한 요청 키의 월 결산 입력이 변경되었습니다.',
            'cashflow_month_close_request_conflict',
          );
        }
        const validStage = storedStage.documentType === 'EVIDENCE_STAGE'
          && storedStage.contractVersion === CASHFLOW_CUMULATIVE_CLOSE_CONTRACT
          && storedStage.status === 'STAGED'
          && storedStage.stageId === stageId
          && storedStage.requestId === requestId
          && storedStage.tenantId === req.context.tenantId
          && storedStage.projectId === prepared.rawProjectId
          && storedStage.yearMonth === cycleYearMonth
          && storedStage.cycleYearMonth === cycleYearMonth
          && storedStage.monthCloseTargetYearMonth === monthCloseTargetYearMonth
          && storedStage.throughMonth === monthCloseTargetYearMonth
          && storedStage.evidenceRevision === evidenceRevision
          && storedStage.manifestHash === evidence.manifest.manifestHash
          && storedStage.payloadFingerprint === evidence.payloadFingerprint
          && storedStage.expectedWorkflowRevision === prepared.expectedWorkflowRevision
          && storedStage.expectedProjectVersion === expectedProjectVersion
          && storedStage.approverUid === expectedApproverUid
          && storedStage.requestedByUid === actorUid
          && storedStage.createIdempotencyKey === idempotencyKey
          && shardSnapshots.every((snapshot, index) => snapshot.exists
            && stableStringify(snapshot.data() || {}) === stableStringify(evidence.shards[index]));
        if (!validStage) {
          throw createHttpError(
            409,
            '저장된 월 결산 staging 근거가 변경되었습니다.',
            'cashflow_month_close_request_evidence_tampered',
          );
        }
        return { stage: storedStage, created: false };
      }

      shardSnapshots.forEach((snapshot, index) => {
        if (snapshot.exists
          && stableStringify(snapshot.data() || {}) !== stableStringify(evidence.shards[index])) {
          throw createHttpError(
            409,
            '저장된 누적 월 결산 월 근거가 변경되었습니다.',
            'cashflow_month_close_request_evidence_tampered',
          );
        }
      });
      const requestedAt = now().toISOString();
      const stage = {
        documentType: 'EVIDENCE_STAGE',
        contractVersion: CASHFLOW_CUMULATIVE_CLOSE_CONTRACT,
        stageId,
        requestId,
        tenantId: req.context.tenantId,
        projectId: prepared.rawProjectId,
        yearMonth: cycleYearMonth,
        cycleYearMonth,
        monthCloseTargetYearMonth,
        fromMonth: CASHFLOW_CUMULATIVE_CLOSE_FROM_MONTH,
        throughMonth: monthCloseTargetYearMonth,
        scope: cashflowCumulativeCloseScope(cycleYearMonth),
        status: 'STAGED',
        revision: evidenceRevision,
        evidenceRevision,
        manifestHash: evidence.manifest.manifestHash,
        monthCount: evidence.shards.length,
        weekCount: evidence.shards.length * 5,
        cellCount: evidence.shards.length * CASHFLOW_MONTH_CELL_COUNT,
        source: prepared.shardSource,
        totals: evidence.totals,
        annualSummaries: evidence.annualSummaries,
        expectedWorkflowRevision: prepared.expectedWorkflowRevision,
        expectedProjectVersion,
        approverUid,
        requestedByUid: actorUid,
        requestedAt,
        expiresAt: new Date(new Date(requestedAt).getTime() + 24 * 60 * 60 * 1_000).toISOString(),
        createIdempotencyKey: idempotencyKey,
        requestFingerprint,
        payloadFingerprint: evidence.payloadFingerprint,
        reviewWarnings: prepared.reviewWarnings,
      };
      assertCashflowMonthCloseRequestSize(stage);
      shardSnapshots.forEach((snapshot, index) => {
        if (!snapshot.exists) transaction.set(shardRefs[index], evidence.shards[index]);
      });
      transaction.set(stageRef, stage);
      return { stage, created: true };
    });
  }

  function requireCanonicalCashflowSettlementCycleStage(stage, expected) {
    const scope = objectValue(stage?.scope);
    const monthCount = cumulativeCloseMonths(expected.cycleYearMonth).length;
    if (!objectValue(stage)
      || stage.documentType !== 'EVIDENCE_STAGE'
      || stage.contractVersion !== CASHFLOW_CUMULATIVE_CLOSE_CONTRACT
      || stage.status !== 'STAGED'
      || stage.stageId !== expected.stageId
      || stage.requestId !== expected.requestId
      || stage.tenantId !== expected.tenantId
      || stage.projectId !== expected.projectId
      || stage.yearMonth !== expected.cycleYearMonth
      || stage.cycleYearMonth !== expected.cycleYearMonth
      || stage.monthCloseTargetYearMonth !== expected.monthCloseTargetYearMonth
      || stage.fromMonth !== CASHFLOW_CUMULATIVE_CLOSE_FROM_MONTH
      || stage.throughMonth !== expected.monthCloseTargetYearMonth
      || !scope
      || scope.contractVersion !== CASHFLOW_CUMULATIVE_CLOSE_CONTRACT
      || scope.fromMonth !== CASHFLOW_CUMULATIVE_CLOSE_FROM_MONTH
      || scope.cycleYearMonth !== expected.cycleYearMonth
      || scope.throughMonth !== expected.monthCloseTargetYearMonth
      || scope.monthCount !== monthCount
      || scope.weekCount !== monthCount * 5
      || scope.cellCount !== monthCount * CASHFLOW_MONTH_CELL_COUNT
      || !Number.isSafeInteger(stage.evidenceRevision)
      || stage.evidenceRevision < 1
      || stage.revision !== stage.evidenceRevision
      || !/^sha256:[a-f0-9]{64}$/.test(stage.manifestHash)
      || stage.expectedWorkflowRevision !== expected.expectedWorkflowRevision
      || stage.expectedProjectVersion !== expected.expectedProjectVersion
      || stage.approverUid !== expected.expectedApproverUid
      || stage.requestedByUid !== expected.actorUid
      || stage.createIdempotencyKey !== expected.idempotencyKey
      || stage.requestFingerprint !== expected.requestFingerprint
      || !/^sha256:[a-f0-9]{64}$/.test(stage.payloadFingerprint)) {
      throw createHttpError(
        409,
        '저장된 월 결산 staging 근거가 변경되었습니다.',
        'cashflow_month_close_request_evidence_tampered',
      );
    }
    return stage;
  }

  async function readCanonicalCashflowSettlementCycleState(req, projectId, cycleYearMonth) {
    const source = await proxyJavaWeeklyRequest({
      context: req.context,
      method: 'GET',
      path: `/api/v1/cashflow/${encodeURIComponent(projectId)}/month-close/dashboard-source?yearMonth=${encodeURIComponent(cycleYearMonth)}&settlementCycle=true`,
      retry: false,
    });
    const context = requireCashflowSettlementCycleReadContext(source, {
      projectId,
      cycleYearMonth,
    });
    const record = await readAlignedCashflowSettlementCycleRequest({
      db,
      tenantId: req.context.tenantId,
      projectId,
      context,
    });
    return { source, context, record };
  }

  async function submitStagedCashflowSettlementCycle(req, stage, expected) {
    if (!objectValue(stage)) {
      throw createHttpError(
        502,
        'JVM 월 결산 접수 근거를 확인하지 못했습니다.',
        'cashflow_settlement_cycle_readback_invalid',
      );
    }
    const expectation = {
      ...expected,
      evidenceRevision: stage.evidenceRevision,
      manifestHash: stage.manifestHash,
    };
    requireCanonicalCashflowSettlementCycleStage(stage, expectation);
    const receipt = requireCashflowSettlementCycleSubmitReceipt(await proxyMutation(
      req,
      `/api/v1/cashflow/${encodeURIComponent(expectation.projectId)}/settlement-cycle/submit`,
      {
        idempotencyKey: expectation.idempotencyKey,
        cycleYearMonth: expectation.cycleYearMonth,
        monthCloseTargetYearMonth: expectation.monthCloseTargetYearMonth,
        requestId: expectation.requestId,
        stageId: expectation.stageId,
        evidenceRevision: expectation.evidenceRevision,
        manifestHash: expectation.manifestHash,
        expectedWorkflowRevision: expectation.expectedWorkflowRevision,
        expectedApproverUid: expectation.expectedApproverUid,
        expectedProjectVersion: expectation.expectedProjectVersion,
      },
      { cashflowWrite: true, deadlineAtMs: Date.now() + monthCloseRouteTimeoutMs },
    ), expectation);
    const { context, record } = await readCanonicalCashflowSettlementCycleState(
      req,
      expectation.projectId,
      expectation.cycleYearMonth,
    );
    if (!record
      || context.businessState !== receipt.businessState
      || context.health !== 'OK'
      || context.requestId !== receipt.requestId
      || context.requestCycleYearMonth !== receipt.cycleYearMonth
      || context.requestTargetYearMonth !== receipt.monthCloseTargetYearMonth
      || context.workflowRevision !== receipt.workflowRevision
      || record.status !== 'PENDING_APPROVAL'
      || record.requestId !== receipt.requestId
      || record.evidenceRevision !== receipt.evidenceRevision
      || record.revision !== receipt.evidenceRevision
      || record.workflowRevision !== receipt.workflowRevision
      || record.manifestHash !== receipt.manifestHash
      || record.requestedByUid !== receipt.submittedByUid
      || record.approverUid !== receipt.approverUid) {
      throw createHttpError(
        502,
        'JVM 월 결산 접수 상태를 다시 확인하지 못했습니다.',
        'cashflow_settlement_cycle_readback_invalid',
      );
    }
    return record;
  }

  async function approveCanonicalCashflowSettlementCycle(req, { projectId, requestId }) {
    const body = objectValue(req.body);
    const evidenceRevision = body?.expectedRevision;
    const manifestHash = body?.expectedManifestHash;
    const reason = body?.reason === undefined ? '' : body.reason;
    const idempotencyKey = req.context.idempotencyKey;
    const requestPrefix = `${projectId}-`;
    const cycleYearMonth = typeof requestId === 'string' && requestId.startsWith(requestPrefix)
      ? requestId.slice(requestPrefix.length)
      : '';
    if (!body
      || body.decision !== 'APPROVE'
      || typeof projectId !== 'string'
      || !projectId
      || projectId.trim() !== projectId
      || projectId.includes('/')
      || typeof requestId !== 'string'
      || requestId !== `${projectId}-${cycleYearMonth}`
      || requestId.includes('/')
      || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(cycleYearMonth)
      || !Number.isSafeInteger(evidenceRevision)
      || evidenceRevision < 1
      || typeof manifestHash !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(manifestHash)
      || typeof reason !== 'string'
      || reason.trim() !== reason
      || reason.length > 1_000
      || typeof idempotencyKey !== 'string'
      || !idempotencyKey
      || idempotencyKey.trim() !== idempotencyKey) {
      throw createHttpError(400, '월 결산 검토 입력값이 올바르지 않습니다.', 'cashflow_month_close_review_invalid');
    }
    requireMutableCashflowSettlementCycle(cycleYearMonth);

    const monthCloseTargetYearMonth = previousYearMonth(cycleYearMonth);
    const before = await readCanonicalCashflowSettlementCycleState(req, projectId, cycleYearMonth);
    const monthClose = objectValue(before.source?.monthClose);
    const initial = before.context.businessState === 'SUBMITTED'
      && before.record?.status === 'PENDING_APPROVAL'
      && monthClose?.status === 'OPEN';
    const replay = before.context.businessState === 'LOCKED'
      && before.record?.status === 'APPROVED'
      && monthClose?.status === 'CLOSED'
      && before.record?.reviewIdempotencyKey === idempotencyKey
      && before.record?.decisionReason === reason;
    const currentMonthCloseRevision = monthClose?.revision;
    const monthCloseRevision = initial
      ? currentMonthCloseRevision
      : Number.isSafeInteger(currentMonthCloseRevision) ? currentMonthCloseRevision - 1 : -1;
    const expectedWorkflowRevision = initial
      ? before.context.workflowRevision
      : before.context.workflowRevision - 1;
    if (before.context.health !== 'OK'
      || (!initial && !replay)
      || before.context.requestId !== requestId
      || before.context.requestCycleYearMonth !== cycleYearMonth
      || before.context.requestTargetYearMonth !== monthCloseTargetYearMonth
      || before.record?.requestId !== requestId
      || before.record?.revision !== evidenceRevision
      || before.record?.evidenceRevision !== evidenceRevision
      || before.record?.manifestHash !== manifestHash
      || before.record?.workflowRevision !== before.context.workflowRevision
      || monthClose?.projectId !== projectId
      || monthClose?.yearMonth !== cycleYearMonth
      || !Number.isSafeInteger(monthCloseRevision)
      || monthCloseRevision < 0
      || (replay && (before.record?.ledgerRevision !== currentMonthCloseRevision
        || before.context.ledgerRevision !== currentMonthCloseRevision
        || before.context.rootHash !== manifestHash))) {
      throw createHttpError(
        409,
        '이미 검토가 시작되었거나 변경된 월 결산 요청입니다.',
        'cashflow_month_close_request_already_reviewed',
      );
    }
    const capability = before.context.commandCapabilities.APPROVE_MONTH_CLOSE;
    if (initial && capability.allowed !== true) {
      throw createHttpError(
        capability.reasonCode === 'NOT_CURRENT_APPROVER' ? 403 : 409,
        '지정된 승인자만 월 결산 요청을 검토할 수 있습니다.',
        'cashflow_month_close_approver_mismatch',
      );
    }

    const expectation = {
      projectId, cycleYearMonth, monthCloseTargetYearMonth, requestId,
      evidenceRevision, manifestHash, monthCloseRevision, expectedWorkflowRevision,
      actorUid: req.context.actorId,
    };
    const closeBody = {
      idempotencyKey,
      yearMonth: cycleYearMonth,
      expectedRevision: monthCloseRevision,
      expectedDraftRevision: 0,
      humanReviewed: true,
      requestId,
      requestRevision: evidenceRevision,
      manifestHash,
      cycleYearMonth,
      monthCloseTargetYearMonth,
      expectedWorkflowRevision,
      decisionReason: reason,
    };
    requireCashflowSettlementCycleApprovalReceipt(await proxyMutation(
      req,
      `/api/v1/cashflow/${encodeURIComponent(projectId)}/month-close`,
      closeBody,
      { cashflowWrite: true, deadlineAtMs: Date.now() + monthCloseRouteTimeoutMs },
    ), expectation);
    const after = await readCanonicalCashflowSettlementCycleState(req, projectId, cycleYearMonth);
    const closed = objectValue(after.source?.monthClose);
    if (initial) notifyCashflowMonthCloseSlack({ tenantId: req.context.tenantId, record: after.record, event: 'APPROVED' });
    return { record: after.record, monthClose: closed };
  }

  async function mutateCanonicalCashflowMonthReopen(req, { projectId, decision = '' }) {
    const body = objectValue(req.body);
    const requestId = body?.requestId;
    const cycleYearMonth = body?.yearMonth;
    const ledgerRevision = body?.expectedRevision;
    const reason = body?.reason;
    const idempotencyKey = req.context.idempotencyKey;
    if (!body
      || typeof projectId !== 'string'
      || !projectId
      || projectId.trim() !== projectId
      || projectId.includes('/')
      || typeof requestId !== 'string'
      || requestId !== `${projectId}-${cycleYearMonth}`
      || requestId.includes('/')
      || typeof cycleYearMonth !== 'string'
      || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(cycleYearMonth)
      || !Number.isSafeInteger(ledgerRevision)
      || ledgerRevision < 1
      || typeof reason !== 'string'
      || !reason
      || reason.trim() !== reason
      || reason.length > 1_000
      || !['', 'APPROVE', 'REJECT'].includes(decision)
      || (decision && body.decision !== decision)
      || typeof idempotencyKey !== 'string'
      || !idempotencyKey
      || idempotencyKey.trim() !== idempotencyKey) {
      throw createHttpError(400, '월 결산 재오픈 요청값이 올바르지 않습니다.', 'cashflow_month_reopen_invalid');
    }
    requireMutableCashflowSettlementCycle(cycleYearMonth);

    const before = await readCanonicalCashflowSettlementCycleState(req, projectId, cycleYearMonth);
    const monthCloseTargetYearMonth = previousYearMonth(cycleYearMonth);
    const monthClose = objectValue(before.source?.latestRun);
    const recordLedgerRevision = before.record?.ledgerRevision;
    const event = objectValue(decision ? before.record?.reopenDecision : before.record?.reopenRequest);
    const initial = decision
      ? before.context.businessState === 'REOPEN_REQUESTED'
        && before.record?.status === 'REOPEN_REQUESTED'
        && monthClose?.status === 'REOPEN_REQUESTED'
        && recordLedgerRevision === ledgerRevision
        && monthClose?.revision === ledgerRevision
      : before.context.businessState === 'LOCKED'
        && before.record?.status === 'APPROVED'
        && monthClose?.status === 'CLOSED'
        && recordLedgerRevision === ledgerRevision
        && monthClose?.revision === ledgerRevision;
    const terminalBusinessState = decision === 'APPROVE' ? 'REOPENED' : 'LOCKED';
    const terminalRecordStatus = decision === 'APPROVE' ? 'REOPENED' : 'APPROVED';
    const terminalMonthStatus = decision === 'APPROVE' ? 'OPEN' : 'CLOSED';
    const replay = decision
      ? before.context.businessState === terminalBusinessState
        && before.record?.status === terminalRecordStatus
        && monthClose?.status === terminalMonthStatus
        && recordLedgerRevision === ledgerRevision + 1
        && monthClose?.revision === ledgerRevision + 1
        && event?.idempotencyKey === idempotencyKey
        && event?.decision === decision
        && event?.reason === reason
      : before.context.businessState === 'REOPEN_REQUESTED'
        && before.record?.status === 'REOPEN_REQUESTED'
        && monthClose?.status === 'REOPEN_REQUESTED'
        && recordLedgerRevision === ledgerRevision + 1
        && monthClose?.revision === ledgerRevision + 1
        && event?.idempotencyKey === idempotencyKey
        && event?.reason === reason;
    const evidenceRevision = before.record?.evidenceRevision;
    const manifestHash = before.record?.manifestHash;
    const expectedWorkflowRevision = initial
      ? before.context.workflowRevision
      : before.context.workflowRevision - 1;
    if (before.context.health !== 'OK'
      || (!initial && !replay)
      || before.context.requestId !== requestId
      || before.context.requestCycleYearMonth !== cycleYearMonth
      || before.context.requestTargetYearMonth !== monthCloseTargetYearMonth
      || before.record?.requestId !== requestId
      || !Number.isSafeInteger(evidenceRevision)
      || evidenceRevision < 1
      || before.record?.revision !== evidenceRevision
      || typeof manifestHash !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(manifestHash)
      || !Number.isSafeInteger(expectedWorkflowRevision)
      || expectedWorkflowRevision < 0
      || monthClose?.projectId !== projectId
      || monthClose?.yearMonth !== cycleYearMonth
      || monthClose?.requestId !== requestId
      || monthClose?.requestRevision !== evidenceRevision
      || monthClose?.manifestHash !== manifestHash
      || monthClose?.rootHash !== manifestHash
      || (before.context.rootHash && before.context.rootHash !== manifestHash)) {
      throw createHttpError(409, '변경되었거나 처리된 재오픈 요청입니다.', 'cashflow_month_reopen_conflict');
    }
    const capabilityName = decision
      ? `${decision}_MONTH_REOPEN`
      : 'REQUEST_MONTH_REOPEN';
    if (initial && before.context.commandCapabilities[capabilityName].allowed !== true) {
      throw createHttpError(
        decision ? 403 : 409,
        '현재 월 결산 재오픈 작업을 수행할 수 없습니다.',
        'cashflow_month_reopen_conflict',
      );
    }

    const commandName = decision ? 'cashflowMonth.decideReopen' : 'cashflowMonth.requestReopen';
    const expectedStatus = decision ? terminalMonthStatus : 'REOPEN_REQUESTED';
    const expectation = {
      commandName, projectId, cycleYearMonth, requestId, ledgerRevision,
      evidenceRevision, manifestHash, expectedWorkflowRevision, reason, decision,
      actorUid: req.context.actorId, status: expectedStatus,
    };
    const commandBody = {
      idempotencyKey,
      yearMonth: cycleYearMonth,
      expectedRevision: ledgerRevision,
      ...(decision ? { decision } : {}),
      reason,
      requestId,
      cycleYearMonth,
      monthCloseTargetYearMonth,
      evidenceRevision,
      manifestHash,
      expectedWorkflowRevision,
    };
    const receipt = requireCashflowSettlementCycleReopenReceipt(await proxyMutation(
      req,
      `/api/v1/cashflow/${encodeURIComponent(projectId)}/month-close/${decision ? 'reopen-decision' : 'reopen-request'}`,
      commandBody,
      { cashflowWrite: true, deadlineAtMs: Date.now() + monthCloseRouteTimeoutMs },
    ), expectation);
    const after = await readCanonicalCashflowSettlementCycleState(req, projectId, cycleYearMonth);
    const afterMonthClose = objectValue(after.source?.latestRun);
    const afterEvent = objectValue(decision ? after.record?.reopenDecision : after.record?.reopenRequest);
    const expectedBusinessState = decision ? terminalBusinessState : 'REOPEN_REQUESTED';
    const expectedRecordStatus = decision ? terminalRecordStatus : 'REOPEN_REQUESTED';
    const eventAt = decision ? 'decidedAt' : 'requestedAt';
    const eventBy = decision ? 'decidedByUid' : 'requestedByUid';
    const receiptAt = decision ? receipt.reopenDecidedAt : receipt.reopenRequestedAt;
    const receiptBy = decision ? receipt.reopenDecidedByUid : receipt.reopenRequestedByUid;
    if (!after.record
      || after.context.health !== 'OK'
      || after.context.businessState !== expectedBusinessState
      || after.context.workflowRevision !== expectedWorkflowRevision + 1
      || after.context.requestId !== requestId
      || after.context.requestCycleYearMonth !== cycleYearMonth
      || after.context.requestTargetYearMonth !== monthCloseTargetYearMonth
      || after.record.requestId !== requestId
      || after.record.status !== expectedRecordStatus
      || after.record.revision !== evidenceRevision
      || after.record.evidenceRevision !== evidenceRevision
      || after.record.manifestHash !== manifestHash
      || after.record.ledgerRevision !== receipt.revision
      || after.record.workflowRevision !== expectedWorkflowRevision + 1
      || afterEvent?.reason !== reason
      || afterEvent?.idempotencyKey !== idempotencyKey
      || (decision && afterEvent?.decision !== decision)
      || afterEvent?.[eventAt] !== receiptAt
      || afterEvent?.[eventBy] !== receiptBy
      || afterMonthClose?.projectId !== projectId
      || afterMonthClose?.yearMonth !== cycleYearMonth
      || afterMonthClose?.status !== receipt.status
      || afterMonthClose?.revision !== receipt.revision
      || afterMonthClose?.requestId !== requestId
      || afterMonthClose?.requestRevision !== evidenceRevision
      || afterMonthClose?.manifestHash !== manifestHash
      || afterMonthClose?.rootHash !== manifestHash) {
      throw createHttpError(
        502,
        'JVM 월 결산 재오픈 상태를 다시 확인하지 못했습니다.',
        'cashflow_settlement_cycle_readback_invalid',
      );
    }
    return after.record;
  }

  async function transitionCanonicalCashflowSettlementCycle(req, {
    projectId,
    requestId,
    action,
  }) {
    const body = objectValue(req.body);
    const cycleYearMonth = body?.cycleYearMonth;
    const monthCloseTargetYearMonth = body?.monthCloseTargetYearMonth;
    const evidenceRevision = body?.expectedRevision;
    const manifestHash = body?.expectedManifestHash;
    const expectedWorkflowRevision = body?.expectedWorkflowRevision;
    const reason = body?.reason;
    const idempotencyKey = req.context.idempotencyKey;
    const invalidCode = action === 'WITHDRAW'
      ? 'cashflow_month_close_withdraw_invalid'
      : 'cashflow_month_close_review_invalid';
    if (!body
      || typeof projectId !== 'string'
      || !projectId
      || projectId.trim() !== projectId
      || projectId.includes('/')
      || typeof requestId !== 'string'
      || !requestId
      || requestId.trim() !== requestId
      || requestId.includes('/')
      || typeof cycleYearMonth !== 'string'
      || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(cycleYearMonth)
      || typeof monthCloseTargetYearMonth !== 'string'
      || monthCloseTargetYearMonth !== previousYearMonth(cycleYearMonth)
      || requestId !== `${projectId}-${cycleYearMonth}`
      || !Number.isSafeInteger(evidenceRevision)
      || evidenceRevision < 1
      || typeof manifestHash !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(manifestHash)
      || !Number.isSafeInteger(expectedWorkflowRevision)
      || expectedWorkflowRevision < 0
      || typeof reason !== 'string'
      || reason.trim() !== reason
      || (action === 'REJECT' && body.decision !== 'REJECT')
      || (action === 'REJECT' && !reason)
      || reason.length > 1_000
      || typeof idempotencyKey !== 'string'
      || !idempotencyKey
      || idempotencyKey.trim() !== idempotencyKey) {
      throw createHttpError(400, action === 'WITHDRAW'
        ? '월 결산 회수 입력값이 올바르지 않습니다.'
        : '월 결산 검토 입력값이 올바르지 않습니다.', invalidCode);
    }
    requireMutableCashflowSettlementCycle(cycleYearMonth);

    const before = await readCanonicalCashflowSettlementCycleState(req, projectId, cycleYearMonth);
    const businessState = action === 'WITHDRAW' ? 'WITHDRAWN' : 'REJECTED';
    const capabilityName = action === 'WITHDRAW' ? 'WITHDRAW_MONTH_CLOSE' : 'REJECT_MONTH_CLOSE';
    const initial = before.context.businessState === 'SUBMITTED'
      && before.context.workflowRevision === expectedWorkflowRevision
      && before.record?.status === 'PENDING_APPROVAL';
    const replay = before.context.businessState === businessState
      && before.context.workflowRevision === expectedWorkflowRevision + 1
      && before.record?.status === businessState;
    if (before.context.health !== 'OK'
      || (!initial && !replay)
      || before.context.requestId !== requestId
      || before.context.requestCycleYearMonth !== cycleYearMonth
      || before.context.requestTargetYearMonth !== monthCloseTargetYearMonth
      || before.record?.requestId !== requestId
      || before.record?.revision !== evidenceRevision
      || before.record?.evidenceRevision !== evidenceRevision
      || before.record?.manifestHash !== manifestHash
      || before.record?.workflowRevision !== before.context.workflowRevision) {
      throw createHttpError(
        409,
        '이미 처리되었거나 변경된 월 결산 요청입니다.',
        'cashflow_month_close_request_already_reviewed',
      );
    }
    const capability = before.context.commandCapabilities[capabilityName];
    if (initial && capability.allowed !== true) {
      const forbidden = (action === 'WITHDRAW' && capability.reasonCode === 'NOT_REQUESTER')
        || (action === 'REJECT' && capability.reasonCode === 'NOT_CURRENT_APPROVER');
      throw createHttpError(
        forbidden ? 403 : 409,
        action === 'WITHDRAW'
          ? '요청한 본인만 월 결산 요청을 회수할 수 있습니다.'
          : '지정된 승인자만 월 결산 요청을 반려할 수 있습니다.',
        action === 'WITHDRAW'
          ? 'cashflow_month_close_withdraw_forbidden'
          : 'cashflow_month_close_approver_mismatch',
      );
    }
    const expectation = {
      projectId,
      cycleYearMonth,
      monthCloseTargetYearMonth,
      requestId,
      businessState,
      evidenceRevision,
      manifestHash,
      expectedWorkflowRevision,
      submittedAt: before.record.requestedAt,
      submittedByUid: before.record.requestedByUid,
      approverUid: before.record.approverUid,
      actorUid: req.context.actorId,
      reason,
    };
    const receipt = requireCashflowSettlementCycleTransitionReceipt(await proxyMutation(
      req,
      `/api/v1/cashflow/${encodeURIComponent(projectId)}/settlement-cycle/transition`,
      {
        idempotencyKey,
        action,
        cycleYearMonth,
        monthCloseTargetYearMonth,
        requestId,
        evidenceRevision,
        manifestHash,
        expectedWorkflowRevision,
        reason,
      },
      { cashflowWrite: true, deadlineAtMs: Date.now() + monthCloseRouteTimeoutMs },
    ), expectation);
    const after = await readCanonicalCashflowSettlementCycleState(req, projectId, cycleYearMonth);
    const decidedAtField = action === 'WITHDRAW' ? 'withdrawnAt' : 'reviewedAt';
    const decidedByField = action === 'WITHDRAW' ? 'withdrawnByUid' : 'reviewedByUid';
    const reasonField = action === 'WITHDRAW' ? 'withdrawReason' : 'decisionReason';
    if (!after.record
      || after.context.health !== 'OK'
      || after.context.businessState !== receipt.businessState
      || after.context.workflowRevision !== receipt.workflowRevision
      || after.context.requestId !== receipt.requestId
      || after.context.requestCycleYearMonth !== receipt.cycleYearMonth
      || after.context.requestTargetYearMonth !== receipt.monthCloseTargetYearMonth
      || after.record.status !== businessState
      || after.record.requestId !== receipt.requestId
      || after.record.revision !== receipt.evidenceRevision
      || after.record.evidenceRevision !== receipt.evidenceRevision
      || after.record.workflowRevision !== receipt.workflowRevision
      || after.record.manifestHash !== receipt.manifestHash
      || after.record.requestedAt !== receipt.submittedAt
      || after.record.requestedByUid !== receipt.submittedByUid
      || after.record.approverUid !== receipt.approverUid
      || after.record[decidedAtField] !== receipt.decidedAt
      || after.record[decidedByField] !== receipt.decidedByUid
      || after.record[reasonField] !== receipt.reason) {
      throw createHttpError(
        502,
        'JVM 월 결산 전이 상태를 다시 확인하지 못했습니다.',
        'cashflow_settlement_cycle_readback_invalid',
      );
    }
    return after.record;
  }

  app.get('/api/v1/cashflow/month-close/requests/pending', asyncHandler(async (req, res) => {
    if (!db?.doc || !db?.collection) {
      throw createHttpError(503, '월 결산 요청 저장소에 연결하지 못했습니다.', 'cashflow_month_close_request_store_unavailable');
    }
    const actorId = readOptionalText(req.context.actorId);
    await readActiveCashflowMember({ db, tenantId: req.context.tenantId, actorId });
    const snapshot = await db.collection(`orgs/${req.context.tenantId}/cashflow_month_close_requests`)
      .where('approverUid', '==', actorId)
      .limit(100)
      .get();
    const candidates = snapshot.docs
      .map((doc) => doc.data() || {})
      .filter((record) => record.documentType === 'REQUEST'
        && record.contractVersion === CASHFLOW_CUMULATIVE_CLOSE_CONTRACT
        && /^20\d{2}-(0[1-9]|1[0-2])$/.test(readOptionalText(record.cycleYearMonth))
        && record.cycleYearMonth >= CASHFLOW_SETTLEMENT_CYCLE_CUTOFF_MONTH
        && record.status === 'PENDING_APPROVAL'
        && record.approverUid === actorId);
    const canonicalMatches = await Promise.all(candidates.map(async (record) => {
      const projectSnapshot = await db.doc(`orgs/${req.context.tenantId}/projects/${record.projectId}`).get();
      return projectSnapshot.exists
        && readOptionalText(projectSnapshot.data()?.executiveApproverId) === actorId;
    }));
    const visibleRecords = candidates.filter((_record, index) => canonicalMatches[index]);
    const items = (await Promise.all(visibleRecords.map(async (record) => cashflowMonthCloseRequestView(
      record,
      await readCashflowRequestPartyNames({ db, tenantId: req.context.tenantId, record }),
    ))))
      .sort((left, right) => String(right.requestedAt).localeCompare(String(left.requestedAt)));
    res.status(200).json({ items, count: items.length });
  }));

  app.post('/api/v1/cashflow/:projectId/month-close/approver', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, CASHFLOW_MONTH_WORKFLOW_ROLES, 'set cashflow month-close approver', authMode, workspaceEmailDomain);
    assertAlignedCashflowMutation();
    if (!db?.doc || !db?.runTransaction) {
      throw createHttpError(503, '프로젝트 조직장 저장소에 연결하지 못했습니다.', 'cashflow_month_close_request_store_unavailable');
    }
    const projectId = readOptionalText(req.params.projectId);
    const approverUid = readOptionalText(req.body?.approverUid);
    const yearMonth = readOptionalText(req.body?.yearMonth);
    const expectedVersion = req.body?.expectedVersion;
    if (
      !projectId || projectId.includes('/')
      || !approverUid || approverUid.includes('/')
      || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth)
      || (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0))
    ) {
      throw createHttpError(400, '프로젝트 조직장 지정값이 올바르지 않습니다.', 'cashflow_month_close_approver_invalid');
    }
    requireMutableCashflowSettlementCycle(yearMonth);
    await assertCashflowMonthActionAccess({
      db, req, projectId, authMode, workspaceEmailDomain,
    });
    const actorId = readOptionalText(req.context.actorId);
    const projectRef = db.doc(`orgs/${req.context.tenantId}/projects/${projectId}`);
    const actorRef = db.doc(`orgs/${req.context.tenantId}/members/${actorId}`);
    const approverRef = db.doc(`orgs/${req.context.tenantId}/members/${approverUid}`);
    const requestId = `${projectId}-${yearMonth}`;
    const coordinatorRef = cashflowSettlementCycleCoordinatorRef(db, req.context.tenantId, projectId);
    const updatedAt = now().toISOString();
    let result;

    await db.runTransaction(async (transaction) => {
      const [projectSnapshot, actorSnapshot, approverSnapshot, coordinatorSnapshot] = await Promise.all([
        transaction.get(projectRef),
        transaction.get(actorRef),
        transaction.get(approverRef),
        transaction.get(coordinatorRef),
      ]);
      if (!projectSnapshot.exists) {
        throw createHttpError(404, '프로젝트를 찾을 수 없습니다.', 'not_found');
      }
      const project = projectSnapshot.data() || {};
      const actor = actorSnapshot.exists ? actorSnapshot.data() || {} : null;
      const approver = approverSnapshot.exists ? approverSnapshot.data() || {} : null;
      if (
        !actor
        || readOptionalText(actor.uid) !== actorId
        || readOptionalText(actor.status).toUpperCase() !== 'ACTIVE'
      ) {
        throw createHttpError(403, '활성 구성원만 프로젝트 조직장을 지정할 수 있습니다.', 'cashflow_month_close_member_inactive');
      }
      if (
        !approver
        || readOptionalText(approver.uid) !== approverUid
        || readOptionalText(approver.status).toUpperCase() !== 'ACTIVE'
      ) {
        throw createHttpError(403, '같은 조직의 활성 구성원만 조직장으로 지정할 수 있습니다.', 'cashflow_month_close_member_inactive');
      }
      const hasPendingRequest = hasCashflowApproverLockedRequest(coordinatorSnapshot, {
        tenantId: req.context.tenantId,
        projectId,
      });
      if (hasPendingRequest) {
        throw createHttpError(409, '승인 대기 중인 월 결산의 조직장은 변경할 수 없습니다.', 'cashflow_month_close_approver_locked');
      }
      const currentVersion = Number.isSafeInteger(project.version) ? project.version : 0;
      if (readOptionalText(project.executiveApproverId) === approverUid) {
        result = {
          projectId,
          executiveApproverId: approverUid,
          executiveApproverName: readOptionalText(project.executiveApproverName) || readOptionalText(approver.name),
          executiveApproverEmail: readOptionalText(project.executiveApproverEmail) || readOptionalText(approver.email),
          version: currentVersion,
          updatedAt: readOptionalText(project.updatedAt) || updatedAt,
        };
        return;
      }
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw createHttpError(409, '프로젝트 정보가 변경되었습니다. 새로고침 후 다시 지정해 주세요.', 'version_conflict');
      }
      const version = currentVersion + 1;
      result = {
        projectId,
        executiveApproverId: approverUid,
        executiveApproverName: readOptionalText(approver.name),
        executiveApproverEmail: readOptionalText(approver.email),
        version,
        updatedAt,
      };
      transaction.set(projectRef, {
        executiveApproverId: result.executiveApproverId,
        executiveApproverName: result.executiveApproverName,
        executiveApproverEmail: result.executiveApproverEmail,
        version,
        updatedAt,
        updatedBy: actorId,
      }, { merge: true });
      transaction.set(
        db.doc(cashflowMonthCloseRequestAuditPath(req.context.tenantId, requestId, version, 'approver-updated')),
        {
          requestId,
          projectId,
          yearMonth,
          action: 'APPROVER_UPDATED',
          revision: version,
          actorUid: actorId,
          approverUid,
          idempotencyKey: readOptionalText(req.context.idempotencyKey),
          createdAt: updatedAt,
        },
      );
    });

    res.status(200).json(result);
  }));

  app.get('/api/v1/cashflow/:projectId/month-close/requests/:requestId/months', asyncHandler(async (req, res) => {
    if (!db?.doc) throw createHttpError(503, '월 결산 요청 저장소에 연결하지 못했습니다.', 'cashflow_month_close_request_store_unavailable');
    const projectId = readOptionalText(req.params.projectId);
    const requestId = readOptionalText(req.params.requestId);
    const actorId = readOptionalText(req.context.actorId);
    const cursor = readOptionalText(req.query.cursor);
    const limit = req.query.limit === undefined ? 12 : Number(req.query.limit);
    if ((cursor && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(cursor)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 12) {
      throw createHttpError(400, '월 결산 월 목록 조회 범위가 올바르지 않습니다.', 'cashflow_month_close_request_invalid');
    }
    const requestSnapshot = await db.doc(cashflowMonthCloseRequestPath(req.context.tenantId, requestId)).get();
    const record = requestSnapshot.exists ? requestSnapshot.data() || {} : null;
    if (!record || record.projectId !== projectId || record.contractVersion !== CASHFLOW_CUMULATIVE_CLOSE_CONTRACT) {
      throw createHttpError(404, '월 결산 요청을 찾을 수 없습니다.', 'cashflow_month_close_request_not_found');
    }
    if (record.status === 'BUILDING') {
      throw createHttpError(409, '누적 월 결산 근거 저장이 아직 완료되지 않았습니다.', 'cashflow_month_close_request_building');
    }
    if (record.requestedByUid !== actorId) {
      const authority = requireAvailableCashflowMonthReopenAuthority(
        await readCanonicalCashflowMonthReopenAuthority(req, projectId),
      );
      if (!authority.canDecideReopen) {
        throw createHttpError(403, '이 월 결산 요청을 조회할 권한이 없습니다.', 'cashflow_month_close_request_forbidden');
      }
    }
    const allMonths = monthsBetween(record.fromMonth, readOptionalText(record.throughMonth) || record.yearMonth);
    const start = cursor ? allMonths.findIndex((month) => month >= cursor) : 0;
    const pageMonths = allMonths.slice(start < 0 ? allMonths.length : start, (start < 0 ? allMonths.length : start) + limit);
    const months = [];
    for (const month of pageMonths) {
      const snapshot = await db.doc(cashflowMonthCloseRequestMonthPath(
        req.context.tenantId, requestId, record.revision, month,
      )).get();
      const stored = snapshot.exists ? snapshot.data() || {} : null;
      const { shardHash, ...base } = stored || {};
      if (!stored || stored.cells?.length !== CASHFLOW_MONTH_CELL_COUNT || shardHash !== cashflowCloseHash(base)) {
        throw createHttpError(409, '저장된 누적 월 결산 근거가 손상되었습니다.', 'cashflow_month_close_request_evidence_tampered');
      }
      months.push(stored);
    }
    const nextIndex = (start < 0 ? allMonths.length : start) + pageMonths.length;
    res.status(200).json({
      requestId,
      requestRevision: record.revision,
      manifestHash: record.manifestHash,
      monthCount: record.monthCount,
      months,
      nextCursor: nextIndex < allMonths.length ? allMonths[nextIndex] : null,
    });
  }));

  app.get('/api/v1/cashflow/:projectId/month-close/requests/:requestId/revision-diff', asyncHandler(async (req, res) => {
    if (!db?.doc) throw createHttpError(503, '월 결산 요청 저장소에 연결하지 못했습니다.', 'cashflow_month_close_request_store_unavailable');
    const projectId = readOptionalText(req.params.projectId);
    const requestId = readOptionalText(req.params.requestId);
    const actorId = readOptionalText(req.context.actorId);
    const requestSnapshot = await db.doc(cashflowMonthCloseRequestPath(req.context.tenantId, requestId)).get();
    const record = requestSnapshot.exists ? requestSnapshot.data() || {} : null;
    if (!record || record.projectId !== projectId || record.contractVersion !== CASHFLOW_CUMULATIVE_CLOSE_CONTRACT) {
      throw createHttpError(404, '월 결산 요청을 찾을 수 없습니다.', 'cashflow_month_close_request_not_found');
    }
    if (record.requestedByUid !== actorId) {
      const authority = requireAvailableCashflowMonthReopenAuthority(
        await readCanonicalCashflowMonthReopenAuthority(req, projectId),
      );
      if (!authority.canDecideReopen) {
        throw createHttpError(403, '이 월 결산 요청을 조회할 권한이 없습니다.', 'cashflow_month_close_request_forbidden');
      }
    }
    const currentRevision = Number(record.revision);
    const throughMonth = readOptionalText(record.throughMonth) || record.yearMonth;
    if (!Number.isSafeInteger(currentRevision) || currentRevision < 1) {
      throw createHttpError(409, '월 결산 요청 revision이 올바르지 않습니다.', 'cashflow_month_close_request_evidence_invalid');
    }
    const readShard = async (revision) => {
      const snapshot = await db.doc(cashflowMonthCloseRequestMonthPath(
        req.context.tenantId, requestId, revision, throughMonth,
      )).get();
      const stored = snapshot.exists ? snapshot.data() || {} : null;
      const { shardHash, ...base } = stored || {};
      if (!stored
        || stored.requestId !== requestId
        || stored.projectId !== projectId
        || Number(stored.requestRevision) !== revision
        || stored.yearMonth !== throughMonth
        || stored.cells?.length !== CASHFLOW_MONTH_CELL_COUNT
        || shardHash !== cashflowCloseHash(base)) {
        throw createHttpError(409, '저장된 revision 비교 근거가 손상되었습니다.', 'cashflow_month_close_request_evidence_tampered');
      }
      return stored;
    };
    const current = await readShard(currentRevision);
    if (currentRevision === 1) {
      res.status(200).json({ requestId, yearMonth: throughMonth, currentRevision, previousRevision: null, changes: [] });
      return;
    }
    const previousRevision = currentRevision - 1;
    const previous = await readShard(previousRevision);
    const changes = buildCashflowMonthCloseRevisionChanges(previous.cells, current.cells);
    res.status(200).json({ requestId, yearMonth: throughMonth, currentRevision, previousRevision, changes });
  }));

  app.post('/api/v1/cashflow/:projectId/month-close/requests', asyncHandler(async (req, res) => {
    requireSettlementCycleMutation(req.body);
    assertWeeklyWorkspaceOrRoleAllowed(req, CASHFLOW_MONTH_WORKFLOW_ROLES, 'request cashflow month close', authMode, workspaceEmailDomain);
    assertAlignedCashflowMutation();
    if (!db?.doc || !db?.runTransaction) {
      throw createHttpError(503, '월 결산 요청 저장소에 연결하지 못했습니다.', 'cashflow_month_close_request_store_unavailable');
    }
    if (req.body?.contractVersion !== CASHFLOW_CUMULATIVE_CLOSE_CONTRACT) {
      throw createHttpError(
        409,
        '최신 월 결산 화면에서 다시 요청해 주세요.',
        'cashflow_settlement_cycle_contract_required',
      );
    }
    const rawProjectId = readOptionalText(req.params.projectId);
    const cycleYearMonth = req.body?.yearMonth;
    const expectedApproverUid = req.body?.expectedApproverUid;
    const expectedProjectVersion = req.body?.expectedProjectVersion;
    const expectedWorkflowRevision = requireExpectedWorkflowRevision(req.body);
    const actorUid = readOptionalText(req.context.actorId);
    const idempotencyKey = readOptionalText(req.context.idempotencyKey);
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(cycleYearMonth)
      || typeof expectedApproverUid !== 'string'
      || !expectedApproverUid
      || expectedApproverUid.trim() !== expectedApproverUid
      || !Number.isSafeInteger(expectedProjectVersion)
      || expectedProjectVersion < 0
      || !idempotencyKey) {
      throw createHttpError(
        400,
        '월 결산 회차와 확정한 프로젝트 조직장 정보가 필요합니다.',
        'cashflow_month_close_approver_expectation_required',
      );
    }
    await assertCashflowMonthActionAccess({
      db, req, projectId: rawProjectId, authMode, workspaceEmailDomain,
    });
    const approverUid = await readCanonicalCashflowApprover({
      db,
      tenantId: req.context.tenantId,
      projectId: rawProjectId,
    });
    if (approverUid !== expectedApproverUid) {
      throw createHttpError(
        409,
        '프로젝트 조직장 정보가 변경되었습니다. 다시 요청해 주세요.',
        'cashflow_month_close_approver_stale',
      );
    }

    const requestId = `${rawProjectId}-${cycleYearMonth}`;
    const requestFingerprint = cashflowCloseHash(req.body ?? null);
    const stageId = cashflowSettlementCycleSubmitStageId({ requestId, actorUid, idempotencyKey });
    const stageExpectation = {
      tenantId: req.context.tenantId,
      projectId: rawProjectId,
      cycleYearMonth,
      monthCloseTargetYearMonth: previousYearMonth(cycleYearMonth),
      requestId,
      stageId,
      expectedWorkflowRevision,
      actorUid,
      expectedApproverUid,
      expectedProjectVersion,
      idempotencyKey,
      requestFingerprint,
    };
    const stageRef = db.doc(
      `${cashflowMonthCloseRequestPath(req.context.tenantId, requestId)}/stages/${stageId}`,
    );
    const stageSnapshot = await stageRef.get();
    if (stageSnapshot.exists) {
      requireMutableCashflowSettlementCycle(cycleYearMonth);
      const stage = stageSnapshot.data() || {};
      if (stage.requestFingerprint !== requestFingerprint) {
        throw createHttpError(
          409,
          '동일한 요청 키의 월 결산 입력이 변경되었습니다.',
          'cashflow_month_close_request_conflict',
        );
      }
      const before = await readCanonicalCashflowSettlementCycleState(req, rawProjectId, cycleYearMonth);
      const shouldNotify = before.context.businessState !== 'SUBMITTED';
      const record = await submitStagedCashflowSettlementCycle(req, stage, stageExpectation);
      if (shouldNotify) {
        notifyCashflowMonthCloseSlack({ tenantId: req.context.tenantId, record, event: 'REQUESTED' });
      }
      res.status(202).json(cashflowMonthCloseRequestView(record));
      return;
    }

    const prepared = await prepareCashflowMonthClose(req);
    requireMutableCashflowSettlementCycle(cycleYearMonth);
    const staged = await stageCumulativeMonthCloseRequest({
      req, prepared, approverUid, expectedApproverUid, expectedProjectVersion,
    });
    const storedStageSnapshot = await stageRef.get();
    const storedStage = storedStageSnapshot.exists ? storedStageSnapshot.data() || null : null;
    const record = await submitStagedCashflowSettlementCycle(req, storedStage, stageExpectation);
    if (staged.created) {
      notifyCashflowMonthCloseSlack({ tenantId: req.context.tenantId, record, event: 'REQUESTED' });
    }
    res.status(202).json(cashflowMonthCloseRequestView(record));
  }));

  // 실무자가 올린 결산 요청을 조직장이 검토하기 전에 스스로 되돌린다.
  app.post('/api/v1/cashflow/:projectId/month-close/requests/:requestId/withdraw', asyncHandler(async (req, res) => {
    requireSettlementCycleMutation(req.body);
    assertWeeklyWorkspaceOrRoleAllowed(req, CASHFLOW_MONTH_WORKFLOW_ROLES, 'withdraw cashflow month close request', authMode, workspaceEmailDomain);
    assertAlignedCashflowMutation();
    if (!db?.doc) {
      throw createHttpError(503, '월 결산 요청 저장소에 연결하지 못했습니다.', 'cashflow_month_close_request_store_unavailable');
    }
    const projectId = req.params.projectId;
    const requestId = req.params.requestId;
    await assertCashflowMonthActionAccess({
      db, req, projectId, authMode, workspaceEmailDomain,
    });
    const withdrawn = await transitionCanonicalCashflowSettlementCycle(req, {
      projectId, requestId, action: 'WITHDRAW',
    });
    res.status(200).json({ request: cashflowMonthCloseRequestView(withdrawn) });
  }));

  app.post([
    '/api/v1/cashflow/:projectId/month-close/requests/:requestId/review',
    '/api/v1/cashflow/:projectId/month-close/requests/:requestId/status-review',
  ], asyncHandler(async (req, res) => {
    requireSettlementCycleMutation(req.body);
    assertAlignedCashflowMutation();
    if (readOptionalText(req.body?.decision).toUpperCase() === 'REJECT') {
      if (!db?.doc) {
        throw createHttpError(503, '월 결산 요청 저장소에 연결하지 못했습니다.', 'cashflow_month_close_request_store_unavailable');
      }
      await readActiveCashflowMember({
        db, tenantId: req.context.tenantId, actorId: req.context.actorId,
      });
      const rejected = await transitionCanonicalCashflowSettlementCycle(req, {
        projectId: req.params.projectId,
        requestId: req.params.requestId,
        action: 'REJECT',
      });
      res.status(200).json({ request: cashflowMonthCloseRequestView(rejected) });
      return;
    }
    if (!db?.doc) {
      throw createHttpError(503, '월 결산 요청 저장소에 연결하지 못했습니다.', 'cashflow_month_close_request_store_unavailable');
    }
    await readActiveCashflowMember({
      db, tenantId: req.context.tenantId, actorId: req.context.actorId,
    });
    const approved = await approveCanonicalCashflowSettlementCycle(req, {
      projectId: req.params.projectId,
      requestId: req.params.requestId,
    });
    res.status(200).json({
      request: cashflowMonthCloseRequestView(approved.record),
      monthClose: approved.monthClose,
    });

  }));

  app.post('/api/v1/cashflow/:projectId/month-close', createJavaMutatingProxyRoute(async (req) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, CASHFLOW_MONTH_WORKFLOW_ROLES, 'close cashflow month', authMode, workspaceEmailDomain);
    assertAlignedCashflowMutation();
    await prepareCashflowMonthClose(req);
    requireMutableCashflowSettlementCycle(readOptionalText(req.body?.yearMonth));
    throw createHttpError(
      409,
      '월 결산 요청을 만들고 지정 승인자의 승인을 받아 주세요.',
      'cashflow_month_close_approval_required',
    );
  }));

  app.post('/api/v1/cashflow/:projectId/month-close/reopen-request', asyncHandler(async (req, res) => {
    requireSettlementCycleMutation(req.body);
    assertWeeklyWorkspaceOrRoleAllowed(req, CASHFLOW_MONTH_WORKFLOW_ROLES, 'request cashflow month reopen', authMode, workspaceEmailDomain);
    assertAlignedCashflowMutation();
    if (!db?.doc) {
      throw createHttpError(503, '월 결산 요청 저장소에 연결하지 못했습니다.', 'cashflow_month_close_request_store_unavailable');
    }
    const projectId = req.params.projectId;
    await assertCashflowProjectInScope({ db, req, projectId, authMode, workspaceEmailDomain });
    await readActiveCashflowMember({ db, tenantId: req.context.tenantId, actorId: req.context.actorId });
    const reopened = await mutateCanonicalCashflowMonthReopen(req, { projectId });
    res.status(200).json({ request: cashflowMonthCloseRequestView(reopened) });
  }));

  app.post('/api/v1/cashflow/:projectId/month-close/reopen-decision', asyncHandler(async (req, res) => {
    requireSettlementCycleMutation(req.body);
    assertAlignedCashflowMutation();
    if (!db?.doc) {
      throw createHttpError(503, '월 결산 요청 저장소에 연결하지 못했습니다.', 'cashflow_month_close_request_store_unavailable');
    }
    await readActiveCashflowMember({
      db, tenantId: req.context.tenantId, actorId: req.context.actorId,
    });
    const decided = await mutateCanonicalCashflowMonthReopen(req, {
      projectId: req.params.projectId,
      decision: req.body?.decision,
    });
    res.status(200).json({ request: cashflowMonthCloseRequestView(decided) });
  }));

  app.get('/api/v1/cashflow/:projectId', asyncHandler(async (req, res) => {
    assertWeeklyWorkspaceOrRoleAllowed(req, ROUTE_ROLES.readCore, 'read Java weekly cashflow snapshot', authMode, workspaceEmailDomain);
    let comparisonBoundary;
    try {
      comparisonBoundary = resolveCashflowComparisonAsOf(readOptionalText(req.query.asOf), now());
    } catch {
      throw createHttpError(400, 'Cashflow comparison asOf must be a valid YYYY-MM-DD date.', 'cashflow_comparison_as_of_invalid');
    }
    const requestedRangeStart = parseCashflowRangeBoundary(req.query.rangeStart, 'rangeStart');
    const requestedRangeEnd = parseCashflowRangeBoundary(req.query.rangeEnd, 'rangeEnd');
    if (
      requestedRangeStart
      && requestedRangeEnd
      && cashflowRangeSortKey(requestedRangeStart) > cashflowRangeSortKey(requestedRangeEnd)
    ) {
      throw createHttpError(400, 'rangeStart must be before or equal to rangeEnd.', 'cashflow_range_invalid');
    }
    const projectId = encodeURIComponent(readOptionalText(req.params.projectId));
    const result = await proxyJavaWeeklyRequest({
      context: req.context,
      method: 'GET',
      path: `/api/v1/cashflow/${projectId}`,
    });
    if (readOptionalText(result?.projectId) !== readOptionalText(req.params.projectId)) {
      throw createHttpError(502, '다른 프로젝트의 자료가 도착했습니다. 화면을 새로고침해 주세요.', 'jvm_weekly_project_mismatch');
    }
    const comparison = buildCashflowProjectionActualComparison(result, comparisonBoundary);
    const comparisonByMonth = new Map(comparison.months.map((month) => [month.yearMonth, month]));
    const sourceMonths = Array.isArray(result?.readModel?.months) ? result.readModel.months : [];
    const range = resolveCashflowReadModelRange({
      months: sourceMonths,
      rawStart: req.query.rangeStart,
      rawEnd: req.query.rangeEnd,
      comparisonBoundary,
    });
    res.status(200).json({
      ...result,
      readModel: {
        ...(result?.readModel || {}),
        range: {
          ...range,
          projection: buildCashflowRangeTotals(sourceMonths, 'projection', range),
          actual: buildCashflowRangeTotals(sourceMonths, 'actual', range),
        },
        months: sourceMonths.map((month) => {
          const monthComparison = comparisonByMonth.get(String(month?.yearMonth || ''));
          return {
            ...month,
            comparison: monthComparison || {
              yearMonth: String(month?.yearMonth || ''),
              weeks: [],
              rowTotals: {},
              totalIn: 0,
              totalOut: 0,
              net: 0,
              totals: {
                projection: { totalIn: 0, totalOut: 0, balance: 0 },
                actual: { totalIn: 0, totalOut: 0, balance: 0 },
                difference: { totalIn: 0, totalOut: 0, balance: 0 },
              },
            },
          };
        }),
      },
      comparison,
    });
  }));
}
