import { hasMultiYearProjectContract, projectEffectivePaymentPlan, projectFinancialYearsWithPaymentPlan, projectContractEndYear } from './project-input-policy.mjs';
import type { ProjectTeamMemberAssignment, ProjectRequestPayload, ProjectFinancialYear } from '../data/types';

export function submissionAmountKnown(value: unknown, explicit?: boolean): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= 0
    && explicit !== false && (explicit === true || value !== 0);
}

export function submissionAmount(value: unknown, currency = 'KRW', explicit?: boolean): string {
  const money = typeof value === 'number' && Number.isFinite(value)
    ? `${value.toLocaleString('ko-KR')}${currency === 'USD' ? ' USD' : '원'}` : null;
  if (typeof value === 'number' && value < 0 && money) return `금액 확인 필요 (저장값 ${money})`;
  if (explicit === false) return money && value !== 0 ? `미확인 (저장값 ${money})` : '미입력';
  if (!submissionAmountKnown(value, explicit)) return '입력 기록 없음';
  return money!;
}

export function submissionAmountTotal(
  entries: Array<{ value: unknown; explicit?: boolean }>, currency = 'KRW',
): string {
  const confirmed = entries.filter((entry) => submissionAmountKnown(entry.value, entry.explicit));
  const subtotal = confirmed.reduce((sum, entry) => sum + (entry.value as number), 0);
  if (entries.length && confirmed.length === entries.length) return submissionAmount(subtotal, currency, true);
  return confirmed.length ? `합계 미완료 (확인된 소계 ${submissionAmount(subtotal, currency, true)})` : '합계 미완료 · 입력 확인 필요';
}

export function submissionRate(revenue: unknown, contract: unknown, flags?: { totalRevenueAmount?: boolean; contractAmount?: boolean }): string {
  return submissionAmountKnown(revenue, flags?.totalRevenueAmount)
    && submissionAmountKnown(contract, flags?.contractAmount) && contract > 0
    ? `${(revenue / contract * 100).toFixed(2)}%` : '계산 불가';
}

const ANNUAL_FINANCIAL_LABELS = [
  ['contractAmount', '계약금액'], ['salesVatAmount', '매출 부가세'], ['totalRevenueAmount', '수익'],
  ['totalActualCost', '실비(원가)'], ['supportAmount', '지원금'],
] as const;

type FinancialPeriod = Partial<Pick<ProjectRequestPayload, 'contractStart' | 'contractEnd' | 'contractEndUndecided'>>;

function missingAnnualYears(rows: ProjectFinancialYear[], period?: FinancialPeriod): number[] {
  if (!period) return [];
  const start = Number(String(period.contractStart || '').slice(0, 4));
  const end = projectContractEndYear(period);
  if (!Number.isSafeInteger(start) || start < 2000 || !Number.isSafeInteger(end) || end < start || end - start > 100) return [];
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset).filter((year) => !rows.some((row) => row.year === year));
}

export function submissionAnnualFinancialNeeds(rows: ProjectFinancialYear[] | undefined, period?: FinancialPeriod) {
  const savedRows = rows || [];
  const requiredRows = [...savedRows, ...missingAnnualYears(savedRows, period).map((year) => ({ year } as ProjectFinancialYear))];
  return requiredRows.sort((a, b) => a.year - b.year).flatMap((row) => {
    const fields = ANNUAL_FINANCIAL_LABELS.filter(([field]) => !submissionAmountKnown(row[field], row.inputFlags?.[field]));
    return fields.length ? [{
      year: row.year,
      fields: fields.map(([field]) => field),
      message: `${row.year}년 ${fields.map(([, label]) => label).join(', ')} 입력 확인이 필요합니다. 해당 금액이 없으면 0원을 직접 입력해 주세요.`,
    }] : [];
  });
}

