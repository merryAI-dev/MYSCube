import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import request from 'supertest';
import { createBffApp } from './app.mjs';
import { createFirestoreDb, getOrInitAdminApp } from './firestore.mjs';
import { getStorage } from 'firebase-admin/storage';
import { EDIT_LEASE_TTL_MS, resolveEditLeaseDocumentId, buildActiveEditLeaseDocument } from './edit-lease.mjs';
import express from 'express';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createProjectRequestContractStorageService, createDraftAttachmentCleanupOutboxHandler } from './project-request-contract-storage.mjs';
import { createProjectRegistrationDraftService } from './routes/project-registration-drafts.mjs';
import { mountProjectRoutes } from './routes/projects.mjs';
import { createAuditChainService } from './audit-chain.mjs';
import { createIdempotencyService } from './idempotency.mjs';
import { loadRbacPolicy } from './rbac-policy.mjs';
import { createProjectInfoDraftService } from './routes/project-info-drafts.mjs';
import { PROJECT_DOCUMENT_FIELD_BY_KIND, PROJECT_INFO_DOCUMENT_KINDS, PROJECT_REGISTRATION_DOCUMENT_KINDS, PROJECT_REGISTRATION_REQUIRED_DOCUMENT_KINDS } from './project-document-validation.mjs';

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
  const storedFiles = new Map<string, Record<string, any>>();
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
    uploadProjectRegistrationAttachment: vi.fn(async (input: Record<string, any>) => {
      const path = `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${input.attachmentId}-${input.fileName}`;
      storedFiles.set(path, { ...input, path, size: input.buffer.byteLength, contentType: input.mimeType });
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
    deleteDraftAttachment: vi.fn(async () => undefined),
    inspectProjectRegistrationAttachment: vi.fn(async ({ path }: { path: string }) => storedFiles.get(path)),
    downloadProjectRegistrationAttachment: vi.fn(async ({ path }: { path: string }) => storedFiles.get(path)),
    deleteProjectRegistrationAttachment: vi.fn(async ({ path }: { path: string }) => {
      storedFiles.delete(path);
      deletedPaths.push(path);
    }),
    relocateDraftAttachments: vi.fn(async (input: Record<string, any>) => input.attachmentRefs.map((attachment: Record<string, any>) => {
      const objectName = String(attachment.path).split('/').at(-1);
      const path = `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${objectName}`;
      relocatedPaths.push(path);
      return { ...attachment, path, visibility: 'PRIVATE' };
    })),
  };

  const server = createServer(createBffApp({
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
    projectRequestContractStorageService: draftStorageService,
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
  const api = request(server);

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
      'privateEditDrafts',
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
    storedFiles.clear();
    vi.clearAllMocks();
  }

  // Match Supertest's IPv4 target; macOS can bind :: on an occupied IPv4 loopback port.
  beforeAll(() => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)));
  beforeEach(resetData, 60_000);
  afterAll(async () => {
    try {
      await clearData();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 60_000);

  it.skipIf(!process.env.FIREBASE_STORAGE_EMULATOR_HOST)('roundtrips all twelve real files through registration, change approval and explicit removal', async () => {
    const bucket = getStorage(getOrInitAdminApp({ projectId })).bucket(`${projectId}.firebasestorage.app`);
    const nativeStorage = createProjectRequestContractStorageService({ projectId, bucketName: bucket.name });
    const nativeServer = createServer(createBffApp({ projectId, db, authMode: 'headers', editLeasesEnabled: true,
      now: () => new Date(nowMs).toISOString(), projectRegistrationDraftStorageService: nativeStorage,
      projectRequestContractStorageService: nativeStorage, driveService, projectRegistrationSlackService,
      env: { ...process.env, BFF_DEPLOY_ENV: 'local', BFF_SCHEDULER_OWNER: 'disabled' } }));
    await new Promise<void>((resolve) => nativeServer.listen(0, '127.0.0.1', resolve));
    const client = request(nativeServer);
    const paths = new Set<string>();
    let sequence = 0;
    const headers = (ownership = {}, actor = 'actor-a') => ({ ...actorHeaders(actor), ...ownership, 'idempotency-key': `native-flow-${++sequence}` });
    const ok = (response: any, status = 200) => { expect(response.status, JSON.stringify(response.body)).toBe(status); return response.body; };
    const checksum = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
    const fixtures = Object.fromEntries(PROJECT_INFO_DOCUMENT_KINDS.map((kind: string) => {
      const word = kind === 'proposal_word_original';
      const ppt = ['proposal_ppt_original', 'presentation_ppt_original'].includes(kind);
      const fileName = word ? 'project-registration-attachment.docx' : ppt ? 'mola-project-attachment.pptx' : 'project-registration-attachment.pdf';
      const mimeType = word ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : ppt ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/pdf';
      const buffer = readFileSync(new URL(`./fixtures/${fileName}`, import.meta.url));
      expect(buffer.length).toBeGreaterThan(100);
      return [kind, { fileName, mimeType, buffer }];
    }));
    const download = async (resource: string, kind: string, actor = 'executive-a') => {
      const response = await client.get(`/api/v1/${resource}/attachments/${kind}`).set(headers({}, actor)).buffer(true)
        .parse((res, callback) => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk))); res.on('end', () => callback(null, Buffer.concat(chunks))); res.on('error', callback); });
      expect(response.status).toBe(200);
      expect(checksum(response.body)).toBe(checksum(fixtures[kind].buffer));
    };
    const readProject = async (id: string) => ok(await client.get('/api/v1/projects').set(headers())).items.find((item: any) => item.id === id);
    const latest = async (id: string) => ok(await client.get(`/api/v1/projects/${id}/latest-request`).set(headers())).item;
    const upload = async (base: string, ownership: Record<string, string>, kinds: string[], round: string) => {
      const selected: Record<string, any> = {};
      for (const kind of kinds) {
        const draft = ok(await client.get(base).set(headers())).draft;
        const file = fixtures[kind];
        const added = ok(await client.post(`${base}/attachments`).set(headers(ownership)).send({ expectedDraftRevision: draft.draftRevision,
          documentKind: kind, fileName: `${round}-${kind}-${file.fileName}`, mimeType: file.mimeType, fileSize: file.buffer.length, contentBase64: file.buffer.toString('base64') }));
        paths.add(added.attachment.path);
        selected[PROJECT_DOCUMENT_FIELD_BY_KIND[kind]] = added.attachment;
      }
      const saved = ok(await client.get(base).set(headers())).draft;
      expect(saved.attachmentRefs).toHaveLength(kinds.length);
      for (const kind of kinds) {
        expect(saved.attachmentRefs.find((ref: any) => ref.documentKind === kind).path).toBe(selected[PROJECT_DOCUMENT_FIELD_BY_KIND[kind]].path);
        await download(base.replace('/api/v1/', ''), kind, 'actor-a');
      }
      return selected;
    };
    const approve = async (id: string, requestId: string) => ok(await client.post(`/api/v1/projects/${id}/executive-review`)
      .set(headers({}, 'executive-a')).send({ requestId, reviewStatus: 'APPROVED' }));
    try {
      const created = ok(await client.post('/api/v1/project-registration-drafts').set(headers({ 'x-edit-session-id': 'native-registration' })).send({ payload: validPayload() }), 201);
      const registrationBase = `/api/v1/project-registration-drafts/${created.draft.draftId}`;
      const registrationOwnership = { 'x-edit-session-id': 'native-registration', 'x-edit-lease-id': created.lease.leaseId, 'x-edit-fence': String(created.lease.fence) };
      await upload(registrationBase, registrationOwnership, PROJECT_REGISTRATION_DOCUMENT_KINDS, 'registration');
      const registrationDraft = ok(await client.get(registrationBase).set(headers())).draft;
      const submitted = ok(await client.post(`${registrationBase}/submit`).set(headers(registrationOwnership)).send({ expectedDraftRevision: registrationDraft.draftRevision }), 201);
      const id = submitted.projectId;
      const registrationRequest = await latest(id);
      expect(registrationRequest.id).toBe(submitted.projectRequestId);
      expect(registrationRequest.requestVersion).toBe(1);
      const registrationProject = await readProject(id);
      for (const kind of PROJECT_REGISTRATION_DOCUMENT_KINDS) {
        const field = PROJECT_DOCUMENT_FIELD_BY_KIND[kind];
        paths.add(registrationRequest.payload[field].path);
        expect(registrationProject[field].path).toBe(registrationRequest.payload[field].path);
        await download(`project-requests/${submitted.projectRequestId}`, kind);
      }
      const wrong = await client.post(`/api/v1/projects/${id}/executive-review`).set(headers({}, 'actor-b')).send({ requestId: submitted.projectRequestId, reviewStatus: 'APPROVED' });
      expect(wrong.status).toBe(403);
      expect(await readProject(id)).toEqual(registrationProject);
      expect(await latest(id)).toEqual(registrationRequest);
      await approve(id, submitted.projectRequestId);
      const confirmed = await readProject(id);
      expect(confirmed.version).toBe(registrationProject.version + 1);
      const infoBase = `/api/v1/project-info-drafts/${id}`;
      const open = async (round: string) => {
        const session = `native-${round}`;
        const lease = ok(await client.post(`/api/v1/edit-leases/project-info/${id}/acquire`).set(headers({ 'x-edit-session-id': session })).send({}));
        expect(lease).toMatchObject({ state: 'ACTIVE', canEdit: true, leaseId: expect.any(String) });
        const ownership = { 'x-edit-session-id': session, 'x-edit-lease-id': lease.leaseId, 'x-edit-fence': String(lease.fence) };
        ok(await client.post(`${infoBase}/open`).set(headers(ownership)).send({}));
        return ownership;
      };
      const infoOwnership = await open('change');
      const selected = await upload(infoBase, infoOwnership, PROJECT_INFO_DOCUMENT_KINDS, 'change');
      const infoDraft = ok(await client.get(infoBase).set(headers())).draft;
      const changed = ok(await client.post(`${infoBase}/submit`).set(headers(infoOwnership)).send({ expectedDraftRevision: infoDraft.draftRevision, expectedVersion: confirmed.version }));
      expect(await readProject(id)).toEqual(confirmed);
      const changeRequest = await latest(id);
      expect(changeRequest).toMatchObject({ id: changed.projectRequestId, requestVersion: 1, baseProjectVersion: confirmed.version, targetProjectVersion: confirmed.version + 1 });
      for (const kind of PROJECT_INFO_DOCUMENT_KINDS) {
        const field = PROJECT_DOCUMENT_FIELD_BY_KIND[kind];
        expect(changeRequest.proposedSnapshot[field].path).toBe(selected[field].path);
        if (registrationRequest.payload[field]) expect(selected[field].path).not.toBe(registrationRequest.payload[field].path);
        await download(`project-requests/${changed.projectRequestId}`, kind);
      }
      await approve(id, changed.projectRequestId);
      const approved = await readProject(id);
      expect(approved.version).toBe(confirmed.version + 1);
      for (const kind of PROJECT_INFO_DOCUMENT_KINDS) {
        const field = PROJECT_DOCUMENT_FIELD_BY_KIND[kind];
        expect(approved[field]).toEqual(changeRequest.proposedSnapshot[field]);
        await download(`projects/${id}`, kind);
      }
      const removeOwnership = await open('remove');
      const reopened = ok(await client.get(infoBase).set(headers())).draft;
      for (const kind of PROJECT_INFO_DOCUMENT_KINDS) expect(reopened.payload[PROJECT_DOCUMENT_FIELD_BY_KIND[kind]]).toEqual(approved[PROJECT_DOCUMENT_FIELD_BY_KIND[kind]]);
      const optional = PROJECT_INFO_DOCUMENT_KINDS.filter((kind: string) => !PROJECT_REGISTRATION_REQUIRED_DOCUMENT_KINDS.includes(kind));
      expect(optional).toHaveLength(9);
      const nullFields = Object.fromEntries(optional.map((kind: string) => [PROJECT_DOCUMENT_FIELD_BY_KIND[kind], null]));
      const removed = ok(await client.patch(infoBase).set(headers(removeOwnership)).send({ expectedDraftRevision: reopened.draftRevision, payload: { ...reopened.payload, ...nullFields } })).draft;
      const removalSubmit = ok(await client.post(`${infoBase}/submit`).set(headers(removeOwnership)).send({ expectedDraftRevision: removed.draftRevision, expectedVersion: approved.version }));
      expect(await readProject(id)).toEqual(approved);
      const removalRequest = await latest(id);
      expect(removalRequest).toMatchObject({ id: changed.projectRequestId, requestVersion: changeRequest.requestVersion + 1, baseProjectVersion: approved.version, targetProjectVersion: approved.version + 1 });
      for (const kind of optional) expect(removalRequest.proposedSnapshot[PROJECT_DOCUMENT_FIELD_BY_KIND[kind]]).toBeNull();
      await approve(id, removalSubmit.projectRequestId);
      const removedProject = await readProject(id);
      expect(removedProject.version).toBe(approved.version + 1);
      const finalOwnership = await open('verify');
      const finalDraft = ok(await client.get(infoBase).set(headers())).draft;
      for (const kind of optional) {
        const field = PROJECT_DOCUMENT_FIELD_BY_KIND[kind];
        expect(removedProject[field]).toBeNull();
        expect(finalDraft.payload[field]).toBeNull();
        expect(finalDraft.attachmentRefs.some((ref: any) => ref.documentKind === kind)).toBe(false);
        const unavailable = await client.get(`/api/v1/projects/${id}/attachments/${kind}`).set(headers({}, 'executive-a'));
        expect(unavailable.status).toBe(409);
        expect(unavailable.body.error).toBe('project_attachment_not_ready');
      }
      for (const kind of PROJECT_REGISTRATION_REQUIRED_DOCUMENT_KINDS) await download(`projects/${id}`, kind);
      for (const kind of PROJECT_REGISTRATION_DOCUMENT_KINDS) await download(`project-requests/${submitted.projectRequestId}`, kind);
      for (const path of paths) expect(checksum((await bucket.file(path).download())[0])).toBe(checksum(fixtures[PROJECT_INFO_DOCUMENT_KINDS.find((kind: string) => path.includes(`-${kind}-`))!].buffer));
      ok(await client.post(`/api/v1/edit-leases/project-info/${id}/release`).set(headers(finalOwnership)).send({}));
    } finally {
      await new Promise<void>((resolve, reject) => nativeServer.close(error => error ? reject(error) : resolve()));
      for (const path of paths) await bucket.file(path).delete({ ignoreNotFound: true });
    }
  }, 60_000);

  it.skipIf(!process.env.FIREBASE_STORAGE_EMULATOR_HOST).each(['registration', 'info'])('replays consumed incoming %s uploads with real Storage bytes', async (kind) => {
    const storage = createProjectRequestContractStorageService({ projectId, bucketName: `${projectId}.firebasestorage.app` });
    const read = vi.spyOn(storage, 'readIncomingUpload');
    const upload = vi.spyOn(storage, 'uploadProjectRegistrationAttachment');
    const clock = () => new Date(nowMs).toISOString();
    const dependencies = { db, now: clock, rbacPolicy: loadRbacPolicy(), auditChainService: createAuditChainService(db, { now: clock }),
      idempotencyService: createIdempotencyService(db), draftStorageService: storage };
    const base = { tenantId, actorId: 'actor-a', actorRole: 'pm', actorDisplayName: 'Actor A', sessionId: 'incoming-session', requestId: 'incoming-request' };
    let service;
    let ownership;
    let draftId;
    if (kind === 'registration') {
      service = createProjectRegistrationDraftService(dependencies);
      const created = await service.create({ ...base, idempotencyKey: 'incoming-create', payload: validPayload() });
      draftId = created.body.draft.draftId;
      ownership = { ...base, draftId, leaseId: created.body.lease.leaseId, fence: created.body.lease.fence };
    } else {
      const resourceId = 'incoming-project';
      await db.doc(`orgs/${tenantId}/projects/${resourceId}`).set({ ...validPayload(), id: resourceId, tenantId, version: 1, executiveReviewStatus: 'APPROVED' });
      const lease = buildActiveEditLeaseDocument({ ...base, resourceType: 'project-info', resourceId, leaseId: 'incoming-lease', serverNow: nowMs });
      await db.doc(`orgs/${tenantId}/editLeases/${resolveEditLeaseDocumentId('project-info', resourceId)}`).set(lease);
      service = createProjectInfoDraftService(dependencies);
      ownership = { ...base, projectId: resourceId, leaseId: lease.leaseId, fence: lease.fence };
      await service.open({ ...ownership, idempotencyKey: 'incoming-open' });
      draftId = (await db.collection(`orgs/${tenantId}/privateEditDrafts`).get()).docs[0].id;
    }
    const bucket = getStorage(getOrInitAdminApp({ projectId })).bucket(`${projectId}.firebasestorage.app`);
    const incomingPath = `orgs/${tenantId}/project-registration-drafts/${draftId}/incoming/source.pdf`;
    const pdf = readFileSync(new URL('./fixtures/project-registration-attachment.pdf', import.meta.url));
    await bucket.file(incomingPath).save(pdf, { contentType: 'application/pdf' });
    let publishedPath;
    try {
      const input = { ...ownership, idempotencyKey: 'incoming-finalize', expectedDraftRevision: 0, documentKind: 'contract',
        fileName: 'contract.pdf', mimeType: 'application/pdf', fileSize: pdf.length, storagePath: incomingPath };
      const result = await service.addAttachment(input);
      publishedPath = result.body.attachment.path;
      expect((await bucket.file(incomingPath).exists())[0]).toBe(false);
      expect(await service.addAttachment(input)).toEqual({ ...result, replayed: true });
      for (const changed of [{ storagePath: `${incomingPath}-other` }, { fileName: 'other.pdf' }]) {
        await expect(service.addAttachment({ ...input, ...changed })).rejects.toMatchObject({ statusCode: 409 });
      }
      expect(read).toHaveBeenCalledTimes(1);
      expect(upload).toHaveBeenCalledTimes(1);
      expect((await bucket.file(publishedPath).download())[0]).toEqual(pdf);
      const draft = (await db.doc(`orgs/${tenantId}/${kind === 'info' ? 'privateEditDrafts' : 'projectRequestDrafts'}/${draftId}`).get()).data();
      expect(draft).toMatchObject({ draftRevision: 1, attachmentRefs: [{ path: publishedPath }] });
    } finally {
      await bucket.file(incomingPath).delete({ ignoreNotFound: true });
      if (publishedPath) await bucket.file(publishedPath).delete({ ignoreNotFound: true });
    }
  });

  it.skipIf(!process.env.FIREBASE_STORAGE_EMULATOR_HOST).each([false, true, 'plain-copy'])('publishes real Storage PDF bytes before any worker (legacy: %s)', async (legacy) => {
    const storage = createProjectRequestContractStorageService({ projectId, bucketName: `${projectId}.firebasestorage.app` });
    const clock = () => new Date(nowMs).toISOString();
    const service = createProjectRegistrationDraftService({ db, now: clock, rbacPolicy: loadRbacPolicy(),
      auditChainService: createAuditChainService(db, { now: clock }), idempotencyService: createIdempotencyService(db), draftStorageService: storage });
    const base = { tenantId, actorId: 'actor-a', actorRole: 'pm', actorDisplayName: 'Actor A', sessionId: 'storage-session', requestId: 'storage-request' };
    const created = await service.create({ ...base, idempotencyKey: 'storage-create', payload: validPayload() });
    const ownership = { ...base, draftId: created.body.draft.draftId, leaseId: created.body.lease.leaseId, fence: created.body.lease.fence };
    const pdf = readFileSync(new URL('./fixtures/project-registration-attachment.pdf', import.meta.url));
    const checksum = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
    const kinds = [['contract', 'contractDocument'], ['customer_business_registration', 'customerBusinessRegistrationDocument'], ['quote', 'quoteDocument']];
    const sourceRefs = [];
    const restoredPrivatePaths: string[] = [];
    const publishedCopies: Array<{ projectId: string; path: string }> = [];
    let downloadServer: ReturnType<typeof createServer> | undefined;
    let existingCopy;
    let submitted;
    try {
      for (const [index, [documentKind]] of kinds.entries()) {
        const input = { ...ownership, attachmentId: `source-${index}`, documentKind, fileName: `${documentKind}.pdf`, mimeType: 'application/pdf', fileSize: pdf.byteLength, buffer: pdf };
        if (legacy) sourceRefs.push({ ...(await storage.uploadDraftAttachment(input)), attachmentId: input.attachmentId, documentKind });
        else sourceRefs.push((await service.addAttachment({ ...input, idempotencyKey: `storage-upload-${index}`, expectedDraftRevision: index })).body.attachment);
      }
      if (legacy) {
        const ref = db.doc(`orgs/${tenantId}/projectRequestDrafts/${ownership.draftId}`);
        const old = (await ref.get()).data();
        const { targetProjectId: _reserved, ...unreserved } = old!;
        await ref.set({ ...(legacy === 'plain-copy' ? old : unreserved), attachmentRefs: sourceRefs });
        if (legacy === 'plain-copy') {
          const bucket = getStorage(getOrInitAdminApp({ projectId })).bucket(`${projectId}.firebasestorage.app`);
          const path = sourceRefs[0].path.replace(`/project-registration-drafts/${ownership.draftId}/`, `/project-registration-documents/${old!.targetProjectId}/`);
          const file = bucket.file(path);
          await bucket.file(sourceRefs[0].path).copy(file);
          const [metadata] = await file.getMetadata();
          existingCopy = { file, metadata };
          expect(metadata.metadata).not.toHaveProperty('relocationSourcePath');
        }
      }
      submitted = await service.submit({ ...ownership, idempotencyKey: 'storage-submit', expectedDraftRevision: legacy ? 0 : 3 });
      if (existingCopy) {
        const [metadata] = await existingCopy.file.getMetadata();
        expect(metadata).toEqual(existingCopy.metadata);
      }
      const project = (await db.doc(`orgs/${tenantId}/projects/${submitted.body.projectId}`).get()).data()!;
      const projectRequest = (await db.doc(`orgs/${tenantId}/project_requests/${submitted.body.projectRequestId}`).get()).data()!;
      const app = express();
      app.use((req, _res, next) => { req.context = { ...base, actorId: 'executive-a', actorRole: 'admin' }; next(); });
      mountProjectRoutes(app, { db, projectRequestContractStorageService: storage });
      app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
      downloadServer = createServer(app);
      await new Promise<void>((resolve) => downloadServer!.listen(0, '127.0.0.1', resolve));
      for (const [index, [kind, field]] of kinds.entries()) {
        const metadata = await storage.inspectProjectRegistrationAttachment({ tenantId, projectId: submitted.body.projectId, path: project[field].path });
        expect(metadata).toMatchObject({ size: pdf.byteLength, contentType: 'application/pdf', draftId: ownership.draftId });
        expect(projectRequest.payload[field].path).toBe(project[field].path);
        for (const resource of [`projects/${submitted.body.projectId}`, `project-requests/${submitted.body.projectRequestId}`]) {
          const response = await request(downloadServer).get(`/api/v1/${resource}/attachments/${kind}`);
          expect(response.status).toBe(200);
          expect(checksum(response.body)).toBe(checksum(pdf));
          expect(response.headers['cache-control']).toContain('no-store');
        }
        if (legacy) expect(checksum((await storage.downloadDraftAttachment({ tenantId, draftId: ownership.draftId, path: sourceRefs[index].path })).buffer)).toBe(checksum(pdf));
      }
      const outbox = (await db.doc(`outbox/${submitted.body.outbox.id}`).get()).data()!;
      expect(outbox).toMatchObject({ status: 'PENDING', sideEffects: { registrationAttachments: 'DONE' } });
      expect(outbox.payload.attachmentRefs.map((attachment: any) => attachment.path)).toEqual(sourceRefs.map((attachment) => attachment.path));
      if (!legacy) {
        const infoService = createProjectInfoDraftService({ db, now: clock, rbacPolicy: loadRbacPolicy(), draftStorageService: storage,
          auditChainService: createAuditChainService(db, { now: clock }), idempotencyService: createIdempotencyService(db) });
        const withdraw = async (target: string, round: string) => {
          const lease = buildActiveEditLeaseDocument({ tenantId, actorId: 'actor-a', actorDisplayName: 'Actor A', sessionId: base.sessionId,
            resourceType: 'project-info', resourceId: target, leaseId: `info-${round}`, serverNow: nowMs });
          await db.doc(`orgs/${tenantId}/editLeases/${resolveEditLeaseDocumentId('project-info', target)}`).set(lease);
          const input = { ...base, projectId: target, leaseId: lease.leaseId, fence: lease.fence };
          await infoService.open({ ...input, idempotencyKey: `info-open-${round}` });
          await infoService.withdraw({ ...input, idempotencyKey: `info-withdraw-${round}` });
          const draft = (await db.doc(`orgs/${tenantId}/projectRequestDrafts/${ownership.draftId}`).get()).data()!;
          expect(draft.targetProjectId).toBeNull();
          expect(draft.attachmentRefs).toHaveLength(3);
          restoredPrivatePaths.push(...draft.attachmentRefs.map((attachment: any) => attachment.path));
          const registrationLease = buildActiveEditLeaseDocument({ tenantId, actorId: 'actor-a', actorDisplayName: 'Actor A', sessionId: base.sessionId,
            resourceType: 'project-registration', resourceId: ownership.draftId, leaseId: `registration-${round}`, serverNow: nowMs });
          await db.doc(`orgs/${tenantId}/editLeases/${resolveEditLeaseDocumentId('project-registration', ownership.draftId)}`).set(registrationLease);
          return { draft, ownership: { ...ownership, leaseId: registrationLease.leaseId, fence: registrationLease.fence } };
        };
        const firstWithdrawal = await withdraw(submitted.body.projectId, 'first');
        const resubmitted = await service.submit({ ...firstWithdrawal.ownership, idempotencyKey: 'storage-resubmit', expectedDraftRevision: firstWithdrawal.draft.draftRevision });
        expect(resubmitted.body.projectId).not.toBe(submitted.body.projectId);
        const secondProject = (await db.doc(`orgs/${tenantId}/projects/${resubmitted.body.projectId}`).get()).data()!;
        for (const [, field] of kinds) publishedCopies.push({ projectId: resubmitted.body.projectId, path: secondProject[field].path });
        const secondWithdrawal = await withdraw(resubmitted.body.projectId, 'second');
        const replacement = await service.addAttachment({ ...secondWithdrawal.ownership, idempotencyKey: 'storage-replace', expectedDraftRevision: secondWithdrawal.draft.draftRevision,
          documentKind: 'contract', fileName: 'replacement.pdf', mimeType: 'application/pdf', fileSize: pdf.byteLength, buffer: pdf });
        await service.removeAttachment({ ...secondWithdrawal.ownership, idempotencyKey: 'storage-remove', expectedDraftRevision: replacement.body.draft.draftRevision, documentKind: 'contract' });
        const discarded = await service.discard({ ...base, draftId: ownership.draftId });
        const cleanupEvent = (await db.doc(`outbox/${discarded.outboxId}`).get()).data();
        await createDraftAttachmentCleanupOutboxHandler({ draftStorageService: storage })(cleanupEvent);
        for (const copy of [...sourceRefs.map((attachment) => ({ projectId: submitted.body.projectId, path: attachment.path })), ...publishedCopies]) {
          expect(checksum((await storage.downloadProjectRegistrationAttachment({ tenantId, ...copy })).buffer)).toBe(checksum(pdf));
        }
        expect((await db.doc(`orgs/${tenantId}/project_requests/${submitted.body.projectRequestId}`).get()).data()?.payload.contractDocument.path).toBe(sourceRefs[0].path);
      }
    } finally {
      if (downloadServer?.listening) await new Promise<void>((resolve, reject) => downloadServer!.close(error => error ? reject(error) : resolve()));
      for (const path of new Set(restoredPrivatePaths)) await storage.deleteDraftAttachment({ tenantId, draftId: ownership.draftId, path });
      for (const copy of publishedCopies) await storage.deleteProjectRegistrationAttachment({ tenantId, draftId: ownership.draftId, ...copy });
      for (const attachment of sourceRefs) {
        if (legacy) await storage.deleteDraftAttachment({ tenantId, draftId: ownership.draftId, path: attachment.path });
        const canonicalPath = legacy && submitted
          ? `orgs/${tenantId}/project-registration-documents/${submitted.body.projectId}/${attachment.path.split('/').at(-1)}` : attachment.path;
        if (!legacy || submitted) await storage.deleteProjectRegistrationAttachment({ tenantId, draftId: ownership.draftId,
          projectId: submitted?.body.projectId || created.body.draft.targetProjectId, path: canonicalPath });
      }
    }
  });

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
    expect(stale.body.details).toEqual({ expectedDraftRevision: 0, actualDraftRevision: 1, conflictReason: 'revision_changed' });

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
        path: expect.stringContaining('/project-registration-documents/'),
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
    expect(relocatedPaths).toHaveLength(0);

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
    expect((await db.doc(`outbox/${first.body.outbox.id}`).get()).data()?.payload?.attachmentRefs).toHaveLength(7);
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
