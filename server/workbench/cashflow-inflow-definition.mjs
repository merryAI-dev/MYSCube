import { analyticsError } from './analytics-contract.mjs';
import { INFLOW_SCOPES, normalizeInflowCell } from './cashflow-inflow-copy.mjs';
import { LINE_IDS, lineRowFor, weekColumnFor } from '../bff/cashflow-coordinates.mjs';
import { toA1 } from '../bff/cashflow-sheet-template.mjs';
import { resolveFinanceWeekForDate, getMonthFinanceWeeks } from '../../src/app/platform/cashflow-week-core.mjs';

const field = (name, type, label, options = {}) => ({ physicalColumn: name, type, label, meaning: label, filterable: false, groupable: false, nullable: false, ...options });
const coverageMetrics = ['project_count', 'observation_count', 'missing_observation_count', 'expected_cell_count', 'confirmed_cell_count', 'missing_cell_count'];
const coverageFields = ['project_id', 'year_month', 'week_no', 'mode', 'receipt_scope', 'currency', 'expected_cells', 'confirmed_cells', 'missing_cells', 'source_status', 'week_start', 'week_end'];
export const CASHFLOW_INFLOW_DEFINITION = {
  id: 'cashflow_inflow', version: '1', label: '사업비 시트의 정산주별 입금',
  meaning: '고정 양식의 입금 항목을 확인한 범위에서 계산합니다. 고객별 수금이나 전사 외부 순유입을 뜻하지 않습니다.',
  grain: { label: '사업 × 정산 월 × 주차 × 실적/예정 × 입금 항목 범위', keys: ['project_id', 'year_month', 'week_no', 'mode', 'receipt_scope'] },
  governance: { status: 'code_verified', activation: '오프라인 검증용. 읽기 전용 수집·권한·대상 사업·실제 모델 검증 후 운영 활성화' },
  sourceRefs: [
    { path: 'server/bff/cashflow-coordinates.mjs', symbol: 'LINE_ROWS / weekColumnFor', meaning: '고정된 주별 입금 셀 좌표' },
    { path: 'server/bff/cashflow-sheet-snapshot.mjs', symbol: 'createCashflowPinnedSnapshot', meaning: '셀 상태 및 Actual/Projection의 0원·미입력 구분' },
    { path: 'policies/cashflow-policy.json', symbol: 'lineEntries / categoryEntries', meaning: '입금 7개 항목. 부가세 환급 분류도 매출부가세 입금으로 연결될 수 있음' },
  ],
  fields: {
    project_id: field('project_id', 'string', '사업 식별자', { filterable: true, groupable: true }),
    year_month: field('year_month', 'string', '정산 월', { format: 'year_month', groupable: true }),
    weekly_year: field('weekly_year', 'integer', '시트의 주별 관리 연도', { min: 2000, max: 2099 }),
    week_no: field('week_no', 'integer', '정산 주차', { min: 1, max: 5, groupable: true }),
    mode: field('mode', 'string', '실적 또는 예정', { filterable: true, enumValues: ['actual', 'projection'] }),
    receipt_scope: field('receipt_scope', 'string', '포함할 입금 항목', { filterable: true, enumValues: Object.keys(INFLOW_SCOPES) }),
    currency: field('currency', 'string', '통화', { filterable: true, enumValues: ['KRW'] }),
    amount: field('amount', 'decimal', '모든 대상 항목을 확인한 입금액', { scale: 0, nullable: true, companions: coverageFields }),
    known_amount: field('known_amount', 'decimal', '확인된 항목 부분합', { scale: 0, nullable: true, companions: coverageFields }),
    expected_cells: field('expected_cells', 'integer', '확인 대상 항목 수', { min: 1, max: 7 }),
    confirmed_cells: field('confirmed_cells', 'integer', '확인한 항목 수', { min: 0, max: 7 }),
    missing_cells: field('missing_cells', 'integer', '확인이 필요한 항목 수', { min: 0, max: 7 }),
    source_status: field('source_status', 'string', '원본 조회 상태', { enumValues: ['OK', 'UNAVAILABLE'] }),
    spreadsheet_id: field('spreadsheet_id', 'string', '원본 스프레드시트 식별자'),
    sheet_name: field('sheet_name', 'string', '원본 시트 이름'),
    source_cells: field('source_cells', 'string', '원본 셀 위치·입력 내용·확인 상태'),
    source_revision: field('source_revision', 'string', '원본 내용 버전', { nullable: true }),
    captured_at: field('captured_at', 'timestamp', '원본을 읽은 시각', { nullable: true }),
    week_start: field('week_start', 'date', '정산주 시작일'),
    week_end: field('week_end', 'date', '정산주 종료일'),
  },
  metrics: {
    total_amount: { kind: 'sum_complete', field: 'amount', label: '모든 대상 항목이 확인된 입금 합계', meaning: '선택한 모든 사업·주차의 대상 항목을 확인했을 때만 합계를 표시합니다. 누락 시 계산 불가(null)입니다.', approved: true, companions: coverageMetrics },
    known_amount_total: { kind: 'sum', field: 'known_amount', label: '확인된 항목 부분합', meaning: '확인된 항목만 더한 금액입니다. 전체 합계로 표현하지 않습니다.', approved: true, companions: coverageMetrics },
    project_count: { kind: 'count_distinct', field: 'project_id', label: '대상 사업 수', meaning: '실패한 원본도 포함하는 선택 범위의 사업 수입니다.', approved: true },
    observation_count: { kind: 'count_rows', label: '대상 사업·주차 수', meaning: '사업과 주차의 조합 수입니다.', approved: true },
    missing_observation_count: { kind: 'count_missing', field: 'amount', label: '금액 확인이 필요한 사업·주차 수', meaning: '하나 이상의 입금 항목이 확인되지 않은 사업·주차 수입니다.', approved: true },
    expected_cell_count: { kind: 'sum', field: 'expected_cells', label: '확인 대상 항목 수', meaning: '선택한 입금 항목의 전체 개수입니다.', approved: true },
    confirmed_cell_count: { kind: 'sum', field: 'confirmed_cells', label: '확인한 항목 수', meaning: '0원을 포함해 확인한 항목 수입니다.', approved: true },
    missing_cell_count: { kind: 'sum', field: 'missing_cells', label: '확인이 필요한 항목 수', meaning: '빈칸·오류·조회 불가 항목 수입니다.', approved: true },
  },
  requiredFilters: [
    { field: 'mode', reason: '실제 입금과 입금 예정은 서로 다른 값입니다.', question: '실제로 들어온 금액과 들어올 예정 금액 중 어느 쪽을 볼까요?', options: [{ id: 'actual', label: '실제 입금' }, { id: 'projection', label: '입금 예정' }] },
    { field: 'receipt_scope', reason: '내부 선입금·지원금·이자가 포함되면 금액의 의미가 달라집니다.', question: '시트의 어떤 입금 항목을 합산할까요?', options: [{ id: 'all_inflows', label: '전체 입금 항목(내부 선입금 포함)' }, { id: 'sales', label: '매출 입금만' }, { id: 'sales_with_vat', label: '매출·매출부가세 입금' }] },
    { field: 'currency', reason: '다른 통화를 환산 기준 없이 더할 수 없습니다.', question: '현재 지원하는 원화(KRW) 입금 자료를 조회할까요?', options: [{ id: 'KRW', label: '원화 입금' }] },
  ],
  timeFields: { timezone: 'Asia/Seoul', yearMonth: 'year_month', weekNo: 'week_no', requireYearMonth: true, requireWeekScope: true, requireCopiedWeeks: true, basis: 'finance_week' },
  allowedRelations: [],
  limitations: [
    '시트 정산주 기준입니다. 달력의 월요일~일요일과 다를 수 있으며 날짜별 입금 내역을 뜻하지 않습니다.',
    '전체 입금 항목에는 내부 선입금·지원금·이자가 포함됩니다. 매출·매출부가세 합계도 고객 수금만을 뜻하지 않습니다.',
    '확인된 항목 부분합은 전체 합계가 아닙니다. 비어 있거나 오류인 항목은 0원으로 처리하지 않습니다.',
    '등록된 분석 대상 목록 범위이며 전사 전체임을 보장하지 않습니다. 원본별 수집 시각이 다를 수 있습니다.',
  ],
};

