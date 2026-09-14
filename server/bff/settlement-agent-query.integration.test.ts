import { describe, it, expect } from 'vitest';
import { createFirestoreDb } from './firestore.mjs';
import { readSettlementAgentReport, selectSettlementIssue } from './settlement-agent-query.mjs';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('settlement report real persistence harness', () => {
  it('reads beyond one page, joins People, enforces scope and never treats a failed page as complete', async () => {
    const db = createFirestoreDb({ projectId: 'demo-agent-report', appName: 'agent-report-test' });
    const tenantId = `report-${Date.now()}`;
    const context = { tenantId, actorId: 'actor', actorRole: 'admin' };
    await db.doc(`orgs/${tenantId}/members/actor`).set({ status: 'ACTIVE', role: 'admin', projectIds: ['p001'] });
    await db.doc(`orgs/${tenantId}/persons/person`).set({ uid: 'leader', name: '홍길동', nickname: '나무' });
    const batch = db.batch();
    for (let i = 0; i < 103; i++) batch.set(db.doc(`orgs/${tenantId}/projects/p${String(i).padStart(3, '0')}`), {
      name: `사업${i}`, cic: 'CIC2', executiveApproverId: 'leader', status: 'COMPLETED', ...(i === 102 ? { trashedAt: '2026-01-01' } : {}),
    });
    await batch.commit();
    let calls = 0;
    const readOverview = async ({ body }: any) => {
      calls++;
      const status = (period: string) => ({ period, status: period === 'MONTH' ? 'SUBMITTED' : 'PENDING_APPROVAL', revision: 1,
        submittedAt: '', submittedBy: '', approvedAt: '', approvedBy: '', deadlineAt: '2026-09-10T14:59:00Z', approverDeadlineAt: '2026-09-11T04:00:00Z' });
      const commands = ['SUBMIT_MONTH_CLOSE','WITHDRAW_MONTH_CLOSE','APPROVE_MONTH_CLOSE','REJECT_MONTH_CLOSE','REQUEST_MONTH_REOPEN','APPROVE_MONTH_REOPEN','REJECT_MONTH_REOPEN','CANCEL_ACTIVE_CYCLE'];
      return { version: '5', yearMonth: body.yearMonth, monthCloseTargetYearMonth: '2026-08', monthCloseTargetLabel: '8월', errors: [],
        items: body.projectIds.map((projectId: string) => ({ projectId, projectionActualSummary: null, sheetCapturedAt: null,
          settlementStatuses: { projectId, yearMonth: body.yearMonth, items: ['MONTH','WEEK_1','WEEK_2','WEEK_3','WEEK_4','WEEK_5'].map(status) },
          settlementCycle: { cycleYearMonth: body.yearMonth, weeklyYearMonth: body.yearMonth, monthCloseTargetYearMonth: '2026-08',
            businessState: 'SUBMITTED', health: 'OK', workflowRevision: 2, monthCloseSettlement: status('MONTH'), provenance: null, supersededAttempt: null,
            commandCapabilities: Object.fromEntries(commands.map((command) => [command, { allowed: false, reasonCode: 'NOT_ALLOWED' }])) },
        })) };
    };
    const events: any[] = [];
    const args = { db, context, input: { yearMonth: '2026-09', kind: 'month_incomplete' }, readOverview,
      signal: AbortSignal.timeout(60000), record: async (event: any) => { events.push(event); } };
    const report = await readSettlementAgentReport(args);
    expect(calls).toBe(2);
    expect(report).toMatchObject({ scanned: 103, checked: 102, complete: true });
    expect(report.rows).toHaveLength(102);
    expect(report.rows.at(-1)).toMatchObject({ name: '사업101', cic: 'CIC2', leaderId: 'leader', leader: '홍길동(나무)' });
    expect(Number.isFinite(Date.parse(report.queriedAt))).toBe(true);
    expect(events.map((event) => event.checked)).toEqual([100, 2]);
    for (const event of events) for (const evidence of event.decisions) {
      expect(selectSettlementIssue({ settlementCycle: evidence.cycle, settlementStatuses: { items: evidence.weeks } }, event.input)).toEqual(evidence.decision);
    }
    const scoped = await readSettlementAgentReport({ ...args, context: { ...context, actorRole: 'pm' } });
    expect(scoped.checked).toBe(1);
    await db.doc(`orgs/${tenantId}/persons/duplicate`).set({ uid: 'leader', name: '다른 사람' });
    const ambiguous = await readSettlementAgentReport({ ...args, input: { ...args.input, projectIds: ['p001', 'missing'] } });
    expect(ambiguous.complete).toBe(false);
    expect(ambiguous.rows[0].leader).toBe('조직장 확인 필요');
    let page = 0;
    await expect(readSettlementAgentReport({ ...args, readOverview: async (req: any) => {
      if (++page === 2) throw new Error('upstream unavailable');
      return readOverview(req);
    } })).rejects.toThrow('upstream unavailable');
  });
});
