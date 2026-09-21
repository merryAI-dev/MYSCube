import { describe, expect, it } from 'vitest';
import { PROJECT_PROPOSAL_FILE_FORMATS } from '../../src/app/platform/project-proposal-file-formats.mjs';
import {
  missingProjectRegistrationRequiredDocumentKind,
  projectDocumentValidationError,
} from './project-document-validation.mjs';

const pdf = Buffer.from('%PDF-1.7\n');
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
const msg = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);

describe('project document validation', () => {
  it.each(PROJECT_PROPOSAL_FILE_FORMATS)('accepts proposal $extension and rejects mismatched headers or MIME', format => {
    const buffer = format.signature === 'pdf' ? pdf : format.signature === 'zip' ? zip : msg;
    const input = { buffer, mimeType: format.mimeType, fileName: `proposal${format.extension.toUpperCase()}`, documentKind: 'proposal_word_original' };
    expect(projectDocumentValidationError(input)).toBe('');
    expect(projectDocumentValidationError({ ...input, buffer: Buffer.from('not a document') })).not.toBe('');
    expect(projectDocumentValidationError({ ...input, mimeType: 'application/octet-stream' })).not.toBe('');
    expect(projectDocumentValidationError({ ...input, fileName: `${input.fileName}.exe` })).not.toBe('');
    for (const mimeType of format.aliases || []) expect(projectDocumentValidationError({ ...input, mimeType })).toBe('');
  });
  it('keeps other slots restricted and rejects unsupported proposal formats', () => {
    for (const documentKind of ['contract', 'quote', 'proposal', 'presentation_ppt_original']) {
      expect(projectDocumentValidationError({ buffer: msg, fileName: 'proposal.hwp', mimeType: 'application/x-hwp', documentKind })).not.toBe('');
    }
    for (const fileName of ['proposal.zip', 'proposal.xlsm', 'proposal.docm', 'proposal.html']) {
      expect(projectDocumentValidationError({ buffer: zip, fileName, mimeType: 'application/zip', documentKind: 'proposal_word_original' })).not.toBe('');
    }
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
