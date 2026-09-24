import { analyzeCashflowSheetTemplate, toA1 } from '../bff/cashflow-sheet-template.mjs';
import { classifyCashflowSheetCell, createCashflowPinnedSnapshot } from '../bff/cashflow-sheet-snapshot.mjs';
import { CashflowTemplateMismatchError, LINE_IDS, LINE_ROWS, weekColumnFor, weekOrdinal } from '../bff/cashflow-coordinates.mjs';
import { getMonthFinanceWeeks } from '../../src/app/platform/cashflow-week-core.mjs';
import { ANALYTICS_LIMITS, analyticsError, assertIdentifier, jsonBytes, sha256 } from './analytics-contract.mjs';

export const INFLOW_SCOPES = Object.freeze({
  all_inflows: Object.freeze(LINE_IDS.slice(0, 7)),
  sales: Object.freeze(['SALES_IN']),
  sales_with_vat: Object.freeze(['SALES_IN', 'SALES_VAT_IN']),
});
export const CASHFLOW_INFLOW_SCHEMA = Object.freeze([
  ['project_id', 'string'], ['year_month', 'string'], ['week_no', 'integer'], ['weekly_year', 'integer'],
  ['mode', 'string'], ['receipt_scope', 'string'], ['currency', 'string'],
  ['amount', 'decimal'], ['known_amount', 'decimal'],
  ['expected_cells', 'integer'], ['confirmed_cells', 'integer'], ['missing_cells', 'integer'],
  ['source_status', 'string'], ['spreadsheet_id', 'string'], ['sheet_name', 'string'],
  ['source_cells', 'string'], ['source_revision', 'string'], ['captured_at', 'timestamp'],
  ['week_start', 'date'], ['week_end', 'date'],
].map(([name, type]) => Object.freeze({ name, type, ...(type === 'decimal' ? { scale: 0 } : {}) })));

const fail = (code, message, statusCode = 422) => { throw analyticsError(statusCode, code, message); };
const validInstant = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const keyOf = (mode, weekNo, lineId) => `${mode}:${weekNo}:${lineId}`;
function normalizedCell(rawValue, classified) {
  const confirmed = ['VALUE', 'ZERO'].includes(classified.state);
  const hasFractionalWon = /\.\d*[1-9]/.test(rawValue.normalize('NFKC').replace(/[,\s\u00a0원₩￦]/g, ''));
  const safe = confirmed && Number.isSafeInteger(classified.amount) && !hasFractionalWon;
  return { state: confirmed && !safe ? 'INVALID' : classified.state, amount: safe ? String(classified.amount) : null };
}
export function normalizeInflowCell({ mode, rawValue }) {
  if (!['actual', 'projection'].includes(mode) || typeof rawValue !== 'string') fail('inflow_cell_invalid', '실적·예정 구분과 원본 표시 값을 확인해 주세요.');
  const classified = mode === 'actual' && /^[-–—―]+$/.test(rawValue.normalize('NFKC').trim())
    ? { state: 'ZERO', amount: 0 } : classifyCashflowSheetCell(rawValue);
  if (classified.state === 'VALUE' && classified.amount === 0) classified.state = 'ZERO';
  return normalizedCell(rawValue, classified);
}
function selectedMappings(template, yearMonth, weekNos) {
  return template.mappingCandidates.filter((mapping) => mapping.yearMonth === yearMonth && weekNos.includes(mapping.weekNo) && INFLOW_SCOPES.all_inflows.includes(mapping.lineId));
}
function sourceCellsFor(target, yearMonth, weekNos, capturedAt) {
  if (target.failure === 'UNAVAILABLE' || target.matrix == null) return null;
  const matrix = target.matrix;
  if (!Array.isArray(matrix) || matrix.length > 60 || matrix.some((row) => !Array.isArray(row) || row.length > 72 || row.some((value) => value != null && (typeof value !== 'string' && typeof value !== 'number' || typeof value === 'number' && !Number.isFinite(value) || String(value).length > 1000)))) {
    fail('inflow_matrix_invalid', '원본 사본은 A1:BT60 범위의 표시 값이어야 합니다. 셀 값의 형식과 크기를 확인해 주세요.');
  }
  const template = analyzeCashflowSheetTemplate(matrix);
  if (!template.supported || template.weeklyYear !== target.weeklyYear) throw new CashflowTemplateMismatchError(template.reasons?.map((reason) => reason.message).join(' ') || '원본의 주별 연도가 지정된 연도와 다릅니다.');
  const mappings = selectedMappings(template, yearMonth, weekNos);
  if (mappings.length !== weekNos.length * 2 * INFLOW_SCOPES.all_inflows.length) throw new CashflowTemplateMismatchError('요청한 주차의 입금 좌표를 모두 확인할 수 없습니다.');
  const selectedMatrix = [];
  for (const mapping of mappings) {
    selectedMatrix[mapping.rowIndex] ||= [];
    selectedMatrix[mapping.rowIndex][mapping.columnIndex] = matrix[mapping.rowIndex]?.[mapping.columnIndex];
  }
  // 주차 셀 해석만 재사용한다. 연간·합계·잔액 계산용 매핑은 전달하지 않는다.
  const snapshot = createCashflowPinnedSnapshot({ projectId: target.projectId, spreadsheetId: target.spreadsheetId, selectedSheetName: target.sheetName, mappings, matrix: selectedMatrix, capturedAt });
  const mappingByKey = new Map(mappings.map((mapping) => [keyOf(mapping.mode, mapping.weekNo, mapping.lineId), mapping]));
  const cells = new Map(snapshot.cells.map((cell) => {
    const key = keyOf(cell.mode, cell.weekNo, cell.lineId); const mapping = mappingByKey.get(key);
    const rawValue = String(matrix[mapping.rowIndex]?.[mapping.columnIndex] ?? '');
    return [key, { lineId: cell.lineId, sourceCell: cell.sourceCell, rawValue, ...normalizedCell(rawValue, cell) }];
  }));
  const sourceRevision = `sha256:${sha256(JSON.stringify({ spreadsheetId: target.spreadsheetId, sheetName: target.sheetName, weeklyYear: target.weeklyYear, yearMonth, weekNos, cells: [...cells], parserRevision: snapshot.sourceRevision, policyVersion: template.policyVersion }))}`;
  return { cells, sourceRevision, capturedAt };
}

