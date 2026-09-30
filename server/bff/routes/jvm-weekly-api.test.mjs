import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as jvmWeeklyApiModule from './jvm-weekly-api.mjs';
import {
  buildCashflowManagementChecks,
  buildCashflowMonthCloseRevisionChanges,
  mountJvmWeeklyApiRoutes,
} from './jvm-weekly-api.mjs';

describe('cashflow section error presentation', () => {
  it.each([
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
  ])('owns the Korean label for %s', (section, label) => {
    expect(jvmWeeklyApiModule.cashflowSectionErrorLabel?.(section)).toBe(label);
  });

  it('does not expose an unknown raw section identifier as its label', () => {
    expect(jvmWeeklyApiModule.cashflowSectionErrorLabel?.('vendorRawSection')).toBe('일부 정보');
  });

  // PARITY TABLE — JVM FirestoreInheritedWeeklyExpensePersistence 가 내는 주간 준수 상태와 같은 표다.
  // BFF 가 존재하지 않는 COMPLETED 를 기다리고 ON_TIME 을 몰라서, 기한 내 완료한 주차가
  // 라이브에서 "주간 정산 상태 확인 필요" 로 그려졌다. 한쪽 어휘를 바꾸면 여기서 깨진다.
  it.each([
    ['ON_TIME', '기한 내 완료'],
    ['COMPLETED_LATE', '기한 후 완료'],
    ['MISSED', '기한 지남'],
    ['PENDING', '완료 대기'],
  ])('labels JVM weekly status %s as %s', (status, label) => {
    expect(jvmWeeklyApiModule.cashflowWeeklyStatusLabel(status, true)).toBe(label);
  });

  // 색도 같은 표를 따른다. 라벨만 고치고 색을 빠뜨려 기한 내 완료가 회색으로 남았었다.
  it.each([
    ['ON_TIME', 'success'],
    ['COMPLETED_LATE', 'success'],
    ['MISSED', 'danger'],
    ['PENDING', 'warning'],
  ])('colours JVM weekly status %s as %s', (weeklyStatus, tone) => {
    expect(jvmWeeklyApiModule.cashflowWeekSurfaceTone({
      month: { tone: 'default' }, weeklyStatus, weeklyAvailable: true, isCurrent: false,
    })).toBe(tone);
  });

  // 라이브 사고(2026-08, JLIN IBS · GGGI): 완료 문서 55건 전부에 lockState 가 없었는데
  // JVM 이 없는 값을 LOCKED 로 읽어, 확정한 적 없는 주가 "완료" 로 보이고 회수까지 막혔다.
  // 고친 자리는 JVM 이다. BFF 는 받은 값을 옮기기만 하고 빈 값을 재해석하지 않는다 -
  // 여기서 한 번 더 판정하면 두 곳이 조용히 갈린다.
  it('keeps practitioner completion above manager confirmation state', () => {
    expect(jvmWeeklyApiModule.cashflowWeeklyStatusLabel('ON_TIME', true, 'SUBMITTED')).toBe('기한 내 완료');
    expect(jvmWeeklyApiModule.cashflowWeeklyStatusLabel('ON_TIME', true, 'LOCKED')).toBe('기한 내 완료');
    expect(jvmWeeklyApiModule.cashflowWeeklyStatusLabel('ON_TIME', true, '')).toBe('기한 내 완료');
  });

  it('never labels a known JVM weekly status as 확인 필요', () => {
    for (const status of ['ON_TIME', 'COMPLETED_LATE', 'MISSED', 'PENDING']) {
      expect(jvmWeeklyApiModule.cashflowWeeklyStatusLabel(status, true)).not.toBe('주간 정산 상태 확인 필요');
    }
  });
});

describe('cashflow month-close revision diff', () => {
  it('preserves EMPTY, ZERO, VALUE, amount changes, and missing keys', () => {
    const cell = (cashflowLine, cellState, amount) => ({
      mode: 'projection', weekNo: 1, cashflowLine, cellState, ...(amount === undefined ? {} : { amount }),
    });
    const previous = [
      cell('EMPTY_TO_ZERO', 'EMPTY'),
      cell('ZERO_TO_EMPTY', 'ZERO', 0),
      cell('EMPTY_TO_VALUE', 'EMPTY'),
      cell('VALUE_TO_EMPTY', 'VALUE', 10),
      cell('ZERO_TO_VALUE', 'ZERO', 0),
      cell('VALUE_TO_ZERO', 'VALUE', 20),
      cell('VALUE_AMOUNT', 'VALUE', 30),
      cell('REMOVED_KEY', 'VALUE', 40),
    ];
    const current = [
      cell('EMPTY_TO_ZERO', 'ZERO', 0),
      cell('ZERO_TO_EMPTY', 'EMPTY'),
      cell('EMPTY_TO_VALUE', 'VALUE', 10),
      cell('VALUE_TO_EMPTY', 'EMPTY'),
      cell('ZERO_TO_VALUE', 'VALUE', 20),
      cell('VALUE_TO_ZERO', 'ZERO', 0),
      cell('VALUE_AMOUNT', 'VALUE', 35),
      cell('ADDED_KEY', 'VALUE', 50),
    ];

    const changes = buildCashflowMonthCloseRevisionChanges(previous, current);

    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ cashflowLine: 'EMPTY_TO_ZERO', previousState: 'EMPTY', currentState: 'ZERO', previousAmount: null, currentAmount: 0, amountDelta: null }),
      expect.objectContaining({ cashflowLine: 'ZERO_TO_EMPTY', previousState: 'ZERO', currentState: 'EMPTY', previousAmount: 0, currentAmount: null, amountDelta: null }),
      expect.objectContaining({ cashflowLine: 'EMPTY_TO_VALUE', previousState: 'EMPTY', currentState: 'VALUE', previousAmount: null, currentAmount: 10, amountDelta: null }),
      expect.objectContaining({ cashflowLine: 'VALUE_TO_EMPTY', previousState: 'VALUE', currentState: 'EMPTY', previousAmount: 10, currentAmount: null, amountDelta: null }),
      expect.objectContaining({ cashflowLine: 'ZERO_TO_VALUE', previousState: 'ZERO', currentState: 'VALUE', previousAmount: 0, currentAmount: 20, amountDelta: 20 }),
      expect.objectContaining({ cashflowLine: 'VALUE_TO_ZERO', previousState: 'VALUE', currentState: 'ZERO', previousAmount: 20, currentAmount: 0, amountDelta: -20 }),
      expect.objectContaining({ cashflowLine: 'VALUE_AMOUNT', previousState: 'VALUE', currentState: 'VALUE', previousAmount: 30, currentAmount: 35, amountDelta: 5 }),
      expect.objectContaining({ cashflowLine: 'ADDED_KEY', previousState: 'MISSING', currentState: 'VALUE', previousAmount: null, currentAmount: 50, amountDelta: null }),
      expect.objectContaining({ cashflowLine: 'REMOVED_KEY', previousState: 'VALUE', currentState: 'MISSING', previousAmount: 40, currentAmount: null, amountDelta: null }),
    ]));
    expect(changes).toHaveLength(9);
  });
});
import { stableStringify } from '../utils.mjs';

function cashflowEvidenceHash(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function createIdempotencyService() {
  return {
    begin: vi.fn(async () => ({ mode: 'new', requestFingerprint: 'fp' })),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
  };
}

const runtimeEnv = {
  BFF_DEPLOY_ENV: 'live',
  BFF_EDIT_LEASES_ENABLED: 'true',
  BFF_LIVE_FIREBASE_PROJECT_ID: 'live-data-project',
  VITE_FIREBASE_PROJECT_ID: 'live-data-project',
  JVM_WEEKLY_FIRESTORE_PROJECT_ID: 'live-data-project',
};

const editLeaseHeaders = {
  'x-edit-session-id': 'session-a',
  'x-edit-lease-id': 'lease-a',
  'x-edit-fence': '7',
};

const cashflowLineIds = [
  'MYSC_PREPAY_IN', 'MYSC_PREPAY_LABOR_IN', 'MYSC_PREPAY_INPUT_VAT_IN',
  'SALES_IN', 'SALES_VAT_IN', 'TEAM_SUPPORT_IN', 'BANK_INTEREST_IN',
  'MYSC_PREPAY_DIRECT_OUT', 'MYSC_PREPAY_LABOR_OUT', 'DIRECT_COST_OUT',
  'INPUT_VAT_OUT', 'MYSC_LABOR_OUT', 'MYSC_PROFIT_OUT', 'SALES_VAT_OUT',
  'TEAM_SUPPORT_OUT', 'BANK_INTEREST_OUT',
];

const managementConfirmations = [
  'labor-transfer',
  'profit-vat-after-deposit',
  'negative-projection-balance',
  'future-prepay-over-million',
].map((checkId) => ({ checkId, decision: 'CONFIRMED' }));

const emptyManagementChecks = [
  { id: 'labor-transfer', status: 'WARNING', title: 'MYSC 인건비 이관', detail: '2026-06 3주차 인건비 미입력' },
  { id: 'profit-vat-after-deposit', status: 'REVIEW_REQUIRED', title: '입금 후 MYSC 수익·매출부가세 이관(해당 주, 차주)', detail: '실제 입금 확인 건이 없습니다. 해당 없음 여부를 사람이 확인해 주세요.' },
  { id: 'negative-projection-balance', status: 'OK', title: 'Projection 잔액 마이너스', detail: 'Projection 누적 잔액이 0원 이상입니다.' },
  { id: 'future-prepay-over-million', status: 'OK', title: '금주 이후 선입금 요청 100만원 초과', detail: '금주 이후 100만원 초과 요청이 없습니다.' },
];

// pm 역할은 테넌트 전역이 아니므로 프로젝트 스코프가 있어야 읽을 수 있다.
// 라이브 멤버 문서와 같은 형태로 배정을 모델링한다.
const ACTOR_MEMBER_ENTRY = ['orgs/tenant-a/members/pm-1', {
  uid: 'pm-1', email: 'pm@example.com', status: 'ACTIVE', role: 'pm', projectIds: ['project-a'],
}];

function monthCloseCalendarFor(yearMonth) {
  const year = Number(String(yearMonth).slice(0, 4));
  return Array.from({ length: 12 }, (_unused, monthIndex) => {
    const month = monthIndex + 1;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const isoAtKstMidnight = (day) => new Date(Date.UTC(nextYear, nextMonth - 1, day) - 9 * 60 * 60 * 1000).toISOString();
    return {
      yearMonth: `${year}-${String(month).padStart(2, '0')}`,
      closeDeadline: `${nextYear}-${String(nextMonth).padStart(2, '0')}-10`,
      closeDeadlineAt: isoAtKstMidnight(11),
      approverDeadlineAt: new Date(Date.UTC(year, month + 1, 1) - 9 * 60 * 60 * 1000).toISOString(),
    };
  });
}

function previousMonthOf(yearMonth) {
  const year = Number(String(yearMonth).slice(0, 4));
  const month = Number(String(yearMonth).slice(5, 7));
  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  return `${previous.year}-${String(previous.month).padStart(2, '0')}`;
}

const settlementCycleCommands = [
  'SUBMIT_MONTH_CLOSE',
  'WITHDRAW_MONTH_CLOSE',
  'APPROVE_MONTH_CLOSE',
  'REJECT_MONTH_CLOSE',
  'REQUEST_MONTH_REOPEN',
  'APPROVE_MONTH_REOPEN',
  'REJECT_MONTH_REOPEN',
  'CANCEL_ACTIVE_CYCLE',
];

function deniedSettlementCycleCapabilities(reasonCode = 'BUSINESS_STATE_NOT_ELIGIBLE') {
  return Object.fromEntries(settlementCycleCommands.map((command) => [
    command,
    { allowed: false, reasonCode },
  ]));
}

function canonicalSettlementCycle(overrides = {}) {
  return {
    cycleYearMonth: '2026-08',
    weeklyYearMonth: '2026-08',
    monthCloseTargetYearMonth: '2026-07',
    closeDeadline: `${overrides.cycleYearMonth || '2026-08'}-10`,
    businessState: 'NOT_REQUESTED',
    health: 'OK',
    workflowRevision: 0,
    monthCloseSettlement: null,
    provenance: null,
    supersededAttempt: null,
    commandCapabilities: {
      ...deniedSettlementCycleCapabilities(),
      SUBMIT_MONTH_CLOSE: { allowed: true, reasonCode: '' },
    },
    ...overrides,
  };
}

function canonicalMonthCloseRequest(cycleYearMonth, status = 'PENDING_APPROVAL', overrides = {}) {
  return {
    documentType: 'REQUEST',
    contractVersion: 'cashflow-cumulative-close-v2',
    requestId: `project-a-${cycleYearMonth}`,
    tenantId: 'tenant-a',
    projectId: 'project-a',
    yearMonth: cycleYearMonth,
    cycleYearMonth,
    monthCloseTargetYearMonth: previousMonthOf(cycleYearMonth),
    throughMonth: previousMonthOf(cycleYearMonth),
    status,
    revision: 1,
    evidenceRevision: 1,
    ledgerRevision: 1,
    workflowRevision: 1,
    manifestHash: `sha256:${'b'.repeat(64)}`,
    requestedByUid: 'pm-1',
    approverUid: 'finance-1',
    ...overrides,
  };
}

function withCanonicalCycle(source, {
  businessState,
  covered = false,
  approvedAt = '',
  approvedBy = '',
  supersededAttempt = null,
  commandCapabilities = null,
  provenanceLedgerRevision = 2,
  rootHash = `sha256:${'a'.repeat(64)}`,
  workflowRevision = null,
}) {
  const cycleYearMonth = source.settlementCycle.cycleYearMonth;
  const targetYearMonth = previousMonthOf(cycleYearMonth);
  const calendar = source.monthCloseCalendar.find((item) => item.yearMonth === targetYearMonth);
  const status = businessState === 'SUBMITTED'
    ? 'SUBMITTED'
    : !covered && ['LOCKED', 'REOPEN_REQUESTED'].includes(businessState)
      ? 'LOCKED'
      : 'WAITING_FOR_UPDATE';
  const month = {
    period: 'MONTH', status, revision: covered ? 4 : businessState === 'SUBMITTED' ? 1 : 2,
    submittedAt: status === 'WAITING_FOR_UPDATE' ? '' : `${cycleYearMonth}-11T01:00:00Z`,
    submittedBy: status === 'WAITING_FOR_UPDATE' ? '' : 'pm-1',
    approvedAt: status === 'LOCKED' ? approvedAt || `${cycleYearMonth}-12T01:00:00Z` : '',
    approvedBy: status === 'LOCKED' ? approvedBy || 'finance-1' : '',
    deadlineAt: calendar.closeDeadlineAt, approverDeadlineAt: calendar.approverDeadlineAt,
  };
  source.settlementCycle = canonicalSettlementCycle({
    cycleYearMonth,
    weeklyYearMonth: cycleYearMonth,
    monthCloseTargetYearMonth: targetYearMonth,
    businessState,
    workflowRevision: workflowRevision ?? (covered ? 5 : businessState === 'SUBMITTED' ? 1 : 2),
    monthCloseSettlement: covered || businessState === 'NOT_REQUESTED' ? null : month,
    provenance: ['LOCKED', 'REOPEN_REQUESTED'].includes(businessState) ? {
      affectedFromMonth: covered ? targetYearMonth : '2023-01',
      affectedThroughMonth: covered ? '2026-09' : targetYearMonth,
      closedByCycleYearMonth: covered ? '2026-10' : cycleYearMonth,
      approvalVersionId: covered ? 'approval-v5' : 'approval-v2',
      requestId: covered ? 'project-a-2026-10' : `project-a-${cycleYearMonth}`,
      ledgerRevision: covered ? 5 : provenanceLedgerRevision,
      rootHash: covered ? `sha256:${'f'.repeat(64)}` : rootHash,
    } : null,
    supersededAttempt,
    commandCapabilities: commandCapabilities || {
      ...deniedSettlementCycleCapabilities(),
      ...(businessState === 'SUBMITTED' ? {
        WITHDRAW_MONTH_CLOSE: { allowed: true, reasonCode: '' },
        APPROVE_MONTH_CLOSE: { allowed: false, reasonCode: 'NOT_CURRENT_APPROVER' },
        REJECT_MONTH_CLOSE: { allowed: false, reasonCode: 'NOT_CURRENT_APPROVER' },
        CANCEL_ACTIVE_CYCLE: { allowed: false, reasonCode: 'RECOVERY_ADMIN_REQUIRED' },
      } : businessState === 'LOCKED'
        ? { REQUEST_MONTH_REOPEN: { allowed: true, reasonCode: '' } }
        : { SUBMIT_MONTH_CLOSE: { allowed: true, reasonCode: '' } }),
    },
  });
  source.settlementStatuses = {
    projectId: source.monthClose.projectId,
    yearMonth: cycleYearMonth,
    items: [month, ...source.settlementStatuses.items.filter((item) => item.period !== 'MONTH')],
  };
  return source;
}

const withCanonicalSubmittedCycle = (source) => withCanonicalCycle(source, {
  businessState: 'SUBMITTED',
});
const withCanonicalLockedCycle = (source, overrides = {}) => withCanonicalCycle(source, {
  businessState: 'LOCKED', ...overrides,
});
const withCanonicalCoveredLockedCycle = (source, supersededAttempt = 'REJECTED') => (
  withCanonicalCycle(source, { businessState: 'LOCKED', covered: true, supersededAttempt })
);

function submittedMonthSettlement(yearMonth = '2026-08') {
  return {
    period: 'MONTH', status: 'SUBMITTED',
    submittedAt: `${yearMonth}-11T01:00:00Z`, submittedBy: 'pm-1',
    approvedAt: '', approvedBy: '', revision: 1,
    deadlineAt: `${yearMonth}-10T15:00:00Z`,
    approverDeadlineAt: `${yearMonth}-${yearMonth.endsWith('-09') ? '30' : '31'}T15:00:00Z`,
  };
}

function canonicalSettlementStatuses(projectId = 'project-a', yearMonth = '2026-08') {
  return {
    projectId,
    yearMonth,
    items: [
      submittedMonthSettlement(yearMonth),
      ...Array.from({ length: 5 }, (_, index) => ({
        period: `WEEK_${index + 1}`,
        status: index === 0 ? 'PENDING_APPROVAL' : 'WAITING_FOR_UPDATE',
        submittedAt: '', submittedBy: '', approvedAt: '', approvedBy: '', revision: 0,
        deadlineAt: `${yearMonth}-${String([2, 6, 13, 20, 27][index]).padStart(2, '0')}T15:00:00Z`,
        approverDeadlineAt: `${yearMonth}-${String([3, 7, 14, 21, 28][index]).padStart(2, '0')}T04:00:00Z`,
      })),
    ],
  };
}

function canonicalWeeklyOverviewResponse(yearMonth = '2026-08') {
  const settlementStatuses = canonicalSettlementStatuses('project-a', yearMonth);
  const month = settlementStatuses.items[0];
  return {
    version: '2',
    yearMonth,
    items: [{
      projectId: 'project-a',
      settlementStatuses,
      projectionActualSummary: null,
      settlementCycle: canonicalSettlementCycle({
        cycleYearMonth: yearMonth,
        weeklyYearMonth: yearMonth,
        monthCloseTargetYearMonth: previousMonthOf(yearMonth),
        businessState: 'SUBMITTED',
        workflowRevision: 1,
        monthCloseSettlement: month,
        commandCapabilities: {
          ...deniedSettlementCycleCapabilities(),
          WITHDRAW_MONTH_CLOSE: { allowed: true, reasonCode: '' },
          APPROVE_MONTH_CLOSE: { allowed: false, reasonCode: 'NOT_CURRENT_APPROVER' },
          REJECT_MONTH_CLOSE: { allowed: false, reasonCode: 'NOT_CURRENT_APPROVER' },
          CANCEL_ACTIVE_CYCLE: { allowed: false, reasonCode: 'RECOVERY_ADMIN_REQUIRED' },
        },
      }),
    }],
    errors: [],
  };
}

function monthDashboardSource(
  monthClose,
  cashflow = { projectId: 'project-a', projection: [], actual: [], readModel: { months: [] } },
  openingBalances = {
    selectedYear: Number(previousMonthOf(monthClose.yearMonth || '2026-01').slice(0, 4)),
    projection: { amount: 0, lineAmounts: {}, sources: [], includedYears: [], excludedWeeklyYears: [] },
    actual: { amount: 0, lineAmounts: {}, sources: [], includedYears: [], excludedWeeklyYears: [] },
  },
  snapshotCompatibility = {
    status: monthClose.status === 'OPEN' ? 'LIVE_CURRENT' : 'FROZEN_COMPLETE',
    missingEvidence: [],
  },
  projectionActualSummary = {
    projectId: monthClose.projectId,
    fromMonth: '2023-01',
    comparisonAsOfWeek: { yearMonth: '2026-07', weekNo: 2 },
    settlementDifferenceAmount: 18_371_453,
    settlementMatches: false,
  },
  cumulativeClose = {
    availability: 'MISSING',
    status: null,
    fromMonth: null,
    closedThrough: null,
    rootHash: null,
    headRevision: null,
  },
  reopenRequest = {
    enabled: false,
    reasonCode: 'CASHFLOW_MONTH_REOPEN_MONTH_NOT_CLOSED',
  },
) {
  const liveCurrent = monthClose.status === 'OPEN' || snapshotCompatibility.status === 'LIVE_AMENDED';
  const cycleYearMonth = monthClose.yearMonth;
  const targetYearMonth = previousMonthOf(cycleYearMonth);
  const monthCloseCalendar = monthCloseCalendarFor(targetYearMonth);
  const targetCalendar = monthCloseCalendar.find((entry) => entry.yearMonth === targetYearMonth);
  const settlementMonth = {
    period: 'MONTH', status: 'WAITING_FOR_UPDATE',
    submittedAt: '', submittedBy: '', approvedAt: '', approvedBy: '', revision: 0,
    deadlineAt: targetCalendar.closeDeadlineAt,
    approverDeadlineAt: targetCalendar.approverDeadlineAt,
  };
  return {
    monthClose,
    latestRun: monthClose,
    monthStatusEvidence: {
      authority: 'CUMULATIVE_CLOSE_HEAD',
      authorityAvailability: cumulativeClose.availability,
      operationalStatus: monthClose.status,
      latestRunStatus: monthClose.status,
      closedThrough: cumulativeClose.closedThrough,
      issueCode: null,
    },
    cashflow: liveCurrent ? cashflow : null,
    openingBalances,
    snapshotCompatibility,
    cumulativeClose,
    reopenRequest,
    settlementStatuses: {
      projectId: monthClose.projectId,
      yearMonth: cycleYearMonth,
      items: [
        settlementMonth,
        ...Array.from({ length: 5 }, (_, index) => ({
          period: `WEEK_${index + 1}`, status: 'WAITING_FOR_UPDATE',
          submittedAt: '', submittedBy: '', approvedAt: '', approvedBy: '', revision: 0,
          deadlineAt: `${cycleYearMonth}-01T15:00:00Z`,
          approverDeadlineAt: `${cycleYearMonth}-02T04:00:00Z`,
        })),
      ],
    },
    settlementCycle: canonicalSettlementCycle({
      cycleYearMonth,
      weeklyYearMonth: cycleYearMonth,
      monthCloseTargetYearMonth: targetYearMonth,
    }),
    operationalCycle: {
      cycleYearMonth,
      targetYearMonth,
      closeDeadline: `${cycleYearMonth}-10`,
      closeEligible: monthClose.status === 'OPEN',
      late: false,
    },
    monthCloseCalendar,
    projectionActualSummary,
    weeklyCompliance: { items: [], nextCursor: '', onTimeCount: 0, missedCount: 0 },
  };
}

function closedCumulativeAuthority(closedThrough, headRevision = 1) {
  const settlement = new Date(`${closedThrough}-01T00:00:00Z`);
  settlement.setUTCMonth(settlement.getUTCMonth() + 1);
  return {
    availability: 'AVAILABLE',
    status: 'CLOSED',
    fromMonth: '2023-01',
    settlementMonth: settlement.toISOString().slice(0, 7),
    closedThrough,
    rootHash: `sha256:${'a'.repeat(64)}`,
    headRevision,
  };
}

function projectionOpeningBalance(lineId, amount = 2_000_000) {
  return {
    selectedYear: 2026,
    projection: annualOpeningMode(lineId, amount),
    actual: { amount: 0, lineAmounts: {}, sources: [], includedYears: [], excludedWeeklyYears: [] },
  };
}

function annualOpeningMode(lineId, amount, year = 2025) {
  const lineStates = Object.fromEntries(cashflowLineIds.map((candidate) => [
    candidate,
    candidate === lineId ? 'VALUE' : 'EMPTY',
  ]));
  return {
    amount,
    lineAmounts: { [lineId]: amount },
    sources: [{ year, lineAmounts: { [lineId]: amount }, lineStates }],
    includedYears: [year],
    excludedWeeklyYears: [],
  };
}

function matchingControlRows(startRow, matches = true) {
  return Array.from({ length: 19 }, (_, index) => ({
    sourceCell: `BO${startRow + index}`, value: 0, computed: 0, matches,
  }));
}

function memoryTransaction(documents) {
  return async (callback) => {
    const staged = new Map();
    const result = await callback({
      get: async (ref) => {
        if (!ref.path) return ref.get();
        const value = staged.has(ref.path) ? staged.get(ref.path) : documents.get(ref.path);
        return { exists: value !== undefined, data: () => value };
      },
      set: (ref, value, options) => {
        ref.beforeTransactionSet?.();
        staged.set(ref.path, options?.merge
          ? { ...(staged.get(ref.path) || documents.get(ref.path) || {}), ...value }
          : value);
      },
    });
    for (const [path, value] of staged) documents.set(path, value);
    return result;
  };
}

function memoryDoc(documents, path) {
  return {
    path,
    get: async () => {
      const value = documents.get(path);
      return { exists: value !== undefined, data: () => value };
    },
    set: async (value, options) => {
      documents.set(path, options?.merge ? { ...(documents.get(path) || {}), ...value } : value);
    },
  };
}

function fullMonthCloseSource({
  mirrorStatus = 'FRESH', controlMatches = true, calculationMismatch = false,
  contractAmount = 1000, explicitZero = false, explicitEmpty = false,
  yearMonth = '2026-06', additionalYearMonths = [],
} = {}) {
  const monthCloseRequestQueries = [];
  const sourceRevision = `sha256:${'c'.repeat(64)}`;
  const targetRevision = `sha256:${'d'.repeat(64)}`;
  const cells = [];
  const confirmations = [];
  for (let weekNo = 1; weekNo <= 5; weekNo += 1) {
    for (const mode of ['projection', 'actual']) {
      for (const lineId of cashflowLineIds) {
        const zero = explicitZero && mode === 'projection' && weekNo === 1 && lineId === 'SALES_IN';
        const empty = explicitEmpty && mode === 'projection' && weekNo === 1 && lineId === 'BANK_INTEREST_IN';
        cells.push({
          mode, yearMonth, weekNo, lineId, direction: cashflowLineIds.indexOf(lineId) < 7 ? 'IN' : 'OUT',
          state: empty ? 'EMPTY' : zero ? 'ZERO' : 'VALUE',
          amount: empty ? null : zero ? 0 : (mode === 'projection' ? 10 : 5),
        });
        confirmations.push({ mode, weekNo, cashflowLine: lineId, decision: 'CONFIRMED' });
      }
    }
  }
  const depositScheduleRows = Array.from({ length: 5 }, (_, index) => ({
    weekNo: index + 1,
    taxInvoiceIssuedDate: `${yearMonth}-${String(index + 1).padStart(2, '0')}`,
    expectedDepositDate: `${yearMonth}-${String(index + 6).padStart(2, '0')}`,
    expectedDepositAmount: (index + 1) * 1000,
    actualDepositDate: '', actualDepositAmount: null,
    actualSource: 'NOT_APPLICABLE', decision: 'CONFIRMED',
  }));
  const closeInput = {
    yearMonth, sourceRevision, targetRevision,
    humanReviewed: true,
    depositScheduleRows,
    cells: cells.map(({ lineId, state, yearMonth: _yearMonth, direction: _direction, ...cell }) => ({
      ...cell, cashflowLine: lineId, cellState: state,
    })),
    confirmations,
    managementConfirmations,
  };
  const sheetFacts = {
    metadata: {
      lastUpdateText: { sourceCell: 'B1', value: '최종 업데이트 : 2026.07.01 최종작성자: 보람' },
      businessType: { sourceCell: 'B2', value: 'Type1. 세금계산서발행+공급가액기준' },
      accountType: { sourceCell: 'B3', value: '전용계좌사업' },
      settlementStatus: { sourceCell: 'B4', value: '정산진행' },
    },
    depositScheduleRows: depositScheduleRows.map((row) => ({
      yearMonth, weekNo: row.weekNo,
      taxInvoiceIssuedDate: row.taxInvoiceIssuedDate,
      expectedDepositDate: row.expectedDepositDate,
      expectedDepositAmount: row.expectedDepositAmount,
      sourceCells: {},
    })),
    controlTotals: {
      deposit: { sourceCell: 'BO9', value: 15000, computed: 15000, matches: controlMatches },
      unpaid: { sourceCell: 'BP9', value: 85000 },
      projection: matchingControlRows(14, controlMatches),
      actual: matchingControlRows(37, controlMatches),
    },
    weeklyCalculationChecks: Array.from({ length: 10 }, (_, index) => ({
      mode: index < 5 ? 'projection' : 'actual',
      yearMonth,
      weekNo: (index % 5) + 1,
      sourceCells: {},
      matches: calculationMismatch && index === 0
        ? { depositTotal: false, withdrawalTotal: true, balance: true }
        : { depositTotal: true, withdrawalTotal: true, balance: true },
    })),
    projectionActualDifferences: Array.from({ length: 5 }, (_, index) => ({
      yearMonth, weekNo: index + 1, amount: index === 4 ? -43_962_826 : 0, sourceCell: `A${11 + index}`,
    })),
    issues: [],
  };
  const mirrorCells = [
    ...cells,
    ...additionalYearMonths.flatMap((additionalYearMonth) => (
      cells.map((cell) => ({ ...cell, yearMonth: additionalYearMonth }))
    )),
  ];
  for (const additionalYearMonth of additionalYearMonths) {
    sheetFacts.depositScheduleRows.push(...sheetFacts.depositScheduleRows
      .filter((row) => row.yearMonth === yearMonth)
      .map((row) => ({ ...row, yearMonth: additionalYearMonth })));
    sheetFacts.weeklyCalculationChecks.push(...sheetFacts.weeklyCalculationChecks
      .filter((check) => check.yearMonth === yearMonth)
      .map((check) => ({ ...check, yearMonth: additionalYearMonth })));
    sheetFacts.projectionActualDifferences.push(...sheetFacts.projectionActualDifferences
      .filter((difference) => difference.yearMonth === yearMonth)
      .map((difference) => ({ ...difference, yearMonth: additionalYearMonth })));
  }
  const draftId = `v1_${Buffer.from(JSON.stringify(['cashflow', 'project-a', 'pm-1']), 'utf8').toString('base64url')}`;
  const documents = new Map([
    ACTOR_MEMBER_ENTRY,
    ['orgs/tenant-a/projects/project-a', {
      id: 'project-a', settlementType: 'TYPE1', basis: '공급가액', accountType: 'DEDICATED',
      fundInputMode: 'BANK_UPLOAD', contractAmount, executiveApproverId: 'finance-1',
    }],
    ['orgs/tenant-a/members/finance-1', { uid: 'finance-1', name: 'Finance One', slackUserId: 'U0123456789', role: 'viewer', status: 'ACTIVE', projectIds: ['project-a'] }],
    ['orgs/tenant-a/members/finance-2', { uid: 'finance-2', role: 'finance', status: 'ACTIVE', projectIds: ['project-a'] }],
    ['orgs/tenant-a/members/pm-1', { uid: 'pm-1', name: 'Project Manager', role: 'pm', status: 'ACTIVE', projectIds: ['project-a'] }],
    ['orgs/tenant-a/members/viewer-2', { uid: 'viewer-2', role: 'viewer', status: 'ACTIVE', projectIds: [] }],
    [`orgs/tenant-a/privateEditDrafts/${draftId}`, {
      tenantId: 'tenant-a', ownerUid: 'pm-1', resourceType: 'cashflow', resourceId: 'project-a',
      status: 'ACTIVE', draftRevision: 7,
      payload: { monthClose: closeInput },
    }],
    ['orgs/tenant-a/cashflow_sheet_mirrors/project-a', {
      projectId: 'project-a', status: mirrorStatus, sourceRevision, appliedSourceRevision: sourceRevision, targetRevisionAtFetch: targetRevision,
      weeklyYear: 2026,
      spreadsheetId: 'spreadsheet-a', spreadsheetTitle: '2026 사업비 관리 시트', selectedSheetName: 'cashflow(사용내역 연동)',
      yearMonths: [yearMonth, ...additionalYearMonths], capturedAt: '2026-07-01T00:00:00.000Z', configRevision: `sha256:${'e'.repeat(64)}`,
      cells: mirrorCells, sheetFacts,
    }],
  ]);
  for (const year of [2024, 2025, 2027, 2028, 2029, 2030, 2031, 2032]) {
    const annualId = Buffer.from(`project-a\n${year}`, 'utf8').toString('base64url');
    documents.set(`orgs/tenant-a/cashflow_sheet_year_totals/${annualId}`, {
      projectId: 'project-a',
      year,
      projection: {},
      projectionStates: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, 'EMPTY'])),
      actual: {},
      actualStates: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, 'EMPTY'])),
    });
  }
  return {
    db: {
      doc: (path) => memoryDoc(documents, path),
      runTransaction: memoryTransaction(documents),
      collection: (path) => {
        function query(filters = [], limitValue = null) {
          return {
            where: (field, operator, expected) => {
              if (path.endsWith('/cashflow_month_close_requests')) {
                monthCloseRequestQueries.push({ kind: 'where', field, operator, expected });
              }
              return query([...filters, { field, operator, expected }], limitValue);
            },
            limit: (count) => {
              if (path.endsWith('/cashflow_month_close_requests')) {
                monthCloseRequestQueries.push({ kind: 'limit', count });
              }
              return query(filters, count);
            },
            get: async () => {
              const docs = [...documents.entries()]
                .filter(([documentPath, value]) => (
                  documentPath.startsWith(`${path}/`)
                  && filters.every(({ field, operator, expected }) => (
                    operator === 'in' ? expected.includes(value[field]) : value[field] === expected
                  ))
                ))
                .map(([documentPath, value]) => ({ id: documentPath.split('/').at(-1), data: () => value }));
              return { docs: Number.isSafeInteger(limitValue) ? docs.slice(0, limitValue) : docs };
            },
          };
        }
        return query();
      },
    },
    documents,
    sourceRevision,
    targetRevision,
    closeInput,
    monthCloseRequestQueries,
  };
}

function createMonthCloseDb() {
  const sourceRevision = `sha256:${'c'.repeat(64)}`;
  const targetRevision = `sha256:${'d'.repeat(64)}`;
  const depositScheduleRows = Array.from({ length: 5 }, (_, index) => ({
    weekNo: index + 1,
    taxInvoiceIssuedDate: '', expectedDepositDate: '', actualDepositDate: '',
    actualSource: 'NOT_APPLICABLE', decision: 'NOT_APPLICABLE',
  }));
  const draftId = `v1_${Buffer.from(JSON.stringify(['cashflow', 'project-a', 'pm-1']), 'utf8').toString('base64url')}`;
  const documents = new Map([
    ACTOR_MEMBER_ENTRY,
    [`orgs/tenant-a/privateEditDrafts/${draftId}`, {
      tenantId: 'tenant-a', ownerUid: 'pm-1', resourceType: 'cashflow', resourceId: 'project-a',
      status: 'ACTIVE', draftRevision: 7,
      payload: { monthClose: {
        yearMonth: '2026-06', sourceRevision, targetRevision,
        depositScheduleRows,
        cells: [{ mode: 'projection', weekNo: 1, cashflowLine: 'SALES_IN', cellState: 'VALUE', amount: 1234 }],
        confirmations: [{ mode: 'projection', weekNo: 1, cashflowLine: 'SALES_IN', decision: 'CONFIRMED' }],
        managementChecks: emptyManagementChecks,
        managementConfirmations,
        deadlineSummary: { trackingStartedAt: null, missedCount: 0, completedCount: 0, current: null },
      } },
    }],
    ['orgs/tenant-a/cashflow_sheet_mirrors/project-a', {
      projectId: 'project-a', status: 'FRESH', sourceRevision, appliedSourceRevision: sourceRevision, targetRevisionAtFetch: targetRevision,
      weeklyYear: 2026,
      yearMonths: ['2026-06'], capturedAt: '2026-07-01T00:00:00.000Z',
      sheetFacts: {
        metadata: {},
        depositScheduleRows: depositScheduleRows.map((row) => ({
          yearMonth: '2026-06', weekNo: row.weekNo,
          taxInvoiceIssuedDate: '', expectedDepositDate: '', expectedDepositAmount: null,
          sourceCells: {},
        })),
        controlTotals: {
          deposit: { sourceCell: 'BO9', value: 0, computed: 0, matches: true },
          unpaid: { sourceCell: 'BP9', value: null },
          projection: matchingControlRows(14),
          actual: matchingControlRows(37),
        },
        issues: [],
      },
    }],
  ]);
  return {
    documents,
    doc: (path) => memoryDoc(documents, path),
    runTransaction: memoryTransaction(documents),
  };
}

const weeklyLeaseWriterRoutes = [
  '/api/v1/weekly-expenses/project-a/sheets/default/save-draft',
  '/api/v1/weekly-expenses/project-a/bank-statements/import-batch',
  '/api/v1/weekly-expenses/project-a/bank-statements/apply-items',
  '/api/v1/weekly-expenses/project-a/sheets/default/commands/cell-patch',
  '/api/v1/weekly-expenses/project-a/sheets/default/commands/copy',
  '/api/v1/weekly-expenses/project-a/sheets/default/commands/paste',
  '/api/v1/weekly-expenses/project-a/sheets/default/commands/cut',
  '/api/v1/weekly-expenses/project-a/sheets/default/commands/row-insert',
  '/api/v1/weekly-expenses/project-a/sheets/default/commands/row-delete',
];

const unlockedCashflowWriterRoutes = [
  '/api/v1/cashflow-metadata/project-a/variance',
];

function createApp(fetchImpl, idempotencyService = createIdempotencyService(), contextPatch = {}, routeOptions = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (routeOptions.settlementCycleMarker !== false
      && req.method === 'POST'
      && req.path.includes('/month-close/')
      && !req.path.endsWith('/approver')
      && req.body?.settlementCycle === undefined) {
      req.body = { ...req.body, settlementCycle: true };
    }
    req.context = {
      tenantId: 'tenant-a',
      actorId: 'pm-1',
      actorRole: 'pm',
      actorEmail: 'pm@example.com',
      requestId: 'req-1',
      idempotencyKey: req.header('idempotency-key') || undefined,
      ...contextPatch,
    };
    next();
  });
  mountJvmWeeklyApiRoutes(app, {
    idempotencyService,
    fetchImpl: async (...args) => {
      if (String(args[0]).includes('/month-close/reopen-authority')
        && routeOptions.forwardReopenAuthorityFetch !== true) {
        const stub = typeof routeOptions.reopenAuthorityResponse === 'function'
          ? routeOptions.reopenAuthorityResponse()
          : routeOptions.reopenAuthorityResponse || {
            ok: true,
            commandName: 'cashflowMonth.readReopenAuthority',
            projectId: 'project-a',
            availability: 'FORBIDDEN',
            canDecideReopen: false,
            guide: '',
          };
        return new Response(JSON.stringify(stub), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (String(args[0]).includes('/weekly-update-compliance') && routeOptions.forwardWeeklyComplianceFetch !== true) {
        const stub = typeof routeOptions.weeklyComplianceResponse === 'function'
          ? routeOptions.weeklyComplianceResponse()
          : routeOptions.weeklyComplianceResponse || { items: [], nextCursor: '', onTimeCount: 0, missedCount: 0 };
        return new Response(JSON.stringify(stub), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      const response = await fetchImpl(...args);
      if (response instanceof Response || response?.body) return response;
      return new Response(await response.text(), {
        status: response.status,
        headers: response.headers,
      });
    },
    jvmWeeklyApiBaseUrl: 'http://jvm-weekly.local',
    jvmWeeklyApiServiceToken: 'test-service-token',
    ...routeOptions,
  });
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({
      code: error.code || 'error',
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  });
  return { app, idempotencyService };
}

function createCashflowActivityTestDb({ eventsByCollection = {}, failingCollections = [] } = {}) {
  const queries = [];
  const failures = new Set(failingCollections);
  const fieldName = (field) => typeof field === 'string' ? field : String(field);
  const compareValues = (left, right, direction) => {
    const leftText = String(left ?? '');
    const rightText = String(right ?? '');
    const compared = leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
    return direction === 'desc' ? -compared : compared;
  };

  return {
    queries,
    db: {
      collection: (collectionPath) => {
        const collectionId = collectionPath.split('/').at(-1);
        const state = {
          filters: [],
          orderBys: [],
          limit: null,
          startAfter: [],
        };
        const query = {
          where: (field, operator, expected) => {
            state.filters.push([fieldName(field), operator, expected]);
            return query;
          },
          orderBy: (field, direction) => {
            state.orderBys.push([fieldName(field), direction]);
            return query;
          },
          startAfter: (...values) => {
            const [first] = values;
            state.startAfter = values.length === 1 && first?.id && typeof first.data === 'function'
              ? [first.data()?.createdAt, first.id]
              : values;
            return query;
          },
          limit: (value) => {
            state.limit = value;
            return query;
          },
          get: async () => {
            queries.push({
              collectionId,
              filters: structuredClone(state.filters),
              orderBys: structuredClone(state.orderBys),
              limit: state.limit,
              startAfter: structuredClone(state.startAfter),
            });
            if (failures.has(collectionId)) throw new Error(`${collectionId} unavailable`);

            let documents = (eventsByCollection[collectionId] || []).map((entry) => {
              const { __documentId, ...value } = entry;
              return {
                id: __documentId || entry.id,
                value,
              };
            });
            documents = documents.filter((document) => state.filters.every(([field, operator, expected]) => (
              operator === '==' && document.value[field] === expected
            )));
            if (state.orderBys.length > 0) {
              documents.sort((left, right) => {
                for (const [field, direction] of state.orderBys) {
                  const leftValue = field === '__name__' ? left.id : left.value[field];
                  const rightValue = field === '__name__' ? right.id : right.value[field];
                  const compared = compareValues(leftValue, rightValue, direction);
                  if (compared !== 0) return compared;
                }
                return 0;
              });
            }
            if (state.startAfter.length > 0) {
              const [createdAt, id] = state.startAfter;
              const boundary = documents.findIndex((document) => (
                document.value.createdAt === createdAt && document.id === id
              ));
              documents = boundary >= 0 ? documents.slice(boundary + 1) : [];
            }
            if (Number.isSafeInteger(state.limit)) documents = documents.slice(0, state.limit);
            return {
              docs: documents.map((document) => ({
                id: document.id,
                data: () => document.value,
              })),
            };
          },
        };
        return query;
      },
    },
  };
}

function canonicalCycleMonthCloseFixture(cycleYearMonth = '2026-09', {
  transitionAction = '', approve = false, reopen = false,
  actorId = 'pm-1', actorRole = 'pm', transitionReceiptPatch = {},
} = {}) {
  const targetYearMonth = previousMonthOf(cycleYearMonth);
  const requestId = `project-a-${cycleYearMonth}`;
  const source = fullMonthCloseSource({ yearMonth: targetYearMonth });
  let monthClose = {
    ok: true, projectId: 'project-a', yearMonth: cycleYearMonth, status: 'OPEN', revision: approve ? 6 : 0,
    reopenCount: 0, projectWarningCount: 0, snapshot: {},
  };
  let dashboard = monthDashboardSource(monthClose);
  const submitBodies = [];
  const monthCloseBodies = [];
  let acceptedMonthCloseBody = null, acceptedMonthCloseReceipt = null;
  const reopenRequestBodies = [], reopenDecisionBodies = [];
  let acceptedReopenRequestBody = null, acceptedReopenRequestReceipt = null;
  let acceptedReopenDecisionBody = null, acceptedReopenDecisionReceipt = null;
  const transitionBodies = [];
  let acceptedTransitionBody = null, acceptedTransitionReceipt = null;
  const bffWrites = [];
  const cashflowSlackService = { enabled: true, notifyMessage: vi.fn().mockResolvedValue(undefined) };
  if (reopen) {
    const manifestHash = `sha256:${'a'.repeat(64)}`;
    source.documents.set(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`, {
      ...canonicalMonthCloseRequest(cycleYearMonth, 'APPROVED', {
        manifestHash, workflowRevision: 2, ledgerRevision: 7, approvalVersionId: 'approval-v2',
        reviewedAt: `${cycleYearMonth}-11T04:00:00Z`, reviewedByUid: 'finance-1',
      }),
    });
    monthClose = {
      ...monthClose, status: 'CLOSED', revision: 7,
      closedAt: `${cycleYearMonth}-11T04:00:00Z`, closedByUid: 'finance-1', auditId: 'month-close-approve-1',
      requestId, requestRevision: 1, manifestHash, rootHash: manifestHash, headRevision: 1,
    };
    dashboard = withCanonicalLockedCycle(monthDashboardSource(monthClose), {
      provenanceLedgerRevision: 7, rootHash: manifestHash,
    });
    dashboard.monthClose = { ...dashboard.monthClose, status: 'OPEN' };
  } else if (transitionAction || approve) {
    const canonicalRequest = canonicalMonthCloseRequest(cycleYearMonth, 'PENDING_APPROVAL', {
      requestedAt: `${cycleYearMonth}-10T02:00:00Z`, reviewWarnings: ['canonical-reread'],
      ...(approve ? { manifestHash: `sha256:${'a'.repeat(64)}` } : {}),
    });
    delete canonicalRequest.ledgerRevision;
    source.documents.set(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`, canonicalRequest);
    const capabilities = {
      ...deniedSettlementCycleCapabilities(),
      ...(transitionAction === 'WITHDRAW'
        ? { WITHDRAW_MONTH_CLOSE: { allowed: true, reasonCode: '' } }
        : transitionAction === 'REJECT' ? {
          APPROVE_MONTH_CLOSE: { allowed: true, reasonCode: '' },
          REJECT_MONTH_CLOSE: { allowed: true, reasonCode: '' },
        } : { APPROVE_MONTH_CLOSE: { allowed: true, reasonCode: '' } }),
    };
    dashboard = withCanonicalCycle(monthDashboardSource(monthClose), {
      businessState: 'SUBMITTED', commandCapabilities: capabilities,
    });
  }
  const fetchImpl = vi.fn(async (url, init = {}) => {
    if (url.includes('/month-close/dashboard-source')) {
      if (!url.includes('settlementCycle=true')) throw new Error('canonical settlement-cycle read was not requested');
      return new Response(JSON.stringify(structuredClone(dashboard)), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/settlement-cycle/submit') && init.method === 'POST') {
      const submitted = JSON.parse(init.body);
      const stage = source.documents.get(
        `orgs/tenant-a/cashflow_month_close_requests/${requestId}/stages/${submitted.stageId}`,
      );
      if (stage?.cycleYearMonth !== cycleYearMonth || stage?.throughMonth !== targetYearMonth) {
        throw new Error('canonical settlement-cycle evidence was not staged');
      }
      submitBodies.push(submitted);
      const canonicalRequest = canonicalMonthCloseRequest(cycleYearMonth, 'PENDING_APPROVAL', {
        revision: submitted.evidenceRevision,
        evidenceRevision: submitted.evidenceRevision,
        workflowRevision: 1,
        manifestHash: submitted.manifestHash,
        requestedAt: `${cycleYearMonth}-10T02:00:00Z`,
      });
      delete canonicalRequest.ledgerRevision;
      source.documents.set(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`, canonicalRequest);
      dashboard = withCanonicalSubmittedCycle(monthDashboardSource(monthClose));
      return new Response(JSON.stringify({
        ok: true, commandName: 'cashflowSettlementCycle.submit', projectId: 'project-a',
        cycleYearMonth, monthCloseTargetYearMonth: targetYearMonth, requestId,
        businessState: 'SUBMITTED', workflowRevision: 1,
        evidenceRevision: submitted.evidenceRevision, manifestHash: submitted.manifestHash,
        submittedAt: `${cycleYearMonth}-10T01:00:00Z`, submittedByUid: 'pm-1', approverUid: 'finance-1',
        decidedAt: '', decidedByUid: '', reason: '', auditId: 'settlement-cycle-submit-1',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (approve && url.endsWith('/month-close') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      monthCloseBodies.push(body);
      if (acceptedMonthCloseBody && JSON.stringify(body) !== JSON.stringify(acceptedMonthCloseBody)) {
        return new Response(JSON.stringify({ code: 'cashflow_month_close_conflict' }), {
          status: 409, headers: { 'content-type': 'application/json' },
        });
      }
      if (acceptedMonthCloseReceipt) return new Response(JSON.stringify(acceptedMonthCloseReceipt), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
      const reviewedAt = `${cycleYearMonth}-11T04:00:00Z`;
      const current = source.documents.get(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`);
      const ledgerRevision = body.expectedRevision + 1;
      source.documents.set(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`, {
        ...current, status: 'APPROVED', workflowRevision: body.expectedWorkflowRevision + 1,
        ledgerRevision, approvalVersionId: 'approval-v2', reviewedAt,
        reviewedByUid: actorId, decisionReason: body.decisionReason,
        reviewIdempotencyKey: body.idempotencyKey,
      });
      monthClose = {
        ...monthClose, status: 'CLOSED', revision: ledgerRevision,
        closedAt: reviewedAt, closedByUid: actorId,
        requestId, requestRevision: body.requestRevision, manifestHash: body.manifestHash,
        rootHash: body.manifestHash, headRevision: 1, snapshot: { source: 'canonical-reread' },
      };
      dashboard = withCanonicalCycle(monthDashboardSource(monthClose), {
        businessState: 'LOCKED', provenanceLedgerRevision: ledgerRevision, rootHash: body.manifestHash,
      });
      acceptedMonthCloseBody = body;
      acceptedMonthCloseReceipt = {
        ok: true, commandName: 'cashflowMonth.close', projectId: 'project-a',
        yearMonth: cycleYearMonth, status: 'CLOSED', revision: ledgerRevision,
        closedAt: reviewedAt, closedByUid: actorId, auditId: 'month-close-approve-1',
        requestId, requestRevision: body.requestRevision, manifestHash: body.manifestHash,
        rootHash: body.manifestHash, headRevision: 1,
      };
      return new Response(JSON.stringify(acceptedMonthCloseReceipt), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (reopen && url.endsWith('/month-close/reopen-request') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const commandActorId = new Headers(init.headers).get('x-actor-id') || actorId;
      reopenRequestBodies.push(body);
      if (acceptedReopenRequestBody && JSON.stringify(body) !== JSON.stringify(acceptedReopenRequestBody)) {
        return new Response(JSON.stringify({ code: 'cashflow_month_reopen_conflict' }), {
          status: 409, headers: { 'content-type': 'application/json' },
        });
      }
      if (acceptedReopenRequestReceipt) return new Response(JSON.stringify(acceptedReopenRequestReceipt), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
      const requestedAt = `${cycleYearMonth}-12T01:00:00Z`;
      const current = source.documents.get(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`);
      source.documents.set(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`, {
        ...current, status: 'REOPEN_REQUESTED', workflowRevision: body.expectedWorkflowRevision + 1,
        ledgerRevision: body.expectedRevision + 1,
        reopenRequest: { reason: body.reason, requestedAt, requestedByUid: commandActorId, idempotencyKey: body.idempotencyKey },
        reopenDecision: {},
      });
      monthClose = {
        ...monthClose, status: 'REOPEN_REQUESTED', revision: body.expectedRevision + 1,
        reopenReason: body.reason, reopenRequestedAt: requestedAt, reopenRequestedByUid: commandActorId,
      };
      dashboard = withCanonicalCycle(monthDashboardSource(monthClose), {
        businessState: 'REOPEN_REQUESTED', provenanceLedgerRevision: 7,
        rootHash: body.manifestHash, workflowRevision: body.expectedWorkflowRevision + 1,
        commandCapabilities: {
          ...deniedSettlementCycleCapabilities(),
          APPROVE_MONTH_REOPEN: { allowed: true, reasonCode: '' },
          REJECT_MONTH_REOPEN: { allowed: true, reasonCode: '' },
        },
      });
      dashboard.monthClose = { ...dashboard.monthClose, status: 'OPEN' };
      acceptedReopenRequestBody = body;
      acceptedReopenRequestReceipt = {
        ok: true, commandName: 'cashflowMonth.requestReopen', projectId: 'project-a',
        yearMonth: cycleYearMonth, status: 'REOPEN_REQUESTED', revision: body.expectedRevision + 1,
        reopenReason: body.reason, reopenRequestedAt: requestedAt, reopenRequestedByUid: commandActorId,
        auditId: 'month-close-reopen-request-1', requestId, requestRevision: body.evidenceRevision,
        manifestHash: body.manifestHash, rootHash: body.manifestHash, headRevision: 1,
      };
      return new Response(JSON.stringify(acceptedReopenRequestReceipt), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (reopen && url.endsWith('/month-close/reopen-decision') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const commandActorId = new Headers(init.headers).get('x-actor-id') || actorId;
      reopenDecisionBodies.push(body);
      if (acceptedReopenDecisionBody && JSON.stringify(body) !== JSON.stringify(acceptedReopenDecisionBody)) {
        return new Response(JSON.stringify({ code: 'cashflow_month_reopen_conflict' }), {
          status: 409, headers: { 'content-type': 'application/json' },
        });
      }
      if (acceptedReopenDecisionReceipt) return new Response(JSON.stringify(acceptedReopenDecisionReceipt), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
      const decidedAt = `${cycleYearMonth}-12T02:00:00Z`;
      const current = source.documents.get(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`);
      const approved = body.decision === 'APPROVE';
      source.documents.set(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`, {
        ...current, status: approved ? 'REOPENED' : 'APPROVED',
        workflowRevision: body.expectedWorkflowRevision + 1, ledgerRevision: body.expectedRevision + 1,
        reopenDecision: {
          decision: body.decision, reason: body.reason, decidedAt,
          decidedByUid: commandActorId, idempotencyKey: body.idempotencyKey,
        },
      });
      monthClose = {
        ...monthClose, status: approved ? 'OPEN' : 'CLOSED', revision: body.expectedRevision + 1,
        reopenCount: approved ? 1 : 0, reopenDecision: body.decision,
        reopenDecisionReason: body.reason, reopenDecidedAt: decidedAt, reopenDecidedByUid: commandActorId,
      };
      dashboard = withCanonicalCycle(monthDashboardSource(monthClose), {
        businessState: approved ? 'REOPENED' : 'LOCKED',
        provenanceLedgerRevision: 7, rootHash: body.manifestHash,
        workflowRevision: body.expectedWorkflowRevision + 1,
      });
      dashboard.monthClose = { ...dashboard.monthClose, status: 'OPEN' };
      acceptedReopenDecisionBody = body;
      acceptedReopenDecisionReceipt = {
        ok: true, commandName: 'cashflowMonth.decideReopen', projectId: 'project-a',
        yearMonth: cycleYearMonth, status: approved ? 'OPEN' : 'CLOSED', revision: body.expectedRevision + 1,
        reopenDecision: body.decision, reopenDecisionReason: body.reason,
        reopenDecidedAt: decidedAt, reopenDecidedByUid: commandActorId,
        auditId: 'month-close-reopen-decision-1', requestId, requestRevision: body.evidenceRevision,
        manifestHash: body.manifestHash, rootHash: body.manifestHash, headRevision: 1,
      };
      return new Response(JSON.stringify(acceptedReopenDecisionReceipt), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/settlement-cycle/transition') && init.method === 'POST') {
      const transitioned = JSON.parse(init.body);
      transitionBodies.push(transitioned);
      if (acceptedTransitionBody && JSON.stringify(transitioned) !== JSON.stringify(acceptedTransitionBody)) {
        return new Response(JSON.stringify({
          code: 'cashflow_settlement_cycle_request_conflict',
          message: '동일한 요청 키의 월 결산 전이 입력이 변경되었습니다.',
        }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      if (acceptedTransitionReceipt) return new Response(JSON.stringify(acceptedTransitionReceipt), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
      const finalStatus = transitioned.action === 'WITHDRAW' ? 'WITHDRAWN' : 'REJECTED';
      const decidedAt = `${cycleYearMonth}-11T03:00:00Z`;
      const current = source.documents.get(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`);
      const canonicalRequest = {
        ...current,
        status: finalStatus,
        workflowRevision: transitioned.expectedWorkflowRevision + 1,
        ...(finalStatus === 'WITHDRAWN' ? {
          withdrawnAt: decidedAt,
          withdrawnByUid: actorId,
          withdrawReason: transitioned.reason,
        } : {
          reviewedAt: decidedAt,
          reviewedByUid: actorId,
          decisionReason: transitioned.reason,
        }),
      };
      source.documents.set(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`, canonicalRequest);
      dashboard = withCanonicalCycle(monthDashboardSource(monthClose), {
        businessState: finalStatus, commandCapabilities: deniedSettlementCycleCapabilities(),
      });
      acceptedTransitionBody = transitioned;
      acceptedTransitionReceipt = {
        ok: true, commandName: 'cashflowSettlementCycle.transition', projectId: 'project-a',
        cycleYearMonth, monthCloseTargetYearMonth: targetYearMonth, requestId,
        businessState: finalStatus, workflowRevision: transitioned.expectedWorkflowRevision + 1,
        evidenceRevision: transitioned.evidenceRevision, manifestHash: transitioned.manifestHash,
        submittedAt: current.requestedAt, submittedByUid: current.requestedByUid,
        approverUid: current.approverUid, decidedAt, decidedByUid: actorId,
        reason: transitioned.reason, auditId: `settlement-cycle-${transitioned.action.toLowerCase()}-1`,
        ...transitionReceiptPatch,
      };
      return new Response(JSON.stringify(acceptedTransitionReceipt), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected JVM request: ${url}`);
  });
  const db = transitionAction || approve || reopen ? {
    ...source.db,
    doc: (path) => {
      const ref = source.db.doc(path);
      return { ...ref, set: async (...args) => {
        bffWrites.push(path);
        return ref.set(...args);
      } };
    },
    runTransaction: (callback) => source.db.runTransaction((transaction) => callback({
      ...transaction,
      set: (...args) => {
        bffWrites.push(args[0].path);
        return transaction.set(...args);
      },
    })),
  } : source.db;
  const appFor = (nextActorId = actorId, nextActorRole = actorRole) => createApp(
    fetchImpl, createIdempotencyService(), { actorId: nextActorId, actorRole: nextActorRole }, {
      env: runtimeEnv, db, cashflowSlackService,
      now: () => new Date(`${cycleYearMonth}-10T00:00:00Z`),
    },
  ).app;
  const setCapability = (name, allowed, reasonCode = '') => {
    dashboard.settlementCycle.commandCapabilities[name] = { allowed, reasonCode };
  };
  return {
    app: appFor(), appFor, source, submitBodies, transitionBodies, monthCloseBodies,
    reopenRequestBodies, reopenDecisionBodies, bffWrites, cashflowSlackService, setCapability,
  };
}

describe('JVM weekly API BFF proxy', () => {
  it('proxies the lightweight month and weekly settlement status flow', async () => {
    const canonical = canonicalSettlementStatuses();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(canonical), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv });

    await request(app)
      .get('/api/v1/cashflow/project-a/settlement-statuses?yearMonth=2026-08')
      .expect(200, canonical);
    await request(app)
      .post('/api/v1/cashflow/project-a/settlement-statuses/transition')
      .send({ yearMonth: '2026-08', period: 'WEEK_3', action: 'APPROVE' })
      .expect(200, canonical);

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://jvm-weekly.local/api/v1/cashflow/project-a/settlement-statuses?yearMonth=2026-08',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://jvm-weekly.local/api/v1/cashflow/project-a/settlement-statuses/transition',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ yearMonth: '2026-08', period: 'WEEK_3', action: 'APPROVE' }) }),
    );
  });

  it('keeps JVM-sent weekly deadlines instead of overwriting them with the BFF copy', async () => {
    // 주간 마감의 단일 소스는 JVM CashflowWeekDeadline 이다. BFF parity 사본은 JVM 이
    // 값을 보내지 않는 구버전 응답에만 채운다. 일부러 사본과 다른 값을 JVM 이 보내게 해서
    // 어느 쪽이 이기는지 고정한다 - 사본이 이기면 규칙이 조용히 갈린다.
    const source = fullMonthCloseSource();
    const settlement = canonicalSettlementStatuses();
    settlement.items[1] = {
      ...settlement.items[1],
      status: 'COMPLETED',
      deadlineAt: '2026-08-01T15:00:00.000Z',
      approverDeadlineAt: '2026-08-02T04:00:00.000Z',
    };
    const fetchImpl = vi.fn(async (_url, init) => new Response(JSON.stringify(
      init.method === 'POST' ? { items: [structuredClone(settlement)], errors: [] } : structuredClone(settlement),
    ), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv, db: source.db });

    await request(app)
      .get('/api/v1/cashflow/project-a/settlement-statuses?yearMonth=2026-08')
      .expect(200)
      .expect((response) => {
        const week = response.body.items.find((item) => item.period === 'WEEK_1');
        expect(week.deadlineAt).toBe('2026-08-01T15:00:00.000Z');
        expect(week.approverDeadlineAt).toBe('2026-08-02T04:00:00.000Z');
      });
  });

  it('uses the canonical JVM MONTH status without aligning from a BFF request document', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08', {
      requestId: 'project-a-2026-08', projectId: 'project-a', yearMonth: '2026-08', status: 'PENDING',
    });
    const settlement = canonicalSettlementStatuses();
    settlement.items[0] = {
      ...settlement.items[0],
      status: 'LOCKED',
      approvedAt: '2026-08-12T01:00:00Z',
      approvedBy: 'finance-1',
    };
    settlement.items[1] = { ...settlement.items[1], status: 'COMPLETED' };
    const fetchImpl = vi.fn(async (_url, init) => new Response(JSON.stringify(
      init.method === 'POST' ? { items: [structuredClone(settlement)], errors: [] } : structuredClone(settlement),
    ), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv, db: source.db });

    await request(app)
      .get('/api/v1/cashflow/project-a/settlement-statuses?yearMonth=2026-08')
      .expect(200)
      .expect((response) => {
        expect(response.body.items).toEqual(expect.arrayContaining([
          expect.objectContaining({ period: 'MONTH', status: 'LOCKED' }),
          expect.objectContaining({ period: 'WEEK_1', status: 'COMPLETED' }),
        ]));
      });
    await request(app)
      .post('/api/v1/cashflow/settlement-statuses/batch')
      .send({ projectIds: ['project-a'], yearMonth: '2026-08' })
      .expect(200)
      .expect((response) => expect(response.body.items[0].items[0]).toMatchObject({
        period: 'MONTH',
        status: 'LOCKED',
      }));
  });

  it('blocks an administrator from submitting an uncompleted settlement', async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'admin' }, { env: runtimeEnv });

    await request(app)
      .post('/api/v1/cashflow/project-a/settlement-statuses/transition')
      .send({ yearMonth: '2026-08', period: 'WEEK_3', action: 'SUBMIT' })
      .expect(403)
      .expect((response) => expect(response.body.code).toBe('cashflow_settlement_submit_forbidden'));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects MONTH at the generic settlement transition boundary without calling JVM', async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'admin' }, { env: runtimeEnv });

    await request(app)
      .post('/api/v1/cashflow/project-a/settlement-statuses/transition')
      .send({ yearMonth: '2026-08', period: 'MONTH', action: 'APPROVE' })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('MONTH_REQUIRES_CLOSE_WORKFLOW'));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects all seven canonical MONTH mutations from stale clients before dependencies', async () => {
    const dependencyTouched = () => { throw new Error('canonical dependency touched'); };
    const db = {
      doc: vi.fn(dependencyTouched),
      collection: vi.fn(dependencyTouched),
      runTransaction: vi.fn(dependencyTouched),
    };
    const fetchImpl = vi.fn(dependencyTouched);
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv, db, settlementCycleMarker: false,
    });
    const mutations = [
      ['SUBMIT_MONTH_CLOSE', '/api/v1/cashflow/project-a/month-close/requests', {}],
      ['WITHDRAW_MONTH_CLOSE', '/api/v1/cashflow/project-a/month-close/requests/project-a-2026-08/withdraw', {}],
      ['APPROVE_MONTH_CLOSE', '/api/v1/cashflow/project-a/month-close/requests/project-a-2026-08/status-review', { decision: 'APPROVE' }],
      ['REJECT_MONTH_CLOSE', '/api/v1/cashflow/project-a/month-close/requests/project-a-2026-08/review', { decision: 'REJECT' }],
      ['REQUEST_MONTH_REOPEN', '/api/v1/cashflow/project-a/month-close/reopen-request', {}],
      ['APPROVE_MONTH_REOPEN', '/api/v1/cashflow/project-a/month-close/reopen-decision', { decision: 'APPROVE' }],
      ['REJECT_MONTH_REOPEN', '/api/v1/cashflow/project-a/month-close/reopen-decision', { decision: 'REJECT' }],
    ];

    for (const marker of [undefined, false]) {
      for (const [action, path, body] of mutations) {
        await request(app)
          .post(path)
          .set('idempotency-key', `stale-${action}-${String(marker)}`)
          .send(marker === undefined ? body : { ...body, settlementCycle: marker })
          .expect(409)
          .expect((response) => expect(response.body.code).toBe('client_upgrade_required'));
      }
    }

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.doc).not.toHaveBeenCalled();
    expect(db.collection).not.toHaveBeenCalled();
    expect(db.runTransaction).not.toHaveBeenCalled();
  });

  it('rejects a historical MONTH approver mutation before dependencies', async () => {
    const dependencyTouched = vi.fn(() => { throw new Error('historical dependency touched'); });
    const { app } = createApp(dependencyTouched, createIdempotencyService(), {}, {
      env: runtimeEnv, db: { doc: dependencyTouched, collection: dependencyTouched, runTransaction: dependencyTouched },
    });
    await request(app).post('/api/v1/cashflow/project-a/month-close/approver')
      .set('idempotency-key', 'historical-approver')
      .send({ approverUid: 'finance-1', yearMonth: '2026-08' })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_settlement_cycle_historical_read_only'));
    expect(dependencyTouched).not.toHaveBeenCalled();
  });

  it.each([
    ['2026-09', '2026-08', '2026-09-10', '2026-09-10T15:00:00.000Z', '2026-09-30T15:00:00.000Z'],
    ['2027-01', '2026-12', '2027-01-10', '2027-01-10T15:00:00.000Z', '2027-01-31T15:00:00.000Z'],
  ])('keeps the %s cycle deadlines through request, stage, JVM save, and canonical reread', async (
    cycleYearMonth, targetYearMonth, closeDeadline, closeDeadlineAt, approverDeadlineAt,
  ) => {
    const { app, source, submitBodies } = canonicalCycleMonthCloseFixture(cycleYearMonth);
    const before = await request(app).get(`/api/v1/cashflow/project-a/month-close?yearMonth=${cycleYearMonth}`).expect(200);
    const deadlines = { closeDeadline, closeDeadlineAt, approverDeadlineAt };
    expect(before.body).toMatchObject(deadlines);

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close/requests')
      .set('idempotency-key', 'submit-cycle-target-1')
      .send({
        contractVersion: 'cashflow-cumulative-close-v2', yearMonth: cycleYearMonth,
        expectedRevision: before.body.revision, expectedWorkflowRevision: before.body.settlementCycle.workflowRevision,
        expectedApproverUid: 'finance-1', expectedProjectVersion: 0,
        expectedOpeningBalances: before.body.dashboard.openingBalances,
        closeInput: { ...source.closeInput, managementChecks: before.body.dashboard.managementChecks },
      })
      .expect(202)
      .expect((response) => expect(response.body).toMatchObject({
        status: 'PENDING_APPROVAL', requestedAt: `${cycleYearMonth}-10T02:00:00Z`,
      }));
    expect(submitBodies).toEqual([expect.objectContaining({
      cycleYearMonth, monthCloseTargetYearMonth: targetYearMonth, expectedWorkflowRevision: 0,
    })]);

    const after = await request(app).get(`/api/v1/cashflow/project-a/month-close?yearMonth=${cycleYearMonth}`).expect(200);
    expect(after.body).toMatchObject({
      ...deadlines, targetYearMonth, settlementCycle: { businessState: 'SUBMITTED' },
      monthState: { requestedByName: 'Project Manager', approverName: 'Finance One' },
    });
  });

  it('reads up to 100 project settlement statuses with one JVM batch request', async () => {
    const projectIds = Array.from({ length: 100 }, (_, index) => `project-${index + 1}`);
    const canonical = {
      items: [canonicalSettlementStatuses('project-1', '2026-09')],
      errors: projectIds.slice(1).map((projectId) => ({ projectId, code: 'STATUS_UNAVAILABLE' })),
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(canonical), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv });

    await request(app)
      .post('/api/v1/cashflow/settlement-statuses/batch')
      .send({ projectIds, yearMonth: '2026-09' })
      .expect(200, canonical);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://jvm-weekly.local/api/v1/cashflow/settlement-statuses/batch?settlementCycle=true',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectIds, yearMonth: '2026-09' }) }),
    );
  });

  it('fails canonical single and batch settlement reads closed on malformed coverage', async () => {
    const malformedSingle = canonicalSettlementStatuses();
    malformedSingle.items = malformedSingle.items.filter((item) => item.period !== 'WEEK_3');
    const missingBatchProject = {
      items: [canonicalSettlementStatuses('project-a')],
      errors: [],
    };
    const fetchImpl = vi.fn(async (url) => new Response(JSON.stringify(
      String(url).includes('/batch') ? missingBatchProject : malformedSingle
    ), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv });

    await request(app)
      .get('/api/v1/cashflow/project-a/settlement-statuses?yearMonth=2026-08')
      .expect(502);
    await request(app)
      .post('/api/v1/cashflow/settlement-statuses/batch')
      .send({ projectIds: ['project-a', 'project-b'], yearMonth: '2026-08' })
      .expect(502);
  });

  it('rejects invalid settlement scopes before calling JVMP', async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv });

    await request(app)
      .get('/api/v1/cashflow/project-a/settlement-statuses?yearMonth=2026-13')
      .expect(400);
    await request(app)
      .post('/api/v1/cashflow/project-a/settlement-statuses/transition')
      .send({ yearMonth: '2026-08', period: 'WEEK_6', action: 'APPROVE' })
      .expect(400);
    await request(app)
      .post('/api/v1/cashflow/settlement-statuses/batch')
      .send({ projectIds: ['duplicate', 'duplicate'], yearMonth: '2026-08' })
      .expect(400);
    await request(app)
      .post('/api/v1/cashflow/settlement-statuses/batch')
      .send({ projectIds: Array.from({ length: 101 }, (_, index) => `project-${index}`), yearMonth: '2026-08' })
      .expect(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads the latest synced sheet formula values without calling the JVM summary endpoint', async () => {
    const { db } = fullMonthCloseSource();
    const fetchImpl = vi.fn();
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv, db, now: () => new Date('2026-06-30T00:00:00.000Z'),
    });

    const response = await request(app)
      .post('/api/v1/cashflow/projection-actual-summary/batch')
      .send({ projectIds: ['project-a'], yearMonth: '2026-06' })
      .expect(200);

    expect(response.body).toMatchObject({
      version: '2', errors: [], items: [{
        projectId: 'project-a', source: 'SHEET_FORMULA', differenceAmount: -43_962_826,
        comparisonAsOfWeek: { yearMonth: '2026-06', weekNo: 5 },
        display: {
          periodLabel: '누적 2026-01~2026-06 5주차',
          statusLabel: '불일치',
          statusTone: 'danger',
          differenceLabel: '차액 -43,962,826원',
        },
      }],
    });
    expect(response.body.items[0].periods.find((period) => period.period === 'WEEK_5')).toEqual({
      period: 'WEEK_5', differenceAmount: -43_962_826,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('opts into the canonical JVM weekly overview and publishes only BFF v5', async () => {
    const source = fullMonthCloseSource();
    const canonical = canonicalWeeklyOverviewResponse('2026-09');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(canonical), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
    });

    const response = await request(app)
      .post('/api/v1/cashflow/weekly-overview')
      .send({ projectIds: ['project-a'], yearMonth: '2026-09' })
      .expect(200);

    expect(response.body).toMatchObject({
      version: '5',
      yearMonth: '2026-09',
      items: [{
        projectId: 'project-a',
        settlementStatuses: {
          yearMonth: '2026-09',
        },
        settlementCycle: {
          cycleYearMonth: '2026-09',
          monthCloseTargetYearMonth: '2026-08',
          businessState: 'SUBMITTED',
        },
      }],
    });
    expect(response.body.items[0].settlementStatuses.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ period: 'MONTH', status: 'SUBMITTED' }),
      expect.objectContaining({ period: 'WEEK_1', status: 'PENDING_APPROVAL' }),
    ]));
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://jvm-weekly.local/api/v1/cashflow/weekly-overview',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          projectIds: ['project-a'], yearMonth: '2026-09', settlementCycle: true,
        }),
      }),
    );
  });

  it.each([
    ['legacy JVM version', (canonical) => { canonical.version = '1'; }],
    ['missing cycle', (canonical) => { delete canonical.items[0].settlementCycle; }],
    ['foreign cycle', (canonical) => { canonical.items[0].settlementCycle.cycleYearMonth = '2026-10'; }],
    ['duplicate cycle item', (canonical) => { canonical.items.push({ ...canonical.items[0] }); }],
    ['legacy MONTH state', (canonical) => {
      canonical.items[0].settlementCycle.businessState = 'PENDING_APPROVAL';
      canonical.items[0].settlementCycle.monthCloseSettlement.status = 'PENDING_APPROVAL';
    }],
    ['split-brain target-key MONTH status', (canonical) => {
      canonical.items[0].settlementStatuses.items[0] = {
        ...canonical.items[0].settlementStatuses.items[0],
        status: 'COMPLETED',
      };
    }],
    ['split-brain MONTH deadline', (canonical) => {
      canonical.items[0].settlementStatuses.items[0] = {
        ...canonical.items[0].settlementStatuses.items[0],
        deadlineAt: '2026-10-10T15:00:00Z',
      };
    }],
    ['missing WEEK_3', (canonical) => {
      canonical.items[0].settlementStatuses.items = canonical.items[0].settlementStatuses.items
        .filter((item) => item.period !== 'WEEK_3');
    }],
    ['malformed WEEK fields', (canonical) => {
      canonical.items[0].settlementStatuses.items[1].submittedAt = {};
      canonical.items[0].settlementStatuses.items[1].deadlineAt = [];
    }],
    ['whitespace-normalized cycle identity', (canonical) => {
      canonical.items[0].settlementStatuses.projectId = ' project-a ';
    }],
    ['whitespace-normalized item identity', (canonical) => {
      canonical.items[0].projectId = ' project-a ';
    }],
    ['STATUS_UNAVAILABLE error', (canonical) => {
      canonical.errors = [{ projectId: 'project-a', code: 'STATUS_UNAVAILABLE' }];
    }],
    ['MONTH_CLOSE_UNAVAILABLE error', (canonical) => {
      canonical.errors = [{ projectId: 'project-a', code: 'MONTH_CLOSE_UNAVAILABLE' }];
    }],
    ['unknown upstream error', (canonical) => {
      canonical.errors = [{ projectId: 'project-a', code: 'UNKNOWN' }];
    }],
    ['foreign upstream error', (canonical) => {
      canonical.errors = [{ projectId: 'project-b', code: 'SUMMARY_UNAVAILABLE' }];
    }],
    ['duplicate upstream error', (canonical) => {
      canonical.errors = [
        { projectId: 'project-a', code: 'SUMMARY_UNAVAILABLE' },
        { projectId: 'project-a', code: 'SUMMARY_UNAVAILABLE' },
      ];
    }],
    ['malformed upstream errors', (canonical) => { canonical.errors = null; }],
  ])('fails the weekly overview closed for a %s', async (_label, mutate) => {
    const canonical = canonicalWeeklyOverviewResponse('2026-09');
    mutate(canonical);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(canonical), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: fullMonthCloseSource().db,
    });

    await request(app)
      .post('/api/v1/cashflow/weekly-overview')
      .send({ projectIds: ['project-a'], yearMonth: '2026-09' })
      .expect(502);
  });

  it('reads one 61-project weekly overview and exposes its monthly status as the previous-month close', async () => {
    const projectIds = Array.from({ length: 61 }, (_, index) => `project-${index + 1}`);
    const source = fullMonthCloseSource();
    const canonicalItem = canonicalWeeklyOverviewResponse('2026-09').items[0];
    const canonical = {
      version: '2',
      yearMonth: '2026-09',
      items: projectIds.map((projectId) => ({
        ...structuredClone(canonicalItem),
        projectId,
        settlementStatuses: { ...structuredClone(canonicalItem.settlementStatuses), projectId },
      })),
      errors: [],
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(canonical), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const getAll = vi.fn(async (...args) => Promise.all(args.slice(0, -1).map((ref) => ref.get())));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv, db: { ...source.db, getAll },
    });

    const response = await request(app)
      .post('/api/v1/cashflow/weekly-overview')
      .send({ projectIds, yearMonth: '2026-09' })
      .expect(200);

    expect(response.body).toMatchObject({ version: '5', yearMonth: '2026-09', monthCloseTargetYearMonth: '2026-08', monthCloseTargetLabel: '8월' });
    expect(response.body.items[0].settlementStatuses.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        period: 'MONTH',
        status: 'SUBMITTED',
        deadlineAt: '2026-09-10T15:00:00Z',
        approverDeadlineAt: '2026-09-30T15:00:00Z',
      }),
      expect.objectContaining({
        period: 'WEEK_1',
        status: 'PENDING_APPROVAL',
        deadlineAt: '2026-09-02T15:00:00Z',
        approverDeadlineAt: '2026-09-03T04:00:00Z',
      }),
    ]));
    expect(response.body.errors).toEqual([]);
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getAll.mock.calls[0]).toHaveLength(62);
    expect(getAll.mock.calls[0].at(-1)).toEqual({
      fieldMask: [
        'projectId',
        'weeklyYear',
        'sourceRevision',
        'capturedAt',
        'sheetFacts.projectionActualDifferences',
      ],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://jvm-weekly.local/api/v1/cashflow/weekly-overview',
      expect.objectContaining({
        method: 'POST', body: JSON.stringify({ projectIds, yearMonth: '2026-09', settlementCycle: true }),
      }),
    );
  });

  it('maps the stored mirror snapshot into weekly overview without the strict freshness gate', async () => {
    const source = fullMonthCloseSource({ mirrorStatus: 'STALE' });
    const mirrorPath = 'orgs/tenant-a/cashflow_sheet_mirrors/project-a';
    const mirror = source.documents.get(mirrorPath);
    mirror.weeklyYear = 2027;
    mirror.appliedSourceRevision = `sha256:${'f'.repeat(64)}`;
    mirror.capturedAt = '2026-08-25T07:48:00.000Z';
    mirror.sheetFacts.projectionActualDifferences = [
      { yearMonth: '2026-08', weekNo: 2, amount: -12_345, sourceCell: 'A14' },
      { yearMonth: '2026-08', weekNo: 3, amount: 0, sourceCell: 'B14' },
      { yearMonth: '2026-08', weekNo: 4, amount: null, sourceCell: 'C14' },
      { yearMonth: '2027-01', weekNo: 1, amount: 999, sourceCell: 'D14' },
    ];
    const getAll = vi.fn(async (...args) => Promise.all(args.slice(0, -1).map((ref) => ref.get())));
    const canonical = canonicalWeeklyOverviewResponse();
    canonical.errors = [{ projectId: 'project-a', code: 'SUMMARY_UNAVAILABLE' }];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(canonical), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'finance' }, {
      env: runtimeEnv,
      db: { ...source.db, getAll },
      now: () => new Date('2026-08-26T03:00:00.000Z'),
    });

    const overview = await request(app)
      .post('/api/v1/cashflow/weekly-overview')
      .send({ projectIds: ['project-a'], yearMonth: '2026-08' })
      .expect(200);

    expect(overview.body).toMatchObject({
      version: '5',
      items: [{
        projectId: 'project-a',
        settlementCycle: {
          cycleYearMonth: '2026-08', monthCloseTargetYearMonth: '2026-07',
        },
        sheetCapturedAt: '2026-08-25T07:48:00.000Z',
        projectionActualSummary: {
          projectId: 'project-a',
          source: 'SHEET_FORMULA',
          fromMonth: '2026-01',
          differenceAmount: 0,
          settlementMatches: true,
          comparisonAsOfWeek: { yearMonth: '2026-08', weekNo: 3 },
          display: {
            periodLabel: '누적 2026-01~2026-08 3주차',
          },
          periods: expect.arrayContaining([
            { period: 'WEEK_2', differenceAmount: -12_345 },
            { period: 'WEEK_3', differenceAmount: 0 },
            { period: 'WEEK_4', differenceAmount: null },
          ]),
        },
      }],
      errors: [],
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).settlementCycle).toBe(false);
    expect(Object.values(overview.body.items[0].settlementCycle.commandCapabilities))
      .toEqual(Array.from({ length: 8 }, () => ({ allowed: false, reasonCode: 'HISTORICAL_READ_ONLY' })));
    expect(overview.body.items[0].settlementStatuses.items[1]).toMatchObject({ period: 'WEEK_1', status: 'PENDING_APPROVAL' });
    expect(getAll).toHaveBeenCalledTimes(1);

    const strict = await request(app)
      .post('/api/v1/cashflow/projection-actual-summary/batch')
      .send({ projectIds: ['project-a'], yearMonth: '2026-08' })
      .expect(200);
    expect(strict.body).toMatchObject({
      items: [], errors: [{ projectId: 'project-a', code: 'SUMMARY_UNAVAILABLE' }],
    });
  });

  it.each([
    ['foreign mirror', (mirror) => { mirror.projectId = 'project-b'; }],
    ['padded mirror identity', (mirror) => { mirror.projectId = ' project-a '; }],
    ['duplicate projection rows', (mirror) => {
      mirror.sheetFacts.projectionActualDifferences = [
        { yearMonth: '2026-08', weekNo: 4, amount: 1 },
        { yearMonth: '2026-08', weekNo: 4, amount: 2 },
      ];
    }],
    ['malformed projection row', (mirror) => {
      mirror.sheetFacts.projectionActualDifferences = [
        { yearMonth: '2026-08', weekNo: '4', amount: 1 },
      ];
    }],
    ['malformed projection amount', (mirror) => {
      mirror.sheetFacts.projectionActualDifferences = [
        { yearMonth: '2026-08', weekNo: 4, amount: '1' },
      ];
    }],
    ['future-only projection rows', (mirror) => {
      mirror.sheetFacts.projectionActualDifferences = [
        { yearMonth: '2026-09', weekNo: 1, amount: 1 },
      ];
    }],
    ['missing mirror', (_mirror, source) => {
      source.documents.delete('orgs/tenant-a/cashflow_sheet_mirrors/project-a');
    }],
  ])('does not invent a Projection-Actual value for a %s', async (_label, mutateMirror) => {
    const source = fullMonthCloseSource();
    const mirror = source.documents.get('orgs/tenant-a/cashflow_sheet_mirrors/project-a');
    mirror.capturedAt = '2026-08-25T07:48:00.000Z';
    mutateMirror(mirror, source);
    const getAll = vi.fn(async (...args) => Promise.all(args.slice(0, -1).map((ref) => ref.get())));
    const canonical = canonicalWeeklyOverviewResponse();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(canonical), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'finance' }, {
      env: runtimeEnv,
      db: { ...source.db, getAll },
      now: () => new Date('2026-08-26T03:00:00.000Z'),
    });

    const response = await request(app)
      .post('/api/v1/cashflow/weekly-overview')
      .send({ projectIds: ['project-a'], yearMonth: '2026-08' })
      .expect(200);

    expect(response.body.items[0].projectionActualSummary).toBeNull();
    expect(response.body.items[0].projectionActualSummary).not.toBe(0);
    expect(response.body.errors).toEqual([]);
  });

  it('keeps weekly statuses when the mirror batch read fails', async () => {
    const source = fullMonthCloseSource();
    const getAll = vi.fn(async () => { throw new Error('mirror read unavailable'); });
    const canonical = canonicalWeeklyOverviewResponse();
    const week4Index = canonical.items[0].settlementStatuses.items
      .findIndex((item) => item.period === 'WEEK_4');
    canonical.items[0].settlementStatuses.items[week4Index] = {
      period: 'WEEK_4', status: 'COMPLETED',
      submittedAt: '', submittedBy: '', approvedAt: '', approvedBy: '', revision: 0,
      deadlineAt: '2026-08-20T15:00:00Z', approverDeadlineAt: '2026-08-21T04:00:00Z',
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(canonical), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'finance' }, {
      env: runtimeEnv, db: { ...source.db, getAll },
    });

    const response = await request(app)
      .post('/api/v1/cashflow/weekly-overview')
      .send({ projectIds: ['project-a'], yearMonth: '2026-08' })
      .expect(200);

    expect(response.body.items[0]).toMatchObject({
      projectId: 'project-a',
      projectionActualSummary: null,
      sheetCapturedAt: null,
    });
    expect(response.body.items[0].settlementStatuses.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ period: 'WEEK_4', status: 'COMPLETED' }),
    ]));
    expect(response.body.errors).toEqual([{ projectId: 'project-a', code: 'SUMMARY_UNAVAILABLE' }]);
  });

  it('keeps a valid mirror summary when its capture timestamp is malformed', async () => {
    const source = fullMonthCloseSource();
    const mirror = source.documents.get('orgs/tenant-a/cashflow_sheet_mirrors/project-a');
    mirror.capturedAt = 'not-an-instant';
    mirror.sheetFacts.projectionActualDifferences = [
      { yearMonth: '2026-08', weekNo: 4, amount: 77 },
    ];
    const getAll = vi.fn(async (...args) => Promise.all(args.slice(0, -1).map((ref) => ref.get())));
    const canonical = canonicalWeeklyOverviewResponse();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(canonical), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'finance' }, {
      env: runtimeEnv,
      db: { ...source.db, getAll },
      now: () => new Date('2026-08-26T03:00:00.000Z'),
    });

    const response = await request(app)
      .post('/api/v1/cashflow/weekly-overview')
      .send({ projectIds: ['project-a'], yearMonth: '2026-08' })
      .expect(200);

    expect(response.body.items[0]).toMatchObject({
      projectionActualSummary: { differenceAmount: 77 },
      sheetCapturedAt: null,
    });
    expect(response.body.errors).toEqual([]);
  });

  it('rejects invalid weekly overview scopes before JVM transport', async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv });

    await request(app)
      .post('/api/v1/cashflow/weekly-overview')
      .send({ projectIds: Array.from({ length: 101 }, (_, index) => `project-${index}`), yearMonth: '2026-08' })
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('cashflow_weekly_overview_request_invalid'));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects projection-actual batch reads before JVM transport when the role is unauthorized', async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'external' });

    await request(app)
      .post('/api/v1/cashflow/projection-actual-summary/batch')
      .send({ projectIds: ['project-a'] })
      .expect(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { projectIds: [] },
    { projectIds: Array.from({ length: 11 }, (_, index) => `project-${index}`) },
    { projectIds: ['project-a', 'project-a'] },
    { projectIds: ['project/a'] },
  ])('rejects an invalid projection-actual summary batch before JVM transport: %j', async (body) => {
    const fetchImpl = vi.fn();
    const { app } = createApp(fetchImpl);

    await request(app)
      .post('/api/v1/cashflow/projection-actual-summary/batch')
      .send(body)
      .expect(400)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_projection_actual_summary_request_invalid');
      });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects only weekly-expense writers before the JVM when their edit lease is missing', async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'admin-1',
      actorRole: 'admin',
    }, { env: runtimeEnv });

    for (const [index, path] of weeklyLeaseWriterRoutes.entries()) {
      await request(app)
        .post(path)
        .set('idempotency-key', `missing-lease-${index}`)
        .send({})
        .expect(400)
        .expect((response) => {
          expect(response.body.code).toBe('cashflow_edit_lease_request_invalid');
        });
    }

    expect(fetchImpl).not.toHaveBeenCalled();
  }, 15_000);

  it.each(weeklyLeaseWriterRoutes)(
    'forwards the same validated weekly-expense lease to writer %s',
    async (path) => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, projectId: 'project-a' }),
      };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'admin-1',
      actorRole: 'admin',
    }, { env: runtimeEnv });

      await request(app)
        .post(path)
        .set({
          'idempotency-key': `valid-lease-${weeklyLeaseWriterRoutes.indexOf(path)}`,
          ...editLeaseHeaders,
        })
        .send({})
        .expect(200);

      expect(calls).toHaveLength(1);
      expect(calls[0].init.headers).toMatchObject({
        'x-data-project-id': 'live-data-project',
        ...editLeaseHeaders,
      });
      expect(calls[0].init.headers['x-edit-finalize']).toBeUndefined();
    },
  );

  it.each(unlockedCashflowWriterRoutes)('does not forward edit-lease headers to cashflow writer %s', async (path) => {
    const fetchImpl = vi.fn(async (_url, init) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, projectId: 'project-a' }),
      init,
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'admin-1', actorRole: 'admin',
    }, { env: runtimeEnv });

    await request(app)
      .post(path)
      .set({
        'idempotency-key': 'final-projection-1',
        ...editLeaseHeaders,
        'x-edit-finalize': 'true',
      })
      .send({ lines: [] })
      .expect(200);

    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers['x-edit-session-id']).toBeUndefined();
    expect(headers['x-edit-lease-id']).toBeUndefined();
    expect(headers['x-edit-fence']).toBeUndefined();
    expect(headers['x-edit-finalize']).toBeUndefined();
  });

  it('routes variance metadata through the JVM instead of writing cashflow_weeks in the BFF', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          projectId: 'project-a', sheetId: 'week-a', varianceRevision: 3, action: 'FLAG',
        }),
      };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'finance-1', actorRole: 'finance',
    }, { env: runtimeEnv });

    await request(app)
      .post('/api/v1/cashflow-metadata/project-a/variance')
      .set({ 'idempotency-key': 'variance-jvm-1', ...editLeaseHeaders })
      .send({
        sheetId: 'week-a', expectedRevision: 2, action: 'FLAG', content: '입금 편차 확인',
        tenantId: 'spoofed', actor: { id: 'spoofed' },
      })
      .expect(200);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://jvm-weekly.local/api/v1/cashflow/project-a/variance');
    expect(calls[0].init.headers).toMatchObject({
      'x-data-project-id': 'live-data-project',
      'x-actor-role': 'finance',
    });
    expect(calls[0].init.headers['x-edit-session-id']).toBeUndefined();
    expect(JSON.parse(calls[0].init.body)).toEqual({
      idempotencyKey: 'variance-jvm-1',
      sheetId: 'week-a', expectedRevision: 2, action: 'FLAG', content: '입금 편차 확인',
    });
  });

  it('reads a historical portal dashboard through the legacy JVM path without scanning requests', async () => {
    const source = fullMonthCloseSource();
    const dashboard = monthDashboardSource({
      ok: true,
      projectId: 'project-a',
      yearMonth: '2026-08',
      status: 'OPEN',
      revision: 0,
      evaluatedBusinessDate: '2026-08-27',
    });
    dashboard.settlementCycle = canonicalSettlementCycle();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(dashboard), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
    });

    const response = await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-08')
      .expect(200);

    expect(fetchImpl.mock.calls[0][0]).toBe(
      'http://jvm-weekly.local/api/v1/cashflow/project-a/month-close/dashboard-source?yearMonth=2026-08',
    );
    expect(source.monthCloseRequestQueries)
      .not.toContainEqual({ kind: 'limit', count: 100 });
    expect(response.body.settlementCycle).toMatchObject({
      cycleYearMonth: '2026-08',
      weeklyYearMonth: '2026-08',
      monthCloseTargetYearMonth: '2026-07',
      businessState: 'NOT_REQUESTED',
    });
    expect(Object.values(response.body.settlementCycle.commandCapabilities))
      .toEqual(Array.from({ length: 8 }, () => ({ allowed: false, reasonCode: 'HISTORICAL_READ_ONLY' })));
    expect(response.body.monthState).toBeNull();
  });

  it('uses the target month calendar when a portal cycle crosses a year boundary', async () => {
    const dashboard = monthDashboardSource(
      {
        ok: true,
        projectId: 'project-a',
        yearMonth: '2026-01',
        status: 'OPEN',
        revision: 0,
        evaluatedBusinessDate: '2026-01-03',
      },
      undefined,
      {
        selectedYear: 2025,
        projection: { amount: 0, lineAmounts: {}, sources: [], includedYears: [], excludedWeeklyYears: [] },
        actual: { amount: 0, lineAmounts: {}, sources: [], includedYears: [], excludedWeeklyYears: [] },
      },
    );
    dashboard.monthCloseCalendar = monthCloseCalendarFor('2025-12');
    dashboard.settlementCycle = canonicalSettlementCycle({
      cycleYearMonth: '2026-01',
      weeklyYearMonth: '2026-01',
      monthCloseTargetYearMonth: '2025-12',
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(dashboard), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: fullMonthCloseSource().db,
    });

    const response = await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-01')
      .expect(200);

    expect(response.body).toMatchObject({
      cycleYearMonth: '2026-01',
      targetYearMonth: '2025-12',
      closeDeadline: '2026-01-10',
      closeDeadlineAt: '2026-01-10T15:00:00.000Z',
      approverDeadlineAt: '2026-01-31T15:00:00.000Z',
    });
  });

  it('aligns a submitted portal cycle to its exact cycle-keyed request', async () => {
    const source = fullMonthCloseSource({ yearMonth: '2026-08' });
    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-09', {
      ...canonicalMonthCloseRequest('2026-09'),
    });
    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08', {
      requestId: 'project-a-2026-08', projectId: 'project-a', yearMonth: '2026-08',
      throughMonth: '2026-08', status: 'APPROVED',
    });
    const dashboard = monthDashboardSource({
      ok: true,
      projectId: 'project-a',
      yearMonth: '2026-09',
      status: 'OPEN',
      revision: 0,
      evaluatedBusinessDate: '2026-09-27',
    });
    const canonicalItem = canonicalWeeklyOverviewResponse('2026-09').items[0];
    dashboard.settlementCycle = canonicalItem.settlementCycle;
    dashboard.settlementStatuses = canonicalItem.settlementStatuses;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(dashboard), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
    });

    const response = await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-09')
      .expect(200);

    expect(response.body.settlementCycle.businessState).toBe('SUBMITTED');
    expect(response.body.monthState).toMatchObject({
      requestId: 'project-a-2026-09',
      cycleYearMonth: '2026-09',
      throughMonth: '2026-08',
      status: 'PENDING_APPROVAL',
    });
  });

  it('fails the portal dashboard closed for a foreign canonical cycle', async () => {
    const dashboard = monthDashboardSource({
      ok: true,
      projectId: 'project-a',
      yearMonth: '2026-09',
      status: 'OPEN',
      revision: 0,
      evaluatedBusinessDate: '2026-09-27',
    });
    dashboard.settlementCycle = canonicalSettlementCycle({ cycleYearMonth: '2026-10' });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(dashboard), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: fullMonthCloseSource().db,
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-09')
      .expect(502);
  });

  it('reads a cashflow month-close through the JVM with the requested yearMonth', async () => {
    const performanceEvents = [];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true,
        projectId: 'project-a',
        yearMonth: '2026-06',
        status: 'CLOSED',
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'auditor-1',
      actorRole: 'auditor',
    }, { performanceLogger: (event) => performanceEvents.push(event) });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          projectId: 'project-a',
          yearMonth: '2026-06',
          status: 'CLOSED',
        });
      });

    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(2);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'http://jvm-weekly.local/api/v1/cashflow/project-a/month-close/dashboard-source?yearMonth=2026-06',
    );
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ 'x-request-id': 'req-1' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(performanceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'cashflow.month_close.read', phase: 'publication_before' }),
      expect.objectContaining({ operation: 'cashflow.month_close.read', phase: 'jvm_dashboard' }),
      expect.objectContaining({ operation: 'cashflow.month_close.read', phase: 'jvm_compliance' }),
      expect.objectContaining({ operation: 'cashflow.month_close.read', phase: 'dashboard_compose' }),
      expect.objectContaining({ operation: 'cashflow.month_close.read', phase: 'publication_after' }),
    ]));
    expect(performanceEvents.every((event) => event.requestId === 'req-1')).toBe(true);
  });

  it('publishes the server-owned 2026 board, status joins, and comparison presentation', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08', {
      ...canonicalMonthCloseRequest('2026-08'),
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(withCanonicalSubmittedCycle(monthDashboardSource(
        { ok: true, projectId: 'project-a', yearMonth: '2026-08', status: 'OPEN', revision: 0 },
        undefined,
        undefined,
        undefined,
        undefined,
        closedCumulativeAuthority('2026-07'),
      ))),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-08-14T03:00:00.000Z'),
      weeklyComplianceResponse: {
        items: [{
          yearMonth: '2026-08', weekNo: 3, status: 'COMPLETED_LATE',
          deadline: '2026-08-13T14:59:59.999Z', completedAt: '2026-08-14T01:00:00.000Z',
        }],
        nextCursor: '', onTimeCount: 0, missedCount: 0,
      },
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-08')
      .expect(200)
      .expect((response) => {
        const { presentation } = response.body;
        expect(presentation).toMatchObject({
          asOfDate: '2026-08-14',
          evidenceSource: 'DASHBOARD',
          annualBefore: [{ year: 2024, label: '2024년' }, { year: 2025, label: '2025년' }],
          annualAfter: [
            { year: 2027, label: '2027년' }, { year: 2028, label: '2028년' },
            { year: 2029, label: '2029년' }, { year: 2030, label: '2030년' },
            { year: 2031, label: '2031년' }, { year: 2032, label: '2032년' },
          ],
          monthClose: { statusLabel: '조직장 승인 대기', tone: 'warning' },
          comparison: {
            annualBefore: [{ year: 2024, label: '2024년' }, { year: 2025, label: '2025년' }],
            annualAfter: [],
            periodLabel: '2024년 ~ 2026-08 3주차',
          },
        });
        expect(presentation.weeks).toHaveLength(60);
        expect(presentation.months).toHaveLength(12);
        expect(presentation.months.find((month) => month.yearMonth === '2026-07')).toMatchObject({
          label: '2026년 07월', columnCount: 5, status: 'CLOSED', locked: true, overdue: false,
          badgeLabel: '월 결산 완료', tone: 'closed',
        });
        expect(presentation.weeks.find((week) => week.yearMonth === '2026-07' && week.weekNo === 5)).toMatchObject({
          monthStatus: 'CLOSED', monthStatusLabel: '월 결산 완료', weeklyStatus: null,
          weeklyStatusLabel: '', statusLabel: '월 결산 완료', surfaceTone: 'closed',
        });
        expect(presentation.weeks.find((week) => week.yearMonth === '2026-08' && week.weekNo === 3)).toMatchObject({
          weekStart: '2026-08-10', weekEnd: '2026-08-16', label: '26-8-3', isCurrent: true,
          monthStatus: 'OPEN', monthStatusLabel: '결산 전', weeklyStatus: 'COMPLETED_LATE',
          weeklyStatusLabel: '기한 후 완료', statusLabel: '기한 후 완료', surfaceTone: 'success',
        });
        expect(presentation.comparison.weeks).toHaveLength(38);
        expect(presentation.comparison.weeks.at(-1)).toMatchObject({
          yearMonth: '2026-08', weekNo: 3, label: '26-8-3', isCurrent: true,
        });
        expect(presentation.comparison.cells).toHaveLength(38);
        expect(presentation.comparison.cells.find((cell) => (
          cell.yearMonth === '2026-06' && cell.weekNo === 5
        ))).toEqual({
          yearMonth: '2026-06', weekNo: 5, weekLabel: '26-6-5',
          weekRange: '2026-06-29 ~ 2026-06-30', difference: -43_962_826,
        });
        expect(presentation.comparison.cells.at(-1)).toMatchObject({
          yearMonth: '2026-08', weekNo: 3, difference: null,
        });
        expect(presentation.comparison.changed).toBe(true);
      });
  });

  it('unifies canonical and approved workflow status for an executed-cycle approval', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08', {
      ...canonicalMonthCloseRequest('2026-08', 'APPROVED', {
        approvalVersionId: 'approval-v2',
        ledgerRevision: 2,
        manifestHash: `sha256:${'a'.repeat(64)}`,
      }),
      requestedAt: '2026-08-20T02:51:00.000Z',
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(withCanonicalLockedCycle(monthDashboardSource(
        { ok: true, projectId: 'project-a', yearMonth: '2026-08', status: 'OPEN', revision: 0 },
        undefined,
        undefined,
        undefined,
        undefined,
        closedCumulativeAuthority('2026-07'),
      ), { approvedAt: '2026-08-25T06:45:00.000Z' })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-08-25T07:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-08')
      .expect(200)
      .expect((response) => {
        expect(response.body.presentation.monthClose).toEqual({
          status: 'COMPLETED',
          statusLabel: '월 결산 완료',
          tone: 'success',
          approvedAt: '2026-08-25T06:45:00.000Z',
        });
      });

  });

  it('uses a later cumulative close authority without moving the queried target month', async () => {
    const source = fullMonthCloseSource({ yearMonth: '2026-08' });
    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-09', {
      ...canonicalMonthCloseRequest('2026-09', 'REJECTED', {
        revision: 4,
        evidenceRevision: 4,
        workflowRevision: 4,
      }),
    });
    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-10', {
      ...canonicalMonthCloseRequest('2026-10', 'APPROVED', {
        approvalVersionId: 'approval-v5',
        ledgerRevision: 5,
        manifestHash: `sha256:${'f'.repeat(64)}`,
        revision: 5,
        evidenceRevision: 5,
        workflowRevision: 5,
        reviewedAt: '2026-10-20T06:45:00.000Z',
      }),
    });
    const dashboard = withCanonicalCoveredLockedCycle(monthDashboardSource(
      {
        ok: true,
        projectId: 'project-a',
        yearMonth: '2026-09',
        status: 'OPEN',
        revision: 0,
        evaluatedBusinessDate: '2026-09-20',
      },
      undefined,
      undefined,
      undefined,
      undefined,
      closedCumulativeAuthority('2026-09', 5),
    ));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(dashboard), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-09-20T07:00:00.000Z'),
    });

    const response = await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-09')
      .expect(200);

    expect(response.body).toMatchObject({
      cycleYearMonth: '2026-09',
      targetYearMonth: '2026-08',
      monthState: {
        requestId: 'project-a-2026-10',
        cycleYearMonth: '2026-10',
        throughMonth: '2026-09',
        status: 'APPROVED',
      },
      presentation: {
        monthClose: {
          status: 'COMPLETED',
          statusLabel: '월 결산 완료',
          approvedAt: '2026-10-20T06:45:00.000Z',
        },
      },
      actions: { requestMonthReopen: { enabled: true } },
    });

    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-10', {
      ...canonicalMonthCloseRequest('2026-10', 'REOPEN_REQUESTED', {
        approvalVersionId: 'approval-v5',
        ledgerRevision: 6,
        manifestHash: `sha256:${'f'.repeat(64)}`,
        revision: 5,
        evidenceRevision: 5,
        workflowRevision: 6,
        reviewedAt: '2026-10-20T06:45:00.000Z',
      }),
    });
    dashboard.settlementCycle = {
      ...dashboard.settlementCycle,
      businessState: 'REOPEN_REQUESTED',
      workflowRevision: 6,
      commandCapabilities: {
        ...deniedSettlementCycleCapabilities(),
        APPROVE_MONTH_REOPEN: { allowed: false, reasonCode: 'REOPEN_DECISION_FORBIDDEN' },
        REJECT_MONTH_REOPEN: { allowed: false, reasonCode: 'REOPEN_DECISION_FORBIDDEN' },
      },
    };

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-09')
      .expect(200)
      .expect((reopenResponse) => expect(reopenResponse.body).toMatchObject({
        cycleYearMonth: '2026-09',
        targetYearMonth: '2026-08',
        monthState: {
          requestId: 'project-a-2026-10',
          cycleYearMonth: '2026-10',
          throughMonth: '2026-09',
          status: 'REOPEN_REQUESTED',
          revision: 5,
          ledgerRevision: 6,
        },
        settlementCycle: {
          businessState: 'REOPEN_REQUESTED',
          monthCloseSettlement: null,
          supersededAttempt: 'REJECTED',
        },
        actions: { requestMonthReopen: { enabled: false } },
      }));
  });

  it('uses the JVM evaluated business date across dashboard, compliance, and presentation at KST midnight', async () => {
    const source = fullMonthCloseSource();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true,
        projectId: 'project-a',
        yearMonth: '2026-06',
        status: 'OPEN',
        revision: 0,
        evaluatedBusinessDate: '2026-06-08',
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      // JVM 은 자정 직후의 canonical business date를 평가했지만 BFF 시계는 아직
      // KST 2026-06-07 23:59:59인 경계를 재현한다.
      now: () => new Date('2026-06-07T14:59:59.000Z'),
      weeklyComplianceResponse: {
        items: [{
          yearMonth: '2026-06', weekNo: 2, status: 'PENDING',
          deadline: '2026-06-11T14:59:59.999Z', completedAt: null,
        }],
        nextCursor: '', onTimeCount: 0, missedCount: 0,
      },
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.evaluatedBusinessDate).toBe('2026-06-08');
        expect(response.body.dashboard.summary).toMatchObject({
          comparisonAsOfDate: '2026-06-08',
          comparisonAsOfWeek: { yearMonth: '2026-06', weekNo: 2 },
          evaluatedBusinessDate: '2026-06-08',
        });
        expect(response.body.dashboard.deadlineSummary.current).toMatchObject({
          yearMonth: '2026-06', weekNo: 2, status: 'PENDING',
        });
        expect(response.body.presentation.asOfDate).toBe('2026-06-08');
        expect(response.body.presentation.comparison.weeks.at(-1)).toMatchObject({
          yearMonth: '2026-06', weekNo: 2, isCurrent: true,
        });
        expect(response.body.presentation.comparison.periodLabel).toBe('2024년 ~ 2026-06 2주차');
      });
  });

  it('rejects an invalid JVM evaluated business date with a safe 502', async () => {
    const source = fullMonthCloseSource();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true,
        projectId: 'project-a',
        yearMonth: '2026-06',
        status: 'OPEN',
        revision: 0,
        evaluatedBusinessDate: '2026-02-30',
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-06-07T14:59:59.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(502)
      .expect((response) => {
        expect(response.body).toEqual({
          code: 'jvm_weekly_response_invalid',
          message: '월 결산 기준일을 확인할 수 없습니다. 잠시 후 다시 불러와 주세요.',
        });
        expect(JSON.stringify(response.body)).not.toContain('Invalid cashflow comparison as-of date');
        expect(JSON.stringify(response.body)).not.toContain('2026-02-30');
      });
  });

  it('clamps a next-year comparison boundary to the last week of the dashboard grain', async () => {
    const source = fullMonthCloseSource();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true,
        projectId: 'project-a',
        yearMonth: '2026-06',
        status: 'OPEN',
        revision: 0,
        evaluatedBusinessDate: '2027-01-01',
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2027-01-01T03:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        const { presentation } = response.body;
        expect(presentation.asOfDate).toBe('2027-01-01');
        expect(presentation.comparison.weeks).toHaveLength(60);
        expect(presentation.comparison.cells).toHaveLength(60);
        expect(presentation.comparison.weeks.at(-1)).toMatchObject({
          yearMonth: '2026-12', weekNo: 5, isCurrent: true,
        });
        expect(presentation.comparison.cells.at(-1)).toMatchObject({
          yearMonth: '2026-12', weekNo: 5,
        });
        expect(presentation.comparison.periodLabel).toBe('2024년 ~ 2026-12 5주차');
        expect(presentation.weeks.filter((week) => week.isCurrent)).toEqual([
          expect.objectContaining({ yearMonth: '2026-12', weekNo: 5 }),
        ]);
      });
  });

  it('keeps unavailable month authority and compliance explicit in presentation', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/monthly_closes/project-a-2026-05', {
      projectId: 'project-a', yearMonth: '2026-05', status: 'CLOSED',
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-08-14T03:00:00.000Z'),
      weeklyComplianceResponse: () => { throw new Error('compliance unavailable'); },
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.monthCloseStatuses).toBeNull();
        expect(response.body.dashboard.deadlineSummary).toBeNull();
        expect(response.body.presentation.months.every((month) => (
          month.status === null
          && month.locked === false
          && month.badgeLabel === '월 결산 상태 확인 필요'
          && month.tone === 'unavailable'
        ))).toBe(true);
        expect(response.body.presentation.weeks.every((week) => (
          week.monthStatus === null
          && week.weeklyStatus === null
          && week.monthStatusLabel === '월 결산 상태 확인 필요'
          && week.weeklyStatusLabel === '주간 정산 상태 확인 필요'
          && week.statusLabel === '월 결산 상태 확인 필요'
          && week.surfaceTone === 'unavailable'
        ))).toBe(true);
      });
  });

  it('keeps the dashboard alive when the compliance side read fails, and says so', async () => {
    // 부가 조회(주간 준수 이력) 실패는 그 섹션만 비운다. 전 프로젝트 화면을 503 으로
    // 죽이면 한 하위 시스템 장애가 회사 자금 화면 전체를 잠근다.
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN',
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      weeklyComplianceResponse: () => { throw new Error('compliance backend down'); },
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.status).toBe('OPEN');
        // 판정 불능을 "지각 0회" 로 그리지 않도록 요약 자체를 비운다.
        expect(response.body.dashboard.deadlineSummary).toBeNull();
        expect(response.body.sectionErrors).toEqual(expect.arrayContaining([
          expect.objectContaining({
            section: 'deadlineSummary',
            code: 'weekly_compliance_unavailable',
            label: '주간 정산 이력',
          }),
        ]));
      });
  });

  it('keeps the dashboard alive when the sheet publication state read fails, and says so', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN',
      })),
    }));
    const db = {
      doc: (path) => {
        if (path.includes('cashflow_sheet_publications')) {
          return { get: async () => { throw new Error('firestore unavailable'); } };
        }
        if (path.includes('/members/')) {
          return {
            get: async () => ({
              exists: true,
              data: () => ({ uid: 'pm-1', status: 'ACTIVE', role: 'pm', projectIds: ['project-a'] }),
            }),
          };
        }
        return { get: async () => ({ exists: false }) };
      },
    };
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { db });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.status).toBe('OPEN');
        expect(response.body.pendingApply).toBeNull();
        expect(response.body.publicationChangedDuringRead).toBe(false);
        expect(response.body.sectionErrors).toEqual(expect.arrayContaining([
          expect.objectContaining({
            section: 'sheetPublication',
            code: 'sheet_publication_state_unavailable',
            label: '시트 반영 상태',
          }),
        ]));
      });
    // 확인 재읽기(publication_after)까지 실패해도 요청당 한 번만 알린다.
    expect(fetchImpl.mock.calls.filter(([url]) => url.includes('/dashboard-source'))).toHaveLength(1);
  });

  it('keeps Sheet and ledger sections when the OPEN project metadata read fails', async () => {
    const fixture = fullMonthCloseSource({ yearMonth: '2026-05' });
    const projectPath = 'orgs/tenant-a/projects/project-a';
    const readDoc = fixture.db.doc;
    fixture.db.doc = (path) => path === projectPath
      ? { get: async () => { throw new Error('project store unavailable'); } }
      : readDoc(path);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: fixture.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.cells).toHaveLength(160);
        expect(response.body.dashboard.canonical).toBeTruthy();
        expect(response.body.dashboard.summary.projectionContractAmount).toBeNull();
        expect(response.body.dashboard.validation.blockers).toContainEqual({
          code: 'PROJECT_SOURCE_UNAVAILABLE',
          message: '프로젝트 등록 정보를 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.',
        });
        expect(response.body.sectionErrors).toContainEqual(expect.objectContaining({
          section: 'projectMetadata',
          code: 'cashflow_project_metadata_unavailable',
          label: '프로젝트 등록 정보',
        }));
      });
  });

  it('keeps independent OPEN sections without inventing zero amounts when the mirror read fails', async () => {
    const fixture = fullMonthCloseSource();
    const mirrorPath = 'orgs/tenant-a/cashflow_sheet_mirrors/project-a';
    const readDoc = fixture.db.doc;
    fixture.db.doc = (path) => path === mirrorPath
      ? { get: async () => { throw new Error('mirror store unavailable'); } }
      : readDoc(path);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: fixture.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.project).toMatchObject({ id: 'project-a' });
        expect(response.body.dashboard.cells).toEqual([]);
        expect(response.body.dashboard.totals).toEqual({
          projection: { totalIn: null, totalOut: null, balance: null, rowTotals: {}, weeks: [] },
          actual: { totalIn: null, totalOut: null, balance: null, rowTotals: {}, weeks: [] },
          difference: { totalIn: null, totalOut: null, balance: null },
        });
        expect(response.body.actions.requestMonthClose.enabled).toBe(false);
        expect(response.body.operationsSummary.rates.actual).toMatchObject({
          state: 'UNAVAILABLE', percent: null,
        });
        expect(response.body.dashboard.validation.blockers).toContainEqual({
          code: 'SHEET_SOURCE_UNAVAILABLE',
          message: '시트 기준값을 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.',
        });
        expect(response.body.sectionErrors).toContainEqual(expect.objectContaining({
          section: 'sheetMirror',
          code: 'cashflow_sheet_mirror_unavailable',
          label: '시트 기준값',
        }));
      });
  });

  it.each([
    [
      'cashflow',
      'cashflow_declared_weekly_year_unavailable',
      null,
      '현금흐름 원장',
    ],
    [
      'cashflow',
      'cashflow_declared_weekly_year_missing',
      null,
      '현금흐름 원장',
    ],
    [
      'cashflow',
      'cashflow_ledger_source_unavailable',
      null,
      '현금흐름 원장',
    ],
    [
      'openingBalances',
      'cashflow_opening_balances_unavailable',
      'OPENING_BALANCES_UNAVAILABLE',
      '이월 잔액',
    ],
    [
      'projectionActualSummary',
      'cashflow_projection_actual_summary_unavailable',
      'PROJECTION_ACTUAL_SUMMARY_UNAVAILABLE',
      'Projection-Actual 요약',
    ],
  ])('keeps independent dashboard sections when JVM %s is explicitly unavailable', async (
    section,
    sectionCode,
    blockerCode,
    sectionLabel,
  ) => {
    const fixture = fullMonthCloseSource({ yearMonth: '2026-05' });
    const jvmSource = monthDashboardSource({
      ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
    });
    if (section === 'cashflow') jvmSource.cashflow = null;
    if (section === 'openingBalances') jvmSource.openingBalances = null;
    if (section === 'projectionActualSummary') jvmSource.projectionActualSummary = null;
    jvmSource.sectionErrors = [{ section, code: sectionCode }];
    jvmSource.blockers = [{
      code: blockerCode || 'CASHFLOW_SOURCE_UNAVAILABLE',
      message: 'Firestore adapter exploded at internal line 917',
    }];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(jvmSource),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: fixture.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        if (section === 'projectionActualSummary') {
          expect(response.body.sectionErrors.some((entry) => (
            entry.section === section && entry.code === sectionCode
          ))).toBe(false);
        } else {
          expect(response.body.sectionErrors).toContainEqual({
            section,
            code: sectionCode,
            label: sectionLabel,
          });
        }
        expect(JSON.stringify(response.body)).not.toContain('Firestore adapter');
        if (section === 'cashflow') {
          expect(response.body.status).toBe('OPEN');
          expect(response.body.closeEligible).toBe(false);
          expect(response.body.dashboard).toBeUndefined();
          expect(response.body.operationsSummary).toMatchObject({
            status: { kind: 'unavailable', tone: 'danger' },
            rates: {
              projection: { state: 'UNAVAILABLE', percent: null, barPercent: 0 },
              actual: { state: 'UNAVAILABLE', percent: null, barPercent: 0 },
            },
          });
          expect(response.body.blockers).toContainEqual({
            code: 'CASHFLOW_SOURCE_UNAVAILABLE',
            message: '현금흐름 원장을 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.',
          });
        } else if (section === 'openingBalances') {
          expect(response.body.dashboard.cells).toHaveLength(160);
          expect(response.body.dashboard.openingBalances).toBeNull();
          expect(response.body.dashboard.managementChecks.find((check) => (
            check.id === 'negative-projection-balance'
          ))).toMatchObject({
            status: 'REVIEW_REQUIRED',
            detail: '이월 잔액을 불러오지 못해 Projection 잔액을 판정할 수 없습니다.',
          });
          expect(response.body.dashboard.validation.canClose).toBe(false);
          expect(response.body.dashboard.validation.blockers).toContainEqual(expect.objectContaining({
            code: blockerCode,
          }));
        } else {
          expect(response.body.dashboard.cells).toHaveLength(160);
          expect(response.body.dashboard.openingBalances.selectedYear).toBe(2026);
          expect(response.body.dashboard.projectionActualSummary).toBeTruthy();
          expect(response.body.dashboard.validation.blockers.map((blocker) => blocker.code))
            .not.toContain('PROJECTION_ACTUAL_SUMMARY_UNAVAILABLE');
        }
      });
  });

  it('does not fabricate zero or EMPTY rows when an amended live ledger is unavailable', async () => {
    const fixture = fullMonthCloseSource();
    const jvmSource = monthDashboardSource(
      {
        ok: true,
        projectId: 'project-a',
        yearMonth: '2026-06',
        status: 'CLOSED',
        revision: 2,
        amendmentCount: 1,
        snapshot: {},
      },
      null,
      undefined,
      { status: 'LIVE_AMENDED', missingEvidence: [] },
    );
    jvmSource.sectionErrors = [{
      section: 'cashflow', code: 'cashflow_ledger_source_unavailable',
    }];
    jvmSource.blockers = [{
      code: 'CASHFLOW_SOURCE_UNAVAILABLE', message: 'raw datastore stack trace',
    }];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(jvmSource),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: fixture.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.status).toBe('CLOSED');
        expect(response.body.closeEligible).toBe(false);
        expect(response.body.dashboard).toBeUndefined();
        expect(response.body.blockers).toContainEqual({
          code: 'CASHFLOW_SOURCE_UNAVAILABLE',
          message: '현금흐름 원장을 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.',
        });
        expect(response.body.sectionErrors).toContainEqual(expect.objectContaining({
          section: 'cashflow',
          code: 'cashflow_ledger_source_unavailable',
          label: '현금흐름 원장',
        }));
        expect(JSON.stringify(response.body)).not.toContain('raw datastore');
      });
  });

  it('rejects an absent OPEN cashflow section unless JVM explicitly marks it unavailable', async () => {
    const fixture = fullMonthCloseSource();
    const jvmSource = monthDashboardSource({
      ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
    });
    jvmSource.cashflow = null;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(jvmSource),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: fixture.db,
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(502)
      .expect((response) => expect(response.body.code).toBe('jvm_weekly_response_invalid'));
  });

  it.each([
    ['cashflow', 'cashflow_ledger_source_unavailable'],
    ['openingBalances', 'cashflow_opening_balances_unavailable'],
  ])('fails a month-close mutation closed when JVM marks required %s unavailable', async (section, code) => {
    const fixture = fullMonthCloseSource();
    const jvmSource = monthDashboardSource({
      ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
    });
    // A contradictory adapter response may carry stale values and an unavailable marker together.
    // The write boundary must trust the marker and never proxy the mutation.
    jvmSource.sectionErrors = [{
      section, code,
    }];
    jvmSource.blockers = [{
      code: 'CASHFLOW_SOURCE_UNAVAILABLE', message: 'Firestore adapter exploded at internal line 917',
    }];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(jvmSource),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'pm-1', actorRole: 'pm',
    }, {
      env: runtimeEnv,
      db: fixture.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close')
      .set('idempotency-key', 'required-source-unavailable')
      .send({
        yearMonth: '2026-07',
        expectedRevision: 0,
        expectedWorkflowRevision: 0,
        expectedOpeningBalances: jvmSource.openingBalances,
        closeInput: fixture.closeInput,
      })
      .expect(503)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'cashflow_month_close_source_unavailable',
          message: '월 결산 필수 자료를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.',
        });
        expect(JSON.stringify(response.body)).not.toContain('Firestore adapter');
      });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it.each([
    ['INVALID', 'CUMULATIVE_CLOSE_AUTHORITY_INVALID', 'cashflow_cumulative_close_authority_invalid'],
    ['UNAVAILABLE', 'CUMULATIVE_CLOSE_AUTHORITY_UNAVAILABLE', 'cashflow_cumulative_close_authority_unavailable'],
  ])('keeps independent dashboard sections when cumulative authority is %s', async (
    availability,
    blockerCode,
    sectionCode,
  ) => {
    const source = fullMonthCloseSource({ yearMonth: '2026-05' });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource(
        { ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0 },
        undefined,
        undefined,
        undefined,
        undefined,
        {
          availability,
          status: null,
          fromMonth: null,
          closedThrough: null,
          rootHash: null,
          headRevision: null,
        },
      )),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.cells).toHaveLength(160);
        expect(response.body.dashboard.openingBalances.selectedYear).toBe(2026);
        expect(response.body.dashboard.totals.projection).toBeTruthy();
        expect(response.body.dashboard.monthCloseStatuses).toBeNull();
        expect(response.body.dashboard.cumulativeCloseAuthority).toMatchObject({
          availability,
          status: null,
        });
        expect(response.body.dashboard.validation.canClose).toBe(false);
        expect(response.body.dashboard.validation.blockers).toContainEqual(expect.objectContaining({
          code: blockerCode,
        }));
        expect(response.body.sectionErrors).toContainEqual({
          section: 'monthCloseStatuses',
          code: sectionCode,
          label: '월 결산 상태',
        });
      });
  });

  it('keeps a pristine missing cumulative authority explicit without inventing OPEN authority', async () => {
    const source = fullMonthCloseSource();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.cumulativeCloseAuthority).toEqual({
          availability: 'MISSING',
          status: null,
          fromMonth: null,
          closedThrough: null,
          rootHash: null,
          headRevision: null,
        });
        expect(response.body.dashboard.monthCloseStatuses).toHaveLength(12);
        expect(response.body.dashboard.monthCloseStatuses.every((entry) => entry.status === 'OPEN')).toBe(true);
      });
  });

  it('keeps stale CLOSED history unavailable when JVM reports missing cumulative authority', async () => {
    const source = fullMonthCloseSource();
    const operational = {
      ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'UNAVAILABLE', revision: 1,
      reopenCount: 0, projectWarningCount: 0, snapshot: {},
    };
    const jvmSource = monthDashboardSource(
      operational,
      null,
      null,
      { status: 'AUTHORITY_UNAVAILABLE', missingEvidence: [] },
    );
    jvmSource.latestRun = { ...operational, status: 'CLOSED' };
    jvmSource.monthStatusEvidence = {
      authority: 'CUMULATIVE_CLOSE_HEAD',
      authorityAvailability: 'MISSING',
      operationalStatus: null,
      latestRunStatus: 'CLOSED',
      closedThrough: null,
      issueCode: 'CUMULATIVE_CLOSE_AUTHORITY_MISSING',
    };
    jvmSource.blockers = [{
      code: 'CUMULATIVE_CLOSE_AUTHORITY_MISSING',
      guide: 'raw adapter text must not be exposed',
    }];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(jvmSource),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.status).toBe('UNAVAILABLE');
        expect(response.body.latestRun.status).toBe('CLOSED');
        expect(response.body.monthStatusEvidence.operationalStatus).toBeNull();
        expect(response.body.closeEligible).toBe(false);
        expect(response.body.actions.requestMonthClose.enabled).toBe(false);
        expect(response.body.dashboard.validation.blockers).toContainEqual(expect.objectContaining({
          code: 'CUMULATIVE_CLOSE_AUTHORITY_MISSING',
        }));
        expect(JSON.stringify(response.body)).not.toContain('raw adapter text');
      });
  });

  it('requires migration when close history exists without cumulative authority', async () => {
    const source = fullMonthCloseSource({ yearMonth: '2026-05' });
    source.documents.set('orgs/tenant-a/monthly_closes/project-a-2026-05', {
      projectId: 'project-a', yearMonth: '2026-05', status: 'CLOSED',
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.cells).toHaveLength(160);
        expect(response.body.dashboard.monthCloseStatuses).toBeNull();
        expect(response.body.dashboard.cumulativeCloseAuthority.availability).toBe('MISSING');
        expect(response.body.dashboard.validation.blockers).toContainEqual(expect.objectContaining({
          code: 'CUMULATIVE_CLOSE_MIGRATION_REQUIRED',
        }));
        expect(response.body.sectionErrors).toContainEqual(expect.objectContaining({
          section: 'monthCloseStatuses',
          code: 'cashflow_month_close_migration_required',
          label: '월 결산 상태',
        }));
      });
  });

  it('retains authority-derived month statuses when only close-history evidence is unavailable', async () => {
    const source = fullMonthCloseSource();
    const baseCollection = source.db.collection;
    source.db.collection = (path) => {
      if (path === 'orgs/tenant-a/monthly_closes') {
        return {
          where: () => ({ limit: () => ({ get: async () => { throw new Error('history unavailable'); } }) }),
        };
      }
      return baseCollection(path);
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource(
        { ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0 },
        undefined,
        undefined,
        undefined,
        undefined,
        closedCumulativeAuthority('2026-05'),
      )),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        const statuses = new Map(response.body.dashboard.monthCloseStatuses.map((entry) => [entry.yearMonth, entry]));
        expect(statuses.get('2026-05')).toMatchObject({ status: 'CLOSED', sheetCalculationChecks: null });
        expect(statuses.get('2026-06')).toMatchObject({ status: 'OPEN', sheetCalculationChecks: null });
        expect(response.body.dashboard.validation.blockers.map((blocker) => blocker.code))
          .not.toContain('CUMULATIVE_CLOSE_AUTHORITY_UNAVAILABLE');
        expect(response.body.sectionErrors).toContainEqual(expect.objectContaining({
          section: 'monthCloseHistory',
          code: 'cashflow_month_close_history_unavailable',
          label: '월 결산 이력',
        }));
      });
  });

  it('still fails closed when the dashboard source itself is down', async () => {
    // 본체가 없으면 대체 표시가 불가능하다. 이건 열화 대상이 아니다.
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ message: 'boom' }),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {});

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(503)
      .expect((response) => expect(response.body.code).toBe('jvm_weekly_api_internal_error'));
  });

  it('publishes the server-owned cumulative close scope and pinned sheet source for 2026-08', async () => {
    const source = fullMonthCloseSource({ yearMonth: '2026-07' });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true,
        projectId: 'project-a',
        yearMonth: '2026-08',
        status: 'OPEN',
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-08-04T01:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-08')
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          yearMonth: '2026-08',
          cycleYearMonth: '2026-08',
          targetYearMonth: '2026-07',
          closeDeadline: '2026-08-10',
          closeEligible: true,
        });
        expect(response.body.dashboard.summary).toMatchObject({
          cycleYearMonth: '2026-08',
          targetYearMonth: '2026-07',
          closeDeadline: '2026-08-10',
        });
        expect(response.body.dashboard.cumulativeCloseScope).toEqual({
          contractVersion: 'cashflow-cumulative-close-v2',
          fromMonth: '2023-01',
          throughMonth: '2026-07',
          lockRange: {
            fromMonth: '2023-01',
            fromWeekNo: 1,
            throughMonth: '2026-07',
            throughWeekNo: 5,
          },
          monthCount: 43,
          weekCount: 215,
          cellCount: 6880,
          source: {
            sourceRevision: source.sourceRevision,
            targetRevision: source.targetRevision,
            capturedAt: '2026-07-01T00:00:00.000Z',
            spreadsheetId: 'spreadsheet-a',
            spreadsheetTitle: '2026 사업비 관리 시트',
            selectedSheetName: 'cashflow(사용내역 연동)',
            spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/spreadsheet-a/edit',
          },
        });
        expect(response.body.actions.cumulativeScope).toMatchObject({ ready: true });
      });
  });

  it('keeps WEEK actions live while historical MONTH actions stay read-only', async () => {
    const source = fullMonthCloseSource({ yearMonth: '2026-05' });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => {
        const dashboardSource = monthDashboardSource({
          ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
        });
        return JSON.stringify(
          source.documents.has('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-06')
            ? withCanonicalSubmittedCycle(dashboardSource)
            : dashboardSource,
        );
      },
    }));
    const routeOptions = {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
      weeklyComplianceResponse: {
        items: [{
          yearMonth: '2026-07', weekNo: 2, status: 'PENDING', completedAt: null,
        }],
        nextCursor: '', onTimeCount: 0, missedCount: 0,
      },
    };

    const pm = createApp(fetchImpl, createIdempotencyService(), {}, routeOptions).app;
    await request(pm)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.actions).toMatchObject({
          completeWeekly: { enabled: true },
          // 완료 전이면 회수할 게 없다. 완료·회수는 서로 배타.
          reopenWeekly: { enabled: false, guide: '아직 완료 요청되지 않은 주간 정산입니다.' },
          confirmWeekly: { enabled: false, guide: '완료 요청된 주간 정산만 확정할 수 있습니다.' },
          changeExecutiveApprover: { enabled: false },
          requestMonthClose: { enabled: false, label: '월 결산 요청' },
          withdrawMonthClose: { enabled: false },
          requestMonthReopen: { enabled: false },
          cumulativeScope: { ready: true },
        });
      });

    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-05', {
      contractVersion: 'cashflow-cumulative-close-v2',
      requestId: 'project-a-2026-05', tenantId: 'tenant-a', projectId: 'project-a', yearMonth: '2026-05',
      fromMonth: '2023-01', throughMonth: '2026-04', status: 'PENDING', revision: 1,
      manifestHash: `sha256:${'2'.repeat(64)}`, requestedByUid: 'pm-1', approverUid: 'finance-1',
      monthCount: 40, weekCount: 200, cellCount: 6400,
    });
    await request(pm)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.actions.requestMonthClose.enabled).toBe(false);
        expect(response.body.actions.changeExecutiveApprover).toMatchObject({
          enabled: false,
          guide: '2026년 9월 이전 월 결산은 이력 조회만 할 수 있습니다.',
        });
      });
    source.documents.delete('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-05');

    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-06', {
      ...canonicalMonthCloseRequest('2026-06'),
      fromMonth: '2023-01', throughMonth: '2026-05', revision: 1,
      manifestHash: `sha256:${'1'.repeat(64)}`, requestedByUid: 'pm-1', approverUid: 'finance-1',
      monthCount: 41, weekCount: 205, cellCount: 6560,
    });
    await request(pm)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.actions).toMatchObject({
          completeWeekly: { enabled: true },
          changeExecutiveApprover: { enabled: false },
          requestMonthClose: { enabled: false },
          withdrawMonthClose: { enabled: false },
          requestMonthReopen: { enabled: false },
        });
      });

    const tenantAdmin = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'tenant-admin-1', actorRole: 'tenant_admin',
    }, routeOptions).app;
    source.documents.delete('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-06');
    await request(tenantAdmin)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.actions.completeWeekly.enabled).toBe(false);
        expect(response.body.actions.requestMonthClose.enabled).toBe(false);
        expect(response.body.actions.changeExecutiveApprover.enabled).toBe(false);
      });
  });

  it('fails month-close actions closed for an inactive canonical member', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/members/admin-1', {
      uid: 'admin-1', status: 'INACTIVE', role: 'admin', projectIds: ['project-a'],
    });
    const dashboard = monthDashboardSource({
      ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
    });
    dashboard.settlementCycle.commandCapabilities = deniedSettlementCycleCapabilities('ACTOR_INACTIVE');
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(dashboard),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'admin-1', actorRole: 'admin', actorEmail: 'admin@example.com',
    }, {
      env: runtimeEnv, db: source.db, now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        for (const action of ['completeWeekly', 'changeExecutiveApprover', 'requestMonthClose', 'withdrawMonthClose', 'requestMonthReopen']) {
          expect(response.body.actions[action].enabled).toBe(false);
        }
      });
  });

  it('keeps historical reopen disabled even when the old projection allowed it', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-06', {
      ...canonicalMonthCloseRequest('2026-06', 'APPROVED', {
        approvalVersionId: 'approval-v2',
        ledgerRevision: 2,
        manifestHash: `sha256:${'a'.repeat(64)}`,
      }),
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(withCanonicalLockedCycle(monthDashboardSource(
        {
          ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'CLOSED', revision: 1,
          snapshot: {},
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ))),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv, db: source.db, now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => expect(response.body.actions.requestMonthReopen).toEqual({
        enabled: false,
        guide: '승인 완료된 최신 월 결산만 재오픈을 요청할 수 있습니다.',
      }));
  });

  it('keeps the dashboard readable when the canonical JVM denies reopen for this actor', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-06', {
      ...canonicalMonthCloseRequest('2026-06', 'APPROVED', {
        approvalVersionId: 'approval-v2',
        ledgerRevision: 2,
        manifestHash: `sha256:${'a'.repeat(64)}`,
      }),
    });
    const sourceBody = withCanonicalLockedCycle(monthDashboardSource({
      ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'CLOSED', revision: 1,
      snapshot: {},
    }));
    sourceBody.settlementCycle.commandCapabilities.REQUEST_MONTH_REOPEN = {
      allowed: false,
      reasonCode: 'PROJECT_WRITE_FORBIDDEN',
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(sourceBody),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv, db: source.db, now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard).toBeTruthy();
        expect(response.body.actions.requestMonthReopen).toMatchObject({
          enabled: false,
          guide: expect.stringContaining('승인 완료된 최신 월 결산'),
        });
      });
  });

  it('keeps the dashboard readable but fails request-dependent actions closed when the request store is unavailable', async () => {
    const source = fullMonthCloseSource({ yearMonth: '2026-08' });
    const requestPath = 'orgs/tenant-a/cashflow_month_close_requests/project-a-2026-09';
    const db = {
      ...source.db,
      doc: (path) => path === requestPath
        ? { path, get: async () => { throw new Error('Firestore request store exploded'); } }
        : source.db.doc(path),
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(withCanonicalSubmittedCycle(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-09', status: 'OPEN', revision: 0,
      }))),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv, db, now: () => new Date('2026-09-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-09')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.cells).toHaveLength(160);
        expect(response.body.sectionErrors).toContainEqual(expect.objectContaining({
          section: 'monthCloseRequest',
          code: 'cashflow_month_close_request_unavailable',
          label: '월 결산 승인 요청',
        }));
        for (const action of ['changeExecutiveApprover', 'requestMonthClose', 'withdrawMonthClose', 'requestMonthReopen']) {
          expect(response.body.actions[action]).toMatchObject({
            enabled: false,
            guide: expect.stringContaining('승인 요청 상태'),
          });
        }
        expect(response.body.actions.requestMonthClose.label).toBe('월 결산 요청 상태 확인 필요');
        expect(JSON.stringify(response.body)).not.toContain('Firestore request store exploded');
      });
  });

  it.each([
    ['invalid format', '2026-13'],
    ['before the cumulative baseline', '2022-12'],
    ['beyond the bounded cumulative range', '2043-02'],
  ])('rejects %s before reading the JVM month-close source', async (_label, yearMonth) => {
    const fetchImpl = vi.fn();
    const { app } = createApp(fetchImpl, createIdempotencyService());

    await request(app)
      .get(`/api/v1/cashflow/project-a/month-close?yearMonth=${yearMonth}`)
      .expect(400)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_month_close_request_invalid');
      });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('publishes a month dashboard with pending apply metadata while a sheet apply is in progress', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/cashflow_sheet_publications/project-a', {
      projectId: 'project-a',
      status: 'APPLYING',
      stagedRunId: 'run-in-flight',
      sourceRevision: source.sourceRevision,
      targetRevisionAtFetch: source.targetRevision,
      applyStartedAt: '2026-07-24T08:00:00.000Z',
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-07-24T08:01:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.pendingApply).toEqual({
          startedAt: '2026-07-24T08:00:00.000Z',
          expiresAt: '2026-07-24T08:10:00.000Z',
        });
        expect(response.body.publicationChangedDuringRead).toBe(false);
      });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps month lock statuses only from JVM closedThrough, not settlement-month history', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/monthly_closes/project-a-2026-07', {
      tenantId: 'tenant-a', projectId: 'project-a', yearMonth: '2026-07', status: 'CLOSED',
    });
    source.documents.set('orgs/tenant-a/monthly_closes/project-a-2026-08', {
      tenantId: 'tenant-a', projectId: 'project-a', yearMonth: '2026-08', status: 'CLOSED',
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource(
        { ok: true, projectId: 'project-a', yearMonth: '2026-08', status: 'OPEN', revision: 0 },
        undefined,
        undefined,
        undefined,
        undefined,
        closedCumulativeAuthority('2026-07'),
      )),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-08-14T01:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-08')
      .expect(200)
      .expect((response) => {
        const statuses = new Map(response.body.dashboard.monthCloseStatuses
          .map((entry) => [entry.yearMonth, entry.status]));
        expect(statuses.get('2026-07')).toBe('CLOSED');
        expect(statuses.get('2026-08')).toBe('OPEN');
      });

    const annualFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource(
        { ok: true, projectId: 'project-a', yearMonth: '2025-12', status: 'OPEN', revision: 0 },
        undefined,
        undefined,
        undefined,
        undefined,
        closedCumulativeAuthority('2026-07'),
      )),
    }));
    const annualApp = createApp(annualFetch, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-08-14T01:00:00.000Z'),
    }).app;
    await request(annualApp)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2025-12')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.monthCloseStatuses)
          .toHaveLength(12);
        expect(response.body.dashboard.monthCloseStatuses.every((entry) => entry.status === 'OPEN'))
          .toBe(true);
    });
  });

  it('passes JVM operational OPEN status while retaining stale CLOSED latest-run evidence', async () => {
    const source = fullMonthCloseSource();
    const operational = {
      ok: true,
      projectId: 'project-a',
      yearMonth: '2026-08',
      status: 'OPEN',
      revision: 1,
      reopenCount: 0,
      projectWarningCount: 0,
      snapshot: {},
    };
    const jvmSource = monthDashboardSource(
      operational,
      undefined,
      undefined,
      undefined,
      undefined,
      closedCumulativeAuthority('2026-07', 4),
    );
    jvmSource.latestRun = {
      ...operational,
      status: 'CLOSED',
      snapshot: { ledgerWeeks: [] },
      snapshotHash: `sha256:${'b'.repeat(64)}`,
    };
    jvmSource.monthStatusEvidence = {
      authority: 'CUMULATIVE_CLOSE_HEAD',
      authorityAvailability: 'AVAILABLE',
      operationalStatus: 'OPEN',
      latestRunStatus: 'CLOSED',
      closedThrough: '2026-07',
      issueCode: 'MONTH_CLOSE_HISTORY_STATUS_DIFFERS_FROM_CUMULATIVE_AUTHORITY',
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(jvmSource),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-08-14T01:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-08')
      .expect(200)
      .expect((response) => {
        expect(response.body.status).toBe('OPEN');
        expect(response.body.latestRun.status).toBe('CLOSED');
        expect(response.body.monthStatusEvidence).toEqual(jvmSource.monthStatusEvidence);
        expect(response.body.dashboard.source.kind).toBe('PINNED_MIRROR');
        expect(response.body.dashboard.validation.blockers.map((blocker) => blocker.code))
          .not.toContain('MONTH_NOT_OPEN');
      });
  });

  it('returns the latest month dashboard with metadata when publication changes twice', async () => {
    const source = fullMonthCloseSource();
    let publicationReadCount = 0;
    const baseDoc = source.db.doc;
    source.db.doc = (path) => {
      if (path !== 'orgs/tenant-a/cashflow_sheet_publications/project-a') return baseDoc(path);
      return {
        get: async () => ({
          exists: true,
          data: () => ({ status: 'APPLIED', stagedRunId: `run-${publicationReadCount += 1}` }),
        }),
      };
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv, db: source.db });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.publicationChangedDuringRead).toBe(true);
        expect(response.body.pendingApply).toBeNull();
      });

    expect(publicationReadCount).toBe(4);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops blocking the month dashboard once an abandoned sheet apply lease expires', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/cashflow_sheet_publications/project-a', {
      projectId: 'project-a',
      status: 'APPLYING',
      stagedRunId: 'run-abandoned',
      sourceRevision: source.sourceRevision,
      targetRevisionAtFetch: source.targetRevision,
      applyStartedAt: '2026-07-24T08:00:00.000Z',
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-07-24T09:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.pendingApply).toBeNull();
      });

    // 만료된 락이 더 이상 JVM 조회를 가로막지 않는다.
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('combines explicit sheet refresh and JVM month-close audit records for the activity timeline', async () => {
    const performanceEvents = [];
    const eventsByCollection = {
      cashflow_sheet_refresh_runs: [{
        id: 'refresh-1', projectId: 'project-a', idempotencyKey: 'refresh-key', status: 'COMPLETED',
        createdAt: '2026-07-01T00:00:00.000Z', completedAt: '2026-07-01T00:01:00.000Z',
        createdBy: { uid: 'pm-1', name: '변민욱(보람)', email: 'pm@example.com' },
        response: { status: 'FRESH', selectedSheetName: 'cashflow(사용내역 연동)' },
      }],
      weekly_api_audit_events: [
        {
          id: 'close-1', projectId: 'project-a', idempotencyKey: 'close-key', commandName: 'cashflowMonth.close',
          actorId: 'pm-1', createdAt: '2026-07-02T00:00:00.000Z',
          metadataJson: JSON.stringify({ yearMonth: '2026-06', status: 'CLOSED', actorEmail: 'pm@example.com' }),
        },
        {
          id: 'apply-1', projectId: 'project-a', idempotencyKey: 'apply-key', commandName: 'weeklyExpense.cashflowSheetLab.apply',
          actorId: 'pm-1', createdAt: '2026-07-01T12:00:00.000Z',
          metadataJson: JSON.stringify({
            yearMonth: '2026-06', projectionLineCount: 8, actualLineCount: 7,
            actorName: '변민욱(보람)', actorEmail: 'pm@example.com',
          }),
        },
        {
          id: 'apply-annual-1', projectId: 'project-a', idempotencyKey: 'apply-annual-key', commandName: 'weeklyExpense.cashflowSheetLab.apply',
          actorId: 'pm-1', createdAt: '2026-07-01T13:00:00.000Z',
          metadataJson: JSON.stringify({
            scope: 'annual', year: 2025, projectionLineCount: 16, actualLineCount: 16,
            actorName: '변민욱(보람)', actorEmail: 'pm@example.com',
          }),
        },
      ],
      cashflow_events: [],
    };
    const { db, queries: activityQueries } = createCashflowActivityTestDb({ eventsByCollection });
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, {
      env: runtimeEnv,
      db,
      performanceLogger: (event) => performanceEvents.push(event),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/activity')
      .expect(200)
      .expect((response) => {
        expect(response.body.events).toMatchObject([
          { type: 'month_close', yearMonth: '2026-06', status: 'CLOSED' },
          { type: 'sheet_apply', scope: 'annual', year: 2025, appliedLineCount: 32 },
          {
            type: 'sheet_apply', yearMonth: '2026-06', appliedLineCount: 15,
            actorName: '변민욱(보람)', actorEmail: 'pm@example.com',
          },
          { type: 'sheet_refresh', sheetName: 'cashflow(사용내역 연동)', actorName: '변민욱(보람)', actorEmail: 'pm@example.com' },
        ]);
      });
    expect(activityQueries.find((query) => query.collectionId === 'weekly_api_audit_events')).toMatchObject({
      filters: [['projectId', '==', 'project-a']],
      orderBys: [['createdAt', 'desc'], ['__name__', 'desc']],
      limit: 50,
    });
    expect(performanceEvents.filter((event) => event.operation === 'cashflow.activity.read')).toEqual(
      expect.arrayContaining(['sheet_refresh', 'audit', 'legacy'].map((source) => expect.objectContaining({
        phase: 'activity_source_read',
        source,
        outcome: 'ok',
        queryCount: 1,
        documentCount: expect.any(Number),
        documentJsonBytes: expect.any(Number),
        responseJsonBytes: expect.any(Number),
        durationMs: expect.any(Number),
      }))),
    );
  });

  it('reads at most 50 raw documents per activity source and returns one globally newest page', async () => {
    const createdAt = (index) => new Date(Date.UTC(2026, 6, 2, 0, 0, index)).toISOString();
    const eventsByCollection = {
      cashflow_sheet_refresh_runs: Array.from({ length: 60 }, (_, index) => ({
        id: `refresh-${String(index).padStart(2, '0')}`,
        projectId: 'project-a',
        status: 'COMPLETED',
        createdAt: createdAt(index),
        response: { status: 'FRESH', selectedSheetName: 'cashflow(사용내역 연동)' },
      })),
      weekly_api_audit_events: Array.from({ length: 60 }, (_, index) => ({
        id: `audit-${String(index).padStart(2, '0')}`,
        projectId: 'project-a',
        commandName: 'weeklyExpense.cashflowSheetLab.apply',
        createdAt: createdAt(index),
        metadataJson: JSON.stringify({ yearMonth: '2026-06', projectionLineCount: 1, actualLineCount: 0 }),
      })),
      cashflow_events: Array.from({ length: 60 }, (_, index) => ({
        id: `legacy-${String(index).padStart(2, '0')}`,
        projectId: 'project-a',
        runId: `legacy-run-${index}`,
        type: 'projection_completed',
        createdAt: createdAt(index),
      })),
    };
    const { db, queries } = createCashflowActivityTestDb({ eventsByCollection });
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db });

    const response = await request(app)
      .get('/api/v1/cashflow/project-a/activity')
      .expect(200);

    expect(response.body.events).toHaveLength(50);
    expect(queries.map((query) => ({
      collectionId: query.collectionId,
      filters: query.filters,
      orderBys: query.orderBys,
      limit: query.limit,
    })).sort((left, right) => left.collectionId.localeCompare(right.collectionId))).toEqual([
      'cashflow_events',
      'cashflow_sheet_refresh_runs',
      'weekly_api_audit_events',
    ].map((collectionId) => ({
      collectionId,
      filters: [['projectId', '==', 'project-a']],
      orderBys: [['createdAt', 'desc'], ['__name__', 'desc']],
      limit: 50,
    })));
  });

  it('does not return an older sparse-source event before the next newer audit page', async () => {
    const auditDocuments = Array.from({ length: 51 }, (_, index) => ({
      id: `audit-global-${String(index).padStart(2, '0')}`,
      projectId: 'project-a',
      commandName: 'weeklyExpense.cashflowSheetLab.apply',
      createdAt: new Date(Date.UTC(2026, 6, 2, 0, 0, 59 - index)).toISOString(),
      metadataJson: JSON.stringify({ yearMonth: '2026-06', projectionLineCount: 1, actualLineCount: 0 }),
    }));
    const { db } = createCashflowActivityTestDb({
      eventsByCollection: {
        cashflow_sheet_refresh_runs: [],
        weekly_api_audit_events: auditDocuments,
        cashflow_events: [{
          id: 'legacy-old', projectId: 'project-a', runId: 'legacy-old',
          type: 'projection_completed', createdAt: '2024-01-01T00:00:00.000Z',
        }],
      },
    });
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db });

    const first = await request(app)
      .get('/api/v1/cashflow/project-a/activity')
      .expect(200);
    expect(first.body.events).toHaveLength(50);
    expect(first.body.events.some((event) => event.id === 'legacy-old')).toBe(false);

    const second = await request(app)
      .get(`/api/v1/cashflow/project-a/activity?cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(200);
    expect(second.body.events.map((event) => event.id)).toEqual([
      'sheet-apply:audit-global-50',
      'legacy-old',
    ]);
    expect(second.body.nextCursor).toBeNull();
  });

  it('uses one opaque aggregate cursor to return the second page without duplicating shorter sources', async () => {
    const legacyEvents = Array.from({ length: 51 }, (_, index) => ({
      id: `legacy-${String(index).padStart(2, '0')}`,
      projectId: 'project-a',
      runId: `legacy-run-${index}`,
      type: 'projection_completed',
      createdAt: new Date(Date.UTC(2026, 6, 2, 0, 0, 59 - index)).toISOString(),
    }));
    const eventsByCollection = {
      cashflow_sheet_refresh_runs: [{
        id: 'refresh-only', projectId: 'project-a', status: 'COMPLETED',
        createdAt: '2026-07-03T00:00:00.000Z', response: { status: 'FRESH' },
      }],
      weekly_api_audit_events: [{
        id: 'audit-only', projectId: 'project-a', commandName: 'cashflowMonth.close',
        createdAt: '2026-07-03T00:00:01.000Z', metadataJson: JSON.stringify({ yearMonth: '2026-06', status: 'CLOSED' }),
      }],
      cashflow_events: legacyEvents,
    };
    const { db } = createCashflowActivityTestDb({ eventsByCollection });
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db });

    const first = await request(app)
      .get('/api/v1/cashflow/project-a/activity')
      .expect(200);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(first.body.nextCursor).not.toBe('legacy-49');

    const second = await request(app)
      .get(`/api/v1/cashflow/project-a/activity?cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(200);
    const firstIds = new Set(first.body.events.map((event) => event.id));
    const secondIds = second.body.events.map((event) => event.id);
    expect(secondIds).toEqual(['legacy-48', 'legacy-49', 'legacy-50']);
    expect(secondIds.filter((id) => firstIds.has(id))).toEqual([]);
    expect([...firstIds, ...secondIds]).toHaveLength(53);
  });

  it('does not skip same-timestamp mixed-case document ids when an aggregate page cuts inside one source', async () => {
    const tiedCreatedAt = '2026-07-02T00:00:00.000Z';
    const { db } = createCashflowActivityTestDb({
      eventsByCollection: {
        cashflow_sheet_refresh_runs: [{
          id: 'refresh-newer', projectId: 'project-a', status: 'COMPLETED',
          createdAt: '2026-07-03T00:00:00.000Z', response: { status: 'FRESH' },
        }],
        weekly_api_audit_events: ['a-audit', 'Z-audit'].map((id) => ({
          id,
          projectId: 'project-a',
          commandName: 'weeklyExpense.cashflowSheetLab.apply',
          createdAt: tiedCreatedAt,
          metadataJson: JSON.stringify({ yearMonth: '2026-06', projectionLineCount: 1, actualLineCount: 0 }),
        })),
        cashflow_events: [],
      },
    });
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db });

    const first = await request(app)
      .get('/api/v1/cashflow/project-a/activity?limit=2')
      .expect(200);
    const second = await request(app)
      .get(`/api/v1/cashflow/project-a/activity?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(200);

    expect([...first.body.events, ...second.body.events].map((event) => event.id)).toEqual([
      'sheet-refresh:refresh-newer',
      'sheet-apply:a-audit',
      'sheet-apply:Z-audit',
    ]);
  });

  it('pages by the Firestore document id when the stored activity payload has a different id', async () => {
    const createdAt = '2026-07-02T00:00:00.000Z';
    const { db } = createCashflowActivityTestDb({
      eventsByCollection: {
        cashflow_events: [
          {
            __documentId: 'firestore-b', id: 'event-newer', projectId: 'project-a',
            type: 'projection_completed', createdAt,
          },
          {
            __documentId: 'firestore-a', id: 'event-older', projectId: 'project-a',
            type: 'projection_completed', createdAt,
          },
        ],
      },
    });
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db });

    const first = await request(app)
      .get('/api/v1/cashflow/project-a/activity?source=legacy&limit=1')
      .expect(200);
    const second = await request(app)
      .get(`/api/v1/cashflow/project-a/activity?source=legacy&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(200);
    const third = await request(app)
      .get(`/api/v1/cashflow/project-a/activity?source=legacy&limit=1&cursor=${encodeURIComponent(second.body.nextCursor)}`)
      .expect(200);

    expect(first.body.events.map((event) => event.id)).toEqual(['event-newer']);
    expect(second.body.events.map((event) => event.id)).toEqual(['event-older']);
    expect(third.body.events).toEqual([]);
    expect(third.body.nextCursor).toBeNull();
  });

  it('keeps every derived activity timestamp inside the raw document cursor order across pages', async () => {
    const rawCreatedAt = (index) => new Date(Date.UTC(2026, 6, 2, 0, 0, 59 - index)).toISOString();
    const refreshDocuments = Array.from({ length: 51 }, (_, index) => ({
      id: `refresh-order-${String(index).padStart(2, '0')}`,
      projectId: 'project-a',
      status: 'COMPLETED',
      createdAt: rawCreatedAt(index),
      completedAt: index === 50 ? '2030-01-01T00:00:00.000Z' : rawCreatedAt(index),
      response: { status: 'FRESH' },
    }));
    const auditDocuments = Array.from({ length: 51 }, (_, index) => ({
      id: `audit-order-${String(index).padStart(2, '0')}`,
      projectId: 'project-a',
      commandName: 'weeklyExpense.cashflowSheetLab.apply',
      createdAt: rawCreatedAt(index),
      metadataJson: JSON.stringify({
        yearMonth: '2026-06',
        projectionLineCount: 1,
        actualLineCount: 0,
        ...(index === 50 ? {
          appliedCellChanges: [{
            yearMonth: '2026-06', weekNo: 1, mode: 'projection', cashflowLine: 'SALES_IN',
            before: { cellState: 'ZERO', amount: 0 },
            after: { cellState: 'VALUE', amount: 1 },
            changedAt: '2031-01-01T00:00:00.000Z',
          }],
        } : {}),
      }),
    }));
    const { db } = createCashflowActivityTestDb({
      eventsByCollection: {
        cashflow_sheet_refresh_runs: refreshDocuments,
        weekly_api_audit_events: auditDocuments,
        cashflow_events: [],
      },
    });
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db });

    const first = await request(app)
      .get('/api/v1/cashflow/project-a/activity')
      .expect(200);
    const second = await request(app)
      .get(`/api/v1/cashflow/project-a/activity?cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(200);

    const oldestFirstPage = first.body.events
      .map((event) => event.createdAt)
      .sort()[0];
    const newestSecondPage = second.body.events
      .map((event) => event.createdAt)
      .sort()
      .at(-1);
    expect(newestSecondPage.localeCompare(oldestFirstPage)).toBeLessThanOrEqual(0);
  });

  it.each([
    { createdAt: 'not-an-instant', id: 'legacy-1' },
    { createdAt: '2026-07-01T00:00:00.000Z', id: 'bad/id' },
  ])('rejects malformed activity cursor boundaries before querying Firestore: %j', async (boundary) => {
    const cursor = Buffer.from(JSON.stringify({
      version: 1,
      projectId: 'project-a',
      source: 'legacy',
      boundaries: { legacy: { done: false, ...boundary } },
    }), 'utf8').toString('base64url');
    const { db, queries } = createCashflowActivityTestDb();
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db });

    await request(app)
      .get(`/api/v1/cashflow/project-a/activity?source=legacy&cursor=${encodeURIComponent(cursor)}`)
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('cashflow_activity_query_invalid'));
    expect(queries).toEqual([]);
  });

  it('returns successful activity sources and a structured error when one aggregate source query fails', async () => {
    const eventsByCollection = {
      cashflow_sheet_refresh_runs: [{
        id: 'refresh-success', projectId: 'project-a', status: 'COMPLETED',
        createdAt: '2026-07-03T00:00:00.000Z', response: { status: 'FRESH' },
      }],
      cashflow_events: [{
        id: 'legacy-success', projectId: 'project-a', runId: 'legacy-success',
        type: 'actual_completed', createdAt: '2026-07-02T00:00:00.000Z',
      }],
    };
    const { db } = createCashflowActivityTestDb({
      eventsByCollection,
      failingCollections: ['weekly_api_audit_events'],
    });
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db });

    await request(app)
      .get('/api/v1/cashflow/project-a/activity')
      .expect(200)
      .expect((response) => {
        expect(response.body.events).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'sheet-refresh:refresh-success', type: 'sheet_refresh' }),
          expect.objectContaining({ id: 'legacy-success', type: 'actual_completed' }),
        ]));
        expect(response.body.errors).toContainEqual({
          source: 'audit',
          code: 'cashflow_activity_source_unavailable',
        });
      });
  });

  it('keeps all 100 cell changes from one audit document together at a raw-document page boundary', async () => {
    const appliedCellChanges = Array.from({ length: 100 }, (_, index) => ({
      yearMonth: '2026-06', weekNo: (index % 5) + 1,
      mode: index % 2 === 0 ? 'projection' : 'actual',
      cashflowLine: `BOUNDARY_LINE_${index}`,
      before: { cellState: 'ZERO', amount: 0 },
      after: { cellState: 'VALUE', amount: index + 1 },
      changedAt: '2026-07-01T00:00:10.000Z',
    }));
    const auditDocuments = Array.from({ length: 51 }, (_, index) => ({
      id: `audit-boundary-${String(index).padStart(2, '0')}`,
      projectId: 'project-a',
      idempotencyKey: `audit-run-${index}`,
      commandName: 'weeklyExpense.cashflowSheetLab.apply',
      createdAt: new Date(Date.UTC(2026, 6, 2, 0, 0, 59 - index)).toISOString(),
      metadataJson: JSON.stringify({
        yearMonth: '2026-06', projectionLineCount: 1, actualLineCount: 0,
        ...(index === 49 ? { appliedCellChanges } : {}),
      }),
    }));
    const { db } = createCashflowActivityTestDb({
      eventsByCollection: {
        cashflow_sheet_refresh_runs: [],
        weekly_api_audit_events: auditDocuments,
        cashflow_events: [],
      },
    });
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db });

    const first = await request(app)
      .get('/api/v1/cashflow/project-a/activity')
      .expect(200);
    const firstBundle = first.body.events.filter((event) => event.id.startsWith('sheet-apply-cell:audit-boundary-49:'));
    expect(firstBundle).toHaveLength(100);
    expect(new Set(firstBundle.map((event) => event.id)).size).toBe(100);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(app)
      .get(`/api/v1/cashflow/project-a/activity?cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(200);
    expect(second.body.events.filter((event) => event.id.startsWith('sheet-apply-cell:audit-boundary-49:'))).toHaveLength(0);
    expect(second.body.events).toEqual([
      expect.objectContaining({ id: 'sheet-apply:audit-boundary-50', type: 'sheet_apply' }),
    ]);
  });

  it('pages full-sheet audit bundles before the activity response exceeds its byte budget', async () => {
    const appliedCellChanges = Array.from({ length: 1_920 }, (_, index) => ({
      yearMonth: '2026-06', weekNo: (index % 5) + 1,
      mode: index % 2 === 0 ? 'projection' : 'actual',
      cashflowLine: `FULL_SHEET_LINE_${index}`,
      before: { cellState: 'ZERO', amount: 0 },
      after: { cellState: 'VALUE', amount: index + 1 },
      changedAt: '2026-07-01T00:00:10.000Z',
    }));
    const auditDocuments = Array.from({ length: 5 }, (_, index) => ({
      id: `audit-full-sheet-${index}`,
      projectId: 'project-a',
      idempotencyKey: `full-sheet-run-${index}`,
      commandName: 'weeklyExpense.cashflowSheetLab.apply',
      createdAt: new Date(Date.UTC(2026, 6, 2, 0, 0, 59 - index)).toISOString(),
      metadataJson: JSON.stringify({
        yearMonth: '2026-06', projectionLineCount: 960, actualLineCount: 960,
        appliedCellChanges,
      }),
    }));
    const { db } = createCashflowActivityTestDb({
      eventsByCollection: {
        cashflow_sheet_refresh_runs: [],
        weekly_api_audit_events: auditDocuments,
        cashflow_events: [],
      },
    });
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db });

    const eventIds = new Set();
    let cursor = '';
    let pageCount = 0;
    do {
      const response = await request(app)
        .get(`/api/v1/cashflow/project-a/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
        .expect(200);
      expect(Buffer.byteLength(JSON.stringify(response.body), 'utf8')).toBeLessThan(2 * 1024 * 1024);
      for (const event of response.body.events) {
        expect(eventIds.has(event.id)).toBe(false);
        eventIds.add(event.id);
      }
      cursor = response.body.nextCursor || '';
      pageCount += 1;
      expect(pageCount).toBeLessThanOrEqual(5);
    } while (cursor);

    expect(pageCount).toBe(5);
    expect(eventIds.size).toBe(5 * (1_920 + 1));
  });

  it('returns one oversized audit bundle whole and advances the cursor to older activity', async () => {
    const oversizedChanges = Array.from({ length: 4_500 }, (_, index) => ({
      yearMonth: '2026-06', weekNo: (index % 5) + 1,
      mode: index % 2 === 0 ? 'projection' : 'actual',
      cashflowLine: `OVERSIZED_LINE_${index}`,
      before: { cellState: 'ZERO', amount: 0 },
      after: { cellState: 'VALUE', amount: index + 1 },
    }));
    const { db } = createCashflowActivityTestDb({
      eventsByCollection: {
        cashflow_sheet_refresh_runs: [],
        weekly_api_audit_events: [{
          id: 'audit-oversized', projectId: 'project-a',
          commandName: 'weeklyExpense.cashflowSheetLab.apply',
          createdAt: '2026-07-02T00:00:02.000Z',
          metadataJson: JSON.stringify({
            yearMonth: '2026-06', projectionLineCount: 2_250, actualLineCount: 2_250,
            appliedCellChanges: oversizedChanges,
          }),
        }, {
          id: 'audit-older', projectId: 'project-a',
          commandName: 'weeklyExpense.cashflowSheetLab.apply',
          createdAt: '2026-07-02T00:00:01.000Z',
          metadataJson: JSON.stringify({ yearMonth: '2026-06', projectionLineCount: 1, actualLineCount: 0 }),
        }],
        cashflow_events: [],
      },
    });
    const performanceEvents = [];
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, {
      env: runtimeEnv,
      db,
      performanceLogger: (event) => performanceEvents.push(event),
    });

    const first = await request(app)
      .get('/api/v1/cashflow/project-a/activity')
      .expect(200);
    const firstResponseBytes = Buffer.byteLength(JSON.stringify(first.body), 'utf8');
    expect(first.body.events).toHaveLength(4_501);
    expect(firstResponseBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(firstResponseBytes).toBeLessThan(4 * 1024 * 1024);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(performanceEvents).toContainEqual(expect.objectContaining({
      operation: 'cashflow.activity.read',
      source: 'audit',
      responseBudgetExceeded: true,
    }));

    const second = await request(app)
      .get(`/api/v1/cashflow/project-a/activity?cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(200);
    expect(second.body.events.map((event) => event.id)).toEqual(['sheet-apply:audit-older']);
    expect(second.body.nextCursor).toBeNull();
  });

  it('keeps mixed-source newest order when a whole audit bundle reaches the byte boundary', async () => {
    const fullSheetChanges = Array.from({ length: 1_920 }, (_, index) => ({
      yearMonth: '2026-06', weekNo: (index % 5) + 1,
      mode: index % 2 === 0 ? 'projection' : 'actual',
      cashflowLine: `MIXED_LINE_${index}`,
      before: { cellState: 'ZERO', amount: 0 },
      after: { cellState: 'VALUE', amount: index + 1 },
    }));
    const { db } = createCashflowActivityTestDb({
      eventsByCollection: {
        cashflow_sheet_refresh_runs: [{
          id: 'refresh-between', projectId: 'project-a', status: 'COMPLETED',
          createdAt: '2026-07-02T00:00:03.000Z', response: { status: 'FRESH' },
        }],
        weekly_api_audit_events: ['04', '02'].map((second) => ({
          id: `audit-mixed-${second}`, projectId: 'project-a',
          commandName: 'weeklyExpense.cashflowSheetLab.apply',
          createdAt: `2026-07-02T00:00:${second}.000Z`,
          metadataJson: JSON.stringify({
            yearMonth: '2026-06', projectionLineCount: 960, actualLineCount: 960,
            appliedCellChanges: fullSheetChanges,
          }),
        })),
        cashflow_events: [{
          id: 'legacy-older', projectId: 'project-a', type: 'projection_completed',
          createdAt: '2026-07-02T00:00:01.000Z',
        }],
      },
    });
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db });

    const summaries = [];
    let cursor = '';
    do {
      const response = await request(app)
        .get(`/api/v1/cashflow/project-a/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
        .expect(200);
      expect(Buffer.byteLength(JSON.stringify(response.body), 'utf8')).toBeLessThan(2 * 1024 * 1024);
      summaries.push(...response.body.events
        .filter((event) => !event.id.startsWith('sheet-apply-cell:'))
        .map((event) => event.id));
      cursor = response.body.nextCursor || '';
    } while (cursor);

    expect(summaries).toEqual([
      'sheet-apply:audit-mixed-04',
      'sheet-refresh:refresh-between',
      'sheet-apply:audit-mixed-02',
      'legacy-older',
    ]);
  });

  it('keeps malformed declared audit counts and cell amounts unavailable instead of coercing them to zero', async () => {
    const audit = {
      id: 'apply-invalid-amounts',
      projectId: 'project-a',
      commandName: 'weeklyExpense.cashflowSheetLab.apply',
      createdAt: '2026-07-01T12:00:00.000Z',
      metadataJson: JSON.stringify({
        yearMonth: '2026-06',
        projectionLineCount: null,
        appliedCellChanges: [{
          yearMonth: '2026-06',
          weekNo: '1',
          mode: 'projection',
          cashflowLine: 'SALES_IN',
          before: { cellState: 'VALUE', amount: null },
          after: { cellState: 'VALUE', amount: '1200' },
          changedAt: '2026-07-01T12:00:00.000Z',
        }],
      }),
    };
    const db = {
      collection: () => ({
        where: () => {
          const chain = {
            orderBy: () => chain,
            limit: () => chain,
            get: async () => ({ docs: [{ id: audit.id, data: () => audit }] }),
          };
          return chain;
        },
      }),
    };
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db });

    await request(app)
      .get('/api/v1/cashflow/project-a/activity?source=audit')
      .expect(200)
      .expect((response) => {
        const apply = response.body.events.find((event) => event.type === 'sheet_apply');
        expect(apply).toMatchObject({
          projectionLineCount: null,
          actualLineCount: 0,
          appliedLineCount: null,
        });
        const change = response.body.events.find((event) => event.type === 'projection_amount_change');
        expect(change).toMatchObject({
          weekNo: null,
          beforeAmount: null,
          afterAmount: null,
        });
      });
  });

  it('reads one bounded activity source without waiting for the other timeline sources', async () => {
    const { db, queries: activityQueries } = createCashflowActivityTestDb();
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db });

    await request(app)
      .get('/api/v1/cashflow/project-a/activity?source=legacy')
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ projectId: 'project-a', source: 'legacy', events: [] });
      });

    expect(activityQueries).toEqual([{
      collectionId: 'cashflow_events',
      filters: [['projectId', '==', 'project-a']],
      orderBys: [['createdAt', 'desc'], ['__name__', 'desc']],
      limit: 50,
      startAfter: [],
    }]);
  });

  it('flattens all 100 exact applied cell changes from one JVM audit into General Activity', async () => {
    const appliedCellChanges = Array.from({ length: 100 }, (_, index) => ({
      yearMonth: '2026-06',
      weekNo: (index % 5) + 1,
      mode: index % 2 === 0 ? 'projection' : 'actual',
      cashflowLine: `LINE_${index}`,
      before: index % 3 === 0 ? { cellState: 'EMPTY', amount: null } : index % 3 === 1 ? { cellState: 'ZERO', amount: 0 } : { cellState: 'VALUE', amount: index },
      after: index % 3 === 0 ? { cellState: 'ZERO', amount: 0 } : { cellState: 'VALUE', amount: index + 1000 },
      actorId: 'pm-1', actorName: '담당자', actorEmail: 'pm@example.com', changedAt: '2026-07-01T12:00:00.000Z',
      reason: '시트 정정', source: 'cashflow-sheet', operationType: 'BATCH_APPLY', operationId: 'operation-100', auditId: 'audit-100',
      sourceRevision: 'source-1', targetRevision: 'target-2', idempotencyKey: 'run-100',
    }));
    const audit = {
      id: 'audit-100', projectId: 'project-a', idempotencyKey: 'run-100', commandName: 'weeklyExpense.cashflowSheetLab.apply',
      actorId: 'pm-1', createdAt: '2026-07-01T12:00:00.000Z',
      metadataJson: JSON.stringify({
        yearMonth: '2026-06', projectionLineCount: 50, actualLineCount: 50, actorName: '담당자', actorEmail: 'pm@example.com',
        operationType: 'BATCH_APPLY', operationId: 'operation-100', reason: '시트 정정', appliedCellChanges,
      }),
    };
    const db = {
      collection: () => ({
        where: () => {
          const chain = {
            orderBy: () => chain,
            limit: () => chain,
            get: async () => ({ docs: [{ id: audit.id, data: () => audit }] }),
          };
          return chain;
        },
      }),
    };
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db });

    await request(app)
      .get('/api/v1/cashflow/project-a/activity?source=audit')
      .expect(200)
      .expect((response) => {
        const changes = response.body.events.filter((event) => event.type === 'projection_amount_change' || event.type === 'actual_amount_change');
        expect(changes).toHaveLength(100);
        expect(response.body.events.filter((event) => event.type === 'sheet_apply')).toHaveLength(1);
        expect(changes[0]).toMatchObject({
          id: 'sheet-apply-cell:audit-100:0', runId: 'run-100', operation: 'BATCH_APPLY', operationId: 'operation-100', auditId: 'audit-100',
          yearMonth: '2026-06', weekNo: 1, mode: 'projection', lineId: 'LINE_0', beforeState: 'EMPTY', afterState: 'ZERO',
          beforeHadValue: false, afterHadValue: true, afterAmount: 0, actorName: '담당자', reason: '시트 정정', sourceDetail: 'cashflow-sheet',
        });
        expect(changes[1]).toMatchObject({ beforeState: 'ZERO', beforeAmount: 0, afterState: 'VALUE', afterAmount: 1001 });
        expect(changes[99]).toMatchObject({ lineId: 'LINE_99' });
      });
  });

  it('rejects an unknown activity source without reading Firestore', async () => {
    const db = { collection: vi.fn() };
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db });

    await request(app)
      .get('/api/v1/cashflow/project-a/activity?source=unknown')
      .expect(400)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_activity_source_invalid');
      });

    expect(db.collection).not.toHaveBeenCalled();
  });

  it('rejects General Activity before Firestore when the actor role is not authorized', async () => {
    const db = { collection: vi.fn() };
    const { app } = createApp(vi.fn(), createIdempotencyService(), { actorRole: 'external' }, { env: runtimeEnv, db });

    await request(app)
      .get('/api/v1/cashflow/project-a/activity?source=audit')
      .expect(403)
      .expect((response) => expect(response.body.code).toBe('forbidden'));

    expect(db.collection).not.toHaveBeenCalled();
  });

  it('composes the open-month dashboard from the pinned sheet, project, and JVM state without a private draft', async () => {
    const { db, sourceRevision, targetRevision } = fullMonthCloseSource({ yearMonth: '2026-05' });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ...monthDashboardSource({
          ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
          reopenCount: 0, projectWarningCount: 0, snapshot: {},
        }),
      }),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard).toMatchObject({
          source: { status: 'FRESH', sourceRevision, targetRevision },
          project: {
            settlementType: 'TYPE1', basis: '공급가액', accountType: 'DEDICATED', contractAmount: 1000,
          },
          sheetControlTotals: {
            deposit: { sourceCell: 'BO9', value: 15000, computed: 15000, matches: true },
            unpaid: { sourceCell: 'BP9', value: 85000 },
          },
          totals: {
            projection: { totalIn: 350, totalOut: 450, balance: -100 },
            actual: { totalIn: 175, totalOut: 225, balance: -50 },
            difference: { totalIn: 175, totalOut: 225, balance: -50 },
          },
          summary: {
            projectionProgressPercent: 10,
            projectionSalesAndVatTotal: 100,
            contractDifference: 900,
            contractCoveragePercent: 10,
            actualProgressPercent: 100,
            confirmationProgressPercent: 0,
            settlementProgressPercent: 0,
            settlementDifferenceAmount: -43_962_826,
            settlementMatches: false,
            settlementCompletedWeekCount: 0,
            settlementTargetWeekCount: 5,
          },
          validation: { canClose: true, blockers: [] },
          projectionActualSummary: {
            projectId: 'project-a', source: 'SHEET_FORMULA', differenceAmount: -43_962_826,
            settlementDifferenceAmount: -43_962_826, settlementMatches: false,
          },
        });
        expect(response.body.dashboard.cells).toHaveLength(160);
        expect(response.body.dashboard.depositScheduleRows).toHaveLength(5);
        expect(response.body.operationsSummary).toMatchObject({
          rates: {
            projection: {
              state: 'AVAILABLE', percent: 10, barPercent: 10, statusLabel: '미달',
            },
            actual: {
              state: 'AVAILABLE', percent: 100, barPercent: 100, statusLabel: 'OK',
            },
          },
        });
      });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not use an unavailable JVM projection-actual summary for the month dashboard', async () => {
    const { db } = fullMonthCloseSource();
    const source = monthDashboardSource({
      ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
      reopenCount: 0, projectWarningCount: 0, snapshot: {},
    });
    source.projectionActualSummary = undefined;
    const { app } = createApp(vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify(source),
    })), createIdempotencyService(), {}, { env: runtimeEnv, db });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => expect(response.body.dashboard.projectionActualSummary).toMatchObject({ source: 'SHEET_FORMULA' }));
  });

  it.each([
    ['/api/v1/cashflow/project-a/month-close/approver', { approverUid: 'finance-1', yearMonth: '2026-08' }],
    ['/api/v1/cashflow/project-a/month-close/requests', { expectedApproverUid: 'finance-1', expectedProjectVersion: 0 }],
    ['/api/v1/cashflow/project-a/month-close/requests/project-a-2026-08/review', { decision: 'APPROVE', expectedRevision: 0 }],
    ['/api/v1/cashflow/project-a/month-close', { yearMonth: '2026-08' }],
  ])('blocks %s before any BFF Firestore workflow write when BFF and JVM data projects differ', async (path, body) => {
    const db = { doc: vi.fn(), runTransaction: vi.fn(), collection: vi.fn() };
    const env = { ...runtimeEnv, JVM_WEEKLY_FIRESTORE_PROJECT_ID: 'other-data-project' };
    const { app } = createApp(vi.fn(), createIdempotencyService(), { actorRole: 'viewer' }, { env, db });

    await request(app)
      .post(path)
      .set('idempotency-key', `mismatch-${path}`)
      .send(body)
      .expect(503)
      .expect((response) => expect(response.body.code).toBe('jvm_weekly_data_project_mismatch'));

    expect(db.doc).not.toHaveBeenCalled();
    expect(db.runTransaction).not.toHaveBeenCalled();
    expect(db.collection).not.toHaveBeenCalled();
  });

  it('uses the real server time on both sides of the Thursday midnight deadline', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/cashflow_sheet_stage_runs/tracking-start', {
      projectId: 'project-a', status: 'APPLIED', appliedAt: '2026-07-06T10:00:00+09:00',
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource(
        {
          ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
          reopenCount: 0, projectWarningCount: 0, snapshot: {},
        },
        undefined,
        {
          selectedYear: 2026,
          projection: annualOpeningMode('SALES_IN', 2_000_000),
          actual: annualOpeningMode('SALES_IN', 1_800_000),
        },
      )),
    }));
    let canonicalStatus = 'PENDING';
    const weeklyComplianceResponse = () => ({
      items: [{
        yearMonth: '2026-07', weekNo: 3, deadline: '2026-07-17T00:00:00+09:00', status: canonicalStatus,
        completedAt: null, completedBy: null, operationId: '', auditId: '', updateResult: '',
      }],
      nextCursor: '', onTimeCount: 0, missedCount: canonicalStatus === 'MISSED' ? 1 : 0,
    });
    const before = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv, db: source.db, weeklyComplianceResponse,
      now: () => new Date('2026-07-16T14:59:00.000Z'),
    });
    await request(before.app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.deadlineSummary.current).toMatchObject({ status: 'PENDING' });
        expect(response.body.dashboard.deadlineSummary.weeklyStatuses).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ yearMonth: '2026-07', weekNo: 4, status: 'PENDING' }),
        ]));
      });

    canonicalStatus = 'MISSED';
    const after = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv, db: source.db, weeklyComplianceResponse,
      now: () => new Date('2026-07-16T15:01:00.000Z'),
    });
    await request(after.app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.deadlineSummary.current).toMatchObject({ status: 'MISSED' });
        expect(response.body.dashboard.deadlineSummary.missedCount).toBeGreaterThan(0);
      });
  });

  it('keeps dashboard comparison, management checks, and weekly controls on the same real KST time', async () => {
    const source = fullMonthCloseSource();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-06-07T15:30:00.000Z'),
      weeklyComplianceResponse: {
        items: [{
          yearMonth: '2026-07', weekNo: 3, deadline: '2026-07-17T00:00:00+09:00', status: 'PENDING',
          completedAt: null, completedBy: null, operationId: '', auditId: '', updateResult: '',
        }],
        nextCursor: '', onTimeCount: 0, missedCount: 0,
      },
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-07')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.summary).toMatchObject({
          comparisonAsOfDate: '2026-06-08',
          comparisonAsOfWeek: { yearMonth: '2026-06', weekNo: 2 },
        });
        expect(response.body.dashboard.comparison.weeks.map((week) => week.weekNo)).toEqual([1, 2]);
        expect(response.body.dashboard.managementChecks.find((check) => check.id === 'labor-transfer')).toMatchObject({ status: 'WARNING' });
        expect(response.body.dashboard.deadlineSummary.current).toBeNull();
      });
  });

  it('does not derive weekly compliance from a BFF reset-control document', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/cashflow_sheet_stage_runs/tracking-start', {
      projectId: 'project-a', status: 'APPLIED', appliedAt: '2026-07-06T10:00:00+09:00',
    });
    source.documents.set('orgs/tenant-a/cashflow_weekly_update_reset_controls/project-a', {
      projectId: 'project-a', trackingStartedAt: '2026-07-17T00:01:00+09:00',
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv, db: source.db });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.deadlineSummary).toMatchObject({ trackingStartedAt: null, missedCount: 0, completedCount: 0 });
        expect(response.body.dashboard.deadlineSummary.weeklyStatuses).toEqual([]);
      });
  });

  it('persists the explicit weekly settlement completion with its actor and exposes it in the dashboard', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/cashflow_sheet_stage_runs/tracking-start', {
      projectId: 'project-a', status: 'APPLIED', appliedAt: '2026-07-06T10:00:00+09:00',
    });
    const fetchImpl = vi.fn(async (url, init) => {
      if (init.method === 'POST' && url.endsWith('/api/v1/cashflow/project-a/weekly-update-complete')) {
        const body = JSON.parse(init.body);
        source.documents.set('orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3', {
          projectId: 'project-a', yearMonth: body.yearMonth, weekNo: body.weekNo,
          status: 'LOCKED', completedAt: body.completedAt, completedByEmail: 'pm@example.com',
        });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            ok: true, projectId: 'project-a', yearMonth: body.yearMonth, weekNo: body.weekNo,
            completedAt: body.completedAt, completedBy: 'pm@example.com', alreadyCompleted: false,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(monthDashboardSource(
          {
            ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
            reopenCount: 0, projectWarningCount: 0, snapshot: {},
          },
          undefined,
          undefined,
          undefined,
          undefined,
          closedCumulativeAuthority('2026-06'),
        )),
      };
    });
    const weeklyComplianceResponse = () => {
      const completion = source.documents.get('orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3');
      return {
        items: completion ? [{
          yearMonth: '2026-07', weekNo: 3, deadline: '2026-07-17T00:00:00+09:00', status: 'ON_TIME',
          completedAt: completion.completedAt, completedBy: completion.completedByEmail,
          operationId: 'op-week-3', auditId: 'audit-week-3', updateResult: 'NO_CHANGES',
        }] : [],
        nextCursor: '', onTimeCount: completion ? 1 : 0, missedCount: 0,
      };
    };
    const cashflowSlackService = { enabled: true, notifyMessage: vi.fn().mockResolvedValue(undefined) };
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'viewer' }, {
      env: runtimeEnv, db: source.db, weeklyComplianceResponse, cashflowSlackService,
      now: () => new Date('2026-07-16T09:00:00.000Z'),
    });

    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete')
      .send({ updateResult: 'NO_CHANGES' })
      .expect(200)
      .expect((response) => expect(response.body).toMatchObject({
        projectId: 'project-a', yearMonth: '2026-07', weekNo: 3, alreadyCompleted: false,
      }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cashflowSlackService.notifyMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('처리자: Project Manager'),
    }));
    expect(cashflowSlackService.notifyMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('처리자: pm-1'),
    }));

    const saved = source.documents.get('orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3');
    expect(saved).toMatchObject({ projectId: 'project-a', yearMonth: '2026-07', weekNo: 3 });
    source.documents.set('orgs/tenant-a/monthly_closes/project-a-2026-06', {
      projectId: 'project-a', yearMonth: '2026-06', status: 'CLOSED',
    });
    source.documents.set('orgs/tenant-a/monthly_closes/project-a-2026-05', {
      projectId: 'project-a',
      yearMonth: '2026-05',
      status: 'CLOSED',
      snapshot: {
        sheetFacts: {
          weeklyCalculationChecks: [{
            mode: 'projection',
            yearMonth: '2026-05',
            weekNo: 1,
            reported: { depositTotal: 111, withdrawalTotal: 222, balance: 333 },
          }],
        },
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://jvm-weekly.local/api/v1/cashflow/project-a/weekly-update-complete',
      expect.objectContaining({ method: 'POST' }),
    );

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.deadlineSummary.current).toMatchObject({
          yearMonth: '2026-07', weekNo: 3, status: 'ON_TIME',
        });
        expect(response.body.dashboard.deadlineSummary.completedWeeks).toEqual(expect.arrayContaining([
          expect.objectContaining({ yearMonth: '2026-07', weekNo: 3, completedBy: 'pm@example.com' }),
        ]));
        expect(response.body.dashboard.deadlineSummary.weeklyStatuses).toEqual(expect.arrayContaining([
          expect.objectContaining({ yearMonth: '2026-07', weekNo: 3, status: 'ON_TIME', updateResult: 'NO_CHANGES' }),
        ]));
        expect(response.body.dashboard.monthCloseStatuses).toEqual(expect.arrayContaining([
          // 결산 기한은 대상월 다음 달 10일이고, 이미 닫힌 달은 기한이 지나도 초과가 아니다.
          expect.objectContaining({ yearMonth: '2026-06', closeDeadline: '2026-07-10', closeOverdue: false }),
          expect.objectContaining({ yearMonth: '2026-05', closeDeadline: '2026-06-10', closeOverdue: false }),
          expect.objectContaining({ yearMonth: '2026-06', status: 'CLOSED' }),
          expect.objectContaining({
            yearMonth: '2026-05',
            status: 'CLOSED',
            sheetCalculationChecks: [expect.objectContaining({
              mode: 'projection',
              yearMonth: '2026-05',
              weekNo: 1,
              reported: { depositTotal: 111, withdrawalTotal: 222, balance: 333 },
            })],
          }),
        ]));
      });
  });

  it('allows aligned Live weekly completion using the real server clock', async () => {
    const source = fullMonthCloseSource();
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          projectId: 'project-a',
          yearMonth: body.yearMonth,
          weekNo: body.weekNo,
          completedAt: body.completedAt,
          completedBy: 'pm@example.com',
          alreadyCompleted: false,
        }),
      };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'viewer' }, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-08-01T05:00:00.000Z'),
    });

    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete')
      .set('idempotency-key', 'live-weekly-complete-1')
      .send({ updateResult: 'NO_CHANGES' })
      .expect(200);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['x-data-project-id']).toBe('live-data-project');
    expect(JSON.parse(init.body)).toMatchObject({
      idempotencyKey: 'cashflow-weekly:live-weekly-complete-1',
      yearMonth: '2026-08',
      weekNo: 1,
      completedAt: '2026-08-01T05:00:00.000Z',
      updateResult: 'NO_CHANGES',
    });
  });

  it('forwards the exact weekly month: August stays writable while July returns stable Korean close guidance', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.yearMonth === '2026-08') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            ok: true,
            projectId: 'project-a',
            yearMonth: body.yearMonth,
            weekNo: body.weekNo,
            completedAt: body.completedAt,
            completedBy: 'pm@example.com',
            alreadyCompleted: false,
          }),
        };
      }
      return {
        ok: false,
        status: 409,
        text: async () => JSON.stringify({
          code: 'cashflow_month_closed',
          message: 'Cashflow month is closed and cannot be changed.',
        }),
      };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'viewer' }, {
      env: runtimeEnv,
      db: fullMonthCloseSource().db,
    });

    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete')
      .set('idempotency-key', 'weekly-open-august')
      .send({ yearMonth: '2026-08', weekNo: 3, updateResult: 'NO_CHANGES' })
      .expect(200)
      .expect((response) => expect(response.body).toMatchObject({ yearMonth: '2026-08', weekNo: 3 }));

    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete')
      .set('idempotency-key', 'weekly-closed-july')
      .send({ yearMonth: '2026-07', weekNo: 5, updateResult: 'NO_CHANGES' })
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'cashflow_month_closed',
          message: '이미 누적 결산이 끝난 월이에요. 수정이 필요하면 관리자에게 월 재오픈을 요청해 주세요.',
        });
        expect(response.body.message).not.toMatch(/Cashflow|closed|cannot be changed/i);
      });

    expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body).yearMonth))
      .toEqual(['2026-08', '2026-07']);
  });

  it('forwards an explicit weekly scope and a reasoned reopen without an edit lease', async () => {
    const source = fullMonthCloseSource();
    const fetchImpl = vi.fn(async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : {};
      if (init.method === 'GET' && url.includes('/weekly-update-complete?')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            ok: true, projectId: 'project-a', yearMonth: '2026-06', weekNo: 2,
            status: 'LOCKED', revision: 1,
          }),
        };
      }
      if (url.endsWith('/api/v1/cashflow/project-a/weekly-update-complete/reopen')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            ok: true, projectId: 'project-a', yearMonth: body.yearMonth, weekNo: body.weekNo,
            status: 'OPEN', revision: 2, reopenReason: body.reason,
          }),
        };
      }
      if (url.endsWith('/api/v1/cashflow/project-a/weekly-update-complete/confirm')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            ok: true, projectId: 'project-a', yearMonth: body.yearMonth, weekNo: body.weekNo,
            status: 'LOCKED', revision: body.expectedRevision + 1,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true, projectId: 'project-a', yearMonth: body.yearMonth, weekNo: body.weekNo,
          status: 'LOCKED', revision: 1,
        }),
      };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'viewer' }, { env: runtimeEnv, db: source.db });

    await request(app)
      .get('/api/v1/cashflow/project-a/weekly-update-complete?yearMonth=2026-06&weekNo=2')
      .expect(200)
      .expect((response) => expect(response.body).toMatchObject({
        yearMonth: '2026-06', weekNo: 2, status: 'LOCKED', revision: 1,
      }));

    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete')
      .send({ yearMonth: '2026-06', weekNo: 2, updateResult: 'CHANGED' })
      .expect(200)
      .expect((response) => expect(response.body).toMatchObject({
        yearMonth: '2026-06', weekNo: 2, status: 'LOCKED', revision: 1,
      }));

    source.documents.set('orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-06-w2', {
      projectId: 'project-a', yearMonth: '2026-06', weekNo: 2, status: 'LOCKED', revision: 1,
    });
    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete/reopen')
      .send({ yearMonth: '2026-06', weekNo: 2, expectedRevision: 1, reason: '긴급 정정' })
      .expect(200)
      .expect((response) => expect(response.body).toMatchObject({
        yearMonth: '2026-06', weekNo: 2, status: 'OPEN', revision: 2, reopenReason: '긴급 정정',
      }));

    const completeCall = fetchImpl.mock.calls.find(([url]) => url.endsWith('/weekly-update-complete'));
    expect(JSON.parse(completeCall[1].body)).toMatchObject({ yearMonth: '2026-06', weekNo: 2 });
    const reopenCall = fetchImpl.mock.calls.find(([url]) => url.endsWith('/weekly-update-complete/reopen'));
    expect(reopenCall[1].headers).not.toHaveProperty('x-edit-session-id');
    expect(JSON.parse(reopenCall[1].body)).toMatchObject({
      yearMonth: '2026-06', weekNo: 2, expectedRevision: 1, reason: '긴급 정정',
    });

    // 회수(사유 없음): 완료 요청(SUBMITTED) 상태. 화면은 revision 을 모른다. BFF 가 완료 기록에서 읽어 JVM 낙관적 잠금에 넘긴다.
    source.documents.set('orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-06-w3', {
      projectId: 'project-a', yearMonth: '2026-06', weekNo: 3, status: 'SUBMITTED', revision: 4,
    });
    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete/reopen')
      .send({ yearMonth: '2026-06', weekNo: 3 })
      .expect(200)
      .expect((response) => expect(response.body).toMatchObject({ yearMonth: '2026-06', weekNo: 3, status: 'OPEN' }));
    const withdrawCall = fetchImpl.mock.calls.filter(([url]) => url.endsWith('/weekly-update-complete/reopen')).at(-1);
    const withdrawBody = JSON.parse(withdrawCall[1].body);
    expect(withdrawBody).toMatchObject({ yearMonth: '2026-06', weekNo: 3, expectedRevision: 4 });
    expect(withdrawBody).not.toHaveProperty('reason');
    // 확정(LOCKED) 된 주는 사유 없이 못 되돌린다.
    source.documents.set('orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-06-w5', {
      projectId: 'project-a', yearMonth: '2026-06', weekNo: 5, status: 'LOCKED', revision: 2,
    });
    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete/reopen')
      .send({ yearMonth: '2026-06', weekNo: 5 })
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('cashflow_weekly_reopen_reason_required'));
    // 완료 요청된 적 없는 주는 되돌릴 수 없다.
    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete/reopen')
      .send({ yearMonth: '2026-06', weekNo: 4 })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_weekly_reopen_not_locked'));
    // 확정: 완료 요청된 주만, revision 은 BFF 가 읽어 넘긴다.
    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete/confirm')
      .send({ yearMonth: '2026-06', weekNo: 5 })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_weekly_confirm_not_submitted'));
    source.documents.set('orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-06-w3', {
      projectId: 'project-a', yearMonth: '2026-06', weekNo: 3, status: 'SUBMITTED', revision: 4,
    });
    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete/confirm')
      .send({ yearMonth: '2026-06', weekNo: 3 })
      .expect(200);
    const confirmCall = fetchImpl.mock.calls.find(([url]) => url.endsWith('/weekly-update-complete/confirm'));
    expect(JSON.parse(confirmCall[1].body)).toMatchObject({ yearMonth: '2026-06', weekNo: 3, expectedRevision: 4 });
  });

  it('does not count a reopened weekly completion as settled', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/cashflow_sheet_stage_runs/tracking-start', {
      projectId: 'project-a', status: 'APPLIED', appliedAt: '2026-07-06T10:00:00+09:00',
    });
    source.documents.set('orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3', {
      projectId: 'project-a', yearMonth: '2026-07', weekNo: 3, status: 'OPEN',
      completedAt: '2026-07-16T09:00:00+09:00', reopenedAt: '2026-07-16T10:00:00+09:00',
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-07-16T09:00:00.000Z'),
      weeklyComplianceResponse: {
        items: [{
          yearMonth: '2026-07', weekNo: 3, deadline: '2026-07-17T00:00:00+09:00', status: 'PENDING',
          completedAt: null, completedBy: null, operationId: '', auditId: '', updateResult: '',
        }],
        nextCursor: '', onTimeCount: 0, missedCount: 0,
      },
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => expect(response.body.dashboard.deadlineSummary.current).toMatchObject({
        yearMonth: '2026-07', weekNo: 3, status: 'PENDING', completedAt: null,
      }));
  });

  it('counts ON_TIME and COMPLETED_LATE as completed without changing JVM compliance counts', async () => {
    const source = fullMonthCloseSource();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      weeklyComplianceResponse: {
        items: [
          { yearMonth: '2026-06', weekNo: 1, status: 'ON_TIME', completedAt: '2026-06-05T00:00:00+09:00' },
          { yearMonth: '2026-06', weekNo: 2, status: 'COMPLETED_LATE', completedAt: '2026-06-13T00:00:00+09:00' },
          { yearMonth: '2026-06', weekNo: 3, status: 'MISSED', completedAt: null },
          { yearMonth: '2026-06', weekNo: 4, status: 'PENDING', completedAt: null },
        ],
        nextCursor: '',
        onTimeCount: 1,
        missedCount: 2,
      },
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => expect(response.body.dashboard.deadlineSummary).toMatchObject({
        onTimeCount: 1,
        missedCount: 2,
        completedCount: 2,
      }));
  });

  it('rejects incomplete weekly scopes before the JVM and preserves a JVM lock conflict', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({
        code: 'weekly_expense_conflict',
        message: 'Cashflow week is locked: 2026-06 2주차.',
      }),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'viewer' }, {
      env: runtimeEnv,
      db: fullMonthCloseSource().db,
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/weekly-update-complete?yearMonth=2026-06&weekNo=6')
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('cashflow_weekly_update_scope_invalid'));
    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete')
      .send({ yearMonth: '2026-06' })
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('cashflow_weekly_update_scope_invalid'));
    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete')
      .send({ yearMonth: '' })
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('cashflow_weekly_update_scope_invalid'));
    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete/reopen')
      .send({ yearMonth: '2026-06', weekNo: 9 })
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('cashflow_weekly_reopen_request_invalid'));
    expect(fetchImpl).not.toHaveBeenCalled();

    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete')
      .send({ yearMonth: '2026-06', weekNo: 2, updateResult: 'CHANGED' })
      .expect(409)
      .expect((response) => expect(response.body).toMatchObject({
        code: 'weekly_expense_conflict',
        message: '요청을 처리할 수 없습니다. 최신 상태와 입력 내용을 확인해 주세요.',
      }));
  });

  it('preserves a JVM weekly settlement outage code and 503 status', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({
        code: 'cashflow_weekly_completion_backend_unavailable',
        message: 'Cashflow weekly completion backend is unavailable.',
      }),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'viewer' }, {
      env: runtimeEnv,
      db: fullMonthCloseSource().db,
    });

    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete')
      .send({ yearMonth: '2026-06', weekNo: 2, updateResult: 'NO_CHANGES' })
      .expect(503)
      .expect((response) => expect(response.body).toMatchObject({
        code: 'cashflow_weekly_completion_backend_unavailable',
        message: expect.stringContaining('처리하지 못했습니다'),
      }));
  });

  it('passes updateResult and JVM 16-week missing-cell evidence without recalculating it', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body.updateResult).toBe('NO_CHANGES');
      expect(body).toMatchObject({
        ignoreProjectionValidation: false,
        projectionValidationEvidenceHash: '',
        projectionValidationIssueCount: 0,
      });
      return {
        ok: false,
        status: 409,
        text: async () => JSON.stringify({
          code: 'cashflow_projection_window_incomplete',
          message: 'Projection window is incomplete.',
          details: {
            requiredWeekCount: 16,
            requiredCellCount: 256,
            missingCells: [{ yearMonth: '2026-05', weekNo: 1, lineId: 'SALES_IN' }],
          },
        }),
      };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'viewer' }, {
      env: runtimeEnv, db: fullMonthCloseSource().db,
    });
    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete')
      .set('idempotency-key', 'weekly-no-changes')
      .send({
        yearMonth: '2026-06', weekNo: 2, updateResult: 'NO_CHANGES',
        projectionValidationEvidenceHash: `sha256:${'f'.repeat(64)}`,
        projectionValidationIssueCount: 42,
      })
      .expect(409)
      .expect((response) => expect(response.body).toMatchObject({
        code: 'cashflow_projection_window_incomplete',
        details: {
          requiredWeekCount: 16, requiredCellCount: 256,
          missingCells: [{ yearMonth: '2026-05', weekNo: 1, lineId: 'SALES_IN' }],
        },
      }));
  });

  it('forwards an explicit projection validation override and its evidence to JVM', async () => {
    const evidenceHash = `sha256:${'a'.repeat(64)}`;
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(JSON.parse(init.body)).toMatchObject({
        updateResult: 'CHANGED',
        ignoreProjectionValidation: true,
        projectionValidationEvidenceHash: evidenceHash,
        projectionValidationIssueCount: 32,
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ projectId: 'project-a', yearMonth: '2026-06', weekNo: 2, status: 'LOCKED' }),
      };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'viewer' }, {
      env: runtimeEnv, db: fullMonthCloseSource().db,
    });
    await request(app)
      .post('/api/v1/cashflow/project-a/weekly-update-complete')
      .send({
        yearMonth: '2026-06', weekNo: 2, updateResult: 'CHANGED',
        ignoreProjectionValidation: true,
        projectionValidationEvidenceHash: evidenceHash,
        projectionValidationIssueCount: 32,
      })
      .expect(200);
  });

  it('adapts the canonical JVM weekly compliance cursor page and validates its query', async () => {
    const canonical = {
      items: [{
        yearMonth: '2026-06', weekNo: 2, deadline: '2026-06-11T23:59:59+09:00', status: 'ON_TIME',
        completedAt: '2026-06-11T08:00:00Z', completedBy: 'pm-1', operationId: 'op-1', auditId: 'audit-1',
        updateResult: 'CHANGED',
      }],
      nextCursor: 'opaque-next', onTimeCount: 7, missedCount: 2,
    };
    const fetchImpl = vi.fn(async (url) => {
      expect(url.endsWith('/weekly-update-compliance?limit=25&cursor=opaque%2Fcursor')).toBe(true);
      return { ok: true, status: 200, text: async () => JSON.stringify(canonical) };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), { actorRole: 'auditor' }, {
      env: runtimeEnv, forwardWeeklyComplianceFetch: true,
    });
    await request(app)
      .get('/api/v1/cashflow/project-a/weekly-update-compliance?limit=25&cursor=opaque%2Fcursor')
      .expect(200)
      // 라벨은 BFF 가 붙인다. 화면이 자기 표를 들고 있다가 대시보드와 어긋났던 자리.
      .expect((response) => expect(response.body).toEqual({
        ...canonical,
        items: [{ ...canonical.items[0], statusLabel: '기한 내 완료' }],
      }));
    await request(app)
      .get('/api/v1/cashflow/project-a/weekly-update-compliance?limit=0')
      .expect(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('proxies canonical applied cell changes without collapsing EMPTY and ZERO', async () => {
    const canonical = {
      items: [{
        eventId: 'event-1', cellId: 'event-1:0', projectId: 'project-a', yearMonth: '2026-08', weekNo: 1,
        mode: 'actual', lineId: 'SALES_IN', beforeHadValue: false, beforeState: 'EMPTY', beforeAmount: null,
        afterHadValue: true, afterState: 'ZERO', afterAmount: 0, actorUid: 'pm-1', actorName: 'PM', actorEmail: 'pm@example.com',
        reason: 'confirmed', source: 'monthly-shard', operationType: 'BATCH_APPLY', operationId: 'op-1', auditId: 'audit-1',
        sourceRevision: 'r1', targetRevision: 'r2', createdAt: '2026-07-30T02:00:01Z',
      }],
      nextCursor: 'opaque-next',
    };
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url.endsWith('/applied-cell-changes?limit=25&cursor=opaque%2Fcursor')).toBe(true);
      expect(new Headers(init.headers).get('x-tenant-id')).toBe('tenant-a');
      expect(new Headers(init.headers).get('x-actor-id')).toBe('pm-1');
      return new Response(JSON.stringify(canonical), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const { app } = createApp(fetchImpl);
    await request(app)
      .get('/api/v1/cashflow/project-a/applied-cell-changes?limit=25&cursor=opaque%2Fcursor')
      .expect(200)
      .expect((response) => expect(response.body).toEqual(canonical));
    await request(app).get('/api/v1/cashflow/project-a/applied-cell-changes?limit=0').expect(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries applied cell history transport failures and preserves JVM errors', async () => {
    const retryFetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], nextCursor: '' }), { status: 200 }));
    const retryApp = createApp(retryFetch).app;
    await request(retryApp).get('/api/v1/cashflow/project-a/applied-cell-changes').expect(200);
    expect(retryFetch).toHaveBeenCalledTimes(2);

    const deniedApp = createApp(vi.fn(async () => new Response(JSON.stringify({ code: 'project_forbidden', message: 'forbidden' }), { status: 403 }))).app;
    await request(deniedApp)
      .get('/api/v1/cashflow/project-a/applied-cell-changes')
      .expect(403)
      .expect((response) => expect(response.body.code).toBe('project_forbidden'));

    const conflictApp = createApp(vi.fn(async () => new Response(JSON.stringify({ code: 'weekly_expense_conflict', message: 'corrupt evidence' }), { status: 409 }))).app;
    await request(conflictApp)
      .get('/api/v1/cashflow/project-a/applied-cell-changes')
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('weekly_expense_conflict'));
  });

  it('enforces applied cell history role and tenant context before JVM access', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: '' }), { status: 200 }));
    await request(createApp(fetchImpl, createIdempotencyService(), { actorRole: 'external' }).app)
      .get('/api/v1/cashflow/project-a/applied-cell-changes')
      .expect(403);
    await request(createApp(fetchImpl, createIdempotencyService(), { tenantId: '' }).app)
      .get('/api/v1/cashflow/project-a/applied-cell-changes')
      .expect(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns the four PPT 38 management checks from canonical server values', () => {
    const { documents } = fullMonthCloseSource();
    const draft = [...documents.values()].find((value) => value?.resourceType === 'cashflow');
    const project = documents.get('orgs/tenant-a/projects/project-a');
    const checks = buildCashflowManagementChecks({
      project,
      cashflow: { readModel: { months: [] } },
      cells: draft.payload.monthClose.cells,
      yearMonth: '2026-06',
      depositScheduleRows: draft.payload.monthClose.depositScheduleRows,
      comparisonBoundary: { asOfWeek: { yearMonth: '2026-07', weekNo: 2 } },
      weeklyYear: 2026,
      monthState: 'MONTH_CELLS',
    });

    expect(checks).toHaveLength(4);
    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ['labor-transfer', 'WARNING'],
      ['profit-vat-after-deposit', 'OK'],
      ['negative-projection-balance', 'WARNING'],
      ['future-prepay-over-million', 'OK'],
    ]);
    expect(checks[0].detail).toContain('일부 이관');
  });

  it('flags missing labor, post-deposit transfer, negative balance, and future prepay on the server', () => {
    const { documents } = fullMonthCloseSource();
    const draft = [...documents.values()].find((value) => value?.resourceType === 'cashflow');
    const cells = draft.payload.monthClose.cells.map((cell) => (
      cell.mode === 'actual' && cell.weekNo === 3 && cell.cashflowLine === 'MYSC_LABOR_OUT' ? { ...cell, amount: 0 } : cell
    )).map((cell) => (
      cell.mode === 'projection' && cell.weekNo === 5 && ['MYSC_PROFIT_OUT', 'SALES_VAT_OUT'].includes(cell.cashflowLine)
        ? { ...cell, amount: 0 }
        : cell
    ));
    const depositScheduleRows = draft.payload.monthClose.depositScheduleRows.map((row) => (
      row.weekNo === 5
        ? { ...row, actualDepositDate: '2026-06-30', actualDepositAmount: 1_000_000, actualSource: 'SHEET' }
        : row
    ));
    const juneMonth = {
      yearMonth: '2026-06',
      projection: {
        weeks: Array.from({ length: 5 }, (_, index) => ({
          weekNo: index + 1,
          amounts: Object.fromEntries(cells
            .filter((cell) => cell.mode === 'projection' && cell.weekNo === index + 1)
            .map((cell) => [cell.cashflowLine, cell.amount])),
        })),
      },
      actual: {
        weeks: Array.from({ length: 5 }, (_, index) => ({
          weekNo: index + 1,
          amounts: Object.fromEntries(cells
            .filter((cell) => cell.mode === 'actual' && cell.weekNo === index + 1)
            .map((cell) => [cell.cashflowLine, cell.amount])),
        })),
      },
    };
    const checks = buildCashflowManagementChecks({
      project: {},
      cashflow: {
        readModel: {
          months: [juneMonth, {
            yearMonth: '2026-08',
            projection: { weeks: [{ weekNo: 1, amounts: { MYSC_PREPAY_IN: 1_000_001 } }] },
            actual: { weeks: [] },
          }],
        },
      },
      cells,
      yearMonth: '2026-06',
      depositScheduleRows,
      comparisonBoundary: { asOfWeek: { yearMonth: '2026-07', weekNo: 2 } },
      weeklyYear: 2026,
      monthState: 'LIVE_CURRENT',
    });

    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ['labor-transfer', 'WARNING'],
      ['profit-vat-after-deposit', 'WARNING'],
      ['negative-projection-balance', 'WARNING'],
      ['future-prepay-over-million', 'WARNING'],
    ]);
    expect(checks[1].detail).toContain('2026-06 5주차에 매출입금이 있으나 [MYSC 수익·매출부가세] 계획이 Projection에 없습니다.');
    expect(checks[0].detail).toContain('실제 0원 · 실제 미이관');
    expect(checks[0].findings).toContain('2026-06 3주차 · 예정 10원 · 실제 0원 · 실제 미이관');
    expect(checks[0].findings).toContain('2026-08 3주차 인건비 미입력');
    expect(checks[2].findings).toHaveLength(5);
    expect(checks[2].findings[0]).toContain('2026-06 1주차');
    expect(checks[2].findings.at(-1)).toContain('2026-06 5주차');
    expect(checks[3].detail).toContain('1,000,001원');
  });

  it('prioritizes an empty third-week Projection over an explicit zero amount', () => {
    const { documents } = fullMonthCloseSource();
    const draft = [...documents.values()].find((value) => value?.resourceType === 'cashflow');
    const cells = draft.payload.monthClose.cells.map((cell) => (
      cell.mode === 'projection' && cell.weekNo === 3 && cell.cashflowLine === 'MYSC_LABOR_OUT'
        ? { ...cell, cellState: 'EMPTY' }
        : cell
    ));
    const checks = buildCashflowManagementChecks({
      cashflow: { readModel: { months: [] } },
      cells,
      yearMonth: '2026-06',
      depositScheduleRows: [],
      comparisonBoundary: { asOfWeek: { yearMonth: '2026-07', weekNo: 2 } },
      weeklyYear: 2026,
      monthState: 'MONTH_CELLS',
    });

    expect(checks.find((check) => check.id === 'labor-transfer')).toEqual({
      id: 'labor-transfer',
      status: 'WARNING',
      title: 'MYSC 인건비 이관',
      detail: '2026-06 3주차 인건비 미입력',
      findings: ['2026-06 3주차 인건비 미입력'],
    });
  });

  it('uses the same simple finding for an explicit-zero third-week Projection labor plan', () => {
    const { documents } = fullMonthCloseSource();
    const draft = [...documents.values()].find((value) => value?.resourceType === 'cashflow');
    const cells = draft.payload.monthClose.cells.map((cell) => (
      cell.mode === 'projection' && cell.weekNo === 3 && cell.cashflowLine === 'MYSC_LABOR_OUT'
        ? { ...cell, cellState: 'ZERO', amount: 0 }
        : cell
    ));
    const checks = buildCashflowManagementChecks({
      cashflow: { readModel: { months: [] } },
      cells,
      yearMonth: '2026-06',
      depositScheduleRows: [],
      comparisonBoundary: { asOfWeek: { yearMonth: '2026-07', weekNo: 2 } },
      weeklyYear: 2026,
      monthState: 'MONTH_CELLS',
    });

    expect(checks.find((check) => check.id === 'labor-transfer')).toEqual({
      id: 'labor-transfer',
      status: 'REVIEW_REQUIRED',
      title: 'MYSC 인건비 이관',
      detail: '2026-06 3주차 인건비 미입력',
      findings: ['2026-06 3주차 인건비 미입력'],
    });
  });

  it('names the exact missing Projection plans after each sales deposit', () => {
    const checks = buildCashflowManagementChecks({
      cashflow: {
        readModel: {
          months: [{
            yearMonth: '2026-07',
            projection: { weeks: [
              { weekNo: 1, amounts: { SALES_IN: 1_000 } },
              { weekNo: 2, amounts: {} },
              { weekNo: 3, amounts: { SALES_IN: 2_000, MYSC_PROFIT_OUT: 100 } },
              { weekNo: 4, amounts: {} },
            ] },
            actual: { weeks: [] },
          }],
        },
      },
      cells: [],
      yearMonth: '2026-07',
      depositScheduleRows: [],
      comparisonBoundary: { asOfWeek: { yearMonth: '2026-07', weekNo: 4 } },
      weeklyYear: 2026,
      monthState: 'LIVE_CURRENT',
    });

    expect(checks.find((check) => check.id === 'profit-vat-after-deposit')?.findings).toEqual([
      '2026-07 1주차에 매출입금이 있으나 [MYSC 수익·매출부가세] 계획이 Projection에 없습니다.',
      '2026-07 3주차에 매출입금이 있으나 [매출부가세] 계획이 Projection에 없습니다.',
    ]);
  });

  it('does not warn when profit and sales VAT are planned in either the deposit week or the next week', () => {
    const checks = buildCashflowManagementChecks({
      cashflow: {
        readModel: {
          months: [{
            yearMonth: '2026-07',
            projection: { weeks: [
              { weekNo: 1, amounts: { SALES_IN: 1_000, MYSC_PROFIT_OUT: 100, SALES_VAT_OUT: 10 } },
              { weekNo: 2, amounts: { SALES_IN: 2_000 } },
              { weekNo: 3, amounts: { MYSC_PROFIT_OUT: 200, SALES_VAT_OUT: 20 } },
            ] },
            actual: { weeks: [] },
          }],
        },
      },
      cells: [],
      yearMonth: '2026-07',
      depositScheduleRows: [],
      comparisonBoundary: { asOfWeek: { yearMonth: '2026-07', weekNo: 3 } },
      weeklyYear: 2026,
      monthState: 'LIVE_CURRENT',
    });

    const transferCheck = checks.find((check) => check.id === 'profit-vat-after-deposit');
    expect(transferCheck).toMatchObject({
      status: 'OK',
      title: '입금 후 MYSC 수익·매출부가세 이관(해당 주, 차주)',
    });
    expect(transferCheck).not.toHaveProperty('findings');
  });

  it('monitors labor and post-deposit transfers across the full pinned project period', () => {
    const { documents } = fullMonthCloseSource();
    const mirror = documents.get('orgs/tenant-a/cashflow_sheet_mirrors/project-a');
    const juneCells = mirror.cells.map((cell) => (
      cell.mode === 'actual' && cell.weekNo === 3 && cell.lineId === 'MYSC_LABOR_OUT'
        ? { ...cell, amount: 10 }
        : cell
    ));
    const julyCells = juneCells.map((cell) => ({
      ...cell,
      yearMonth: '2026-07',
      state: cell.mode === 'projection' && cell.weekNo === 3 && cell.lineId === 'MYSC_LABOR_OUT' ? 'EMPTY' : cell.state,
      amount: cell.mode === 'projection' && [1, 2].includes(cell.weekNo) && ['MYSC_PROFIT_OUT', 'SALES_VAT_OUT'].includes(cell.lineId) ? 0 : cell.amount,
    }));
    const currentCells = juneCells.map(({ lineId, state, yearMonth: _yearMonth, direction: _direction, ...cell }) => ({
      ...cell, cashflowLine: lineId, cellState: state,
    }));
    const checks = buildCashflowManagementChecks({
      cashflow: { readModel: { months: [] } },
      cells: currentCells,
      yearMonth: '2026-06',
      pinnedSheetCells: [...juneCells, ...julyCells],
      depositScheduleRows: [{
        yearMonth: '2026-07', weekNo: 1, actualDepositDate: '2026-07-01', actualDepositAmount: 1_000_000,
      }],
      comparisonBoundary: { asOfWeek: { yearMonth: '2026-08', weekNo: 3 } },
      weeklyYear: 2026,
      monthState: 'FROZEN_COMPLETE',
    });

    expect(checks.find((check) => check.id === 'labor-transfer')?.detail).toContain('2026-07 3주차 인건비 미입력');
    expect(checks.find((check) => check.id === 'profit-vat-after-deposit')?.detail).toContain('2026-07 1주차에 매출입금이 있으나 [MYSC 수익·매출부가세] 계획이 Projection에 없습니다.');
  });

  it('excludes an out-of-coordinate JVM ledger month from management checks', () => {
    const { documents } = fullMonthCloseSource();
    const mirror = documents.get('orgs/tenant-a/cashflow_sheet_mirrors/project-a');
    const pinnedSheetCells = mirror.cells.map((cell) => ({
      ...cell,
      amount: cell.lineId === 'MYSC_PREPAY_IN' || cell.lineId === 'DIRECT_COST_OUT' ? 100 : 0,
    }));
    const cells = pinnedSheetCells.map(({ lineId, state, yearMonth: _yearMonth, direction: _direction, ...cell }) => ({
      ...cell,
      cashflowLine: lineId,
      cellState: state,
    }));
    const checks = buildCashflowManagementChecks({
      project: {},
      cashflow: {
        readModel: {
          months: [{
            yearMonth: '2024-09',
            projection: { weeks: [{ weekNo: 2, amounts: { DIRECT_COST_OUT: 1_293_296 } }] },
            actual: { weeks: [] },
          }],
        },
      },
      cells,
      yearMonth: '2026-06',
      pinnedSheetCells,
      depositScheduleRows: [],
      comparisonBoundary: { asOfWeek: { yearMonth: '2026-06', weekNo: 5 } },
      weeklyYear: 2026,
      monthState: 'LIVE_CURRENT',
    });

    const negative = checks.find((check) => check.id === 'negative-projection-balance');
    expect(negative).toMatchObject({
      id: 'negative-projection-balance',
      status: 'OK',
      title: 'Projection 잔액 마이너스',
    });
    expect(negative).not.toHaveProperty('findings');
  });

  it.each([
    ['weeklyYear', undefined, 'LIVE_CURRENT'],
    ['monthState', 2025, undefined],
  ])('does not read p1773651024850-2025-12-w4 when %s is missing', (_missing, weeklyYear, monthState) => {
    const checks = buildCashflowManagementChecks({
      cashflow: {
        readModel: {
          months: [{
            yearMonth: '2025-12',
            projection: { weeks: [{ weekNo: 4, amounts: { DIRECT_COST_OUT: 1_773_651_024_850 } }] },
            actual: { weeks: [] },
          }],
        },
      },
      cells: [],
      yearMonth: '2025-12',
      depositScheduleRows: [],
      comparisonBoundary: { asOfWeek: { yearMonth: '2025-12', weekNo: 4 } },
      weeklyYear,
      monthState,
    });

    expect(checks.find((check) => check.id === 'negative-projection-balance')).toMatchObject({
      status: 'OK',
      detail: 'Projection 누적 잔액이 0원 이상입니다.',
    });
  });

  it('starts the negative Projection check from the prior-year opening balance', () => {
    const checks = buildCashflowManagementChecks({
      cashflow: {
        readModel: {
          months: [{
            yearMonth: '2026-01',
            projection: { weeks: [{ weekNo: 1, amounts: { DIRECT_COST_OUT: 2_000_000 } }] },
            actual: { weeks: [] },
          }],
        },
      },
      cells: [],
      yearMonth: '2026-01',
      depositScheduleRows: [],
      projectionOpeningBalance: 2_000_000,
      comparisonBoundary: { asOfWeek: { yearMonth: '2026-01', weekNo: 5 } },
      weeklyYear: 2026,
      monthState: 'LIVE_CURRENT',
    });

    expect(checks.find((check) => check.id === 'negative-projection-balance')).toMatchObject({
      status: 'OK',
      detail: 'Projection 누적 잔액이 0원 이상입니다.',
    });
  });

  it('uses JVM opening balances and exposes stored annual columns without weekly reconstruction', async () => {
    const { db, documents } = fullMonthCloseSource();
    documents.get('orgs/tenant-a/projects/project-a').contractStart = '2025-01-01';
    documents.get('orgs/tenant-a/projects/project-a').contractEnd = '2026-12-31';
    const mirror = documents.get('orgs/tenant-a/cashflow_sheet_mirrors/project-a');
    mirror.appliedAnnualYears = [2025];
    mirror.appliedWeeklyYears = [2026];
    const missingAnnualId = Buffer.from('project-a\n2024', 'utf8').toString('base64url');
    documents.delete(`orgs/tenant-a/cashflow_sheet_year_totals/${missingAnnualId}`);
    const annualId = Buffer.from('project-a\n2025', 'utf8').toString('base64url');
    documents.set(`orgs/tenant-a/cashflow_sheet_year_totals/${annualId}`, {
      projectId: 'project-a',
      year: 2025,
      projection: { SALES_IN: 9_000_000 },
      projectionStates: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, lineId === 'SALES_IN' ? 'VALUE' : 'EMPTY'])),
      actual: { SALES_IN: 8_000_000 },
      actualStates: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, lineId === 'SALES_IN' ? 'VALUE' : 'EMPTY'])),
    });
    const jvmOpeningBalances = {
      selectedYear: 2026,
      projection: annualOpeningMode('SALES_IN', 2_000_000),
      actual: annualOpeningMode('SALES_IN', 1_800_000),
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource(
        {
          ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
          reopenCount: 0, projectWarningCount: 0, snapshot: {},
        },
        undefined,
        jvmOpeningBalances,
      )),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.openingBalances).toEqual(jvmOpeningBalances);
        expect(response.body.dashboard.canonical.weeklyYear).toBe(2026);
        expect(response.body.dashboard.canonical.annualTotals.map((row) => row.year)).toEqual([
          2025, 2027, 2028, 2029, 2030, 2031, 2032,
        ]);
        expect(response.body.dashboard.canonical.annualTotals[0]).toMatchObject({
          year: 2025,
          projection: { lineStates: { SALES_IN: 'VALUE', BANK_INTEREST_IN: 'EMPTY' }, totalIn: null, totalOut: null, net: null },
          actual: { lineStates: { SALES_IN: 'VALUE', BANK_INTEREST_IN: 'EMPTY' }, totalIn: null, totalOut: null, net: null },
        });
        expect(response.body.dashboard.canonical.annualTotals[0].projection.lineAmounts).toEqual({ SALES_IN: 9_000_000 });
        expect(response.body.dashboard.validation.blockers).toContainEqual({
          code: 'SHEET_SOURCE_REQUIRED', message: '먼저 시트값을 불러와 주세요.',
        });
      });
  });

  it('excludes a stray annual-year week and keeps the stored annual column authoritative', async () => {
    const { db, documents } = fullMonthCloseSource();
    const annualId = Buffer.from('project-a\n2025', 'utf8').toString('base64url');
    documents.set(`orgs/tenant-a/cashflow_sheet_year_totals/${annualId}`, {
      projectId: 'project-a',
      year: 2025,
      projection: { SALES_IN: 317_449_417 },
      projectionStates: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, lineId === 'SALES_IN' ? 'VALUE' : 'EMPTY'])),
      actual: { SALES_IN: 317_449_417 },
      actualStates: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, lineId === 'SALES_IN' ? 'VALUE' : 'EMPTY'])),
    });
    const cashflow = {
      projectId: 'project-a',
      projection: [],
      actual: [],
      readModel: {
        months: [
          {
            yearMonth: '2025-12',
            projection: { weeks: [{ weekNo: 4, amounts: { SALES_IN: 7_582_243 }, net: 7_582_243 }] },
            actual: { weeks: [] },
          },
          {
            yearMonth: '2026-01',
            projection: { weeks: [{ weekNo: 2, amounts: { DIRECT_COST_OUT: 500_000 }, net: 2_500_000 }] },
            actual: { weeks: [] },
          },
        ],
      },
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      }, cashflow, projectionOpeningBalance('TEAM_SUPPORT_IN'))),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.canonical.months.map((month) => month.yearMonth)).toEqual(['2026-01']);
        expect(response.body.dashboard.canonical.annualTotals[1].projection).toMatchObject({
          lineAmounts: { SALES_IN: 317_449_417 },
          lineStates: { SALES_IN: 'VALUE' },
          totalIn: null,
          totalOut: null,
          net: null,
        });
        expect(response.body.dashboard.managementChecks.flatMap((check) => check.findings || []))
          .not.toEqual(expect.arrayContaining([expect.stringContaining('2025-12')]));
        expect(response.body.dashboard.canonical.range).toMatchObject({
          start: { yearMonth: '2026-01', weekNo: 1 },
          end: { yearMonth: '2026-12', weekNo: 5 },
          projection: { totalIn: 0, totalOut: 500_000, net: -500_000 },
        });
      });
  });

  it('keeps missing Sheet amounts unavailable instead of inventing a zero dashboard', async () => {
    const documents = new Map([
      ACTOR_MEMBER_ENTRY,
      ['orgs/tenant-a/projects/project-a', { id: 'project-a', contractAmount: 1000 }],
    ]);
    const db = {
      doc: (path) => ({
        get: async () => {
          const value = documents.get(path);
          return { exists: value !== undefined, data: () => value };
        },
      }),
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard).toMatchObject({
          source: { status: 'EMPTY' },
          cells: [],
          totals: {
            projection: { totalIn: null, totalOut: null, balance: null },
            actual: { totalIn: null, totalOut: null, balance: null },
          },
        });
        expect(response.body.dashboard.totals.projection.weeks).toEqual([]);
        expect(response.body.dashboard.totals.actual.weeks).toEqual([]);
        expect(response.body.dashboard.validation.blockers).toContainEqual(expect.objectContaining({
          code: 'SHEET_SOURCE_REQUIRED',
        }));
      });
  });

  it('keeps the dashboard readable when the mirror has no weekly-year contract', async () => {
    const { db, documents } = fullMonthCloseSource();
    delete documents.get('orgs/tenant-a/cashflow_sheet_mirrors/project-a').weeklyYear;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv, db });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.canonical).toBeNull();
        expect(response.body.dashboard.monthCloseStatuses).toBeNull();
        expect(response.body.dashboard.validation.blockers).toContainEqual({
          code: 'SHEET_SOURCE_REQUIRED',
          message: '시트에서 주별 관리 연도를 확인하지 못했습니다. 표준 양식으로 다시 불러와 주세요.',
        });
        expect(response.body.sectionErrors).toContainEqual(expect.objectContaining({
          section: 'monthCloseStatuses',
          code: 'cashflow_month_close_period_contract_unavailable',
          label: '월 결산 상태',
        }));
      });
  });

  it('bounds the month-close JVM proxy before the browser deadline', async () => {
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: createMonthCloseDb(),
      jvmWeeklyApiTimeoutMs: 5,
    });
    const startedAt = Date.now();

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(503)
      .expect((response) => expect(response.body).toMatchObject({ code: 'jvm_weekly_api_unreachable' }));

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('ignores obsolete private-draft confirmations when reading an open month', async () => {
    const { db, documents } = fullMonthCloseSource({ yearMonth: '2026-05' });
    const draft = [...documents.values()].find((value) => value?.resourceType === 'cashflow');
    const confirmations = draft.payload.monthClose.confirmations;
    confirmations[confirmations.length - 1] = { ...confirmations[0] };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.summary.confirmationProgressPercent).toBe(0);
        expect(response.body.dashboard.validation).toMatchObject({ canClose: true });
        expect(response.body.dashboard.confirmations).toEqual([]);
      });
  });

  it('shows Projection overage and keeps the zero-contract rule', async () => {
    for (const contractAmount of [100, 0]) {
      const { db } = fullMonthCloseSource({ contractAmount, yearMonth: '2026-05' });
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(monthDashboardSource({
          ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
          reopenCount: 0, projectWarningCount: 0, snapshot: {},
        })),
      }));
      const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
        env: runtimeEnv,
        db,
        now: () => new Date('2026-07-10T00:00:00.000Z'),
      });

      await request(app)
        .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
        .expect(200)
        .expect((response) => {
      expect(response.body.dashboard.summary.projectionProgressPercent).toBe(100);
        });
    }
  });

  it.each([null, '1000', Number.MAX_SAFE_INTEGER + 1])(
    'rejects a declared invalid project contract amount without publishing a zero-based summary: %p',
    async (contractAmount) => {
      const { db } = fullMonthCloseSource({ contractAmount });
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(monthDashboardSource({
          ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
          reopenCount: 0, projectWarningCount: 0, snapshot: {},
        })),
      }));
      const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
        env: runtimeEnv,
        db,
        now: () => new Date('2026-07-10T00:00:00.000Z'),
      });

      await request(app)
        .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
        .expect(502)
        .expect((response) => expect(response.body).toMatchObject({
          code: 'jvm_weekly_cashflow_totals_invalid',
        }));
    },
  );

  it.each([null, '500', Number.MAX_SAFE_INTEGER + 1])(
    'rejects a declared invalid annual line amount instead of treating the annual source as missing: %p',
    async (annualAmount) => {
      const { db, documents } = fullMonthCloseSource();
      const annualId = Buffer.from('project-a\n2027', 'utf8').toString('base64url');
      documents.set(`orgs/tenant-a/cashflow_sheet_year_totals/${annualId}`, {
        projectId: 'project-a',
        year: 2027,
        projection: { SALES_IN: annualAmount },
        projectionStates: Object.fromEntries(cashflowLineIds.map((lineId) => [
          lineId, lineId === 'SALES_IN' ? 'VALUE' : 'EMPTY',
        ])),
        actual: {},
        actualStates: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, 'EMPTY'])),
      });
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(monthDashboardSource({
          ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
          reopenCount: 0, projectWarningCount: 0, snapshot: {},
        })),
      }));
      const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
        env: runtimeEnv,
        db,
        now: () => new Date('2026-07-10T00:00:00.000Z'),
      });

      await request(app)
        .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
        .expect(502)
        .expect((response) => expect(response.body).toMatchObject({
          code: 'jvm_weekly_cashflow_totals_invalid',
        }));
    },
  );

  it('does not invent a future annual Projection total before the derived cells are stored', async () => {
    const { db, documents } = fullMonthCloseSource({ contractAmount: 1000 });
    const project = documents.get('orgs/tenant-a/projects/project-a');
    project.contractStart = '2026-01-01';
    project.contractEnd = '2027-12-31';
    const mirror = documents.get('orgs/tenant-a/cashflow_sheet_mirrors/project-a');
    mirror.appliedAnnualYears = [2027];
    mirror.appliedWeeklyYears = [2026];
    mirror.sheetFacts.annualCashflowTotals = [{
      year: 2027,
      projection: { totalIn: 999, lineAmounts: { SALES_IN: 999, SALES_VAT_IN: 0 } },
      actual: { totalIn: 0 },
    }];
    const annualId = Buffer.from('project-a\n2027', 'utf8').toString('base64url');
    documents.set(`orgs/tenant-a/cashflow_sheet_year_totals/${annualId}`, {
      projectId: 'project-a',
      year: 2027,
      projection: { SALES_IN: 500, SALES_VAT_IN: 150 },
      projectionStates: Object.fromEntries(cashflowLineIds.map((lineId) => [
        lineId, ['SALES_IN', 'SALES_VAT_IN'].includes(lineId) ? 'VALUE' : 'EMPTY',
      ])),
      actual: {},
      actualStates: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, 'EMPTY'])),
    });
    const cashflow = {
      projectId: 'project-a',
      readModel: {
        months: [{
          yearMonth: '2026-06',
          projection: { weeks: [{ weekNo: 1, amounts: { SALES_IN: 350 } }] },
          actual: { weeks: [] },
        }],
      },
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      }, cashflow)),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.summary).toMatchObject({
          projectionProgressPercent: 100,
          projectionTotalIn: null,
          projectionSalesAndVatTotal: 1000,
          contractDifference: 0,
          contractCoveragePercent: 100,
          projectionContractAmount: 1000,
          projectionYears: [
            { year: 2026, source: 'WEEKLY' },
            { year: 2027, source: 'ANNUAL', totalIn: null, salesAndVatTotal: 650 },
          ],
        });
        expect(response.body.dashboard.validation.warnings).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'CONTRACT_PROJECTION_MISMATCH' }),
        ]));
      });
  });

  it('uses the CLOSED snapshot instead of current project or mirror values', async () => {
    const current = fullMonthCloseSource({ yearMonth: '2026-05' });
    const annualId = Buffer.from('project-a\n2025', 'utf8').toString('base64url');
    current.documents.set(`orgs/tenant-a/cashflow_sheet_year_totals/${annualId}`, {
      projectId: 'project-a',
      year: 2025,
      projection: { SALES_IN: 900 },
      projectionStates: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, lineId === 'SALES_IN' ? 'VALUE' : 'EMPTY'])),
      actual: { SALES_IN: 800 },
      actualStates: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, lineId === 'SALES_IN' ? 'VALUE' : 'EMPTY'])),
    });
    const weeklyTotals = Array.from({ length: 5 }, (_, index) => ({
      weekNo: index + 1,
      projection: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, 20])),
      actual: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, 10])),
    }));
    const previousWeeklyTotals = weeklyTotals.map((week, index) => ({
      ...week,
      projection: index === 0 ? { ...week.projection, SALES_IN: 19 } : week.projection,
    }));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'CLOSED', revision: 1,
        reopenCount: 0, projectWarningCount: 0,
        previousSnapshot: { weeklyTotals: previousWeeklyTotals },
        snapshot: {
          project: { settlementType: 'TYPE5', basis: '공급가액', accountType: 'DEDICATED', contractAmount: 2000 },
          sourceFingerprint: `sha256:${'f'.repeat(64)}`,
          targetRevision: `sha256:${'a'.repeat(64)}`,
          sourceReadAt: '2026-07-09T00:00:00.000Z',
          weeklyTotals,
          ledgerWeeks: weeklyTotals.map((week) => ({
            yearMonth: '2026-06',
            weekNo: week.weekNo,
            projection: week.projection,
            actual: week.actual,
          })),
          reopenContext: { request: { reason: '입금 반영 오류 수정' }, decision: { reason: '증빙 확인 완료' } },
          depositScheduleRows: [], confirmations: [],
          sheetFacts: { metadata: { businessType: { value: 'snapshot metadata' } }, depositScheduleRows: [] },
        },
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv, db: current.db });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard).toMatchObject({
          source: { kind: 'MONTH_CLOSE_SNAPSHOT', sourceRevision: `sha256:${'f'.repeat(64)}` },
          cumulativeCloseScope: {
            fromMonth: '2023-01',
            throughMonth: '2026-05',
            monthCount: 41,
            weekCount: 205,
            cellCount: 6560,
            source: {
              sourceRevision: `sha256:${'f'.repeat(64)}`,
              targetRevision: `sha256:${'a'.repeat(64)}`,
              capturedAt: '2026-07-09T00:00:00.000Z',
              spreadsheetId: null,
              spreadsheetUrl: null,
            },
          },
          project: { settlementType: 'TYPE5', contractAmount: 2000 },
          sheetMetadata: { businessType: { value: 'snapshot metadata' } },
          sheetControlTotals: { deposit: null, unpaid: null },
          totals: {
            projection: { totalIn: 700, totalOut: 900, balance: -200 },
            actual: { totalIn: 350, totalOut: 450, balance: -100 },
          },
          canonical: {
            annualTotals: expect.arrayContaining([expect.objectContaining({
              year: 2025,
              projection: expect.objectContaining({ lineAmounts: { SALES_IN: 900 } }),
              actual: expect.objectContaining({ lineAmounts: { SALES_IN: 800 } }),
            })]),
            range: {
              projection: { totalIn: 700, totalOut: 900, net: -200 },
              actual: { totalIn: 350, totalOut: 450, net: -100 },
            },
            months: [expect.objectContaining({
              yearMonth: '2026-06',
              comparison: expect.objectContaining({ yearMonth: '2026-06' }),
            })],
          },
          validation: { canClose: false },
          postCloseAdjustment: {
            reason: '입금 반영 오류 수정',
            changedCount: 1,
            changes: [{ mode: 'projection', weekNo: 1, cashflowLine: 'SALES_IN', beforeAmount: 19, afterAmount: 20 }],
          },
        });
      });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the mirror read throws', (db, mirrorPath) => {
      const readDoc = db.doc;
      db.doc = (path) => path === mirrorPath
        ? { get: async () => { throw new Error('mirror unavailable'); } }
        : readDoc(path);
    }],
    ['the mirror is missing', (db, mirrorPath) => db.documents.delete(mirrorPath)],
    ['the mirror declares another weekly year', (db, mirrorPath) => {
      db.documents.get(mirrorPath).weeklyYear = 2031;
    }],
  ])('serves identical immutable CLOSED snapshot values when %s', async (_label, sabotageMirror) => {
    const weeklyTotals = Array.from({ length: 5 }, (_, index) => ({
      weekNo: index + 1,
      projection: { SALES_IN: index === 0 ? 321 : 0 },
      actual: { SALES_IN: index === 0 ? 123 : 0 },
    }));
    const close = {
      ok: true,
      projectId: 'project-a',
      yearMonth: '2026-06',
      status: 'CLOSED',
      revision: 1,
      reopenCount: 0,
      projectWarningCount: 0,
      snapshot: {
        project: { settlementType: 'TYPE1', contractAmount: 321 },
        sourceFingerprint: `sha256:${'f'.repeat(64)}`,
        targetRevision: `sha256:${'a'.repeat(64)}`,
        sourceReadAt: '2026-07-09T00:00:00.000Z',
        weeklyTotals,
        ledgerWeeks: weeklyTotals.map((week) => ({
          yearMonth: '2026-06',
          weekNo: week.weekNo,
          projection: week.projection,
          actual: week.actual,
        })),
        sheetFacts: {
          projectionActualDifferences: [{ yearMonth: '2026-06', weekNo: 1, amount: 198 }],
          annualCashflowTotals: [{ year: 2026, projection: { totalIn: 654 }, actual: { totalIn: 321 } }],
          cashflowGrandTotals: { projection: { totalIn: 987 }, actual: { totalIn: 654 } },
        },
        depositScheduleRows: [],
        confirmations: [],
      },
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource(close)),
    }));
    const readDashboard = async (db) => {
      const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
        env: runtimeEnv,
        db,
        now: () => new Date('2026-07-10T00:00:00.000Z'),
      });
      const response = await request(app)
        .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
        .expect(200);
      // 8초 분해를 브라우저에서 보게 한 Server-Timing. span 이름·ms 만, 본문은 그대로.
      expect(response.headers['server-timing']).toMatch(/^publication_before;dur=\d+, jvm_dashboard;dur=\d+, jvm_compliance;dur=\d+, dashboard_compose;dur=\d+, publication_after;dur=\d+, total;dur=\d+$/);
      return response.body.dashboard;
    };
    const baseline = await readDashboard(createMonthCloseDb());
    // 결산된 회차의 연간 열·총계는 닫힌 스냅샷에서 온다. 미러 상태와 무관하게 AVAILABLE 이어야
    // 화면이 값을 지우지 않는다 (예전엔 미러를 안 읽었다는 이유로 UNAVAILABLE 을 돌려줬다).
    expect(baseline.sheetFormulaValues).toMatchObject({
      status: 'AVAILABLE',
      reason: null,
      sourceRevision: `sha256:${'f'.repeat(64)}`,
      targetRevision: `sha256:${'a'.repeat(64)}`,
      annual: [{ year: 2026, projection: { totalIn: 654 }, actual: { totalIn: 321 } }],
      grandTotals: { projection: { totalIn: 987 }, actual: { totalIn: 654 } },
    });
    const sabotagedDb = createMonthCloseDb();
    sabotageMirror(sabotagedDb, 'orgs/tenant-a/cashflow_sheet_mirrors/project-a');

    expect(await readDashboard(sabotagedDb)).toEqual(baseline);
    expect(baseline.canonical).toMatchObject({
      weeklyYear: 2026,
      months: [expect.objectContaining({ yearMonth: '2026-06' })],
      range: {
        start: { yearMonth: '2026-01', weekNo: 1 },
        end: { yearMonth: '2026-12', weekNo: 5 },
      },
    });
    expect(baseline.totals).toMatchObject({
      projection: { totalIn: 321 },
      actual: { totalIn: 123 },
      difference: { totalIn: 198 },
    });
  });

  it('shows the current JVM ledger after an approved CLOSED-month amendment while preserving the original snapshot', async () => {
    const frozenWeeklyTotals = Array.from({ length: 5 }, (_, index) => ({
      weekNo: index + 1,
      projection: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, lineId === 'SALES_IN' && index === 0 ? 100 : 0])),
      actual: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, 0])),
    }));
    const currentWeeklyTotals = frozenWeeklyTotals.map((week, index) => ({
      ...week,
      projection: index === 0 ? { ...week.projection, SALES_IN: 101 } : week.projection,
    }));
    const currentReadModel = {
      months: [{
        yearMonth: '2026-05',
        projection: {
          rowTotals: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, lineId === 'SALES_IN' ? 101 : 0])),
          weeks: currentWeeklyTotals.map((week) => ({
            weekNo: week.weekNo,
            amounts: week.projection,
            totalIn: week.projection.SALES_IN,
            totalOut: 0,
            weekIn: week.projection.SALES_IN,
            weekOut: 0,
            net: 101,
          })),
          monthTotals: { totalIn: 101, totalOut: 0, net: 101 },
        },
        actual: {
          rowTotals: Object.fromEntries(cashflowLineIds.map((lineId) => [lineId, 0])),
          weeks: currentWeeklyTotals.map((week) => ({
            weekNo: week.weekNo,
            amounts: week.actual,
            totalIn: 0,
            totalOut: 0,
            weekIn: 0,
            weekOut: 0,
            net: 0,
          })),
          monthTotals: { totalIn: 0, totalOut: 0, net: 0 },
        },
      }],
    };
    const close = {
      ok: true,
      projectId: 'project-a',
      yearMonth: '2026-06',
      status: 'CLOSED',
      revision: 2,
      reopenCount: 0,
      projectWarningCount: 1,
      amendmentCount: 1,
      lastAmendmentAt: '2026-07-09T00:00:00.000Z',
      lastAmendmentByName: '보람',
      lastAmendmentReason: '시트 정정',
      lastAmendmentEvidence: {
        closeRevision: 2,
        sourceRevision: `sha256:${'1'.repeat(64)}`,
        targetRevision: `sha256:${'2'.repeat(64)}`,
        resultingTargetRevision: `sha256:${'3'.repeat(64)}`,
        calculationChecks: Array.from({ length: 10 }, (_, index) => ({
          mode: index < 5 ? 'projection' : 'actual',
          yearMonth: '2026-05',
          weekNo: (index % 5) + 1,
          reported: { depositTotal: index === 0 ? 999 : 0, withdrawalTotal: 0, balance: index === 0 ? 999 : 0 },
        })),
      },
      snapshot: {
        project: { contractAmount: 101 },
        sourceFingerprint: `sha256:${'f'.repeat(64)}`,
        sheetFacts: {
          weeklyCalculationChecks: [{
            mode: 'projection', yearMonth: '2026-05', weekNo: 1,
            reported: { depositTotal: 111, withdrawalTotal: 0, balance: 111 },
          }],
          annualCashflowTotals: [{ year: 2026, projection: { totalIn: 111 } }],
          cashflowGrandTotals: { projection: { totalIn: 111 } },
          projectionActualDifferences: [{ yearMonth: '2026-05', amount: 111 }],
        },
        weeklyTotals: frozenWeeklyTotals,
        ledgerWeeks: frozenWeeklyTotals.map((week) => ({
          yearMonth: '2026-05',
          weekNo: week.weekNo,
          projection: week.projection,
          actual: week.actual,
        })),
        depositScheduleRows: [],
        confirmations: [],
      },
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource(
        close,
        { projectId: 'project-a', projection: [], actual: [], readModel: currentReadModel },
        {
          selectedYear: 2026,
          projection: { amount: 0, lineAmounts: {}, sources: [], includedYears: [], excludedWeeklyYears: [] },
          actual: { amount: 0, lineAmounts: {}, sources: [], includedYears: [], excludedWeeklyYears: [] },
        },
        { status: 'LIVE_AMENDED', missingEvidence: [] },
      )),
    }));
    const db = createMonthCloseDb();
    const mirror = db.documents.get('orgs/tenant-a/cashflow_sheet_mirrors/project-a');
    mirror.sourceRevision = close.lastAmendmentEvidence.sourceRevision;
    mirror.appliedSourceRevision = close.lastAmendmentEvidence.sourceRevision;
    mirror.appliedTargetRevision = close.lastAmendmentEvidence.resultingTargetRevision;
    mirror.sheetFacts = {
      weeklyCalculationChecks: Array.from({ length: 10 }, (_, index) => ({
        mode: index < 5 ? 'projection' : 'actual',
        yearMonth: '2026-05',
        weekNo: (index % 5) + 1,
        reported: { depositTotal: index === 0 ? 321 : 0, withdrawalTotal: 0, balance: index === 0 ? 321 : 0 },
      })),
      annualCashflowTotals: [{ year: 2026, projection: { totalIn: 654 }, actual: { totalIn: 321 } }],
      cashflowGrandTotals: { projection: { totalIn: 987 }, actual: { totalIn: 654 } },
      projectionActualDifferences: [{ yearMonth: '2026-05', amount: 333 }],
      issues: [],
    };
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv, db });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.source.kind).toBe('MONTH_CLOSE_AMENDED_CURRENT');
        expect(response.body.dashboard.snapshotCompatibility.status).toBe('LIVE_AMENDED');
        expect(response.body.dashboard.totals.projection.totalIn).toBe(101);
        expect(response.body.dashboard.canonical.months[0].projection.weeks[0].amounts.SALES_IN).toBe(101);
        expect(response.body.dashboard.cells).toHaveLength(160);
        expect(response.body.dashboard.cells.find((cell) => (
          cell.mode === 'projection' && cell.weekNo === 1 && cell.cashflowLine === 'SALES_IN'
        ))).toMatchObject({ cellState: 'VALUE', amount: 101 });
        expect(response.body.dashboard.cells.find((cell) => (
          cell.mode === 'projection' && cell.weekNo === 1 && cell.cashflowLine === 'BANK_INTEREST_IN'
        ))).toMatchObject({ cellState: 'ZERO', amount: 0 });
        expect(response.body.dashboard.sheetCalculationChecks[0].reported.depositTotal).toBe(321);
        expect(response.body.dashboard.sheetFormulaValues).toMatchObject({
          status: 'AVAILABLE',
          reason: null,
          sourceRevision: close.lastAmendmentEvidence.sourceRevision,
          targetRevision: close.lastAmendmentEvidence.resultingTargetRevision,
          annual: [{ year: 2026, projection: { totalIn: 654 }, actual: { totalIn: 321 } }],
          grandTotals: { projection: { totalIn: 987 }, actual: { totalIn: 654 } },
          projectionActualDifferences: [{ yearMonth: '2026-05', amount: 333 }],
        });
        expect(response.body.dashboard.sheetFormulaValues.weekly[0].reported.depositTotal).toBe(321);
        expect(response.body.dashboard.source).toMatchObject({
          sourceRevision: `sha256:${'1'.repeat(64)}`,
          targetRevision: `sha256:${'3'.repeat(64)}`,
        });
      });
    mirror.appliedTargetRevision = `sha256:${'4'.repeat(64)}`;
    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.sheetFormulaValues).toMatchObject({
          status: 'UNAVAILABLE',
          reason: 'AMENDMENT_SHEET_FORMULA_SNAPSHOT_UNAVAILABLE',
          sourceRevision: close.lastAmendmentEvidence.sourceRevision,
          targetRevision: close.lastAmendmentEvidence.resultingTargetRevision,
          weekly: [], annual: [], grandTotals: {}, projectionActualDifferences: [],
        });
      });
    mirror.appliedTargetRevision = close.lastAmendmentEvidence.resultingTargetRevision;
    delete mirror.sheetFacts;
    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.sheetFormulaValues).toMatchObject({
          status: 'UNAVAILABLE',
          reason: 'AMENDMENT_SHEET_FORMULA_SNAPSHOT_UNAVAILABLE',
          weekly: [], annual: [], grandTotals: {}, projectionActualDifferences: [],
        });
      });
    currentReadModel.months = [];
    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.cells).toHaveLength(160);
        expect(response.body.dashboard.cells.every((cell) => cell.cellState === 'EMPTY')).toBe(true);
        expect(response.body.dashboard.totals.projection.totalIn).toBe(0);
      });
    expect(close.snapshot.weeklyTotals[0].projection.SALES_IN).toBe(100);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('serves a legacy CLOSED snapshot as evidence-only without falling back to live ledger data', async () => {
    const legacyMonthClose = {
      ok: true,
      projectId: 'project-a',
      yearMonth: '2026-06',
      status: 'CLOSED',
      revision: 1,
      reopenCount: 0,
      projectWarningCount: 0,
      snapshot: {
        project: { contractAmount: 1000 },
        weeklyTotals: [{
          weekNo: 1,
          projection: { SALES_IN: 1000 },
          actual: { SALES_IN: 900 },
        }],
      },
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource(
        legacyMonthClose,
        null,
        null,
        { status: 'LEGACY_EVIDENCE_ONLY', missingEvidence: ['OPENING_BALANCES', 'LEDGER_WEEKS'] },
      )),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv, db: createMonthCloseDb() });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.openingBalances).toBeNull();
        expect(response.body.dashboard.canonical).toBeNull();
        expect(response.body.dashboard.snapshotCompatibility).toEqual({
          status: 'LEGACY_EVIDENCE_ONLY',
          missingEvidence: ['OPENING_BALANCES', 'LEDGER_WEEKS'],
        });
        expect(response.body.dashboard.totals.projection.weeks[0]).toMatchObject({ weekNo: 1, totalIn: 1000 });
        expect(response.body.dashboard.validation.warnings).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'LEGACY_CLOSE_EVIDENCE_LIMITED' }),
        ]));
      });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a stale sheet blocker', async () => {
    for (const source of [fullMonthCloseSource({ mirrorStatus: 'STALE' })]) {
      const fetchImpl = vi.fn(async (url) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(url.includes('/dashboard-source') ? monthDashboardSource({
          ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
          reopenCount: 0, projectWarningCount: 0, snapshot: {},
        }) : { ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'CLOSED' }),
      }));
      const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv, db: source.db });

      const read = await request(app)
        .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-07')
        .expect(200);
      expect(read.body.dashboard.validation.canClose).toBe(false);
      expect(read.body.dashboard.validation.blockers.map((item) => item.code)).toEqual(expect.arrayContaining([
        'SHEET_SOURCE_STALE',
      ]));
    }
  });

  it('asks users to apply a newly loaded revision to the MYSCube sheet', async () => {
    const source = fullMonthCloseSource({ additionalYearMonths: ['2026-05'] });
    source.documents.get('orgs/tenant-a/cashflow_sheet_mirrors/project-a').appliedSourceRevision = `sha256:${'a'.repeat(64)}`;
    const fetchImpl = vi.fn(async (url, init) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.includes('/dashboard-source')
        ? monthDashboardSource({
          ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
          reopenCount: 0, projectWarningCount: 0, snapshot: {},
        })
        : init.method === 'GET'
          ? { projectId: 'project-a', projection: [], actual: [], readModel: { months: [] } }
          : { ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'CLOSED', revision: 1, auditId: 'audit-1' }),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'pm-1', actorRole: 'pm',
    }, { env: runtimeEnv, db: source.db });

    const response = await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-07')
      .expect(200);

    expect(response.body.dashboard.validation.blockers).toContainEqual({
      code: 'SHEET_SOURCE_NOT_APPLIED',
      message: '불러온 값을 MYSCube 시트에 반영해 주세요.',
    });
    await request(app)
      .post('/api/v1/cashflow/project-a/month-close/requests')
      .set('idempotency-key', 'month-close-unapplied-request')
      .send({
        contractVersion: 'cashflow-cumulative-close-v2',
        yearMonth: '2026-07', expectedRevision: 0, expectedWorkflowRevision: 0,
        expectedApproverUid: 'finance-1', expectedProjectVersion: 0,
        expectedOpeningBalances: response.body.dashboard.openingBalances,
        closeInput: {
          ...source.closeInput, managementChecks: response.body.dashboard.managementChecks, managementConfirmations: [],
        },
      })
      .expect(409)
      .expect((result) => expect(result.body.code).toBe('cashflow_month_close_validation_failed'));
    expect(source.documents.has('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-07')).toBe(false);
  });

  it('does not create a request when the dashboard mirror is missing', async () => {
    const source = fullMonthCloseSource();
    source.documents.delete('orgs/tenant-a/cashflow_sheet_mirrors/project-a');
    const fetchImpl = vi.fn(async (url, init) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.includes('/dashboard-source')
        ? monthDashboardSource({
          ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
          reopenCount: 0, projectWarningCount: 0, snapshot: {},
        })
        : init.method === 'GET'
          ? { projectId: 'project-a', projection: [], actual: [], readModel: { months: [] } }
          : { ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'CLOSED', revision: 1, auditId: 'audit-1' }),
    }));
    const requester = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'pm-1', actorRole: 'pm',
    }, { env: runtimeEnv, db: source.db, now: () => new Date('2026-07-10T00:00:00.000Z') }).app;
    const read = await request(requester).get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-07').expect(200);

    await request(requester)
      .post('/api/v1/cashflow/project-a/month-close/requests')
      .set('idempotency-key', 'month-close-missing-mirror-request')
      .send({
        contractVersion: 'cashflow-cumulative-close-v2',
        yearMonth: '2026-07', expectedRevision: 0, expectedWorkflowRevision: 0,
        expectedApproverUid: 'finance-1', expectedProjectVersion: 0,
        expectedOpeningBalances: read.body.dashboard.openingBalances,
        closeInput: {
          ...source.closeInput, managementChecks: read.body.dashboard.managementChecks, managementConfirmations: [],
        },
      })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_month_close_validation_failed'));
    expect(source.documents.has('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-07')).toBe(false);
  });

  it('warns when the pinned sheet total does not equal its item values', async () => {
    const source = fullMonthCloseSource({ calculationMismatch: true, yearMonth: '2026-05' });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv, db: source.db });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.validation.canClose).toBe(true);
        expect(response.body.dashboard.validation.warnings).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'SHEET_CALCULATION_MISMATCH' }),
        ]));
      });
  });

  it('reports sheet reconciliation warnings before a request is staged', async () => {
    const source = fullMonthCloseSource({
      controlMatches: false, calculationMismatch: true, explicitZero: true, explicitEmpty: true,
      additionalYearMonths: ['2026-05'],
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'pm-1', actorRole: 'pm',
    }, { env: runtimeEnv, db: source.db, now: () => new Date('2026-07-10T00:00:00.000Z') });
    const read = await request(app).get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-07').expect(200);

    expect(read.body.dashboard.validation.canClose).toBe(true);
    expect(read.body.dashboard.validation.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      'SHEET_CONTROL_TOTAL_MISMATCH',
      'SHEET_CALCULATION_MISMATCH',
    ]));

  });

  it('blocks incomplete cell confirmations before creating an approval request', async () => {
    const source = fullMonthCloseSource();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'pm-1', actorRole: 'pm',
    }, { env: runtimeEnv, db: source.db, now: () => new Date('2026-07-10T00:00:00.000Z') });
    const read = await request(app).get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-07').expect(200);

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close/requests')
      .set('idempotency-key', 'month-close-incomplete-confirmations')
      .send({
        contractVersion: 'cashflow-cumulative-close-v2',
        yearMonth: '2026-07', expectedRevision: 0, expectedWorkflowRevision: 0,
        expectedApproverUid: 'finance-1', expectedProjectVersion: 0,
        expectedOpeningBalances: read.body.dashboard.openingBalances,
        closeInput: {
          ...source.closeInput,
          confirmations: source.closeInput.confirmations.slice(1),
          managementChecks: read.body.dashboard.managementChecks,
        },
      })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_month_close_confirmations_incomplete'));
  });

  it('rejects a VALUE cell with a missing amount instead of storing it as zero', async () => {
    const source = fullMonthCloseSource();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'pm-1', actorRole: 'pm',
    }, { env: runtimeEnv, db: source.db, now: () => new Date('2026-07-10T00:00:00.000Z') });
    const read = await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-07')
      .expect(200);
    const cells = source.closeInput.cells.map((cell, index) => (
      index === 0 ? { ...cell, cellState: 'VALUE', amount: null } : cell
    ));

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close/requests')
      .set('idempotency-key', 'month-close-missing-value-amount')
      .send({
        contractVersion: 'cashflow-cumulative-close-v2',
        yearMonth: '2026-07', expectedRevision: 0, expectedWorkflowRevision: 0,
        expectedApproverUid: 'finance-1', expectedProjectVersion: 0,
        expectedOpeningBalances: read.body.dashboard.openingBalances,
        closeInput: {
          ...source.closeInput,
          cells,
          managementChecks: read.body.dashboard.managementChecks,
        },
      })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_month_close_cells_incomplete'));

    expect(source.documents.has('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-07')).toBe(false);
  });

  it.each([
    ['live canonical ledger', () => monthDashboardSource(
      { ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0 },
      {
        projectId: 'project-a',
        readModel: {
          months: [{
            yearMonth: '2026-06',
            projection: { weeks: [{ weekNo: 1, amounts: { SALES_IN: null } }] },
            actual: { weeks: [] },
          }],
        },
      },
    )],
    ['frozen ledger evidence', () => monthDashboardSource(
      {
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'CLOSED', revision: 1,
        snapshot: {
          weeklyYear: 2026,
          ledgerWeeks: [{
            yearMonth: '2026-06', weekNo: 1,
            projection: { SALES_IN: null }, actual: {},
          }],
        },
      },
      null,
      undefined,
      { status: 'FROZEN_COMPLETE', missingEvidence: [] },
      undefined,
      closedCumulativeAuthority('2026-06'),
    )],
  ])('rejects a null amount from %s instead of publishing ZERO', async (_label, buildSource) => {
    const source = fullMonthCloseSource();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(buildSource()),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(502)
      .expect((response) => expect(response.body.code).toBe('jvm_weekly_cashflow_totals_invalid'));
  });

  it('marks an overflowing monthly line total unavailable instead of publishing an unsafe row total', async () => {
    const source = fullMonthCloseSource({ yearMonth: '2026-05' });
    const mirror = source.documents.get('orgs/tenant-a/cashflow_sheet_mirrors/project-a');
    mirror.cells = mirror.cells.map((cell) => {
      if (cell.mode !== 'projection') return cell;
      if (cashflowLineIds.slice(0, 7).includes(cell.lineId)) {
        if (cell.weekNo === 1 && cell.lineId === 'SALES_IN') return { ...cell, amount: Number.MAX_SAFE_INTEGER };
        if (cell.weekNo === 2 && cell.lineId === 'SALES_IN') return { ...cell, amount: 1 };
        if (cell.weekNo === 2 && cell.lineId === 'TEAM_SUPPORT_IN') return { ...cell, amount: -1 };
        return { ...cell, amount: 0 };
      }
      return cell;
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.totals.projection).toMatchObject({
          totalIn: null,
          totalOut: null,
          balance: null,
        });
        expect(response.body.dashboard.totals.projection.rowTotals).toEqual({});
        expect(response.body.dashboard.validation.blockers).toContainEqual({
          code: 'AMOUNT_OUT_OF_RANGE',
          message: '지원 범위를 넘는 금액이 있습니다.',
        });
      });
  });

  it('warns about malformed sheet values without blocking the month-close request', async () => {
    const source = fullMonthCloseSource();
    source.documents.get('orgs/tenant-a/cashflow_sheet_mirrors/project-a').sheetFacts.issues = [{
      code: 'INVALID_AMOUNT', sourceCell: 'A17',
    }];
    const fetchImpl = vi.fn(async (url, init) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.includes('/dashboard-source')
        ? monthDashboardSource({
          ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
          reopenCount: 0, projectWarningCount: 0, snapshot: {},
        })
        : init.method === 'GET'
          ? { projectId: 'project-a', projection: [], actual: [], readModel: { months: [] } }
          : { ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'CLOSED', revision: 1, auditId: 'audit-1' }),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'pm-1', actorRole: 'pm',
    }, { env: runtimeEnv, db: source.db, now: () => new Date('2026-07-10T00:00:00.000Z') });
    const read = await request(app).get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-07').expect(200);

    expect(read.body.dashboard.validation.canClose).toBe(true);
    expect(read.body.dashboard.validation.blockers.map((item) => item.code)).not.toContain('SHEET_VALUE_INVALID');
    expect(read.body.dashboard.validation.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SHEET_VALUE_INVALID',
        details: [expect.objectContaining({ sourceCell: 'A17' })],
      }),
    ]));
    const created = await request(app)
      .post('/api/v1/cashflow/project-a/month-close/requests')
      .set('idempotency-key', 'month-close-invalid-sheet-request')
      .send({
        contractVersion: 'cashflow-cumulative-close-v2',
        yearMonth: '2026-07', expectedRevision: 0, expectedWorkflowRevision: 0,
        expectedApproverUid: 'finance-1', expectedProjectVersion: 0,
        expectedOpeningBalances: read.body.dashboard.openingBalances,
        closeInput: { ...source.closeInput, managementChecks: read.body.dashboard.managementChecks, managementConfirmations: [] },
      });
    expect(created.body.code).not.toBe('cashflow_month_close_validation_failed');
  });

  it('keeps an explicit sheet zero in the complete month-close evidence', async () => {
    const source = fullMonthCloseSource({ explicitZero: true, yearMonth: '2026-05' });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv, db: source.db });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.cells).toHaveLength(160);
        expect(response.body.dashboard.cells.find((cell) => (
          cell.mode === 'projection' && cell.weekNo === 1 && cell.cashflowLine === 'SALES_IN'
        ))).toMatchObject({ cellState: 'ZERO', amount: 0 });
        expect(response.body.dashboard.validation.blockers).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'SHEET_MONTH_INCOMPLETE' }),
        ]));
      });
  });

  it('keeps an explicit zero when reading a closed month snapshot', async () => {
    const source = fullMonthCloseSource({ explicitZero: true });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'CLOSED', revision: 1,
        reopenCount: 0, projectWarningCount: 0,
        snapshot: { cells: source.closeInput.cells, weeklyTotals: [] },
      }, undefined, undefined, { status: 'LIVE_CURRENT', missingEvidence: [] })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv, db: source.db });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.cells.find((cell) => (
          cell.mode === 'projection' && cell.weekNo === 1 && cell.cashflowLine === 'SALES_IN'
        ))).toMatchObject({ cellState: 'ZERO', amount: 0 });
      });
  });

  it('requires explicit reviewed close input before forwarding a month close', async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'pm-1',
      actorRole: 'pm',
    }, { env: runtimeEnv, db: createMonthCloseDb() });

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close')
      .set('idempotency-key', 'month-close-no-input')
      .send({ yearMonth: '2026-06', expectedRevision: 0 })
      .expect(400)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_month_close_request_invalid');
      });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a same-net opening row change that happened after the user review', async () => {
    const source = fullMonthCloseSource();
    const reviewed = projectionOpeningBalance('SALES_IN');
    const current = projectionOpeningBalance('TEAM_SUPPORT_IN');
    let dashboardReadCount = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('/dashboard-source')) {
        dashboardReadCount += 1;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(monthDashboardSource({
            ok: true,
            projectId: 'project-a',
            yearMonth: '2026-07',
            status: 'OPEN',
            revision: 0,
            reopenCount: 0,
            projectWarningCount: 0,
            snapshot: {},
          }, undefined, dashboardReadCount === 1 ? reviewed : current)),
        };
      }
      throw new Error('Month close mutation must not run after opening-balance drift.');
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    const read = await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-07')
      .expect(200);
    const closeInput = {
      ...source.closeInput,
      managementChecks: read.body.dashboard.managementChecks,
    };

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close')
      .set('idempotency-key', 'month-close-opening-row-drift')
      .send({
        yearMonth: '2026-07',
        expectedRevision: 0,
        expectedWorkflowRevision: 0,
        expectedApproverUid: 'finance-1',
        expectedProjectVersion: 0,
        expectedOpeningBalances: read.body.dashboard.openingBalances,
        closeInput,
      })
      .expect(409)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_opening_balance_stale');
      });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a sparse JVM annual opening source before dashboard composition', async () => {
    const source = fullMonthCloseSource();
    const sparse = projectionOpeningBalance('SALES_IN');
    sparse.projection.sources[0].lineStates = { SALES_IN: 'VALUE' };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true,
        projectId: 'project-a',
        yearMonth: '2026-06',
        status: 'OPEN',
        revision: 0,
        reopenCount: 0,
        projectWarningCount: 0,
        snapshot: {},
      }, undefined, sparse)),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv, db: source.db });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(502)
      .expect((response) => {
        expect(response.body.code).toBe('jvm_weekly_opening_balance_invalid');
      });
  });

  // 계약 변경(2026-08-09): publication·JVM 대시보드·컴플라이언스는 서로 독립 읽기라
  // 함께 출발한다. 이전에는 publication 이 매달리면 JVM 호출이 시작되지 않는 직렬
  // 순서를 단언했지만, 그 순서가 왕복 지연을 겹겹이 쌓았다. 총 시간 보호는 라우트
  // 데드라인(504)이 그대로 담당한다.
  it('bounds slow Firestore composition inside the full month-close route deadline', async () => {
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const stalledDb = {
      doc: () => ({ get: () => new Promise(() => {}) }),
    };
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: stalledDb,
      cashflowMonthCloseRouteTimeoutMs: 20,
    });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(504)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_month_close_route_timeout');
      });
  });

  it('never starts the final JVM close mutation after the preflight deadline', async () => {
    const fetchImpl = vi.fn();
    const stalledDb = {
      doc: () => ({ get: () => new Promise(() => {}) }),
    };
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: stalledDb,
      cashflowMonthCloseRouteTimeoutMs: 30,
    });

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close')
      .set('idempotency-key', 'month-close-stalled-preflight')
      .send({
        yearMonth: '2026-07',
        expectedRevision: 0,
        expectedWorkflowRevision: 0,
        expectedOpeningBalances: { selectedYear: 2026 },
        closeInput: { yearMonth: '2026-06', humanReviewed: true },
      })
      .expect(504)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_month_close_route_timeout');
      });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a month close that has not been explicitly reviewed by a person', async () => {
    const source = fullMonthCloseSource();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv, db: source.db });
    const read = await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-07')
      .expect(200);

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close')
      .set('idempotency-key', 'month-close-human-review-required')
      .send({
        yearMonth: '2026-07',
        expectedRevision: 0,
        expectedWorkflowRevision: 0,
        expectedOpeningBalances: read.body.dashboard.openingBalances,
        closeInput: { ...source.closeInput, humanReviewed: false, managementChecks: read.body.dashboard.managementChecks },
      })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_month_close_human_review_required'));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // 프로젝트 스코프 인가는 지금까지 JVM 에만 있었다. BFF 가 Firestore 를 직접 읽는
  // 경로가 늘면서 그 비대칭이 우회 통로가 되므로 BFF 에도 같은 규칙을 세운다.
  it('blocks a scoped actor from reading a project outside their assignment', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/members/pm-1', {
      uid: 'pm-1', email: 'pm@example.com', status: 'ACTIVE', role: 'pm', projectIds: ['project-b'],
    });
    const fetchImpl = vi.fn();
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv, db: source.db });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(403)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_project_forbidden');
      });
    // JVM 까지 가기 전에 막혀야 한다 — 데이터가 프로세스 경계를 넘지 않는다.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks an inactive member even when the project is in their assignment', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/members/pm-1', {
      uid: 'pm-1', email: 'pm@example.com', status: 'DISABLED', role: 'pm', projectIds: ['project-a'],
    });
    const { app } = createApp(vi.fn(), createIdempotencyService(), {}, { env: runtimeEnv, db: source.db });
    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(403);
  });

  it.each(['admin', 'finance', 'auditor', 'tenant_admin', 'support', 'security'])(
    'lets tenant-wide role %s read without a project assignment',
    async (actorRole) => {
      const source = fullMonthCloseSource();
      source.documents.delete('orgs/tenant-a/members/pm-1');
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(monthDashboardSource({
          ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
          reopenCount: 0, projectWarningCount: 0, snapshot: {},
        })),
      }));
      const { app } = createApp(fetchImpl, createIdempotencyService(), {
        actorId: `${actorRole}-1`, actorRole, actorEmail: `${actorRole}@example.com`,
      }, { env: runtimeEnv, db: source.db });
      await request(app)
        .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
        .expect(200);
    },
  );

  it.each([
    ['missing calculation evidence', (source) => {
      delete source.documents.get('orgs/tenant-a/cashflow_sheet_mirrors/project-a').sheetFacts.weeklyCalculationChecks;
    }, 'SHEET_CALCULATION_CHECK_MISSING'],
    ['invalid control evidence', (source) => {
      source.documents.get('orgs/tenant-a/cashflow_sheet_mirrors/project-a').sheetFacts.controlTotals.projection[0].matches = null;
    }, 'SHEET_CONTROL_TOTAL_INVALID'],
  ])('warns about %s without blocking the approval request', async (_label, mutate, expectedCode) => {
    const source = fullMonthCloseSource();
    mutate(source);
    const fetchImpl = vi.fn(async (url, init) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.includes('/dashboard-source')
        ? monthDashboardSource({
          ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
          reopenCount: 0, projectWarningCount: 0, snapshot: {},
        })
        : init.method === 'GET'
          ? { projectId: 'project-a', projection: [], actual: [], readModel: { months: [] } }
          : { ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'CLOSED', revision: 1, auditId: 'audit-1' }),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'pm-1', actorRole: 'pm',
    }, { env: runtimeEnv, db: source.db, now: () => new Date('2026-07-10T00:00:00.000Z') });
    const read = await request(app).get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-07').expect(200);

    expect(read.body.dashboard.validation.canClose).toBe(true);
    expect(read.body.dashboard.validation.blockers.map((item) => item.code)).not.toContain(expectedCode);
    expect(read.body.dashboard.validation.warnings.map((item) => item.code)).toContain(expectedCode);
    const created = await request(app)
      .post('/api/v1/cashflow/project-a/month-close/requests')
      .set('idempotency-key', `invalid-close-request-${expectedCode}`)
      .send({
        contractVersion: 'cashflow-cumulative-close-v2',
        yearMonth: '2026-07', expectedRevision: 0, expectedWorkflowRevision: 0,
        expectedApproverUid: 'finance-1', expectedProjectVersion: 0,
        expectedOpeningBalances: read.body.dashboard.openingBalances,
        closeInput: { ...source.closeInput, managementChecks: read.body.dashboard.managementChecks, managementConfirmations: [] },
      });
    expect(created.body.code).not.toBe('cashflow_month_close_validation_failed');
  });

  it('does not create a request when the canonical JVM month is already closed', async () => {
    const source = fullMonthCloseSource();
    const jvmSource = monthDashboardSource(
      { ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'CLOSED', revision: 1, snapshot: {} },
      undefined,
      undefined,
      { status: 'LIVE_AMENDED', missingEvidence: [] },
    );
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(jvmSource),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv, db: source.db, now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close/requests')
      .set('idempotency-key', 'closed-month-request')
      .send({
        contractVersion: 'cashflow-cumulative-close-v2',
        yearMonth: '2026-07', expectedRevision: 1, expectedWorkflowRevision: 0,
        expectedApproverUid: 'finance-1', expectedProjectVersion: 0,
        expectedOpeningBalances: jvmSource.openingBalances,
        closeInput: { ...source.closeInput, managementChecks: emptyManagementChecks },
      })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_month_close_not_eligible'));

    expect(source.documents.has('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-07')).toBe(false);
  });

  it('does not create a request when the server dashboard validation is blocked', async () => {
    // 시트 형식 이슈는 이제 경고다. 여전히 막는 사유(시트값이 오래됨)로 차단 경로를 확인한다.
    const source = fullMonthCloseSource({ mirrorStatus: 'STALE' });
    const jvmSource = monthDashboardSource({
      ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(jvmSource),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv, db: source.db, now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close/requests')
      .set('idempotency-key', 'blocked-dashboard-request')
      .send({
        contractVersion: 'cashflow-cumulative-close-v2',
        yearMonth: '2026-07', expectedRevision: 0, expectedWorkflowRevision: 0,
        expectedApproverUid: 'finance-1', expectedProjectVersion: 0,
        expectedOpeningBalances: jvmSource.openingBalances,
        closeInput: { ...source.closeInput, managementChecks: emptyManagementChecks },
      })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_month_close_validation_failed'));

    expect(source.documents.has('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-07')).toBe(false);
  });

  it('does not let an active but unassigned member create a month-close request', async () => {
    const source = fullMonthCloseSource();
    const jvmSource = monthDashboardSource({
      ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(jvmSource),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'viewer-2', actorRole: 'viewer', actorEmail: 'viewer-2@example.com',
    }, {
      env: runtimeEnv, db: source.db, now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close/requests')
      .set('idempotency-key', 'unassigned-month-request')
      .send({
        contractVersion: 'cashflow-cumulative-close-v2',
        yearMonth: '2026-07', expectedRevision: 0, expectedWorkflowRevision: 0,
        expectedApproverUid: 'finance-1', expectedProjectVersion: 0,
        expectedOpeningBalances: jvmSource.openingBalances,
        closeInput: { ...source.closeInput, managementChecks: emptyManagementChecks },
      })
      .expect(403)
      .expect((response) => expect(response.body.code).toBe('cashflow_project_forbidden'));

    expect(source.documents.has('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-07')).toBe(false);
  });

  it('shows only current canonical approval requests in the manager queue', async () => {
    const source = fullMonthCloseSource();
    const current = { ...canonicalMonthCloseRequest('2026-09'), approverUid: 'finance-1' };
    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-09', {
      ...current,
    });
    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08', { ...current, requestId: 'project-a-2026-08', cycleYearMonth: '2026-08' });
    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/legacy-pending', { ...current, requestId: 'legacy-pending', status: 'PENDING' });
    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/archive-current', { ...current, requestId: 'archive-current', documentType: 'REQUEST_ARCHIVE' });
    const { app } = createApp(vi.fn(), createIdempotencyService(), {
      actorId: 'finance-1', actorRole: 'finance',
    }, { env: runtimeEnv, db: source.db });

    await request(app)
      .get('/api/v1/cashflow/month-close/requests/pending')
      .expect(200)
      .expect((response) => {
        expect(response.body.count).toBe(1);
        expect(response.body.items[0].requestId).toBe('project-a-2026-09');
      });
  });

  it('persists an active designated approver and ignores historical requests when checking the lock', async () => {
    const source = fullMonthCloseSource();
    source.documents.get('orgs/tenant-a/projects/project-a').version = 2;
    const { app } = createApp(vi.fn(), createIdempotencyService(), {
      actorId: 'pm-1', actorRole: 'pm',
    }, { env: runtimeEnv, db: source.db, now: () => new Date('2026-07-29T00:00:00.000Z') });

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close/approver')
      .set('idempotency-key', 'set-approver-finance-2')
      .send({ approverUid: 'finance-2', yearMonth: '2026-09', expectedVersion: 2 })
      .expect(200)
      .expect((response) => expect(response.body).toMatchObject({
        projectId: 'project-a', executiveApproverId: 'finance-2', executiveApproverName: '', version: 3,
      }));

    expect(source.documents.get('orgs/tenant-a/projects/project-a')).toMatchObject({
      executiveApproverId: 'finance-2', version: 3, updatedBy: 'pm-1',
    });

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close/approver')
      .set('idempotency-key', 'set-approver-finance-2')
      .send({ approverUid: 'finance-2', yearMonth: '2026-09', expectedVersion: 2 })
      .expect(200)
      .expect((response) => expect(response.body.version).toBe(3));
    expect(source.documents.get('orgs/tenant-a/projects/project-a').version).toBe(3);

    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08', {
      requestId: 'project-a-2026-08', projectId: 'project-a', yearMonth: '2026-08', status: 'PENDING',
    });
    await request(app)
      .post('/api/v1/cashflow/project-a/month-close/approver')
      .set('idempotency-key', 'ignore-historical-approver')
      .send({ approverUid: 'finance-1', yearMonth: '2026-09', expectedVersion: 3 })
      .expect(200)
      .expect((response) => expect(response.body.version).toBe(4));
    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/__active__-project-a', {
      documentType: 'ACTIVE_COORDINATOR', tenantId: 'tenant-a', projectId: 'project-a',
      activeCycleYearMonth: '2026-09', activeRequestId: 'project-a-2026-09',
      activeState: 'PENDING_APPROVAL', workflowRevision: 1,
    });
    await request(app)
      .post('/api/v1/cashflow/project-a/month-close/approver')
      .set('idempotency-key', 'locked-current-approver')
      .send({ approverUid: 'finance-2', yearMonth: '2026-09', expectedVersion: 4 })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_month_close_approver_locked'));
  });

  it('rejects inactive approvers and unassigned actors when designating an approver', async () => {
    const source = fullMonthCloseSource();
    source.documents.get('orgs/tenant-a/projects/project-a').version = 2;
    source.documents.get('orgs/tenant-a/members/finance-2').status = 'INACTIVE';
    const requester = createApp(vi.fn(), createIdempotencyService(), {
      actorId: 'pm-1', actorRole: 'pm',
    }, { env: runtimeEnv, db: source.db }).app;

    await request(requester)
      .post('/api/v1/cashflow/project-a/month-close/approver')
      .send({ approverUid: 'finance-2', yearMonth: '2026-09', expectedVersion: 2 })
      .expect(403)
      .expect((response) => expect(response.body.code).toBe('cashflow_month_close_member_inactive'));
    await request(requester)
      .post('/api/v1/cashflow/project-a/month-close/approver')
      .send({ approverUid: 'pm-1', yearMonth: '2026-09', expectedVersion: 2 })
      .expect(200)
      .expect((response) => expect(response.body.executiveApproverId).toBe('pm-1'));

    const outsider = createApp(vi.fn(), createIdempotencyService(), {
      actorId: 'viewer-2', actorRole: 'viewer',
    }, { env: runtimeEnv, db: source.db }).app;
    await request(outsider)
      .post('/api/v1/cashflow/project-a/month-close/approver')
      .send({ approverUid: 'finance-1', yearMonth: '2026-09', expectedVersion: 3 })
      .expect(403)
      .expect((response) => expect(response.body.code).toBe('cashflow_project_forbidden'));
  });

  it('lets only the requester or current reopen decider read cumulative month evidence', async () => {
    const source = fullMonthCloseSource();
    const requestId = 'project-a-2026-07';
    source.documents.set(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`, {
      ...canonicalMonthCloseRequest('2026-07'),
      fromMonth: '2026-06', throughMonth: '2026-06', monthCount: 1,
    });
    const shard = {
      documentType: 'EVIDENCE_MONTH', requestId, projectId: 'project-a',
      requestRevision: 1, yearMonth: '2026-06', cells: source.closeInput.cells,
    };
    source.documents.set(
      `orgs/tenant-a/cashflow_month_close_request_months/${requestId}-r1-2026-06`,
      { ...shard, shardHash: cashflowEvidenceHash(shard) },
    );
    const fetchImpl = vi.fn();
    const appFor = (actorId, actorRole, availability) => createApp(
      vi.fn(async (url, init) => {
        if (String(url).includes('/month-close/reopen-authority')) {
          expect(init.method).toBe('GET');
          return new Response(JSON.stringify({
            ok: true,
            commandName: 'cashflowMonth.readReopenAuthority',
            projectId: 'project-a',
            availability,
            canDecideReopen: availability === 'ALLOWED',
            guide: '',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return fetchImpl(url, init);
      }),
      createIdempotencyService(),
      { actorId, actorRole },
      { env: runtimeEnv, db: source.db, forwardReopenAuthorityFetch: true },
    ).app;
    const monthsPath = `/api/v1/cashflow/project-a/month-close/requests/${requestId}/months?limit=1`;
    const revisionDiffPath = `/api/v1/cashflow/project-a/month-close/requests/${requestId}/revision-diff`;

    for (const [actorId, actorRole, availability] of [
      ['pm-1', 'pm', 'FORBIDDEN'],
      ['viewer-2', 'viewer', 'ALLOWED'],
      ['admin-1', 'viewer', 'ALLOWED'],
    ]) {
      await request(appFor(actorId, actorRole, availability)).get(monthsPath).expect(200);
      await request(appFor(actorId, actorRole, availability)).get(revisionDiffPath).expect(200);
    }

    await request(appFor('finance-1', 'finance', 'FORBIDDEN'))
      .get(monthsPath)
      .expect(403)
      .expect((response) => expect(response.body.code).toBe('cashflow_month_close_request_forbidden'));
    await request(appFor('finance-1', 'finance', 'FORBIDDEN'))
      .get(revisionDiffPath)
      .expect(403)
      .expect((response) => expect(response.body.code).toBe('cashflow_month_close_request_forbidden'));
    await request(appFor('finance-1', 'finance', 'UNAVAILABLE'))
      .get(monthsPath)
      .expect(503)
      .expect((response) => expect(response.body.code).toBe('cashflow_month_reopen_authority_unavailable'));
  });

  it('trusts the JVM approval receipt when the reread ledger has no audit id', async () => {
    const cycleYearMonth = '2026-09';
    const requestId = `project-a-${cycleYearMonth}`;
    const { app, appFor, source, monthCloseBodies, bffWrites, cashflowSlackService, setCapability } = canonicalCycleMonthCloseFixture(
      cycleYearMonth,
      { approve: true, actorId: 'finance-1', actorRole: 'viewer' },
    );
    const pending = source.documents.get(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`);
    const payload = {
      decision: 'APPROVE', expectedRevision: pending.evidenceRevision,
      expectedManifestHash: pending.manifestHash, reason: '근거 확인 완료',
    };
    setCapability('APPROVE_MONTH_CLOSE', false, 'NOT_CURRENT_APPROVER');
    await request(appFor('finance-2', 'finance')).post(`/api/v1/cashflow/project-a/month-close/requests/${requestId}/review`)
      .set('idempotency-key', 'month-close-review-wrong').send(payload).expect(403);
    expect(monthCloseBodies).toEqual([]);
    setCapability('APPROVE_MONTH_CLOSE', true);
    const approved = await request(app)
      .post(`/api/v1/cashflow/project-a/month-close/requests/${requestId}/status-review`)
      .set('idempotency-key', 'month-close-review-approve')
      .send(payload)
      .expect(200)
      .expect((response) => {
        expect(response.body.request).toMatchObject({
          requestId, status: 'APPROVED', evidenceRevision: 1, ledgerRevision: 7,
          workflowRevision: 2, reviewedByUid: 'finance-1', reviewWarnings: ['canonical-reread'],
        });
        expect(response.body.monthClose).toMatchObject({
          status: 'CLOSED', revision: 7, snapshot: { source: 'canonical-reread' },
        });
      });
    expect(monthCloseBodies).toEqual([{
      idempotencyKey: 'month-close-review-approve', yearMonth: cycleYearMonth,
      expectedRevision: 6, expectedDraftRevision: 0, humanReviewed: true,
      requestId, requestRevision: 1, manifestHash: pending.manifestHash,
      cycleYearMonth, monthCloseTargetYearMonth: '2026-08',
      expectedWorkflowRevision: 1, decisionReason: payload.reason,
    }]);
    await request(app)
      .post(`/api/v1/cashflow/project-a/month-close/requests/${requestId}/review`)
      .set('idempotency-key', 'month-close-review-approve').send(payload).expect(200, approved.body);
    expect(monthCloseBodies).toHaveLength(2);
    expect(bffWrites).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cashflowSlackService.notifyMessage).toHaveBeenCalledTimes(1);
  });

  it('routes a cumulative close rejection through the JVM transition', async () => {
    const cycleYearMonth = '2026-09';
    const requestId = `project-a-${cycleYearMonth}`;
    const { app, source, transitionBodies, bffWrites, cashflowSlackService } = canonicalCycleMonthCloseFixture(cycleYearMonth, {
      transitionAction: 'REJECT', actorId: 'finance-1', actorRole: 'finance',
    });
    const pending = source.documents.get(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`);
    const payload = {
      decision: 'REJECT', cycleYearMonth, monthCloseTargetYearMonth: '2026-08',
      expectedRevision: pending.evidenceRevision,
      expectedManifestHash: pending.manifestHash,
      expectedWorkflowRevision: pending.workflowRevision,
      reason: '입금 근거 재확인 필요',
    };
    await request(app)
      .post(`/api/v1/cashflow/project-a/month-close/requests/${requestId}/status-review`)
      .set('idempotency-key', 'reject-padded')
      .send({ ...payload, decision: ' reject ' })
      .expect(400);
    expect(transitionBodies).toEqual([]);
    const rejected = await request(app)
      .post(`/api/v1/cashflow/project-a/month-close/requests/${requestId}/status-review`)
      .set('idempotency-key', 'reject-once')
      .send(payload)
      .expect(200)
      .expect((response) => expect(response.body.request).toMatchObject({
        requestId, status: 'REJECTED', workflowRevision: 2,
        decisionReason: payload.reason, reviewWarnings: ['canonical-reread'],
      }));
    await request(app)
      .post(`/api/v1/cashflow/project-a/month-close/requests/${requestId}/review`)
      .set('idempotency-key', 'reject-once').send(payload).expect(200, rejected.body);

    expect(transitionBodies).toEqual([{
      idempotencyKey: 'reject-once', action: 'REJECT',
      cycleYearMonth, monthCloseTargetYearMonth: '2026-08', requestId,
      evidenceRevision: 1, manifestHash: pending.manifestHash,
      expectedWorkflowRevision: 1, reason: payload.reason,
    }, expect.any(Object)]);
    expect(bffWrites).toEqual([]);
    expect(cashflowSlackService.notifyMessage).not.toHaveBeenCalled();
  });



  it('routes a cumulative close withdrawal through the JVM transition', async () => {
    const cycleYearMonth = '2026-09';
    const requestId = `project-a-${cycleYearMonth}`;
    const { app, appFor, source, transitionBodies, bffWrites, cashflowSlackService, setCapability } = canonicalCycleMonthCloseFixture(
      cycleYearMonth, { transitionAction: 'WITHDRAW' },
    );
    const pending = source.documents.get(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`);
    const payload = {
      cycleYearMonth,
      monthCloseTargetYearMonth: '2026-08',
      expectedRevision: pending.evidenceRevision,
      expectedManifestHash: pending.manifestHash,
      expectedWorkflowRevision: pending.workflowRevision,
      reason: '기초잔액을 다시 확인하겠습니다.',
    };
    setCapability('WITHDRAW_MONTH_CLOSE', false, 'NOT_REQUESTER');
    await request(appFor('finance-2', 'finance')).post(`/api/v1/cashflow/project-a/month-close/requests/${requestId}/withdraw`)
      .set('idempotency-key', 'withdraw-wrong').send(payload).expect(403);
    expect(transitionBodies).toEqual([]);
    setCapability('WITHDRAW_MONTH_CLOSE', true);

    await request(app)
      .post(`/api/v1/cashflow/project-a/month-close/requests/${requestId}/withdraw`)
      .set('idempotency-key', 'withdraw-stale')
      .send({ ...payload, expectedWorkflowRevision: 0 })
      .expect(409);
    expect(transitionBodies).toEqual([]);

    const withdrawn = await request(app)
      .post(`/api/v1/cashflow/project-a/month-close/requests/${requestId}/withdraw`)
      .set('idempotency-key', 'withdraw-once')
      .send(payload)
      .expect(200)
      .expect((response) => expect(response.body.request).toMatchObject({
        requestId,
        status: 'WITHDRAWN',
        workflowRevision: 2,
        withdrawReason: payload.reason,
        reviewWarnings: ['canonical-reread'],
      }));
    expect(transitionBodies).toEqual([{
      idempotencyKey: 'withdraw-once', action: 'WITHDRAW',
      cycleYearMonth, monthCloseTargetYearMonth: '2026-08', requestId,
      evidenceRevision: 1, manifestHash: pending.manifestHash,
      expectedWorkflowRevision: 1, reason: payload.reason,
    }]);
    await request(app)
      .post(`/api/v1/cashflow/project-a/month-close/requests/${requestId}/withdraw`)
      .set('idempotency-key', 'withdraw-once')
      .send(payload)
      .expect(200, withdrawn.body);
    expect(transitionBodies).toHaveLength(2);
    await request(app)
      .post(`/api/v1/cashflow/project-a/month-close/requests/${requestId}/withdraw`)
      .set('idempotency-key', 'withdraw-another-key')
      .send(payload)
      .expect(409);
    expect(transitionBodies).toHaveLength(3);
    expect(bffWrites).toEqual([]);
    expect(cashflowSlackService.notifyMessage).not.toHaveBeenCalled();
  });

  it('fails a foreign JVM settlement-cycle transition receipt closed', async () => {
    const cycleYearMonth = '2026-09', requestId = `project-a-${cycleYearMonth}`;
    const { app, source, bffWrites } = canonicalCycleMonthCloseFixture(cycleYearMonth, {
      transitionAction: 'WITHDRAW', transitionReceiptPatch: { projectId: 'project-b' },
    });
    const pending = source.documents.get(`orgs/tenant-a/cashflow_month_close_requests/${requestId}`);
    await request(app)
      .post(`/api/v1/cashflow/project-a/month-close/requests/${requestId}/withdraw`)
      .set('idempotency-key', 'withdraw-foreign-receipt')
      .send({
        cycleYearMonth, monthCloseTargetYearMonth: '2026-08',
        expectedRevision: pending.evidenceRevision,
        expectedManifestHash: pending.manifestHash,
        expectedWorkflowRevision: pending.workflowRevision,
        reason: '기초잔액 재확인',
      })
      .expect(502)
      .expect((response) => expect(response.body.code).toBe('cashflow_jvm_invalid_response'));
    expect(bffWrites).toEqual([]);
  });

  it('blocks the legacy direct month-close mutation route', async () => {
    const source = fullMonthCloseSource({ yearMonth: '2026-08' });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-09', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'admin-1', actorRole: 'admin',
    }, { env: runtimeEnv, db: source.db, now: () => new Date('2026-09-10T00:00:00.000Z') });
    const read = await request(app).get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-09').expect(200);

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close')
      .set('idempotency-key', 'legacy-direct-close')
      .send({
        yearMonth: '2026-09',
        expectedRevision: 0,
        expectedWorkflowRevision: 0,
        expectedApproverUid: 'finance-1',
        expectedProjectVersion: 0,
        expectedOpeningBalances: read.body.dashboard.openingBalances,
        closeInput: { ...source.closeInput, managementChecks: read.body.dashboard.managementChecks },
      })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_month_close_approval_required'));
    expect(fetchImpl.mock.calls.filter(([url, init]) => url.endsWith('/month-close') && init.method === 'POST')).toHaveLength(0);
  });

  it('reopens the canonical authority and rereads approve and reject decisions', async () => {
    for (const [decision, finalStatus] of [['APPROVE', 'REOPENED'], ['REJECT', 'APPROVED']]) {
      const cycleYearMonth = '2026-10';
      const requestId = `project-a-${cycleYearMonth}`;
      const {
        app, appFor, source, reopenRequestBodies, reopenDecisionBodies, bffWrites,
      } = canonicalCycleMonthCloseFixture(cycleYearMonth, { reopen: true });
      const authority = source.documents.get(
        `orgs/tenant-a/cashflow_month_close_requests/${requestId}`,
      );
      const requestPayload = {
        requestId, yearMonth: cycleYearMonth, expectedRevision: 7, reason: '증빙 정정 필요',
      };
      const requested = await request(app)
        .post('/api/v1/cashflow/project-a/month-close/reopen-request')
        .set('idempotency-key', 'reopen-canonical-request').send(requestPayload).expect(200);
      expect(requested.body.request).toMatchObject({
        requestId, status: 'REOPEN_REQUESTED', evidenceRevision: 1,
        ledgerRevision: 8, workflowRevision: 3,
      });
      await request(app).post('/api/v1/cashflow/project-a/month-close/reopen-request')
        .set('idempotency-key', 'reopen-canonical-request').send(requestPayload).expect(200, requested.body);

      const decisionPayload = {
        requestId, yearMonth: cycleYearMonth, expectedRevision: 8,
        decision, reason: decision === 'APPROVE' ? '정정 승인' : '정정 반려',
      };
      const approver = appFor('finance-1', 'finance');
      const decided = await request(approver)
        .post('/api/v1/cashflow/project-a/month-close/reopen-decision')
        .set('idempotency-key', 'reopen-canonical-decision').send(decisionPayload).expect(200);
      expect(decided.body.request).toMatchObject({
        requestId, status: finalStatus, evidenceRevision: 1, ledgerRevision: 9, workflowRevision: 4,
        reopenDecision: { decision, reason: decisionPayload.reason, decidedByUid: 'finance-1' },
      });
      await request(approver).post('/api/v1/cashflow/project-a/month-close/reopen-decision')
        .set('idempotency-key', 'reopen-canonical-decision').send(decisionPayload).expect(200, decided.body);

      expect(reopenRequestBodies).toEqual([{
        idempotencyKey: 'reopen-canonical-request', yearMonth: cycleYearMonth,
        expectedRevision: 7, reason: requestPayload.reason, requestId, cycleYearMonth,
        monthCloseTargetYearMonth: '2026-09', evidenceRevision: 1,
        manifestHash: authority.manifestHash, expectedWorkflowRevision: 2,
      }, expect.any(Object)]);
      expect(reopenDecisionBodies).toEqual([{
        idempotencyKey: 'reopen-canonical-decision', yearMonth: cycleYearMonth,
        expectedRevision: 8, decision, reason: decisionPayload.reason,
        requestId, cycleYearMonth, monthCloseTargetYearMonth: '2026-09',
        evidenceRevision: 1, manifestHash: authority.manifestHash, expectedWorkflowRevision: 3,
      }, expect.any(Object)]);
      expect(bffWrites).toEqual([]);
    }
  });


  it('blocks month close while a sheet publication is APPLYING', async () => {
    const source = fullMonthCloseSource();
    const fetchImpl = vi.fn(async (url, init) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.includes('/dashboard-source')
        ? monthDashboardSource({
          ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
          reopenCount: 0, projectWarningCount: 0, snapshot: {},
        })
        : { ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'CLOSED' }),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });
    const read = await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-07')
      .expect(200);
    source.documents.set('orgs/tenant-a/cashflow_sheet_publications/project-a', {
      projectId: 'project-a',
      status: 'APPLYING',
      stagedRunId: 'run-in-flight',
      sourceRevision: `sha256:${'a'.repeat(64)}`,
    });

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close')
      .set('idempotency-key', 'month-close-publication-applying')
      .send({
        yearMonth: '2026-07',
        expectedRevision: 0,
        expectedWorkflowRevision: 0,
        expectedOpeningBalances: read.body.dashboard.openingBalances,
        closeInput: { ...source.closeInput, managementChecks: read.body.dashboard.managementChecks },
      })
      .expect(409)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_sheet_apply_in_progress');
      });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the sheet publication changes during month-close preflight', async () => {
    const source = fullMonthCloseSource();
    let publicationReadCount = 0;
    let publicationRaceActive = false;
    const baseDoc = source.db.doc;
    source.db.doc = (path) => {
      if (!publicationRaceActive || path !== 'orgs/tenant-a/cashflow_sheet_publications/project-a') return baseDoc(path);
      return {
        get: async () => {
          publicationReadCount += 1;
          return {
            exists: true,
            data: () => ({
              projectId: 'project-a',
              status: 'APPLIED',
              stagedRunId: publicationReadCount < 2 ? 'run-before' : 'run-after',
              sourceRevision: `sha256:${'a'.repeat(64)}`,
            }),
          };
        },
      };
    };
    const fetchImpl = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(monthDashboardSource({
        ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
        reopenCount: 0, projectWarningCount: 0, snapshot: {},
      })),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });
    const read = await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-07')
      .expect(200);
    publicationRaceActive = true;
    publicationReadCount = 0;

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close')
      .set('idempotency-key', 'month-close-publication-preflight-race')
      .send({
        yearMonth: '2026-07',
        expectedRevision: 0,
        expectedWorkflowRevision: 0,
        expectedOpeningBalances: read.body.dashboard.openingBalances,
        closeInput: { ...source.closeInput, managementChecks: read.body.dashboard.managementChecks },
      })
      .expect(409)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_sheet_publication_changed');
      });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ ...runtimeEnv, BFF_DEPLOY_ENV: 'preview' }, 'unsafe_bff_runtime'],
    [{ ...runtimeEnv, JVM_WEEKLY_FIRESTORE_PROJECT_ID: 'other-data-project' }, 'jvm_weekly_data_project_mismatch'],
  ])('blocks reopen writes before the JVM when runtime alignment fails', async (env, code) => {
    const fetchImpl = vi.fn();
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'pm-1', actorRole: 'pm',
    }, { env });

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close/reopen-request')
      .set('idempotency-key', `blocked-reopen-${code}`)
      .send({ yearMonth: '2026-06', expectedRevision: 4, reason: '정정 필요' })
      .expect(503)
      .expect((response) => expect(response.body.code).toBe(code));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('delegates reopen decision authority to the canonical JVM domain gate', async () => {
    const source = fullMonthCloseSource();
    source.documents.set('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-09', {
      ...canonicalMonthCloseRequest('2026-09', 'REOPEN_REQUESTED', {
        ledgerRevision: 2,
        workflowRevision: 2,
        requestedByUid: 'viewer-2',
      }),
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      code: 'cashflow_month_reopen_decision_forbidden',
      message: '현재 프로젝트의 활성 조직장 또는 Runtime 관리자만 재오픈을 결정할 수 있어요. 담당 조직장을 확인해 주세요.',
    }), { status: 403, headers: { 'content-type': 'application/json' } }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'pm-1', actorRole: 'pm',
    }, { env: runtimeEnv, db: source.db });

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close/reopen-decision')
      .set({
        'idempotency-key': 'forbidden-pm-reopen-decision',
        ...editLeaseHeaders,
        'x-edit-finalize': 'true',
      })
      .send({
        requestId: 'project-a-2026-09', yearMonth: '2026-09', expectedRevision: 2,
        decision: 'APPROVE', reason: '권한 없는 승인',
      })
      .expect(403)
      .expect((response) => expect(response.body.code).toBe('cashflow_month_reopen_decision_forbidden'));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['1', 'TRUE', 'yes', 'false'])(
    'ignores obsolete cashflow edit finalization value %s',
    async (finalize) => {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, projectId: 'project-a' }),
      }));
      const { app } = createApp(fetchImpl, createIdempotencyService(), {
        actorId: 'admin-1', actorRole: 'admin',
      }, { env: runtimeEnv });

      await request(app)
        .post('/api/v1/cashflow-metadata/project-a/variance')
        .set({
          'idempotency-key': `bad-finalize-${finalize}`,
          ...editLeaseHeaders,
          'x-edit-finalize': finalize,
        })
        .send({ yearMonth: '2026-07', weekNo: 1, reason: 'test' })
        .expect(200);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][1].headers['x-edit-finalize']).toBeUndefined();
    },
  );

  it.each(['0', '-1', '01', '1e2', '1.0', '9007199254740992'])(
    'rejects non-canonical edit fence %s before the JVM',
    async (fence) => {
      const fetchImpl = vi.fn();
      const { app } = createApp(fetchImpl, createIdempotencyService(), {
        actorId: 'admin-1',
        actorRole: 'admin',
      }, { env: runtimeEnv });

      await request(app)
        .post('/api/v1/weekly-expenses/project-a/sheets/default/save-draft')
        .set({
          'idempotency-key': `bad-fence-${fence}`,
          ...editLeaseHeaders,
          'x-edit-fence': fence,
        })
        .send({})
        .expect(400);

      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('rejects direct Projection writes and keeps Google Sheet import as the only user write path', async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'finance-1',
      actorRole: 'finance',
    }, { env: runtimeEnv });

    await request(app)
      .post('/api/v1/cashflow/project-a/projection')
      .send({ lines: [{ yearMonth: '2026-07', weekNo: 1, cashflowLine: 'SALES_IN', amount: 1000 }] })
      .expect(410)
      .expect((response) => expect(response.body.code).toBe('cashflow_projection_sheet_import_only'));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards only trusted context headers and strips client actor/tenant body fields', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv });

    await request(app)
      .post('/api/v1/weekly-expenses/project-a/sheets/default/commands/cell-patch')
      .set({ 'idempotency-key': 'idem-proxy-1', ...editLeaseHeaders })
      .send({
        tenantId: 'spoofed-tenant',
        actor: { id: 'spoofed-admin', role: 'admin' },
        cells: [{ rowIndex: 0, columnIndex: 1, rawValue: '1000' }],
      })
      .expect(200);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://jvm-weekly.local/api/v1/weekly-expenses/project-a/sheets/default/commands/cell-patch');
    expect(calls[0].init.headers).toMatchObject({
      'x-tenant-id': 'tenant-a',
      'x-inner-platform-service-token': 'test-service-token',
      'x-actor-id': 'pm-1',
      'x-actor-role': 'pm',
      'x-actor-email': 'pm@example.com',
    });
    expect(JSON.parse(calls[0].init.body)).toEqual({
      idempotencyKey: 'idem-proxy-1',
      cells: [{ rowIndex: 0, columnIndex: 1, rawValue: '1000' }],
    });
  });

  it('does not use BFF Firestore idempotency for Java-owned commands', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    }));
    const idempotencyService = createIdempotencyService();
    idempotencyService.begin.mockImplementation(async () => {
      throw new Error('BFF idempotency must not run for Java weekly commands');
    });
    const { app } = createApp(fetchImpl, idempotencyService, {}, { env: runtimeEnv });

    await request(app)
      .post('/api/v1/weekly-expenses/project-a/sheets/default/commands/cell-patch')
      .set({ 'idempotency-key': 'idem-java-owned-1', ...editLeaseHeaders })
      .send({
        cells: [{ rowIndex: 0, columnIndex: 1, rawValue: '1000' }],
      })
      .expect(200);

    expect(idempotencyService.begin).not.toHaveBeenCalled();
    expect(idempotencyService.complete).not.toHaveBeenCalled();
    expect(idempotencyService.fail).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('proxies server clipboard copy commands through the Java API', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          commandName: 'weeklyExpense.cells.copy',
          clipboard: { operationType: 'COPY', rowCount: 1, columnCount: 2, cells: [] },
        }),
      };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv });

    await request(app)
      .post('/api/v1/weekly-expenses/project-a/sheets/default/commands/copy')
      .set({ 'idempotency-key': 'idem-copy-1', ...editLeaseHeaders })
      .send({
        expectedSheetVersion: 3,
        startRow: 0,
        startColumn: 3,
        endRow: 0,
        endColumn: 4,
        depth: 'DEEP',
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.commandName).toBe('weeklyExpense.cells.copy');
      });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://jvm-weekly.local/api/v1/weekly-expenses/project-a/sheets/default/commands/copy');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      idempotencyKey: 'idem-copy-1',
      expectedSheetVersion: 3,
      startRow: 0,
      startColumn: 3,
      endRow: 0,
      endColumn: 4,
      depth: 'DEEP',
    });
  });

  it('proxies cashflow snapshot reads with trusted tenant context and embeds the binding comparison read model', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          projectId: 'project-a',
          projection: [],
          actual: [],
          readModel: {
            months: [{
              yearMonth: '2026-01',
              projection: { weeks: [{ weekNo: 1, amounts: { SALES_IN: 1000 } }] },
              actual: { weeks: [{ weekNo: 1, amounts: { SALES_IN: 700 } }] },
            }],
          },
        }),
      };
    });
    const { app } = createApp(fetchImpl);

    await request(app)
      .get('/api/v1/cashflow/project-a?asOf=2026-01-31&rangeStart=2026-01%3A1&rangeEnd=2026-01%3A1')
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ projectId: 'project-a' });
        expect(response.body.comparison).toMatchObject({
          direction: 'projection_minus_actual',
          asOfDate: '2026-01-31',
          asOfWeek: { yearMonth: '2026-01', weekNo: 5 },
          months: [{
            yearMonth: '2026-01',
            weeks: [{
              weekNo: 1,
              amounts: { SALES_IN: 300 },
              totalIn: 300,
              totalOut: 0,
              net: 300,
              lines: expect.arrayContaining([
                expect.objectContaining({ lineId: 'SALES_IN', projection: 1000, actual: 700, difference: 300 }),
              ]),
            }],
          }],
        });
        expect(response.body.readModel.months[0].comparison).toMatchObject({
          weeks: [{
            weekNo: 1,
            amounts: { SALES_IN: 300 },
            totalIn: 300,
            totalOut: 0,
            net: 300,
            lines: expect.arrayContaining([
              expect.objectContaining({ lineId: 'SALES_IN', projection: 1000, actual: 700, difference: 300 }),
            ]),
          }],
          rowTotals: { SALES_IN: 300 },
          totalIn: 300,
          totalOut: 0,
          net: 300,
        });
        expect(response.body.readModel.range).toMatchObject({
          start: { yearMonth: '2026-01', weekNo: 1 },
          end: { yearMonth: '2026-01', weekNo: 1 },
          projection: { rowTotals: { SALES_IN: 1000 }, totalIn: 1000, totalOut: 0, net: 1000 },
          actual: { rowTotals: { SALES_IN: 700 }, totalIn: 700, totalOut: 0, net: 700 },
        });
      });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://jvm-weekly.local/api/v1/cashflow/project-a');
    expect(calls[0].init.headers['x-inner-platform-service-token']).toBe('test-service-token');
    expect(calls[0].init.headers['x-tenant-id']).toBe('tenant-a');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('rejects a mismatched JVM cashflow snapshot project before returning data', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        projectId: 'project-b',
        readModel: { months: [] },
      }),
    }));
    const { app } = createApp(fetchImpl);

    await request(app)
      .get('/api/v1/cashflow/project-a?asOf=2026-01-31')
      .expect(502)
      .expect((response) => {
        expect(response.body.code).toBe('jvm_weekly_project_mismatch');
      });
  });

  it('rejects an invalid cashflow comparison as-of date before calling the JVM', async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(fetchImpl);

    await request(app)
      .get('/api/v1/cashflow/project-a?asOf=2026-02-30')
      .expect(400)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_comparison_as_of_invalid');
      });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects invalid or reversed cashflow total ranges before calling the JVM', async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(fetchImpl);

    await request(app)
      .get('/api/v1/cashflow/project-a?rangeStart=2026-1%3A1&rangeEnd=2026-12%3A5')
      .expect(400)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_range_invalid');
      });

    await request(app)
      .get('/api/v1/cashflow/project-a?rangeStart=2026-12%3A5&rangeEnd=2026-01%3A1')
      .expect(400)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_range_invalid');
      });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('defaults cashflow comparison as-of to the current Seoul date', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        projectId: 'project-a',
        readModel: {
          months: [{
            yearMonth: '2026-06',
            projection: {
              weeks: [
                { weekNo: 3, amounts: { SALES_IN: 30 } },
                { weekNo: 4, amounts: { SALES_IN: 40 } },
              ],
            },
            actual: { weeks: [] },
          }],
        },
      }),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      now: () => new Date('2026-06-14T15:30:00.000Z'),
    });

    await request(app)
      .get('/api/v1/cashflow/project-a')
      .expect(200)
      .expect((response) => {
        expect(response.body.comparison).toMatchObject({
          asOfDate: '2026-06-15',
          asOfWeek: { yearMonth: '2026-06', weekNo: 3 },
        });
        expect(response.body.readModel.months[0].comparison.weeks.map((week) => week.weekNo)).toEqual([3]);
      });
  });

  it('proxies weekly expense sheet read-back through trusted Java context', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          projectId: 'project-a',
          sheetKey: 'default',
          rows: [{ id: 'row-1', cells: [] }],
          sheetVersion: 7,
        }),
      };
    });
    const { app } = createApp(fetchImpl);

    await request(app)
      .get('/api/v1/weekly-expenses/project-a/sheets/default')
      .send({
        tenantId: 'spoofed-tenant',
        actor: { id: 'spoofed-admin', role: 'admin' },
      })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ projectId: 'project-a', sheetKey: 'default', sheetVersion: 7 });
      });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://jvm-weekly.local/api/v1/weekly-expenses/project-a/sheets/default');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[0].init.headers).toMatchObject({
      'x-tenant-id': 'tenant-a',
      'x-inner-platform-service-token': 'test-service-token',
      'x-actor-id': 'pm-1',
      'x-actor-role': 'pm',
    });
  });

  it('proxies weekly expense sheet list reads for Java-backed portal hydration', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          projectId: 'project-a',
          sheets: [{ sheetKey: 'default', rows: [], sheetVersion: 1 }],
        }),
      };
    });
    const { app } = createApp(fetchImpl);

    await request(app)
      .get('/api/v1/weekly-expenses/project-a/sheets')
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ projectId: 'project-a', sheets: [{ sheetKey: 'default', sheetVersion: 1 }] });
      });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://jvm-weekly.local/api/v1/weekly-expenses/project-a/sheets');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('adds a Google identity token when the Java Cloud Run audience is configured', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (String(url).startsWith('http://metadata.google.internal/')) {
        return {
          ok: true,
          status: 200,
          text: async () => 'metadata-id-token',
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ projectId: 'project-a', projection: [], actual: [] }),
      };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      jvmWeeklyApiIdTokenAudience: 'https://innerplatform-jvm-weekly-api.run.app',
    });

    await request(app)
      .get('/api/v1/cashflow/project-a')
      .expect(200);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('metadata.google.internal');
    expect(calls[0].url).toContain('audience=https%3A%2F%2Finnerplatform-jvm-weekly-api.run.app');
    expect(calls[0].init.headers).toMatchObject({ 'Metadata-Flavor': 'Google' });
    expect(calls[1].url).toBe('http://jvm-weekly.local/api/v1/cashflow/project-a');
    expect(calls[1].init.headers.authorization).toBe('Bearer metadata-id-token');
    expect(calls[1].init.headers['x-inner-platform-service-token']).toBe('test-service-token');
  });

  it('adds an audience-bound ID token resolved from Live BFF credentials', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ projectId: 'project-a', projection: [], actual: [] }),
      };
    });
    const resolveIdentityToken = vi.fn(async () => 'live-id-token');
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, {
      jvmWeeklyApiIdTokenAudience: 'https://innerplatform-jvm-weekly-api-live.a.run.app',
      jvmWeeklyApiServiceAccountJson: JSON.stringify({ client_email: 'live-invoker@example.iam.gserviceaccount.com' }),
      jvmWeeklyApiIdentityTokenResolver: resolveIdentityToken,
    });

    await request(app)
      .get('/api/v1/cashflow/project-a')
      .expect(200);

    expect(resolveIdentityToken).toHaveBeenCalledWith(expect.objectContaining({
      audience: 'https://innerplatform-jvm-weekly-api-live.a.run.app',
      serviceAccountJson: JSON.stringify({ client_email: 'live-invoker@example.iam.gserviceaccount.com' }),
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.authorization).toBe('Bearer live-id-token');
  });

  it('proxies audit export creation as a finance-only Java command', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, commandName: 'weeklyExpense.auditExport.create' }),
      };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'finance-1',
      actorRole: 'finance',
      actorEmail: 'finance@example.com',
    });

    await request(app)
      .post('/api/v1/weekly-expenses/project-a/audit-export')
      .set('idempotency-key', 'idem-export-1')
      .send({
        tenantId: 'spoofed-tenant',
        actor: { id: 'spoofed-admin', role: 'admin' },
        format: 'CSV',
      })
      .expect(200);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://jvm-weekly.local/api/v1/weekly-expenses/project-a/audit-export');
    expect(calls[0].init.headers).toMatchObject({
      'x-tenant-id': 'tenant-a',
      'x-inner-platform-service-token': 'test-service-token',
      'x-actor-id': 'finance-1',
      'x-actor-role': 'finance',
      'x-actor-email': 'finance@example.com',
    });
    expect(JSON.parse(calls[0].init.body)).toEqual({
      idempotencyKey: 'idem-export-1',
      format: 'CSV',
    });
  });

  it('preserves real Java roles for mysc users when JVM auth mode is strict', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, commandName: 'weeklyExpense.auditExport.create' }),
      };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'finance-mysc-1',
      actorRole: 'finance',
      actorEmail: 'finance@mysc.co.kr',
      actorName: '재무 사용자',
    });

    await request(app)
      .post('/api/v1/weekly-expenses/project-a/audit-export')
      .set('idempotency-key', 'idem-strict-mysc-export-1')
      .send({ format: 'CSV' })
      .expect(200);

    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers).toMatchObject({
      'x-actor-id': 'finance-mysc-1',
      'x-actor-role': 'finance',
      'x-actor-email': 'finance@mysc.co.kr',
      'x-actor-name': encodeURIComponent('재무 사용자'),
    });
  });

  it('does not relax finance-only Java weekly routes for workspace users in strict mode', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'viewer-mysc-1',
      actorRole: 'viewer',
      actorEmail: 'viewer@mysc.co.kr',
    });

    await request(app)
      .post('/api/v1/weekly-expenses/project-a/audit-export')
      .set('idempotency-key', 'idem-strict-viewer-export-1')
      .send({ format: 'CSV' })
      .expect(403);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lets mysc workspace users run scoped Java weekly commands when JVM auth mode is workspace', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, commandName: 'weeklyExpense.auditExport.create' }),
      };
    });
    const { app } = createApp(
      fetchImpl,
      createIdempotencyService(),
      {
        actorId: 'workspace-1',
        actorRole: 'viewer',
        actorEmail: 'workspace@mysc.co.kr',
        actorName: '민욱 사용자',
      },
      { jvmWeeklyAuthMode: 'internal_saas_workspace' },
    );

    await request(app)
      .post('/api/v1/weekly-expenses/project-a/audit-export')
      .set('idempotency-key', 'idem-workspace-export-1')
      .send({ format: 'CSV' })
      .expect(200);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://jvm-weekly.local/api/v1/weekly-expenses/project-a/audit-export');
    expect(calls[0].init.headers).toMatchObject({
      'x-tenant-id': 'tenant-a',
      'x-inner-platform-service-token': 'test-service-token',
      'x-actor-id': 'workspace-1',
      'x-actor-role': 'workspace_user',
      'x-actor-email': 'workspace@mysc.co.kr',
      'x-actor-name': encodeURIComponent('민욱 사용자'),
    });
  });

  it('uses the configured workspace email domain when relaxing Java weekly roles', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, commandName: 'weeklyExpense.auditExport.create' }),
      };
    });
    const { app } = createApp(
      fetchImpl,
      createIdempotencyService(),
      {
        actorId: 'workspace-2',
        actorRole: 'viewer',
        actorEmail: 'workspace@example.org',
      },
      {
        jvmWeeklyAuthMode: 'internal_saas_workspace',
        jvmWeeklyWorkspaceEmailDomain: 'example.org',
      },
    );

    await request(app)
      .post('/api/v1/weekly-expenses/project-a/audit-export')
      .set('idempotency-key', 'idem-workspace-export-custom-domain-1')
      .send({ format: 'CSV' })
      .expect(200);

    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers).toMatchObject({
      'x-actor-id': 'workspace-2',
      'x-actor-role': 'workspace_user',
      'x-actor-email': 'workspace@example.org',
    });
  });

  it('disables the legacy weekly submit command in favor of month close', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, commandName: 'weeklyExpense.submitWeek', state: 'submitted' }),
      };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'pm-1',
      actorRole: 'pm',
      actorEmail: 'pm@example.com',
    }, { env: runtimeEnv });
    await request(app)
      .post('/api/v1/weekly-expenses/project-a/submit')
      .set({ 'idempotency-key': 'idem-submit-compound-1', ...editLeaseHeaders, 'x-edit-finalize': 'true' })
      .send({ yearMonth: '2026-06', weekNo: 1 })
      .expect(410)
      .expect((response) => {
        expect(response.body.code).toBe('weekly_close_disabled_use_month_close');
      });

    expect(calls).toHaveLength(0);
  });

  it('disables the legacy weekly close command in favor of month close', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, commandName: 'weeklyExpense.closeWeek', state: 'closed' }),
      };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'admin-1',
      actorRole: 'admin',
      actorEmail: 'admin@example.com',
    }, { env: runtimeEnv });

    await request(app)
      .post('/api/v1/weekly-expenses/project-a/close')
      .set({ 'idempotency-key': 'idem-close-1', ...editLeaseHeaders, 'x-edit-finalize': 'true' })
      .send({
        tenantId: 'spoofed-tenant',
        actor: { id: 'spoofed-admin', role: 'admin' },
        yearMonth: '2026-06',
        weekNo: 1,
        projectionLines: [{ yearMonth: '2026-06', weekNo: 1, cashflowLine: 'SALES_IN', amount: 2500 }],
      })
      .expect(410)
      .expect((response) => {
        expect(response.body.code).toBe('weekly_close_disabled_use_month_close');
      });

    expect(calls).toHaveLength(0);
  });

  it('proxies bank statement import and apply commands through trusted Java context', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const { app } = createApp(fetchImpl, createIdempotencyService(), {}, { env: runtimeEnv });

    await request(app)
      .post('/api/v1/weekly-expenses/project-a/bank-statements/import-batch')
      .set({ 'idempotency-key': 'idem-bank-import-1', ...editLeaseHeaders })
      .send({
        tenantId: 'spoofed-tenant',
        actor: { id: 'spoofed-admin', role: 'admin' },
        columns: ['거래일시', '금액'],
        lines: [{ lineIndex: 0, sourceLineKey: 'bank:1', signedAmount: -1000, rawCells: ['2026-06-01', '-1000'] }],
      })
      .expect(200);

    await request(app)
      .post('/api/v1/weekly-expenses/project-a/bank-statements/apply-items')
      .set({ 'idempotency-key': 'idem-bank-apply-1', ...editLeaseHeaders })
      .send({
        tenantId: 'spoofed-tenant',
        actor: { id: 'spoofed-admin', role: 'admin' },
        sheetKey: 'default',
        items: [{ importLineId: 'line-1', cells: [{ columnIndex: 8, rawValue: '사업비' }] }],
      })
      .expect(200);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('http://jvm-weekly.local/api/v1/weekly-expenses/project-a/bank-statements/import-batch');
    expect(calls[1].url).toBe('http://jvm-weekly.local/api/v1/weekly-expenses/project-a/bank-statements/apply-items');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      idempotencyKey: 'idem-bank-import-1',
      columns: ['거래일시', '금액'],
      lines: [{ lineIndex: 0, sourceLineKey: 'bank:1', signedAmount: -1000, rawCells: ['2026-06-01', '-1000'] }],
    });
    expect(JSON.parse(calls[1].init.body)).toEqual({
      idempotencyKey: 'idem-bank-apply-1',
      sheetKey: 'default',
      items: [{ importLineId: 'line-1', cells: [{ columnIndex: 8, rawValue: '사업비' }] }],
    });
    expect(calls[0].init.headers).toMatchObject({
      'x-tenant-id': 'tenant-a',
      'x-inner-platform-service-token': 'test-service-token',
      'x-actor-id': 'pm-1',
      'x-actor-role': 'pm',
    });
  });

  it('proxies bank statement import line reads through trusted Java context without a request body', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          projectId: 'project-a',
          status: 'all',
          lines: [
            { id: 'line-1', sourceLineKey: 'bank:1', status: 'staged', signedAmount: -1000, rawCells: ['2026-06-01', '-1000'] },
          ],
        }),
      };
    });
    const { app } = createApp(fetchImpl);

    await request(app)
      .get('/api/v1/weekly-expenses/project-a/bank-statements/import-lines?status=all')
      .send({
        tenantId: 'spoofed-tenant',
        actor: { id: 'spoofed-admin', role: 'admin' },
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.lines).toHaveLength(1);
        expect(response.body.lines[0].id).toBe('line-1');
      });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://jvm-weekly.local/api/v1/weekly-expenses/project-a/bank-statements/import-lines?status=all');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[0].init.headers).toMatchObject({
      'x-tenant-id': 'tenant-a',
      'x-inner-platform-service-token': 'test-service-token',
      'x-actor-id': 'pm-1',
      'x-actor-role': 'pm',
    });
  });
});

describe('JVM month-close calendar contract', () => {
  function createCalendarApp(source) {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(source),
    }));
    return createApp(fetchImpl, createIdempotencyService(), {}, {
      env: runtimeEnv,
      db: source.db,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });
  }

  it('passes JVM calendar deadlines through the monthly status join and summary', async () => {
    const source = fullMonthCloseSource();
    const jvmSource = monthDashboardSource({
      ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
    });
    jvmSource.monthCloseCalendar[4] = {
      yearMonth: '2026-05',
      closeDeadline: '2026-06-10',
      closeDeadlineAt: '2099-01-03T00:00:00Z',
      approverDeadlineAt: '2099-01-04T00:00:00Z',
    };
    jvmSource.settlementStatuses.items[0].deadlineAt = '2099-01-03T00:00:00Z';
    jvmSource.settlementStatuses.items[0].approverDeadlineAt = '2099-01-04T00:00:00Z';
    const { app } = createCalendarApp({ ...jvmSource, db: source.db });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(200)
      .expect((response) => {
        expect(response.body.dashboard.monthCloseStatuses).toEqual(expect.arrayContaining([
          expect.objectContaining({
            yearMonth: '2026-05',
            closeDeadline: '2026-06-10',
            closeDeadlineAt: '2099-01-03T00:00:00Z',
            approverDeadlineAt: '2099-01-04T00:00:00Z',
          }),
        ]));
        expect(response.body.dashboard.summary).toMatchObject({
          closeDeadline: '2026-06-10',
          closeDeadlineAt: '2099-01-03T00:00:00Z',
          approverDeadlineAt: '2099-01-04T00:00:00Z',
        });
      });
  });

  it.each([
    ['missing', (source) => { delete source.monthCloseCalendar; }],
    ['wrong count', (source) => { source.monthCloseCalendar = source.monthCloseCalendar.slice(0, 11); }],
    ['malformed item', (source) => { source.monthCloseCalendar[5].closeDeadlineAt = 'not-an-instant'; }],
  ])('fails closed when the JVM calendar is %s', async (_label, mutate) => {
    const source = fullMonthCloseSource();
    const jvmSource = monthDashboardSource({
      ok: true, projectId: 'project-a', yearMonth: '2026-06', status: 'OPEN', revision: 0,
    });
    mutate(jvmSource);
    const { app } = createCalendarApp({ ...jvmSource, db: source.db });

    await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-06')
      .expect(502)
      .expect((response) => expect(response.body.code).toBe('jvm_weekly_response_invalid'));
  });

  it('does not authorize a month-close write from the calendar alone', async () => {
    const source = fullMonthCloseSource();
    const jvmSource = monthDashboardSource({
      ok: true, projectId: 'project-a', yearMonth: '2026-07', status: 'OPEN', revision: 0,
    });
    jvmSource.operationalCycle.closeEligible = false;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(jvmSource),
    }));
    const { app } = createApp(fetchImpl, createIdempotencyService(), {
      actorId: 'pm-1', actorRole: 'pm',
    }, { env: runtimeEnv, db: source.db, now: () => new Date('2026-07-10T00:00:00.000Z') });
    const read = await request(app)
      .get('/api/v1/cashflow/project-a/month-close?yearMonth=2026-07')
      .expect(200);

    await request(app)
      .post('/api/v1/cashflow/project-a/month-close/requests')
      .set('idempotency-key', 'calendar-ineligible')
      .send({
        contractVersion: 'cashflow-cumulative-close-v2',
        yearMonth: '2026-07', expectedRevision: 0, expectedWorkflowRevision: 0,
        expectedApproverUid: 'finance-1', expectedProjectVersion: 0,
        expectedOpeningBalances: read.body.dashboard.openingBalances,
        closeInput: { ...source.closeInput, managementChecks: read.body.dashboard.managementChecks },
      })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_month_close_not_eligible'));
    expect(source.documents.has('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-07')).toBe(false);
  });
});
