import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { mountProjectRoutes } from './projects.mjs';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createDb(seed = {}) {
  const documents = new Map(Object.entries(seed).map(([path, value]) => [path, clone(value)]));
  const snapshot = (path) => {
    const exists = documents.has(path);
    return { exists, id: path.split('/').at(-1), data: () => (exists ? clone(documents.get(path)) : undefined) };
  };
  const doc = (path) => ({
    path,
    get: async () => snapshot(path),
    set: async (value, options = {}) => {
      const current = documents.get(path);
      documents.set(path, options.merge && current ? { ...current, ...clone(value) } : clone(value));
    },
  });
  const querySnapshot = (path, filters = []) => {
    const prefix = `${path}/`;
    const docs = [...documents.entries()].flatMap(([documentPath, value]) => {
      const relativePath = documentPath.startsWith(prefix) ? documentPath.slice(prefix.length) : '';
      if (!relativePath || relativePath.includes('/')) return [];
      if (filters.some(({ field, expected }) => value?.[field] !== expected)) return [];
      return [{ id: relativePath, ref: doc(documentPath), data: () => clone(value) }];
    });
    return { docs, empty: docs.length === 0, size: docs.length };
  };
  const collection = (path) => {
    const query = (filters = []) => ({
      path,
      kind: 'query',
      filters,
      get: async () => querySnapshot(path, filters),
      where: (field, operator, expected) => {
        if (operator !== '==') throw new Error(`unsupported query operator: ${operator}`);
        return query([...filters, { field, expected }]);
      },
    });
    return query();
  };

  return {
    documents,
    doc,
    collection,
    async runTransaction(callback) {
      const writes = [];
      const tx = {
        get: async (ref) => ref.kind === 'query' ? querySnapshot(ref.path, ref.filters) : snapshot(ref.path),
        set: (ref, value, options = {}) => writes.push({ ref, value: clone(value), options }),
      };
      const result = await callback(tx);
      for (const write of writes) {
        const current = documents.get(write.ref.path);
        documents.set(
          write.ref.path,
          write.options.merge && current ? { ...current, ...write.value } : write.value,
        );
      }
      return result;
    },
    batch() {
      const writes = [];
      return {
        set: (ref, value, options = {}) => writes.push({ kind: 'set', ref, value: clone(value), options }),
        delete: (ref) => writes.push({ kind: 'delete', ref }),
        commit: async () => {
          for (const write of writes) {
            if (write.kind === 'delete') {
              documents.delete(write.ref.path);
              continue;
            }
            const current = documents.get(write.ref.path);
            documents.set(
              write.ref.path,
              write.options.merge && current ? { ...current, ...write.value } : write.value,
            );
          }
        },
      };
    },
  };
}

function createRouteApp({ actorRole = 'finance', memberStatus = 'ACTIVE', seed = {}, projectRegistrationSlackService } = {}) {
  const db = createDb({
    'orgs/tenant-a/members/finance-a': {
      uid: 'finance-a', role: actorRole, status: memberStatus,
    },
    ...seed,
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.context = {
      tenantId: 'tenant-a',
      actorId: 'finance-a',
      actorEmail: 'finance-a@example.com',
      actorRole,
      idempotencyKey: req.get('idempotency-key') || 'management-planning-test',
      requestId: 'http-request-a',
    };
    next();
  });
  mountProjectRoutes(app, {
    db,
    now: () => '2026-07-15T01:00:00.000Z',
    idempotencyService: {
      begin: vi.fn(async () => ({ mode: 'acquired', requestFingerprint: 'fingerprint-a' })),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    },
    projectRegistrationSlackService,
  });
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ error: error.code || 'internal_error', message: error.message });
  });
  return { app, db };
}

function approvedProject(overrides = {}) {
  return {
    id: 'project-a',
    tenantId: 'tenant-a',
    version: 4,
    createdBy: 'pm-a',
    createdAt: '2026-07-01T00:00:00.000Z',
    executiveReviewStatus: 'APPROVED',
    executiveReviewedAt: '2026-07-10T00:00:00.000Z',
    executiveReviewedById: 'executive-a',
    executiveReviewedByName: '조직장A',
    executiveReviewComment: '조직장 승인',
    executiveReviewHistory: [{
      status: 'APPROVED',
      previousStatus: 'PENDING',
      reviewedAt: '2026-07-10T00:00:00.000Z',
      reviewedById: 'executive-a',
      reviewedByName: '조직장A',
      reviewComment: '조직장 승인',
    }],
    managementPlanningReviewStatus: 'PENDING',
    ...overrides,
  };
}

