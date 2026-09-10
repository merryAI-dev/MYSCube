import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { CalendarDays, CheckCircle2, CircleDollarSign, Info, AlertTriangle, ArrowRight, CircleHelp, SearchCheck } from 'lucide-react';
import {
  collection,
  getDocs,
  query,
  where,
} from 'firebase/firestore';
import { toast } from 'sonner';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { usePortalStore } from '../../data/portal-store';
import { usePayroll } from '../../data/payroll-store';
import { useCashflowWeeks } from '../../data/cashflow-weeks-store';
import { TRANSACTIONS } from '../../data/mock-data';
import { computePlannedPayDate, getSeoulTodayIso, subtractBusinessDays } from '../../platform/business-days';
import { fmtShort } from '../../data/budget-data';
import { featureFlags } from '../../config/feature-flags';
import { useFirebase } from '../../lib/firebase-context';
import { getOrgCollectionPath } from '../../lib/firebase';
import type { PayrollCandidateReviewDecision, Transaction } from '../../data/types';
import { resolveProjectPayrollLiquidity, type PayrollLiquidityQueueItem } from '../../platform/payroll-liquidity';
import { resolvePayrollCashflowAlignment } from '../../platform/payroll-cashflow-alignment';
import {
  payrollReviewSnapshotMatches,
  resolvePayrollRunReview,
  toPayrollReviewSnapshot,
} from '../../platform/payroll-review';
import {
  getPayrollDecisionLabel,
  getPayrollDecisionTone,
  getPayrollPaidStatusLabel,
  getPayrollPaidStatusTone,
  getPayrollReviewStatusLabel,
  getPayrollReviewStatusTone,
} from '../../platform/payroll-display';

