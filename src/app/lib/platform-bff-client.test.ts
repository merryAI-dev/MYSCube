import { describe, expect, it, vi } from 'vitest';
import {
  addCommentViaBff,
  addEvidenceViaBff,
  analyzeGoogleSheetImportViaBff,
  analyzeProjectRequestContractViaBff,
  changeTransactionStateViaBff,
  deepSyncAuthGovernanceUserViaBff,
  deepSyncAuthGovernanceUsersViaBff,
  fetchAuthGovernanceUsersViaBff,
  fetchAssignedProjectRequestsViaBff,
  fetchLatestProjectRequestViaBff,
  fetchPendingProjectChangeRequestsViaBff,
  fetchProjectReviewInboxViaBff,
  fetchProjectsViaBff,
  linkProjectEvidenceDriveRootViaBff,
  notifyProjectRequestRegistrationViaBff,
  reviewProjectManagementPlanningStatusViaBff,
  reviewProjectExecutiveStatusViaBff,
  overrideTransactionEvidenceDriveCategoriesViaBff,
  previewGoogleSheetImportViaBff,
  processProjectRequestContractViaBff,
  provisionProjectEvidenceDriveRootViaBff,
  provisionTransactionEvidenceDriveViaBff,
  readPlatformApiRuntimeConfig,
  restoreProjectViaBff,
  syncTransactionEvidenceDriveViaBff,
  trashProjectViaBff,
  uploadProjectSheetSourceViaBff,
  uploadProjectRequestContractViaBff,
  toRequestActor,
  updateContactViaBff,
  uploadTransactionEvidenceDriveViaBff,
  upsertLedgerViaBff,
  type PlatformApiClientLike,
  upsertProjectViaBff,
  upsertTransactionViaBff,
  upsertCashflowWeekAmountsViaBff,
  saveCashflowProjectionBatchViaBff,
  fetchCashflowMonthCloseViaBff,
  saveCashflowMonthCloseApproverViaBff,
  completeCashflowWeeklyUpdateViaBff,
  fetchCashflowWeeklyUpdateViaBff,
  fetchCashflowWeeklyComplianceViaBff,
  fetchCashflowProjectionActualSummariesViaBff,
  fetchCashflowSettlementStatusesBatchViaBff,
  fetchCashflowWeeklyOverviewViaBff,
  transitionCashflowSettlementStatusViaBff,
  fetchCashflowActivityViaBff,
  fetchCashflowAppliedCellChangesViaBff,
  type CashflowCumulativeCloseScope,
  type CashflowMonthCloseActions,
  type CashflowMonthClosePresentation,
  type CashflowOperationsSummary,
  type CashflowSettlementCycle,
  type CashflowSettlementStatusItem,
  type CashflowSettlementStatusesResult,
  reopenCashflowWeeklyUpdateViaBff,
  requestCashflowMonthCloseViaBff,
  fetchPendingCashflowMonthCloseRequestsViaBff,
  fetchCashflowMonthCloseRequestMonthsViaBff,
  reviewCashflowMonthCloseRequestViaBff,
  withdrawCashflowMonthCloseRequestViaBff,
  requestCashflowMonthReopenViaBff,
  decideCashflowMonthReopenViaBff,
  readWeeklyExpenseSheetViaBff,
  saveWeeklyExpenseDraftViaBff,
  importBankStatementBatchViaBff,
  applyBankStatementItemsViaBff,
  syncProjectCashflowActualsViaBff,
  applyCashflowVarianceIntentViaBff,
  applyWeeklySubmissionStatusIntentViaBff,
  applyEvidenceRequiredMapIntentViaBff,
  fetchParticipationDashboardViaBff,
  fetchPersonsViaBff,
  createPersonViaBff,
  previewParticipationSheetByLinkViaBff,
} from './platform-bff-client';

const cashflowLease = { sessionId: 'session-a', leaseId: 'lease-a', fence: 7 };

const cashflowSettlementCycleCommands = [
  'SUBMIT_MONTH_CLOSE', 'WITHDRAW_MONTH_CLOSE', 'APPROVE_MONTH_CLOSE', 'REJECT_MONTH_CLOSE',
  'REQUEST_MONTH_REOPEN', 'APPROVE_MONTH_REOPEN', 'REJECT_MONTH_REOPEN', 'CANCEL_ACTIVE_CYCLE',
];

function cashflowWeeklyOverviewCycle(
  monthCloseSettlement: CashflowSettlementStatusItem | null = null,
): CashflowSettlementCycle {
  const submitted = monthCloseSettlement !== null;
  return {
    cycleYearMonth: '2026-08', weeklyYearMonth: '2026-08', monthCloseTargetYearMonth: '2026-07', closeDeadline: '2026-08-10',
    businessState: submitted ? 'SUBMITTED' : 'NOT_REQUESTED', health: 'OK', workflowRevision: submitted ? 1 : 0,
    monthCloseSettlement, provenance: null, supersededAttempt: null,
    commandCapabilities: {
      ...Object.fromEntries(cashflowSettlementCycleCommands.map((command) => [
        command, { allowed: false, reasonCode: 'BUSINESS_STATE_NOT_ELIGIBLE' },
      ])),
      ...(submitted ? {
        WITHDRAW_MONTH_CLOSE: { allowed: true, reasonCode: '' },
        APPROVE_MONTH_CLOSE: { allowed: false, reasonCode: 'NOT_CURRENT_APPROVER' },
        REJECT_MONTH_CLOSE: { allowed: false, reasonCode: 'NOT_CURRENT_APPROVER' },
        CANCEL_ACTIVE_CYCLE: { allowed: false, reasonCode: 'RECOVERY_ADMIN_REQUIRED' },
      } : { SUBMIT_MONTH_CLOSE: { allowed: true, reasonCode: '' } }),
    } as CashflowSettlementCycle['commandCapabilities'],
  };
}

function cashflowWeeklyOverviewStatuses(projectId: string, items: CashflowSettlementStatusItem[] = [
  {
    period: 'MONTH', status: 'WAITING_FOR_UPDATE',
    deadlineAt: '2026-08-10T15:00:00.000Z', approverDeadlineAt: '2026-08-31T15:00:00.000Z',
    submittedAt: '', submittedBy: '', approvedAt: '', approvedBy: '', revision: 0,
  },
  {
    period: 'WEEK_1', status: 'PENDING_APPROVAL',
    deadlineAt: '2026-08-02T15:00:00.000Z', approverDeadlineAt: '2026-08-03T04:00:00.000Z',
    submittedAt: '2026-08-03T01:00:00.000Z', submittedBy: 'pm-1', approvedAt: '', approvedBy: '', revision: 1,
  },
  ...Array.from({ length: 4 }, (_, index) => ({
    period: `WEEK_${index + 2}` as CashflowSettlementStatusItem['period'],
    status: 'WAITING_FOR_UPDATE' as const,
    deadlineAt: '2026-08-06T15:00:00.000Z',
    approverDeadlineAt: '2026-08-07T04:00:00.000Z',
    submittedAt: '', submittedBy: '', approvedAt: '', approvedBy: '', revision: 0,
  })),
]): CashflowSettlementStatusesResult {
  return { projectId, yearMonth: '2026-08', items };
}

function cashflowInconsistentOverviewCycle(): CashflowSettlementCycle {
  return {
    ...cashflowWeeklyOverviewCycle(),
    businessState: 'INCONSISTENT', health: 'UNAVAILABLE', workflowRevision: -1,
    commandCapabilities: Object.fromEntries(cashflowSettlementCycleCommands.map((command) => [
      command, { allowed: false, reasonCode: 'PROJECTION_NOT_READY' },
    ])) as CashflowSettlementCycle['commandCapabilities'],
  };
}

function cashflowWeeklyOverviewData(
  settlementCycle: CashflowSettlementCycle = cashflowWeeklyOverviewCycle(),
) {
  return {
    version: '5', yearMonth: '2026-08',
    monthCloseTargetYearMonth: '2026-07', monthCloseTargetLabel: '7월',
    items: [{
      projectId: 'p001', settlementStatuses: cashflowWeeklyOverviewStatuses('p001'),
      projectionActualSummary: null, sheetCapturedAt: '2026-08-25T07:48:00.000Z', settlementCycle,
    }],
    errors: [],
  };
}

function asMockClient<T extends {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  patch?: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
}>(client: T): T & PlatformApiClientLike {
  return client as T & PlatformApiClientLike;
}

