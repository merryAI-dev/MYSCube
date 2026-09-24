import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { ANALYTICS_ENGINE_VERSION, ANALYTICS_LIMITS, analyticsError, assertIdentifier, jsonBytes, sha256 } from './analytics-contract.mjs';
import { executeAnalyticsQuery } from './analytics-engine.mjs';
import { resolveSemanticCatalog, validateSemanticDataset } from './semantic-catalog.mjs';
import { compileSemanticQuery, SemanticQueryPlanSchema } from './semantic-query.mjs';

const iso = z.string().datetime();
const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const columnInput = z.object({ name, type: z.enum(['string', 'integer', 'number', 'decimal', 'boolean', 'date', 'timestamp']), scale: z.number().int().min(0).max(18).optional(), label: z.string().max(100).optional(), description: z.string().max(300).optional(), unit: z.string().max(40).optional() }).strict();
const datasetInput = z.object({
  datasetId: name,
  manifest: z.object({ sourceRevision: z.string().min(1).max(200), asOf: iso, capturedAt: iso, completeness: z.enum(['complete', 'partial', 'unknown']),
    coverage: z.object({ description: z.string().min(1).max(1000), periodStart: z.string().max(40).optional(), periodEnd: z.string().max(40).optional(), expectedRows: z.number().int().min(0).max(100_000_000).optional() }).strict(),
    semanticDefinitionId: name.optional(), semanticDefinitionVersion: z.string().min(1).max(80).optional(),
    timeCoverage: z.object({ yearMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/), weekNos: z.array(z.number().int().min(1).max(5)).min(1).max(5) }).strict().optional(),
    label: z.string().max(100).optional(), semantics: z.string().max(2000).optional(), grain: z.string().max(300).optional(),
  }).strict(),
  schema: z.array(columnInput).min(1).max(ANALYTICS_LIMITS.columns),
  rows: z.array(z.record(z.string(), z.unknown())).max(ANALYTICS_LIMITS.rows),
}).strict();
const queryInput = z.object({ sql: z.string().trim().min(1).max(ANALYTICS_LIMITS.sqlChars), datasetVersions: z.record(name, digest).optional() }).strict();
const qaInput = z.object({ kind: z.literal('qa'), qa: z.record(z.string(), z.unknown()), columns: z.array(z.object({ name: z.string().max(100), type: z.string().max(100) }).strict()).max(64).default([]), rows: z.array(z.record(z.string(), z.unknown())).max(500).default([]), coverage: z.unknown(), queriedAt: iso }).strict();
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) throw analyticsError(400, 'analytics_input_invalid', '분석 자료의 형식·버전·조회 내용을 확인해 주세요.');
  return result.data;
};
function normalizeDataset(input) {
  const dataset = parse(datasetInput, input);
  assertIdentifier(dataset.datasetId);
  const names = dataset.schema.map((column) => assertIdentifier(column.name));
  if (new Set(names).size !== names.length) throw analyticsError(400, 'analytics_schema_duplicate', '분석 자료의 열 이름이 중복되었습니다.');
  for (const column of dataset.schema) if (column.scale !== undefined && column.type !== 'decimal') throw analyticsError(400, 'analytics_schema_invalid', '소수 자릿수는 decimal 열에만 지정할 수 있습니다.');
  const rows = dataset.rows.map((row, rowIndex) => {
    if (Object.keys(row).length !== names.length || names.some((key) => !Object.hasOwn(row, key))) throw analyticsError(400, 'analytics_row_missing', `${rowIndex + 1}번째 행의 열이 누락되거나 추가되었습니다. 미확인 값은 null, 확인된 0은 0으로 구분해 주세요.`);
    return Object.fromEntries(dataset.schema.map((column) => {
      const value = row[column.name];
      let valid = value === null;
      if (value !== null) {
        if (column.type === 'string') valid = typeof value === 'string' && value.length <= 10000;
        if (column.type === 'integer') valid = Number.isSafeInteger(value);
        if (column.type === 'number') valid = typeof value === 'number' && Number.isFinite(value);
        if (column.type === 'boolean') valid = typeof value === 'boolean';
        if (column.type === 'decimal') {
          const match = typeof value === 'string' && /^-?(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
          valid = !!match && match[1].length <= 38 - (column.scale ?? 0) && (match[2]?.length ?? 0) <= (column.scale ?? 0);
        }
        if (column.type === 'date') valid = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
        if (column.type === 'timestamp') valid = iso.safeParse(value).success && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value);
      }
      if (!valid) throw analyticsError(400, 'analytics_value_invalid', `${rowIndex + 1}번째 행의 ${column.label || column.name} 값이 ${column.type} 형식과 맞지 않습니다. 누락 값은 null로 표시해 주세요.`);
      return [column.name, value];
    }));
  });
  if (dataset.manifest.coverage.expectedRows !== undefined && (dataset.manifest.coverage.expectedRows < rows.length || (dataset.manifest.completeness === 'complete' && dataset.manifest.coverage.expectedRows !== rows.length))) {
    throw analyticsError(400, 'analytics_coverage_invalid', '자료의 전체 행 수와 포함된 행 수가 맞지 않습니다. 일부 자료라면 partial로 표시해 주세요.');
  }
  const normalized = { ...dataset, rows };
  if (jsonBytes(normalized) > ANALYTICS_LIMITS.datasetBytes) throw analyticsError(413, 'analytics_dataset_too_large', '자료 하나의 5MB 한도를 넘었습니다. 분석 기간이나 열 범위를 나누어 주세요.');
  validateSemanticDataset(normalized);
  return normalized;
}
function splitRows(rows) {
  const chunks = [];
  let values = [];
  let bytes = 2;
  for (const row of rows) {
    const next = jsonBytes(row) + 1;
    if (next > 700_000) throw analyticsError(413, 'analytics_row_too_large', '분석 자료의 한 행이 너무 큽니다. 긴 본문을 줄여 주세요.');
    if (values.length && bytes + next > 250_000) { chunks.push(JSON.stringify(values)); values = []; bytes = 2; }
    values.push(row); bytes += next;
  }
  if (values.length) chunks.push(JSON.stringify(values));
  return chunks;
}
const coverageOf = (dataset) => Object.fromEntries(dataset.schema.map((column) => [column.name, {
  missing: dataset.rows.filter((row) => row[column.name] === null).length,
  confirmedZero: dataset.rows.filter((row) => ['integer', 'number'].includes(column.type) ? row[column.name] === 0 : column.type === 'decimal' && typeof row[column.name] === 'string' && /^-?0(?:\.0+)?$/.test(row[column.name])).length,
}]));

