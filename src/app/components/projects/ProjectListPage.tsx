import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  Search, ArrowUpDown, ArrowRight,
  FolderKanban, RotateCcw, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '../ui/alert-dialog';
import { useAppStore } from '../../data/store';
import {
  PROJECT_STATUS_LABELS,
  SETTLEMENT_TYPE_LABELS, normalizeSettlementType,
  type ProjectStatus, type SettlementType, type Project,
} from '../../data/types';
import { PageHeader } from '../layout/PageHeader';
import { resolveApiErrorMessage } from '../../platform/api-error-message';
import { groupProjectListItems, matchesProjectListFilters, summarizeProjectListItems } from '../../platform/project-list-view';
import { normalizeProjectRevenueFields } from '../../platform/project-financials';
import { buildProjectMonthlyPerformance } from '../../platform/project-monthly-performance';
import { usePendingProjectChangeRequests } from './usePendingProjectChangeRequests';
import { getProjectRegistrationCicOptions, normalizeProjectDepartment } from '../../platform/project-cic';

const statusColor: Record<string, string> = {
  CONTRACT_PENDING: 'bg-amber-100 text-amber-800',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  COMPLETED: 'bg-green-100 text-green-800',
  COMPLETED_PENDING_PAYMENT: 'bg-teal-100 text-teal-800',
};

function fmtFull(n: number) {
  return n.toLocaleString('ko-KR');
}

function formatChartAmount(amount: number) {
  if (amount === 0) return '-';
  if (Math.abs(amount) >= 100_000_000) return `${(amount / 100_000_000).toFixed(1)}억`;
  if (Math.abs(amount) >= 10_000) return `${Math.round(amount / 10_000)}만`;
  return fmtFull(amount);
}

export function projectCheckoutFileStatus(applicable: boolean, uploaded: boolean) {
  return uploaded ? '첨부 완료' : applicable ? '미첨부' : '해당 없음';
}

type SortKey = 'name' | 'contractAmount' | 'totalRevenueAmount' | 'status';
type SortDir = 'asc' | 'desc';

