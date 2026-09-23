import { createCashflowEvidenceQuery, readEvidenceHttpQuery } from './cashflow-evidence-query.mjs';
import { summarizeAccountingRows } from '../mcp/accounting-report.mjs';
import { createHttpError } from './bff-utils.mjs';
export function createInsightCashflowReport({ db, now = () => new Date().toISOString(), readSnapshot, release, pageQuery }) {
  const query = pageQuery || createCashflowEvidenceQuery({ db, now, readSnapshot, release });
  return async (context, input, signal = AbortSignal.timeout(25000)) => {
    if (Object.keys(input).some((key) => key !== 'yearMonth')) throw createHttpError(400, '조회 연월만 지정해 주세요.', 'insight_report_invalid');
    const identity = db.doc(`orgs/${context.tenantId}/members/${context.actorId}`);
    const before = JSON.stringify((await identity.get()).data());
    const rows = []; let after; let last; let complete = false; let stopReason = null;
    for (let page = 0; page < 5; page++) {
      try {
        last = await query(context, { yearMonth: input.yearMonth, ...(after ? { after } : {}) }, signal);
        rows.push(...last.rows); after = last.nextAfter;
        if (!after) { complete = true; break; }
      } catch (error) {
        if (error.statusCode === 403 || error.statusCode === 409 || !last) throw error;
        stopReason = '추가 사업을 조회하지 못했습니다. 이전에 확인한 자료만 표시합니다.'; break;
      }
    }
    if (before !== JSON.stringify((await identity.get()).data())) throw createHttpError(409, '조회 중 권한이 변경되어 자료를 표시하지 않습니다.', 'insight_report_scope_changed');
    return { ...last, rows, totals: summarizeAccountingRows(rows), catalogComplete: complete, nextAfter: after || null,
      accessibleInPage: rows.length, available: rows.filter((row) => row.status === 'AVAILABLE').length,
      failed: rows.filter((row) => row.status === 'FAILED').length, notRecorded: rows.filter((row) => row.status === 'NOT_RECORDED').length,
      scope: 'accessible_registered_projects', totalsScope: 'RECORDED_VALUES_ACROSS_READ_PAGES', queriedAt: now(),
      limitations: [complete ? '현재 계정에서 조회 가능한 등록 사업 목록의 끝까지 탐색했습니다.' : stopReason || '한 번에 최대 50개 등록 사업을 탐색합니다. 아직 조회하지 못한 사업이 있습니다.',
        '사업별 자료 조회 시각이 다릅니다. 같은 시점의 은행 잔고나 확정 결산 합계가 아닙니다.',
        '일부 사업·주차의 실패·미기록은 0원이 아닙니다. 합계에는 확인된 금액만 포함됩니다.',
        'JVM에 반영된 자료이며 현재 시트의 최신 값인지 확인하지 않았습니다.'] };
  };
}
export function mountInsightCashflowReport(app, { asyncHandler, ...dependencies }) {
  const query = createInsightCashflowReport(dependencies);
  app.get('/api/v1/insight-cashflow-report', asyncHandler(async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await query(req.context, readEvidenceHttpQuery(req.query))); }));
}
