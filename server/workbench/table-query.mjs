import * as z from 'zod/v4';
import { analyticsError, assertIdentifier, sha256 } from './analytics-contract.mjs';

const id = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const scalar = z.union([z.string().max(1000), z.number().finite(), z.boolean()]);
export const TableQueryPolicySchema = z.object({ schemaVersion: z.literal(1) }).strict();
export const TableQueryPlanSchema = z.object({
  kind: z.literal('table'), datasetId: id,
  select: z.array(id).min(1).max(32).optional(), distinct: z.boolean().optional(),
  aggregate: z.object({ op: z.enum(['count_rows', 'count_distinct']), field: id.optional() }).strict().optional(),
  filters: z.array(z.object({ field: id, op: z.enum(['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null']), value: z.union([scalar, z.array(scalar).min(1).max(100)]).optional() }).strict()).max(30).optional(),
  groupBy: z.array(id).max(12).optional(),
  orderBy: z.array(z.object({ field: id, direction: z.enum(['asc', 'desc']) }).strict()).max(8).optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict();
const columnSchema = z.object({ name: id, type: z.enum(['string', 'integer', 'number', 'decimal', 'boolean', 'date', 'timestamp']), scale: z.number().int().min(0).max(18).optional(), label: z.string().max(100).optional(), description: z.string().max(300).optional(), unit: z.string().max(40).optional() }).strict();
const fail = (code, message) => { throw analyticsError(422, code, message); };
const quote = value => `"${assertIdentifier(value)}"`;
const text = value => `'${value.replaceAll("'", "''")}'`;
export function tableFilterOperators(column) {
  return ['string', 'boolean'].includes(column.type)
    ? ['eq', 'ne', 'in', 'not_in', 'is_null', 'is_not_null']
    : ['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null'];
}
export function bindTableQuery(item) {
  if (!TableQueryPolicySchema.safeParse(item?.tableQuery).success || item.semanticDefinitionId !== undefined || item.semanticDefinitionVersion !== undefined) fail('table_query_not_enabled', '승인된 원문 표 사본만 이 방식으로 조회할 수 있습니다. 업무 정의가 있는 자료는 기존 조회 기준을 사용해 주세요.');
  assertIdentifier(item.datasetId);
  const parsed = z.array(columnSchema).min(1).max(64).safeParse(item.schema);
  if (!parsed.success) fail('table_schema_invalid', '사본의 승인된 열 이름과 자료형을 확인해 주세요.');
  const columns = parsed.data;
  if (new Set(columns.map(column => column.name)).size !== columns.length || columns.some(column => column.type === 'decimal' ? column.scale === undefined : column.scale !== undefined)) fail('table_schema_invalid', '열 이름 중복 또는 소수 자릿수 정의를 확인해 주세요.');
  columns.forEach(column => assertIdentifier(column.name));
  return { columns, definitionHash: sha256(JSON.stringify({ kind: 'table', policyVersion: 1, datasetId: item.datasetId, tableQuery: item.tableQuery, columns })) };
}
function literal(value, column) {
  let valid = false;
  if (column.type === 'string') valid = typeof value === 'string' && !/[\u0000-\u001f]/.test(value);
  if (column.type === 'boolean') valid = typeof value === 'boolean';
  if (column.type === 'integer') valid = Number.isSafeInteger(value);
  if (column.type === 'number') valid = typeof value === 'number' && Number.isFinite(value);
  if (column.type === 'decimal') {
    const match = typeof value === 'string' && /^-?(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
    valid = !!match && match[1].length <= 38 - column.scale && (match[2]?.length ?? 0) <= column.scale;
  }
  if (column.type === 'date') valid = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (column.type === 'timestamp') valid = typeof value === 'string' && z.string().datetime().safeParse(value).success && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value);
  if (!valid) fail('table_filter_value_invalid', '비교할 값의 원문 자료형을 확인해 주세요. 누락 값은 누락 여부 조건으로 조회합니다.');
  if (column.type === 'date') return `DATE ${text(value)}`;
  if (column.type === 'timestamp') return `TIMESTAMP ${text(value.slice(0, -1).replace('T', ' '))}`;
  if (column.type === 'decimal') return `CAST(${text(value)} AS DECIMAL(38,${column.scale}))`;
  return typeof value === 'string' ? text(value) : typeof value === 'boolean' ? value ? 'TRUE' : 'FALSE' : String(value);
}
export function compileTableQuery({ plan, catalogItems }) {
  const parsed = TableQueryPlanSchema.safeParse(plan);
  if (!parsed.success) fail('table_plan_invalid', '원문 표의 항목·조건·개수·정렬만 지정해 주세요. SQL·계산식·임의 조인은 사용할 수 없습니다.');
  const input = parsed.data;
  const item = catalogItems.find(value => value.datasetId === input.datasetId);
  if (!item || !/^[a-f0-9]{64}$/.test(item.version)) fail('table_dataset_unavailable', '현재 권한에서 사용할 수 있는 사본과 고정 버전을 확인해 주세요.');
  const { columns, definitionHash } = bindTableQuery(item);
  const column = name => {
    const found = columns.find(value => value.name === name);
    if (!found) fail('table_field_unknown', '승인된 사본에 없는 항목은 조회할 수 없습니다.');
    return found;
  };
  const selected = input.select || [], groups = input.groupBy || [], aggregate = input.aggregate;
  if (Boolean(selected.length) === Boolean(aggregate) || (!aggregate && groups.length) || (aggregate && input.distinct !== undefined)) fail('table_selection_invalid', '개별 행 조회와 개수 집계 중 하나를 선택해 주세요. 묶음별 집계에는 개수 기준이 필요합니다.');
  for (const values of [selected, groups, (input.orderBy || []).map(value => value.field)]) if (new Set(values).size !== values.length) fail('table_plan_duplicate', '항목과 정렬 조건을 중복해서 선택할 수 없습니다.');
  selected.forEach(column); groups.forEach(column);
  const labels = Object.create(null);
  let output = [...selected], expressions = selected.map(quote);
  if (aggregate) {
    if ((aggregate.op === 'count_rows' && aggregate.field !== undefined) || (aggregate.op === 'count_distinct' && !aggregate.field)) fail('table_aggregate_invalid', '사본 행 수는 항목 없이, 중복 제외 개수는 항목 하나를 지정해 주세요.');
    const metrics = aggregate.op === 'count_rows' ? ['row_count'] : ['distinct_count', 'missing_count'];
    if (groups.some(name => metrics.includes(name))) fail('table_output_collision', '묶음 항목과 개수 결과의 이름이 겹칩니다. 다른 묶음 기준을 선택해 주세요.');
    output = [...groups, ...metrics]; expressions = groups.map(quote);
    if (aggregate.op === 'count_rows') { expressions.push('COUNT(*) AS "row_count"'); labels.row_count = '사본 행 수'; }
    else {
      column(aggregate.field);
      expressions.push(`COUNT(DISTINCT ${quote(aggregate.field)}) AS "distinct_count"`, `(COUNT(*) - COUNT(${quote(aggregate.field)})) AS "missing_count"`);
      labels.distinct_count = '중복 제외 원문 값 수(누락 제외)'; labels.missing_count = '값이 누락된 사본 행 수';
    }
  }
  const symbols = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  const clauses = (input.filters || []).map(filter => {
    const field = column(filter.field), name = quote(filter.field);
    if (!tableFilterOperators(field).includes(filter.op)) fail('table_filter_operator_invalid', '이 자료형에 사용할 수 없는 비교 방식입니다.');
    if (['is_null', 'is_not_null'].includes(filter.op)) {
      if (filter.value !== undefined) fail('table_filter_value_invalid', '누락 여부 조건에는 값을 넣지 않습니다.');
      return `${name} IS ${filter.op === 'is_not_null' ? 'NOT ' : ''}NULL`;
    }
    if (['in', 'not_in'].includes(filter.op)) {
      if (!Array.isArray(filter.value)) fail('table_filter_value_invalid', '여러 값과 비교할 때는 값 목록을 지정해 주세요.');
      return `${name} ${filter.op === 'not_in' ? 'NOT ' : ''}IN (${filter.value.map(value => literal(value, field)).join(', ')})`;
    }
    if (filter.value === undefined || Array.isArray(filter.value)) fail('table_filter_value_invalid', '비교할 값 하나를 지정해 주세요.');
    return `${name} ${symbols[filter.op]} ${literal(filter.value, field)}`;
  });
  const order = (input.orderBy || []).map(value => {
    if (!output.includes(value.field)) fail('table_order_invalid', '결과에 포함된 항목만 정렬할 수 있습니다.');
    return `${quote(value.field)} ${value.direction.toUpperCase()} NULLS LAST`;
  });
  const limit = input.limit ?? 100;
  const sql = `SELECT ${input.distinct ? 'DISTINCT ' : ''}${expressions.join(', ')} FROM ${quote(input.datasetId)}${clauses.length ? ` WHERE ${clauses.map(value => `(${value})`).join(' AND ')}` : ''}${groups.length ? ` GROUP BY ${groups.map(quote).join(', ')}` : ''}${order.length ? ` ORDER BY ${order.join(', ')}` : ''} LIMIT ${limit}`;
  if (sql.length > 16000) fail('table_plan_too_large', '조회 조건이 너무 많습니다. 필요한 조건만 남겨 주세요.');
  return {
    sql, kind: 'table', datasetVersions: { [input.datasetId]: item.version },
    appliedPlan: { ...input, filters: input.filters || [], groupBy: groups, limit },
    definitionVersions: { [input.datasetId]: { id: 'stored_table', version: '1', hash: definitionHash } },
    definitionLabel: '승인된 사본의 원문 표 조회',
    columnLabels: Object.fromEntries(output.map(name => [name, labels[name] || column(name).label || name])),
    sourceRefs: [{ datasetId: item.datasetId, sourceRevision: item.sourceRevision }],
    limitations: ['저장된 원문 값과 사본에 포함된 행만 조회했습니다. 원문 상태를 진행·완료·미준수 등 업무 의미로 해석하지 않습니다.', '개수는 사본의 행 또는 중복을 제외한 원문 값 수입니다. 전체 사업·사용자·업무 건수를 뜻하지 않습니다.', '누락은 null, 빈 문자열과 확인된 0은 별도 값입니다. 중복 제외 개수는 null을 제외하며 누락 행 수를 함께 제공합니다.', '날짜는 원문 달력 날짜, 시각은 UTC 값으로 비교합니다. 정산 주차·업무 기간·삭제 제외 규칙을 추정하지 않습니다.'],
  };
}
export function buildTableQueryGuide({ catalogItems }) {
  const datasets = [];
  for (const item of catalogItems) {
    try {
      const { columns, definitionHash } = bindTableQuery(item);
      if (!/^[a-f0-9]{64}$/.test(item.version)) continue;
      datasets.push({ datasetId: item.datasetId, version: item.version, definitionHash, fields: columns.map(column => ({ ...column, operators: tableFilterOperators(column) })) });
    } catch { continue; }
  }
  return { schemaVersion: 1, kind: 'table', selection: 'Exactly one of select or aggregate. groupBy requires aggregate; distinct is only for select.', aggregates: ['count_rows', 'count_distinct'], countDistinct: 'Excludes null; missing_count is returned separately.', meaning: 'Stored values only. Ask for undefined business meaning, derived metrics, joins or deletion rules. No semantic time: filter actual date/timestamp columns with explicit boundaries.', datasets };
}
