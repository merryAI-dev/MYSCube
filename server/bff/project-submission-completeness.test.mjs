import { describe, expect, it } from 'vitest';
import { projectSubmissionCompletenessIssues as issues } from '../../src/app/platform/project-submission-completeness.mjs';
import { completeProjectSubmissionFixture as complete } from '../../src/app/platform/project-submission-completeness.fixture.mjs';

const amounts = ['contractAmount', 'salesVatAmount', 'totalRevenueAmount', 'totalActualCost', 'supportAmount'];
describe('shared final submission completeness', () => {
  it('routes conditional settlement detail errors to the visible finance step', () => {
    const result = issues(complete({ basis: 'SUPPLY_AMOUNT', settlementSystem: 'OTHER', settlementSystemOther: '' }));
    expect(result).toContainEqual(expect.objectContaining({ field: 'settlementSystemOther', step: 'financial' }));
  });
  it('accepts explicitly entered zero, false and explicit absence without mutating data', () => {
    const payload = complete();
    const before = JSON.stringify(payload);
    expect(issues(payload)).toEqual([]);
    expect(JSON.stringify(payload)).toBe(before);
  });
  for (const field of amounts) for (const empty of [undefined, null, '', '0', -1, NaN, Infinity]) {
    it(`rejects missing or invalid ${field}: ${String(empty)}`, () => {
      const payload = complete(); payload[field] = empty; payload.financialYears[0][field] = empty;
      expect(issues(payload).some((issue) => issue.field === field)).toBe(true);
      expect(issues(payload).some((issue) => issue.field === `financialYears.2026.${field}`)).toBe(true);
    });
  }
  for (const field of amounts) it(`requires explicit input evidence for ${field}, even zero`, () => {
    const payload = complete(); payload.financialInputFlags[field] = false;
    expect(issues(payload).some((issue) => issue.field === field)).toBe(true);
  });
  it('rejects empty single-year rows, wrong totals, and omitted payment evidence', () => {
    expect(issues(complete({ financialYears: [] })).some((issue) => issue.field === 'financialYears')).toBe(true);
    expect(issues(complete({ contractAmount: 120 })).some((issue) => issue.field === 'contractAmount')).toBe(true);
    expect(issues(complete({ paymentPlanInputFlags: {} })).filter((issue) => issue.field.startsWith('paymentPlan.'))).toHaveLength(3);
  });
  it('requires each annual payment, row flags, and missing years', () => {
    const payload = complete({ contractEnd: '2027-12-31' });
    expect(issues(payload).some((issue) => issue.field === 'financialYears.2027')).toBe(true);
    expect(issues(payload).some((issue) => issue.field === 'financialYears.2026.paymentPlan.contract')).toBe(true);
    delete payload.financialYears[0].inputFlags;
    expect(issues(payload).some((issue) => issue.field === 'financialYears.2026.totalActualCost')).toBe(true);
  });
  it('allows conditional hidden settlement fields only for NONE', () => {
    expect(issues(complete()).some((issue) => issue.field === 'interestRefundPolicy')).toBe(false);
    expect(issues(complete({ basis: '공급가액' })).some((issue) => issue.field === 'interestRefundPolicy')).toBe(true);
  });
  it('requires document or explicit response for all four previously optional slots', () => {
    const payload = complete({ registrationOptionalDocumentNotes: {} });
    expect(issues(payload).filter((issue) => issue.field.endsWith('Document'))).toHaveLength(4);
    payload.registrationConfirmations.proposalPptOriginal = 'https://drive.google.com/file/d/test/view';
    expect(issues(payload).some((issue) => issue.field === 'proposalPptOriginalDocument')).toBe(false);
  });
  it('does not treat none text as a URL and disallows explicit absence with an attachment', () => {
    expect(issues(complete({ businessManagementGoogleFolderLink: '없음' })).some((issue) => issue.field === 'businessManagementGoogleFolderLink')).toBe(true);
    expect(issues(complete({ proposalWordOriginalDocument: { path: 'file.docx' } })).some((issue) => issue.field === 'proposalWordOriginalDocument')).toBe(true);
  });
  it('requires staffing decisions and rejects partially filled extra rows', () => {
    const payload = complete({ submissionResponses: {} });
    expect(issues(payload).filter((issue) => issue.field.startsWith('staffing.'))).toHaveLength(5);
    payload.staffing.others = [{ role: '멘토', slot: null }];
    expect(issues(payload).some((issue) => issue.field === 'staffing.others.0.slot')).toBe(true);
  });
  it('rejects an absence marker that contradicts supplied content', () => {
    const payload = complete({ paymentPlanDesc: '계획 있음' });
    payload.staffing.lead = { personId: 'person', name: '담당자' };
    expect(issues(payload).some((issue) => issue.field === 'paymentPlanDesc')).toBe(true);
    expect(issues(payload).some((issue) => issue.field === 'staffing.lead')).toBe(true);
  });
  it('returns all missing checks, while operational fields and legacy hidden fields are not required', () => {
    const result = issues({});
    expect(result.length).toBeGreaterThan(30);
    expect(result.every((issue) => issue.field && issue.label && issue.message && issue.step)).toBe(true);
    expect(result.some((issue) => ['budgetCurrentYear', 'checkout', 'note', 'groupwareName', 'fundInputMode'].includes(issue.field))).toBe(false);
  });
});
