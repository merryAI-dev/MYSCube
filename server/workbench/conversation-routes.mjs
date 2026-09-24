import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { createHttpError } from '../bff/bff-utils.mjs';
import { createConversationService } from './conversations.mjs';
import { runConversationTurn } from './conversation-agent.mjs';
import { createHtmlCompletion } from './html-completion.mjs';
import { resolveHtmlBindings } from './html-bindings.mjs';
import { withConversationDeadline } from './execution-deadline.mjs';

const input = z.object({ expectedVersion: z.number().int().nonnegative(), requestId: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/), message: z.string().trim().min(1).max(4000),
  currentSource: z.object({ title: z.string().max(80), html: z.string().max(200000) }).strict().optional() }).strict();
const hash = (text) => createHash('sha256').update(text).digest('hex');

export function mountConversations(app, { db, now, env, core, analytics, asyncHandler, createMutatingRoute, idempotencyService, completionFactory = createHtmlCompletion, deadlineMs = 110000 }) {
  const prefix = '/api/v1/workbench-conversations';
  const service = createConversationService({ db, now });
  const redact = (context, turn) => turn.result && turn.result.scopeFingerprint !== context.analyticsScope.fingerprint
    ? { ...turn, result: { status: 'answered', answer: '조회 권한 범위가 변경되어 이전 자료와 화면을 표시하지 않습니다. 현재 권한으로 다시 질문해 주세요.' } } : turn;
  app.use(prefix, (req, _res, next) => req.context.actorRole === 'admin' ? next() : next(createHttpError(403, '관리자 본인의 분석 대화만 이용할 수 있습니다.', 'conversation_admin_required')));
  app.get(prefix, asyncHandler(async (req, res) => {
    const result = await service.list(req.context); await core.authorize(req.context);
    res.json({ ...result, items: result.items.map(({ id, title, version, updatedAt, createdAt, lastState }) => ({ id, title, version, updatedAt, createdAt, lastState })) });
  }));
  app.post(prefix, createMutatingRoute(idempotencyService, async (req) => ({ status: 201, body: await service.create(req.context, req.body) })));
  app.get(`${prefix}/:id`, asyncHandler(async (req, res) => {
    const result = await service.get(req.context, req.params.id); await core.authorize(req.context);
    const { workContext, pendingClarification, ...publicSession } = result;
    res.json({ ...publicSession, turns: result.turns.map((turn) => redact(req.context, turn)) });
  }));
  app.get(`${prefix}/:id/turns/:turnId`, asyncHandler(async (req, res) => { const turn = await service.getTurn(req.context, req.params.id, req.params.turnId); await core.authorize(req.context); res.json(redact(req.context, turn)); }));
  app.post(`${prefix}/:id/turns`, asyncHandler(async (req, res) => {
    const parsed = input.safeParse(req.body);
    if (!parsed.success) throw createHttpError(400, '질문과 저장 버전, 편집 소스를 확인해 주세요.', 'conversation_invalid');
    if (env.WORKBENCH_AI_ENABLED !== 'true' || !env.WORKBENCH_GEMINI_API_KEY) throw createHttpError(503, 'AI 연결 설정 전입니다. 저장된 대화와 직접 편집은 계속 이용할 수 있습니다.', 'conversation_model_unconfigured');
    const { currentSource, ...request } = parsed.data;
    const begun = await service.beginTurn(req.context, req.params.id, { ...request, sourceHash: hash(JSON.stringify(currentSource || null)), scopeFingerprint: req.context.analyticsScope.fingerprint });
    if (begun.mode === 'in_progress') throw createHttpError(409, '이 요청을 처리 중입니다. 잠시 후 대화를 다시 확인해 주세요.', 'conversation_in_progress');
    if (begun.mode !== 'started') return res.json({ version: begun.version, turnId: begun.turnId, turn: redact(req.context, begun.turn), result: redact(req.context, begun.turn).result, replayed: true });
    const runId = randomUUID(), owner = hash(req.context.actorId);
    const lease = db.doc(`orgs/${req.context.tenantId}/html_generation_locks/active`);
    const budget = db.doc(`orgs/${req.context.tenantId}/html_generation_usage/${now().slice(0, 10)}`);
    const signal = AbortSignal.timeout(Math.min(deadlineMs, 110000));
    let acquired = false;
    try {
      await db.runTransaction(async (tx) => {
        const [usage, active] = await tx.getAll(budget, lease);
        const current = usage.data() || { count: 0, actors: {} };
        if (current.count >= 20 || (current.actors?.[owner] || 0) >= 5) throw createHttpError(429, '오늘 AI 요청 한도에 도달했습니다. 저장한 화면과 직접 편집은 계속 이용할 수 있습니다.', 'conversation_daily_limit');
        if (Date.parse(active.data()?.expiresAt) > Date.parse(now())) throw createHttpError(429, '다른 분석 요청을 처리 중입니다. 잠시 후 다시 요청해 주세요.', 'conversation_busy');
        tx.set(budget, { count: current.count + 1, actors: { ...current.actors, [owner]: (current.actors?.[owner] || 0) + 1 } });
        tx.set(lease, { runId, expiresAt: new Date(Date.parse(now()) + 125000).toISOString() });
      });
      acquired = true;
      const tokenUsage = { inputTokens: null, outputTokens: null }; const started = performance.now();
      const complete = completionFactory({ apiKey: env.WORKBENCH_GEMINI_API_KEY, model: env.WORKBENCH_HTML_MODEL || 'gemini-3.6-flash', onUsage: async (usage) => {
        for (const [name, field] of [['inputTokens', 'promptTokenCount'], ['outputTokens', 'candidatesTokenCount']]) if (Number.isSafeInteger(usage[field]) && usage[field] >= 0) tokenUsage[name] = (tokenUsage[name] || 0) + usage[field];
      } });
      const changedScope = begun.workContext?.scopeFingerprint && begun.workContext.scopeFingerprint !== req.context.analyticsScope.fingerprint;
      const state = changedScope ? {} : begun.workContext;
      const { scopeFingerprint: _oldScope, react, lastMode: _lastMode, ...workContext } = state || {};
      const result = await withConversationDeadline(() => runConversationTurn({ context: req.context, message: request.message, history: changedScope ? [] : begun.history,
        workContext, pendingClarification: changedScope || begun.pendingClarification?.mode === 'react' ? null : begun.pendingClarification, currentSource, complete, analytics, qa: core.qa, authorize: core.authorize,
        bindHtml: resolveHtmlBindings, signal, now }), signal);
      await core.authorize(req.context); signal.throwIfAborted();
      result.scopeFingerprint = req.context.analyticsScope.fingerprint;
      result.mode = 'analysis'; result.type = result.status === 'clarification_required' ? 'clarification' : 'answer';
      result.telemetry = { ...tokenUsage, elapsedMs: Math.round(performance.now() - started) };
      result.context = { ...result.context, ...(react ? { react } : {}), lastMode: 'analysis', scopeFingerprint: req.context.analyticsScope.fingerprint };
      const saved = await service.completeTurn(req.context, req.params.id, { turnId: begun.turnId, result });
      res.json({ ...saved, turnId: begun.turnId, result });
    } catch (error) {
      await service.failTurn(req.context, req.params.id, { turnId: begun.turnId, error: { code: /^[a-zA-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'conversation_failed',
        message: error.expose ? error.message.slice(0, 1000) : '요청을 완료하지 못했습니다. 이전 결과와 작성 내용은 유지됩니다.' } });
      throw error;
    } finally {
      if (acquired) await db.runTransaction(async (tx) => { if ((await tx.get(lease)).data()?.runId === runId) tx.delete(lease); });
    }
  }));
}
