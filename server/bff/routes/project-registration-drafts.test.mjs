import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createIdempotencyService } from '../idempotency.mjs';
import { resolveEditLeaseDocumentId } from '../edit-lease.mjs';
import { loadRbacPolicy } from '../rbac-policy.mjs';
import {
  createProjectRegistrationDraftService,
  mountProjectRegistrationDraftRoutes,
} from './project-registration-drafts.mjs';

const VALID_PDF = Buffer.from('%PDF-1.4\n');
const VALID_ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const VALID_V2_PROJECT_NAME = 'Private';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createDb(seed = {}) {
  const documents = new Map(Object.entries(seed).map(([path, value]) => [path, clone(value)]));
  let retryBeforeSecondAttempt = null;

  function snapshot(path) {
    const exists = documents.has(path);
    return {
      exists,
      data: () => (exists ? clone(documents.get(path)) : undefined),
    };
  }

  function doc(path) {
    return {
      path,
      get: async () => snapshot(path),
      set: async (value, options = {}) => {
        const next = options.merge && documents.has(path)
          ? { ...documents.get(path), ...clone(value) }
          : clone(value);
        documents.set(path, next);
      },
    };
  }

  function collection(collectionPath) {
    const prefix = `${collectionPath}/`;
    const state = { filters: [], limit: Infinity };
    const query = {
      where(field, op, value) {
        if (op !== '==') throw new Error('mock collection only supports ==');
        state.filters.push([field, value]);
        return query;
      },
      limit(count) {
        state.limit = count;
        return query;
      },
      async get() {
        const docs = [...documents.entries()]
          .filter(([docPath]) => docPath.startsWith(prefix) && !docPath.slice(prefix.length).includes('/'))
          .map(([docPath, value]) => ({ id: docPath.slice(prefix.length), data: () => clone(value) }))
          .filter((docRef) => state.filters.every(([field, value]) => (docRef.data() || {})[field] === value))
          .slice(0, state.limit);
        return { docs };
      },
    };
    return query;
  }

  async function runAttempt(callback, commit) {
    const writes = [];
    const tx = {
      get: async (ref) => snapshot(ref.path),
      set: (ref, value, options = {}) => writes.push({ type: 'set', ref, value: clone(value), options }),
      create: (ref, value) => writes.push({ type: 'create', ref, value: clone(value) }),
      update: (ref, value) => writes.push({ type: 'update', ref, value: clone(value) }),
    };
    const result = await callback(tx);
    if (!commit) return result;
    for (const write of writes) {
      const current = documents.get(write.ref.path);
      if (write.type === 'create' && current !== undefined) throw new Error('document already exists');
      if (write.type === 'update' && current === undefined) throw new Error('document does not exist');
      documents.set(
        write.ref.path,
        (write.type === 'update' || write.options?.merge) && current
          ? { ...current, ...write.value }
          : write.value,
      );
    }
    return result;
  }

  return {
    documents,
    doc,
    collection,
    retryNextTransaction(beforeSecondAttempt) {
      retryBeforeSecondAttempt = beforeSecondAttempt || (() => undefined);
    },
    async runTransaction(callback) {
      if (retryBeforeSecondAttempt) {
        const beforeSecondAttempt = retryBeforeSecondAttempt;
        retryBeforeSecondAttempt = null;
        await runAttempt(callback, false);
        await beforeSecondAttempt();
      }
      return runAttempt(callback, true);
    },
  };
}

function createHarness({
  seed = {},
  storageService,
  cleanupOutboxEventFactory,
  nowMs = Date.parse('2026-07-10T00:00:00.000Z'),
  auditChainService: auditOverride,
} = {}) {
  const db = createDb({
    'orgs/tenant-a/members/actor-a': {
      uid: 'actor-a',
      role: 'pm',
      status: 'ACTIVE',
      projectIds: [],
    },
    'orgs/tenant-a/members/actor-b': {
      uid: 'actor-b',
      role: 'pm',
      status: 'ACTIVE',
      projectIds: [],
    },
    'orgs/tenant-a/members/actor-admin': {
      uid: 'actor-admin',
      role: 'admin',
      status: 'ACTIVE',
      projectIds: [],
    },
    'orgs/tenant-a/members/head-a': {
      uid: 'head-a',
      role: 'admin',
      status: 'ACTIVE',
      projectIds: [],
    },
    ...seed,
  });
  let currentNowMs = nowMs;
  let draftSequence = 0;
  let leaseSequence = 0;
  let attachmentSequence = 0;
  let cleanupOutboxSequence = 0;
  const auditChainService = auditOverride || {
    appendManyInTransaction: vi.fn(async () => []),
  };
  const idempotencyService = createIdempotencyService(db, {
    now: () => new Date(currentNowMs),
  });
  const service = createProjectRegistrationDraftService({
    db,
    now: () => new Date(currentNowMs).toISOString(),
    createDraftId: () => `draft-${++draftSequence}`,
    createLeaseId: () => `lease-${++leaseSequence}`,
    createAttachmentId: () => `attachment-${++attachmentSequence}`,
    createProjectId: () => 'project-1',
    createProjectRequestId: () => 'project-request-1',
    createRegistrationOutboxEvent: (input) => ({
      id: 'outbox-1',
      ...input,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: input.createdAt,
      updatedAt: input.createdAt,
    }),
    createAttachmentCleanupOutboxEvent: cleanupOutboxEventFactory || ((input) => ({
      id: `cleanup-outbox-${++cleanupOutboxSequence}`,
      ...input,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: input.createdAt,
      updatedAt: input.createdAt,
    })),
    auditChainService,
    idempotencyService,
    draftStorageService: storageService,
    rbacPolicy: loadRbacPolicy(),
  });
  const base = {
    tenantId: 'tenant-a',
    actorId: 'actor-a',
    actorRole: 'pm',
    actorDisplayName: 'Actor A',
    requestId: 'request-a',
    sessionId: 'session-a',
  };
  return {
    db,
    service,
    base,
    auditChainService,
    advance(ms) { currentNowMs += ms; },
  };
}

function validRegistrationPayload(overrides = {}) {
  return {
    name: 'Private project',
    officialContractName: 'Private project contract',
    type: 'D1',
    status: 'CONTRACT_PENDING',
    phase: 'CONFIRMED',
    description: 'Description',
    clientOrg: 'Client',
    department: 'AXR',
    groupwareName: '2026 Private project',
    currency: 'KRW',
    contractAmount: 100_000,
    salesVatAmount: 10_000,
    totalRevenueAmount: 40_000,
    supportAmount: 0,
    financialInputFlags: { contractAmount: true, salesVatAmount: true, totalRevenueAmount: true },
    contractStart: '2026-07-01',
    contractEnd: '2026-12-31',
    contractType: '계약서(날인)',
    settlementType: 'TYPE1',
    basis: '공급가액',
    accountType: 'OPERATING',
    fundInputMode: 'BANK_UPLOAD',
    paymentPlan: { contract: 50_000, interim: 0, final: 50_000 },
    paymentPlanDesc: '50/50',
    finalPaymentExpectedWeek: '26-12-4',
    settlementGuide: 'Guide',
    finalPaymentNote: 'Final note',
    projectPurpose: 'Purpose',
    registeredById: 'actor-a',
    registeredByName: 'Actor A',
    registeredByEmail: 'actor-a@example.com',
    executiveApproverId: 'head-a',
    executiveApproverName: 'Head A',
    executiveApproverEmail: 'head-a@example.com',
    managerId: 'actor-a',
    managerName: 'Actor A',
    teamName: 'AXR',
    teamMembers: 'Actor A · 실무책임자 · 100% · 실제 참여',
    teamMembersDetailed: [{
      memberName: 'Actor A',
      role: '실무책임자',
      participationRate: 100,
      isDocumentOnly: false,
    }],
    participantCondition: 'Condition',
    note: 'Note',
    arbitraryBrowserField: 'must-not-persist',
    ...overrides,
  };
}

function validRegistrationV2Payload(overrides = {}) {
  const payload = validRegistrationPayload({
    registrationRequirementsVersion: 2,
    participationSheetLink: 'https://docs.google.com/spreadsheets/d/participation-sheet-a/edit',
    name: VALID_V2_PROJECT_NAME,
    teamMembers: [
      'Head A · 사업 최종 책임자 · 100% · 실제 참여',
      'Actor A · 실무책임자 · 100% · 실제 참여',
      'Operator A · 운영매니저 · 100% · 실제 참여',
    ].join(', '),
    teamMembersDetailed: [
      {
        memberName: 'Head A',
        role: '사업 최종 책임자',
        participationRate: 100,
        isDocumentOnly: false,
      },
      {
        memberName: 'Actor A',
        role: '실무책임자',
        participationRate: 100,
        isDocumentOnly: false,
      },
      {
        memberName: 'Operator A',
        role: '운영매니저',
        participationRate: 100,
        isDocumentOnly: false,
      },
    ],
    contractStart: '2026-01-01',
    contractEnd: '2027-12-31',
    contractAmount: 300_000,
    salesVatAmount: 30_000,
    totalRevenueAmount: 120_000,
    totalActualCost: 75_000,
    supportAmount: 10_000,
    financialInputFlags: {
      contractAmount: true,
      salesVatAmount: true,
      totalRevenueAmount: true,
      totalActualCost: true,
      supportAmount: true,
    },
    financialYears: [
      // 계약서 대조 확인 체크는 걷어냈다 - confirmed:false 인 채로도 제출이 통과해야 한다.
      { year: 2026, contractAmount: 100_000, salesVatAmount: 10_000, totalRevenueAmount: 40_000, totalActualCost: 25_000, supportAmount: 0, profitRate: 0.4, confirmed: false },
      { year: 2027, contractAmount: 200_000, salesVatAmount: 20_000, totalRevenueAmount: 80_000, totalActualCost: 50_000, supportAmount: 10_000, profitRate: 0.4, confirmed: false },
    ],
    registrationConfirmations: {
      laborIncludesFourInsurance: true,
      laborIncludesRetirementPay: true,
      customerSettlementBasisConfirmed: true,
      modusignContractUsed: true,
      originalContractSubmitted: false,
    },
    groupwareName: undefined,
    registrationOptionalDocumentNotes: {
      proposalWordOriginal: '제안서 Word 원본은 고객사 제공 자료가 없어 제출 제외',
      proposalPptOriginal: '제안서 PPT 원본은 고객사 제공 자료가 없어 제출 제외',
      presentationPptOriginal: '발표자료 PPT 원본은 해당 없음',
    },
    paymentExpectedMonths: {
      contract: '2026-07',
      interim: '',
      final: '2027-12',
    },
    advanceInterimBelow70Reason: '발주처 지급 조건에 따라 잔금 비중이 30%를 초과합니다.',
    ...overrides,
  });
  if (!Object.prototype.hasOwnProperty.call(overrides, 'groupwareName')) delete payload.groupwareName;
  return payload;
}

