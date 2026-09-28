import * as z from 'zod/v4';
import { FieldPath } from 'firebase-admin/firestore';
import { assertOverview } from './cashflow-status.mjs';
import { isProjectInActorScope } from '../bff/cashflow-project-scope.mjs';
import { previousYearMonth } from '../bff/cashflow-close-calendar.mjs';

const labels = { COMPLETED: '승인 완료', PENDING_APPROVAL: '승인 대기', WAITING_FOR_UPDATE: '업데이트 대기',
  LOCKED: '확정', NOT_REQUESTED: '요청 전', SUBMITTED: '승인 대기', REOPEN_REQUESTED: '재개 요청',
  REOPENED: '재개됨', REJECTED: '반려', WITHDRAWN: '철회', UNKNOWN: '확인 필요' };
export const settlementStatusInput = z.object({
  yearMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/).describe('week/both는 주정산 운영월, month는 월결산 대상월'),
  kind: z.enum(['week', 'month', 'both']),
  weekNo: z.number().int().min(1).max(5).optional(),
  projectIds: z.array(z.string().min(1).max(120).regex(/^[^/]+$/)).min(1).max(100).optional(),
}).strict();

export function renderSettlementStatus(result) {
  const lines = ['[정산 완료 여부]',
    ...(result.kind !== 'month' ? [`주정산: ${result.cycleMonth}${result.weekNo ? ` · ${result.weekNo}주차` : ' · 주차별'}`] : []),
    ...(result.kind !== 'week' ? [`월결산 대상: ${result.targetMonth}`] : []),
    `조회 ${result.rows.length}개 사업 · ${result.complete ? '요청 범위 조회 완료' : '일부 자료 미확인'}`];
  const periods = result.kind === 'month' ? [] : result.weekNo ? [result.weekNo] : [1, 2, 3, 4, 5];
  for (const week of periods) {
    const counts = {};
    for (const row of result.rows) { const state = row.weeks[week]; counts[state] = (counts[state] || 0) + 1; }
    lines.push(`${week}주차: ${Object.entries(counts).map(([state, count]) => `${labels[state]} ${count}개`).join(' · ') || '등록 사업 없음'}`);
  }
  lines.push('등록 사업 기준입니다. 조회 실패·상태 누락은 확인 필요이며, 업데이트 대기는 기한 위반을 뜻하지 않습니다.',
    '조회 시점의 상태이며 과거 월말 상태를 복원한 결과가 아닙니다.',
    ...(result.truncated ? ['등록 사업 조회 한도에 도달해 전체 결과가 아닙니다.'] : []),
    `자료 조회 시각: ${result.queriedAt}`);
  const details = result.rows.map((row) => {
    const groups = new Map();
    for (const week of periods) { const state = row.weeks[week]; groups.set(state, [...(groups.get(state) || []), week]); }
    return `- ${row.name}: ${[
      ...(result.kind !== 'week' ? [`월결산 ${labels[row.month]}`] : []),
      ...[...groups].map(([state, weeks]) => `${weeks.join('·')}주 ${labels[state]}`),
    ].join(' / ')}`;
  });
  let length = lines.join('\n').length;
  const visible = [];
  for (const detail of details) {
    if (length + detail.length > 30000) break;
    visible.push(detail); length += detail.length + 1;
  }
  if (visible.length < details.length) lines.push(`표시 한도: 사업별 목록 ${visible.length}/${details.length}개 표시. 나머지 ${details.length - visible.length}개는 사업 범위를 좁혀 요청해주세요. 위 집계는 조회된 전체 사업 기준입니다.`);
  lines.push(...visible);
  return lines.join('\n');
}

