import { describe, expect, it } from 'vitest';
import { submissionContractWarning, submissionAmount, submissionRate, submissionConfirmation, submittedParticipationLines, submissionPaymentPlan } from './project-submission-display';
import { projectFinancialYearsWithPaymentPlan } from './project-input-policy.mjs';

describe('submitted read projection', () => {
  it('preserves missing, explicit zero, currency and unknown confirmation', () => {
    expect(submissionAmount(null)).toBe('미입력');
    expect(submissionAmount(0)).toBe('0원');
    expect(submissionAmount(0, 'KRW', false)).toBe('미입력');
    expect(submissionAmount(12.5, 'USD')).toBe('12.5 USD');
    expect(submissionRate(0, 100)).toBe('0.00%');
    expect(submissionRate(0, 100, { totalRevenueAmount: false })).toBe('계산 불가');
    expect(submissionRate(1, 0)).toBe('계산 불가');
    expect(submissionConfirmation(undefined)).toBe('기록 없음');
    expect(submissionConfirmation(false)).toBe('미확인');
  });
  it('displays submitted monthly null separately from zero without changing the source', () => {
    const members = [{ memberName: '담당', memberNickname: '', role: 'PM', participationRate: 0,
      monthlyRates: { '2026-02': 0, '2026-01': null }, laborAllocationStartMonth: '2026-01', laborAllocationEndMonth: '2026-02' }];
    const original = JSON.stringify(members);
    expect(submittedParticipationLines(members)[0]).toContain('2026-01: 미입력 · 2026-02: 0%');
    expect(JSON.stringify(members)).toBe(original);
  });
  it('retains legacy whole-period plans without allocating them to invented years', () => {
    const project = { contractStart: '2025-01-01', contractEnd: '2026-12-31', paymentPlan: { contract: 70, interim: 0, final: 30 }, financialYears: [{ year: 2025, paymentPlan: undefined }, { year: 2026, paymentPlan: undefined }] };
    expect(submissionPaymentPlan(project)).toEqual({ plan: project.paymentPlan, legacy: true });
    expect(projectFinancialYearsWithPaymentPlan(project)[0].paymentPlan).toBeUndefined();
  });
  it('does not convert a missing annual plan into a complete zero total', () => {
    const result = submissionPaymentPlan({ contractStart: '2025-01-01', contractEnd: '2026-12-31', financialYears: [{ paymentPlan: { contract: 70, interim: 0, final: 30 } }, {}] });
    expect(result.plan?.contract).toBeUndefined();
    expect(result.plan?.interim).toBeUndefined();
  });
  it('single year review mirrors whole-project payment without changing annual stored values', () => {
    const project = { contractStart: '2026-01-01', contractEnd: '2026-12-31', paymentPlan: { contract: 70, interim: 0, final: 30 }, financialYears: [{ year: 2026, paymentPlan: { contract: 0, interim: 0, final: 0 } }] };
    expect(projectFinancialYearsWithPaymentPlan(project)[0].paymentPlan.contract).toBe(70);
    expect(project.financialYears[0].paymentPlan.contract).toBe(0);
  });
});

it('warns about submitted mismatches without coercing missing fields or changing values', () => {
  const source = { contractAmount: 120000000, salesVatAmount: 0, totalRevenueAmount: 48000000, totalActualCost: 0, supportAmount: 0, currency: 'KRW' as const };
  const before = JSON.stringify(source);
  expect(submissionContractWarning(source)).toContain('120,000,000원과 항목 합계 48,000,000원');
  expect(submissionContractWarning({ ...source, currency: 'USD' })).toContain('120,000,000 USD');
  expect(submissionContractWarning({ ...source, totalActualCost: undefined })).toContain('실비(원가) 금액이 미입력');
  expect(submissionContractWarning({ ...source, financialInputFlags: { contractAmount: true, salesVatAmount: true, totalRevenueAmount: true, totalActualCost: false, supportAmount: false } })).toContain('계약금액 120,000,000원 · 입력된 항목 소계 48,000,000원');
  expect(submissionContractWarning({ ...source, totalActualCost: 72000000 })).toBe('');
  expect(JSON.stringify(source)).toBe(before);
});
