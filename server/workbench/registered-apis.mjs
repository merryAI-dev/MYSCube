import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { createHttpError } from '../bff/bff-utils.mjs';
import { createExternalApiAdapter } from './external-api.mjs';
import { compileSemanticQuery } from './semantic-query.mjs';
import { operationReceiptMetadata } from './operation-scopes.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/);
const parameter = z.object({ type: z.enum(['string', 'integer', 'number', 'boolean']), required: z.boolean().default(true),
  label: z.string().min(1).max(80), example: z.union([z.string().max(500), z.number().finite(), z.boolean()]),
  enum: z.array(z.union([z.string().max(500), z.number().finite(), z.boolean()])).min(1).max(30).optional() }).strict();
const baseDefinition = { name: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(1000), enabled: z.boolean(), parameters: z.record(identifier, parameter) };
const definition = z.discriminatedUnion('kind', [
  z.object({ ...baseDefinition, kind: z.literal('analytics-copy'), plan: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ ...baseDefinition, kind: z.literal('external-read'), endpointId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), endpointVersion: z.number().int().positive() }).strict(),
]);
const stableJson = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const rawHash = (value) => createHash('sha256').update(value).digest('hex');
const saveInput = z.object({ expectedVersion: z.number().int().nonnegative(), definition }).strict();
const parse = (schema, input) => { const result = schema.safeParse(input); if (!result.success) throw createHttpError(400, 'API 이름·조회 정의·입력 항목과 저장 버전을 확인해 주세요.', 'registered_api_invalid'); return result.data; };
const checkId = (id) => parse(z.string().uuid(), id);

export function validateApiInput(parameters, input) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || JSON.stringify(input).length > 32000 || Object.keys(input).some((key) => !Object.hasOwn(parameters, key))) throw createHttpError(400, '등록한 API 입력 항목만 전달해 주세요.', 'registered_api_input_invalid');
  for (const [key, parameter] of Object.entries(parameters)) {
    const value = input[key];
    if (value === undefined && !parameter.required) continue;
    const valid = parameter.type === 'integer' ? Number.isSafeInteger(value) : parameter.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === parameter.type && (parameter.type !== 'string' || value.length <= 500);
    if (!valid || (parameter.enum && !parameter.enum.includes(value))) throw createHttpError(400, `${parameter.label} 항목의 값과 형식을 확인해 주세요.`, 'registered_api_input_invalid');
  }
  return input;
}

export function resolveApiPlan(template, input) {
  let count = 0;
  const walk = (value, depth = 0) => {
    if (++count > 1000 || depth > 12) throw createHttpError(400, 'API 조회 정의가 너무 복잡합니다.', 'registered_api_invalid');
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    if (value && typeof value === 'object') {
      if (Object.hasOwn(value, '$input')) {
        if (Object.keys(value).length !== 1 || typeof value.$input !== 'string' || !Object.hasOwn(input, value.$input)) throw createHttpError(400, '조회 정의에 필요한 API 입력값이 없습니다.', 'registered_api_input_invalid');
        return input[value.$input];
      }
      if (Object.keys(value).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))) throw createHttpError(400, '지원하지 않는 조회 정의입니다.', 'registered_api_invalid');
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, depth + 1)]));
    }
    return value;
  };
  return walk(template);
}

