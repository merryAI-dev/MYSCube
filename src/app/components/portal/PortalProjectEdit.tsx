import { PROJECT_DOCUMENTS } from '../../platform/project-documents';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  LockKeyhole,
  MessageSquareText,
  Pencil,
  Save,
  SendHorizontal,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../data/auth-store';
import { useProjectDepartmentSettings } from '../../data/project-department-settings';
import { usePersonRoster } from '../../data/use-person-roster';
import { usePortalStore } from '../../data/portal-store';
import type { FileAttachment, Project, ProjectRequest } from '../../data/types';
import { getAuthInstance } from '../../lib/firebase';
import { useFirebase } from '../../lib/firebase-context';
import { extractTextFromPdf } from '../../lib/pdf-extract';
import { createEditLeaseClient } from '../../lib/edit-lease-client';
import { downloadProjectInfoDraftAttachmentViaBff } from '../../lib/project-request-attachment-client';
import {
  createProjectInfoDraftClient,
  type ProjectInfoAttachment,
  type ProjectInfoDocumentKind,
  type ProjectInfoDraft,
  type ProjectInfoFileLike,
  type ProjectInfoRebaseConflict,
  type ProjectInfoRebaseResolution,
} from '../../lib/project-info-draft-client';
import { ProjectInfoRebaseDialog } from './ProjectInfoRebaseDialog';
import { PlatformApiError } from '../../platform/api-client';

// The draft froze the project version it started from; the project has moved since.
function isCanonicalVersionConflict(error: unknown) {
  if (!(error instanceof PlatformApiError) || error.status !== 409) return false;
  const body = error.body as { error?: string } | null | undefined;
  return body?.error === 'canonical_version_conflict';
}
import {
  analyzeProjectRequestContractViaBff,
  fetchLatestProjectRequestViaBff,
  isPlatformApiEnabled,
  type ActorLike,
} from '../../lib/platform-bff-client';
import { openEditSession, type EditSession } from '../../platform/edit-session';
import {
  buildProjectEditorDraftFromProject,
  buildProjectRequestPayloadFromDraft,
  createProjectEditorDraft,
  type ProjectEditorDraft,
} from '../../platform/project-editor';
import {
  resolveProjectRequestKind,
  resolveProjectRequestPayload,
} from '../../platform/project-change-request';
import {
  buildPortalProjectReviewFeedback,
  hasManagementPlanningReview,
} from '../../platform/portal-project-review-feedback';
import { getManagementPlanningReview } from '../../platform/project-management-planning-review';
import type { ProjectRequestDocumentKind } from '../../platform/project-contract-upload';
import { resolvePortalProjectResourcePath } from '../../platform/portal-project-selection';
import { EditLeaseDialogs } from '../editing/EditLeaseDialogs';
import { useEditLease } from '../editing/useEditLease';
import { ProjectEditorWizard } from '../projects/ProjectEditorWizard';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
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
import { usePrivateDraftDocumentPreviews } from './usePrivateDraftDocumentPreviews';

type DraftClient = ReturnType<typeof createProjectInfoDraftClient>;

const PROJECT_INFO_PREVIEW_FIELDS = PROJECT_DOCUMENTS;

function resolveExecutiveBanner(
  project: Project,
  changeRequestStatus: ProjectRequest['status'] | null,
  request: ProjectRequest | null,
) {
  const status = changeRequestStatus === 'REJECTED'
    ? 'REVISION_REJECTED'
    : changeRequestStatus || project.executiveReviewStatus || 'PENDING';
  const reason = changeRequestStatus === 'REJECTED'
    ? request?.reviewComment || request?.rejectedReason || ''
    : project.executiveReviewComment || '';
  if (status === 'APPROVED') return {
    tone: 'success', title: '승인 완료',
    description: '조직장 검토가 승인되었습니다. 경영기획실 합의가 완료될 때까지 조직장 승인 이력은 유지됩니다.',
  };
  if (status === 'REVISION_REJECTED') return {
    tone: 'danger', title: '수정 요청 후 반려',
    description: reason || '수정이 필요한 상태입니다. 내용을 보완한 뒤 다시 제출해 주세요.',
  };
  if (status === 'DUPLICATE_DISCARDED') return {
    tone: 'neutral', title: '중복·폐기',
    description: reason || '중복 또는 폐기 대상으로 정리된 상태입니다. 필요한 경우 내용을 보완해 다시 제출할 수 있습니다.',
  };
  return {
    tone: 'warning', title: '검토 대기',
    description: '조직장 결재 대기 상태입니다. 수정 저장 시 같은 승인 대기열에서 최신 값으로 확인됩니다.',
  };
}

