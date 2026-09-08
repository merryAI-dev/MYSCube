import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { getStorage } from 'firebase-admin/storage';
import { createBffApp } from './app.mjs';
import { createFirestoreDb, getOrInitAdminApp } from './firestore.mjs';
import { createProjectRequestContractStorageService } from './project-request-contract-storage.mjs';
import { resolveProjectRequestDocuments } from './routes/projects.mjs';
import { PROJECT_DOCUMENT_FIELD_BY_KIND } from './project-document-validation.mjs';

const describeWithStorage = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST ? describe : describe.skip;

describeWithStorage('project review SSOT with persisted Firestore and real document fixtures', () => {
  const projectId = 'demo-project-review-ssot';
  const db = createFirestoreDb({ projectId, appName: projectId });
  const bucket = getStorage(getOrInitAdminApp({ projectId, appName: projectId })).bucket(`${projectId}.firebasestorage.app`);
  const storage = createProjectRequestContractStorageService({ projectId, bucketName: bucket.name, storage: { bucket: () => bucket } });
  const projectRef = db.doc('orgs/mysc/projects/p001');
  const requestRef = db.doc('orgs/mysc/project_requests/pr001');
  const memberRef = db.doc('orgs/mysc/members/head-a');
  const partRef = db.doc('orgs/mysc/partEntries/manual');
  const documents: Record<string, any> = {};
  const headers = { 'x-tenant-id': 'mysc', 'x-actor-id': 'head-a', 'x-actor-role': 'viewer' };

  async function clean() {
    for (const collection of await db.doc('orgs/mysc').listCollections()) await db.recursiveDelete(collection);
  }

  beforeAll(async () => {
    for (const [field, fileName, contentType] of [
      ['contractDocument', 'project-registration-attachment.pdf', 'application/pdf'],
      ['customerBusinessRegistrationDocument', 'project-registration-attachment.pdf', 'application/pdf'],
      ['quoteDocument', 'project-registration-attachment.pdf', 'application/pdf'],
      ['proposalWordOriginalDocument', 'project-registration-attachment.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['proposalPptOriginalDocument', 'mola-project-attachment.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ]) {
      const buffer = await readFile(new URL(`./fixtures/${fileName}`, import.meta.url));
      const path = `orgs/mysc/project-registration-documents/p001/${field}-${fileName}`;
      await bucket.file(path).save(buffer, { resumable: false, metadata: { contentType, metadata: { attachmentId: field } } });
      documents[field] = { path, name: fileName, size: buffer.length, contentType, attachmentId: field };
    }
  });

  beforeEach(async () => {
    await clean();
    await memberRef.set({ uid: 'head-a', role: 'viewer', status: 'ACTIVE' });
    await projectRef.set({ id: 'p001', version: 3, name: '승인 원장', executiveApproverId: 'head-a', executiveReviewStatus: 'PENDING',
      contractDocument: { ...documents.contractDocument, downloadURL: 'https://old.example/token', oldMetadata: 'remove' } });
    await requestRef.set({ id: 'untrusted-id', requestKind: 'REGISTRATION', status: 'PENDING', requestVersion: 1,
      approvedProjectId: 'p001', targetProjectId: 'p001', requestedAt: '2026-09-08T00:00:00Z',
      registrationAttachmentsPublishedAt: '2026-09-08T00:00:00Z',
      payload: { executiveApproverId: 'head-a', registrationRequirementsVersion: 2, ...documents } });
    await partRef.set({ projectId: 'p001', source: 'MANUAL', rate: 20 });
  });

  afterAll(async () => {
    await clean();
    for (const document of Object.values(documents)) await bucket.file(document.path).delete({ ignoreNotFound: true });
  });

  function api(inspect = storage.inspectProjectRegistrationAttachment, reviewDb = db) {
    const inspectSpy = vi.fn(inspect);
    const notifyMessage = vi.fn(async () => ({}));
    const client = request(createBffApp({ projectId, db: reviewDb,
      projectRequestContractStorageService: { ...storage, inspectProjectRegistrationAttachment: inspectSpy },
      projectRegistrationSlackService: { enabled: true, notifyMessage } }));
    const approve = () => client.post('/api/v1/projects/p001/executive-review').set({ ...headers, 'idempotency-key': 'ssot-approve' })
      .send({ requestId: 'pr001', reviewStatus: 'APPROVED' });
    return { client, approve, inspectSpy, notifyMessage };
  }

  it('keeps damaged published requests visible and prevents all approval side effects', async () => {
    await requestRef.update({ 'payload.quoteDocument': null });
    const h = api();
    const before = (await projectRef.get()).data();
    const assigned = await h.client.get('/api/v1/project-requests/assigned-to-me').set(headers);
    expect(assigned.status).toBe(200);
    expect(assigned.body.items[0]).toMatchObject({ id: 'pr001', attachmentReviewStatus: 'REPAIR_REQUIRED' });
    expect(h.inspectSpy).not.toHaveBeenCalled();
    expect((await h.approve()).status).toBe(409);
    expect((await projectRef.get()).data()).toEqual(before);
    expect((await requestRef.get()).data()?.status).toBe('PENDING');
    expect((await db.collection('orgs/mysc/partEntries').get()).size).toBe(1);
    expect(h.notifyMessage).not.toHaveBeenCalled();
  });

  it.each(['project_requests', 'projectRequests'].flatMap((collection) => (
    ['CHANGE', 'REGISTRATION', null].map((kind) => ({ collection, kind }))
  )))('does not expose an old assignment when the newer $collection/$kind request and Project name another approver', async ({ collection, kind }) => {
    await projectRef.update({ executiveApproverId: 'head-b' });
    await requestRef.update({ requestKind: 'CHANGE', requestedAt: '2026-09-01T00:00:00Z' });
    await db.doc(`orgs/mysc/${collection}/newer`).set({ ...(kind ? { requestKind: kind } : {}), targetProjectId: 'p001',
      requestedAt: '2026-09-08T00:00:00Z', status: 'PENDING',
      payload: { executiveApproverId: 'head-b', registrationRequirementsVersion: 1 } });
    const h = api();
    const response = await h.client.get('/api/v1/project-requests/assigned-to-me').set(headers);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [], projects: [] });
    expect(h.inspectSpy).not.toHaveBeenCalled();
  });

  it('blocks a canonical reference whose Storage object is missing', async () => {
    await requestRef.update({ 'payload.contractDocument.path': `${documents.contractDocument.path}-missing` });
    const h = api();
    const before = (await projectRef.get()).data();
    expect((await h.approve()).status).toBe(422);
    expect((await projectRef.get()).data()).toEqual(before);
    expect((await requestRef.get()).data()?.status).toBe('PENDING');
    expect(h.notifyMessage).not.toHaveBeenCalled();
  });

  it('preserves legacy document access but denies Project approver fallback for modern requests', async () => {
    const h = api();
    for (const kind of ['REGISTRATION', 'CHANGE']) {
      await requestRef.update({ requestKind: kind, 'payload.executiveApproverId': null });
      const response = await h.client.get('/api/v1/project-requests/pr001/attachments/contract').set(headers);
      expect(response.status).toBe(403);
    }
    await requestRef.update({ requestKind: 'REGISTRATION', 'payload.registrationRequirementsVersion': 1 });
    const legacy = await h.client.get('/api/v1/project-requests/pr001/attachments/contract').set(headers);
    expect(legacy.status).toBe(200);
    expect(legacy.body).toEqual(await readFile(new URL('./fixtures/project-registration-attachment.pdf', import.meta.url)));
    await requestRef.update({ 'payload.registrationRequirementsVersion': 2 });
    await memberRef.update({ role: 'finance' });
    expect((await h.client.get('/api/v1/project-requests/pr001/attachments/contract').set({ ...headers, 'x-actor-role': 'finance' })).status).toBe(200);
  });

  it('resolves the newest target-only legacy collection request while preserving explicit identity', async () => {
    await db.doc('orgs/mysc/projectRequests/newer').set({ id: 'forged-newer', requestKind: 'CHANGE', targetProjectId: 'p001', requestedAt: '2026-09-09T00:00:00Z' });
    const implicit = await resolveProjectRequestDocuments({ db, tenantId: 'mysc', projectId: 'p001' });
    expect(implicit.requestId).toBe('newer');
    expect(implicit.request.id).toBe('newer');
    const explicit = await resolveProjectRequestDocuments({ db, tenantId: 'mysc', projectId: 'p001', requestId: 'pr001' });
    expect(explicit.requestId).toBe('pr001');
    expect(explicit.request.id).toBe('pr001');
  });

  it.each(['metadata', 'deleted', 'member'])('rejects delayed inspection after a persisted %s change', async (change) => {
    const before = (await projectRef.get()).data();
    let changed = false;
    const h = api(async (input) => {
      const result = await storage.inspectProjectRegistrationAttachment(input);
      if (!changed) {
        changed = true;
        if (change === 'metadata') await requestRef.update({ 'payload.contractDocument.downloadURL': 'https://changed.example' });
        if (change === 'deleted') await requestRef.delete();
        if (change === 'member') await memberRef.update({ status: 'INACTIVE' });
      }
      return result;
    });
    expect((await h.approve()).status).toBe(change === 'member' ? 403 : 409);
    expect((await projectRef.get()).data()).toEqual(before);
    expect((await requestRef.get()).data()?.status).toBe(change === 'deleted' ? undefined : 'PENDING');
    expect((await partRef.get()).data()).toEqual({ projectId: 'p001', source: 'MANUAL', rate: 20 });
    expect((await db.collection('orgs/mysc/partEntries').get()).size).toBe(1);
    expect(h.notifyMessage).not.toHaveBeenCalled();
  });

  it('replaces document maps exactly, inspects once across a real transaction retry, and replays idempotently', async () => {
    await projectRef.update(Object.fromEntries(Object.values(PROJECT_DOCUMENT_FIELD_BY_KIND).map((field: string) => [field,
      { ...documents.contractDocument, downloadURL: 'https://old.example/token', oldMetadata: 'remove' }])));
    await requestRef.update({ requestKind: 'CHANGE', baseProjectVersion: 3, targetProjectVersion: 4,
      proposedSnapshot: { name: '변경 승인', executiveApproverId: 'head-a',
        ...Object.fromEntries(Object.values(PROJECT_DOCUMENT_FIELD_BY_KIND).map((field: string) => [field, documents[field] || null])) } });
    const originalRunTransaction = db.runTransaction.bind(db);
    let attempts = 0;
    const reviewDb = Object.create(db);
    reviewDb.runTransaction = (handler, options) => originalRunTransaction(async (tx) => {
      const result = await handler(tx);
      if (result?.data?.executiveReviewStatus === 'APPROVED' && ++attempts === 1) {
        throw Object.assign(new Error('Force Firestore retry after staged writes'), { code: 10 });
      }
      return result;
    }, options);
    const h = api(storage.inspectProjectRegistrationAttachment, reviewDb);
    const approved = await h.approve();
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(attempts).toBe(2);
    expect(h.inspectSpy).toHaveBeenCalledTimes(Object.keys(documents).length);
    const project = (await projectRef.get()).data();
    expect(project?.version).toBe(4);
    expect(project?.contractDocument).toEqual(documents.contractDocument);
    for (const field of Object.values(PROJECT_DOCUMENT_FIELD_BY_KIND)) expect(project?.[field]).toEqual(documents[field] || null);
    expect((await requestRef.get()).data()?.status).toBe('APPROVED');
    expect((await partRef.get()).data()?.rate).toBe(20);
    const replay = await h.approve();
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(approved.body);
    expect((await projectRef.get()).data()).toEqual(project);
    expect(h.inspectSpy).toHaveBeenCalledTimes(Object.keys(documents).length);
    expect(h.notifyMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['metadata', 'deleted', 'member', 'role'])('management planning rejects an inspected request or membership %s change without code claims', async (change) => {
    await memberRef.update({ role: 'finance' });
    await projectRef.update({ executiveReviewStatus: 'APPROVED' });
    await requestRef.update({ status: 'APPROVED' });
    const before = (await projectRef.get()).data();
    let changed = false;
    const h = api(async (input) => {
      const result = await storage.inspectProjectRegistrationAttachment(input);
      if (!changed) {
        changed = true;
        if (change === 'metadata') await requestRef.update({ 'payload.contractDocument.downloadURL': 'https://changed.example' });
        if (change === 'deleted') await requestRef.delete();
        if (change === 'member') await memberRef.update({ status: 'INACTIVE' });
        if (change === 'role') await memberRef.update({ role: 'viewer' });
      }
      return result;
    });
    const response = await h.client.post('/api/v1/projects/p001/management-planning-review')
      .set({ ...headers, 'x-actor-role': 'finance', 'idempotency-key': 'management-race' })
      .send({ requestId: 'pr001', reviewStatus: 'AGREED', projectCode: 'SSOT-001' });
    expect(response.status).toBe(['member', 'role'].includes(change) ? 403 : 409);
    expect((await projectRef.get()).data()).toEqual(before);
    expect((await db.doc('orgs/mysc/projectCodeClaims/SSOT-001').get()).exists).toBe(false);
    expect((await db.collection('orgs/mysc/partEntries').get()).size).toBe(1);
    expect(h.notifyMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['CHANGE', 'APPROVED', 'PENDING'],
    ['CHANGE', 'REVISION_REJECTED', 'APPROVED'],
    ['REGISTRATION', 'PENDING', 'APPROVED'],
  ])('management planning honors %s with Project %s and Request %s', async (kind, projectStatus, requestStatus) => {
    await memberRef.update({ role: 'finance' });
    await projectRef.update({ executiveReviewStatus: projectStatus });
    await requestRef.update({ requestKind: kind, status: requestStatus });
    const h = api();
    const before = (await projectRef.get()).data();
    const response = await h.client.post('/api/v1/projects/p001/management-planning-review')
      .set({ ...headers, 'x-actor-role': 'finance', 'idempotency-key': 'management-stage' })
      .send({ requestId: 'pr001', reviewStatus: 'AGREED', projectCode: 'SSOT-001' });
    expect(response.status).toBe(409);
    expect((await projectRef.get()).data()).toEqual(before);
    expect((await db.doc('orgs/mysc/projectCodeClaims/SSOT-001').get()).exists).toBe(false);
    expect(h.notifyMessage).not.toHaveBeenCalled();
  });

  it('allows management planning to reject damaged attachments without inspecting Storage', async () => {
    await memberRef.update({ role: 'finance' });
    await projectRef.update({ executiveReviewStatus: 'APPROVED' });
    await requestRef.update({ status: 'APPROVED', 'payload.quoteDocument': null });
    const h = api();
    const response = await h.client.post('/api/v1/projects/p001/management-planning-review')
      .set({ ...headers, 'x-actor-role': 'finance', 'idempotency-key': 'management-reject' })
      .send({ requestId: 'pr001', reviewStatus: 'REVISION_REJECTED', reviewComment: '제출 파일 보완 필요' });
    expect(response.status).toBe(200);
    expect((await projectRef.get()).data()?.managementPlanningReviewStatus).toBe('REVISION_REJECTED');
    expect(h.inspectSpy).not.toHaveBeenCalled();
    expect(h.notifyMessage).not.toHaveBeenCalled();
  });

  it('allows a repaired registration with pending Request status when its Project organization-head approval remains valid', async () => {
    await memberRef.update({ role: 'finance' });
    await projectRef.update({ executiveReviewStatus: 'APPROVED', managementPlanningReviewStatus: 'REVISION_REJECTED' });
    const h = api();
    const response = await h.client.post('/api/v1/projects/p001/management-planning-review')
      .set({ ...headers, 'x-actor-role': 'finance', 'idempotency-key': 'management-repaired' })
      .send({ requestId: 'pr001', reviewStatus: 'AGREED', projectCode: 'SSOT-001' });
    expect(response.status).toBe(200);
    expect((await projectRef.get()).data()?.managementPlanningReviewStatus).toBe('AGREED');
    expect((await db.doc('orgs/mysc/projectCodeClaims/SSOT-001').get()).data()?.projectId).toBe('p001');
    expect(h.inspectSpy).toHaveBeenCalledTimes(Object.keys(documents).length);
    expect(h.notifyMessage).toHaveBeenCalledTimes(1);
  });
});
