import express from 'express';
import { randomUUID } from 'node:crypto';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createIdempotencyService } from '../bff/idempotency.mjs';
import { createHttpError } from '../bff/bff-utils.mjs';
import { createWorkbenchAdmission, workbenchAdmissionMiddleware } from '../bff/workbench-admission.mjs';
import { mountInsightCashflowReport } from '../bff/insight-cashflow-report.mjs';
import { mountQaEvidenceRoutes } from '../bff/qa-evidence.mjs';
import { mountPersonalWorkPageRoutes } from '../bff/personal-work-pages.mjs';
import { mountCashflowEvidenceRoutes } from '../bff/cashflow-evidence-query.mjs';
import { mountWorkbenchAssistantRoutes } from '../bff/workbench-assistant.mjs';
import { createReliabilityService, mountReliabilityRoutes } from '../bff/reliability-service.mjs';
import { createWorkbenchSnapshotReader } from './snapshot-reader.mjs';
import { mountHtmlStudio } from './html-routes.mjs';
import { createAnalyticsService } from './analytics-service.mjs';
import { mountConversations } from './conversation-routes.mjs';
import { mountReactStudio } from './react-routes.mjs';
import { mountRequestRecovery } from './request-recovery.mjs';
import { workbenchOperationScopeMiddleware } from './operation-scopes.mjs';
import { mountRemotePreview } from './remote-preview-routes.mjs';
import { createRemoteRuntimeBroker } from './remote-runtime/broker.mjs';
import { createCopiedLogSummary } from './copied-log-summary.mjs';

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function createMutatingRoute(service, fn, { validateReplay } = {}) {
  return asyncHandler(async (req, res) => {
    const options = { ...req.context, method: req.method, path: req.path, body: req.body };
    const lock = await service.begin(options);
    if (lock.mode === 'replay') { const body = validateReplay ? await validateReplay(req) : lock.body; res.setHeader('x-idempotency-replayed', '1'); return res.status(lock.status).json(body); }
    if (lock.mode !== 'started') throw createHttpError(409, '처리 중이거나 변경된 요청입니다.', 'workbench_request_conflict');
    try {
      const result = await fn(req);
      await service.complete({ ...options, requestFingerprint: lock.requestFingerprint, responseStatus: result.status, responseBody: result.body });
      res.status(result.status).json(result.body);
    } catch (error) { await service.fail({ ...options, requestFingerprint: lock.requestFingerprint, error }); throw error; }
  });
}

export function createWorkbenchApp(options) {
  const { db, env, verifyToken } = options;
  const now = options.now || (() => new Date().toISOString());
  const core = createIsolatedWorkbenchCore({ db, env, now, readCode: options.readCode });
  const headersForTests = options.authMode === 'headers' && core.runtime.projectId.startsWith('demo-') && Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  if (!headersForTests && typeof verifyToken !== 'function') throw new Error('An isolated identity verifier is required.');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'myscube-workbench', projectId: core.runtime.projectId }));
  app.use('/api/v1', asyncHandler(async (req, res, next) => {
    const claims = headersForTests ? { uid: req.header('x-actor-id') } : await verifyToken(req.header('authorization'));
    const tenantId = headersForTests ? req.header('x-tenant-id') : env.WORKBENCH_TENANT_ID;
    if (![claims?.uid, tenantId].every((value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value))) throw createHttpError(401, '다시 로그인해 주세요.', 'unauthorized');
    const member = (await db.doc(`orgs/${tenantId}/members/${claims.uid}`).get()).data();
    req.context = { tenantId, actorId: claims.uid, actorRole: member?.role, requestId: randomUUID(), idempotencyKey: req.header('idempotency-key') };
    try { await core.authorize(req.context); }
    catch (error) { app.locals.remoteRuntime?.revokeOwner(req.context); throw error; }
    if (!['GET', 'HEAD'].includes(req.method) && !req.context.idempotencyKey) throw createHttpError(400, '요청 번호가 필요합니다.', 'idempotency_key_required');
    res.setHeader('Cache-Control', 'no-store');
    next();
  }));
  app.use('/api/v1', workbenchAdmissionMiddleware({ service: createWorkbenchAdmission({ db }), readsEnabled: env.WORKBENCH_READS_ENABLED !== 'false' }));
  app.use('/api/v1', workbenchOperationScopeMiddleware({ db, now, authorize: core.authorize, asyncHandler }));
  const idempotencyService = createIdempotencyService(db);
  const common = { db, now, asyncHandler, createMutatingRoute, idempotencyService };
  const analytics = options.analytics || createAnalyticsService({ db, now });
  const reactStudio = mountReactStudio(app, { ...common, env, core, analytics, completionFactory: options.reactCompletionFactory, gitFetch: options.gitFetch });
  if (env.WORKBENCH_REMOTE_RUNTIME_ENABLED === 'true' && !headersForTests && (env.WORKBENCH_REMOTE_RUNTIME_DRIVER !== 'docker-host' || env.K_SERVICE)) throw new Error('Remote React requires an approved independent Docker host; Cloud Run cannot run this broker.');
  app.locals.remoteRuntime = mountRemotePreview(app, { ...common, env, core, ...reactStudio, brokerFactory: options.remoteBrokerFactory || createRemoteRuntimeBroker });
  const htmlStudio = mountHtmlStudio(app, { ...common, env, core, analytics, completionFactory: options.htmlCompletionFactory });
  mountRequestRecovery(app, { db, core, asyncHandler, ...reactStudio, htmlPages: htmlStudio.pages });
  mountConversations(app, { ...common, env, core, analytics, completionFactory: options.conversationCompletionFactory, deadlineMs: options.conversationDeadlineMs });
  const readSnapshot = createWorkbenchSnapshotReader({ db, now: () => Date.parse(now()) });
  mountPersonalWorkPageRoutes(app, common);
  mountQaEvidenceRoutes(app, { ...common, query: core.qa });
  mountInsightCashflowReport(app, { ...common, readSnapshot });
  mountCashflowEvidenceRoutes(app, { ...common, readSnapshot });
  mountWorkbenchAssistantRoutes(app, { ...common, env, readSnapshot, completionFactory: options.workbenchCompletionFactory,
    modelConfiguration: { enabled: env.WORKBENCH_AI_ENABLED === 'true', apiKey: env.WORKBENCH_GEMINI_API_KEY }, qaQuery: core.qa });
  mountReliabilityRoutes(app, { ...common, service: {
    ...createReliabilityService({ db, now, environment: 'isolated' }),
    summary: createCopiedLogSummary({ db, env, now, authorize: core.authorize, readHttpSummary: core.httpLogs.summary }),
    observeClient: async () => { throw createHttpError(410, '운영 기록은 승인된 원본의 읽기 전용 사본으로 확인합니다.', 'workbench_observation_readonly'); },
  } });
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.code || 'workbench_failed', message: error.expose ? error.message : '분석 도구 요청을 처리하지 못했습니다.' }));
  return app;
}