function bannerClassName(tone: string) {
  if (tone === 'danger') return 'border-slate-200 bg-white text-red-700';
  if (tone === 'neutral') return 'border-slate-200 bg-slate-50 text-slate-900';
  if (tone === 'warning') return 'border-slate-200 bg-white text-red-700';
  return 'border-slate-200 bg-white text-slate-900';
}

function resolveManagementPlanningBanner(
  status: ReturnType<typeof getManagementPlanningReview>['status'],
  comment: string,
) {
  if (status === 'AGREED') return {
    tone: 'success', title: '경영기획실 합의 완료', description: comment || '경영기획실 합의가 완료되었습니다.',
  };
  if (status === 'REVISION_REJECTED') return {
    tone: 'danger', title: '경영기획실 반려', description: comment || '보완 요청을 확인한 뒤 수정 후 다시 제출해 주세요.',
  };
  return {
    tone: 'warning', title: '경영기획실 합의 대기', description: comment || '조직장 승인 후 경영기획실 합의를 기다리고 있습니다.',
  };
}

function managementPlanningBannerClassName(tone: string) {
  if (tone === 'danger') return 'border-rose-200 bg-rose-50 text-rose-900';
  if (tone === 'success') return 'border-emerald-200 bg-emerald-50 text-emerald-900';
  return 'border-amber-200 bg-amber-50 text-amber-900';
}

function attachmentDocument(attachment: ProjectInfoAttachment): FileAttachment {
  return {
    path: attachment.path,
    name: attachment.name,
    downloadURL: '',
    size: attachment.size,
    contentType: attachment.contentType,
    uploadedAt: attachment.uploadedAt || '',
  };
}

function latestPrivateAlternativeDocumentKind(attachmentRefs: ProjectInfoAttachment[]) {
  let latest: 'proposal' | 'rfp_request_evidence' | null = null;
  for (const attachment of attachmentRefs) {
    if (attachment.documentKind === 'proposal' || attachment.documentKind === 'rfp_request_evidence') {
      latest = attachment.documentKind;
    }
  }
  return latest;
}

function editorDraftFromPrivate(record: ProjectInfoDraft): ProjectEditorDraft {
  const documents: Partial<Record<ProjectRequestDocumentKind, FileAttachment>> = {};
  for (const attachment of record.attachmentRefs) documents[attachment.documentKind] = attachmentDocument(attachment);
  const latestAlternativeKind = latestPrivateAlternativeDocumentKind(record.attachmentRefs);
  return createProjectEditorDraft({
    ...(record.payload as Partial<ProjectEditorDraft>),
    ...Object.fromEntries(PROJECT_DOCUMENTS.filter(({ documentKind }) => documents[documentKind]).map(({ documentKind, field }) => [field, documents[documentKind]])),
    ...(latestAlternativeKind === 'proposal' ? { rfpRequestEvidenceDocument: null } : {}),
    ...(latestAlternativeKind === 'rfp_request_evidence' ? { proposalDocument: null } : {}),
    registrationRequirementsVersion: 2,
  });
}

function previewAttachmentsFromPrivateDraft(record: ProjectInfoDraft | null) {
  if (!record) return [];
  const attachments = new Map<ProjectRequestDocumentKind, { documentKind: ProjectRequestDocumentKind; path: string }>();
  const payload = record.payload as Partial<ProjectEditorDraft>;
  for (const { documentKind, field } of PROJECT_INFO_PREVIEW_FIELDS) {
    const document = payload[field] as FileAttachment | null | undefined;
    const path = String(document?.path || '').trim();
    if (path) attachments.set(documentKind, { documentKind, path });
  }
  for (const attachment of record.attachmentRefs) {
    if (attachment.path) attachments.set(attachment.documentKind, {
      documentKind: attachment.documentKind,
      path: attachment.path,
    });
  }
  const latestAlternativeKind = latestPrivateAlternativeDocumentKind(record.attachmentRefs);
  if (latestAlternativeKind === 'rfp_request_evidence') attachments.delete('proposal');
  if (latestAlternativeKind === 'proposal') attachments.delete('rfp_request_evidence');
  return [...attachments.values()];
}

