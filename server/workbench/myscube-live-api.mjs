import { COMPANY_SUMMARY_ENDPOINT, validateCompanySummary } from './myscube-company-summary.mjs';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import { createHttpError } from '../bff/bff-utils.mjs';
import { isPublicExternalAddress, requestPinnedExternalJson, validateExternalResponse } from './external-api.mjs';

export const MYSCUBE_LIVE_ORIGIN = 'https://myscube.myscguard.app';
// Cloudflare blocks an empty User-Agent (mysc_explicit_automation_client_block); the edge scopes this identity to the AXR egress IP.
export const MYSCUBE_LIVE_USER_AGENT = 'MYSCube-AXR-Workbench/1.0';
const MAX_BYTES = 256000;
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const text = (maxLength = 1000, nullable = false) => ({ type: 'string', maxLength, ...(nullable ? { nullable: true } : {}) });
const integer = (nullable = false) => ({ type: 'integer', ...(nullable ? { nullable: true } : {}) });
const bool = { type: 'boolean' };
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
const enumeration = values => ({ ...text(), enum: values });
const nullable = schema => ({ ...schema, nullable: true });
const amounts = object({ inflow: integer(true), outflow: integer(true), cumulativeBalance: integer(true) });
const week = object({ weekNo: integer(), start: text(10), end: text(10), availability: enumeration(['AVAILABLE', 'NOT_RECORDED']), totals: amounts });
const source = object({ authority: enumeration(['JVM']), targetRevision: text(200), retrievedAt: text(40), capturedAt: { type: 'null' }, freshness: enumeration(['UNKNOWN']), liveSheetVerified: { type: 'boolean', enum: [false] },
  sheetMirror: object({ authority: enumeration(['BFF_PINNED_MIRROR']), capturedAt: text(40, true), sourceRevision: text(128, true), appliedSourceRevision: text(128, true), appliedTargetRevision: text(128, true), matchesJvmRevision: bool }) });
const evidence = object({ projectId: text(500), yearMonth: text(7), amountCurrency: enumeration(['KRW']), fieldStateAvailability: enumeration(['NOT_EXPOSED']), availability: enumeration(['AVAILABLE', 'NOT_RECORDED']), totalsScope: enumeration(['RECORDED_JVM_LINES']),
  monthlyTotals: object({ projection: amounts, actual: amounts }), projection: array(week, 5), actual: array(week, 5), source, warnings: array(text(2000), 20) });
const errorSchema = object({ category: text(80, true), code: text(100, true), httpStatus: integer(true) });
const summaryAmount = object({ value: integer(true), included: integer(), excluded: integer() });
const summaryMode = object({ inflow: summaryAmount, outflow: summaryAmount, cumulativeBalance: summaryAmount });
const projectSchema = object({ document_id: { type: 'null' }, project_id: text(500), project_name: text(10000, true), status: text(10000, true), cic: text(10000, true), contract_start_raw: text(10000, true), contract_end_raw: text(10000, true),
  contract_start: text(10, true), contract_end: text(10, true), contract_end_undecided: { type: 'boolean', nullable: true }, updated_at_raw: text(10000, true), trashed_at_raw: text(10000, true), document_updated_at: { type: 'null' } });
const projectsResponse = object({ items: array(projectSchema, 20), count: integer(), nextCursor: text(500, true) });
const cashflowResponse = object({ yearMonth: text(7), queriedAt: text(40), rows: array(object({ projectId: text(500), name: text(1000), cic: text(1000), status: enumeration(['AVAILABLE', 'NOT_RECORDED', 'FAILED']),
  projection: nullable(amounts), actual: nullable(amounts), difference: nullable(amounts), missingWeeks: nullable(object({ projection: array(integer(), 5), actual: array(integer(), 5) })), evidence: nullable(evidence), error: nullable(errorSchema) }), 10),
  totals: object({ projection: summaryMode, actual: summaryMode, difference: summaryMode }), scope: enumeration(['accessible_projects_in_this_page']), totalsScope: enumeration(['THIS_PAGE_ONLY']), amountCurrency: enumeration(['KRW']),
  accessibleInPage: integer(), available: integer(), notRecorded: integer(), failed: integer(), nextAfter: text(500, true), catalogComplete: bool, limitations: array(text(2000), 20) });
