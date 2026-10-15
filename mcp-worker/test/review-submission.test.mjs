import { describe, expect, it, vi } from 'vitest';
import { BffError } from '../src/bff.mjs';
import { attachmentTextPath, loadSubmission, parseSubject, SUBMISSION_FIELDS } from '../src/review/submission.mjs';

const doc = (name) => ({ path: `orgs/mysc/project-registration-documents/p1/${name}`, name });
const payload = {
  name: '청년 창업', officialContractName: '2026 청년 창업 지원 운영 용역', clientOrg: '가상테스트재단', currency: 'KRW',
  contractStart: '2026-03-01', contractEnd: '2026-12-31', contractAmount: 110_000_000,
  contractDocument: doc('c.pdf'), quoteDocument: doc('q.pdf'),
  participationSheetLink: 'https://docs.google.com/spreadsheets/d/x/edit', businessManagementGoogleFolderLink: 'javascript:alert(1)',
  // 허용 목록 밖: 대화로 나가면 안 되는 값
  customerBusinessRegistrationNumber: '123-45-67890', registeredByEmail: 'pm@mysc.co.kr', executiveApproverName: '조직장',
};
const bffWith = (responses) => ({ get: vi.fn(async (path, query) => {
  const key = `${path}${query?.requestId ? `?requestId=${query.requestId}` : ''}`;
  if (!(key in responses)) throw new BffError(404, { code: 'not_found' });
  const value = responses[key];
  if (value instanceof Error) throw value;
  return value;
}) });

describe('review subject', () => {
  it('validates subject types and identifiers', () => {
    expect(parseSubject({ type: 'request', projectId: 'p1', requestId: 'r1' })).toEqual({ type: 'request', projectId: 'p1', requestId: 'r1' });
    expect(() => parseSubject({ type: 'request', projectId: 'p1' })).toThrow('requestId');
    expect(() => parseSubject({ type: 'project', projectId: '../admin' })).toThrow('projectId');
    expect(() => parseSubject({ type: 'nope' })).toThrow('검토 대상');
  });

  it('builds the attachment text path for each subject', () => {
    expect(attachmentTextPath({ type: 'request', projectId: 'p1', requestId: 'r1' }, 'contract')).toBe('/api/v1/project-requests/r1/attachments/contract/text');
    expect(attachmentTextPath({ type: 'registration_draft', draftId: 'd1' }, 'quote')).toBe('/api/v1/project-registration-drafts/d1/attachments/quote/text');
    expect(attachmentTextPath({ type: 'edit_draft', projectId: 'p1' }, 'contract')).toBe('/api/v1/project-info-drafts/p1/attachments/contract/text');
    expect(attachmentTextPath({ type: 'project', projectId: 'p1' }, 'customer_business_registration')).toBe('/api/v1/projects/p1/attachments/customer_business_registration/text');
    expect(attachmentTextPath({ type: 'project', projectId: 'p1' }, 'rfp_request_evidence')).toBe('/api/v1/projects/p1/attachments/rfp_request_evidence/text');
    expect(() => attachmentTextPath({ type: 'project', projectId: 'p1' }, 'unknown')).toThrow();
  });
});

