import { describe, expect, it } from 'vitest';
import { buildCashflowInflowDataset, CASHFLOW_INFLOW_SCHEMA, INFLOW_SCOPES, normalizeInflowCell } from './cashflow-inflow-copy.mjs';
import { makeInflowFixtureMatrix } from './cashflow-inflow-fixture.mjs';
import { CashflowTemplateMismatchError, LINE_ROWS, weekColumnFor } from '../bff/cashflow-coordinates.mjs';

const capturedAt = '2026-09-23T01:00:00.000Z';
const target = (overrides = {}) => ({ projectId: 'project_a', spreadsheetId: 'sheet_a', sheetName: '사업비', weeklyYear: 2026, currency: 'KRW', matrix: makeInflowFixtureMatrix(), ...overrides });
const input = (targets, overrides = {}) => ({ yearMonth: '2026-09', weekNos: [1], capturedAt, targets, ...overrides });
const find = (dataset, mode = 'actual', scope = 'all_inflows', project = 'project_a') => dataset.rows.find((row) => row.mode === mode && row.receipt_scope === scope && row.project_id === project);
const column = weekColumnFor(2026, '2026-09', 1);
const fillIn = (matrix, mode, values) => values.forEach((value, index) => { matrix[LINE_ROWS[mode][index]][column] = value; });

