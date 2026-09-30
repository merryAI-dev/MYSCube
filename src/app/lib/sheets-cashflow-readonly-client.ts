import {
  toRequestActor,
  type ActorLike,
  type GoogleSheetPreviewSheet,
  type PlatformApiClientLike,
} from './platform-bff-client';
import { PlatformApiClient } from '../platform/api-client';
import { extractSpreadsheetId } from '../integrations/google-sheets/link';
import {
  cashflowMutationHeaders,
  type CashflowMutationLease,
} from './cashflow-edit-lease';

export function isCashflowSheetApplyResultUncertain(error: unknown) {
  const apiError = error as { status?: unknown; code?: string; body?: { code?: string; error?: string } };
  const status = Number(apiError?.status);
  if (!Number.isInteger(status)) return true;
  const code = apiError?.code || apiError?.body?.code || apiError?.body?.error || '';
  return code === 'cashflow_sheet_operation_uncertain';
}

export interface CashflowSheetLabWeekColumn {
  raw: string;
  year: number;
  month: number;
  yearMonth: string;
  weekNo: number;
  rowIndex: number;
  columnIndex: number;
  a1: string;
}

export interface CashflowSheetLabAnnualColumn {
  year: number;
  columnIndex: number;
  a1: string;
}

export interface CashflowSheetLabLineRow {
  rowIndex: number;
  label: string;
  canonicalLabel?: string;
  labelColumnIndex: number;
  a1: string;
  lineId: string;
  direction: 'IN' | 'OUT';
}

export interface CashflowSheetLabMappingCandidate {
  mode: 'projection' | 'actual';
  lineId: string;
  label: string;
  canonicalLabel?: string;
  direction: 'IN' | 'OUT';
  yearMonth: string;
  weekNo: number;
  rowIndex: number;
  columnIndex: number;
  a1: string;
  source: 'sheet_layout';
}

export interface CashflowSheetLabPreviewValue extends Omit<CashflowSheetLabMappingCandidate, 'source'> {
  sheetValue: string;
  amount: number | null;
  source: 'firebase_cashflow_weeks';
}

export interface CashflowSheetLabTemplateSection {
  mode: 'projection' | 'actual';
  headerRowIndex: number;
  weekRowIndex: number;
  weekColumns: CashflowSheetLabWeekColumn[];
  annualColumns: CashflowSheetLabAnnualColumn[];
  lineRows: CashflowSheetLabLineRow[];
  derivedRows: Array<{
    rowIndex: number;
    label: string;
    labelColumnIndex: number;
    a1: string;
    kind: 'deposit_total' | 'withdrawal_total' | 'balance';
  }>;
  ignoredRows: Array<{
    rowIndex: number;
    label: string;
    labelColumnIndex: number;
    a1: string;
    reason: string;
  }>;
  mappings: CashflowSheetLabMappingCandidate[];
  annualMappings: Array<Omit<CashflowSheetLabMappingCandidate, 'yearMonth' | 'weekNo' | 'source'> & {
    year: number;
    source: 'sheet_annual_total';
  }>;
  annualDerivedMappings: Array<{
    mode: 'projection' | 'actual';
    derivedKind: 'deposit_total' | 'withdrawal_total' | 'balance';
    label: string;
    year: number;
    periodKind: 'ANNUAL' | 'GRAND_TOTAL';
    rowIndex: number;
    columnIndex: number;
    a1: string;
    source: 'sheet_annual_derived';
  }>;
  missingLineIds: string[];
  duplicateLineIds: string[];
}

export interface CashflowSheetLabTemplateResult {
  supported: boolean;
  policyVersion: string;
  sectionOrder: ['projection', 'actual'];
  sections: CashflowSheetLabTemplateSection[];
  mappingCandidates: CashflowSheetLabMappingCandidate[];
  derivedRows: Array<CashflowSheetLabTemplateSection['derivedRows'][number] & { mode: 'projection' | 'actual' }>;
  ignoredRows: Array<CashflowSheetLabTemplateSection['ignoredRows'][number] & { mode: 'projection' | 'actual' }>;
  reasons: Array<{
    code: string;
    mode?: 'projection' | 'actual';
    lineIds?: string[];
    count?: number;
    message: string;
  }>;
  stats: {
    rowCount: number;
    maxColumnCount: number;
    sectionCount: number;
    mappingCount: number;
  };
}

