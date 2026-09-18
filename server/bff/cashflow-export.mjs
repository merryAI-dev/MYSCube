import ExcelJS from 'exceljs';
import { getMonthFinanceWeeks } from '../../src/app/platform/cashflow-week-core.mjs';
import {
  CASHFLOW_ALL_LINES,
  CASHFLOW_IN_LINES,
  CASHFLOW_OUT_LINES,
  getCashflowLineLabel,
} from './cashflow-policy.mjs';
import {
  annualColumnFor,
  CashflowTemplateMismatchError,
  requireWeeklyYear,
  weekOrdinal,
} from './cashflow-coordinates.mjs';

export class CashflowExportSourceUnavailableError extends Error {
  constructor(detail) {
    super('연결된 시트에 내려받을 저장값이 없습니다.');
    this.name = 'CashflowExportSourceUnavailableError';
    this.code = 'cashflow_export_source_unavailable';
    this.detail = detail;
  }
}

function cashflowExportSourceUnavailable(detail) {
  throw new CashflowExportSourceUnavailableError(detail);
}

function cashflowTemplateMismatch(detail) {
  throw new CashflowTemplateMismatchError(detail);
}

const CASHFLOW_EXPORT_MODES = Object.freeze(['projection', 'actual']);
const CASHFLOW_EXPORT_STATES = Object.freeze(['EMPTY', 'ZERO', 'VALUE']);
const CASHFLOW_EXPORT_DERIVED_KINDS = Object.freeze(['deposit_total', 'withdrawal_total', 'balance']);
const CASHFLOW_EXPORT_LINE_IDS = new Set(CASHFLOW_ALL_LINES);
const CASHFLOW_EXPORT_DIRECTIONS = new Map([
  ...CASHFLOW_IN_LINES.map((lineId) => [lineId, 'IN']),
  ...CASHFLOW_OUT_LINES.map((lineId) => [lineId, 'OUT']),
]);

function isCashflowExportCellValid(cell) {
  return CASHFLOW_EXPORT_STATES.includes(cell?.state)
    && (cell.state !== 'EMPTY' || cell.amount === undefined)
    && (cell.state !== 'ZERO' || cell.amount === 0)
    && (cell.state !== 'VALUE' || Number.isSafeInteger(cell.amount));
}

function isCashflowExportDeclaredAmountValid(value) {
  return value === null || Number.isSafeInteger(value);
}

function normalizeSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isYearMonth(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}$/.test(trimmed)) return false;
  const [, mmRaw] = trimmed.split('-');
  const month = Number.parseInt(mmRaw, 10);
  return Number.isFinite(month) && month >= 1 && month <= 12;
}

function parseYearMonth(value) {
  if (!isYearMonth(value)) return null;
  const [yearRaw, monthRaw] = value.trim().split('-');
  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  return { year, month };
}

function formatYearMonth(year, month) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

function formatWeekLabel(yearMonth, weekNo) {
  const parsed = parseYearMonth(yearMonth);
  if (!parsed) return `${yearMonth}-w${weekNo}`;
  return `${String(parsed.year % 100).padStart(2, '0')}-${parsed.month}-${weekNo}`;
}

function getMonthWeeks(yearMonth) {
  return getMonthFinanceWeeks(yearMonth);
}

function requireCashflowMirror({ projectId, mirror, yearMonths }) {
  if (!mirror
    || mirror.projectId !== projectId
    || !Array.isArray(yearMonths)
    || yearMonths.length === 0) {
    cashflowExportSourceUnavailable(`mirror identity is unavailable for ${projectId}`);
  }
  if (!Number.isSafeInteger(mirror.weeklyYear)) {
    cashflowTemplateMismatch(`weekly year is invalid for ${projectId}`);
  }
  return requireWeeklyYear(mirror.weeklyYear);
}

