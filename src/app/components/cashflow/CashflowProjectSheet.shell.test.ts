import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 마감 후 변경 다이얼로그는 별도 파일이다. 사유·필터 입력이 부모 state 였을 때 글자 하나에 3,500줄이
// 다시 그려졌다. 셸 검사는 두 파일을 하나의 소스로 본다.
const source = readFileSync(resolve(import.meta.dirname, 'CashflowProjectSheet.tsx'), 'utf8')
  + readFileSync(resolve(import.meta.dirname, 'CashflowLateSheetChangeDialog.tsx'), 'utf8');

describe('CashflowProjectSheet schedule bar', () => {
  // 시트 검토·반영이 실패해도 아무것도 띄우지 않고 끝나는 자리가 넷 있었다. 사람 눈에는 버튼만
  // 원래대로 돌아오니 반영이 된 줄 안다. 성공은 토스트, 오류는 그 자리 인라인 배너(2026-08-19 결정).
  it('never ends a sheet stage or apply in silence', () => {
    expect(source).toContain('const [sheetOperationError, setSheetOperationError] = useState');
    expect(source).toContain('function sheetOperationErrorMessage(error: unknown, step: CashflowSheetStep): string');
    // 불러오기 실패·인증 재시도 실패, 검토 실패·인증 재시도 실패, 반영에서 어느 분기도 못 받은 오류, 다섯 다 말한다.
    expect(source.match(/setSheetOperationError\(sheetOperationErrorMessage\(/g)?.length).toBe(5);
    // 어느 단계에서 난 오류인지 붙인다.
    expect(source).toContain("sheetOperationErrorMessage(error, 'refresh')");
    expect(source).toContain("sheetOperationErrorMessage(error, 'stage')");
    expect(source).toContain("sheetOperationErrorMessage(finalError, 'apply')");
    // 반영할 수 없는 범위와 "이미 최신" 도 조용히 끝나지 않는다.
    expect(source).toContain('반영할 수 없는 시트 범위가 있습니다.');
    expect(source).toContain("toast.success('MYSCube가 이미 시트 최신값과 같습니다.');");
    // 새 시도는 지난 오류를 지우고 시작한다.
    expect(source.match(/setSheetOperationError\(''\)/g)?.length).toBe(3);
    expect(source).toContain('{sheetOperationError ? (');
  });

});

describe('CashflowProjectSheet staged loading', () => {
  // 첫 화면은 config + month-close 둘로 그린다. 나머지는 그 뒤(보조) 또는 보일 때(이력·명부)만 읽는다.
  // 12개가 동시에 나가면 Vercel 인스턴스가 늘어나는 동안 month-close 가 제일 늦게 끝났다(2026-08-19).
  it('loads the mirror only as a fallback or for the review dialog, never on mount', () => {
    expect(source).toContain('const mirrorNeeded = sheetReviewDialogOpen');
    expect(source).toContain("|| (monthCloseSettled && !(monthCloseResult?.dashboard?.source && Array.isArray(monthCloseResult?.dashboard?.cells)))");
    expect(source).toContain('if (!mirrorNeeded) return () => { cancelled = true; };');
  });
  it('loads the activity timeline only when it scrolls into view, and the roster after month-close', () => {
    expect(source).toContain('new IntersectionObserver(');
    expect(source).toContain('if (!opsTimelineVisible || !monthCloseSettled) return;');
    expect(source).toContain('cashflowActivityOneClickRef.current.pendingAggregate = true;');
    expect(source).toContain('void loadCashflowActivityAggregate();');
    expect(source).toContain('<div ref={opsTimelineRef} className="min-w-0">{renderOpsTimeline()}</div>');
    expect(source).toContain('usePersonRoster(monthCloseSettled)');
  });
});

describe('CashflowProjectSheet monthly close shell', () => {
  it('uses the server month-close guide instead of rebuilding a target-month deadline label', () => {
    // 서버 guide 는 한 줄 안내의 폴백으로 쓴다(화면이 기한 라벨을 다시 만들지 않는다).
    expect(source).toContain('requestGuide: monthCloseActions?.requestMonthClose.guide');
    expect(source).not.toContain('monthCloseResult.dashboard.summary.targetYearMonth}월 결산');
  });

  it('makes final save create an approval request after server validation', () => {
    expect(source).toContain('누적 월결산 승인 요청');
    expect(source).toMatch(/fetchCashflowMonthCloseViaBff[\s\S]*requestCashflowMonthCloseViaBff/);
    expect(source).not.toContain('!prepared.actions.cumulativeScope.ready');
    expect(source).toContain('prepared.actions.requestMonthClose.guide');
    expect(source).toContain('expectedRevision: prepared.revision');
    expect(source).toContain('expectedOpeningBalances: reviewedOpeningBalances');
    expect(source).toContain('closeInput: monthCloseInput');
    expect(source).not.toContain('savePrivateCashflowDraft');
    expect(source).not.toContain('cashflowLease');
    expect(source).not.toContain('saveCashflowProjectionBatchViaBff');
    expect(source).not.toContain('projectionDrafts: drafts');
    expect(source).not.toContain('applyCashflowMonthCloseProjectionDrafts');
  });

  it('requires an explicit human review before the compact month close is enabled', () => {
    expect(source).toContain('결산 기준과 서버가 고정한 누적 범위를 점검');
    expect(source).toContain('월 결산 승인 요청');
    expect(source).not.toContain('managementDecisions');
    expect(source).not.toContain('캐시플로 항목 사람 확인');
    expect(source).not.toContain('세금계산서·입금 일정</h3>');
    expect(source).toContain('monthCloseHumanReviewed');
    expect(source).toContain('humanReviewed: monthCloseHumanReviewed');
    expect(source).toContain('시트의 값과 일치하는지 직접 확인했습니다.');
    expect(source).toContain('위 누적 범위의 모든 주차가 수정 불가 상태로 잠깁니다.');
    expect(source).not.toContain('<span>주요 관리 항목</span>');
    expect(source).not.toMatch(/>확인<\/Button>/);
    expect(source).not.toMatch(/>해당 없음<\/Button>/);
    expect(source).not.toContain('!monthCloseProgress.complete');
    expect(source).toContain('monthCloseResult?.dashboard?.cumulativeCloseScope');
    expect(source).not.toContain('function previousYearMonth');
    expect(source).not.toContain('function isCumulativeCloseScopeReady');
    expect(source).toContain('cumulativeRequestScope.fromMonth} ~ {cumulativeRequestScope.throughMonth');
    expect(source).toContain('서버 고정 범위');
    expect(source).toContain('cumulativeRequestScope.monthCount');
    expect(source).toContain('cumulativeRequestScope.weekCount');
    expect(source).toContain('cumulativeRequestScope.cellCount');
    expect(source).not.toContain('cumulativeRequestMonthCount *');
    expect(source).toContain('cumulativeRequestScope.source.spreadsheetUrl');
    expect(source).toContain('저장 대상 시트 열기');
  });

  it('initializes the pinned source before effects read its revision', () => {
    const declaration = source.indexOf('const monthClosePinnedSource = useMemo');
    const revisionEffect = source.indexOf(
      '[monthCloseTargetYearMonth, yearMonth, monthClosePinnedSource?.sourceRevision, monthClosePinnedSource?.targetRevisionAtFetch]',
    );
    expect(declaration).toBeGreaterThan(-1);
    expect(revisionEffect).toBeGreaterThan(declaration);
  });

  it('uses only the server close decision and renders authority section guides in Korean', () => {
    expect(source).not.toContain('dashboard?.validation?.canClose');
    expect(source).not.toContain('dashboard?.validation?.blockers?.[0]?.message');
    expect(source).toContain('monthCloseSectionErrors.map((entry) => entry.cause ? `${entry.label}: ${entry.cause}` : entry.label)');
    expect(source).not.toContain("entry.section === 'monthCloseStatuses'");
  });

  it('prefills immutable sheet-authored deposit facts for the compact month close', () => {
    expect(source).toContain('dashboard?.sheetDepositScheduleRows');
    expect(source).toContain('taxInvoiceIssuedDate: row.taxInvoiceIssuedDate');
    expect(source).toContain('expectedDepositDate: row.expectedDepositDate');
    expect(source).toContain('expectedDepositAmount: row.expectedDepositAmount');
    expect(source).not.toContain('hasDepositValue');
  });

  it('keeps all cashflow labels at a readable 12px minimum', () => {
    expect(source).not.toMatch(/text-\[(?:[0-9]|1[01])px\]/);
  });

  it('consumes composed dashboard totals, comparison, summary, sheet metadata, and validation', () => {
    expect(source).toContain('sheetFormulaValues?.weekly.find');
    expect(source).toContain('const cashflowPresentation = monthCloseResult?.presentation;');
    expect(source).toContain('sheetFormulaValues?.grandTotals?.[mode]');
    expect(source).not.toContain('fetchCashflowSnapshotViaBff');
    expect(source).not.toContain('loadCashflowComparison');
    expect(source).not.toContain('cashflowSnapshot');
    expect(source).toContain('month?.comparison?.weeks');
    expect(source).toContain('dashboard?.projectionActualSummary');
    expect(source).toContain('CashflowCanonicalSummary');
    expect(source).toContain('summary={monthCloseResult?.dashboard?.projectionActualSummary}');
    expect(source).toContain('loading={monthCloseLoading}');
    expect(source).toContain('error={Boolean(monthCloseError) || cashflowSourceUnavailable}');
    expect(source).not.toContain('projectionSummary?.settlementMatches');
    expect(source).toContain("cashflowPresentation?.evidenceSource === 'DASHBOARD'");
    expect(source).toContain("['사업 타입', sheetDashboardMetadata.businessType?.value]");
    expect(source).toContain("['전용 계좌사업', sheetDashboardMetadata.accountType?.value]");
    expect(source).toContain("['정산 여부', sheetDashboardMetadata.settlementStatus?.value]");
    expect(source).toContain('세금계산서 발행일 · 입금일 · 입금액');
    expect(source).toContain('opsSummary?.status.detail');
    expect(source).not.toContain('computeCashflowDerivedTotals');
    expect(source).not.toContain('computeOpeningCashflowTotals');
    expect(source).not.toContain('monthSummaries.reduce');
  });

  it('renders the pinned Sheet formula values without recreating balance calculations', () => {
    expect(source).toContain('monthCloseRequestGenerationRef');
    expect(source).toContain('shouldApplyCashflowMonthCloseRequestResult({');
    expect(source).toContain('selectedProjectId: selectedProjectIdRef.current');
    expect(source).toContain('selectedYearMonth: selectedYearMonthRef.current');
    expect(source).toContain('const sheetFormulaValues = monthCloseResult?.dashboard?.sheetFormulaValues');
    expect(source).toContain('const sheetDerivedAmount');
    expect(source).toContain('reported?.balance ?? null');
    expect(source).not.toContain('carryForwardCashflowRunningBalances({');
    expect(source).toMatch(/\}, \[orgId, projectId, resolveBffActor, selectedYear, user\?\.uid, yearMonth\]\);/);
  });

  it('renders Sheet formula results instead of recomputing them from canonical cells', () => {
    expect(source).toContain('sheetFormulaValues?.weekly.find');
    expect(source).toContain('sheetFormulaValues?.grandTotals?.[mode]');
    expect(source).toContain("sheetFormulaValues?.status === 'UNAVAILABLE'");
    expect(source).toContain('합계·잔액은 표시하지 않습니다.');
    expect(source).not.toContain('function getCanonicalDerivedAmount');
  });

  it('shows the compact loading ring on main cashflow actions without changing status colors', () => {
    expect(source).toContain('sheetRefreshLoading ? <span aria-hidden="true"');
    expect(source).toContain('executiveApproverBusy ? <span aria-hidden="true"');
    expect(source).toContain('border-t-[#17324D] motion-safe:animate-spin');
  });

  it('drops the inbox card but keeps the issue count badge', () => {
    expect(source).not.toContain("inbox.push({ id: 'all-clear'");
    expect(source).toContain('const statusBadgeLabel = opsSummary?.status.label');
    expect(source).toContain('{statusBadgeLabel}');
    expect(source).not.toContain('`확인 항목 ${opsSummary.status.count}건`');
    expect(source).not.toContain('visibleInbox');
    expect(source).not.toContain('text-muted-foreground">확인할 항목</div>');
    expect(source).not.toContain('xl:max-h-[126px]');
  });

  it('allows the current user to be selected as organization head', () => {
    expect(source).not.toContain('.filter((member) => member.uid !== user?.uid)');
    expect(source).not.toContain('member.uid !== project?.registeredById');
    expect(source).not.toContain('member.uid !== project?.managerId');
  });

  it('renders server-owned rate state without comparing, clamping, or defaulting percentages', () => {
    expect(source).not.toContain('function rateStatusLabel');
    expect(source).toContain('rate?.statusLabel');
    expect(source).toContain('rate.barPercent');
    expect(source).not.toContain('Math.min(100, Math.max(0, rate.percent))');
    expect(source).not.toContain('contractCoveragePercent || 0');
    expect(source).not.toContain('actualProgressPercent || 0');
  });

  it('keeps Projection then ACTUAL row order and uses navy for difference rows', () => {
    const cashflowTables = source.slice(source.indexOf('function renderProjectionCell'), source.indexOf('function renderPortalSettlementPanel()'));
    expect(source.indexOf('data-cashflow-block="projection"')).toBeLessThan(source.indexOf('data-cashflow-block="actual"'));
    expect(source).toMatch(/renderModeLineRows\(mode, CASHFLOW_IN_LINES[\s\S]*renderSummaryRow\(mode, 'totalIn'\)[\s\S]*renderModeLineRows\(mode, CASHFLOW_OUT_LINES[\s\S]*renderSummaryRow\(mode, 'totalOut'\)[\s\S]*renderSummaryRow\(mode, 'net'\)/);
    expect(source).toContain('Projection - Actual 차이');
    expect(source).toContain('시트 수식값');
    expect(source).not.toContain('setDifferenceViewMode');
    expect(source).toContain("'bg-[#EAF0F5] text-[#17324D]'");
    expect(source).toContain("rowIndex % 2 === 0 ? 'bg-white' : 'bg-slate-50'");
    expect(source).toContain("input.isAltRow ? 'bg-slate-50' : 'bg-white'");
    expect(source).toContain('isAltRow: rowIndex % 2 === 1');
    expect(source).toContain("'text-emerald-700' : 'text-red-700'");
    expect(source).toContain("'bg-[#EAF0F5] text-sky-700'");
    expect(source).toContain('data-cashflow-settlement-actions className={`grid gap-px overflow-hidden rounded-md border border-border bg-border');
    expect(source).toContain("surface: 'border-border bg-accent'");
    expect(source).toContain('text-card-foreground">주간 정산');
    expect(source).toContain('text-card-foreground">월 결산');
    expect(source).toContain('프로젝트 조직장');
    expect(source).toContain('project-executive-approver');
    // 에러 토스트는 지웠다(2026-08-19 오전) - 실패는 그 자리 인라인 배너로 말한다.
    // 성공 확인은 같은 날 오후에 되살렸다: 반영·요청·회수·확정이 됐는지 사용자가 알 길이 없었다.
    // 그래서 toast 는 success 만 쓴다.
    expect(source).toContain('setWeeklyActionNotice');
    expect(source).toContain('주간 정산 완료 요청을 보냈어요');
    expect(source).toContain('완료 요청을 회수했어요');
    expect(source).toContain('주간 정산을 확정했어요');
    expect(source).toContain('weeklyActionNotice && !weeklyWithdrawError');
    expect(source).toContain("setWeeklyActionNotice(''), 6000");
    expect(source).toContain("import { toast } from 'sonner';");
    // 반영 건수는 다시 쓴 월의 셀 수(appliedLineCount, 월당 160)가 아니라 검토 단계의 변경 후보 수.
    // 내용(어떤 칸이 얼마→얼마)도 같이 말한다.
    expect(source).toContain('buildSheetApplyNotice({ stagedLineCount: stage.stagedLineCount, candidates: stage.candidates })');
    expect(source).not.toContain('result.appliedLineCount.toLocaleString');
    expect(source).toContain("toast.success('월 결산 승인 요청을 보냈어요. 조직장 승인을 기다립니다.')");
    expect(source).toContain("toast.success('월 결산 요청을 회수했어요.')");
    expect(source).toContain("toast.error(resolveApiErrorMessage(finalError, '시트 값을 반영하지 못했습니다. 잠시 후 다시 시도해 주세요.'))");
    expect(source).toContain("toast.success('MYSCube가 이미 시트 최신값과 같습니다.');");
    expect(source).not.toContain('toast.warning');
    expect(source).not.toContain('월 결산 승인 조직장을 선택하세요');
    expect(source).toContain('saveCashflowMonthCloseApproverViaBff');
    expect(source).toContain('text-secondary-foreground">{check.title}');
    expect(source).toContain('text-muted-foreground">프로젝트 전체 기간 · BFF/JVM 서버 판정');
    expect(source).toContain('bg-accent px-2.5 py-1 font-semibold text-accent-foreground');
    expect(source).toContain('space-y-5 bg-background p-4');
    expect(source).not.toMatch(/FFF7DE|E4C974|D6A92C|FCE8A8/);
    expect(source).toContain('text-red-700');
    expect(cashflowTables).not.toMatch(/(?:rose|amber|blue|indigo|violet)-\d+/);
  });

  it('keeps cashflow tables compact and shows server-owned date ranges in the practitioner timeline', () => {
    expect(source).toContain('{week.label}');
    expect(source).not.toContain('formatShortWeekRange');
    expect(source).not.toContain('week.weekStart.slice(5)');
    expect(source).toContain('periodLabel: `${week.weekStart} ~ ${week.weekEnd}`');
    expect(source).toContain('node.periodLabel ? <div className="mt-0.5 text-slate-500">{node.periodLabel}</div> : null');
  });

  it('keeps monthly labels while making a closed month a gray locked column group', () => {
    expect(source).toContain('const monthGroups = cashflowPresentation?.months || []');
    expect(source).toContain('colSpan={month.columnCount}');
    expect(source).toContain('{month.label}');
    expect(source).toContain('LockKeyhole');
    expect(source).toContain('month.locked ? <LockKeyhole');
    expect(source).toContain('{month.badgeLabel}');
    expect(source).toContain('cashflowSurfaceClass(week.surfaceTone)');
    expect(source).toContain('{week.statusLabel}');
    expect(source).not.toContain('const weeklyStatusByWeek = new Map');
    expect(source).not.toContain('const monthCloseStatusByMonth = new Map');
    expect(source).not.toContain('const monthGroups = visibleWeeks.reduce');
  });

  it('keeps explicit zero ledger values distinct from unentered cells outside the as-of comparison range', () => {
    expect(source).toContain('Object.prototype.hasOwnProperty.call(amounts, params.lineId)');
    expect(source).not.toContain("? Boolean(comparisonLine?.projectionHadValue)");
  });

  it('places the operations dashboard before comparison and the monthly board', () => {
    const operations = source.indexOf('{renderOperationsPanel()}');
    const comparison = source.indexOf('data-cashflow-block="comparison"');
    const monthlyBoard = source.lastIndexOf('{renderUnifiedMonthlyBoard()}');
    expect(operations).toBeGreaterThan(-1);
    expect(operations).toBeLessThan(comparison);
    expect(comparison).toBeLessThan(monthlyBoard);
    expect(source).toContain('dashboardTitle');
    expect(source).toContain("'시트 설정'");
    expect(source).not.toContain('변경 내용 검토');
  });

  it('keeps the dashboard information order from the PPT before the comparison table', () => {
    const metadata = source.indexOf('sheetDashboardMetadata');
    const summary = source.indexOf('{dashboardSummary}');
    const management = source.indexOf('주요 관리 항목');
    const comparison = source.indexOf('data-cashflow-block="comparison"');
    expect(metadata).toBeGreaterThan(-1);
    expect(summary).toBeGreaterThan(metadata);
    expect(management).toBeGreaterThan(summary);
    expect(comparison).toBeGreaterThan(management);
  });

  it('keeps the dashboard deposit schedule as a compact sheet-confirmed note', () => {
    expect(source).toContain('세금계산서 발행일 · 입금일 · 입금액 주별 확인됨');
    expect(source).not.toContain('세금계산서·입금 일정</h3>');
  });

  it('keeps the PPT summary as Projection, Actual, and monthly close only', () => {
    expect(source).toContain("renderRateTile('Projection', opsSummary?.rates.projection)");
    expect(source).toContain("renderRateTile('Actual', opsSummary?.rates.actual)");
    expect(source).toContain('<CashflowCanonicalSummary');
    expect(source).not.toContain('opsSummary.rates.confirmation');
    expect(source).not.toContain('renderOpsStatusDonut');
  });

  it('renders server-owned operation rates without rebuilding raw dashboard business totals', () => {
    expect(source).toContain('opsSummary?.rates.projection');
    expect(source).toContain('opsSummary?.rates.actual');
    expect(source).toContain('opsSummary?.status.detail');
    expect(source).not.toContain('프로젝트 등록 계약금액');
    expect(source).not.toContain('전체 사업기간 Projection 매출액+매출부가세');
    expect(source).not.toContain('projectionContractAmount');
    expect(source).not.toContain('projectionSalesAndVatTotal');
    expect(source).not.toContain('contractDifference');
    expect(source).not.toContain('contractCoveragePercent');
    expect(source).not.toContain('계약금액 0원');
  });

  it('keeps sheet sync explicit and uses the approved action label', () => {
    expect(source).toContain('handleRefreshSheetMirror');
    expect(source).toContain('refreshCashflowSheetLabMirrorViaBff');
    expect(source).toContain('stageCashflowSheetLabViaBff');
    expect(source).not.toContain('handleStagePinnedSheetValues(false, cashflowSheetMirror)');
    expect(source).toContain('시트 값 가져와 덮어쓰기');
    expect(source).toContain('handleRefreshAndApplySheetValues');
    expect(source).toContain('fetchCashflowActivityViaBff');
    expect(source).toContain('MYSCube 시트 덮어쓰기');
    expect(source).toContain('replaceAllActualSources');
    expect(source).not.toContain('시트 연동하기');
    expect(source).not.toContain('최신값 다시 가져오기');
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('MYSCube 시트와 다른 값이 없습니다.');
    expect(source).not.toContain('시트 변경이 없어 기존 고정값을 그대로 사용합니다.');
  });

  it('probes sheet freshness on entry without a full read', () => {
    // 진입은 modifiedTime 만 싸게 대조한다. 시트 풀 리드(checkCashflowSheetChangesViaBff)는
    // 진입 경로에서 사라졌고, 사용자가 '시트 불러오기' 를 누를 때만 일어난다.
    expect(source).toContain('probeCashflowSheetFreshnessViaBff');
    expect(source).toContain('setCashflowSheetFreshness');
    expect(source).toContain('sheetChangedSinceMirror');
    expect(source).not.toContain('checkCashflowSheetChangesViaBff');
    expect(source).not.toContain('const sheetChangeCount = [');
    expect(source).not.toContain('변경 ${sheetChangeCount.toLocaleString()}건');
    // 단일 버튼은 고정된 시트 값을 가져온 뒤 같은 계약으로 덮어쓴다.
    expect(source).toContain('시트 변경됨 · 가져와 덮어쓰기');
    expect(source).not.toContain('onClick={handleOpenSheetReviewDialog}');
    expect(source).toContain('시트 이동');
    expect(source).toContain('href={configuredSheetUrl}');
    expect(source).toContain('target="_blank"');
    expect(source).toContain('rel="noopener noreferrer"');
    expect(source).not.toContain('pendingAutoStageRevision');
    expect(source).not.toContain('setPendingAutoStageRevision');

    const checkFlow = source.slice(
      source.indexOf('const checkSheetChanges = async'),
      source.indexOf('void checkSheetChanges();'),
    );
    expect(checkFlow).not.toContain('applyCashflowSheetLabViaBff');
    expect(source).toMatch(/expectedMirrorRevision: sourceMirror\.sourceRevision,\s*\.\.\.\(replaceAllActualSources/);
    expect(checkFlow).not.toContain('refreshCashflowSheetLabMirrorViaBff');
  });

  it('keeps the sheet refresh loading state open until the successful response is processed', () => {
    expect(source).toContain('CashflowSheetSyncOverlay');
    expect(source).toContain('{sheetRefreshLoading ? <CashflowSheetSyncOverlay operation="refresh" /> : null}');
    expect(source).toContain('inert={sheetRefreshLoading || undefined}');
    expect(source).toContain('aria-busy={sheetRefreshLoading}');
    expect(source).not.toContain('setSheetRefreshResult');
    expect(source).not.toContain('setSheetStageDialog');
    expect(source).not.toContain('handingOffToAutoStage');
  });

  it('reuses the staged run when a closed-month change needs a reason', () => {
    expect(source).toContain("bffErrorCode(finalError) === 'cashflow_closed_month_reason_required'");
    expect(source).toContain("onSubmit((resumeRequired ? resumeReason : needsReason ? reason : '').trim())");
    expect(source).toContain('lateSheetFormulaAccepted,');
    expect(source).toContain('closedMonthChangeReason');
    expect(source).toContain('마감 후 시트값 변경');
    expect(source).toContain('사유와 함께 반영');
    expect(source).not.toContain('renderSheetStageReviewGrid');
    expect(source).not.toContain('sheetStageDialog');
    expect(source).not.toContain('캐시플로 항목 사람 확인');
  });

  it('asks before applying a sheet whose displayed formulas differ from the JVM calculation', () => {
    expect(source).toContain("bffErrorCode(finalError) === 'cashflow_formula_mismatch_confirmation_required'");
    expect(source).toContain('cashflowFormulaMismatchesFromError');
    expect(source).toContain('pending.acceptPendingApprovalDifferences');
  });

  it('keeps an unlinked project usable and guides the user to sheet setup', () => {
    expect(source).toContain("cashflowSheetConfig ? '시트 설정' : '시트 연결'");
    expect(source).toContain('시트를 연결하지 않아도 캐시플로우는 조회할 수 있습니다.');
    expect(source).toContain('시트 설정에서 직접 시트값을 가져올 때만 고정합니다.');
    expect(source).toContain('!cashflowSheetConfigLoaded || cashflowSheetConfig || !projectId');
    expect(source).toContain('myscube:cashflow-sheet-onboarding:');
    expect(source).toContain('캐시플로우 시트 연동 시작하기');
    expect(source).toContain('나중에 하기');
    expect(source).toContain('설정 후에도 자동으로 값을 가져오지 않습니다.');
    expect(source).toContain('sheetFormulaValues?.weekly.find');
    expect(source).toContain('sheetFormulaValues?.grandTotals?.[mode]');
  });

  it('shows the server service account immediately in project sheet setup', () => {
    expect(source).toContain('setCashflowSystemAccountEmail(response.systemAccountEmail || response.accessPolicy?.serviceAccountEmail');
    expect(source).toContain('먼저 서비스 계정을 Google Sheet 편집자로 공유해 주세요.');
    expect(source).toContain('{cashflowSystemAccountEmail}');
    expect(source).toContain('계정 복사');
  });

  it('keeps legacy closed snapshots as evidence-only without rendering annual-year views', () => {
    expect(source).toContain("snapshotCompatibility?.status === 'LEGACY_EVIDENCE_ONLY'");
    expect(source).toContain('이전 형식의 월 결산입니다.');
    expect(source).toContain('재오픈 승인 후 시트값을 다시 반영하고 재결산');
    expect(source).not.toContain('fetchCashflowSnapshotViaBff');
    expect(source).not.toContain('resolveCashflowEvidenceScope({');
    expect(source).toContain("cashflowPresentation?.evidenceSource === 'DASHBOARD'");
    expect(source).not.toContain('data-cashflow-block="multi-year-view"');
    expect(source).not.toContain('data-cashflow-year-view');
    expect(source).toContain('monthCloseResult?.dashboard?.sheetMetadata as CashflowSheetDashboardMetadata');
  });

  it('keeps the operations dashboard as the first visible cashflow block', () => {
    expect(source).not.toContain('시트가 아직 연결되지 않았습니다.');
    const operations = source.indexOf('{renderOperationsPanel()}');
    const comparison = source.indexOf('data-cashflow-block="comparison"');
    expect(operations).toBeGreaterThan(-1);
    expect(operations).toBeLessThan(comparison);
  });

  it('shows month close only as a compact board action instead of a standalone panel', () => {
    expect(source).not.toContain('data-cashflow-block="month-close"');
    expect(source).toContain('type="month"');
    expect(source).toContain('누적 월결산 승인 요청');
    expect(source).toContain('재오픈 요청');
  });

  it('provides an explicit persisted weekly settlement action without a Stage QA clock', () => {
    expect(source).not.toContain('Stage QA 기준시각');
    expect(source).not.toContain('setCashflowMonthCloseQaDateTimeViaBff');
    expect(source).toContain('completeCashflowWeeklyUpdateViaBff');
    expect(source).toContain('주간 정산 완료');
    expect(source).toContain('completedBy');
    // 주간 상태 라벨은 BFF(cashflowWeeklyStatusLabel) 가 준다. 화면이 자기 표를 들면 대시보드와 어긋난다.
    expect(source).toContain('{week.statusLabel}');
    expect(source).not.toContain('기한 후 완료·미준수');
    expect(source).toContain("updateResult: weeklyUpdateResult");
    expect(source).toContain("['CHANGED', '변경사항 반영 완료'");
    expect(source).toContain("['NO_CHANGES', '변경사항 없음'");
    expect(source).toContain('대상 주차와 그 이후 15개 재무주차(총 16주·256칸)의 JVM 저장 Projection 값을 확인합니다.');
    expect(source).toContain(".sort((left, right) => left.localeCompare(right))");
    expect(source).toContain("weeklyProjectionWarning ? '무시하고 반영' : '반영'");
    expect(source).not.toContain('선택한 결과로 완료');
    expect(source).toContain('서버가 확인한 미입력 항목');
    expect(source).not.toContain('ZERO(0원)는 작성값이며 EMPTY(미입력)는 완료할 수 없습니다.');
    expect(source).not.toContain('Cashflow weekly lock no longer matches');
    expect(source).toContain('weeklyProjectionValidation(error)');
    expect(source).toContain('resolveCashflowWeeklyCompletionErrorMessage(');
    expect(source).toContain('fetchCashflowWeeklyComplianceViaBff');
    expect(source).not.toContain("week.status === 'ON_TIME' ?");
    expect(source).not.toContain("week.status === 'COMPLETED_LATE' ?");
  });

  // 계약 변경(2026-08-09): sticky 는 가장 가까운 스크롤 조상에만 붙는다
  // (w3c/csswg-drafts#9140). 표마다 독립 overflow-x 래퍼를 두면 주차 헤더의
  // sticky top 이 죽고 두 표의 가로 스크롤이 어긋나므로, 스크롤 컨테이너를
  // 하나로 합쳐 그 사실 자체를 고정한다.
  it('keeps Projection and Actual inside one shared scroll container so sticky headers work', () => {
    expect(source).toContain('aria-label="Projection과 Actual 현금흐름 스크롤 표"');
    // 컨테이너는 하나이고, 세로(max-height)와 가로 스크롤을 모두 소유한다.
    expect(source).toContain('max-h-[calc(100vh-240px)] space-y-5 overflow-auto scroll-smooth');
    expect(source).not.toContain('overflow-x-auto scroll-smooth');
    // 두 표는 같은 컨테이너 안의 비스크롤 블록이다 — sticky 조상이 되면 안 된다.
    expect(source.indexOf('data-cashflow-block="projection"')).toBeGreaterThan(source.indexOf('ref={cashflowBoardScrollRef}'));
    expect(source.indexOf('data-cashflow-block="actual"')).toBeGreaterThan(source.indexOf('data-cashflow-block="projection"'));
    expect(source).not.toContain('onScroll=');
  });

  it('guides a blocked month close to the specific next action and records safe developer diagnostics', () => {
    const preparation = source.slice(source.indexOf('const monthClosePreparation'), source.indexOf('const handleOpenMonthCloseReview'));
    expect(source).toContain('cashflow.month_close.review.open');
    expect(source).toContain('cashflow.month_close.preflight.blocked');
    expect(source).toContain('cashflow.month_close.status.load');
    expect(source).toContain('cashflow.weekly_settlement.complete');
    expect(preparation).not.toContain('cashflow.month_close.preflight.sheet_refresh');
    expect(source).toContain('결산 상태 다시 확인');
    expect(source).toContain('recordDevtoolsLog');
    expect(source).toContain('toDevtoolsError');
  });

  it('shows a saved sheet structure error and its failing cells in the cashflow dashboard', () => {
    expect(source).toContain('시트 연동 오류: ');
    expect(source).toContain('cashflowSheetMirror.lastRefreshError.diagnostics');
    expect(source).toContain('diagnostic.sourceCell');
    expect(source).toContain('시트 설정');
    expect(source).not.toContain('min-w-0 truncate">시트 연동 오류');
  });

  it('locks the cashflow screen with the shared sheet sync overlay while a sheet refresh is running', () => {
    expect(source).toContain('CashflowSheetSyncOverlay');
    expect(source).toContain('inert={sheetRefreshLoading || undefined}');
    expect(source).toContain('<CashflowSheetSyncOverlay operation="refresh" />');
  });

  it('resumes the same staged sheet apply after an uncertain server response', () => {
    expect(source).toContain('getCashflowSheetLabApplyStatusViaBff');
    expect(source).toContain('isCashflowSheetApplyResultUncertain(finalError)');
    expect(source).toContain("status.status !== 'APPLYING'");
    expect(source).toContain('setLateSheetApply(stage)');
    expect(source).toContain('setSheetApplyResumeRequired(true)');
    expect(source).toContain('같은 작업 이어서 완료');
    // 전송 중이거나 이어서 완료 중이면 닫기가 무시된다.
    expect(source).toContain('if (sheetStageApplyLoading || sheetApplyResumeRequired) return;');
    expect(source).toContain('!resumeRequired && (');
  });

  it('does not carry a recovered closed-month reason into a later staged apply', () => {
    const applyStart = source.indexOf('const handleApplyStagedSheetValues');
    const applyFlow = source.slice(applyStart, source.indexOf('const handleStagePinnedSheetValues', applyStart));
    const rememberStart = applyFlow.indexOf('const rememberApplyResult');
    const rememberFlow = applyFlow.slice(rememberStart, applyFlow.indexOf('setSheetStageApplyLoading(true)', rememberStart));
    const uncertainStart = applyFlow.indexOf('if (isCashflowSheetApplyResultUncertain(finalError))');
    const uncertainFlow = applyFlow.slice(uncertainStart, applyFlow.indexOf('} else {', uncertainStart));
    expect(rememberFlow).toContain("setLateSheetResumeReason('');");
    expect(uncertainFlow).toContain('setLateSheetResumeReason(closedMonthChangeReason);');

    const stageStart = source.indexOf('const applyStageResult = async');
    const stageFlow = source.slice(stageStart, source.indexOf('setSheetRefreshLoading(true)', stageStart));
    const closedStart = stageFlow.indexOf('if (result.closedMonthDifferences?.length)');
    const closedFlow = stageFlow.slice(closedStart, stageFlow.indexOf('return;', closedStart));
    expect(closedFlow).toContain("setLateSheetResumeReason('');");

    const dialogKey = source.indexOf("key={lateSheetApply?.runId || 'closed-month'}");
    const dialogStart = source.lastIndexOf('<CashflowLateSheetChangeDialog', dialogKey);
    const dialogFlow = source.slice(dialogStart, source.indexOf('/>', dialogStart));
    expect(dialogFlow).toContain("setLateSheetResumeReason('');");
  });

  it('remounts each change dialog for a new staged run so local reason and filters reset', () => {
    expect(source).toContain("key={pendingApprovalStage?.runId || 'pending-approval'}");
    expect(source).toContain("key={lateSheetApply?.runId || 'closed-month'}");
  });

  it('uses the sheets-lab one-way apply contract and does not turn post-apply reads into a failed save', () => {
    const applyStart = source.indexOf('const handleApplyStagedSheetValues');
    const applyFlow = source.slice(applyStart, source.indexOf('const handleStagePinnedSheetValues', applyStart));
    expect(applyFlow).toContain('replaceAllActualSources: true');
    expect(applyFlow).toContain('pendingApprovalDifferenceCount: stage.pendingApprovalDifferenceCount');
    expect(applyFlow).toContain('pendingApprovalDifferenceManifestHash: stage.pendingApprovalDifferenceManifestHash');
    expect(applyFlow).toContain('acceptPendingApprovalDifferences');
    expect(applyFlow).not.toContain('applyRiskCandidates: true');
    expect(applyFlow).toContain('void Promise.allSettled([');
    expect(applyFlow).not.toContain('await Promise.all([\n        loadCashflowEvents(),\n        loadCashflowMonthClose(),\n      ]);');
    const refreshStart = source.indexOf('const handleRefreshSheetMirror');
    const refreshFlow = source.slice(refreshStart, source.indexOf('const handleMonthClosePreparationAction', refreshStart));
    expect(refreshFlow).toContain('sourceYear: cashflowSheetConfig.sourceYear');
    expect(refreshFlow).not.toContain('sourceYear: selectedYear');
  });

  it('stops after staging closed-month differences until a reason is explicitly confirmed', () => {
    const stageStart = source.indexOf('const applyStageResult = async');
    const stageFlow = source.slice(
      stageStart,
      source.indexOf('setSheetRefreshLoading(true)', stageStart),
    );
    expect(stageFlow).toContain('result.closedMonthDifferences?.length');
    expect(stageFlow).toContain('setLateSheetApply(result)');
    expect(stageFlow.indexOf('setLateSheetApply(result)')).toBeLessThan(stageFlow.indexOf('handleApplyStagedSheetValues(result)'));
    expect(source).toContain('이미 결산이 완료된 월의 값이 시트에서 변경되었습니다. 사유를 남기면 변경 이력과 경고 횟수에 함께 기록됩니다. 그래도 반영할까요?');
    expect(source).not.toContain('결산 마감일이 지난 값');
    // 결재 중 차이(pendingApproval)는 같은 표를 사유 없이 보여준다. 마감 후 변경(closedMonth)만 사유 필수.
    expect(source).toContain('(needsReason && !reason.trim()) || !complete');
    expect(source).toContain('kind="pendingApproval"');
    expect(source).not.toContain('결재 중 변경 후보 전체');
    expect(source).toContain('closedMonthDifferenceManifestHash');
    expect(source).toContain('closedMonthDifferenceCount');
    expect(source).toContain("onSubmit((resumeRequired ? resumeReason : needsReason ? reason : '').trim())");
  });

  it('runs the same main-page sheet action in refresh, stage, then apply order', () => {
    const actionStart = source.indexOf('const handleRefreshAndApplySheetValues');
    const action = source.slice(actionStart, source.indexOf('const handleOpenSheetOnboarding', actionStart));
    expect(action).toContain('await handleRefreshSheetMirror()');
    expect(action).toContain('await handleStagePinnedSheetValues(true, mirror)');
    expect(source).toContain('result.pendingApprovalDifferences?.length');
    expect(source).toContain('setPendingApprovalStage(result)');
    expect(source).toContain('pendingApprovalClosedMonthChangeReason');
    expect(source).toContain('pendingApprovalFormulaAccepted');
    const stageResultStart = source.indexOf('const applyStageResult');
    const stageResultFlow = source.slice(stageResultStart, source.indexOf('setSheetRefreshLoading(true)', stageResultStart));
    const closedMonthGate = stageResultFlow.indexOf('result.closedMonthDifferences?.length');
    const pendingApprovalGate = stageResultFlow.indexOf('result.pendingApprovalDifferences?.length');
    expect(closedMonthGate).toBeGreaterThan(-1);
    expect(pendingApprovalGate).toBeGreaterThan(-1);
    expect(closedMonthGate).toBeLessThan(pendingApprovalGate);
    expect(source).toContain("operation: 'cashflow.sheet_sync.one_click'");
    expect(action).toContain("toast.error(mirror?.lastRefreshError?.message || '시트 최신값을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.');");
  });

  it('continues a closed-month apply through a later pending-approval confirmation', () => {
    const applyStart = source.indexOf('const handleApplyStagedSheetValues');
    const applyFlow = source.slice(applyStart, source.indexOf('const handleStagePinnedSheetValues', applyStart));
    expect(applyFlow).toContain("bffErrorCode(finalError) === 'cashflow_pending_approval_confirmation_required'");
    expect(applyFlow).toContain('pendingApprovalDifferences: details?.pendingApprovalDifferences?.length');
    expect(source).toContain('pendingApprovalClosedMonthChangeReason');
    expect(source).toContain('pendingApprovalFormulaAccepted');
    expect(source).toContain('lateSheetPendingApprovalAccepted');
    expect(source).toContain('setLateSheetPendingApprovalAccepted(acceptPendingApprovalDifferences);');
    const closedDialogKey = source.indexOf("key={lateSheetApply?.runId || 'closed-month'}");
    const closedDialogStart = source.lastIndexOf('<CashflowLateSheetChangeDialog', closedDialogKey);
    const closedMonthDialog = source.slice(
      closedDialogStart,
      source.indexOf('<AlertDialog\n        open={blocker.state', closedDialogStart),
    );
    expect(closedMonthDialog).toContain('handleApplyStagedSheetValues(');
    expect(closedMonthDialog).toContain('lateSheetFormulaAccepted,');
    expect(closedMonthDialog).toContain('lateSheetPendingApprovalAccepted,');
    expect(source).toContain("setPendingApprovalClosedMonthChangeReason('');");
    expect(source).toContain('setPendingApprovalFormulaAccepted(false);');
    expect(source).toContain('toast.error(');
    expect(applyFlow).toContain("toast.error('로그인 정보를 확인하지 못했습니다. 다시 로그인한 뒤 시도해 주세요.');");
    expect(source).toContain("toast.error(resolveApiErrorMessage(error, '시트 변경 검토를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.'))");
  });

  it('keeps Projection read-only and accepts values only through sheet import', () => {
    expect(source).toContain('현금흐름 관리시트');
    expect(source).not.toContain('캐시플로 진단시트');
    expect(source).not.toContain('수정 시작');
    expect(source).not.toContain('서버 확정 원장 합계');
    expect(source).toContain('조회 전용 · 값은 시트 값 불러오기로만 반영됩니다.');
    expect(source).not.toContain('openProjectionWeekEditing');
    expect(source).not.toContain('projectionDrafts: drafts');
    expect(source).not.toContain('financialYearChecks?.years.length');
    expect(source).not.toContain('시트 {fmt(check.sheet[field.key])} · 등록 {fmt(check.registered[field.key])}');
  });

  it('keeps the selected-year board self-contained', () => {
    expect(source).not.toContain('cashflowYearView');
    expect(source).not.toContain('data-cashflow-block="multi-year-view"');
    expect(source).not.toContain('data-cashflow-year-view');
    expect(source).toContain('monthCloseResult?.dashboard?.canonical?.months');
    expect(source).not.toContain('cashflowSnapshotRange');
  });

  it('shows who explicitly loaded the sheet values in the activity timeline', () => {
    expect(source).toContain('decodeActivityActor');
    expect(source).toContain('decodeURIComponent(text)');
    expect(source).toContain('`${actorName}님이`');
    expect(source).toContain('`${actorEmail} 계정으로`');
    expect(source).toContain('시트의 최신 값을 불러와 MYSCube 시트 반영 전 검증본으로 보관했습니다.');
    expect(source).toContain('latestCashflowEventSummary');
    expect(source).toContain('시트의 최신 값을 불러왔습니다.');
  });

  it('keeps exact applied history in General Activity and searchable', () => {
    expect(source).not.toContain('AppliedCellHistory');
    expect(source).toContain('실제 반영 기록');
    expect(source).toContain('aria-label="실제 반영 기록 검색"');
    expect(source).toContain('function formatCashflowStateAmount');
    expect(source).toContain('formatCashflowStateAmount(event.beforeState, event.beforeAmount)');
    expect(source).toContain('formatCashflowStateAmount(event.afterState, event.afterAmount)');
    expect(source).not.toContain('source {event.sourceDetail || event.source ||');
    expect(source).not.toContain('operation {event.operation || event.type}');
    expect(source).toContain('aria-label="마감 후 변경 후보 전체 목록"');
  });

  it('does not globally truncate exact General Activity rows', () => {
    const mergeSource = source.slice(source.indexOf('function mergeCashflowEvents'), source.indexOf('function HoverExplain'));
    expect(mergeSource).not.toContain('.slice(');
  });

  it('loads one aggregate activity page and retries only a failed source without hiding loaded events', () => {
    expect(source).toContain("from './cashflow-activity-loader'");
    expect(source).toContain("cashflowActivityRequestGuard.start('aggregate', { reset: true })");
    expect(source).toContain("cashflowActivityRequestGuard.start(`source:${source}`)");
    expect(source).toContain('cashflowEventLoading || cashflowEventLoadingMore || !projectId');
    expect(source).toContain('limit: 50,');
    expect(source).toContain('signal: ticket.signal,');
    expect(source).toContain('response.errors.map');
    expect(source).toContain('setCashflowEvents((current) => mergeCashflowEvents(current, response.events))');
    expect(source).toContain('cashflowEventErrors.map');
    expect(source).toContain('onClick={() => void loadCashflowEventSource(failure.source, {');
    expect(source).toContain('preservePagination: Boolean(failure.preservePagination)');
    expect(source).toContain('실제 반영 기록을 불러오는 중입니다.');
    expect(source).toContain('아직 표시할 변경 기록이 없습니다.');
    expect(source).toContain('role="alert"');
    expect(source).not.toContain("setCashflowEventsError(resolveApiErrorMessage(error, '변경 이력을 불러오지 못했습니다.'))");
  });

  it('removes the three-source helper loop and pages opaque aggregate and recovery cursors', () => {
    expect(source).not.toContain('loadCashflowActivitySourcesSequentially');
    expect(source).toContain('const [cashflowActivityCursorQueue, setCashflowActivityCursorQueue] = useState<CashflowActivityCursor[]>');
    const rootLoadStart = source.indexOf('const loadCashflowEvents = useCallback');
    const rootLoadFlow = source.slice(rootLoadStart, source.indexOf('const loadMoreCashflowEvents', rootLoadStart));
    expect(rootLoadFlow).toContain('setCashflowActivityCursorQueue([]);');
    expect(source).toContain('const loadMoreCashflowEvents = useCallback(async (): Promise<void> => {');
    expect(source).toContain('cashflowEventLoadingMoreRef.current || cashflowEventLoading || cashflowEventLoadingSources.length > 0');
    expect(source).toContain('disabled={cashflowEventLoading || cashflowEventLoadingMore || cashflowEventLoadingSources.length > 0}');
    expect(source).toContain('cursor: queuedCursor.cursor,');
    expect(source).toContain('updateCashflowActivityCursorQueue(');
    expect(source).toContain('if (response.nextCursor === queuedCursor.cursor)');
    expect(source).toContain('updateCashflowActivityCursorQueue(current, queuedCursor.source, null)');
    expect(source).toContain("이전 기록 더 불러오기");
    expect(source).toContain('cashflowActivityCursorQueue.length > 0 ? loadMoreCashflowEvents() : loadCashflowActivityAggregate()');
  });

  it('aborts stale project activity and keeps mutation reloads behind timeline visibility', () => {
    expect(source).toContain('const loadCashflowActivityAggregate = useCallback(async (): Promise<void> => {');
    expect(source).toContain('cashflowActivityRequestGuard.invalidate();');
    expect(source).toContain('shouldStartCashflowActivityLoad({');
    expect(source).toContain('visible: opsTimelineVisibleRef.current,');
    expect(source).toContain('cashflowActivityScopeRef.current === activityScope');
    expect(source).toContain('currentScope: isCurrentCashflowActivityScope(),');
    expect(source).toContain("if (input.signal.aborted) throw new Error('활동 기록 요청이 중단되었습니다.');");
    expect(source).toContain('void loadCashflowActivityAggregate();');
  });

  it('reloads only Activity sources that each completed mutation can actually write', () => {
    expect(source).toContain("reloadCashflowActivityForMutations('sheet_mirror_refreshed')");
    expect(source).toContain("reloadCashflowActivityForMutations('sheet_values_applied')");
    expect(source).toContain("reloadCashflowActivityForMutations('month_reopen_completed')");

    const requestStart = source.indexOf('const handleFinalizeMonthClose');
    const requestFlow = source.slice(requestStart, source.indexOf('const handleWithdrawMonthCloseRequest', requestStart));
    const withdrawStart = source.indexOf('const handleWithdrawMonthCloseRequest');
    const withdrawFlow = source.slice(withdrawStart, source.indexOf('const handleMonthReopenAction', withdrawStart));
    expect(requestFlow).not.toContain('loadCashflowEvents()');
    expect(requestFlow).not.toContain('reloadCashflowActivityForMutations(');
    expect(withdrawFlow).not.toContain('loadCashflowEvents()');
    expect(withdrawFlow).not.toContain('reloadCashflowActivityForMutations(');
  });

  it('defers every one-click activity read and drains only successful sources outside frozen confirmation flows', () => {
    const frozenActionStart = source.indexOf('const handleRefreshAndApplySheetValues');
    const wrapperStart = source.indexOf('const handleDeferredRefreshAndApplySheetValues', frozenActionStart);
    const frozenAction = source.slice(frozenActionStart, wrapperStart);
    const action = source.slice(wrapperStart, source.indexOf('const handleOpenSheetOnboarding', wrapperStart));
    expect(frozenAction).not.toContain('cashflowActivityOneClickRef');
    expect(frozenAction).toContain("toast.error(mirror?.lastRefreshError?.message || '시트 최신값을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.');");
    expect(action).toContain('const oneClickActivityScope = activityScope;');
    expect(action).toContain('cashflowActivityOneClickRef.current.depth += 1;');
    expect(action).toContain('} finally {');
    expect(action).toContain('cashflowActivityOneClickRef.current.scope === oneClickActivityScope');
    expect(action).toContain('cashflowActivityOneClickRef.current.depth -= 1;');
    expect(action).toContain('setCashflowActivityDrainVersion((current) => current + 1);');
    const terminalDrain = action.slice(action.indexOf('} finally {'));
    expect(terminalDrain).not.toContain('cashflowActivityOneClickRef.current.pendingSources.clear();');
    expect(terminalDrain).not.toContain('void reloadCashflowActivitySources(pendingSources);');
    expect(action).not.toContain('loadCashflowEvents()');

    expect(source).toContain('takeCashflowActivityPendingWork(cashflowActivityOneClickRef.current');
    expect(source).toContain('busy: cashflowEventLoading || cashflowEventLoadingMore || cashflowEventLoadingSources.length > 0');
    expect(source).toContain("if (pendingWork?.kind === 'aggregate') void loadCashflowActivityAggregate();");
    expect(source).toContain("else if (pendingWork?.kind === 'sources') void reloadCashflowActivitySources(pendingWork.sources);");
    expect(source).toContain('cashflowActivityDrainVersion,');

    const mutationReloadStart = source.indexOf('const reloadCashflowActivityForMutations');
    const mutationReload = source.slice(mutationReloadStart, source.indexOf('const loadCashflowEvents', mutationReloadStart));
    expect(mutationReload).toContain('if (!opsTimelineVisibleRef.current) return;');
    expect(mutationReload).toContain('sources.forEach((source) => cashflowActivityOneClickRef.current.pendingSources.add(source));');
    expect(mutationReload).toContain('setCashflowActivityDrainVersion((current) => current + 1);');
    expect(mutationReload).not.toContain('await reloadCashflowActivitySources(sources);');

    const applyStart = source.indexOf('const handleApplyStagedSheetValues');
    const applyFlow = source.slice(applyStart, source.indexOf('const handleStagePinnedSheetValues', applyStart));
    const stageStart = source.indexOf('const handleStagePinnedSheetValues');
    const stageFlow = source.slice(stageStart, frozenActionStart);
    expect(applyFlow).not.toContain('cashflowActivityOneClickRef');
    expect(stageFlow).not.toContain('cashflowActivityOneClickRef');
    expect(applyFlow.indexOf('cashflow_formula_mismatch_confirmation_required')).toBeLessThan(applyFlow.indexOf('cashflow_closed_month_reason_required'));
    expect(applyFlow.indexOf('cashflow_closed_month_reason_required')).toBeLessThan(applyFlow.indexOf('cashflow_pending_approval_confirmation_required'));
    expect(source).toContain('onClick={() => void handleDeferredRefreshAndApplySheetValues()}');
  });

  it('keeps mutation head pages out of the aggregate cursor and replays a deferred initial aggregate once', () => {
    expect(source).toContain('pendingAggregate: false,');
    expect(source).toContain('cashflowActivityOneClickRef.current.pendingAggregate = true;');
    expect(source).toContain('const pendingWork = takeCashflowActivityPendingWork(');
    expect(source).toContain("if (pendingWork?.kind === 'aggregate') void loadCashflowActivityAggregate();");
    expect(source).toContain("else if (pendingWork?.kind === 'sources') void reloadCashflowActivitySources(pendingWork.sources);");

    expect(source).toContain('loadCashflowEventSource(source, { preservePagination: true })');
    expect(source).toContain('if (!options.preservePagination) {');
    expect(source).toContain('preservePagination: options.preservePagination');
    expect(source).toContain('preservePagination: Boolean(failure.preservePagination)');
  });

  it('uses the server KST comparison week and totals only the visible comparison scope', () => {
    expect(source).toContain('cashflowPresentation?.comparison.cells || []');
    expect(source).toContain('cashflowPresentation?.comparison.periodLabel || \'확인 불가\'');
    expect(source).not.toContain('monthCloseResult?.dashboard?.summary?.comparisonAsOfWeek');
    expect(source).not.toContain('resolveCashflowComparisonScope({');
    expect(source).not.toContain('comparisonWeeks.reduce');
    expect(source).not.toContain('comparisonAnnualYears.reduce');
    expect(source).toContain('const cashflowTotalPeriodLabel = cashflowPresentation?.comparison.periodLabel');
    expect(source).not.toContain("const totalProjection = projectLineTotalFor('projection', lineId)");
    expect(source).not.toContain("const totalActual = projectLineTotalFor('actual', lineId)");
  });

  it('shows the restored JVM Projection completeness warning', () => {
    expect(source).toContain('서버가 확인한 미입력 항목');
    expect(source).toContain('Projection 미입력 주차와 항목');
  });

  it('renders annual carry-forward and future totals around the selected year weekly ledger', () => {
    expect(source).toContain('const previousAnnualYears = cashflowPresentation?.annualBefore || []');
    expect(source).toContain('const followingAnnualYears = cashflowPresentation?.annualAfter || []');
    expect(source).not.toContain('annualYearsFor(weeklyYear)');
    expect(source).not.toContain('CASHFLOW_STANDARD_ANNUAL_YEARS');
    expect(source).toContain('sheetFormulaValues?.annual.find');
    expect(source).not.toContain('dashboard?.canonical as');
    expect(source).not.toContain('summarizeCanonicalCashflowYear');
    expect(source).toContain('{annual.label}');
    expect(source).toContain('const renderAnnualSummaryCell');
    expect(source).toContain('sheetFormulaValues?.grandTotals?.[mode]');
    expect(source).toContain('Total');
    expect(source).toContain('const visibleWeeks = annualWeeks');
    expect(source).toContain('annualSummaryValue(year, mode, kind)');
    expect(source).toContain('sheetDerivedAmount(mode, week.yearMonth, week.weekNo, kind)');
    expect(source).not.toContain("'서버 값'");
    expect(source).not.toContain("'값 없음'");
    expect(source).toContain('>미입력</');
    expect(source).toContain('>확인 불가</');
  });

  it('never renders synthetic zero cashflow values after the canonical read fails', () => {
    expect(source).toContain('shouldHideCashflowValuesAfterLoadError');
    expect(source).toContain('현금흐름 데이터를 불러오지 못했습니다.');
  });

  it('hides canonical cashflow values and shows a safe guide when the server marks the source unavailable', () => {
    expect(source).toContain("entry.section === 'cashflow'");
    expect(source).toContain('if (cashflowSourceUnavailable)');
    expect(source).toContain("entry.code === 'CASHFLOW_SOURCE_UNAVAILABLE'");
    expect(source).toContain('<p>{cashflowSourceUnavailableGuide}</p>');
    expect(source).toContain('확인되지 않은 금액은 표시하지 않습니다.');
    expect(source).toContain('불러오지 못한 항목은 표시하지 않으며, 다시 조회하기 전까지 관련 판정은 차단됩니다.');
    expect(source).not.toContain('아래 현금흐름 수치는 유효합니다.');
  });

  it('renders the Projection - Actual row from the pinned Sheet formula range', () => {
    expect(source).not.toContain('resolveCashflowComparisonScope');
    expect(source).not.toContain('monthCloseResult?.dashboard?.summary?.comparisonAsOfWeek');
    expect(source).toContain('const comparisonCells = cashflowPresentation?.comparison.cells || []');
    expect(source).not.toContain('sheetFormulaValues?.projectionActualDifferences.find');
    expect(source).not.toContain('comparisonWeeks.reduce');
    expect(source).not.toContain('const cashflowTotalPeriodLabel = `${previousAnnualYears[0] || selectedYear}년 ~ ${followingAnnualYears.at(-1) || selectedYear}년`');
    expect(source).not.toContain('const mirroredAnnualTotals = useMemo');
    expect(source).toContain('const annualTotalFor = (year: number');
    expect(source).not.toContain("const totalProjection = projectLineTotalFor('projection', lineId)");
    expect(source).not.toContain("const totalActual = projectLineTotalFor('actual', lineId)");
    expect(source).toContain('Projection - Actual 차이</div>');
    expect(source).toContain('현금흐름 관리시트 E11:BL11 주별 수식 기준');
    expect(source).not.toContain('!cashflowPresentation.comparison.changed');
    expect(source).not.toContain('Projection과 Actual 차이가 없습니다.');
    expect(source).toContain('`${rowSurface} text-slate-500`');
    expect(source).toContain('const columnCount = comparisonCells.length');
    expect(source).not.toContain('difference: hasValue ? projection - actual : null');
  });

  it('keeps the last good month result during a same-month retry and lists every management finding', () => {
    expect(source).toContain('setMonthCloseResult((current) => isCashflowMonthCloseRequestForSelection(current, projectId, yearMonth)');
    expect(source).toContain('check.findings?.length');
    expect(source).toContain('check.findings.map((finding)');
  });

  it('reloads the canonical ledger and management checks together after sheet apply', () => {
    expect(source).toContain('loadCashflowMonthClose()');
    expect(source).not.toContain('loadCashflowComparison');
  });

  it('warns once for unsaved local changes without a cashflow edit session', () => {
    expect(source).not.toContain('임시저장 후 종료');
    expect(source).toContain('저장하지 않고 이동');
    expect(source).toContain('계속 작성');
    expect(source).toContain('discardChangesAndLeave');
    expect(source).not.toContain('cashflowLease.release');
    expect(source).toContain('blocker.proceed?.();');
    expect(source).not.toContain('hasActiveEditSession');
    expect(source).toContain('저장되지 않은 변경사항이 있습니다');
  });

  it('keeps a missing server cell null instead of fabricating zero', () => {
    expect(source).toContain('amount: number | null | undefined');
    expect(source).toContain('amount: !hasValue ? null : isSafeCashflowNumber(amount) ? amount : undefined');
    expect(source).toContain('persisted.amount === null');
    expect(source).toContain('persisted.amount === undefined');
    expect(source).not.toContain('Number(amounts[params.lineId] || 0)');
    expect(source).not.toContain('function getBoardEffectiveAmount');
  });

  it('shows unavailable instead of fabricating zero for missing amounts and counts', () => {
    expect(source).toContain('function isSafeCashflowNumber(value: unknown): value is number');
    expect(source).toContain('function formatCashflowAmount(value: unknown): string');
    expect(source).toContain("function formatCashflowCount(value: unknown, unit: '건' | '회')");
    expect(source).not.toContain('Number(total?.lineAmounts?.[lineId] || 0)');
    expect(source).not.toContain('Number(total?.lineAmounts?.[lineId] ?? 0)');
    expect(source).not.toContain('Number(event.beforeAmount || 0)');
    expect(source).not.toContain('Number(event.afterAmount || 0)');
    expect(source).not.toContain('event.appliedLineCount || 0');
    expect(source).not.toContain('event.projectionLineCount || 0');
    expect(source).not.toContain('event.actualLineCount || 0');
    expect(source).not.toContain('deadlineSummary?.missedCount || 0');
    expect(source).not.toContain('deadlineSummary?.completedCount || 0');
    expect(source).not.toContain('Number(change.beforeAmount || 0)');
    expect(source).not.toContain('Number(change.afterAmount || 0)');
    expect(source).toContain("state === 'EMPTY' ? null : undefined");
    expect(source).toContain("<span className=\"text-red-700\">확인 불가</span>");
  });

  it('keeps the established layout by default and stacks responsive grids only in a narrow host', () => {
    expect(source).toContain('compact = false');
    expect(source).toContain('compact?: boolean;');
    expect(source).toContain("compact ? '' : 'md:grid-cols-3'");
    expect(source).toContain("compact ? '' : 'xl:grid-cols-[minmax(0,1fr)_320px]'");
  });
});