export interface CashflowSheetLabPreviewResult {
  projectId: string;
  spreadsheetId: string;
  spreadsheetTitle: string;
  selectedSheetName: string;
  availableSheets: GoogleSheetPreviewSheet[];
  matrix: string[][];
  accessPolicy: {
    googleAuth: 'service_account';
    googleScope: 'spreadsheets.readonly';
    sheetPermission: 'shared_with_mysc_system_account';
    layoutSource: 'google_sheet_formatted_values';
    valueSource: 'firebase_cashflow_weeks';
    actorRolePolicy: 'mysc_email_maps_to_workspace_user_for_read';
    sheetReadRange: string;
    sheetPreviewCache: 'hit' | 'miss' | 'in_flight_join';
    sheetNamePolicy: 'cashflow_usage_linked_only';
    sheetConfigSource?: 'request' | 'saved_config';
    weekBasis?: 'sheet_range';
    totalBasis?: 'sheet_range';
  };
  activeWeekRange?: {
    startWeek?: string;
    endWeek?: string;
    weekBasis?: 'sheet_range';
    totalBasis?: 'sheet_range';
  };
  template: CashflowSheetLabTemplateResult;
  previewValues: CashflowSheetLabPreviewValue[];
  cashflowSnapshotStatus: 'pending' | 'ready' | 'unavailable';
  cashflowSnapshotError?: { code: string; message: string } | null;
}

export interface CashflowSheetFormulaMismatchNotice {
  yearMonth: string;
  mode: string;
  weekNo: number;
  field: 'depositTotal' | 'withdrawalTotal' | 'balance' | string;
  reported?: number | string;
  calculated?: number | string;
  sourceCell?: string;
}

export interface CashflowSheetLabApplyResult {
  /** 반영은 됐지만 시트 합계·잔액이 정산 엔진 계산과 다른 칸. */
  formulaMismatches?: CashflowSheetFormulaMismatchNotice[];
  projectId: string;
  spreadsheetId: string;
  spreadsheetTitle: string;
  selectedSheetName: string;
  availableSheets?: GoogleSheetPreviewSheet[];
  matrix?: string[][];
  accessPolicy?: CashflowSheetLabPreviewResult['accessPolicy'];
  template?: CashflowSheetLabTemplateResult;
  previewValues?: CashflowSheetLabPreviewValue[];
  cashflowSnapshotStatus?: CashflowSheetLabPreviewResult['cashflowSnapshotStatus'];
  cashflowSnapshotError?: CashflowSheetLabPreviewResult['cashflowSnapshotError'];
  activeWeekRange?: {
    startWeek?: string;
    endWeek?: string;
    weekBasis?: 'sheet_range';
    totalBasis?: 'sheet_range';
  };
  appliedLineCount: number;
  projectionLineCount: number;
  actualLineCount: number;
  skippedInvalidWeekCount?: number;
  skippedInvalidWeeks?: string[];
  skippedRiskLineCount?: number;
  settledWeekChanges?: Array<{
    yearMonth: string;
    weekNo: number;
    completionRevision: number;
    warningCount: number;
  }>;
  verifiedLineCount?: number;
  lastAppliedAt?: string;
  runId?: string;
  stagedRunId?: string;
  appliedMonths?: string[];
  appliedYears?: number[];
  lastAppliedBy?: {
    uid?: string;
    email?: string;
    role?: string;
  } | null;
  firebaseResult: {
    ok: boolean;
    commandName: string;
    projectId: string;
    sourceSheetKey: string;
    weekBasis?: 'sheet_range';
    totalBasis?: 'sheet_range';
    savedProjectionLineCount: number;
    savedActualLineCount: number;
    skippedInvalidWeekCount?: number;
    skippedInvalidWeeks?: string[];
    verifiedLineCount?: number;
    updatedWeeks: Array<{
      projectId: string;
      yearMonth: string;
      weekNo: number;
      mode: 'projection' | 'actual';
      updatedAt: string;
    }>;
  };
}

