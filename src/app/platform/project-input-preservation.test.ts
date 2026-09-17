import { describe, expect, it } from 'vitest';
import { createProjectEditorDraft, buildProjectRequestPayloadFromDraft, preservePaymentPlanOnContractExpansion } from './project-editor';
import { parseProjectAmountEntry } from './project-contract-amount';
import { projectContractEndYear } from './project-input-policy.mjs';

const fixture = () => createProjectEditorDraft({
  registrationRequirementsVersion: 2, contractStart: '2025-01-01', contractEnd: '2026-12-31',
  contractAmount: 300, totalRevenueAmount: 150,
  financialYears: [2025, 2026].map((year, i) => ({
    year, contractAmount: 100 * (i + 1), salesVatAmount: 0, totalRevenueAmount: 50 * (i + 1),
    totalActualCost: 0, supportAmount: 0, profitRate: 0.5, confirmed: true,
    paymentPlan: { contract: 100 * (i + 1), interim: 0, final: 0 },
    paymentExpectedMonths: { contract: `${year}-07`, interim: '', final: '' },
    advanceInterimBelow70Reason: '기존 사유', isSettled: true,
  })),
});

describe('project financial input preservation', () => {
  it('preserves annual allocations through an incomplete date, persisted read, and restored date', () => {
    const initial = fixture();
    const cleared = createProjectEditorDraft({ ...initial, contractEnd: '' });
    const persisted = buildProjectRequestPayloadFromDraft(cleared);
    const reopened = createProjectEditorDraft(persisted as unknown as typeof initial);
    const restored = createProjectEditorDraft({ ...reopened, contractEnd: initial.contractEnd });
    expect(restored.financialYears).toEqual(initial.financialYears);
  });
  it('retains out-of-range years until explicitly removed and does not duplicate totals into added years', () => {
    const initial = fixture();
    const shortened = createProjectEditorDraft({ ...initial, contractEnd: '2025-12-31' });
    expect(shortened.financialYears).toEqual(initial.financialYears);
    const extended = createProjectEditorDraft({ ...initial, contractStart: '2024-01-01' });
    expect(extended.financialYears[0].contractAmount).toBe(0);
    expect(extended.financialYears.slice(1)).toEqual(initial.financialYears);
    expect(extended.financialYears.reduce((sum, row) => sum + row.contractAmount, 0)).toBe(300);
  });
  it('creates the future start year for an undecided end using the shared end-year rule', () => {
    const startYear = new Date().getFullYear() + 1;
    const initial = createProjectEditorDraft({ registrationRequirementsVersion: 2, contractStart: `${startYear}-01-01`, contractEnd: '', contractEndUndecided: true });
    expect(projectContractEndYear(initial)).toBe(startYear);
    expect(initial.financialYears.map(row => row.year)).toEqual([startYear]);
  });
  it('moves the active single-year payment plan only to its original year when expanding', () => {
    const initial = createProjectEditorDraft({
      ...fixture(), contractEnd: '2025-12-31', financialYears: fixture().financialYears.slice(0, 1),
      paymentPlan: { contract: 75, interim: 0, final: 25 },
      paymentExpectedMonths: { contract: '2025-03', interim: '', final: '2025-10' },
      advanceInterimBelow70Reason: '입금 사유',
    });
    const next = preservePaymentPlanOnContractExpansion(initial, createProjectEditorDraft({ ...initial, contractEnd: '2026-12-31' }));
    expect(next.financialYears[0]).toMatchObject({ paymentPlan: initial.paymentPlan, paymentExpectedMonths: initial.paymentExpectedMonths, advanceInterimBelow70Reason: initial.advanceInterimBelow70Reason });
    expect(next.financialYears[1].paymentPlan).toEqual({ contract: 0, interim: 0, final: 0 });
    expect(preservePaymentPlanOnContractExpansion(fixture(), fixture()).financialYears).toEqual(fixture().financialYears);
  });
  it.each([['１２，３４５', 12345], ['12,345원', 12345], ['０', 0], ['', 0], ['원', null], ['123abc', null], ['-100', null], ['12.5', null], ['9007199254740992', null]])('parses %s without converting invalid input into zero', (input, result) => {
    expect(parseProjectAmountEntry(String(input))).toBe(result);
  });
});
