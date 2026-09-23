import { createHash } from 'node:crypto';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHttpError } from '../bff/bff-utils.mjs';

const error = (status, code, message) => createHttpError(status, message, code);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
export function isPublicExternalAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes('%')) return false;
  const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  const [a, b = '0'] = normalized.split(':'); const first = parseInt(a, 16), second = parseInt(b || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) && !(first === 0x3fff && second <= 0xfff);
}

function validateSchema(schema, depth = 0, budget = { nodes: 0 }) {
  if (!record(schema) || ++budget.nodes > 150 || depth > 8 || !keys(schema, ['type', 'properties', 'required', 'additionalProperties', 'items', 'maxItems', 'maxLength', 'enum', 'description', 'nullable'])
    || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)) throw error(503, 'external_schema_invalid', '외부 API 응답 형식 설정을 확인해 주세요.');
  if (schema.type === 'object') {
    if (!record(schema.properties) || schema.additionalProperties !== false || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string' || !Object.hasOwn(schema.properties, key))))) throw error(503, 'external_schema_invalid', '외부 API 객체의 허용 항목과 필수 항목을 확인해 주세요.');
    for (const [name, value] of Object.entries(schema.properties)) {
      if (['__proto__', 'constructor', 'prototype'].includes(name)) throw error(503, 'external_schema_invalid', '지원하지 않는 외부 API 항목입니다.');
      validateSchema(value, depth + 1, budget);
    }
  }
  if (schema.type === 'array') {
    if (!Number.isSafeInteger(schema.maxItems) || schema.maxItems < 0 || schema.maxItems > 500) throw error(503, 'external_schema_invalid', '외부 API 배열의 최대 항목 수를 500개 이내로 설정해 주세요.');
    validateSchema(schema.items, depth + 1, budget);
  }
  if (schema.type === 'string' && (!Number.isSafeInteger(schema.maxLength) || schema.maxLength < 1 || schema.maxLength > 32000)) throw error(503, 'external_schema_invalid', '외부 API 문자열의 최대 길이를 설정해 주세요.');
  if (schema.enum && (!Array.isArray(schema.enum) || schema.enum.length > 100 || schema.enum.some((value) => value !== null && !['string', 'number', 'boolean'].includes(typeof value)))) throw error(503, 'external_schema_invalid', '외부 API 허용값 설정을 확인해 주세요.');
}
export function validateExternalResponse(schema, value) {
  const mismatch = () => { throw error(502, 'external_response_invalid', '외부 API 응답이 등록된 항목·값 형식과 다릅니다. 결과를 표시하지 않았습니다.'); };
  const visit = (spec, actual) => {
    if (actual === null && spec.nullable === true) return;
    if (spec.enum && !spec.enum.includes(actual)) mismatch();
    if (spec.type === 'null') { if (actual !== null) mismatch(); return; }
    if (spec.type === 'object') {
      if (!record(actual) || Object.keys(actual).some((key) => !Object.hasOwn(spec.properties, key)) || (spec.required || []).some((key) => !Object.hasOwn(actual, key))) mismatch();
      for (const [key, item] of Object.entries(actual)) visit(spec.properties[key], item);
    } else if (spec.type === 'array') {
      if (!Array.isArray(actual) || actual.length > spec.maxItems) mismatch();
      for (const item of actual) visit(spec.items, item);
    } else if (spec.type === 'integer') { if (!Number.isSafeInteger(actual)) mismatch(); }
    else if (spec.type === 'number') { if (typeof actual !== 'number' || !Number.isFinite(actual) || (Number.isInteger(actual) && !Number.isSafeInteger(actual))) mismatch(); }
    else if (typeof actual !== spec.type || (spec.type === 'string' && actual.length > spec.maxLength)) mismatch();
  };
  visit(schema, value); return value;
}

