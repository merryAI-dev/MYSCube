import { describe, expect, it } from 'vitest';
import { createProjectEditorDraft, buildProjectRequestPayloadFromDraft, buildProjectEditorProjectPatch } from './project-editor';
// @ts-expect-error BFF runs as native JavaScript.
import { buildProjectInfoDraftSeed, buildProjectPatchFromChangeRequestPayload, buildProjectRequestPayloadFromProject } from '../../../server/bff/routes/projects.mjs';

const fields = ['contractDocument', 'customerBusinessRegistrationDocument', 'quoteDocument', 'proposalDocument', 'proposalWordOriginalDocument', 'proposalPptOriginalDocument', 'presentationPptOriginalDocument', 'rfpRequestEvidenceDocument', 'performanceCertificateDocument', 'taxInvoiceDocument', 'finalSettlementReportDocument', 'finalReportDocument'] as const;

describe('project document roundtrip', () => {
  it('preserves explicit removal and omitted attachment values', () => {
    const draft = createProjectEditorDraft({ finalReportDocument: null, proposalDocument: undefined });
    const payload = buildProjectRequestPayloadFromDraft(draft);
    expect(payload.finalReportDocument).toBeNull();
    expect(payload.proposalDocument).toBeUndefined();
  });
  it.each(fields)('preserves %s through editor, request, seed and approval', (field) => {
    const attachment = { path: `orgs/mysc/project-registration-documents/check/${field}.pdf`, name: `${field}.pdf`, size: 1, contentType: 'application/pdf' };
    const draft = createProjectEditorDraft({ name: 'check', [field]: attachment });
    const payload = buildProjectRequestPayloadFromDraft(draft);
    expect(payload[field]).toEqual(attachment);
    expect(buildProjectEditorProjectPatch(draft, { mode: 'admin', now: '2026-09-08', actorId: 'admin', actorName: 'admin' })[field]).toEqual(attachment);
    const seed = buildProjectInfoDraftSeed({ id: 'check', name: 'check', [field]: attachment }, {});
    expect(seed[field]).toEqual(attachment);
    expect(buildProjectPatchFromChangeRequestPayload(seed, { id: 'check' })[field]).toEqual(attachment);
  });
  it.each(fields)('preserves omitted %s on approval and honors explicit null', (field) => {
    const attachment = { path: `private/${field}.pdf` };
    expect(buildProjectPatchFromChangeRequestPayload({}, { [field]: attachment })[field]).toEqual(attachment);
    expect(buildProjectPatchFromChangeRequestPayload({ [field]: null }, { [field]: attachment })[field]).toBeNull();
    expect(buildProjectRequestPayloadFromProject({ [field]: null }, { [field]: attachment })[field]).toBeNull();
  });
});
