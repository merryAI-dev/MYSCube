import * as z from 'zod/v4';
import { accountingInput, accountingEvidence } from './accounting-read.mjs';
import { classifyReadError } from './support-read.mjs';

const period = accountingInput.pick({ yearMonth: true, weekNo: true });
export const comparisonInput = z.object({
  projectIds: z.array(accountingInput.shape.projectId).min(1).max(10),
  baseline: period,
  current: period,
}).strict().refine((input) => new Set(input.projectIds).size === input.projectIds.length, '사업을 중복 선택할 수 없습니다.')
  .refine((input) => Boolean(input.baseline.weekNo) === Boolean(input.current.weekNo), '월끼리 또는 주차끼리 비교해주세요.')
  .refine((input) => `${input.baseline.yearMonth}-${input.baseline.weekNo || 0}` < `${input.current.yearMonth}-${input.current.weekNo || 0}`, '비교 기간은 기준 기간보다 이후여야 합니다.');

const fields = ['inflow', 'outflow', 'cumulativeBalance'];
const fieldLabels = { inflow: '입금', outflow: '출금', cumulativeBalance: '누적잔액' };
const known = (value) => Number.isSafeInteger(value);
const safe = (value) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('accounting_amount_invalid');
  return Number(value);
};
const change = (before, after) => known(before) && known(after) ? safe(BigInt(after) - BigInt(before)) : null;
const money = (value) => value === null ? '미확인' : `${value.toLocaleString('ko-KR')}원`;
const periodLabel = (value) => `${value.yearMonth}${value.weekNo ? ` ${value.weekNo}주차` : ''}`;

function compact(evidence) {
  const values = Object.fromEntries(['projection', 'actual'].map((mode) => [mode,
    evidence.weekNo ? evidence[mode][0].totals : evidence.monthlyTotals[mode]]));
  return {
    status: evidence.availability, projectName: evidence.projectName, ...values,
    variance: evidence.weekNo ? evidence.difference.weeks[0] : evidence.difference.monthlyTotals,
    observations: evidence.observations,
    missingWeeks: Object.fromEntries(['projection', 'actual'].map((mode) => [mode,
      evidence[mode].filter((week) => week.availability === 'NOT_RECORDED').map((week) => week.weekNo)])),
    source: { authority: 'JVM', targetRevision: evidence.source.targetRevision, retrievedAt: evidence.source.retrievedAt,
      freshness: evidence.source.freshness, liveSheetVerified: false },
  };
}

export function compareAccountingPeriods(input, rows, queriedAt = new Date().toISOString()) {
  const compared = rows.map((row) => ({ ...row,
    changes: Object.fromEntries(['projection', 'actual', 'variance'].map((mode) => [mode,
      Object.fromEntries(fields.map((field) => [field, change(row.baseline[mode]?.[field], row.current[mode]?.[field])]))])),
  }));
  const totals = Object.fromEntries(['projection', 'actual', 'variance'].map((mode) => [mode,
    Object.fromEntries(fields.map((field) => {
      const paired = compared.filter((row) => known(row.changes[mode][field]));
      const before = paired.length ? safe(paired.reduce((sum, row) => sum + BigInt(row.baseline[mode][field]), 0n)) : null;
      const after = paired.length ? safe(paired.reduce((sum, row) => sum + BigInt(row.current[mode][field]), 0n)) : null;
      return [field, { baseline: before, current: after, change: change(before, after), paired: paired.length, excluded: rows.length - paired.length }];
    })),
  ]));
  const drivers = Object.fromEntries(fields.map((field) => {
    const values = compared.filter((row) => known(row.changes.actual[field]) && row.changes.actual[field] !== 0)
      .sort((a, b) => Math.abs(b.changes.actual[field]) - Math.abs(a.changes.actual[field]) || a.projectId.localeCompare(b.projectId));
    return [field, { count: values.length, truncated: values.length > 5,
      items: values.slice(0, 5).map((row) => ({ projectId: row.projectId, name: row.name, change: row.changes.actual[field] })) }];
  }));
  const actions = [];
  for (const row of compared) {
    if (['baseline', 'current'].some((side) => row[side].status === 'FAILED' || row[side].status === 'OUT_OF_SCOPE')) {
      actions.push({ projectId: row.projectId, projectName: row.name, kind: 'VERIFY_SOURCE', status: 'PROPOSED',
        proposal: '기간별 원장 조회 실패·범위 밖 사유를 확인한 뒤 비교를 다시 실행합니다.' });
    }
    if (['baseline', 'current'].some((side) => Object.values(row[side].missingWeeks || {}).some((weeks) => weeks.length))) {
      actions.push({ projectId: row.projectId, projectName: row.name, kind: 'VERIFY_MISSING', status: 'PROPOSED',
        proposal: '미기록 주차의 입력 여부와 원장 반영 여부를 확인합니다. 미기록을 금액 0으로 판단하지 않습니다.' });
    }
    if (row.current.actual?.cumulativeBalance < 0) {
      actions.push({ projectId: row.projectId, projectName: row.name, kind: 'REVIEW_BALANCE', status: 'PROPOSED',
        proposal: '음수 누적잔액의 원장 근거와 예정 입출금을 확인합니다. 지급 가능 여부는 별도로 판단해야 합니다.' });
    }
    if (fields.some((field) => known(row.changes.actual[field]) && row.changes.actual[field] !== 0)) {
      actions.push({ projectId: row.projectId, projectName: row.name, kind: 'EXPLAIN_CHANGE', status: 'PROPOSED',
        proposal: '변동이 발생한 기간의 항목별 계획·실적을 조회해 차이를 확인합니다. 원인과 담당자는 아직 확인되지 않았습니다.' });
    }
  }
  return { baseline: input.baseline, current: input.current, direction: 'CURRENT_MINUS_BASELINE',
    coverage: 'EXPLICIT_SELECTED_PROJECTS', requestedProjects: input.projectIds.length,
    allReadsSucceeded: compared.every((row) => ['baseline', 'current'].every((side) => !['FAILED', 'OUT_OF_SCOPE'].includes(row[side].status))),
    complete: compared.every((row) => ['baseline', 'current'].every((side) => row[side].status === 'AVAILABLE'
      && Object.values(row[side].missingWeeks).every((weeks) => weeks.length === 0)
      && ['projection', 'actual'].every((mode) => fields.every((field) => known(row[side][mode]?.[field]))))),
    atomicSnapshot: false, amountCurrency: 'KRW', queriedAt, totals, drivers, rows: compared, proposedActions: actions,
    warnings: ['선택한 사업만 비교한 결과이며 전사 전체 비교가 아닙니다.',
      '합계는 항목별로 두 기간 모두 금액이 있는 동일 사업만 포함합니다. 미확인 값을 0으로 채우지 않습니다.',
      '월 금액은 기록된 JVM 주차 기준입니다. 미기록 주차·진행 중인 기간은 확정 월실적과 다를 수 있습니다.',
      '누적잔액의 차이는 잔액 변화이며 해당 기간의 순현금흐름과 같다고 판단하지 않습니다.',
      '사업·기간별 조회 시점은 다릅니다. 원본 시트 최신성·셀 EMPTY/ZERO 상태는 확인되지 않았습니다.',
      '변동 순위는 수치 변화이며 원인 분석이 아닙니다. 조치안은 제안이며 업무가 배정되거나 실행된 상태가 아닙니다.'],
  };
}