function addRequiredRegistrationAttachments(db, draftId, existing = []) {
  const path = `orgs/tenant-a/projectRequestDrafts/${draftId}`;
  const draft = db.documents.get(path);
  const existingKinds = new Set(existing.map((attachment) => attachment.documentKind));
  const missing = [
    'contract',
    'customer_business_registration',
    'quote',
    'proposal_word_original',
    'proposal_ppt_original',
    'presentation_ppt_original',
    'rfp_request_evidence',
  ]
    .filter((documentKind) => !existingKinds.has(documentKind))
    .map((documentKind) => ({
      attachmentId: `required-${documentKind}`,
      documentKind,
      path: `orgs/tenant-a/project-registration-drafts/${draftId}/${documentKind}.pdf`,
      name: `${documentKind}.pdf`,
      size: VALID_PDF.byteLength,
      contentType: 'application/pdf',
    }));
  db.documents.set(path, { ...draft, attachmentRefs: [...existing, ...missing] });
}

async function expectHttpError(promise, statusCode, code) {
  await expect(promise).rejects.toMatchObject({ statusCode, code });
}

describe('project registration draft service', () => {
  it('creates one opaque draft and initial lease atomically, then replays exactly', async () => {
    const { db, service, base, auditChainService, advance } = createHarness();
    const input = {
      ...base,
      idempotencyKey: 'idem-create',
      payload: { name: 'Private draft' },
      stepIndex: 1,
    };

    const first = await service.create(input);
    const leasePath = `orgs/tenant-a/editLeases/${resolveEditLeaseDocumentId('project-registration', 'draft-1')}`;
    const storedExpiry = db.documents.get(leasePath).expiresAt;
    advance(60_000);
    const replay = await service.create(input);

    expect(first).toMatchObject({
      status: 201,
      replayed: false,
      body: {
        draft: { draftId: 'draft-1', draftRevision: 0, payload: { name: 'Private draft' } },
        lease: { state: 'ACTIVE', canEdit: true, leaseId: 'lease-1', fence: 1 },
      },
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(db.documents.get(leasePath).expiresAt).toBe(storedExpiry);
    expect([...db.documents.keys()].filter((path) => path.includes('/projectRequestDrafts/'))).toHaveLength(1);
    expect([...db.documents.keys()].filter((path) => path.includes('/editLeases/'))).toHaveLength(1);
    expect(auditChainService.appendManyInTransaction).toHaveBeenCalledTimes(1);
    expect(auditChainService.appendManyInTransaction.mock.calls[0][1].map((entry) => entry.action))
      .toEqual(['PROJECT_REGISTRATION_DRAFT_CREATE', 'EDIT_LEASE_ACQUIRE']);
    await expectHttpError(service.create({ ...input, sessionId: 'session-b' }), 409, 'idempotency_conflict');
  });

  it('rejects oversized create and PATCH payloads before fingerprinting or transactions', async () => {
    const harness = createHarness();
    const transactionSpy = vi.spyOn(harness.db, 'runTransaction');
    const oversizedPayload = { text: 'x'.repeat((900 * 1024) + 1) };

    await expectHttpError(
      harness.service.create({
        ...harness.base,
        idempotencyKey: 'idem-oversized-create',
        payload: oversizedPayload,
      }),
      413,
      'draft_payload_too_large',
    );
    expect(transactionSpy).not.toHaveBeenCalled();

    const created = await harness.service.create({
      ...harness.base,
      idempotencyKey: 'idem-small-create',
      payload: { name: 'small' },
    });
    transactionSpy.mockClear();
    await expectHttpError(
      harness.service.update({
        ...harness.base,
        idempotencyKey: 'idem-oversized-patch',
        draftId: created.body.draft.draftId,
        leaseId: created.body.lease.leaseId,
        fence: created.body.lease.fence,
        expectedDraftRevision: 0,
        payload: oversizedPayload,
      }),
      413,
      'draft_payload_too_large',
    );
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('rejects a nested own __proto__ key before create fingerprinting without writes', async () => {
    const { db, service, base, auditChainService } = createHarness();
    const dangerousPayload = JSON.parse(
      '{"profile":{"__proto__":{"displayName":"different"}}}',
    );

    await expectHttpError(
      service.create({ ...base, idempotencyKey: 'idem-create-dangerous-key', payload: dangerousPayload }),
      422,
      'draft_payload_invalid',
    );
    expect([...db.documents.keys()].filter((path) => path.includes('/projectRequestDrafts/'))).toHaveLength(0);
    expect([...db.documents.keys()].filter((path) => path.includes('/idempotency_keys/'))).toHaveLength(0);
    expect(auditChainService.appendManyInTransaction).not.toHaveBeenCalled();
  });

  it('rejects a reused create key when two safe payloads differ', async () => {
    const { service, base } = createHarness();
    const idempotencyKey = 'idem-create-safe-conflict';

    await service.create({ ...base, idempotencyKey, payload: { profile: { name: 'first' } } });

    await expectHttpError(
      service.create({ ...base, idempotencyKey, payload: { profile: { name: 'second' } } }),
      409,
      'idempotency_conflict',
    );
  });

  it.each([
    ['undefined', () => ({ nested: { value: undefined } })],
    ['NaN', () => ({ value: Number.NaN })],
    ['infinite number', () => ({ value: Number.POSITIVE_INFINITY })],
    ['unsafe number', () => ({ value: Number.MAX_SAFE_INTEGER + 1 })],
    ['root undefined', () => undefined],
    ['root null', () => null],
    ['root array', () => []],
    ['root scalar', () => 'text'],
    ['nested array', () => ({ rows: [[1]] })],
    ['non-plain object', () => ({ createdAt: new Date() })],
    ['BigInt', () => ({ value: 1n })],
    ['oversized UTF-8 key', () => ({ ['가'.repeat(501)]: true })],
    ['cycle', () => {
      const value = {};
      value.self = value;
      return value;
    }],
    ['depth above 20', () => {
      let value = 'leaf';
      for (let depth = 0; depth < 10_000; depth += 1) value = { child: value };
      return value;
    }],
  ])('rejects %s before create fingerprinting without writes', async (_label, createPayload) => {
    const { db, service, base, auditChainService } = createHarness();

    await expectHttpError(
      service.create({
        ...base,
        idempotencyKey: `idem-invalid-${_label}`,
        payload: createPayload(),
      }),
      422,
      'draft_payload_invalid',
    );

    expect([...db.documents.keys()].filter((path) => path.includes('/projectRequestDrafts/'))).toHaveLength(0);
    expect([...db.documents.keys()].filter((path) => path.includes('/idempotency_keys/'))).toHaveLength(0);
    expect(auditChainService.appendManyInTransaction).not.toHaveBeenCalled();
  });

  it('adopts only the current owner legacy draft without deleting its data', async () => {
    const legacyPath = 'orgs/tenant-a/projectRequestDrafts/registration-actor-a';
    const legacy = {
      id: 'registration-actor-a',
      ownerId: 'actor-a',
      payloadSnapshot: { name: 'Legacy', contractDocument: { path: 'legacy.pdf' } },
      stepIndex: 3,
      attachmentRefs: [{ attachmentId: 'legacy-file', path: 'legacy.pdf' }],
      status: 'DRAFT',
      version: 4,
    };
    const { db, service, base } = createHarness({ seed: { [legacyPath]: legacy } });

    const created = await service.create({ ...base, idempotencyKey: 'idem-adopt' });

    expect(created.body.draft).toMatchObject({
      payload: legacy.payloadSnapshot,
      stepIndex: 3,
      attachmentRefs: legacy.attachmentRefs,
    });
    expect(db.documents.get(legacyPath)).toMatchObject({
      ...legacy,
      migrationStatus: 'ADOPTED',
      adoptedByDraftId: 'draft-1',
    });
  });

  it('ignores a legacy document whose owner does not match the actor', async () => {
    const legacyPath = 'orgs/tenant-a/projectRequestDrafts/registration-actor-a';
    const legacy = {
      ownerUid: 'actor-b',
      payloadSnapshot: { name: 'Foreign private draft' },
      status: 'DRAFT',
    };
    const { db, service, base } = createHarness({ seed: { [legacyPath]: legacy } });

    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-ignore-foreign',
      payload: { name: 'Actor A draft' },
    });

    expect(created.body.draft.payload).toEqual({ name: 'Actor A draft' });
    expect(db.documents.get(legacyPath)).toEqual(legacy);
  });

  it('returns an owner draft after lease expiry and hides it from every other actor', async () => {
    const { service, base, advance } = createHarness();
    const created = await service.create({ ...base, idempotencyKey: 'idem-private-read' });
    advance(1_800_000);

    await expect(service.get({ ...base, draftId: created.body.draft.draftId }))
      .resolves.toEqual({ draft: created.body.draft });
    await expectHttpError(
      service.get({ ...base, actorId: 'actor-b', actorRole: 'pm', draftId: created.body.draft.draftId }),
      404,
      'not_found',
    );
    await expectHttpError(
      service.get({ ...base, actorId: 'actor-admin', actorRole: 'admin', draftId: created.body.draft.draftId }),
      404,
      'not_found',
    );
  });

  it('downloads a stored draft attachment only for its owner and exact document kind', async () => {
    const downloadDraftAttachment = vi.fn(async () => ({
      buffer: Buffer.from('private-draft-pdf'),
      contentType: 'application/pdf',
      size: 17,
    }));
    const { db, service, base } = createHarness({
      storageService: { downloadDraftAttachment },
    });
    const created = await service.create({ ...base, idempotencyKey: 'idem-preview-create' });
    const draftId = created.body.draft.draftId;
    const path = `orgs/tenant-a/project-registration-drafts/${draftId}/attachment-a-contract.pdf`;
    db.documents.set(`orgs/tenant-a/projectRequestDrafts/${draftId}`, {
      ...db.documents.get(`orgs/tenant-a/projectRequestDrafts/${draftId}`),
      attachmentRefs: [{
        attachmentId: 'attachment-a', documentKind: 'contract', path,
        name: 'contract.pdf', size: 17, contentType: 'application/pdf',
      }],
    });

    await expect(service.readAttachment({ ...base, draftId, documentKind: 'contract' }))
      .resolves.toMatchObject({
        buffer: Buffer.from('private-draft-pdf'), name: 'contract.pdf', contentType: 'application/pdf',
      });
    await expectHttpError(
      service.readAttachment({ ...base, actorId: 'actor-b', draftId, documentKind: 'contract' }),
      404,
      'not_found',
    );
    await expectHttpError(
      service.readAttachment({ ...base, draftId, documentKind: 'quote' }),
      404,
      'not_found',
    );
    await expectHttpError(
      service.readAttachment({ ...base, draftId, documentKind: 'browser-controlled' }),
      400,
      'draft_attachment_invalid',
    );
    expect(downloadDraftAttachment).toHaveBeenCalledOnce();
    expect(downloadDraftAttachment).toHaveBeenCalledWith({ tenantId: 'tenant-a', draftId, path });
  });

  it('revision-saves only the draft, replays exactly, and rejects stale or wrong-session writes', async () => {
    const { db, service, base } = createHarness();
    const created = await service.create({ ...base, idempotencyKey: 'idem-patch-create' });
    const ownership = {
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
    };
    const patch = {
      ...base,
      ...ownership,
      draftId: created.body.draft.draftId,
      idempotencyKey: 'idem-patch',
      expectedDraftRevision: 0,
      payload: { name: 'Saved privately' },
      stepIndex: 2,
    };

    const first = await service.update(patch);
    const replay = await service.update(patch);

    expect(first.body.draft).toMatchObject({ draftRevision: 1, payload: patch.payload, stepIndex: 2 });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(db.documents.get('orgs/tenant-a/projectRequestDrafts/draft-1')).toMatchObject({
      draftRevision: 1,
      payload: patch.payload,
    });
    await expectHttpError(
      service.update({ ...patch, idempotencyKey: 'idem-stale', expectedDraftRevision: 0 }),
      409,
      'draft_version_conflict',
    );
    await expectHttpError(
      service.update({ ...patch, idempotencyKey: 'idem-wrong-session', sessionId: 'session-b', expectedDraftRevision: 1 }),
      423,
      'edit_lease_held',
    );
    await expectHttpError(
      service.update({ ...patch, idempotencyKey: 'idem-wrong-fence', fence: ownership.fence + 1, expectedDraftRevision: 1 }),
      423,
      'edit_lease_held',
    );
  });

  it.each([
    'contract',
    'customer_business_registration',
    'quote',
  ])('rejects a v2 save when the %s attachment is missing', async (missingKind) => {
    const { db, service, base } = createHarness();
    const created = await service.create({ ...base, idempotencyKey: `idem-save-${missingKind}-create` });
    addRequiredRegistrationAttachments(db, created.body.draft.draftId);
    const path = `orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`;
    const draft = db.documents.get(path);
    db.documents.set(path, {
      ...draft,
      attachmentRefs: draft.attachmentRefs.filter((attachment) => attachment.documentKind !== missingKind),
    });

    await expectHttpError(service.update({
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      idempotencyKey: `idem-save-${missingKind}`,
      expectedDraftRevision: 0,
      payload: validRegistrationV2Payload(),
    }), 422, 'project_registration_invalid');
  });

  it.each([
    ['quote attached', {}, true],
    ['quote deferred', { quoteSubmissionDeferred: true }, false],
  ])('accepts a v2 save when the %s path satisfies the quote requirement', async (_label, payloadOverrides, includeQuote) => {
    const { db, service, base } = createHarness();
    const created = await service.create({ ...base, idempotencyKey: `idem-save-${_label}-create` });
    addRequiredRegistrationAttachments(db, created.body.draft.draftId);
    const path = `orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`;
    if (!includeQuote) {
      const draft = db.documents.get(path);
      db.documents.set(path, {
        ...draft,
        attachmentRefs: draft.attachmentRefs.filter((attachment) => attachment.documentKind !== 'quote'),
      });
    }

    await expect(service.update({
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      idempotencyKey: `idem-save-${_label}`,
      expectedDraftRevision: 0,
      payload: validRegistrationV2Payload(payloadOverrides),
    })).resolves.toMatchObject({ status: 200 });
  });

  it('lists only my active registration drafts, newest first', async () => {
    const h = createHarness();
    const row = (overrides) => ({
      ownerUid: 'actor-a', ownerId: 'actor-a', tenantId: 'tenant-a',
      resourceType: 'project-registration', draftRevision: 1, status: 'ACTIVE',
      payload: { name: '' }, stepIndex: 2,
      createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
      ...overrides,
    });
    h.db.documents.set('orgs/tenant-a/projectRequestDrafts/draft-old', row({
      resourceId: 'draft-old', alias: '이어가던 것', payload: { name: '지난주 초안' }, updatedAt: '2026-08-20T09:00:00.000Z',
    }));
    h.db.documents.set('orgs/tenant-a/projectRequestDrafts/draft-new', row({
      resourceId: 'draft-new', payload: { name: '' }, updatedAt: '2026-08-25T09:00:00.000Z',
    }));
    h.db.documents.set('orgs/tenant-a/projectRequestDrafts/draft-submitted', row({
      resourceId: 'draft-submitted', status: 'SUBMITTED', updatedAt: '2026-08-26T09:00:00.000Z',
    }));
    h.db.documents.set('orgs/tenant-a/projectRequestDrafts/draft-other-user', row({
      resourceId: 'draft-other-user', ownerUid: 'actor-b', ownerId: 'actor-b', updatedAt: '2026-08-26T09:00:00.000Z',
    }));

    const listed = await h.service.listMine({
      tenantId: 'tenant-a', actorId: 'actor-a', actorDisplayName: 'Actor A', requestId: 'request-list',
    });
    expect(listed.drafts).toEqual([
      { draftId: 'draft-new', alias: '', name: '', updatedAt: '2026-08-25T09:00:00.000Z', stepIndex: 2 },
      { draftId: 'draft-old', alias: '이어가던 것', name: '지난주 초안', updatedAt: '2026-08-20T09:00:00.000Z', stepIndex: 2 },
    ]);
  });

  it('soft-discards my draft, hides it from the list, and refuses submitted drafts', async () => {
    const h = createHarness();
    const row = (overrides) => ({
      ownerUid: 'actor-a', ownerId: 'actor-a', tenantId: 'tenant-a',
      resourceType: 'project-registration', draftRevision: 1, status: 'ACTIVE',
      payload: { name: '' }, stepIndex: 0,
      attachmentRefs: [{ documentKind: 'contract', path: 'orgs/tenant-a/project-registration-drafts/draft-x/a-contract.pdf', name: 'a.pdf', size: 3, contentType: 'application/pdf' }],
      createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
      ...overrides,
    });
    h.db.documents.set('orgs/tenant-a/projectRequestDrafts/draft-x', row({ resourceId: 'draft-x' }));
    h.db.documents.set('orgs/tenant-a/projectRequestDrafts/draft-done', row({ resourceId: 'draft-done', status: 'SUBMITTED' }));

    const discarded = await h.service.discard({
      tenantId: 'tenant-a', actorId: 'actor-a', actorDisplayName: 'Actor A', requestId: 'request-discard', draftId: 'draft-x',
    });
    expect(discarded.body).toEqual({ draftId: 'draft-x', status: 'DISCARDED' });
    expect(h.db.documents.get('orgs/tenant-a/projectRequestDrafts/draft-x')).toMatchObject({ status: 'DISCARDED' });
    const cleanup = [...h.db.documents.entries()].find(([path]) => path.startsWith('outbox/'));
    expect(cleanup?.[1]?.payload?.paths).toEqual(['orgs/tenant-a/project-registration-drafts/draft-x/a-contract.pdf']);

    const listed = await h.service.listMine({
      tenantId: 'tenant-a', actorId: 'actor-a', actorDisplayName: 'Actor A', requestId: 'request-list-2',
    });
    expect(listed.drafts.some((draft) => draft.draftId === 'draft-x')).toBe(false);

    await expect(h.service.discard({
      tenantId: 'tenant-a', actorId: 'actor-a', actorDisplayName: 'Actor A', requestId: 'request-discard-2', draftId: 'draft-done',
    })).rejects.toMatchObject({ code: 'draft_already_submitted' });
  });

  it('atomically submits only the stored private draft and replays after releasing the lease', async () => {
    const memberPath = 'orgs/tenant-a/members/actor-a';
    const { db, service, base, auditChainService } = createHarness({
      seed: {
        [memberPath]: {
          uid: 'actor-a',
          role: 'pm',
          status: 'ACTIVE',
          name: 'Preserved Name',
          email: 'preserved@example.com',
          createdAt: '2025-01-01T00:00:00.000Z',
          projectId: 'existing-project',
          projectIds: ['existing-project'],
          projectNames: { 'existing-project': 'Existing' },
          portalProfile: {
            projectId: 'existing-project',
            projectIds: ['existing-project'],
            projectNames: { 'existing-project': 'Existing' },
            role: 'preserved-profile-role',
          },
        },
      },
    });
    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-submit-create',
      payload: validRegistrationV2Payload(),
    });
    addRequiredRegistrationAttachments(db, created.body.draft.draftId);
    const input = {
      ...base,
      actorEmail: 'actor-a@example.com',
      idempotencyKey: 'idem-submit',
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 0,
    };

    const first = await service.submit(input);
    const replay = await service.submit(input);

    expect(first).toMatchObject({
      status: 201,
      replayed: false,
      body: {
        status: 'SUBMITTED',
        projectId: 'project-1',
        projectRequestId: 'project-request-1',
        projectVersion: 1,
        draftId: created.body.draft.draftId,
        draftRevision: 1,
        lease: { state: 'RELEASED', canEdit: false },
        outbox: { id: 'outbox-1', status: 'PENDING' },
      },
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(db.documents.get('orgs/tenant-a/projects/project-1')).toMatchObject({
      id: 'project-1',
      name: VALID_V2_PROJECT_NAME,
      registrationSource: 'pm_portal',
      executiveReviewStatus: 'PENDING',
      version: 1,
      taxInvoiceAmount: 0,
      isSettled: false,
      finalPaymentExpectedWeek: '26-12-4',
    });
    expect(db.documents.get('orgs/tenant-a/projects/project-1')).not.toHaveProperty('arbitraryBrowserField');
    expect(db.documents.get('orgs/tenant-a/project_requests/project-request-1')).toMatchObject({
      id: 'project-request-1',
      sourceDraftId: created.body.draft.draftId,
      status: 'PENDING',
      approvedProjectId: 'project-1',
      payload: { name: VALID_V2_PROJECT_NAME, finalPaymentExpectedWeek: '26-12-4' },
    });
    expect(db.documents.get('orgs/tenant-a/project_requests/project-request-1').payload)
      .not.toHaveProperty('arbitraryBrowserField');
    expect(db.documents.get(`orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`)).toMatchObject({
      status: 'SUBMITTED',
      draftRevision: 1,
      submittedProjectId: 'project-1',
      submittedProjectRequestId: 'project-request-1',
    });
    expect(db.documents.get(`orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`))
      .not.toHaveProperty('payload');
    expect(db.documents.get(`orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`))
      .not.toHaveProperty('attachmentRefs');
    expect(db.documents.get(`orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`))
      .not.toHaveProperty('stepIndex');
    expect(db.documents.get(`orgs/tenant-a/editLeases/${resolveEditLeaseDocumentId('project-registration', created.body.draft.draftId)}`))
      .toMatchObject({ state: 'RELEASED', releaseReason: 'FINAL_SUBMIT' });
    expect(db.documents.get(memberPath)).toMatchObject({
      uid: 'actor-a',
      role: 'pm',
      name: 'Preserved Name',
      email: 'preserved@example.com',
      createdAt: '2025-01-01T00:00:00.000Z',
      projectId: 'project-1',
      projectIds: ['existing-project', 'project-1'],
      projectNames: { 'existing-project': 'Existing', 'project-1': VALID_V2_PROJECT_NAME },
      lastLoginAt: '2026-07-10T00:00:00.000Z',
      portalProfile: {
        role: 'preserved-profile-role',
        projectId: 'project-1',
        projectIds: ['existing-project', 'project-1'],
        projectNames: { 'existing-project': 'Existing', 'project-1': VALID_V2_PROJECT_NAME },
      },
    });
    expect([...db.documents.keys()].filter((path) => path === 'outbox/outbox-1')).toHaveLength(1);
    const submitIdempotency = [...db.documents.values()]
      .find((document) => document.idempotencyKey === 'idem-submit');
    expect(Date.parse(submitIdempotency.expiresAt) - Date.parse(submitIdempotency.completedAt)).toBe(86_400_000);
    expect(auditChainService.appendManyInTransaction).toHaveBeenCalledTimes(2);
    expect(auditChainService.appendManyInTransaction.mock.calls[1][1].map((entry) => entry.action))
      .toEqual(['PROJECT_REGISTRATION_SUBMIT', 'EDIT_LEASE_RELEASE']);
  });

  it.each([
    [
      'same-tenant owner document is missing',
      { registeredById: 'foreign-owner', managerId: 'foreign-owner' },
      { 'orgs/tenant-b/members/foreign-owner': { uid: 'foreign-owner', role: 'pm', status: 'ACTIVE' } },
    ],
    [
      'owner status is missing',
      { registeredById: 'actor-b', managerId: 'actor-b' },
      { 'orgs/tenant-a/members/actor-b': { uid: 'actor-b', role: 'pm' } },
    ],
    [
      'executive approver is inactive',
      {},
      { 'orgs/tenant-a/members/head-a': { uid: 'head-a', role: 'admin', status: 'INACTIVE' } },
    ],
    [
      'executive approver UID does not match its member document',
      {},
      { 'orgs/tenant-a/members/head-a': { uid: 'different-head', role: 'admin', status: 'ACTIVE' } },
    ],
  ])('rejects final submit when the selected %s', async (_label, payloadOverrides, seed) => {
    const { db, service, base } = createHarness({ seed });
    const created = await service.create({
      ...base,
      idempotencyKey: `idem-active-member-create-${_label}`,
      payload: validRegistrationV2Payload(payloadOverrides),
    });
    addRequiredRegistrationAttachments(db, created.body.draft.draftId);

    await expectHttpError(service.submit({
      ...base,
      actorEmail: 'actor-a@example.com',
      idempotencyKey: `idem-active-member-submit-${_label}`,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 0,
    }), 403, 'forbidden');

    expect(db.documents.has('orgs/tenant-a/projects/project-1')).toBe(false);
    expect(db.documents.has('orgs/tenant-a/project_requests/project-request-1')).toBe(false);
    expect(db.documents.has('outbox/outbox-1')).toBe(false);
    expect(db.documents.get(`orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`))
      .toMatchObject({ status: 'ACTIVE', draftRevision: 0 });
  });

  it('rechecks selected member activity when Firestore retries final submit', async () => {
    const { db, service, base } = createHarness();
    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-member-retry-create',
      payload: validRegistrationV2Payload(),
    });
    addRequiredRegistrationAttachments(db, created.body.draft.draftId);
    db.retryNextTransaction(() => {
      db.documents.set('orgs/tenant-a/members/head-a', {
        uid: 'head-a', role: 'admin', status: 'INACTIVE', projectIds: [],
      });
    });

    await expectHttpError(service.submit({
      ...base,
      actorEmail: 'actor-a@example.com',
      idempotencyKey: 'idem-member-retry-submit',
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 0,
    }), 403, 'forbidden');

    expect(db.documents.has('orgs/tenant-a/projects/project-1')).toBe(false);
    expect(db.documents.has('orgs/tenant-a/project_requests/project-request-1')).toBe(false);
    expect(db.documents.has('outbox/outbox-1')).toBe(false);
  });

  it.each([
    ['requester', { registeredById: 'actor-b', managerId: 'actor-b', executiveApproverId: 'actor-a' }],
    ['project owner', { registeredById: 'actor-b', managerId: 'actor-b', executiveApproverId: 'actor-b' }],
  ])('allows final submit when the designated executive approver is the %s', async (_label, payloadOverrides) => {
    const { db, service, base } = createHarness();
    const created = await service.create({
      ...base,
      idempotencyKey: `idem-self-approval-create-${_label}`,
      payload: validRegistrationV2Payload(payloadOverrides),
    });
    addRequiredRegistrationAttachments(db, created.body.draft.draftId);

    const submitted = await service.submit({
      ...base,
      actorEmail: 'actor-a@example.com',
      idempotencyKey: `idem-self-approval-submit-${_label}`,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 0,
    });

    expect(submitted.status).toBe(201);
    expect(db.documents.get('orgs/tenant-a/projects/project-1')).toMatchObject({
      executiveApproverId: payloadOverrides.executiveApproverId,
      executiveReviewStatus: 'PENDING',
    });
    expect(db.documents.get('orgs/tenant-a/project_requests/project-request-1')).toMatchObject({
      payload: { executiveApproverId: payloadOverrides.executiveApproverId },
    });
    expect(db.documents.has('outbox/outbox-1')).toBe(true);
  });

  it('replays a committed final submit when Firestore reports an invalid-or-closed transaction', async () => {
    const { db, service, base, auditChainService } = createHarness();
    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-submit-closed-create',
      payload: validRegistrationV2Payload(),
    });
    addRequiredRegistrationAttachments(db, created.body.draft.draftId);
    const runTransaction = db.runTransaction.bind(db);
    let submitTransactionCalls = 0;
    db.runTransaction = async (callback) => {
      submitTransactionCalls += 1;
      const result = await runTransaction(callback);
      if (submitTransactionCalls === 1) {
        throw Object.assign(new Error('3 INVALID_ARGUMENT: Transaction is invalid or closed.'), {
          code: 3,
          details: 'Transaction is invalid or closed.',
        });
      }
      return result;
    };

    const submitted = await service.submit({
      ...base,
      idempotencyKey: 'idem-submit-closed',
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 0,
    });

    expect(submitted).toMatchObject({ status: 201, replayed: true, body: { status: 'SUBMITTED' } });
    expect(submitTransactionCalls).toBe(2);
    expect([...db.documents.keys()].filter((path) => path.includes('/projects/'))).toHaveLength(1);
    expect([...db.documents.keys()].filter((path) => path.includes('/project_requests/'))).toHaveLength(1);
    expect([...db.documents.keys()].filter((path) => path.startsWith('outbox/'))).toHaveLength(1);
    expect(auditChainService.appendManyInTransaction).toHaveBeenCalledTimes(2);
  });

  it('accepts the seven PPT page 29 registration documents end to end', async () => {
    const storageService = {
      uploadDraftAttachment: vi.fn(async ({ tenantId, draftId, attachmentId, fileName, buffer, mimeType }) => ({
        path: `orgs/${tenantId}/project-registration-drafts/${draftId}/${attachmentId}-${fileName}`,
        name: fileName,
        size: buffer.byteLength,
        contentType: mimeType,
        uploadedAt: '2026-07-10T00:00:00.000Z',
      })),
      deleteDraftAttachment: vi.fn(async () => undefined),
    };
    const { db, service, base } = createHarness({ storageService });
    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-v2-create',
      payload: validRegistrationV2Payload(),
    });
    const documents = [
      ['contract', 'contract.pdf', 'application/pdf', VALID_PDF],
      ['customer_business_registration', 'customer.pdf', 'application/pdf', VALID_PDF],
      ['quote', 'quote.pdf', 'application/pdf', VALID_PDF],
      ['proposal_word_original', 'proposal.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', VALID_ZIP],
      ['proposal_ppt_original', 'proposal.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', VALID_ZIP],
      ['presentation_ppt_original', 'presentation.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', VALID_ZIP],
      ['rfp_request_evidence', 'rfp.pdf', 'application/pdf', VALID_PDF],
    ];
    for (const [revision, [documentKind, fileName, mimeType, buffer]] of documents.entries()) {
      await service.addAttachment({
        ...base,
        idempotencyKey: `idem-v2-${documentKind}`,
        draftId: created.body.draft.draftId,
        leaseId: created.body.lease.leaseId,
        fence: created.body.lease.fence,
        expectedDraftRevision: revision,
        documentKind,
        fileName,
        mimeType,
        fileSize: buffer.byteLength,
        buffer,
      });
    }

    await service.submit({
      ...base,
      idempotencyKey: 'idem-v2-submit',
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 7,
    });

    expect(db.documents.get('orgs/tenant-a/project_requests/project-request-1').payload).toMatchObject({
      registrationRequirementsVersion: 2,
      financialYears: [{ year: 2026, confirmed: false }, { year: 2027, confirmed: false }],
    });
    expect(db.documents.get('orgs/tenant-a/project_requests/project-request-1').payload)
      .not.toHaveProperty('groupwareName');
    expect(db.documents.get('outbox/outbox-1').payload.attachmentRefs.map((item) => item.documentKind))
      .toEqual(documents.map(([documentKind]) => documentKind));
  });

  it('submits an open-ended contract (contractEndUndecided) with financial years up to the current year', async () => {
    const { db, service, base } = createHarness();
    const currentYear = new Date().getFullYear();
    const years = Array.from({ length: currentYear - 2026 + 1 }, (_, offset) => ({
      year: 2026 + offset,
      contractAmount: offset === 0 ? 100_000 : 0,
      salesVatAmount: offset === 0 ? 10_000 : 0,
      totalRevenueAmount: offset === 0 ? 40_000 : 0,
      totalActualCost: offset === 0 ? 25_000 : 0,
      supportAmount: 0,
      profitRate: offset === 0 ? 0.4 : 0,
      confirmed: false,
    }));
    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-open-ended-create',
      payload: validRegistrationV2Payload({
        contractEnd: '',
        contractEndUndecided: true,
        financialYears: years,
        contractAmount: 100_000,
      }),
    });
    addRequiredRegistrationAttachments(db, created.body.draft.draftId);
    const submitted = await service.submit({
      ...base,
      idempotencyKey: 'idem-open-ended-submit',
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 0,
    });
    expect(submitted.status).toBe(201);
    const request = db.documents.get('orgs/tenant-a/project_requests/project-request-1');
    expect(request.payload).toMatchObject({ contractEnd: '', contractEndUndecided: true });
    const project = [...db.documents.entries()].find(([path]) => path.includes('/projects/'))[1];
    expect(project).toMatchObject({ contractEnd: '', contractEndUndecided: true });
  });

  it('still rejects a missing contract end without the open-ended flag, and both together', async () => {
    const { db, service, base } = createHarness();
    const missingEnd = await service.create({
      ...base,
      idempotencyKey: 'idem-missing-end-create',
      payload: validRegistrationV2Payload({ contractEnd: '' }),
    });
    addRequiredRegistrationAttachments(db, missingEnd.body.draft.draftId);
    await expect(service.submit({
      ...base,
      idempotencyKey: 'idem-missing-end-submit',
      draftId: missingEnd.body.draft.draftId,
      leaseId: missingEnd.body.lease.leaseId,
      fence: missingEnd.body.lease.fence,
      expectedDraftRevision: 0,
    })).rejects.toMatchObject({ code: 'project_registration_invalid' });

    const contradictory = await service.create({
      ...base,
      idempotencyKey: 'idem-contradictory-create',
      payload: validRegistrationV2Payload({ contractEndUndecided: true }),
    });
    addRequiredRegistrationAttachments(db, contradictory.body.draft.draftId);
    await expect(service.submit({
      ...base,
      idempotencyKey: 'idem-contradictory-submit',
      draftId: contradictory.body.draft.draftId,
      leaseId: contradictory.body.lease.leaseId,
      fence: contradictory.body.lease.fence,
      expectedDraftRevision: 0,
    })).rejects.toMatchObject({ code: 'project_registration_invalid' });
  });

  it('allows optional RFP to be omitted when a legacy proposal exists', async () => {
    const { db, service, base } = createHarness();
    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-v2-rfp-create',
      payload: validRegistrationV2Payload(),
    });
    addRequiredRegistrationAttachments(db, created.body.draft.draftId, [{
      attachmentId: 'proposal',
      documentKind: 'proposal',
      path: `orgs/tenant-a/project-registration-drafts/${created.body.draft.draftId}/proposal.pdf`,
      name: 'proposal.pdf',
      size: VALID_PDF.byteLength,
      contentType: 'application/pdf',
    }]);
    const path = `orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`;
    const draft = db.documents.get(path);
    db.documents.set(path, {
      ...draft,
      attachmentRefs: draft.attachmentRefs.filter((attachment) => attachment.documentKind !== 'rfp_request_evidence'),
    });

    await expect(service.submit({
      ...base,
      idempotencyKey: 'idem-v2-rfp-submit',
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 0,
    })).resolves.toMatchObject({ status: 201 });
  });

  it('keeps a stored legacy proposal when the required RFP is uploaded', async () => {
    const storageService = {
      uploadDraftAttachment: vi.fn(async ({ tenantId, draftId, attachmentId, fileName, buffer, mimeType }) => ({
        path: `orgs/${tenantId}/project-registration-drafts/${draftId}/${attachmentId}-${fileName}`,
        name: fileName,
        size: buffer.byteLength,
        contentType: mimeType,
        uploadedAt: '2026-07-10T00:00:00.000Z',
      })),
      deleteDraftAttachment: vi.fn(async () => undefined),
    };
    const { db, service, base } = createHarness({ storageService });
    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-v2-alternative-create',
      payload: validRegistrationV2Payload(),
    });
    const common = {
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    };
    const proposal = await service.addAttachment({
      ...common,
      idempotencyKey: 'idem-v2-alternative-proposal',
      expectedDraftRevision: 0,
      documentKind: 'proposal',
      fileName: 'proposal.pdf',
    });
    await service.addAttachment({
      ...common,
      idempotencyKey: 'idem-v2-alternative-rfp',
      expectedDraftRevision: 1,
      documentKind: 'rfp_request_evidence',
      fileName: 'rfp.pdf',
    });
    addRequiredRegistrationAttachments(db, created.body.draft.draftId, db.documents.get(
      `orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`,
    ).attachmentRefs);

    const storedDraft = db.documents.get(`orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`);
    expect(storedDraft.attachmentRefs.map((item) => item.documentKind))
    expect(storedDraft.attachmentRefs.map((item) => item.documentKind)).toContain('proposal');
    expect(storedDraft.attachmentRefs.map((item) => item.documentKind)).toContain('rfp_request_evidence');
    expect(storageService.deleteDraftAttachment).not.toHaveBeenCalledWith(expect.objectContaining({
      path: proposal.body.attachment.path,
    }));

    await service.submit({
      ...base,
      idempotencyKey: 'idem-v2-alternative-submit',
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 2,
    });

    expect(db.documents.get('outbox/outbox-1').payload.attachmentRefs.map((item) => item.documentKind))
      .toEqual(expect.arrayContaining(['proposal', 'rfp_request_evidence']));
  });

  it('samples lease time again when Firestore retries final submit', async () => {
    const { db, service, base, advance } = createHarness();
    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-submit-retry-expiry-create',
      payload: validRegistrationV2Payload(),
    });
    addRequiredRegistrationAttachments(db, created.body.draft.draftId);
    db.retryNextTransaction(() => advance((30 * 60 * 1000) + 1));

    await expectHttpError(service.submit({
      ...base,
      idempotencyKey: 'idem-submit-retry-expiry',
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 0,
    }), 410, 'edit_lease_expired');

    expect(db.documents.has('orgs/tenant-a/projects/project-1')).toBe(false);
    expect(db.documents.get(`orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`))
      .toMatchObject({ status: 'ACTIVE', draftRevision: 0 });
  });

  it('uses the successful transaction attempt time for every final-submit record', async () => {
    const { db, service, base, advance, auditChainService } = createHarness();
    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-submit-retry-time-create',
      payload: validRegistrationV2Payload(),
    });
    addRequiredRegistrationAttachments(db, created.body.draft.draftId);
    db.retryNextTransaction(() => advance(60_000));

    const submitted = await service.submit({
      ...base,
      idempotencyKey: 'idem-submit-retry-time',
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 0,
    });

    const successfulAt = '2026-07-10T00:01:00.000Z';
    expect(submitted.body.submittedAt).toBe(successfulAt);
    expect(db.documents.get('orgs/tenant-a/projects/project-1').createdAt).toBe(successfulAt);
    expect(db.documents.get('orgs/tenant-a/project_requests/project-request-1').requestedAt).toBe(successfulAt);
    expect(db.documents.get('outbox/outbox-1')).toMatchObject({
      createdAt: successfulAt,
      updatedAt: successfulAt,
      nextAttemptAt: successfulAt,
    });
    expect([...db.documents.values()].find((document) => document.idempotencyKey === 'idem-submit-retry-time'))
      .toMatchObject({ completedAt: successfulAt });
    expect(auditChainService.appendManyInTransaction.mock.calls.at(-1)[1]
      .every((entry) => entry.timestamp === successfulAt)).toBe(true);
  });

  it.each([
    ['boolean contract amount', { contractAmount: true }],
    ['non-numeric sales VAT', { salesVatAmount: 'not-money' }],
    ['negative revenue', { totalRevenueAmount: -1 }],
    ['negative payment amount', { paymentPlan: { contract: -1, interim: 0, final: 100_000 } }],
    ['invalid contract date', { contractStart: '2026-13-01' }],
    ['reversed contract dates', { contractStart: '2026-12-31', contractEnd: '2026-07-01' }],
  ])('rejects %s instead of coercing finance data during final submit', async (_label, payloadOverrides) => {
    const { db, service, base } = createHarness();
    const created = await service.create({
      ...base,
      idempotencyKey: `idem-submit-invalid-create-${_label}`,
      payload: validRegistrationPayload(payloadOverrides),
    });

    await expectHttpError(service.submit({
      ...base,
      idempotencyKey: `idem-submit-invalid-${_label}`,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 0,
    }), 422, 'project_registration_invalid');

    expect([...db.documents.keys()].filter((path) => path.includes('/projects/'))).toHaveLength(0);
    expect([...db.documents.keys()].filter((path) => path.startsWith('outbox/'))).toHaveLength(0);
    expect(db.documents.get(`orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`))
      .toMatchObject({ status: 'ACTIVE', draftRevision: 0 });
  });

  it('rolls back every final-submit write when audit append fails', async () => {
    const auditChainService = { appendManyInTransaction: vi.fn(async () => []) };
    const { db, service, base } = createHarness({ auditChainService });
    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-submit-audit-create',
      payload: validRegistrationV2Payload(),
    });
    addRequiredRegistrationAttachments(db, created.body.draft.draftId);
    auditChainService.appendManyInTransaction.mockRejectedValueOnce(new Error('audit append failed'));

    await expect(service.submit({
      ...base,
      idempotencyKey: 'idem-submit-audit-failure',
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 0,
    })).rejects.toThrow('audit append failed');

    expect([...db.documents.keys()].filter((path) => path.includes('/projects/'))).toHaveLength(0);
    expect([...db.documents.keys()].filter((path) => path.includes('/project_requests/'))).toHaveLength(0);
    expect([...db.documents.keys()].filter((path) => path.startsWith('outbox/'))).toHaveLength(0);
    expect(db.documents.get(`orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`))
      .toMatchObject({ status: 'ACTIVE', draftRevision: 0 });
    expect(db.documents.get(`orgs/tenant-a/editLeases/${resolveEditLeaseDocumentId('project-registration', created.body.draft.draftId)}`))
      .toMatchObject({ state: 'ACTIVE' });
  });

  it('does not partially submit when a generated canonical ID collides', async () => {
    const existingProject = { id: 'project-1', name: 'Existing', version: 9 };
    const { db, service, base } = createHarness({
      seed: { 'orgs/tenant-a/projects/project-1': existingProject },
    });
    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-submit-collision-create',
      payload: validRegistrationV2Payload(),
    });
    addRequiredRegistrationAttachments(db, created.body.draft.draftId);

    await expectHttpError(service.submit({
      ...base,
      idempotencyKey: 'idem-submit-collision',
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 0,
    }), 409, 'canonical_id_conflict');

    expect(db.documents.get('orgs/tenant-a/projects/project-1')).toEqual(existingProject);
    expect([...db.documents.keys()].filter((path) => path.includes('/project_requests/'))).toHaveLength(0);
    expect([...db.documents.keys()].filter((path) => path.startsWith('outbox/'))).toHaveLength(0);
    expect(db.documents.get(`orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`))
      .toMatchObject({ status: 'ACTIVE', draftRevision: 0 });
  });

  it('maps only the latest typed private attachment to each canonical document field', async () => {
    const storageService = {
      uploadDraftAttachment: vi.fn(async ({ tenantId, draftId, attachmentId, fileName, buffer, mimeType }) => ({
        path: `orgs/${tenantId}/project-registration-drafts/${draftId}/${attachmentId}-${fileName}`,
        name: fileName,
        size: buffer.byteLength,
        contentType: mimeType,
        uploadedAt: '2026-07-10T00:00:00.000Z',
      })),
      deleteDraftAttachment: vi.fn(async () => undefined),
    };
    const { db, service, base } = createHarness({ storageService });
    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-submit-doc-create',
      payload: validRegistrationV2Payload({
        contractDocument: { path: 'browser-controlled', downloadURL: 'https://public.example/secret' },
      }),
    });
    const attachmentBase = {
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      documentKind: 'contract',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    };
    await service.addAttachment({
      ...attachmentBase,
      idempotencyKey: 'idem-submit-doc-first',
      expectedDraftRevision: 0,
      fileName: 'old-contract.pdf',
    });
    await service.addAttachment({
      ...attachmentBase,
      idempotencyKey: 'idem-submit-doc-latest',
      expectedDraftRevision: 1,
      fileName: 'latest-contract.pdf',
    });
    addRequiredRegistrationAttachments(
      db,
      created.body.draft.draftId,
      db.documents.get(`orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`).attachmentRefs,
    );

    await service.submit({
      ...base,
      idempotencyKey: 'idem-submit-doc-final',
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 2,
    });

    const project = db.documents.get('orgs/tenant-a/projects/project-1');
    expect(project.contractDocument).toBeNull();
    expect(db.documents.get(`orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`))
      .not.toHaveProperty('attachmentRefs');
    expect(db.documents.get('outbox/outbox-1').payload.attachmentRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentKind: 'contract', name: 'latest-contract.pdf' }),
      expect.objectContaining({ documentKind: 'customer_business_registration' }),
      expect.objectContaining({ documentKind: 'quote' }),
      expect.objectContaining({ documentKind: 'proposal_word_original' }),
      expect.objectContaining({ documentKind: 'proposal_ppt_original' }),
      expect.objectContaining({ documentKind: 'presentation_ppt_original' }),
      expect.objectContaining({ documentKind: 'rfp_request_evidence' }),
    ]));
  });

  it('rejects adopted attachment paths outside the current private draft prefix', async () => {
    const legacyPath = 'orgs/tenant-a/projectRequestDrafts/registration-actor-a';
    const { db, service, base } = createHarness({
      seed: {
        [legacyPath]: {
          ownerUid: 'actor-a',
          status: 'DRAFT',
          payloadSnapshot: validRegistrationPayload(),
          attachmentRefs: [{
            attachmentId: 'legacy-contract',
            documentKind: 'contract',
            path: 'orgs/tenant-a/project-registration-drafts/another-draft/legacy-contract.pdf',
            name: 'legacy-contract.pdf',
          }],
        },
      },
    });
    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-submit-adopted-path-create',
    });

    await expectHttpError(service.submit({
      ...base,
      idempotencyKey: 'idem-submit-adopted-path',
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 0,
    }), 422, 'draft_attachment_invalid');

    expect(db.documents.has('orgs/tenant-a/projects/project-1')).toBe(false);
    expect(db.documents.get(`orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`))
      .toMatchObject({ status: 'ACTIVE', attachmentRefs: [expect.objectContaining({ attachmentId: 'legacy-contract' })] });
  });

  it('preserves current financial flag semantics by inferring positive stored amounts', async () => {
    const { db, service, base } = createHarness();
    const payload = validRegistrationV2Payload({
      type: 'I1',
      supportAmount: 0,
      financialYears: [
        { year: 2026, contractAmount: 100_000, salesVatAmount: 10_000, totalRevenueAmount: 40_000, totalActualCost: 25_000, supportAmount: 0, profitRate: 0.4, confirmed: true },
        { year: 2027, contractAmount: 200_000, salesVatAmount: 20_000, totalRevenueAmount: 80_000, totalActualCost: 50_000, supportAmount: 0, profitRate: 0.4, confirmed: true },
      ],
    });
    delete payload.financialInputFlags;
    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-submit-financial-flags-create',
      payload,
    });
    addRequiredRegistrationAttachments(db, created.body.draft.draftId);
    await service.submit({
      ...base,
      idempotencyKey: 'idem-submit-financial-flags',
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 0,
    });

    expect(db.documents.get('orgs/tenant-a/projects/project-1').financialInputFlags).toEqual({
      contractAmount: true,
      salesVatAmount: true,
      totalRevenueAmount: true,
      totalActualCost: true,
      supportAmount: false,
    });
  });

  it('rejects a reused PATCH key when two safe payloads differ', async () => {
    const { service, base } = createHarness();
    const created = await service.create({ ...base, idempotencyKey: 'idem-patch-safe-create' });
    const common = {
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      idempotencyKey: 'idem-patch-safe-conflict',
      expectedDraftRevision: 0,
    };

    await service.update({ ...common, payload: { profile: { name: 'first' } } });

    await expectHttpError(
      service.update({ ...common, payload: { profile: { name: 'second' } } }),
      409,
      'idempotency_conflict',
    );
  });

  it.each([
    ['nested own __proto__', () => ({
      payload: JSON.parse('{"profile":{"__proto__":{"displayName":"different"}}}'),
    })],
    ['root array', () => ({ payload: [] })],
    ['missing payload', () => ({})],
  ])('rejects a %s PATCH payload before fingerprinting without writes', async (_label, createPatchInput) => {
    const { db, service, base, auditChainService } = createHarness();
    const created = await service.create({ ...base, idempotencyKey: 'idem-invalid-patch-create' });
    const draftPath = 'orgs/tenant-a/projectRequestDrafts/draft-1';
    const beforeDraft = clone(db.documents.get(draftPath));
    const beforeIdempotencyCount = [...db.documents.keys()]
      .filter((path) => path.includes('/idempotency_keys/')).length;
    const beforeAuditCount = auditChainService.appendManyInTransaction.mock.calls.length;

    await expectHttpError(
      service.update({
        ...base,
        draftId: created.body.draft.draftId,
        leaseId: created.body.lease.leaseId,
        fence: created.body.lease.fence,
        idempotencyKey: 'idem-invalid-patch',
        expectedDraftRevision: 0,
        ...createPatchInput(),
      }),
      422,
      'draft_payload_invalid',
    );

    expect(db.documents.get(draftPath)).toEqual(beforeDraft);
    expect([...db.documents.keys()].filter((path) => path.includes('/idempotency_keys/')))
      .toHaveLength(beforeIdempotencyCount);
    expect(auditChainService.appendManyInTransaction).toHaveBeenCalledTimes(beforeAuditCount);
  });

  it('rejects a draft document above the safe Firestore size before writing it', async () => {
    const { db, service, base, auditChainService } = createHarness();
    const created = await service.create({ ...base, idempotencyKey: 'idem-size-create' });

    await expectHttpError(service.update({
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      idempotencyKey: 'idem-size-patch',
      expectedDraftRevision: 0,
      payload: { text: 'x'.repeat(901 * 1024) },
    }), 413, 'draft_payload_too_large');

    expect(db.documents.get('orgs/tenant-a/projectRequestDrafts/draft-1').draftRevision).toBe(0);
    expect(auditChainService.appendManyInTransaction).toHaveBeenCalledTimes(1);
  });

  it('deletes the superseded private object after a same-kind replacement commits', async () => {
    let uploadCount = 0;
    const storageService = {
      uploadDraftAttachment: vi.fn(async ({ tenantId, draftId, attachmentId, fileName, buffer, mimeType }) => ({
        path: `orgs/${tenantId}/project-registration-drafts/${draftId}/${attachmentId}-${++uploadCount}-${fileName}`,
        name: fileName,
        size: buffer.byteLength,
        contentType: mimeType,
        uploadedAt: '2026-07-10T00:00:00.000Z',
      })),
      deleteDraftAttachment: vi.fn(async () => undefined),
    };
    const { db, service, base } = createHarness({ storageService });
    const created = await service.create({ ...base, idempotencyKey: 'idem-replace-create' });
    const common = {
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      documentKind: 'contract',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    };
    const first = await service.addAttachment({
      ...common, idempotencyKey: 'idem-replace-first', expectedDraftRevision: 0, fileName: 'first.pdf',
    });
    await service.addAttachment({
      ...common, idempotencyKey: 'idem-replace-second', expectedDraftRevision: 1, fileName: 'second.pdf',
    });

    expect(storageService.deleteDraftAttachment).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      draftId: created.body.draft.draftId,
      path: first.body.attachment.path,
    });
    expect(db.documents.get('outbox/cleanup-outbox-1')).toMatchObject({
      eventType: 'draft.attachments.cleanup',
      entityType: 'project_registration_draft',
      entityId: created.body.draft.draftId,
      payload: {
        draftId: created.body.draft.draftId,
        paths: [first.body.attachment.path],
      },
      status: 'PENDING',
    });
  });

  it('clears stale contract analysis when a private contract is replaced before submission', async () => {
    let uploadCount = 0;
    const storageService = {
      uploadDraftAttachment: vi.fn(async ({ tenantId, draftId, attachmentId, fileName, buffer, mimeType }) => ({
        path: `orgs/${tenantId}/project-registration-drafts/${draftId}/${attachmentId}-${++uploadCount}-${fileName}`,
        name: fileName,
        size: buffer.byteLength,
        contentType: mimeType,
        uploadedAt: '2026-07-10T00:00:00.000Z',
      })),
      deleteDraftAttachment: vi.fn(async () => undefined),
    };
    const { db, service, base } = createHarness({ storageService });
    const created = await service.create({
      ...base,
      idempotencyKey: 'idem-contract-analysis-create',
      payload: validRegistrationV2Payload(),
    });
    const attachmentInput = {
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      documentKind: 'contract',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    };
    const first = await service.addAttachment({
      ...attachmentInput,
      idempotencyKey: 'idem-contract-analysis-first',
      expectedDraftRevision: 0,
      fileName: 'contract-a.pdf',
    });
    addRequiredRegistrationAttachments(
      db,
      created.body.draft.draftId,
      db.documents.get(`orgs/tenant-a/projectRequestDrafts/${created.body.draft.draftId}`).attachmentRefs,
    );
    await service.update({
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      idempotencyKey: 'idem-contract-analysis-save-a',
      expectedDraftRevision: 1,
      payload: validRegistrationV2Payload({
        contractDocument: { path: first.body.attachment.path },
        contractAnalysis: { summary: 'contract A analysis' },
      }),
    });
    const replacement = await service.addAttachment({
      ...attachmentInput,
      idempotencyKey: 'idem-contract-analysis-replacement',
      expectedDraftRevision: 2,
      fileName: 'contract-b.pdf',
    });

    expect(replacement.body.draft.payload.contractAnalysis).toBeNull();
    addRequiredRegistrationAttachments(
      db,
      created.body.draft.draftId,
      [replacement.body.attachment],
    );
    await service.submit({
      ...base,
      idempotencyKey: 'idem-contract-analysis-submit',
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 3,
    });

    expect(db.documents.get('orgs/tenant-a/projects/project-1').contractAnalysis).toBeNull();
    expect(db.documents.get('orgs/tenant-a/project_requests/project-request-1').payload.contractAnalysis).toBeNull();
  });

  it('removes a private attachment only with the owning lease fence and advances the draft revision', async () => {
    const storageService = {
      uploadDraftAttachment: vi.fn(async ({ tenantId, draftId, attachmentId, fileName, buffer, mimeType }) => ({
        path: `orgs/${tenantId}/project-registration-drafts/${draftId}/${attachmentId}-${fileName}`,
        name: fileName,
        size: buffer.byteLength,
        contentType: mimeType,
        uploadedAt: '2026-07-10T00:00:00.000Z',
      })),
      deleteDraftAttachment: vi.fn(async () => undefined),
    };
    const { db, service, base } = createHarness({ storageService });
    const created = await service.create({ ...base, idempotencyKey: 'idem-remove-create' });
    const uploaded = await service.addAttachment({
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      idempotencyKey: 'idem-remove-upload',
      expectedDraftRevision: 0,
      documentKind: 'contract',
      fileName: 'contract.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    });
    await service.update({
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      idempotencyKey: 'idem-remove-save-path',
      expectedDraftRevision: 1,
      payload: { contractDocument: { path: uploaded.body.attachment.path } },
    });

    await expectHttpError(service.removeAttachment({
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence + 1,
      idempotencyKey: 'idem-remove-wrong-fence',
      expectedDraftRevision: 2,
      documentKind: 'contract',
    }), 423, 'edit_lease_held');
    expect(storageService.deleteDraftAttachment).not.toHaveBeenCalled();
    expect(db.documents.has('outbox/cleanup-outbox-1')).toBe(false);

    const removed = await service.removeAttachment({
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      idempotencyKey: 'idem-remove-contract',
      expectedDraftRevision: 2,
      documentKind: 'contract',
    });

    expect(removed.body.draft).toMatchObject({
      draftRevision: 3,
      attachmentRefs: [],
      payload: { contractDocument: null },
    });
    expect(storageService.deleteDraftAttachment).toHaveBeenCalledOnce();
    expect(storageService.deleteDraftAttachment).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      draftId: created.body.draft.draftId,
      path: uploaded.body.attachment.path,
    });
    expect(db.documents.get('outbox/cleanup-outbox-1')).toMatchObject({
      eventType: 'draft.attachments.cleanup',
      payload: {
        draftId: created.body.draft.draftId,
        paths: [uploaded.body.attachment.path],
      },
    });
  });

  it('deletes only the just-uploaded object when the post-upload transaction conflicts', async () => {
    const deleted = [];
    let uploadCount = 0;
    let db;
    const storageService = {
      uploadDraftAttachment: vi.fn(async ({ tenantId, draftId, attachmentId, fileName, buffer, mimeType }) => {
        uploadCount += 1;
        const path = `orgs/${tenantId}/project-registration-drafts/${draftId}/${attachmentId}-${fileName}`;
        if (uploadCount === 2) {
          await db.doc(`orgs/${tenantId}/projectRequestDrafts/${draftId}`).set({ draftRevision: 2 }, { merge: true });
        }
        return { path, name: fileName, size: buffer.byteLength, contentType: mimeType, uploadedAt: '2026-07-10T00:00:00.000Z' };
      }),
      deleteDraftAttachment: vi.fn(async ({ path }) => {
        deleted.push(path);
        throw new Error('sensitive cleanup detail: orgs/tenant-a/private/contract.pdf');
      }),
    };
    const harness = createHarness({ storageService });
    db = harness.db;
    const { service, base } = harness;
    const created = await service.create({ ...base, idempotencyKey: 'idem-attachment-create' });
    const common = {
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      documentKind: 'contract',
      fileName: 'contract.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    };

    const first = await service.addAttachment({
      ...common,
      idempotencyKey: 'idem-attachment-1',
      expectedDraftRevision: 0,
    });
    const firstPath = first.body.attachment.path;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expectHttpError(
        service.addAttachment({
          ...common,
          idempotencyKey: 'idem-attachment-2',
          expectedDraftRevision: 1,
        }),
        409,
        'draft_version_conflict',
      );
      expect(warn).toHaveBeenCalledWith('[bff] draft attachment cleanup failed', {
        requestId: 'request-a',
        errorCode: 'draft_attachment_cleanup_failed',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/sensitive cleanup detail|contract\.pdf|orgs\/tenant-a/i);
    } finally {
      warn.mockRestore();
    }

    expect(deleted).toEqual([
      'orgs/tenant-a/project-registration-drafts/draft-1/attachment-2-contract.pdf',
    ]);
    expect(db.documents.get('orgs/tenant-a/projectRequestDrafts/draft-1').attachmentRefs)
      .toEqual([expect.objectContaining({ path: firstPath })]);
  });

  it('rejects non-PDF MIME types and fake PDF content before private storage', async () => {
    const storageService = {
      uploadDraftAttachment: vi.fn(),
      deleteDraftAttachment: vi.fn(),
    };
    const { service, base } = createHarness({ storageService });
    const created = await service.create({ ...base, idempotencyKey: 'idem-pdf-validation-create' });
    const attachment = {
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      expectedDraftRevision: 0,
      documentKind: 'contract',
      fileName: 'contract.pdf',
    };

    await expectHttpError(service.addAttachment({
      ...attachment,
      idempotencyKey: 'idem-pdf-validation-mime',
      mimeType: 'text/plain',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    }), 422, 'draft_attachment_invalid');
    const fakePdf = Buffer.from('not-a-pdf');
    await expectHttpError(service.addAttachment({
      ...attachment,
      idempotencyKey: 'idem-pdf-validation-magic',
      mimeType: 'application/pdf',
      fileSize: fakePdf.byteLength,
      buffer: fakePdf,
    }), 422, 'draft_attachment_invalid');
    expect(storageService.uploadDraftAttachment).not.toHaveBeenCalled();
  });

  it('rejects a reused attachment key when only the raw file bytes differ', async () => {
    const storageService = {
      uploadDraftAttachment: vi.fn(async ({ tenantId, draftId, attachmentId, fileName, buffer, mimeType }) => ({
        path: `orgs/${tenantId}/project-registration-drafts/${draftId}/${attachmentId}-${fileName}`,
        name: fileName,
        size: buffer.byteLength,
        contentType: mimeType,
        uploadedAt: '2026-07-10T00:00:00.000Z',
      })),
      deleteDraftAttachment: vi.fn(async () => undefined),
    };
    const { service, base } = createHarness({ storageService });
    const created = await service.create({ ...base, idempotencyKey: 'idem-attachment-bytes-create' });
    const firstPdf = Buffer.from('%PDF-A');
    const secondPdf = Buffer.from('%PDF-B');
    const common = {
      ...base,
      draftId: created.body.draft.draftId,
      leaseId: created.body.lease.leaseId,
      fence: created.body.lease.fence,
      idempotencyKey: 'idem-attachment-bytes',
      expectedDraftRevision: 0,
      documentKind: 'contract',
      fileName: 'bytes.pdf',
      mimeType: 'application/pdf',
      fileSize: firstPdf.byteLength,
    };

    await service.addAttachment({ ...common, buffer: firstPdf });

    await expectHttpError(
      service.addAttachment({ ...common, buffer: secondPdf }),
      409,
      'idempotency_conflict',
    );
    expect(storageService.uploadDraftAttachment).toHaveBeenCalledTimes(1);
    expect(storageService.deleteDraftAttachment).not.toHaveBeenCalled();
  });
});

