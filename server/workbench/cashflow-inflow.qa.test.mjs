import { describe, expect, it } from 'vitest';
import policy from '../../policies/cashflow-policy.json' with { type: 'json' };
import { LINE_ROWS, weekColumnFor } from '../bff/cashflow-coordinates.mjs';
import { buildCashflowInflowDataset } from './cashflow-inflow-copy.mjs';
import { validateSemanticDataset } from './semantic-catalog.mjs';
import { compileSemanticQuery } from './semantic-query.mjs';
import { executeAnalyticsQuery } from './analytics-engine.mjs';

function matrix(year = 2026) {
  const cells = Array.from({ length: 60 }, () => Array(72).fill(''));
  const years = [year - 2, year - 1, ...Array.from({ length: 6 }, (_, i) => year + i + 1)];
  for (const [mode, header, weeks] of [['projection', 11, 12], ['actual', 34, 35]]) {
    cells[header][0] = mode === 'actual' ? 'ACTUAL' : 'Projection';
    [2, 3, 64, 65, 66, 67, 68, 69].forEach((column, i) => { cells[header][column] = `${years[i]}년`; });
    cells[header][70] = 'Total';
    for (let i = 0; i < 60; i++) cells[weeks][i + 4] = `${year % 100}-${Math.floor(i / 5) + 1}-${i % 5 + 1}`;
    LINE_ROWS[mode].forEach((row, i) => { cells[row][0] = policy.lineEntries[i][`${mode}Label`] || policy.lineEntries[i].label; });
  }
  for (const [row, label] of [[21, '입금 합계'], [31, '출금 합계'], [32, '잔액 (※ 중요)'], [44, '입금 합계'], [54, '출금 합계'], [55, '잔액']]) cells[row][0] = label;
  return cells;
}
function target(projectId, { actual = ['0','0','0','0','0','0','0'], projection = ['0','0','0','0','0','0','0'], month = '2026-09', weekNo = 1, ...extra } = {}) {
  const cells = matrix(); const column = weekColumnFor(2026, month, weekNo);
  actual.forEach((value, i) => { cells[LINE_ROWS.actual[i]][column] = value; });
  projection.forEach((value, i) => { cells[LINE_ROWS.projection[i]][column] = value; });
  cells[44][column] = '999999'; cells[21][column] = '999999';
  return { projectId, spreadsheetId: `qa-sheet-${projectId}-abcdefghijk`, sheetName: 'cashflow(사용내역 연동)', currency: 'KRW', weeklyYear: 2026, matrix: cells, ...extra };
}
const build = (targets, extra = {}) => buildCashflowInflowDataset({ datasetId: 'cashflow_inflow', yearMonth: '2026-09', weekNos: [1], capturedAt: '2026-09-23T00:00:00.000Z', targets, ...extra });
const filters = (mode = 'actual', scope = 'all_inflows') => [
  { field: 'mode', op: 'eq', value: mode }, { field: 'receipt_scope', op: 'eq', value: scope }, { field: 'currency', op: 'eq', value: 'KRW' },
];
function compile(dataset, overrides = {}) {
  return compileSemanticQuery({ catalogItems: [{ ...dataset.manifest, schema: dataset.schema, datasetId: dataset.datasetId, version: 'a'.repeat(64) }],
    plan: { datasetId: dataset.datasetId, definitionVersion: '1', measures: ['total_amount', 'known_amount_total'], filters: filters(), time: { yearMonth: '2026-09', weekNo: 1 }, ...overrides } });
}
async function query(dataset, overrides) {
  const compiled = compile(dataset, overrides);
  return executeAnalyticsQuery({ sql: compiled.sql, datasets: [dataset] });
}

