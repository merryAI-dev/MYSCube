import { createHash } from 'node:crypto';
import { createAnalyticsService } from './analytics-service.mjs';
import { ANALYTICS_CLOCK_SKEW_MS, analyticsError } from './analytics-contract.mjs';
import { resolveWorkbenchRuntime } from './runtime-config.mjs';

export const PROJECT_COPY_DATASET = 'projects_inventory_v1';
export const PROJECT_COPY_FIELDS = Object.freeze(['id', 'name', 'status', 'cic', 'contractStart', 'contractEnd', 'contractEndUndecided', 'updatedAt', 'trashedAt']);
export const PROJECT_COPY_LIMIT = 1000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const timestamp = value => {
  if (!Number.isSafeInteger(value?.seconds) || !Number.isInteger(value?.nanoseconds) || value.nanoseconds < 0 || value.nanoseconds > 999999999) fail('project_copy_time_invalid', '원본 문서의 정확한 조회·수정 시각이 없습니다.');
  return `${new Date(value.seconds * 1000).toISOString().slice(0, 19)}.${String(value.nanoseconds).padStart(9, '0')}Z`;
};
const fail = (code, message) => { throw analyticsError(409, code, message); };
function utcNanos(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  const milliseconds = match && Date.parse(`${match[1]}Z`);
  if (!match || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== match[1]) fail('project_copy_time_invalid', '원본 조회·수정·수집 시각은 정확한 UTC 시각이어야 합니다.');
  return BigInt(milliseconds) * 1000000n + BigInt((match[2] || '').padEnd(9, '0'));
}
const schema = [
  ['document_id', 'string', '사업 문서 식별자', '원본 문서 ID. project_id와 다르더라도 합치지 않습니다.'],
  ['project_id', 'string', '저장된 사업 식별자', '원본 id 값. 누락은 null입니다.'],
  ['project_name', 'string', '사업명', '원본 name 값 그대로입니다.'],
  ['status', 'string', '저장된 사업 상태', '원본 status 코드이며 승인·정산·현재 진행 여부를 추정하지 않습니다.'],
  ['cic', 'string', '저장된 담당 조직', '원본 cic 값. 누락된 조직을 대신 지정하지 않습니다.'],
  ['contract_start_raw', 'string', '계약 시작일 원문', '빈 문자열과 null을 구분하여 보존합니다.'],
  ['contract_end_raw', 'string', '계약 종료일 원문', '빈 문자열과 null을 구분하여 보존합니다.'],
  ['contract_start', 'date', '계약 시작일', '유효한 YYYY-MM-DD만 날짜로 조회합니다. 빈 원문 또는 누락은 null입니다.'],
  ['contract_end', 'date', '계약 종료일', '유효한 YYYY-MM-DD만 날짜로 조회합니다. 빈 원문 또는 누락은 null입니다.'],
  ['contract_end_undecided', 'boolean', '종료 기간 없음 선택값', '저장된 명시적 선택값. 누락은 false가 아닌 null입니다.'],
  ['updated_at_raw', 'string', '사업 수정 시각 원문', '원본 updatedAt 문자열입니다. 사본 수집 시각과 다릅니다.'],
  ['trashed_at_raw', 'string', '휴지통 이동 시각 원문', '휴지통 항목도 포함합니다. 값이 없다고 활성 사업으로 단정하지 않습니다.'],
  ['document_updated_at', 'string', '문서 수정 시각', 'Firestore가 기록한 원본 문서 updateTime입니다.'],
].map(([name, type, label, description]) => ({ name, type, label, description }));