describe('project registration draft routes', () => {
  function createRouteApp({ enabled = true } = {}) {
    const service = {
      create: vi.fn(async () => ({ status: 201, replayed: false, body: { draft: { draftId: 'draft-a' }, lease: { leaseId: 'lease-a' } } })),
      get: vi.fn(async () => ({ draft: { draftId: 'draft-a' } })),
      update: vi.fn(async () => ({ status: 200, replayed: false, body: { draft: { draftId: 'draft-a', draftRevision: 1 } } })),
      addAttachment: vi.fn(async () => ({ status: 200, replayed: false, body: { draft: { draftId: 'draft-a', draftRevision: 2 } } })),
      removeAttachment: vi.fn(async () => ({ status: 200, replayed: false, body: { draft: { draftId: 'draft-a', draftRevision: 3 } } })),
      readAttachment: vi.fn(async () => ({
        buffer: Buffer.from('private-draft-pdf'),
        contentType: 'application/pdf',
        size: 17,
        name: 'contract\"\r\nX-Test: injected.pdf',
      })),
      submit: vi.fn(async () => ({
        status: 201,
        replayed: false,
        body: { projectId: 'project-a', projectRequestId: 'request-a', draftId: 'draft-a', draftRevision: 2 },
      })),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.context = {
        tenantId: 'tenant-a',
        actorId: 'actor-a',
        actorRole: 'pm',
        actorName: 'Actor A',
        requestId: 'request-a',
        idempotencyKey: req.header('idempotency-key') || undefined,
      };
      next();
    });
    mountProjectRegistrationDraftRoutes(app, {
      enabled,
      projectRegistrationDraftService: service,
      piiProtector: { encryptText: vi.fn(async () => ({ ciphertext: 'encrypted-email' })) },
    });
    app.use((error, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error', message: error.message });
    });
    return { app, service };
  }

  it('does not mount the private API when the Stage lease flag is disabled', async () => {
    const { app } = createRouteApp({ enabled: false });
    await request(app).post('/api/v1/project-registration-drafts').send({}).expect(404);
  });

  it('passes revision and lease headers to PATCH without using the global mutating wrapper', async () => {
    const { app, service } = createRouteApp();

    const response = await request(app)
      .patch('/api/v1/project-registration-drafts/draft-a')
      .set({
        'idempotency-key': 'idem-route-patch',
        'x-edit-session-id': 'session-a',
        'x-edit-lease-id': 'lease-a',
        'x-edit-fence': '4',
      })
      .send({ expectedDraftRevision: 0, payload: { name: 'Saved' }, stepIndex: 2 })
      .expect(200);

    expect(response.body.draft).toMatchObject({ draftId: 'draft-a', draftRevision: 1 });
    expect(service.update).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      actorId: 'actor-a',
      actorRole: 'pm',
      draftId: 'draft-a',
      sessionId: 'session-a',
      leaseId: 'lease-a',
      fence: 4,
      idempotencyKey: 'idem-route-patch',
      expectedDraftRevision: 0,
      payload: { name: 'Saved' },
      stepIndex: 2,
    }));
  });

  it('passes only expected revision and lease headers to atomic submit', async () => {
    const { app, service } = createRouteApp();

    const response = await request(app)
      .post('/api/v1/project-registration-drafts/draft-a/submit')
      .set({
        'idempotency-key': 'idem-route-submit',
        'x-edit-session-id': 'session-a',
        'x-edit-lease-id': 'lease-a',
        'x-edit-fence': '4',
      })
      .send({ expectedDraftRevision: 1 })
      .expect(201);

    expect(response.body).toMatchObject({ projectId: 'project-a', projectRequestId: 'request-a' });
    expect(service.submit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      actorId: 'actor-a',
      draftId: 'draft-a',
      sessionId: 'session-a',
      leaseId: 'lease-a',
      fence: 4,
      idempotencyKey: 'idem-route-submit',
      expectedDraftRevision: 1,
    }));

    await request(app)
      .post('/api/v1/project-registration-drafts/draft-a/submit')
      .set({
        'idempotency-key': 'idem-route-submit-extra',
        'x-edit-session-id': 'session-a',
        'x-edit-lease-id': 'lease-a',
        'x-edit-fence': '4',
      })
      .send({ expectedDraftRevision: 1, projectId: 'browser-controlled' })
      .expect(400);
  });

  it('requires a typed private attachment kind and forwards it to storage registration', async () => {
    const { app, service } = createRouteApp();
    const headers = {
      'idempotency-key': 'idem-route-attachment-kind',
      'x-edit-session-id': 'session-a',
      'x-edit-lease-id': 'lease-a',
      'x-edit-fence': '4',
    };
    const body = {
      expectedDraftRevision: 1,
      documentKind: 'quote',
      fileName: 'quote.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      contentBase64: VALID_PDF.toString('base64'),
    };

    await request(app)
      .post('/api/v1/project-registration-drafts/draft-a/attachments')
      .set(headers)
      .send(body)
      .expect(200);
    expect(service.addAttachment).toHaveBeenCalledWith(expect.objectContaining({ documentKind: 'quote' }));

    await request(app)
      .post('/api/v1/project-registration-drafts/draft-a/attachments')
      .set({ ...headers, 'idempotency-key': 'idem-route-attachment-kind-missing' })
      .send({ ...body, documentKind: undefined })
      .expect(400);
  });

  it('passes the typed attachment kind, revision, and lease fence to DELETE', async () => {
    const { app, service } = createRouteApp();
    await request(app)
      .delete('/api/v1/project-registration-drafts/draft-a/attachments/quote')
      .set({
        'idempotency-key': 'idem-route-attachment-remove',
        'x-edit-session-id': 'session-a',
        'x-edit-lease-id': 'lease-a',
        'x-edit-fence': '4',
      })
      .send({ expectedDraftRevision: 2 })
      .expect(200);

    expect(service.removeAttachment).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      actorId: 'actor-a',
      draftId: 'draft-a',
      sessionId: 'session-a',
      leaseId: 'lease-a',
      fence: 4,
      expectedDraftRevision: 2,
      documentKind: 'quote',
    }));
  });

  it('serves an owner draft attachment as private no-store bytes without edit lease headers', async () => {
    const { app, service } = createRouteApp();

    const response = await request(app)
      .get('/api/v1/project-registration-drafts/draft-a/attachments/contract')
      .expect(200);

    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toContain('%22%0D%0AX-Test%3A%20injected.pdf');
    expect(response.headers['x-test']).toBeUndefined();
    expect(response.body).toEqual(Buffer.from('private-draft-pdf'));
    expect(service.readAttachment).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', actorId: 'actor-a', draftId: 'draft-a', documentKind: 'contract',
    }));
  });

  it('returns 422 for a root array before the real create service writes anything', async () => {
    const harness = createHarness();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.context = {
        tenantId: 'tenant-a',
        actorId: 'actor-a',
        actorRole: 'pm',
        actorName: 'Actor A',
        requestId: 'request-array',
        idempotencyKey: req.header('idempotency-key') || undefined,
      };
      next();
    });
    mountProjectRegistrationDraftRoutes(app, {
      enabled: true,
      projectRegistrationDraftService: harness.service,
    });
    app.use((error, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app)
      .post('/api/v1/project-registration-drafts')
      .set({
        'idempotency-key': 'idem-route-root-array',
        'x-edit-session-id': 'session-a',
      })
      .send({ payload: [], stepIndex: 0 })
      .expect(422);

    expect(response.body.error).toBe('draft_payload_invalid');
    expect([...harness.db.documents.keys()].filter((path) => path.includes('/projectRequestDrafts/')))
      .toHaveLength(0);
    expect([...harness.db.documents.keys()].filter((path) => path.includes('/idempotency_keys/')))
      .toHaveLength(0);
    expect(harness.auditChainService.appendManyInTransaction).not.toHaveBeenCalled();
  });
});
