import { useEffect, useMemo, useState } from 'react';
import { INTEREST_REFUND_POLICY_LABELS, type FileAttachment, type ProjectRegistrationOptionalDocumentNotes } from '../../../data/types';
import type { MigrationAuditConsoleRecord } from '../../../platform/project-migration-console';
import { getMigrationAuditStatusLabel } from '../../../platform/project-migration-console';
import { resolveProjectRequestKind, resolveProjectRequestPayload } from '../../../platform/project-change-request';
import type { ProjectRequestDocumentKind } from '../../../platform/project-contract-upload';
import { PROJECT_DOCUMENTS, type ProjectDocumentField } from '../../../platform/project-documents';
import { buildMigrationReviewDossier } from '../../../platform/project-migration-review-dossier';
import {
  getManagementPlanningReview,
  getManagementPlanningReviewLabel,
} from '../../../platform/project-management-planning-review';
import { ContractDocumentPreview } from '../ContractDocumentPreview';
import { ProjectClosureDriveContents } from '../ProjectClosureDriveContents';
import { FinancialYearsTable } from './FinancialYearsTable';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Button } from '../../ui/button';

interface MigrationAuditDocumentDialogProps {
  open: boolean;
  record: MigrationAuditConsoleRecord | null;
  acting: boolean;
  canFinalize: boolean;
  documentPreviewUrls?: Partial<Record<ProjectRequestDocumentKind, string>>;
  documentPreviewStates?: Partial<Record<ProjectRequestDocumentKind, {
    status: 'idle' | 'loading' | 'ready' | 'error';
    error?: string;
  }>>;
  reviewStage?: 'executive' | 'managementPlanning';
  onLoadDocumentPreview?: (kind: ProjectRequestDocumentKind) => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
  onApprove: () => void;
  onReject: () => void;
}

type ReviewDocumentDefinition = {
  kind: ProjectRequestDocumentKind;
  field: ProjectDocumentField;
  label: string;
};

type ReviewDocumentSlotDefinition = {
  number: number;
  label: string;
  kinds: ProjectRequestDocumentKind[];
  optional?: boolean;
  noteField?: keyof ProjectRegistrationOptionalDocumentNotes;
};

type ReviewDocumentEntry = ReviewDocumentDefinition & {
  document: FileAttachment;
};

type ReviewDocumentSlot = ReviewDocumentSlotDefinition & {
  entries: ReviewDocumentEntry[];
  note: string;
  link: string;
  conflict: boolean;
};

const REVIEW_DOCUMENT_DEFINITIONS: ReviewDocumentDefinition[] = PROJECT_DOCUMENTS.map(({ documentKind, field, label }) => ({ kind: documentKind, field, label }));

const REVIEW_DOCUMENT_SLOTS: ReviewDocumentSlotDefinition[] = [
  { number: 1, label: '계약서 PDF', kinds: ['contract'] },
  { number: 2, label: '고객사 사업자등록증 PDF', kinds: ['customer_business_registration'] },
  { number: 3, label: '산출내역서(견적서) PDF', kinds: ['quote'] },
  { number: 4, label: '제안서 Word 원본 (선택)', kinds: ['proposal_word_original'], optional: true, noteField: 'proposalWordOriginal' },
  { number: 5, label: '제안서(구글드라이브 링크)', kinds: ['proposal_ppt_original'], optional: true, noteField: 'proposalPptOriginal' },
  { number: 6, label: '발표자료(구글드라이브 링크)', kinds: ['presentation_ppt_original'], optional: true, noteField: 'presentationPptOriginal' },
  { number: 7, label: 'RFP/요청 메일 증빙 (선택)', kinds: ['rfp_request_evidence'], optional: true },
];

function isFileAttachment(value: unknown): value is FileAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const attachment = value as Partial<FileAttachment>;
  return Boolean(String(attachment.path || attachment.downloadURL || '').trim());
}