export function buildCashflowInflowDataset({ datasetId = 'cashflow_inflow', yearMonth, weekNos, capturedAt, targets } = {}) {
  assertIdentifier(datasetId);
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth || '') || !Array.isArray(weekNos) || !weekNos.length || weekNos.length > 5 || weekNos.some((week) => !Number.isInteger(week) || week < 1 || week > 5) || new Set(weekNos).size !== weekNos.length) fail('inflow_period_invalid', '조회할 정산 월과 중복 없는 1~5주차를 지정해 주세요.');
  if (!validInstant(capturedAt)) fail('inflow_capture_invalid', '분석 자료를 모은 시각을 올바른 UTC 시각으로 기록해 주세요.');
  if (!Array.isArray(targets) || !targets.length) fail('inflow_targets_required', '입금 자료를 확인할 대상 사업 목록이 필요합니다. 대상이 없는 상태를 0원으로 만들지 않습니다.');
  const weeks = [...weekNos].sort((a, b) => a - b);
  const expectedRows = targets.length * weeks.length * 2 * Object.keys(INFLOW_SCOPES).length;
  if (expectedRows > ANALYTICS_LIMITS.rows) fail('inflow_targets_too_large', '분석 사본의 행 한도를 넘었습니다. 대상 사업이나 기간을 나누어 주세요.', 413);
  const projectIds = new Set(); const sourceIds = new Set();
  for (const target of targets) {
    if (!target || typeof target !== 'object' || typeof target.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(target.projectId) || typeof target.spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(target.spreadsheetId) || typeof target.sheetName !== 'string' || !target.sheetName.trim() || target.sheetName.length > 100 || /[\u0000-\u001f]/.test(target.sheetName)) fail('inflow_target_invalid', '대상 사업과 원본 시트의 식별 정보를 확인해 주세요.');
    if (target.currency !== 'KRW') fail('inflow_currency_unsupported', '원화 자료만 합산할 수 있습니다. 다른 통화는 환산 기준 없이 섞지 않습니다.');
    if (!Number.isInteger(target.weeklyYear) || weeks.some((week) => weekOrdinal(target.weeklyYear, yearMonth, week) === -1)) throw new CashflowTemplateMismatchError('요청한 기간은 해당 사업의 주별 관리 연도에 포함되지 않습니다.');
    if (target.failure !== undefined && target.failure !== 'UNAVAILABLE') fail('inflow_source_failure_invalid', '원본 조회 실패 여부를 UNAVAILABLE로 명시해 주세요.');
    if (target.capturedAt !== undefined && (!validInstant(target.capturedAt) || Date.parse(target.capturedAt) > Date.parse(capturedAt))) fail('inflow_capture_invalid', '원본 확인 시각은 자료를 모은 시각보다 뒤일 수 없습니다.');
    const sourceId = JSON.stringify([target.spreadsheetId, target.sheetName]);
    if (projectIds.has(target.projectId) || sourceIds.has(sourceId)) fail('inflow_duplicate_source', '같은 사업 또는 같은 원본 시트가 중복 연결되어 있습니다. 중복 합산을 막기 위해 연결 관계를 확인해 주세요.');
    projectIds.add(target.projectId); sourceIds.add(sourceId);
  }
  const calendar = new Map(getMonthFinanceWeeks(yearMonth).map((week) => [week.weekNo, week]));
  const rows = []; const sourceCaptures = [];
  for (const target of [...targets].sort((a, b) => a.projectId.localeCompare(b.projectId))) {
    if (target.failure === 'UNAVAILABLE' && target.matrix != null) fail('inflow_source_conflict', '원본 조회 실패와 원본 값이 동시에 제공되었습니다. 확인된 원본 상태를 하나로 지정해 주세요.');
    const source = sourceCellsFor(target, yearMonth, weeks, target.capturedAt ?? capturedAt);
    if (source) sourceCaptures.push(source.capturedAt);
    for (const weekNo of weeks) for (const mode of ['actual', 'projection']) for (const [receiptScope, lineIds] of Object.entries(INFLOW_SCOPES)) {
      const cells = lineIds.map((lineId) => source?.cells.get(keyOf(mode, weekNo, lineId)) || {
        lineId, sourceCell: toA1(LINE_ROWS[mode][LINE_IDS.indexOf(lineId)], weekColumnFor(target.weeklyYear, yearMonth, weekNo)), rawValue: null, state: 'ERROR', amount: null,
      });
      const confirmed = cells.filter((cell) => ['VALUE', 'ZERO'].includes(cell.state));
      const knownAmount = confirmed.length ? confirmed.reduce((total, cell) => total + BigInt(cell.amount), 0n).toString() : null;
      const week = calendar.get(weekNo);
      const sourceCells = JSON.stringify(cells);
      if (sourceCells.length > 10000) fail('inflow_source_cells_too_large', '원본 셀 근거가 저장 한도를 넘었습니다. 셀 내용을 확인해 주세요.', 413);
      rows.push({ project_id: target.projectId, year_month: yearMonth, week_no: weekNo, weekly_year: target.weeklyYear, mode, receipt_scope: receiptScope, currency: 'KRW',
        amount: confirmed.length === cells.length ? knownAmount : null, known_amount: knownAmount, expected_cells: cells.length, confirmed_cells: confirmed.length, missing_cells: cells.length - confirmed.length,
        source_status: source ? 'OK' : 'UNAVAILABLE', spreadsheet_id: target.spreadsheetId, sheet_name: target.sheetName, source_cells: sourceCells, source_revision: source?.sourceRevision ?? null, captured_at: source?.capturedAt ?? null,
        week_start: week.weekStart, week_end: week.weekEnd });
    }
  }
  const complete = rows.every((row) => row.missing_cells === 0);
  const asOf = sourceCaptures.sort((a, b) => Date.parse(a) - Date.parse(b))[0] || capturedAt;
  const dataset = { datasetId, manifest: {
    sourceRevision: `sha256:${sha256(JSON.stringify({ yearMonth, weeks, rows }))}`, asOf, capturedAt, completeness: sourceCaptures.length ? complete ? 'complete' : 'partial' : 'unknown',
    semanticDefinitionId: 'cashflow_inflow', semanticDefinitionVersion: '1',
    timeCoverage: { yearMonth, weekNos: weeks },
    coverage: { description: `지정된 ${targets.length}개 사업 중 원본 ${sourceCaptures.length}개 확인. 사업비 시트의 정산주 기준이며 실패한 사업도 대상에 포함합니다.`, expectedRows, periodStart: calendar.get(weeks[0]).weekStart, periodEnd: calendar.get(weeks.at(-1)).weekEnd },
    label: '사업비 시트 주차별 입금 사본', grain: '사업 × 정산 월 × 주차 × 실적/예정 × 입금 범위',
    semantics: '전체 입금 항목·매출 항목·매출과 매출부가세 항목을 구분한 사본입니다. 매출과 매출부가세 합계는 외부 고객 수금만을 뜻하지 않습니다. 빈칸·오류는 0원이 아니며 부분합은 확인된 셀만 포함합니다.',
  }, schema: CASHFLOW_INFLOW_SCHEMA.map((column) => ({ ...column })), rows };
  if (jsonBytes(dataset) > ANALYTICS_LIMITS.datasetBytes) fail('inflow_dataset_too_large', '입금 분석 사본의 5MB 한도를 넘었습니다. 대상 사업이나 기간을 나누어 주세요.', 413);
  return dataset;
}
