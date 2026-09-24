import { createHash, randomUUID } from 'node:crypto';
import { createHttpError } from '../bff/bff-utils.mjs';
import { createHtmlPageService, generateHtmlPage } from './html-pages.mjs';
import { HTML_REFERENCES, HTML_EXAMPLE } from './html-references.mjs';
import { createHtmlCompletion } from './html-completion.mjs';
import { compileHtmlPreview } from './html-tailwind.mjs';
import { createHtmlDataPolicy } from './html-data.mjs';

export function mountHtmlStudio(app, { db, now, env, core, analytics, asyncHandler, createMutatingRoute, idempotencyService, completionFactory = createHtmlCompletion }) {
  const prefix = '/api/v1/html-work-pages';
  const pages = createHtmlPageService({ db, now, authorize: core.authorize, ...(analytics ? { validateDataBinding: createHtmlDataPolicy({ analytics, authorize: core.authorize }) } : {}) });
  const mutate = (handler) => (req, res, next) => {
    req.context = { ...req.context, idempotencyKey: createHash('sha256').update(`${req.context.idempotencyKey}:${req.context.analyticsScope.fingerprint}`).digest('hex') };
    return createMutatingRoute(idempotencyService, handler, { validateReplay: async (request) => { const saved = await pages.mutationResult(request.context); if (!saved) throw createHttpError(409, '저장 결과를 다시 확인한 뒤 요청해 주세요.', 'html_receipt_unavailable'); return saved; } })(req, res, next);
  };
  const modelEnabled = env.WORKBENCH_AI_ENABLED === 'true' && Boolean(env.WORKBENCH_GEMINI_API_KEY);
  app.use(prefix, (req, _res, next) => req.context.actorRole === 'admin' ? next() : next(createHttpError(403, 'HTML 제작 공간은 관리자만 이용할 수 있습니다.', 'html_admin_required')));
  app.get(`${prefix}/capabilities`, asyncHandler(async (req, res) => res.json({ modelEnabled, actorId: req.context.actorId, mode: 'html-css', message: modelEnabled ? 'HTML 생성 결과를 검토한 뒤 적용해 주세요.' : 'AI 연결 설정 전입니다. HTML 직접 편집·저장·복원은 사용할 수 있습니다.' })));
  app.get(`${prefix}/references`, (_req, res) => res.json({ references: HTML_REFERENCES, example: HTML_EXAMPLE }));
  app.get(`${prefix}/evidence/:id`, asyncHandler(async (req, res) => {
    await core.authorize(req.context);
    const evidence = await analytics.evidence(req.context, req.params.id);
    await core.authorize(req.context);
    res.set('Cache-Control', 'no-store');
    res.json({ evidenceId: evidence.evidenceId, columns: evidence.columns, rows: evidence.rows, metadata: evidence.metadata,
      datasetVersions: evidence.datasetVersions, semantic: evidence.semantic, truncated: evidence.truncated });
  }));
  app.get(prefix, asyncHandler(async (req, res) => res.json(await pages.list(req.context))));
  app.get(`${prefix}/:id/versions`, asyncHandler(async (req, res) => res.json(await pages.history(req.context, req.params.id))));
  app.get(`${prefix}/:id/review`, asyncHandler(async (req, res) => {
    const version = req.query.version === undefined ? undefined : Number(req.query.version);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw createHttpError(400, '리뷰할 버전 번호를 확인해 주세요.', 'html_version_invalid');
    res.json(await pages.exportReview(req.context, req.params.id, version));
  }));
  app.get(`${prefix}/:id`, asyncHandler(async (req, res) => res.json(await pages.get(req.context, req.params.id))));
  app.post(prefix, mutate(async (req) => ({ status: 201, body: await pages.save(req.context, null, req.body) })));
  app.put(`${prefix}/:id`, mutate(async (req) => ({ status: 200, body: await pages.save(req.context, req.params.id, req.body) })));
  app.post(`${prefix}/:id/restore`, mutate(async (req) => ({ status: 200, body: await pages.restore(req.context, req.params.id, req.body) })));
  app.post(`${prefix}/preview`, asyncHandler(async (req, res) => {
    const result = await compileHtmlPreview(req.body?.source);
    await core.authorize(req.context);
    res.json(result);
  }));
  const generateOnce = (handler) => async (req, res) => {
    const options = { ...req.context, method: req.method, path: req.path, body: req.body };
    const lock = await idempotencyService.begin(options);
    if (lock.mode !== 'started') throw createHttpError(409, '이미 처리했거나 처리 중인 생성 요청입니다. 새 요청으로 다시 시도해 주세요.', 'html_generation_duplicate');
    try {
      const result = await handler(req);
      await idempotencyService.complete({ ...options, requestFingerprint: lock.requestFingerprint, responseStatus: 200, responseBody: { runId: result.runId, resultRetained: false } });
      res.json(result);
    } catch (error) {
      await idempotencyService.fail({ ...options, requestFingerprint: lock.requestFingerprint, error });
      throw error;
    }
  };
  app.post(`${prefix}/generate`, asyncHandler(generateOnce(async (req) => {
    if (!modelEnabled) throw createHttpError(503, 'AI 연결 설정 전입니다. 소스를 직접 편집하거나 연결 후 생성해 주세요.', 'html_model_unconfigured');
    const owner = createHash('sha256').update(req.context.actorId).digest('hex');
    const day = now().slice(0, 10);
    const budget = db.doc(`orgs/${req.context.tenantId}/html_generation_usage/${day}`);
    const lease = db.doc(`orgs/${req.context.tenantId}/html_generation_locks/active`);
    const runId = randomUUID();
    await db.runTransaction(async (tx) => {
      const [usage, active] = await tx.getAll(budget, lease);
      const current = usage.data() || { count: 0, actors: {} };
      if (current.count >= 20 || (current.actors?.[owner] || 0) >= 5) throw createHttpError(429, '오늘 HTML 생성 한도에 도달했습니다. 직접 편집과 저장은 계속 이용할 수 있습니다.', 'html_daily_limit');
      if (Date.parse(active.data()?.expiresAt) > Date.parse(now())) throw createHttpError(429, 'HTML 생성 요청이 처리 중입니다. 잠시 후 다시 요청해 주세요.', 'html_generation_busy');
      tx.set(budget, { count: current.count + 1, actors: { ...current.actors, [owner]: (current.actors?.[owner] || 0) + 1 } });
      tx.set(lease, { runId, expiresAt: new Date(Date.parse(now()) + 125000).toISOString() });
    });
    const run = db.doc(`orgs/${req.context.tenantId}/html_generation_runs/${runId}`);
    let inputTokens = 0, outputTokens = 0;
    try {
      await run.create({ actorId: req.context.actorId, startedAt: now(), status: 'started' });
      const complete = completionFactory({ apiKey: env.WORKBENCH_GEMINI_API_KEY, model: env.WORKBENCH_HTML_MODEL || 'gemini-3.6-flash',
        onUsage: async (usage) => { inputTokens += usage.promptTokenCount || 0; outputTokens += usage.candidatesTokenCount || 0; } });
      const signal = AbortSignal.timeout(110000);
      const result = await generateHtmlPage({ complete: async (args) => { await core.authorize(req.context); return complete(args); }, input: req.body, signal });
      await core.authorize(req.context);
      await run.update({ status: 'proposal_ready', completedAt: now(), inputTokens, outputTokens });
      return { ...result, runId };
    } catch (error) {
      await run.set({ status: 'failed', completedAt: now(), inputTokens, outputTokens }, { merge: true });
      if (error.statusCode) throw error;
      throw createHttpError(502, 'HTML 생성을 완료하지 못했습니다. 기존 소스를 유지했습니다. AI 연결과 사용 한도를 확인해 주세요.', 'html_generation_failed');
    } finally {
      await db.runTransaction(async (tx) => { if ((await tx.get(lease)).data()?.runId === runId) tx.delete(lease); });
    }
  })));
  return { pages };
}
