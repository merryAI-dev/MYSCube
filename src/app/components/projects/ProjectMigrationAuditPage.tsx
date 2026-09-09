import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../data/auth-store';
import { usePortalStore } from '../../data/portal-store';
import { useAppStore } from '../../data/store';
import type { Project, ProjectExecutiveReviewStatus, ProjectRequest } from '../../data/types';
import { useFirebase } from '../../lib/firebase-context';
import {
  fetchAssignedProjectRequestsViaBff,
  fetchProjectReviewInboxViaBff,
  isPlatformApiEnabled,
  reviewProjectExecutiveStatusViaBff,
  reviewProjectManagementPlanningStatusViaBff,
  reviewProjectClosureViaBff,
} from '../../lib/platform-bff-client';
import { downloadProjectAttachmentViaBff, downloadProjectRequestAttachmentViaBff } from '../../lib/project-request-attachment-client';
import type { ProjectRequestDocumentKind } from '../../platform/project-contract-upload';
import { PROJECT_DOCUMENTS } from '../../platform/project-documents';
import {
  type MigrationAuditConsoleRecord,
  type MigrationAuditConsoleStatus,
  buildMigrationAuditConsoleRecords,
  collectMigrationAuditCicOptions,
  deriveMigrationAuditStatus,
  filterMigrationAuditConsoleRecords,
  resolveMigrationReviewApproverId,
  summarizeMigrationAuditConsole,
} from '../../platform/project-migration-console';
import { getManagementPlanningReview } from '../../platform/project-management-planning-review';
import { resolveProjectRequestKind, resolveProjectRequestPayload } from '../../platform/project-change-request';
import { PageHeader } from '../layout/PageHeader';
import { usePrivateDraftDocumentPreviews } from '../portal/usePrivateDraftDocumentPreviews';
import { Card, CardContent } from '../ui/card';
import { MigrationAuditControlBar } from './migration-audit/MigrationAuditControlBar';
import { MigrationAuditRecordList } from './migration-audit/MigrationAuditRecordList';
import { MigrationAuditDocumentDialog } from './migration-audit/MigrationAuditDocumentDialog';
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
import { Textarea } from '../ui/textarea';
import { Input } from '../ui/input';
import { Button } from '../ui/button';

type ReviewActionMode = 'approve' | 'reject' | 'discard';
export type ProjectRegistrationReviewStage = 'executive' | 'managementPlanning';

type ReviewDocumentSource = {
  source: 'project' | 'request';
  projectId: string;
  requestId: string;
};

function getReviewDialogTitle(mode: ReviewActionMode, reviewStage: ProjectRegistrationReviewStage): string {
  if (reviewStage === 'managementPlanning') return mode === 'approve' ? '프로젝트 코드 부여에 합의할까요?' : '프로젝트 코드를 반려할까요?';
  if (mode === 'approve') return '이 프로젝트를 승인할까요?';
  if (mode === 'reject') return '수정 요청 후 반려할까요?';
  return '이 프로젝트를 중복·폐기할까요?';
}

function getReviewDialogDescription(mode: ReviewActionMode, reviewStage: ProjectRegistrationReviewStage): string {
  if (reviewStage === 'managementPlanning') {
    return mode === 'approve'
      ? '조직장 승인이 끝난 프로젝트에 코드를 부여하고 경영기획실 합의로 기록합니다.'
      : '반려 사유를 남기면 PM에게 다시 전달되어 보완 후 재제출할 수 있습니다.';
  }
  if (mode === 'approve') return 'PM이 올린 원문을 기준으로 이 프로젝트를 등록 대상으로 확정합니다.';
  if (mode === 'reject') return '수정이 필요한 이유를 반드시 남기고 PM이 다시 보완하도록 돌려보냅니다.';
  return '중복 또는 폐기 대상으로 정리하고, 판단 근거를 반드시 남깁니다.';
}