export function createSettlementStatusTool({ db, authorize, readOverview, record = async () => {}, onProgress = () => {} }) {
  return { name: 'settlement_status_report', schema: settlementStatusInput,
    description: '전체 등록 사업 또는 선택 사업의 주정산·월결산 완료 여부만 새로 조회합니다. 금액 분석 없이 상태만 출력합니다. projectIds 생략은 전체 등록 사업입니다. week/both의 yearMonth는 주정산 운영월이며 both의 월결산은 직전 월입니다. month의 yearMonth는 월결산 대상월입니다. 주차 생략은 1~5주차이며 승인 완료·승인 대기·업데이트 대기·확인 필요를 구분합니다.',
    render: renderSettlementStatus,
    modelResult: (result) => ({ yearMonth: result.yearMonth, kind: result.kind, checked: result.rows.length, complete: result.complete, rendered: renderSettlementStatus(result) }),
    async execute(input, { signal }) {
      input = settlementStatusInput.parse(input);
      const month = new Date(`${input.yearMonth}-01T00:00:00Z`);
      month.setUTCMonth(month.getUTCMonth() + 1);
      const cycleMonth = input.kind === 'month' ? month.toISOString().slice(0, 7) : input.yearMonth;
      const rows = [];
      let cursor;
      let scanned = 0;
      let truncated = false;
      do {
        signal.throwIfAborted();
        const context = await authorize();
        onProgress('READ_PROJECTS');
        const member = (await db.doc(`orgs/${context.tenantId}/members/${context.actorId}`).get()).data();
        let query = db.collection(`orgs/${context.tenantId}/projects`).orderBy(FieldPath.documentId()).select('name', 'trashedAt');
        if (cursor) query = query.startAfter(cursor);
        const page = await query.limit(100).get();
        scanned += page.docs.length;
        const projects = page.docs.filter((doc) => !doc.data().trashedAt && (!input.projectIds || input.projectIds.includes(doc.id))
          && isProjectInActorScope({ role: context.actorRole, members: [member], actorId: context.actorId, projectId: doc.id }));
        if (projects.length) {
          const projectIds = projects.map((doc) => doc.id);
          onProgress('READ_SETTLEMENT');
          let overview;
          try { overview = assertOverview(await readOverview({ context, body: { yearMonth: cycleMonth, projectIds } }), { yearMonth: cycleMonth, projectIds }); }
          catch (error) {
            signal.throwIfAborted();
            if ([401, 403].includes(error.status || error.statusCode)) throw error;
            await record({ type: 'status_page_unavailable', projectCount: projects.length });
          }
          await authorize();
          for (const doc of projects) {
            const item = overview?.items.find((entry) => entry.projectId === doc.id);
            const healthy = item?.settlementCycle.health === 'OK' && item.settlementCycle.businessState !== 'INCONSISTENT';
            rows.push({ projectId: doc.id, name: doc.data().name || '사업명 확인 필요',
              month: healthy && labels[item.settlementCycle.businessState] ? item.settlementCycle.businessState : 'UNKNOWN',
              weeks: Object.fromEntries([1, 2, 3, 4, 5].map((week) => [week, healthy
                ? item.settlementStatuses.items.find((status) => status.period === `WEEK_${week}`)?.status || 'UNKNOWN' : 'UNKNOWN'])) });
          }
        }
        cursor = page.docs.length === 100 ? page.docs.at(-1) : null;
        if (cursor && scanned >= 1000) { truncated = true; break; }
      } while (cursor);
      signal.throwIfAborted();
      const relevantWeeks = input.weekNo ? [input.weekNo] : [1, 2, 3, 4, 5];
      return { ...input, cycleMonth, targetMonth: previousYearMonth(cycleMonth), rows, truncated,
        complete: !truncated && (!input.projectIds || rows.length === new Set(input.projectIds).size)
          && rows.every((row) => (input.kind === 'week' || row.month !== 'UNKNOWN')
            && (input.kind === 'month' || relevantWeeks.every((week) => row.weeks[week] !== 'UNKNOWN'))),
        queriedAt: new Date().toISOString() };
    },
  };
}