export function createRegisteredApiService({ db, analytics, authorize, env = process.env, externalAdapter, now = () => new Date().toISOString() }) {
  const external = externalAdapter || createExternalApiAdapter({ env, now });
  const collection = (context) => db.collection(`orgs/${context.tenantId}/workbench_api_owners/${hash(context.actorId)}/apis`);
  const guard = async (context) => { await authorize(context); if (context.actorRole !== 'admin') throw createHttpError(403, '관리자 본인의 등록 API만 이용할 수 있습니다.', 'registered_api_forbidden'); };
  const assertStored = (item) => {
    if (!item || hash(item.definition) !== item.definitionHash) throw createHttpError(409, '등록 API 버전이 없거나 저장 내용이 일치하지 않습니다.', 'registered_api_version_invalid');
    return item;
  };
  const describe = (context, item) => {
    if (item.definition.kind === 'external-read') {
      const endpoint = external.get(context, item.definition.endpointId, item.definition.endpointVersion);
      if (endpoint.contractHash !== item.endpointHash) throw createHttpError(409, '외부 API의 등록 당시 정의가 변경되었습니다. 새 연결 버전을 등록해 주세요.', 'registered_api_endpoint_changed');
      return { ...item, responseKind: 'external-read', responseSchema: endpoint.responseSchema };
    }
    if (!context.analyticsScope.datasetIds.includes(item.definition.plan.datasetId)) throw createHttpError(403, '이 API의 분석 자료를 조회할 권한이 없습니다.', 'registered_api_forbidden');
    return { ...item, responseKind: 'analytics-copy' };
  };
  const get = async (context, id, version) => {
    await guard(context);
    const ref = collection(context).doc(checkId(id));
    const latest = assertStored((await ref.get()).data());
    if (!latest.definition.enabled) throw createHttpError(409, '이 API의 사용이 중지되었습니다. 다른 API를 선택해 주세요.', 'registered_api_disabled');
    const item = version === undefined ? latest : assertStored((await ref.collection('versions').doc(String(parse(z.number().int().positive(), version))).get()).data());
    if (!item.definition.enabled) throw createHttpError(409, '사용이 중지된 API 버전입니다.', 'registered_api_disabled');
    const result = describe(context, item);
    await guard(context);
    return result;
  };
  return {
    get,
    async mutationResult(context) {
      await guard(context);
      if (!context.idempotencyKey) return null;
      const receipt = (await db.doc(`orgs/${context.tenantId}/workbench_mutation_results/${rawHash(context.idempotencyKey)}`).get()).data();
      if (!receipt) return null;
      if (receipt.kind !== 'registered-api' || receipt.actorId !== context.actorId || receipt.tenantId !== context.tenantId || receipt.scopeFingerprint !== (context.analyticsScope?.fingerprint || null)) throw createHttpError(403, '현재 권한으로 이 API 저장 결과를 확인할 수 없습니다.', 'registered_api_operation_forbidden');
      const result = describe(context, assertStored((await collection(context).doc(checkId(receipt.apiId)).collection('versions').doc(String(receipt.version)).get()).data()));
      await guard(context); return result;
    },
    async listEndpoints(context) { await guard(context); const result = external.list(context); await guard(context); return result; },
    async list(context) {
      await guard(context);
      const records = await collection(context).orderBy('updatedAt', 'desc').limit(101).get();
      const items = records.docs.slice(0, 100).map((record) => assertStored(record.data())).filter((item) => item.definition.kind === 'external-read' ? external.list(context).items.some((endpoint) => endpoint.id === item.definition.endpointId && endpoint.version === item.definition.endpointVersion) : context.analyticsScope.datasetIds.includes(item.definition.plan.datasetId)).map((item) => describe(context, item));
      await guard(context); return { items, truncated: records.size > 100 };
    },
    async save(context, id, input) {
      await guard(context);
      const request = parse(saveInput, input);
      if (Object.keys(request.definition.parameters).length > 12 || JSON.stringify(request).length > 32000) throw createHttpError(400, 'API 입력은 12개, 정의는 32KB 이내로 등록해 주세요.', 'registered_api_invalid');
      const operation = context.idempotencyKey ? db.doc(`orgs/${context.tenantId}/workbench_mutation_results/${rawHash(context.idempotencyKey)}`) : null;
      const payloadHash = rawHash(stableJson({ id, request }));
      const replay = async (receipt, read) => {
        if (receipt.kind !== 'registered-api' || receipt.actorId !== context.actorId || receipt.tenantId !== context.tenantId || receipt.payloadHash !== payloadHash || receipt.scopeFingerprint !== (context.analyticsScope?.fingerprint || null)) throw createHttpError(409, '같은 요청 번호의 API 내용이나 권한 범위가 다릅니다.', 'registered_api_operation_conflict');
        return describe(context, assertStored((await read(collection(context).doc(receipt.apiId).collection('versions').doc(String(receipt.version)))).data()));
      };
      if (operation) { const receipt = (await operation.get()).data(); if (receipt) { const result = await replay(receipt, (target) => target.get()); await guard(context); return result; } }
      const examples = Object.fromEntries(Object.entries(request.definition.parameters).map(([key, value]) => [key, value.example]));
      validateApiInput(request.definition.parameters, examples);
      let endpointHash;
      if (request.definition.kind === 'external-read') {
        const endpoint = external.get(context, request.definition.endpointId, request.definition.endpointVersion);
        if (stableJson(request.definition.parameters) !== stableJson(endpoint.parameters)) throw createHttpError(400, '외부 API 입력 정의는 승인된 연결과 동일해야 합니다.', 'registered_api_parameters_mismatch');
        endpointHash = endpoint.contractHash;
      } else {
        const plan = resolveApiPlan(request.definition.plan, examples);
        if (typeof request.definition.plan.datasetId !== 'string') throw createHttpError(400, '조회 자료는 입력값이 아닌 고정된 자료를 선택해 주세요.', 'registered_api_invalid');
        const catalog = await analytics.catalog(context);
        compileSemanticQuery({ plan, catalogItems: catalog.items });
      }
      const ref = collection(context).doc(id ? checkId(id) : randomUUID());
      await guard(context);
      return db.runTransaction(async (tx) => {
        if (operation) { const receipt = (await tx.get(operation)).data(); if (receipt) return replay(receipt, (target) => tx.get(target)); }
        const current = (await tx.get(ref)).data();
        if ((current?.version || 0) !== request.expectedVersion || (!id && request.expectedVersion !== 0) || (id && !current)) throw createHttpError(409, 'API가 다른 창에서 변경되었습니다. 새로 읽은 뒤 다시 저장해 주세요.', 'registered_api_conflict');
        const value = { id: ref.id, version: request.expectedVersion + 1, definition: request.definition, definitionHash: hash(request.definition), updatedAt: now(), updatedBy: context.actorId, ...(endpointHash ? { endpointHash } : {}) };
        tx.set(ref, value); tx.create(ref.collection('versions').doc(String(value.version)), value);
        if (operation) tx.create(operation, { kind: 'registered-api', actorId: context.actorId, tenantId: context.tenantId, scopeFingerprint: context.analyticsScope?.fingerprint || null, apiId: value.id, version: value.version, payloadHash, definitionHash: value.definitionHash, completedAt: now(), ...operationReceiptMetadata(context) });
        return describe(context, value);
      });
    },
    async invoke(context, id, version, input, { signal } = {}) {
      const item = await get(context, id, version);
      validateApiInput(item.definition.parameters, input);
      const plan = item.definition.kind === 'analytics-copy' ? resolveApiPlan(item.definition.plan, input) : null;
      const invocation = collection(context).doc(id).collection('calls').doc(randomUUID());
      await invocation.create({ apiVersion: version, actorId: context.actorId, startedAt: now(), state: 'started' });
      try {
        const result = plan ? await analytics.queryPlan(context, plan, { signal }) : await external.invoke(context, item.definition.endpointId, item.definition.endpointVersion, input, { signal, authorize: guard });
        await get(context, id, version);
        const response = { apiId: id, apiVersion: version, ...(plan ? { evidenceId: result.evidenceId, columns: result.columns, rows: result.rows, metadata: result.metadata, semantic: result.semantic, truncated: result.truncated } : result) };
        if (Buffer.byteLength(JSON.stringify(response)) > 256000) throw createHttpError(413, '조회 결과가 너무 큽니다. API 조회 범위를 줄여 주세요.', 'registered_api_result_large');
        await invocation.update({ state: 'completed', completedAt: now(), ...(result.evidenceId ? { evidenceId: result.evidenceId } : { endpointId: item.definition.endpointId, endpointVersion: item.definition.endpointVersion }) });
        return response;
      } catch (error) { await invocation.update({ state: 'failed', completedAt: now(), errorCode: error.code || 'query_failed' }); throw error; }
    },
  };
}
