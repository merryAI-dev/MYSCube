import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  filterCashflowProjectsByDepartment,
  formatCashflowExecutiveApprover,
  formatCashflowManager,
} from './CashflowWeeklyPage';
import type { PersonRecord } from '../../lib/platform-bff-client';

const source = readFileSync(resolve(import.meta.dirname, 'CashflowWeeklyPage.tsx'), 'utf8');

describe('CashflowWeeklyPage settlement status surface', () => {
  it('filters both visible rows and compliance requests by normalized department', () => {
    expect(source).toContain("const [deptFilter, setDeptFilter] = useState('ALL')");
    expect(source).toContain('getProjectRegistrationCicOptions()');
    expect(source).toContain('normalizeProjectDepartment(project.department)');
    expect(source).toContain('filterCashflowProjectsByDepartment(projects, deptFilter)');
    expect(source).not.toContain('Promise.allSettled(filteredProjects.map');
    expect(source).toContain('const projectIds = JSON.parse(overviewProjectIdsKey) as string[]');
    expect(source).toContain('{filteredProjects.map((project) => {');
    expect(source).toContain('filteredProjects.length === 0');
    expect(source).toContain('>담당조직</Label>');
    expect(source).toContain('<SelectItem value="ALL">전체 조직</SelectItem>');

    const projects = [
      { id: 'axr', department: 'AXR team' },
      { id: 'cic', department: 'CIC 2' },
      { id: 'empty', department: '' },
    ];
    expect(filterCashflowProjectsByDepartment(projects, 'ALL').map(({ id }) => id)).toEqual(['axr', 'cic', 'empty']);
    expect(filterCashflowProjectsByDepartment(projects, 'AXR팀').map(({ id }) => id)).toEqual(['axr']);
    expect(filterCashflowProjectsByDepartment(projects, 'CIC2').map(({ id }) => id)).toEqual(['cic']);
    expect(filterCashflowProjectsByDepartment(projects, '없는 조직')).toEqual([]);
  });

  it('keeps the executive approver and manager in separate columns', () => {
    const people: Array<Pick<PersonRecord, 'uid' | 'name' | 'nickname' | 'email'>> = [{ uid: 'owner-1', name: '원장 책임자', nickname: '원장', email: 'owner@example.com' }];
    expect(formatCashflowExecutiveApprover({ executiveApproverId: 'owner-1', executiveApproverName: '저장 책임자' }, people)).toBe('원장 책임자(원장)');
    expect(formatCashflowManager({ managerId: 'owner-1', managerName: '기존 담당자' }, people)).toBe('원장 책임자(원장)');
    expect(formatCashflowExecutiveApprover({ executiveApproverId: 'missing', executiveApproverName: '스냅샷 책임자' }, people)).toBe('연결 필요');
    expect(formatCashflowManager({ managerId: 'missing', managerName: '기존 담당자' }, people)).toBe('연결 필요');
    expect(source).toContain('People 연결 필요');
    expect(source).toContain('레거시 이름은 표시만 하고, 선택한 People UID로만');
    expect(source).toContain('flex flex-col items-center gap-0.5 text-center');
  });

  it('hides settlement actions when the canonical cycle needs rechecking', () => {
    expect(source).toContain("item.settlementCycle.health !== 'OK'");
    expect(source).toContain("item.settlementCycle.businessState === 'INCONSISTENT'");
    expect(source).toContain("[item.projectId, '상태 재확인 필요']");
    expect(source).toContain('>{statusErrors[project.id]}</span>');
    expect(source).not.toContain("error.code === 'STATUS_UNAVAILABLE'");
  });

  it('routes detailed work to the project cashflow screen', () => {
    expect(source).not.toContain('useCashflowEditLease');
    expect(source).not.toContain('updateVarianceFlag');
    expect(source).not.toContain('EditLeaseDialogs');
    expect(source).not.toContain('checkBeforeMutation');
    expect(source).toContain('&view=compare');
    expect(source).toContain('#projection-actual-comparison');
    expect(source).toContain('현금흐름 보기');
  });

  it('keeps month close in its separate admin column', () => {
    expect(source).toContain('<div>{monthCloseTargetLabel} ·');
    expect(source).toContain('{monthWeeks.map((week) => (');
    expect(source).not.toContain('{settlementPeriodOrder.map((period) => {');
  });
});