const definitions = [
  { id: 'myscube-projects', version: 1, name: 'MYSCube 사업 목록', description: '현재 사용자가 조회할 수 있는 MYSCube 사업 원문 목록의 한 페이지입니다. 휴지통 항목도 포함하며 상태의 업무 의미를 추정하지 않습니다. document_id와 document_updated_at은 원본 API가 구분하여 제공하지 않아 null입니다. project_id는 API 응답 id이며 원본 문서 ID와 저장된 id를 구분할 수 없습니다.',
    parameters: { limit: { type: 'integer', required: false, label: '페이지 사업 수(최대 20)', example: 20 }, cursor: { type: 'string', required: false, label: '다음 페이지 위치', example: 'project-20' } }, responseSchema: projectsResponse },
  { id: 'myscube-cashflow-evidence', version: 1, name: 'MYSCube 월·주 현금흐름 근거', description: '한 번에 최대 10개 사업의 요청 월·주차 원장 합계를 조회합니다. 합계는 이번 페이지만 포함하며 전사 전체나 현재 Google Sheets의 최신 값이 아닙니다. 미확인과 실패는 0원이 아닙니다.',
    parameters: { yearMonth: { type: 'string', required: true, label: '조회 월', example: '2026-09' }, after: { type: 'string', required: false, label: '다음 페이지 위치', example: 'project-10' } }, responseSchema: cashflowResponse },
];
const fail = (status, code, message) => { throw createHttpError(status, code.startsWith('myscube_live_') ? message : 'MYSCube 조회를 완료하지 못했습니다.', code); };
const invalid = () => fail(502, 'myscube_live_response_invalid', 'MYSCube 응답의 범위·값 형식을 확인하지 못해 표시하지 않았습니다.');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const cursor = value => typeof value === 'string' && value.length >= 1 && value.length <= 500 && !/[\x00-\x1f\x7f/]/.test(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const pick = (value, names) => { if (!record(value)) invalid(); return Object.fromEntries(names.map(key => [key, value[key]])); };
const strings = values => Array.isArray(values) && values.length <= 20 && values.every(value => typeof value === 'string' && value.length <= 2000);
function rawText(value) { if (value == null) return null; if (typeof value !== 'string' || value.length > 10000) invalid(); return value; }
function dateValue(value) { if (value === null || value === '') return null; if (!day(value)) invalid(); return value; }
function projectPage(raw, input) {
  if (!record(raw) || !Array.isArray(raw.items) || raw.items.length > input.limit || raw.count !== raw.items.length || !(raw.nextCursor === null || cursor(raw.nextCursor))) invalid();
  const ids = new Set();
  const items = raw.items.map(value => {
    if (!record(value) || !cursor(value.id) || ids.has(value.id)) invalid(); ids.add(value.id);
    const start = rawText(value.contractStart), end = rawText(value.contractEnd);
    if (value.contractEndUndecided != null && typeof value.contractEndUndecided !== 'boolean') invalid();
    return { document_id: null, project_id: value.id, project_name: rawText(value.name), status: rawText(value.status), cic: rawText(value.cic), contract_start_raw: start, contract_end_raw: end,
      contract_start: dateValue(start), contract_end: dateValue(end), contract_end_undecided: value.contractEndUndecided ?? null, updated_at_raw: rawText(value.updatedAt), trashed_at_raw: rawText(value.trashedAt), document_updated_at: null };
  });
  if (raw.nextCursor !== null && (items.length !== input.limit || raw.nextCursor !== items.at(-1)?.project_id)) invalid();
  return { items, count: raw.count, nextCursor: raw.nextCursor };
}
function money(value) { const result = pick(value, ['inflow', 'outflow', 'cumulativeBalance']); if (Object.values(result).some(value => value !== null && !Number.isSafeInteger(value))) invalid(); return result; }
function weekRows(values) {
  if (!Array.isArray(values) || values.length > 5) invalid();
  const ids = new Set();
  return values.map(value => {
    const result = pick(value, ['weekNo', 'start', 'end', 'availability']);
    if (!Number.isInteger(result.weekNo) || result.weekNo < 1 || result.weekNo > 5 || ids.has(result.weekNo) || !day(result.start) || !day(result.end) || result.start > result.end || !['AVAILABLE', 'NOT_RECORDED'].includes(result.availability)) invalid();
    ids.add(result.weekNo); result.totals = money(value.totals);
    if (result.availability === 'NOT_RECORDED' && Object.values(result.totals).some(value => value !== null)) invalid();
    return result;
  });
}
function rowEvidence(value, row, input) {
  const result = pick(value, ['projectId', 'yearMonth', 'amountCurrency', 'fieldStateAvailability', 'availability', 'totalsScope']);
  if (result.projectId !== row.projectId || result.yearMonth !== input.yearMonth || value.detail !== 'summary' || !strings(value.warnings)) invalid();
  result.monthlyTotals = { projection: money(value.monthlyTotals?.projection), actual: money(value.monthlyTotals?.actual) };
  result.projection = weekRows(value.projection); result.actual = weekRows(value.actual);
  if (JSON.stringify(result.projection.map(({ weekNo, start, end }) => [weekNo, start, end])) !== JSON.stringify(result.actual.map(({ weekNo, start, end }) => [weekNo, start, end]))) invalid();
  result.source = pick(value.source, ['authority', 'targetRevision', 'retrievedAt', 'capturedAt', 'freshness', 'liveSheetVerified']);
  if (!instant(result.source.retrievedAt)) invalid();
  result.source.sheetMirror = pick(value.source?.sheetMirror, ['authority', 'capturedAt', 'sourceRevision', 'appliedSourceRevision', 'appliedTargetRevision', 'matchesJvmRevision']);
  if (result.source.sheetMirror.capturedAt !== null && !instant(result.source.sheetMirror.capturedAt)) invalid();
  result.warnings = [...value.warnings]; return result;
}
function cashflowPage(raw, input) {
  if (!record(raw) || raw.yearMonth !== input.yearMonth || !instant(raw.queriedAt) || !Array.isArray(raw.rows) || raw.rows.length > 10 || !(raw.nextAfter === null || cursor(raw.nextAfter)) || !strings(raw.limitations)) invalid();
  const ids = new Set();
  const rows = raw.rows.map(value => {
    const row = pick(value, ['projectId', 'name', 'cic', 'status']);
    if (!cursor(row.projectId) || ids.has(row.projectId)) invalid(); ids.add(row.projectId);
    if (row.status === 'FAILED') {
      if (!record(value.error) || ['projection', 'actual', 'difference', 'evidence', 'missingWeeks'].some(key => value[key] != null)) invalid();
      const category = value.error.category, code = value.error.code, httpStatus = value.error.httpStatus;
      return { ...row, projection: null, actual: null, difference: null, missingWeeks: null, evidence: null, error: { category: typeof category === 'string' && /^[a-zA-Z_]{1,80}$/.test(category) ? category : null, code: typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : null, httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null } };
    }
    row.projection = money(value.projection); row.actual = money(value.actual); row.difference = money(value.difference);
    row.missingWeeks = pick(value.missingWeeks, ['projection', 'actual']); row.evidence = rowEvidence(value.evidence, row, input); row.error = null;
    for (const mode of ['projection', 'actual']) {
      if (JSON.stringify(row[mode]) !== JSON.stringify(row.evidence.monthlyTotals[mode]) || JSON.stringify(row.missingWeeks[mode]) !== JSON.stringify(row.evidence[mode].filter(week => week.availability === 'NOT_RECORDED').map(week => week.weekNo))) invalid();
    }
    const recorded = [...row.evidence.projection, ...row.evidence.actual].some(week => week.availability === 'AVAILABLE');
    if (row.status !== (recorded ? 'AVAILABLE' : 'NOT_RECORDED')) invalid();
    return row;
  });
  const result = { ...pick(raw, ['yearMonth', 'queriedAt', 'scope', 'totalsScope', 'amountCurrency', 'accessibleInPage', 'available', 'notRecorded', 'failed', 'nextAfter', 'catalogComplete']), rows, totals: {}, limitations: [...raw.limitations] };
  for (const mode of ['projection', 'actual', 'difference']) result.totals[mode] = Object.fromEntries(['inflow', 'outflow', 'cumulativeBalance'].map(field => {
    const value = pick(raw.totals?.[mode]?.[field], ['value', 'included', 'excluded']);
    if (value.value !== null && !Number.isSafeInteger(value.value) || !Number.isInteger(value.included) || !Number.isInteger(value.excluded) || value.included < 0 || value.excluded < 0 || value.included + value.excluded !== rows.length || (value.included === 0) !== (value.value === null)) invalid();
    return [field, value];
  }));
  if (result.accessibleInPage !== rows.length || result.available !== rows.filter(row => row.status === 'AVAILABLE').length || result.notRecorded !== rows.filter(row => row.status === 'NOT_RECORDED').length || result.failed !== rows.filter(row => row.status === 'FAILED').length || result.catalogComplete !== (raw.nextAfter === null && !input.after)) invalid();
  return result;
}
function pageWeekCalendarUniform(data) {
  const calendars = data.rows.filter(row => row.status === 'AVAILABLE').map(row =>
    JSON.stringify(row.evidence.actual.map(({ weekNo, start, end }) => [weekNo, start, end]).sort((a, b) => a[0] - b[0])));
  return calendars.length ? calendars.every(calendar => calendar === calendars[0]) : null;
}
function bounded(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(createHttpError(504, 'MYSCube 조회 시간이 한도를 넘었습니다.', 'myscube_live_timeout'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function requestMyscubeLiveJson(options, requestImpl = https.request) {
  let status, closed;
  try {
    return await requestPinnedExternalJson({ ...options, requestImpl: (url, settings, receive) => {
      const req = requestImpl(url, settings, response => { status = response.statusCode; receive(response); });
      closed = new Promise(resolve => req.once('close', resolve));
      return req;
    } });
  } catch (cause) {
    if (status === 401 || status === 403) fail(status, 'myscube_live_authorization_denied', 'MYSCube 인증 또는 접근 권한이 거부됐습니다. 로그인 상태를 다시 확인해 주세요.');
    throw cause;
  } finally { if (closed) await closed; }
}
export function createMyscubeLiveApiAdapter({ env = process.env, enabled = env.WORKBENCH_MYSCUBE_LIVE_ENABLED === 'true', credentialProvider, resolveDns = lookup, transport = requestMyscubeLiveJson, now = () => new Date().toISOString(), monotonicNow = () => performance.now(), schedule = (callback, delay) => setTimeout(callback, delay) } = {}) {
  const enabledDefinitions = env.WORKBENCH_MYSCUBE_COMPANY_SUMMARY_ENABLED === 'true' ? [...definitions, COMPANY_SUMMARY_ENDPOINT] : definitions;
  let active = 0, lastClock = 0; const actors = new Set(), admitted = [];
  const clock = () => { const value = monotonicNow(); if (!Number.isFinite(value)) throw new Error('Invalid monotonic clock.'); lastClock = Math.max(lastClock, value); return lastClock; };
  const admitRate = key => {
    const at = clock();
    while (admitted.length && admitted[0].at <= at - 60000) admitted.shift();
    if (admitted.length >= 60 || admitted.filter(item => item.key === key).length >= 12) fail(429, 'myscube_live_rate_limited', 'MYSCube 조회 횟수가 한도에 도달했습니다. 잠시 후 수동으로 다시 조회해 주세요.');
    admitted.push({ at, key });
  };
  const allowed = context => enabled === true && context?.tenantId === 'mysc' && context.actorRole === 'admin' && typeof context.actorId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(context.actorId);
  const definition = (context, id, version) => { const value = enabledDefinitions.find(value => value.id === id && value.version === version); if (!allowed(context) || !value) fail(403, 'myscube_live_forbidden', '현재 계정에서 사용할 수 없는 MYSCube 연결입니다.'); return value; };
  const publicDefinition = value => ({ ...structuredClone(value), contractHash: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
  return {
    list: context => ({ items: allowed(context) ? enabledDefinitions.map(publicDefinition) : [] }),
    get: (context, id, version) => publicDefinition(definition(context, id, version)),
    async invoke(context, id, version, input, { signal, authorize } = {}) {
      const selected = definition(context, id, version);
      const companySummary = id === COMPANY_SUMMARY_ENDPOINT.id;
      const timeoutMs = companySummary ? 55000 : 10000;
      const sourceBudgetMs = companySummary ? 360000 : 25000;
      if (typeof authorize !== 'function') throw new Error('Live API requires an authorization callback.');
      if (!record(input) || Object.keys(input).some(key => !Object.hasOwn(selected.parameters, key))) fail(400, 'myscube_live_input_invalid', '등록된 조회 조건만 입력해 주세요.');
      const params = { ...input };
      if (id === 'myscube-projects') {
        params.limit ??= 20;
        if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 20 || params.cursor !== undefined && !cursor(params.cursor)) fail(400, 'myscube_live_input_invalid', '사업 목록의 페이지 크기와 다음 위치를 확인해 주세요.');
      } else if (typeof params.yearMonth !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(params.yearMonth) || params.after !== undefined && (!cursor(params.after) || params.after.length > 100) || companySummary && params.weekNo !== undefined && (!Number.isInteger(params.weekNo) || params.weekNo < 1 || params.weekNo > 5)) fail(400, 'myscube_live_input_invalid', '조회 월과 다음 페이지 위치를 확인해 주세요.');
      if (typeof credentialProvider !== 'function') fail(503, 'myscube_live_credentials_unavailable', '현재 로그인으로 MYSCube를 연결할 준비가 되지 않았습니다.');
      const key = `${context.tenantId}:${context.actorId}`;
      if (active >= 2 || actors.has(key)) fail(429, 'myscube_live_busy', 'MYSCube 조회가 진행 중입니다. 완료한 뒤 다시 조회해 주세요.');
      admitRate(key);
      active++; actors.add(key);
      let networkPromise, networkSettled = true, dispatchedAt = null, upstreamMayContinue = false;
      const deadline = clock() + timeoutMs;
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
      const checkDeadline = () => { if (combined.aborted || clock() >= deadline) { controller.abort(); fail(504, 'myscube_live_timeout', 'MYSCube 조회 시간이 한도를 넘었습니다.'); } };
      const check = async () => { checkDeadline(); await bounded(Promise.resolve().then(() => authorize(context)), combined); checkDeadline(); definition(context, id, version); };
      try {
        await check();
        const addresses = await bounded(Promise.resolve().then(() => resolveDns('myscube.myscguard.app', { all: true, verbatim: true })), combined);
        if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 32 || addresses.some(value => !isPublicExternalAddress(value.address) || isIP(value.address) !== value.family)) fail(403, 'myscube_live_address_forbidden', '허용된 MYSCube 공개 주소를 확인하지 못했습니다.');
        const authorization = await bounded(Promise.resolve().then(() => credentialProvider(context)), combined);
        if (typeof authorization !== 'string' || authorization.length > 8192 || !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)) fail(401, 'myscube_live_credentials_unavailable', '로그인 정보를 다시 확인해 주세요.');
        await check();
        const url = new URL(id === 'myscube-projects' ? '/api/v1/projects' : companySummary ? '/api/v1/company-cashflow-summary' : '/api/v1/cashflow-evidence', MYSCUBE_LIVE_ORIGIN);
        for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
        checkDeadline();
        networkSettled = false;
        networkPromise = Promise.resolve().then(() => { checkDeadline(); dispatchedAt = clock(); return transport({ url, ...addresses[0], headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': MYSCUBE_LIVE_USER_AGENT, Authorization: authorization, 'x-tenant-id': context.tenantId }, signal: combined, maxBytes: MAX_BYTES }); });
        networkPromise.then(() => { networkSettled = true; }, () => { networkSettled = true; });
        const raw = await bounded(networkPromise, combined);
        await check();
        if (Buffer.byteLength(JSON.stringify(raw)) > MAX_BYTES) fail(413, 'myscube_live_response_large', 'MYSCube 응답이 조회 용량 한도를 넘었습니다.');
        const data = id === 'myscube-projects' ? projectPage(raw, params) : companySummary ? validateCompanySummary(raw, params) : cashflowPage(raw, params);
        validateExternalResponse(selected.responseSchema, data);
        checkDeadline();
        const limitations = id === 'myscube-projects' ? ['이번 페이지의 사업 원문만 조회했습니다. 휴지통 항목도 포함하며 상태 코드로 활성·승인 여부를 추정하지 않습니다.', 'document_id와 document_updated_at은 API 미제공으로 null입니다. project_id는 API 응답 id로 원본 문서 식별자와 저장값을 구분할 수 없습니다.', '계약기간은 계약서 날짜이며 입금기간이 아닙니다.'] : [...data.limitations];
        return { data, metadata: { source: selected.name, endpointId: id, endpointVersion: version, asOf: now(), sourceKind: 'myscube-live', ...(companySummary ? { catalogComplete: data.catalogComplete, weekCalendarUniform: data.weekCalendarUniform, companySummary: true } : {}), ...(id === 'myscube-cashflow-evidence' ? { catalogComplete: data.catalogComplete, accessibleInPage: data.accessibleInPage, weekCalendarUniform: pageWeekCalendarUniform(data) } : {}), resultScope: id === 'myscube-projects' ? 'THIS_PAGE_ONLY' : data.totalsScope, limitations }, truncated: companySummary ? data.totalsScope !== 'COMPLETE_REGISTERED_PROJECTS' : (id === 'myscube-projects' ? data.nextCursor : data.nextAfter) !== null };
      } catch (cause) {
        upstreamMayContinue = combined.aborted || !Number.isInteger(cause?.statusCode) || [502, 503, 504].includes(cause.statusCode);
        let error;
        if (combined.aborted) error = createHttpError(504, 'MYSCube 조회 시간이 한도를 넘었습니다.', 'myscube_live_timeout');
        else if ([401, 403].includes(cause?.statusCode)) error = createHttpError(cause.statusCode, 'MYSCube 인증 또는 접근 권한을 확인해 주세요.', 'myscube_live_authorization_denied');
        else if (typeof cause?.code === 'string' && cause.code.startsWith('myscube_live_') && cause.expose) error = cause;
        else error = createHttpError(502, 'MYSCube 조회를 완료하지 못했습니다. 원본 응답이나 인증 정보는 표시하지 않았습니다.', 'myscube_live_request_failed');
        if ((id === 'myscube-cashflow-evidence' || companySummary) && dispatchedAt !== null && upstreamMayContinue) error.details = { sourceKind: 'myscube-live', sourceWorkMayContinue: true, sourceBudgetMs, retryAfterMs: Math.max(0, Math.ceil(dispatchedAt + sourceBudgetMs - clock())) };
        throw error;
      } finally {
        clearTimeout(timeout);
        const release = () => { active--; actors.delete(key); };
        const releaseWhenSafe = () => {
          const remaining = id === 'myscube-cashflow-evidence' && dispatchedAt !== null && upstreamMayContinue ? dispatchedAt + sourceBudgetMs - clock() : 0;
          if (remaining > 0) { schedule(releaseWhenSafe, Math.ceil(remaining))?.unref?.(); return; }
          release();
        };
        if (networkSettled) releaseWhenSafe();
        else { controller.abort(); networkPromise.then(releaseWhenSafe, releaseWhenSafe); }
      }
    },
  };
}
