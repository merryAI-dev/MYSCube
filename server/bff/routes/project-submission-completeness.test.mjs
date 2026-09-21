import { describe, expect, it } from 'vitest';
import { completeProjectSubmissionFixture as complete } from '../../../src/app/platform/project-submission-completeness.fixture.mjs';
import { buildProjectRegistrationCanonicalDocuments, buildProjectInfoChangeSubmission, buildProjectPatchFromChangeRequestPayload } from './projects.mjs';

const attachmentRefs = ['contract', 'customer_business_registration', 'quote'].map((documentKind) => ({ documentKind, path: `orgs/test/project-registration-drafts/test/${documentKind}.pdf`, name: `${documentKind}.pdf`, size: 1, contentType: 'application/pdf' }));
const meta = { tenantId: 'test', projectId: 'project', projectRequestId: 'request', sourceDraftId: 'draft', actorId: 'person-pm', actorName: '검증 실무자', actorEmail: 'test@example.com', timestamp: '2026-09-21T00:00:00.000Z' };
const register = (payload = complete()) => buildProjectRegistrationCanonicalDocuments({ ...meta, payload, attachmentRefs });
const failure = (fn) => { try { fn(); } catch (error) { return error; } throw new Error('submission unexpectedly accepted'); };

describe('required completeness on real final submission builders', () => {
  it('persists explicit zero evidence and absence decisions through registration and approval projection', () => {
    const canonical = register();
    const payload = canonical.projectRequest.payload;
    expect(payload.financialYears[0].inputFlags.totalActualCost).toBe(true);
    expect(payload.paymentPlanInputFlags.final).toBe(true);
    expect(payload.submissionResponses['staffing.others']).toBe('NOT_APPLICABLE');
    expect(payload.registrationOptionalDocumentNotes.rfpRequestEvidence).toBe('해당 없음');
    expect(payload.registrationConfirmations.customerSettlementBasisConfirmed).toBe(false);
    const result = buildProjectPatchFromChangeRequestPayload(payload, { budgetCurrentYear: 777, isSettled: true });
    expect(result.submissionResponses).toEqual(payload.submissionResponses);
    expect(result).not.toHaveProperty('budgetCurrentYear');
    expect(result).not.toHaveProperty('isSettled');
  });
  it('rejects raw missing cost before a canonical document can manufacture zero', () => {
    const payload = complete(); delete payload.totalActualCost; delete payload.financialYears[0].totalActualCost;
    const error = failure(() => register(payload));
    expect(error.code).toBe('project_submission_incomplete');
    expect(error.details.requiredFields.map((issue) => issue.field)).toContain('totalActualCost');
    expect(error.details.requiredFields.map((issue) => issue.field)).toContain('financialYears.2026.totalActualCost');
  });
  it('rejects missing required files on CHANGE final submission and leaves the original untouched', () => {
    const canonical = register();
    const before = JSON.stringify(canonical);
    const payload = { ...canonical.projectRequest.payload, contractDocument: null };
    const error = failure(() => buildProjectInfoChangeSubmission({ ...meta, project: canonical.project, payload, attachmentRefs: [] }));
    expect(error.code).toBe('project_submission_incomplete');
    expect(error.details.requiredFields.some((issue) => issue.field === 'contractDocument')).toBe(true);
    expect(JSON.stringify(canonical)).toBe(before);
  });
  it('preserves old sparse approval compatibility without applying new completeness gates', () => {
    expect(buildProjectPatchFromChangeRequestPayload({ name: '기존 제출' }, { totalActualCost: 123 })).toEqual({ name: '기존 제출' });
  });
});
