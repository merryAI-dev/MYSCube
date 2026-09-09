import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  AlertTriangle,
  ArrowRight,
  FolderPlus,
  Loader2,
  Send,
} from 'lucide-react';
import { usePortalStore } from '../../data/portal-store';
import { useCashflowWeeks } from '../../data/cashflow-weeks-store';
import { useAuth } from '../../data/auth-store';
import type { EvidenceUploadSelection } from '../cashflow/SettlementLedgerPage';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import {
  normalizeSettlementSheetPolicy,
  normalizeProjectFundInputMode,
  type CashflowWeekSheet,
  type Transaction,
  type TransactionState,
} from '../../data/types';
import { toast } from 'sonner';
import { useFirebase } from '../../lib/firebase-context';
import {
  type ProvisionTransactionEvidenceDriveResult,
  type SyncTransactionEvidenceDriveResult,
  type UploadTransactionEvidenceDriveResult,
  provisionProjectEvidenceDriveRootViaBff,
  provisionTransactionEvidenceDriveViaBff,
  syncTransactionEvidenceDriveViaBff,
  uploadTransactionEvidenceDriveViaBff,
  fetchBudgetSuggestionViaBff,
  isPlatformApiEnabled,
  syncProjectCashflowActualsViaBff,
} from '../../lib/platform-bff-client';
import {
  deriveSettlementRowsLocally,
  buildSettlementActualSyncPayloadLocally,
} from '../../platform/settlement-calculation-kernel';
import { splitLooseNameList } from '../../platform/name-list';
import { resolveApiErrorMessage } from '../../platform/api-error-message';
import { reportError } from '../../platform/observability';
import { type ImportRow } from '../../platform/settlement-csv';
import { readDevAuthHarnessConfig } from '../../platform/dev-harness';
import { normalizeBudgetLabel } from '../../platform/budget-labels';
import { buildProjectExpenseRowsForActualSync } from '../../platform/expense-sheet-actual-sync';
import { resolvePortalHappyPath } from '../../platform/portal-happy-path';
import { resolveWeeklyExpenseSavePolicy } from '../../platform/weekly-expense-save-policy';
import { usePortalNavigationGuard } from './PortalLayout';
import { getYearMondayWeeks } from '../../platform/cashflow-weeks';
import { EditLeaseDialogs } from '../editing/EditLeaseDialogs';
import { useCashflowEditLease } from '../cashflow/useCashflowEditLease';
import { createCashflowPrivateDraftClient } from '../../lib/cashflow-private-draft-client';
const GoogleSheetMigrationWizard = lazy(
  () => import('./GoogleSheetMigrationWizard').then((module) => ({ default: module.GoogleSheetMigrationWizard })),
);
const SettlementLedgerPage = lazy(
  () => import('../cashflow/SettlementLedgerPage').then((module) => ({ default: module.SettlementLedgerPage })),
);

