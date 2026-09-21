import { describe, expect, it } from 'vitest';
import { PROJECT_SUBMISSION_FIELDS, projectSubmissionOwnedPatch, assertProjectSubmissionFields } from './project-submission-fields.mjs';
import { buildProjectPatchFromChangeRequestPayload } from '../../../server/bff/routes/projects.mjs';

describe('submission field ownership through approval', () => {
  it('rejects newly introduced payload keys until their ownership is defined', () => {
    expect(() => assertProjectSubmissionFields({ name: '사업', accidentalNewField: true })).toThrow('accidentalNewField');
  });
  it('keeps operations and absent legacy fields out of the approval patch', () => {
    const existing = { name: '기존', contractAmount: 900, budgetCurrentYear: 700,
      contractDocument: { path: 'existing.pdf' }, financialYears: [{ year: 2026, contractAmount: 900 }],
      taxInvoiceAmount: 15, paymentPlan: { contract: 100, interim: 0, final: 800 } };
    const patch = buildProjectPatchFromChangeRequestPayload({ description: '내용 수정' }, existing);
    expect(patch).toEqual({ description: '내용 수정' });
    expect({ ...existing, ...patch }).toEqual({ ...existing, description: '내용 수정' });
  });
  it('persists explicit clear values rather than resurrecting the previous values', () => {
    const existing = { contractEndUndecided: true, businessManagementGoogleFolderLink: 'old',
      contractEnd: '', proposalDocument: { path: 'old.pdf' } };
    const payload = { contractEndUndecided: false, contractEnd: '2027-12-31',
      businessManagementGoogleFolderLink: '', proposalDocument: null, totalActualCost: 0 };
    const patch = buildProjectPatchFromChangeRequestPayload(payload, existing);
    expect(patch).toMatchObject(payload);
    expect({ ...existing, ...patch }).toMatchObject(payload);
  });
  it('does not copy arbitrary or operations keys even if a normalizer supplies them', () => {
    const raw = { note: '', budgetCurrentYear: 50, permissions: ['admin'], version: 8 };
    expect(projectSubmissionOwnedPatch(raw, raw)).toEqual({ note: '' });
    expect(new Set(PROJECT_SUBMISSION_FIELDS).size).toBe(PROJECT_SUBMISSION_FIELDS.length);
  });
  it('covers every approved attachment including final report without erasing absent attachments', () => {
    const docs = PROJECT_SUBMISSION_FIELDS.filter((key) => key.endsWith('Document'));
    expect(docs).toContain('finalReportDocument');
    for (const key of docs) {
      const patch = buildProjectPatchFromChangeRequestPayload({ [key]: null }, { [key]: { path: 'kept.pdf' } });
      expect(patch, key).toEqual({ [key]: null });
    }
  });
});
