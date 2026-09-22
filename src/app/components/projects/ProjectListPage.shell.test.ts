import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, 'ProjectListPage.tsx'), 'utf8');
const pendingHookSource = readFileSync(resolve(import.meta.dirname, 'usePendingProjectChangeRequests.ts'), 'utf8');

describe('ProjectListPage shell contract', () => {
  it('does not show the retired monitoring preset filter bar', () => {
    expect(source).not.toContain('data-testid="project-monitoring-presets"');
    expect(source).not.toContain('data-testid="project-monitoring-preset-no-ledger"');
    expect(source).not.toContain('data-testid="project-monitoring-preset-pending-approval"');
    expect(source).not.toContain('data-testid="project-monitoring-preset-missing-evidence"');
    expect(source).not.toContain('모니터링 프리셋');
  });

  it('shows settlement type labels instead of O/X settlement flags', () => {
    expect(source).toContain('정산 유형');
    expect(source).toContain('전체 정산 유형');
    expect(source).toContain('settlementFilter');
    expect(source).not.toContain('typeFilter');
    expect(source).toContain('normalizeSettlementType(p.settlementType)');
    expect(source).toContain('SETTLEMENT_TYPE_LABELS[normalizeSettlementType(p.settlementType)]');
    expect(source).not.toContain('SETTLEMENT_TYPE_SHORT[normalizeSettlementType(p.settlementType)]');
    expect(source).not.toContain('p.isSettled ?');
  });

  it('searches the PPT-defined project fields without broken header shortcuts', () => {
    expect(source).toContain('matchesProjectListFilters(project, {');
    expect(source).toContain('프로젝트명, 계약명, 계약대상, 담당조직, 운영진 검색');
    expect(source).not.toContain("navigate('/projects/new')");
    expect(source).not.toContain("navigate('/approvals')");
    expect(source).not.toContain('승인 대기 확인');
    expect(source).not.toContain('canAccessAdminPath');
  });

  it('shows the business owner from registeredBy fields', () => {
    expect(source).toContain('최종 보고자 (실무책임자)');
    expect(source).toContain('p.registeredByName || p.managerName');
  });

  it('orders lifecycle tabs as contract-pending, in-progress, completed, then trash', () => {
    expect(source).toContain('data-testid="projects-tab-contract-pending"');
    expect(source).toContain('data-testid="projects-tab-in-progress"');
    expect(source).toContain('data-testid="projects-tab-completed"');
    expect(source.indexOf('data-testid="projects-tab-contract-pending"')).toBeLessThan(
      source.indexOf('data-testid="projects-tab-in-progress"'),
    );
    expect(source.indexOf('data-testid="projects-tab-in-progress"')).toBeLessThan(
      source.indexOf('data-testid="projects-tab-completed"'),
    );
    expect(source).toContain('data-testid="projects-tab-trash"');
    expect(source.indexOf('data-testid="projects-tab-completed"')).toBeLessThan(
      source.indexOf('data-testid="projects-tab-trash"'),
    );
    expect(source).not.toContain('data-testid="projects-tab-confirmed"');
  });

  it('visually groups lifecycle tabs as a connected navy four-stage control', () => {
    expect(source).toContain('grid-cols-4');
    expect(source).toContain('bg-[#0f2747]');
    expect(source).toContain('data-[state=active]:bg-[#174a7c]');
    expect(source).toContain('data-[state=active]:text-white');
    expect(source).toContain('rounded-t-none');
    expect(source).toContain('h-11 w-full grid-cols-4 items-center');
    expect(source).not.toContain('rounded-full border border-current text-[10px] font-semibold">1</span>');
  });

  it('keeps filter defaults while showing planner-defined labels in the required order', () => {
    expect(source).toContain('프로젝트 진행 현황');
    expect(source).not.toContain('conic-gradient');
    expect(source).toContain('#e5484d');
    expect(source).toContain('#2f9e44');
    expect(source).toContain('#111827');
    expect(source).toContain('summaryProjects');
    expect(source).toContain('계약금액 합계');
    expect(source).toContain('총수익 합계');
    expect(source).toContain('전체 조직');
    expect(source).toContain('전체 상태');
    expect(source).toContain('전체 정산 유형');
    expect(source.indexOf('담당조직</Label>')).toBeLessThan(source.indexOf('진행 상태</Label>'));
    expect(source.indexOf('진행 상태</Label>')).toBeLessThan(source.indexOf('정산 유형</Label>'));
  });

  it('renders approval-log monthly performance for the current KST year with values', () => {
    expect(source).toContain('buildProjectMonthlyPerformance(summaryProjects)');
    expect(source).toContain('승인 기준 월별');
    expect(source).toContain('올해 · KST');
    expect(source).toContain('formatChartAmount');
    expect(source).toContain('repeat(${monthlyPerformance.length}, minmax(0, 1fr))');
    expect(source).not.toContain('매출 MoM');
    expect(source).not.toContain('총수익 MoM');
    expect(source).not.toContain('상태별 분포를 기준으로 현재 프로젝트 포트폴리오를 확인합니다.');
    expect(source).not.toContain('lifecycleChartBackground');
    expect(source).toContain('#001e46');
    expect(source).toContain('#0e7490');
    expect(source).toContain('getProjectRegistrationCicOptions()');
  });

  it('shows and sorts the registered total revenue next to contract amount', () => {
    expect(source).toContain("type SortKey = 'name' | 'contractAmount' | 'totalRevenueAmount' | 'status'");
    expect(source).toContain("handleSort('totalRevenueAmount')");
    expect(source).toContain('총수익 <ArrowUpDown');
    expect(source).toContain("normalizeProjectRevenueFields(p, 'totalRevenueAmount').totalRevenueAmount");
  });

  it('keeps the contract-pending action consistent across rows', () => {
    expect(source).toContain('navigate(`/projects/${p.id}/edit?phase=CONFIRMED`)');
    expect(source).toContain('확정 <ArrowRight className="w-3 h-3" />');
    expect(source).not.toContain("p.phase === 'PROSPECT'");
  });

  it('expands project context inline instead of navigating away from the list', () => {
    expect(source).toContain('expandedProjectId');
    expect(source).toContain('프로젝트 목적');
    expect(source).toContain('주요 내용');
    expect(source).toContain('normalizeProjectDepartment(p.department)');
    expect(source).not.toContain('onClick={() => navigate(`/projects/${p.id}`)}');
  });

  it('surfaces pending PM change requests through the permission-checked BFF summary', () => {
    expect(source).toContain('usePendingProjectChangeRequests');
    expect(source).toContain('usePendingProjectChangeRequests(projectIds)');
    expect(source).toContain('수정 검토 중');
    expect(pendingHookSource).toContain('fetchPendingProjectChangeRequestsViaBff');
    expect(pendingHookSource).toContain('projectIds,');
    expect(pendingHookSource).toContain("request.requestKind !== 'CHANGE'");
    expect(pendingHookSource).toContain("request.targetProjectId || request.approvedProjectId");
    expect(pendingHookSource).not.toContain("collection(db, 'tenants'");
  });
});
