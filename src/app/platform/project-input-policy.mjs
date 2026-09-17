export function projectContractEndYear(project, currentYear = new Date().getFullYear()) {
  const startYear = Number(String(project.contractStart || '').slice(0, 4));
  return project.contractEndUndecided
    ? Math.max(startYear, currentYear)
    : Number(String(project.contractEnd || '').slice(0, 4));
}

const paymentFields = ['contract', 'interim', 'final'];
const paymentLabels = { contract: '선금/계약금', interim: '중도금', final: '잔금' };
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

export function hasMultiYearProjectContract(project, currentYear = new Date().getFullYear()) {
  const start = String(project.contractStart || '');
  const end = String(project.contractEnd || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(start) && (project.contractEndUndecided
    ? Number(start.slice(0, 4)) < currentYear
    : /^\d{4}-\d{2}-\d{2}$/.test(end) && start.slice(0, 4) !== end.slice(0, 4));
}

export function projectPaymentIssues(project) {
  const annual = hasMultiYearProjectContract(project);
  const sources = annual ? (Array.isArray(project.financialYears) ? project.financialYears : []) : [project];
  return sources.flatMap((source) => {
    const prefix = annual ? `financialYears.${source.year}.` : '';
    const label = annual ? `${source.year}년 ` : '';
    const plan = source.paymentPlan || {};
    const issues = [];
    for (const field of paymentFields) {
      if (Number(plan[field]) > 0 && !monthPattern.test(String(source.paymentExpectedMonths?.[field] || ''))) {
        issues.push({ field: `${prefix}paymentExpectedMonths.${field}`, step: 'financial',
          label: annual ? `${label}${paymentLabels[field]} 예상 입금 시점` : `${paymentLabels[field]} 입금 예상월`,
          message: `${label}${paymentLabels[field]} 입금 예상월을 입력해 주세요.` });
      }
    }
    const total = paymentFields.reduce((sum, field) => sum + (Number(plan[field]) || 0), 0);
    const advance = (Number(plan.contract) || 0) + (Number(plan.interim) || 0);
    if (total > 0 && Number(source.contractAmount) > 0 && advance / Number(source.contractAmount) < 0.7
      && !String(source.advanceInterimBelow70Reason || '').trim()) {
      issues.push({ field: `${prefix}advanceInterimBelow70Reason`, step: 'financial', label: `${label}선금·중도금 70% 미만 사유`,
        message: `${label}선금·중도금 70% 미만 사유를 입력해 주세요.` });
    }
    return issues;
  });
}

export function projectParticipationPeriodWarnings(project) {
  const start = String(project.contractStart || '').slice(0, 7);
  const end = String(project.contractEnd || '').slice(0, 7);
  if (!monthPattern.test(start)) return [];
  return (Array.isArray(project.teamMembersDetailed) ? project.teamMembersDetailed : []).flatMap((member, index) => {
    if (!Object.hasOwn(member, 'monthlyRates')) return [];
    const from = String(member.laborAllocationStartMonth || '');
    const to = String(member.laborAllocationEndMonth || '');
    const months = Object.keys(member.monthlyRates || {});
    const outside = [from, to, ...months].filter((month) => monthPattern.test(month))
      .some((month) => month < start || (monthPattern.test(end) && month > end));
    if (!outside) return [];
    const person = member.memberNickname || member.memberName || `참여인력 ${index + 1}`;
    return [{ field: `teamMembersDetailed.${index}.monthlyRates`, step: 'team',
      message: `${person}: 참여기간(${from}~${to || '종료 미정'})과 계약기간(${start}~${end || '종료 기간 없음'})이 다릅니다. 참여율은 입력한 월 그대로 보존됩니다.` }];
  });
}
