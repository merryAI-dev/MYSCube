import { describe, expect, it } from 'vitest';
import { submissionContractWarning, submissionAmount, submissionAmountTotal, submissionFinancialYears, submissionRate, submissionConfirmation, submittedParticipationLines, submissionPaymentPlan } from './project-submission-display';
import { projectFinancialYearsWithPaymentPlan } from './project-input-policy.mjs';
import { createProjectEditorDraft } from './project-editor';
import { formatProjectAmountInput } from './project-contract-amount';

describe('submitted read projection', () => {
  it('does not certify partial totals or annual zero payments without input evidence', () => {
    expect(submissionAmountTotal([{ value: 0 }])).toBe('합계 미완료 · 입력 확인 필요');
    expect(submissionAmountTotal([{ value: 10 }, { value: 0 }])).toBe('합계 미완료 (확인된 소계 10원)');
    expect(submissionAmountTotal([{ value: 0, explicit: true }, { value: 0, explicit: true }])).toBe('0원');
    const source = { contractStart: '2025-01-01', contractEnd: '2026-12-31', financialYears: [
      { paymentPlan: { contract: 70, interim: 0, final: 30 }, paymentPlanInputFlags: { interim: true } },
      { paymentPlan: { contract: 70, interim: 0, final: 30 } },
    ] };
    expect(submissionPaymentPlan(source).plan).toEqual({ contract: 140, interim: undefined, final: 60 });
    expect(submissionPaymentPlan(source).inputFlags?.interim).toBe(false);
  });
  it('does not infer annual amount flags from project totals and projects payment flags with their matching source', () => {
    const source = { contractStart: '2026-01-01', contractEnd: '2026-12-31',
      financialInputFlags: { salesVatAmount: true, totalActualCost: false },
      paymentPlan: { contract: 70, interim: 0, final: 30 }, paymentPlanInputFlags: { interim: true },
      financialYears: [{ year: 2026, salesVatAmount: 0, totalActualCost: 0, inputFlags: { totalActualCost: true }, paymentPlanInputFlags: { interim: false } }],
    };
    const before = JSON.stringify(source);
    const row = submissionFinancialYears(source as Parameters<typeof submissionFinancialYears>[0])[0];
    expect(row.inputFlags).toEqual({ totalActualCost: true });
    expect(submissionAmount(row.salesVatAmount, 'KRW', row.inputFlags?.salesVatAmount)).toBe('입력 기록 없음');
    expect(row.paymentPlanInputFlags?.interim).toBe(true);
    expect(row.paymentPlan?.interim).toBe(0);
    expect(JSON.stringify(source)).toBe(before);
  });
  it('matches actual editor hydration when a total is explicit but a legacy annual zero is not', () => {
    const source = { contractStart: '2026-01-01', contractEnd: '2026-12-31', salesVatAmount: 0,
      financialInputFlags: { salesVatAmount: true }, financialYears: [{ year: 2026, contractAmount: 100,
        salesVatAmount: 0, totalRevenueAmount: 100, totalActualCost: 0, supportAmount: 0, profitRate: 1, confirmed: false }],
    };
    const draft = createProjectEditorDraft(source);
    const editorRow = draft.financialYears[0];
    const approvalRow = submissionFinancialYears(source)[0];
    expect(formatProjectAmountInput(editorRow.salesVatAmount, editorRow.inputFlags?.salesVatAmount === true)).toBe('');
    expect(submissionAmount(approvalRow.salesVatAmount, 'KRW', approvalRow.inputFlags?.salesVatAmount)).toBe('입력 기록 없음');
    expect(approvalRow.inputFlags?.salesVatAmount).toBeUndefined();
    expect(source.financialYears[0].salesVatAmount).toBe(0);
  });
  it('preserves missing, explicit zero, currency and unknown confirmation', () => {
    expect(submissionAmount(null)).toBe('입력 기록 없음');
    expect(submissionAmount(0)).toBe('입력 기록 없음');
    expect(submissionAmount(0, 'KRW', true)).toBe('0원');
    expect(submissionAmount(100, 'KRW', false)).toBe('미확인 (저장값 100원)');
    expect(submissionAmount(0, 'KRW', false)).toBe('미입력');
    expect(submissionAmount(12.5, 'USD')).toBe('12.5 USD');
    expect(submissionRate(0, 100)).toBe('계산 불가');
    expect(submissionRate(0, 100, { totalRevenueAmount: true })).toBe('0.00%');
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
    expect(submissionPaymentPlan(project)).toEqual({ plan: project.paymentPlan, legacy: true, inputFlags: undefined });
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
  const source = { contractAmount: 120000000, salesVatAmount: 0, totalRevenueAmount: 48000000, totalActualCost: 0, supportAmount: 0, currency: 'KRW' as const, financialInputFlags: { contractAmount: true, salesVatAmount: true, totalRevenueAmount: true, totalActualCost: true, supportAmount: true } };
  const before = JSON.stringify(source);
  expect(submissionContractWarning(source)).toContain('120,000,000원과 항목 합계 48,000,000원');
  expect(submissionContractWarning({ ...source, currency: 'USD' })).toContain('120,000,000 USD');
  expect(submissionContractWarning({ ...source, totalActualCost: undefined })).toContain('실비(원가) 금액이 미입력');
  expect(submissionContractWarning({ ...source, financialInputFlags: { contractAmount: true, salesVatAmount: true, totalRevenueAmount: true, totalActualCost: false, supportAmount: false } })).toContain('계약금액 120,000,000원 · 입력된 항목 소계 48,000,000원');
  expect(submissionContractWarning({ ...source, totalActualCost: 72000000 })).toBe('');
  expect(JSON.stringify(source)).toBe(before);
});
