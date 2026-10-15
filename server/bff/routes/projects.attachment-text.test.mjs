import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { mountProjectRoutes } from './projects.mjs';
import { createProjectRequestContractStorageService } from '../project-request-contract-storage.mjs';
import { makePdf } from '../test-pdf.fixture.mjs';

// 첨부 텍스트 라우트가 기존 다운로드와 같은 권한·경로 검사를 거치는지 확인한다.
const prefix = 'orgs/mysc/project-registration-documents/p001';
const contractPdf = makePdf(['Total contract amount 110,000,000 KRW including VAT for the service period', 'Article 9 Liquidated damages']);

function harness({ actor = 'head-a', role = 'pm', projectIds = [], contractPath = `${prefix}/contract.pdf` } = {}) {
  const attachment = { path: contractPath, name: '계약서.pdf', size: contractPdf.byteLength, contentType: 'application/pdf' };
  const payload = { name: '청년 창업', executiveApproverId: 'head-a', contractDocument: attachment, teamMembersDetailed: [] };
  const documents = new Map([
    ['orgs/mysc/projects/p001', { id: 'p001', name: '청년 창업', version: 1, executiveApproverId: 'head-a', contractDocument: attachment }],
    ['orgs/mysc/project_requests/req-1', { id: 'req-1', targetProjectId: 'p001', requestKind: 'REGISTRATION', requestVersion: 1, status: 'PENDING', proposedSnapshot: payload, payload }],
    [`orgs/mysc/members/${actor}`, { uid: actor, role, status: 'ACTIVE', projectIds }],
  ]);
  const writes = vi.fn();
  const db = {
    doc: (path) => ({ path, get: async () => ({ exists: documents.has(path), data: () => structuredClone(documents.get(path)) }), set: writes, update: writes }),
    collection: (path) => ({ query: true, path, where() { return this; }, get: async () => ({ docs: [] }) }),
    runTransaction: async () => { throw new Error('unexpected transaction'); },
  };
  const download = vi.fn(async () => [contractPdf]);
  const bucket = { file: vi.fn(() => ({ download, getMetadata: async () => [{ contentType: 'application/pdf', size: String(contractPdf.byteLength) }] })) };
  const storage = createProjectRequestContractStorageService({ projectId: 'demo', storage: { bucket: () => bucket } });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.context = { tenantId: 'mysc', actorId: actor, actorRole: role, requestId: 'trace' }; next(); });
  mountProjectRoutes(app, {
    db, now: () => '2026-10-14T08:00:00.000Z', projectRequestContractStorageService: storage,
    idempotencyService: { begin: async () => ({ mode: 'acquired' }), complete: vi.fn(), fail: vi.fn() },
  });
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' }));
  return { api: request(app), download, bucket, writes };
}

describe('project request attachment text', () => {
  const url = '/api/v1/project-requests/req-1/attachments/contract/text';

  it('renders authorized pages and preserves denial and path checks for images', async () => {
    const h = harness();
    const image = await h.api.get(`${url}?format=image&page=1`).expect(200);
    expect(image.body).toMatchObject({ page: 1, pageCount: 2, mimeType: 'image/jpeg' });
    expect(image.headers['cache-control']).toBe('private, no-store');
    expect(h.writes).not.toHaveBeenCalled();
    const other = harness({ actor: 'other-head' });
    await other.api.get(`${url}?format=image&page=1`).expect(403);
    expect(other.download).not.toHaveBeenCalled();
    const forged = harness({ contractPath: 'orgs/other/project-registration-documents/p001/contract.pdf' });
    await forged.api.get(`${url}?format=image&page=1`).expect(409);
    expect(forged.download).not.toHaveBeenCalled();
    await h.api.get(`${url}?format=image&page=0`).expect(400);
  });

  it('gives the designated approver the page texts of the same file the download serves', async () => {
    const h = harness();
    const text = await h.api.get(url).expect(200);
    expect(text.headers['cache-control']).toBe('private, no-store');
    expect(text.body).toMatchObject({ kind: 'contract', name: '계약서.pdf', pageCount: 2, quality: 'ok' });
    expect(text.body.pages[0]).toContain('110,000,000');
    const bytes = await h.api.get('/api/v1/project-requests/req-1/attachments/contract').expect(200);
    expect(bytes.body).toEqual(contractPdf);
    expect(h.writes).not.toHaveBeenCalled();
  });

  it('refuses whoever the download refuses, before reading the file', async () => {
    const other = harness({ actor: 'other-head' });
    expect((await other.api.get(url)).status).toBe(403);
    expect((await other.api.get('/api/v1/project-requests/req-1/attachments/contract')).status).toBe(403);
    expect(other.download).not.toHaveBeenCalled();
  });

  it('refuses a path outside the project prefix the same way as the download', async () => {
    const forged = harness({ contractPath: 'orgs/other/project-registration-documents/p001/contract.pdf' });
    expect((await forged.api.get(url)).status).toBe(409);
    expect(forged.bucket.file).not.toHaveBeenCalled();
  });

  it('rejects unknown kinds and requests', async () => {
    const h = harness();
    expect((await h.api.get('/api/v1/project-requests/req-1/attachments/unknown/text')).status).toBe(400);
    expect((await h.api.get('/api/v1/project-requests/missing/attachments/contract/text')).status).toBe(404);
  });
});

describe('project attachment text', () => {
  const url = '/api/v1/projects/p001/attachments/contract/text';

  it('renders an assigned members page and denies an unrelated member', async () => {
    const h = harness({ actor: 'pm-a', projectIds: ['p001'] });
    const image = await h.api.get(`${url}?format=image&page=2`).expect(200);
    expect(image.body).toMatchObject({ page: 2, pageCount: 2, mimeType: 'image/jpeg' });
    expect(h.writes).not.toHaveBeenCalled();
    const other = harness({ actor: 'pm-b', projectIds: ['p999'] });
    await other.api.get(`${url}?format=image&page=1`).expect(403);
    expect(other.download).not.toHaveBeenCalled();
  });

  it('gives an assigned member the page texts', async () => {
    const h = harness({ actor: 'pm-a', projectIds: ['p001'] });
    const text = await h.api.get(url).expect(200);
    expect(text.body).toMatchObject({ kind: 'contract', pageCount: 2, quality: 'ok' });
    expect(h.writes).not.toHaveBeenCalled();
  });

  it('refuses an unrelated member exactly like the download', async () => {
    const h = harness({ actor: 'pm-b', projectIds: ['p999'] });
    expect((await h.api.get(url)).status).toBe(403);
    expect((await h.api.get('/api/v1/projects/p001/attachments/contract')).status).toBe(403);
    expect(h.download).not.toHaveBeenCalled();
  });
});
