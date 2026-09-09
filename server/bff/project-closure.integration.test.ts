import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createBffApp } from './app.mjs';
import { createFirestoreDb } from './firestore.mjs';
import { assertCashflowMonthWritable } from './cashflow-month-state.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('project closure approval authority', () => {
  const db = createFirestoreDb({ projectId: 'demo-project-closure', appName: 'demo-project-closure' });
  const project = db.doc('orgs/mysc/projects/closure-project');
  const headers = (uid: string) => ({ 'x-tenant-id': 'mysc', 'x-actor-id': uid, 'x-actor-role': 'viewer' });
  const api = () => request(createBffApp({ db, projectId: 'demo-project-closure' }));
  const submission = { expectedProjectVersion: 3, retentionStartDate: '2026-09-09', retentionPeriodYears: 5,
    driveFolderLink: '', handoverNote: '재경팀 보관본 인계', driveDeletedAt: '', note: '' };
  const submit = (key = 'closure-submit') => api().post('/api/v1/projects/closure-project/closure-requests')
    .set({ ...headers('pm'), 'idempotency-key': key }).send(submission);
  const review = (id: string, uid = 'head', decision = 'APPROVED', revision = 1) => api()
    .post(`/api/v1/projects/closure-project/closure-requests/${id}/review`)
    .set({ ...headers(uid), 'idempotency-key': `review-${uid}-${decision}-${revision}` })
    .send({ decision, expectedRequestVersion: revision, comment: decision === 'REJECTED' ? '자료 보완' : '' });

  beforeEach(async () => {
    for (const collection of await db.doc('orgs/mysc').listCollections()) await db.recursiveDelete(collection);
    await db.recursiveDelete(db.collection('idempotency'));
    for (const uid of ['pm', 'head', 'outsider']) await db.doc(`orgs/mysc/members/${uid}`).set({ uid, role: 'viewer', status: 'ACTIVE' });
    await project.set({ id: 'closure-project', tenantId: 'mysc', version: 3, name: '종료 승인 사업',
      managerId: 'pm', registeredById: 'pm', executiveApproverId: 'head', status: 'IN_PROGRESS',
      contractEnd: '2030-12-31', executiveReviewStatus: 'APPROVED' });
    await db.doc('orgs/mysc/cashflow_settlement_statuses/closure-project-2026-09').set({ status: 'WAITING_FOR_UPDATE' });
  });

  it('records a closure request without excluding a project', async () => {
    const result = await submit();
    expect(result.status).toBe(201);
    expect(result.body.item).toMatchObject({ requestKind: 'CLOSURE', status: 'PENDING', requestVersion: 1,
      closureSubmission: { retentionStartDate: '2026-09-09', retentionPeriodYears: 5 } });
    expect((await project.get()).data()?.closure).toBeUndefined();
  });

  it('head approval immediately closes despite a future contract end and unfinished settlements', async () => {
    const submitted = await submit();
    expect(submitted.status).toBe(201);
    const result = await review(submitted.body.item.id);
    expect(result.status).toBe(200);
    expect((await project.get()).data()).toMatchObject({ status: 'COMPLETED', closure: {
      contractVersion: 'project-closure-v1', requestId: submitted.body.item.id, approvedBy: 'head',
    } });
    expect((await db.doc('orgs/mysc/cashflow_settlement_statuses/closure-project-2026-09').get()).data())
      .toEqual({ status: 'WAITING_FOR_UPDATE' });
    expect(result.body.item.status).toBe('APPROVED');
  });

  it('denies non-designated reviewers and preserves the pending request', async () => {
    const submitted = await submit();
    expect(submitted.status).toBe(201);
    expect((await review(submitted.body.item.id, 'outsider')).status).toBe(403);
    expect((await project.get()).data()?.closure).toBeUndefined();
  });

  it('rejects stale project evidence and stale request revisions', async () => {
    const submitted = await submit();
    expect(submitted.status).toBe(201);
    expect((await review(submitted.body.item.id, 'head', 'APPROVED', 0)).status).toBe(409);
    await project.update({ version: 9 });
    expect((await review(submitted.body.item.id)).status).toBe(409);
    expect((await project.get()).data()?.closure).toBeUndefined();
  });

  it('returns for revision without changing registration approval or settlement data', async () => {
    const submitted = await submit();
    expect(submitted.status).toBe(201);
    const result = await review(submitted.body.item.id, 'head', 'REJECTED');
    expect(result.status).toBe(200);
    expect(result.body.item).toMatchObject({ status: 'REJECTED', reviewOutcome: 'REVISION_REJECTED' });
    expect((await project.get()).data()).toMatchObject({ executiveReviewStatus: 'APPROVED', status: 'IN_PROGRESS' });
  });

  it('replays an approval without incrementing the project twice', async () => {
    const submitted = await submit();
    expect(submitted.status).toBe(201);
    const first = await review(submitted.body.item.id);
    expect(first.status).toBe(200);
    const before = (await project.get()).data();
    expect((await review(submitted.body.item.id)).status).toBe(200);
    expect((await project.get()).data()).toEqual(before);
  });

  it('allows stale requests to be returned and resubmitted against the current project', async () => {
    const submitted = await submit();
    await project.update({ version: 9 });
    expect((await review(submitted.body.item.id, 'head', 'REJECTED')).status).toBe(200);
    const next = await api().post('/api/v1/projects/closure-project/closure-requests')
      .set({ ...headers('pm'), 'idempotency-key': 'resubmit-closure' }).send({ ...submission, expectedProjectVersion: 9 });
    expect(next.status).toBe(201);
    expect((await review(next.body.item.id)).status).toBe(200);
  });

  it('blocks BFF settlement draft writes immediately after approval', async () => {
    const submitted = await submit();
    await review(submitted.body.item.id);
    await expect(assertCashflowMonthWritable({ db, tenantId: 'mysc', projectId: 'closure-project', yearMonth: '2030-01' }))
      .rejects.toMatchObject({ code: 'project_closed' });
  });

  it('lets the new designated head return a request after an assignment change', async () => {
    const submitted = await submit();
    await project.update({ version: 9, executiveApproverId: 'outsider' });
    const inbox = await api().get('/api/v1/project-requests/assigned-to-me').set(headers('outsider'));
    expect(inbox.status).toBe(200);
    expect(inbox.body.items.map((item: { id: string }) => item.id)).toContain(submitted.body.item.id);
    expect((await review(submitted.body.item.id, 'head')).status).toBe(403);
    expect((await review(submitted.body.item.id, 'outsider', 'REJECTED')).status).toBe(200);
  });

  it('replays lost approval responses under a new transport key without another audit', async () => {
    const submitted = await submit();
    await review(submitted.body.item.id);
    const before = (await project.get()).data();
    const replay = await api().post(`/api/v1/projects/closure-project/closure-requests/${submitted.body.item.id}/review`)
      .set({ ...headers('head'), 'idempotency-key': 'new-retry-key' })
      .send({ decision: 'APPROVED', expectedRequestVersion: 1, comment: '' });
    expect(replay.status).toBe(200);
    expect((await project.get()).data()).toEqual(before);
    expect((await db.collection('orgs/mysc/project_closure_reviews').get()).size).toBe(1);
  });

  it('rejects unsafe versions and nonexistent calendar dates without creating requests', async () => {
    for (const [key, body] of Object.entries({ badVersion: { ...submission, expectedProjectVersion: null },
      badDate: { ...submission, driveDeletedAt: '2026-99-99' } })) {
      const result = await api().post('/api/v1/projects/closure-project/closure-requests')
        .set({ ...headers('pm'), 'idempotency-key': key }).send(body);
      expect(result.status).toBe(400);
    }
    expect((await db.collection('orgs/mysc/project_requests').get()).empty).toBe(true);
  });

  it('reads the canonical closure pointer even when a newer registration request exists', async () => {
    const submitted = await submit();
    await db.doc('orgs/mysc/project_requests/newer').set({ id: 'newer', tenantId: 'mysc', requestKind: 'REGISTRATION',
      targetProjectId: 'closure-project', requestedAt: '2040-01-01', payload: {} });
    const latest = await api().get('/api/v1/projects/closure-project/latest-request?requestKind=CLOSURE').set(headers('head'));
    expect(latest.status).toBe(200);
    expect(latest.body.item.id).toBe(submitted.body.item.id);
  });

  it('rejects malformed stored review evidence with a controlled conflict', async () => {
    const submitted = await submit();
    await db.doc(`orgs/mysc/project_requests/${submitted.body.item.id}`).update({ payload: null });
    expect((await review(submitted.body.item.id)).status).toBe(409);
    expect((await project.get()).data()?.closure).toBeUndefined();
  });

  it('refuses forged closure facts on the ordinary project write route', async () => {
    const response = await api().post('/api/v1/projects')
      .set({ ...headers('pm'), 'x-actor-role': 'admin', 'idempotency-key': 'forged-closure' })
      .send({ id: 'closure-project', name: '종료 승인 사업', expectedVersion: 3, closure: { approvedBy: 'pm' } });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('project_closure_server_managed');
    expect((await project.get()).data()?.closure).toBeUndefined();
  });
});
