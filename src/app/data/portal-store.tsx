import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { isPermissionDenied } from '../platform/firestore-error';
import {
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import type {
  BankImportIntakeItem,
  BudgetPlanRow,
  BudgetCodeEntry,
  BudgetCodeRename,
  BudgetTreeCode,
  BudgetTreeV2,
  Comment,
  Ledger,
  ProjectSheetSourceSnapshot,
  ProjectSheetSourceType,
  Project,
  ProjectCheckout,
  ProjectStatus,
  OrgMember,
  ParticipationEntry,
  Transaction,
  TransactionState,
  WeeklySubmissionStatus,
  ProjectRequest,
  ProjectRequestPayload,
} from './types';
import {
  normalizeAccountType,
  normalizeBasis,
  normalizeProjectContractType,
  normalizeProjectFundInputMode,
  normalizeProjectPhase,
  normalizeProjectStatus,
  normalizeProjectType,
  normalizeSettlementSheetPolicy,
  normalizeSettlementType,
} from './types';
import type { ExpenseSet, ExpenseItem, ExpenseSetStatus } from './budget-data';
import { BUDGET_CODE_BOOK, EXPENSE_SETS } from './budget-data';
import {
  CHANGE_REQUESTS,
  type ChangeRequest,
  type ChangeRequestState,
} from './personnel-change-data';
import { LEDGERS, PROJECTS, TRANSACTIONS } from './mock-data';
import { SETTLEMENT_COLUMNS } from '../platform/settlement-csv';
import type { ImportRow } from '../platform/settlement-csv';
import {
  BANK_STATEMENT_COLUMNS,
  buildBankStatementServerImportLines,
  buildBankImportIntakeItemsFromBankSheet,
  mapBankStatementsToImportRows,
  mergeBankRowsIntoExpenseSheet,
  type BankStatementRow,
  type BankStatementSheet,
} from '../platform/bank-statement';
import { normalizeSpace } from '../platform/csv-utils';
import { isBankImportManualFieldsComplete, resolveBankImportProjectionStatus } from '../platform/bank-import-triage';
import { normalizeProjectDepartment, resolveProjectCic } from '../platform/project-cic';
import { normalizeProjectFinancialInputFlagsForAmounts } from '../platform/project-contract-amount';
import { resolveProjectRevenueFinancials } from '../platform/project-financials';
import {
  resolveEvidenceRequiredDesc,
} from '../platform/settlement-sheet-prepare';
import { resolveEvidenceChecklist } from '../platform/evidence-helpers';
import { prepareExpenseSheetRowsForSave } from './portal-store.settlement';
import {
  buildExpenseSheetPersistenceDoc,
  patchExpenseSheetProjectionEvidenceBySourceTxId,
  upsertExpenseSheetProjectionRowBySourceTxId,
  upsertExpenseSheetTabRows,
  buildWeeklySubmissionStatusPatch,
  sanitizeExpenseSheetName,
  serializeExpenseSheetRowForPersistence,
} from './portal-store.persistence';
import {
  buildBankImportIntakeDoc,
  mergeBankImportIntakeItem,
  normalizeBankImportIntakeItem,
  reconcileBankImportUploadItems,
} from './portal-store.intake';
import { useAuth } from './auth-store';
import { useFirebase } from '../lib/firebase-context';
import { getAuthInstance, getOrgCollectionPath, getOrgDocumentPath } from '../lib/firebase';
import {
  addCommentViaBff,
  applyBankStatementItemsViaBff,
  applyEvidenceRequiredMapIntentViaBff,
  applyWeeklySubmissionStatusIntentViaBff,
  changeTransactionStateViaBff,
  importBankStatementBatchViaBff,
  isPlatformApiEnabled,
  readWeeklyExpenseSheetViaBff,
  saveWeeklyExpenseDraftViaBff,
  type UpsertProjectPayload,
  upsertProjectViaBff,
  uploadProjectCheckoutAttachmentViaBff,
  upsertTransactionViaBff,
} from '../lib/platform-bff-client';
import type { CashflowMutationLease } from '../lib/cashflow-edit-lease';
import { createCashflowPrivateDraftClient } from '../lib/cashflow-private-draft-client';
import { duplicateExpenseSetAsDraft, withExpenseItems } from './portal-store.helpers';
import { buildPortalProfilePatch, readMemberWorkspace, resolveMemberProjectAccessState } from './member-workspace';
import { buildLegacyMemberDocId, mergeMemberRecordSources } from './member-documents';
import { toast } from 'sonner';
import { includesProject, normalizeProjectIds, resolvePrimaryProjectId } from './project-assignment';
import { canEnterPortalWorkspace } from '../platform/navigation';
import { readDevAuthHarnessConfig } from '../platform/dev-harness';
import { reportError } from '../platform/observability';
import { validateBudgetCodeBookDraft } from '../platform/budget-code-book-validation';
import { buildBudgetLabelKey, normalizeBudgetLabel } from '../platform/budget-labels';
import { buildLegacyBudgetSnapshotsFromTree, normalizeBudgetTreeCodes } from '../platform/budget-tree-v2';
import { useFirestoreAccessPolicy } from './firestore-realtime-mode';
import {
  resolveActivePortalProjectId,
  resolvePortalProjectCandidates,
} from '../platform/portal-project-selection';
import { listenMembers } from '../lib/firestore-service';

export interface PortalUser {
  id: string;
  name: string;
  email: string;
  role: string;
  projectId: string;
  projectIds: string[];
  projectNames?: Record<string, string>;
  registeredAt: string;
}

export interface BankStatementApplyCellPatch {
  columnIndex: number;
  rawValue: string;
  userEdited?: boolean;
}

export interface BankStatementApplyOptions {
  cellPatchesByRowKey?: Record<string, BankStatementApplyCellPatch[]>;
  cashflowLease?: CashflowMutationLease;
}

export interface CashflowMutationOptions {
  cashflowLease?: CashflowMutationLease;
  canonicalFinal?: boolean;
  finalize?: boolean;
}

const ACTIVE_PORTAL_PROJECT_STORAGE_KEY = 'mysc-portal-active-project';

function getActivePortalProjectStorageKey(uid: string | null | undefined): string {
  return `${ACTIVE_PORTAL_PROJECT_STORAGE_KEY}:${String(uid || '').trim()}`;
}

function normalizePortalRole(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) return 'pm';
  return normalized === 'viewer' ? 'pm' : normalized;
}

function normalizeExpenseSheetRows(rows: unknown): ImportRow[] | null {
  if (!Array.isArray(rows)) return null;
  return rows.map((row, index) => {
    const candidate = row && typeof row === 'object' ? row as Partial<ImportRow> & {
      userEditedCellIndexes?: unknown;
      userEditedCells?: unknown;
      reviewHints?: unknown;
      reviewRequiredCellIndexes?: unknown;
      reviewStatus?: unknown;
      reviewFingerprint?: unknown;
      reviewConfirmedAt?: unknown;
    } : {};
    const rawUserEdited = Array.isArray(candidate.userEditedCellIndexes)
      ? candidate.userEditedCellIndexes
      : Array.isArray(candidate.userEditedCells)
        ? candidate.userEditedCells
        : candidate.userEditedCells instanceof Set
          ? Array.from(candidate.userEditedCells)
          : [];
    const userEditedCells = new Set(
      rawUserEdited
        .map((value) => (typeof value === 'number' ? value : Number.parseInt(String(value), 10)))
        .filter((value) => Number.isInteger(value) && value >= 0),
    );
    return {
      tempId: candidate.tempId || `imp-${Date.now()}-${index}`,
      ...(candidate.sourceTxId ? { sourceTxId: candidate.sourceTxId } : {}),
      ...(candidate.entryKind ? { entryKind: candidate.entryKind } : {}),
      cells: Array.isArray(candidate.cells) ? candidate.cells.map((cell) => String(cell ?? '')) : [],
      ...(candidate.error ? { error: String(candidate.error) } : {}),
      ...(Array.isArray(candidate.reviewHints)
        ? { reviewHints: candidate.reviewHints.map((item) => String(item)) }
        : {}),
      ...(Array.isArray(candidate.reviewRequiredCellIndexes)
        ? {
            reviewRequiredCellIndexes: candidate.reviewRequiredCellIndexes
              .map((value) => (typeof value === 'number' ? value : Number.parseInt(String(value), 10)))
              .filter((value) => Number.isInteger(value) && value >= 0),
          }
        : {}),
      ...(candidate.reviewStatus === 'pending' || candidate.reviewStatus === 'confirmed'
        ? { reviewStatus: candidate.reviewStatus }
        : {}),
      ...(candidate.reviewFingerprint ? { reviewFingerprint: String(candidate.reviewFingerprint) } : {}),
      ...(candidate.reviewConfirmedAt ? { reviewConfirmedAt: String(candidate.reviewConfirmedAt) } : {}),
      ...(userEditedCells.size > 0 ? { userEditedCells } : {}),
    } satisfies ImportRow;
  });
}

function serializeExpenseSheetRowsForComparison(rows: ImportRow[] | null | undefined): string {
  if (!rows || rows.length === 0) return '[]';
  return JSON.stringify(rows.map((row) => serializeExpenseSheetRowForPersistence(row)));
}

function stableSerializeForComparison(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerializeForComparison(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerializeForComparison(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function serializeProjectForComparison(project: Project): string {
  return stableSerializeForComparison(project);
}

export function areProjectsEqual(left: Project[], right: Project[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (serializeProjectForComparison(left[i]) !== serializeProjectForComparison(right[i])) {
      return false;
    }
  }
  return true;
}

export function mergeProjectSnapshot(projects: Project[], project: Project): Project[] {
  const map = new Map(projects.map((item) => [item.id, item]));
  map.set(project.id, project);
  return Array.from(map.values()).sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'ko'),
  );
}

export function areExpenseSheetRowsEqual(
  left: ImportRow[] | null | undefined,
  right: ImportRow[] | null | undefined,
): boolean {
  return serializeExpenseSheetRowsForComparison(left) === serializeExpenseSheetRowsForComparison(right);
}

function serializeExpenseSheetTabForComparison(tab: ExpenseSheetTab): string {
  return JSON.stringify({
    id: tab.id,
    name: tab.name,
    order: tab.order,
    createdAt: tab.createdAt || '',
    updatedAt: tab.updatedAt || '',
    rows: serializeExpenseSheetRowsForComparison(tab.rows),
  });
}

export function areExpenseSheetTabsEqual(
  left: ExpenseSheetTab[],
  right: ExpenseSheetTab[],
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (serializeExpenseSheetTabForComparison(left[i]) !== serializeExpenseSheetTabForComparison(right[i])) {
      return false;
    }
  }
  return true;
}

function resolveExpenseSheetFallbackId(expenseSheets: ExpenseSheetTab[]): string {
  return expenseSheets.find((sheet) => sheet.id === 'default')?.id || expenseSheets[0]?.id || 'default';
}

export function reconcileExpenseSheetTabsFromSnapshot(params: {
  currentSheets: ExpenseSheetTab[];
  nextSheets: ExpenseSheetTab[];
  activeExpenseSheetId: string;
}) {
  const nextActiveExpenseSheetId = params.nextSheets.some((sheet) => sheet.id === params.activeExpenseSheetId)
    ? params.activeExpenseSheetId
    : resolveExpenseSheetFallbackId(params.nextSheets);
  return {
    expenseSheets: areExpenseSheetTabsEqual(params.currentSheets, params.nextSheets)
      ? params.currentSheets
      : params.nextSheets,
    activeExpenseSheetId: nextActiveExpenseSheetId,
    sheetsChanged: !areExpenseSheetTabsEqual(params.currentSheets, params.nextSheets),
    activeChanged: nextActiveExpenseSheetId !== params.activeExpenseSheetId,
  };
}

export function reconcileExpenseSheetRowsFromSelection(params: {
  expenseSheets: ExpenseSheetTab[];
  activeExpenseSheetId: string;
  currentRows: ImportRow[] | null;
}) {
  const activeSheet = params.expenseSheets.find((sheet) => sheet.id === params.activeExpenseSheetId) || null;
  const nextRows = activeSheet?.rows || null;
  const rowsChanged = !areExpenseSheetRowsEqual(params.currentRows, nextRows);
  return {
    expenseSheetRows: rowsChanged ? nextRows : params.currentRows,
    rowsChanged,
  };
}

export function shouldHydrateDevHarnessPortalSnapshot(params: {
  projectId: string | null | undefined;
  hydratedProjectId: string | null | undefined;
}): boolean {
  return !!params.projectId && params.projectId !== params.hydratedProjectId;
}

interface DevHarnessPortalSnapshot {
  activeExpenseSheetId?: string;
  expenseIntakeItems?: unknown[];
  expenseSheets?: Array<{
    id?: string;
    name?: string;
    rows?: unknown;
    order?: number;
    createdAt?: string;
    updatedAt?: string;
  }>;
  sheetSources?: ProjectSheetSourceSnapshot[];
  weeklySubmissionStatuses?: WeeklySubmissionStatus[];
}

function getDevHarnessPortalStorageKey(projectId: string): string {
  return `portal-dev-harness:${projectId}`;
}

function readDevHarnessPortalSnapshot(projectId: string): DevHarnessPortalSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(getDevHarnessPortalStorageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DevHarnessPortalSnapshot;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeDevHarnessPortalSnapshot(projectId: string, snapshot: DevHarnessPortalSnapshot): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(getDevHarnessPortalStorageKey(projectId), JSON.stringify(snapshot));
}

export interface ExpenseSheetTab {
  id: string;
  name: string;
  rows: ImportRow[] | null;
  order: number;
  createdAt?: string;
  updatedAt?: string;
}

export function syncExpenseIntakeEvidenceState(params: {
  item: BankImportIntakeItem;
  updates: Partial<BankImportIntakeItem>;
  evidenceRequiredMap: Record<string, string>;
  expenseSheets: ExpenseSheetTab[];
  activeExpenseSheetId: string;
  activeRows: ImportRow[] | null;
  now: string;
}) {
  const mergedCandidate = mergeBankImportIntakeItem(params.item, {
    ...params.updates,
    updatedAt: params.now,
  });
  if (!mergedCandidate) {
    return {
      item: params.item,
      expenseSheets: params.expenseSheets,
      activeRows: params.activeRows,
    };
  }

  const evidenceRequiredDesc = resolveEvidenceRequiredDesc(
    params.evidenceRequiredMap,
    mergedCandidate.manualFields.budgetCategory || '',
    mergedCandidate.manualFields.budgetSubCategory || '',
  );
  const evidenceChecklist = resolveEvidenceChecklist({
    evidenceRequired: [],
    evidenceRequiredDesc,
    evidenceCompletedDesc: mergedCandidate.manualFields.evidenceCompletedDesc || '',
    evidenceCompletedManualDesc: mergedCandidate.manualFields.evidenceCompletedDesc || '',
    evidenceAutoListedDesc: '',
    evidenceDriveLink: '',
    evidenceDriveFolderId: '',
  });
  const syncedItem = normalizeBankImportIntakeItem({
    ...mergedCandidate,
    evidenceStatus: evidenceChecklist.status,
    projectionStatus: resolveBankImportProjectionStatus({
      matchState: mergedCandidate.matchState,
      manualFields: mergedCandidate.manualFields,
      evidenceStatus: evidenceChecklist.status,
    }),
    updatedAt: params.now,
  }) || params.item;

  const targetSheetId = syncedItem.existingExpenseSheetId || params.activeExpenseSheetId || 'default';
  const targetSheet = params.expenseSheets.find((sheet) => sheet.id === targetSheetId) || null;
  const targetRows = targetSheet?.rows || (targetSheetId === params.activeExpenseSheetId ? params.activeRows : null);
  const patched = patchExpenseSheetProjectionEvidenceBySourceTxId({
    rows: targetRows,
    sourceTxId: syncedItem.sourceTxId,
    evidenceRequiredDesc,
    evidenceCompletedDesc: syncedItem.manualFields.evidenceCompletedDesc || '',
    evidenceStatus: evidenceChecklist.status,
  });

  const nextSheets = patched.patchedRow
    ? upsertExpenseSheetTabRows({
        sheets: params.expenseSheets,
        sheetId: targetSheetId,
        sheetName: sanitizeExpenseSheetName(targetSheet?.name, targetSheetId === 'default' ? '기본 탭' : '새 탭'),
        order: targetSheet?.order || (targetSheetId === 'default' ? 0 : params.expenseSheets.length + 1),
        rows: patched.rows,
        now: params.now,
        createdAt: targetSheet?.createdAt,
      })
    : params.expenseSheets;

  return {
    item: syncedItem,
    expenseSheets: nextSheets,
    activeRows: targetSheetId === params.activeExpenseSheetId ? patched.rows : params.activeRows,
    evidenceRequiredDesc,
  };
}

function sanitizeBankStatementSheet(sheet: BankStatementSheet): BankStatementSheet {
  const incomingColumns = Array.isArray(sheet?.columns) ? sheet.columns : [];
  const maxLenFromRows = Array.isArray(sheet?.rows)
    ? sheet.rows.reduce((max, row) => Math.max(max, Array.isArray(row?.cells) ? row.cells.length : 0), 0)
    : 0;
  const rawColumns = incomingColumns.length > 0
    ? incomingColumns
    : Array.from({ length: maxLenFromRows }, (_, i) => BANK_STATEMENT_COLUMNS[i] || `컬럼${i + 1}`);
  const seen = new Set<string>();
  const columns = rawColumns.map((column, i) => {
    const base = normalizeSpace(String(column || `컬럼${i + 1}`)) || `컬럼${i + 1}`;
    let next = base;
    let suffix = 2;
    while (seen.has(next)) {
      next = `${base}_${suffix}`;
      suffix += 1;
    }
    seen.add(next);
    return next;
  });
  const rows = (Array.isArray(sheet?.rows) ? sheet.rows : []).map((row, i) => ({
    tempId: row?.tempId || `bank-${Date.now()}-${i}`,
    cells: columns.map((_, colIdx) => normalizeSpace(String(Array.isArray(row?.cells) ? (row.cells[colIdx] ?? '') : ''))),
    status: row?.status === 'applied' ? 'applied' : 'staged',
  }));
  return { columns, rows: rows as BankStatementRow[] };
}

interface PortalState {
  isRegistered: boolean;
  isLoading: boolean;
  isProjectCatalogReady: boolean;
  portalUser: PortalUser | null;
  activeProjectId: string;
  members: OrgMember[];
  projects: Project[];
  ledgers: Ledger[];
  myProject: Project | null;
  participationEntries: ParticipationEntry[];
  expenseSets: ExpenseSet[];
  changeRequests: ChangeRequest[];
  transactions: Transaction[];
  comments: Comment[];
  evidenceRequiredMap: Record<string, string>;
  sheetSources: ProjectSheetSourceSnapshot[];
  expenseIntakeItems: BankImportIntakeItem[];
  expenseSheets: ExpenseSheetTab[];
  activeExpenseSheetId: string;
  expenseSheetRows: ImportRow[] | null;
  bankStatementRows: BankStatementSheet | null;
  bankStatementProjectId: string;
  budgetPlanRows: BudgetPlanRow[] | null;
  budgetCodeBook: BudgetCodeEntry[];
  budgetTreeV2: BudgetTreeV2 | null;
  weeklySubmissionStatuses: WeeklySubmissionStatus[];
}

