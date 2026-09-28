import { FieldPath } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { isProjectInActorScope } from '../bff/cashflow-project-scope.mjs';
import { accountingInput, accountingEvidence } from './accounting-read.mjs';
import { classifyReadError } from './support-read.mjs';
import { CASHFLOW_LEDGER_CURRENCY } from '../bff/cashflow-policy.mjs';

const schema = accountingInput.omit({ projectId: true, detail: true }).extend({
  cursor: z.string().min(1).max(100).regex(/^[^/]+$/).optional(),
}).strict();

export function summarizeAccountingRows(rows) {
  return Object.fromEntries(['projection', 'actual', 'difference'].map((mode) => [mode,
    Object.fromEntries(['inflow', 'outflow', 'cumulativeBalance'].map((field) => {
      const values = rows.map((row) => row[mode]?.[field]).filter((value) => value !== null && value !== undefined);
      if (values.some((value) => !Number.isSafeInteger(value))) throw new Error('accounting_amount_invalid');
      const sum = values.reduce((total, value) => total + BigInt(value), 0n);
      if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('accounting_amount_invalid');
      return [field, { value: values.length ? Number(sum) : null, included: values.length, excluded: rows.length - values.length }];
    })),
  ]));
}

export function analyzeAccountingRows(rows) {
  const identity = (row) => ({ projectId: row.projectId, name: row.name, cic: row.cic });
  const ranking = (entries, compare) => ({ count: entries.length, items: entries.sort(compare).slice(0, 5), truncated: entries.length > 5 });
  const tie = (a, b) => a.projectId.localeCompare(b.projectId);
  return {
    scope: 'RECORDED_VALUES_ACROSS_READ_PAGES',
    direction: 'ACTUAL_MINUS_PROJECTION',
    largestDifferences: Object.fromEntries(['inflow', 'outflow', 'cumulativeBalance'].map((field) => {
      const known = rows.filter((row) => Number.isSafeInteger(row.difference?.[field]));
      return [field, { comparable: known.length, unknown: rows.length - known.length,
        ...ranking(known.filter((row) => row.difference[field] !== 0).map((row) => ({ ...identity(row), value: row.difference[field] })),
          (a, b) => Math.abs(b.value) - Math.abs(a.value) || tie(a, b)) }];
    })),
    negativeBalances: Object.fromEntries(['projection', 'actual'].map((mode) => {
      const known = rows.filter((row) => Number.isSafeInteger(row[mode]?.cumulativeBalance));
      return [mode, { known: known.length, unknown: rows.length - known.length,
        ...ranking(known.filter((row) => row[mode].cumulativeBalance < 0).map((row) => ({ ...identity(row), value: row[mode].cumulativeBalance })),
          (a, b) => a.value - b.value || tie(a, b)) }];
    })),
    warning: '순위는 조회된 기록값 안에서 최대 5개입니다. 차액의 부호나 음수 잔액만으로 성과·지급 가능 여부·원인을 판단하지 않습니다. 출금도 원장의 부호를 유지합니다.',
  };
}

