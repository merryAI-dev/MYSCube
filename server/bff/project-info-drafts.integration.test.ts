import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import request from 'supertest';
import { createBffApp } from './app.mjs';
import { createFirestoreDb } from './firestore.mjs';

const describeIfEmulator = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
const VALID_PDF = Buffer.from('%PDF-1.4\n');

describeIfEmulator('project information private drafts (Firestore emulator)', () => {
  const firebaseProjectId = 'demo-project-info-drafts';
  const tenantId = 'tenant-project-info-drafts';
  const db = createFirestoreDb({ projectId: firebaseProjectId });
  let nowMs = Date.parse('2026-07-12T00:00:00.000Z');
  let attachmentSequence = 0;
  let outboxSequence = 0;
  const storedAttachments = new Map<string, Record<string, any>>();
  const storage = {
    uploadProjectRegistrationAttachment: vi.fn(async (input: Record<string, any>) => {
      const attachment = {
        path: `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${input.attachmentId}-${input.fileName}`,
        name: input.fileName,
        size: input.buffer.byteLength,
        contentType: input.mimeType,
        uploadedAt: new Date(nowMs).toISOString(),
        attachmentId: input.attachmentId,
        draftId: input.draftId,
      };
      storedAttachments.set(attachment.path, attachment);
      return attachment;
    }),
    inspectProjectRegistrationAttachment: vi.fn(async ({ path }: Record<string, any>) => {
      const attachment = storedAttachments.get(path);
      if (!attachment) throw new Error('stored attachment not found');
      return attachment;
    }),
    deleteProjectRegistrationAttachment: vi.fn(async ({ path }: Record<string, any>) => {
      storedAttachments.delete(path);
    }),
  };
  const server = createServer(createBffApp({
    projectId: firebaseProjectId,
    db,
    authMode: 'headers',
    now: () => new Date(nowMs).toISOString(),
    editLeasesEnabled: true,
    createProjectInfoAttachmentId: () => `info-attachment-${++attachmentSequence}`,
    createProjectInfoOutboxEvent: (input: Record<string, any>) => ({
      id: `project-info-outbox-${++outboxSequence}`,
      ...input,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: input.createdAt,
      updatedAt: input.createdAt,
    }),
    projectRegistrationDraftStorageService: storage,
    workerSecret: 'project-info-worker-secret',
    workerAuthPolicy: {
      deployEnv: 'local', schedulerOwner: 'manual',
      secrets: { manual: 'project-info-worker-secret', vercel: '', k8s: '' },
    },
    env: {
      ...process.env,
      BFF_DEPLOY_ENV: 'local',
      BFF_SCHEDULER_OWNER: 'disabled',
    },
  }));
  const api = request(server);

  function actorHeaders(actorId = 'actor-a', role = 'pm') {
    return {
      'x-tenant-id': tenantId,
      'x-actor-id': actorId,
      'x-actor-role': role,
      'x-actor-name': actorId,
      'x-actor-email': `${actorId}@example.com`,
    };
  }

  function validPayload(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Project A', officialContractName: 'Project A contract', type: 'D1',
      status: 'IN_PROGRESS', phase: 'CONFIRMED', description: 'Before', clientOrg: 'Client',
      department: 'AXR', currency: 'KRW', contractAmount: 100000, salesVatAmount: 10000,
      totalRevenueAmount: 40000, supportAmount: 0, financialInputFlags: { contractAmount: true },
      registrationRequirementsVersion: 2,
      financialYears: [{
        year: 2026,
        contractAmount: 100000,
        salesVatAmount: 10000,
        totalRevenueAmount: 40000,
        supportAmount: 0,
        profitRate: 0.4,
        confirmed: true,
      }],
      registrationConfirmations: {
        laborIncludesFourInsurance: true,
        laborIncludesRetirementPay: true,
        customerSettlementBasisConfirmed: true,
        modusignContractUsed: true,
        originalContractSubmitted: null,
      },
      registrationOptionalDocumentNotes: {
        proposalWordOriginal: '고객사 미제공',
        proposalPptOriginal: '해당 없음',
        presentationPptOriginal: '해당 없음',
      },
      contractStart: '2026-07-01', contractEnd: '2026-12-31', contractType: '계약서(날인)',
      settlementType: 'TYPE1', basis: '공급가액', accountType: 'OPERATING', fundInputMode: 'BANK_UPLOAD',
      paymentPlan: { contract: 100000, interim: 0, final: 0 }, paymentPlanDesc: '선금 100%',
      paymentExpectedMonths: { contract: '2026-07', interim: '', final: '' },
      advanceInterimBelow70Reason: '',
      settlementGuide: '', finalPaymentNote: '', projectPurpose: 'Purpose',
      registeredById: 'actor-a', registeredByName: 'actor-a', managerId: 'actor-a', managerName: 'actor-a',
      executiveApproverId: 'executive-a', executiveApproverName: 'Executive A', executiveApproverEmail: 'executive-a@example.com',
      teamName: 'AXR', teamMembers: '', teamMembersDetailed: [{
        memberName: 'actor-a', memberNickname: 'Actor', role: '운영매니저',
        participationRate: 100, isDocumentOnly: false,
      }, {
        memberName: 'Executive A', memberNickname: 'Executive', role: '사업 최종 책임자',
        participationRate: 0, isDocumentOnly: false,
      }], participantCondition: '', note: '',
      contractDocument: {
        path: `orgs/${tenantId}/project-registration-documents/project-a/contract.pdf`,
      },
      customerBusinessRegistrationDocument: {
        path: `orgs/${tenantId}/project-registration-documents/project-a/customer-business-registration.pdf`,
      },
      quoteDocument: {
        path: `orgs/${tenantId}/project-registration-documents/project-a/quote.pdf`,
      },
      proposalDocument: {
        path: `orgs/${tenantId}/project-registration-documents/project-a/proposal.pdf`,
      },
      proposalWordOriginalDocument: null,
      proposalPptOriginalDocument: null,
      presentationPptOriginalDocument: null,
      rfpRequestEvidenceDocument: null,
      contractAnalysis: null,
      ...overrides,
    };
  }

  async function clearCollection(path: string) {
    const snap = await db.collection(path).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((document) => batch.delete(document.ref));
    await batch.commit();
  }

  async function reset() {
    await Promise.all([
      'members', 'projects', 'project_requests', 'projectRequests', 'privateEditDrafts', 'editLeases',
      'audit_logs', 'audit_chain', 'idempotency_keys', 'outbox_deliveries',
    ].map((name) => clearCollection(`orgs/${tenantId}/${name}`)));
    await clearCollection('outbox');
    const batch = db.batch();
    batch.set(db.doc(`orgs/${tenantId}/members/actor-a`), {
      uid: 'actor-a', role: 'pm', status: 'ACTIVE', projectIds: ['project-a'],
    });
    batch.set(db.doc(`orgs/${tenantId}/members/actor-admin`), {
      uid: 'actor-admin', role: 'admin', status: 'ACTIVE', projectIds: [],
    });
    batch.set(db.doc(`orgs/${tenantId}/projects/project-a`), {
      id: 'project-a', tenantId, version: 3, executiveReviewStatus: 'APPROVED',
      executiveReviewedAt: '2026-07-01T09:00:00.000Z',
      executiveReviewedById: 'organization-head',
      executiveReviewedByName: '조직장',
      executiveReviewComment: '기존 승인 메모',
      executiveReviewHistory: [], ...validPayload(),
    });
    await batch.commit();
    nowMs = Date.parse('2026-07-12T00:00:00.000Z');
    attachmentSequence = 0;
    outboxSequence = 0;
    storedAttachments.clear();
    vi.clearAllMocks();
  }

  async function acquire(idempotencyKey = 'lease-acquire-a') {
    return api
      .post('/api/v1/edit-leases/project-info/project-a/acquire')
      .set({ ...actorHeaders(), 'x-edit-session-id': 'session-a', 'idempotency-key': idempotencyKey })
      .send({});
  }

  function mutationHeaders(lease: any, key: string) {
    return {
      ...actorHeaders(),
      'x-edit-session-id': 'session-a',
      'x-edit-lease-id': lease.leaseId,
      'x-edit-fence': String(lease.fence),
      'idempotency-key': key,
    };
  }

  // Match Supertest's IPv4 target; macOS can bind :: on an occupied IPv4 loopback port.
  beforeAll(() => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)));
  beforeEach(reset, 60_000);
  afterAll(async () => {
    try {
      await reset();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 60_000);

  it('blocks an older private draft across sequential leases and binds file selection to the previewed Request (real Firestore, StorageMap)', async () => {
    await db.doc(`orgs/${tenantId}/members/actor-b`).set({ uid: 'actor-b', role: 'pm', status: 'ACTIVE' });
    const basePath = '/api/v1/project-info-drafts/project-a';
    const aLease = await acquire('rebase-acquire-A');
    expect(aLease.body).toMatchObject({ canEdit: true, state: 'ACTIVE', leaseId: expect.any(String) });
    let a = mutationHeaders(aLease.body, 'rebase-open-A');
    expect((await api.post(`${basePath}/open`).set(a).send({})).status).toBe(200);
    const upload = (headers: Record<string, string>, name: string) => api.post(`${basePath}/attachments`).set({ ...headers, 'idempotency-key': `rebase-upload-${name}` }).send({ expectedDraftRevision: 0, documentKind: 'contract', fileName: `${name}.pdf`, mimeType: 'application/pdf', fileSize: VALID_PDF.byteLength, contentBase64: VALID_PDF.toString('base64') });
    const uploadedA = await upload(a, 'A');
    expect(uploadedA.status).toBe(200);
    expect((await api.post('/api/v1/edit-leases/project-info/project-a/release').set({ ...a, 'idempotency-key': 'rebase-release-A' }).send({})).status).toBe(200);
    const bLease = await api.post('/api/v1/edit-leases/project-info/project-a/acquire').set({ ...actorHeaders('actor-b'), 'x-edit-session-id': 'session-b', 'idempotency-key': 'rebase-acquire-B' }).send({});
    expect(bLease.status).toBe(200);
    expect(bLease.body).toMatchObject({ canEdit: true, state: 'ACTIVE', leaseId: expect.any(String) });
    const b = { ...mutationHeaders(bLease.body, 'rebase-open-B'), ...actorHeaders('actor-b'), 'x-edit-session-id': 'session-b' };
    expect((await api.post(`${basePath}/open`).set(b).send({})).status).toBe(200);
    const uploadedB = await upload(b, 'B');
    expect(uploadedB.status).toBe(200);
    expect((await api.post(`${basePath}/submit`).set({ ...b, 'idempotency-key': 'rebase-submit-B' }).send({ expectedDraftRevision: 1, expectedVersion: 3 })).status).toBe(200);
    const reacquiredA = await acquire('rebase-reacquire-A');
    expect(reacquiredA.body).toMatchObject({ canEdit: true, state: 'ACTIVE', leaseId: expect.any(String) });
    a = mutationHeaders(reacquiredA.body, 'rebase-reopen-A');
    expect((await api.post(`${basePath}/open`).set(a).send({})).status).toBe(200);
    const requestRef = db.doc(`orgs/${tenantId}/project_requests/change-project-a`);
    const before = (await requestRef.get()).data()!;
    const auditCount = (await db.collection(`orgs/${tenantId}/audit_logs`).get()).size;
    const outboxCount = (await db.collection('outbox').get()).size;
    const rejected = await api.post(`${basePath}/submit`).set({ ...a, 'idempotency-key': 'rebase-submit-A' }).send({ expectedDraftRevision: 1, expectedVersion: 3 });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toBe('draft_source_conflict');
    expect((await requestRef.get()).data()).toEqual(before);
    expect((await db.doc(`orgs/${tenantId}/projects/project-a`).get()).data()?.version).toBe(3);
    expect((await db.collection(`orgs/${tenantId}/audit_logs`).get()).size).toBe(auditCount);
    expect((await db.collection('outbox').get()).size).toBe(outboxCount);
    const preview = await api.post(`${basePath}/rebase`).set({ ...a, 'idempotency-key': 'rebase-preview-B' }).send({ expectedDraftRevision: 1 });
    expect(preview.status).toBe(200);
    expect(preview.body.conflicts).toContainEqual(expect.objectContaining({ field: 'contractDocument', mine: expect.objectContaining({ name: 'A.pdf' }), theirs: expect.objectContaining({ name: 'B.pdf' }) }));
    await requestRef.set({ ...before, requestVersion: 2, proposedSnapshot: { ...before.proposedSnapshot, name: 'C' } });
    const applyInput = { expectedDraftRevision: 1, sourceFingerprint: preview.body.sourceFingerprint, resolutions: { contractDocument: 'THEIRS' } };
    const stale = await api.post(`${basePath}/rebase`).set({ ...a, 'idempotency-key': 'rebase-apply-stale' }).send(applyInput);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('draft_source_conflict');
    const refreshed = await api.post(`${basePath}/rebase`).set({ ...a, 'idempotency-key': 'rebase-preview-C' }).send({ expectedDraftRevision: 1 });
    expect(refreshed.status).toBe(200);
    const applied = await api.post(`${basePath}/rebase`).set({ ...a, 'idempotency-key': 'rebase-apply-C' }).send({ ...applyInput, sourceFingerprint: refreshed.body.sourceFingerprint });
    expect(applied.status).toBe(200);
    expect(applied.body.draft.payload.contractDocument.path).toBe(uploadedB.body.attachment.path);
    expect(applied.body.draft.attachmentRefs[0].path).toBe(uploadedB.body.attachment.path);
    const read = await api.get(basePath).set(actorHeaders());
    expect(read.body.draft).toEqual(applied.body.draft);
    expect((await api.post(`${basePath}/submit`).set({ ...a, 'idempotency-key': 'rebase-submit-C' }).send({ expectedDraftRevision: 2, expectedVersion: 3 })).status).toBe(200);
    expect((await requestRef.get()).data()?.proposedSnapshot.contractDocument.path).toBe(uploadedB.body.attachment.path);
    expect(storedAttachments.has(uploadedA.body.attachment.path)).toBe(true);
    expect(storedAttachments.has(uploadedB.body.attachment.path)).toBe(true);
    expect(storage.deleteProjectRegistrationAttachment).not.toHaveBeenCalled();
  });

  it('keeps temporary data owner-only and atomically submits only the final change request', async () => {
    const acquired = await acquire();
    expect(acquired.status).toBe(200);
    const headers = mutationHeaders(acquired.body, 'draft-open-a');
    const opened = await api.post('/api/v1/project-info-drafts/project-a/open').set(headers).send({});
    expect(opened.status).toBe(200);
    const saved = await api.patch('/api/v1/project-info-drafts/project-a')
      .set({ ...headers, 'idempotency-key': 'draft-save-a' })
      .send({ expectedDraftRevision: 0, payload: validPayload({ name: 'Private name' }), stepIndex: 4 });
    expect(saved.status).toBe(200);
    expect((await db.doc(`orgs/${tenantId}/projects/project-a`).get()).data()?.name).toBe('Project A');
    expect((await db.doc(`orgs/${tenantId}/project_requests/change-project-a`).get()).exists).toBe(false);

    const adminRead = await api.get('/api/v1/project-info-drafts/project-a').set(actorHeaders('actor-admin', 'admin'));
    expect(adminRead.status).toBe(404);
    const projectBeforeSubmit = (await db.doc(`orgs/${tenantId}/projects/project-a`).get()).data();

    const submitted = await api.post('/api/v1/project-info-drafts/project-a/submit')
      .set({ ...headers, 'idempotency-key': 'draft-submit-a' })
      .send({ expectedDraftRevision: 1, expectedVersion: 3, resubmit: false });
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({ projectVersion: 3, lease: { state: 'RELEASED' } });
    const [project, changeRequest, drafts] = await Promise.all([
      db.doc(`orgs/${tenantId}/projects/project-a`).get(),
      db.doc(`orgs/${tenantId}/project_requests/change-project-a`).get(),
      db.collection(`orgs/${tenantId}/privateEditDrafts`).get(),
    ]);
    expect(project.data()).toEqual(projectBeforeSubmit);
    expect(changeRequest.data()).toMatchObject({
      status: 'PENDING', baseProjectVersion: 3, targetProjectVersion: 4,
      proposedSnapshot: { name: 'Private name' },
    });
    expect((await db.doc(`orgs/${tenantId}/projectRequests/change-project-a`).get()).exists).toBe(false);
    expect(drafts.docs[0].data()).not.toHaveProperty('payload');
  });

  it('stores same-kind private attachments permanently and leaves version conflicts private', async () => {
    const acquired = await acquire();
    const baseHeaders = mutationHeaders(acquired.body, 'draft-open-b');
    const opened = await api.post('/api/v1/project-info-drafts/project-a/open').set(baseHeaders).send({});
    const uploaded = await api.post('/api/v1/project-info-drafts/project-a/attachments')
      .set({ ...baseHeaders, 'idempotency-key': 'draft-upload-b' })
      .send({
        expectedDraftRevision: opened.body.draft.draftRevision,
        documentKind: 'contract', fileName: 'contract.pdf', mimeType: 'application/pdf',
        fileSize: VALID_PDF.byteLength, contentBase64: VALID_PDF.toString('base64'),
    });
    expect(uploaded.status).toBe(200);
    const attachmentPath = uploaded.body.attachment.path;
    expect(attachmentPath).toContain('/project-registration-documents/project-a/');
    await db.doc(`orgs/${tenantId}/projects/project-a`).set({ version: 4 }, { merge: true });
    const conflict = await api.post('/api/v1/project-info-drafts/project-a/submit')
      .set({ ...baseHeaders, 'idempotency-key': 'draft-submit-conflict' })
      .send({ expectedDraftRevision: 1, expectedVersion: 3 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('canonical_version_conflict');
    expect(conflict.body.details).toEqual({ expectedVersion: 3, actualVersion: 4, conflictReason: 'canonical_changed' });
    expect((await db.doc(`orgs/${tenantId}/project_requests/change-project-a`).get()).exists).toBe(false);
    expect((await db.collection('outbox').get()).empty).toBe(true);

    await db.doc(`orgs/${tenantId}/projects/project-a`).set({ version: 3 }, { merge: true });
    const submitted = await api.post('/api/v1/project-info-drafts/project-a/submit')
      .set({ ...baseHeaders, 'idempotency-key': 'draft-submit-b' })
      .send({ expectedDraftRevision: 1, expectedVersion: 3 });
    expect(submitted.status).toBe(200);
    expect(storage.uploadProjectRegistrationAttachment).toHaveBeenCalledOnce();
    expect((await db.doc(`orgs/${tenantId}/project_requests/change-project-a`).get()).data())
      .toMatchObject({ proposedSnapshot: { contractDocument: { path: attachmentPath } } });
  });

  it('does not copy an attachment twice when a resubmit inherits the published file', async () => {
    const firstLease = await acquire('lease-acquire-race-v1');
    const firstHeaders = mutationHeaders(firstLease.body, 'draft-open-race-v1');
    const firstDraft = await api.post('/api/v1/project-info-drafts/project-a/open').set(firstHeaders).send({});
    const uploaded = await api.post('/api/v1/project-info-drafts/project-a/attachments')
      .set({ ...firstHeaders, 'idempotency-key': 'draft-upload-race-v1' })
      .send({
        expectedDraftRevision: firstDraft.body.draft.draftRevision,
        documentKind: 'contract', fileName: 'race-contract.pdf', mimeType: 'application/pdf',
        fileSize: VALID_PDF.byteLength, contentBase64: VALID_PDF.toString('base64'),
    });
    expect(uploaded.status).toBe(200);
    const attachmentPath = uploaded.body.attachment.path;
    const firstSubmit = await api.post('/api/v1/project-info-drafts/project-a/submit')
      .set({ ...firstHeaders, 'idempotency-key': 'draft-submit-race-v1' })
      .send({ expectedDraftRevision: 1, expectedVersion: 3 });
    expect(firstSubmit.status).toBe(200);

    const secondLease = await acquire('lease-acquire-race-v2');
    expect(secondLease.status).toBe(200);
    const secondHeaders = mutationHeaders(secondLease.body, 'draft-open-race-v2');
    const secondDraft = await api.post('/api/v1/project-info-drafts/project-a/open').set(secondHeaders).send({});
    expect(secondDraft.status).toBe(200);
    const secondSubmit = await api.post('/api/v1/project-info-drafts/project-a/submit')
      .set({ ...secondHeaders, 'idempotency-key': 'draft-submit-race-v2' })
      .send({ expectedDraftRevision: 0, expectedVersion: 3 });
    expect(secondSubmit.status).toBe(200);
    expect(storage.uploadProjectRegistrationAttachment).toHaveBeenCalledOnce();
    expect(storedAttachments.size).toBe(1);
    expect((await db.doc(`orgs/${tenantId}/project_requests/change-project-a`).get()).data())
      .toMatchObject({
        requestVersion: 2,
        submittedOutboxId: 'project-info-outbox-2',
        proposedSnapshot: { contractDocument: { path: attachmentPath } },
      });
  });

  it('lets the persisted project owner acquire without a duplicated member assignment', async () => {
    await db.doc(`orgs/${tenantId}/members/actor-a`).set({ projectIds: [] }, { merge: true });
    const acquired = await acquire();
    expect(acquired.status).toBe(200);
    expect(acquired.body).toMatchObject({ state: 'ACTIVE', canEdit: true });
  });
});
