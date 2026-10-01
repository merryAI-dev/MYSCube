import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, 'CashflowExportPage.tsx'), 'utf8');

describe('CashflowExportPage authoritative export surface', () => {
  it('downloads the selected range through the BFF only', () => {
    expect(source).toContain('exportCashflowWorkbookViaBff');
    expect(source).toContain('startYearMonth: yearMonths[0]');
    expect(source).toContain('endYearMonth: yearMonths[yearMonths.length - 1]');
    expect(source).not.toContain('BFF 서버의 최신 현금흐름 데이터');
    expect(source).not.toContain('생성 기준');
    expect(source).not.toContain('buildCashflowExportWorkbookSpec');
    expect(source).not.toContain('loadExcelJs');
    expect(source).toContain('projectIds: scope === \'selected\'');
  });

  it('wires organization, multi-project, multi-account-type, sorting, and continuous years to the BFF', () => {
    expect(source).toContain('소속(CIC/센터)');
    expect(source).toContain('selectedProjectIds');
    expect(source).toContain('사업 다중선택');
    expect(source).toContain('통장 유형 다중선택');
    expect(source).toContain('buildCashflowExportAvailableYears');
    expect(source).toContain("projectIds: scope === 'selected'");
    expect(source).toContain('scope,');
    expect(source).toContain("department: departmentFilter === 'ALL'");
    expect(source).toContain('accountTypes:');
    expect(source).toContain('sortBy,');
  });

  it('loads operations 10 projects at a time and marks only the failed chunk', () => {
    expect(source).toContain('loadCashflowExportChunksInSequence');
    expect(source).toContain('chunks: chunkCashflowExportProjectIds(projectIds)');
    expect(source).not.toContain('Promise.allSettled(currentRequests)');
    expect(source).toContain('loading={pending}');
    expect(source).toContain('data-testid="cashflow-export-operations-progress"');
  });

  it('shows the canonical two-week operations table without client-side financial differences', () => {
    expect(source).toContain('fetchCashflowWeeklyOverviewViaBff');
    expect(source).toContain('fetchCashflowSettlementStatusesBatchViaBff');
    expect(source).toContain('resolveCashflowExportRecentWeeks');
    expect(source).toContain('formatCashflowExecutiveApprover');
    expect(source).toContain('formatCashflowManager');
    expect(source).toContain('조직장');
    expect(source).toContain('주정산 최근 2주');
    expect(source).toContain('실무자 제출 완료');
    expect(source).toContain('조직장 승인 완료');
    expect(source).toContain('제출 전');
    expect(source).toContain('승인 전');
    expect(source).toContain('시트 불러온 시각');
    expect(source).toContain('Projection-Actual');
    expect(source).not.toContain('projectionActualInDifference');
    expect(source).not.toContain('projectionActualOutDifference');
    expect(source).toContain('사업 보기');
    expect(source).toContain('CashflowCanonicalSummary');
    expect(source).toContain('누적 Projection-Actual');
    expect(source).not.toContain('현재 주차 상세');
    expect(source).not.toContain('useCashflowProjectionActualSummaries');
    expect(source).not.toContain('buildCashflowExportProjectRows');
    expect(source).not.toContain('확인 불가');
    expect(source).not.toContain('다시 조회');
    expect(source).not.toContain('주정산 기록 없음');
  });

  it('does not infer export readiness from the legacy weekly status collection', () => {
    expect(source).not.toContain('weeklySubmissionStatus');
    expect(source).not.toContain('onSnapshot');
    expect(source).not.toContain('업데이트된 사업');
    expect(source).not.toContain('미업데이트 사업');
    expect(source).not.toContain('최근 업데이트(Projection)');
    expect(source).not.toContain('지난 목요일 자정');
    expect(source).not.toContain('useCashflowWeeks');
  });

  it('does not request operations data before export permission is established', () => {
    expect(source).toContain('!canExport || !bffEnabled');
  });

  it('keeps the export context while opening a project in a horizontal split view', () => {
    expect(source).toContain("searchParams.get('project')");
    expect(source).toContain('CashflowExportProjectPane');
    expect(source).toContain('cashflow-export-split-layout');
    expect(source).toContain('cashflow-export-primary-pane');
    expect(source).toContain('grid grid-cols-2 gap-2');
    expect(source).toContain('정산 정보에 저장된 통장 유형을 여러 개 함께 고릅니다.');
    expect(source).not.toContain('navigate(`/cashflow/projects/');
  });
});
