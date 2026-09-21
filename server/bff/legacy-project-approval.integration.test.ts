import { projectReviewVersionToken } from './project-review-version.mjs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createBffApp } from './app.mjs';
import { createFirestoreDb } from './firestore.mjs';
import { createProjectRequestContractStorageService } from './project-request-contract-storage.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('legacy project approval persistence (emulator only)', () => {
  const db = createFirestoreDb({ projectId: 'demo-legacy-project-approval' });
  const tenantId = 'legacy-approval-test';
  const projectRef = db.doc(`orgs/${tenantId}/projects/p001`);
  const requestRef = db.doc(`orgs/${tenantId}/project_requests/change-p001`);
  const attachment = { path: `orgs/${tenantId}/project-request-contracts/pm-a/123-contract.pdf`, name: '기존 계약서.pdf', size: 9, contentType: 'application/pdf' };
  const fileWrites = vi.fn();
  const storage = createProjectRequestContractStorageService({ projectId: 'demo-legacy-project-approval', storage: {
    bucket: () => ({ file: () => ({ getMetadata: async () => [{ size: '9', contentType: 'application/pdf', generation: '1' }],
      download: async () => [Buffer.from('%PDF-1.4\n')], save: fileWrites, delete: fileWrites, copy: fileWrites }) }),
  } });
  const api = request(createBffApp({ db, projectId: 'demo-legacy-project-approval', authMode: 'headers',
    projectRequestContractStorageService: storage, env: { ...process.env, BFF_DEPLOY_ENV: 'local', BFF_SCHEDULER_OWNER: 'disabled' } }));
  const headers = (actor = 'head-a') => ({ 'x-tenant-id': tenantId, 'x-actor-id': actor, 'x-actor-role': 'admin', 'x-actor-email': `${actor}@mysc.co.kr` });
  beforeEach(async () => {
    for (const collection of ['projects', 'project_requests', 'members', 'idempotency_keys', 'audit_logs', 'partEntries']) {
      const snap = await db.collection(`orgs/${tenantId}/${collection}`).get();
      if (!snap.empty) { const batch = db.batch(); snap.docs.forEach(doc => batch.delete(doc.ref)); await batch.commit(); }
    }
    fileWrites.mockClear();
    await projectRef.set({ id: 'p001', tenantId, name: 'Before', version: 9, executiveReviewStatus: 'APPROVED',
      executiveApproverId: 'head-a', contractDocument: attachment, executiveReviewHistory: [{ status: 'APPROVED', reviewedAt: '2026-08-01' }] });
    await requestRef.set({ id: 'change-p001', targetProjectId: 'p001', approvedProjectId: 'p001', status: 'PENDING', requestKind: 'CHANGE',
      requestVersion: 2, baseProjectVersion: 9, targetProjectVersion: 10,
      proposedSnapshot: { name: 'After', executiveApproverId: 'head-a', contractDocument: attachment, teamMembersDetailed: [] } });
    for (const uid of ['head-a', 'other-head']) await db.doc(`orgs/${tenantId}/members/${uid}`).set({ uid, role: 'admin', status: 'ACTIVE', projectIds: ['p001'] });
  });
  afterAll(async () => { await db.terminate(); });

  it('persists approval once, preserves the original reference and serves it after approval', async () => {
    const expectedReviewToken = projectReviewVersionToken((await projectRef.get()).data(), (await requestRef.get()).data());
    const submit = () => api.post('/api/v1/projects/p001/executive-review').set(headers()).set('idempotency-key', 'legacy-approved-once')
      .send({ requestId: 'change-p001', reviewStatus: 'APPROVED', expectedReviewToken });
    const first = await submit();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const replay = await submit();
    expect(replay.status).toBe(200);
    expect(replay.headers['x-idempotency-replayed']).toBe('1');
    const project = (await projectRef.get()).data();
    expect(project).toMatchObject({ version: 10, name: 'After', contractDocument: attachment, executiveReviewStatus: 'APPROVED' });
    expect(project?.executiveReviewHistory).toHaveLength(2);
    expect((await requestRef.get()).data()?.status).toBe('APPROVED');
    const download = await api.get('/api/v1/projects/p001/attachments/contract').set(headers());
    expect(download.status).toBe(200);
    expect(download.body).toEqual(Buffer.from('%PDF-1.4\n'));
    expect(fileWrites).not.toHaveBeenCalled();
  });

  it('leaves project and request unchanged for unauthorized review and forged references', async () => {
    const beforeProject = (await projectRef.get()).data();
    const beforeRequest = (await requestRef.get()).data();
    const denied = await api.post('/api/v1/projects/p001/executive-review').set(headers('other-head')).set('idempotency-key', 'legacy-denied')
      .send({ requestId: 'change-p001', reviewStatus: 'APPROVED', expectedReviewToken: projectReviewVersionToken((await projectRef.get()).data(), (await requestRef.get()).data()) });
    expect(denied.status).toBe(403);
    expect((await projectRef.get()).data()).toEqual(beforeProject);
    expect((await requestRef.get()).data()).toEqual(beforeRequest);
    await requestRef.update({ 'proposedSnapshot.contractDocument.path': `orgs/${tenantId}/project-request-contracts/other/other.pdf` });
    const forged = (await requestRef.get()).data();
    const rejected = await api.post('/api/v1/projects/p001/executive-review').set(headers()).set('idempotency-key', 'legacy-forged')
      .send({ requestId: 'change-p001', reviewStatus: 'APPROVED', expectedReviewToken: projectReviewVersionToken((await projectRef.get()).data(), (await requestRef.get()).data()) });
    expect(rejected.status).toBe(422);
    expect((await projectRef.get()).data()).toEqual(beforeProject);
    expect((await requestRef.get()).data()).toEqual(forged);
    expect(fileWrites).not.toHaveBeenCalled();
  });
});