function approvedRequest(overrides = {}) {
  return {
    id: 'request-a',
    approvedProjectId: 'project-a',
    targetProjectId: 'project-a',
    requestKind: 'REGISTRATION',
    status: 'APPROVED',
    reviewOutcome: 'APPROVED',
    payload: { name: '프로젝트 A' },
    requestedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function reviewSeed(project = approvedProject(), projectRequest = approvedRequest()) {
  return {
    'orgs/tenant-a/projects/project-a': project,
    'orgs/tenant-a/project_requests/request-a': projectRequest,
  };
}

describe('management planning project review route', () => {
  it('agrees after executive approval, normalizes and atomically claims the project code', async () => {
    const projectRegistrationSlackService = { enabled: true, notifyMessage: vi.fn(async () => {}) };
    const { app, db } = createRouteApp({ seed: reviewSeed(), projectRegistrationSlackService });

    const response = await request(app)
      .post('/api/v1/projects/project-a/management-planning-review')
      .set('idempotency-key', 'planning-agree-a')
      .send({
        requestId: 'request-a',
        reviewStatus: 'AGREED',
        projectCode: '  axr-2026-001  ',
        reviewComment: '코드 부여 완료',
        reviewerName: '조작된 경영기획실 이름',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      projectId: 'project-a',
      requestId: 'request-a',
      reviewStatus: 'AGREED',
      projectCode: 'AXR-2026-001',
      slackDelivered: true,
    });
    expect(db.documents.get('orgs/tenant-a/projects/project-a')).toMatchObject({
      executiveReviewStatus: 'APPROVED',
      executiveReviewedByName: '조직장A',
      projectCode: 'AXR-2026-001',
      projectCodeKey: 'AXR-2026-001',
      managementPlanningReviewStatus: 'AGREED',
      managementPlanningReviewedByName: 'finance-a@example.com',
      managementPlanningReviewHistory: [expect.objectContaining({
        status: 'AGREED',
        projectCode: 'AXR-2026-001',
        reviewedByName: 'finance-a@example.com',
      })],
    });
    expect(db.documents.get('orgs/tenant-a/project_requests/request-a')).toMatchObject({
      status: 'APPROVED',
      reviewOutcome: 'APPROVED',
      reviewedBy: 'finance-a',
      reviewedByName: 'finance-a@example.com',
      rejectedReason: null,
    });
    expect(db.documents.get('orgs/tenant-a/projectCodeClaims/AXR-2026-001')).toMatchObject({
      projectId: 'project-a',
      projectCode: 'AXR-2026-001',
      projectCodeKey: 'AXR-2026-001',
    });
    expect(projectRegistrationSlackService.notifyMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('프로젝트 코드 등록 완료: AXR-2026-001'),
    }));
  });

  it('requires executive approval of the pending modern change before management planning agreement', async () => {
    const executiveHistory = [{
      status: 'APPROVED',
      previousStatus: 'PENDING',
      reviewedAt: '2026-07-10T00:00:00.000Z',
      reviewedById: 'executive-a',
      reviewedByName: '조직장A',
      reviewComment: '조직장 승인',
    }];
    const notifyMessage = vi.fn();
    const { app, db } = createRouteApp({
      projectRegistrationSlackService: { enabled: true, notifyMessage },
      seed: reviewSeed(
        approvedProject({
          name: '보완 전 프로젝트 A',
          registrationRequirementsVersion: 2,
          managementPlanningReviewStatus: 'REVISION_REJECTED',
          executiveReviewHistory: executiveHistory,
        }),
        approvedRequest({
          requestKind: 'CHANGE',
          status: 'PENDING',
          reviewOutcome: null,
          rejectedReason: null,
          baseProjectVersion: 3,
          targetProjectVersion: 4,
          proposedSnapshot: {
            name: '보완 후 프로젝트 A',
            registrationRequirementsVersion: 2,
            settlementType: 'NONE',
            financialYears: [],
          },
        }),
      ),
    });

    const before = clone([...db.documents]);
    const response = await request(app)
      .post('/api/v1/projects/project-a/management-planning-review')
      .set('idempotency-key', 'planning-resubmitted-agree')
      .send({
        requestId: 'request-a',
        reviewStatus: 'AGREED',
        projectCode: 'AXR-2026-002',
        reviewComment: '보완 확인',
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('executive_review_required');
    expect([...db.documents]).toEqual(before);
    expect([...db.documents.keys()].some(path => path.includes('/projectCodeClaims/'))).toBe(false);
    expect(notifyMessage).not.toHaveBeenCalled();
  });

  it('accepts a legacy approved request as organization-head approval for code issuance', async () => {
    const { app, db } = createRouteApp({
      seed: reviewSeed(
        approvedProject({
          executiveReviewStatus: undefined,
          executiveReviewedAt: undefined,
          executiveReviewedById: undefined,
          executiveReviewedByName: undefined,
        }),
        approvedRequest({ status: 'APPROVED', reviewOutcome: 'APPROVED' }),
      ),
    });

    const response = await request(app)
      .post('/api/v1/projects/project-a/management-planning-review')
      .set('idempotency-key', 'planning-legacy-approved')
      .send({
        requestId: 'request-a',
        reviewStatus: 'AGREED',
        projectCode: 'AXR-2026-LEGACY',
      });

    expect(response.status).toBe(200);
    expect(db.documents.get('orgs/tenant-a/projects/project-a')).toMatchObject({
      managementPlanningReviewStatus: 'AGREED',
      projectCode: 'AXR-2026-LEGACY',
    });
  });

  it('returns a management-planning rejection to the PM without changing the executive approval', async () => {
    const { app, db } = createRouteApp({ seed: reviewSeed() });

    const response = await request(app)
      .post('/api/v1/projects/project-a/management-planning-review')
      .set('idempotency-key', 'planning-reject-a')
      .send({
        requestId: 'request-a',
        reviewStatus: 'REVISION_REJECTED',
        reviewComment: '프로젝트 코드 기준을 보완해 주세요.',
        reviewerName: '경영기획실A',
      });

    expect(response.status).toBe(200);
    expect(db.documents.get('orgs/tenant-a/projects/project-a')).toMatchObject({
      executiveReviewStatus: 'APPROVED',
      executiveReviewedByName: '조직장A',
      executiveReviewHistory: [expect.objectContaining({ status: 'APPROVED', reviewedByName: '조직장A' })],
      managementPlanningReviewStatus: 'REVISION_REJECTED',
      managementPlanningReviewComment: '프로젝트 코드 기준을 보완해 주세요.',
      managementPlanningReviewHistory: [expect.objectContaining({ status: 'REVISION_REJECTED' })],
    });
    expect(db.documents.get('orgs/tenant-a/project_requests/request-a')).toMatchObject({
      status: 'PENDING',
      reviewOutcome: null,
      rejectedReason: '프로젝트 코드 기준을 보완해 주세요.',
      reviewComment: '프로젝트 코드 기준을 보완해 주세요.',
    });
  });

  it('rejects management-planning review before the organization head approves', async () => {
    const { app, db } = createRouteApp({
      seed: reviewSeed(
        approvedProject({ executiveReviewStatus: 'PENDING' }),
        approvedRequest({ status: 'PENDING', reviewOutcome: null }),
      ),
    });

    const response = await request(app)
      .post('/api/v1/projects/project-a/management-planning-review')
      .set('idempotency-key', 'planning-before-executive')
      .send({ requestId: 'request-a', reviewStatus: 'AGREED', projectCode: 'AXR-2026-001' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('executive_review_required');
    expect(db.documents.get('orgs/tenant-a/projectCodeClaims/AXR-2026-001')).toBeUndefined();
  });

  it('rejects a project code already claimed by another project', async () => {
    const { app, db } = createRouteApp({
      seed: {
        ...reviewSeed(),
        'orgs/tenant-a/projectCodeClaims/AXR-2026-001': {
          tenantId: 'tenant-a', projectId: 'project-other', projectCode: 'AXR-2026-001', projectCodeKey: 'AXR-2026-001',
        },
      },
    });

    const response = await request(app)
      .post('/api/v1/projects/project-a/management-planning-review')
      .set('idempotency-key', 'planning-duplicate-code')
      .send({ requestId: 'request-a', reviewStatus: 'AGREED', projectCode: 'AXR-2026-001' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('project_code_conflict');
    expect(db.documents.get('orgs/tenant-a/projects/project-a')?.managementPlanningReviewStatus).toBe('PENDING');
  });

  it('rejects a code already stored on a legacy project even when no claim document exists', async () => {
    const { app, db } = createRouteApp({
      seed: {
        ...reviewSeed(),
        'orgs/tenant-a/projects/project-legacy': approvedProject({
          id: 'project-legacy',
          projectCode: ' axr-2026-legacy ',
          projectCodeKey: undefined,
          managementPlanningReviewStatus: 'AGREED',
        }),
      },
    });

    const response = await request(app)
      .post('/api/v1/projects/project-a/management-planning-review')
      .set('idempotency-key', 'planning-legacy-duplicate-code')
      .send({ requestId: 'request-a', reviewStatus: 'AGREED', projectCode: 'AXR-2026-LEGACY' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('project_code_conflict');
    expect(db.documents.get('orgs/tenant-a/projectCodeClaims/AXR-2026-LEGACY')).toBeUndefined();
    expect(db.documents.get('orgs/tenant-a/projects/project-a')?.managementPlanningReviewStatus).toBe('PENDING');
  });

  it('allows only admin or finance to decide management-planning review', async () => {
    const { app, db } = createRouteApp({ actorRole: 'pm', seed: reviewSeed() });

    const response = await request(app)
      .post('/api/v1/projects/project-a/management-planning-review')
      .set('idempotency-key', 'planning-pm-denied')
      .send({ requestId: 'request-a', reviewStatus: 'AGREED', projectCode: 'AXR-2026-001' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
    expect(db.documents.get('orgs/tenant-a/projects/project-a')?.managementPlanningReviewStatus).toBe('PENDING');
  });

  it('rejects management-planning review from an inactive member', async () => {
    const { app, db } = createRouteApp({ memberStatus: 'INACTIVE', seed: reviewSeed() });

    const response = await request(app)
      .post('/api/v1/projects/project-a/management-planning-review')
      .set('idempotency-key', 'planning-inactive-denied')
      .send({ requestId: 'request-a', reviewStatus: 'AGREED', projectCode: 'AXR-2026-001' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
    expect(db.documents.get('orgs/tenant-a/projects/project-a')?.managementPlanningReviewStatus).toBe('PENDING');
  });
});
