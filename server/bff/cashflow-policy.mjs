import cashflowPolicyData from '../../policies/cashflow-policy.json' with { type: 'json' };

export const CASHFLOW_LEDGER_CURRENCY = cashflowPolicyData.ledgerCurrency;

export const CASHFLOW_IN_LINES = cashflowPolicyData.lineEntries
  .filter((entry) => entry.direction === 'IN')
  .map((entry) => entry.lineId);

export const CASHFLOW_OUT_LINES = cashflowPolicyData.lineEntries
  .filter((entry) => entry.direction === 'OUT')
  .map((entry) => entry.lineId);

export const CASHFLOW_ALL_LINES = [...CASHFLOW_IN_LINES, ...CASHFLOW_OUT_LINES];

export const CASHFLOW_SHEET_LINE_LABELS = Object.fromEntries(
  cashflowPolicyData.lineEntries.map((entry) => [entry.lineId, entry.label]),
);

export function getCashflowLineLabel(lineId) {
  if (!lineId) return '';
  return CASHFLOW_SHEET_LINE_LABELS[lineId] || lineId;
}

// projection + actual 두 모드, 월당 5개 재무 주차. 한 달 결산 셀 수의 단일 소스 -
// JVM 은 CashflowLineCatalog.monthCellCount() 로 같은 값을 파생하고, 두 값의 일치는
// CashflowLineCatalogPolicyParityTest(JSON 대조)와 cashflow-policy.test.mjs 가 고정한다.
// 라우트에 리터럴 160 을 쓰지 않는다 - 라인이 추가되면 여기만 따라 움직인다.
export const CASHFLOW_MODE_COUNT = 2;
export const CASHFLOW_WEEKS_PER_MONTH = 5;
export const CASHFLOW_MONTH_CELL_COUNT = CASHFLOW_ALL_LINES.length * CASHFLOW_MODE_COUNT * CASHFLOW_WEEKS_PER_MONTH;
