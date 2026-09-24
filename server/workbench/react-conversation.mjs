import { randomUUID } from 'node:crypto';
import { validateReactScreenBindings } from './react-screen-bindings.mjs';
import * as z from 'zod/v4';
import { createHttpError } from '../bff/bff-utils.mjs';
import { createConversationService } from './conversations.mjs';
import { runConversationTurn } from './conversation-agent.mjs';
import { withConversationDeadline } from './execution-deadline.mjs';
import { resolveHtmlBindings } from './html-bindings.mjs';
import { generateReactPage, parseReact, reactHash, reactSourceHash, ReactSourceSchema, ReactApiRefsSchema } from './react-pages.mjs';

export const ReactConversationInput = z.object({ expectedVersion: z.number().int().nonnegative(), requestId: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),
  message: z.string().trim().min(1).max(4000), mode: z.enum(['react', 'analysis', 'auto']).default('react'), currentSource: ReactSourceSchema.optional(), apis: ReactApiRefsSchema.optional(), clarificationId: z.string().uuid().optional() }).strict();
const errorText = (error) => ({ code: /^[a-zA-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'react_conversation_failed', message: error.expose ? error.message.slice(0, 1000) : '요청을 완료하지 못했습니다. 기존 대화와 편집 내용은 유지됩니다.' });
const safeTokens = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function createReactConversationService({ db, now = () => new Date().toISOString(), authorize, apis, analytics, qa, env, completionFactory, deadlineMs = 110000 }) {
  const conversations = createConversationService({ db, now });
  const guard = async (context) => { await authorize(context); if (context.actorRole !== 'admin') throw createHttpError(403, '관리자 본인의 제작 대화만 이용할 수 있습니다.', 'react_admin_required'); };
  const redact = (context, turn) => turn.result && turn.result.scopeFingerprint !== context.analyticsScope.fingerprint
    ? { ...turn, result: { type: 'answer', status: 'answered', answer: '조회 권한 범위가 바뀌어 이전 자료와 소스 제안은 표시하지 않습니다. 현재 권한으로 새 대화를 시작해 주세요.' } } : turn;
  const publicSession = (context, value) => {
    const { workContext, pendingClarification, ...session } = value;
    const allowed = workContext?.scopeFingerprint === context.analyticsScope.fingerprint;
    return { ...session, turns: value.turns.map((turn) => redact(context, turn)),
      reactContext: allowed && workContext.react ? workContext.react : null,
      lastMode: allowed ? workContext.lastMode || 'analysis' : 'react',
      pendingClarification: allowed ? pendingClarification || null : null };
  };
  const get = async (context, id) => { await guard(context); const result = await conversations.get(context, id); await guard(context); return publicSession(context, result); };
  return {
    get,
    async list(context) { await guard(context); const result = await conversations.list(context); await guard(context); return { ...result, items: result.items.map(({ id, title, version, updatedAt, createdAt, lastState }) => ({ id, title, version, updatedAt, createdAt, lastState })) }; },
    async create(context, input) { await guard(context); const result = await conversations.create(context, input); await guard(context); return result; },
    async turn(context, id, raw) {
      await guard(context);
      if (env.WORKBENCH_AI_ENABLED !== 'true' || !env.WORKBENCH_GEMINI_API_KEY) throw createHttpError(503, 'AI 연결 설정 전입니다. 저장된 대화와 직접 편집은 계속 이용할 수 있습니다.', 'react_model_unconfigured');
      const input = parseReact(ReactConversationInput, raw);
      const begun = await conversations.beginTurn(context, id, { expectedVersion: input.expectedVersion, requestId: input.requestId, message: input.message,
        sourceHash: reactHash(JSON.stringify({ mode: input.mode, currentSource: input.currentSource || null, apis: input.apis || null, clarificationId: input.clarificationId || null })), scopeFingerprint: context.analyticsScope.fingerprint });
      if (begun.mode === 'in_progress') throw createHttpError(409, '이 대화의 요청을 처리 중입니다. 잠시 후 저장된 대화를 확인해 주세요.', 'conversation_in_progress');
      if (begun.mode !== 'started') { await guard(context); const turn = redact(context, begun.turn); return { turnId: begun.turnId, version: begun.version, turn, result: turn.result, replayed: true }; }
      const runId = randomUUID(), owner = reactHash(context.actorId), model = env.WORKBENCH_HTML_MODEL || 'gemini-3.6-flash';
      const lock = db.doc(`orgs/${context.tenantId}/html_generation_locks/active`), budget = db.doc(`orgs/${context.tenantId}/html_generation_usage/${now().slice(0, 10)}`);
      const record = db.doc(`orgs/${context.tenantId}/react_generation_runs/${runId}`);
      const started = performance.now(), stages = [], tokens = { inputTokens: null, outputTokens: null, thoughtTokens: null, totalTokens: null };
      let acquired = false, recorded = false;
      const signal = AbortSignal.timeout(Math.min(deadlineMs, 110000));
      const onStage = (stage) => { if (stages.length < 30) stages.push(stage); };
      const onUsage = async (usage) => { for (const [name, field] of [['inputTokens', 'promptTokenCount'], ['outputTokens', 'candidatesTokenCount'], ['thoughtTokens', 'thoughtsTokenCount'], ['totalTokens', 'totalTokenCount']]) {
        const value = safeTokens(usage[field]); if (value !== null) tokens[name] = (tokens[name] || 0) + value;
      } if (recorded) await record.update({ ...tokens, lastUsageAt: now() }); };
      try {
        const changedScope = begun.workContext?.scopeFingerprint && begun.workContext.scopeFingerprint !== context.analyticsScope.fingerprint;
        if (changedScope && input.mode !== 'analysis') throw createHttpError(409, '조회 권한이 변경되어 이전 코드와 연결을 AI에 다시 전달하지 않았습니다. 새 대화에서 현재 권한의 API를 선택해 주세요.', 'react_conversation_scope_changed');
        const previous = changedScope ? {} : begun.workContext || {};
        const { react, lastMode, scopeFingerprint: _scope, ...analysisContext } = previous;
        const source = changedScope ? undefined : input.currentSource || react?.source;
        const refs = changedScope ? [] : input.apis || react?.apis || [];
        const reactContext = source || refs.length ? { ...(source ? { source, sourceHash: reactSourceHash(source) } : {}), apis: refs, ...(react?.lastProposal ? { lastProposal: react.lastProposal } : {}) } : null;
        const pending = changedScope || (input.mode !== 'auto' && (begun.pendingClarification?.mode || 'analysis') !== input.mode) ? null : begun.pendingClarification;
        if (input.clarificationId && pending?.id !== input.clarificationId) throw createHttpError(409, '이전 확인 질문의 답변입니다. 최신 대화를 다시 열어 현재 질문에 답해 주세요.', 'react_clarification_stale');
        const selected = [];
        let screenCheck = null;
        const authorizeApis = async () => {
          signal.throwIfAborted(); await guard(context);
          const currentApis = [];
          for (const ref of refs) currentApis.push(await apis.get(context, ref.id, ref.version));
          if (screenCheck) {
            const catalog = await analytics.catalog(context);
            const evidence = await Promise.all(screenCheck.evidenceIds.map((evidenceId) => analytics.evidence(context, evidenceId)));
            validateReactScreenBindings({ bindings: screenCheck.bindings, evidence, apis: currentApis, catalog });
          }
          signal.throwIfAborted();
        };
        await authorizeApis();
        if (input.mode !== 'analysis') for (const ref of refs) { const api = await apis.get(context, ref.id, ref.version); selected.push({ id: api.id, version: api.version, ...api.definition, responseKind: api.responseKind || api.definition.kind, responseSchema: api.responseSchema || null }); }
        await db.runTransaction(async (tx) => {
          const [usage, active] = await tx.getAll(budget, lock); const value = usage.data() || { count: 0, actors: {} };
          if (value.count >= 20 || (value.actors?.[owner] || 0) >= 5) throw createHttpError(429, '오늘 AI 요청 한도에 도달했습니다. 저장된 대화와 직접 편집은 계속 이용할 수 있습니다.', 'react_daily_limit');
          if (Date.parse(active.data()?.expiresAt) > Date.parse(now())) throw createHttpError(429, '다른 분석 요청을 처리 중입니다. 잠시 후 다시 요청해 주세요.', 'react_conversation_busy');
          tx.set(budget, { count: value.count + 1, actors: { ...value.actors, [owner]: (value.actors?.[owner] || 0) + 1 } });
          tx.set(lock, { runId, expiresAt: new Date(Date.parse(now()) + 125000).toISOString() });
        }); acquired = true;
        await record.create({ actorId: context.actorId, sessionId: id, turnId: begun.turnId, mode: input.mode, model, state: 'started', startedAt: now() }); recorded = true;
        const complete = completionFactory({ apiKey: env.WORKBENCH_GEMINI_API_KEY, model, onUsage });
        let result;
        if (input.mode === 'react') {
          const generated = await withConversationDeadline(() => generateReactPage({ complete, prompt: input.message, currentSource: source, apis: selected,
            previousProposal: react?.lastProposal, businessContext: analysisContext, history: changedScope ? [] : begun.history, pendingClarification: pending, authorize: authorizeApis, signal, onStage }), signal);
          const { artifact, ...proposal } = generated;
          result = { ...proposal, ...(artifact ? { compiled: { sourceHash: artifact.sourceHash, bundleHash: artifact.bundleHash, cssHash: artifact.cssHash, packageSetHash: artifact.packageSetHash, runtimeVersion: artifact.runtimeVersion } } : {}),
            context: { ...analysisContext, ...(reactContext || generated.source ? { react: { ...reactContext, ...(generated.source ? { lastProposal: generated.source } : {}) } } : {}), lastMode: input.mode } };
        } else {
          const measuredComplete = async (args) => { const started = performance.now(); try { return await complete(args); } finally { onStage({ stage: 'model', durationMs: Math.round(performance.now() - started) }); } };
          const analysisStart = performance.now(); let analysis;
          try { analysis = await withConversationDeadline(() => runConversationTurn({ context, message: input.message, history: changedScope ? [] : begun.history,
            workContext: analysisContext, pendingClarification: pending, complete: measuredComplete, analytics, qa,
            authorize: input.mode === 'auto' ? authorizeApis : authorize, bindHtml: resolveHtmlBindings, signal, now,
            ...(input.mode === 'auto' ? { currentSource: source, registeredApis: selected, screenBuilder: async ({ request, purpose, bindings, evidence, businessContext }) => {
              let verified = [];
              if (purpose === 'connected') {
                verified = validateReactScreenBindings({ bindings, evidence, apis: selected, catalog: await analytics.catalog(context) });
                screenCheck = { bindings, evidenceIds: evidence.map((item) => item.evidenceId) };
                try { await authorizeApis(); }
                catch (error) { screenCheck = null; throw error; }
              }
              const generated = await generateReactPage({ complete, prompt: request, currentSource: source, apis: selected,
                previousProposal: react?.lastProposal, businessContext: { ...businessContext, screenBindings: verified, purpose },
                history: changedScope ? [] : begun.history, pendingClarification: pending, authorize: authorizeApis, signal, onStage });
              const { artifact, ...proposal } = generated;
              return { ...proposal, screenBindings: verified,
                ...(artifact ? { compiled: { sourceHash: artifact.sourceHash, bundleHash: artifact.bundleHash, cssHash: artifact.cssHash, packageSetHash: artifact.packageSetHash, runtimeVersion: artifact.runtimeVersion } } : {}) };
            } } : {}) }), signal); }
          finally { onStage({ stage: 'analysis', durationMs: Math.round(performance.now() - analysisStart) }); }
          if (!analysis.source) screenCheck = null;
          result = { ...analysis, type: analysis.type || (analysis.status === 'clarification_required' ? 'clarification' : 'answer'),
            ...(analysis.clarification ? { clarification: { ...analysis.clarification, mode: input.mode } } : {}), context: { ...analysis.context, ...(reactContext || analysis.source ? { react: { ...reactContext, ...(analysis.source ? { lastProposal: analysis.source } : {}) } } : {}), lastMode: input.mode } };
        }
        await authorizeApis();
        result.mode = input.mode; result.scopeFingerprint = context.analyticsScope.fingerprint;
        result.context.scopeFingerprint = context.analyticsScope.fingerprint;
        result.telemetry = { model, ...tokens, stages, elapsedMs: Math.round(performance.now() - started) };
        const saved = await conversations.completeTurn(context, id, { turnId: begun.turnId, result });
        await guard(context); signal.throwIfAborted();
        await record.update({ state: 'completed', resultType: result.type, completedAt: now(), ...result.telemetry });
        return { ...saved, turnId: begun.turnId, result };
      } catch (error) {
        await conversations.failTurn(context, id, { turnId: begun.turnId, error: errorText(error) });
        if (recorded) await record.update({ state: 'failed', completedAt: now(), code: errorText(error).code, ...tokens, stages, elapsedMs: Math.round(performance.now() - started) });
        throw error;
      } finally { if (acquired) await db.runTransaction(async (tx) => { if ((await tx.get(lock)).data()?.runId === runId) tx.delete(lock); }); }
    },
  };
}
