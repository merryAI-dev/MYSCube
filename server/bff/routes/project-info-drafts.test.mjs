import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createIdempotencyService } from '../idempotency.mjs';
import { buildActiveEditLeaseDocument, resolveEditLeaseDocumentId } from '../edit-lease.mjs';
import { loadRbacPolicy } from '../rbac-policy.mjs';
import {
  createProjectInfoDraftService,
  createProjectInfoSubmittedOutboxHandler,
  mountProjectInfoDraftRoutes,
} from './project-info-drafts.mjs';

const VALID_PDF = Buffer.from('%PDF-1.4\n');

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createDb(seed = {}) {
  const documents = new Map(Object.entries(seed).map(([path, value]) => [path, clone(value)]));
  function snapshot(path) {
    const exists = documents.has(path);
    return { exists, id: path.split('/').at(-1), data: () => (exists ? clone(documents.get(path)) : undefined) };
  }
  function doc(path) {
    return {
      path,
      get: async () => snapshot(path),
      set: async (value, options = {}) => documents.set(
        path,
        options.merge && documents.has(path) ? { ...documents.get(path), ...clone(value) } : clone(value),
      ),
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

  return {
    documents,
    doc,
    collection,
    async runTransaction(callback) {
      const writes = [];
      const tx = {
        get: async (ref) => snapshot(ref.path),
        set: (ref, value, options = {}) => writes.push({ type: 'set', ref, value: clone(value), options }),
        create: (ref, value) => writes.push({ type: 'create', ref, value: clone(value), options: {} }),
      };
      const result = await callback(tx);
      for (const write of writes) {
        const current = documents.get(write.ref.path);
        if (write.type === 'create' && current !== undefined) throw new Error('document already exists');
        documents.set(write.ref.path, write.options.merge && current
          ? { ...current, ...write.value }
          : write.value);
      }
      return result;
    },
  };
}

function validPayload(overrides = {}) {
  return {
    name: 'Project A',
    officialContractName: 'Project A contract',
    type: 'D1',
    status: 'IN_PROGRESS',
    phase: 'CONFIRMED',
    description: 'Before',
    clientOrg: 'Client',
    department: 'AXR',
    currency: 'KRW',
    contractAmount: 100000,
    salesVatAmount: 10000,
    totalRevenueAmount: 40000,
    supportAmount: 0,
    financialInputFlags: { contractAmount: true },
    contractStart: '2026-07-01',
    contractEnd: '2026-12-31',
    contractType: '계약서(날인)',
    settlementType: 'TYPE1',
    basis: '공급가액',
    accountType: 'OPERATING',
    fundInputMode: 'BANK_UPLOAD',
    paymentPlan: { contract: 100000, interim: 0, final: 0 },
    paymentPlanDesc: '선금 100%',
    settlementGuide: '',
    finalPaymentNote: '',
    projectPurpose: 'Purpose',
    registeredById: 'actor-a',
    registeredByName: 'Actor A',
    executiveApproverId: 'head-a',
    executiveApproverName: 'Head A',
    executiveApproverEmail: 'head-a@example.com',
    managerId: 'actor-a',
    managerName: 'Actor A',
    teamName: 'AXR',
    teamMembers: '',
    teamMembersDetailed: [],
    participantCondition: '',
    note: '',
    contractDocument: null,
    quoteDocument: null,
    proposalDocument: null,
    contractAnalysis: null,
    ...overrides,
  };
}

function validV2Payload(overrides = {}) {
  return validPayload({
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
    paymentExpectedMonths: { contract: '2026-07', interim: '', final: '' },
    advanceInterimBelow70Reason: '',
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
    teamMembersDetailed: [
      {
        memberName: 'Head A',
        memberNickname: 'Head',
        role: '사업 최종 책임자',
        participationRate: 100,
        isDocumentOnly: false,
      },
      {
        memberName: 'Actor A',
        memberNickname: 'Actor',
        role: '실무책임자',
        participationRate: 100,
        isDocumentOnly: false,
      },
      {
        memberName: 'Operator A',
        memberNickname: 'Operator',
        role: '운영매니저',
        participationRate: 100,
        isDocumentOnly: false,
      },
    ],
    contractDocument: { path: 'orgs/tenant-a/project-registration-documents/project-a/contract.pdf' },
    customerBusinessRegistrationDocument: {
      path: 'orgs/tenant-a/project-registration-documents/project-a/customer-business-registration.pdf',
    },
    quoteDocument: { path: 'orgs/tenant-a/project-registration-documents/project-a/quote.pdf' },
    proposalDocument: { path: 'orgs/tenant-a/project-registration-documents/project-a/proposal.pdf' },
    proposalWordOriginalDocument: {
      path: 'orgs/tenant-a/project-registration-documents/project-a/proposal.docx',
    },
    proposalPptOriginalDocument: {
      path: 'orgs/tenant-a/project-registration-documents/project-a/proposal.pptx',
    },
    presentationPptOriginalDocument: {
      path: 'orgs/tenant-a/project-registration-documents/project-a/presentation.pptx',
    },
    rfpRequestEvidenceDocument: {
      path: 'orgs/tenant-a/project-registration-documents/project-a/rfp.pdf',
    },
    ...overrides,
  });
}

function harness({ storageService, outboxEventFactory, cleanupOutboxEventFactory } = {}) {
  let nowMs = Date.parse('2026-07-12T00:00:00.000Z');
  let cleanupOutboxSequence = 0;
  const lease = buildActiveEditLeaseDocument({
    tenantId: 'tenant-a', resourceType: 'project-info', resourceId: 'project-a',
    actorId: 'actor-a', actorDisplayName: 'Actor A', sessionId: 'session-a',
    leaseId: 'lease-a', serverNow: nowMs,
  });
  const db = createDb({
    'orgs/tenant-a/members/actor-a': {
      uid: 'actor-a', role: 'pm', status: 'ACTIVE', projectIds: ['project-a'],
    },
    'orgs/tenant-a/members/actor-admin': {
      uid: 'actor-admin', role: 'admin', status: 'ACTIVE', projectIds: [],
    },
    'orgs/tenant-a/projects/project-a': {
      id: 'project-a', tenantId: 'tenant-a', version: 3, executiveReviewStatus: 'APPROVED',
      executiveReviewHistory: [], ...validV2Payload(),
    },
    [`orgs/tenant-a/editLeases/${resolveEditLeaseDocumentId('project-info', 'project-a')}`]: lease,
  });
  const auditChainService = { appendManyInTransaction: vi.fn(async () => []) };
  const idempotencyService = createIdempotencyService(db, { now: () => new Date(nowMs) });
  const effectiveStorageService = {
    ...(storageService || {}),
    inspectProjectRegistrationAttachment: storageService?.inspectProjectRegistrationAttachment || vi.fn(async ({ path }) => {
      const attachment = [...db.documents.values()]
        .flatMap((document) => Array.isArray(document?.attachmentRefs) ? document.attachmentRefs : [])
        .find((candidate) => candidate?.path === path);
      if (!attachment) throw new Error('stored attachment not found');
      return clone(attachment);
    }),
  };
  const service = createProjectInfoDraftService({
    db,
    now: () => new Date(nowMs).toISOString(),
    createAttachmentId: () => 'attachment-a',
    createOutboxEvent: outboxEventFactory || ((input) => ({
      id: 'outbox-a', ...input, status: 'PENDING', attempts: 0,
      nextAttemptAt: input.createdAt, updatedAt: input.createdAt,
    })),
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
    draftStorageService: effectiveStorageService,
    rbacPolicy: loadRbacPolicy(),
  });
  const base = {
    tenantId: 'tenant-a', actorId: 'actor-a', actorDisplayName: 'Actor A',
    actorEmail: 'actor-a@example.com', actorRole: 'pm', requestId: 'request-a',
    projectId: 'project-a', sessionId: 'session-a', leaseId: 'lease-a', fence: 1,
  };
  return { db, service, base, auditChainService, advance: (ms) => { nowMs += ms; } };
}

async function openedDraft(h, key = 'open-a') {
  return h.service.open({ ...h.base, idempotencyKey: key });
}

describe('project information private drafts', () => {
  it('keeps an inherited unpublished attachment immutable when the next draft removes it', async () => {
    const storageService = {
      uploadProjectRegistrationAttachment: vi.fn(async (input) => ({
        path: `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${input.attachmentId}-${input.fileName}`,
        name: input.fileName,
        size: input.buffer.byteLength,
        contentType: input.mimeType,
        uploadedAt: '2026-07-12T00:01:00.000Z',
      })),
      deleteProjectRegistrationAttachment: vi.fn(async () => undefined),
    };
    const h = harness({ storageService });
    await openedDraft(h, 'immutable-open-v1');
    await h.service.addAttachment({
      ...h.base,
      idempotencyKey: 'immutable-upload-v1',
      expectedDraftRevision: 0,
      documentKind: 'contract',
      fileName: 'contract-v1.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    });
    await h.service.submit({
      ...h.base,
      idempotencyKey: 'immutable-submit-v1',
      expectedDraftRevision: 1,
      expectedVersion: 3,
    });
    h.db.documents.set(
      `orgs/tenant-a/editLeases/${resolveEditLeaseDocumentId('project-info', 'project-a')}`,
      buildActiveEditLeaseDocument({
        tenantId: 'tenant-a', resourceType: 'project-info', resourceId: 'project-a',
        actorId: 'actor-a', actorDisplayName: 'Actor A', sessionId: 'session-a',
        leaseId: 'lease-a', serverNow: Date.parse('2026-07-12T00:00:00.000Z'),
      }),
    );

    const reopened = await openedDraft(h, 'immutable-open-v2');
    expect(reopened.body.draft.attachmentRefs[0]).not.toHaveProperty('inheritedFromProjectRequest');
    const rawDraft = [...h.db.documents.values()].find((value) => value?.resourceType === 'project-info' && value?.status === 'ACTIVE');
    expect(rawDraft.attachmentRefs[0]).toMatchObject({
      documentKind: 'contract',
      inheritedFromProjectRequest: true,
    });

    const removed = await h.service.removeAttachment({
      ...h.base,
      idempotencyKey: 'immutable-remove-v2',
      expectedDraftRevision: 0,
      documentKind: 'contract',
    });

    expect(removed.body.draft).toMatchObject({
      draftRevision: 1,
      attachmentRefs: [],
      payload: { contractDocument: null },
    });
    expect(storageService.deleteProjectRegistrationAttachment).not.toHaveBeenCalled();
    expect([...h.db.documents.values()].some((value) => value?.eventType === 'draft.attachments.cleanup'))
      .toBe(false);
  });

  it('replaces an inherited proposal without deleting the prior request blob', async () => {
    const storageService = {
      uploadProjectRegistrationAttachment: vi.fn(async (input) => ({
        path: `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${input.attachmentId}-${input.fileName}`,
        name: input.fileName,
        size: input.buffer.byteLength,
        contentType: input.mimeType,
        uploadedAt: '2026-07-12T00:01:00.000Z',
      })),
      deleteProjectRegistrationAttachment: vi.fn(async () => undefined),
    };
    const h = harness({ storageService });
    await openedDraft(h, 'inherited-proposal-open-v1');
    await h.service.addAttachment({
      ...h.base,
      idempotencyKey: 'inherited-proposal-upload-v1',
      expectedDraftRevision: 0,
      documentKind: 'proposal',
      fileName: 'proposal-v1.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    });
    await h.service.submit({
      ...h.base,
      idempotencyKey: 'inherited-proposal-submit-v1',
      expectedDraftRevision: 1,
      expectedVersion: 3,
    });
    h.db.documents.set(
      `orgs/tenant-a/editLeases/${resolveEditLeaseDocumentId('project-info', 'project-a')}`,
      buildActiveEditLeaseDocument({
        tenantId: 'tenant-a', resourceType: 'project-info', resourceId: 'project-a',
        actorId: 'actor-a', actorDisplayName: 'Actor A', sessionId: 'session-a',
        leaseId: 'lease-a', serverNow: Date.parse('2026-07-12T00:00:00.000Z'),
      }),
    );
    await openedDraft(h, 'inherited-proposal-open-v2');

    const replacement = await h.service.addAttachment({
      ...h.base,
      idempotencyKey: 'inherited-rfp-upload-v2',
      expectedDraftRevision: 0,
      documentKind: 'rfp_request_evidence',
      fileName: 'rfp-v2.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    });

    expect(replacement.body.draft.attachmentRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentKind: 'proposal', name: 'proposal-v1.pdf' }),
      expect.objectContaining({ documentKind: 'rfp_request_evidence', name: 'rfp-v2.pdf' }),
    ]));
    expect(storageService.deleteProjectRegistrationAttachment).not.toHaveBeenCalled();
    expect([...h.db.documents.values()].some((value) => value?.eventType === 'draft.attachments.cleanup'))
      .toBe(false);
  });

  it('opens an owner-only draft from canonical data and hides it from admins', async () => {
    const h = harness();
    h.db.documents.set('orgs/tenant-a/members/actor-a', {
      ...h.db.documents.get('orgs/tenant-a/members/actor-a'), projectIds: [],
    });
    const opened = await openedDraft(h);

    expect(opened).toMatchObject({
      status: 200,
      body: { draft: {
        projectId: 'project-a', resourceType: 'project-info', draftRevision: 0,
        baseCanonicalVersion: 3, payload: { name: 'Project A' }, status: 'ACTIVE',
      } },
    });
    await expect(h.service.get({
      tenantId: 'tenant-a', actorId: 'actor-admin', projectId: 'project-a',
    })).rejects.toMatchObject({ statusCode: 404, code: 'not_found' });
  });

  it('opens a pending V2 change draft for a legacy project before its participation sheet is linked', async () => {
    const h = harness();
    const manualTeam = [{
      memberName: 'Actor A',
      memberNickname: 'Actor',
      role: '운영매니저',
      participationRate: 50,
      isDocumentOnly: false,
    }];
    h.db.documents.set('orgs/tenant-a/projects/project-a', {
      id: 'project-a',
      tenantId: 'tenant-a',
      version: 3,
      executiveReviewStatus: 'APPROVED',
      executiveReviewHistory: [],
      ...validPayload({ teamMembersDetailed: manualTeam }),
    });
    h.db.documents.set('orgs/tenant-a/project_requests/change-project-a', {
      id: 'change-project-a',
      requestKind: 'CHANGE',
      status: 'PENDING',
      targetProjectId: 'project-a',
      proposedSnapshot: validV2Payload({ teamMembersDetailed: manualTeam }),
    });
    const projectBeforeOpen = clone(h.db.documents.get('orgs/tenant-a/projects/project-a'));
    const requestBeforeOpen = clone(h.db.documents.get('orgs/tenant-a/project_requests/change-project-a'));

    const opened = await openedDraft(h, 'open-legacy-pending-v2');

    expect(opened).toMatchObject({
      status: 200,
      body: { draft: {
        projectId: 'project-a',
        draftRevision: 0,
        payload: {
          registrationRequirementsVersion: 2,
          participationSheetLink: '',
          teamMembersDetailed: manualTeam,
        },
      } },
    });
    expect(h.db.documents.get('orgs/tenant-a/projects/project-a')).toEqual(projectBeforeOpen);
    expect(h.db.documents.get('orgs/tenant-a/project_requests/change-project-a')).toEqual(requestBeforeOpen);
  });

  it('hydrates a pending no-link sheet roster but still rejects it at submission', async () => {
    const h = harness();
    const manualTeam = [{
      memberName: 'Actor A',
      memberNickname: 'Actor',
      role: '운영매니저',
      participationRate: 50,
      isDocumentOnly: false,
    }];
    const sheetTeam = [{
      personId: 'person-a',
      memberName: 'Actor A',
      memberNickname: 'Actor',
      role: '',
      participationRate: 20,
      laborAllocationStartMonth: '2026-07',
      laborAllocationEndMonth: '2026-12',
      monthlyRates: {
        '2026-07': 20,
        '2026-08': 0,
        '2026-09': null,
      },
    }];
    h.db.documents.set('orgs/tenant-a/projects/project-a', {
      id: 'project-a',
      tenantId: 'tenant-a',
      version: 3,
      executiveReviewStatus: 'APPROVED',
      executiveReviewHistory: [],
      ...validPayload({ teamMembersDetailed: manualTeam }),
    });
    h.db.documents.set('orgs/tenant-a/project_requests/change-project-a', {
      id: 'change-project-a',
      requestKind: 'CHANGE',
      status: 'PENDING',
      targetProjectId: 'project-a',
      proposedSnapshot: validV2Payload({ teamMembersDetailed: sheetTeam }),
    });
    const projectBeforeOpen = clone(h.db.documents.get('orgs/tenant-a/projects/project-a'));
    const requestBeforeOpen = clone(h.db.documents.get('orgs/tenant-a/project_requests/change-project-a'));

    const opened = await openedDraft(h, 'open-legacy-pending-sheet-v2');

    expect(opened.body.draft.payload).toMatchObject({
      registrationRequirementsVersion: 2,
      participationSheetLink: '',
      teamMembersDetailed: sheetTeam,
    });
    expect(h.db.documents.get('orgs/tenant-a/projects/project-a')).toEqual(projectBeforeOpen);
    expect(h.db.documents.get('orgs/tenant-a/project_requests/change-project-a')).toEqual(requestBeforeOpen);
    await expect(h.service.submit({
      ...h.base,
      idempotencyKey: 'submit-legacy-pending-sheet-v2',
      expectedDraftRevision: 0,
      expectedVersion: 3,
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'project_registration_invalid',
      message: expect.stringContaining('participationSheetLink'),
    });
    expect(h.db.documents.get('orgs/tenant-a/projects/project-a')).toEqual(projectBeforeOpen);
    expect(h.db.documents.get('orgs/tenant-a/project_requests/change-project-a')).toEqual(requestBeforeOpen);
  });

  it('returns an existing active owner draft without hydrating an incompatible pending seed', async () => {
    const h = harness();
    const projectPath = 'orgs/tenant-a/projects/project-a';
    const requestPath = 'orgs/tenant-a/project_requests/change-project-a';
    const draftId = `v1_${Buffer.from(JSON.stringify(['project-info', 'project-a', 'actor-a']), 'utf8').toString('base64url')}`;
    const draftPath = `orgs/tenant-a/privateEditDrafts/${draftId}`;
    const existingDraft = {
      ownerUid: 'actor-a',
      tenantId: 'tenant-a',
      resourceType: 'project-info',
      resourceId: 'project-a',
      draftRevision: 7,
      baseCanonicalVersion: 2,
      baseSnapshot: { marker: 'original-base' },
      payload: { marker: 'keep-existing-draft' },
      attachmentRefs: [],
      stepIndex: 3,
      status: 'ACTIVE',
      createdAt: '2026-07-11T23:00:00.000Z',
      updatedAt: '2026-07-11T23:30:00.000Z',
    };
    h.db.documents.set(requestPath, {
      id: 'change-project-a',
      requestKind: 'CHANGE',
      status: 'PENDING',
      targetProjectId: 'project-a',
      proposedSnapshot: validV2Payload({
        participationSheetLink: '',
        teamMembersDetailed: [{
          personId: 'person-a',
          memberName: 'Actor A',
          laborAllocationStartMonth: '2026-07',
          monthlyRates: { '2026-07': 120 },
        }],
      }),
    });
    h.db.documents.set(draftPath, existingDraft);
    const projectBeforeOpen = clone(h.db.documents.get(projectPath));
    const requestBeforeOpen = clone(h.db.documents.get(requestPath));
    const draftBeforeOpen = clone(h.db.documents.get(draftPath));

    const opened = await openedDraft(h, 'open-existing-active-draft');

    expect(opened.body.draft).toEqual({
      projectId: 'project-a',
      resourceType: 'project-info',
      resourceId: 'project-a',
      draftRevision: 7,
      baseCanonicalVersion: 2,
      payload: { marker: 'keep-existing-draft' },
      attachmentRefs: [],
      stepIndex: 3,
      status: 'ACTIVE',
      createdAt: '2026-07-11T23:00:00.000Z',
      updatedAt: '2026-07-11T23:30:00.000Z',
    });
    expect(h.db.documents.get(projectPath)).toEqual(projectBeforeOpen);
    expect(h.db.documents.get(requestPath)).toEqual(requestBeforeOpen);
    expect(h.db.documents.get(draftPath)).toEqual(draftBeforeOpen);
    expect(h.auditChainService.appendManyInTransaction).not.toHaveBeenCalled();
  });

  it('downloads a stored edit-draft attachment only for its owner and exact document kind', async () => {
    const downloadDraftAttachment = vi.fn(async () => ({
      buffer: Buffer.from('private-edit-pdf'), contentType: 'application/pdf', size: 16,
    }));
    const h = harness({ storageService: { downloadDraftAttachment } });
    await openedDraft(h);
    const [draftPath] = [...h.db.documents.keys()].filter((path) => path.includes('/privateEditDrafts/'));
    const draft = h.db.documents.get(draftPath);
    const path = `orgs/tenant-a/project-registration-drafts/${draftPath.split('/').at(-1)}/attachment-a-contract.pdf`;
    h.db.documents.set(draftPath, {
      ...draft,
      attachmentRefs: [{
        attachmentId: 'attachment-a', documentKind: 'contract', path,
        name: 'contract.pdf', size: 16, contentType: 'application/pdf',
      }],
    });

    await expect(h.service.readAttachment({
      tenantId: 'tenant-a', actorId: 'actor-a', projectId: 'project-a', documentKind: 'contract',
    })).resolves.toMatchObject({
      buffer: Buffer.from('private-edit-pdf'), name: 'contract.pdf', contentType: 'application/pdf',
    });
    await expect(h.service.readAttachment({
      tenantId: 'tenant-a', actorId: 'actor-admin', projectId: 'project-a', documentKind: 'contract',
    })).rejects.toMatchObject({ statusCode: 404, code: 'not_found' });
    await expect(h.service.readAttachment({
      tenantId: 'tenant-a', actorId: 'actor-a', projectId: 'project-a', documentKind: 'performance_certificate',
    })).rejects.toMatchObject({ statusCode: 404, code: 'not_found' });
    await expect(h.service.readAttachment({
      tenantId: 'tenant-a', actorId: 'actor-a', projectId: 'project-a', documentKind: 'browser-controlled',
    })).rejects.toMatchObject({ statusCode: 400, code: 'draft_attachment_invalid' });
    expect(downloadDraftAttachment).toHaveBeenCalledOnce();
    expect(downloadDraftAttachment).toHaveBeenCalledWith({
      tenantId: 'tenant-a', draftId: draftPath.split('/').at(-1), path,
    });
  });

  it('previews only exact canonical or resumable-request documents when no private replacement exists', async () => {
    const downloadProjectRegistrationAttachment = vi.fn(async () => ({
      buffer: Buffer.from('stored-project-pdf'), contentType: 'application/pdf', size: 18,
    }));
    const h = harness({ storageService: {
      downloadDraftAttachment: vi.fn(),
      downloadProjectRegistrationAttachment,
    } });
    const canonicalPath = 'orgs/tenant-a/project-registration-documents/project-a/contract.pdf';
    h.db.documents.set('orgs/tenant-a/projects/project-a', {
      ...h.db.documents.get('orgs/tenant-a/projects/project-a'),
      contractDocument: { path: canonicalPath, name: 'canonical-contract.pdf' },
    });
    await openedDraft(h);

    await expect(h.service.readAttachment({
      tenantId: 'tenant-a', actorId: 'actor-a', projectId: 'project-a', documentKind: 'contract',
    })).resolves.toMatchObject({
      buffer: Buffer.from('stored-project-pdf'), name: 'canonical-contract.pdf',
    });
    expect(downloadProjectRegistrationAttachment).toHaveBeenLastCalledWith({
      tenantId: 'tenant-a', projectId: 'project-a', path: canonicalPath,
    });

    const [draftPath] = [...h.db.documents.keys()].filter((path) => path.includes('/privateEditDrafts/'));
    const draft = h.db.documents.get(draftPath);
    h.db.documents.set(draftPath, {
      ...draft,
      payload: {
        ...draft.payload,
        quoteDocument: {
          path: 'orgs/tenant-a/project-registration-documents/project-a/browser-forged.pdf',
          name: 'browser-forged.pdf',
        },
      },
    });
    await expect(h.service.readAttachment({
      tenantId: 'tenant-a', actorId: 'actor-a', projectId: 'project-a', documentKind: 'quote',
    })).rejects.toMatchObject({ statusCode: 404, code: 'not_found' });
    expect(downloadProjectRegistrationAttachment).toHaveBeenCalledTimes(1);
  });

  it('previews a server-stored pending change document without trusting browser metadata', async () => {
    const downloadProjectRegistrationAttachment = vi.fn(async () => ({
      buffer: Buffer.from('pending-rfp'), contentType: 'application/pdf', size: 11,
    }));
    const h = harness({ storageService: {
      downloadDraftAttachment: vi.fn(),
      downloadProjectRegistrationAttachment,
    } });
    const rfpPath = 'orgs/tenant-a/project-registration-documents/project-a/pending-rfp.pdf';
    h.db.documents.set('orgs/tenant-a/project_requests/change-project-a', {
      requestKind: 'CHANGE',
      status: 'PENDING',
      payload: { rfpRequestEvidenceDocument: { path: rfpPath, name: 'pending-rfp.pdf' } },
      proposedSnapshot: { rfpRequestEvidenceDocument: { path: rfpPath, name: 'pending-rfp.pdf' } },
    });
    await openedDraft(h);

    await expect(h.service.readAttachment({
      tenantId: 'tenant-a', actorId: 'actor-a', projectId: 'project-a', documentKind: 'rfp_request_evidence',
    })).resolves.toMatchObject({ buffer: Buffer.from('pending-rfp'), name: 'pending-rfp.pdf' });
    expect(downloadProjectRegistrationAttachment).toHaveBeenCalledWith({
      tenantId: 'tenant-a', projectId: 'project-a', path: rfpPath,
    });
  });

  it('previews a trusted pending-change document from private draft storage before outbox relocation', async () => {
    const downloadDraftAttachment = vi.fn(async () => ({
      buffer: Buffer.from('pending-private-rfp'), contentType: 'application/pdf', size: 19,
    }));
    const h = harness({ storageService: {
      downloadDraftAttachment,
      downloadProjectRegistrationAttachment: vi.fn(),
    } });
    await openedDraft(h);
    const [draftPath] = [...h.db.documents.keys()].filter((path) => path.includes('/privateEditDrafts/'));
    const draftId = draftPath.split('/').at(-1);
    const rfpPath = `orgs/tenant-a/project-registration-drafts/${draftId}/pending-rfp.pdf`;
    const draft = h.db.documents.get(draftPath);
    h.db.documents.set(draftPath, {
      ...draft,
      payload: {
        ...draft.payload,
        proposalDocument: null,
        rfpRequestEvidenceDocument: { path: rfpPath, name: 'pending-rfp.pdf' },
      },
    });
    h.db.documents.set('orgs/tenant-a/project_requests/change-project-a', {
      requestKind: 'CHANGE',
      status: 'PENDING',
      payload: { rfpRequestEvidenceDocument: { path: rfpPath, name: 'pending-rfp.pdf' } },
      proposedSnapshot: { rfpRequestEvidenceDocument: { path: rfpPath, name: 'pending-rfp.pdf' } },
    });

    await expect(h.service.readAttachment({
      tenantId: 'tenant-a', actorId: 'actor-a', projectId: 'project-a', documentKind: 'rfp_request_evidence',
    })).resolves.toMatchObject({ buffer: Buffer.from('pending-private-rfp'), name: 'pending-rfp.pdf' });
    expect(downloadDraftAttachment).toHaveBeenCalledWith({
      tenantId: 'tenant-a', draftId, path: rfpPath,
    });
  });

  it('temporary save changes only the private draft and rejects stale revisions', async () => {
    const h = harness();
    await openedDraft(h);
    const saved = await h.service.update({
      ...h.base,
      idempotencyKey: 'save-a',
      expectedDraftRevision: 0,
      payload: validPayload({ name: 'Private changed name' }),
      stepIndex: 2,
    });

    expect(saved.body.draft).toMatchObject({ draftRevision: 1, payload: { name: 'Private changed name' } });
    expect(h.db.documents.get('orgs/tenant-a/projects/project-a').name).toBe('Project A');
    expect(h.db.documents.has('orgs/tenant-a/project_requests/change-project-a')).toBe(false);
    await expect(h.service.update({
      ...h.base,
      idempotencyKey: 'save-stale',
      expectedDraftRevision: 0,
      payload: validPayload({ name: 'Stale' }),
    })).rejects.toMatchObject({ statusCode: 409, code: 'draft_version_conflict' });
  });

  it('submits request, metadata-only draft, canonical version, lease, audit, idempotency and outbox atomically', async () => {
    const storage = {
      uploadProjectRegistrationAttachment: vi.fn(async (input) => ({
        path: `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${input.attachmentId}-${input.fileName}`,
        name: input.fileName,
        size: input.buffer.byteLength,
        contentType: input.mimeType,
        uploadedAt: '2026-07-12T00:01:00.000Z',
      })),
      deleteProjectRegistrationAttachment: vi.fn(async () => undefined),
      inspectProjectRegistrationAttachment: vi.fn(async (input) => ({
        path: input.path,
        attachmentId: 'attachment-a',
        size: VALID_PDF.byteLength,
        contentType: 'application/pdf',
      })),
    };
    const h = harness({ storageService: storage });
    h.db.documents.set('orgs/tenant-a/projects/project-a', {
      ...h.db.documents.get('orgs/tenant-a/projects/project-a'),
      executiveReviewStatus: 'REVISION_REJECTED',
    });
    const projectBefore = clone(h.db.documents.get('orgs/tenant-a/projects/project-a'));
    await openedDraft(h);
    const uploaded = await h.service.addAttachment({
      ...h.base,
      idempotencyKey: 'upload-a',
      expectedDraftRevision: 0,
      documentKind: 'contract',
      fileName: 'submitted-contract.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    });
    await h.service.update({
      ...h.base, idempotencyKey: 'save-a', expectedDraftRevision: 1,
      payload: validV2Payload({
        name: 'Submitted name',
        contractDocument: { path: uploaded.body.attachment.path },
        browserOnlyField: 'must not persist',
      }),
      stepIndex: 4,
    });
    const submitInput = {
      ...h.base,
      idempotencyKey: 'submit-a',
      expectedDraftRevision: 2,
      expectedVersion: 3,
      resubmit: true,
      reviewComment: '보완 완료',
    };
    const submitted = await h.service.submit(submitInput);
    const replay = await h.service.submit(submitInput);

    const project = h.db.documents.get('orgs/tenant-a/projects/project-a');
    const request = h.db.documents.get('orgs/tenant-a/project_requests/change-project-a');
    const draft = [...h.db.documents.entries()].find(([path]) => path.includes('/privateEditDrafts/'))[1];
    const storedLease = h.db.documents.get(`orgs/tenant-a/editLeases/${resolveEditLeaseDocumentId('project-info', 'project-a')}`);
    expect(submitted.body).toMatchObject({
      status: 'SUBMITTED', projectId: 'project-a', projectRequestId: 'change-project-a',
      projectVersion: 3, draftRevision: 3, lease: { state: 'RELEASED', canEdit: false },
      outbox: { id: 'outbox-a', status: 'PENDING' },
    });
    expect(project).toEqual(projectBefore);
    expect(request).toMatchObject({
      requestKind: 'CHANGE', status: 'PENDING', baseProjectVersion: 3,
      targetProjectVersion: 4, requestVersion: 1, submittedOutboxId: 'outbox-a',
      beforeSnapshot: { name: 'Project A' },
      proposedSnapshot: { name: 'Submitted name' },
    });
    expect(h.db.documents.has('orgs/tenant-a/projectRequests/change-project-a')).toBe(false);
    expect(request.proposedSnapshot).not.toHaveProperty('browserOnlyField');
    expect(draft).toMatchObject({ status: 'SUBMITTED', draftRevision: 3, submittedProjectRequestId: 'change-project-a' });
    expect(draft).not.toHaveProperty('payload');
    expect(draft).not.toHaveProperty('attachmentRefs');
    expect(storedLease).toMatchObject({ state: 'RELEASED', releaseReason: 'FINAL_SUBMIT' });
    expect(h.db.documents.get('outbox/outbox-a')).toMatchObject({
      eventType: 'project.info.submitted',
      payload: { requestVersion: 1, targetProjectVersion: 4 },
    });
    expect(h.db.documents.get('outbox/outbox-a').payload).not.toHaveProperty('attachmentRefs');
    expect(h.db.documents.get('outbox/outbox-a').payload).not.toHaveProperty('draftId');
    expect(storage.inspectProjectRegistrationAttachment).toHaveBeenCalledWith({
      tenantId: 'tenant-a', projectId: 'project-a', path: uploaded.body.attachment.path,
    });
    expect([...h.db.documents.keys()].some((path) => path.includes('/idempotency_keys/'))).toBe(true);
    expect(h.auditChainService.appendManyInTransaction).toHaveBeenCalled();
    expect(replay).toEqual({ ...submitted, replayed: true });

    h.db.documents.set(
      `orgs/tenant-a/editLeases/${resolveEditLeaseDocumentId('project-info', 'project-a')}`,
      buildActiveEditLeaseDocument({
        tenantId: 'tenant-a', resourceType: 'project-info', resourceId: 'project-a',
        actorId: 'actor-a', actorDisplayName: 'Actor A', sessionId: 'session-a',
        leaseId: 'lease-a', serverNow: Date.parse('2026-07-12T00:00:00.000Z'),
      }),
    );
    const withdrawn = await h.service.withdraw({ ...h.base, idempotencyKey: 'withdraw-a' });

    expect(h.db.documents.get('orgs/tenant-a/projects/project-a')).toEqual(projectBefore);
    expect(h.db.documents.get('orgs/tenant-a/project_requests/change-project-a')).toMatchObject({ status: 'WITHDRAWN' });
    expect(withdrawn.body).toMatchObject({ withdrawn: true, canonicalVersion: 3 });
  });

  it('carries staffing and settlementSystemOther changes into the change request snapshot and review diff', async () => {
    const h = harness();
    await openedDraft(h, 'open-staffing');
    await h.service.update({
      ...h.base, idempotencyKey: 'save-staffing', expectedDraftRevision: 0,
      payload: validV2Payload({
        settlementSystem: 'OTHER',
        settlementSystemOther: '자체 정산 시트',
        staffing: {
          lead: { personId: 'person-lead', name: '김총괄', nickname: '리드' },
          pm: { personId: 'person-pm', name: '박실무', nickname: '' },
          operators: [{ personId: 'person-op', name: '이운영', nickname: '오퍼' }],
          others: [
            { role: '멘토', slot: { personId: 'person-mentor', name: '박하늘', nickname: '하늘' } },
            { role: '', slot: { personId: 'person-drop', name: '역할없음', nickname: '' } },
          ],
          settlementSupport: '도담',
        },
      }),
    });
    await h.service.submit({
      ...h.base, idempotencyKey: 'submit-staffing', expectedDraftRevision: 1, expectedVersion: 3,
    });

    const request = h.db.documents.get('orgs/tenant-a/project_requests/change-project-a');
    expect(request.proposedSnapshot.staffing).toMatchObject({
      lead: { personId: 'person-lead' },
      pm: { personId: 'person-pm' },
      operators: [{ personId: 'person-op' }],
      // 역할명이 빈 줄은 저장되지 않는다.
      others: [{ role: '멘토', slot: { personId: 'person-mentor' } }],
      settlementSupport: '도담',
    });
    expect(request.proposedSnapshot.staffing.others).toHaveLength(1);
    expect(request.proposedSnapshot.settlementSystemOther).toBe('자체 정산 시트');
    const staffingChange = (request.changedFields || []).find((change) => change.key === 'staffing');
    expect(staffingChange).toMatchObject({ label: '실제 투입인력' });
    expect(staffingChange.after).toBe('총괄 리드 / 실무 박실무 / 운영 오퍼 / 멘토 하늘 / 정산지원 도담');
  });

  it('archives a submitted request and only uploads Drive files that are missing', async () => {
    const requestPath = 'orgs/tenant-a/project_requests/change-project-a';
    const outboxPath = 'outbox/archive-a';
    const attachmentPath = 'orgs/tenant-a/project-registration-documents/project-a/contract.pdf';
    const submittedRequest = {
      id: 'change-project-a', requestKind: 'CHANGE', targetProjectId: 'project-a',
      requestVersion: 2, targetProjectVersion: 4, submittedOutboxId: 'archive-a',
      status: 'PENDING', requestedAt: '2026-09-07T09:30:00.000Z',
      requestedBy: 'actor-a', requestedByName: 'Actor A', changedFields: ['name', 'contractDocument'],
      proposedSnapshot: {
        name: 'Changed project',
        contractDocument: { path: attachmentPath, name: 'contract.pdf', contentType: 'application/pdf' },
      },
    };
    const db = createDb({
      'orgs/tenant-a/projects/project-a': {
        id: 'project-a', name: 'Project A', version: 3, evidenceDriveRootFolderId: 'project-root-a',
      },
      [requestPath]: submittedRequest,
      [outboxPath]: { status: 'PROCESSING', claimToken: 'claim-a' },
    });
    const driveService = {
      getConfig: () => ({ enabled: true }),
      ensureProjectChangeRequestFolder: vi.fn(async () => ({
        folder: {
          id: 'change-folder-a',
          webViewLink: 'https://drive.google.com/drive/folders/change-folder-a',
        },
      })),
      listFolderFiles: vi.fn(async () => [{ appProperties: { archiveFileKey: 'request-summary' } }]),
      uploadFileToFolder: vi.fn(async () => ({ id: 'file-a' })),
    };
    const storage = {
      downloadProjectRegistrationAttachment: vi.fn(async () => ({
        buffer: VALID_PDF, contentType: 'application/pdf', size: VALID_PDF.byteLength,
      })),
    };
    const handler = createProjectInfoSubmittedOutboxHandler({
      db, driveService, projectRegistrationAttachmentStorageService: storage,
      now: () => '2026-09-07T10:00:00.000Z',
    });
    const event = {
      id: 'archive-a', tenantId: 'tenant-a', claimToken: 'claim-a',
      payload: {
        projectId: 'project-a', projectRequestId: 'change-project-a',
        requestVersion: 2, targetProjectVersion: 4,
      },
    };

    await handler(event);
    await handler(event);

    expect(driveService.ensureProjectChangeRequestFolder).toHaveBeenCalledOnce();
    expect(driveService.ensureProjectChangeRequestFolder).toHaveBeenCalledWith({
      tenantId: 'tenant-a', projectId: 'project-a', projectName: 'Project A',
      projectFolderId: 'project-root-a', requestId: 'change-project-a', requestVersion: 2,
      requestedAt: '2026-09-07T09:30:00.000Z',
    });
    expect(driveService.listFolderFiles).toHaveBeenCalledOnce();
    expect(driveService.uploadFileToFolder.mock.calls.map(([input]) => input.appProperties.archiveFileKey))
      .toEqual(['request-json', 'document-contract']);
    const requestUpload = driveService.uploadFileToFolder.mock.calls[0][0];
    expect(JSON.parse(Buffer.from(requestUpload.contentBase64, 'base64').toString('utf8'))).toEqual(submittedRequest);
    expect(storage.downloadProjectRegistrationAttachment).toHaveBeenCalledWith({
      tenantId: 'tenant-a', projectId: 'project-a', path: attachmentPath,
    });
    expect(db.documents.get(requestPath)).toMatchObject({
      status: 'PENDING', proposedSnapshot: { name: 'Changed project' },
      driveArchiveFolderId: 'change-folder-a',
      driveArchiveFolderLink: 'https://drive.google.com/drive/folders/change-folder-a',
      driveArchivedAt: '2026-09-07T10:00:00.000Z',
    });
  });

  it('skips disabled or stale Drive deliveries before any external call', async () => {
    const requestPath = 'orgs/tenant-a/project_requests/change-project-a';
    const db = createDb({
      'orgs/tenant-a/projects/project-a': { id: 'project-a', name: 'Project A', version: 3 },
      [requestPath]: {
        id: 'change-project-a', requestKind: 'CHANGE', targetProjectId: 'project-a', requestVersion: 2,
        targetProjectVersion: 4, submittedOutboxId: 'archive-a',
      },
      'outbox/archive-a': { status: 'PROCESSING', claimToken: 'claim-a' },
    });
    const ensureProjectChangeRequestFolder = vi.fn();
    const event = {
      id: 'archive-a', tenantId: 'tenant-a', claimToken: 'claim-a',
      payload: {
        projectId: 'project-a', projectRequestId: 'change-project-a',
        requestVersion: 2, targetProjectVersion: 4,
      },
    };
    const disabled = createProjectInfoSubmittedOutboxHandler({
      db,
      driveService: { getConfig: () => ({ enabled: false }), ensureProjectChangeRequestFolder },
    });

    await disabled(event);
    db.documents.set(requestPath, { ...db.documents.get(requestPath), requestVersion: 3 });
    const enabled = createProjectInfoSubmittedOutboxHandler({
      db,
      driveService: { getConfig: () => ({ enabled: true }), ensureProjectChangeRequestFolder },
    });
    await enabled(event);

    expect(ensureProjectChangeRequestFolder).not.toHaveBeenCalled();
    expect(db.documents.get(requestPath)).not.toHaveProperty('driveArchiveFolderId');
  });

  it('leaves the request and outbox unchanged when Drive archival fails', async () => {
    const requestPath = 'orgs/tenant-a/project_requests/change-project-a';
    const outboxPath = 'outbox/archive-a';
    const db = createDb({
      'orgs/tenant-a/projects/project-a': { id: 'project-a', name: 'Project A', version: 3 },
      [requestPath]: {
        id: 'change-project-a', requestKind: 'CHANGE', targetProjectId: 'project-a',
        requestVersion: 2, targetProjectVersion: 4, submittedOutboxId: 'archive-a', status: 'PENDING',
        requestedAt: '2026-09-07T09:30:00.000Z', proposedSnapshot: { name: 'Changed project' },
      },
      [outboxPath]: { status: 'PROCESSING', claimToken: 'claim-a' },
    });
    const requestBefore = clone(db.documents.get(requestPath));
    const outboxBefore = clone(db.documents.get(outboxPath));
    const handler = createProjectInfoSubmittedOutboxHandler({
      db,
      driveService: {
        getConfig: () => ({ enabled: true }),
        ensureProjectChangeRequestFolder: vi.fn(async () => { throw new Error('Drive unavailable'); }),
        listFolderFiles: vi.fn(),
        uploadFileToFolder: vi.fn(),
      },
    });

    await expect(handler({
      id: 'archive-a', tenantId: 'tenant-a', claimToken: 'claim-a',
      payload: {
        projectId: 'project-a', projectRequestId: 'change-project-a',
        requestVersion: 2, targetProjectVersion: 4,
      },
    })).rejects.toThrow('Drive unavailable');
    expect(db.documents.get(requestPath)).toEqual(requestBefore);
    expect(db.documents.get(outboxPath)).toEqual(outboxBefore);
  });

  it('does not reopen organization-head review while management planning is still pending', async () => {
    const h = harness();
    h.db.documents.set('orgs/tenant-a/projects/project-a', {
      ...h.db.documents.get('orgs/tenant-a/projects/project-a'),
      executiveReviewStatus: 'APPROVED',
      managementPlanningReviewStatus: 'PENDING',
    });
    await openedDraft(h);
    await h.service.update({
      ...h.base,
      idempotencyKey: 'management-pending-save',
      expectedDraftRevision: 0,
      payload: validV2Payload({ name: 'Must not reopen review' }),
    });

    await expect(h.service.submit({
      ...h.base,
      idempotencyKey: 'management-pending-resubmit',
      expectedDraftRevision: 1,
      expectedVersion: 3,
      resubmit: true,
      reviewComment: '잘못된 재제출',
    })).rejects.toMatchObject({ statusCode: 409, code: 'invalid_resubmit_state' });
    expect(h.db.documents.get('orgs/tenant-a/projects/project-a')).toMatchObject({
      executiveReviewStatus: 'APPROVED',
      managementPlanningReviewStatus: 'PENDING',
    });
  });

  it('submits a new request without mutating a management-planning rejection', async () => {
    const h = harness();
    const projectPath = 'orgs/tenant-a/projects/project-a';
    const executiveHistory = [{
      status: 'APPROVED',
      previousStatus: 'PENDING',
      reviewedAt: '2026-07-11T00:00:00.000Z',
      reviewedById: 'head-a',
      reviewedByName: 'Head A',
      reviewComment: null,
    }];
    h.db.documents.set(projectPath, {
      ...h.db.documents.get(projectPath),
      executiveReviewStatus: 'APPROVED',
      executiveReviewHistory: executiveHistory,
      managementPlanningReviewStatus: 'REVISION_REJECTED',
      managementPlanningReviewHistory: [{
        status: 'REVISION_REJECTED',
        previousStatus: 'PENDING',
        reviewedAt: '2026-07-11T01:00:00.000Z',
        reviewedById: 'finance-a',
        reviewedByName: 'Finance A',
        reviewComment: '코드 기준을 보완해 주세요',
      }],
    });
    const projectBefore = clone(h.db.documents.get(projectPath));

    await openedDraft(h);
    await h.service.update({
      ...h.base,
      idempotencyKey: 'management-reject-save',
      expectedDraftRevision: 0,
      payload: validV2Payload({ name: 'Management resubmission' }),
    });
    await h.service.submit({
      ...h.base,
      idempotencyKey: 'management-reject-submit',
      expectedDraftRevision: 1,
      expectedVersion: 3,
      resubmit: true,
      reviewComment: '기획실 보완사항 반영',
    });

    expect(h.db.documents.get(projectPath)).toEqual(projectBefore);
    expect(h.db.documents.get('orgs/tenant-a/project_requests/change-project-a')).toMatchObject({
      status: 'PENDING',
      baseProjectVersion: 3,
      targetProjectVersion: 4,
      proposedSnapshot: { name: 'Management resubmission' },
    });
  });

  it('preserves completed-project checkout and three private evidence PDFs in the change request', async () => {
    const storage = {
      uploadProjectRegistrationAttachment: vi.fn(async (input) => ({
        path: `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${input.attachmentId}-${input.fileName}`,
        name: input.fileName,
        size: input.buffer.byteLength,
        contentType: input.mimeType,
        uploadedAt: '2026-07-12T00:01:00.000Z',
      })),
      deleteProjectRegistrationAttachment: vi.fn(async () => undefined),
    };
    const h = harness({ storageService: storage });
    await openedDraft(h);
    await expect(h.service.addAttachment({
      ...h.base,
      actorId: 'actor-admin',
      actorRole: 'admin',
      idempotencyKey: 'checkout-upload-forbidden',
      expectedDraftRevision: 0,
      documentKind: 'performance_certificate',
      fileName: 'forbidden.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    })).rejects.toMatchObject({ statusCode: 404 });
    const kinds = ['performance_certificate', 'tax_invoice', 'final_settlement_report'];
    for (const [revision, documentKind] of kinds.entries()) {
      await h.service.addAttachment({
        ...h.base,
        idempotencyKey: `checkout-upload-${documentKind}`,
        expectedDraftRevision: revision,
        documentKind,
        fileName: `${documentKind}.pdf`,
        mimeType: 'application/pdf',
        fileSize: VALID_PDF.byteLength,
        buffer: VALID_PDF,
      });
    }
    await h.service.update({
      ...h.base,
      idempotencyKey: 'checkout-save',
      expectedDraftRevision: 3,
      payload: validV2Payload({
        status: 'COMPLETED',
        checkout: {
          finalPaymentReceived: true,
          bankBalanceZero: true,
          performanceCertificateReceived: true,
          taxInvoiceEvidenceConfirmed: true,
          finalSettlementReportConfirmed: true,
          usbEvidenceSubmitted: true,
          evidenceDeletedAfterUsb: true,
        },
      }),
    });

    const submitInput = {
      ...h.base,
      idempotencyKey: 'checkout-submit',
      expectedDraftRevision: 4,
      expectedVersion: 3,
    };
    const submitted = await h.service.submit(submitInput);
    const replay = await h.service.submit(submitInput);

    const request = h.db.documents.get('orgs/tenant-a/project_requests/change-project-a');
    expect(request.proposedSnapshot).toMatchObject({
      checkout: {
        finalPaymentReceived: true,
        bankBalanceZero: true,
        performanceCertificateReceived: true,
        taxInvoiceEvidenceConfirmed: true,
        finalSettlementReportConfirmed: true,
        usbEvidenceSubmitted: true,
        evidenceDeletedAfterUsb: true,
      },
      performanceCertificateDocument: { documentKind: 'performance_certificate' },
      taxInvoiceDocument: { documentKind: 'tax_invoice' },
      finalSettlementReportDocument: { documentKind: 'final_settlement_report' },
    });
    expect(replay).toEqual({ ...submitted, replayed: true });
  });

  it('does not require settlement-only checkout evidence for a non-settlement project', async () => {
    const h = harness();
    await openedDraft(h);
    await h.service.update({
      ...h.base,
      idempotencyKey: 'non-settlement-checkout-save',
      expectedDraftRevision: 0,
      payload: validV2Payload({
        status: 'COMPLETED',
        basis: 'NONE',
        accountType: 'NONE',
        checkout: {
          finalPaymentReceived: true,
          bankBalanceZero: true,
          performanceCertificateReceived: false,
          taxInvoiceEvidenceConfirmed: false,
          finalSettlementReportConfirmed: true,
          usbEvidenceSubmitted: true,
          evidenceDeletedAfterUsb: true,
        },
      }),
    });

    await h.service.submit({
      ...h.base,
      idempotencyKey: 'non-settlement-checkout-submit',
      expectedDraftRevision: 1,
      expectedVersion: 3,
    });

    expect(h.db.documents.get('orgs/tenant-a/project_requests/change-project-a').proposedSnapshot).toMatchObject({
      basis: 'NONE',
      checkout: {
        usbEvidenceSubmitted: false,
        evidenceDeletedAfterUsb: false,
        finalSettlementReportConfirmed: false,
      },
      finalSettlementReportDocument: null,
    });
  });

  it('allows electronic performance-certificate completion when no customer PDF applies', async () => {
    const h = harness();
    await openedDraft(h);
    await h.service.update({
      ...h.base,
      idempotencyKey: 'electronic-certificate-checkout-save',
      expectedDraftRevision: 0,
      payload: validV2Payload({
        status: 'COMPLETED',
        checkout: {
          finalPaymentReceived: true,
          bankBalanceZero: true,
          performanceCertificateReceived: true,
          performanceCertificateDocumentApplicable: false,
          taxInvoiceEvidenceConfirmed: false,
          finalSettlementReportConfirmed: false,
          usbEvidenceSubmitted: false,
          evidenceDeletedAfterUsb: false,
        },
      }),
    });

    await h.service.submit({
      ...h.base,
      idempotencyKey: 'electronic-certificate-checkout-submit',
      expectedDraftRevision: 1,
      expectedVersion: 3,
    });

    expect(h.db.documents.get('orgs/tenant-a/project_requests/change-project-a').proposedSnapshot).toMatchObject({
      checkout: {
        performanceCertificateReceived: true,
        performanceCertificateDocumentApplicable: false,
      },
      performanceCertificateDocument: null,
    });
  });

  it('rejects an applicable completed-project performance certificate without the matching PDF', async () => {
    const h = harness();
    await openedDraft(h);
    await h.service.update({
      ...h.base,
      idempotencyKey: 'checkout-invalid-save',
      expectedDraftRevision: 0,
      payload: validV2Payload({
        status: 'COMPLETED',
        checkout: {
          finalPaymentReceived: true,
          bankBalanceZero: true,
          performanceCertificateReceived: true,
          performanceCertificateDocumentApplicable: true,
          taxInvoiceEvidenceConfirmed: false,
          finalSettlementReportConfirmed: false,
          usbEvidenceSubmitted: false,
          evidenceDeletedAfterUsb: false,
        },
      }),
    });

    await expect(h.service.submit({
      ...h.base,
      idempotencyKey: 'checkout-invalid-submit',
      expectedDraftRevision: 1,
      expectedVersion: 3,
    })).rejects.toMatchObject({ statusCode: 422, code: 'project_registration_invalid' });
    expect(h.db.documents.has('orgs/tenant-a/project_requests/change-project-a')).toBe(false);
  });

  it('rejects a forged completion-evidence path instead of silently deleting the canonical PDF', async () => {
    const h = harness();
    const projectPath = 'orgs/tenant-a/projects/project-a';
    const canonicalPerformanceCertificate = {
      path: 'orgs/tenant-a/project-registration-documents/project-a/performance-certificate.pdf',
      name: 'performance-certificate.pdf',
      contentType: 'application/pdf',
    };
    h.db.documents.set(projectPath, {
      ...h.db.documents.get(projectPath),
      ...validV2Payload({
        proposalDocument: {
          path: 'orgs/tenant-a/project-registration-documents/project-a/proposal.pdf',
          name: 'proposal.pdf',
          contentType: 'application/pdf',
        },
        rfpRequestEvidenceDocument: null,
        performanceCertificateDocument: canonicalPerformanceCertificate,
      }),
    });
    await openedDraft(h);
    await h.service.update({
      ...h.base,
      idempotencyKey: 'forged-checkout-save',
      expectedDraftRevision: 0,
      payload: validV2Payload({
        proposalDocument: {
          path: 'orgs/tenant-a/project-registration-documents/project-a/proposal.pdf',
          name: 'proposal.pdf',
          contentType: 'application/pdf',
        },
        rfpRequestEvidenceDocument: null,
        status: 'COMPLETED',
        checkout: {
          finalPaymentReceived: true,
          bankBalanceZero: true,
          performanceCertificateReceived: true,
          performanceCertificateDocumentApplicable: true,
          taxInvoiceEvidenceConfirmed: false,
          finalSettlementReportConfirmed: false,
          usbEvidenceSubmitted: false,
          evidenceDeletedAfterUsb: false,
        },
        performanceCertificateDocument: {
          path: 'orgs/other-tenant/project-registration-documents/other/forged-performance.pdf',
          name: 'forged-performance.pdf',
          contentType: 'application/pdf',
        },
      }),
    });

    await expect(h.service.submit({
      ...h.base,
      idempotencyKey: 'forged-checkout-submit',
      expectedDraftRevision: 1,
      expectedVersion: 3,
    })).rejects.toMatchObject({ statusCode: 422, code: 'project_registration_invalid' });
    expect(h.db.documents.get(projectPath).performanceCertificateDocument)
      .toEqual(canonicalPerformanceCertificate);
    expect(h.db.documents.has('orgs/tenant-a/project_requests/change-project-a')).toBe(false);
  });

  it('rejects a legacy-v1 project information submission instead of bypassing the seven-document contract', async () => {
    const h = harness();
    await openedDraft(h);
    await h.service.update({
      ...h.base,
      idempotencyKey: 'legacy-v1-save',
      expectedDraftRevision: 0,
      payload: validPayload({ registrationRequirementsVersion: 1 }),
    });

    await expect(h.service.submit({
      ...h.base,
      idempotencyKey: 'legacy-v1-submit',
      expectedDraftRevision: 1,
      expectedVersion: 3,
    })).rejects.toMatchObject({ statusCode: 422, code: 'project_registration_invalid' });
    expect(h.db.documents.has('orgs/tenant-a/project_requests/change-project-a')).toBe(false);
  });

  it('rejects explicit removal of a completion PDF while its confirmation remains checked', async () => {
    const h = harness();
    const projectPath = 'orgs/tenant-a/projects/project-a';
    const canonicalPerformanceCertificate = {
      path: 'orgs/tenant-a/project-registration-documents/project-a/performance-certificate.pdf',
      name: 'performance-certificate.pdf',
      contentType: 'application/pdf',
    };
    h.db.documents.set(projectPath, {
      ...h.db.documents.get(projectPath),
      ...validV2Payload({
        proposalDocument: {
          path: 'orgs/tenant-a/project-registration-documents/project-a/proposal.pdf',
        },
        rfpRequestEvidenceDocument: null,
        performanceCertificateDocument: canonicalPerformanceCertificate,
      }),
    });
    await openedDraft(h);
    await h.service.update({
      ...h.base,
      idempotencyKey: 'removed-checkout-save',
      expectedDraftRevision: 0,
      payload: validV2Payload({
        proposalDocument: {
          path: 'orgs/tenant-a/project-registration-documents/project-a/proposal.pdf',
        },
        rfpRequestEvidenceDocument: null,
        status: 'COMPLETED',
        checkout: {
          finalPaymentReceived: true,
          bankBalanceZero: true,
          performanceCertificateReceived: true,
          performanceCertificateDocumentApplicable: true,
          taxInvoiceEvidenceConfirmed: false,
          finalSettlementReportConfirmed: false,
          usbEvidenceSubmitted: false,
          evidenceDeletedAfterUsb: false,
        },
        performanceCertificateDocument: null,
      }),
    });

    await expect(h.service.submit({
      ...h.base,
      idempotencyKey: 'removed-checkout-submit',
      expectedDraftRevision: 1,
      expectedVersion: 3,
    })).rejects.toMatchObject({ statusCode: 422, code: 'project_registration_invalid' });
    expect(h.db.documents.get(projectPath).performanceCertificateDocument)
      .toEqual(canonicalPerformanceCertificate);
  });

  it('requires checkout fields when editing an already-completed project even if status is omitted', async () => {
    const h = harness();
    const projectPath = 'orgs/tenant-a/projects/project-a';
    h.db.documents.set(projectPath, {
      ...h.db.documents.get(projectPath),
      status: 'COMPLETED',
      checkout: {
        finalPaymentReceived: true,
        bankBalanceZero: true,
        performanceCertificateReceived: false,
        taxInvoiceEvidenceConfirmed: false,
        finalSettlementReportConfirmed: false,
        usbEvidenceSubmitted: false,
        evidenceDeletedAfterUsb: false,
      },
    });
    await openedDraft(h);
    const payload = validV2Payload({ name: 'Completed project rename' });
    delete payload.status;
    delete payload.checkout;
    await h.service.update({
      ...h.base,
      idempotencyKey: 'completed-omitted-checkout-save',
      expectedDraftRevision: 0,
      payload,
    });

    await expect(h.service.submit({
      ...h.base,
      idempotencyKey: 'completed-omitted-checkout-submit',
      expectedDraftRevision: 1,
      expectedVersion: 3,
    })).rejects.toMatchObject({ statusCode: 422, code: 'project_registration_invalid' });
    expect(h.db.documents.has('orgs/tenant-a/project_requests/change-project-a')).toBe(false);
  });

  it('fails closed on canonical version drift without partial writes', async () => {
    const h = harness();
    await openedDraft(h);
    await h.service.update({
      ...h.base, idempotencyKey: 'save-a', expectedDraftRevision: 0,
      payload: validPayload({ name: 'Must remain private' }),
    });
    h.db.documents.set('orgs/tenant-a/projects/project-a', {
      ...h.db.documents.get('orgs/tenant-a/projects/project-a'), version: 4,
    });

    await expect(h.service.submit({
      ...h.base, idempotencyKey: 'submit-conflict', expectedDraftRevision: 1, expectedVersion: 3,
    })).rejects.toMatchObject({ statusCode: 409, code: 'canonical_version_conflict' });
    expect(h.db.documents.has('orgs/tenant-a/project_requests/change-project-a')).toBe(false);
    expect(h.db.documents.has('outbox/outbox-a')).toBe(false);
    expect([...h.db.documents.values()].find((value) => value?.resourceType === 'project-info' && value?.ownerUid))
      .toMatchObject({ status: 'ACTIVE', payload: { name: 'Must remain private' } });
  });

  it('uploads into the permanent private project path and saves metadata only after storage succeeds', async () => {
    const storage = {
      uploadProjectRegistrationAttachment: vi.fn(async (input) => ({
        path: `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${input.attachmentId}-${input.fileName}`,
        name: input.fileName,
        size: input.buffer.byteLength,
        contentType: input.mimeType,
        uploadedAt: '2026-07-12T00:01:00.000Z',
      })),
      deleteProjectRegistrationAttachment: vi.fn(async () => undefined),
    };
    const h = harness({ storageService: storage });
    await openedDraft(h);
    const uploaded = await h.service.addAttachment({
      ...h.base,
      idempotencyKey: 'upload-a',
      expectedDraftRevision: 0,
      documentKind: 'contract',
      fileName: 'contract.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    });
    const replaced = await h.service.addAttachment({
      ...h.base,
      idempotencyKey: 'upload-b',
      expectedDraftRevision: 1,
      documentKind: 'contract',
      fileName: 'replacement.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    });

    expect(uploaded.body).toMatchObject({
      draft: { draftRevision: 1, attachmentRefs: [{ documentKind: 'contract', name: 'contract.pdf' }] },
    });
    expect(storage.uploadProjectRegistrationAttachment).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', projectId: 'project-a', draftId: expect.stringMatching(/^v1_/), actorId: 'actor-a',
    }));
    expect(replaced.body.draft.attachmentRefs).toHaveLength(1);
    expect(replaced.body.draft.attachmentRefs[0].name).toBe('replacement.pdf');
    expect(h.db.documents.get('outbox/cleanup-outbox-1')).toMatchObject({
      eventType: 'draft.attachments.cleanup',
      entityType: 'project_info_draft',
      payload: {
        draftId: expect.stringMatching(/^v1_/),
        projectId: 'project-a',
        paths: [uploaded.body.attachment.path],
      },
    });
  });

  it('clears canonical contract analysis when a private replacement is uploaded and submitted with null analysis', async () => {
    const storage = {
      uploadProjectRegistrationAttachment: vi.fn(async (input) => ({
        path: `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${input.attachmentId}-${input.fileName}`,
        name: input.fileName,
        size: input.buffer.byteLength,
        contentType: input.mimeType,
        uploadedAt: '2026-07-12T00:01:00.000Z',
      })),
      deleteProjectRegistrationAttachment: vi.fn(async () => undefined),
    };
    const h = harness({ storageService: storage });
    const projectPath = 'orgs/tenant-a/projects/project-a';
    h.db.documents.set(projectPath, {
      ...h.db.documents.get(projectPath),
      contractAnalysis: { summary: 'canonical contract A analysis' },
    });
    await openedDraft(h, 'open-contract-analysis');
    const replacement = await h.service.addAttachment({
      ...h.base,
      idempotencyKey: 'upload-contract-b',
      expectedDraftRevision: 0,
      documentKind: 'contract',
      fileName: 'contract-b.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    });

    expect(replacement.body.draft.payload.contractAnalysis).toBeNull();
    await h.service.update({
      ...h.base,
      idempotencyKey: 'save-contract-b-failed-analysis',
      expectedDraftRevision: 1,
      payload: validV2Payload({
        contractDocument: { path: replacement.body.attachment.path },
        contractAnalysis: null,
      }),
    });
    await h.service.submit({
      ...h.base,
      idempotencyKey: 'submit-contract-b-failed-analysis',
      expectedDraftRevision: 2,
      expectedVersion: 3,
    });

    const request = h.db.documents.get('orgs/tenant-a/project_requests/change-project-a');
    expect(request.proposedSnapshot.contractDocument).toMatchObject({
      documentKind: 'contract',
      path: replacement.body.attachment.path,
    });
    expect(request.proposedSnapshot.contractAnalysis).toBeNull();
    expect(request.payload.contractAnalysis).toBeNull();
  });

  it('removes a private attachment only with the owning lease fence and advances the draft revision', async () => {
    const storage = {
      uploadProjectRegistrationAttachment: vi.fn(async (input) => ({
        path: `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${input.attachmentId}-${input.fileName}`,
        name: input.fileName,
        size: input.buffer.byteLength,
        contentType: input.mimeType,
        uploadedAt: '2026-07-12T00:01:00.000Z',
      })),
      deleteProjectRegistrationAttachment: vi.fn(async () => undefined),
    };
    const h = harness({ storageService: storage });
    await openedDraft(h);
    const uploaded = await h.service.addAttachment({
      ...h.base,
      idempotencyKey: 'remove-upload',
      expectedDraftRevision: 0,
      documentKind: 'contract',
      fileName: 'contract.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    });
    await h.service.update({
      ...h.base,
      idempotencyKey: 'remove-save-path',
      expectedDraftRevision: 1,
      payload: validPayload({ contractDocument: { path: uploaded.body.attachment.path } }),
    });

    await expect(h.service.removeAttachment({
      ...h.base,
      fence: h.base.fence + 1,
      idempotencyKey: 'remove-wrong-fence',
      expectedDraftRevision: 2,
      documentKind: 'contract',
    })).rejects.toMatchObject({ statusCode: 423, code: 'edit_lease_held' });
    expect(storage.deleteProjectRegistrationAttachment).not.toHaveBeenCalled();
    expect(h.db.documents.has('outbox/cleanup-outbox-1')).toBe(false);

    const removed = await h.service.removeAttachment({
      ...h.base,
      idempotencyKey: 'remove-contract',
      expectedDraftRevision: 2,
      documentKind: 'contract',
    });

    expect(removed.body.draft).toMatchObject({
      draftRevision: 3,
      attachmentRefs: [],
      payload: { contractDocument: null },
    });
    expect(storage.deleteProjectRegistrationAttachment).toHaveBeenCalledOnce();
    expect(storage.deleteProjectRegistrationAttachment).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      draftId: expect.stringMatching(/^v1_/),
      path: uploaded.body.attachment.path,
    });
    expect(h.db.documents.get('outbox/cleanup-outbox-1')).toMatchObject({
      eventType: 'draft.attachments.cleanup',
      payload: {
        draftId: expect.stringMatching(/^v1_/),
        paths: [uploaded.body.attachment.path],
      },
    });
  });

  it('keeps proposal and RFP as independent private edit attachments', async () => {
    const storage = {
      uploadProjectRegistrationAttachment: vi.fn(async (input) => ({
        path: `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${input.attachmentId}-${input.fileName}`,
        name: input.fileName,
        size: input.buffer.byteLength,
        contentType: input.mimeType,
        uploadedAt: '2026-07-12T00:01:00.000Z',
      })),
      deleteProjectRegistrationAttachment: vi.fn(async () => undefined),
    };
    const h = harness({ storageService: storage });
    await openedDraft(h);
    const common = {
      ...h.base,
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    };
    const proposal = await h.service.addAttachment({
      ...common,
      idempotencyKey: 'alternative-proposal-upload',
      expectedDraftRevision: 0,
      documentKind: 'proposal',
      fileName: 'proposal.pdf',
    });
    const rfp = await h.service.addAttachment({
      ...common,
      idempotencyKey: 'alternative-rfp-upload',
      expectedDraftRevision: 1,
      documentKind: 'rfp_request_evidence',
      fileName: 'rfp.pdf',
    });

    expect(rfp.body.draft.attachmentRefs.map((item) => item.documentKind))
      .toEqual(['proposal', 'rfp_request_evidence']);
    expect(storage.deleteProjectRegistrationAttachment).not.toHaveBeenCalledWith(expect.objectContaining({
      path: proposal.body.attachment.path,
    }));

    await h.service.submit({
      ...h.base,
      idempotencyKey: 'alternative-submit',
      expectedDraftRevision: 2,
      expectedVersion: 3,
    });

    expect(h.db.documents.get('orgs/tenant-a/project_requests/change-project-a').proposedSnapshot)
      .toMatchObject({
        proposalDocument: { documentKind: 'proposal', name: 'proposal.pdf' },
        rfpRequestEvidenceDocument: { documentKind: 'rfp_request_evidence', name: 'rfp.pdf' },
      });
  });

  it.each([
    {
      label: 'canonical proposal with private RFP evidence',
      canonicalField: 'proposalDocument',
      canonicalKind: 'proposal',
      replacementField: 'rfpRequestEvidenceDocument',
      replacementKind: 'rfp_request_evidence',
    },
    {
      label: 'canonical RFP evidence with private proposal',
      canonicalField: 'rfpRequestEvidenceDocument',
      canonicalKind: 'rfp_request_evidence',
      replacementField: 'proposalDocument',
      replacementKind: 'proposal',
    },
  ])('submits $label while preserving the independent canonical document', async ({
    canonicalField,
    canonicalKind,
    replacementField,
    replacementKind,
  }) => {
    const storage = {
      uploadProjectRegistrationAttachment: vi.fn(async (input) => ({
        path: `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${input.attachmentId}-${input.fileName}`,
        name: input.fileName,
        size: input.buffer.byteLength,
        contentType: input.mimeType,
        uploadedAt: '2026-07-12T00:01:00.000Z',
      })),
      deleteProjectRegistrationAttachment: vi.fn(async () => undefined),
    };
    const h = harness({ storageService: storage });
    h.db.documents.set('orgs/tenant-a/projects/project-a', {
      ...h.db.documents.get('orgs/tenant-a/projects/project-a'),
      ...validV2Payload({
        proposalDocument: null,
        rfpRequestEvidenceDocument: null,
        [canonicalField]: {
          path: `orgs/tenant-a/project-registration-documents/project-a/${canonicalKind}.pdf`,
          name: `${canonicalKind}.pdf`,
          contentType: 'application/pdf',
        },
      }),
    });
    await openedDraft(h);
    await h.service.addAttachment({
      ...h.base,
      idempotencyKey: `canonical-alternative-${replacementKind}`,
      expectedDraftRevision: 0,
      documentKind: replacementKind,
      fileName: `${replacementKind}.pdf`,
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    });

    await h.service.submit({
      ...h.base,
      idempotencyKey: `canonical-alternative-submit-${replacementKind}`,
      expectedDraftRevision: 1,
      expectedVersion: 3,
    });

    const proposed = h.db.documents.get('orgs/tenant-a/project_requests/change-project-a').proposedSnapshot;
    expect(proposed[canonicalField]).toMatchObject({ path: expect.stringContaining(`/${canonicalKind}.pdf`) });
    expect(proposed[replacementField]).toMatchObject({ documentKind: replacementKind });
  });

  it('rejects client-forged document paths when no validated private attachment exists', async () => {
    const h = harness();
    h.db.documents.set('orgs/tenant-a/projects/project-a', {
      ...h.db.documents.get('orgs/tenant-a/projects/project-a'),
      ...validV2Payload({
        proposalDocument: {
          path: 'orgs/tenant-a/project-registration-documents/project-a/proposal.pdf',
        },
        rfpRequestEvidenceDocument: null,
      }),
    });
    await openedDraft(h);
    await h.service.update({
      ...h.base,
      idempotencyKey: 'forged-document-save',
      expectedDraftRevision: 0,
      payload: validV2Payload({
        contractDocument: { path: 'orgs/other-tenant/project-registration-documents/other/contract.pdf' },
        customerBusinessRegistrationDocument: { path: 'missing-customer.pdf' },
        quoteDocument: { path: 'missing-quote.pdf' },
        proposalDocument: null,
        rfpRequestEvidenceDocument: { path: 'missing-rfp.pdf' },
      }),
    });

    await expect(h.service.submit({
      ...h.base,
      idempotencyKey: 'forged-document-submit',
      expectedDraftRevision: 1,
      expectedVersion: 3,
    })).rejects.toMatchObject({ statusCode: 422, code: 'project_registration_invalid' });
    expect(h.db.documents.has('orgs/tenant-a/project_requests/change-project-a')).toBe(false);
  });

  it.each([
    { requestStatus: 'PENDING', projectReviewStatus: 'APPROVED', resubmit: false },
    { requestStatus: 'REJECTED', projectReviewStatus: 'REVISION_REJECTED', resubmit: true },
  ])('preserves server-stored replacement documents when reopening a $requestStatus change', async ({
    requestStatus,
    projectReviewStatus,
    resubmit,
  }) => {
    const h = harness();
    const projectPath = 'orgs/tenant-a/projects/project-a';
    const requestPath = 'orgs/tenant-a/project_requests/change-project-a';
    const proposedRfp = {
      path: 'orgs/tenant-a/project-registration-documents/project-a/replacement-rfp.pdf',
      name: 'replacement-rfp.pdf',
      contentType: 'application/pdf',
      visibility: 'PRIVATE',
    };
    const canonical = validV2Payload({
      proposalDocument: {
        path: 'orgs/tenant-a/project-registration-documents/project-a/proposal.pdf',
      },
      rfpRequestEvidenceDocument: null,
    });
    const previousPayload = validV2Payload({
      proposalDocument: null,
      rfpRequestEvidenceDocument: proposedRfp,
    });
    h.db.documents.set(projectPath, {
      ...h.db.documents.get(projectPath),
      ...canonical,
      executiveReviewStatus: projectReviewStatus,
      managementPlanningReviewStatus: 'AGREED',
      projectCode: 'AXR-2026-001',
    });
    h.db.documents.set(requestPath, {
      id: 'change-project-a',
      requestKind: 'CHANGE',
      status: requestStatus,
      requestVersion: 1,
      targetProjectId: 'project-a',
      targetProjectVersion: 4,
      payload: previousPayload,
      proposedSnapshot: previousPayload,
    });

    const opened = await openedDraft(h);
    expect(opened.body.draft.payload).toMatchObject({
      proposalDocument: null,
      rfpRequestEvidenceDocument: proposedRfp,
    });

    await h.service.submit({
      ...h.base,
      idempotencyKey: `stored-replacement-submit-${requestStatus.toLowerCase()}`,
      expectedDraftRevision: 0,
      expectedVersion: 3,
      resubmit,
      ...(resubmit ? { reviewComment: '문서 보완 완료' } : {}),
    });

    expect(h.db.documents.get(requestPath).proposedSnapshot).toMatchObject({
      proposalDocument: null,
      rfpRequestEvidenceDocument: proposedRfp,
    });
    expect(h.db.documents.get(projectPath)).toMatchObject({
      executiveReviewStatus: projectReviewStatus,
      managementPlanningReviewStatus: 'AGREED',
      projectCode: 'AXR-2026-001',
    });
  });

  it('maps a new original-document kind into the canonical change request field', async () => {
    const storage = {
      uploadProjectRegistrationAttachment: vi.fn(async (input) => ({
        path: `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${input.attachmentId}-${input.fileName}`,
        name: input.fileName,
        size: input.buffer.byteLength,
        contentType: input.mimeType,
        uploadedAt: '2026-07-12T00:01:00.000Z',
      })),
      deleteProjectRegistrationAttachment: vi.fn(async () => undefined),
    };
    const h = harness({ storageService: storage });
    await openedDraft(h);
    const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
    await h.service.addAttachment({
      ...h.base,
      idempotencyKey: 'proposal-word-upload',
      expectedDraftRevision: 0,
      documentKind: 'proposal_word_original',
      fileName: 'proposal.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileSize: docx.byteLength,
      buffer: docx,
    });
    await h.service.submit({
      ...h.base,
      idempotencyKey: 'proposal-word-submit',
      expectedDraftRevision: 1,
      expectedVersion: 3,
    });

    expect(h.db.documents.get('orgs/tenant-a/project_requests/change-project-a').proposedSnapshot)
      .toMatchObject({ proposalWordOriginalDocument: { documentKind: 'proposal_word_original' } });
  });

  it('allows a same-kind replacement when the private attachment list is at its limit', async () => {
    const storage = {
      uploadProjectRegistrationAttachment: vi.fn(async (input) => ({
        path: `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${input.attachmentId}-${input.fileName}`,
        name: input.fileName,
        size: input.buffer.byteLength,
        contentType: input.mimeType,
        uploadedAt: '2026-07-12T00:01:00.000Z',
      })),
      deleteProjectRegistrationAttachment: vi.fn(async () => undefined),
    };
    const h = harness({ storageService: storage });
    await openedDraft(h);
    const [draftPath] = [...h.db.documents.keys()].filter((path) => path.includes('/privateEditDrafts/'));
    const draft = h.db.documents.get(draftPath);
    h.db.documents.set(draftPath, {
      ...draft,
      attachmentRefs: [
        { attachmentId: 'old-contract', documentKind: 'contract', path: 'private/old-contract.pdf' },
        ...Array.from({ length: 99 }, (_, index) => ({
          attachmentId: `proposal-${index}`,
          documentKind: 'proposal',
          path: `private/proposal-${index}.pdf`,
        })),
      ],
    });

    const replaced = await h.service.addAttachment({
      ...h.base,
      idempotencyKey: 'upload-at-limit',
      expectedDraftRevision: 0,
      documentKind: 'contract',
      fileName: 'replacement.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    });

    expect(replaced.body.draft.attachmentRefs).toHaveLength(100);
    expect(replaced.body.draft.attachmentRefs.filter((item) => item.documentKind === 'contract'))
      .toEqual([expect.objectContaining({ name: 'replacement.pdf' })]);
  });

  it('rejects non-PDF MIME types and fake PDF content before private storage', async () => {
    const storage = {
      uploadProjectRegistrationAttachment: vi.fn(),
      deleteProjectRegistrationAttachment: vi.fn(),
    };
    const h = harness({ storageService: storage });
    await openedDraft(h);
    const attachment = {
      ...h.base,
      expectedDraftRevision: 0,
      documentKind: 'contract',
      fileName: 'contract.pdf',
    };

    await expect(h.service.addAttachment({
      ...attachment,
      idempotencyKey: 'upload-invalid-mime',
      mimeType: 'text/plain',
      fileSize: VALID_PDF.byteLength,
      buffer: VALID_PDF,
    })).rejects.toMatchObject({ statusCode: 422, code: 'draft_attachment_invalid' });
    const fakePdf = Buffer.from('not-a-pdf');
    await expect(h.service.addAttachment({
      ...attachment,
      idempotencyKey: 'upload-invalid-magic',
      mimeType: 'application/pdf',
      fileSize: fakePdf.byteLength,
      buffer: fakePdf,
    })).rejects.toMatchObject({ statusCode: 422, code: 'draft_attachment_invalid' });
    expect(storage.uploadProjectRegistrationAttachment).not.toHaveBeenCalled();
  });

  it('serves an owner edit-draft attachment as private no-store bytes', async () => {
    const service = {
      readAttachment: vi.fn(async () => ({
        buffer: Buffer.from('private-edit-pdf'), contentType: 'application/pdf', size: 16,
        name: 'contract\"\r\nX-Test: injected.pdf',
      })),
    };
    const app = express();
    app.use((req, _res, next) => {
      req.context = {
        tenantId: 'tenant-a', actorId: 'actor-a', actorRole: 'pm', actorName: 'Actor A', requestId: 'request-a',
      };
      next();
    });
    mountProjectInfoDraftRoutes(app, { enabled: true, projectInfoDraftService: service });
    app.use((error, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app)
      .get('/api/v1/project-info-drafts/project-a/attachments/contract')
      .expect(200);

    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toContain('%22%0D%0AX-Test%3A%20injected.pdf');
    expect(response.headers['x-test']).toBeUndefined();
    expect(response.body).toEqual(Buffer.from('private-edit-pdf'));
    expect(service.readAttachment).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', actorId: 'actor-a', projectId: 'project-a', documentKind: 'contract',
    }));
  });

  it('passes the typed attachment kind, revision, and lease fence to DELETE', async () => {
    const service = {
      removeAttachment: vi.fn(async () => ({
        status: 200,
        replayed: false,
        body: { draft: { projectId: 'project-a', draftRevision: 3 } },
      })),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.context = {
        tenantId: 'tenant-a', actorId: 'actor-a', actorRole: 'pm', actorName: 'Actor A',
        requestId: 'request-a', idempotencyKey: req.header('idempotency-key') || undefined,
      };
      next();
    });
    mountProjectInfoDraftRoutes(app, { enabled: true, projectInfoDraftService: service });
    app.use((error, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    await request(app)
      .delete('/api/v1/project-info-drafts/project-a/attachments/tax_invoice')
      .set({
        'idempotency-key': 'info-remove-route',
        'x-edit-session-id': 'session-a',
        'x-edit-lease-id': 'lease-a',
        'x-edit-fence': '4',
      })
      .send({ expectedDraftRevision: 2 })
      .expect(200);

    expect(service.removeAttachment).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      actorId: 'actor-a',
      projectId: 'project-a',
      sessionId: 'session-a',
      leaseId: 'lease-a',
      fence: 4,
      expectedDraftRevision: 2,
      documentKind: 'tax_invoice',
    }));
  });
  it('issues a signed upload URL and accepts a storagePath attachment through the same contract', async () => {
    const readIncomingUpload = vi.fn(async () => ({ buffer: VALID_PDF }));
    const deleteIncomingUpload = vi.fn(async () => undefined);
    const storageService = {
      uploadProjectRegistrationAttachment: vi.fn(async (input) => ({
        path: `orgs/${input.tenantId}/project-registration-documents/${input.projectId}/${input.attachmentId}-${input.fileName}`,
        name: input.fileName,
        size: input.buffer.byteLength,
        contentType: input.mimeType,
        uploadedAt: '2026-07-12T00:01:00.000Z',
      })),
      deleteProjectRegistrationAttachment: vi.fn(async () => undefined),
      createIncomingUploadUrl: vi.fn(async (input) => ({
        uploadUrl: 'https://storage.example/signed-put',
        path: `orgs/${input.tenantId}/project-registration-drafts/${input.draftId}/incoming/uuid-${input.fileName}`,
        expiresAt: '2026-07-12T00:10:00.000Z',
      })),
      readIncomingUpload,
      deleteIncomingUpload,
    };
    const h = harness({ storageService });
    await openedDraft(h, 'open-direct');

    const issued = await h.service.issueAttachmentUploadUrl({
      ...h.base,
      idempotencyKey: 'upload-url-direct',
      documentKind: 'contract',
      fileName: 'big-contract.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
    });
    expect(issued.status).toBe(200);
    expect(issued.body.uploadUrl).toBe('https://storage.example/signed-put');
    const { storagePath } = issued.body;
    expect(storagePath).toContain('/incoming/');

    const uploaded = await h.service.addAttachment({
      ...h.base,
      idempotencyKey: 'upload-direct',
      expectedDraftRevision: 0,
      documentKind: 'contract',
      fileName: 'big-contract.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      storagePath,
    });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.attachment.size).toBe(VALID_PDF.byteLength);
    expect(readIncomingUpload).toHaveBeenCalledWith(expect.objectContaining({ path: storagePath }));
    expect(deleteIncomingUpload).toHaveBeenCalledWith(expect.objectContaining({ path: storagePath }));
  });

  it('rejects a storagePath attachment when the direct upload cannot be found', async () => {
    const storageService = {
      uploadProjectRegistrationAttachment: vi.fn(async () => { throw new Error('unexpected'); }),
      deleteProjectRegistrationAttachment: vi.fn(async () => undefined),
      readIncomingUpload: vi.fn(async () => { throw new Error('missing'); }),
    };
    const h = harness({ storageService });
    await openedDraft(h, 'open-direct-missing');
    await expect(h.service.addAttachment({
      ...h.base,
      idempotencyKey: 'upload-direct-missing',
      expectedDraftRevision: 0,
      documentKind: 'contract',
      fileName: 'big-contract.pdf',
      mimeType: 'application/pdf',
      fileSize: VALID_PDF.byteLength,
      storagePath: 'orgs/tenant-a/project-registration-drafts/x/incoming/uuid-big-contract.pdf',
    })).rejects.toMatchObject({ code: 'draft_attachment_incoming_missing' });
  });

  it('withdraws a pending registration request back into an active registration draft', async () => {
    const h = harness();
    await openedDraft(h, 'open-withdraw-reg');
    h.db.documents.set('orgs/tenant-a/project_requests/pr-registration-1', {
      id: 'pr-registration-1',
      tenantId: 'tenant-a',
      requestKind: 'REGISTRATION',
      status: 'PENDING',
      requestedBy: 'actor-a',
      approvedProjectId: 'project-a',
      sourceDraftId: 'registration-draft-1',
      payload: { name: '회수 대상 등록', registrationRequirementsVersion: 2 },
    });
    h.db.documents.set('orgs/tenant-a/projectRequestDrafts/registration-draft-1', {
      ownerUid: 'actor-a', ownerId: 'actor-a', tenantId: 'tenant-a',
      resourceType: 'project-registration', resourceId: 'registration-draft-1',
      draftRevision: 8, status: 'SUBMITTED',
      submittedAt: '2026-08-26T02:00:00.000Z',
      submittedProjectId: 'project-a',
      submittedProjectRequestId: 'pr-registration-1',
      submittedOutboxId: 'outbox-registration-1',
      createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-26T02:00:00.000Z',
    });
    h.db.documents.set('outbox/outbox-registration-1', {
      id: 'outbox-registration-1', status: 'DONE',
      payload: {
        attachmentRefs: [{
          documentKind: 'contract',
          path: 'orgs/tenant-a/project-registration-drafts/registration-draft-1/a-contract.pdf',
          name: 'contract.pdf', size: 9, contentType: 'application/pdf',
        }],
      },
    });

    const withdrawn = await h.service.withdraw({ ...h.base, idempotencyKey: 'withdraw-reg' });
    expect(withdrawn.body).toEqual({
      withdrawn: true, kind: 'REGISTRATION', registrationDraftId: 'registration-draft-1',
    });
    expect(h.db.documents.get('orgs/tenant-a/project_requests/pr-registration-1')).toMatchObject({
      status: 'WITHDRAWN', withdrawnBy: 'actor-a',
    });
    expect(h.db.documents.get('orgs/tenant-a/projects/project-a')).toMatchObject({
      executiveReviewStatus: 'DUPLICATE_DISCARDED',
    });
    const restored = h.db.documents.get('orgs/tenant-a/projectRequestDrafts/registration-draft-1');
    expect(restored).toMatchObject({
      status: 'ACTIVE', draftRevision: 9,
      payload: { name: '회수 대상 등록' },
      submittedProjectId: null, submittedProjectRequestId: null, submittedOutboxId: null,
    });
    expect(restored.attachmentRefs).toHaveLength(1);
    expect(restored.attachmentRefs[0].path).toContain('/project-registration-drafts/registration-draft-1/');
  });

  it('still rejects withdraw when nothing is pending for the project', async () => {
    const h = harness();
    await openedDraft(h, 'open-withdraw-none');
    await expect(h.service.withdraw({ ...h.base, idempotencyKey: 'withdraw-none' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'request_not_withdrawable' });
  });
});
