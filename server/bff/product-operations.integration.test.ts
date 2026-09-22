import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createBffApp } from './app.mjs';
import { createFirestoreDb } from './firestore.mjs';
import { createReliabilityService } from './reliability-service.mjs';
import { createPersonalWorkPageService } from './personal-work-pages.mjs';
import { createCashflowEvidenceQuery } from './cashflow-evidence-query.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('product operations persisted contracts', () => {
  const db = createFirestoreDb({ projectId: 'demo-bff-it' });
  const context = { tenantId: 'operations-test', actorId: 'a', actorRole: 'admin' };
  const other = { ...context, actorId: 'b', actorRole: 'pm' };
  const now = () => '2026-09-22T02:00:00.000Z';
  const reliability = createReliabilityService({ db, now, environment: 'local' });
  const pages = createPersonalWorkPageService({ db, now });
  const config = { schemaVersion: 1, title: '내 사업', description: '', source: 'cashflow-evidence', presentation: 'table', yearMonth: '2026-09', search: '' };
  beforeEach(async () => {
    await db.recursiveDelete(db.doc(`orgs/${context.tenantId}`));
    await db.doc(`orgs/${context.tenantId}/members/a`).set({ uid: 'a', role: 'admin', status: 'ACTIVE' });
    await db.doc(`orgs/${context.tenantId}/members/b`).set({ uid: 'b', role: 'pm', status: 'ACTIVE', projectIds: ['p1'] });
  });
  afterAll(async () => { await db.recursiveDelete(db.doc(`orgs/${context.tenantId}`)); });

  it('counts concurrent duplicate/out-of-order events once and isolates actor outcomes', async () => {
    const event = { operationId: 'b9bf1270-158c-49ef-8a9a-26976085bd63', operationKey: 'registration.submit', mode: 'manual', phase: 'started' };
    const deliveries = await Promise.allSettled([reliability.observeClient(context, event), reliability.observeClient(context, event)]);
    for (const delivery of deliveries) {
      if (delivery.status === 'rejected') {
        // Exercise the client's retained-delivery retry when the store rejects concurrent collection.
        expect([3, 10]).toContain(delivery.reason.code);
        if (delivery.reason.code === 3) expect(delivery.reason.message).toContain('Transaction is invalid or closed');
        await reliability.observeClient(context, event);
      }
    }
    await reliability.observe(context, { ...event, authority: 'server', outcome: 'saved', requestId: 'saved-proof', followup: 'unconfirmed' });
    await reliability.observeClient(context, { ...event, phase: 'unknown' });
    await reliability.observe(context, { ...event, authority: 'server', outcome: 'system_failed', requestId: 'retry-failure' });
    const summary = await reliability.summary(context);
    expect(summary.counts).toMatchObject({ total: 1, saved: 1, system_failed: 0, unknown: 0, followupUnconfirmed: 1 });
    expect(await reliability.getOperation(context, event.operationKey, event.operationId)).toMatchObject({ outcome: 'saved', requestId: 'saved-proof' });
    expect(await reliability.getOperation(other, event.operationKey, event.operationId)).toMatchObject({ found: false });
    await expect(reliability.summary(other)).rejects.toMatchObject({ statusCode: 403 });
    await expect(reliability.observeClient(context, { ...event, phase: 'saved' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('preserves incident revisions, conflicts, public projection and resolved visibility', async () => {
    const input = { expectedVersion: 0, title: 'private title', status: 'investigating', operationKey: null, cause: 'internal cause', evidence: 'internal request',
      owner: 'operator', action: '', releaseSha: '', published: true, publicTitle: '저장 지연', publicMessage: '확인 중입니다', publicAction: '입력 화면을 유지해 주세요' };
    const incident = await reliability.saveIncident(context, null, input);
    const guidance = await reliability.listIncidents(other, { publishedOnly: true });
    expect(guidance.items[0]).toEqual({ id: incident.id, title: input.publicTitle, message: input.publicMessage, nextAction: input.publicAction, status: 'investigating', operationKey: null, updatedAt: now() });
    await expect(reliability.saveIncident(other, incident.id, input)).rejects.toMatchObject({ statusCode: 403 });
    await expect(reliability.saveIncident(context, incident.id, input)).rejects.toMatchObject({ statusCode: 409 });
    await reliability.saveIncident(context, incident.id, { ...input, expectedVersion: 1, status: 'resolved', action: '검증 완료' });
    expect((await reliability.listIncidents(other, { publishedOnly: true })).items).toHaveLength(0);
    expect((await reliability.incidentHistory(context, incident.id)).items.map((item) => item.version)).toEqual([2, 1]);
    await expect(reliability.incidentHistory(other, incident.id)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('persists personal pages, immutable restore, conflicts and owner/tenant isolation', async () => {
    const first = await pages.save(context, null, { expectedVersion: 0, config });
    expect(await pages.get(context, first.id)).toEqual(first);
    for (const stranger of [other, { ...context, tenantId: 'another-organization' }]) {
      await expect(pages.get(stranger, first.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(pages.history(stranger, first.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(pages.save(stranger, first.id, { expectedVersion: 1, config })).rejects.toMatchObject({ statusCode: 404 });
      await expect(pages.restore(stranger, first.id, { expectedVersion: 1, version: 1 })).rejects.toMatchObject({ statusCode: 404 });
      await expect(pages.remove(stranger, first.id, { expectedVersion: 1 })).rejects.toMatchObject({ statusCode: 404 });
    }
    const second = await pages.save(context, first.id, { expectedVersion: 1, config: { ...config, title: '바뀐 화면' } });
    await expect(pages.save(context, first.id, { expectedVersion: 1, config })).rejects.toMatchObject({ statusCode: 409 });
    const restored = await pages.restore(context, first.id, { expectedVersion: second.version, version: 1 });
    expect(restored).toMatchObject({ version: 3, restoredFrom: 1, config });
    expect((await pages.history(context, first.id)).items.map((item) => item.version)).toEqual([3, 2, 1]);
    await pages.remove(context, first.id, { expectedVersion: 3 });
    expect((await pages.list(context)).items).toHaveLength(0);
    await expect(pages.get(context, first.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(pages.restore(context, first.id, { expectedVersion: 4, version: 1 })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects arbitrary execution and unknown source/version instead of adapting old config', async () => {
    for (const altered of [{ ...config, url: 'https://private.example' }, { ...config, script: 'fetch("secret")' }, { ...config, source: 'arbitrary-api' }, { ...config, schemaVersion: 2 }]) {
      await expect(pages.save(context, null, { expectedVersion: 0, config: altered })).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it('cashflow scope excludes forbidden projects and a failed read is not zero or a confirmed cause', async () => {
    for (const id of ['p1', 'private-project']) await db.doc(`orgs/${context.tenantId}/projects/${id}`).set({ name: id, cic: 'CIC1', status: 'ACTIVE' });
    const before = (await db.collection(`orgs/${context.tenantId}/projects`).get()).docs.map((doc) => doc.data());
    const readSnapshot = vi.fn().mockRejectedValue(Object.assign(new Error('secret upstream'), { code: 'jvm_weekly_api_unreachable' }));
    const query = createCashflowEvidenceQuery({ db, readSnapshot, now, release: 'a'.repeat(40) });
    const result = await query(other, { yearMonth: '2026-09' }, new AbortController().signal);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(readSnapshot.mock.calls[0][0].params).toEqual({ projectId: 'p1' });
    expect(result).toMatchObject({ accessibleInPage: 1, failed: 1, available: 0, totalsScope: 'THIS_PAGE_ONLY', code: { release: 'a'.repeat(40) } });
    expect(result.totals.actual.inflow).toEqual({ value: null, included: 0, excluded: 1 });
    expect(JSON.stringify(result)).not.toContain('private-project');
    expect(JSON.stringify(result)).not.toContain('secret upstream');
    expect((await db.collection(`orgs/${context.tenantId}/projects`).get()).docs.map((doc) => doc.data())).toEqual(before);
  });

  it('keeps zero, missing month records and timed-out businesses distinct without losing successful rows', async () => {
    for (const id of ['p1', 'p2', 'p3']) await db.doc(`orgs/${context.tenantId}/projects/${id}`).set({ name: id, cic: 'CIC1' });
    const readSnapshot = vi.fn(async ({ params }: any) => {
      if (params.projectId === 'p3') return new Promise(() => {});
      const recorded = params.projectId === 'p1';
      const mode = { rowTotals: {}, weeks: recorded ? [{ weekNo: 2, amounts: { SALES_IN: 0 }, weekIn: 0, weekOut: 0, net: 0 }] : [], monthTotals: { totalIn: 0, totalOut: 0, net: 0 } };
      return { projectId: params.projectId, targetRevision: 'rev-from-persisted-source', accountingSource: { weeklyYear: 2026 },
        readModel: { months: [{ yearMonth: '2026-09', projection: mode, actual: mode }] } };
    });
    const query = createCashflowEvidenceQuery({ db, readSnapshot, now, readBudgetMs: 20 });
    const result = await query(context, { yearMonth: '2026-09' }, new AbortController().signal);
    expect(result.rows.map((row: any) => row.status)).toEqual(['AVAILABLE', 'NOT_RECORDED', 'FAILED']);
    expect(result.rows[0].actual.inflow).toBe(0);
    expect(result.rows[1].actual.inflow).toBeNull();
    expect(result.rows[2].error.category).toBe('TIMEOUT');
    expect(result.totals.actual.inflow).toEqual({ value: 0, included: 1, excluded: 2 });
    expect(result.rows[0].missingWeeks.actual).not.toContain(2);
    expect(result.rows[1].missingWeeks.actual).toContain(2);
  });

  it('serves actual HTTP save/reload/replay and rejects model use before configuration', async () => {
    const app = createBffApp({ db, authMode: 'headers', env: { ...process.env, PRODUCT_WORKBENCH_AI_ENABLED: 'false' } });
    const api = request(app);
    const headers = { 'x-tenant-id': context.tenantId, 'x-actor-id': 'a', 'x-actor-role': 'admin', 'idempotency-key': 'page-create-unique' };
    const first = await api.post('/api/v1/personal-work-pages').set(headers).send({ expectedVersion: 0, config });
    expect(first.status).toBe(201);
    const replay = await api.post('/api/v1/personal-work-pages').set(headers).send({ expectedVersion: 0, config });
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.headers['x-idempotency-replayed']).toBe('1');
    expect((await api.get(`/api/v1/personal-work-pages/${first.body.id}`).set(headers)).body.config).toEqual(config);
    const foreign = await api.get(`/api/v1/personal-work-pages/${first.body.id}`).set({ ...headers, 'x-actor-id': 'b', 'x-actor-role': 'pm' });
    expect(foreign.status).toBe(404);
    expect((await api.get('/api/v1/workbench-assistant/capabilities').set(headers)).body.modelEnabled).toBe(false);
    const blocked = await api.post('/api/v1/workbench-assistant/cashflow').set({ ...headers, 'idempotency-key': 'ask-unconfigured' }).send({ question: '이번 달은?', yearMonth: '2026-09' });
    expect(blocked.status).toBe(503);
    expect(blocked.body.error).toBe('workbench_model_unconfigured');
  });

  it('limits AI rollout to admins and rejects exhausted tenant capacity before calling the provider', async () => {
    const complete = vi.fn();
    const app = createBffApp({ db, authMode: 'headers', env: { ...process.env, PRODUCT_WORKBENCH_AI_ENABLED: 'true', SETTLEMENT_AGENT_GEMINI_API_KEY: 'test-only' }, workbenchCompletionFactory: () => complete });
    const api = request(app);
    const headers = { 'x-tenant-id': context.tenantId, 'x-actor-id': 'b', 'x-actor-role': 'pm', 'idempotency-key': 'pm-ai' };
    expect((await api.get('/api/v1/workbench-assistant/capabilities').set(headers)).body.modelEnabled).toBe(false);
    expect((await api.post('/api/v1/workbench-assistant/page-proposal').set(headers).send({ question: '화면 구성', yearMonth: '2026-09' })).status).toBe(403);
    const lock = db.doc(`orgs/${context.tenantId}/personal_work_pages/_tenant_budget/agent_locks/active`);
    await lock.set({ runId: 'another-request', expiresAt: new Date(Date.now() + 60000).toISOString() });
    const busy = await api.post('/api/v1/workbench-assistant/page-proposal').set({ ...headers, 'x-actor-id': 'a', 'x-actor-role': 'admin', 'idempotency-key': 'busy-ai' }).send({ question: '화면 구성', yearMonth: '2026-09' });
    expect(busy.status).toBe(429);
    expect(busy.body.error).toBe('workbench_ai_tenant_in_progress');
    expect((await lock.get()).data()?.runId).toBe('another-request');
    expect(complete).not.toHaveBeenCalled();
  });

  it('rechecks revoked membership before any tool evidence can reach a model', async () => {
    const complete = vi.fn(async () => {
      await db.doc(`orgs/${context.tenantId}/members/a`).update({ role: 'pm' });
      return { tool_calls: [{ id: 'call1', function: { name: 'cashflow_diagnostics', arguments: '{}' } }] };
    });
    const app = createBffApp({ db, authMode: 'headers', env: { ...process.env, PRODUCT_WORKBENCH_AI_ENABLED: 'true', SETTLEMENT_AGENT_GEMINI_API_KEY: 'not-a-real-key' },
      workbenchCompletionFactory: () => complete });
    const result = await request(app).post('/api/v1/workbench-assistant/cashflow').set({ 'x-tenant-id': context.tenantId, 'x-actor-id': 'a', 'x-actor-role': 'admin', 'idempotency-key': 'revoke-during-model' })
      .send({ question: '현금흐름 오류 기록 확인', yearMonth: '2026-09' });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('workbench_scope_changed');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(complete.mock.calls)).not.toContain('client_reported_error_metadata');
  });

  it('does not replay private incident or model results after role/scope changes', async () => {
    const complete = vi.fn(async () => ({ tool_calls: [{ function: { name: 'propose_page', arguments: JSON.stringify({ ...config, title: 'private generated title' }) } }] }));
    const app = createBffApp({ db, authMode: 'headers', env: { ...process.env, PRODUCT_WORKBENCH_AI_ENABLED: 'true', SETTLEMENT_AGENT_GEMINI_API_KEY: 'test-only-no-network' }, workbenchCompletionFactory: () => complete });
    const api = request(app);
    const headers = { 'x-tenant-id': context.tenantId, 'x-actor-id': 'a', 'x-actor-role': 'admin', 'idempotency-key': 'private-incident' };
    const body = { expectedVersion: 0, title: 'private incident', status: 'investigating', operationKey: null, cause: 'private cause', evidence: 'private evidence',
      owner: '', action: '', releaseSha: '', published: false, publicTitle: '', publicMessage: '', publicAction: '' };
    expect((await api.post('/api/v1/product-operations/incidents').set(headers).send(body)).status).toBe(201);
    const modelHeaders = { ...headers, 'idempotency-key': 'private-model' };
    const question = { question: '사업 조회 페이지', yearMonth: '2026-09' };
    const initial = await api.post('/api/v1/workbench-assistant/page-proposal').set(modelHeaders).send(question);
    expect(initial.status).toBe(200);
    expect(initial.body.config.title).toBe('private generated title');
    await db.doc(`orgs/${context.tenantId}/members/a`).update({ role: 'pm', projectIds: [] });
    const incidentReplay = await api.post('/api/v1/product-operations/incidents').set({ ...headers, 'x-actor-role': 'pm' }).send(body);
    expect(incidentReplay.status).toBe(403);
    expect(JSON.stringify(incidentReplay.body)).not.toContain('private cause');
    const modelReplay = await api.post('/api/v1/workbench-assistant/page-proposal').set({ ...modelHeaders, 'x-actor-role': 'pm' }).send(question);
    expect(modelReplay.status).toBe(409);
    expect(modelReplay.body.error).toBe('workbench_model_already_processed');
    expect(JSON.stringify(modelReplay.body)).not.toContain('private generated title');
    expect(complete).toHaveBeenCalledTimes(1);
    const caches = await db.collection(`orgs/${context.tenantId}/idempotency_keys`).get();
    const modelCache = caches.docs.find((doc: any) => doc.data().idempotencyKey === 'private-model')?.data();
    expect(modelCache.responseBody).toEqual({ runId: initial.body.runId, resultRetained: false });
  });
});