describe('loading a submission', () => {
  it('exposes linked proposal and presentation files for the users Drive connector', async () => {
    const project = { ...payload, rfpRequestEvidenceDocument: doc('rfp.pdf'), registrationConfirmations: {
      proposalPptOriginal: 'https://drive.google.com/file/d/proposal/view?resourcekey=key',
      presentationPptOriginal: 'https://docs.google.com/presentation/d/slides/edit',
    } };
    const bff = bffWith({ '/api/v1/projects/p1/review-document': { project } });
    const result = await loadSubmission(bff, { type: 'project', projectId: 'p1' });
    expect(result.attachedKinds).toContain('rfp_request_evidence');
    expect(result.linkedDocuments).toEqual([
      { kind: 'proposalPptOriginal', url: project.registrationConfirmations.proposalPptOriginal, readWith: 'google_drive', evidence: 'unverified' },
      { kind: 'presentationPptOriginal', url: project.registrationConfirmations.presentationPptOriginal, readWith: 'google_drive', evidence: 'unverified' },
    ]);
    project.registrationConfirmations.proposalPptOriginal = 'https://drive.google.com.attacker.example/file/d/x';
    project.registrationConfirmations.presentationPptOriginal = 'https://user:secret@drive.google.com/file/d/x';
    expect((await loadSubmission(bff, { type: 'project', projectId: 'p1' })).linkedDocuments).toEqual([]);
  });
  it('reads a registration request, exposing only allow-listed fields', async () => {
    const bff = bffWith({ '/api/v1/projects/p1/review-document?requestId=r1': { request: { requestKind: 'REGISTRATION', payload }, reviewToken: 'tok', readiness: { issues: [{ code: 'missing_quote', field: 'quoteDocument', message: '견적서 확인', secret: 'x' }] } } });
    const result = await loadSubmission(bff, { type: 'request', projectId: 'p1', requestId: 'r1' });
    expect(Object.keys(result.submission).every((key) => SUBMISSION_FIELDS.includes(key))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/123-45-67890|pm@mysc|조직장/);
    expect(result).toMatchObject({ reviewToken: 'tok', attachedKinds: ['contract', 'quote'], serverReadiness: [{ code: 'missing_quote', field: 'quoteDocument', message: '견적서 확인' }] });
    expect(result.attachments.find((item) => item.kind === 'contract')).toEqual({ kind: 'contract', present: true, name: 'c.pdf' });
    expect(result.links).toEqual({ participationSheetLink: 'https://docs.google.com/spreadsheets/d/x/edit', businessManagementGoogleFolderLink: '' });
  });

  it('reviews the proposed snapshot of a change request, like the BFF', async () => {
    const bff = bffWith({ '/api/v1/projects/p1/review-document?requestId=r2': { request: { requestKind: 'CHANGE', payload: { contractAmount: 1 }, proposedSnapshot: { ...payload, contractAmount: 200 } }, reviewToken: 't2' } });
    expect((await loadSubmission(bff, { type: 'request', projectId: 'p1', requestId: 'r2' })).submission.contractAmount).toBe(200);
  });

  it('reads registration and edit drafts with their attachment refs and draft revision', async () => {
    const bff = bffWith({
      '/api/v1/project-registration-drafts/d1': { draft: { draftRevision: 4, payload: { ...payload, contractDocument: null, quoteDocument: null }, attachmentRefs: [{ documentKind: 'customer_business_registration', path: 'orgs/mysc/project-registration-drafts/d1/b.pdf', name: 'b.pdf' }] } },
      '/api/v1/project-info-drafts/p1': { draft: { draftRevision: 2, payload, attachmentRefs: [] } },
    });
    const registration = await loadSubmission(bff, { type: 'registration_draft', draftId: 'd1' });
    expect(registration).toMatchObject({ reviewToken: 'draft-revision:4', attachedKinds: ['customer_business_registration'] });
    const edit = await loadSubmission(bff, { type: 'edit_draft', projectId: 'p1' });
    expect(edit.attachedKinds).toEqual(['contract', 'quote']);
  });

  it('reads an approved project from the review document', async () => {
    const bff = bffWith({ '/api/v1/projects/p1/review-document': { project: { ...payload, id: 'p1' }, request: null, reviewToken: 'pt' } });
    const result = await loadSubmission(bff, { type: 'project', projectId: 'p1' });
    expect(result).toMatchObject({ reviewToken: 'pt', submission: { contractAmount: 110_000_000 } });
    expect(bff.get).toHaveBeenCalledWith('/api/v1/projects/p1/review-document', {});
  });

  it('passes BFF permission errors through unchanged', async () => {
    const bff = bffWith({ '/api/v1/projects/p1/review-document?requestId=r1': new BffError(403, { code: 'forbidden', message: 'Project request access denied' }) });
    await expect(loadSubmission(bff, { type: 'request', projectId: 'p1', requestId: 'r1' })).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});
