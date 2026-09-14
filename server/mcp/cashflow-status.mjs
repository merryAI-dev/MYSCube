import { randomUUID } from 'node:crypto';
import { previousYearMonth } from '../bff/cashflow-close-calendar.mjs';

const YEAR_MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const PERIODS = new Set(['MONTH', 'WEEK_1', 'WEEK_2', 'WEEK_3', 'WEEK_4', 'WEEK_5']);
const MONTH_STATUSES = new Set(['WAITING_FOR_UPDATE', 'SUBMITTED', 'LOCKED']);
const WEEK_STATUSES = new Set(['WAITING_FOR_UPDATE', 'PENDING_APPROVAL', 'COMPLETED']);
const CYCLE_COMMANDS = new Set([
  'SUBMIT_MONTH_CLOSE', 'WITHDRAW_MONTH_CLOSE', 'APPROVE_MONTH_CLOSE', 'REJECT_MONTH_CLOSE',
  'REQUEST_MONTH_REOPEN', 'APPROVE_MONTH_REOPEN', 'REJECT_MONTH_REOPEN', 'CANCEL_ACTIVE_CYCLE',
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function assertProjectIds(projectIds) {
  if (!Array.isArray(projectIds) || projectIds.length < 1 || projectIds.length > 100) {
    throw new Error('조회할 프로젝트는 1~100개여야 합니다.');
  }
  const normalized = projectIds.map(text);
  if (normalized.some((projectId) => !projectId || projectId.length > 120 || projectId.includes('/'))
    || new Set(normalized).size !== normalized.length) {
    throw new Error('프로젝트 식별자가 올바르지 않습니다.');
  }
  return normalized;
}

function assertYearMonth(yearMonth) {
  if (!YEAR_MONTH.test(text(yearMonth))) throw new Error('조회 연월은 YYYY-MM 형식이어야 합니다.');
  return yearMonth;
}

function safeBaseUrl(value) {
  let url;
  try {
    url = new URL(text(value));
  } catch {
    throw new Error('MYSCUBE_BFF_BASE_URL 설정이 올바르지 않습니다.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) {
    throw new Error('MYSCUBE_BFF_BASE_URL은 HTTPS 주소여야 합니다.');
  }
  return url;
}

function safeError(response) {
  if (response.status === 401) return 'MYSCube 로그인이 만료됐거나 필요합니다.';
  if (response.status === 403) return '이 정산 현황을 조회할 권한이 없습니다.';
  if (response.status >= 500) return 'MYSCube 현금흐름 조회 서버에 일시적인 문제가 있습니다.';
  return '현금흐름 조회 요청이 올바르지 않습니다.';
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function validInstant(value) {
  return typeof value === 'string'
    && value.trim() === value
    && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validStatusItem(value) {
  const item = objectValue(value);
  const statuses = item?.period === 'MONTH' ? MONTH_STATUSES : WEEK_STATUSES;
  return Boolean(item)
    && PERIODS.has(item.period)
    && statuses.has(item.status)
    && Number.isSafeInteger(item.revision)
    && item.revision >= 0
    && ['submittedAt', 'submittedBy', 'approvedAt', 'approvedBy']
      .every((field) => typeof item[field] === 'string')
    && [item.submittedAt, item.approvedAt]
      .every((value) => value === '' || validInstant(value))
    && validInstant(item.deadlineAt)
    && validInstant(item.approverDeadlineAt);
}

function validCanonicalItem(item, { yearMonth, monthCloseTargetYearMonth }) {
  const statuses = objectValue(item?.settlementStatuses);
  const statusItems = Array.isArray(statuses?.items) ? statuses.items : [];
  const periodKeys = statusItems.map((status) => status?.period);
  const cycle = objectValue(item?.settlementCycle);
  const provenance = cycle?.provenance === null ? null : objectValue(cycle?.provenance);
  const capabilities = objectValue(cycle?.commandCapabilities);
  const capabilityNames = capabilities ? Object.keys(capabilities) : [];
  const summary = item?.projectionActualSummary === null
    ? null : objectValue(item?.projectionActualSummary);
  const summaryDisplay = summary ? objectValue(summary.display) : null;
  const summaryComparison = summary ? objectValue(summary.comparisonAsOfWeek) : null;
  const summaryPeriods = summary && Array.isArray(summary.periods) ? summary.periods : [];
  const summaryPeriodKeys = summaryPeriods.map((period) => period?.period);
  const validSummary = item?.projectionActualSummary === null || (Boolean(summary)
    && summary.projectId === item?.projectId
    && summary.source === 'SHEET_FORMULA'
    && typeof summary.sourceRevision === 'string'
    && YEAR_MONTH.test(summary.fromMonth)
    && YEAR_MONTH.test(summaryComparison?.yearMonth)
    && Number.isInteger(summaryComparison?.weekNo)
    && summaryComparison.weekNo >= 1
    && summaryComparison.weekNo <= 5
    && Number.isSafeInteger(summary.differenceAmount)
    && Number.isSafeInteger(summary.settlementDifferenceAmount)
    && typeof summary.settlementMatches === 'boolean'
    && typeof summaryDisplay?.periodLabel === 'string'
    && typeof summaryDisplay?.statusLabel === 'string'
    && ['success', 'danger'].includes(summaryDisplay?.statusTone)
    && typeof summaryDisplay?.differenceLabel === 'string'
    && Array.isArray(summary.periods)
    && summaryPeriods.every((period) => PERIODS.has(period?.period)
      && (period?.differenceAmount === null || Number.isSafeInteger(period?.differenceAmount)))
    && new Set(summaryPeriodKeys).size === summaryPeriodKeys.length);
  return statuses?.projectId === item?.projectId
    && statuses?.yearMonth === yearMonth
    && statusItems.length === PERIODS.size
    && statusItems.every(validStatusItem)
    && new Set(periodKeys).size === PERIODS.size
    && cycle?.cycleYearMonth === yearMonth
    && cycle?.weeklyYearMonth === yearMonth
    && cycle?.monthCloseTargetYearMonth === monthCloseTargetYearMonth
    && ['NOT_REQUESTED', 'SUBMITTED', 'LOCKED', 'REOPEN_REQUESTED', 'REOPENED', 'REJECTED', 'WITHDRAWN', 'INCONSISTENT']
      .includes(cycle?.businessState)
    && ['OK', 'RECONCILING', 'UNAVAILABLE'].includes(cycle?.health)
    && Number.isSafeInteger(cycle?.workflowRevision)
    && cycle.workflowRevision >= (cycle.businessState === 'INCONSISTENT' ? -1 : 0)
    && (cycle?.monthCloseSettlement === null
      || (validStatusItem(cycle?.monthCloseSettlement) && cycle.monthCloseSettlement.period === 'MONTH'))
    && (cycle?.provenance === null || (Boolean(provenance)
      && YEAR_MONTH.test(provenance.affectedFromMonth)
      && YEAR_MONTH.test(provenance.affectedThroughMonth)
      && YEAR_MONTH.test(provenance.closedByCycleYearMonth)
      && typeof provenance.approvalVersionId === 'string'
      && typeof provenance.requestId === 'string'
      && Number.isSafeInteger(provenance.ledgerRevision)
      && /^sha256:[a-f0-9]{64}$/.test(provenance.rootHash)))
    && [null, 'REJECTED', 'WITHDRAWN'].includes(cycle?.supersededAttempt)
    && capabilityNames.length === CYCLE_COMMANDS.size
    && capabilityNames.every((command) => CYCLE_COMMANDS.has(command))
    && capabilityNames.every((command) => {
      const capability = objectValue(capabilities[command]);
      return typeof capability?.allowed === 'boolean'
        && typeof capability?.reasonCode === 'string'
        && (capability.allowed ? capability.reasonCode === '' : /^[A-Z][A-Z0-9_]*$/.test(capability.reasonCode));
    })
    && validSummary
    && (item?.sheetCapturedAt === null || validInstant(item?.sheetCapturedAt));
}

export function assertOverview(result, { projectIds, yearMonth }) {
  const requested = new Set(projectIds);
  const items = Array.isArray(result?.items) ? result.items : null;
  const errors = Array.isArray(result?.errors) ? result.errors : null;
  const itemIds = items?.map((item) => item?.projectId);
  const errorKeys = errors?.map((error) => `${error?.projectId}:${error?.code}`);
  if (result?.version !== '5'
    || result.yearMonth !== yearMonth
    || result?.monthCloseTargetYearMonth !== previousYearMonth(yearMonth)
    || typeof result?.monthCloseTargetLabel !== 'string'
    || !items
    || !errors
    || itemIds.length !== projectIds.length
    || itemIds.some((projectId) => !requested.has(projectId))
    || new Set(itemIds).size !== itemIds.length
    || items.some((item) => !validCanonicalItem(item, {
      yearMonth,
      monthCloseTargetYearMonth: result.monthCloseTargetYearMonth,
    }))
    || errors.some((error) => !requested.has(error?.projectId) || error?.code !== 'SUMMARY_UNAVAILABLE')
    || new Set(errorKeys).size !== errorKeys.length) {
    throw new Error('MYSCube 현금흐름 응답을 확인할 수 없습니다.');
  }
  return result;
}

export function resolveCashflowMcpConfig(env = process.env) {
  return { baseUrl: safeBaseUrl(env.MYSCUBE_BFF_BASE_URL).toString() };
}

export async function readCashflowStatus({
  baseUrl,
  accessToken,
  projectIds,
  yearMonth,
  fetchImpl = globalThis.fetch,
  requestId = randomUUID(),
  audit = () => {},
}) {
  const safeProjectIds = assertProjectIds(projectIds);
  const safeYearMonth = assertYearMonth(yearMonth);
  if (typeof fetchImpl !== 'function') throw new Error('현금흐름 조회 연결을 사용할 수 없습니다.');

  if (!text(accessToken)) throw new Error('MYSCube 로그인이 필요합니다.');
  const endpoint = new URL('/api/v1/mcp/cashflow/weekly-overview', safeBaseUrl(baseUrl));
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${text(accessToken)}`,
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify({ projectIds: safeProjectIds, yearMonth: safeYearMonth }),
    });
  } catch {
    audit({ tool: 'cashflow_status', requestId, yearMonth: safeYearMonth, projectCount: safeProjectIds.length, outcome: 'network_error' });
    throw new Error('MYSCube 현금흐름 조회에 연결하지 못했습니다.');
  }

  if (!response.ok) {
    audit({ tool: 'cashflow_status', requestId, yearMonth: safeYearMonth, projectCount: safeProjectIds.length, outcome: `http_${response.status}` });
    throw new Error(safeError(response));
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('MYSCube 현금흐름 응답을 읽을 수 없습니다.');
  }
  const overview = assertOverview(result, { projectIds: safeProjectIds, yearMonth: safeYearMonth });
  audit({ tool: 'cashflow_status', requestId, yearMonth: safeYearMonth, projectCount: safeProjectIds.length, resultProjectCount: overview.items.length, outcome: 'ok' });
  return overview;
}
