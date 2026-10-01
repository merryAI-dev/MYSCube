import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import {
  BarChart3,
  CalendarRange,
  Check,
  ChevronsUpDown,
  Columns2,
  Download,
  FileSpreadsheet,
  FolderSearch,
  Layers3,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '../layout/PageHeader';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../ui/command';
import { useAppStore } from '../../data/store';
import { useAuth } from '../../data/auth-store';
import { useFirebase } from '../../lib/firebase-context';
import { triggerDownload } from '../../platform/csv-utils';
import {
  buildCashflowExportAvailableYears,
  countCashflowExportProjectsByAccountType,
  filterCashflowExportTargetProjects,
  toggleCashflowExportAccountType,
  type CashflowExportAccountTypeFilter,
  type CashflowExportSortBy,
} from '../../platform/cashflow-export-filters';
import {
  exportCashflowWorkbookViaBff,
  fetchCashflowSettlementStatusesBatchViaBff,
  fetchCashflowWeeklyOverviewViaBff,
  isPlatformApiEnabled,
  type CashflowSettlementStatusItem,
  type CashflowSettlementStatusesResult,
  type CashflowWeeklyOverviewResult,
} from '../../lib/platform-bff-client';
import {
  expandCashflowYearMonthRange,
  summarizeCashflowYearMonths,
  type CashflowExportWorkbookVariant,
} from '../../platform/cashflow-export';
import { hasPermission } from '../../platform/rbac';
import { getSeoulTodayIso } from '../../platform/business-days';
import { ACCOUNT_TYPE_LABELS, type AccountType } from '../../data/types';
import { CashflowCanonicalSummary } from './CashflowCanonicalSummary';
import {
  chunkCashflowExportProjectIds,
  loadCashflowExportChunksInSequence,
  findCashflowExportSettlementStatus,
  resolveCashflowExportRecentWeeks,
  type CashflowExportRecentWeek,
} from '../../platform/cashflow-export-dashboard';
import { formatCashflowExecutiveApprover, formatCashflowManager } from './CashflowWeeklyPage';
import { CashflowExportProjectPane } from './CashflowExportProjectPane';

const strongFieldBaseClass = 'h-10 rounded-lg border-2 bg-white text-[12px] font-medium text-zinc-950 shadow-none transition-colors focus-visible:ring-2 [&_svg]:size-4 [&_svg]:!opacity-100 [&_svg]:text-stone-500';
const activeDisabledFieldClass = 'border-stone-200 bg-stone-100 text-stone-500 shadow-none [&_svg]:text-stone-400';
const monochromeSurfaceClass = 'border-stone-200 bg-stone-50';

function formatDateTime(value?: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

function formatSettlementAt(value: string | null | undefined, emptyLabel: string): string {
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return emptyLabel;
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || '';
  return `${part('month')}/${part('day')}(${part('weekday')}) ${part('hour')}:${part('minute')}`;
}

function settlementStatusPresentation(status: CashflowSettlementStatusItem['status']) {
  if (status === 'COMPLETED') {
    return { label: '승인 완료', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' };
  }
  if (status === 'PENDING_APPROVAL') {
    return { label: '조직장 승인 필요', className: 'border-amber-200 bg-amber-50 text-amber-800' };
  }
  if (status === 'WAITING_FOR_UPDATE') {
    return { label: '주정산 이전', className: 'border-red-200 bg-red-50 text-red-700' };
  }
  return { label: '주정산 이전', className: 'border-red-200 bg-red-50 text-red-700' };
}

function SettlementWeekStrip({
  week,
  item,
  loading,
  error,
}: {
  week: CashflowExportRecentWeek;
  item: CashflowSettlementStatusItem | null;
  loading: boolean;
  error: boolean;
}) {
  if (loading) {
    return (
      <div data-testid={`cashflow-export-week-${week.yearMonth}-${week.period}`} className="rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-2">
        <p className="font-semibold text-stone-700">{week.displayLabel}</p>
        <p role="status" className="mt-1 text-[10px] text-stone-500">불러오는 중…</p>
      </div>
    );
  }
  if (error || !item) {
    return (
      <div data-testid={`cashflow-export-week-${week.yearMonth}-${week.period}`} className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2">
        <p className="font-semibold text-stone-800">{week.displayLabel}</p>
        <p role="alert" className="mt-1 text-[10px] font-medium text-amber-800">주정산 정보를 불러오지 못함</p>
      </div>
    );
  }
  const presentation = settlementStatusPresentation(item.status);
  return (
    <div data-testid={`cashflow-export-week-${week.yearMonth}-${week.period}`} className="rounded-lg border border-stone-200 bg-white px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold text-zinc-950">{week.displayLabel}</p>
        <Badge variant="outline" className={`shrink-0 text-[9px] ${presentation.className}`}>{presentation.label}</Badge>
      </div>
      <dl className="mt-1.5 grid gap-0.5 text-[9px] leading-4 text-stone-600">
        <div className="flex items-center justify-between gap-3">
          <dt>실무자 제출 완료</dt>
          <dd className="tabular-nums text-stone-800">{formatSettlementAt(item.submittedAt, '제출 전')}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt>조직장 승인 완료</dt>
          <dd className="tabular-nums text-stone-800">{formatSettlementAt(item.approvedAt, '승인 전')}</dd>
        </div>
      </dl>
    </div>
  );
}

type CashflowWeeklyOverviewItem = CashflowWeeklyOverviewResult['items'][number];

interface CashflowExportOperationsState {
  key: string;
  loading: boolean;
  overviewItems: Record<string, CashflowWeeklyOverviewItem>;
  settlementResults: CashflowSettlementStatusesResult[];
  statusErrors: Record<string, boolean>;
  summaryErrors: Record<string, boolean>;
  pendingProjectIds: Record<string, boolean>;
}

function settlementErrorKey(projectId: string, yearMonth: string) {
  return `${projectId}:${yearMonth}`;
}

function SelectionField(props: {
  step: string;
  icon: typeof BarChart3;
  label: string;
  helper: string;
  showHelper?: boolean;
  value: string;
  testId: string;
  toneClass: string;
  children: ReactNode;
}) {
  const { icon: Icon, label, helper, showHelper = false, testId, toneClass, children } = props;
  return (
    <div data-testid={testId} className={`space-y-2 rounded-xl border p-3 ${toneClass}`}>
      <div className="flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-md border border-stone-200 bg-white">
          <Icon className="h-3.5 w-3.5 text-stone-600" />
        </div>
        <Label className="text-[11px] font-medium tracking-[0.01em] text-stone-700">{label}</Label>
      </div>
      {children}
      {showHelper ? <p className="text-[10px] leading-relaxed text-stone-500">{helper}</p> : null}
    </div>
  );
}

export function CashflowExportPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const operationsTableRef = useRef<HTMLDivElement>(null);
  const operationsTableScrollLeftRef = useRef(0);
  const { projects, persons } = useAppStore();
  const { user } = useAuth();
  const { orgId } = useFirebase();
  const todayIso = getSeoulTodayIso();
  const currentYearMonth = todayIso.slice(0, 7);
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [departmentFilter, setDepartmentFilter] = useState('ALL');
  const [accountTypeFilter, setAccountTypeFilter] = useState<CashflowExportAccountTypeFilter>('ALL');
  const [accountTypePickerOpen, setAccountTypePickerOpen] = useState(false);
  const [sortBy, setSortBy] = useState<CashflowExportSortBy>('PROJECT_NAME');
  const [rangeMode, setRangeMode] = useState<'year' | 'custom'>('year');
  const [selectedYear, setSelectedYear] = useState<string>(currentYearMonth.slice(0, 4));
  const [startYearMonth, setStartYearMonth] = useState<string>(`${currentYearMonth.slice(0, 4)}-01`);
  const [endYearMonth, setEndYearMonth] = useState<string>(`${currentYearMonth.slice(0, 4)}-12`);
  const [multiProjectVariant, setMultiProjectVariant] = useState<'combined' | 'multi-sheet'>('multi-sheet');
  const [downloadPreparing, setDownloadPreparing] = useState(false);
  const [operationsState, setOperationsState] = useState<CashflowExportOperationsState>({
    key: '', loading: false, overviewItems: {}, settlementResults: [], statusErrors: {}, summaryErrors: {}, pendingProjectIds: {},
  });

  const canExport = hasPermission((user?.role || 'viewer') as any, 'cashflow:export');
  const bffEnabled = isPlatformApiEnabled();

  const sortedProjects = useMemo(
    () => [...projects].sort((left, right) => left.name.localeCompare(right.name, 'ko')),
    [projects],
  );
  const panelProjectParam = searchParams.get('project');
  const panelProjectId = panelProjectParam?.trim() || '';
  const panelProject = useMemo(
    () => sortedProjects.find((project) => project.id === panelProjectId) || null,
    [panelProjectId, sortedProjects],
  );

  useLayoutEffect(() => {
    const table = operationsTableRef.current;
    if (!table) return undefined;
    const savedScrollLeft = operationsTableScrollLeftRef.current;
    table.scrollLeft = savedScrollLeft;
    const frame = window.requestAnimationFrame(() => {
      if (operationsTableRef.current) operationsTableRef.current.scrollLeft = savedScrollLeft;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [panelProjectId]);

  const openProjectPanel = useCallback((projectId: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('project', projectId);
      return next;
    });
  }, [setSearchParams]);

  const closeProjectPanel = useCallback(() => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('project');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    if (panelProjectParam !== null && !panelProjectId) {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.delete('project');
        return next;
      }, { replace: true });
      return;
    }
    if (!panelProjectId || sortedProjects.length === 0 || panelProject) return;
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('project');
      return next;
    }, { replace: true });
  }, [panelProject, panelProjectId, panelProjectParam, setSearchParams, sortedProjects.length]);

  const departments = useMemo(() => Array.from(new Set(
    sortedProjects.map((project) => project.department).filter(Boolean),
  )).sort((left, right) => left.localeCompare(right, 'ko')), [sortedProjects]);

  const availableYears = useMemo(
    () => buildCashflowExportAvailableYears(sortedProjects, currentYearMonth.slice(0, 4)),
    [currentYearMonth, sortedProjects],
  );
  const accountTypeCounts = useMemo(
    () => countCashflowExportProjectsByAccountType(sortedProjects, departmentFilter),
    [departmentFilter, sortedProjects],
  );

  const yearMonths = useMemo(() => {
    if (rangeMode === 'year') {
      return expandCashflowYearMonthRange(`${selectedYear}-01`, `${selectedYear}-12`);
    }
    return expandCashflowYearMonthRange(startYearMonth, endYearMonth);
  }, [endYearMonth, rangeMode, selectedYear, startYearMonth]);

  const targetProjects = useMemo(() => {
    return filterCashflowExportTargetProjects(sortedProjects, {
      scope,
      selectedProjectIds,
      departmentFilter,
      accountTypeFilter,
      sortBy,
    });
  }, [accountTypeFilter, departmentFilter, scope, selectedProjectIds, sortBy, sortedProjects]);
  const targetProjectIds = useMemo(() => targetProjects.map((project) => project.id), [targetProjects]);
  const targetProjectIdsKey = JSON.stringify(targetProjectIds);
  const recentWeeks = useMemo(() => resolveCashflowExportRecentWeeks(todayIso), [todayIso]);
  const previousWeek = recentWeeks[0];
  const currentWeek = recentWeeks[1];
  const operationsActor = useMemo(() => user ? {
    uid: user.uid, email: user.email, role: user.role, idToken: user.idToken,
  } : null, [user?.email, user?.idToken, user?.role, user?.uid]);
  const operationsKey = JSON.stringify([
    orgId, operationsActor?.uid || '', operationsActor?.role || '', targetProjectIdsKey,
    previousWeek?.yearMonth || '', previousWeek?.period || '', currentWeek?.yearMonth || '', currentWeek?.period || '',
  ]);
  const operationsWillLoad = Boolean(
    canExport && bffEnabled && operationsActor?.idToken && targetProjectIds.length > 0 && currentWeek && previousWeek,
  );
  const scopedOperations: CashflowExportOperationsState = operationsState.key === operationsKey ? operationsState : {
    key: operationsKey,
    loading: operationsWillLoad,
    overviewItems: {}, settlementResults: [], statusErrors: {}, summaryErrors: {},
    pendingProjectIds: operationsWillLoad ? Object.fromEntries(targetProjectIds.map((projectId) => [projectId, true])) : {},
  };

  const operationsPendingCount = Object.keys(scopedOperations.pendingProjectIds).length;
  const operationsFailedCount = targetProjectIds.filter((projectId) => (
    !scopedOperations.pendingProjectIds[projectId]
    && (scopedOperations.summaryErrors[projectId]
      || recentWeeks.some((week) => scopedOperations.statusErrors[settlementErrorKey(projectId, week.yearMonth)]))
  )).length;
  const operationsProgress = operationsPendingCount > 0
    ? {
      tone: 'status' as const,
      text: `사업 ${targetProjectIds.length}개 중 ${targetProjectIds.length - operationsPendingCount}개를 불러왔습니다. 나머지는 10개씩 차례로 불러옵니다.`,
    }
    : operationsFailedCount > 0
      ? {
        tone: 'alert' as const,
        text: `사업 ${operationsFailedCount}개는 주정산 또는 시트 정보를 불러오지 못했습니다. 다른 사업은 정상으로 표시됩니다. 화면을 새로 고치면 다시 불러옵니다.`,
      }
      : null;

  const workbookVariant: CashflowExportWorkbookVariant = multiProjectVariant;
  const periodSummary = summarizeCashflowYearMonths(yearMonths);
  const accountTypeFilterLabel = accountTypeFilter === 'ALL'
    ? '전체 통장 유형'
    : accountTypeFilter.length === 0
      ? '0개 선택'
      : accountTypeFilter.length === 1
        ? ACCOUNT_TYPE_LABELS[accountTypeFilter[0]]
        : `${accountTypeFilter.length}개 유형 선택`;
  const sortByLabel = sortBy === 'DEPARTMENT' ? '소속(CIC/센터)' : '사업명';
  const projectSelectionLabel = scope === 'selected'
    ? `${targetProjects.length}개 사업 선택`
    : '전체 사업';
  const workbookVariantLabel = workbookVariant === 'combined' ? '대상 사업 통합 시트' : '대상 사업 개별 시트';

  useEffect(() => {
    const projectIds = JSON.parse(targetProjectIdsKey) as string[];
    if (!canExport || !bffEnabled || !operationsActor?.idToken || projectIds.length === 0 || !currentWeek || !previousWeek) {
      setOperationsState({
        key: operationsKey, loading: false, overviewItems: {}, settlementResults: [], statusErrors: {}, summaryErrors: {}, pendingProjectIds: {},
      });
      return;
    }

    let active = true;
    setOperationsState({
      key: operationsKey,
      loading: true,
      overviewItems: {},
      settlementResults: [],
      statusErrors: {},
      summaryErrors: {},
      pendingProjectIds: Object.fromEntries(projectIds.map((projectId) => [projectId, true])),
    });
    const loadPreviousWeek = previousWeek.yearMonth !== currentWeek.yearMonth;

    void loadCashflowExportChunksInSequence({
      chunks: chunkCashflowExportProjectIds(projectIds),
      isActive: () => active,
      loadChunk: (chunk) => Promise.all([
        fetchCashflowWeeklyOverviewViaBff({
          tenantId: orgId,
          actor: operationsActor,
          projectIds: chunk,
          yearMonth: currentWeek.yearMonth,
        }).then((value) => ({ status: 'fulfilled' as const, value }), (reason) => ({ status: 'rejected' as const, reason })),
        loadPreviousWeek
          ? fetchCashflowSettlementStatusesBatchViaBff({
            tenantId: orgId,
            actor: operationsActor,
            projectIds: chunk,
            yearMonth: previousWeek.yearMonth,
          }).then((value) => ({ status: 'fulfilled' as const, value }), (reason) => ({ status: 'rejected' as const, reason }))
          : null,
      ]),
      onChunk: (chunk, settled) => {
        const requestedIds = new Set(chunk);
        const overviewItems: Record<string, CashflowWeeklyOverviewItem> = {};
        const settlementResults: CashflowSettlementStatusesResult[] = [];
        const statusErrors: Record<string, boolean> = {};
        const summaryErrors: Record<string, boolean> = {};
        const [currentResult, previousResult] = settled.status === 'fulfilled'
          ? settled.value
          : [{ status: 'rejected' as const, reason: settled.reason }, loadPreviousWeek ? { status: 'rejected' as const, reason: settled.reason } : null];

        if (currentResult.status === 'rejected') {
          chunk.forEach((projectId) => {
            statusErrors[settlementErrorKey(projectId, currentWeek.yearMonth)] = true;
            summaryErrors[projectId] = true;
          });
        } else {
          currentResult.value.items.forEach((item) => {
            if (!requestedIds.has(item.projectId)) return;
            overviewItems[item.projectId] = item;
            if (item.settlementStatuses) settlementResults.push(item.settlementStatuses);
          });
          currentResult.value.errors.forEach((error) => {
            if (requestedIds.has(error.projectId)) summaryErrors[error.projectId] = true;
          });
        }

        if (previousResult?.status === 'rejected') {
          chunk.forEach((projectId) => {
            statusErrors[settlementErrorKey(projectId, previousWeek.yearMonth)] = true;
          });
        } else if (previousResult) {
          previousResult.value.items.forEach((item) => {
            if (requestedIds.has(item.projectId) && item.yearMonth === previousWeek.yearMonth) {
              settlementResults.push(item);
            }
          });
          previousResult.value.errors.forEach((error) => {
            if (requestedIds.has(error.projectId) && error.code === 'STATUS_UNAVAILABLE') {
              statusErrors[settlementErrorKey(error.projectId, previousWeek.yearMonth)] = true;
            }
          });
        }

        setOperationsState((current) => {
          if (current.key !== operationsKey) return current;
          const pendingProjectIds = { ...current.pendingProjectIds };
          chunk.forEach((projectId) => { delete pendingProjectIds[projectId]; });
          return {
            key: operationsKey,
            loading: Object.keys(pendingProjectIds).length > 0,
            overviewItems: { ...current.overviewItems, ...overviewItems },
            settlementResults: [...current.settlementResults, ...settlementResults],
            statusErrors: { ...current.statusErrors, ...statusErrors },
            summaryErrors: { ...current.summaryErrors, ...summaryErrors },
            pendingProjectIds,
          };
        });
      },
    });

    return () => { active = false; };
  }, [bffEnabled, canExport, currentWeek, operationsActor, operationsKey, orgId, previousWeek, targetProjectIdsKey]);

  function toggleProject(projectId: string) {
    setSelectedProjectIds((current) => current.includes(projectId)
      ? current.filter((id) => id !== projectId)
      : [...current, projectId]);
  }

  async function handleDownload() {
    if (!canExport) {
      toast.error('경영기획실 페이지 접근 권한이 없습니다.');
      return;
    }
    if (!bffEnabled || !user) {
      toast.error('내보내기 서버에 연결되지 않았습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    if (targetProjects.length === 0 || yearMonths.length === 0) {
      toast.error('다운로드할 사업 또는 기간을 먼저 선택해 주세요.');
      return;
    }

    setDownloadPreparing(true);
    try {
      const response = await exportCashflowWorkbookViaBff({
          tenantId: orgId,
          actor: {
            uid: user.uid,
            email: user.email,
            role: user.role,
            idToken: user.idToken,
            googleAccessToken: user.googleAccessToken,
          },
          body: {
            scope,
            projectIds: scope === 'selected' ? selectedProjectIds : undefined,
            department: departmentFilter === 'ALL' ? undefined : departmentFilter,
            accountTypes: accountTypeFilter === 'ALL' ? undefined : accountTypeFilter,
            sortBy,
            startYearMonth: yearMonths[0],
            endYearMonth: yearMonths[yearMonths.length - 1],
            variant: workbookVariant,
          },
      });
      triggerDownload(response.blob, response.fileName);
      toast.success('캐시플로 엑셀을 준비했습니다.');
    } catch (error) {
      const message = error instanceof Error ? error.message : '캐시플로 다운로드에 실패했습니다.';
      toast.error(message);
    } finally {
      setDownloadPreparing(false);
    }
  }

  if (!canExport) {
    return (
        <Card>
        <CardContent className="p-8 text-center space-y-2">
          <FileSpreadsheet className="w-8 h-8 mx-auto text-muted-foreground/40" />
          <p className="text-[13px] font-semibold text-zinc-950">경영기획실 페이지 접근 권한이 없습니다.</p>
          <p className="text-[12px] text-stone-600">관리자와 경영기획실 담당자만 주간 상태 정리와 엑셀 다운로드를 사용할 수 있습니다.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div data-testid="cashflow-export-page">
      <div
        data-testid="cashflow-export-split-layout"
        className={panelProject ? 'lg:grid lg:grid-cols-2 lg:items-start lg:gap-4' : ''}
      >
        <div data-testid="cashflow-export-primary-pane" className="min-w-0 space-y-4">
      <PageHeader
        icon={BarChart3}
        iconGradient="linear-gradient(135deg, #fafaf9 0%, #f5f5f4 100%)"
        title="경영기획실 통합 관리"
        description="프로젝트와 기간을 선택해 서버 기준 현금흐름 엑셀을 다운로드합니다."
        badge={scope === 'selected' ? '선택 사업 추출' : '전체 추출'}
        badgeVariant="outline"
        actions={(
          <Button
            data-testid="cashflow-export-download"
            onClick={handleDownload}
            disabled={downloadPreparing || !bffEnabled || targetProjects.length === 0 || yearMonths.length === 0}
            className="h-8 gap-1.5 rounded-lg border border-stone-900 bg-stone-900 text-[12px] text-white hover:bg-stone-800"
          >
            {downloadPreparing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            {downloadPreparing ? '준비 중' : '엑셀 다운로드'}
          </Button>
        )}
      />

      <Card className="border-stone-200 bg-white shadow-none">
        <CardHeader className="pb-3">
          <CardTitle className="text-[14px] font-semibold text-zinc-950">내보내기 설정</CardTitle>
          <p className="text-[12px] text-stone-600">
            {scope === 'selected' ? '선택 사업' : '전체 사업'} · {projectSelectionLabel} · {accountTypeFilterLabel} · {periodSummary || '기간 미선택'} · {workbookVariantLabel}
          </p>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <SelectionField
            step="1"
            icon={Layers3}
            label="대상 범위"
            helper="전체 사업을 한 번에 받을지, 필요한 사업을 여러 개 고를지 선택합니다."
            value={scope === 'selected' ? '사업 선택' : '전체 사업'}
            testId="cashflow-export-step-range"
            toneClass={monochromeSurfaceClass}
          >
            <Select
              value={scope}
              onValueChange={(value) => {
                if (value === 'all' || value === 'selected') setScope(value);
              }}
            >
              <SelectTrigger
                data-testid="cashflow-export-scope"
                className={`${strongFieldBaseClass} border-stone-300 hover:border-stone-400 focus-visible:ring-stone-200`}
                style={{ borderWidth: 2 }}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체 사업</SelectItem>
                <SelectItem value="selected">사업 선택</SelectItem>
              </SelectContent>
            </Select>
          </SelectionField>

          <SelectionField
            step="2"
            icon={BarChart3}
            label="정렬 기준"
            helper="워크북의 사업 순서를 사업명 또는 소속 기준으로 정합니다."
            value={sortByLabel}
            testId="cashflow-export-step-sort"
            toneClass={monochromeSurfaceClass}
          >
            <Select
              value={sortBy}
              onValueChange={(value) => {
                if (value === 'PROJECT_NAME' || value === 'DEPARTMENT') setSortBy(value);
              }}
            >
              <SelectTrigger data-testid="cashflow-export-sort" className={`${strongFieldBaseClass} border-stone-300 hover:border-stone-400 focus-visible:ring-stone-200`} style={{ borderWidth: 2 }}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PROJECT_NAME">사업명</SelectItem>
                <SelectItem value="DEPARTMENT">소속(CIC/센터)</SelectItem>
              </SelectContent>
            </Select>
          </SelectionField>

          <SelectionField
            step="3"
            icon={Layers3}
            label="소속(CIC/센터)"
            helper="담당 조직을 기준으로 다운로드 대상을 좁힙니다."
            value={departmentFilter === 'ALL' ? '전체 소속' : departmentFilter}
            testId="cashflow-export-step-department"
            toneClass={monochromeSurfaceClass}
          >
            <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
              <SelectTrigger data-testid="cashflow-export-department" className={`${strongFieldBaseClass} border-stone-300 hover:border-stone-400 focus-visible:ring-stone-200`} style={{ borderWidth: 2 }}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">전체 소속</SelectItem>
                {departments.map((department) => <SelectItem key={department} value={department}>{department}</SelectItem>)}
              </SelectContent>
            </Select>
          </SelectionField>

          <SelectionField
            step="4"
            icon={FolderSearch}
            label="사업 다중선택"
            helper={scope === 'selected' ? '다운로드할 사업을 여러 개 선택합니다.' : '전체 사업 범위에서는 자동으로 모든 사업이 포함됩니다.'}
            value={scope === 'selected' ? projectSelectionLabel : '자동 포함'}
            testId="cashflow-export-step-project"
            toneClass={monochromeSurfaceClass}
          >
            <Popover open={projectPickerOpen} onOpenChange={setProjectPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  role="combobox"
                  data-testid="cashflow-export-project"
                  disabled={scope !== 'selected'}
                  className={`${strongFieldBaseClass} w-full justify-between px-3 ${scope === 'selected' ? 'border-stone-300' : activeDisabledFieldClass}`}
                >
                  <span className="truncate">{scope === 'selected' ? projectSelectionLabel : '전체 사업 자동 포함'}</span>
                  <ChevronsUpDown className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
                <Command>
                  <CommandInput placeholder="사업명 또는 소속 검색" />
                  <CommandList className="max-h-[300px]">
                    <CommandEmpty>조건에 맞는 사업이 없습니다.</CommandEmpty>
                    <CommandGroup heading="다운로드할 사업">
                      {sortedProjects
                        .filter((project) => departmentFilter === 'ALL' || project.department === departmentFilter)
                        .filter((project) => accountTypeFilter === 'ALL' || accountTypeFilter.includes(project.accountType))
                        .map((project) => {
                          const selected = selectedProjectIds.includes(project.id);
                          return (
                            <CommandItem key={project.id} value={`${project.name} ${project.department}`} onSelect={() => toggleProject(project.id)}>
                              <Check className={`h-4 w-4 ${selected ? 'opacity-100' : 'opacity-0'}`} />
                              <span className="truncate">{project.name}</span>
                              <span className="ml-auto text-[10px] text-muted-foreground">{project.department}</span>
                            </CommandItem>
                          );
                        })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </SelectionField>

          <SelectionField
            step="5"
            icon={BarChart3}
            label="통장 유형 다중선택"
            helper="정산 정보에 저장된 통장 유형을 여러 개 함께 고릅니다."
            showHelper
            value={accountTypeFilterLabel}
            testId="cashflow-export-step-account-type"
            toneClass={monochromeSurfaceClass}
          >
            <Popover open={accountTypePickerOpen} onOpenChange={setAccountTypePickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  role="combobox"
                  aria-expanded={accountTypePickerOpen}
                  data-testid="cashflow-export-account-type"
                  className={`${strongFieldBaseClass} w-full justify-between border-stone-300 px-3 hover:border-stone-400 focus-visible:ring-stone-200`}
                >
                  <span className="truncate">{accountTypeFilterLabel}</span>
                  <ChevronsUpDown className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
                <Command>
                  <CommandList>
                    <CommandGroup heading="추출할 통장 유형">
                      <CommandItem value="전체 통장 유형" onSelect={() => setAccountTypeFilter('ALL')}>
                        <Check className={`h-4 w-4 ${accountTypeFilter === 'ALL' ? 'opacity-100' : 'opacity-0'}`} />
                        전체 통장 유형
                      </CommandItem>
                      {(Object.entries(ACCOUNT_TYPE_LABELS) as Array<[AccountType, string]>).map(([value, label]) => {
                        const selected = accountTypeFilter !== 'ALL' && accountTypeFilter.includes(value);
                        const optionLabel = `${label} (${accountTypeCounts[value]}개)`;
                        return (
                          <CommandItem
                            key={value}
                            value={optionLabel}
                            onSelect={() => setAccountTypeFilter((current) => toggleCashflowExportAccountType(current, value))}
                          >
                            <Check className={`h-4 w-4 ${selected ? 'opacity-100' : 'opacity-0'}`} />
                            {optionLabel}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </SelectionField>

          <SelectionField
            step="6"
            icon={CalendarRange}
            label="기간 범위"
            helper="기본은 연간 일괄이며, 필요하면 시작 월과 종료 월을 직접 지정할 수 있습니다."
            value={rangeMode === 'year' ? '연간 일괄' : '기간 직접 선택'}
            testId="cashflow-export-step-period"
            toneClass={monochromeSurfaceClass}
          >
            <Select
              value={rangeMode}
              onValueChange={(value) => {
                if (value === 'year' || value === 'custom') setRangeMode(value);
              }}
            >
              <SelectTrigger
                data-testid="cashflow-export-range-mode"
                className={`${strongFieldBaseClass} border-stone-300 hover:border-stone-400 focus-visible:ring-stone-200`}
                style={{ borderWidth: 2 }}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="year">연간 일괄</SelectItem>
                <SelectItem value="custom">기간 직접 선택</SelectItem>
              </SelectContent>
            </Select>
          </SelectionField>

          <SelectionField
            step="7"
            icon={FileSpreadsheet}
            label="워크북 형식"
            helper="경영기획실 후처리 방식에 맞춰 통합 시트 또는 사업별 시트를 선택합니다."
            value={workbookVariantLabel}
            testId="cashflow-export-step-variant"
            toneClass={monochromeSurfaceClass}
          >
            <Select
              value={workbookVariant}
              onValueChange={(value) => {
                if (value === 'combined' || value === 'multi-sheet') {
                  setMultiProjectVariant(value as 'combined' | 'multi-sheet');
                }
              }}
            >
              <SelectTrigger
                data-testid="cashflow-export-variant"
                className={`${strongFieldBaseClass} border-stone-300 hover:border-stone-400 focus-visible:ring-stone-200`}
                style={{ borderWidth: 2 }}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="combined">대상 사업 통합 시트</SelectItem>
                <SelectItem value="multi-sheet">대상 사업 개별 시트</SelectItem>
              </SelectContent>
            </Select>
          </SelectionField>

          {rangeMode === 'year' ? (
            <SelectionField
              step="8"
              icon={CalendarRange}
              label="추출 연도"
              helper="월당 5주 고정 슬롯으로 1년 전체를 한 번에 구성합니다."
              value={`${selectedYear}년`}
              testId="cashflow-export-step-year"
              toneClass={`${monochromeSurfaceClass} md:col-span-2`}
            >
              <Select value={selectedYear} onValueChange={setSelectedYear}>
                <SelectTrigger
                  id="cashflow-export-year"
                  data-testid="cashflow-export-year"
                  className={`${strongFieldBaseClass} border-stone-300 hover:border-stone-400 focus-visible:ring-stone-200`}
                  style={{ borderWidth: 2 }}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableYears.map((year) => (
                    <SelectItem key={year} value={year}>{year}년</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SelectionField>
          ) : (
            <>
              <SelectionField
                step="8A"
                icon={CalendarRange}
                label="시작 월"
                helper="직접 추출을 시작할 월입니다."
                value={startYearMonth || '미선택'}
                testId="cashflow-export-step-start"
                toneClass={monochromeSurfaceClass}
              >
                <Input
                  id="cashflow-export-start"
                  data-testid="cashflow-export-start"
                  type="month"
                  value={startYearMonth}
                  onChange={(event) => setStartYearMonth(event.target.value)}
                  className="h-10 rounded-lg border-2 border-stone-300 bg-white text-[12px] font-medium text-zinc-950 shadow-none focus-visible:ring-2 focus-visible:ring-stone-200"
                />
              </SelectionField>
              <SelectionField
                step="8B"
                icon={CalendarRange}
                label="종료 월"
                helper="마지막으로 포함할 월입니다."
                value={endYearMonth || '미선택'}
                testId="cashflow-export-step-end"
                toneClass={monochromeSurfaceClass}
              >
                <Input
                  id="cashflow-export-end"
                  data-testid="cashflow-export-end"
                  type="month"
                  value={endYearMonth}
                  onChange={(event) => setEndYearMonth(event.target.value)}
                  className="h-10 rounded-lg border-2 border-stone-300 bg-white text-[12px] font-medium text-zinc-950 shadow-none focus-visible:ring-2 focus-visible:ring-stone-200"
                />
              </SelectionField>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="border-stone-200 bg-stone-50 shadow-none">
        <CardContent className="grid gap-3 p-4 text-[12px] text-stone-600 sm:grid-cols-2">
          <div>
            <p className="text-[11px] text-stone-500">대상 사업</p>
            <p className="mt-1 font-semibold text-zinc-950">{targetProjects.length}건</p>
          </div>
          <div>
            <p className="text-[11px] text-stone-500">기간</p>
            <p className="mt-1 font-semibold text-zinc-950">{periodSummary || '기간 미선택'}</p>
          </div>
          {!bffEnabled ? <p className="sm:col-span-2 text-red-700">내보내기 서버 연결을 확인해 주세요.</p> : null}
        </CardContent>
      </Card>

      <Card className="border-stone-200 bg-white shadow-none">
        <CardHeader className="pb-3">
          <CardTitle className="text-[14px] font-semibold text-zinc-950">다운로드 대상 사업</CardTitle>
          <p className="text-[11px] text-stone-600">
            최근 두 주의 주정산 상태와 시트에서 마지막으로 불러온 저장값을 함께 확인합니다.
          </p>
          {operationsProgress ? (
            <p
              data-testid="cashflow-export-operations-progress"
              role={operationsProgress.tone === 'alert' ? 'alert' : 'status'}
              className={`text-[11px] ${operationsProgress.tone === 'alert' ? 'text-amber-800' : 'text-stone-500'}`}
            >
              {operationsProgress.text}
            </p>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          <div
            ref={operationsTableRef}
            data-testid="cashflow-export-operations-table"
            role="region"
            aria-label="다운로드 대상 사업 운영 현황"
            tabIndex={0}
            onScroll={(event) => {
              if (event.currentTarget.scrollWidth > event.currentTarget.clientWidth) {
                operationsTableScrollLeftRef.current = event.currentTarget.scrollLeft;
              }
            }}
            className="max-h-[620px] overflow-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stone-300"
          >
            <table className="w-full min-w-[1320px] text-[11px]">
              <thead className="sticky top-0 z-10 bg-stone-50">
                <tr className="border-y border-stone-200">
                  <th className="px-4 py-2 text-left font-semibold">사업명</th>
                  <th className="px-3 py-2 text-left font-semibold">조직장</th>
                  <th className="px-3 py-2 text-left font-semibold">담당자</th>
                  <th className="px-3 py-2 text-left font-semibold">주정산 최근 2주</th>
                  <th className="px-3 py-2 text-center font-semibold">누적 Projection-Actual</th>
                  <th className="px-3 py-2 text-left font-semibold">시트 불러온 시각</th>
                  <th className="px-4 py-2 text-right font-semibold">이동</th>
                </tr>
              </thead>
              <tbody>
                {targetProjects.map((project) => {
                  const overviewItem = scopedOperations.overviewItems[project.id];
                  const pending = Boolean(scopedOperations.pendingProjectIds[project.id]);
                  const summaryError = Boolean(scopedOperations.summaryErrors[project.id]);
                  return (
                    <tr key={project.id} className="border-b border-stone-100 align-top hover:bg-stone-50/70">
                      <td className="px-4 py-3 font-semibold text-zinc-950">{project.name}</td>
                      <td className="px-3 py-3 text-stone-700">{formatCashflowExecutiveApprover(project, persons)}</td>
                      <td className="px-3 py-3 text-stone-700">{formatCashflowManager(project, persons)}</td>
                      <td className="min-w-[420px] px-3 py-3">
                        <div className="grid grid-cols-2 gap-2">
                          {recentWeeks.map((week) => (
                            <SettlementWeekStrip
                              key={`${project.id}:${week.yearMonth}:${week.period}`}
                              week={week}
                              item={findCashflowExportSettlementStatus(scopedOperations.settlementResults, project.id, week)}
                              loading={pending}
                              error={Boolean(scopedOperations.statusErrors[settlementErrorKey(project.id, week.yearMonth)])}
                            />
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-center">
                        {pending ? (
                          <span role="status" className="text-stone-500">불러오는 중…</span>
                        ) : summaryError ? (
                          <span role="alert" className="text-amber-800">시트 현황을 불러오지 못함</span>
                        ) : overviewItem?.projectionActualSummary ? (
                          <CashflowCanonicalSummary summary={overviewItem.projectionActualSummary} />
                        ) : (
                          <span className="text-stone-500">시트 저장값 없음</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-stone-600">
                        {pending
                          ? <span role="status" className="text-stone-500">불러오는 중…</span>
                          : summaryError
                          ? <span role="alert" className="text-amber-800">시트 현황을 불러오지 못함</span>
                          : overviewItem?.sheetCapturedAt
                            ? formatDateTime(overviewItem.sheetCapturedAt)
                            : '불러온 기록 없음'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`${project.name} 보기`}
                          className="h-7 gap-1 text-[11px]"
                          onClick={() => openProjectPanel(project.id)}
                        >
                          <Columns2 className="h-3.5 w-3.5" /> 사업 보기
                        </Button>
                      </td>
                    </tr>
                  );
                })}
                {targetProjects.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-10 text-center text-stone-500">조건에 맞는 사업이 없습니다.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
        </div>
        {panelProject ? (
          <CashflowExportProjectPane
            project={panelProject}
            yearMonth={currentYearMonth}
            onClose={closeProjectPanel}
          />
        ) : null}
      </div>
    </div>
  );
}