export interface CashflowSheetLabChangeCandidate {
  id?: string;
  projectId: string;
  runId: string;
  source: 'google_sheet' | 'portal';
  status: 'draft' | 'pending_review' | 'approved' | 'rejected' | 'applied' | 'superseded' | 'failed';
  mode: 'projection' | 'actual';
  scope?: 'weekly' | 'annual';
  year?: number;
  yearMonth?: string;
  weekNo?: number;
  lineId: string;
  lineDirection: 'in' | 'out';
  beforeAmount: number | null;
  beforeHadValue: boolean;
  beforeCellState?: 'VALUE' | 'ZERO' | 'EMPTY';
  proposedAmount: number | null;
  proposedHadValue: boolean;
  sourceCell?: string;
  sourceLabel?: string;
  riskFlags?: string[];
  actorUid?: string;
  actorName?: string;
  actorEmail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CashflowSheetLabMirrorCell {
  mode: 'projection' | 'actual';
  yearMonth: string;
  weekNo: number;
  lineId: string;
  direction: 'IN' | 'OUT';
  sourceCell: string;
  sourceLabel: string;
  state: 'VALUE' | 'ZERO' | 'EMPTY' | 'INVALID';
  amount?: number;
  rawValue?: string;
}

export interface CashflowSheetLabAnnualCell {
  mode: 'projection' | 'actual';
  year: number;
  lineId: string;
  direction: 'IN' | 'OUT';
  sourceCell: string;
  sourceLabel: string;
  state: 'VALUE' | 'ZERO' | 'EMPTY' | 'INVALID';
  amount?: number;
  rawValue?: string;
}

export interface CashflowSheetLabTotalCell {
  mode: 'projection' | 'actual';
  kind: 'line' | 'derived';
  lineId?: string;
  direction?: 'IN' | 'OUT';
  derivedKind?: 'deposit_total' | 'withdrawal_total' | 'balance';
  sourceCell: string;
  state: 'VALUE' | 'ZERO' | 'EMPTY' | 'INVALID';
  amount?: number;
  rawValue?: string;
}

export interface CashflowSheetLabMirrorResult {
  schemaVersion?: number;
  projectId: string;
  status: 'EMPTY' | 'FRESH' | 'STALE' | 'ERROR';
  sourceFileModifiedTime?: string | null;
  sourceYear?: number;
  sources?: Record<string, {
    sourceYear: number;
    spreadsheetId?: string;
    spreadsheetTitle?: string;
    selectedSheetName?: string;
    sourceRevision?: string;
    capturedAt?: string;
  }>;
  spreadsheetId?: string;
  spreadsheetTitle?: string;
  selectedSheetName?: string;
  sourceRevision?: string;
  targetRevisionAtFetch?: string;
  appliedSourceRevision?: string;
  appliedTargetRevision?: string;
  appliedAnnualYears?: number[];
  appliedWeeklyYears?: number[];
  capturedAt?: string;
  capturedBy?: { uid?: string; email?: string; role?: string };
  yearMonths?: string[];
  years?: number[];
  summary?: { cellCount: number; valueCount: number; emptyCount: number; invalidCount: number };
  cells?: CashflowSheetLabMirrorCell[];
  annualCells?: CashflowSheetLabAnnualCell[];
  totalCells?: CashflowSheetLabTotalCell[];
  sheetFacts?: {
    metadata?: {
      lastUpdateText?: { sourceCell: string; value: string };
      businessType?: { sourceCell: string; value: string };
      accountType?: { sourceCell: string; value: string };
      settlementStatus?: { sourceCell: string; value: string };
    };
    depositScheduleRows?: Array<{
      yearMonth: string;
      weekNo: number;
      taxInvoiceIssuedDate: string;
      expectedDepositDate: string;
      expectedDepositAmount: number | null;
      sourceCells: {
        taxInvoiceIssuedDate: string;
        expectedDepositDate: string;
        expectedDepositAmount: string;
      };
    }>;
    annualFinancialTotals?: Array<{
      year: number;
      contractAmount: number;
      salesVatAmount: number;
      totalRevenueAmount: number;
      supportAmount: number;
    }>;
    annualCashflowTotals?: Array<{
      year: number;
      projection: CashflowSheetLabAnnualModeTotal;
      actual: CashflowSheetLabAnnualModeTotal;
    }>;
    weeklyCalculationChecks?: Array<{
      mode: 'projection' | 'actual';
      yearMonth: string;
      weekNo: number;
      reported: {
        depositTotal: number | null;
        withdrawalTotal: number | null;
        balance: number | null;
      };
      matches: {
        depositTotal: boolean | null;
        withdrawalTotal: boolean | null;
        balance: boolean | null;
      };
    }>;
    cashflowGrandTotalsBySourceYear?: Array<{
      sourceYear: number;
      projection: CashflowSheetLabGrandTotal;
      actual: CashflowSheetLabGrandTotal;
    }>;
  };
  financialYearChecks?: {
    years: Array<{
      year: number;
      status: 'MATCH' | 'MISMATCH' | 'SHEET_YEAR_MISSING';
      mismatches: Array<'contractAmount' | 'salesVatAmount' | 'totalRevenueAmount' | 'supportAmount'>;
      registered: Record<'contractAmount' | 'salesVatAmount' | 'totalRevenueAmount' | 'supportAmount', number>;
      sheet: Record<'contractAmount' | 'salesVatAmount' | 'totalRevenueAmount' | 'supportAmount', number>;
    }>;
    total: {
      status: 'MATCH' | 'MISMATCH' | 'SHEET_YEAR_MISSING';
      mismatches: Array<'contractAmount' | 'salesVatAmount' | 'totalRevenueAmount' | 'supportAmount'>;
      registered: Record<'contractAmount' | 'salesVatAmount' | 'totalRevenueAmount' | 'supportAmount', number>;
      sheet: Record<'contractAmount' | 'salesVatAmount' | 'totalRevenueAmount' | 'supportAmount', number>;
    };
  };
  reconciliationWarnings?: Array<{
    year: number;
    mode: 'projection' | 'actual';
    status: 'MISMATCH' | 'PARTIAL_WEEKLY';
    mismatchedLineIds: string[];
  }>;
  activeWeekRange?: CashflowSheetLabApplyResult['activeWeekRange'] & { activeWeeks?: unknown[] };
  lastRefreshAttemptAt?: string;
  lastRefreshIdempotencyKey?: string;
  lastRefreshError?: {
    code: string;
    message: string;
    statusCode?: number;
    at?: string;
    diagnosticCount?: number;
    diagnostics?: Array<{
      code: string;
      message: string;
      mode?: 'projection' | 'actual';
      sourceCell?: string;
      lineIds?: string[];
    }>;
  } | null;
}

function isCashflowSheetLabMirrorResult(
  value: unknown,
  expected: { projectId: string },
): value is CashflowSheetLabMirrorResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CashflowSheetLabMirrorResult>;
  if (candidate.projectId !== expected.projectId) return false;
  if (!['EMPTY', 'FRESH', 'STALE', 'ERROR'].includes(String(candidate.status || ''))) return false;
  if (candidate.status === 'FRESH' || candidate.status === 'STALE') {
    return typeof candidate.sourceRevision === 'string' && candidate.sourceRevision.length > 0;
  }
  return true;
}

