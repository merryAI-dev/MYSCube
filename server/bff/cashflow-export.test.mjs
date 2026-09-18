import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { parseWithSchema, cashflowExportSchema, cashflowWeekAmountsSchema } from './schemas.mjs';
import {
  buildCashflowExportSourceFromMirror,
  buildCashflowExportFileName,
  buildCashflowExportWorkbookBuffer,
  expandCashflowYearMonthRange,
} from './cashflow-export.mjs';
import { CashflowTemplateMismatchError } from './cashflow-coordinates.mjs';
import { CASHFLOW_ALL_LINES } from './cashflow-policy.mjs';

function completeMirror(projectId, overrides = {}) {
  const sourceRevision = `sha256:${'a'.repeat(64)}`;
  const cells = [];
  for (const mode of ['projection', 'actual']) {
    for (let weekNo = 1; weekNo <= 5; weekNo += 1) {
      for (const lineId of CASHFLOW_ALL_LINES) {
        cells.push({
          mode,
          yearMonth: '2026-01',
          weekNo,
          lineId,
          direction: lineId.endsWith('_IN') ? 'IN' : 'OUT',
          state: 'EMPTY',
        });
      }
    }
  }
  const replaceCell = (mode, weekNo, lineId, value) => {
    const index = cells.findIndex((cell) => (
      cell.mode === mode && cell.weekNo === weekNo && cell.lineId === lineId
    ));
    cells[index] = { ...cells[index], ...value };
  };
  replaceCell('projection', 1, 'SALES_IN', { state: 'VALUE', amount: 900 });
  replaceCell('actual', 1, 'SALES_IN', { state: 'ZERO', amount: 0 });
  const weeklyCalculationChecks = [];
  for (const mode of ['projection', 'actual']) {
    for (let weekNo = 1; weekNo <= 5; weekNo += 1) {
      const projection = mode === 'projection';
      weeklyCalculationChecks.push({
        mode,
        yearMonth: '2026-01',
        weekNo,
        reported: {
          openingBalance: projection ? 5_000 : 4_000,
          depositTotal: projection && weekNo === 1 ? 900 : 0,
          withdrawalTotal: 0,
          balance: projection ? 5_900 : 4_000,
        },
      });
    }
  }
  const annualMode = (salesAmount, balance) => ({
    source: 'ANNUAL',
    lineAmounts: { SALES_IN: salesAmount },
    lineStates: Object.fromEntries(CASHFLOW_ALL_LINES.map((lineId) => [
      lineId,
      lineId === 'SALES_IN' ? (salesAmount === 0 ? 'ZERO' : 'VALUE') : 'EMPTY',
    ])),
    totalIn: salesAmount,
    totalOut: 0,
    net: balance,
  });
  const annualCells = [];
  const annualDerivedCells = [];
  for (const mode of ['projection', 'actual']) {
    const salesAmount = mode === 'projection' ? 1_200 : 0;
    const balance = mode === 'projection' ? 7_200 : 4_000;
    for (const lineId of CASHFLOW_ALL_LINES) {
      const selected = lineId === 'SALES_IN';
      annualCells.push({
        mode,
        year: 2024,
        periodKind: 'ANNUAL',
        lineId,
        direction: lineId.endsWith('_IN') ? 'IN' : 'OUT',
        state: selected ? (salesAmount === 0 ? 'ZERO' : 'VALUE') : 'EMPTY',
        ...(selected ? { amount: salesAmount } : {}),
      });
    }
    annualDerivedCells.push(
      { mode, year: 2024, periodKind: 'ANNUAL', derivedKind: 'deposit_total', state: salesAmount === 0 ? 'ZERO' : 'VALUE', amount: salesAmount },
      { mode, year: 2024, periodKind: 'ANNUAL', derivedKind: 'withdrawal_total', state: 'ZERO', amount: 0 },
      { mode, year: 2024, periodKind: 'ANNUAL', derivedKind: 'balance', state: 'VALUE', amount: balance },
    );
  }
  // 주별 연도(2026)의 시트 BS열 Total. 주별 값의 합(900)과 일부러 다르게 둔다 - 내보내기는
  // 더해서 만들지 않고 시트에 적힌 값을 옮겨야 한다. 배열 가운데에 두어, 첫/끝 칸을 고치는
  // 2024 연간 검증 테스트가 계속 2024 셀을 겨냥하게 한다.
  const grandTotalCells = [];
  const grandTotalDerivedCells = [];
  for (const mode of ['projection', 'actual']) {
    const projection = mode === 'projection';
    for (const lineId of CASHFLOW_ALL_LINES) {
      const cell = { mode, year: 2026, periodKind: 'GRAND_TOTAL', lineId, direction: lineId.endsWith('_IN') ? 'IN' : 'OUT' };
      if (lineId === 'SALES_IN') Object.assign(cell, projection ? { state: 'VALUE', amount: 1_300 } : { state: 'ZERO', amount: 0 });
      else if (lineId === 'DIRECT_COST_OUT') Object.assign(cell, { state: 'VALUE', amount: projection ? 410 : 20 });
      else cell.state = 'EMPTY';
      grandTotalCells.push(cell);
    }
    grandTotalDerivedCells.push(
      { mode, year: 2026, periodKind: 'GRAND_TOTAL', derivedKind: 'deposit_total', state: projection ? 'VALUE' : 'ZERO', amount: projection ? 1_300 : 0 },
      { mode, year: 2026, periodKind: 'GRAND_TOTAL', derivedKind: 'withdrawal_total', state: 'VALUE', amount: projection ? 410 : 20 },
      projection
        ? { mode, year: 2026, periodKind: 'GRAND_TOTAL', derivedKind: 'balance', state: 'VALUE', amount: 890 }
        : { mode, year: 2026, periodKind: 'GRAND_TOTAL', derivedKind: 'balance', state: 'EMPTY' },
    );
  }
  annualCells.splice(CASHFLOW_ALL_LINES.length, 0, ...grandTotalCells);
  annualDerivedCells.splice(3, 0, ...grandTotalDerivedCells);
  return {
    projectId,
    weeklyYear: 2026,
    status: 'FRESH',
    sourceRevision,
    appliedSourceRevision: sourceRevision,
    cells,
    annualCells,
    annualDerivedCells,
    sheetFacts: {
      weeklyCalculationChecks,
      annualCashflowTotals: [{
        year: 2024,
        projection: annualMode(9_999, 9_999),
        actual: annualMode(9_999, 9_999),
      }],
    },
    ...overrides,
  };
}

