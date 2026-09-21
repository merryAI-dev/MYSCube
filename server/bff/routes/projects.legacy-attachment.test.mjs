import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { mountProjectRoutes } from './projects.mjs';
import { createProjectRequestContractStorageService } from '../project-request-contract-storage.mjs';

function harness({ prefix = 'project-request-contracts', actor = 'head-a', mutateRequest, changeDuringInspection = false, missing = false } = {}) {
  const attachment = { path: `orgs/mysc/${prefix}/pm-a/123-contract.pdf`, name: '기존 계약서.pdf', size: 9, contentType: 'application/pdf' };
  const projectPath = 'orgs/mysc/projects/p001';
  const requestPath = 'orgs/mysc/project_requests/change-p001';
  const project = { id: 'p001', name: 'Before', version: 9, executiveReviewStatus: 'APPROVED', executiveApproverId: 'head-a', contractDocument: attachment };
  const payload = { name: 'After', executiveApproverId: 'head-a', contractDocument: { ...attachment }, teamMembersDetailed: [] };
  mutateRequest?.(payload);
  const documents = new Map([
    [projectPath, project],
    [requestPath, { id: 'change-p001', targetProjectId: 'p001', approvedProjectId: 'p001', requestKind: 'CHANGE', requestVersion: 2,
      status: 'PENDING', baseProjectVersion: 9, targetProjectVersion: 10, proposedSnapshot: payload, payload }],
    [`orgs/mysc/members/${actor}`, { uid: actor, role: 'pm', status: 'ACTIVE', projectIds: ['p001'] }],
  ]);
  const read = (path) => ({ exists: documents.has(path), data: () => structuredClone(documents.get(path)) });
  const writes = vi.fn();
  const db = {
    doc: (path) => ({ path, get: async () => read(path) }),
    collection: (path) => ({ query: true, path, where() { return this; }, get: async () => ({ docs: [] }) }),
    runTransaction: async (callback) => {
      const pending = [];
      const result = await callback({ get: async ref => ref.query ? { docs: [] } : read(ref.path),
        set: (ref, value) => pending.push([ref.path, value]), delete: () => { throw new Error('unexpected deletion'); } });
      pending.forEach(([path, value]) => { writes(path, value); documents.set(path, { ...documents.get(path), ...value }); });
      return result;
    },
  };
  let inspectionMutationArmed = false;
  const getMetadata = vi.fn(async () => {
    if (missing) throw new Error('not found');
    if (changeDuringInspection && inspectionMutationArmed) documents.get(projectPath).contractDocument = { ...attachment, path: `orgs/mysc/${prefix}/pm-a/changed.pdf` };
    return [{ size: '9', contentType: 'application/pdf', generation: '1' }];
  });
  const download = vi.fn(async () => [Buffer.from('%PDF-1.4\n')]);
  const bucket = { file: vi.fn(() => ({ getMetadata, download })) };
  const storage = createProjectRequestContractStorageService({ projectId: 'demo-legacy-approval', storage: { bucket: () => bucket } });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.context = { tenantId: 'mysc', actorId: actor, actorRole: 'pm', actorName: '검토자',
    actorEmail: `${actor}@mysc.co.kr`, requestId: 'req-test', idempotencyKey: 'legacy-review-test' }; next(); });
  mountProjectRoutes(app, { db, now: () => '2026-09-17T07:00:00.000Z', projectRequestContractStorageService: storage,
    idempotencyService: { begin: async () => ({ mode: 'acquired' }), complete: vi.fn(), fail: vi.fn() } });
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' }));
  return { api: request(app), documents, attachment, writes, bucket, download, projectPath, requestPath, getMetadata, armInspectionMutation: () => { inspectionMutationArmed = true; } };
}

const review = h => h.api.get('/api/v1/projects/p001/review-document?requestId=change-p001');
const approve = async h => {
  const document = await review(h);
  expect(document.status).toBe(200);
  h.armInspectionMutation();
  return h.api.post('/api/v1/projects/p001/executive-review').send({ requestId: 'change-p001', reviewStatus: 'APPROVED', expectedReviewToken: document.body.reviewToken });
};

