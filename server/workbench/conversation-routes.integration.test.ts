import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Firestore } from '@google-cloud/firestore';
import { createWorkbenchApp } from './app.mjs';
import { HTML_EXAMPLE } from './html-references.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
const tenantId = 'conversation-http';
const root = `orgs/${tenantId}`;
const env = { WORKBENCH_PROJECT_ID: 'demo-conversation-http', PRODUCTION_PROJECT_ID: 'demo-business-app', WORKBENCH_MODEL_PROJECT_ID: 'demo-conversation-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-business-model', WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'fixture-never-sent' };
const interpretation = { summary: '연도를 확인해야 합니다.', context: { datasetIds: [], filters: {}, evidenceIds: [] }, ambiguities: [{ field: 'year', reason: '연도가 없습니다.', question: '어느 연도 9월인가요?', options: [{ id: 'year-2026', label: '2026년 9월' }] }] };
const clarification = () => ({ tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify({ action: 'clarify', interpretation }) } }] });
const analytics = { catalog: vi.fn(async () => ({ datasets: [] })), query: vi.fn(), evidence: vi.fn() };

suite('isolated conversation HTTP contracts (fixture completion, no live AI)', () => {
  const db = new Firestore({ projectId: env.WORKBENCH_PROJECT_ID });
  const complete = vi.fn(async () => clarification());
  const now = () => '2026-09-22T13:00:00.000Z';
  const app = (overrides: Record<string, unknown> = {}) => createWorkbenchApp({ db, env, now, authMode: 'headers', analytics, conversationCompletionFactory: () => complete, ...overrides });
  const call = (verb: string, path: string, actor = 'admin-a', overrides: Record<string, unknown> = {}) => (request(app(overrides)) as any)[verb](`/api/v1${path}`).set('x-tenant-id', tenantId).set('x-actor-id', actor).set('Idempotency-Key', crypto.randomUUID());
  const create = async (actor = 'admin-a') => (await call('post', '/workbench-conversations', actor).send({ title: '9월 확인' })).body;
  const turnBody = (version: number, requestId = 'request-1', source = HTML_EXAMPLE) => ({ expectedVersion: version, requestId, message: '9월 미제출 사업을 확인해 주세요.', currentSource: { title: '현재 화면', html: source } });

  beforeEach(async () => {
    await db.recursiveDelete(db.doc(root)); complete.mockClear(); analytics.catalog.mockClear();
    for (const [id, role] of [['admin-a', 'admin'], ['admin-b', 'admin'], ['member-a', 'member']] as const) {
      await db.doc(`${root}/members/${id}`).set({ status: 'ACTIVE', role, permissionsCapturedAt: now(), analyticsDatasetIds: [], analyticsScopeRevision: 'scope-v1' });
    }
  });
  afterAll(async () => { await db.recursiveDelete(db.doc(root)); await db.terminate(); });

  it('persists a clarification turn through HTTP and replays one request id without a second model call', async () => {
    const session = await create();
    const first = await call('post', `/workbench-conversations/${session.id}/turns`).send(turnBody(0));
    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({ status: 'clarification_required', clarification: { question: '어느 연도 9월인가요?' } });
    const replay = await call('post', `/workbench-conversations/${session.id}/turns`).send(turnBody(0));
    expect(replay.status).toBe(200); expect(replay.body.replayed).toBe(true); expect(complete).toHaveBeenCalledTimes(1);
    const canonical = await call('get', `/workbench-conversations/${session.id}`);
    expect(canonical.body.turns).toHaveLength(1); expect(canonical.body.turns[0]).toMatchObject({ state: 'completed', message: turnBody(0).message, result: { status: 'clarification_required' } });
  });

  it('treats same request id with a different source hash as a conflict and preserves the first turn', async () => {
    const session = await create();
    await expect(call('post', `/workbench-conversations/${session.id}/turns`).send(turnBody(0))).resolves.toMatchObject({ status: 200 });
    const changed = await call('post', `/workbench-conversations/${session.id}/turns`).send(turnBody(0, 'request-1', `${HTML_EXAMPLE} `));
    expect(changed.status).toBe(409); expect(changed.body.error).toBe('conversation_request_conflict'); expect(complete).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale expectedVersion before another model call', async () => {
    const session = await create();
    await call('post', `/workbench-conversations/${session.id}/turns`).send(turnBody(0));
    const stale = await call('post', `/workbench-conversations/${session.id}/turns`).send(turnBody(0, 'request-2'));
    expect(stale.status).toBe(409); expect(stale.body.error).toBe('conversation_version_conflict'); expect(complete).toHaveBeenCalledTimes(1);
  });

  it('keeps saved HTML page reads available when the conversation model is disabled', async () => {
    const disabledEnv = { ...env, WORKBENCH_AI_ENABLED: 'false', WORKBENCH_GEMINI_API_KEY: '' };
    const session = await call('post', '/workbench-conversations', 'admin-a', { env: disabledEnv }).send({ title: '설정 전' });
    const rejected = await call('post', `/workbench-conversations/${session.body.id}/turns`, 'admin-a', { env: disabledEnv }).send(turnBody(0));
    expect(rejected.status).toBe(503); expect(rejected.body.error).toBe('conversation_model_unconfigured');
    expect((await call('get', '/html-work-pages', 'admin-a', { env: disabledEnv })).status).toBe(200);
  });

  it('records a failed deadline turn and keeps actors isolated', async () => {
    const never = vi.fn(() => new Promise(() => {}));
    const session = await create();
    const timed = await call('post', `/workbench-conversations/${session.id}/turns`, 'admin-a', { conversationCompletionFactory: () => never, conversationDeadlineMs: 5 }).send(turnBody(0));
    expect(timed.status).toBe(504); expect(timed.body.error).toBe('conversation_deadline');
    const own = await call('get', `/workbench-conversations/${session.id}`);
    expect(own.body.turns[0]).toMatchObject({ state: 'failed', error: { code: 'conversation_deadline' } });
    expect((await call('get', `/workbench-conversations/${session.id}`, 'admin-b')).status).toBe(404);
    expect((await call('get', `/workbench-conversations/${session.id}`, 'member-a')).status).toBe(403);
  });
});