function getProjectRequestReviewDescription(mode: ReviewActionMode, request: ProjectRequest | null | undefined, reviewStage: ProjectRegistrationReviewStage): string {
  if (request?.requestKind === 'CLOSURE') return mode === 'approve'
    ? '조직장 승인·합의 즉시 주정산·월결산 업무 대상에서 제외됩니다. 계약 기간과 미결 정산 여부는 제외 조건이 아니며 과거 자료는 유지됩니다.'
    : '종료 요청만 보완하도록 돌려보냅니다. 프로젝트와 기존 정산 이력은 유지됩니다.';
  if (reviewStage === 'managementPlanning' || resolveProjectRequestKind(request) !== 'CHANGE') return getReviewDialogDescription(mode, reviewStage);
  if (mode === 'approve') return 'PM이 제출한 수정 값을 프로젝트 원장에 반영하고 변경 요청을 승인 완료로 닫습니다.';
  if (mode === 'reject') return '프로젝트 원장은 유지하고, 수정이 필요한 이유를 남겨 PM에게 돌려보냅니다.';
  return '프로젝트 원장은 유지하고, 중복 또는 폐기된 수정 요청으로 정리합니다.';
}

function toExecutiveStatus(mode: ReviewActionMode): ProjectExecutiveReviewStatus {
  if (mode === 'approve') return 'APPROVED';
  if (mode === 'reject') return 'REVISION_REJECTED';
  return 'DUPLICATE_DISCARDED';
}

function buildExecutiveRecords(records: MigrationAuditConsoleRecord[]): MigrationAuditConsoleRecord[] {
  // Legacy planning agreements were made before the management-planning state split.
  // They remain eligible for the designated organization head's decision, but are shown as pending.
  return records.map((record) => record.status === 'PLANNING_AGREED' ? { ...record, status: 'PENDING' } : record);
}

function toManagementPlanningConsoleStatus(project: Project): MigrationAuditConsoleStatus {
  const status = getManagementPlanningReview(project).status;
  if (status === 'AGREED') return 'APPROVED';
  if (status === 'REVISION_REJECTED') return 'REVISION_REJECTED';
  return 'PENDING';
}

function buildManagementPlanningRecords(records: MigrationAuditConsoleRecord[]): MigrationAuditConsoleRecord[] {
  return records
    .filter((record) => record.request?.requestKind !== 'CLOSURE')
    .filter((record) => deriveMigrationAuditStatus(record.project, record.request) === 'APPROVED')
    .map((record) => ({ ...record, status: toManagementPlanningConsoleStatus(record.project) }));
}

type ProjectMigrationAuditPageProps = {
  embedded?: boolean;
  reviewScope?: 'all' | 'pending';
  reviewStage?: ProjectRegistrationReviewStage;
  assigneeOnly?: boolean;
};

type ProjectMigrationAuditPageContentProps = ProjectMigrationAuditPageProps & {
  projects: Project[];
  currentUser?: { name?: string; email?: string } | null;
};