export function PortalPayrollPage() {
  const navigate = useNavigate();
  const { activeProjectId, myProject, portalUser } = usePortalStore();
  const {
    schedules,
    runs,
    upsertSchedule,
    acknowledgePayrollRun,
    savePayrollExpectedAmount,
    savePayrollReview,
  } = usePayroll();
  const { weeks: cashflowWeeks } = useCashflowWeeks();
  const { db, isOnline, orgId } = useFirebase();
  const firestoreEnabled = featureFlags.firestoreCoreEnabled && isOnline && !!db;
  const [liveTransactions, setLiveTransactions] = useState<Transaction[] | null>(null);
  const [transactionsFetchState, setTransactionsFetchState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [decisionSavingTxId, setDecisionSavingTxId] = useState<string | null>(null);
  const [pmAmountInput, setPmAmountInput] = useState('');

  const today = getSeoulTodayIso();
  const yearMonth = today.slice(0, 7);

  const projectId = activeProjectId || myProject?.id || '';
  const schedule = useMemo(() => schedules.find((s) => s.projectId === projectId) || null, [projectId, schedules]);
  const run = useMemo(() => runs.find((r) => r.projectId === projectId && r.yearMonth === yearMonth) || null, [projectId, runs, yearMonth]);
  const projectTransactions = useMemo(() => {
    const source = liveTransactions ?? (!firestoreEnabled ? TRANSACTIONS : []);
    return source.filter((tx) => tx.projectId === projectId);
  }, [firestoreEnabled, liveTransactions, projectId]);

  const [dayInput, setDayInput] = useState<string>(schedule ? String(schedule.dayOfMonth) : '');
  const day = Math.max(1, Math.min(31, Number.parseInt(dayInput || '0', 10) || 0));
  const reviewState = useMemo(() => (
    run && transactionsFetchState === 'ready'
      ? resolvePayrollRunReview({
          run,
          transactions: projectTransactions,
          today,
        })
      : null
  ), [projectTransactions, run, today, transactionsFetchState]);
  const reviewRows = useMemo(() => (
    reviewState?.reviewCandidates.map((candidate) => ({
      candidate,
      tx: projectTransactions.find((tx) => tx.id === candidate.txId) || null,
    })) || []
  ), [projectTransactions, reviewState]);

  const preview = useMemo(() => {
    if (!day || day < 1 || day > 31) return null;
    const planned = computePlannedPayDate(yearMonth, day);
    const notice = subtractBusinessDays(planned, 3);
    return { planned, notice };
  }, [day, yearMonth]);

  const needsPayrollAck = !!(run && today >= run.noticeDate && !run.acknowledged);
  const cashflowAlignment = useMemo(() => (
    run
      ? resolvePayrollCashflowAlignment({
          run,
          cashflowWeeks,
        })
      : null
  ), [cashflowWeeks, run]);
  const queueItems = useMemo(() => (
    myProject
      ? resolveProjectPayrollLiquidity({
          project: myProject,
          runs,
          transactions: projectTransactions,
          cashflowWeeks,
          today,
        })
      : []
  ), [cashflowWeeks, myProject, projectTransactions, runs, today]);
  const activeQueueItem = queueItems[0] || null;
  const reviewStatusLabel = reviewState ? (
    reviewState.paidStatus === 'CONFIRMED'
      ? '지급 확정 완료'
      : reviewState.needsAdminConfirm
      ? 'Admin 최종 확정 대기'
      : getPayrollReviewStatusLabel(reviewState.pmReviewStatus)
  ) : null;

  useEffect(() => {
    setDayInput(schedule ? String(schedule.dayOfMonth) : '');
  }, [projectId, schedule?.dayOfMonth]);

  useEffect(() => {
    setPmAmountInput(
      run?.pmExpectedPayrollAmount !== undefined && run?.pmExpectedPayrollAmount !== null
        ? String(run.pmExpectedPayrollAmount)
        : '',
    );
  }, [run?.id, run?.pmExpectedPayrollAmount]);

  useEffect(() => {
    if (!projectId || !firestoreEnabled || !db) {
      setLiveTransactions(null);
      setTransactionsFetchState('ready');
      return;
    }

    let isCancelled = false;
    setTransactionsFetchState('loading');
    const txQuery = query(
      collection(db, getOrgCollectionPath(orgId, 'transactions')),
      where('projectId', '==', projectId),
    );

    void getDocs(txQuery)
      .then((snap) => {
        if (isCancelled) return;
        setLiveTransactions(snap.docs.map((doc) => doc.data() as Transaction));
        setTransactionsFetchState('ready');
      })
      .catch((err) => {
        if (isCancelled) return;
        console.error('[PortalPayrollPage] transactions fetch error:', err);
        toast.error('인건비 지급용 거래 내역을 불러오지 못했습니다');
        setLiveTransactions(null);
        setTransactionsFetchState('error');
      });

    return () => {
      isCancelled = true;
    };
  }, [db, firestoreEnabled, orgId, projectId]);

  useEffect(() => {
    if (!run || !reviewState) return;
    if (payrollReviewSnapshotMatches(run, reviewState)) return;

    void savePayrollReview({
      runId: run.id,
      ...toPayrollReviewSnapshot(reviewState),
    }).catch((err) => {
      console.error('[PortalPayrollPage] payroll review sync error:', err);
    });
  }, [reviewState, run, savePayrollReview]);

  async function onSave() {
    if (!projectId) return;
    if (!Number.isFinite(day) || day < 1 || day > 31) {
      toast.error('지급일은 1-31 사이여야 합니다');
      return;
    }
    try {
      await upsertSchedule({ projectId, dayOfMonth: day, active: true });
      toast.success('인건비 지급일을 저장했습니다');
    } catch (err: any) {
      console.error(err);
      toast.error(err?.message || '저장에 실패했습니다');
    }
  }

  async function onAckPayroll() {
    if (!run) return;
    try {
      await acknowledgePayrollRun(run.id);
      toast.success('공지 확인이 기록되었습니다');
    } catch (err: any) {
      console.error(err);
      toast.error(err?.message || '확인 처리에 실패했습니다');
    }
  }

  async function onDecideCandidate(txId: string, decision: PayrollCandidateReviewDecision) {
    if (!run || !reviewState || !portalUser) return;
    const now = new Date().toISOString();
    const nextCandidates = reviewState.reviewCandidates.map((candidate) => (
      candidate.txId === txId
        ? {
            ...candidate,
            decision,
            decidedAt: now,
            decidedByUid: portalUser.id,
            decidedByName: portalUser.name,
          }
        : candidate
    ));
    const nextReview = resolvePayrollRunReview({
      run: {
        ...run,
        reviewCandidates: nextCandidates,
      },
      transactions: projectTransactions,
      today,
    });

    setDecisionSavingTxId(txId);
    try {
      await savePayrollReview({
        runId: run.id,
        ...toPayrollReviewSnapshot(nextReview),
      });
      toast.success('인건비 적요 판단을 저장했습니다');
    } catch (err: any) {
      console.error(err);
      toast.error(err?.message || '판단 저장에 실패했습니다');
    } finally {
      setDecisionSavingTxId(null);
    }
  }

  async function onSavePmExpectedAmount() {
    if (!run) return;
    const normalized = pmAmountInput.replace(/[^0-9]/g, '');
    const amount = normalized ? Number.parseInt(normalized, 10) : null;
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      toast.error('인건비 금액은 0원 이상이어야 합니다');
      return;
    }
    try {
      await savePayrollExpectedAmount({
        runId: run.id,
        pmExpectedPayrollAmount: amount,
      });
      toast.success(amount === null ? 'PM 입력 금액을 비웠습니다' : 'PM 입력 금액을 저장했습니다');
    } catch (err: any) {
      console.error(err);
      toast.error(err?.message || 'PM 입력 금액 저장에 실패했습니다');
    }
  }

  return (
    <div className="space-y-5">
      {needsPayrollAck && (
        <Card className="border-rose-200/60 dark:border-rose-800/40 bg-rose-50/50 dark:bg-rose-950/10">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-[12px]" style={{ fontWeight: 700 }}>확인이 필요한 공지가 있습니다</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  지급 예정 공지를 확인해 주세요. Admin이 확인 여부를 추적합니다.
                </p>
              </div>
            </div>

            {needsPayrollAck && run && (
              <div className="p-3 rounded-lg bg-background border border-rose-200/50 dark:border-rose-800/40">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[12px]" style={{ fontWeight: 700 }}>
                      인건비 지급 예정: {run.plannedPayDate}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      공지일: {run.noticeDate} (3영업일 전)
                    </p>
                  </div>
                  <Button size="sm" className="h-8 text-[12px] gap-1.5" onClick={onAckPayroll}>
                    <CheckCircle2 className="w-3.5 h-3.5" /> 확인했습니다
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {run && transactionsFetchState === 'loading' && (
        <Card data-testid="portal-payroll-review-loading" className="border-border/60 shadow-sm">
          <CardContent className="p-4">
            <p className="text-[13px] text-foreground" style={{ fontWeight: 700 }}>인건비 적요 검토</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              거래 후보를 불러오는 중입니다. 로딩이 끝나면 PM 1차 검토 카드가 열립니다.
            </p>
          </CardContent>
        </Card>
      )}

      {run && transactionsFetchState === 'error' && (
        <Card data-testid="portal-payroll-review-fetch-error" className="border-rose-200/60 bg-rose-50/50 shadow-sm">
          <CardContent className="p-4">
            <p className="text-[13px] text-foreground" style={{ fontWeight: 700 }}>인건비 적요 검토</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              거래 후보를 불러오지 못해 아직 인건비 판단을 저장하지 않았습니다. 잠시 후 다시 시도해 주세요.
            </p>
          </CardContent>
        </Card>
      )}

      {run && reviewState && (
        <Card data-testid="portal-payroll-review-console" className="border-border/60 shadow-sm">
          <CardContent className="p-4 space-y-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <SearchCheck className="w-4 h-4 text-teal-600" />
                  <p className="text-[13px] text-foreground" style={{ fontWeight: 700 }}>인건비 적요 검토</p>
                  <Badge variant="outline" className="text-[10px]">PM 1차 검토</Badge>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  시스템이 먼저 인건비 의심 거래를 잡고, PM이 통장 적요를 보고 맞음/아님/보류를 판단합니다.
                </p>
              </div>
            </div>

            <div className={`rounded-xl border px-4 py-3 ${
              reviewState.paidStatus === 'CONFIRMED'
                ? 'border-emerald-200/70 bg-emerald-50/70'
                : reviewState.hasMissingCandidate
                ? 'border-rose-200/70 bg-rose-50/70'
                : reviewState.needsAdminConfirm
                  ? 'border-emerald-200/70 bg-emerald-50/70'
                  : 'border-amber-200/70 bg-amber-50/70'
            }`}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={`text-[10px] ${
                  reviewState.paidStatus === 'CONFIRMED' || reviewState.needsAdminConfirm
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : getPayrollReviewStatusTone(reviewState.pmReviewStatus)
                }`}>
                  {reviewStatusLabel}
                </Badge>
                <Badge variant="outline" className="border-white/70 bg-white/80 text-[10px] text-slate-700">
                  지급 창 {reviewState.windowStart} ~ {reviewState.windowEnd}
                </Badge>
              </div>
              <p className="mt-2 text-[13px] text-foreground" style={{ fontWeight: 700 }}>
                {reviewState.paidStatus === 'CONFIRMED'
                  ? '이번 달 인건비 지급이 최종 확정되었습니다'
                  : reviewState.hasMissingCandidate
                  ? '이번 달에는 인건비 후보를 찾지 못했습니다'
                  : reviewState.needsAdminConfirm
                    ? 'PM 판단이 끝났고 이제 Admin 최종 확정만 남았습니다'
                    : reviewState.pendingDecisionCount > 0
                      ? `지금 ${reviewState.pendingDecisionCount}건을 판단해 주세요`
                      : 'PM 판단이 저장되었습니다'}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {reviewState.paidStatus === 'CONFIRMED'
                  ? 'PM 판단과 Admin 확정이 모두 끝났습니다. 다음 지급 창 전까지는 기준 지급액과 통장 흐름만 점검하면 됩니다.'
                  : reviewState.hasMissingCandidate
                  ? '후보 없음은 정상 종료가 아닙니다. 통장내역을 직접 보고 적요를 확인한 뒤 Admin에 알려 주세요.'
                  : reviewState.needsAdminConfirm
                    ? '거래 단위 판단은 끝났습니다. Admin이 월 지급 여부를 최종 확정할 때까지 상태를 유지합니다.'
                  : '원본 적요를 보고 맞음, 아님, 보류 중 하나로 닫아 주세요. 미판단이나 보류가 남아 있으면 Admin이 확정할 수 없습니다.'}
              </p>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-4 space-y-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div className="space-y-1">
                  <p className="text-[12px] text-foreground" style={{ fontWeight: 700 }}>이번 달 금액 대조</p>
                  <p className="text-[11px] text-muted-foreground">
                    PM 입력 금액과 캐시플로 Projection을 plannedPayDate 기준 주차로 비교합니다.
                  </p>
                </div>
                <div className="flex items-end gap-2">
                  <div className="space-y-1">
                    <Label className="text-[11px]">PM 입력 금액</Label>
                    <Input
                      className="h-9 w-[160px] text-[12px]"
                      inputMode="numeric"
                      value={pmAmountInput}
                      placeholder="예: 3100000"
                      onChange={(event) => setPmAmountInput(event.target.value.replace(/[^0-9]/g, '').slice(0, 12))}
                    />
                  </div>
                  <Button size="sm" className="h-9 text-[12px]" onClick={onSavePmExpectedAmount}>
                    저장
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-3 text-[11px]">
                <div className="rounded-lg border border-border/60 bg-background px-3 py-2.5">
                  <p className="text-muted-foreground">PM 입력 금액</p>
                  <p className="mt-1 text-foreground" style={{ fontWeight: 700 }}>
                    {cashflowAlignment?.pmExpectedPayrollAmount !== null && cashflowAlignment?.pmExpectedPayrollAmount !== undefined
                      ? `${fmtShort(cashflowAlignment.pmExpectedPayrollAmount)}원`
                      : '-'}
                  </p>
                </div>
                <div className="rounded-lg border border-border/60 bg-background px-3 py-2.5">
                  <p className="text-muted-foreground">캐시플로 Projection</p>
                  <p className="mt-1 text-foreground" style={{ fontWeight: 700 }}>
                    {cashflowAlignment?.cashflowProjectedPayrollAmount !== null && cashflowAlignment?.cashflowProjectedPayrollAmount !== undefined
                      ? `${fmtShort(cashflowAlignment.cashflowProjectedPayrollAmount)}원`
                      : '-'}
                  </p>
                </div>
                <div className="rounded-lg border border-border/60 bg-background px-3 py-2.5">
                  <p className="text-muted-foreground">참조 주차</p>
                  <p className="mt-1 text-foreground" style={{ fontWeight: 700 }}>
                    {cashflowAlignment?.referenceWeek ? cashflowAlignment.referenceWeek.weekLabel : '-'}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {cashflowAlignment?.referenceWeek
                      ? `${cashflowAlignment.referenceWeek.weekStart} ~ ${cashflowAlignment.referenceWeek.weekEnd}`
                      : 'plannedPayDate 기준 주차를 찾지 못했습니다.'}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className={`text-[10px] ${
                  cashflowAlignment?.flags.includes('amount_mismatch')
                    ? 'border-rose-200 bg-rose-50 text-rose-700'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                }`}>
                  금액 불일치 {cashflowAlignment?.flags.includes('amount_mismatch') ? '있음' : '없음'}
                </Badge>
                <Badge variant="outline" className={`text-[10px] ${
                  activeQueueItem?.projectionBalanceInsufficient
                    ? 'border-rose-200 bg-rose-50 text-rose-700'
                    : 'border-slate-200 bg-slate-50 text-slate-700'
                }`}>
                  Projection 기준 잔액 {activeQueueItem?.projectionBalanceInsufficient ? '부족' : '정상'}
                </Badge>
                <Badge variant="outline" className={`text-[10px] ${
                  activeQueueItem?.pmBalanceInsufficient
                    ? 'border-rose-200 bg-rose-50 text-rose-700'
                    : 'border-slate-200 bg-slate-50 text-slate-700'
                }`}>
                  PM 기준 잔액 {activeQueueItem?.pmBalanceInsufficient ? '부족' : '정상'}
                </Badge>
              </div>

              {(cashflowAlignment?.flags.includes('pm_amount_missing')
                || cashflowAlignment?.flags.includes('cashflow_projection_missing')
                || cashflowAlignment?.flags.includes('amount_mismatch')
                || activeQueueItem?.projectionBalanceInsufficient
                || activeQueueItem?.pmBalanceInsufficient) && (
                <div className="rounded-xl border border-rose-200/70 bg-rose-50/70 px-4 py-3">
                  <p className="text-[12px] text-rose-900" style={{ fontWeight: 700 }}>금액 대조 경고</p>
                  <div className="mt-2 space-y-1 text-[11px] text-rose-800/80">
                    {cashflowAlignment?.flags.includes('pm_amount_missing') && (
                      <p>PM 입력 금액이 아직 없습니다. 이번 달 지급 금액을 먼저 입력해 주세요.</p>
                    )}
                    {cashflowAlignment?.flags.includes('cashflow_projection_missing') && (
                      <p>캐시플로 Projection에서 MYSC 인건비 금액을 찾지 못했습니다.</p>
                    )}
                    {cashflowAlignment?.flags.includes('amount_mismatch') && (
                      <p>금액 불일치: PM 입력 금액과 캐시플로 Projection 금액이 다릅니다.</p>
                    )}
                    {activeQueueItem?.projectionBalanceInsufficient && (
                      <p>Projection 기준 잔액이 부족합니다. Admin과 PM에게 동시에 경고됩니다.</p>
                    )}
                    {activeQueueItem?.pmBalanceInsufficient && (
                      <p>PM 기준 잔액이 부족합니다. 입력한 지급 금액으로는 현재 잔액이 모자랍니다.</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px] md:grid-cols-4">
                <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                  <p className="text-muted-foreground">후보</p>
                  <p className="mt-1 text-foreground" style={{ fontWeight: 700 }}>{reviewState.candidateCount}건</p>
                </div>
                <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                  <p className="text-muted-foreground">남은 판단</p>
                  <p className="mt-1 text-foreground" style={{ fontWeight: 700 }}>{reviewState.pendingDecisionCount}건</p>
                </div>
                <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                  <p className="text-muted-foreground">인건비 판단</p>
                  <p className="mt-1 text-foreground" style={{ fontWeight: 700 }}>{reviewState.payrollDecisionCount}건</p>
                </div>
                <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                  <p className="text-muted-foreground">지급 상태</p>
                  <div className="mt-1">
                    <Badge className={`text-[10px] ${getPayrollPaidStatusTone(reviewState.paidStatus)}`}>
                      {getPayrollPaidStatusLabel(reviewState.paidStatus)}
                    </Badge>
                  </div>
                </div>
            </div>

            {reviewState.hasMissingCandidate && (
              <div className="rounded-xl border border-rose-200/70 bg-rose-50/70 px-4 py-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 text-rose-600" />
                  <div className="min-w-0">
                    <p className="text-[12px] text-rose-900" style={{ fontWeight: 700 }}>이번 달 인건비 후보가 없습니다</p>
                    <p className="mt-1 text-[11px] text-rose-800/80">
                      후보 없음은 정상 종료가 아니라 이상 신호입니다. 통장내역에서 적요를 직접 확인한 뒤 Admin에 알려 주세요.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {reviewState.needsAdminConfirm && (
              <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/70 px-4 py-3">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" />
                  <div className="min-w-0">
                    <p className="text-[12px] text-emerald-900" style={{ fontWeight: 700 }}>Admin 최종 확정 대기</p>
                    <p className="mt-1 text-[11px] text-emerald-800/80">
                      PM 1차 검토가 끝났습니다. 이제 Admin이 월 지급 확정만 하면 됩니다.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {reviewRows.length === 0 ? (
              <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-4 text-[12px] text-muted-foreground">
                <div className="flex items-start gap-2">
                  <CircleHelp className="mt-0.5 h-4 w-4" />
                  <div className="min-w-0">
                    <p className="text-foreground" style={{ fontWeight: 700 }}>검토할 후보가 아직 없습니다</p>
                    <p className="mt-1">
                      지급 창 안에서는 통장 적요를 직접 확인해야 합니다. 통장내역을 열어 월 급여/인건비 지급 흔적을 먼저 점검해 주세요.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {reviewRows.map(({ candidate, tx }) => {
                  return (
                    <div key={candidate.txId} className="rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-[12px] text-foreground" style={{ fontWeight: 700 }}>
                              {tx?.counterparty || candidate.txId}
                            </p>
                            <Badge variant="outline" className={`text-[10px] ${getPayrollDecisionTone(candidate.decision)}`}>
                              {getPayrollDecisionLabel(candidate.decision)}
                            </Badge>
                            {candidate.signals.map((signal) => (
                              <Badge key={signal} variant="secondary" className="text-[10px]">
                                {signal.replace('cashflow:', '항목 ').replace('memo:', '메모 ').replace('counterparty:', '거래처 ')}
                              </Badge>
                            ))}
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {tx?.dateTime || '-'} · {tx ? `${fmtShort(tx.amounts.bankAmount)}원` : '-'}
                          </p>
                          <p className="text-[11px] text-foreground">
                            {tx?.memo?.trim() ? tx.memo : '적요 없음'}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            className={`h-8 text-[11px] ${
                              candidate.decision === 'PAYROLL'
                                ? 'bg-emerald-600 text-white hover:bg-emerald-600/90'
                                : ''
                            }`}
                            variant={candidate.decision === 'PAYROLL' ? 'default' : 'outline'}
                            disabled={decisionSavingTxId === candidate.txId}
                            onClick={() => onDecideCandidate(candidate.txId, 'PAYROLL')}
                          >
                            맞음
                          </Button>
                          <Button
                            size="sm"
                            className={`h-8 text-[11px] ${
                              candidate.decision === 'NOT_PAYROLL'
                                ? 'border-rose-600 bg-rose-600 text-white hover:bg-rose-600/90 hover:text-white'
                                : ''
                            }`}
                            variant={candidate.decision === 'NOT_PAYROLL' ? 'default' : 'outline'}
                            disabled={decisionSavingTxId === candidate.txId}
                            onClick={() => onDecideCandidate(candidate.txId, 'NOT_PAYROLL')}
                          >
                            아님
                          </Button>
                          <Button
                            size="sm"
                            className={`h-8 text-[11px] ${
                              candidate.decision === 'HOLD'
                                ? 'border-amber-500 bg-amber-500 text-white hover:bg-amber-500/90 hover:text-white'
                                : ''
                            }`}
                            variant={candidate.decision === 'HOLD' ? 'default' : 'outline'}
                            disabled={decisionSavingTxId === candidate.txId}
                            onClick={() => onDecideCandidate(candidate.txId, 'HOLD')}
                          >
                            보류
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" className="h-8 text-[11px] gap-1.5" onClick={() => navigate('/portal/weekly-expenses')}>
                사업비 입력(주간) 열기 <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <PortalPayrollLiquidityDetail
        item={activeQueueItem}
        onOpenWeeklyExpenses={() => navigate('/portal/weekly-expenses')}
      />

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-teal-600" />
            <p className="text-[13px]" style={{ fontWeight: 700 }}>인건비 지급일 등록</p>
            {schedule ? (
              <Badge className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">설정됨</Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">미설정</Badge>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-1">
              <Label className="text-[11px]">매월 지급일 (1-31)</Label>
              <Input
                className="mt-1 h-9 text-[12px]"
                inputMode="numeric"
                value={dayInput}
                placeholder="예: 25"
                onChange={(e) => setDayInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))}
              />
            </div>
            <div className="md:col-span-2">
              <div className="p-3 rounded-lg bg-muted/30 border border-border/50 h-full">
                <div className="flex items-start gap-2">
                  <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-[11px]" style={{ fontWeight: 600 }}>미리보기 ({yearMonth})</p>
                    {preview ? (
                      <div className="text-[11px] text-muted-foreground mt-1 space-y-1">
                        <p>지급 예정일: <span className="text-foreground" style={{ fontWeight: 700 }}>{preview.planned}</span></p>
                        <p>공지 시작일: <span className="text-foreground" style={{ fontWeight: 700 }}>{preview.notice}</span> (3영업일 전)</p>
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground mt-1">지급일을 입력하면 자동 계산됩니다.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button size="sm" className="h-9 text-[12px] gap-1.5" onClick={onSave} disabled={!projectId}>
              <CircleDollarSign className="w-4 h-4" /> 저장
            </Button>
          </div>
        </CardContent>
      </Card>

      {run && (
        <Card>
          <CardContent className="p-4">
            <p className="text-[13px]" style={{ fontWeight: 700 }}>이번달 인건비 상태</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-[11px]">
              <div className="p-3 rounded-lg bg-muted/30 border border-border/50">
                <p className="text-muted-foreground">지급 예정일</p>
                <p style={{ fontWeight: 800 }} className="mt-1">{run.plannedPayDate}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/30 border border-border/50">
                <p className="text-muted-foreground">공지일</p>
                <p style={{ fontWeight: 800 }} className="mt-1">{run.noticeDate}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/30 border border-border/50">
                <p className="text-muted-foreground">내 확인</p>
                <p style={{ fontWeight: 800 }} className="mt-1">{run.acknowledged ? '확인' : '미확인'}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/30 border border-border/50">
                <p className="text-muted-foreground">지급 상태</p>
                <div className="mt-1">
                  <Badge className={`text-[10px] ${getPayrollPaidStatusTone(run.paidStatus)}`}>
                    {getPayrollPaidStatusLabel(run.paidStatus)}
                  </Badge>
                </div>
              </div>
            </div>
            {!activeQueueItem && (
              <p className="mt-3 text-[11px] text-muted-foreground">
                현재는 지급 창 바깥입니다. 지급일 3일 전부터 이 화면에 잔액 strip과 위험 상태가 자동으로 열립니다.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const PAYROLL_STATUS_STYLES: Record<PayrollLiquidityQueueItem['status'], string> = {
  insufficient_balance: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  payment_unconfirmed: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  baseline_missing: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  balance_unknown: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  clear: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
};

function payrollStatusLabel(status: PayrollLiquidityQueueItem['status']) {
  if (status === 'insufficient_balance') return '잔액 부족 위험';
  if (status === 'payment_unconfirmed') return '지급 확인 필요';
  if (status === 'baseline_missing') return '기준 지급액 없음';
  if (status === 'balance_unknown') return '잔액 데이터 없음';
  return '이번 지급 창 안정';
}

function PortalPayrollLiquidityDetail({
  item,
  onOpenWeeklyExpenses,
}: {
  item: PayrollLiquidityQueueItem | null;
  onOpenWeeklyExpenses: () => void;
}) {
  if (!item) {
    return (
      <Card data-testid="portal-payroll-detail-empty">
        <CardContent className="p-4">
          <p className="text-[13px] text-foreground" style={{ fontWeight: 700 }}>
            이번 지급 창이 아직 열리지 않았습니다.
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            지급일 D-3부터 D+3까지 잔액 strip과 위험 경고가 자동으로 이 화면에 열립니다.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="portal-payroll-liquidity-detail">
      <CardContent className="p-4 space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Badge className={`text-[10px] ${PAYROLL_STATUS_STYLES[item.status]}`}>
                {payrollStatusLabel(item.status)}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                지급 창 {item.windowStart} ~ {item.windowEnd}
              </span>
            </div>
            <p className="text-[16px] text-foreground" style={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
              지급일 {item.plannedPayDate}
            </p>
            <p className="text-[11px] text-muted-foreground">{item.statusReason}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px] lg:min-w-[380px]">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
              <p className="text-muted-foreground">직전 확정 지급액</p>
              <p className="mt-1 text-foreground" style={{ fontWeight: 700 }}>
                {item.expectedPayrollAmount !== null ? `${fmtShort(item.expectedPayrollAmount)}원` : '-'}
              </p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
              <p className="text-muted-foreground">PM 입력 금액</p>
              <p className="mt-1 text-foreground" style={{ fontWeight: 700 }}>
                {item.pmExpectedPayrollAmount !== null ? `${fmtShort(item.pmExpectedPayrollAmount)}원` : '-'}
              </p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
              <p className="text-muted-foreground">캐시플로 Projection</p>
              <p className="mt-1 text-foreground" style={{ fontWeight: 700 }}>
                {item.cashflowProjectedPayrollAmount !== null ? `${fmtShort(item.cashflowProjectedPayrollAmount)}원` : '-'}
              </p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
              <p className="text-muted-foreground">현재 잔액</p>
              <p className="mt-1 text-foreground" style={{ fontWeight: 700 }}>
                {item.currentBalance !== null ? `${fmtShort(item.currentBalance)}원` : '-'}
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-[11px]">
          {item.projectionReferenceWeek && (
            <Badge variant="outline" className="text-[10px]">
              참조 주차 {item.projectionReferenceWeek.weekLabel} · {item.projectionReferenceWeek.weekStart} ~ {item.projectionReferenceWeek.weekEnd}
            </Badge>
          )}
          <Badge variant="outline" className={`text-[10px] ${item.amountMismatch ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
            금액 불일치 {item.amountMismatch ? '있음' : '없음'}
          </Badge>
          <Badge variant="outline" className={`text-[10px] ${item.projectionBalanceInsufficient ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
            Projection 기준 잔액 {item.projectionBalanceInsufficient ? '부족' : '정상'}
          </Badge>
          <Badge variant="outline" className={`text-[10px] ${item.pmBalanceInsufficient ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
            PM 기준 잔액 {item.pmBalanceInsufficient ? '부족' : '정상'}
          </Badge>
        </div>

        <div className="space-y-2">
          <p className="text-[12px] text-foreground" style={{ fontWeight: 700 }}>
            D-3 ~ D+3 잔액 strip
          </p>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
            {item.dayBalances.map((entry) => {
              const isRisk = item.expectedPayrollAmount !== null
                && entry.balance !== null
                && entry.balance < item.expectedPayrollAmount;
              return (
                <div
                  key={entry.date}
                  className={`rounded-xl border px-3 py-3 ${
                    isRisk
                      ? 'border-rose-200/70 bg-rose-50/70 dark:border-rose-900/40 dark:bg-rose-950/10'
                      : 'border-border/60 bg-muted/20'
                  }`}
                >
                  <p className="text-[10px] text-muted-foreground">{entry.date.slice(5)}</p>
                  <p className="mt-1 text-[12px] text-foreground" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {entry.balance !== null ? `${fmtShort(entry.balance)}원` : '-'}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="h-8 text-[11px] gap-1.5" onClick={onOpenWeeklyExpenses}>
            사업비 입력(주간) 열기 <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
