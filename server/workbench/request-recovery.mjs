import { createHash } from 'node:crypto';
import { createHttpError } from '../bff/bff-utils.mjs';
import { readWorkbenchOperationScope, OPERATION_SCOPE_CHANGED_MESSAGE } from './operation-scopes.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const scopeChanged = () => ({ state: 'scope_changed', message: OPERATION_SCOPE_CHANGED_MESSAGE });
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const kindForPath = (path) => path.startsWith('/html-work-pages') ? 'html-page' : path.startsWith('/react-work-pages') ? 'react-page' : 'registered-api';

async function recoverInCurrentScope({ db, core, context, key, operation, path, method, pages, apis, htmlPages }) {
  try {
    const originalKey = hash(`${key}:${operation.scopeFingerprint}`);
    const receipt = (await db.doc(`orgs/${context.tenantId}/workbench_mutation_results/${hash(originalKey)}`).get()).data();
    if (!receipt || receipt.kind !== kindForPath(path) || receipt.actorId !== context.actorId || receipt.tenantId !== context.tenantId
      || receipt.scopeFingerprint !== operation.scopeFingerprint || receipt.operationPath !== path || receipt.operationMethod !== method
      || !/^[a-f0-9]{64}$/.test(receipt.operationPayloadHash || '') || receipt.operationPayloadHash !== operation.payloadHash
      || !Number.isSafeInteger(receipt.version) || receipt.version < 1) return scopeChanged();
    const resourceId = receipt.kind === 'registered-api' ? receipt.apiId : receipt.pageId;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(resourceId || '') || path.split('/')[2] && path.split('/')[2] !== resourceId) return scopeChanged();
    await core.authorize(context);
    const saved = receipt.kind === 'html-page' ? await htmlPages.getVersion(context, receipt.pageId, receipt.version)
      : receipt.kind === 'react-page' ? await pages.get(context, receipt.pageId, receipt.version) : await apis.get(context, receipt.apiId, receipt.version);
    if (saved.id !== (receipt.pageId || receipt.apiId) || saved.version !== receipt.version) return scopeChanged();
    if (receipt.kind === 'html-page' && (saved.contentHash !== receipt.contentHash || saved.previewHash !== receipt.previewHash || !sameJson(saved.dataBinding?.evidenceIds || [], receipt.evidenceIds))) return scopeChanged();
    if (receipt.kind === 'react-page') {
      if (saved.sourceHash !== receipt.sourceHash || !sameJson(saved.apis, receipt.apis)) return scopeChanged();
      await pages.validateApis(context, saved.apis);
    }
    if (receipt.kind === 'registered-api' && saved.definitionHash !== receipt.definitionHash) return scopeChanged();
    await core.authorize(context);
    return { state: 'completed', kind: receipt.kind, body: saved, recoveredAfterScopeChange: true };
  } catch { return scopeChanged(); }
}
export function mountRequestRecovery(app, { db, core, asyncHandler, pages, apis, htmlPages }) {
  app.get('/api/v1/workbench-requests/:key', asyncHandler(async (req, res) => {
    const { key } = req.params, { path, method } = req.query;
    if (req.context.actorRole !== 'admin' || !/^[a-f0-9-]{36}$/.test(key) || !['POST', 'PUT'].includes(method) || typeof path !== 'string'
      || !/^\/(?:react-work-pages|html-work-pages|workbench-apis)(?:\/[a-f0-9-]{36}(?:\/restore)?)?$/.test(path)) throw createHttpError(400, '확인할 저장 요청을 다시 선택해 주세요.', 'workbench_recovery_invalid');
    await core.authorize(req.context);
    const operation = await readWorkbenchOperationScope({ db, context: req.context, rawKey: key });
    await core.authorize(req.context);
    if (operation && (operation.path !== path || operation.method !== method)) throw createHttpError(400, '확인할 저장 요청의 종류와 경로가 다릅니다.', 'workbench_recovery_mismatch');
    if (operation?.scopeFingerprint !== undefined && operation.scopeFingerprint !== req.context.analyticsScope.fingerprint) return res.json(await recoverInCurrentScope({ db, core, context: req.context, key, operation, path, method, pages, apis, htmlPages }));
    const scopedKey = hash(`${key}:${req.context.analyticsScope.fingerprint}`);
    const receipt = (await db.doc(`orgs/${req.context.tenantId}/workbench_mutation_results/${hash(scopedKey)}`).get()).data();
    if (receipt && receipt.actorId === req.context.actorId && ((receipt.kind === 'react-page' && path.startsWith('/react-work-pages')) || (receipt.kind === 'registered-api' && path.startsWith('/workbench-apis')) || (receipt.kind === 'html-page' && path.startsWith('/html-work-pages')))) {
      const service = receipt.kind === 'react-page' ? pages : receipt.kind === 'html-page' ? htmlPages : apis;
      const saved = await service.mutationResult({ ...req.context, idempotencyKey: scopedKey });
      await core.authorize(req.context);
      return res.json({ state: 'completed', kind: receipt.kind, body: saved });
    }
    const entry = (await db.doc(`orgs/${req.context.tenantId}/idempotency_keys/ik_${hash(scopedKey).slice(0, 40)}`).get()).data();
    await core.authorize(req.context);
    if (!entry || entry.actorId !== req.context.actorId || entry.path !== `/api/v1${path}` || entry.method !== method) return res.json({ state: 'not_found' });
    if (entry.status === 'completed' && path.startsWith('/html-work-pages')) {
      const saved = await htmlPages.getVersion(req.context, entry.responseBody?.id, entry.responseBody?.version); await core.authorize(req.context);
      return res.json({ state: 'completed', kind: 'html-page', body: saved });
    }
    res.json({ state: entry.status === 'completed' ? 'completed' : entry.status === 'failed' ? 'failed' : 'pending', ...(entry.status === 'completed' ? { body: entry.responseBody } : {}) });
  }));
}
