import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowDownToLine, CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck, ClipboardList, Columns2, FileSpreadsheet, Loader2, LockKeyhole, RefreshCw, Save, Undo2 } from 'lucide-react';
import { useBlocker, useNavigate } from 'react-router';
// 반영 결과는 화면을 닫아도 놓치지 않도록 우측 하단에 알린다.
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { CashflowLateSheetChangeDialog } from './CashflowLateSheetChangeDialog';
import { useCashflowWeeks } from '../../data/cashflow-weeks-store';
import {
  CASHFLOW_SHEET_LINE_LABELS,
  type OrgMember,
  type Project,
  type CashflowSheetLineId,
  type UserRole,
} from '../../data/types';
import { CASHFLOW_ALL_LINES, CASHFLOW_IN_LINES, CASHFLOW_OUT_LINES } from '../../platform/cashflow-sheet';
import { useAuth } from '../../data/auth-store';
import { useFirebase } from '../../lib/firebase-context';
import { getAuthInstance } from '../../lib/firebase';
import {
  resolveApiErrorMessage,
  resolveCashflowWeeklyCompletionErrorMessage,
} from '../../platform/api-error-message';
import { PlatformApiError } from '../../platform/api-client';
import { isRequestTimeoutError, reconcileMonthCloseRequestAfterTimeout } from '../../data/cashflow-month-close-request-reconcile';
import { resolveApiErrorPresentation, type ApiErrorPresentation } from '../../platform/api-error-messages';
import { recordDevtoolsLog, toDevtoolsError } from '../../platform/devtools-transaction-log';
import {
  fetchCashflowActivityViaBff,
  requestCashflowMonthCloseViaBff,
  withdrawCashflowMonthCloseRequestViaBff,
  saveCashflowMonthCloseApproverViaBff,
  completeCashflowWeeklyUpdateViaBff,
  confirmCashflowWeeklyUpdateViaBff,
  reopenCashflowWeeklyUpdateViaBff,
  decideCashflowMonthReopenViaBff,
  fetchCashflowMonthCloseViaBff,
  fetchCashflowWeeklyComplianceViaBff,
  requestCashflowMonthReopenViaBff,
  type CashflowMonthCloseCell,
  type CashflowMonthCloseDraftInput,
  type CashflowMonthCloseResult,
  type CashflowMonthCloseRequest,
  type CashflowMonthClosePresentation,
  type CashflowMonthClosePresentationWeek,
  type CashflowOperationsRate,
  type CashflowDeadlineSummary,
  type CashflowActivityEvent,
  type CashflowActivitySource,
  type CashflowWeeklyComplianceItem,
} from '../../lib/platform-bff-client';
import { getCashflowSettlementPeriodOrder, isYearMonth } from '../../platform/cashflow-weeks';
import { addMonthsToYearMonth } from '../../platform/business-days';
import { getCashflowModeLineLabel } from '../../platform/policies/cashflow-policy';
import { getSnappedWeekScrollLeft } from './cashflow-board-scroll';
import {
  applyCashflowSheetLabViaBff,
  cashflowFormulaMismatchesFromError,
  probeCashflowSheetFreshnessViaBff,
  getCashflowSheetLabApplyStatusViaBff,
  getCashflowSheetLabMirrorViaBff,
  getCashflowSheetLabShareAccountViaBff,
  isCashflowSheetApplyResultUncertain,
  refreshCashflowSheetLabMirrorViaBff,
  stageCashflowSheetLabViaBff,
  type CashflowSheetLabMirrorResult,
  type CashflowSheetFreshnessProbe,
  type CashflowSheetLabShareAccountResult,
  type CashflowSheetLabStageResult,
  type CashflowFormulaMismatch,
} from '../../lib/sheets-cashflow-readonly-client';
import {
  buildCashflowMonthCloseDraftInput,
  createEmptyCashflowMonthCloseDepositRows,
  isCashflowMonthCloseRequestForSelection,
  normalizeCashflowMonthCloseCells,
  shouldApplyCashflowMonthCloseRequestResult,
  shouldHideCashflowValuesAfterLoadError,
  type CashflowMonthCloseDepositReviewRow,
} from './cashflow-month-close';
import { CashflowSheetSyncOverlay } from './CashflowSheetSyncOverlay';
import { CashflowFormulaMismatchDialog } from './CashflowFormulaMismatchDialog';
import { CashflowCanonicalSummary } from './CashflowCanonicalSummary';
import { MemberPicker } from '../ui/member-picker';
import { buildOrgMemberPickerOptions } from '../../data/project-team-member-options';
import { usePersonRoster } from '../../data/use-person-roster';
import {
  cashflowActivitySourcesForMutations,
  createCashflowActivityRequestGuard,
  filterCashflowActivityErrorsAfterSuccess,
  shouldStartCashflowActivityLoad,
  takeCashflowActivityPendingWork,
  updateCashflowActivityCursorQueue,
  type CashflowActivityCursor,
  type CashflowActivityMutation,
} from './cashflow-activity-loader';
import { describeCashflowMonthCloseIssue } from './cashflow-month-close-blocker-helpers';
import { buildSheetApplyNotice } from './cashflow-sheet-apply-notice';
import { pickCashflowMonthCloseNotice } from './cashflow-month-close-notice';
import { CashflowScheduleBar } from './CashflowScheduleBar';
import { buildScheduleSteps, type ScheduleStep } from './cashflow-schedule-steps';

type CashflowOpsTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

function isSafeCashflowNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function fmt(n: unknown): string {
  return isSafeCashflowNumber(n) ? n.toLocaleString('ko-KR') : '확인 불가';
}

function formatCashflowAmount(value: unknown): string {
  return isSafeCashflowNumber(value) ? `${fmt(value)}원` : '확인 불가';
}

function formatCashflowCount(value: unknown, unit: '건' | '회'): string {
  return isSafeCashflowNumber(value) && value >= 0 ? `${fmt(value)}${unit}` : '확인 불가';
}

function formatCashflowStateAmount(state: string | undefined, value: unknown): string {
  if (state === 'EMPTY') return '미작성 (EMPTY)';
  return (state === 'VALUE' || state === 'ZERO') && isSafeCashflowNumber(value)
    ? `${formatCashflowAmount(value)} (${state})`
    : '확인 불가';
}

function fmtSigned(n: number): string {
  if (!isSafeCashflowNumber(n)) return '확인 불가';
  if (n === 0) return '0';
  return `${n > 0 ? '+' : '-'}${Math.abs(n).toLocaleString('ko-KR')}`;
}

