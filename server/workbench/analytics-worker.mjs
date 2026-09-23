import { DuckDBInstance, decimalValue, dateValue, timestampValue } from '@duckdb/node-api';
import { ANALYTICS_LIMITS, ANALYTICS_ENGINE_VERSION, validateAnalyticsAst, analyticsError, jsonBytes, assertIdentifier } from './analytics-contract.mjs';

const quote = (name) => `"${name}"`;
const sqlType = (column) => ({ string: 'VARCHAR', integer: 'BIGINT', number: 'DOUBLE', decimal: `DECIMAL(38,${column.scale ?? 0})`, boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMP' })[column.type];
async function main(input) {
  if (typeof input.sql !== 'string' || input.sql.length > ANALYTICS_LIMITS.sqlChars || !Array.isArray(input.datasets) || input.datasets.length > ANALYTICS_LIMITS.datasets) throw analyticsError(400, 'analytics_input_invalid', '분석할 자료와 조회 내용을 확인해 주세요.');
  for (const dataset of input.datasets) {
    assertIdentifier(dataset.datasetId);
    if (!Array.isArray(dataset.schema) || dataset.schema.length > ANALYTICS_LIMITS.columns || !Array.isArray(dataset.rows) || dataset.rows.length > ANALYTICS_LIMITS.rows) throw analyticsError(413, 'analytics_input_too_large', '분석 자료의 행·열 한도를 넘었습니다.');
    dataset.schema.forEach((column) => assertIdentifier(column.name));
  }
  const instance = await DuckDBInstance.create(':memory:', {
    threads: '1', memory_limit: '64MB', max_temp_directory_size: '0B',
    enable_external_access: 'false', autoload_known_extensions: 'false', autoinstall_known_extensions: 'false',
    allow_unsigned_extensions: 'false', allow_community_extensions: 'false', allow_persistent_secrets: 'false',
  });
  const connection = await instance.connect();
  try {
    const parsed = await connection.runAndReadAll('SELECT json_serialize_sql($1::VARCHAR) AS ast', [input.sql]);
    const astJson = parsed.getRowObjectsJson()[0].ast;
    const ast = JSON.parse(astJson);
    const usedDatasetIds = validateAnalyticsAst(ast, input.datasets.map((dataset) => dataset.datasetId));
    for (const dataset of input.datasets.filter((item) => usedDatasetIds.includes(item.datasetId))) {
      await connection.run(`CREATE TABLE ${quote(dataset.datasetId)} (${dataset.schema.map((column) => `${quote(column.name)} ${sqlType(column)}`).join(', ')})`);
      const appender = await connection.createAppender(dataset.datasetId);
      try {
        for (const row of dataset.rows) {
          for (const column of dataset.schema) {
            const value = row[column.name];
            if (value === null) appender.appendNull();
            else if (column.type === 'integer') appender.appendBigInt(BigInt(value));
            else if (column.type === 'number') appender.appendDouble(value);
            else if (column.type === 'boolean') appender.appendBoolean(value);
            else if (column.type === 'decimal') {
              const [integer, fraction = ''] = value.split('.');
              const scaled = BigInt(`${integer}${fraction.padEnd(column.scale ?? 0, '0')}`);
              appender.appendDecimal(decimalValue(scaled, 38, column.scale ?? 0));
            } else if (column.type === 'date') appender.appendDate(dateValue(Math.floor(Date.parse(`${value}T00:00:00Z`) / 86400000)));
            else if (column.type === 'timestamp') appender.appendTimestamp(timestampValue(BigInt(Date.parse(value)) * 1000n));
            else appender.appendVarchar(value);
          }
          appender.endRow();
        }
        appender.flushSync();
      } finally { appender.closeSync(); }
    }
    await connection.run('SET lock_configuration = true');
    const canonicalResult = await connection.runAndReadAll('SELECT json_deserialize_sql($1::JSON) AS sql', [astJson]);
    const canonical = canonicalResult.getRowObjectsJson()[0].sql;
    const executedSql = `SELECT * FROM (${canonical}) AS "__axr_result" LIMIT ${ANALYTICS_LIMITS.resultRows + 1}`;
    const result = await connection.runAndReadAll(executedSql);
    const columns = result.deduplicatedColumnNames().map((name, index) => ({ name, type: String(result.columnType(index)) }));
    if (columns.length > ANALYTICS_LIMITS.columns) throw analyticsError(413, 'analytics_result_columns_exceeded', '조회 결과의 열이 64개를 넘습니다. 필요한 열을 선택해 주세요.');
    const rawRows = result.getRowsJson();
    if (rawRows.some((values) => values.some((value, i) => ['DOUBLE', 'FLOAT'].includes(columns[i].type) && (['Infinity', '-Infinity', 'NaN'].includes(value) || (typeof value === 'number' && !Number.isFinite(value)))))) {
      throw analyticsError(400, 'analytics_non_finite_result', '0으로 나누는 등 계산할 수 없는 값이 있습니다. 분모와 미입력 값을 확인한 뒤 계산 조건을 명시해 주세요.');
    }
    const rows = rawRows.slice(0, ANALYTICS_LIMITS.resultRows).map((values) => Object.fromEntries(columns.map((column, i) => [column.name, values[i]])));
    const response = { engineVersion: ANALYTICS_ENGINE_VERSION, columns, rows, usedDatasetIds, normalizedSql: canonical, executedSql, queryParameters: {}, truncated: rawRows.length > ANALYTICS_LIMITS.resultRows, resultRowLimit: ANALYTICS_LIMITS.resultRows };
    if (jsonBytes(response) > ANALYTICS_LIMITS.resultBytes) throw analyticsError(413, 'analytics_result_too_large', '조회 결과가 500KB를 넘습니다. 필요한 열이나 집계만 선택해 주세요.');
    return response;
  } finally { connection.closeSync(); instance.closeSync(); }
}

let input = '';
let bytes = 0;
try {
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > ANALYTICS_LIMITS.queryBytes) throw new Error('Input exceeds budget');
    input += chunk;
  }
  const result = await main(JSON.parse(input));
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, statusCode: error.expose ? error.statusCode : 400, code: error.expose ? error.code : 'analytics_query_invalid', message: error.expose ? error.message : '조회 문법·열 이름·자료형을 확인해 주세요. 외부 자료는 조회할 수 없습니다.' }));
}
