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