export function PortalWeeklyExpensePage() {
  const navigate = useNavigate();
  const { registerNavigationHandler } = usePortalNavigationGuard();
  const weeklyExpenseSavePolicy = resolveWeeklyExpenseSavePolicy();
  const { user: authUser, ensureGoogleWorkspaceAccess } = useAuth();
  const { orgId } = useFirebase();
  const {
    isLoading: portalStoreLoading,
    activeProjectId,
    portalUser,
    myProject,
    ledgers,
    transactions,
    addTransaction,
    updateTransaction,
    patchTransactionSnapshot,
    changeTransactionState,
    evidenceRequiredMap,
    sheetSources,
    saveEvidenceRequiredMap,
    expenseSheets,
    activeExpenseSheetId,
    setActiveExpenseSheet,
    expenseSheetRows,
    bankStatementRows,
    saveExpenseSheetRows,
    comments,
    addComment,
    participationEntries,
    budgetPlanRows,
    budgetCodeBook,
    budgetTreeV2,
    saveBankStatementRows,
    saveBudgetPlanRows,
    saveBudgetCodeBook,
    markSheetSourceApplied,
    weeklySubmissionStatuses,
    upsertWeeklySubmissionStatus,
  } = usePortalStore();
  const {
    upsertWeekAmounts,
    updateVarianceFlag,
    applyProjectActualSyncResultLocally,
  } = useCashflowWeeks();
  const devHarnessConfig = readDevAuthHarnessConfig(import.meta.env, typeof window !== 'undefined' ? window.location : undefined);
  const [projectDriveProvisioning, setProjectDriveProvisioning] = useState(false);
  const [googleSheetImportOpen, setGoogleSheetImportOpen] = useState(false);
  const [hasUnsavedSettlementChanges, setHasUnsavedSettlementChanges] = useState(false);
  const [isSettlementSaving, setIsSettlementSaving] = useState(false);
  const [restoredExpenseRows, setRestoredExpenseRows] = useState<ImportRow[] | null>(null);
  const loadedPrivateDraftKeyRef = useRef('');
  const privateDraftLoadRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const actualSyncSignatureRef = useRef('');

  const projectId = activeProjectId || myProject?.id || '';
  const projectName = myProject?.name || '내 사업';
  const ledgerUserRole = portalUser?.role === 'pm' ? 'pm' : 'admin';
  const visibleExpenseSheets = useMemo(() => (
    expenseSheets.length > 0
      ? expenseSheets
      : [{ id: 'default', name: '', rows: expenseSheetRows, order: 0 }]
  ), [expenseSheets, expenseSheetRows]);
  const shouldShowExpenseSheetTabs = visibleExpenseSheets.length > 1;
  const activeSheetName = useMemo(() => {
    const sheet = visibleExpenseSheets.find((item) => item.id === activeExpenseSheetId) || visibleExpenseSheets[0];
    const name = sheet?.name?.trim();
    return sheet?.id !== 'default' && name ? name : '사업비 입력';
  }, [visibleExpenseSheets, activeExpenseSheetId]);
  const bankStatementCount = bankStatementRows?.rows?.length || 0;

  const defaultLedgerId = useMemo(() => {
    const ledger = ledgers.find((l) => l.projectId === projectId);
    return ledger?.id || `l-${projectId}`;
  }, [projectId, ledgers]);
  const happyPath = useMemo(() => resolvePortalHappyPath({
    authUser,
    portalUser,
    project: myProject,
    ledgers,
  }), [authUser, portalUser, myProject, ledgers]);
  const fundInputMode = normalizeProjectFundInputMode(myProject?.fundInputMode);
  const isDirectEntryMode = fundInputMode === 'DIRECT_ENTRY';
  const weeklySetupPanel = useMemo(() => {
    if (!happyPath.canOpenWeeklyExpenses) {
      return {
        title: '주간 사업비를 시작하려면 먼저 사업 연결이 필요합니다',
        description: '사업 배정이 끝나면 이 화면과 통장내역, 예산 화면을 같은 기준으로 사용할 수 있습니다.',
        toneClass: 'border-amber-200/70 bg-amber-50/70',
        actionLabel: '사업 설정 열기',
        actionKind: 'settings' as const,
      };
    }
    if (!isDirectEntryMode && bankStatementCount === 0) {
      return {
        title: '이번 주 원본이 아직 없습니다',
        description: '통장내역을 먼저 올리면 이 탭이 자동 분류와 사람 확인 기준으로 바로 이어집니다.',
        toneClass: 'border-cyan-200/70 bg-cyan-50/70',
        actionLabel: '통장내역 열기',
        actionKind: 'bank' as const,
      };
    }
    if (!happyPath.canUseEvidenceWorkflow) {
      return {
        title: '증빙 폴더 연결을 마치면 제출 흐름이 더 빨라집니다',
        description: '기본 폴더를 준비하면 행 저장 후 바로 증빙 폴더 생성, 업로드, 동기화를 이어갈 수 있습니다.',
        toneClass: 'border-amber-200/70 bg-amber-50/70',
        actionLabel: '기본 폴더 준비',
        actionKind: 'drive' as const,
      };
    }
    return null;
  }, [
    bankStatementCount,
    happyPath.canOpenWeeklyExpenses,
    happyPath.canUseEvidenceWorkflow,
    isDirectEntryMode,
  ]);
  const settlementSheetPolicy = useMemo(
    () => normalizeSettlementSheetPolicy(myProject?.settlementSheetPolicy, myProject?.fundInputMode),
    [myProject?.fundInputMode, myProject?.settlementSheetPolicy],
  );
  const effectiveBudgetCodeBook = useMemo(() => {
    const orderedCodes: string[] = [];
    const subCodesByCode = new Map<string, Set<string>>();
    const pushEntry = (rawCode?: string | null, rawSub?: string | null) => {
      const code = normalizeBudgetLabel(rawCode || '');
      const sub = normalizeBudgetLabel(rawSub || '');
      if (!code || !sub) return;
      if (!subCodesByCode.has(code)) {
        subCodesByCode.set(code, new Set());
        orderedCodes.push(code);
      }
      subCodesByCode.get(code)!.add(sub);
    };

    const pushCode = (rawCode?: string | null) => {
      const code = normalizeBudgetLabel(rawCode || '');
      if (!code) return;
      if (!subCodesByCode.has(code)) {
        subCodesByCode.set(code, new Set());
        orderedCodes.push(code);
      }
      return code;
    };

    if (budgetTreeV2?.codes && budgetTreeV2.codes.length > 0) {
      budgetTreeV2.codes.forEach((entry) => {
        const code = pushCode(entry.code);
        if (!code) return;
        entry.subItems.forEach((subItem) => pushEntry(code, subItem.subCode));
      });
    } else {
      budgetCodeBook.forEach((entry) => {
        const code = pushCode(entry.code);
        if (!code) return;
        entry.subCodes.forEach((subCode) => pushEntry(code, subCode));
      });
      (budgetPlanRows || []).forEach((row) => pushEntry(row.budgetCode, row.subCode));
    }

    return orderedCodes.map((code) => ({
      code,
      subCodes: Array.from(subCodesByCode.get(code) || []),
    })).filter((entry) => entry.subCodes.length > 0);
  }, [budgetCodeBook, budgetPlanRows, budgetTreeV2?.codes]);

  const authorOptions = useMemo(() => {
    const names = new Set<string>();
    const collectNames = (value?: string | null) => {
      splitLooseNameList(value).forEach((name) => names.add(name));
    };
    participationEntries
      .filter((e) => e.projectId === projectId)
      .forEach((e) => {
        collectNames(e.memberName);
      });
    collectNames(portalUser?.name);
    collectNames(myProject?.managerName);
    collectNames(myProject?.settlementSupportName);
    return Array.from(names).filter(Boolean).sort((a, b) => a.localeCompare(b, 'ko'));
  }, [participationEntries, projectId, portalUser?.name, myProject?.managerName, myProject?.settlementSupportName]);

  const bffActor = useMemo(() => ({
    uid: authUser?.uid || portalUser?.id || 'portal-user',
    email: authUser?.email || portalUser?.email || '',
    role: authUser?.role || portalUser?.role || 'pm',
    idToken: authUser?.idToken,
    googleAccessToken: authUser?.googleAccessToken,
  }), [
    authUser?.uid,
    authUser?.email,
    authUser?.role,
    authUser?.idToken,
    authUser?.googleAccessToken,
    portalUser?.id,
    portalUser?.email,
    portalUser?.role,
  ]);
  const cashflowLease = useCashflowEditLease({ tenantId: orgId, projectId, actor: bffActor });
  const cashflowPrivateDraftClient = useMemo(() => (
    cashflowLease.sessionId && projectId
      ? createCashflowPrivateDraftClient({
          tenantId: orgId,
          projectId,
          actor: bffActor,
          sessionId: cashflowLease.sessionId,
        })
      : null
  ), [bffActor, cashflowLease.sessionId, orgId, projectId]);
  const saveExpenseSheetRowsWithLease = useCallback(async (rows: ImportRow[]) => {
    const mutationLease = await cashflowLease.checkBeforeMutation();
    const saved = await saveExpenseSheetRows(rows, { cashflowLease: mutationLease });
    setRestoredExpenseRows(saved);
    return saved;
  }, [cashflowLease.checkBeforeMutation, saveExpenseSheetRows]);
  const saveBankStatementRowsWithLease = useCallback(async (sheet: Parameters<typeof saveBankStatementRows>[0]) => {
    const mutationLease = await cashflowLease.checkBeforeMutation();
    return saveBankStatementRows(sheet, { cashflowLease: mutationLease });
  }, [cashflowLease.checkBeforeMutation, saveBankStatementRows]);
  const upsertWeekAmountsWithLease = useCallback(async (input: Parameters<typeof upsertWeekAmounts>[0]) => {
    const mutationLease = await cashflowLease.checkBeforeMutation();
    return upsertWeekAmounts({ ...input, cashflowLease: mutationLease });
  }, [cashflowLease.checkBeforeMutation, upsertWeekAmounts]);
  const updateVarianceFlagWithLease = useCallback(async (input: Parameters<typeof updateVarianceFlag>[0]) => {
    const mutationLease = await cashflowLease.checkBeforeMutation();
    return updateVarianceFlag({ ...input, cashflowLease: mutationLease });
  }, [cashflowLease.checkBeforeMutation, updateVarianceFlag]);
  const upsertWeeklySubmissionStatusWithLease = useCallback(async (
    input: Parameters<typeof upsertWeeklySubmissionStatus>[0],
  ) => {
    const mutationLease = await cashflowLease.checkBeforeMutation();
    return upsertWeeklySubmissionStatus({ ...input, cashflowLease: mutationLease });
  }, [cashflowLease.checkBeforeMutation, upsertWeeklySubmissionStatus]);
  const saveEvidenceRequiredMapWithLease = useCallback(async (map: Record<string, string>) => {
    const mutationLease = await cashflowLease.checkBeforeMutation();
    return saveEvidenceRequiredMap(map, { cashflowLease: mutationLease });
  }, [cashflowLease.checkBeforeMutation, saveEvidenceRequiredMap]);
  const hydrateWeeklyPrivateDraft = useCallback(async (ownership: { leaseId: string; fence: number }) => {
    if (!cashflowPrivateDraftClient) throw new Error('임시저장 API가 준비되지 않았습니다.');
    const key = `${projectId}:${ownership.leaseId}:${ownership.fence}`;
    if (loadedPrivateDraftKeyRef.current === key) return;
    if (privateDraftLoadRef.current?.key === key) return privateDraftLoadRef.current.promise;
    const promise = (async () => {
      const opened = await cashflowPrivateDraftClient.open(ownership, { baseSnapshot: {}, payload: {} });
      const weeklyExpense = opened.draft.payload.weeklyExpense;
      if (weeklyExpense && typeof weeklyExpense === 'object' && !Array.isArray(weeklyExpense)) {
        const rawRows = (weeklyExpense as { rows?: unknown }).rows;
        if (Array.isArray(rawRows)) {
          const restored = rawRows.map((value, rowIndex) => {
            const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
            const rawCells = Array.isArray(row.cells) ? row.cells : [];
            const cells = rawCells
              .filter((cell): cell is Record<string, unknown> => Boolean(cell && typeof cell === 'object'))
              .sort((a, b) => Number(a.columnIndex) - Number(b.columnIndex));
            return {
              tempId: typeof row.tempId === 'string' ? row.tempId : `draft-row-${rowIndex}`,
              sourceTxId: typeof row.sourceTxId === 'string' ? row.sourceTxId : undefined,
              entryKind: typeof row.entryKind === 'string' ? row.entryKind : undefined,
              cells: cells.map((cell) => String(cell.rawValue ?? '')),
              userEditedCells: new Set(cells.filter((cell) => cell.userEdited === true).map((cell) => Number(cell.columnIndex))),
            };
          }) as ImportRow[];
          setRestoredExpenseRows(restored);
        }
      }
      loadedPrivateDraftKeyRef.current = key;
    })();
    privateDraftLoadRef.current = { key, promise };
    try {
      await promise;
    } finally {
      if (privateDraftLoadRef.current?.key === key) privateDraftLoadRef.current = null;
    }
  }, [cashflowPrivateDraftClient, projectId]);
  useEffect(() => {
    loadedPrivateDraftKeyRef.current = '';
    privateDraftLoadRef.current = null;
    setRestoredExpenseRows(null);
  }, [projectId]);
  useEffect(() => {
    if (!cashflowLease.canEdit || !cashflowLease.ownership) return;
    void hydrateWeeklyPrivateDraft(cashflowLease.ownership).catch((error) => {
      toast.error(resolveApiErrorMessage(error, '임시저장본을 복구하지 못했습니다.'));
    });
  }, [cashflowLease.canEdit, cashflowLease.ownership, hydrateWeeklyPrivateDraft]);
  const beginWeeklyEditing = useCallback(async (resumePrevious = false) => {
    const ownership = await (resumePrevious ? cashflowLease.takeover() : cashflowLease.acquire());
    if (!ownership) return;
    try {
      await hydrateWeeklyPrivateDraft(ownership);
    } catch (error) {
      await cashflowLease.release();
      toast.error(resolveApiErrorMessage(error, '임시저장본을 열지 못했습니다.'));
    }
  }, [cashflowLease.acquire, cashflowLease.release, cashflowLease.takeover, hydrateWeeklyPrivateDraft]);
  const deriveRowsWithLocalKernel = useCallback(async (
    rows: ImportRow[],
    context: Parameters<typeof deriveSettlementRowsLocally>[1],
    options: Parameters<typeof deriveSettlementRowsLocally>[2],
  ) => deriveSettlementRowsLocally(rows, context, options), []);
  const previewActualSyncWithLocalKernel = useCallback(async (
    rows: ImportRow[],
    yearWeeks: Parameters<typeof buildSettlementActualSyncPayloadLocally>[1],
    persistedRows?: ImportRow[] | null,
  ) => {
    const currentProjectRows = buildProjectExpenseRowsForActualSync({
      sheets: visibleExpenseSheets,
      activeSheetId: activeExpenseSheetId,
      activeRows: rows,
    });
    const persistedProjectRows = buildProjectExpenseRowsForActualSync({
      sheets: visibleExpenseSheets,
      activeSheetId: activeExpenseSheetId,
      activeRows: persistedRows ?? expenseSheetRows ?? [],
    });
    return buildSettlementActualSyncPayloadLocally(currentProjectRows, yearWeeks, persistedProjectRows);
  }, [activeExpenseSheetId, expenseSheetRows, visibleExpenseSheets]);

  const projectActualSyncPayload = useMemo(() => {
    const rows = buildProjectExpenseRowsForActualSync({
      sheets: visibleExpenseSheets,
      activeSheetId: activeExpenseSheetId,
      activeRows: expenseSheetRows ?? [],
    });
    if (rows.length === 0) return [];
    const currentYear = new Date().getFullYear();
    return buildSettlementActualSyncPayloadLocally(rows, getYearMondayWeeks(currentYear), rows);
  }, [activeExpenseSheetId, expenseSheetRows, visibleExpenseSheets]);

  const projectExpenseSourceSignature = useMemo(() => {
    const rows = buildProjectExpenseRowsForActualSync({
      sheets: visibleExpenseSheets,
      activeSheetId: activeExpenseSheetId,
      activeRows: expenseSheetRows ?? [],
    });
    return JSON.stringify({
      projectId,
      sheets: visibleExpenseSheets.map((sheet) => ({
        id: sheet.id,
        name: sheet.name,
        rowCount: Array.isArray(sheet.rows) ? sheet.rows.length : 0,
      })),
      rows: rows.map((row) => ({
        tempId: row.tempId,
        sourceTxId: row.sourceTxId,
        entryKind: row.entryKind,
        cells: row.cells,
      })),
    });
  }, [activeExpenseSheetId, expenseSheetRows, projectId, visibleExpenseSheets]);

  const syncCashflowActualsFromCanonicalSource = useCallback(async () => {
    if (!projectId) return [];
    if (isPlatformApiEnabled()) {
      const result = await syncProjectCashflowActualsViaBff({
        tenantId: orgId,
        actor: bffActor,
        projectId,
      });
      applyProjectActualSyncResultLocally({ projectId, result });
      return [...result.weeks, ...result.cleared];
    }

    throw new Error('Actual 원장 읽기 API가 연결되지 않아 읽기 전용으로 유지됩니다.');
  }, [applyProjectActualSyncResultLocally, bffActor, orgId, projectId]);

  useEffect(() => {
    if (!projectId || portalStoreLoading || hasUnsavedSettlementChanges || isSettlementSaving) return;
    const signature = projectExpenseSourceSignature;
    if (actualSyncSignatureRef.current === signature) return;
    actualSyncSignatureRef.current = signature;
    let cancelled = false;
    void (async () => {
      try {
        await syncCashflowActualsFromCanonicalSource();
        if (cancelled) return;
      } catch (error) {
        actualSyncSignatureRef.current = '';
        reportError(error, {
          message: '[PortalWeeklyExpensePage] actual realtime sync failed:',
          options: {
            level: 'error',
            tags: {
              surface: 'portal_weekly_expense',
              action: 'actual_realtime_sync',
            },
            extra: {
              projectId,
            },
          },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    hasUnsavedSettlementChanges,
    isSettlementSaving,
    portalStoreLoading,
    projectExpenseSourceSignature,
    projectId,
    syncCashflowActualsFromCanonicalSource,
  ]);

  const handleEvidenceDriveError = useCallback((error: unknown, actionLabel: string) => {
    reportError(error, {
      message: `[PortalWeeklyExpensePage] ${actionLabel} failed:`,
      options: {
        level: 'error',
        tags: {
          surface: 'portal_weekly_expense',
          action: actionLabel,
        },
        extra: {
          projectId,
          actorId: bffActor.uid,
        },
      },
    });
    toast.error(resolveApiErrorMessage(error, `${actionLabel}에 실패했습니다.`));
  }, [bffActor.uid, projectId]);

  const applyProvisionedDriveState = useCallback(async (
    txId: string,
    result: ProvisionTransactionEvidenceDriveResult,
  ) => {
    patchTransactionSnapshot(txId, {
      version: result.version,
      evidenceDriveFolderId: result.folderId,
      evidenceDriveFolderName: result.folderName,
      evidenceDriveLink: result.webViewLink || undefined,
      evidenceDriveSharedDriveId: result.sharedDriveId || undefined,
      evidenceDriveSyncStatus: result.syncStatus,
      updatedAt: result.updatedAt,
    });
  }, [patchTransactionSnapshot]);

  const applySyncedEvidenceState = useCallback(async (
    txId: string,
    result: SyncTransactionEvidenceDriveResult | UploadTransactionEvidenceDriveResult,
  ) => {
    patchTransactionSnapshot(txId, {
      version: result.version,
      attachmentsCount: result.evidenceCount,
      evidenceDriveFolderId: result.folderId,
      evidenceDriveFolderName: result.folderName,
      evidenceDriveLink: result.webViewLink || undefined,
      evidenceDriveSharedDriveId: result.sharedDriveId || undefined,
      evidenceDriveSyncStatus: 'SYNCED',
      evidenceDriveLastSyncedAt: result.lastSyncedAt,
      evidenceCompletedDesc: result.evidenceCompletedDesc || '',
      evidenceCompletedManualDesc: result.evidenceCompletedManualDesc || '',
      evidenceAutoListedDesc: result.evidenceAutoListedDesc || '',
      evidencePendingDesc: result.evidencePendingDesc || '',
      supportPendingDocs: result.supportPendingDocs || '',
      evidenceMissing: result.evidenceMissing,
      evidenceStatus: result.evidenceStatus,
      updatedAt: result.updatedAt,
    });
  }, [patchTransactionSnapshot]);

  const ensureTransactionPersisted = useCallback(async ({
    transaction,
    sourceTxId,
  }: {
    transaction: Transaction;
    sourceTxId?: string;
  }): Promise<string | null> => {
    const existingTx = sourceTxId ? transactions.find((candidate) => candidate.id === sourceTxId) : undefined;
    const now = new Date().toISOString();
    const txId = existingTx?.id || transaction.id;
    const nextTx: Transaction = {
      ...(existingTx || {}),
      ...transaction,
      id: txId,
      projectId,
      ledgerId: defaultLedgerId,
      counterparty: transaction.counterparty.trim(),
      state: existingTx?.state || transaction.state || 'DRAFT',
      createdAt: existingTx?.createdAt || transaction.createdAt || now,
      createdBy: existingTx?.createdBy || transaction.createdBy || portalUser?.name || authUser?.name || 'pm',
      updatedAt: now,
      updatedBy: portalUser?.name || authUser?.name || transaction.updatedBy || 'pm',
      weekCode: transaction.weekCode || existingTx?.weekCode || '',
    };

    try {
      const mutationLease = await cashflowLease.checkBeforeMutation();
      if (existingTx) {
        await updateTransaction(txId, nextTx, { cashflowLease: mutationLease });
      } else {
        await addTransaction(nextTx, { cashflowLease: mutationLease });
      }
      return txId;
    } catch (error) {
      handleEvidenceDriveError(error, '거래 저장');
      return null;
    }
  }, [
    addTransaction,
    authUser?.name,
    cashflowLease.checkBeforeMutation,
    defaultLedgerId,
    handleEvidenceDriveError,
    portalUser?.name,
    projectId,
    transactions,
    updateTransaction,
  ]);

  const provisionEvidenceDrive = useCallback(async (tx: Transaction) => {
    if (tx.evidenceDriveFolderId) {
      const folderName = tx.evidenceDriveFolderName || '기존 증빙 폴더';
      toast.success(`이미 연결된 증빙 폴더를 사용합니다: ${folderName}`);
      return {
        transactionId: tx.id,
        projectId: tx.projectId,
        projectFolderId: myProject?.evidenceDriveRootFolderId || '',
        projectFolderName: myProject?.evidenceDriveRootFolderName || '',
        folderId: tx.evidenceDriveFolderId,
        folderName,
        webViewLink: tx.evidenceDriveLink || null,
        sharedDriveId: tx.evidenceDriveSharedDriveId || myProject?.evidenceDriveSharedDriveId || null,
        syncStatus: 'LINKED' as const,
        version: tx.version || 1,
        updatedAt: tx.updatedAt || new Date().toISOString(),
      };
    }

    try {
      const mutationLease = await cashflowLease.checkBeforeMutation();
      const result = await provisionTransactionEvidenceDriveViaBff({
        tenantId: orgId,
        actor: bffActor,
        transactionId: tx.id,
        lease: mutationLease,
      });
      await applyProvisionedDriveState(tx.id, result);
      toast.success(`증빙 폴더 연결 완료: ${result.folderName}`);
      return result;
    } catch (error) {
      handleEvidenceDriveError(error, '증빙 폴더 생성');
      throw error;
    }
  }, [applyProvisionedDriveState, bffActor, cashflowLease.checkBeforeMutation, handleEvidenceDriveError, myProject?.evidenceDriveRootFolderId, myProject?.evidenceDriveRootFolderName, myProject?.evidenceDriveSharedDriveId, orgId]);

  const syncEvidenceDrive = useCallback(async (tx: Transaction) => {
    try {
      const mutationLease = await cashflowLease.checkBeforeMutation();
      const result = await syncTransactionEvidenceDriveViaBff({
        tenantId: orgId,
        actor: bffActor,
        transactionId: tx.id,
        lease: mutationLease,
      });
      await applySyncedEvidenceState(tx.id, result);
      toast.success(`증빙 동기화 완료: Drive 폴더 파일 ${result.evidenceCount}건 반영`);
    } catch (error) {
      handleEvidenceDriveError(error, '증빙 동기화');
      throw error;
    }
  }, [applySyncedEvidenceState, bffActor, cashflowLease.checkBeforeMutation, handleEvidenceDriveError, orgId]);

  const provisionProjectDriveRoot = useCallback(async () => {
    setProjectDriveProvisioning(true);
    try {
      const result = await provisionProjectEvidenceDriveRootViaBff({
        tenantId: orgId,
        actor: bffActor,
        projectId,
      });
      toast.success(`기본 폴더 연결 완료: ${result.folderName}`);
    } catch (error) {
      handleEvidenceDriveError(error, '기본 폴더 생성');
      throw error;
    } finally {
      setProjectDriveProvisioning(false);
    }
  }, [bffActor, handleEvidenceDriveError, orgId, projectId]);

  const uploadEvidenceDrive = useCallback(async (tx: Transaction, uploads: EvidenceUploadSelection[]) => {
    try {
      let lastResult: UploadTransactionEvidenceDriveResult | null = null;
      for (const upload of uploads) {
        const mutationLease = await cashflowLease.checkBeforeMutation();
        const contentBase64 = await readFileAsBase64(upload.file);
        lastResult = await uploadTransactionEvidenceDriveViaBff({
          tenantId: orgId,
          actor: bffActor,
          transactionId: tx.id,
          lease: mutationLease,
          upload: {
            fileName: upload.reviewedFileName,
            originalFileName: upload.file.name,
            mimeType: upload.file.type || 'application/octet-stream',
            fileSize: upload.file.size,
            contentBase64,
            category: upload.category,
          },
        });
      }

      if (lastResult) {
        await applySyncedEvidenceState(tx.id, lastResult);
        const uploadLabel = uploads.length === 1
          ? uploads[0]?.reviewedFileName || uploads[0]?.file.name || '파일 1건'
          : `${uploads[0]?.reviewedFileName || uploads[0]?.file.name || '파일'} 외 ${uploads.length - 1}건`;
        toast.success(`업로드 완료: ${uploadLabel}`);
      }
    } catch (error) {
      handleEvidenceDriveError(error, '증빙 업로드');
      throw error;
    }
  }, [
    applySyncedEvidenceState,
    bffActor,
    cashflowLease.checkBeforeMutation,
    handleEvidenceDriveError,
    orgId,
  ]);

  const handleAddTransaction = useCallback((tx: Transaction) => {
    void (async () => {
      const mutationLease = await cashflowLease.checkBeforeMutation();
      await addTransaction(tx, { cashflowLease: mutationLease });
    })().catch((error) => toast.error(resolveApiErrorMessage(error, '거래 저장에 실패했습니다.')));
  }, [addTransaction, cashflowLease.checkBeforeMutation]);

  const handleUpdateTransaction = useCallback((txId: string, updates: Partial<Transaction>) => {
    void (async () => {
      const mutationLease = await cashflowLease.checkBeforeMutation();
      await updateTransaction(txId, updates, { cashflowLease: mutationLease });
    })().catch((error) => toast.error(resolveApiErrorMessage(error, '거래 수정에 실패했습니다.')));
  }, [cashflowLease.checkBeforeMutation, updateTransaction]);

  const handleChangeTransactionState = useCallback((txId: string, newState: TransactionState, reason?: string) => {
    void (async () => {
      const mutationLease = await cashflowLease.checkBeforeMutation();
      await changeTransactionState(txId, newState, reason, { cashflowLease: mutationLease });
    })().catch((error) => toast.error(resolveApiErrorMessage(error, '거래 상태 변경에 실패했습니다.')));
  }, [cashflowLease.checkBeforeMutation, changeTransactionState]);

  const handleAddComment = useCallback(async (comment: Parameters<typeof addComment>[0]) => {
    const mutationLease = await cashflowLease.checkBeforeMutation();
    await addComment(comment, { cashflowLease: mutationLease });
  }, [addComment, cashflowLease.checkBeforeMutation]);

  const handleFetchBudgetSuggestion = useCallback(async (counterparty: string) => {
    return fetchBudgetSuggestionViaBff({ tenantId: orgId, actor: bffActor, projectId, counterparty });
  }, [bffActor, orgId, projectId]);

  const requestRouteNavigation = useCallback((path: string, label: string) => {
    if (isSettlementSaving) {
      toast.message(`${label} 이동은 저장이 끝난 뒤 가능합니다.`);
      return;
    }
    navigate(path);
  }, [isSettlementSaving, navigate]);

  useEffect(() => {
    registerNavigationHandler(() => {
      if (isSettlementSaving) return true;
      return false;
    });
    return () => registerNavigationHandler(null);
  }, [isSettlementSaving, registerNavigationHandler]);

  useEffect(() => {
    if (!isSettlementSaving) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isSettlementSaving]);

  const requestSheetSwitch = useCallback((sheetId: string) => {
    if (sheetId === activeExpenseSheetId) return;
    setActiveExpenseSheet(sheetId);
  }, [activeExpenseSheetId, setActiveExpenseSheet]);

  if (!projectId) {
    return (
      <div className="rounded-2xl border border-amber-200/70 bg-gradient-to-br from-amber-50 via-white to-orange-50/70 p-6">
        <div className="max-w-2xl space-y-3">
          <h1 className="text-[20px] font-extrabold tracking-[-0.03em] text-slate-900">주간 사업비 화면을 열 준비가 아직 끝나지 않았습니다</h1>
          <p className="text-[13px] leading-6 text-slate-600">
            사업 배정이 끝나면 이번 주 입력 탭, 통장내역, 증빙 흐름을 같은 기준으로 이어서 사용할 수 있습니다.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => navigate('/portal/project-select')}>사업 선택하기</Button>
            <Button variant="outline" size="sm" onClick={() => navigate('/portal/project-select')}>프로젝트 선택으로 이동</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-background px-3 py-2">
        <Button
          type="button"
          size="sm"
          variant={cashflowLease.canEdit ? 'default' : 'outline'}
          disabled={!cashflowLease.sessionId || cashflowLease.busy || cashflowLease.canEdit}
          onClick={() => void beginWeeklyEditing()}
        >
          {cashflowLease.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {cashflowLease.canEdit ? '수정 중' : '수정 시작'}
        </Button>
        {cashflowLease.canEdit && (
          <Button type="button" size="sm" variant="ghost" disabled={cashflowLease.busy} onClick={() => void cashflowLease.extend()}>
            {cashflowLease.remainingLabel} · 30분 연장
          </Button>
        )}
        {!cashflowLease.canEdit && <span className="text-[11px] text-muted-foreground">읽기는 가능하며 저장은 수정 세션을 선점한 뒤 활성화됩니다.</span>}
      </div>
      {weeklySetupPanel ? (
        <Card data-testid="weekly-expense-setup-panel" className={weeklySetupPanel.toneClass}>
          <CardContent className="px-4 py-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0 space-y-1.5">
                <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">지금 해야 할 일</p>
                <p className="text-[15px] font-semibold text-slate-900">{weeklySetupPanel.title}</p>
                <p className="max-w-4xl text-[12px] leading-6 text-slate-600">{weeklySetupPanel.description}</p>
              </div>
              {weeklySetupPanel.actionLabel && (
                <div className="shrink-0">
                  {weeklySetupPanel.actionKind === 'drive' ? (
                    <Button
                      size="sm"
                      onClick={() => void provisionProjectDriveRoot()}
                      disabled={projectDriveProvisioning || !happyPath.canOpenWeeklyExpenses}
                    >
                      {projectDriveProvisioning ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
                      {weeklySetupPanel.actionLabel}
                    </Button>
                  ) : weeklySetupPanel.actionKind === 'settings' ? (
                    <Button size="sm" onClick={() => requestRouteNavigation('/portal/project-select', '사업 선택')}>
                      {weeklySetupPanel.actionLabel}
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => requestRouteNavigation('/portal/bank-statements', '통장내역')}>
                      {weeklySetupPanel.actionLabel}
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {shouldShowExpenseSheetTabs && (
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {visibleExpenseSheets.map((sheet) => (
              <Button
                key={sheet.id}
                variant={sheet.id === activeExpenseSheetId ? 'default' : 'outline'}
                size="sm"
                className="h-8 text-[11px]"
                onClick={() => requestSheetSwitch(sheet.id)}
              >
                {sheet.id === 'default' ? '사업비 입력' : sheet.name || '사업비 입력'}
              </Button>
            ))}
          </div>
        </div>
      )}

      <VarianceFlagBanner
        projectId={projectId}
        onUpdateVarianceFlag={updateVarianceFlagWithLease}
      />
      <p className="text-[11px] text-muted-foreground">
        주차별 입력은 저장할 수 있지만 최종 확정과 수정 잠금은 월 결산에서 처리합니다.
      </p>
      <Suspense
        fallback={(
          <div className="rounded-xl border bg-background px-4 py-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              사업비 시트를 불러오는 중입니다…
            </div>
          </div>
        )}
      >
        <SettlementLedgerPage
          projectId={projectId}
          projectName={projectName}
          transactions={transactions}
          defaultLedgerId={defaultLedgerId}
          onAddTransaction={handleAddTransaction}
          onUpdateTransaction={handleUpdateTransaction}
          authorOptions={authorOptions}
          budgetCodeBook={effectiveBudgetCodeBook}
          budgetTreeV2={budgetTreeV2}
          hideYearControls
          hideCountBadge
          saveMode={weeklyExpenseSavePolicy.mode}
          autoSaveIdleMs={weeklyExpenseSavePolicy.idleMs}
          autoSaveSyncCashflow={false}
          showSaveStatusButton={weeklyExpenseSavePolicy.showStatusButton}
          evidenceRequiredMap={evidenceRequiredMap}
          onSaveEvidenceRequiredMap={saveEvidenceRequiredMapWithLease}
          sheetRows={restoredExpenseRows || expenseSheetRows}
          onSaveSheetRows={saveExpenseSheetRowsWithLease}
          onChangeTransactionState={handleChangeTransactionState}
          currentUserName={portalUser?.name || 'PM'}
          currentUserId={portalUser?.id || 'pm'}
          userRole={ledgerUserRole}
          allowEditSubmitted
          comments={comments}
          onAddComment={handleAddComment}
          onProvisionEvidenceDrive={provisionEvidenceDrive}
          onSyncEvidenceDrive={syncEvidenceDrive}
          onUploadEvidenceDrive={uploadEvidenceDrive}
          onEnsureTransactionPersisted={ensureTransactionPersisted}
          onFetchBudgetSuggestion={isPlatformApiEnabled() ? handleFetchBudgetSuggestion : undefined}
          workflowMode={fundInputMode}
          settlementSheetPolicy={settlementSheetPolicy}
          basis={myProject?.basis}
          onUpdateWeeklySubmissionStatus={upsertWeeklySubmissionStatusWithLease}
          onDeriveRows={deriveRowsWithLocalKernel}
          onPreviewActualSyncPayload={previewActualSyncWithLocalKernel}
          onSyncCashflowActuals={syncCashflowActualsFromCanonicalSource}
          onDirtyStateChange={setHasUnsavedSettlementChanges}
          onSavingStateChange={setIsSettlementSaving}
          weeklySubmissionStatuses={weeklySubmissionStatuses}
          discardChangesRequestToken={0}
          ledgerViewOnly={!cashflowLease.canEdit}
        />
      </Suspense>
      {isSettlementSaving && (
        <div className="fixed inset-0 z-[140] flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex min-h-[22rem] w-[min(92vw,56rem)] max-w-none flex-col items-center justify-center gap-6 rounded-[28px] border bg-background px-8 py-10 shadow-2xl sm:px-12 sm:py-12">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
            <div className="text-center">
              <p className="text-2xl font-bold tracking-[-0.03em] text-foreground sm:text-[2rem]">사업비 입력을 저장하고 있습니다</p>
              <p className="mt-3 text-base leading-8 text-muted-foreground sm:text-lg">저장이 끝날 때까지 잠시 기다려 주세요.</p>
            </div>
          </div>
        </div>
      )}
      {googleSheetImportOpen && (
        <Suspense fallback={null}>
            <GoogleSheetMigrationWizard
              open={googleSheetImportOpen}
              onOpenChange={setGoogleSheetImportOpen}
              orgId={orgId}
              projectId={projectId}
              projectName={projectName}
              projectSettlementType={myProject?.settlementType}
              projectAccountType={myProject?.accountType}
              activeSheetName={activeSheetName}
              bffActor={bffActor}
              expenseSheetRows={restoredExpenseRows || expenseSheetRows || []}
              budgetPlanRows={budgetPlanRows || []}
              evidenceRequiredMap={evidenceRequiredMap}
              sheetSources={sheetSources}
              devHarnessEnabled={devHarnessConfig.enabled}
              ensureGoogleWorkspaceAccess={ensureGoogleWorkspaceAccess}
              saveExpenseSheetRows={saveExpenseSheetRowsWithLease}
              saveBudgetPlanRows={saveBudgetPlanRows}
              saveBudgetCodeBook={saveBudgetCodeBook}
              saveBankStatementRows={saveBankStatementRowsWithLease}
              saveEvidenceRequiredMap={saveEvidenceRequiredMapWithLease}
              markSheetSourceApplied={markSheetSourceApplied}
              upsertWeekAmounts={upsertWeekAmountsWithLease}
              previewActualSyncPayload={previewActualSyncWithLocalKernel}
            />
        </Suspense>
      )}
      <EditLeaseDialogs
        warningOpen={cashflowLease.warningOpen}
        expiredOpen={cashflowLease.expiredOpen}
        conflictOpen={cashflowLease.conflictOpen}
        holder={cashflowLease.holder}
        busy={cashflowLease.busy}
        onDismissWarning={cashflowLease.dismissWarning}
        onExtend={() => { void cashflowLease.extend(); }}
        onContinueReadOnly={cashflowLease.continueReadOnly}
        onReacquire={() => { void beginWeeklyEditing(); }}
        onTakeover={() => { void beginWeeklyEditing(true); }}
      />

    </div>
  );
}

async function readFileAsBase64(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('파일 읽기에 실패했습니다.'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });

  const [, base64 = ''] = dataUrl.split(',', 2);
  if (!base64) {
    throw new Error(`파일 인코딩에 실패했습니다: ${file.name}`);
  }
  return base64;
}

// ── PM 편차 확인 배너 ──

function VarianceFlagBanner({
  projectId,
  onUpdateVarianceFlag,
}: {
  projectId: string;
  onUpdateVarianceFlag: (input: {
    sheetId: string;
    action: 'FLAG' | 'REPLY' | 'RESOLVE';
    content?: string;
  }) => Promise<void>;
}) {
  const { weeks } = useCashflowWeeks();
  const [replyText, setReplyText] = useState('');
  const [replyingId, setReplyingId] = useState<string | null>(null);

  // Find all OPEN flags for this project
  const openFlags = useMemo(() => {
    return weeks.filter(
      (w) =>
        w.projectId === projectId &&
        w.varianceFlag?.status === 'OPEN',
    );
  }, [weeks, projectId]);

  const handleReply = async (sheet: CashflowWeekSheet) => {
    if (!replyText.trim() || !sheet.varianceFlag) return;
    try {
      await onUpdateVarianceFlag({ sheetId: sheet.id, action: 'REPLY', content: replyText.trim() });
      setReplyText('');
      setReplyingId(null);
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '편차 확인 답변을 저장하지 못했습니다.'));
    }
  };

  if (openFlags.length === 0) return null;

  return (
    <div className="space-y-2">
      {openFlags.map((sheet) => {
        const flag = sheet.varianceFlag!;
        const weekLabel = `${sheet.yearMonth} ${sheet.weekNo}주`;
        const isReplying = replyingId === sheet.id;

        return (
          <div
            key={sheet.id}
            className="flex flex-col gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-4 py-3"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-bold text-amber-800 dark:text-amber-200">
                  관리자 확인요청 | {weekLabel}
                </p>
                <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-0.5">
                  "{flag.reason}"
                </p>
                <p className="text-[9px] text-amber-600/70 mt-0.5">
                  {flag.flaggedBy} · {flag.flaggedAt.slice(0, 16).replace('T', ' ')}
                </p>
              </div>
              {!isReplying && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px] shrink-0 border-amber-400 text-amber-700 hover:bg-amber-100"
                  onClick={() => setReplyingId(sheet.id)}
                >
                  답변
                </Button>
              )}
            </div>
            {isReplying && (
              <div className="flex gap-2 ml-6">
                <input
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="사유를 입력하세요..."
                  className="flex-1 h-8 rounded-md border bg-background px-2.5 text-[11px] outline-none focus:ring-1 focus:ring-ring"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleReply(sheet);
                    if (e.key === 'Escape') setReplyingId(null);
                  }}
                />
                <Button
                  size="sm"
                  className="h-8 text-[11px] gap-1 px-3"
                  onClick={() => void handleReply(sheet)}
                  disabled={!replyText.trim()}
                >
                  <Send className="h-3 w-3" />
                  전송
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
