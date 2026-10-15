import { describe, expect, it } from 'vitest';
import {
  buildAnnualCashflowTotals,
  classifyCashflowSheetCell,
  computeCashflowTargetRevision,
  createCashflowPinnedSnapshot,
  extractCashflowSheetFacts,
} from './cashflow-sheet-snapshot.mjs';
import { CashflowTemplateMismatchError } from './cashflow-coordinates.mjs';

const annualAccidentFixture = (overrides = {}) => ({
  weeklyYear: 2026,
  cells: [{
    yearMonth: '2025-12', weekNo: 4, mode: 'actual', lineId: 'SALES_IN', direction: 'IN',
    state: 'VALUE', amount: 7_582_243,
  }],
  annualCells: [{
    year: 2025, mode: 'actual', lineId: 'SALES_IN', direction: 'IN',
    state: 'VALUE', amount: 317_449_417,
  }],
  annualDerivedCells: [{
    year: 2025, mode: 'actual', derivedKind: 'deposit_total',
    state: 'VALUE', amount: 317_449_417,
  }],
  ...overrides,
});

describe('annual cashflow coordinate contract', () => {
  it('T1 keeps the annual coordinate value when an orphan weekly cell exists', () => {
    const totals = buildAnnualCashflowTotals(annualAccidentFixture());
    expect(totals.find(({ year }) => year === 2025).actual.lineAmounts.SALES_IN).toBe(317_449_417);
  });

  it('T2 uses the declared sheet deposit total', () => {
    const totals = buildAnnualCashflowTotals(annualAccidentFixture());
    expect(totals.find(({ year }) => year === 2025).actual.totalIn).toBe(317_449_417);
  });

  it('T3 returns only the annual years declared by the coordinate contract', () => {
    const totals = buildAnnualCashflowTotals(annualAccidentFixture());
    // 주차 연도(2026)는 연간 열이 없으므로 여기 없다. 그 해의 합계는 Total 열이 든다.
    expect(totals.map(({ year }) => year)).toEqual([2024, 2025, 2027, 2028, 2029, 2030, 2031, 2032]);
  });

  it('T4 preserves an empty declared total as null', () => {
    const fixture = annualAccidentFixture();
    fixture.annualDerivedCells[0] = { ...fixture.annualDerivedCells[0], state: 'EMPTY', amount: undefined };
    const totals = buildAnnualCashflowTotals(fixture);
    expect(totals.find(({ year }) => year === 2025).actual.totalIn).toBeNull();
  });

  it('T6 passes each annual line state through instead of counting it away', () => {
    // 항목별 상태가 살아 있어야 화면이 "빈 칸" 과 "값 있는 칸" 을 구분해 그린다.
    // 세기만 하고 버리면 둘 다 확인 불가가 된다 - 라이브 JLIN 2024·2025 증상.
    const fixture = annualAccidentFixture();
    const actual = buildAnnualCashflowTotals(fixture).find(({ year }) => year === 2025).actual;
    expect(actual.lineStates.SALES_IN).toBe('VALUE');
    expect(actual.lineAmounts.SALES_IN).toBe(317_449_417);
    expect(actual.reconciliation.status).toBe('NOT_APPLICABLE');
  });

  it('T7 does not synthesize an annual entry for the weekly year from weekly cells', () => {
    // 예전에는 60개 주차 셀을 더해 주차 연도의 가짜 연간 항목을 만들었다.
    // 화면은 그 열을 그리지 않고 시트에도 없다.
    const totals = buildAnnualCashflowTotals(annualAccidentFixture());
    expect(totals.find(({ year }) => year === 2026)).toBeUndefined();
  });

  it('T7 excludes cells outside the coordinate years', () => {
    const fixture = annualAccidentFixture({
      cells: [{ yearMonth: '2023-12', weekNo: 4, mode: 'actual', lineId: 'SALES_IN', direction: 'IN', state: 'VALUE', amount: 1 }],
      annualCells: [
        ...annualAccidentFixture().annualCells,
        { year: 2033, mode: 'actual', lineId: 'SALES_IN', direction: 'IN', state: 'VALUE', amount: 2, sourceCell: 'ZZ1' },
      ],
    });
    const totals = buildAnnualCashflowTotals(fixture);
    expect(totals.map(({ year }) => year)).not.toContain(2023);
    expect(totals.map(({ year }) => year)).not.toContain(2033);
  });

  it('T8 rejects a missing weekly year', () => {
    expect(() => buildAnnualCashflowTotals({ cells: [], annualCells: [] }))
      .toThrow(CashflowTemplateMismatchError);
  });

  it('T9 preserves explicit zero and omits empty line amounts', () => {
    const totals = buildAnnualCashflowTotals(annualAccidentFixture({
      annualCells: [
        { year: 2025, mode: 'actual', lineId: 'SALES_IN', direction: 'IN', state: 'ZERO', amount: 0 },
        { year: 2025, mode: 'actual', lineId: 'TEAM_SUPPORT_IN', direction: 'IN', state: 'EMPTY' },
      ],
    }));
    const amounts = totals.find(({ year }) => year === 2025).actual.lineAmounts;
    expect(amounts).toHaveProperty('SALES_IN', 0);
    expect(amounts).not.toHaveProperty('TEAM_SUPPORT_IN');
  });
});