export function requestPinnedExternalJson({ url, address, family, headers, signal, maxBytes = 256000, requestImpl = https.request }) {
  return new Promise((resolve, reject) => {
    const req = requestImpl(url, { method: 'GET', headers, agent: false, family, servername: url.hostname, signal,
      lookup: (hostname, options, callback) => {
        if (hostname !== url.hostname) { callback(error(403, 'external_dns_changed', '허용된 외부 API 주소가 변경되었습니다.')); return; }
        if (options?.all) callback(null, [{ address, family }]); else callback(null, address, family);
      } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); reject(error(502, 'external_redirect_forbidden', '외부 API가 다른 주소로 이동했습니다. 연결 설정을 확인해 주세요.')); return; }
      if (res.statusCode !== 200) { res.destroy(); reject(error(502, 'external_request_failed', '외부 API 조회를 완료하지 못했습니다. 연결 상태를 확인해 주세요.')); return; }
      if (!/^application\/(?:[\w.-]+\+)?json\b/i.test(String(res.headers['content-type'] || '')) || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) { res.destroy(); reject(error(502, 'external_content_invalid', '외부 API의 응답 형식을 확인하지 못했습니다.')); return; }
      if (Number(res.headers['content-length']) > maxBytes) { res.destroy(); reject(error(413, 'external_response_large', '외부 API 응답이 조회 용량 한도를 넘었습니다.')); return; }
      let size = 0; const chunks = [];
      res.on('data', (chunk) => { size += chunk.length; if (size > maxBytes) { res.destroy(error(413, 'external_response_large', '외부 API 응답이 조회 용량 한도를 넘었습니다.')); return; } chunks.push(chunk); });
      res.on('error', (reason) => reject(reason.expose ? reason : error(502, 'external_response_failed', '외부 API 응답을 끝까지 읽지 못했습니다.')));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(error(502, 'external_json_invalid', '외부 API에서 올바른 JSON을 받지 못했습니다.')); } });
    });
    req.on('error', (reason) => reject(reason.expose ? reason : error(502, 'external_transport_failed', '외부 API에 연결하지 못했습니다.')));
    req.end();
  });
}

const withSignal = (promise, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(error(504, 'external_timeout', '외부 API 조회 시간이 한도를 넘었습니다.')); return; }
  const abort = () => reject(error(504, 'external_timeout', '외부 API 조회 시간이 한도를 넘었습니다.'));
  signal.addEventListener('abort', abort, { once: true });
  Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
});