describe('existing legacy attachment review routes', () => {
  it.each(['project-request-contracts', 'project-request-documents'])('approves and reads an unchanged %s contract without rewriting its reference', async prefix => {
    const h = harness({ prefix });
    expect((await h.api.get('/api/v1/project-requests/change-p001/attachments/contract')).status).toBe(200);
    expect(h.writes).not.toHaveBeenCalled();
    const response = await approve(h);
    expect(response.status).toBe(200);
    expect(h.documents.get(h.projectPath)).toMatchObject({ name: 'After', version: 10, executiveReviewStatus: 'APPROVED', contractDocument: h.attachment });
    expect(h.documents.get(h.requestPath)).toMatchObject({ status: 'APPROVED' });
    const read = await h.api.get('/api/v1/projects/p001/attachments/contract');
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('private, no-store');
    expect(read.body).toEqual(Buffer.from('%PDF-1.4\n'));
    expect(h.documents.get(h.projectPath).contractDocument).toEqual(h.attachment);
  });

  it.each([
    ['another path', p => { p.contractDocument.path = 'orgs/mysc/project-request-contracts/pm-a/other.pdf'; }],
    ['another tenant', p => { p.contractDocument.path = 'orgs/other/project-request-contracts/pm-a/123-contract.pdf'; }],
    ['another field', p => { p.quoteDocument = p.contractDocument; delete p.contractDocument; }],
    ['changed metadata', p => { p.contractDocument.size = 10; }],
  ])('rejects %s without any approval writes', async (_label, mutateRequest) => {
    const h = harness({ mutateRequest });
    expect((await approve(h)).body.error).toBe('project_attachment_unavailable');
    expect(h.writes).not.toHaveBeenCalled();
    expect(h.download).not.toHaveBeenCalled();
  });

  it('rechecks the current project attachment in the approval transaction', async () => {
    const h = harness({ changeDuringInspection: true });
    const response = await approve(h);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('review_version_conflict');
    expect(h.writes).not.toHaveBeenCalled();
  });

  it('keeps designated approver authorization and missing-file rejection', async () => {
    const unauthorized = harness({ actor: 'other-head' });
    expect((await approve(unauthorized)).status).toBe(403);
    expect((await unauthorized.api.get('/api/v1/project-requests/change-p001/attachments/contract')).status).toBe(403);
    expect(unauthorized.writes).not.toHaveBeenCalled();
    const missing = harness({ missing: true });
    expect((await approve(missing)).body.error).toBe('project_attachment_unavailable');
    expect(missing.writes).not.toHaveBeenCalled();
  });

  it('rejects a forged request attachment before any file is read', async () => {
    const h = harness({ mutateRequest: p => { p.contractDocument.path = 'orgs/mysc/project-request-contracts/another/other.pdf'; } });
    expect((await h.api.get('/api/v1/project-requests/change-p001/attachments/contract')).status).toBe(409);
    expect(h.bucket.file).not.toHaveBeenCalled();
  });
});


describe('review document version and access contract', () => {
  it('returns no-store consistent snapshot without writes and rejects missing token', async () => {
    const h = harness(); const before = structuredClone([...h.documents]);
    const read = await review(h);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('private, no-store');
    expect(read.body.reviewToken).toMatch(/^[0-9a-f]{64}$/);
    expect(read.body.project.version).toBe(9);
    expect(read.body.request.requestVersion).toBe(2);
    expect([...h.documents]).toEqual(before);
    const rejected = await h.api.post('/api/v1/projects/p001/executive-review').send({ requestId: 'change-p001', reviewStatus: 'APPROVED' });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toBe('review_version_required');
    expect(h.writes).not.toHaveBeenCalled();
  });
  it.each(['request', 'project'])('rejects stale %s after the document was opened', async source => {
    const h = harness(); const read = await review(h);
    if (source === 'request') h.documents.get(h.requestPath).proposedSnapshot.name = 'Resubmitted';
    else h.documents.get(h.projectPath).version = 10;
    const before = structuredClone([...h.documents]);
    const res = await h.api.post('/api/v1/projects/p001/executive-review').send({ requestId: 'change-p001', reviewStatus: 'APPROVED', expectedReviewToken: read.body.reviewToken });
    expect(res.status).toBe(409); expect(res.body.error).toBe(source === 'project' ? 'canonical_version_conflict' : 'review_version_conflict');
    expect([...h.documents]).toEqual(before); expect(h.writes).not.toHaveBeenCalled();
  });
  it('supports missing legacy requestVersion while preserving operating fields', async () => {
    const h = harness(); delete h.documents.get(h.requestPath).requestVersion;
    Object.assign(h.documents.get(h.projectPath), { budgetCurrentYear: 777, settlementLocked: true });
    expect((await approve(h)).status).toBe(200);
    expect(h.documents.get(h.projectPath)).toMatchObject({ budgetCurrentYear: 777, settlementLocked: true });
  });
  it('denies unrelated members and cross-project request lookup without writes', async () => {
    const h = harness({ actor: 'outsider' });
    h.documents.get('orgs/mysc/members/outsider').projectIds = [];
    expect((await review(h)).status).toBe(403);
    const own = harness(); own.documents.get(own.requestPath).targetProjectId = 'another'; own.documents.get(own.requestPath).approvedProjectId = 'another';
    const mismatch = await review(own); expect(mismatch.status).toBe(409); expect(mismatch.body.error).toBe('request_project_mismatch');
    expect(h.writes).not.toHaveBeenCalled(); expect(own.writes).not.toHaveBeenCalled();
  });
});