const invalid = () => { throw analyticsError(422, 'cashflow_inflow_copy_invalid', '입금 사본의 대상·셀 상태·금액·기간이 일치하지 않습니다. 원본 사본을 다시 확인해 주세요.'); };
export function validateCashflowInflowRows(dataset) {
  if (dataset.manifest.semanticDefinitionId !== CASHFLOW_INFLOW_DEFINITION.id) return;
  const coverage = dataset.manifest.timeCoverage;
  if (!coverage || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(coverage.yearMonth) || !Array.isArray(coverage.weekNos) || !coverage.weekNos.length || new Set(coverage.weekNos).size !== coverage.weekNos.length || coverage.weekNos.some((week) => !Number.isInteger(week) || week < 1 || week > 5) || !dataset.rows.length) invalid();
  const sourceOwners = new Map(); const targets = new Map(); const periods = new Set(); const seen = new Set(); const rawCells = new Map();
  let incomplete = false;
  for (const row of dataset.rows) {
    const lines = INFLOW_SCOPES[row.receipt_scope];
    if (row.year_month !== coverage.yearMonth || !coverage.weekNos.includes(row.week_no)) invalid();
    if (!lines || row.currency !== 'KRW' || !Number.isSafeInteger(row.weekly_year)) invalid();
    const col = weekColumnFor(row.weekly_year, row.year_month, row.week_no);
    const week = getMonthFinanceWeeks(row.year_month).find((week) => week.weekNo === row.week_no);
    if (col === -1 || !week || row.week_start !== week.weekStart || row.week_end !== week.weekEnd) invalid();
    if (![row.project_id, row.spreadsheet_id, row.sheet_name].every((value) => typeof value === 'string' && value.trim().length > 0)) invalid();
    const source = JSON.stringify([row.spreadsheet_id, row.sheet_name]);
    if (sourceOwners.has(source) && sourceOwners.get(source) !== row.project_id) invalid();
    sourceOwners.set(source, row.project_id);
    const target = JSON.stringify([source, row.weekly_year, row.currency, row.source_status, row.source_revision, row.captured_at]);
    if (targets.has(row.project_id) && targets.get(row.project_id) !== target) invalid();
    targets.set(row.project_id, target); periods.add(JSON.stringify([row.year_month, row.week_no]));
    seen.add(JSON.stringify([row.project_id, row.year_month, row.week_no, row.mode, row.receipt_scope]));
    if (row.source_status === 'OK') {
      if (typeof row.source_revision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(row.source_revision) || !Number.isFinite(Date.parse(row.captured_at)) || Date.parse(row.captured_at) > Date.parse(dataset.manifest.capturedAt)) invalid();
    } else if (row.source_status !== 'UNAVAILABLE' || row.source_revision !== null || row.captured_at !== null) invalid();
    let cells;
    try { cells = JSON.parse(row.source_cells); } catch { invalid(); }
    if (!Array.isArray(cells) || cells.length !== lines.length) invalid();
    let known = 0; let amount = 0n;
    for (const [index, cell] of cells.entries()) {
      const expected = toA1(lineRowFor(row.mode, LINE_IDS.indexOf(lines[index])), col);
      if (cell.lineId !== lines[index] || cell.sourceCell !== expected || !['ZERO', 'VALUE', 'EMPTY', 'INVALID', 'ERROR'].includes(cell.state)) invalid();
      if (row.source_status === 'UNAVAILABLE' && (cell.state !== 'ERROR' || cell.rawValue !== null)) invalid();
      if (row.source_status === 'OK' && typeof cell.rawValue !== 'string') invalid();
      if (row.source_status === 'OK') {
        const parsed = normalizeInflowCell({ mode: row.mode, rawValue: cell.rawValue });
        if (cell.state !== parsed.state || cell.amount !== parsed.amount) invalid();
      }
      const cellKey = JSON.stringify([row.project_id, row.mode, cell.sourceCell]);
      const cellValue = JSON.stringify([cell.rawValue, cell.state, cell.amount]);
      if (rawCells.has(cellKey) && rawCells.get(cellKey) !== cellValue) invalid();
      rawCells.set(cellKey, cellValue);
      if (['ZERO', 'VALUE'].includes(cell.state)) {
        if (typeof cell.amount !== 'string' || !/^-?(0|[1-9]\d*)$/.test(cell.amount) || !Number.isSafeInteger(Number(cell.amount)) || (cell.state === 'ZERO') !== (BigInt(cell.amount) === 0n)) invalid();
        known++; amount += BigInt(cell.amount);
      } else if (cell.amount !== null) invalid();
    }
    const expectedAmount = known ? amount.toString() : null;
    if (row.expected_cells !== lines.length || row.confirmed_cells !== known || row.missing_cells !== lines.length - known || row.known_amount !== expectedAmount || row.amount !== (known === lines.length ? expectedAmount : null)) invalid();
    incomplete ||= known !== lines.length;
  }
  for (const project of targets.keys()) for (const period of periods) {
    const [month, week] = JSON.parse(period);
    for (const mode of ['actual', 'projection']) for (const receiptScope of Object.keys(INFLOW_SCOPES)) {
      if (!seen.has(JSON.stringify([project, month, week, mode, receiptScope]))) invalid();
    }
  }
  if (periods.size !== coverage.weekNos.length) invalid();
  if (dataset.manifest.coverage.expectedRows !== dataset.rows.length || (incomplete && dataset.manifest.completeness === 'complete')) invalid();
}

export function financeWeekContext(at) {
  const instant = Date.parse(at);
  if (!Number.isFinite(instant)) throw new Error('A valid server clock is required.');
  const date = new Date(instant + 9 * 3600000).toISOString().slice(0, 10);
  const current = resolveFinanceWeekForDate(date);
  const previousDate = new Date(Date.parse(`${current.weekStart}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return { basis: 'finance_week', thisWeek: current, previousWeek: resolveFinanceWeekForDate(previousDate) };
}
