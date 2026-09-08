import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createServer } from 'node:http';
import ExcelJS from 'exceljs';
import { createBffApp } from './app.mjs';
import { createFirestoreDb } from './firestore.mjs';
import { CASHFLOW_ALL_LINES } from './cashflow-policy.mjs';

const describeIfEmulator = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

describeIfEmulator('BFF integration (Firestore emulator)', () => {
  const projectId = 'demo-bff-it';
  const tenantId = 'mysc';
  const actorId = 'u001';
  const workerSecret = 'it-worker-secret';
  const defaultHeaders = {
    'x-tenant-id': tenantId,
    'x-actor-id': actorId,
    'x-actor-role': 'admin',
  };

  const db = createFirestoreDb({ projectId });
  const app = createBffApp({ projectId, workerSecret });
  let api: ReturnType<typeof request>;
  const servers: ReturnType<typeof createServer>[] = [];
  async function createApi(application: ReturnType<typeof createBffApp>) {
    const server = createServer(application);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return request(server);
  }

  function parseBinaryResponse(res: any, callback: (err: Error | null, body?: Buffer) => void) {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    res.on('end', () => callback(null, Buffer.concat(chunks)));
    res.on('error', callback);
  }

  async function downloadCashflowExport(body: Record<string, unknown>) {
    return api
      .post('/api/v1/cashflow-exports')
      .set({
        ...defaultHeaders,
        'idempotency-key': `idem-cashflow-export-${Math.random().toString(16).slice(2)}`,
      })
      .buffer(true)
      .parse(parseBinaryResponse)
      .send(body);
  }

  async function readWorkbook(buffer: Buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    return workbook;
  }

  async function seedCashflowExportMirror({
    targetProjectId,
    projectionAmount = 0,
    actualAmount = 0,
    projectionBalance = projectionAmount,
    actualBalance = actualAmount,
  }: {
    targetProjectId: string;
    projectionAmount?: number;
    actualAmount?: number;
    projectionBalance?: number;
    actualBalance?: number;
  }) {
    const sourceRevision = `sha256:${Buffer.from(targetProjectId).toString('hex').padEnd(64, '0').slice(0, 64)}`;
    const cells: Array<Record<string, unknown>> = [];
    for (const mode of ['projection', 'actual']) {
      for (let weekNo = 1; weekNo <= 5; weekNo += 1) {
        for (const lineId of CASHFLOW_ALL_LINES) {
          const amount = mode === 'projection' ? projectionAmount : actualAmount;
          const selected = weekNo === 1 && lineId === 'SALES_IN';
          cells.push({
            mode,
            yearMonth: '2026-01',
            weekNo,
            lineId,
            direction: lineId.endsWith('_IN') ? 'IN' : 'OUT',
            state: selected ? (amount === 0 ? 'ZERO' : 'VALUE') : 'EMPTY',
            ...(selected ? { amount } : {}),
          });
        }
      }
    }
    const weeklyCalculationChecks = [];
    for (const mode of ['projection', 'actual']) {
      for (let weekNo = 1; weekNo <= 5; weekNo += 1) {
        const amount = mode === 'projection' ? projectionAmount : actualAmount;
        const balance = mode === 'projection' ? projectionBalance : actualBalance;
        weeklyCalculationChecks.push({
          mode,
          yearMonth: '2026-01',
          weekNo,
          reported: {
            openingBalance: 0,
            depositTotal: weekNo === 1 ? amount : 0,
            withdrawalTotal: 0,
            balance,
          },
        });
      }
    }
    const annualMode = (amount: number, balance: number) => ({
      source: 'ANNUAL',
      lineAmounts: { SALES_IN: amount },
      lineStates: Object.fromEntries(CASHFLOW_ALL_LINES.map((lineId) => [
        lineId,
        lineId === 'SALES_IN' ? (amount === 0 ? 'ZERO' : 'VALUE') : 'EMPTY',
      ])),
      totalIn: amount,
      totalOut: 0,
      net: balance,
    });
    const annualCells: Array<Record<string, unknown>> = [];
    const annualDerivedCells: Array<Record<string, unknown>> = [];
    for (const mode of ['projection', 'actual']) {
      const amount = mode === 'projection' ? projectionAmount : actualAmount;
      const balance = mode === 'projection' ? projectionBalance : actualBalance;
      for (const lineId of CASHFLOW_ALL_LINES) {
        const selected = lineId === 'SALES_IN';
        annualCells.push({
          mode,
          year: 2024,
          periodKind: 'ANNUAL',
          lineId,
          direction: lineId.endsWith('_IN') ? 'IN' : 'OUT',
          state: selected ? (amount === 0 ? 'ZERO' : 'VALUE') : 'EMPTY',
          ...(selected ? { amount } : {}),
        });
      }
      annualDerivedCells.push(
        { mode, year: 2024, periodKind: 'ANNUAL', derivedKind: 'deposit_total', state: amount === 0 ? 'ZERO' : 'VALUE', amount },
        { mode, year: 2024, periodKind: 'ANNUAL', derivedKind: 'withdrawal_total', state: 'ZERO', amount: 0 },
        { mode, year: 2024, periodKind: 'ANNUAL', derivedKind: 'balance', state: 'VALUE', amount: balance },
      );
    }
    await db.doc(`orgs/${tenantId}/cashflow_sheet_mirrors/${targetProjectId}`).set({
      projectId: targetProjectId,
      weeklyYear: 2026,
      status: 'FRESH',
      sourceRevision,
      appliedSourceRevision: sourceRevision,
      cells,
      annualCells,
      annualDerivedCells,
      sheetFacts: {
        weeklyCalculationChecks,
        annualCashflowTotals: [{
          year: 2024,
          projection: annualMode(9_999, 9_999),
          actual: annualMode(9_999, 9_999),
        }],
      },
    });
  }

  async function clearCollection(path: string): Promise<void> {
    const snap = await db.collection(path).get();
    if (snap.empty) return;

    const chunks: Array<typeof snap.docs> = [];
    for (let i = 0; i < snap.docs.length; i += 400) {
      chunks.push(snap.docs.slice(i, i + 400));
    }

    for (const chunk of chunks) {
      const batch = db.batch();
      chunk.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }
  }

  async function resetTenantData(): Promise<void> {
    const collections = [
      'projects',
      'partEntries',
      'project_code_registry',
      'project_requests',
      'projectRequests',
      'ledgers',
      'transactions',
      'comments',
      'evidences',
      'client_error_events',
      'audit_logs',
      'audit_chain',
      'change_events',
      'views',
      'members',
      'persons',
      'cashflow_weeks',
      'cashflow_sheet_mirrors',
      'outbox_deliveries',
      'idempotency_keys',
      'relation_rules',
      'participation_rules',
    ];

    for (const collectionName of collections) {
      await clearCollection(`orgs/${tenantId}/${collectionName}`);
    }

    await clearCollection('outbox');
    await clearCollection('work_queue');
  }

  async function seedPortalParticipationChange({
    targetProjectId,
    requestId,
    projectReviewState,
  }: {
    targetProjectId: string;
    requestId: string;
    projectReviewState: Record<string, unknown>;
  }) {
    const oldSyncRef = db.doc(`orgs/${tenantId}/partEntries/pte-${targetProjectId}-old`);
    const manualRef = db.doc(`orgs/${tenantId}/partEntries/manual-${targetProjectId}`);
    const oldSyncEntry = {
      id: `pte-${targetProjectId}-old`,
      tenantId,
      projectId: targetProjectId,
      memberId: 'project-team:old',
      memberName: '기존 담당자',
      source: 'PROJECT_TEAM_SYNC',
      rate: 15,
      monthlyRates: { '2026-01': 15 },
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const manualEntry = {
      id: `manual-${targetProjectId}`,
      tenantId,
      projectId: targetProjectId,
      memberId: 'manual-member',
      memberName: '수기 담당자',
      source: 'MANUAL',
      rate: 5,
      monthlyRates: { '2026-01': 5 },
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    await db.doc(`orgs/${tenantId}/projects/${targetProjectId}`).set({
      id: targetProjectId,
      tenantId,
      name: '기존 참여율 사업',
      version: 2,
      contractStart: '2026-01-01',
      contractEnd: '2027-12-31',
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/portal-participation/edit',
      teamMembersDetailed: [{
        memberName: '기존 담당자',
        memberNickname: 'old',
        role: '',
        participationRate: 15,
        laborAllocationStartMonth: '2026-01',
        laborAllocationEndMonth: '2026-12',
        monthlyRates: { '2026-01': 15 },
      }],
      ...projectReviewState,
    });
    await db.doc(`orgs/${tenantId}/project_requests/${requestId}`).set({
      id: requestId,
      tenantId,
      requestKind: 'CHANGE',
      status: 'PENDING',
      targetProjectId,
      approvedProjectId: targetProjectId,
      baseProjectVersion: 2,
      targetProjectVersion: 3,
      requestVersion: 1,
      proposedSnapshot: {
        name: '시트 참여율 반영 사업',
        executiveApproverId: actorId,
        teamMembersDetailed: [{
          personId: 'person-able',
          memberName: '김정태',
          memberNickname: 'able',
          role: '',
          participationRate: 20,
          laborAllocationStartMonth: '2026-01',
          laborAllocationEndMonth: '2027-12',
          monthlyRates: {
            '2026-01': null,
            '2026-02': 0,
            '2026-03': 10,
            '2027-01': 5,
          },
        }],
      },
    });
    await oldSyncRef.set(oldSyncEntry);
    await manualRef.set(manualEntry);
    return { oldSyncRef, manualRef, oldSyncEntry, manualEntry };
  }

  beforeAll(async () => {
    api = await createApi(app);
    await resetTenantData();
  });

  beforeEach(async () => {
    await resetTenantData();
    await db.doc(`orgs/${tenantId}/members/${actorId}`).set({
      uid: actorId,
      email: 'u001@example.com',
      role: 'admin',
      status: 'ACTIVE',
    });
    await db.doc(`orgs/${tenantId}/persons/person-${actorId}`).set({
      personId: `person-${actorId}`,
      uid: actorId,
      name: 'Integration Admin',
    });
  });

  afterAll(async () => {
    try { await resetTenantData(); }
    finally { await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))); }
  });

  it('returns health metadata', async () => {
    const response = await api.get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.projectId).toBe(projectId);
  });

  it('ingests client error events into Firestore', async () => {
    const logged = vi.spyOn(console, 'error');
    try {
      const response = await api
        .post('/api/v1/client-errors')
        .set({ ...defaultHeaders, 'idempotency-key': 'idem-client-error-001' })
        .send({
          eventType: 'exception',
          message: 'Portal projects listen failed',
          name: 'FirebaseError',
          stack: 'Error: Portal projects listen failed',
          level: 'error',
          source: 'portal_store',
          route: '/portal/project-settings?tab=old#section',
          href: 'https://inner-platform.vercel.app/portal/project-settings?tab=old#section',
          clientRequestId: 'ui:req.001',
          tags: {
            action: 'projects_listen',
          },
          extra: {
            requestId: 'req_001',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.id).toMatch(/^cerr_/);

      const stored = await db.doc(`orgs/${tenantId}/client_error_events/${response.body.id}`).get();
      expect(stored.exists).toBe(true);
      expect(stored.data()).toMatchObject({
        tenantId,
        actorId,
        source: 'portal_store',
        message: 'Portal projects listen failed',
        clientRequestId: 'ui:req.001',
        route: '/portal/project-settings?tab=old#section',
        href: 'https://inner-platform.vercel.app/portal/project-settings?tab=old#section',
      });
      const event = logged.mock.calls.map(([line]) => { try { return JSON.parse(String(line)); } catch { return {}; } }).find((entry) => entry.message === 'client.error');
      expect(event.clientRequestId).toBe('ui:req.001');
      expect(event.route).toBe('/portal/project-settings?tab=old#section');
      expect(event.href).toBe('https://inner-platform.vercel.app/portal/project-settings?tab=old#section');
    } finally { logged.mockRestore(); }
  });

  it('logs safe project diagnostics with original failure correlation and server actor role', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await api.post('/api/v1/client-errors').set({ ...defaultHeaders, 'idempotency-key': 'diagnostics-valid' }).send({
        eventType: 'exception', source: 'platform_api', message: '플랫폼 요청 실패',
        route: '/portal/register-project/private-draft',
        tags: { method: 'PATCH' },
        clientRequestId: 'original-client-request',
        extra: { errorCode: 'draft_version_conflict', operation: 'project_info_draft_save', endpoint: '/api/v1/project-info-drafts/*', status: 409, attempt: 0, maxRetries: 2, release: 'release-ssot', responseRequestId: 'original-server-request', actorRole: 'forged-admin', expectedDraftRevision: 1, actualDraftRevision: 2, body: 'private-body', fileName: 'private-file.pdf', sessionId: 'private-session', leaseId: 'private-lease', idempotencyKey: 'private-key' },
      });
      expect(response.status).toBe(200);
      const event = logged.mock.calls.map(([line]) => { try { return JSON.parse(String(line)); } catch { return {}; } }).find((entry) => entry.message === 'client.error');
      expect(event).toMatchObject({ errorCode: 'draft_version_conflict', operation: 'project_info_draft_save', release: 'release-ssot', clientRequestId: 'original-client-request', responseRequestId: 'original-server-request', actorRole: 'admin' });
      expect(event.requestId).not.toBe(event.clientRequestId);
      expect(event.route).toBe('/portal/register-project');
      expect(event).toMatchObject({ endpoint: '/api/v1/project-info-drafts/*', method: 'PATCH', status: 409, attempt: 0, maxRetries: 2 });
      const stored = (await db.doc(`orgs/${tenantId}/client_error_events/${response.body.id}`).get()).data();
      expect(stored.extra).toMatchObject({ errorCode: 'draft_version_conflict', expectedDraftRevision: 1, actualDraftRevision: 2, status: 409, attempt: 0, maxRetries: 2 });
      expect(stored.tags.method).toBe('PATCH');
      expect(stored.route).toBe('/portal/register-project');
      expect(stored.actorEmail).toBeUndefined();
      expect(JSON.stringify(stored)).not.toMatch(/private-|forged-admin/);
      const invalid = await api.post('/api/v1/client-errors').set({ ...defaultHeaders, 'idempotency-key': 'diagnostics-invalid' }).send({
        source: 'platform_api', message: '플랫폼 요청 실패',
        route: '/portal/private@example.com/private-file.pdf?token=x',
        tags: { method: 'private-method' },
        extra: { errorCode: 'private@example.com', operation: 'secret-token', release: 'private-file.pdf?token=private-token', responseRequestId: 'private@example.com', endpoint: '/api/v1/projects/private-user/private-file.pdf?token=private-token', status: 600, attempt: -1, maxRetries: '3' },
      });
      expect(invalid.status).toBe(200);
      const invalidStored = (await db.doc(`orgs/${tenantId}/client_error_events/${invalid.body.id}`).get()).data();
      expect(invalidStored.tags.method).toBeUndefined();
      expect(invalidStored.route).toBe('/portal/*');
      expect(JSON.stringify(invalidStored)).not.toMatch(/private@example|private-file/);
      for (const key of ['endpoint', 'status', 'attempt', 'maxRetries']) expect(invalidStored.extra[key]).toBeUndefined();
      const logs = JSON.stringify(logged.mock.calls);
      expect(logs).not.toMatch(/private@example|private-file|private-token|secret-token|forged-admin/);
    } finally { logged.mockRestore(); }
  });

  it('preserves generic API resource-family diagnostics in stored events and logs', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await api.post('/api/v1/client-errors').set({ ...defaultHeaders, 'idempotency-key': 'generic-diagnostics' }).send({
        source: 'platform_api', message: '플랫폼 요청 실패', tags: { method: 'GET' },
        extra: { endpoint: '/api/v1/transactions/*', status: 503, attempt: 1, maxRetries: 2 },
      });
      expect(response.status).toBe(200);
      const stored = (await db.doc(`orgs/${tenantId}/client_error_events/${response.body.id}`).get()).data();
      expect(stored).toMatchObject({ tags: { method: 'GET' }, extra: { endpoint: '/api/v1/transactions/*', status: 503, attempt: 1, maxRetries: 2 } });
      const event = logged.mock.calls.map(([line]) => { try { return JSON.parse(String(line)); } catch { return {}; } }).find((entry) => entry.message === 'client.error');
      expect(event).toMatchObject({ method: 'GET', endpoint: '/api/v1/transactions/*', status: 503, attempt: 1, maxRetries: 2 });
    } finally { logged.mockRestore(); }
  });

  it('delivers project registration Slack notifications for stored project requests', async () => {
    const projectRegistrationSlackService = {
      enabled: true,
      notifyMessage: vi.fn(async () => {}),
    };
    const notifyApi = await createApi(createBffApp({
      projectId,
      workerSecret,
      db,
      projectRegistrationSlackService,
    }));

    await db.doc(`orgs/${tenantId}/project_requests/pr_notify_001`).set({
      id: 'pr_notify_001',
      tenantId,
      status: 'APPROVED',
      approvedProjectId: 'p_notify_001',
      requestedByName: '보람',
      requestedByEmail: 'boram@example.com',
      payload: {
        name: '2026 CTS2',
        officialContractName: 'CTS 역량강화 사업',
        clientOrg: 'CTS',
        department: '개발협력센터',
        managerName: '보람',
        teamName: 'AXR팀',
        contractStart: '2026-04-01',
        contractEnd: '2026-12-31',
        contractAmount: 120000000,
        projectPurpose: '역량강화 교육 운영',
      },
      createdAt: '2026-03-31T10:00:00.000Z',
      updatedAt: '2026-03-31T10:00:00.000Z',
    }, { merge: true });

    const response = await notifyApi
      .post('/api/v1/project-requests/pr_notify_001/notify-registration')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-request-notify-001' })
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      enabled: true,
      delivered: true,
      requestId: 'pr_notify_001',
      projectId: 'p_notify_001',
    });
    expect(projectRegistrationSlackService.notifyMessage).toHaveBeenCalledTimes(1);
    expect(projectRegistrationSlackService.notifyMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('2026 CTS2'),
    }));
  });

  it('requires organization-head approval before management planning can agree', async () => {
    const reviewApi = await createApi(createBffApp({ projectId, workerSecret, db }));
    await db.doc(`orgs/${tenantId}/projects/p_management_gate_001`).set({
      id: 'p_management_gate_001',
      tenantId,
      name: '경영기획실 승인 게이트',
      executiveReviewStatus: 'PENDING',
      executiveReviewHistory: [],
    });

    const response = await reviewApi
      .post('/api/v1/projects/p_management_gate_001/management-planning-review')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-management-gate-001' })
      .send({ reviewStatus: 'AGREED', projectCode: 'PRJ-2026-100' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('executive_review_required');
  });

  it('lets management planning issue a code only after organization-head approval', async () => {
    const reviewApi = await createApi(createBffApp({ projectId, workerSecret, db }));
    await db.doc(`orgs/${tenantId}/projects/p_exec_review_001`).set({
      id: 'p_exec_review_001',
      tenantId,
      name: '네팔 귀환노동자 재정착 사업',
      registrationSource: 'pm_portal',
      executiveReviewStatus: 'PENDING',
      executiveApproverId: actorId,
      executiveApproverName: '조직장A',
      executiveReviewHistory: [{
        status: 'PENDING',
        previousStatus: null,
        reviewedAt: '2026-04-20T08:00:00.000Z',
        reviewedById: 'u-old',
        reviewedByName: '변민욱',
        reviewComment: 'PM 신규 등록',
      }],
      createdAt: '2026-04-20T08:00:00.000Z',
      updatedAt: '2026-04-20T09:00:00.000Z',
    }, { merge: true });
    await db.doc(`orgs/${tenantId}/project_requests/pr_exec_review_001`).set({
      id: 'pr_exec_review_001',
      tenantId,
      status: 'PENDING',
      approvedProjectId: 'p_exec_review_001',
      payload: { executiveApproverId: actorId },
    }, { merge: true });

    const approved = await reviewApi
      .post('/api/v1/projects/p_exec_review_001/executive-review')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-executive-review-001' })
      .send({ requestId: 'pr_exec_review_001', reviewStatus: 'APPROVED' });
    expect(approved.status).toBe(200);

    const agreement = await reviewApi
      .post('/api/v1/projects/p_exec_review_001/management-planning-review')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-management-review-001' })
      .send({ requestId: 'pr_exec_review_001', reviewStatus: 'AGREED', projectCode: ' prj-2026-001 ' });
    expect(agreement.status).toBe(200);
    expect(agreement.body.reviewStatus).toBe('AGREED');

    const project = (await db.doc(`orgs/${tenantId}/projects/p_exec_review_001`).get()).data();
    expect(project).toMatchObject({
      executiveReviewStatus: 'APPROVED',
      projectCode: 'PRJ-2026-001',
      projectCodeKey: 'PRJ-2026-001',
      managementPlanningReviewStatus: 'AGREED',
    });
    expect(project?.executiveReviewHistory).toHaveLength(2);
    expect(project?.managementPlanningReviewHistory).toEqual([expect.objectContaining({
      status: 'AGREED',
      previousStatus: 'PENDING',
      projectCode: 'PRJ-2026-001',
    })]);
    expect((await db.doc(`orgs/${tenantId}/projectCodeClaims/PRJ-2026-001`).get()).data()).toMatchObject({
      projectId: 'p_exec_review_001',
    });
  });

  it.each([
    {
      label: 'organization-head approval',
      projectId: 'p_exec_participation_sync_001',
      requestId: 'pr_exec_participation_sync_001',
      path: '/api/v1/projects/p_exec_participation_sync_001/executive-review',
      projectReviewState: {
        executiveReviewStatus: 'PENDING',
        executiveApproverId: actorId,
      },
      reviewBody: { reviewStatus: 'APPROVED' },
    },
  ])('syncs approved portal change monthly rates through $label and preserves MANUAL entries', async ({
    projectId: targetProjectId,
    requestId,
    path,
    projectReviewState,
    reviewBody,
  }) => {
    const reviewApi = await createApi(createBffApp({ projectId, workerSecret, db }));
    const { oldSyncRef, manualRef, manualEntry } = await seedPortalParticipationChange({
      targetProjectId,
      requestId,
      projectReviewState,
    });

    const response = await reviewApi
      .post(path)
      .set({
        ...defaultHeaders,
        'idempotency-key': `idem-${targetProjectId}`,
      })
      .send({ requestId, ...reviewBody });

    expect(response.status).toBe(200);
    const synced = await db.doc(`orgs/${tenantId}/partEntries/pte-${targetProjectId}-able__2026-01`).get();
    expect(synced.exists).toBe(true);
    expect(synced.data()).toMatchObject({
      projectId: targetProjectId,
      projectName: '시트 참여율 반영 사업',
      personId: 'person-able',
      source: 'PROJECT_TEAM_SYNC',
      rate: 20,
      periodStart: '2026-01',
      periodEnd: '2027-12',
      monthlyRates: {
        '2026-01': null,
        '2026-02': 0,
        '2026-03': 10,
        '2027-01': 5,
      },
    });
    expect((await oldSyncRef.get()).exists).toBe(false);
    expect((await manualRef.get()).data()).toEqual(manualEntry);
  });

  it.each([
    {
      label: 'management-planning agreement',
      projectId: 'p_management_participation_sync_001',
      requestId: 'pr_management_participation_sync_001',
      path: '/api/v1/projects/p_management_participation_sync_001/management-planning-review',
      projectReviewState: {
        executiveReviewStatus: 'APPROVED',
        managementPlanningReviewStatus: 'PENDING',
      },
      reviewBody: { reviewStatus: 'AGREED', projectCode: 'PRJ-2026-431' },
      expectedRequestStatus: 'APPROVED',
    },
    {
      label: 'organization-head rejection',
      projectId: 'p_exec_participation_reject_001',
      requestId: 'pr_exec_participation_reject_001',
      path: '/api/v1/projects/p_exec_participation_reject_001/executive-review',
      projectReviewState: {
        executiveReviewStatus: 'PENDING',
        executiveApproverId: actorId,
      },
      reviewBody: { reviewStatus: 'REVISION_REJECTED', reviewComment: '참여율을 확인해 주세요' },
      expectedRequestStatus: 'REJECTED',
    },
    {
      label: 'management-planning rejection',
      projectId: 'p_management_participation_reject_001',
      requestId: 'pr_management_participation_reject_001',
      path: '/api/v1/projects/p_management_participation_reject_001/management-planning-review',
      projectReviewState: {
        executiveReviewStatus: 'APPROVED',
        managementPlanningReviewStatus: 'PENDING',
      },
      reviewBody: { reviewStatus: 'REVISION_REJECTED', reviewComment: '참여율을 확인해 주세요' },
      expectedRequestStatus: 'APPROVED',
    },
  ])('does not sync portal change participation entries on $label', async ({
    projectId: targetProjectId,
    requestId,
    path,
    projectReviewState,
    reviewBody,
    expectedRequestStatus,
  }) => {
    const reviewApi = await createApi(createBffApp({ projectId, workerSecret, db }));
    const { oldSyncRef, manualRef, oldSyncEntry, manualEntry } = await seedPortalParticipationChange({
      targetProjectId,
      requestId,
      projectReviewState,
    });
    if (expectedRequestStatus === 'APPROVED') {
      await db.doc(`orgs/${tenantId}/project_requests/${requestId}`).update({ status: 'APPROVED' });
    }

    const response = await reviewApi
      .post(path)
      .set({
        ...defaultHeaders,
        'idempotency-key': `idem-${targetProjectId}`,
      })
      .send({ requestId, ...reviewBody });

    expect(response.status).toBe(200);
    expect((await oldSyncRef.get()).data()).toEqual(oldSyncEntry);
    expect((await manualRef.get()).data()).toEqual(manualEntry);
    expect((await db.doc(`orgs/${tenantId}/partEntries/pte-${targetProjectId}-able__2026-01`).get()).exists).toBe(false);
    expect((await db.doc(`orgs/${tenantId}/project_requests/${requestId}`).get()).data()?.status).toBe(expectedRequestStatus);
  });

  it('requires a rejection reason for executive rejection and discard', async () => {
    const reviewApi = await createApi(createBffApp({
      projectId,
      workerSecret,
      db,
    }));

    await db.doc(`orgs/${tenantId}/projects/p_exec_review_002`).set({
      id: 'p_exec_review_002',
      tenantId,
      name: '사유 필수 테스트',
      registrationSource: 'pm_portal',
      createdAt: '2026-04-20T08:00:00.000Z',
      updatedAt: '2026-04-20T08:00:00.000Z',
    }, { merge: true });

    const response = await reviewApi
      .post('/api/v1/projects/p_exec_review_002/executive-review')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-executive-review-002' })
      .send({
        reviewStatus: 'REVISION_REJECTED',
        reviewerName: '임원B',
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('request_error');
    expect(response.body.message).toMatch(/reviewComment/i);
  });

  it('rejects new planning-before-exec but lets organization heads finalise existing planning agreements', async () => {
    const reviewApi = await createApi(createBffApp({ projectId, workerSecret, db }));
    await db.doc(`orgs/${tenantId}/projects/p_new_planning_001`).set({
      id: 'p_new_planning_001', tenantId, name: '신규 역순 차단', executiveApproverId: actorId, executiveReviewStatus: 'PENDING', executiveReviewHistory: [],
    });
    const newAgreement = await reviewApi
      .post('/api/v1/projects/p_new_planning_001/executive-review')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-new-planning-before-exec' })
      .send({ reviewStatus: 'PLANNING_AGREED', projectCode: 'PRJ-2026-legacy' });
    expect(newAgreement.status).toBe(409);
    expect(newAgreement.body.error).toBe('legacy_planning_agreement_read_only');

    await db.doc(`orgs/${tenantId}/projects/p_legacy_planning_001`).set({
      id: 'p_legacy_planning_001',
      tenantId,
      name: '기존 경영기획실 합의',
      executiveApproverId: actorId,
      executiveReviewStatus: 'PLANNING_AGREED',
      executiveReviewHistory: [{ status: 'PLANNING_AGREED', projectCode: 'PRJ-2026-LEGACY' }],
      projectCode: 'PRJ-2026-LEGACY',
    });
    const approved = await reviewApi
      .post('/api/v1/projects/p_legacy_planning_001/executive-review')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-legacy-planning-final-approved' })
      .send({ reviewStatus: 'APPROVED' });
    expect(approved.status).toBe(200);
    expect((await db.doc(`orgs/${tenantId}/projects/p_legacy_planning_001`).get()).data()).toMatchObject({
      executiveReviewStatus: 'APPROVED',
      projectCode: 'PRJ-2026-LEGACY',
    });
    const alreadyAgreed = await reviewApi
      .post('/api/v1/projects/p_legacy_planning_001/management-planning-review')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-legacy-planning-management-repeat' })
      .send({ reviewStatus: 'AGREED', projectCode: 'PRJ-2026-LEGACY' });
    expect(alreadyAgreed.status).toBe(409);
    expect(alreadyAgreed.body.error).toBe('legacy_planning_agreement_already_finalized');
  });

  it('rejects duplicate project codes from management planning', async () => {
    const reviewApi = await createApi(createBffApp({ projectId, workerSecret, db }));
    await db.doc(`orgs/${tenantId}/projects/p_code_owner_001`).set({
      id: 'p_code_owner_001', tenantId, name: '코드 소유 프로젝트', executiveApproverId: actorId, executiveReviewStatus: 'PENDING', executiveReviewHistory: [],
    });
    await db.doc(`orgs/${tenantId}/projects/p_code_owner_002`).set({
      id: 'p_code_owner_002', tenantId, name: '코드 중복 프로젝트', executiveApproverId: actorId, executiveReviewStatus: 'PENDING', executiveReviewHistory: [],
    });

    const firstApproval = await reviewApi
      .post('/api/v1/projects/p_code_owner_001/executive-review')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-code-owner-exec-001' })
      .send({ reviewStatus: 'APPROVED' });
    expect(firstApproval.status).toBe(200);
    const secondApproval = await reviewApi
      .post('/api/v1/projects/p_code_owner_002/executive-review')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-code-owner-exec-002' })
      .send({ reviewStatus: 'APPROVED' });
    expect(secondApproval.status).toBe(200);

    const agreed = await reviewApi
      .post('/api/v1/projects/p_code_owner_001/management-planning-review')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-code-owner-agree' })
      .send({ reviewStatus: 'AGREED', projectCode: 'PRJ-2026-009' });
    expect(agreed.status).toBe(200);

    const duplicate = await reviewApi
      .post('/api/v1/projects/p_code_owner_002/management-planning-review')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-code-duplicate' })
      .send({ reviewStatus: 'AGREED', projectCode: 'PRJ-2026-009' });
    expect(duplicate.status).toBe(409);
  });

  it('requires the designated organization head for new executive decisions', async () => {
    const reviewApi = await createApi(createBffApp({ projectId, workerSecret, db }));
    await db.doc(`orgs/${tenantId}/projects/p_designated_exec_001`).set({
      id: 'p_designated_exec_001',
      tenantId,
      name: '조직장 지정 검증',
      executiveApproverId: 'u-other',
      executiveReviewStatus: 'PENDING',
      executiveReviewHistory: [],
    });

    const response = await reviewApi
      .post('/api/v1/projects/p_designated_exec_001/executive-review')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-designated-exec-001' })
      .send({ reviewStatus: 'APPROVED' });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('executive_approver_mismatch');
  });

  it('uses the resubmitted change request approver instead of a stale project approver', async () => {
    const reviewApi = await createApi(createBffApp({ projectId, workerSecret, db }));
    await db.doc(`orgs/${tenantId}/projects/p_reassigned_exec_001`).set({
      id: 'p_reassigned_exec_001',
      tenantId,
      name: '조직장 재지정',
      version: 2,
      executiveApproverId: 'u-previous-head',
      executiveApproverName: '이전 조직장',
      executiveReviewStatus: 'PENDING',
      executiveReviewHistory: [],
    });
    await db.doc(`orgs/${tenantId}/project_requests/pr_reassigned_exec_001`).set({
      id: 'pr_reassigned_exec_001',
      tenantId,
      requestKind: 'CHANGE',
      status: 'PENDING',
      targetProjectId: 'p_reassigned_exec_001',
      approvedProjectId: 'p_reassigned_exec_001',
      baseProjectVersion: 2,
      targetProjectVersion: 3,
      requestVersion: 1,
      proposedSnapshot: {
        executiveApproverId: actorId,
        executiveApproverName: '새 조직장',
      },
    });

    const response = await reviewApi
      .post('/api/v1/projects/p_reassigned_exec_001/executive-review')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-reassigned-exec-001' })
      .send({ requestId: 'pr_reassigned_exec_001', reviewStatus: 'APPROVED' });

    expect(response.status).toBe(200);
    expect((await db.doc(`orgs/${tenantId}/projects/p_reassigned_exec_001`).get()).data()).toMatchObject({
      executiveApproverId: actorId,
      executiveApproverName: '새 조직장',
      executiveReviewStatus: 'APPROVED',
    });
  });

  it('atomically trashes a project with its duplicate-discard review', async () => {
    const reviewApi = await createApi(createBffApp({ projectId, workerSecret, db }));
    const projectRef = db.doc(`orgs/${tenantId}/projects/p_exec_discard_001`);
    await projectRef.set({
      id: 'p_exec_discard_001',
      tenantId,
      name: '중복 폐기 테스트',
      version: 1,
      registrationSource: 'pm_portal',
      executiveReviewStatus: 'PLANNING_AGREED',
      executiveApproverId: actorId,
      projectCode: 'PRJ-2026-002',
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    });

    const response = await reviewApi
      .post('/api/v1/projects/p_exec_discard_001/executive-review')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-executive-discard-001' })
      .send({
        reviewStatus: 'DUPLICATE_DISCARDED',
        reviewComment: '동일 계약 프로젝트가 이미 등록되어 있습니다.',
        reviewerName: '임원B',
      });

    expect(response.status).toBe(200);
    expect((await projectRef.get()).data()).toMatchObject({
      version: 2,
      executiveReviewStatus: 'DUPLICATE_DISCARDED',
      trashedById: actorId,
      trashedByEmail: null,
      trashedReason: '동일 계약 프로젝트가 이미 등록되어 있습니다.',
    });
    expect((await projectRef.get()).data()?.trashedAt).toEqual(expect.any(String));
  });

  it('resubmits an executive-rejected pm portal project back to pending', async () => {
    const reviewApi = await createApi(createBffApp({
      projectId,
      workerSecret,
      db,
    }));

    await db.doc(`orgs/${tenantId}/projects/p_exec_review_003`).set({
      id: 'p_exec_review_003',
      tenantId,
      name: '재제출 테스트 사업',
      registrationSource: 'pm_portal',
      executiveReviewStatus: 'REVISION_REJECTED',
      executiveReviewedAt: '2026-04-20T09:00:00.000Z',
      executiveReviewedById: 'u-old',
      executiveReviewedByName: '임원A',
      executiveReviewComment: '계약서 다시 올려 주세요',
      executiveReviewHistory: [
        {
          status: 'REVISION_REJECTED',
          previousStatus: 'APPROVED',
          reviewedAt: '2026-04-20T09:00:00.000Z',
          reviewedById: 'u-old',
          reviewedByName: '임원A',
          reviewComment: '계약서 다시 올려 주세요',
        },
      ],
      contractDocument: {
        path: 'orgs/mysc/project-request-contracts/u-old/contract.pdf',
        name: '재제출_계약서.pdf',
        downloadURL: 'https://example.com/recontract.pdf',
        size: 2345,
        contentType: 'application/pdf',
        uploadedAt: '2026-04-20T08:00:00.000Z',
      },
      createdAt: '2026-04-20T08:00:00.000Z',
      updatedAt: '2026-04-20T09:00:00.000Z',
    }, { merge: true });

    await db.doc(`orgs/${tenantId}/project_requests/pr_exec_review_003`).set({
      id: 'pr_exec_review_003',
      tenantId,
      status: 'REJECTED',
      reviewOutcome: 'REVISION_REJECTED',
      approvedProjectId: 'p_exec_review_003',
      requestKind: 'CHANGE',
      rejectedReason: '계약서 다시 올려 주세요',
      payload: {
        name: '재제출 테스트 사업',
        officialContractName: '재제출 테스트 사업',
        clientOrg: 'KOICA',
        department: 'CIC1',
        managerName: '변민욱',
        teamName: 'AXR팀',
        contractDocument: {
          path: 'orgs/mysc/project-request-contracts/u-old/contract.pdf',
          name: '재제출_계약서.pdf',
          downloadURL: 'https://example.com/recontract.pdf',
          size: 2345,
          contentType: 'application/pdf',
          uploadedAt: '2026-04-20T08:00:00.000Z',
        },
        contractAnalysis: {
          provider: 'heuristic',
          model: 'fallback',
          summary: '기존 분석',
          warnings: [],
          nextActions: [],
          extractedAt: '2026-04-20T08:01:00.000Z',
          fields: {},
        },
      },
      proposedSnapshot: {
        name: '재제출 테스트 사업',
        officialContractName: '재제출 테스트 사업',
        clientOrg: 'KOICA',
        department: 'CIC1',
        managerName: '변민욱',
        teamName: 'AXR팀',
        contractDocument: {
          path: 'orgs/mysc/project-request-documents/u-new/contract.pdf',
          name: '보완_계약서.pdf',
          downloadURL: 'https://example.com/new-contract.pdf',
          size: 3456,
          contentType: 'application/pdf',
          uploadedAt: '2026-04-21T08:00:00.000Z',
        },
      },
      createdAt: '2026-04-20T08:00:00.000Z',
      updatedAt: '2026-04-20T09:00:00.000Z',
    }, { merge: true });

    const response = await reviewApi
      .post('/api/v1/projects/p_exec_review_003/executive-review/resubmit')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-executive-review-003-resubmit' })
      .send({
        requestId: 'pr_exec_review_003',
        reviewComment: '계약서 보완 후 다시 제출',
        reviewerName: '변민욱',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      projectId: 'p_exec_review_003',
      requestId: 'pr_exec_review_003',
      reviewStatus: 'PENDING',
    });
    expect((await db.doc(`orgs/${tenantId}/projects/p_exec_review_003`).get()).data()).toMatchObject({
      executiveReviewStatus: 'PENDING',
      executiveReviewedAt: expect.any(String),
      executiveReviewedById: actorId,
      executiveReviewedByName: '변민욱',
      executiveReviewComment: '계약서 보완 후 다시 제출',
      executiveReviewHistory: expect.arrayContaining([
        expect.objectContaining({
          status: 'PENDING',
          reviewedByName: '변민욱',
          reviewComment: '계약서 보완 후 다시 제출',
        }),
      ]),
    });
    const requestSnap = await db.doc(`orgs/${tenantId}/project_requests/pr_exec_review_003`).get();
    expect(requestSnap.data()?.payload?.contractDocument).toMatchObject({
      name: '보완_계약서.pdf',
      path: 'orgs/mysc/project-request-documents/u-new/contract.pdf',
    });
    expect(requestSnap.data()?.proposedSnapshot?.contractDocument).toMatchObject({
      name: '보완_계약서.pdf',
      path: 'orgs/mysc/project-request-documents/u-new/contract.pdf',
    });
  });

  it('resubmits a management-planning rejection without reopening organization-head review', async () => {
    const reviewApi = await createApi(createBffApp({ projectId, workerSecret, db }));
    const executiveHistory = [{
      status: 'APPROVED',
      previousStatus: 'PENDING',
      reviewedAt: '2026-07-12T00:00:00.000Z',
      reviewedById: actorId,
      reviewedByName: '조직장A',
      reviewComment: null,
    }];
    const managementHistory = [{
      status: 'REVISION_REJECTED',
      previousStatus: 'PENDING',
      reviewedAt: '2026-07-12T01:00:00.000Z',
      reviewedById: 'finance-a',
      reviewedByName: '경영기획실A',
      reviewComment: '프로젝트 코드 기준을 보완해 주세요',
    }];
    await db.doc(`orgs/${tenantId}/projects/p_management_resubmit_001`).set({
      id: 'p_management_resubmit_001',
      tenantId,
      name: '경영기획실 반려 재제출',
      executiveReviewStatus: 'APPROVED',
      executiveReviewHistory: executiveHistory,
      managementPlanningReviewStatus: 'REVISION_REJECTED',
      managementPlanningReviewedAt: '2026-07-12T01:00:00.000Z',
      managementPlanningReviewedById: 'finance-a',
      managementPlanningReviewedByName: '경영기획실A',
      managementPlanningReviewComment: '프로젝트 코드 기준을 보완해 주세요',
      managementPlanningReviewHistory: managementHistory,
    });
    await db.doc(`orgs/${tenantId}/project_requests/pr_management_resubmit_001`).set({
      id: 'pr_management_resubmit_001',
      tenantId,
      status: 'PENDING',
      reviewOutcome: 'REVISION_REJECTED',
      approvedProjectId: 'p_management_resubmit_001',
      rejectedReason: '프로젝트 코드 기준을 보완해 주세요',
      payload: { name: '경영기획실 반려 재제출' },
    });

    const response = await reviewApi
      .post('/api/v1/projects/p_management_resubmit_001/executive-review/resubmit')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-management-resubmit-001' })
      .send({ requestId: 'pr_management_resubmit_001', reviewComment: '보완 후 재제출' });
    expect(response.status).toBe(200);

    const project = (await db.doc(`orgs/${tenantId}/projects/p_management_resubmit_001`).get()).data();
    expect(project?.executiveReviewStatus).toBe('APPROVED');
    expect(project?.executiveReviewHistory).toEqual(executiveHistory);
    expect(project).toMatchObject({
      managementPlanningReviewStatus: 'PENDING',
      managementPlanningReviewedAt: null,
      managementPlanningReviewedById: null,
      managementPlanningReviewedByName: null,
      managementPlanningReviewComment: null,
      managementPlanningReviewHistory: managementHistory,
    });
  });

  it('also resubmits an executive-rejected legacy project back to pending', async () => {
    const reviewApi = await createApi(createBffApp({
      projectId,
      workerSecret,
      db,
    }));

    await db.doc(`orgs/${tenantId}/projects/p_exec_review_legacy_001`).set({
      id: 'p_exec_review_legacy_001',
      tenantId,
      name: '기존 등록 재제출 테스트 사업',
      registrationSource: 'legacy_import',
      executiveReviewStatus: 'REVISION_REJECTED',
      executiveReviewedAt: '2026-04-20T09:00:00.000Z',
      executiveReviewedById: 'u-old',
      executiveReviewedByName: '대표A',
      executiveReviewComment: '기존 등록 사업도 다시 제출 가능해야 합니다',
      executiveReviewHistory: [
        {
          status: 'REVISION_REJECTED',
          previousStatus: 'APPROVED',
          reviewedAt: '2026-04-20T09:00:00.000Z',
          reviewedById: 'u-old',
          reviewedByName: '대표A',
          reviewComment: '기존 등록 사업도 다시 제출 가능해야 합니다',
        },
      ],
      createdAt: '2026-04-20T08:00:00.000Z',
      updatedAt: '2026-04-20T09:00:00.000Z',
    }, { merge: true });

    await db.doc(`orgs/${tenantId}/project_requests/pr_exec_review_legacy_001`).set({
      id: 'pr_exec_review_legacy_001',
      tenantId,
      status: 'REJECTED',
      reviewOutcome: 'REVISION_REJECTED',
      approvedProjectId: 'p_exec_review_legacy_001',
      rejectedReason: '기존 등록 사업도 다시 제출 가능해야 합니다',
      payload: {
        name: '기존 등록 재제출 테스트 사업',
        officialContractName: '기존 등록 재제출 테스트 사업',
        clientOrg: 'KOICA',
        department: 'CIC1',
        managerName: '변민욱',
        teamName: 'AXR팀',
      },
      createdAt: '2026-04-20T08:00:00.000Z',
      updatedAt: '2026-04-20T09:00:00.000Z',
    }, { merge: true });

    const response = await reviewApi
      .post('/api/v1/projects/p_exec_review_legacy_001/executive-review/resubmit')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-executive-review-legacy-001-resubmit' })
      .send({
        requestId: 'pr_exec_review_legacy_001',
        reviewComment: '기존 등록 사업도 수정 후 다시 제출',
        reviewerName: '변민욱',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      projectId: 'p_exec_review_legacy_001',
      requestId: 'pr_exec_review_legacy_001',
      reviewStatus: 'PENDING',
    });
    expect((await db.doc(`orgs/${tenantId}/projects/p_exec_review_legacy_001`).get()).data()).toMatchObject({
      executiveReviewStatus: 'PENDING',
      executiveReviewedAt: expect.any(String),
      executiveReviewedById: actorId,
      executiveReviewedByName: '변민욱',
      executiveReviewComment: '기존 등록 사업도 수정 후 다시 제출',
    });
  });

  it('persists explicit zero contract amounts through project upsert', async () => {
    const response = await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-zero-contract-001' })
      .send({
        id: 'p-zero-contract-001',
        name: 'Zero Contract Project',
        contractAmount: 0,
      });

    expect([200, 201]).toContain(response.status);

    const stored = await db.doc(`orgs/${tenantId}/projects/p-zero-contract-001`).get();
    expect(stored.exists).toBe(true);
    expect(stored.data()).toMatchObject({
      id: 'p-zero-contract-001',
      name: 'Zero Contract Project',
      contractAmount: 0,
    });
  });

  it('persists sheet monthly rates through project save and exposes the exact linked values in the dashboard', async () => {
    const targetProjectId = 'p-participation-monthly-001';
    const sheetLink = 'https://docs.google.com/spreadsheets/d/participation-monthly-001/edit';
    await db.doc(`orgs/${tenantId}/persons/person-able`).set({
      personId: 'person-able',
      name: '김정태',
      nickname: '에이블',
    });

    const teamMembersDetailed = [
      {
        personId: 'person-able',
        memberName: '김정태',
        memberNickname: '에이블',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        laborAllocationEndMonth: '2027-02',
        monthlyRates: {
          '2026-01': 20,
          '2026-02': null,
          '2026-03': 0,
          '2027-01': 5,
        },
      },
      {
        memberName: '김혜령',
        memberNickname: '테일러',
        role: '',
        participationRate: 30,
        laborAllocationStartMonth: '2026-01',
        laborAllocationEndMonth: '2026-03',
        monthlyRates: { '2026-01': 30, '2026-02': null, '2026-03': 10 },
      },
    ];
    const projectPayload = {
      id: targetProjectId,
      name: '참여율 월별 저장 통합 사업',
      registrationRequirementsVersion: 2,
      clientOrg: 'KOICA',
      basis: '공급가액',
      settlementSystem: 'E_NARA_DOUM',
      contractStart: '2026-01-01',
      contractEnd: '2027-02-28',
      participationSheetLink: sheetLink,
      teamMembersDetailed,
    };

    const created = await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-participation-monthly-create-001' })
      .send(projectPayload);

    expect(created.status).toBe(201);
    const firstEntries = await db.collection(`orgs/${tenantId}/partEntries`)
      .where('projectId', '==', targetProjectId)
      .get();
    expect(firstEntries.docs.map((doc) => doc.id).sort()).toEqual([
      `pte-${targetProjectId}-에이블__2026-01`,
      `pte-${targetProjectId}-테일러__2026-01`,
    ]);
    expect(firstEntries.docs.find((doc) => doc.id.endsWith('-에이블__2026-01'))?.data()).toMatchObject({
      personId: 'person-able',
      clientOrg: 'KOICA',
      settlementSystem: 'E_NARA_DOUM',
      monthlyRates: {
        '2026-01': 20,
        '2026-02': null,
        '2026-03': 0,
        '2027-01': 5,
      },
    });
    expect(firstEntries.docs.find((doc) => doc.id.endsWith('-테일러__2026-01'))?.data()).not.toHaveProperty('personId');

    const portfolioFixtures = [
      { id: 'p-koica-rcms', name: 'KOICA RCMS 사업', clientOrg: 'KOICA', settlementSystem: 'RCMS', rate: 7 },
      { id: 'p-koica-ezbaro', name: 'KOICA 이지바로 사업', clientOrg: 'KOICA', settlementSystem: 'EZBARO', rate: 3 },
      { id: 'p-koica-other', name: 'KOICA 다른 정산 사업', clientOrg: 'KOICA', settlementSystem: 'ACCOUNTANT', rate: 11 },
      { id: 'p-other-rcms', name: '타 고객 RCMS 사업', clientOrg: '다른 고객', settlementSystem: 'RCMS', rate: 13 },
    ];
    for (const fixture of portfolioFixtures) {
      await db.doc(`orgs/${tenantId}/projects/${fixture.id}`).set({
        id: fixture.id,
        name: fixture.name,
        clientOrg: fixture.clientOrg,
        settlementSystem: fixture.settlementSystem,
        contractStart: '2026-01-01',
        contractEnd: '2026-01-31',
      });
      await db.doc(`orgs/${tenantId}/partEntries/pte-${fixture.id}-able__2026-01`).set({
        id: `pte-${fixture.id}-able__2026-01`,
        projectId: fixture.id,
        projectName: fixture.name,
        personId: 'person-able',
        memberId: 'project-team:able__2026-01',
        memberName: '김정태',
        source: 'PROJECT_TEAM_SYNC',
        rate: fixture.rate,
        periodStart: '2026-01',
        periodEnd: '2026-01',
        monthlyRates: { '2026-01': fixture.rate },
      });
    }

    await db.doc(`orgs/${tenantId}/participation_rules/participation-rule-koica-platforms`).set({
      id: 'participation-rule-koica-platforms',
      kind: 'USER_DEFINED',
      alias: 'KOICA 정산 플랫폼 묶음',
      clientOrgs: ['KOICA'],
      settlementSystems: ['E_NARA_DOUM', 'RCMS', 'EZBARO'],
    });
    await db.doc(`orgs/${tenantId}/participation_rules/participation-rule-rcms-all`).set({
      id: 'participation-rule-rcms-all',
      kind: 'USER_DEFINED',
      alias: '고객 무관 RCMS 전체',
      clientOrgs: [],
      settlementSystems: ['RCMS'],
    });
    await db.doc(`orgs/${tenantId}/participation_rules/participation-rule-koica-all`).set({
      id: 'participation-rule-koica-all',
      kind: 'USER_DEFINED',
      alias: 'KOICA 전체 정산 플랫폼',
      clientOrgs: ['KOICA'],
      settlementSystems: [],
    });
    const dashboardCollectionNames = ['projects', 'partEntries', 'persons', 'participation_rules'];
    const snapshotDashboardCollections = async () => Object.fromEntries(await Promise.all(
      dashboardCollectionNames.map(async (collectionName) => {
        const snapshot = await db.collection(`orgs/${tenantId}/${collectionName}`).get();
        return [collectionName, snapshot.docs
          .map((doc) => ({ id: doc.id, data: doc.data() }))
          .sort((left, right) => left.id.localeCompare(right.id))];
      }),
    ));
    const collectionsBeforeDashboard = await snapshotDashboardCollections();
    const expectedYearMonths = [
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
      '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12',
    ];
    const dashboard = await api
      .get('/api/v1/participation-dashboard?year=2026&ruleId=participation-rule-koica-platforms')
      .set(defaultHeaders);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.selectedRule).toMatchObject({
      alias: 'KOICA 정산 플랫폼 묶음',
      clientOrgs: ['KOICA'],
      settlementSystems: ['E_NARA_DOUM', 'RCMS', 'EZBARO'],
    });
    expect(dashboard.body.unlinkedEntryCount).toBe(1);
    expect(dashboard.body.months).toHaveLength(12);
    expect(dashboard.body.months.map((month: { yearMonth: string }) => month.yearMonth)).toEqual(expectedYearMonths);
    expect(dashboard.body.members).toEqual([
      expect.objectContaining({
        memberId: 'person-able',
        projectCount: 3,
        months: expect.arrayContaining([
          expect.objectContaining({ yearMonth: '2026-01', rate: 30, isConfirmed: true, hasMissing: false }),
          expect.objectContaining({ yearMonth: '2026-02', rate: 0, isConfirmed: false, hasMissing: true }),
          expect.objectContaining({ yearMonth: '2026-03', rate: 0, isConfirmed: true, hasMissing: false }),
        ]),
      }),
    ]);
    const koicaPlatformsMember = dashboard.body.members[0];
    expect(koicaPlatformsMember.projects.map((project: { projectId: string }) => project.projectId).sort()).toEqual([
      targetProjectId,
      'p-koica-ezbaro',
      'p-koica-rcms',
    ].sort());
    expect(koicaPlatformsMember.projects).toHaveLength(koicaPlatformsMember.projectCount);
    koicaPlatformsMember.projects.forEach((project: { months: Array<{ yearMonth: string }> }) => {
      expect(project.months.map((month) => month.yearMonth)).toEqual(expectedYearMonths);
    });
    const targetProject = koicaPlatformsMember.projects.find((project: { projectId: string }) => project.projectId === targetProjectId);
    expect(targetProject.months).toEqual(expect.arrayContaining([
      expect.objectContaining({ yearMonth: '2026-01', rate: 20, isConfirmed: true, hasMissing: false }),
      expect.objectContaining({ yearMonth: '2026-02', rate: 0, isConfirmed: false, hasMissing: true }),
      expect.objectContaining({ yearMonth: '2026-03', rate: 0, isConfirmed: true, hasMissing: false }),
    ]));
    const koicaRcmsProject = koicaPlatformsMember.projects.find((project: { projectId: string }) => project.projectId === 'p-koica-rcms');
    const koicaEzbaroProject = koicaPlatformsMember.projects.find((project: { projectId: string }) => project.projectId === 'p-koica-ezbaro');
    expect(koicaRcmsProject.months).toContainEqual(expect.objectContaining({ yearMonth: '2026-01', rate: 7 }));
    expect(koicaEzbaroProject.months).toContainEqual(expect.objectContaining({ yearMonth: '2026-01', rate: 3 }));
    expect(koicaPlatformsMember.months.find((month: { yearMonth: string }) => month.yearMonth === '2026-01')?.rate).toBe(
      koicaPlatformsMember.projects.reduce((sum: number, project: { months: Array<{ yearMonth: string; rate: number }> }) => (
        sum + (project.months.find((month) => month.yearMonth === '2026-01')?.rate || 0)
      ), 0),
    );
    expect(dashboard.body.filterOptions.settlementSystems.map(({ value, projectCount }: { value: string; projectCount: number }) => ({
      value,
      projectCount,
    }))).toEqual([
      { value: 'NONE', projectCount: 0 },
      { value: 'E_NARA_DOUM', projectCount: 1 },
      { value: 'BOTAEM_E', projectCount: 0 },
      { value: 'RCMS', projectCount: 2 },
      { value: 'EZBARO', projectCount: 1 },
      { value: 'SMTECH', projectCount: 0 },
      { value: 'KOCCA_PMS', projectCount: 0 },
      { value: 'NIPA', projectCount: 0 },
      { value: 'IRIS', projectCount: 0 },
      { value: 'OTHER', projectCount: 0 },
      { value: 'ACCOUNTANT', projectCount: 1 },
    ]);

    const platformOnlyDashboard = await api
      .get('/api/v1/participation-dashboard?year=2026&ruleId=participation-rule-rcms-all')
      .set(defaultHeaders);
    expect(platformOnlyDashboard.status).toBe(200);
    expect(platformOnlyDashboard.body.selectedRule).toMatchObject({
      alias: '고객 무관 RCMS 전체',
      clientOrgs: [],
      settlementSystems: ['RCMS'],
    });
    expect(platformOnlyDashboard.body.members).toEqual([
      expect.objectContaining({
        memberId: 'person-able',
        projectCount: 2,
        months: expect.arrayContaining([
          expect.objectContaining({ yearMonth: '2026-01', rate: 20 }),
        ]),
      }),
    ]);
    expect(platformOnlyDashboard.body.members[0].projects.map((project: { projectId: string }) => project.projectId).sort()).toEqual([
      'p-koica-rcms',
      'p-other-rcms',
    ]);
    platformOnlyDashboard.body.members[0].projects.forEach((project: { months: Array<{ yearMonth: string }> }) => {
      expect(project.months.map((month) => month.yearMonth)).toEqual(expectedYearMonths);
    });

    const clientOnlyDashboard = await api
      .get('/api/v1/participation-dashboard?year=2026&ruleId=participation-rule-koica-all')
      .set(defaultHeaders);
    expect(clientOnlyDashboard.status).toBe(200);
    expect(clientOnlyDashboard.body.selectedRule).toMatchObject({
      alias: 'KOICA 전체 정산 플랫폼',
      clientOrgs: ['KOICA'],
      settlementSystems: [],
    });
    expect(clientOnlyDashboard.body.members).toEqual([
      expect.objectContaining({
        memberId: 'person-able',
        projectCount: 4,
        months: expect.arrayContaining([
          expect.objectContaining({ yearMonth: '2026-01', rate: 41 }),
        ]),
      }),
    ]);
    expect(clientOnlyDashboard.body.members[0].projects.map((project: { projectId: string }) => project.projectId).sort()).toEqual([
      targetProjectId,
      'p-koica-ezbaro',
      'p-koica-other',
      'p-koica-rcms',
    ].sort());
    clientOnlyDashboard.body.members[0].projects.forEach((project: { months: Array<{ yearMonth: string }> }) => {
      expect(project.months.map((month) => month.yearMonth)).toEqual(expectedYearMonths);
    });

    const allDashboard = await api
      .get('/api/v1/participation-dashboard?year=2026&ruleId=all')
      .set(defaultHeaders);
    expect(allDashboard.status).toBe(200);
    expect(allDashboard.body.members.length).toBeGreaterThan(0);
    expect(allDashboard.body.members.every((member: { projects: unknown[] }) => member.projects.length === 0)).toBe(true);
    expect(allDashboard.body.members).toContainEqual(expect.objectContaining({
      memberId: 'person-able',
      projectCount: 5,
      projects: [],
      months: expect.arrayContaining([
        expect.objectContaining({ yearMonth: '2026-01', rate: 54 }),
      ]),
    }));

    expect(await snapshotDashboardCollections()).toEqual(collectionsBeforeDashboard);

    await db.doc(`orgs/${tenantId}/persons/person-taylor`).set({
      personId: 'person-taylor',
      name: '김혜령',
      nickname: '테일러',
    });
    const updated = await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-participation-monthly-update-001' })
      .send({
        ...projectPayload,
        expectedVersion: 1,
        teamMembersDetailed: [
          {
            ...teamMembersDetailed[0],
            monthlyRates: { '2026-01': null, '2026-03': 10, '2027-01': 5 },
          },
          { ...teamMembersDetailed[1], personId: 'person-taylor' },
        ],
      });

    expect(updated.status).toBe(200);
    const secondEntries = await db.collection(`orgs/${tenantId}/partEntries`)
      .where('projectId', '==', targetProjectId)
      .get();
    expect(secondEntries.size).toBe(2);
    expect(secondEntries.docs.find((doc) => doc.id.endsWith('-에이블__2026-01'))?.data()?.monthlyRates).toEqual({
      '2026-01': null,
      '2026-03': 10,
      '2027-01': 5,
    });
    expect(secondEntries.docs.find((doc) => doc.id.endsWith('-테일러__2026-01'))?.data()).toMatchObject({
      personId: 'person-taylor',
    });

    const unrelatedUpdate = await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-participation-unrelated-update-001' })
      .send({
        id: targetProjectId,
        name: '참여율 월별 저장 통합 사업 이름 변경',
        expectedVersion: 2,
      });
    expect(unrelatedUpdate.status).toBe(200);
    const entriesAfterUnrelatedUpdate = await db.collection(`orgs/${tenantId}/partEntries`)
      .where('projectId', '==', targetProjectId)
      .get();
    const byId = (docs: typeof secondEntries.docs) => docs
      .map((doc) => ({ id: doc.id, data: doc.data() }))
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(byId(entriesAfterUnrelatedUpdate.docs)).toEqual(byId(secondEntries.docs));
  });

  it('creates a Person and professional profile atomically without copying profile values into audit or idempotency records', async () => {
    const personId = 'person-created-with-profile';
    const idempotencyKey = 'idem-person-create-with-profile-001';
    const payload = {
      personId,
      name: '새 프로필',
      email: 'created-profile-secret@example.com',
      employment: {
        type: 'FULL_TIME',
        state: 'WORKING',
        effectiveFrom: '2026-01-01',
      },
      professionalProfile: {
        educationRecords: [{
          attainmentCode: 'BACHELOR_GRADUATED',
          institutionName: 'private-create-university',
          countryCode: 'KR',
          major: 'private-create-major',
        }],
        englishEvidence: [{
          testCode: 'TOEFL',
          scaleCode: 'TOEFL_IBT_120',
          resultValue: '105',
          testedAt: '2025-11',
        }],
        certifications: [{ label: 'private-create-certificate' }],
      },
    };
    const created = await api
      .post('/api/v1/persons')
      .set({ ...defaultHeaders, 'idempotency-key': idempotencyKey })
      .send(payload);

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      person: { personId, name: '새 프로필' },
      professionalProfile: { revision: 1, changed: true },
    });
    expect(created.body.person).not.toHaveProperty('professionalProfile');
    const stored = (await db.doc(`orgs/${tenantId}/persons/${personId}`).get()).data();
    expect(stored?.professionalProfile).toMatchObject({
      schemaVersion: 1,
      educationRecords: [{ attainmentCode: 'BACHELOR_GRADUATED' }],
      englishEvidence: [{ testCode: 'TOEFL', resultValue: '105' }],
      certifications: [{ key: 'private-create-certificate', label: 'private-create-certificate' }],
      provenance: { revision: 1, source: 'PEOPLE_MANUAL' },
    });

    const replay = await api
      .post('/api/v1/persons')
      .set({ ...defaultHeaders, 'idempotency-key': idempotencyKey })
      .send(payload);
    expect(replay.status).toBe(201);
    expect(replay.headers['x-idempotency-replayed']).toBe('1');
    expect(replay.body).toEqual(created.body);

    const auditLogs = await db.collection(`orgs/${tenantId}/audit_logs`).get();
    const personAuditActions = auditLogs.docs
      .map((doc) => doc.data())
      .filter((entry) => entry.entityId === personId)
      .map((entry) => entry.action)
      .sort();
    expect(personAuditActions).toEqual(['CREATE', 'PROFILE_UPDATE']);
    const idempotencyDocs = await db.collection(`orgs/${tenantId}/idempotency_keys`).get();
    const createIdempotency = idempotencyDocs.docs
      .map((doc) => doc.data())
      .find((entry) => entry.idempotencyKey === idempotencyKey);
    expect(createIdempotency?.responseBody).toEqual({ personId, revision: 1, changed: true });
    const protectedRecords = JSON.stringify({
      auditLogs: auditLogs.docs.map((doc) => doc.data()),
      idempotency: createIdempotency,
    });
    for (const rawValue of [
      'created-profile-secret@example.com',
      'private-create-university',
      'private-create-major',
      'TOEFL_IBT_120',
      '2025-11',
      'private-create-certificate',
    ]) {
      expect(protectedRecords).not.toContain(rawValue);
    }

    const forbiddenEmptyProfilePersonId = 'person-created-empty-profile-forbidden';
    const forbiddenEmptyProfileKey = 'idem-person-create-empty-profile-forbidden-001';
    const forbiddenEmptyProfile = await api
      .post('/api/v1/persons')
      .set({
        'x-tenant-id': tenantId,
        'x-actor-id': 'tenant-admin-without-profile-permission',
        'x-actor-role': 'tenant_admin',
        'idempotency-key': forbiddenEmptyProfileKey,
      })
      .send({
        personId: forbiddenEmptyProfilePersonId,
        name: '권한 없는 빈 프로필',
        employment: {
          type: 'FULL_TIME',
          state: 'WORKING',
          effectiveFrom: '2026-01-01',
        },
        professionalProfile: {
          educationRecords: [],
          englishEvidence: [],
          certifications: [],
        },
      });
    expect(forbiddenEmptyProfile.status).toBe(403);
    expect((await db.doc(`orgs/${tenantId}/persons/${forbiddenEmptyProfilePersonId}`).get()).exists).toBe(false);
    const forbiddenEmptyProfileReceipt = (await db.collection(`orgs/${tenantId}/idempotency_keys`).get()).docs
      .map((doc) => doc.data())
      .find((entry) => entry.idempotencyKey === forbiddenEmptyProfileKey);
    expect(forbiddenEmptyProfileReceipt).toBeUndefined();

    const emptyProfilePersonId = 'person-created-empty-profile';
    const emptyProfileKey = 'idem-person-create-empty-profile-001';
    const emptyProfileCreated = await api
      .post('/api/v1/persons')
      .set({ ...defaultHeaders, 'idempotency-key': emptyProfileKey })
      .send({
        personId: emptyProfilePersonId,
        name: '빈 프로필',
        employment: {
          type: 'FULL_TIME',
          state: 'WORKING',
          effectiveFrom: '2026-01-01',
        },
        professionalProfile: {
          educationRecords: [],
          englishEvidence: [],
          certifications: [],
        },
      });
    expect(emptyProfileCreated.status).toBe(201);
    expect(emptyProfileCreated.body).toMatchObject({
      person: { personId: emptyProfilePersonId, name: '빈 프로필' },
      professionalProfile: { revision: 0, changed: false },
    });
    const emptyProfileStored = (await db.doc(`orgs/${tenantId}/persons/${emptyProfilePersonId}`).get()).data();
    expect(emptyProfileStored).not.toHaveProperty('professionalProfile');
    const emptyProfileAudit = (await db.collection(`orgs/${tenantId}/audit_logs`).get()).docs
      .map((doc) => doc.data())
      .filter((entry) => entry.entityId === emptyProfilePersonId);
    expect(emptyProfileAudit.map((entry) => entry.action)).toEqual(['CREATE']);
    const emptyProfileReceipt = (await db.collection(`orgs/${tenantId}/idempotency_keys`).get()).docs
      .map((doc) => doc.data())
      .find((entry) => entry.idempotencyKey === emptyProfileKey);
    expect(emptyProfileReceipt?.responseBody).toEqual({
      personId: emptyProfilePersonId,
      revision: 0,
      changed: false,
    });
  });

  it('persists a People professional profile and keeps it out of the participation dashboard', async () => {
    const personId = 'person-profile-filter';
    const projectIdForProfile = 'p-profile-filter';
    const idempotencyKey = 'idem-professional-profile-integration-001';
    await db.doc(`orgs/${tenantId}/persons/${personId}`).set({
      personId,
      name: '김프로필',
      email: 'profile-secret@example.com',
      note: 'private-person-note',
      joinedAt: '2026-01-01',
    });
    await db.doc(`orgs/${tenantId}/projects/${projectIdForProfile}`).set({
      id: projectIdForProfile,
      name: '프로필 필터 사업',
      clientOrg: 'KOICA',
      settlementSystem: 'RCMS',
      contractStart: '2026-01-01',
      contractEnd: '2026-12-31',
    });
    await db.doc(`orgs/${tenantId}/partEntries/pte-${projectIdForProfile}-profile`).set({
      id: `pte-${projectIdForProfile}-profile`,
      projectId: projectIdForProfile,
      projectName: '프로필 필터 사업',
      personId,
      memberId: 'project-team:profile',
      memberName: '김프로필',
      source: 'PROJECT_TEAM_SYNC',
      rate: 30,
      periodStart: '2026-01',
      periodEnd: '2026-12',
      monthlyRates: { '2026-01': 30 },
    });

    const profilePayload = {
      expectedRevision: 0,
      profile: {
        educationRecords: [{
          attainmentCode: 'MASTER_GRADUATED',
          institutionName: 'University of Sussex',
          countryCode: 'GB',
          major: 'private-major-secret',
        }],
        englishEvidence: [{
          testCode: 'TOEIC',
          scaleCode: 'TOEIC_990',
          resultValue: '920',
          testedAt: '2026-05',
        }],
        certifications: [{ label: 'PMP' }, { label: 'ODA 전문가' }],
      },
    };
    const saved = await api
      .put(`/api/v1/persons/${personId}/professional-profile`)
      .set({ ...defaultHeaders, 'idempotency-key': idempotencyKey })
      .send(profilePayload);

    expect(saved.status).toBe(200);
    const storedPerson = (await db.doc(`orgs/${tenantId}/persons/${personId}`).get()).data();
    expect(storedPerson?.professionalProfile).toMatchObject({
      schemaVersion: 1,
      educationRecords: [{
        attainmentCode: 'MASTER_GRADUATED',
        institutionName: 'University of Sussex',
        // 옛 국가 코드(GB)로 보내도 국내/해외 구분으로 옮겨 저장된다.
        regionCode: 'OVERSEAS_ENGLISH',
        major: 'private-major-secret',
      }],
      englishEvidence: [{
        testCode: 'TOEIC',
        scaleCode: 'TOEIC_990',
        resultValue: '920',
        testedAt: '2026-05',
      }],
      certifications: [{ key: 'pmp', label: 'PMP' }, { key: 'oda 전문가', label: 'ODA 전문가' }],
      provenance: { revision: 1, source: 'PEOPLE_MANUAL' },
    });
    expect(saved.body).toEqual({
      profile: storedPerson?.professionalProfile,
      revision: 1,
      changed: true,
    });

    const replay = await api
      .put(`/api/v1/persons/${personId}/professional-profile`)
      .set({ ...defaultHeaders, 'idempotency-key': idempotencyKey })
      .send(profilePayload);
    expect(replay.status).toBe(200);
    expect(replay.headers['x-idempotency-replayed']).toBe('1');
    expect(replay.body).toEqual(saved.body);

    await db.doc(`orgs/${tenantId}/members/viewer-profile`).set({
      uid: 'viewer-profile',
      email: 'viewer-profile@example.com',
      role: 'viewer',
      status: 'ACTIVE',
    });
    const forbiddenReplay = await api
      .put(`/api/v1/persons/${personId}/professional-profile`)
      .set({
        'x-tenant-id': tenantId,
        'x-actor-id': 'viewer-profile',
        'x-actor-role': 'viewer',
        'idempotency-key': idempotencyKey,
      })
      .send(profilePayload);
    expect(forbiddenReplay.status).toBe(403);

    const peopleResponse = await api.get('/api/v1/persons').set(defaultHeaders);
    expect(peopleResponse.status).toBe(200);
    expect(peopleResponse.body.capabilities).toEqual({
      professionalProfileRead: true,
      professionalProfileWrite: true,
    });
    const directoryPerson = peopleResponse.body.items.find((person: { personId: string }) => person.personId === personId);
    expect(directoryPerson).toMatchObject({ personId, name: '김프로필' });
    expect(directoryPerson).not.toHaveProperty('professionalProfile');
    expect(directoryPerson).not.toHaveProperty('note');

    const protectedCollections = [
      'projects',
      'partEntries',
      'persons',
      'participation_rules',
      'audit_logs',
      'audit_chain',
      'idempotency_keys',
    ];
    const snapshotProtectedCollections = async () => Object.fromEntries(await Promise.all(
      protectedCollections.map(async (collectionName) => {
        const snapshot = await db.collection(`orgs/${tenantId}/${collectionName}`).get();
        return [collectionName, snapshot.docs
          .map((doc) => ({ id: doc.id, data: doc.data() }))
          .sort((left, right) => left.id.localeCompare(right.id))];
      }),
    ));
    const beforeDashboardRead = await snapshotProtectedCollections();
    // 2026-08-27 보람: 학력·어학·자격은 인력 명부(People)가 본다. 참여율 응답에는
    // 권한과 무관하게 인사정보가 실리지 않는다 - 가려야 할 데이터를 아예 안 보낸다.
    const dashboard = await api
      .get('/api/v1/participation-dashboard?year=2026&ruleId=all')
      .set(defaultHeaders);

    expect(dashboard.status).toBe(200);
    expect(dashboard.headers['cache-control']).toContain('no-store');
    expect(dashboard.body).not.toHaveProperty('professionalProfileAccess');
    expect(dashboard.body).not.toHaveProperty('profileFilterOptions');
    expect(dashboard.body).not.toHaveProperty('selectedProfileFilters');
    expect(dashboard.body.members).toEqual([
      expect.objectContaining({
        memberId: personId,
        memberName: '김프로필',
        projectCount: 1,
        months: expect.arrayContaining([
          expect.objectContaining({ yearMonth: '2026-01', rate: 30, isConfirmed: true }),
        ]),
      }),
    ]);
    expect(dashboard.body.members.every((member: Record<string, unknown>) => !('profileSummary' in member))).toBe(true);
    expect(JSON.stringify(dashboard.body)).not.toContain('profile-secret@example.com');
    expect(JSON.stringify(dashboard.body)).not.toContain('private-person-note');
    expect(JSON.stringify(dashboard.body)).not.toContain('private-major-secret');
    for (const forbidden of ['"testedAt"', '"major"', '"countryCode"', '"regionCode"', '"resultValue"', '"professionalProfile"', 'PMP', 'University of Sussex']) {
      expect(JSON.stringify(dashboard.body)).not.toContain(forbidden);
    }
    expect(await snapshotProtectedCollections()).toEqual(beforeDashboardRead);

    const auditAndIdempotency = JSON.stringify({
      auditLogs: beforeDashboardRead.audit_logs,
      auditChain: beforeDashboardRead.audit_chain,
      idempotencyKeys: beforeDashboardRead.idempotency_keys,
    });
    const profileIdempotency = beforeDashboardRead.idempotency_keys
      .map(({ data }) => data)
      .find((entry) => entry.idempotencyKey === idempotencyKey);
    expect(profileIdempotency?.responseBody).toEqual({ personId, revision: 1, changed: true });
    for (const rawProfileValue of ['University of Sussex', 'private-major-secret', 'TOEIC_990', '2026-05', 'PMP', 'ODA 전문가']) {
      expect(auditAndIdempotency).not.toContain(rawProfileValue);
    }

  });

  it('normalizes project revenue fields through project upsert', async () => {
    const response = await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-revenue-normalize-001' })
      .send({
        id: 'p-revenue-normalize-001',
        name: 'Revenue Normalize Project',
        contractAmount: 100000,
        totalRevenueAmount: 91000,
        profitAmount: 1,
        profitRate: 0.01,
      });

    expect([200, 201]).toContain(response.status);

    const stored = await db.doc(`orgs/${tenantId}/projects/p-revenue-normalize-001`).get();
    expect(stored.exists).toBe(true);
    expect(stored.data()).toMatchObject({
      id: 'p-revenue-normalize-001',
      totalRevenueAmount: 91000,
      profitAmount: 91000,
      profitRate: 0.91,
    });
  });

  it('delivers project registration Slack notifications only for PM portal-created projects', async () => {
    const projectRegistrationSlackService = {
      enabled: true,
      notifyMessage: vi.fn(async () => {}),
    };
    const projectsApi = await createApi(createBffApp({
      projectId,
      workerSecret,
      db,
      projectRegistrationSlackService,
    }));

    const adminCreated = await projectsApi
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-create-slack-001' })
      .send({
        id: 'p-slack-create-admin-001',
        name: 'Admin Create Project',
        type: 'I1',
        department: '투자센터',
        managerName: '보람',
        contractAmount: 0,
        financialInputFlags: { contractAmount: false },
      });

    expect(adminCreated.status).toBe(201);
    expect(projectRegistrationSlackService.notifyMessage).toHaveBeenCalledTimes(0);

    const pmCreated = await projectsApi
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-create-slack-002' })
      .send({
        id: 'p-slack-create-pm-001',
        name: 'PM Portal Create Project',
        type: 'I1',
        department: '투자센터',
        managerName: '보람',
        contractAmount: 0,
        financialInputFlags: { contractAmount: false },
        registrationSource: 'pm_portal',
      });

    expect(pmCreated.status).toBe(201);
    expect(projectRegistrationSlackService.notifyMessage).toHaveBeenCalledTimes(1);
    expect(projectRegistrationSlackService.notifyMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('PM Portal Create Project'),
      blocks: expect.any(Array),
    }));

    const updated = await projectsApi
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-create-slack-003' })
      .send({
        id: 'p-slack-create-pm-001',
        name: 'PM Portal Create Project Updated',
        type: 'I1',
        expectedVersion: 1,
        registrationSource: 'pm_portal',
      });

    expect(updated.status).toBe(200);
    expect(projectRegistrationSlackService.notifyMessage).toHaveBeenCalledTimes(1);
  });

  it('previews google sheet rows for an existing project', async () => {
    const googleSheetsService = {
      previewSpreadsheet: vi.fn(async ({ value, sheetName }) => ({
        spreadsheetId: 'sheet-001',
        spreadsheetTitle: '주간 사업비 시트',
        selectedSheetName: sheetName || '주간정산',
        availableSheets: [
          { sheetId: 0, title: '요약', index: 0 },
          { sheetId: 1, title: '주간정산', index: 1 },
        ],
        matrix: [
          ['작성자', '거래일시', '지급처'],
          ['홍길동', '2026-03-12', '카페 메리'],
        ],
      })),
    };
    const sheetsApi = await createApi(createBffApp({ projectId, workerSecret, db, googleSheetsService }));

    await sheetsApi
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-sheets-001' })
      .send({ id: 'p-sheets-001', name: 'Sheets Project' });

    const preview = await sheetsApi
      .post('/api/v1/projects/p-sheets-001/google-sheet-import/preview')
      .set({
        ...defaultHeaders,
        'x-google-access-token': 'google-token-123',
        'idempotency-key': 'idem-google-sheet-preview-001',
      })
      .send({ value: 'https://docs.google.com/spreadsheets/d/sheet-001/edit#gid=1' });

    expect(preview.status).toBe(200);
    expect(preview.body.spreadsheetTitle).toBe('주간 사업비 시트');
    expect(preview.body.selectedSheetName).toBe('주간정산');
    expect(preview.body.matrix[1]).toEqual(['홍길동', '2026-03-12', '카페 메리']);
    expect(googleSheetsService.previewSpreadsheet).toHaveBeenCalledWith({
      value: 'https://docs.google.com/spreadsheets/d/sheet-001/edit#gid=1',
      sheetName: undefined,
      accessToken: 'google-token-123',
    });
  });

  it('analyzes google sheet migration guidance for an existing project', async () => {
    const googleSheetMigrationAiService = {
      analyzePreview: vi.fn(async ({ spreadsheetTitle, selectedSheetName, matrix }) => ({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        summary: `${spreadsheetTitle}의 ${selectedSheetName} 탭은 사용내역으로 보입니다.`,
        confidence: 'high',
        likelyTarget: 'expense_sheet',
        usageTips: ['비목/세목 컬럼을 먼저 확인하세요.'],
        warnings: ['2줄 헤더 여부를 확인하세요.'],
        nextActions: ['표본 3행을 먼저 검증하세요.'],
        suggestedMappings: [
          {
            sourceHeader: '입금합계 > 입금액',
            platformField: '입금합계/입금액',
            confidence: 'high',
            reason: '입금 금액 그룹으로 보입니다.',
          },
        ],
        headerPreview: ['작성자', '입금합계 > 입금액'],
      })),
    };
    const analysisApi = await createApi(createBffApp({ projectId, workerSecret, db, googleSheetMigrationAiService }));

    await analysisApi
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-sheets-002' })
      .send({ id: 'p-sheets-002', name: 'Sheets Analysis Project' });

    const analysis = await analysisApi
      .post('/api/v1/projects/p-sheets-002/google-sheet-import/analyze')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-google-sheet-analyze-001' })
      .send({
        spreadsheetTitle: '2026 사업비 관리 시트',
        selectedSheetName: '사용내역',
        matrix: [
          ['작성자', '입금합계', '사업팀'],
          ['No.', '입금액', '지급처'],
        ],
      });

    expect(analysis.status).toBe(200);
    expect(analysis.body.likelyTarget).toBe('expense_sheet');
    expect(analysis.body.usageTips[0]).toContain('비목/세목');
    expect(googleSheetMigrationAiService.analyzePreview).toHaveBeenCalledWith({
      spreadsheetTitle: '2026 사업비 관리 시트',
      selectedSheetName: '사용내역',
      matrix: [
        ['작성자', '입금합계', '사업팀'],
        ['No.', '입금액', '지급처'],
      ],
    });
  });

  it('uploads and persists project sheet source snapshots for an existing project', async () => {
    const projectSheetSourceStorageService = {
      uploadSource: vi.fn(async () => ({
        path: 'orgs/mysc/project-sheet-sources/p-source-001/usage/123-환경AC.xlsx',
        name: '환경AC.xlsx',
        downloadURL: 'https://example.com/source.xlsx',
        size: 1024,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        uploadedAt: '2026-03-19T12:00:00.000Z',
      })),
    };
    const sourceApi = await createApi(createBffApp({ projectId, workerSecret, db, projectSheetSourceStorageService }));

    await sourceApi
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-source-001' })
      .send({ id: 'p-source-001', name: 'Source Project' });

    const upload = await sourceApi
      .post('/api/v1/projects/p-source-001/sheet-sources/upload')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-sheet-source-upload-001' })
      .send({
        sourceType: 'usage',
        sheetName: '사용내역',
        fileName: '환경AC.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileSize: 1024,
        contentBase64: 'ZmFrZS14bHN4',
        rowCount: 176,
        columnCount: 27,
        matchedColumns: ['작성자', '비목'],
        unmatchedColumns: ['정산증빙자료 부착완료 여부'],
        previewMatrix: [
          ['작성자', '비목'],
          ['메리', '여비'],
        ],
        applyTarget: 'expense_sheet',
      });

    expect(upload.status).toBe(200);
    expect(projectSheetSourceStorageService.uploadSource).toHaveBeenCalledWith(expect.objectContaining({
      tenantId,
      actorId,
      projectId: 'p-source-001',
      sourceType: 'usage',
      fileName: '환경AC.xlsx',
    }));
    expect(upload.body.sourceType).toBe('usage');
    expect(upload.body.previewMatrix[1]).toEqual(['메리', '여비']);

    const snap = await db.doc(`orgs/${tenantId}/projects/p-source-001/sheet_sources/usage`).get();
    expect(snap.exists).toBe(true);
    expect(snap.data()?.sheetName).toBe('사용내역');
    expect(snap.data()?.applyTarget).toBe('expense_sheet');
  });

  it('allows viewer role to process project request contract uploads', async () => {
    const projectRequestContractStorageService = {
      uploadContract: vi.fn(async ({ fileName, mimeType, fileSize }) => ({
        path: `orgs/${tenantId}/project-request-contracts/${actorId}/${fileName}`,
        name: fileName,
        downloadURL: `https://example.com/contracts/${encodeURIComponent(fileName)}`,
        size: fileSize,
        contentType: mimeType,
        uploadedAt: '2026-03-23T08:40:00.000Z',
      })),
    };
    const projectRequestContractAiService = {
      analyzeContract: vi.fn(async ({ fileName, documentText }) => ({
        provider: 'heuristic',
        model: 'deterministic-fallback',
        summary: `${fileName} 요약`,
        warnings: [],
        nextActions: [],
        extractedAt: '2026-03-23T08:40:00.000Z',
        fields: {
          officialContractName: { value: '공식 계약명', confidence: 'medium', evidence: documentText || fileName },
          suggestedProjectName: { value: '신규 사업', confidence: 'medium', evidence: fileName },
          clientOrg: { value: '발주처', confidence: 'low', evidence: '' },
          projectPurpose: { value: '', confidence: 'low', evidence: '' },
          description: { value: '', confidence: 'low', evidence: '' },
          contractStart: { value: '', confidence: 'low', evidence: '' },
          contractEnd: { value: '', confidence: 'low', evidence: '' },
          contractAmount: { value: null, confidence: 'low', evidence: '' },
          salesVatAmount: { value: null, confidence: 'low', evidence: '' },
        },
      })),
    };
    const contractApi = await createApi(createBffApp({
      projectId,
      workerSecret,
      db,
      projectRequestContractStorageService,
      projectRequestContractAiService,
    }));

    const upload = await contractApi
      .post('/api/v1/project-requests/contract/process')
      .set({
        ...defaultHeaders,
        'x-actor-role': 'viewer',
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent('viewer-contract.pdf'),
        'x-file-type': 'application/pdf',
        'x-file-size': '9',
        'idempotency-key': 'idem-project-request-contract-001',
      })
      .send(Buffer.from('%PDF-test'));

    expect(upload.status).toBe(200);
    expect(upload.body.contractDocument.name).toBe('viewer-contract.pdf');
    expect(upload.body.analysis.fields.officialContractName.value).toBe('공식 계약명');
    expect(projectRequestContractStorageService.uploadContract).toHaveBeenCalledWith(expect.objectContaining({
      tenantId,
      actorId,
      fileName: 'viewer-contract.pdf',
      mimeType: 'application/pdf',
      fileSize: 9,
    }));
    expect(projectRequestContractAiService.analyzeContract).toHaveBeenCalledWith(expect.objectContaining({
      fileName: 'viewer-contract.pdf',
    }));
  });

  it('rejects disallowed CORS origin', async () => {
    const corsApi = await createApi(createBffApp({
      projectId,
      allowedOrigins: 'http://localhost:5173',
    }));

    const denied = await corsApi
      .get('/api/v1/health')
      .set('origin', 'https://evil.example.com');

    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('origin_not_allowed');
  });

  it('enforces firebase_required auth mode and blocks header spoofing', async () => {
    const verifier = vi.fn(async (token: string) => {
      if (token !== 'valid-token') {
        throw new Error('invalid token');
      }
      return {
        uid: actorId,
        email: 'admin@mysc.co.kr',
        role: 'admin',
        tenantId,
      };
    });

    const secureApi = await createApi(createBffApp({
      projectId,
      authMode: 'firebase_required',
      tokenVerifier: verifier,
    }));

    const missingToken = await secureApi
      .get('/api/v1/projects')
      .set(defaultHeaders);

    expect(missingToken.status).toBe(401);
    expect(missingToken.body.error).toBe('missing_bearer_token');

    const ok = await secureApi
      .get('/api/v1/projects')
      .set({ ...defaultHeaders, authorization: 'Bearer valid-token' });

    expect(ok.status).toBe(200);

    const spoofed = await secureApi
      .get('/api/v1/projects')
      .set({
        ...defaultHeaders,
        'x-actor-id': 'spoofed-user',
        authorization: 'Bearer valid-token',
      });

    expect(spoofed.status).toBe(403);
    expect(spoofed.body.error).toBe('actor_mismatch');
  });

  it('handles project upsert idempotency and version conflicts', async () => {
    const createPayload = {
      id: 'p-bff-001',
      name: 'BFF Integration Project',
      slug: 'bff-integration-project',
      status: 'IN_PROGRESS',
    };

    const first = await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-create-001' })
      .send(createPayload);

    expect(first.status).toBe(201);
    expect(first.body.id).toBe(createPayload.id);
    expect(first.body.version).toBe(1);

    const replay = await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-create-001' })
      .send(createPayload);

    expect(replay.status).toBe(201);
    expect(replay.headers['x-idempotency-replayed']).toBe('1');
    expect(replay.body.version).toBe(1);

    const noExpectedVersion = await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-update-001' })
      .send({ ...createPayload, name: 'Updated without version' });

    expect(noExpectedVersion.status).toBe(409);
    expect(noExpectedVersion.body.error).toBe('version_required');

    const update = await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-update-002' })
      .send({ ...createPayload, name: 'Updated with version', expectedVersion: 1 });

    expect(update.status).toBe(200);
    expect(update.body.version).toBe(2);

    const wrongVersion = await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-update-003' })
      .send({ ...createPayload, name: 'Wrong version', expectedVersion: 1 });

    expect(wrongVersion.status).toBe(409);
    expect(wrongVersion.body.error).toBe('version_conflict');

    const conflict = await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-create-001' })
      .send({ ...createPayload, name: 'Different Project Name' });

    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('idempotency_conflict');
  });

  it('supports ledger and transaction upsert with validation', async () => {
    await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-seed-project-001' })
      .send({ id: 'p-bff-002', name: 'Project 2' });

    const missingProject = await api
      .post('/api/v1/ledgers')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-ledger-404' })
      .send({ id: 'l404', projectId: 'no-project', name: 'Invalid ledger' });

    expect(missingProject.status).toBe(404);

    const ledger = await api
      .post('/api/v1/ledgers')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-ledger-create-001' })
      .send({ id: 'l001', projectId: 'p-bff-002', name: 'Main Ledger' });

    expect(ledger.status).toBe(201);
    expect(ledger.body.version).toBe(1);

    const ledgerUpdate = await api
      .post('/api/v1/ledgers')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-ledger-update-001' })
      .send({ id: 'l001', projectId: 'p-bff-002', name: 'Main Ledger V2', expectedVersion: 1 });

    expect(ledgerUpdate.status).toBe(200);
    expect(ledgerUpdate.body.version).toBe(2);

    const tx = await api
      .post('/api/v1/transactions')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-tx-create-001' })
      .send({
        id: 'tx001',
        projectId: 'p-bff-002',
        ledgerId: 'l001',
        counterparty: 'Vendor A',
      });

    expect(tx.status).toBe(201);
    expect(tx.body.state).toBe('DRAFT');
    expect(tx.body.version).toBe(1);

    const txList = await api
      .get('/api/v1/transactions')
      .set(defaultHeaders);

    expect(txList.status).toBe(200);
    expect(txList.body.count).toBe(1);
  });

  it('supports deterministic cursor pagination for project list', async () => {
    await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-page-project-1' })
      .send({ id: 'p-page-001', name: 'Paged Project 1' });
    await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-page-project-2' })
      .send({ id: 'p-page-002', name: 'Paged Project 2' });
    await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-page-project-3' })
      .send({ id: 'p-page-003', name: 'Paged Project 3' });

    const firstPage = await api
      .get('/api/v1/projects?limit=2')
      .set(defaultHeaders);

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.count).toBe(2);
    expect(firstPage.body.nextCursor).toBeTruthy();

    const secondPage = await api
      .get(`/api/v1/projects?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .set(defaultHeaders);

    expect(secondPage.status).toBe(200);
    expect(secondPage.body.count).toBe(1);

    const seenIds = new Set([
      ...firstPage.body.items.map((item: any) => item.id),
      ...secondPage.body.items.map((item: any) => item.id),
    ]);
    expect(seenIds.size).toBe(3);
  });

  it('moves projects to trash and restores them with version checks', async () => {
    const created = await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-trash-project-001-create' })
      .send({ id: 'p-trash-001', name: 'Trash Target Project' });

    expect(created.status).toBe(201);

    const trashed = await api
      .post('/api/v1/projects/p-trash-001/trash')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-trash-project-001-trash' })
      .send({ expectedVersion: 1, reason: '중복 등록 테스트' });

    expect(trashed.status).toBe(200);
    expect(trashed.body.version).toBe(2);
    expect(typeof trashed.body.trashedAt).toBe('string');

    const trashedSnap = await db.doc(`orgs/${tenantId}/projects/p-trash-001`).get();
    expect(trashedSnap.exists).toBe(true);
    expect(trashedSnap.data()).toMatchObject({
      trashedById: actorId,
      trashedReason: '중복 등록 테스트',
    });
    expect(typeof trashedSnap.data()?.trashedAt).toBe('string');

    const restoreConflict = await api
      .post('/api/v1/projects/p-trash-001/restore')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-trash-project-001-restore-conflict' })
      .send({ expectedVersion: 1 });

    expect(restoreConflict.status).toBe(409);

    const restored = await api
      .post('/api/v1/projects/p-trash-001/restore')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-trash-project-001-restore' })
      .send({ expectedVersion: 2 });

    expect(restored.status).toBe(200);
    expect(restored.body.version).toBe(3);

    const restoredSnap = await db.doc(`orgs/${tenantId}/projects/p-trash-001`).get();
    expect(restoredSnap.exists).toBe(true);
    expect(restoredSnap.data()).toMatchObject({
      trashedAt: null,
      trashedById: null,
      trashedByEmail: null,
      trashedReason: null,
    });
  });

  it('auto-provisions a default ledger when a transaction is created before ledger setup', async () => {
    await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-auto-ledger-project-001' })
      .send({
        id: 'p-auto-ledger-001',
        name: 'Auto Ledger Project',
        accountType: 'DEDICATED',
      });

    const tx = await api
      .post('/api/v1/transactions')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-auto-ledger-tx-001' })
      .send({
        id: 'tx-auto-ledger-001',
        projectId: 'p-auto-ledger-001',
        ledgerId: 'l-p-auto-ledger-001',
        counterparty: 'Vendor Auto',
      });

    expect(tx.status).toBe(201);
    expect(tx.body.state).toBe('DRAFT');

    const ledgerSnap = await db.doc(`orgs/${tenantId}/ledgers/l-p-auto-ledger-001`).get();
    expect(ledgerSnap.exists).toBe(true);
    expect(ledgerSnap.data()?.projectId).toBe('p-auto-ledger-001');
    expect(ledgerSnap.data()?.name).toBe('전용통장 원장');
  });

  it('exports non-zero cashflow values from the stored sheet mirror without re-validating its status or revision', async () => {
    await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-cashflow-project-001' })
      .send({
        id: 'p-cashflow-001',
        name: 'Cashflow Project',
        accountType: 'DEDICATED',
      });

    await db.doc(`orgs/${tenantId}/cashflow_weeks/p-cashflow-001-2026-01-w1`).set({
      projectId: 'p-cashflow-001',
      yearMonth: '2026-01',
      weekNo: 1,
      weekStart: '2025-12-31',
      weekEnd: '2026-01-06',
      projection: { SALES_IN: 111 },
      actual: { SALES_IN: 222 },
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });

    await db.doc(`orgs/${tenantId}/transactions/tx-cashflow-001`).set({
      id: 'tx-cashflow-001',
      projectId: 'p-cashflow-001',
      dateTime: '2026-01-05',
      amount: 1250,
      createdAt: '2026-01-05T00:00:00.000Z',
      updatedAt: '2026-01-05T00:00:00.000Z',
    }, { merge: true });

    await seedCashflowExportMirror({
      targetProjectId: 'p-cashflow-001',
      projectionAmount: 1250,
      actualAmount: 900,
      projectionBalance: 6250,
      actualBalance: 4900,
    });
    await db.doc(`orgs/${tenantId}/cashflow_sheet_mirrors/p-cashflow-001`).set({
      status: 'STALE',
      appliedSourceRevision: `sha256:${'f'.repeat(64)}`,
    }, { merge: true });

    const response = await downloadCashflowExport({
      scope: 'single',
      projectId: 'p-cashflow-001',
      startYearMonth: '2026-01',
      endYearMonth: '2026-01',
      variant: 'single-project',
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const workbook = await readWorkbook(response.body);
    const worksheet = workbook.getWorksheet('Projection');
    const rows = worksheet.getSheetValues().filter(Boolean).map((row) => (Array.isArray(row) ? row.slice(1) : []));
    expect(rows[0]).toEqual(['사업', 'Cashflow Project', '사업 ID', 'p-cashflow-001', '거래 수', 1]);
    const salesRow = rows.find((row) => row[0] === '매출액(입금)');

    expect(salesRow).toBeTruthy();
    expect(salesRow).toEqual(['매출액(입금)', 1250]);
    expect(rows.find((row) => row[0] === '잔액')).toEqual([
      '잔액', 6250, 6250, 6250, 6250, 6250,
    ]);
    const salesRowNumber = worksheet.getSheetValues()
      .findIndex((row) => Array.isArray(row) && row[1] === '매출액(입금)');
    expect(worksheet.getCell(salesRowNumber, 7).value).toBeNull();
  });

  it('filters exported projects by accountType', async () => {
    await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-cashflow-project-002a' })
      .send({
        id: 'p-cashflow-002a',
        name: 'Dedicated Project',
        accountType: 'DEDICATED',
      });

    await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-cashflow-project-002b' })
      .send({
        id: 'p-cashflow-002b',
        name: 'Operating Project',
        accountType: 'OPERATING',
      });

    await db.doc(`orgs/${tenantId}/cashflow_weeks/p-cashflow-002a-2026-01-w1`).set({
      projectId: 'p-cashflow-002a',
      yearMonth: '2026-01',
      weekNo: 1,
      weekStart: '2025-12-31',
      weekEnd: '2026-01-06',
      projection: { SALES_IN: 700 },
      actual: { SALES_IN: 500 },
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });

    await db.doc(`orgs/${tenantId}/cashflow_weeks/p-cashflow-002b-2026-01-w1`).set({
      projectId: 'p-cashflow-002b',
      yearMonth: '2026-01',
      weekNo: 1,
      weekStart: '2025-12-31',
      weekEnd: '2026-01-06',
      projection: { SALES_IN: 900 },
      actual: { SALES_IN: 600 },
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });

    await db.doc(`orgs/${tenantId}/transactions/tx-cashflow-002a`).set({
      id: 'tx-cashflow-002a',
      projectId: 'p-cashflow-002a',
      dateTime: '2026-01-04',
      amount: 700,
      createdAt: '2026-01-04T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
    }, { merge: true });

    await seedCashflowExportMirror({
      targetProjectId: 'p-cashflow-002a',
      projectionAmount: 700,
      actualAmount: 500,
    });

    const response = await downloadCashflowExport({
      scope: 'all',
      accountType: 'DEDICATED',
      startYearMonth: '2024-01',
      endYearMonth: '2024-12',
      variant: 'multi-sheet',
    });

    expect(response.status).toBe(200);

    const workbook = await readWorkbook(response.body);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Dedicated Project']);

    const worksheet = workbook.getWorksheet('Dedicated Project');
    const rows = worksheet.getSheetValues().filter(Boolean).map((row) => (Array.isArray(row) ? row.slice(1) : []));
    expect(rows[0]).toEqual(['사업', 'Dedicated Project', '사업 ID', 'p-cashflow-002a', '거래 수', 0]);
    const salesRow = rows.find((row) => row[0] === '매출액(입금)');

    expect(salesRow).toEqual(['매출액(입금)', 700]);
    expect(rows.find((row) => row[0] === '항목')).toEqual(['항목', '2024']);
  });

  it('exports only the explicitly selected project ids', async () => {
    for (const [id, name] of [['p-selected-a', 'Selected A'], ['p-selected-b', 'Selected B']]) {
      await api
        .post('/api/v1/projects')
        .set({ ...defaultHeaders, 'idempotency-key': `idem-${id}` })
        .send({ id, name, accountType: 'NONE' });
    }
    await seedCashflowExportMirror({ targetProjectId: 'p-selected-b' });

    const response = await downloadCashflowExport({
      scope: 'all',
      projectIds: ['p-selected-b'],
      startYearMonth: '2026-01',
      endYearMonth: '2026-01',
      variant: 'multi-sheet',
    });

    expect(response.status).toBe(200);
    const workbook = await readWorkbook(response.body);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Selected B']);

    const mismatchedFilter = await downloadCashflowExport({
      scope: 'all',
      projectIds: ['p-selected-b'],
      accountType: 'DEDICATED',
      startYearMonth: '2026-01',
      endYearMonth: '2026-01',
      variant: 'multi-sheet',
    });
    expect(mismatchedFilter.status).toBe(404);
    expect(JSON.parse(mismatchedFilter.body.toString()).error).toBe('not_found');
  });

  it('cross-filters selected projects by canonical department and account types before sorting the workbook', async () => {
    const projects = [
      { id: 'p-cross-b', name: '가 사업', shortName: 'A-B', department: '센터B', accountType: 'OTHER' },
      { id: 'p-cross-a2', name: '나 사업', shortName: 'B-A2', department: '센터A', accountType: 'OTHER' },
      { id: 'p-cross-a1', name: '가 사업', shortName: 'C-A1', department: '센터A', accountType: 'DEDICATED' },
      { id: 'p-cross-account', name: '다 사업', shortName: 'D-ACCOUNT', department: '센터A', accountType: 'OPERATING' },
    ];
    for (const project of projects) {
      await db.doc(`orgs/${tenantId}/projects/${project.id}`).set(project);
    }
    await seedCashflowExportMirror({ targetProjectId: 'p-cross-a1' });
    await seedCashflowExportMirror({ targetProjectId: 'p-cross-a2' });

    const response = await downloadCashflowExport({
      scope: 'selected',
      projectIds: projects.map(({ id }) => id),
      department: '센터A',
      accountTypes: ['DEDICATED', 'OTHER'],
      sortBy: 'DEPARTMENT',
      startYearMonth: '2026-01',
      endYearMonth: '2026-01',
      variant: 'multi-sheet',
    });

    expect(response.status).toBe(200);
    expect(decodeURIComponent(response.headers['content-disposition'])).toContain('선택사업_개별시트');
    const workbook = await readWorkbook(response.body);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['C-A1', 'B-A2']);

    const missingProject = await downloadCashflowExport({
      scope: 'selected',
      projectIds: ['p-cross-a1', 'missing-project'],
      startYearMonth: '2026-01',
      endYearMonth: '2026-01',
      variant: 'multi-sheet',
    });
    expect(missingProject.status).toBe(404);
    expect(JSON.parse(missingProject.body.toString()).error).toBe('selected_project_not_found');
  });

  it('accepts legacy basis payloads for export requests', async () => {
    await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-cashflow-project-legacy-basis' })
      .send({
        id: 'p-cashflow-legacy-basis',
        name: 'Legacy Basis Project',
        basis: '공급가액',
        accountType: 'NONE',
      });
    await seedCashflowExportMirror({ targetProjectId: 'p-cashflow-legacy-basis' });

    const response = await downloadCashflowExport({
      scope: 'all',
      basis: '공급가액',
      startYearMonth: '2026-01',
      endYearMonth: '2026-01',
      variant: 'multi-sheet',
    });

    expect(response.status).toBe(200);
    const workbook = await readWorkbook(response.body);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Legacy Basis Project']);
  });

  it('enforces deterministic state transitions and version checks', async () => {
    await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-seed-project-003' })
      .send({ id: 'p-bff-003', name: 'Project 3' });

    await api
      .post('/api/v1/ledgers')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-seed-ledger-003' })
      .send({ id: 'l003', projectId: 'p-bff-003', name: 'Ledger 3' });

    await api
      .post('/api/v1/transactions')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-seed-tx-003' })
      .send({ id: 'tx003', projectId: 'p-bff-003', ledgerId: 'l003', counterparty: 'Vendor C' });

    const invalidTransition = await api
      .patch('/api/v1/transactions/tx003/state')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-state-invalid-003' })
      .send({ newState: 'APPROVED', expectedVersion: 1 });

    expect(invalidTransition.status).toBe(400);
    expect(invalidTransition.body.message).toMatch(/Invalid state transition/);

    const submitted = await api
      .patch('/api/v1/transactions/tx003/state')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-state-submit-003' })
      .send({ newState: 'SUBMITTED', expectedVersion: 1 });

    expect(submitted.status).toBe(200);
    expect(submitted.body.state).toBe('SUBMITTED');
    expect(submitted.body.version).toBe(2);

    const noReasonReject = await api
      .patch('/api/v1/transactions/tx003/state')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-state-reject-003a' })
      .send({ newState: 'REJECTED', expectedVersion: 2 });

    expect(noReasonReject.status).toBe(400);

    const rejected = await api
      .patch('/api/v1/transactions/tx003/state')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-state-reject-003b' })
      .send({ newState: 'REJECTED', expectedVersion: 2, reason: '증빙 부족' });

    expect(rejected.status).toBe(200);
    expect(rejected.body.state).toBe('REJECTED');
    expect(rejected.body.version).toBe(3);

    const staleVersion = await api
      .patch('/api/v1/transactions/tx003/state')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-state-resubmit-003a' })
      .send({ newState: 'SUBMITTED', expectedVersion: 2 });

    expect(staleVersion.status).toBe(409);
    expect(staleVersion.body.error).toBe('version_conflict');
  });

  it('creates and lists comments/evidences with immutable audit trail', async () => {
    await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-seed-project-004' })
      .send({ id: 'p-bff-004', name: 'Project 4' });

    await api
      .post('/api/v1/ledgers')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-seed-ledger-004' })
      .send({ id: 'l004', projectId: 'p-bff-004', name: 'Ledger 4' });

    await api
      .post('/api/v1/transactions')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-seed-tx-004' })
      .send({ id: 'tx004', projectId: 'p-bff-004', ledgerId: 'l004', counterparty: 'Vendor D' });

    const comment = await api
      .post('/api/v1/transactions/tx004/comments')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-comment-004' })
      .send({ content: '검토 요청', authorName: '관리자' });

    expect(comment.status).toBe(201);
    const transactionComment = await db.doc(`orgs/${tenantId}/comments/${comment.body.id}`).get();
    expect(transactionComment.data()).toMatchObject({
      projectId: 'p-bff-004',
      targetType: 'transaction',
    });

    const sheetRowComment = await api
      .post('/api/v1/transactions/sheet-row:row-004/comments')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-sheet-row-comment-004' })
      .send({
        content: '금액 확인',
        authorName: '관리자',
        projectId: 'p-bff-004',
        targetType: 'expense_sheet_row',
        sheetRowId: 'sheet-row:row-004',
        fieldKey: 'amount',
        fieldLabel: '금액',
      });

    expect(sheetRowComment.status).toBe(201);
    const savedSheetRowComment = await db.doc(`orgs/${tenantId}/comments/${sheetRowComment.body.id}`).get();
    expect(savedSheetRowComment.data()).toMatchObject({
      transactionId: 'sheet-row:row-004',
      projectId: 'p-bff-004',
      targetType: 'expense_sheet_row',
      sheetRowId: 'sheet-row:row-004',
      fieldKey: 'amount',
      fieldLabel: '금액',
    });

    const evidence = await api
      .post('/api/v1/transactions/tx004/evidences')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-evidence-004' })
      .send({
        fileName: 'invoice.pdf',
        fileType: 'application/pdf',
        fileSize: 32000,
        category: '세금계산서',
      });

    expect(evidence.status).toBe(201);

    const comments = await api
      .get('/api/v1/transactions/tx004/comments')
      .set(defaultHeaders);

    const evidences = await api
      .get('/api/v1/transactions/tx004/evidences')
      .set(defaultHeaders);

    expect(comments.status).toBe(200);
    expect(comments.body.count).toBe(1);
    expect(evidences.status).toBe(200);
    expect(evidences.body.count).toBe(1);

    const audits = await api
      .get('/api/v1/audit-logs')
      .set(defaultHeaders);

    expect(audits.status).toBe(200);
    expect(audits.body.count).toBeGreaterThanOrEqual(5);
    const ids = audits.body.items.map((item: any) => item.id);
    expect(new Set(ids).size).toBe(ids.length);

    const verify = await api
      .get('/api/v1/audit-logs/verify')
      .set(defaultHeaders);
    expect(verify.status).toBe(200);
    expect(verify.body.ok).toBe(true);
    expect(verify.body.checked).toBeGreaterThanOrEqual(5);
  });

  it('provisions and syncs evidence drive folders via injected drive service', async () => {
    const driveService = {
      getConfig: vi.fn(() => ({
        enabled: true,
        defaultParentFolderId: 'fld-company-root',
        sharedDriveId: 'shared-drive-001',
      })),
      ensureProjectRootFolder: vi.fn(async () => ({
        id: 'fld-project-root',
        name: 'Drive_Project_p-drive-001',
        webViewLink: 'https://drive.google.com/drive/folders/fld-project-root',
        driveId: 'shared-drive-001',
        mimeType: 'application/vnd.google-apps.folder',
      })),
      getFile: vi.fn(async (folderId: string) => ({
        id: folderId,
        name: 'Manual Root',
        webViewLink: `https://drive.google.com/drive/folders/${folderId}`,
        driveId: 'shared-drive-001',
        mimeType: 'application/vnd.google-apps.folder',
      })),
      ensureTransactionFolder: vi.fn(async () => ({
        projectRootFolder: {
          id: 'fld-project-root',
          name: 'Drive_Project_p-drive-001',
          webViewLink: 'https://drive.google.com/drive/folders/fld-project-root',
          driveId: 'shared-drive-001',
          mimeType: 'application/vnd.google-apps.folder',
        },
        folder: {
          id: 'fld-tx-root',
          name: '20260311_회의비_다과비_tx-drive-001',
          webViewLink: 'https://drive.google.com/drive/folders/fld-tx-root',
          driveId: 'shared-drive-001',
          mimeType: 'application/vnd.google-apps.folder',
        },
      })),
      listFolderFiles: vi.fn(async () => ([
        {
          id: 'file-tax-001',
          name: '세금계산서_3월.pdf',
          mimeType: 'application/pdf',
          size: 18000,
          webViewLink: 'https://drive.google.com/file/d/file-tax-001/view',
        },
        {
          id: 'file-transfer-001',
          name: '입금확인서_3월.pdf',
          mimeType: 'application/pdf',
          size: 9000,
          webViewLink: 'https://drive.google.com/file/d/file-transfer-001/view',
        },
      ])),
    };
    const driveApi = await createApi(createBffApp({ projectId, workerSecret, db, driveService }));

    const createdProject = await driveApi
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-project-drive-001' })
      .send({ id: 'p-drive-001', name: 'Drive Project' });

    expect(createdProject.status).toBe(201);
    expect(createdProject.body.evidenceDriveRootFolderId).toBe('fld-project-root');
    expect(driveService.ensureProjectRootFolder).toHaveBeenCalledWith(expect.objectContaining({
      tenantId,
      projectId: 'p-drive-001',
      projectName: 'Drive Project',
    }));

    await driveApi
      .post('/api/v1/ledgers')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-ledger-drive-001' })
      .send({ id: 'l-drive-001', projectId: 'p-drive-001', name: 'Drive Ledger' });

    await driveApi
      .post('/api/v1/transactions')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-tx-drive-001' })
      .send({
        id: 'tx-drive-001',
        projectId: 'p-drive-001',
        ledgerId: 'l-drive-001',
        counterparty: 'Vendor Drive',
        budgetCategory: '회의비',
        budgetSubCategory: '다과비',
        dateTime: '2026-03-11',
        evidenceRequired: ['세금계산서', '입금확인서'],
        evidenceStatus: 'MISSING',
        evidenceMissing: ['세금계산서', '입금확인서'],
        attachmentsCount: 0,
        state: 'DRAFT',
      });

    const projectRoot = await driveApi
      .post('/api/v1/projects/p-drive-001/evidence-drive/root/provision')
      .set({ ...defaultHeaders, 'x-actor-role': 'viewer', 'idempotency-key': 'idem-project-drive-root-001' })
      .send({});

    expect(projectRoot.status).toBe(200);
    expect(projectRoot.body.folderId).toBe('fld-project-root');

    const linkedRoot = await driveApi
      .post('/api/v1/projects/p-drive-001/evidence-drive/root/link')
      .set({ ...defaultHeaders, 'x-actor-role': 'viewer', 'idempotency-key': 'idem-project-drive-link-001' })
      .send({ value: 'https://drive.google.com/drive/folders/1GD5XnPypL-s6Jp44TJjRRd0nnP0Yu_sg?usp=share_link' });

    expect(linkedRoot.status).toBe(200);
    expect(linkedRoot.body.folderId).toBe('1GD5XnPypL-s6Jp44TJjRRd0nnP0Yu_sg');
    expect(driveService.getFile).toHaveBeenCalledWith('1GD5XnPypL-s6Jp44TJjRRd0nnP0Yu_sg');

    const txFolder = await driveApi
      .post('/api/v1/transactions/tx-drive-001/evidence-drive/provision')
      .set({ ...defaultHeaders, 'x-actor-role': 'viewer', 'idempotency-key': 'idem-tx-drive-provision-001' })
      .send({});

    expect(txFolder.status).toBe(200);
    expect(txFolder.body.folderId).toBe('fld-tx-root');
    expect(driveService.ensureTransactionFolder).toHaveBeenCalled();

    const sync = await driveApi
      .post('/api/v1/transactions/tx-drive-001/evidence-drive/sync')
      .set({ ...defaultHeaders, 'x-actor-role': 'viewer', 'idempotency-key': 'idem-tx-drive-sync-001' })
      .send({});

    expect(sync.status).toBe(200);
    expect(sync.body.evidenceCount).toBe(2);
    expect(sync.body.evidenceStatus).toBe('COMPLETE');
    expect(sync.body.evidenceCompletedDesc).toContain('세금계산서');

    const txSnap = await db.doc(`orgs/${tenantId}/transactions/tx-drive-001`).get();
    expect(txSnap.exists).toBe(true);
    expect(txSnap.data()?.evidenceDriveFolderId).toBe('fld-tx-root');
    expect(txSnap.data()?.evidenceAutoListedDesc).toBe('세금계산서, 입금확인서');
    expect(txSnap.data()?.evidenceMissing).toEqual([]);

    const projectSnap = await db.doc(`orgs/${tenantId}/projects/p-drive-001`).get();
    expect(projectSnap.data()?.evidenceDriveRootFolderId).toBe('fld-project-root');

    const evidenceSnap = await db
      .collection(`orgs/${tenantId}/evidences`)
      .where('transactionId', '==', 'tx-drive-001')
      .get();
    expect(evidenceSnap.size).toBe(2);
    expect(evidenceSnap.docs.map((doc) => doc.data().driveFileId).sort()).toEqual(['file-tax-001', 'file-transfer-001']);
  });

  it('creates project roots per project and uploads files with parser categories', async () => {
    const folderState = new Map<string, Array<any>>();
    const ensureProjectRootFolder = vi.fn(async ({ projectId, projectName }) => ({
      id: `fld-project-${projectId}`,
      name: `${projectName}_${projectId}`,
      webViewLink: `https://drive.google.com/drive/folders/fld-project-${projectId}`,
      driveId: 'shared-drive-001',
      mimeType: 'application/vnd.google-apps.folder',
    }));
    const ensureTransactionFolder = vi.fn(async ({ projectId, transaction }) => ({
      projectRootFolder: {
        id: `fld-project-${projectId}`,
        name: `Project_${projectId}`,
        webViewLink: `https://drive.google.com/drive/folders/fld-project-${projectId}`,
        driveId: 'shared-drive-001',
        mimeType: 'application/vnd.google-apps.folder',
      },
      folder: {
        id: `fld-${transaction.id}`,
        name: `${transaction.id}_folder`,
        webViewLink: `https://drive.google.com/drive/folders/fld-${transaction.id}`,
        driveId: 'shared-drive-001',
        mimeType: 'application/vnd.google-apps.folder',
      },
    }));
    const driveService = {
      getConfig: vi.fn(() => ({
        enabled: true,
        defaultParentFolderId: 'fld-company-root',
        sharedDriveId: 'shared-drive-001',
      })),
      ensureProjectRootFolder,
      getFile: vi.fn(),
      ensureTransactionFolder,
      uploadFileToFolder: vi.fn(async ({ folderId, fileName, mimeType, appProperties }) => {
        const fileId = `drv-${folderId}-${folderState.get(folderId)?.length || 0}`;
        const uploaded = {
          id: fileId,
          name: fileName,
          mimeType,
          size: 1024,
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
          parents: [folderId],
          driveId: 'shared-drive-001',
          appProperties,
        };
        folderState.set(folderId, [...(folderState.get(folderId) || []), uploaded]);
        return uploaded;
      }),
      listFolderFiles: vi.fn(async ({ folderId }) => folderState.get(folderId) || []),
    };
    const driveApi = await createApi(createBffApp({ projectId, workerSecret, db, driveService }));

    for (const project of [
      { id: 'p-upload-001', name: '온드림 교육사업' },
      { id: 'p-upload-002', name: '체인지메이커 운영사업' },
    ]) {
      const createdProject = await driveApi
        .post('/api/v1/projects')
        .set({ ...defaultHeaders, 'idempotency-key': `idem-project-${project.id}` })
        .send(project);

      expect(createdProject.status).toBe(201);
      expect(createdProject.body.evidenceDriveRootFolderId).toBe(`fld-project-${project.id}`);
    }

    expect(ensureProjectRootFolder).toHaveBeenCalledTimes(2);

    await driveApi
      .post('/api/v1/ledgers')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-ledger-upload-001' })
      .send({ id: 'l-upload-001', projectId: 'p-upload-001', name: 'Upload Ledger' });

    await driveApi
      .post('/api/v1/transactions')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-tx-upload-001' })
      .send({
        id: 'tx-upload-001',
        projectId: 'p-upload-001',
        ledgerId: 'l-upload-001',
        counterparty: 'Zoom',
        budgetCategory: '교육운영비',
        budgetSubCategory: '강의자료',
        dateTime: '2026-03-11',
        evidenceRequired: ['강의자료', 'ZOOM invoice'],
        evidenceStatus: 'MISSING',
        evidenceMissing: ['강의자료', 'ZOOM invoice'],
        attachmentsCount: 0,
        state: 'DRAFT',
      });

    const firstUpload = await driveApi
      .post('/api/v1/transactions/tx-upload-001/evidence-drive/upload')
      .set({ ...defaultHeaders, 'x-actor-role': 'viewer', 'idempotency-key': 'idem-upload-file-001' })
      .send({
        fileName: '강의자료_1차시.pdf',
        mimeType: 'application/pdf',
        fileSize: 1024,
        contentBase64: 'ZmFrZS1wZGY=',
      });

    expect(firstUpload.status).toBe(201);
    expect(firstUpload.body.parserCategory).toBe('강의자료');
    expect(firstUpload.body.evidenceCompletedDesc).toBe('강의자료');
    expect(firstUpload.body.evidencePendingDesc).toBe('ZOOM invoice');

    const secondUpload = await driveApi
      .post('/api/v1/transactions/tx-upload-001/evidence-drive/upload')
      .set({ ...defaultHeaders, 'x-actor-role': 'viewer', 'idempotency-key': 'idem-upload-file-002' })
      .send({
        fileName: 'ZOOM invoice March.pdf',
        mimeType: 'application/pdf',
        fileSize: 2048,
        contentBase64: 'ZmFrZS16b29tLXBkZg==',
      });

    expect(secondUpload.status).toBe(201);
    expect(secondUpload.body.parserCategory).toBe('ZOOM invoice');
    expect(secondUpload.body.evidenceStatus).toBe('COMPLETE');
    expect(secondUpload.body.evidenceCompletedDesc).toContain('강의자료');
    expect(secondUpload.body.evidenceCompletedDesc).toContain('ZOOM invoice');

    const evidenceSnap = await db
      .collection(`orgs/${tenantId}/evidences`)
      .where('transactionId', '==', 'tx-upload-001')
      .get();

    expect(evidenceSnap.size).toBe(2);
    expect(evidenceSnap.docs.map((doc) => doc.data().parserCategory).sort()).toEqual(['ZOOM invoice', '강의자료']);
  });

  it('detects tampering in audit hash chain', async () => {
    await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-seed-project-audit' })
      .send({ id: 'p-audit-001', name: 'Audit Project' });

    await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-seed-project-audit-2' })
      .send({ id: 'p-audit-001', name: 'Audit Project v2', expectedVersion: 1 });

    const verifyBefore = await api
      .get('/api/v1/audit-logs/verify')
      .set(defaultHeaders);
    expect(verifyBefore.status).toBe(200);
    expect(verifyBefore.body.ok).toBe(true);

    const firstAudit = await db
      .collection(`orgs/${tenantId}/audit_logs`)
      .orderBy('chainSeq', 'asc')
      .limit(1)
      .get();
    expect(firstAudit.empty).toBe(false);
    await firstAudit.docs[0].ref.set({ details: 'tampered' }, { merge: true });

    const verifyAfter = await api
      .get('/api/v1/audit-logs/verify')
      .set(defaultHeaders);
    expect(verifyAfter.status).toBe(409);
    expect(verifyAfter.body.ok).toBe(false);
    expect(verifyAfter.body.reason).toBe('hash_mismatch');
  });

  it('handles high concurrency with exactly one successful state transition per version', async () => {
    await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-seed-project-race' })
      .send({ id: 'p-race-001', name: 'Race Project' });

    await api
      .post('/api/v1/ledgers')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-seed-ledger-race' })
      .send({ id: 'l-race-001', projectId: 'p-race-001', name: 'Race Ledger' });

    await api
      .post('/api/v1/transactions')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-seed-tx-race' })
      .send({ id: 'tx-race-001', projectId: 'p-race-001', ledgerId: 'l-race-001', counterparty: 'Race Vendor' });

    const workers = Array.from({ length: 25 }, (_, idx) => (
      api
        .patch('/api/v1/transactions/tx-race-001/state')
        .set({ ...defaultHeaders, 'idempotency-key': `idem-race-${idx}` })
        .send({ newState: 'SUBMITTED', expectedVersion: 1 })
    ));

    const responses = await Promise.all(workers);
    const successCount = responses.filter((r) => r.status === 200).length;
    const conflictCount = responses.filter((r) => r.status === 409 && r.body.error === 'version_conflict').length;

    expect(successCount).toBe(1);
    expect(conflictCount).toBe(24);

    const stored = await db.doc(`orgs/${tenantId}/transactions/tx-race-001`).get();
    expect(stored.data()).toMatchObject({ state: 'SUBMITTED', version: 2 });

    const stateChangeEvents = await db.collection('outbox')
      .where('eventType', '==', 'transaction.state_changed')
      .where('entityId', '==', 'tx-race-001')
      .get();
    expect(stateChangeEvents.size).toBe(1);
  });

  it('audits member role changes and blocks unauthorized actor role', async () => {
    await db.doc(`orgs/${tenantId}/members/u-target`).set({
      uid: 'u-target',
      tenantId,
      role: 'viewer',
      status: 'ACTIVE',
      email: 'target@example.com',
      updatedAt: new Date().toISOString(),
    });
    await db.doc(`orgs/${tenantId}/persons/person-target`).set({
      personId: 'person-target',
      uid: 'u-target',
      name: 'Target User',
    });

    const forbidden = await api
      .patch('/api/v1/members/u-target/role')
      .set({ ...defaultHeaders, 'x-actor-role': 'pm', 'idempotency-key': 'idem-role-pm-deny' })
      .send({ role: 'finance', reason: 'test' });

    expect(forbidden.status).toBe(403);

    const missingReason = await api
      .patch('/api/v1/members/u-target/role')
      .set({ ...defaultHeaders, 'x-actor-role': 'admin', 'idempotency-key': 'idem-role-reason-required' })
      .send({ role: 'finance' });

    expect(missingReason.status).toBe(400);
    expect(missingReason.body.error).toBe('role_change_reason_required');

    const changed = await api
      .patch('/api/v1/members/u-target/role')
      .set({ ...defaultHeaders, 'x-actor-role': 'admin', 'idempotency-key': 'idem-role-admin-allow' })
      .send({ role: 'finance', reason: 'quarter close' });

    expect(changed.status).toBe(200);
    expect(changed.body.previousRole).toBe('pm');
    expect(changed.body.role).toBe('finance');

    const memberSnap = await db.doc(`orgs/${tenantId}/members/u-target`).get();
    expect(memberSnap.data()?.role).toBe('finance');

    const auditSnap = await db
      .collection(`orgs/${tenantId}/audit_logs`)
      .where('entityType', '==', 'member')
      .limit(5)
      .get();
    const roleChangeLog = auditSnap.docs.map((doc) => doc.data()).find((item: any) => item.action === 'ROLE_CHANGE');
    expect(roleChangeLog).toBeTruthy();
  });

  it('changes roles only for one exact ACTIVE member/People UID pair', async () => {
    await db.doc(`orgs/${tenantId}/members/legacy-target`).set({
      uid: 'canonical-target', tenantId, role: 'pm', status: 'ACTIVE',
    });
    await db.doc(`orgs/${tenantId}/persons/person-canonical-target`).set({
      personId: 'person-canonical-target', uid: 'canonical-target', name: 'Canonical Target',
    });

    const mismatched = await api
      .patch('/api/v1/members/legacy-target/role')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-role-exact-uid' })
      .send({ role: 'finance', reason: 'exact UID guard' });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.error).toBe('member_uid_invalid');

    await db.doc(`orgs/${tenantId}/members/unlinked-target`).set({
      uid: 'unlinked-target', tenantId, role: 'pm', status: 'ACTIVE',
    });
    const unlinked = await api
      .patch('/api/v1/members/unlinked-target/role')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-role-unlinked-uid' })
      .send({ role: 'finance', reason: 'People link required' });
    expect(unlinked.status).toBe(409);
    expect(unlinked.body.error).toBe('people_uid_unlinked');

    await db.doc(`orgs/${tenantId}/members/ambiguous-target`).set({
      uid: 'ambiguous-target', tenantId, role: 'pm', status: 'ACTIVE',
    });
    await db.doc(`orgs/${tenantId}/persons/person-ambiguous-a`).set({
      personId: 'person-ambiguous-a', uid: 'ambiguous-target', name: 'Ambiguous A',
    });
    await db.doc(`orgs/${tenantId}/persons/person-ambiguous-b`).set({
      personId: 'person-ambiguous-b', uid: 'ambiguous-target', name: 'Ambiguous B',
    });
    const ambiguous = await api
      .patch('/api/v1/members/ambiguous-target/role')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-role-ambiguous-uid' })
      .send({ role: 'finance', reason: 'People link must be unique' });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error).toBe('people_uid_ambiguous');
  });

  it('rejects role mutation when the acting admin People UID is absent or ambiguous', async () => {
    await db.doc(`orgs/${tenantId}/members/actor-people-target`).set({
      uid: 'actor-people-target', tenantId, role: 'pm', status: 'ACTIVE',
    });
    await db.doc(`orgs/${tenantId}/persons/person-actor-people-target`).set({
      personId: 'person-actor-people-target', uid: 'actor-people-target', name: 'Actor People Target',
    });
    await db.doc(`orgs/${tenantId}/persons/person-${actorId}`).delete();

    const absent = await api
      .patch('/api/v1/members/actor-people-target/role')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-role-actor-people-absent' })
      .send({ role: 'finance', reason: 'actor People UID required' });

    expect(absent.status).toBe(403);
    expect(absent.body.error).toBe('member_authority_required');

    await db.doc(`orgs/${tenantId}/persons/person-actor-a`).set({
      personId: 'person-actor-a', uid: actorId, name: 'Actor A',
    });
    await db.doc(`orgs/${tenantId}/persons/person-actor-b`).set({
      personId: 'person-actor-b', uid: actorId, name: 'Actor B',
    });

    const ambiguousActor = await api
      .patch('/api/v1/members/actor-people-target/role')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-role-actor-people-ambiguous' })
      .send({ role: 'finance', reason: 'actor People UID must be unique' });

    expect(ambiguousActor.status).toBe(403);
    expect(ambiguousActor.body.error).toBe('member_authority_required');
    const target = await db.doc(`orgs/${tenantId}/members/actor-people-target`).get();
    expect(target.data()?.role).toBe('pm');
  });

  it('uses member fallback for firebase auth when token role is missing and ignores spoofed header role', async () => {
    await db.doc(`orgs/${tenantId}/members/u-firebase-roleless`).set({
      uid: 'u-firebase-roleless',
      tenantId,
      role: 'pm',
      status: 'ACTIVE',
      email: 'roleless@mysc.co.kr',
      updatedAt: new Date().toISOString(),
    });
    await db.doc(`orgs/${tenantId}/persons/person-firebase-roleless`).set({
      personId: 'person-firebase-roleless',
      uid: 'u-firebase-roleless',
      name: 'Firebase Roleless User',
    });

    await db.doc(`orgs/${tenantId}/members/u-target`).set({
      uid: 'u-target',
      tenantId,
      role: 'viewer',
      status: 'ACTIVE',
      email: 'target@example.com',
      updatedAt: new Date().toISOString(),
    });
    await db.doc(`orgs/${tenantId}/persons/person-target`).set({
      personId: 'person-target',
      uid: 'u-target',
      name: 'Target User',
    });

    const firebaseApi = await createApi(createBffApp({
      projectId,
      workerSecret,
      db,
      authMode: 'firebase_required',
      tokenVerifier: async () => ({
        uid: 'u-firebase-roleless',
        tenantId,
        email: 'roleless@mysc.co.kr',
      }),
    }));

    const denied = await firebaseApi
      .patch('/api/v1/members/u-target/role')
      .set({
        authorization: 'Bearer firebase-token',
        'x-tenant-id': tenantId,
        'x-actor-id': 'u-firebase-roleless',
        'x-actor-role': 'admin',
        'x-actor-email': 'spoofed@mysc.co.kr',
        'idempotency-key': 'idem-firebase-roleless-denied',
      })
      .send({ role: 'finance', reason: 'spoofed header should not escalate' });

    expect(denied.status).toBe(403);

    await db.doc(`orgs/${tenantId}/members/u-firebase-roleless`).set({
      role: 'admin',
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    const allowed = await firebaseApi
      .patch('/api/v1/members/u-target/role')
      .set({
        authorization: 'Bearer firebase-token',
        'x-tenant-id': tenantId,
        'x-actor-id': 'u-firebase-roleless',
        'x-actor-role': 'pm',
        'x-actor-email': 'spoofed@mysc.co.kr',
        'idempotency-key': 'idem-firebase-roleless-allowed',
      })
      .send({ role: 'finance', reason: 'member fallback admin should allow' });

    expect(allowed.status).toBe(200);
    expect(allowed.body.role).toBe('finance');

    await db.doc(`orgs/${tenantId}/members/u-firebase-roleless`).set({
      status: 'INACTIVE',
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    const revoked = await firebaseApi
      .get('/api/v1/persons')
      .set({
        authorization: 'Bearer firebase-token',
        'x-tenant-id': tenantId,
        'x-actor-id': 'u-firebase-roleless',
      });

    expect(revoked.status).toBe(403);
    expect(revoked.body.error).toBe('member_inactive');

    for (const invalidStatus of ['', null, 7, 'active', ' ACTIVE ']) {
      await db.doc(`orgs/${tenantId}/members/u-firebase-roleless`).set({
        status: invalidStatus,
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      const malformed = await firebaseApi
        .get('/api/v1/persons')
        .set({
          authorization: 'Bearer firebase-token',
          'x-tenant-id': tenantId,
          'x-actor-id': 'u-firebase-roleless',
        });

      expect(malformed.status).toBe(403);
      expect(malformed.body.error).toBe('member_inactive');
    }

    await db.doc(`orgs/${tenantId}/members/u-firebase-roleless`).set({
      uid: 'u-firebase-roleless',
      tenantId,
      role: 'admin',
      email: 'roleless@mysc.co.kr',
      updatedAt: new Date().toISOString(),
    });
    const legacyStatus = await firebaseApi
      .get('/api/v1/persons')
      .set({
        authorization: 'Bearer firebase-token',
        'x-tenant-id': tenantId,
        'x-actor-id': 'u-firebase-roleless',
      });
    expect(legacyStatus.status).toBe(200);

    const missingMemberApi = await createApi(createBffApp({
      projectId,
      workerSecret,
      db,
      authMode: 'firebase_required',
      tokenVerifier: async () => ({
        uid: 'u-former-finance',
        tenantId,
        role: 'finance',
        email: 'former-finance@mysc.co.kr',
      }),
    }));
    const missingMember = await missingMemberApi
      .get('/api/v1/persons')
      .set({
        authorization: 'Bearer firebase-token',
        'x-tenant-id': tenantId,
        'x-actor-id': 'u-former-finance',
      });

    expect(missingMember.status).toBe(403);
    expect(missingMember.body.error).toBe('member_inactive');
  });

  it('lists auth governance rows merged from auth users and member docs', async () => {
    await db.doc(`orgs/${tenantId}/members/jslee_mysc_co_kr`).set({
      uid: 'jslee_mysc_co_kr',
      tenantId,
      role: 'admin',
      email: 'jslee@mysc.co.kr',
      name: 'Legacy JS',
    });
    await db.doc(`orgs/${tenantId}/members/u-jslee`).set({
      uid: 'u-jslee',
      tenantId,
      role: 'pm',
      email: 'jslee@mysc.co.kr',
      name: 'Canonical JS',
      status: 'ACTIVE',
      projectIds: ['p-governance'],
    });
    await db.doc(`orgs/${tenantId}/projects/p-governance`).set({
      id: 'p-governance',
      name: '권한 점검 사업',
      executiveApproverId: 'u-jslee',
    });

    const governanceApi = await createApi(createBffApp({
      projectId,
      workerSecret,
      db,
      authAdminService: {
        listUsers: async () => ({
          users: [{
            uid: 'u-jslee',
            email: 'jslee@mysc.co.kr',
            displayName: 'JS Lee',
            disabled: false,
            customClaims: { role: 'pm', tenantId },
          }],
        }),
      },
    }));

    const response = await governanceApi
      .get('/api/v1/admin/auth-governance/users')
      .set(defaultHeaders);

    expect(response.status).toBe(200);
    const row = response.body.items.find((item: any) => item.email === 'jslee@mysc.co.kr');
    expect(row).toBeTruthy();
    expect(row).toMatchObject({
      authUid: 'u-jslee',
      effectiveRole: 'pm',
      driftFlags: expect.arrayContaining(['duplicate_member_docs', 'legacy_role_mismatch']),
      permissionOverview: {
        isActive: true,
        accessibleProjects: [{ id: 'p-governance', name: '권한 점검 사업' }],
        organizationHeadProjects: [{ id: 'p-governance', name: '권한 점검 사업' }],
        canRequestCashflowClose: true,
        canApproveProjectRegistration: true,
        canDecideCashflowReopen: true,
      },
    });
    expect(response.body.summary.duplicateMemberDocs).toBeGreaterThanOrEqual(1);
  });

  it('deep syncs canonical member, legacy member, and custom claims together', async () => {
    await db.doc(`orgs/${tenantId}/members/jhsong_mysc_co_kr`).set({
      uid: 'jhsong_mysc_co_kr',
      tenantId,
      role: 'pm',
      email: 'jhsong@mysc.co.kr',
      name: 'Legacy Song',
      status: 'ACTIVE',
      projectIds: ['p-sync-1'],
    });
    await db.doc(`orgs/${tenantId}/persons/person-jhsong`).set({
      personId: 'person-jhsong', uid: 'u-jhsong', name: '송지현',
    });

    const setCustomUserClaims = vi.fn(async () => {});
    const governanceApi = await createApi(createBffApp({
      projectId,
      workerSecret,
      db,
      authAdminService: {
        listUsers: async () => ({
          users: [{
            uid: 'u-jhsong',
            email: 'jhsong@mysc.co.kr',
            displayName: 'JH Song',
            disabled: false,
            customClaims: { role: 'pm', tenantId },
          }],
        }),
        setCustomUserClaims,
      },
    }));

    const response = await governanceApi
      .post('/api/v1/admin/auth-governance/users/jhsong%40mysc.co.kr/deep-sync')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-auth-governance-sync-001' })
      .send({ role: 'admin', reason: 'cashflow export alignment' });

    expect(response.status).toBe(200);
    expect(response.body.role).toBe('admin');
    expect(response.body.mirroredLegacyCount).toBe(1);

    const canonicalSnap = await db.doc(`orgs/${tenantId}/members/u-jhsong`).get();
    expect(canonicalSnap.data()).toMatchObject({
      uid: 'u-jhsong',
      email: 'jhsong@mysc.co.kr',
      role: 'admin',
      projectIds: ['p-sync-1'],
    });

    const legacySnap = await db.doc(`orgs/${tenantId}/members/jhsong_mysc_co_kr`).get();
    expect(legacySnap.data()).toMatchObject({
      role: 'admin',
      canonicalUid: 'u-jhsong',
    });

    expect(setCustomUserClaims).toHaveBeenCalledWith('u-jhsong', { role: 'admin', tenantId });
  });

  it('blocks demoting the last remaining admin (lockout protection)', async () => {
    // This scenario predates the shared ACTIVE actor fixture above and must begin
    // with exactly one persisted admin to exercise the lockout invariant.
    await db.doc(`orgs/${tenantId}/members/${actorId}`).delete();
    await db.doc(`orgs/${tenantId}/members/u-admin-1`).set({
      uid: 'u-admin-1',
      tenantId,
      role: 'admin',
      status: 'ACTIVE',
      email: 'admin1@example.com',
      updatedAt: new Date().toISOString(),
    });
    await db.doc(`orgs/${tenantId}/persons/person-admin-1`).set({
      personId: 'person-admin-1', uid: 'u-admin-1', name: 'Admin One',
    });
    await db.doc(`orgs/${tenantId}/members/inactive-admin`).set({
      uid: 'inactive-admin', tenantId, role: 'admin', status: 'INACTIVE',
    });
    await db.doc(`orgs/${tenantId}/members/invalid-admin-doc`).set({
      uid: 'different-uid', tenantId, role: 'admin', status: 'ACTIVE',
    });

    const denied = await api
      .patch('/api/v1/members/u-admin-1/role')
      .set({
        ...defaultHeaders,
        'x-actor-id': 'u-admin-1',
        'x-actor-role': 'admin',
        'idempotency-key': 'idem-last-admin-demote',
      })
      .send({ role: 'viewer', reason: 'test lockout prevention' });

    expect(denied.status).toBe(409);
    expect(denied.body.error).toBe('last_admin_lockout');

    await db.doc(`orgs/${tenantId}/members/u-admin-2`).set({
      uid: 'u-admin-2',
      tenantId,
      role: 'admin',
      status: 'ACTIVE',
      email: 'admin2@example.com',
      updatedAt: new Date().toISOString(),
    });
    await db.doc(`orgs/${tenantId}/persons/person-admin-2`).set({
      personId: 'person-admin-2', uid: 'u-admin-2', name: 'Admin Two',
    });

    const ok = await api
      .patch('/api/v1/members/u-admin-2/role')
      .set({
        ...defaultHeaders,
        'x-actor-id': 'u-admin-1',
        'x-actor-role': 'admin',
        'idempotency-key': 'idem-second-admin-demote',
      })
      .send({ role: 'viewer', reason: 'leaving one admin' });

    expect(ok.status).toBe(200);
    expect(ok.body.previousRole).toBe('admin');
    expect(ok.body.role).toBe('pm');
  });

  it('enforces permission-level RBAC for transaction state changes (submit vs approve)', async () => {
    await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-perm-project-001' })
      .send({ id: 'p-perm-001', name: 'Permission Project' });

    await api
      .post('/api/v1/ledgers')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-perm-ledger-001' })
      .send({ id: 'l-perm-001', projectId: 'p-perm-001', name: 'Permission Ledger' });

    await api
      .post('/api/v1/transactions')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-perm-tx-001' })
      .send({ id: 'tx-perm-001', projectId: 'p-perm-001', ledgerId: 'l-perm-001', counterparty: 'Vendor' });

    const submitted = await api
      .patch('/api/v1/transactions/tx-perm-001/state')
      .set({ ...defaultHeaders, 'x-actor-role': 'pm', 'idempotency-key': 'idem-perm-submit-001' })
      .send({ newState: 'SUBMITTED', expectedVersion: 1 });

    expect(submitted.status).toBe(200);
    expect(submitted.body.state).toBe('SUBMITTED');

    const deniedApprove = await api
      .patch('/api/v1/transactions/tx-perm-001/state')
      .set({ ...defaultHeaders, 'x-actor-role': 'pm', 'idempotency-key': 'idem-perm-approve-deny-001' })
      .send({ newState: 'APPROVED', expectedVersion: 2 });

    expect(deniedApprove.status).toBe(403);
    expect(deniedApprove.body.error).toBe('forbidden');

    const approved = await api
      .patch('/api/v1/transactions/tx-perm-001/state')
      .set({ ...defaultHeaders, 'x-actor-role': 'finance', 'idempotency-key': 'idem-perm-approve-allow-001' })
      .send({ newState: 'APPROVED', expectedVersion: 2 });

    expect(approved.status).toBe(200);
    expect(approved.body.state).toBe('APPROVED');
  });

  it('enforces audit-read RBAC and requires legacy viewers to use private registration drafts', async () => {
    const deniedAudit = await api
      .get('/api/v1/audit-logs')
      .set({ ...defaultHeaders, 'x-actor-role': 'pm' });

    expect(deniedAudit.status).toBe(403);
    expect(deniedAudit.body.error).toBe('forbidden');

    const viewerWrite = await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'x-actor-role': 'viewer', 'idempotency-key': 'idem-rbac-viewer-write' })
      .send({ id: 'p-rbac-viewer-write', name: 'Viewer Project' });

    expect(viewerWrite.status).toBe(403);
    expect(viewerWrite.body.error).toBe('project_registration_draft_required');
  });

  it('writes through generic pipeline without mutating canonical cashflow weeks', async () => {
    const createProject = await api
      .post('/api/v1/write')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-gw-project-001' })
      .send({
        entityType: 'project',
        entityId: 'p-gw-001',
        patch: {
          id: 'p-gw-001',
          name: 'Pipeline Project',
        },
      });

    expect(createProject.status).toBe(201);
    expect(createProject.body.eventId).toBeTruthy();
    expect(createProject.body.affectedViews).toContain('project_financials');

    const createLedger = await api
      .post('/api/v1/write')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-gw-ledger-001' })
      .send({
        entityType: 'ledger',
        entityId: 'l-gw-001',
        patch: {
          id: 'l-gw-001',
          projectId: 'p-gw-001',
          name: 'Pipeline Ledger',
        },
      });
    expect(createLedger.status).toBe(201);

    const createTx = await api
      .post('/api/v1/write')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-gw-tx-001' })
      .send({
        entityType: 'transaction',
        entityId: 'tx-gw-001',
        patch: {
          id: 'tx-gw-001',
          projectId: 'p-gw-001',
          ledgerId: 'l-gw-001',
          counterparty: 'Pipeline Vendor',
          direction: 'OUT',
          state: 'SUBMITTED',
          amounts: {
            bankAmount: 150000,
          },
          submittedBy: actorId,
          submittedAt: '2026-02-14T12:00:00.000Z',
        },
      });

    expect(createTx.status).toBe(201);
    expect(createTx.body.affectedViews).toContain('approval_inbox');
    expect(createTx.body.affectedViews).not.toContain('cashflow_weeks');

    const createApprovedTx = await api
      .post('/api/v1/write')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-gw-tx-approved-001' })
      .send({
        entityType: 'transaction',
        entityId: 'tx-gw-approved-001',
        patch: {
          id: 'tx-gw-approved-001',
          projectId: 'p-gw-001',
          ledgerId: 'l-gw-001',
          counterparty: 'Pipeline Client',
          dateTime: '2026-02-16',
          direction: 'IN',
          state: 'APPROVED',
          cashflowCategory: 'CONTRACT_PAYMENT',
          amounts: {
            bankAmount: 250000,
          },
        },
      });

    expect(createApprovedTx.status).toBe(201);
    expect(createApprovedTx.body.affectedViews).not.toContain('cashflow_weeks');

    const cashflowWeek = await db.doc(`orgs/${tenantId}/cashflow_weeks/p-gw-001-2026-02-w3`).get();
    expect(cashflowWeek.exists).toBe(false);

    const financials = await api
      .get('/api/v1/views/project_financials?projectId=p-gw-001')
      .set(defaultHeaders);
    expect(financials.status).toBe(200);
    expect(financials.body.item).toBeTruthy();
    expect(financials.body.item.projectId).toBe('p-gw-001');

    const inbox = await api
      .get('/api/v1/views/approval_inbox')
      .set(defaultHeaders);
    expect(inbox.status).toBe(200);
    expect(inbox.body.totalPending).toBeGreaterThanOrEqual(1);
    const hasTx = (inbox.body.items || []).some((item: any) => item.itemId === 'tx-gw-001');
    expect(hasTx).toBe(true);

    const queueJobs = await api
      .get('/api/v1/queue/jobs?eventId=' + encodeURIComponent(createTx.body.eventId))
      .set(defaultHeaders);
    expect(queueJobs.status).toBe(200);
    expect(queueJobs.body.count).toBeGreaterThanOrEqual(1);
  });

  it('replays queue jobs from a change event', async () => {
    const write = await api
      .post('/api/v1/write')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-gw-replay-seed' })
      .send({
        entityType: 'member',
        entityId: 'u-replay-001',
        patch: {
          id: 'u-replay-001',
          name: 'Replay User',
          role: 'pm',
          email: 'replay@example.com',
        },
      });

    expect(write.status).toBe(201);
    expect(write.body.eventId).toBeTruthy();

    const replay = await api
      .post(`/api/v1/queue/replay/${write.body.eventId}`)
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-gw-replay-run' })
      .send({});

    expect(replay.status).toBe(200);
    expect(replay.body.queued).toBeGreaterThanOrEqual(1);

    const jobs = await api
      .get('/api/v1/queue/jobs?eventId=' + encodeURIComponent(write.body.eventId))
      .set(defaultHeaders);
    expect(jobs.status).toBe(200);
    expect(jobs.body.count).toBeGreaterThanOrEqual(1);
  });

  it('rejects internal worker endpoints without a valid secret', async () => {
    const deniedQueue = await api
      .post('/api/internal/workers/work-queue/run')
      .send({});
    expect(deniedQueue.status).toBe(401);
    expect(deniedQueue.body.error).toBe('unauthorized_worker');

    const deniedOutbox = await api
      .post('/api/internal/workers/outbox/run')
      .send({});
    expect(deniedOutbox.status).toBe(401);
    expect(deniedOutbox.body.error).toBe('unauthorized_worker');

    // Vercel Cron invokes worker endpoints via HTTP GET.
    const deniedQueueGet = await api
      .get('/api/internal/workers/work-queue/run');
    expect(deniedQueueGet.status).toBe(401);
    expect(deniedQueueGet.body.error).toBe('unauthorized_worker');

    const deniedOutboxGet = await api
      .get('/api/internal/workers/outbox/run');
    expect(deniedOutboxGet.status).toBe(401);
    expect(deniedOutboxGet.body.error).toBe('unauthorized_worker');
  });

  it('processes work queue jobs through internal worker endpoint', async () => {
    const write = await api
      .post('/api/v1/write')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-worker-queue-seed' })
      .send({
        entityType: 'project',
        entityId: 'p-worker-queue-001',
        patch: {
          id: 'p-worker-queue-001',
          name: 'Queue Worker Seed',
        },
        options: {
          sync: false,
        },
      });

    expect(write.status).toBe(201);
    expect(write.body.eventId).toBeTruthy();

    const runQueue = await api
      .get('/api/internal/workers/work-queue/run')
      .set('authorization', `Bearer ${workerSecret}`)
      .query({ tenantId, eventId: write.body.eventId });

    expect(runQueue.status).toBe(200);
    expect(runQueue.body.ok).toBe(true);
    expect(runQueue.body.worker).toBe('work_queue');
    expect(runQueue.body.processed).toBeGreaterThanOrEqual(1);

    const jobs = await api
      .get(`/api/v1/queue/jobs?eventId=${encodeURIComponent(write.body.eventId)}`)
      .set(defaultHeaders);

    expect(jobs.status).toBe(200);
    expect(jobs.body.count).toBeGreaterThanOrEqual(1);
    const allDone = (jobs.body.items || []).every((item: any) => item.status === 'DONE');
    expect(allDone).toBe(true);
  });

  it('processes outbox events through internal worker endpoint', async () => {
    const createProject = await api
      .post('/api/v1/projects')
      .set({ ...defaultHeaders, 'idempotency-key': 'idem-worker-outbox-seed' })
      .send({
        id: 'p-worker-outbox-001',
        name: 'Outbox Worker Seed',
      });
    expect(createProject.status).toBe(201);

    const pendingBefore = await db
      .collection('outbox')
      .where('status', '==', 'PENDING')
      .limit(5)
      .get();
    expect(pendingBefore.empty).toBe(false);

    const runOutbox = await api
      .get('/api/internal/workers/outbox/run')
      .set('authorization', `Bearer ${workerSecret}`);

    expect(runOutbox.status).toBe(200);
    expect(runOutbox.body.ok).toBe(true);
    expect(runOutbox.body.worker).toBe('outbox');
    expect(runOutbox.body.processed).toBeGreaterThanOrEqual(1);
    expect(runOutbox.body.succeeded).toBeGreaterThanOrEqual(1);

    const doneAfter = await db
      .collection('outbox')
      .where('status', '==', 'DONE')
      .limit(5)
      .get();
    expect(doneAfter.empty).toBe(false);
  });
});
