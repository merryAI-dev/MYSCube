import { hasMultiYearProjectContract, projectEffectivePaymentPlan } from './project-input-policy.mjs';
import type { ProjectTeamMemberAssignment, ProjectRequestPayload } from '../data/types';

export function submissionAmount(value: unknown, currency = 'KRW', explicit?: boolean): string {
  if (explicit === false || typeof value !== 'number' || !Number.isFinite(value)) return '미입력';
  return `${value.toLocaleString('ko-KR')}${currency === 'USD' ? ' USD' : '원'}`;
}

export function submissionRate(revenue: unknown, contract: unknown, flags?: { totalRevenueAmount?: boolean; contractAmount?: boolean }): string {
  if (flags?.totalRevenueAmount === false || flags?.contractAmount === false) return '계산 불가';
  return typeof revenue === 'number' && Number.isFinite(revenue)
    && typeof contract === 'number' && Number.isFinite(contract) && contract > 0
    ? `${(revenue / contract * 100).toFixed(2)}%` : '계산 불가';
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

export function submissionPaymentPlan(project: Partial<Pick<ProjectRequestPayload, 'contractStart' | 'contractEnd' | 'contractEndUndecided' | 'paymentPlan'>> & { financialYears?: Array<{ paymentPlan?: ProjectRequestPayload['paymentPlan'] }> } | null | undefined) {
  const rows = project?.financialYears || [];
  const hasAnnualPlan = rows.some((row: { paymentPlan?: unknown }) => row.paymentPlan != null);
  const legacy = hasMultiYearProjectContract(project || {}) && !hasAnnualPlan && project?.paymentPlan != null;
  if (hasMultiYearProjectContract(project || {}) && !legacy && rows.length > 0) {
    const total = (field: 'contract' | 'interim' | 'final') => {
      const values = rows.map((row) => row.paymentPlan?.[field]);
      return values.every((value) => typeof value === 'number' && Number.isFinite(value))
        ? values.reduce<number>((sum, value) => sum + (value as number), 0) : undefined;
    };
    return { plan: { contract: total('contract'), interim: total('interim'), final: total('final') }, legacy };
  }
  return { plan: legacy ? project.paymentPlan : projectEffectivePaymentPlan(project), legacy };
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
  const plan = submissionPaymentPlan(project).plan;
  const amount = (project as { contractAmount?: number } | null)?.contractAmount;
  if (!plan || typeof amount !== 'number' || amount <= 0 || !Number.isFinite(amount)
    || typeof plan.contract !== 'number' || typeof plan.interim !== 'number') return '계산 불가';
  return `${((plan.contract + plan.interim) / amount * 100).toFixed(1)}%`;
}

export function submissionContractWarning(project: Partial<Pick<ProjectRequestPayload, 'contractAmount' | 'salesVatAmount' | 'totalRevenueAmount' | 'totalActualCost' | 'supportAmount' | 'currency' | 'financialInputFlags'>> | null | undefined): string {
  const fields = [
    ['contractAmount', '계약금액'], ['salesVatAmount', '매출부가세'],
    ['totalRevenueAmount', '수익'], ['totalActualCost', '실비(원가)'], ['supportAmount', '지원금'],
  ] as const;
  const missing = fields.filter(([key]) => project?.financialInputFlags?.[key] === false
    || typeof project?.[key] !== 'number' || !Number.isFinite(project[key])).map(([, label]) => label);
  if (missing.length) {
    const knownItems = fields.slice(1).filter(([key]) => project?.financialInputFlags?.[key] !== false
      && typeof project?.[key] === 'number' && Number.isFinite(project[key]));
    const subtotal = knownItems.reduce((sum, [key]) => sum + (project![key] as number), 0);
    const amounts = `계약금액 ${submissionAmount(project?.contractAmount, project?.currency, project?.financialInputFlags?.contractAmount)} · 입력된 항목 소계 ${knownItems.length ? submissionAmount(subtotal, project?.currency) : '미입력'}. `;
    return `${amounts}금액 대조에 필요한 ${missing.join('·')} 금액이 미입력입니다. 작성자와 계약금액 및 항목별 금액을 확인해 주세요.`;
  }
  const amount = project!.contractAmount!;
  const sum = project!.salesVatAmount! + project!.totalRevenueAmount! + project!.totalActualCost! + project!.supportAmount!;
  if (Math.abs(amount - sum) < 0.000001) return '';
  return `계약금액 ${submissionAmount(amount, project?.currency)}과 항목 합계 ${submissionAmount(sum, project?.currency)}이 다릅니다. 작성자와 계약금액 및 매출부가세·수익·실비(원가)·지원금을 확인해 주세요.`;
}