export function submissionAnnualRate(rows: ProjectFinancialYear[] | undefined, period?: FinancialPeriod): string {
  if (!rows?.length || missingAnnualYears(rows, period).length || rows.some((row) => !submissionAmountKnown(row.contractAmount, row.inputFlags?.contractAmount)
    || !submissionAmountKnown(row.totalRevenueAmount, row.inputFlags?.totalRevenueAmount))) return '계산 불가 · 연도별 계약금액·수익 확인 필요';
  const contract = rows.reduce((sum, row) => sum + row.contractAmount, 0);
  const revenue = rows.reduce((sum, row) => sum + row.totalRevenueAmount, 0);
  return submissionRate(revenue, contract, { contractAmount: true, totalRevenueAmount: true });
}

export function submissionConfirmation(value: unknown, yes = '확인', no = '미확인'): string {
  return value === true ? yes : value === false ? no : '기록 없음';
}

export function submittedParticipationLines(members?: ProjectTeamMemberAssignment[]): string[] {
  return (members || []).map((member) => {
    const name = [member.memberName, member.memberNickname && `(${member.memberNickname})`].filter(Boolean).join(' ') || '이름 미입력';
    const period = `${member.laborAllocationStartMonth || '미입력'} ~ ${member.laborAllocationEndMonth || '미입력'}`;
    const months = member.monthlyRates == null ? '월별 참여율 기록 없음'
      : Object.entries(member.monthlyRates).sort(([a], [b]) => a.localeCompare(b))
        .map(([month, rate]) => `${month}: ${rate == null ? '미입력' : `${rate}%`}`).join(' · ') || '월별 참여율 없음';
    return `${name} / ${member.role || '역할 미입력'} / 기준 참여율 ${member.participationRate == null ? '미입력' : `${member.participationRate}%`} / 참여기간 ${period}${member.isDocumentOnly ? ' / 서류상 참여' : ''}\n${months}`;
  });
}

type ProjectPaymentPlanInputFlags = Partial<Record<'contract' | 'interim' | 'final', boolean>>;

type PaymentDisplaySource = Partial<Pick<ProjectRequestPayload, 'contractStart' | 'contractEnd' | 'contractEndUndecided' | 'contractAmount' | 'financialInputFlags' | 'paymentPlan' | 'paymentPlanInputFlags'>> & {
  financialYears?: Array<{ paymentPlan?: ProjectRequestPayload['paymentPlan']; paymentPlanInputFlags?: ProjectPaymentPlanInputFlags }>;
};

export function submissionPaymentPlan(project: PaymentDisplaySource | null | undefined) {
  const rows = project?.financialYears || [];
  const hasAnnualPlan = rows.some((row) => row.paymentPlan != null);
  const legacy = hasMultiYearProjectContract(project || {}) && !hasAnnualPlan && project?.paymentPlan != null;
  if (hasMultiYearProjectContract(project || {}) && !legacy && rows.length > 0) {
    const total = (field: 'contract' | 'interim' | 'final') => (
      rows.every((row) => submissionAmountKnown(row.paymentPlan?.[field], row.paymentPlanInputFlags?.[field]))
        ? rows.reduce((sum, row) => sum + row.paymentPlan![field], 0) : undefined
    );
    const plan = { contract: total('contract'), interim: total('interim'), final: total('final') };
    return { plan, legacy, inputFlags: { contract: plan.contract !== undefined, interim: plan.interim !== undefined, final: plan.final !== undefined } };
  }
  return { plan: legacy ? project.paymentPlan : projectEffectivePaymentPlan(project), legacy, inputFlags: project?.paymentPlanInputFlags };
}

type FinancialYearDisplaySource = Partial<Pick<ProjectRequestPayload, 'financialYears' | 'contractStart' | 'contractEnd' | 'contractEndUndecided' | 'financialInputFlags' | 'paymentPlan' | 'paymentPlanInputFlags' | 'paymentExpectedMonths' | 'advanceInterimBelow70Reason'>>;