interface PortalActions {
  register: (
    user: Omit<PortalUser, 'id' | 'registeredAt' | 'projectId' | 'projectIds'> & {
      projectId?: string;
      projectIds?: string[];
    },
  ) => Promise<boolean>;
  setSessionActiveProject: (projectId: string) => Promise<boolean>;
  patchProjectSnapshot: (project: Project) => void;
  updateProjectStatus: (projectId: string, status: ProjectStatus) => Promise<boolean>;
  updateProjectCheckout: (projectId: string, patch: Partial<ProjectCheckout>) => Promise<boolean>;
  uploadProjectCheckoutDocument: (projectId: string, documentKind: string, file: File) => Promise<boolean>;
  logout: () => void;
  addExpenseSet: (set: ExpenseSet) => void;
  updateExpenseSet: (id: string, updates: Partial<ExpenseSet>) => void;
  addExpenseItem: (setId: string, item: ExpenseItem) => void;
  updateExpenseItem: (setId: string, itemId: string, item: ExpenseItem) => void;
  deleteExpenseItem: (setId: string, itemId: string) => void;
  changeExpenseStatus: (setId: string, status: ExpenseSetStatus, reason?: string) => void;
  duplicateExpenseSet: (setId: string) => void;
  addChangeRequest: (req: ChangeRequest) => void;
  submitChangeRequest: (id: string) => Promise<boolean>;
  addTransaction: (tx: Transaction, options?: CashflowMutationOptions) => Promise<void>;
  updateTransaction: (id: string, updates: Partial<Transaction>, options?: CashflowMutationOptions) => Promise<void>;
  patchTransactionSnapshot: (id: string, updates: Partial<Transaction>) => void;
  changeTransactionState: (id: string, newState: TransactionState, reason?: string, options?: CashflowMutationOptions) => Promise<void>;
  addComment: (comment: Comment, options?: CashflowMutationOptions) => Promise<void>;
  saveEvidenceRequiredMap: (map: Record<string, string>, options?: { cashflowLease?: CashflowMutationLease }) => Promise<void>;
  markSheetSourceApplied: (input: { sourceType: ProjectSheetSourceType; applyTarget: string }) => Promise<void>;
  upsertExpenseIntakeItems: (items: BankImportIntakeItem[]) => Promise<void>;
  saveExpenseIntakeDraft: (id: string, updates: Partial<BankImportIntakeItem>) => Promise<void>;
  updateExpenseIntakeItem: (id: string, updates: Partial<BankImportIntakeItem>) => Promise<void>;
  projectExpenseIntakeItem: (id: string, updates?: Partial<BankImportIntakeItem>) => Promise<void>;
  syncExpenseIntakeEvidence: (id: string, updates: Partial<BankImportIntakeItem>) => Promise<void>;
  setActiveExpenseSheet: (sheetId: string) => void;
  createExpenseSheet: (name?: string) => Promise<string | null>;
  renameExpenseSheet: (sheetId: string, name: string) => Promise<boolean>;
  deleteExpenseSheet: (sheetId: string) => Promise<boolean>;
  saveExpenseSheetRows: (rows: ImportRow[], options?: CashflowMutationOptions) => Promise<ImportRow[]>;
  saveBankStatementRows: (sheet: BankStatementSheet, options?: CashflowMutationOptions) => Promise<void>;
  applyBankStatementRowsToExpenseSheet: (sheet: BankStatementSheet & { selectedRowIds?: string[] }, options?: BankStatementApplyOptions) => Promise<{ appliedCount: number }>;
  refreshBankStatementRows: (status?: 'staged' | 'applied') => Promise<void>;
  saveBudgetPlanRows: (rows: BudgetPlanRow[]) => Promise<void>;
  saveBudgetCodeBook: (rows: BudgetCodeEntry[], renames?: BudgetCodeRename[]) => Promise<void>;
  saveBudgetTreeV2: (codes: BudgetTreeCode[]) => Promise<void>;
  upsertWeeklySubmissionStatus: (input: {
    projectId: string;
    yearMonth: string;
    weekNo: number;
    projectionEdited?: boolean;
    projectionUpdated?: boolean;
    expenseEdited?: boolean;
    expenseUpdated?: boolean;
    expenseSyncState?: 'pending' | 'review_required' | 'synced' | 'sync_failed';
    expenseReviewPendingCount?: number;
    cashflowLease?: CashflowMutationLease;
  }) => Promise<void>;
  createProjectRequest: (payload: ProjectRequestPayload) => Promise<string | null>;
}

const _g = globalThis as any;
if (!_g.__PORTAL_CTX__) {
  _g.__PORTAL_CTX__ = createContext<(PortalState & PortalActions) | null>(null);
}
const PortalContext: React.Context<(PortalState & PortalActions) | null> = _g.__PORTAL_CTX__;

function sanitizeBudgetEntry(value: string): string {
  return String(value || '').trim();
}

function normalizeBudgetCodeBook(input: BudgetCodeEntry[]): BudgetCodeEntry[] {
  return (input || [])
    .map((row) => ({
      code: sanitizeBudgetEntry(row.code),
      subCodes: (row.subCodes || []).map(sanitizeBudgetEntry).filter(Boolean),
    }))
    .filter((row) => row.code && row.subCodes.length > 0);
}

function withTenantScope<T extends object>(orgId: string, payload: T): T & { tenantId: string } {
  return {
    ...payload,
    tenantId: orgId,
  };
}

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripUndefinedDeep(entry))
      .filter((entry) => entry !== undefined) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
        const cleaned = stripUndefinedDeep(entry);
        return cleaned === undefined ? [] : [[key, cleaned]];
      }),
    ) as T;
  }
  return value;
}