describe('cashflow sheet pinned snapshot', () => {
  it('carries annual line states and amounts through sheet facts without a weekly-year entry', () => {
    // 시트가 SSOT 다. 연간 항목은 셀 상태·금액을 그대로 전달하고, 주차 연도는 항목을 만들지 않는다.
    const facts = extractCashflowSheetFacts({
      weeklyYear: 2026,
      cells: [
        { mode: 'projection', yearMonth: '2026-01', weekNo: 1, lineId: 'SALES_IN', direction: 'IN', state: 'VALUE', amount: 100 },
      ],
      annualCells: [
        { mode: 'projection', year: 2025, lineId: 'SALES_IN', direction: 'IN', state: 'VALUE', amount: 500, periodKind: 'ANNUAL' },
        { mode: 'projection', year: 2025, lineId: 'DIRECT_COST_OUT', direction: 'OUT', state: 'EMPTY', periodKind: 'ANNUAL' },
      ],
    });

    const annual2025 = facts.annualCashflowTotals.find(({ year }) => year === 2025).projection;
    expect(annual2025.source).toBe('ANNUAL');
    expect(annual2025.lineStates).toMatchObject({ SALES_IN: 'VALUE', DIRECT_COST_OUT: 'EMPTY' });
    expect(annual2025.lineAmounts).toEqual({ SALES_IN: 500 });
    expect(facts.annualCashflowTotals.find(({ year }) => year === 2026)).toBeUndefined();
  });

  it.each(['', '  ', '-', '―', '–'])('classifies %j as an empty cell', (rawValue) => {
    expect(classifyCashflowSheetCell(rawValue)).toEqual({ state: 'EMPTY' });
  });

  it('keeps an explicit zero distinct from an empty cell', () => {
    expect(classifyCashflowSheetCell('0')).toEqual({ state: 'VALUE', amount: 0 });
    expect(classifyCashflowSheetCell('₩ 1,234')).toEqual({ state: 'VALUE', amount: 1234 });
    expect(classifyCashflowSheetCell('(1,234)')).toEqual({ state: 'VALUE', amount: -1234 });
  });

  it('pins an annual explicit zero as ZERO with its amount intact', () => {
    const annualMapping = {
      mode: 'projection', year: 2025, lineId: 'SALES_IN', direction: 'IN',
      rowIndex: 0, columnIndex: 0, a1: 'A1', label: '매출액(입금)',
    };
    const zero = createCashflowPinnedSnapshot({
      projectId: 'project-a',
      spreadsheetId: 'sheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      template: { sections: [{ mode: 'projection', weekColumns: [{ year: 2026 }], annualMappings: [annualMapping] }] },
      matrix: [[0]],
    });
    const empty = createCashflowPinnedSnapshot({
      projectId: 'project-a',
      spreadsheetId: 'sheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      template: { sections: [{ mode: 'projection', weekColumns: [{ year: 2026 }], annualMappings: [annualMapping] }] },
      matrix: [['']],
    });

    expect(zero.annualCells).toEqual([expect.objectContaining({ state: 'ZERO', amount: 0 })]);
    expect(empty.annualCells).toEqual([expect.objectContaining({ state: 'EMPTY' })]);
    expect(zero.sourceRevision).not.toBe(empty.sourceRevision);
  });

  it('reads an accounting-format dash as zero in Actual but as empty in Projection', () => {
    const mappingFor = (mode) => ({
      mode, year: 2025, lineId: 'SALES_IN', direction: 'IN',
      rowIndex: 0, columnIndex: 0, a1: 'A1', label: '매출액(입금)',
    });
    const snapshotFor = (mode) => createCashflowPinnedSnapshot({
      projectId: 'project-a',
      spreadsheetId: 'sheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      template: { sections: [{ mode, weekColumns: [{ year: 2026 }], annualMappings: [mappingFor(mode)] }] },
      matrix: [['-']],
    });

    // Actual 의 '-' 는 회계 서식이 0 을 그린 것이다. 확정된 0원(ZERO)으로 읽어 화면에 0 이 뜬다.
    expect(snapshotFor('actual').annualCells)
      .toEqual([expect.objectContaining({ state: 'ZERO', amount: 0 })]);
    // Projection 의 '-' 는 기존 계약 그대로 미기입(EMPTY)이다.
    expect(snapshotFor('projection').annualCells)
      .toEqual([expect.objectContaining({ state: 'EMPTY' })]);
  });

  it('pins annual totals and running balances as sheet evidence', () => {
    const snapshot = createCashflowPinnedSnapshot({
      projectId: 'project-a',
      spreadsheetId: 'sheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      template: {
        sections: [{
          mode: 'projection',
          weekColumns: [{ year: 2026 }],
          annualDerivedMappings: [
            { mode: 'projection', year: 2024, periodKind: 'ANNUAL', derivedKind: 'deposit_total', rowIndex: 0, columnIndex: 2, a1: 'C1' },
            { mode: 'projection', year: 2024, periodKind: 'ANNUAL', derivedKind: 'withdrawal_total', rowIndex: 1, columnIndex: 2, a1: 'C2' },
            { mode: 'projection', year: 2024, periodKind: 'ANNUAL', derivedKind: 'balance', rowIndex: 2, columnIndex: 2, a1: 'C3' },
            { mode: 'projection', year: 2025, periodKind: 'ANNUAL', derivedKind: 'balance', rowIndex: 2, columnIndex: 3, a1: 'D3' },
          ],
        }],
      },
      matrix: [['', '', '100'], ['', '', '30'], ['', '', '70', '170']],
    });

    expect(snapshot.annualDerivedCells).toEqual([
      expect.objectContaining({ year: 2024, derivedKind: 'balance', amount: 70, sourceCell: 'C3' }),
      expect.objectContaining({ year: 2024, derivedKind: 'deposit_total', amount: 100, sourceCell: 'C1' }),
      expect.objectContaining({ year: 2024, derivedKind: 'withdrawal_total', amount: 30, sourceCell: 'C2' }),
      expect.objectContaining({ year: 2025, derivedKind: 'balance', amount: 170, sourceCell: 'D3' }),
    ]);
  });

  it('marks non-numeric sheet contents invalid instead of silently converting them to zero', () => {
    expect(classifyCashflowSheetCell('확인 필요')).toEqual({
      state: 'INVALID',
      rawValue: '확인 필요',
    });
  });

  it('keeps monthly derived totals as verification evidence without replacing sheet values', () => {
    const matrix = Array.from({ length: 30 }, () => Array.from({ length: 8 }, () => ''));
    const weekColumns = Array.from({ length: 5 }, (_, index) => ({
      yearMonth: '2026-07', weekNo: index + 1, columnIndex: index + 3,
    }));
    const section = (mode, rowOffset) => ({
      mode,
      weekColumns,
      annualColumns: [{ year: 2025, columnIndex: 2 }],
      lineRows: [
        { rowIndex: rowOffset, lineId: 'SALES_IN', direction: 'IN' },
        { rowIndex: rowOffset + 1, lineId: 'DIRECT_COST_OUT', direction: 'OUT' },
      ],
      derivedRows: [
        { rowIndex: rowOffset + 2, kind: 'deposit_total' },
        { rowIndex: rowOffset + 3, kind: 'withdrawal_total' },
        { rowIndex: rowOffset + 4, kind: 'balance' },
      ],
    });
    for (const rowOffset of [10, 20]) {
      matrix[rowOffset + 4][2] = '0';
      for (let index = 0; index < 5; index += 1) {
        const column = index + 3;
        matrix[rowOffset][column] = '100';
        matrix[rowOffset + 1][column] = '30';
        matrix[rowOffset + 2][column] = '100';
        matrix[rowOffset + 3][column] = '30';
        matrix[rowOffset + 4][column] = String((index + 1) * 70);
      }
    }
    const template = { sections: [section('projection', 10), section('actual', 20)] };

    const valid = extractCashflowSheetFacts({ template, matrix });
    expect(valid.weeklyCalculationChecks.find((check) => check.mode === 'projection' && check.weekNo === 2))
      .toMatchObject({
        reported: { depositTotal: 100, withdrawalTotal: 30, balance: 140 },
        matches: { depositTotal: true, withdrawalTotal: true, balance: true },
      });

    matrix[12][4] = '101';
    matrix[14][4] = '999';
    const invalid = extractCashflowSheetFacts({ template, matrix });
    expect(invalid.weeklyCalculationChecks.find((check) => check.mode === 'projection' && check.weekNo === 2))
      .toMatchObject({
        reported: { depositTotal: 101, withdrawalTotal: 30, balance: 999 },
        matches: { depositTotal: false, withdrawalTotal: true, balance: false },
      });
  });

  it('pins the Sheet Projection–Actual formula row without recalculating it', () => {
    const matrix = Array.from({ length: 12 }, () => Array.from({ length: 5 }, () => ''));
    matrix[10][3] = '-4,796,728'; // D11: the sheet formula result, not Projection - Actual in application code.
    const facts = extractCashflowSheetFacts({
      matrix,
      template: {
        sections: [{
          mode: 'projection',
          weekColumns: [{ yearMonth: '2026-01', weekNo: 1, columnIndex: 3 }],
        }],
      },
    });

    expect(facts.projectionActualDifferences).toEqual([{
      yearMonth: '2026-01', weekNo: 1, amount: -4_796_728, sourceCell: 'D11',
    }]);
  });

  it('pins normalized cells and keeps source and target revisions separate', () => {
    const mappings = [
      {
        mode: 'actual', yearMonth: '2026-01', weekNo: 1, lineId: 'SALES_IN',
        direction: 'IN', rowIndex: 1, columnIndex: 3, a1: 'D2', label: '매출액(입금)',
      },
      {
        mode: 'projection', yearMonth: '2026-01', weekNo: 1, lineId: 'SALES_IN',
        direction: 'IN', rowIndex: 0, columnIndex: 3, a1: 'D1', label: '매출액(입금)',
      },
    ];
    const first = createCashflowPinnedSnapshot({
      projectId: 'project-a',
      spreadsheetId: 'sheet-a',
      spreadsheetTitle: '2026 사업비',
      selectedSheetName: 'cashflow(사용내역 연동)',
      mappings,
      matrix: [[], ['', '', '', '1,000']],
      targetSnapshot: { weeks: [{ yearMonth: '2026-01', weekNo: 1, projection: { SALES_IN: 10 } }] },
      capturedAt: '2026-07-13T01:00:00.000Z',
      capturedBy: { uid: 'user-a' },
    });
    const second = createCashflowPinnedSnapshot({
      projectId: 'project-a',
      spreadsheetId: 'sheet-a',
      spreadsheetTitle: '2026 사업비',
      selectedSheetName: 'cashflow(사용내역 연동)',
      mappings: [...mappings].reverse(),
      matrix: [[], ['', '', '', '1000']],
      targetSnapshot: { weeks: [{ yearMonth: '2026-01', weekNo: 1, projection: { SALES_IN: 20 } }] },
      capturedAt: '2026-07-13T02:00:00.000Z',
      capturedBy: { uid: 'user-b' },
    });

    expect(first.cells).toEqual([
      expect.objectContaining({ mode: 'actual', state: 'VALUE', amount: 1000 }),
      expect.objectContaining({ mode: 'projection', state: 'EMPTY' }),
    ]);
    expect(first.sourceRevision).toBe(second.sourceRevision);
    expect(first.targetRevisionAtFetch).not.toBe(second.targetRevisionAtFetch);
    expect(first.summary).toEqual({ cellCount: 2, valueCount: 1, emptyCount: 1, invalidCount: 0 });
  });

  it('pins business metadata, the five-week deposit schedule, and BS/BT controls', () => {
    const matrix = Array.from({ length: 55 }, () => Array.from({ length: 72 }, () => ''));
    matrix[0][1] = '최종 업데이트 : 2026.07.01 최종작성자: 보람';
    matrix[1][1] = 'Type1. 세금계산서발행+공급가액기준';
    matrix[2][1] = '전용계좌사업';
    matrix[3][1] = '정산진행';
    for (let weekIndex = 0; weekIndex < 5; weekIndex += 1) {
      const columnIndex = 3 + weekIndex;
      matrix[6][columnIndex] = `2026-06-${String(weekIndex + 1).padStart(2, '0')}`;
      matrix[7][columnIndex] = `2026.06.${String(weekIndex + 6).padStart(2, '0')}`;
      matrix[8][columnIndex] = String((weekIndex + 1) * 1000);
      matrix[13][columnIndex] = String((weekIndex + 1) * 10);
      matrix[36][columnIndex] = String((weekIndex + 1) * 5);
    }
    matrix[8][70] = '15,000';
    matrix[8][71] = '85,000';
    matrix[13][70] = '150';
    matrix[36][70] = '75';

    const weekColumns = Array.from({ length: 5 }, (_, weekIndex) => ({
      yearMonth: '2026-06', weekNo: weekIndex + 1, columnIndex: 3 + weekIndex,
    }));
    const template = {
      sections: [
        {
          mode: 'projection', weekColumns,
          lineRows: [{ rowIndex: 13, lineId: 'SALES_IN' }], derivedRows: [],
        },
        {
          mode: 'actual', weekColumns,
          lineRows: [{ rowIndex: 36, lineId: 'SALES_IN' }], derivedRows: [],
        },
      ],
    };

    expect(extractCashflowSheetFacts({ template, matrix })).toEqual({
      metadata: {
        lastUpdateText: { sourceCell: 'B1', value: '최종 업데이트 : 2026.07.01 최종작성자: 보람' },
        businessType: { sourceCell: 'B2', value: 'Type1. 세금계산서발행+공급가액기준' },
        accountType: { sourceCell: 'B3', value: '전용계좌사업' },
        settlementStatus: { sourceCell: 'B4', value: '정산진행' },
      },
      depositScheduleRows: Array.from({ length: 5 }, (_, weekIndex) => ({
        yearMonth: '2026-06',
        weekNo: weekIndex + 1,
        taxInvoiceIssuedDate: `2026-06-${String(weekIndex + 1).padStart(2, '0')}`,
        expectedDepositDate: `2026-06-${String(weekIndex + 6).padStart(2, '0')}`,
        expectedDepositAmount: (weekIndex + 1) * 1000,
        sourceCells: {
          taxInvoiceIssuedDate: `${String.fromCharCode(68 + weekIndex)}7`,
          expectedDepositDate: `${String.fromCharCode(68 + weekIndex)}8`,
          expectedDepositAmount: `${String.fromCharCode(68 + weekIndex)}9`,
        },
      })),
      annualFinancialTotals: [{
        year: 2026,
        contractAmount: 15000,
        salesVatAmount: 0,
        totalRevenueAmount: 0,
        supportAmount: 0,
      }],
      annualCashflowTotals: [],
      cashflowGrandTotals: {
        projection: { lineAmounts: {}, lineStates: {}, totalIn: 0, totalOut: 0, net: 0 },
        actual: { lineAmounts: {}, lineStates: {}, totalIn: 0, totalOut: 0, net: 0 },
      },
      controlTotals: {
        deposit: { sourceCell: 'BS9', value: 15000, computed: 15000, matches: true },
        unpaid: { sourceCell: 'BT9', value: 85000 },
        projection: [{
          kind: 'line', lineId: 'SALES_IN', sourceCell: 'BS14', value: 150, computed: 150, matches: true,
          annualValues: [{ year: 2026, value: 150 }],
        }],
        actual: [{
          kind: 'line', lineId: 'SALES_IN', sourceCell: 'BS37', value: 75, computed: 75, matches: true,
          annualValues: [{ year: 2026, value: 75 }],
        }],
      },
      issues: [],
    });
  });

  it('treats future blank week cells as zero for BS sums without inventing deposit values', () => {
    const matrix = Array.from({ length: 55 }, () => Array.from({ length: 72 }, () => ''));
    const weekColumns = Array.from({ length: 60 }, (_, index) => ({
      yearMonth: `2026-${String(Math.floor(index / 5) + 1).padStart(2, '0')}`,
      weekNo: (index % 5) + 1,
      columnIndex: 3 + index,
    }));
    matrix[8][3] = '1000';
    matrix[8][70] = '1000';
    matrix[13][3] = '100';
    matrix[13][70] = '100';
    const facts = extractCashflowSheetFacts({
      matrix,
      template: {
        sections: [
          { mode: 'projection', weekColumns, lineRows: [{ rowIndex: 13, lineId: 'SALES_IN' }], derivedRows: [] },
          { mode: 'actual', weekColumns, lineRows: [], derivedRows: [] },
        ],
      },
    });

    expect(facts.depositScheduleRows[1].expectedDepositAmount).toBeNull();
    expect(facts.controlTotals.deposit).toMatchObject({ computed: 1000, value: 1000, matches: true });
    expect(facts.controlTotals.projection[0]).toMatchObject({ computed: 100, value: 100, matches: true });
  });

  it('uses the official fixed BS/BT control columns', () => {
    const matrix = Array.from({ length: 55 }, () => Array.from({ length: 72 }, () => ''));
    const weekColumns = [
      { yearMonth: '2027-01', weekNo: 4, columnIndex: 63 },
      { yearMonth: '2027-01', weekNo: 5, columnIndex: 62 },
    ];
    matrix[8][63] = '1000';
    matrix[8][62] = '2000';
    matrix[8][70] = '3000';
    matrix[13][63] = '100';
    matrix[13][62] = '200';
    matrix[13][70] = '300';

    const facts = extractCashflowSheetFacts({
      matrix,
      template: {
        sections: [
          { mode: 'projection', headerRowIndex: 0, weekColumns, lineRows: [{ rowIndex: 13, lineId: 'SALES_IN' }], derivedRows: [] },
          { mode: 'actual', headerRowIndex: 0, weekColumns, lineRows: [], derivedRows: [] },
        ],
      },
    });

    expect(facts.depositScheduleRows).toHaveLength(2);
    expect(facts.controlTotals.deposit).toMatchObject({ sourceCell: 'BS9', value: 3000, computed: 3000, matches: true });
    expect(facts.controlTotals.projection[0]).toMatchObject({ sourceCell: 'BS14', value: 300, computed: 300, matches: true });
  });

  it('checks the Total balance as deposits minus withdrawals, not the sum of weekly balances', () => {
    // 라이브 AXR(p1773817948751) 2026-10: 잔액이 계속 마이너스인 시트에서 BS33(-1,495,947)을
    // 주차별 잔액 합(-57,650,126)과 비교해 거짓 불일치 경고가 났다.
    const matrix = Array.from({ length: 56 }, () => Array.from({ length: 72 }, () => ''));
    const weekColumns = [
      { yearMonth: '2026-12', weekNo: 4, columnIndex: 4 },
      { yearMonth: '2026-12', weekNo: 5, columnIndex: 5 },
      { yearMonth: '2027-01', weekNo: 1, columnIndex: 6 },
    ];
    const write = (rowIndex, weekly, total) => {
      weekly.forEach((value, index) => { matrix[rowIndex][4 + index] = String(value); });
      matrix[rowIndex][70] = String(total);
    };
    write(21, [0, 500, 0], 500); // 입금 합계
    write(31, [1_000, 300, 700], 2_000); // 출금 합계
    write(32, [-1_000, -800, -1_500], -1_500); // 잔액: BS33 = BS22 - BS32
    const section = (mode, offset) => ({
      mode,
      weekColumns,
      lineRows: [],
      derivedRows: [
        { rowIndex: 21 + offset, kind: 'deposit_total' },
        { rowIndex: 31 + offset, kind: 'withdrawal_total' },
        { rowIndex: 32 + offset, kind: 'balance' },
      ],
    });
    const facts = extractCashflowSheetFacts({ matrix, template: { sections: [section('projection', 0), section('actual', 0)] } });
    const balance = facts.controlTotals.projection.find((row) => row.derivedKind === 'balance');

    expect(balance).toMatchObject({
      sourceCell: 'BS33',
      value: -1_500,
      computed: -1_500,
      matches: true,
      annualValues: [{ year: 2026, value: -800 }, { year: 2027, value: -700 }],
    });
    expect(facts.controlTotals.projection.every((row) => row.matches === true)).toBe(true);

    // 시트 Total 잔액이 실제로 입금-출금과 다르면 여전히 불일치로 잡는다.
    matrix[32][70] = '-1,499';
    const changed = extractCashflowSheetFacts({ matrix, template: { sections: [section('projection', 0), section('actual', 0)] } });
    expect(changed.controlTotals.projection.find((row) => row.derivedKind === 'balance'))
      .toMatchObject({ value: -1_499, computed: -1_500, matches: false });
  });

  it('groups sheet finance checks by calendar year using the registered cashflow lines', () => {
    const matrix = Array.from({ length: 55 }, () => Array.from({ length: 72 }, () => ''));
    const weekColumns = [
      { yearMonth: '2025-12', weekNo: 5, columnIndex: 3 },
      { yearMonth: '2026-01', weekNo: 1, columnIndex: 4 },
    ];
    matrix[8][3] = '100';
    matrix[8][4] = '200';
    matrix[8][70] = '300';
    matrix[13][3] = '10';
    matrix[13][4] = '20';
    matrix[13][70] = '30';
    matrix[14][3] = '30';
    matrix[14][4] = '40';
    matrix[14][70] = '70';
    matrix[15][3] = '50';
    matrix[15][4] = '60';
    matrix[15][70] = '110';

    const facts = extractCashflowSheetFacts({
      matrix,
      template: {
        sections: [
          {
            mode: 'projection',
            weekColumns,
            lineRows: [
              { rowIndex: 13, lineId: 'SALES_VAT_IN' },
              { rowIndex: 14, lineId: 'MYSC_PROFIT_OUT' },
              { rowIndex: 15, lineId: 'TEAM_SUPPORT_IN' },
            ],
            derivedRows: [],
          },
          { mode: 'actual', weekColumns, lineRows: [], derivedRows: [] },
        ],
      },
    });

    expect(facts.annualFinancialTotals).toEqual([
      { year: 2025, contractAmount: 100, salesVatAmount: 10, totalRevenueAmount: 30, supportAmount: 50 },
      { year: 2026, contractAmount: 200, salesVatAmount: 20, totalRevenueAmount: 40, supportAmount: 60 },
    ]);
  });

  it('computes the same target revision regardless of Firestore map and week order', () => {
    const first = computeCashflowTargetRevision({
      weeks: [
        { yearMonth: '2026-02', weekNo: 1, actual: { SALES_IN: 20, VAT_IN: 2 } },
        { yearMonth: '2026-01', weekNo: 2, projection: { SALES_IN: 10 } },
      ],
    });
    const second = computeCashflowTargetRevision({
      weeks: [
        { weekNo: 2, yearMonth: '2026-01', projection: { SALES_IN: 10 } },
        { weekNo: 1, yearMonth: '2026-02', actual: { VAT_IN: 2, SALES_IN: 20 } },
      ],
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('distinguishes a missing target value, an explicit zero, and a closed week', () => {
    const missing = computeCashflowTargetRevision({
      weeks: [{ yearMonth: '2026-01', weekNo: 1, projection: {} }],
    });
    const zero = computeCashflowTargetRevision({
      weeks: [{ yearMonth: '2026-01', weekNo: 1, projection: { SALES_IN: 0 } }],
    });
    const closed = computeCashflowTargetRevision({
      weeks: [{ yearMonth: '2026-01', weekNo: 1, projection: {}, adminClosed: true }],
    });
    expect(new Set([missing, zero, closed])).toHaveLength(3);
  });

  it('changes the target revision when Actual source provenance changes but the aggregate stays equal', () => {
    const first = computeCashflowTargetRevision({
      weeks: [{
        yearMonth: '2026-01',
        weekNo: 1,
        actual: { SALES_IN: 600 },
        weeklyExpenseActualBySheet: {
          bank: { SALES_IN: 500 },
          'cashflow-sheet-lab': { SALES_IN: 100 },
        },
      }],
    });
    const second = computeCashflowTargetRevision({
      weeks: [{
        yearMonth: '2026-01',
        weekNo: 1,
        actual: { SALES_IN: 600 },
        weeklyExpenseActualBySheet: {
          bank: { SALES_IN: 400 },
          'cashflow-sheet-lab': { SALES_IN: 200 },
        },
      }],
    });

    expect(first).not.toBe(second);
  });

  it('uses the JVM-compatible canonical source-key order for target revisions', () => {
    expect(computeCashflowTargetRevision({
      weeks: [{
        yearMonth: '2026-07',
        weekNo: 1,
        projection: { SALES_IN: 100 },
        actual: { DIRECT_COST_OUT: 60 },
        weeklyExpenseActualBySheet: {
          'z-source': { DIRECT_COST_OUT: 10 },
          A_source: { DIRECT_COST_OUT: 20 },
          _source: { DIRECT_COST_OUT: 30 },
        },
        adminClosed: false,
      }],
    })).toBe('sha256:013247d9be20befa6593d6a8dc9c39d3a39456651513458be7391d3aafc5383f');
  });

  it('keeps a full 60-week normalized mirror below the Firestore safety budget', () => {
    const mappings = [];
    const matrix = [];
    for (let modeIndex = 0; modeIndex < 2; modeIndex += 1) {
      for (let lineIndex = 0; lineIndex < 16; lineIndex += 1) {
        const rowIndex = modeIndex * 16 + lineIndex;
        matrix[rowIndex] = [];
        for (let weekIndex = 0; weekIndex < 60; weekIndex += 1) {
          const columnIndex = weekIndex + 3;
          matrix[rowIndex][columnIndex] = '1,234';
          mappings.push({
            mode: modeIndex === 0 ? 'projection' : 'actual',
            yearMonth: `2026-${String(Math.floor(weekIndex / 5) + 1).padStart(2, '0')}`,
            weekNo: (weekIndex % 5) + 1,
            lineId: `LINE_${String(lineIndex).padStart(2, '0')}`,
            direction: lineIndex < 7 ? 'IN' : 'OUT',
            rowIndex,
            columnIndex,
            a1: `R${rowIndex + 1}C${columnIndex + 1}`,
            label: `항목 ${lineIndex}`,
          });
        }
      }
    }
    const snapshot = createCashflowPinnedSnapshot({
      projectId: 'project-a',
      spreadsheetId: 'sheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      mappings,
      matrix,
      capturedAt: '2026-07-13T01:00:00.000Z',
    });
    expect(snapshot.cells).toHaveLength(1_920);
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThan(700 * 1024);
  });
});
