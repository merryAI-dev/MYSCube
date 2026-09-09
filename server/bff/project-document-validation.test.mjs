import { describe, expect, it } from 'vitest';
import {
  missingProjectRegistrationRequiredDocumentKind,
  projectDocumentValidationError,
  assertProjectDocumentOriginals,
  PROJECT_DOCUMENT_FIELD_BY_KIND,
} from './project-document-validation.mjs';
import { projectInfoDraftAttachmentSchema, projectRegistrationDraftAttachmentSchema } from './schemas.mjs';

const pdf = Buffer.from('%PDF-1.7\n');
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
const msg = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);

describe('project document validation', () => {
  it.each(Object.values(PROJECT_DOCUMENT_FIELD_BY_KIND))('compares original %s against current attachments, independent of version', field => {
    const old = { path: 'old.pdf', name: 'old' };
    const repaired = { path: 'repaired.pdf', name: 'repaired' };
    for (const next of [null, { path: 'replacement.pdf' }]) {
      expect(() => assertProjectDocumentOriginals({ [field]: old }, { [field]: next }, { [field]: old })).not.toThrow();
      expect(() => assertProjectDocumentOriginals({ [field]: repaired }, { [field]: next }, { [field]: old })).toThrow();
      expect(() => assertProjectDocumentOriginals({ [field]: old }, { [field]: next })).toThrow();
    }
    expect(() => assertProjectDocumentOriginals({}, { [field]: repaired }, { [field]: null })).not.toThrow();
    expect(() => assertProjectDocumentOriginals({ [field]: repaired }, { [field]: { ...repaired } })).not.toThrow();
    expect(assertProjectDocumentOriginals({ [field]: repaired }, { [field]: { ...repaired } })).toEqual({});
    expect(assertProjectDocumentOriginals({ [field]: old }, { [field]: repaired }, { [field]: old })).toEqual({ [field]: repaired });
    expect(() => assertProjectDocumentOriginals({ [field]: repaired }, { status: 'COMPLETED' })).not.toThrow();
  });
  it.each(['performance_certificate', 'tax_invoice', 'final_settlement_report', 'final_report'])('keeps %s exclusive to the edit attachment schema', (documentKind) => {
    const input = { expectedDraftRevision: 0, documentKind, fileName: 'report.pdf', mimeType: 'application/pdf', fileSize: 1, contentBase64: 'YQ==' };
    expect(projectInfoDraftAttachmentSchema.safeParse(input).success).toBe(true);
    expect(projectRegistrationDraftAttachmentSchema.safeParse(input).success).toBe(false);
  });

  it('requires only slots 1 to 3 and accepts a deferred quote', () => {
    const refs = (kinds) => kinds.map((documentKind) => ({ documentKind }));

    expect(missingProjectRegistrationRequiredDocumentKind(refs(['contract', 'customer_business_registration', 'quote']))).toBe('');
    expect(missingProjectRegistrationRequiredDocumentKind(refs(['contract', 'customer_business_registration']))).toBe('quote');
    expect(missingProjectRegistrationRequiredDocumentKind(
      refs(['contract', 'customer_business_registration']),
      { quoteSubmissionDeferred: true },
    )).toBe('');
  });

  it('enforces each registration slot extension, MIME, and signature contract', () => {
    expect(projectDocumentValidationError({
      buffer: pdf, mimeType: 'application/pdf', fileName: 'contract.pdf', documentKind: 'contract',
    })).toBe('');
    expect(projectDocumentValidationError({
      buffer: zip,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: 'proposal.docx',
      documentKind: 'proposal_word_original',
    })).toBe('');
    expect(projectDocumentValidationError({
      buffer: zip,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      fileName: 'presentation.pptx',
      documentKind: 'presentation_ppt_original',
    })).toBe('');
    expect(projectDocumentValidationError({
      buffer: Buffer.from('From: buyer@example.com\r\nTo: pm@example.com\r\nSubject: Request\r\n\r\nBody'),
      mimeType: 'message/rfc822',
      fileName: 'request.eml',
      documentKind: 'rfp_request_evidence',
    })).toBe('');
    expect(projectDocumentValidationError({
      buffer: msg,
      mimeType: 'application/vnd.ms-outlook',
      fileName: 'request.msg',
      documentKind: 'rfp_request_evidence',
    })).toBe('');
    expect(projectDocumentValidationError({
      buffer: zip, mimeType: 'application/pdf', fileName: 'request.pdf', documentKind: 'rfp_request_evidence',
    })).not.toBe('');
  });
});
