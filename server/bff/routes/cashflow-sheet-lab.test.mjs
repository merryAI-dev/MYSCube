import express from 'express';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  assertJavaCashflowMatchesFirestore,
  assertJavaCashflowReadbackMatchesAppliedMonths,
  mountCashflowSheetLabRoutes,
} from './cashflow-sheet-lab.mjs';
import { GoogleSheetsServiceError } from '../google-sheets.mjs';
import { stableStringify } from '../utils.mjs';

const PROJECTION_IN_LABELS = [
  'MYSC 선입금 - 직접사업비 등',
  'MYSC 선입금 - MYSC 인건비',
  'MYSC 선입금 - 매입부가세',
  '매출액(입금)',
  '매출부가세(입금)',
  '팀지원금(입금)',
  '은행이자(입금)',
];

const PROJECTION_OUT_LABELS = [
  'MYSC 선입금 - 직접사업비 등',
  'MYSC 선입금 - MYSC 인건비',
  '직접사업비(공급가액)',
  '매입부가세',
  'MYSC인건비',
  'MYSC수익',
  '매출부가세(출금)',
  '팀지원금(출금)',
  '은행이자(출금)',
];

const ACTUAL_IN_LABELS = [
  'MYSC 선입금 - 직접사업비 등(입금)',
  'MYSC 선입금 - MYSC 인건비(입금)',
  'MYSC 선입금 - 매입부가세(입금)',
  ...PROJECTION_IN_LABELS.slice(3),
];

const ACTUAL_OUT_LABELS = [
  'MYSC 선입금 - 직접사업비 등(출금)',
  'MYSC 선입금 - MYSC 인건비(출금)',
  ...PROJECTION_OUT_LABELS.slice(2),
];

const JANUARY_FINANCE_WEEKS = ['26-1-1', '26-1-2', '26-1-3', '26-1-4', '26-1-5'];
const FULL_YEAR_FINANCE_WEEKS = Array.from({ length: 12 }, (_, monthIndex) => (
  Array.from({ length: 5 }, (_unused, weekIndex) => `26-${monthIndex + 1}-${weekIndex + 1}`)
)).flat();
function officialAnnualColumns(sourceYear) {
  return new Map([
    [sourceYear - 2, 2],
    [sourceYear - 1, 3],
    [sourceYear + 1, 64],
    [sourceYear + 2, 65],
    [sourceYear + 3, 66],
    [sourceYear + 4, 67],
    [sourceYear + 5, 68],
    [sourceYear + 6, 69],
    [sourceYear, 70],
  ]);
}
const CASHFLOW_LINE_IDS = [
  'MYSC_PREPAY_IN', 'MYSC_PREPAY_LABOR_IN', 'MYSC_PREPAY_INPUT_VAT_IN',
  'SALES_IN', 'SALES_VAT_IN', 'TEAM_SUPPORT_IN', 'BANK_INTEREST_IN',
  'MYSC_PREPAY_DIRECT_OUT', 'MYSC_PREPAY_LABOR_OUT', 'DIRECT_COST_OUT',
  'INPUT_VAT_OUT', 'MYSC_LABOR_OUT', 'MYSC_PROFIT_OUT', 'SALES_VAT_OUT',
  'TEAM_SUPPORT_OUT', 'BANK_INTEREST_OUT',
];

function closeHash(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function stageManifestHash(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function cumulativeMonths(throughMonth) {
  const months = [];
  for (let year = 2023, month = 1; `${year}-${String(month).padStart(2, '0')}` <= throughMonth;) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }
  return months;
}

function cumulativeCloseRequestDocuments({ status = 'PENDING', throughMonth = '2026-01', cycleYearMonth = throughMonth } = {}) {
  const requestId = `project-a-${cycleYearMonth}`;
  const revision = 1;
  const source = { kind: 'PINNED_MIRROR', sourceRevision: 'source-a', targetRevision: 'target-a' };
  const shards = cumulativeMonths(throughMonth).map((yearMonth) => {
    const base = {
      contractVersion: 'cashflow-cumulative-close-v2',
      requestId,
      requestRevision: revision,
      projectId: 'project-a',
      yearMonth,
      cells: ['projection', 'actual'].flatMap((mode) => Array.from({ length: 5 }, (_unused, weekIndex) => (
        CASHFLOW_LINE_IDS.map((cashflowLine) => ({
          mode,
          weekNo: weekIndex + 1,
          cashflowLine,
          cellState: yearMonth === throughMonth && mode === 'projection' && weekIndex === 0 && cashflowLine === CASHFLOW_LINE_IDS[0]
            ? 'ZERO'
            : 'EMPTY',
          amount: yearMonth === throughMonth && mode === 'projection' && weekIndex === 0 && cashflowLine === CASHFLOW_LINE_IDS[0]
            ? 0
            : null,
        }))
      )).flat()),
      source,
    };
    return { ...base, shardHash: closeHash(base) };
  });
  const manifest = {
    contractVersion: 'cashflow-cumulative-close-v2',
    requestId,
    requestRevision: revision,
    projectId: 'project-a',
    fromMonth: '2023-01',
    yearMonth: cycleYearMonth,
    months: shards.map((shard) => ({ yearMonth: shard.yearMonth, shardHash: shard.shardHash })),
  };
  return Object.fromEntries([
    [`orgs/tenant-a/cashflow_month_close_requests/${requestId}`, {
      contractVersion: 'cashflow-cumulative-close-v2',
      requestId,
      tenantId: 'tenant-a',
      projectId: 'project-a',
      fromMonth: '2023-01',
      yearMonth: cycleYearMonth,
      ...(cycleYearMonth !== throughMonth ? { throughMonth } : {}),
      status,
      revision,
      manifestHash: closeHash(manifest),
      monthCount: shards.length,
      weekCount: shards.length * 5,
      cellCount: shards.length * 160,
    }],
    ...shards.map((shard) => [
      `orgs/tenant-a/cashflow_month_close_request_months/${requestId}-r${revision}-${shard.yearMonth}`,
      shard,
    ]),
  ]);
}

function matchingCanonicalWeeks(cellCount, yearMonths = ['2026-01']) {
  const weeks = new Map(yearMonths.flatMap((yearMonth) => Array.from({ length: 5 }, (_unused, index) => {
    const weekNo = index + 1;
    return [`${yearMonth}:${weekNo}`, {
      id: `project-a-${yearMonth}-w${weekNo}`,
      projectId: 'project-a',
      yearMonth,
      weekNo,
      projection: {},
      actual: {},
    }];
  })));
  yearMonths.flatMap((yearMonth) => ['projection', 'actual'].flatMap((mode) => Array.from({ length: 5 }, (_unused, weekIndex) => (
    CASHFLOW_LINE_IDS.map((lineId) => ({ yearMonth, mode, weekNo: weekIndex + 1, lineId }))
  )).flat())).slice(0, cellCount).forEach((cell) => {
    weeks.get(`${cell.yearMonth}:${cell.weekNo}`)[cell.mode][cell.lineId] = 999;
  });
  return [...weeks.values()];
}

function javaApplyResponse(request, resultingTargetRevision) {
  const lines = (request.cells || []).filter((cell) => ['VALUE', 'ZERO'].includes(cell.cellState));
  const calculationChecks = (request.calculationChecks || []).map((check) => ({
    ...check,
    calculated: {
      openingBalance: check.reported.openingBalance ?? 0,
      depositTotal: check.reported.depositTotal ?? 0,
      withdrawalTotal: check.reported.withdrawalTotal ?? 0,
      balance: check.reported.balance ?? 0,
    },
    matches: { depositTotal: true, withdrawalTotal: true, balance: true },
  }));
  return {
    ok: true,
    commandName: 'weeklyExpense.cashflowSheetLab.apply',
    projectId: request.projectId,
    sourceSheetKey: 'cashflow-sheet-lab',
    yearMonth: request.yearMonth,
    sourceRevision: request.sourceRevision,
    targetRevision: request.targetRevision,
    resultingTargetRevision,
    projection: lines
      .filter((cell) => cell.mode === 'projection')
      .map((cell) => ({
        yearMonth: request.yearMonth,
        weekNo: cell.weekNo,
        cashflowLine: cell.cashflowLine,
        amount: cell.amount,
      })),
    actual: lines
      .filter((cell) => cell.mode === 'actual')
      .map((cell) => ({
        sheetKey: 'cashflow-sheet-lab',
        yearMonth: request.yearMonth,
        weekNo: cell.weekNo,
        cashflowLine: cell.cashflowLine,
        amount: cell.amount,
      })),
    settledWeekChanges: [],
    calculationChecks,
  };
}

function javaBatchApplyResponse(request, resultingTargetRevision) {
  const months = (request.months || []).filter((month) => month.apply !== false).map((month) => {
    const result = javaApplyResponse({ ...request, ...month }, resultingTargetRevision);
    return {
      yearMonth: month.yearMonth,
      savedProjectionLineCount: result.projection.length,
      savedActualLineCount: result.actual.length,
      projection: result.projection,
      actual: result.actual,
      calculationChecks: result.calculationChecks,
    };
  });
  return {
    ok: true,
    commandName: 'weeklyExpense.cashflowSheetLab.apply',
    projectId: request.projectId,
    sourceSheetKey: 'cashflow-sheet-lab',
    sourceRevision: request.sourceRevision,
    targetRevision: request.targetRevision,
    resultingTargetRevision,
    months,
    settledWeekChanges: [],
    durationMs: 12,
    auditId: 'audit-batch',
  };
}

function completeStagedMonth(yearMonth = '2026-01') {
  return {
    yearMonth,
    apply: true,
    cells: ['projection', 'actual'].flatMap((mode) => Array.from({ length: 5 }, (_unused, weekIndex) => (
      CASHFLOW_LINE_IDS.map((cashflowLine) => ({
        yearMonth,
        mode,
        weekNo: weekIndex + 1,
        cashflowLine,
        cellState: 'EMPTY',
      }))
    )).flat()),
  };
}

function javaAnnualApplyResponse(request) {
  const values = (mode) => Object.fromEntries((request.cells || [])
    .filter((cell) => cell.mode === mode && ['VALUE', 'ZERO'].includes(cell.cellState))
    .map((cell) => [cell.cashflowLine, cell.amount]));
  const states = (mode) => Object.fromEntries((request.cells || [])
    .filter((cell) => cell.mode === mode)
    .map((cell) => [cell.cashflowLine, cell.cellState]));
  return {
    ok: true,
    commandName: 'weeklyExpense.cashflowSheetLab.apply',
    projectId: request.projectId,
    sourceSheetKey: 'cashflow-sheet-lab',
    year: request.year,
    sourceRevision: request.sourceRevision,
    revision: request.expectedRevision + 1,
    projection: values('projection'),
    actual: values('actual'),
    projectionStates: states('projection'),
    actualStates: states('actual'),
  };
}

function javaOperationNotFound(input) {
  return {
    version: '1',
    projectId: input.projectId,
    operationType: input.operationType,
    idempotencyKeyHash: `sha256:${createHash('sha256').update(input.idempotencyKey).digest('hex')}`,
    status: 'NOT_FOUND',
    sourceRevision: null,
    expectedTargetRevision: null,
    resultingTargetRevision: null,
    appliedMonths: [],
    appliedYears: [],
    annualRevisions: [],
    auditId: null,
    completedAt: null,
  };
}

function javaOperationApplied(input, values = {}) {
  return {
    ...javaOperationNotFound(input),
    status: 'APPLIED',
    sourceRevision: values.sourceRevision,
    expectedTargetRevision: values.expectedTargetRevision ?? null,
    resultingTargetRevision: values.resultingTargetRevision ?? null,
    appliedMonths: values.appliedMonths || [],
    appliedYears: values.appliedYears || [],
    annualRevisions: values.annualRevisions || [],
    auditId: 'audit-status',
    completedAt: '2026-07-20T00:00:00.000Z',
    ...(values.overrides || {}),
  };
}

function buildOfficialMatrix({
  weekLabels = FULL_YEAR_FINANCE_WEEKS,
  annualYears = [],
  projectionAnnualValue = '',
  actualAnnualValue = '',
  projectionAnnualValues = {},
  actualAnnualValues = {},
} = {}) {
  const matrix = Array.from({ length: 60 }, () => Array(72).fill(''));
  const sourceYear = 2000 + Number.parseInt(String(weekLabels[0] || '26').split('-')[0], 10);
  const annualColumns = officialAnnualColumns(sourceYear);
  const writeSection = (actual, annualValue, annualValues) => {
    const headerRowIndex = actual ? 34 : 11;
    const weekRowIndex = actual ? 35 : 12;
    const lineRowIndexes = actual
      ? [37, 38, 39, 40, 41, 42, 43, 45, 46, 47, 48, 49, 50, 51, 52, 53]
      : [14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30];
    const derivedRows = actual
      ? [[44, '입금 합계'], [54, '출금 합계'], [55, '잔액']]
      : [[21, '입금 합계'], [31, '출금 합계'], [32, '잔액 (※ 중요)']];
    matrix[headerRowIndex][0] = actual ? 'ACTUAL' : 'Projection';
    for (const [year, columnIndex] of annualColumns) {
      matrix[headerRowIndex][columnIndex] = columnIndex === 70 ? 'Total' : `${year}년`;
    }
    weekLabels.forEach((label, index) => {
      matrix[weekRowIndex][4 + index] = label;
    });
    const inLabels = actual ? ACTUAL_IN_LABELS : PROJECTION_IN_LABELS;
    const outLabels = actual ? ACTUAL_OUT_LABELS : PROJECTION_OUT_LABELS;
    const labels = [...inLabels, ...outLabels];
    lineRowIndexes.forEach((rowIndex, index) => {
      matrix[rowIndex][0] = labels[index];
      weekLabels.forEach((_label, weekIndex) => {
        matrix[rowIndex][4 + weekIndex] = '999';
      });
      for (const year of annualYears) {
        const columnIndex = annualColumns.get(year);
        if (columnIndex !== undefined) {
          matrix[rowIndex][columnIndex] = Object.hasOwn(annualValues, year)
            ? annualValues[year]
            : year === 2027 ? '' : annualValue;
        }
      }
    });
    derivedRows.forEach(([rowIndex, label]) => {
      matrix[rowIndex][0] = label;
      weekLabels.forEach((_week, weekIndex) => {
        matrix[rowIndex][4 + weekIndex] = '999';
      });
    });
  };
  matrix[0][0] = 'title';
  writeSection(false, projectionAnnualValue, projectionAnnualValues);
  writeSection(true, actualAnnualValue, actualAnnualValues);
  return matrix;
}

function buildMatrix() {
  return buildOfficialMatrix();
}

function buildMatrixWithWeekLabels(requestedLabels) {
  const sourceYear = Number.parseInt(String(requestedLabels?.[0] || '26').split('-')[0], 10);
  const fullYearLabels = Array.from({ length: 12 }, (_, monthIndex) => (
    Array.from({ length: 5 }, (_unused, weekIndex) => `${sourceYear}-${monthIndex + 1}-${weekIndex + 1}`)
  )).flat();
  return buildOfficialMatrix({ weekLabels: fullYearLabels });
}

async function loadSanitized260701FullYearFixture() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(fileURLToPath(new URL(
    '../fixtures/cashflow-260701-sanitized-full-year.xlsx',
    import.meta.url,
  )));
  const sheet = workbook.getWorksheet('cashflow(사용내역 연동)');
  if (!sheet) throw new Error('Sanitized cashflow fixture sheet is missing');
  const matrix = Array.from({ length: Math.max(sheet.rowCount, 60) }, (_row, rowIndex) => (
    Array.from({ length: sheet.columnCount }, (_column, columnIndex) => {
      const value = sheet.getCell(rowIndex + 1, columnIndex + 1).value;
      if (value && typeof value === 'object' && 'result' in value) return value.result ?? '';
      return value ?? '';
    })
  ));
  matrix.forEach((row) => {
    while (row.length < 72) row.push('');
  });
  for (const headerRowIndex of [11, 34]) {
    for (const [year, columnIndex] of officialAnnualColumns(2026)) {
      matrix[headerRowIndex][columnIndex] = columnIndex === 70 ? 'Total' : `${year}년`;
    }
  }
  matrix[16][0] = 'MYSC 선입금 - 매입부가세';
  matrix[32][0] = '잔액 (※ 중요)';
  matrix[55][0] = '잔액';
  return matrix;
}

function buildMultiYearMatrix() {
  const matrix = buildOfficialMatrix({
    annualYears: [2024, 2025, 2027, 2028],
    projectionAnnualValue: '100',
    actualAnnualValue: '50',
  });
  matrix[14][3] = '0';
  return matrix;
}

function buildMaximumCandidateMatrix() {
  return buildOfficialMatrix({
    annualYears: [2024, 2025, 2027, 2028, 2029, 2030, 2031, 2032],
    projectionAnnualValue: '100',
    actualAnnualValue: '50',
    projectionAnnualValues: { 2027: '100' },
    actualAnnualValues: { 2027: '50' },
  });
}

function buildConflictingAnnualWeeklyMatrix() {
  return buildOfficialMatrix({
    annualYears: [2026],
    projectionAnnualValue: '100',
    actualAnnualValue: '50',
  });
}

function createDb({
  project = { id: 'project-a' },
  weeks = [],
  initialDocuments = {},
  onGet,
  onQuery,
  onBatchCommit,
  onWrite,
} = {}) {
  const documents = new Map();
  const documentVersions = new Map();
  const queries = [];
  const batchCommitSizes = [];
  const directSetPaths = [];
  let batchCommitAttempt = 0;
  documents.set('orgs/tenant-a/projects/project-a', { ...project });
  for (const week of weeks) {
    documents.set(`orgs/tenant-a/cashflow_weeks/${week.id}`, { ...week });
  }
  for (const [path, value] of Object.entries(initialDocuments)) {
    documents.set(path, { ...value });
  }

  function writeDocument(path, patch, options = {}) {
    documents.set(path, options.merge ? { ...(documents.get(path) || {}), ...patch } : { ...patch });
    documentVersions.set(path, (documentVersions.get(path) || 0) + 1);
    onWrite?.({ path, patch, options, value: documents.get(path) });
  }

  function ref(path) {
    return {
      path,
      get: vi.fn(async () => {
        if (onGet) await onGet(path);
        return {
          exists: documents.has(path),
          data: () => documents.get(path),
        };
      }),
      set: vi.fn(async (patch, options = {}) => {
        directSetPaths.push(path);
        writeDocument(path, patch, options);
      }),
    };
  }

  return {
    doc: vi.fn(ref),
    batch: vi.fn(() => {
      const operations = [];
      return {
        set: (docRef, patch, options = {}) => operations.push({ path: docRef.path, patch, options }),
        commit: vi.fn(async () => {
          batchCommitAttempt += 1;
          if (onBatchCommit) {
            await onBatchCommit({
              attempt: batchCommitAttempt,
              size: operations.length,
              paths: operations.map((operation) => operation.path),
            });
          }
          for (const operation of operations) {
            writeDocument(operation.path, operation.patch, operation.options);
          }
          batchCommitSizes.push(operations.length);
        }),
      };
    }),
    collection: vi.fn((path) => ({
      get: vi.fn(async () => ({
        docs: [...documents.entries()]
          .filter(([docPath]) => docPath.startsWith(`${path}/`))
          .map(([docPath, data]) => ({
            id: docPath.slice(path.length + 1),
            data: () => data,
          })),
      })),
      where: vi.fn((field, op, value) => {
        queries.push({ path, field, op, value });
        return {
          get: vi.fn(async () => {
            if (onQuery) await onQuery({ path, field, op, value });
            return {
              docs: [...documents.entries()]
              .filter(([docPath, data]) => docPath.startsWith(`${path}/`) && data[field] === value)
              .map(([docPath, data]) => ({
                id: docPath.slice(path.length + 1),
                data: () => data,
              })),
            };
          }),
        };
      }),
    })),
    runTransaction: vi.fn(async (callback) => {
      for (let retry = 0; retry < 5; retry += 1) {
        const operations = [];
        const readVersions = new Map();
        const result = await callback({
          get: async (target) => {
            const snapshot = await target.get();
            if (target.path) readVersions.set(target.path, documentVersions.get(target.path) || 0);
            return snapshot;
          },
          set: (docRef, patch, options = {}) => operations.push({ path: docRef.path, patch, options }),
        });
        const candidateOperations = operations.filter(({ path }) => path.includes('/cashflow_change_candidates/'));
        if (candidateOperations.length > 0) {
          batchCommitAttempt += 1;
          if (onBatchCommit) {
            await onBatchCommit({
              attempt: batchCommitAttempt,
              size: candidateOperations.length,
              paths: candidateOperations.map((operation) => operation.path),
            });
          }
        }
        const conflicted = [...readVersions].some(([path, version]) => (
          (documentVersions.get(path) || 0) !== version
        ));
        if (conflicted) continue;
        for (const operation of operations) {
          writeDocument(operation.path, operation.patch, operation.options);
        }
        if (candidateOperations.length > 0) batchCommitSizes.push(candidateOperations.length);
        return result;
      }
      throw new Error('transaction retry limit exceeded');
    }),
    __getDocument: (path = 'orgs/tenant-a/projects/project-a') => documents.get(path),
    __getDocumentsByPrefix: (prefix) => [...documents.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, data]) => ({ path, data })),
    __getQueries: () => [...queries],
    __getBatchCommitSizes: () => [...batchCommitSizes],
    __clearBatchCommitSizes: () => { batchCommitSizes.length = 0; },
    __getDirectSetPaths: () => [...directSetPaths],
  };
}

function expectedClosedMonthDifferences(db, requiredMonths = [], riskOnly = true) {
  const monthSet = new Set(requiredMonths);
  const byMonth = new Map();
  for (const { data: candidate } of db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_change_candidates/')) {
    if (riskOnly && !candidate.riskFlags?.includes('closed_month_change')) continue;
    if (monthSet.size > 0 && !monthSet.has(candidate.yearMonth)) continue;
    const candidates = byMonth.get(candidate.yearMonth) || [];
    candidates.push(candidate);
    byMonth.set(candidate.yearMonth, candidates);
  }
  return [...byMonth.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([yearMonth, candidates]) => ({
    yearMonth,
    differenceCount: candidates.length,
    weeks: [...new Set(candidates.map((candidate) => candidate.weekNo))].sort((left, right) => left - right),
    changes: candidates.map((candidate) => ({
      mode: candidate.mode,
      weekNo: candidate.weekNo,
      lineId: candidate.lineId,
      beforeHadValue: candidate.beforeHadValue,
      beforeAmount: candidate.beforeHadValue ? candidate.beforeAmount : null,
      afterHadValue: candidate.proposedHadValue,
      afterAmount: candidate.proposedHadValue ? candidate.proposedAmount : null,
    })).sort((left, right) => (
      left.weekNo - right.weekNo
      || left.mode.localeCompare(right.mode)
      || left.lineId.localeCompare(right.lineId)
    )),
    truncatedChangeCount: 0,
  }));
}

