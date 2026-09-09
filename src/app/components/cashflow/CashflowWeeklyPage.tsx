import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { BarChart3, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '../layout/PageHeader';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { formatProjectPeriod } from './cashflow-schedule-steps';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { useAppStore } from '../../data/store';
import { useCashflowWeeks } from '../../data/cashflow-weeks-store';
import { useAuth } from '../../data/auth-store';
import { useFirebase } from '../../lib/firebase-context';
import {
  fetchCashflowMonthCloseViaBff,
  fetchCashflowWeeklyOverviewViaBff,
  reviewCashflowMonthCloseRequestViaBff,
  transitionCashflowSettlementStatusViaBff,
  type CashflowSettlementCycle,
  type CashflowSettlementPeriod,
  type CashflowSettlementStatus,
  type CashflowSettlementStatusItem,
  type CashflowSettlementStatusesResult,
  type CashflowWeeklyOverviewResult,
} from '../../lib/platform-bff-client';
import { getMonthMondayWeeks } from '../../platform/cashflow-weeks';
import { getProjectRegistrationCicOptions, normalizeProjectDepartment } from '../../platform/project-cic';
import { recordDevtoolsLog, toDevtoolsError } from '../../platform/devtools-transaction-log';
import type { PersonRecord } from '../../lib/platform-bff-client';
import type { Project } from '../../data/types';

export function filterCashflowProjectsByDepartment<T extends { department?: unknown }>(projects: T[], department: string): T[] {
  return projects.filter((project) => department === 'ALL' || normalizeProjectDepartment(project.department) === department);
}

type SettlementStatusFilter = 'ALL' | CashflowSettlementStatus;
type MonthSettlementStatusFilter = 'ALL' | CashflowSettlementCycle['businessState'];

export interface CashflowOwnerOption {
  uid: string;
  label: string;
  email: string;
}

/** People 명부의 UID가 프로젝트 담당자·승인자의 유일한 표시 근거다. */
export function buildCashflowOwnerOptions(people: Array<Pick<PersonRecord, 'uid' | 'name' | 'nickname' | 'email'>>): CashflowOwnerOption[] {
  const byUid = new Map<string, CashflowOwnerOption>();
  people.forEach((person) => {
    const uid = String(person.uid || '').trim();
    const name = String(person.name || '').trim();
    if (!uid || !name || byUid.has(uid)) return;
    const nickname = String(person.nickname || '').trim();
    byUid.set(uid, { uid, label: nickname ? `${name}(${nickname})` : name, email: String(person.email || '').trim() });
  });
  return [...byUid.values()].sort((left, right) => left.label.localeCompare(right.label, 'ko'));
}

export function resolveCashflowOwner(
  uid: string | undefined,
  legacyName: string | undefined,
  options: CashflowOwnerOption[],
) {
  const person = options.find((option) => option.uid === String(uid || '').trim());
  return {
    label: person?.label || '',
    legacyName: String(legacyName || '').trim(),
  };
}

export function formatCashflowExecutiveApprover(project: Pick<Project, 'executiveApproverId' | 'executiveApproverName'>, people: Array<Pick<PersonRecord, 'uid' | 'name' | 'nickname' | 'email'>>) {
  return resolveCashflowOwner(project.executiveApproverId, project.executiveApproverName, buildCashflowOwnerOptions(people)).label || '연결 필요';
}

export function formatCashflowManager(project: Pick<Project, 'managerId' | 'managerName'>, people: Array<Pick<PersonRecord, 'uid' | 'name' | 'nickname' | 'email'>>) {
  return resolveCashflowOwner(project.managerId, project.managerName, buildCashflowOwnerOptions(people)).label || '연결 필요';
}

export function filterCashflowProjectsBySettlementStatus<T extends { id: string; department?: unknown }>(
  projects: T[],
  department: string,
  statuses: Record<string, CashflowSettlementStatusesResult>,
  cycles: Record<string, CashflowSettlementCycle>,
  statusErrors: Record<string, string>,
  monthStatusErrors: Record<string, string>,
  statusesLoading: boolean,
  weekNos: number[],
  monthStatusFilter: MonthSettlementStatusFilter,
  weekStatusFilter: SettlementStatusFilter,
): T[] {
  return filterCashflowProjectsByDepartment(projects, department).filter((project) => {
    const projectStatuses = statuses[project.id];
    if (statusErrors[project.id] || (statusesLoading && !projectStatuses)) return true;
    const matches = (period: CashflowSettlementPeriod, filter: SettlementStatusFilter) => (
      filter === 'ALL' || (statusItem(projectStatuses, period)?.status || 'WAITING_FOR_UPDATE') === filter
    );
    return (Boolean(monthStatusErrors[project.id]) || monthStatusFilter === 'ALL' || cycles[project.id]?.businessState === monthStatusFilter)
      && (weekStatusFilter === 'ALL' || weekNos.some((weekNo) => matches(`WEEK_${weekNo}` as CashflowSettlementPeriod, weekStatusFilter)));
  });
}

function statusItem(result: CashflowSettlementStatusesResult | undefined, period: CashflowSettlementPeriod) {
  return result?.items.find((item) => item.period === period);
}

function SettlementStatusButton({
  item,
  loading,
  canApprove,
  onAction,
}: {
  item?: CashflowSettlementStatusItem;
  loading: boolean;
  canApprove: boolean;
  onAction: (action: 'SUBMIT' | 'APPROVE') => void;
}) {
  const status = item?.status || 'WAITING_FOR_UPDATE';
  if (status === 'COMPLETED') {
    return <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 font-semibold text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />승인 완료</span>;
  }
  if (status === 'WAITING_FOR_UPDATE') {
    return <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 font-semibold text-red-700"><span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />주정산 이전</span>;
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="min-h-8 gap-1.5 whitespace-normal rounded-full border-amber-200 bg-amber-50 px-2.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100"
      disabled={loading || !canApprove}
      onClick={() => onAction('APPROVE')}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      {loading ? '처리 중…' : '조직장 승인 필요'}
    </Button>
  );
}

function MonthSettlementStatusButton({
  cycle,
  deadlineKnown,
  loading,
  onApprove,
}: {
  cycle?: CashflowSettlementCycle;
  deadlineKnown: boolean;
  loading: boolean;
  onApprove: () => void;
}) {
  if (!cycle || cycle.health !== 'OK' || cycle.businessState === 'INCONSISTENT') {
    return <span className="text-amber-700">상태 재확인 필요</span>;
  }
  if (cycle.businessState === 'LOCKED') {
    return <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 font-semibold text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />승인 완료</span>;
  }
  if (cycle.businessState === 'SUBMITTED') {
    const capability = cycle.commandCapabilities.APPROVE_MONTH_CLOSE;
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="min-h-8 gap-1.5 whitespace-normal rounded-full border-amber-200 bg-amber-50 px-2.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100"
        disabled={loading || !deadlineKnown || !capability.allowed}
        title={!deadlineKnown ? '월 결산 마감을 확인한 뒤 승인할 수 있습니다.' : undefined}
        onClick={onApprove}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
        {loading ? '처리 중…' : '조직장 승인 필요'}
      </Button>
    );
  }
  const label = cycle.businessState === 'REOPEN_REQUESTED'
    ? '재오픈 승인 대기'
    : cycle.businessState === 'REOPENED'
      ? '재결산 필요'
      : cycle.businessState === 'REJECTED'
        ? '월 결산 반려'
        : cycle.businessState === 'WITHDRAWN'
          ? '요청 회수'
          : '결산 전';
  return <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 font-semibold text-red-700"><span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />{label}</span>;
}

