import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createBffApp } from './app.mjs';
import { createFirestoreDb } from './firestore.mjs';
import { EDIT_LEASE_TTL_MS, resolveEditLeaseDocumentId } from './edit-lease.mjs';

const describeIfEmulator = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
const VALID_PDF = Buffer.from('%PDF-1.4\n');
const VALID_ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

describeIfEmulator('private project registration drafts (Firestore emulator)', () => {
  const projectId = 'demo-project-registration-drafts';
  const tenantId = 'tenant-drafts';
  const db = createFirestoreDb({ projectId });
  let nowMs = Date.parse('2026-07-10T00:00:00.000Z');
  let draftSequence = 0;
  let leaseSequence = 0;
  let attachmentSequence = 0;
  let projectSequence = 0;
  let projectRequestSequence = 0;
  let uploadHook: null | ((input: Record<string, any>) => Promise<void>) = null;
  let driveHook: null | ((input: Record<string, any>) => Promise<Record<string, any>>) = null;
  const uploadedPaths: string[] = [];
  const deletedPaths: string[] = [];
  const relocatedPaths: string[] = [];
  const driveService = {
    getConfig: vi.fn(() => ({ enabled: true, defaultParentFolderId: 'stage-root' })),
    ensureProjectRootFolder: vi.fn(async (input: Record<string, any>) => {
      if (driveHook) return driveHook(input);
      return {
        id: `drive-${input.projectId}`,
        name: `${input.projectName} (${input.projectId})`,
        webViewLink: `https://drive.example/${input.projectId}`,
        driveId: 'shared-drive-stage',
      };
    }),
  };
  const projectRegistrationSlackService = {
    enabled: true,
    notifyMessage: vi.fn(async () => undefined),
  };

  const draftStorageService = {
    uploadDraftAttachment: vi.fn(async (input: Record<string, any>) => {
      const path = `orgs/${input.tenantId}/project-registration-drafts/${input.draftId}/${input.attachmentId}-${input.fileName}`;
      uploadedPaths.push(path);
      if (uploadHook) await uploadHook({ ...input, path });
      return {
        path,
        name: input.fileName,
        size: input.buffer.byteLength,
        contentType: input.mimeType,
        uploadedAt: new Date(nowMs).toISOString(),
      };
    }),
    deleteDraftAttachment: vi.fn(async ({ path }: { path: string }) => {
      deletedPaths.push(path);
    }),
    relocateDraftAttachments: vi.fn(async (input: Record<string, any>) => input.attachmentRefs.map((attachment: Record<string, any>) => {
      const objectName = String(attachment.path).split('/').at(-1);
      const path = `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${objectName}`;
      relocatedPaths.push(path);
      return { ...attachment, path, visibility: 'PRIVATE' };
    })),
  };

  const api = request(createBffApp({
    projectId,
    db,
    authMode: 'headers',
    now: () => new Date(nowMs).toISOString(),
    editLeasesEnabled: true,
    createProjectRegistrationDraftId: () => `opaque-draft-${++draftSequence}`,
    createProjectRegistrationLeaseId: () => `draft-lease-${++leaseSequence}`,
    createProjectRegistrationAttachmentId: () => `draft-attachment-${++attachmentSequence}`,
    createProjectRegistrationProjectId: () => `canonical-project-${++projectSequence}`,
    createProjectRegistrationRequestId: () => `canonical-request-${++projectRequestSequence}`,
    projectRegistrationDraftStorageService: draftStorageService,
    driveService,
    projectRegistrationSlackService,
    workerSecret: 'draft-worker-secret',
    workerAuthPolicy: {
      deployEnv: 'local',
      schedulerOwner: 'manual',
      secrets: { manual: 'draft-worker-secret', vercel: '', k8s: '' },
    },
    env: {
      ...process.env,
      BFF_DEPLOY_ENV: 'local',
      BFF_SCHEDULER_OWNER: 'disabled',
    },
  }));

  function actorHeaders(actorId = 'actor-a', actorRole = 'pm') {
    return {
      'x-tenant-id': tenantId,
      'x-actor-id': actorId,
      'x-actor-role': actorRole,
      'x-actor-name': actorId,
    };
  }

  function createDraft({
    actorId = 'actor-a',
    actorRole = 'pm',
    sessionId = 'session-a',
    key = 'idem-create',
    body = {},
  }: {
    actorId?: string;
    actorRole?: string;
    sessionId?: string;
    key?: string;
    body?: Record<string, unknown>;
  } = {}) {
    return api
      .post('/api/v1/project-registration-drafts')
      .set({
        ...actorHeaders(actorId, actorRole),
        'x-edit-session-id': sessionId,
        'idempotency-key': key,
      })
      .send(body);
  }

  function mutationHeaders(created: any, key: string, overrides: Record<string, string> = {}) {
    return {
      ...actorHeaders(),
      'x-edit-session-id': 'session-a',
      'x-edit-lease-id': created.body.lease.leaseId,
      'x-edit-fence': String(created.body.lease.fence),
      'idempotency-key': key,
      ...overrides,
    };
  }

  function validPayload(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Stage private project',
      officialContractName: 'Stage contract',
      type: 'D1',
      status: 'CONTRACT_PENDING',
      phase: 'CONFIRMED',
      description: 'Description',
      clientOrg: 'Client',
      department: 'AXR',
      currency: 'KRW',
      contractAmount: 100_000,
      salesVatAmount: 10_000,
      totalRevenueAmount: 40_000,
      supportAmount: 0,
      financialInputFlags: { contractAmount: true, salesVatAmount: true, totalRevenueAmount: true },
      registrationRequirementsVersion: 2,
      financialYears: [{
        year: 2026,
        contractAmount: 100_000,
        salesVatAmount: 10_000,
        totalRevenueAmount: 40_000,
        supportAmount: 0,
        profitRate: 0.4,
        confirmed: true,
      }],
      registrationConfirmations: {
        laborIncludesFourInsurance: true,
        laborIncludesRetirementPay: true,
        customerSettlementBasisConfirmed: true,
        modusignContractUsed: true,
        originalContractSubmitted: false,
      },
      registrationOptionalDocumentNotes: {
        proposalWordOriginal: '제안서 Word 원본 없음',
        proposalPptOriginal: '제안서 PPT 원본 없음',
        presentationPptOriginal: '발표자료 원본 없음',
      },
      contractStart: '2026-07-01',
      contractEnd: '2026-12-31',
      contractType: '계약서(날인)',
      settlementType: 'TYPE1',
      basis: '공급가액',
      accountType: 'OPERATING',
      fundInputMode: 'BANK_UPLOAD',
      paymentPlan: { contract: 50_000, interim: 0, final: 50_000 },
      paymentExpectedMonths: { contract: '2026-07', interim: '', final: '2026-12' },
      advanceInterimBelow70Reason: '잔금 비중 50%',
      managerId: 'actor-a',
      managerName: 'Actor A',
      executiveApproverId: 'executive-a',
      executiveApproverName: 'Executive A',
      executiveApproverEmail: 'executive-a@example.com',
      registeredById: 'actor-a',
      registeredByName: 'Actor A',
      registeredByEmail: 'actor-a@example.com',
      teamName: 'AXR',
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/participation-registration-fixture/edit',
      teamMembersDetailed: [{
        memberName: 'Actor A',
        role: '운영매니저',
        participationRate: 100,
        isDocumentOnly: false,
      }, {
        memberName: 'Executive A',
        role: '사업 최종 책임자',
        participationRate: 0,
        isDocumentOnly: false,
      }],
      projectPurpose: 'Purpose',
      arbitraryBrowserField: 'must-not-persist',
      ...overrides,
    };
  }

  function submitDraft(created: any, key: string, expectedDraftRevision = created.body.draft.draftRevision) {
    return api
      .post(`/api/v1/project-registration-drafts/${created.body.draft.draftId}/submit`)
      .set(mutationHeaders(created, key))
      .send({ expectedDraftRevision });
  }

  async function uploadRequiredAttachments(created: any, keyPrefix: string) {
    const attachments = [
      ['contract', 'contract.pdf', 'application/pdf', VALID_PDF],
      ['customer_business_registration', 'customer-business-registration.pdf', 'application/pdf', VALID_PDF],
      ['quote', 'quote.pdf', 'application/pdf', VALID_PDF],
      ['proposal_word_original', 'proposal.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', VALID_ZIP],
      ['proposal_ppt_original', 'proposal.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', VALID_ZIP],
      ['presentation_ppt_original', 'presentation.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', VALID_ZIP],
      ['rfp_request_evidence', 'rfp.pdf', 'application/pdf', VALID_PDF],
    ] as const;
    const responses = [];
    for (const [expectedDraftRevision, [documentKind, fileName, mimeType, content]] of attachments.entries()) {
      responses.push(await api
        .post(`/api/v1/project-registration-drafts/${created.body.draft.draftId}/attachments`)
        .set(mutationHeaders(created, `${keyPrefix}-${documentKind}`))
        .send({
          expectedDraftRevision,
          documentKind,
          fileName,
          mimeType,
          fileSize: content.byteLength,
          contentBase64: content.toString('base64'),
        }));
    }
    return responses;
  }

  async function clearCollection(path: string) {
    const snap = await db.collection(path).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }

  async function count(path: string) {
    return (await db.collection(path).get()).size;
  }

  async function clearData() {
    await Promise.all([
      'projectRequestDrafts',
      'editLeases',
      'audit_logs',
      'audit_chain',
      'idempotency_keys',
      'projects',
      'project_requests',
      'project_dashboard_projects',
      'partEntries',
      'outbox_deliveries',
      'members',
    ].map((collection) => clearCollection(`orgs/${tenantId}/${collection}`)));
    await Promise.all([clearCollection('outbox'), clearCollection('work_queue')]);
  }

  async function resetData() {
    await clearData();
    const batch = db.batch();
    for (const [uid, role] of [
      ['actor-a', 'pm'],
      ['actor-b', 'pm'],
      ['executive-a', 'pm'],
      ['actor-finance', 'finance'],
      ['actor-admin', 'admin'],
    ]) {
      batch.set(db.doc(`orgs/${tenantId}/members/${uid}`), {
        uid,
        role,
        status: 'ACTIVE',
        name: uid === 'actor-a' ? 'Actor A' : uid,
        email: `${uid}@example.com`,
        createdAt: '2025-01-01T00:00:00.000Z',
        projectIds: [],
      });
    }
    await batch.commit();
    nowMs = Date.parse('2026-07-10T00:00:00.000Z');
    draftSequence = 0;
    leaseSequence = 0;
    attachmentSequence = 0;
    projectSequence = 0;
    projectRequestSequence = 0;
    uploadHook = null;
    driveHook = null;
    uploadedPaths.length = 0;
    deletedPaths.length = 0;
    relocatedPaths.length = 0;
    vi.clearAllMocks();
  }

  beforeEach(resetData, 60_000);
  afterAll(clearData, 60_000);

  it('atomically creates exactly one private draft and lease and replays without extending expiry', async () => {
    const createBody = { payload: { name: 'Private only' }, stepIndex: 1 };
    const first = await createDraft({
      body: createBody,
    });

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      draft: {
        draftId: 'opaque-draft-1',
        draftRevision: 0,
        payload: { name: 'Private only' },
        status: 'ACTIVE',
      },
      lease: {
        state: 'ACTIVE',
        canEdit: true,
        leaseId: 'draft-lease-1',
        fence: 1,
      },
    });
    expect(await count(`orgs/${tenantId}/projectRequestDrafts`)).toBe(1);
    expect(await count(`orgs/${tenantId}/editLeases`)).toBe(1);
    expect(await count(`orgs/${tenantId}/projects`)).toBe(0);
    expect(await count(`orgs/${tenantId}/project_requests`)).toBe(0);
    expect(await count(`orgs/${tenantId}/project_dashboard_projects`)).toBe(0);
    expect(await count('outbox')).toBe(0);
    expect(await count('work_queue')).toBe(0);
    expect((await db.doc(`orgs/${tenantId}/members/actor-a`).get()).data()?.projectIds).toEqual([]);

    const draft = await db.doc(`orgs/${tenantId}/projectRequestDrafts/opaque-draft-1`).get();
    expect(draft.data()).toMatchObject({
      ownerUid: 'actor-a',
      ownerId: 'actor-a',
      tenantId,
      resourceType: 'project-registration',
      resourceId: 'opaque-draft-1',
      draftRevision: 0,
      attachmentRefs: [],
      status: 'ACTIVE',
    });
    const leaseRef = db.doc(
      `orgs/${tenantId}/editLeases/${resolveEditLeaseDocumentId('project-registration', 'opaque-draft-1')}`,
    );
    const expiresAt = (await leaseRef.get()).data()?.expiresAt;
    const auditCount = await count(`orgs/${tenantId}/audit_logs`);
    nowMs += 60_000;

    const replay = await createDraft({ body: createBody });

    expect(replay.status).toBe(201);
    expect(replay.headers['x-idempotency-replayed']).toBe('1');
    expect(replay.body).toEqual(first.body);
    expect((await leaseRef.get()).data()?.expiresAt).toBe(expiresAt);
    expect(await count(`orgs/${tenantId}/projectRequestDrafts`)).toBe(1);
    expect(await count(`orgs/${tenantId}/editLeases`)).toBe(1);
    expect(await count(`orgs/${tenantId}/audit_logs`)).toBe(auditCount);
  });

  it('adopts one unsubmitted owner legacy draft and ignores a foreign legacy owner', async () => {
    const ownerLegacyRef = db.doc(`orgs/${tenantId}/projectRequestDrafts/registration-actor-a`);
    const foreignLegacyRef = db.doc(`orgs/${tenantId}/projectRequestDrafts/registration-actor-b`);
    await ownerLegacyRef.set({
      id: 'registration-actor-a',
      ownerId: 'actor-a',
      payloadSnapshot: { name: 'Preserved legacy', contractDocument: { path: 'legacy.pdf' } },
      stepIndex: 3,
      attachmentRefs: [{ attachmentId: 'legacy-1', path: 'legacy.pdf' }],
      status: 'DRAFT',
      version: 7,
    });
    await foreignLegacyRef.set({
      id: 'registration-actor-b',
      ownerUid: 'someone-else',
      payloadSnapshot: { name: 'Must stay private' },
      status: 'DRAFT',
    });

    const adopted = await createDraft({ key: 'idem-adopt' });
    const second = await createDraft({ key: 'idem-after-adopt' });
    const foreign = await createDraft({ actorId: 'actor-b', sessionId: 'session-b', key: 'idem-foreign' });

    expect(adopted.body.draft).toMatchObject({
      payload: { name: 'Preserved legacy', contractDocument: { path: 'legacy.pdf' } },
      stepIndex: 3,
      attachmentRefs: [{ attachmentId: 'legacy-1', path: 'legacy.pdf' }],
    });
    expect(second.body.draft.payload).toEqual({});
    expect(foreign.body.draft.payload).toEqual({});
    expect((await ownerLegacyRef.get()).data()).toMatchObject({
      payloadSnapshot: { name: 'Preserved legacy', contractDocument: { path: 'legacy.pdf' } },
      migrationStatus: 'ADOPTED',
      adoptedByDraftId: adopted.body.draft.draftId,
    });
    expect((await foreignLegacyRef.get()).data()).toEqual({
      id: 'registration-actor-b',
      ownerUid: 'someone-else',
      payloadSnapshot: { name: 'Must stay private' },
      status: 'DRAFT',
    });
  });

  it('lets only the owner read a preserved draft after lease expiry without renewing it', async () => {
    const created = await createDraft({ key: 'idem-private-get' });
    const leaseRef = db.doc(
      `orgs/${tenantId}/editLeases/${resolveEditLeaseDocumentId('project-registration', created.body.draft.draftId)}`,
    );
    const leaseBefore = (await leaseRef.get()).data();
    nowMs += EDIT_LEASE_TTL_MS;

    const owner = await api
      .get(`/api/v1/project-registration-drafts/${created.body.draft.draftId}`)
      .set(actorHeaders());
    const otherPm = await api
      .get(`/api/v1/project-registration-drafts/${created.body.draft.draftId}`)
      .set(actorHeaders('actor-b', 'pm'));
    const finance = await api
      .get(`/api/v1/project-registration-drafts/${created.body.draft.draftId}`)
      .set(actorHeaders('actor-finance', 'finance'));
    const admin = await api
      .get(`/api/v1/project-registration-drafts/${created.body.draft.draftId}`)
      .set(actorHeaders('actor-admin', 'admin'));

    expect(owner.status).toBe(200);
    expect(owner.body).toEqual({ draft: created.body.draft });
    for (const response of [otherPm, finance, admin]) {
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('not_found');
    }
    expect((await leaseRef.get()).data()).toEqual(leaseBefore);
  });

  it('saves by revision with exact replay and rejects stale, expired, and wrong-session writes', async () => {
    const created = await createDraft({ key: 'idem-patch-create' });
    const path = `/api/v1/project-registration-drafts/${created.body.draft.draftId}`;
    const body = { expectedDraftRevision: 0, payload: { name: 'Temporary save' }, stepIndex: 2 };
    const first = await api.patch(path).set(mutationHeaders(created, 'idem-patch')).send(body);
    const auditCount = await count(`orgs/${tenantId}/audit_logs`);
    const replay = await api.patch(path).set(mutationHeaders(created, 'idem-patch')).send(body);

    expect(first.status).toBe(200);
    expect(first.body.draft).toMatchObject({ draftRevision: 1, payload: body.payload, stepIndex: 2 });
    expect(replay.status).toBe(200);
    expect(replay.headers['x-idempotency-replayed']).toBe('1');
    expect(replay.body).toEqual(first.body);
    expect(await count(`orgs/${tenantId}/audit_logs`)).toBe(auditCount);
    expect((await db.doc(`orgs/${tenantId}/projectRequestDrafts/${created.body.draft.draftId}`).get()).data()?.draftRevision).toBe(1);

    const stale = await api
      .patch(path)
      .set(mutationHeaders(created, 'idem-patch-stale'))
      .send({ ...body, expectedDraftRevision: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('draft_version_conflict');

    const wrongSession = await api
      .patch(path)
      .set(mutationHeaders(created, 'idem-patch-wrong-session', { 'x-edit-session-id': 'session-b' }))
      .send({ ...body, expectedDraftRevision: 1 });
    expect(wrongSession.status).toBe(423);
    expect(wrongSession.body.error).toBe('edit_lease_held');

    nowMs += EDIT_LEASE_TTL_MS;
    const expired = await api
      .patch(path)
      .set(mutationHeaders(created, 'idem-patch-expired'))
      .send({ ...body, expectedDraftRevision: 1 });
    expect(expired.status).toBe(410);
    expect(expired.body.error).toBe('edit_lease_expired');

    expect(await count(`orgs/${tenantId}/projects`)).toBe(0);
    expect(await count(`orgs/${tenantId}/project_requests`)).toBe(0);
    expect(await count(`orgs/${tenantId}/project_dashboard_projects`)).toBe(0);
    expect(await count('outbox')).toBe(0);
    expect(await count('work_queue')).toBe(0);
    expect((await db.doc(`orgs/${tenantId}/members/actor-a`).get()).data()?.projectIds).toEqual([]);
  });

  it('registers private attachment metadata and deletes only a failed post-upload object', async () => {
    const created = await createDraft({ key: 'idem-attachment-create' });
    const path = `/api/v1/project-registration-drafts/${created.body.draft.draftId}/attachments`;
    const fileBody = {
      expectedDraftRevision: 0,
      documentKind: 'contract',
      fileName: 'contract.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      contentBase64: VALID_PDF.toString('base64'),
    };
    const first = await api
      .post(path)
      .set(mutationHeaders(created, 'idem-attachment-1'))
      .send(fileBody);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      draft: { draftRevision: 1 },
      attachment: {
        attachmentId: 'draft-attachment-1',
        path: expect.stringContaining('/project-registration-drafts/'),
        name: 'contract.pdf',
        size: VALID_PDF.byteLength,
        contentType: 'application/pdf',
      },
    });
    const firstPath = first.body.attachment.path;
    expect(deletedPaths).toEqual([]);

    uploadHook = async ({ tenantId: hookTenantId, draftId }) => {
      await db.doc(`orgs/${hookTenantId}/projectRequestDrafts/${draftId}`).set({ draftRevision: 2 }, { merge: true });
    };
    const failed = await api
      .post(path)
      .set(mutationHeaders(created, 'idem-attachment-2'))
      .send({ ...fileBody, expectedDraftRevision: 1, documentKind: 'quote', fileName: 'quote.pdf' });

    expect(failed.status).toBe(409);
    expect(failed.body.error).toBe('draft_version_conflict');
    expect(uploadedPaths).toHaveLength(2);
    expect(deletedPaths).toEqual([uploadedPaths[1]]);
    expect(deletedPaths).not.toContain(firstPath);
    const stored = (await db.doc(`orgs/${tenantId}/projectRequestDrafts/${created.body.draft.draftId}`).get()).data();
    expect(stored?.attachmentRefs).toEqual([expect.objectContaining({ path: firstPath })]);
  });

  it('atomically submits canonical records, replays after release, and publishes attachments inline in the same request', async () => {
    const created = await createDraft({
      key: 'idem-submit-create',
      body: { payload: validPayload(), stepIndex: 4 },
    });
    const attachments = await uploadRequiredAttachments(created, 'idem-submit');
    expect(attachments.map((attachment) => attachment.status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
    expect(await count(`orgs/${tenantId}/projects`)).toBe(0);
    expect(await count(`orgs/${tenantId}/project_requests`)).toBe(0);
    expect(await count('outbox')).toBe(0);

    const first = await submitDraft(created, 'idem-submit-final', 7);
    const replay = await submitDraft(created, 'idem-submit-final', 7);

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: 'SUBMITTED',
      projectVersion: 1,
      lease: { state: 'RELEASED', canEdit: false },
    });
    expect(replay.status).toBe(201);
    expect(replay.headers['x-idempotency-replayed']).toBe('1');
    expect(replay.body).toEqual(first.body);
    expect(await count(`orgs/${tenantId}/projects`)).toBe(1);
    expect(await count(`orgs/${tenantId}/project_requests`)).toBe(1);
    expect(await count('outbox')).toBe(1);
    // 첨부 공개 이관은 제출과 같은 요청 안에서 인라인 처리된다. 크론(하루 1회)만 기다리면
    // 결재 문서의 서류가 하루 종일 '미제출'로 보이고 승인이 막히기 때문이다.
    expect(await count(`orgs/${tenantId}/partEntries`)).toBe(2);
    expect(driveService.ensureProjectRootFolder).toHaveBeenCalledTimes(1);
    expect(projectRegistrationSlackService.notifyMessage).toHaveBeenCalledTimes(1);
    expect(relocatedPaths).toHaveLength(7);

    const project = (await db.doc(`orgs/${tenantId}/projects/${first.body.projectId}`).get()).data();
    expect(project).toMatchObject({
      id: first.body.projectId,
      registrationSource: 'pm_portal',
      executiveReviewStatus: 'PENDING',
      version: 1,
    });
    expect(project).not.toHaveProperty('arbitraryBrowserField');
    expect(project?.contractDocument)
      .toMatchObject({ path: expect.stringContaining('/project-registration-documents/'), visibility: 'PRIVATE' });
    const requestDoc = (await db.doc(`orgs/${tenantId}/project_requests/${first.body.projectRequestId}`).get()).data();
    expect(requestDoc).toMatchObject({ sourceDraftId: created.body.draft.draftId });
    expect(requestDoc?.payload).not.toHaveProperty('arbitraryBrowserField');
    expect(requestDoc?.payload?.contractDocument)
      .toMatchObject({ path: expect.stringContaining('/project-registration-documents/'), visibility: 'PRIVATE' });
    const draft = (await db.doc(`orgs/${tenantId}/projectRequestDrafts/${created.body.draft.draftId}`).get()).data();
    expect(draft).toMatchObject({
      status: 'SUBMITTED',
      draftRevision: 8,
    });
    expect(draft).not.toHaveProperty('payload');
    expect(draft).not.toHaveProperty('attachmentRefs');
    expect(draft).not.toHaveProperty('stepIndex');
    expect((await db.doc(`outbox/${first.body.outbox.id}`).get()).data()?.payload?.attachmentRefs)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ documentKind: 'contract', path: expect.stringContaining('/project-registration-drafts/') }),
        expect.objectContaining({ documentKind: 'customer_business_registration' }),
        expect.objectContaining({ documentKind: 'quote' }),
        expect.objectContaining({ documentKind: 'proposal_word_original' }),
        expect.objectContaining({ documentKind: 'proposal_ppt_original' }),
        expect.objectContaining({ documentKind: 'presentation_ppt_original' }),
        expect.objectContaining({ documentKind: 'rfp_request_evidence' }),
      ]));
    const lease = (await db.doc(
      `orgs/${tenantId}/editLeases/${resolveEditLeaseDocumentId('project-registration', created.body.draft.draftId)}`,
    ).get()).data();
    expect(lease).toMatchObject({ state: 'RELEASED', releaseReason: 'FINAL_SUBMIT' });
    expect((await db.doc(`orgs/${tenantId}/members/actor-a`).get()).data()).toMatchObject({
      projectId: first.body.projectId,
      projectIds: [first.body.projectId],
      lastLoginAt: '2026-07-10T00:00:00.000Z',
    });

    const otherKey = await submitDraft(created, 'idem-submit-after-release', 8);
    expect(otherKey.status).toBe(409);
    expect(otherKey.body.error).toBe('draft_not_active');

    // 크론 워커는 안전망이다. 인라인으로 이미 끝났으므로 처리할 이벤트가 없어야 한다.
    const worker = await api
      .post('/api/internal/workers/outbox/run')
      .set('x-worker-secret', 'draft-worker-secret')
      .send({ limit: 10, maxAttempts: 3 });
    expect(worker.status).toBe(200);
    expect(worker.body).toMatchObject({ processed: 0 });
    expect(driveService.ensureProjectRootFolder).toHaveBeenCalledTimes(1);
    expect(projectRegistrationSlackService.notifyMessage).toHaveBeenCalledTimes(1);
    expect((await db.doc(`outbox/${first.body.outbox.id}`).get()).data()?.status).toBe('DONE');
    expect((await db.doc(`orgs/${tenantId}/outbox_deliveries/${first.body.outbox.id}`).get()).exists).toBe(true);
  }, 60_000);

  it('serializes concurrent final submits to one canonical result', async () => {
    const sameKeyDraft = await createDraft({
      key: 'idem-concurrent-same-create',
      body: { payload: validPayload() },
    });
    await uploadRequiredAttachments(sameKeyDraft, 'idem-concurrent-same-upload');
    const same = await Promise.all([
      submitDraft(sameKeyDraft, 'idem-concurrent-same', 7),
      submitDraft(sameKeyDraft, 'idem-concurrent-same', 7),
    ]);
    expect(same.map((response) => response.status)).toEqual([201, 201]);
    expect(same[0].body).toEqual(same[1].body);
    expect(same.filter((response) => response.headers['x-idempotency-replayed'] === '1')).toHaveLength(1);
    expect(await count(`orgs/${tenantId}/projects`)).toBe(1);
    expect(await count(`orgs/${tenantId}/project_requests`)).toBe(1);
    expect(await count('outbox')).toBe(1);

    await resetData();
    const differentKeyDraft = await createDraft({
      key: 'idem-concurrent-different-create',
      body: { payload: validPayload({ name: 'Different key race' }) },
    });
    await uploadRequiredAttachments(differentKeyDraft, 'idem-concurrent-different-upload');
    const different = await Promise.all([
      submitDraft(differentKeyDraft, 'idem-concurrent-a', 7),
      submitDraft(differentKeyDraft, 'idem-concurrent-b', 7),
    ]);
    expect(different.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await count(`orgs/${tenantId}/projects`)).toBe(1);
    expect(await count(`orgs/${tenantId}/project_requests`)).toBe(1);
    expect(await count('outbox')).toBe(1);
  }, 60_000);

  it('keeps canonical submit committed when the inline attachment publication fails on a Drive outage', async () => {
    driveHook = async () => { throw new Error('temporary Drive outage'); };
    const created = await createDraft({
      key: 'idem-worker-failure-create',
      body: { payload: validPayload({ name: 'Worker failure project' }) },
    });
    await uploadRequiredAttachments(created, 'idem-worker-failure-upload');
    // 인라인 이관이 실패해도 제출 응답은 성공 그대로다 - 커밋된 정본을 실패로 되돌리지 않는다.
    const submitted = await submitDraft(created, 'idem-worker-failure', 7);
    expect(submitted.status).toBe(201);
    expect(await count(`orgs/${tenantId}/projects`)).toBe(1);
    expect(await count(`orgs/${tenantId}/project_requests`)).toBe(1);
    const eventAfterSubmit = (await db.doc(`outbox/${submitted.body.outbox.id}`).get()).data();
    expect(eventAfterSubmit?.status).toBe('FAILED');
    expect(eventAfterSubmit?.attempts).toBe(1);
    expect(projectRegistrationSlackService.notifyMessage).not.toHaveBeenCalled();

    // 재시도 백오프(nextAttemptAt 미래) 때문에 바로 도는 워커는 집지 않는다 - 크론이 안전망.
    const worker = await api
      .post('/api/internal/workers/outbox/run')
      .set('x-worker-secret', 'draft-worker-secret')
      .send({ limit: 10, maxAttempts: 3 });
    expect(worker.body).toMatchObject({ processed: 0 });
  }, 60_000);
});
