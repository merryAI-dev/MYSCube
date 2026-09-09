import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CheckCircle2, Clock3, LockKeyhole, Pencil, Send } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../data/auth-store';
import { useProjectDepartmentSettings } from '../../data/project-department-settings';
import { usePersonRoster } from '../../data/use-person-roster';
import { usePortalStore } from '../../data/portal-store';
import type { FileAttachment } from '../../data/types';
import { getAuthInstance } from '../../lib/firebase';
import { useFirebase } from '../../lib/firebase-context';
import { extractTextFromPdf } from '../../lib/pdf-extract';
import { createEditLeaseClient } from '../../lib/edit-lease-client';
import { downloadProjectRegistrationDraftAttachmentViaBff } from '../../lib/project-request-attachment-client';
import {
  createProjectRegistrationDraftClient,
  type ProjectRegistrationAttachment,
  type ProjectRegistrationDraft,
  type ProjectRegistrationFileLike,
  type ProjectRegistrationDocumentKind,
} from '../../lib/project-registration-draft-client';
import { analyzeProjectRequestContractViaBff, type ActorLike } from '../../lib/platform-bff-client';
import { openEditSession, type EditSession } from '../../platform/edit-session';
import {
  buildProjectRequestPayloadFromDraft,
  createProjectEditorDraft,
  type ProjectEditorDraft,
} from '../../platform/project-editor';
import type { ProjectRequestDocumentKind } from '../../platform/project-contract-upload';
import { EditLeaseDialogs } from '../editing/EditLeaseDialogs';
import { useEditLease } from '../editing/useEditLease';
import { ProjectEditorWizard } from '../projects/ProjectEditorWizard';
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
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Input } from '../ui/input';
import { usePrivateDraftDocumentPreviews } from './usePrivateDraftDocumentPreviews';

type DraftClient = ReturnType<typeof createProjectRegistrationDraftClient>;

function attachmentDocument(attachment: ProjectRegistrationAttachment): FileAttachment {
  return {
    path: attachment.path,
    name: attachment.name,
    downloadURL: '',
    size: attachment.size,
    contentType: attachment.contentType,
    uploadedAt: attachment.uploadedAt || '',
  };
}

function draftForEditor(record: ProjectRegistrationDraft): ProjectEditorDraft {
  const documents: Partial<Record<ProjectRequestDocumentKind, FileAttachment>> = {};
  for (const attachment of record.attachmentRefs) {
    documents[attachment.documentKind] = attachmentDocument(attachment);
  }
  return createProjectEditorDraft({
    ...(record.payload as Partial<ProjectEditorDraft>),
    contractDocument: documents.contract || null,
    quoteDocument: documents.quote || null,
    proposalDocument: documents.proposal || null,
    proposalWordOriginalDocument: documents.proposal_word_original || null,
    proposalPptOriginalDocument: documents.proposal_ppt_original || null,
    presentationPptOriginalDocument: documents.presentation_ppt_original || null,
    rfpRequestEvidenceDocument: documents.rfp_request_evidence || null,
    customerBusinessRegistrationDocument: documents.customer_business_registration || null,
    registrationRequirementsVersion: 2,
  });
}

