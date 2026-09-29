import { previousYearMonth } from '../bff/cashflow-close-calendar.mjs';
export function memoryDb() {
  const records = new Map();
  const snap = (ref) => ({ id: ref.path.split('/').at(-1), ref, exists: records.has(ref.path), data: () => structuredClone(records.get(ref.path)) });
  const db = {
    doc: (path) => ({ path, get: async () => snap(db.doc(path)) }),
    collection: (path) => {
      const filters = [];
      let after;
      let limit = Infinity;
      const query = {
        where: (field, op, value) => { filters.push([field, op, value]); return query; },
        orderBy: () => query,
        select: () => query,
        startAfter: (doc) => { after = doc.id; return query; },
        limit: (value) => { limit = value; return query; },
        get: async () => ({ docs: [...records].filter(([key, data]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')
          && filters.every(([field, op, value]) => op === 'in' ? value.includes(data[field]) : data[field] === value))
          .filter(([key]) => !after || key.split('/').at(-1) > after).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key]) => snap(db.doc(key))) }),
      };
      return query;
    },
    runTransaction: async (fn) => {
      const pending = [];
      const value = await fn({ get: async (ref) => snap(ref),
        set: (ref, value) => pending.push(() => records.set(ref.path, structuredClone(value))),
        create: (ref, value) => { if (records.has(ref.path)) throw new Error('already_exists'); pending.push(() => records.set(ref.path, structuredClone(value))); },
        update: (ref, value) => pending.push(() => records.set(ref.path, { ...records.get(ref.path), ...structuredClone(value) })),
        delete: (ref) => pending.push(() => records.delete(ref.path)),
      });
      pending.forEach((write) => write());
      return value;
    },
  };
  return { db, records };
}

export function statusOverview({ body: { projectIds, yearMonth } }) {
  const target = previousYearMonth(yearMonth);
  const status = (period) => ({ period, status: period === 'MONTH' ? 'LOCKED' : period === 'WEEK_1' ? 'COMPLETED' : period === 'WEEK_2' ? 'PENDING_APPROVAL' : 'WAITING_FOR_UPDATE', revision: 1,
    submittedAt: '', submittedBy: '', approvedAt: '', approvedBy: '', deadlineAt: '2026-09-01T00:00:00Z', approverDeadlineAt: '2026-09-02T00:00:00Z' });
  return { version: '5', yearMonth, monthCloseTargetYearMonth: target, monthCloseTargetLabel: target, errors: [], items: projectIds.map((projectId) => ({ projectId,
    settlementStatuses: { projectId, yearMonth, items: ['MONTH', 'WEEK_1', 'WEEK_2', 'WEEK_3', 'WEEK_4', 'WEEK_5'].map(status) },
    projectionActualSummary: null, sheetCapturedAt: null,
    settlementCycle: { cycleYearMonth: yearMonth, weeklyYearMonth: yearMonth, monthCloseTargetYearMonth: target, businessState: 'LOCKED', health: 'OK', workflowRevision: 1,
      monthCloseSettlement: status('MONTH'), provenance: null, supersededAttempt: null,
      commandCapabilities: Object.fromEntries(['SUBMIT_MONTH_CLOSE', 'WITHDRAW_MONTH_CLOSE', 'APPROVE_MONTH_CLOSE', 'REJECT_MONTH_CLOSE', 'REQUEST_MONTH_REOPEN', 'APPROVE_MONTH_REOPEN', 'REJECT_MONTH_REOPEN', 'CANCEL_ACTIVE_CYCLE'].map((key) => [key, { allowed: false, reasonCode: 'NOT_ALLOWED' }])) },
  })) };
}
