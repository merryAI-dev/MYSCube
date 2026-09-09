import React, { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  ArrowLeft, Plus, BookOpen, Calendar, Building2,
  User, DollarSign, BarChart3, Landmark, FileText,
  Wallet, Users, TrendingUp, Edit, FolderKanban,
  Play, Square, AlertTriangle, RotateCcw, Trash2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '../ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '../ui/alert-dialog';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';
import { useAppStore } from '../../data/store';
import {
  PROJECT_STATUS_LABELS, PROJECT_TYPE_LABELS, SETTLEMENT_TYPE_LABELS,
  SETTLEMENT_TYPE_SHORT, BASIS_LABELS, ACCOUNT_TYPE_LABELS,
  PROJECT_PHASE_LABELS,
  type ProjectStatus, type Basis, type SettlementType, type Ledger,
  formatSettlementSheetPolicySummary,
  normalizeSettlementSheetPolicy,
} from '../../data/types';
import { EmptyState } from '../ui/empty-state';
import { Progress } from '../ui/progress';
import { computeProjectCompleteness } from '../../data/project-completeness';
import { resolveApiErrorMessage } from '../../platform/api-error-message';
import { normalizeProjectRevenueFields } from '../../platform/project-financials';
import { describeProjectRequestVersion } from '../../platform/project-change-request';
import { usePendingProjectChangeRequests } from './usePendingProjectChangeRequests';
import { normalizeProjectDepartment } from '../../platform/project-cic';

const statusColor: Record<string, string> = {
  CONTRACT_PENDING: 'bg-amber-100 text-amber-800',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  COMPLETED: 'bg-green-100 text-green-800',
  COMPLETED_PENDING_PAYMENT: 'bg-teal-100 text-teal-800',
};

function toFiniteNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function fmt(n: number | null | undefined) {
  return toFiniteNumber(n).toLocaleString('ko-KR');
}

function fmtShort(n: number | null | undefined) {
  const amount = toFiniteNumber(n);
  if (Math.abs(amount) >= 1e8) return (amount / 1e8).toFixed(1) + '억';
  if (Math.abs(amount) >= 1e4) return (amount / 1e4).toFixed(0) + '만';
  return amount.toLocaleString();
}

function fmtPercent(n: number | null | undefined) {
  const ratio = toFiniteNumber(n);
  if (ratio === 0) return '-';
  return (ratio * 100).toFixed(2) + '%';
}

export function ProjectDetailPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const {
    getProjectById, getProjectLedgers, transactions, templates,
    addLedger, restoreProject, trashProject, updateProject,
  } = useAppStore();

  const project = getProjectById(projectId || '');
  const projectLedgers = getProjectLedgers(projectId || '');
  const pendingProjectIds = useMemo(() => project?.id ? [project.id] : [], [project?.id]);
  const pendingProjectChangeMap = usePendingProjectChangeRequests(pendingProjectIds);
  const pendingProjectChangeRequest = project ? pendingProjectChangeMap.get(project.id) || null : null;

  const revenueFinancials = project ? normalizeProjectRevenueFields(project, 'totalRevenueAmount') : null;
  const contractAmount = toFiniteNumber(project?.contractAmount);
  const budgetCurrentYear = toFiniteNumber(project?.budgetCurrentYear);
  const profitRate = toFiniteNumber(revenueFinancials?.profitRate);
  const profitAmount = toFiniteNumber(revenueFinancials?.profitAmount);
  const taxInvoiceAmount = toFiniteNumber(project?.taxInvoiceAmount);
  const isTrashed = !!project?.trashedAt;

  const [showLedgerDialog, setShowLedgerDialog] = useState(false);
  const [ledgerForm, setLedgerForm] = useState({
    name: '', templateId: '', basis: '' as Basis, settlementType: '' as SettlementType,
  });

  // Stats
  const stats = useMemo(() => {
    if (!project) return { totalIn: 0, totalOut: 0, txCount: 0, approvedCount: 0, pendingCount: 0, rejectedCount: 0 };
    const pTxs = transactions.filter(t => t.projectId === project.id);
    return {
      totalIn: pTxs.filter(t => t.direction === 'IN').reduce((s, t) => s + t.amounts.bankAmount, 0),
      totalOut: pTxs.filter(t => t.direction === 'OUT').reduce((s, t) => s + t.amounts.bankAmount, 0),
      txCount: pTxs.length,
      approvedCount: pTxs.filter(t => t.state === 'APPROVED').length,
      pendingCount: pTxs.filter(t => t.state === 'SUBMITTED').length,
      rejectedCount: pTxs.filter(t => t.state === 'REJECTED').length,
    };
  }, [project, transactions]);

  // Ledger stats
  const ledgerStats = useMemo(() => {
    const map: Record<string, { txCount: number; totalIn: number; totalOut: number }> = {};
    projectLedgers.forEach(l => {
      const lTxs = transactions.filter(t => t.ledgerId === l.id);
      map[l.id] = {
        txCount: lTxs.length,
        totalIn: lTxs.filter(t => t.direction === 'IN').reduce((s, t) => s + t.amounts.bankAmount, 0),
        totalOut: lTxs.filter(t => t.direction === 'OUT').reduce((s, t) => s + t.amounts.bankAmount, 0),
      };
    });
    return map;
  }, [projectLedgers, transactions]);

  const completeness = useMemo(() => computeProjectCompleteness(project || {}), [project]);
  const settlementSheetPolicy = useMemo(
    () => normalizeSettlementSheetPolicy(project?.settlementSheetPolicy, project?.fundInputMode),
    [project?.fundInputMode, project?.settlementSheetPolicy],
  );

  if (!project) {
    return (
      <EmptyState
        icon={FolderKanban}
        title="프로젝트를 찾을 수 없습니다"
        description="요청하신 프로젝트가 존재하지 않거나 삭제되었을 수 있습니다."
        action={{
          label: '프로젝트 목록으로',
          onClick: () => navigate('/projects'),
          icon: ArrowLeft,
        }}
      />
    );
  }

  const handleCreateLedger = async () => {
    const tpl = templates.find(t => t.id === ledgerForm.templateId);
    const newLedger: Ledger = {
      id: 'l' + String(Date.now()).slice(-6),
      projectId: project.id,
      templateId: ledgerForm.templateId,
      name: ledgerForm.name || tpl?.name || '새 원장',
      basis: ledgerForm.basis || project.basis,
      settlementType: ledgerForm.settlementType || project.settlementType,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await addLedger(newLedger);
      setShowLedgerDialog(false);
      setLedgerForm({ name: '', templateId: '', basis: '' as Basis, settlementType: '' as SettlementType });
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '원장 생성에 실패했습니다.'));
    }
  };

  const handleStatusChange = async (newStatus: ProjectStatus) => {
    try {
      await updateProject(project.id, { status: newStatus, updatedAt: new Date().toISOString() });
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '사업 상태 변경에 실패했습니다.'));
    }
  };

  const handleTrash = async () => {
    try {
      await trashProject(project.id, '어드민 휴지통 이동');
      toast.success(`휴지통으로 이동됨: ${project.name}`);
      navigate('/projects');
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '프로젝트 휴지통 이동에 실패했습니다.'));
    }
  };

  const handleRestore = async () => {
    try {
      await restoreProject(project.id);
      toast.success(`프로젝트 복구됨: ${project.name}`);
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '프로젝트 복구에 실패했습니다.'));
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="sm" className="mt-1 shrink-0" onClick={() => navigate('/projects')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5"
            style={{ background: 'linear-gradient(135deg, #0891b2, #0891b2)' }}
          >
            <FolderKanban className="w-4.5 h-4.5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-[20px]" style={{ fontWeight: 800, letterSpacing: '-0.03em' }}>
                {project.name}
              </h1>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${statusColor[project.status]}`}>
                {PROJECT_STATUS_LABELS[project.status]}
              </span>
              {isTrashed && (
                <Badge variant="destructive">휴지통</Badge>
              )}
              {project.phase === 'PROSPECT' && (
                <span className="inline-flex rounded-full px-2 py-0.5 text-xs bg-amber-100 text-amber-800">
                  입찰/예정
                </span>
              )}
              {pendingProjectChangeRequest && (
                <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
                  수정 중
                </Badge>
              )}
              <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] ${
                project.accountType === 'DEDICATED'
                  ? 'bg-blue-50 text-blue-700'
                  : project.accountType === 'OPERATING'
                    ? 'bg-slate-100 text-slate-700'
                    : 'bg-gray-100 text-gray-600'
              }`}>
                {ACCOUNT_TYPE_LABELS[project.accountType]}
              </span>
            </div>
            <p className="text-[12px] text-muted-foreground mt-0.5">{project.description}</p>
            {pendingProjectChangeRequest && (
              <p className="mt-1 text-[12px] font-medium text-amber-700">
                {describeProjectRequestVersion({
                  request: pendingProjectChangeRequest,
                  project,
                  fallbackActorName: project.registeredByName || project.managerName,
                  fallbackRequestedAt: pendingProjectChangeRequest.requestedAt,
                })} 승인 전까지 이 화면은 현재 확정된 원장 값을 보여줍니다.
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!isTrashed && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(`/projects/${project.id}/edit`)}>
              <Edit className="w-3.5 h-3.5" />
              수정
            </Button>
          )}
          {isTrashed ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" className="gap-1.5" data-testid="project-detail-restore">
                  <RotateCcw className="w-3.5 h-3.5" />
                  복구
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>프로젝트를 복구하시겠습니까?</AlertDialogTitle>
                  <AlertDialogDescription>
                    "{project.name}"을(를) 활성 프로젝트 목록으로 되돌립니다. 기존 원장과 거래 연결은 그대로 유지됩니다.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>취소</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void handleRestore()}>
                    복구
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" className="gap-1.5" data-testid="project-detail-trash">
                  <Trash2 className="w-3.5 h-3.5" />
                  휴지통 이동
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>프로젝트를 휴지통으로 이동하시겠습니까?</AlertDialogTitle>
                  <AlertDialogDescription>
                    "{project.name}"은(는) 즉시 숨겨지지만 완전 삭제되지 않습니다. 휴지통 탭에서 언제든 복구할 수 있습니다.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>취소</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void handleTrash()}>
                    휴지통 이동
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {!isTrashed && project.status === 'CONTRACT_PENDING' && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" className="gap-1.5" style={{ background: 'linear-gradient(135deg, #0891b2, #0891b2)' }}>
                  <Play className="w-3.5 h-3.5" />
                  사업 시작
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>사업을 시작하시겠습니까?</AlertDialogTitle>
                  <AlertDialogDescription>
                    "{project.name}" 사업의 상태를 "진행중"으로 변경합니다.
                    이후 거래 등록 및 증빙 관리가 활성화됩니다.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>취소</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void handleStatusChange('IN_PROGRESS')}>
                    사업 시작
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {!isTrashed && project.status === 'IN_PROGRESS' && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5 text-amber-700 border-amber-300 hover:bg-amber-50">
                  <Square className="w-3.5 h-3.5" />
                  사업 종료
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>사업을 종료하시겠습니까?</AlertDialogTitle>
                  <AlertDialogDescription>
                    "{project.name}" 사업의 상태를 "완료"로 변경합니다.
                    {stats.pendingCount > 0 && (
                      <span className="block mt-2 text-amber-600" style={{ fontWeight: 500 }}>
                        주의: 현재 승인 대기 중인 거래가 {stats.pendingCount}건 있습니다.
                      </span>
                    )}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>취소</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void handleStatusChange('COMPLETED')}>
                    사업 종료
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {isTrashed && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="pt-3 pb-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
              <div className="text-sm">
                <p style={{ fontWeight: 600 }}>휴지통 보관 중인 프로젝트입니다.</p>
                <p className="text-muted-foreground mt-1">
                  삭제일: {project.trashedAt?.slice(0, 10) || '-'}
                  {project.trashedByEmail ? ` · 삭제자: ${project.trashedByEmail}` : ''}
                  {project.trashedReason ? ` · 사유: ${project.trashedReason}` : ''}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Project Info Grid */}
      <Card>
        <CardContent className="pt-3 pb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground mb-1">입력 완성도</p>
              <p className="text-sm" style={{ fontWeight: 700 }}>
                {completeness.percent}% ({completeness.filled}/{completeness.total})
              </p>
            </div>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(`/projects/${project.id}/edit`)} disabled={isTrashed}>
              <Edit className="w-3.5 h-3.5" />
              정보 보완
            </Button>
          </div>
          <div className="mt-2">
            <Progress value={completeness.percent} className="h-2" />
          </div>
          {completeness.missing.length > 0 && (
            <p className="text-[11px] text-muted-foreground mt-2">
              다음 항목을 채우면 좋아요: {completeness.missing.slice(0, 4).map((m) => m.label).join(', ')}
              {completeness.missing.length > 4 ? ` 외 ${completeness.missing.length - 4}개` : ''}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-3 pb-3">
            <p className="text-xs text-muted-foreground mb-1">계약 대상</p>
            <p className="text-sm" style={{ fontWeight: 500 }}>{project.clientOrg || '-'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-3">
            <p className="text-xs text-muted-foreground mb-1">프로젝트 유형</p>
            <p className="text-sm" style={{ fontWeight: 500 }}>{PROJECT_TYPE_LABELS[project.type]}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-3">
            <p className="text-xs text-muted-foreground mb-1">정산유형</p>
            <p className="text-sm" style={{ fontWeight: 500 }}>
              {SETTLEMENT_TYPE_SHORT[project.settlementType]} / {BASIS_LABELS[project.basis]}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-3">
            <p className="text-xs text-muted-foreground mb-1">담당조직(CIC) / 팀</p>
                  <p className="text-sm" style={{ fontWeight: 500 }}>{normalizeProjectDepartment(project.department) || '-'}</p>
            <p className="text-xs text-muted-foreground">{project.teamName || '-'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-3">
            <p className="text-xs text-muted-foreground mb-1">정산 시트 정책</p>
            <p className="text-sm" style={{ fontWeight: 500 }}>
              {formatSettlementSheetPolicySummary(settlementSheetPolicy)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Financial KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Landmark className="w-3.5 h-3.5" /> 계약금액
            </div>
            <p className="text-xl" style={{ fontWeight: 600 }}>{fmtShort(contractAmount)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <DollarSign className="w-3.5 h-3.5" /> 2026년 예산
            </div>
            <p className="text-xl" style={{ fontWeight: 600 }}>{fmtShort(budgetCurrentYear)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <TrendingUp className="w-3.5 h-3.5 text-emerald-600" /> 수익률 / 수익금액
            </div>
            <p className="text-xl" style={{ fontWeight: 600 }}>
              <span className={profitRate >= 0.1 ? 'text-emerald-700' : 'text-amber-700'}>
                {fmtPercent(profitRate)}
              </span>
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {profitAmount > 0 ? fmt(profitAmount) + '원' : '-'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <BarChart3 className="w-3.5 h-3.5 text-green-600" /> 입금 누계
            </div>
            <p className="text-xl text-green-700" style={{ fontWeight: 600 }}>{fmtShort(stats.totalIn)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              사업비대비 {contractAmount > 0 ? ((stats.totalIn / contractAmount) * 100).toFixed(1) : 0}%
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <BarChart3 className="w-3.5 h-3.5 text-red-600" /> 출금 누계
            </div>
            <p className="text-xl text-red-600" style={{ fontWeight: 600 }}>{fmtShort(stats.totalOut)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              거래 {stats.txCount}건 (승인 {stats.approvedCount} / 대기 {stats.pendingCount} / 반려 {stats.rejectedCount})
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Ledgers */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="flex items-center gap-2">
            <BookOpen className="w-5 h-5" /> 원장 목록
          </h2>
          {!isTrashed && (
            <Button onClick={() => setShowLedgerDialog(true)} className="gap-1.5">
              <Plus className="w-4 h-4" /> 원장 생성
            </Button>
          )}
        </div>

        {projectLedgers.length === 0 ? (
          <Card>
            <EmptyState
              icon={BookOpen}
              title="아직 원장이 없습니다"
              description="템플릿에서 원장을 생성하여 거래 내역을 관리하세요."
              action={{
                label: isTrashed ? '휴지통 보관 중' : '원장 생성',
                onClick: () => { if (!isTrashed) setShowLedgerDialog(true); },
                icon: isTrashed ? AlertTriangle : Plus,
              }}
              variant="compact"
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projectLedgers.map(l => {
              const ls = ledgerStats[l.id] || { txCount: 0, totalIn: 0, totalOut: 0 };
              return (
                <Card
                  key={l.id}
                  className="cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => navigate(`/projects/${project.id}/ledgers/${l.id}`)}
                >
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center justify-between mb-2">
                      <h3>{l.name}</h3>
                      <Badge variant="secondary" className="text-xs">{ls.txCount}건</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground space-y-1">
                      <p>기준: {BASIS_LABELS[l.basis]}</p>
                      <p>정산: {SETTLEMENT_TYPE_SHORT[l.settlementType]}</p>
                    </div>
                    <div className="flex items-center justify-between mt-3 pt-3 border-t text-sm">
                      <span className="text-green-700">+{fmtShort(ls.totalIn)}</span>
                      <span className="text-red-600">-{fmtShort(ls.totalOut)}</span>
                      <span style={{ fontWeight: 500 }}>
                        NET {fmtShort(ls.totalIn - ls.totalOut)}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">보조 정보</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Accordion type="multiple" className="w-full">
            <AccordionItem value="project-detail-contract">
              <AccordionTrigger className="text-[13px]">계약 및 담당 정보</AccordionTrigger>
              <AccordionContent>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">계약기간</span>
                      <span>{project.contractStart || '-'} ~ {project.contractEnd || '-'}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">입금 계획</span>
                      <span className="text-right">{project.paymentPlanDesc || '-'}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">잔금 입금</span>
                      <span className="text-right">{project.finalPaymentNote || '-'}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">정산 여부</span>
                      <span className={project.isSettled ? 'text-green-600' : 'text-muted-foreground'}>
                        {project.isSettled ? 'O (완료)' : 'X (미정산)'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">세금계산서 금액</span>
                      <span>{taxInvoiceAmount > 0 ? fmt(taxInvoiceAmount) + '원' : '-'}</span>
                    </div>
                  </div>

                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">담당조직(CIC)</span>
                      <span>{normalizeProjectDepartment(project.department) || '-'}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">팀(팀장)</span>
                      <span>{project.teamName || '-'} </span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">PM</span>
                      <span>{project.managerName || '-'}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">그룹웨어 등록명</span>
                      <span>{project.groupwareName || '-'}</span>
                    </div>
                    {project.evidenceDriveRootFolderLink ? (
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">사업관리 폴더</span>
                        <a
                          href={project.evidenceDriveRootFolderLink}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-blue-700 underline underline-offset-2"
                        >
                          폴더 열기
                        </a>
                      </div>
                    ) : null}
                    {project.participantCondition && (
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">참여기업 조건</span>
                        <span className="max-w-[240px] text-right">{project.participantCondition}</span>
                      </div>
                    )}
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="project-detail-participation">
              <AccordionTrigger className="text-[13px]">참여 인력 현황</AccordionTrigger>
              <AccordionContent>
                <div className="flex items-center justify-between gap-4 rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
                  <span>참여율 합산과 초과 경고는 서버 기준 참여인력 대시보드에서 확인합니다.</span>
                  <Button variant="outline" size="sm" onClick={() => navigate('/participation')}>참여인력 대시보드</Button>
                </div>
              </AccordionContent>
            </AccordionItem>

            {(project.paymentPlan.contract > 0 || project.paymentPlan.interim > 0 || project.paymentPlan.final > 0) && (
              <AccordionItem value="project-detail-payment-plan">
                <AccordionTrigger className="text-[13px]">입금 계획</AccordionTrigger>
                <AccordionContent>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    {[
                      { label: '선금/계약금', amount: project.paymentPlan.contract },
                      { label: '중도금', amount: project.paymentPlan.interim },
                      { label: '잔금', amount: project.paymentPlan.final },
                    ].filter((item) => item.amount > 0).map((item) => (
                      <div key={item.label} className="rounded-lg bg-muted/50 p-3 text-center">
                        <p className="text-xs text-muted-foreground">{item.label}</p>
                        <p className="text-lg" style={{ fontWeight: 600 }}>{fmtShort(item.amount)}</p>
                        <p className="text-xs text-muted-foreground">
                          {contractAmount > 0 ? ((item.amount / contractAmount) * 100).toFixed(0) : 0}%
                        </p>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            )}
          </Accordion>
        </CardContent>
      </Card>

      {/* Create Ledger Dialog */}
      <Dialog open={showLedgerDialog} onOpenChange={setShowLedgerDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>원장 생성</DialogTitle>
            <DialogDescription>템플릿에서 원장을 생성합니다. 프로젝트별로 여러 원장을 사용할 수 있습니다.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>템플릿 *</Label>
              <Select
                value={ledgerForm.templateId}
                onValueChange={v => {
                  const tpl = templates.find(t => t.id === v);
                  setLedgerForm(f => ({
                    ...f,
                    templateId: v,
                    name: tpl?.name || '',
                    basis: (tpl?.defaultBasis || project.basis) as Basis,
                    settlementType: project.settlementType,
                  }));
                }}
              >
                <SelectTrigger><SelectValue placeholder="템플릿 선택" /></SelectTrigger>
                <SelectContent>
                  {templates.map(t => (
                    <SelectItem key={t.id} value={t.id}>{t.name} (v{t.version})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>원장 이름</Label>
              <Input
                value={ledgerForm.name}
                onChange={e => setLedgerForm(f => ({ ...f, name: e.target.value }))}
                placeholder="원장 이름"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>기준 (Basis)</Label>
                <Select value={ledgerForm.basis} onValueChange={v => setLedgerForm(f => ({ ...f, basis: v as Basis }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(BASIS_LABELS) as Basis[]).map(k => (
                      <SelectItem key={k} value={k}>{BASIS_LABELS[k]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>정산유형</Label>
                <Select value={ledgerForm.settlementType} onValueChange={v => setLedgerForm(f => ({ ...f, settlementType: v as SettlementType }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(SETTLEMENT_TYPE_LABELS) as SettlementType[]).map(k => (
                      <SelectItem key={k} value={k}>{SETTLEMENT_TYPE_LABELS[k]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLedgerDialog(false)}>취소</Button>
            <Button onClick={() => void handleCreateLedger()} disabled={!ledgerForm.templateId}>생성</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