export function submissionFinancialYears(project: FinancialYearDisplaySource | null | undefined): ProjectFinancialYear[] {
  const rows = projectFinancialYearsWithPaymentPlan(project) as ProjectFinancialYear[];
  const start = String(project?.contractStart || '');
  const end = String(project?.contractEnd || '');
  const singleYear = /^\d{4}-\d{2}-\d{2}$/.test(start)
    && (project?.contractEndUndecided || /^\d{4}-\d{2}-\d{2}$/.test(end))
    && !hasMultiYearProjectContract(project || {}) && rows.length === 1
    && rows[0].year === Number(start.slice(0, 4));
  if (!singleYear) return rows;
  return rows.map((row) => ({
    ...row,
    paymentPlanInputFlags: project?.paymentPlan ? project.paymentPlanInputFlags : row.paymentPlanInputFlags,
  }));
}

export function submittedConfirmationLines(value?: ProjectRequestPayload['registrationConfirmations']): string {
  return ([
    ['laborIncludesFourInsurance', '인건비 4대보험 포함'],
    ['laborIncludesRetirementPay', '인건비 퇴직금 포함'],
    ['customerSettlementBasisConfirmed', '고객사 정산 기준 확인'],
    ['modusignContractUsed', '모두싸인 사용'],
    ['originalContractSubmitted', '계약서 원본 제출'],
  ] as const).map(([key, label]) => `${label}: ${submissionConfirmation(value?.[key], '예', '아니오')}`).join('\n');
}

export function submissionAdvanceRatio(project: Parameters<typeof submissionPaymentPlan>[0]): string {
  const { plan, inputFlags } = submissionPaymentPlan(project);
  const amount = (project as { contractAmount?: number } | null)?.contractAmount;
  if (!plan || typeof amount !== 'number' || amount <= 0 || !Number.isFinite(amount)
    || !submissionAmountKnown(plan.contract, inputFlags?.contract)
    || !submissionAmountKnown(plan.interim, inputFlags?.interim)
    || !submissionAmountKnown(amount, project?.financialInputFlags?.contractAmount)) return '계산 불가';
  return `${((plan.contract + plan.interim) / amount * 100).toFixed(1)}%`;
}

export function submissionContractWarning(project: Partial<Pick<ProjectRequestPayload, 'contractAmount' | 'salesVatAmount' | 'totalRevenueAmount' | 'totalActualCost' | 'supportAmount' | 'currency' | 'financialInputFlags'>> | null | undefined): string {
  const fields = [
    ['contractAmount', '계약금액'], ['salesVatAmount', '매출부가세'],
    ['totalRevenueAmount', '수익'], ['totalActualCost', '실비(원가)'], ['supportAmount', '지원금'],
  ] as const;
  const missing = fields.filter(([key]) => !submissionAmountKnown(project?.[key], project?.financialInputFlags?.[key])).map(([, label]) => label);
  if (missing.length) {
    const knownItems = fields.slice(1).filter(([key]) => submissionAmountKnown(project?.[key], project?.financialInputFlags?.[key]));
    const subtotal = knownItems.reduce((sum, [key]) => sum + (project![key] as number), 0);
    const amounts = `계약금액 ${submissionAmount(project?.contractAmount, project?.currency, project?.financialInputFlags?.contractAmount)} · 입력된 항목 소계 ${knownItems.length ? submissionAmount(subtotal, project?.currency, true) : '미입력'}. `;
    return `${amounts}금액 대조에 필요한 ${missing.join('·')} 금액이 미입력이거나 입력 기록을 확인할 수 없습니다. 작성자와 계약금액 및 항목별 금액을 확인해 주세요.`;
  }
  const amount = project!.contractAmount!;
  const sum = project!.salesVatAmount! + project!.totalRevenueAmount! + project!.totalActualCost! + project!.supportAmount!;
  if (Math.abs(amount - sum) < 0.000001) return '';
  return `계약금액 ${submissionAmount(amount, project?.currency)}과 항목 합계 ${submissionAmount(sum, project?.currency)}이 다릅니다. 작성자와 계약금액 및 매출부가세·수익·실비(원가)·지원금을 확인해 주세요.`;
}