export function renderAccountingComparison(result) {
  const lines = [`📊 기간 비교: ${periodLabel(result.baseline)} → ${periodLabel(result.current)} · 원(KRW)`,
    `선택 사업 ${result.requestedProjects}개 · ${result.complete ? '두 기간 자료 조회 완료' : '일부 기간 자료 미확인'}`, '변화 = 비교 기간 − 기준 기간'];
  for (const [mode, label] of [['projection', '계획'], ['actual', '실적'], ['variance', '실적−계획 차이']]) {
    for (const field of fields) {
      const total = result.totals[mode][field];
      lines.push(`${label} ${fieldLabels[field]}: ${money(total.baseline)} → ${money(total.current)} / 변화 ${money(total.change)} (비교 ${total.paired}개·미확인 ${total.excluded}개)`);
    }
  }
  for (const row of result.rows) {
    lines.push(`${row.name}: ${fields.map((field) => `${fieldLabels[field]} 실적 변화 ${money(row.changes.actual[field])}`).join(' / ')}`);
    for (const [side, label] of [['baseline', '기준'], ['current', '비교']]) {
      const value = row[side];
      lines.push(`- ${label} ${periodLabel(result[side])}: ${value.source ? `JVM 조회 ${value.source.retrievedAt}` : value.error?.message || '자료 미확인'}`);
      for (const [mode, modeLabel] of [['projection', '계획'], ['actual', '실적']]) {
        if (value.missingWeeks?.[mode]?.length) lines.push(`  ${modeLabel} 미기록 ${value.missingWeeks[mode].join('·')}주차`);
      }
    }
  }
  if (result.proposedActions.length) lines.push('후속 조치 제안 (미배정·미실행)', ...result.proposedActions.map((action) => `- ${action.projectName}: ${action.proposal}`));
  return [...lines, ...result.warnings, `자료 조회 시각: ${result.queriedAt}`].join('\n');
}

export function createAccountingComparisonTool({ readSnapshot, authorize = async () => {} }) {
  return {
    name: 'accounting_compare', schema: comparisonInput,
    description: 'CFO 기간 비교와 근거 기반 후속 조치안을 만듭니다. 명시한 사업 최대 10개를 동일 사업끼리 월간 또는 주간 비교합니다. baseline보다 current가 이후여야 합니다. 전사 전체 비교가 아닙니다. 코드 계산 totals/changes/drivers만 수치에 사용하세요. 두 기간 모두 금액이 있는 사업만 합계에 포함하며 missingWeeks와 warnings를 보존합니다. proposedActions는 제안이며 실행 완료가 아닙니다. 항목별 원인 확인이 필요하면 accounting_read(detail=lines)를 이어서 사용하세요.',
    async execute(raw, { signal } = {}) {
      const input = comparisonInput.parse(raw);
      await authorize();
      signal?.throwIfAborted();
      const rows = [];
      for (const projectId of input.projectIds) {
        const row = { projectId };
        for (const side of ['baseline', 'current']) {
          signal?.throwIfAborted();
          await authorize();
          try {
            const snapshot = await readSnapshot({ params: { projectId }, query: { yearMonth: input[side].yearMonth }, signal });
            signal?.throwIfAborted();
            row[side] = compact(accountingEvidence(snapshot, { projectId, ...input[side] }));
          } catch (error) {
            signal?.throwIfAborted();
            const failure = classifyReadError(error);
            if (failure.category === 'AUTHORIZATION' || ['member_unverified', 'member_inactive', 'workspace_not_allowed'].includes(error?.message)) throw error;
            row[side] = { status: failure.category === 'UNSUPPORTED_PERIOD' ? 'OUT_OF_SCOPE' : 'FAILED', error: failure };
          }
        }
        row.name = row.current.projectName || row.baseline.projectName || '사업명 확인 필요';
        rows.push(row);
      }
      await authorize();
      signal?.throwIfAborted();
      return compareAccountingPeriods(input, rows);
    },
    render: renderAccountingComparison,
  };
}
