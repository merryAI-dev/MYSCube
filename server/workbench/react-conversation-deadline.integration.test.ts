import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createReactConversationService } from './react-conversation.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('React conversation failure and competing answers', () => {
  const db = new Firestore({ projectId: 'demo-react-conversation-deadline' }), tenantId = 'react-conversation-deadline';
  const now = () => '2026-09-23T12:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-other-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-react-deadline-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-other-model', WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'fixture-only' };
  const core = createIsolatedWorkbenchCore({ db, env, now });
  const context = () => ({ tenantId, actorId: 'admin', actorRole: 'admin' });
  const result = { tool_calls: [{ function: { name: 'answer_react_request', arguments: JSON.stringify({ answer: '수정 없이 설명만 제공합니다.' }) } }] };
  const service = (complete: any, deadlineMs = 2000) => createReactConversationService({ db, now, env, authorize: core.authorize, apis: { get: async () => { throw new Error('unexpected API'); } }, analytics: {}, qa: () => {}, completionFactory: () => complete, deadlineMs });
  beforeEach(async () => { await db.recursiveDelete(db.doc(`orgs/${tenantId}`)); await db.doc(`orgs/${tenantId}/members/admin`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now(), analyticsDatasetIds: [], analyticsScopeRevision: 'v1' }); });
  afterAll(async () => { await db.recursiveDelete(db.doc(`orgs/${tenantId}`)); await db.terminate(); });
  it('releases a failed turn and tenant lease even when the provider ignores abort; a late result cannot become a proposal', async () => {
    let release: (value: any) => void = () => {}, called = false;
    const slow = service(async () => { called = true; return new Promise((resolve) => { release = resolve; }); }, 400);
    const session = await slow.create(context());
    await expect(slow.turn(context(), session.id, { expectedVersion: 0, requestId: 'timeout', message: '화면 설명' })).rejects.toMatchObject({ code: 'conversation_deadline' });
    expect(called).toBe(true);
    const failed = await slow.get(context(), session.id); expect(failed.version).toBe(1); expect(failed.turns[0].state).toBe('failed'); expect(failed.active).toBeNull(); expect(failed.reactContext).toBeNull();
    expect((await db.doc(`orgs/${tenantId}/html_generation_locks/active`).get()).exists).toBe(false);
    release({ tool_calls: [{ function: { name: 'render_react_source', arguments: JSON.stringify({ title: '늦은 제안', code: 'export default function App(){return <p>늦음</p>}' }) } }] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await slow.get(context(), session.id)).turns[0].result).toBeUndefined();
    const retry = await service(async () => result).turn(context(), session.id, { expectedVersion: 1, requestId: 'retry', message: '다시 설명' });
    expect(retry.result.type).toBe('answer'); expect(retry.version).toBe(2);
  });
  it('rejects a competing answer and stale version without another provider call', async () => {
    let release: (value: any) => void = () => {}, started: () => void = () => {}, calls = 0;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const api = service(async () => { calls++; started(); return new Promise((resolve) => { release = resolve; }); });
    const session = await api.create(context());
    const first = api.turn(context(), session.id, { expectedVersion: 0, requestId: 'a', message: '설명' }); await ready;
    await expect(api.turn(context(), session.id, { expectedVersion: 0, requestId: 'b', message: '다른 답변' })).rejects.toMatchObject({ statusCode: 409 });
    release(result); await first;
    await expect(api.turn(context(), session.id, { expectedVersion: 0, requestId: 'c', message: '예전 버전 답변' })).rejects.toMatchObject({ statusCode: 409 });
    expect(calls).toBe(1); expect((await api.get(context(), session.id)).turns).toHaveLength(1);
  });
});
