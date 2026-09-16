import { describe, expect, it } from 'vitest';
import { hasMultiYearProjectContract, projectPaymentIssues, projectParticipationPeriodWarnings } from './project-input-policy.mjs';

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