function ProjectPeriodLine({ start, end }: { start?: string | null; end?: string | null }) {
  const period = formatProjectPeriod(start, end);
  if (!period) return null;
  return <p className="truncate text-[11px] font-normal text-muted-foreground">{period}</p>;
}

function SettlementStatusFilterSelect({
  label,
  value,
  onValueChange,
}: {
  label: string;
  value: SettlementStatusFilter;
  onValueChange: (value: SettlementStatusFilter) => void;
}) {
  return (
    <div className="w-[140px]">
      <Label className="mb-1.5 block text-[11px] font-semibold text-slate-600">{label}</Label>
      <Select value={value} onValueChange={(next) => onValueChange(next as SettlementStatusFilter)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">전체 상태</SelectItem>
          <SelectItem value="WAITING_FOR_UPDATE">주정산 이전</SelectItem>
          <SelectItem value="PENDING_APPROVAL">조직장 승인 필요</SelectItem>
          <SelectItem value="COMPLETED">승인 완료</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function MonthSettlementStatusFilterSelect({
  value,
  onValueChange,
}: {
  value: MonthSettlementStatusFilter;
  onValueChange: (value: MonthSettlementStatusFilter) => void;
}) {
  return (
    <div className="w-[140px]">
      <Label className="mb-1.5 block text-[11px] font-semibold text-slate-600">월결산 상태</Label>
      <Select value={value} onValueChange={(next) => onValueChange(next as MonthSettlementStatusFilter)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">전체 상태</SelectItem>
          <SelectItem value="NOT_REQUESTED">결산 전</SelectItem>
          <SelectItem value="SUBMITTED">조직장 승인 필요</SelectItem>
          <SelectItem value="LOCKED">승인 완료</SelectItem>
          <SelectItem value="REOPEN_REQUESTED">재오픈 승인 대기</SelectItem>
          <SelectItem value="REOPENED">재결산 필요</SelectItem>
          <SelectItem value="REJECTED">월 결산 반려</SelectItem>
          <SelectItem value="WITHDRAWN">요청 회수</SelectItem>
          <SelectItem value="INCONSISTENT">상태 재확인 필요</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function formatSettlementAt(value: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || '';
  return `${part('day')}일 ${part('hour')}:${part('minute')}`;
}

function SettlementApprovalTimes({ item }: { item?: CashflowSettlementStatusItem }) {
  const submittedAt = formatSettlementAt(item?.submittedAt || '');
  const approvedAt = formatSettlementAt(item?.approvedAt || '');
  if (!submittedAt && !approvedAt) return null;
  return (
    <div className="mt-1.5 flex flex-col items-center gap-0.5 text-center text-[9px] leading-tight text-slate-500">
      {submittedAt ? <div>실무자 결재: {submittedAt}</div> : null}
      {approvedAt ? <div>조직장 승인: {approvedAt}</div> : null}
    </div>
  );
}

export function CashflowWeeklyPage() {
  const navigate = useNavigate();
  const { projects, persons, updateProject } = useAppStore();
  const { user } = useAuth();
  const { orgId } = useFirebase();
  const { yearMonth, isLoading, goPrevMonth, goNextMonth } = useCashflowWeeks();
  const monthWeeks = useMemo(() => getMonthMondayWeeks(yearMonth), [yearMonth]);
  const [overview, setOverview] = useState<CashflowWeeklyOverviewResult | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState('');
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [actionKey, setActionKey] = useState('');
  const [ownerLinkingKey, setOwnerLinkingKey] = useState('');
  const [deptFilter, setDeptFilter] = useState('ALL');
  const [monthStatusFilter, setMonthStatusFilter] = useState<MonthSettlementStatusFilter>('ALL');
  const [weekStatusFilter, setWeekStatusFilter] = useState<SettlementStatusFilter>('ALL');
  const departments = useMemo(() => Array.from(new Set([
    ...getProjectRegistrationCicOptions(),
    ...projects.map((project) => normalizeProjectDepartment(project.department)).filter(Boolean),
  ])).sort((left, right) => left.localeCompare(right, 'ko')), [projects]);
  const departmentProjects = useMemo(() => filterCashflowProjectsByDepartment(projects, deptFilter), [deptFilter, projects]);
  const ownerOptions = useMemo(
    () => buildCashflowOwnerOptions(persons),
    [persons],
  );
  const ownerLinkIssues = useMemo(() => {
    if (persons.length === 0) return [];
    return projects.flatMap((project) => {
      const executiveApprover = resolveCashflowOwner(project.executiveApproverId, project.executiveApproverName, ownerOptions);
      const manager = resolveCashflowOwner(project.managerId, project.managerName, ownerOptions);
      return [
        ...(!executiveApprover.label && (project.executiveApproverId || executiveApprover.legacyName) ? [{
          key: `${project.id}:executive`, project, role: '조직장' as const, legacyName: executiveApprover.legacyName, uid: project.executiveApproverId || '',
        }] : []),
        ...(!manager.label && (project.managerId || manager.legacyName) ? [{
          key: `${project.id}:manager`, project, role: '책임자' as const, legacyName: manager.legacyName, uid: project.managerId || '',
        }] : []),
      ];
    });
  }, [ownerOptions, persons.length, projects]);
  const overviewProjectIds = useMemo(() => departmentProjects.map((project) => project.id), [departmentProjects]);
  const overviewProjectIdsKey = useMemo(() => JSON.stringify(overviewProjectIds), [overviewProjectIds]);
  const overviewActor = useMemo(() => user ? {
    uid: user.uid,
    email: user.email,
    role: user.role,
    idToken: user.idToken,
  } : null, [user?.uid, user?.email, user?.role, user?.idToken]);
  const statuses = useMemo<Record<string, CashflowSettlementStatusesResult>>(() => Object.fromEntries(
    (overview?.items || []).flatMap((item) => item.settlementStatuses ? [[item.projectId, item.settlementStatuses]] : []),
  ), [overview]);
  const cycles = useMemo<Record<string, CashflowSettlementCycle>>(() => Object.fromEntries(
    (overview?.items || []).map((item) => [item.projectId, item.settlementCycle]),
  ), [overview]);
  const closeDeadline = overview?.items[0]?.settlementCycle.closeDeadline || '';
  const monthDeadlineKnown = closeDeadline === `${yearMonth}-10`;
  const monthCloseTargetYearMonth = overview?.monthCloseTargetYearMonth || '';
  const monthCloseTargetLabel = /^20\d{2}-(0[1-9]|1[0-2])$/.test(monthCloseTargetYearMonth)
    ? `${monthCloseTargetYearMonth.slice(0, 4) === yearMonth.slice(0, 4) ? '' : `${monthCloseTargetYearMonth.slice(0, 4)}년 `}${Number(monthCloseTargetYearMonth.slice(5, 7))}월분 결산`
    : '월결산';
  const monthCloseDeadlineLabel = monthDeadlineKnown
    ? `${Number(closeDeadline.slice(5, 7))}/${Number(closeDeadline.slice(8, 10))} 마감`
    : '마감 확인 필요';
  const statusErrors = useMemo<Record<string, string>>(() => {
    if (overviewError) return Object.fromEntries(overviewProjectIds.map((projectId) => [projectId, '상태 재확인 필요']));
    return {};
  }, [overviewError, overviewProjectIds]);
  const monthStatusErrors = useMemo<Record<string, string>>(() => {
    return Object.fromEntries((overview?.items || [])
      .filter((item) => item.settlementCycle.health !== 'OK' || item.settlementCycle.businessState === 'INCONSISTENT')
      .map((item) => [item.projectId, '상태 재확인 필요']));
  }, [overview]);
  const filteredProjects = useMemo(() => filterCashflowProjectsBySettlementStatus(
    projects,
    deptFilter,
    statuses,
    cycles,
    statusErrors,
    monthStatusErrors,
    overviewLoading,
    monthWeeks.map((week) => week.weekNo),
    monthStatusFilter,
    weekStatusFilter,
  ), [cycles, deptFilter, monthStatusErrors, monthStatusFilter, monthWeeks, overviewLoading, projects, statusErrors, statuses, weekStatusFilter]);

  useEffect(() => {
    const projectIds = JSON.parse(overviewProjectIdsKey) as string[];
    if (!overviewActor?.idToken || projectIds.length === 0) {
      setOverview(null);
      setOverviewLoading(false);
      setOverviewError('');
      return;
    }
    let active = true;
    const startedAt = Date.now();
    setOverviewLoading(true);
    setOverviewError('');
    setOverview(null);
    const requestTimer = window.setTimeout(() => {
      recordDevtoolsLog({
        kind: 'cashflow_transaction',
        phase: 'start',
        operation: 'cashflow.weekly_overview',
        transport: 'bff',
        yearMonth,
        summary: { projectCount: projectIds.length },
      });
      void fetchCashflowWeeklyOverviewViaBff({
        tenantId: orgId,
        actor: overviewActor,
        projectIds,
        yearMonth,
      }).then((result) => {
        if (!active) return;
        setOverview(result);
        recordDevtoolsLog({
          kind: 'cashflow_transaction',
          phase: 'success',
          operation: 'cashflow.weekly_overview',
          transport: 'bff',
          yearMonth,
          durationMs: Date.now() - startedAt,
          summary: { projectCount: projectIds.length, itemCount: result.items.length, issueCount: result.errors.length },
        });
      }).catch((error) => {
        if (!active) return;
        setOverviewError('현금흐름 현황을 불러오지 못했습니다. 다시 불러와 주세요.');
        recordDevtoolsLog({
          kind: 'cashflow_transaction',
          phase: 'error',
          operation: 'cashflow.weekly_overview',
          transport: 'bff',
          yearMonth,
          durationMs: Date.now() - startedAt,
          summary: { projectCount: projectIds.length },
          error: toDevtoolsError(error),
        });
      }).finally(() => {
        if (active) setOverviewLoading(false);
      });
    }, 120);
    return () => { active = false; window.clearTimeout(requestTimer); };
  }, [orgId, overviewActor, overviewProjectIdsKey, refreshSequence, yearMonth]);

  async function transition(projectId: string, period: Exclude<CashflowSettlementPeriod, 'MONTH'>, action: 'SUBMIT' | 'APPROVE', targetYearMonth = yearMonth) {
    if (!user?.idToken) return;
    const key = `${projectId}:${period}`;
    setActionKey(key);
    try {
      await transitionCashflowSettlementStatusViaBff({ tenantId: orgId, actor: user, projectId, yearMonth: targetYearMonth, period, action });
      setRefreshSequence((current) => current + 1);
      toast.success(action === 'APPROVE' ? '정산을 승인했습니다.' : '조직장 승인 대기로 변경했습니다.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '결산 상태를 변경하지 못했습니다.');
    } finally {
      setActionKey('');
    }
  }

  async function approveMonthClose(projectId: string) {
    if (!user?.idToken || !monthDeadlineKnown) return;
    const key = `${projectId}:MONTH`;
    setActionKey(key);
    try {
      const current = await fetchCashflowMonthCloseViaBff({ tenantId: orgId, actor: user, projectId, yearMonth });
      const request = current.monthState;
      if (current.projectId !== projectId
        || current.cycleYearMonth !== yearMonth
        || current.settlementCycle.health !== 'OK'
        || current.settlementCycle.commandCapabilities.APPROVE_MONTH_CLOSE.allowed !== true
        || !request?.manifestHash
        || !Number.isSafeInteger(request.revision)) {
        throw new Error('월 결산 승인 상태를 다시 확인해 주세요.');
      }
      await reviewCashflowMonthCloseRequestViaBff({
        tenantId: orgId,
        actor: user,
        projectId,
        requestId: request.requestId,
        payload: { decision: 'APPROVE', expectedRevision: request.revision, expectedManifestHash: request.manifestHash },
        idempotencyKey: `cashflow-month-close-review:${request.requestId}:approve:r${request.revision}`,
      });
      setRefreshSequence((currentSequence) => currentSequence + 1);
      toast.success('월 결산을 승인했습니다.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '월 결산을 승인하지 못했습니다.');
    } finally {
      setActionKey('');
    }
  }

  async function linkProjectOwner(project: Project, role: '조직장' | '책임자', uid: string) {
    const owner = ownerOptions.find((option) => option.uid === uid);
    if (!owner) return;
    const key = `${project.id}:${role}`;
    setOwnerLinkingKey(key);
    try {
      await updateProject(project.id, role === '조직장'
        ? { executiveApproverId: owner.uid, executiveApproverName: owner.label, executiveApproverEmail: owner.email }
        : { managerId: owner.uid, managerName: owner.label });
      toast.success(`${project.name} ${role}를 ${owner.label}로 연결했습니다.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `${role} 연결을 저장하지 못했습니다.`);
    } finally {
      setOwnerLinkingKey('');
    }
  }

  function openProject(projectId: string) {
    navigate(`/cashflow/projects/${projectId}?ym=${encodeURIComponent(yearMonth)}&view=compare#projection-actual-comparison`);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        icon={BarChart3}
        iconGradient="linear-gradient(135deg, #0d9488 0%, #14b8a6 100%)"
        title="전사 현금흐름 현황"
        description={`프로젝트별 월·주 정산 상태 · ${yearMonth}`}
        actions={(
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[12px]" onClick={goPrevMonth}>
              <ChevronLeft className="h-3.5 w-3.5" /> 이전 달
            </Button>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[12px]" onClick={goNextMonth}>
              다음 달 <ChevronRight className="h-3.5 w-3.5" />
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={() => setRefreshSequence((current) => current + 1)}>
              다시 불러오기
            </Button>
          </div>
        )}
      />

      <div className="flex items-end gap-3 rounded-lg border bg-white px-4 py-3">
        <div className="w-[180px]">
          <Label className="mb-1.5 block text-[11px] font-semibold text-slate-600">담당조직</Label>
          <Select value={deptFilter} onValueChange={setDeptFilter}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">전체 조직</SelectItem>
              {departments.map((department) => <SelectItem key={department} value={department}>{department}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <MonthSettlementStatusFilterSelect value={monthStatusFilter} onValueChange={setMonthStatusFilter} />
        <SettlementStatusFilterSelect label="주정산 상태" value={weekStatusFilter} onValueChange={setWeekStatusFilter} />
        <span className="pb-2 text-[11px] text-muted-foreground">{filteredProjects.length}개 프로젝트</span>
      </div>

      {ownerLinkIssues.length > 0 ? (
        <Card className="border-red-200 bg-red-50/40">
          <CardContent className="space-y-2 p-3">
            <div>
              <p className="text-[12px] font-semibold text-red-800">People 연결 필요 {ownerLinkIssues.length}건</p>
              <p className="text-[11px] text-red-700">레거시 이름은 표시만 하고, 선택한 People UID로만 프로젝트 담당자를 연결합니다.</p>
            </div>
            <div className="max-h-44 space-y-2 overflow-auto">
              {ownerLinkIssues.map((issue) => (
                <div key={issue.key} className="grid items-center gap-2 rounded-md border border-red-100 bg-white px-2 py-2 md:grid-cols-[minmax(150px,1fr)_70px_minmax(160px,1fr)_minmax(180px,1fr)]">
                  <span className="truncate text-[11px] font-medium">{issue.project.name}</span>
                  <span className="text-[11px] text-slate-600">{issue.role}</span>
                  <span className="truncate text-[11px] text-red-700">기존값: {issue.legacyName || issue.uid}</span>
                  <Select
                    value={undefined}
                    disabled={ownerLinkingKey === `${issue.project.id}:${issue.role}`}
                    onValueChange={(uid) => void linkProjectOwner(issue.project, issue.role, uid)}
                  >
                    <SelectTrigger className="h-8 text-[11px]"><SelectValue placeholder="People에서 연결" /></SelectTrigger>
                    <SelectContent>
                      {ownerOptions.map((owner) => <SelectItem key={owner.uid} value={owner.uid}>{owner.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {overviewError ? <div role="alert" className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-[11px] text-amber-900">{overviewError}</div> : null}
          <div className="max-h-[calc(100vh-190px)] overflow-auto">
            <table className="w-full min-w-[1440px] border-separate border-spacing-0 text-[11px]">
              <thead>
                <tr className="bg-muted/30">
                  <th className="sticky left-0 top-0 z-40 min-w-[180px] border-b bg-slate-50 px-3 py-2 text-left font-bold">프로젝트</th>
                  <th className="sticky left-[180px] top-0 z-40 min-w-[104px] border-b bg-slate-50 px-2 py-2 text-left font-bold">조직장</th>
                  <th className="sticky left-[284px] top-0 z-40 min-w-[104px] border-b bg-slate-50 px-2 py-2 text-left font-bold">책임자</th>
                  <th className="sticky top-0 z-30 min-w-[170px] border-b bg-slate-50 px-3 py-2 text-center font-bold">
                    <div>{monthCloseTargetLabel} · <span className="text-[10px] text-muted-foreground">{monthCloseDeadlineLabel}</span></div>
                  </th>
                  <th className="sticky top-0 z-30 min-w-[140px] border-b border-l-2 border-slate-300 bg-slate-50 px-3 py-2 text-center font-bold">현금흐름(링크)</th>
                  {monthWeeks.map((week) => (
                    <th key={week.weekNo} className="sticky top-0 z-30 min-w-[170px] border-b bg-slate-50 px-3 py-2 text-center font-bold">
                      <div>{week.label}</div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">{week.weekStart}~{week.weekEnd}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredProjects.map((project) => {
                  const projectStatuses = statuses[project.id];
                  const canApprove = user?.uid === project.executiveApproverId;
                  const executiveApprover = resolveCashflowOwner(project.executiveApproverId, project.executiveApproverName, ownerOptions);
                  const manager = resolveCashflowOwner(project.managerId, project.managerName, ownerOptions);
                  return (
                    <tr key={project.id} className="border-t border-border/30 transition-colors hover:bg-muted/20">
                      <td className="sticky left-0 z-20 bg-white px-3 py-2">
                        <p className="truncate font-semibold">{project.name}</p>
                        {/* 종료가 다가오면 체크아웃이 붙는다 - 일정 판단에 기간이 필요하다(2026-08-20 보람). */}
                        <ProjectPeriodLine start={project.contractStart} end={project.contractEnd} />
                      </td>
                      <td className="sticky left-[180px] z-20 bg-white px-2 py-2 font-medium">{executiveApprover.label || <span className="text-red-700">연결 필요</span>}</td>
                      <td className="sticky left-[284px] z-20 bg-white px-2 py-2 font-medium">{manager.label || <span className="text-red-700">연결 필요</span>}</td>
                      <td className="px-3 py-3 text-center">
                        {statusErrors[project.id] || monthStatusErrors[project.id]
                          ? <span className="text-amber-700">{statusErrors[project.id] || monthStatusErrors[project.id]}</span>
                          : (overviewLoading && !cycles[project.id])
                            ? <span className="text-muted-foreground">확인 중…</span>
                            : <MonthSettlementStatusButton cycle={cycles[project.id]} deadlineKnown={monthDeadlineKnown} loading={actionKey === `${project.id}:MONTH`} onApprove={() => void approveMonthClose(project.id)} />}
                        {!statusErrors[project.id] && !monthStatusErrors[project.id]
                          ? <SettlementApprovalTimes item={cycles[project.id]?.monthCloseSettlement || undefined} />
                          : null}
                      </td>
                      <td className="border-l-2 border-slate-300 px-3 py-3 text-center">
                        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[11px]" onClick={() => openProject(project.id)}>
                          <ExternalLink className="h-3.5 w-3.5" /> 현금흐름 보기
                        </Button>
                      </td>
                      {monthWeeks.map((week) => {
                        const period = `WEEK_${week.weekNo}` as Exclude<CashflowSettlementPeriod, 'MONTH'>;
                        return (
                          <td key={period} className="px-3 py-3 text-center">
                            {statusErrors[project.id] ? <span className="text-amber-700">{statusErrors[project.id]}</span> : (overviewLoading && !projectStatuses) ? <span className="text-muted-foreground">확인 중…</span> : (
                              <SettlementStatusButton
                                item={statusItem(projectStatuses, period)}
                                loading={actionKey === `${project.id}:${period}`}
                                canApprove={canApprove}
                                onAction={(action) => void transition(project.id, period, action)}
                              />
                            )}
                            <SettlementApprovalTimes item={statusItem(projectStatuses, period)} />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {filteredProjects.length === 0 ? (
                  <tr><td className="px-4 py-8 text-center text-[12px] text-muted-foreground" colSpan={5 + monthWeeks.length}>프로젝트가 없습니다.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {isLoading ? <div className="border-t border-border/40 px-4 py-3 text-[11px] text-muted-foreground">불러오는 중…</div> : null}
        </CardContent>
      </Card>
    </div>
  );
}
