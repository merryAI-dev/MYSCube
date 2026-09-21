import { describe, it, expect } from 'vitest';
import { buildProjectReviewReadiness, mapProjectReviewReadinessError } from './project-review-readiness.mjs';
const documents = {
  contractDocument: { path: 'orgs/t/project-request-contracts/old/contract.pdf' },
  customerBusinessRegistrationDocument: { path: 'orgs/t/project-request-documents/old/customer.pdf' },
  quoteDocument: { path: 'orgs/t/project-request-documents/old/quote.pdf' },
};
describe('read-only project approval readiness', () => {
  it('warns on former format without blocking old stored document paths or mutating the source', () => {
    const request = { status: 'PENDING', payload: documents };
    const before = structuredClone(request);
    const result = buildProjectReviewReadiness(request, {});
    expect(result.legacy).toBe(true);
    expect(result.issues.map(i => i.code)).toEqual(['legacy_submission_format']);
    expect(result.issues.every(i => i.severity === 'warning')).toBe(true);
    expect(request).toEqual(before);
  });
  it('distinguishes an absent old field from explicit null without claiming either file is lost', () => {
    const result = buildProjectReviewReadiness({ payload: { contractDocument: null } }, {});
    expect(result.issues.find(i => i.field === 'contractDocument').code).toBe('submission_document_reference_empty');
    expect(result.issues.find(i => i.field === 'quoteDocument').code).toBe('submission_field_unrecorded');
    expect(result.issues.every(i => i.severity === 'warning')).toBe(true);
  });
  it('blocks the existing unpublished v2 registration missing-required-file condition', () => {
    const result = buildProjectReviewReadiness({ requestKind: 'REGISTRATION', status: 'PENDING', payload: { registrationRequirementsVersion: 2, ...documents, quoteDocument: null } }, {});
    expect(result.issues).toEqual([expect.objectContaining({ severity: 'blocking', code: 'project_attachments_processing', field: 'quoteDocument' })]);
  });
  it.each([
    { requestKind: 'REGISTRATION', status: 'PENDING', registrationAttachmentsPublishedAt: '2026-01-01' },
    { requestKind: 'REGISTRATION', status: 'APPROVED' },
    { requestKind: 'CHANGE', status: 'PENDING' },
  ])('does not impose new required-file gates on published, processed or change requests: %s', metadata => {
    const result = buildProjectReviewReadiness({ ...metadata, payload: { registrationRequirementsVersion: 2 } }, {});
    expect(result.issues.every(i => i.severity === 'warning')).toBe(true);
  });
  it('honors quote deferral and uses proposedSnapshot instead of stale change payload', () => {
    const result = buildProjectReviewReadiness({ requestKind: 'CHANGE', status: 'PENDING', payload: {}, proposedSnapshot: { registrationRequirementsVersion: 2, ...documents, quoteDocument: null, quoteSubmissionDeferred: true } }, {});
    expect(result).toEqual({ legacy: false, issues: [] });
  });
  it('uses project fields only when there is no request, never to fill an omitted submission', () => {
    expect(buildProjectReviewReadiness(null, { registrationRequirementsVersion: 2, ...documents }).issues).toEqual([]);
    expect(buildProjectReviewReadiness({ payload: {} }, { registrationRequirementsVersion: 2, ...documents }).legacy).toBe(true);
  });
  it.each(['EACCES', 'ETIMEDOUT', '403', 'secret/path/request'])('does not expose unknown infrastructure errors or report them as missing files: %s', code => {
    const issue = mapProjectReviewReadinessError({ code, message: 'secret/path' });
    expect(issue.code).toBe('project_review_check_unavailable');
    expect(issue.severity).toBe('warning');
    expect(JSON.stringify(issue)).not.toContain('secret/path');
    expect(issue.action).toContain('오류 추적');
  });
  it.each([
    ['Project registration participationSheetLink is required for sheet-backed team members', 'participation_sheet_link_missing'],
    ['Project registration sheet-backed team member 2 identity is required', 'participation_member_identity_missing'],
    ['Project registration duplicate monthlyRates ownership for 2026-09', 'participation_monthly_owner_duplicate'],
  ])('explains an actual participation approval rejection: %s', (message, code) => {
    const issue = mapProjectReviewReadinessError({ code: 'project_registration_invalid', message });
    expect(issue.code).toBe(code);
    expect(issue.severity).toBe('blocking');
    expect(issue.action).toContain('등록자');
  });
  it('maps confirmed storage verification failure to a blocker without claiming deletion', () => {
    expect(mapProjectReviewReadinessError({ code: 'project_attachment_unavailable' })).toMatchObject({ code: 'project_attachment_unavailable', severity: 'blocking' });
    expect(mapProjectReviewReadinessError({ code: 'project_attachment_unavailable' }).detail).toContain('파일 접근 문제');
  });
});