function ProjectMigrationAuditPageContent({
  embedded = false,
  reviewScope = 'all',
  reviewStage = 'executive',
  assigneeOnly = false,
  projects,
  currentUser,
}: ProjectMigrationAuditPageContentProps) {
  const { user: authUser } = useAuth();
  const { orgId } = useFirebase();
  const [requests, setRequests] = useState<ProjectRequest[]>([]);
  const [assignedProjects, setAssignedProjects] = useState<Project[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [requestLoadError, setRequestLoadError] = useState('');
  const [loadedRequestKey, setLoadedRequestKey] = useState('');
  const [cicFilter, setCicFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | MigrationAuditConsoleStatus>('PENDING');
  const [kindFilter, setKindFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [inboxScope, setInboxScope] = useState<'MINE' | 'ALL'>('MINE');
  const [openRecordId, setOpenRecordId] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<ReviewActionMode | null>(null);
  const [reviewComment, setReviewComment] = useState('');
  const [projectCode, setProjectCode] = useState('');
  const [acting, setActing] = useState(false);
  const [requestReloadVersion, setRequestReloadVersion] = useState(0);
  const isManagementPlanning = reviewStage === 'managementPlanning';
  const reviewProjectIds = useMemo(() => projects.map((project) => project.id).filter(Boolean), [projects]);
  const requestKey = JSON.stringify([orgId, authUser?.uid, authUser?.email, authUser?.role, authUser?.idToken, assigneeOnly, reviewProjectIds, requestReloadVersion]);
  const requestAuthorityReady = loadedRequestKey === requestKey && !loadingRequests && !requestLoadError;

  useEffect(() => {
    setActionMode(null);
    if (!isPlatformApiEnabled() || !authUser?.uid) {
      setRequests([]);
      setAssignedProjects([]);
      setLoadingRequests(false);
      setRequestLoadError('프로젝트 결재 서버 연결을 확인하지 못했습니다. 다시 로그인한 뒤 확인해 주세요.');
      return undefined;
    }
    let disposed = false;
    setLoadingRequests(true);
    setRequestLoadError('');
    void (async () => {
      try {
        const actor = {
          uid: authUser.uid,
          email: authUser.email,
          role: authUser.role,
          idToken: authUser.idToken,
        };
        if (assigneeOnly) {
          const assignedInbox = await fetchAssignedProjectRequestsViaBff({ tenantId: orgId, actor });
          if (!disposed) {
            setRequests(assignedInbox.requests);
            setAssignedProjects(assignedInbox.projects);
            setLoadedRequestKey(requestKey);
          }
        } else {
          const nextRequests = await fetchProjectReviewInboxViaBff({
            tenantId: orgId,
            actor,
            projectIds: reviewProjectIds,
          });
          if (!disposed) {
            setRequests(nextRequests);
            setAssignedProjects([]);
            setLoadedRequestKey(requestKey);
          }
        }
      } catch (error) {
        console.error('[ProjectMigrationAuditPage] project request fetch error:', error);
        if (!disposed) {
          setRequests([]);
          setAssignedProjects([]);
          setRequestLoadError('PM 등록 프로젝트와 접수 이력을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
        }
      } finally {
        if (!disposed) setLoadingRequests(false);
      }
    })();
    return () => { disposed = true; };
  }, [assigneeOnly, authUser?.email, authUser?.idToken, authUser?.role, authUser?.uid, orgId, requestReloadVersion, reviewProjectIds, requestKey]);

  const recordProjects = useMemo(() => {
    if (assignedProjects.length === 0) return projects;
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    assignedProjects.forEach((project) => projectsById.set(project.id, project));
    return Array.from(projectsById.values());
  }, [assignedProjects, projects]);
  const records = useMemo(() => requestAuthorityReady ? buildMigrationAuditConsoleRecords(recordProjects, requests) : [], [recordProjects, requests, requestAuthorityReady]);
  const stageRecords = useMemo(() => {
    if (isManagementPlanning) return buildManagementPlanningRecords(records);
    return buildExecutiveRecords(records);
  }, [isManagementPlanning, records]);
  const scopedRecords = useMemo(() => reviewScope === 'pending'
    ? stageRecords.filter((record) => record.status === 'PENDING')
    : stageRecords, [reviewScope, stageRecords]);
  const reviewerDepartment = String(authUser?.department || '').trim();
  const effectiveInboxScope = assigneeOnly ? 'MINE' : inboxScope;
  const inboxRecords = useMemo(() => {
    if (isManagementPlanning || effectiveInboxScope === 'ALL') return scopedRecords;
    return scopedRecords.filter((record) => {
      const approverId = resolveMigrationReviewApproverId(record.project, record.request);
      return Boolean(authUser?.uid && approverId === authUser.uid);
    });
  }, [authUser?.uid, effectiveInboxScope, isManagementPlanning, scopedRecords]);
  const summaryRecords = useMemo(() => filterMigrationAuditConsoleRecords(inboxRecords.filter((record) => kindFilter === 'ALL' || resolveProjectRequestKind(record.request) === kindFilter), { cic: cicFilter, status: 'ALL', searchQuery }), [cicFilter, inboxRecords, searchQuery, kindFilter]);
  const filteredRecords = useMemo(() => filterMigrationAuditConsoleRecords(summaryRecords, { cic: cicFilter, status: statusFilter, searchQuery }), [cicFilter, searchQuery, statusFilter, summaryRecords]);
  const summary = useMemo(() => summarizeMigrationAuditConsole(summaryRecords), [summaryRecords]);
  const cicOptions = useMemo(() => collectMigrationAuditCicOptions(inboxRecords), [inboxRecords]);
  const openRecord = useMemo(() => summaryRecords.find((record) => record.id === openRecordId) || null, [openRecordId, summaryRecords]);
  const existingProjectCode = String(openRecord?.project.projectCode || '').trim();
  const reviewDocumentAccess = useMemo(() => {
    const sources = new Map<ProjectRequestDocumentKind, ReviewDocumentSource>();
    const attachments: Array<{ documentKind: ProjectRequestDocumentKind; path: string }> = [];
    if (!openRecord) return { attachments, sources };

    const reviewPayload = openRecord.request
      ? resolveProjectRequestPayload(openRecord.request)
      : openRecord.project;
    const requestId = String(openRecord.request?.id || '').trim();
    const projectId = String(openRecord.project.id || '').trim();
    const source: ReviewDocumentSource['source'] = openRecord.request ? 'request' : 'project';
    PROJECT_DOCUMENTS.forEach(({ documentKind, field }) => {
      const document = reviewPayload?.[field];
      const path = String(document?.path || '').trim();
      const downloadURL = String(document?.downloadURL || '').trim();
      if (!path || downloadURL) return;

      if ((source === 'request' && !requestId) || (source === 'project' && !projectId)) return;
      attachments.push({ documentKind, path });
      sources.set(documentKind, { source, projectId, requestId });
    });
    return { attachments, sources };
  }, [openRecord]);
  const loadReviewDocumentPreview = useCallback(async ({
    documentKind,
    signal,
  }: {
    documentKind: ProjectRequestDocumentKind;
    signal: AbortSignal;
  }) => {
    const source = reviewDocumentAccess.sources.get(documentKind);
    if (!source || !authUser?.uid) throw new Error('첨부 파일을 불러올 권한 정보를 확인하지 못했습니다.');
    const actor = { uid: authUser.uid, email: authUser.email, role: authUser.role, idToken: authUser.idToken };
    if (source.source === 'request') {
      return downloadProjectRequestAttachmentViaBff({
        tenantId: orgId,
        actor,
        requestId: source.requestId,
        documentKind,
        signal,
      });
    }
    return downloadProjectAttachmentViaBff({
      tenantId: orgId,
      actor,
      projectId: source.projectId,
      documentKind,
      signal,
    });
  }, [authUser?.email, authUser?.idToken, authUser?.role, authUser?.uid, orgId, reviewDocumentAccess]);
  const {
    documentPreviewUrls,
    documentPreviewStates,
    loadDocumentPreview,
  } = usePrivateDraftDocumentPreviews({
    attachments: reviewDocumentAccess.attachments,
    enabled: Boolean(openRecord && isPlatformApiEnabled() && authUser?.uid),
    loadAttachment: loadReviewDocumentPreview,
  });
  const designatedApproverId = openRecord ? resolveMigrationReviewApproverId(openRecord.project, openRecord.request) : undefined;
  const canExecutiveFinalize = Boolean(authUser?.uid && designatedApproverId === authUser.uid);
  const role = String(authUser?.role || '').trim().toLowerCase();
  const canManagementPlanningFinalize = role === 'admin' || role === 'finance';
  const canFinalize = requestAuthorityReady && (isManagementPlanning ? canManagementPlanningFinalize : canExecutiveFinalize);
  const attachmentRepairRequired = openRecord?.request?.attachmentReviewStatus === 'REPAIR_REQUIRED';

  async function handleConfirmAction() {
    if (!openRecord || !actionMode) return;
    if (actionMode === 'approve' && attachmentRepairRequired) return;
    if (!canFinalize) {
      toast.error(isManagementPlanning ? '경영기획실 담당자만 처리할 수 있습니다.' : '지정된 조직장만 처리할 수 있습니다.');
      return;
    }
    const trimmedComment = reviewComment.trim();
    const trimmedProjectCode = projectCode.trim();
    const reviewerName = currentUser?.name || authUser?.name || currentUser?.email || authUser?.email || '관리자';
    if (!isPlatformApiEnabled() || !authUser?.uid) {
      toast.error('프로젝트 처리 서버가 연결되어 있지 않아 저장하지 않았습니다.');
      return;
    }

    if (openRecord.request?.requestKind === 'CLOSURE') {
      if (actionMode === 'discard' || (actionMode === 'reject' && !trimmedComment)) return;
      setActing(true);
      try {
        await reviewProjectClosureViaBff({ tenantId: orgId, actor: authUser, projectId: openRecord.project.id,
          requestId: openRecord.request.id, expectedRequestVersion: openRecord.request.requestVersion || 0,
          decision: actionMode === 'approve' ? 'APPROVED' : 'REJECTED', comment: trimmedComment });
        toast.success(actionMode === 'approve' ? '사업 종료를 승인했습니다. 주정산·월결산 대상에서 제외됩니다.' : '종료 요청을 보완하도록 돌려보냈습니다.');
        setActionMode(null);
        setRequestReloadVersion((value) => value + 1);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '종료 검토 처리에 실패했습니다.');
      } finally { setActing(false); }
      return;
    }

    if (isManagementPlanning) {
      if (actionMode === 'discard') return;
      if (actionMode === 'approve' && !trimmedProjectCode) {
        toast.error('프로젝트 코드를 입력해 주세요.');
        return;
      }
      if (actionMode === 'reject' && !trimmedComment) {
        toast.error('반려 사유를 입력해 주세요.');
        return;
      }
      setActing(true);
      try {
        await reviewProjectManagementPlanningStatusViaBff({
          tenantId: orgId,
          actor: { uid: authUser.uid, email: authUser.email, role: authUser.role, idToken: authUser.idToken },
          projectId: openRecord.project.id,
          review: {
            requestId: openRecord.request?.id,
            reviewStatus: actionMode === 'approve' ? 'AGREED' : 'REVISION_REJECTED',
            projectCode: actionMode === 'approve' ? trimmedProjectCode : undefined,
            reviewComment: trimmedComment || undefined,
            reviewerName,
          },
        });
        toast.success(actionMode === 'approve' ? '프로젝트 코드를 부여하고 합의했습니다.' : '반려 사유를 PM에게 전달했습니다.', { description: openRecord.title });
        setRequestReloadVersion((version) => version + 1);
        setActionMode(null);
        setReviewComment('');
        setProjectCode('');
      } catch (error) {
        toast.error('경영기획실 합의 저장 실패', { description: error instanceof Error ? error.message : '다시 시도해 주세요.' });
      } finally {
        setActing(false);
      }
      return;
    }

    const nextExecutiveStatus = toExecutiveStatus(actionMode);
    if (nextExecutiveStatus !== 'APPROVED' && !trimmedComment) {
      toast.error(actionMode === 'reject' ? '반려 사유를 입력해 주세요.' : '폐기 사유를 입력해 주세요.');
      return;
    }
    setActing(true);
    try {
      await reviewProjectExecutiveStatusViaBff({
        tenantId: orgId,
        actor: { uid: authUser.uid, email: authUser.email, role: authUser.role, idToken: authUser.idToken },
        projectId: openRecord.project.id,
        review: { requestId: openRecord.request?.id, reviewStatus: nextExecutiveStatus, reviewComment: trimmedComment || undefined, reviewerName },
      });
      toast.success(actionMode === 'approve' ? '프로젝트를 승인했습니다.' : actionMode === 'reject' ? '수정 요청 후 반려로 처리했습니다.' : '중복·폐기로 처리했습니다.', { description: openRecord.title });
      setRequestReloadVersion((version) => version + 1);
      setActionMode(null);
      setReviewComment('');
    } catch (error) {
      toast.error('조직장 결재 저장 실패', { description: error instanceof Error ? error.message : '다시 시도해 주세요.' });
    } finally {
      setActing(false);
    }
  }

  const pageTitle = isManagementPlanning ? '프로젝트 코드 부여' : 'PM 등록 프로젝트 검토';
  const pageDescription = isManagementPlanning
    ? '조직장 승인이 끝난 프로젝트를 확인하고, 경영기획실 합의와 함께 프로젝트 코드를 부여합니다.'
    : '내게 배정된 프로젝트 등록 요청을 먼저 확인하고, 문서형 팝업에서 기안·조직장 결재선과 등록 내용을 검토합니다.';

  return (
    <div className="space-y-6">
      {!embedded ? <PageHeader icon={ClipboardCheck} iconGradient={isManagementPlanning ? 'linear-gradient(135deg, #0f2f57 0%, #174a7c 100%)' : 'linear-gradient(135deg, #0f766e 0%, #0ea5e9 100%)'} title={pageTitle} description={pageDescription} badge={isManagementPlanning ? '경영기획실 합의' : '조직장 결재'} /> : null}
      {requestLoadError ? <Card><CardContent className="p-4 text-[12px] text-muted-foreground"><p>{requestLoadError}</p><Button className="mt-3" variant="outline" onClick={() => setRequestReloadVersion((value) => value + 1)}>접수 이력 다시 확인</Button></CardContent></Card> : null}
      <MigrationAuditControlBar cicOptions={cicOptions} cicFilter={cicFilter} onCicFilterChange={setCicFilter} inboxScope={effectiveInboxScope} onInboxScopeChange={setInboxScope} reviewerDepartment={reviewerDepartment} statusFilter={statusFilter} onStatusFilterChange={setStatusFilter} searchQuery={searchQuery} onSearchQueryChange={setSearchQuery} summary={summary} reviewStage={reviewStage} assigneeOnly={assigneeOnly} />
      {!isManagementPlanning ? <label className="flex items-center gap-2 text-sm">요청 유형<select aria-label="요청 유형" className="rounded border bg-background px-3 py-2" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}><option value="ALL">전체</option><option value="REGISTRATION">등록</option><option value="CHANGE">변경</option><option value="CLOSURE">사업 종료</option></select></label> : null}
      {loadingRequests ? <Card><CardContent className="flex items-center justify-center gap-2 py-16 text-[12px] text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />PM 등록 프로젝트와 접수 이력을 불러오는 중입니다…</CardContent></Card> : <MigrationAuditRecordList records={filteredRecords} onOpen={(record) => setOpenRecordId(record.id)} reviewStage={reviewStage} />}
      <MigrationAuditDocumentDialog open={!!openRecord} record={openRecord} acting={acting} canFinalize={canFinalize} documentPreviewUrls={documentPreviewUrls} documentPreviewStates={documentPreviewStates} reviewStage={reviewStage} onLoadDocumentPreview={loadDocumentPreview} onOpenChange={(open) => { if (!open) setOpenRecordId(null); }} onApprove={() => { setActionMode('approve'); setReviewComment(''); setProjectCode(String(openRecord?.project.projectCode || '').trim()); }} onReject={() => { setActionMode('reject'); setReviewComment(isManagementPlanning ? '' : (openRecord?.project.executiveReviewComment || '')); setProjectCode(''); }} />
      <AlertDialog open={!!actionMode && !!openRecord && requestAuthorityReady} onOpenChange={(open) => { if (!open) { setActionMode(null); setReviewComment(''); setProjectCode(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{getReviewDialogTitle(actionMode || 'approve', reviewStage)}</AlertDialogTitle><AlertDialogDescription>{getProjectRequestReviewDescription(actionMode || 'approve', openRecord?.request, reviewStage)}</AlertDialogDescription></AlertDialogHeader>
          <div className="space-y-2">
            {isManagementPlanning && actionMode === 'approve' ? <div className="space-y-2"><label htmlFor="management-planning-project-code" className="text-[12px] font-medium text-slate-700">프로젝트 코드</label><Input aria-required id="management-planning-project-code" value={projectCode} onChange={(event) => setProjectCode(event.target.value)} readOnly={Boolean(existingProjectCode)} placeholder="예: MYSC-2026-001" className="rounded-none border-slate-400" autoComplete="off" /><p className="text-[11px] leading-5 text-slate-500">{existingProjectCode ? '이미 부여된 프로젝트 코드는 변경할 수 없습니다.' : '합의 저장과 함께 프로젝트 원장에 저장되며, 이후 운영 화면의 기준 코드로 사용됩니다.'}</p></div> : null}
            <p className="text-[12px] font-medium text-slate-700">{actionMode === 'approve' ? (isManagementPlanning ? '합의 메모' : '승인 메모') : actionMode === 'reject' ? '반려 사유' : '폐기 사유'}</p>
            <Textarea aria-required={actionMode !== 'approve'} value={reviewComment} onChange={(event) => setReviewComment(event.target.value)} maxLength={2000} placeholder={actionMode === 'approve' ? (isManagementPlanning ? '합의 판단 근거를 남길 수 있습니다.' : '승인 판단 근거를 남길 수 있습니다.') : 'PM이 보완 내용을 이해할 수 있도록 반려 사유를 남겨 주세요.'} className="min-h-[120px]" />
            <p className="text-right text-[10px] text-slate-500">{reviewComment.length.toLocaleString()}/2,000자</p>
          </div>
          <AlertDialogFooter><AlertDialogCancel disabled={acting}>취소</AlertDialogCancel><AlertDialogAction onClick={(event) => { event.preventDefault(); void handleConfirmAction(); }} disabled={acting || (isManagementPlanning && actionMode === 'approve' && !projectCode.trim()) || (actionMode !== 'approve' && !reviewComment.trim())}>{acting ? '저장 중...' : actionMode === 'approve' ? (isManagementPlanning ? '합의 및 코드 저장' : '승인 저장') : actionMode === 'reject' ? '반려 저장' : '폐기 저장'}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function ProjectMigrationAuditPage(props: ProjectMigrationAuditPageProps = {}) {
  const { projects, currentUser } = useAppStore();
  return <ProjectMigrationAuditPageContent {...props} projects={projects} currentUser={currentUser} />;
}

export function ProjectAssigneeApprovalPage() {
  const { projects, portalUser } = usePortalStore();
  return <ProjectMigrationAuditPageContent assigneeOnly projects={projects} currentUser={portalUser} />;
}