export function buildMigrationReviewDocumentSlots(record: MigrationAuditConsoleRecord): ReviewDocumentSlot[] {
  const payload = record.request ? resolveProjectRequestPayload(record.request) : record.project;
  const requestNotes = payload?.registrationOptionalDocumentNotes;
  const notes: Partial<ProjectRegistrationOptionalDocumentNotes> = requestNotes || {};
  const quoteSubmissionDeferred = payload?.quoteSubmissionDeferred;
  const confirmations = payload?.registrationConfirmations;
  const documentByKind = new Map<ProjectRequestDocumentKind, ReviewDocumentEntry>();

  REVIEW_DOCUMENT_DEFINITIONS.forEach((definition) => {
    const document = payload?.[definition.field];
    if (!isFileAttachment(document)) return;
    documentByKind.set(definition.kind, { ...definition, document });
  });

  if (record.request && resolveProjectRequestKind(record.request) === 'CLOSURE') {
    const kinds: ProjectRequestDocumentKind[] = ['final_report', 'tax_invoice', 'performance_certificate', 'final_settlement_report'];
    return kinds.map((kind, index) => ({
      number: index + 1, label: PROJECT_DOCUMENTS.find((document) => document.documentKind === kind)!.label,
      kinds: [kind], optional: index > 0, entries: documentByKind.has(kind) ? [documentByKind.get(kind)!] : [],
      note: '', link: '', conflict: false,
    }));
  }

  const representedKinds = new Set(REVIEW_DOCUMENT_SLOTS.flatMap((slot) => slot.kinds));
  const extraSlots = REVIEW_DOCUMENT_DEFINITIONS
    .filter(({ kind }) => !representedKinds.has(kind) && documentByKind.has(kind))
    .map(({ kind, label }, index) => ({ number: REVIEW_DOCUMENT_SLOTS.length + index + 1, label, kinds: [kind], optional: true }));
  return [...REVIEW_DOCUMENT_SLOTS, ...extraSlots].map((slot: ReviewDocumentSlotDefinition) => {
    const entries = slot.kinds.flatMap((kind) => {
      const entry = documentByKind.get(kind);
      return entry ? [entry] : [];
    });
    return {
      ...slot,
      entries,
      link: slot.number === 5
        ? String(confirmations?.proposalPptOriginal || '').trim()
        : slot.number === 6 ? String(confirmations?.presentationPptOriginal || '').trim() : '',
      note: slot.number === 3 && quoteSubmissionDeferred
        ? '이후 제출 예정'
        : slot.noteField ? String(notes[slot.noteField] || '').trim() : '',
      conflict: false,
    };
  });
}

function formatDateTime(value?: string) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10).replace(/-/g, '.');
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function formatMoney(value?: number) {
  return Number.isFinite(value) ? `${Number(value).toLocaleString('ko-KR')}원` : '-';
}

function ApprovalSeal({ name, state }: { name: string; state: 'submitted' | 'approved' | 'rejected' }) {
  const tone = state === 'approved'
    ? 'border-[#174a7c] text-[#174a7c]'
    : state === 'rejected'
      ? 'border-[#b42318] text-[#b42318]'
      : 'border-slate-500 text-slate-700';
  return <div className={`grid h-12 w-12 place-items-center rounded-full border-2 bg-white text-center text-[10px] font-semibold leading-3 ${tone}`}>{name || '-'}</div>;
}

function DocumentCell({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div className={`grid min-h-11 grid-cols-[112px_minmax(0,1fr)] border-b border-slate-300 last:border-b-0 ${className}`}>
      <dt className="flex items-center border-r border-slate-300 bg-slate-50 px-3 text-[11px] font-semibold text-slate-700">{label}</dt>
      <dd className="flex items-center break-words px-3 py-2 text-[12px] leading-5 text-slate-900">{value || '-'}</dd>
    </div>
  );
}

function ReviewMessage({ label, by, at, message }: { label: string; by: string; at: string; message: string }) {
  return (
    <div className="grid border-b border-slate-300 last:border-b-0 md:grid-cols-[150px_150px_minmax(0,1fr)]">
      <div className="bg-slate-50 px-3 py-3 font-semibold text-slate-700">{label}</div>
      <div className="border-y border-slate-300 px-3 py-3 text-slate-600 md:border-y-0 md:border-r">{by} · {at}</div>
      <p className="whitespace-pre-wrap break-words px-3 py-3 leading-5 text-slate-900">{message}</p>
    </div>
  );
}

/** 예 / 아니오 / 미입력. 결재 문서에서 빈칸과 "아니오" 는 뜻이 다르므로 뭉개지 않는다. */
function formatConfirmation(value: boolean | null | undefined): string {
  if (value === true) return '예';
  if (value === false) return '아니오';
  return '미입력';
}