export function createAnalyticsService({ db, now = () => new Date().toISOString(), execute = executeAnalyticsQuery }) {
  function scope(context) {
    const grant = context?.analyticsScope;
    if (context?.actorRole !== 'admin' || ![context?.tenantId, context?.actorId].every((value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value))
      || !digest.safeParse(grant?.fingerprint).success || !Array.isArray(grant?.datasetIds) || grant.datasetIds.length > ANALYTICS_LIMITS.datasets || !grant.datasetIds.every((id) => name.safeParse(id).success)) {
      throw analyticsError(403, 'analytics_scope_required', '분석 자료를 볼 수 있는 최신 권한 정보가 필요합니다.');
    }
    const allowed = new Set(grant.datasetIds.map(assertIdentifier));
    const ref = db.doc(`orgs/${context.tenantId}/axr_analytics/${grant.fingerprint}`);
    return { ref, allowed, fingerprint: grant.fingerprint, actorId: context.actorId };
  }
  const metadata = (value) => ({ datasetId: value.datasetId, version: value.version, ...value.manifest, schema: value.schema, rowCount: value.rowCount, columnCoverage: value.columnCoverage, importedAt: value.importedAt, importedBy: value.importedBy, contentHash: value.contentHash });
  const assertOwner = (value, grant) => {
    if (value && (value.actorId !== grant.actorId || value.scopeFingerprint !== grant.fingerprint)) throw analyticsError(403, 'analytics_scope_mismatch', '현재 계정의 분석 범위와 맞지 않는 자료입니다.');
    return value;
  };
  const assertManifest = (value) => {
    if (!name.safeParse(value?.datasetId).success || !digest.safeParse(value?.version).success || !digest.safeParse(value?.contentHash).success
      || !Number.isInteger(value?.chunkCount) || value.chunkCount < 0 || value.chunkCount > 40 || !Array.isArray(value.chunkHashes) || value.chunkHashes.length !== value.chunkCount || !value.chunkHashes.every((item) => digest.safeParse(item).success)
      || !Number.isInteger(value.rowCount) || value.rowCount < 0 || value.rowCount > ANALYTICS_LIMITS.rows || !Array.isArray(value.schema) || value.schema.length < 1 || value.schema.length > ANALYTICS_LIMITS.columns) {
      throw analyticsError(409, 'analytics_copy_corrupt', '분석 사본의 저장 정보를 확인하지 못했습니다. 자료를 다시 복사해 주세요.');
    }
    return value;
  };
  const persistEvidence = async (grant, value) => {
    let payloadJson;
    try { payloadJson = JSON.stringify(value); } catch { throw analyticsError(400, 'analytics_evidence_invalid', '분석 근거를 저장할 수 있는 형식으로 확인해 주세요.'); }
    if (Buffer.byteLength(payloadJson, 'utf8') > 880_000) throw analyticsError(413, 'analytics_evidence_too_large', '분석 근거의 저장 한도를 넘었습니다. 필요한 자료와 열만 선택해 주세요.');
    await grant.ref.collection('evidence').doc(value.evidenceId).create({ payloadJson, contentHash: sha256(payloadJson), actorId: grant.actorId, scopeFingerprint: grant.fingerprint });
    return value;
  };
  async function executeQuery(context, input, { signal, semantic } = {}) {
    const grant = scope(context);
    const request = parse(queryInput, input);
    const selected = request.datasetVersions;
    const ids = selected ? Object.keys(selected).sort() : [...grant.allowed].sort();
    if (!ids.length || ids.some((id) => !grant.allowed.has(id))) throw analyticsError(403, 'analytics_dataset_forbidden', '조회 가능한 분석 자료를 선택해 주세요.');
    const refs = ids.map((id) => {
      const ref = grant.ref.collection('datasets').doc(id);
      return selected ? ref.collection('versions').doc(selected[id]) : ref;
    });
    const records = await db.getAll(...refs);
    const versions = records.filter((record) => record.exists || selected).map((record) => {
      if (!record.exists) throw analyticsError(404, 'analytics_dataset_missing', '분석용 사본이 아직 준비되지 않았거나 지정한 버전이 없습니다.');
      return assertManifest(assertOwner(record.data(), grant));
    });
    if (!versions.length) throw analyticsError(404, 'analytics_dataset_missing', '분석용 사본이 아직 준비되지 않았습니다.');
    let bytes = 0;
    const datasets = [];
    for (const value of versions) {
      if (signal?.aborted) throw analyticsError(499, 'analytics_query_cancelled', '분석 요청이 취소되었습니다.');
      const revision = grant.ref.collection('datasets').doc(value.datasetId).collection('versions').doc(value.version);
      const chunkRefs = Array.from({ length: value.chunkCount }, (_, i) => revision.collection('chunks').doc(String(i).padStart(4, '0')));
      const chunks = chunkRefs.length ? await db.getAll(...chunkRefs) : [];
      const rows = [];
      for (const [index, chunk] of chunks.entries()) {
        const text = chunk.data()?.rowsJson;
        if (typeof text !== 'string' || sha256(text) !== value.chunkHashes[index]) throw analyticsError(409, 'analytics_copy_corrupt', '분석 사본의 무결성을 확인하지 못했습니다. 자료를 다시 복사한 후 조회해 주세요.');
        bytes += Buffer.byteLength(text);
        if (bytes > ANALYTICS_LIMITS.queryBytes - 100000) throw analyticsError(413, 'analytics_query_too_large', '함께 분석할 자료가 6MB 한도를 넘었습니다. 자료 범위를 좁혀 주세요.');
        rows.push(...JSON.parse(text));
      }
      const normalized = normalizeDataset({ datasetId: value.datasetId, manifest: value.manifest, schema: value.schema, rows });
      const expectedCoverage = coverageOf(normalized);
      const coverageMatches = Object.keys(value.columnCoverage || {}).length === normalized.schema.length && normalized.schema.every(({ name: column }) => value.columnCoverage?.[column]?.missing === expectedCoverage[column].missing && value.columnCoverage?.[column]?.confirmedZero === expectedCoverage[column].confirmedZero);
      if (rows.length !== value.rowCount || sha256(JSON.stringify(normalized)) !== value.contentHash || value.contentHash !== value.version || !coverageMatches) throw analyticsError(409, 'analytics_copy_corrupt', '분석 사본의 버전과 내용이 일치하지 않습니다. 자료를 다시 복사해 주세요.');
      datasets.push(normalized);
    }
    const result = await execute({ sql: request.sql, datasets }, { signal });
    const usedVersions = versions.filter((value) => result.usedDatasetIds.includes(value.datasetId));
    const datasetVersions = Object.fromEntries(usedVersions.map((value) => [value.datasetId, value.version]));
    const queryHash = sha256(JSON.stringify({ sql: request.sql, datasetVersions, engineVersion: ANALYTICS_ENGINE_VERSION, scopeFingerprint: grant.fingerprint, ...(semantic ? { semantic } : {}) }));
    const range = (field) => {
      const values = usedVersions.map((value) => value.manifest[field]).sort((a, b) => Date.parse(a) - Date.parse(b));
      return { from: values[0], to: values.at(-1) };
    };
    const sourceTimes = { asOf: range('asOf'), capturedAt: range('capturedAt') };
    const displayRange = (value) => value.from === value.to ? value.from : `${value.from} ~ ${value.to}`;
    const completeness = usedVersions.every((value) => value.manifest.completeness === 'complete') ? 'complete' : usedVersions.some((value) => value.manifest.completeness === 'partial') ? 'partial' : 'unknown';
    const inflow = semantic && Object.values(semantic.definitionVersions).some((value) => value.id === 'cashflow_inflow');
    const inflowCriteria = inflow ? semantic.appliedPlan.filters.map((filter) => {
      const labels = { actual: '실제 입금', projection: '입금 예정', all_inflows: '전체 입금 항목(내부 선입금·지원금·이자 포함)', sales: '시트 매출 입금', sales_with_vat: '시트 매출·매출부가세 입금', KRW: '원화' };
      return `${filter.field === 'project_id' ? '사업 조건 ' : ''}${labels[filter.value] || JSON.stringify(filter.value)}`;
    }).join(' · ') : '';
    const inflowScope = inflow ? `${semantic.appliedPlan.time.yearMonth} ${semantic.appliedPlan.time.weekNo ? `${semantic.appliedPlan.time.weekNo}정산주` : '전체 정산주'} (${semantic.period.start} ~ ${semantic.period.end}) · ${inflowCriteria}. 합계가 비어 있으면 전체 금액을 확인할 수 없습니다. 확인된 항목 부분합과 누락 수를 함께 확인해 주세요. ` : '';
    const evidence = { evidenceId: randomUUID(), kind: 'sql', queryHash, sql: request.sql, normalizedSql: result.normalizedSql, executedSql: result.executedSql, queryParameters: result.queryParameters, engineVersion: ANALYTICS_ENGINE_VERSION, datasetVersions,
      columns: result.columns.map((column) => semantic?.columnLabels[column.name] ? { ...column, label: semantic.columnLabels[column.name] } : column), rows: result.rows, truncated: result.truncated, resultRowLimit: result.resultRowLimit,
      coverage: usedVersions.map(metadata), completeness, sourceTimes,
      ...(semantic ? { semantic: { ...semantic, limitReached: result.rows.length >= semantic.appliedPlan.limit } } : {}),
      metadata: { provenance: '분석용 사본', asOf: displayRange(sourceTimes.asOf), capturedAt: displayRange(sourceTimes.capturedAt), completeness: { complete: '완료', partial: '일부', unknown: '확인 안 됨' }[completeness], query: result.normalizedSql,
        ...(semantic ? { definition: semantic.definitionLabel, limitations: semantic.limitations.join(' '), resultScope: `${inflowScope}${result.rows.length >= semantic.appliedPlan.limit ? `최대 ${semantic.appliedPlan.limit}행까지 표시했습니다. 전체 결과는 더 많을 수 있습니다.` : `${result.rows.length}행을 확인했습니다. 사본에 없는 자료는 포함하지 않습니다.`}` } : {}) },
      capturedAt: sourceTimes.capturedAt.to, queriedAt: now(), actorId: context.actorId, scopeFingerprint: grant.fingerprint };
    if (jsonBytes(evidence) > 900_000) throw analyticsError(413, 'analytics_evidence_too_large', '분석 근거의 저장 한도를 넘었습니다. 필요한 자료와 열만 선택해 주세요.');
    if (signal?.aborted) throw analyticsError(499, 'analytics_query_cancelled', '분석 요청이 취소되었습니다.');
    return persistEvidence(grant, evidence);
  }
  return {
    async importDataset(context, input) {
      const grant = scope(context);
      const dataset = normalizeDataset(input);
      if (!grant.allowed.has(dataset.datasetId)) throw analyticsError(403, 'analytics_dataset_forbidden', '이 자료를 분석 사본에 등록할 권한이 없습니다.');
      if (Date.parse(dataset.manifest.capturedAt) > Date.parse(now()) + 60000) throw analyticsError(400, 'analytics_capture_in_future', '자료를 복사한 시각이 현재보다 뒤에 있습니다. 복사 정보를 확인해 주세요.');
      const contentHash = sha256(JSON.stringify(dataset));
      const version = contentHash;
      const chunks = splitRows(dataset.rows);
      const ref = grant.ref.collection('datasets').doc(dataset.datasetId);
      const revision = ref.collection('versions').doc(version);
      const columnCoverage = coverageOf(dataset);
      const value = { datasetId: dataset.datasetId, version, contentHash, manifest: dataset.manifest, schema: dataset.schema, columnCoverage, rowCount: dataset.rows.length, chunkCount: chunks.length, chunkHashes: chunks.map(sha256), actorId: context.actorId, scopeFingerprint: grant.fingerprint, importedAt: now(), importedBy: context.actorId };
      return db.runTransaction(async (tx) => {
        const [existing, latest] = await tx.getAll(revision, ref);
        assertOwner(existing.data(), grant); assertOwner(latest.data(), grant);
        if (existing.exists) return metadata(existing.data());
        if (latest.exists && Date.parse(latest.data().manifest.capturedAt) > Date.parse(dataset.manifest.capturedAt)) throw analyticsError(409, 'analytics_import_stale', '더 최근에 복사한 자료가 있습니다. 이전 자료로 현재 버전을 바꿀 수 없습니다.');
        if (latest.exists && Date.parse(latest.data().manifest.capturedAt) === Date.parse(dataset.manifest.capturedAt)) throw analyticsError(409, 'analytics_import_conflict', '같은 복사 시각에 내용이 다른 버전이 이미 저장되어 있습니다. 원본 버전을 확인하고 다시 복사해 주세요.');
        tx.create(revision, value);
        chunks.forEach((rowsJson, index) => tx.create(revision.collection('chunks').doc(String(index).padStart(4, '0')), { rowsJson, hash: sha256(rowsJson) }));
        tx.set(ref, value);
        return metadata(value);
      });
    },
    async catalog(context) {
      const grant = scope(context);
      const ids = [...grant.allowed].sort();
      const records = ids.length ? await db.getAll(...ids.map((id) => grant.ref.collection('datasets').doc(id))) : [];
      const items = records.filter((doc) => doc.exists).map((doc) => metadata(assertManifest(assertOwner(doc.data(), grant))));
      return { scopeFingerprint: grant.fingerprint, engineVersion: ANALYTICS_ENGINE_VERSION, items, semantic: resolveSemanticCatalog({ catalogItems: items }), missingDatasetIds: ids.filter((id, i) => !records[i].exists), limits: ANALYTICS_LIMITS };
    },
    async query(context, input, { signal } = {}) {
      return executeQuery(context, input, { signal });
    },
    async queryPlan(context, input, { datasetVersions, signal } = {}) {
      const plan = parse(SemanticQueryPlanSchema, input);
      const grant = scope(context);
      if (!grant.allowed.has(plan.datasetId)) throw analyticsError(403, 'analytics_dataset_forbidden', '이 자료를 조회할 권한이 없습니다.');
      if (datasetVersions && (Object.keys(datasetVersions).length !== 1 || !digest.safeParse(datasetVersions[plan.datasetId]).success)) throw analyticsError(400, 'analytics_input_invalid', '조회할 자료와 고정 버전을 함께 확인해 주세요.');
      const latest = grant.ref.collection('datasets').doc(plan.datasetId);
      const ref = datasetVersions ? latest.collection('versions').doc(datasetVersions[plan.datasetId]) : latest;
      const record = await ref.get();
      if (!record.exists) throw analyticsError(404, 'analytics_dataset_missing', '분석용 사본이 아직 준비되지 않았거나 지정한 버전이 없습니다.');
      const item = metadata(assertManifest(assertOwner(record.data(), grant)));
      const compiled = compileSemanticQuery({ plan, catalogItems: [item] });
      const { sql, datasetVersions: versions, ...semantic } = compiled;
      return executeQuery(context, { sql, datasetVersions: versions }, { signal, semantic });
    },
    async recordEvidence(context, input) {
      const grant = scope(context);
      const value = parse(qaInput, input);
      let nodes = 0;
      const validate = (entry, depth = 0) => {
        if (++nodes > 30000 || depth > 30) throw analyticsError(413, 'analytics_evidence_too_large', '분석 근거의 구조가 너무 큽니다. 필요한 자료만 선택해 주세요.');
        if (entry === null || typeof entry === 'string' || typeof entry === 'boolean' || (typeof entry === 'number' && Number.isFinite(entry))) return;
        if (Array.isArray(entry)) return entry.forEach((child) => validate(child, depth + 1));
        if (entry && Object.getPrototypeOf(entry) === Object.prototype) return Object.values(entry).forEach((child) => validate(child, depth + 1));
        throw analyticsError(400, 'analytics_evidence_invalid', '분석 근거에 저장할 수 없는 값이 있습니다.');
      };
      validate(value);
      return persistEvidence(grant, { ...value, evidenceId: randomUUID(), queryHash: sha256(JSON.stringify(value)), datasetVersions: {}, engineVersion: ANALYTICS_ENGINE_VERSION, completeness: 'unknown',
        metadata: { provenance: '복사된 로그·코드 근거', asOf: '제공된 근거별 시점 확인 필요', capturedAt: '제공된 근거별 복사 시각 확인 필요', completeness: '확인 안 됨' },
        recordedAt: now(), actorId: context.actorId, scopeFingerprint: grant.fingerprint });
    },
    async evidence(context, id) {
      const grant = scope(context);
      const parsedId = parse(z.string().uuid(), id);
      const stored = (await grant.ref.collection('evidence').doc(parsedId).get()).data();
      if (!stored) throw analyticsError(404, 'analytics_evidence_missing', '현재 권한 범위에서 이 분석 근거를 찾을 수 없습니다.');
      assertOwner(stored, grant);
      if (typeof stored.payloadJson !== 'string' || sha256(stored.payloadJson) !== stored.contentHash) throw analyticsError(409, 'analytics_evidence_corrupt', '저장한 분석 근거의 무결성을 확인하지 못했습니다. 다시 조회해 주세요.');
      const value = assertOwner(JSON.parse(stored.payloadJson), grant);
      if (Object.keys(value.datasetVersions).some((datasetId) => !grant.allowed.has(datasetId))) throw analyticsError(403, 'analytics_dataset_forbidden', '이 분석 근거의 자료를 볼 권한이 없습니다.');
      return value;
    },
  };
}