function createApp({ context = {}, db = createDb(), googleSheetsService, routeOptions = {} } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.context = {
      tenantId: 'tenant-a',
      actorId: 'actor-a',
      actorRole: 'workspace_user',
      actorEmail: 'user@mysc.co.kr',
      requestId: 'req-1',
      ...context,
    };
    next();
  });
  if (routeOptions.javaWeeklyClient && !routeOptions.javaWeeklyClient.validateCashflowSheetFormulas) {
    routeOptions.javaWeeklyClient.validateCashflowSheetFormulas = vi.fn(async (input) => ({
      ok: true,
      projectId: input.projectId,
      annualCheckCount: 0,
      weeklyCheckCount: 0,
    }));
  }
  if (routeOptions.javaWeeklyClient && !routeOptions.javaWeeklyClient.getCashflowSnapshot) {
    const snapshot = { projectId: 'project-a', targetRevision: '', projection: [], actual: [] };
    const appliedRequests = [];
    const remember = (result) => {
      snapshot.projectId = result.projectId;
      snapshot.targetRevision = result.resultingTargetRevision;
      const monthResults = Array.isArray(result.months) ? result.months : [result];
      for (const month of monthResults) {
        snapshot.projection = snapshot.projection
          .filter((line) => line.yearMonth !== month.yearMonth)
          .concat(month.projection || []);
        snapshot.actual = snapshot.actual
          .filter((line) => line.yearMonth !== month.yearMonth || line.sheetKey !== 'cashflow-sheet-lab')
          .concat(month.actual || []);
      }
      return result;
    };
    for (const method of ['applyCashflowSheetLab', 'applyCashflowSheetBatch']) {
      if (!routeOptions.javaWeeklyClient[method]) continue;
      const apply = routeOptions.javaWeeklyClient[method];
      if (vi.isMockFunction(apply)) {
        const implementation = apply.getMockImplementation();
        apply.mockImplementation(async (...args) => {
          appliedRequests.push(args[0]);
          return remember(await implementation(...args));
        });
      } else {
        routeOptions.javaWeeklyClient[method] = async (...args) => {
          appliedRequests.push(args[0]);
          return remember(await apply(...args));
        };
      }
    }
    if (routeOptions.javaWeeklyClient.getCashflowSheetOperationStatus) {
      const readStatus = routeOptions.javaWeeklyClient.getCashflowSheetOperationStatus;
      const implementation = vi.isMockFunction(readStatus) ? readStatus.getMockImplementation() : readStatus;
      const wrapped = async (...args) => {
        const result = await implementation(...args);
        if (result?.status === 'APPLIED') snapshot.targetRevision = result.resultingTargetRevision;
        return result;
      };
      if (vi.isMockFunction(readStatus)) readStatus.mockImplementation(wrapped);
      else routeOptions.javaWeeklyClient.getCashflowSheetOperationStatus = wrapped;
    }
    routeOptions.javaWeeklyClient.getCashflowSnapshot = vi.fn(async () => {
      if (snapshot.projection.length === 0 && snapshot.actual.length === 0 && appliedRequests.length > 0) {
        const request = appliedRequests.at(-1);
        const months = Array.isArray(request.months) ? request.months : [request];
        for (const month of months.filter((candidate) => candidate.apply !== false)) {
          const response = javaApplyResponse({ ...request, ...month }, snapshot.targetRevision);
          snapshot.projection.push(...response.projection);
          snapshot.actual.push(...response.actual);
        }
      }
      return { ...snapshot };
    });
  }
  mountCashflowSheetLabRoutes(app, {
    db,
    googleSheetsService: googleSheetsService || {
      getServiceAccountEmail: () => 'cashflow-service@mysc.iam.gserviceaccount.com',
      getSpreadsheetMeta: vi.fn(async () => ({
        spreadsheetId: 'spreadsheet-a',
        spreadsheetTitle: 'Cashflow workbook',
        availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      })),
      previewSpreadsheet: vi.fn(async () => ({
        spreadsheetId: 'spreadsheet-a',
        spreadsheetTitle: 'Cashflow workbook',
        selectedSheetName: 'cashflow(사용내역 연동)',
        availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
        matrix: buildMatrix(),
      })),
    },
    ...routeOptions,
  });
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({
      code: error.code || 'error',
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  });
  return app;
}

async function stageJanuaryApply(javaWeeklyClient, suffix) {
  const db = createDb({
    project: {
      id: 'project-a',
      cashflowSheetLab: {
        value: 'saved-spreadsheet-a',
        sheetName: 'cashflow(사용내역 연동)',
        startWeek: '26-1-1',
        endWeek: '26-1-5',
      },
    },
  });
  const app = createApp({
    db,
    googleSheetsService: {
      previewSpreadsheet: vi.fn(async () => ({
        spreadsheetId: 'spreadsheet-a',
        selectedSheetName: 'cashflow(사용내역 연동)',
        availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
        matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
      })),
    },
    routeOptions: { editLeasesEnabled: true, javaWeeklyClient },
  });
  const mirror = await request(app)
    .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
    .send({ idempotencyKey: `refresh-${suffix}` })
    .expect(200);
  const stage = await request(app)
    .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
    .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: `stage-${suffix}` })
    .expect(200);
  return { app, db, mirror, stage };
}

function createDisabledApp() {
  const app = express();
  app.use(express.json());
  mountCashflowSheetLabRoutes(app, {
    enabled: false,
    db: createDb(),
    googleSheetsService: {
      previewSpreadsheet: vi.fn(),
    },
  });
  return app;
}

