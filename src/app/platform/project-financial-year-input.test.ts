import { describe, expect, it } from 'vitest';
import type { ProjectFinancialYear } from '../data/types';
import { CONTRACT_AMOUNT_ITEM_FIELDS, formatProjectAmountInput } from './project-contract-amount';
import { aggregateProjectFinancialInputFlags, updateProjectFinancialYearAmount } from './project-financial-year-input';

const blankYear = (year = 2026): ProjectFinancialYear => ({
  year,
  contractAmount: 0,
  salesVatAmount: 0,
  totalRevenueAmount: 0,
  totalActualCost: 0,
  supportAmount: 0,
  profitRate: 0,
  confirmed: false,
});

describe('annual project finance input completeness', () => {
  it('does not mark missing components complete when one amount is entered', () => {
    const row = updateProjectFinancialYearAmount(blankYear(), 'totalRevenueAmount', '48,000,000', true);
    expect(row.contractAmount).toBe(48_000_000);
    expect(row.inputFlags).toEqual({
      contractAmount: false, salesVatAmount: false, totalRevenueAmount: true,
      totalActualCost: false, supportAmount: false,
    });
    expect(formatProjectAmountInput(row.totalActualCost, row.inputFlags?.totalActualCost === true)).toBe('');
  });

  it('accepts explicitly typed zero and preserves its distinction from empty after serialization', () => {
    const explicitZero = updateProjectFinancialYearAmount(blankYear(), 'totalActualCost', '0', true);
    const restored = JSON.parse(JSON.stringify(explicitZero));
    expect(formatProjectAmountInput(restored.totalActualCost, restored.inputFlags.totalActualCost)).toBe('0');
    const cleared = updateProjectFinancialYearAmount(restored, 'totalActualCost', '', true);
    expect(cleared.totalActualCost).toBe(0);
    expect(cleared.inputFlags?.totalActualCost).toBe(false);
    expect(formatProjectAmountInput(cleared.totalActualCost, cleared.inputFlags?.totalActualCost === true)).toBe('');
  });

  it('requires all four components before the derived contract is complete and reverses when cleared', () => {
    const completed = CONTRACT_AMOUNT_ITEM_FIELDS.reduce(
      (row, field) => updateProjectFinancialYearAmount(row, field, field === 'totalRevenueAmount' ? '100' : '0', true),
      blankYear(),
    );
    expect(completed.inputFlags?.contractAmount).toBe(true);
    expect(completed.contractAmount).toBe(100);
    const cleared = updateProjectFinancialYearAmount(completed, 'supportAmount', ' ', true);
    expect(cleared.inputFlags?.contractAmount).toBe(false);
    expect(cleared.inputFlags?.salesVatAmount).toBe(true);
    expect(cleared.inputFlags?.totalRevenueAmount).toBe(true);
  });

  it('requires a field in every year, including explicit zero years', () => {
    const entered = updateProjectFinancialYearAmount(blankYear(), 'totalActualCost', '50', false);
    const missing = blankYear(2027);
    expect(aggregateProjectFinancialInputFlags([entered, missing]).totalActualCost).toBe(false);
    const zero = updateProjectFinancialYearAmount(missing, 'totalActualCost', '0', false);
    expect(aggregateProjectFinancialInputFlags([entered, zero]).totalActualCost).toBe(true);
    expect(aggregateProjectFinancialInputFlags([entered, zero]).salesVatAmount).toBe(false);
  });

  it('keeps an independently entered multi-year contract and unrelated row data', () => {
    const row = { ...blankYear(), contractAmount: 120, inputFlags: { contractAmount: true }, isSettled: true, paymentPlan: { contract: 100, interim: 0, final: 20 } };
    const edited = updateProjectFinancialYearAmount(row, 'totalRevenueAmount', '48', false);
    expect(edited.contractAmount).toBe(120);
    expect(edited.inputFlags?.contractAmount).toBe(true);
    expect(edited.isSettled).toBe(true);
    expect(edited.paymentPlan).toEqual(row.paymentPlan);
    expect(row).not.toHaveProperty('inputFlags.totalRevenueAmount');
  });

  it('does not infer completion from an empty list or zero values in legacy rows', () => {
    expect(Object.values(aggregateProjectFinancialInputFlags([]))).not.toContain(true);
    expect(Object.values(aggregateProjectFinancialInputFlags([blankYear()]))).not.toContain(true);
  });
});