function completeWorkbookWeeks(projectId, yearMonths, values = []) {
  const valuesByKey = new Map(values.map((value) => [
    `${value.yearMonth}|${value.weekNo}|${value.mode}|${value.lineId}`,
    value.amount,
  ]));
  const weeks = [];
  for (const yearMonth of yearMonths) {
    for (let weekNo = 1; weekNo <= 5; weekNo += 1) {
      const week = {
        id: `${projectId}-${yearMonth}-w${weekNo}-exact`,
        projectId,
        yearMonth,
        weekNo,
        projection: {},
        actual: {},
        projectionStates: {},
        actualStates: {},
        projectionTotals: { totalIn: 0, totalOut: 0, balance: 0 },
        actualTotals: { totalIn: 0, totalOut: 0, balance: 0 },
      };
      for (const mode of ['projection', 'actual']) {
        for (const lineId of CASHFLOW_ALL_LINES) {
          const key = `${yearMonth}|${weekNo}|${mode}|${lineId}`;
          if (!valuesByKey.has(key)) {
            week[`${mode}States`][lineId] = 'EMPTY';
            continue;
          }
          const amount = valuesByKey.get(key);
          week[mode][lineId] = amount;
          week[`${mode}States`][lineId] = amount === 0 ? 'ZERO' : 'VALUE';
        }
      }
      weeks.push(week);
    }
  }
  return weeks;
}

