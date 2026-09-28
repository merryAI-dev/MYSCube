import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import { createAnalyticsService } from './analytics-service.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createConversationService } from './conversations.mjs';
import { createReactConversationService } from './react-conversation.mjs';
import { issueDateColumnChoice } from './date-column-choice.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('durable server date choices with real Firestore, authorization and DuckDB', () => {
  const db = new Firestore({ projectId: 'demo-date-choice-it' }), tenantId = `date-choice-${randomUUID()}`, prefix = `orgs/${tenantId}`;
  const now = () => '2026-09-28T00:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-date-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-date-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-date-business-model', WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'offline-only' };
  const core = createIsolatedWorkbenchCore({ db, env, now }), analytics = createAnalyticsService({ db, now }), raw = createConversationService({ db, now });
  const context = () => ({ tenantId, actorId: 'admin', actorRole: 'admin' });
  const period = { start: '2026-09-01', end: '2026-09-30', label: '2026년 9월', basis: 'explicit_request' };
  const understood = (range = period, datasetId = 'project_dates') => ({ summary: '날짜 기준 사본 조회', ambiguities: [], context: { datasetIds: [datasetId], filters: {}, evidenceIds: [], ...(range ? { period: range } : {}) } });
  const plan = (field = 'contract_end', datasetId = 'project_dates', range = period) => ({ kind: 'table', datasetId, select: ['name'], filters: range ? [{ field, op: 'gte', value: range.start }, { field, op: 'lte', value: range.end }] : [] });
  const query = (field = 'contract_end', datasetId = 'project_dates', range = period) => ({ action: 'query_table', interpretation: understood(range, datasetId), plan: plan(field, datasetId, range) });
  const data = (datasetId = 'project_dates') => ({ datasetId, manifest: { tableQuery: { schemaVersion: 1 }, sourceRevision: 'synthetic-v1', capturedAt: now(), asOf: now(), completeness: 'complete', coverage: { description: '합성 날짜 경계 2행', expectedRows: 2 } }, schema: [
    { name: 'name', type: 'string' }, { name: 'contract_start', type: 'date', label: '계약 시작일' }, { name: 'contract_end', type: 'date', label: '계약 종료일' },
  ], rows: [{ name: '9월 종료 사업', contract_start: '2026-03-01', contract_end: '2026-09-30' }, { name: '9월 시작 사업', contract_start: '2026-09-01', contract_end: '2026-12-31' }] });
  let ctx, responses, lastEvidence, queryPlan, complete;
  const service = (overrides = {}) => createReactConversationService({ db, now, env, authorize: core.authorize, analytics: { ...analytics, queryPlan },
    apis: { get: async () => { throw new Error('unexpected API access'); } }, qa: () => { throw new Error('unexpected QA'); }, completionFactory: () => complete, ...overrides });
  const turn = (id, expectedVersion, requestId, extras = {}) => service().turn(context(), id, { expectedVersion, requestId, message: '계약 날짜 조회', mode: 'analysis', ...extras });
  async function pendingSession() {
    const session = await raw.create(ctx), begun = await raw.beginTurn(ctx, session.id, { expectedVersion: 0, requestId: 'seed-choice', message: '9월 계약 자료', scopeFingerprint: ctx.analyticsScope.fingerprint });
    const pending = issueDateColumnChoice({ datasetId: 'project_dates', catalogItems: (await analytics.catalog(ctx)).items, message: '9월 계약 자료', period });
    await raw.completeTurn(ctx, session.id, { turnId: begun.turnId, result: { answer: pending.question, status: 'clarification_required', clarification: pending, scopeFingerprint: ctx.analyticsScope.fingerprint, context: { scopeFingerprint: ctx.analyticsScope.fingerprint } } });
    return { session, pending, selection: { clarificationId: pending.id, optionId: pending.options[1].id } };
  }
  async function selectAndFail() {
    const f = await pendingSession(); responses.push(query('contract_start'));
    await expect(turn(f.session.id, 1, 'choose-end', { selection: f.selection })).rejects.toMatchObject({ code: 'conversation_date_basis_mismatch' });
    return f;
  }
  beforeEach(async () => {
    await db.recursiveDelete(db.doc(prefix));
    await db.doc(`${prefix}/members/admin`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now(), analyticsDatasetIds: ['project_dates', 'other_dates'], analyticsScopeRevision: 'approved-v1' });
    ctx = context(); await core.authorize(ctx); await analytics.importDataset(ctx, data()); await analytics.importDataset(ctx, data('other_dates'));
    responses = []; lastEvidence = null;
    queryPlan = vi.fn(async (...args) => { lastEvidence = await analytics.queryPlan(...args); return lastEvidence; });
    complete = vi.fn(async () => {
      const next = responses.shift(); if (!next) throw new Error('unexpected completion');
      const step = next === 'answer' ? { action: 'answer', interpretation: understood(), answer: '날짜 기준에 맞는 사본을 확인했습니다.', evidenceIds: [lastEvidence.evidenceId] } : next;
      return { tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify(step) } }] };
    });
  });
  afterAll(async () => { await db.recursiveDelete(db.doc(prefix)); await db.terminate(); });

  it('runs the real clarify action, persists a failed selection, replays it and queries only the chosen end date after reload', async () => {
    const session = await service().create(context()); responses.push({ action: 'clarify_date_column', datasetId: 'project_dates', interpretation: understood() });
    const first = await turn(session.id, 0, 'ask'); const pending = first.result.clarification;
    expect(pending.kind).toBe('date_column'); expect(pending.dateColumn).toBeUndefined(); expect(queryPlan).not.toHaveBeenCalled();
    expect((await service().get(context(), session.id)).pendingClarification.options).toEqual(pending.options);
    const selection = { clarificationId: pending.id, optionId: pending.options[1].id }, input = { selection, clarificationId: pending.id };
    responses.push(query('contract_start'));
    await expect(turn(session.id, 1, 'choose', input)).rejects.toMatchObject({ code: 'conversation_date_basis_mismatch' });
    expect(queryPlan).not.toHaveBeenCalled();
    const saved = await raw.get(ctx, session.id), basis = saved.serverState.dateBasis;
    expect(basis.field).toBe('contract_end'); expect(saved.pendingClarification).toBeNull(); expect(saved.turns[1].selection).toEqual(basis);
    const restored = await service().get(context(), session.id);
    expect(restored.dateBasis.field).toBe('contract_end'); expect(restored.serverState).toBeUndefined(); expect(restored.turns[1].selection).toBeUndefined();
    expect(await turn(session.id, 1, 'choose', input)).toMatchObject({ replayed: true, turn: { state: 'failed' } }); expect(complete).toHaveBeenCalledTimes(2);
    await expect(turn(session.id, 1, 'choose', { ...input, selection: { ...selection, optionId: pending.options[0].id } })).rejects.toMatchObject({ code: 'conversation_request_conflict' });
    await expect(turn(session.id, 2, 'old-choice', input)).rejects.toMatchObject({ code: 'conversation_date_choice_stale' });
    responses.push(query(), 'answer'); const answer = await turn(session.id, 2, 'follow-up');
    expect(answer.result.evidence[0].rows).toEqual([{ name: '9월 종료 사업' }]); expect(queryPlan).toHaveBeenCalledTimes(1);
    const persisted = await raw.get(ctx, session.id), result = persisted.turns[2].result;
    expect(result.dateBasisProvenance).toEqual([expect.objectContaining({ field: 'contract_end', selectedTurnId: basis.selectedTurnId, evidenceId: answer.result.evidence[0].evidenceId, definitionHash: basis.definitionHash })]);
    expect(answer.result.dateBasisProvenance).toBeUndefined(); expect(persisted.turns[1]).toEqual(saved.turns[1]);
  });
  it('keeps a pending date question after free-text labels and unrelated answers; only a later valid click grants authority', async () => {
    const { session, selection, pending } = await pendingSession(); responses.push(query());
    const free = await turn(session.id, 1, 'label', { message: '계약 종료일' });
    expect(free.result.clarification.id).toBe(pending.id); expect(queryPlan).not.toHaveBeenCalled();
    expect((await raw.get(ctx, session.id)).serverState?.dateBasis).toBeUndefined();
    responses.push({ action: 'answer', interpretation: understood(null), answer: '조회 전 필요한 항목을 설명합니다.', evidenceIds: [] });
    await turn(session.id, 2, 'explain');
    expect((await raw.get(ctx, session.id)).pendingClarification.id).toBe(pending.id);
    responses.push(query(), 'answer'); await turn(session.id, 3, 'click', { selection });
    expect((await raw.get(ctx, session.id)).serverState.dateBasis.field).toBe('contract_end'); expect(queryPlan).toHaveBeenCalledTimes(1);
  });
  it.each(['wrong-option', 'other-session', 'stale-version', 'scope', 'schema'])('rejects %s before a new turn, model call or SQL', async kind => {
    const { session, selection } = await pendingSession(); let target = session.id, version = 1;
    if (kind === 'wrong-option') selection.optionId = randomUUID();
    if (kind === 'other-session') { target = (await raw.create(ctx)).id; version = 0; }
    if (kind === 'stale-version') version = 0;
    if (kind === 'scope') await db.doc(`${prefix}/members/admin`).update({ analyticsScopeRevision: 'changed' });
    if (kind === 'schema') { const next = data(); next.schema[2].label = '변경된 종료 항목'; next.manifest.sourceRevision = 'schema-v2'; next.manifest.capturedAt = '2026-09-28T00:00:01.000Z'; await analytics.importDataset(ctx, next); }
    await expect(turn(target, version, 'invalid-choice', { selection })).rejects.toMatchObject({ statusCode: 409 });
    expect(complete).not.toHaveBeenCalled(); expect(queryPlan).not.toHaveBeenCalled(); expect((await raw.get(ctx, session.id)).turns).toHaveLength(1);
  });
  it('keeps pending choices usable at the new head after an unrelated model failure', async () => {
    const { session, selection } = await pendingSession();
    const original = (await raw.get(ctx, session.id)).pendingClarification;
    const started = await raw.beginTurn(ctx, session.id, { expectedVersion: 1, requestId: 'failed-question', message: '설명', scopeFingerprint: ctx.analyticsScope.fingerprint });
    await raw.failTurn(ctx, session.id, { turnId: started.turnId });
    const saved = await raw.get(ctx, session.id); expect(saved.pendingClarification.issued.version).toBe(2); expect(saved.pendingClarification.id).toBe(selection.clarificationId);
    expect(saved.pendingClarification).toEqual({ ...original, issued: { ...original.issued, version: 2 } });
    responses.push(query(), 'answer'); await turn(session.id, 2, 'select-after-failure', { selection });
    expect(queryPlan).toHaveBeenCalledTimes(1); expect((await raw.get(ctx, session.id)).serverState.dateBasis.field).toBe('contract_end');
  });
  it('rejects forged authority fields in the client request before persisting or calling the model', async () => {
    const { session, selection } = await pendingSession();
    for (const extra of [{ serverState: { dateBasis: { field: 'contract_end' } } }, { selection: { ...selection, field: 'contract_end' } }]) {
      await expect(turn(session.id, 1, 'forged', extra)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(complete).not.toHaveBeenCalled(); expect(queryPlan).not.toHaveBeenCalled(); expect((await raw.get(ctx, session.id)).turns).toHaveLength(1);
  });
  it('allows a fresh copy without re-confirming the same date definition and executes that immutable version', async () => {
    const { session, selection } = await pendingSession(), next = data(); next.manifest.sourceRevision = 'copy-v2'; next.manifest.capturedAt = '2026-09-28T00:00:01.000Z'; next.rows[0].name = '새 사본 종료 사업';
    const imported = await analytics.importDataset(ctx, next); responses.push(query(), 'answer'); const result = await turn(session.id, 1, 'choose-new-copy', { selection });
    expect(result.result.evidence[0].datasetVersions).toEqual({ project_dates: imported.version }); expect(result.result.evidence[0].rows).toEqual([{ name: '새 사본 종료 사업' }]);
    const saved = await raw.get(ctx, session.id); expect(saved.serverState.dateBasis.datasetVersion).not.toBe(imported.version); expect(saved.turns[1].result.dateBasisProvenance[0].datasetVersion).toBe(imported.version);
  });
  it('serializes concurrent different selections: one user choice, one active-turn conflict and no overwritten selection', async () => {
    const { session, selection, pending } = await pendingSession(), items = (await analytics.catalog(ctx)).items;
    const calls = [selection, { ...selection, optionId: pending.options[0].id }].map((selected, i) => raw.beginTurn(ctx, session.id, { expectedVersion: 1, requestId: `race-${i}`, message: '선택', scopeFingerprint: ctx.analyticsScope.fingerprint, selection: selected }, { dateCatalogItems: items }));
    const results = await Promise.allSettled(calls), winner = results.find(value => value.status === 'fulfilled');
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1); expect(results.find(value => value.status === 'rejected').reason.code).toBe('conversation_in_progress');
    const saved = await raw.get(ctx, session.id); expect(saved.turns).toHaveLength(2); expect(saved.serverState.dateBasis).toEqual(winner.value.selectedDateBasis); expect(saved.turns[1].selection).toEqual(winner.value.selectedDateBasis);
  });
  it('keeps the chosen column for a later period change, and fails an unbounded query without injecting old filters', async () => {
    const { session } = await selectAndFail(); const october = { ...period, start: '2026-10-01', end: '2026-10-31' }; responses.push(query('contract_end', 'project_dates', october), 'answer');
    const result = await turn(session.id, 2, 'october'); expect(result.result.evidence[0].rows).toEqual([]); expect(result.result.dateBasis.field).toBe('contract_end');
    responses.push(query('contract_end', 'project_dates', null));
    await expect(turn(session.id, 3, 'unbounded', { message: '기간 없이 전체 자료를 보여줘' })).rejects.toMatchObject({ code: 'conversation_date_basis_mismatch' });
    expect(queryPlan).toHaveBeenCalledTimes(1); expect((await raw.get(ctx, session.id)).serverState.dateBasis.field).toBe('contract_end');
  });
  it('clears basis only after a successful other-dataset query, never after model context or a failed query', async () => {
    const { session } = await selectAndFail(); responses.push({ action: 'answer', interpretation: understood(null, 'other_dates'), answer: '다른 자료는 아직 조회하지 않았습니다.', evidenceIds: [] });
    const answerOnly = await turn(session.id, 2, 'only-answer'); expect(answerOnly.result.dateBasis).toBeUndefined();
    expect((await raw.get(ctx, session.id)).serverState.dateBasis.field).toBe('contract_end');
    const failed = Object.assign(new Error('failed query'), { statusCode: 503, code: 'synthetic_db_unavailable' }); queryPlan.mockRejectedValueOnce(failed); responses.push(query('contract_end', 'other_dates'));
    await expect(turn(session.id, 3, 'failed-b')).rejects.toBe(failed); expect((await raw.get(ctx, session.id)).serverState.dateBasis.field).toBe('contract_end');
    responses.push(query('contract_end', 'other_dates'), 'answer'); const result = await turn(session.id, 4, 'success-b');
    expect(result.result.dateBasis).toBeUndefined(); expect((await raw.get(ctx, session.id)).serverState.dateBasis).toBeNull(); expect((await service().get(context(), session.id)).dateBasis).toBeUndefined();
  });
  it('does not label an answer with a query basis when that answer does not use the actual query evidence', async () => {
    const { session } = await selectAndFail();
    responses.push(query(), { action: 'answer', interpretation: understood(null), answer: '조회 방법만 설명합니다.', evidenceIds: [] });
    const result = await turn(session.id, 2, 'query-unused');
    expect(queryPlan).toHaveBeenCalledTimes(1); expect(result.result.evidence).toEqual([]); expect(result.result.dateBasis).toBeUndefined();
    expect((await service().get(context(), session.id)).dateBasis.field).toBe('contract_end');
  });
  it('clears an unresolved other-dataset pending choice on successful dataset switching', async () => {
    const { session } = await pendingSession(); responses.push(query('contract_end', 'other_dates'), 'answer'); await turn(session.id, 1, 'query-b');
    expect((await raw.get(ctx, session.id)).pendingClarification).toBeNull();
  });
  it('shows stale basis notice after schema changes and hides all basis state after scope change', async () => {
    const { session } = await selectAndFail(); const next = data(); next.schema[2].label = '바뀐 항목'; next.manifest.sourceRevision = 'schema-v2'; next.manifest.capturedAt = '2026-09-28T00:00:01.000Z'; await analytics.importDataset(ctx, next);
    const stale = await service().get(context(), session.id); expect(stale.dateBasis).toBeUndefined(); expect(stale.dateBasisNotice).toContain('다시 선택');
    responses.push(query()); await expect(turn(session.id, 2, 'stale-basis')).rejects.toMatchObject({ code: 'conversation_date_choice_stale' }); expect(queryPlan).not.toHaveBeenCalled();
    await db.doc(`${prefix}/members/admin`).update({ analyticsScopeRevision: 'changed', analyticsDatasetIds: [] });
    const hidden = await service().get(context(), session.id); expect(hidden.dateBasis).toBeUndefined(); expect(hidden.dateBasisNotice).toBeUndefined(); expect(hidden.serverState).toBeUndefined(); expect(hidden.pendingClarification).toBeNull();
    expect(hidden.turns.every(value => value.selection === undefined && value.result?.dateBasis === undefined)).toBe(true);
  });
});
