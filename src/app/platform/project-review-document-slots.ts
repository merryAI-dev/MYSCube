import type { FileAttachment, ProjectRegistrationOptionalDocumentNotes } from '../data/types';
import type { MigrationAuditConsoleRecord } from './project-migration-console';
import { resolveProjectRequestPayload } from './project-change-request';
import type { ProjectRequestDocumentKind } from './project-contract-upload';

type ReviewDocumentField =
  | 'contractDocument'
  | 'customerBusinessRegistrationDocument'
  | 'quoteDocument'
  | 'proposalDocument'
  | 'rfpRequestEvidenceDocument'
  | 'proposalWordOriginalDocument'
  | 'proposalPptOriginalDocument'
  | 'presentationPptOriginalDocument'
  | 'performanceCertificateDocument'
  | 'taxInvoiceDocument'
  | 'finalSettlementReportDocument'
  | 'finalReportDocument';

type ReviewDocumentDefinition = {
  kind: ProjectRequestDocumentKind;
  field: ReviewDocumentField;
  label: string;
};

type ReviewDocumentSlotDefinition = {
  number: number;
  label: string;
  kinds: ProjectRequestDocumentKind[];
  noteField?: keyof ProjectRegistrationOptionalDocumentNotes;
};

export type ReviewDocumentEntry = ReviewDocumentDefinition & {
  document: FileAttachment;
};

export type ReviewDocumentSlot = ReviewDocumentSlotDefinition & {
  entries: ReviewDocumentEntry[];
  note: string;
  link: string;
  conflict: boolean;
  submissionState: 'SUBMITTED' | 'NOT_APPLICABLE' | 'DEFERRED' | 'EXPLAINED' | 'EMPTY' | 'UNRECORDED';
  submissionLabel: string;
};

export const REVIEW_DOCUMENT_DEFINITIONS: ReviewDocumentDefinition[] = [
  { kind: 'contract', field: 'contractDocument', label: '계약서 PDF' },
  { kind: 'customer_business_registration', field: 'customerBusinessRegistrationDocument', label: '고객사 사업자등록증 PDF' },
  { kind: 'quote', field: 'quoteDocument', label: '견적서 PDF' },
  { kind: 'proposal', field: 'proposalDocument', label: '제안서 PDF' },
  { kind: 'rfp_request_evidence', field: 'rfpRequestEvidenceDocument', label: 'RFP/요청 메일 증빙' },
  { kind: 'proposal_word_original', field: 'proposalWordOriginalDocument', label: '제안서 파일' },
  { kind: 'proposal_ppt_original', field: 'proposalPptOriginalDocument', label: '제안서 PPT 원본' },
  { kind: 'presentation_ppt_original', field: 'presentationPptOriginalDocument', label: '발표자료 PPT 원본' },
  { kind: 'performance_certificate', field: 'performanceCertificateDocument', label: '수행확인서' },
  { kind: 'tax_invoice', field: 'taxInvoiceDocument', label: '세금계산서' },
  { kind: 'final_settlement_report', field: 'finalSettlementReportDocument', label: '최종 정산보고서' },
  { kind: 'final_report', field: 'finalReportDocument', label: '최종 결과보고서' },
];

const REVIEW_DOCUMENT_SLOTS: ReviewDocumentSlotDefinition[] = [
  { number: 1, label: '계약서 PDF', kinds: ['contract'] },
  { number: 2, label: '고객사 사업자등록증 PDF', kinds: ['customer_business_registration'] },
  { number: 3, label: '산출내역서(견적서) PDF', kinds: ['quote'] },
  { number: 4, label: '제안서 파일', kinds: ['proposal_word_original'], noteField: 'proposalWordOriginal' },
  { number: 5, label: '제안서(구글드라이브 링크)', kinds: ['proposal_ppt_original'], noteField: 'proposalPptOriginal' },
  { number: 6, label: '발표자료(구글드라이브 링크)', kinds: ['presentation_ppt_original'], noteField: 'presentationPptOriginal' },
  { number: 7, label: 'RFP/요청 메일 증빙', kinds: ['rfp_request_evidence'], noteField: 'rfpRequestEvidence' },
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

  const additionalSlots = REVIEW_DOCUMENT_DEFINITIONS
    .filter((definition) => !REVIEW_DOCUMENT_SLOTS.some((slot) => slot.kinds.includes(definition.kind))
      && documentByKind.has(definition.kind))
    .map((definition, index) => ({ number: 8 + index, label: definition.label, kinds: [definition.kind] }));

  return [...REVIEW_DOCUMENT_SLOTS, ...additionalSlots].map((slot: ReviewDocumentSlotDefinition) => {
    const entries = slot.kinds.flatMap((kind) => {
      const entry = documentByKind.get(kind);
      return entry ? [entry] : [];
    });
    const linkField = slot.number === 5 ? 'proposalPptOriginal' : slot.number === 6 ? 'presentationPptOriginal' : null;
    const link = linkField ? String(confirmations?.[linkField] || '').trim() : '';
    const note = slot.number === 3 && quoteSubmissionDeferred
      ? '이후 제출 예정'
      : slot.noteField ? String(notes[slot.noteField] || '').trim() : '';
    const explicitAbsence = note.replace(/\s/g, '') === '해당없음';
    const recorded = REVIEW_DOCUMENT_DEFINITIONS.some((definition) => slot.kinds.includes(definition.kind)
      && Object.hasOwn(payload || {}, definition.field))
      || Boolean(linkField && Object.hasOwn(confirmations || {}, linkField));
    const submissionState: ReviewDocumentSlot['submissionState'] = entries.length || link ? 'SUBMITTED'
      : explicitAbsence ? 'NOT_APPLICABLE'
      : slot.number === 3 && quoteSubmissionDeferred ? 'DEFERRED'
      : note ? 'EXPLAINED'
      : recorded ? 'EMPTY' : 'UNRECORDED';
    const labels: Record<ReviewDocumentSlot['submissionState'], string> = {
      SUBMITTED: '제출됨', NOT_APPLICABLE: '해당 없음', DEFERRED: '이후 제출 예정',
      EXPLAINED: '미첨부 사유 기록됨', EMPTY: '미입력', UNRECORDED: '기록 없음',
    };
    return {
      ...slot,
      entries,
      link,
      note,
      submissionState,
      submissionLabel: labels[submissionState],
      conflict: Boolean((entries.length || link) && explicitAbsence),
    };
  });
}