function buildCashflowExportWeeksFromMirror({ projectId, mirror, yearMonths, weeklyYear }) {
  if (!Array.isArray(mirror.cells)) {
    cashflowTemplateMismatch(`weekly cells are unavailable for ${projectId}`);
  }
  for (const yearMonth of yearMonths) {
    try {
      if (weekOrdinal(weeklyYear, yearMonth, 1) === -1) {
        cashflowExportSourceUnavailable(`${yearMonth} is outside the weekly coordinate block`);
      }
    } catch {
      cashflowExportSourceUnavailable(`${yearMonth} is outside the weekly coordinate block`);
    }
  }

  const selectedMonths = new Set(yearMonths);
  const cellsByKey = new Map();
  for (const cell of mirror.cells) {
    if (!selectedMonths.has(cell?.yearMonth)) continue;
    const mode = cell?.mode;
    const weekNo = Number(cell?.weekNo);
    const lineId = cell?.lineId;
    if (!CASHFLOW_EXPORT_MODES.includes(mode)
      || weekOrdinal(weeklyYear, cell.yearMonth, weekNo) === -1
      || !CASHFLOW_EXPORT_LINE_IDS.has(lineId)
      || cell.direction !== CASHFLOW_EXPORT_DIRECTIONS.get(lineId)
      || !isCashflowExportCellValid(cell)) {
      cashflowTemplateMismatch(`mirror cell is invalid for ${projectId}`);
    }
    const key = `${cell.yearMonth}|${weekNo}|${mode}|${lineId}`;
    if (cellsByKey.has(key)) {
      cashflowTemplateMismatch(`mirror cell is duplicated for ${projectId}`);
    }
    cellsByKey.set(key, cell);
  }

  const checksByKey = new Map();
  const weeklyCalculationChecks = mirror?.sheetFacts?.weeklyCalculationChecks;
  if (!Array.isArray(weeklyCalculationChecks)) {
    cashflowTemplateMismatch(`declared weekly totals are unavailable for ${projectId}`);
  }
  for (const check of weeklyCalculationChecks) {
    if (!selectedMonths.has(check?.yearMonth)) continue;
    const mode = check?.mode;
    const weekNo = Number(check?.weekNo);
    const reported = check?.reported;
    if (!CASHFLOW_EXPORT_MODES.includes(mode)
      || weekOrdinal(weeklyYear, check.yearMonth, weekNo) === -1
      || !reported
      || !isCashflowExportDeclaredAmountValid(reported.depositTotal)
      || !isCashflowExportDeclaredAmountValid(reported.withdrawalTotal)
      || !isCashflowExportDeclaredAmountValid(reported.balance)) {
      cashflowTemplateMismatch(`declared weekly totals are invalid for ${projectId}`);
    }
    const key = `${check.yearMonth}|${weekNo}|${mode}`;
    if (checksByKey.has(key)) {
      cashflowTemplateMismatch(`declared weekly totals are duplicated for ${projectId}`);
    }
    checksByKey.set(key, reported);
  }

  const weeks = [];
  for (const yearMonth of yearMonths) {
    for (let weekNo = 1; weekNo <= 5; weekNo += 1) {
      const week = {
        id: `${projectId}-${yearMonth}-w${weekNo}-sheet-mirror`,
        projectId,
        yearMonth,
        weekNo,
        projection: {},
        actual: {},
        projectionStates: {},
        actualStates: {},
      };
      for (const mode of CASHFLOW_EXPORT_MODES) {
        const amounts = week[mode];
        const states = week[`${mode}States`];
        for (const lineId of CASHFLOW_ALL_LINES) {
          const cell = cellsByKey.get(`${yearMonth}|${weekNo}|${mode}|${lineId}`);
          if (!cell) {
            cashflowTemplateMismatch(`mirror cell is missing for ${projectId}`);
          }
          states[lineId] = cell.state;
          if (cell.state === 'VALUE' || cell.state === 'ZERO') amounts[lineId] = cell.amount;
        }
        const reported = checksByKey.get(`${yearMonth}|${weekNo}|${mode}`);
        if (!reported) {
          cashflowTemplateMismatch(`declared weekly totals are missing for ${projectId}`);
        }
        week[`${mode}Totals`] = {
          totalIn: reported.depositTotal,
          totalOut: reported.withdrawalTotal,
          balance: reported.balance,
        };
      }
      weeks.push(week);
    }
  }
  return weeks;
}