export function renderAccountingReport(result) {
  const money = (value) => value === null ? '미확인' : `${value.toLocaleString('ko-KR')}원`;
  const fields = { inflow: '입금', outflow: '출금', cumulativeBalance: '누적잔액' };
  const lines = [`📊 ${result.yearMonth}${result.weekNo ? ` ${result.weekNo}주차` : ''} · 등록 사업 ${result.found}개 · 원(KRW)`,
    result.wholeCatalog ? '접근 가능한 등록 사업 목록 조회 완료' : '일부 사업 조회 결과입니다. 전체 합계·순위가 아닙니다.',
    `조회 성공 ${result.counts.READ}개 · 미기록 ${result.counts.NOT_RECORDED}개 · 기간 범위 밖 ${result.counts.OUT_OF_SCOPE}개 · 실패 ${result.counts.FAILED}개 · 미시도 ${result.counts.NOT_ATTEMPTED}개`,
    '차이 = 실적(A) − 계획(P).'];
  for (const [mode, label] of [['projection', '계획'], ['actual', '실적'], ['difference', '차이']]) {
    lines.push(`${label}: ${Object.entries(fields).map(([field, name]) => {
      const total = result.totals[mode][field];
      return `${name} ${money(total.value)} (반영 ${total.included}개·미확인 ${total.excluded}개)`;
    }).join(' / ')}`);
  }
  for (const [field, label] of Object.entries(fields)) {
    const rank = result.analysis.largestDifferences[field];
    lines.push(`${label} 차액 절댓값 상위: 비교 가능 ${rank.comparable}개 · 미확인 ${rank.unknown}개 · 차이 발생 ${rank.count}개${rank.truncated ? ' 중 5개 표시' : ''}`,
      ...rank.items.map((row) => `- ${row.name} (${row.cic}): ${money(row.value)}`));
  }
  for (const [mode, label] of [['projection', '계획'], ['actual', '실적']]) {
    const rank = result.analysis.negativeBalances[mode];
    lines.push(`${label} 음수 누적잔액 ${rank.count}개 · 미확인 ${rank.unknown}개${rank.truncated ? ' · 음수 잔액 5개 표시' : ''}`,
      ...rank.items.map((row) => `- ${row.name} (${row.cic}): ${money(row.value)}`));
  }
  return [...lines, result.analysis.warning, result.warning, '원본 시트의 실시간 갱신 여부·셀 입력 상태는 확인되지 않았습니다.', `자료 조회 시각: ${result.queriedAt}`].join('\n');
}