describe('independent S17 inflow QA: fixed cells → adapter → compiler → native DuckDB', () => {
  it('uses source inflow cells once and keeps actual/projection and sales/VAT scopes separate', async () => {
    const dataset = build([target('a', { actual: ['10','20','30','100','10','5','-2'], projection: ['0','0','0','200','20','0','0'] })]);
    expect((await query(dataset)).rows[0]).toMatchObject({ total_amount: '173', known_amount_total: '173', expected_cell_count: '7', confirmed_cell_count: '7', missing_cell_count: '0' });
    expect((await query(dataset, { filters: filters('actual', 'sales') })).rows[0].total_amount).toBe('100');
    expect((await query(dataset, { filters: filters('actual', 'sales_with_vat') })).rows[0].total_amount).toBe('110');
    expect((await query(dataset, { filters: filters('projection', 'sales_with_vat') })).rows[0].total_amount).toBe('220');
  });
  it('preserves Actual dash zero but Projection dash missing instead of reporting both as confirmed zero', async () => {
    const dataset = build([target('zero', { actual: Array(7).fill('-'), projection: Array(7).fill('-') })]);
    expect((await query(dataset)).rows[0]).toMatchObject({ total_amount: '0', known_amount_total: '0', confirmed_cell_count: '7', missing_cell_count: '0' });
    expect((await query(dataset, { filters: filters('projection') })).rows[0]).toMatchObject({ total_amount: null, known_amount_total: null, confirmed_cell_count: '0', missing_cell_count: '7' });
  });
  it('retains failed target denominator and exposes a partial amount instead of an all-project total', async () => {
    const missing = target('unavailable'); delete missing.matrix; missing.failure = 'UNAVAILABLE';
    const dataset = build([target('ok', { actual: ['0','0','0','100','0','0','0'] }), missing]);
    expect((await query(dataset)).rows[0]).toMatchObject({ total_amount: null, known_amount_total: '100', project_count: '2', observation_count: '2', missing_observation_count: '1', expected_cell_count: '14', confirmed_cell_count: '7', missing_cell_count: '7' });
  });
  it('keeps explicit zero distinct from an empty/error cell and does exact aggregate integer arithmetic', async () => {
    const incomplete = build([target('bad', { actual: ['0','0','0','100','','#REF!','-5'] })]);
    expect((await query(incomplete)).rows[0]).toMatchObject({ total_amount: null, known_amount_total: '95', missing_cell_count: '2' });
    const large = build([target('large-a', { actual: ['0','0','0','9007199254740991','0','0','0'] }), target('large-b', { actual: ['0','0','0','1','0','0','0'] })]);
    expect((await query(large, { filters: filters('actual', 'sales') })).rows[0].total_amount).toBe('9007199254740992');
  });
  it('does not allow filtering away missing coverage or changing required meaning through an IN filter', () => {
    const dataset = build([target('a')]);
    expect(() => compile(dataset, { filters: filters().concat({ field: 'amount', op: 'is_not_null' }) })).toThrow(expect.objectContaining({ code: 'semantic_filter_not_allowed' }));
    expect(() => compile(dataset, { filters: filters().filter((item) => item.field !== 'mode') })).toThrow(expect.objectContaining({ code: 'semantic_clarification_required' }));
    expect(() => compile(dataset, { filters: filters().map((item) => item.field === 'mode' ? { ...item, op: 'in', value: ['actual', 'projection'] } : item) })).toThrow(expect.objectContaining({ code: 'semantic_required_filter_invalid' }));
  });
  it('rejects a direct import whose amount or raw cell evidence was altered', () => {
    const dataset = build([target('a')]);
    expect(() => validateSemanticDataset(dataset)).not.toThrow();
    const wrongAmount = structuredClone(dataset); wrongAmount.rows[0].amount = '999';
    expect(() => validateSemanticDataset(wrongAmount)).toThrow();
    const wrongRaw = structuredClone(dataset);
    const cells = JSON.parse(wrongRaw.rows[0].source_cells); cells[0].rawValue = '100';
    wrongRaw.rows[0].source_cells = JSON.stringify(cells);
    expect(() => validateSemanticDataset(wrongRaw)).toThrow();
  });
  it('rejects cross-scope contradictions even when each row individually adds up', () => {
    const dataset = build([target('a')]);
    const sales = dataset.rows.find((row) => row.mode === 'actual' && row.receipt_scope === 'sales');
    const cells = JSON.parse(sales.source_cells); cells[0] = { ...cells[0], rawValue: '5', state: 'VALUE', amount: '5' };
    sales.source_cells = JSON.stringify(cells); sales.amount = '5'; sales.known_amount = '5';
    expect(() => validateSemanticDataset(dataset)).toThrow();
  });
  it('records automatic coverage measures in the applied plan and rejects monthly coverage guesses', () => {
    const dataset = build([target('a')]);
    expect(compile(dataset, { measures: ['total_amount'] }).appliedPlan.measures).toEqual(expect.arrayContaining(['total_amount', 'project_count', 'missing_cell_count', 'expected_cell_count']));
    expect(() => compile(dataset, { time: { yearMonth: '2026-09', weekScope: 'all' } })).toThrow(expect.objectContaining({ code: 'semantic_period_copy_missing' }));
  });
  it('rejects duplicated sources instead of counting one bank sheet twice', () => {
    const a = target('a'); const b = { ...target('b'), spreadsheetId: a.spreadsheetId };
    expect(() => build([a, b])).toThrow();
  });
  it('rejects unsupported currency and out-of-weekly-year periods rather than annual-cell fallback', () => {
    expect(() => build([target('usd', { currency: 'USD' })])).toThrow();
    expect(() => build([target('old')], { yearMonth: '2025-09' })).toThrow();
  });
  it('retains the full merged fifth finance week instead of falsely labelling it a calendar week', () => {
    const dataset = build([target('boundary', { month: '2026-08', weekNo: 5 })], { yearMonth: '2026-08', weekNos: [5] });
    expect(dataset.rows.length).toBeGreaterThan(0);
    for (const row of dataset.rows) expect(row).toMatchObject({ week_start: '2026-08-24', week_end: '2026-08-31' });
  });
});