function isWholeCalendarYear(yearMonths, year) {
  return yearMonths.length === 12 && yearMonths.every((yearMonth, index) => (
    yearMonth === `${year}-${String(index + 1).padStart(2, '0')}`
  ));
}

function buildCashflowExportAnnualFromMirror({ projectId, mirror, year, periodKind = 'ANNUAL' }) {
  if (!Array.isArray(mirror.annualCells) || !Array.isArray(mirror.annualDerivedCells)) {
    cashflowTemplateMismatch(`annual cells are unavailable for ${projectId}`);
  }

  const cellsByKey = new Map();
  for (const cell of mirror.annualCells) {
    if (cell?.year !== year) continue;
    if (!CASHFLOW_EXPORT_MODES.includes(cell?.mode)
      || cell.periodKind !== periodKind
      || !CASHFLOW_EXPORT_LINE_IDS.has(cell?.lineId)
      || cell.direction !== CASHFLOW_EXPORT_DIRECTIONS.get(cell.lineId)
      || !isCashflowExportCellValid(cell)) {
      cashflowTemplateMismatch(`annual line is invalid for ${projectId}`);
    }
    const key = `${cell.mode}|${cell.lineId}`;
    if (cellsByKey.has(key)) {
      cashflowTemplateMismatch(`annual line is duplicated for ${projectId}`);
    }
    cellsByKey.set(key, cell);
  }

  const derivedByKey = new Map();
  for (const cell of mirror.annualDerivedCells) {
    if (cell?.year !== year) continue;
    if (!CASHFLOW_EXPORT_MODES.includes(cell?.mode)
      || cell.periodKind !== periodKind
      || !CASHFLOW_EXPORT_DERIVED_KINDS.includes(cell?.derivedKind)
      || !isCashflowExportCellValid(cell)) {
      cashflowTemplateMismatch(`annual derived cell is invalid for ${projectId}`);
    }
    const key = `${cell.mode}|${cell.derivedKind}`;
    if (derivedByKey.has(key)) {
      cashflowTemplateMismatch(`annual derived cell is duplicated for ${projectId}`);
    }
    derivedByKey.set(key, cell);
  }

  const annual = { year };
  for (const mode of CASHFLOW_EXPORT_MODES) {
    const amounts = {};
    const states = {};
    for (const lineId of CASHFLOW_ALL_LINES) {
      const cell = cellsByKey.get(`${mode}|${lineId}`);
      if (!cell) cashflowTemplateMismatch(`annual line is missing for ${projectId}`);
      states[lineId] = cell.state;
      if (cell.state === 'ZERO' || cell.state === 'VALUE') amounts[lineId] = cell.amount;
    }
    const derivedAmount = (kind) => {
      const cell = derivedByKey.get(`${mode}|${kind}`);
      if (!cell) cashflowTemplateMismatch(`annual derived cell is missing for ${projectId}`);
      return cell.state === 'EMPTY' ? null : cell.amount;
    };
    const totalIn = derivedAmount('deposit_total');
    const totalOut = derivedAmount('withdrawal_total');
    const balance = derivedAmount('balance');
    if (![totalIn, totalOut, balance].every((value) => value === null || Number.isSafeInteger(value))) {
      cashflowTemplateMismatch(`annual derived amount is invalid for ${projectId}`);
    }
    annual[mode] = amounts;
    annual[`${mode}States`] = states;
    annual[`${mode}Totals`] = { totalIn, totalOut, balance };
  }
  return annual;
}