describe('offline fixed-coordinate inflow copies', () => {
  it('uses the exact input lines, keeps modes separate and never adds sheet totals', () => {
    const matrix = makeInflowFixtureMatrix();
    fillIn(matrix, 'actual', ['1,000원', '2,000', '3,000', '4,000', '400', '50', '5']);
    fillIn(matrix, 'projection', ['10', '20', '30', '40', '4', '5', '6']);
    matrix[44][column] = '999999'; matrix[21][column] = '888888';
    const dataset = buildCashflowInflowDataset(input([target({ matrix })]));
    expect(dataset.rows).toHaveLength(6);
    expect(dataset.schema).toEqual(CASHFLOW_INFLOW_SCHEMA);
    expect(find(dataset)).toMatchObject({ amount: '10455', known_amount: '10455', expected_cells: 7, confirmed_cells: 7, missing_cells: 0, weekly_year: 2026 });
    expect(find(dataset, 'projection')).toMatchObject({ amount: '115' });
    expect(find(dataset, 'actual', 'sales')).toMatchObject({ amount: '4000', expected_cells: 1 });
    expect(find(dataset, 'actual', 'sales_with_vat')).toMatchObject({ amount: '4400', expected_cells: 2 });
    expect(JSON.parse(find(dataset).source_cells).map((cell) => cell.lineId)).toEqual(INFLOW_SCOPES.all_inflows);
    expect(JSON.parse(find(dataset).source_cells)[0]).toMatchObject({ rawValue: '1,000원', amount: '1000', state: 'VALUE', sourceCell: 'AS38' });
    expect(dataset.manifest.completeness).toBe('complete');
    expect(dataset.manifest.timeCoverage).toEqual({ yearMonth: '2026-09', weekNos: [1] });
  });
  it('preserves Actual dash as confirmed zero, Projection dash as empty, and explicit zero in both', () => {
    const matrix = makeInflowFixtureMatrix();
    fillIn(matrix, 'actual', Array(7).fill('-'));
    fillIn(matrix, 'projection', Array(7).fill('-'));
    const dataset = buildCashflowInflowDataset(input([target({ matrix })]));
    expect(find(dataset)).toMatchObject({ amount: '0', known_amount: '0', confirmed_cells: 7 });
    expect(find(dataset, 'projection')).toMatchObject({ amount: null, known_amount: null, missing_cells: 7 });
    matrix[17][column] = '0'; matrix[40][column] = '0';
    const explicit = buildCashflowInflowDataset(input([target({ matrix })]));
    expect(find(explicit, 'projection', 'sales').amount).toBe('0');
    expect(find(explicit, 'actual', 'sales').amount).toBe('0');
    expect(dataset.manifest.completeness).toBe('partial');
  });
  it('retains missing and malformed cells and reports only the confirmed partial amount', () => {
    const matrix = makeInflowFixtureMatrix();
    fillIn(matrix, 'actual', ['100', '', '#REF!', '금액 확인', '0', '(20)', '5.5']);
    const result = find(buildCashflowInflowDataset(input([target({ matrix })])));
    expect(result).toMatchObject({ amount: null, known_amount: '80', confirmed_cells: 3, missing_cells: 4 });
    expect(JSON.parse(result.source_cells).map((cell) => cell.state)).toEqual(['VALUE', 'EMPTY', 'INVALID', 'INVALID', 'ZERO', 'VALUE', 'INVALID']);
  });
  it('sums integer won beyond Number safety with BigInt but rejects unsafe and rounded fractional source cells', () => {
    const matrix = makeInflowFixtureMatrix(2026, '0');
    fillIn(matrix, 'actual', ['9007199254740991', '9007199254740991', '0', '0', '0', '0', '0']);
    expect(find(buildCashflowInflowDataset(input([target({ matrix })]))).amount).toBe('18014398509481982');
    matrix[37][column] = '9007199254740992'; matrix[38][column] = '9007199254740991.1';
    const result = find(buildCashflowInflowDataset(input([target({ matrix })])));
    expect(result).toMatchObject({ amount: null, known_amount: '0', confirmed_cells: 5 });
    expect(JSON.parse(result.source_cells).slice(0, 2).map((cell) => cell.state)).toEqual(['INVALID', 'INVALID']);
  });
  it('keeps failed sources in the full target denominator with every expected coordinate', () => {
    const dataset = buildCashflowInflowDataset(input([target({ matrix: makeInflowFixtureMatrix(2026, '0') }), target({ projectId: 'project_b', spreadsheetId: 'sheet_b', matrix: undefined, failure: 'UNAVAILABLE' })], { weekNos: [1, 2] }));
    expect(dataset.rows).toHaveLength(24); expect(dataset.manifest.coverage.expectedRows).toBe(24);
    const failed = find(dataset, 'actual', 'all_inflows', 'project_b');
    expect(failed).toMatchObject({ source_status: 'UNAVAILABLE', amount: null, known_amount: null, source_revision: null, captured_at: null, expected_cells: 7, confirmed_cells: 0, missing_cells: 7 });
    expect(JSON.parse(failed.source_cells)[0]).toEqual({ lineId: INFLOW_SCOPES.all_inflows[0], sourceCell: 'AS38', rawValue: null, state: 'ERROR', amount: null });
    expect(dataset.manifest.completeness).toBe('partial');
    const none = buildCashflowInflowDataset(input([target({ matrix: undefined })]));
    expect(none.manifest).toMatchObject({ completeness: 'unknown', asOf: capturedAt });
    expect(none.rows.every((row) => row.source_status === 'UNAVAILABLE')).toBe(true);
  });
  it('refuses out-of-coordinate years before looking at any matrix', () => {
    let reads = 0;
    const outside = target({ weeklyYear: 2025 });
    Object.defineProperty(outside, 'matrix', { get() { reads++; throw new Error('must not read'); } });
    expect(() => buildCashflowInflowDataset(input([outside]))).toThrow(CashflowTemplateMismatchError);
    expect(reads).toBe(0);
  });
  it('refuses shifted labels, missing headers and mismatch of declared and actual weekly year', () => {
    const shifted = makeInflowFixtureMatrix(); shifted[37][0] = '임의 입금 라벨';
    expect(() => buildCashflowInflowDataset(input([target({ matrix: shifted })]))).toThrow(CashflowTemplateMismatchError);
    const missing = makeInflowFixtureMatrix(); missing[12][4] = '';
    expect(() => buildCashflowInflowDataset(input([target({ matrix: missing })]))).toThrow(CashflowTemplateMismatchError);
    expect(() => buildCashflowInflowDataset(input([target({ matrix: makeInflowFixtureMatrix(2025) })]))).toThrow(CashflowTemplateMismatchError);
  });
  it('rejects duplicate business/source, mixed currency, conflicting failure and future capture', () => {
    expect(() => buildCashflowInflowDataset(input([target(), target()]))).toThrow(/중복/);
    expect(() => buildCashflowInflowDataset(input([target(), target({ projectId: 'project_b' })]))).toThrow(/중복/);
    expect(() => buildCashflowInflowDataset(input([target({ currency: 'USD' })]))).toThrow(/통화/);
    expect(() => buildCashflowInflowDataset(input([target({ failure: 'UNAVAILABLE' })]))).toThrow(/동시에/);
    expect(() => buildCashflowInflowDataset(input([target({ capturedAt: '2026-09-23T02:00:00Z' })]))).toThrow(/시각/);
    expect(() => buildCashflowInflowDataset(input([target()], { capturedAt: '2026-02-30T00:00:00Z' }))).toThrow(/시각/);
  });
  it('keeps the oldest real source capture distinct from the collection time and preserves raw-format revisions', () => {
    const a = target({ matrix: makeInflowFixtureMatrix(2026, '0'), capturedAt: '2026-09-23T00:30:00Z' });
    const b = target({ projectId: 'project_b', spreadsheetId: 'sheet_b', matrix: makeInflowFixtureMatrix(2026, '0'), capturedAt: '2026-09-23T00:00:00Z' });
    const first = buildCashflowInflowDataset(input([a, b]));
    expect(first.manifest).toMatchObject({ asOf: b.capturedAt, capturedAt });
    expect(buildCashflowInflowDataset(input([b, a])).manifest.sourceRevision).toBe(first.manifest.sourceRevision);
    a.matrix[40][column] = '0원';
    const updated = buildCashflowInflowDataset(input([a, b]));
    expect(find(updated).amount).toBe(find(first).amount);
    expect(find(updated).source_revision).not.toBe(find(first).source_revision);
  });
  it('uses the existing five-slot calendar including a six-calendar-week month', () => {
    const dataset = buildCashflowInflowDataset(input([target({ matrix: makeInflowFixtureMatrix(2026, '0') })], { yearMonth: '2026-08', weekNos: [5] }));
    expect(dataset.rows[0]).toMatchObject({ week_start: '2026-08-24', week_end: '2026-08-31', year_month: '2026-08', week_no: 5 });
    expect(dataset.manifest.coverage).toMatchObject({ periodStart: '2026-08-24', periodEnd: '2026-08-31' });
  });
  it('rejects empty scope, duplicate/invalid weeks and oversized matrices', () => {
    expect(() => buildCashflowInflowDataset(input([]))).toThrow(/대상/);
    expect(() => buildCashflowInflowDataset(input([target()], { weekNos: [1, 1] }))).toThrow(/주차/);
    expect(() => buildCashflowInflowDataset(input([target()], { weekNos: [6] }))).toThrow(/주차/);
    expect(() => buildCashflowInflowDataset(input([target({ matrix: Array(61).fill([]) })]))).toThrow(/A1:BT60/);
  });
  it('provides the same raw-cell normalization to import validation without rounding fractions', () => {
    for (const mode of ['actual', 'projection']) {
      const matrix = makeInflowFixtureMatrix();
      fillIn(matrix, mode, ['-', '0', '(1,200원)', '#REF!', '9007199254740991.1', '１２３', '']);
      const result = find(buildCashflowInflowDataset(input([target({ matrix })])), mode);
      for (const cell of JSON.parse(result.source_cells)) expect(normalizeInflowCell({ mode, rawValue: cell.rawValue })).toEqual({ state: cell.state, amount: cell.amount });
    }
  });
});