function invalidCashflowSheetMirrorResponse(): Error & { code: string } {
  return Object.assign(new Error('Cashflow sheet refresh returned an invalid response.'), {
    code: 'cashflow_sheet_refresh_response_invalid',
  });
}

export interface CashflowSheetLabAnnualModeTotal {
  source: 'WEEKLY' | 'ANNUAL' | 'NONE';
  coverage: {
    status: 'COMPLETE' | 'PARTIAL' | 'ANNUAL_ONLY' | 'NONE';
    weekCount: number;
    expectedWeekCount: number;
    monthCount: number;
    expectedMonthCount: number;
  };
  valueCellCount: number;
  emptyCellCount: number;
  invalidCellCount: number;
  lineAmounts: Record<string, number>;
  lineStates?: Record<string, 'VALUE' | 'ZERO' | 'EMPTY'>;
  totalIn: number;
  totalOut: number;
  net: number;
  reconciliation: {
    status: 'NOT_APPLICABLE' | 'PARTIAL_WEEKLY' | 'MATCH' | 'MISMATCH';
    mismatchedLineIds: string[];
  };
}

export interface CashflowSheetLabGrandTotal {
  lineAmounts: Record<string, number>;
  lineStates: Record<string, 'VALUE' | 'ZERO' | 'EMPTY'>;
  totalIn: number;
  totalOut: number;
  net: number;
}