export function buildCashflowExportSourceFromMirror({ projectId, mirror, yearMonths }) {
  const weeklyYear = requireCashflowMirror({ projectId, mirror, yearMonths });
  if (yearMonths.every((yearMonth) => weekOrdinal(weeklyYear, yearMonth, 1) !== -1)) {
    return {
      weeks: buildCashflowExportWeeksFromMirror({ projectId, mirror, yearMonths, weeklyYear }),
      // 연간 합계는 시트 BS열(Total)에 적힌 값이다. 주별 값을 더해 만들지 않는다.
      yearTotal: buildCashflowExportAnnualFromMirror({ projectId, mirror, year: weeklyYear, periodKind: 'GRAND_TOTAL' }),
    };
  }

  const year = Number(String(yearMonths[0] || '').slice(0, 4));
  if (!Number.isSafeInteger(year)
    || annualColumnFor(weeklyYear, year) === -1
    || !isWholeCalendarYear(yearMonths, year)) {
    cashflowExportSourceUnavailable(`requested period is not one complete cashflow coordinate for ${projectId}`);
  }
  return { annual: buildCashflowExportAnnualFromMirror({ projectId, mirror, year }) };
}

export function expandCashflowYearMonthRange(startYearMonth, endYearMonth) {
  const start = parseYearMonth(startYearMonth);
  const end = parseYearMonth(endYearMonth);
  if (!start || !end) return [];
  const startValue = start.year * 12 + (start.month - 1);
  const endValue = end.year * 12 + (end.month - 1);
  const low = Math.min(startValue, endValue);
  const high = Math.max(startValue, endValue);
  const yearMonths = [];
  for (let value = low; value <= high; value += 1) {
    const year = Math.floor(value / 12);
    const month = (value % 12) + 1;
    yearMonths.push(formatYearMonth(year, month));
  }
  return yearMonths;
}

function summarizeCashflowYearMonths(yearMonths) {
  if (!Array.isArray(yearMonths) || yearMonths.length === 0) return '';
  if (yearMonths.length === 1) return yearMonths[0];
  return `${yearMonths[0]} ~ ${yearMonths[yearMonths.length - 1]}`;
}

function buildCashflowWeekSlots(yearMonth) {
  const actualWeeks = new Map();
  for (const week of getMonthWeeks(yearMonth)) {
    actualWeeks.set(week.weekNo, week);
  }
  const slots = [];
  for (let weekNo = 1; weekNo <= 5; weekNo += 1) {
    const actual = actualWeeks.get(weekNo);
    slots.push({
      yearMonth,
      weekNo,
      weekStart: actual?.weekStart || '',
      weekEnd: actual?.weekEnd || '',
      label: actual?.label || formatWeekLabel(yearMonth, weekNo),
      present: Boolean(actual),
    });
  }
  return slots;
}

function getCashflowWeekTotals(week, mode) {
  const declared = mode === 'projection' ? week?.projectionTotals : week?.actualTotals;
  const exactAmount = (value) => {
    if (value === null || Number.isSafeInteger(value)) return value;
    cashflowTemplateMismatch('declared export amount is invalid');
  };
  return {
    totalIn: exactAmount(declared?.totalIn),
    totalOut: exactAmount(declared?.totalOut),
    net: exactAmount(declared?.balance),
  };
}

function normalizeProjectLabel(project) {
  return normalizeSpace(project.shortName || project.name || project.id) || project.id;
}

function normalizeProjectTitle(project) {
  return normalizeSpace(project.name || project.shortName || project.id) || project.id;
}

function getPreferredWeekSheet(current, next) {
  if (!current) return next;
  const currentScore = `${current.updatedAt || ''}|${current.createdAt || ''}|${current.id || ''}`;
  const nextScore = `${next.updatedAt || ''}|${next.createdAt || ''}|${next.id || ''}`;
  return nextScore > currentScore ? next : current;
}