describe('platform-bff-client', () => {
  it('forwards professional profile filters and cancellation to the participation BFF', async () => {
    const snapshot = { professionalProfileAccess: true, members: [] };
    const client = asMockClient({
      get: vi.fn().mockResolvedValue({ data: snapshot }),
      post: vi.fn(),
      request: vi.fn(),
    });
    const controller = new AbortController();

    await expect(fetchParticipationDashboardViaBff({
      tenantId: 'mysc',
      actor: { uid: 'admin-1', role: 'admin' },
      year: '2026',
      ruleId: 'koica',
      signal: controller.signal,
      client,
    })).resolves.toBe(snapshot);

    // 학력·어학·자격 필터는 인력 명부(People)로 옮겼다. 참여율 조회는 연도와 규칙만 받는다.
    expect(client.get).toHaveBeenCalledWith(
      '/api/v1/participation-dashboard?year=2026&ruleId=koica',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('keeps profile capability outside the global PersonRecord items', async () => {
    const response = {
      items: [{ personId: 'person-a', name: '김정태' }],
      total: 1,
      capabilities: { professionalProfileRead: true, professionalProfileWrite: false },
    };
    const client = asMockClient({
      get: vi.fn().mockResolvedValue({ data: response }),
      post: vi.fn(),
      request: vi.fn(),
    });

    const controller = new AbortController();
    await expect(fetchPersonsViaBff({
      tenantId: 'mysc', actor: { uid: 'finance-a', role: 'finance' }, signal: controller.signal, client,
    })).resolves.toBe(response);
    expect(response.items[0]).not.toHaveProperty('professionalProfile');
    expect(client.get).toHaveBeenCalledWith('/api/v1/persons', expect.objectContaining({ signal: controller.signal }));
  });

  it('uses the caller-owned idempotency key for atomic person plus optional profile creation', async () => {
    const created = { person: { personId: 'person-a', name: '김메리' }, professionalProfile: { revision: 1, changed: true } };
    const client = asMockClient({
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ data: created }),
      request: vi.fn(),
    });
    const professionalProfile = { educationRecords: [], englishEvidence: [], certifications: [{ label: 'PMP' }] };

    await expect(createPersonViaBff({
      tenantId: 'mysc', actor: { uid: 'admin-a', role: 'admin' },
      idempotencyKey: 'person-create-attempt-a',
      person: {
        name: '김메리', employment: { type: 'PARTNER', state: 'WORKING', effectiveFrom: '2026-08-25' },
        professionalProfile,
      },
      client,
    })).resolves.toBe(created);

    expect(client.post).toHaveBeenCalledWith('/api/v1/persons', expect.objectContaining({
      idempotencyKey: 'person-create-attempt-a', retries: 0,
      body: expect.objectContaining({ professionalProfile }),
    }));
  });

  it('previews a participation sheet with a read-only GET request', async () => {
    const preview = { ok: true, rows: [], months: [], blocking: [] };
    const client = asMockClient({
      get: vi.fn().mockResolvedValue({ data: preview }),
      post: vi.fn(),
      request: vi.fn(),
    });

    await expect(previewParticipationSheetByLinkViaBff({
      tenantId: 'mysc',
      actor: { uid: 'admin-1', role: 'admin' },
      sheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit?usp=sharing',
      contractStart: '2026-01-01',
      contractEnd: '2026-12-31',
      projectId: 'project-a',
      client,
    })).resolves.toEqual(preview);

    expect(client.post).not.toHaveBeenCalled();
    expect(client.get).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/v1\/participation-dashboard\/sheet-preview\?/),
      expect.objectContaining({ tenantId: 'mysc', timeoutMs: 30000, retries: 0 }),
    );
    const requestPath = client.get.mock.calls[0][0] as string;
    const query = new URL(requestPath, 'https://myscube.test').searchParams;
    expect(Object.fromEntries(query)).toEqual({
      sheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit?usp=sharing',
      contractStart: '2026-01-01',
      contractEnd: '2026-12-31',
      projectId: 'project-a',
    });
  });

  it('uses the JVM status transition hook for WEEK approvals', async () => {
    const status = { projectId: 'p001', yearMonth: '2026-08', items: [] };
    const client = asMockClient({
      get: vi.fn(),
      post: vi.fn().mockResolvedValueOnce({ data: status }),
      request: vi.fn(),
    });
    const common = { tenantId: 'mysc', actor: { uid: 'head-1', role: 'admin' }, projectId: 'p001', yearMonth: '2026-08', client };

    await transitionCashflowSettlementStatusViaBff({ ...common, period: 'WEEK_2', action: 'APPROVE' });

    expect(client.get).not.toHaveBeenCalled();
    expect(client.post).toHaveBeenCalledWith('/api/v1/cashflow/p001/settlement-statuses/transition', expect.objectContaining({
      body: { yearMonth: '2026-08', period: 'WEEK_2', action: 'APPROVE' },
    }));
  });

  it('does not report a direct canonical review as successful until approval is complete', async () => {
    const monthRequest = {
      requestId: 'p001-2026-08', projectId: 'p001', yearMonth: '2026-08', status: 'PENDING',
      revision: 3, manifestHash: 'sha256:manifest', reviewWarnings: [],
    };
    const client = asMockClient({
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ data: { request: { ...monthRequest, status: 'APPROVING' } } }),
      request: vi.fn(),
    });

    await expect(reviewCashflowMonthCloseRequestViaBff({
      tenantId: 'mysc', actor: { uid: 'head-1', role: 'admin' }, projectId: 'p001', requestId: monthRequest.requestId,
      payload: { decision: 'APPROVE', expectedRevision: 3, expectedManifestHash: 'sha256:manifest' },
      idempotencyKey: 'month-close-review-1', client,
    })).rejects.toThrow('월 결산 승인 상태를 확인하지 못했습니다.');
  });

  it('posts all settlement project IDs in one bounded batch request', async () => {
    const data = {
      items: [cashflowWeeklyOverviewStatuses('p001')],
      errors: [{ projectId: 'p002', code: 'STATUS_UNAVAILABLE' as const }],
    };
    const client = asMockClient({ post: vi.fn(async () => ({ data })), get: vi.fn(), request: vi.fn() });
    const result = await fetchCashflowSettlementStatusesBatchViaBff({
      tenantId: 'mysc', actor: { uid: 'admin-1', role: 'admin' },
      projectIds: ['p001', 'p002'], yearMonth: '2026-08', client,
    });

    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith('/api/v1/cashflow/settlement-statuses/batch', expect.objectContaining({
      body: { projectIds: ['p001', 'p002'], yearMonth: '2026-08' }, retries: 0, timeoutMs: 12000,
    }));
    expect(result).toEqual(data);
  });

  it.each([
    ['missing project coverage', () => ({
      items: [cashflowWeeklyOverviewStatuses('p001')], errors: [],
    })],
    ['malformed settlement status', () => {
      const settlement = cashflowWeeklyOverviewStatuses('p001');
      Reflect.set(settlement.items[1], 'deadlineAt', null);
      return {
        items: [settlement], errors: [{ projectId: 'p002', code: 'STATUS_UNAVAILABLE' }],
      };
    }],
  ])('fails a settlement batch closed for %s', async (_label, response) => {
    const client = asMockClient({
      post: vi.fn(async () => ({ data: response() })), get: vi.fn(), request: vi.fn(),
    });

    await expect(fetchCashflowSettlementStatusesBatchViaBff({
      tenantId: 'mysc', actor: { uid: 'admin-1', role: 'admin' },
      projectIds: ['p001', 'p002'], yearMonth: '2026-08', client,
    })).rejects.toThrow('현금흐름 정산 상태 응답이 올바르지 않습니다.');
  });

  it('posts project IDs and the selected month to the sheet-formula projection-actual summary adapter', async () => {
    const data = {
      version: '2',
      items: Array.from({ length: 9 }, (_, index) => ({
        projectId: `p00${index + 1}`, fromMonth: '2023-01',
        comparisonAsOfWeek: { yearMonth: '2026-08', weekNo: 4 },
        source: 'SHEET_FORMULA' as const, sourceRevision: `source-${index}`,
        differenceAmount: 10_000_000,
        settlementDifferenceAmount: 18_371_453 + index, settlementMatches: false,
        periods: [{ period: 'MONTH' as const, differenceAmount: 10_000_000 }],
      })),
      errors: [{ projectId: 'p010', code: 'SUMMARY_UNAVAILABLE' as const }],
    };
    const client = asMockClient({
      post: vi.fn(async () => ({ data })), get: vi.fn(), request: vi.fn(),
    });

    const result = await fetchCashflowProjectionActualSummariesViaBff({
      tenantId: 'mysc', actor: { uid: 'u001', role: 'pm' }, projectIds: Array.from({ length: 10 }, (_, index) => `p0${String(index + 1).padStart(2, '0')}`), yearMonth: '2026-11', client,
    });

    expect(result).toBe(data);
    expect(client.post).toHaveBeenCalledWith('/api/v1/cashflow/projection-actual-summary/batch', expect.objectContaining({
      body: { projectIds: Array.from({ length: 10 }, (_, index) => `p0${String(index + 1).padStart(2, '0')}`), yearMonth: '2026-11' }, retries: 0, timeoutMs: 12000,
    }));
    expect(result.items).toHaveLength(9);
    expect(result.errors).toEqual([{ projectId: 'p010', code: 'SUMMARY_UNAVAILABLE' }]);
  });

  it('posts all visible projects once to the weekly overview without rejecting unavailable summaries', async () => {
    const projectIds = Array.from({ length: 61 }, (_, index) => `p${index + 1}`);
    const data = {
      version: '5',
      yearMonth: '2026-08',
      monthCloseTargetYearMonth: '2026-07',
      monthCloseTargetLabel: '7월',
      items: projectIds.map((projectId) => ({
        projectId,
        settlementStatuses: cashflowWeeklyOverviewStatuses(projectId),
        projectionActualSummary: null,
        sheetCapturedAt: null,
        settlementCycle: cashflowWeeklyOverviewCycle(),
      })),
      errors: projectIds.map((projectId) => ({ projectId, code: 'SUMMARY_UNAVAILABLE' as const })),
    };
    const client = asMockClient({ post: vi.fn(async () => ({ data })), get: vi.fn(), request: vi.fn() });

    await expect(fetchCashflowWeeklyOverviewViaBff({
      tenantId: 'mysc', actor: { uid: 'u001', role: 'pm' }, projectIds, yearMonth: '2026-08', client,
    })).resolves.toBe(data);
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith('/api/v1/cashflow/weekly-overview', expect.objectContaining({
      body: { projectIds, yearMonth: '2026-08' }, retries: 0, timeoutMs: 12000,
    }));
  });

  it('preserves a complete v5 weekly status, canonical cycle, and stored mirror item', async () => {
    const summary = {
      projectId: 'p001', source: 'SHEET_FORMULA' as const, sourceRevision: 'source-1', fromMonth: '2026-01',
      comparisonAsOfWeek: { yearMonth: '2026-08', weekNo: 5 },
      differenceAmount: -12_345, settlementDifferenceAmount: -12_345, settlementMatches: false,
      display: {
        periodLabel: '누적 2026-01~2026-08 5주차', statusLabel: '불일치',
        statusTone: 'danger' as const, differenceLabel: '차액 -12,345원',
      },
      periods: ['MONTH', 'WEEK_1', 'WEEK_2', 'WEEK_3', 'WEEK_4', 'WEEK_5'].map((period) => ({
        period: period as 'MONTH' | 'WEEK_1' | 'WEEK_2' | 'WEEK_3' | 'WEEK_4' | 'WEEK_5',
        differenceAmount: period === 'WEEK_5' ? -12_345 : null,
      })),
    };
    const monthStatus = {
      period: 'MONTH' as const, status: 'SUBMITTED' as const,
      deadlineAt: '2026-08-10T15:00:00.000Z', approverDeadlineAt: '2026-08-31T15:00:00.000Z',
      submittedAt: '2026-08-11T01:00:00.000Z', submittedBy: 'pm-1', approvedAt: '', approvedBy: '', revision: 1,
    };
    const weekStatus = {
      period: 'WEEK_5' as const, status: 'COMPLETED' as const,
      deadlineAt: '2026-08-30T15:00:00.000Z', approverDeadlineAt: '2026-08-31T04:00:00.000Z',
      submittedAt: '2026-08-31T01:00:00.000Z', submittedBy: 'pm-1',
      approvedAt: '2026-08-31T02:00:00.000Z', approvedBy: 'head-1', revision: 2,
    };
    const data = {
      version: '5' as const, yearMonth: '2026-08',
      monthCloseTargetYearMonth: '2026-07', monthCloseTargetLabel: '7월',
      items: [{
        projectId: 'p001',
        settlementStatuses: cashflowWeeklyOverviewStatuses('p001', [
          monthStatus,
          ...Array.from({ length: 4 }, (_, index) => ({
            period: `WEEK_${index + 1}` as 'WEEK_1' | 'WEEK_2' | 'WEEK_3' | 'WEEK_4',
            status: 'WAITING_FOR_UPDATE' as const,
            deadlineAt: '2026-08-06T15:00:00.000Z',
            approverDeadlineAt: '2026-08-07T04:00:00.000Z',
            submittedAt: '', submittedBy: '', approvedAt: '', approvedBy: '', revision: 0,
          })),
          weekStatus,
        ]),
        projectionActualSummary: summary,
        sheetCapturedAt: '2026-08-25T07:48:00.000Z',
        settlementCycle: cashflowWeeklyOverviewCycle(monthStatus),
      }],
      errors: [],
    };
    const client = asMockClient({ post: vi.fn(async () => ({ data })), get: vi.fn(), request: vi.fn() });

    await expect(fetchCashflowWeeklyOverviewViaBff({
      tenantId: 'mysc', actor: { uid: 'u001', role: 'pm' },
      projectIds: ['p001'], yearMonth: '2026-08', client,
    })).resolves.toBe(data);
  });

  it('accepts the canonical INCONSISTENT persistence sentinel revision', async () => {
    const data = cashflowWeeklyOverviewData(cashflowInconsistentOverviewCycle());
    const client = asMockClient({ post: vi.fn(async () => ({ data })), get: vi.fn(), request: vi.fn() });

    await expect(fetchCashflowWeeklyOverviewViaBff({
      tenantId: 'mysc', actor: { uid: 'u001', role: 'pm' },
      projectIds: ['p001'], yearMonth: '2026-08', client,
    })).resolves.toBe(data);
  });

  it('accepts a structurally valid superseded catch-up cycle without reinterpreting its lifecycle', async () => {
    const commandCapabilities = Object.fromEntries(cashflowSettlementCycleCommands.map((command) => [
      command, { allowed: false, reasonCode: 'BUSINESS_STATE_NOT_ELIGIBLE' },
    ])) as CashflowSettlementCycle['commandCapabilities'];
    commandCapabilities.REQUEST_MONTH_REOPEN = { allowed: true, reasonCode: '' };
    const data = cashflowWeeklyOverviewData({
      ...cashflowWeeklyOverviewCycle(), businessState: 'LOCKED', workflowRevision: 2,
      monthCloseSettlement: null,
      provenance: {
        affectedFromMonth: '2026-01', affectedThroughMonth: '2026-08', closedByCycleYearMonth: '2026-09',
        approvalVersionId: 'approval-2', requestId: 'p001-2026-09', ledgerRevision: 2,
        rootHash: `sha256:${'a'.repeat(64)}`,
      },
      commandCapabilities,
    });
    const client = asMockClient({ post: vi.fn(async () => ({ data })), get: vi.fn(), request: vi.fn() });

    await expect(fetchCashflowWeeklyOverviewViaBff({
      tenantId: 'mysc', actor: { uid: 'u001', role: 'pm' },
      projectIds: ['p001'], yearMonth: '2026-08', client,
    })).resolves.toBe(data);
  });

  it.each([
    ['wrong response version', (data: any) => { data.version = '3'; }],
    ['legacy response version', (data: any) => { data.version = '4'; }],
    ['foreign settlement project', (data: any) => { data.items[0].settlementStatuses.projectId = 'foreign'; }],
    ['foreign settlement month', (data: any) => { data.items[0].settlementStatuses.yearMonth = '2026-07'; }],
    ['missing settlement cycle', (data: any) => { delete data.items[0].settlementCycle; }],
    ['foreign settlement cycle', (data: any) => { data.items[0].settlementCycle.cycleYearMonth = '2026-09'; }],
    ['foreign weekly cycle', (data: any) => { data.items[0].settlementCycle.weeklyYearMonth = '2026-09'; }],
    ['foreign month-close target', (data: any) => { data.items[0].settlementCycle.monthCloseTargetYearMonth = '2026-06'; }],
    ['non-previous shared month-close target', (data: any) => {
      data.monthCloseTargetYearMonth = '2026-06';
      data.items[0].settlementCycle.monthCloseTargetYearMonth = '2026-06';
    }],
    ['malformed cycle capabilities', (data: any) => { delete data.items[0].settlementCycle.commandCapabilities.SUBMIT_MONTH_CLOSE; }],
    ['negative revision outside INCONSISTENT', (data: any) => { data.items[0].settlementCycle.workflowRevision = -1; }],
    ['revision below the INCONSISTENT sentinel', (data: any) => {
      data.items[0].settlementCycle = { ...cashflowInconsistentOverviewCycle(), workflowRevision: -2 };
    }],
    ['non-public status error', (data: any) => { data.errors = [{ projectId: 'p001', code: 'STATUS_UNAVAILABLE' }]; }],
    ['legacy MONTH pending status', (data: any) => { data.items[0].settlementStatuses.items[0].status = 'PENDING_APPROVAL'; }],
    ['legacy MONTH completed status', (data: any) => { data.items[0].settlementStatuses.items[0].status = 'COMPLETED'; }],
    ['MONTH-only status on a week', (data: any) => { data.items[0].settlementStatuses.items[1].status = 'LOCKED'; }],
    ['foreign summary project', (data: any) => {
      data.items[0].projectionActualSummary = {
        projectId: 'foreign', source: 'SHEET_FORMULA', sourceRevision: 'source-1', fromMonth: '2026-01',
        comparisonAsOfWeek: { yearMonth: '2026-08', weekNo: 5 }, differenceAmount: 1,
        settlementDifferenceAmount: 1, settlementMatches: false, periods: [],
      };
    }],
    ['summary without its stored display labels', (data: any) => {
      data.items[0].projectionActualSummary = {
        projectId: 'p001', source: 'SHEET_FORMULA', sourceRevision: 'source-1', fromMonth: '2026-01',
        comparisonAsOfWeek: { yearMonth: '2026-08', weekNo: 5 }, differenceAmount: 1,
        settlementDifferenceAmount: 1, settlementMatches: false, periods: [],
      };
    }],
    ['malformed capture timestamp', (data: any) => { data.items[0].sheetCapturedAt = 'not-an-instant'; }],
    ['duplicate settlement period', (data: any) => {
      data.items[0].settlementStatuses.items.push({ ...data.items[0].settlementStatuses.items[1] });
    }],
    ['missing settlement week', (data: any) => {
      data.items[0].settlementStatuses.items = data.items[0].settlementStatuses.items
        .filter((item: any) => item.period !== 'WEEK_3');
    }],
    ['malformed settlement timestamps', (data: any) => {
      data.items[0].settlementStatuses.items[1].submittedAt = 'not-an-instant';
      data.items[0].settlementStatuses.items[1].deadlineAt = null;
    }],
  ])('fails closed for a weekly overview with %s', async (_label, mutate) => {
    const data: any = cashflowWeeklyOverviewData();
    mutate(data);
    const client = asMockClient({ post: vi.fn(async () => ({ data })), get: vi.fn(), request: vi.fn() });

    await expect(fetchCashflowWeeklyOverviewViaBff({
      tenantId: 'mysc', actor: { uid: 'u001', role: 'pm' },
      projectIds: ['p001'], yearMonth: '2026-08', client,
    })).rejects.toThrow('현금흐름 현황 응답이 올바르지 않습니다.');
  });

  it.each([
    { errors: [{ projectId: 'foreign', code: 'SUMMARY_UNAVAILABLE' }] },
    { errors: [{ projectId: 'p001', code: 'OTHER_ERROR' }] },
    { errors: 'malformed' },
  ])('fails closed for malformed or foreign canonical summary errors: %j', async (invalid) => {
    const client = asMockClient({
      post: vi.fn(async () => ({ data: { version: '1', items: [], ...invalid } })), get: vi.fn(), request: vi.fn(),
    });
    await expect(fetchCashflowProjectionActualSummariesViaBff({
      tenantId: 'mysc', actor: { uid: 'u001', role: 'pm' }, projectIds: ['p001'], client,
    })).rejects.toThrow('JVM 누적 Projection-Actual 요약 응답이 올바르지 않습니다.');
  });

  it('preserves the server cumulative close scope without deriving counts', async () => {
    const cumulativeCloseScope = {
      contractVersion: 'cashflow-cumulative-close-v2',
      fromMonth: '2023-01',
      throughMonth: '2026-08',
      lockRange: { fromMonth: '2023-01', fromWeekNo: 1, throughMonth: '2026-08', throughWeekNo: 5 },
      monthCount: 44,
      weekCount: 220,
      cellCount: 7040,
      source: {
        sourceRevision: 'source-1',
        targetRevision: 'target-1',
        capturedAt: '2026-07-01T00:00:00.000Z',
        spreadsheetId: 'spreadsheet-a',
        spreadsheetTitle: '2026 사업비 관리 시트',
        selectedSheetName: 'cashflow(사용내역 연동)',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/spreadsheet-a/edit',
      },
    } satisfies CashflowCumulativeCloseScope;
    const projectionActualSummary = {
      projectId: 'p001', fromMonth: '2023-01',
      comparisonAsOfWeek: { yearMonth: '2026-08', weekNo: 4 },
      settlementDifferenceAmount: 18_371_453, settlementMatches: false,
    };
    const client = asMockClient({
      get: vi.fn(async () => ({ data: { dashboard: { cumulativeCloseScope, projectionActualSummary } } })),
      post: vi.fn(), request: vi.fn(),
    });

    const result = await fetchCashflowMonthCloseViaBff({
      tenantId: 'mysc', actor: { uid: 'u001', role: 'pm' }, projectId: 'p001', yearMonth: '2026-08', client,
    });

    expect(result.dashboard?.cumulativeCloseScope).toEqual(cumulativeCloseScope);
    expect(result.dashboard?.cumulativeCloseScope?.weekCount).toBe(220);
    expect(result.dashboard?.cumulativeCloseScope?.cellCount).toBe(7040);
    expect(result.dashboard?.projectionActualSummary).toBe(projectionActualSummary);
    expect(result.dashboard?.projectionActualSummary?.settlementDifferenceAmount).toBe(18_371_453);
  });

  it('passes through the server presentation, actions, and operations summary unchanged', async () => {
    const presentation = {
      asOfDate: '2026-08-14',
      annualBefore: [{ year: 2024, label: '2024년' }],
      annualAfter: [{ year: 2027, label: '2027년' }],
      weeks: [{
        yearMonth: '2026-08', weekNo: 3, weekStart: '2026-08-10', weekEnd: '2026-08-16',
        label: '26-8-3', isCurrent: true, monthStatus: 'OPEN' as const, monthStatusLabel: '결산 전',
        weeklyStatus: 'COMPLETED_LATE' as const, weeklyStatusLabel: '기한 후 완료', overdue: false,
        statusLabel: '기한 후 완료', surfaceTone: 'success' as const,
      }],
      months: [{
        yearMonth: '2026-08', label: '2026년 08월', columnCount: 5, status: 'OPEN' as const,
        locked: false, overdue: false, badgeLabel: '', tone: 'default' as const,
      }],
      comparison: {
        annualBefore: [{ year: 2024, label: '2024년' }], annualAfter: [],
        weeks: [], cells: [], changed: false, periodLabel: '2024년 ~ 2026-08 3주차',
      },
      monthClose: { statusLabel: '결산 전', tone: 'neutral' as const },
      evidenceSource: 'DASHBOARD' as const,
    } satisfies CashflowMonthClosePresentation;
    const actions = {
      completeWeekly: { enabled: false, guide: '주간 가이드' },
      reopenWeekly: { enabled: false, guide: '주간 회수 가이드' },
      confirmWeekly: { enabled: false, guide: '주간 확정 가이드' },
      changeExecutiveApprover: { enabled: false, guide: '조직장 가이드' },
      requestMonthClose: { enabled: false, guide: '서버 가이드', label: '월 결산 요청' },
      withdrawMonthClose: { enabled: false, guide: '회수 가이드' },
      requestMonthReopen: { enabled: false, guide: '재오픈 가이드' },
      cumulativeScope: { ready: false, guide: '누적 범위 가이드' },
    } satisfies CashflowMonthCloseActions;
    const operationsSummary = {
      status: {
        kind: 'blocked', tone: 'danger', count: 2, label: '서버 요약', detail: '서버 상세',
      },
      rates: {
        projection: { state: 'AVAILABLE', percent: 77, barPercent: 77, statusLabel: '미달' },
        actual: { state: 'UNAVAILABLE', percent: null, barPercent: 0, statusLabel: '확인 필요' },
      },
    } satisfies CashflowOperationsSummary;
    const sectionErrors = [{ section: 'cashflow', code: 'sentinel', label: '서버 섹션명' }];
    const data = { projectId: 'p001', yearMonth: '2026-08', presentation, actions, operationsSummary, sectionErrors };
    const client = asMockClient({ get: vi.fn(async () => ({ data })), post: vi.fn(), request: vi.fn() });

    const result = await fetchCashflowMonthCloseViaBff({
      tenantId: 'mysc', actor: { uid: 'u001', role: 'pm' }, projectId: 'p001', yearMonth: '2026-08', client,
    });

    expect(result.presentation).toBe(presentation);
    expect(result.actions).toBe(actions);
    expect(result.operationsSummary).toBe(operationsSummary);
    expect(result.sectionErrors).toBe(sectionErrors);
  });

  it('sends cashflow metadata intents with the exact project lease and no client audit fields', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({ data: { ok: true } })), get: vi.fn(), request: vi.fn(),
    });
    const actor = { uid: 'u001', role: 'pm' };
    await applyCashflowVarianceIntentViaBff({
      tenantId: 'mysc', actor, projectId: 'p001', lease: cashflowLease,
      idempotencyKey: 'variance-1',
      intent: { sheetId: 'p001-2026-07-w1', expectedRevision: 2, action: 'REPLY', content: '확인했습니다' },
      client,
    });
    await applyWeeklySubmissionStatusIntentViaBff({
      tenantId: 'mysc', actor, projectId: 'p001', lease: cashflowLease,
      idempotencyKey: 'status-1',
      intent: { yearMonth: '2026-07', weekNo: 1, expectedRevision: 3, changes: { expenseUpdated: true } },
      client,
    });
    await applyEvidenceRequiredMapIntentViaBff({
      tenantId: 'mysc', actor, projectId: 'p001', lease: cashflowLease,
      idempotencyKey: 'evidence-map-1',
      intent: { expectedRevision: 4, map: { '사업비|교통비': '영수증' } },
      client,
    });

    expect(client.post).toHaveBeenNthCalledWith(1, '/api/v1/cashflow-metadata/p001/variance', expect.objectContaining({
      body: { sheetId: 'p001-2026-07-w1', expectedRevision: 2, action: 'REPLY', content: '확인했습니다' },
      headers: expect.objectContaining({ 'x-edit-session-id': 'session-a', 'x-edit-fence': '7' }),
      idempotencyKey: 'variance-1',
    }));
    expect(client.post).toHaveBeenNthCalledWith(2, '/api/v1/cashflow-metadata/p001/weekly-submission-status', expect.objectContaining({
      body: { yearMonth: '2026-07', weekNo: 1, expectedRevision: 3, changes: { expenseUpdated: true } },
      headers: expect.objectContaining({ 'x-edit-session-id': 'session-a', 'x-edit-fence': '7' }),
      idempotencyKey: 'status-1',
    }));
    expect(client.post).toHaveBeenNthCalledWith(3, '/api/v1/cashflow-metadata/p001/evidence-required-map', expect.objectContaining({
      body: { expectedRevision: 4, map: { '사업비|교통비': '영수증' } },
      headers: expect.objectContaining({ 'x-edit-session-id': 'session-a', 'x-edit-fence': '7' }),
      idempotencyKey: 'evidence-map-1',
    }));
  });

  it('final-saves all projection lines in one fenced JVM command', async () => {
    const client = asMockClient({ post: vi.fn(async () => ({ data: { ok: true } })), get: vi.fn(), request: vi.fn() });
    const lines = [
      { yearMonth: '2026-07', weekNo: 1, cashflowLine: 'SALES_IN', amount: 1000 },
      { yearMonth: '2026-07', weekNo: 2, cashflowLine: 'DIRECT_COST_OUT', amount: 400 },
    ];
    await saveCashflowProjectionBatchViaBff({
      tenantId: 'mysc', actor: { uid: 'u001', role: 'pm' }, projectId: 'p001',
      lines, idempotencyKey: 'projection-final-1', lease: cashflowLease, finalize: true, client,
    });
    expect(client.post).toHaveBeenCalledWith('/api/v1/cashflow/p001/projection', expect.objectContaining({
      body: { lines },
      headers: expect.objectContaining({ 'x-edit-fence': '7', 'x-edit-finalize': 'true' }),
    }));
  });

  it('uses the approval-backed month-close contract for request, review, withdrawal, and reopen', async () => {
    const client = asMockClient({
      get: vi.fn(async () => ({ data: {
        ok: true,
        projectId: 'p001',
        yearMonth: '2026-06',
        status: 'CLOSED',
      } })),
      post: vi.fn(async (path: string) => ({ data: {
        ok: true,
        projectId: 'p001',
        yearMonth: '2026-06',
        status: 'CLOSED',
        request: { status: path.endsWith('/withdraw') ? 'WITHDRAWN' : 'APPROVED' },
      } })),
      request: vi.fn(),
    });
    const actor = { uid: 'u001', role: 'pm' };

    await fetchCashflowMonthCloseViaBff({
      tenantId: 'mysc', actor, projectId: 'p001', yearMonth: '2026-06', client,
    });
    await requestCashflowMonthCloseViaBff({
      tenantId: 'mysc', actor, projectId: 'p001', idempotencyKey: 'month-close-1',
      payload: {
        contractVersion: 'cashflow-cumulative-close-v2',
        yearMonth: '2026-06',
        expectedRevision: 2,
        expectedWorkflowRevision: 3,
        expectedApproverUid: 'head-1',
        expectedProjectVersion: 4,
        expectedOpeningBalances: {
          selectedYear: 2026,
          projection: { amount: 0, lineAmounts: {}, sources: [], includedYears: [], excludedWeeklyYears: [] },
          actual: { amount: 0, lineAmounts: {}, sources: [], includedYears: [], excludedWeeklyYears: [] },
        },
        closeInput: { yearMonth: '2026-06' } as never,
      },
      client,
    });
    await fetchPendingCashflowMonthCloseRequestsViaBff({
      tenantId: 'mysc', actor: { uid: 'head-1', role: 'viewer' }, client,
    });
    await fetchCashflowMonthCloseRequestMonthsViaBff({
      tenantId: 'mysc', actor: { uid: 'head-1', role: 'viewer' }, projectId: 'p001',
      requestId: 'p001-2026-06', requestRevision: 1, cursor: '2023-12', limit: 12, client,
    });
    await reviewCashflowMonthCloseRequestViaBff({
      tenantId: 'mysc', actor: { uid: 'head-1', role: 'viewer' }, projectId: 'p001',
      requestId: 'p001-2026-06', idempotencyKey: 'month-close-review-1',
      payload: { decision: 'APPROVE', expectedRevision: 1, expectedManifestHash: 'sha256:manifest', reason: '확인 완료' }, client,
    });
    await withdrawCashflowMonthCloseRequestViaBff({
      tenantId: 'mysc', actor, projectId: 'p001', requestId: 'p001-2026-06',
      idempotencyKey: 'month-close-withdraw-1',
      payload: {
        cycleYearMonth: '2026-06', monthCloseTargetYearMonth: '2026-05',
        expectedRevision: 1, expectedManifestHash: 'sha256:manifest',
        expectedWorkflowRevision: 3, reason: '다시 확인',
      },
      client,
    });
    await requestCashflowMonthReopenViaBff({
      tenantId: 'mysc', actor, projectId: 'p001', idempotencyKey: 'reopen-request-1',
      payload: { requestId: 'p001-2026-06', yearMonth: '2026-06', expectedRevision: 3, reason: '증빙 정정 필요' },
      client,
    });
    await decideCashflowMonthReopenViaBff({
      tenantId: 'mysc', actor: { uid: 'finance-1', role: 'finance' }, projectId: 'p001',
      idempotencyKey: 'reopen-decision-1',
      payload: { requestId: 'p001-2026-06', yearMonth: '2026-06', expectedRevision: 4, decision: 'APPROVE', reason: '확인 완료' },
      client,
    });

    expect(client.get).toHaveBeenCalledWith(
      '/api/v1/cashflow/p001/month-close?yearMonth=2026-06',
      expect.objectContaining({ retries: 0 }),
    );
    expect(client.post).toHaveBeenNthCalledWith(1, '/api/v1/cashflow/p001/month-close/requests', expect.objectContaining({
      idempotencyKey: 'month-close-1',
      timeoutMs: 27_000,
      body: expect.objectContaining({
        contractVersion: 'cashflow-cumulative-close-v2',
        yearMonth: '2026-06',
        expectedRevision: 2,
        expectedWorkflowRevision: 3,
        settlementCycle: true,
        closeInput: { yearMonth: '2026-06' },
      }),
    }));
    expect(client.post).toHaveBeenNthCalledWith(
      1,
      '/api/v1/cashflow/p001/month-close/requests',
      expect.not.objectContaining({ headers: expect.anything() }),
    );
    expect(client.get).toHaveBeenNthCalledWith(2, '/api/v1/cashflow/month-close/requests/pending', expect.objectContaining({ retries: 0 }));
    expect(client.get).toHaveBeenNthCalledWith(
      3,
      '/api/v1/cashflow/p001/month-close/requests/p001-2026-06/months?limit=12&cursor=2023-12',
      expect.objectContaining({ retries: 0 }),
    );
    expect(client.post).toHaveBeenNthCalledWith(2, '/api/v1/cashflow/p001/month-close/requests/p001-2026-06/status-review', expect.objectContaining({
      idempotencyKey: 'month-close-review-1',
      body: { decision: 'APPROVE', expectedRevision: 1, expectedManifestHash: 'sha256:manifest', reason: '확인 완료', settlementCycle: true },
      timeoutMs: 12_000,
    }));
    expect(client.post).toHaveBeenNthCalledWith(
      3,
      '/api/v1/cashflow/p001/month-close/requests/p001-2026-06/withdraw',
      expect.objectContaining({
        idempotencyKey: 'month-close-withdraw-1',
        body: expect.objectContaining({ settlementCycle: true }),
      }),
    );
    expect(client.post).toHaveBeenNthCalledWith(
      4,
      '/api/v1/cashflow/p001/month-close/reopen-request',
      expect.objectContaining({
        idempotencyKey: 'reopen-request-1',
        body: { requestId: 'p001-2026-06', yearMonth: '2026-06', expectedRevision: 3, reason: '증빙 정정 필요', settlementCycle: true },
      }),
    );
    expect(client.post).toHaveBeenNthCalledWith(
      4,
      '/api/v1/cashflow/p001/month-close/reopen-request',
      expect.not.objectContaining({ headers: expect.anything() }),
    );
    expect(client.post).toHaveBeenNthCalledWith(
      5,
      '/api/v1/cashflow/p001/month-close/reopen-decision',
      expect.objectContaining({
        idempotencyKey: 'reopen-decision-1',
        body: { requestId: 'p001-2026-06', yearMonth: '2026-06', expectedRevision: 4, decision: 'APPROVE', reason: '확인 완료', settlementCycle: true },
      }),
    );
    expect(client.post).toHaveBeenNthCalledWith(
      5,
      '/api/v1/cashflow/p001/month-close/reopen-decision',
      expect.not.objectContaining({ headers: expect.anything() }),
    );
  });

  it('persists the designated month-close approver through the cashflow BFF', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          projectId: 'p001',
          executiveApproverId: 'head-a',
          executiveApproverName: '조직장 A',
          executiveApproverEmail: 'head-a@example.com',
          version: 3,
          updatedAt: '2026-07-29T00:00:00.000Z',
        },
      })),
      get: vi.fn(),
      request: vi.fn(),
    });

    const result = await saveCashflowMonthCloseApproverViaBff({
      tenantId: 'mysc',
      actor: { uid: 'pm-a', role: 'pm', idToken: 'token-abc' },
      projectId: 'p001',
      payload: { approverUid: 'head-a', yearMonth: '2026-07', expectedVersion: 2 },
      idempotencyKey: 'approver-p001-2026-07-head-a',
      client,
    });

    expect(client.post).toHaveBeenCalledWith('/api/v1/cashflow/p001/month-close/approver', expect.objectContaining({
      tenantId: 'mysc',
      body: expect.objectContaining({ approverUid: 'head-a', yearMonth: '2026-07', expectedVersion: 2 }),
      idempotencyKey: 'approver-p001-2026-07-head-a',
    }));
    expect(result).toMatchObject({ executiveApproverId: 'head-a', version: 3 });
  });

  it('coalesces concurrent month-close reads per actor and releases the key after completion', async () => {
    let finishFirstRequest: ((value: { data: { ok: true; projectId: string; yearMonth: string; status: 'OPEN' } }) => void) | undefined;
    const firstResponse = new Promise<{ data: { ok: true; projectId: string; yearMonth: string; status: 'OPEN' } }>((resolve) => {
      finishFirstRequest = resolve;
    });
    const client = asMockClient({
      get: vi.fn()
        .mockImplementationOnce(() => firstResponse)
        .mockResolvedValue({ data: { ok: true, projectId: 'p001', yearMonth: '2026-07', status: 'OPEN' } }),
      post: vi.fn(),
      request: vi.fn(),
    });
    const input = {
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'pm' },
      projectId: 'p001',
      yearMonth: '2026-07',
      client,
    };

    const first = fetchCashflowMonthCloseViaBff(input);
    const duplicate = fetchCashflowMonthCloseViaBff(input);
    const otherMonth = fetchCashflowMonthCloseViaBff({ ...input, yearMonth: '2026-08' });
    expect(client.get).toHaveBeenCalledTimes(2);
    finishFirstRequest?.({ data: { ok: true, projectId: 'p001', yearMonth: '2026-07', status: 'OPEN' } });
    await expect(Promise.all([first, duplicate, otherMonth])).resolves.toHaveLength(3);

    await fetchCashflowMonthCloseViaBff(input);
    expect(client.get).toHaveBeenCalledTimes(3);
    expect(client.get).toHaveBeenLastCalledWith(
      '/api/v1/cashflow/p001/month-close?yearMonth=2026-07',
      expect.objectContaining({ retries: 0, timeoutMs: 27_000 }),
    );
  });

  it('uses project-scoped contracts for explicit weekly settlement completion', async () => {
    const client = asMockClient({
      get: vi.fn(async () => ({ data: { projectId: 'p001', yearMonth: '2026-06', weekNo: 2 } })),
      post: vi.fn(async () => ({ data: {
        projectId: 'p001', yearMonth: '2026-06', weekNo: 2, completedAt: '2026-07-16T09:00:00.000Z', alreadyCompleted: false,
      } })),
      request: vi.fn(),
    });
    const actor = { uid: 'finance-1', role: 'finance' };

    await completeCashflowWeeklyUpdateViaBff({
      tenantId: 'mysc', actor, projectId: 'p001', yearMonth: '2026-06', weekNo: 2, updateResult: 'CHANGED', client,
    });
    await fetchCashflowWeeklyUpdateViaBff({
      tenantId: 'mysc', actor, projectId: 'p001', yearMonth: '2026-06', weekNo: 2, client,
    });
    await reopenCashflowWeeklyUpdateViaBff({
      tenantId: 'mysc', actor, projectId: 'p001', yearMonth: '2026-06', weekNo: 2, client,
    });

    expect(client.post).toHaveBeenNthCalledWith(1, '/api/v1/cashflow/p001/weekly-update-complete', expect.objectContaining({
      body: { yearMonth: '2026-06', weekNo: 2, updateResult: 'CHANGED' },
    }));
    expect(client.get).toHaveBeenNthCalledWith(
      1,
      '/api/v1/cashflow/p001/weekly-update-complete?yearMonth=2026-06&weekNo=2',
      expect.objectContaining({ retries: 0 }),
    );
    // 회수는 사유 없이, revision 도 화면이 아니라 BFF 가 잠금 기록에서 읽는다.
    expect(client.post).toHaveBeenNthCalledWith(2, '/api/v1/cashflow/p001/weekly-update-complete/reopen', expect.objectContaining({
      body: { yearMonth: '2026-06', weekNo: 2 },
    }));
  });

  it('does not invent missing or zero weekly settlement scope values', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({ data: { ok: true } })),
      get: vi.fn(),
      request: vi.fn(),
    });
    const actor = { uid: 'finance-1', role: 'finance' };

    await completeCashflowWeeklyUpdateViaBff({
      tenantId: 'mysc', actor, projectId: 'p001', yearMonth: '2026-06', updateResult: 'NO_CHANGES', client,
    });
    await completeCashflowWeeklyUpdateViaBff({
      tenantId: 'mysc', actor, projectId: 'p001', weekNo: 0, updateResult: 'CHANGED', client,
    });

    expect(client.post).toHaveBeenNthCalledWith(
      1,
      '/api/v1/cashflow/p001/weekly-update-complete',
      expect.objectContaining({ body: { yearMonth: '2026-06', weekNo: undefined, updateResult: 'NO_CHANGES' } }),
    );
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      '/api/v1/cashflow/p001/weekly-update-complete',
      expect.objectContaining({ body: { yearMonth: undefined, weekNo: 0, updateResult: 'CHANGED' } }),
    );
  });

  it('sends an explicit projection validation override with its JVM evidence', async () => {
    const client = asMockClient({ post: vi.fn(async () => ({ data: { ok: true } })), get: vi.fn(), request: vi.fn() });
    await completeCashflowWeeklyUpdateViaBff({
      tenantId: 'mysc', actor: { uid: 'pm-1', role: 'pm' }, projectId: 'p001',
      yearMonth: '2026-08', weekNo: 2, updateResult: 'CHANGED',
      ignoreProjectionValidation: true,
      projectionValidationEvidenceHash: `sha256:${'a'.repeat(64)}`,
      projectionValidationIssueCount: 32,
      client,
    });
    expect(client.post).toHaveBeenCalledWith('/api/v1/cashflow/p001/weekly-update-complete', expect.objectContaining({
      body: expect.objectContaining({
        ignoreProjectionValidation: true,
        projectionValidationEvidenceHash: `sha256:${'a'.repeat(64)}`,
        projectionValidationIssueCount: 32,
      }),
    }));
  });

  it('reads canonical weekly compliance with bounded cursor paging', async () => {
    const client = asMockClient({ post: vi.fn(), get: vi.fn(async () => ({ data: { items: [], nextCursor: '', onTimeCount: 0, missedCount: 0 } })), request: vi.fn() });
    await fetchCashflowWeeklyComplianceViaBff({ tenantId: 'mysc', actor: { uid: 'admin-1', role: 'admin' }, projectId: 'p001', limit: 50, cursor: 'opaque/cursor', client });
    expect(client.get).toHaveBeenCalledWith('/api/v1/cashflow/p001/weekly-update-compliance?limit=50&cursor=opaque%2Fcursor', expect.objectContaining({ retries: 0 }));
  });

  it('reads paged applied cell changes without changing state or amounts', async () => {
    const page = { items: [{ beforeState: 'EMPTY', beforeAmount: null, afterState: 'ZERO', afterAmount: 0 }], nextCursor: 'next/cursor' };
    const client = asMockClient({ post: vi.fn(), get: vi.fn(async () => ({ data: page })), request: vi.fn() });
    const result = await fetchCashflowAppliedCellChangesViaBff({ tenantId: 'mysc', actor: { uid: 'admin-1', role: 'admin' }, projectId: 'p001', limit: 50, cursor: 'opaque/cursor', client });
    expect(client.get).toHaveBeenCalledWith('/api/v1/cashflow/p001/applied-cell-changes?limit=50&cursor=opaque%2Fcursor', expect.objectContaining({ retries: 0 }));
    expect(result).toEqual(page);
  });

  it('reads one bounded aggregate activity page with cursor and cancellation', async () => {
    const events = Array.from({ length: 101 }, (_, index) => ({ id: `event-${index}` }));
    const page = {
      projectId: 'p001',
      events,
      errors: [{ source: 'sheet_refresh' as const, code: 'cashflow_activity_source_unavailable' as const }],
      nextCursor: 'next/cursor',
    };
    const client = asMockClient({ post: vi.fn(), get: vi.fn(async () => ({ data: page })), request: vi.fn() });
    const controller = new AbortController();

    const result = await fetchCashflowActivityViaBff({
      tenantId: 'mysc', actor: { uid: 'admin-1', role: 'admin' }, projectId: 'p001',
      limit: 50, cursor: 'opaque/cursor', signal: controller.signal, client,
    });

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith('/api/v1/cashflow/p001/activity?limit=50&cursor=opaque%2Fcursor', expect.objectContaining({
      retries: 0,
      timeoutMs: 12000,
      signal: controller.signal,
    }));
    expect(result).toBe(page);
    expect(result.events).toHaveLength(101);
  });

  it('defaults the initial aggregate activity request to 50 documents', async () => {
    const page = { projectId: 'p001', events: [], errors: [], nextCursor: null };
    const client = asMockClient({ post: vi.fn(), get: vi.fn(async () => ({ data: page })), request: vi.fn() });

    await fetchCashflowActivityViaBff({
      tenantId: 'mysc', actor: { uid: 'admin-1', role: 'admin' }, projectId: 'p001', client,
    });

    expect(client.get).toHaveBeenCalledWith('/api/v1/cashflow/p001/activity?limit=50', expect.objectContaining({
      retries: 0,
      timeoutMs: 12000,
    }));
  });

  it('retries one failed activity source without reading the other sources', async () => {
    const page = { projectId: 'p001', source: 'audit' as const, events: [], errors: [], nextCursor: null };
    const client = asMockClient({ post: vi.fn(), get: vi.fn(async () => ({ data: page })), request: vi.fn() });
    const controller = new AbortController();

    const result = await fetchCashflowActivityViaBff({
      tenantId: 'mysc', actor: { uid: 'admin-1', role: 'admin' }, projectId: 'p001', source: 'audit', limit: 50, client,
      signal: controller.signal,
    });

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith('/api/v1/cashflow/p001/activity?limit=50&source=audit', expect.objectContaining({
      retries: 0,
      timeoutMs: 12000,
      signal: controller.signal,
    }));
    expect(result).toBe(page);
  });

  it('routes projection through the fenced JVM-owned BFF endpoint', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({ data: { ok: true, projectId: 'p001' } })),
      get: vi.fn(),
      request: vi.fn(),
    });

    await upsertCashflowWeekAmountsViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'pm' },
      projectId: 'p001',
      payload: { yearMonth: '2026-07', weekNo: 1, mode: 'projection', amounts: { SALES_IN: 1000 } },
      idempotencyKey: 'projection-1',
      lease: cashflowLease,
      client,
    });
    const headers = {
      'x-edit-session-id': 'session-a',
      'x-edit-lease-id': 'lease-a',
      'x-edit-fence': '7',
    };
    expect(client.post).toHaveBeenNthCalledWith(1, '/api/v1/cashflow/p001/projection', expect.objectContaining({
      idempotencyKey: 'projection-1', headers,
      body: { lines: [{ yearMonth: '2026-07', weekNo: 1, cashflowLine: 'SALES_IN', amount: 1000 }] },
    }));
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it('reads the current JVM sheet version before a fenced weekly draft save', async () => {
    const client = asMockClient({
      get: vi.fn(async () => ({ data: { ok: true, projectId: 'p001', sheetKey: 'default', sheetVersion: 3, rows: [] } })),
      post: vi.fn(async () => ({ data: { ok: true, projectId: 'p001', sheetVersion: 4 } })),
      request: vi.fn(),
    });
    const actor = { uid: 'u001', role: 'pm' };
    const current = await readWeeklyExpenseSheetViaBff({ tenantId: 'mysc', actor, projectId: 'p001', sheetKey: 'default', client });
    await saveWeeklyExpenseDraftViaBff({
      tenantId: 'mysc', actor, projectId: 'p001', sheetKey: 'default', idempotencyKey: 'draft-1',
      lease: cashflowLease,
      payload: { expectedSheetVersion: current.sheetVersion, sheetName: '기본 탭', rows: [] },
      client,
    });
    expect(client.get).toHaveBeenCalledWith('/api/v1/weekly-expenses/p001/sheets/default', expect.any(Object));
    expect(client.post).toHaveBeenCalledWith('/api/v1/weekly-expenses/p001/sheets/default/save-draft', expect.objectContaining({
      headers: expect.objectContaining({ 'x-edit-fence': '7' }),
      idempotencyKey: 'draft-1',
      body: { expectedSheetVersion: 3, sheetName: '기본 탭', rows: [] },
    }));
  });

  it('requires the same lease headers for bank import and apply', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({ data: { ok: true, projectId: 'p001', lines: [] } })),
      get: vi.fn(), request: vi.fn(),
    });
    const actor = { uid: 'u001', role: 'pm' };
    await importBankStatementBatchViaBff({
      tenantId: 'mysc', actor, projectId: 'p001', idempotencyKey: 'import-1', lease: cashflowLease,
      payload: { idempotencyKey: 'ignored-client-body', columns: [], lines: [] }, client,
    });
    await applyBankStatementItemsViaBff({
      tenantId: 'mysc', actor, projectId: 'p001', idempotencyKey: 'apply-1', lease: cashflowLease, finalize: true,
      payload: { idempotencyKey: 'ignored-client-body', sheetKey: 'default', items: [] }, client,
    });
    expect(client.post).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ 'x-edit-session-id': 'session-a' }),
    }));
    expect(client.post).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ 'x-edit-session-id': 'session-a', 'x-edit-finalize': 'true' }),
    }));
    expect(client.post).toHaveBeenNthCalledWith(1, expect.any(String), expect.not.objectContaining({
      headers: expect.objectContaining({ 'x-edit-finalize': expect.anything() }),
    }));
  });

  it('reads actual cashflow from the JVM snapshot without invoking a canonical mutation', async () => {
    const client = asMockClient({
      get: vi.fn(async () => ({ data: {
        projectId: 'p001',
        projection: [],
        actual: [
          { sheetKey: 'default', yearMonth: '2026-07', weekNo: 1, cashflowLine: 'DIRECT_COST_OUT', amount: 1000 },
          { sheetKey: 'receipts', yearMonth: '2026-07', weekNo: 1, cashflowLine: 'DIRECT_COST_OUT', amount: 500 },
        ],
        readModel: { months: [{
          yearMonth: '2026-07',
          projection: { rowTotals: {}, weeks: [], monthTotals: { totalIn: 0, totalOut: 0, net: 0 } },
          actual: {
            rowTotals: { DIRECT_COST_OUT: 1500 },
            weeks: [{ weekNo: 1, amounts: { DIRECT_COST_OUT: 1500 }, totalIn: 0, totalOut: 1500, net: -1500, weekIn: 0, weekOut: 1500 }],
            monthTotals: { totalIn: 0, totalOut: 1500, net: -1500 },
          },
        }] },
      } })),
      post: vi.fn(), request: vi.fn(),
    });

    const result = await syncProjectCashflowActualsViaBff({
      tenantId: 'mysc', actor: { uid: 'u001', role: 'pm' }, projectId: 'p001', client,
    });

    expect(client.get).toHaveBeenCalledWith('/api/v1/cashflow/p001', expect.any(Object));
    expect(client.post).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      projectId: 'p001', sourceRows: 2, sheetCount: 2, upsertedWeeks: 1,
      weeks: [{ yearMonth: '2026-07', weekNo: 1, amounts: { DIRECT_COST_OUT: 1500 } }],
      cleared: [],
    });
  });

  it('reads the BFF projection-minus-actual comparison for the requested as-of date', async () => {
    const module = await import('./platform-bff-client') as unknown as {
      fetchCashflowSnapshotViaBff?: (params: Record<string, unknown>) => Promise<{
        comparison: { direction: string; asOfDate: string };
        readModel: {
          range: { projection: { totalIn: number } };
          months: Array<{ comparison: { totalIn: number } }>;
        };
      }>;
    };
    expect(typeof module.fetchCashflowSnapshotViaBff).toBe('function');
    if (!module.fetchCashflowSnapshotViaBff) return;

    const client = asMockClient({
      get: vi.fn(async () => ({ data: {
        projectId: 'p001',
        projection: [],
        actual: [],
        comparison: {
          projectId: 'p001', direction: 'projection_minus_actual', asOfDate: '2026-07-13',
          asOfWeek: { yearMonth: '2026-07', weekNo: 3 }, timeZone: 'Asia/Seoul', lineOrder: [], months: [], ignoredLineIds: [],
        },
        readModel: {
          range: {
            start: { yearMonth: '2026-01', weekNo: 1 },
            end: { yearMonth: '2026-12', weekNo: 5 },
            projection: { rowTotals: {}, totalIn: 300, totalOut: 0, net: 300 },
            actual: { rowTotals: {}, totalIn: 0, totalOut: 0, net: 0 },
          },
          months: [{
            yearMonth: '2026-07',
            projection: { rowTotals: {}, weeks: [], monthTotals: { totalIn: 0, totalOut: 0, net: 0 } },
            actual: { rowTotals: {}, weeks: [], monthTotals: { totalIn: 0, totalOut: 0, net: 0 } },
            comparison: { weeks: [], rowTotals: {}, totalIn: 300, totalOut: 0, net: 300, totals: {} },
          }],
        },
      } })),
      post: vi.fn(), request: vi.fn(),
    });

    const result = await module.fetchCashflowSnapshotViaBff({
      tenantId: 'mysc', actor: { uid: 'u001', role: 'pm' }, projectId: 'p001', asOf: '2026-07-13',
      rangeStart: { yearMonth: '2026-01', weekNo: 1 },
      rangeEnd: { yearMonth: '2026-12', weekNo: 5 },
      client,
    });

    expect(client.get).toHaveBeenCalledWith(
      '/api/v1/cashflow/p001?asOf=2026-07-13&rangeStart=2026-01%3A1&rangeEnd=2026-12%3A5',
      expect.any(Object),
    );
    expect(result.comparison).toMatchObject({ direction: 'projection_minus_actual', asOfDate: '2026-07-13' });
    expect(result.readModel.range.projection.totalIn).toBe(300);
    expect(result.readModel.months[0]?.comparison.totalIn).toBe(300);
  });
  it('reads runtime config with defaults', () => {
    expect(readPlatformApiRuntimeConfig({})).toEqual({
      enabled: false,
      baseUrl: 'http://127.0.0.1:8787',
    });
  });

  it('keeps hosted browser calls on the BFF when env points at the Java API', () => {
    const originalWindow = globalThis.window;
    vi.stubGlobal('window', {
      location: {
        origin: 'https://inner-platform-preview-merryai-devs-projects.vercel.app',
        hostname: 'inner-platform-preview-merryai-devs-projects.vercel.app',
      },
    });

    expect(readPlatformApiRuntimeConfig({
      VITE_PLATFORM_API_ENABLED: 'true',
      VITE_PLATFORM_API_BASE_URL: 'https://innerplatform-jvm-weekly-api-c3pm5gv7ia-du.a.run.app',
    })).toEqual({
      enabled: true,
      baseUrl: 'https://inner-platform-preview-merryai-devs-projects.vercel.app',
    });

    vi.stubGlobal('window', originalWindow);
  });

  it('normalizes actor shape', () => {
    expect(toRequestActor({ uid: 'u001', email: 'a@x.com', role: 'admin' })).toEqual({
      id: 'u001',
      email: 'a@x.com',
      role: 'admin',
    });
  });

  it('passes id token when provided', () => {
    expect(toRequestActor({ uid: 'u001', role: 'admin', idToken: 'token-abc' })).toEqual({
      id: 'u001',
      role: 'admin',
      idToken: 'token-abc',
    });
  });

  it('calls contact update endpoint', async () => {
    const client = asMockClient({
      post: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(async () => ({ data: { ok: true, contact: { id: 'ct_001', name: '홍길동', organization: 'MYSC', emails: ['person@example.com'], phones: [], score: 1 } } })),
      request: vi.fn(),
    });

    const result = await updateContactViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'admin' },
      contactId: 'ct_001',
      contact: {
        name: '홍길동',
        organization: 'MYSC',
        department: '',
        title: '',
        role: '',
        emails: ['person@example.com'],
        phones: [],
        website: '',
        address: '',
        memo: '수정',
      },
      client,
    });

    expect(client.patch).toHaveBeenCalledWith('/api/v1/contacts/ct_001', expect.objectContaining({
      tenantId: 'mysc',
      body: expect.objectContaining({ memo: '수정' }),
    }));
    expect(result.contact.id).toBe('ct_001');
  });

  it('calls project upsert endpoint', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({ data: { id: 'p001', tenantId: 'mysc', version: 1, updatedAt: '2026-01-01' } })),
      get: vi.fn(),
      request: vi.fn(),
    });

    const result = await upsertProjectViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'admin' },
      project: { id: 'p001', name: 'Project 1' },
      client,
    });

    expect(client.post).toHaveBeenCalledWith('/api/v1/projects', expect.objectContaining({
      tenantId: 'mysc',
      body: { id: 'p001', name: 'Project 1' },
    }));
    expect(result.version).toBe(1);
  });

  it('reads all project pages through the BFF without opening a realtime listener', async () => {
    const client = asMockClient({
      post: vi.fn(),
      get: vi
        .fn()
        .mockResolvedValueOnce({ data: { items: [{ id: 'p001', name: 'Project 1' }], nextCursor: 'page-2' } })
        .mockResolvedValueOnce({ data: { items: [{ id: 'p002', name: 'Project 2' }], nextCursor: null } }),
      request: vi.fn(),
    });

    const result = await fetchProjectsViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'admin', idToken: 'token-abc' },
      client,
    });

    expect(result.map((project) => project.id)).toEqual(['p001', 'p002']);
    expect(client.get).toHaveBeenNthCalledWith(1, '/api/v1/projects?limit=200', expect.objectContaining({
      tenantId: 'mysc',
      timeoutMs: 10000,
    }));
    expect(client.get).toHaveBeenNthCalledWith(2, '/api/v1/projects?limit=200&cursor=page-2', expect.any(Object));
  });

  it('reads only the authenticated reviewer\'s project requests through the scoped BFF inbox', async () => {
    const client = asMockClient({
      post: vi.fn(),
      get: vi.fn(async () => ({
        data: {
          items: [{
            id: 'request-head-a',
            approvedProjectId: 'project-a',
            payload: { executiveApproverId: 'head-a' },
          }],
          projects: [{ id: 'project-a', name: 'Project A' }],
        },
      })),
      request: vi.fn(),
    });

    const result = await fetchAssignedProjectRequestsViaBff({
      tenantId: 'mysc',
      actor: { uid: 'head-a', role: 'pm', idToken: 'token-abc' },
      client,
    });

    expect(result).toEqual({
      requests: [expect.objectContaining({ id: 'request-head-a', approvedProjectId: 'project-a' })],
      projects: [expect.objectContaining({ id: 'project-a', name: 'Project A' })],
    });
    expect(client.get).toHaveBeenCalledWith('/api/v1/project-requests/assigned-to-me', expect.objectContaining({
      tenantId: 'mysc',
      timeoutMs: 10000,
    }));
  });

  it('reads latest, pending-summary, and privileged review request views through the BFF', async () => {
    const client = asMockClient({
      post: vi.fn(async (path: string) => ({
        data: { items: [{ id: path.includes('pending-changes') ? 'pending-a' : 'review-a', requestKind: 'CHANGE' }] },
      })),
      get: vi.fn()
        .mockResolvedValueOnce({ data: { item: { id: 'latest-a', approvedProjectId: 'project-a' } } }),
      request: vi.fn(),
    });
    const actor = { uid: 'pm-a', role: 'pm', idToken: 'token-abc' };

    await expect(fetchLatestProjectRequestViaBff({
      tenantId: 'mysc', actor, projectId: 'project-a', client,
    })).resolves.toEqual(expect.objectContaining({ id: 'latest-a' }));
    await expect(fetchPendingProjectChangeRequestsViaBff({
      tenantId: 'mysc', actor, projectIds: ['project-a'], client,
    })).resolves.toEqual([expect.objectContaining({ id: 'pending-a' })]);
    await expect(fetchProjectReviewInboxViaBff({
      tenantId: 'mysc', actor, projectIds: ['project-a'], client,
    })).resolves.toEqual([expect.objectContaining({ id: 'review-a' })]);

    expect(client.get).toHaveBeenNthCalledWith(1, '/api/v1/projects/project-a/latest-request', expect.objectContaining({ timeoutMs: 10000 }));
    expect(client.post).toHaveBeenNthCalledWith(1, '/api/v1/project-requests/pending-changes', expect.objectContaining({
      body: { projectIds: ['project-a'] },
      timeoutMs: 10000,
    }));
    expect(client.post).toHaveBeenNthCalledWith(2, '/api/v1/project-requests/review-inbox', expect.objectContaining({
      body: { projectIds: ['project-a'] },
      timeoutMs: 10000,
    }));
  });

  it('chunks 201 project ids and returns deduplicated requests in stable requested order', async () => {
    const projectIds = Array.from({ length: 201 }, (_, index) => `project-${index + 1}`);
    const client = asMockClient({
      post: vi.fn(async (_path: string, options: { body?: unknown }) => {
        const batch = (options.body as { projectIds: string[] }).projectIds;
        return {
          data: {
            items: batch.length === 200
              ? [
                { id: 'request-b', requestedAt: '2026-07-20T00:00:00.000Z' },
                { id: 'request-duplicate', requestedAt: '2026-07-19T00:00:00.000Z' },
              ]
              : [
                { id: 'request-a', requestedAt: '2026-07-20T00:00:00.000Z' },
                { id: 'request-duplicate', requestedAt: '2026-07-19T00:00:00.000Z' },
              ],
          },
        };
      }),
      get: vi.fn(),
      request: vi.fn(),
    });
    const actor = { uid: 'reviewer-a', role: 'admin' };

    await expect(fetchProjectReviewInboxViaBff({
      tenantId: 'mysc', actor, projectIds: [...projectIds, 'project-1', ' '], client,
    })).resolves.toEqual([
      expect.objectContaining({ id: 'request-a' }),
      expect.objectContaining({ id: 'request-b' }),
      expect.objectContaining({ id: 'request-duplicate' }),
    ]);
    await expect(fetchPendingProjectChangeRequestsViaBff({
      tenantId: 'mysc', actor, projectIds, client,
    })).resolves.toHaveLength(3);

    expect(client.post).toHaveBeenCalledTimes(4);
    expect((client.post.mock.calls[0]?.[1]?.body as { projectIds: string[] }).projectIds).toHaveLength(200);
    expect((client.post.mock.calls[1]?.[1]?.body as { projectIds: string[] }).projectIds).toHaveLength(1);
    expect((client.post.mock.calls[2]?.[1]?.body as { projectIds: string[] }).projectIds).toHaveLength(200);
    expect((client.post.mock.calls[3]?.[1]?.body as { projectIds: string[] }).projectIds).toHaveLength(1);
  });

  it('calls project trash and restore endpoints', async () => {
    const client = asMockClient({
      post: vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            id: 'p001',
            tenantId: 'mysc',
            version: 2,
            updatedAt: '2026-04-03T11:10:00.000Z',
            trashedAt: '2026-04-03T11:10:00.000Z',
          },
        })
        .mockResolvedValueOnce({
          data: {
            id: 'p001',
            tenantId: 'mysc',
            version: 3,
            updatedAt: '2026-04-03T11:12:00.000Z',
          },
        }),
      get: vi.fn(),
      request: vi.fn(),
    });

    const trashed = await trashProjectViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'admin' },
      projectId: 'p001',
      payload: { expectedVersion: 1, reason: '중복 등록' },
      client,
    });

    const restored = await restoreProjectViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'admin' },
      projectId: 'p001',
      payload: { expectedVersion: 2 },
      client,
    });

    expect(client.post).toHaveBeenNthCalledWith(1, '/api/v1/projects/p001/trash', expect.objectContaining({
      tenantId: 'mysc',
      body: { expectedVersion: 1, reason: '중복 등록' },
    }));
    expect(client.post).toHaveBeenNthCalledWith(2, '/api/v1/projects/p001/restore', expect.objectContaining({
      tenantId: 'mysc',
      body: { expectedVersion: 2 },
    }));
    expect(trashed.trashedAt).toBe('2026-04-03T11:10:00.000Z');
    expect(restored.version).toBe(3);
  });

  it('calls ledger/transaction endpoints', async () => {
    const client = asMockClient({
      post: vi
        .fn()
        .mockResolvedValueOnce({ data: { id: 'l001', tenantId: 'mysc', version: 1, updatedAt: '2026-01-02' } })
        .mockResolvedValueOnce({ data: { id: 'tx001', tenantId: 'mysc', version: 1, updatedAt: '2026-01-02', state: 'DRAFT' } }),
      get: vi.fn(),
      request: vi.fn(),
    });

    const ledger = await upsertLedgerViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'admin' },
      ledger: { id: 'l001', projectId: 'p001', name: 'main ledger' },
      client,
    });

    const tx = await upsertTransactionViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'admin' },
      transaction: { id: 'tx001', projectId: 'p001', ledgerId: 'l001', counterparty: 'vendor' },
      lease: cashflowLease,
      client,
    });

    expect(ledger.id).toBe('l001');
    expect(tx.state).toBe('DRAFT');
    expect(client.post).toHaveBeenNthCalledWith(2, '/api/v1/transactions', expect.objectContaining({
      headers: expect.objectContaining({ 'x-edit-session-id': 'session-a', 'x-edit-lease-id': 'lease-a', 'x-edit-fence': '7' }),
    }));
  });

  it('calls transaction state endpoint with expected version', async () => {
    const client = asMockClient({
      post: vi.fn(),
      get: vi.fn(),
      request: vi.fn(async () => ({
        data: { id: 'tx001', state: 'APPROVED', rejectedReason: null, version: 2, updatedAt: '2026-01-02' },
      })),
    });

    const result = await changeTransactionStateViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'admin' },
      transactionId: 'tx001',
      newState: 'APPROVED',
      expectedVersion: 1,
      lease: cashflowLease,
      client,
    });

    expect(client.request).toHaveBeenCalledWith('/api/v1/transactions/tx001/state', expect.objectContaining({
      method: 'PATCH',
      tenantId: 'mysc',
      body: { newState: 'APPROVED', expectedVersion: 1, reason: undefined },
      headers: expect.objectContaining({ 'x-edit-session-id': 'session-a', 'x-edit-lease-id': 'lease-a', 'x-edit-fence': '7' }),
    }));
    expect(result.state).toBe('APPROVED');
  });

  it('calls comment/evidence endpoints', async () => {
    const client = asMockClient({
      post: vi
        .fn()
        .mockResolvedValueOnce({ data: { id: 'c001', transactionId: 'tx001', version: 1, createdAt: '2026-01-02' } })
        .mockResolvedValueOnce({ data: { id: 'ev001', transactionId: 'tx001', version: 1, uploadedAt: '2026-01-02' } }),
      get: vi.fn(),
      request: vi.fn(),
    });

    const comment = await addCommentViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'admin' },
      transactionId: 'tx001',
      comment: { content: 'hello' },
      lease: cashflowLease,
      client,
    });

    const evidence = await addEvidenceViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'admin' },
      transactionId: 'tx001',
      evidence: {
        fileName: 'invoice.pdf',
        fileType: 'application/pdf',
        fileSize: 123,
        category: '세금계산서',
      },
      lease: cashflowLease,
      client,
    });

    expect(client.post).toHaveBeenNthCalledWith(1, '/api/v1/transactions/tx001/comments', expect.objectContaining({
      headers: expect.objectContaining({ 'x-edit-session-id': 'session-a', 'x-edit-lease-id': 'lease-a', 'x-edit-fence': '7' }),
    }));
    expect(client.post).toHaveBeenNthCalledWith(2, '/api/v1/transactions/tx001/evidences', expect.objectContaining({
      headers: expect.objectContaining({ 'x-edit-session-id': 'session-a', 'x-edit-lease-id': 'lease-a', 'x-edit-fence': '7' }),
    }));
    expect(comment.id).toBe('c001');
    expect(evidence.id).toBe('ev001');
  });

  it('fetches auth governance users through the bff client', async () => {
    const client = asMockClient({
      post: vi.fn(),
      get: vi.fn(async () => ({
        data: {
          items: [{ identityKey: 'jslee@mysc.co.kr', email: 'jslee@mysc.co.kr', driftFlags: ['missing_auth'] }],
          summary: {
            total: 1,
            needsDeepSync: 1,
            missingAuth: 1,
            missingCanonicalMember: 0,
            duplicateMemberDocs: 0,
            bootstrapCandidates: 1,
          },
        },
      })),
      request: vi.fn(),
    });

    const response = await fetchAuthGovernanceUsersViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u-admin', role: 'admin', idToken: 'token-1' },
      client,
    });

    expect(client.get).toHaveBeenCalledWith('/api/v1/admin/auth-governance/users', expect.objectContaining({
      tenantId: 'mysc',
      actor: expect.objectContaining({ id: 'u-admin', role: 'admin', idToken: 'token-1' }),
    }));
    expect(response.summary.total).toBe(1);
  });

  it('posts a deep sync request for an auth governance user', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          identityKey: 'jslee@mysc.co.kr',
          email: 'jslee@mysc.co.kr',
          canonicalDocId: 'uid-jslee',
          role: 'admin',
          mirroredLegacyCount: 1,
          claimsUpdated: true,
          claimsSyncStatus: 'SYNCED',
          updatedAt: '2026-04-13T06:30:00.000Z',
        },
      })),
      get: vi.fn(),
      request: vi.fn(),
    });

    const response = await deepSyncAuthGovernanceUserViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u-admin', role: 'admin', idToken: 'token-1' },
      identityKey: 'jslee@mysc.co.kr',
      role: 'admin',
      reason: 'cashflow export alignment',
      client,
    });

    expect(client.post).toHaveBeenCalledWith(
      '/api/v1/admin/auth-governance/users/jslee%40mysc.co.kr/deep-sync',
      expect.objectContaining({
        body: {
          role: 'admin',
          reason: 'cashflow export alignment',
        },
      }),
    );
    expect(response.claimsUpdated).toBe(true);
    expect(response.claimsSyncStatus).toBe('SYNCED');
  });

  it('posts one bulk deep sync request and preserves per-item outcomes', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          outcomes: [
            { identityKey: 'first@mysc.co.kr', status: 'FAILED', errorCode: 'internal_error', message: '다시 시도해 주세요.' },
            {
              identityKey: 'second@mysc.co.kr',
              status: 'SUCCEEDED',
              result: { role: 'finance', claimsSyncStatus: 'SYNCED' },
            },
          ],
          summary: { total: 2, succeeded: 1, failed: 1, pendingClaimsSync: 0 },
        },
      })),
      get: vi.fn(),
      request: vi.fn(),
    });

    const response = await deepSyncAuthGovernanceUsersViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u-admin', role: 'admin', idToken: 'token-1' },
      reason: '권한 일괄 정렬',
      items: [
        { identityKey: 'first@mysc.co.kr', role: 'finance' },
        { identityKey: 'second@mysc.co.kr', role: 'finance' },
      ],
      client,
    });

    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith(
      '/api/v1/admin/auth-governance/users/deep-sync-bulk',
      expect.objectContaining({
        body: {
          reason: '권한 일괄 정렬',
          items: [
            { identityKey: 'first@mysc.co.kr', role: 'finance' },
            { identityKey: 'second@mysc.co.kr', role: 'finance' },
          ],
        },
      }),
    );
    expect(response.summary).toEqual({ total: 2, succeeded: 1, failed: 1, pendingClaimsSync: 0 });
    expect(response.outcomes.map(({ status }) => status)).toEqual(['FAILED', 'SUCCEEDED']);
  });

  it('calls project request contract analysis endpoint', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          provider: 'anthropic',
          model: 'claude-sonnet',
          summary: '초안 생성',
          warnings: ['사람 확인 필요'],
          nextActions: ['담당팀은 직접 선택하세요.'],
          extractedAt: '2026-03-16T09:00:00.000Z',
          fields: {
            officialContractName: { value: '뷰티풀 커넥트 운영 계약', confidence: 'high', evidence: '사업명: 뷰티풀 커넥트 운영 계약' },
            suggestedProjectName: { value: '뷰티풀커넥트', confidence: 'high', evidence: '사업명' },
            clientOrg: { value: '아모레퍼시픽재단', confidence: 'high', evidence: '발주기관' },
            projectPurpose: { value: '청년 창업가의 지역 연결 지원', confidence: 'medium', evidence: '사업 목적' },
            description: { value: '', confidence: 'low', evidence: '' },
            contractStart: { value: '2026-03-01', confidence: 'high', evidence: '계약기간' },
            contractEnd: { value: '2026-12-31', confidence: 'high', evidence: '계약기간' },
            contractAmount: { value: 120000000, confidence: 'high', evidence: '총 계약금액' },
            salesVatAmount: { value: 12000000, confidence: 'medium', evidence: '부가세' },
          },
        },
      })),
      get: vi.fn(),
      request: vi.fn(),
    });

    const result = await analyzeProjectRequestContractViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'pm', idToken: 'token-abc' },
      fileName: 'contract.pdf',
      documentText: '사업명: 뷰티풀 커넥트 운영 계약',
      client,
    });

    expect(client.post).toHaveBeenCalledWith('/api/v1/project-requests/contract/analyze', expect.objectContaining({
      tenantId: 'mysc',
      body: {
        fileName: 'contract.pdf',
        documentText: '사업명: 뷰티풀 커넥트 운영 계약',
      },
    }));
    expect(result.fields.officialContractName.value).toBe('뷰티풀 커넥트 운영 계약');
    expect(result.fields.contractAmount.value).toBe(120000000);
  });

  it('calls project request contract upload endpoint', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          path: 'orgs/mysc/project-request-contracts/u001/contract.pdf',
          name: 'contract.pdf',
          downloadURL: 'https://example.com/contract.pdf',
          size: 1234,
          contentType: 'application/pdf',
          uploadedAt: '2026-03-16T10:00:00.000Z',
        },
      })),
      get: vi.fn(),
      request: vi.fn(),
    });

    const result = await uploadProjectRequestContractViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'pm', idToken: 'token-abc' },
      upload: {
        fileName: 'contract.pdf',
        mimeType: 'application/pdf',
        fileSize: 1234,
        contentBase64: 'ZmFrZS1wZGY=',
      },
      client,
    });

    expect(client.post).toHaveBeenCalledWith('/api/v1/project-requests/contract/upload', expect.objectContaining({
      tenantId: 'mysc',
      body: {
        fileName: 'contract.pdf',
        mimeType: 'application/pdf',
        fileSize: 1234,
        contentBase64: 'ZmFrZS1wZGY=',
      },
    }));
    expect(result.downloadURL).toContain('contract.pdf');
  });

  it('calls project request contract process endpoint with binary body', async () => {
    const file = new File(['pdf-bytes'], '계약서 샘플.pdf', { type: 'application/pdf' });
    const client = asMockClient({
      post: vi.fn(),
      get: vi.fn(),
      request: vi.fn(async () => ({
        data: {
          contractDocument: {
            path: 'orgs/mysc/project-request-contracts/u001/contract.pdf',
            name: 'contract.pdf',
            downloadURL: 'https://example.com/contract.pdf',
            size: 1234,
            contentType: 'application/pdf',
            uploadedAt: '2026-03-16T10:00:00.000Z',
          },
          analysis: {
            provider: 'heuristic',
            model: 'deterministic-fallback',
            summary: 'summary',
            warnings: [],
            nextActions: [],
            extractedAt: '2026-03-16T10:00:00.000Z',
            fields: {
              officialContractName: { value: '공식 계약명', confidence: 'medium', evidence: '근거' },
              suggestedProjectName: { value: '계약명', confidence: 'medium', evidence: '근거' },
              clientOrg: { value: '', confidence: 'low', evidence: '' },
              projectPurpose: { value: '', confidence: 'low', evidence: '' },
              description: { value: '', confidence: 'low', evidence: '' },
              contractStart: { value: '', confidence: 'low', evidence: '' },
              contractEnd: { value: '', confidence: 'low', evidence: '' },
              contractAmount: { value: null, confidence: 'low', evidence: '' },
              salesVatAmount: { value: null, confidence: 'low', evidence: '' },
            },
          },
        },
      })),
    });

    const result = await processProjectRequestContractViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'pm', idToken: 'token-abc' },
      file,
      client,
    });

    expect(client.request).toHaveBeenCalledWith('/api/v1/project-requests/contract/process', expect.objectContaining({
      method: 'POST',
      tenantId: 'mysc',
      body: file,
      headers: expect.objectContaining({
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent('계약서 샘플.pdf'),
        'x-file-type': 'application/pdf',
      }),
    }));
    expect(result.analysis.fields.officialContractName.value).toBe('공식 계약명');
  });

  it('calls project registration notification endpoint', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          ok: true,
          enabled: true,
          delivered: true,
          requestId: 'pr-123',
          projectId: 'p-123',
        },
      })),
      get: vi.fn(),
      request: vi.fn(),
    });

    const result = await notifyProjectRequestRegistrationViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'pm', idToken: 'token-abc' },
      projectRequestId: 'pr-123',
      client,
    });

    expect(client.post).toHaveBeenCalledWith('/api/v1/project-requests/pr-123/notify-registration', expect.objectContaining({
      tenantId: 'mysc',
      body: {},
      idempotencyKey: 'project-request-registration-notify:pr-123',
    }));
    expect(result.delivered).toBe(true);
    expect(result.projectId).toBe('p-123');
  });

  it('calls project executive review endpoint with reason and reviewer metadata', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          ok: true,
          projectId: 'p-123',
          requestId: 'pr-123',
          reviewStatus: 'REVISION_REJECTED',
          slackDelivered: true,
        },
      })),
      get: vi.fn(),
      request: vi.fn(),
    });

    const result = await reviewProjectExecutiveStatusViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u-admin', role: 'admin', idToken: 'token-abc' },
      projectId: 'p-123',
      review: {
        requestId: 'pr-123',
        reviewStatus: 'REVISION_REJECTED',
        reviewComment: '예산 다시 올려 주세요',
        reviewerName: '임원A',
      },
      client,
    });

    expect(client.post).toHaveBeenCalledWith('/api/v1/projects/p-123/executive-review', expect.objectContaining({
      tenantId: 'mysc',
      body: {
        requestId: 'pr-123',
        reviewStatus: 'REVISION_REJECTED',
        reviewComment: '예산 다시 올려 주세요',
        reviewerName: '임원A',
      },
    }));
    expect(result.reviewStatus).toBe('REVISION_REJECTED');
    expect(result.slackDelivered).toBe(true);
  });

  it('omits blank optional text fields from project executive review requests', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          ok: true,
          projectId: 'p-123',
          requestId: null,
          reviewStatus: 'APPROVED',
        },
      })),
      get: vi.fn(),
      request: vi.fn(),
    });

    await reviewProjectExecutiveStatusViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u-admin', role: 'admin', idToken: 'token-abc' },
      projectId: 'p-123',
      review: {
        requestId: '   ',
        reviewStatus: 'APPROVED',
        reviewComment: null,
        reviewerName: '  임원A  ',
      } as any,
      client,
    });

    expect(client.post).toHaveBeenCalledWith('/api/v1/projects/p-123/executive-review', expect.objectContaining({
      tenantId: 'mysc',
      body: {
        reviewStatus: 'APPROVED',
        reviewerName: '임원A',
      },
    }));
  });

  it('sends the assigned project code with an approval decision', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({ data: { ok: true, projectId: 'p-123', requestId: null, reviewStatus: 'APPROVED' } })),
      get: vi.fn(),
      request: vi.fn(),
    });

    await reviewProjectExecutiveStatusViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u-admin', role: 'admin', idToken: 'token-abc' },
      projectId: 'p-123',
      review: { reviewStatus: 'APPROVED', projectCode: '  PRJ-2026-001  ' },
      client,
    });

    expect(client.post).toHaveBeenCalledWith('/api/v1/projects/p-123/executive-review', expect.objectContaining({
      body: { reviewStatus: 'APPROVED', projectCode: 'PRJ-2026-001' },
    }));
  });

  it('calls project executive review resubmission endpoint', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          ok: true,
          projectId: 'p-123',
          requestId: 'pr-123',
          reviewStatus: 'PENDING',
        },
      })),
      get: vi.fn(),
      request: vi.fn(),
    });

    const { resubmitProjectExecutiveReviewViaBff } = await import('./platform-bff-client');
    const result = await resubmitProjectExecutiveReviewViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u-admin', role: 'admin', idToken: 'token-abc' },
      projectId: 'p-123',
      payload: {
        requestId: 'pr-123',
        reviewComment: '계약서 보완 후 재제출',
        reviewerName: '변민욱',
      },
      client,
    });

    expect(client.post).toHaveBeenCalledWith('/api/v1/projects/p-123/executive-review/resubmit', expect.objectContaining({
      tenantId: 'mysc',
      body: {
        requestId: 'pr-123',
        reviewComment: '계약서 보완 후 재제출',
        reviewerName: '변민욱',
      },
    }));
    expect(result.reviewStatus).toBe('PENDING');
  });

  it('calls the management-planning review endpoint with normalized code metadata', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          ok: true,
          projectId: 'p-123',
          requestId: 'pr-123',
          reviewStatus: 'AGREED',
        },
      })),
      get: vi.fn(),
      request: vi.fn(),
    });

    const result = await reviewProjectManagementPlanningStatusViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u-finance', role: 'finance', idToken: 'token-abc' },
      projectId: 'p-123',
      review: {
        requestId: '  pr-123  ',
        reviewStatus: 'AGREED',
        projectCode: '  PRJ-2026-001  ',
        reviewComment: '  코드 부여 완료  ',
        reviewerName: '  경영기획실  ',
      },
      client,
    });

    expect(client.post).toHaveBeenCalledWith('/api/v1/projects/p-123/management-planning-review', expect.objectContaining({
      tenantId: 'mysc',
      body: {
        requestId: 'pr-123',
        reviewStatus: 'AGREED',
        projectCode: 'PRJ-2026-001',
        reviewComment: '코드 부여 완료',
        reviewerName: '경영기획실',
      },
    }));
    expect(result.reviewStatus).toBe('AGREED');
  });

  it('omits blank optional text fields from project executive review resubmission requests', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          ok: true,
          projectId: 'p-123',
          requestId: 'pr-123',
          reviewStatus: 'PENDING',
        },
      })),
      get: vi.fn(),
      request: vi.fn(),
    });

    const { resubmitProjectExecutiveReviewViaBff } = await import('./platform-bff-client');
    await resubmitProjectExecutiveReviewViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u-admin', role: 'admin', idToken: 'token-abc' },
      projectId: 'p-123',
      payload: {
        requestId: '  pr-123  ',
        reviewComment: null,
        reviewerName: '  변민욱  ',
      } as any,
      client,
    });

    expect(client.post).toHaveBeenCalledWith('/api/v1/projects/p-123/executive-review/resubmit', expect.objectContaining({
      tenantId: 'mysc',
      body: {
        requestId: 'pr-123',
        reviewerName: '변민욱',
      },
    }));
  });

  it('calls evidence drive provision/sync endpoints', async () => {
    const client = asMockClient({
      post: vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            projectId: 'p001',
            folderId: 'fld-project',
            folderName: 'Project Root',
            webViewLink: 'https://drive.google.com/drive/folders/fld-project',
            sharedDriveId: 'shared-001',
            version: 2,
            updatedAt: '2026-03-11T10:00:00.000Z',
          },
        })
        .mockResolvedValueOnce({
          data: {
            projectId: 'p001',
            folderId: 'fld-project',
            folderName: 'Project Root',
            webViewLink: 'https://drive.google.com/drive/folders/fld-project',
            sharedDriveId: 'shared-001',
            version: 3,
            updatedAt: '2026-03-11T10:01:30.000Z',
          },
        })
        .mockResolvedValueOnce({
          data: {
            transactionId: 'tx001',
            projectId: 'p001',
            folderId: 'fld-tx',
            folderName: '20260311_회의비_다과비_tx001',
            webViewLink: 'https://drive.google.com/drive/folders/fld-tx',
            sharedDriveId: 'shared-001',
            evidenceCount: 2,
            evidenceCompletedDesc: '세금계산서, 입금확인서',
            evidenceAutoListedDesc: '세금계산서, 입금확인서',
            evidencePendingDesc: null,
            supportPendingDocs: null,
            evidenceMissing: [],
            evidenceStatus: 'COMPLETE',
            lastSyncedAt: '2026-03-11T10:02:00.000Z',
            version: 4,
            updatedAt: '2026-03-11T10:02:00.000Z',
          },
        }),
      get: vi.fn(),
      request: vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            transactionId: 'tx001',
            projectId: 'p001',
            projectFolderId: 'fld-project',
            projectFolderName: 'Project Root',
            folderId: 'fld-tx',
            folderName: '20260311_회의비_다과비_tx001',
            webViewLink: 'https://drive.google.com/drive/folders/fld-tx',
            sharedDriveId: 'shared-001',
            syncStatus: 'LINKED',
            version: 3,
            updatedAt: '2026-03-11T10:01:00.000Z',
          },
        })
        .mockResolvedValueOnce({
          data: {
            transactionId: 'tx001',
            projectId: 'p001',
            folderId: 'fld-tx',
            folderName: '20260311_회의비_다과비_tx001',
            webViewLink: 'https://drive.google.com/drive/folders/fld-tx',
            sharedDriveId: 'shared-001',
            evidenceCount: 2,
            evidenceCompletedDesc: '세금계산서, 입금확인서',
            evidenceAutoListedDesc: '세금계산서, 입금확인서',
            evidencePendingDesc: null,
            supportPendingDocs: null,
            evidenceMissing: [],
            evidenceStatus: 'COMPLETE',
            lastSyncedAt: '2026-03-11T10:02:00.000Z',
            version: 4,
            updatedAt: '2026-03-11T10:02:00.000Z',
          },
        }),
    });

    const projectRoot = await provisionProjectEvidenceDriveRootViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'admin' },
      projectId: 'p001',
      client,
    });

    const txFolder = await provisionTransactionEvidenceDriveViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'admin' },
      transactionId: 'tx001',
      lease: cashflowLease,
      client,
    });

    const linkedRoot = await linkProjectEvidenceDriveRootViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'admin' },
      projectId: 'p001',
      value: 'https://drive.google.com/drive/folders/fld-project',
      client,
    });

    const syncResult = await syncTransactionEvidenceDriveViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'admin' },
      transactionId: 'tx001',
      lease: cashflowLease,
      client,
    });

    expect(client.post).toHaveBeenNthCalledWith(1, '/api/v1/projects/p001/evidence-drive/root/provision', expect.objectContaining({
      tenantId: 'mysc',
    }));
    expect(client.request).toHaveBeenNthCalledWith(1, '/api/v1/transactions/tx001/evidence-drive/provision', expect.objectContaining({
      tenantId: 'mysc',
      method: 'POST',
      retries: 0,
      timeoutMs: 15000,
      headers: expect.objectContaining({ 'x-edit-session-id': 'session-a', 'x-edit-lease-id': 'lease-a', 'x-edit-fence': '7' }),
    }));
    expect(client.post).toHaveBeenNthCalledWith(2, '/api/v1/projects/p001/evidence-drive/root/link', expect.objectContaining({
      tenantId: 'mysc',
      body: { value: 'https://drive.google.com/drive/folders/fld-project' },
    }));
    expect(client.request).toHaveBeenNthCalledWith(2, '/api/v1/transactions/tx001/evidence-drive/sync', expect.objectContaining({
      tenantId: 'mysc',
      method: 'POST',
      retries: 0,
      timeoutMs: 20000,
      headers: expect.objectContaining({ 'x-edit-session-id': 'session-a', 'x-edit-lease-id': 'lease-a', 'x-edit-fence': '7' }),
    }));
    expect(projectRoot.folderId).toBe('fld-project');
    expect(txFolder.syncStatus).toBe('LINKED');
    expect(linkedRoot.folderName).toBe('Project Root');
    expect(syncResult.evidenceStatus).toBe('COMPLETE');
  });

  it('uploads an evidence file through the drive upload endpoint', async () => {
    const client = asMockClient({
      post: vi.fn(),
      get: vi.fn(),
      request: vi.fn(async () => ({
        data: {
          transactionId: 'tx001',
          projectId: 'p001',
          folderId: 'fld-tx',
          folderName: '20260311_회의비_다과비_tx001',
          driveFileId: 'drv-file-001',
          fileName: 'ZOOM invoice March.pdf',
          webViewLink: 'https://drive.google.com/file/d/drv-file-001/view',
          category: 'ZOOM invoice',
          parserCategory: 'ZOOM invoice',
          parserConfidence: 0.92,
          evidenceCount: 1,
          evidenceCompletedDesc: 'ZOOM invoice',
          evidenceAutoListedDesc: 'ZOOM invoice',
          evidencePendingDesc: null,
          supportPendingDocs: null,
          evidenceMissing: [],
          evidenceStatus: 'COMPLETE',
          lastSyncedAt: '2026-03-11T11:00:00.000Z',
          version: 5,
          updatedAt: '2026-03-11T11:00:00.000Z',
        },
      })),
    });

    const result = await uploadTransactionEvidenceDriveViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'admin' },
      transactionId: 'tx001',
      upload: {
        fileName: 'ZOOM invoice March.pdf',
        originalFileName: 'zoom_3month_raw.pdf',
        mimeType: 'application/pdf',
        fileSize: 1024,
        contentBase64: 'ZmFrZS1wZGY=',
        category: 'ZOOM invoice',
      },
      lease: cashflowLease,
      client,
    });

    expect(client.request).toHaveBeenCalledWith('/api/v1/transactions/tx001/evidence-drive/upload', expect.objectContaining({
      tenantId: 'mysc',
      method: 'POST',
      retries: 0,
      timeoutMs: 30000,
      headers: expect.objectContaining({ 'x-edit-session-id': 'session-a', 'x-edit-lease-id': 'lease-a', 'x-edit-fence': '7' }),
      body: expect.objectContaining({
        fileName: 'ZOOM invoice March.pdf',
        originalFileName: 'zoom_3month_raw.pdf',
        mimeType: 'application/pdf',
        fileSize: 1024,
        category: 'ZOOM invoice',
      }),
    }));
    expect(result.driveFileId).toBe('drv-file-001');
    expect(result.evidenceCompletedDesc).toBe('ZOOM invoice');
  });

  it('posts evidence drive category overrides', async () => {
    const client = asMockClient({
      post: vi.fn(),
      get: vi.fn(),
      request: vi.fn(async () => ({
        data: {
          transactionId: 'tx001',
          projectId: 'p001',
          folderId: 'fld-tx',
          folderName: '20260311_회의비_다과비_tx001',
          webViewLink: 'https://drive.google.com/drive/folders/fld-tx',
          sharedDriveId: 'drive-001',
          evidenceCount: 1,
          evidenceCompletedDesc: '세금계산서',
          evidenceAutoListedDesc: '세금계산서',
          evidencePendingDesc: null,
          supportPendingDocs: null,
          evidenceMissing: [],
          evidenceStatus: 'COMPLETE',
          lastSyncedAt: '2026-03-11T11:10:00.000Z',
          version: 6,
          updatedAt: '2026-03-11T11:10:00.000Z',
        },
      })),
    });

    const result = await overrideTransactionEvidenceDriveCategoriesViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'pm' },
      transactionId: 'tx001',
      overrides: {
        items: [{ driveFileId: 'drv-file-001', category: '세금계산서' }],
      },
      client,
    });

    expect(client.request).toHaveBeenCalledWith('/api/v1/transactions/tx001/evidence-drive/overrides', expect.objectContaining({
      method: 'POST',
      tenantId: 'mysc',
      body: {
        items: [{ driveFileId: 'drv-file-001', category: '세금계산서' }],
      },
    }));
    expect(result.evidenceCompletedDesc).toBe('세금계산서');
  });

  it('calls google sheet import preview endpoint', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          spreadsheetId: 'sheet-001',
          spreadsheetTitle: '주간 사업비 시트',
          selectedSheetName: '주간정산',
          availableSheets: [
            { sheetId: 0, title: '요약', index: 0 },
            { sheetId: 1, title: '주간정산', index: 1 },
          ],
          matrix: [
            ['작성자', '거래일시', '지급처'],
            ['홍길동', '2026-03-12', '카페 메리'],
          ],
        },
      })),
      get: vi.fn(),
      request: vi.fn(),
    });

    const preview = await previewGoogleSheetImportViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'pm', googleAccessToken: 'google-token-123' },
      projectId: 'p001',
      value: 'https://docs.google.com/spreadsheets/d/sheet-001/edit#gid=1',
      sheetName: '주간정산',
      client,
    });

    expect(client.post).toHaveBeenCalledWith('/api/v1/projects/p001/google-sheet-import/preview', expect.objectContaining({
      headers: {
        'x-google-access-token': 'google-token-123',
      },
      body: {
        value: 'https://docs.google.com/spreadsheets/d/sheet-001/edit#gid=1',
        sheetName: '주간정산',
      },
      timeoutMs: 20000,
    }));
    expect(preview.selectedSheetName).toBe('주간정산');
  });

  it('calls google sheet import analysis endpoint', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          summary: '사용내역 탭으로 보입니다.',
          confidence: 'high',
          likelyTarget: 'expense_sheet',
          usageTips: ['상단 헤더를 먼저 확인하세요.'],
          warnings: ['2줄 헤더 여부를 확인하세요.'],
          nextActions: ['표본 3행을 먼저 검증하세요.'],
          suggestedMappings: [
            {
              sourceHeader: '입금합계 > 입금액',
              platformField: '입금합계/입금액',
              confidence: 'high',
              reason: '입금 금액 계열입니다.',
            },
          ],
        },
      })),
      get: vi.fn(),
      request: vi.fn(),
    });

    const analysis = await analyzeGoogleSheetImportViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'pm' },
      projectId: 'p001',
      spreadsheetTitle: '2026 사업비 관리 시트',
      selectedSheetName: '사용내역',
      matrix: [
        ['작성자', '입금합계', '사업팀'],
        ['No.', '입금액', '지급처'],
      ],
      client,
    });

    expect(client.post).toHaveBeenCalledWith('/api/v1/projects/p001/google-sheet-import/analyze', expect.objectContaining({
      body: {
        spreadsheetTitle: '2026 사업비 관리 시트',
        selectedSheetName: '사용내역',
        matrix: [
          ['작성자', '입금합계', '사업팀'],
          ['No.', '입금액', '지급처'],
        ],
      },
      timeoutMs: 25000,
    }));
    expect(analysis.likelyTarget).toBe('expense_sheet');
  });

  it('calls project sheet source upload endpoint', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          sourceType: 'usage',
          projectId: 'p001',
          sheetName: '사용내역',
          fileName: '환경AC.xlsx',
          storagePath: 'orgs/mysc/project-sheet-sources/p001/usage/123-환경AC.xlsx',
          downloadURL: 'https://example.com/source.xlsx',
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          uploadedAt: '2026-03-19T12:00:00.000Z',
          rowCount: 176,
          columnCount: 27,
          matchedColumns: ['작성자', '비목'],
          unmatchedColumns: ['정산증빙자료 부착완료 여부'],
          previewMatrix: [['작성자', '비목'], ['메리', '여비']],
        },
      })),
      get: vi.fn(),
      request: vi.fn(),
    });

    const result = await uploadProjectSheetSourceViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'pm' },
      projectId: 'p001',
      upload: {
        sourceType: 'usage',
        sheetName: '사용내역',
        fileName: '환경AC.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileSize: 123456,
        contentBase64: 'ZmFrZS14bHN4',
        rowCount: 176,
        columnCount: 27,
        matchedColumns: ['작성자', '비목'],
        unmatchedColumns: ['정산증빙자료 부착완료 여부'],
        previewMatrix: [['작성자', '비목'], ['메리', '여비']],
        applyTarget: 'expense_sheet',
      },
      client,
    });

    expect(client.post).toHaveBeenCalledWith('/api/v1/projects/p001/sheet-sources/upload', expect.objectContaining({
      tenantId: 'mysc',
      body: expect.objectContaining({
        sourceType: 'usage',
        sheetName: '사용내역',
        applyTarget: 'expense_sheet',
      }),
      timeoutMs: 45000,
    }));
    expect(result.sourceType).toBe('usage');
    expect(result.previewMatrix[1]).toEqual(['메리', '여비']);
  });

  it('normalizes nullable google sheet migration analysis arrays', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          summary: '사용내역 탭으로 보입니다.',
          confidence: 'high',
          likelyTarget: 'expense_sheet',
          usageTips: null,
          warnings: null,
          nextActions: null,
          suggestedMappings: null,
          headerPreview: null,
        },
      })),
      get: vi.fn(),
      request: vi.fn(),
    });

    const analysis = await analyzeGoogleSheetImportViaBff({
      tenantId: 'mysc',
      actor: { uid: 'u001', role: 'pm' },
      projectId: 'p001',
      selectedSheetName: '사용내역',
      matrix: [
        ['작성자', '입금합계', '사업팀'],
        ['No.', '입금액', '지급처'],
      ],
      client,
    });

    expect(analysis.usageTips).toEqual([]);
    expect(analysis.warnings).toEqual([]);
    expect(analysis.nextActions).toEqual([]);
    expect(analysis.suggestedMappings).toEqual([]);
    expect(analysis.headerPreview).toEqual([]);
  });
});