export interface CashflowSheetLabStageResult {
  ok: boolean;
  commandName: 'cashflowSheetLab.stage.firebase';
  projectId: string;
  spreadsheetId?: string;
  spreadsheetTitle?: string;
  selectedSheetName?: string;
  activeWeekRange?: CashflowSheetLabApplyResult['activeWeekRange'];
  sourceRevision?: string;
  targetRevisionAtFetch?: string;
  replaceAllActualSources?: boolean;
  runId: string;
  status?: 'READY' | 'BLOCKED' | 'NO_CHANGES';
  stagedLineCount: number;
  projectionLineCount: number;
  actualLineCount: number;
  riskLineCount: number;
  skippedInvalidWeekCount?: number;
  skippedInvalidWeeks?: string[];
  blockedMonths?: string[];
  /** 시트 형식 때문에 이번 반영에서 뺀 달. 이유와 칸 위치는 서버가 준 그대로다. */
  excludedMonths?: Array<{
    yearMonth: string;
    reason: 'INVALID_CELLS' | 'MONTH_INCOMPLETE' | 'AFTER_BLOCKED_MONTH';
    message: string;
    cells?: Array<{ sourceCell: string; rawValue: string }>;
    cellCount?: number;
  }>;
  /** 이번 반영에서 뺀 연간 연도. */
  excludedYears?: Array<{ year: number; reason: string; message: string }>;
  closedMonthDifferences?: Array<{
    yearMonth: string;
    differenceCount: number;
    weeks: number[];
    changes?: Array<{
      mode: string;
      weekNo: number;
      lineId: string;
      beforeHadValue: boolean;
      beforeAmount: number | null;
      afterHadValue: boolean;
      afterAmount: number | null;
    }>;
    truncatedChangeCount?: number;
  }>;
  closedMonthDifferenceCount?: number;
  closedMonthDifferenceManifestHash?: string;
  pendingApprovalDifferences?: Array<{
    requestId: string;
    requestRevision: number;
    requestStatus: 'PENDING' | 'APPROVING' | 'UNCERTAIN';
    requestManifestHash: string;
    yearMonth: string;
    differenceCount: number;
    weeks: number[];
    changes: Array<{
      mode: string;
      weekNo: number;
      lineId: string;
      beforeHadValue: boolean;
      beforeState: 'EMPTY' | 'ZERO' | 'VALUE';
      beforeAmount: number | null;
      afterHadValue: boolean;
      afterState: 'EMPTY' | 'ZERO' | 'VALUE';
      afterAmount: number | null;
    }>;
    truncatedChangeCount: number;
  }>;
  pendingApprovalDifferenceCount?: number;
  pendingApprovalDifferenceManifestHash?: string;
  pendingApprovalContractIssues?: Array<{
    requestId: string;
    yearMonth?: string;
    blockedMonths: string[];
    blockAllCandidates: boolean;
    reasonCode: 'cashflow_pending_approval_contract_unsupported';
    message: string;
  }>;
  stagedMonths?: string[];
  stagedYears?: number[];
  annualLineCount?: number;
  candidates?: CashflowSheetLabChangeCandidate[];
  omittedCandidateCount?: number;
  lastStagedAt?: string;
  lastStagedBy?: {
    uid?: string;
    email?: string;
    role?: string;
  } | null;
}

export interface CashflowFormulaMismatch {
  yearMonth?: string;
  year?: number;
  mode: 'projection' | 'actual';
  weekNo?: number;
  field: 'depositTotal' | 'withdrawalTotal' | 'balance';
  reported: number | null;
  calculated: number | null;
  sourceCell?: string;
}

export function cashflowFormulaMismatchesFromError(error: unknown): CashflowFormulaMismatch[] {
  const details = (error as { body?: { details?: { mismatches?: unknown } } })?.body?.details;
  return Array.isArray(details?.mismatches) ? details.mismatches as CashflowFormulaMismatch[] : [];
}

export interface CashflowSheetLabApplyStatusResult {
  projectId: string;
  status: 'IDLE' | 'APPLYING';
  stagedRun: CashflowSheetLabStageResult | null;
  applyInput: {
    applyRiskCandidates?: boolean;
    closedMonthChangeReason?: string;
    acceptPendingApprovalDifferences?: boolean;
    pendingApprovalDifferenceCount?: number;
    pendingApprovalDifferenceManifestHash?: string;
    acceptFormulaMismatches?: boolean;
    replaceAllActualSources?: boolean;
  } | null;
}

