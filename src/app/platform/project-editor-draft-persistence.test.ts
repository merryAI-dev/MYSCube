import { describe, expect, it } from 'vitest';
import { createProjectEditorDraft, buildProjectRequestPayloadFromDraft } from './project-editor';
import { serializeProjectEditorPrivateDraft } from './project-editor-draft-persistence';

describe('private draft persistence', () => {
  it('retains editor text and explicit clears on reopen while final submission still normalizes', () => {
    const draft = createProjectEditorDraft({
      name: '  project  ', note: '  first line\nsecond line  ', finalPaymentNote: '  pending  ',
      businessManagementGoogleFolderLink: '', contractEndUndecided: false,
      proposalDocument: null, teamMembersDetailed: [],
      contractAmount: 0, totalRevenueAmount: 0,
    });
    const payload = serializeProjectEditorPrivateDraft(draft);
    const reopened = createProjectEditorDraft(payload);
    expect(reopened).toEqual(draft);
    expect(payload).toMatchObject({ name: '  project  ', note: '  first line\nsecond line  ', finalPaymentNote: '  pending  ', businessManagementGoogleFolderLink: '', contractEndUndecided: false, proposalDocument: null, teamMembersDetailed: [] });
    expect(buildProjectRequestPayloadFromDraft(reopened).name).toBe('project');
  });

  it('does not retain references to mutable editor objects or extra session state', () => {
    const draft = createProjectEditorDraft({ paymentPlan: { contract: 10, interim: 0, final: 0 } });
    Object.assign(draft, { amountInputs: { contract: 'bad' }, leaseId: 'private-session', auth: 'private-auth' });
    const payload = serializeProjectEditorPrivateDraft(draft);
    draft.paymentPlan.contract = 20;
    expect(payload.paymentPlan).toEqual({ contract: 10, interim: 0, final: 0 });
    expect(payload).not.toHaveProperty('amountInputs');
    expect(payload).not.toHaveProperty('leaseId');
    expect(payload).not.toHaveProperty('auth');
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite amounts instead of JSON null: %s', (value) => {
    const draft = createProjectEditorDraft();
    draft.paymentPlan.contract = value;
    expect(() => serializeProjectEditorPrivateDraft(draft)).toThrow('금액 입력 형식');
  });
});
