import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import { createAnalyticsService } from './analytics-service.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createConversationService } from './conversations.mjs';
import { createReactConversationService } from './react-conversation.mjs';
import { issueDateColumnChoice } from './date-column-choice.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('independent date choice race challenges', () => {
  const db = new Firestore({ projectId: 'demo-date-choice-it' }), tenantId = `date-choice-qa-${randomUUID()}`, prefix = `orgs/${tenantId}`;
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

  it('rejects schema replacement after selection and during completion before any SQL', async () => {
    const {session,selection}=await pendingSession();
    complete.mockImplementationOnce(async()=>{
      const next=data();next.schema[2].label='Changed date meaning';next.manifest.sourceRevision='qa-schema';next.manifest.capturedAt='2026-09-28T00:00:01.000Z';
      await analytics.importDataset(ctx,next);
      return {tool_calls:[{function:{name:'workbench_step',arguments:JSON.stringify(query())}}]};
    });
    await expect(turn(session.id,1,'qa-schema',{selection})).rejects.toMatchObject({code:'conversation_date_choice_stale'});
    expect(queryPlan).not.toHaveBeenCalled();
    const saved=await raw.get(ctx,session.id);expect(saved.turns[1].state).toBe('failed');expect(saved.serverState.dateBasis.field).toBe('contract_end');
    const visible=await service().get(context(),session.id);expect(visible.dateBasis).toBeUndefined();expect(visible.dateBasisNotice).toBeTruthy();
  });
  it('discards query response after membership revocation and does not complete the turn', async()=>{
    const {session,selection}=await pendingSession();responses.push(query());
    queryPlan.mockImplementationOnce(async(...args)=>{const result=await analytics.queryPlan(...args);await db.doc(`${prefix}/members/admin`).update({status:'INACTIVE'});return result;});
    await expect(turn(session.id,1,'qa-revoke',{selection})).rejects.toMatchObject({statusCode:403});
    expect(queryPlan).toHaveBeenCalledTimes(1);expect(complete).toHaveBeenCalledTimes(1);
    const saved=await raw.get(ctx,session.id);expect(saved.turns[1].state).toBe('failed');expect(saved.turns[1].result).toBeUndefined();expect(saved.active).toBeNull();
    await expect(service().get(context(),session.id)).rejects.toMatchObject({statusCode:403});
  });
});