describe('cashflow export bff helper', () => {
  it('maps the complete applied sheet mirror without collapsing EMPTY and ZERO', () => {
    const { weeks } = buildCashflowExportSourceFromMirror({
      projectId: 'proj-a',
      mirror: completeMirror('proj-a'),
      yearMonths: ['2026-01'],
    });

    expect(weeks).toHaveLength(5);
    expect(weeks[0]).toMatchObject({
      projectId: 'proj-a',
      yearMonth: '2026-01',
      weekNo: 1,
      projection: { SALES_IN: 900 },
      actual: { SALES_IN: 0 },
      projectionStates: { SALES_IN: 'VALUE', TEAM_SUPPORT_IN: 'EMPTY' },
      actualStates: { SALES_IN: 'ZERO', TEAM_SUPPORT_IN: 'EMPTY' },
      projectionTotals: { totalIn: 900, totalOut: 0, balance: 5900 },
      actualTotals: { totalIn: 0, totalOut: 0, balance: 4000 },
    });
  });

  it('carries the sheet BS Total of the weekly year exactly, without summing weeks', () => {
    const { yearTotal } = buildCashflowExportSourceFromMirror({
      projectId: 'proj-a',
      mirror: completeMirror('proj-a'),
      yearMonths: ['2026-01'],
    });

    // 주별 SALES_IN 합은 900이지만 시트 Total은 1,300이다. 시트 값을 그대로 쓴다.
    expect(yearTotal).toMatchObject({
      year: 2026,
      projection: { SALES_IN: 1_300, DIRECT_COST_OUT: 410 },
      actual: { SALES_IN: 0, DIRECT_COST_OUT: 20 },
      projectionStates: { SALES_IN: 'VALUE', TEAM_SUPPORT_IN: 'EMPTY' },
      actualStates: { SALES_IN: 'ZERO', TEAM_SUPPORT_IN: 'EMPTY' },
      projectionTotals: { totalIn: 1_300, totalOut: 410, balance: 890 },
      actualTotals: { totalIn: 0, totalOut: 20, balance: null },
    });
    expect(yearTotal.projection).not.toHaveProperty('TEAM_SUPPORT_IN');
  });

  it('rejects a weekly export when the sheet Total cells are missing, duplicated, or invalid', () => {
    const grandTotalIndex = (cells) => cells.findIndex((cell) => cell.periodKind === 'GRAND_TOTAL');
    const mirrors = [];
    const missing = completeMirror('proj-a');
    missing.annualCells.splice(grandTotalIndex(missing.annualCells), 1);
    mirrors.push(missing);
    const duplicate = completeMirror('proj-a');
    duplicate.annualCells.push({ ...duplicate.annualCells[grandTotalIndex(duplicate.annualCells)] });
    mirrors.push(duplicate);
    const invalidState = completeMirror('proj-a');
    const index = grandTotalIndex(invalidState.annualCells);
    invalidState.annualCells[index] = { ...invalidState.annualCells[index], state: 'ZERO', amount: 5 };
    mirrors.push(invalidState);
    const missingDerived = completeMirror('proj-a');
    missingDerived.annualDerivedCells.splice(grandTotalIndex(missingDerived.annualDerivedCells), 1);
    mirrors.push(missingDerived);

    for (const mirror of mirrors) {
      expect(() => buildCashflowExportSourceFromMirror({ projectId: 'proj-a', mirror, yearMonths: ['2026-01'] }))
        .toThrow(CashflowTemplateMismatchError);
    }
  });

  it('writes the sheet Total as the rightmost annual column for every row', async () => {
    const source = buildCashflowExportSourceFromMirror({
      projectId: 'proj-a',
      mirror: completeMirror('proj-a'),
      yearMonths: ['2026-01'],
    });
    const buffer = await buildCashflowExportWorkbookBuffer({
      variant: 'single-project',
      yearMonths: ['2026-01'],
      projects: [{ id: 'proj-a', name: '경기 사업', ...source }],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const expectations = {
      Projection: { sales: 1_300, direct: 410, totalIn: 1_300, totalOut: 410, balance: 890 },
      Actual: { sales: 0, direct: 20, totalIn: 0, totalOut: 20, balance: null },
    };
    for (const [sheetName, expected] of Object.entries(expectations)) {
      const worksheet = workbook.getWorksheet(sheetName);
      const rowNumber = (label) => worksheet.getSheetValues()
        .findIndex((row) => Array.isArray(row) && row[1] === label);
      const yearColumn = 7;
      expect(worksheet.columnCount).toBe(yearColumn);
      expect(worksheet.getCell(rowNumber('항목'), yearColumn).value).toBe('2026년 연간 합계(1~12월)');
      expect(worksheet.getCell(rowNumber('매출액(입금)'), yearColumn).value).toBe(expected.sales);
      expect(worksheet.getCell(rowNumber('직접사업비'), yearColumn).value).toBe(expected.direct);
      expect(worksheet.getCell(rowNumber('입금 합계'), yearColumn).value).toBe(expected.totalIn);
      expect(worksheet.getCell(rowNumber('출금 합계'), yearColumn).value).toBe(expected.totalOut);
      expect(worksheet.getCell(rowNumber('잔액'), yearColumn).value).toBe(expected.balance);
      // EMPTY 는 빈칸, ZERO 는 0 으로 남는다.
      expect(worksheet.getCell(rowNumber('팀지원금(입금)'), yearColumn).value).toBeNull();
    }
  });

  it('rejects a year Total that belongs to a different year than the exported weeks', async () => {
    const source = buildCashflowExportSourceFromMirror({
      projectId: 'proj-a',
      mirror: completeMirror('proj-a'),
      yearMonths: ['2026-01'],
    });
    await expect(buildCashflowExportWorkbookBuffer({
      variant: 'single-project',
      yearMonths: ['2026-01'],
      projects: [{ id: 'proj-a', name: '경기 사업', ...source, yearTotal: { ...source.yearTotal, year: 2025 } }],
    })).rejects.toThrow(CashflowTemplateMismatchError);
  });

  it('copies declared weekly totals even when they differ from the line amounts', async () => {
    const mirror = completeMirror('proj-a');
    const declared = mirror.sheetFacts.weeklyCalculationChecks.find((check) => (
      check.mode === 'projection' && check.yearMonth === '2026-01' && check.weekNo === 1
    ));
    declared.reported.depositTotal = 901;
    declared.reported.withdrawalTotal = 7;
    const source = buildCashflowExportSourceFromMirror({
      projectId: 'proj-a', mirror, yearMonths: ['2026-01'],
    });
    expect(source.weeks[0].projectionTotals).toEqual({ totalIn: 901, totalOut: 7, balance: 5900 });

    const buffer = await buildCashflowExportWorkbookBuffer({
      variant: 'single-project',
      yearMonths: ['2026-01'],
      projects: [{ id: 'proj-a', name: '선언 합계 사업', ...source }],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet('Projection');
    const rowFor = (label) => worksheet.getSheetValues()
      .findIndex((row) => Array.isArray(row) && row[1] === label);
    expect(worksheet.getCell(rowFor('입금 합계'), 2).value).toBe(901);
    expect(worksheet.getCell(rowFor('출금 합계'), 2).value).toBe(7);
    expect(worksheet.getCell(rowFor('잔액'), 2).value).toBe(5900);
  });

  it.each([
    ['depositTotal', { depositTotal: null, withdrawalTotal: 0, balance: 777 }],
    ['withdrawalTotal', { depositTotal: 901, withdrawalTotal: null, balance: 777 }],
    ['balance', { depositTotal: 901, withdrawalTotal: 0, balance: null }],
    ['all totals', { depositTotal: null, withdrawalTotal: null, balance: null }],
  ])('copies an EMPTY declared %s as a blank without changing the other stored totals', async (_field, reported) => {
    const mirror = completeMirror('proj-a');
    const declared = mirror.sheetFacts.weeklyCalculationChecks.find((check) => (
      check.mode === 'projection' && check.yearMonth === '2026-01' && check.weekNo === 1
    ));
    declared.reported = { ...declared.reported, ...reported };

    const source = buildCashflowExportSourceFromMirror({
      projectId: 'proj-a', mirror, yearMonths: ['2026-01'],
    });
    expect(source.weeks[0].projectionTotals).toEqual({
      totalIn: reported.depositTotal,
      totalOut: reported.withdrawalTotal,
      balance: reported.balance,
    });

    const buffer = await buildCashflowExportWorkbookBuffer({
      variant: 'single-project',
      yearMonths: ['2026-01'],
      projects: [{ id: 'proj-a', name: '빈 합계 사업', ...source }],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet('Projection');
    const rowFor = (label) => worksheet.getSheetValues()
      .findIndex((row) => Array.isArray(row) && row[1] === label);
    expect(worksheet.getCell(rowFor('입금 합계'), 2).value).toBe(reported.depositTotal);
    expect(worksheet.getCell(rowFor('출금 합계'), 2).value).toBe(reported.withdrawalTotal);
    expect(worksheet.getCell(rowFor('잔액'), 2).value).toBe(reported.balance);
  });

  it.each([
    ['missing', 'missing'],
    ['undefined', undefined],
    ['string', '0'],
    ['boolean', false],
    ['decimal', 0.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s declared weekly total instead of coercing it', (_label, invalidValue) => {
    const mirror = completeMirror('proj-a');
    const declared = mirror.sheetFacts.weeklyCalculationChecks[0];
    if (invalidValue === 'missing') delete declared.reported.balance;
    else declared.reported.balance = invalidValue;

    expect(() => buildCashflowExportSourceFromMirror({
      projectId: 'proj-a', mirror, yearMonths: ['2026-01'],
    })).toThrow(CashflowTemplateMismatchError);
  });

  it('maps a whole annual coordinate to one stored annual column without monthly synthesis', () => {
    const { annual, weeks } = buildCashflowExportSourceFromMirror({
      projectId: 'proj-a',
      mirror: completeMirror('proj-a'),
      yearMonths: Array.from({ length: 12 }, (_, index) => `2024-${String(index + 1).padStart(2, '0')}`),
    });

    expect(weeks).toBeUndefined();
    expect(annual).toMatchObject({
      year: 2024,
      projection: { SALES_IN: 1_200 },
      actual: { SALES_IN: 0 },
      projectionStates: { SALES_IN: 'VALUE', TEAM_SUPPORT_IN: 'EMPTY' },
      actualStates: { SALES_IN: 'ZERO', TEAM_SUPPORT_IN: 'EMPTY' },
      projectionTotals: { totalIn: 1_200, totalOut: 0, balance: 7_200 },
      actualTotals: { totalIn: 0, totalOut: 0, balance: 4_000 },
    });
  });

  it('writes an annual source as one exact XLSX column', async () => {
    const yearMonths = Array.from({ length: 12 }, (_, index) => `2024-${String(index + 1).padStart(2, '0')}`);
    const source = buildCashflowExportSourceFromMirror({
      projectId: 'proj-a',
      mirror: completeMirror('proj-a'),
      yearMonths,
    });
    const buffer = await buildCashflowExportWorkbookBuffer({
      variant: 'single-project',
      yearMonths,
      projects: [{ id: 'proj-a', name: '연간 사업', ...source }],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const projection = workbook.getWorksheet('Projection');
    const rows = projection.getSheetValues().filter(Boolean)
      .map((row) => Array.isArray(row) ? row.slice(1) : []);
    expect(rows.find((row) => row[0] === '항목')).toEqual(['항목', '2024']);
    expect(rows.find((row) => row[0] === '매출액(입금)')).toEqual(['매출액(입금)', 1_200]);
    expect(rows.find((row) => row[0] === '입금 합계')).toEqual(['입금 합계', 1_200]);
    expect(rows.find((row) => row[0] === '잔액')).toEqual(['잔액', 7_200]);
    expect(projection.columnCount).toBe(6);
  });

  it('keeps annual derived ZERO, EMPTY, and VALUE independently', async () => {
    const yearMonths = Array.from({ length: 12 }, (_, index) => `2024-${String(index + 1).padStart(2, '0')}`);
    const mirror = completeMirror('proj-a');
    mirror.annualDerivedCells = mirror.annualDerivedCells.map((cell) => {
      if (cell.mode !== 'projection') return cell;
      if (cell.derivedKind === 'deposit_total') return { ...cell, state: 'ZERO', amount: 0 };
      if (cell.derivedKind === 'withdrawal_total') return { ...cell, state: 'EMPTY', amount: undefined };
      return { ...cell, state: 'VALUE', amount: 777 };
    });
    const source = buildCashflowExportSourceFromMirror({ projectId: 'proj-a', mirror, yearMonths });
    const buffer = await buildCashflowExportWorkbookBuffer({
      variant: 'single-project', yearMonths, projects: [{ id: 'proj-a', name: '연간 사업', ...source }],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet('Projection');
    const rowFor = (label) => worksheet.getSheetValues()
      .findIndex((row) => Array.isArray(row) && row[1] === label);
    expect(worksheet.getCell(rowFor('입금 합계'), 2).value).toBe(0);
    expect(worksheet.getCell(rowFor('출금 합계'), 2).value).toBeNull();
    expect(worksheet.getCell(rowFor('잔액'), 2).value).toBe(777);
  });

  it('rejects renderer input that would require a missing-state or ZERO fallback', async () => {
    const exactSource = buildCashflowExportSourceFromMirror({
      projectId: 'proj-a',
      mirror: completeMirror('proj-a'),
      yearMonths: ['2026-01'],
    });
    const missingStateSource = structuredClone(exactSource);
    delete missingStateSource.weeks[0].projectionStates.SALES_IN;
    const invalidZeroSource = structuredClone(exactSource);
    invalidZeroSource.weeks[0].projectionStates.SALES_IN = 'ZERO';
    invalidZeroSource.weeks[0].projection.SALES_IN = 900;

    for (const source of [missingStateSource, invalidZeroSource]) {
      await expect(buildCashflowExportWorkbookBuffer({
        variant: 'single-project',
        yearMonths: ['2026-01'],
        projects: [{ id: 'proj-a', name: '엄격 사업', ...source }],
      })).rejects.toThrow(CashflowTemplateMismatchError);
    }
  });

  it('rejects incomplete, duplicate, or invalid raw annual cells', () => {
    const yearMonths = Array.from({ length: 12 }, (_, index) => `2024-${String(index + 1).padStart(2, '0')}`);
    const mirrors = [];
    const missingLine = completeMirror('proj-a');
    missingLine.annualCells.pop();
    mirrors.push(missingLine);
    const duplicateLine = completeMirror('proj-a');
    duplicateLine.annualCells.push({ ...duplicateLine.annualCells[0] });
    mirrors.push(duplicateLine);
    const invalidDirection = completeMirror('proj-a');
    invalidDirection.annualCells[0] = { ...invalidDirection.annualCells[0], direction: 'OUT' };
    mirrors.push(invalidDirection);
    const invalidDerived = completeMirror('proj-a');
    invalidDerived.annualDerivedCells[0] = { ...invalidDerived.annualDerivedCells[0], state: 'INVALID' };
    mirrors.push(invalidDerived);

    for (const mirror of mirrors) {
      expect(() => buildCashflowExportSourceFromMirror({ projectId: 'proj-a', mirror, yearMonths }))
        .toThrow(CashflowTemplateMismatchError);
    }
  });

  it.each([2027, 2032])('maps annual coordinate boundary %i without inference', (year) => {
    const mirror = completeMirror('proj-a');
    const moveAnnual = (cell) => (cell.periodKind === 'ANNUAL' ? { ...cell, year } : cell);
    mirror.annualCells = mirror.annualCells.map(moveAnnual);
    mirror.annualDerivedCells = mirror.annualDerivedCells.map(moveAnnual);
    const yearMonths = Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`);
    expect(buildCashflowExportSourceFromMirror({ projectId: 'proj-a', mirror, yearMonths }).annual)
      .toMatchObject({ year, projection: { SALES_IN: 1_200 } });
  });

  it('maps the BL boundary at December week 5 from the exact weekly cell', () => {
    const mirror = completeMirror('proj-a');
    mirror.cells = mirror.cells.map((cell) => ({ ...cell, yearMonth: '2026-12' }));
    mirror.sheetFacts.weeklyCalculationChecks = mirror.sheetFacts.weeklyCalculationChecks
      .map((check) => ({ ...check, yearMonth: '2026-12' }));
    const boundary = mirror.cells.find((cell) => (
      cell.mode === 'projection' && cell.weekNo === 5 && cell.lineId === 'SALES_IN'
    ));
    Object.assign(boundary, { state: 'VALUE', amount: 8_765 });

    const { weeks } = buildCashflowExportSourceFromMirror({
      projectId: 'proj-a', mirror, yearMonths: ['2026-12'],
    });
    expect(weeks[4].projection.SALES_IN).toBe(8_765);
  });

  it.each([
    ['stale status', { status: 'STALE' }],
    ['different applied revision', { appliedSourceRevision: `sha256:${'b'.repeat(64)}` }],
    ['missing revision metadata', { sourceRevision: undefined, appliedSourceRevision: undefined }],
  ])('maps the stored mirror for %s without re-validating upstream state', (_label, overrides) => {
    const { weeks } = buildCashflowExportSourceFromMirror({
      projectId: 'proj-a',
      mirror: completeMirror('proj-a', overrides),
      yearMonths: ['2026-01'],
    });

    expect(weeks[0]).toMatchObject({
      projection: { SALES_IN: 900 },
      actual: { SALES_IN: 0 },
      projectionTotals: { totalIn: 900, totalOut: 0, balance: 5_900 },
    });
  });

  it.each([
    ['missing mirror', null],
    ['wrong project', completeMirror('other-project')],
    ['non-canonical weekly year', completeMirror('proj-a', { weeklyYear: '2026' })],
    ['partial annual coordinate', completeMirror('proj-a')],
  ])('fails closed for %s instead of falling back to another store', (_label, mirror) => {
    const yearMonths = _label === 'partial annual coordinate' ? ['2024-03', '2024-04'] : ['2026-01'];
    const operation = () => buildCashflowExportSourceFromMirror({ projectId: 'proj-a', mirror, yearMonths });
    if (_label === 'non-canonical weekly year') {
      expect(operation).toThrow(CashflowTemplateMismatchError);
    } else {
      expect(operation).toThrow(/연결된 시트/);
    }
  });

  it.each([
    [['2024-01', '2024-12']],
    [['2026-12', '2027-01']],
    [Array.from({ length: 12 }, (_, index) => `2033-${String(index + 1).padStart(2, '0')}`)],
  ])('rejects mixed, partial, or out-of-coordinate periods', (yearMonths) => {
    expect(() => buildCashflowExportSourceFromMirror({
      projectId: 'proj-a', mirror: completeMirror('proj-a'), yearMonths,
    })).toThrow(/연결된 시트/);
  });

  it('rejects an incomplete or duplicated mirror matrix instead of filling it with zero', () => {
    const incomplete = completeMirror('proj-a');
    incomplete.cells.pop();
    expect(() => buildCashflowExportSourceFromMirror({
      projectId: 'proj-a', mirror: incomplete, yearMonths: ['2026-01'],
    })).toThrow(CashflowTemplateMismatchError);

    const duplicated = completeMirror('proj-a');
    duplicated.cells.push({ ...duplicated.cells[0] });
    expect(() => buildCashflowExportSourceFromMirror({
      projectId: 'proj-a', mirror: duplicated, yearMonths: ['2026-01'],
    })).toThrow(CashflowTemplateMismatchError);

    const missingDeclaredBalance = completeMirror('proj-a');
    missingDeclaredBalance.sheetFacts.weeklyCalculationChecks.pop();
    expect(() => buildCashflowExportSourceFromMirror({
      projectId: 'proj-a', mirror: missingDeclaredBalance, yearMonths: ['2026-01'],
    })).toThrow(CashflowTemplateMismatchError);
  });

  it('expands year-month range in ascending order', () => {
    expect(expandCashflowYearMonthRange('2026-01', '2026-03')).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(expandCashflowYearMonthRange('2026-03', '2026-01')).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('builds a single project filename with project name', () => {
    expect(buildCashflowExportFileName({
      scope: 'single',
      projectName: '알파 프로젝트',
      yearMonths: ['2026-01', '2026-02'],
      variant: 'single-project',
    })).toContain('알파 프로젝트');
  });

  it('accepts legacy basis export requests during the compatibility window', () => {
    expect(() => parseWithSchema(cashflowExportSchema, {
      scope: 'all',
      basis: '공급가액',
      startYearMonth: '2026-01',
      endYearMonth: '2026-01',
      variant: 'multi-sheet',
    })).not.toThrow();
  });

  it('accepts a bounded list of selected project ids and rejects unsafe ids', () => {
    expect(() => parseWithSchema(cashflowExportSchema, {
      scope: 'all',
      projectIds: ['project-a', 'project-b'],
      startYearMonth: '2026-01',
      endYearMonth: '2026-01',
      variant: 'multi-sheet',
    })).not.toThrow();
    expect(() => parseWithSchema(cashflowExportSchema, {
      scope: 'all',
      projectIds: ['other/project'],
      startYearMonth: '2026-01',
      endYearMonth: '2026-01',
      variant: 'multi-sheet',
    })).toThrow();
  });

  it('accepts canonical accountTypes, department, and sortBy export filters', () => {
    const parsed = parseWithSchema(cashflowExportSchema, {
      scope: 'all',
      projectIds: ['project-a', 'project-b'],
      department: 'CIC1',
      accountTypes: ['DEDICATED', 'OTHER'],
      sortBy: 'DEPARTMENT',
      startYearMonth: '2024-01',
      endYearMonth: '2024-12',
      variant: 'multi-sheet',
    });

    expect(parsed).toMatchObject({
      department: 'CIC1',
      accountTypes: ['DEDICATED', 'OTHER'],
      sortBy: 'DEPARTMENT',
    });
  });

  it('accepts selected scope only with an explicit project list', () => {
    const base = {
      scope: 'selected',
      startYearMonth: '2024-01',
      endYearMonth: '2024-12',
      variant: 'multi-sheet',
    };

    expect(() => parseWithSchema(cashflowExportSchema, {
      ...base,
      projectIds: ['project-a'],
    })).not.toThrow();
    expect(() => parseWithSchema(cashflowExportSchema, base)).toThrow();
  });

  it('keeps legacy accountType including OTHER while rejecting ambiguous or invalid filters', () => {
    const base = {
      scope: 'all',
      startYearMonth: '2024-01',
      endYearMonth: '2024-12',
      variant: 'multi-sheet',
    };

    expect(() => parseWithSchema(cashflowExportSchema, { ...base, accountType: 'OTHER' })).not.toThrow();
    expect(() => parseWithSchema(cashflowExportSchema, {
      ...base,
      accountType: 'DEDICATED',
      accountTypes: ['DEDICATED'],
    })).toThrow();
    expect(() => parseWithSchema(cashflowExportSchema, {
      ...base,
      accountTypes: ['DEDICATED', 'DEDICATED'],
    })).toThrow();
    expect(() => parseWithSchema(cashflowExportSchema, {
      ...base,
      accountTypes: ['UNKNOWN'],
    })).toThrow();
    expect(() => parseWithSchema(cashflowExportSchema, { ...base, sortBy: 'UNKNOWN' })).toThrow();
  });

  it('names selected exports without claiming that every project was included', () => {
    expect(buildCashflowExportFileName({
      scope: 'selected',
      yearMonths: ['2024-01', '2024-12'],
      variant: 'multi-sheet',
    })).toContain('선택사업_개별시트');
  });

  it('rejects raw week 6 for cashflow week writes because storage uses financeWeek 1..5', () => {
    expect(() => parseWithSchema(cashflowWeekAmountsSchema, {
      yearMonth: '2026-08',
      weekNo: 6,
      mode: 'actual',
      amounts: { DIRECT_COST_OUT: 1000 },
    }, 'Invalid cashflow week request')).toThrow(/expected number to be <=5/);
  });

  it('creates a non-empty xlsx buffer', async () => {
    const buffer = await buildCashflowExportWorkbookBuffer({
      variant: 'single-project',
      yearMonths: ['2026-01'],
      projects: [
        {
          id: 'proj-a',
          name: '알파 프로젝트',
          shortName: '알파',
          weeks: completeWorkbookWeeks('proj-a', ['2026-01'], [
            { yearMonth: '2026-01', weekNo: 1, mode: 'projection', lineId: 'SALES_IN', amount: 1000 },
            { yearMonth: '2026-01', weekNo: 1, mode: 'actual', lineId: 'SALES_IN', amount: 900 },
          ]),
        },
      ],
    });

    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
  });

  it('keeps the single-project metadata row aligned with the app workbook spec', async () => {
    const buffer = await buildCashflowExportWorkbookBuffer({
      variant: 'single-project',
      yearMonths: ['2026-01'],
      projects: [
        {
          id: 'proj-a',
          name: '알파 프로젝트',
          shortName: '알파',
          transactions: [],
          weeks: completeWorkbookWeeks('proj-a', ['2026-01']),
        },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet('Projection');
    const rows = worksheet.getSheetValues().filter(Boolean).map((row) => Array.isArray(row) ? row.slice(1) : []);

    expect(rows[0]).toEqual(['사업', '알파 프로젝트', '사업 ID', 'proj-a', '거래 수', 0]);
  });

  it('omits top-level period metadata from combined exports', async () => {
    const buffer = await buildCashflowExportWorkbookBuffer({
      variant: 'combined',
      yearMonths: ['2026-01'],
      projects: [
        {
          id: 'proj-a',
          name: '알파 프로젝트',
          weeks: completeWorkbookWeeks('proj-a', ['2026-01']),
        },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet('전체 사업');
    const rows = worksheet.getSheetValues().filter(Boolean).map((row) => Array.isArray(row) ? row.slice(1) : []);

    expect(rows.some((row) => row[0] === '대상 기간')).toBe(false);
  });

  it('renders annual single-project exports as a horizontal worksheet', async () => {
    const buffer = await buildCashflowExportWorkbookBuffer({
      variant: 'single-project',
      yearMonths: ['2026-01', '2026-02'],
      projects: [
        {
          id: 'proj-wide',
          name: '가로형 프로젝트',
          weeks: completeWorkbookWeeks('proj-wide', ['2026-01', '2026-02'], [
            { yearMonth: '2026-01', weekNo: 1, mode: 'projection', lineId: 'SALES_IN', amount: 100 },
            { yearMonth: '2026-01', weekNo: 1, mode: 'projection', lineId: 'DIRECT_COST_OUT', amount: 25 },
            { yearMonth: '2026-02', weekNo: 1, mode: 'projection', lineId: 'SALES_IN', amount: 200 },
            { yearMonth: '2026-02', weekNo: 1, mode: 'projection', lineId: 'DIRECT_COST_OUT', amount: 50 },
          ]),
        },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet('Projection');
    const rows = worksheet.getSheetValues().filter(Boolean).map((row) => Array.isArray(row) ? row.slice(1) : []);
    const headerRow = rows.find((row) => row[0] === '항목');
    const salesRow = rows.find((row) => row[0] === '매출액(입금)');

    expect(rows.filter((row) => row[0] === '매출액(입금)')).toHaveLength(1);
    // 월 합계 열은 없다. 주차 열만 이어진다.
    expect(headerRow).toEqual([
      '항목',
      '26-1-1', '26-1-2', '26-1-3', '26-1-4', '26-1-5',
      '26-2-1', '26-2-2', '26-2-3', '26-2-4', '26-2-5',
    ]);
    expect(rows.some((row) => row[0] === '기간')).toBe(false);
    expect(rows.some((row) => row[0] === 'Projection')).toBe(false);
    expect(rows.some((row) => row[0] === 'Actual')).toBe(false);
    expect(salesRow).toEqual([
      '매출액(입금)',
      100, undefined, undefined, undefined, undefined,
      200,
    ]);
  });

  it('applies the MYSCube cashflow worksheet format without monthly Total columns', async () => {
    const buffer = await buildCashflowExportWorkbookBuffer({
      variant: 'single-project',
      yearMonths: ['2026-01'],
      projects: [{
        id: 'proj-format',
        name: '서식 프로젝트',
        weeks: completeWorkbookWeeks('proj-format', ['2026-01'], [
          { yearMonth: '2026-01', weekNo: 1, mode: 'projection', lineId: 'SALES_IN', amount: 1000 },
          { yearMonth: '2026-01', weekNo: 1, mode: 'projection', lineId: 'DIRECT_COST_OUT', amount: 250 },
        ]),
      }],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet('Projection');
    const header = worksheet.getRow(2);
    const sales = worksheet.getRow(
      worksheet.getSheetValues().findIndex((row) => Array.isArray(row) && row[1] === '매출액(입금)'),
    );

    expect(header.values.slice(1)).toEqual(['항목', '26-1-1', '26-1-2', '26-1-3', '26-1-4', '26-1-5']);
    expect(sales.values.slice(1)).toEqual(['매출액(입금)', 1000]);
    for (let column = 3; column <= 6; column += 1) {
      expect(sales.getCell(column).value).toBeNull();
    }
    expect(worksheet.columnCount).toBe(6);
    expect(worksheet.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 2 });
    expect(worksheet.getColumn(1).width).toBeGreaterThanOrEqual(22);
    expect(header.getCell(1).font.bold).toBe(true);
    expect(sales.getCell(2).numFmt).toContain('#,##0');
  });

  it('orders workbook sheets by department, project name, and id when requested', async () => {
    const buffer = await buildCashflowExportWorkbookBuffer({
      variant: 'multi-sheet',
      sortBy: 'DEPARTMENT',
      yearMonths: ['2026-01'],
      projects: [
        { id: 'p3', name: '가 사업', shortName: 'A-B-가', department: '센터B', weeks: completeWorkbookWeeks('p3', ['2026-01']) },
        { id: 'p2', name: '나 사업', shortName: 'B-A-나', department: '센터A', weeks: completeWorkbookWeeks('p2', ['2026-01']) },
        { id: 'p1', name: '가 사업', shortName: 'D-A-가-2', department: '센터A', weeks: completeWorkbookWeeks('p1', ['2026-01']) },
        { id: 'p0', name: '가 사업', shortName: 'C-A-가-1', department: '센터A', weeks: completeWorkbookWeeks('p0', ['2026-01']) },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    expect(workbook.worksheets.map(({ name }) => name)).toEqual(['C-A-가-1', 'D-A-가-2', 'B-A-나', 'A-B-가']);
  });

  it('orders combined workbook project sections by department too', async () => {
    const buffer = await buildCashflowExportWorkbookBuffer({
      variant: 'combined',
      sortBy: 'DEPARTMENT',
      scope: 'selected',
      yearMonths: ['2026-01'],
      projects: [
        { id: 'p-b', name: '가 사업', department: '센터B', weeks: completeWorkbookWeeks('p-b', ['2026-01']) },
        { id: 'p-a2', name: '나 사업', department: '센터A', weeks: completeWorkbookWeeks('p-a2', ['2026-01']) },
        { id: 'p-a1', name: '가 사업', department: '센터A', weeks: completeWorkbookWeeks('p-a1', ['2026-01']) },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet('선택 사업');
    const projectNames = worksheet
      .getSheetValues()
      .filter((row) => Array.isArray(row) && row[1] === '사업')
      .map((row) => row[2]);

    expect(projectNames).toEqual(['가 사업', '나 사업', '가 사업']);
  });
});
