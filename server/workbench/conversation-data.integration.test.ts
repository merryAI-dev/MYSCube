import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Firestore } from '@google-cloud/firestore';
import { createWorkbenchApp } from './app.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createAnalyticsService } from './analytics-service.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('copied rows → real SQL → persistent conversation → exact HTML binding (fixture planner)', () => {
  const env = { WORKBENCH_PROJECT_ID: 'demo-conversation-data', PRODUCTION_PROJECT_ID: 'demo-data-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-data-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-business-model', WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'local-fixture-only' };
  const db = new Firestore({ projectId: env.WORKBENCH_PROJECT_ID });
  const tenantId = 'conversation-data-it', root = `orgs/${tenantId}`, actorId = 'admin-a';
  const now = () => '2026-09-22T12:00:00.000Z';
  const analytics = createAnalyticsService({ db, now });
  const core = createIsolatedWorkbenchCore({ db, env, now });
  const context: any = { tenantId, actorId, actorRole: 'admin' };
  const selected = { period: { start: '2026-09-01', end: '2026-09-30', label: '2026년 9월', basis: 'explicit_request' }, datasetIds: ['weekly_submission'], filters: {}, evidenceIds: [] };
  const interpretation = (value: any = selected) => ({ summary: '2026년 9월 업데이트 대기 상태', context: value, ambiguities: [] });
  const step = (value: any) => ({ tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify(value) } }] });
  let phase = 'clarify', modelCalls = 0, historySeen = '';
  const complete = async ({ messages }: any) => {
    modelCalls++; historySeen = JSON.stringify(messages);
    if (phase === 'clarify') return step({ action: 'clarify', interpretation: { summary: '연도 확인 필요', context: { datasetIds: [], filters: {}, evidenceIds: [] }, ambiguities: [{ field: 'year', reason: '연도가 지정되지 않았습니다.', question: '어느 연도 9월인가요?', options: [{ id: '2026', label: '2026년 9월' }] }] } });
    const queryResult = messages.findLast((message: any) => message.content.startsWith('조회 도구 결과'));
    if (!queryResult) return step({ action: 'query', interpretation: interpretation(), plan: { datasetId: 'weekly_submission', definitionVersion: '1', select: ['project_id', 'revision', 'submitted_at'], filters: [{ field: 'status', op: 'eq', value: 'WAITING_FOR_UPDATE' }], time: { yearMonth: '2026-09', weekScope: 'all' }, orderBy: [{ field: 'project_id', direction: 'asc' }] } });
    const evidence = JSON.parse(queryResult.content.slice(queryResult.content.indexOf(':') + 1));
    return step({ action: 'render', interpretation: interpretation(), answer: '확인한 업데이트 대기 사업을 표에 연결했습니다. 승인 대기와 구분하며 재수정 요청도 포함할 수 있습니다.',
      title: '주정산 확인', html: '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>주정산 확인</title></head><body class="bg-slate-50 p-8"><main><h1 class="text-2xl">주정산 확인</h1><section data-binding="projects"></section></main></body></html>', bindings: [{ id: 'projects', evidenceId: evidence.evidenceId, kind: 'table' }] });
  };
  const app = () => createWorkbenchApp({ db, env, now, authMode: 'headers', analytics, conversationCompletionFactory: () => complete });
  const call = (verb: string, path: string) => (request(app()) as any)[verb](`/api/v1${path}`).set('x-tenant-id', tenantId).set('x-actor-id', actorId).set('Idempotency-Key', crypto.randomUUID());
  beforeEach(async () => {
    await db.recursiveDelete(db.doc(root)); phase = 'clarify'; modelCalls = 0;
    delete context.analyticsScope;
    await db.doc(`${root}/members/${actorId}`).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now(), analyticsDatasetIds: ['weekly_submission'], analyticsScopeRevision: 'v1' });
    await core.authorize(context);
    await analytics.importDataset(context, { datasetId: 'weekly_submission', manifest: { semanticDefinitionId: 'weekly_submission', semanticDefinitionVersion: '1', sourceRevision: 'fixture-revision', asOf: now(), capturedAt: now(), completeness: 'complete', coverage: { description: '합성 QA용 세 사업이며 운영 자료가 아닙니다.', expectedRows: 3 } },
      schema: [{ name: 'project_id', type: 'string' }, { name: 'year_month', type: 'string' }, { name: 'week_no', type: 'integer' }, { name: 'status', type: 'string' }, { name: 'revision', type: 'integer' }, { name: 'submitted_at', type: 'timestamp' }, { name: 'approved_at', type: 'timestamp' }, { name: 'health', type: 'string' }],
      rows: [{ project_id: '업데이트 대기 사업', year_month: '2026-09', week_no: 1, status: 'WAITING_FOR_UPDATE', revision: 0, submitted_at: null, approved_at: null, health: 'OK' }, { project_id: '승인 대기 사업', year_month: '2026-09', week_no: 1, status: 'PENDING_APPROVAL', revision: 1, submitted_at: now(), approved_at: null, health: 'OK' }, { project_id: '상태 확인 필요', year_month: '2026-09', week_no: 1, status: null, revision: null, submitted_at: null, approved_at: null, health: 'UNAVAILABLE' }] });
  });
  afterAll(async () => { await db.recursiveDelete(db.doc(root)); await db.terminate(); });
  it('clarifies without query, resumes with saved context and saves/restores the same real query values', async () => {
    const session = (await call('post', '/workbench-conversations').send({ title: '확인 질문부터 이어지는 화면' })).body;
    const clarification = await call('post', `/workbench-conversations/${session.id}/turns`).send({ expectedVersion: 0, requestId: 'clarify', message: '9월 업데이트 대기 사업 화면을 보여줘' });
    expect(clarification.status).toBe(200); expect(clarification.body.result.status).toBe('clarification_required'); expect(clarification.body.result.evidence).toBeUndefined();
    phase = 'query-render';
    const resumed = await call('post', `/workbench-conversations/${session.id}/turns`).send({ expectedVersion: 1, requestId: 'resume', message: '2026년 9월' });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(historySeen).toContain('9월 업데이트 대기 사업 화면');
    const result = resumed.body.result, proposal = result.proposal;
    expect(result.evidence[0].rows).toEqual([{ project_id: '업데이트 대기 사업', revision: '0', submitted_at: null }]);
    expect(proposal.html).toContain('업데이트 대기 사업'); expect(proposal.html).toContain('>0<'); expect(proposal.html).toContain('자료 없음');
    expect(result.evidence[0].semantic.definitionVersions).toBeDefined(); expect(proposal.html).not.toContain('승인 대기 사업');
    const saved = await call('post', '/html-work-pages').send({ expectedVersion: 0, source: { title: proposal.title, html: proposal.html }, dataBinding: { template: proposal.template, bindings: proposal.bindings } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const reopened = await call('get', `/html-work-pages/${saved.body.id}`);
    expect(reopened.status).toBe(200); expect(reopened.body.source.html).toBe(proposal.html);
    const review = await call('get', `/html-work-pages/${saved.body.id}/review`);
    expect(review.body.files['template.html']).toContain('data-binding="projects"'); expect(review.body.manifest.evidenceIds).toEqual([result.evidence[0].evidenceId]);
    const reloaded = await call('get', `/workbench-conversations/${session.id}`);
    expect(reloaded.body.turns.map((turn: any) => turn.state)).toEqual(['completed', 'completed']); expect(modelCalls).toBe(3);
  });
});