describe('cashflow sheet lab route', () => {
  it('accepts a complete JVM canonical readback while preserving EMPTY, ZERO, and VALUE', () => {
    const revision = `sha256:${'a'.repeat(64)}`;
    const month = completeStagedMonth();
    month.cells.find((cell) => cell.mode === 'projection' && cell.weekNo === 1).cellState = 'ZERO';
    month.cells.find((cell) => cell.mode === 'projection' && cell.weekNo === 1).amount = 0;
    month.cells.find((cell) => cell.mode === 'actual' && cell.weekNo === 2).cellState = 'VALUE';
    month.cells.find((cell) => cell.mode === 'actual' && cell.weekNo === 2).amount = 1234;
    const projectionCell = month.cells.find((cell) => cell.cellState === 'ZERO');
    const actualCell = month.cells.find((cell) => cell.cellState === 'VALUE');

    expect(assertJavaCashflowReadbackMatchesAppliedMonths({
      projectId: 'project-a',
      targetRevision: revision,
      projection: [{
        yearMonth: projectionCell.yearMonth,
        weekNo: projectionCell.weekNo,
        cashflowLine: projectionCell.cashflowLine,
        amount: 0,
      }],
      actual: [{
        sheetKey: 'cashflow-sheet-lab',
        yearMonth: actualCell.yearMonth,
        weekNo: actualCell.weekNo,
        cashflowLine: actualCell.cashflowLine,
        amount: 1234,
      }],
    }, [month], { projectId: 'project-a', resultingTargetRevision: revision })).toBe(160);
  });

  it.each([
    ['revision', (snapshot) => { snapshot.targetRevision = `sha256:${'b'.repeat(64)}`; }, 'cashflow_jvm_readback_revision_mismatch'],
    ['missing ZERO', (snapshot) => { snapshot.projection = []; }, 'cashflow_jvm_readback_mismatch'],
    ['wrong VALUE', (snapshot) => { snapshot.actual[0].amount += 1; }, 'cashflow_jvm_readback_mismatch'],
    ['unknown line', (snapshot) => { snapshot.actual[0].cashflowLine = 'UNKNOWN'; }, 'jvm_cashflow_snapshot_invalid'],
    ['duplicate projection', (snapshot) => { snapshot.projection.push({ ...snapshot.projection[0] }); }, 'jvm_cashflow_snapshot_invalid'],
  ])('rejects a JVM canonical readback with %s mismatch', (_label, mutate, expectedCode) => {
    const revision = `sha256:${'a'.repeat(64)}`;
    const month = completeStagedMonth();
    const projectionCell = month.cells[0];
    projectionCell.cellState = 'ZERO';
    projectionCell.amount = 0;
    const actualCell = month.cells.find((cell) => cell.mode === 'actual');
    actualCell.cellState = 'VALUE';
    actualCell.amount = 1234;
    const snapshot = {
      projectId: 'project-a',
      targetRevision: revision,
      projection: [{ yearMonth: '2026-01', weekNo: 1, cashflowLine: projectionCell.cashflowLine, amount: 0 }],
      actual: [{ sheetKey: 'cashflow-sheet-lab', yearMonth: '2026-01', weekNo: 1, cashflowLine: actualCell.cashflowLine, amount: 1234 }],
    };
    mutate(snapshot);
    expect(() => assertJavaCashflowReadbackMatchesAppliedMonths(
      snapshot,
      [month],
      { projectId: 'project-a', resultingTargetRevision: revision },
    )).toThrow(expect.objectContaining({ code: expectedCode }));
  });

  it('fails closed when the JVM canonical snapshot differs from Firestore before or after apply', () => {
    const firestoreSnapshot = {
      weeks: [{
        yearMonth: '2026-08',
        weekNo: 2,
        projection: { SALES_IN: 100 },
        actual: { DIRECT_COST_OUT: 30 },
      }],
    };
    const matchingJvmSnapshot = {
      projectId: 'project-a',
      projection: [{ yearMonth: '2026-08', weekNo: 2, cashflowLine: 'SALES_IN', amount: 100 }],
      actual: [
        { sheetKey: 'bank', yearMonth: '2026-08', weekNo: 2, cashflowLine: 'DIRECT_COST_OUT', amount: 10 },
        { sheetKey: 'cashflow-sheet-lab', yearMonth: '2026-08', weekNo: 2, cashflowLine: 'DIRECT_COST_OUT', amount: 20 },
      ],
    };
    expect(() => assertJavaCashflowMatchesFirestore(matchingJvmSnapshot, firestoreSnapshot)).not.toThrow();
    expect(() => assertJavaCashflowMatchesFirestore({
      ...matchingJvmSnapshot,
      projection: [{ yearMonth: '2026-08', weekNo: 2, cashflowLine: 'SALES_IN', amount: 101 }],
    }, firestoreSnapshot)).toThrow(expect.objectContaining({ code: 'jvm_cashflow_canonical_mismatch' }));
    expect(() => assertJavaCashflowMatchesFirestore({
      projectId: 'project-a',
      projection: [{ yearMonth: '2026-08', weekNo: 2, cashflowLine: 'UNKNOWN_LINE', amount: 1 }],
      actual: [],
    }, {
      weeks: [{ yearMonth: '2026-08', weekNo: 2, projection: { UNKNOWN_LINE: 1 }, actual: {} }],
    })).toThrow(expect.objectContaining({ code: 'jvm_cashflow_snapshot_invalid' }));
  });

  it('returns 404 when the deployment surface disables sheet lab', async () => {
    await request(createDisabledApp())
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/config')
      .expect(404)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_sheet_lab_not_available');
      });
  });

  it('does not expose the retired full sheet change-count endpoint', async () => {
    await request(createApp())
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/changes/check')
      .send({})
      .expect(404);
  });

  it('probes freshness on entry without reading the sheet (cheap change badge)', async () => {
    // 진입 전용 경량 엔드포인트. 시트 풀 리드 없이 modifiedTime 만 대조한다.
    const projectDoc = {
      id: 'project-a', contractStart: '2024-01-01', contractEnd: '2028-12-31',
      cashflowSheetLab: {
        value: 'https://docs.google.com/spreadsheets/d/spreadsheet-a/edit',
        sheetName: 'cashflow(사용내역 연동)', startWeek: '26-1-1', endWeek: '26-1-1',
      },
    };
    const previewSpreadsheet = vi.fn();
    let modifiedTime = '2026-08-09T10:00:00.000Z';
    const getSpreadsheetFreshness = vi.fn(async () => ({ spreadsheetId: 'spreadsheet-a', modifiedTime, version: '3' }));

    // 미러가 없으면 '불러오기 필요'
    const emptyDb = createDb({ project: projectDoc });
    const before = await request(
      createApp({ db: emptyDb, googleSheetsService: { previewSpreadsheet, getSpreadsheetFreshness } }),
    ).post('/api/v1/projects/project-a/cashflow-sheet-lab/changes/probe').send({}).expect(200);
    expect(before.body).toMatchObject({ status: 'AVAILABLE', mirrorLoaded: false, sheetChangedSinceMirror: true });

    // 미러를 modifiedTime 과 함께 심은 db (불러온 상태)
    const db = createDb({
      project: projectDoc,
      initialDocuments: {
        'orgs/tenant-a/cashflow_sheet_mirrors/project-a': {
          projectId: 'project-a', status: 'FRESH', sourceRevision: 'sha256:abc',
          sourceFileModifiedTime: modifiedTime,
        },
      },
    });
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet, getSpreadsheetFreshness } });

    // 변경 없음 -> 시트 안 읽음
    const unchanged = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/changes/probe')
      .send({}).expect(200);
    expect(unchanged.body).toMatchObject({ mirrorLoaded: true, sheetChangedSinceMirror: false });
    expect(previewSpreadsheet).not.toHaveBeenCalled();

    // 시트가 바뀌면 changed=true (여전히 풀 리드는 안 함)
    modifiedTime = '2026-08-09T11:00:00.000Z';
    const changed = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/changes/probe')
      .send({}).expect(200);
    expect(changed.body).toMatchObject({ mirrorLoaded: true, sheetChangedSinceMirror: true });
    expect(previewSpreadsheet).not.toHaveBeenCalled();

    // probe 실패는 '변경 없음'이라 하지 않는다 (판정 불능)
    getSpreadsheetFreshness.mockRejectedValueOnce(new Error('drive down'));
    const failed = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/changes/probe')
      .send({}).expect(200);
    expect(failed.body.status).toBe('UNAVAILABLE');
  });

  it('always reads the sheet in full, even when Drive says it has not changed', async () => {
    // 2026-08-19: Drive 는 편집 뒤 수십 초~2분 동안 옛 modifiedTime 을 돌려준다. 그 시간 동안
    // "안 바뀜"으로 건너뛰면 방금 고친 값이 안 들어온다. 사용자가 누르는 이유는 고쳤기
    // 때문이므로 매번 통째로 읽는다. modifiedTime 은 changes/probe 표시용으로 기록만 한다.
    const db = createDb({
      project: {
        id: 'project-a',
        contractStart: '2024-01-01',
        contractEnd: '2028-12-31',
        cashflowSheetLab: {
          value: 'https://docs.google.com/spreadsheets/d/spreadsheet-a/edit',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-1',
        },
      },
    });
    const modifiedTime = '2026-08-09T10:00:00.000Z';
    const previewSpreadsheet = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      spreadsheetTitle: 'Cashflow workbook',
      selectedSheetName: 'cashflow(사용내역 연동)',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      matrix: buildMatrix(),
    }));
    const getSpreadsheetFreshness = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a', modifiedTime, version: '7',
    }));
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet, getSpreadsheetFreshness } });

    const first = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'fresh-001' })
      .expect(200);
    expect(first.body.status).toBe('FRESH');
    expect(previewSpreadsheet).toHaveBeenCalledTimes(1);
    // 불러오기가 느릴 때 어느 구간인지 브라우저에서 바로 갈리도록 구간 기록을 헤더로 낸다.
    expect(first.headers['server-timing']).toMatch(/google_sheet_fetch;dur=\d+/);
    expect(first.headers['server-timing']).toMatch(/sheet_parse_validate;dur=\d+/);
    expect(first.headers['server-timing']).toMatch(/mirror_publish;dur=\d+/);
    expect(first.headers['server-timing']).toMatch(/total;dur=\d+/);
    expect(db.__getDocument('orgs/tenant-a/cashflow_sheet_mirrors/project-a').sourceFileModifiedTime)
      .toBe(modifiedTime);

    // Drive 가 같은 modifiedTime 을 줘도 다시 통째로 읽는다. 건너뛴 응답(unchanged) 은 더 이상 없다.
    const second = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'fresh-002' })
      .expect(200);
    expect(second.body.status).toBe('FRESH');
    expect(second.body.unchanged).toBeUndefined();
    expect(second.headers['server-timing']).toMatch(/google_sheet_fetch;dur=\d+/);
    expect(previewSpreadsheet).toHaveBeenCalledTimes(2);

    // probe 실패도 불러오기를 막지 않는다 - modifiedTime 은 기록용일 뿐이다.
    getSpreadsheetFreshness.mockRejectedValueOnce(new Error('drive down'));
    const third = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'fresh-003' })
      .expect(200);
    expect(third.body.status).toBe('FRESH');
    expect(previewSpreadsheet).toHaveBeenCalledTimes(3);
  });

  it('reads Google Sheets only on explicit mirror refresh and pins the result', async () => {
    const performanceEvents = [];
    const db = createDb({
      project: {
        id: 'project-a',
        contractStart: '2024-01-01',
        contractEnd: '2028-12-31',
        cashflowSheetLab: {
          value: 'https://docs.google.com/spreadsheets/d/spreadsheet-a/edit',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-1',
        },
      },
    });
    const previewSpreadsheet = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      spreadsheetTitle: 'Cashflow workbook',
      selectedSheetName: 'cashflow(사용내역 연동)',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      matrix: buildMatrix(),
    }));
    const app = createApp({
      db,
      googleSheetsService: { previewSpreadsheet },
      routeOptions: { performanceLogger: (event) => performanceEvents.push(event) },
    });

    const beforeRefresh = await request(app)
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/mirror')
      .expect(200);
    expect(beforeRefresh.body).toMatchObject({ projectId: 'project-a', status: 'EMPTY' });
    expect(previewSpreadsheet).not.toHaveBeenCalled();

    const refreshed = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-refresh-001' })
      .expect(200);
    expect(refreshed.body).toMatchObject({
      projectId: 'project-a',
      status: 'FRESH',
      weeklyYear: 2026,
      sourceRevision: expect.stringMatching(/^sha256:/),
      targetRevisionAtFetch: expect.stringMatching(/^sha256:/),
      summary: { cellCount: 1920, valueCount: 1920, emptyCount: 0, invalidCount: 0 },
    });
    expect(previewSpreadsheet).toHaveBeenCalledTimes(1);

    const pinned = await request(app)
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/mirror')
      .expect(200);
    expect(pinned.body.sourceRevision).toBe(refreshed.body.sourceRevision);
    expect(pinned.body.cells).toHaveLength(1920);
    expect(db.__getDocument('orgs/tenant-a/cashflow_sheet_mirrors/project-a')).toMatchObject({ weeklyYear: 2026 });
    expect(previewSpreadsheet).toHaveBeenCalledTimes(1);
    expect(db.__getDocument().cashflowSheetLab.activeWeeks).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(performanceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'project_read', operation: 'cashflow.sheet_mirror.refresh' }),
      expect.objectContaining({ phase: 'mirror_read', operation: 'cashflow.sheet_mirror.refresh' }),
      expect.objectContaining({ phase: 'refresh_reserve', operation: 'cashflow.sheet_mirror.refresh' }),
      expect.objectContaining({ phase: 'google_sheet_fetch', operation: 'cashflow.sheet_mirror.refresh' }),
      expect.objectContaining({ phase: 'sheet_parse_validate', operation: 'cashflow.sheet_mirror.refresh' }),
      expect.objectContaining({ phase: 'target_snapshot_read', operation: 'cashflow.sheet_mirror.refresh' }),
      expect.objectContaining({ phase: 'mirror_build', operation: 'cashflow.sheet_mirror.refresh' }),
      expect.objectContaining({ phase: 'mirror_publish', operation: 'cashflow.sheet_mirror.refresh' }),
    ]));
    expect(performanceEvents.every((event) => event.requestId === 'req-1')).toBe(true);
  });

  it('selects the linked tab before the single sheet values fetch', async () => {
    const performanceEvents = [];
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: { value: 'spreadsheet-a' },
      },
    });
    const availableSheets = [
      { sheetId: 1, title: '요약', index: 0 },
      { sheetId: 2, title: 'cashflow(사용내역 연동)', index: 1 },
    ];
    const previewSpreadsheet = vi.fn(async ({ selectSheet }) => ({
      spreadsheetId: 'spreadsheet-a',
      spreadsheetTitle: 'Cashflow workbook',
      selectedSheetName: selectSheet(availableSheets).title,
      availableSheets,
      matrix: buildMatrix(),
    }));
    const app = createApp({
      db,
      googleSheetsService: { previewSpreadsheet },
      routeOptions: { performanceLogger: (event) => performanceEvents.push(event) },
    });

    const refreshed = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-single-fetch-001' })
      .expect(200);

    expect(refreshed.body).toMatchObject({
      status: 'FRESH',
      selectedSheetName: 'cashflow(사용내역 연동)',
    });
    expect(previewSpreadsheet).toHaveBeenCalledTimes(1);
    expect(performanceEvents.filter((event) => event.phase === 'sheet_parse_validate')).toHaveLength(1);
    expect(performanceEvents.filter((event) => event.phase === 'mirror_publish')).toHaveLength(1);
  });

  it('stores weekly values and annual totals without requiring a missing future year', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        contractStart: '2024-01-01',
        contractEnd: '2028-12-31',
        cashflowSheetLab: {
          value: 'https://docs.google.com/spreadsheets/d/spreadsheet-a/edit',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
    });
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          spreadsheetTitle: 'Cashflow workbook',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMultiYearMatrix(),
        })),
      },
    });

    const refreshed = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'multi-year-refresh-001' })
      .expect(200);

    expect(refreshed.body.sheetFacts.annualCashflowTotals).toEqual(expect.arrayContaining([
      expect.objectContaining({ year: 2024, projection: expect.objectContaining({ source: 'ANNUAL' }) }),
      expect.objectContaining({ year: 2025, actual: expect.objectContaining({ source: 'ANNUAL' }) }),
      expect.objectContaining({ year: 2027, projection: expect.objectContaining({ source: 'ANNUAL', lineAmounts: {} }) }),
      expect.objectContaining({ year: 2028, actual: expect.objectContaining({ source: 'ANNUAL' }) }),
    ]));
    // 주차 연도는 연간 항목이 없다. 주차 값은 cells 에, 그 해 합계는 Total 열에 있다.
    expect(refreshed.body.sheetFacts.annualCashflowTotals.find((row) => row.year === 2026)).toBeUndefined();
    const mirror = db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_mirrors/');
    const snapshots = db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_snapshots/');
    expect(mirror[0].data).toMatchObject({ projectId: 'project-a', status: 'FRESH', snapshotSchemaVersion: 2 });
    expect(mirror[0].data.snapshotId).toMatch(/^cfsnap_[a-f0-9]{32}$/);
    expect(snapshots).toHaveLength(1);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_snapshot_months/')).toHaveLength(12);
    const yearSnapshots = db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_snapshot_years/');
    // 연간 8개 연도만 스냅샷된다. 주차 연도는 연간 항목이 없으니 스냅샷도 없다.
    expect(yearSnapshots).toHaveLength(8);
    const reordered = yearSnapshots.find(({ data }) => data.year === 2025);
    reordered.data.projection.lineAmounts = Object.fromEntries(
      Object.entries(reordered.data.projection.lineAmounts).reverse(),
    );
    await db.doc(reordered.path).set(reordered.data);
  });

  it('applies annual totals and weekly values together without inventing annual weeks', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        contractStart: '2024-01-01',
        contractEnd: '2028-12-31',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
    });
    let annualCallsStarted = 0;
    let releaseAnnualCalls;
    const annualCallsReady = new Promise((resolve) => { releaseAnnualCalls = resolve; });
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => javaApplyResponse(input, `sha256:${'1'.repeat(64)}`)),
      applyCashflowSheetBatch: vi.fn(async (input) => javaBatchApplyResponse(input, `sha256:${'1'.repeat(64)}`)),
      applyCashflowSheetAnnualTotal: vi.fn(async (input) => {
        annualCallsStarted += 1;
        if (annualCallsStarted === 3) releaseAnnualCalls();
        await annualCallsReady;
        const response = javaAnnualApplyResponse(input);
        const docId = Buffer.from(`${input.projectId}\n${input.year}`, 'utf8').toString('base64url');
        await db.doc(`orgs/tenant-a/cashflow_sheet_year_totals/${docId}`).set({
          projectId: input.projectId,
          year: input.year,
          sourceRevision: input.sourceRevision,
          revision: response.revision,
          projection: response.projection,
          actual: response.actual,
          projectionStates: response.projectionStates,
          actualStates: response.actualStates,
          updatedAt: '2026-07-20T00:00:00.000Z',
        });
        return response;
      }),
    };
    const editLeaseService = {
      acquire: vi.fn(async () => ({ body: { leaseId: 'annual-lease', fence: 9 } })),
      release: vi.fn(),
    };
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          spreadsheetTitle: 'Cashflow workbook',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMultiYearMatrix(),
        })),
      },
      routeOptions: { editLeasesEnabled: true, editLeaseService, javaWeeklyClient },
    });

    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'annual-refresh-001' })
      .expect(200);
    expect(mirror.body.cells).toHaveLength(1920);
    expect(mirror.body.annualCells).toHaveLength(288);
    expect(mirror.body.totalCells).toHaveLength(38);

    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'annual-stage-001' })
      .expect(200);
    expect(stage.body).toMatchObject({
      stagedMonths: Array.from({ length: 12 }, (_unused, index) => `2026-${String(index + 1).padStart(2, '0')}`),
      stagedYears: [2024, 2025, 2028],
      annualLineCount: 96,
    });
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_years/')).toHaveLength(3);

    const applied = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({
        stageRunId: stage.body.runId,
        closedMonthChangeReason: '결산 후 연간 합계 정정',
        idempotencyKey: 'annual-apply-001',
      })
      .expect(200);
    expect(applied.body).toMatchObject({
      appliedMonths: Array.from({ length: 12 }, (_unused, index) => `2026-${String(index + 1).padStart(2, '0')}`),
      appliedYears: [2024, 2025, 2028],
      appliedLineCount: 2016,
    });
    expect(javaWeeklyClient.applyCashflowSheetLab).not.toHaveBeenCalled();
    expect(javaWeeklyClient.applyCashflowSheetBatch).toHaveBeenCalledTimes(1);
    expect(javaWeeklyClient.validateCashflowSheetFormulas).toHaveBeenCalledTimes(1);
    expect(javaWeeklyClient.applyCashflowSheetBatch).toHaveBeenCalledWith(expect.objectContaining({
      openingBalanceCells: expect.arrayContaining([
        expect.objectContaining({ year: 2025, mode: 'projection', cashflowLine: 'MYSC_PREPAY_IN', cellState: 'ZERO', amount: 0 }),
        expect.objectContaining({ year: 2025, mode: 'actual', cashflowLine: 'BANK_INTEREST_OUT', cellState: 'VALUE', amount: 50 }),
      ]),
    }));
    expect(javaWeeklyClient.applyCashflowSheetBatch.mock.calls[0][0].openingBalanceCells).toHaveLength(64);
    expect(javaWeeklyClient.applyCashflowSheetAnnualTotal).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a',
      year: 2025,
      expectedRevision: 0,
      amendmentReason: '결산 후 연간 합계 정정',
      cells: expect.arrayContaining([
        expect.objectContaining({ mode: 'projection', cashflowLine: 'MYSC_PREPAY_IN', cellState: 'ZERO', amount: 0 }),
        expect.objectContaining({ mode: 'actual', cashflowLine: 'BANK_INTEREST_OUT', cellState: 'VALUE', amount: 50 }),
      ]),
    }));
    expect(javaWeeklyClient.applyCashflowSheetAnnualTotal).toHaveBeenCalledTimes(3);
    expect(annualCallsStarted).toBe(3);
    const annual2025Id = Buffer.from('project-a\n2025', 'utf8').toString('base64url');
    const annual2025 = db.__getDocument(`orgs/tenant-a/cashflow_sheet_year_totals/${annual2025Id}`);
    expect(annual2025.projection).toHaveProperty('MYSC_PREPAY_IN', 0);
    expect(annual2025.projectionStates).toHaveProperty('MYSC_PREPAY_IN', 'ZERO');
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_weeks/')).toHaveLength(0);
    expect(db.__getDocument('orgs/tenant-a/cashflow_sheet_publications/project-a')).toMatchObject({
      projectId: 'project-a',
      status: 'APPLIED',
      stagedRunId: stage.body.runId,
      appliedTargetRevision: applied.body.resultingTargetRevision,
    });

  });

  it('fails closed when an annual JVM response does not match the fixed command contract', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        contractStart: '2024-01-01',
        contractEnd: '2026-12-31',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
    });
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => javaApplyResponse(input, `sha256:${'1'.repeat(64)}`)),
      applyCashflowSheetBatch: vi.fn(async (input) => javaBatchApplyResponse(input, `sha256:${'1'.repeat(64)}`)),
      applyCashflowSheetAnnualTotal: vi.fn(async (input) => ({
        ...javaAnnualApplyResponse(input),
        commandName: 'weeklyExpense.cashflowSheetAnnual.apply',
      })),
    };
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMultiYearMatrix(),
        })),
      },
      routeOptions: { javaWeeklyClient },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'annual-contract-refresh' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'annual-contract-stage' })
      .expect(200);

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'annual-contract-apply' })
      .expect(503)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_sheet_operation_uncertain');
      });
    expect(db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${stage.body.runId}`).status)
      .toBe('APPLYING');
    expect(db.__getDocument('orgs/tenant-a/cashflow_sheet_publications/project-a')).toMatchObject({
      status: 'APPLYING',
      stagedRunId: stage.body.runId,
    });
  });

  it('resumes a bounded parallel annual apply after one year fails', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        contractStart: '2024-01-01',
        contractEnd: '2028-12-31',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
    });
    const attemptsByYear = new Map();
    let annualStatusReads = 0;
    const javaWeeklyClient = {
      getCashflowSheetOperationStatus: vi.fn(async (input) => {
        annualStatusReads += 1;
        if (annualStatusReads === 1) throw Object.assign(new Error('status unavailable'), { statusCode: 503 });
        return javaOperationNotFound(input);
      }),
      applyCashflowSheetAnnualTotal: vi.fn(async (input) => {
        const attempt = (attemptsByYear.get(input.year) || 0) + 1;
        attemptsByYear.set(input.year, attempt);
        if (input.year === 2025 && attempt === 1) {
          throw Object.assign(new Error('temporary annual failure'), {
            statusCode: 503,
            code: 'weekly_api_unavailable',
          });
        }
        return javaAnnualApplyResponse(input);
      }),
      applyCashflowSheetLab: vi.fn(async (input) => javaApplyResponse(input, `sha256:${'1'.repeat(64)}`)),
      applyCashflowSheetBatch: vi.fn(async (input) => javaBatchApplyResponse(input, `sha256:${'1'.repeat(64)}`)),
    };
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMultiYearMatrix(),
        })),
      },
      routeOptions: { editLeasesEnabled: true, javaWeeklyClient },
    });

    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'annual-resume-refresh' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'annual-resume-stage' })
      .expect(200);

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'annual-resume-first' })
      .expect(503);
    expect(db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${stage.body.runId}`).status).toBe('APPLYING');
    const recovery = await request(app)
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/apply-status')
      .expect(200);
    expect(recovery.body).toMatchObject({
      projectId: 'project-a',
      status: 'APPLYING',
      stagedRun: {
        runId: stage.body.runId,
        stagedLineCount: stage.body.stagedLineCount,
      },
      applyInput: {
        applyRiskCandidates: false,
        closedMonthChangeReason: '',
        replaceAllActualSources: false,
      },
    });

    const replay = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({
        stageRunId: stage.body.runId,
        idempotencyKey: 'annual-resume-second',
        applyRiskCandidates: true,
        closedMonthChangeReason: '다른 화면에서 임의로 바꾼 재시도 입력',
      })
      .expect(200);
    expect(replay.body.appliedYears).toEqual([2024, 2025, 2028]);
    expect(javaWeeklyClient.applyCashflowSheetAnnualTotal).toHaveBeenCalledTimes(4);
    expect(javaWeeklyClient.applyCashflowSheetLab).not.toHaveBeenCalled();
    expect(javaWeeklyClient.applyCashflowSheetBatch).toHaveBeenCalledTimes(1);
    expect(db.__getDocument('orgs/tenant-a/cashflow_sheet_publications/project-a')).toMatchObject({
      status: 'APPLIED',
      stagedRunId: stage.body.runId,
    });
    const annualCalls = javaWeeklyClient.applyCashflowSheetAnnualTotal.mock.calls.map(([call]) => call);
    expect(annualCalls.filter((call) => call.year === 2024)).toHaveLength(1);
    expect(annualCalls.filter((call) => call.year === 2028)).toHaveLength(1);
    const retried2025 = annualCalls.filter((call) => call.year === 2025);
    expect(retried2025).toHaveLength(2);
    expect(retried2025[0].idempotencyKey).toBe(retried2025[1].idempotencyKey);
  }, 10_000);

  it('gives the weekly year no annual column so weekly and annual totals cannot conflict', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-12-5',
        },
      },
    });
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          spreadsheetTitle: 'Cashflow workbook',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildConflictingAnnualWeeklyMatrix(),
        })),
      },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'conflicting-year-refresh' })
      .expect(200);

    // 좌표 계약: 주별 블록은 E:BL 하나뿐이고 연간 열은 그 해를 포함하지 않는다.
    // 따라서 2026 은 주차 그리드에만 존재하고, 주차합과 연간값이 어긋날 자리가 없다.
    // 주차 연도는 연간 항목 자체를 만들지 않는다 - 주차 셀을 더한 가짜 연간값이 없으니
    // 주차합과 연간값이 어긋날 자리가 처음부터 없다.
    expect(mirror.body.sheetFacts.annualCashflowTotals.find((row) => row.year === 2026)).toBeUndefined();
    expect(mirror.body.sheetFacts.annualCashflowTotals.map((row) => row.year)).not.toContain(2026);
    // 2026 으로 태깅된 셀은 Total 열(BS)의 GRAND_TOTAL 뿐이며 연간 열이 아니다.
    expect(mirror.body.annualCells.some((cell) => (
      Number(cell.year) === 2026 && cell.periodKind !== 'GRAND_TOTAL'
    ))).toBe(false);
    expect(mirror.body.reconciliationWarnings).toEqual([]);

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'conflicting-year-stage' })
      .expect(200);
  });

  it('compares a pinned multi-year sheet total with registered financial years', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        financialYears: [
          { year: 2025, contractAmount: 100, salesVatAmount: 10, totalRevenueAmount: 20, supportAmount: 30 },
          { year: 2026, contractAmount: 200, salesVatAmount: 20, totalRevenueAmount: 40, supportAmount: 60 },
        ],
      },
      initialDocuments: {
        'orgs/tenant-a/cashflow_sheet_mirrors/project-a': {
          projectId: 'project-a',
          status: 'FRESH',
          sheetFacts: {
            annualFinancialTotals: [
              { year: 2025, contractAmount: 100, salesVatAmount: 10, totalRevenueAmount: 20, supportAmount: 30 },
              { year: 2026, contractAmount: 200, salesVatAmount: 21, totalRevenueAmount: 40, supportAmount: 60 },
            ],
          },
        },
      },
    });

    const response = await request(createApp({ db }))
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/mirror')
      .expect(200);

    expect(response.body.financialYearChecks).toMatchObject({
      years: [
        { year: 2025, status: 'MATCH', mismatches: [] },
        { year: 2026, status: 'MISMATCH', mismatches: ['salesVatAmount'] },
      ],
      total: { status: 'MISMATCH', mismatches: ['salesVatAmount'] },
    });
  });

  it('keeps the last-good mirror as STALE when an explicit refresh fails', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-1',
        },
      },
    });
    const previewSpreadsheet = vi.fn()
      .mockResolvedValueOnce({
        spreadsheetId: 'spreadsheet-a',
        spreadsheetTitle: 'Cashflow workbook',
        selectedSheetName: 'cashflow(사용내역 연동)',
        availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
        matrix: buildMatrix(),
      })
      .mockRejectedValueOnce(new GoogleSheetsServiceError('temporary failure', {
        code: 'google_sheets_api_error',
        statusCode: 503,
      }));
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet } });

    const first = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-stale-first' })
      .expect(200);
    const second = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-stale-second' })
      .expect(200);

    expect(second.body).toMatchObject({
      status: 'STALE',
      sourceRevision: first.body.sourceRevision,
      lastRefreshError: { code: 'google_sheets_api_error' },
    });
    expect(second.body.cells).toEqual(first.body.cells);
  });

  it('returns ERROR when the first explicit mirror refresh fails', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: { value: 'spreadsheet-a', sheetName: 'cashflow(사용내역 연동)' },
      },
    });
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => {
          throw new GoogleSheetsServiceError('unavailable', {
            code: 'google_sheets_api_error',
            statusCode: 503,
          });
        }),
      },
    });

    const response = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-error-first' })
      .expect(200);
    expect(response.body).toMatchObject({
      projectId: 'project-a',
      status: 'ERROR',
      lastRefreshError: { code: 'google_sheets_api_error' },
    });
    expect(response.body.sourceRevision).toBeUndefined();
  });

  it('returns the exact cells that make a cashflow sheet structure unsupported', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: { value: 'spreadsheet-a', sheetName: 'cashflow(사용내역 연동)' },
      },
    });
    const matrix = buildMatrix();
    matrix[12][4] = 'broken-week-header';
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix,
        })),
      },
    });

    const response = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-unsupported-template' })
      .expect(200);

    expect(response.body).toMatchObject({
      status: 'ERROR',
      lastRefreshError: {
        code: 'cashflow_sheet_template_unsupported',
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'cashflow_week_header_invalid', sourceCell: 'E13' }),
        ]),
      },
    });
  });

  it('rejects a sheet whose weekly header row mixes years', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: { value: 'spreadsheet-a', sheetName: 'cashflow(사용내역 연동)' },
      },
    });
    const matrix = buildMatrix();
    matrix[12][31] = '25-6-3';
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix,
        })),
      },
    });

    const response = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-mixed-weekly-years' })
      .expect(200);

    expect(response.body).toMatchObject({
      status: 'ERROR',
      lastRefreshError: {
        code: 'cashflow_sheet_template_unsupported',
        statusCode: 400,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'cashflow_week_years_mixed', sourceCell: 'AF13' }),
        ]),
      },
    });
  });

  it('replays an explicit mirror refresh idempotently without rereading Google', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: { value: 'spreadsheet-a', sheetName: 'cashflow(사용내역 연동)' },
      },
    });
    const previewSpreadsheet = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      matrix: buildMatrix(),
    }));
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet } });
    const payload = { idempotencyKey: 'mirror-idempotent-001' };

    const first = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send(payload)
      .expect(200);
    const replay = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send(payload)
      .expect(200);

    expect(replay.body.sourceRevision).toBe(first.body.sourceRevision);
    expect(replay.body.capturedAt).toBe(first.body.capturedAt);
    expect(previewSpreadsheet).toHaveBeenCalledTimes(1);
  });

  it('replays an older refresh key without rereading Google or replacing the latest pinned mirror', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: { value: 'spreadsheet-a', sheetName: 'cashflow(사용내역 연동)' },
      },
    });
    const previewSpreadsheet = vi.fn(async () => {
      const matrix = buildMatrix();
      matrix[14][4] = previewSpreadsheet.mock.calls.length === 1 ? '111' : '222';
      return {
        spreadsheetId: 'spreadsheet-a',
        selectedSheetName: 'cashflow(사용내역 연동)',
        availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
        matrix,
      };
    });
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet } });

    const first = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-old-key-a' })
      .expect(200);
    const second = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-new-key-b' })
      .expect(200);
    const firstReplay = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-old-key-a' })
      .expect(200);
    const pinned = await request(app)
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/mirror')
      .expect(200);

    expect(first.body.sourceRevision).not.toBe(second.body.sourceRevision);
    expect(firstReplay.body.sourceRevision).toBe(first.body.sourceRevision);
    expect(firstReplay.body.cells).toEqual(first.body.cells);
    expect(pinned.body.sourceRevision).toBe(second.body.sourceRevision);
    expect(previewSpreadsheet).toHaveBeenCalledTimes(2);
  });

  it('keeps the newest explicit refresh pinned when an older request finishes later', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
    });
    let releaseFirstPreview;
    let markFirstPreviewStarted;
    const firstPreviewStarted = new Promise((resolve) => {
      markFirstPreviewStarted = resolve;
    });
    const firstPreviewGate = new Promise((resolve) => {
      releaseFirstPreview = resolve;
    });
    const previewSpreadsheet = vi.fn(async () => {
      const callNumber = previewSpreadsheet.mock.calls.length;
      const matrix = buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS);
      matrix[14][4] = callNumber === 1 ? '111' : '222';
      if (callNumber === 1) {
        markFirstPreviewStarted();
        await firstPreviewGate;
      }
      return {
        spreadsheetId: callNumber === 1 ? 'spreadsheet-a' : 'spreadsheet-b',
        selectedSheetName: 'cashflow(사용내역 연동)',
        availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
        matrix,
      };
    });
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet } });

    const olderRequest = request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-concurrent-older' })
      .then((response) => response);
    await firstPreviewStarted;
    await request(app)
      .put('/api/v1/projects/project-a/cashflow-sheet-lab/config')
      .send({
        value: 'spreadsheet-b',
        sheetName: 'cashflow(사용내역 연동)',
        startWeek: '26-1-1',
        endWeek: '26-1-5',
      })
      .expect(200);
    const newerResponse = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-concurrent-newer' })
      .expect(200);
    releaseFirstPreview();
    const olderResponse = await olderRequest;
    const pinned = await request(app)
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/mirror')
      .expect(200);

    expect(olderResponse.status).toBe(200);
    expect(olderResponse.body.sourceRevision).toBe(newerResponse.body.sourceRevision);
    expect(pinned.body.sourceRevision).toBe(newerResponse.body.sourceRevision);
    expect(pinned.body.cells.find((cell) => cell.sourceCell === 'E15')?.amount).toBe(222);
  });

  it('does not install the first in-flight refresh after the saved config changes', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
    });
    let releasePreview;
    let markPreviewStarted;
    const previewStarted = new Promise((resolve) => {
      markPreviewStarted = resolve;
    });
    const previewGate = new Promise((resolve) => {
      releasePreview = resolve;
    });
    const previewSpreadsheet = vi.fn(async () => {
      markPreviewStarted();
      await previewGate;
      return {
        spreadsheetId: 'spreadsheet-a',
        selectedSheetName: 'cashflow(사용내역 연동)',
        availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
        matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
      };
    });
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet } });

    const inFlightRefresh = request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-first-in-flight' })
      .then((response) => response);
    await previewStarted;
    await request(app)
      .put('/api/v1/projects/project-a/cashflow-sheet-lab/config')
      .send({
        value: 'spreadsheet-b',
        sheetName: 'cashflow(사용내역 연동)',
        startWeek: '26-1-1',
        endWeek: '26-1-5',
      })
      .expect(200);
    releasePreview();

    const completedRefresh = await inFlightRefresh;
    const pinned = await request(app)
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/mirror')
      .expect(200);

    expect(completedRefresh.status).toBe(200);
    expect(completedRefresh.body.status).not.toBe('FRESH');
    expect(pinned.body.status).not.toBe('FRESH');
    expect(pinned.body.sourceRevision).toBeUndefined();
  });

  it('rejects reuse of an older refresh key with a different source request', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: { value: 'spreadsheet-a', sheetName: 'cashflow(사용내역 연동)' },
      },
    });
    const previewSpreadsheet = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      matrix: buildMatrix(),
    }));
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet } });

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-reused-old-key' })
      .expect(200);
    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-next-key' })
      .expect(200);
    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'mirror-reused-old-key', value: 'spreadsheet-b' })
      .expect(409)
      .expect((response) => {
        expect(response.body.code).toBe('idempotency_key_reused');
      });

    expect(previewSpreadsheet).toHaveBeenCalledTimes(2);
  });

  it('saves the cashflow sheet config without reading Google Sheets', async () => {
    const db = createDb();
    const previewSpreadsheet = vi.fn();

    const response = await request(createApp({ db, googleSheetsService: { previewSpreadsheet } }))
      .put('/api/v1/projects/project-a/cashflow-sheet-lab/config')
      .send({
        value: 'https://docs.google.com/spreadsheets/d/spreadsheet-a/edit#gid=1',
        sheetName: 'cashflow(사용내역 연동)',
        startWeek: '26-1-1',
        endWeek: '26-1-3',
      })
      .expect(200);

    expect(response.body.config).toMatchObject({
      value: 'https://docs.google.com/spreadsheets/d/spreadsheet-a/edit#gid=1',
      sheetName: 'cashflow(사용내역 연동)',
      spreadsheetId: 'spreadsheet-a',
      weekBasis: 'sheet_range',
      totalBasis: 'sheet_range',
      updatedBy: { email: 'user@mysc.co.kr', role: 'workspace_user' },
    });
    expect(previewSpreadsheet).not.toHaveBeenCalled();
    expect(db.__getDocument().cashflowSheetLab).toMatchObject(response.body.config);
  });

  it('keeps one explicit source per project year and replaces only that year on refresh', async () => {
    const db = createDb({
      project: { id: 'project-a', contractStart: '2026-01-01', contractEnd: '2027-12-31' },
    });
    const previewSpreadsheet = vi.fn(async ({ value }) => {
      const year = String(value).includes('2027') ? 2027 : 2026;
      const labels = Array.from({ length: 5 }, (_, index) => `${String(year).slice(2)}-1-${index + 1}`);
      const matrix = buildMatrixWithWeekLabels(labels);
      matrix[10][4] = year === 2026 ? '101' : '202';
      return {
        spreadsheetId: `spreadsheet-${year}`,
        spreadsheetTitle: `${year} cashflow`,
        selectedSheetName: 'cashflow(사용내역 연동)',
        availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
        matrix,
      };
    });
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet } });

    for (const year of [2026, 2027]) {
      await request(app)
        .put('/api/v1/projects/project-a/cashflow-sheet-lab/config')
        .send({
          sourceYear: year,
          value: `https://docs.google.com/spreadsheets/d/spreadsheet-${year}/edit`,
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: `${String(year).slice(2)}-1-1`,
          endWeek: `${String(year).slice(2)}-1-5`,
        })
        .expect(200);
      await request(app)
        .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
        .send({ sourceYear: year, idempotencyKey: `refresh-${year}` })
        .expect(200);
    }

    const config = await request(app)
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/config?sourceYear=2026')
      .expect(200);
    expect(config.body.projectYears).toEqual([2026, 2027]);
    expect(config.body.config).toMatchObject({ sourceYear: 2026, spreadsheetId: 'spreadsheet-2026' });
    expect(config.body.configs).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceYear: 2026, spreadsheetId: 'spreadsheet-2026' }),
      expect.objectContaining({ sourceYear: 2027, spreadsheetId: 'spreadsheet-2027' }),
    ]));

    const mirror = await request(app)
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/mirror')
      .expect(200);
    expect(mirror.body.sources).toMatchObject({
      2026: { sourceYear: 2026, spreadsheetId: 'spreadsheet-2026' },
      2027: { sourceYear: 2027, spreadsheetId: 'spreadsheet-2027' },
    });
    expect([...new Set(mirror.body.cells.map((cell) => Number(cell.yearMonth.slice(0, 4))))]).toEqual([2026, 2027]);
    expect(mirror.body.sheetFacts.projectionActualDifferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ yearMonth: '2026-01', weekNo: 1, amount: 101, sourceCell: 'E11' }),
      expect.objectContaining({ yearMonth: '2027-01', weekNo: 1, amount: 202, sourceCell: 'E11' }),
    ]));
    expect([...new Set(mirror.body.sheetFacts.weeklyCalculationChecks.map((row) => (
      Number(row.yearMonth.slice(0, 4))
    )))]).toEqual([2026, 2027]);
  });

  it('keeps each annual year from one closest sheet source instead of double-counting overlapping 2024/2025 totals', async () => {
    const db = createDb({
      project: { id: 'project-a', contractStart: '2024-01-01', contractEnd: '2028-12-31' },
    });
    const previewSpreadsheet = vi.fn(async ({ value }) => {
      const year = String(value).includes('2027') ? 2027 : 2026;
      const weekLabels = Array.from({ length: 12 }, (_, monthIndex) => (
        Array.from({ length: 5 }, (_unused, weekIndex) => `${String(year).slice(2)}-${monthIndex + 1}-${weekIndex + 1}`)
      )).flat();
      return {
        spreadsheetId: `spreadsheet-${year}`,
        selectedSheetName: 'cashflow(사용내역 연동)',
        availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
        matrix: buildOfficialMatrix({
          weekLabels,
          annualYears: [2025],
          projectionAnnualValues: { 2025: year === 2026 ? '100' : '200' },
          actualAnnualValues: { 2025: year === 2026 ? '50' : '80' },
        }),
      };
    });
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet } });

    for (const year of [2026, 2027]) {
      await request(app)
        .put('/api/v1/projects/project-a/cashflow-sheet-lab/config')
        .send({
          sourceYear: year,
          value: `https://docs.google.com/spreadsheets/d/spreadsheet-${year}/edit`,
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: `${String(year).slice(2)}-1-1`,
          endWeek: `${String(year).slice(2)}-12-5`,
        })
        .expect(200);
      await request(app)
        .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
        .send({ sourceYear: year, idempotencyKey: `refresh-overlap-${year}` })
        .expect(200);
    }

    const mirror = await request(app)
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/mirror')
      .expect(200);
    const cells2025 = mirror.body.annualCells.filter((cell) => cell.year === 2025);
    expect(cells2025).toHaveLength(32);
    expect(new Set(cells2025.map((cell) => cell.sourceYear))).toEqual(new Set([2026]));
    const totals2025 = mirror.body.sheetFacts.annualCashflowTotals.find((row) => row.year === 2025).projection;
    expect(Object.values(totals2025.lineStates).filter((state) => state === 'VALUE')).toHaveLength(16);
    expect(totals2025.lineAmounts.SALES_IN).toBe(100);
    // 합계는 시트의 입금 합계 행 좌표에서만 온다. 이 fixture 는 그 칸이 비어 있으므로
    // 라인 합(700)으로 대체하지 않고 값이 없는 채로 둔다.
    expect(totals2025.totalIn).toBeNull();
  });

  it('invalidates the pinned mirror and staged run when the saved sheet config changes', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
    });
    const javaWeeklyClient = { applyCashflowSheetLab: vi.fn() };
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
        })),
      },
      routeOptions: { editLeasesEnabled: true, javaWeeklyClient },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-before-config-change' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'stage-before-config-change' })
      .expect(200);

    await request(app)
      .put('/api/v1/projects/project-a/cashflow-sheet-lab/config')
      .send({
        value: 'spreadsheet-b',
        sheetName: 'cashflow(사용내역 연동)',
        startWeek: '26-1-1',
        endWeek: '26-1-5',
      })
      .expect(200);
    const staleMirror = await request(app)
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/mirror')
      .expect(200);

    expect(staleMirror.body).toMatchObject({
      status: 'STALE',
      sourceRevision: mirror.body.sourceRevision,
      lastRefreshError: { code: 'cashflow_sheet_config_changed' },
    });
    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'stage-after-config-change' })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_sheet_config_changed'));
    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'stage-before-config-change' })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_sheet_config_changed'));
    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .set({
        'x-edit-session-id': 'session-a',
        'x-edit-lease-id': 'lease-a',
        'x-edit-fence': '7',
      })
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'apply-after-config-change' })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_sheet_config_changed'));
    expect(javaWeeklyClient.applyCashflowSheetLab).not.toHaveBeenCalled();
  });

  it('pins the whole selected tab when refreshing a legacy saved range config', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
    });
    const resultingTargetRevision = `sha256:${'5'.repeat(64)}`;
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => javaApplyResponse(input, resultingTargetRevision)),
    };
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-b',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
        })),
      },
      routeOptions: { editLeasesEnabled: true, javaWeeklyClient },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({
        idempotencyKey: 'refresh-owner-draft-b',
      })
      .expect(200);
    expect(mirror.body).toMatchObject({ status: 'FRESH', spreadsheetId: 'spreadsheet-b' });
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'stage-owner-draft-b' })
      .expect(200);
    expect(stage.body.stagedLineCount).toBeGreaterThan(0);
    expect(mirror.body.cells).toHaveLength(1920);
    expect(mirror.body.activeWeekRange).toMatchObject({ startWeek: '', endWeek: '' });
    expect(javaWeeklyClient.applyCashflowSheetLab).not.toHaveBeenCalled();
  });

  it('returns the system service account email with the saved config', async () => {
    const response = await request(createApp())
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/config')
      .expect(200);

    expect(response.body.systemAccountEmail).toBe('cashflow-service@mysc.iam.gserviceaccount.com');
    expect(response.body.accessPolicy).toMatchObject({
      googleAuth: 'service_account',
      serviceAccountEmail: 'cashflow-service@mysc.iam.gserviceaccount.com',
      sheetPermission: 'shared_with_mysc_system_account',
    });
  });

  it('does not contact Google while reading saved config', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'https://docs.google.com/spreadsheets/d/spreadsheet-a/edit#gid=1',
          sheetName: 'cashflow(사용내역 연동)',
          spreadsheetId: 'spreadsheet-a',
          spreadsheetTitle: '',
          startWeek: '26-1-1',
          endWeek: '26-1-3',
        },
      },
    });
    const getSpreadsheetMeta = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      spreadsheetTitle: '[AXR]사업비 관리 시트',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
    }));

    const response = await request(createApp({
      db,
      googleSheetsService: {
        getServiceAccountEmail: () => 'cashflow-service@mysc.iam.gserviceaccount.com',
        getSpreadsheetMeta,
        previewSpreadsheet: vi.fn(),
      },
    }))
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/config')
      .expect(200);

    expect(response.body.config.spreadsheetTitle).toBe('');
    expect(getSpreadsheetMeta).not.toHaveBeenCalled();
  });

  it('allows saving ranges before sheet headers are verified', async () => {
    await request(createApp())
      .put('/api/v1/projects/project-a/cashflow-sheet-lab/config')
      .send({
        value: 'spreadsheet-a',
        sheetName: 'cashflow(사용내역 연동)',
        startWeek: '26-1-1',
        endWeek: '26-1-4',
      })
      .expect(200);
  });

  it('retires direct live preview so only explicit pinned refresh can read Google', async () => {
    const previewSpreadsheet = vi.fn();

    await request(createApp({ googleSheetsService: { previewSpreadsheet } }))
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/preview')
      .send({ value: 'spreadsheet-a' })
      .expect(410)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_sheet_direct_preview_retired');
      });

    expect(previewSpreadsheet).not.toHaveBeenCalled();
  });

  it('fails closed instead of using the legacy Node multi-transaction apply path', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-2',
        },
      },
    });

    await request(createApp({ db }))
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ idempotencyKey: 'apply-001' })
      .expect(503)
      .expect((response) => expect(response.body.code).toBe('unsafe_bff_runtime'));
    expect(db.__getDocument('orgs/tenant-a/cashflow_weeks/project-a-2026-01-w1')).toBeUndefined();
  });

  it('allows an aligned Live request to reach pinned-stage validation', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-2',
        },
      },
    });

    await request(createApp({
      db,
      routeOptions: {
        env: {
          BFF_DEPLOY_ENV: 'live',
          FIREBASE_PROJECT_ID: 'live-data-project',
          BFF_LIVE_FIREBASE_PROJECT_ID: 'live-data-project',
          JVM_WEEKLY_FIRESTORE_PROJECT_ID: 'live-data-project',
          JVM_WEEKLY_API_BASE_URL: 'https://live-jvm.example',
          JVM_WEEKLY_INTERNAL_API_TOKEN: 'service-token',
        },
      },
    }))
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ idempotencyKey: 'live-apply-001' })
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('cashflow_sheet_stage_run_required'));

    expect(db.__getDocument('orgs/tenant-a/cashflow_weeks/project-a-2026-01-w1')).toBeUndefined();
  });

  it('rejects a misaligned Live runtime before reading project data', async () => {
    let readCount = 0;
    const db = createDb({ onGet: async () => { readCount += 1; } });

    await request(createApp({
      db,
      routeOptions: {
        env: {
          BFF_DEPLOY_ENV: 'live',
          FIREBASE_PROJECT_ID: 'stage-data-project',
          BFF_LIVE_FIREBASE_PROJECT_ID: 'live-data-project',
          JVM_WEEKLY_FIRESTORE_PROJECT_ID: 'stage-data-project',
          JVM_WEEKLY_API_BASE_URL: 'https://live-jvm.example',
          JVM_WEEKLY_INTERNAL_API_TOKEN: 'service-token',
        },
      },
    }))
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ idempotencyKey: 'live-apply-misaligned-001' })
      .expect(503)
      .expect((response) => expect(response.body.code).toBe('unsafe_bff_runtime'));

    expect(readCount).toBe(0);
  });

  it('rejects direct final apply without a pinned stage run', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-1',
        },
      },
    });
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async ({ projectId, lines }) => ({
        ok: true,
        projectId,
        sourceSheetKey: 'cashflow-sheet-lab',
        savedProjectionLineCount: lines.filter((line) => line.mode === 'projection').length,
        savedActualLineCount: lines.filter((line) => line.mode === 'actual').length,
      })),
    };

    await request(createApp({
      db,
      routeOptions: { editLeasesEnabled: true, javaWeeklyClient },
    }))
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .set({
        'x-edit-session-id': 'session-a',
        'x-edit-lease-id': 'lease-a',
        'x-edit-fence': '7',
        'x-edit-finalize': 'true',
      })
      .send({ idempotencyKey: 'apply-jvm-001' })
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('cashflow_sheet_stage_run_required'));

    expect(javaWeeklyClient.applyCashflowSheetLab).not.toHaveBeenCalled();
    expect(db.__getDocument('orgs/tenant-a/cashflow_weeks/project-a-2026-01-w1')).toBeUndefined();
  });

  it.each(['0', '-1', '01', '1e2', '1.0', '9007199254740992'])(
    'ignores obsolete final-apply edit fence %s and still requires a pinned stage run',
    async (fence) => {
      const javaWeeklyClient = { applyCashflowSheetLab: vi.fn() };
      await request(createApp({
        routeOptions: { editLeasesEnabled: true, javaWeeklyClient },
      }))
        .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
        .set({
          'x-edit-session-id': 'session-a',
          'x-edit-lease-id': 'lease-a',
          'x-edit-fence': fence,
        })
        .send({ idempotencyKey: `bad-fence-${fence}` })
        .expect(400)
        .expect((response) => {
          expect(response.body.code).toBe('cashflow_sheet_stage_run_required');
        });
      expect(javaWeeklyClient.applyCashflowSheetLab).not.toHaveBeenCalled();
    },
  );

  it('stages sheet values as cell-level review candidates without updating cashflow weeks', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
      weeks: [{
        id: 'project-a-2026-01-w1',
        projectId: 'project-a',
        yearMonth: '2026-01',
        weekNo: 1,
        projection: { MYSC_PREPAY_IN: 100 },
        actual: { MYSC_PREPAY_IN: 200 },
      }],
    });

    const previewSpreadsheet = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      spreadsheetTitle: 'Cashflow workbook',
      selectedSheetName: 'cashflow(사용내역 연동)',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
    }));
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet } });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-stage-001' })
      .expect(200);

    const response = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({
        expectedMirrorRevision: mirror.body.sourceRevision,
        yearMonth: '2026-01',
        idempotencyKey: 'stage-001',
      })
      .expect(200);

    expect(response.body).toMatchObject({
      ok: true,
      commandName: 'cashflowSheetLab.stage.firebase',
      stagedLineCount: 160,
      projectionLineCount: 80,
      actualLineCount: 80,
    });
    expect(response.body.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'pending_review' }),
    ]));
    expect(db.__getDocument('orgs/tenant-a/cashflow_weeks/project-a-2026-01-w1')).toMatchObject({
      projection: { MYSC_PREPAY_IN: 100 },
      actual: { MYSC_PREPAY_IN: 200 },
    });
    const candidates = db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_change_candidates/');
    expect(candidates).toHaveLength(160);
    const stagedMonths = db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_months/');
    expect(stagedMonths).toHaveLength(1);
    expect(stagedMonths[0].data).toMatchObject({
      projectId: 'project-a',
      yearMonth: '2026-01',
      sourceRevision: mirror.body.sourceRevision,
    });
    expect(stagedMonths[0].data.cells).toHaveLength(160);
    const persistedProjectionCandidate = candidates.find((candidate) => (
      candidate.data.mode === 'projection' && candidate.data.lineId === 'MYSC_PREPAY_IN'
    ))?.data;
    expect(persistedProjectionCandidate).toMatchObject({
      projectId: 'project-a',
      status: 'pending_review',
      source: 'google_sheet',
      lineDirection: 'in',
      beforeAmount: 100,
      beforeHadValue: true,
      proposedAmount: 999,
      proposedHadValue: true,
      sourceCell: expect.any(String),
    });
    expect(candidates.find((candidate) => candidate.data.mode === 'actual' && candidate.data.lineId === 'MYSC_PREPAY_IN')?.data.riskFlags).toEqual([]);
    expect(previewSpreadsheet).toHaveBeenCalledTimes(1);
    expect(db.__getDocument().cashflowSheetLab.activeWeeks).toBeUndefined();
  });

  it('keeps a successful stage response when diagnostic logging and timing fail', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
        },
      },
    });
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrix(),
        })),
      },
      routeOptions: {
        performanceNow: () => { throw new Error('diagnostic clock failed'); },
      },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-stage-diagnostic-failure' })
      .expect(200);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('diagnostic logger failed');
    });
    try {
      const response = await request(app)
        .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
        .send({
          expectedMirrorRevision: mirror.body.sourceRevision,
          idempotencyKey: 'stage-diagnostic-failure',
        })
        .expect(200);
      expect(response.body.status).toBe('READY');
      expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_runs/')[0].data.status).toBe('READY');
    } finally {
      info.mockRestore();
    }
  });

  it('rejects stage when the pinned source revision does not match', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: { value: 'saved-spreadsheet-a', sheetName: 'cashflow(사용내역 연동)' },
      },
    });
    const previewSpreadsheet = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      matrix: buildMatrix(),
    }));
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet } });
    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-wrong-revision' })
      .expect(200);

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: 'sha256:wrong', idempotencyKey: 'stage-wrong-revision' })
      .expect(409)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_sheet_mirror_revision_conflict');
      });
    expect(previewSpreadsheet).toHaveBeenCalledTimes(1);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_change_candidates/')).toHaveLength(0);
  });

  it('releases a resume lock when its fixed mirror changed before any JVM operation', async () => {
    const { app, db, stage } = await stageJanuaryApply({
      applyCashflowSheetLab: vi.fn(async (input) => javaApplyResponse(input, 'sha256:test')),
    }, 'resume-stale');
    const run = db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${stage.body.runId}`);
    const applyRequestHash = createHash('sha256').update(JSON.stringify({
      stagedRunId: stage.body.runId,
      applyRiskCandidates: false,
    })).digest('hex');
    Object.assign(run, {
      status: 'APPLYING',
      appliedIdempotencyKey: 'interrupted-apply',
      applyRequestHash,
      applyOperations: {},
    });
    await db.doc('orgs/tenant-a/cashflow_sheet_publications/project-a').set({
      status: 'APPLYING',
      stagedRunId: stage.body.runId,
    });
    db.__getDocument('orgs/tenant-a/cashflow_sheet_mirrors/project-a').sourceRevision = `sha256:${'9'.repeat(64)}`;

    const resume = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'resume-stale-retry' });
    expect(resume.status).toBe(409);
    expect(resume.body.code).toBe('cashflow_sheet_mirror_revision_conflict');

    expect(db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${stage.body.runId}`))
      .toMatchObject({ status: 'READY', applyFailure: { code: 'cashflow_sheet_mirror_revision_conflict' } });
    expect(db.__getDocument('orgs/tenant-a/cashflow_sheet_publications/project-a')).toMatchObject({ status: 'READY' });
    await request(app)
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/apply-status')
      .expect(200)
      .expect((response) => expect(response.body.status).toBe('IDLE'));

    const uncertainRun = db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${stage.body.runId}`);
    Object.assign(uncertainRun, {
      status: 'APPLYING',
      appliedIdempotencyKey: 'uncertain-apply',
      applyRequestHash,
      applyOperations: { month: { status: 'UNCERTAIN' } },
    });
    await db.doc('orgs/tenant-a/cashflow_sheet_publications/project-a').set({
      status: 'APPLYING',
      stagedRunId: stage.body.runId,
    });
    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'uncertain-retry' })
      .expect(409);
    expect(db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${stage.body.runId}`).status).toBe('APPLYING');
  });

  it('replays stage idempotently without duplicating candidates', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
    });
    const previewSpreadsheet = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
    }));
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet } });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-stage-replay' })
      .expect(200);
    const payload = {
      expectedMirrorRevision: mirror.body.sourceRevision,
      yearMonth: '2026-01',
      idempotencyKey: 'stage-replay-001',
    };

    const first = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send(payload)
      .expect(200);
    const replay = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send(payload)
      .expect(200);

    expect(replay.body.runId).toBe(first.body.runId);
    expect(replay.body.lastStagedAt).toBe(first.body.lastStagedAt);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_change_candidates/')).toHaveLength(160);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_runs/')).toHaveLength(1);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_months/')).toHaveLength(1);
    expect(previewSpreadsheet).toHaveBeenCalledTimes(1);
  });

  it('uses deterministic candidate identities when the same stage request overlaps', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
    });
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
        })),
      },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-stage-overlap' })
      .expect(200);
    const payload = {
      expectedMirrorRevision: mirror.body.sourceRevision,
      yearMonth: '2026-01',
      idempotencyKey: 'stage-overlap-001',
    };
    let tick = 0;
    const toISOString = vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => (
      `2026-07-13T00:00:00.${String(tick++).padStart(3, '0')}Z`
    ));

    try {
      const responses = await Promise.all([
        request(app).post('/api/v1/projects/project-a/cashflow-sheet-lab/stage').send(payload),
        request(app).post('/api/v1/projects/project-a/cashflow-sheet-lab/stage').send(payload),
      ]);
      expect(responses.every((response) => [200, 409].includes(response.status))).toBe(true);
    } finally {
      toISOString.mockRestore();
    }

    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_change_candidates/')).toHaveLength(160);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_runs/')).toHaveLength(1);
  });

  it('persists all 2,176 stage candidates in five bounded batches with a three-item response preview', async () => {
    const performanceEvents = [];
    const candidatePrefix = 'orgs/tenant-a/cashflow_change_candidates/';
    let retainedFieldInjected = false;
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
        },
      },
      onWrite: ({ path, patch, value }) => {
        if (!retainedFieldInjected && path.includes('/cashflow_sheet_stage_runs/') && patch.status === 'STAGING') {
          retainedFieldInjected = true;
          value.preexistingDiagnostic = 'retained-by-merge';
        }
      },
    });
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMaximumCandidateMatrix(),
        })),
      },
      routeOptions: { performanceLogger: (event) => performanceEvents.push(event) },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-stage-maximum-batches' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({
        expectedMirrorRevision: mirror.body.sourceRevision,
        idempotencyKey: 'stage-maximum-batches',
      })
      .expect(200);

    expect(stage.body).toMatchObject({
      status: 'READY',
      stagedLineCount: 2176,
      annualLineCount: 256,
    });
    const candidates = db.__getDocumentsByPrefix(candidatePrefix);
    expect(candidates).toHaveLength(2176);
    expect(candidates.every(({ path }) => /\/cfc_[a-f0-9]{32}$/.test(path))).toBe(true);
    expect(db.__getBatchCommitSizes()).toEqual([450, 450, 450, 450, 376]);
    expect(db.__getDirectSetPaths().filter((path) => path.startsWith(candidatePrefix))).toEqual([]);
    expect(stage.body.candidates).toHaveLength(3);
    expect(stage.body.omittedCandidateCount).toBe(2173);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stage.headers['server-timing']).toMatch(/stage_read;dur=\d+/);
    expect(stage.headers['server-timing']).toMatch(/stage_build;dur=\d+/);
    expect(stage.headers['server-timing']).toMatch(/stage_write;dur=\d+/);
    const persistedRun = db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_runs/')[0].data;
    expect(performanceEvents).toContainEqual(expect.objectContaining({
      operation: 'cashflow.sheet_stage',
      phase: 'stage_persistence',
      outcome: 'ok',
      candidateCount: 2176,
      candidateBatchCount: 5,
      persistedRunJsonBytes: Buffer.byteLength(JSON.stringify(persistedRun), 'utf8'),
    }));
  });

  it('does not publish READY after a middle candidate batch fails and retries without duplicates', async () => {
    const candidatePrefix = 'orgs/tenant-a/cashflow_change_candidates/';
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
        },
      },
      onBatchCommit: ({ attempt }) => {
        if (attempt === 3) throw new Error('injected third candidate batch failure');
      },
    });
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMaximumCandidateMatrix(),
        })),
      },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-stage-batch-failure' })
      .expect(200);
    const payload = {
      expectedMirrorRevision: mirror.body.sourceRevision,
      idempotencyKey: 'stage-batch-failure',
    };

    const failed = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send(payload);
    expect(failed.status).toBe(500);

    const partialCandidates = db.__getDocumentsByPrefix(candidatePrefix);
    expect(partialCandidates).toHaveLength(900);
    const partialCandidatePaths = partialCandidates.map(({ path }) => path);
    const failedRuns = db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_runs/');
    expect(failedRuns).toHaveLength(1);
    expect(failedRuns[0].data).toMatchObject({ status: 'STAGING_FAILED' });
    expect(failedRuns[0].data.response).toBeUndefined();
    expect(failedRuns.filter(({ data }) => data.status === 'READY')).toEqual([]);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_months/')).toEqual([]);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_years/')).toEqual([]);

    const retried = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send(payload)
      .expect(200);
    expect(retried.body).toMatchObject({ status: 'READY', stagedLineCount: 2176 });
    const finalCandidates = db.__getDocumentsByPrefix(candidatePrefix);
    const successfulRuns = db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_runs/');
    expect(successfulRuns).toHaveLength(1);
    expect(successfulRuns[0].data).toMatchObject({
      status: 'READY',
      failedAt: null,
      failure: null,
    });
    const currentCandidates = finalCandidates.filter(({ data }) => (
      data.candidateManifestHash === successfulRuns[0].data.candidateManifestHash
      && data.stageAttemptId === successfulRuns[0].data.stageAttemptId
    ));
    expect(currentCandidates).toHaveLength(2176);
    expect(new Set(currentCandidates.map(({ path }) => path)).size).toBe(2176);
    expect(finalCandidates).toHaveLength(2176);
    expect(partialCandidatePaths.every((path) => currentCandidates.some((candidate) => candidate.path === path))).toBe(true);
  });

  it('excludes stale annual children when a failed stage retry loses an annual candidate year', async () => {
    const candidatePrefix = 'orgs/tenant-a/cashflow_change_candidates/';
    const yearMonths = Array.from(
      { length: 12 },
      (_unused, index) => `2026-${String(index + 1).padStart(2, '0')}`,
    );
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
        },
      },
      weeks: matchingCanonicalWeeks(1120, yearMonths),
      onBatchCommit: ({ attempt }) => {
        if (attempt === 3) throw new Error('injected third candidate batch failure');
      },
    });
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => javaApplyResponse(input, `sha256:${'6'.repeat(64)}`)),
      applyCashflowSheetBatch: vi.fn(async (input) => javaBatchApplyResponse(input, `sha256:${'6'.repeat(64)}`)),
      applyCashflowSheetAnnualTotal: vi.fn(async (input) => javaAnnualApplyResponse(input)),
    };
    const previewSpreadsheet = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      matrix: buildMaximumCandidateMatrix(),
    }));
    const app = createApp({
      db,
      googleSheetsService: { previewSpreadsheet },
      routeOptions: { javaWeeklyClient },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-stage-stale-child-first' })
      .expect(200);
    const payload = {
      expectedMirrorRevision: mirror.body.sourceRevision,
      idempotencyKey: 'stage-stale-child-retry',
    };

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send(payload)
      .expect(500);
    const partialCandidates = db.__getDocumentsByPrefix(candidatePrefix);
    expect(partialCandidates).toHaveLength(900);
    expect(partialCandidates.filter(({ data }) => data.scope === 'annual' && data.year === 2024)).toHaveLength(32);

    const projection2024 = Object.fromEntries(CASHFLOW_LINE_IDS.map((lineId) => [lineId, 100]));
    const actual2024 = Object.fromEntries(CASHFLOW_LINE_IDS.map((lineId) => [lineId, 50]));
    const valueStates = Object.fromEntries(CASHFLOW_LINE_IDS.map((lineId) => [lineId, 'VALUE']));
    const annual2024Id = Buffer.from('project-a\n2024', 'utf8').toString('base64url');
    await db.doc(`orgs/tenant-a/cashflow_sheet_year_totals/${annual2024Id}`).set({
      projectId: 'project-a',
      year: 2024,
      revision: 1,
      sourceRevision: 'canonical-2024',
      projection: projection2024,
      actual: actual2024,
      projectionStates: valueStates,
      actualStates: valueStates,
    });

    const retried = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send(payload)
      .expect(200);
    expect(retried.body).toMatchObject({
      status: 'READY',
      stagedLineCount: 1024,
      stagedMonths: ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12'],
      stagedYears: [2025, 2027, 2028, 2029, 2030, 2031, 2032],
      annualLineCount: 224,
    });

    const applied = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: retried.body.runId, idempotencyKey: 'apply-stage-stale-child-retry' });
    const appliedCandidates = db.__getDocumentsByPrefix(candidatePrefix)
      .filter(({ data }) => data.status === 'applied');
    expect({
      status: applied.status,
      code: applied.body.code,
      appliedMonths: applied.body.appliedMonths,
      appliedYears: applied.body.appliedYears,
      appliedCandidateCount: appliedCandidates.length,
      appliedWeeklyCandidateCount: appliedCandidates.filter(({ data }) => data.scope !== 'annual').length,
      monthlyApplyCalls: javaWeeklyClient.applyCashflowSheetLab.mock.calls.length
        + javaWeeklyClient.applyCashflowSheetBatch.mock.calls.length,
      annualApplyCalls: javaWeeklyClient.applyCashflowSheetAnnualTotal.mock.calls.length,
    }).toEqual({
      status: 200,
      code: undefined,
      appliedMonths: ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12'],
      appliedYears: [2025, 2027, 2028, 2029, 2030, 2031, 2032],
      appliedCandidateCount: 1024,
      appliedWeeklyCandidateCount: 800,
      monthlyApplyCalls: 1,
      annualApplyCalls: 7,
    });
  });

  it('keeps a newer READY attempt usable when an expired attempt finishes its candidate batches late', async () => {
    let releaseExpiredAttempt;
    let markExpiredAttemptBlocked;
    const expiredAttemptBlocked = new Promise((resolve) => { markExpiredAttemptBlocked = resolve; });
    const holdExpiredAttempt = new Promise((resolve) => { releaseExpiredAttempt = resolve; });
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
        },
      },
      onBatchCommit: async ({ attempt }) => {
        if (attempt !== 1) return;
        markExpiredAttemptBlocked();
        await holdExpiredAttempt;
      },
    });
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => javaApplyResponse(input, `sha256:${'7'.repeat(64)}`)),
      applyCashflowSheetBatch: vi.fn(async (input) => javaBatchApplyResponse(input, `sha256:${'7'.repeat(64)}`)),
      applyCashflowSheetAnnualTotal: vi.fn(async (input) => javaAnnualApplyResponse(input)),
    };
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrix(),
        })),
      },
      routeOptions: { javaWeeklyClient },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-stage-expired-attempt' })
      .expect(200);
    const payload = {
      expectedMirrorRevision: mirror.body.sourceRevision,
      idempotencyKey: 'stage-expired-attempt',
    };
    let nowMs = Date.parse('2026-08-21T00:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const expiredRequest = request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send(payload)
      .then((response) => response);
    let newerResponse;
    let expiredResponse;
    let appliedResponse;
    try {
      await expiredAttemptBlocked;
      nowMs += 61_000;
      newerResponse = await request(app)
        .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
        .send(payload);
      appliedResponse = await request(app)
        .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
        .send({ stageRunId: newerResponse.body.runId, idempotencyKey: 'apply-stage-expired-attempt' });
      releaseExpiredAttempt();
      expiredResponse = await expiredRequest;
    } finally {
      releaseExpiredAttempt();
      nowSpy.mockRestore();
    }

    const run = db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_runs/')[0].data;
    const candidates = db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_change_candidates/');
    const currentCandidateCount = candidates
      .filter(({ data }) => (
        data.candidateManifestHash === run.candidateManifestHash
        && data.stageAttemptId === run.stageAttemptId
      ))
      .length;
    const appliedCandidateCount = candidates
      .filter(({ data }) => (
        data.candidateManifestHash === run.candidateManifestHash
        && data.stageAttemptId === run.stageAttemptId
        && data.status === 'applied'
      ))
      .length;

    expect({
      newerStatus: newerResponse.status,
      expiredStatus: expiredResponse.status,
      runStatus: run.status,
      currentCandidateCount,
      appliedCandidateCount,
      stagedLineCount: run.stagedLineCount,
      applyStatus: appliedResponse.status,
      applyCode: appliedResponse.body.code,
    }).toEqual({
      newerStatus: 200,
      expiredStatus: 409,
      runStatus: 'APPLIED',
      currentCandidateCount: run.stagedLineCount,
      appliedCandidateCount: run.stagedLineCount,
      stagedLineCount: run.stagedLineCount,
      applyStatus: 200,
      applyCode: undefined,
    });
  });

  it('keeps a 12-month closed and pending stage under 900 KiB while replaying every confirmation detail', async () => {
    const months = Array.from(
      { length: 12 },
      (_unused, index) => `2026-${String(index + 1).padStart(2, '0')}`,
    );
    const closedMonthDocuments = Object.fromEntries(months.map((yearMonth) => [
      `orgs/tenant-a/monthly_closes/project-a-${yearMonth}`,
      {
        contractVersion: 'cashflow-month-close-v1',
        tenantId: 'tenant-a',
        projectId: 'project-a',
        yearMonth,
        status: 'CLOSED',
      },
    ]));
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
        },
      },
      initialDocuments: {
        ...cumulativeCloseRequestDocuments({ throughMonth: '2026-12' }),
        ...closedMonthDocuments,
      },
    });
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrix(),
        })),
      },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-stage-12-month-confirmations' })
      .expect(200);
    const payload = {
      expectedMirrorRevision: mirror.body.sourceRevision,
      idempotencyKey: 'stage-12-month-confirmations',
    };
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send(payload)
      .expect(200);

    expect(stage.body).toMatchObject({
      status: 'READY',
      stagedLineCount: 1920,
      closedMonthDifferenceCount: 1920,
      pendingApprovalDifferenceCount: 1920,
    });
    expect(stage.body.closedMonthDifferences).toHaveLength(12);
    expect(stage.body.pendingApprovalDifferences).toHaveLength(12);
    expect(stage.body.closedMonthDifferences.flatMap((difference) => difference.changes)).toHaveLength(1920);
    expect(stage.body.pendingApprovalDifferences.flatMap((difference) => difference.changes)).toHaveLength(1920);
    expect(stage.body.closedMonthDifferenceManifestHash)
      .toBe(stageManifestHash(stage.body.closedMonthDifferences));
    expect(stage.body.pendingApprovalDifferenceManifestHash)
      .toBe(stageManifestHash(stage.body.pendingApprovalDifferences));

    const persistedStageDocuments = db.__getDocumentsByPrefix('orgs/tenant-a/')
      .filter(({ path }) => [
        '/cashflow_change_candidates/',
        '/cashflow_sheet_stage_runs/',
        '/cashflow_sheet_stage_months/',
        '/cashflow_sheet_stage_years/',
      ].some((segment) => path.includes(segment)));
    const oversizedDocuments = persistedStageDocuments
      .map(({ path, data }) => ({ path, bytes: Buffer.byteLength(JSON.stringify(data), 'utf8') }))
      .filter(({ bytes }) => bytes >= 900 * 1024);
    expect(oversizedDocuments).toEqual([]);
    expect(stage.body.candidates).toHaveLength(3);
    expect(stage.body.omittedCandidateCount).toBe(1917);

    const replay = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send(payload)
      .expect(200);
    expect(replay.body).toEqual(stage.body);
  });

  it('blocks only a month containing an invalid pinned cell', async () => {
    const matrix = buildMatrix();
    matrix[14][4] = '확인 필요';
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-1',
        },
      },
    });
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix,
        })),
      },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-invalid-month' })
      .expect(200);
    expect(mirror.body.summary.invalidCount).toBe(1);

    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: 'stage-invalid-month' })
      .expect(200);
    expect(stage.body).toMatchObject({
      status: 'BLOCKED',
      stagedLineCount: 0,
      blockedMonths: ['2026-01'],
    });
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_change_candidates/')).toHaveLength(0);
  });

  it('preserves an EMPTY pinned cell as an authoritative removal candidate', async () => {
    const matrix = buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS);
    matrix[14][4] = '-';
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
      weeks: [{
        id: 'project-a-2026-01-w1',
        projectId: 'project-a',
        yearMonth: '2026-01',
        weekNo: 1,
        projection: { MYSC_PREPAY_IN: 100 },
      }],
    });
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix,
        })),
      },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-empty-cell' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: 'stage-empty-cell' })
      .expect(200);
    const removal = stage.body.candidates.find((candidate) => (
      candidate.mode === 'projection' && candidate.lineId === 'MYSC_PREPAY_IN'
    ));
    expect(removal).toMatchObject({
      beforeHadValue: true,
      beforeAmount: 100,
      proposedHadValue: false,
      proposedAmount: null,
      cellState: 'EMPTY',
    });
  });

  it('compares Actual against the cashflow-sheet-lab source contribution instead of the aggregate', async () => {
    const matrix = buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS);
    matrix[40][4] = '600';
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
      weeks: [{
        id: 'project-a-2026-01-w1',
        projectId: 'project-a',
        yearMonth: '2026-01',
        weekNo: 1,
        actual: { SALES_IN: 600 },
        weeklyExpenseActualBySheet: {
          bank: { SALES_IN: 500 },
          'cashflow-sheet-lab': { SALES_IN: 100 },
        },
      }],
    });
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix,
        })),
      },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-source-specific-actual' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: 'stage-source-specific-actual' })
      .expect(200);

    expect(stage.body.candidates).toContainEqual(expect.objectContaining({
      mode: 'actual',
      yearMonth: '2026-01',
      weekNo: 1,
      lineId: 'SALES_IN',
      beforeHadValue: true,
      beforeAmount: 100,
      proposedHadValue: true,
      proposedAmount: 600,
    }));
  });

  it('shows legacy aggregate Actual removals for human review before the one-time sheet overwrite', async () => {
    const matrix = buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS);
    // 진짜 빈칸이어야 미기입이다. Actual 의 '-' 는 회계 서식의 0 이라 제거가 아니라 0 변경 제안이 된다.
    matrix[40][4] = '';
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
      weeks: [{
        id: 'project-a-2026-01-w1',
        projectId: 'project-a',
        yearMonth: '2026-01',
        weekNo: 1,
        actual: { SALES_IN: 123 },
      }],
    });
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix,
        })),
      },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-legacy-actual' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: 'stage-legacy-actual' })
      .expect(200);

    expect(stage.body.candidates).toContainEqual(expect.objectContaining({
      mode: 'actual',
      yearMonth: '2026-01',
      weekNo: 1,
      lineId: 'SALES_IN',
      beforeHadValue: true,
      beforeAmount: 123,
      proposedHadValue: false,
      proposedAmount: null,
    }));
  });

  it('requires closed-month reason before pending-approval confirmation and rejects forged evidence', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
      initialDocuments: {
        ...cumulativeCloseRequestDocuments(),
        'orgs/tenant-a/monthly_closes/project-a-2026-01': {
          contractVersion: 'cashflow-month-close-v1',
          tenantId: 'tenant-a',
          projectId: 'project-a',
          yearMonth: '2026-01',
          status: 'CLOSED',
        },
      },
    });
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => javaApplyResponse(input, `sha256:${'7'.repeat(64)}`)),
    };
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
        })),
      },
      routeOptions: { javaWeeklyClient },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-pending-close' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: 'stage-pending-close' })
      .expect(200);

    expect(stage.body.pendingApprovalDifferenceCount).toBe(160);
    expect(stage.body.closedMonthDifferenceCount).toBe(160);
    expect(stage.body.pendingApprovalDifferenceManifestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(stage.body.pendingApprovalDifferences).toEqual([expect.objectContaining({
      requestId: 'project-a-2026-01',
      requestRevision: 1,
      requestStatus: 'PENDING',
      yearMonth: '2026-01',
      differenceCount: 160,
      weeks: [1, 2, 3, 4, 5],
      truncatedChangeCount: 0,
      changes: expect.any(Array),
    })]);
    expect(stage.body.pendingApprovalDifferences[0].changes).toHaveLength(160);
    expect(stage.body.pendingApprovalDifferences[0].changes).toContainEqual(expect.objectContaining({
      mode: 'projection', weekNo: 1, lineId: CASHFLOW_LINE_IDS[0],
      beforeHadValue: true, beforeState: 'ZERO', beforeAmount: 0,
      afterHadValue: true, afterState: 'VALUE', afterAmount: 999,
    }));
    expect(stage.body.pendingApprovalDifferences[0].changes).toContainEqual(expect.objectContaining({
      beforeHadValue: false, beforeState: 'EMPTY', beforeAmount: null,
      afterHadValue: true, afterState: 'VALUE', afterAmount: 999,
    }));

    const closedMonthRejected = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'apply-closed-before-pending' })
      .expect(409);
    expect(closedMonthRejected.body.code).toBe('cashflow_closed_month_reason_required');
    expect(javaWeeklyClient.applyCashflowSheetLab).not.toHaveBeenCalled();

    for (const forged of [
      { pendingApprovalDifferenceCount: 159, pendingApprovalDifferenceManifestHash: stage.body.pendingApprovalDifferenceManifestHash },
      { pendingApprovalDifferenceCount: 160, pendingApprovalDifferenceManifestHash: `sha256:${'0'.repeat(64)}` },
    ]) {
      const rejected = await request(app)
        .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
        .send({
          stageRunId: stage.body.runId,
          closedMonthChangeReason: '결산 완료 월 변경 확인',
          closedMonthDifferenceCount: stage.body.closedMonthDifferenceCount,
          closedMonthDifferenceManifestHash: stage.body.closedMonthDifferenceManifestHash,
          acceptPendingApprovalDifferences: true,
          ...forged,
          idempotencyKey: `apply-pending-forged-${forged.pendingApprovalDifferenceCount}-${forged.pendingApprovalDifferenceManifestHash.slice(-1)}`,
        })
        .expect(409);
      expect(rejected.body.code).toBe('cashflow_pending_approval_confirmation_required');
    }
    expect(javaWeeklyClient.applyCashflowSheetLab).not.toHaveBeenCalled();

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({
        stageRunId: stage.body.runId,
        closedMonthChangeReason: '결산 완료 월 변경 확인',
        closedMonthDifferenceCount: stage.body.closedMonthDifferenceCount,
        closedMonthDifferenceManifestHash: stage.body.closedMonthDifferenceManifestHash,
        acceptPendingApprovalDifferences: true,
        pendingApprovalDifferenceCount: stage.body.pendingApprovalDifferenceCount,
        pendingApprovalDifferenceManifestHash: stage.body.pendingApprovalDifferenceManifestHash,
        idempotencyKey: 'apply-pending-confirmed',
      })
      .expect(200);
    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledTimes(1);

    const forceMirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-pending-force' })
      .expect(200);
    const forceStage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({
        expectedMirrorRevision: forceMirror.body.sourceRevision,
        yearMonth: '2026-01',
        replaceAllActualSources: true,
        idempotencyKey: 'stage-pending-force',
      })
      .expect(200);
    // 시트가 진실인 쓰기 모드(replaceAllActualSources)여도 결재 중인 회차의 차이는 그대로 보고되고,
    // 확인 근거 없이는 반영되지 않는다. 7월엔 이 플래그가 결재 차단까지 같이 껐다.
    expect(forceStage.body.status).toBe('READY');
    expect(forceStage.body.pendingApprovalDifferenceCount).toBe(160);
    expect(forceStage.body.pendingApprovalDifferenceManifestHash).toBe(stage.body.pendingApprovalDifferenceManifestHash);
    const forcedWithoutEvidence = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({
        stageRunId: forceStage.body.runId,
        replaceAllActualSources: true,
        closedMonthChangeReason: '결산 완료 월 변경 확인',
        closedMonthDifferenceCount: forceStage.body.closedMonthDifferenceCount,
        closedMonthDifferenceManifestHash: forceStage.body.closedMonthDifferenceManifestHash,
        idempotencyKey: 'apply-pending-force',
      })
      .expect(409);
    expect(forcedWithoutEvidence.body.code).toBe('cashflow_pending_approval_confirmation_required');
    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({
        stageRunId: forceStage.body.runId,
        replaceAllActualSources: true,
        closedMonthChangeReason: '결산 완료 월 변경 확인',
        closedMonthDifferenceCount: forceStage.body.closedMonthDifferenceCount,
        closedMonthDifferenceManifestHash: forceStage.body.closedMonthDifferenceManifestHash,
        acceptPendingApprovalDifferences: true,
        pendingApprovalDifferenceCount: forceStage.body.pendingApprovalDifferenceCount,
        pendingApprovalDifferenceManifestHash: forceStage.body.pendingApprovalDifferenceManifestHash,
        idempotencyKey: 'apply-pending-force-confirmed',
      })
      .expect(200);
    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledTimes(2);
  });

  it('accepts the canonical cycle month plus separate throughMonth contract', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: { value: 'saved-spreadsheet-a', sheetName: 'cashflow(사용내역 연동)' },
      },
      initialDocuments: cumulativeCloseRequestDocuments({ throughMonth: '2026-07', cycleYearMonth: '2026-08' }),
    });
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
        })),
      },
    });
    const mirror = await request(app).post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-canonical-horizon' }).expect(200);
    const stage = await request(app).post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-08', idempotencyKey: 'stage-canonical-horizon' })
      .expect(200);

    expect(stage.body.pendingApprovalContractIssues).toEqual([]);
  });

  it('does not mutate a malformed legacy PENDING close during sheet staging', async () => {
    const documents = cumulativeCloseRequestDocuments();
    const requestPath = 'orgs/tenant-a/cashflow_month_close_requests/project-a-2026-01';
    documents[requestPath] = {
      ...documents[requestPath],
      fromMonth: '24-1-1',
      monthCount: 0,
      requestedByUid: 'pm-a',
    };
    documents['orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-01'] = {
      tenantId: 'tenant-a', projectId: 'project-a', yearMonth: '2026-01',
      periods: { MONTH: { status: 'PENDING_APPROVAL', revision: 3 } },
    };
    const db = createDb({
      project: { id: 'project-a', cashflowSheetLab: { value: 'saved-spreadsheet-a', sheetName: 'cashflow(사용내역 연동)' } },
      initialDocuments: documents,
    });
    const app = createApp({
      db,
      context: { actorId: 'finance-a', actorRole: 'finance' },
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a', selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
        })),
      },
    });
    const mirror = await request(app).post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-malformed-close' }).expect(200);
    const stage = await request(app).post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: 'stage-malformed-close' })
      .expect(200);

    expect(stage.body.status).toBe('BLOCKED');
    expect(stage.body.pendingApprovalContractIssues).toEqual([expect.objectContaining({
      requestId: 'project-a-2026-01',
      reasonCode: 'cashflow_pending_approval_contract_unsupported',
      blockedMonths: ['2026-01'],
    })]);
    expect(stage.body.stagedLineCount).toBe(0);
    expect(stage.body.candidates).toEqual([]);
    expect(db.__getDocument(requestPath)).toMatchObject({
      status: 'PENDING', monthCount: 0,
    });
    expect(db.__getDocument('orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-01').periods.MONTH)
      .toMatchObject({ status: 'PENDING_APPROVAL', revision: 3 });
    expect(db.__getDocument('orgs/tenant-a/cashflow_month_close_request_audits/project-a-2026-01-r1-withdrawn')).toBeUndefined();
  });

  it('rejects apply when an active close request status changes after staging', async () => {
    const requestDocuments = cumulativeCloseRequestDocuments();
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
      initialDocuments: requestDocuments,
    });
    const javaWeeklyClient = { applyCashflowSheetLab: vi.fn() };
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
        })),
      },
      routeOptions: { javaWeeklyClient },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-pending-race' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: 'stage-pending-race' })
      .expect(200);
    db.__getDocument('orgs/tenant-a/cashflow_month_close_requests/project-a-2026-01').status = 'APPROVING';

    const rejected = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({
        stageRunId: stage.body.runId,
        acceptPendingApprovalDifferences: true,
        pendingApprovalDifferenceCount: stage.body.pendingApprovalDifferenceCount,
        pendingApprovalDifferenceManifestHash: stage.body.pendingApprovalDifferenceManifestHash,
        idempotencyKey: 'apply-pending-race',
      })
      .expect(409);
    expect(rejected.body.code).toBe('cashflow_pending_approval_evidence_stale');
    expect(javaWeeklyClient.applyCashflowSheetLab).not.toHaveBeenCalled();
  });

  it('passes one pending-approval warning instruction for 100 changed cells in one month and replays idempotently', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a', sheetName: 'cashflow(사용내역 연동)', startWeek: '26-1-1', endWeek: '26-1-5',
        },
      },
      weeks: matchingCanonicalWeeks(60),
      initialDocuments: cumulativeCloseRequestDocuments(),
    });
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => javaApplyResponse(input, `sha256:${'8'.repeat(64)}`)),
    };
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a', selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
        })),
      },
      routeOptions: { javaWeeklyClient },
    });
    const mirror = await request(app).post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-pending-100' }).expect(200);
    const stage = await request(app).post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: 'stage-pending-100' }).expect(200);
    expect(stage.body.pendingApprovalDifferenceCount).toBe(100);
    const applyPayload = {
      stageRunId: stage.body.runId,
      acceptPendingApprovalDifferences: true,
      pendingApprovalDifferenceCount: 100,
      pendingApprovalDifferenceManifestHash: stage.body.pendingApprovalDifferenceManifestHash,
      idempotencyKey: 'apply-pending-100',
    };
    const applied = await request(app).post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send(applyPayload).expect(200);
    await request(app).post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send(applyPayload).expect(200).expect(applied.body);

    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledTimes(1);
    const instruction = javaWeeklyClient.applyCashflowSheetLab.mock.calls[0][0].pendingApprovalAffectedMonths;
    expect(instruction).toEqual([expect.objectContaining({
      yearMonth: '2026-01', warningCountIncrement: 1, differenceCount: 100,
    })]);
    expect(instruction[0].approvalDifferences.flatMap((difference) => difference.changes)).toHaveLength(100);
  });

  it('passes exactly one pending-approval warning instruction per affected month', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a', sheetName: 'cashflow(사용내역 연동)', startWeek: '26-1-1', endWeek: '26-2-5',
        },
      },
      initialDocuments: cumulativeCloseRequestDocuments({ throughMonth: '2026-02' }),
    });
    const javaWeeklyClient = {
      applyCashflowSheetBatch: vi.fn(async (input) => javaBatchApplyResponse(input, `sha256:${'9'.repeat(64)}`)),
    };
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a', selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrixWithWeekLabels([...JANUARY_FINANCE_WEEKS, '26-2-1', '26-2-2', '26-2-3', '26-2-4', '26-2-5']),
        })),
      },
      routeOptions: { javaWeeklyClient },
    });
    const mirror = await request(app).post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-pending-two-months' }).expect(200);
    const stage = await request(app).post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'stage-pending-two-months' }).expect(200);
    await request(app).post('/api/v1/projects/project-a/cashflow-sheet-lab/apply').send({
      stageRunId: stage.body.runId,
      acceptPendingApprovalDifferences: true,
      pendingApprovalDifferenceCount: stage.body.pendingApprovalDifferenceCount,
      pendingApprovalDifferenceManifestHash: stage.body.pendingApprovalDifferenceManifestHash,
      idempotencyKey: 'apply-pending-two-months',
    }).expect(200);

    const instructions = javaWeeklyClient.applyCashflowSheetBatch.mock.calls[0][0].pendingApprovalAffectedMonths;
    expect(instructions.map((instruction) => [instruction.yearMonth, instruction.warningCountIncrement]))
      .toEqual([['2026-01', 1], ['2026-02', 1]]);
    expect(instructions.map((instruction) => instruction.approvalDifferences.flatMap((difference) => difference.changes).length))
      .toEqual([160, 160]);
  });

  it('requires explicit confirmation before applying staged closed-month differences', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
      weeks: [{
        id: 'project-a-2026-01-w1',
        projectId: 'project-a',
        yearMonth: '2026-01',
        weekNo: 1,
        adminClosed: true,
      }],
      initialDocuments: {
        'orgs/tenant-a/monthly_closes/project-a-2026-01': {
          contractVersion: 'cashflow-month-close-v1',
          tenantId: 'tenant-a',
          projectId: 'project-a',
          yearMonth: '2026-01',
          status: 'CLOSED',
        },
      },
    });
    const resultingTargetRevision = `sha256:${'6'.repeat(64)}`;
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => javaApplyResponse(input, resultingTargetRevision)),
    };
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
        })),
      },
      routeOptions: { javaWeeklyClient },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-closed-month' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: 'stage-closed-month' })
      .expect(200);

    expect(stage.body).toMatchObject({
      status: 'READY',
      blockedMonths: [],
      stagedLineCount: 160,
      riskLineCount: 160,
      closedMonthDifferences: [{
        yearMonth: '2026-01',
        differenceCount: 160,
        weeks: [1, 2, 3, 4, 5],
      }],
    });
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_change_candidates/')).toHaveLength(160);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_months/')).toHaveLength(1);
    const expectedDifferences = expectedClosedMonthDifferences(db);
    expect(expectedDifferences[0].changes).toHaveLength(160);
    expect(stage.body.closedMonthDifferences).toEqual(expectedDifferences);

    const rejected = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'apply-closed-month-unconfirmed' })
      .expect(409);
    expect(rejected.body).toMatchObject({
      code: 'cashflow_closed_month_reason_required',
      details: { closedMonthDifferences: stage.body.closedMonthDifferences },
    });
    expect(javaWeeklyClient.applyCashflowSheetLab).not.toHaveBeenCalled();

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({
        stageRunId: stage.body.runId,
        idempotencyKey: 'apply-closed-month-confirmed',
        closedMonthChangeReason: '결산 완료 월 변경 확인',
        closedMonthDifferenceCount: stage.body.closedMonthDifferenceCount,
        closedMonthDifferenceManifestHash: stage.body.closedMonthDifferenceManifestHash,
      })
      .expect(200);
    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledWith(expect.objectContaining({
      closedMonthChangeReason: '결산 완료 월 변경 확인',
    }));
  });

  it('acknowledges a fresh matching mirror without JVM mutation and replays the stage request', async () => {
    const amounts = Object.fromEntries(CASHFLOW_LINE_IDS.map((lineId) => [lineId, 999]));
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
      weeks: Array.from({ length: 5 }, (_unused, index) => ({
        id: `project-a-2026-01-w${index + 1}`,
        projectId: 'project-a',
        yearMonth: '2026-01',
        weekNo: index + 1,
        ...(index === 0 ? { adminClosed: true } : {}),
        projection: { ...amounts },
        actual: { ...amounts },
      })),
      initialDocuments: {
        'orgs/tenant-a/monthly_closes/project-a-2026-01': {
          contractVersion: 'cashflow-month-close-v1',
          tenantId: 'tenant-a',
          projectId: 'project-a',
          yearMonth: '2026-01',
          status: 'CLOSED',
        },
      },
    });
    const javaWeeklyClient = { applyCashflowSheetLab: vi.fn(), applyCashflowSheetBatch: vi.fn() };
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
        })),
      },
      routeOptions: { javaWeeklyClient },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-closed-month-same-values' })
      .expect(200);
    expect(mirror.body.status).toBe('FRESH');
    const canonicalBefore = db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_weeks/');
    const payload = {
      expectedMirrorRevision: mirror.body.sourceRevision,
      yearMonth: '2026-01',
      idempotencyKey: 'stage-closed-month-same-values',
    };
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send(payload)
      .expect(200);
    const replay = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send(payload)
      .expect(200);

    expect(stage.body).toMatchObject({
      status: 'NO_CHANGES',
      blockedMonths: [],
      closedMonthDifferences: [],
      stagedLineCount: 0,
      riskLineCount: 0,
    });
    expect(replay.body).toEqual(stage.body);
    expect(javaWeeklyClient.applyCashflowSheetLab).not.toHaveBeenCalled();
    expect(javaWeeklyClient.applyCashflowSheetBatch).not.toHaveBeenCalled();
    expect(db.__getDocument('orgs/tenant-a/cashflow_sheet_mirrors/project-a')).toMatchObject({
      sourceRevision: mirror.body.sourceRevision,
      targetRevisionAtFetch: mirror.body.targetRevisionAtFetch,
      appliedSourceRevision: mirror.body.sourceRevision,
      // 바뀐 것 없음 = 이 시점의 시트와 결산이 같다. target 을 같이 기록해야 다음 결산 뒤 불러오기가
      // 영원한 리비전 불일치(편차·수정 스냅샷 UNAVAILABLE, 정책 화면 확인 필요)로 남지 않는다.
      appliedTargetRevision: mirror.body.targetRevisionAtFetch,
    });
    expect(db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${stage.body.runId}`)).toMatchObject({
      status: 'APPLIED',
      response: stage.body,
    });
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_weeks/')).toEqual(canonicalBefore);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_change_candidates/')).toHaveLength(0);
  });

  it('does not let an expired no-change reservation overwrite the newer acknowledgement', async () => {
    const amounts = Object.fromEntries(CASHFLOW_LINE_IDS.map((lineId) => [lineId, 999]));
    let stageRunGetCount = 0;
    let blockStageCompletion = false;
    let releaseStaleCompletion;
    let staleCompletionReached;
    const staleCompletionBlocked = new Promise((resolve) => { releaseStaleCompletion = resolve; });
    const staleCompletionReady = new Promise((resolve) => { staleCompletionReached = resolve; });
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
      weeks: Array.from({ length: 5 }, (_unused, index) => ({
        id: `project-a-2026-01-w${index + 1}`,
        projectId: 'project-a',
        yearMonth: '2026-01',
        weekNo: index + 1,
        projection: { ...amounts },
        actual: { ...amounts },
      })),
      onGet: async (path) => {
        if (!blockStageCompletion || !path.includes('/cashflow_sheet_stage_runs/')) return;
        stageRunGetCount += 1;
        if (stageRunGetCount === 3) {
          staleCompletionReached();
          await staleCompletionBlocked;
        }
      },
    });
    const googleSheetsService = {
      previewSpreadsheet: vi.fn(async () => ({
        spreadsheetId: 'spreadsheet-a',
        selectedSheetName: 'cashflow(사용내역 연동)',
        availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
        matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
      })),
    };
    const staleApp = createApp({ context: { actorId: 'stale-worker' }, db, googleSheetsService });
    const currentApp = createApp({ context: { actorId: 'current-worker' }, db, googleSheetsService });
    const mirror = await request(currentApp)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-expired-no-changes' })
      .expect(200);
    const payload = {
      expectedMirrorRevision: mirror.body.sourceRevision,
      yearMonth: '2026-01',
      idempotencyKey: 'stage-expired-no-changes',
    };
    let now = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
    blockStageCompletion = true;

    try {
      const staleStage = request(staleApp)
        .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
        .send(payload)
        .then((response) => response);
      await staleCompletionReady;
      now += 60_001;
      const currentStage = await request(currentApp)
        .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
        .send(payload)
        .expect(200);
      releaseStaleCompletion();
      expect((await staleStage).status).toBe(409);

      expect(currentStage.body.status).toBe('NO_CHANGES');
      expect(db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${currentStage.body.runId}`)).toMatchObject({
        status: 'APPLIED',
        response: currentStage.body,
      });
      expect(db.__getDocument('orgs/tenant-a/cashflow_sheet_mirrors/project-a')).toMatchObject({
        appliedSourceRevision: mirror.body.sourceRevision,
        // 바뀐 것 없음도 반영이다. target 이 안 올라가면 다음 결산 뒤 영원히 리비전 불일치.
        appliedTargetRevision: mirror.body.targetRevisionAtFetch,
        lastAppliedBy: { uid: 'current-worker' },
      });
    } finally {
      releaseStaleCompletion();
      dateNow.mockRestore();
    }
  });

  it('rejects stage when canonical cashflow changed after the explicit refresh', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: { value: 'saved-spreadsheet-a', sheetName: 'cashflow(사용내역 연동)' },
      },
    });
    const previewSpreadsheet = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      matrix: buildMatrix(),
    }));
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet } });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-target-drift' })
      .expect(200);
    await db.doc('orgs/tenant-a/cashflow_weeks/project-a-2026-01-w1').set({
      id: 'project-a-2026-01-w1',
      projectId: 'project-a',
      yearMonth: '2026-01',
      weekNo: 1,
      projection: { SALES_IN: 1 },
    });

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'stage-target-drift' })
      .expect(409)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_sheet_target_revision_conflict');
      });

    // 쓰기 모드는 이 검사를 우회하지 못한다. 팝업의 diff 는 불러온 시점의 결산 기준이라,
    // 결산이 움직였으면 다시 불러와야 한다.
    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({
        expectedMirrorRevision: mirror.body.sourceRevision,
        replaceAllActualSources: true,
        idempotencyKey: 'stage-target-drift-overwrite',
      })
      .expect(409)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_sheet_target_revision_conflict');
      });
    const refreshed = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-target-drift-again' })
      .expect(200);
    const overwriteStage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({
        expectedMirrorRevision: refreshed.body.sourceRevision,
        replaceAllActualSources: true,
        idempotencyKey: 'stage-target-drift-overwrite-refreshed',
      })
      .expect(200);
    expect(overwriteStage.body.replaceAllActualSources).toBe(true);
  });

  it('applies a staged pinned month through JVM without rereading the Google Sheet', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
      weeks: [{
        id: 'project-a-2026-01-w1',
        projectId: 'project-a',
        yearMonth: '2026-01',
        weekNo: 1,
        projection: { MYSC_PREPAY_IN: 100 },
        actual: { MYSC_PREPAY_IN: 200 },
      }],
    });
    let previewCalls = 0;
    const googleSheetsService = {
      previewSpreadsheet: vi.fn(async () => {
        previewCalls += 1;
        if (previewCalls > 1) throw new Error('apply must use staged candidates');
        const matrix = buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS);
        matrix[15][4] = '';
        return {
          spreadsheetId: 'spreadsheet-a',
          spreadsheetTitle: 'Cashflow workbook',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix,
        };
      }),
    };
    const resultingTargetRevision = `sha256:${'1'.repeat(64)}`;
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => javaApplyResponse(input, resultingTargetRevision)),
    };
    const editLeaseService = {
      acquire: vi.fn(async () => ({ body: { leaseId: 'sheet-lab-lease', fence: 8 } })),
      release: vi.fn(),
    };
    const app = createApp({
      db,
      googleSheetsService,
      routeOptions: { editLeasesEnabled: true, editLeaseService, javaWeeklyClient },
    });

    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-stage-apply-001' })
      .expect(200);

    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({
        expectedMirrorRevision: mirror.body.sourceRevision,
        yearMonth: '2026-01',
        replaceAllActualSources: true,
        idempotencyKey: 'stage-apply-001',
      })
      .expect(200);

    expect(stage.body.replaceAllActualSources).toBe(true);

    // BFF는 apply 직전에 canonical weeks를 다시 읽지 않는다.
    // 최종 target-revision 판정은 JVM transaction이 담당한다.
    await db.doc('orgs/tenant-a/cashflow_weeks/project-a-2026-02-w1').set({
      id: 'project-a-2026-02-w1',
      projectId: 'project-a',
      yearMonth: '2026-02',
      weekNo: 1,
      projection: { SALES_IN: 123 },
    });

    const apply = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'apply-stage-001' })
      .expect(200);
    const replay = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'apply-stage-001' })
      .expect(200);

    expect(googleSheetsService.previewSpreadsheet).toHaveBeenCalledTimes(1);
    expect(apply.body).toMatchObject({
      appliedLineCount: 160,
      projectionLineCount: 80,
      actualLineCount: 80,
      skippedRiskLineCount: 0,
      stagedRunId: stage.body.runId,
    });
    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledTimes(1);
    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a',
      sourceRevision: mirror.body.sourceRevision,
      targetRevision: mirror.body.targetRevisionAtFetch,
      yearMonth: '2026-01',
      replaceAllActualSources: true,
      cells: expect.arrayContaining([
        expect.objectContaining({
          mode: 'projection',
          weekNo: 1,
          cashflowLine: 'MYSC_PREPAY_IN',
          cellState: 'VALUE',
          amount: 999,
        }),
        expect.objectContaining({
          mode: 'actual',
          weekNo: 1,
          cashflowLine: 'BANK_INTEREST_OUT',
          cellState: 'VALUE',
          amount: 999,
        }),
      ]),
      editSession: null,
    }));
    expect(editLeaseService.acquire).not.toHaveBeenCalled();
    expect(editLeaseService.release).not.toHaveBeenCalled();
    expect(javaWeeklyClient.applyCashflowSheetLab.mock.calls[0][0].cells).toHaveLength(160);
    expect(javaWeeklyClient.applyCashflowSheetLab.mock.calls[0][0].calculationChecks).toHaveLength(10);
    expect(db.__getQueries()).toContainEqual({
      path: 'orgs/tenant-a/cashflow_change_candidates',
      field: 'runId',
      op: '==',
      value: stage.body.runId,
    });
    const emptyCell = javaWeeklyClient.applyCashflowSheetLab.mock.calls[0][0].cells.find((cell) => (
      cell.mode === 'projection' && cell.cashflowLine === 'MYSC_PREPAY_LABOR_IN'
    ));
    expect(emptyCell).toMatchObject({ cellState: 'EMPTY' });
    expect(emptyCell).not.toHaveProperty('amount');
    expect(replay.body).toEqual(apply.body);
    expect(db.__getDocument('orgs/tenant-a/cashflow_weeks/project-a-2026-01-w1')).toMatchObject({
      projection: { MYSC_PREPAY_IN: 100 },
      actual: { MYSC_PREPAY_IN: 200 },
    });
  });

  it('stages every complete month from the selected tab for one explicit apply', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-2-5',
        },
      },
    });
    const twoFullMonths = [
      ...JANUARY_FINANCE_WEEKS,
      '26-2-1', '26-2-2', '26-2-3', '26-2-4', '26-2-5',
    ];
    const googleSheetsService = {
      previewSpreadsheet: vi.fn(async () => ({
        spreadsheetId: 'spreadsheet-a',
        spreadsheetTitle: 'Cashflow workbook',
        selectedSheetName: 'cashflow(사용내역 연동)',
        availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
        matrix: buildMatrixWithWeekLabels(twoFullMonths),
      })),
    };
    const resultingTargetRevision = `sha256:${'2'.repeat(64)}`;
    const javaWeeklyClient = {
      applyCashflowSheetBatch: vi.fn(async (input) => javaBatchApplyResponse(input, resultingTargetRevision)),
    };
    const editLeaseService = {
      acquire: vi.fn(async () => ({ body: { leaseId: 'sheet-lab-lease', fence: 8 } })),
      release: vi.fn(),
    };
    const app = createApp({
      db,
      googleSheetsService,
      routeOptions: { editLeasesEnabled: true, editLeaseService, javaWeeklyClient },
    });

    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-two-months' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'stage-two-months' })
      .expect(200);

    const fullYearMonths = Array.from(
      { length: 12 },
      (_unused, index) => `2026-${String(index + 1).padStart(2, '0')}`,
    );
    expect(stage.body.stagedMonths).toEqual(fullYearMonths);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_change_candidates/').length).toBeGreaterThan(0);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_runs/')).toHaveLength(1);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_months/')).toHaveLength(12);
    const apply = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'apply-two-months' })
      .expect(200);

    expect(apply.body).toMatchObject({
      appliedMonths: fullYearMonths,
      appliedLineCount: 1920,
      verifiedLineCount: 1920,
    });
    expect(javaWeeklyClient.applyCashflowSheetBatch).toHaveBeenCalledTimes(1);
    expect(javaWeeklyClient.applyCashflowSheetBatch).toHaveBeenCalledWith(expect.objectContaining({
      targetRevision: mirror.body.targetRevisionAtFetch,
      months: expect.arrayContaining([
        expect.objectContaining({ yearMonth: '2026-01', cells: expect.any(Array) }),
        expect.objectContaining({ yearMonth: '2026-02', cells: expect.any(Array) }),
      ]),
    }));
    expect(javaWeeklyClient.applyCashflowSheetBatch.mock.calls[0][0].months).toHaveLength(12);
    expect(editLeaseService.release).not.toHaveBeenCalled();
  });

  it('includes unchanged bridge months for explicit month replacement without applying them', async () => {
    const lineAmounts = Object.fromEntries(CASHFLOW_LINE_IDS.map((lineId) => [lineId, 999]));
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-3-5',
        },
      },
      weeks: Array.from({ length: 5 }, (_unused, index) => ({
        id: `project-a-2026-02-w${index + 1}`,
        projectId: 'project-a',
        yearMonth: '2026-02',
        weekNo: index + 1,
        projection: { ...lineAmounts },
        actual: { ...lineAmounts },
      })),
    });
    const javaWeeklyClient = {
      applyCashflowSheetBatch: vi.fn(async (input) => javaBatchApplyResponse(input, `sha256:${'3'.repeat(64)}`)),
    };
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrixWithWeekLabels([
            ...JANUARY_FINANCE_WEEKS,
            '26-2-1', '26-2-2', '26-2-3', '26-2-4', '26-2-5',
            '26-3-1', '26-3-2', '26-3-3', '26-3-4', '26-3-5',
          ]),
        })),
      },
      routeOptions: { javaWeeklyClient },
    });

    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-bridge-month' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({
        expectedMirrorRevision: mirror.body.sourceRevision,
        yearMonth: '2026-03',
        replaceAllActualSources: true,
        idempotencyKey: 'stage-bridge-month',
      })
      .expect(200);

    expect(stage.body.stagedMonths).toEqual(['2026-03']);
    expect(stage.body.calculationMonths).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_months/')).toHaveLength(3);

    const applied = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'apply-bridge-month' })
      .expect(200);

    expect(applied.body.appliedMonths).toEqual(['2026-03']);
    expect(javaWeeklyClient.applyCashflowSheetBatch.mock.calls[0][0].months.map((month) => ({
      yearMonth: month.yearMonth,
      apply: month.apply,
    }))).toEqual([
      { yearMonth: '2026-01', apply: false },
      { yearMonth: '2026-02', apply: false },
      { yearMonth: '2026-03', apply: true },
    ]);
  });

  it('fails closed when a multi-month JVM response omits calculation evidence', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-2-5',
        },
      },
    });
    const twoFullMonths = [
      ...JANUARY_FINANCE_WEEKS,
      '26-2-1', '26-2-2', '26-2-3', '26-2-4', '26-2-5',
    ];
    const javaWeeklyClient = {
      applyCashflowSheetBatch: vi.fn(async (input) => {
        const response = javaBatchApplyResponse(input, `sha256:${'2'.repeat(64)}`);
        return {
          ...response,
          months: response.months.map(({ calculationChecks: _calculationChecks, ...month }) => month),
        };
      }),
    };
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrixWithWeekLabels(twoFullMonths),
        })),
      },
      routeOptions: { javaWeeklyClient },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'batch-contract-refresh' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'batch-contract-stage' })
      .expect(200);

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'batch-contract-apply' })
      .expect(503)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_sheet_operation_uncertain');
      });
    expect(db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${stage.body.runId}`).status)
      .toBe('APPLYING');
  });

  it('imports the sanitized 260701 XLSX across all 12 months and verifies exact ledger totals', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-12-5',
        },
      },
    });
    const googleSheetsService = {
      previewSpreadsheet: vi.fn(async () => ({
        spreadsheetId: 'spreadsheet-a',
        spreadsheetTitle: '260701 sanitized cashflow fixture',
        selectedSheetName: 'cashflow(사용내역 연동)',
        availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
        matrix: await loadSanitized260701FullYearFixture(),
      })),
    };
    const resultingTargetRevision = `sha256:${'3'.repeat(64)}`;
    const javaWeeklyClient = {
      applyCashflowSheetBatch: vi.fn(async (input) => javaBatchApplyResponse(input, resultingTargetRevision)),
    };
    const editLeaseService = {
      acquire: vi.fn(async () => ({ body: { leaseId: 'sheet-lab-lease', fence: 8 } })),
      release: vi.fn(),
    };
    const app = createApp({
      db,
      googleSheetsService,
      routeOptions: { editLeasesEnabled: true, editLeaseService, javaWeeklyClient },
    });

    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-260701-mock' })
      .expect(200);

    const sum = (mode, direction) => mirror.body.cells
      .filter((cell) => cell.mode === mode && cell.direction === direction && cell.state === 'VALUE')
      .reduce((total, cell) => total + cell.amount, 0);
    expect(mirror.body.summary).toMatchObject({ cellCount: 1920, invalidCount: 0 });
    expect({
      projectionIn: sum('projection', 'IN'),
      projectionOut: sum('projection', 'OUT'),
      actualIn: sum('actual', 'IN'),
      actualOut: sum('actual', 'OUT'),
    }).toEqual({
      projectionIn: 7_800_000,
      projectionOut: 3_900_000,
      actualIn: 7_020_000,
      actualOut: 3_120_000,
    });

    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'stage-260701-mock' })
      .expect(200);
    expect(stage.body.stagedMonths).toEqual(Array.from(
      { length: 12 },
      (_unused, index) => `2026-${String(index + 1).padStart(2, '0')}`,
    ));

    db.__clearBatchCommitSizes();
    const apply = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'apply-260701-mock' })
      .expect(200);

    expect(apply.body).toMatchObject({
      appliedLineCount: 1920,
      projectionLineCount: 960,
      actualLineCount: 960,
      verifiedLineCount: 49,
      resultingTargetRevision: `sha256:${'3'.repeat(64)}`,
    });
    expect(javaWeeklyClient.applyCashflowSheetBatch).toHaveBeenCalledTimes(1);
    expect(db.__getBatchCommitSizes()).toEqual([49]);
    expect(editLeaseService.release).not.toHaveBeenCalled();
    expect(db.__getDocument('orgs/tenant-a/cashflow_sheet_mirrors/project-a')).toMatchObject({
      appliedSourceRevision: mirror.body.sourceRevision,
      appliedTargetRevision: `sha256:${'3'.repeat(64)}`,
    });
  });

  it('fails closed when the JVM reports a different amount than the staged sheet value', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
    });
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => {
        const response = javaApplyResponse(input, `sha256:${'7'.repeat(64)}`);
        response.projection[0] = { ...response.projection[0], amount: response.projection[0].amount + 1 };
        return response;
      }),
    };
    const editLeaseService = {
      acquire: vi.fn(async () => ({ body: { leaseId: 'sheet-lab-lease', fence: 8 } })),
      release: vi.fn(),
    };
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
        })),
      },
      routeOptions: { editLeasesEnabled: true, editLeaseService, javaWeeklyClient },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-jvm-mismatch' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: 'stage-jvm-mismatch' })
      .expect(200);

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'apply-jvm-mismatch' })
      .expect(503)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_sheet_operation_uncertain');
      });
    expect(db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${stage.body.runId}`).status).toBe('APPLYING');
    expect(editLeaseService.release).not.toHaveBeenCalled();
  });

  it('retries a NOT_FOUND single-month operation with the server-pinned idempotency key', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
    });
    const previewSpreadsheet = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
    }));
    const resultingTargetRevision = `sha256:${'3'.repeat(64)}`;
    let attempts = 0;
    const javaWeeklyClient = {
      getCashflowSheetOperationStatus: vi.fn(async (input) => javaOperationNotFound(input)),
      applyCashflowSheetLab: vi.fn(async (input) => {
        if (attempts++ === 0) {
          throw Object.assign(new Error('temporary JVM failure'), {
            statusCode: 503,
            code: 'weekly_api_unavailable',
          });
        }
        return javaApplyResponse(input, resultingTargetRevision);
      }),
    };
    const app = createApp({
      db,
      googleSheetsService: { previewSpreadsheet },
      routeOptions: { editLeasesEnabled: true, javaWeeklyClient },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-resume-months' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: 'stage-resume-months' })
      .expect(200);
    const headers = {
      'x-edit-session-id': 'session-a',
      'x-edit-lease-id': 'lease-a',
      'x-edit-fence': '7',
      'x-edit-finalize': 'true',
    };
    const firstPayload = {
      stageRunId: stage.body.runId,
      idempotencyKey: 'apply-resume-first',
      applyRiskCandidates: true,
      closedMonthChangeReason: '최초 서버 고정 사유',
    };

    const retry = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .set(headers)
      .send(firstPayload)
      .expect(200);

    expect(retry.body.resultingTargetRevision).toBe(resultingTargetRevision);
    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledTimes(2);
    const calls = javaWeeklyClient.applyCashflowSheetLab.mock.calls.map(([call]) => call);
    expect(calls.map((call) => call.yearMonth)).toEqual(['2026-01', '2026-01']);
    expect(calls[0].idempotencyKey).toBe(calls[1].idempotencyKey);
    expect(calls[0].targetRevision).toBe(mirror.body.targetRevisionAtFetch);
    expect(calls[1].targetRevision).toBe(mirror.body.targetRevisionAtFetch);
    expect(calls[0].closedMonthChangeReason).toBe('최초 서버 고정 사유');
    expect(calls[1].closedMonthChangeReason).toBe('최초 서버 고정 사유');
    expect(previewSpreadsheet).toHaveBeenCalledTimes(1);
  });

  it('finalizes a reset-after-commit month operation only after authoritative status proves it', async () => {
    let sourceRevision;
    let expectedTargetRevision;
    const resultingTargetRevision = `sha256:${'9'.repeat(64)}`;
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async () => {
        throw Object.assign(new Error('connection reset after commit'), { statusCode: 503, code: 'jvm_weekly_api_unreachable' });
      }),
      getCashflowSheetOperationStatus: vi.fn(async (input) => javaOperationApplied(input, {
        sourceRevision,
        expectedTargetRevision,
        resultingTargetRevision,
        appliedMonths: ['2026-01'],
      })),
    };
    const staged = await stageJanuaryApply(javaWeeklyClient, 'status-proven');
    sourceRevision = staged.mirror.body.sourceRevision;
    expectedTargetRevision = staged.mirror.body.targetRevisionAtFetch;

    await request(staged.app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: staged.stage.body.runId, idempotencyKey: 'apply-status-proven' })
      .expect(200)
      .expect((response) => expect(response.body.resultingTargetRevision).toBe(resultingTargetRevision));
    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledTimes(1);
    expect(javaWeeklyClient.getCashflowSheetOperationStatus).toHaveBeenCalledTimes(1);
    expect(staged.db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${staged.stage.body.runId}`))
      .toMatchObject({ status: 'APPLIED' });
  });

  it('does not resend a mutation that may still be running when operation status is not found yet', async () => {
    let sourceRevision;
    let expectedTargetRevision;
    let statusReads = 0;
    const resultingTargetRevision = `sha256:${'2'.repeat(64)}`;
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async () => {
        throw Object.assign(new Error('JVM response deadline exceeded'), {
          statusCode: 503,
          code: 'jvm_weekly_api_unreachable',
          mutationOutcome: 'uncertain',
        });
      }),
      getCashflowSheetOperationStatus: vi.fn(async (input) => {
        if (statusReads++ === 0) return javaOperationNotFound(input);
        return javaOperationApplied(input, {
          sourceRevision,
          expectedTargetRevision,
          resultingTargetRevision,
          appliedMonths: ['2026-01'],
        });
      }),
    };
    const staged = await stageJanuaryApply(javaWeeklyClient, 'in-flight-not-found');
    sourceRevision = staged.mirror.body.sourceRevision;
    expectedTargetRevision = staged.mirror.body.targetRevisionAtFetch;
    const payload = {
      stageRunId: staged.stage.body.runId,
      idempotencyKey: 'apply-in-flight-not-found',
    };

    await request(staged.app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send(payload)
      .expect(503)
      .expect((response) => expect(response.body.code).toBe('cashflow_sheet_operation_uncertain'));

    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledTimes(1);
    expect(javaWeeklyClient.getCashflowSheetOperationStatus).toHaveBeenCalledTimes(1);
    expect(staged.db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${staged.stage.body.runId}`))
      .toMatchObject({ status: 'APPLYING' });

    await request(staged.app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send(payload)
      .expect(200)
      .expect((response) => expect(response.body.resultingTargetRevision).toBe(resultingTargetRevision));

    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledTimes(1);
    expect(javaWeeklyClient.getCashflowSheetOperationStatus).toHaveBeenCalledTimes(2);
    expect(staged.db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${staged.stage.body.runId}`))
      .toMatchObject({ status: 'APPLIED' });
  });

  it('replays the applied response when two requests finish the same staged run together', async () => {
    let releaseBoth;
    let callCount = 0;
    const returnedAuditIds = [];
    const bothStarted = new Promise((resolve) => { releaseBoth = resolve; });
    const resultingTargetRevision = `sha256:${'6'.repeat(64)}`;
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => {
        const callNumber = ++callCount;
        if (callNumber === 2) releaseBoth();
        await bothStarted;
        const auditId = `audit-${callNumber}`;
        returnedAuditIds.push(auditId);
        return { ...javaApplyResponse(input, resultingTargetRevision), auditId };
      }),
    };
    const staged = await stageJanuaryApply(javaWeeklyClient, 'concurrent-completion');
    const payload = {
      stageRunId: staged.stage.body.runId,
      idempotencyKey: 'apply-concurrent-completion',
    };

    const responses = await Promise.all([
      request(staged.app).post('/api/v1/projects/project-a/cashflow-sheet-lab/apply').send(payload),
      request(staged.app).post('/api/v1/projects/project-a/cashflow-sheet-lab/apply').send(payload),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledTimes(2);
    expect(returnedAuditIds.sort()).toEqual(['audit-1', 'audit-2']);
    expect(javaWeeklyClient.applyCashflowSheetLab.mock.calls[0][0].idempotencyKey)
      .toBe(javaWeeklyClient.applyCashflowSheetLab.mock.calls[1][0].idempotencyKey);
    const storedRun = staged.db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${staged.stage.body.runId}`);
    expect(storedRun).toMatchObject({ status: 'APPLIED', applyResponse: responses[0].body });
    expect(responses[0].body).toEqual(storedRun.applyResponse);
  });

  it('replays the applied response when a concurrent request checkpoints after completion', async () => {
    let releaseSecond;
    let secondStarted;
    let callCount = 0;
    const returnedAuditIds = [];
    const secondMayFinish = new Promise((resolve) => { releaseSecond = resolve; });
    const secondHasStarted = new Promise((resolve) => { secondStarted = resolve; });
    const resultingTargetRevision = `sha256:${'5'.repeat(64)}`;
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => {
        const callNumber = ++callCount;
        if (callNumber === 2) {
          secondStarted();
          await secondMayFinish;
        } else {
          await secondHasStarted;
        }
        const auditId = `audit-${callNumber}`;
        returnedAuditIds.push(auditId);
        return { ...javaApplyResponse(input, resultingTargetRevision), auditId };
      }),
    };
    const staged = await stageJanuaryApply(javaWeeklyClient, 'late-checkpoint');
    const payload = { stageRunId: staged.stage.body.runId, idempotencyKey: 'apply-late-checkpoint' };

    const first = request(staged.app).post('/api/v1/projects/project-a/cashflow-sheet-lab/apply').send(payload)
      .then((response) => response);
    const second = request(staged.app).post('/api/v1/projects/project-a/cashflow-sheet-lab/apply').send(payload)
      .then((response) => response);
    const firstResponse = await first;
    releaseSecond();
    const secondResponse = await second;

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(returnedAuditIds.sort()).toEqual(['audit-1', 'audit-2']);
    expect(secondResponse.body).toEqual(firstResponse.body);
    expect(secondResponse.body).toEqual(staged.db
      .__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${staged.stage.body.runId}`).applyResponse);
  });

  it('does not replay an applied response when publication completion evidence differs', async () => {
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => javaApplyResponse(input, `sha256:${'4'.repeat(64)}`)),
    };
    const staged = await stageJanuaryApply(javaWeeklyClient, 'invalid-applied-evidence');
    const payload = { stageRunId: staged.stage.body.runId, idempotencyKey: 'apply-invalid-evidence' };
    await request(staged.app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send(payload)
      .expect(200);
    staged.db.__getDocument('orgs/tenant-a/cashflow_sheet_publications/project-a').appliedTargetRevision = `sha256:${'3'.repeat(64)}`;

    await request(staged.app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send(payload)
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_sheet_stage_run_applied'));
  });

  it.each([
    ['malformed status', () => ({ status: 'APPLIED' }), 'MISMATCH'],
    ['wrong project', (input, sourceRevision, targetRevision) => javaOperationApplied(input, {
      sourceRevision, expectedTargetRevision: targetRevision, resultingTargetRevision: `sha256:${'8'.repeat(64)}`,
      appliedMonths: ['2026-01'], overrides: { projectId: 'project-b' },
    }), 'MISMATCH'],
    ['wrong revision', (input, sourceRevision) => javaOperationApplied(input, {
      sourceRevision, expectedTargetRevision: `sha256:${'7'.repeat(64)}`, resultingTargetRevision: `sha256:${'8'.repeat(64)}`,
      appliedMonths: ['2026-01'],
    }), 'MISMATCH'],
    ['wrong scope', (input, sourceRevision, targetRevision) => javaOperationApplied(input, {
      sourceRevision, expectedTargetRevision: targetRevision, resultingTargetRevision: `sha256:${'8'.repeat(64)}`,
      appliedMonths: ['2026-02'],
    }), 'MISMATCH'],
    ['status read failure', () => { throw Object.assign(new Error('status unavailable'), { statusCode: 503 }); }, 'READ_FAILED'],
  ])('keeps %s explicitly uncertain and does not replay it on repeated resume', async (_label, statusResult, outcome) => {
    let sourceRevision;
    let expectedTargetRevision;
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async () => {
        throw Object.assign(new Error('response lost'), { statusCode: 503, code: 'jvm_weekly_api_unreachable' });
      }),
      getCashflowSheetOperationStatus: vi.fn(async (input) => statusResult(input, sourceRevision, expectedTargetRevision)),
    };
    const staged = await stageJanuaryApply(javaWeeklyClient, `status-${outcome.toLowerCase()}-${_label.replaceAll(' ', '-')}`);
    sourceRevision = staged.mirror.body.sourceRevision;
    expectedTargetRevision = staged.mirror.body.targetRevisionAtFetch;
    const payload = { stageRunId: staged.stage.body.runId, idempotencyKey: `apply-${outcome.toLowerCase()}` };

    await request(staged.app).post('/api/v1/projects/project-a/cashflow-sheet-lab/apply').send(payload)
      .expect(503)
      .expect((response) => expect(response.body.code).toBe('cashflow_sheet_operation_uncertain'));
    await request(staged.app).post('/api/v1/projects/project-a/cashflow-sheet-lab/apply').send(payload)
      .expect(503);
    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledTimes(1);
    const run = staged.db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${staged.stage.body.runId}`);
    expect(Object.values(run.applyOperations)).toContainEqual(expect.objectContaining({
      status: 'UNCERTAIN', evidence: expect.objectContaining({ outcome }),
    }));
  });

  it('stages no candidates when closed-month cells already equal the sheet, even in full-replacement mode', async () => {
    // 라이브 AXR 재현. 1~7월이 결산돼 있고 시트 값이 DB 와 같을 때 "전체 교체" 로 반영하면
    // 값이 같은 잠긴 셀 1,120개가 후보로 들어가 JVM 이 사유를 요구했고, 에러 표는 0원→0원 으로
    // 채워졌으며, 화면 manifest 와 서버 manifest 가 어긋나 반영이 막혔다.
    // 바뀐 것이 없으면 후보가 아니어야 한다. 그 사유는 조직에 경고로 남기 때문이다.
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
      initialDocuments: {
        'orgs/tenant-a/monthly_closes/project-a-2026-01': {
          contractVersion: 'cashflow-month-close-v1',
          tenantId: 'tenant-a',
          projectId: 'project-a',
          yearMonth: '2026-01',
          status: 'CLOSED',
        },
      },
    });
    const previewSpreadsheet = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
    }));
    const applyCashflowSheetBatch = vi.fn(async (input) => javaBatchApplyResponse(input, `sha256:${'5'.repeat(64)}`));
    const app = createApp({
      db,
      googleSheetsService: { previewSpreadsheet },
      routeOptions: { editLeasesEnabled: true, javaWeeklyClient: { applyCashflowSheetBatch } },
    });

    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-same-values' })
      .expect(200);

    // DB 를 시트와 완전히 같게 만든다 - 첫 미러의 셀을 그대로 cashflow_weeks 로 옮겨
    // 같은 결산 상태의 두 번째 앱을 세운다.
    const weeksByKey = new Map();
    for (const cell of mirror.body.cells) {
      if (!['VALUE', 'ZERO'].includes(cell.state)) continue;
      const key = `${cell.yearMonth}-w${cell.weekNo}`;
      const week = weeksByKey.get(key) || {
        id: `project-a-${key}`, projectId: 'project-a', tenantId: 'tenant-a',
        yearMonth: cell.yearMonth, weekNo: cell.weekNo,
        projection: {}, weeklyExpenseActualBySheet: { 'cashflow-sheet-lab': {} },
      };
      if (cell.mode === 'projection') week.projection[cell.lineId] = Number(cell.amount);
      else week.weeklyExpenseActualBySheet['cashflow-sheet-lab'][cell.lineId] = Number(cell.amount);
      weeksByKey.set(key, week);
    }
    const sameDb = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
      weeks: [...weeksByKey.values()],
      initialDocuments: {
        'orgs/tenant-a/monthly_closes/project-a-2026-01': {
          contractVersion: 'cashflow-month-close-v1',
          tenantId: 'tenant-a',
          projectId: 'project-a',
          yearMonth: '2026-01',
          status: 'CLOSED',
        },
      },
    });
    const sameApp = createApp({
      db: sameDb,
      googleSheetsService: { previewSpreadsheet },
      routeOptions: { editLeasesEnabled: true, javaWeeklyClient: { applyCashflowSheetBatch } },
    });
    const refreshed = await request(sameApp)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-same-values-2' })
      .expect(200);

    const stage = await request(sameApp)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({
        expectedMirrorRevision: refreshed.body.sourceRevision,
        replaceAllActualSources: true,
        idempotencyKey: 'stage-same-values',
      })
      .expect(200);

    // 전체 교체 모드여도 값이 같으면 후보가 아니다.
    expect(stage.body.status).toBe('NO_CHANGES');
    expect(stage.body.stagedLineCount).toBe(0);
    expect(stage.body.closedMonthDifferenceCount).toBe(0);
    expect(stage.body.closedMonthDifferences).toEqual([]);
    // JVM 은 호출조차 되지 않는다 - 사유를 요구할 기회가 없다.
    expect(applyCashflowSheetBatch).not.toHaveBeenCalled();
  });

  it('retries the same staged run with a reason after the JVM rejects a late closed-month change', async () => {
    const twoFullMonths = [
      ...JANUARY_FINANCE_WEEKS,
      '26-2-1', '26-2-2', '26-2-3', '26-2-4', '26-2-5',
    ];
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-2-5',
        },
      },
      initialDocuments: {
        'orgs/tenant-a/monthly_closes/project-a-2026-01': {
          contractVersion: 'cashflow-month-close-v1',
          tenantId: 'tenant-a',
          projectId: 'project-a',
          yearMonth: '2026-01',
          status: 'OPEN',
        },
        'orgs/tenant-a/monthly_closes/project-a-2026-02': {
          contractVersion: 'cashflow-month-close-v1',
          tenantId: 'tenant-a',
          projectId: 'project-a',
          yearMonth: '2026-02',
          status: 'OPEN',
        },
      },
    });
    const previewSpreadsheet = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      matrix: buildMatrixWithWeekLabels(twoFullMonths),
    }));
    const resultingTargetRevision = `sha256:${'4'.repeat(64)}`;
    let attempts = 0;
    const javaWeeklyClient = {
      applyCashflowSheetBatch: vi.fn(async (input) => {
        if (attempts++ === 0 && !input.closedMonthChangeReason) {
          throw Object.assign(new Error('reason required'), {
            statusCode: 409,
            code: 'cashflow_closed_month_reason_required',
            details: { closedMonths: ['2026-01', '2026-02'] },
          });
        }
        return javaBatchApplyResponse(input, resultingTargetRevision);
      }),
    };
    const app = createApp({
      db,
      googleSheetsService: { previewSpreadsheet },
      routeOptions: { editLeasesEnabled: true, javaWeeklyClient },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-rejected-retry' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'stage-rejected-retry' })
      .expect(200);
    expect(stage.body.closedMonthDifferences).toEqual([]);
    const headers = {
      'x-edit-session-id': 'session-a',
      'x-edit-lease-id': 'lease-a',
      'x-edit-fence': '7',
    };

    const rejected = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .set(headers)
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'apply-rejected-first' })
      .expect(409);
    const expectedDifferences = expectedClosedMonthDifferences(db, ['2026-01', '2026-02'], false);
    expect(expectedDifferences.flatMap((difference) => difference.changes)).toHaveLength(320);
    expect(rejected.body.details.closedMonthDifferences).toEqual(expectedDifferences);
    // 마감된 달을 바꾸는 사람은 건수가 아니라 어떤 값이 얼마로 바뀌는지를 보고 판단해야 한다.
    for (const difference of rejected.body.details.closedMonthDifferences) {
      expect(difference.changes.length).toBeGreaterThan(0);
      expect(difference.changes.length + difference.truncatedChangeCount).toBe(difference.differenceCount);
      for (const change of difference.changes) {
        expect(difference.weeks).toContain(change.weekNo);
        expect(['projection', 'actual']).toContain(change.mode);
        expect(typeof change.lineId).toBe('string');
        // before와 after가 실제로 다른 항목만 실려야 한다.
        expect([change.beforeHadValue, change.beforeAmount])
          .not.toEqual([change.afterHadValue, change.afterAmount]);
        if (!change.beforeHadValue) expect(change.beforeAmount).toBeNull();
        if (!change.afterHadValue) expect(change.afterAmount).toBeNull();
      }
    }
    expect(db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${stage.body.runId}`).status).toBe('READY');
    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .set(headers)
      .send({
        stageRunId: stage.body.runId,
        idempotencyKey: 'apply-rejected-second',
        closedMonthChangeReason: '결산 후 실제 입금액 정정',
      })
      .expect(200);

    expect(javaWeeklyClient.applyCashflowSheetBatch).toHaveBeenCalledTimes(2);
    const calls = javaWeeklyClient.applyCashflowSheetBatch.mock.calls.map(([call]) => call);
    expect(calls[0].idempotencyKey).not.toBe(calls[1].idempotencyKey);
    expect(calls[1].closedMonthChangeReason).toBe('결산 후 실제 입금액 정정');
  });

  it('keeps the staged run atomic until formula mismatches are explicitly accepted', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
    });
    const previewSpreadsheet = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
    }));
    const resultingTargetRevision = `sha256:${'6'.repeat(64)}`;
    const mismatch = {
      yearMonth: '2026-01',
      mode: 'projection',
      weekNo: 1,
      field: 'depositTotal',
      reported: 6_800_000,
      calculated: 6_700_000,
      sourceCell: 'BO12',
    };
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => {
        if (!input.acceptFormulaMismatches) {
          throw Object.assign(new Error('formula confirmation required'), {
            statusCode: 409,
            code: 'cashflow_formula_mismatch_confirmation_required',
            details: { mismatchCount: 1, mismatches: [mismatch] },
          });
        }
        return javaApplyResponse(input, resultingTargetRevision);
      }),
    };
    const app = createApp({
      db,
      googleSheetsService: { previewSpreadsheet },
      routeOptions: { editLeasesEnabled: true, javaWeeklyClient },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-formula-mismatch' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: 'stage-formula-mismatch' })
      .expect(200);

    const rejected = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'apply-formula-mismatch-first' })
      .expect(409);
    expect(rejected.body).toMatchObject({
      code: 'cashflow_formula_mismatch_confirmation_required',
      details: { mismatchCount: 1, mismatches: [mismatch] },
    });
    expect(db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${stage.body.runId}`).status).toBe('READY');

    const currentMirror = db.__getDocument('orgs/tenant-a/cashflow_sheet_mirrors/project-a');
    const originalSourceRevision = currentMirror.sourceRevision;
    currentMirror.sourceRevision = `sha256:${'9'.repeat(64)}`;
    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({
        stageRunId: stage.body.runId,
        idempotencyKey: 'apply-formula-mismatch-stale-confirmation',
        acceptFormulaMismatches: true,
      })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_sheet_mirror_revision_conflict'));
    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledTimes(1);
    currentMirror.sourceRevision = originalSourceRevision;

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({
        stageRunId: stage.body.runId,
        idempotencyKey: 'apply-formula-mismatch-confirmed',
        acceptFormulaMismatches: true,
      })
      .expect(200);

    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledTimes(2);
    expect(javaWeeklyClient.applyCashflowSheetLab.mock.calls[0][0].acceptFormulaMismatches).toBe(false);
    expect(javaWeeklyClient.applyCashflowSheetLab.mock.calls[1][0].acceptFormulaMismatches).toBe(true);
  });

  it('treats a monthly close missing only contractVersion as legacy v1 and reaches formula validation', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
      initialDocuments: {
        'orgs/tenant-a/monthly_closes/project-a-2026-01': {
          tenantId: 'tenant-a',
          projectId: 'project-a',
          yearMonth: '2026-01',
          status: 'OPEN',
        },
      },
    });
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => {
        throw Object.assign(new Error('formula confirmation required'), {
          statusCode: 409,
          code: 'cashflow_formula_mismatch_confirmation_required',
          details: { mismatchCount: 1, mismatches: [] },
        });
      }),
    };
    const app = createApp({ db, routeOptions: { javaWeeklyClient } });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-legacy-month-close' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: 'stage-legacy-month-close' })
      .expect(200);

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'apply-legacy-month-close' })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_formula_mismatch_confirmation_required'));
    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['contract version', { contractVersion: 'cashflow-month-close-v0' }],
    ['blank contract version', { contractVersion: ' ' }],
    ['legacy closed status', { status: 'CLOSED' }],
    ['tenant', { tenantId: 'tenant-b' }],
    ['project', { projectId: 'project-b' }],
    ['month', { yearMonth: '2026-02' }],
    ['status', { status: 'INVALID' }],
  ])('still rejects a monthly close with an invalid %s', async (_field, override) => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
      initialDocuments: {
        'orgs/tenant-a/monthly_closes/project-a-2026-01': {
          tenantId: 'tenant-a',
          projectId: 'project-a',
          yearMonth: '2026-01',
          status: 'OPEN',
          ...override,
        },
      },
    });
    const app = createApp({ db });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: `refresh-invalid-month-close-${_field}` })
      .expect(200);

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: `stage-invalid-month-close-${_field}` })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_month_close_contract_invalid'));
  });

  it('applies a settled-week sheet change without a weekly confirmation', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
    });
    const previewSpreadsheet = vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
    }));
    const resultingTargetRevision = `sha256:${'5'.repeat(64)}`;
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async (input) => javaApplyResponse(input, resultingTargetRevision)),
    };
    const app = createApp({
      db,
      googleSheetsService: { previewSpreadsheet },
      routeOptions: { editLeasesEnabled: true, javaWeeklyClient },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-settled-change' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, yearMonth: '2026-01', idempotencyKey: 'stage-settled-change' })
      .expect(200);

    const applied = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'apply-settled-unconfirmed' })
      .expect(200);
    expect(applied.body.settledWeekChanges).toBeUndefined();
    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledTimes(1);
    expect(javaWeeklyClient.applyCashflowSheetLab.mock.calls[0][0].settledWeekChangeConfirmation).toBeUndefined();
  });

  it('ignores a legacy saved weeks 4 and 5 range and stages the full selected tab', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-2-4',
          endWeek: '26-2-5',
        },
      },
    });
    const googleSheetsService = {
      previewSpreadsheet: vi.fn(async () => ({
        spreadsheetId: 'spreadsheet-a',
        spreadsheetTitle: 'Cashflow workbook',
        selectedSheetName: 'cashflow(사용내역 연동)',
        availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
        matrix: buildMatrixWithWeekLabels(['26-2-4', '26-2-5']),
      })),
    };
    const app = createApp({
      db,
      googleSheetsService,
      routeOptions: { editLeasesEnabled: true },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-fixed-weeks' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'stage-fixed-weeks' })
      .expect(200);
    expect(stage.body).toMatchObject({
      status: 'READY',
      blockedMonths: [],
      stagedLineCount: 1920,
    });
    expect(mirror.body.activeWeekRange).toMatchObject({ startWeek: '', endWeek: '' });
    expect(mirror.body.cells).toHaveLength(1920);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_months/')).toHaveLength(12);
    expect(db.__getDocument('orgs/tenant-a/cashflow_weeks/project-a-2026-02-w4')).toBeUndefined();
  });

  it('ignores a legacy saved weeks 1 and 2 range and stages the full selected tab', async () => {
    const db = createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-2',
        },
      },
    });
    const app = createApp({
      db,
      googleSheetsService: {
        previewSpreadsheet: vi.fn(async () => ({
          spreadsheetId: 'spreadsheet-a',
          selectedSheetName: 'cashflow(사용내역 연동)',
          availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
          matrix: buildMatrixWithWeekLabels(['26-1-1', '26-1-2']),
        })),
      },
    });
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: 'refresh-partial-leading-weeks' })
      .expect(200);
    const stage = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({ expectedMirrorRevision: mirror.body.sourceRevision, idempotencyKey: 'stage-partial-leading-weeks' })
      .expect(200);

    expect(stage.body).toMatchObject({
      status: 'READY',
      blockedMonths: [],
      stagedLineCount: 1920,
    });
    expect(mirror.body.activeWeekRange).toMatchObject({ startWeek: '', endWeek: '' });
    expect(mirror.body.cells).toHaveLength(1920);
    expect(db.__getDocumentsByPrefix('orgs/tenant-a/cashflow_sheet_stage_months/')).toHaveLength(12);
  });

  it('retires both sheet write-back routes for inbound-only finance sync', async () => {
    const previewSpreadsheet = vi.fn();
    const batchUpdateValues = vi.fn();
    const app = createApp({ googleSheetsService: { previewSpreadsheet, batchUpdateValues } });

    for (const path of [
      '/api/v1/projects/project-a/cashflow-sheet-lab/writeback/preview',
      '/api/v1/projects/project-a/cashflow-sheet-lab/writeback/apply',
    ]) {
      await request(app)
        .post(path)
        .send({})
        .expect(410)
        .expect((response) => {
          expect(response.body.code).toBe('cashflow_sheet_writeback_retired');
        });
    }

    expect(previewSpreadsheet).not.toHaveBeenCalled();
    expect(batchUpdateValues).not.toHaveBeenCalled();
  });

  it('denies external emails', async () => {
    await request(createApp({
      context: {
        actorEmail: 'external@example.com',
      },
    }))
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/preview')
      .send({ value: 'spreadsheet-a' })
      .expect(403);
  });

  it('allows admins outside the workspace domain', async () => {
    await request(createApp({
      context: {
        actorRole: 'admin',
        actorEmail: 'admin@example.com',
      },
    }))
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/config')
      .expect(200);
  });
});

