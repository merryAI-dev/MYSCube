import { describe, expect, it } from 'vitest';
import type { MigrationAuditConsoleRecord } from '../../../platform/project-migration-console';
import { buildMigrationReviewDocumentSlots } from './MigrationAuditDocumentDialog';

describe('submitted review attachments', () => {
  it('preserves seven base slots and exposes every additional submitted document', () => {
    const record = {
      project: { finalReportDocument: { path: 'project/old-report', name: 'old-report.pdf' } },
      request: {
        requestKind: 'REGISTRATION',
        payload: {
          proposalDocument: { path: 'request/proposal', name: 'proposal.pdf' },
          performanceCertificateDocument: { path: 'request/certificate', name: 'certificate.pdf' },
          taxInvoiceDocument: { path: 'request/tax', name: 'tax.pdf' },
          finalSettlementReportDocument: { path: 'request/settlement', name: 'settlement.pdf' },
          finalReportDocument: { path: 'request/report', name: 'report.pdf' },
        },
      },
    } as unknown as MigrationAuditConsoleRecord;
    const slots = buildMigrationReviewDocumentSlots(record);
    expect(slots).toHaveLength(12);
    expect(slots.slice(0, 7).map((slot) => slot.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(slots.slice(7).flatMap((slot) => slot.entries.map((entry) => entry.kind))).toEqual([
      'proposal', 'performance_certificate', 'tax_invoice', 'final_settlement_report', 'final_report',
    ]);
    expect(slots.at(-1)?.entries[0].document.path).toBe('request/report');
  });

  it('keeps an uploaded proposal and its submitted Drive link together', () => {
    const record = {
      project: { taxInvoiceDocument: { path: 'project/tax' } },
      request: {
        requestKind: 'REGISTRATION',
        payload: {
          proposalPptOriginalDocument: { path: 'request/slides', name: 'slides.pptx' },
          registrationConfirmations: { proposalPptOriginal: 'https://drive.google.com/file/d/submitted/view' },
        },
      },
    } as unknown as MigrationAuditConsoleRecord;
    const slots = buildMigrationReviewDocumentSlots(record);
    expect(slots).toHaveLength(7);
    expect(slots[4].entries[0].document.name).toBe('slides.pptx');
    expect(slots[4].link).toBe('https://drive.google.com/file/d/submitted/view');
    expect(slots.flatMap((slot) => slot.entries).some((entry) => entry.kind === 'tax_invoice')).toBe(false);
  });
});

describe('submission evidence states', () => {
  const slots = (payload: Record<string, unknown>) => buildMigrationReviewDocumentSlots({
    project: { contractDocument: { path: 'later/file.pdf' } },
    request: { requestKind: 'REGISTRATION', payload },
  } as unknown as MigrationAuditConsoleRecord);

  it('distinguishes an unrecorded field from an explicitly empty field without consulting the later project', () => {
    expect(slots({})[0]).toMatchObject({ submissionState: 'UNRECORDED', submissionLabel: '기록 없음' });
    expect(slots({ contractDocument: null })[0]).toMatchObject({ submissionState: 'EMPTY', submissionLabel: '미입력' });
  });

  it('recognizes a submitted link and a recorded empty link separately', () => {
    expect(slots({ registrationConfirmations: { presentationPptOriginal: 'https://docs.google.com/presentation/d/submitted/edit' } })[5])
      .toMatchObject({ submissionState: 'SUBMITTED', submissionLabel: '제출됨' });
    expect(slots({ registrationConfirmations: { presentationPptOriginal: '' } })[5])
      .toMatchObject({ submissionState: 'EMPTY', submissionLabel: '미입력' });
  });

  it('preserves explicit absence, deferred quote and historical reasons as distinct responses', () => {
    expect(slots({ registrationOptionalDocumentNotes: { rfpRequestEvidence: '해당 없음' } })[6])
      .toMatchObject({ submissionState: 'NOT_APPLICABLE', submissionLabel: '해당 없음' });
    expect(slots({ quoteSubmissionDeferred: true })[2]).toMatchObject({ submissionState: 'DEFERRED' });
    expect(slots({ registrationOptionalDocumentNotes: { proposalWordOriginal: '고객사에게 원본을 받지 못했습니다' } })[3])
      .toMatchObject({ submissionState: 'EXPLAINED', note: '고객사에게 원본을 받지 못했습니다' });
  });

  it('keeps original evidence visible when an older response also says not applicable', () => {
    expect(slots({ proposalWordOriginalDocument: { path: 'submitted/proposal.docx' }, registrationOptionalDocumentNotes: { proposalWordOriginal: '해당 없음' } })[3])
      .toMatchObject({ submissionState: 'SUBMITTED', conflict: true });
  });
});
