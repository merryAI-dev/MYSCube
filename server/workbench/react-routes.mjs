import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { createHttpError } from '../bff/bff-utils.mjs';
import { createWorkbenchAdmission } from '../bff/workbench-admission.mjs';
import { createRegisteredApiService } from './registered-apis.mjs';
import { createReactPageService, generateReactPage, parseReact, reactHash, reactSourceHash, ReactSourceSchema, ReactApiRefsSchema, REACT_EXAMPLE } from './react-pages.mjs';
import { compileReactPreview } from './react-compiler.mjs';
import { createHtmlCompletion } from './html-completion.mjs';
import { createGitDeliveryService } from './git-delivery.mjs';
import { resolveReactRuntime } from './react-runtime-config.mjs';
import { createReactConversationService } from './react-conversation.mjs';
import { withConversationDeadline } from './execution-deadline.mjs';
import { ReactPageMutationResponseSchema, ReactExecutionArtifactSchema, ReactPreviewRequestSchema } from '../../shared/workbench-react-workspace.mjs';

export function mountReactStudio(app, { db, now, env, core, analytics, asyncHandler, createMutatingRoute, idempotencyService,
  completionFactory = createHtmlCompletion, gitFetch }) {
  const prefix = '/api/v1/react-work-pages', apiPrefix = '/api/v1/workbench-apis';
  const mutate = (fn) => (req, res, next) => {
    req.context = { ...req.context, idempotencyKey: reactHash(`${req.context.idempotencyKey}:${req.context.analyticsScope.fingerprint}`) };
    return createMutatingRoute(idempotencyService, fn)(req, res, next);
  };
  const apis = createRegisteredApiService({ db, analytics, authorize: core.authorize, now, env });
  const pages = createReactPageService({ db, authorize: core.authorize, apis, now });
  const git = createGitDeliveryService({ db, env, authorize: core.authorize, ...(gitFetch ? { fetchImpl: gitFetch } : {}) });
  const admission = createWorkbenchAdmission({ db, actorLimit: 30, leaseMs: 120000 });
  const remoteRuntime = env.WORKBENCH_REMOTE_RUNTIME_ENABLED === 'true';
  const runtime = remoteRuntime ? null : resolveReactRuntime(env);
  const modelEnabled = env.WORKBENCH_AI_ENABLED === 'true' && Boolean(env.WORKBENCH_GEMINI_API_KEY);
  const gitEnabled = Boolean(env.WORKBENCH_GIT_REPOSITORY && (env.WORKBENCH_GITHUB_TOKEN || env.WORKBENCH_GIT_CREDENTIAL_MODE === 'github-app' && env.WORKBENCH_GITHUB_APP_ID && env.WORKBENCH_GITHUB_INSTALLATION_ID && env.WORKBENCH_GITHUB_APP_PRIVATE_KEY));
  const conversations = createReactConversationService({ db, now, env, authorize: core.authorize, apis, analytics, qa: core.qa, completionFactory });
  const admin = (req, _res, next) => req.context.actorRole === 'admin' ? next() : next(createHttpError(403, '관리자 제작 공간입니다.', 'react_admin_required'));
  app.use(prefix, admin); app.use(apiPrefix, admin);
  const limited = (fn) => async (req) => { const lease = await admission.acquire(req.context); try { return await fn(req); } finally { await lease.release(); } };
  const delivery = async (context, value) => {
    if (!gitEnabled) return { status: 'disabled', message: 'GitHub 연결 전입니다. 저장 버전은 보존되어 있으며 연결 후 PR을 만들 수 있습니다.' };
    try { return await git.publish(context, { pageId: value.id, version: value.version, title: value.source.title, ...('workspace' in value.source ? { workspace: value.source.workspace } : { code: value.source.code }), sourceHash: value.sourceHash, packageSetHash: value.artifact.packageSetHash, apiIds: value.apis.map((item) => item.id), apiBindings: value.apis }); }
    catch (error) { return { status: 'failed', message: error.expose ? error.message : '화면은 저장했지만 GitHub 전달에 실패했습니다. 같은 저장 버전으로 다시 시도해 주세요.' }; }
  };
  app.get(`${apiPrefix}/catalog`, asyncHandler(async (req, res) => { const result = await analytics.catalog(req.context); await core.authorize(req.context); res.json(result); }));
  app.get(`${apiPrefix}/endpoints`, asyncHandler(async (req, res) => res.json(await apis.listEndpoints(req.context))));
  app.get(apiPrefix, asyncHandler(async (req, res) => res.json(await apis.list(req.context))));
  app.post(apiPrefix, mutate(limited(async (req) => ({ status: 201, body: await apis.save(req.context, null, req.body) }))));
  app.put(`${apiPrefix}/:id`, mutate(limited(async (req) => ({ status: 200, body: await apis.save(req.context, req.params.id, req.body) }))));
  app.post(`${apiPrefix}/:id/test`, asyncHandler(async (req, res) => res.json(await limited(async (request) => {
    const body = parseReact(z.object({ version: z.number().int().positive(), input: z.record(z.string(), z.unknown()) }).strict(), request.body);
    if (env.WORKBENCH_READS_ENABLED === 'false') throw createHttpError(503, '분석 조회를 잠시 중지했습니다.', 'workbench_reads_disabled');
    return apis.invoke(request.context, request.params.id, body.version, body.input, { signal: AbortSignal.timeout(10000) });
  })(req))));
  app.get(`${prefix}/capabilities`, asyncHandler(async (_req, res) => res.json({ modelEnabled, gitEnabled, gitRepository: gitEnabled ? env.WORKBENCH_GIT_REPOSITORY : null,
    runtimeUrl: runtime?.url || null, remoteRuntime, runtimeMode: remoteRuntime ? 'remote-container' : runtime?.local ? 'local-test' : 'not-configured', example: REACT_EXAMPLE })));
  app.get(`${prefix}/conversations`, asyncHandler(async (req, res) => res.json(await conversations.list(req.context))));
  app.post(`${prefix}/conversations`, mutate(async (req) => ({ status: 201, body: await conversations.create(req.context, req.body) })));
  app.get(`${prefix}/conversations/:id`, asyncHandler(async (req, res) => res.json(await conversations.get(req.context, req.params.id))));
  app.post(`${prefix}/conversations/:id/turns`, asyncHandler(async (req, res) => res.json(await limited((request) => conversations.turn(request.context, request.params.id, request.body))(req))));
  app.get(prefix, asyncHandler(async (req, res) => res.json(await pages.list(req.context))));
  app.get(`${prefix}/:id/versions`, asyncHandler(async (req, res) => res.json(await pages.history(req.context, req.params.id))));
  app.get(`${prefix}/:id`, asyncHandler(async (req, res) => res.json(await pages.get(req.context, req.params.id))));
  const save = (id) => mutate(limited(async (req) => {
    const saved = await pages.save(req.context, id ? req.params.id : null, req.body);
    const git = await delivery(req.context, saved); return { status: id ? 200 : 201, body: ReactPageMutationResponseSchema.parse({ ...saved, git }) };
  }));
  app.post(prefix, save(false)); app.put(`${prefix}/:id`, save(true));
  app.post(`${prefix}/:id/restore`, mutate(limited(async (req) => { const saved = await pages.restore(req.context, req.params.id, req.body); return { status: 200, body: ReactPageMutationResponseSchema.parse({ ...saved, git: await delivery(req.context, saved) }) }; })));
  app.post(`${prefix}/:id/publish`, asyncHandler(async (req, res) => res.json(await limited(async (request) => {
    const { version } = parseReact(z.object({ version: z.number().int().positive() }).strict(), request.body);
    return delivery(request.context, await pages.get(request.context, request.params.id, version));
  })(req))));
  app.post(`${prefix}/preview`, asyncHandler(async (req, res) => res.json(await limited(async (request) => {
    if (!runtime) throw createHttpError(503, '별도 React 실행 공간이 연결되지 않았습니다. 소스 편집과 저장은 사용할 수 있습니다.', 'react_runtime_unconfigured');
    const input = parseReact(ReactPreviewRequestSchema, request.body);
    const selectedApis = await pages.validateApis(request.context, input.apis);
    const artifact = await compileReactPreview(input.source, { apis: selectedApis });
    await core.authorize(request.context);
    const executionId = randomUUID();
    await db.doc(`orgs/${request.context.tenantId}/react_executions/${executionId}`).create({ owner: request.context.actorId, apis: input.apis, sourceHash: reactSourceHash(input.source), scopeFingerprint: request.context.analyticsScope.fingerprint, createdAt: now(), expiresAt: new Date(Date.parse(now()) + 30 * 60000).toISOString() });
    return ReactExecutionArtifactSchema.parse({ ...artifact, executionId });
  })(req))));
  app.post(`${prefix}/executions/:id/call`, asyncHandler(async (req, res) => res.json(await limited(async (request) => {
    if (env.WORKBENCH_READS_ENABLED === 'false') throw createHttpError(503, '분석 조회를 잠시 중지했습니다.', 'workbench_reads_disabled');
    const id = parseReact(z.string().uuid(), request.params.id);
    const body = parseReact(z.object({ apiId: z.string().uuid(), input: z.record(z.string(), z.unknown()) }).strict(), request.body);
    const execution = (await db.doc(`orgs/${request.context.tenantId}/react_executions/${id}`).get()).data();
    if (!execution || execution.owner !== request.context.actorId || execution.scopeFingerprint !== request.context.analyticsScope.fingerprint || Date.parse(execution.expiresAt) <= Date.parse(now())) throw createHttpError(403, '미리보기 권한 또는 실행 시간이 만료되었습니다. 미리보기를 다시 적용해 주세요.', 'react_execution_expired');
    const api = execution.apis.find((item) => item.id === body.apiId);
    if (!api) throw createHttpError(403, '이 화면에 연결하지 않은 API입니다.', 'react_api_not_bound');
    return apis.invoke(request.context, api.id, api.version, body.input, { signal: AbortSignal.timeout(10000) });
  })(req))));
  app.post(`${prefix}/generate`, mutate(limited(async (req) => {
    if (!modelEnabled) throw createHttpError(503, 'AI 연결 설정 전입니다. React 직접 편집과 저장은 사용할 수 있습니다.', 'react_model_unconfigured');
    const input = parseReact(z.object({ prompt: z.string().min(1).max(4000), source: ReactSourceSchema.optional(), apis: ReactApiRefsSchema }).strict(), req.body);
    const selected = await Promise.all(input.apis.map((api) => apis.get(req.context, api.id, api.version)));
    const owner = reactHash(req.context.actorId), day = now().slice(0, 10);
    const budget = db.doc(`orgs/${req.context.tenantId}/html_generation_usage/${day}`);
    await db.runTransaction(async (tx) => { const data = (await tx.get(budget)).data() || { count: 0, actors: {} }; if (data.count >= 20 || (data.actors?.[owner] || 0) >= 5) throw createHttpError(429, '오늘 AI 요청 한도에 도달했습니다.', 'react_daily_limit'); tx.set(budget, { count: data.count + 1, actors: { ...data.actors, [owner]: (data.actors?.[owner] || 0) + 1 } }); });
    const record = db.doc(`orgs/${req.context.tenantId}/react_generation_runs/${randomUUID()}`);
    const started = performance.now(), stages = []; let inputTokens = null, outputTokens = null;
    await record.create({ actorId: req.context.actorId, sourceHash: input.source ? reactSourceHash(input.source) : null, state: 'started', createdAt: now() });
    try {
      const complete = completionFactory({ apiKey: env.WORKBENCH_GEMINI_API_KEY, model: env.WORKBENCH_HTML_MODEL || 'gemini-3.6-flash', onUsage: async (usage) => {
        if (Number.isSafeInteger(usage.promptTokenCount) && usage.promptTokenCount >= 0) inputTokens = (inputTokens || 0) + usage.promptTokenCount;
        if (Number.isSafeInteger(usage.candidatesTokenCount) && usage.candidatesTokenCount >= 0) outputTokens = (outputTokens || 0) + usage.candidatesTokenCount;
        await record.update({ inputTokens, outputTokens });
      } });
      const signal = AbortSignal.timeout(110000);
      const result = await withConversationDeadline(() => generateReactPage({ complete, prompt: input.prompt, currentSource: input.source, apis: selected.map((api) => ({ id: api.id, version: api.version, ...api.definition, responseSchema: api.responseSchema || null, responseKind: api.responseKind || api.definition.kind })), authorize: async () => { await core.authorize(req.context); await pages.validateApis(req.context, input.apis); }, signal, onStage: (stage) => stages.push(stage) }), signal);
      await core.authorize(req.context); await pages.validateApis(req.context, input.apis);
      await record.update({ state: 'completed', resultType: result.type, outputHash: result.source ? reactSourceHash(result.source) : null, completedAt: now(), inputTokens, outputTokens, stages, elapsedMs: Math.round(performance.now() - started) });
      return { status: 200, body: result };
    } catch (error) { await record.update({ state: 'failed', completedAt: now(), code: error.code || 'react_generation_failed', inputTokens, outputTokens, stages, elapsedMs: Math.round(performance.now() - started) }); throw error; }
  })));
  return { pages, apis };
}
