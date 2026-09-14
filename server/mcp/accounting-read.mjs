import * as z from 'zod/v4';
import { LINE_IDS, lineRowFor, weekColumnFor, weekOrdinal } from '../bff/cashflow-coordinates.mjs';
import { getCashflowLineLabel } from '../bff/cashflow-policy.mjs';
import { getMonthFinanceWeeks, resolveFinanceWeekForDate } from '../../src/app/platform/cashflow-week-core.mjs';

export const accountingInput = z.object({
  projectId: z.string().min(1).max(100).regex(/^[^/]+$/),
  yearMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
  weekNo: z.number().int().min(1).max(5).optional(),
  detail: z.enum(['summary', 'lines']).default('summary'),
}).strict();

function amount(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('accounting_amount_invalid');
  return value;
}

function text(value, limit = 200) {
  return typeof value === 'string' && value.length <= limit ? value : null;
}

export function accountingEvidence(snapshot, rawInput, retrievedAt = new Date().toISOString()) {
  const input = accountingInput.parse(rawInput);
  if (snapshot?.projectId !== input.projectId || typeof snapshot?.targetRevision !== 'string' || !snapshot.targetRevision || snapshot.targetRevision.length > 200) {
    throw new Error('accounting_source_mismatch');
  }
  const metadata = snapshot.accountingSource;
  if (!Number.isInteger(metadata?.weeklyYear) || weekOrdinal(metadata.weeklyYear, input.yearMonth, input.weekNo || 1) === -1) {
    throw new Error('accounting_weekly_scope_invalid');
  }
  const months = snapshot.readModel?.months;
  if (!Array.isArray(months)) throw new Error('accounting_read_model_invalid');
  const matches = months.filter((month) => month.yearMonth === input.yearMonth);
  if (matches.length > 1) throw new Error('accounting_duplicate_month');
  const month = matches[0];
  const warnings = [
    '금액은 JVM 원장 조회값입니다. 셀의 EMPTY/ZERO/VALUE 상태는 이 API에서 제공하지 않아 추정하지 않았습니다.',
    'JVM 금액 통화는 제공되지 않습니다. 프로젝트 등록 통화와 원장 금액 단위의 일치는 확인되지 않았습니다.',
    '조회 시각은 원본 시트 갱신 시각이 아닙니다. 원본 Google Sheets를 새로 불러오거나 수정하지 않았습니다.',
    'NOT_RECORDED인 주차·항목의 금액은 미확인입니다. 합계는 기록된 JVM 라인 기준이며 누락을 0으로 채우지 않았습니다.',
  ];
  if (!month) warnings.push('해당 월의 원장 데이터가 없습니다. 금액을 0으로 판단하지 않았습니다.');
  const weeks = getMonthFinanceWeeks(input.yearMonth).filter((week) => !input.weekNo || week.weekNo === input.weekNo);
  const modes = {};
  for (const mode of ['projection', 'actual']) {
    const sourceMode = month?.[mode];
    if (sourceMode && (!Array.isArray(sourceMode.weeks) || !sourceMode.rowTotals || typeof sourceMode.rowTotals !== 'object')) {
      throw new Error('accounting_mode_invalid');
    }
    const sourceWeeks = sourceMode?.weeks || [];
    if (sourceWeeks.some((week) => !Number.isInteger(week.weekNo) || weekOrdinal(metadata.weeklyYear, input.yearMonth, week.weekNo) === -1)
        || new Set(sourceWeeks.map((week) => week.weekNo)).size !== sourceWeeks.length) throw new Error('accounting_week_invalid');
    modes[mode] = weeks.map((week) => {
      const source = sourceWeeks.find((row) => row.weekNo === week.weekNo);
      const values = source?.amounts;
      if (source && (!values || typeof values !== 'object' || Array.isArray(values)
          || Object.keys(values).some((line) => !LINE_IDS.includes(line)))) throw new Error('accounting_lines_invalid');
      if (values) Object.values(values).forEach(amount);
      return {
        weekNo: week.weekNo, start: week.weekStart, end: week.weekEnd,
        availability: values && Object.keys(values).length ? 'AVAILABLE' : 'NOT_RECORDED',
        totals: {
          inflow: values && Object.keys(values).length ? amount(source?.weekIn) : null,
          outflow: values && Object.keys(values).length ? amount(source?.weekOut) : null,
          cumulativeBalance: values && Object.keys(values).length ? amount(source?.net) : null,
        },
        ...(input.detail === 'lines' ? { lines: LINE_IDS.map((lineId, index) => ({
          lineId, label: getCashflowLineLabel(lineId),
          amount: values && Object.hasOwn(values, lineId) ? amount(values[lineId]) : null,
          coordinate: { rowIndex: lineRowFor(mode, index), columnIndex: weekColumnFor(metadata.weeklyYear, input.yearMonth, week.weekNo), indexBase: 0 },
        })) } : {}),
      };
    });
  }
  const mirror = metadata.mirror || {};
  const monthlyTotals = {};
  if (!input.weekNo) for (const mode of ['projection', 'actual']) {
    const data = month?.[mode];
    const recorded = data?.weeks?.some((week) => Object.keys(week.amounts || {}).length > 0);
    monthlyTotals[mode] = {
      inflow: recorded ? amount(data.monthTotals?.totalIn) : null,
      outflow: recorded ? amount(data.monthTotals?.totalOut) : null,
      cumulativeBalance: recorded ? amount(data.monthTotals?.net) : null,
    };
  }
  const delta = (projection, actual) => Object.fromEntries(['inflow', 'outflow', 'cumulativeBalance'].map((key) => [
    key, projection?.[key] === null || actual?.[key] === null ? null : amount(actual[key] - projection[key]),
  ]));
  const difference = {
    derivedBy: 'BFF_FROM_JVM', direction: 'ACTUAL_MINUS_PROJECTION',
    weeks: modes.projection.map((week, index) => ({ weekNo: week.weekNo, ...delta(week.totals, modes.actual[index].totals) })),
    ...(!input.weekNo ? { monthlyTotals: delta(monthlyTotals.projection, monthlyTotals.actual) } : {}),
  };
  return {
    projectId: input.projectId, projectName: text(metadata.projectName), yearMonth: input.yearMonth,
    detail: input.detail,
    currentWeek: resolveFinanceWeekForDate(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date(retrievedAt))),
    ...(input.weekNo ? { weekNo: input.weekNo } : {}),
    projectCurrency: /^[A-Z]{3}$/.test(metadata.projectCurrency || '') ? metadata.projectCurrency : null, amountCurrency: null,
    fieldStateAvailability: 'NOT_EXPOSED',
    source: { authority: 'JVM', targetRevision: snapshot.targetRevision, retrievedAt,
      capturedAt: null, freshness: 'UNKNOWN',
      sheetMirror: { authority: 'BFF_PINNED_MIRROR', status: text(mirror.status, 32),
        capturedAt: text(mirror.capturedAt, 40), sourceRevision: text(mirror.sourceRevision, 128),
        appliedSourceRevision: text(mirror.appliedSourceRevision, 128), appliedTargetRevision: text(mirror.appliedTargetRevision, 128),
        matchesJvmRevision: Boolean(mirror.appliedTargetRevision && mirror.appliedTargetRevision === snapshot.targetRevision) } },
    availability: month ? 'AVAILABLE' : 'NOT_RECORDED',
    totalsScope: 'RECORDED_JVM_LINES', ...(!input.weekNo ? { monthlyTotals } : {}), ...modes, difference, warnings,
  };
}

