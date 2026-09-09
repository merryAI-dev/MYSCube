import { createHash, randomUUID } from 'node:crypto';
import {
  asyncHandler,
  chunkArray,
  createHttpError,
  ensureDocumentExists,
  readOptionalText,
  stripUndefinedDeep,
} from '../bff-utils.mjs';
import { GoogleSheetsServiceError, extractSpreadsheetId } from '../google-sheets.mjs';
import { analyzeCashflowSheetTemplate, cashflowMappingKey, parseCashflowWeekLabel } from '../cashflow-sheet-template.mjs';
import {
  buildAnnualCashflowTotals,
  computeCashflowTargetRevision,
  createCashflowPinnedSnapshot,
} from '../cashflow-sheet-snapshot.mjs';
import { CASHFLOW_ALL_LINES, CASHFLOW_IN_LINES, CASHFLOW_OUT_LINES } from '../cashflow-policy.mjs';
import {
  cashflowAnnualTotalDocPath,
  summarizeCashflowAnnualMode,
} from '../cashflow-annual-total.mjs';
import { assertCashflowMutationRuntime, createJavaWeeklyClient } from '../java-weekly-client.mjs';
import { createCashflowPerformanceTrace } from '../cashflow-performance.mjs';
import { stableStringify } from '../utils.mjs';
import { cashflowApplyLeaseMs, readCashflowApplyLeaseState } from '../cashflow-apply-lease.mjs';
import { cashflowCloseHash } from '../cashflow-close-hash.mjs';
import {
  CASHFLOW_CUMULATIVE_CLOSE_CONTRACT,
  CASHFLOW_CUMULATIVE_CLOSE_FROM_MONTH,
  cashflowCumulativeMonthLocked,
  readCashflowCumulativeCloseAuthority,
  readCashflowCumulativeCloseScope,
  monthsBetween,
  previousYearMonth,
} from '../cashflow-close-calendar.mjs';
import { getMonthFinanceWeeks } from '../../../src/app/platform/cashflow-week-core.mjs';
import {
  cashflowSheetLabApplySchema,
  cashflowSheetLabConfigSchema,
  cashflowSheetLabMirrorRefreshSchema,
  cashflowSheetLabStageSchema,
  parseWithSchema,
} from '../schemas.mjs';

const CASHFLOW_SHEET_LAB_READ_RANGE = 'A1:BT60';
const DEFAULT_SHEET_PREVIEW_CACHE_TTL_MS = 15_000;
const CASHFLOW_USAGE_SHEET_NAME_PARTS = ['cashflow', '사용내역', '연동'];
const CASHFLOW_WEEK_BASIS = 'sheet_range';
const CASHFLOW_WEEKS_COLLECTION_ID = 'cashflow_weeks';
const CASHFLOW_CHANGE_CANDIDATES_COLLECTION_ID = 'cashflow_change_candidates';
const CASHFLOW_SHEET_MIRRORS_COLLECTION_ID = 'cashflow_sheet_mirrors';
const CASHFLOW_SHEET_SNAPSHOTS_COLLECTION_ID = 'cashflow_sheet_snapshots';
const CASHFLOW_SHEET_SNAPSHOT_MONTHS_COLLECTION_ID = 'cashflow_sheet_snapshot_months';
const CASHFLOW_SHEET_SNAPSHOT_YEARS_COLLECTION_ID = 'cashflow_sheet_snapshot_years';
const CASHFLOW_SHEET_REFRESH_RUNS_COLLECTION_ID = 'cashflow_sheet_refresh_runs';
const CASHFLOW_SHEET_STAGE_RUNS_COLLECTION_ID = 'cashflow_sheet_stage_runs';
const CASHFLOW_SHEET_STAGE_MONTHS_COLLECTION_ID = 'cashflow_sheet_stage_months';
const CASHFLOW_SHEET_STAGE_YEARS_COLLECTION_ID = 'cashflow_sheet_stage_years';
const CASHFLOW_MODES = ['projection', 'actual'];
const CASHFLOW_SHEET_SOURCE_KEY = 'cashflow-sheet-lab';
// 미러 본체(sheetFacts 포함)의 형태 버전. 형태를 바꾸는 코드 변경마다 올린다.
// refresh 는 시트 modifiedTime 이 같으면 저장된 미러를 그대로 돌려주는데, 그 최적화는
// "시트가 같으면 결과도 같다" 를 전제한다. 코드가 바뀌면 전제가 깨지므로 버전이 다른
// 미러는 시트가 안 바뀌었어도 한 번 다시 읽는다. 다시 만들어지면 최적화가 다시 돈다.
//   2 → 3: annualCashflowTotals 가 항목별 lineStates 를 담고 주차 연도 항목을 만들지 않는다.
const CASHFLOW_SHEET_MIRROR_SCHEMA_VERSION = 3;
const CASHFLOW_SHEET_APPLY_COMMAND = 'weeklyExpense.cashflowSheetLab.apply';
const CASHFLOW_ACTIVE_CLOSE_REQUEST_STATUSES = new Set(['PENDING', 'PENDING_APPROVAL', 'APPROVING', 'UNCERTAIN']);
const CASHFLOW_LINE_ORDER = new Map(CASHFLOW_ALL_LINES.map((lineId, index) => [lineId, index]));
const FINANCIAL_YEAR_FIELDS = [
  'contractAmount',
  'salesVatAmount',
  'totalRevenueAmount',
  'supportAmount',
];

function projectCashflowYears(project = {}) {
  const startText = readOptionalText(project.contractStart);
  const endText = readOptionalText(project.contractEnd);
  const startYear = /^\d{4}-/.test(startText) ? Number(startText.slice(0, 4)) : Number.NaN;
  const endYear = /^\d{4}-/.test(endText) ? Number(endText.slice(0, 4)) : Number.NaN;
  if (Number.isSafeInteger(startYear) && Number.isSafeInteger(endYear) && startYear <= endYear && endYear - startYear <= 20) {
    return Array.from({ length: endYear - startYear + 1 }, (_, index) => startYear + index);
  }
  return [...new Set((Array.isArray(project.financialYears) ? project.financialYears : [])
    .map((row) => Number(row?.year))
    .filter(Number.isSafeInteger))].sort((left, right) => left - right);
}

function inferLegacySourceYear(config = {}, project = {}) {
  const parsed = parseCashflowWeekLabel(readOptionalText(config.startWeek));
  if (Number.isSafeInteger(parsed?.year)) return parsed.year;
  const years = projectCashflowYears(project);
  if (years.length === 1) return years[0];
  // All legacy cashflow sources were introduced with the 2026 template.
  return 2026;
}

function resolveSourceYear(value, config = {}, project = {}) {
  const requested = Number(value);
  const year = Number.isSafeInteger(requested) && requested >= 2000 && requested <= 2100
    ? requested
    : inferLegacySourceYear(config, project);
  const projectYears = projectCashflowYears(project);
  if (projectYears.length > 0 && !projectYears.includes(year)) {
    throw createHttpError(400, `${year}년은 프로젝트 사업기간에 포함되지 않습니다.`, 'cashflow_sheet_source_year_out_of_period');
  }
  return year;
}

function wholeWon(value) {
  return Number.isSafeInteger(value) ? value : 0;
}

function attachFinancialYearChecks(mirror, project) {
  if (mirror?.status !== 'FRESH') return mirror;
  const registeredYears = Array.isArray(project?.financialYears)
    ? project.financialYears
      .filter((row) => Number.isSafeInteger(row?.year))
      .sort((left, right) => left.year - right.year)
    : [];
  if (registeredYears.length < 2) return mirror;

  const sheetYears = new Map((mirror.sheetFacts?.annualFinancialTotals || [])
    .filter((row) => Number.isSafeInteger(row?.year))
    .map((row) => [row.year, row]));
  const compare = (year, registered, sheet) => {
    const mismatches = FINANCIAL_YEAR_FIELDS.filter((field) => (
      !sheet || wholeWon(registered[field]) !== wholeWon(sheet[field])
    ));
    return {
      year,
      status: sheet ? (mismatches.length === 0 ? 'MATCH' : 'MISMATCH') : 'SHEET_YEAR_MISSING',
      mismatches,
      registered: Object.fromEntries(FINANCIAL_YEAR_FIELDS.map((field) => [field, wholeWon(registered[field])])),
      sheet: Object.fromEntries(FINANCIAL_YEAR_FIELDS.map((field) => [field, wholeWon(sheet?.[field])])),
    };
  };
  const years = registeredYears.map((registered) => compare(registered.year, registered, sheetYears.get(registered.year)));
  const totalRegistered = Object.fromEntries(FINANCIAL_YEAR_FIELDS.map((field) => [field,
    years.reduce((sum, row) => sum + row.registered[field], 0),
  ]));
  const totalSheet = Object.fromEntries(FINANCIAL_YEAR_FIELDS.map((field) => [field,
    years.reduce((sum, row) => sum + row.sheet[field], 0),
  ]));
  const totalMismatches = FINANCIAL_YEAR_FIELDS.filter((field) => totalRegistered[field] !== totalSheet[field]);

  return {
    ...mirror,
    financialYearChecks: {
      years,
      total: {
        status: years.some((row) => row.status === 'SHEET_YEAR_MISSING')
          ? 'SHEET_YEAR_MISSING'
          : (totalMismatches.length === 0 ? 'MATCH' : 'MISMATCH'),
        mismatches: totalMismatches,
        registered: totalRegistered,
        sheet: totalSheet,
      },
    },
  };
}

function readSelectedYear(value) {
  const text = readOptionalText(value);
  const year = /^\d{4}$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(year)) {
    throw createHttpError(400, 'selectedYear must be a four-digit year.', 'cashflow_selected_year_invalid');
  }
  return year;
}

async function readCanonicalAnnualTotal(db, tenantId, projectId, year) {
  const snap = await db.doc(cashflowAnnualTotalDocPath(tenantId, projectId, year)).get();
  if (!snap.exists) return null;
  const value = snap.data() || {};
  if (readOptionalText(value.projectId) !== projectId || Number(value.year) !== year) return null;
  return {
    year,
    source: 'ANNUAL',
    revision: Math.max(0, Number(value.revision) || 0),
    sourceRevision: readOptionalText(value.sourceRevision),
    updatedAt: readOptionalText(value.updatedAt),
    projection: summarizeCashflowAnnualMode(value, 'projection'),
    actual: summarizeCashflowAnnualMode(value, 'actual'),
  };
}

function normalizeRole(value) {
  const normalized = readOptionalText(value).toLowerCase();
  return normalized === 'viewer' ? 'pm' : normalized;
}

function isWorkspaceUser(context, workspaceEmailDomain = 'mysc.co.kr') {
  const email = readOptionalText(context?.actorEmail).toLowerCase();
  const domain = readOptionalText(workspaceEmailDomain).replace(/^@+/, '').toLowerCase();
  return Boolean(domain) && email.endsWith(`@${domain}`);
}

function assertCashflowSheetLabAccess(req, workspaceEmailDomain = 'mysc.co.kr') {
  const actorRole = normalizeRole(req.context?.actorRole);
  if (isWorkspaceUser(req.context, workspaceEmailDomain)) return;
  if (['admin', 'finance_admin'].includes(actorRole)) return;
  throw createHttpError(
    403,
    `Workspace email is required to preview cashflow sheets lab: ${actorRole || 'unknown'}`,
    'forbidden',
  );
}

// 강제 해제는 진행 중일 수 있는 반영을 끊는 조작이므로 워크스페이스 사용자 전체가 아니라
// 관리 역할에게만 연다.
function assertCashflowSheetApplyLockAdmin(req) {
  const actorRole = normalizeRole(req.context?.actorRole);
  if (['admin', 'finance_admin'].includes(actorRole)) return;
  throw createHttpError(
    403,
    '시트 반영 대기 상태 해제는 관리자만 할 수 있습니다.',
    'forbidden',
  );
}

function normalizeRouteError(error) {
  if (error instanceof GoogleSheetsServiceError) {
    if (error.code === 'google_sheets_api_error' && [401, 403].includes(Number(error.statusCode))) {
      return createHttpError(
        403,
        'Google Sheet를 MYSC 시스템 서비스 계정에 공유해 주세요.',
        'google_sheet_service_account_forbidden',
      );
    }
    return createHttpError(error.statusCode, error.message, error.code);
  }
  return error;
}

function logCashflowSheetLab(event, req, details = {}, level = 'info') {
  try {
    const write = typeof console[level] === 'function' ? console[level] : console.info;
    write('[CashflowSheetLab]', event, {
      requestId: req.context?.requestId || req.requestId || null,
      tenantId: req.context?.tenantId || null,
      actorId: req.context?.actorId || null,
      actorRole: req.context?.actorRole || null,
      ...details,
    });
  } catch {
    // Diagnostics must never affect a financial command.
  }
}

