import { describe, expect, it } from 'vitest';
import {
  hasMultiYearProjectContract,
  projectFinancialYearsWithPaymentPlan,
  projectPaymentIssues,
  projectParticipationPeriodWarnings,
} from './project-input-policy.mjs';

const annual = {
  contractStart: '2025-06-18', contractEnd: '2029-12-31',
  paymentPlan: { contract: 490, interim: 0, final: 210 },
  paymentExpectedMonths: { contract: '', interim: '', final: '' },
  contractAmount: 3500,
  financialYears: [2025, 2026, 2027, 2028, 2029].map((year) => ({
    year, contractAmount: 700, paymentPlan: { contract: 490, interim: 0, final: 210 },
    paymentExpectedMonths: { contract: `${year}-06`, interim: '', final: `${year}-11` },
  })),
};

describe('project input field ownership', () => {
  it('accepts the multi-year incident shape without synthesizing top-level months', () => {
    const before = structuredClone(annual);
    expect(projectPaymentIssues(annual)).toEqual([]);
    expect(annual).toEqual(before);
  });
  it('identifies the exact missing annual month and ignores inactive top-level fields', () => {
    const changed = structuredClone(annual);
    changed.financialYears[2].paymentExpectedMonths.contract = '';
    expect(projectPaymentIssues(changed)).toEqual([expect.objectContaining({ field: 'financialYears.2027.paymentExpectedMonths.contract' })]);
  });
  it('requires the annual below-70-percent reason even when the top-level reason is filled', () => {
    const changed = structuredClone(annual);
    changed.financialYears[0].paymentPlan.contract = 100;
    expect(projectPaymentIssues({ ...changed, advanceInterimBelow70Reason: '전체 사유' })).toContainEqual(
      expect.objectContaining({ field: 'financialYears.2025.advanceInterimBelow70Reason' }),
    );
  });
  it('uses top-level payment fields for a single year and accepts no payment or exact 70 percent', () => {
    const single = { ...annual, contractEnd: '2025-12-31', contractAmount: 700 };
    expect(projectPaymentIssues(single).map((issue) => issue.field)).toEqual(['paymentExpectedMonths.contract', 'paymentExpectedMonths.final']);
    expect(projectPaymentIssues({ ...single, paymentPlan: {} })).toEqual([]);
    expect(projectPaymentIssues({ ...single, paymentExpectedMonths: annual.financialYears[0].paymentExpectedMonths })).toEqual([]);
  });
  it('mirrors the single-year payment plan into its annual row without mutating the source', () => {
    const single = {
      contractStart: '2026-06-04', contractEnd: '2026-12-31',
      paymentPlan: { contract: 313_432_000, interim: 89_552_000, final: 44_776_000 },
      paymentExpectedMonths: { contract: '2026-08', interim: '2026-12', final: '2027-01' },
      advanceInterimBelow70Reason: '',
      financialYears: [{ year: 2026, contractAmount: 447_760_000, paymentPlan: { contract: 0, interim: 0, final: 0 },
        paymentExpectedMonths: { contract: '', interim: '', final: '' } }],
    };
    const before = structuredClone(single);
    expect(projectFinancialYearsWithPaymentPlan(single)).toEqual([expect.objectContaining({
      year: 2026,
      contractAmount: 447_760_000,
      paymentPlan: single.paymentPlan,
      paymentExpectedMonths: single.paymentExpectedMonths,
    })]);
    expect(single).toEqual(before);
  });
  it('leaves multi-year annual payment plans and projects without a top-level plan as they are', () => {
    expect(projectFinancialYearsWithPaymentPlan(annual)).toBe(annual.financialYears);
    const noPlan = { contractStart: '2026-01-01', contractEnd: '2026-12-31', financialYears: annual.financialYears.slice(0, 1) };
    expect(projectFinancialYearsWithPaymentPlan(noPlan)).toBe(noPlan.financialYears);
    expect(projectFinancialYearsWithPaymentPlan(undefined)).toEqual([]);
    // 종료일을 고치는 중인 다년도 사업은 단년도로 보지 않는다.
    const editingEnd = { ...annual, contractEnd: '' };
    expect(projectFinancialYearsWithPaymentPlan(editingEnd)).toBe(editingEnd.financialYears);
  });
  it('handles an open-ended contract using the same year boundary', () => {
    expect(hasMultiYearProjectContract({ contractStart: '2025-01-01', contractEndUndecided: true }, 2026)).toBe(true);
    expect(hasMultiYearProjectContract({ contractStart: '2026-01-01', contractEndUndecided: true }, 2026)).toBe(false);
  });
  it('warns for a restored out-of-contract stint without changing its months, nulls or zeros', () => {
    const project = { contractStart: '2026-05-14', contractEnd: '2026-11-30', teamMembersDetailed: [{
      memberName: '참여자', laborAllocationStartMonth: '2026-04', laborAllocationEndMonth: '2026-11',
      monthlyRates: { '2026-04': 20, '2026-05': null, '2026-06': 0 },
    }] };
    const before = structuredClone(project);
    expect(projectParticipationPeriodWarnings(project)[0].message).toContain('참여자');
    expect(projectParticipationPeriodWarnings(project)[0].message).toContain('2026-04');
    expect(project).toEqual(before);
  });
});
