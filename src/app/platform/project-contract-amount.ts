import type { Project, ProjectFinancialInputFlags } from '../data/types';

export const EMPTY_PROJECT_FINANCIAL_INPUT_FLAGS: Required<ProjectFinancialInputFlags> = {
  contractAmount: false,
  salesVatAmount: false,
  totalRevenueAmount: false,
  totalActualCost: false,
  supportAmount: false,
};

function normalizeAmountInput(value: string): string {
  return String(value || '').replace(/,/g, '').trim();
}

export function createEmptyProjectFinancialInputFlags(): ProjectFinancialInputFlags {
  return { ...EMPTY_PROJECT_FINANCIAL_INPUT_FLAGS };
}

export function normalizeProjectFinancialInputFlags(
  value: ProjectFinancialInputFlags | null | undefined,
): Required<ProjectFinancialInputFlags> {
  return {
    ...EMPTY_PROJECT_FINANCIAL_INPUT_FLAGS,
    ...(value || {}),
  };
}

export function normalizeProjectFinancialInputFlagsForAmounts(
  value: ProjectFinancialInputFlags | null | undefined,
  amounts: {
    contractAmount?: number | null;
    salesVatAmount?: number | null;
    totalRevenueAmount?: number | null;
    totalActualCost?: number | null;
    supportAmount?: number | null;
  },
): Required<ProjectFinancialInputFlags> {
  const normalized = normalizeProjectFinancialInputFlags(value);
  return {
    contractAmount: normalized.contractAmount || Number(amounts.contractAmount || 0) > 0,
    salesVatAmount: normalized.salesVatAmount || Number(amounts.salesVatAmount || 0) > 0,
    totalRevenueAmount: normalized.totalRevenueAmount || Number(amounts.totalRevenueAmount || 0) > 0,
    totalActualCost: normalized.totalActualCost || Number(amounts.totalActualCost || 0) > 0,
    supportAmount: normalized.supportAmount || Number(amounts.supportAmount || 0) > 0,
  };
}

export function parseProjectAmountInput(value: string): number {
  const normalized = normalizeAmountInput(value);
  if (!normalized) return 0;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function hasExplicitProjectAmountInput(value: string): boolean {
  const normalized = normalizeAmountInput(value);
  if (!normalized) return false;

  return Number.isFinite(Number(normalized));
}

export function hasNonNegativeProjectAmountInput(value: string): boolean {
  return hasExplicitProjectAmountInput(value) && parseProjectAmountInput(value) >= 0;
}

export function formatProjectAmountInput(value: number, hasExplicitValue: boolean): string {
  if (!hasExplicitValue || !Number.isFinite(value)) return '';
  return value.toLocaleString('ko-KR');
}

export function hasStoredProjectAmount(value: unknown, hasExplicitValue?: boolean): boolean {
  if (hasExplicitValue === false) return false;
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatStoredProjectAmount(value: unknown, hasExplicitValue?: boolean): string {
  return hasStoredProjectAmount(value, hasExplicitValue)
    ? `${Number(value).toLocaleString('ko-KR')}원`
    : '-';
}

export function hasStoredProjectContractAmount(project: Partial<Project>): boolean {
  return hasStoredProjectAmount(
    project.contractAmount,
    project.financialInputFlags?.contractAmount,
  );
}

/** 계약금액을 이루는 네 항목. 단년도에서 계약금액은 이 넷의 합이다. */
export const CONTRACT_AMOUNT_ITEM_FIELDS = [
  'salesVatAmount',
  'totalRevenueAmount',
  'totalActualCost',
  'supportAmount',
] as const;

export type ContractAmountItemField = typeof CONTRACT_AMOUNT_ITEM_FIELDS[number];

/**
 * 단년도 계약금액을 항목 합계로 계산한다.
 *
 * 연도가 하나뿐이면 "총 계약금액"과 "그 해의 계약금액"이 같은 값이라 사람이 둘을 따로
 * 넣을 이유가 없다. 다년도는 연도마다 계약금액이 따로 있으므로 이 함수를 쓰지 않는다.
 *
 * 이 계산은 사람이 금액을 고칠 때만 부른다. 불러오기만으로 저장된 값을 덮어쓰면
 * 항목이 덜 채워진 기존 사업의 계약금액이 조용히 줄어든다.
 */
export function deriveContractAmountFromItems(
  items: Partial<Record<ContractAmountItemField, number>>,
): number {
  return CONTRACT_AMOUNT_ITEM_FIELDS.reduce((sum, field) => {
    const value = Number(items[field]);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}


export function parseProjectAmountEntry(value: string): number | null {
  const normalized = value.normalize('NFKC').trim().replace(/\s*원$/, '').replace(/,/g, '').trim();
  if (!normalized) return value.trim() ? null : 0;
  if (!/^\d+$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isSafeInteger(amount) ? amount : null;
}