function formatSheetAppliedAt(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

type WeeklyProjectionMissingCell = { yearMonth: string; weekNo: number; lineId: string };
type WeeklyProjectionValidation = { missingCells: WeeklyProjectionMissingCell[]; evidenceHash: string };

function weeklyProjectionValidation(error: unknown): WeeklyProjectionValidation | null {
  const details = (error as { body?: { details?: { missingCells?: unknown; evidenceHash?: unknown } } })?.body?.details;
  const missingCells = Array.isArray(details?.missingCells)
    ? details.missingCells.filter((cell): cell is WeeklyProjectionMissingCell => Boolean(
      cell && typeof cell === 'object'
      && /^20\d{2}-(0[1-9]|1[0-2])$/.test(String((cell as WeeklyProjectionMissingCell).yearMonth))
      && Number.isInteger(Number((cell as WeeklyProjectionMissingCell).weekNo))
      && typeof (cell as WeeklyProjectionMissingCell).lineId === 'string',
    ))
    : [];
  const evidenceHash = typeof details?.evidenceHash === 'string' ? details.evidenceHash : '';
  return missingCells.length > 0 && /^sha256:[a-f0-9]{64}$/.test(evidenceHash)
    ? { missingCells, evidenceHash }
    : null;
}

function decodeActivityActor(value?: string): string {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// 배경은 주간 정산 상태, 테두리는 월 결산 기한 초과. 둘은 다른 사실이라 다른 자리에 그린다.
function cashflowSurfaceClass(tone?: CashflowMonthClosePresentationWeek['surfaceTone'], overdue = false): string {
  const bg = tone === 'closed' ? 'bg-slate-200'
    : tone === 'danger' ? 'bg-red-100'
      : tone === 'warning' ? 'bg-yellow-50'
        : tone === 'success' ? 'bg-emerald-50'
          : tone === 'current' ? 'bg-[#EAF0F5]'
            : tone === 'unavailable' ? 'bg-red-50'
              : '';
  return overdue ? `${bg} ring-2 ring-inset ring-red-400`.trim() : bg;
}

type PortalTimelineTone = CashflowMonthClosePresentationWeek['surfaceTone'] | CashflowMonthClosePresentation['monthClose']['tone'];

type PortalTimelineNode = {
  key: string;
  kind: 'weekly' | 'monthly' | 'project-end';
  label: string;
  statusLabel: string;
  periodLabel?: string;
  tone: PortalTimelineTone;
  current: boolean;
};

function formatPortalTimelineDate(value?: string | null): string {
  const at = Date.parse(String(value || ''));
  if (!Number.isFinite(at)) return '확인 불가';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(at));
}

/*
 * 색은 같은 구역의 CashflowScheduleBar 와 한 팔레트다(DESIGN.md).
 * 완료 #17324D · 진행 #0176D3 · 초과 #e11d48 · 대기 회색. 타임라인이 자기만의
 * 색(갈색 amber 계열, 비브랜드 네이비)을 따로 가지면 한 화면에 디자인이 둘이 된다.
 */
function portalTimelineDotClass(tone: PortalTimelineTone): string {
  if (tone === 'closed' || tone === 'success') return 'border-[#17324D] bg-[#17324D] text-white';
  if (tone === 'danger') return 'border-red-600 bg-red-600 text-white';
  if (tone === 'warning') return 'border-[#17324D] bg-white text-[#17324D] ring-2 ring-[#17324D]/15';
  return 'border-slate-300 bg-white text-slate-400';
}

function portalTimelineTextClass(tone: PortalTimelineTone): string {
  if (tone === 'danger') return 'font-semibold text-red-700';
  // 완료는 점(✓)이 이미 말한다. 글자까지 색을 더하지 않는다.
  if (tone === 'closed' || tone === 'success') return 'font-semibold text-slate-700';
  if (tone === 'warning') return 'font-semibold text-[#17324D]';
  return 'text-slate-500';
}

function portalTimelineConnectorClass(tone: PortalTimelineTone): string {
  if (tone === 'closed' || tone === 'success') return 'bg-[#17324D]/25';
  if (tone === 'danger') return 'bg-red-300';
  if (tone === 'warning') return 'bg-[#17324D]/25';
  return 'bg-slate-200';
}

function portalScheduleStepStateLabel(state: ScheduleStep['state']): string {
  if (state === 'done') return '완료';
  if (state === 'done_late') return '완료 · 기한 초과';
  if (state === 'overdue') return '기한 초과';
  if (state === 'current') return '진행 중';
  return '대기';
}

function portalScheduleStepClass(state: ScheduleStep['state'], suppressOverdue = false): string {
  if (state === 'done') return 'text-slate-700';
  if (state === 'done_late' || state === 'overdue') return suppressOverdue ? 'text-slate-500' : 'text-red-700';
  if (state === 'current') return 'text-[#17324D]';
  return 'text-slate-400';
}

function logCashflowSettlement(input: {
  phase: 'start' | 'success' | 'error' | 'info';
  operation: string;
  projectId: string;
  yearMonth?: string;
  weekNo?: number;
  durationMs?: number;
  summary?: Record<string, unknown>;
  error?: unknown;
}): void {
  recordDevtoolsLog({
    kind: 'cashflow_transaction',
    phase: input.phase,
    operation: input.operation,
    transport: 'bff',
    projectId: input.projectId,
    yearMonth: input.yearMonth,
    weekNo: input.weekNo,
    durationMs: input.durationMs,
    summary: input.summary,
    ...(input.error ? { error: toDevtoolsError(input.error) } : {}),
  });
}

type CashflowEvent = CashflowActivityEvent & { revertedAt?: string };
type CashflowSheetDashboardMetadata = NonNullable<NonNullable<CashflowSheetLabMirrorResult['sheetFacts']>['metadata']>;
type CashflowMonthCloseMutationOperation = 'approver' | 'request' | 'withdraw' | 'reopen';
type CashflowMonthCloseMutationScope = {
  operation: CashflowMonthCloseMutationOperation;
  generation: number;
  projectId: string;
  yearMonth: string;
};
type CashflowMonthCloseMutationIdentity = { projectId?: string; yearMonth?: string };
const CASHFLOW_ACTIVITY_SOURCE_LABELS: Record<CashflowActivitySource, string> = {
  legacy: '일반 변경',
  sheet_refresh: '시트 불러오기',
  audit: '시트 반영·월 결산',
};

function mergeCashflowEvents(current: CashflowEvent[], incoming: CashflowActivityEvent[]): CashflowEvent[] {
  const events = new Map(current.map((event) => [event.id, event]));
  incoming.forEach((event) => events.set(event.id, event));
  return [...events.values()]
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function HoverExplain({
  children,
  message,
}: {
  children: ReactNode;
  message: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-pointer underline decoration-dotted underline-offset-2">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px] text-[12px] leading-relaxed">
        {message}
      </TooltipContent>
    </Tooltip>
  );
}

function renderCashflowLineLabel(label: string): ReactNode {
  const parenIndex = label.indexOf('(');
  if (parenIndex < 0) return label;
  const main = label.slice(0, parenIndex).trim();
  const detail = label.slice(parenIndex).trim();
  return (
    <>
      <span className="block">{main}</span>
      <span className="block text-[12px] font-normal leading-4 text-slate-500">{detail}</span>
    </>
  );
}

function isBffAuthRejection(error: unknown): boolean {
  const source = error as { status?: number; body?: { code?: string; error?: string } };
  const code = bffErrorCode(error);
  return source.status === 401
    || source.status === 403
    || code === 'missing_bearer_token'
    || code === 'invalid_token';
}

function bffErrorCode(error: unknown): string {
  const source = error as { body?: { code?: string; error?: string } };
  return source.body?.code || source.body?.error || '';
}

/*
 * 시트 검토·반영에서 화면이 다루지 않는 오류의 문구.
 *
 * 이 두 흐름은 실패해도 아무것도 띄우지 않고 끝나는 자리가 여럿이었다. 사람 눈에는
 * 버튼만 원래대로 돌아오니 반영이 된 줄 안다(실제 신고: "로직이 중도에 끝나는 느낌이고
 * 토스트도 안 뜬다"). 문구는 서버 코드에 대한 공용 안내를 그대로 쓴다 - 여기서 새로 짓지 않는다.
 * 이 화면의 오류는 토스트가 아니라 그 자리 인라인 배너로 남긴다(2026-08-19 결정).
 */
function sheetOperationErrorMessage(error: unknown): string {
  const status = error instanceof PlatformApiError
    ? error.status
    : Number((error as { status?: number })?.status) || 400;
  const code = error instanceof PlatformApiError ? error.code : bffErrorCode(error);
  return resolveApiErrorPresentation(code, status).guide;
}

export function CashflowProjectSheet({
  projectId,
  projectName,
  project,
  members,
  onExecutiveApproverSaved,
  roleOverride,
  portalMode = false,
  compact = false,
}: {
  projectId: string;
  projectName?: string;
  project?: Project | null;
  members?: OrgMember[];
  onExecutiveApproverSaved?: (result: {
    executiveApproverId: string;
    executiveApproverName: string;
    executiveApproverEmail: string;
    version: number;
    updatedAt: string;
  }) => void;
  roleOverride?: UserRole | string;
  portalMode?: boolean;
  compact?: boolean;
  initialViewMode?: 'projection' | 'actual' | 'compare';
  onUpdateWeeklySubmissionStatus?: (input: {
    projectId: string;
    yearMonth: string;
    weekNo: number;
    projectionEdited?: boolean;
    projectionUpdated?: boolean;
    expenseEdited?: boolean;
    expenseUpdated?: boolean;
  }) => Promise<void>;
}) {
  const { user } = useAuth();
  const { orgId } = useFirebase();
  const navigate = useNavigate();
  const role = (roleOverride || user?.role || '').toString().toLowerCase() as UserRole | '';
  const bffActor = useMemo(() => ({
    uid: user?.uid || 'cashflow-user',
    email: user?.email || '',
    role: role || user?.role || 'workspace_user',
    idToken: user?.idToken,
    googleAccessToken: user?.googleAccessToken,
  }), [
    role,
    user?.email,
    user?.googleAccessToken,
    user?.idToken,
    user?.role,
    user?.uid,
  ]);
  const latestBffActorRef = useRef(bffActor);
  useEffect(() => {
    latestBffActorRef.current = bffActor;
  }, [bffActor]);
  const resolveBffActor = useCallback(async (options: { forceRefresh?: boolean } = {}) => {
    const currentActor = latestBffActorRef.current;
    const firebaseAuthUser = getAuthInstance()?.currentUser;
    const firebaseToken = await firebaseAuthUser?.getIdToken(Boolean(options.forceRefresh)).catch(() => undefined);
    const nextToken = firebaseToken || currentActor.idToken;
    if (!nextToken) return null;
    return {
      ...currentActor,
      idToken: nextToken,
    };
  }, []);

  const {
    yearMonth,
    setYearMonth,
  } = useCashflowWeeks();

  const [cashflowSheetConfig, setCashflowSheetConfig] = useState<{
    sourceYear?: number;
    value?: string;
    sheetName?: string;
    spreadsheetId?: string;
    spreadsheetTitle?: string;
    startWeek?: string;
    endWeek?: string;
    lastAppliedAt?: string;
    lastAppliedBy?: { uid?: string; email?: string; role?: string } | null;
    lastAppliedLineCount?: number;
    lastProjectionLineCount?: number;
    lastActualLineCount?: number;
  } | null>(null);
  const [cashflowSheetConfigLoaded, setCashflowSheetConfigLoaded] = useState(false);
  const [cashflowSheetFreshness, setCashflowSheetFreshness] = useState<CashflowSheetFreshnessProbe | null>(null);
  const [cashflowSystemAccountEmail, setCashflowSystemAccountEmail] = useState('');
  const [cashflowSystemAccountError, setCashflowSystemAccountError] = useState(false);
  const [cashflowSheetMirror, setCashflowSheetMirror] = useState<CashflowSheetLabMirrorResult | null>(null);
  const [loadedMonthCloseResult, setMonthCloseResult] = useState<CashflowMonthCloseResult | null>(null);
  const monthCloseResult = isCashflowMonthCloseRequestForSelection(
    loadedMonthCloseResult,
    projectId,
    yearMonth,
  ) ? loadedMonthCloseResult : null;
  const cashflowPresentation = monthCloseResult?.presentation;
  const monthCloseRequest = monthCloseResult?.monthState || null;
  const monthCloseActions = monthCloseResult?.actions;
  const monthCloseCycle = monthCloseResult?.settlementCycle;
  const monthCloseTargetYearMonth = isYearMonth(yearMonth)
    && isYearMonth(monthCloseResult?.targetYearMonth)
    && monthCloseCycle?.cycleYearMonth === yearMonth
    && monthCloseCycle.monthCloseTargetYearMonth === monthCloseResult.targetYearMonth
    && monthCloseResult.targetYearMonth === addMonthsToYearMonth(yearMonth, -1)
    ? monthCloseResult.targetYearMonth
    : '';
  const canApproveReopen = monthCloseCycle?.commandCapabilities.APPROVE_MONTH_REOPEN.allowed === true;
  const canRejectReopen = monthCloseCycle?.commandCapabilities.REJECT_MONTH_REOPEN.allowed === true;
  const canReviewReopen = canApproveReopen || canRejectReopen;
  const [monthCloseLoading, setMonthCloseLoading] = useState(false);
  // 화면 열 때 요청 12개가 동시에 나가면 Vercel 인스턴스가 늘어나는 동안 제일 중요한 month-close 가
  // 제일 늦게 끝났다(2026-08-19, 2.6초 vs 7.8초). 첫 화면은 config + month-close 둘로 그리고,
  // 나머지는 그 뒤(보조 정보) 또는 보일 때(이력·명부)만 읽는다. 데이터·자리는 그대로, 순서만 바뀐다.
  const [monthCloseSettled, setMonthCloseSettled] = useState(false);
  const [monthCloseError, setMonthCloseError] = useState<string | null>(null);
  const [monthCloseErrorPresentation, setMonthCloseErrorPresentation] = useState<(ApiErrorPresentation & {
    code: string;
    requestId: string;
  }) | null>(null);
  const [monthCloseBusy, setMonthCloseBusy] = useState(false);
  const [selectedExecutiveApproverId, setSelectedExecutiveApproverId] = useState(project?.executiveApproverId || '');
  const [savedExecutiveApproverId, setSavedExecutiveApproverId] = useState(project?.executiveApproverId || '');
  const [executiveApproverBusy, setExecutiveApproverBusy] = useState(false);
  const [executiveApproverAttention, setExecutiveApproverAttention] = useState(false);
  const [weeklyCompletionBusy, setWeeklyCompletionBusy] = useState(false);
  const [weeklyCompletionOpen, setWeeklyCompletionOpen] = useState(false);
  const [weeklyUpdateResult, setWeeklyUpdateResult] = useState<'CHANGED' | 'NO_CHANGES' | ''>('');
  const [weeklyCompletionError, setWeeklyCompletionError] = useState('');
  const [weeklyWithdrawBusy, setWeeklyWithdrawBusy] = useState(false);
  // 조직장이 확정한 주를 되돌릴 때만 사유를 받는다. 완료 요청 회수는 사유가 필요 없다.
  const [weeklyReopenReasonOpen, setWeeklyReopenReasonOpen] = useState(false);
  const [weeklyReopenReason, setWeeklyReopenReason] = useState('');
  const [weeklyWithdrawError, setWeeklyWithdrawError] = useState('');
  const [weeklyConfirmBusy, setWeeklyConfirmBusy] = useState(false);
  // 완료 요청·회수·확정이 실제로 접수됐다는 확인. 상태 배지만으로는 "내가 누른 것이 먹혔는지" 가 안 보인다.
  const [weeklyActionNotice, setWeeklyActionNotice] = useState('');
  const [weeklyProjectionWarning, setWeeklyProjectionWarning] = useState<WeeklyProjectionValidation | null>(null);
  const [weeklyHistoryOpen, setWeeklyHistoryOpen] = useState(false);
  const [weeklyComplianceHistory, setWeeklyComplianceHistory] = useState<CashflowWeeklyComplianceItem[]>([]);
  const [weeklyComplianceHistoryLoading, setWeeklyComplianceHistoryLoading] = useState(false);
  const [weeklyComplianceHistoryError, setWeeklyComplianceHistoryError] = useState('');
  const [weeklyComplianceNextCursor, setWeeklyComplianceNextCursor] = useState('');
  const [weeklyCompliancePageCount, setWeeklyCompliancePageCount] = useState(0);
  const [monthCloseReviewOpen, setMonthCloseReviewOpen] = useState(false);
  const [monthCloseHumanReviewed, setMonthCloseHumanReviewed] = useState(false);
  const [monthCloseDepositRows, setMonthCloseDepositRows] = useState<CashflowMonthCloseDepositReviewRow[]>(
    () => createEmptyCashflowMonthCloseDepositRows(),
  );
  const [monthCloseReviewDirty, setMonthCloseReviewDirty] = useState(false);
  const [monthCloseWithdrawOpen, setMonthCloseWithdrawOpen] = useState(false);
  const [monthCloseWithdrawReason, setMonthCloseWithdrawReason] = useState('');
  const [reopenAction, setReopenAction] = useState<'request' | 'approve' | 'reject' | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [sheetRefreshLoading, setSheetRefreshLoading] = useState(false);
  // 시트 검토·반영이 실패한 이유. 성공만 토스트로 알리고 오류는 그 자리에 남긴다.
  const [sheetOperationError, setSheetOperationError] = useState('');
  const [sheetReviewDialogOpen, setSheetReviewDialogOpen] = useState(false);
  const [lateSheetApply, setLateSheetApply] = useState<CashflowSheetLabStageResult | null>(null);
  const [sheetApplyResumeRequired, setSheetApplyResumeRequired] = useState(false);
  const [lateSheetResumeReason, setLateSheetResumeReason] = useState('');
  const [lateSheetFormulaAccepted, setLateSheetFormulaAccepted] = useState(false);
  const [lateSheetPendingApprovalAccepted, setLateSheetPendingApprovalAccepted] = useState(false);
  const [formulaMismatchPrompt, setFormulaMismatchPrompt] = useState<{
    stage: CashflowSheetLabStageResult;
    issues: CashflowFormulaMismatch[];
    closedMonthChangeReason: string;
    acceptPendingApprovalDifferences: boolean;
  } | null>(null);
  const [pendingApprovalStage, setPendingApprovalStage] = useState<CashflowSheetLabStageResult | null>(null);
  const [pendingApprovalClosedMonthChangeReason, setPendingApprovalClosedMonthChangeReason] = useState('');
  const [pendingApprovalFormulaAccepted, setPendingApprovalFormulaAccepted] = useState(false);
  const [sheetStageApplyLoading, setSheetStageApplyLoading] = useState(false);
  // 조직장은 로그인해서 승인해야 하므로 계정이 필수지만, 명부에 없는 사람(퇴사 후 계정이
  // 남은 경우)은 후보에서 빠져야 한다. 명부는 문지기로만 쓴다.
  const approverRoster = usePersonRoster(monthCloseSettled);
  const executiveApproverOptions = useMemo(
    () => buildOrgMemberPickerOptions(members || [], approverRoster),
    [members, approverRoster],
  );

  useEffect(() => {
    const approverId = project?.executiveApproverId || '';
    setSelectedExecutiveApproverId(approverId);
    setSavedExecutiveApproverId(approverId);
  }, [project?.executiveApproverId, projectId]);
  const [cashflowEvents, setCashflowEvents] = useState<CashflowEvent[]>([]);
  const [cashflowEventErrors, setCashflowEventErrors] = useState<Array<{
    source: CashflowActivitySource;
    message: string;
    preservePagination?: boolean;
  }>>([]);
  const [cashflowEventLoading, setCashflowEventLoading] = useState(false);
  const [cashflowEventLoadingSources, setCashflowEventLoadingSources] = useState<CashflowActivitySource[]>([]);
  const [cashflowActivityCursorQueue, setCashflowActivityCursorQueue] = useState<CashflowActivityCursor[]>([]);
  const [cashflowEventLoadingMore, setCashflowEventLoadingMore] = useState(false);
  const cashflowEventLoadingMoreRef = useRef(false);
  const [cashflowActivityDrainVersion, setCashflowActivityDrainVersion] = useState(0);
  const [cashflowEventLoadError, setCashflowEventLoadError] = useState('');
  const cashflowActivityRequestGuardRef = useRef<ReturnType<typeof createCashflowActivityRequestGuard> | null>(null);
  if (!cashflowActivityRequestGuardRef.current) {
    cashflowActivityRequestGuardRef.current = createCashflowActivityRequestGuard();
  }
  const cashflowActivityRequestGuard = cashflowActivityRequestGuardRef.current;
  const activityScope = `${orgId}:${projectId}`;
  const cashflowActivityScopeRef = useRef(activityScope);
  cashflowActivityScopeRef.current = activityScope;
  const cashflowActivityOneClickRef = useRef({
    scope: activityScope,
    depth: 0,
    pendingAggregate: false,
    pendingSources: new Set<CashflowActivitySource>(),
  });
  if (cashflowActivityOneClickRef.current.scope !== activityScope) {
    cashflowActivityOneClickRef.current = {
      scope: activityScope,
      depth: 0,
      pendingAggregate: false,
      pendingSources: new Set<CashflowActivitySource>(),
    };
  }
  const opsTimelineRef = useRef<HTMLDivElement | null>(null);
  const [opsTimelineVisible, setOpsTimelineVisible] = useState(false);
  const opsTimelineVisibleRef = useRef(false);
  opsTimelineVisibleRef.current = opsTimelineVisible;
  const [cashflowEventQuery, setCashflowEventQuery] = useState('');
  const [cashflowEventMode, setCashflowEventMode] = useState('ALL');
  const [cashflowEventMonth, setCashflowEventMonth] = useState('ALL');
  const [revertingRunId, setRevertingRunId] = useState<string | null>(null);
  const monthCloseRequestGenerationRef = useRef(0);
  const monthCloseMutationGenerationRef = useRef<Record<CashflowMonthCloseMutationOperation, number>>({
    approver: 0,
    request: 0,
    withdraw: 0,
    reopen: 0,
  });
  const selectedProjectIdRef = useRef(projectId);
  const selectedOrgIdRef = useRef(orgId);
  const selectedYearMonthRef = useRef(yearMonth);
  selectedProjectIdRef.current = projectId;
  selectedOrgIdRef.current = orgId;
  selectedYearMonthRef.current = yearMonth;
  const captureMonthCloseMutationScope = useCallback((operation: CashflowMonthCloseMutationOperation): CashflowMonthCloseMutationScope => {
    const generation = monthCloseMutationGenerationRef.current[operation] + 1;
    monthCloseMutationGenerationRef.current[operation] = generation;
    return { operation, generation, projectId, yearMonth };
  }, [projectId, yearMonth]);
  const isCurrentMonthCloseMutation = useCallback((
    scope: CashflowMonthCloseMutationScope,
    response?: CashflowMonthCloseMutationIdentity | null,
  ): boolean => shouldApplyCashflowMonthCloseRequestResult({
    requestGeneration: scope.generation,
    currentGeneration: monthCloseMutationGenerationRef.current[scope.operation],
    requestedProjectId: scope.projectId,
    selectedProjectId: selectedProjectIdRef.current,
    requestedYearMonth: scope.yearMonth,
    selectedYearMonth: selectedYearMonthRef.current,
  })
    && (response?.projectId === undefined || response.projectId === scope.projectId)
    && (response?.yearMonth === undefined || response.yearMonth === scope.yearMonth), []);
  useEffect(() => {
    monthCloseMutationGenerationRef.current = {
      approver: monthCloseMutationGenerationRef.current.approver + 1,
      request: monthCloseMutationGenerationRef.current.request + 1,
      withdraw: monthCloseMutationGenerationRef.current.withdraw + 1,
      reopen: monthCloseMutationGenerationRef.current.reopen + 1,
    };
    setExecutiveApproverBusy(false);
    setMonthCloseBusy(false);
  }, [projectId, yearMonth]);
  // 본체는 성공했지만 부가 섹션 조회가 실패한 경우. 화면은 유지하고 안내 + 재시도를 준다.
  const monthCloseSectionErrors = monthCloseResult?.sectionErrors || [];
  const cashflowSourceUnavailable = monthCloseSectionErrors.some((entry) => entry.section === 'cashflow');
  const cashflowSourceUnavailableGuide = monthCloseResult?.blockers?.find((entry) => (
    entry.code === 'CASHFLOW_SOURCE_UNAVAILABLE'
  ))?.message;
  const deadlineSummaryUnavailable = monthCloseSectionErrors.some((entry) => entry.section === 'deadlineSummary')
    || (Boolean(monthCloseResult?.dashboard) && monthCloseResult?.dashboard?.deadlineSummary == null);

  const selectedYear = useMemo(() => {
    const parsed = Number.parseInt(yearMonth.slice(0, 4), 10);
    return Number.isFinite(parsed) ? parsed : new Date().getFullYear();
  }, [yearMonth]);
  const annualWeeks = cashflowPresentation?.weeks || [];
  const cashflowBoardScrollRef = useRef<HTMLElement | null>(null);
  const [exitBusy, setExitBusy] = useState(false);

  const hasDirty = monthCloseReviewDirty;
  const blocker = useBlocker(hasDirty);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!hasDirty) return;
      e.preventDefault();
      e.returnValue = '';
    };

    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasDirty]);

  useEffect(() => {
    setMonthCloseResult(null);
    setMonthCloseDepositRows(createEmptyCashflowMonthCloseDepositRows());
    setMonthCloseHumanReviewed(false);
    setMonthCloseReviewDirty(false);
  }, [projectId]);

  const discardChangesAndLeave = useCallback(async (): Promise<void> => {
    if (blocker.state !== 'blocked') return;
    setExitBusy(true);
    try {
      setMonthCloseReviewDirty(false);
      blocker.proceed?.();
    } catch (error) {
    } finally {
      setExitBusy(false);
    }
  }, [blocker]);

  useEffect(() => {
    let cancelled = false;
    setCashflowSheetConfigLoaded(false);
    setCashflowSheetConfig(null);
    setCashflowSystemAccountEmail('');
    setCashflowSystemAccountError(false);
    if (!projectId || !orgId || !user?.uid) {
      setCashflowSheetConfigLoaded(true);
      return () => { cancelled = true; };
    }
    const loadConfig = async (): Promise<void> => {
      try {
        let actor = await resolveBffActor();
        if (!actor?.idToken) return;
        let response: CashflowSheetLabShareAccountResult;
        try {
          response = await getCashflowSheetLabShareAccountViaBff({ tenantId: orgId, actor, projectId, sourceYear: selectedYear });
        } catch (error) {
          if (!isBffAuthRejection(error)) throw error;
          actor = await resolveBffActor({ forceRefresh: true });
          if (!actor?.idToken) throw error;
          response = await getCashflowSheetLabShareAccountViaBff({ tenantId: orgId, actor, projectId, sourceYear: selectedYear });
        }
        if (!cancelled) {
          setCashflowSheetConfig(response.config?.value ? response.config : null);
          setCashflowSystemAccountEmail(response.systemAccountEmail || response.accessPolicy?.serviceAccountEmail || '');
          setCashflowSystemAccountError(!(response.systemAccountEmail || response.accessPolicy?.serviceAccountEmail));
        }
      } catch {
        if (!cancelled) {
          setCashflowSheetConfig(null);
          setCashflowSystemAccountError(true);
        }
      } finally {
        if (!cancelled) setCashflowSheetConfigLoaded(true);
      }
    };
    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, [orgId, projectId, resolveBffActor, selectedYear, user?.uid]);

  useEffect(() => {
    let cancelled = false;
    setCashflowSheetFreshness(null);
    if (!monthCloseSettled || !cashflowSheetConfigLoaded || !cashflowSheetConfig?.value || !projectId || !orgId || !user?.uid) {
      return () => { cancelled = true; };
    }

    // 진입은 시트를 풀 리드하지 않는다. modifiedTime 만 싸게 대조해 '변경됨' 배지만 띄운다.
    // 실제 diff 와 풀 리드는 사용자가 '시트 불러오기'를 누를 때만.
    const probeFreshness = async (): Promise<void> => {
      try {
        let actor = await resolveBffActor();
        if (!actor?.idToken) throw new Error('Cashflow sheet freshness probe requires authentication.');
        let result: CashflowSheetFreshnessProbe;
        try {
          result = await probeCashflowSheetFreshnessViaBff({ tenantId: orgId, actor, projectId });
        } catch (error) {
          if (!isBffAuthRejection(error)) throw error;
          actor = await resolveBffActor({ forceRefresh: true });
          if (!actor?.idToken) throw error;
          result = await probeCashflowSheetFreshnessViaBff({ tenantId: orgId, actor, projectId });
        }
        if (!cancelled) setCashflowSheetFreshness(result);
      } catch {
        if (!cancelled) {
          setCashflowSheetFreshness({
            status: 'UNAVAILABLE', mirrorLoaded: false, sheetChangedSinceMirror: false, checkedAt: '',
          });
        }
      }
    };
    void probeFreshness();
    return () => { cancelled = true; };
  }, [
    cashflowSheetConfig?.sourceYear,
    cashflowSheetConfig?.value,
    cashflowSheetConfigLoaded,
    monthCloseSettled,
    orgId,
    projectId,
    resolveBffActor,
    selectedYear,
    user?.uid,
  ]);

  useEffect(() => {
    if (!cashflowSheetConfigLoaded || cashflowSheetConfig || !projectId || typeof window === 'undefined') return;
    const storageKey = `myscube:cashflow-sheet-onboarding:${projectId}`;
    try {
      if (window.sessionStorage.getItem(storageKey)) return;
      window.sessionStorage.setItem(storageKey, 'shown');
    } catch {
      // Storage가 차단된 브라우저에서도 온보딩은 정상 노출한다.
    }
    setSheetReviewDialogOpen(true);
  }, [cashflowSheetConfig, cashflowSheetConfigLoaded, projectId]);

  const [cashflowSheetMirrorLoading, setCashflowSheetMirrorLoading] = useState(false);
  const mirrorNeeded = sheetReviewDialogOpen
    || (monthCloseSettled && !(monthCloseResult?.dashboard?.source && Array.isArray(monthCloseResult?.dashboard?.cells)));
  useEffect(() => {
    let cancelled = false;
    if (!projectId || !orgId || !user?.uid) { setCashflowSheetMirror(null); return () => { cancelled = true; }; }
    // 미러(약 1MB)는 보드를 그리는 데 쓰이지 않는다 - 대시보드가 있으면. 폴백이거나 검토 다이얼로그일 때만 읽는다.
    if (!mirrorNeeded) return () => { cancelled = true; };

    const readMirror = (actor: NonNullable<Awaited<ReturnType<typeof resolveBffActor>>>) => (
      getCashflowSheetLabMirrorViaBff({ tenantId: orgId, actor, projectId })
    );
    const loadPinnedMirror = async (): Promise<void> => {
      setCashflowSheetMirrorLoading(true);
      try {
        const actor = await resolveBffActor();
        if (!actor?.idToken) return;
        let mirror: CashflowSheetLabMirrorResult;
        try {
          mirror = await readMirror(actor);
        } catch (error) {
          if (!isBffAuthRejection(error)) throw error;
          const refreshedActor = await resolveBffActor({ forceRefresh: true });
          if (!refreshedActor?.idToken) throw error;
          mirror = await readMirror(refreshedActor);
        }
        if (!cancelled) setCashflowSheetMirror(mirror);
      } catch {
        if (!cancelled) setCashflowSheetMirror(null);
      } finally {
        if (!cancelled) setCashflowSheetMirrorLoading(false);
      }
    };
    void loadPinnedMirror();
    return () => { cancelled = true; };
  }, [mirrorNeeded, orgId, projectId, resolveBffActor, user?.uid]);

  // 프로젝트가 바뀌면 이전 프로젝트의 미러를 들고 있지 않는다.
  useEffect(() => { setCashflowSheetMirror(null); }, [projectId]);

  const loadCashflowMonthClose = useCallback(async (): Promise<void> => {
    const requestGeneration = ++monthCloseRequestGenerationRef.current;
    const requestedProjectId = projectId;
    const requestedYearMonth = yearMonth;
    const isCurrentRequest = () => shouldApplyCashflowMonthCloseRequestResult({
      requestGeneration,
      currentGeneration: monthCloseRequestGenerationRef.current,
      requestedProjectId,
      selectedProjectId: selectedProjectIdRef.current,
      requestedYearMonth,
      selectedYearMonth: selectedYearMonthRef.current,
    });
    if (!projectId || !orgId || !user?.uid) {
      setMonthCloseResult(null);
      setMonthCloseError('로그인 세션이 만료됐어요. 다시 로그인해 주세요.');
      setMonthCloseErrorPresentation({
        guide: '로그인 세션이 만료됐어요. 다시 로그인해 주세요.',
        resolution: 'contact',
        code: '',
        requestId: '',
      });
      return;
    }
    setMonthCloseResult((current) => isCashflowMonthCloseRequestForSelection(current, projectId, yearMonth)
      ? current
      : null);
    setMonthCloseLoading(true);
    setMonthCloseError(null);
    setMonthCloseErrorPresentation(null);
    const startedAt = Date.now();
    logCashflowSettlement({
      phase: 'start',
      operation: 'cashflow.month_close.status.load',
      projectId,
      yearMonth,
      summary: { selectedYear },
    });
    try {
      const actor = await resolveBffActor();
      if (!actor?.idToken) throw new Error('로그인 세션이 만료되었습니다.');
      try {
      const result = await fetchCashflowMonthCloseViaBff({
        tenantId: orgId,
        actor,
        projectId,
        yearMonth,
      });
      if (!isCurrentRequest()) return;
      setMonthCloseResult(result);
      logCashflowSettlement({
        phase: 'success',
        operation: 'cashflow.month_close.status.load',
        projectId,
        yearMonth,
        durationMs: Date.now() - startedAt,
        summary: { status: result.status, closeEligible: result.closeEligible },
      });
      } catch (error) {
        if (!isBffAuthRejection(error)) throw error;
        const refreshedActor = await resolveBffActor({ forceRefresh: true });
        if (!refreshedActor?.idToken) throw error;
        const result = await fetchCashflowMonthCloseViaBff({
          tenantId: orgId,
          actor: refreshedActor,
          projectId,
          yearMonth,
        });
        if (!isCurrentRequest()) return;
        setMonthCloseResult(result);
        logCashflowSettlement({
          phase: 'success',
          operation: 'cashflow.month_close.status.load',
          projectId,
          yearMonth,
          durationMs: Date.now() - startedAt,
          summary: { status: result.status, closeEligible: result.closeEligible, retriedAuth: true },
        });
      }
    } catch (error) {
      if (!isCurrentRequest()) return;
      if (error instanceof PlatformApiError) {
        const presentation = resolveApiErrorPresentation(error.code, error.status);
        setMonthCloseError(presentation.guide);
        setMonthCloseErrorPresentation({
          ...presentation,
          code: error.code.slice(0, 64),
          requestId: String(error.requestId || '').slice(0, 64),
        });
      } else {
        const presentation = resolveApiErrorPresentation('', 500);
        setMonthCloseError(presentation.guide);
        setMonthCloseErrorPresentation({ ...presentation, code: '', requestId: '' });
      }
      logCashflowSettlement({
        phase: 'error',
        operation: 'cashflow.month_close.status.load',
        projectId,
        yearMonth,
        durationMs: Date.now() - startedAt,
        error,
      });
    } finally {
      if (isCurrentRequest()) {
        setMonthCloseLoading(false);
        setMonthCloseSettled(true);
      }
    }
  }, [orgId, projectId, resolveBffActor, selectedYear, user?.uid, yearMonth]);

  useEffect(() => {
    setMonthCloseSettled(false);
    void loadCashflowMonthClose();
  }, [loadCashflowMonthClose]);

  useEffect(() => {
    if (!weeklyActionNotice) return;
    const timer = window.setTimeout(() => setWeeklyActionNotice(''), 6000);
    return () => window.clearTimeout(timer);
  }, [weeklyActionNotice]);

  const handleOpenWeeklyCompletion = useCallback((): void => {
    if (!savedExecutiveApproverId) {
      setExecutiveApproverAttention(true);
      return;
    }
    setWeeklyCompletionError('');
    setWeeklyProjectionWarning(null);
    setWeeklyUpdateResult('');
    setWeeklyCompletionOpen(true);
  }, [savedExecutiveApproverId]);

  const handleCompleteWeeklyUpdate = useCallback(async (): Promise<void> => {
    if (!weeklyUpdateResult) return;
    if (monthCloseActions?.completeWeekly.enabled !== true) {
      return;
    }
    if (selectedProjectIdRef.current !== projectId || selectedYearMonthRef.current !== yearMonth) {
      return;
    }
    if (!savedExecutiveApproverId) {
      setExecutiveApproverAttention(true);
      return;
    }
    setWeeklyCompletionBusy(true);
    setWeeklyActionNotice('');
    const startedAt = Date.now();
    const currentDeadline = monthCloseResult?.dashboard?.deadlineSummary?.current;
    logCashflowSettlement({
      phase: 'start',
      operation: 'cashflow.weekly_settlement.complete',
      projectId,
      yearMonth: currentDeadline?.yearMonth || yearMonth,
      weekNo: currentDeadline?.weekNo,
      summary: { alreadyCompleted: Boolean(currentDeadline?.completedAt) },
    });
    try {
      let actor = await resolveBffActor();
      if (!actor?.idToken) throw new Error('로그인 세션이 만료되었습니다.');
      const complete = (targetActor: typeof actor) => {
        if (selectedProjectIdRef.current !== projectId || selectedYearMonthRef.current !== yearMonth) {
          throw new Error('선택한 프로젝트 또는 결산 월이 변경되었습니다. 현재 화면의 주간 정산 상태를 다시 확인해 주세요.');
        }
        return completeCashflowWeeklyUpdateViaBff({
          tenantId: orgId,
          actor: targetActor,
          projectId,
          yearMonth: currentDeadline?.yearMonth,
          weekNo: currentDeadline?.weekNo,
          updateResult: weeklyUpdateResult,
          ignoreProjectionValidation: Boolean(weeklyProjectionWarning),
          projectionValidationEvidenceHash: weeklyProjectionWarning?.evidenceHash,
          projectionValidationIssueCount: weeklyProjectionWarning?.missingCells.length,
        });
      };
      let result;
      try {
        result = await complete(actor);
      } catch (error) {
        if (!isBffAuthRejection(error)) throw error;
        actor = await resolveBffActor({ forceRefresh: true });
        if (!actor?.idToken) throw error;
        result = await complete(actor);
      }
      await loadCashflowMonthClose();
      setWeeklyCompletionOpen(false);
      setWeeklyCompletionError('');
      setWeeklyActionNotice(result.alreadyCompleted
        ? '이미 완료 요청된 주입니다. 현재 상태를 다시 불러왔어요.'
        : '주간 정산 완료 요청을 보냈어요. 조직장 확정을 기다립니다.');
      if (!result.alreadyCompleted) toast.success('주간 정산 완료 요청을 보냈어요.');
      setWeeklyProjectionWarning(null);
      setWeeklyUpdateResult('');
      logCashflowSettlement({
        phase: 'success',
        operation: 'cashflow.weekly_settlement.complete',
        projectId,
        yearMonth: result.yearMonth,
        weekNo: result.weekNo,
        durationMs: Date.now() - startedAt,
        summary: { alreadyCompleted: result.alreadyCompleted },
      });
    } catch (error) {
      logCashflowSettlement({
        phase: 'error',
        operation: 'cashflow.weekly_settlement.complete',
        projectId,
        yearMonth: currentDeadline?.yearMonth || yearMonth,
        weekNo: currentDeadline?.weekNo,
        durationMs: Date.now() - startedAt,
        error,
      });
      const message = resolveCashflowWeeklyCompletionErrorMessage(
        error,
        '주간 정산 완료 상태를 저장하지 못했습니다.',
      );
      setWeeklyCompletionError(message);
      setWeeklyProjectionWarning(weeklyProjectionValidation(error));
    } finally {
      setWeeklyCompletionBusy(false);
    }
  }, [loadCashflowMonthClose, monthCloseActions?.completeWeekly, monthCloseResult?.dashboard?.deadlineSummary?.current, orgId, projectId, resolveBffActor, savedExecutiveApproverId, weeklyProjectionWarning, weeklyUpdateResult, yearMonth]);

  // 주정산 회수: 사유·결재 없이 즉시. revision 은 BFF 가 잠금 기록에서 읽는다. 되돌리려면 다시 완료하면 된다.
  const handleWithdrawWeeklyUpdate = useCallback(async (reason?: string): Promise<void> => {
    if (monthCloseActions?.reopenWeekly.enabled !== true) return;
    const currentDeadline = monthCloseResult?.dashboard?.deadlineSummary?.current;
    if (!currentDeadline) return;
    if (selectedProjectIdRef.current !== projectId || selectedYearMonthRef.current !== yearMonth) return;
    setWeeklyWithdrawBusy(true);
    setWeeklyWithdrawError('');
    setWeeklyActionNotice('');
    const startedAt = Date.now();
    try {
      const actor = await resolveBffActor();
      if (!actor?.idToken) throw new Error('로그인 세션이 만료되었습니다.');
      const result = await reopenCashflowWeeklyUpdateViaBff({
        tenantId: orgId,
        actor,
        projectId,
        yearMonth: currentDeadline.yearMonth,
        weekNo: currentDeadline.weekNo,
        ...(reason ? { reason } : {}),
      });
      await loadCashflowMonthClose();
      setWeeklyReopenReasonOpen(false);
      setWeeklyReopenReason('');
      setWeeklyActionNotice(reason
        ? '확정된 주간 정산을 되돌렸어요. 값을 고친 뒤 다시 요청할 수 있어요.'
        : '완료 요청을 회수했어요. 값을 고친 뒤 다시 요청할 수 있어요.');
      toast.success('주간 정산 완료 요청을 회수했어요.');
      logCashflowSettlement({
        phase: 'success',
        operation: 'cashflow.weekly_settlement.withdraw',
        projectId,
        yearMonth: result.yearMonth,
        weekNo: result.weekNo,
        durationMs: Date.now() - startedAt,
        summary: { revision: result.revision },
      });
    } catch (error) {
      logCashflowSettlement({
        phase: 'error',
        operation: 'cashflow.weekly_settlement.withdraw',
        projectId,
        yearMonth: currentDeadline.yearMonth,
        weekNo: currentDeadline.weekNo,
        durationMs: Date.now() - startedAt,
        error,
      });
      // 조직장이 확정한 주는 사유가 있어야 되돌릴 수 있다. 서버가 그렇게 말해 주므로
      // 그때만 사유 창을 연다 - 화면이 확정 여부를 따로 판정하지 않는다.
      if (bffErrorCode(error) === 'cashflow_weekly_reopen_reason_required') {
        setWeeklyReopenReason('');
        setWeeklyReopenReasonOpen(true);
        setWeeklyWithdrawError('');
        return;
      }
      setWeeklyWithdrawError(resolveApiErrorMessage(error, '주간 정산을 회수하지 못했습니다. 화면을 다시 불러온 뒤 시도해 주세요.'));
    } finally {
      setWeeklyWithdrawBusy(false);
    }
  }, [loadCashflowMonthClose, monthCloseActions?.reopenWeekly, monthCloseResult?.dashboard?.deadlineSummary?.current, orgId, projectId, resolveBffActor, yearMonth]);

  // 주정산 확정: 완료 요청된 주를 프로젝트 조직장이 잠근다. 서버(actions.confirmWeekly) 가 조직장인지 판정한다.
  const handleConfirmWeeklyUpdate = useCallback(async (): Promise<void> => {
    if (monthCloseActions?.confirmWeekly.enabled !== true) return;
    const currentDeadline = monthCloseResult?.dashboard?.deadlineSummary?.current;
    if (!currentDeadline) return;
    if (selectedProjectIdRef.current !== projectId || selectedYearMonthRef.current !== yearMonth) return;
    setWeeklyConfirmBusy(true);
    setWeeklyWithdrawError('');
    setWeeklyActionNotice('');
    const startedAt = Date.now();
    try {
      const actor = await resolveBffActor();
      if (!actor?.idToken) throw new Error('로그인 세션이 만료되었습니다.');
      const result = await confirmCashflowWeeklyUpdateViaBff({
        tenantId: orgId,
        actor,
        projectId,
        yearMonth: currentDeadline.yearMonth,
        weekNo: currentDeadline.weekNo,
      });
      await loadCashflowMonthClose();
      setWeeklyActionNotice('주간 정산을 확정했어요. 이제 이 주는 잠깁니다.');
      toast.success('주간 정산을 확정했어요.');
      logCashflowSettlement({
        phase: 'success',
        operation: 'cashflow.weekly_settlement.confirm',
        projectId,
        yearMonth: result.yearMonth,
        weekNo: result.weekNo,
        durationMs: Date.now() - startedAt,
        summary: { revision: result.revision },
      });
    } catch (error) {
      logCashflowSettlement({
        phase: 'error',
        operation: 'cashflow.weekly_settlement.confirm',
        projectId,
        yearMonth: currentDeadline.yearMonth,
        weekNo: currentDeadline.weekNo,
        durationMs: Date.now() - startedAt,
        error,
      });
      setWeeklyWithdrawError(resolveApiErrorMessage(error, '주간 정산을 확정하지 못했습니다. 화면을 다시 불러온 뒤 시도해 주세요.'));
    } finally {
      setWeeklyConfirmBusy(false);
    }
  }, [loadCashflowMonthClose, monthCloseActions?.confirmWeekly, monthCloseResult?.dashboard?.deadlineSummary?.current, orgId, projectId, resolveBffActor, yearMonth]);

  const loadWeeklyComplianceHistory = useCallback(async (): Promise<void> => {
    setWeeklyComplianceHistoryLoading(true);
    setWeeklyComplianceHistoryError('');
    try {
      const actor = await resolveBffActor();
      if (!actor?.idToken) throw new Error('로그인 세션이 만료되었습니다.');
      const page = await fetchCashflowWeeklyComplianceViaBff({ tenantId: orgId, actor, projectId, limit: 50 });
      setWeeklyComplianceHistory(page.items);
      setWeeklyComplianceNextCursor(page.nextCursor);
      setWeeklyCompliancePageCount(1);
    } catch (error) {
      setWeeklyComplianceHistoryError(resolveApiErrorMessage(error, '주간 정산 이력을 불러오지 못했습니다.'));
    } finally {
      setWeeklyComplianceHistoryLoading(false);
    }
  }, [orgId, projectId, resolveBffActor]);

  const loadMoreWeeklyComplianceHistory = useCallback(async (): Promise<void> => {
    if (!weeklyComplianceNextCursor || weeklyComplianceHistoryLoading) return;
    if (weeklyCompliancePageCount >= 100) {
      setWeeklyComplianceHistoryError('안전을 위해 100페이지에서 추가 조회를 중단했습니다. 검색 범위를 조정해 주세요.');
      return;
    }
    setWeeklyComplianceHistoryLoading(true);
    try {
      const actor = await resolveBffActor();
      if (!actor?.idToken) throw new Error('로그인 세션이 만료되었습니다.');
      const page = await fetchCashflowWeeklyComplianceViaBff({ tenantId: orgId, actor, projectId, limit: 50, cursor: weeklyComplianceNextCursor });
      if (page.nextCursor && page.nextCursor === weeklyComplianceNextCursor) throw new Error('이력 페이지가 반복되어 추가 조회를 중단했습니다.');
      setWeeklyComplianceHistory((items) => [...items, ...page.items]);
      setWeeklyComplianceNextCursor(page.nextCursor);
      setWeeklyCompliancePageCount((count) => count + 1);
    } catch (error) {
      setWeeklyComplianceHistoryError(resolveApiErrorMessage(error, '추가 주간 정산 이력을 불러오지 못했습니다.'));
    } finally {
      setWeeklyComplianceHistoryLoading(false);
    }
  }, [orgId, projectId, resolveBffActor, weeklyComplianceHistoryLoading, weeklyComplianceNextCursor, weeklyCompliancePageCount]);

  useEffect(() => {
    if (weeklyHistoryOpen) void loadWeeklyComplianceHistory();
  }, [loadWeeklyComplianceHistory, weeklyHistoryOpen]);

  const fetchCashflowActivityPage = useCallback(async (input: {
    source?: CashflowActivitySource;
    cursor?: string;
    signal: AbortSignal;
  }) => {
    let actor = await resolveBffActor();
    if (!actor?.idToken) throw new Error('로그인 세션이 만료되었습니다.');
    if (input.signal.aborted) throw new Error('활동 기록 요청이 중단되었습니다.');
    const request = (requestActor: NonNullable<Awaited<ReturnType<typeof resolveBffActor>>>) => fetchCashflowActivityViaBff({
      tenantId: orgId,
      actor: requestActor,
      projectId,
      limit: 50,
      ...(input.source ? { source: input.source } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      signal: input.signal,
    });
    try {
      return await request(actor);
    } catch (error) {
      if (!isBffAuthRejection(error) || input.signal.aborted) throw error;
      actor = await resolveBffActor({ forceRefresh: true });
      if (!actor?.idToken || input.signal.aborted) throw error;
      return request(actor);
    }
  }, [orgId, projectId, resolveBffActor]);

  const isCurrentCashflowActivityScope = useCallback(() => (
    cashflowActivityScopeRef.current === activityScope
    && selectedOrgIdRef.current === orgId
    && selectedProjectIdRef.current === projectId
  ), [activityScope, orgId, projectId]);

  const cashflowActivityDeferred = useCallback(() => (
    cashflowActivityOneClickRef.current.scope === activityScope
    && cashflowActivityOneClickRef.current.depth > 0
  ), [activityScope]);

  const loadCashflowEventSource = useCallback(async (
    source: CashflowActivitySource,
    options: { preservePagination?: boolean } = {},
  ): Promise<void> => {
    if (cashflowEventLoading || cashflowEventLoadingMore || !projectId || !orgId || !user?.uid || !shouldStartCashflowActivityLoad({
      visible: opsTimelineVisibleRef.current,
      deferred: cashflowActivityDeferred(),
      currentScope: isCurrentCashflowActivityScope(),
    })) return;
    const ticket = cashflowActivityRequestGuard.start(`source:${source}`);
    setCashflowEventLoadingSources((current) => current.includes(source) ? current : [...current, source]);
    try {
      const response = await fetchCashflowActivityPage({ source, signal: ticket.signal });
      if (!cashflowActivityRequestGuard.isCurrent(ticket) || !isCurrentCashflowActivityScope()) return;
      setCashflowEvents((current) => mergeCashflowEvents(current, response.events));
      setCashflowEventErrors((current) => filterCashflowActivityErrorsAfterSuccess(
        current,
        source,
        Boolean(options.preservePagination),
      ));
      if (!options.preservePagination) {
        setCashflowActivityCursorQueue((current) => updateCashflowActivityCursorQueue(current, source, response.nextCursor));
      }
    } catch (error) {
      if (!cashflowActivityRequestGuard.isCurrent(ticket) || !isCurrentCashflowActivityScope()) return;
      const message = resolveApiErrorMessage(error, `${CASHFLOW_ACTIVITY_SOURCE_LABELS[source]} 기록을 불러오지 못했습니다.`);
      setCashflowEventErrors((current) => [
        ...current.filter((failure) => failure.source !== source),
        { source, message, preservePagination: options.preservePagination },
      ]);
    } finally {
      if (cashflowActivityRequestGuard.isCurrent(ticket) && isCurrentCashflowActivityScope()) {
        setCashflowEventLoadingSources((current) => current.filter((candidate) => candidate !== source));
      }
      cashflowActivityRequestGuard.finish(ticket);
    }
  }, [cashflowActivityDeferred, cashflowActivityRequestGuard, cashflowEventLoading, cashflowEventLoadingMore, fetchCashflowActivityPage, isCurrentCashflowActivityScope, orgId, projectId, user?.uid]);

  const reloadCashflowActivitySources = useCallback(async (sources: readonly CashflowActivitySource[]): Promise<void> => {
    await Promise.all([...new Set(sources)].map((source) => (
      loadCashflowEventSource(source, { preservePagination: true })
    )));
  }, [loadCashflowEventSource]);

  const reloadCashflowActivityForMutations = useCallback(async (...mutations: CashflowActivityMutation[]): Promise<void> => {
    const sources = cashflowActivitySourcesForMutations(mutations);
    if (sources.length === 0) return;
    if (!opsTimelineVisibleRef.current) return;
    sources.forEach((source) => cashflowActivityOneClickRef.current.pendingSources.add(source));
    setCashflowActivityDrainVersion((current) => current + 1);
  }, []);

  // Frozen apply flow keeps this symbol. A successful apply writes only the JVM audit source.
  const loadCashflowEvents = useCallback(async (): Promise<void> => {
    await reloadCashflowActivityForMutations('sheet_values_applied');
  }, [reloadCashflowActivityForMutations]);

  const loadCashflowActivityAggregate = useCallback(async (): Promise<void> => {
    if (!projectId || !orgId || !user?.uid || !shouldStartCashflowActivityLoad({
      visible: opsTimelineVisibleRef.current,
      deferred: cashflowActivityDeferred(),
      currentScope: isCurrentCashflowActivityScope(),
    })) return;
    if (cashflowActivityOneClickRef.current.scope === activityScope) {
      cashflowActivityOneClickRef.current.pendingAggregate = false;
      cashflowActivityOneClickRef.current.pendingSources.clear();
    }
    const ticket = cashflowActivityRequestGuard.start('aggregate', { reset: true });
    cashflowEventLoadingMoreRef.current = false;
    setCashflowEventLoading(true);
    setCashflowEventLoadingMore(false);
    setCashflowEventLoadError('');
    setCashflowEventErrors([]);
    setCashflowEventLoadingSources([]);
    setCashflowActivityCursorQueue([]);
    try {
      const response = await fetchCashflowActivityPage({ signal: ticket.signal });
      if (!cashflowActivityRequestGuard.isCurrent(ticket) || !isCurrentCashflowActivityScope()) return;
      setCashflowEvents((current) => mergeCashflowEvents(current, response.events));
      setCashflowEventErrors(response.errors.map((failure) => ({
        source: failure.source,
        message: '기록 일부를 일시적으로 불러오지 못했습니다.',
      })));
      setCashflowActivityCursorQueue(updateCashflowActivityCursorQueue([], undefined, response.nextCursor));
    } catch (error) {
      if (!cashflowActivityRequestGuard.isCurrent(ticket) || !isCurrentCashflowActivityScope()) return;
      setCashflowEventLoadError(resolveApiErrorMessage(error, '변경 이력을 불러오지 못했습니다.'));
    } finally {
      if (cashflowActivityRequestGuard.isCurrent(ticket) && isCurrentCashflowActivityScope()) {
        setCashflowEventLoading(false);
      }
      cashflowActivityRequestGuard.finish(ticket);
    }
  }, [activityScope, cashflowActivityDeferred, cashflowActivityRequestGuard, fetchCashflowActivityPage, isCurrentCashflowActivityScope, orgId, projectId, user?.uid]);

  useEffect(() => {
    const pendingWork = takeCashflowActivityPendingWork(cashflowActivityOneClickRef.current, {
      scope: activityScope,
      visible: opsTimelineVisible,
      busy: cashflowEventLoading || cashflowEventLoadingMore || cashflowEventLoadingSources.length > 0,
    });
    if (pendingWork?.kind === 'aggregate') void loadCashflowActivityAggregate();
    else if (pendingWork?.kind === 'sources') void reloadCashflowActivitySources(pendingWork.sources);
  }, [
    activityScope,
    cashflowActivityDrainVersion,
    cashflowEventLoading,
    cashflowEventLoadingMore,
    cashflowEventLoadingSources.length,
    loadCashflowActivityAggregate,
    opsTimelineVisible,
    reloadCashflowActivitySources,
  ]);

  const loadMoreCashflowEvents = useCallback(async (): Promise<void> => {
    if (cashflowActivityCursorQueue.length === 0 || cashflowEventLoadingMoreRef.current || cashflowEventLoading || cashflowEventLoadingSources.length > 0 || !shouldStartCashflowActivityLoad({
      visible: opsTimelineVisibleRef.current,
      deferred: cashflowActivityDeferred(),
      currentScope: isCurrentCashflowActivityScope(),
    })) return;
    const queuedCursors = [...cashflowActivityCursorQueue];
    cashflowEventLoadingMoreRef.current = true;
    setCashflowEventLoadingMore(true);
    setCashflowEventLoadError('');
    let generation: number | null = null;
    await Promise.all(queuedCursors.map(async (queuedCursor) => {
      const ticket = cashflowActivityRequestGuard.start(queuedCursor.source ? `source:${queuedCursor.source}` : 'aggregate');
      generation ??= ticket.generation;
      try {
        const response = await fetchCashflowActivityPage({
          ...(queuedCursor.source ? { source: queuedCursor.source } : {}),
          cursor: queuedCursor.cursor,
          signal: ticket.signal,
        });
        if (!cashflowActivityRequestGuard.isCurrent(ticket) || !isCurrentCashflowActivityScope()) return;
        setCashflowEvents((current) => mergeCashflowEvents(current, response.events));
        const failedSources = new Set(response.errors.map((failure) => failure.source));
        setCashflowEventErrors((current) => [
          ...current.filter((failure) => failure.source !== queuedCursor.source && !failedSources.has(failure.source)),
          ...response.errors.map((failure) => ({
            source: failure.source,
            message: '기록 일부를 일시적으로 불러오지 못했습니다.',
          })),
        ]);
        if (response.nextCursor === queuedCursor.cursor) {
          setCashflowEventLoadError('이력 페이지가 반복되어 추가 조회를 중단했습니다.');
          setCashflowActivityCursorQueue((current) => updateCashflowActivityCursorQueue(current, queuedCursor.source, null));
        } else {
          setCashflowActivityCursorQueue((current) => updateCashflowActivityCursorQueue(current, queuedCursor.source, response.nextCursor));
        }
      } catch (error) {
        if (!cashflowActivityRequestGuard.isCurrent(ticket) || !isCurrentCashflowActivityScope()) return;
        const failedSource = queuedCursor.source;
        if (failedSource) {
          const message = resolveApiErrorMessage(error, `${CASHFLOW_ACTIVITY_SOURCE_LABELS[failedSource]} 기록을 불러오지 못했습니다.`);
          setCashflowEventErrors((current) => [
            ...current.filter((failure) => failure.source !== failedSource),
            { source: failedSource, message },
          ]);
        } else {
          setCashflowEventLoadError(resolveApiErrorMessage(error, '이전 변경 이력을 불러오지 못했습니다.'));
        }
      } finally {
        cashflowActivityRequestGuard.finish(ticket);
      }
    }));
    if (generation !== null && cashflowActivityRequestGuard.isGenerationCurrent(generation) && isCurrentCashflowActivityScope()) {
      cashflowEventLoadingMoreRef.current = false;
      setCashflowEventLoadingMore(false);
    }
  }, [cashflowActivityCursorQueue, cashflowActivityDeferred, cashflowActivityRequestGuard, cashflowEventLoading, cashflowEventLoadingSources.length, fetchCashflowActivityPage, isCurrentCashflowActivityScope]);

  useEffect(() => {
    setCashflowEvents([]);
    setCashflowEventErrors([]);
    setCashflowEventLoadError('');
    setCashflowEventLoading(false);
    setCashflowEventLoadingSources([]);
    setCashflowActivityCursorQueue([]);
    setCashflowEventLoadingMore(false);
    cashflowEventLoadingMoreRef.current = false;
    return () => {
      cashflowActivityRequestGuard.invalidate();
    };
  }, [activityScope, cashflowActivityRequestGuard]);

  // 이력 타임라인은 화면 오른쪽/아래에 있다. 들어올 때 읽는다. 한 번 보이면 이후 갱신은 기존 경로대로.
  useEffect(() => {
    const node = opsTimelineRef.current;
    if (!node) return undefined;
    if (typeof IntersectionObserver === 'undefined') { setOpsTimelineVisible(true); return undefined; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setOpsTimelineVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    // 넓은 화면에선 타임라인이 처음부터 보여서 "보이면 읽는다"가 첫 발사에 끼었다(2026-08-19).
    // 보조 정보이니 month-close 가 끝난 뒤에만 읽는다.
    if (!opsTimelineVisible || !monthCloseSettled) return;
    if (cashflowActivityDeferred()) {
      if (cashflowActivityOneClickRef.current.scope === activityScope) {
        cashflowActivityOneClickRef.current.pendingAggregate = true;
      }
      return;
    }
    void loadCashflowActivityAggregate();
  }, [activityScope, cashflowActivityDeferred, loadCashflowActivityAggregate, monthCloseSettled, opsTimelineVisible]);

  const monthClosePinnedSource = useMemo<CashflowSheetLabMirrorResult | null>(() => {
    const dashboard = monthCloseResult?.dashboard;
    if (!dashboard?.source || !Array.isArray(dashboard.cells)) return cashflowSheetMirror;
    if (!monthCloseTargetYearMonth) return null;
    return {
      projectId,
      status: dashboard.source.kind === 'PINNED_MIRROR' && dashboard.source.status === 'FRESH' ? 'FRESH' : 'STALE',
      sourceRevision: dashboard.source.sourceRevision,
      targetRevisionAtFetch: dashboard.source.targetRevision,
      capturedAt: dashboard.source.capturedAt,
      yearMonths: [monthCloseTargetYearMonth],
      cells: dashboard.cells.map((cell) => ({
        mode: cell.mode,
        yearMonth: monthCloseTargetYearMonth,
        weekNo: cell.weekNo,
        lineId: cell.cashflowLine,
        direction: CASHFLOW_IN_LINES.includes(cell.cashflowLine as CashflowSheetLineId) ? 'IN' : 'OUT',
        sourceCell: cell.sourceCell || '',
        sourceLabel: cell.sourceLabel || '',
        state: cell.cellState,
        ...(['VALUE', 'ZERO'].includes(cell.cellState) ? { amount: cell.amount } : {}),
      })),
    };
  }, [cashflowSheetMirror, monthCloseResult?.dashboard, monthCloseTargetYearMonth, projectId]);

  useEffect(() => {
    setMonthCloseHumanReviewed(false);
  }, [monthCloseTargetYearMonth, yearMonth, monthClosePinnedSource?.sourceRevision, monthClosePinnedSource?.targetRevisionAtFetch]);

  useEffect(() => {
    const sourceRows = monthCloseResult?.dashboard?.sheetDepositScheduleRows || [];
    if (sourceRows.length !== 5 || monthCloseReviewDirty) return;
    setMonthCloseDepositRows(sourceRows
      .slice()
      .sort((left, right) => left.weekNo - right.weekNo)
      .map((row) => ({
        weekNo: row.weekNo,
        taxInvoiceIssuedDate: row.taxInvoiceIssuedDate || '',
        expectedDepositDate: row.expectedDepositDate || '',
        expectedDepositAmount: row.expectedDepositAmount ?? null,
        actualDepositDate: '',
        actualDepositAmount: null,
        actualSource: 'NOT_APPLICABLE',
        decision: null,
      })));
  }, [monthCloseResult?.dashboard?.sheetDepositScheduleRows, monthCloseReviewDirty]);

  const monthCloseCellsState = useMemo(() => {
    try {
      return {
        cells: normalizeCashflowMonthCloseCells(monthClosePinnedSource, monthCloseTargetYearMonth),
        error: null as string | null,
      };
    } catch (error) {
      return {
        cells: [] as CashflowMonthCloseCell[],
        error: error instanceof Error ? error.message : '결산 대상 시트 셀을 확인하지 못했습니다.',
      };
    }
  }, [monthClosePinnedSource, monthCloseTargetYearMonth]);

  // 막는 사유는 서버 판정 그대로 쓰고, 어느 칸인지만 펴서 보여준다. 화면이 다시 판정하지 않는다.
  const monthCloseBlockers = useMemo(() => (
    (monthCloseResult?.dashboard?.validation?.blockers || []).map((blocker) => ({
      code: blocker.code,
      message: blocker.message,
      lines: describeCashflowMonthCloseIssue(blocker),
    }))
  ), [monthCloseResult?.dashboard?.validation?.blockers]);

  // 일정 진행 바. 마감·완료 시각·초과 판정은 서버 값이고, 여기서는 단계 상태만 고른다.
  const weeklyScheduleSteps = useMemo(() => {
    const current = monthCloseResult?.dashboard?.deadlineSummary?.current;
    if (!current?.deadline) return [];
    return buildScheduleSteps({
      practitionerLabel: '완료 요청',
      approverLabel: '조직장 확정',
      practitionerDeadline: current.deadline,
      approverDeadline: current.approverDeadline,
      practitionerDoneAt: current.completedAt,
      // 확정 시각은 응답에 없다. 시각을 지어내지 않고 "확정됨" 만 표시한다.
      approverDoneAt: current.lockState === 'LOCKED' ? current.confirmedAt : null,
      approverDone: current.lockState === 'LOCKED',
      practitionerLate: current.status === 'COMPLETED_LATE',
      nowIso: new Date().toISOString(),
    });
  }, [monthCloseResult?.dashboard?.deadlineSummary?.current]);

  const monthScheduleSteps = useMemo(() => {
    if (!monthCloseResult?.closeDeadlineAt) return [];
    const businessState = monthCloseCycle?.businessState;
    const requestActive = ['SUBMITTED', 'LOCKED', 'REOPEN_REQUESTED'].includes(businessState || '');
    const approved = ['LOCKED', 'REOPEN_REQUESTED'].includes(businessState || '');
    const settlement = monthCloseCycle?.monthCloseSettlement;
    return buildScheduleSteps({
      practitionerLabel: '결산 요청',
      approverLabel: '조직장 승인',
      practitionerDeadline: monthCloseResult.closeDeadlineAt,
      approverDeadline: monthCloseResult.approverDeadlineAt,
      practitionerDoneAt: requestActive ? (settlement?.submittedAt || monthCloseRequest?.requestedAt) : null,
      approverDoneAt: approved ? (settlement?.approvedAt || monthCloseRequest?.reviewedAt) : null,
      nowIso: new Date().toISOString(),
    });
  }, [monthCloseCycle?.businessState, monthCloseCycle?.monthCloseSettlement, monthCloseRequest?.requestedAt, monthCloseRequest?.reviewedAt, monthCloseResult?.approverDeadlineAt, monthCloseResult?.closeDeadlineAt]);

  const settlementPeriodOrder = useMemo(() => getCashflowSettlementPeriodOrder({
    yearMonth,
    closeDeadline: monthCloseResult?.closeDeadline,
  }), [monthCloseResult?.closeDeadline, yearMonth]);
  const monthDeadlineKnown = settlementPeriodOrder.at(-1) !== 'MONTH';

  const portalTimelineNodes = useMemo<PortalTimelineNode[]>(() => {
    if (!portalMode) return [];
    const weeklyNodes = new Map((cashflowPresentation?.weeks || [])
      .filter((week) => week.yearMonth === yearMonth)
      .map((week) => [`WEEK_${week.weekNo}`, {
          key: `weekly-${week.yearMonth}-${week.weekNo}`,
          kind: 'weekly',
          label: `${week.label} 주정산`,
          statusLabel: week.weeklyStatusLabel || '주간 정산 상태 확인 필요',
          periodLabel: `${week.weekStart} ~ ${week.weekEnd}`,
          tone: week.surfaceTone,
          current: week.isCurrent,
        } satisfies PortalTimelineNode]));
    const targetYearMonth = monthCloseTargetYearMonth;
    const targetLabel = /^20\d{2}-(0[1-9]|1[0-2])$/.test(targetYearMonth)
      ? `${targetYearMonth.slice(0, 4) === yearMonth.slice(0, 4) ? '' : `${targetYearMonth.slice(0, 4)}년 `}${Number(targetYearMonth.slice(5, 7))}월분 결산`
      : '월결산';
    const deadlineLabel = monthDeadlineKnown && monthCloseResult?.closeDeadline
      ? `${Number(monthCloseResult.closeDeadline.slice(5, 7))}/${Number(monthCloseResult.closeDeadline.slice(8, 10))} 마감`
      : '마감 확인 필요';
    const monthHealthy = monthCloseCycle?.health === 'OK' && monthCloseCycle.businessState !== 'INCONSISTENT';
    const monthlyPresentation = monthHealthy ? cashflowPresentation?.monthClose : null;
    const monthlyNode: PortalTimelineNode = {
      key: `monthly-${targetYearMonth}`,
      kind: 'monthly',
      label: `${targetLabel} · ${deadlineLabel}`,
      statusLabel: monthlyPresentation?.statusLabel || '상태 재확인 필요',
      tone: monthlyPresentation?.tone || 'danger',
      current: false,
    };
    const projectEnd = project?.contractEnd;
    return [
      ...settlementPeriodOrder.flatMap((period) => period === 'MONTH'
        ? [monthlyNode]
        : weeklyNodes.get(period) ? [weeklyNodes.get(period)!] : []),
      {
        key: 'project-end',
        kind: 'project-end',
        label: '프로젝트 종료',
        statusLabel: formatPortalTimelineDate(projectEnd),
        tone: projectEnd ? 'default' : 'unavailable',
        current: false,
      },
    ];
  }, [cashflowPresentation?.monthClose, cashflowPresentation?.weeks, monthCloseCycle?.businessState, monthCloseCycle?.health, monthCloseResult?.closeDeadline, monthCloseTargetYearMonth, monthDeadlineKnown, portalMode, project?.contractEnd, settlementPeriodOrder, yearMonth]);

  const weeklyEnabledActions = [
    monthCloseActions?.completeWeekly.enabled ? 'complete' : null,
    monthCloseActions?.reopenWeekly.enabled ? 'withdraw' : null,
    monthCloseActions?.confirmWeekly.enabled ? 'confirm' : null,
  ].filter((action): action is 'complete' | 'withdraw' | 'confirm' => Boolean(action));
  const portalWeeklyAction = portalMode && weeklyEnabledActions.length === 1 ? weeklyEnabledActions[0] : null;
  const portalWeeklyActionAmbiguous = portalMode && weeklyEnabledActions.length > 1;
  const portalWeeklyButtonLabel = portalWeeklyAction === 'complete'
    ? '주간 정산 완료 요청'
    : portalWeeklyAction === 'withdraw'
      ? '주간 정산 요청 회수'
      : portalWeeklyAction === 'confirm'
        ? '주간 정산 확정'
        : portalWeeklyActionAmbiguous
          ? '주간 정산 상태 확인 필요'
          : '주간 정산 확인 중';
  const portalWeeklyButtonBusy = portalWeeklyAction === 'complete'
    ? weeklyCompletionBusy
    : portalWeeklyAction === 'withdraw'
      ? weeklyWithdrawBusy
      : portalWeeklyAction === 'confirm'
        ? weeklyConfirmBusy
        : false;
  const monthlyEnabledActions = [
    monthDeadlineKnown && monthCloseCycle?.commandCapabilities.SUBMIT_MONTH_CLOSE.allowed ? 'request' : null,
    monthDeadlineKnown && monthCloseCycle?.commandCapabilities.WITHDRAW_MONTH_CLOSE.allowed ? 'withdraw' : null,
    monthDeadlineKnown && !monthCloseError && monthCloseCycle?.commandCapabilities.REQUEST_MONTH_REOPEN.allowed ? 'reopen' : null,
  ].filter((action): action is 'request' | 'withdraw' | 'reopen' => Boolean(action));
  const portalMonthlyAction = portalMode && !canReviewReopen && monthlyEnabledActions.length === 1
    ? monthlyEnabledActions[0]
    : null;
  const portalMonthlyActionAmbiguous = portalMode && !canReviewReopen && monthlyEnabledActions.length > 1;
  const portalMonthlyButtonLabel = portalMonthlyAction === 'request'
    ? ['REJECTED', 'REOPENED', 'WITHDRAWN'].includes(monthCloseCycle?.businessState || '') ? '월 결산 재요청' : '월 결산 요청'
    : portalMonthlyAction === 'withdraw'
      ? '월 결산 요청 회수'
      : portalMonthlyAction === 'reopen'
        ? '월 결산 재오픈 요청'
        : portalMonthlyActionAmbiguous
          ? '월 결산 상태 확인 필요'
          : canReviewReopen
            ? '월 결산 재오픈 검토'
            : '월 결산 확인 중';
  const portalMonthlyButtonBusy = portalMonthlyAction !== null ? monthCloseBusy : false;

  const monthCloseNotice = useMemo(() => pickCashflowMonthCloseNotice({
    requestStatus: monthCloseRequest?.status,
    requestedByUid: monthCloseRequest?.requestedByUid,
    requestedByName: monthCloseRequest?.requestedByName,
    approverName: monthCloseRequest?.approverName,
    requestedAt: monthCloseRequest?.requestedAt,
    currentUid: user?.uid,
    canWithdraw: monthCloseCycle?.commandCapabilities.WITHDRAW_MONTH_CLOSE.allowed === true,
    withdrawGuide: monthCloseActions?.withdrawMonthClose.guide,
    canRequestReopen: monthCloseCycle?.commandCapabilities.REQUEST_MONTH_REOPEN.allowed === true,
    reopenGuide: monthCloseActions?.requestMonthReopen.guide,
    requestGuide: monthCloseActions?.requestMonthClose.guide,
    todayIso: new Date().toISOString(),
  }), [monthCloseActions?.requestMonthClose.guide, monthCloseActions?.requestMonthReopen.guide, monthCloseActions?.withdrawMonthClose.guide, monthCloseCycle?.commandCapabilities, monthCloseRequest?.approverName, monthCloseRequest?.requestedAt, monthCloseRequest?.requestedByName, monthCloseRequest?.requestedByUid, monthCloseRequest?.status, user?.uid]);

  const monthClosePreparation = useMemo(() => {
    if (monthCloseError) {
      return {
        status: 'STATUS_RETRY_REQUIRED' as const,
        title: '월 결산 상태를 다시 확인해 주세요.',
        detail: `${monthCloseError} 잠시 후 다시 확인해 주세요. 같은 문제가 계속되면 AXR팀에 문의해 주세요.`,
        actionLabel: '결산 상태 다시 확인',
      };
    }
    if (monthCloseLoading) {
      return {
        status: 'STATUS_LOADING' as const,
        title: '결산 상태를 확인하고 있습니다.',
        detail: '서버의 결산 가능일과 고정본 상태를 확인한 뒤 확정할 수 있습니다.',
        actionLabel: null,
      };
    }
    if (!monthCloseResult) {
      return {
        status: 'STATUS_RETRY_REQUIRED' as const,
        title: '월 결산 상태를 다시 확인해 주세요.',
        detail: '서버 상태를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요. 같은 문제가 계속되면 AXR팀에 문의해 주세요.',
        actionLabel: '결산 상태 다시 확인',
      };
    }
    if (!cashflowPresentation) {
      return {
        status: 'STATUS_RETRY_REQUIRED' as const,
        title: '월 결산 상태를 확인할 수 없습니다.',
        detail: '확인 불가',
        actionLabel: '결산 상태 다시 확인',
      };
    }
    if (!monthCloseTargetYearMonth
      || !monthDeadlineKnown
      || monthCloseCycle?.health !== 'OK'
      || monthCloseCycle.businessState === 'INCONSISTENT'
      || monthCloseCycle.commandCapabilities.SUBMIT_MONTH_CLOSE.allowed !== true) {
      return {
        status: 'SERVER_BLOCKED' as const,
        title: '월 결산을 진행할 수 없습니다.',
        detail: monthCloseActions?.requestMonthClose.guide || '확인 불가',
        actionLabel: null,
      };
    }
    return {
      status: 'READY' as const,
      title: '월 결산을 진행할 수 있습니다.',
      detail: '서버에서 월 결산 요청 가능 상태를 확인했습니다.',
      actionLabel: null,
    };
  }, [cashflowPresentation, monthCloseActions?.requestMonthClose.guide, monthCloseCycle, monthCloseError, monthCloseLoading, monthCloseResult, monthCloseTargetYearMonth, monthDeadlineKnown]);

  const handleSaveExecutiveApprover = useCallback(async (): Promise<void> => {
    if (monthCloseActions?.changeExecutiveApprover.enabled !== true) {
      return;
    }
    const approver = executiveApproverOptions.find((member) => member.uid === selectedExecutiveApproverId);
    if (!project || !approver) {
      return;
    }
    const mutationScope = captureMonthCloseMutationScope('approver');
    setExecutiveApproverBusy(true);
    try {
      const actor = await resolveBffActor();
      if (!isCurrentMonthCloseMutation(mutationScope)) return;
      if (!actor?.idToken) throw new Error('로그인 세션이 만료되었습니다.');
      const result = await saveCashflowMonthCloseApproverViaBff({
        tenantId: orgId,
        actor,
        projectId,
        payload: {
          approverUid: approver.uid,
          yearMonth,
          expectedVersion: project.version,
        },
        idempotencyKey: `cashflow-month-close-approver:${projectId}:${yearMonth}:${approver.uid}:${project.version ?? 0}`,
      });
      if (!isCurrentMonthCloseMutation(mutationScope, result)) return;
      setSavedExecutiveApproverId(result.executiveApproverId);
      setExecutiveApproverAttention(false);
      onExecutiveApproverSaved?.(result);
    } catch (error) {
      if (!isCurrentMonthCloseMutation(mutationScope)) return;
    } finally {
      if (isCurrentMonthCloseMutation(mutationScope)) setExecutiveApproverBusy(false);
    }
  }, [captureMonthCloseMutationScope, executiveApproverOptions, isCurrentMonthCloseMutation, monthCloseActions?.changeExecutiveApprover, onExecutiveApproverSaved, orgId, project, projectId, resolveBffActor, selectedExecutiveApproverId, yearMonth]);

  const handleOpenMonthCloseReview = useCallback((): void => {
    const summary = {
      status: monthClosePreparation.status,
      submitMonthCloseAllowed: monthCloseCycle?.commandCapabilities.SUBMIT_MONTH_CLOSE.allowed === true,
      requestMonthCloseGuide: monthCloseActions?.requestMonthClose.guide || '',
    };
    logCashflowSettlement({
      phase: 'info',
      operation: 'cashflow.month_close.review.open',
      projectId,
      yearMonth,
      summary,
    });
    if (!monthDeadlineKnown || monthCloseCycle?.commandCapabilities.SUBMIT_MONTH_CLOSE.allowed !== true) {
      return;
    }
    if (project && !savedExecutiveApproverId) {
      setExecutiveApproverAttention(true);
      return;
    }
    setMonthCloseReviewOpen(true);
    if (monthClosePreparation.status !== 'READY' && monthClosePreparation.status !== 'STATUS_LOADING') {
      logCashflowSettlement({
        phase: 'info',
        operation: 'cashflow.month_close.preflight.blocked',
        projectId,
        yearMonth,
        summary,
      });
    }
  }, [monthCloseActions?.requestMonthClose.guide, monthCloseCycle?.commandCapabilities.SUBMIT_MONTH_CLOSE.allowed, monthClosePreparation.status, monthDeadlineKnown, project, projectId, savedExecutiveApproverId, yearMonth]);

  const handleFinalizeMonthClose = useCallback(async (): Promise<void> => {
    if (!monthDeadlineKnown || monthCloseCycle?.commandCapabilities.SUBMIT_MONTH_CLOSE.allowed !== true) {
      return;
    }
    if (selectedProjectIdRef.current !== projectId || selectedYearMonthRef.current !== yearMonth) {
      return;
    }
    if (!yearMonth || !savedExecutiveApproverId || !monthCloseHumanReviewed) {
      if (!savedExecutiveApproverId) setExecutiveApproverAttention(true);
      return;
    }
    const reviewedOpeningBalances = monthCloseResult?.dashboard?.openingBalances;
    if (!reviewedOpeningBalances) {
      return;
    }

    const mutationScope = captureMonthCloseMutationScope('request');
    setMonthCloseBusy(true);
    const startedAt = Date.now();
    try {
      const actor = await resolveBffActor();
      if (!isCurrentMonthCloseMutation(mutationScope)) return;
      if (!actor?.idToken) throw new Error('로그인 세션이 만료되었습니다.');
      const prepared = await fetchCashflowMonthCloseViaBff({
        tenantId: orgId,
        actor,
        projectId,
        yearMonth,
      });
      if (!isCurrentMonthCloseMutation(mutationScope, prepared)) return;
      setMonthCloseResult(prepared);
      if (prepared.settlementCycle.commandCapabilities.SUBMIT_MONTH_CLOSE.allowed !== true) {
        throw new Error(
          prepared.actions.requestMonthClose.guide
            || '서버에서 월 결산 가능 상태를 확인하지 못했습니다.',
        );
      }
      if (prepared.targetYearMonth !== monthCloseTargetYearMonth
        || prepared.settlementCycle.cycleYearMonth !== yearMonth
        || prepared.settlementCycle.monthCloseTargetYearMonth !== prepared.targetYearMonth) {
        throw new Error('월 결산 회차와 대상 월을 다시 확인해 주세요.');
      }
      let monthCloseInput: CashflowMonthCloseDraftInput;
      try {
        if (monthCloseCellsState.error) throw new Error(monthCloseCellsState.error);
        const managementChecks = monthCloseResult?.dashboard?.managementChecks || [];
        monthCloseInput = buildCashflowMonthCloseDraftInput({
          mirror: monthClosePinnedSource,
          yearMonth: prepared.targetYearMonth,
          humanReviewed: monthCloseHumanReviewed,
          depositScheduleRows: monthCloseDepositRows,
          managementChecks,
          deadlineSummary: monthCloseResult?.dashboard?.deadlineSummary || {
            trackingStartedAt: null,
            missedCount: 0,
            completedCount: 0,
            current: null,
          } satisfies CashflowDeadlineSummary,
        });
      } catch (error) {
        logCashflowSettlement({
          phase: 'info',
          operation: 'cashflow.month_close.preflight.blocked',
          projectId,
          yearMonth,
          summary: { reason: 'draft_input_invalid', hasSheetConfig: Boolean(cashflowSheetConfig?.value) },
          error,
        });
        return;
      }
      logCashflowSettlement({
        phase: 'start',
        operation: 'cashflow.month_close.request',
        projectId,
        yearMonth,
        summary: { sourceRevision: monthCloseInput.sourceRevision, targetRevision: monthCloseInput.targetRevision },
      });
      const requestStartedAtIso = new Date().toISOString();
      let request: CashflowMonthCloseRequest;
      try {
        request = await requestCashflowMonthCloseViaBff({
          tenantId: orgId,
          actor,
          projectId,
          payload: {
            contractVersion: 'cashflow-cumulative-close-v2',
            yearMonth,
            expectedRevision: prepared.revision,
            expectedWorkflowRevision: prepared.settlementCycle.workflowRevision,
            expectedApproverUid: savedExecutiveApproverId,
            expectedProjectVersion: project?.version ?? 0,
            expectedOpeningBalances: reviewedOpeningBalances,
            closeInput: monthCloseInput,
          },
          idempotencyKey: `cashflow-month-close-request:${projectId}:${yearMonth}:${prepared.revision}:r${monthCloseRequest?.revision ?? -1}`,
        });
      } catch (error) {
        // 브라우저가 27초에 끊어도 서버는 저장까지 갈 수 있다(첫 누적 요청은 43개월 shard).
        // 타임아웃은 실패가 아니라 모름이다. 서버에 이번 요청이 남았는지 확인하고 둘 중 하나만 말한다.
        if (!isRequestTimeoutError(error) || !isCurrentMonthCloseMutation(mutationScope)) throw error;
        setMonthCloseError('요청 결과를 확인하고 있어요. 잠시만 기다려 주세요.');
        const reconciled = await reconcileMonthCloseRequestAfterTimeout({
          fetchCurrent: async () => (
            await fetchCashflowMonthCloseViaBff({ tenantId: orgId, actor, projectId, yearMonth })
          ).monthState,
          actorUid: actor.uid,
          startedAtIso: requestStartedAtIso,
        });
        if (!isCurrentMonthCloseMutation(mutationScope)) return;
        setMonthCloseError(null);
        if (!reconciled || reconciled.projectId !== projectId || reconciled.yearMonth !== yearMonth) {
          throw new Error('월 결산 요청이 접수되지 않았어요. 잠시 후 다시 시도해 주세요.');
        }
        request = reconciled;
      }
      if (!isCurrentMonthCloseMutation(mutationScope, request)) return;
      if (request.status !== 'PENDING_APPROVAL') throw new Error('월결산 결재 요청 상태를 확인하지 못했습니다.');
      setMonthCloseReviewOpen(false);
      setMonthCloseReviewDirty(false);
      if (!isCurrentMonthCloseMutation(mutationScope, request)) return;
      await loadCashflowMonthClose();
      if (!isCurrentMonthCloseMutation(mutationScope, request)) return;
      toast.success('월 결산 승인 요청을 보냈어요. 조직장 승인을 기다립니다.');
      logCashflowSettlement({
        phase: 'success',
        operation: 'cashflow.month_close.request',
        projectId,
        yearMonth,
        durationMs: Date.now() - startedAt,
        summary: { status: request.status, revision: request.revision },
      });
    } catch (error) {
      if (!isCurrentMonthCloseMutation(mutationScope)) return;
      logCashflowSettlement({
        phase: 'error',
        operation: 'cashflow.month_close.request',
        projectId,
        yearMonth,
        durationMs: Date.now() - startedAt,
        error,
      });
      await loadCashflowMonthClose();
      if (!isCurrentMonthCloseMutation(mutationScope)) return;
    } finally {
      if (isCurrentMonthCloseMutation(mutationScope)) setMonthCloseBusy(false);
    }
  }, [
    cashflowSheetConfig?.value,
    captureMonthCloseMutationScope,
    isCurrentMonthCloseMutation,
    monthClosePinnedSource,
    loadCashflowMonthClose,
    monthCloseCellsState,
    monthCloseDepositRows,
    monthCloseHumanReviewed,
    monthCloseResult,
    monthCloseTargetYearMonth,
    monthCloseActions?.requestMonthClose,
    monthCloseCycle?.commandCapabilities.SUBMIT_MONTH_CLOSE.allowed,
    monthDeadlineKnown,
    monthCloseRequest?.revision,
    orgId,
    projectId,
    project?.version,
    savedExecutiveApproverId,
    resolveBffActor,
    yearMonth,
  ]);

  const handleWithdrawMonthCloseRequest = useCallback(async (): Promise<void> => {
    if (!monthDeadlineKnown || monthCloseCycle?.commandCapabilities.WITHDRAW_MONTH_CLOSE.allowed !== true) {
      return;
    }
    const authorityCycleYearMonth = monthCloseRequest?.cycleYearMonth;
    const authorityTargetYearMonth = monthCloseRequest?.monthCloseTargetYearMonth;
    const authorityWorkflowRevision = monthCloseRequest?.workflowRevision;
    if (!monthCloseRequest?.manifestHash
      || !isYearMonth(authorityCycleYearMonth)
      || !isYearMonth(authorityTargetYearMonth)
      || typeof authorityWorkflowRevision !== 'number'
      || !Number.isSafeInteger(authorityWorkflowRevision)
      || authorityWorkflowRevision < 0) return;
    const startedAt = Date.now();
    const mutationScope = captureMonthCloseMutationScope('withdraw');
    setMonthCloseBusy(true);
    try {
      const actor = await resolveBffActor();
      if (!isCurrentMonthCloseMutation(mutationScope)) return;
      if (!actor?.idToken) throw new Error('로그인 세션이 만료되었습니다.');
      if (!isCurrentMonthCloseMutation(mutationScope) || monthCloseRequest.projectId !== projectId) return;
      const { request } = await withdrawCashflowMonthCloseRequestViaBff({
        tenantId: orgId,
        actor,
        projectId,
        requestId: monthCloseRequest.requestId,
        payload: {
          cycleYearMonth: authorityCycleYearMonth,
          monthCloseTargetYearMonth: authorityTargetYearMonth,
          expectedRevision: monthCloseRequest.revision,
          expectedManifestHash: monthCloseRequest.manifestHash,
          expectedWorkflowRevision: authorityWorkflowRevision,
          reason: monthCloseWithdrawReason.trim(),
        },
        idempotencyKey: `cashflow-month-close-withdraw:${monthCloseRequest.requestId}:r${monthCloseRequest.revision}`,
      });
      if (!isCurrentMonthCloseMutation(mutationScope) || request.projectId !== projectId) return;
      setMonthCloseWithdrawOpen(false);
      setMonthCloseWithdrawReason('');
      await loadCashflowMonthClose();
      if (!isCurrentMonthCloseMutation(mutationScope)) return;
      toast.success('월 결산 요청을 회수했어요.');
      logCashflowSettlement({
        phase: 'success',
        operation: 'cashflow.month_close.withdraw',
        projectId,
        yearMonth,
        durationMs: Date.now() - startedAt,
        summary: { status: request.status, revision: request.revision },
      });
    } catch (error) {
      if (!isCurrentMonthCloseMutation(mutationScope)) return;
      logCashflowSettlement({
        phase: 'error',
        operation: 'cashflow.month_close.withdraw',
        projectId,
        yearMonth,
        durationMs: Date.now() - startedAt,
        error,
      });
      await loadCashflowMonthClose();
      if (!isCurrentMonthCloseMutation(mutationScope)) return;
    } finally {
      if (isCurrentMonthCloseMutation(mutationScope)) setMonthCloseBusy(false);
    }
  }, [
    captureMonthCloseMutationScope,
    isCurrentMonthCloseMutation,
    loadCashflowMonthClose,
    monthCloseCycle?.commandCapabilities.WITHDRAW_MONTH_CLOSE.allowed,
    monthCloseRequest,
    monthCloseWithdrawReason,
    monthDeadlineKnown,
    orgId,
    projectId,
    resolveBffActor,
    yearMonth,
  ]);

  const handleMonthReopenAction = useCallback(async (): Promise<void> => {
    const reason = reopenReason.trim();
    if (!reopenAction || !monthCloseRequest || !reason) {
      return;
    }
    if (!monthDeadlineKnown) {
      return;
    }
    if (reopenAction === 'request' && monthCloseCycle?.commandCapabilities.REQUEST_MONTH_REOPEN.allowed !== true) {
      return;
    }
    if (reopenAction === 'approve' && !canApproveReopen) {
      return;
    }
    if (reopenAction === 'reject' && !canRejectReopen) {
      return;
    }
    const expectedRevision = monthCloseRequest.ledgerRevision;
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) {
      return;
    }

    const mutationScope = captureMonthCloseMutationScope('reopen');
    setMonthCloseBusy(true);
    try {
      const actor = await resolveBffActor();
      if (!isCurrentMonthCloseMutation(mutationScope)) return;
      if (!actor?.idToken) throw new Error('로그인 세션이 만료되었습니다.');
      if (!isCurrentMonthCloseMutation(mutationScope) || monthCloseRequest.projectId !== projectId) return;
      const idempotencyKey = `cashflow-month-reopen:${reopenAction}:${projectId}:${monthCloseRequest.requestId}:${expectedRevision}`;
      const result = reopenAction === 'request'
        ? await requestCashflowMonthReopenViaBff({
            tenantId: orgId,
            actor,
            projectId,
            payload: {
              requestId: monthCloseRequest.requestId,
              yearMonth: monthCloseRequest.yearMonth,
              expectedRevision,
              reason,
            },
            idempotencyKey,
          })
        : await decideCashflowMonthReopenViaBff({
            tenantId: orgId,
            actor,
            projectId,
            payload: {
              requestId: monthCloseRequest.requestId,
              yearMonth: monthCloseRequest.yearMonth,
              expectedRevision,
              decision: reopenAction === 'approve' ? 'APPROVE' : 'REJECT',
              reason,
            },
            idempotencyKey,
          });
      if (!isCurrentMonthCloseMutation(mutationScope) || result.request.projectId !== projectId) return;
      await loadCashflowMonthClose();
      if (!isCurrentMonthCloseMutation(mutationScope)) return;
      void reloadCashflowActivityForMutations('month_reopen_completed');
      setReopenAction(null);
      setReopenReason('');
      if (portalMode) {
        toast.success(reopenAction === 'request'
          ? '월 결산 재오픈 요청을 보냈어요.'
          : reopenAction === 'approve'
            ? '월 결산 재오픈을 승인했어요.'
            : '월 결산 재오픈을 반려했어요.');
      }
    } catch (error) {
      if (!isCurrentMonthCloseMutation(mutationScope)) return;
    } finally {
      if (isCurrentMonthCloseMutation(mutationScope)) setMonthCloseBusy(false);
    }
  }, [canApproveReopen, canRejectReopen, captureMonthCloseMutationScope, isCurrentMonthCloseMutation, loadCashflowMonthClose, monthCloseCycle?.commandCapabilities.REQUEST_MONTH_REOPEN.allowed, monthCloseRequest, monthDeadlineKnown, orgId, portalMode, projectId, reloadCashflowActivityForMutations, reopenAction, reopenReason, resolveBffActor, yearMonth]);

  const handleRefreshSheetMirror = useCallback(async (): Promise<CashflowSheetLabMirrorResult | null> => {
    if (!cashflowSheetConfig?.value) {
      logCashflowSettlement({
        phase: 'info',
        operation: 'cashflow.month_close.preflight.sheet_refresh.blocked',
        projectId,
        yearMonth,
        summary: { reason: 'sheet_config_missing' },
      });
      return null;
    }
    const startedAt = Date.now();
    const refreshIdempotencyKey = `cashflow-sheet-refresh:${projectId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const refreshMirror = (actor: NonNullable<Awaited<ReturnType<typeof resolveBffActor>>>) => (
      refreshCashflowSheetLabMirrorViaBff({
        tenantId: orgId,
        actor,
        projectId,
        sourceYear: cashflowSheetConfig.sourceYear,
        value: cashflowSheetConfig.value,
        sheetName: cashflowSheetConfig.sheetName || undefined,
        idempotencyKey: refreshIdempotencyKey,
      })
    );
    const rememberMirror = (mirror: CashflowSheetLabMirrorResult) => {
      setCashflowSheetMirror((current) => mirror.status === 'STALE' && current?.sourceRevision
        ? {
            ...current,
            ...mirror,
            sourceRevision: mirror.sourceRevision || current.sourceRevision,
            capturedAt: mirror.capturedAt || current.capturedAt,
            summary: mirror.summary || current.summary,
            cells: mirror.cells || current.cells,
          }
        : mirror);
      if (mirror.status === 'FRESH' && mirror.sourceRevision) {
        void reloadCashflowActivityForMutations('sheet_mirror_refreshed');
        } else if (mirror.status === 'STALE') {
        } else {
      }
    };
    setSheetRefreshLoading(true);
    logCashflowSettlement({
      phase: 'start',
      operation: 'cashflow.sheet_refresh',
      projectId,
      yearMonth,
      summary: { sourceYear: cashflowSheetConfig.sourceYear, hasSheetConfig: true },
    });
    try {
      const actor = await resolveBffActor();
      if (!actor?.idToken) {
        return null;
      }
      const mirror = await refreshMirror(actor);
      rememberMirror(mirror);
      logCashflowSettlement({
        phase: 'success',
        operation: 'cashflow.sheet_refresh',
        projectId,
        yearMonth,
        durationMs: Date.now() - startedAt,
        summary: { mirrorStatus: mirror.status, hasSourceRevision: Boolean(mirror.sourceRevision) },
      });
      return mirror;
    } catch (error) {
      if (isBffAuthRejection(error)) {
        try {
          const actor = await resolveBffActor({ forceRefresh: true });
          if (!actor?.idToken) throw error;
          const mirror = await refreshMirror(actor);
          rememberMirror(mirror);
          logCashflowSettlement({
            phase: 'success',
            operation: 'cashflow.sheet_refresh',
            projectId,
            yearMonth,
            durationMs: Date.now() - startedAt,
            summary: { mirrorStatus: mirror.status, hasSourceRevision: Boolean(mirror.sourceRevision), retriedAuth: true },
          });
          return mirror;
        } catch (retryError) {
          logCashflowSettlement({
            phase: 'error',
            operation: 'cashflow.sheet_refresh',
            projectId,
            yearMonth,
            durationMs: Date.now() - startedAt,
            error: retryError,
          });
          return null;
        }
      }
      logCashflowSettlement({
        phase: 'error',
        operation: 'cashflow.sheet_refresh',
        projectId,
        yearMonth,
        durationMs: Date.now() - startedAt,
        error,
      });
      return null;
    } finally {
      setSheetRefreshLoading(false);
    }
  }, [cashflowSheetConfig, orgId, projectId, reloadCashflowActivityForMutations, resolveBffActor, selectedYear, yearMonth]);

  const handleMonthClosePreparationAction = useCallback(async (): Promise<void> => {
    if (monthClosePreparation.status === 'STATUS_RETRY_REQUIRED') {
      logCashflowSettlement({
        phase: 'start',
        operation: 'cashflow.month_close.preflight.status_retry',
        projectId,
        yearMonth,
      });
      await loadCashflowMonthClose();
    }
  }, [loadCashflowMonthClose, monthClosePreparation.status, projectId, yearMonth]);

  const handleApplyStagedSheetValues = useCallback(async (
    stage: CashflowSheetLabStageResult,
    closedMonthChangeReason = '',
    acceptFormulaMismatches = false,
    acceptPendingApprovalDifferences = false,
  ): Promise<void> => {
    if (!stage.runId || stage.stagedLineCount <= 0) return;
    const applyIdempotencyKey = `cashflow-sheet-apply-stage:${projectId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    // 건수·내용은 검토 단계의 변경 후보로 말한다. 서버의 appliedLineCount 는 다시 쓴 월의
    // 전체 셀 수(월당 160)라 "2건 바꿨는데 160건" 이 된다.
    const notifySheetApplied = () => {
      const notice = buildSheetApplyNotice({ stagedLineCount: stage.stagedLineCount, candidates: stage.candidates });
      toast.success(notice.title, notice.lines.length > 0 ? { description: notice.lines.join('\n') } : undefined);
    };
    const apply = async (actor: NonNullable<Awaited<ReturnType<typeof resolveBffActor>>>) => {
      return applyCashflowSheetLabViaBff({
        tenantId: orgId,
        actor,
        projectId,
        stageRunId: stage.runId,
        replaceAllActualSources: true,
        closedMonthChangeReason,
        closedMonthDifferenceCount: stage.closedMonthDifferenceCount,
        closedMonthDifferenceManifestHash: stage.closedMonthDifferenceManifestHash,
        acceptPendingApprovalDifferences,
        pendingApprovalDifferenceCount: stage.pendingApprovalDifferenceCount,
        pendingApprovalDifferenceManifestHash: stage.pendingApprovalDifferenceManifestHash,
        acceptFormulaMismatches,
        idempotencyKey: applyIdempotencyKey,
      });
    };
    const rememberApplyResult = async (result: Awaited<ReturnType<typeof apply>>) => {
      void Promise.allSettled([
        loadCashflowEvents(),
        loadCashflowMonthClose(),
      ]);
      setCashflowSheetConfig((current) => current ? {
        ...current,
        lastAppliedAt: result.lastAppliedAt,
        lastAppliedBy: result.lastAppliedBy,
        lastAppliedLineCount: result.appliedLineCount,
        lastProjectionLineCount: result.projectionLineCount,
        lastActualLineCount: result.actualLineCount,
      } : current);
      setLateSheetApply(null);
      setSheetApplyResumeRequired(false);
      setLateSheetResumeReason('');
      setLateSheetFormulaAccepted(false);
      setLateSheetPendingApprovalAccepted(false);
      setFormulaMismatchPrompt(null);
      setPendingApprovalStage(null);
      setPendingApprovalClosedMonthChangeReason('');
      setPendingApprovalFormulaAccepted(false);
    };

    setSheetStageApplyLoading(true);
    setSheetOperationError('');
    logCashflowSettlement({
      phase: 'start',
      operation: 'cashflow.sheet_apply',
      projectId,
      summary: { stagedRunId: stage.runId, stagedLineCount: stage.stagedLineCount, reasonProvided: Boolean(closedMonthChangeReason.trim()) },
    });
    try {
      const actor = await resolveBffActor();
      if (!actor?.idToken) {
        toast.error('로그인 정보를 확인하지 못했습니다. 다시 로그인한 뒤 시도해 주세요.');
        return;
      }
      const result = await apply(actor);
      await rememberApplyResult(result);
      notifySheetApplied();
      logCashflowSettlement({ phase: 'success', operation: 'cashflow.sheet_apply', projectId, summary: { appliedLineCount: result.appliedLineCount } });
    } catch (error) {
      let finalError = error;
      if (isBffAuthRejection(error)) {
        try {
          const actor = await resolveBffActor({ forceRefresh: true });
          if (!actor?.idToken) throw error;
          const result = await apply(actor);
          await rememberApplyResult(result);
          notifySheetApplied();
          logCashflowSettlement({ phase: 'success', operation: 'cashflow.sheet_apply', projectId, summary: { appliedLineCount: result.appliedLineCount, authRetried: true } });
          return;
        } catch (retryError) {
          finalError = retryError;
        }
      }
      logCashflowSettlement({ phase: 'error', operation: 'cashflow.sheet_apply', projectId, error: finalError });
      if (bffErrorCode(finalError) === 'cashflow_formula_mismatch_confirmation_required') {
        const issues = cashflowFormulaMismatchesFromError(finalError);
        if (issues.length > 0) {
          setLateSheetApply(null);
          setSheetApplyResumeRequired(false);
          setFormulaMismatchPrompt({ stage, issues, closedMonthChangeReason, acceptPendingApprovalDifferences });
          return;
        }
      }
      if (bffErrorCode(finalError) === 'cashflow_closed_month_reason_required') {
        const details = (finalError as {
          body?: { details?: { closedMonthDifferences?: CashflowSheetLabStageResult['closedMonthDifferences'] } };
        }).body?.details;
        setLateSheetApply({
          ...stage,
          closedMonthDifferences: details?.closedMonthDifferences?.length
            ? details.closedMonthDifferences
            : stage.closedMonthDifferences,
        });
        setLateSheetFormulaAccepted(acceptFormulaMismatches);
        setLateSheetPendingApprovalAccepted(acceptPendingApprovalDifferences);
        setSheetApplyResumeRequired(false);
        return;
      }
      if (bffErrorCode(finalError) === 'cashflow_pending_approval_confirmation_required') {
        const details = (finalError as {
          body?: { details?: Pick<CashflowSheetLabStageResult, 'pendingApprovalDifferences' | 'pendingApprovalDifferenceCount' | 'pendingApprovalDifferenceManifestHash'> };
        }).body?.details;
        setLateSheetApply(null);
        setSheetApplyResumeRequired(false);
        setPendingApprovalStage({
          ...stage,
          pendingApprovalDifferences: details?.pendingApprovalDifferences?.length
            ? details.pendingApprovalDifferences
            : stage.pendingApprovalDifferences,
          pendingApprovalDifferenceCount: details?.pendingApprovalDifferenceCount ?? stage.pendingApprovalDifferenceCount,
          pendingApprovalDifferenceManifestHash: details?.pendingApprovalDifferenceManifestHash || stage.pendingApprovalDifferenceManifestHash,
        });
        setPendingApprovalClosedMonthChangeReason(closedMonthChangeReason);
        setPendingApprovalFormulaAccepted(acceptFormulaMismatches);
        return;
      }
      if (isCashflowSheetApplyResultUncertain(finalError)) {
        setLateSheetApply(stage);
        setLateSheetResumeReason(closedMonthChangeReason);
        setLateSheetFormulaAccepted(acceptFormulaMismatches);
        setLateSheetPendingApprovalAccepted(acceptPendingApprovalDifferences);
        setSheetApplyResumeRequired(true);
      } else {
        setLateSheetApply(null);
        setSheetApplyResumeRequired(false);
        setLateSheetPendingApprovalAccepted(false);
        toast.error(resolveApiErrorMessage(finalError, '시트 값을 반영하지 못했습니다. 잠시 후 다시 시도해 주세요.'));
        setSheetOperationError(sheetOperationErrorMessage(finalError));
      }
    } finally {
      setSheetStageApplyLoading(false);
    }
  }, [loadCashflowEvents, loadCashflowMonthClose, orgId, projectId, resolveBffActor]);

  useEffect(() => {
    let cancelled = false;
    if (!monthCloseSettled || !projectId || !orgId || !user?.uid) return () => { cancelled = true; };
    const loadApplyStatus = async (): Promise<void> => {
      try {
        const actor = await resolveBffActor();
        if (!actor?.idToken) return;
        const status = await getCashflowSheetLabApplyStatusViaBff({ tenantId: orgId, actor, projectId });
        if (cancelled || status.status !== 'APPLYING' || !status.stagedRun) return;
        setLateSheetApply(status.stagedRun);
        setLateSheetResumeReason(status.applyInput?.closedMonthChangeReason || '');
        setLateSheetFormulaAccepted(status.applyInput?.acceptFormulaMismatches === true);
        setLateSheetPendingApprovalAccepted(status.applyInput?.acceptPendingApprovalDifferences === true);
        setSheetApplyResumeRequired(true);
      } catch {
        // 복구 상태 조회 실패는 일반 조회를 막지 않는다. 실제 반영 시 서버가 다시 차단한다.
      }
    };
    void loadApplyStatus();
    return () => {
      cancelled = true;
    };
  }, [monthCloseSettled, orgId, projectId, resolveBffActor, user?.uid]);

  const handleStagePinnedSheetValues = useCallback(async (
    replaceAllActualSources = true,
    mirrorOverride?: CashflowSheetLabMirrorResult,
  ): Promise<void> => {
    const sourceMirror = mirrorOverride || cashflowSheetMirror;
    if (sourceMirror?.status !== 'FRESH' || !sourceMirror.sourceRevision) {
      return;
    }
    const stageIdempotencyKey = `cashflow-sheet-stage:${projectId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const stageMirror = (actor: NonNullable<Awaited<ReturnType<typeof resolveBffActor>>>) => stageCashflowSheetLabViaBff({
      tenantId: orgId,
      actor,
      projectId,
      expectedMirrorRevision: sourceMirror.sourceRevision,
      ...(replaceAllActualSources ? { replaceAllActualSources: true } : {}),
      idempotencyKey: stageIdempotencyKey,
    });
    const applyStageResult = async (result: CashflowSheetLabStageResult) => {
      if (result.status === 'BLOCKED') {
        const contractIssue = result.pendingApprovalContractIssues?.[0];
        const blockedMonths = (contractIssue?.blockedMonths || result.blockedMonths || []).join(', ');
        const message = contractIssue
          ? `${contractIssue.message}${blockedMonths ? ` 확인할 월: ${blockedMonths}` : ''}`
          : `반영할 수 없는 시트 범위가 있습니다.${blockedMonths ? ` 확인할 월: ${blockedMonths}` : ''}`;
        toast.error(message);
        setSheetOperationError(message);
        return;
      }
      if (result.stagedLineCount <= 0) {
        toast.success('MYSCube가 이미 시트 최신값과 같습니다.');
        return;
      }
      if (result.closedMonthDifferences?.length) {
        setLateSheetApply(result);
        setLateSheetResumeReason('');
        setLateSheetFormulaAccepted(false);
        setLateSheetPendingApprovalAccepted(false);
        setSheetApplyResumeRequired(false);
        return;
      }
      if (result.pendingApprovalDifferences?.length) {
        setPendingApprovalStage(result);
        setPendingApprovalClosedMonthChangeReason('');
        setPendingApprovalFormulaAccepted(false);
        return;
      }
      await handleApplyStagedSheetValues(result);
    };
    setSheetRefreshLoading(true);
    setSheetOperationError('');
    logCashflowSettlement({
      phase: 'start',
      operation: 'cashflow.sheet_stage',
      projectId,
      summary: { expectedMirrorRevision: sourceMirror.sourceRevision, replaceAllActualSources },
    });
    try {
      const actor = await resolveBffActor();
      if (!actor?.idToken) {
        toast.error('로그인 정보를 확인하지 못했습니다. 다시 로그인한 뒤 시도해 주세요.');
        return;
      }
      const stage = await stageMirror(actor);
      await applyStageResult(stage);
      logCashflowSettlement({
        phase: 'success',
        operation: 'cashflow.sheet_stage',
        projectId,
        summary: {
          stageRunId: stage.runId,
          status: stage.status,
          stagedLineCount: stage.stagedLineCount,
          nextStep: stage.pendingApprovalDifferences?.length || stage.closedMonthDifferences?.length ? 'confirmation' : 'apply',
        },
      });
    } catch (error) {
      if (isBffAuthRejection(error)) {
        try {
          const actor = await resolveBffActor({ forceRefresh: true });
          if (!actor?.idToken) throw error;
          await applyStageResult(await stageMirror(actor));
          return;
        } catch (retryError) {
          toast.error(resolveApiErrorMessage(retryError, '시트 변경 검토를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.'));
          setSheetOperationError(sheetOperationErrorMessage(retryError));
          return;
        }
      } else {
        toast.error(resolveApiErrorMessage(error, '시트 변경 검토를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.'));
      }
      setSheetOperationError(sheetOperationErrorMessage(error));
    } finally {
      setSheetRefreshLoading(false);
    }
  }, [cashflowSheetMirror, handleApplyStagedSheetValues, orgId, projectId, resolveBffActor]);

  const handleRefreshAndApplySheetValues = useCallback(async (): Promise<void> => {
    const startedAt = Date.now();
    logCashflowSettlement({
      phase: 'start',
      operation: 'cashflow.sheet_sync.one_click',
      projectId,
      yearMonth,
      summary: { steps: ['refresh', 'stage', 'apply'] },
    });
    const mirror = await handleRefreshSheetMirror();
    if (mirror?.status !== 'FRESH' || !mirror.sourceRevision) {
      toast.error(mirror?.lastRefreshError?.message || '시트 최신값을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.');
      logCashflowSettlement({
        phase: 'error',
        operation: 'cashflow.sheet_sync.one_click',
        projectId,
        yearMonth,
        durationMs: Date.now() - startedAt,
        summary: { completedStep: 'refresh', mirrorStatus: mirror?.status || 'EMPTY' },
      });
      return;
    }
    logCashflowSettlement({
      phase: 'info',
      operation: 'cashflow.sheet_sync.one_click',
      projectId,
      yearMonth,
      durationMs: Date.now() - startedAt,
      summary: { completedStep: 'refresh', nextStep: 'stage' },
    });
    await handleStagePinnedSheetValues(true, mirror);
    logCashflowSettlement({
      phase: 'info',
      operation: 'cashflow.sheet_sync.one_click',
      projectId,
      yearMonth,
      durationMs: Date.now() - startedAt,
      summary: { completedStep: 'stage', nextStep: 'apply_or_confirmation' },
    });
  }, [handleRefreshSheetMirror, handleStagePinnedSheetValues, projectId, yearMonth]);

  const handleDeferredRefreshAndApplySheetValues = useCallback(async (): Promise<void> => {
    const oneClickActivityScope = activityScope;
    if (cashflowActivityOneClickRef.current.scope !== oneClickActivityScope) {
      cashflowActivityOneClickRef.current = {
        scope: oneClickActivityScope,
        depth: 0,
        pendingAggregate: false,
        pendingSources: new Set<CashflowActivitySource>(),
      };
    }
    if (cashflowActivityOneClickRef.current.depth === 0) cashflowActivityOneClickRef.current.pendingSources.clear();
    cashflowActivityOneClickRef.current.depth += 1;
    try {
      await handleRefreshAndApplySheetValues();
    } finally {
      if (cashflowActivityOneClickRef.current.scope === oneClickActivityScope) {
        cashflowActivityOneClickRef.current.depth -= 1;
        setCashflowActivityDrainVersion((current) => current + 1);
      }
    }
  }, [activityScope, handleRefreshAndApplySheetValues]);

  const handleOpenSheetOnboarding = useCallback(() => {
    setSheetReviewDialogOpen(true);
  }, []);

  const handleStartSheetChangeReview = useCallback(async (replaceAllActualSources = true): Promise<void> => {
    setSheetReviewDialogOpen(false);
    await handleStagePinnedSheetValues(replaceAllActualSources);
  }, [handleStagePinnedSheetValues]);

  const handleRevertCashflowRun = useCallback(async (_runId: string): Promise<void> => {
  }, []);

  function getWeekLabel(weekNo: number, targetYearMonth = yearMonth): string {
    return cashflowPresentation?.weeks.find((week) => (
      week.yearMonth === targetYearMonth && week.weekNo === weekNo
    ))?.label || '확인 불가';
  }

  const previousAnnualYears = cashflowPresentation?.annualBefore || [];
  const followingAnnualYears = cashflowPresentation?.annualAfter || [];
  const comparisonCells = cashflowPresentation?.comparison.cells || [];
  const sheetFormulaValues = monthCloseResult?.dashboard?.sheetFormulaValues;
  const sheetFormulaValuesAvailable = sheetFormulaValues?.status !== 'UNAVAILABLE';
  const annualTotalFor = (year: number, mode: 'projection' | 'actual') => (
    sheetFormulaValuesAvailable ? sheetFormulaValues?.annual.find((total) => total.year === year)?.[mode] ?? null : null
  );
  const annualSummaryValue = (
    year: number,
    mode: 'projection' | 'actual',
    kind: 'totalIn' | 'totalOut' | 'net',
  ) => annualTotalFor(year, mode)?.[kind] ?? null;
  const projectLineTotalFor = (mode: 'projection' | 'actual', lineId: CashflowSheetLineId) => {
    const total = sheetFormulaValuesAvailable ? sheetFormulaValues?.grandTotals?.[mode] : undefined;
    const state = total?.lineStates?.[lineId];
    const amount = total?.lineAmounts?.[lineId];
    if (state === 'VALUE' || state === 'ZERO') return isSafeCashflowNumber(amount) ? amount : undefined;
    return state === 'EMPTY' ? null : undefined;
  };

  const cashflowTotalPeriodLabel = cashflowPresentation?.comparison.periodLabel || '확인 불가';
  const currentPresentationWeek = cashflowPresentation?.weeks.find((week) => week.isCurrent);
  const sheetRangeLabel = cashflowSheetConfig
    ? `${cashflowSheetConfig.sheetName || '시트 탭'} · 탭 전체`
    : '연결된 Google Sheet가 없습니다.';
  const sheetIdentityLabel = cashflowSheetConfig
    ? cashflowSheetConfig.spreadsheetTitle || cashflowSheetConfig.spreadsheetId || 'Google Sheet'
    : '시트 연결 필요';
  const sheetChangedSinceMirror = cashflowSheetFreshness?.status === 'AVAILABLE'
    && cashflowSheetFreshness.sheetChangedSinceMirror === true;
  const sheetMirrorStatus = cashflowSheetMirror?.status || 'EMPTY';
  const configuredSheetUrl = (() => {
    try {
      const url = new URL(cashflowSheetConfig?.value || '');
      return url.protocol === 'https:' && url.hostname === 'docs.google.com' && url.pathname.startsWith('/spreadsheets/')
        ? url.toString()
        : '';
    } catch {
      return '';
    }
  })();
  const sheetMirrorCapturedAt = formatSheetAppliedAt(cashflowSheetMirror?.capturedAt)
    || cashflowSheetMirror?.capturedAt
    || '';

  const opsSummary = monthCloseResult?.operationsSummary;

  function diffTextClass(diff: number): string {
    return diff === 0 ? 'text-slate-400' : 'text-slate-800';
  }

  function getServerReadCell(params: {
    targetYearMonth: string;
    mode: 'projection' | 'actual';
    weekNo: number;
    lineId: CashflowSheetLineId;
  }): { amount: number | null | undefined; hasValue: boolean; mismatch: boolean } {
    const month = monthCloseResult?.dashboard?.canonical?.months?.find((candidate) => candidate.yearMonth === params.targetYearMonth);
    const week = month?.[params.mode]?.weeks?.find((candidate) => candidate.weekNo === params.weekNo);
    const comparisonLine = month?.comparison?.weeks
      ?.find((candidate) => candidate.weekNo === params.weekNo)
      ?.lines?.find((candidate) => candidate.lineId === params.lineId);
    const amounts = week?.amounts || {};
    const hasValue = Object.prototype.hasOwnProperty.call(amounts, params.lineId);
    const amount = amounts[params.lineId];
    return {
      amount: !hasValue ? null : isSafeCashflowNumber(amount) ? amount : undefined,
      hasValue,
      mismatch: comparisonLine?.mismatch === true,
    };
  }

  function renderProjectionCell(input: {
    targetYearMonth: string;
    weekNo: number;
    lineId: CashflowSheetLineId;
    isAltRow: boolean;
    surfaceTone?: CashflowMonthClosePresentationWeek['surfaceTone'];
    overdue?: boolean;
  }) {
    const persisted = getServerReadCell({ ...input, mode: 'projection' });
    const shouldHighlightMismatch = persisted.mismatch;
    const bgClass = cashflowSurfaceClass(input.surfaceTone, input.overdue) || (input.isAltRow ? 'bg-slate-50' : 'bg-white');

    return (
      <td key={`${input.lineId}-${input.targetYearMonth}-${input.weekNo}-p`} className={`min-w-[84px] border-l-[6px] border-l-white px-1 py-1 align-middle ${bgClass}`}>
        {persisted.amount === null ? (
          <div className="py-0.5 text-center text-[12px] text-slate-400">미입력</div>
        ) : persisted.amount === undefined ? (
          <div className="py-0.5 text-center text-[12px]"><span className="text-red-700">확인 불가</span></div>
        ) : (
          <div className={`h-5 px-1 text-right text-[12px] leading-5 tabular-nums ${shouldHighlightMismatch ? 'font-semibold text-red-700' : 'text-slate-900'}`}>
            {fmt(persisted.amount)}
          </div>
        )}
      </td>
    );
  }

  function renderActualCell(input: {
    targetYearMonth: string;
    weekNo: number;
    lineId: CashflowSheetLineId;
    isAltRow: boolean;
    surfaceTone?: CashflowMonthClosePresentationWeek['surfaceTone'];
    overdue?: boolean;
  }) {
    const persisted = getServerReadCell({ ...input, mode: 'actual' });
    const bgClass = cashflowSurfaceClass(input.surfaceTone, input.overdue) || (input.isAltRow ? 'bg-slate-50' : 'bg-white');

    return (
      <td key={`${input.lineId}-${input.targetYearMonth}-${input.weekNo}-a`} className={`min-w-[84px] border-l-[6px] border-l-white px-1 py-1 align-middle ${bgClass}`}>
        {persisted.amount === null ? (
          <div className="py-0.5 text-center text-[12px] text-slate-400">미입력</div>
        ) : persisted.amount === undefined ? (
          <div className="py-0.5 text-center text-[12px]"><span className="text-red-700">확인 불가</span></div>
        ) : (
          <div className="h-5 px-1 text-right text-[12px] leading-5 tabular-nums text-slate-700">
            {fmt(persisted.amount)}
          </div>
        )}
      </td>
    );
  }

  function renderSummaryCell(input: {
    keyName: string;
    value: number | null | undefined;
    mode: 'projection' | 'actual';
    isAltRow?: boolean;
    surfaceTone?: CashflowMonthClosePresentationWeek['surfaceTone'];
    overdue?: boolean;
    emphasis?: 'income' | 'expense' | 'balance';
    stickyRight?: boolean;
    rowTone?: 'income' | 'expense';
  }) {
    const bgClass = cashflowSurfaceClass(input.surfaceTone, input.overdue) || (input.emphasis
      ? 'bg-[#EAF0F5]'
      : input.isAltRow
          ? 'bg-slate-50'
          : 'bg-white');
    const valueClass = input.emphasis ? 'text-slate-950' : 'text-slate-800';
    return (
      <td key={input.keyName} className={`min-w-[84px] border-l-[6px] border-l-white px-1 py-1 align-middle ${input.stickyRight ? 'sticky right-0 z-20 shadow-[-12px_0_24px_rgba(15,23,42,0.08)]' : ''} ${bgClass}`}>
        <div className="flex items-center justify-end gap-1 text-[12px] leading-4">
          <span className={`font-semibold tabular-nums ${input.mode === 'actual' ? 'text-slate-700' : valueClass}`}>
            {input.value === null
              ? <span className="text-slate-400">미입력</span>
              : input.value === undefined
                ? <span className="text-red-700">확인 불가</span>
                : fmt(input.value)}
          </span>
        </div>
      </td>
    );
  }

  function renderUnifiedMonthlyBoard() {
    if (monthCloseLoading && !monthCloseResult?.dashboard?.canonical) {
      return (
        <div className="rounded-[18px] border border-slate-200 bg-white px-3 py-8 text-center text-[12px] text-slate-500">
          서버 확정 시트와 기간 합계를 불러오는 중입니다.
        </div>
      );
    }
    if (cashflowSourceUnavailable) {
      return (
        <div className="rounded-[18px] border border-red-200 bg-red-50 px-3 py-8 text-center text-[12px] text-red-700">
          <p>{cashflowSourceUnavailableGuide}</p>
          <p>확인되지 않은 금액은 표시하지 않습니다.</p>
          <button type="button" className="mt-3 rounded-lg border border-red-300 bg-white px-3 py-1.5 font-semibold" onClick={() => void loadCashflowMonthClose()}>
            다시 확인
          </button>
        </div>
      );
    }
    if (shouldHideCashflowValuesAfterLoadError(monthCloseError, Boolean(monthCloseResult?.dashboard?.canonical))) {
      return (
        <div className="rounded-[18px] border border-red-200 bg-red-50 px-3 py-8 text-center text-[12px] text-red-700">
          <p>현금흐름 데이터를 불러오지 못했습니다.</p>
          <button type="button" className="mt-3 rounded-lg border border-red-300 bg-white px-3 py-1.5 font-semibold" onClick={() => void loadCashflowMonthClose()}>
            다시 확인
          </button>
        </div>
      );
    }
    if (!cashflowPresentation) {
      return (
        <div role="alert" className="rounded-[18px] border border-red-200 bg-red-50 px-3 py-8 text-center text-[12px] text-red-700">
          현금흐름 표시 기준을 확인할 수 없습니다. 다시 불러와 주세요.
        </div>
      );
    }
    const visibleWeeks = annualWeeks;
    const monthGroups = cashflowPresentation?.months || [];
    const boardColumnCount = previousAnnualYears.length + visibleWeeks.length + followingAnnualYears.length + 2;
    const sheetDerivedAmount = (
      mode: 'projection' | 'actual',
      targetYearMonth: string,
      weekNo: number,
      kind: 'totalIn' | 'totalOut' | 'net',
    ) => {
      const reported = sheetFormulaValuesAvailable ? sheetFormulaValues?.weekly.find((check) => (
        check.mode === mode && check.yearMonth === targetYearMonth && check.weekNo === weekNo
      ))?.reported : undefined;
      return kind === 'totalIn'
        ? reported?.depositTotal ?? null
        : kind === 'totalOut'
          ? reported?.withdrawalTotal ?? null
          : reported?.balance ?? null;
    };
    const projectTotalsFor = (mode: 'projection' | 'actual') => {
      const total = sheetFormulaValuesAvailable ? sheetFormulaValues?.grandTotals?.[mode] : undefined;
      return { totalIn: total?.totalIn ?? null, totalOut: total?.totalOut ?? null, net: total?.net ?? null };
    };
    const scrollBoard = (direction: -1 | 1) => {
      const container = cashflowBoardScrollRef.current;
      if (!container) return;
      const weekColumn = container.querySelector<HTMLElement>('[data-cashflow-board-column="true"]');
      const weekWidth = weekColumn?.getBoundingClientRect().width || 84;
      container.scrollTo({
        left: getSnappedWeekScrollLeft({
          currentLeft: container.scrollLeft,
          direction,
          viewportWidth: container.clientWidth,
          maxScrollLeft: container.scrollWidth - container.clientWidth,
          weekWidth,
        }),
        behavior: 'smooth',
      });
    };
    const renderAnnualLineCell = (mode: 'projection' | 'actual', lineId: CashflowSheetLineId, year: number, isAltRow: boolean) => {
      const total = annualTotalFor(year, mode);
      const state = total?.lineStates?.[lineId];
      const value = total?.lineAmounts?.[lineId];
      return (
        <td key={`${mode}-${lineId}-${year}-annual`} data-cashflow-board-column="true" className={`min-w-[84px] border-l-[6px] border-l-white px-1 py-1 text-right align-middle text-[12px] tabular-nums text-slate-700 ${isAltRow ? 'bg-slate-50' : 'bg-white'}`}>
          {state === 'EMPTY'
            ? <span className="text-slate-400">미입력</span>
            : (state === 'VALUE' || state === 'ZERO') && isSafeCashflowNumber(value)
              ? fmt(value)
              : <span className="text-red-700">확인 불가</span>}
        </td>
      );
    };
    const renderAnnualSummaryCell = (
      mode: 'projection' | 'actual',
      kind: 'totalIn' | 'totalOut' | 'net',
      year: number,
      emphasis: 'income' | 'expense' | 'balance',
      rowTone?: 'income' | 'expense',
    ) => renderSummaryCell({
      keyName: `${mode}-${kind}-${year}-annual`,
      value: annualSummaryValue(year, mode, kind),
      mode,
      emphasis,
      rowTone,
    });
    const renderModeLineRows = (
      mode: 'projection' | 'actual',
      lineIds: CashflowSheetLineId[],
      tone: 'income' | 'expense',
    ) => lineIds.map((lineId, rowIndex) => {
      const emphasized = lineId === 'MYSC_PREPAY_IN' || lineId.startsWith('MYSC_PREPAY_');
      const projectLineTotal = projectLineTotalFor(mode, lineId);
      return (
        <tr key={`${mode}-${lineId}`} data-cashflow-row="line" className="border-t border-white transition-colors hover:brightness-[0.98]">
          <td className={`sticky left-0 z-20 w-[192px] min-w-[192px] border-r-[6px] border-r-white px-3 py-2 text-[12px] leading-4 ${tone === 'income' ? 'text-emerald-700' : 'text-red-700'} ${rowIndex % 2 === 0 ? 'bg-white' : 'bg-slate-50'} ${emphasized ? 'font-bold' : 'font-medium'}`}>
            {renderCashflowLineLabel(getCashflowModeLineLabel(lineId, mode))}
          </td>
          {previousAnnualYears.map((annual) => renderAnnualLineCell(mode, lineId, annual.year, rowIndex % 2 === 1))}
          {visibleWeeks.map((week) => mode === 'projection'
            ? renderProjectionCell({ targetYearMonth: week.yearMonth, weekNo: week.weekNo, lineId, isAltRow: rowIndex % 2 === 1, surfaceTone: week.surfaceTone, overdue: week.overdue })
            : renderActualCell({ targetYearMonth: week.yearMonth, weekNo: week.weekNo, lineId, isAltRow: rowIndex % 2 === 1, surfaceTone: week.surfaceTone, overdue: week.overdue }))}
          {followingAnnualYears.map((annual) => renderAnnualLineCell(mode, lineId, annual.year, rowIndex % 2 === 1))}
          {renderSummaryCell({
            keyName: `${mode}-${lineId}-range`,
            value: projectLineTotal,
            mode,
            isAltRow: rowIndex % 2 === 1,
            stickyRight: true,
          })}
        </tr>
      );
    });
    const renderSummaryRow = (
      mode: 'projection' | 'actual',
      kind: 'totalIn' | 'totalOut' | 'net',
    ) => {
      const isIncome = kind === 'totalIn';
      const isExpense = kind === 'totalOut';
      const label = isIncome ? '입금 합계' : isExpense ? '출금 합계' : mode === 'projection' ? '잔액 (※ 중요)' : '잔액';
      const rowTone = isIncome ? 'income' : isExpense ? 'expense' : undefined;
      const emphasis = isIncome ? 'income' : isExpense ? 'expense' : 'balance';
      return (
        <tr key={`${mode}-${kind}`} data-cashflow-row={kind} className="border-t-[6px] border-white bg-[#EAF0F5]">
          <td className="sticky left-0 z-20 w-[192px] min-w-[192px] border-r-[6px] border-r-white bg-[#EAF0F5] px-3 py-2 text-[12px] font-bold text-[#17324D]">
            {label}
          </td>
          {previousAnnualYears.map((annual) => renderAnnualSummaryCell(mode, kind, annual.year, emphasis, rowTone))}
          {visibleWeeks.map((week) => renderSummaryCell({
            keyName: `${mode}-${kind}-${week.yearMonth}-${week.weekNo}`,
            value: sheetDerivedAmount(mode, week.yearMonth, week.weekNo, kind),
            mode,
            surfaceTone: week.surfaceTone,
            overdue: week.overdue,
            emphasis,
            rowTone,
          }))}
          {followingAnnualYears.map((annual) => renderAnnualSummaryCell(mode, kind, annual.year, emphasis, rowTone))}
          {renderSummaryCell({
            keyName: `${mode}-${kind}-range`,
            value: projectTotalsFor(mode)[kind],
            mode,
            emphasis,
            stickyRight: true,
            rowTone,
          })}
        </tr>
      );
    };
    const renderModeTable = (mode: 'projection' | 'actual') => (
      <table className="w-full border-separate border-spacing-0 text-[12px]" style={{ minWidth: `${192 + (boardColumnCount - 1) * 84}px` }}>
        <thead className="sticky top-0 z-40 bg-white/95 text-slate-600 backdrop-blur shadow-[0_10px_24px_rgba(15,23,42,0.06)]">
          <tr>
            <th rowSpan={3} className="sticky left-0 z-50 w-[192px] min-w-[192px] border-r-[6px] border-r-white bg-white px-3 py-2 text-left text-[12px] font-bold text-slate-800">
              항목
            </th>
            {previousAnnualYears.map((annual) => (
              <th rowSpan={3} key={`${mode}-${annual.year}-before`} data-cashflow-board-column="true" className="min-w-[84px] border-l-[6px] border-l-white bg-slate-100 px-1 py-2 text-center align-middle font-semibold">
                <div className="text-[12px] font-bold text-slate-800">{annual.label}</div>
                <div className="text-[12px] font-normal text-slate-400">누적</div>
              </th>
            ))}
            {monthGroups.map((month) => {
              const monthHeadClass = month.tone === 'closed'
                ? 'border-b-slate-500 bg-slate-300 text-slate-800'
                : month.tone === 'danger' || month.tone === 'unavailable'
                  ? 'border-b-red-400 bg-red-200 text-red-900'
                  : 'border-b-slate-200 bg-slate-100 text-slate-600';
              return (
                <th colSpan={month.columnCount} key={`${mode}-${month.yearMonth}-month`} className={`border-b-2 border-l-[6px] border-l-white px-2 py-1.5 text-left align-middle ${monthHeadClass}`}>
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] font-bold">
                    {month.label}
                    {month.locked ? <LockKeyhole className="h-3.5 w-3.5" aria-label="누적 월 결산 완료 월 수정 잠김" /> : null}
                    {month.badgeLabel ? (
                      <span className="rounded bg-red-700 px-1.5 py-0.5 text-[12px] font-bold text-white">{month.badgeLabel}</span>
                    ) : null}
                  </span>
                </th>
              );
            })}
            {followingAnnualYears.map((annual) => (
              <th rowSpan={3} key={`${mode}-${annual.year}-after`} data-cashflow-board-column="true" className="min-w-[84px] border-l-[6px] border-l-white bg-slate-100 px-1 py-2 text-center align-middle font-semibold">
                <div className="text-[12px] font-bold text-slate-800">{annual.label}</div>
                <div className="text-[12px] font-normal text-slate-400">합계</div>
              </th>
            ))}
            <th rowSpan={3} className="sticky right-0 z-50 min-w-[84px] border-l-[6px] border-l-white bg-white px-1 py-2 text-left text-[12px] font-bold text-slate-800 shadow-[-12px_0_24px_rgba(15,23,42,0.08)]">
              Total
            </th>
          </tr>
          <tr>
            {visibleWeeks.map((week) => (
                <th key={`${mode}-${week.yearMonth}-${week.weekNo}-weekly-close`} data-cashflow-board-column="true" className={`min-w-[84px] border-l-[6px] border-l-white px-1 py-1 text-center align-middle ${cashflowSurfaceClass(week.surfaceTone, week.overdue) || 'bg-white'}`}>
                  <span className={`inline-flex items-center gap-1 whitespace-nowrap text-[12px] font-semibold ${week.surfaceTone === 'danger' || week.surfaceTone === 'unavailable' ? 'text-red-700' : week.weeklyStatusLabel ? 'text-slate-700' : 'text-slate-300'}`}>
                    {week.surfaceTone === 'closed' ? <LockKeyhole className="h-3 w-3" aria-hidden="true" /> : <CheckCircle2 className="h-3 w-3" />}
                    {week.weeklyStatusLabel || '주간 정산 상태 확인 필요'}
                  </span>
                </th>
            ))}
          </tr>
          <tr>
            {visibleWeeks.map((week) => (
                <th key={`${mode}-${week.yearMonth}-${week.weekNo}`} data-cashflow-board-column="true" className={`min-w-[84px] border-l-[6px] border-l-white px-1 py-1.5 text-center align-top font-semibold ${cashflowSurfaceClass(week.surfaceTone) || 'bg-slate-50'}`}>
                  <span className="block truncate text-[12px] font-bold leading-5 text-slate-800">{week.label}</span>
                </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {renderModeLineRows(mode, CASHFLOW_IN_LINES, 'income')}
          {renderSummaryRow(mode, 'totalIn')}
          {renderModeLineRows(mode, CASHFLOW_OUT_LINES, 'expense')}
          {renderSummaryRow(mode, 'totalOut')}
          {renderSummaryRow(mode, 'net')}
        </tbody>
      </table>
    );
    return (
      <Card className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
            <div>
              <div className="text-[15px] font-bold tracking-[-0.01em] text-slate-950">현금흐름 관리시트</div>
              <div className="mt-1 text-[12px] text-slate-500">조회 전용 · 값은 시트 값 불러오기로만 반영됩니다.</div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <label className="flex items-center gap-1 text-[12px] font-semibold text-slate-600">
                <span className="sr-only">결산 대상 월</span>
                <Input
                  type="month"
                  value={yearMonth}
                  className="h-8 w-[138px] rounded-full border-0 bg-white px-3 text-[12px] shadow-sm disabled:bg-slate-200 disabled:text-slate-500"
                  onChange={(event) => setYearMonth(event.target.value)}
                />
              </label>
              <Badge className={`h-8 rounded-full border-0 px-3 text-[12px] ${monthCloseStatusClass}`}>
                {monthCloseLoading ? '상태 확인 중' : monthCloseStatusLabel}
              </Badge>
            </div>
          </div>
          {!sheetFormulaValuesAvailable ? (
            <div role="alert" className="mx-4 mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              최신 시트 수식값과 반영된 데이터의 revision이 일치하지 않아, 합계·잔액은 표시하지 않습니다. 시트 값을 다시 가져온 뒤 반영해 주세요.
            </div>
          ) : null}
          <div className="relative bg-slate-100 px-4 pb-4">
            <Button type="button" variant="outline" size="sm" className="absolute left-2 top-1/2 z-50 h-8 w-8 -translate-y-1/2 border border-slate-200 bg-white/95 p-0 shadow-sm" onClick={() => scrollBoard(-1)} aria-label="왼쪽 주차로 이동">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button type="button" variant="outline" size="sm" className="absolute right-2 top-1/2 z-50 h-8 w-8 -translate-y-1/2 border border-slate-200 bg-white/95 p-0 shadow-sm" onClick={() => scrollBoard(1)} aria-label="오른쪽 주차로 이동">
              <ChevronRight className="h-4 w-4" />
            </Button>
            {/* 스크롤 컨테이너는 하나여야 한다. sticky 는 가장 가까운 스크롤 조상에만 붙으므로
                (w3c/csswg-drafts#9140), 표마다 overflow-x 래퍼를 두면 주차 헤더의 sticky top 은
                페이지 세로 스크롤에서 아무것도 하지 못하고, Projection·ACTUAL 의 가로 스크롤도
                서로 어긋난다. 세로·가로 스크롤을 이 컨테이너 안으로 모아 헤더·항목 열이 실제로
                고정되고 두 표가 항상 같은 주차 열을 보이게 한다. */}
            <section
              ref={cashflowBoardScrollRef}
              className="max-h-[calc(100vh-240px)] space-y-5 overflow-auto scroll-smooth rounded-md border border-slate-200 bg-white p-3"
              tabIndex={0}
              aria-label="Projection과 Actual 현금흐름 스크롤 표"
            >
              <div className="w-max min-w-full" data-cashflow-block="projection" data-cashflow-row-count={CASHFLOW_ALL_LINES.length + 3}>
                <h3 className="sticky left-0 z-30 w-fit border-l-4 border-[#17324D] bg-[#17324D] px-3 py-2 text-[14px] font-bold text-white">Projection</h3>
                {renderModeTable('projection')}
              </div>
              <div className="w-max min-w-full" data-cashflow-block="actual" data-cashflow-row-count={CASHFLOW_ALL_LINES.length + 3}>
                <h3 className="sticky left-0 z-30 w-fit border-l-4 border-[#17324D] bg-[#17324D] px-3 py-2 text-[14px] font-bold text-white">ACTUAL</h3>
                {renderModeTable('actual')}
              </div>
            </section>
          </div>
          {monthCloseLoading ? <div className="px-3 py-2 text-[12px] text-slate-500">불러오는 중...</div> : null}
        </CardContent>
      </Card>
    );
  }


  function renderProjectionActualDiffTable() {
    const columnCount = comparisonCells.length;
    if (monthCloseResult?.dashboard?.snapshotCompatibility?.status === 'LEGACY_EVIDENCE_ONLY') {
      return (
        <div className="rounded-md border border-slate-300 bg-slate-50 px-3 py-5 text-[12px] leading-5 text-[#17324D]">
          이전 형식으로 결산된 월이라 전체 기간의 항목별 차이 근거는 표시하지 않습니다. 결산 당시 보관된 월 값만 읽을 수 있습니다.
        </div>
      );
    }
    if (monthCloseLoading) {
      return <div className="rounded-[18px] border border-slate-200 bg-white px-3 py-8 text-center text-[12px] text-slate-500">BFF 차이값을 불러오는 중...</div>;
    }
    if (sheetFormulaValues?.status === 'UNAVAILABLE') {
      return (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-5 text-[12px] leading-5 text-red-700">
          최신 시트 수식값과 반영된 데이터의 revision이 일치하지 않아 Projection–Actual 차이를 표시하지 않습니다. 시트 값을 다시 가져온 뒤 반영해 주세요.
        </div>
      );
    }
    if (monthCloseError || !monthCloseResult?.dashboard?.canonical?.range) {
      return (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-6 text-center text-[12px] text-red-700">
          <div>{monthCloseError || '서버 확정 시트와 기간 합계를 불러오지 못했습니다. 화면을 다시 확인해 주세요.'}</div>
          {monthCloseErrorPresentation ? (
            <>
              <div className="mt-1 text-[12px] text-red-700">
                {monthCloseErrorPresentation.resolution === 'retry' ? '상태: 다시 시도 가능' : monthCloseErrorPresentation.resolution === 'wait' ? '상태: 기다린 뒤 확인' : '상태: 담당자 확인 필요'}
              </div>
              {monthCloseErrorPresentation.code || monthCloseErrorPresentation.requestId ? (
                <div className="mt-1 text-[12px] text-red-600">
                  {[monthCloseErrorPresentation.code, monthCloseErrorPresentation.requestId].filter(Boolean).join(' · ')}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      );
    }
    if (!cashflowPresentation) {
      return <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-6 text-center text-[12px] text-red-700">확인 불가</div>;
    }
    return (
      <Card className="overflow-hidden border-slate-200">
        <CardContent className="space-y-3 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[12px] font-semibold text-slate-950">
                <HoverExplain message="현금흐름 관리시트의 Projection–Actual 차이 수식 결과를 그대로 표시합니다.">
                  Projection - Actual 차이
                </HoverExplain>
              </div>
              <div className="text-[12px] text-slate-500">
                현금흐름 관리시트 E11:BL11 주별 수식 기준
              </div>
            </div>
            <Badge className="rounded-md border border-[#C7D3DF] bg-[#EAF0F5] px-2.5 py-1 text-[12px] text-[#17324D]">시트 수식값</Badge>
          </div>
          <div className="overflow-x-auto rounded-md border border-slate-200 bg-white p-2">
            <table className="border-separate border-spacing-0 text-[12px]" style={{ minWidth: `${220 + columnCount * 96}px` }}>
              <thead className="bg-white text-slate-500">
                <tr>
                  <th className="sticky left-0 z-20 w-[220px] min-w-[220px] border-r-[6px] border-r-white bg-white px-3 py-2 text-left font-medium">항목</th>
                  {comparisonCells.map((cell) => (
                    <th key={`${cell.yearMonth}-${cell.weekNo}`} className="min-w-[96px] border-l-[6px] border-l-white bg-slate-50/80 px-2 py-2 text-right font-medium">
                      <div>{cell.weekLabel}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-t-[6px] border-white">
                  <td className="sticky left-0 z-10 w-[220px] min-w-[220px] border-r-[6px] border-r-white bg-white px-3 py-2">
                    <div className="truncate text-emerald-700">Projection - Actual 차이</div>
                  </td>
                  {comparisonCells.map((cell) => {
                    const rowSurface = 'bg-white';
                    const differenceClass = cell.difference === null || cell.difference === 0
                      ? `${rowSurface} text-slate-500`
                      : 'bg-[#EAF0F5] text-sky-700';
                    return (
                      <td
                        key={`sheet-projection-actual-difference-${cell.yearMonth}-${cell.weekNo}`}
                        className={`min-w-[96px] border-l-[6px] border-l-white px-2 py-2 text-right font-semibold tabular-nums ${differenceClass}`}
                        title={cell.difference === null ? `${cell.weekRange}\n시트 수식값 없음` : `${cell.weekRange}\n시트 차이 ${fmtSigned(cell.difference)}`}
                      >
                        {cell.difference === null ? '미입력' : fmtSigned(cell.difference)}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    );
  }

  function opsToneClass(tone: CashflowOpsTone): string {
    if (tone === 'danger') return 'border-red-200 bg-red-50 text-red-800';
    if (tone === 'warning') return 'border-border bg-accent text-accent-foreground';
    if (tone === 'success') return 'border-border bg-secondary text-secondary-foreground';
    if (tone === 'info') return 'border-border bg-accent text-accent-foreground';
    return 'border-border bg-secondary text-secondary-foreground';
  }

  function opsDotClass(tone: CashflowOpsTone): string {
    if (tone === 'danger') return 'bg-red-500';
    if (tone === 'warning') return 'bg-sky-600';
    if (tone === 'success') return 'bg-slate-500';
    if (tone === 'info') return 'bg-[#17324D]';
    return 'bg-slate-400';
  }

  function opsSubtleBgClass(tone: CashflowOpsTone): string {
    if (tone === 'danger') return 'bg-red-50';
    if (tone === 'warning') return 'bg-accent';
    if (tone === 'success') return 'bg-secondary';
    if (tone === 'info') return 'bg-accent';
    return 'bg-secondary';
  }

  function renderRateTile(label: string, rate?: CashflowOperationsRate) {
    const tone = label === 'Projection'
      ? { surface: 'border-border bg-accent', value: 'text-primary', bar: 'bg-primary' }
      : { surface: 'border-border bg-card', value: 'text-foreground', bar: 'bg-sky-600' };
    const summaryDescription = opsSummary?.status.detail || '확인 불가';
    const primaryValue = rate?.percent === null || rate?.percent === undefined
      ? rate?.statusLabel || (monthCloseLoading ? '확인 중' : '확인 불가')
      : `${rate.percent}%`;
    const statusLabel = rate?.statusLabel || (monthCloseLoading ? '로딩' : '확인 불가');
    return (
      <div className={`min-w-[158px] rounded-md border px-3.5 py-3 shadow-none ${tone.surface}`} title="BFF/JVM 서버 요약값">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12px] font-semibold leading-4 text-muted-foreground">{label}</div>
          <div className="text-[12px] tabular-nums text-muted-foreground">서버 기준</div>
        </div>
        <div className="mt-1 flex items-end justify-between gap-2">
          <span className={`text-[22px] font-bold leading-6 tabular-nums ${tone.value}`}>
            {primaryValue}
          </span>
          <span className={`truncate text-right text-[12px] font-semibold leading-4 ${tone.value}`}>{statusLabel}</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          {rate?.state === 'AVAILABLE' ? <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${rate.barPercent}%` }} /> : null}
        </div>
        <div className="mt-1.5 text-[12px] leading-4 text-muted-foreground">{summaryDescription}</div>
      </div>
    );
  }

  function renderOperationsSummary() {
    return (
      <div className={`grid gap-2 ${compact ? '' : 'md:grid-cols-3'}`}>
        {renderRateTile('Projection', opsSummary?.rates.projection)}
        {renderRateTile('Actual', opsSummary?.rates.actual)}
        <div className="min-w-[158px] rounded-md border border-border bg-accent px-3.5 py-3 shadow-none" title="JVM 누적 Projection-Actual 요약값">
          <div className="mb-1 text-[12px] font-semibold leading-4 text-muted-foreground">결산</div>
          <CashflowCanonicalSummary
            summary={monthCloseResult?.dashboard?.projectionActualSummary}
            loading={monthCloseLoading}
            error={Boolean(monthCloseError) || cashflowSourceUnavailable}
            onRetry={monthCloseErrorPresentation?.resolution === 'contact' ? undefined : () => void loadCashflowMonthClose()}
          />
        </div>
      </div>
    );
  }

  function renderPortalSettlementPanel() {
    const renderScheduleDetails = (steps: ScheduleStep[], suppressOverdue = false) => (
      <div className="mt-3 space-y-2 text-center">
        {steps.map((step) => (
          <div key={step.key} className="text-[12px] leading-4 text-slate-600">
            <div className={`font-semibold ${portalScheduleStepClass(step.state, suppressOverdue)}`}>
              {step.label} · {portalScheduleStepStateLabel(step.state)}
            </div>
            <div className="mt-0.5 text-slate-500">{step.detail || '확인 불가'}</div>
          </div>
        ))}
      </div>
    );

    const renderWeeklyAction = () => {
      /*
       * 할 동작이 없으면 버튼을 그리지 않는다. 완료 요청도 확정도 끝난 주에 비활성
       * "주간 정산 확인 중" 버튼이 남으면, 위 단계에 "완료" 라고 적어 놓고 아래에서
       * 아직 확인 중이라고 말하는 셈이다. "확인 중" 은 로딩일 때만 참이다.
       */
      if (!monthCloseLoading && !portalWeeklyAction && !portalWeeklyActionAmbiguous) return null;
      return (
      <Button
        type="button"
        size="sm"
        variant={portalWeeklyAction === 'confirm' ? 'default' : 'outline'}
        className={`mt-3 min-h-8 w-full rounded-md px-3 text-[12px] font-semibold ${portalWeeklyAction === 'confirm' ? 'bg-[#17324D] text-white hover:bg-slate-800' : 'border-slate-300 bg-white text-[#17324D]'}`}
        disabled={monthCloseLoading || portalWeeklyButtonBusy || !portalWeeklyAction}
        aria-label={`${portalWeeklyButtonLabel} · ${currentPresentationWeek?.label || '현재 주차'}`}
        title={portalWeeklyActionAmbiguous ? '여러 주간 정산 동작이 동시에 가능해 상태를 다시 확인해야 합니다.' : undefined}
        onClick={() => {
          if (portalWeeklyAction === 'complete') return handleOpenWeeklyCompletion();
          if (portalWeeklyAction === 'withdraw') return void handleWithdrawWeeklyUpdate();
          if (portalWeeklyAction === 'confirm') return void handleConfirmWeeklyUpdate();
        }}
      >
        {portalWeeklyButtonBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : portalWeeklyAction === 'withdraw' ? <Undo2 className="mr-1 h-3 w-3" /> : portalWeeklyAction === 'confirm' ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <ClipboardCheck className="mr-1 h-3 w-3" />}
        {portalWeeklyButtonLabel}
      </Button>
      );
    };

    const renderMonthlyAction = () => {
      // 주간과 같은 이유. 재오픈 검토자는 예외다(검토 버튼이 항상 있어야 한다).
      if (!monthCloseLoading && !portalMonthlyAction && !portalMonthlyActionAmbiguous && !canReviewReopen) return null;
      return (
      <div className="mt-3 flex flex-wrap gap-2">
        {!monthCloseError && !canReviewReopen ? (
          <Button
            type="button"
            size="sm"
            variant={portalMonthlyAction === 'request' ? 'default' : 'outline'}
            className={`min-h-8 w-full rounded-md px-3 text-[12px] font-semibold ${portalMonthlyAction === 'request' ? 'bg-[#17324D] text-white shadow-none hover:bg-slate-800' : 'border-slate-300 bg-white text-[#17324D]'}`}
            disabled={monthCloseBusy || monthCloseLoading || !monthDeadlineKnown || !portalMonthlyAction}
            aria-label={`${portalMonthlyButtonLabel} · ${yearMonth} 월`}
            title={portalMonthlyActionAmbiguous ? '여러 월결산 동작이 동시에 가능해 상태를 다시 확인해야 합니다.' : undefined}
            onClick={() => {
              if (portalMonthlyAction === 'request') return handleOpenMonthCloseReview();
              if (portalMonthlyAction === 'withdraw') {
                setMonthCloseWithdrawReason('');
                setMonthCloseWithdrawOpen(true);
                return;
              }
              if (portalMonthlyAction === 'reopen') {
                setReopenReason('');
                setReopenAction('request');
              }
            }}
          >
            {portalMonthlyButtonBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
            {portalMonthlyButtonLabel}
          </Button>
        ) : !monthCloseError && canReviewReopen ? (
          <>
            <Button type="button" size="sm" className="min-h-8 flex-1 rounded-md bg-[#17324D] px-3 text-[12px] text-white shadow-none hover:bg-slate-800" disabled={monthCloseBusy || monthCloseLoading || !monthDeadlineKnown || !canApproveReopen} onClick={() => { setReopenReason(''); setReopenAction('approve'); }}>재오픈 승인</Button>
            <Button type="button" size="sm" variant="outline" className="min-h-8 flex-1 rounded-md border-slate-300 bg-white px-3 text-[12px] text-slate-700" disabled={monthCloseBusy || monthCloseLoading || !monthDeadlineKnown || !canRejectReopen} onClick={() => { setReopenReason(''); setReopenAction('reject'); }}>재오픈 반려</Button>
          </>
        ) : null}
      </div>
      );
    };


    return (
      <section data-cashflow-settlement-actions className="overflow-hidden rounded-lg border border-border bg-border">
        <div className="bg-card px-4 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <div className="text-[15px] font-bold text-card-foreground">결산 · {yearMonth} 기준</div>
              <div className="mt-1 text-[12px] text-muted-foreground">주간·월간 결산 일정을 한 줄에서 확인합니다.</div>
            </div>
          </div>

          <div data-cashflow-portal-settlement-timeline className="mt-4 overflow-x-auto pb-2">
            <ol aria-label={`${yearMonth} 주정산·월결산 일정`} className="flex min-w-max items-start px-2">
              {portalTimelineNodes.map((node, index) => (
                <li key={node.key} className={`flex items-start ${index > 0 ? 'flex-1' : ''}`}>
                  {index > 0 ? <span aria-hidden="true" className={`mt-12 h-px min-w-8 flex-1 ${portalTimelineConnectorClass(portalTimelineNodes[index - 1].tone)}`} /> : null}
                  <div className="w-40 shrink-0 text-center">
                    <div className={`min-h-10 text-[12px] leading-4 ${portalTimelineTextClass(node.tone)}`}>
                      {node.label}
                      <div className="mt-0.5">{node.statusLabel}</div>
                      {node.periodLabel ? <div className="mt-0.5 text-slate-500">{node.periodLabel}</div> : null}
                    </div>
                    <span className={`mt-1 inline-flex h-6 w-6 items-center justify-center rounded-full border text-[12px] font-bold ${portalTimelineDotClass(node.tone)}`}>
                      {node.tone === 'closed' || node.tone === 'success' ? '✓' : node.tone === 'danger' ? '!' : node.tone === 'warning' ? '…' : '·'}
                    </span>
                    {node.kind === 'weekly' && node.current ? (
                      <div data-cashflow-portal-weekly-node className="px-2">
                        {renderScheduleDetails(weeklyScheduleSteps)}
                        {renderWeeklyAction()}
                      </div>
                    ) : null}
                    {node.kind === 'monthly' ? (
                      <div data-cashflow-portal-monthly-node className="px-2">
                        {renderScheduleDetails(monthScheduleSteps, true)}
                        {renderMonthlyAction()}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {monthCloseSectionErrors.length > 0 ? (
            <div role="status" className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-accent px-3 py-2 text-[12px] text-card-foreground">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>
                일부 정보를 불러오지 못했습니다
                {` (${monthCloseSectionErrors.map((entry) => entry.cause ? `${entry.label}: ${entry.cause}` : entry.label).join(', ')})`}
                . 관련 판정은 다시 조회하기 전까지 차단됩니다.
              </span>
              <button type="button" className="font-semibold underline underline-offset-2" disabled={monthCloseLoading} onClick={() => { void loadCashflowMonthClose(); }}>
                다시 불러오기
              </button>
            </div>
          ) : null}

          <div data-cashflow-portal-settlement-annotations className={`mt-5 grid gap-3 border-t border-border pt-4 ${compact ? '' : 'sm:grid-cols-2'}`}>
            <div className="text-[12px] leading-5 text-muted-foreground">
              <div className={`font-semibold ${portalTimelineTextClass(currentPresentationWeek?.surfaceTone || 'neutral')}`}>
                이번 주 주정산 · {currentPresentationWeek?.weeklyStatusLabel || '주간 정산 상태 확인 필요'}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>누적 미준수 <strong className="ml-1 text-red-700">{deadlineSummaryUnavailable ? '확인 불가' : formatCashflowCount(monthCloseResult?.dashboard?.deadlineSummary?.missedCount, '회')}</strong></span>
                <span>기한 내 완료 <strong className="ml-1 text-emerald-700">{deadlineSummaryUnavailable ? '확인 불가' : formatCashflowCount(monthCloseResult?.dashboard?.deadlineSummary?.completedCount, '회')}</strong></span>
                <button type="button" className="font-semibold text-[#17324D] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#17324D]" onClick={() => setWeeklyHistoryOpen(true)}>자세히</button>
              </div>
              {weeklyWithdrawError ? <div role="alert" className="mt-2 text-red-700">{weeklyWithdrawError}</div> : null}
              {weeklyActionNotice && !weeklyWithdrawError ? <div role="status" className="mt-2 text-emerald-700">{weeklyActionNotice}</div> : null}
            </div>

            <div className="text-[12px] leading-5 text-muted-foreground">
              <div className={`font-semibold ${portalTimelineTextClass(cashflowPresentation?.monthClose.tone || 'neutral')}`}>
                월결산 · {monthCloseLoading ? '상태 확인 중' : monthCloseStatusLabel}
              </div>
              {monthCloseNotice ? <div className={`mt-1 ${monthCloseNotice.tone === 'attention' ? 'font-semibold text-red-700' : ''}`}>{monthCloseNotice.text}</div> : null}
              {monthCloseBlockers.length > 0 ? <div role="alert" className="mt-2 text-red-700">월 결산을 진행할 수 없어요: {monthCloseBlockers.map((blocker) => blocker.message).join(' · ')}</div> : null}
            </div>
          </div>
        </div>
      </section>
    );
  }

  function renderOperationsPanel() {
    const statusBadgeLabel = opsSummary?.status.label || (monthCloseLoading ? '서버 검증 중' : '확인 불가');
    const statusTone: CashflowOpsTone = opsSummary?.status.tone || (monthCloseLoading ? 'neutral' : 'danger');
    const dashboardSummary = renderOperationsSummary();
    return (
      <Card className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-end gap-2">
              <ClipboardList className="h-4 w-4 shrink-0 text-primary" />
              <div className="truncate text-[16px] font-bold tracking-[-0.01em] text-card-foreground">{dashboardTitle}</div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 rounded-md border-slate-300 bg-white px-2.5 text-[12px] font-semibold text-[#17324D]"
                onClick={() => cashflowSheetConfig
                  ? navigate(`/portal/cashflow/${encodeURIComponent(projectId)}/sheets-lab`)
                  : handleOpenSheetOnboarding()}
              >
                {cashflowSheetConfig ? '시트 설정' : '시트 연결'}
              </Button>
              {configuredSheetUrl ? (
                <a
                  className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-[12px] font-semibold text-[#17324D] hover:bg-accent"
                  href={configuredSheetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <FileSpreadsheet className="mr-1 h-3 w-3" />
                  시트 이동
                </a>
              ) : null}
              {cashflowSheetConfig ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={`relative h-7 shrink-0 overflow-visible rounded-md px-2.5 text-[12px] font-semibold ${
                    sheetChangedSinceMirror
                      ? 'border-yellow-300 bg-yellow-50 text-yellow-900 hover:bg-yellow-100'
                      : 'border-slate-300 bg-white text-[#17324D] hover:bg-accent'
                  }`}
                  disabled={sheetRefreshLoading}
                  onClick={() => void handleDeferredRefreshAndApplySheetValues()}
                >
                  {sheetRefreshLoading ? <span aria-hidden="true" className="pointer-events-none absolute -inset-1 rounded-md border-2 border-transparent border-t-[#17324D] motion-safe:animate-spin" /> : null}
                  {sheetRefreshLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                  {sheetChangedSinceMirror ? '시트 변경됨 · 가져와 덮어쓰기' : '시트 값 가져와 덮어쓰기'}
                </Button>
              ) : null}
              {project && members ? (
                <div
                  id="project-executive-approver"
                  className={`flex min-w-[250px] items-end gap-2 border-l pl-2 ${executiveApproverAttention ? 'border-yellow-400 bg-yellow-50 ring-2 ring-yellow-300' : 'border-slate-200'}`}
                >
                  <div className="min-w-0 flex-1">
                    <label className="mb-1 block text-[12px] font-semibold text-slate-800">프로젝트 조직장</label>
                    <MemberPicker
                      className="h-7 border-slate-300 bg-white text-[12px]"
                      options={executiveApproverOptions}
                      value={selectedExecutiveApproverId}
                      onChange={setSelectedExecutiveApproverId}
                      placeholder="조직장 선택"
                      disabled={executiveApproverBusy || monthCloseActions?.changeExecutiveApprover.enabled !== true}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="relative h-7 shrink-0 overflow-visible border-slate-300 bg-white px-2.5 text-[12px] font-semibold text-[#17324D]"
                    disabled={executiveApproverBusy || !selectedExecutiveApproverId || selectedExecutiveApproverId === savedExecutiveApproverId || monthCloseActions?.changeExecutiveApprover.enabled !== true}
                    onClick={() => void handleSaveExecutiveApprover()}
                  >
                    {executiveApproverBusy ? <span aria-hidden="true" className="pointer-events-none absolute -inset-1 rounded-md border-2 border-transparent border-t-[#17324D] motion-safe:animate-spin" /> : null}
                    {executiveApproverBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                    저장
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="hidden text-[12px] text-muted-foreground sm:inline">기준일 {cashflowPresentation?.asOfDate || '확인 불가'}</span>
              <Badge className={`rounded-md px-2.5 py-1 text-[12px] shadow-none ${opsToneClass(statusTone)}`}>
                {statusBadgeLabel}
              </Badge>
            </div>
          </div>

          {sheetDashboardMetadata ? (
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              {[
                ['사업 타입', sheetDashboardMetadata.businessType?.value],
                ['전용 계좌사업', sheetDashboardMetadata.accountType?.value],
                ['정산 여부', sheetDashboardMetadata.settlementStatus?.value],
              ].filter(([, value]) => Boolean(value)).map(([label, value]) => (
                <span key={label} className="rounded-md border border-border bg-accent px-2.5 py-1 font-semibold text-accent-foreground">
                  <span className="mr-1 text-primary">{label}</span>{value}
                </span>
              ))}
              <span className="ml-1 border-l border-border pl-3 text-muted-foreground">
                세금계산서 발행일 · 입금일 · 입금액 주별 확인됨
              </span>
            </div>
          ) : null}

          {sheetOperationError ? (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-[12px] leading-5 text-red-800">
              {sheetOperationError}
            </div>
          ) : null}

          {portalMode ? renderPortalSettlementPanel() : (
          <section data-cashflow-settlement-actions className={`grid gap-px overflow-hidden rounded-md border border-border bg-border ${compact ? '' : 'md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'}`}>
              <div className="bg-card px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-bold text-card-foreground">주간 정산</div>
                    <div className="mt-1 text-[12px] leading-4 text-muted-foreground">
                      {currentPresentationWeek
                        ? `${currentPresentationWeek.label} · ${currentPresentationWeek.weeklyStatusLabel || '주간 정산 상태 확인 필요'}`
                        : '확인 불가'}
                    </div>
                  </div>
                  {monthCloseActions ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 shrink-0 rounded-md border-slate-300 bg-white px-3 text-[12px] font-semibold text-[#17324D]"
                      disabled={weeklyCompletionBusy || monthCloseLoading || !monthCloseActions.completeWeekly.enabled}
                      onClick={handleOpenWeeklyCompletion}
                    >
                      {weeklyCompletionBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <ClipboardCheck className="mr-1 h-3 w-3" />}
                      주간 정산 완료 요청
                    </Button>
                  ) : null}
                  {monthCloseActions?.reopenWeekly.enabled ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 shrink-0 rounded-md border-slate-300 bg-white px-3 text-[12px] font-semibold text-slate-700"
                      disabled={weeklyWithdrawBusy || monthCloseLoading}
                      onClick={() => void handleWithdrawWeeklyUpdate()}
                    >
                      {weeklyWithdrawBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Undo2 className="mr-1 h-3 w-3" />}
                      요청 회수
                    </Button>
                  ) : null}
                  {monthCloseActions?.confirmWeekly.enabled ? (
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 shrink-0 rounded-md bg-[#17324D] px-3 text-[12px] font-semibold text-white hover:bg-slate-800"
                      disabled={weeklyConfirmBusy || monthCloseLoading}
                      onClick={() => void handleConfirmWeeklyUpdate()}
                    >
                      {weeklyConfirmBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
                      주간 정산 확정
                    </Button>
                  ) : null}
                </div>
                {weeklyWithdrawError ? <div role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-800">{weeklyWithdrawError}</div> : null}
                {weeklyActionNotice && !weeklyWithdrawError ? <div role="status" className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] leading-5 text-emerald-900">{weeklyActionNotice}</div> : null}
                {weeklyScheduleSteps.length > 0 ? <CashflowScheduleBar steps={weeklyScheduleSteps} className="mt-3" /> : null}
                <div className="mt-3 flex items-center gap-4 text-[12px] text-muted-foreground">
                  <span>누적 미준수 <strong className="ml-1 text-red-700">{deadlineSummaryUnavailable ? '확인 불가' : formatCashflowCount(monthCloseResult?.dashboard?.deadlineSummary?.missedCount, '회')}</strong></span>
                  <span>기한 내 완료 <strong className="ml-1 text-primary">{deadlineSummaryUnavailable ? '확인 불가' : formatCashflowCount(monthCloseResult?.dashboard?.deadlineSummary?.completedCount, '회')}</strong></span>
                  <button type="button" className="font-semibold text-[#17324D] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#17324D]" onClick={() => setWeeklyHistoryOpen(true)}>자세히</button>
                </div>
              </div>
              {monthCloseSectionErrors.length > 0 ? (
                <div role="status" className="flex flex-wrap items-center gap-2 border-t border-border bg-accent px-4 py-2 text-[12px] text-card-foreground">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    일부 정보를 불러오지 못했습니다
                    {` (${monthCloseSectionErrors.map((entry) => entry.cause ? `${entry.label}: ${entry.cause}` : entry.label).join(', ')})`}
                    . 불러오지 못한 항목은 표시하지 않으며, 다시 조회하기 전까지 관련 판정은 차단됩니다.
                  </span>
                  <button
                    type="button"
                    className="font-semibold underline underline-offset-2"
                    disabled={monthCloseLoading}
                    onClick={() => { void loadCashflowMonthClose(); }}
                  >
                    다시 불러오기
                  </button>
                </div>
              ) : null}
              <div className="bg-card px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-[13px] font-bold text-card-foreground">월 결산</div>
                      <Badge className={`h-6 rounded-md px-2 text-[12px] shadow-none ${monthCloseStatusClass}`}>{monthCloseLoading ? '상태 확인 중' : monthCloseStatusLabel}</Badge>
                    </div>
                    {monthCloseBlockers.length > 0 ? (
                      <div role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-800">
                        <div className="flex items-center gap-1.5 font-bold">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          월 결산을 진행할 수 없어요
                        </div>
                        <ul className="mt-1 space-y-0.5">
                          {monthCloseBlockers.map((blocker) => (
                            <li key={blocker.code}>
                              · {blocker.message}
                              {blocker.lines.length > 0 ? (
                                <ul className="mt-0.5 ml-3 space-y-0.5 text-red-700">
                                  {blocker.lines.map((line) => <li key={line}>- {line}</li>)}
                                </ul>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : monthCloseNotice ? (
                      <div
                        role={monthCloseNotice.tone === 'attention' ? 'status' : undefined}
                        className={`mt-1 text-[12px] leading-4 ${monthCloseNotice.tone === 'attention' ? 'font-semibold text-red-700' : 'text-muted-foreground'}`}
                      >
                        {monthCloseNotice.text}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {monthCloseCycle?.commandCapabilities.SUBMIT_MONTH_CLOSE.allowed ? (
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 rounded-md bg-[#17324D] px-3 text-[12px] font-semibold text-white shadow-none hover:bg-slate-800"
                        disabled={monthCloseBusy || monthCloseLoading || !monthDeadlineKnown}
                        onClick={handleOpenMonthCloseReview}
                      >
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                        {portalMonthlyButtonLabel}
                      </Button>
                    ) : null}
                    {monthCloseCycle?.commandCapabilities.WITHDRAW_MONTH_CLOSE.allowed ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 rounded-md border-slate-300 bg-white px-3 text-[12px] text-slate-700"
                        disabled={monthCloseBusy || monthCloseLoading || !monthDeadlineKnown}
                        onClick={() => { setMonthCloseWithdrawReason(''); setMonthCloseWithdrawOpen(true); }}
                      >
                        결재 요청 회수
                      </Button>
                    ) : null}
                    {!monthCloseError && monthCloseCycle?.commandCapabilities.REQUEST_MONTH_REOPEN.allowed ? (
                      <Button type="button" size="sm" variant="outline" className="h-8 rounded-md border-slate-300 bg-white px-3 text-[12px] text-[#17324D]" disabled={!monthDeadlineKnown} onClick={() => { setReopenReason(''); setReopenAction('request'); }}>
                        재오픈 요청
                      </Button>
                    ) : null}
                    {!monthCloseError && canReviewReopen ? (
                      <>
                        <Button type="button" size="sm" className="h-8 rounded-md bg-[#17324D] px-3 text-[12px] text-white shadow-none hover:bg-slate-800" disabled={!monthDeadlineKnown || !canApproveReopen} onClick={() => { setReopenReason(''); setReopenAction('approve'); }}>재오픈 승인</Button>
                        <Button type="button" size="sm" variant="outline" className="h-8 rounded-md border-slate-300 bg-white px-3 text-[12px] text-slate-700" disabled={!monthDeadlineKnown || !canRejectReopen} onClick={() => { setReopenReason(''); setReopenAction('reject'); }}>재오픈 반려</Button>
                      </>
                    ) : null}
                  </div>
                </div>
                {monthScheduleSteps.length > 0 ? <CashflowScheduleBar steps={monthScheduleSteps} className="mt-3" /> : null}
              </div>
          </section>
          )}

          {cashflowSheetMirror?.lastRefreshError?.message ? (
            <div className="flex items-start justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
              <div className="min-w-0">
                <span className="font-semibold">시트 연동 오류: </span>{cashflowSheetMirror.lastRefreshError.message}
                {cashflowSheetMirror.lastRefreshError.diagnostics?.length ? (
                  <ul className="mt-2 space-y-1 border-t border-red-200 pt-2">
                    {cashflowSheetMirror.lastRefreshError.diagnostics.map((diagnostic, index) => (
                      <li key={`${diagnostic.code}-${diagnostic.sourceCell || index}`}>
                        {diagnostic.sourceCell ? `${diagnostic.sourceCell} · ` : ''}{diagnostic.message}
                      </li>
                    ))}
                    {isSafeCashflowNumber(cashflowSheetMirror.lastRefreshError.diagnosticCount)
                    && cashflowSheetMirror.lastRefreshError.diagnosticCount > cashflowSheetMirror.lastRefreshError.diagnostics.length ? (
                      <li>외 {formatCashflowCount(cashflowSheetMirror.lastRefreshError.diagnosticCount - cashflowSheetMirror.lastRefreshError.diagnostics.length, '건')}</li>
                    ) : null}
                  </ul>
                ) : null}
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 rounded-md border-red-200 bg-white px-2.5 text-[12px] text-red-700"
                onClick={() => navigate(`/portal/cashflow/${encodeURIComponent(projectId)}/sheets-lab`)}
              >
                시트 설정
              </Button>
            </div>
          ) : null}
          {dashboardSummary}

          <div className="grid gap-3">
            <div className="rounded-md border border-border bg-card px-3.5 py-3 shadow-none">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-[12px] font-bold text-card-foreground">주요 관리 항목</div>
                <span className="text-[12px] text-muted-foreground">프로젝트 전체 기간 · BFF/JVM 서버 판정</span>
              </div>
              <div className="space-y-2">
                {(monthCloseResult?.dashboard?.managementChecks || []).map((check) => {
                  // REVIEW_REQUIRED 가 neutral(회색) 이면 정상보다도 눈에 안 띈다. 확인이 필요한 것은
                  // 확인이 필요해 보여야 한다.
                  const tone: CashflowOpsTone = check.status === 'OK' ? 'success' : 'warning';
                  return (
                    <div key={check.id} className="rounded-md border border-border bg-secondary px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${opsDotClass(tone)}`} />
                        <span className="text-[12px] font-bold text-secondary-foreground">{check.title}</span>
                      </div>
                      {check.findings?.length ? (
                        <ul className={`mt-1 space-y-0.5 text-[12px] leading-4 ${check.status === 'OK' ? 'text-muted-foreground' : 'text-secondary-foreground'}`}>
                          {check.findings.map((finding) => <li key={finding}>· {finding}</li>)}
                        </ul>
                      ) : (
                        <div className={`mt-1 text-[12px] leading-4 ${check.status === 'OK' ? 'text-muted-foreground' : 'text-secondary-foreground'}`}>{check.detail}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {monthCloseResult?.dashboard?.postCloseAdjustment ? (
            <div className="rounded-md border border-border bg-accent px-3 py-2 text-[12px] text-accent-foreground">
              <div className="font-bold">결산 후 조정 특이사항</div>
              <div className="mt-1">{monthCloseResult.dashboard.postCloseAdjustment.reason} · 변경 {formatCashflowCount(monthCloseResult.dashboard.postCloseAdjustment.changedCount, '건')}</div>
              <div className="mt-1.5 space-y-1 text-[12px] leading-4 text-secondary-foreground">
                {monthCloseResult.dashboard.postCloseAdjustment.changes.slice(0, 5).map((change) => (
                  <div key={`${change.mode}:${change.weekNo}:${change.cashflowLine}`}>
                    {change.mode === 'projection' ? 'Projection' : 'Actual'} {change.weekNo}주차 · {CASHFLOW_SHEET_LINE_LABELS[change.cashflowLine as CashflowSheetLineId] || change.cashflowLine}
                    {' '}{formatCashflowAmount(change.beforeAmount)} → {formatCashflowAmount(change.afterAmount)}
                  </div>
                ))}
                {isSafeCashflowNumber(monthCloseResult.dashboard.postCloseAdjustment.changedCount)
                && monthCloseResult.dashboard.postCloseAdjustment.changedCount > 5 ? (
                  <div>외 {formatCashflowCount(monthCloseResult.dashboard.postCloseAdjustment.changedCount - 5, '건')}</div>
                ) : null}
              </div>
            </div>
          ) : null}

        </CardContent>
      </Card>
    );
  }

  function cashflowEventLabel(event: CashflowEvent): string {
    if (event.type === 'sheet_refresh') return '시트 값 불러오기';
    if (event.type === 'sheet_apply') return '시트 값 반영';
    if (event.type === 'month_close') return '월 결산';
    if (event.type === 'projection_amount_change') return 'Projection 값 변경';
    if (event.type === 'actual_amount_change') return 'Actual 값 변경';
    if (event.type === 'projection_completed') return '과거 Projection 완료 기록';
    if (event.type === 'actual_completed') return '과거 Actual 완료 기록';
    if (event.type === 'admin_closed') return '과거 주차 결산 기록';
    if (event.type === 'sheet_apply_reverted') return '시트 반영 되돌림';
    return '변경';
  }

  function cashflowEventDetail(event: CashflowEvent): string {
    const actorName = decodeActivityActor(event.actorName);
    const actorEmail = decodeActivityActor(event.actorEmail);
    if (event.type === 'sheet_refresh') {
      const actor = actorName
        ? `${actorName}님이`
        : actorEmail ? `${actorEmail} 계정으로` : '담당자가';
      const action = `${actor} 시트의 최신 값을 불러와 MYSCube 시트 반영 전 검증본으로 보관했습니다.`;
      return [event.sheetName, action].filter(Boolean).join(' · ');
    }
    if (event.type === 'sheet_apply') {
      const actor = actorName || actorEmail || '담당자';
      const period = event.scope === 'annual' && event.year ? `${event.year}년 합계` : event.yearMonth || '';
      return `${actor} · ${period} 시트 반영 ${formatCashflowCount(event.appliedLineCount, '건')} · Projection ${formatCashflowCount(event.projectionLineCount, '건')} · Actual ${formatCashflowCount(event.actualLineCount, '건')}`;
    }
    if (event.type === 'month_close') return [`${event.yearMonth || ''} 월`, event.status || '결산 완료', actorName || actorEmail || '사용자'].filter(Boolean).join(' · ');
    if (event.type === 'projection_amount_change' || event.type === 'actual_amount_change') {
      const weekLabel = event.weekNo ? getWeekLabel(event.weekNo, event.yearMonth) : '';
      const lineLabel = event.lineId ? CASHFLOW_SHEET_LINE_LABELS[event.lineId as CashflowSheetLineId] || event.lineId : '';
      const before = formatCashflowStateAmount(event.beforeState, event.beforeAmount);
      const after = formatCashflowStateAmount(event.afterState, event.afterAmount);
      return `${weekLabel} ${lineLabel} ${before} → ${after} · ${actorName || actorEmail || '사용자'}`;
    }
    if (event.type === 'sheet_apply_reverted') return '선택한 시트 반영 run의 금액 변경을 이전 값으로 되돌렸습니다.';
    const weekLabel = event.weekNo ? getWeekLabel(event.weekNo, event.yearMonth) : '';
    return [weekLabel, actorName || actorEmail || '사용자'].filter(Boolean).join(' · ');
  }

  function latestCashflowEventSummary(event?: CashflowEvent): string {
    if (!event) return '시트 반영과 월 결산 기록이 여기에 남습니다.';
    const actor = decodeActivityActor(event.actorName) || decodeActivityActor(event.actorEmail) || '최근 사용자';
    if (event.type === 'sheet_refresh') return `${actor}님이 시트의 최신 값을 불러왔습니다.`;
    if (event.type === 'sheet_apply') return `${actor}님이 시트 값을 MYSCube 시트에 반영했습니다.`;
    if (event.type === 'month_close') return `${actor}님이 ${event.yearMonth || ''} 월 결산을 확정했습니다.`;
    return `${actor}님의 최근 변경 기록입니다.`;
  }

  function cashflowEventSourceClass(source: CashflowEvent['source']): string {
    if (source === 'google_sheet_refresh') return 'bg-slate-100 text-slate-700';
    if (source === 'google_sheet_apply') return 'bg-[#EAF0F5] text-[#17324D]';
    if (source === 'month_close') return 'bg-[#EAF0F5] text-[#17324D]';
    if (source === 'revert') return 'bg-[#EAF0F5] text-[#17324D]';
    return 'bg-slate-100 text-slate-700';
  }

  function renderOpsTimeline() {
    const countBadges = [
      { key: 'sheet', label: '시트 불러오기', value: cashflowEvents.filter((event) => event.type === 'sheet_refresh').length },
      { key: 'amount', label: '금액 변경', value: cashflowEvents.filter((event) => event.type === 'projection_amount_change' || event.type === 'actual_amount_change').length },
      { key: 'status', label: '월 결산', value: cashflowEvents.filter((event) => event.type === 'month_close').length },
    ].filter((item) => item.value > 0);
    const latestEvent = cashflowEvents[0];
    const filteredEvents = cashflowEvents.filter((event) => {
      const query = cashflowEventQuery.trim().toLocaleLowerCase('ko-KR');
      const mode = event.mode || (event.type.startsWith('projection') ? 'projection' : event.type.startsWith('actual') ? 'actual' : '');
      return (cashflowEventMode === 'ALL' || mode === cashflowEventMode)
        && (cashflowEventMonth === 'ALL' || event.yearMonth === cashflowEventMonth)
        && (!query || `${cashflowEventLabel(event)} ${cashflowEventDetail(event)} ${event.sourceDetail || event.source || ''} ${event.operation || ''} ${event.operationId || ''} ${event.auditId || ''} ${event.runId} ${event.reason || ''} ${event.sourceRevision || ''} ${event.targetRevision || ''}`.toLocaleLowerCase('ko-KR').includes(query));
    });

    return (
      <Card className="h-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-2 pb-3">
            <div>
              <div className="text-[15px] font-bold tracking-[-0.01em] text-slate-950">실제 반영 기록</div>
              <div className="mt-0.5 text-[12px] leading-4 text-slate-600">{latestCashflowEventSummary(latestEvent)}</div>
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-1">
              {countBadges.map((badge) => (
                <span
                  key={badge.key}
                  className="rounded-md border border-slate-200 bg-slate-100 px-2 py-1 text-[12px] font-semibold leading-4 text-slate-700"
                >
                  {badge.label} {badge.value}
                </span>
              ))}
            </div>
          </div>
          <div className={`mb-2 grid gap-2 ${compact ? '' : 'sm:grid-cols-3'}`}>
            <Input aria-label="실제 반영 기록 검색" value={cashflowEventQuery} onChange={(event) => setCashflowEventQuery(event.target.value)} placeholder="항목·담당자 검색" />
            <select aria-label="실제 반영 구분 필터" className="h-9 rounded-md border border-slate-300 bg-white px-2 text-[12px]" value={cashflowEventMode} onChange={(event) => setCashflowEventMode(event.target.value)}><option value="ALL">전체 구분</option><option value="projection">Projection</option><option value="actual">Actual</option></select>
            <select aria-label="실제 반영 월 필터" className="h-9 rounded-md border border-slate-300 bg-white px-2 text-[12px]" value={cashflowEventMonth} onChange={(event) => setCashflowEventMonth(event.target.value)}><option value="ALL">전체 월</option>{[...new Set(cashflowEvents.map((event) => event.yearMonth).filter(Boolean))].sort((left, right) => left.localeCompare(right)).map((month) => <option key={month} value={month}>{month}</option>)}</select>
          </div>
          {cashflowEventErrors.map((failure) => (
            <div key={failure.source} role="alert" className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              <span>{CASHFLOW_ACTIVITY_SOURCE_LABELS[failure.source]}: {failure.message}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={cashflowEventLoading || cashflowEventLoadingMore || cashflowEventLoadingSources.includes(failure.source)}
                onClick={() => void loadCashflowEventSource(failure.source, {
                  preservePagination: Boolean(failure.preservePagination),
                })}
              >
                다시 시도
              </Button>
            </div>
          ))}
          {cashflowEventLoadError ? (
            <div role="alert" className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              <span>{cashflowEventLoadError}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={cashflowEventLoading || cashflowEventLoadingMore}
                onClick={() => void (cashflowActivityCursorQueue.length > 0 ? loadMoreCashflowEvents() : loadCashflowActivityAggregate())}
              >
                다시 시도
              </Button>
            </div>
          ) : null}
          <div className="max-h-[230px] space-y-0 overflow-auto rounded-md border border-slate-200 bg-slate-50 px-2 py-2 pr-1">
            {(cashflowEventLoading || cashflowEventLoadingSources.length > 0) && filteredEvents.length === 0 ? (
              <div role="status" className="px-2 py-8 text-center text-[12px] leading-4 text-slate-500">실제 반영 기록을 불러오는 중입니다.</div>
            ) : filteredEvents.length === 0 ? (
              <div className="px-2 py-8 text-center text-[12px] leading-4 text-slate-500">
                아직 표시할 변경 기록이 없습니다.
                <br />
                시트 값을 불러오거나 월 결산하면 담당자와 시간이 여기에 남습니다.
              </div>
            ) : filteredEvents.map((event, index) => {
              const canRevert = event.type === 'sheet_apply'
                && event.source === 'google_sheet_apply'
                && !event.revertedAt
                && cashflowEvents.some((candidate) => (
                  candidate.runId === event.runId
                  && !candidate.revertedAt
                  && (candidate.type === 'projection_amount_change' || candidate.type === 'actual_amount_change')
                ));
              return (
              <div key={event.id || `${event.runId}:${index}`} className="relative grid grid-cols-[16px_minmax(0,1fr)] gap-2 pb-3">
                {index < filteredEvents.length - 1 && (
                  <div className="absolute left-[6px] top-3 h-full w-px bg-slate-200/80" />
                )}
                <div className={`relative z-10 mt-1 h-3 w-3 rounded-full border-2 border-white ${opsDotClass(event.type === 'sheet_apply_reverted' ? 'warning' : 'info')}`} />
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[12px] font-semibold leading-4 ${cashflowEventSourceClass(event.source)}`}>
                          {event.source === 'google_sheet_refresh' ? '불러오기' : event.source === 'google_sheet_apply' ? '시트' : event.source === 'month_close' ? '결산' : event.source === 'revert' ? '되돌림' : '기록'}
                        </span>
                        <span className="truncate text-[12px] font-bold text-slate-900">{cashflowEventLabel(event)}</span>
                      </div>
                    </div>
                    <div className="shrink-0 text-[12px] tabular-nums text-slate-400">{formatSheetAppliedAt(event.createdAt)}</div>
                  </div>
                  <div className="mt-1 text-[12px] leading-4 text-slate-500">{cashflowEventDetail(event)}</div>
                  {canRevert && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-1 h-6 rounded-md px-2 text-[12px]"
                      onClick={() => void handleRevertCashflowRun(event.runId)}
                      disabled={revertingRunId === event.runId}
                    >
                      {revertingRunId === event.runId ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                      이 반영 되돌리기
                    </Button>
                  )}
                  {event.revertedAt && <div className="mt-1 text-[12px] font-semibold text-slate-700">되돌림 완료</div>}
                </div>
              </div>
              );
            })}
          </div>
          {cashflowActivityCursorQueue.length > 0 ? (
            <Button type="button" variant="outline" className="mt-2 w-full" disabled={cashflowEventLoading || cashflowEventLoadingMore || cashflowEventLoadingSources.length > 0} onClick={() => void loadMoreCashflowEvents()}>
              {cashflowEventLoadingMore ? '이전 기록 불러오는 중…' : '이전 기록 더 불러오기'}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  const monthClosePresentation = monthCloseCycle?.health === 'OK' && monthCloseCycle.businessState !== 'INCONSISTENT'
    ? cashflowPresentation?.monthClose
    : null;
  const monthCloseStatusLabel = monthClosePresentation?.statusLabel || '상태 재확인 필요';
  const monthCloseStatusClass = monthClosePresentation?.tone === 'danger'
    ? 'border border-red-200 bg-red-50 text-red-700'
    : monthClosePresentation?.tone === 'success'
      ? 'border border-border bg-secondary text-secondary-foreground'
      : 'border border-border bg-accent text-accent-foreground';
  const sheetDashboardMetadata = cashflowPresentation?.evidenceSource === 'DASHBOARD'
    ? monthCloseResult?.dashboard?.sheetMetadata as CashflowSheetDashboardMetadata | undefined
    : undefined;
  const dashboardTitle = `${projectName?.trim() || '이 프로젝트'} 현금흐름 대시보드`;
  const legacyCloseEvidence = monthCloseResult?.dashboard?.snapshotCompatibility?.status === 'LEGACY_EVIDENCE_ONLY';
  const cumulativeRequestScope = monthCloseResult?.dashboard?.cumulativeCloseScope;
  const cumulativeRequestScopeReady = monthCloseActions?.cumulativeScope.ready === true;

  return (
    <>
    <div className="space-y-5 bg-background p-4" inert={sheetRefreshLoading || undefined} aria-busy={sheetRefreshLoading}>
      {legacyCloseEvidence ? (
        <div role="status" className="rounded-md border border-slate-300 bg-slate-50 px-4 py-3 text-[12px] leading-5 text-[#17324D]">
          <strong>이전 형식의 월 결산입니다.</strong> 결산 당시 저장된 값은 읽을 수 있지만, 항목별 전년도 이월 근거와 전체 동결 시트는 보관되지 않았습니다. 수정이 필요하면 재오픈 승인 후 시트값을 다시 반영하고 재결산해 주세요.
        </div>
      ) : null}
      <section className={`grid gap-3 ${compact ? '' : 'xl:grid-cols-[minmax(0,1fr)_320px]'}`}>
        {renderOperationsPanel()}
        <div ref={opsTimelineRef} className="min-w-0">{renderOpsTimeline()}</div>
      </section>

      <section id="projection-actual-comparison" data-cashflow-block="comparison" className="scroll-mt-4 space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[#EAF0F5]">
            <Columns2 className="h-4 w-4 text-[#17324D]" />
          </span>
          <div>
            <div className="text-[15px] font-bold tracking-[-0.01em] text-slate-950">Projection - Actual 차이</div>
            <div className="text-[12px] text-slate-500">기준 범위 {cashflowTotalPeriodLabel}</div>
          </div>
        </div>
        {renderProjectionActualDiffTable()}
      </section>

      {renderUnifiedMonthlyBoard()}

      <AlertDialog open={weeklyCompletionOpen} onOpenChange={(open) => {
        if (!weeklyCompletionBusy) {
          setWeeklyCompletionOpen(open);
          if (!open) setWeeklyProjectionWarning(null);
        }
      }}>
        <AlertDialogContent className="sm:max-w-[620px]">
          <AlertDialogHeader>
            <AlertDialogTitle>주간 정산 완료 요청</AlertDialogTitle>
            <AlertDialogDescription>대상 주차와 그 이후 15개 재무주차(총 16주·256칸)의 JVM 저장 Projection 값을 확인합니다.</AlertDialogDescription>
          </AlertDialogHeader>
          {weeklyCompletionError ? <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-[12px] leading-5 text-red-800">{weeklyCompletionError}</div> : null}
          {weeklyProjectionWarning ? (
            <details open className="max-h-[260px] overflow-auto rounded-md border border-red-300 bg-red-50 p-3 text-[12px]">
              <summary className="cursor-pointer font-bold text-red-950">서버가 확인한 미입력 항목 {weeklyProjectionWarning.missingCells.length.toLocaleString()}건</summary>
              <ul className="mt-2 space-y-1" aria-label="Projection 미입력 주차와 항목">
                {weeklyProjectionWarning.missingCells.map((cell) => <li key={`${cell.yearMonth}:${cell.weekNo}:${cell.lineId}`}>{cell.yearMonth} {cell.weekNo}주차 · {CASHFLOW_SHEET_LINE_LABELS[cell.lineId as CashflowSheetLineId] || cell.lineId}이 미작성입니다.</li>)}
              </ul>
            </details>
          ) : null}
          <fieldset className="space-y-2">
            <legend className="mb-2 text-[13px] font-bold text-slate-900">이번 주차 처리 결과를 하나 선택해 주세요.</legend>
            {([
              ['CHANGED', '변경사항 반영 완료', '시트 변경사항을 MYSCube에 반영하고 확인했습니다.'],
              ['NO_CHANGES', '변경사항 없음', '확인 결과 이번 주차에 반영할 변경사항이 없습니다.'],
            ] as const).map(([value, label, description]) => (
              <label key={value} className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-300 p-3 text-[12px] focus-within:ring-2 focus-within:ring-[#17324D]">
                <input type="radio" name="weekly-update-result" value={value} checked={weeklyUpdateResult === value} disabled={weeklyCompletionBusy} onChange={() => { setWeeklyUpdateResult(value); setWeeklyCompletionError(''); }} className="mt-0.5 h-4 w-4" />
                <span><strong className="block text-slate-900">{label}</strong><span className="mt-1 block text-slate-600">{description}</span></span>
              </label>
            ))}
          </fieldset>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={weeklyCompletionBusy}>취소</AlertDialogCancel>
            <Button type="button" disabled={weeklyCompletionBusy || !weeklyUpdateResult} onClick={() => void handleCompleteWeeklyUpdate()}>
              {weeklyCompletionBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ClipboardCheck className="mr-1.5 h-3.5 w-3.5" />}{weeklyProjectionWarning ? '무시하고 반영' : '반영'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={weeklyHistoryOpen} onOpenChange={setWeeklyHistoryOpen}>
        <AlertDialogContent className="sm:max-w-[860px]">
          <AlertDialogHeader>
            <AlertDialogTitle>주간 정산 준수 이력</AlertDialogTitle>
            <AlertDialogDescription>JVM 프로젝트 원장의 연월·주차별 전체 준수 이력입니다.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-[60dvh] overflow-auto rounded-md border border-slate-300" role="region" aria-label="주간 정산 준수 전체 이력" tabIndex={0}>
            {weeklyComplianceHistory.length > 0 ? (
              <table className="w-full min-w-[780px] border-collapse text-[12px]">
                <caption className="sr-only">주간 정산 대상, 마감기한, 준수 상태, 완료시각과 완료자</caption>
                <thead className="sticky top-0 bg-slate-100"><tr><th className="px-3 py-2 text-left">대상 주차</th><th className="px-3 py-2 text-left">마감기한</th><th className="px-3 py-2 text-left">준수 상태</th><th className="px-3 py-2 text-left">처리 결과</th><th className="px-3 py-2 text-left">완료시각</th><th className="px-3 py-2 text-left">완료자</th></tr></thead>
                <tbody>{weeklyComplianceHistory.map((week) => <tr key={`${week.yearMonth}:${week.weekNo}:${week.operationId || week.status}`} className="border-t border-slate-200"><th className="px-3 py-2 text-left">{week.yearMonth} {week.weekNo}주차</th><td className="px-3 py-2">{formatSheetAppliedAt(week.deadline)}</td><td className="px-3 py-2 font-semibold">{week.statusLabel}</td><td className="px-3 py-2">{week.updateResult === 'CHANGED' ? '변경사항 반영 완료' : week.updateResult === 'NO_CHANGES' ? '변경사항 없음' : '-'}</td><td className="px-3 py-2">{formatSheetAppliedAt(week.completedAt) || '-'}</td><td className="px-3 py-2 break-all">{week.completedBy || '-'}</td></tr>)}</tbody>
              </table>
            ) : weeklyComplianceHistoryLoading ? <p role="status" className="p-6 text-center text-[12px] text-slate-500">이력을 불러오는 중입니다.</p> : weeklyComplianceHistoryError ? <div role="alert" className="p-6 text-center text-[12px] text-red-700">{weeklyComplianceHistoryError}<Button type="button" size="sm" variant="outline" className="ml-2" onClick={() => void loadWeeklyComplianceHistory()}>다시 시도</Button></div> : <p className="p-6 text-center text-[12px] text-slate-500">저장된 주간 정산 이력이 없습니다.</p>}
          </div>
          {weeklyComplianceNextCursor ? <Button type="button" variant="outline" disabled={weeklyComplianceHistoryLoading} onClick={() => void loadMoreWeeklyComplianceHistory()}>{weeklyComplianceHistoryLoading ? '추가 이력 불러오는 중…' : '이전 이력 더 불러오기'}</Button> : null}
          <AlertDialogFooter><AlertDialogCancel>닫기</AlertDialogCancel></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={monthCloseReviewOpen}
        onOpenChange={(open) => {
          if (!monthCloseBusy) setMonthCloseReviewOpen(open);
        }}
      >
        <AlertDialogContent className="sm:max-w-[620px]">
          <AlertDialogHeader>
            <AlertDialogTitle>{yearMonth} 누적 월결산 승인 요청</AlertDialogTitle>
            <AlertDialogDescription>
              결산 기준과 서버가 고정한 누적 범위를 점검한 뒤 지정 조직장에게 승인을 요청합니다.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-4 text-[13px] text-slate-700">
            <div className="flex items-center justify-between gap-4">
              <span>결산 대상</span>
              <strong className="text-slate-950">{yearMonth}</strong>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span>시트 데이터</span>
              <strong className="text-[#17324D]">{monthCloseCellsState.error ? '확인 필요' : '준비됨'}</strong>
            </div>
            {cumulativeRequestScopeReady && cumulativeRequestScope ? <><div className="flex items-center justify-between gap-4"><span>누적 대상 월</span><strong className="text-right text-slate-950">{cumulativeRequestScope.fromMonth} ~ {cumulativeRequestScope.throughMonth}</strong></div><div className="flex items-center justify-between gap-4"><span>서버 고정 범위</span><strong className="text-right text-slate-950">{cumulativeRequestScope.lockRange.fromMonth} {cumulativeRequestScope.lockRange.fromWeekNo}주차 ~ {cumulativeRequestScope.lockRange.throughMonth} {cumulativeRequestScope.lockRange.throughWeekNo}주차</strong></div><div className="flex items-center justify-between gap-4"><span>포함 데이터</span><strong className="text-slate-950">{cumulativeRequestScope.monthCount}개월 · {cumulativeRequestScope.weekCount}주 · {cumulativeRequestScope.cellCount}셀</strong></div><div className="flex items-start justify-between gap-4"><span>저장 대상</span><strong className="text-right text-slate-950">{cumulativeRequestScope.source.spreadsheetTitle || '이름 없음'} · {cumulativeRequestScope.source.selectedSheetName || '탭 이름 없음'}</strong></div></> : <div role="alert" className="text-red-700">서버의 누적 결산 고정 범위와 건수를 확인하지 못했습니다. 다시 불러온 뒤 요청해 주세요.</div>}
            {cumulativeRequestScopeReady && cumulativeRequestScope?.source.spreadsheetUrl ? <a href={cumulativeRequestScope.source.spreadsheetUrl} target="_blank" rel="noreferrer" className="font-semibold text-[#17324D] underline">저장 대상 시트 열기</a> : <span className="text-slate-500">저장 대상 시트 링크 없음</span>}
          </div>

          <div className={`rounded-md border px-3 py-3 text-[13px] leading-5 ${monthClosePreparation.status === 'READY' ? 'border-[#C7D3DF] bg-[#EAF0F5] text-[#17324D]' : monthClosePreparation.status === 'STATUS_RETRY_REQUIRED' ? 'border-red-200 bg-red-50 text-red-700' : 'border-[#C7D3DF] bg-[#EAF0F5] text-[#17324D]'}`}>
            <div className="font-bold">{monthClosePreparation.title}</div>
            <div className="mt-1">{monthClosePreparation.detail}</div>
          </div>

          <div className="rounded-md border border-[#C7D3DF] bg-[#EAF0F5] px-3 py-3 text-[13px] leading-5 text-[#17324D]">
            승인 완료 시 위 누적 범위의 모든 주차가 수정 불가 상태로 잠깁니다.
          </div>

          <label className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-3 py-3 text-[13px] leading-5 text-slate-800">
            <input
              type="checkbox"
              checked={monthCloseHumanReviewed}
              disabled={monthCloseBusy || monthClosePreparation.status !== 'READY'}
              onChange={(event) => setMonthCloseHumanReviewed(event.target.checked)}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-[#17324D]"
            />
            <span>시트의 값과 일치하는지 직접 확인했습니다.</span>
          </label>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={monthCloseBusy}>닫기</AlertDialogCancel>
            {monthClosePreparation.actionLabel ? (
              <Button
                type="button"
                variant="outline"
                disabled={monthCloseBusy || sheetRefreshLoading}
                onClick={() => void handleMonthClosePreparationAction()}
              >
                {sheetRefreshLoading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                {monthClosePreparation.actionLabel}
              </Button>
            ) : null}
            <AlertDialogAction
               disabled={!cumulativeRequestScopeReady || !yearMonth || !savedExecutiveApproverId || !monthCloseHumanReviewed || monthCloseBusy || monthClosePreparation.status !== 'READY'}
              onClick={(event) => {
                event.preventDefault();
                void handleFinalizeMonthClose();
              }}
            >
              {monthCloseBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
              {portalMonthlyButtonLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CashflowFormulaMismatchDialog
        issues={formulaMismatchPrompt?.issues || []}
        busy={sheetStageApplyLoading}
        onCancel={() => setFormulaMismatchPrompt(null)}
        onConfirm={() => {
          if (!formulaMismatchPrompt) return;
          const pending = formulaMismatchPrompt;
          setFormulaMismatchPrompt(null);
          void handleApplyStagedSheetValues(
            pending.stage,
            pending.closedMonthChangeReason,
            true,
            pending.acceptPendingApprovalDifferences,
          );
        }}
      />

      <CashflowLateSheetChangeDialog
        key={pendingApprovalStage?.runId || 'pending-approval'}
        kind="pendingApproval"
        stage={pendingApprovalStage}
        submitting={sheetStageApplyLoading}
        onCancel={() => {
          if (sheetStageApplyLoading) return;
          setPendingApprovalStage(null);
          setPendingApprovalClosedMonthChangeReason('');
          setPendingApprovalFormulaAccepted(false);
        }}
        onSubmit={() => {
          const stage = pendingApprovalStage;
          setPendingApprovalStage(null);
          if (stage) void handleApplyStagedSheetValues(
            stage,
            pendingApprovalClosedMonthChangeReason,
            pendingApprovalFormulaAccepted,
            true,
          );
        }}
      />

      <AlertDialog
        open={monthCloseWithdrawOpen}
        onOpenChange={(open) => {
          if (!open && !monthCloseBusy) {
            setMonthCloseWithdrawOpen(false);
            setMonthCloseWithdrawReason('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>월 결산 결재 요청 회수</AlertDialogTitle>
            <AlertDialogDescription>
              조직장 검토 전이라 회수할 수 있습니다. 회수하면 정산 상태가 입력 대기로 돌아가고, 수정 후 다시 요청해야 합니다.
              회수 이력은 감사 기록에 남습니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="grid gap-2 text-[12px] font-semibold text-slate-700">
            사유 (선택)
            <textarea
              value={monthCloseWithdrawReason}
              className="min-h-[96px] rounded-md border border-slate-200 p-3 text-[12px] font-normal outline-none focus:border-[#17324D]"
              placeholder="회수하는 이유를 남겨 두면 이후 확인이 쉬워집니다."
              disabled={monthCloseBusy}
              onChange={(event) => setMonthCloseWithdrawReason(event.target.value)}
            />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={monthCloseBusy}>닫기</AlertDialogCancel>
            <AlertDialogAction
              disabled={monthCloseBusy}
              onClick={(event) => {
                event.preventDefault();
                void handleWithdrawMonthCloseRequest();
              }}
            >
              {monthCloseBusy ? '처리 중…' : '회수하기'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

            {/*
        확정된 주간 정산 되돌리기. 사유 필요 여부는 서버가 판정하고(400
        cashflow_weekly_reopen_reason_required) 화면은 그 답을 받아 이 창을 연다.
        완료 요청 회수는 사유가 없어도 되므로 이 창이 뜨지 않는다.
      */}
      <AlertDialog
        open={weeklyReopenReasonOpen}
        onOpenChange={(open) => {
          if (!open && !weeklyWithdrawBusy) {
            setWeeklyReopenReasonOpen(false);
            setWeeklyReopenReason('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>확정된 주간 정산 되돌리기</AlertDialogTitle>
            <AlertDialogDescription>
              조직장이 확정한 주간 정산입니다. 되돌리면 감사 이력에 남으니 사유를 구체적으로 작성해 주세요.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="grid gap-2 text-[12px] font-semibold text-slate-700">
            사유
            <textarea
              value={weeklyReopenReason}
              className="min-h-[120px] rounded-md border border-slate-200 p-3 text-[12px] font-normal outline-none focus:border-[#17324D]"
              placeholder="되돌려야 하는 이유와 고칠 범위를 입력해 주세요."
              disabled={weeklyWithdrawBusy}
              onChange={(event) => setWeeklyReopenReason(event.target.value)}
            />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={weeklyWithdrawBusy}>취소</AlertDialogCancel>
            <AlertDialogAction
              disabled={weeklyWithdrawBusy || weeklyReopenReason.trim().length === 0}
              onClick={(event) => {
                event.preventDefault();
                void handleWithdrawWeeklyUpdate(weeklyReopenReason.trim());
              }}
            >
              되돌리기
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

<AlertDialog
        open={reopenAction !== null}
        onOpenChange={(open) => {
          if (!open && !monthCloseBusy) {
            setReopenAction(null);
            setReopenReason('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {reopenAction === 'request' ? '월 결산 재오픈 요청' : reopenAction === 'approve' ? '재오픈 승인' : '재오픈 반려'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              결산 이후 변경은 감사 이력과 경고 카운트에 남습니다. 처리 사유를 구체적으로 작성해 주세요.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="grid gap-2 text-[12px] font-semibold text-slate-700">
            사유
            <textarea
              value={reopenReason}
              className="min-h-[120px] rounded-md border border-slate-200 p-3 text-[12px] font-normal outline-none focus:border-[#17324D]"
              placeholder="수정이 필요한 이유와 범위를 입력해 주세요."
              disabled={monthCloseBusy}
              onChange={(event) => setReopenReason(event.target.value)}
            />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={monthCloseBusy}>취소</AlertDialogCancel>
            <AlertDialogAction
              disabled={monthCloseBusy || !reopenReason.trim()}
              onClick={(event) => {
                event.preventDefault();
                void handleMonthReopenAction();
              }}
            >
              {monthCloseBusy ? '처리 중…' : reopenAction === 'request' ? '요청 보내기' : reopenAction === 'approve' ? '승인' : '반려'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={sheetReviewDialogOpen}
        onOpenChange={(open) => setSheetReviewDialogOpen(open)}
      >
        <AlertDialogContent className="sm:max-w-[760px]">
          <AlertDialogHeader>
            <AlertDialogTitle>{cashflowSheetConfig ? '시트 업데이트 반영' : '캐시플로우 시트 연동 시작하기'}</AlertDialogTitle>
            <AlertDialogDescription>
              {cashflowSheetConfig
                ? '고정해 둔 시트 값을 MYSCube 시트와 비교합니다. 저장 버튼을 누르기 전까지 MYSCube 시트는 바뀌지 않습니다.'
                : '시트를 연결하지 않아도 캐시플로우는 조회할 수 있습니다. 기존 시트 값을 가져오려면 아래 순서로 연결해 주세요.'}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="rounded-md border border-[#C7D3DF] bg-[#EAF0F5] p-3 text-[12px] text-[#17324D]" aria-label="Google Sheet 편집자 공유 안내">
            <strong>먼저 서비스 계정을 Google Sheet 편집자로 공유해 주세요.</strong>
            {cashflowSystemAccountEmail ? (
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <code className="break-all rounded bg-white px-2 py-1.5">{cashflowSystemAccountEmail}</code>
                <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(cashflowSystemAccountEmail)}>계정 복사</Button>
              </div>
            ) : <p role={cashflowSystemAccountError ? 'alert' : 'status'} className="mt-2">{cashflowSystemAccountError ? '서비스 계정 이메일을 확인하지 못했습니다. 시트 설정에서 다시 불러와 주세요.' : '서비스 계정 이메일을 불러오는 중입니다.'}</p>}
          </div>

          <div className="space-y-4 rounded-md border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[13px] font-bold text-slate-950">
                  <ArrowDownToLine className="h-4 w-4 text-[#17324D]" />
                  {cashflowSheetConfig ? '시트에서 가져오기' : '연동 전 확인사항'}
                </div>
                <div className="mt-1 text-[12px] leading-5 text-slate-600">
                  {cashflowSheetConfig
                    ? '마지막으로 고정한 Projection/Actual 값을 MYSCube 시트에 반영합니다. 이 단계에서는 Google Sheet를 다시 읽지 않습니다.'
                  : '설정 후에도 자동으로 값을 가져오지 않습니다. 시트 설정에서 직접 시트값을 가져올 때만 고정합니다.'}
                </div>
              </div>
              <Badge className={`w-fit rounded-md border px-2.5 py-1 text-[12px] ${sheetMirrorStatus === 'FRESH' ? 'border-slate-300 bg-slate-100 text-slate-700' : 'border-[#C7D3DF] bg-[#EAF0F5] text-[#17324D]'}`}>
                {cashflowSheetConfig ? (cashflowSheetMirrorLoading ? '확인 중' : sheetMirrorStatus) : '선택 설정'}
              </Badge>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-[#C7D3DF] bg-[#EAF0F5] px-3 py-2 text-[12px] leading-5 text-slate-800">
              <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0 text-[#17324D]" />
              <div>
                {cashflowSheetConfig
                  ? `현재 선택: ${sheetMirrorCapturedAt || '최근'} 고정본을 MYSCube 시트에 반영합니다.`
                  : 'Google Sheet는 조회 전용으로 연결되며, 시트 값 반영 버튼을 누를 때만 MYSCube 시트가 바뀝니다.'}
              </div>
            </div>
            <div className={`grid gap-2 ${compact ? '' : 'sm:grid-cols-3'}`}>
              {(cashflowSheetConfig ? [
                ['1', '고정본 선택', '명시적으로 연동한 시트 고정본을 사용합니다.'],
                ['2', '시트값 반영', '시트에서 사람이 확인한 최신값을 MYSCube 시트에 바로 반영합니다.'],
                ['3', '변경 이력', '결산 후 변경은 시점과 사유, 경고 횟수를 기록합니다.'],
              ] : [
                ['1', '공유 권한 확인', '연동할 Google Sheet에 조회 권한이 있는지 확인합니다.'],
                ['2', '시트 탭 선택', '사용할 시트 탭을 지정하면 탭 전체를 불러옵니다.'],
                ['3', '명시적으로 불러오기', '설정 후 시트 설정에서 직접 값을 가져와 저장할 값을 확인합니다.'],
              ]).map(([step, title, detail]) => (
                <div key={step} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-900 text-[12px] font-bold text-white">{step}</span>
                    <span className="text-[12px] font-bold text-slate-900">{title}</span>
                  </div>
                  <div className="mt-1 text-[12px] leading-4 text-slate-500">{detail}</div>
                </div>
              ))}
            </div>
            <div className={`rounded-md border px-3 py-2 text-[12px] leading-5 ${cashflowSheetConfig ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-[#C7D3DF] bg-[#EAF0F5] text-[#17324D]'}`}>
              {cashflowSheetConfig
                ? `${sheetIdentityLabel} · ${sheetRangeLabel}`
                : '먼저 Google Sheet 공유 권한과 시트 탭을 설정해야 합니다.'}
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>{cashflowSheetConfig ? '닫기' : '나중에 하기'}</AlertDialogCancel>
            {!cashflowSheetConfig?.value ? (
              <AlertDialogAction onClick={() => navigate(`/portal/cashflow/${encodeURIComponent(projectId)}/sheets-lab`)}>
                시트 연동 설정
              </AlertDialogAction>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => void handleStartSheetChangeReview(true)} disabled={sheetRefreshLoading || sheetMirrorStatus !== 'FRESH'}>
                  {sheetRefreshLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                  시트 값 반영
                </Button>
                <AlertDialogAction onClick={() => void handleStartSheetChangeReview(true)} disabled={sheetRefreshLoading || sheetMirrorStatus !== 'FRESH'} className="bg-[#17324D] hover:bg-slate-800">
                  {sheetRefreshLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
                  {yearMonth} MYSCube 시트 덮어쓰기
                </AlertDialogAction>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CashflowLateSheetChangeDialog
        key={lateSheetApply?.runId || 'closed-month'}
        stage={lateSheetApply}
        resumeRequired={sheetApplyResumeRequired}
        resumeReason={lateSheetResumeReason}
        submitting={sheetStageApplyLoading}
        onCancel={() => {
          if (sheetStageApplyLoading || sheetApplyResumeRequired) return;
          setLateSheetApply(null);
          setSheetApplyResumeRequired(false);
          setLateSheetResumeReason('');
          setLateSheetFormulaAccepted(false);
          setLateSheetPendingApprovalAccepted(false);
        }}
        onSubmit={(reason) => lateSheetApply && void handleApplyStagedSheetValues(
          lateSheetApply,
          reason,
          lateSheetFormulaAccepted,
          lateSheetPendingApprovalAccepted,
        )}
      />


      <AlertDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => {
          if (!open && !exitBusy && blocker.state === 'blocked') {
            blocker.reset();
          }
        }}
      >
         <AlertDialogContent>
           <AlertDialogHeader>
             <AlertDialogTitle>저장되지 않은 변경사항이 있습니다</AlertDialogTitle>
             <AlertDialogDescription>
               페이지를 이동하면 아직 최종저장하지 않은 현금흐름 입력값이 사라집니다.
             </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={exitBusy} onClick={() => blocker.reset?.()}>계속 작성</AlertDialogCancel>
            <Button
              type="button"
              variant="outline"
              disabled={exitBusy}
              onClick={() => void discardChangesAndLeave()}
            >
               저장하지 않고 이동
             </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    {sheetRefreshLoading ? <CashflowSheetSyncOverlay operation="refresh" /> : null}
    </>
  );
}
