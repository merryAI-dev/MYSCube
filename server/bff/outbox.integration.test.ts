import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFirestoreDb } from './firestore.mjs';
import {
  DRAFT_ATTACHMENT_CLEANUP_EVENT_TYPE,
  createOutboxEvent,
  enqueueOutboxEvent,
  processOutboxBatch,
} from './outbox.mjs';
import { buildNotificationId } from './notifications.mjs';
import { createProjectRegistrationSubmittedOutboxHandler } from './routes/projects.mjs';

const describeIfEmulator = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

describeIfEmulator('outbox worker integration (Firestore emulator)', () => {
  const projectId = 'demo-bff-outbox-it';
  const tenantId = 'mysc';
  const db = createFirestoreDb({ projectId });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((next) => { resolve = next; });
    return { promise, resolve };
  }

  async function waitUntil(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  async function clearCollection(path: string): Promise<void> {
    const snap = await db.collection(path).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }

  async function resetData(): Promise<void> {
    await clearCollection('outbox');
    await clearCollection(`orgs/${tenantId}/transactions`);
    await clearCollection(`orgs/${tenantId}/members`);
    await clearCollection(`orgs/${tenantId}/outbox_deliveries`);
    await clearCollection(`orgs/${tenantId}/notifications`);
    await clearCollection(`orgs/${tenantId}/projects`);
    await clearCollection(`orgs/${tenantId}/project_requests`);
    await clearCollection(`orgs/${tenantId}/partEntries`);
  }

  beforeAll(async () => {
    await resetData();
  });

  beforeEach(async () => {
    await resetData();
  });

  afterAll(async () => {
    await resetData();
  });

  it('processes pending events and writes delivery records', async () => {
    const event = createOutboxEvent({
      tenantId,
      requestId: 'req-outbox-001',
      eventType: 'transaction.upsert',
      entityType: 'transaction',
      entityId: 'tx001',
      payload: { amount: 1000 },
      createdAt: new Date().toISOString(),
    });
    event.nextAttemptAt = new Date(0).toISOString();

    await enqueueOutboxEvent(db, event);
    const result = await processOutboxBatch(db, { limit: 20, maxAttempts: 3 });

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);

    const outboxSnap = await db.doc(`outbox/${event.id}`).get();
    expect(outboxSnap.data()?.status).toBe('DONE');

    const deliverySnap = await db.doc(`orgs/${tenantId}/outbox_deliveries/${event.id}`).get();
    expect(deliverySnap.exists).toBe(true);
  });

  it('samples fresh claim and default-delivery time for each event in a batch', async () => {
    const events = ['a', 'b'].map((suffix) => {
      const event = createOutboxEvent({
        tenantId,
        requestId: `req-outbox-fresh-time-${suffix}`,
        eventType: 'transaction.upsert',
        entityType: 'transaction',
        entityId: `tx-fresh-time-${suffix}`,
        payload: {},
        createdAt: new Date(0).toISOString(),
      });
      event.nextAttemptAt = new Date(0).toISOString();
      return event;
    });
    await Promise.all(events.map((event) => enqueueOutboxEvent(db, event)));
    let nowCalls = 0;

    const result = await processOutboxBatch(db, {
      now: () => new Date(Date.parse('2026-07-10T00:00:00.000Z') + (nowCalls++ * 1_000)).toISOString(),
    });

    expect(result).toMatchObject({ processed: 2, succeeded: 2 });
    const deliveredAt = await Promise.all(events.map(async (event) => (
      await db.doc(`orgs/${tenantId}/outbox_deliveries/${event.id}`).get()
    ).data()?.deliveredAt));
    expect(new Set(deliveredAt).size).toBe(2);
  });

  it('creates notifications when transaction is submitted', async () => {
    await db.doc(`orgs/${tenantId}/members/admin1`).set({ uid: 'admin1', role: 'admin', tenantId });
    await db.doc(`orgs/${tenantId}/members/fin1`).set({ uid: 'fin1', role: 'finance', tenantId });
    await db.doc(`orgs/${tenantId}/transactions/tx100`).set({
      id: 'tx100',
      tenantId,
      projectId: 'p1',
      ledgerId: 'l1',
      counterparty: '거래처A',
      amounts: { bankAmount: 1000 },
      state: 'SUBMITTED',
      submittedBy: 'pm1',
      updatedAt: new Date().toISOString(),
    });

    const event = createOutboxEvent({
      tenantId,
      requestId: 'req-outbox-003',
      eventType: 'transaction.state_changed',
      entityType: 'transaction',
      entityId: 'tx100',
      payload: { nextState: 'SUBMITTED', actorId: 'pm1', actorRole: 'pm' },
      createdAt: new Date().toISOString(),
    });
    event.nextAttemptAt = new Date(0).toISOString();

    await enqueueOutboxEvent(db, event);
    const result = await processOutboxBatch(db, { limit: 20, maxAttempts: 3 });
    expect(result.succeeded).toBe(1);

    const adminNotifId = buildNotificationId({ eventId: event.id, recipientId: 'admin1' });
    const finNotifId = buildNotificationId({ eventId: event.id, recipientId: 'fin1' });

    const adminSnap = await db.doc(`orgs/${tenantId}/notifications/${adminNotifId}`).get();
    const finSnap = await db.doc(`orgs/${tenantId}/notifications/${finNotifId}`).get();
    expect(adminSnap.exists).toBe(true);
    expect(finSnap.exists).toBe(true);
  });

  it('creates notification for submitter when transaction is approved', async () => {
    await db.doc(`orgs/${tenantId}/members/pm1`).set({ uid: 'pm1', role: 'pm', tenantId });
    await db.doc(`orgs/${tenantId}/transactions/tx200`).set({
      id: 'tx200',
      tenantId,
      projectId: 'p1',
      ledgerId: 'l1',
      counterparty: '거래처B',
      amounts: { bankAmount: 2500 },
      state: 'APPROVED',
      submittedBy: 'pm1',
      approvedBy: 'admin1',
      approvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const event = createOutboxEvent({
      tenantId,
      requestId: 'req-outbox-004',
      eventType: 'transaction.state_changed',
      entityType: 'transaction',
      entityId: 'tx200',
      payload: { nextState: 'APPROVED', actorId: 'admin1', actorRole: 'admin' },
      createdAt: new Date().toISOString(),
    });
    event.nextAttemptAt = new Date(0).toISOString();

    await enqueueOutboxEvent(db, event);
    const result = await processOutboxBatch(db, { limit: 20, maxAttempts: 3 });
    expect(result.succeeded).toBe(1);

    const notifId = buildNotificationId({ eventId: event.id, recipientId: 'pm1' });
    const snap = await db.doc(`orgs/${tenantId}/notifications/${notifId}`).get();
    expect(snap.exists).toBe(true);
    expect(snap.data()?.state).toBe('APPROVED');
  });

  it('retries failed events and marks DEAD when attempts exceed max', async () => {
    const event = createOutboxEvent({
      tenantId,
      requestId: 'req-outbox-002',
      eventType: 'transaction.upsert',
      entityType: 'transaction',
      entityId: 'tx002',
      payload: {},
      createdAt: new Date().toISOString(),
    });
    event.nextAttemptAt = new Date(0).toISOString();

    await enqueueOutboxEvent(db, event);

    const failHandler = async () => {
      throw new Error('temporary downstream failure');
    };

    const first = await processOutboxBatch(db, { limit: 20, maxAttempts: 2, handler: failHandler });
    expect(first.failed).toBe(1);

    await db.doc(`outbox/${event.id}`).set({ nextAttemptAt: new Date(0).toISOString() }, { merge: true });
    const second = await processOutboxBatch(db, { limit: 20, maxAttempts: 2, handler: failHandler });
    expect(second.failed).toBe(1);

    const snap = await db.doc(`outbox/${event.id}`).get();
    expect(snap.data()?.status).toBe('DEAD');
  });

  it('reclaims a crashed PROCESSING event after its claim expires', async () => {
    const now = '2026-07-10T00:10:00.000Z';
    const event = createOutboxEvent({
      tenantId,
      requestId: 'req-outbox-crashed-claim',
      eventType: 'transaction.upsert',
      entityType: 'transaction',
      entityId: 'tx-crashed-claim',
      payload: {},
      createdAt: '2026-07-10T00:00:00.000Z',
    });
    Object.assign(event, {
      status: 'PROCESSING',
      attempts: 1,
      claimOwner: 'dead-worker',
      claimToken: 'dead-token',
      processingStartedAt: '2026-07-10T00:00:00.000Z',
      processingLeaseExpiresAt: '2026-07-10T00:05:00.000Z',
    });
    await enqueueOutboxEvent(db, event);
    const handler = vi.fn(async () => undefined);

    const result = await processOutboxBatch(db, {
      handler,
      now: () => now,
      workerId: 'recovery-worker',
      processingTimeoutMs: 5 * 60 * 1000,
    });

    expect(result).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      attempts: 2,
      claimOwner: 'recovery-worker',
      claimToken: expect.any(String),
    });
    expect((await db.doc(`outbox/${event.id}`).get()).data()).toMatchObject({
      status: 'DONE',
      attempts: 2,
      claimOwner: null,
      claimToken: null,
    });
  });

  it('does not reclaim a fresh PROCESSING event', async () => {
    const now = '2026-07-10T00:10:00.000Z';
    const event = createOutboxEvent({
      tenantId,
      requestId: 'req-outbox-fresh-claim',
      eventType: 'transaction.upsert',
      entityType: 'transaction',
      entityId: 'tx-fresh-claim',
      payload: {},
      createdAt: '2026-07-10T00:00:00.000Z',
    });
    Object.assign(event, {
      status: 'PROCESSING',
      attempts: 1,
      claimOwner: 'active-worker',
      claimToken: 'active-token',
      processingStartedAt: '2026-07-10T00:09:00.000Z',
      processingLeaseExpiresAt: '2026-07-10T00:14:00.000Z',
    });
    await enqueueOutboxEvent(db, event);
    const handler = vi.fn(async () => undefined);

    const result = await processOutboxBatch(db, {
      handler,
      now: () => now,
      workerId: 'other-worker',
      processingTimeoutMs: 5 * 60 * 1000,
    });

    expect(result).toMatchObject({ processed: 0, succeeded: 0, failed: 0 });
    expect(handler).not.toHaveBeenCalled();
    expect((await db.doc(`outbox/${event.id}`).get()).data()).toMatchObject({
      status: 'PROCESSING',
      claimOwner: 'active-worker',
      claimToken: 'active-token',
    });
  });

  it('lets only one worker claim the same crashed PROCESSING event', async () => {
    const event = createOutboxEvent({
      tenantId,
      requestId: 'req-outbox-single-reclaim',
      eventType: 'transaction.upsert',
      entityType: 'transaction',
      entityId: 'tx-single-reclaim',
      payload: {},
      createdAt: '2026-07-10T00:00:00.000Z',
    });
    Object.assign(event, {
      status: 'PROCESSING',
      attempts: 1,
      claimOwner: 'dead-worker',
      claimToken: 'dead-token',
      processingStartedAt: '2026-07-10T00:00:00.000Z',
      processingLeaseExpiresAt: '2026-07-10T00:05:00.000Z',
    });
    await enqueueOutboxEvent(db, event);
    const handler = vi.fn(async () => undefined);

    const outcomes = await Promise.all([
      processOutboxBatch(db, { handler, now: () => '2026-07-10T00:10:00.000Z', workerId: 'worker-a' }),
      processOutboxBatch(db, { handler, now: () => '2026-07-10T00:10:00.000Z', workerId: 'worker-b' }),
    ]);

    expect(outcomes.reduce((sum, outcome) => sum + outcome.processed, 0)).toBe(1);
    expect(outcomes.reduce((sum, outcome) => sum + outcome.succeeded, 0)).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await db.doc(`outbox/${event.id}`).get()).data()?.status).toBe('DONE');
  });

  it('heartbeats a long handler so another worker cannot reclaim its live claim', async () => {
    const event = createOutboxEvent({
      tenantId,
      requestId: 'req-outbox-long-handler',
      eventType: 'transaction.upsert',
      entityType: 'transaction',
      entityId: 'tx-long-handler',
      payload: {},
      createdAt: new Date(0).toISOString(),
    });
    event.nextAttemptAt = new Date(0).toISOString();
    await enqueueOutboxEvent(db, event);
    const started = deferred();
    const release = deferred();
    let nowMs = Date.parse('2026-07-10T00:00:00.000Z');
    const firstRun = processOutboxBatch(db, {
      handler: async () => {
        started.resolve();
        await release.promise;
      },
      now: () => new Date(nowMs).toISOString(),
      workerId: 'long-worker',
      processingTimeoutMs: 1_000,
      heartbeatIntervalMs: 10,
    });
    await started.promise;
    nowMs += 2_000;

    const renewed = await waitUntil(async () => {
      const current = (await db.doc(`outbox/${event.id}`).get()).data();
      return Date.parse(current?.processingLeaseExpiresAt || '') > nowMs;
    });
    let second;
    try {
      expect(renewed).toBe(true);
      second = await processOutboxBatch(db, {
        handler: vi.fn(async () => undefined),
        now: () => new Date(nowMs).toISOString(),
        workerId: 'competing-worker',
        processingTimeoutMs: 1_000,
        heartbeatIntervalMs: 10,
      });
      expect(second).toMatchObject({ processed: 0, succeeded: 0 });
    } finally {
      release.resolve();
      await firstRun;
    }
    expect((await db.doc(`outbox/${event.id}`).get()).data()?.status).toBe('DONE');
  });

  it('prevents an old worker from overwriting a claim reclaimed after heartbeat loss', async () => {
    const event = createOutboxEvent({
      tenantId,
      requestId: 'req-outbox-lost-heartbeat',
      eventType: 'transaction.upsert',
      entityType: 'transaction',
      entityId: 'tx-lost-heartbeat',
      payload: {},
      createdAt: new Date(0).toISOString(),
    });
    event.nextAttemptAt = new Date(0).toISOString();
    await enqueueOutboxEvent(db, event);
    const started = deferred();
    const release = deferred();
    let nowMs = Date.parse('2026-07-10T00:00:00.000Z');
    const inertTimer = { unref: () => undefined };
    const oldRun = processOutboxBatch(db, {
      handler: async () => {
        started.resolve();
        await release.promise;
      },
      now: () => new Date(nowMs).toISOString(),
      workerId: 'old-worker',
      processingTimeoutMs: 1_000,
      heartbeatIntervalMs: 10,
      setIntervalFn: () => inertTimer,
      clearIntervalFn: () => undefined,
    });
    await started.promise;
    nowMs += 2_000;

    const replacement = await processOutboxBatch(db, {
      handler: vi.fn(async () => undefined),
      now: () => new Date(nowMs).toISOString(),
      workerId: 'replacement-worker',
      processingTimeoutMs: 1_000,
      heartbeatIntervalMs: 10,
    });
    release.resolve();
    const old = await oldRun;

    expect(replacement).toMatchObject({ processed: 1, succeeded: 1 });
    expect(old).toMatchObject({ processed: 1, succeeded: 0, failed: 0 });
    expect((await db.doc(`outbox/${event.id}`).get()).data()).toMatchObject({
      status: 'DONE',
      claimOwner: null,
      claimToken: null,
    });
  });

  it.each([
    'project.registration.submitted',
    'project.info.submitted',
    DRAFT_ATTACHMENT_CLEANUP_EVENT_TYPE,
  ])(
    'does not mark %s side effects done without an event handler', async (eventType) => {
    const event = createOutboxEvent({
      tenantId,
      requestId: `req-handler-required-${eventType}`,
      eventType,
      entityType: 'project',
      entityId: 'project-registration-1',
      payload: { projectId: 'project-registration-1', projectRequestId: 'request-registration-1' },
      createdAt: new Date().toISOString(),
    });
    event.nextAttemptAt = new Date(0).toISOString();
    await enqueueOutboxEvent(db, event);

    const result = await processOutboxBatch(db, { limit: 20, maxAttempts: 3 });

    expect(result).toMatchObject({ processed: 1, succeeded: 0, failed: 1 });
    expect((await db.doc(`outbox/${event.id}`).get()).data()?.status).toBe('FAILED');
    expect((await db.doc(`orgs/${tenantId}/outbox_deliveries/${event.id}`).get()).exists).toBe(false);
  });

  it('completes registration delivery when Drive and Slack are explicitly disabled', async () => {
    await db.doc(`orgs/${tenantId}/members/pm-registration`).set({
      uid: 'pm-registration',
      name: 'Registration PM',
      role: 'pm',
      tenantId,
    });
    await db.doc(`orgs/${tenantId}/projects/project-disabled-side-effects`).set({
      id: 'project-disabled-side-effects',
      name: 'Disabled side effects project',
      teamMembersDetailed: [{
        memberName: 'Registration PM',
        role: '',
        participationRate: 30,
        laborAllocationStartMonth: '2026-11',
        laborAllocationEndMonth: '2027-02',
        monthlyRates: {
          '2026-11': 30,
          '2026-12': null,
          '2027-01': 0,
          '2027-02': 10,
        },
      }],
      settlementType: 'NONE',
      accountType: 'NONE',
    });
    await db.doc(`orgs/${tenantId}/project_requests/request-disabled-side-effects`).set({
      id: 'request-disabled-side-effects',
      approvedProjectId: 'project-disabled-side-effects',
      payload: { name: 'Disabled side effects project' },
    });
    const ensureProjectRootFolder = vi.fn(async () => {
      throw new Error('disabled Drive must not be called');
    });
    const notifyMessage = vi.fn(async () => {
      throw new Error('disabled Slack must not be called');
    });
    const event = createOutboxEvent({
      tenantId,
      requestId: 'req-disabled-side-effects',
      eventType: 'project.registration.submitted',
      entityType: 'project',
      entityId: 'project-disabled-side-effects',
      payload: {
        projectId: 'project-disabled-side-effects',
        projectRequestId: 'request-disabled-side-effects',
      },
      createdAt: new Date().toISOString(),
    });
    event.nextAttemptAt = new Date(0).toISOString();
    await enqueueOutboxEvent(db, event);
    const handler = createProjectRegistrationSubmittedOutboxHandler({
      db,
      driveService: {
        getConfig: () => ({ enabled: false, defaultParentFolderId: '' }),
        ensureProjectRootFolder,
      },
      projectRegistrationSlackService: { enabled: false, notifyMessage },
    });

    const result = await processOutboxBatch(db, {
      limit: 20,
      maxAttempts: 3,
      eventHandlers: { 'project.registration.submitted': handler },
    });

    expect(result).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
    expect(ensureProjectRootFolder).not.toHaveBeenCalled();
    expect(notifyMessage).not.toHaveBeenCalled();
    const participationEntries = await db.collection(`orgs/${tenantId}/partEntries`).get();
    expect(participationEntries.size).toBe(1);
    expect(participationEntries.docs[0].data()).toMatchObject({
      note: '',
      periodStart: '2026-11',
      periodEnd: '2027-02',
      monthlyRates: {
        '2026-11': 30,
        '2026-12': null,
        '2027-01': 0,
        '2027-02': 10,
      },
    });
    expect((await db.doc(`outbox/${event.id}`).get()).data()).toMatchObject({
      status: 'DONE',
      sideEffects: { registrationDrive: 'SKIPPED', registrationSlack: 'SKIPPED' },
    });
    expect((await db.doc(`orgs/${tenantId}/outbox_deliveries/${event.id}`).get()).exists).toBe(true);
  });

  it('syncs the latest canonical roster when registration delivery overlaps a project edit', async () => {
    const projectId = 'project-registration-concurrent-edit';
    const requestId = 'request-registration-concurrent-edit';
    const projectRef = db.doc(`orgs/${tenantId}/projects/${projectId}`);
    await db.doc(`orgs/${tenantId}/members/person-able`).set({
      uid: 'person-able', name: '김정태', nickname: '에이블', role: 'pm', tenantId,
    });
    const member = (rate: number) => ({
      personId: 'person-able',
      memberName: '김정태',
      memberNickname: '에이블',
      role: '',
      participationRate: rate,
      laborAllocationStartMonth: '2026-01',
      laborAllocationEndMonth: '2026-12',
      monthlyRates: { '2026-01': rate },
    });
    await projectRef.set({
      id: projectId,
      name: '등록 중 수정 사업',
      version: 1,
      contractStart: '2026-01-01',
      contractEnd: '2026-12-31',
      teamMembersDetailed: [member(10)],
      settlementType: 'NONE',
      accountType: 'NONE',
    });
    await db.doc(`orgs/${tenantId}/project_requests/${requestId}`).set({
      id: requestId,
      approvedProjectId: projectId,
      payload: { name: '등록 중 수정 사업' },
    });
    const snapshotCaptured = deferred();
    const releaseDrive = deferred();
    const ensureProjectRootFolder = vi.fn(async () => {
      snapshotCaptured.resolve();
      await releaseDrive.promise;
      return {
        id: 'folder-concurrent-edit',
        driveId: 'drive-a',
        name: '등록 중 수정 사업',
        webViewLink: 'https://drive.google.com/drive/folders/folder-concurrent-edit',
      };
    });
    const event = createOutboxEvent({
      tenantId,
      requestId: 'req-registration-concurrent-edit',
      eventType: 'project.registration.submitted',
      entityType: 'project',
      entityId: projectId,
      payload: { projectId, projectRequestId: requestId },
      createdAt: new Date().toISOString(),
    });
    event.nextAttemptAt = new Date(0).toISOString();
    await enqueueOutboxEvent(db, event);
    const handler = createProjectRegistrationSubmittedOutboxHandler({
      db,
      driveService: {
        getConfig: () => ({ enabled: true, defaultParentFolderId: 'parent-a' }),
        ensureProjectRootFolder,
      },
      projectRegistrationSlackService: { enabled: false },
    });

    const processing = processOutboxBatch(db, {
      limit: 20,
      maxAttempts: 3,
      eventHandlers: { 'project.registration.submitted': handler },
    });
    await snapshotCaptured.promise;
    await projectRef.set({ version: 2, teamMembersDetailed: [member(30)] }, { merge: true });
    releaseDrive.resolve();
    const result = await processing;

    expect(result).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
    expect((await projectRef.get()).data()).toMatchObject({
      version: 2,
      evidenceDriveRootFolderId: 'folder-concurrent-edit',
      teamMembersDetailed: [expect.objectContaining({ participationRate: 30 })],
    });
    const participationEntries = await db.collection(`orgs/${tenantId}/partEntries`)
      .where('projectId', '==', projectId)
      .get();
    expect(participationEntries.size).toBe(1);
    expect(participationEntries.docs[0].data()).toMatchObject({
      personId: 'person-able',
      rate: 30,
      monthlyRates: { '2026-01': 30 },
    });
    expect((await db.doc(`outbox/${event.id}`).get()).data()?.status).toBe('DONE');
  });

  it('relocates private registration attachments before atomically publishing canonical metadata', async () => {
    const sourcePath = 'orgs/mysc/project-registration-drafts/draft-relocate/contract.pdf';
    const canonicalPath = 'orgs/mysc/project-registration-documents/project-relocate/contract.pdf';
    await db.doc(`orgs/${tenantId}/members/pm-registration`).set({
      uid: 'pm-registration', name: 'Registration PM', role: 'pm', tenantId,
    });
    await db.doc(`orgs/${tenantId}/projects/project-relocate`).set({
      id: 'project-relocate', name: 'Attachment project', teamMembersDetailed: [], contractDocument: null,
    });
    await db.doc(`orgs/${tenantId}/project_requests/request-relocate`).set({
      id: 'request-relocate', approvedProjectId: 'project-relocate', payload: { name: 'Attachment project', contractDocument: null },
    });
    const attachmentStorageService = {
      relocateDraftAttachments: vi.fn(async () => [{
        attachmentId: 'contract-1',
        documentKind: 'contract',
        path: canonicalPath,
        name: 'contract.pdf',
        contentType: 'application/pdf',
        size: 3,
        visibility: 'PRIVATE',
      }]),
    };
    const notifyMessage = vi.fn(async (_payload, delivery) => {
      const current = (await db.doc(`outbox/${event.id}`).get()).data();
      expect(current?.sideEffects).toMatchObject({
        registrationSlack: 'PROCESSING',
        registrationSlackIdempotencyKey: delivery.idempotencyKey,
      });
    });
    const event = createOutboxEvent({
      tenantId,
      requestId: 'req-relocate',
      eventType: 'project.registration.submitted',
      entityType: 'project',
      entityId: 'project-relocate',
      payload: {
        projectId: 'project-relocate',
        projectRequestId: 'request-relocate',
        draftId: 'draft-relocate',
        attachmentRefs: [{
          attachmentId: 'contract-1', documentKind: 'contract', path: sourcePath, name: 'contract.pdf',
        }],
      },
      createdAt: new Date(0).toISOString(),
    });
    event.nextAttemptAt = new Date(0).toISOString();
    await enqueueOutboxEvent(db, event);
    const handler = createProjectRegistrationSubmittedOutboxHandler({
      db,
      driveService: { getConfig: () => ({ enabled: false, defaultParentFolderId: '' }) },
      projectRegistrationSlackService: { enabled: true, notifyMessage },
      projectRegistrationAttachmentStorageService: attachmentStorageService,
    });

    const result = await processOutboxBatch(db, {
      eventHandlers: { 'project.registration.submitted': handler },
      now: () => '2026-07-10T00:00:00.000Z',
    });

    expect(result).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
    expect(attachmentStorageService.relocateDraftAttachments).toHaveBeenCalledWith({
      tenantId,
      draftId: 'draft-relocate',
      projectId: 'project-relocate',
      attachmentRefs: event.payload.attachmentRefs,
    });
    expect((await db.doc(`orgs/${tenantId}/projects/project-relocate`).get()).data()?.contractDocument)
      .toMatchObject({ path: canonicalPath, visibility: 'PRIVATE' });
    expect((await db.doc(`orgs/${tenantId}/project_requests/request-relocate`).get()).data()?.payload?.contractDocument)
      .toMatchObject({ path: canonicalPath, visibility: 'PRIVATE' });
    expect((await db.doc(`outbox/${event.id}`).get()).data()).toMatchObject({
      status: 'DONE',
      sideEffects: {
        registrationAttachments: 'DONE',
        registrationSlack: 'DONE',
        registrationSlackIdempotencyKey: `outbox:${event.id}:registrationSlack`,
      },
    });
    expect(notifyMessage).toHaveBeenCalledWith(expect.any(Object), {
      idempotencyKey: `outbox:${event.id}:registrationSlack`,
    });
  });

  it('keeps Slack delivery PROCESSING rather than falsely DONE after an ambiguous failure', async () => {
    await db.doc(`orgs/${tenantId}/projects/project-slack-failure`).set({
      id: 'project-slack-failure', name: 'Slack project', teamMembersDetailed: [],
    });
    await db.doc(`orgs/${tenantId}/project_requests/request-slack-failure`).set({
      id: 'request-slack-failure', approvedProjectId: 'project-slack-failure', payload: { name: 'Slack project' },
    });
    const notifyMessage = vi.fn(async () => {
      throw new Error('Slack response lost after send');
    });
    const event = createOutboxEvent({
      tenantId,
      requestId: 'req-slack-failure',
      eventType: 'project.registration.submitted',
      entityType: 'project',
      entityId: 'project-slack-failure',
      payload: { projectId: 'project-slack-failure', projectRequestId: 'request-slack-failure', attachmentRefs: [] },
      createdAt: new Date(0).toISOString(),
    });
    event.nextAttemptAt = new Date(0).toISOString();
    await enqueueOutboxEvent(db, event);
    const handler = createProjectRegistrationSubmittedOutboxHandler({
      db,
      driveService: { getConfig: () => ({ enabled: false, defaultParentFolderId: '' }) },
      projectRegistrationSlackService: { enabled: true, notifyMessage },
    });

    const result = await processOutboxBatch(db, {
      eventHandlers: { 'project.registration.submitted': handler },
      now: () => '2026-07-10T00:00:00.000Z',
    });

    expect(result).toMatchObject({ processed: 1, succeeded: 0, failed: 1 });
    expect((await db.doc(`outbox/${event.id}`).get()).data()).toMatchObject({
      status: 'FAILED',
      sideEffects: {
        registrationSlack: 'PROCESSING',
        registrationSlackIdempotencyKey: `outbox:${event.id}:registrationSlack`,
      },
    });
    expect((await db.doc(`outbox/${event.id}`).get()).data()?.sideEffects?.registrationSlack).not.toBe('DONE');
  });
});