function indexProjectWeeks(project) {
  const byYearMonth = new Map();
  for (const week of project.weeks || []) {
    if (week.projectId !== project.id) continue;
    if (!isYearMonth(week.yearMonth)) continue;
    const weekNo = Math.max(1, Math.min(5, Math.trunc(week.weekNo)));
    const monthMap = byYearMonth.get(week.yearMonth) || new Map();
    monthMap.set(weekNo, getPreferredWeekSheet(monthMap.get(weekNo), week));
    byYearMonth.set(week.yearMonth, monthMap);
  }
  return byYearMonth;
}

function getWeekAmounts(week, mode) {
  const source = mode === 'projection' ? week?.projection : week?.actual;
  const states = mode === 'projection' ? week?.projectionStates : week?.actualStates;
  const amounts = {};
  for (const lineId of CASHFLOW_ALL_LINES) {
    const state = states?.[lineId];
    const hasAmount = Boolean(source) && Object.prototype.hasOwnProperty.call(source, lineId);
    if (state === 'EMPTY' && !hasAmount) {
      amounts[lineId] = null;
    } else if (state === 'ZERO' && hasAmount && source[lineId] === 0) {
      amounts[lineId] = 0;
    } else if (state === 'VALUE' && hasAmount && Number.isSafeInteger(source[lineId])) {
      amounts[lineId] = source[lineId];
    } else {
      cashflowTemplateMismatch(`render source is invalid for ${lineId}`);
    }
  }
  return amounts;
}

function formatYearTotalLabel(year) {
  return `${year}년 연간 합계(1~12월)`;
}

// 시트 BS열(Total)의 값을 그대로 옮긴다. 화면에 보이는 달만 더한 값이 아니라 그해 1~12월 합계다.
function resolveYearTotalColumn({ yearTotal, yearMonths, mode }) {
  if (!yearTotal) return null;
  const years = new Set(yearMonths.map((yearMonth) => Number(String(yearMonth).slice(0, 4))));
  if (years.size !== 1 || !years.has(yearTotal.year)) {
    cashflowTemplateMismatch('year total does not match the exported weekly year');
  }
  return {
    label: formatYearTotalLabel(yearTotal.year),
    amounts: getWeekAmounts(yearTotal, mode),
    totals: getCashflowWeekTotals(yearTotal, mode),
  };
}

function buildWeeklyModeSectionRows({ yearMonths, mode, weekIndex, yearTotal }) {
  const modeLabel = mode === 'projection' ? 'Projection' : 'Actual';
  const monthColumns = yearMonths.map((yearMonth) => {
    const slots = buildCashflowWeekSlots(yearMonth);
    const weeksByWeekNo = weekIndex.get(yearMonth) || new Map();
    return {
      slots,
      slotAmounts: slots.map((slot) => getWeekAmounts(weeksByWeekNo.get(slot.weekNo), mode)),
      weekTotals: slots.map((slot) => getCashflowWeekTotals(weeksByWeekNo.get(slot.weekNo), mode)),
    };
  });
  const yearColumn = resolveYearTotalColumn({ yearTotal, yearMonths, mode });
  const withYear = (values, yearValue) => (yearColumn ? [...values, yearValue] : values);
  const weekly = (pick) => monthColumns.flatMap(pick);

  const headerRow = withYear(['항목', ...weekly((month) => month.slots.map((slot) => slot.label))], yearColumn?.label);
  const blankRow = (label) => [label, ...Array(headerRow.length - 1).fill('')];
  const lineRow = (lineId) => withYear(
    [getCashflowLineLabel(lineId), ...weekly((month) => month.slotAmounts.map((amounts) => amounts[lineId]))],
    yearColumn?.amounts[lineId],
  );

  return [
    headerRow,
    blankRow(`입금 (${modeLabel})`),
    ...CASHFLOW_IN_LINES.map(lineRow),
    withYear(['입금 합계', ...weekly((month) => month.weekTotals.map((week) => week.totalIn))], yearColumn?.totals.totalIn),
    blankRow(`출금 (${modeLabel})`),
    ...CASHFLOW_OUT_LINES.map(lineRow),
    withYear(['출금 합계', ...weekly((month) => month.weekTotals.map((week) => week.totalOut))], yearColumn?.totals.totalOut),
    withYear(['잔액', ...weekly((month) => month.weekTotals.map((week) => week.net))], yearColumn?.totals.net),
  ];
}

