import { FieldPath } from 'firebase-admin/firestore';
import { isProjectInActorScope } from './cashflow-project-scope.mjs';
import { assertOverview } from '../mcp/cashflow-status.mjs';
import { previousYearMonth } from './cashflow-close-calendar.mjs';

export function selectSettlementIssue(item, { kind, weekNo, cutoff, includeLateApproved = true }) {
  const cycle = item.settlementCycle;
  if (cycle.health !== 'OK' || cycle.businessState === 'INCONSISTENT') return { state: 'UNKNOWN' };
  if (kind === 'month_incomplete') return cycle.businessState === 'LOCKED' ? null : { state: cycle.businessState };
  const status = item.settlementStatuses.items.find((entry) => entry.period === `WEEK_${weekNo}`);
  if (!status || !Number.isFinite(Date.parse(status.approverDeadlineAt))) return { state: 'UNKNOWN' };
  if (Date.parse(status.approverDeadlineAt) > Date.parse(cutoff)) return null;
  if (status.status !== 'COMPLETED') return { state: status.status, deadline: status.approverDeadlineAt };
  if (!includeLateApproved) return null;
  if (!status.approvedAt) return { state: 'UNKNOWN' };
  return Date.parse(status.approvedAt) > Date.parse(status.approverDeadlineAt)
    ? { state: 'LATE_APPROVED', deadline: status.approverDeadlineAt } : null;
}

// Read-only composition of the existing project scope and canonical BFF/JVM query.
export async function readSettlementAgentReport({ db, context, input, readOverview, signal, record = async () => {} }) {
  const member = (await db.doc(`orgs/${context.tenantId}/members/${context.actorId}`).get()).data();
  const query = db.collection(`orgs/${context.tenantId}/projects`).orderBy(FieldPath.documentId())
    .select('name', 'cic', 'executiveApproverId', 'trashedAt', 'status');
  const rows = [];
  let cursor;
  let scanned = 0;
  let checked = 0;
  do {
    signal.throwIfAborted();
    const page = await (cursor ? query.startAfter(cursor) : query).limit(100).get();
    scanned += page.docs.length;
    const projects = page.docs.filter((doc) => !doc.data().trashedAt
      && (!input.projectIds || input.projectIds.includes(doc.id))
      && isProjectInActorScope({ role: context.actorRole, members: [member], actorId: context.actorId, projectId: doc.id }));
    if (projects.length) {
      const projectIds = projects.map((doc) => doc.id);
      const overview = assertOverview(await readOverview({ context, body: { yearMonth: input.yearMonth, projectIds } }), { yearMonth: input.yearMonth, projectIds });
      checked += projects.length;
      const decisions = [];
      for (const doc of projects) {
        const item = overview.items.find((entry) => entry.projectId === doc.id);
        const issue = selectSettlementIssue(item, input);
        decisions.push({ projectId: doc.id, workflowRevision: item.settlementCycle.workflowRevision,
          cycle: { health: item.settlementCycle.health, businessState: item.settlementCycle.businessState },
          weeks: item.settlementStatuses.items.filter((entry) => entry.period === `WEEK_${input.weekNo}`), decision: issue });
        if (issue) {
          const project = doc.data();
          const leaderId = typeof project.executiveApproverId === 'string' && !project.executiveApproverId.includes('/') ? project.executiveApproverId : '';
          const people = leaderId ? await db.collection(`orgs/${context.tenantId}/persons`).where('uid', '==', leaderId).limit(2).get() : null;
          const leader = people?.docs.length === 1 ? people.docs[0].data() : null;
          rows.push({ projectId: doc.id, name: project.name || '사업명 확인 필요', projectStatus: project.status || '',
            cic: typeof project.cic === 'string' ? project.cic.trim() : '', leaderId,
            leader: leader?.name ? `${leader.name}${leader.nickname ? `(${leader.nickname})` : ''}` : '조직장 확인 필요', ...issue });
        }
      }
      await record({ type: 'report_page', policy: 'registered-scope-v1', input, actorId: context.actorId,
        scanned: page.docs.length, checked: projects.length, decisions });
    }
    cursor = page.docs.length === 100 ? page.docs.at(-1) : null;
  } while (cursor);
  signal.throwIfAborted();
  return { yearMonth: input.yearMonth, monthCloseTargetYearMonth: previousYearMonth(input.yearMonth), kind: input.kind, weekNo: input.weekNo || null, cutoff: input.cutoff || null, includeLateApproved: input.includeLateApproved !== false,
    queriedAt: new Date().toISOString(),
    coverage: 'accessible_registered_projects', complete: !input.projectIds || checked === new Set(input.projectIds).size, scanned, checked, rows,
    warning: '권한 내 등록 사업 기준입니다. 정산 의무 대상·종료 제외 정책이 적용된 미준수 명단은 아닙니다.' };
}
