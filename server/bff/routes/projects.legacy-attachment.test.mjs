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
  const getMetadata = vi.fn(async () => {
    if (missing) throw new Error('not found');
    if (changeDuringInspection) documents.get(projectPath).contractDocument = { ...attachment, path: `orgs/mysc/${prefix}/pm-a/changed.pdf` };
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
  return { api: request(app), documents, attachment, writes, bucket, download, projectPath, requestPath };
}

const approve = h => h.api.post('/api/v1/projects/p001/executive-review').send({ requestId: 'change-p001', reviewStatus: 'APPROVED' });

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
    expect(response.body.error).toBe('canonical_version_conflict');
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
