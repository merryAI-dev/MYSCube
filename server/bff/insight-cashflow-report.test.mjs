import { it, expect, vi } from 'vitest';
import { createInsightCashflowReport } from './insight-cashflow-report.mjs';
const db = { doc: () => ({ get: async () => ({ data: () => ({ role: 'admin' }) }) }) };
const context = { tenantId: 'x', actorId: 'a' };
const row = (projectId, value) => ({ projectId, status: 'AVAILABLE', actual: { inflow: value, outflow: null, cumulativeBalance: null } });
it('follows pages and preserves zero versus missing without modifying the read port', async () => {
  const pageQuery = vi.fn().mockResolvedValueOnce({ rows: [row('a', 0)], nextAfter: 'a' }).mockResolvedValueOnce({ rows: [row('b', null)], nextAfter: null });
  const result = await createInsightCashflowReport({ db, pageQuery })(context, { yearMonth: '2026-09' });
  expect(result.catalogComplete).toBe(true); expect(result.totals.actual.inflow).toEqual({ value: 0, included: 1, excluded: 1 });
  expect(pageQuery.mock.calls[1][1].after).toBe('a');
});
it('retains successful pages on read failure but rejects changed permissions', async () => {
  const pageQuery = vi.fn().mockResolvedValueOnce({ rows: [row('a', 20)], nextAfter: 'a' }).mockRejectedValueOnce(new Error('timeout'));
  const result = await createInsightCashflowReport({ db, pageQuery })(context, { yearMonth: '2026-09' });
  expect(result.catalogComplete).toBe(false); expect(result.rows).toHaveLength(1);
  const forbidden = vi.fn().mockResolvedValueOnce({ rows: [], nextAfter: 'a' }).mockRejectedValueOnce(Object.assign(new Error('scope'), { statusCode: 409 }));
  await expect(createInsightCashflowReport({ db, pageQuery: forbidden })(context, { yearMonth: '2026-09' })).rejects.toMatchObject({ statusCode: 409 });
});
