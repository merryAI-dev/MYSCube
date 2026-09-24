import { createHash } from 'node:crypto';
import { createHttpError } from '../bff/bff-utils.mjs';

export const OPERATION_SCOPE_CHANGED_MESSAGE = '조회 권한이 바뀌어 이전 저장 결과를 확인할 수 없습니다. 중복 저장을 막기 위해 새로 저장하지 않았습니다.';
export const isDurableWorkbenchOperation = (path, method) => ['POST', 'PUT'].includes(method) && /^\/(?:html-work-pages|react-work-pages|workbench-apis)(?:\/[a-f0-9-]{36}(?:\/restore)?)?$/.test(path);
const rawKeyPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const stableJson = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
export const operationReceiptMetadata = (context) => context.operationIdentity ? {
  operationPayloadHash: context.operationIdentity.payloadHash,
  operationPath: context.operationIdentity.path,
  operationMethod: context.operationIdentity.method,
} : {};
const operationRef = (db, context, rawKey) => {
  if (!rawKeyPattern.test(rawKey || '')) throw createHttpError(400, '저장 요청 번호의 형식을 확인해 주세요.', 'workbench_operation_key_invalid');
  return db.doc(`orgs/${context.tenantId}/workbench_operation_scopes/${hash(JSON.stringify([context.actorId, rawKey]))}`);
};
export async function readWorkbenchOperationScope({ db, context, rawKey }) {
  const saved = (await operationRef(db, context, rawKey).get()).data();
  if (saved && (saved.actorId !== context.actorId || saved.tenantId !== context.tenantId)) throw createHttpError(403, '현재 계정의 저장 요청만 확인할 수 있습니다.', 'workbench_operation_forbidden');
  return saved || null;
}
export function workbenchOperationScopeMiddleware({ db, now, authorize, asyncHandler }) {
  return asyncHandler(async (req, _res, next) => {
    if (!isDurableWorkbenchOperation(req.path, req.method)) return next();
    const context = req.context;
    await authorize(context);
    if (context.actorRole !== 'admin') throw createHttpError(403, '관리자 본인의 저장 요청만 사용할 수 있습니다.', 'workbench_operation_forbidden');
    const ref = operationRef(db, context, context.idempotencyKey);
    const value = { actorId: context.actorId, tenantId: context.tenantId, scopeFingerprint: context.analyticsScope.fingerprint,
      path: req.path, method: req.method, payloadHash: hash(stableJson(req.body ?? null)), createdAt: now() };
    await db.runTransaction(async (tx) => {
      const previous = (await tx.get(ref)).data();
      if (previous) {
        if (previous.scopeFingerprint !== value.scopeFingerprint) throw createHttpError(409, OPERATION_SCOPE_CHANGED_MESSAGE, 'workbench_operation_scope_changed');
        if (previous.actorId !== value.actorId || previous.tenantId !== value.tenantId || previous.path !== value.path || previous.method !== value.method || previous.payloadHash !== value.payloadHash) throw createHttpError(409, '이 저장 요청 번호에 연결된 내용이 다릅니다. 이전 저장 결과를 먼저 확인해 주세요.', 'workbench_operation_conflict');
      } else tx.create(ref, value);
    });
    await authorize(context);
    context.operationIdentity = { path: value.path, method: value.method, payloadHash: value.payloadHash };
    next();
  });
}
