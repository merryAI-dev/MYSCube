import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createConversationService } from './conversations.mjs';
import { createReactConversationService } from './react-conversation.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('independent React conversation persistence, clarification and scope QA', () => {
  const db = new Firestore({ projectId: 'demo-react-conversation-qa' });
  const tenantId = 'react-conversation-qa';
  const now = () => '2026-09-23T12:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-react-qa-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-react-qa-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-react-qa-business-model', WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'offline-fixture-only' };
  const core = createIsolatedWorkbenchCore({ db, env, now });
  const apiId = randomUUID();
  const source = { title: '편집 중 원문', code: "import React from 'react'; export default function App(){return <main>편집 중 원문</main>}" };
  const context = () => ({ tenantId, actorId: 'admin-a', actorRole: 'admin' });
  const member = db.doc(`orgs/${tenantId}/members/admin-a`);
  let inputs: any[], refs: number[], responses: any[];
  const tool = (name: string, value: any) => ({ tool_calls: [{ function: { name, arguments: JSON.stringify(value) } }] });
  const service = () => createReactConversationService({ db, now, env, authorize: core.authorize,
    apis: { get: async (_context: any, id: string, version: number) => { expect(id).toBe(apiId); refs.push(version); return { id, version, definition: { kind: 'analytics-copy', name: '고정 API', description: '테스트 조회 정의', parameters: {} } }; } },
    analytics: {}, qa: () => { throw new Error('unexpected QA tool'); },
    completionFactory: ({ onUsage }: any) => async (input: any) => { inputs.push(input); await onUsage({ promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 }); return responses.shift(); },
  });
  beforeEach(async () => { await db.recursiveDelete(db.doc(`orgs/${tenantId}`)); await member.set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now(), analyticsDatasetIds: ['weekly'], analyticsScopeRevision: 'A' }); inputs = []; refs = []; responses = []; });
  afterAll(async () => { await db.recursiveDelete(db.doc(`orgs/${tenantId}`)); await db.terminate(); });

  it('reopens pending clarification with original source/API pins, then persists a compiled proposal and idempotent turn', async () => {
    responses.push(tool('clarify_react_request', { question: '표와 카드 중 무엇을 원하시나요?', reason: '화면 구성 확인', options: [{ id: 'table', label: '표' }, { id: 'cards', label: '카드' }] }));
    const session = await service().create(context(), { title: '연결 대화' });
    const first = await service().turn(context(), session.id, { expectedVersion: 0, requestId: 'first', mode: 'react', message: '보기 좋은 화면으로 만들어 주세요', currentSource: source, apis: [{ id: apiId, version: 2 }] });
    expect(first.result.type).toBe('clarification'); expect(first.result.source).toBeUndefined();
    const reopened = await service().get(context(), session.id);
    expect(reopened.reactContext.source).toEqual(source); expect(reopened.reactContext.apis).toEqual([{ id: apiId, version: 2 }]);
    expect(reopened.pendingClarification.originalMessage).toBe('보기 좋은 화면으로 만들어 주세요');
    responses.push(tool('render_react_source', { title: '표 제안', code: "import React from 'react'; export default function App(){return <main className='p-4'>표 제안</main>}" }));
    const next = { expectedVersion: 1, requestId: 'followup', mode: 'react', message: '표로 해 주세요', clarificationId: reopened.pendingClarification.id };
    const second = await service().turn(context(), session.id, next);
    expect(second.result.type).toBe('source'); expect(second.result.compiled.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(inputs[1].messages)).toContain('보기 좋은 화면으로 만들어 주세요');
    expect(JSON.stringify(inputs[1].messages)).toContain('편집 중 원문'); expect(new Set(refs)).toEqual(new Set([2]));
    const replay = await service().turn(context(), session.id, next); expect(replay.replayed).toBe(true); expect(inputs).toHaveLength(2);
    const saved = await service().get(context(), session.id); expect(saved.turns).toHaveLength(2); expect(saved.reactContext.source).toEqual(source); expect(saved.turns[1].result.source.title).toBe('표 제안');
    expect(saved.turns[1].result.telemetry.totalTokens).toBe(5);
  });

  it('redacts prior source and pending context after scope change and never resends it to the model', async () => {
    responses.push(tool('render_react_source', { title: 'A 자료', code: "import React from 'react'; export default function App(){return <main>A_SCOPE_SECRET</main>}" }));
    const session = await service().create(context());
    await service().turn(context(), session.id, { expectedVersion: 0, requestId: 'a', message: '화면 제안', mode: 'react', currentSource: source, apis: [] });
    await member.update({ analyticsScopeRevision: 'B', analyticsDatasetIds: [] });
    const redacted = await service().get(context(), session.id); expect(JSON.stringify(redacted)).not.toContain('A_SCOPE_SECRET'); expect(redacted.reactContext).toBeNull();
    await expect(service().turn(context(), session.id, { expectedVersion: 1, requestId: 'b', message: '그걸 수정해줘', mode: 'react' })).rejects.toMatchObject({ code: 'react_conversation_scope_changed' });
    expect(inputs).toHaveLength(1);
    expect(JSON.stringify(await service().get(context(), session.id))).not.toContain('A_SCOPE_SECRET');
  });

  it('opens an existing analysis session in React without consuming its old clarification or changing its stored turn', async () => {
    const original = createConversationService({ db, now }); const ctx: any = context(); await core.authorize(ctx);
    const session = await original.create(ctx, { title: '자료와 화면 연결' });
    const begun = await original.beginTurn(ctx, session.id, { expectedVersion: 0, requestId: 'analysis', message: '9월 자료', scopeFingerprint: ctx.analyticsScope.fingerprint });
    const pendingId = randomUUID();
    await original.completeTurn(ctx, session.id, { turnId: begun.turnId, result: { type: 'clarification', status: 'clarification_required', answer: '어느 연도인가요?', scopeFingerprint: ctx.analyticsScope.fingerprint, clarification: { id: pendingId, mode: 'analysis', question: '어느 연도인가요?', originalMessage: '9월 자료' }, context: { scopeFingerprint: ctx.analyticsScope.fingerprint } } });
    const prior = (await original.get(ctx, session.id)).turns[0];
    responses.push(tool('answer_react_request', { answer: '먼저 화면 배치를 정할 수 있습니다.' }));
    const result = await service().turn(context(), session.id, { expectedVersion: 1, requestId: 'react', mode: 'react', message: '조회 말고 화면 배치를 설명해줘', currentSource: source, apis: [] });
    expect(result.result.type).toBe('answer'); expect(inputs[0].messages[0].content).toContain('Pending clarification (data):null');
    const stored = await original.get(ctx, session.id); expect(stored.turns[0]).toEqual(prior); expect(stored.turns).toHaveLength(2);
  });
});
