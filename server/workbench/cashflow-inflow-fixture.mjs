import policy from '../../policies/cashflow-policy.json' with { type: 'json' };
import { ANNUAL_COLUMNS_BEFORE, ANNUAL_COLUMNS_AFTER, annualYearsFor, LINE_ROWS } from '../bff/cashflow-coordinates.mjs';

export function makeInflowFixtureMatrix(weeklyYear = 2026, fill = '') {
  const matrix = Array.from({ length: 60 }, () => Array(72).fill(''));
  for (const [mode, headerRow, weekRow] of [['projection', 11, 12], ['actual', 34, 35]]) {
    const years = annualYearsFor(weeklyYear);
    [...ANNUAL_COLUMNS_BEFORE, ...ANNUAL_COLUMNS_AFTER].forEach((column, index) => { matrix[headerRow][column] = `${years[index]}년`; });
    matrix[headerRow][70] = 'Total';
    for (let index = 0; index < 60; index++) matrix[weekRow][index + 4] = `${String(weeklyYear).slice(2)}-${Math.floor(index / 5) + 1}-${index % 5 + 1}`;
    policy.lineEntries.forEach((line, index) => {
      const row = LINE_ROWS[mode][index];
      matrix[row][0] = line[`${mode}Label`] || line.label;
      for (let column = 4; column < 64; column++) matrix[row][column] = fill;
    });
  }
  for (const [row, label] of [[21, '입금 합계'], [31, '출금 합계'], [32, '잔액 (※ 중요)'], [44, '입금 합계'], [54, '출금 합계'], [55, '잔액']]) matrix[row][0] = label;
  return matrix;
}
