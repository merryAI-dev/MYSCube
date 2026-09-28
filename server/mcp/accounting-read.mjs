import * as z from 'zod/v4';
import { LINE_IDS, lineRowFor, weekColumnFor, weekOrdinal } from '../bff/cashflow-coordinates.mjs';
import { getCashflowLineLabel, CASHFLOW_LEDGER_CURRENCY } from '../bff/cashflow-policy.mjs';
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
    '회계 원장 금액은 MYSC 내규에 따라 KRW(원화)입니다. 프로젝트 계약 통화와 별개의 원장 단위이며 환산을 수행한 것이 아닙니다.',
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
    weeks: modes.projection.map((week, index) => ({ weekNo: week.weekNo, ...delta(week.totals, modes.actual[index].totals),
      ...(input.detail === 'lines' ? { lines: week.lines.map((line, lineIndex) => ({
        lineId: line.lineId, label: line.label,
        amount: line.amount === null || modes.actual[index].lines[lineIndex].amount === null
          ? null : amount(modes.actual[index].lines[lineIndex].amount - line.amount),
      })) } : {}),
    })),
    ...(!input.weekNo ? { monthlyTotals: delta(monthlyTotals.projection, monthlyTotals.actual) } : {}),
  };
  return {
    projectId: input.projectId, projectName: text(metadata.projectName), yearMonth: input.yearMonth,
    detail: input.detail,
    currentWeek: resolveFinanceWeekForDate(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date(retrievedAt))),
    ...(input.weekNo ? { weekNo: input.weekNo } : {}),
    projectCurrency: /^[A-Z]{3}$/.test(metadata.projectCurrency || '') ? metadata.projectCurrency : null,
    amountCurrency: CASHFLOW_LEDGER_CURRENCY, currencyAuthority: 'MYSC_LEDGER_POLICY',
    fieldStateAvailability: 'NOT_EXPOSED',
    source: { authority: 'JVM', targetRevision: snapshot.targetRevision, retrievedAt,
      capturedAt: null, freshness: 'UNKNOWN', liveSheetVerified: false,
      freshnessExplanation: '저장된 캡처와 원장 버전이 같아도 현재 Google Sheets가 최신 반영됐는지는 확인 불가입니다.',
      sheetMirror: { authority: 'BFF_PINNED_MIRROR',
        capturedAt: text(mirror.capturedAt, 40), sourceRevision: text(mirror.sourceRevision, 128),
        appliedSourceRevision: text(mirror.appliedSourceRevision, 128), appliedTargetRevision: text(mirror.appliedTargetRevision, 128),
        matchesJvmRevision: Boolean(mirror.appliedTargetRevision && mirror.appliedTargetRevision === snapshot.targetRevision) } },
    availability: month ? 'AVAILABLE' : 'NOT_RECORDED',
    totalsScope: 'RECORDED_JVM_LINES', ...(!input.weekNo ? { monthlyTotals } : {}), ...modes, difference,
    observations: Object.fromEntries(['projection', 'actual'].map((mode) => [mode, {
      negativeBalanceWeeks: modes[mode].filter((week) => week.totals.cumulativeBalance !== null && week.totals.cumulativeBalance < 0).map((week) => week.weekNo),
      unrecordedWeeks: modes[mode].filter((week) => week.availability === 'NOT_RECORDED').map((week) => week.weekNo),
    }])), warnings,
  };
}

export function renderAccountingEvidence(result) {
  const money = (value) => value === null ? '미확인' : `${value.toLocaleString('ko-KR')}원`;
  const totals = (value) => `입금 ${money(value.inflow)} · 출금 ${money(value.outflow)} · 누적잔액 ${money(value.cumulativeBalance)}`;
  const lines = [`📊 ${result.projectName || '선택 사업'} · ${result.yearMonth}${result.weekNo ? ` ${result.weekNo}주차` : ''} · 원(KRW)`, '차이 = 실적(A) − 계획(P). 기록된 원장 항목 기준입니다.'];
  if (result.monthlyTotals) lines.push(`월 계획: ${totals(result.monthlyTotals.projection)}`, `월 실적: ${totals(result.monthlyTotals.actual)}`, `월 차이: ${totals(result.difference.monthlyTotals)}`);
  for (const [index, week] of result.projection.entries()) {
    const actual = result.actual[index];
    lines.push(`${week.weekNo}주차 (${week.start} ~ ${week.end})`, `계획: ${totals(week.totals)}`, `실적: ${totals(actual.totals)}`, `차이: ${totals(result.difference.weeks[index])}`);
    if (result.detail === 'lines') for (const [lineIndex, line] of week.lines.entries()) {
      lines.push(`- ${line.label}: 계획 ${money(line.amount)} / 실적 ${money(actual.lines[lineIndex].amount)} / 차이 ${money(result.difference.weeks[index].lines[lineIndex].amount)}`);
    }
  }
  for (const [mode, label] of [['projection', '계획'], ['actual', '실적']]) {
    const observation = result.observations[mode];
    if (observation.negativeBalanceWeeks.length) lines.push(`${label} 누적잔액 음수: ${observation.negativeBalanceWeeks.join('·')}주차 (원인과 지급 가능 여부는 확인되지 않았습니다.)`);
    if (observation.unrecordedWeeks.length) lines.push(`${label} 미기록: ${observation.unrecordedWeeks.join('·')}주차`);
  }
  return [...lines, `자료 조회 시각: ${result.source.retrievedAt}`, ...result.warnings].join('\n');
}

export function createAccountingTools({ readSnapshot }) {
  return [{
    name: 'accounting_read',
    description: '한 사업의 월/주차 Projection·Actual 입출금과 누적잔액을 JVM에서 조회합니다. 전사 전체 사업은 accounting_report를 사용하세요. 기본 summary는 주별 합계, 항목별 금액과 항목별 실적−계획 차이는 detail=lines. observations는 음수 누적잔액과 미기록 주차이며 원인 진단이 아닙니다. 금액은 MYSC 내규상 KRW(원화)입니다. currentWeek는 한국시간 현재 재무 주차입니다. 캡처 버전 일치는 현재 시트의 최신 반영 증거가 아닙니다. 원장 해시는 요청하지 않으면 노출하지 마세요.',
    schema: accountingInput,
    async execute(input, { signal } = {}) {
      const parsed = accountingInput.parse(input);
      signal?.throwIfAborted();
      const snapshot = await readSnapshot({ params: { projectId: parsed.projectId }, query: { yearMonth: parsed.yearMonth }, signal });
      signal?.throwIfAborted();
      return accountingEvidence(snapshot, parsed);
    },
    modelResult: (result) => result,
    render: renderAccountingEvidence,
  }];
}