function cashflowStageMetricNow(performanceNow) {
  try {
    const value = Number(typeof performanceNow === 'function' ? performanceNow() : Date.now());
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function cashflowStageJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function emitCashflowStageMetric(performanceLogger, payload) {
  try {
    if (typeof performanceLogger === 'function') {
      performanceLogger(payload);
    } else if (process.env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(payload));
    }
  } catch {
    // Diagnostics must never affect a financial stage.
  }
}

function routeErrorDetails(error) {
  return {
    statusCode: error?.statusCode || 500,
    code: error?.code || error?.name || 'error',
    message: error?.message || 'Unknown error',
  };
}

function normalizeSheetFamilyName(value) {
  return readOptionalText(value).toLowerCase().replace(/\s+/g, '');
}

function isCashflowUsageLinkedSheetName(value) {
  const normalized = normalizeSheetFamilyName(value);
  return CASHFLOW_USAGE_SHEET_NAME_PARTS.every((part) => normalized.includes(part));
}

function findCashflowUsageLinkedSheet(sheets = []) {
  return sheets.find((sheet) => isCashflowUsageLinkedSheetName(sheet?.title)) || null;
}

function assertCashflowUsageLinkedSheet(preview) {
  if (isCashflowUsageLinkedSheetName(preview?.selectedSheetName)) return;
  throw createHttpError(
    400,
    'cashflow(사용내역 연동) 계열 시트 탭만 검토할 수 있습니다.',
    'cashflow_sheet_tab_unsupported',
  );
}

function projectDocPath(tenantId, projectId) {
  return `orgs/${tenantId}/projects/${projectId}`;
}

function cashflowSheetMirrorDocPath(tenantId, projectId) {
  return `orgs/${tenantId}/${CASHFLOW_SHEET_MIRRORS_COLLECTION_ID}/${projectId}`;
}

function cashflowSheetSnapshotDocPath(tenantId, snapshotId) {
  return `orgs/${tenantId}/${CASHFLOW_SHEET_SNAPSHOTS_COLLECTION_ID}/${snapshotId}`;
}

function cashflowSheetSnapshotMonthDocPath(tenantId, snapshotId, yearMonth) {
  return `orgs/${tenantId}/${CASHFLOW_SHEET_SNAPSHOT_MONTHS_COLLECTION_ID}/${snapshotId}_${readOptionalText(yearMonth).replace('-', '_')}`;
}

function cashflowSheetSnapshotYearDocPath(tenantId, snapshotId, year) {
  return `orgs/${tenantId}/${CASHFLOW_SHEET_SNAPSHOT_YEARS_COLLECTION_ID}/${snapshotId}_${Number(year)}`;
}

function cashflowSheetRefreshRunDocPath(tenantId, projectId, idempotencyKey) {
  const runId = `cfrefresh_${stableHash({ tenantId, projectId, idempotencyKey }).slice(0, 32)}`;
  return `orgs/${tenantId}/${CASHFLOW_SHEET_REFRESH_RUNS_COLLECTION_ID}/${runId}`;
}

function cashflowSheetStageMonthDocPath(tenantId, runId, yearMonth) {
  const monthKey = readOptionalText(yearMonth).replace('-', '_');
  return `orgs/${tenantId}/${CASHFLOW_SHEET_STAGE_MONTHS_COLLECTION_ID}/${runId}_${monthKey}`;
}

function cashflowSheetStageYearDocPath(tenantId, runId, year) {
  return `orgs/${tenantId}/${CASHFLOW_SHEET_STAGE_YEARS_COLLECTION_ID}/${runId}_${Number(year)}`;
}

async function readProjectDocument(db, tenantId, projectId) {
  if (!db) return null;
  return ensureDocumentExists(db, projectDocPath(tenantId, projectId), `Project not found: ${projectId}`);
}

function readCashflowSheetLabConfig(project = {}, sourceYear) {
  const requestedYear = Number(sourceYear);
  const hasRequestedYear = Number.isSafeInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100;
  const configured = hasRequestedYear
    ? project?.cashflowSheetLabSources?.[String(requestedYear)]
    : null;
  const legacy = project?.cashflowSheetLab;
  const config = configured || (legacy && (
    !hasRequestedYear || inferLegacySourceYear(legacy, project) === requestedYear
  ) ? legacy : null);
  if (!config || typeof config !== 'object') return null;
  const value = readOptionalText(config.value);
  if (!value) return null;
  return {
    sourceYear: resolveSourceYear(config.sourceYear || sourceYear, config, project),
    value,
    sheetName: readOptionalText(config.sheetName),
    spreadsheetId: readOptionalText(config.spreadsheetId),
    spreadsheetTitle: readOptionalText(config.spreadsheetTitle),
    startWeek: readOptionalText(config.startWeek),
    endWeek: readOptionalText(config.endWeek),
    weekBasis: readOptionalText(config.weekBasis) || CASHFLOW_WEEK_BASIS,
    totalBasis: readOptionalText(config.totalBasis) || CASHFLOW_WEEK_BASIS,
    updatedAt: readOptionalText(config.updatedAt),
    updatedBy: config.updatedBy && typeof config.updatedBy === 'object' ? {
      uid: readOptionalText(config.updatedBy.uid),
      email: readOptionalText(config.updatedBy.email),
      role: readOptionalText(config.updatedBy.role),
    } : null,
    lastAppliedAt: readOptionalText(config.lastAppliedAt),
    lastAppliedBy: config.lastAppliedBy && typeof config.lastAppliedBy === 'object' ? {
      uid: readOptionalText(config.lastAppliedBy.uid),
      email: readOptionalText(config.lastAppliedBy.email),
      role: readOptionalText(config.lastAppliedBy.role),
    } : null,
    lastAppliedLineCount: Number.isFinite(Number(config.lastAppliedLineCount)) ? Number(config.lastAppliedLineCount) : undefined,
    lastProjectionLineCount: Number.isFinite(Number(config.lastProjectionLineCount)) ? Number(config.lastProjectionLineCount) : undefined,
    lastActualLineCount: Number.isFinite(Number(config.lastActualLineCount)) ? Number(config.lastActualLineCount) : undefined,
  };
}

function readCashflowSheetLabConfigs(project = {}) {
  const configs = Object.entries(project?.cashflowSheetLabSources || {}).flatMap(([year, config]) => {
    const parsed = readCashflowSheetLabConfig({ ...project, cashflowSheetLabSources: { [year]: config }, cashflowSheetLab: null }, Number(year));
    return parsed ? [parsed] : [];
  });
  const legacy = readCashflowSheetLabConfig(project);
  if (legacy && !configs.some((config) => config.sourceYear === legacy.sourceYear)) configs.push(legacy);
  return configs.sort((left, right) => left.sourceYear - right.sourceYear);
}

function weekLabelsFromTemplate(template) {
  const labels = new Set();
  for (const section of template?.sections || []) {
    for (const week of section.weekColumns || []) {
      if (week?.raw) labels.add(readOptionalText(week.raw));
    }
  }
  return labels;
}

function assertConfiguredWeekRangeExistsInTemplate(template, { startWeek, endWeek }) {
  const labels = weekLabelsFromTemplate(template);
  const missing = [readOptionalText(startWeek), readOptionalText(endWeek)]
    .filter(Boolean)
    .filter((label) => !labels.has(label));
  if (missing.length === 0) return;
  throw createHttpError(
    400,
    `시작/종료 주차가 시트 헤더에 없습니다: ${missing.join(', ')}`,
    'cashflow_week_range_not_in_sheet',
  );
}

function resolveSystemAccountEmail(googleSheetsService) {
  if (typeof googleSheetsService?.getServiceAccountEmail === 'function') {
    return readOptionalText(googleSheetsService.getServiceAccountEmail());
  }
  return readOptionalText(googleSheetsService?.serviceAccountEmail);
}

function buildConfigResponse(projectId, config, systemAccountEmail = '', project = {}) {
  const serviceAccountEmail = readOptionalText(systemAccountEmail);
  return {
    projectId,
    configured: Boolean(config),
    config,
    configs: readCashflowSheetLabConfigs(project),
    projectYears: projectCashflowYears(project),
    ...(serviceAccountEmail ? {
      systemAccountEmail: serviceAccountEmail,
      accessPolicy: {
        googleAuth: 'service_account',
        serviceAccountEmail,
        sheetPermission: 'shared_with_mysc_system_account',
      },
    } : {}),
  };
}

function resolvePreviewSource(parsed, savedConfig) {
  const value = readOptionalText(parsed.value);
  if (value) {
    return {
      sourceYear: Number(parsed.sourceYear || savedConfig?.sourceYear),
      value,
      sheetName: readOptionalText(parsed.sheetName) || undefined,
      startWeek: '',
      endWeek: '',
      source: 'request',
    };
  }
  if (savedConfig?.value) {
    return {
      sourceYear: Number(savedConfig.sourceYear),
      value: savedConfig.value,
      sheetName: readOptionalText(parsed.sheetName) || savedConfig.sheetName || undefined,
      startWeek: '',
      endWeek: '',
      source: 'saved_config',
    };
  }
  throw createHttpError(
    400,
    'Cashflow sheet URL is not configured. Save the sheet link first.',
    'cashflow_sheet_config_required',
  );
}

function weekSortKey(week) {
  if (!week) return null;
  return week.year * 10000 + week.month * 100 + week.weekNo;
}

function normalizeWeekRange({ startWeek, endWeek }) {
  const start = readOptionalText(startWeek);
  const end = readOptionalText(endWeek);
  const parsedStart = start ? parseCashflowWeekLabel(start) : null;
  const parsedEnd = end ? parseCashflowWeekLabel(end) : null;
  if (start && !parsedStart) {
    throw createHttpError(400, `Invalid startWeek: ${start}`, 'cashflow_week_range_invalid');
  }
  if (end && !parsedEnd) {
    throw createHttpError(400, `Invalid endWeek: ${end}`, 'cashflow_week_range_invalid');
  }
  if (parsedStart && parsedEnd && weekSortKey(parsedStart) > weekSortKey(parsedEnd)) {
    throw createHttpError(400, 'startWeek must be before or equal to endWeek.', 'cashflow_week_range_invalid');
  }
  return {
    startWeek: parsedStart?.raw || '',
    endWeek: parsedEnd?.raw || '',
    startKey: weekSortKey(parsedStart),
    endKey: weekSortKey(parsedEnd),
  };
}

function computeCashflowSheetConfigRevision(config = {}) {
  const rawValue = readOptionalText(config?.value);
  return `sha256:${stableHash({
    sourceYear: Number(config?.sourceYear) || null,
    spreadsheetId: extractSpreadsheetId(rawValue) || rawValue,
    sheetName: readOptionalText(config?.sheetName),
  })}`;
}

function assertFreshCashflowSheetMirror(mirror) {
  if (readOptionalText(mirror?.status) === 'FRESH' && readOptionalText(mirror?.configRevision)) return;
  if (readOptionalText(mirror?.lastRefreshError?.code) === 'cashflow_sheet_config_changed'
    || (readOptionalText(mirror?.status) === 'FRESH' && !readOptionalText(mirror?.configRevision))) {
    throw createHttpError(
      409,
      '시트 설정이 변경되었습니다. 최신값을 다시 가져온 뒤 검토해 주세요.',
      'cashflow_sheet_config_changed',
    );
  }
  throw createHttpError(
    409,
    '최근 시트 연동이 실패했습니다. 최신값을 다시 가져온 뒤 검토해 주세요.',
    'cashflow_sheet_mirror_stale',
  );
}

function isInWeekRange(value, range) {
  if (!range?.startKey && !range?.endKey) return true;
  const key = weekSortKey({
    year: Number.parseInt(String(value.yearMonth).slice(0, 4), 10),
    month: Number.parseInt(String(value.yearMonth).slice(5, 7), 10),
    weekNo: Number(value.weekNo),
  });
  if (!Number.isFinite(key)) return false;
  if (range.startKey && key < range.startKey) return false;
  if (range.endKey && key > range.endKey) return false;
  return true;
}

function buildActiveWeeksFromTemplate(template, weekRange) {
  const projectionSection = template.sections?.find((section) => section.mode === 'projection');
  const sourceWeeks = projectionSection?.weekColumns || template.sections?.[0]?.weekColumns || [];
  const seen = new Set();
  return sourceWeeks
    .filter((week) => isInWeekRange(week, weekRange))
    .map((week) => {
      const key = `${week.yearMonth}:${week.weekNo}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        label: week.raw,
        year: week.year,
        month: week.month,
        yearMonth: week.yearMonth,
        weekNo: week.weekNo,
        source: 'sheet_header',
      };
    })
    .filter(Boolean);
}

function selectCanonicalAnnualCells(cells = []) {
  const byYear = new Map();
  for (const cell of cells) {
    const year = Number(cell?.year);
    const sourceYear = Number(cell?.sourceYear);
    if (!Number.isSafeInteger(year) || !Number.isSafeInteger(sourceYear)) continue;
    const candidates = byYear.get(year) || new Map();
    const sourceCells = candidates.get(sourceYear) || [];
    sourceCells.push(cell);
    candidates.set(sourceYear, sourceCells);
    byYear.set(year, candidates);
  }
  return [...byYear.entries()].flatMap(([year, candidates]) => {
    const sourceYear = [...candidates.keys()].sort((left, right) => (
      Math.abs(left - year) - Math.abs(right - year) || right - left
    ))[0];
    return candidates.get(sourceYear) || [];
  }).sort((left, right) => Number(left.year) - Number(right.year)
    || readOptionalText(left.mode).localeCompare(readOptionalText(right.mode))
    || readOptionalText(left.lineId).localeCompare(readOptionalText(right.lineId)));
}

function mergeCashflowSourceMirror(previous, next, sourceYear) {
  const sheetWeeklyYear = Number(next?.sheetContract?.weeklyYear ?? next?.weeklyYear);
  if (sheetWeeklyYear !== sourceYear) {
    throw createHttpError(
      400,
      `${sourceYear}년 시트에는 ${sourceYear}-1-1 형식의 주차만 사용할 수 있습니다.`,
      'cashflow_sheet_source_year_mismatch',
    );
  }

  const previousCells = readOptionalText(previous?.sourceRevision)
    ? (previous.cells || []).filter((cell) => Number(readOptionalText(cell?.yearMonth).slice(0, 4)) !== sourceYear)
    : [];
  const previousSourceYear = Number(previous?.sourceYear)
    || Number(readOptionalText(previous?.yearMonths?.[0]).slice(0, 4))
    || 2026;
  const previousAnnualCells = readOptionalText(previous?.sourceRevision)
    ? (previous.annualCells || [])
      .map((cell) => ({ ...cell, sourceYear: Number(cell?.sourceYear) || previousSourceYear }))
      .filter((cell) => cell.sourceYear !== sourceYear)
    : [];
  const cells = [...previousCells, ...(next.cells || [])]
    .sort((left, right) => readOptionalText(left.yearMonth).localeCompare(readOptionalText(right.yearMonth))
      || Number(left.weekNo) - Number(right.weekNo)
      || readOptionalText(left.mode).localeCompare(readOptionalText(right.mode))
      || readOptionalText(left.lineId).localeCompare(readOptionalText(right.lineId)));
  const annualCells = selectCanonicalAnnualCells([
    ...previousAnnualCells,
    ...(next.annualCells || []).map((cell) => ({ ...cell, sourceYear })),
  ]);
  const previousAnnualDerivedCells = readOptionalText(previous?.sourceRevision)
    ? (previous.annualDerivedCells || [])
      .map((cell) => ({ ...cell, sourceYear: Number(cell?.sourceYear) || previousSourceYear }))
      .filter((cell) => cell.sourceYear !== sourceYear)
    : [];
  const annualDerivedCells = selectCanonicalAnnualCells([
    ...previousAnnualDerivedCells,
    ...(next.annualDerivedCells || []).map((cell) => ({ ...cell, sourceYear })),
  ]);
  const previousTotalCells = readOptionalText(previous?.sourceRevision)
    ? (previous.totalCells || [])
      .map((cell) => ({ ...cell, sourceYear: Number(cell?.sourceYear) || previousSourceYear }))
      .filter((cell) => cell.sourceYear !== sourceYear)
    : [];
  const totalCells = [
    ...previousTotalCells,
    ...(next.totalCells || []).map((cell) => ({ ...cell, sourceYear })),
  ].sort((left, right) => Number(left.sourceYear) - Number(right.sourceYear)
    || readOptionalText(left.mode).localeCompare(readOptionalText(right.mode))
    || readOptionalText(left.kind).localeCompare(readOptionalText(right.kind))
    || readOptionalText(left.lineId || left.derivedKind).localeCompare(readOptionalText(right.lineId || right.derivedKind)));
  const replaceYearRows = (previousRows, nextRows, yearOf) => [
    ...(previousRows || []).filter((row) => yearOf(row) !== sourceYear),
    ...(nextRows || []).filter((row) => yearOf(row) === sourceYear),
  ].sort((left, right) => yearOf(left) - yearOf(right));
  const sources = {
    ...(previous?.sources && typeof previous.sources === 'object' ? previous.sources : {}),
    [String(sourceYear)]: {
      sourceYear,
      spreadsheetId: next.spreadsheetId,
      spreadsheetTitle: next.spreadsheetTitle,
      selectedSheetName: next.selectedSheetName,
      sourceRevision: next.sourceRevision,
      configRevision: next.configRevision,
      capturedAt: next.capturedAt,
      activeWeekRange: next.activeWeekRange,
    },
  };
  const sourceRevision = `sha256:${stableHash({ sources, cells, annualCells, annualDerivedCells, totalCells })}`;
  const summary = cells.reduce((counts, cell) => {
    counts.cellCount += 1;
    if (['VALUE', 'ZERO'].includes(cell.state)) counts.valueCount += 1;
    if (cell.state === 'EMPTY') counts.emptyCount += 1;
    if (cell.state === 'INVALID') counts.invalidCount += 1;
    return counts;
  }, { cellCount: 0, valueCount: 0, emptyCount: 0, invalidCount: 0 });
  const depositScheduleRows = replaceYearRows(
    previous?.sheetFacts?.depositScheduleRows,
    next?.sheetFacts?.depositScheduleRows,
    (row) => Number(readOptionalText(row?.yearMonth).slice(0, 4)),
  );
  const projectionActualDifferences = replaceYearRows(
    previous?.sheetFacts?.projectionActualDifferences,
    next?.sheetFacts?.projectionActualDifferences,
    (row) => Number(readOptionalText(row?.yearMonth).slice(0, 4)),
  );
  const weeklyCalculationChecks = replaceYearRows(
    previous?.sheetFacts?.weeklyCalculationChecks,
    next?.sheetFacts?.weeklyCalculationChecks,
    (row) => Number(readOptionalText(row?.yearMonth).slice(0, 4)),
  );
  const annualFinancialTotals = replaceYearRows(
    previous?.sheetFacts?.annualFinancialTotals,
    next?.sheetFacts?.annualFinancialTotals,
    (row) => Number(row?.year),
  );
  const annualCashflowTotals = buildAnnualCashflowTotals({ annualCells, annualDerivedCells, weeklyYear: sourceYear });
  const cashflowGrandTotalsBySourceYear = [
    ...(previous?.sheetFacts?.cashflowGrandTotalsBySourceYear || [])
      .filter((row) => Number(row?.sourceYear) !== sourceYear),
    {
      sourceYear,
      ...(next?.sheetFacts?.cashflowGrandTotals || {}),
    },
  ].filter((row) => Number.isSafeInteger(Number(row?.sourceYear)))
    .sort((left, right) => Number(left.sourceYear) - Number(right.sourceYear));
  const reconciliationWarnings = annualCashflowTotals.flatMap((row) => ['projection', 'actual'].flatMap((mode) => (
    ['MISMATCH', 'PARTIAL_WEEKLY'].includes(readOptionalText(row?.[mode]?.reconciliation?.status))
      ? [{ year: row.year, mode, ...row[mode].reconciliation }]
      : []
  )));

  return stripUndefinedDeep({
    ...next,
    schemaVersion: CASHFLOW_SHEET_MIRROR_SCHEMA_VERSION,
    sourceYear,
    sources,
    sourceRevision,
    cells,
    annualCells,
    annualDerivedCells,
    totalCells,
    yearMonths: [...new Set(cells.map((cell) => readOptionalText(cell.yearMonth)).filter(Boolean))].sort(),
    years: [...new Set([
      ...cells.map((cell) => Number(readOptionalText(cell.yearMonth).slice(0, 4))),
      ...annualCells.map((cell) => Number(cell.year)),
    ].filter(Number.isSafeInteger))].sort((left, right) => left - right),
    summary,
    sheetFacts: {
      ...(next.sheetFacts || {}),
      depositScheduleRows,
      projectionActualDifferences,
      weeklyCalculationChecks,
      annualFinancialTotals,
      annualCashflowTotals,
      cashflowGrandTotalsBySourceYear,
    },
    reconciliationWarnings,
    appliedSourceRevision: previous?.appliedSourceRevision,
    appliedTargetRevision: previous?.appliedTargetRevision,
    appliedAnnualYears: previous?.appliedAnnualYears,
    appliedWeeklyYears: previous?.appliedWeeklyYears,
  });
}

async function saveCashflowSheetLabConfig({ db, tenantId, projectId, project, parsed, context, existingConfig = null }) {
  if (!db) {
    throw createHttpError(503, '시트 설정을 저장할 수 없습니다. 담당자에게 문의해 주세요.', 'firestore_unconfigured');
  }
  const now = new Date().toISOString();
  const sourceYear = resolveSourceYear(parsed.sourceYear, existingConfig || parsed, project);
  const spreadsheetId = extractSpreadsheetId(parsed.value);
  const existingSpreadsheetId = readOptionalText(existingConfig?.spreadsheetId);
  const shouldKeepVerifiedMetadata = Boolean(existingConfig)
    && existingSpreadsheetId
    && existingSpreadsheetId === spreadsheetId
    && readOptionalText(existingConfig?.sheetName) === readOptionalText(parsed.sheetName);
  const config = {
    sourceYear,
    value: parsed.value,
    sheetName: readOptionalText(parsed.sheetName),
    spreadsheetId,
    spreadsheetTitle: shouldKeepVerifiedMetadata ? readOptionalText(existingConfig?.spreadsheetTitle) : '',
    startWeek: '',
    endWeek: '',
    weekBasis: CASHFLOW_WEEK_BASIS,
    totalBasis: CASHFLOW_WEEK_BASIS,
    updatedAt: now,
    updatedBy: {
      uid: readOptionalText(context?.actorId),
      email: readOptionalText(context?.actorEmail),
      role: 'workspace_user',
    },
  };
  const configRevision = computeCashflowSheetConfigRevision(config);
  const legacyConfig = readCashflowSheetLabConfig(project);
  const sourceConfigs = {
    ...(project?.cashflowSheetLabSources && typeof project.cashflowSheetLabSources === 'object'
      ? project.cashflowSheetLabSources
      : {}),
    ...(legacyConfig ? { [String(legacyConfig.sourceYear)]: legacyConfig } : {}),
    [String(sourceYear)]: config,
  };
  const projectRef = db.doc(projectDocPath(tenantId, projectId));
  const mirrorRef = db.doc(cashflowSheetMirrorDocPath(tenantId, projectId));
  await db.runTransaction(async (transaction) => {
    const mirrorSnap = await transaction.get(mirrorRef);
    const mirror = mirrorSnap.exists ? mirrorSnap.data() || {} : null;
    transaction.set(projectRef, stripUndefinedDeep({
      cashflowSheetLab: config,
      cashflowSheetLabSources: sourceConfigs,
      updatedAt: now,
    }), { merge: true });
    const installedSource = mirror?.sources?.[String(sourceYear)];
    const hasInstalledSource = Boolean(readOptionalText(installedSource?.sourceRevision))
      || (Number(mirror?.sourceYear) === sourceYear && Boolean(readOptionalText(mirror?.sourceRevision)));
    const installedConfigRevision = readOptionalText(installedSource?.configRevision)
      || (Number(mirror?.sourceYear) === sourceYear ? readOptionalText(mirror?.configRevision) : '');
    const installedConfigMismatch = hasInstalledSource && installedConfigRevision !== configRevision;
    const pendingConfigRevision = readOptionalText(mirror?.pendingRefreshConfigRevision);
    const pendingConfigMismatch = Boolean(pendingConfigRevision)
      && pendingConfigRevision !== configRevision;
    if (installedConfigMismatch || pendingConfigMismatch) {
      const latestRefreshGeneration = Math.max(0, Number(mirror.latestRefreshGeneration) || 0) + 1;
      const invalidation = {
        status: installedConfigMismatch ? 'STALE' : readOptionalText(mirror.status) || (hasInstalledSource ? 'STALE' : 'EMPTY'),
        latestRefreshGeneration,
        pendingRefreshConfigRevision: null,
        lastRefreshAttemptAt: now,
      };
      if (installedConfigMismatch || !hasInstalledSource) {
        invalidation.lastRefreshError = {
          code: 'cashflow_sheet_config_changed',
          message: '시트 설정이 변경되었습니다. 최신값을 다시 가져와 주세요.',
          statusCode: 409,
          at: now,
        };
      }
      transaction.set(mirrorRef, stripUndefinedDeep(invalidation), { merge: true });
    }
  });
  return config;
}

function cashflowChangeCandidateManifestHash(candidates) {
  const normalized = candidates.map((candidate) => {
    const {
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      actorUid: _actorUid,
      actorName: _actorName,
      actorEmail: _actorEmail,
      ...stableCandidate
    } = candidate;
    return stripUndefinedDeep(stableCandidate);
  }).sort((left, right) => {
    const leftText = stableStringify(left);
    const rightText = stableStringify(right);
    if (leftText === rightText) return 0;
    return leftText < rightText ? -1 : 1;
  });
  return `sha256:${stableHash(normalized)}`;
}

async function saveCashflowChangeCandidates({
  db,
  tenantId,
  candidates,
  candidateManifestHash,
  stageAttemptId,
  runRef,
  requestHash,
  reservationExpiresAt,
}) {
  if (!db || candidates.length === 0) return { candidateCount: candidates.length, batchCommitCount: 0 };
  let batchCommitCount = 0;
  for (let offset = 0; offset < candidates.length; offset += 450) {
    const chunk = candidates.slice(offset, offset + 450);
    await db.runTransaction(async (transaction) => {
      const currentRunSnap = await transaction.get(runRef);
      const currentRun = currentRunSnap.exists ? (currentRunSnap.data() || {}) : {};
      if (
        readOptionalText(currentRun.status) !== 'STAGING'
        || readOptionalText(currentRun.requestHash) !== requestHash
        || readOptionalText(currentRun.stageAttemptId) !== stageAttemptId
        || readOptionalText(currentRun.candidateManifestHash) !== candidateManifestHash
        || readOptionalText(currentRun.reservationExpiresAt) !== reservationExpiresAt
      ) {
        throw createHttpError(
          409,
          '시트 검토 완료 상태가 변경되었습니다. 다시 확인해 주세요.',
          'cashflow_sheet_stage_completion_conflict',
        );
      }
      for (const candidate of chunk) {
        const id = `cfc_${stableHash({
          runId: candidate.runId,
          projectId: candidate.projectId,
          scope: candidate.scope,
          year: candidate.year,
          mode: candidate.mode,
          yearMonth: candidate.yearMonth,
          weekNo: candidate.weekNo,
          lineId: candidate.lineId,
          candidateManifestHash,
        }).slice(0, 32)}`;
        transaction.set(
          db.doc(`orgs/${tenantId}/${CASHFLOW_CHANGE_CANDIDATES_COLLECTION_ID}/${id}`),
          stripUndefinedDeep({ ...candidate, id, candidateManifestHash, stageAttemptId }),
        );
      }
    });
    batchCommitCount += 1;
  }
  return { candidateCount: candidates.length, batchCommitCount };
}

async function readCashflowChangeCandidatesByRun({ db, tenantId, projectId, runId }) {
  if (!db) return [];
  const run = await readCashflowSheetStageRun(db, tenantId, projectId, runId);
  const candidateManifestHash = readOptionalText(run.candidateManifestHash);
  const stageAttemptId = readOptionalText(run.stageAttemptId);
  const snap = await db.collection(`orgs/${tenantId}/${CASHFLOW_CHANGE_CANDIDATES_COLLECTION_ID}`)
    .where('runId', '==', runId)
    .get();
  const candidates = snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((candidate) => (
      readOptionalText(candidate.projectId) === readOptionalText(projectId)
      && readOptionalText(candidate.runId) === readOptionalText(runId)
      && readOptionalText(candidate.status || 'pending_review') === 'pending_review'
      && (!candidateManifestHash || readOptionalText(candidate.candidateManifestHash) === candidateManifestHash)
      && (!stageAttemptId || readOptionalText(candidate.stageAttemptId) === stageAttemptId)
    ));
  if (candidateManifestHash && candidates.length !== Number(run.stagedLineCount)) {
    throw createHttpError(
      409,
      '검토 후보 저장이 완전하지 않습니다. 시트 값을 다시 검토해 주세요.',
      'cashflow_sheet_stage_candidates_incomplete',
    );
  }
  return candidates;
}

async function markCashflowChangeCandidatesStatus({ db, tenantId, candidates, status, now }) {
  if (!db || candidates.length === 0) return;
  for (let offset = 0; offset < candidates.length; offset += 450) {
    const batch = db.batch();
    for (const candidate of candidates.slice(offset, offset + 450)) {
      batch.set(
        db.doc(`orgs/${tenantId}/${CASHFLOW_CHANGE_CANDIDATES_COLLECTION_ID}/${candidate.id}`),
        stripUndefinedDeep({
        status,
        updatedAt: now,
        appliedAt: status === 'applied' ? now : undefined,
        }),
        { merge: true },
      );
    }
    await batch.commit();
  }
}

async function readCashflowWeeksSnapshot(db, tenantId, projectId) {
  const snap = await db.collection(`orgs/${tenantId}/${CASHFLOW_WEEKS_COLLECTION_ID}`)
    .where('projectId', '==', projectId)
    .get();
  return {
    weeks: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  };
}

function canonicalCellEntriesFromWeeks(weeks = []) {
  const entries = [];
  for (const week of weeks) {
    const yearMonth = readOptionalText(week?.yearMonth);
    const weekNo = Number(week?.weekNo);
    for (const mode of ['projection', 'actual']) {
      const amounts = week?.[mode] && typeof week[mode] === 'object' ? week[mode] : {};
      for (const [cashflowLine, rawAmount] of Object.entries(amounts)) {
        const amount = Number(rawAmount);
        if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth)
          || !Number.isSafeInteger(weekNo) || weekNo < 1 || weekNo > 5
          || !CASHFLOW_LINE_ORDER.has(readOptionalText(cashflowLine)) || !Number.isSafeInteger(amount)) {
          throw createHttpError(502, 'Canonical cashflow snapshot is invalid.', 'cashflow_canonical_snapshot_invalid');
        }
        entries.push({ yearMonth, weekNo, mode, cashflowLine, state: amount === 0 ? 'ZERO' : 'VALUE', amount });
      }
    }
  }
  return entries.sort((left, right) => (
    left.yearMonth.localeCompare(right.yearMonth)
    || left.weekNo - right.weekNo
    || left.mode.localeCompare(right.mode)
    || left.cashflowLine.localeCompare(right.cashflowLine)
  ));
}

function canonicalWeeksFromJavaSnapshot(snapshot = {}) {
  if (Array.isArray(snapshot?.readModel?.months)) {
    return snapshot.readModel.months.flatMap((month) => ['projection', 'actual'].flatMap((mode) => (
      Array.isArray(month?.[mode]?.weeks) ? month[mode].weeks : []
    ).map((week) => ({
      yearMonth: month.yearMonth,
      weekNo: week.weekNo,
      [mode]: week.amounts || {},
    }))));
  }
  if (!Array.isArray(snapshot?.projection) || !Array.isArray(snapshot?.actual)) {
    throw createHttpError(502, 'JVM cashflow snapshot is invalid.', 'jvm_cashflow_snapshot_invalid');
  }
  const byWeek = new Map();
  const addLine = (mode, line) => {
    const yearMonth = readOptionalText(line?.yearMonth);
    const weekNo = Number(line?.weekNo);
    const cashflowLine = readOptionalText(line?.cashflowLine);
    const amount = Number(line?.amount);
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth)
      || !Number.isSafeInteger(weekNo) || weekNo < 1 || weekNo > 5
      || !CASHFLOW_LINE_ORDER.has(cashflowLine) || !Number.isSafeInteger(amount)) {
      throw createHttpError(502, 'JVM cashflow snapshot is invalid.', 'jvm_cashflow_snapshot_invalid');
    }
    const key = `${yearMonth}:${weekNo}`;
    const week = byWeek.get(key) || { yearMonth, weekNo, projection: {}, actual: {} };
    if (mode === 'actual') {
      week.actual[cashflowLine] = (week.actual[cashflowLine] || 0) + amount;
    } else if (Object.hasOwn(week.projection, cashflowLine)) {
      throw createHttpError(502, 'JVM projection snapshot contains duplicate cells.', 'jvm_cashflow_snapshot_invalid');
    } else {
      week.projection[cashflowLine] = amount;
    }
    byWeek.set(key, week);
  };
  snapshot.projection.forEach((line) => addLine('projection', line));
  snapshot.actual.forEach((line) => addLine('actual', line));
  return [...byWeek.values()];
}

function canonicalSheetSourceWeeksFromJavaSnapshot(snapshot = {}) {
  if (!Array.isArray(snapshot?.projection) || !Array.isArray(snapshot?.actual)) {
    return canonicalWeeksFromJavaSnapshot(snapshot);
  }
  const hasActualProvenance = snapshot.actual.some((line) => readOptionalText(line?.sheetKey));
  return canonicalWeeksFromJavaSnapshot({
    ...snapshot,
    actual: hasActualProvenance
      ? snapshot.actual.filter((line) => readOptionalText(line?.sheetKey) === CASHFLOW_SHEET_SOURCE_KEY)
      : snapshot.actual,
  });
}

export function assertJavaCashflowMatchesFirestore(javaSnapshot, firestoreSnapshot) {
  const javaCells = canonicalCellEntriesFromWeeks(canonicalWeeksFromJavaSnapshot(javaSnapshot));
  const firestoreCells = canonicalCellEntriesFromWeeks(firestoreSnapshot?.weeks || []);
  if (stableHash(javaCells) !== stableHash(firestoreCells)) {
    throw createHttpError(
      503,
      'JVM and Firestore cashflow snapshots do not match.',
      'jvm_cashflow_canonical_mismatch',
    );
  }
}

export function assertJavaCashflowReadbackMatchesAppliedMonths(
  javaSnapshot,
  stagedMonths,
  { projectId, resultingTargetRevision } = {},
) {
  if (
    readOptionalText(javaSnapshot?.projectId) !== readOptionalText(projectId)
    || !/^sha256:[a-f0-9]{64}$/.test(readOptionalText(resultingTargetRevision))
    || readOptionalText(javaSnapshot?.targetRevision) !== readOptionalText(resultingTargetRevision)
  ) {
    throw createHttpError(502, 'JVM canonical revision does not match the applied revision.', 'cashflow_jvm_readback_revision_mismatch');
  }
  const expected = new Map();
  for (const month of stagedMonths || []) {
    for (const cell of month?.cells || []) {
      const normalized = {
        sourceYear: Number(readOptionalText(month?.yearMonth).slice(0, 4)),
        yearMonth: readOptionalText(month?.yearMonth),
        weekNo: Number(cell?.weekNo),
        mode: readOptionalText(cell?.mode),
        cashflowLine: readOptionalText(cell?.cashflowLine),
        state: readOptionalText(cell?.cellState),
        ...(['VALUE', 'ZERO'].includes(readOptionalText(cell?.cellState)) ? { amount: Number(cell?.amount) } : {}),
      };
      const key = canonicalCellKey(normalized);
      if (
        !Number.isSafeInteger(normalized.sourceYear)
        || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(normalized.yearMonth)
        || !Number.isSafeInteger(normalized.weekNo) || normalized.weekNo < 1 || normalized.weekNo > 5
        || !CASHFLOW_MODES.includes(normalized.mode)
        || !CASHFLOW_LINE_ORDER.has(normalized.cashflowLine)
        || !['EMPTY', 'ZERO', 'VALUE'].includes(normalized.state)
        || (normalized.state !== 'EMPTY' && !Number.isSafeInteger(normalized.amount))
        || expected.has(key)
      ) {
        throw createHttpError(502, 'Staged cashflow readback contract is invalid.', 'cashflow_jvm_readback_contract_invalid');
      }
      expected.set(key, normalized);
    }
  }
  const expectedCellCount = (stagedMonths || []).length * CASHFLOW_MODES.length * 5 * CASHFLOW_ALL_LINES.length;
  if (expected.size !== expectedCellCount) {
    throw createHttpError(502, 'Staged cashflow readback contract is incomplete.', 'cashflow_jvm_readback_contract_invalid');
  }
  const actual = canonicalCellsFromSnapshot(
    { weeks: canonicalSheetSourceWeeksFromJavaSnapshot(javaSnapshot) },
    expected.keys(),
  );
  if (compareCanonicalCells(expected, actual, expected.keys()).changeCount !== 0) {
    throw createHttpError(502, 'JVM canonical readback does not match the staged sheet.', 'cashflow_jvm_readback_mismatch');
  }
  return expected.size;
}

function canonicalCellKey(cell) {
  return `${cell.sourceYear}:${cell.yearMonth}:${cell.weekNo}:${cell.mode}:${cell.cashflowLine}`;
}

function canonicalCellsFromSnapshot(snapshot, allowedKeys) {
  const entries = canonicalCellEntriesFromWeeks(snapshot?.weeks || []).map((cell) => ({
    ...cell,
    sourceYear: Number(cell.yearMonth.slice(0, 4)),
  }));
  const index = new Map(entries.map((cell) => [canonicalCellKey(cell), cell]));
  return new Map([...allowedKeys].map((key) => [key, index.get(key) || { state: 'EMPTY' }]));
}

function compareCanonicalCells(left, right, keys) {
  let projectionChangeCount = 0;
  let actualChangeCount = 0;
  for (const key of keys) {
    const leftCell = left.get(key) || { state: 'EMPTY' };
    const rightCell = right.get(key) || { state: 'EMPTY' };
    if (leftCell.state === rightCell.state
      && (leftCell.state === 'EMPTY' || leftCell.amount === rightCell.amount)) continue;
    if (key.includes(':projection:')) projectionChangeCount += 1;
    else actualChangeCount += 1;
  }
  return {
    status: 'AVAILABLE',
    changeCount: projectionChangeCount + actualChangeCount,
    projectionChangeCount,
    actualChangeCount,
  };
}

async function readCashflowSheetMirror(db, tenantId, projectId) {
  if (!db) {
    throw createHttpError(503, '불러온 시트 값을 읽을 수 없습니다. 담당자에게 문의해 주세요.', 'firestore_unconfigured');
  }
  const snap = await db.doc(cashflowSheetMirrorDocPath(tenantId, projectId)).get();
  return snap.exists ? snap.data() : null;
}

async function readCashflowSheetStageRun(db, tenantId, projectId, runId) {
  if (!/^cfstage_[a-f0-9]{32}$/.test(readOptionalText(runId))) {
    throw createHttpError(400, '유효한 시트 검토 runId가 필요합니다.', 'cashflow_sheet_stage_run_invalid');
  }
  const snap = await db.doc(`orgs/${tenantId}/${CASHFLOW_SHEET_STAGE_RUNS_COLLECTION_ID}/${runId}`).get();
  if (!snap.exists) {
    throw createHttpError(404, '시트 검토 run을 찾을 수 없습니다.', 'cashflow_sheet_stage_run_not_found');
  }
  const run = snap.data() || {};
  if (readOptionalText(run.projectId) !== readOptionalText(projectId)) {
    throw createHttpError(404, '시트 검토 run을 찾을 수 없습니다.', 'cashflow_sheet_stage_run_not_found');
  }
  return run;
}

function assertStageRunRequestMatches(run, requestHash) {
  if (readOptionalText(run?.requestHash) !== requestHash) {
    throw createHttpError(409, '같은 idempotencyKey에 다른 검토 요청을 사용할 수 없습니다.', 'idempotency_key_reused');
  }
}

function stageRunInProgressError() {
  return createHttpError(409, '같은 시트 검토 요청이 이미 처리 중입니다.', 'idempotency_request_in_progress');
}

const CASHFLOW_STAGE_RESPONSE_RUN_FIELDS = [
  'closedMonthDifferences',
  'closedMonthDifferenceCount',
  'closedMonthDifferenceManifestHash',
  'pendingApprovalDifferences',
  'pendingApprovalDifferenceCount',
  'pendingApprovalDifferenceManifestHash',
  'pendingApprovalContractIssues',
];

function compactCashflowSheetStageResponse(response) {
  const compact = { ...response };
  for (const field of CASHFLOW_STAGE_RESPONSE_RUN_FIELDS) delete compact[field];
  return compact;
}

function hydrateCashflowSheetStageResponse(run) {
  if (!run?.response || typeof run.response !== 'object' || Array.isArray(run.response)) return null;
  const response = { ...run.response };
  for (const field of CASHFLOW_STAGE_RESPONSE_RUN_FIELDS) {
    if (Object.hasOwn(run, field)) response[field] = run[field];
  }
  return response;
}

async function reserveCashflowSheetStageRun({ db, runRef, requestHash, reservation }) {
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(runRef);
    if (snap.exists) {
      const run = snap.data() || {};
      assertStageRunRequestMatches(run, requestHash);
      const response = hydrateCashflowSheetStageResponse(run);
      if (response) return response;
      const reservationExpiresAt = Date.parse(readOptionalText(run.reservationExpiresAt));
      if (readOptionalText(run.status) === 'STAGING' && reservationExpiresAt > Date.now()) {
        throw stageRunInProgressError();
      }
    }
    transaction.set(runRef, stripUndefinedDeep({
      ...reservation,
      requestHash,
      status: 'STAGING',
      failedAt: null,
      failure: null,
    }), { merge: true });
    return null;
  });
}

async function beginCashflowSheetRefreshRun({
  db,
  tenantId,
  projectId,
  idempotencyKey,
  requestHash,
  configRevision,
  attemptedAt,
  context,
}) {
  const runRef = db.doc(cashflowSheetRefreshRunDocPath(tenantId, projectId, idempotencyKey));
  const mirrorRef = db.doc(cashflowSheetMirrorDocPath(tenantId, projectId));
  const result = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(runRef);
    if (snap.exists) {
      const run = snap.data() || {};
      if (readOptionalText(run.requestHash) !== requestHash) {
        throw createHttpError(
          409,
          '같은 idempotencyKey에 다른 시트 연동 요청을 사용할 수 없습니다.',
          'idempotency_key_reused',
        );
      }
      if (run.response) return { replay: run.response, generation: null };
      throw createHttpError(
        409,
        '같은 시트 연동 요청이 이미 처리 중입니다.',
        'idempotency_request_in_progress',
      );
    }
    const mirrorSnap = await transaction.get(mirrorRef);
    const mirror = mirrorSnap.exists ? mirrorSnap.data() || {} : {};
    const generation = Math.max(0, Number(mirror.latestRefreshGeneration) || 0) + 1;
    transaction.set(mirrorRef, stripUndefinedDeep({
      schemaVersion: Number(mirror.schemaVersion) || 1,
      projectId,
      status: readOptionalText(mirror.status) || 'EMPTY',
      latestRefreshGeneration: generation,
      pendingRefreshConfigRevision: configRevision,
      lastRefreshAttemptAt: attemptedAt,
    }), { merge: true });
    transaction.set(runRef, stripUndefinedDeep({
      tenantId,
      projectId,
      idempotencyKey,
      requestHash,
      configRevision,
      generation,
      status: 'IN_PROGRESS',
      createdAt: attemptedAt,
      createdBy: {
        uid: readOptionalText(context?.actorId),
        name: readOptionalText(context?.actorName),
        email: readOptionalText(context?.actorEmail),
        role: readOptionalText(context?.actorRole) || 'workspace_user',
      },
    }));
    return { replay: null, generation };
  });
  return { runRef, ...result };
}

async function completeCashflowSheetRefreshRun({
  db,
  tenantId,
  projectId,
  runRef,
  requestHash,
  generation,
  response,
  completedAt,
}) {
  const mirrorRef = db.doc(cashflowSheetMirrorDocPath(tenantId, projectId));
  return db.runTransaction(async (transaction) => {
    const runSnap = await transaction.get(runRef);
    const mirrorSnap = await transaction.get(mirrorRef);
    const run = runSnap.exists ? runSnap.data() || {} : {};
    if (readOptionalText(run.requestHash) !== requestHash) {
      throw createHttpError(
        409,
        '시트 연동 멱등 실행 정보가 변경되었습니다.',
        'idempotency_key_reused',
      );
    }
    const runGeneration = Number(run.generation);
    if (!Number.isSafeInteger(runGeneration) || runGeneration !== Number(generation)) {
      throw createHttpError(409, '시트 연동 순서 정보가 변경되었습니다.', 'cashflow_sheet_refresh_generation_conflict');
    }
    const currentMirror = mirrorSnap.exists ? mirrorSnap.data() || {} : {};
    const currentGeneration = Math.max(0, Number(currentMirror.latestRefreshGeneration) || 0);
    const superseded = currentGeneration > runGeneration;
    const runId = readOptionalText(runRef?.id) || readOptionalText(runRef?.path).split('/').pop();
    const snapshotId = `cfsnap_${stableHash({ tenantId, projectId, runId, sourceRevision: response?.sourceRevision }).slice(0, 32)}`;
    const installedResponse = superseded ? currentMirror : stripUndefinedDeep({
      ...response,
      snapshotId,
      snapshotSchemaVersion: 2,
      latestRefreshGeneration: runGeneration,
      pendingRefreshConfigRevision: null,
    });
    if (!superseded) {
      transaction.set(mirrorRef, installedResponse);
      writeCashflowSheetReadModels({ transaction, db, tenantId, projectId, mirror: installedResponse });
    }
    transaction.set(runRef, stripUndefinedDeep({
      status: 'COMPLETED',
      completedAt,
      superseded,
      response: installedResponse,
    }), { merge: true });
    return installedResponse;
  });
}

function writeCashflowSheetReadModels({ transaction, db, tenantId, projectId, mirror }) {
  if (readOptionalText(mirror?.status) !== 'FRESH') return;
  const snapshotId = readOptionalText(mirror?.snapshotId);
  if (!/^cfsnap_[a-f0-9]{32}$/.test(snapshotId)) return;
  const capturedAt = readOptionalText(mirror?.capturedAt);
  const sourceRevision = readOptionalText(mirror?.sourceRevision);
  transaction.set(db.doc(cashflowSheetSnapshotDocPath(tenantId, snapshotId)), stripUndefinedDeep({
    schemaVersion: 2,
    snapshotId,
    tenantId,
    projectId,
    status: 'INSTALLED',
    spreadsheetId: readOptionalText(mirror?.spreadsheetId),
    spreadsheetTitle: readOptionalText(mirror?.spreadsheetTitle),
    selectedSheetName: readOptionalText(mirror?.selectedSheetName),
    configRevision: readOptionalText(mirror?.configRevision),
    sourceRevision,
    targetRevisionAtFetch: readOptionalText(mirror?.targetRevisionAtFetch),
    capturedAt,
    capturedBy: mirror?.capturedBy || {},
    yearMonths: mirror?.yearMonths || [],
    years: mirror?.years || [],
    summary: mirror?.summary || {},
    activeWeekRange: mirror?.activeWeekRange || {},
  }));
  const cellsByMonth = groupPinnedCellsByMonth(mirror?.cells || []);
  for (const [yearMonth, cells] of cellsByMonth) {
    transaction.set(db.doc(cashflowSheetSnapshotMonthDocPath(tenantId, snapshotId, yearMonth)), stripUndefinedDeep({
      schemaVersion: 2,
      snapshotId,
      tenantId,
      projectId,
      yearMonth,
      source: 'cashflow_sheet_refresh',
      sourceRevision,
      capturedAt,
      cells,
    }));
  }
  for (const total of mirror?.sheetFacts?.annualCashflowTotals || []) {
    if (!Number.isSafeInteger(total?.year)) continue;
    transaction.set(db.doc(cashflowSheetSnapshotYearDocPath(tenantId, snapshotId, total.year)), stripUndefinedDeep({
      schemaVersion: 2,
      snapshotId,
      tenantId,
      projectId,
      year: total.year,
      source: 'cashflow_sheet_refresh',
      sourceRevision,
      capturedAt,
      projection: total.projection,
      actual: total.actual,
      annualCells: (mirror?.annualCells || []).filter((cell) => Number(cell?.year) === total.year),
    }));
  }
}

function setFiniteAmount(index, mapping, amount) {
  if (typeof amount === 'number' && Number.isFinite(amount)) {
    index.set(cashflowMappingKey(mapping), amount);
  }
}

function buildSnapshotAmountIndex(snapshot) {
  const index = new Map();
  const weeks = Array.isArray(snapshot?.weeks) ? snapshot.weeks : [];
  for (const week of weeks) {
    const yearMonth = readOptionalText(week?.yearMonth);
    const weekNo = Number(week?.weekNo);
    if (!yearMonth || !Number.isFinite(weekNo)) continue;

    const projection = week?.projection && typeof week.projection === 'object' ? week.projection : {};
    for (const [lineId, amount] of Object.entries(projection)) {
      setFiniteAmount(index, { mode: 'projection', yearMonth, weekNo, lineId }, amount);
    }

    const hasActualProvenance = Object.prototype.hasOwnProperty.call(week || {}, 'weeklyExpenseActualBySheet');
    const actualBySource = hasActualProvenance && typeof week.weeklyExpenseActualBySheet === 'object'
      ? week.weeklyExpenseActualBySheet
      : {};
    const sourceActual = actualBySource[CASHFLOW_SHEET_SOURCE_KEY]
      && typeof actualBySource[CASHFLOW_SHEET_SOURCE_KEY] === 'object'
      ? actualBySource[CASHFLOW_SHEET_SOURCE_KEY]
      : {};
    // Legacy documents have no source ledger. Compare against their aggregate so
    // every overwrite or removal is surfaced in the explicit human review.
    const sheetActual = hasActualProvenance
      ? sourceActual
      : (week?.actual && typeof week.actual === 'object' ? week.actual : {});
    for (const [lineId, amount] of Object.entries(sheetActual)) {
      setFiniteAmount(index, { mode: 'actual', yearMonth, weekNo, lineId }, amount);
    }
  }

  return index;
}

function readIndexedSnapshotAmount(index, mapping) {
  if (!index) return null;
  const amount = index.get(cashflowMappingKey(mapping));
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
}

function hasIndexedSnapshotAmount(index, mapping) {
  return Boolean(index?.has(cashflowMappingKey(mapping)));
}

function groupPinnedCellsByMonth(cells = []) {
  const grouped = new Map();
  for (const cell of cells) {
    const yearMonth = readOptionalText(cell?.yearMonth);
    if (!yearMonth) continue;
    const monthCells = grouped.get(yearMonth) || [];
    monthCells.push(cell);
    grouped.set(yearMonth, monthCells);
  }
  return grouped;
}

function validateCompletePinnedMonth(yearMonth, cells = []) {
  const expectedWeekNumbers = getMonthFinanceWeeks(yearMonth).map((week) => Number(week.weekNo));
  if (expectedWeekNumbers.length !== 5) return { ok: false, reason: 'invalid_year_month' };
  const expectedWeekSet = new Set(expectedWeekNumbers);
  const keys = new Set();
  const weekNumbers = new Set();
  for (const cell of cells) {
    const mode = readOptionalText(cell?.mode);
    const lineId = readOptionalText(cell?.lineId);
    const weekNo = Number(cell?.weekNo);
    const state = readOptionalText(cell?.state);
    if (
      readOptionalText(cell?.yearMonth) !== yearMonth
      || !CASHFLOW_MODES.includes(mode)
      || !CASHFLOW_LINE_ORDER.has(lineId)
      || !Number.isInteger(weekNo)
      || !expectedWeekSet.has(weekNo)
      || !['VALUE', 'ZERO', 'EMPTY'].includes(state)
      || (['VALUE', 'ZERO'].includes(state) && !Number.isSafeInteger(cell?.amount))
      || (state === 'ZERO' && cell?.amount !== 0)
      || (state === 'EMPTY' && cell?.amount !== undefined)
    ) {
      return { ok: false, reason: 'invalid_cell' };
    }
    const key = `${mode}:${weekNo}:${lineId}`;
    if (keys.has(key)) return { ok: false, reason: 'duplicate_cell' };
    keys.add(key);
    weekNumbers.add(weekNo);
  }

  if (weekNumbers.size === 0) return { ok: false, reason: 'empty_month' };
  for (const weekNo of expectedWeekNumbers) {
    if (!weekNumbers.has(weekNo)) return { ok: false, reason: 'incomplete_month' };
    for (const mode of CASHFLOW_MODES) {
      for (const lineId of CASHFLOW_ALL_LINES) {
        if (!keys.has(`${mode}:${weekNo}:${lineId}`)) {
          return { ok: false, reason: 'incomplete_month' };
        }
      }
    }
  }
  if (keys.size !== expectedWeekNumbers.length * CASHFLOW_MODES.length * CASHFLOW_ALL_LINES.length) {
    return { ok: false, reason: 'unexpected_cell_count' };
  }

  return {
    ok: true,
    cells: [...cells]
      .sort((left, right) => (
        Number(left.weekNo) - Number(right.weekNo)
        || CASHFLOW_MODES.indexOf(left.mode) - CASHFLOW_MODES.indexOf(right.mode)
        || CASHFLOW_LINE_ORDER.get(left.lineId) - CASHFLOW_LINE_ORDER.get(right.lineId)
      ))
      .map((cell) => stripUndefinedDeep({
        mode: cell.mode,
        weekNo: Number(cell.weekNo),
        cashflowLine: cell.lineId,
        cellState: cell.state,
        amount: ['VALUE', 'ZERO'].includes(cell.state) ? cell.amount : undefined,
        sourceCell: readOptionalText(cell.sourceCell) || undefined,
        sourceLabel: readOptionalText(cell.sourceLabel) || cell.lineId,
      })),
  };
}

function validateCompletePinnedYear(year, cells = []) {
  if (!Number.isSafeInteger(year) || year < 2000 || year > 2099) return { ok: false, reason: 'invalid_year' };
  const keys = new Set();
  for (const cell of cells) {
    const mode = readOptionalText(cell?.mode);
    const lineId = readOptionalText(cell?.lineId);
    const state = readOptionalText(cell?.state);
    if (
      Number(cell?.year) !== year
      || !CASHFLOW_MODES.includes(mode)
      || !CASHFLOW_LINE_ORDER.has(lineId)
      || !['VALUE', 'ZERO', 'EMPTY'].includes(state)
      || (['VALUE', 'ZERO'].includes(state) && !Number.isSafeInteger(cell?.amount))
      || (state === 'ZERO' && cell?.amount !== 0)
      || (state === 'EMPTY' && cell?.amount !== undefined)
    ) return { ok: false, reason: 'invalid_cell' };
    const key = `${mode}:${lineId}`;
    if (keys.has(key)) return { ok: false, reason: 'duplicate_cell' };
    keys.add(key);
  }
  for (const mode of CASHFLOW_MODES) {
    for (const lineId of CASHFLOW_ALL_LINES) {
      if (!keys.has(`${mode}:${lineId}`)) return { ok: false, reason: 'incomplete_year' };
    }
  }
  if (keys.size !== CASHFLOW_MODES.length * CASHFLOW_ALL_LINES.length) {
    return { ok: false, reason: 'unexpected_cell_count' };
  }
  return {
    ok: true,
    cells: [...cells]
      .sort((left, right) => (
        CASHFLOW_MODES.indexOf(left.mode) - CASHFLOW_MODES.indexOf(right.mode)
        || CASHFLOW_LINE_ORDER.get(left.lineId) - CASHFLOW_LINE_ORDER.get(right.lineId)
      ))
      .map((cell) => stripUndefinedDeep({
        mode: cell.mode,
        cashflowLine: cell.lineId,
        cellState: cell.state,
        amount: ['VALUE', 'ZERO'].includes(cell.state) ? cell.amount : undefined,
        sourceCell: readOptionalText(cell.sourceCell) || undefined,
        sourceLabel: readOptionalText(cell.sourceLabel) || cell.lineId,
      })),
  };
}

function monthCalculationChecks(mirror, yearMonth) {
  const checks = Array.isArray(mirror?.sheetFacts?.weeklyCalculationChecks)
    ? mirror.sheetFacts.weeklyCalculationChecks.filter((check) => readOptionalText(check?.yearMonth) === yearMonth)
    : [];
  return checks.length === 10 ? checks : [];
}

function cashflowFormulaPreflightInput(mirror) {
  const sourceYear = Number(mirror?.sourceYear);
  if (!Number.isSafeInteger(sourceYear)) {
    throw createHttpError(409, '시트의 기준 연도를 확인할 수 없습니다. 시트 값을 다시 불러와 주세요.', 'cashflow_sheet_formula_evidence_incomplete');
  }
  const annualCells = [];
  const annualYears = [...new Set((mirror?.annualCells || []).map((cell) => Number(cell?.year)))]
    .filter(Number.isSafeInteger)
    .sort((left, right) => left - right);
  for (const year of annualYears) {
    const validated = validateCompletePinnedYear(
      year,
      (mirror.annualCells || []).filter((cell) => Number(cell?.year) === year),
    );
    if (!validated.ok) {
      throw createHttpError(409, `${year}년 연간 원장 행을 확인할 수 없습니다. 시트 값을 다시 불러와 주세요.`, 'cashflow_sheet_formula_evidence_incomplete');
    }
    annualCells.push(...validated.cells.map((cell) => stripUndefinedDeep({
      year,
      mode: cell.mode,
      cashflowLine: cell.cashflowLine,
      cellState: cell.cellState,
      amount: ['VALUE', 'ZERO'].includes(cell.cellState) ? cell.amount : undefined,
    })));
  }

  const fieldByKind = {
    deposit_total: 'depositTotal',
    withdrawal_total: 'withdrawalTotal',
    balance: 'balance',
  };
  const annualDerivedCells = (mirror?.annualDerivedCells || []).map((cell) => {
    const year = Number(cell?.year);
    const periodKind = readOptionalText(cell?.periodKind);
    const field = fieldByKind[readOptionalText(cell?.derivedKind)];
    const state = readOptionalText(cell?.state);
    const sourceCell = readOptionalText(cell?.sourceCell);
    if (
      !annualYears.includes(year)
      || !field
      || periodKind !== (year === sourceYear ? 'GRAND_TOTAL' : 'ANNUAL')
      || !CASHFLOW_MODES.includes(readOptionalText(cell?.mode))
      || !['VALUE', 'ZERO', 'EMPTY'].includes(state)
      || (['VALUE', 'ZERO'].includes(state) && !Number.isSafeInteger(cell?.amount))
      || !sourceCell || sourceCell.length > 20
    ) {
      throw createHttpError(409, '기존 검토본에는 연도별 합계·잔액 확인 정보가 없어 반영하지 않았습니다. 시트 양식이나 수식 오류는 아닙니다. 시트 값 다시 불러오기를 눌러 새 검토본을 만든 뒤 반영해 주세요.', 'cashflow_sheet_formula_evidence_incomplete');
    }
    return stripUndefinedDeep({
      year,
      periodKind,
      mode: cell.mode,
      field,
      amount: ['VALUE', 'ZERO'].includes(state) ? cell.amount : undefined,
      sourceCell,
    });
  });

  const expectedDerivedKeys = new Set(annualYears.flatMap((year) => (
    CASHFLOW_MODES.flatMap((mode) => Object.values(fieldByKind).map((field) => `${year}:${mode}:${field}`))
  )));
  const actualDerivedKeys = new Set(annualDerivedCells.map((cell) => `${cell.year}:${cell.mode}:${cell.field}`));
  if (
    annualDerivedCells.length !== expectedDerivedKeys.size
    || actualDerivedKeys.size !== expectedDerivedKeys.size
    || [...actualDerivedKeys].some((key) => !expectedDerivedKeys.has(key))
  ) {
    throw createHttpError(409, '기존 검토본의 연도별 합계·잔액 확인 정보가 완전하지 않아 반영하지 않았습니다. 시트 양식이나 수식 오류는 아닙니다. 시트 값 다시 불러오기를 눌러 새 검토본을 만든 뒤 반영해 주세요.', 'cashflow_sheet_formula_evidence_incomplete');
  }

  const cellsByMonth = groupPinnedCellsByMonth((mirror?.cells || [])
    .filter((cell) => Number(readOptionalText(cell?.yearMonth).slice(0, 4)) === sourceYear));
  const months = [];
  const yearMonths = [...cellsByMonth.keys()].sort();
  for (const yearMonth of yearMonths) {
    const validated = validateCompletePinnedMonth(yearMonth, cellsByMonth.get(yearMonth) || []);
    const calculationChecks = monthCalculationChecks(mirror, yearMonth);
    if (!validated.ok || calculationChecks.length !== 10) {
      throw createHttpError(409, `${yearMonth} 계산 근거를 확인할 수 없습니다. 시트 값을 다시 불러와 주세요.`, 'cashflow_sheet_formula_evidence_incomplete');
    }
    months.push({ yearMonth, cells: validated.cells, calculationChecks, apply: false });
  }
  return { sourceYear, annualCells, annualDerivedCells, months };
}

function stageMonthSnapshotDocument({ tenantId, projectId, runId, mirror, yearMonth, cells, calculationChecks, now }) {
  return stripUndefinedDeep({
    tenantId,
    projectId,
    runId,
    yearMonth,
    configRevision: mirror.configRevision,
    sourceRevision: mirror.sourceRevision,
    targetRevisionAtFetch: mirror.targetRevisionAtFetch,
    cells,
    calculationChecks,
    createdAt: now,
  });
}

function stageYearSnapshotDocument({ tenantId, projectId, runId, mirror, year, expectedRevision, cells, now }) {
  return stripUndefinedDeep({
    tenantId,
    projectId,
    runId,
    year,
    expectedRevision,
    configRevision: mirror.configRevision,
    sourceRevision: mirror.sourceRevision,
    targetRevisionAtFetch: mirror.targetRevisionAtFetch,
    cells,
    createdAt: now,
  });
}

async function readCashflowSheetStageMonth({ db, tenantId, projectId, runId, yearMonth }) {
  const snap = await db.doc(cashflowSheetStageMonthDocPath(tenantId, runId, yearMonth)).get();
  if (!snap.exists) {
    throw createHttpError(409, '검토 당시 고정한 월 시트 값을 찾을 수 없습니다.', 'cashflow_sheet_stage_month_missing');
  }
  const value = snap.data() || {};
  if (
    readOptionalText(value.projectId) !== readOptionalText(projectId)
    || readOptionalText(value.runId) !== readOptionalText(runId)
    || readOptionalText(value.yearMonth) !== readOptionalText(yearMonth)
  ) {
    throw createHttpError(409, '검토 당시 고정한 월 시트 값이 일치하지 않습니다.', 'cashflow_sheet_stage_month_mismatch');
  }
  return value;
}

async function readCashflowSheetStageYear({ db, tenantId, projectId, runId, year }) {
  const snap = await db.doc(cashflowSheetStageYearDocPath(tenantId, runId, year)).get();
  if (!snap.exists) {
    throw createHttpError(409, '검토 당시 고정한 연간 합계 값을 찾을 수 없습니다.', 'cashflow_sheet_stage_year_missing');
  }
  const value = snap.data() || {};
  if (
    readOptionalText(value.projectId) !== readOptionalText(projectId)
    || readOptionalText(value.runId) !== readOptionalText(runId)
    || Number(value.year) !== Number(year)
  ) {
    throw createHttpError(409, '검토 당시 고정한 연간 합계 값이 일치하지 않습니다.', 'cashflow_sheet_stage_year_mismatch');
  }
  return value;
}

async function readCanonicalClosedCashflowMonths({ db, tenantId, projectId, yearMonths }) {
  const closedMonths = new Set();
  const headSnap = await db.doc(`orgs/${tenantId}/cashflow_cumulative_close_heads/${projectId}`).get();
  const head = headSnap.exists ? headSnap.data() || {} : {};
  const closedThrough = readOptionalText(head.closedThrough);
  if (headSnap.exists && (
    readOptionalText(head.contractVersion) !== CASHFLOW_CUMULATIVE_CLOSE_CONTRACT
    || readOptionalText(head.tenantId) !== tenantId
    || readOptionalText(head.projectId) !== projectId
    || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(closedThrough)
    || !readOptionalText(head.rootHash).startsWith('sha256:')
    || !Number.isSafeInteger(Number(head.revision))
  )) {
    throw createHttpError(409, '누적 월 결산 범위가 표준 계약과 다릅니다.', 'cashflow_month_close_contract_invalid');
  }
  // 누적 head 가 있으면 그것이 잠금의 유일한 권위다. 월별 문서를 합집합으로 더하면
  // 회차 이름표(회차 월)가 데이터 월로 오해되어 아직 열린 달까지 잠긴다.
  if (headSnap.exists) {
    const authority = readCashflowCumulativeCloseAuthority(head, { tenantId, projectId });
    for (const yearMonth of yearMonths || []) {
      if (cashflowCumulativeMonthLocked(authority, yearMonth)) closedMonths.add(yearMonth);
    }
    return closedMonths;
  }
  // head 가 없는 레거시 프로젝트만 월별 문서로 판정한다.
  await Promise.all((yearMonths || []).map(async (yearMonth) => {
    const snap = await db.doc(`orgs/${tenantId}/monthly_closes/${projectId}-${yearMonth}`).get();
    if (!snap.exists) return;
    const close = snap.data() || {};
    const legacyOpen = !Object.hasOwn(close, 'contractVersion') && readOptionalText(close.status) === 'OPEN';
    if (
      (!legacyOpen && readOptionalText(close.contractVersion) !== 'cashflow-month-close-v1')
      || readOptionalText(close.tenantId) !== tenantId
      || readOptionalText(close.projectId) !== projectId
      || readOptionalText(close.yearMonth) !== yearMonth
      || !['OPEN', 'CLOSED', 'REOPEN_REQUESTED'].includes(readOptionalText(close.status))
    ) {
      throw createHttpError(
        409,
        `${yearMonth} 월 결산 상태가 표준 계약과 다릅니다. 관리자에게 확인해 주세요.`,
        'cashflow_month_close_contract_invalid',
      );
    }
    if (close.status === 'CLOSED') closedMonths.add(yearMonth);
  }));
  return closedMonths;
}

function sortMonthDifferenceChanges(changes) {
  return [...changes].sort((left, right) => (
    left.weekNo - right.weekNo
    || String(left.mode).localeCompare(String(right.mode))
    || String(left.lineId).localeCompare(String(right.lineId))
  ));
}

function buildPinnedSheetChangeCandidates({ tenantId, projectId, runId, mirror, cashflowSnapshot, closedMonths = new Set(), context, now }) {
  const amountIndex = buildSnapshotAmountIndex(cashflowSnapshot);
  const weekIndex = new Map((cashflowSnapshot?.weeks || []).map((week) => [`${week.yearMonth}:${week.weekNo}`, week]));
  const blockedMonths = new Set((mirror?.cells || [])
    .filter((cell) => cell.state === 'INVALID')
    .map((cell) => readOptionalText(cell.yearMonth))
    .filter(Boolean));
  for (const [yearMonth, cells] of groupPinnedCellsByMonth(mirror?.cells || [])) {
    if (!validateCompletePinnedMonth(yearMonth, cells).ok) blockedMonths.add(yearMonth);
  }
  const closedDifferences = (mirror?.cells || []).filter((cell) => {
    if (!closedMonths.has(readOptionalText(cell?.yearMonth))) return false;
    if (!['VALUE', 'ZERO', 'EMPTY'].includes(cell?.state)) return false;
    const mapping = {
      mode: cell.mode,
      yearMonth: cell.yearMonth,
      weekNo: cell.weekNo,
      lineId: cell.lineId,
    };
    const beforeHadValue = hasIndexedSnapshotAmount(amountIndex, mapping);
    const proposedHadValue = ['VALUE', 'ZERO'].includes(cell.state);
    if (beforeHadValue !== proposedHadValue) return true;
    if (!proposedHadValue) return false;
    return normalizeAppliedAmount(readIndexedSnapshotAmount(amountIndex, mapping))
      !== normalizeAppliedAmount(cell.amount);
  });
  const closedMonthDifferenceMap = new Map();
  for (const cell of closedDifferences) {
    const yearMonth = readOptionalText(cell.yearMonth);
    const summary = closedMonthDifferenceMap.get(yearMonth) || {
      yearMonth,
      differenceCount: 0,
      weeks: new Set(),
      changes: [],
    };
    summary.differenceCount += 1;
    summary.weeks.add(Number(cell.weekNo));
    const mapping = {
      mode: cell.mode,
      yearMonth: cell.yearMonth,
      weekNo: cell.weekNo,
      lineId: cell.lineId,
    };
    const beforeHadValue = hasIndexedSnapshotAmount(amountIndex, mapping);
    summary.changes.push({
      mode: cell.mode,
      weekNo: Number(cell.weekNo),
      lineId: cell.lineId,
      beforeHadValue,
      beforeAmount: beforeHadValue ? normalizeAppliedAmount(readIndexedSnapshotAmount(amountIndex, mapping)) : null,
      afterHadValue: ['VALUE', 'ZERO'].includes(cell.state),
      afterAmount: ['VALUE', 'ZERO'].includes(cell.state) ? normalizeAppliedAmount(cell.amount) : null,
    });
    closedMonthDifferenceMap.set(yearMonth, summary);
  }
  const closedMonthDifferences = [...closedMonthDifferenceMap.values()]
    .map((summary) => ({
      yearMonth: summary.yearMonth,
      differenceCount: summary.differenceCount,
      weeks: [...summary.weeks].filter(Number.isSafeInteger).sort((left, right) => left - right),
      changes: sortMonthDifferenceChanges(summary.changes),
      truncatedChangeCount: 0,
    }))
    .sort((left, right) => left.yearMonth.localeCompare(right.yearMonth));
  const riskLineCount = closedDifferences.length;
  const nonWritableMonths = blockedMonths;

  const candidates = (mirror?.cells || [])
    .filter((cell) => !nonWritableMonths.has(readOptionalText(cell.yearMonth)))
    .filter((cell) => ['VALUE', 'ZERO', 'EMPTY'].includes(cell.state))
    .map((cell) => {
      const mapping = {
        mode: cell.mode,
        yearMonth: cell.yearMonth,
        weekNo: cell.weekNo,
        lineId: cell.lineId,
      };
      const beforeHadValue = hasIndexedSnapshotAmount(amountIndex, mapping);
      const beforeAmount = beforeHadValue ? normalizeAppliedAmount(readIndexedSnapshotAmount(amountIndex, mapping)) : null;
      const proposedHadValue = ['VALUE', 'ZERO'].includes(cell.state);
      const proposedAmount = proposedHadValue ? normalizeAppliedAmount(cell.amount) : null;
      // 값이 같으면 후보가 아니다. 전체 교체 모드여도 마찬가지다 - 바뀌지 않은 셀을
      // JVM 에 쓰면 잠긴 달에서 사유를 요구받고, 그 사유는 조직에 경고로 기록된다.
      // 바뀐 것이 없는데 경고가 남으면 담당자가 하지 않은 일을 한 것으로 남는다.
      if (beforeHadValue === proposedHadValue && (!proposedHadValue || beforeAmount === proposedAmount)) return null;

      const week = weekIndex.get(`${cell.yearMonth}:${cell.weekNo}`);
      const riskFlags = closedMonths.has(readOptionalText(cell.yearMonth)) ? ['closed_month_change'] : [];
      return {
        tenantId,
        projectId,
        runId,
        source: 'google_sheet',
        sourceRevision: mirror.sourceRevision,
        targetRevisionAtFetch: mirror.targetRevisionAtFetch,
        status: 'pending_review',
        mode: cell.mode,
        yearMonth: cell.yearMonth,
        weekNo: cell.weekNo,
        lineId: cell.lineId,
        lineDirection: cell.direction === 'IN' ? 'in' : 'out',
        beforeAmount,
        beforeHadValue,
        proposedAmount,
        proposedHadValue,
        cellState: cell.state,
        sourceCell: cell.sourceCell,
        sourceLabel: cell.sourceLabel,
        riskFlags,
        actorUid: readOptionalText(context?.actorId),
        actorName: readOptionalText(context?.actorEmail) || readOptionalText(context?.actorId),
        actorEmail: readOptionalText(context?.actorEmail),
        createdAt: now,
        updatedAt: now,
      };
    })
    .filter(Boolean);

  return {
    candidates,
    blockedMonths: [...blockedMonths].sort(),
    riskLineCount,
    closedMonthDifferences,
  };
}

function summarizeCandidateMonthDifferences(candidates, yearMonths = []) {
  const requiredMonths = new Set((Array.isArray(yearMonths) ? yearMonths : [yearMonths])
    .map(readOptionalText)
    .filter(Boolean));
  const summaries = new Map();
  for (const candidate of candidates) {
    const candidateMonth = readOptionalText(candidate?.yearMonth);
    if (!candidateMonth || (requiredMonths.size > 0 && !requiredMonths.has(candidateMonth))) continue;
    const summary = summaries.get(candidateMonth) || { yearMonth: candidateMonth, differenceCount: 0, weeks: new Set(), changes: [] };
    summary.differenceCount += 1;
    if (Number.isSafeInteger(Number(candidate?.weekNo))) summary.weeks.add(Number(candidate.weekNo));
    summary.changes.push({
      mode: candidate.mode,
      weekNo: Number(candidate.weekNo),
      lineId: candidate.lineId,
      beforeHadValue: Boolean(candidate.beforeHadValue),
      beforeAmount: candidate.beforeHadValue ? candidate.beforeAmount : null,
      afterHadValue: Boolean(candidate.proposedHadValue),
      afterAmount: candidate.proposedHadValue ? candidate.proposedAmount : null,
    });
    summaries.set(candidateMonth, summary);
  }
  return [...summaries.values()].map((summary) => ({
    yearMonth: summary.yearMonth,
    differenceCount: summary.differenceCount,
    weeks: [...summary.weeks].sort((left, right) => left - right),
    changes: sortMonthDifferenceChanges(summary.changes),
    truncatedChangeCount: 0,
  })).sort((left, right) => left.yearMonth.localeCompare(right.yearMonth));
}

async function buildPinnedAnnualChangeCandidates({
  db,
  tenantId,
  projectId,
  runId,
  mirror,
  context,
  now,
}) {
  const weeklyYear = Number(mirror?.sheetContract?.weeklyYear ?? mirror?.weeklyYear);
  const contractAnnualYears = Array.isArray(mirror?.sheetContract?.annualYears)
    ? mirror.sheetContract.annualYears.map(Number).filter(Number.isSafeInteger)
    : [];
  const annualYears = [...new Set((mirror?.annualCells || [])
    .map((cell) => Number(cell?.year))
    .filter((year) => Number.isSafeInteger(year)
      && (contractAnnualYears.length === 0 || contractAnnualYears.includes(year))
      && year !== weeklyYear))].sort((left, right) => left - right);
  const documents = [];
  const candidates = [];
  for (const year of annualYears) {
    const sourceCells = (mirror?.annualCells || []).filter((cell) => Number(cell?.year) === year);
    const validated = validateCompletePinnedYear(year, sourceCells);
    if (!validated.ok) {
      throw createHttpError(
        409,
        `${year}년 연간 합계가 Projection·Actual 전체 항목을 충족하지 않습니다. 시트 구조를 확인해 주세요.`,
        'cashflow_sheet_annual_incomplete',
      );
    }
    const current = await readCanonicalAnnualTotal(db, tenantId, projectId, year);
    const expectedRevision = Math.max(0, Number(current?.revision) || 0);
    const yearCandidates = validated.cells.map((cell) => {
      const beforeState = readOptionalText(current?.[cell.mode]?.lineStates?.[cell.cashflowLine]) || 'EMPTY';
      const beforeHadValue = ['VALUE', 'ZERO'].includes(beforeState);
      const beforeAmount = beforeHadValue
        ? normalizeAppliedAmount(current?.[cell.mode]?.lineAmounts?.[cell.cashflowLine])
        : null;
      const proposedHadValue = ['VALUE', 'ZERO'].includes(cell.cellState);
      const proposedAmount = proposedHadValue ? normalizeAppliedAmount(cell.amount) : null;
      // 위와 같다. 연간 셀도 값이 같으면 후보가 아니다.
      if (beforeState === cell.cellState && (!proposedHadValue || beforeAmount === proposedAmount)) {
        return null;
      }
      return {
        tenantId,
        projectId,
        runId,
        scope: 'annual',
        year,
        source: 'google_sheet',
        sourceRevision: mirror.sourceRevision,
        targetRevisionAtFetch: mirror.targetRevisionAtFetch,
        status: 'pending_review',
        mode: cell.mode,
        lineId: cell.cashflowLine,
        lineDirection: CASHFLOW_IN_LINES.includes(cell.cashflowLine) ? 'in' : 'out',
        beforeAmount,
        beforeHadValue,
        beforeCellState: beforeState,
        proposedAmount,
        proposedHadValue,
        cellState: cell.cellState,
        sourceCell: cell.sourceCell,
        sourceLabel: cell.sourceLabel,
        riskFlags: [],
        actorUid: readOptionalText(context?.actorId),
        actorName: readOptionalText(context?.actorEmail) || readOptionalText(context?.actorId),
        actorEmail: readOptionalText(context?.actorEmail),
        createdAt: now,
        updatedAt: now,
      };
    }).filter(Boolean);
    if (yearCandidates.length === 0) continue;
    candidates.push(...yearCandidates);
    documents.push(stageYearSnapshotDocument({
      tenantId,
      projectId,
      runId,
      mirror,
      year,
      expectedRevision,
      cells: validated.cells,
      now,
    }));
  }
  return { candidates, documents, stagedYears: documents.map((document) => document.year) };
}

function normalizeAppliedAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.trunc(amount) : 0;
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function cumulativeCloseMonths(fromMonth, throughMonth) {
  if (fromMonth !== CASHFLOW_CUMULATIVE_CLOSE_FROM_MONTH
    || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(throughMonth)) return [];
  return monthsBetween(fromMonth, throughMonth);
}

function pendingApprovalEvidenceError(message = '결재 중인 누적 결산 근거가 변경되었거나 완전하지 않습니다.') {
  return createHttpError(409, message, 'cashflow_pending_approval_evidence_stale');
}

function buildPendingApprovalAffectedMonths(differences = []) {
  const byMonth = new Map();
  for (const difference of differences) {
    const yearMonth = readOptionalText(difference?.yearMonth);
    if (!yearMonth) continue;
    const month = byMonth.get(yearMonth) || { yearMonth, warningCountIncrement: 1, differenceCount: 0, approvalDifferences: [] };
    month.differenceCount += Number(difference.differenceCount) || 0;
    month.approvalDifferences.push(difference);
    byMonth.set(yearMonth, month);
  }
  return [...byMonth.values()].sort((left, right) => left.yearMonth.localeCompare(right.yearMonth));
}

function pendingApprovalIssueMonths(request, candidates) {
  const candidateMonths = [...new Set(candidates
    .map((candidate) => readOptionalText(candidate.yearMonth))
    .filter((yearMonth) => /^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth)))].sort();
  const throughMonth = readCashflowCumulativeCloseScope(request).throughMonth;
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(throughMonth)) return candidateMonths;
  return candidateMonths.filter((yearMonth) => yearMonth <= throughMonth);
}

function pendingApprovalContractIssue({ request, candidates, blockAllCandidates = false }) {
  const blockedMonths = pendingApprovalIssueMonths(request, candidates);
  const throughMonth = readCashflowCumulativeCloseScope(request).throughMonth;
  return {
    requestId: readOptionalText(request?.requestId) || 'unknown',
    yearMonth: readOptionalText(request?.yearMonth) || undefined,
    blockedMonths,
    blockAllCandidates: Boolean(blockAllCandidates || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(throughMonth)),
    reasonCode: 'cashflow_pending_approval_contract_unsupported',
    message: '시트 양식은 정상입니다. 기존 결재 요청의 근거 형식을 확인할 수 없어 해당 월은 반영하지 않았습니다. 결재 요청을 확인한 뒤 다시 시도해 주세요.',
  };
}

async function readPendingApprovalDifferences({ db, tenantId, projectId, candidates = [] }) {
  const requestSnapshot = await db.collection(`orgs/${tenantId}/cashflow_month_close_requests`)
    .where('projectId', '==', projectId)
    .get();
  const requests = requestSnapshot.docs
    .map((doc) => doc.data() || {})
    .filter((request) => CASHFLOW_ACTIVE_CLOSE_REQUEST_STATUSES.has(readOptionalText(request.status)))
    .sort((left, right) => readOptionalText(left.requestId).localeCompare(readOptionalText(right.requestId)));
  const evidence = [];
  const differences = [];
  const contractIssues = [];
  for (const request of requests) {
    const requestId = readOptionalText(request.requestId);
    const revision = Number(request.revision);
    const scope = readCashflowCumulativeCloseScope(request);
    const fromMonth = scope.fromMonth;
    const cycleYearMonth = scope.cycleYearMonth;
    const throughMonth = scope.throughMonth;
    const months = cumulativeCloseMonths(fromMonth, throughMonth);
    const incompleteHeader = (
      scope.contractVersion !== CASHFLOW_CUMULATIVE_CLOSE_CONTRACT
      || readOptionalText(request.projectId) !== projectId
      || !requestId
      || !Number.isSafeInteger(revision)
      || revision < 1
      || fromMonth !== CASHFLOW_CUMULATIVE_CLOSE_FROM_MONTH
      || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(cycleYearMonth)
      || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(throughMonth)
      || (scope.strictRange && throughMonth !== previousYearMonth(cycleYearMonth))
      || months.length === 0
      || Number(request.monthCount) !== months.length
      || Number(request.weekCount) !== months.length * 5
      || Number(request.cellCount) !== months.length * 160
    );
    if (incompleteHeader) {
      contractIssues.push(pendingApprovalContractIssue({ request, candidates }));
      continue;
    }
    let shards;
    let manifestHash;
    try {
      shards = await Promise.all(months.map(async (yearMonth) => {
        const snapshot = await db.doc(
          `orgs/${tenantId}/cashflow_month_close_request_months/${requestId}-r${revision}-${yearMonth}`,
        ).get();
        const shard = snapshot.exists ? snapshot.data() || {} : null;
        const cells = Array.isArray(shard?.cells) ? shard.cells : [];
        const expectedKeys = ['projection', 'actual'].flatMap((mode) => Array.from({ length: 5 }, (_unused, weekIndex) => (
          CASHFLOW_ALL_LINES.map((lineId) => `${mode}|${weekIndex + 1}|${lineId}`)
        )).flat());
        const actualKeys = cells.map((cell) => `${readOptionalText(cell.mode)}|${Number(cell.weekNo)}|${readOptionalText(cell.cashflowLine)}`);
        const validCells = cells.length === 160 && actualKeys.every((key, index) => key === expectedKeys[index])
          && cells.every((cell) => (
            ['EMPTY', 'ZERO', 'VALUE'].includes(readOptionalText(cell.cellState))
            && (cell.cellState === 'EMPTY'
              ? cell.amount === null
              : Number.isSafeInteger(Number(cell.amount))
                && (cell.cellState === 'ZERO' ? Number(cell.amount) === 0 : Number(cell.amount) !== 0))
          ));
        if (
          !shard
          || shard.contractVersion !== CASHFLOW_CUMULATIVE_CLOSE_CONTRACT
          || readOptionalText(shard.requestId) !== requestId
          || Number(shard.requestRevision) !== revision
          || readOptionalText(shard.projectId) !== projectId
          || readOptionalText(shard.yearMonth) !== yearMonth
          || !validCells
        ) throw pendingApprovalEvidenceError(`결재 중인 누적 결산 ${yearMonth} 근거 구조가 완전하지 않습니다.`);
        const { shardHash, ...base } = shard;
        if (readOptionalText(shardHash) !== cashflowCloseHash(base)) {
          throw pendingApprovalEvidenceError(`결재 중인 누적 결산 ${yearMonth} 근거 hash가 일치하지 않습니다.`);
        }
        return shard;
      }));
      const manifest = {
        contractVersion: CASHFLOW_CUMULATIVE_CLOSE_CONTRACT,
        requestId,
        requestRevision: revision,
        projectId,
        fromMonth,
        yearMonth: cycleYearMonth,
        months: shards.map((shard) => ({ yearMonth: shard.yearMonth, shardHash: shard.shardHash })),
      };
      manifestHash = cashflowCloseHash(manifest);
      if (manifestHash !== readOptionalText(request.manifestHash)) {
        throw pendingApprovalEvidenceError('결재 중인 누적 결산 manifest hash가 일치하지 않습니다.');
      }
    } catch (error) {
      if (readOptionalText(error?.code) !== 'cashflow_pending_approval_evidence_stale') throw error;
      contractIssues.push(pendingApprovalContractIssue({ request, candidates }));
      continue;
    }
    evidence.push({
      requestId,
      status: request.status,
      revision,
      manifestHash,
      fromMonth,
      yearMonth: cycleYearMonth,
      monthCount: months.length,
    });
    const shardByMonth = new Map(shards.map((shard) => [shard.yearMonth, shard]));
    for (const yearMonth of months) {
      const candidateByKey = new Map(candidates
        .filter((candidate) => readOptionalText(candidate.scope) !== 'annual' && readOptionalText(candidate.yearMonth) === yearMonth)
        .map((candidate) => [`${candidate.mode}|${candidate.weekNo}|${candidate.lineId}`, candidate]));
      const changes = shardByMonth.get(yearMonth).cells.flatMap((cell) => {
        const candidate = candidateByKey.get(`${cell.mode}|${cell.weekNo}|${cell.cashflowLine}`);
        if (!candidate) return [];
        const beforeHadValue = cell.cellState !== 'EMPTY';
        const afterState = readOptionalText(candidate.cellState);
        const afterHadValue = ['VALUE', 'ZERO'].includes(afterState);
        const beforeAmount = beforeHadValue ? Number(cell.amount) : null;
        const afterAmount = afterHadValue ? Number(candidate.proposedAmount) : null;
        if (cell.cellState === afterState && beforeAmount === afterAmount) return [];
        return [{
          mode: cell.mode,
          weekNo: cell.weekNo,
          lineId: cell.cashflowLine,
          beforeHadValue,
          beforeState: cell.cellState,
          beforeAmount,
          afterHadValue,
          afterState,
          afterAmount,
        }];
      });
      if (changes.length > 0) {
        differences.push({
          requestId,
          requestRevision: revision,
          requestStatus: request.status,
          requestManifestHash: manifestHash,
          yearMonth,
          differenceCount: changes.length,
          weeks: [...new Set(changes.map((change) => change.weekNo))],
          changes,
          truncatedChangeCount: 0,
        });
      }
    }
  }
  return {
    evidence,
    differences,
    contractIssues,
    blockedMonths: [...new Set(contractIssues.flatMap((issue) => issue.blockedMonths || []))].sort(),
    blockAllCandidates: contractIssues.some((issue) => issue.blockAllCandidates),
    differenceCount: differences.reduce((sum, difference) => sum + difference.differenceCount, 0),
    manifestHash: contractIssues.length > 0
      ? `sha256:${stableHash({ differences, contractIssues })}`
      : `sha256:${stableHash(differences)}`,
  };
}

function assertApplyRequestMatches(stageRun, applyRequestHash) {
  if (readOptionalText(stageRun.applyRequestHash) !== readOptionalText(applyRequestHash)) {
    throw createHttpError(409, '다른 최종 반영 요청이 이미 이 검토본을 사용 중입니다.', 'cashflow_sheet_apply_in_progress');
  }
}

async function reserveCashflowSheetApply({
  db,
  tenantId,
  projectId,
  stagedRunId,
  idempotencyKey,
  applyRequestHash,
  applyInput,
  replaceAllActualSources = false,
  now,
}) {
  const runRef = db.doc(`orgs/${tenantId}/${CASHFLOW_SHEET_STAGE_RUNS_COLLECTION_ID}/${stagedRunId}`);
  const mirrorRef = db.doc(cashflowSheetMirrorDocPath(tenantId, projectId));
  const publicationRef = db.doc(`orgs/${tenantId}/cashflow_sheet_publications/${projectId}`);
  const result = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(runRef);
    if (!snap.exists) {
      throw createHttpError(404, '시트 검토 run을 찾을 수 없습니다.', 'cashflow_sheet_stage_run_not_found');
    }
    const stageRun = snap.data() || {};
    if (readOptionalText(stageRun.projectId) !== readOptionalText(projectId)) {
      throw createHttpError(404, '시트 검토 run을 찾을 수 없습니다.', 'cashflow_sheet_stage_run_not_found');
    }
    const publicationSnap = await transaction.get(publicationRef);
    const publication = publicationSnap.exists ? (publicationSnap.data() || {}) : {};
    const status = readOptionalText(stageRun.status);
    if (status === 'APPLIED') {
      assertApplyRequestMatches(stageRun, applyRequestHash);
      const replay = appliedCashflowSheetResponse(stageRun, publication, {
        projectId,
        stagedRunId,
        applyRequestHash,
      });
      if (replay) return { replay, resume: false, stageRun };
      throw createHttpError(409, '이미 반영된 시트 검토 run의 완료 근거가 일치하지 않습니다.', 'cashflow_sheet_stage_run_applied');
    }
    if (
      readOptionalText(publication.status).toUpperCase() === 'APPLYING'
      && readOptionalText(publication.stagedRunId) !== stagedRunId
    ) {
      throw createHttpError(
        409,
        '이 프로젝트의 다른 시트 반영 작업이 진행 중입니다.',
        'cashflow_sheet_apply_in_progress',
      );
    }
    if (status === 'APPLYING') {
      assertApplyRequestMatches(stageRun, applyRequestHash);
      transaction.set(publicationRef, stripUndefinedDeep({
        projectId,
        status: 'APPLYING',
        stagedRunId,
        sourceRevision: stageRun.sourceRevision,
        targetRevisionAtFetch: stageRun.targetRevisionAtFetch,
        applyStartedAt: readOptionalText(stageRun.applyStartedAt) || now,
      }), { merge: true });
      return { replay: null, resume: true, stageRun };
    }
    if (status !== 'READY') {
      throw createHttpError(409, '반영 가능한 상태의 시트 검토 run이 아닙니다.', 'cashflow_sheet_stage_run_blocked');
    }
    const mirrorSnap = await transaction.get(mirrorRef);
    if (!mirrorSnap.exists) {
      throw createHttpError(409, '시트 고정본을 찾을 수 없습니다. 최신값을 다시 가져와 주세요.', 'cashflow_sheet_mirror_required');
    }
    const mirror = mirrorSnap.data() || {};
    assertFreshCashflowSheetMirror(mirror);
    if (
      readOptionalText(mirror.configRevision) !== readOptionalText(stageRun.configRevision)
      || readOptionalText(mirror.sourceRevision) !== readOptionalText(stageRun.sourceRevision)
      || readOptionalText(mirror.targetRevisionAtFetch) !== readOptionalText(stageRun.targetRevisionAtFetch)
    ) {
      throw createHttpError(409, '검토 후 시트 고정본이 변경되었습니다. 다시 검토해 주세요.', 'cashflow_sheet_mirror_revision_conflict');
    }
    transaction.set(runRef, stripUndefinedDeep({
      status: 'APPLYING',
      applyStartedAt: now,
      appliedIdempotencyKey: idempotencyKey,
      applyRequestHash,
      applyInput,
    }), { merge: true });
    transaction.set(publicationRef, stripUndefinedDeep({
      projectId,
      status: 'APPLYING',
      stagedRunId,
      sourceRevision: stageRun.sourceRevision,
      targetRevisionAtFetch: stageRun.targetRevisionAtFetch,
      applyStartedAt: now,
      appliedAt: null,
    }), { merge: true });
    return {
      replay: null,
      resume: false,
      stageRun: {
        ...stageRun,
        status: 'APPLYING',
        applyStartedAt: now,
        appliedIdempotencyKey: idempotencyKey,
        applyRequestHash,
      },
    };
  });
  return { ...result, runRef, publicationRef };
}

async function readCashflowSheetApplyStatus({ db, tenantId, projectId, nowMs = Date.now() }) {
  await releaseExpiredCashflowSheetApplyLease({ db, tenantId, projectId, nowMs });
  const publicationRef = db.doc(`orgs/${tenantId}/cashflow_sheet_publications/${projectId}`);
  const publicationSnap = await publicationRef.get();
  const publication = publicationSnap.exists ? (publicationSnap.data() || {}) : {};
  if (readOptionalText(publication.status).toUpperCase() !== 'APPLYING') {
    return { projectId, status: 'IDLE', stagedRun: null, applyInput: null };
  }
  const stagedRunId = readOptionalText(publication.stagedRunId);
  if (!stagedRunId) {
    throw createHttpError(
      409,
      '시트 반영 상태에 검토 run 정보가 없습니다. 관리자 확인이 필요합니다.',
      'cashflow_sheet_apply_recovery_invalid',
    );
  }
  const runSnap = await db.doc(`orgs/${tenantId}/${CASHFLOW_SHEET_STAGE_RUNS_COLLECTION_ID}/${stagedRunId}`).get();
  const stageRunDocument = runSnap.exists ? (runSnap.data() || {}) : {};
  if (
    readOptionalText(stageRunDocument.projectId) !== readOptionalText(projectId)
    || readOptionalText(stageRunDocument.status) !== 'APPLYING'
  ) {
    throw createHttpError(
      409,
      '진행 중인 시트 반영의 검토본을 확인할 수 없습니다. 관리자 확인이 필요합니다.',
      'cashflow_sheet_apply_recovery_invalid',
    );
  }
  const persistedStageResponse = hydrateCashflowSheetStageResponse(stageRunDocument);
  const stagedRun = persistedStageResponse || {
    ok: true,
    commandName: 'cashflowSheetLab.stage.firebase',
    projectId,
    runId: stagedRunId,
    status: 'READY',
    stagedLineCount: Number(stageRunDocument.stagedLineCount) || 0,
    projectionLineCount: Number(stageRunDocument.projectionLineCount) || 0,
    actualLineCount: Number(stageRunDocument.actualLineCount) || 0,
    riskLineCount: Number(stageRunDocument.riskLineCount) || 0,
    closedMonthDifferences: Array.isArray(stageRunDocument.closedMonthDifferences) ? stageRunDocument.closedMonthDifferences : [],
    closedMonthDifferenceCount: Number(stageRunDocument.closedMonthDifferenceCount) || 0,
    closedMonthDifferenceManifestHash: readOptionalText(stageRunDocument.closedMonthDifferenceManifestHash),
    pendingApprovalDifferences: Array.isArray(stageRunDocument.pendingApprovalDifferences) ? stageRunDocument.pendingApprovalDifferences : [],
    pendingApprovalDifferenceCount: Number(stageRunDocument.pendingApprovalDifferenceCount) || 0,
    pendingApprovalDifferenceManifestHash: readOptionalText(stageRunDocument.pendingApprovalDifferenceManifestHash),
    stagedMonths: Array.isArray(stageRunDocument.stagedMonths) ? stageRunDocument.stagedMonths : [],
    stagedYears: Array.isArray(stageRunDocument.stagedYears) ? stageRunDocument.stagedYears : [],
  };
  return {
    projectId,
    status: 'APPLYING',
    stagedRun: { ...stagedRun, runId: stagedRunId, status: 'READY' },
    applyInput: (
      stageRunDocument.applyInput
      && typeof stageRunDocument.applyInput === 'object'
      && !Array.isArray(stageRunDocument.applyInput)
    ) ? stageRunDocument.applyInput : {
      applyRiskCandidates: true,
      closedMonthChangeReason: '',
      closedMonthDifferenceCount: 0,
      closedMonthDifferenceManifestHash: '',
      acceptPendingApprovalDifferences: false,
      pendingApprovalDifferenceCount: 0,
      pendingApprovalDifferenceManifestHash: '',
      acceptFormulaMismatches: false,
      replaceAllActualSources: stageRunDocument.replaceAllActualSources === true,
    },
  };
}

// 락을 놓을 때 무엇이 반영됐는지는 여기서 판정하지 않는다. 반영 여부의 진실은 JVM
// 멱등키와 revision 가드가 쥐고 있고, 다음 반영 요청이 그 가드를 정상적으로 통과하거나
// 거절된다. force=true 는 임대가 아직 남아 있어도 관리자 판단으로 해제한다.
async function releaseCashflowSheetApplyLock({
  db,
  tenantId,
  projectId,
  nowMs = Date.now(),
  leaseMs = cashflowApplyLeaseMs(),
  force = false,
  reason = '',
  actor = null,
}) {
  const publicationRef = db.doc(`orgs/${tenantId}/cashflow_sheet_publications/${projectId}`);
  return db.runTransaction(async (transaction) => {
    const publicationSnap = await transaction.get(publicationRef);
    const publication = publicationSnap.exists ? (publicationSnap.data() || {}) : {};
    const lease = readCashflowApplyLeaseState(publication, { nowMs, leaseMs });
    if (!lease.applying) return { released: false, reasonCode: 'not_applying', lease };
    if (!force && !lease.expired) return { released: false, reasonCode: 'lease_held', lease };
    const releasedAt = new Date(nowMs).toISOString();
    const failure = stripUndefinedDeep({
      code: force ? 'cashflow_sheet_apply_lock_force_released' : 'cashflow_sheet_apply_lease_expired',
      message: force
        ? '관리자가 시트 반영 대기 상태를 해제했습니다.'
        : '시트 반영이 끝나지 않아 대기 상태를 해제했습니다.',
      reason: readOptionalText(reason) || undefined,
      releasedById: readOptionalText(actor?.actorId) || undefined,
      releasedByEmail: readOptionalText(actor?.actorEmail) || undefined,
      previousApplyStartedAt: lease.applyStartedAt || undefined,
      previousStagedRunId: lease.stagedRunId || undefined,
    });
    const stagedRunId = lease.stagedRunId;
    if (stagedRunId) {
      const runRef = db.doc(`orgs/${tenantId}/${CASHFLOW_SHEET_STAGE_RUNS_COLLECTION_ID}/${stagedRunId}`);
      const runSnap = await transaction.get(runRef);
      const stageRun = runSnap.exists ? (runSnap.data() || {}) : {};
      if (
        runSnap.exists
        && readOptionalText(stageRun.projectId) === readOptionalText(projectId)
        && readOptionalText(stageRun.status) === 'APPLYING'
      ) {
        transaction.set(runRef, stripUndefinedDeep({
          status: 'READY',
          appliedIdempotencyKey: null,
          applyRequestHash: null,
          applyFailedAt: releasedAt,
          applyFailure: failure,
        }), { merge: true });
      }
    }
    transaction.set(publicationRef, stripUndefinedDeep({
      status: 'READY',
      applyFailedAt: releasedAt,
      applyFailure: failure,
    }), { merge: true });
    return { released: true, reasonCode: failure.code, lease, releasedAt, stagedRunId };
  });
}

function releaseExpiredCashflowSheetApplyLease(options) {
  return releaseCashflowSheetApplyLock({ ...options, force: false });
}

async function restoreCashflowSheetApplyReady({
  db,
  runRef,
  publicationRef,
  idempotencyKey,
  applyRequestHash,
  error,
}) {
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(runRef);
    if (!snap.exists) return;
    const stageRun = snap.data() || {};
    const publicationSnap = await transaction.get(publicationRef);
    const publication = publicationSnap.exists ? (publicationSnap.data() || {}) : {};
    if (
      readOptionalText(stageRun.status) !== 'APPLYING'
      || readOptionalText(stageRun.appliedIdempotencyKey) !== readOptionalText(idempotencyKey)
      || readOptionalText(stageRun.applyRequestHash) !== readOptionalText(applyRequestHash)
      || readOptionalText(publication.status).toUpperCase() !== 'APPLYING'
      || readOptionalText(publication.stagedRunId) !== readOptionalText(stageRun.runId)
    ) return;
    transaction.set(runRef, stripUndefinedDeep({
      status: 'READY',
      appliedIdempotencyKey: null,
      applyRequestHash: null,
      applyFailedAt: new Date().toISOString(),
      applyFailure: routeErrorDetails(error),
    }), { merge: true });
    transaction.set(publicationRef, stripUndefinedDeep({
      status: 'READY',
      applyFailedAt: new Date().toISOString(),
      applyFailure: routeErrorDetails(error),
    }), { merge: true });
  });
}

function monthApplyIdempotencyKey({ idempotencyKey, stagedRunId, yearMonth }) {
  return `cf-sheet-month-${stableHash({ idempotencyKey, stagedRunId, yearMonth }).slice(0, 48)}`;
}

function monthBatchApplyIdempotencyKey({ idempotencyKey, stagedRunId, yearMonths }) {
  return `cf-sheet-month-batch-${stableHash({ idempotencyKey, stagedRunId, yearMonths }).slice(0, 42)}`;
}

function yearApplyIdempotencyKey({ idempotencyKey, stagedRunId, year }) {
  return `cf-sheet-year-${stableHash({ idempotencyKey, stagedRunId, year }).slice(0, 48)}`;
}

function appliedCashflowSheetResponse(run, publication, {
  projectId,
  stagedRunId,
  idempotencyKey = '',
  applyRequestHash,
}) {
  const response = run?.applyResponse;
  const sourceRevision = readOptionalText(run?.sourceRevision);
  const targetRevision = readOptionalText(response?.resultingTargetRevision);
  const valid = readOptionalText(run?.status) === 'APPLIED'
    && readOptionalText(run?.projectId) === projectId
    && (!idempotencyKey || readOptionalText(run?.appliedIdempotencyKey) === idempotencyKey)
    && readOptionalText(run.applyRequestHash) === applyRequestHash
    && response?.ok === true
    && readOptionalText(response?.projectId) === projectId
    && readOptionalText(response?.stagedRunId) === stagedRunId
    && readOptionalText(response?.sourceRevision) === sourceRevision
    && Boolean(targetRevision)
    && readOptionalText(publication?.status).toUpperCase() === 'APPLIED'
    && readOptionalText(publication?.projectId) === projectId
    && readOptionalText(publication?.stagedRunId) === stagedRunId
    && readOptionalText(publication?.sourceRevision) === sourceRevision
    && readOptionalText(publication?.appliedTargetRevision) === targetRevision;
  return valid ? response : null;
}

async function readAppliedCashflowSheetResponse({
  db,
  tenantId,
  projectId,
  stagedRunId,
  idempotencyKey = '',
  applyRequestHash,
}) {
  const runRef = db.doc(`orgs/${tenantId}/${CASHFLOW_SHEET_STAGE_RUNS_COLLECTION_ID}/${stagedRunId}`);
  const publicationRef = db.doc(`orgs/${tenantId}/cashflow_sheet_publications/${projectId}`);
  return db.runTransaction(async (transaction) => {
    const [runSnap, publicationSnap] = await Promise.all([
      transaction.get(runRef),
      transaction.get(publicationRef),
    ]);
    return appliedCashflowSheetResponse(
      runSnap.exists ? (runSnap.data() || {}) : {},
      publicationSnap.exists ? (publicationSnap.data() || {}) : {},
      { projectId, stagedRunId, idempotencyKey, applyRequestHash },
    );
  });
}

async function checkpointCashflowSheetApplyOperation({
  db,
  runRef,
  publicationRef,
  projectId,
  stagedRunId,
  idempotencyKey,
  applyRequestHash,
  operationKey,
  checkpoint,
}) {
  await db.runTransaction(async (transaction) => {
    const [runSnap, publicationSnap] = await Promise.all([
      transaction.get(runRef),
      transaction.get(publicationRef),
    ]);
    const run = runSnap.exists ? (runSnap.data() || {}) : {};
    const publication = publicationSnap.exists ? (publicationSnap.data() || {}) : {};
    if (
      readOptionalText(run.status) !== 'APPLYING'
      || readOptionalText(run.appliedIdempotencyKey) !== idempotencyKey
      || readOptionalText(run.applyRequestHash) !== applyRequestHash
      || readOptionalText(publication.status).toUpperCase() !== 'APPLYING'
      || readOptionalText(publication.stagedRunId) !== stagedRunId
    ) {
      if (appliedCashflowSheetResponse(run, publication, {
        projectId,
        stagedRunId,
        idempotencyKey,
        applyRequestHash,
      })) return;
      throw createHttpError(409, '시트 반영 작업 상태가 변경되었습니다.', 'cashflow_sheet_apply_operation_conflict');
    }
    transaction.set(runRef, {
      applyOperations: {
        ...(run.applyOperations && typeof run.applyOperations === 'object' ? run.applyOperations : {}),
        [operationKey]: checkpoint,
      },
    }, { merge: true });
  });
}

function sameSortedValues(actual, expected) {
  return JSON.stringify([...(Array.isArray(actual) ? actual : [])].sort())
    === JSON.stringify([...(Array.isArray(expected) ? expected : [])].sort());
}

function assertCashflowSheetOperationStatus(status, expected) {
  const observed = {
    version: readOptionalText(status?.version),
    projectId: readOptionalText(status?.projectId),
    operationType: readOptionalText(status?.operationType),
    idempotencyKeyHash: readOptionalText(status?.idempotencyKeyHash),
    status: readOptionalText(status?.status),
    sourceRevision: readOptionalText(status?.sourceRevision) || null,
    expectedTargetRevision: readOptionalText(status?.expectedTargetRevision) || null,
    resultingTargetRevision: readOptionalText(status?.resultingTargetRevision) || null,
    appliedMonths: Array.isArray(status?.appliedMonths) ? status.appliedMonths : null,
    appliedYears: Array.isArray(status?.appliedYears) ? status.appliedYears.map(Number) : null,
    annualRevisions: Array.isArray(status?.annualRevisions) ? status.annualRevisions : null,
  };
  if (
    observed.version !== '1'
    || observed.projectId !== expected.projectId
    || observed.operationType !== expected.operationType
    || observed.idempotencyKeyHash !== expected.idempotencyKeyHash
    || !['NOT_FOUND', 'APPLIED'].includes(observed.status)
    || observed.appliedMonths === null
    || observed.appliedYears === null
    || observed.annualRevisions === null
  ) {
    throw Object.assign(new Error('작업 상태 응답이 요청과 일치하지 않습니다.'), { observed });
  }
  if (observed.status === 'NOT_FOUND') return { outcome: 'NOT_FOUND', observed };
  const monthOperation = ['MONTH_APPLY', 'BATCH_APPLY'].includes(expected.operationType);
  const validApplied = observed.sourceRevision === expected.sourceRevision
    && sameSortedValues(observed.appliedMonths, expected.appliedMonths)
    && sameSortedValues(observed.appliedYears, expected.appliedYears)
    && (monthOperation
      ? observed.expectedTargetRevision === expected.expectedTargetRevision
        && /^sha256:[a-f0-9]{64}$/.test(observed.resultingTargetRevision || '')
        && observed.annualRevisions.length === 0
      : observed.expectedTargetRevision === null
        && observed.resultingTargetRevision === null
        && observed.annualRevisions.length === 1
        && Number(observed.annualRevisions[0]?.year) === expected.appliedYears[0]
        && (expected.annualRevision === null
          ? Number.isSafeInteger(Number(observed.annualRevisions[0]?.revision))
            && Number(observed.annualRevisions[0]?.revision) >= 1
          : Number(observed.annualRevisions[0]?.revision) === expected.annualRevision));
  if (!validApplied) {
    throw Object.assign(new Error('적용된 작업 범위나 revision이 요청과 일치하지 않습니다.'), { observed });
  }
  return { outcome: 'APPLIED', observed };
}

function cashflowSheetOperationUncertainError(operationKey, evidence) {
  const error = createHttpError(
    503,
    '시트 반영 결과를 확정할 수 없습니다. 같은 요청으로 다시 시도해 주세요.',
    'cashflow_sheet_operation_uncertain',
  );
  error.operationKey = operationKey;
  error.operationEvidence = evidence;
  return error;
}

async function executeCashflowSheetOperation({
  javaWeeklyClient,
  context,
  projectId,
  operationKey,
  operationType,
  idempotencyKey,
  expected,
  reconcileFirst,
  oneWay = false,
  mutate,
  verifyMutation,
  checkpointFromStatus,
}) {
  if (oneWay) return verifyMutation(await mutate());

  const readStatus = async (mutationError) => {
    try {
      const status = await javaWeeklyClient.getCashflowSheetOperationStatus({
        context,
        projectId,
        operationType,
        idempotencyKey,
      });
      try {
        return assertCashflowSheetOperationStatus(status, expected);
      } catch (error) {
        return { outcome: 'MISMATCH', observed: error.observed || null };
      }
    } catch (error) {
      return {
        outcome: 'READ_FAILED',
        readErrorCode: readOptionalText(error?.code) || null,
        mutationErrorCode: readOptionalText(mutationError?.code) || null,
      };
    }
  };
  const reconcile = async (mutationError) => {
    const evidence = await readStatus(mutationError);
    if (evidence.outcome === 'APPLIED') return checkpointFromStatus(evidence.observed);
    if (evidence.outcome === 'NOT_FOUND') return null;
    throw cashflowSheetOperationUncertainError(operationKey, { ...evidence, expected });
  };
  if (reconcileFirst) {
    const checkpoint = await reconcile();
    if (checkpoint) return checkpoint;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return verifyMutation(await mutate());
    } catch (mutationError) {
      const mutationStatus = Number(mutationError?.statusCode || mutationError?.status);
      if (mutationStatus >= 400 && mutationStatus < 500 && mutationError?.mutationOutcome !== 'uncertain') {
        throw mutationError;
      }
      const checkpoint = await reconcile(mutationError);
      if (checkpoint) return checkpoint;
      if (mutationError?.mutationOutcome === 'uncertain') {
        throw cashflowSheetOperationUncertainError(operationKey, {
          outcome: 'NOT_FOUND_AFTER_UNCERTAIN_MUTATION',
          mutationErrorCode: readOptionalText(mutationError?.code) || null,
          expected,
        });
      }
      if (attempt === 1) {
        throw cashflowSheetOperationUncertainError(operationKey, {
          outcome: 'NOT_FOUND_AFTER_RETRY',
          mutationErrorCode: readOptionalText(mutationError?.code) || null,
          expected,
        });
      }
    }
  }
  throw cashflowSheetOperationUncertainError(operationKey, { outcome: 'UNKNOWN', expected });
}

function assertResultingTargetRevision(result) {
  const revision = readOptionalText(result?.resultingTargetRevision);
  if (!/^sha256:[a-f0-9]{64}$/.test(revision)) {
    throw createHttpError(
      502,
      'JVM 캐시플로 저장 결과의 revision을 확인할 수 없습니다.',
      'cashflow_jvm_invalid_response',
    );
  }
  return revision;
}

function summarizeJavaMonthResult(result = {}) {
  return stripUndefinedDeep({
    ok: result.ok === true,
    commandName: readOptionalText(result.commandName) || 'weeklyExpense.cashflowSheetLab.apply',
    projectId: readOptionalText(result.projectId),
    yearMonth: readOptionalText(result.yearMonth),
    sourceRevision: readOptionalText(result.sourceRevision),
    targetRevision: readOptionalText(result.targetRevision),
    resultingTargetRevision: readOptionalText(result.resultingTargetRevision),
    savedProjectionLineCount: Number(result.savedProjectionLineCount) || 0,
    savedActualLineCount: Number(result.savedActualLineCount) || 0,
    auditId: readOptionalText(result.auditId) || undefined,
  });
}

function javaAppliedLineIndex(lines, { mode, yearMonth }) {
  const index = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    if (readOptionalText(line?.yearMonth) !== yearMonth) continue;
    if (mode === 'actual' && readOptionalText(line?.sheetKey) !== CASHFLOW_SHEET_SOURCE_KEY) continue;
    const weekNo = Number(line?.weekNo);
    const lineId = readOptionalText(line?.cashflowLine);
    const amount = Number(line?.amount);
    const key = `${weekNo}:${lineId}`;
    if (!Number.isInteger(weekNo) || !CASHFLOW_LINE_ORDER.has(lineId) || !Number.isSafeInteger(amount) || index.has(key)) {
      throw createHttpError(502, '저장 결과 검산이 맞지 않아 저장을 취소했습니다. 시트 값을 다시 불러온 뒤 시도해 주세요.', 'cashflow_jvm_apply_verification_failed');
    }
    index.set(key, amount);
  }
  return index;
}

function verifyJavaMonthAppliedCells(result, month, {
  projectId,
  sourceRevision,
  targetRevision = null,
  commandName,
}) {
  if (
    result?.ok !== true
    || readOptionalText(result?.commandName) !== commandName
    || readOptionalText(result?.projectId) !== projectId
    || readOptionalText(result?.yearMonth) !== month.yearMonth
    || readOptionalText(result?.sourceSheetKey) !== CASHFLOW_SHEET_SOURCE_KEY
    || readOptionalText(result?.sourceRevision) !== sourceRevision
    || (targetRevision !== null && readOptionalText(result?.targetRevision) !== targetRevision)
  ) {
    throw createHttpError(502, '저장 대상 기간이 요청과 달라 저장을 취소했습니다. 시트 값을 다시 불러온 뒤 시도해 주세요.', 'cashflow_jvm_apply_verification_failed');
  }
  const calculationChecks = Array.isArray(result?.calculationChecks) ? result.calculationChecks : [];
  const calculationKeys = new Set(calculationChecks.map((check) => (
    `${readOptionalText(check?.mode)}:${Number(check?.weekNo)}`
  )));
  if (
    calculationChecks.length !== 10
    || calculationKeys.size !== 10
    || CASHFLOW_MODES.some((mode) => Array.from({ length: 5 }, (_, index) => (
      !calculationKeys.has(`${mode}:${index + 1}`)
    )).some(Boolean))
    || calculationChecks.some((check) => (
      !['openingBalance', 'depositTotal', 'withdrawalTotal', 'balance'].every((field) => (
        check?.calculated?.[field] !== null
        && check?.calculated?.[field] !== undefined
        && Number.isSafeInteger(Number(check.calculated[field]))
      ))
    ))
  ) {
    throw createHttpError(502, 'JVM 계산 검증 결과가 불완전해 저장을 확인할 수 없습니다.', 'cashflow_jvm_calculation_verification_failed');
  }
  let verifiedLineCount = 0;
  for (const mode of CASHFLOW_MODES) {
    const index = javaAppliedLineIndex(result?.[mode], { mode, yearMonth: month.yearMonth });
    const expected = month.cells.filter((cell) => (
      cell.mode === mode && ['VALUE', 'ZERO'].includes(cell.cellState)
    ));
    if (index.size !== expected.length) {
      throw createHttpError(502, '저장된 항목 수가 불러온 시트 값과 달라 저장을 취소했습니다. 시트 값을 다시 불러온 뒤 시도해 주세요.', 'cashflow_jvm_apply_verification_failed');
    }
    for (const cell of expected) {
      if (index.get(`${cell.weekNo}:${cell.cashflowLine}`) !== Number(cell.amount)) {
        throw createHttpError(502, '저장된 금액이 불러온 시트 값과 달라 저장을 취소했습니다. 시트 값을 다시 불러온 뒤 시도해 주세요.', 'cashflow_jvm_apply_verification_failed');
      }
      verifiedLineCount += 1;
    }
  }
  return verifiedLineCount;
}

function verifyJavaAnnualAppliedCells(result, stagedYear, { projectId, sourceRevision, expectedRevision = null }) {
  if (
    result?.ok !== true
    || readOptionalText(result?.commandName) !== CASHFLOW_SHEET_APPLY_COMMAND
    || readOptionalText(result?.projectId) !== projectId
    || Number(result?.year) !== stagedYear.year
    || readOptionalText(result?.sourceSheetKey) !== CASHFLOW_SHEET_SOURCE_KEY
    || readOptionalText(result?.sourceRevision) !== sourceRevision
    || (expectedRevision === null
      ? !Number.isSafeInteger(Number(result?.revision)) || Number(result.revision) < 1
      : Number(result?.revision) !== Number(expectedRevision) + 1)
  ) {
    throw createHttpError(502, '연간 합계의 저장 대상 기간이 요청과 달라 저장을 취소했습니다. 시트 값을 다시 불러온 뒤 시도해 주세요.', 'cashflow_jvm_annual_apply_verification_failed');
  }
  let verifiedLineCount = 0;
  for (const mode of CASHFLOW_MODES) {
    const values = result?.[mode] && typeof result[mode] === 'object' ? result[mode] : {};
    const states = result?.[`${mode}States`] && typeof result[`${mode}States`] === 'object'
      ? result[`${mode}States`]
      : {};
    for (const cell of stagedYear.cells.filter((candidate) => candidate.mode === mode)) {
      if (readOptionalText(states[cell.cashflowLine]) !== cell.cellState) {
        throw createHttpError(502, '연간 합계의 빈 칸 여부가 불러온 시트 값과 달라 저장을 취소했습니다. 시트 값을 다시 불러온 뒤 시도해 주세요.', 'cashflow_jvm_annual_apply_verification_failed');
      }
      if (['VALUE', 'ZERO'].includes(cell.cellState) && Number(values[cell.cashflowLine]) !== Number(cell.amount)) {
        throw createHttpError(502, '연간 합계 금액이 불러온 시트 값과 달라 저장을 취소했습니다. 시트 값을 다시 불러온 뒤 시도해 주세요.', 'cashflow_jvm_annual_apply_verification_failed');
      }
      verifiedLineCount += 1;
    }
  }
  return verifiedLineCount;
}

async function applyStagedCashflowSheetLab({
  db,
  tenantId,
  projectId,
  parsed = {},
  context = {},
  javaWeeklyClient = null,
  editSession = null,
  resolveEditSession = null,
  idempotencyKey = '',
  logger = () => {},
} = {}) {
  const stagedRunId = readOptionalText(parsed.stageRunId);
  const now = new Date().toISOString();
  logger('staged.start', {
    projectId,
    stagedRunId,
    applyRiskCandidates: Boolean(parsed.applyRiskCandidates),
  });
  if (!stagedRunId) {
    throw createHttpError(400, '검토 후보 runId가 필요합니다.', 'cashflow_sheet_stage_run_required');
  }

  let stageRun = await readCashflowSheetStageRun(db, tenantId, projectId, stagedRunId);
  const replaceAllActualSources = stageRun.replaceAllActualSources === true;
  const stageStatus = readOptionalText(stageRun.status);
  const resuming = stageStatus === 'APPLYING';
  const replaying = stageStatus === 'APPLIED';
  const storedApplyInput = (
    (resuming || replaying)
    && stageRun.applyInput
    && typeof stageRun.applyInput === 'object'
    && !Array.isArray(stageRun.applyInput)
  ) ? stageRun.applyInput : null;
  const applyRiskCandidates = storedApplyInput
    ? storedApplyInput.applyRiskCandidates === true
    : Boolean(parsed.applyRiskCandidates);
  const closedMonthChangeReason = storedApplyInput
    ? readOptionalText(storedApplyInput.closedMonthChangeReason)
    : readOptionalText(parsed.closedMonthChangeReason);
  const closedMonthDifferenceCount = storedApplyInput
    ? Number(storedApplyInput.closedMonthDifferenceCount)
    : Number(parsed.closedMonthDifferenceCount);
  const closedMonthDifferenceManifestHash = storedApplyInput
    ? readOptionalText(storedApplyInput.closedMonthDifferenceManifestHash)
    : readOptionalText(parsed.closedMonthDifferenceManifestHash);
  const acceptPendingApprovalDifferences = storedApplyInput
    ? storedApplyInput.acceptPendingApprovalDifferences === true
    : parsed.acceptPendingApprovalDifferences === true;
  const pendingApprovalDifferenceCount = storedApplyInput
    ? Number(storedApplyInput.pendingApprovalDifferenceCount)
    : Number(parsed.pendingApprovalDifferenceCount);
  const pendingApprovalDifferenceManifestHash = storedApplyInput
    ? readOptionalText(storedApplyInput.pendingApprovalDifferenceManifestHash)
    : readOptionalText(parsed.pendingApprovalDifferenceManifestHash);
  const pendingApprovalAffectedMonths = acceptPendingApprovalDifferences
    ? buildPendingApprovalAffectedMonths(stageRun.pendingApprovalDifferences)
    : [];
  const acceptFormulaMismatches = storedApplyInput
    ? storedApplyInput.acceptFormulaMismatches === true
    : parsed.acceptFormulaMismatches === true;
  const applyRequestHash = stableHash({
    stagedRunId,
    applyRiskCandidates,
    ...(acceptFormulaMismatches ? { acceptFormulaMismatches: true } : {}),
    ...(closedMonthChangeReason ? { closedMonthChangeReason } : {}),
    ...(Number.isSafeInteger(closedMonthDifferenceCount) ? { closedMonthDifferenceCount } : {}),
    ...(closedMonthDifferenceManifestHash ? { closedMonthDifferenceManifestHash } : {}),
    ...(acceptPendingApprovalDifferences ? { acceptPendingApprovalDifferences: true } : {}),
    ...(Number.isSafeInteger(pendingApprovalDifferenceCount) ? { pendingApprovalDifferenceCount } : {}),
    ...(pendingApprovalDifferenceManifestHash ? { pendingApprovalDifferenceManifestHash } : {}),
    ...(replaceAllActualSources ? { replaceAllActualSources: true } : {}),
  });
  if (replaying) {
    assertApplyRequestMatches(stageRun, applyRequestHash);
    const replay = await readAppliedCashflowSheetResponse({
      db,
      tenantId,
      projectId,
      stagedRunId,
      applyRequestHash,
    });
    if (replay) return replay;
    throw createHttpError(409, '이미 반영된 시트 검토 run입니다.', 'cashflow_sheet_stage_run_applied');
  }
  if (resuming) assertApplyRequestMatches(stageRun, applyRequestHash);
  if (!resuming && stageStatus !== 'READY') {
    throw createHttpError(409, '반영 가능한 상태의 시트 검토 run이 아닙니다.', 'cashflow_sheet_stage_run_blocked');
  }
  const candidates = await readCashflowChangeCandidatesByRun({ db, tenantId, projectId, runId: stagedRunId });
  if (candidates.length === 0) {
    throw createHttpError(400, '저장할 검토 후보가 없습니다.', 'cashflow_sheet_stage_candidates_empty');
  }

  const candidateMonths = [...new Set(candidates.map((candidate) => readOptionalText(candidate.yearMonth)).filter(Boolean))].sort();
  const candidateYears = [...new Set(candidates
    .filter((candidate) => readOptionalText(candidate.scope) === 'annual')
    .map((candidate) => Number(candidate.year))
    .filter(Number.isSafeInteger))].sort((left, right) => left - right);
  const selectedMonths = Array.isArray(stageRun.calculationMonths) && stageRun.calculationMonths.length > 0
    ? stageRun.calculationMonths.map(readOptionalText).filter(Boolean)
    : candidateMonths;
  const selectedMonthSet = new Set(candidateMonths);
  if (candidateMonths.some((yearMonth) => !selectedMonths.includes(yearMonth))) {
    throw createHttpError(409, '검토 당시 월 계산 범위가 완전하지 않습니다.', 'cashflow_sheet_stage_month_incomplete');
  }
  const selectedYearSet = new Set(candidateYears);
  const selectedCandidates = candidates.filter((candidate) => (
    selectedMonthSet.has(readOptionalText(candidate.yearMonth))
    || (readOptionalText(candidate.scope) === 'annual' && selectedYearSet.has(Number(candidate.year)))
  ));
  const closedMonthCandidates = selectedCandidates.filter((candidate) => (
    Array.isArray(candidate?.riskFlags) && candidate.riskFlags.includes('closed_month_change')
  ));
  if (closedMonthCandidates.length > 0 && (
    !closedMonthChangeReason
    || closedMonthDifferenceCount !== Number(stageRun.closedMonthDifferenceCount)
    || closedMonthDifferenceManifestHash !== readOptionalText(stageRun.closedMonthDifferenceManifestHash)
  )) {
    const error = createHttpError(
      409,
      '결산 완료 월 변경을 확인하고 변경 사유를 입력해 주세요.',
      'cashflow_closed_month_reason_required',
    );
    error.details = {
      closedMonths: [...new Set(closedMonthCandidates.map((candidate) => candidate.yearMonth))].sort(),
      closedMonthDifferences: Array.isArray(stageRun.closedMonthDifferences) && stageRun.closedMonthDifferences.length > 0
        ? stageRun.closedMonthDifferences
        : summarizeCandidateMonthDifferences(closedMonthCandidates),
      closedMonthDifferenceCount: Number(stageRun.closedMonthDifferenceCount) || closedMonthCandidates.length,
      closedMonthDifferenceManifestHash: readOptionalText(stageRun.closedMonthDifferenceManifestHash),
    };
    throw error;
  }

  if (!javaWeeklyClient) {
    throw createHttpError(503, '저장을 처리하는 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.', 'cashflow_jvm_authority_unavailable');
  }

  const stagedMonths = await Promise.all(selectedMonths.map(async (yearMonth) => {
    const stagedMonth = await readCashflowSheetStageMonth({ db, tenantId, projectId, runId: stagedRunId, yearMonth });
    if (
      readOptionalText(stagedMonth.configRevision) !== readOptionalText(stageRun.configRevision)
      || readOptionalText(stagedMonth.sourceRevision) !== readOptionalText(stageRun.sourceRevision)
      || readOptionalText(stagedMonth.targetRevisionAtFetch) !== readOptionalText(stageRun.targetRevisionAtFetch)
    ) {
      throw createHttpError(409, '검토 당시 고정한 월 시트 revision이 일치하지 않습니다.', 'cashflow_sheet_stage_month_revision_conflict');
    }
    // stage 단계에서 시트 셀·계산 근거를 검증하고 고정한다. apply는 그 고정본과
    // revision만 확인하고 같은 160셀/10개 계산 검사를 다시 반복하지 않는다.
    const cells = Array.isArray(stagedMonth.cells) ? stagedMonth.cells : [];
    const calculationChecks = Array.isArray(stagedMonth.calculationChecks) ? stagedMonth.calculationChecks : [];
    if (cells.length === 0 || calculationChecks.length !== 10) {
      throw createHttpError(409, '검토 당시 고정한 시트 근거가 없습니다. 시트 값을 다시 불러와 주세요.', 'cashflow_sheet_stage_evidence_missing');
    }
    return {
      yearMonth,
      cells,
      calculationChecks,
      apply: selectedMonthSet.has(yearMonth),
    };
  }));
  const stagedYears = await Promise.all(candidateYears.map(async (year) => {
    const stagedYear = await readCashflowSheetStageYear({ db, tenantId, projectId, runId: stagedRunId, year });
    if (
      readOptionalText(stagedYear.configRevision) !== readOptionalText(stageRun.configRevision)
      || readOptionalText(stagedYear.sourceRevision) !== readOptionalText(stageRun.sourceRevision)
      || readOptionalText(stagedYear.targetRevisionAtFetch) !== readOptionalText(stageRun.targetRevisionAtFetch)
    ) {
      throw createHttpError(409, '검토 당시 고정한 연간 합계 revision이 일치하지 않습니다.', 'cashflow_sheet_stage_year_revision_conflict');
    }
    const cells = Array.isArray(stagedYear.cells) ? stagedYear.cells : [];
    if (cells.length === 0) {
      throw createHttpError(409, '검토 당시 고정한 연간 합계가 없습니다. 시트 값을 다시 불러와 주세요.', 'cashflow_sheet_stage_evidence_missing');
    }
    return {
      year,
      expectedRevision: Math.max(0, Number(stagedYear.expectedRevision) || 0),
      cells,
    };
  }));
  const openingBalanceCells = Array.isArray(stageRun.openingBalanceCells)
    ? stageRun.openingBalanceCells
    : [];

  let mirror;
  try {
    mirror = await readCashflowSheetMirror(db, tenantId, projectId);
    assertFreshCashflowSheetMirror(mirror);
    if (
      readOptionalText(mirror?.configRevision) !== readOptionalText(stageRun.configRevision)
      || readOptionalText(mirror?.sourceRevision) !== readOptionalText(stageRun.sourceRevision)
    ) {
      throw createHttpError(409, '검토 후 시트 고정본이 변경되었습니다. 다시 검토해 주세요.', 'cashflow_sheet_mirror_revision_conflict');
    }
  } catch (error) {
    const code = readOptionalText(error?.code);
    if (
      resuming
      && Object.keys(stageRun.applyOperations || {}).length === 0
      && ['cashflow_sheet_config_changed', 'cashflow_sheet_mirror_stale', 'cashflow_sheet_mirror_revision_conflict'].includes(code)
    ) {
      await restoreCashflowSheetApplyReady({
        db,
        runRef: db.doc(`orgs/${tenantId}/${CASHFLOW_SHEET_STAGE_RUNS_COLLECTION_ID}/${stagedRunId}`),
        publicationRef: db.doc(`orgs/${tenantId}/cashflow_sheet_publications/${projectId}`),
        idempotencyKey: stageRun.appliedIdempotencyKey,
        applyRequestHash: stageRun.applyRequestHash,
        error,
      });
    }
    throw error;
  }
  // 월 반영은 JVM의 실제 월 저장 명령이 target revision을 원자적으로 확인한다.
  // 연간 명령은 아직 그 계약이 없으므로, 연간-only 작업에만 BFF가 한 번 확인한다.
  if (!resuming && stagedMonths.length === 0 && stagedYears.length > 0) {
    const currentTargetSnapshot = await readCashflowWeeksSnapshot(db, tenantId, projectId);
    if (computeCashflowTargetRevision(currentTargetSnapshot) !== readOptionalText(stageRun.targetRevisionAtFetch)) {
      throw createHttpError(409, '검토 후 캐시플로우 값이 변경되었습니다. 다시 검토해 주세요.', 'cashflow_sheet_target_revision_conflict');
    }
  }
  if (stagedYears.length > 0) {
    const preflightInput = cashflowFormulaPreflightInput(mirror);
    await javaWeeklyClient.validateCashflowSheetFormulas({
      context,
      projectId,
      ...preflightInput,
      acceptFormulaMismatches,
    });
  }

  if (!resuming) {
    const pendingApproval = await readPendingApprovalDifferences({ db, tenantId, projectId, candidates: selectedCandidates });
    if (stableHash(pendingApproval.evidence) !== stableHash(stageRun.pendingApprovalEvidence || [])) {
      throw pendingApprovalEvidenceError('검토 후 결재 중인 누적 결산 상태 또는 revision이 변경되었습니다. 다시 검토해 주세요.');
    }
    if (
      pendingApproval.differenceCount !== Number(stageRun.pendingApprovalDifferenceCount)
      || pendingApproval.manifestHash !== readOptionalText(stageRun.pendingApprovalDifferenceManifestHash)
      || stableHash(pendingApproval.differences) !== stableHash(stageRun.pendingApprovalDifferences || [])
    ) {
      throw pendingApprovalEvidenceError('검토 후 결재 중인 누적 결산 월 근거가 변경되었습니다. 다시 검토해 주세요.');
    }
    if (pendingApproval.differenceCount > 0 && (
      !acceptPendingApprovalDifferences
      || pendingApprovalDifferenceCount !== pendingApproval.differenceCount
      || pendingApprovalDifferenceManifestHash !== pendingApproval.manifestHash
    )) {
      const error = createHttpError(
        409,
        '결재 중인 누적 결산과 달라지는 전체 값을 확인한 뒤 반영해 주세요.',
        'cashflow_pending_approval_confirmation_required',
      );
      error.details = {
        pendingApprovalDifferences: pendingApproval.differences,
        pendingApprovalDifferenceCount: pendingApproval.differenceCount,
        pendingApprovalDifferenceManifestHash: pendingApproval.manifestHash,
      };
      throw error;
    }
  }

  // 중단된 이전 반영이 남긴 락은 새 검토본으로 재시도해도 stagedRunId가 달라 계속 막힌다.
  // 예약 전에 만료된 락을 먼저 놓아 그 고착을 끊는다.
  await releaseExpiredCashflowSheetApplyLease({
    db,
    tenantId,
    projectId,
    nowMs: Date.parse(now),
  });

  const reservation = await reserveCashflowSheetApply({
    db,
    tenantId,
    projectId,
    stagedRunId,
    idempotencyKey,
    applyRequestHash,
    applyInput: {
      applyRiskCandidates,
      closedMonthChangeReason,
      closedMonthDifferenceCount,
      closedMonthDifferenceManifestHash,
      acceptPendingApprovalDifferences,
      pendingApprovalDifferenceCount,
      pendingApprovalDifferenceManifestHash,
      acceptFormulaMismatches,
      replaceAllActualSources,
    },
    replaceAllActualSources,
    now,
  });
  if (reservation.replay) return reservation.replay;
  stageRun = reservation.stageRun;
  const effectiveIdempotencyKey = reservation.resume
    ? readOptionalText(stageRun.appliedIdempotencyKey)
    : idempotencyKey;
  if (!effectiveIdempotencyKey) {
    throw createHttpError(409, '최종 반영 재시도 키를 확인할 수 없습니다.', 'cashflow_sheet_apply_resume_invalid');
  }

  const javaResults = [];
  const javaAnnualResults = [];
  const verifiedFormulaValidation = [];
  let verifiedLineCount = 0;
  let targetRevision = readOptionalText(stageRun.targetRevisionAtFetch);
  let completedOperationCount = 0;
  const applyOperations = stageRun.applyOperations && typeof stageRun.applyOperations === 'object'
    ? { ...stageRun.applyOperations }
    : {};
  const persistOperation = async (operationKey, checkpoint) => {
    await checkpointCashflowSheetApplyOperation({
      db,
      runRef: reservation.runRef,
      publicationRef: reservation.publicationRef,
      projectId,
      stagedRunId,
      idempotencyKey: effectiveIdempotencyKey,
      applyRequestHash,
      operationKey,
      checkpoint,
    });
    applyOperations[operationKey] = checkpoint;
  };
  const operationHash = (idempotencyKey) => `sha256:${createHash('sha256').update(idempotencyKey).digest('hex')}`;
  try {
    const resolvedEditSession = typeof resolveEditSession === 'function'
      ? await resolveEditSession()
      : editSession;
    const operationCount = stagedYears.length + (stagedMonths.length > 0 ? 1 : 0);
    if (stagedMonths.length === 1) {
      const operationStartedAt = Date.now();
      const month = stagedMonths[0];
      const monthTargetRevision = targetRevision;
      const operationKey = `MONTH_APPLY:${month.yearMonth}`;
      const operationIdempotencyKey = monthApplyIdempotencyKey({
        idempotencyKey: effectiveIdempotencyKey,
        stagedRunId,
        yearMonth: month.yearMonth,
      });
      const isLastOperation = completedOperationCount === operationCount - 1;
      const monthEditSession = resolvedEditSession
        ? { ...resolvedEditSession, finalize: isLastOperation ? Boolean(resolvedEditSession.finalize) : false }
        : null;
      const checkpoint = readOptionalText(applyOperations[operationKey]?.status) === 'APPLIED'
        ? applyOperations[operationKey]
        : await executeCashflowSheetOperation({
          javaWeeklyClient,
          context,
          projectId,
          operationKey,
          operationType: 'MONTH_APPLY',
          idempotencyKey: operationIdempotencyKey,
          expected: {
            projectId,
            operationType: 'MONTH_APPLY',
            idempotencyKeyHash: operationHash(operationIdempotencyKey),
            sourceRevision: readOptionalText(stageRun.sourceRevision),
            expectedTargetRevision: monthTargetRevision,
            appliedMonths: [month.yearMonth],
            appliedYears: [],
          },
          reconcileFirst: Boolean(applyOperations[operationKey]),
          oneWay: replaceAllActualSources,
          mutate: () => javaWeeklyClient.applyCashflowSheetLab({
            context,
            projectId,
            idempotencyKey: operationIdempotencyKey,
            editSession: monthEditSession,
            sourceRevision: stageRun.sourceRevision,
            targetRevision,
            yearMonth: month.yearMonth,
            cells: month.cells,
            calculationChecks: month.calculationChecks,
            openingBalanceCells,
            replaceAllActualSources,
            closedMonthChangeReason,
            pendingApprovalAffectedMonths,
            acceptFormulaMismatches,
          }),
          verifyMutation: (javaResult) => {
            const resultingTargetRevision = assertResultingTargetRevision(javaResult);
            const operationVerifiedLineCount = verifyJavaMonthAppliedCells(javaResult, month, {
              projectId,
              sourceRevision: readOptionalText(stageRun.sourceRevision),
              targetRevision: replaceAllActualSources ? null : monthTargetRevision,
              commandName: CASHFLOW_SHEET_APPLY_COMMAND,
            });
            return {
              status: 'APPLIED',
              operationType: 'MONTH_APPLY',
              idempotencyKey: operationIdempotencyKey,
              resultingTargetRevision,
              verifiedLineCount: operationVerifiedLineCount,
              monthResults: [summarizeJavaMonthResult(javaResult)],
              formulaValidation: Array.isArray(javaResult?.calculationChecks) ? javaResult.calculationChecks : [],
              evidence: { outcome: 'MUTATION_RESPONSE' },
              appliedAt: now,
            };
          },
          checkpointFromStatus: (status) => ({
            status: 'APPLIED',
            operationType: 'MONTH_APPLY',
            idempotencyKey: operationIdempotencyKey,
            resultingTargetRevision: status.resultingTargetRevision,
            verifiedLineCount: month.cells.filter((cell) => ['VALUE', 'ZERO'].includes(cell.cellState)).length,
            monthResults: [summarizeJavaMonthResult({
              ok: true,
              projectId,
              yearMonth: month.yearMonth,
              sourceRevision: stageRun.sourceRevision,
              targetRevision: monthTargetRevision,
              resultingTargetRevision: status.resultingTargetRevision,
              auditId: status.auditId,
            })],
            formulaValidation: [],
            evidence: { outcome: 'AUTHORITATIVE_STATUS', status },
            appliedAt: now,
          }),
        });
      if (applyOperations[operationKey] !== checkpoint) await persistOperation(operationKey, checkpoint);
      targetRevision = checkpoint.resultingTargetRevision;
      verifiedLineCount += Number(checkpoint.verifiedLineCount) || 0;
      javaResults.push(...(Array.isArray(checkpoint.monthResults) ? checkpoint.monthResults : []));
      verifiedFormulaValidation.push(...(Array.isArray(checkpoint.formulaValidation) ? checkpoint.formulaValidation : []));
      logger('month.ok', { projectId, yearMonth: month.yearMonth, durationMs: Date.now() - operationStartedAt });
      completedOperationCount += 1;
    } else if (stagedMonths.length > 1) {
      const operationStartedAt = Date.now();
      const batchTargetRevision = targetRevision;
      const appliedMonths = stagedMonths.filter((month) => month.apply);
      const appliedYearMonths = appliedMonths.map((month) => month.yearMonth);
      const operationKey = `BATCH_APPLY:${appliedYearMonths.join(',')}`;
      const operationIdempotencyKey = monthBatchApplyIdempotencyKey({
        idempotencyKey: effectiveIdempotencyKey,
        stagedRunId,
        yearMonths: stagedMonths.map((month) => month.yearMonth),
      });
      const isLastOperation = completedOperationCount === operationCount - 1;
      const monthEditSession = resolvedEditSession
        ? { ...resolvedEditSession, finalize: isLastOperation ? Boolean(resolvedEditSession.finalize) : false }
        : null;
      const checkpoint = readOptionalText(applyOperations[operationKey]?.status) === 'APPLIED'
        ? applyOperations[operationKey]
        : await executeCashflowSheetOperation({
          javaWeeklyClient,
          context,
          projectId,
          operationKey,
          operationType: 'BATCH_APPLY',
          idempotencyKey: operationIdempotencyKey,
          expected: {
            projectId,
            operationType: 'BATCH_APPLY',
            idempotencyKeyHash: operationHash(operationIdempotencyKey),
            sourceRevision: readOptionalText(stageRun.sourceRevision),
            expectedTargetRevision: batchTargetRevision,
            appliedMonths: appliedYearMonths,
            appliedYears: [],
          },
          reconcileFirst: Boolean(applyOperations[operationKey]),
          oneWay: replaceAllActualSources,
          mutate: () => javaWeeklyClient.applyCashflowSheetBatch({
            context,
            projectId,
            idempotencyKey: operationIdempotencyKey,
            editSession: monthEditSession,
            sourceRevision: stageRun.sourceRevision,
            targetRevision,
            openingBalanceCells,
            months: stagedMonths.map((month) => ({
              yearMonth: month.yearMonth,
              cells: month.cells,
              calculationChecks: month.calculationChecks,
              apply: month.apply,
            })),
            replaceAllActualSources,
            closedMonthChangeReason,
            pendingApprovalAffectedMonths,
            acceptFormulaMismatches,
          }),
          verifyMutation: (batchResult) => {
            if (
              batchResult?.ok !== true
              || readOptionalText(batchResult?.commandName) !== CASHFLOW_SHEET_APPLY_COMMAND
              || readOptionalText(batchResult?.projectId) !== projectId
              || readOptionalText(batchResult?.sourceSheetKey) !== CASHFLOW_SHEET_SOURCE_KEY
              || readOptionalText(batchResult?.sourceRevision) !== readOptionalText(stageRun.sourceRevision)
              || (!replaceAllActualSources && readOptionalText(batchResult?.targetRevision) !== batchTargetRevision)
            ) {
              throw createHttpError(502, '저장 형식이 올바르지 않아 저장을 취소했습니다. 담당자에게 문의해 주세요.', 'cashflow_jvm_apply_verification_failed');
            }
            const resultingTargetRevision = assertResultingTargetRevision(batchResult);
            const returnedMonths = new Map((Array.isArray(batchResult?.months) ? batchResult.months : [])
              .map((month) => [readOptionalText(month?.yearMonth), month]));
            if (returnedMonths.size !== appliedMonths.length) {
              throw createHttpError(502, '저장된 항목 수가 요청과 달라 저장을 취소했습니다. 시트 값을 다시 불러온 뒤 시도해 주세요.', 'cashflow_jvm_apply_verification_failed');
            }
            let operationVerifiedLineCount = 0;
            const monthResults = appliedMonths.map((month) => {
              const monthResult = returnedMonths.get(month.yearMonth);
              if (!monthResult) {
                throw createHttpError(502, '여러 달 저장의 대상 기간이 요청과 달라 저장을 취소했습니다. 시트 값을 다시 불러온 뒤 시도해 주세요.', 'cashflow_jvm_apply_verification_failed');
              }
              const compatibleResult = {
                ...monthResult,
                ok: batchResult.ok,
                commandName: batchResult.commandName,
                projectId: batchResult.projectId,
                sourceSheetKey: batchResult.sourceSheetKey,
                sourceRevision: batchResult.sourceRevision,
                targetRevision: batchResult.targetRevision,
                resultingTargetRevision,
                auditId: batchResult.auditId,
              };
              operationVerifiedLineCount += verifyJavaMonthAppliedCells(compatibleResult, month, {
                projectId,
                sourceRevision: readOptionalText(stageRun.sourceRevision),
                targetRevision: replaceAllActualSources ? null : batchTargetRevision,
                commandName: CASHFLOW_SHEET_APPLY_COMMAND,
              });
              return summarizeJavaMonthResult(compatibleResult);
            });
            return {
              status: 'APPLIED', operationType: 'BATCH_APPLY', idempotencyKey: operationIdempotencyKey,
              resultingTargetRevision, verifiedLineCount: operationVerifiedLineCount, monthResults,
              formulaValidation: monthResults.flatMap((_result, index) => (
                Array.isArray(appliedMonths[index]?.calculationChecks) ? appliedMonths[index].calculationChecks : []
              )),
              evidence: { outcome: 'MUTATION_RESPONSE' }, appliedAt: now,
            };
          },
          checkpointFromStatus: (status) => ({
            status: 'APPLIED', operationType: 'BATCH_APPLY', idempotencyKey: operationIdempotencyKey,
            resultingTargetRevision: status.resultingTargetRevision,
            verifiedLineCount: appliedMonths.flatMap((month) => month.cells)
              .filter((cell) => ['VALUE', 'ZERO'].includes(cell.cellState)).length,
            monthResults: appliedMonths.map((month) => summarizeJavaMonthResult({
              ok: true, projectId, yearMonth: month.yearMonth, sourceRevision: stageRun.sourceRevision,
              targetRevision: batchTargetRevision, resultingTargetRevision: status.resultingTargetRevision,
              auditId: status.auditId,
            })),
            formulaValidation: [], evidence: { outcome: 'AUTHORITATIVE_STATUS', status }, appliedAt: now,
          }),
        });
      if (applyOperations[operationKey] !== checkpoint) await persistOperation(operationKey, checkpoint);
      targetRevision = checkpoint.resultingTargetRevision;
      verifiedLineCount += Number(checkpoint.verifiedLineCount) || 0;
      javaResults.push(...(Array.isArray(checkpoint.monthResults) ? checkpoint.monthResults : []));
      verifiedFormulaValidation.push(...(Array.isArray(checkpoint.formulaValidation) ? checkpoint.formulaValidation : []));
      logger('months.ok', {
        projectId,
        monthCount: appliedMonths.length,
        durationMs: Date.now() - operationStartedAt,
        jvmDurationMs: 0,
      });
      completedOperationCount += 1;
    }
    // Closed-month authorization is validated by the JVM monthly command. Run it before
    // independent annual totals so a missing late-amendment reason cannot leave a partial apply.
    for (const yearBatch of chunkArray(stagedYears.map((stagedYear, index) => ({ stagedYear, index })), 4)) {
      const settled = await Promise.allSettled(yearBatch.map(async ({ stagedYear, index }) => {
        const operationStartedAt = Date.now();
        const operationIndex = (stagedMonths.length > 0 ? 1 : 0) + index;
        const isLastOperation = operationIndex === operationCount - 1;
        const yearEditSession = resolvedEditSession
          ? { ...resolvedEditSession, finalize: isLastOperation ? Boolean(resolvedEditSession.finalize) : false }
          : null;
        const operationKey = `ANNUAL_APPLY:${stagedYear.year}`;
        const operationIdempotencyKey = yearApplyIdempotencyKey({
          idempotencyKey: effectiveIdempotencyKey,
          stagedRunId,
          year: stagedYear.year,
        });
        const checkpoint = readOptionalText(applyOperations[operationKey]?.status) === 'APPLIED'
          ? applyOperations[operationKey]
          : await executeCashflowSheetOperation({
            javaWeeklyClient,
            context,
            projectId,
            operationKey,
            operationType: 'ANNUAL_APPLY',
            idempotencyKey: operationIdempotencyKey,
            expected: {
              projectId,
              operationType: 'ANNUAL_APPLY',
              idempotencyKeyHash: operationHash(operationIdempotencyKey),
              sourceRevision: readOptionalText(stageRun.sourceRevision),
              expectedTargetRevision: null,
              appliedMonths: [],
              appliedYears: [stagedYear.year],
              annualRevision: replaceAllActualSources ? null : stagedYear.expectedRevision + 1,
            },
            reconcileFirst: Boolean(applyOperations[operationKey]),
            oneWay: replaceAllActualSources,
            mutate: () => javaWeeklyClient.applyCashflowSheetAnnualTotal({
              context,
              projectId,
              idempotencyKey: operationIdempotencyKey,
              editSession: yearEditSession,
              sourceRevision: stageRun.sourceRevision,
              year: stagedYear.year,
              expectedRevision: stagedYear.expectedRevision,
              cells: stagedYear.cells,
              amendmentReason: closedMonthChangeReason,
              replaceAllActualSources,
            }),
            verifyMutation: (javaResult) => ({
              status: 'APPLIED',
              operationType: 'ANNUAL_APPLY',
              idempotencyKey: operationIdempotencyKey,
              verifiedLineCount: verifyJavaAnnualAppliedCells(javaResult, stagedYear, {
                projectId,
                sourceRevision: readOptionalText(stageRun.sourceRevision),
                expectedRevision: replaceAllActualSources ? null : stagedYear.expectedRevision,
              }),
              annualResult: javaResult,
              evidence: { outcome: 'MUTATION_RESPONSE' },
              appliedAt: now,
            }),
            checkpointFromStatus: (status) => ({
              status: 'APPLIED',
              operationType: 'ANNUAL_APPLY',
              idempotencyKey: operationIdempotencyKey,
              verifiedLineCount: stagedYear.cells.length,
              annualResult: {
                ok: true,
                commandName: CASHFLOW_SHEET_APPLY_COMMAND,
                projectId,
                year: stagedYear.year,
                sourceRevision: stageRun.sourceRevision,
                revision: Number(status.annualRevisions?.[0]?.revision)
                  || (replaceAllActualSources ? undefined : stagedYear.expectedRevision + 1),
                auditId: status.auditId,
              },
              evidence: { outcome: 'AUTHORITATIVE_STATUS', status },
              appliedAt: now,
            }),
          });
        logger('annual.ok', { projectId, year: stagedYear.year, durationMs: Date.now() - operationStartedAt });
        return { operationKey, checkpoint };
      }));
      const rejected = settled.find((result) => (
        result.status === 'rejected'
        && readOptionalText(result.reason?.code) === 'cashflow_sheet_operation_uncertain'
      )) || settled.find((result) => result.status === 'rejected');
      for (const result of settled) {
        if (result.status !== 'fulfilled') continue;
        if (applyOperations[result.value.operationKey] !== result.value.checkpoint) {
          await persistOperation(result.value.operationKey, result.value.checkpoint);
        }
        verifiedLineCount += Number(result.value.checkpoint.verifiedLineCount) || 0;
        javaAnnualResults.push(result.value.checkpoint.annualResult);
        completedOperationCount += 1;
      }
      if (rejected) throw rejected.reason;
    }
  } catch (error) {
    if (readOptionalText(error?.code) === 'cashflow_sheet_operation_uncertain' && error.operationKey) {
      await persistOperation(error.operationKey, {
        status: 'UNCERTAIN',
        operationType: error.operationEvidence?.expected?.operationType,
        idempotencyKeyHash: error.operationEvidence?.expected?.idempotencyKeyHash,
        evidence: error.operationEvidence,
        updatedAt: now,
      });
    }
    if (readOptionalText(error?.code) === 'cashflow_closed_month_reason_required') {
      const requiredMonths = Array.isArray(error?.details?.closedMonths)
        ? error.details.closedMonths
        : [readOptionalText(error?.message).match(/\b20\d{2}-(?:0[1-9]|1[0-2])\b/)?.[0]].filter(Boolean);
      error.details = {
        ...(error?.details && typeof error.details === 'object' ? error.details : {}),
        closedMonthDifferences: summarizeCandidateMonthDifferences(selectedCandidates, requiredMonths),
      };
    }
    // 반영된 작업이 하나도 없고 결과가 불확정도 아니면 락을 즉시 놓는다. 5xx·전송 실패는
    // 이전에 해제 대상이 아니어서, 서버 오류 한 번이 프로젝트를 영구히 잠그는 원인이었다.
    // 불확정(uncertain)은 JVM 반영 여부를 모르는 상태이므로 임대 만료에 맡긴다.
    const uncertainOutcome = readOptionalText(error?.code) === 'cashflow_sheet_operation_uncertain'
      || error?.mutationOutcome === 'uncertain';
    if (completedOperationCount === 0 && !uncertainOutcome) {
      await restoreCashflowSheetApplyReady({
        db,
        runRef: reservation.runRef,
        publicationRef: reservation.publicationRef,
        idempotencyKey: effectiveIdempotencyKey,
        applyRequestHash,
        error,
      });
    }
    throw error;
  }

  const appliedMonthSnapshots = stagedMonths.filter((month) => month.apply);
  let canonicalReadbackVerifiedCellCount = 0;
  if (appliedMonthSnapshots.length > 0) {
    let canonicalReadback;
    try {
      canonicalReadback = await javaWeeklyClient.getCashflowSnapshot({ context, projectId });
      canonicalReadbackVerifiedCellCount = assertJavaCashflowReadbackMatchesAppliedMonths(
        canonicalReadback,
        appliedMonthSnapshots,
        { projectId, resultingTargetRevision: targetRevision },
      );
    } catch (error) {
      throw Object.assign(createHttpError(
        503,
        'JVM 저장 후 canonical 값을 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.',
        'cashflow_sheet_canonical_readback_uncertain',
      ), {
        cause: error,
        details: { readbackCode: readOptionalText(error?.code) || 'cashflow_jvm_readback_failed' },
      });
    }
  }
  const appliedCells = [
    ...appliedMonthSnapshots.flatMap((month) => month.cells),
    ...stagedYears.flatMap((year) => year.cells),
  ];
  const projectionLineCount = appliedCells.filter((cell) => cell.mode === 'projection').length;
  const actualLineCount = appliedCells.filter((cell) => cell.mode === 'actual').length;
  const response = {
    ok: true,
    commandName: CASHFLOW_SHEET_APPLY_COMMAND,
    projectId,
    sourceSheetKey: CASHFLOW_SHEET_SOURCE_KEY,
    sourceRevision: stageRun.sourceRevision,
    targetRevisionAtStart: stageRun.targetRevisionAtFetch,
    resultingTargetRevision: targetRevision,
    appliedMonths: candidateMonths,
    appliedYears: candidateYears,
    weekBasis: CASHFLOW_WEEK_BASIS,
    totalBasis: CASHFLOW_WEEK_BASIS,
    appliedLineCount: appliedCells.length,
    projectionLineCount,
    actualLineCount,
    skippedRiskLineCount: 0,
    lastAppliedAt: now,
    runId: `cashflow-sheet-apply:${projectId}:${now}`,
    stagedRunId,
    lastAppliedBy: {
      uid: readOptionalText(context?.actorId),
      email: readOptionalText(context?.actorEmail),
      role: readOptionalText(context?.actorRole) || 'workspace_user',
    },
    verifiedLineCount,
    canonicalReadbackVerifiedCellCount,
    formulaValidation: verifiedFormulaValidation,
    firebaseResult: {
      ok: true,
      commandName: CASHFLOW_SHEET_APPLY_COMMAND,
      projectId,
      sourceRevision: stageRun.sourceRevision,
      targetRevisionAtStart: stageRun.targetRevisionAtFetch,
      resultingTargetRevision: targetRevision,
      monthResults: javaResults.map(summarizeJavaMonthResult),
      annualResults: javaAnnualResults.map((result) => stripUndefinedDeep({
        ok: result.ok === true,
        commandName: readOptionalText(result.commandName) || 'weeklyExpense.cashflowSheetAnnual.apply',
        projectId: readOptionalText(result.projectId),
        year: Number(result.year),
        sourceRevision: readOptionalText(result.sourceRevision),
        revision: Number(result.revision) || 0,
        auditId: readOptionalText(result.auditId) || undefined,
      })),
      verifiedLineCount,
      canonicalReadbackVerifiedCellCount,
    },
  };
  const runCompletionPatch = {
    status: 'APPLIED',
    appliedAt: now,
    appliedIdempotencyKey: effectiveIdempotencyKey,
    applyRequestHash,
    applyResponse: response,
    appliedBy: response.lastAppliedBy,
  };
  const appliedWeeklyYears = [...new Set(candidateMonths
    .map((yearMonth) => Number(yearMonth.slice(0, 4)))
    .filter(Number.isSafeInteger))];
  const mirrorRef = db.doc(cashflowSheetMirrorDocPath(tenantId, projectId));
  const mirrorCompletionPatch = stripUndefinedDeep({
    appliedSourceRevision: stageRun.sourceRevision,
    appliedTargetRevision: targetRevision,
    lastAppliedAt: now,
    lastAppliedBy: response.lastAppliedBy,
    appliedAnnualYears: [...new Set([
      ...(Array.isArray(stageRun.appliedAnnualYears) ? stageRun.appliedAnnualYears.map(Number) : []),
      ...candidateYears,
    ].filter(Number.isSafeInteger))]
      .filter((year) => !appliedWeeklyYears.includes(year))
      .sort((left, right) => left - right),
    appliedWeeklyYears: [...new Set([
      ...(Array.isArray(stageRun.appliedWeeklyYears) ? stageRun.appliedWeeklyYears.map(Number) : []),
      ...appliedWeeklyYears,
    ].filter(Number.isSafeInteger))]
      .filter((year) => !candidateYears.includes(year))
      .sort((left, right) => left - right),
  });
  let finalizedResponse = response;
  try {
    await db.runTransaction(async (transaction) => {
      const currentRunSnap = await transaction.get(reservation.runRef);
      const currentRun = currentRunSnap.exists ? (currentRunSnap.data() || {}) : {};
      const publicationSnap = await transaction.get(reservation.publicationRef);
      const publication = publicationSnap.exists ? (publicationSnap.data() || {}) : {};
      if (
        readOptionalText(currentRun.status) !== 'APPLYING'
        || readOptionalText(currentRun.appliedIdempotencyKey) !== effectiveIdempotencyKey
        || readOptionalText(currentRun.applyRequestHash) !== applyRequestHash
        || readOptionalText(publication.status).toUpperCase() !== 'APPLYING'
        || readOptionalText(publication.stagedRunId) !== stagedRunId
      ) {
        throw createHttpError(409, '시트 반영 완료 상태가 변경되었습니다. 다시 확인해 주세요.', 'cashflow_sheet_apply_completion_conflict');
      }
      transaction.set(reservation.runRef, runCompletionPatch, { merge: true });
      transaction.set(mirrorRef, mirrorCompletionPatch, { merge: true });
      transaction.set(reservation.publicationRef, stripUndefinedDeep({
        projectId,
        status: 'APPLIED',
        stagedRunId,
        sourceRevision: stageRun.sourceRevision,
        appliedTargetRevision: targetRevision,
        appliedAt: now,
        applyFailure: null,
      }), { merge: true });
    });
  } catch (error) {
    if (error?.code !== 'cashflow_sheet_apply_completion_conflict') throw error;
    const replay = await readAppliedCashflowSheetResponse({
      db,
      tenantId,
      projectId,
      stagedRunId,
      idempotencyKey: effectiveIdempotencyKey,
      applyRequestHash,
    });
    if (!replay) throw error;
    finalizedResponse = replay;
  }
  try {
    await markCashflowChangeCandidatesStatus({
      db,
      tenantId,
      candidates: selectedCandidates,
      status: 'applied',
      now,
    });
  } catch (error) {
    logger('staged.candidate_status_failed', {
      projectId,
      stagedRunId,
      ...routeErrorDetails(error),
    }, 'warn');
  }
  return finalizedResponse;
}

async function stagePinnedCashflowSheetLab({
  db,
  tenantId,
  projectId,
  parsed = {},
  context = {},
  logger = () => {},
  trace = null,
  performanceNow,
  onMetric = () => {},
} = {}) {
  const phaseDurationMs = { read: 0, build: 0, write: 0 };
  let stageTimingsPublished = false;
  const measureAsync = async (phase, task) => {
    const startedAt = cashflowStageMetricNow(performanceNow);
    try {
      return await task();
    } finally {
      phaseDurationMs[phase] += Math.max(0, cashflowStageMetricNow(performanceNow) - startedAt);
    }
  };
  const publishStageTimings = () => {
    if (stageTimingsPublished) return;
    stageTimingsPublished = true;
    for (const phase of ['read', 'build', 'write']) {
      try {
        trace?.emit?.(`stage_${phase}`, {
          outcome: 'ok',
          durationMs: Math.round(phaseDurationMs[phase]),
        });
      } catch {
        // Diagnostics must never affect a financial stage.
      }
    }
  };
  logger('start', {
    projectId,
    expectedMirrorRevision: parsed.expectedMirrorRevision,
    yearMonth: parsed.yearMonth || null,
    replaceAllActualSources: Boolean(parsed.replaceAllActualSources),
  });
  const requestHash = stableHash({
    expectedMirrorRevision: parsed.expectedMirrorRevision,
    ...(parsed.yearMonth ? { yearMonth: parsed.yearMonth } : {}),
    ...(parsed.replaceAllActualSources ? { replaceAllActualSources: true } : {}),
  });
  const runId = `cfstage_${stableHash({ tenantId, projectId, idempotencyKey: parsed.idempotencyKey }).slice(0, 32)}`;
  const runRef = db.doc(`orgs/${tenantId}/${CASHFLOW_SHEET_STAGE_RUNS_COLLECTION_ID}/${runId}`);
  const mirror = await measureAsync('read', () => readCashflowSheetMirror(db, tenantId, projectId));
  if (!mirror?.sourceRevision) {
    throw createHttpError(409, '먼저 시트 연동하기를 실행해 주세요.', 'cashflow_sheet_mirror_required');
  }
  if (readOptionalText(mirror.sourceRevision) !== readOptionalText(parsed.expectedMirrorRevision)) {
    throw createHttpError(409, '검토 중인 시트 revision이 최신 고정본과 다릅니다.', 'cashflow_sheet_mirror_revision_conflict');
  }
  assertFreshCashflowSheetMirror(mirror);
  const configRevision = readOptionalText(mirror.configRevision);
  const existingRunSnap = await measureAsync('read', () => runRef.get());
  if (existingRunSnap.exists) {
    const existingRun = existingRunSnap.data() || {};
    assertStageRunRequestMatches(existingRun, requestHash);
    const response = hydrateCashflowSheetStageResponse(existingRun);
    if (response) {
      publishStageTimings();
      return response;
    }
    const reservationExpiresAt = Date.parse(readOptionalText(existingRun.reservationExpiresAt));
    if (readOptionalText(existingRun.status) === 'STAGING' && reservationExpiresAt > Date.now()) {
      throw stageRunInProgressError();
    }
  }

  const initialBuildStartedAt = cashflowStageMetricNow(performanceNow);
  const stageYear = parsed.yearMonth ? Number(parsed.yearMonth.slice(0, 4)) : Number(mirror.sourceYear);
  const calculationCells = (mirror.cells || []).filter((cell) => parsed.yearMonth
    ? readOptionalText(cell.yearMonth) >= '2023-01' && readOptionalText(cell.yearMonth) <= parsed.yearMonth
    : Number(readOptionalText(cell.yearMonth).slice(0, 4)) === stageYear);
  const pinnedCells = calculationCells;
  const pinnedMonths = [...groupPinnedCellsByMonth(pinnedCells).keys()].sort();
  const calculationSourceMonths = [...groupPinnedCellsByMonth(calculationCells).keys()].sort();
  const firstWeeklyYear = calculationSourceMonths[0]?.endsWith('-01')
    ? Number(calculationSourceMonths[0].slice(0, 4))
    : Number.NaN;
  const openingBalanceCells = Number.isSafeInteger(firstWeeklyYear)
    ? (mirror.annualCells || [])
      .filter((cell) => Number(cell?.year) < firstWeeklyYear)
      .map((cell) => stripUndefinedDeep({
        year: Number(cell.year),
        mode: readOptionalText(cell.mode),
        cashflowLine: readOptionalText(cell.lineId),
        cellState: readOptionalText(cell.state),
        ...(['VALUE', 'ZERO'].includes(readOptionalText(cell.state)) ? { amount: Number(cell.amount) } : {}),
      }))
    : [];
  const hasAnnualCells = !parsed.yearMonth && (mirror.annualCells || []).length > 0;
  phaseDurationMs.build += Math.max(0, cashflowStageMetricNow(performanceNow) - initialBuildStartedAt);
  if (pinnedMonths.length === 0 && !hasAnnualCells) {
    throw createHttpError(
      409,
      '고정한 시트에서 반영할 주차값이나 연간 합계를 찾을 수 없습니다.',
      'cashflow_sheet_stage_month_required',
    );
  }

  const cashflowSnapshot = await measureAsync('read', () => readCashflowWeeksSnapshot(db, tenantId, projectId));
  const currentTargetRevision = computeCashflowTargetRevision(cashflowSnapshot);
  // 시트가 진실(replaceAllActualSources)이어도, 팝업에서 본 diff 는 불러온 시점의 결산 상태 기준이다.
  // 그 사이 결산이 움직였으면 diff 가 거짓이 되므로 쓰기 모드와 무관하게 다시 불러오게 한다.
  if (currentTargetRevision !== readOptionalText(mirror.targetRevisionAtFetch)) {
    throw createHttpError(409, '시트 연동 후 캐시플로우 값이 변경되었습니다. 다시 연동해 주세요.', 'cashflow_sheet_target_revision_conflict');
  }
  const closedMonths = await measureAsync('read', () => readCanonicalClosedCashflowMonths({
    db,
    tenantId,
    projectId,
    yearMonths: pinnedMonths,
  }));
  const candidateBuildStartedAt = cashflowStageMetricNow(performanceNow);
  const candidatePinnedCells = parsed.yearMonth
    ? pinnedCells.filter((cell) => readOptionalText(cell.yearMonth) === parsed.yearMonth
      || closedMonths.has(readOptionalText(cell.yearMonth)))
    : pinnedCells;
  const now = new Date().toISOString();
  const reservationExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const weekly = buildPinnedSheetChangeCandidates({
    tenantId,
    projectId,
    runId,
    mirror: { ...mirror, cells: candidatePinnedCells },
    cashflowSnapshot,
    closedMonths,
    context,
    now,
  });
  const annual = parsed.yearMonth ? { candidates: [], documents: [], stagedYears: [] } : await buildPinnedAnnualChangeCandidates({
    db,
    tenantId,
    projectId,
    runId,
    mirror,
    context,
    now,
  });
  const candidates = [...weekly.candidates, ...annual.candidates];
  phaseDurationMs.build += Math.max(0, cashflowStageMetricNow(performanceNow) - candidateBuildStartedAt);
  // 결재 중인 회차 차단은 쓰기 모드와 무관하다. 7월에 replaceAllActualSources 에 묶여 꺼져 있었다.
  const pendingApproval = await measureAsync('read', () => readPendingApprovalDifferences({
    db, tenantId, projectId, candidates,
  }));
  const finalBuildStartedAt = cashflowStageMetricNow(performanceNow);
  const pendingBlockedMonths = new Set(pendingApproval.blockedMonths || []);
  const candidatesForStage = candidates.filter((candidate) => {
    if (pendingApproval.blockAllCandidates) return false;
    if (readOptionalText(candidate.scope) === 'annual') return true;
    return !pendingBlockedMonths.has(readOptionalText(candidate.yearMonth));
  });
  const stageAttemptId = randomUUID();
  const candidateManifestHash = cashflowChangeCandidateManifestHash(candidatesForStage);
  const annualForStage = pendingApproval.blockAllCandidates
    ? { candidates: [], documents: [], stagedYears: [] }
    : annual;
  const blockedMonths = [...new Set([
    ...weekly.blockedMonths,
    ...pendingApproval.blockedMonths,
  ])].sort();
  const riskLineCount = candidatesForStage.filter((candidate) => Array.isArray(candidate.riskFlags) && candidate.riskFlags.length > 0).length;
  const projectionLineCount = candidatesForStage.filter((candidate) => candidate.mode === 'projection').length;
  const actualLineCount = candidatesForStage.filter((candidate) => candidate.mode === 'actual').length;
  const cellsByMonth = groupPinnedCellsByMonth(calculationCells);
  const stagedMonths = [...new Set(candidatesForStage
    .map((candidate) => readOptionalText(candidate.yearMonth))
    .filter(Boolean))].sort();
  const lastStagedMonth = stagedMonths.at(-1) || '';
  const calculationMonths = lastStagedMonth
    ? calculationSourceMonths.filter((yearMonth) => yearMonth <= lastStagedMonth)
    : [];
  const stagedMonthDocuments = calculationMonths.map((yearMonth) => {
    const validated = validateCompletePinnedMonth(yearMonth, cellsByMonth.get(yearMonth) || []);
    if (!validated.ok) {
      throw createHttpError(
        409,
        `${yearMonth} 시트 값이 월 전체 구조를 충족하지 않습니다. 월 1주차부터 다시 연동해 주세요.`,
        'cashflow_sheet_month_incomplete',
      );
    }
    return stageMonthSnapshotDocument({
      tenantId,
      projectId,
      runId,
      mirror,
      yearMonth,
      cells: validated.cells,
      calculationChecks: monthCalculationChecks(mirror, yearMonth),
      now,
    });
  });
  const responseCandidates = [
    ...candidatesForStage.filter((candidate) => candidate.beforeHadValue),
    ...candidatesForStage.filter((candidate) => !candidate.beforeHadValue),
  ].slice(0, 3);
  const closedMonthDifferenceCount = weekly.closedMonthDifferences.reduce((sum, month) => sum + month.differenceCount, 0);
  const closedMonthDifferenceManifestHash = `sha256:${stableHash(weekly.closedMonthDifferences)}`;
  const response = {
    ok: true,
    commandName: 'cashflowSheetLab.stage.firebase',
    projectId,
    spreadsheetId: mirror.spreadsheetId,
    spreadsheetTitle: mirror.spreadsheetTitle,
    selectedSheetName: mirror.selectedSheetName,
    configRevision,
    sourceRevision: mirror.sourceRevision,
    targetRevisionAtFetch: mirror.targetRevisionAtFetch,
    replaceAllActualSources: Boolean(parsed.replaceAllActualSources),
    activeWeekRange: mirror.activeWeekRange,
    runId,
    status: blockedMonths.length > 0 || pendingApproval.contractIssues.length > 0 ? 'BLOCKED' : candidatesForStage.length === 0 ? 'NO_CHANGES' : 'READY',
    stagedLineCount: candidatesForStage.length,
    projectionLineCount,
    actualLineCount,
    riskLineCount,
    blockedMonths,
    closedMonthDifferences: weekly.closedMonthDifferences,
    closedMonthDifferenceCount,
    closedMonthDifferenceManifestHash,
    pendingApprovalDifferences: pendingApproval.differences,
    pendingApprovalDifferenceCount: pendingApproval.differenceCount,
    pendingApprovalDifferenceManifestHash: pendingApproval.manifestHash,
    pendingApprovalContractIssues: pendingApproval.contractIssues,
    stagedMonths,
    calculationMonths,
    stagedYears: annualForStage.stagedYears,
    annualLineCount: annualForStage.candidates.length,
    candidates: responseCandidates,
    omittedCandidateCount: Math.max(0, candidatesForStage.length - responseCandidates.length),
    lastStagedAt: now,
    lastStagedBy: {
      uid: readOptionalText(context?.actorId),
      email: readOptionalText(context?.actorEmail),
      role: readOptionalText(context?.actorRole) || 'workspace_user',
    },
  };
  const runDocument = stripUndefinedDeep({
    runId,
    tenantId,
    projectId,
    idempotencyKey: parsed.idempotencyKey,
    requestHash,
    stageAttemptId,
    candidateManifestHash,
    reservationExpiresAt,
    configRevision,
    sourceRevision: mirror.sourceRevision,
    targetRevisionAtFetch: mirror.targetRevisionAtFetch,
    replaceAllActualSources: Boolean(parsed.replaceAllActualSources),
    status: response.status,
    stagedLineCount: candidatesForStage.length,
    blockedMonths,
    closedMonthDifferences: weekly.closedMonthDifferences,
    closedMonthDifferenceCount,
    closedMonthDifferenceManifestHash,
    pendingApprovalEvidence: pendingApproval.evidence,
    pendingApprovalDifferences: pendingApproval.differences,
    pendingApprovalDifferenceCount: pendingApproval.differenceCount,
    pendingApprovalDifferenceManifestHash: pendingApproval.manifestHash,
    pendingApprovalContractIssues: pendingApproval.contractIssues,
    stagedMonths,
    calculationMonths,
    stagedYears: annualForStage.stagedYears,
    openingBalanceCells,
    appliedAnnualYears: Array.isArray(mirror.appliedAnnualYears) ? mirror.appliedAnnualYears.map(Number) : [],
    appliedWeeklyYears: Array.isArray(mirror.appliedWeeklyYears) ? mirror.appliedWeeklyYears.map(Number) : [],
    createdAt: now,
    createdBy: response.lastStagedBy,
  });
  const persistedResponse = response.status === 'NO_CHANGES'
    ? response
    : compactCashflowSheetStageResponse(response);
  phaseDurationMs.build += Math.max(0, cashflowStageMetricNow(performanceNow) - finalBuildStartedAt);
  const stageWriteStartedAt = cashflowStageMetricNow(performanceNow);
  const replay = await reserveCashflowSheetStageRun({
    db,
    runRef,
    requestHash,
    reservation: runDocument,
  });
  if (replay) {
    phaseDurationMs.write += Math.max(0, cashflowStageMetricNow(performanceNow) - stageWriteStartedAt);
    publishStageTimings();
    return replay;
  }
  let candidateBatchCount = 0;
  let persistedRunJsonBytes = 0;
  try {
    if (response.status === 'NO_CHANGES') {
      const mirrorRef = db.doc(cashflowSheetMirrorDocPath(tenantId, projectId));
      const cashflowQuery = db.collection(`orgs/${tenantId}/${CASHFLOW_WEEKS_COLLECTION_ID}`)
        .where('projectId', '==', projectId);
      const finalRunDocument = stripUndefinedDeep({
        ...runDocument,
        status: 'APPLIED',
        reservationExpiresAt: null,
        appliedAt: now,
        failedAt: null,
        failure: null,
        response: persistedResponse,
      });
      await db.runTransaction(async (transaction) => {
        const currentRunSnap = await transaction.get(runRef);
        const currentMirrorSnap = await transaction.get(mirrorRef);
        const currentCashflowSnap = await transaction.get(cashflowQuery);
        const currentRun = currentRunSnap.exists ? (currentRunSnap.data() || {}) : {};
        const currentMirror = currentMirrorSnap.exists ? (currentMirrorSnap.data() || {}) : {};
        assertFreshCashflowSheetMirror(currentMirror);
        if (
          readOptionalText(currentRun.status) !== 'STAGING'
          || readOptionalText(currentRun.requestHash) !== requestHash
          || readOptionalText(currentRun.stageAttemptId) !== stageAttemptId
          || readOptionalText(currentRun.candidateManifestHash) !== candidateManifestHash
          || readOptionalText(currentRun.reservationExpiresAt) !== reservationExpiresAt
          || readOptionalText(currentMirror.configRevision) !== configRevision
          || readOptionalText(currentMirror.sourceRevision) !== readOptionalText(mirror.sourceRevision)
          || readOptionalText(currentMirror.targetRevisionAtFetch) !== readOptionalText(mirror.targetRevisionAtFetch)
          || computeCashflowTargetRevision({
            weeks: currentCashflowSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
          }) !== readOptionalText(mirror.targetRevisionAtFetch)
        ) {
          throw createHttpError(409, '시트 검토 완료 상태가 변경되었습니다. 다시 확인해 주세요.', 'cashflow_sheet_stage_completion_conflict');
        }
        persistedRunJsonBytes = cashflowStageJsonBytes(stripUndefinedDeep({ ...currentRun, ...finalRunDocument }));
        transaction.set(runRef, finalRunDocument, { merge: true });
        // 바뀐 것이 없다 = 이 시점의 시트와 결산이 같다. source 만 올리고 target 을 안 올리면
        // 월결산·주정산 뒤 첫 불러오기부터 영원히 리비전 불일치로 남는다.
        transaction.set(mirrorRef, {
          appliedSourceRevision: mirror.sourceRevision,
          appliedTargetRevision: mirror.targetRevisionAtFetch,
          lastAppliedAt: now,
          lastAppliedBy: response.lastStagedBy,
        }, { merge: true });
      });
    } else {
      const candidatePersistence = await saveCashflowChangeCandidates({
        db,
        tenantId,
        candidates: candidatesForStage,
        candidateManifestHash,
        stageAttemptId,
        runRef,
        requestHash,
        reservationExpiresAt,
      });
      candidateBatchCount = candidatePersistence.batchCommitCount;
      const finalRunDocument = stripUndefinedDeep({
        ...runDocument,
        status: response.status,
        reservationExpiresAt: null,
        failedAt: null,
        failure: null,
        response: persistedResponse,
      });
      await db.runTransaction(async (transaction) => {
        const currentRunSnap = await transaction.get(runRef);
        const currentRun = currentRunSnap.exists ? (currentRunSnap.data() || {}) : {};
        if (
          readOptionalText(currentRun.status) !== 'STAGING'
          || readOptionalText(currentRun.requestHash) !== requestHash
          || readOptionalText(currentRun.stageAttemptId) !== stageAttemptId
          || readOptionalText(currentRun.candidateManifestHash) !== candidateManifestHash
          || readOptionalText(currentRun.reservationExpiresAt) !== reservationExpiresAt
        ) {
          throw createHttpError(
            409,
            '시트 검토 완료 상태가 변경되었습니다. 다시 확인해 주세요.',
            'cashflow_sheet_stage_completion_conflict',
          );
        }
        persistedRunJsonBytes = cashflowStageJsonBytes(stripUndefinedDeep({ ...currentRun, ...finalRunDocument }));
        for (const month of stagedMonthDocuments) {
          transaction.set(
            db.doc(cashflowSheetStageMonthDocPath(tenantId, runId, month.yearMonth)),
            month,
          );
        }
        for (const yearDocument of annualForStage.documents) {
          transaction.set(
            db.doc(cashflowSheetStageYearDocPath(tenantId, runId, yearDocument.year)),
            yearDocument,
          );
        }
        transaction.set(runRef, finalRunDocument, { merge: true });
      });
    }
  } catch (error) {
    await db.runTransaction(async (transaction) => {
      const currentRunSnap = await transaction.get(runRef);
      const currentRun = currentRunSnap.exists ? (currentRunSnap.data() || {}) : {};
      if (
        readOptionalText(currentRun.status) !== 'STAGING'
        || readOptionalText(currentRun.stageAttemptId) !== stageAttemptId
        || readOptionalText(currentRun.reservationExpiresAt) !== reservationExpiresAt
      ) return;
      transaction.set(runRef, stripUndefinedDeep({
        status: 'STAGING_FAILED',
        reservationExpiresAt: null,
        failedAt: new Date().toISOString(),
        failure: routeErrorDetails(error),
      }), { merge: true });
    }).catch(() => null);
    throw error;
  }
  phaseDurationMs.write += Math.max(0, cashflowStageMetricNow(performanceNow) - stageWriteStartedAt);
  publishStageTimings();
  try {
    onMetric({
      phase: 'stage_persistence',
      outcome: 'ok',
      candidateCount: candidatesForStage.length,
      candidateBatchCount,
      persistedRunJsonBytes,
    });
  } catch {
    // Diagnostics must never affect a financial stage.
  }
  logger('ok', {
    projectId,
    sourceRevision: mirror.sourceRevision,
    stagedLineCount: candidatesForStage.length,
    projectionLineCount,
    actualLineCount,
    riskCount: riskLineCount,
    blockedMonths,
  });
  return response;
}

function createSheetPreviewLoader({ googleSheetsService, cacheTtlMs = DEFAULT_SHEET_PREVIEW_CACHE_TTL_MS } = {}) {
  const cache = new Map();
  const inFlight = new Map();

  function cacheKey({ value, sheetName }) {
    return JSON.stringify({
      value: readOptionalText(value),
      sheetName: readOptionalText(sheetName),
      rangeA1: CASHFLOW_SHEET_LAB_READ_RANGE,
      auth: 'service',
    });
  }

  return async function loadSheetPreview(params) {
    const key = cacheKey(params);
    const bypassCache = params?.bypassCache === true;
    const cached = bypassCache ? null : cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.value, cacheStatus: 'hit' };
    }

    const running = inFlight.get(key);
    if (running) {
      const value = await running;
      return { ...value, cacheStatus: 'in_flight_join' };
    }

    const request = (async () => {
      const authMode = 'service_account';
      const preview = await googleSheetsService.previewSpreadsheet({
        value: params.value,
        sheetName: params.sheetName,
        rangeA1: CASHFLOW_SHEET_LAB_READ_RANGE,
        ...(!params.sheetName ? { selectSheet: findCashflowUsageLinkedSheet } : {}),
      });
      return { ...preview, authMode };
    })();
    inFlight.set(key, request);
    try {
      const value = await request;
      if (!bypassCache && cacheTtlMs > 0) {
        cache.set(key, {
          value,
          expiresAt: Date.now() + cacheTtlMs,
        });
      }
      return { ...value, cacheStatus: 'miss' };
    } finally {
      inFlight.delete(key);
    }
  };
}

export function mountCashflowSheetLabRoutes(app, {
  db,
  googleSheetsService,
  enabled = true,
  env = process.env,
  javaWeeklyClient,
  workspaceEmailDomain = 'mysc.co.kr',
  sheetPreviewCacheTtlMs = DEFAULT_SHEET_PREVIEW_CACHE_TTL_MS,
  performanceLogger,
  performanceNow,
} = {}) {
  if (enabled === false) {
    app.use('/api/v1/projects/:projectId/cashflow-sheet-lab', (_req, res) => {
      res.status(404).json({
        code: 'cashflow_sheet_lab_not_available',
        message: 'Cashflow sheet lab is not available on this deployment surface.',
      });
    });
    return;
  }

  const loadSheetPreview = createSheetPreviewLoader({
    googleSheetsService,
    cacheTtlMs: sheetPreviewCacheTtlMs,
  });
  const loadSheetFreshness = (value) => (
    typeof googleSheetsService?.getSpreadsheetFreshness === 'function'
      ? googleSheetsService.getSpreadsheetFreshness(value)
      : Promise.resolve(null)
  );
  const deployEnv = readOptionalText(env.BFF_DEPLOY_ENV).toLowerCase() || 'local';
  const authoritativeWritesEnabled = deployEnv === 'live'
    || (deployEnv === 'local' && Boolean(javaWeeklyClient));
  const authoritativeJavaClient = authoritativeWritesEnabled
    ? (javaWeeklyClient || createJavaWeeklyClient({ env, performanceLogger, performanceNow }))
    : null;
  const systemAccountEmail = resolveSystemAccountEmail(googleSheetsService);

  app.get('/api/v1/projects/:projectId/cashflow-sheet-lab/config', asyncHandler(async (req, res) => {
    assertCashflowSheetLabAccess(req, workspaceEmailDomain);

    const { tenantId } = req.context;
    const { projectId } = req.params;
    const project = await readProjectDocument(db, tenantId, projectId);
    const sourceYear = resolveSourceYear(req.query.sourceYear, project?.cashflowSheetLab || {}, project);
    const config = readCashflowSheetLabConfig(project, sourceYear);
    res.status(200).json(buildConfigResponse(projectId, config, systemAccountEmail, project));
  }));

  app.get('/api/v1/projects/:projectId/cashflow-sheet-lab/mirror', asyncHandler(async (req, res) => {
    assertCashflowSheetLabAccess(req, workspaceEmailDomain);
    const { tenantId } = req.context;
    const { projectId } = req.params;
    const project = await readProjectDocument(db, tenantId, projectId);
    const mirror = await readCashflowSheetMirror(db, tenantId, projectId);
    res.status(200).json(attachFinancialYearChecks(mirror, project) || { projectId, status: 'EMPTY' });
  }));

  app.get('/api/v1/projects/:projectId/cashflow-sheet-lab/apply-status', asyncHandler(async (req, res) => {
    assertCashflowSheetLabAccess(req, workspaceEmailDomain);
    const { tenantId } = req.context;
    const { projectId } = req.params;
    await readProjectDocument(db, tenantId, projectId);
    res.status(200).json(await readCashflowSheetApplyStatus({ db, tenantId, projectId }));
  }));

  app.post('/api/v1/projects/:projectId/cashflow-sheet-lab/apply-lock/release', asyncHandler(async (req, res) => {
    assertCashflowSheetApplyLockAdmin(req);
    const { tenantId } = req.context;
    const { projectId } = req.params;
    const reason = readOptionalText(req.body?.reason);
    if (!reason) {
      throw createHttpError(
        422,
        '해제 사유를 입력해 주세요.',
        'cashflow_sheet_apply_lock_release_reason_required',
      );
    }
    await readProjectDocument(db, tenantId, projectId);
    const result = await releaseCashflowSheetApplyLock({
      db,
      tenantId,
      projectId,
      force: true,
      reason,
      actor: req.context,
    });
    res.status(200).json({
      projectId,
      released: result.released,
      status: result.released ? 'READY' : result.lease.status || 'IDLE',
      stagedRunId: result.stagedRunId || '',
      releasedAt: result.releasedAt || '',
    });
  }));

  // traceRef 는 라우트가 구간 기록을 응답 헤더로 내보내기 위한 통로다. 내부 호출(비교 관측)은
  // 넘기지 않으므로 헤더도 붙지 않는다.
  const executeCashflowSheetMirrorRefresh = async (req, traceRef) => {
    const trace = createCashflowPerformanceTrace({
      requestId: req.context?.requestId || req.requestId,
      operation: 'cashflow.sheet_mirror.refresh',
      ...(performanceLogger ? { logger: performanceLogger } : {}),
      ...(performanceNow ? { now: performanceNow } : {}),
    });
    if (traceRef) traceRef.trace = trace;
    const { tenantId } = req.context;
    const { projectId } = req.params;
    const parsed = parseWithSchema(
      cashflowSheetLabMirrorRefreshSchema,
      req.body,
      'Invalid cashflow sheet mirror refresh payload',
    );
    const project = await trace.measure(
      'project_read',
      () => readProjectDocument(db, tenantId, projectId),
    );
    const sourceYear = resolveSourceYear(parsed.sourceYear, parsed, project);
    const source = resolvePreviewSource(
      { ...parsed, sourceYear },
      readCashflowSheetLabConfig(project, sourceYear),
    );
    const weekRange = normalizeWeekRange(source);
    const configRevision = computeCashflowSheetConfigRevision({ ...source, ...weekRange });
    const previousMirror = await trace.measure(
      'mirror_read',
      () => readCashflowSheetMirror(db, tenantId, projectId),
    );
    const refreshRequestHash = stableHash({
      sourceYear,
      value: source.value,
      sheetName: source.sheetName || '',
      startWeek: weekRange.startWeek,
      endWeek: weekRange.endWeek,
    });
    const attemptedAt = new Date().toISOString();
    if (
      readOptionalText(previousMirror?.lastRefreshIdempotencyKey) === parsed.idempotencyKey
      && readOptionalText(previousMirror?.lastRefreshRequestHash) !== refreshRequestHash
    ) {
      throw createHttpError(409, '같은 idempotencyKey에 다른 시트 연동 요청을 사용할 수 없습니다.', 'idempotency_key_reused');
    }
    // 불러오기는 항상 시트를 통째로 읽는다. 예전엔 Drive modifiedTime 이 같으면 건너뛰었는데,
    // Drive 는 편집 뒤 수십 초~2분 동안 옛 modifiedTime 을 돌려줘서 "방금 고쳤는데 안 바뀜"
    // 이 됐다. 사용자가 누르는 이유는 고쳤기 때문이므로 그 절약은 가치가 없었다(2026-08-19).
    // modifiedTime 은 changes/probe 의 "불러오기 필요" 표시용으로만 기록한다.
    let freshness = null;
    const refreshRun = await trace.measure(
      'refresh_reserve',
      () => beginCashflowSheetRefreshRun({
        db,
        tenantId,
        projectId,
        idempotencyKey: parsed.idempotencyKey,
        requestHash: refreshRequestHash,
        configRevision,
        attemptedAt,
        context: req.context,
      }),
    );
    if (refreshRun.replay) {
      return refreshRun.replay;
    }
    if (readOptionalText(previousMirror?.lastRefreshIdempotencyKey) === parsed.idempotencyKey) {
      const completedMirror = await completeCashflowSheetRefreshRun({
        db,
        tenantId,
        projectId,
        runRef: refreshRun.runRef,
        requestHash: refreshRequestHash,
        generation: refreshRun.generation,
        response: previousMirror,
        completedAt: attemptedAt,
      });
      return completedMirror;
    }

    logCashflowSheetLab('mirror.refresh.start', req, {
      projectId,
      authMode: 'service_account',
      source: source.source,
      sheetName: source.sheetName || null,
      startWeek: weekRange.startWeek || null,
      endWeek: weekRange.endWeek || null,
    });

    try {
      if (!freshness) {
        freshness = await trace.measure(
          'freshness_probe',
          () => loadSheetFreshness(source.value).catch(() => null),
        );
      }
      const preview = await trace.measure(
        'google_sheet_fetch',
        () => loadSheetPreview({
          value: source.value,
          sheetName: source.sheetName,
          bypassCache: true,
        }),
      );
      assertCashflowUsageLinkedSheet(preview);
      const template = trace.measureSync(
        'sheet_parse_validate',
        () => analyzeCashflowSheetTemplate(preview.matrix),
      );
      assertConfiguredWeekRangeExistsInTemplate(template, weekRange);
      if (!template.supported) {
        throw Object.assign(createHttpError(
          400,
          '시트 양식이 표준과 다릅니다. 표시된 칸을 표준 양식으로 맞춘 뒤 다시 불러와 주세요.',
          'cashflow_sheet_template_unsupported',
        ), {
          diagnostics: template.reasons.slice(0, 20),
          diagnosticCount: template.reasons.length,
        });
      }

      const targetSnapshot = await trace.measure(
        'target_snapshot_read',
        () => readCashflowWeeksSnapshot(db, tenantId, projectId),
      );
      const mappings = template.mappingCandidates.filter((mapping) => isInWeekRange(mapping, weekRange));
      const mirror = trace.measureSync('mirror_build', () => createCashflowPinnedSnapshot({
        projectId,
        spreadsheetId: preview.spreadsheetId,
        spreadsheetTitle: preview.spreadsheetTitle,
        selectedSheetName: preview.selectedSheetName,
        mappings,
        matrix: preview.matrix,
        template,
        targetSnapshot,
        capturedAt: attemptedAt,
        capturedBy: {
          uid: req.context?.actorId,
          email: req.context?.actorEmail,
          role: req.context?.actorRole || 'workspace_user',
        },
      }));
      mirror.weeklyYear = template.weeklyYear;
      mirror.sheetContract = template.contract;
      mirror.activeWeekRange = {
        startWeek: weekRange.startWeek,
        endWeek: weekRange.endWeek,
        weekBasis: CASHFLOW_WEEK_BASIS,
        totalBasis: CASHFLOW_WEEK_BASIS,
        activeWeeks: buildActiveWeeksFromTemplate(template, weekRange),
      };
      mirror.configRevision = configRevision;
      // 데이터 읽기 이전에 찍은 값. 다음 불러오기의 변경 감지 기준.
      mirror.sourceFileModifiedTime = freshness?.modifiedTime || null;
      mirror.lastRefreshAttemptAt = attemptedAt;
      mirror.lastRefreshIdempotencyKey = parsed.idempotencyKey;
      mirror.lastRefreshRequestHash = refreshRequestHash;
      const mergedMirror = mergeCashflowSourceMirror(previousMirror, mirror, sourceYear);
      const completedMirror = await trace.measure(
        'mirror_publish',
        () => completeCashflowSheetRefreshRun({
          db,
          tenantId,
          projectId,
          runRef: refreshRun.runRef,
          requestHash: refreshRequestHash,
          generation: refreshRun.generation,
          response: mergedMirror,
          completedAt: new Date().toISOString(),
        }),
      );
      logCashflowSheetLab('mirror.refresh.ok', req, {
        projectId,
        sourceRevision: completedMirror.sourceRevision,
        targetRevisionAtFetch: completedMirror.targetRevisionAtFetch,
        ...completedMirror.summary,
      });
      return completedMirror;
    } catch (error) {
      const normalized = normalizeRouteError(error);
      const diagnostics = Array.isArray(normalized?.diagnostics) ? normalized.diagnostics : [];
      const lastRefreshError = {
        code: normalized?.code || normalized?.name || 'error',
        message: normalized?.message || '시트 연동에 실패했습니다.',
        statusCode: normalized?.statusCode || 500,
        at: attemptedAt,
        ...(diagnostics.length > 0 ? {
          diagnostics,
          diagnosticCount: Number(normalized?.diagnosticCount) || diagnostics.length,
        } : {}),
      };
      const mirror = previousMirror?.sourceRevision
        ? {
          ...previousMirror,
          status: 'STALE',
          lastRefreshAttemptAt: attemptedAt,
          lastRefreshError,
          lastRefreshIdempotencyKey: parsed.idempotencyKey,
          lastRefreshRequestHash: refreshRequestHash,
        }
        : {
          schemaVersion: 1,
          projectId,
          status: 'ERROR',
          lastRefreshAttemptAt: attemptedAt,
          lastRefreshError,
          lastRefreshIdempotencyKey: parsed.idempotencyKey,
          lastRefreshRequestHash: refreshRequestHash,
        };
      const completedMirror = await trace.measure(
        'mirror_publish_error',
        () => completeCashflowSheetRefreshRun({
          db,
          tenantId,
          projectId,
          runRef: refreshRun.runRef,
          requestHash: refreshRequestHash,
          generation: refreshRun.generation,
          response: mirror,
          completedAt: new Date().toISOString(),
        }),
      );
      logCashflowSheetLab('mirror.refresh.failed', req, {
        projectId,
        mirrorStatus: completedMirror.status,
        ...routeErrorDetails(normalized),
      }, 'warn');
      return completedMirror;
    }
  };

  app.post('/api/v1/projects/:projectId/cashflow-sheet-lab/mirror/refresh', asyncHandler(async (req, res) => {
    assertCashflowSheetLabAccess(req, workspaceEmailDomain);
    const traceRef = {};
    const mirror = await executeCashflowSheetMirrorRefresh(req, traceRef);
    // 불러오기가 20초씩 걸릴 때 구글 왕복인지 파싱인지 Firestore 쓰기인지 브라우저에서 바로 갈린다.
    if (traceRef.trace) res.set('Server-Timing', traceRef.trace.serverTiming());
    res.status(200).json(mirror);
  }));

  // modifiedTime(~수십 ms)만 저장된 고정본과 대조해 "변경됨/없음"만 판정한다 - 건수·diff
  // 는 계산하지 않는다. 판정 불능(probe 실패, 미러 없음)은 보수적으로 "불러오기 필요"로
  // 기울인다 - 낡은 값을 최신이라 말하지 않는다.
  app.post('/api/v1/projects/:projectId/cashflow-sheet-lab/changes/probe', asyncHandler(async (req, res) => {
    assertCashflowSheetLabAccess(req, workspaceEmailDomain);
    const { tenantId } = req.context;
    const { projectId } = req.params;
    const checkedAt = new Date().toISOString();
    try {
      const project = await readProjectDocument(db, tenantId, projectId);
      const configs = readCashflowSheetLabConfigs(project);
      if (configs.length === 0) {
        throw createHttpError(400, 'Cashflow sheet URL is not configured.', 'cashflow_sheet_config_required');
      }
      const mirror = await readCashflowSheetMirror(db, tenantId, projectId);
      if (!mirror || readOptionalText(mirror.status) !== 'FRESH' || !readOptionalText(mirror.sourceRevision)) {
        res.status(200).json({
          status: 'AVAILABLE', mirrorLoaded: false, sheetChangedSinceMirror: true, checkedAt,
        });
        return;
      }
      // 미러의 sourceFileModifiedTime 은 마지막으로 불러온 소스 하나의 값이다. 단일 소스
      // 프로젝트(대부분)는 정확하고, 멀티 소스는 하나라도 새로우면 changed 로 기운다.
      const storedModifiedTime = readOptionalText(mirror.sourceFileModifiedTime);
      if (!storedModifiedTime) {
        res.status(200).json({
          status: 'AVAILABLE', mirrorLoaded: true, sheetChangedSinceMirror: true, checkedAt,
        });
        return;
      }
      let changed = false;
      for (const config of configs) {
        const freshness = await loadSheetFreshness(config.value);
        if (!freshness?.modifiedTime) { changed = true; break; }
        if (configs.length > 1 || freshness.modifiedTime !== storedModifiedTime) {
          if (freshness.modifiedTime !== storedModifiedTime) { changed = true; break; }
        }
      }
      res.status(200).json({
        status: 'AVAILABLE',
        mirrorLoaded: true,
        sheetChangedSinceMirror: changed,
        checkedAt,
      });
    } catch (error) {
      logCashflowSheetLab('changes.probe.unavailable', req, {
        projectId,
        ...routeErrorDetails(normalizeRouteError(error)),
      }, 'warn');
      // probe 실패는 판정 불능이다. 조용히 '변경 없음'이라 하지 않는다.
      res.status(200).json({
        status: 'UNAVAILABLE', mirrorLoaded: false, sheetChangedSinceMirror: false, checkedAt,
      });
    }
  }));

  app.put('/api/v1/projects/:projectId/cashflow-sheet-lab/config', asyncHandler(async (req, res) => {
    assertCashflowSheetLabAccess(req, workspaceEmailDomain);

    const { tenantId } = req.context;
    const { projectId } = req.params;
    const parsed = parseWithSchema(cashflowSheetLabConfigSchema, req.body, 'Invalid cashflow sheet lab config payload');
    logCashflowSheetLab('config.save.start', req, {
      projectId,
      authMode: 'bff_config_only',
      sheetName: parsed.sheetName || null,
      valueProvided: Boolean(parsed.value),
      startWeek: null,
      endWeek: null,
    });

    const project = await readProjectDocument(db, tenantId, projectId);

    try {
      const config = await saveCashflowSheetLabConfig({
        db,
        tenantId,
        projectId,
        project,
        parsed,
        context: req.context,
        existingConfig: readCashflowSheetLabConfig(project, parsed.sourceYear),
      });
      logCashflowSheetLab('config.save.ok', req, {
        projectId,
        authMode: 'bff_config_only',
        spreadsheetId: config.spreadsheetId,
        selectedSheetName: config.sheetName,
        weekBasis: CASHFLOW_WEEK_BASIS,
      });
      res.status(200).json(buildConfigResponse(projectId, config, systemAccountEmail, {
        ...project,
        cashflowSheetLab: config,
        cashflowSheetLabSources: {
          ...(project.cashflowSheetLabSources || {}),
          [String(config.sourceYear)]: config,
        },
      }));
    } catch (error) {
      logCashflowSheetLab('config.save.error', req, {
        projectId,
        authMode: 'bff_config_only',
        ...routeErrorDetails(normalizeRouteError(error)),
      }, 'warn');
      throw normalizeRouteError(error);
    }
  }));

  app.post('/api/v1/projects/:projectId/cashflow-sheet-lab/preview', asyncHandler(async (req) => {
    assertCashflowSheetLabAccess(req, workspaceEmailDomain);
    throw createHttpError(
      410,
      '직접 시트 미리보기는 종료되었습니다. 시트 연동하기로 고정본을 만든 뒤 검토해 주세요.',
      'cashflow_sheet_direct_preview_retired',
    );
  }));

  app.post('/api/v1/projects/:projectId/cashflow-sheet-lab/writeback/preview', asyncHandler(async (req) => {
    assertCashflowSheetLabAccess(req, workspaceEmailDomain);
    throw createHttpError(
      410,
      '캐시플로 시트 연동은 조회 전용입니다.',
      'cashflow_sheet_writeback_retired',
    );
  }));

  app.post('/api/v1/projects/:projectId/cashflow-sheet-lab/writeback/apply', asyncHandler(async (req) => {
    assertCashflowSheetLabAccess(req, workspaceEmailDomain);
    throw createHttpError(
      410,
      '캐시플로 시트 연동은 조회 전용입니다.',
      'cashflow_sheet_writeback_retired',
    );
  }));

  app.post('/api/v1/projects/:projectId/cashflow-sheet-lab/apply', asyncHandler(async (req, res) => {
    assertCashflowSheetLabAccess(req, workspaceEmailDomain);
    if (!authoritativeWritesEnabled) {
      throw createHttpError(503, '현재 환경에서는 캐시플로를 저장할 수 없습니다. 담당자에게 문의해 주세요.', 'unsafe_bff_runtime');
    }
    if (!javaWeeklyClient) assertCashflowMutationRuntime({}, env);
    const { tenantId } = req.context;
    const { projectId } = req.params;
    const parsed = parseWithSchema(cashflowSheetLabApplySchema, req.body, 'Invalid cashflow sheet lab apply payload');
    const project = await readProjectDocument(db, tenantId, projectId);
    const deprecatedGoogleAccessTokenIgnored = Boolean(readOptionalText(req.header('x-google-access-token')));
    const idempotencyKey = readOptionalText(parsed.idempotencyKey) || readOptionalText(req.context?.idempotencyKey);
    if (authoritativeWritesEnabled && !idempotencyKey) {
      throw createHttpError(400, 'idempotencyKey is required for cashflow apply.', 'idempotency_key_required');
    }

    try {
      const stagedRunId = readOptionalText(parsed.stageRunId);
      if (!stagedRunId) {
        throw createHttpError(
          400,
          '최종 반영 전에 시트 연동과 변경 검토가 필요합니다.',
          'cashflow_sheet_stage_run_required',
        );
      }
      const result = await applyStagedCashflowSheetLab({
        db,
        tenantId,
        projectId,
        parsed,
        context: req.context,
        javaWeeklyClient: authoritativeJavaClient,
        editSession: null,
        resolveEditSession: null,
        idempotencyKey,
        logger: (event, details = {}, level = 'info') => {
          logCashflowSheetLab(`apply.${event}`, req, details, level);
        },
      });
      res.status(200).json(result);
    } catch (error) {
      logCashflowSheetLab('apply.error', req, {
        projectId,
        authMode: 'service_account',
        deprecatedGoogleAccessTokenIgnored,
        ...routeErrorDetails(normalizeRouteError(error)),
      }, 'warn');
      throw normalizeRouteError(error);
    }
  }));

  app.post('/api/v1/projects/:projectId/cashflow-sheet-lab/stage', asyncHandler(async (req, res) => {
    assertCashflowSheetLabAccess(req, workspaceEmailDomain);
    const trace = createCashflowPerformanceTrace({
      requestId: req.context?.requestId || req.requestId,
      operation: 'cashflow.sheet_stage',
      ...(performanceLogger ? { logger: performanceLogger } : {}),
      ...(performanceNow ? { now: performanceNow } : {}),
    });
    const { tenantId } = req.context;
    const { projectId } = req.params;
    const parsed = parseWithSchema(cashflowSheetLabStageSchema, req.body, 'Invalid cashflow sheet lab stage payload');
    await readProjectDocument(db, tenantId, projectId);

    try {
      const result = await trace.measure('stage_total', () => stagePinnedCashflowSheetLab({
        db,
        tenantId,
        projectId,
        parsed,
        context: req.context,
        trace,
        performanceNow,
        onMetric: (metric) => emitCashflowStageMetric(performanceLogger, {
          severity: 'INFO',
          message: 'cashflow.performance',
          requestId: req.context?.requestId || req.requestId || 'unknown',
          operation: 'cashflow.sheet_stage',
          ...metric,
        }),
        logger: (event, details = {}, level = 'info') => {
          logCashflowSheetLab(`stage.${event}`, req, details, level);
        },
      }));
      try {
        res.set('Server-Timing', trace.serverTiming());
      } catch {
        // Diagnostics must never affect a financial stage.
      }
      res.status(200).json(result);
    } catch (error) {
      logCashflowSheetLab('stage.error', req, {
        projectId,
        authMode: 'service_account',
        ...routeErrorDetails(normalizeRouteError(error)),
      }, 'warn');
      throw normalizeRouteError(error);
    }
  }));

}