function buildAnnualModeSectionRows({ annual, mode }) {
  const modeLabel = mode === 'projection' ? 'Projection' : 'Actual';
  const amounts = getWeekAmounts(annual, mode);
  const totals = getCashflowWeekTotals(annual, mode);
  return [
    ['항목', String(annual.year)],
    [`입금 (${modeLabel})`, ''],
    ...CASHFLOW_IN_LINES.map((lineId) => [getCashflowLineLabel(lineId), amounts[lineId]]),
    ['입금 합계', totals.totalIn],
    [`출금 (${modeLabel})`, ''],
    ...CASHFLOW_OUT_LINES.map((lineId) => [getCashflowLineLabel(lineId), amounts[lineId]]),
    ['출금 합계', totals.totalOut],
    ['잔액', totals.net],
  ];
}

function buildProjectWorkbookRows({ project, yearMonths, includeBothModes, mode }) {
  const rows = [];
  const projectTitle = normalizeProjectTitle(project);
  const projectLabel = normalizeProjectLabel(project);
  const weekIndex = indexProjectWeeks(project);
  const transactionCount = project.transactions?.length || 0;
  rows.push(['사업', projectTitle, '사업 ID', project.id, '거래 수', transactionCount]);
  if (projectLabel !== projectTitle) {
    rows.push(['표시명', projectLabel]);
  }
  if (project.annual) {
    rows.push(...buildAnnualModeSectionRows({
      annual: project.annual,
      mode: includeBothModes ? 'projection' : (mode || 'projection'),
    }));
    if (includeBothModes) {
      rows.push([]);
      rows.push(...buildAnnualModeSectionRows({ annual: project.annual, mode: 'actual' }));
    }
    return rows;
  }
  const primaryMode = includeBothModes ? 'projection' : (mode || 'projection');
  rows.push(...buildWeeklyModeSectionRows({ yearMonths, mode: primaryMode, weekIndex, yearTotal: project.yearTotal }));
  if (includeBothModes) {
    rows.push([]);
    rows.push(...buildWeeklyModeSectionRows({ yearMonths, mode: 'actual', weekIndex, yearTotal: project.yearTotal }));
  }
  return rows;
}