function ProjectInfoEditor({
  actor,
  canonicalDraft,
  departmentOptions,
  draftClient,
  members,
  roster,
  project,
  requestDoc,
  settlementSystemOptions,
  session,
}: {
  actor: ActorLike;
  canonicalDraft: ProjectEditorDraft;
  departmentOptions: string[];
  draftClient: DraftClient;
  members: ReturnType<typeof usePortalStore>['members'];
  roster: ReturnType<typeof usePersonRoster>;
  project: Project;
  requestDoc: ProjectRequest | null;
  settlementSystemOptions: string[];
  session: EditSession;
}) {
  const navigate = useNavigate();
  const { orgId } = useFirebase();
  const [record, setRecord] = useState<ProjectInfoDraft | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [saveSuccessDialogOpen, setSaveSuccessDialogOpen] = useState(false);
  const [rebaseState, setRebaseState] = useState<{
    conflicts: ProjectInfoRebaseConflict[];
    autoMerged: Array<{ field: string; value: unknown }>;
    pendingActionId: string;
  } | null>(null);
  const [rebaseBusy, setRebaseBusy] = useState(false);
  const rebasedVersionRef = useRef(0);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [resubmitComment, setResubmitComment] = useState('');
  const revisionRef = useRef(0);
  const recordLoadedRef = useRef(false);
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const writesPausedRef = useRef(false);
  const finishedRef = useRef(false);
  const mutationEpochRef = useRef(0);
  const latestRecordRef = useRef<ProjectInfoDraft | null>(null);
  const [draftConflictCount, setDraftConflictCount] = useState(0);
  const leaseClient = useMemo(() => createEditLeaseClient({
    tenantId: orgId,
    actor,
    sessionId: session.sessionId,
    resourceType: 'project-info',
    resourceId: project.id,
  }), [actor, orgId, project.id, session.sessionId]);
  const lease = useEditLease({ client: leaseClient });
  const changeRequestStatus = resolveProjectRequestKind(requestDoc) === 'CHANGE'
    ? requestDoc?.status || null
    : null;
  const canExecutiveResubmit = changeRequestStatus === 'REJECTED'
    || (!changeRequestStatus && (
      project.executiveReviewStatus === 'REVISION_REJECTED'
      || project.executiveReviewStatus === 'DUPLICATE_DISCARDED'
    ));
  const managementPlanningReview = useMemo(() => getManagementPlanningReview(project), [project]);
  const hasExplicitManagementPlanningReview = useMemo(() => hasManagementPlanningReview(project), [project]);
  const managementPlanningBanner = useMemo(
    () => hasExplicitManagementPlanningReview
      ? resolveManagementPlanningBanner(managementPlanningReview.status, managementPlanningReview.reviewComment)
      : null,
    [hasExplicitManagementPlanningReview, managementPlanningReview.reviewComment, managementPlanningReview.status],
  );
  const canManagementPlanningResubmit = managementPlanningReview.status === 'REVISION_REJECTED';
  const canResubmit = canExecutiveResubmit || canManagementPlanningResubmit;
  const executiveBanner = useMemo(
    () => resolveExecutiveBanner(project, changeRequestStatus, requestDoc),
    [changeRequestStatus, project, requestDoc],
  );
  // A submit clears the local draft record, so its status is never 'SUBMITTED' here.
  // Show the action whenever the project is awaiting a decision; the server rejects it
  // with request_not_withdrawable if there is nothing pending to pull back.
  const canWithdrawRequest = changeRequestStatus === 'PENDING'
    && lease.canEdit
    && !submitted;
  const reviewFeedback = useMemo(() => buildPortalProjectReviewFeedback(project, requestDoc), [project, requestDoc]);
  const initialDraft = useMemo(
    () => (record ? editorDraftFromPrivate(record) : canonicalDraft),
    [canonicalDraft, record],
  );
  const autosaveKey = `portal-edit-${orgId}-${project.id}-${actor.uid}`;
  const editorCanEdit = lease.canEdit && record !== null && !submitted;
  const previewAttachments = useMemo(() => previewAttachmentsFromPrivateDraft(record), [record]);
  const loadDraftDocumentPreview = useCallback(({ documentKind, signal }: {
    documentKind: ProjectRequestDocumentKind;
    signal: AbortSignal;
  }) => downloadProjectInfoDraftAttachmentViaBff({
    tenantId: orgId,
    actor,
    projectId: project.id,
    documentKind,
    signal,
  }), [actor, orgId, project.id]);
  const {
    documentPreviewUrls,
    documentPreviewStates,
    loadDocumentPreview,
  } = usePrivateDraftDocumentPreviews({
    attachments: previewAttachments,
    enabled: record !== null && !submitted,
    loadAttachment: loadDraftDocumentPreview,
  });
  const releaseLeaseAfterDraftOpenFailure = useCallback(async (error: unknown, fallback: string) => {
    recordLoadedRef.current = false;
    setRecord(null);
    await lease.release();
    toast.error(error instanceof Error ? error.message : fallback);
  }, [lease.release]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const status = await lease.checkStatus();
      if (!status.canEdit || !status.ownership || recordLoadedRef.current) return;
      try {
        const opened = await draftClient.open(status.ownership);
        if (cancelled) return;
        revisionRef.current = opened.draft.draftRevision;
        recordLoadedRef.current = true;
        setRecord(opened.draft);
      } catch (error) {
        if (cancelled) return;
        await releaseLeaseAfterDraftOpenFailure(error, '수정 임시저장을 다시 열지 못했습니다.');
      }
    })();
    return () => { cancelled = true; };
  }, [draftClient, lease.checkStatus, releaseLeaseAfterDraftOpenFailure]);

  const enqueueMutation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const epoch = mutationEpochRef.current;
    const checkedOperation = () => {
      if (epoch !== mutationEpochRef.current) throw new Error('수정 요청 회수 전 입력은 다시 확인한 뒤 저장해 주세요.');
      return operation();
    };
    const run = mutationQueueRef.current.then(checkedOperation, checkedOperation);
    mutationQueueRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  const withOwnership = useCallback(async <T,>(
    operation: (ownership: { leaseId: string; fence: number }) => Promise<T>,
  ) => {
    if (finishedRef.current || writesPausedRef.current) throw new Error('최근 임시저장과 비교한 뒤 다시 저장해 주세요.');
    const ownership = await lease.checkBeforeSave();
    if (!ownership) throw new Error('수정 세션이 종료되었거나 다른 세션이 사용 중입니다.');
    try {
      return await operation(ownership);
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 409 && error.code === 'draft_version_conflict') {
        writesPausedRef.current = true;
        setDraftConflictCount((count) => count + 1);
      }
      await lease.checkStatus();
      throw error;
    }
  }, [lease.checkBeforeSave, lease.checkStatus]);

  const startEditing = useCallback(async () => {
    const ownership = await lease.acquire();
    if (!ownership) return;
    try {
      const opened = await draftClient.open(ownership);
      revisionRef.current = opened.draft.draftRevision;
      recordLoadedRef.current = true;
      setRecord(opened.draft);
    } catch (error) {
      await releaseLeaseAfterDraftOpenFailure(error, '수정 임시저장을 열지 못했습니다.');
    }
  }, [draftClient, lease.acquire, releaseLeaseAfterDraftOpenFailure]);

  const persistDraft = useCallback((draft: ProjectEditorDraft, stepIndex: number) => enqueueMutation(() => (
    withOwnership(async (ownership) => {
      if (!record) throw new Error('수정 임시저장이 준비되지 않았습니다.');
      const saved = await draftClient.save(ownership, {
        expectedDraftRevision: revisionRef.current,
        payload: buildProjectRequestPayloadFromDraft(draft) as unknown as Record<string, unknown>,
        stepIndex,
      });
      revisionRef.current = saved.draft.draftRevision;
      setRecord(saved.draft);
    })
  )), [draftClient, enqueueMutation, record, withOwnership]);

  const loadLatestDraft = useCallback(async () => {
    writesPausedRef.current = true;
    await mutationQueueRef.current;
    const latest = await draftClient.get();
    revisionRef.current = latest.draft.draftRevision;
    latestRecordRef.current = latest.draft;
    return editorDraftFromPrivate(latest.draft);
  }, [draftClient]);

  const uploadDocument = useCallback((kind: ProjectRequestDocumentKind, file: File) => enqueueMutation(() => (
    withOwnership(async (ownership) => {
      if (!record) throw new Error('수정 임시저장이 준비되지 않았습니다.');
      const uploaded = await draftClient.upload(ownership, {
        expectedDraftRevision: revisionRef.current,
        documentKind: kind,
        file: file as ProjectInfoFileLike,
      });
      revisionRef.current = uploaded.draft.draftRevision;
      setRecord(uploaded.draft);
      let contractAnalysis = null;
      if (kind === 'contract') {
        try {
          const documentText = await extractTextFromPdf(file);
          contractAnalysis = await analyzeProjectRequestContractViaBff({
            tenantId: orgId,
            actor,
            fileName: file.name,
            documentText,
          });
        } catch (error) {
          console.error('[PortalProjectEdit] contract analysis failed:', error);
          toast.warning('계약서는 저장했지만 자동 분석에 실패했습니다. 입력값을 직접 확인해 주세요.');
        }
      }
      return { document: attachmentDocument(uploaded.attachment), contractAnalysis };
    })
  )), [actor, draftClient, enqueueMutation, orgId, record, withOwnership]);

  const removeDocument = useCallback((kind: ProjectRequestDocumentKind) => enqueueMutation(() => (
    withOwnership(async (ownership) => {
      if (!record) throw new Error('수정 임시저장이 준비되지 않았습니다.');
      const hasPrivateAttachment = record.attachmentRefs.some((attachment) => attachment.documentKind === kind);
      if (!hasPrivateAttachment) return;
      const removed = await draftClient.removeAttachment(ownership, {
        expectedDraftRevision: revisionRef.current,
        documentKind: kind as ProjectInfoDocumentKind,
      });
      revisionRef.current = removed.draft.draftRevision;
      setRecord(removed.draft);
    })
  )), [draftClient, enqueueMutation, record, withOwnership]);

  const submitDraft = async (actionId: string) => {
    const shouldResubmit = canResubmit || actionId === 'resubmit';
    const storedVersion = Number.isInteger(project.version) && Number(project.version) > 0 ? Number(project.version) : 1;
    await enqueueMutation(() => withOwnership((ownership) => draftClient.submit(ownership, {
      expectedDraftRevision: revisionRef.current,
      // A rebase reports the canonical version it aligned to; the store copy can still be stale.
      expectedVersion: rebasedVersionRef.current || storedVersion,
      resubmit: shouldResubmit,
      ...(shouldResubmit && resubmitComment.trim() ? { reviewComment: resubmitComment.trim() } : {}),
    })));
    finishedRef.current = true;
    await lease.checkStatus();
    if (shouldResubmit) setResubmitComment('');
    rebasedVersionRef.current = 0;
    setSubmitted(true);
    recordLoadedRef.current = false;
    setRecord(null);
    setSaveSuccessDialogOpen(true);
    void lease.release();
  };

  const handleSubmit = async (_draft: ProjectEditorDraft, actionId: string) => {
    if (busyActionId) return;
    if (!record) {
      toast.error('수정 임시저장이 준비되지 않았습니다.');
      return;
    }
    setBusyActionId(actionId);
    try {
      await submitDraft(actionId);
    } catch (error) {
      if (isCanonicalVersionConflict(error)) {
        try {
          const preview = await enqueueMutation(() => withOwnership((ownership) => draftClient.rebase(ownership, {
            expectedDraftRevision: revisionRef.current,
          })));
          setRebaseState({
            conflicts: preview.conflicts,
            autoMerged: preview.autoMerged,
            pendingActionId: actionId,
          });
        } catch (rebaseError) {
          toast.error(rebaseError instanceof Error
            ? rebaseError.message
            : '프로젝트 변경 내역을 불러오지 못했습니다.');
        }
        // The submit did not go through. Rethrow so the caller keeps treating this as a
        // failure and leaves the local autosave and the unsaved-changes guard in place.
        throw error;
      }
      toast.error(error instanceof Error ? error.message : '저장에 실패했습니다. 다시 시도해주세요.');
      throw error;
    } finally {
      setBusyActionId(null);
    }
  };

  const withdrawRequest = async () => {
    mutationEpochRef.current += 1;
    setWithdrawBusy(true);
    try {
      const result = await enqueueMutation(() => withOwnership((ownership) => draftClient.withdraw(ownership)));
      if (result.kind === 'REGISTRATION') {
        finishedRef.current = true;
        // 신규 등록 건은 등록 임시저장으로 복원된다. 이 수정 화면이 아니라 등록 위저드에서 이어간다.
        setWithdrawOpen(false);
        toast.success('등록 요청을 회수했습니다. 등록 임시저장에서 이어서 작성할 수 있습니다.');
        navigate(result.registrationDraftId
          ? `/portal/register-project/${result.registrationDraftId}`
          : '/portal/register-project');
        return;
      }
      revisionRef.current = result.draft.draftRevision;
      rebasedVersionRef.current = result.canonicalVersion;
      setRecord(result.draft);
      recordLoadedRef.current = true;
      setWithdrawOpen(false);
      toast.success('수정 요청을 회수했습니다. 이어서 수정할 수 있습니다.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '수정 요청을 회수하지 못했습니다.');
    } finally {
      setWithdrawBusy(false);
    }
  };

  const applyRebase = async (resolutions: Record<string, ProjectInfoRebaseResolution>) => {
    if (!rebaseState) return;
    const actionId = rebaseState.pendingActionId;
    setRebaseBusy(true);
    try {
      const result = await enqueueMutation(() => withOwnership((ownership) => draftClient.rebase(ownership, {
        expectedDraftRevision: revisionRef.current,
        resolutions,
      })));
      if (result.draft) {
        revisionRef.current = result.draft.draftRevision;
        setRecord(result.draft);
      }
      rebasedVersionRef.current = result.canonicalVersion;
      setRebaseState(null);
      setBusyActionId(actionId);
      try {
        await submitDraft(actionId);
      } finally {
        setBusyActionId(null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '변경 내용을 반영하지 못했습니다. 다시 시도해주세요.');
    } finally {
      setRebaseBusy(false);
    }
  };

  const minutesLeft = Math.max(0, Math.ceil(lease.remainingMs / 60_000));
  const leaseBar = (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
      <div className="flex items-center gap-2 text-slate-700">
        {lease.canEdit ? <Pencil className="h-4 w-4" /> : <LockKeyhole className="h-4 w-4" />}
        <span>{lease.error || (lease.canEdit
          ? (record ? `수정 세션 사용 중 · ${minutesLeft}분 남음` : '수정 임시저장 준비 중')
          : '읽기 모드')}</span>
      </div>
      <div className="flex gap-2">
        {lease.canEdit ? (
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => void lease.extend()} disabled={lease.busy}>
              <Clock3 className="mr-1 h-4 w-4" />30분 연장
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void lease.release()} disabled={lease.busy}>
              수정 종료
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" onClick={() => void startEditing()} disabled={lease.busy}>
            수정 시작
          </Button>
        )}
      </div>
    </div>
  );

  const resubmitCommentField = (
    <div className="mt-4">
      <Label className="text-[11px] font-semibold uppercase tracking-[0.16em]">다시 제출 메모</Label>
      <Textarea
        value={resubmitComment}
        onChange={(event) => setResubmitComment(event.target.value)}
        maxLength={2000}
        placeholder="보완한 내용을 짧게 남길 수 있습니다."
        className="mt-2 min-h-[88px] border-white/70 bg-white/85 text-sm text-slate-900"
        disabled={!editorCanEdit}
      />
      <p className="mt-1 text-right text-[10px] text-slate-500">{resubmitComment.length.toLocaleString()}/2,000자</p>
    </div>
  );

  const topSlot = (
    <div className="space-y-3">
      {leaseBar}
      <div className={`rounded-2xl border px-4 py-4 ${bannerClassName(executiveBanner.tone)}`}>
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em]">{canExecutiveResubmit ? '반려 사유' : '검토 상태'}</p>
            <h2 className="mt-1 text-base font-semibold">{executiveBanner.title}</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{executiveBanner.description}</p>
            {canExecutiveResubmit ? resubmitCommentField : null}
            {canWithdrawRequest ? (
              <div className="mt-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setWithdrawOpen(true)}
                  disabled={withdrawBusy || !!busyActionId}
                >
                  수정 요청 회수
                </Button>
                <p className="mt-1.5 text-[11px] leading-5 opacity-80">
                  승인 대기열에서 요청을 빼고 이어서 수정합니다. 조직장이 이미 처리했다면 회수할 수 없습니다.
                </p>
              </div>
            ) : null}
          </div>
          {busyActionId ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        </div>
      </div>
      {managementPlanningBanner ? (
        <div className={`rounded-2xl border px-4 py-4 ${managementPlanningBannerClassName(managementPlanningBanner.tone)}`} data-testid="portal-management-planning-review">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em]">경영기획실 검토</p>
              <h2 className="mt-1 text-base font-semibold">{managementPlanningBanner.title}</h2>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{managementPlanningBanner.description}</p>
              {canManagementPlanningResubmit ? resubmitCommentField : null}
            </div>
          </div>
        </div>
      ) : null}
      {reviewFeedback.length > 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white px-4 py-3" data-testid="portal-project-review-feedback">
          <div className="flex items-center gap-2 text-slate-900"><MessageSquareText className="h-4 w-4" /><h2 className="text-sm font-semibold">제출·처리 메모</h2></div>
          <ol className="mt-3 space-y-3 border-l border-slate-200 pl-4">
            {reviewFeedback.map((entry) => (
              <li key={entry.id} className="relative">
                <span className="absolute -left-[1.1rem] top-1.5 h-2 w-2 rounded-full border border-slate-300 bg-white" />
                <p className="text-xs font-semibold text-slate-800">{entry.label}</p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-700">{entry.comment}</p>
                {entry.reviewerName || entry.reviewedAt ? <p className="mt-1 text-xs text-slate-500">{[entry.reviewerName, entry.reviewedAt].filter(Boolean).join(' · ')}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );

  return (
    <>
      <ProjectEditorWizard
        mode="portal-edit"
        title="프로젝트 수정"
        description="임시저장 내용은 본인에게만 보이며, 최종 저장 후 승인 대기열에 표시됩니다."
        embeddedInShell
        initialDraft={initialDraft}
        draftKey={autosaveKey}
        members={members}
        roster={roster}
        departmentOptions={departmentOptions}
        settlementSystemOptions={settlementSystemOptions}
        topSlot={topSlot}
        showCheckoutEntry
        readOnly={!editorCanEdit || withdrawBusy || rebaseBusy || rebaseState !== null}
        trustedParticipationSheetDraft={canonicalDraft}
        canRemoveContractDocument={Boolean(record?.attachmentRefs.some((attachment) => attachment.documentKind === 'contract'))}
        canRemoveProjectDocuments
        onRemoveProjectDocument={removeDocument}
        completed={submitted}
        autosave={{
          key: autosaveKey,
          ready: record !== null,
          disabled: submitted || !editorCanEdit || withdrawBusy || rebaseBusy || rebaseState !== null,
          conflictCount: draftConflictCount,
          onSave: persistDraft,
          onLoadLatest: loadLatestDraft,
          onResume: () => {
            if (latestRecordRef.current) setRecord(latestRecordRef.current);
            writesPausedRef.current = false;
          },
        }}
        actions={submitted ? [] : (
          canResubmit
            ? [{ id: 'resubmit', label: '수정 후 다시 제출', icon: SendHorizontal, variant: 'secondary' as const }]
            : [{ id: 'save', label: '최종 저장', icon: Save }]
        )}
        busyActionId={busyActionId}
        documentPreviewUrls={documentPreviewUrls}
        documentPreviewStates={documentPreviewStates}
        onLoadDocumentPreview={loadDocumentPreview}
        onContractFileUpload={async (file) => {
          const uploaded = await uploadDocument('contract', file);
          return { contractDocument: uploaded.document, contractAnalysis: uploaded.contractAnalysis };
        }}
        onProjectDocumentFileUpload={({ kind, file }) => uploadDocument(kind, file)}
        onLeave={async () => {
          finishedRef.current = true;
          await mutationQueueRef.current;
          if (!await lease.release()) {
            finishedRef.current = false;
            throw new Error('edit lease release failed');
          }
        }}
        onCancel={() => navigate('/portal/project-select')}
        onSubmit={handleSubmit}
      />
      <EditLeaseDialogs
        warningOpen={lease.warningOpen}
        expiredOpen={lease.expiredOpen}
        conflictOpen={lease.conflictOpen}
        holder={lease.holder}
        busy={lease.busy}
        onDismissWarning={lease.dismissWarning}
        onExtend={() => { void lease.extend(); }}
        onContinueReadOnly={lease.continueReadOnly}
        onReacquire={() => { void startEditing(); }}
        onTakeover={() => { void lease.takeover(); }}
      />
      <AlertDialog open={withdrawOpen} onOpenChange={(open) => { if (!withdrawBusy) setWithdrawOpen(open); }}>
        <AlertDialogContent className="max-w-md border border-slate-200 bg-white">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg text-slate-950">수정 요청을 회수할까요?</AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-6 text-slate-600">
              요청이 승인 대기열에서 빠지고, 프로젝트 검토 상태는 요청 이전으로 되돌아갑니다.
              입력한 내용은 그대로 남아 이어서 수정할 수 있습니다. 다시 제출하려면 최종 저장을 눌러주세요.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={withdrawBusy}>닫기</AlertDialogCancel>
            <AlertDialogAction
              disabled={withdrawBusy}
              onClick={(event) => { event.preventDefault(); void withdrawRequest(); }}
            >
              {withdrawBusy ? '회수 중...' : '회수하고 이어서 수정'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ProjectInfoRebaseDialog
        open={rebaseState !== null}
        conflicts={rebaseState?.conflicts || []}
        autoMerged={rebaseState?.autoMerged || []}
        busy={rebaseBusy}
        onConfirm={(resolutions) => { void applyRebase(resolutions); }}
        onCancel={() => setRebaseState(null)}
      />
      <AlertDialog open={saveSuccessDialogOpen}
        onOpenChange={(open) => {
          setSaveSuccessDialogOpen(open);
          if (!open && submitted) navigate('/portal/project-select');
        }}
      >
        <AlertDialogContent className="max-w-md border border-slate-200 bg-white">
          <AlertDialogHeader className="items-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <AlertDialogTitle className="text-xl text-slate-950">프로젝트 수정 요청이 등록되었습니다</AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-6 text-slate-600">
              {canManagementPlanningResubmit
                ? '기존 조직장 승인 이력은 유지되며, 보완한 요청은 경영기획실 재검토 화면에 표시됩니다.'
                : '조직장 승인 전까지 프로젝트 원장은 바뀌지 않으며, 조직장 검토 화면에서 최신 수정 요청으로 확인됩니다.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:justify-center">
            <AlertDialogAction onClick={() => navigate('/portal/project-select')}>프로젝트 목록으로</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function PortalProjectEdit() {
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId: routeProjectIdParam } = useParams<{ projectId: string }>();
  const routeProjectId = routeProjectIdParam?.trim() || '';
  const { user } = useAuth();
  const { orgId } = useFirebase();
  const { activeProjectId, isLoading: portalLoading, members, myProject: sessionProject, projects } = usePortalStore();
  const roster = usePersonRoster();
  const { options: departmentOptions } = useProjectDepartmentSettings();
  const routeProject = routeProjectId ? projects.find((project) => project.id === routeProjectId) || null : null;
  const fallbackProject = projects.find((project) => project.id === activeProjectId) || sessionProject;
  const project = routeProjectId ? routeProject : fallbackProject;
  const currentPath = `${location.pathname}${location.search}${location.hash}`;
  const [requestDoc, setRequestDoc] = useState<ProjectRequest | null>(null);
  const [bootstrap, setBootstrap] = useState<{
    actor: ActorLike;
    draftClient: DraftClient;
    session: EditSession;
  } | null>(null);
  const [error, setError] = useState('');
  const identityKey = [user?.uid, user?.email, user?.name, user?.role].join('|');

  useEffect(() => {
    if (routeProjectId || !project?.id) return;
    navigate(resolvePortalProjectResourcePath(currentPath, project.id), { replace: true });
  }, [currentPath, navigate, project?.id, routeProjectId]);

  useEffect(() => {
    if (!project?.id || !user?.uid || !isPlatformApiEnabled()) {
      setRequestDoc(null);
      return undefined;
    }
    let disposed = false;
    void (async () => {
      try {
        const idToken = user.idToken || await getAuthInstance()?.currentUser?.getIdToken() || undefined;
        const request = await fetchLatestProjectRequestViaBff({
          tenantId: orgId,
          actor: { uid: user.uid, email: user.email, role: user.role, idToken },
          projectId: project.id,
        });
        if (!disposed) setRequestDoc(request);
      } catch (cause) {
        console.error('[PortalProjectEdit] latest project request fetch failed:', cause);
        if (!disposed) setRequestDoc(null);
      }
    })();
    return () => { disposed = true; };
  }, [orgId, project?.id, user?.email, user?.idToken, user?.role, user?.uid]);

  useEffect(() => {
    if (!user?.uid || !project?.id) {
      setBootstrap(null);
      return undefined;
    }
    let cancelled = false;
    let session: EditSession | null = null;
    void (async () => {
      try {
        setError('');
        session = await openEditSession();
        const idToken = user.idToken || await getAuthInstance()?.currentUser?.getIdToken() || undefined;
        const actor: ActorLike = { uid: user.uid, email: user.email, role: user.role, idToken };
        const draftClient = createProjectInfoDraftClient({
          tenantId: orgId, actor, sessionId: session.sessionId, projectId: project.id,
        });
        if (!cancelled) setBootstrap({ actor, draftClient, session });
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '수정 세션을 준비하지 못했습니다.');
      }
    })();
    return () => {
      cancelled = true;
      session?.dispose();
    };
  // Token refresh must not remount the editor; identity or project changes must.
  }, [identityKey, orgId, project?.id]);

  useEffect(() => {
    const idToken = user?.idToken;
    if (!user?.uid || !idToken || !project?.id) return;
    setBootstrap((current) => {
      if (!current || current.actor.uid !== user.uid || current.actor.idToken === idToken) return current;
      const actor = { ...current.actor, idToken };
      return {
        ...current,
        actor,
        draftClient: createProjectInfoDraftClient({
          tenantId: orgId,
          actor,
          sessionId: current.session.sessionId,
          projectId: project.id,
        }),
      };
    });
  }, [orgId, project?.id, user?.idToken, user?.uid]);

  const canonicalDraft = useMemo(() => {
    if (!project) return createProjectEditorDraft();
    const pendingChange = requestDoc?.status === 'PENDING' && resolveProjectRequestKind(requestDoc) === 'CHANGE';
    return createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject(project, pendingChange ? resolveProjectRequestPayload(requestDoc) : undefined),
    });
  }, [project, requestDoc]);

  if (!project && portalLoading) {
    return (
      <div className="flex min-h-48 items-center justify-center text-sm text-slate-500" role="status">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />프로젝트를 불러오는 중...
      </div>
    );
  }
  if (!project) {
    return (
      <Card className="border-dashed border-slate-200 bg-slate-50">
        <CardContent className="p-8 text-center">
          <p className="text-sm text-slate-600">수정할 프로젝트를 찾지 못했습니다.</p>
          <Button className="mt-4" onClick={() => navigate('/portal/project-select')}>프로젝트 선택으로 돌아가기</Button>
        </CardContent>
      </Card>
    );
  }
  if (error) return <div className="rounded-lg border border-red-200 bg-white p-5 text-sm text-red-700">{error}</div>;
  if (!bootstrap) return <div className="p-6 text-sm text-muted-foreground">읽기 모드를 준비하는 중...</div>;
  return (
    <ProjectInfoEditor
      key={project.id}
      actor={bootstrap.actor}
      canonicalDraft={canonicalDraft}
      departmentOptions={departmentOptions}
      draftClient={bootstrap.draftClient}
      members={members}
      roster={roster}
      project={project}
      requestDoc={requestDoc}
      settlementSystemOptions={projects.flatMap((item) => item.settlementSystem === 'OTHER' && item.settlementSystemOther && !item.trashedAt ? [item.settlementSystemOther] : [])}
      session={bootstrap.session}
    />
  );
}