export function ProjectListPage() {
  const { allProjects, restoreProject, trashProject } = useAppStore();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [settlementFilter, setSettlementFilter] = useState<string>('ALL');
  const [deptFilter, setDeptFilter] = useState<string>('ALL');
  const [sortKey, setSortKey] = useState<SortKey>('contractAmount');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [activeTab, setActiveTab] = useState<string>('contract-pending');
  const projectIds = useMemo(() => allProjects.map((project) => project.id).filter(Boolean), [allProjects]);
  const pendingProjectChangeMap = usePendingProjectChangeRequests(projectIds);

  const {
    active: activeProjects,
    contractPending: contractPendingProjects,
    inProgress: inProgressProjects,
    completed: completedProjects,
    trashed: trashedProjects,
  } = useMemo(() => groupProjectListItems(allProjects), [allProjects]);
  const tabProjects = activeTab === 'trash'
    ? trashedProjects
    : activeTab === 'completed'
      ? completedProjects
      : activeTab === 'in-progress'
        ? inProgressProjects
        : contractPendingProjects;

  const departments = useMemo(() => {
    const depts = new Set([
      ...getProjectRegistrationCicOptions(),
      ...activeProjects.map((project) => normalizeProjectDepartment(project.department)).filter(Boolean),
    ]);
    return Array.from(depts).sort();
  }, [activeProjects]);
  const hasActiveFilters = !!search || statusFilter !== 'ALL' || settlementFilter !== 'ALL' || deptFilter !== 'ALL';

  const summaryProjects = useMemo(() => activeProjects.filter((project) => matchesProjectListFilters(project, {
    search,
    status: statusFilter,
    settlementType: settlementFilter,
    department: deptFilter,
  })), [activeProjects, search, statusFilter, settlementFilter, deptFilter]);
  const portfolioSummary = useMemo(() => summarizeProjectListItems(summaryProjects), [summaryProjects]);
  const monthlyPerformance = useMemo(() => buildProjectMonthlyPerformance(summaryProjects), [summaryProjects]);
  const monthlyMaximum = Math.max(...monthlyPerformance.flatMap((month) => [month.contractAmount, month.totalRevenueAmount]), 0);

  const filtered = useMemo(() => {
    const result = tabProjects.filter((project) => matchesProjectListFilters(project, {
      search,
      status: statusFilter,
      settlementType: settlementFilter,
      department: deptFilter,
    }));

    result.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'contractAmount': cmp = a.contractAmount - b.contractAmount; break;
        case 'totalRevenueAmount': cmp = normalizeProjectRevenueFields(a, 'totalRevenueAmount').totalRevenueAmount - normalizeProjectRevenueFields(b, 'totalRevenueAmount').totalRevenueAmount; break;
        case 'status': cmp = a.status.localeCompare(b.status); break;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });

    return result;
  }, [tabProjects, search, statusFilter, settlementFilter, deptFilter, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const handleRestore = async (project: Project) => {
    try {
      await restoreProject(project.id);
      toast.success(`휴지통에서 복구됨: ${project.name}`);
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '프로젝트 복구에 실패했습니다.'));
    }
  };

  const handleTrash = async (project: Project) => {
    try {
      await trashProject(project.id, '프로젝트 통합 관리에서 휴지통 이동');
      toast.success(`휴지통으로 이동됨: ${project.name}`);
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '프로젝트 휴지통 이동에 실패했습니다.'));
    }
  };

  const resetFilters = () => {
    setSearch('');
    setStatusFilter('ALL');
    setSettlementFilter('ALL');
    setDeptFilter('ALL');
  };

  const renderEmptyState = () => {
    const stateByTab = hasActiveFilters
      ? {
        title: '검색 조건에 맞는 프로젝트가 없습니다',
        description: '필터를 초기화하고 전체 포트폴리오를 다시 확인해 주세요.',
      }
      : activeTab === 'contract-pending'
        ? {
          title: '계약 전 프로젝트가 없습니다',
          description: '등록 요청은 실무자 포털에서 접수되고, 여기서는 계약 전 상태의 프로젝트를 확인합니다.',
        }
        : activeTab === 'in-progress'
          ? {
            title: '진행 중인 프로젝트가 없습니다',
            description: '계약이 완료되어 운영을 시작한 프로젝트가 이 탭에 표시됩니다.',
          }
          : activeTab === 'completed'
            ? {
              title: '종료된 프로젝트가 없습니다',
              description: '완료되었거나 잔금 입금을 기다리는 프로젝트가 이 탭에 표시됩니다.',
            }
            : activeTab === 'trash'
          ? {
            title: '휴지통이 비어 있습니다',
            description: '삭제된 프로젝트가 생기면 이 탭에서 복구할 수 있습니다.',
          }
          : {
            title: '프로젝트가 없습니다',
            description: '프로젝트 상태를 다시 확인해 주세요.',
          };

    return (
      <Card data-testid="projects-empty-state" className="border-slate-200/80 bg-slate-50/70">
        <CardContent className="flex min-h-[220px] items-center justify-center p-6">
          <div className="max-w-md text-center">
            <h2 className="text-[20px] font-semibold tracking-[-0.03em] text-slate-900">{stateByTab.title}</h2>
            <p className="mt-2 text-[13px] leading-6 text-slate-600">{stateByTab.description}</p>
            {hasActiveFilters && (
              <div className="mt-4">
                <Button size="sm" onClick={resetFilters}>필터 초기화</Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  };

  const renderProjectTable = (list: Project[]) => (
    <Card>
      <CardContent className="pt-0 pb-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[90px]">담당조직(CIC)</TableHead>
                <TableHead className="min-w-[200px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="flex items-center gap-1">
                    프로젝트명 <ArrowUpDown className="w-3 h-3" />
                  </span>
                </TableHead>
                <TableHead className="min-w-[120px]">계약 대상</TableHead>
                <TableHead className="cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="flex items-center gap-1">
                    상태 <ArrowUpDown className="w-3 h-3" />
                  </span>
                </TableHead>
                <TableHead className="min-w-[90px]">계약 기간</TableHead>
                <TableHead className="min-w-[80px]">최종 보고자 (실무책임자)</TableHead>
                <TableHead className="text-right min-w-[100px] cursor-pointer" onClick={() => handleSort('contractAmount')}>
                  <span className="flex items-center justify-end gap-1">
                    계약금액 <ArrowUpDown className="w-3 h-3" />
                  </span>
                </TableHead>
                <TableHead className="text-right min-w-[100px] cursor-pointer" onClick={() => handleSort('totalRevenueAmount')}>
                  <span className="flex items-center justify-end gap-1">
                    총수익 <ArrowUpDown className="w-3 h-3" />
                  </span>
                </TableHead>
                <TableHead className="min-w-[150px] text-center">정산 유형</TableHead>
                {activeTab === 'trash' && (
                  <>
                    <TableHead className="min-w-[90px]">삭제일</TableHead>
                    <TableHead className="min-w-[90px] text-center">액션</TableHead>
                  </>
                )}
                {activeTab !== 'trash' && (
                  <TableHead className="min-w-[60px] text-center">액션</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map(p => {
                const totalRevenueAmount = normalizeProjectRevenueFields(p, 'totalRevenueAmount').totalRevenueAmount;
                return (
                <TableRow
                  key={p.id}
                  data-testid={activeTab === 'trash' ? `project-trash-row-${p.id}` : `project-list-row-${p.id}`}
                  className="hover:bg-accent/50"
                >
                  <TableCell className="text-[11px] text-muted-foreground whitespace-nowrap">
                    {normalizeProjectDepartment(p.department) || '-'}
                  </TableCell>
                  <TableCell style={{ fontWeight: 500 }} className="max-w-[220px] truncate text-sm">
                    <span className="inline-flex max-w-full items-center gap-1.5">
                      <span className="truncate">{p.name}</span>
                      {pendingProjectChangeMap.has(p.id) ? (
                        <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                          수정 검토 중
                        </span>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-[11px] whitespace-nowrap">{p.clientOrg || '-'}</TableCell>
                  <TableCell className="text-[11px] whitespace-nowrap">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] whitespace-nowrap ${statusColor[p.status]}`}>
                      {PROJECT_STATUS_LABELS[p.status]}
                    </span>
                  </TableCell>
                  <TableCell className="text-[11px] text-muted-foreground whitespace-nowrap">
                    {p.contractStart ? `${p.contractStart.replace(/-/g, '.')}` : '-'}
                    {p.contractEnd ? ` ~ ${p.contractEnd.replace(/-/g, '.')}` : ''}
                  </TableCell>
                  <TableCell className="text-[11px] whitespace-nowrap">
                    {p.registeredByName || p.managerName || '-'}
                  </TableCell>
                  <TableCell className="text-right text-sm whitespace-nowrap">
                    {p.contractAmount > 0 ? fmtFull(p.contractAmount) : '-'}
                  </TableCell>
                  <TableCell className="text-right text-sm whitespace-nowrap">
                    {totalRevenueAmount > 0 ? fmtFull(totalRevenueAmount) : '-'}
                  </TableCell>
                  <TableCell className="text-center text-sm">
                    <span
                      className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700"
                    >
                      {SETTLEMENT_TYPE_LABELS[normalizeSettlementType(p.settlementType)]}
                    </span>
                  </TableCell>
                  {activeTab === 'trash' && (
                    <>
                      <TableCell className="text-[11px] text-muted-foreground whitespace-nowrap">
                        {p.trashedAt ? p.trashedAt.slice(0, 10).replace(/-/g, '.') : '-'}
                      </TableCell>
                      <TableCell className="text-center" onClick={e => e.stopPropagation()}>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-[10px] gap-0.5 px-1.5"
                            onClick={() => void handleRestore(p)}
                          >
                            복구 <RotateCcw className="w-3 h-3" />
                          </Button>
                      </TableCell>
                    </>
                  )}
                  {activeTab !== 'trash' && (
                    <TableCell className="text-center" onClick={e => e.stopPropagation()}>
                      <div className="flex justify-center gap-1">
                        {activeTab === 'contract-pending' && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-[10px] gap-0.5 px-1.5"
                            onClick={() => navigate(`/projects/${p.id}/edit?phase=CONFIRMED`)}
                          >
                            확정 <ArrowRight className="w-3 h-3" />
                          </Button>
                        )}
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="outline" size="sm" className="h-6 gap-0.5 border-red-200 px-1.5 text-[10px] text-red-700 hover:bg-red-50 hover:text-red-800">
                              휴지통 <Trash2 className="w-3 h-3" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>프로젝트를 휴지통으로 이동하시겠습니까?</AlertDialogTitle>
                              <AlertDialogDescription>
                                &quot;{p.name}&quot;은(는) 활성 목록에서 숨겨집니다. 완전 삭제되지 않으며 휴지통 탭에서 복구할 수 있습니다.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>취소</AlertDialogCancel>
                              <AlertDialogAction onClick={() => void handleTrash(p)}>
                                휴지통 이동
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
                );
              })}

              {list.length === 0 && (
                <TableRow>
                  <TableCell colSpan={activeTab === 'trash' ? 11 : 10} className="text-center py-12 text-muted-foreground">
                    {search || statusFilter !== 'ALL' || settlementFilter !== 'ALL' || deptFilter !== 'ALL'
                      ? '검색 조건에 맞는 프로젝트가 없습니다'
                      : activeTab === 'trash'
                        ? '휴지통이 비어 있습니다.'
                        : activeTab === 'contract-pending'
                          ? '계약 전 프로젝트가 없습니다.'
                          : '등록 프로젝트가 없습니다.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="mx-auto w-full max-w-[1320px] space-y-4">
      {/* Header */}
      <PageHeader
        icon={FolderKanban}
        iconGradient="linear-gradient(135deg, #0891b2, #22d3ee)"
        title="프로젝트 통합 관리"
        description="프로젝트 등록부터 계약·운영·종료까지 현재 단계를 확인합니다."
      />

      <section aria-label="프로젝트 진행 현황" className="grid gap-4 rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-sm xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.9fr)] xl:items-center">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.04em] text-slate-500">프로젝트 진행 현황</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <strong className="text-[28px] font-bold tracking-[-0.04em] text-[#0f2747]">{portfolioSummary.total}</strong>
            <span className="text-sm font-semibold text-slate-800">활성 프로젝트</span>
            <span className="text-xs text-slate-500">선택한 검색·필터 기준</span>
          </div>
          <dl className="mt-3 grid max-w-xl grid-cols-3 divide-x divide-slate-200 border-y border-slate-100 py-2.5">
            <div className="px-3 first:pl-0">
              <dt className="text-[11px] text-slate-500">계약 전</dt>
              <dd className="mt-0.5 text-base font-bold text-[#e5484d]">{portfolioSummary.contractPending}<span className="ml-0.5 text-xs font-medium text-slate-500">개</span></dd>
            </div>
            <div className="px-3">
              <dt className="text-[11px] text-slate-500">진행</dt>
              <dd className="mt-0.5 text-base font-bold text-[#2f9e44]">{portfolioSummary.inProgress}<span className="ml-0.5 text-xs font-medium text-slate-500">개</span></dd>
            </div>
            <div className="px-3">
              <dt className="text-[11px] text-slate-500">종료</dt>
              <dd className="mt-0.5 text-base font-bold text-[#111827]">{portfolioSummary.completed}<span className="ml-0.5 text-xs font-medium text-slate-500">개</span></dd>
            </div>
          </dl>
          <dl className="mt-3 grid max-w-xl grid-cols-2 divide-x divide-slate-200 border-y border-slate-100 py-2.5">
            <div className="pr-3">
              <dt className="text-[11px] text-slate-500">계약금액 합계</dt>
              <dd className="mt-0.5 truncate text-sm font-bold tabular-nums text-slate-900" title={`${fmtFull(portfolioSummary.contractAmount)}원`}>{fmtFull(portfolioSummary.contractAmount)}<span className="ml-0.5 text-[11px] font-medium text-slate-500">원</span></dd>
            </div>
            <div className="pl-3">
              <dt className="text-[11px] text-slate-500">총수익 합계</dt>
              <dd className="mt-0.5 truncate text-sm font-bold tabular-nums text-slate-900" title={`${fmtFull(portfolioSummary.totalRevenueAmount)}원`}>{fmtFull(portfolioSummary.totalRevenueAmount)}<span className="ml-0.5 text-[11px] font-medium text-slate-500">원</span></dd>
            </div>
          </dl>
        </div>
        <section aria-label="승인 기준 월별 매출 및 총수익" className="min-w-0 border-t border-slate-100 pt-4 xl:border-t-0 xl:border-l xl:pl-5 xl:pt-0">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold tracking-[0.04em] text-slate-500">승인 기준 월별</p>
              <p className="mt-0.5 text-sm font-semibold text-slate-800">매출 · 총수익 <span className="text-[11px] font-normal text-slate-500">올해 · KST</span></p>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-slate-600">
              <span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-[#001e46]" />매출</span>
              <span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-[#0e7490]" />총수익</span>
            </div>
          </div>
          <div className="mt-3 grid gap-1" style={{ gridTemplateColumns: `repeat(${monthlyPerformance.length}, minmax(0, 1fr))` }} role="img" aria-label="승인 로그 기준 올해 월별 매출과 총수익 막대 그래프">
            {monthlyPerformance.map((month) => {
              const contractHeight = monthlyMaximum ? Math.max(3, (month.contractAmount / monthlyMaximum) * 100) : 0;
              const revenueHeight = monthlyMaximum ? Math.max(3, (month.totalRevenueAmount / monthlyMaximum) * 100) : 0;
              return (
                <div key={month.key} className="min-w-0" title={`${month.key}: 매출 ${fmtFull(month.contractAmount)}원, 총수익 ${fmtFull(month.totalRevenueAmount)}원`}>
                  <div className="flex h-24 items-end justify-center gap-px border-b border-slate-200">
                    <span className="w-1.5 rounded-t-sm bg-[#001e46]" style={{ height: `${contractHeight}%` }} />
                    <span className="w-1.5 rounded-t-sm bg-[#0e7490]" style={{ height: `${revenueHeight}%` }} />
                  </div>
                  <p className="mt-1 text-center text-[9px] text-slate-500">{month.label}</p>
                </div>
              );
            })}
          </div>
          <div className="mt-2 grid gap-x-1 border-t border-slate-100 pt-2 text-[9px] tabular-nums" style={{ gridTemplateColumns: `28px repeat(${monthlyPerformance.length}, minmax(0, 1fr))` }}>
            <span className="font-semibold text-[#001e46]">매출</span>
            {monthlyPerformance.map((month) => <span key={`${month.key}-sales`} className="truncate text-center text-slate-600" title={`${fmtFull(month.contractAmount)}원`}>{formatChartAmount(month.contractAmount)}</span>)}
            <span className="font-semibold text-[#0e7490]">수익</span>
            {monthlyPerformance.map((month) => <span key={`${month.key}-revenue`} className="truncate text-center text-slate-600" title={`${fmtFull(month.totalRevenueAmount)}원`}>{formatChartAmount(month.totalRevenueAmount)}</span>)}
          </div>
        </section>
      </section>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
      >
        <TabsList
          aria-label="프로젝트 진행 단계"
          className="grid h-11 w-full grid-cols-4 items-center overflow-hidden rounded-lg border border-slate-300 bg-[#0f2747] p-0 shadow-sm"
        >
          <TabsTrigger
            value="contract-pending"
            className="h-full items-center justify-center gap-1.5 rounded-none border-r border-white/15 px-2 py-0 leading-none text-slate-200 data-[state=active]:bg-[#174a7c] data-[state=active]:text-white data-[state=active]:shadow-[inset_0_-3px_0_#ffffff] sm:gap-2 sm:px-4"
            data-testid="projects-tab-contract-pending"
          >
            <span className="font-semibold">계약 전</span>
            <Badge variant="secondary" className="ml-0.5 border-white/20 bg-white/10 px-1.5 py-0 text-[10px] leading-none text-current sm:ml-1">
              {contractPendingProjects.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger
            value="in-progress"
            className="h-full items-center justify-center gap-1.5 rounded-none border-r border-white/15 px-2 py-0 leading-none text-slate-200 data-[state=active]:bg-[#174a7c] data-[state=active]:text-white data-[state=active]:shadow-[inset_0_-3px_0_#ffffff] sm:gap-2 sm:px-4"
            data-testid="projects-tab-in-progress"
          >
            <span className="font-semibold">진행</span>
            <Badge variant="secondary" className="ml-0.5 border-white/20 bg-white/10 px-1.5 py-0 text-[10px] leading-none text-current sm:ml-1">
              {inProgressProjects.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger
            value="completed"
            className="h-full items-center justify-center gap-1.5 rounded-none border-r border-white/15 px-2 py-0 leading-none text-slate-200 data-[state=active]:bg-[#174a7c] data-[state=active]:text-white data-[state=active]:shadow-[inset_0_-3px_0_#ffffff] sm:gap-2 sm:px-4"
            data-testid="projects-tab-completed"
          >
            <span className="font-semibold">종료</span>
            <Badge variant="secondary" className="ml-0.5 border-white/20 bg-white/10 px-1.5 py-0 text-[10px] leading-none text-current sm:ml-1">
              {completedProjects.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger
            value="trash"
            className="h-full items-center justify-center gap-1 rounded-none px-2 py-0 leading-none text-slate-200 data-[state=active]:bg-[#174a7c] data-[state=active]:text-white data-[state=active]:shadow-[inset_0_-3px_0_#ffffff] sm:gap-1.5 sm:px-4"
            data-testid="projects-tab-trash"
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="font-semibold">휴지통</span>
            <Badge variant="secondary" className="ml-0.5 border-white/20 bg-white/10 px-1.5 py-0 text-[10px] leading-none text-current sm:ml-1">
              {trashedProjects.length}
            </Badge>
          </TabsTrigger>
        </TabsList>

        {/* Filters */}
        <Card className="mt-0 rounded-t-none border-t-0 shadow-sm">
          <CardContent className="pt-4 pb-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[220px] flex-1 max-w-sm">
                <Label htmlFor="project-list-search" className="mb-1.5 block text-[11px] font-semibold text-slate-600">프로젝트 검색</Label>
                <div className="relative">
                <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
                <Input
                  id="project-list-search"
                  placeholder="프로젝트명, 계약명, 계약대상, 담당조직, 운영진 검색"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="pl-8"
                />
                </div>
              </div>
              <div className="w-[150px]">
                <Label className="mb-1.5 block text-[11px] font-semibold text-slate-600">담당조직</Label>
                <Select value={deptFilter} onValueChange={setDeptFilter}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">전체 조직</SelectItem>
                    {departments.map(d => (
                      <SelectItem key={d} value={d}>{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-[150px]">
                <Label className="mb-1.5 block text-[11px] font-semibold text-slate-600">진행 상태</Label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">전체 상태</SelectItem>
                    {(Object.keys(PROJECT_STATUS_LABELS) as ProjectStatus[]).map(k => (
                      <SelectItem key={k} value={k}>{PROJECT_STATUS_LABELS[k]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-[180px]">
                <Label className="mb-1.5 block text-[11px] font-semibold text-slate-600">정산 유형</Label>
                <Select value={settlementFilter} onValueChange={setSettlementFilter}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">전체 정산 유형</SelectItem>
                    {(Object.keys(SETTLEMENT_TYPE_LABELS) as SettlementType[]).map(k => (
                      <SelectItem key={k} value={k}>{SETTLEMENT_TYPE_LABELS[k]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <span className="mb-2 text-sm text-muted-foreground">
                {filtered.length}개 프로젝트
              </span>
            </div>
          </CardContent>
        </Card>

        <TabsContent value="contract-pending" className="mt-0">
          {activeTab === 'contract-pending' && (filtered.length === 0 ? renderEmptyState() : renderProjectTable(filtered))}
        </TabsContent>
        <TabsContent value="in-progress" className="mt-0">
          {activeTab === 'in-progress' && (filtered.length === 0 ? renderEmptyState() : renderProjectTable(filtered))}
        </TabsContent>
        <TabsContent value="completed" className="mt-0">
          {activeTab === 'completed' && (filtered.length === 0 ? renderEmptyState() : renderProjectTable(filtered))}
        </TabsContent>
        <TabsContent value="trash" className="mt-0">
          {activeTab === 'trash' && (filtered.length === 0 ? renderEmptyState() : renderProjectTable(filtered))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