export function createAccountingTools({ readSnapshot }) {
  return [{
    name: 'accounting_read',
    description: '한 사업의 월/주차 Projection·Actual 입출금과 누적잔액을 JVM에서 조회합니다. 기본 summary는 주별 합계, 항목별 금액이 필요할 때만 detail=lines. 사업은 먼저 식별하세요. currentWeek는 한국시간 현재 재무 주차입니다. 승인 여부/원본시트 실시간 조회는 아닙니다.',
    schema: accountingInput,
    async execute(input, { signal } = {}) {
      const parsed = accountingInput.parse(input);
      signal?.throwIfAborted();
      const snapshot = await readSnapshot({ params: { projectId: parsed.projectId }, query: { yearMonth: parsed.yearMonth }, signal });
      signal?.throwIfAborted();
      return accountingEvidence(snapshot, parsed);
    },
    modelResult: (result) => result,
    render: (result) => `📊 ${result.projectName || '선택 사업'} · ${result.yearMonth}${result.weekNo ? ` ${result.weekNo}주차` : ''}\n금액 자료 ${result.availability === 'AVAILABLE' ? '조회 완료' : '확인 불가'}. 원본 시트의 실시간 갱신 여부·금액 통화·셀 입력 상태는 확인되지 않았습니다.`,
  }];
}
