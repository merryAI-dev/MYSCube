import type { ProjectFinancialInputFlags, ProjectFinancialYear } from '../data/types';
import {
  CONTRACT_AMOUNT_ITEM_FIELDS,
  deriveContractAmountFromItems,
  hasExplicitProjectAmountInput,
  normalizeProjectFinancialInputFlags,
  parseProjectAmountInput,
} from './project-contract-amount';

type FinancialInputRow = ProjectFinancialYear & { inputFlags?: ProjectFinancialInputFlags };
type FinancialAmountField = keyof ProjectFinancialInputFlags;

export function updateProjectFinancialYearAmount(
  row: FinancialInputRow,
  field: FinancialAmountField,
  rawValue: string,
  deriveContract: boolean,
): FinancialInputRow {
  const inputFlags = {
    ...normalizeProjectFinancialInputFlags(row.inputFlags),
    [field]: hasExplicitProjectAmountInput(rawValue),
  };
  const next = { ...row, [field]: parseProjectAmountInput(rawValue), inputFlags };
  if (deriveContract && CONTRACT_AMOUNT_ITEM_FIELDS.some((item) => item === field)) {
    inputFlags.contractAmount = CONTRACT_AMOUNT_ITEM_FIELDS.every((item) => inputFlags[item] === true);
    if (inputFlags.contractAmount) next.contractAmount = deriveContractAmountFromItems(next);
  }
  return next;
}

export function aggregateProjectFinancialInputFlags(rows: FinancialInputRow[]): Required<ProjectFinancialInputFlags> {
  const enteredInEveryYear = (field: FinancialAmountField) => (
    rows.length > 0 && rows.every((row) => row.inputFlags?.[field] === true)
  );
  return {
    contractAmount: enteredInEveryYear('contractAmount'),
    salesVatAmount: enteredInEveryYear('salesVatAmount'),
    totalRevenueAmount: enteredInEveryYear('totalRevenueAmount'),
    totalActualCost: enteredInEveryYear('totalActualCost'),
    supportAmount: enteredInEveryYear('supportAmount'),
  };
}
