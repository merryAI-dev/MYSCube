import * as z from 'zod/v4';
import { compileReactPreview } from './react-compiler.mjs';
import { ReactSourceSchema, ReactApiRefsSchema, parseReact } from './react-pages.mjs';
import { createWorkbenchAdmission } from '../bff/workbench-admission.mjs';
import { createHttpError } from '../bff/bff-utils.mjs';

export function mountRemotePreview(app, { db, env, core, pages, apis, asyncHandler, brokerFactory }) {
  const prefix = '/api/v1/react-work-pages/remote';
  if (env.WORKBENCH_REMOTE_RUNTIME_ENABLED !== 'true') return null;
  if (typeof brokerFactory !== 'function') throw new Error('The remote runtime broker must be explicitly configured.');
  const evidence = new Map();
  const admission = createWorkbenchAdmission({ db, actorLimit: 12, leaseMs: 30000 });
  const broker = brokerFactory({ authorize: core.authorize, callApi: async (context, { apiId, apiVersion, input, signal }) => {
    if (env.WORKBENCH_READS_ENABLED === 'false') throw createHttpError(503, '분석 조회를 잠시 중지했습니다.', 'workbench_reads_disabled');
    const result = await apis.invoke(context, apiId, apiVersion, input, { signal: signal || AbortSignal.timeout(10000) });
    if (context.remoteEvidence && result.evidenceId) context.remoteEvidence[apiId] = { evidenceId: result.evidenceId };
    return result;
  } });
  const owner = (context) => `${context.tenantId}:${context.actorId}:${context.analyticsScope.fingerprint}`;
  const expiry = setInterval(() => { for (const [id, value] of evidence) if (Date.parse(value.expiresAt) <= Date.now()) evidence.delete(id); }, 60000); expiry.unref();
  const checked = async (req) => {
    if (req.context.actorRole !== 'admin') throw createHttpError(403, '관리자 본인의 실행 화면만 이용할 수 있습니다.', 'remote_preview_forbidden');
    await core.authorize(req.context);
  };
  const render = async (req, value) => {
    await checked(req);
    const entry = evidence.get(value.sessionId || req.params.id);
    const frame = value.frame || value;
    return { sessionId: value.sessionId || req.params.id, frame, ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}), evidence: entry?.owner === owner(req.context) ? entry.bindings : {} };
  };
  app.post(prefix, asyncHandler(async (req, res) => {
    await checked(req);
    const input = parseReact(z.object({ source: ReactSourceSchema, apis: ReactApiRefsSchema, previousSessionId: z.string().uuid().optional(), viewport: z.object({ width: z.number().int().min(320).max(1600), height: z.number().int().min(240).max(1200) }).strict().optional() }).strict(), req.body);
    const lease = await admission.acquire(req.context);
    try {
      await pages.validateApis(req.context, input.apis);
      const artifact = await compileReactPreview(input.source);
      await checked(req);
      const context = { ...req.context, remoteEvidence: {} };
      const value = await broker.create(context, { artifact, sourceHash: artifact.sourceHash, apiBindings: input.apis, viewport: input.viewport, previousSessionId: input.previousSessionId });
      try { await checked(req); }
      catch (error) { await broker.close(context, value.sessionId).catch(() => {}); throw error; }
      evidence.set(value.sessionId, { owner: owner(context), bindings: context.remoteEvidence, expiresAt: value.expiresAt });
      res.json(await render(req, value));
    } finally { await lease.release(); }
  }));
  app.get(`${prefix}/:id`, asyncHandler(async (req, res) => { await checked(req); res.json(await render(req, await broker.frame(req.context, parseReact(z.string().uuid(), req.params.id)))); }));
  app.get(`${prefix}/status/summary`, asyncHandler(async (req, res) => {
    await checked(req);
    const cleanup = broker.cleanupStatus || [];
    res.json({ activeSessions: broker.activeSessions, reservedSessions: broker.reservedSessions,
      cleanupPending: cleanup.filter((item) => item.pending).length, cleanupFailed: cleanup.filter((item) => item.failed).length });
  }));
  app.post(`${prefix}/:id/events`, asyncHandler(async (req, res) => { await checked(req); res.json(await render(req, await broker.event(req.context, parseReact(z.string().uuid(), req.params.id), req.body))); }));
  app.delete(`${prefix}/:id`, asyncHandler(async (req, res) => {
    await checked(req); const id = parseReact(z.string().uuid(), req.params.id); await broker.close(req.context, id); evidence.delete(id); res.json({ closed: true });
  }));
  const closeAll = (broker.shutdown || broker.closeAll).bind(broker);
  broker.shutdown = () => { clearInterval(expiry); evidence.clear(); closeAll(); };
  broker.closeAll = broker.shutdown;
  return broker;
}
