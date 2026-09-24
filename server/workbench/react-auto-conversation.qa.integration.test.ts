import { createHash, randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createAnalyticsService } from './analytics-service.mjs';
import { createRegisteredApiService } from './registered-apis.mjs';
import { createReactConversationService } from './react-conversation.mjs';
import { validateReactScreenBindings } from './react-screen-bindings.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('independent auto conversation uses the actual copied query and pinned API semantics', () => {
  const db = new Firestore({ projectId: 'demo-auto-conversation-independent' });
  const tenantId = 'auto-conversation-independent', actorId = 'qa', root = `orgs/${tenantId}`;
  const now = () => '2026-09-24T10:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-other-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-auto-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-other-model', WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'offline-fixture-only' };
  const core = createIsolatedWorkbenchCore({ db, env, now });
  const analytics = createAnalyticsService({ db, now });
  const apis = createRegisteredApiService({ db, analytics, authorize: core.authorize, now, env });
  const member = db.doc(`${root}/members/${actorId}`);
  let context: any, api: any, captureSequence = 0;
  const plan = { datasetId: 'weekly_submission', definitionVersion: '1', select: ['project_id', 'status'],
    filters: [{ field: 'status', op: 'eq', value: 'WAITING_FOR_UPDATE' }, { field: 'project_id', op: 'eq', value: 'SYNTHETIC_ROW_ONLY' }], time: { yearMonth: '2026-09', weekNo: 1 } };
  const selected = { datasetIds: ['weekly_submission'], period: { start: '2026-09-01', end: '2026-09-30', label: '2026년 9월', basis: 'explicit_request' }, filters: {}, evidenceIds: [] };
  const interpretation = { summary: '2026년 9월 첫 정산주 업데이트 대기 사업', context: selected, ambiguities: [] };
  const source = { title: '현재 편집본', code: 'export default function App(){return <h1>편집 보존</h1>}' };
  const tool = (name: string, value: any) => ({ tool_calls: [{ function: { name, arguments: JSON.stringify(value) } }] });
  const seed = async (revision: string) => analytics.importDataset(context, { datasetId: 'weekly_submission', manifest: { semanticDefinitionId: 'weekly_submission', semanticDefinitionVersion: '1', sourceRevision: revision, asOf: now(), capturedAt: new Date(Date.parse(now()) - 60000 + ++captureSequence * 1000).toISOString(), completeness: 'complete', coverage: { description: '독립 QA 합성 사본', expectedRows: 1 } },
    schema: [{ name: 'project_id', type: 'string' }, { name: 'year_month', type: 'string' }, { name: 'week_no', type: 'integer' }, { name: 'status', type: 'string' }, { name: 'revision', type: 'integer' }, { name: 'submitted_at', type: 'timestamp' }, { name: 'approved_at', type: 'timestamp' }, { name: 'health', type: 'string' }],
    rows: [{ project_id: 'SYNTHETIC_ROW_ONLY', year_month: '2026-09', week_no: 1, status: 'WAITING_FOR_UPDATE', revision: 0, submitted_at: null, approved_at: null, health: 'OK' }] });
  beforeEach(async () => {
    await db.recursiveDelete(db.doc(root)); captureSequence = 0;
    await member.set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now(), analyticsDatasetIds: ['weekly_submission'], analyticsScopeRevision: '1' });
    context = { tenantId, actorId, actorRole: 'admin', idempotencyKey: randomUUID() }; await core.authorize(context);
    await seed('fixture-v1');
    api = await apis.save(context, null, { expectedVersion: 0, definition: { name: '업데이트 대기 사본', description: '합성자료의 의미 연결', kind: 'analytics-copy', enabled: true, parameters: {}, plan } });
  });
  afterAll(async () => { await db.recursiveDelete(db.doc(root)); await db.terminate(); });

  const actualBinding = async () => {
    const queried = await analytics.queryPlan(context, plan);
    const evidence = await analytics.evidence(context, queried.evidenceId);
    return { binding: { apiId: api.id, apiVersion: api.version, input: {}, evidenceId: evidence.evidenceId }, evidence };
  };
  it('matches persisted SQL evidence, permits AND filter reordering, and rejects period/status/column order/version drift', async () => {
    const { binding, evidence } = await actualBinding(), catalog = await analytics.catalog(context);
    expect(evidence.rows).toEqual([{ project_id: 'SYNTHETIC_ROW_ONLY', status: 'WAITING_FOR_UPDATE' }]);
    const invoke = (candidate: any, proof: any = evidence) => validateReactScreenBindings({ bindings: [binding], evidence: [proof], apis: [candidate], catalog });
    expect(invoke({ ...api, definition: { ...api.definition, plan: { ...plan, filters: [...plan.filters].reverse() } } })[0].evidenceId).toBe(evidence.evidenceId);
    for (const changedPlan of [{ ...plan, time: { yearMonth: '2026-10', weekNo: 1 } }, { ...plan, select: [...plan.select].reverse() },
      { ...plan, filters: [{ field: 'status', op: 'eq', value: 'PENDING_APPROVAL' }, plan.filters[1]] }]) {
      expect(() => invoke({ ...api, definition: { ...api.definition, plan: changedPlan } })).toThrow(expect.objectContaining({ code: 'react_screen_binding_mismatch' }));
    }
    const forged = structuredClone(evidence); forged.semantic.definitionVersions.weekly_submission.hash = 'f'.repeat(64);
    expect(() => invoke(api, forged)).toThrow(expect.objectContaining({ code: 'react_screen_binding_mismatch' }));
    expect(() => invoke({ ...api, version: 2 })).toThrow(expect.objectContaining({ code: 'react_screen_binding_mismatch' }));
    await seed('fixture-v2');
    expect(() => validateReactScreenBindings({ bindings: [binding], evidence: [evidence], apis: [api], catalog: { ...catalog, items: [] } })).toThrow();
    const latest = await analytics.catalog(context);
    expect(() => validateReactScreenBindings({ bindings: [binding], evidence: [evidence], apis: [api], catalog: latest })).toThrow(expect.objectContaining({ code: 'react_screen_binding_mismatch' }));
  });

  const scenario = (fault?: 'mismatch' | 'revoke' | 'dataset-change' | 'dataset-change-during-generation') => {
    const calls: any[] = []; let generated = 0, querySteps = 0;
    const service = createReactConversationService({ db, now, env, authorize: core.authorize, apis, analytics, qa: core.qa,
      completionFactory: () => async (input: any) => {
        calls.push(input);
        if (input.tools[0].function.name === 'workbench_step') {
          const resultMessage = input.messages.findLast((message: any) => message.content.startsWith('조회 도구 결과'));
          if (!resultMessage) { querySteps++; return tool('workbench_step', { action: 'query', interpretation, plan }); }
          const evidence = JSON.parse(resultMessage.content.slice(resultMessage.content.indexOf(':') + 1));
          if (fault === 'revoke') await member.update({ status: 'INACTIVE' });
          if (fault === 'dataset-change') await seed('changed-during-turn');
          return tool('workbench_step', { action: 'build_screen', interpretation, purpose: 'connected', request: '확인한 조건으로 조회하는 화면을 만들어 주세요', evidenceIds: [evidence.evidenceId],
            bindings: [{ apiId: api.id, apiVersion: fault === 'mismatch' ? 999 : api.version, input: {}, evidenceId: evidence.evidenceId }] });
        }
        generated++;
        if (fault === 'dataset-change-during-generation') await seed('changed-inside-generator');
        // The sentinel exists in a result row and in the API filter. Forbid serialized result rows, not the approved API definition.
        expect(JSON.stringify(input.messages)).not.toContain('"rows":');
        return tool('render_react_source', { title: '조회 연결 제안', workspace: { schemaVersion: 1, entry: 'App.tsx', packageSetId: 'react18-tailwind4-v1', files: {
          'App.tsx': `import React from 'react'; export default function App(){return <button onClick={()=>{void window.workbench.callApi('${api.id}',{})}}>다시 조회</button>}`,
        } } });
      } });
    return { service, calls, counts: () => ({ generated, querySteps }) };
  };
  it('one auto turn performs actual query → validated screen proposal, persists context and never automatically saves a page', async () => {
    const { service, calls, counts } = scenario(), session = await service.create(context);
    const input = { expectedVersion: 0, requestId: 'query-and-build', mode: 'auto', message: '2026년 9월 첫 정산주 업데이트 대기 사업을 조회해서 화면으로 만들어줘', currentSource: source, apis: [{ id: api.id, version: api.version }] };
    const result = await service.turn(context, session.id, input);
    expect(result.result.type).toBe('source'); expect(result.result.screenBindings).toHaveLength(1); expect(counts()).toEqual({ generated: 1, querySteps: 1 });
    expect(result.result.compiled.sourceHash).toMatch(/^[a-f0-9]{64}$/); expect(result.result.baseEditorIdentity).toBeTruthy();
    expect((await service.get(context, session.id)).reactContext.source).toEqual(source);
    expect((await db.collection(`${root}/react_work_pages/${createHash('sha256').update(actorId).digest('hex')}/pages`).get()).empty).toBe(true);
    const before = calls.length; expect((await service.turn(context, session.id, input)).replayed).toBe(true); expect(calls).toHaveLength(before);
  });
  it.each(['mismatch', 'dataset-change'] as const)('asks for matching evidence/API after %s without invoking generator', async (fault) => {
    const { service, counts } = scenario(fault), session = await service.create(context);
    const result = await service.turn(context, session.id, { expectedVersion: 0, requestId: fault, mode: 'auto', message: '조회하고 화면을 만들어줘', currentSource: source, apis: [{ id: api.id, version: api.version }] });
    expect(result.result.type).toBe('clarification'); expect(result.result.source).toBeUndefined(); expect(counts().generated).toBe(0);
    expect((await service.get(context, session.id)).reactContext.source).toEqual(source);
  });
  it('returns durable clarification when the copied dataset changes while the generator is producing source', async () => {
    const { service, counts } = scenario('dataset-change-during-generation'), session = await service.create(context);
    const input = { expectedVersion: 0, requestId: 'changed-during-generation', mode: 'auto', message: '조회해서 화면을 만들어줘', currentSource: source, apis: [{ id: api.id, version: api.version }] };
    const result = await service.turn(context, session.id, input);
    expect(counts()).toEqual({ generated: 1, querySteps: 1 });
    expect(result.result.type).toBe('clarification');
    expect(result.result.source).toBeUndefined();
    expect(result.result.compiled).toBeUndefined();
    const persisted = await service.get(context, session.id);
    expect(persisted.reactContext.source).toEqual(source);
    expect((await db.collection(`${root}/react_work_pages/${createHash('sha256').update(actorId).digest('hex')}/pages`).get()).empty).toBe(true);
    expect((await service.turn(context, session.id, input)).replayed).toBe(true);
    expect(counts()).toEqual({ generated: 1, querySteps: 1 });
  });
  it('stops after persisted membership revocation between query and screen action', async () => {
    const { service, counts } = scenario('revoke'), session = await service.create(context);
    await expect(service.turn(context, session.id, { expectedVersion: 0, requestId: 'revoked', mode: 'auto', message: '조회해서 화면을 만들어줘', currentSource: source, apis: [{ id: api.id, version: api.version }] })).rejects.toMatchObject({ statusCode: 403 });
    expect(counts().generated).toBe(0);
  });
});