export interface CashflowSheetLabShareAccountResult {
  projectId: string;
  configured?: boolean;
  config?: {
    sourceYear?: number;
    value?: string;
    sheetName?: string;
    spreadsheetId?: string;
    spreadsheetTitle?: string;
    startWeek?: string;
    endWeek?: string;
    updatedAt?: string;
    lastAppliedAt?: string;
    lastAppliedBy?: {
      uid?: string;
      email?: string;
      role?: string;
    } | null;
    lastAppliedLineCount?: number;
    lastProjectionLineCount?: number;
    lastActualLineCount?: number;
  } | null;
  configs?: NonNullable<CashflowSheetLabShareAccountResult['config']>[];
  projectYears?: number[];
  systemAccountEmail?: string;
  accessPolicy?: {
    googleAuth: 'service_account';
    serviceAccountEmail?: string;
    sheetPermission: 'shared_with_mysc_system_account';
  };
}

export const extractSpreadsheetIdFromSheetInput = extractSpreadsheetId;

let sameOriginBffClient: PlatformApiClient | undefined;

function createSameOriginBffClient(): PlatformApiClient {
  return sameOriginBffClient ||= new PlatformApiClient({
    baseUrl: '',
    maxRetries: 1,
    retryDelayMs: 200,
    timeoutMs: 25000,
  });
}

export async function saveCashflowSheetLabConfigViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  sourceYear?: number;
  value: string;
  sheetName?: string;
  startWeek?: string;
  endWeek?: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowSheetLabShareAccountResult> {
  const apiClient = params.client || createSameOriginBffClient();
  const response = await apiClient.request<CashflowSheetLabShareAccountResult>(
    `/api/v1/projects/${encodeURIComponent(params.projectId)}/cashflow-sheet-lab/config`,
    {
      method: 'PUT',
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: {
        ...(params.sourceYear ? { sourceYear: params.sourceYear } : {}),
        value: params.value,
        ...(params.sheetName ? { sheetName: params.sheetName } : {}),
        ...(params.startWeek ? { startWeek: params.startWeek } : {}),
        ...(params.endWeek ? { endWeek: params.endWeek } : {}),
      },
      timeoutMs: 15000,
      retries: 0,
    },
  );
  return response.data;
}

export async function applyCashflowSheetLabViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  value?: string;
  sheetName?: string;
  startWeek?: string;
  endWeek?: string;
  stageRunId?: string;
  replaceAllActualSources?: boolean;
  applyRiskCandidates?: boolean;
  settledWeekChangeConfirmationId?: string;
  closedMonthChangeReason?: string;
  closedMonthDifferenceCount?: number;
  closedMonthDifferenceManifestHash?: string;
  acceptPendingApprovalDifferences?: boolean;
  pendingApprovalDifferenceCount?: number;
  pendingApprovalDifferenceManifestHash?: string;
  acceptFormulaMismatches?: boolean;
  idempotencyKey: string;
  lease?: CashflowMutationLease;
  finalize?: boolean;
  client?: PlatformApiClientLike;
}): Promise<CashflowSheetLabApplyResult> {
  const apiClient = params.client || createSameOriginBffClient();
  const response = await apiClient.post<CashflowSheetLabApplyResult>(
    `/api/v1/projects/${encodeURIComponent(params.projectId)}/cashflow-sheet-lab/apply`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: {
        ...(params.value ? { value: params.value } : {}),
        ...(params.sheetName ? { sheetName: params.sheetName } : {}),
        ...(params.startWeek ? { startWeek: params.startWeek } : {}),
        ...(params.endWeek ? { endWeek: params.endWeek } : {}),
        ...(params.stageRunId ? { stageRunId: params.stageRunId } : {}),
        ...(params.replaceAllActualSources ? { replaceAllActualSources: true } : {}),
        ...(typeof params.applyRiskCandidates === 'boolean' ? { applyRiskCandidates: params.applyRiskCandidates } : {}),
        ...(params.settledWeekChangeConfirmationId
          ? { settledWeekChangeConfirmationId: params.settledWeekChangeConfirmationId }
          : {}),
        ...(params.closedMonthChangeReason?.trim() ? { closedMonthChangeReason: params.closedMonthChangeReason.trim() } : {}),
        ...(Number.isSafeInteger(params.closedMonthDifferenceCount) ? { closedMonthDifferenceCount: params.closedMonthDifferenceCount } : {}),
        ...(params.closedMonthDifferenceManifestHash ? { closedMonthDifferenceManifestHash: params.closedMonthDifferenceManifestHash } : {}),
        ...(params.acceptPendingApprovalDifferences ? { acceptPendingApprovalDifferences: true } : {}),
        ...(Number.isSafeInteger(params.pendingApprovalDifferenceCount) ? { pendingApprovalDifferenceCount: params.pendingApprovalDifferenceCount } : {}),
        ...(params.pendingApprovalDifferenceManifestHash ? { pendingApprovalDifferenceManifestHash: params.pendingApprovalDifferenceManifestHash } : {}),
        ...(params.acceptFormulaMismatches ? { acceptFormulaMismatches: true } : {}),
        idempotencyKey: params.idempotencyKey,
      },
      idempotencyKey: params.idempotencyKey,
      ...(params.lease ? {
        headers: {
          ...cashflowMutationHeaders(params.lease),
          ...(params.finalize ? { 'x-edit-finalize': 'true' } : {}),
        },
      } : {}),
      timeoutMs: 300000,
      retries: 0,
    },
  );
  return response.data;
}

export async function getCashflowSheetLabApplyStatusViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowSheetLabApplyStatusResult> {
  const apiClient = params.client || createSameOriginBffClient();
  const response = await apiClient.request<CashflowSheetLabApplyStatusResult>(
    `/api/v1/projects/${encodeURIComponent(params.projectId)}/cashflow-sheet-lab/apply-status`,
    {
      method: 'GET',
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      timeoutMs: 15000,
      retries: 0,
    },
  );
  return response.data;
}

export async function stageCashflowSheetLabViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  expectedMirrorRevision: string;
  yearMonth?: string;
  replaceAllActualSources?: boolean;
  idempotencyKey: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowSheetLabStageResult> {
  const apiClient = params.client || createSameOriginBffClient();
  const response = await apiClient.post<CashflowSheetLabStageResult>(
    `/api/v1/projects/${encodeURIComponent(params.projectId)}/cashflow-sheet-lab/stage`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: {
        expectedMirrorRevision: params.expectedMirrorRevision,
        ...(params.yearMonth ? { yearMonth: params.yearMonth } : {}),
        ...(params.replaceAllActualSources ? { replaceAllActualSources: true } : {}),
        idempotencyKey: params.idempotencyKey,
      },
      idempotencyKey: params.idempotencyKey,
      timeoutMs: 30000,
      retries: 0,
    },
  );
  return response.data;
}

export async function getCashflowSheetLabMirrorViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowSheetLabMirrorResult> {
  const apiClient = params.client || createSameOriginBffClient();
  const response = await apiClient.get<CashflowSheetLabMirrorResult>(
    `/api/v1/projects/${encodeURIComponent(params.projectId)}/cashflow-sheet-lab/mirror`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      timeoutMs: 15000,
      retries: 0,
    },
  );
  return response.data;
}

export async function refreshCashflowSheetLabMirrorViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  sourceYear?: number;
  value?: string;
  sheetName?: string;
  startWeek?: string;
  endWeek?: string;
  idempotencyKey: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowSheetLabMirrorResult> {
  const apiClient = params.client || createSameOriginBffClient();
  const response = await apiClient.post<CashflowSheetLabMirrorResult>(
    `/api/v1/projects/${encodeURIComponent(params.projectId)}/cashflow-sheet-lab/mirror/refresh`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: {
        ...(params.sourceYear ? { sourceYear: params.sourceYear } : {}),
        ...(params.value ? { value: params.value } : {}),
        ...(params.sheetName ? { sheetName: params.sheetName } : {}),
        ...(params.startWeek ? { startWeek: params.startWeek } : {}),
        ...(params.endWeek ? { endWeek: params.endWeek } : {}),
        idempotencyKey: params.idempotencyKey,
      },
      idempotencyKey: params.idempotencyKey,
      timeoutMs: 30000,
      retries: 0,
    },
  );
  const expectedMirror = { projectId: params.projectId };
  if (isCashflowSheetLabMirrorResult(response.data, expectedMirror)) return response.data;
  throw invalidCashflowSheetMirrorResponse();
}

export async function getCashflowSheetLabShareAccountViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  sourceYear?: number;
  client?: PlatformApiClientLike;
}): Promise<CashflowSheetLabShareAccountResult> {
  const apiClient = params.client || createSameOriginBffClient();
  const response = await apiClient.get<CashflowSheetLabShareAccountResult>(
    `/api/v1/projects/${encodeURIComponent(params.projectId)}/cashflow-sheet-lab/config${params.sourceYear ? `?sourceYear=${params.sourceYear}` : ''}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      timeoutMs: 15000,
      retries: 0,
    },
  );
  return response.data;
}

export interface CashflowSheetFreshnessProbe {
  status: 'AVAILABLE' | 'UNAVAILABLE';
  mirrorLoaded: boolean;
  sheetChangedSinceMirror: boolean;
  checkedAt: string;
}

// 진입 전용 경량 변경 감지. 시트 풀 리드 없이 modifiedTime 만 대조한다 (~0.1s).
export async function probeCashflowSheetFreshnessViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowSheetFreshnessProbe> {
  const apiClient = params.client || createSameOriginBffClient();
  const response = await apiClient.post<CashflowSheetFreshnessProbe>(
    `/api/v1/projects/${encodeURIComponent(params.projectId)}/cashflow-sheet-lab/changes/probe`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: {},
      timeoutMs: 12000,
      retries: 0,
    },
  );
  return response.data;
}

export type CashflowSheetStep = 'refresh' | 'stage' | 'apply';

const CASHFLOW_SHEET_PHASE_LABELS: Record<CashflowSheetStep | 'save', string> = {
  refresh: '① 시트 불러오기',
  stage: '② 반영 검토',
  apply: '③ 반영',
  save: '④ 정산 엔진 저장',
};

/** 시트 반영 오류가 어느 단계에서 났는지. 반영 중 정산 엔진이 거절·검증 실패한 경우는 저장 단계로 본다. */
export function cashflowSheetErrorPhase(step: CashflowSheetStep, error: unknown): string {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : '';
  if (step === 'apply' && /^(cashflow_jvm_|jvm_)/.test(code)) return CASHFLOW_SHEET_PHASE_LABELS.save;
  return CASHFLOW_SHEET_PHASE_LABELS[step];
}

/** 이번 반영에서 뺀 달·연도를 사람이 읽는 줄로 편다. 서버 문구와 칸 위치를 그대로 쓴다. */
export function describeCashflowSheetExclusions(stage: Pick<CashflowSheetLabStageResult, 'excludedMonths' | 'excludedYears'> | null | undefined): string[] {
  const lines: string[] = [];
  const months = stage?.excludedMonths || [];
  const direct = months.filter((month) => month.reason !== 'AFTER_BLOCKED_MONTH');
  for (const month of direct) {
    const cells = (month.cells || []).slice(0, 5)
      .map((cell) => (cell.rawValue ? `${cell.sourceCell}('${cell.rawValue}')` : cell.sourceCell))
      .join(', ');
    const more = (month.cellCount || 0) > 5 ? ` 외 ${(month.cellCount || 0) - 5}칸` : '';
    lines.push(`${month.message}${cells ? ` 확인할 칸: ${cells}${more}` : ''}`);
  }
  const following = months.filter((month) => month.reason === 'AFTER_BLOCKED_MONTH').map((month) => month.yearMonth);
  if (following.length > 0) {
    lines.push(`${following[0]}${following.length > 1 ? `~${following[following.length - 1]}` : ''}은 앞 달 잔액을 이어받을 수 없어 이번 반영에서 뺐습니다.`);
  }
  for (const year of stage?.excludedYears || []) lines.push(year.message);
  return lines;
}

const FORMULA_FIELD_LABELS: Record<string, string> = { depositTotal: '입금 합계', withdrawalTotal: '출금 합계', balance: '잔액' };
const MODE_LABELS: Record<string, string> = { projection: 'Projection', actual: 'Actual' };

function formatWon(value: unknown): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${amount.toLocaleString('ko-KR')}원` : String(value ?? '');
}

/** 반영 후 합계·잔액 불일치를 "어느 주차 · 어느 칸 · 시트 값 · 계산 값" 줄로 편다. */
export function describeCashflowSheetFormulaMismatches(mismatches: CashflowSheetFormulaMismatchNotice[] | null | undefined): string[] {
  const list = mismatches || [];
  const lines = list.slice(0, 10).map((mismatch) => {
    const field = FORMULA_FIELD_LABELS[mismatch.field] || mismatch.field;
    const where = `${mismatch.yearMonth} ${mismatch.weekNo}주차 ${MODE_LABELS[mismatch.mode] || mismatch.mode} ${field}${mismatch.sourceCell ? `(${mismatch.sourceCell})` : ''}`;
    return `${where}: 시트 ${formatWon(mismatch.reported)} · 항목 합으로 계산 ${formatWon(mismatch.calculated)}`;
  });
  return list.length > 10 ? [...lines, `외 ${list.length - 10}건`] : lines;
}