function RegistrationEditor({
  actor,
  draftClient,
  record: initialRecord,
  session,
}: {
  actor: ActorLike;
  draftClient: DraftClient;
  record: ProjectRegistrationDraft;
  session: EditSession;
}) {
  const navigate = useNavigate();
  const { orgId } = useFirebase();
  const { members, projects } = usePortalStore();
  const roster = usePersonRoster();
  const { options: departmentOptions } = useProjectDepartmentSettings();
  const [record, setRecord] = useState(initialRecord);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [aliasInput, setAliasInput] = useState(String(initialRecord.alias || ''));
  const revisionRef = useRef(record.draftRevision);
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const leaseClient = useMemo(() => createEditLeaseClient({
    tenantId: orgId,
    actor,
    sessionId: session.sessionId,
    resourceType: 'project-registration',
    resourceId: record.draftId,
  }), [actor, orgId, record.draftId, session.sessionId]);
  const lease = useEditLease({ client: leaseClient });
  const loadDraftDocumentPreview = useCallback(({ documentKind, signal }: {
    documentKind: ProjectRequestDocumentKind;
    signal: AbortSignal;
  }) => downloadProjectRegistrationDraftAttachmentViaBff({
    tenantId: orgId,
    actor,
    draftId: record.draftId,
    documentKind,
    signal,
  }), [actor, orgId, record.draftId]);
  const {
    documentPreviewUrls,
    documentPreviewStates,
    loadDocumentPreview,
  } = usePrivateDraftDocumentPreviews({
    attachments: record.attachmentRefs,
    enabled: !submitted,
    loadAttachment: loadDraftDocumentPreview,
  });

  useEffect(() => {
    void lease.checkStatus();
  }, [lease.checkStatus]);

  const enqueueMutation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const run = mutationQueueRef.current.then(operation, operation);
    mutationQueueRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  const withOwnership = useCallback(async <T,>(operation: (ownership: { leaseId: string; fence: number }) => Promise<T>) => {
    const ownership = await lease.checkBeforeSave();
    if (!ownership) throw new Error('수정 세션이 종료되었거나 다른 세션이 사용 중입니다.');
    try {
      return await operation(ownership);
    } catch (error) {
      await lease.checkStatus();
      throw error;
    }
  }, [lease.checkBeforeSave, lease.checkStatus]);

  const persistDraft = useCallback((draft: ProjectEditorDraft, stepIndex: number) => enqueueMutation(() => (
    withOwnership(async (ownership) => {
      const saved = await draftClient.save(record.draftId, ownership, {
        expectedDraftRevision: revisionRef.current,
        payload: buildProjectRequestPayloadFromDraft(draft) as unknown as Record<string, unknown>,
        stepIndex,
      });
      revisionRef.current = saved.draft.draftRevision;
      setRecord(saved.draft);
    })
  )), [draftClient, enqueueMutation, record.draftId, withOwnership]);

  const uploadDocument = useCallback((kind: ProjectRequestDocumentKind, file: File) => enqueueMutation(() => (
    withOwnership(async (ownership) => {
      if (![
        'contract',
        'customer_business_registration',
        'quote',
        'proposal',
        'proposal_word_original',
        'proposal_ppt_original',
        'presentation_ppt_original',
        'rfp_request_evidence',
      ].includes(kind)) {
        throw new Error('신규 등록에서 지원하지 않는 첨부 종류입니다.');
      }
      const uploaded = await draftClient.upload(record.draftId, ownership, {
        expectedDraftRevision: revisionRef.current,
        documentKind: kind as ProjectRegistrationDocumentKind,
        file: file as ProjectRegistrationFileLike,
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
          console.error('[PortalProjectRegister] contract analysis failed:', error);
          toast.warning('계약서는 저장했지만 자동 분석에 실패했습니다. 입력값을 직접 확인해 주세요.');
        }
      }
      return { document: attachmentDocument(uploaded.attachment), contractAnalysis };
    })
  )), [actor, draftClient, enqueueMutation, orgId, record.draftId, withOwnership]);

  const removeDocument = useCallback((kind: ProjectRequestDocumentKind) => enqueueMutation(() => (
    withOwnership(async (ownership) => {
      if (![
        'contract',
        'customer_business_registration',
        'quote',
        'proposal',
        'proposal_word_original',
        'proposal_ppt_original',
        'presentation_ppt_original',
        'rfp_request_evidence',
      ].includes(kind)) {
        throw new Error('신규 등록에서 지원하지 않는 첨부 종류입니다.');
      }
      const removed = await draftClient.removeAttachment(record.draftId, ownership, {
        expectedDraftRevision: revisionRef.current,
        documentKind: kind as ProjectRegistrationDocumentKind,
      });
      revisionRef.current = removed.draft.draftRevision;
      setRecord(removed.draft);
    })
  )), [draftClient, enqueueMutation, record.draftId, withOwnership]);

  const editorDraft = useMemo(() => draftForEditor(record), [record]);
  const autosave = useMemo(() => ({
    key: `portal-register-${record.draftId}`,
    disabled: !lease.canEdit,
    onSave: persistDraft,
  }), [lease.canEdit, persistDraft, record.draftId]);

  const submit = async () => {
    if (busyActionId) return;
    setBusyActionId('submit');
    try {
      await enqueueMutation(() => withOwnership((ownership) => draftClient.submit(record.draftId, ownership, {
        expectedDraftRevision: revisionRef.current,
      })));
      setSubmitted(true);
      toast.success('프로젝트 등록 요청이 최종 제출되었습니다.');
    } finally {
      setBusyActionId(null);
    }
  };

  if (submitted) {
    return (
      <div className="mx-auto w-full max-w-5xl py-10">
        <Card className="border-slate-200 bg-white">
          <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[#001e46] text-white">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-slate-950">프로젝트 등록 요청이 최종 제출되었습니다</h1>
              <p className="mt-2 text-sm text-slate-600">이제 최종 결재자 (총괄책임자)의 조직장 검토 화면에 표시됩니다.</p>
            </div>
            <Button onClick={() => navigate('/portal/project-select')}>프로젝트 선택으로 돌아가기</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const minutesLeft = Math.max(0, Math.ceil(lease.remainingMs / 60_000));
  const topSlot = (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-3 text-slate-700">
        {lease.canEdit ? <Pencil className="h-4 w-4" /> : <LockKeyhole className="h-4 w-4" />}
        <span>{lease.error || (lease.canEdit ? `수정 세션 사용 중 · ${minutesLeft}분 남음` : '읽기 모드')}</span>
        {/* 임시저장 이름. 목록에서 초안을 구분하는 표시용이라 제출 payload 와 분리해 저장한다. */}
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          임시저장 이름
          <Input
            value={aliasInput}
            onChange={(event) => setAliasInput(event.target.value.slice(0, 60))}
            onBlur={() => {
              const nextAlias = aliasInput.trim();
              if (nextAlias === String(record.alias || '')) return;
              void enqueueMutation(() => withOwnership(async (ownership) => {
                const saved = await draftClient.setAlias(record.draftId, ownership, nextAlias);
                setRecord(saved.draft);
              })).catch(() => toast.error('임시저장 이름을 저장하지 못했습니다.'));
            }}
            placeholder="예: 관광벤처 멘토링"
            disabled={!lease.canEdit}
            className="h-8 w-52 text-[13px]"
          />
        </label>
      </div>
      <div className="flex gap-2">
        {lease.canEdit ? (
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => void lease.extend()} disabled={lease.busy}>
              <Clock3 className="mr-1 h-4 w-4" />30분 연장
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" onClick={() => void lease.acquire()} disabled={lease.busy}>
            수정 시작
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <>
      <ProjectEditorWizard
        mode="portal-register"
        title="프로젝트 등록"
        description="임시저장 내용은 본인에게만 보이며, 최종 저장 후 최종 결재자 (총괄책임자)의 조직장 검토 화면에 표시됩니다."
        embeddedInShell
        initialDraft={editorDraft}
        draftKey={`portal-register-${record.draftId}`}
        members={members}
        roster={roster}
        departmentOptions={departmentOptions}
        settlementSystemOptions={projects.flatMap((project) => project.settlementSystem === 'OTHER' && project.settlementSystemOther && !project.trashedAt ? [project.settlementSystemOther] : [])}
        topSlot={topSlot}
        readOnly={!lease.canEdit}
        autosave={autosave}
        actions={[{ id: 'submit', label: '최종 저장', icon: Send }]}
        busyActionId={busyActionId}
        documentPreviewUrls={documentPreviewUrls}
        documentPreviewStates={documentPreviewStates}
        onLoadDocumentPreview={loadDocumentPreview}
        onProjectDocumentFileUpload={({ kind, file }) => uploadDocument(kind, file)}
        canRemoveContractDocument
        canRemoveProjectDocuments
        onRemoveProjectDocument={removeDocument}
        onLeave={async () => {
          if (!await lease.release()) throw new Error('edit lease release failed');
        }}
        onCancel={() => navigate('/portal/project-select')}
        onSubmit={() => submit()}
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
        onReacquire={() => { void lease.acquire(); }}
        onTakeover={() => { void lease.takeover(); }}
      />
    </>
  );
}

export function PortalProjectRegister() {
  const { draftId } = useParams<{ draftId?: string }>();
  const navigate = useNavigate();
  const { orgId } = useFirebase();
  const { user } = useAuth();
  const [bootstrap, setBootstrap] = useState<{
    actor: ActorLike;
    client: DraftClient;
    draft: ProjectRegistrationDraft;
    session: EditSession;
  } | null>(null);
  const [error, setError] = useState('');
  const [resumeChoices, setResumeChoices] = useState<
    Array<{ draftId: string; alias: string; name: string; updatedAt: string; stepIndex: number }> | null
  >(null);
  const [deletingDraftId, setDeletingDraftId] = useState<string | null>(null);
  const [confirmDeleteDraftId, setConfirmDeleteDraftId] = useState<string | null>(null);
  const listClientRef = useRef<DraftClient | null>(null);
  const [forceNewDraft, setForceNewDraft] = useState(false);
  const createDraftPromiseRef = useRef<{
    ownerKey: string;
    promise: Promise<{ draft: ProjectRegistrationDraft }>;
  } | null>(null);
  const identityKey = [user?.uid, user?.email, user?.name, user?.role].join('|');

  useEffect(() => {
    if (!user?.uid) {
      setBootstrap(null);
      return undefined;
    }
    setBootstrap(null);
    let cancelled = false;
    let session: EditSession | null = null;
    void (async () => {
      try {
        setError('');
        session = await openEditSession();
        if (cancelled) {
          session.dispose();
          return;
        }
        const idToken = user.idToken || await getAuthInstance()?.currentUser?.getIdToken() || undefined;
        if (cancelled) return;
        const actor: ActorLike = { uid: user.uid, email: user.email, role: user.role, idToken };
        const client = createProjectRegistrationDraftClient({ tenantId: orgId, actor, sessionId: session.sessionId });
        if (!draftId) {
          // 임시저장한 초안이 있으면 새로 만들기 전에 사람이 고른다. 조용히 최신 초안에
          // 떨어뜨리면 새로 등록하려던 사람이 남의 문맥에서 시작하게 된다.
          if (!forceNewDraft) {
            listClientRef.current = client;
            let existing: Array<{ draftId: string; alias: string; name: string; updatedAt: string; stepIndex: number }> = [];
            try {
              ({ drafts: existing } = await client.list());
            } catch {
              // 목록 조회 실패가 등록 자체를 막으면 안 된다. 새 초안 생성으로 폴백한다.
            }
            if (cancelled) return;
            if (existing.length > 0) {
              setResumeChoices(existing);
              session.dispose();
              session = null;
              return;
            }
          }
          const ownerKey = `${orgId}:${user.uid}`;
          const initial = createProjectEditorDraft({
            registrationRequirementsVersion: 2,
            registeredById: user.uid,
            registeredByName: user.name || '',
            registeredByEmail: user.email || '',
            managerId: user.uid,
            managerName: user.name || '',
          });
          if (!createDraftPromiseRef.current || createDraftPromiseRef.current.ownerKey !== ownerKey) {
            createDraftPromiseRef.current = {
              ownerKey,
              promise: client.create({
                payload: buildProjectRequestPayloadFromDraft(initial) as unknown as Record<string, unknown>,
                stepIndex: 0,
              }),
            };
          }
          const pendingCreate = createDraftPromiseRef.current;
          let created: { draft: ProjectRegistrationDraft };
          try {
            created = await pendingCreate.promise;
          } catch (cause) {
            if (createDraftPromiseRef.current === pendingCreate) createDraftPromiseRef.current = null;
            throw cause;
          }
          if (!cancelled) navigate(`/portal/register-project/${created.draft.draftId}`, { replace: true });
          return;
        }
        createDraftPromiseRef.current = null;
        const loaded = await client.get(draftId);
        if (!cancelled && session) setBootstrap({ actor, client, draft: loaded.draft, session });
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '등록 임시저장을 불러오지 못했습니다.');
      }
    })();
    return () => {
      cancelled = true;
      session?.dispose();
    };
  // Token refresh must not unmount the editor; identity changes must.
  }, [draftId, forceNewDraft, identityKey, navigate, orgId]);

  useEffect(() => {
    const idToken = user?.idToken;
    if (!user?.uid || !idToken) return;
    setBootstrap((current) => {
      if (!current || current.actor.uid !== user.uid || current.actor.idToken === idToken) return current;
      const actor = { ...current.actor, idToken };
      return {
        ...current,
        actor,
        client: createProjectRegistrationDraftClient({
          tenantId: orgId,
          actor,
          sessionId: current.session.sessionId,
        }),
      };
    });
  }, [orgId, user?.idToken, user?.uid]);

  if (error) {
    return <div className="rounded-lg border border-red-200 bg-white p-5 text-sm text-red-700">{error}</div>;
  }
  if (!draftId && resumeChoices && resumeChoices.length > 0) {
    return (
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-900">작성 중인 등록 임시저장이 있습니다</h2>
            <p className="text-sm text-slate-600">이어서 작성하거나, 새로 등록을 시작할 수 있어요.</p>
          </div>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {resumeChoices.map((choice) => (
              <li key={choice.draftId} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {choice.alias || choice.name || '이름 없는 임시저장'}
                  </p>
                  <p className="text-xs text-slate-500">
                    마지막 저장 {choice.updatedAt ? new Date(choice.updatedAt).toLocaleString('ko-KR') : '시각 정보 없음'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => navigate(`/portal/register-project/${choice.draftId}`)}
                  >
                    <Pencil className="h-4 w-4" />
                    이어서 작성
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                    disabled={deletingDraftId === choice.draftId}
                    onClick={() => setConfirmDeleteDraftId(choice.draftId)}
                  >
                    {deletingDraftId === choice.draftId ? '삭제 중...' : '삭제'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <AlertDialog
            open={confirmDeleteDraftId !== null}
            onOpenChange={(nextOpen) => { if (!nextOpen) setConfirmDeleteDraftId(null); }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>이 임시저장을 삭제할까요?</AlertDialogTitle>
                <AlertDialogDescription>
                  첨부파일까지 정리되며 목록에서 사라집니다. 이 작업은 되돌릴 수 없습니다.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>취소</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-rose-600 hover:bg-rose-700"
                  onClick={() => {
                    const targetDraftId = confirmDeleteDraftId;
                    setConfirmDeleteDraftId(null);
                    if (!targetDraftId || !listClientRef.current) return;
                    setDeletingDraftId(targetDraftId);
                    void listClientRef.current.discard(targetDraftId)
                      .then(() => {
                        setResumeChoices((current) => {
                          const remaining = (current || []).filter((item) => item.draftId !== targetDraftId);
                          if (remaining.length === 0) setForceNewDraft(true);
                          return remaining.length > 0 ? remaining : null;
                        });
                        toast.success('임시저장을 삭제했습니다.');
                      })
                      .catch(() => toast.error('임시저장 삭제에 실패했습니다. 잠시 후 다시 시도해 주세요.'))
                      .finally(() => setDeletingDraftId(null));
                  }}
                >
                  삭제
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button
            type="button"
            className="gap-1.5"
            onClick={() => {
              setResumeChoices(null);
              setForceNewDraft(true);
            }}
          >
            새로 등록 시작
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (!bootstrap) {
    return <div className="p-6 text-sm text-muted-foreground">등록 임시저장을 준비하는 중...</div>;
  }
  return (
    <RegistrationEditor
      actor={bootstrap.actor}
      draftClient={bootstrap.client}
      record={bootstrap.draft}
      session={bootstrap.session}
    />
  );
}
