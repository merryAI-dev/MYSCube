import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  collection,
  getDocs,
  limit,
  query,
  where,
} from 'firebase/firestore';
import { useAuth } from './auth-store';
import type { CashflowSheetLineId, CashflowWeekSheet } from './types';
import {
  cashflowWeeklyCompletionKey,
  filterCashflowWeeksThroughSelectedYear,
  isCashflowWeeklySettlementCompleted,
} from './cashflow-weeks.helpers';
import { useFirebase } from '../lib/firebase-context';
import { getOrgCollectionPath } from '../lib/firebase';
import {
  isPlatformApiEnabled,
  syncProjectCashflowActualsViaBff,
  upsertCashflowWeekAmountsViaBff,
  applyCashflowVarianceIntentViaBff,
  type ProjectCashflowActualSyncResult,
} from '../lib/platform-bff-client';
import type { CashflowMutationLease } from '../lib/cashflow-edit-lease';
import { addMonthsToYearMonth, getSeoulTodayIso } from '../platform/business-days';
import { getMonthMondayWeeks } from '../platform/cashflow-weeks';
import { recordDevtoolsLog, summarizeAmountMap, toDevtoolsError } from '../platform/devtools-transaction-log';
import { resolveApiErrorPresentation } from '../platform/api-error-messages';

interface CashflowWeekState {
  yearMonth: string; // selected month ("YYYY-MM")
  weeks: CashflowWeekSheet[];
  weeklySettlementCompletedKeys: string[];
  isLoading: boolean;
  loadError: string | null;
}

interface CashflowWeekActions {
  setYearMonth: (yearMonth: string) => void;
  goPrevMonth: () => void;
  goNextMonth: () => void;
  upsertWeekAmounts: (input: {
    projectId: string;
    yearMonth: string;
    weekNo: number;
    mode: 'projection' | 'actual';
    amounts: Partial<Record<CashflowSheetLineId, number>>;
    markCompleted?: boolean;
    cashflowLease?: CashflowMutationLease;
    finalize?: boolean;
  }) => Promise<void>;
  upsertLineAmount: (input: {
    projectId: string;
    yearMonth: string;
    weekNo: number;
    mode: 'projection' | 'actual';
    lineId: CashflowSheetLineId;
    amount: number;
    cashflowLease?: CashflowMutationLease;
    finalize?: boolean;
  }) => Promise<void>;
  syncProjectActualsFromExpenseSheets: (input: { projectId: string }) => Promise<ProjectCashflowActualSyncResult>;
  applyProjectActualSyncResultLocally: (input: {
    projectId: string;
    result: Pick<ProjectCashflowActualSyncResult, 'weeks' | 'cleared' | 'updatedAt' | 'skipped'>;
  }) => void;
  updateVarianceFlag: (input: {
    sheetId: string;
    action: 'FLAG' | 'REPLY' | 'RESOLVE';
    content?: string;
    cashflowLease?: CashflowMutationLease;
  }) => Promise<void>;
  getWeeksForProject: (projectId: string) => CashflowWeekSheet[];
}

const _g = globalThis as any;
if (!_g.__MYSC_CASHFLOW_WEEKS_CTX__) {
  _g.__MYSC_CASHFLOW_WEEKS_CTX__ = createContext<(CashflowWeekState & CashflowWeekActions) | null>(null);
}
const CashflowWeekContext: React.Context<(CashflowWeekState & CashflowWeekActions) | null> = _g.__MYSC_CASHFLOW_WEEKS_CTX__;

function patchCashflowWeekLocally(
  rows: CashflowWeekSheet[],
  id: string,
  patch: Partial<CashflowWeekSheet>,
  fallback?: CashflowWeekSheet,
): CashflowWeekSheet[] {
  let matched = false;
  const nextRows = rows.map((row) => {
    if (row.id !== id) return row;
    matched = true;
    return { ...row, ...patch };
  });
  if (!matched && fallback) {
    nextRows.push({ ...fallback, ...patch });
  }
  nextRows.sort((a, b) => {
    if (a.projectId !== b.projectId) return String(a.projectId).localeCompare(String(b.projectId));
    if (a.yearMonth !== b.yearMonth) return String(a.yearMonth).localeCompare(String(b.yearMonth));
    return (a.weekNo || 0) - (b.weekNo || 0);
  });
  return nextRows;
}