describe('review token compatibility boundaries', () => {
  it('reads a legacy request collection and rejects duplicate collection ambiguity', async () => {
    const h = harness();
    const oldPath = h.requestPath.replace('/project_requests/', '/projectRequests/');
    h.documents.set(oldPath, h.documents.get(h.requestPath)); h.documents.delete(h.requestPath);
    expect((await review(h)).status).toBe(200);
    h.documents.set(h.requestPath, h.documents.get(oldPath));
    const ambiguous = await review(h);
    expect(ambiguous.status).toBe(409); expect(ambiguous.body.error).toBe('request_collection_conflict');
    expect(h.writes).not.toHaveBeenCalled();
  });
  it.each(['expectedRequestVersion', 'expectedProjectVersion'])('rejects mismatching %s even with a valid content token', async field => {
    const h = harness(); const read = await review(h);
    const result = await h.api.post('/api/v1/projects/p001/executive-review').send({ requestId: 'change-p001', reviewStatus: 'APPROVED', expectedReviewToken: read.body.reviewToken, [field]: 999 });
    expect(result.status).toBe(409); expect(result.body.error).toBe('review_version_conflict');
    expect(h.writes).not.toHaveBeenCalled();
  });
});


describe('read-only readiness uses the approval preflight', () => {
  it('keeps an old valid document approvable and describes unrecorded fields as warnings', async () => {
    const h = harness(); const before = structuredClone([...h.documents]); const result = await review(h);
    expect(result.status).toBe(200);
    expect(result.body.readiness.legacy).toBe(true);
    expect(result.body.readiness.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'legacy_submission_format', severity: 'warning' }),
      expect.objectContaining({ code: 'submission_field_unrecorded', field: 'quoteDocument', severity: 'warning' }),
    ]));
    expect(result.body.readiness.issues.some(issue => issue.severity === 'blocking')).toBe(false);
    expect(h.getMetadata).toHaveBeenCalledTimes(1);
    expect([...h.documents]).toEqual(before); expect(h.writes).not.toHaveBeenCalled();
  });
  it('identifies the unavailable attachment without treating access failure as non-submission', async () => {
    const h = harness({ missing: true }); const result = await review(h);
    expect(result.status).toBe(200);
    const issue = result.body.readiness.issues.find(issue => issue.code === 'project_attachment_unavailable');
    expect(issue).toMatchObject({ field: 'contractDocument', severity: 'blocking' });
    expect(issue.title).toContain('계약서'); expect(issue.detail).toContain('접근'); expect(issue.action).toContain('운영 담당자');
    expect(issue.detail).not.toContain('미제출'); expect(h.writes).not.toHaveBeenCalled();
    const failedApproval = await approve(h);
    expect(failedApproval.status).toBe(422); expect(failedApproval.body.error).toBe('project_attachment_unavailable');
  });
  it('blocks unpublished required v2 files with the existing publication policy', async () => {
    const h = harness(); const r = h.documents.get(h.requestPath);
    Object.assign(r, { requestKind: 'REGISTRATION', payload: { registrationRequirementsVersion: 2, executiveApproverId: 'head-a' } });
    const result = await review(h);
    expect(result.status).toBe(200);
    expect(result.body.readiness.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'project_attachments_processing', severity: 'blocking' })]));
    expect(h.writes).not.toHaveBeenCalled();
  });
  it('does not run current storage checks on a historical approved document', async () => {
    const h = harness({ missing: true }); h.documents.get(h.requestPath).status = 'APPROVED';
    const result = await review(h);
    expect(result.status).toBe(200); expect(h.getMetadata).not.toHaveBeenCalled();
    expect(result.body.readiness.issues.some(issue => issue.severity === 'blocking')).toBe(false);
    expect(h.writes).not.toHaveBeenCalled();
  });
  it('reports a stale canonical base before approval without changing either record', async () => {
    const h = harness(); h.documents.get(h.projectPath).version = 10; const before = structuredClone([...h.documents]);
    const result = await review(h); expect(result.status).toBe(200);
    expect(result.body.readiness.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'canonical_version_conflict', severity: 'blocking' })]));
    expect([...h.documents]).toEqual(before); expect(h.writes).not.toHaveBeenCalled();
  });
});