export function createExternalApiAdapter({ env = process.env, resolveDns = lookup, transport = requestPinnedExternalJson, now = () => new Date().toISOString() } = {}) {
  const configured = () => {
    let values;
    try { values = JSON.parse(env.WORKBENCH_EXTERNAL_ENDPOINTS || '[]'); } catch { throw error(503, 'external_config_invalid', '외부 API 연결 설정을 확인해 주세요.'); }
    if (!Array.isArray(values) || values.length > 30) throw error(503, 'external_config_invalid', '외부 API 연결 개수와 설정을 확인해 주세요.');
    const unique = new Set();
    return values.map((value) => {
      if (!record(value) || !keys(value, ['id', 'version', 'name', 'description', 'url', 'parameters', 'responseSchema', 'auth', 'allowedTenants'])
        || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.id || '') || !Number.isSafeInteger(value.version) || value.version < 1
        || typeof value.name !== 'string' || !value.name || value.name.length > 80 || typeof value.description !== 'string' || !value.description || value.description.length > 1000
        || !record(value.parameters) || Object.keys(value.parameters).length > 12 || !Array.isArray(value.allowedTenants) || !value.allowedTenants.length
        || value.allowedTenants.some((id) => !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw error(503, 'external_config_invalid', '외부 API의 식별자·버전·허용 조직·입력 정의를 확인해 주세요.');
      let url; try { url = new URL(value.url); } catch { throw error(503, 'external_url_invalid', '외부 API 주소를 확인해 주세요.'); }
      if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash || url.search || url.hostname.endsWith('.') || url.hostname.includes('%')) throw error(503, 'external_url_invalid', '외부 API는 인증정보·쿼리가 없는 HTTPS 443 주소로 설정해 주세요.');
      validateSchema(value.responseSchema);
      for (const [name, parameter] of Object.entries(value.parameters)) {
        if (!/^[a-z][a-zA-Z0-9_]{0,63}$/.test(name) || /^(?:api_?key|token|secret|password|authorization)$/i.test(name) || !record(parameter) || !keys(parameter, ['type', 'required', 'label', 'example', 'enum']) || !['string', 'integer', 'number', 'boolean'].includes(parameter.type)
          || typeof parameter.required !== 'boolean' || typeof parameter.label !== 'string' || !parameter.label || !Object.hasOwn(parameter, 'example')) throw error(503, 'external_parameters_invalid', '외부 API 입력 정의를 확인해 주세요.');
      }
      if (value.auth && (!record(value.auth) || !keys(value.auth, ['type', 'secretEnv', 'header']) || !['bearer', 'header'].includes(value.auth.type)
        || !/^WORKBENCH_EXTERNAL_SECRET_[A-Z0-9_]+$/.test(value.auth.secretEnv || '') || (value.auth.type === 'header' && !/^x-[a-z0-9-]{1,60}$/i.test(value.auth.header || '')))) throw error(503, 'external_auth_invalid', '외부 API 전용 인증 설정을 확인해 주세요.');
      const identity = `${value.id}:${value.version}`;
      if (unique.has(identity)) throw error(503, 'external_version_duplicate', '외부 API의 같은 버전이 중복되었습니다.');
      unique.add(identity); return value;
    });
  };
  const endpoint = (context, id, version) => {
    const value = configured().find((item) => item.id === id && item.version === version && item.allowedTenants.includes(context.tenantId));
    if (!value) throw error(403, 'external_endpoint_forbidden', '이 조직에서 사용할 수 없는 외부 API이거나 연결 버전이 준비되지 않았습니다.');
    return value;
  };
  const publicDefinition = (value) => ({ id: value.id, version: value.version, name: value.name, description: value.description, parameters: value.parameters, responseSchema: value.responseSchema, contractHash: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
  return {
    list: (context) => ({ items: configured().filter((item) => item.allowedTenants.includes(context.tenantId)).map(publicDefinition) }),
    get: (context, id, version) => publicDefinition(endpoint(context, id, version)),
    async invoke(context, id, version, input, { signal, authorize } = {}) {
      if (typeof authorize !== 'function') throw new Error('External API requires authorization');
      const bounded = AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]);
      await authorize(context); bounded.throwIfAborted();
      const definition = endpoint(context, id, version);
      if (!record(input) || Object.keys(input).some((key) => !Object.hasOwn(definition.parameters, key))) throw error(400, 'external_input_invalid', '등록한 외부 API 입력만 전달해 주세요.');
      const url = new URL(definition.url);
      for (const [name, parameter] of Object.entries(definition.parameters)) {
        const value = input[name]; if (value === undefined && !parameter.required) continue;
        if ((parameter.type === 'integer' ? !Number.isSafeInteger(value) : parameter.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value) : typeof value !== parameter.type)
          || (typeof value === 'string' && value.length > 500) || (parameter.enum && !parameter.enum.includes(value))) throw error(400, 'external_input_invalid', '외부 API 입력값의 형식과 허용 범위를 확인해 주세요.');
        url.searchParams.set(name, String(value));
      }
      const host = url.hostname.replace(/^\[|\]$/g, '');
      let addresses;
      try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await withSignal(resolveDns(host, { all: true, verbatim: true }), bounded); }
      catch (reason) { if (reason?.code === 'external_timeout') throw reason; throw error(502, 'external_dns_failed', '외부 API 주소를 확인하지 못했습니다.'); }
      bounded.throwIfAborted();
      if (!Array.isArray(addresses) || !addresses.length || addresses.some((item) => !isPublicExternalAddress(item.address) || isIP(item.address) !== item.family)) throw error(403, 'external_address_forbidden', '내부 주소나 확인할 수 없는 주소로는 API를 연결할 수 없습니다.');
      const headers = { Accept: 'application/json', 'Accept-Encoding': 'identity' };
      if (definition.auth) {
        const secret = env[definition.auth.secretEnv];
        if (typeof secret !== 'string' || !secret || secret.length > 8000 || /[\r\n]/.test(secret)) throw error(503, 'external_auth_unavailable', '외부 API의 전용 인증 정보가 준비되지 않았습니다.');
        headers[definition.auth.type === 'bearer' ? 'Authorization' : definition.auth.header] = definition.auth.type === 'bearer' ? `Bearer ${secret}` : secret;
      }
      await authorize(context); bounded.throwIfAborted();
      const result = await withSignal(transport({ url, ...addresses[0], headers, signal: bounded, maxBytes: 256000 }), bounded);
      bounded.throwIfAborted(); await authorize(context);
      const current = endpoint(context, id, version);
      if (JSON.stringify(current) !== JSON.stringify(definition)) throw error(409, 'external_definition_changed', '조회 중 외부 API 연결 정의가 바뀌었습니다. 다시 확인해 주세요.');
      if (Buffer.byteLength(JSON.stringify(result)) > 256000) throw error(413, 'external_response_large', '외부 API 응답이 조회 용량 한도를 넘었습니다.');
      validateExternalResponse(definition.responseSchema, result);
      return { data: result, metadata: { source: definition.name, endpointId: id, endpointVersion: version, asOf: now(), resultScope: '외부 API가 응답한 범위입니다. 전체 사업 또는 전체 기간을 보장하지 않습니다.' }, truncated: false };
    },
  };
}