export function MigrationAuditDocumentDialog({
  open,
  record,
  acting,
  canFinalize,
  documentPreviewUrls = {},
  documentPreviewStates = {},
  reviewStage = 'executive',
  onLoadDocumentPreview,
  onOpenChange,
  onApprove,
  onReject,
}: MigrationAuditDocumentDialogProps) {
  const documentSlots = useMemo(
    () => record ? buildMigrationReviewDocumentSlots(record) : [],
    [record],
  );
  const documentEntries = useMemo(
    () => documentSlots.flatMap((slot) => slot.entries),
    [documentSlots],
  );
  const [selectedDocumentKind, setSelectedDocumentKind] = useState<ProjectRequestDocumentKind>('contract');

  useEffect(() => {
    if (!open) return;
    const preferredKind = documentEntries.some((entry) => entry.kind === 'contract')
      ? 'contract'
      : documentEntries[0]?.kind;
    if (preferredKind) setSelectedDocumentKind(preferredKind);
  }, [documentEntries, open, record?.id]);

  if (!record) return null;

  const isClosure = record.request?.requestKind === 'CLOSURE';

  const dossier = buildMigrationReviewDossier(record.project, record.request);
  const reviewPayload = record.request ? resolveProjectRequestPayload(record.request) : record.project;
  const totalActualCost = reviewPayload?.totalActualCost;
  const financialYears = reviewPayload?.financialYears;
  const interestRefundPolicy = reviewPayload?.interestRefundPolicy;
  const registrationNote = reviewPayload?.note;
  const confirmations = reviewPayload?.registrationConfirmations;
  const checkout = reviewPayload?.checkout;
  const checkoutVisible = isClosure || record.project.status === 'COMPLETED' || record.project.status === 'COMPLETED_PENDING_PAYMENT';
  const quoteDocument = reviewPayload?.quoteDocument;
  const quoteSubmissionDeferred = reviewPayload?.quoteSubmissionDeferred;
  const designatedApproverName = reviewPayload?.executiveApproverName || '';
  const isManagementPlanning = reviewStage === 'managementPlanning';
  const isUnapprovedChange = isClosure || (resolveProjectRequestKind(record.request) === 'CHANGE' && (record.request?.status === 'PENDING' || record.request?.status === 'REJECTED'));
  const organizationReviewStatus = isUnapprovedChange ? record.status : record.project.executiveReviewStatus;
  const organizationDecisionState = organizationReviewStatus === 'APPROVED'
    ? 'approved'
    : organizationReviewStatus === 'REVISION_REJECTED' || organizationReviewStatus === 'DUPLICATE_DISCARDED'
      ? 'rejected'
      : null;
  const latestOrganizationDecision = organizationDecisionState && !isUnapprovedChange
    ? [...(record.project.executiveReviewHistory || [])].reverse().find((entry) => entry.status === organizationReviewStatus)
    : undefined;
  const organizationReviewedByName = isUnapprovedChange ? record.request?.reviewedByName || '' : latestOrganizationDecision?.reviewedByName || record.project.executiveReviewedByName || '';
  const organizationReviewedAt = isUnapprovedChange ? record.request?.reviewedAt || '' : latestOrganizationDecision?.reviewedAt || record.project.executiveReviewedAt || '';
  const managementReview = getManagementPlanningReview(record.project);
  const managementDecisionState = managementReview.status === 'AGREED'
    ? 'approved'
    : managementReview.status === 'REVISION_REJECTED'
      ? 'rejected'
      : null;
  const latestManagementDecision = managementDecisionState
    ? [...managementReview.history].reverse().find((entry) => entry.status === managementReview.status)
    : undefined;
  const managementReviewedByName = latestManagementDecision?.reviewedByName || managementReview.reviewedByName;
  const managementReviewedAt = latestManagementDecision?.reviewedAt || managementReview.reviewedAt;
  const selectedDocument = documentEntries.find((entry) => entry.kind === selectedDocumentKind) || null;
  const selectedPreviewUrl = selectedDocument
    ? documentPreviewUrls[selectedDocument.kind] || selectedDocument.document.downloadURL || ''
    : '';
  const selectedPreviewState = selectedDocument ? documentPreviewStates[selectedDocument.kind] : undefined;
  const reviewMessages = dossier.audit.history.filter((entry) => entry.reviewComment !== '-' && entry.reviewComment !== 'PM 신규 등록');
  const managementMessages = managementReview.history.filter((entry) => Boolean(entry.reviewComment?.trim()));
  const requestReviewComment = String(record.request?.reviewComment || '').trim();
  const hasDistinctRequestReviewComment = Boolean(
    requestReviewComment
    && requestReviewComment !== 'PM 신규 등록'
    && ![...reviewMessages, ...managementMessages].some((entry) => String(entry.reviewComment || '').trim() === requestReviewComment),
  );
  const isActionPending = isManagementPlanning
    ? organizationReviewStatus === 'APPROVED' && managementReview.status === 'PENDING'
    : record.status === 'PENDING';
  const documentStatus = isManagementPlanning
    ? getManagementPlanningReviewLabel(managementReview.status)
    : getMigrationAuditStatusLabel(record.status);
  const attachmentRepairRequired = record.request?.attachmentReviewStatus === 'REPAIR_REQUIRED';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-[1180px] overflow-y-auto rounded-none border border-slate-500 bg-slate-100 p-5 shadow-2xl sm:max-w-[1180px]">
        <DialogHeader className="sr-only"><DialogTitle>{isClosure ? '사업 종료 승인서' : '프로젝트 등록 및 승인서'}</DialogTitle><DialogDescription>제출된 프로젝트 요청과 증빙을 확인합니다.</DialogDescription></DialogHeader>
        <article className="mx-auto w-full max-w-[1020px] border border-slate-400 bg-white px-8 py-9 text-slate-900" data-testid="migration-review-document">
          <header className="border-b-2 border-slate-700 pb-5">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_410px]">
              <div className="flex min-h-[138px] flex-col justify-center">
                <p className="text-[11px] font-semibold tracking-[0.12em] text-slate-500">MYSCube · {isClosure ? 'PROJECT CLOSURE' : 'PROJECT REGISTRATION'}</p>
                <h2 className="mt-3 text-center text-[25px] font-bold tracking-[0.08em]">{isClosure ? '사업 종료 승인서' : '프로젝트 등록 및 승인서'}</h2>
              </div>
              {isClosure ? <div className="border border-slate-400 p-4 text-sm"><p>조직장 승인·합의</p><p className="mt-2">{organizationDecisionState ? `${organizationReviewedByName} · ${formatDateTime(organizationReviewedAt)}` : `${designatedApproverName || '지정 조직장'} · 검토 대기`}</p><p className="mt-2 text-xs text-slate-500">승인 즉시 주정산·월결산 업무 대상에서 제외됩니다.</p></div> : <div className="border border-slate-400">
                <div className="grid grid-cols-[48px_repeat(3,minmax(0,1fr))]">
                  <div className="flex items-center justify-center border-r border-b border-slate-400 bg-slate-50 text-[11px] font-semibold">결재</div>
                  <div className="border-r border-b border-slate-400 px-2 py-1.5 text-center text-[11px] font-semibold">기안</div>
                  <div className="border-r border-b border-slate-400 px-2 py-1.5 text-center text-[11px] font-semibold">조직장 승인</div>
                  <div className="border-b border-slate-400 px-2 py-1.5 text-center text-[11px] font-semibold">경영기획실 합의</div>
                  <div className="flex items-center justify-center border-r border-b border-slate-400 bg-slate-50 text-[10px] text-slate-600">인</div>
                  <div className="flex min-h-[70px] items-center justify-center border-r border-b border-slate-400 px-2 py-2"><ApprovalSeal name={dossier.audit.requestedByName} state="submitted" /></div>
                  <div className="flex min-h-[70px] items-center justify-center border-r border-b border-slate-400 px-2 py-2">
                    {organizationDecisionState ? <ApprovalSeal name={organizationReviewedByName || '미상'} state={organizationDecisionState} /> : <span data-testid="organization-head-approval-pending" className="text-center"><span className="block text-[11px] font-medium text-slate-800">{designatedApproverName || '결재자 미지정'}</span><span className="mt-1 block text-[10px] text-slate-500">검토 대기</span></span>}
                  </div>
                  <div className="flex min-h-[70px] items-center justify-center border-b border-slate-400 px-2 py-2">
                    {managementDecisionState ? <ApprovalSeal name={managementReviewedByName || '미상'} state={managementDecisionState} /> : <span data-testid="management-planning-approval-pending" aria-label="경영기획실 합의 대기" className="text-[10px] text-slate-500">합의 대기</span>}
                  </div>
                  <div className="flex items-center justify-center border-r border-t border-slate-400 bg-slate-50 text-[10px] text-slate-600">일자</div>
                  <div className="border-r border-t border-slate-400 px-2 py-2 text-center text-[10px] text-slate-700">{formatDateTime(record.requestedAt)}</div>
                  <div className="border-r border-t border-slate-400 px-2 py-2 text-center text-[10px] text-slate-700">{organizationReviewedAt ? formatDateTime(organizationReviewedAt) : '검토 대기'}</div>
                  <div className="border-t border-slate-400 px-2 py-2 text-center text-[10px] text-slate-700">{managementReviewedAt ? formatDateTime(managementReviewedAt) : '합의 대기'}</div>
                </div>
              </div>}
            </div>
          </header>
          {isClosure && record.request?.closureSubmission ? <section className="mt-6">
            <h3 className="border-b-2 border-slate-700 pb-2 text-[14px] font-bold">종료 신청 및 보관</h3>
            <div className="border border-slate-400">
              <DocumentCell label="보관 기산일" value={record.request.closureSubmission.retentionStartDate} />
              <DocumentCell label="보관 기간" value={`${record.request.closureSubmission.retentionPeriodYears}년`} />
              <DocumentCell label="인계·보관 위치" value={record.request.closureSubmission.handoverNote || '미입력'} />
              <DocumentCell label="Drive 링크" value={record.request.closureSubmission.driveFolderLink || '미등록'} />
              <DocumentCell label="Drive 정리일" value={record.request.closureSubmission.driveDeletedAt || '미기록'} />
              <DocumentCell label="기타 메모" value={record.request.closureSubmission.note || '없음'} />
            </div>
            <ProjectClosureDriveContents projectId={record.project.id} link={record.request.closureSubmission.driveFolderLink} />
          </section> : null}

          <section className="mt-5">
            <h3 className="border-b-2 border-slate-700 pb-2 text-[14px] font-bold">의견 및 처리 이력</h3>
            <div className="border border-t-0 border-slate-400 text-[12px]">
              {dossier.audit.requestSummary !== '-' ? <ReviewMessage label="요청 요약" by={dossier.audit.requestedByName} at={dossier.audit.requestedAt} message={dossier.audit.requestSummary} /> : null}
              {hasDistinctRequestReviewComment ? <ReviewMessage label="실무자 제출/재제출 메모" by={record.request?.requestedByName || dossier.audit.requestedByName} at={record.request?.requestedAt || dossier.audit.requestUpdatedAt} message={requestReviewComment} /> : null}
              {reviewMessages.map((entry, index) => <ReviewMessage key={`${entry.status}-${entry.reviewedAt}-${index}`} label={entry.status === 'PENDING' ? '실무자 제출/재제출 메모' : entry.status === 'APPROVED' ? '조직장 승인 메모' : entry.status === 'REVISION_REJECTED' ? '조직장 반려 메모' : '조직장 폐기 메모'} by={entry.reviewedByName} at={entry.reviewedAt} message={entry.reviewComment} />)}
              {managementMessages.map((entry, index) => <ReviewMessage key={`management-${entry.status}-${entry.reviewedAt}-${index}`} label={entry.status === 'AGREED' ? '경영기획실 합의 메모' : '경영기획실 반려 메모'} by={entry.reviewedByName} at={formatDateTime(entry.reviewedAt)} message={String(entry.reviewComment || '-')} />)}
              {dossier.audit.requestSummary === '-' && !hasDistinctRequestReviewComment && reviewMessages.length === 0 && managementMessages.length === 0 ? <p className="px-3 py-4 text-slate-500">등록된 의견 또는 처리 메모가 없습니다.</p> : null}
            </div>
          </section>

          <section className="mt-6 border border-slate-400">
            <DocumentCell label="문서 번호" value={record.request?.id || record.id} />
            <DocumentCell label="작성 일자" value={formatDateTime(record.requestedAt)} />
            <DocumentCell label="기안 부서" value={record.cic} />
            <DocumentCell label="기안자" value={dossier.audit.requestedByName} />
            <DocumentCell label="결재 상태" value={documentStatus} />
          </section>

          <section className="mt-6"><h3 className="border-b-2 border-slate-700 pb-2 text-[14px] font-bold">기본정보</h3><dl className="border border-t-0 border-slate-400">
            <DocumentCell label="프로젝트명" value={dossier.headerTitle} /><DocumentCell label="공식 계약명" value={dossier.identity.officialContractName} /><DocumentCell label="계약 대상" value={dossier.identity.clientOrg} /><DocumentCell label="담당조직(CIC)" value={dossier.identity.cic} /><DocumentCell label="최종 보고자 (실무책임자)" value={dossier.identity.pmName} /><DocumentCell label="프로젝트 코드" value={managementReview.projectCode || '부여 대기'} /><DocumentCell label="담당 부서" value={dossier.identity.department} /><DocumentCell label="프로젝트 유형" value={dossier.contract.projectTypeLabel} />
          </dl></section>
          <section className="mt-6"><h3 className="border-b-2 border-slate-700 pb-2 text-[14px] font-bold">계약/재무</h3><dl className="grid border border-t-0 border-slate-400 md:grid-cols-2">
            <DocumentCell label="계약 기간" value={dossier.contract.periodLabel} className="md:border-r md:border-slate-400" /><DocumentCell label="정산 유형" value={dossier.contract.settlementTypeLabel} />
            <DocumentCell label="계약서 유형" value={dossier.contract.contractType} className="md:border-r md:border-slate-400" /><DocumentCell label="계약 체결 방식" value={confirmations?.modusignContractUsed === true ? '모두싸인' : confirmations?.modusignContractUsed === false ? `서면 계약${confirmations?.originalContractSubmitted === true ? ' · 원본 제출' : ''}` : '미입력'} />
            <DocumentCell label="정산 기준" value={dossier.contract.basisLabel} className="md:border-r md:border-slate-400" /><DocumentCell label="통장 유형" value={dossier.contract.accountTypeLabel} />
            <DocumentCell label="사업비 입력 방식" value={dossier.contract.fundInputModeLabel} className="md:border-r md:border-slate-400" /><DocumentCell label="통화" value={dossier.budget.currencyLabel} />
            <DocumentCell label="계약금액" value={dossier.budget.contractAmountLabel} className="md:border-r md:border-slate-400" /><DocumentCell label="총매출부가세" value={dossier.budget.salesVatAmountLabel} />
            <DocumentCell label="총수익" value={dossier.budget.totalRevenueAmountLabel} className="md:border-r md:border-slate-400" /><DocumentCell label="총실비(원가)" value={formatMoney(totalActualCost)} />
            <DocumentCell label="총지원금" value={dossier.budget.supportAmountLabel} className="md:border-r md:border-slate-400" /><DocumentCell label="정산 시스템" value={dossier.contract.settlementSystemLabel} />
            <DocumentCell label="인건비 정산 기준" value={dossier.contract.laborSettlementBasisLabel} className="md:border-r md:border-slate-400" /><DocumentCell label="이자 반납 여부" value={interestRefundPolicy ? INTEREST_REFUND_POLICY_LABELS[interestRefundPolicy] : '-'} />
            <DocumentCell label="선금·중도금·잔금" value={dossier.budget.paymentPlanSplitLabel} className="md:col-span-2" />
            {dossier.budget.finalPaymentExpectedWeek ? <DocumentCell label="잔금 입금 예정 주차" value={dossier.budget.finalPaymentExpectedWeek} className="md:col-span-2" /> : null}
            {dossier.budget.advanceInterimBelow70Reason ? <DocumentCell label="선금·중도금 70% 미만 사유" value={dossier.budget.advanceInterimBelow70Reason} className="md:col-span-2" /> : null}
            {dossier.budget.finalPaymentNote !== '-' ? <DocumentCell label="잔금 메모" value={dossier.budget.finalPaymentNote} className="md:col-span-2" /> : null}
            <div className="grid min-h-11 grid-cols-[112px_minmax(0,1fr)] border-b border-slate-300 last:border-b-0 md:col-span-2"><dt className="flex items-center border-r border-slate-300 bg-slate-50 px-3 text-[11px] font-semibold text-slate-700">연도별 계약/재무</dt><dd className="min-w-0 px-3 py-2"><FinancialYearsTable years={financialYears} /></dd></div>
            <DocumentCell label="입금 계획" value={dossier.budget.paymentPlanDesc} className="md:col-span-2" />
            <DocumentCell label="산출내역서(견적서)" value={quoteDocument?.name || (quoteSubmissionDeferred ? '이후 제출 예정' : '-')} className="md:col-span-2" />
          </dl></section>
          {/*
            팀/인력은 dossier 가 늘 담고 있었는데 결재 문서에 그리지 않아, 누가 투입되는지
            모르는 채로 결재가 이뤄졌다. 판단에 필요한 값은 빠짐없이 문서에 남긴다.
          */}
          <section className="mt-6"><h3 className="border-b-2 border-slate-700 pb-2 text-[14px] font-bold">팀/인력</h3><dl className="border border-t-0 border-slate-400">
            {dossier.people.teamName !== '-' ? <DocumentCell label="팀 이름" value={dossier.people.teamName} /> : null}
            <DocumentCell label="실제 투입인력" value={dossier.people.staffingSummary} />
            {/* 서류상 명단의 원천은 참여율 시트다. 문서에는 요약과 원천 링크만 남기고 시트에서 대조하게 한다. */}
            <div className="grid min-h-11 grid-cols-[112px_minmax(0,1fr)] border-b border-slate-300 last:border-b-0">
              <dt className="flex items-center border-r border-slate-300 bg-slate-50 px-3 text-[11px] font-semibold text-slate-700">서류상 참여인력</dt>
              <dd className="px-3 py-2 text-[12px] leading-5 text-slate-900">
                {dossier.people.members.length > 0 ? `${dossier.people.members.length}명 등록됨 · ` : ''}
                월별 참여율 원본은 참여율 시트에서 확인해 주세요.
                {dossier.people.participationSheetLink ? (
                  <>
                    {' '}
                    <a className="break-all text-blue-700 underline" href={dossier.people.participationSheetLink} target="_blank" rel="noreferrer">참여율 시트 열기</a>
                  </>
                ) : ' (참여율 시트 링크 미등록)'}
              </dd>
            </div>
          </dl></section>

          {/* 종료사업 체크아웃. 종료 단계 사업만 뜻이 있으므로 그때만 그린다. */}
          {checkoutVisible ? (
            <section className="mt-6"><h3 className="border-b-2 border-slate-700 pb-2 text-[14px] font-bold">종료사업 체크아웃</h3><dl className="grid border border-t-0 border-slate-400 md:grid-cols-2">
              <DocumentCell label="잔금 입금 완료" value={formatConfirmation(checkout?.finalPaymentReceived)} className="md:border-r md:border-slate-400" />
              <DocumentCell label="사업비 통장 0원" value={formatConfirmation(checkout?.bankBalanceZero)} />
              <DocumentCell label="실적증명서 원본 제출" value={formatConfirmation(checkout?.performanceCertificateReceived)} className="md:border-r md:border-slate-400" />
              <DocumentCell label="세금계산서 증빙 확인" value={formatConfirmation(checkout?.taxInvoiceEvidenceConfirmed)} />
              <DocumentCell label="최종 정산리포트 확인" value={formatConfirmation(checkout?.finalSettlementReportConfirmed)} className="md:border-r md:border-slate-400" />
              <DocumentCell label="USB 재경팀 제출" value={formatConfirmation(checkout?.usbEvidenceSubmitted)} />
              <DocumentCell label="Google Drive 정산자료 수동 삭제" value={formatConfirmation(checkout?.evidenceDeletedAfterUsb)} className="md:col-span-2" />
            </dl></section>
          ) : null}
          <section className="mt-6"><h3 className="border-b-2 border-slate-700 pb-2 text-[14px] font-bold">등록 내용</h3><dl className="border border-t-0 border-slate-400">
            <DocumentCell label="프로젝트 목적" value={dossier.notes.projectPurpose} /><DocumentCell label="상세 설명" value={dossier.notes.description} /><DocumentCell label="참여 조건" value={dossier.notes.participantCondition} /><DocumentCell label="등록 메모" value={registrationNote || '-'} />
          </dl></section>
          <section className="mt-6">
            <h3 className="border-b-2 border-slate-700 pb-2 text-[14px] font-bold">{isClosure ? '종료 제출서류 4종' : '등록 제출서류 7종'}</h3>
            <div className="border border-t-0 border-slate-400" data-testid="migration-review-document-slots">
              <div className="hidden grid-cols-[48px_220px_minmax(0,1fr)_108px] border-b border-slate-400 bg-slate-100 text-[11px] font-semibold text-slate-700 md:grid">
                <div className="border-r border-slate-400 px-2 py-2 text-center">번호</div>
                <div className="border-r border-slate-400 px-3 py-2">구분</div>
                <div className="border-r border-slate-400 px-3 py-2">제출 파일 / 미첨부 사유</div>
                <div className="px-3 py-2 text-center">원문</div>
              </div>
              {documentSlots.map((slot) => (
                <div
                  key={slot.number}
                  className="grid border-b border-slate-300 last:border-b-0 md:grid-cols-[48px_220px_minmax(0,1fr)_108px]"
                  data-testid={`migration-review-document-slot-${slot.number}`}
                >
                  <div className="flex items-center justify-center border-b border-slate-300 bg-slate-50 px-2 py-3 text-[11px] font-semibold text-slate-800 md:border-r md:border-b-0 md:border-slate-400">
                    {slot.number}
                  </div>
                  <div className="flex items-center border-b border-slate-300 px-3 py-3 text-[11px] font-semibold leading-5 text-slate-800 md:border-r md:border-b-0 md:border-slate-400">
                    {slot.label}
                  </div>
                  <div className="min-w-0 border-b border-slate-300 px-3 py-3 text-[12px] leading-5 text-slate-800 md:border-r md:border-b-0 md:border-slate-400">
                    {slot.entries.length > 0 ? (
                      <div className="space-y-2">
                        {slot.entries.map((entry) => {
                          const state = documentPreviewStates[entry.kind];
                          return (
                            <div key={entry.kind} data-document-kind={entry.kind}>
                              <p className="break-all font-medium">{entry.document.name || entry.label}</p>
                              {slot.entries.length > 1 ? <p className="text-[10px] text-slate-500">{entry.label}</p> : null}
                              {state?.status === 'error' ? (
                                <p className="mt-1 text-[10px] text-rose-700">{state.error || '원문을 불러오지 못했습니다.'}</p>
                              ) : null}
                            </div>
                          );
                        })}
                        {slot.conflict ? (
                          <p className="border-t border-amber-300 pt-2 text-[10px] font-semibold text-amber-800">
                            제출 규칙 불일치 · 제안서와 RFP/요청 증빙이 함께 등록되었습니다. 두 원문을 모두 확인해 주세요.
                          </p>
                        ) : null}
                      </div>
                    ) : slot.link ? (
                      <a className="break-all text-blue-700 underline" href={slot.link} target="_blank" rel="noreferrer">{slot.link}</a>
                    ) : slot.note ? (
                      <p><span className="font-semibold text-slate-600">미첨부 사유</span> · {slot.note}</p>
                    ) : slot.optional ? (
                      <p className="text-slate-500">선택 · 미제출</p>
                    ) : (
                      <p className="text-rose-700">미제출</p>
                    )}
                  </div>
                  <div className="flex items-center justify-center px-3 py-3">
                    {slot.entries.length > 0 ? (
                      <div className="flex flex-wrap justify-center gap-1.5">
                        {slot.entries.map((entry) => {
                          const previewUrl = documentPreviewUrls[entry.kind] || entry.document.downloadURL || '';
                          const state = documentPreviewStates[entry.kind];
                          return (
                            <Button
                              key={entry.kind}
                              type="button"
                              variant={selectedDocumentKind === entry.kind ? 'default' : 'outline'}
                              size="sm"
                              className="h-8 rounded-none px-2.5 text-[11px]"
                              disabled={state?.status === 'loading'}
                              onClick={() => {
                                setSelectedDocumentKind(entry.kind);
                                if (!previewUrl) void onLoadDocumentPreview?.(entry.kind);
                              }}
                            >
                              {state?.status === 'loading' ? '불러오는 중' : state?.status === 'error' ? '다시 열기' : '원문 보기'}
                            </Button>
                          );
                        })}
                      </div>
                    ) : (
                      <span className="text-[10px] text-slate-400">해당 없음</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {selectedDocument ? (
              <ContractDocumentPreview
                document={{ ...selectedDocument.document, downloadURL: selectedPreviewUrl }}
                title={`${selectedDocument.label} 원문`}
                description={selectedPreviewState?.status === 'loading'
                  ? '제출 원문을 안전하게 불러오는 중입니다.'
                  : selectedPreviewState?.status === 'error'
                    ? (selectedPreviewState.error || '원문을 불러오지 못했습니다. 다시 열기를 시도해 주세요.')
                    : 'PDF 미리보기가 비어 있으면 새 탭에서 원문을 확인하고, Word·PPT·메일 원본도 새 탭에서 내려받아 대조합니다.'}
                descriptionClassName={selectedPreviewState?.status === 'error' ? 'text-rose-700' : 'text-slate-600'}
                className="rounded-none border-t-0 border-slate-400"
                privateDraftAttachment={!selectedPreviewUrl}
                previewState={selectedPreviewState}
                onLoadPreview={onLoadDocumentPreview ? () => onLoadDocumentPreview(selectedDocument.kind) : undefined}
              />
            ) : (
              <div className="border border-t-0 border-slate-400 bg-slate-50 px-4 py-8 text-center text-[12px] text-slate-500">
                검토할 수 있는 제출 원문이 없습니다.
              </div>
            )}
          </section>

          {attachmentRepairRequired ? <p role="alert" className="mt-5 border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">제출 첨부 파일을 복구해야 승인할 수 있습니다. 담당자에게 첨부 파일 확인을 요청해 주세요.</p> : null}
          {isActionPending && canFinalize ? <footer className="mt-7 flex justify-end gap-2 border-t border-slate-300 pt-4"><Button type="button" variant="outline" className="rounded-none border-slate-500" onClick={onReject} disabled={acting}>반려</Button><Button type="button" className="rounded-none bg-[#174a7c] hover:bg-[#103a63]" onClick={onApprove} disabled={acting || attachmentRepairRequired}>{isManagementPlanning ? '합의' : '승인'}</Button></footer> : null}
          {isActionPending && !canFinalize ? <p className="mt-7 border-t border-slate-300 pt-4 text-right text-[11px] text-slate-500">{isManagementPlanning ? '경영기획실 담당자만 합의 또는 반려할 수 있습니다.' : '지정된 조직장만 승인 또는 반려할 수 있습니다.'}</p> : null}
        </article>
      </DialogContent>
    </Dialog>
  );
}
