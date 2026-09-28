import express from 'express';
import request from 'supertest';
import { randomUUID, createHash } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountWorkbenchAssistantRoutes } from '../bff/workbench-assistant.mjs';
import { createIdempotencyService } from '../bff/idempotency.mjs';
import { createWorkbenchApp } from './app.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('shared assistant model DI preserves legacy callers and isolated credentials', () => {
  const db = new Firestore({ projectId: 'demo-workbench-model-di' });
  const tenantId = 'model-di-qa', actorId = 'admin'; const root = `orgs/${tenantId}`;
  const now = () => new Date().toISOString();
  let logs: string[] = []; const logSpies: any[] = [];
  const LEGACY = 'synthetic-legacy-key-sentinel', ISOLATED = 'synthetic-isolated-key-sentinel';
  const mixedEnv = { PRODUCT_WORKBENCH_AI_ENABLED: 'true', SETTLEMENT_AGENT_GEMINI_API_KEY: LEGACY, WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: ISOLATED };
  const config = { schemaVersion: 1, title: 'Synthetic page', description: '', source: 'service-guidance', presentation: 'table', yearMonth: '2026-09', search: '' };
  const question = { question: '업무 화면 구성', yearMonth: '2026-09' };
  const headers = () => ({ 'x-tenant-id': tenantId, 'x-actor-id': actorId, 'idempotency-key': randomUUID() });
  const factory = () => vi.fn(() => async () => ({ tool_calls: [{ function: { name: 'propose_page', arguments: JSON.stringify(config) } }] }));
  function legacy(completionFactory: any, extra: any = {}) {
    const app = express(); app.use(express.json());
    app.use((req: any, _res, next) => { req.context = { tenantId, actorId, actorRole: req.header('x-actor-role') || 'admin', requestId: randomUUID(), idempotencyKey: req.header('idempotency-key') }; next(); });
    const asyncHandler = (handler: any) => (req: any, res: any, next: any) => Promise.resolve(handler(req, res, next)).catch(next);
    mountWorkbenchAssistantRoutes(app, { db, now, env: mixedEnv, asyncHandler, idempotencyService: createIdempotencyService(db), readSnapshot: async () => null, completionFactory, ...extra });
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ error: error.code }));
    return app;
  }
  async function noSecrets(response: any) {
    let serialized = JSON.stringify(response.body) + logs.join('\n');
    const owner = createHash('sha256').update(actorId).digest('hex');
    const runs = await db.collection(`${root}/personal_work_pages/${owner}/agent_runs`).get();
    for (const run of runs.docs) { serialized += JSON.stringify(run.data()); const events = await run.ref.collection('events').get(); serialized += JSON.stringify(events.docs.map(doc => doc.data())); }
    const receipts = await db.collection(`${root}/idempotency_keys`).get(); serialized += JSON.stringify(receipts.docs.map(doc => doc.data()));
    expect(serialized).not.toContain(LEGACY); expect(serialized).not.toContain(ISOLATED);
  }
  beforeEach(async () => { logs = []; for (const name of ['log', 'warn', 'error'] as const) logSpies.push(vi.spyOn(console, name).mockImplementation((...args) => { logs.push(JSON.stringify(args)); })); await db.recursiveDelete(db.doc(root)); await db.doc(`${root}/members/${actorId}`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now() }); });
  afterEach(() => { for (const spy of logSpies.splice(0)) spy.mockRestore(); });
  afterAll(async () => { await db.recursiveDelete(db.doc(root)); await db.terminate(); });

  it('uses only the legacy key when DI is absent even if both environment families exist', async () => {
    const completion = factory(); const app = legacy(completion);
    expect((await request(app).get('/api/v1/workbench-assistant/capabilities')).body.modelEnabled).toBe(true);
    const response = await request(app).post('/api/v1/workbench-assistant/page-proposal').set(headers()).send(question);
    expect(response.status).toBe(200); expect(completion).toHaveBeenCalledTimes(1); expect(completion.mock.calls[0][0].apiKey).toBe(LEGACY); await noSecrets(response);
  });
  it('keeps the legacy feature flag authoritative when DI is absent', async () => {
    const completion = factory(); const response = await request(legacy(completion, { env: { ...mixedEnv, PRODUCT_WORKBENCH_AI_ENABLED: 'false' } })).post('/api/v1/workbench-assistant/page-proposal').set(headers()).send(question);
    expect(response.status).toBe(503); expect(completion).not.toHaveBeenCalled(); await noSecrets(response);
  });
  it('uses only the explicit isolated key when both environment families exist', async () => {
    const completion = factory(); const response = await request(legacy(completion, { modelConfiguration: { enabled: true, apiKey: ISOLATED } })).post('/api/v1/workbench-assistant/page-proposal').set(headers()).send(question);
    expect(response.status).toBe(200); expect(completion.mock.calls[0][0].apiKey).toBe(ISOLATED); await noSecrets(response);
  });
  it.each([null, {}, { enabled: false, apiKey: ISOLATED }, { enabled: 'true', apiKey: ISOLATED }, { enabled: true }, { enabled: true, apiKey: '   ' }])('fails closed for explicit incomplete/disabled DI and never falls back: %j', async modelConfiguration => {
    const completion = factory(); const app = legacy(completion, { modelConfiguration });
    expect((await request(app).get('/api/v1/workbench-assistant/capabilities')).body.modelEnabled).toBe(false);
    const response = await request(app).post('/api/v1/workbench-assistant/page-proposal').set(headers()).send(question);
    expect(response.status).toBe(503); expect(completion).not.toHaveBeenCalled(); await noSecrets(response);
  });
  it('does not call either provider or disclose either key for a denied role', async () => {
    const completion = factory(); const response = await request(legacy(completion, { modelConfiguration: { enabled: true, apiKey: ISOLATED } })).post('/api/v1/workbench-assistant/page-proposal').set({ ...headers(), 'x-actor-role': 'pm' }).send(question);
    expect(response.status).toBe(403); expect(completion).not.toHaveBeenCalled(); await noSecrets(response);
  });
  it('passes isolated model configuration through the actual independent app mount and preserves production-key rejection', async () => {
    const completion = factory(); const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-isolated-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-business-model', WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: ISOLATED };
    const app = createWorkbenchApp({ db, env, authMode: 'headers', workbenchCompletionFactory: completion });
    const response = await request(app).post('/api/v1/workbench-assistant/page-proposal').set(headers()).send(question);
    expect(response.status).toBe(200); expect(completion.mock.calls[0][0].apiKey).toBe(ISOLATED); await noSecrets(response);
    expect(() => createWorkbenchApp({ db, env: { ...env, SETTLEMENT_AGENT_GEMINI_API_KEY: LEGACY }, authMode: 'headers' })).toThrow('Production credential');
  });
});
