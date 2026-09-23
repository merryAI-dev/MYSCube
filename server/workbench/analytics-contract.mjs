import { createHash } from 'node:crypto';

export const ANALYTICS_ENGINE_VERSION = 'duckdb-1.5.5-r.5-policy-v1';
export const ANALYTICS_LIMITS = Object.freeze({ datasets: 20, columns: 64, rows: 20000, datasetBytes: 5_000_000, queryBytes: 6_000_000, sqlChars: 16000, resultRows: 500, resultBytes: 500_000, timeoutMs: 3000 });
export const identifier = /^[a-z][a-z0-9_]{0,62}$/;
export const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
export const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
export function analyticsError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code, expose: true });
}
export function assertIdentifier(value) {
  if (typeof value !== 'string' || !identifier.test(value) || /^(duckdb|sqlite|pg_|information_schema)/.test(value)) {
    throw analyticsError(400, 'analytics_identifier_invalid', '자료명과 열 이름은 영문 소문자로 시작하는 63자 이내 이름을 사용해 주세요.');
  }
  return value;
}

const functions = new Set(['sum', 'avg', 'min', 'max', 'count', 'count_star', 'count_if', 'median', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp', 'bool_and', 'bool_or', 'first', 'last', 'arg_min', 'arg_max', 'abs', 'round', 'ceil', 'ceiling', 'floor', 'trunc', 'greatest', 'least', 'nullif', '+', '-', '*', '/', '//', '%', 'lower', 'upper', 'length', 'trim', 'ltrim', 'rtrim', 'substring', 'substr', 'left', 'right', 'contains', 'starts_with', 'ends_with', 'concat', 'concat_ws', '||', 'like_escape', 'not_like_escape', '~~', '!~~', '~~*', '!~~*', 'date_part', 'date_trunc', 'date_diff', 'datediff', 'year', 'month', 'day', 'quarter', 'strftime', 'row_number', 'rank', 'dense_rank', 'lag', 'lead', 'first_value', 'last_value']);
const classes = new Set(['FUNCTION', 'COLUMN_REF', 'CONSTANT', 'STAR', 'COMPARISON', 'CONJUNCTION', 'OPERATOR', 'CASE', 'CAST', 'BETWEEN', 'SUBQUERY', 'WINDOW']);
const operators = new Set(['OPERATOR_IS_NULL', 'OPERATOR_IS_NOT_NULL', 'OPERATOR_COALESCE', 'OPERATOR_NOT', 'COMPARE_IN', 'COMPARE_NOT_IN']);
const castTypes = new Set(['VARCHAR', 'BOOLEAN', 'TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT', 'UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'DATE', 'TIMESTAMP', 'TIMESTAMP_TZ', 'SQLNULL']);
const tables = new Set(['BASE_TABLE', 'JOIN', 'SUBQUERY', 'EMPTY']);

export function validateAnalyticsAst(ast, datasetIds) {
  const invalid = () => { throw analyticsError(400, 'analytics_sql_not_allowed', '복사된 자료를 조회하는 SELECT만 사용할 수 있습니다. 외부 파일·네트워크·설정 변경·임의 함수는 사용할 수 없습니다.'); };
  if (!ast || ast.error || ast.statements?.length !== 1 || ast.statements[0].named_param_map?.length) invalid();
  const permitted = new Set(datasetIds);
  const ctes = new Set();
  const queue = [{ value: ast.statements[0].node, depth: 0 }];
  let count = 0;
  for (let i = 0; i < queue.length; i++) {
    const { value, depth } = queue[i];
    if (!value || typeof value !== 'object') continue;
    if (++count > 10000 || depth > 80) invalid();
    for (const entry of value.cte_map?.map || []) {
      if (permitted.has(entry.key)) invalid();
      ctes.add(entry.key);
    }
    if (value.type?.endsWith?.('_NODE') && !['SELECT_NODE', 'SET_OPERATION_NODE'].includes(value.type)) invalid();
    if (value.class && !classes.has(value.class)) invalid();
    if (['FUNCTION', 'WINDOW'].includes(value.class)) {
      if (!functions.has(value.function_name?.toLowerCase()) || value.schema || value.catalog || value.export_state) invalid();
    }
    if (value.class === 'OPERATOR' && !operators.has(value.type)) invalid();
    if (value.class === 'CAST' && (!castTypes.has(value.cast_type?.id) || value.cast_type?.type_info?.extension_info)) invalid();
    if (value.type === 'BASE_TABLE') {
      if (value.schema_name || value.catalog_name || value.at_clause || (!permitted.has(value.table_name) && !ctes.has(value.table_name))) invalid();
    }
    if (value.type === 'TABLE_FUNCTION' || value.type === 'PIVOT' || value.sample) invalid();
    if (value.from_table && !tables.has(value.from_table.type)) invalid();
    if (value.type === 'JOIN' && (![value.left, value.right].every((table) => tables.has(table?.type)) || !['INNER', 'LEFT', 'RIGHT', 'OUTER', 'SEMI', 'ANTI'].includes(value.join_type))) invalid();
    for (const child of Object.values(value)) if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
  }
  const used = new Set();
  const resolving = new Set();
  let visits = 0;
  function references(value, inherited, depth = 0) {
    if (!value || typeof value !== 'object') return;
    if (++visits > 10000 || depth > 80) invalid();
    let bindings = inherited;
    if (value.cte_map?.map?.length) {
      bindings = new Map(inherited);
      for (const entry of value.cte_map.map) bindings.set(entry.key, { node: entry.value.query.node, scope: bindings });
    }
    if (value.type === 'BASE_TABLE') {
      const binding = bindings.get(value.table_name);
      if (binding) {
        if (resolving.has(binding)) invalid();
        resolving.add(binding);
        references(binding.node, binding.scope, depth + 1);
        resolving.delete(binding);
      } else if (permitted.has(value.table_name)) used.add(value.table_name);
      else invalid();
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'cte_map' && child && typeof child === 'object') references(child, bindings, depth + 1);
    }
  }
  references(ast.statements[0].node, new Map());
  if (!used.size) throw analyticsError(400, 'analytics_sql_without_dataset', '연결된 자료를 적어도 하나 선택해 조회해 주세요.');
  return [...used].sort();
}