export function CashflowWeekProvider({ children, loadWeeks = true }: { children: ReactNode; loadWeeks?: boolean }) {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const { db, isOnline, orgId } = useFirebase();
  const firestoreEnabled = isOnline && !!db;

  const [yearMonth, setYearMonthState] = useState(() => getSeoulTodayIso().slice(0, 7));
  const [weeks, setWeeks] = useState<CashflowWeekSheet[]>([]);
  const [weeklySettlementCompletedKeys, setWeeklySettlementCompletedKeys] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);

  const reloadWeeks = useCallback(() => {
    setReloadVersion((current) => current + 1);
  }, []);

  const setYearMonth = useCallback((value: string) => {
    const next = typeof value === 'string' ? value.trim() : '';
    if (!/^\d{4}-\d{2}$/.test(next)) return;
    setYearMonthState(next);
  }, []);

  const goPrevMonth = useCallback(() => {
    setYearMonthState((prev) => addMonthsToYearMonth(prev, -1));
  }, []);

  const goNextMonth = useCallback(() => {
    setYearMonthState((prev) => addMonthsToYearMonth(prev, 1));
  }, []);

  const applyProjectActualSyncResultLocally = useCallback((input: {
    projectId: string;
    result: Pick<ProjectCashflowActualSyncResult, 'weeks' | 'cleared' | 'updatedAt' | 'skipped'>;
  }) => {
    const projectId = input.projectId.trim();
    if (!projectId || input.result.skipped) return;
    reloadWeeks();
  }, [reloadWeeks]);

  useEffect(() => {
    let cancelled = false;

    if (authLoading || !isAuthenticated || !user) {
      setWeeks([]);
      setWeeklySettlementCompletedKeys([]);
      setIsLoading(false);
      setLoadError(null);
      return () => {
        cancelled = true;
      };
    }

    if (!loadWeeks || !firestoreEnabled || !db) {
      setWeeks([]);
      setWeeklySettlementCompletedKeys([]);
      setIsLoading(false);
      setLoadError(null);
      return () => {
        cancelled = true;
      };
    }

    setIsLoading(true);
    setLoadError(null);

    const base = collection(db, getOrgCollectionPath(orgId, 'cashflowWeeks'));
    const selectedYear = Number.parseInt(yearMonth.slice(0, 4), 10);
    const carryForwardYearStart = `${Number.isFinite(selectedYear) ? selectedYear - 1 : yearMonth.slice(0, 4)}-01`;
    const selectedYearEnd = `${yearMonth.slice(0, 4)}-12`;
    const q = query(
      base,
      where('yearMonth', '>=', carryForwardYearStart),
      where('yearMonth', '<=', selectedYearEnd),
      limit(5000),
    );
    const completionQuery = query(
      collection(db, getOrgCollectionPath(orgId, 'cashflowWeeklyUpdateCompletions')),
      where('yearMonth', '==', yearMonth),
      limit(5000),
    );

    void Promise.all([getDocs(q), getDocs(completionQuery)])
      .then(([snap, completionSnap]) => {
        if (cancelled) return;
        const docs = filterCashflowWeeksThroughSelectedYear(
          snap.docs.map((d) => d.data() as CashflowWeekSheet),
          yearMonth,
        );
        docs.sort((a, b) => {
          if (a.projectId !== b.projectId) return String(a.projectId).localeCompare(String(b.projectId));
          if (a.yearMonth !== b.yearMonth) return String(a.yearMonth).localeCompare(String(b.yearMonth));
          return (a.weekNo || 0) - (b.weekNo || 0);
        });
        setWeeks(docs);
        setWeeklySettlementCompletedKeys(completionSnap.docs
          .map((item) => item.data())
          .filter(isCashflowWeeklySettlementCompleted)
          .map(cashflowWeeklyCompletionKey)
          .filter(Boolean));
        setIsLoading(false);
        setLoadError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[CashflowWeeks] fetch error:', err);
        setWeeks([]);
        setWeeklySettlementCompletedKeys([]);
        setIsLoading(false);
        setLoadError(resolveApiErrorPresentation('', 500).guide);
      });

    return () => {
      cancelled = true;
    };
  }, [authLoading, isAuthenticated, user?.uid, db, firestoreEnabled, orgId, yearMonth, reloadVersion, loadWeeks]);

  const upsertWeekAmounts = useCallback(async (input: {
    projectId: string;
    yearMonth: string;
    weekNo: number;
    mode: 'projection' | 'actual';
    amounts: Partial<Record<CashflowSheetLineId, number>>;
    markCompleted?: boolean;
    cashflowLease?: CashflowMutationLease;
    finalize?: boolean;
  }): Promise<void> => {
    const actor = user;
    if (!actor) throw new Error('캐시플로우 저장 권한 정보가 없습니다.');

    const projectId = input.projectId.trim();
    const ym = input.yearMonth.trim();
    const weekNo = Math.max(1, Math.min(5, Math.trunc(input.weekNo)));
    if (!projectId || !/^\d{4}-\d{2}$/.test(ym)) {
      throw new Error('캐시플로우 저장 범위가 올바르지 않습니다.');
    }

    const def = getMonthMondayWeeks(ym).find((week) => week.weekNo === weekNo);
    if (!def) throw new Error('캐시플로우 주차가 올바르지 않습니다.');

    const normalizedAmounts = input.amounts || {};
    const amountSummary = summarizeAmountMap(normalizedAmounts);
    if (actor.source === 'dev_harness') {
      recordDevtoolsLog({
        kind: 'cashflow_transaction',
        phase: 'success',
        operation: 'cashflow.week.upsert',
        transport: 'local',
        tenantId: orgId,
        actorId: actor.uid,
        projectId,
        yearMonth: ym,
        weekNo,
        mode: input.mode,
        summary: amountSummary,
      });
      reloadWeeks();
      return;
    }

    if (!isPlatformApiEnabled()) {
      throw new Error('캐시플로우 저장 API가 연결되어 있지 않아 읽기 전용으로 유지됩니다.');
    }
    if (!input.cashflowLease) {
      throw new Error('수정 세션을 먼저 시작해 주세요.');
    }
    if (input.mode !== 'projection') {
      throw new Error('Actual 값은 주간 사용내역 임시저장 또는 통장내역 반영으로만 저장할 수 있습니다.');
    }

    recordDevtoolsLog({
      kind: 'cashflow_transaction',
      phase: 'start',
      operation: 'cashflow.week.upsert',
      transport: 'bff',
      tenantId: orgId,
      actorId: actor.uid,
      projectId,
      yearMonth: ym,
      weekNo,
      mode: input.mode,
      summary: amountSummary,
    });

    try {
      await upsertCashflowWeekAmountsViaBff({
        tenantId: orgId,
        actor: {
          uid: actor.uid,
          email: actor.email,
          role: actor.role,
          idToken: (actor as any).idToken,
          googleAccessToken: (actor as any).googleAccessToken,
        },
        projectId,
        idempotencyKey: `cashflow-projection:${projectId}:${ym}:w${weekNo}:${Date.now()}`,
        lease: input.cashflowLease,
        finalize: input.finalize === true,
        payload: {
          yearMonth: ym,
          weekNo,
          mode: input.mode,
          amounts: Object.fromEntries(
            Object.entries(normalizedAmounts).map(([lineId, amount]) => [lineId, Number(amount) || 0]),
          ),
        },
      });
      reloadWeeks();
      recordDevtoolsLog({
        kind: 'cashflow_transaction',
        phase: 'success',
        operation: 'cashflow.week.upsert',
        transport: 'bff',
        tenantId: orgId,
        actorId: actor.uid,
        projectId,
        yearMonth: ym,
        weekNo,
        mode: input.mode,
        summary: amountSummary,
      });
    } catch (error) {
      recordDevtoolsLog({
        kind: 'cashflow_transaction',
        phase: 'error',
        operation: 'cashflow.week.upsert',
        transport: 'bff',
        tenantId: orgId,
        actorId: actor.uid,
        projectId,
        yearMonth: ym,
        weekNo,
        mode: input.mode,
        summary: amountSummary,
        error: toDevtoolsError(error),
      });
      throw error;
    }
  }, [orgId, reloadWeeks, user]);
  const upsertLineAmount = useCallback(async (input: {
    projectId: string;
    yearMonth: string;
    weekNo: number;
    mode: 'projection' | 'actual';
    lineId: CashflowSheetLineId;
    amount: number;
    cashflowLease?: CashflowMutationLease;
    finalize?: boolean;
  }): Promise<void> => {
    return upsertWeekAmounts({
      projectId: input.projectId,
      yearMonth: input.yearMonth,
      weekNo: input.weekNo,
      mode: input.mode,
      amounts: { [input.lineId]: input.amount },
      cashflowLease: input.cashflowLease,
      finalize: input.finalize,
    });
  }, [upsertWeekAmounts]);

  const syncProjectActualsFromExpenseSheets = useCallback(async (input: {
    projectId: string;
  }): Promise<ProjectCashflowActualSyncResult> => {
    const actor = user;
    const projectId = input.projectId.trim();
    if (!actor || !projectId) throw new Error('Actual 동기화 권한 정보가 없습니다.');
    if (!isPlatformApiEnabled() || actor.source === 'dev_harness') {
      throw new Error('Actual 동기화 API가 연결되어 있지 않습니다.');
    }

    recordDevtoolsLog({
      kind: 'cashflow_transaction',
      phase: 'start',
      operation: 'cashflow.actual.sync',
      transport: 'bff',
      tenantId: orgId,
      actorId: actor.uid,
      projectId,
    });
    let result: ProjectCashflowActualSyncResult;
    try {
      result = await syncProjectCashflowActualsViaBff({
        tenantId: orgId,
        actor: {
          uid: actor.uid,
          email: actor.email,
          role: actor.role,
          idToken: (actor as any).idToken,
          googleAccessToken: (actor as any).googleAccessToken,
        },
        projectId,
      });
      recordDevtoolsLog({
        kind: 'cashflow_transaction',
        phase: 'success',
        operation: 'cashflow.actual.sync',
        transport: 'bff',
        tenantId: orgId,
        actorId: actor.uid,
        projectId,
        summary: {
          skipped: result.skipped,
          sourceRows: result.sourceRows,
          sheetCount: result.sheetCount,
          upsertedWeeks: result.upsertedWeeks,
          clearedWeeks: result.clearedWeeks,
        },
      });
    } catch (error) {
      recordDevtoolsLog({
        kind: 'cashflow_transaction',
        phase: 'error',
        operation: 'cashflow.actual.sync',
        transport: 'bff',
        tenantId: orgId,
        actorId: actor.uid,
        projectId,
        error: toDevtoolsError(error),
      });
      throw error;
    }

    applyProjectActualSyncResultLocally({ projectId, result });

    return result;
  }, [applyProjectActualSyncResultLocally, orgId, user]);

  const updateVarianceFlag = useCallback(async (input: {
    sheetId: string;
    action: 'FLAG' | 'REPLY' | 'RESOLVE';
    content?: string;
    cashflowLease?: CashflowMutationLease;
  }): Promise<void> => {
    const actor = user;
    const current = weeks.find((week) => week.id === input.sheetId);
    if (!actor || !current) throw new Error('편차 확인 대상 또는 권한 정보를 찾을 수 없습니다.');
    if (actor.source === 'dev_harness') {
      const now = new Date().toISOString();
      const revision = (current.varianceRevision || 0) + 1;
      const previous = current.varianceFlag;
      const varianceFlag = input.action === 'FLAG'
        ? { status: 'OPEN' as const, reason: input.content || '', flaggedBy: actor.name, flaggedByUid: actor.uid, flaggedAt: now }
        : input.action === 'REPLY'
          ? { ...previous!, status: 'REPLIED' as const, pmReply: input.content || '', pmRepliedBy: actor.name, pmRepliedByUid: actor.uid, pmRepliedAt: now }
          : { ...previous!, status: 'RESOLVED' as const, resolvedBy: actor.name, resolvedByUid: actor.uid, resolvedAt: now };
      setWeeks((prev) => patchCashflowWeekLocally(prev, input.sheetId, {
        varianceFlag,
        varianceHistory: [...(current.varianceHistory || []), {
          id: `vf-${revision}`,
          action: input.action,
          actor: actor.name,
          actorUid: actor.uid,
          content: input.action === 'RESOLVE' ? (input.content || '해결 처리') : (input.content || ''),
          timestamp: now,
        }],
        varianceRevision: revision,
        updatedAt: now,
      }));
      return;
    }
    if (!isPlatformApiEnabled()) {
      throw new Error('편차 확인 API가 연결되어 있지 않아 읽기 전용으로 유지됩니다.');
    }
    if (!input.cashflowLease) throw new Error('수정 세션을 먼저 시작해 주세요.');
    const result = await applyCashflowVarianceIntentViaBff({
      tenantId: orgId,
      actor: {
        uid: actor.uid,
        email: actor.email,
        role: actor.role,
        idToken: actor.idToken,
        googleAccessToken: actor.googleAccessToken,
      },
      projectId: current.projectId,
      lease: input.cashflowLease,
      idempotencyKey: `cashflow-variance:${input.sheetId}:${input.action}:${Date.now()}`,
      intent: {
        sheetId: input.sheetId,
        action: input.action,
        content: input.content,
        expectedRevision: current.varianceRevision || 0,
      },
    });
    setWeeks((prev) => patchCashflowWeekLocally(prev, input.sheetId, {
      varianceFlag: result.week.varianceFlag,
      varianceHistory: result.week.varianceHistory,
      varianceRevision: result.week.varianceRevision,
      updatedAt: result.week.updatedAt,
    }));
  }, [orgId, user, weeks]);

  const getWeeksForProject = useCallback((projectId: string): CashflowWeekSheet[] => {
    const pid = projectId.trim();
    if (!pid) return [];
    return weeks.filter((w) => w.projectId === pid);
  }, [weeks]);

  const value = useMemo(() => ({
    yearMonth,
    weeks,
    weeklySettlementCompletedKeys,
    isLoading,
    loadError,
    setYearMonth,
    goPrevMonth,
    goNextMonth,
    upsertWeekAmounts,
    upsertLineAmount,
    syncProjectActualsFromExpenseSheets,
    applyProjectActualSyncResultLocally,
    updateVarianceFlag,
    getWeeksForProject,
  }), [
    yearMonth,
    weeks,
    weeklySettlementCompletedKeys,
    isLoading,
    loadError,
    setYearMonth,
    goPrevMonth,
    goNextMonth,
    upsertWeekAmounts,
    upsertLineAmount,
    syncProjectActualsFromExpenseSheets,
    applyProjectActualSyncResultLocally,
    updateVarianceFlag,
    getWeeksForProject,
  ]);

  return (
    <CashflowWeekContext.Provider value={value}>
      {children}
    </CashflowWeekContext.Provider>
  );
}

export function useCashflowWeeks() {
  const ctx = useContext(CashflowWeekContext);
  if (!ctx) throw new Error('useCashflowWeeks must be used within CashflowWeekProvider');
  return ctx;
}

export function useOptionalCashflowWeeks() {
  return useContext(CashflowWeekContext);
}