describe('cashflow sheet apply lock lease', () => {
  const PUBLICATION_PATH = 'orgs/tenant-a/cashflow_sheet_publications/project-a';
  const STAGE_RUN_PATH = 'orgs/tenant-a/cashflow_sheet_stage_runs/run-v1';

  function minutesAgo(minutes) {
    return new Date(Date.now() - minutes * 60 * 1000).toISOString();
  }

  function applyingDb(applyStartedAt) {
    return createDb({
      initialDocuments: {
        [PUBLICATION_PATH]: {
          projectId: 'project-a',
          status: 'APPLYING',
          stagedRunId: 'run-v1',
          sourceRevision: 'sha256:source',
          targetRevisionAtFetch: 'sha256:target',
          applyStartedAt,
        },
        [STAGE_RUN_PATH]: {
          runId: 'run-v1',
          projectId: 'project-a',
          status: 'APPLYING',
          applyStartedAt,
          appliedIdempotencyKey: 'idem-v1',
          applyRequestHash: 'sha256:req',
        },
      },
    });
  }

  it('keeps reporting an apply in progress while the lease is held', async () => {
    const db = applyingDb(minutesAgo(1));

    const response = await request(createApp({ db }))
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/apply-status')
      .expect(200);

    expect(response.body.status).toBe('APPLYING');
    expect(db.__getDocument(PUBLICATION_PATH).status).toBe('APPLYING');
  });

  it('releases an abandoned apply lock once the lease expires', async () => {
    const db = applyingDb(minutesAgo(11));

    const response = await request(createApp({ db }))
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/apply-status')
      .expect(200);

    expect(response.body.status).toBe('IDLE');
    const publication = db.__getDocument(PUBLICATION_PATH);
    expect(publication.status).toBe('READY');
    expect(publication.applyFailure.code).toBe('cashflow_sheet_apply_lease_expired');
    const stageRun = db.__getDocument(STAGE_RUN_PATH);
    expect(stageRun.status).toBe('READY');
    expect(stageRun.appliedIdempotencyKey).toBeNull();
  });

  // 2026-08-06 사고: 반영이 중단된 뒤 시트 값을 다시 불러오면 stagedRunId가 달라져
  // 재반영도 409로 막혔다. 임대가 만료되면 그 고착이 풀려야 한다.
  it('clears a stale lock that pins an older staged run so a new run can apply', async () => {
    const db = applyingDb(minutesAgo(11));

    await request(createApp({ db }))
      .get('/api/v1/projects/project-a/cashflow-sheet-lab/apply-status')
      .expect(200);

    const publication = db.__getDocument(PUBLICATION_PATH);
    // reserve 트랜잭션의 차단 조건(APPLYING && stagedRunId 불일치)이 더는 성립하지 않는다.
    expect(publication.status).not.toBe('APPLYING');
  });

  it('does not release a held lease for a non-admin actor', async () => {
    const db = applyingDb(minutesAgo(1));

    await request(createApp({ db }))
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply-lock/release')
      .send({ reason: '반영이 멈춰 있음' })
      .expect(403);

    expect(db.__getDocument(PUBLICATION_PATH).status).toBe('APPLYING');
  });

  it('requires a reason before an admin releases the lock', async () => {
    const db = applyingDb(minutesAgo(1));

    await request(createApp({ db, context: { actorRole: 'admin' } }))
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply-lock/release')
      .send({})
      .expect(422)
      .expect((response) => {
        expect(response.body.code).toBe('cashflow_sheet_apply_lock_release_reason_required');
      });

    expect(db.__getDocument(PUBLICATION_PATH).status).toBe('APPLYING');
  });

  it('lets an admin release a lease that has not expired yet', async () => {
    const db = applyingDb(minutesAgo(1));

    const response = await request(createApp({ db, context: { actorRole: 'admin' } }))
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply-lock/release')
      .send({ reason: '반영 프로세스가 중단됨' })
      .expect(200);

    expect(response.body).toMatchObject({ released: true, status: 'READY', stagedRunId: 'run-v1' });
    const publication = db.__getDocument(PUBLICATION_PATH);
    expect(publication.status).toBe('READY');
    expect(publication.applyFailure).toMatchObject({
      code: 'cashflow_sheet_apply_lock_force_released',
      reason: '반영 프로세스가 중단됨',
      releasedById: 'actor-a',
    });
    expect(db.__getDocument(STAGE_RUN_PATH).status).toBe('READY');
  });

  it('treats a repeated admin release as a no-op instead of failing', async () => {
    const db = createDb({
      initialDocuments: {
        [PUBLICATION_PATH]: { projectId: 'project-a', status: 'READY' },
      },
    });

    const response = await request(createApp({ db, context: { actorRole: 'admin' } }))
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply-lock/release')
      .send({ reason: '이미 해제됨' })
      .expect(200);

    expect(response.body.released).toBe(false);
    expect(db.__getDocument(PUBLICATION_PATH).status).toBe('READY');
  });
});