function makeUniqueSheetName(baseName, usedNames) {
  const cleaned = normalizeSpace(baseName).replace(/[\[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const base = (cleaned || 'Sheet').slice(0, 31);
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }
  for (let i = 2; i < 100; i += 1) {
    const suffix = ` (${i})`;
    const candidate = `${base.slice(0, Math.max(0, 31 - suffix.length))}${suffix}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
  const fallback = `${base.slice(0, 27)}-dup`;
  usedNames.add(fallback);
  return fallback.slice(0, 31);
}

function compareProjects(left, right, sortBy) {
  if (sortBy === 'DEPARTMENT') {
    const departmentOrder = normalizeSpace(left.department).localeCompare(normalizeSpace(right.department), 'ko');
    if (departmentOrder) return departmentOrder;
  }
  const leftTitle = normalizeProjectTitle(left);
  const rightTitle = normalizeProjectTitle(right);
  if (leftTitle !== rightTitle) return leftTitle.localeCompare(rightTitle, 'ko');
  return String(left.id || '').localeCompare(String(right.id || ''));
}

function buildWorkbookSpec({ projects, yearMonths, variant, sortBy = 'PROJECT_NAME', scope = 'all' }) {
  if (variant === 'single-project') {
    const project = projects[0];
    if (!project) return { sheets: [] };
    return {
      sheets: [
        { name: 'Projection', rows: buildProjectWorkbookRows({ project, yearMonths, includeBothModes: false, mode: 'projection' }) },
        { name: 'Actual', rows: buildProjectWorkbookRows({ project, yearMonths, includeBothModes: false, mode: 'actual' }) },
      ],
    };
  }
  if (variant === 'combined') {
    const rows = [];
    const sortedProjects = [...projects].sort((left, right) => compareProjects(left, right, sortBy));
    for (const project of sortedProjects) {
      rows.push(...buildProjectWorkbookRows({ project, yearMonths, includeBothModes: true }));
      rows.push([]);
    }
    return { sheets: [{ name: scope === 'selected' ? '선택 사업' : '전체 사업', rows }] };
  }
  const usedNames = new Set();
  const sortedProjects = [...projects].sort((left, right) => compareProjects(left, right, sortBy));
  return {
    sheets: sortedProjects.map((project) => ({
      name: makeUniqueSheetName(normalizeProjectLabel(project), usedNames),
      rows: buildProjectWorkbookRows({ project, yearMonths, includeBothModes: true }),
    })),
  };
}

export function buildCashflowExportFileName({ scope, projectName, yearMonths, variant }) {
  const period = summarizeCashflowYearMonths(yearMonths).replace(/\s+/g, '');
  if (scope === 'single') {
    return `캐시플로_추출_${normalizeSpace(projectName || '단일사업')}_${period || '기간미지정'}.xlsx`;
  }
  const scopeLabel = scope === 'selected' ? '선택사업' : '전체사업';
  const suffix = variant === 'combined' ? `${scopeLabel}_통합시트` : `${scopeLabel}_개별시트`;
  return `캐시플로_추출_${suffix}_${period || '기간미지정'}.xlsx`;
}

function applyCashflowWorksheetFormat(worksheet) {
  worksheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 2 }];
  worksheet.properties.defaultRowHeight = 20;
  worksheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  worksheet.getColumn(1).width = 24;
  for (let columnIndex = 2; columnIndex <= worksheet.columnCount; columnIndex += 1) {
    worksheet.getColumn(columnIndex).width = 14;
  }

  worksheet.eachRow((row, rowNumber) => {
    const label = normalizeSpace(row.getCell(1).value);
    const isMetadata = rowNumber === 1 || label === '표시명';
    const isHeader = label === '항목';
    const isSection = label.startsWith('입금 (') || label.startsWith('출금 (');
    const isSummary = ['입금 합계', '출금 합계', '잔액'].includes(label);

    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      cell.alignment = { vertical: 'middle', horizontal: columnNumber === 1 ? 'left' : 'right' };
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFF1F5F9' } },
      };
      if (columnNumber > 1 && typeof cell.value === 'number') {
        cell.numFmt = '#,##0;[Red]-#,##0;–';
      }
      if (isMetadata) {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF001E46' } };
      } else if (isHeader) {
        cell.font = { bold: true, color: { argb: 'FF17324D' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF0F5' } };
      } else if (isSection) {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: label.startsWith('입금') ? 'FF0F766E' : 'FF475569' } };
      } else if (isSummary) {
        cell.font = { bold: true, color: { argb: 'FF0F172A' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: label === '잔액' ? 'FFFDE68A' : 'FFF8FAFC' } };
      }
    });
  });
}

export async function buildCashflowExportWorkbookBuffer({
  projects,
  yearMonths,
  variant,
  sortBy = 'PROJECT_NAME',
  scope = 'all',
}) {
  const workbookSpec = buildWorkbookSpec({ projects, yearMonths, variant, sortBy, scope });
  const workbook = new ExcelJS.Workbook();
  for (const sheet of workbookSpec.sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    sheet.rows.forEach((row) => worksheet.addRow(row));
    applyCashflowWorksheetFormat(worksheet);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
