export const PROJECT_REGISTRATION_DOCUMENT_KINDS = Object.freeze([
  'contract',
  'customer_business_registration',
  'quote',
  'proposal',
  'proposal_word_original',
  'proposal_ppt_original',
  'presentation_ppt_original',
  'rfp_request_evidence',
]);

export const PROJECT_REGISTRATION_REQUIRED_DOCUMENT_KINDS = Object.freeze([
  'contract',
  'customer_business_registration',
  'quote',
]);

export function missingProjectRegistrationRequiredDocumentKind(attachmentRefs, { quoteSubmissionDeferred = false } = {}) {
  const attachedKinds = new Set((Array.isArray(attachmentRefs) ? attachmentRefs : [])
    .map((attachment) => String(attachment?.documentKind || '').trim())
    .filter(Boolean));
  return PROJECT_REGISTRATION_REQUIRED_DOCUMENT_KINDS.find((kind) => (
    !attachedKinds.has(kind) && !(kind === 'quote' && quoteSubmissionDeferred === true)
  )) || '';
}

export const PROJECT_INFO_DOCUMENT_KINDS = Object.freeze([
  ...PROJECT_REGISTRATION_DOCUMENT_KINDS,
  'performance_certificate',
  'tax_invoice',
  'final_settlement_report',
  'final_report',
]);

const PDF_ONLY_KINDS = new Set([
  'contract',
  'customer_business_registration',
  'quote',
  'proposal',
  'performance_certificate',
  'tax_invoice',
  'final_settlement_report',
  'final_report',
]);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function extension(fileName) {
  const match = /\.([^.]+)$/.exec(String(fileName || '').trim().toLowerCase());
  return match ? `.${match[1]}` : '';
}

function hasPdfMagic(buffer) {
  return buffer.toString('ascii', 0, 5) === '%PDF-';
}

function hasZipMagic(buffer) {
  if (buffer.byteLength < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
  return (buffer[2] === 0x03 && buffer[3] === 0x04)
    || (buffer[2] === 0x05 && buffer[3] === 0x06)
    || (buffer[2] === 0x07 && buffer[3] === 0x08);
}

function hasMsgMagic(buffer) {
  return buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}

function hasEmlHeaders(buffer) {
  const headers = buffer.toString('utf8', 0, Math.min(buffer.byteLength, 16 * 1024)).split(/\r?\n\r?\n/, 1)[0];
  return /^(?:from|received|return-path|message-id):/im.test(headers)
    && /^(?:to|subject|date):/im.test(headers);
}

function isPdf(buffer, mimeType, fileExtension) {
  return mimeType === 'application/pdf' && fileExtension === '.pdf' && hasPdfMagic(buffer);
}

function isDocx(buffer, mimeType, fileExtension) {
  return mimeType === DOCX_MIME && fileExtension === '.docx' && hasZipMagic(buffer);
}

function isPptx(buffer, mimeType, fileExtension) {
  return mimeType === PPTX_MIME && fileExtension === '.pptx' && hasZipMagic(buffer);
}

export function projectDocumentValidationError({ buffer, mimeType, fileName, documentKind }) {
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  const fileExtension = extension(fileName);

  if (PDF_ONLY_KINDS.has(documentKind)) {
    return isPdf(buffer, normalizedMime, fileExtension) ? '' : 'Attachment must be a valid PDF';
  }
  if (documentKind === 'proposal_word_original') {
    return isDocx(buffer, normalizedMime, fileExtension) ? '' : 'Proposal Word original must be a valid DOCX';
  }
  if (documentKind === 'proposal_ppt_original' || documentKind === 'presentation_ppt_original') {
    return isPptx(buffer, normalizedMime, fileExtension) ? '' : 'Presentation original must be a valid PPTX';
  }
  if (documentKind === 'rfp_request_evidence') {
    const valid = isPdf(buffer, normalizedMime, fileExtension)
      || isDocx(buffer, normalizedMime, fileExtension)
      || (fileExtension === '.eml' && normalizedMime === 'message/rfc822' && hasEmlHeaders(buffer))
      || (
        fileExtension === '.msg'
        && ['application/vnd.ms-outlook', 'application/x-msg'].includes(normalizedMime)
        && hasMsgMagic(buffer)
      );
    return valid ? '' : 'RFP evidence must be a valid PDF, DOCX, EML, or MSG';
  }
  return 'documentKind is invalid';
}