export function createAccountingReportTool({ db, authorize, readSnapshot, record = async () => {} }) {
  const continuations = new Map();
  return {
    name: 'accounting_report', schema,
    description: '전사 등록 사업의 P(Projection)/A(Actual)를 조회합니다. 단위는 내규상 KRW(원화)입니다. 사업별 반복 호출 대신 사용하세요. nextCursor가 있으면 동일 기간으로 이어서 호출하세요. totals와 groups는 이전 페이지까지 포함한 서버 누적 집계이므로 페이지 합계를 다시 더하지 마세요. rows는 이번 페이지입니다. wholeCatalog가 false이면 전사 전체 합계가 아닙니다. 시간 한도로 미시도한 사업도 다음 호출에서 재개합니다. 차액은 양쪽 금액이 있는 사업만 비교합니다. analysis는 현재까지 조회한 사업의 차액 절댓값 상위 5개와 음수 잔액 목록·미확인 건수를 코드로 계산합니다. 전사 순위는 wholeCatalog=true인지 확인하세요.',
    async execute(raw, { signal }) {
      const input = schema.parse(raw);
      const context = await authorize();
      signal.throwIfAborted();
      const scope = JSON.stringify([context.tenantId, context.actorId, context.actorRole, input.yearMonth, input.weekNo || null]);
      const state = input.cursor ? continuations.get(input.cursor) : { scope, rows: new Map(), after: null, scanned: 0 };
      if (!state || state.scope !== scope) throw new Error('accounting_report_cursor_invalid');
      const deadline = Date.now() + 50000;
      const member = (await db.doc(`orgs/${context.tenantId}/members/${context.actorId}`).get()).data();
      let query = db.collection(`orgs/${context.tenantId}/projects`).orderBy(FieldPath.documentId())
        .select('name', 'cic', 'status', 'trashedAt');
      if (state.after) query = query.startAfter(state.after);
      const page = await query.limit(101).get();
      const scanned = page.docs.slice(0, 100);
      const projects = scanned.filter((doc) => !doc.data().trashedAt && isProjectInActorScope({
        role: context.actorRole, members: [member], actorId: context.actorId, projectId: doc.id,
      }));
      const rows = new Array(projects.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, projects.length) }, async () => {
        while (next < projects.length) {
          signal.throwIfAborted();
          const index = next++;
          const doc = projects[index];
          const project = doc.data();
          const row = { projectId: doc.id, name: project.name || '사업명 확인 필요', cic: project.cic || 'CIC 미지정' };
          if (Date.now() >= deadline) {
            rows[index] = { ...row, status: 'NOT_ATTEMPTED', error: { category: 'TIME_BUDGET', message: '조회 시간 한도로 시도하지 않았습니다.' } };
            continue;
          }
          try {
            const current = await authorize();
            const snapshot = await readSnapshot({ context: current, params: { projectId: doc.id }, query: { yearMonth: input.yearMonth }, signal });
            const value = accountingEvidence(snapshot, { projectId: doc.id, yearMonth: input.yearMonth, weekNo: input.weekNo });
            const missingWeeks = Object.fromEntries(['projection', 'actual'].map((mode) => [mode,
              value[mode].filter((week) => week.availability !== 'AVAILABLE').map((week) => week.weekNo)]));
            const money = Object.fromEntries(['projection', 'actual'].map((mode) => [mode,
              input.weekNo ? value[mode][0].totals : value.monthlyTotals[mode]]));
            const recorded = ['projection', 'actual'].some((mode) => value[mode].some((week) => week.availability === 'AVAILABLE'));
            rows[index] = { ...row, status: recorded ? 'READ' : 'NOT_RECORDED', ...money, missingWeeks,
              difference: input.weekNo ? value.difference.weeks[0] : value.difference.monthlyTotals,
              amountCurrency: value.amountCurrency, sourceRevision: value.source.targetRevision };
          } catch (error) {
            signal.throwIfAborted();
            const failure = classifyReadError(error);
            rows[index] = { ...row, status: failure.category === 'UNSUPPORTED_PERIOD' ? 'OUT_OF_SCOPE' : 'FAILED', error: failure };
          }
        }
      }));
      signal.throwIfAborted();
      await authorize();
      for (const row of rows) state.rows.set(row.projectId, row);
      for (const id of state.rows.keys()) {
        if (!isProjectInActorScope({ role: context.actorRole, members: [member], actorId: context.actorId, projectId: id })) state.rows.delete(id);
      }
      const firstPending = rows.find((row) => row.status === 'NOT_ATTEMPTED');
      const consumed = firstPending ? scanned.findIndex((doc) => doc.id === firstPending.projectId) : scanned.length;
      state.after = scanned[consumed - 1]?.id || state.after;
      state.scanned += consumed;
      const nextCursor = firstPending || page.docs.length > 100 ? randomUUID() : null;
      const accumulated = [...state.rows.values()];
      const counts = Object.fromEntries(['READ', 'NOT_RECORDED', 'OUT_OF_SCOPE', 'FAILED', 'NOT_ATTEMPTED'].map((status) => [status, accumulated.filter((row) => row.status === status).length]));
      const groups = [...new Set(accumulated.map((row) => row.cic))].map((cic) => {
        const group = accumulated.filter((row) => row.cic === cic);
        return { cic, projects: group.length, totals: summarizeAccountingRows(group) };
      });
      const result = { yearMonth: input.yearMonth, weekNo: input.weekNo || null,
        coverage: 'accessible_registered_projects_cumulative', scanned: state.scanned, found: accumulated.length, pageFound: rows.length, counts, nextCursor,
        wholeCatalog: !nextCursor,
        allReadsSucceeded: counts.FAILED === 0 && counts.NOT_ATTEMPTED === 0,
        queriedAt: new Date().toISOString(), liveSheetVerified: false, atomicSnapshot: false,
        amountCurrency: CASHFLOW_LEDGER_CURRENCY, currencyAuthority: 'MYSC_LEDGER_POLICY',
        totals: summarizeAccountingRows(accumulated), analysis: analyzeAccountingRows(accumulated), totalsScope: 'RECORDED_VALUES_ACROSS_READ_PAGES', groups,
        rows, warning: '등록 사업 기준이며 정산 의무·종료 제외 명단이 아닙니다. 사업별 조회 시점은 다릅니다. 미기록·범위 밖·실패를 0으로 판단하지 마세요. 월 금액은 기록된 주차 기준입니다.' };
      await record({ type: 'accounting_report_page', input, result });
      if (input.cursor) continuations.delete(input.cursor);
      if (nextCursor) continuations.set(nextCursor, state);
      return result;
    },
    modelResult: (result) => ({ ...result, rows: result.rows.map(({ sourceRevision, ...row }) => row) }),
    render: renderAccountingReport,
  };
}
