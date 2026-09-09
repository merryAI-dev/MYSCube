import { createHttpError, readOptionalText } from './bff-utils.mjs';
import {
  cashflowCumulativeMonthLocked,
  readCashflowCumulativeCloseAuthority,
} from './cashflow-close-calendar.mjs';

function isYearMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

const MONTH_CLOSE_COUNTERS = [
  'revision',
  'reopenCount',
  'amendmentCount',
  'postDeadlineAmendmentWarningCount',
];
const MONTH_CLOSE_MAP_EVIDENCE = [
  'snapshot',
  'previousSnapshot',
  'lastAmendmentEvidence',
  'reopenRequest',
  'reopenDecision',
  'reopenContext',
];
const MONTH_CLOSE_TEXT_EVIDENCE = [
  'snapshotHash',
  'previousSnapshotHash',
  'latestVersionId',
  'closedAt',
  'closedByUid',
  'closedByName',
  'reopenReason',
  'reopenRequestedAt',
  'reopenRequestedByUid',
  'reopenDecisionReason',
  'reopenDecidedAt',
  'reopenDecidedByUid',
  'lastAmendmentAt',
  'lastAmendmentByUid',
  'lastAmendmentByName',
  'lastAmendmentReason',
  'lastAmendmentDeadline',
];

function isPristineOpenMonthClose(close) {
  const legacy = !Object.hasOwn(close, 'contractVersion');
  if (!legacy && readOptionalText(close.contractVersion) !== 'cashflow-month-close-v1') return false;
  if (readOptionalText(close.status) !== 'OPEN') return false;
  if (!legacy && (!Object.hasOwn(close, 'revision') || !Object.hasOwn(close, 'reopenCount'))) return false;
  if (MONTH_CLOSE_COUNTERS.some((field) => (
    Object.hasOwn(close, field) && (!Number.isSafeInteger(close[field]) || close[field] !== 0)
  ))) return false;
  if (MONTH_CLOSE_MAP_EVIDENCE.some((field) => {
    if (!Object.hasOwn(close, field)) return false;
    const value = close[field];
    return !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0;
  })) return false;
  if (MONTH_CLOSE_TEXT_EVIDENCE.some((field) => (
    Object.hasOwn(close, field)
    && (typeof close[field] !== 'string' || close[field].trim() !== '')
  ))) return false;
  return !Object.hasOwn(close, 'lastAmendmentPostDeadline')
    || close.lastAmendmentPostDeadline === false;
}

export async function assertCashflowMonthWritable({ db, transaction, tenantId, projectId, yearMonth }) {
  if (!isYearMonth(yearMonth)) {
    throw createHttpError(400, '대상 월 형식을 확인해 주세요.', 'cashflow_month_invalid');
  }
  const read = (ref) => (transaction ? transaction.get(ref) : ref.get());
  const headSnapshot = await read(db.doc(`orgs/${tenantId}/cashflow_cumulative_close_heads/${projectId}`));
  if (headSnapshot.exists) {
    const authority = readCashflowCumulativeCloseAuthority(headSnapshot.data(), { tenantId, projectId });
    if (!authority) {
      throw createHttpError(409, '월 결산 기준 정보를 확인할 수 없어 안전하게 중단했어요. AXR 현금흐름 기간·마감 정책에서 상태를 확인해 주세요.', 'cashflow_month_close_contract_invalid');
    }
    if (!cashflowCumulativeMonthLocked(authority, yearMonth)) return;
    throw createHttpError(409, `${yearMonth} 누적 결산 완료 월은 수정할 수 없습니다.`, 'cashflow_month_locked');
  }

  const closeSnapshot = await read(db.doc(`orgs/${tenantId}/monthly_closes/${projectId}-${yearMonth}`));
  if (!closeSnapshot.exists) return;
  const close = closeSnapshot.data() || {};
  if (
    readOptionalText(close.tenantId) !== tenantId
    || readOptionalText(close.projectId) !== projectId
    || readOptionalText(close.yearMonth) !== yearMonth
  ) {
    throw createHttpError(409, '월 결산 기준 정보를 확인할 수 없어 안전하게 중단했어요. AXR 현금흐름 기간·마감 정책에서 상태를 확인해 주세요.', 'cashflow_month_close_contract_invalid');
  }
  if (isPristineOpenMonthClose(close)) return;
  throw createHttpError(
    409,
    `${yearMonth} 마감 이력에 대응하는 누적 마감 기준이 없어 관리자 복구가 필요합니다.`,
    'cashflow_month_close_migration_required',
  );
}
