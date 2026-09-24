import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createCapabilityExecutor } from './capability-executor.mjs';
import { createDecisionPolicy } from './decision-policy.mjs';

// Local Firestore persistence proof; no real model, GitHub, JVM or production access.
const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('isolated Workbench retained capabilities', () => {
  const env = { WORKBENCH_PROJECT_ID: 'demo-workbench-isolated', PRODUCTION_PROJECT_ID: 'demo-operational-app',
    WORKBENCH_MODEL_PROJECT_ID: 'demo-workbench-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-production-model', WORKBENCH_AI_ENABLED: 'false' };
  const db = new Firestore({ projectId: env.WORKBENCH_PROJECT_ID });
  const businessDb = new Firestore({ projectId: env.PRODUCTION_PROJECT_ID });
  const context = { tenantId: 'isolated-capabilities', actorId: 'admin-a', actorRole: 'admin' };
  const now = () => '2026-09-22T12:00:00.000Z';
  const root = `orgs/${context.tenantId}`;
  const sha = 'a'.repeat(40);
  const readCode = vi.fn(async ({ sha: revision }: any) => ({ items: [], revision: revision || null }));
  const core = () => createIsolatedWorkbenchCore({ env, db, now, readCode });
  const signal = () => new AbortController().signal;
  beforeEach(async () => {
    expect(db).not.toBe(businessDb);
    expect(db.projectId).toBe(env.WORKBENCH_PROJECT_ID);
    expect(businessDb.projectId).toBe(env.PRODUCTION_PROJECT_ID);
    expect(db.projectId).not.toBe(businessDb.projectId);
    readCode.mockClear();
    await db.recursiveDelete(db.doc(root));
    await businessDb.recursiveDelete(businessDb.doc(root));
    await db.doc(`${root}/members/${context.actorId}`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now() });
    await businessDb.doc(`${root}/projects/p1`).set({ name: 'Operational original', amount: 123, revision: 'untouched' });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await db.recursiveDelete(db.doc(root));
    await businessDb.recursiveDelete(businessDb.doc(root));
    await Promise.all([db.terminate(), businessDb.terminate()]);
  });

  it('answers from copied logs and requests the exact correlated revision without claiming proven causality', async () => {
    await db.doc(`${root}/client_error_events/event-a`).set({ actorId: context.actorId, createdAt: now(), occurredAt: now(),
      clientRequestId: 'failed-request', ingestRelease: 'b'.repeat(40), extra: { code: 'save_failed', status: 500 } });
    await db.doc(`${root}/reliability_operations/operation-a`).set({ actorId: context.actorId, requestId: 'failed-request',
      operationKey: 'registration.submit', serverObserved: true, updatedAt: now(), releaseSha: sha, outcome: 'system_failed', errorCode: 'save_failed' });
    const result = await core().qa(context, { question: '제출이 왜 실패했나요?', area: 'approval', eventId: 'event-a' });
    expect(result.answerMode).toBe('deterministic_evidence');
    expect(result.logs).toHaveLength(1);
    expect(result.correlation).toBe('REQUEST_METADATA_CANDIDATE');
    expect(readCode).toHaveBeenCalledWith(expect.objectContaining({ sha, area: 'approval' }));
    expect(result.unknowns.join(' ')).toContain('인과관계 확정은 아닙니다');
  });

  it('executes a typed fixture decision against real copied evidence and persists a metadata-only trace', async () => {
    await db.doc(`${root}/client_error_events/decision-event`).set({ actorId: context.actorId, createdAt: now(), extra: { code: 'save_failed', status: 500 } });
    const instance = core();
    const inspect = vi.fn((ctx, input) => instance.qa(ctx, input));
    const preview = vi.fn();
    const evaluate = vi.fn().mockResolvedValue({ model: 'jev-1.13.0', usage: { input_tokens: 0, output_tokens: 0 },
      answers: { nextCapability: { type: 'choice', choice: 'inspect', confidence: 0.9, probabilities: { inspect: 0.9, preview: 0.05, __abstain__: 0.05 } } } });
    const execute = createCapabilityExecutor({
      capabilities: [{ id: 'inspect', description: '오류 기록과 해당 버전 코드 근거를 조회합니다.', effect: 'read', execute: inspect },
        { id: 'preview', description: '자료의 화면 구성을 제안합니다.', effect: 'preview', execute: preview }],
      authorize: async (ctx) => { await instance.authorize(ctx); return { capabilityIds: ['inspect', 'preview'], scopeFingerprint: 'fixture-scope-v1' }; },
      decisionPolicy: createDecisionPolicy({ enabled: true, evaluate }),
      recordDecision: (ctx, trace) => db.collection(`orgs/${ctx.tenantId}/decision_traces`).add(trace),
    });
    const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No real provider calls permitted.'));
    const result = await execute(context, { turnId: 'fixture-turn', intentSummary: '저장 실패 원인 확인', evidenceReady: true,
      input: { question: '제출이 왜 실패했나요?', area: 'approval', eventId: 'decision-event' } });
    expect(result.execution).toBe('completed');
    expect(result.output.logs).toHaveLength(1);
    expect(result.output.logs[0].id).toBe('decision-event');
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(preview).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
    const traces = (await db.collection(`${root}/decision_traces`).get()).docs.map((doc) => doc.data());
    expect(traces).toHaveLength(2);
    expect(traces.every((trace) => trace.decisionId === result.decisionId)).toBe(true);
    expect(JSON.stringify(traces)).not.toContain('제출이 왜');
    expect(JSON.stringify(traces)).not.toContain('decision-event');
    expect((await businessDb.doc(`${root}/projects/p1`).get()).data()?.revision).toBe('untouched');
  });

  it('does not invoke a capability when unavailable, when evidence is missing, or after permission revocation during a decision', async () => {
    const instance = core();
    const handler = vi.fn();
    const evaluate = vi.fn(async () => {
      await db.doc(`${root}/members/${context.actorId}`).update({ status: 'INACTIVE' });
      return { model: 'jev-1.13.0', usage: { input_tokens: 0, output_tokens: 0 }, answers: { nextCapability: {
        type: 'choice', choice: 'inspect', confidence: 0.9, probabilities: { inspect: 0.9, preview: 0.05, __abstain__: 0.05 },
      } } };
    });
    const options = {
      capabilities: [{ id: 'inspect', description: '근거 조회', effect: 'read', execute: handler }, { id: 'preview', description: '화면 제안', effect: 'preview', execute: handler }],
      authorize: async (ctx) => { await instance.authorize(ctx); return { capabilityIds: ['inspect', 'preview'], scopeFingerprint: 'fixture-scope-v1' }; },
      recordDecision: (ctx, trace) => db.collection(`orgs/${ctx.tenantId}/decision_traces`).add(trace),
    };
    const input = { turnId: 'blocked-turn', intentSummary: '자료 확인', evidenceReady: true, input: {} };
    const disabled = createCapabilityExecutor({ ...options, decisionPolicy: createDecisionPolicy({ evaluate }) });
    expect((await disabled(context, input)).execution).toBe('not_run');
    const enabled = createCapabilityExecutor({ ...options, decisionPolicy: createDecisionPolicy({ enabled: true, evaluate }) });
    expect((await enabled(context, { ...input, evidenceReady: false })).execution).toBe('not_run');
    expect(evaluate).not.toHaveBeenCalled();
    await expect(enabled(context, input)).rejects.toMatchObject({ statusCode: 403 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves an unknown failed revision unknown rather than using ingestion release or main', async () => {
    await db.doc(`${root}/client_error_events/old-event`).set({ actorId: context.actorId, createdAt: now(), ingestRelease: 'b'.repeat(40), extra: { status: 500 } });
    const result = await core().qa(context, { question: '이전 오류 원인?', area: 'approval', eventId: 'old-event' });
    expect(result.correlation).toBe('NOT_ESTABLISHED');
    expect(readCode.mock.calls[0][0].sha).toBeFalsy();
    expect(result.unknowns.join(' ')).toContain('최신 main으로 대신하지 않았습니다');
  });

  it('persists variable dashboard widgets and restores a selected revision without modifying business records', async () => {
    const instance = core();
    await instance.authorize(context);
    const config = { schemaVersion: 2, source: 'insight-dashboard', title: 'CEO 현황', description: '', yearMonth: '2026-09', presentation: 'cards', search: '',
      widgets: [{ id: 'quality', kind: 'operations', title: '제출 추이', display: 'trend', days: 14, search: '', width: 'full' }] };
    const first = await instance.pages.save(context, null, { expectedVersion: 0, config });
    const expanded = { ...config, widgets: [...config.widgets, { id: 'cash', kind: 'cashflow', title: '현금흐름', display: 'table', days: 7, search: 'CIC1', width: 'half' }] };
    await instance.pages.save(context, first.id, { expectedVersion: 1, config: expanded });
    expect((await core().pages.get(context, first.id)).config).toEqual(expanded);
    const restored = await instance.pages.restore(context, first.id, { expectedVersion: 2, version: 1 });
    expect(restored).toMatchObject({ version: 3, restoredFrom: 1, config });
    expect((await instance.pages.history(context, first.id)).items.map((item: any) => item.version)).toEqual([3, 2, 1]);
    expect((await businessDb.doc(`${root}/projects/p1`).get()).data()).toEqual({ name: 'Operational original', amount: 123, revision: 'untouched' });
  });

  it('keeps missing and stale local snapshots unavailable even if operational business data exists', async () => {
    await db.doc(`${root}/projects/p1`).set({ name: 'Copied project', cic: 'CIC1' });
    const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Outbound HTTP forbidden in isolated evidence test'));
    const instance = core();
    const missing = await instance.evidence(context, { yearMonth: '2026-09' }, signal());
    expect(missing).toMatchObject({ failed: 1, available: 0 });
    expect(missing.rows[0].error.code).toBe('workbench_snapshot_unavailable');
    await db.doc(`${root}/workbench_snapshots/p1-2026-09`).set({ capturedAt: '2026-09-20T00:00:00.000Z', sourceRevision: 'old', snapshot: { projectId: 'p1' } });
    const stale = await instance.evidence(context, { yearMonth: '2026-09' }, signal());
    expect(stale).toMatchObject({ failed: 1, available: 0 });
    expect(stale.rows[0].error.code).toBe('workbench_snapshot_stale');
    expect(stale.totals.actual.inflow).toEqual({ value: null, included: 0, excluded: 1 });
    expect(outbound).not.toHaveBeenCalled();
    expect((await businessDb.doc(`${root}/projects/p1`).get()).data()?.revision).toBe('untouched');
  });

  it('reads a fresh copied snapshot while preserving explicit zero as recorded data', async () => {
    await db.doc(`${root}/projects/p1`).set({ name: 'Copied project', cic: 'CIC1' });
    const mode = { rowTotals: {}, weeks: [{ weekNo: 2, amounts: { SALES_IN: 0 }, weekIn: 0, weekOut: 0, net: 0 }], monthTotals: { totalIn: 0, totalOut: 0, net: 0 } };
    await db.doc(`${root}/workbench_snapshots/p1-2026-09`).set({ capturedAt: now(), sourceRevision: 'copied-revision',
      snapshot: { projectId: 'p1', targetRevision: 'copied-revision', accountingSource: { weeklyYear: 2026 },
        readModel: { months: [{ yearMonth: '2026-09', projection: mode, actual: mode }] } } });
    const result = await core().evidence(context, { yearMonth: '2026-09' }, signal());
    expect(result).toMatchObject({ failed: 0, available: 1 });
    expect(result.rows[0]).toMatchObject({ status: 'AVAILABLE', actual: { inflow: 0 } });
    expect(result.totals.actual.inflow).toEqual({ value: 0, included: 1, excluded: 0 });
  });

  it('rejects stale permission copies before reading privileged QA evidence', async () => {
    await db.doc(`${root}/members/${context.actorId}`).update({ permissionsCapturedAt: '2026-09-20T00:00:00.000Z' });
    await expect(core().authorize(context)).rejects.toMatchObject({ statusCode: 403 });
    await expect(core().qa(context, { question: '오류 조회', area: 'approval' })).rejects.toMatchObject({ statusCode: 403 });
    expect(readCode).not.toHaveBeenCalled();
  });
});