function nullable(value, type) {
  if (value === undefined || value === null) return null;
  if (typeof value !== type || (type === 'string' && value.length > 10000)) fail('project_copy_value_invalid', '사업 원본의 자료형을 확인하지 못했습니다. 이전 분석 사본을 유지합니다.');
  return value;
}
function date(value) {
  if (value === null || value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('project_copy_date_invalid', '계약 날짜 원문이 YYYY-MM-DD 형식과 다릅니다. 날짜를 추측하여 바꾸지 않았습니다.');
  return value;
}
export function buildProjectDataset({ documents, readTime, capturedAt }) {
  if (!Array.isArray(documents) || documents.length > PROJECT_COPY_LIMIT) fail('project_copy_limit', '사업 사본의 1,000건 한도를 넘었습니다. 일부 항목으로 전체 사본을 교체하지 않았습니다.');
  const readAt = utcNanos(readTime), captureAt = utcNanos(capturedAt);
  if (readAt > captureAt + BigInt(ANALYTICS_CLOCK_SKEW_MS) * 1000000n) fail('project_copy_time_invalid', '원본 조회 시각과 사본 수집 시각을 확인해 주세요.');
  const ids = new Set();
  const rows = documents.map(({ id, data, updateTime }) => {
    if (typeof id !== 'string' || !id || id.length > 1500 || ids.has(id) || !data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !PROJECT_COPY_FIELDS.includes(key))) fail('project_copy_document_invalid', '사업 원본의 문서 식별자·허용 항목·수정 시각이 맞지 않습니다.');
    if (utcNanos(updateTime) > readAt) fail('project_copy_time_invalid', '조회 시점보다 나중에 수정된 문서가 포함되어 있습니다.');
    ids.add(id);
    const start = nullable(data.contractStart, 'string'), end = nullable(data.contractEnd, 'string');
    return { document_id: id, project_id: nullable(data.id, 'string'), project_name: nullable(data.name, 'string'), status: nullable(data.status, 'string'), cic: nullable(data.cic, 'string'),
      contract_start_raw: start, contract_end_raw: end, contract_start: date(start), contract_end: date(end), contract_end_undecided: nullable(data.contractEndUndecided, 'boolean'),
      updated_at_raw: nullable(data.updatedAt, 'string'), trashed_at_raw: nullable(data.trashedAt, 'string'), document_updated_at: updateTime };
  }).sort((a, b) => a.document_id < b.document_id ? -1 : a.document_id > b.document_id ? 1 : 0);
  return { datasetId: PROJECT_COPY_DATASET, manifest: { sourceRevision: hash(rows), asOf: readTime, capturedAt, completeness: 'complete', tableQuery: { schemaVersion: 1 },
    label: '사업 등록 원문 사본', grain: '원본 projects 문서 1개당 1행',
    coverage: { description: '조회 시점의 projects 전체 문서. 휴지통 항목 포함. 승인 요청·임시저장·주정산·월결산·입출금 자료는 포함하지 않습니다.', expectedRows: rows.length },
    semantics: '저장된 원문 필드 조회용입니다. 상태 코드로 승인 완료·활성 여부를 추정하지 않습니다. 계약기간은 계약서 날짜이며 매출·입금 기간이 아닙니다. 계약일 원문 빈 문자열과 누락은 보존하고 날짜 열에서만 null로 표시합니다. 금액과 담당자 개인정보는 포함하지 않습니다.' }, schema, rows };
}

export function createProjectCopyProducer({ env, source, db, authorize, now = () => new Date().toISOString() }) {
  const runtime = resolveWorkbenchRuntime(env);
  return { async run(context) {
    if (env.WORKBENCH_PROJECT_COPY_ENABLED !== 'true' || env.WORKBENCH_IMPORT_ENABLED !== 'true' || source.projectId !== env.WORKBENCH_COPY_SOURCE_PROJECT_ID || source.projectId !== runtime.productionProjectId || db.projectId !== runtime.projectId || context.tenantId !== env.WORKBENCH_TENANT_ID) fail('project_copy_disabled', '승인된 원본과 독립 분석 저장소 사이에서만 사업 사본을 연결할 수 있습니다.');
    await authorize(context);
    if (!context.analyticsScope?.datasetIds?.includes(PROJECT_COPY_DATASET)) fail('project_copy_forbidden', '이 계정에 승인된 사업 분석 사본 권한이 필요합니다.');
    const snapshot = await source.collection(`orgs/${context.tenantId}/projects`).select(...PROJECT_COPY_FIELDS).limit(PROJECT_COPY_LIMIT + 1).get();
    const dataset = buildProjectDataset({ documents: snapshot.docs.map(doc => ({ id: doc.id, data: doc.data(), updateTime: timestamp(doc.updateTime) })), readTime: timestamp(snapshot.readTime), capturedAt: now() });
    await authorize(context);
    const result = await createAnalyticsService({ db, now }).importDataset(context, dataset);
    await authorize(context);
    return { ...result, sourceProjectId: source.projectId, sourceReadTime: dataset.manifest.asOf, projectionHash: dataset.manifest.sourceRevision };
  } };
}