describe('cashflow sheet apply lock release on failure', () => {
  function labDb() {
    return createDb({
      project: {
        id: 'project-a',
        cashflowSheetLab: {
          value: 'saved-spreadsheet-a',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-1-5',
        },
      },
    });
  }

  function previewStub() {
    return vi.fn(async () => ({
      spreadsheetId: 'spreadsheet-a',
      selectedSheetName: 'cashflow(사용내역 연동)',
      availableSheets: [{ sheetId: 1, title: 'cashflow(사용내역 연동)', index: 0 }],
      matrix: buildMatrixWithWeekLabels(JANUARY_FINANCE_WEEKS),
    }));
  }

  async function stageOne(app, keySuffix) {
    const mirror = await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/mirror/refresh')
      .send({ idempotencyKey: `refresh-${keySuffix}` })
      .expect(200);
    return request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/stage')
      .send({
        expectedMirrorRevision: mirror.body.sourceRevision,
        yearMonth: '2026-01',
        idempotencyKey: `stage-${keySuffix}`,
      })
      .expect(200);
  }

  // 월 반영의 권위 있는 검증이 거부해도 예약 락은 즉시 해제된다.
  it('releases the apply lock when authoritative monthly validation rejects before write', async () => {
    const db = labDb();
    const javaWeeklyClient = {
      validateCashflowSheetFormulas: vi.fn(),
      applyCashflowSheetLab: vi.fn(async () => {
        throw Object.assign(new Error('formula confirmation required'), {
          statusCode: 409,
          code: 'cashflow_formula_mismatch_confirmation_required',
          details: { mismatchCount: 1, mismatches: [] },
        });
      }),
    };
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet: previewStub() }, routeOptions: { javaWeeklyClient } });
    const stage = await stageOne(app, 'internal-error');

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'apply-internal-error' })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('cashflow_formula_mismatch_confirmation_required'));

    expect(javaWeeklyClient.validateCashflowSheetFormulas).not.toHaveBeenCalled();
    expect(javaWeeklyClient.applyCashflowSheetLab).toHaveBeenCalledTimes(1);
    expect(db.__getDocument('orgs/tenant-a/cashflow_sheet_publications/project-a').status).toBe('READY');
    expect(db.__getDocument(`orgs/tenant-a/cashflow_sheet_stage_runs/${stage.body.runId}`).status).toBe('READY');
  });

  // 반영 여부를 모르는 상태에서 락을 놓으면 이중 반영 위험이 있다. 임대 만료에 맡긴다.
  it('keeps the apply lock when the mutation outcome is uncertain', async () => {
    const db = labDb();
    const javaWeeklyClient = {
      applyCashflowSheetLab: vi.fn(async () => {
        throw Object.assign(new Error('transport failure'), {
          statusCode: 503,
          code: 'jvm_weekly_api_unavailable',
          transportFailure: true,
          mutationOutcome: 'uncertain',
        });
      }),
    };
    const app = createApp({ db, googleSheetsService: { previewSpreadsheet: previewStub() }, routeOptions: { javaWeeklyClient } });
    const stage = await stageOne(app, 'uncertain');

    await request(app)
      .post('/api/v1/projects/project-a/cashflow-sheet-lab/apply')
      .send({ stageRunId: stage.body.runId, idempotencyKey: 'apply-uncertain' })
      .expect((response) => {
        expect(response.status).toBeGreaterThanOrEqual(400);
      });

    expect(db.__getDocument('orgs/tenant-a/cashflow_sheet_publications/project-a').status).toBe('APPLYING');
  });
});