function createExpenseSheetId(): string {
  return `sheet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePortalUser(candidate: Partial<PortalUser> | null | undefined): PortalUser | null {
  if (!candidate) return null;
  const projectIds = normalizeProjectIds([
    ...(Array.isArray(candidate.projectIds) ? candidate.projectIds : []),
    candidate.projectId,
  ]);
  const projectId = resolvePrimaryProjectId(projectIds, candidate.projectId);
  if (!projectId) return null;
  return {
    id: (candidate.id || '').trim(),
    name: candidate.name || '사용자',
    email: candidate.email || '',
    role: normalizePortalRole(candidate.role),
    projectId,
    projectIds,
    projectNames: candidate.projectNames,
    registeredAt: candidate.registeredAt || new Date().toISOString(),
  };
}

function arePortalUsersEqual(left: PortalUser | null, right: PortalUser | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (
    left.id !== right.id
    || left.name !== right.name
    || left.email !== right.email
    || left.role !== right.role
    || left.projectId !== right.projectId
    || left.registeredAt !== right.registeredAt
  ) {
    return false;
  }
  if (left.projectIds.length !== right.projectIds.length) return false;
  if (left.projectIds.some((projectId, index) => projectId !== right.projectIds[index])) return false;
  return JSON.stringify(left.projectNames || {}) === JSON.stringify(right.projectNames || {});
}

type StoredPortalMember = Omit<Partial<PortalUser>, 'projectIds' | 'projectId'> & {
  projectIds?: Array<string | { id?: string; name?: string }>;
  projectId?: string | { id?: string; name?: string };
  role?: string;
  status?: string;
  createdAt?: string;
};

function getPortalMemberRefs(
  db: Firestore,
  orgId: string,
  identity: { uid: string; email?: string },
) {
  const canonicalRef = doc(db, getOrgDocumentPath(orgId, 'members', identity.uid));
  const legacyMemberId = buildLegacyMemberDocId(identity.email || '');
  const legacyRef = legacyMemberId && legacyMemberId !== identity.uid
    ? doc(db, getOrgDocumentPath(orgId, 'members', legacyMemberId))
    : null;
  return { canonicalRef, legacyRef };
}

async function loadPortalMemberRecord(
  db: Firestore,
  orgId: string,
  identity: { uid: string; email?: string },
) {
  const { canonicalRef, legacyRef } = getPortalMemberRefs(db, orgId, identity);
  const [canonicalSnap, legacySnap] = await Promise.all([
    getDoc(canonicalRef),
    legacyRef ? getDoc(legacyRef) : Promise.resolve(null),
  ]);

  return {
    canonicalRef,
    usedLegacyFallback: !canonicalSnap.exists() && Boolean(legacySnap?.exists()),
    member: mergeMemberRecordSources(
      canonicalSnap.exists() ? (canonicalSnap.data() as Record<string, unknown>) : undefined,
      legacySnap?.exists() ? (legacySnap.data() as Record<string, unknown>) : undefined,
    ) as StoredPortalMember | undefined,
  };
}

export function PortalProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading: authLoading, user: authUser } = useAuth();
  const { db, isOnline, orgId } = useFirebase();
  const devHarnessConfig = readDevAuthHarnessConfig(import.meta.env, typeof window !== 'undefined' ? window.location : undefined);
  const isDevHarnessUser = authUser?.source === 'dev_harness' && devHarnessConfig.enabled;
  const firestoreEnabled = isOnline && !!db;

  const [portalUser, setPortalUser] = useState<PortalUser | null>(null);
  const [activeProjectIdState, setActiveProjectIdState] = useState('');

  const [expenseSets, setExpenseSets] = useState<ExpenseSet[]>(EXPENSE_SETS);
  const [changeRequests, setChangeRequests] = useState<ChangeRequest[]>(CHANGE_REQUESTS);
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [participationEntries, setParticipationEntries] = useState<ParticipationEntry[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [evidenceRequiredMap, setEvidenceRequiredMap] = useState<Record<string, string>>({});
  const evidenceRequiredMapRevisionRef = useRef(0);
  const [sheetSources, setSheetSources] = useState<ProjectSheetSourceSnapshot[]>([]);
  const [expenseIntakeItems, setExpenseIntakeItems] = useState<BankImportIntakeItem[]>([]);
  const [expenseSheets, setExpenseSheets] = useState<ExpenseSheetTab[]>([]);
  const [activeExpenseSheetId, setActiveExpenseSheetIdState] = useState('default');
  const [expenseSheetRows, setExpenseSheetRows] = useState<ImportRow[] | null>(null);
  const [bankStatementRows, setBankStatementRows] = useState<BankStatementSheet | null>(null);
  const [bankStatementProjectId, setBankStatementProjectId] = useState('');
  const [budgetPlanRows, setBudgetPlanRows] = useState<BudgetPlanRow[] | null>(null);
  const [budgetCodeBook, setBudgetCodeBook] = useState<BudgetCodeEntry[]>(
    normalizeBudgetCodeBook(BUDGET_CODE_BOOK as unknown as BudgetCodeEntry[]),
  );
  const [budgetTreeV2, setBudgetTreeV2] = useState<BudgetTreeV2 | null>(null);
  const [weeklySubmissionStatuses, setWeeklySubmissionStatuses] = useState<WeeklySubmissionStatus[]>([]);
  const [projectCatalogLoading, setProjectCatalogLoading] = useState(false);
  const [isProjectCatalogReady, setIsProjectCatalogReady] = useState(false);
  const [projectScopeLoading, setProjectScopeLoading] = useState(false);
  const [isMemberLoading, setIsMemberLoading] = useState(true);
  const projectCatalogUnsubsRef = useRef<Unsubscribe[]>([]);
  const projectScopeUnsubsRef = useRef<Unsubscribe[]>([]);
  const weeklySubmissionUnsubsRef = useRef<Unsubscribe[]>([]);
  const projectsRef = useRef<Project[]>([]);
  const expenseIntakeItemsRef = useRef<BankImportIntakeItem[]>([]);
  const expenseSheetsRef = useRef<ExpenseSheetTab[]>([]);
  const activeExpenseSheetIdRef = useRef(activeExpenseSheetId);
  const expenseSheetRowsRef = useRef<ImportRow[] | null>(expenseSheetRows);
  const devHarnessHydratedProjectIdRef = useRef<string | null>(null);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    expenseIntakeItemsRef.current = expenseIntakeItems;
  }, [expenseIntakeItems]);

  useEffect(() => {
    expenseSheetsRef.current = expenseSheets;
  }, [expenseSheets]);

  useEffect(() => {
    activeExpenseSheetIdRef.current = activeExpenseSheetId;
  }, [activeExpenseSheetId]);

  useEffect(() => {
    expenseSheetRowsRef.current = expenseSheetRows;
  }, [expenseSheetRows]);

  const authUserProjectIdsKey = (authUser?.projectIds || []).join('|');
  const portalUserProjectIdsKey = (portalUser?.projectIds || []).join('|');

  const assignedProjectIds = useMemo(
    () => normalizeProjectIds([
      ...(Array.isArray(portalUser?.projectIds) ? portalUser.projectIds : []),
      portalUser?.projectId,
      ...(Array.isArray(authUser?.projectIds) ? authUser.projectIds : []),
      authUser?.projectId,
    ]),
    [authUser?.projectId, authUserProjectIdsKey, portalUser?.projectId, portalUserProjectIdsKey],
  );
  const assignedProjectIdsKey = assignedProjectIds.join('|');

  const candidateProjectsSource = useMemo(() => {
    if (!isDevHarnessUser || projects.length > 0) return projects;
    return PROJECTS;
  }, [isDevHarnessUser, projects]);

  const portalProjectCandidates = useMemo(() => resolvePortalProjectCandidates({
    role: authUser?.role || portalUser?.role,
    authUid: authUser?.uid,
    assignedProjectIds,
    projects: candidateProjectsSource,
  }), [assignedProjectIdsKey, authUser?.role, authUser?.uid, candidateProjectsSource, portalUser?.role]);

  const scopedProjectIds = useMemo(
    () => normalizeProjectIds([
      ...portalProjectCandidates.searchProjects.map((project) => project.id),
      ...assignedProjectIds,
    ]),
    [assignedProjectIdsKey, portalProjectCandidates.searchProjects],
  );
  const scopedProjectIdsKey = scopedProjectIds.join('|');

  const activeProjectId = useMemo(() => resolveActivePortalProjectId({
    activeProjectId: activeProjectIdState,
    primaryProjectId: portalUser?.projectId || authUser?.projectId || '',
    candidateProjectIds: scopedProjectIds,
  }), [activeProjectIdState, authUser?.projectId, portalUser?.projectId, scopedProjectIdsKey]);

  const myProject = useMemo(() => {
    if (!activeProjectId) return null;
    return projects.find((project) => project.id === activeProjectId) || null;
  }, [activeProjectId, projects]);
  const currentProjectId = activeProjectId;
  const currentProjectIdRef = useRef(currentProjectId);
  currentProjectIdRef.current = currentProjectId;
  const { allowRealtimeListeners: livePortalMode } = useFirestoreAccessPolicy(portalUser?.role || authUser?.role);
  const hasHydratedPortalSession = Boolean(
    isAuthenticated && authUser?.uid && portalUser?.id === authUser.uid,
  );

  useEffect(() => {
    if (!firestoreEnabled || !db || !isAuthenticated || !authUser) {
      setMembers([]);
      return;
    }
    return listenMembers(db, orgId, setMembers);
  }, [authUser?.uid, db, firestoreEnabled, isAuthenticated, orgId]);

  useEffect(() => {
    const uid = authUser?.uid;
    if (!uid || typeof sessionStorage === 'undefined') {
      setActiveProjectIdState('');
      return;
    }
    try {
      setActiveProjectIdState(sessionStorage.getItem(getActivePortalProjectStorageKey(uid)) || '');
    } catch {
      setActiveProjectIdState('');
    }
  }, [authUser?.uid]);

  useEffect(() => {
    const uid = authUser?.uid;
    if (!uid || typeof sessionStorage === 'undefined') return;
    const storageKey = getActivePortalProjectStorageKey(uid);
    try {
      if (activeProjectId) {
        sessionStorage.setItem(storageKey, activeProjectId);
      } else if (scopedProjectIds.length > 0) {
        sessionStorage.removeItem(storageKey);
      }
    } catch {
      // ignore sessionStorage failures
    }
  }, [activeProjectId, authUser?.uid, scopedProjectIdsKey]);

  useEffect(() => {
    if (!isDevHarnessUser || !activeProjectId || devHarnessHydratedProjectIdRef.current !== activeProjectId) return;
    writeDevHarnessPortalSnapshot(activeProjectId, {
      activeExpenseSheetId,
      expenseIntakeItems,
      expenseSheets: expenseSheets.map((sheet) => ({
        id: sheet.id,
        name: sheet.name,
        rows: sheet.rows,
        order: sheet.order,
        createdAt: sheet.createdAt,
        updatedAt: sheet.updatedAt,
      })),
      sheetSources,
      weeklySubmissionStatuses,
    });
  }, [activeExpenseSheetId, activeProjectId, expenseIntakeItems, expenseSheets, isDevHarnessUser, sheetSources, weeklySubmissionStatuses]);

  useEffect(() => {
    if (authLoading) {
      setIsMemberLoading(true);
      return;
    }
    if (!isAuthenticated || !authUser) {
      devHarnessHydratedProjectIdRef.current = null;
      setActiveProjectIdState('');
      setPortalUser(null);
      setIsMemberLoading(false);
      return;
    }
    if (!canEnterPortalWorkspace(authUser.role)) {
      devHarnessHydratedProjectIdRef.current = null;
      setActiveProjectIdState('');
      setPortalUser(null);
      setIsMemberLoading(false);
      return;
    }

    if (isDevHarnessUser) {
      const now = new Date().toISOString();
      const projectIds = normalizeProjectIds([
        ...(Array.isArray(authUser.projectIds) ? authUser.projectIds : []),
        authUser.projectId,
      ]);
      const normalized = normalizePortalUser({
        id: authUser.uid,
        name: authUser.name,
        email: authUser.email,
        role: authUser.role,
        projectId: resolvePrimaryProjectId(projectIds, authUser.projectId) || '',
        projectIds,
        registeredAt: authUser.registeredAt || now,
      });
      setPortalUser((previous) => (arePortalUsersEqual(previous, normalized) ? previous : normalized));
      setIsMemberLoading(false);
      return;
    }

    const loadFromStore = async () => {
      setIsMemberLoading(true);
      try {
        if (!firestoreEnabled || !db) {
          setPortalUser(null);
          return;
        }
        const { canonicalRef, member, usedLegacyFallback } = await loadPortalMemberRecord(db, orgId, authUser);
        if (!member) {
          setPortalUser(null);
          return;
        }
        const workspace = readMemberWorkspace(member);
        const access = resolveMemberProjectAccessState(member);
        const memberRole = typeof member.role === 'string' && member.role.trim()
          ? normalizePortalRole(member.role)
          : normalizePortalRole(authUser.role || 'pm');
        const nameMap: Record<string, string> = {};
        const rawIds = Array.isArray(member.projectIds) ? member.projectIds : [];
        const coercedIds = rawIds
          .map((entry) => {
            if (typeof entry === 'string') return entry;
            const id = String(entry?.id || '').trim();
            const name = String(entry?.name || '').trim();
            if (id && name) nameMap[id] = name;
            return id;
          })
          .filter(Boolean);
        for (const [projectId, name] of Object.entries(workspace.portalProfile?.projectNames || {})) {
          if (projectId && name) nameMap[projectId] = name;
        }
        const preferredId = workspace.portalProfile?.projectId || (
          typeof member.projectId === 'string'
            ? member.projectId
            : String((member.projectId as any)?.id || '')
        );
        const normalizedPreferred = preferredId || '';
        const normalized = normalizePortalUser({
          id: authUser.uid,
          name: member.name || authUser.name,
          email: member.email || authUser.email,
          role: memberRole,
          projectId: normalizedPreferred,
          projectIds: normalizeProjectIds([
            ...(workspace.portalProfile?.projectIds || []),
            ...coercedIds,
          ]),
          projectNames: Object.keys(nameMap).length ? nameMap : undefined,
          registeredAt: member.createdAt || authUser.registeredAt || new Date().toISOString(),
        });
        if (!normalized) {
          setPortalUser(null);
          return;
        }
        try {
          if (access.needsRootSync || usedLegacyFallback) {
            const now = new Date().toISOString();
            await setDoc(canonicalRef, {
              uid: authUser.uid,
              name: normalized.name,
              email: normalized.email,
              role: memberRole,
              tenantId: orgId,
              status: typeof member.status === 'string' && member.status.trim() ? member.status : 'ACTIVE',
              ...(access.projectNames ? { projectNames: access.projectNames } : {}),
              ...buildPortalProfilePatch({
                projectId: normalized.projectId,
                projectIds: normalized.projectIds,
                projectNames: normalized.projectNames,
                updatedAt: now,
                updatedByUid: authUser.uid,
                updatedByName: authUser.name || normalized.name,
              }),
              updatedAt: now,
              createdAt: member.createdAt || authUser.registeredAt || now,
              lastLoginAt: now,
            }, { merge: true });
          }
        } catch (err) {
          reportError(err, {
            message: '[PortalStore] member projectIds normalize failed:',
            options: {
              level: 'warning',
              tags: {
                surface: 'portal_store',
                action: 'member_projectids_normalize',
              },
              extra: {
                orgId,
                actorId: authUser.uid,
              },
            },
          });
        }
        setPortalUser((previous) => (arePortalUsersEqual(previous, normalized) ? previous : normalized));
      } catch (err) {
        reportError(err, {
          message: '[PortalStore] member load failed:',
          options: {
            level: 'error',
            tags: {
              surface: 'portal_store',
              action: 'member_load',
            },
            extra: {
              orgId,
              actorId: authUser.uid,
            },
          },
        });
      } finally {
        setIsMemberLoading(false);
      }
    };

    loadFromStore();
  }, [authLoading, isAuthenticated, authUser?.uid, authUser?.email, authUser?.name, authUser?.role, authUser?.registeredAt, authUser?.projectId, authUserProjectIdsKey, firestoreEnabled, db, orgId, isDevHarnessUser]);

  useEffect(() => {
    projectCatalogUnsubsRef.current.forEach((unsub) => unsub());
    projectCatalogUnsubsRef.current = [];
    let cancelled = false;
    const ifActive = (action: () => void) => {
      if (!cancelled) action();
    };
    const setProjectsIfChanged = (nextProjects: Project[]) => {
      ifActive(() => {
        if (areProjectsEqual(projectsRef.current, nextProjects)) return;
        projectsRef.current = nextProjects;
        setProjects(nextProjects);
      });
    };

    if ((authLoading || isMemberLoading) && hasHydratedPortalSession) {
      setProjectCatalogLoading(false);
      return () => {
        cancelled = true;
      };
    }

    if (authLoading || isMemberLoading || !isAuthenticated || !authUser) {
      setProjectsIfChanged([]);
      setProjectCatalogLoading(false);
      setIsProjectCatalogReady(false);
      return () => {
        cancelled = true;
      };
    }

    if (isDevHarnessUser) {
      setProjectsIfChanged(PROJECTS.filter((project) => assignedProjectIds.includes(project.id)));
      setProjectCatalogLoading(false);
      setIsProjectCatalogReady(true);
      return () => {
        cancelled = true;
      };
    }

    if (!firestoreEnabled || !db) {
      setProjectsIfChanged([]);
      setProjectCatalogLoading(false);
      setIsProjectCatalogReady(true);
      return () => {
        cancelled = true;
      };
    }

    setProjectCatalogLoading(true);
    setIsProjectCatalogReady(false);
    const handleProjectsResult = (docs: Array<{ id: string; data(): unknown }>) => {
      const map = new Map<string, Project>();
      docs.forEach((docItem) => {
        const data = docItem.data() as Project;
        const id = data.id || docItem.id;
        map.set(id, { ...data, id });
      });
      const nextProjects = Array.from(map.values()).sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || '')),
      );
      setProjectsIfChanged(nextProjects);
      ifActive(() => setProjectCatalogLoading(false));
      ifActive(() => setIsProjectCatalogReady(true));
    };
    const handleProjectsError = (err: unknown) => {
      reportError(err, {
        message: '[PortalStore] projects listen error:',
        options: {
          level: 'error',
          tags: {
            surface: 'portal_store',
            action: 'projects_listen',
          },
          extra: {
            orgId,
            actorId: authUser.uid,
          },
        },
      });
      ifActive(() => setProjectCatalogLoading(false));
      ifActive(() => setIsProjectCatalogReady(true));
    };
    const projectsQuery = query(collection(db, getOrgCollectionPath(orgId, 'projects')), limit(500));
    if (livePortalMode) {
      projectCatalogUnsubsRef.current.push(
        onSnapshot(projectsQuery, (snap) => handleProjectsResult(snap.docs), handleProjectsError),
      );
    } else {
      getDocs(projectsQuery)
        .then((snap) => handleProjectsResult(snap.docs))
        .catch(handleProjectsError);
    }

    return () => {
      cancelled = true;
      projectCatalogUnsubsRef.current.forEach((unsub) => unsub());
      projectCatalogUnsubsRef.current = [];
    };
  }, [authLoading, isMemberLoading, isAuthenticated, authUser?.uid, hasHydratedPortalSession, firestoreEnabled, db, orgId, isDevHarnessUser, assignedProjectIdsKey, livePortalMode]);

  useEffect(() => {
    setBankStatementRows(null);
    setBankStatementProjectId('');
  }, [currentProjectId]);

  useEffect(() => {
    projectScopeUnsubsRef.current.forEach((unsub) => unsub());
    projectScopeUnsubsRef.current = [];
    let cancelled = false;
    evidenceRequiredMapRevisionRef.current = 0;

    if ((authLoading || isMemberLoading) && hasHydratedPortalSession) {
      setProjectScopeLoading(false);
      return () => {
        cancelled = true;
      };
    }

    if (authLoading || isMemberLoading || !isAuthenticated || !authUser) {
      setLedgers([]);
      setExpenseSets([]);
      setChangeRequests([]);
      setParticipationEntries([]);
      setTransactions([]);
      setComments([]);
      setEvidenceRequiredMap({});
      setSheetSources([]);
      setExpenseSheets([]);
      setActiveExpenseSheetIdState('default');
      setExpenseSheetRows(null);
      setBankStatementRows(null);
      setBudgetPlanRows(null);
      setProjectScopeLoading(false);
      return () => {
        cancelled = true;
      };
    }

    if (isDevHarnessUser) {
      const projectId = currentProjectId || null;
      if (!shouldHydrateDevHarnessPortalSnapshot({
        projectId,
        hydratedProjectId: devHarnessHydratedProjectIdRef.current,
      })) {
        setProjectScopeLoading(false);
        return () => {
          cancelled = true;
        };
      }
      const scopedIds = normalizeProjectIds([
        ...(Array.isArray(portalUser?.projectIds) ? portalUser.projectIds : []),
        currentProjectId,
      ]);
      const snapshot = projectId ? readDevHarnessPortalSnapshot(projectId) : null;
      const persistedExpenseSheets = (snapshot?.expenseSheets || [])
        .map((sheet, index) => ({
          id: String(sheet?.id || (index === 0 ? 'default' : `sheet-${index + 1}`)),
          name: sanitizeExpenseSheetName(
            typeof sheet?.name === 'string' ? sheet.name : undefined,
            index === 0 ? '기본 탭' : `탭 ${index + 1}`,
          ),
          rows: normalizeExpenseSheetRows(sheet?.rows),
          order: Number.isFinite(sheet?.order) ? Number(sheet.order) : index,
          ...(sheet?.createdAt ? { createdAt: String(sheet.createdAt) } : {}),
          ...(sheet?.updatedAt ? { updatedAt: String(sheet.updatedAt) } : {}),
        }))
        .sort((a, b) => a.order - b.order);
      const persistedActiveSheetId = typeof snapshot?.activeExpenseSheetId === 'string'
        ? snapshot.activeExpenseSheetId
        : 'default';
      const resolvedActiveSheet = persistedExpenseSheets.find((sheet) => sheet.id === persistedActiveSheetId)
        || persistedExpenseSheets[0]
        || null;
      setLedgers(LEDGERS.filter((ledger) => scopedIds.includes(ledger.projectId)));
      setExpenseSets(EXPENSE_SETS);
      setChangeRequests(CHANGE_REQUESTS);
      setParticipationEntries([]);
      setTransactions(TRANSACTIONS.filter((tx) => scopedIds.includes(tx.projectId)));
      setComments([]);
      setEvidenceRequiredMap((prev) => prev || {});
      setSheetSources(Array.isArray(snapshot?.sheetSources) ? snapshot.sheetSources : []);
      setExpenseIntakeItems(
        Array.isArray(snapshot?.expenseIntakeItems)
          ? snapshot.expenseIntakeItems
            .map((item) => normalizeBankImportIntakeItem(item))
            .filter((item): item is BankImportIntakeItem => item !== null)
          : [],
      );
      setExpenseSheets(persistedExpenseSheets);
      setActiveExpenseSheetIdState(resolvedActiveSheet?.id || 'default');
      setExpenseSheetRows(resolvedActiveSheet?.rows || null);
      setWeeklySubmissionStatuses(Array.isArray(snapshot?.weeklySubmissionStatuses) ? snapshot.weeklySubmissionStatuses : []);
      devHarnessHydratedProjectIdRef.current = projectId;
      setProjectScopeLoading(false);
      return () => {
        cancelled = true;
      };
    }

    if (!firestoreEnabled || !db) {
      setLedgers([]);
      setExpenseSets([]);
      setChangeRequests([]);
      setParticipationEntries([]);
      setTransactions([]);
      setComments([]);
      setExpenseSheets([]);
      setActiveExpenseSheetIdState('default');
      setEvidenceRequiredMap({});
      setSheetSources([]);
      setExpenseIntakeItems([]);
      setExpenseSheetRows(null);
      setBankStatementRows(null);
      setBudgetPlanRows(null);
      setProjectScopeLoading(false);
      return () => {
        cancelled = true;
      };
    }

    if (!currentProjectId) {
      setLedgers([]);
      setExpenseSets(EXPENSE_SETS);
      setChangeRequests(CHANGE_REQUESTS);
      setParticipationEntries([]);
      setTransactions([]);
      setComments([]);
      setEvidenceRequiredMap({});
      setSheetSources([]);
      setExpenseIntakeItems([]);
      setExpenseSheets([]);
      setActiveExpenseSheetIdState('default');
      setExpenseSheetRows(null);
      setBankStatementRows(null);
      setBudgetPlanRows(null);
      setProjectScopeLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setProjectScopeLoading(true);
    let ledgerReady = false;
    let expenseReady = false;
    let changeReady = false;
    let partReady = false;
    let txReady = false;
    const markReady = () => {
      if (ledgerReady && expenseReady && changeReady && partReady && txReady) setProjectScopeLoading(false);
    };
    const ifActive = (action: () => void) => {
      if (!cancelled) action();
    };
    const ledgerQuery = query(
      collection(db, getOrgCollectionPath(orgId, 'ledgers')),
      where('projectId', '==', currentProjectId),
    );
    const expenseQuery = query(
      collection(db, getOrgCollectionPath(orgId, 'expenseSets')),
      where('projectId', '==', currentProjectId),
    );
    const changeRequestQuery = query(
      collection(db, getOrgCollectionPath(orgId, 'changeRequests')),
      where('projectId', '==', currentProjectId),
    );
    const participationQuery = query(
      collection(db, getOrgCollectionPath(orgId, 'partEntries')),
      where('projectId', '==', currentProjectId),
    );
    const handleLedgerResult = (docs: Array<{ data(): unknown }>) => {
      ifActive(() => {
        const list = docs
          .map((docItem) => docItem.data() as Ledger)
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        setLedgers(list);
        ledgerReady = true;
        markReady();
      });
    };
    const handleLedgerError = (err: unknown) => {
      console.error('[PortalStore] ledgers listen error:', err);
      if (!isPermissionDenied(err)) {
        toast.error('원장 데이터를 불러오지 못했습니다');
      }
      ifActive(() => {
        setLedgers(LEDGERS.filter((ledger) => ledger.projectId === currentProjectId));
        ledgerReady = true;
        markReady();
      });
    };
    const handleExpenseResult = (docs: Array<{ data(): unknown }>) => {
      ifActive(() => {
        const list = docs
          .map((docItem) => docItem.data() as ExpenseSet)
          .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        setExpenseSets(list);
        expenseReady = true;
        markReady();
      });
    };
    const handleExpenseError = (err: unknown) => {
      console.error('[PortalStore] expenseSets listen error:', err);
      toast.error('사업비 데이터를 불러오지 못했습니다');
      ifActive(() => {
        expenseReady = true;
        markReady();
      });
    };
    const handleChangeRequestResult = (docs: Array<{ data(): unknown }>) => {
      ifActive(() => {
        const list = docs
          .map((docItem) => docItem.data() as ChangeRequest)
          .sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')));
        setChangeRequests(list);
        changeReady = true;
        markReady();
      });
    };
    const handleChangeRequestError = (err: unknown) => {
      console.error('[PortalStore] changeRequests listen error:', err);
      toast.error('인력변경 데이터를 불러오지 못했습니다');
      ifActive(() => {
        changeReady = true;
        markReady();
      });
    };
    const handleParticipationResult = (docs: Array<{ data(): unknown }>) => {
      ifActive(() => {
        const list = docs
          .map((docItem) => docItem.data() as ParticipationEntry)
          .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        setParticipationEntries(list);
        partReady = true;
        markReady();
      });
    };
    const handleParticipationError = (err: unknown) => {
      console.error('[PortalStore] participation entries listen error:', err);
      if (!isPermissionDenied(err)) {
        toast.error('인력 데이터를 불러오지 못했습니다. 기본 데이터를 표시합니다.');
      }
      ifActive(() => {
        setParticipationEntries([]);
        partReady = true;
        markReady();
      });
    };
    const txQuery = query(
      collection(db, getOrgCollectionPath(orgId, 'transactions')),
      where('projectId', '==', currentProjectId),
    );
    const commentQuery = query(
      collection(db, getOrgCollectionPath(orgId, 'comments')),
      where('projectId', '==', currentProjectId),
    );
    const evidenceMapRef = doc(db, getOrgDocumentPath(orgId, 'budgetEvidenceMaps', currentProjectId));
    const sheetSourceCollection = collection(
      db,
      `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/sheet_sources`,
    );
    const expenseSheetCollection = collection(
      db,
      `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/expense_sheets`,
    );
    const bankStatementRef = doc(
      db,
      `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/bank_statements/default`,
    );
    const budgetPlanRef = doc(
      db,
      `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/budget_summary/default`,
    );
    const budgetCodeBookRef = doc(
      db,
      `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/budget_code_book/default`,
    );
    const budgetTreeV2Ref = doc(
      db,
      `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/budget_tree_v2/default`,
    );
    const handleTransactionResult = (docs: Array<{ data(): unknown }>) => {
      ifActive(() => {
        const list = docs
          .map((docItem) => docItem.data() as Transaction)
          .sort((a, b) => String(b.dateTime || '').localeCompare(String(a.dateTime || '')));
        setTransactions(list);
        txReady = true;
        markReady();
      });
    };
    const handleTransactionError = (err: unknown) => {
      console.error('[PortalStore] transactions listen error:', err);
      if (!isPermissionDenied(err)) {
        toast.error('거래 데이터를 불러오지 못했습니다');
      }
      ifActive(() => {
        setTransactions(TRANSACTIONS.filter((transaction) => transaction.projectId === currentProjectId));
        txReady = true;
        markReady();
      });
    };
    const handleCommentResult = (docs: Array<{ data(): unknown }>) => {
      ifActive(() => {
        const list = docs
          .map((docItem) => docItem.data() as Comment)
          .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
        setComments(list);
      });
    };
    const handleCommentError = (err: unknown) => {
      console.error('[PortalStore] comments listen error:', err);
      ifActive(() => setComments([]));
    };
    const handleEvidenceMapResult = (snap: { exists(): boolean; data(): unknown }) => {
      ifActive(() => {
        if (!snap.exists()) {
          setEvidenceRequiredMap({});
          evidenceRequiredMapRevisionRef.current = 0;
          return;
        }
        const data = snap.data() as { map?: Record<string, string>; evidenceMapRevision?: number };
        setEvidenceRequiredMap(data?.map || {});
        evidenceRequiredMapRevisionRef.current = Number.isInteger(data?.evidenceMapRevision)
          ? Number(data.evidenceMapRevision)
          : 0;
      });
    };
    const handleEvidenceMapError = (err: unknown) => {
      console.error('[PortalStore] evidence map listen error:', err);
      ifActive(() => setEvidenceRequiredMap({}));
    };
    const handleSheetSourceResult = (docs: Array<{ id: string; data(): unknown }>) => {
      ifActive(() => {
        const list = docs
          .map((docItem) => {
            const data = docItem.data() as Partial<ProjectSheetSourceSnapshot> & {
              previewMatrixRows?: Array<{ cells?: unknown }>;
            };
            const previewMatrix = Array.isArray(data.previewMatrix)
              ? data.previewMatrix.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : []))
              : Array.isArray(data.previewMatrixRows)
                ? data.previewMatrixRows.map((row) => {
                    const cells = row && typeof row === 'object' ? row.cells : undefined;
                    return Array.isArray(cells) ? cells.map((cell) => String(cell ?? '')) : [];
                  })
                : [];
            return {
              sourceType: (data.sourceType || docItem.id) as ProjectSheetSourceType,
              projectId: String(data.projectId || currentProjectId || ''),
              sheetName: String(data.sheetName || ''),
              fileName: String(data.fileName || ''),
              storagePath: String(data.storagePath || ''),
              downloadURL: String(data.downloadURL || ''),
              contentType: String(data.contentType || ''),
              uploadedAt: String(data.uploadedAt || ''),
              rowCount: Number.isFinite(Number(data.rowCount)) ? Number(data.rowCount) : 0,
              columnCount: Number.isFinite(Number(data.columnCount)) ? Number(data.columnCount) : 0,
              matchedColumns: Array.isArray(data.matchedColumns) ? data.matchedColumns.map((value) => String(value || '')) : [],
              unmatchedColumns: Array.isArray(data.unmatchedColumns) ? data.unmatchedColumns.map((value) => String(value || '')) : [],
              previewMatrix,
              ...(data.applyTarget ? { applyTarget: String(data.applyTarget) } : {}),
              ...(data.lastAppliedAt ? { lastAppliedAt: String(data.lastAppliedAt) } : {}),
              ...(data.updatedAt ? { updatedAt: String(data.updatedAt) } : {}),
              ...(data.updatedBy ? { updatedBy: String(data.updatedBy) } : {}),
            } satisfies ProjectSheetSourceSnapshot;
          })
          .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
        setSheetSources(list);
      });
    };
    const handleSheetSourceError = (err: unknown) => {
      reportError(err, {
        message: '[PortalStore] sheet source listen error:',
        options: {
          level: 'error',
          tags: {
            surface: 'portal_store',
            action: 'sheet_source_listen',
          },
          extra: {
            orgId,
            actorId: authUser.uid,
            projectId: currentProjectId,
          },
        },
      });
      ifActive(() => setSheetSources([]));
    };
    const handleExpenseIntakeResult = (docs: Array<{ id: string; data(): unknown }>) => {
      ifActive(() => {
        const nextItems = docs
          .map((docItem) => normalizeBankImportIntakeItem({ id: docItem.id, ...(docItem.data() as Record<string, unknown>) }))
          .filter((item): item is BankImportIntakeItem => item !== null)
          .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
        setExpenseIntakeItems(nextItems);
      });
    };
    const handleExpenseIntakeError = (err: unknown) => {
      reportError(err, {
        message: '[PortalStore] expense intake listen error:',
        options: {
          level: 'error',
          tags: {
            surface: 'portal_store',
            action: 'expense_intake_listen',
          },
          extra: {
            orgId,
            actorId: authUser.uid,
            projectId: currentProjectId,
          },
        },
      });
      ifActive(() => setExpenseIntakeItems([]));
    };
    const handleExpenseSheetResult = (docs: Array<{ id: string; data(): unknown }>) => {
      ifActive(() => {
        const nextDocs = docs
          .map<ExpenseSheetTab | null>((docItem) => {
            const data = docItem.data() as {
              name?: string;
              rows?: ImportRow[];
              order?: number;
              createdAt?: string;
              updatedAt?: string;
              deletedAt?: string;
            };
            if (data?.deletedAt) return null;
            return {
              id: docItem.id,
              name: sanitizeExpenseSheetName(data?.name, docItem.id === 'default' ? '기본 탭' : '새 탭'),
              rows: normalizeExpenseSheetRows(data?.rows),
              order: Number.isFinite(Number(data?.order)) ? Number(data?.order) : (docItem.id === 'default' ? 0 : 999),
              createdAt: data?.createdAt,
              updatedAt: data?.updatedAt,
            };
          })
          .filter((sheet): sheet is ExpenseSheetTab => sheet !== null)
          .sort((a, b) => {
            if (a.order !== b.order) return a.order - b.order;
            return String(a.createdAt || a.updatedAt || '').localeCompare(String(b.createdAt || b.updatedAt || ''));
          });
        const nextState = reconcileExpenseSheetTabsFromSnapshot({
          currentSheets: expenseSheetsRef.current,
          nextSheets: nextDocs,
          activeExpenseSheetId: activeExpenseSheetIdRef.current,
        });
        if (nextState.sheetsChanged) {
          expenseSheetsRef.current = nextState.expenseSheets;
          setExpenseSheets(nextState.expenseSheets);
        }
        if (nextState.activeChanged) {
          activeExpenseSheetIdRef.current = nextState.activeExpenseSheetId;
          setActiveExpenseSheetIdState(nextState.activeExpenseSheetId);
        }
      });
    };
    const handleExpenseSheetError = (err: unknown) => {
      reportError(err, {
        message: '[PortalStore] expense sheet listen error:',
        options: {
          level: 'error',
          tags: {
            surface: 'portal_store',
            action: 'expense_sheet_listen',
          },
          extra: {
            orgId,
            actorId: authUser.uid,
            projectId: currentProjectId,
          },
        },
      });
      ifActive(() => {
        setExpenseSheets([]);
        setExpenseSheetRows(null);
      });
    };
    const handleBankStatementResult = (snap: { exists(): boolean; data(): unknown }) => {
      ifActive(() => {
        if (!snap.exists()) {
          setBankStatementRows(null);
          return;
        }
        const data = snap.data() as { rows?: BankStatementRow[]; columns?: string[] };
        const rawRows = Array.isArray(data?.rows) ? data.rows : [];
        if (rawRows.length === 0) {
          setBankStatementRows(null);
          return;
        }
        const fallbackColumnCount = Math.max(...rawRows.map((row) => (Array.isArray(row?.cells) ? row.cells.length : 0)), 0);
        const fallbackColumns = fallbackColumnCount > 0
          ? Array.from({ length: fallbackColumnCount }, (_, index) => BANK_STATEMENT_COLUMNS[index] || `컬럼${index + 1}`)
          : [];
        const columns = Array.isArray(data?.columns) && data.columns.length > 0
          ? data.columns.map((column, index) => normalizeSpace(String(column || `컬럼${index + 1}`)))
          : fallbackColumns;
        const rows = rawRows.map((row, rowIdx) => ({
          tempId: row?.tempId || `bank-${Date.now()}-${rowIdx}`,
          cells: Array.isArray(row?.cells)
            ? columns.map((_, index) => normalizeSpace(String(row.cells[index] ?? '')))
            : columns.map(() => ''),
          status: row?.status === 'applied' ? 'applied' as const : 'staged' as const,
        }));
        setBankStatementRows({ columns, rows });
        setBankStatementProjectId(currentProjectId);
      });
    };
    const handleBankStatementError = (err: unknown) => {
      reportError(err, {
        message: '[PortalStore] bank statement listen error:',
        options: {
          level: 'error',
          tags: {
            surface: 'portal_store',
            action: 'bank_statement_listen',
          },
          extra: {
            orgId,
            actorId: authUser.uid,
            projectId: currentProjectId,
          },
        },
      });
      ifActive(() => setBankStatementRows(null));
      ifActive(() => setBankStatementProjectId(''));
    };
    const handleBudgetPlanResult = (snap: { exists(): boolean; data(): unknown }) => {
      ifActive(() => {
        if (!snap.exists()) {
          setBudgetPlanRows(null);
          return;
        }
        const data = snap.data() as { rows?: BudgetPlanRow[] };
        setBudgetPlanRows(Array.isArray(data?.rows) ? data.rows : null);
      });
    };
    const handleBudgetPlanError = (err: unknown) => {
      console.error('[PortalStore] budget plan listen error:', err);
      ifActive(() => setBudgetPlanRows(null));
    };
    const handleBudgetCodeBookResult = (snap: { exists(): boolean; data(): unknown }) => {
      ifActive(() => {
        if (!snap.exists()) {
          setBudgetCodeBook(BUDGET_CODE_BOOK);
          return;
        }
        const data = snap.data() as { codes?: BudgetCodeEntry[] };
        const source = Array.isArray(data?.codes)
          ? data.codes
          : (BUDGET_CODE_BOOK as unknown as BudgetCodeEntry[]);
        const normalized = normalizeBudgetCodeBook(source);
        setBudgetCodeBook(normalized.length > 0 ? normalized : normalizeBudgetCodeBook(BUDGET_CODE_BOOK as unknown as BudgetCodeEntry[]));
      });
    };
    const handleBudgetCodeBookError = (err: unknown) => {
      console.error('[PortalStore] budget code book listen error:', err);
      ifActive(() => setBudgetCodeBook(normalizeBudgetCodeBook(BUDGET_CODE_BOOK as unknown as BudgetCodeEntry[])));
    };
    const handleBudgetTreeV2Result = (snap: { exists(): boolean; data(): unknown }) => {
      ifActive(() => {
        if (!snap.exists()) {
          setBudgetTreeV2(null);
          return;
        }
        const data = snap.data() as Partial<BudgetTreeV2> & { codes?: BudgetTreeCode[] };
        setBudgetTreeV2({
          version: 2,
          projectId: String(data.projectId || currentProjectId || ''),
          codes: normalizeBudgetTreeCodes(data.codes),
          ...(data.updatedAt ? { updatedAt: String(data.updatedAt) } : {}),
          ...(data.updatedBy ? { updatedBy: String(data.updatedBy) } : {}),
        });
      });
    };
    const handleBudgetTreeV2Error = (err: unknown) => {
      console.error('[PortalStore] budget tree v2 listen error:', err);
      ifActive(() => setBudgetTreeV2(null));
    };

    if (livePortalMode) {
      projectScopeUnsubsRef.current.push(onSnapshot(ledgerQuery, (snap) => handleLedgerResult(snap.docs), handleLedgerError));
      projectScopeUnsubsRef.current.push(onSnapshot(expenseQuery, (snap) => handleExpenseResult(snap.docs), handleExpenseError));
      projectScopeUnsubsRef.current.push(onSnapshot(changeRequestQuery, (snap) => handleChangeRequestResult(snap.docs), handleChangeRequestError));
      projectScopeUnsubsRef.current.push(onSnapshot(participationQuery, (snap) => handleParticipationResult(snap.docs), handleParticipationError));
      projectScopeUnsubsRef.current.push(onSnapshot(txQuery, (snap) => handleTransactionResult(snap.docs), handleTransactionError));
      projectScopeUnsubsRef.current.push(onSnapshot(commentQuery, (snap) => handleCommentResult(snap.docs), handleCommentError));
      projectScopeUnsubsRef.current.push(onSnapshot(evidenceMapRef, handleEvidenceMapResult, handleEvidenceMapError));
      projectScopeUnsubsRef.current.push(onSnapshot(sheetSourceCollection, (snap) => handleSheetSourceResult(snap.docs), handleSheetSourceError));
      projectScopeUnsubsRef.current.push(
        onSnapshot(
          collection(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/expense_intake`),
          (snap) => handleExpenseIntakeResult(snap.docs),
          handleExpenseIntakeError,
        ),
      );
      projectScopeUnsubsRef.current.push(onSnapshot(expenseSheetCollection, (snap) => handleExpenseSheetResult(snap.docs), handleExpenseSheetError));
      projectScopeUnsubsRef.current.push(onSnapshot(bankStatementRef, handleBankStatementResult, handleBankStatementError));
      projectScopeUnsubsRef.current.push(onSnapshot(budgetPlanRef, handleBudgetPlanResult, handleBudgetPlanError));
      projectScopeUnsubsRef.current.push(onSnapshot(budgetCodeBookRef, handleBudgetCodeBookResult, handleBudgetCodeBookError));
      projectScopeUnsubsRef.current.push(onSnapshot(budgetTreeV2Ref, handleBudgetTreeV2Result, handleBudgetTreeV2Error));
    } else {
      getDocs(ledgerQuery).then((snap) => handleLedgerResult(snap.docs)).catch(handleLedgerError);
      getDocs(expenseQuery).then((snap) => handleExpenseResult(snap.docs)).catch(handleExpenseError);
      getDocs(changeRequestQuery).then((snap) => handleChangeRequestResult(snap.docs)).catch(handleChangeRequestError);
      getDocs(participationQuery).then((snap) => handleParticipationResult(snap.docs)).catch(handleParticipationError);
      getDocs(txQuery).then((snap) => handleTransactionResult(snap.docs)).catch(handleTransactionError);
      getDocs(commentQuery).then((snap) => handleCommentResult(snap.docs)).catch(handleCommentError);
      getDoc(evidenceMapRef).then(handleEvidenceMapResult).catch(handleEvidenceMapError);
      getDocs(sheetSourceCollection).then((snap) => handleSheetSourceResult(snap.docs)).catch(handleSheetSourceError);
      getDocs(collection(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/expense_intake`))
        .then((snap) => handleExpenseIntakeResult(snap.docs))
        .catch(handleExpenseIntakeError);
      getDocs(expenseSheetCollection).then((snap) => handleExpenseSheetResult(snap.docs)).catch(handleExpenseSheetError);
      getDoc(bankStatementRef).then(handleBankStatementResult).catch(handleBankStatementError);
      getDoc(budgetPlanRef).then(handleBudgetPlanResult).catch(handleBudgetPlanError);
      getDoc(budgetCodeBookRef).then(handleBudgetCodeBookResult).catch(handleBudgetCodeBookError);
      getDoc(budgetTreeV2Ref).then(handleBudgetTreeV2Result).catch(handleBudgetTreeV2Error);
    }

    return () => {
      cancelled = true;
      projectScopeUnsubsRef.current.forEach((unsub) => unsub());
      projectScopeUnsubsRef.current = [];
    };
  }, [authLoading, isMemberLoading, isAuthenticated, authUser?.uid, hasHydratedPortalSession, currentProjectId, firestoreEnabled, db, orgId, scopedProjectIdsKey, isDevHarnessUser, portalUserProjectIdsKey, livePortalMode]);

  useEffect(() => {
    weeklySubmissionUnsubsRef.current.forEach((unsub) => unsub());
    weeklySubmissionUnsubsRef.current = [];
    let cancelled = false;
    const ifActive = (action: () => void) => {
      if (!cancelled) action();
    };

    const handleWeeklySubmissionResult = (docs: Array<{ id: string; data(): unknown }>) => {
      ifActive(() => {
        const list = docs.map((docItem) => {
          const data = docItem.data() as WeeklySubmissionStatus;
          return { ...data, id: data.id || docItem.id };
        });
        list.sort((a, b) => {
          if (a.projectId !== b.projectId) return String(a.projectId).localeCompare(String(b.projectId));
          if (a.yearMonth !== b.yearMonth) return String(b.yearMonth || '').localeCompare(String(a.yearMonth || ''));
          return (a.weekNo || 0) - (b.weekNo || 0);
        });
        setWeeklySubmissionStatuses(list);
      });
    };
    const handleWeeklySubmissionError = (err: unknown) => {
      console.error('[PortalStore] weekly submission listen error:', err);
      ifActive(() => setWeeklySubmissionStatuses([]));
    };

    if ((authLoading || isMemberLoading) && hasHydratedPortalSession) {
      return () => {
        cancelled = true;
      };
    }

    if (authLoading || isMemberLoading || !isAuthenticated || !authUser || isDevHarnessUser) {
      if (!isDevHarnessUser) {
        setWeeklySubmissionStatuses([]);
      }
      return () => {
        cancelled = true;
      };
    }

    if (!firestoreEnabled || !db || scopedProjectIds.length === 0) {
      setWeeklySubmissionStatuses([]);
      return () => {
        cancelled = true;
      };
    }

    const weeklySubmissionBase = collection(db, getOrgCollectionPath(orgId, 'weeklySubmissionStatus'));
    const weekQuery = scopedProjectIds.length === 1
      ? query(weeklySubmissionBase, where('projectId', '==', scopedProjectIds[0]))
      : query(weeklySubmissionBase, where('projectId', 'in', scopedProjectIds.slice(0, 10)));

    if (livePortalMode) {
      weeklySubmissionUnsubsRef.current.push(onSnapshot(weekQuery, (snap) => handleWeeklySubmissionResult(snap.docs), handleWeeklySubmissionError));
    } else {
      getDocs(weekQuery).then((snap) => handleWeeklySubmissionResult(snap.docs)).catch(handleWeeklySubmissionError);
    }

    return () => {
      cancelled = true;
      weeklySubmissionUnsubsRef.current.forEach((unsub) => unsub());
      weeklySubmissionUnsubsRef.current = [];
    };
  }, [authLoading, isMemberLoading, isAuthenticated, authUser?.uid, hasHydratedPortalSession, firestoreEnabled, db, orgId, isDevHarnessUser, scopedProjectIdsKey, livePortalMode]);

  useEffect(() => {
    if (authLoading || isMemberLoading || !isAuthenticated || !authUser) return;
    const selection = reconcileExpenseSheetRowsFromSelection({
      expenseSheets,
      activeExpenseSheetId,
      currentRows: expenseSheetRows,
    });
    if (selection.rowsChanged) {
      setExpenseSheetRows(selection.expenseSheetRows);
    }
  }, [authLoading, isMemberLoading, isAuthenticated, authUser?.uid, expenseSheets, activeExpenseSheetId, expenseSheetRows]);

  const persistExpenseSet = useCallback(async (set: ExpenseSet) => {
    if (!db) return;
    await setDoc(
      doc(db, getOrgDocumentPath(orgId, 'expenseSets', set.id)),
      withTenantScope(orgId, set),
      { merge: true },
    );
  }, [db, orgId]);

  const persistChangeRequest = useCallback(async (request: ChangeRequest) => {
    if (!db) return;
    await setDoc(
      doc(db, getOrgDocumentPath(orgId, 'changeRequests', request.id)),
      withTenantScope(orgId, request),
      { merge: true },
    );
  }, [db, orgId]);

  const setActiveExpenseSheet = useCallback((sheetId: string) => {
    const nextId = String(sheetId || '').trim();
    if (!nextId) return;
    if (activeExpenseSheetIdRef.current !== nextId) {
      setActiveExpenseSheetIdState(nextId);
    }
    activeExpenseSheetIdRef.current = nextId;
    const activeSheet = expenseSheetsRef.current.find((sheet) => sheet.id === nextId) || null;
    const nextRows = activeSheet?.rows || null;
    if (!areExpenseSheetRowsEqual(expenseSheetRowsRef.current, nextRows)) {
      setExpenseSheetRows(nextRows);
    }
  }, []);

  const createExpenseSheet = useCallback(async (name?: string): Promise<string | null> => {
    if (isDevHarnessUser) {
      const now = new Date().toISOString();
      const id = createExpenseSheetId();
      const nextOrder = expenseSheets.length > 0
        ? Math.max(...expenseSheets.map((sheet) => (Number.isFinite(sheet.order) ? sheet.order : 0))) + 1
        : 1;
      const nextSheet = {
        id,
        name: sanitizeExpenseSheetName(name, `탭 ${expenseSheets.length + 1}`),
        order: nextOrder,
        rows: [] as ImportRow[],
        createdAt: now,
        updatedAt: now,
      };
      setExpenseSheets((prev) => [...prev, nextSheet]);
      setActiveExpenseSheetIdState(id);
      setExpenseSheetRows([]);
      return id;
    }
    if (!db || !currentProjectId) {
      toast.error('Firestore 연결이 필요합니다. 관리자에게 문의해 주세요.');
      return null;
    }
    const now = new Date().toISOString();
    const id = createExpenseSheetId();
    const nextOrder = expenseSheets.length > 0
      ? Math.max(...expenseSheets.map((sheet) => (Number.isFinite(sheet.order) ? sheet.order : 0))) + 1
      : 1;
    await setDoc(
      doc(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/expense_sheets/${id}`),
      withTenantScope(orgId, {
        id,
        projectId: currentProjectId,
        name: sanitizeExpenseSheetName(name, `탭 ${expenseSheets.length + 1}`),
        order: nextOrder,
        rows: [] as ImportRow[],
        createdAt: now,
        updatedAt: now,
        updatedBy: portalUser?.name || authUser?.name || '',
      }),
      { merge: true },
    );
    setActiveExpenseSheetIdState(id);
    return id;
  }, [currentProjectId, db, orgId, portalUser?.name, authUser?.name, expenseSheets, isDevHarnessUser]);

  const renameExpenseSheet = useCallback(async (sheetId: string, name: string): Promise<boolean> => {
    if (isDevHarnessUser) {
      const id = String(sheetId || '').trim();
      const nextName = sanitizeExpenseSheetName(name, '');
      if (!id || !nextName) return false;
      setExpenseSheets((prev) => prev.map((sheet) => (
        sheet.id === id
          ? { ...sheet, name: nextName, updatedAt: new Date().toISOString() }
          : sheet
      )));
      return true;
    }
    if (!db || !currentProjectId) {
      toast.error('Firestore 연결이 필요합니다. 관리자에게 문의해 주세요.');
      return false;
    }
    const id = String(sheetId || '').trim();
    const nextName = sanitizeExpenseSheetName(name, '');
    if (!id || !nextName) return false;
    await setDoc(
      doc(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/expense_sheets/${id}`),
      withTenantScope(orgId, {
        id,
        projectId: currentProjectId,
        name: nextName,
        updatedAt: new Date().toISOString(),
        updatedBy: portalUser?.name || authUser?.name || '',
      }),
      { merge: true },
    );
    return true;
  }, [currentProjectId, db, orgId, portalUser?.name, authUser?.name, isDevHarnessUser]);

  const deleteExpenseSheet = useCallback(async (sheetId: string): Promise<boolean> => {
    if (isDevHarnessUser) {
      const id = String(sheetId || '').trim();
      if (!id) return false;
      if (expenseSheets.length <= 1) {
        toast.message('최소 1개의 탭은 유지되어야 합니다.');
        return false;
      }
      const nextSheets = expenseSheets.filter((sheet) => sheet.id !== id);
      setExpenseSheets(nextSheets);
      if (activeExpenseSheetId === id) {
        const fallback = nextSheets[0]?.id || 'default';
        setActiveExpenseSheetIdState(fallback);
        setExpenseSheetRows(nextSheets.find((sheet) => sheet.id === fallback)?.rows || []);
      }
      return true;
    }
    if (!db || !currentProjectId) {
      toast.error('Firestore 연결이 필요합니다. 관리자에게 문의해 주세요.');
      return false;
    }
    const id = String(sheetId || '').trim();
    if (!id) return false;
    if (expenseSheets.length <= 1) {
      toast.message('최소 1개의 탭은 유지되어야 합니다.');
      return false;
    }
    await setDoc(
      doc(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/expense_sheets/${id}`),
      withTenantScope(orgId, {
        id,
        projectId: currentProjectId,
        deletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      { merge: true },
    );
    if (activeExpenseSheetId === id) {
      const fallback = expenseSheets.find((sheet) => sheet.id !== id)?.id || 'default';
      setActiveExpenseSheetIdState(fallback);
    }
    return true;
  }, [currentProjectId, db, orgId, expenseSheets, activeExpenseSheetId, isDevHarnessUser]);

  const saveEvidenceRequiredMap = useCallback(async (
    map: Record<string, string>,
    options: { cashflowLease?: CashflowMutationLease } = {},
  ) => {
    if (isDevHarnessUser) {
      setEvidenceRequiredMap(map);
      return;
    }
    if (!currentProjectId || !authUser || !isPlatformApiEnabled()) {
      throw new Error('증빙 필수항목 API가 연결되어 있지 않아 읽기 전용으로 유지됩니다.');
    }
    if (!options.cashflowLease) throw new Error('수정 세션을 먼저 시작해 주세요.');
    const result = await applyEvidenceRequiredMapIntentViaBff({
      tenantId: orgId,
      actor: {
        uid: authUser.uid,
        email: authUser.email,
        role: authUser.role,
        idToken: authUser.idToken,
        googleAccessToken: authUser.googleAccessToken,
      },
      projectId: currentProjectId,
      lease: options.cashflowLease,
      idempotencyKey: `cashflow-evidence-required-map:${currentProjectId}:${Date.now()}`,
      intent: { expectedRevision: evidenceRequiredMapRevisionRef.current, map },
    });
    evidenceRequiredMapRevisionRef.current = result.evidenceRequiredMap.evidenceMapRevision;
    setEvidenceRequiredMap(result.evidenceRequiredMap.map);
  }, [authUser, currentProjectId, isDevHarnessUser, orgId]);

  const markSheetSourceApplied = useCallback(async (input: {
    sourceType: ProjectSheetSourceType;
    applyTarget: string;
  }) => {
    const sourceType = String(input.sourceType || '').trim() as ProjectSheetSourceType;
    const applyTarget = normalizeSpace(String(input.applyTarget || ''));
    if (!sourceType || !applyTarget) return;
    const now = new Date().toISOString();
    if (isDevHarnessUser || !db || !currentProjectId) {
      setSheetSources((prev) => prev.map((item) => (
        item.sourceType === sourceType
          ? {
            ...item,
            applyTarget,
            lastAppliedAt: now,
            updatedAt: now,
            updatedBy: portalUser?.name || authUser?.name || '',
          }
          : item
      )));
      return;
    }
    await setDoc(
      doc(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/sheet_sources/${sourceType}`),
      withTenantScope(orgId, {
        projectId: currentProjectId,
        sourceType,
        applyTarget,
        lastAppliedAt: now,
        updatedAt: now,
        updatedBy: portalUser?.name || authUser?.name || '',
      }),
      { merge: true },
    );
  }, [authUser?.name, currentProjectId, db, isDevHarnessUser, orgId, portalUser?.name]);

  const saveExpenseSheetRows = useCallback(async (rows: ImportRow[], options?: CashflowMutationOptions) => {
    const now = new Date().toISOString();
    const activeSheet = expenseSheets.find((sheet) => sheet.id === activeExpenseSheetId) || null;
    const activeSheetId = activeSheet?.id || activeExpenseSheetId || 'default';
    const activeSheetName = sanitizeExpenseSheetName(activeSheet?.name, activeSheetId === 'default' ? '기본 탭' : '새 탭');
    const defaultLedgerId = ledgers.find((ledger) => ledger.projectId === currentProjectId)?.id
      || (currentProjectId ? `l-${currentProjectId}` : 'l-default');
    const preparedOptions = {
      projectId: currentProjectId || '',
      defaultLedgerId,
      evidenceRequiredMap,
      policy: normalizeSettlementSheetPolicy(myProject?.settlementSheetPolicy, myProject?.fundInputMode),
      basis: myProject?.basis,
    } as const;
    const preparedRows = prepareExpenseSheetRowsForSave({
      rows,
      ...preparedOptions,
    });
    const sanitizedRows = preparedRows.map((row) => ({
      ...row,
      cells: Array.isArray(row.cells) ? row.cells.map((c) => (c ?? '')) : [],
      ...(row.reviewHints && row.reviewHints.length > 0 ? { reviewHints: [...row.reviewHints] } : {}),
      ...(row.reviewRequiredCellIndexes && row.reviewRequiredCellIndexes.length > 0
        ? { reviewRequiredCellIndexes: [...row.reviewRequiredCellIndexes] }
        : {}),
      ...(row.reviewStatus ? { reviewStatus: row.reviewStatus } : {}),
      ...(row.reviewFingerprint ? { reviewFingerprint: row.reviewFingerprint } : {}),
      ...(row.reviewConfirmedAt ? { reviewConfirmedAt: row.reviewConfirmedAt } : {}),
      ...(row.userEditedCells && row.userEditedCells.size > 0
        ? { userEditedCells: new Set(row.userEditedCells) }
        : {}),
    }));
    if (isDevHarnessUser) {
      setExpenseSheetRows(sanitizedRows as ImportRow[]);
      setExpenseSheets((prev) => upsertExpenseSheetTabRows({
        sheets: prev,
        sheetId: activeSheetId,
        sheetName: activeSheetName,
        order: activeSheet?.order || (activeSheetId === 'default' ? 0 : prev.length + 1),
        rows: sanitizedRows as ImportRow[],
        now,
        createdAt: activeSheet?.createdAt,
      }));
      writeDevHarnessPortalSnapshot(currentProjectId || '', {
        activeExpenseSheetId: activeSheetId,
        expenseSheets: upsertExpenseSheetTabRows({
          sheets: expenseSheets.map((sheet) => ({
            id: sheet.id,
            name: sheet.name,
            rows: sheet.rows || [],
            order: sheet.order,
            createdAt: sheet.createdAt,
            updatedAt: sheet.updatedAt,
          })),
          sheetId: activeSheetId,
          sheetName: activeSheetName,
          order: activeSheet?.order || (activeSheetId === 'default' ? 0 : expenseSheets.length + 1),
          rows: sanitizedRows as ImportRow[],
          now,
          createdAt: activeSheet?.createdAt,
        }),
        sheetSources,
        weeklySubmissionStatuses,
      });
      return sanitizedRows as ImportRow[];
    }
    if (!currentProjectId || !authUser || !isPlatformApiEnabled()) {
      throw new Error('사업비 저장 API가 연결되어 있지 않아 읽기 전용으로 유지됩니다.');
    }
    if (!options?.cashflowLease) throw new Error('수정 세션을 먼저 시작해 주세요.');
    const actor = {
      uid: authUser.uid,
      email: authUser.email,
      role: authUser.role,
      idToken: authUser.idToken,
      googleAccessToken: authUser.googleAccessToken,
    };
    const weeklyRows = (sanitizedRows as ImportRow[]).map((row, rowIndex) => ({
      rowIndex,
      tempId: row.tempId,
      sourceTxId: row.sourceTxId,
      entryKind: row.entryKind,
      cells: row.cells.map((rawValue, columnIndex) => ({
        columnIndex,
        rawValue: String(rawValue ?? ''),
        userEdited: row.userEditedCells?.has(columnIndex) || false,
      })),
    }));
    if (!options.canonicalFinal) {
      const draftClient = createCashflowPrivateDraftClient({
        tenantId: orgId,
        actor,
        projectId: currentProjectId,
        sessionId: options.cashflowLease.sessionId,
      });
      const opened = await draftClient.open(options.cashflowLease, {
        baseSnapshot: { sheetKey: activeSheetId },
        payload: {},
      });
      await draftClient.save(options.cashflowLease, {
        expectedDraftRevision: opened.draft.draftRevision,
        payload: {
          ...opened.draft.payload,
          weeklyExpense: { sheetKey: activeSheetId, sheetName: activeSheetName, rows: weeklyRows },
        },
      });
    } else {
    const current = await readWeeklyExpenseSheetViaBff({
      tenantId: orgId,
      actor,
      projectId: currentProjectId,
      sheetKey: activeSheetId,
    });
    await saveWeeklyExpenseDraftViaBff({
      tenantId: orgId,
      actor,
      projectId: currentProjectId,
      sheetKey: activeSheetId,
      idempotencyKey: `weekly-expense-save:${currentProjectId}:${activeSheetId}:${Date.now()}`,
      lease: options.cashflowLease,
      finalize: options.finalize === true,
      payload: {
        expectedSheetVersion: current.sheetVersion,
        sheetName: activeSheetName,
        rows: weeklyRows,
      },
    });
    }
    const nextSheets = upsertExpenseSheetTabRows({
      sheets: expenseSheetsRef.current,
      sheetId: activeSheetId,
      sheetName: activeSheetName,
      order: activeSheet?.order || (activeSheetId === 'default' ? 0 : expenseSheetsRef.current.length + 1),
      rows: sanitizedRows as ImportRow[],
      now,
      createdAt: activeSheet?.createdAt,
    });
    expenseSheetsRef.current = nextSheets;
    setExpenseSheets(nextSheets);
    setExpenseSheetRows(sanitizedRows as ImportRow[]);
    return sanitizedRows as ImportRow[];
  }, [
    db,
    orgId,
    currentProjectId,
    portalUser?.name,
    authUser?.name,
    activeExpenseSheetId,
    expenseSheets,
    budgetPlanRows,
    expenseSheetRows,
    evidenceRequiredMap,
    sheetSources,
    ledgers,
    isDevHarnessUser,
    weeklySubmissionStatuses,
    authUser?.uid,
    authUser?.email,
    authUser?.role,
    authUser?.idToken,
    authUser?.googleAccessToken,
    portalUser?.email,
    portalUser?.role,
    myProject?.settlementSheetPolicy,
    myProject?.fundInputMode,
    myProject?.basis,
  ]);

  const saveBudgetPlanRows = useCallback(async (rows: BudgetPlanRow[]) => {
    const now = new Date().toISOString();
    const sanitizedRows = rows.map((row) => ({
      budgetCode: row.budgetCode || '',
      subCode: row.subCode || '',
      initialBudget: Number.isFinite(row.initialBudget) ? row.initialBudget : 0,
      revisedBudget: Number.isFinite(row.revisedBudget ?? NaN) ? row.revisedBudget : 0,
      ...(row.note ? { note: row.note } : {}),
    }));
    if (isDevHarnessUser || !db || !currentProjectId) {
      setBudgetPlanRows(sanitizedRows as BudgetPlanRow[]);
      return;
    }
    const payload = withTenantScope(orgId, {
      projectId: currentProjectId,
      rows: sanitizedRows,
      updatedAt: now,
      updatedBy: portalUser?.name || authUser?.name || '',
    });
    await setDoc(
      doc(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/budget_summary/default`),
      payload,
      { merge: true },
    );
    setBudgetPlanRows(sanitizedRows as BudgetPlanRow[]);
  }, [currentProjectId, db, orgId, portalUser?.name, authUser?.name, isDevHarnessUser]);

  const saveBudgetCodeBook = useCallback(async (rows: BudgetCodeEntry[], renames: BudgetCodeRename[] = []) => {
    const now = new Date().toISOString();
    const validation = validateBudgetCodeBookDraft(rows);
    if (!validation.isValid) {
      throw new Error(validation.errors[0] || '비목/세목 구조를 확인해 주세요.');
    }
    const sanitized = normalizeBudgetCodeBook(rows);
    if (isDevHarnessUser || !db || !currentProjectId) {
      setBudgetCodeBook(sanitized);
      return;
    }
    const payload = withTenantScope(orgId, {
      projectId: currentProjectId,
      codes: sanitized,
      updatedAt: now,
      updatedBy: portalUser?.name || authUser?.name || '',
    });
    await setDoc(
      doc(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/budget_code_book/default`),
      payload,
      { merge: true },
    );
    setBudgetCodeBook(sanitized);

    if (renames.length === 0) return;
    const renameMap = new Map<string, { code: string; sub: string }>();
    renames.forEach((r) => {
      const fromCode = normalizeBudgetLabel(r.fromCode);
      const fromSub = normalizeBudgetLabel(r.fromSub);
      const toCode = normalizeBudgetLabel(r.toCode);
      const toSub = normalizeBudgetLabel(r.toSub);
      if (!fromCode || !fromSub || !toCode || !toSub) return;
      renameMap.set(buildBudgetLabelKey(fromCode, fromSub), { code: toCode, sub: toSub });
    });
    if (renameMap.size === 0) return;

    const budgetPlanRef = doc(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/budget_summary/default`);
    const expenseSheetRef = doc(
      db,
      `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/expense_sheets/${activeExpenseSheetId || 'default'}`,
    );
    const evidenceMapRef = doc(db, getOrgDocumentPath(orgId, 'budgetEvidenceMaps', currentProjectId));
    const updatedBy = portalUser?.name || authUser?.name || '';

    if (budgetPlanRows && budgetPlanRows.length > 0) {
      let touched = false;
      const nextRows = budgetPlanRows.map((row) => {
        const key = buildBudgetLabelKey(row.budgetCode, row.subCode);
        const mapped = renameMap.get(key);
        if (!mapped) return row;
        touched = true;
        return { ...row, budgetCode: mapped.code, subCode: mapped.sub };
      });
      if (touched) {
        await setDoc(
          budgetPlanRef,
          withTenantScope(orgId, {
            projectId: currentProjectId,
            rows: nextRows.map((row) => ({
              budgetCode: row.budgetCode || '',
              subCode: row.subCode || '',
              initialBudget: Number.isFinite(row.initialBudget) ? row.initialBudget : 0,
              revisedBudget: Number.isFinite(row.revisedBudget ?? NaN) ? row.revisedBudget : 0,
              ...(row.note ? { note: row.note } : {}),
            })),
            updatedAt: now,
            updatedBy,
          }),
          { merge: true },
        );
        setBudgetPlanRows(nextRows);
      }
    }

    if (expenseSheetRows && expenseSheetRows.length > 0) {
      const budgetCodeIdx = SETTLEMENT_COLUMNS.findIndex((c) => c.csvHeader === '비목');
      const subCodeIdx = SETTLEMENT_COLUMNS.findIndex((c) => c.csvHeader === '세목');
      if (budgetCodeIdx >= 0 && subCodeIdx >= 0) {
        let touched = false;
        const nextRows = expenseSheetRows.map((row) => {
          const cells = Array.isArray(row.cells) ? [...row.cells] : [];
          const key = buildBudgetLabelKey(cells[budgetCodeIdx] || '', cells[subCodeIdx] || '');
          const mapped = renameMap.get(key);
          if (!mapped) return row;
          cells[budgetCodeIdx] = mapped.code;
          cells[subCodeIdx] = mapped.sub;
          touched = true;
          return { ...row, cells };
        });
        if (touched) {
          await setDoc(
            expenseSheetRef,
            withTenantScope(orgId, {
              projectId: currentProjectId,
              rows: nextRows.map(serializeExpenseSheetRowForPersistence),
              updatedAt: now,
              updatedBy,
            }),
            { merge: true },
          );
          setExpenseSheetRows(nextRows);
        }
      }
    }

    if (evidenceRequiredMap && Object.keys(evidenceRequiredMap).length > 0) {
      let touched = false;
      const nextMap: Record<string, string> = {};
      Object.entries(evidenceRequiredMap).forEach(([key, value]) => {
        const [rawCode, rawSub] = key.split('|');
        if (!rawSub) {
          nextMap[key] = value;
          return;
        }
        const mapKey = buildBudgetLabelKey(rawCode, rawSub);
        const mapped = renameMap.get(mapKey);
        if (!mapped) {
          nextMap[key] = value;
          return;
        }
        const nextKey = `${mapped.code}|${mapped.sub}`;
        if (!nextMap[nextKey]) nextMap[nextKey] = value;
        touched = true;
      });
      if (touched) {
        await setDoc(
          evidenceMapRef,
          withTenantScope(orgId, {
            projectId: currentProjectId,
            map: nextMap,
            updatedAt: now,
            updatedBy,
          }),
          { merge: true },
        );
        setEvidenceRequiredMap(nextMap);
      }
    }
  }, [currentProjectId, db, orgId, portalUser?.name, authUser?.name, activeExpenseSheetId, isDevHarnessUser]);

  const saveBudgetTreeV2 = useCallback(async (codes: BudgetTreeCode[]) => {
    const now = new Date().toISOString();
    const normalizedCodes = normalizeBudgetTreeCodes(codes);
    const derivedLegacy = buildLegacyBudgetSnapshotsFromTree(normalizedCodes);
    const nextTree: BudgetTreeV2 = {
      version: 2,
      projectId: currentProjectId || '',
      codes: normalizedCodes,
      updatedAt: now,
      updatedBy: portalUser?.name || authUser?.name || '',
    };
    if (isDevHarnessUser || !db || !currentProjectId) {
      setBudgetCodeBook(derivedLegacy.codeBook);
      setBudgetTreeV2(nextTree);
      return;
    }
    const projectBasePath = `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}`;
    await setDoc(
      doc(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/budget_tree_v2/default`),
      withTenantScope(orgId, nextTree),
      { merge: true },
    );
    await setDoc(
      doc(db, `${projectBasePath}/budget_code_book/default`),
      withTenantScope(orgId, {
        projectId: currentProjectId,
        codes: derivedLegacy.codeBook,
        updatedAt: now,
        updatedBy: portalUser?.name || authUser?.name || '',
      }),
      { merge: true },
    );
    setBudgetCodeBook(derivedLegacy.codeBook);
    setBudgetTreeV2(nextTree);
  }, [authUser?.name, currentProjectId, db, isDevHarnessUser, orgId, portalUser?.name]);

  const upsertWeeklySubmissionStatus = useCallback(async (input: {
    projectId: string;
    yearMonth: string;
    weekNo: number;
    projectionEdited?: boolean;
    projectionUpdated?: boolean;
    expenseEdited?: boolean;
    expenseUpdated?: boolean;
    expenseSyncState?: 'pending' | 'review_required' | 'synced' | 'sync_failed';
    expenseReviewPendingCount?: number;
    cashflowLease?: CashflowMutationLease;
  }) => {
    if (!authUser) throw new Error('주간 제출 상태 저장 권한 정보가 없습니다.');
    const projectId = input.projectId?.trim();
    const yearMonth = input.yearMonth?.trim();
    const weekNo = Math.max(1, Math.min(5, Math.trunc(input.weekNo)));
    if (!projectId || !/^\d{4}-\d{2}$/.test(yearMonth)) return;

    const id = `${projectId}-${yearMonth}-w${weekNo}`;
    const changes = {
      projectionEdited: input.projectionEdited,
      projectionUpdated: input.projectionUpdated,
      expenseEdited: input.expenseEdited,
      expenseUpdated: input.expenseUpdated,
      expenseSyncState: input.expenseSyncState,
      expenseReviewPendingCount: input.expenseReviewPendingCount,
    };
    const compactChanges = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => value !== undefined),
    ) as typeof changes;
    if (isDevHarnessUser) {
      const patch = buildWeeklySubmissionStatusPatch({
        orgId, projectId, yearMonth, weekNo,
        updatedBy: portalUser?.name || authUser.name || '',
        now: new Date().toISOString(),
        ...compactChanges,
      });
      setWeeklySubmissionStatuses((prev) => [
        ...prev.filter((item) => item.id !== id),
        { ...prev.find((item) => item.id === id), ...patch },
      ]);
      return;
    }
    if (!isPlatformApiEnabled()) {
      throw new Error('주간 제출 상태 API가 연결되어 있지 않아 읽기 전용으로 유지됩니다.');
    }
    if (!input.cashflowLease) throw new Error('수정 세션을 먼저 시작해 주세요.');
    const current = weeklySubmissionStatuses.find((item) => item.id === id);
    try {
      const result = await applyWeeklySubmissionStatusIntentViaBff({
        tenantId: orgId,
        actor: {
          uid: authUser.uid,
          email: authUser.email,
          role: authUser.role,
          idToken: authUser.idToken,
          googleAccessToken: authUser.googleAccessToken,
        },
        projectId,
        lease: input.cashflowLease,
        idempotencyKey: `cashflow-weekly-status:${id}:${Date.now()}`,
        intent: {
          yearMonth,
          weekNo,
          expectedRevision: current?.statusRevision || 0,
          changes: compactChanges,
        },
      });
      setWeeklySubmissionStatuses((prev) => [
        ...prev.filter((item) => item.id !== id),
        result.status,
      ]);
    } catch (err) {
      console.error('[PortalStore] weeklySubmissionStatus save failed:', err);
      toast.error('주간 제출 상태 저장에 실패했습니다.');
      throw err;
    }
  }, [authUser, isDevHarnessUser, orgId, portalUser?.name, weeklySubmissionStatuses]);

  const createProjectRequest = useCallback(async (payload: ProjectRequestPayload): Promise<string | null> => {
    if (!db || !authUser) {
      toast.error('로그인 정보를 확인할 수 없습니다.');
      return null;
    }
    const now = new Date().toISOString();
    const id = `pr-${Date.now()}`;
    const requesterName = authUser.name || portalUser?.name || '사용자';
    const requesterEmail = authUser.email || portalUser?.email || '';
    const ownerId = payload.registeredById || payload.managerId || authUser.uid;
    const ownerName = payload.registeredByName || payload.managerName || requesterName;
    const ownerEmail = payload.registeredByEmail || (ownerId === authUser.uid ? requesterEmail : '');
    const requestPayload: ProjectRequestPayload = {
      ...payload,
      registeredById: ownerId,
      registeredByName: ownerName,
      registeredByEmail: ownerEmail,
      managerId: ownerId,
      managerName: ownerName,
    };
    const request: ProjectRequest = {
      id,
      tenantId: orgId,
      status: 'PENDING',
      payload: requestPayload,
      requestedBy: authUser.uid,
      requestedByName: requesterName,
      requestedByEmail: requesterEmail,
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    // Immediately create project (no admin approval flow)
    const projectId = `p${Date.now()}`;
    const slug = String(requestPayload.name || '')
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 50);
    const revenueFinancials = resolveProjectRevenueFinancials({
      contractAmount: requestPayload.contractAmount,
      totalRevenueAmount: requestPayload.totalRevenueAmount,
      preferredSource: 'totalRevenueAmount',
    });
    const financialInputFlags = normalizeProjectFinancialInputFlagsForAmounts(requestPayload.financialInputFlags, {
      contractAmount: requestPayload.contractAmount,
      salesVatAmount: requestPayload.salesVatAmount,
      totalRevenueAmount: revenueFinancials.totalRevenueAmount,
      supportAmount: requestPayload.supportAmount,
    });
    const paymentPlan = requestPayload.paymentPlan || { contract: 0, interim: 0, final: 0 };
    const project: Project = {
      id: projectId,
      slug,
      orgId,
      registrationSource: 'pm_portal',
      executiveReviewStatus: 'PENDING',
      executiveReviewHistory: [{
        status: 'PENDING',
        previousStatus: null,
        reviewedAt: now,
        reviewedById: authUser.uid,
        reviewedByName: requesterName,
        reviewComment: null,
      }],
      registeredById: ownerId,
      registeredByName: ownerName,
      registeredByEmail: ownerEmail,
      registeredAt: now,
      name: requestPayload.name,
      officialContractName: requestPayload.officialContractName,
      status: normalizeProjectStatus(requestPayload.status),
      type: normalizeProjectType(requestPayload.type),
      phase: normalizeProjectPhase(requestPayload.phase),
      contractAmount: requestPayload.contractAmount,
      contractStart: requestPayload.contractStart,
      contractEnd: requestPayload.contractEnd,
      settlementType: normalizeSettlementType(requestPayload.settlementType),
      basis: normalizeBasis(requestPayload.basis),
      accountType: normalizeAccountType(requestPayload.accountType),
      settlementSystem: requestPayload.settlementSystem,
      laborSettlementBasis: requestPayload.laborSettlementBasis,
      fundInputMode: normalizeProjectFundInputMode(requestPayload.fundInputMode),
      settlementSheetPolicy: normalizeSettlementSheetPolicy(requestPayload.settlementSheetPolicy, normalizeProjectFundInputMode(requestPayload.fundInputMode)),
      paymentPlan,
      paymentExpectedMonths: requestPayload.paymentExpectedMonths,
      advanceInterimBelow70Reason: requestPayload.advanceInterimBelow70Reason,
      paymentPlanDesc: requestPayload.paymentPlanDesc,
      clientOrg: requestPayload.clientOrg,
      businessManagementGoogleFolderLink: requestPayload.businessManagementGoogleFolderLink || '',
      groupwareName: requestPayload.groupwareName || '',
      participantCondition: requestPayload.participantCondition,
      teamMembersDetailed: requestPayload.teamMembersDetailed || [],
      contractType: normalizeProjectContractType(requestPayload.contractType),
      projectPurpose: requestPayload.projectPurpose,
      totalRevenueAmount: revenueFinancials.totalRevenueAmount,
      supportAmount: requestPayload.supportAmount,
      salesVatAmount: requestPayload.salesVatAmount,
      financialInputFlags,
      settlementGuide: requestPayload.settlementGuide,
      contractDocument: requestPayload.contractDocument,
      quoteDocument: requestPayload.quoteDocument || null,
      proposalDocument: requestPayload.proposalDocument || null,
      department: normalizeProjectDepartment(requestPayload.department),
      cic: resolveProjectCic({ department: requestPayload.department }),
      teamName: requestPayload.teamName,
      managerId: ownerId,
      managerName: ownerName,
      budgetCurrentYear: requestPayload.contractAmount || 0,
      taxInvoiceAmount: 0,
      profitRate: revenueFinancials.profitRate,
      profitAmount: revenueFinancials.profitAmount,
      isSettled: false,
      finalPaymentNote: requestPayload.finalPaymentNote || '',
      confirmerName: '',
      lastCheckedAt: '',
      cashflowDiffNote: '',
      description: requestPayload.description,
      createdAt: now,
      updatedAt: now,
    };
    if (isPlatformApiEnabled()) {
      const idToken = authUser.idToken || await getAuthInstance()?.currentUser?.getIdToken() || undefined;
      await upsertProjectViaBff({
        tenantId: orgId,
        actor: {
          uid: authUser.uid,
          email: authUser.email,
          role: authUser.role,
          idToken,
        },
        project: { ...project } as UpsertProjectPayload,
      });
    } else {
      await setDoc(doc(db, getOrgDocumentPath(orgId, 'projects', projectId)), withTenantScope(orgId, project), { merge: true });
    }
    const nextPortalProjectIds = normalizeProjectIds([
      ...(Array.isArray(portalUser?.projectIds) ? portalUser.projectIds : []),
      portalUser?.projectId,
      projectId,
    ]);
    const nextPortalProjectId = resolvePrimaryProjectId(nextPortalProjectIds, projectId) || projectId;
    const nextPortalProjectNames = {
      ...(portalUser?.projectNames || {}),
      [projectId]: requestPayload.name,
    };
    await setDoc(doc(db, getOrgDocumentPath(orgId, 'members', authUser.uid)), {
      uid: authUser.uid,
      name: authUser.name || portalUser?.name || '사용자',
      email: authUser.email || portalUser?.email || '',
      role: normalizePortalRole(authUser.role || portalUser?.role || 'pm'),
      tenantId: orgId,
      status: 'ACTIVE',
      ...buildPortalProfilePatch({
        projectId: nextPortalProjectId,
        projectIds: nextPortalProjectIds,
        projectNames: nextPortalProjectNames,
        updatedAt: now,
        updatedByUid: authUser.uid,
        updatedByName: authUser.name || portalUser?.name || '사용자',
      }),
      updatedAt: now,
      createdAt: authUser.registeredAt || now,
      lastLoginAt: now,
    }, { merge: true });
    setPortalUser((previous) => normalizePortalUser({
      id: authUser.uid,
      name: authUser.name || previous?.name || portalUser?.name || '사용자',
      email: authUser.email || previous?.email || portalUser?.email || '',
      role: normalizePortalRole(authUser.role || previous?.role || portalUser?.role || 'pm'),
      projectId: nextPortalProjectId,
      projectIds: nextPortalProjectIds,
      projectNames: nextPortalProjectNames,
      registeredAt: previous?.registeredAt || authUser.registeredAt || now,
    }));
    await setDoc(doc(db, getOrgDocumentPath(orgId, 'projectRequests', id)), {
      ...request,
      status: 'PENDING',
      reviewOutcome: null,
      reviewedBy: null,
      reviewedByName: null,
      reviewedAt: null,
      approvedProjectId: projectId,
    }, { merge: true });
    return id;
  }, [db, orgId, portalUser, authUser]);

  const saveBankStatementRows = useCallback(async (sheet: BankStatementSheet, options?: CashflowMutationOptions) => {
    const incomingColumns = Array.isArray(sheet?.columns) ? sheet.columns : [];
    const maxLenFromRows = Array.isArray(sheet?.rows)
      ? sheet.rows.reduce((max, row) => Math.max(max, Array.isArray(row?.cells) ? row.cells.length : 0), 0)
      : 0;
    const rawColumns = incomingColumns.length > 0
      ? incomingColumns
      : Array.from({ length: maxLenFromRows }, (_, i) => BANK_STATEMENT_COLUMNS[i] || `컬럼${i + 1}`);
    const seen = new Set<string>();
    const sanitizedColumns = rawColumns.map((c, i) => {
      const base = normalizeSpace(String(c || `컬럼${i + 1}`)) || `컬럼${i + 1}`;
      let next = base;
      let suffix = 2;
      while (seen.has(next)) {
        next = `${base}_${suffix}`;
        suffix += 1;
      }
      seen.add(next);
      return next;
    });
    const sanitizedRows = (Array.isArray(sheet?.rows) ? sheet.rows : []).map((row, i) => ({
      tempId: row?.tempId || `bank-${Date.now()}-${i}`,
      cells: sanitizedColumns.map((_, colIdx) => normalizeSpace(String(Array.isArray(row?.cells) ? (row.cells[colIdx] ?? '') : ''))),
      status: row?.status === 'applied' ? 'applied' as const : 'staged' as const,
    }));
    const sanitizedSheet: BankStatementSheet = { columns: sanitizedColumns, rows: sanitizedRows as BankStatementRow[] };
    if (isDevHarnessUser) {
      setBankStatementRows(sanitizedSheet);
      setBankStatementProjectId(currentProjectId);
      return;
    }
    if (!currentProjectId || !authUser || !isPlatformApiEnabled()) {
      throw new Error('통장내역 저장 API가 연결되어 있지 않아 읽기 전용으로 유지됩니다.');
    }
    if (!options?.cashflowLease) throw new Error('수정 세션을 먼저 시작해 주세요.');
    if (!options.canonicalFinal) {
      const actor = {
        uid: authUser.uid,
        email: authUser.email,
        role: authUser.role,
        idToken: authUser.idToken,
        googleAccessToken: authUser.googleAccessToken,
      };
      const draftClient = createCashflowPrivateDraftClient({
        tenantId: orgId,
        actor,
        projectId: currentProjectId,
        sessionId: options.cashflowLease.sessionId,
      });
      const opened = await draftClient.open(options.cashflowLease, {
        baseSnapshot: { source: 'bank-statement' },
        payload: {},
      });
      await draftClient.save(options.cashflowLease, {
        expectedDraftRevision: opened.draft.draftRevision,
        payload: { ...opened.draft.payload, bankStatement: sanitizedSheet },
      });
      setBankStatementRows(sanitizedSheet);
      setBankStatementProjectId(currentProjectId);
      return;
    }
    const idempotencyKey = `bank-import:${currentProjectId}:${Date.now()}`;
    const result = await importBankStatementBatchViaBff({
      tenantId: orgId,
      actor: {
        uid: authUser.uid,
        email: authUser.email,
        role: authUser.role,
        idToken: authUser.idToken,
        googleAccessToken: authUser.googleAccessToken,
      },
      projectId: currentProjectId,
      idempotencyKey,
      lease: options.cashflowLease,
      finalize: options.finalize === true,
      payload: {
        idempotencyKey,
        uploadName: 'portal-bank-statement',
        columns: sanitizedColumns,
        lines: buildBankStatementServerImportLines(sanitizedSheet),
      },
    });
    const importedIdBySourceKey = new Map(
      result.lines.map((line) => [line.sourceLineKey, line.id || line.sourceLineKey]),
    );
    setBankStatementRows({
      columns: sanitizedSheet.columns,
      rows: sanitizedSheet.rows.map((row) => ({
        ...row,
        tempId: importedIdBySourceKey.get(row.tempId) || row.tempId,
      })),
    });
    setBankStatementProjectId(currentProjectId);
  }, [authUser, currentProjectId, isDevHarnessUser, orgId]);

  const applyBankStatementRowsToExpenseSheet = useCallback(async (sheet: BankStatementSheet & { selectedRowIds?: string[] }, options?: BankStatementApplyOptions) => {
    const now = new Date().toISOString();
    const selectedIds = new Set((sheet.selectedRowIds || []).map((value) => String(value)));
    const fullSheet = sanitizeBankStatementSheet(sheet);
    const selectedRows = selectedIds.size > 0
      ? fullSheet.rows.filter((row) => selectedIds.has(row.tempId))
      : fullSheet.rows;
    const selectedSheet = { columns: fullSheet.columns, rows: selectedRows };
    if (selectedSheet.rows.length === 0) return { appliedCount: 0 };

    const currentSheet = bankStatementRows ? sanitizeBankStatementSheet(bankStatementRows) : fullSheet;
    const targetSheetId = activeExpenseSheetIdRef.current || 'default';
    const targetSheet = expenseSheetsRef.current.find((sheetItem) => sheetItem.id === targetSheetId) || null;
    const targetRows = targetSheet?.rows || (targetSheetId === 'default' ? expenseSheetRowsRef.current : []);
    const cellPatchesByRowKey = options?.cellPatchesByRowKey || {};
    const importRows = mapBankStatementsToImportRows(selectedSheet).map((row, index) => {
      const rowKey = selectedSheet.rows[index]?.tempId || `row-${index}`;
      const patches = cellPatchesByRowKey[rowKey] || [];
      if (patches.length === 0) return row;
      const cells = [...row.cells];
      patches.forEach((patch) => {
        if (patch.columnIndex >= 0 && patch.columnIndex < cells.length) {
          cells[patch.columnIndex] = normalizeSpace(String(patch.rawValue || ''));
        }
      });
      return { ...row, cells };
    });
    const mergedExpenseRows = mergeBankRowsIntoExpenseSheet(targetRows, importRows);
    const uploadBatchId = `bank-apply-${Date.now()}`;
    const intakeItems = buildBankImportIntakeItemsFromBankSheet({
      projectId: currentProjectId || '',
      sheet: selectedSheet,
      existingItems: expenseIntakeItemsRef.current,
      existingRows: targetRows,
      existingExpenseSheetId: targetSheetId,
      lastUploadBatchId: uploadBatchId,
      now,
      updatedBy: portalUser?.name || authUser?.name || '',
    });
    const reconciledIntakeItems = reconcileBankImportUploadItems(expenseIntakeItemsRef.current, intakeItems);

    const shouldMarkApplied = (row: BankStatementRow) => selectedIds.size === 0 || selectedIds.has(row.tempId);
    const nextBankSheet = {
      columns: currentSheet.columns.length > 0 ? currentSheet.columns : fullSheet.columns,
      rows: currentSheet.rows.map((row) => (
        shouldMarkApplied(row) ? { ...row, status: 'applied' as const } : row
      )),
    };
    if (isDevHarnessUser) {
      await saveExpenseSheetRows(mergedExpenseRows, options);
      setBankStatementRows(nextBankSheet);
      setBankStatementProjectId(currentProjectId);
      expenseIntakeItemsRef.current = reconciledIntakeItems;
      setExpenseIntakeItems(reconciledIntakeItems);
      return { appliedCount: importRows.length };
    }
    if (!currentProjectId || !authUser || !isPlatformApiEnabled()) {
      throw new Error('통장내역 반영 API가 연결되어 있지 않아 읽기 전용으로 유지됩니다.');
    }
    if (!options?.cashflowLease) throw new Error('수정 세션을 먼저 시작해 주세요.');
    const actor = {
      uid: authUser.uid,
      email: authUser.email,
      role: authUser.role,
      idToken: authUser.idToken,
      googleAccessToken: authUser.googleAccessToken,
    };
    const importIdempotencyKey = `bank-apply-import:${currentProjectId}:${Date.now()}`;
    const imported = await importBankStatementBatchViaBff({
      tenantId: orgId,
      actor,
      projectId: currentProjectId,
      idempotencyKey: importIdempotencyKey,
      lease: options.cashflowLease,
      payload: {
        idempotencyKey: importIdempotencyKey,
        uploadName: 'portal-bank-apply',
        columns: selectedSheet.columns,
        lines: buildBankStatementServerImportLines(selectedSheet),
      },
    });
    const importLineIdBySourceKey = new Map<string, string>();
    imported.lines.forEach((line) => {
      if (line.id) importLineIdBySourceKey.set(line.sourceLineKey, line.id);
    });
    const currentWeeklySheet = await readWeeklyExpenseSheetViaBff({
      tenantId: orgId,
      actor,
      projectId: currentProjectId,
      sheetKey: targetSheetId,
    });
    const applyIdempotencyKey = `bank-apply:${currentProjectId}:${targetSheetId}:${Date.now()}`;
    const applied = await applyBankStatementItemsViaBff({
      tenantId: orgId,
      actor,
      projectId: currentProjectId,
      idempotencyKey: applyIdempotencyKey,
      lease: options.cashflowLease,
      finalize: true,
      payload: {
        idempotencyKey: applyIdempotencyKey,
        sheetKey: targetSheetId,
        sheetName: targetSheet?.name,
        expectedSheetVersion: currentWeeklySheet.sheetVersion,
        items: importRows.map((row, index) => {
          const sourceLineKey = selectedSheet.rows[index]?.tempId || `row-${index}`;
          const importLineId = importLineIdBySourceKey.get(sourceLineKey);
          if (!importLineId) throw new Error('통장내역 반영 ID를 확인하지 못했습니다.');
          return {
            importLineId,
            cells: row.cells.map((rawValue, columnIndex) => ({
              columnIndex,
              rawValue: String(rawValue ?? ''),
              userEdited: row.userEditedCells?.has(columnIndex) || false,
            })),
          };
        }),
      },
    });
    const readback = await readWeeklyExpenseSheetViaBff({
      tenantId: orgId,
      actor,
      projectId: currentProjectId,
      sheetKey: targetSheetId,
    });
    const readbackRows = readback.rows.map((row) => ({
      tempId: row.id,
      sourceTxId: row.sourceTxId || undefined,
      entryKind: row.entryKind || undefined,
      cells: row.cells
        .slice()
        .sort((a, b) => a.columnIndex - b.columnIndex)
        .map((cell) => cell.rawValue),
      userEditedCells: new Set(row.cells.filter((cell) => cell.userEdited).map((cell) => cell.columnIndex)),
    })) as ImportRow[];
    const nextExpenseSheets = upsertExpenseSheetTabRows({
      sheets: expenseSheetsRef.current,
      sheetId: targetSheetId,
      sheetName: targetSheet?.name || readback.sheetName,
      order: targetSheet?.order || (targetSheetId === 'default' ? 0 : expenseSheetsRef.current.length + 1),
      rows: readbackRows,
      now,
      createdAt: targetSheet?.createdAt,
    });
    expenseSheetsRef.current = nextExpenseSheets;
    setExpenseSheets(nextExpenseSheets);
    setExpenseSheetRows(readbackRows);
    expenseIntakeItemsRef.current = reconciledIntakeItems;
    setExpenseIntakeItems(reconciledIntakeItems);
    setBankStatementRows(nextBankSheet);
    setBankStatementProjectId(currentProjectId);
    return { appliedCount: applied.appliedLineCount };
  }, [authUser, bankStatementRows, currentProjectId, isDevHarnessUser, orgId, portalUser?.name, saveExpenseSheetRows]);

  const refreshBankStatementRows = useCallback(async () => {
    if (isDevHarnessUser || !db || !currentProjectId) return;
    const projectId = currentProjectId;
    const snap = await getDoc(doc(db, `${getOrgDocumentPath(orgId, 'projects', projectId)}/bank_statements/default`));
    if (currentProjectIdRef.current !== projectId) return;
    if (!snap.exists()) {
      setBankStatementRows(null);
      setBankStatementProjectId('');
      return;
    }
    const data = snap.data() as { columns?: string[]; rows?: BankStatementRow[] };
    setBankStatementRows(sanitizeBankStatementSheet({
      columns: Array.isArray(data.columns) ? data.columns : [],
      rows: Array.isArray(data.rows) ? data.rows : [],
    }));
    setBankStatementProjectId(projectId);
  }, [currentProjectId, db, isDevHarnessUser, orgId]);

  const upsertExpenseIntakeItems = useCallback(async (items: BankImportIntakeItem[]) => {
    if (!Array.isArray(items) || items.length === 0) return;
    const normalizedItems = items
      .map((item) => normalizeBankImportIntakeItem(item))
      .filter((item): item is BankImportIntakeItem => item !== null);
    if (normalizedItems.length === 0) return;

    if (isDevHarnessUser || !db || !currentProjectId) {
      setExpenseIntakeItems((prev) => {
        const nextMap = new Map(expenseIntakeItemsRef.current.map((item) => [item.id, item] as const));
        normalizedItems.forEach((item) => {
          nextMap.set(item.id, item);
        });
        const nextItems = Array.from(nextMap.values())
          .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
        expenseIntakeItemsRef.current = nextItems;
        return nextItems;
      });
      return;
    }

    await Promise.all(
      normalizedItems.map((item) => setDoc(
        doc(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/expense_intake/${item.id}`),
        buildBankImportIntakeDoc({ orgId, item }),
        { merge: true },
      )),
    );
    setExpenseIntakeItems((prev) => {
      const nextMap = new Map(expenseIntakeItemsRef.current.map((item) => [item.id, item] as const));
      normalizedItems.forEach((item) => {
        nextMap.set(item.id, item);
      });
      const nextItems = Array.from(nextMap.values())
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
      expenseIntakeItemsRef.current = nextItems;
      return nextItems;
    });
  }, [currentProjectId, db, isDevHarnessUser, orgId]);

  const saveExpenseIntakeDraft = useCallback(async (id: string, updates: Partial<BankImportIntakeItem>) => {
    const currentItem = expenseIntakeItemsRef.current.find((item) => item.id === id);
    if (!currentItem) return;

    const mergedCandidate = mergeBankImportIntakeItem(currentItem, updates);
    if (!mergedCandidate) return;

    if (isDevHarnessUser || !db || !currentProjectId) {
      const nextItems = expenseIntakeItemsRef.current
        .map((item) => (item.id === id ? mergedCandidate : item))
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
      expenseIntakeItemsRef.current = nextItems;
      setExpenseIntakeItems(nextItems);
      return;
    }

    await setDoc(
      doc(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/expense_intake/${id}`),
      buildBankImportIntakeDoc({ orgId, item: mergedCandidate }),
      { merge: true },
    );
    const nextItems = expenseIntakeItemsRef.current
      .map((item) => (item.id === id ? mergedCandidate : item))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
    expenseIntakeItemsRef.current = nextItems;
    setExpenseIntakeItems(nextItems);
  }, [currentProjectId, db, isDevHarnessUser, orgId]);

  const updateExpenseIntakeItem = saveExpenseIntakeDraft;

  const projectExpenseIntakeItem = useCallback(async (id: string, updates?: Partial<BankImportIntakeItem>) => {
    const currentItem = expenseIntakeItemsRef.current.find((item) => item.id === id);
    if (!currentItem) return;
    const mergedCandidate = updates ? mergeBankImportIntakeItem(currentItem, updates) : currentItem;
    if (!mergedCandidate) return;
    if (!isBankImportManualFieldsComplete(mergedCandidate.manualFields)) return;
    const now = new Date().toISOString();
    const evidenceRequiredDesc = resolveEvidenceRequiredDesc(
      evidenceRequiredMap,
      mergedCandidate.manualFields.budgetCategory || '',
      mergedCandidate.manualFields.budgetSubCategory || '',
    );
    const evidenceChecklist = resolveEvidenceChecklist({
      evidenceRequired: [],
      evidenceRequiredDesc,
      evidenceCompletedDesc: mergedCandidate.manualFields.evidenceCompletedDesc || '',
      evidenceCompletedManualDesc: mergedCandidate.manualFields.evidenceCompletedDesc || '',
      evidenceAutoListedDesc: '',
      evidenceDriveLink: '',
      evidenceDriveFolderId: '',
    });
    const normalizedProjectedItem = normalizeBankImportIntakeItem({
      ...mergedCandidate,
      matchState: 'AUTO_CONFIRMED',
      projectionStatus: resolveBankImportProjectionStatus({
        matchState: 'AUTO_CONFIRMED',
        manualFields: mergedCandidate.manualFields,
        evidenceStatus: evidenceChecklist.status,
      }),
      evidenceStatus: evidenceChecklist.status,
      existingExpenseSheetId: mergedCandidate.existingExpenseSheetId || activeExpenseSheetIdRef.current || 'default',
      updatedAt: now,
    });
    if (!normalizedProjectedItem) return;
    const targetSheetId = normalizedProjectedItem.existingExpenseSheetId || activeExpenseSheetIdRef.current || 'default';
    const targetSheet = expenseSheetsRef.current.find((sheet) => sheet.id === targetSheetId) || null;
    const targetRows = targetSheet?.rows || (targetSheetId === activeExpenseSheetIdRef.current ? expenseSheetRowsRef.current : null);
    const projection = upsertExpenseSheetProjectionRowBySourceTxId({
      rows: targetRows,
      item: normalizedProjectedItem,
      evidenceRequiredDesc,
    });
    const projectedItem = normalizeBankImportIntakeItem({
      ...normalizedProjectedItem,
      existingExpenseSheetId: targetSheetId,
      existingExpenseRowTempId: projection.projectedRow.tempId,
    });
    if (!projectedItem) return;
    const nextSheets = upsertExpenseSheetTabRows({
      sheets: expenseSheetsRef.current,
      sheetId: targetSheetId,
      sheetName: sanitizeExpenseSheetName(targetSheet?.name, targetSheetId === 'default' ? '기본 탭' : '새 탭'),
      order: targetSheet?.order || (targetSheetId === 'default' ? 0 : expenseSheetsRef.current.length + 1),
      rows: projection.rows,
      now,
      createdAt: targetSheet?.createdAt,
    });

    if (isDevHarnessUser || !db || !currentProjectId) {
      expenseSheetsRef.current = nextSheets;
      setExpenseSheets(nextSheets);
      if (targetSheetId === activeExpenseSheetIdRef.current) {
        setExpenseSheetRows(projection.rows);
      }
      const nextItems = expenseIntakeItemsRef.current
        .map((item) => (item.id === id ? projectedItem : item))
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
      expenseIntakeItemsRef.current = nextItems;
      setExpenseIntakeItems(nextItems);
      return;
    }

    const expensePayload = buildExpenseSheetPersistenceDoc({
      orgId,
      projectId: currentProjectId,
      activeSheetId: targetSheetId,
      activeSheetName: sanitizeExpenseSheetName(targetSheet?.name, targetSheetId === 'default' ? '기본 탭' : '새 탭'),
      order: targetSheet?.order || (targetSheetId === 'default' ? 0 : expenseSheetsRef.current.length + 1),
      rows: projection.rows,
      createdAt: targetSheet?.createdAt,
      now,
      updatedBy: portalUser?.name || authUser?.name || '',
    });
    await setDoc(
      doc(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/expense_sheets/${targetSheetId}`),
      expensePayload,
      { merge: true },
    );
    await setDoc(
      doc(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/expense_intake/${id}`),
      buildBankImportIntakeDoc({ orgId, item: projectedItem }),
      { merge: true },
    );
    expenseSheetsRef.current = nextSheets;
    setExpenseSheets(nextSheets);
    if (targetSheetId === activeExpenseSheetIdRef.current) {
      setExpenseSheetRows(projection.rows);
    }
    const nextItems = expenseIntakeItemsRef.current
      .map((item) => (item.id === id ? projectedItem : item))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
    expenseIntakeItemsRef.current = nextItems;
    setExpenseIntakeItems(nextItems);
  }, [authUser?.name, currentProjectId, db, evidenceRequiredMap, isDevHarnessUser, orgId, portalUser?.name]);

  const syncExpenseIntakeEvidence = useCallback(async (id: string, updates: Partial<BankImportIntakeItem>) => {
    const currentItem = expenseIntakeItemsRef.current.find((item) => item.id === id);
    if (!currentItem) return;

    const now = new Date().toISOString();
    const nextState = syncExpenseIntakeEvidenceState({
      item: currentItem,
      updates,
      evidenceRequiredMap,
      expenseSheets: expenseSheetsRef.current,
      activeExpenseSheetId: activeExpenseSheetIdRef.current,
      activeRows: expenseSheetRowsRef.current,
      now,
    });

    if (isDevHarnessUser || !db || !currentProjectId) {
      expenseSheetsRef.current = nextState.expenseSheets;
      setExpenseSheets(nextState.expenseSheets);
      if (activeExpenseSheetIdRef.current === (nextState.item.existingExpenseSheetId || activeExpenseSheetIdRef.current)) {
        setExpenseSheetRows(nextState.activeRows);
      }
      const nextItems = expenseIntakeItemsRef.current
        .map((item) => (item.id === id ? nextState.item : item))
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
      expenseIntakeItemsRef.current = nextItems;
      setExpenseIntakeItems(nextItems);
      return;
    }

    await setDoc(
      doc(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/expense_intake/${id}`),
      buildBankImportIntakeDoc({ orgId, item: nextState.item }),
      { merge: true },
    );

    const targetSheetId = nextState.item.existingExpenseSheetId || activeExpenseSheetIdRef.current || 'default';
    const targetSheet = nextState.expenseSheets.find((sheet) => sheet.id === targetSheetId) || null;
    if (targetSheet?.rows) {
      await setDoc(
        doc(db, `${getOrgDocumentPath(orgId, 'projects', currentProjectId)}/expense_sheets/${targetSheetId}`),
        buildExpenseSheetPersistenceDoc({
          orgId,
          projectId: currentProjectId,
          activeSheetId: targetSheetId,
          activeSheetName: sanitizeExpenseSheetName(targetSheet.name, targetSheetId === 'default' ? '기본 탭' : '새 탭'),
          order: targetSheet.order,
          rows: targetSheet.rows,
          createdAt: targetSheet.createdAt,
          now,
          updatedBy: portalUser?.name || authUser?.name || '',
        }),
        { merge: true },
      );
    }

    expenseSheetsRef.current = nextState.expenseSheets;
    setExpenseSheets(nextState.expenseSheets);
    if (activeExpenseSheetIdRef.current === targetSheetId) {
      setExpenseSheetRows(nextState.activeRows);
    }
    const nextItems = expenseIntakeItemsRef.current
      .map((item) => (item.id === id ? nextState.item : item))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
    expenseIntakeItemsRef.current = nextItems;
    setExpenseIntakeItems(nextItems);
  }, [authUser?.name, currentProjectId, db, evidenceRequiredMap, isDevHarnessUser, orgId, portalUser?.name]);

  const persistTransaction = useCallback(async (txData: Transaction, cashflowLease?: CashflowMutationLease) => {
    if (!authUser || !isPlatformApiEnabled()) {
      throw new Error('거래 저장 API가 연결되어 있지 않아 저장하지 않았습니다.');
    }
    const result = await upsertTransactionViaBff({
      tenantId: orgId,
      actor: authUser,
      transaction: {
        ...txData,
        ...(Number.isFinite(txData.version) ? { expectedVersion: txData.version } : {}),
      },
      lease: cashflowLease,
    });
    return {
      ...txData,
      version: result.version,
      updatedAt: result.updatedAt,
      state: result.state as TransactionState,
    };
  }, [authUser, orgId]);

  const register = useCallback(async (
    user: Omit<PortalUser, 'id' | 'registeredAt' | 'projectId' | 'projectIds'> & {
      projectId?: string;
      projectIds?: string[];
    },
  ): Promise<boolean> => {
    if (isDevHarnessUser) {
      const now = new Date().toISOString();
      const normalizedProjectIds = normalizeProjectIds([
        ...(Array.isArray(user.projectIds) ? user.projectIds : []),
        user.projectId,
      ]);
      const primaryProjectId = resolvePrimaryProjectId(normalizedProjectIds, user.projectId);
      if (!primaryProjectId) {
        toast.error('최소 1개 이상의 사업을 선택해 주세요.');
        return false;
      }
        const candidate = normalizePortalUser({
          ...user,
          id: authUser?.uid || `pu-${Date.now()}`,
          role: normalizePortalRole(authUser?.role || user.role || 'pm'),
          projectId: primaryProjectId,
          projectIds: normalizedProjectIds,
          registeredAt: now,
        });
      if (!candidate) {
        toast.error('사업 정보를 저장하지 못했습니다.');
        return false;
      }
      setPortalUser(candidate);
      return true;
    }
    if (!firestoreEnabled || !db) {
      toast.error('Firestore 연결이 필요합니다. 관리자에게 문의해 주세요.');
      return false;
    }
    const previousPortalUser = portalUser;
    const now = new Date().toISOString();
    const normalizedProjectIds = normalizeProjectIds([
      ...(Array.isArray(user.projectIds) ? user.projectIds : []),
      user.projectId,
    ]);
    const primaryProjectId = resolvePrimaryProjectId(normalizedProjectIds, user.projectId);
    if (!primaryProjectId) {
      toast.error('최소 1개 이상의 사업을 선택해 주세요.');
      return false;
    }

    const candidate = normalizePortalUser({
      ...user,
      id: authUser?.uid || `pu-${Date.now()}`,
      role: normalizePortalRole(authUser?.role || user.role || 'pm'),
      projectId: primaryProjectId,
      projectIds: normalizedProjectIds,
      registeredAt: now,
    });

    if (!candidate) {
      toast.error('사업 정보를 저장하지 못했습니다.');
      return false;
    }

    if (authUser) {
      setIsMemberLoading(true);
      let memberRole = normalizePortalRole(authUser.role || user.role || 'pm');
      try {
        const { canonicalRef, member } = await loadPortalMemberRecord(db, orgId, authUser);
        if (typeof member?.role === 'string' && member.role.trim()) {
          memberRole = normalizePortalRole(member.role);
        }
        await setDoc(canonicalRef, {
          uid: authUser.uid,
          name: candidate.name,
          email: candidate.email,
          role: memberRole,
          tenantId: orgId,
          status: typeof member?.status === 'string' && member.status.trim() ? member.status : 'ACTIVE',
          ...buildPortalProfilePatch({
            projectId: candidate.projectId,
            projectIds: candidate.projectIds,
            projectNames: candidate.projectNames,
            updatedAt: now,
            updatedByUid: authUser.uid,
            updatedByName: authUser.name || candidate.name,
          }),
          updatedAt: now,
          createdAt: member?.createdAt || authUser.registeredAt || now,
          lastLoginAt: now,
        }, { merge: true });
        const nextPortalUser = candidate.role !== memberRole ? { ...candidate, role: memberRole } : candidate;
        setPortalUser(nextPortalUser);
        setActiveProjectIdState(nextPortalUser.projectId);
      } catch (err) {
        console.error('[PortalStore] register member sync error:', err);
        setPortalUser(previousPortalUser);
        toast.error('회원 정보를 저장하지 못했습니다.');
        return false;
      } finally {
        setIsMemberLoading(false);
      }
    } else {
      setPortalUser(candidate);
      setActiveProjectIdState(candidate.projectId);
    }

    return true;
  }, [authUser, firestoreEnabled, db, orgId, portalUser, isDevHarnessUser]);

  const setSessionActiveProject = useCallback(async (projectId: string): Promise<boolean> => {
    const target = projectId.trim();
    if (!target) return false;
    if (!includesProject(scopedProjectIds, target)) {
      toast.error('선택 가능한 사업이 아닙니다.');
      return false;
    }
    setActiveProjectIdState(target);
    return true;
  }, [scopedProjectIds]);

  const patchProjectSnapshot = useCallback((project: Project) => {
    if (!project.id) return;
    setProjects((prev) => {
      const next = mergeProjectSnapshot(prev, project);
      projectsRef.current = next;
      return next;
    });
  }, []);

  const updateProjectStatus = useCallback(async (projectId: string, status: ProjectStatus): Promise<boolean> => {
    const targetProjectId = projectId.trim();
    if (!targetProjectId || !includesProject(scopedProjectIds, targetProjectId)) {
      toast.error('선택 가능한 사업이 아닙니다.');
      return false;
    }

    const normalizedStatus = normalizeProjectStatus(status);
    const existingProject = projectsRef.current.find((project) => project.id === targetProjectId);
    if (!existingProject) {
      toast.error('사업 정보를 찾지 못했습니다.');
      return false;
    }
    if (existingProject.status === normalizedStatus) return true;

    const now = new Date().toISOString();
    const patch: Partial<Project> = {
      status: normalizedStatus,
      updatedAt: now,
    };
    const previousProjects = projectsRef.current;
    const nextProjects = previousProjects.map((project) => (
      project.id === targetProjectId ? { ...project, ...patch } : project
    ));
    projectsRef.current = nextProjects;
    setProjects(nextProjects);

    if (isDevHarnessUser || !firestoreEnabled || !db) return true;

    try {
      if (isPlatformApiEnabled()) {
        const idToken = authUser?.idToken || await getAuthInstance()?.currentUser?.getIdToken() || undefined;
        await upsertProjectViaBff({
          tenantId: orgId,
          actor: {
            uid: authUser?.uid || portalUser?.id || 'portal-user',
            email: authUser?.email || portalUser?.email || '',
            role: authUser?.role || portalUser?.role || 'pm',
            idToken,
          },
          project: {
            ...existingProject,
            ...patch,
            expectedVersion: existingProject.version ?? 1,
          } as UpsertProjectPayload,
        });
      } else {
        await setDoc(
          doc(db, getOrgDocumentPath(orgId, 'projects', targetProjectId)),
          withTenantScope(orgId, patch),
          { merge: true },
        );
      }
      return true;
    } catch (err) {
      console.error('[PortalStore] updateProjectStatus error:', err);
      projectsRef.current = previousProjects;
      setProjects(previousProjects);
      toast.error('사업 상태 저장에 실패했습니다.');
      return false;
    }
  }, [
    authUser?.email,
    authUser?.idToken,
    authUser?.role,
    authUser?.uid,
    db,
    firestoreEnabled,
    isDevHarnessUser,
    orgId,
    portalUser?.email,
    portalUser?.id,
    portalUser?.role,
    scopedProjectIds,
  ]);

  /**
   * 종료사업 체크아웃 항목을 저장한다. 상태 저장과 같은 경로를 쓰되 `checkout` 만 덮어쓴다.
   * 종료 확인은 편집기 초안을 열 만큼 큰 일이 아니라 체크 하나가 곧 저장이다.
   */
  /**
   * 체크아웃 저장은 한 줄로 세운다. 체크박스를 연달아 누르면 요청이 동시에 나가고, 각자
   * 자기가 읽은 version 을 보내 뒤엣것이 409 로 튕긴다. 앞 요청이 끝나야 다음이 시작한다.
   */
  const checkoutSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());


  const runCheckoutSave = useCallback(async (
    projectId: string,
    patch: Partial<ProjectCheckout>,
  ): Promise<boolean> => {
    const targetProjectId = projectId.trim();
    if (!targetProjectId || !includesProject(scopedProjectIds, targetProjectId)) {
      toast.error('선택 가능한 사업이 아닙니다.');
      return false;
    }

    const existingProject = projectsRef.current.find((project) => project.id === targetProjectId);
    if (!existingProject) {
      toast.error('사업 정보를 찾지 못했습니다.');
      return false;
    }

    const nextCheckout = { ...(existingProject.checkout || {}), ...patch } as ProjectCheckout;
    const projectPatch: Partial<Project> = { checkout: nextCheckout, updatedAt: new Date().toISOString() };
    const previousProjects = projectsRef.current;
    const nextProjects = previousProjects.map((project) => (
      project.id === targetProjectId ? { ...project, ...projectPatch } : project
    ));
    projectsRef.current = nextProjects;
    setProjects(nextProjects);

    if (isDevHarnessUser || !firestoreEnabled || !db) return true;

    try {
      if (isPlatformApiEnabled()) {
        const idToken = authUser?.idToken || await getAuthInstance()?.currentUser?.getIdToken() || undefined;
        // 앞 저장이 끝난 뒤의 최신 버전을 읽는다. 이 함수가 처음 읽은 값은 이미 낡았을 수 있다.
        const latest = projectsRef.current.find((project) => project.id === targetProjectId) || existingProject;
        const saved = await upsertProjectViaBff({
          tenantId: orgId,
          actor: {
            uid: authUser?.uid || portalUser?.id || 'portal-user',
            email: authUser?.email || portalUser?.email || '',
            role: authUser?.role || portalUser?.role || 'pm',
            idToken,
          },
          project: {
            ...latest,
            ...projectPatch,
            expectedVersion: latest.version ?? 1,
          } as UpsertProjectPayload,
        });
        // 서버가 올린 version 을 되쓰지 않으면 다음 체크가 다시 낡은 값을 보낸다.
        if (typeof saved?.version === 'number') {
          const versioned = projectsRef.current.map((project) => (
            project.id === targetProjectId ? { ...project, version: saved.version } : project
          ));
          projectsRef.current = versioned;
          setProjects(versioned);
        }
      } else {
        await setDoc(
          doc(db, getOrgDocumentPath(orgId, 'projects', targetProjectId)),
          withTenantScope(orgId, projectPatch),
          { merge: true },
        );
      }
      return true;
    } catch (err) {
      console.error('[PortalStore] updateProjectCheckout error:', err);
      projectsRef.current = previousProjects;
      setProjects(previousProjects);
      toast.error('체크아웃 저장에 실패했습니다.');
      return false;
    }
  }, [
    authUser?.email,
    authUser?.idToken,
    authUser?.role,
    authUser?.uid,
    db,
    firestoreEnabled,
    isDevHarnessUser,
    orgId,
    portalUser?.email,
    portalUser?.id,
    portalUser?.role,
    scopedProjectIds,
  ]);

  /**
   * 체크아웃 증빙 업로드. 체크 저장과 같은 줄에 세운다 - 둘 다 프로젝트 version 을 올리므로
   * 동시에 나가면 서로를 409 로 튕긴다.
   */
  const uploadProjectCheckoutDocument = useCallback((
    projectId: string,
    documentKind: string,
    file: File,
  ): Promise<boolean> => {
    const queued = checkoutSaveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const targetProjectId = projectId.trim();
        if (!targetProjectId || !includesProject(scopedProjectIds, targetProjectId)) {
          toast.error('선택 가능한 사업이 아닙니다.');
          return false;
        }
        if (!isPlatformApiEnabled()) {
          toast.error('이 환경에서는 증빙 업로드를 지원하지 않습니다.');
          return false;
        }
        try {
          const buffer = await file.arrayBuffer();
          let binary = '';
          const bytes = new Uint8Array(buffer);
          for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
          const idToken = authUser?.idToken || await getAuthInstance()?.currentUser?.getIdToken() || undefined;
          const saved = await uploadProjectCheckoutAttachmentViaBff({
            tenantId: orgId,
            actor: {
              uid: authUser?.uid || portalUser?.id || 'portal-user',
              email: authUser?.email || portalUser?.email || '',
              role: authUser?.role || portalUser?.role || 'pm',
              idToken,
            },
            projectId: targetProjectId,
            documentKind,
            file: { name: file.name, size: file.size, type: file.type, contentBase64: btoa(binary) },
          });
          if (typeof saved?.version === 'number') {
            const versioned = projectsRef.current.map((project) => (
              project.id === targetProjectId ? { ...project, version: saved.version } : project
            ));
            projectsRef.current = versioned;
            setProjects(versioned);
          }
          toast.success('증빙을 올렸습니다.');
          return true;
        } catch (err) {
          console.error('[PortalStore] uploadProjectCheckoutDocument error:', err);
          toast.error('증빙 업로드에 실패했습니다.');
          return false;
        }
      });
    checkoutSaveChainRef.current = queued;
    return queued;
  }, [authUser?.email, authUser?.idToken, authUser?.role, authUser?.uid, orgId, portalUser?.email, portalUser?.id, portalUser?.role, scopedProjectIds]);

  /**
   * 밖에서 부르는 입구. 실제 저장은 위 구현이 하고, 여기서는 줄을 세우기만 한다.
   * 체크박스를 연달아 누르면 요청이 동시에 나가 각자 자기가 읽은 version 을 보내고
   * 뒤엣것이 409 로 튕긴다 (라이브에서 실제로 났다).
   */
  const updateProjectCheckout = useCallback((
    projectId: string,
    patch: Partial<ProjectCheckout>,
  ): Promise<boolean> => {
    const queued = checkoutSaveChainRef.current
      .catch(() => undefined)
      .then(() => runCheckoutSave(projectId, patch));
    checkoutSaveChainRef.current = queued;
    return queued;
  }, [runCheckoutSave]);


  const logout = useCallback(() => {
    setActiveProjectIdState('');
    setPortalUser(null);
  }, []);

  const addExpenseSet = useCallback((set: ExpenseSet) => {
    setExpenseSets((prev) => [set, ...prev]);

    if (firestoreEnabled) {
      persistExpenseSet(set).catch((err) => {
        console.error('[PortalStore] persistExpenseSet error:', err);
        toast.error('사업비 세트 저장에 실패했습니다');
      });
    }
  }, [firestoreEnabled, persistExpenseSet]);

  const updateExpenseSet = useCallback((id: string, updates: Partial<ExpenseSet>) => {
    setExpenseSets((prev) => prev.map((item) => {
      if (item.id !== id) return item;
      return { ...item, ...updates };
    }));

    if (firestoreEnabled && db) {
      updateDoc(doc(db, getOrgDocumentPath(orgId, 'expenseSets', id)), {
        ...updates,
        tenantId: orgId,
        updatedAt: new Date().toISOString(),
      }).catch((err) => {
        console.error('[PortalStore] updateExpenseSet error:', err);
        toast.error('사업비 세트 저장에 실패했습니다');
      });
    }
  }, [firestoreEnabled, db, orgId]);

  const addExpenseItem = useCallback((setId: string, item: ExpenseItem) => {
    const now = new Date().toISOString();
    let nextSet: ExpenseSet | null = null;

    setExpenseSets((prev) => prev.map((set) => {
      if (set.id !== setId) return set;
      nextSet = withExpenseItems(set, [...set.items, item], now);
      return nextSet;
    }));

    if (firestoreEnabled && nextSet) {
      persistExpenseSet(nextSet).catch((err) => {
        console.error('[PortalStore] addExpenseItem persist error:', err);
        toast.error('지출 항목 저장에 실패했습니다');
      });
    }
  }, [firestoreEnabled, persistExpenseSet]);

  const updateExpenseItem = useCallback((setId: string, itemId: string, item: ExpenseItem) => {
    const now = new Date().toISOString();
    let nextSet: ExpenseSet | null = null;

    setExpenseSets((prev) => prev.map((set) => {
      if (set.id !== setId) return set;
      nextSet = withExpenseItems(
        set,
        set.items.map((existing) => (existing.id === itemId ? item : existing)),
        now,
      );
      return nextSet;
    }));

    if (firestoreEnabled && nextSet) {
      persistExpenseSet(nextSet).catch((err) => {
        console.error('[PortalStore] updateExpenseItem persist error:', err);
        toast.error('지출 항목 저장에 실패했습니다');
      });
    }
  }, [firestoreEnabled, persistExpenseSet]);

  const deleteExpenseItem = useCallback((setId: string, itemId: string) => {
    const now = new Date().toISOString();
    let nextSet: ExpenseSet | null = null;

    setExpenseSets((prev) => prev.map((set) => {
      if (set.id !== setId) return set;
      nextSet = withExpenseItems(
        set,
        set.items.filter((item) => item.id !== itemId),
        now,
      );
      return nextSet;
    }));

    if (firestoreEnabled && nextSet) {
      persistExpenseSet(nextSet).catch((err) => {
        console.error('[PortalStore] deleteExpenseItem persist error:', err);
        toast.error('지출 항목 삭제에 실패했습니다');
      });
    }
  }, [firestoreEnabled, persistExpenseSet]);

  const changeExpenseStatus = useCallback((setId: string, status: ExpenseSetStatus, reason?: string) => {
    const now = new Date().toISOString();
    let nextSet: ExpenseSet | null = null;

    setExpenseSets((prev) => prev.map((set) => {
      if (set.id !== setId) return set;
      const updates: Partial<ExpenseSet> = { status, updatedAt: now };
      if (status === 'SUBMITTED') updates.submittedAt = now;
      if (status === 'REJECTED') updates.rejectedReason = reason;
      nextSet = { ...set, ...updates };
      return nextSet;
    }));

    if (firestoreEnabled && nextSet) {
      persistExpenseSet(nextSet).catch((err) => {
        console.error('[PortalStore] changeExpenseStatus persist error:', err);
        toast.error('사업비 상태 변경에 실패했습니다');
      });
    }
  }, [firestoreEnabled, persistExpenseSet]);

  const duplicateExpenseSet = useCallback((setId: string) => {
    let duplicated: ExpenseSet | null = null;

    setExpenseSets((prev) => {
      const src = prev.find((set) => set.id === setId);
      if (!src) return prev;

      duplicated = duplicateExpenseSetAsDraft(
        src,
        new Date().toISOString(),
        () => `es-dup-${Date.now()}`,
        () => `ei-dup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );

      return duplicated ? [duplicated, ...prev] : prev;
    });

    if (firestoreEnabled && duplicated) {
      persistExpenseSet(duplicated).catch((err) => {
        console.error('[PortalStore] duplicateExpenseSet persist error:', err);
        toast.error('사업비 세트 복제에 실패했습니다');
      });
    }
  }, [firestoreEnabled, persistExpenseSet]);

  const addChangeRequest = useCallback((req: ChangeRequest) => {
    setChangeRequests((prev) => [req, ...prev]);

    if (firestoreEnabled) {
      persistChangeRequest(req).catch((err) => {
        console.error('[PortalStore] persistChangeRequest error:', err);
        toast.error('인력변경 요청 저장에 실패했습니다');
      });
    }
  }, [firestoreEnabled, persistChangeRequest]);

  const submitChangeRequest = useCallback(async (id: string) => {
    const now = new Date().toISOString();
    let previousRequest: ChangeRequest | null = null;
    let nextRequest: ChangeRequest | null = null;

    setChangeRequests((prev) => prev.map((request) => (
      request.id === id
        ? (() => {
          previousRequest = request;
          nextRequest = {
            ...request,
            state: 'SUBMITTED' as ChangeRequestState,
            timeline: [
              ...request.timeline,
              {
                id: `tl-${Date.now()}`,
                action: '요청서 제출',
                actor: portalUser?.name || request.requestedBy || '사용자',
                timestamp: now,
                type: 'SUBMIT',
              },
            ],
          };
          return nextRequest;
        })()
        : request
    )));

    if (!firestoreEnabled || !db) return true;

    try {
      if (!nextRequest) return true;
      await persistChangeRequest(nextRequest);
      return true;
    } catch (err) {
      console.error('[PortalStore] submitChangeRequest error:', err);
      toast.error('인력변경 제출에 실패했습니다');
      if (previousRequest) {
        setChangeRequests((prev) => prev.map((request) => (
          request.id === id ? previousRequest as ChangeRequest : request
        )));
      }
      return false;
    }
  }, [firestoreEnabled, db, portalUser?.name, persistChangeRequest]);

  const addTransaction = useCallback(async (txData: Transaction, options?: CashflowMutationOptions) => {
    let nextTx = txData;
    if (firestoreEnabled) {
      try {
        nextTx = await persistTransaction(txData, options?.cashflowLease);
      } catch (err) {
        console.error('[PortalStore] persistTransaction error:', err);
        toast.error('거래 저장에 실패했습니다');
        throw err;
      }
    }

    setTransactions((prev) => [nextTx, ...prev.filter((tx) => tx.id !== nextTx.id)]);
  }, [firestoreEnabled, persistTransaction]);

  const updateTransaction = useCallback(async (id: string, updates: Partial<Transaction>, options?: CashflowMutationOptions) => {
    const now = new Date().toISOString();
    const currentTx = transactions.find((t) => t.id === id);
    if (!currentTx) return;
    let nextTx: Transaction = { ...currentTx, ...updates, updatedAt: now };

    if (firestoreEnabled) {
      try {
        nextTx = await persistTransaction(nextTx, options?.cashflowLease);
      } catch (err) {
        console.error('[PortalStore] updateTransaction error:', err);
        toast.error('거래 수정에 실패했습니다');
        throw err;
      }
    }

    setTransactions((prev) => prev.map((t) => (t.id === id ? nextTx : t)));
  }, [firestoreEnabled, persistTransaction, transactions]);

  const patchTransactionSnapshot = useCallback((id: string, updates: Partial<Transaction>) => {
    setTransactions((prev) => prev.map((transaction) => (
      transaction.id === id ? { ...transaction, ...updates } : transaction
    )));
  }, []);

  const changeTransactionState = useCallback(async (id: string, newState: TransactionState, reason?: string, options?: CashflowMutationOptions) => {
    const now = new Date().toISOString();
    const currentTx = transactions.find((t) => t.id === id);
    if (!currentTx) return;
    const stateUpdates: Partial<Transaction> = {
      state: newState,
      updatedAt: now,
      updatedBy: portalUser?.id || 'unknown',
    };
    if (newState === 'SUBMITTED') {
      stateUpdates.submittedBy = portalUser?.name || portalUser?.id;
      stateUpdates.submittedAt = now;
    } else if (newState === 'APPROVED') {
      stateUpdates.approvedBy = portalUser?.name || portalUser?.id;
      stateUpdates.approvedAt = now;
    } else if (newState === 'REJECTED' && reason) {
      stateUpdates.rejectedReason = reason;
    }
    let nextTx: Transaction = { ...currentTx, ...stateUpdates };

    if (firestoreEnabled) {
      try {
        if (!authUser || !isPlatformApiEnabled()) {
          throw new Error('거래 상태 변경 API가 연결되어 있지 않아 저장하지 않았습니다.');
        }
        const result = await changeTransactionStateViaBff({
          tenantId: orgId,
          actor: authUser,
          transactionId: id,
          newState,
          expectedVersion: currentTx.version ?? 1,
          reason,
          lease: options?.cashflowLease,
        });
        nextTx = {
          ...nextTx,
          state: result.state as TransactionState,
          version: result.version,
          updatedAt: result.updatedAt,
          ...(result.rejectedReason ? { rejectedReason: result.rejectedReason } : {}),
        };
      } catch (err) {
        console.error('[PortalStore] changeTransactionState error:', err);
        toast.error('거래 상태 변경에 실패했습니다');
        throw err;
      }
    }

    setTransactions((prev) => prev.map((t) => (t.id === id ? nextTx : t)));
  }, [authUser, firestoreEnabled, orgId, portalUser?.id, portalUser?.name, transactions]);

  const addComment = useCallback(async (comment: Comment, options?: CashflowMutationOptions) => {
    if (!currentProjectId) {
      toast.error('사업 정보가 없어 메모를 저장할 수 없습니다.');
      return;
    }

    const isSheetRowComment = (comment.targetType === 'expense_sheet_row')
      || comment.transactionId.startsWith('sheet-row:')
      || comment.sheetRowId?.startsWith('sheet-row:');
    const payload = {
      ...comment,
      projectId: comment.projectId || currentProjectId,
      targetType: isSheetRowComment ? 'expense_sheet_row' : (comment.targetType || 'transaction'),
      ...(isSheetRowComment ? { sheetRowId: comment.sheetRowId || comment.transactionId } : {}),
    };

    if (firestoreEnabled) {
      if (!authUser || !isPlatformApiEnabled()) {
        throw new Error('메모 저장 API가 연결되어 있지 않아 저장하지 않았습니다.');
      }
      const result = await addCommentViaBff({
        tenantId: orgId,
        actor: authUser,
        transactionId: comment.transactionId,
        comment: {
          id: comment.id,
          content: comment.content,
          authorName: comment.authorName,
          projectId: payload.projectId,
          targetType: payload.targetType,
          sheetRowId: payload.sheetRowId,
          fieldKey: payload.fieldKey,
          fieldLabel: payload.fieldLabel,
        },
        lease: options?.cashflowLease,
      });
      setComments((prev) => [
        ...prev.filter((item) => item.id !== result.id),
        { ...payload, id: result.id, version: result.version, createdAt: result.createdAt } as Comment,
      ]);
      return;
    }

    setComments((prev) => [...prev, payload as Comment]);
  }, [authUser, currentProjectId, firestoreEnabled, orgId]);

  const value: PortalState & PortalActions = {
    isRegistered: !!portalUser,
    isLoading: projectCatalogLoading || projectScopeLoading || isMemberLoading,
    isProjectCatalogReady,
    portalUser,
    activeProjectId,
    members,
    projects,
    ledgers,
    myProject,
    participationEntries,
    expenseSets,
    changeRequests,
    transactions,
    comments,
    evidenceRequiredMap,
    sheetSources,
    expenseIntakeItems,
    expenseSheets,
    activeExpenseSheetId,
    expenseSheetRows,
    bankStatementRows,
    bankStatementProjectId,
    budgetPlanRows,
    budgetCodeBook,
    budgetTreeV2,
    weeklySubmissionStatuses,
    register,
    setSessionActiveProject,
    patchProjectSnapshot,
    updateProjectStatus,
    updateProjectCheckout,
    uploadProjectCheckoutDocument,
    logout,
    addExpenseSet,
    updateExpenseSet,
    addExpenseItem,
    updateExpenseItem,
    deleteExpenseItem,
    changeExpenseStatus,
    duplicateExpenseSet,
    addChangeRequest,
    submitChangeRequest,
    addTransaction,
    updateTransaction,
    patchTransactionSnapshot,
    changeTransactionState,
    addComment,
    saveEvidenceRequiredMap,
    markSheetSourceApplied,
    upsertExpenseIntakeItems,
    saveExpenseIntakeDraft,
    updateExpenseIntakeItem,
    projectExpenseIntakeItem,
    syncExpenseIntakeEvidence,
    setActiveExpenseSheet,
    createExpenseSheet,
    renameExpenseSheet,
    deleteExpenseSheet,
    saveExpenseSheetRows,
    saveBankStatementRows,
    applyBankStatementRowsToExpenseSheet,
    refreshBankStatementRows,
    saveBudgetPlanRows,
    saveBudgetCodeBook,
    saveBudgetTreeV2,
    upsertWeeklySubmissionStatus,
    createProjectRequest,
  };

  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

export function usePortalStore() {
  const ctx = useContext(PortalContext);
  if (!ctx) throw new Error('usePortalStore must be inside PortalProvider');
  return ctx;
}
