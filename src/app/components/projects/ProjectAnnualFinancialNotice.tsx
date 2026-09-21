import type { ProjectFinancialYear, ProjectRequestPayload } from '../../data/types';
import { submissionAnnualFinancialNeeds } from '../../platform/project-submission-display';

export function ProjectAnnualFinancialNotice({ years, period }: { years?: ProjectFinancialYear[]; period?: Partial<Pick<ProjectRequestPayload, 'contractStart' | 'contractEnd' | 'contractEndUndecided'>> }) {
  const needs = submissionAnnualFinancialNeeds(years, period);
  if (!years?.length && !needs.length) return <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">연도별 금액 입력 기록이 없습니다. 계약기간에 해당하는 각 연도의 계약금액, 매출 부가세, 수익, 실비(원가), 지원금을 확인해 주세요. 해당 금액이 없으면 0원을 직접 입력해 주세요.</p>;
  if (!needs.length) return null;
  return <div aria-label="연도별 금액 확인 안내" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
    <p className="font-medium">입력 확인이 필요한 금액</p>
    <p className="mt-1">표시된 기존 저장 합계가 있어도 연도별 입력이 완료된 것은 아닙니다. 계약서와 대조해 아래 항목을 확인해 주세요.</p>
    <ul className="mt-1 space-y-1">{needs.map((item) => <li key={item.year}>{item.message}</li>)}</ul>
    <p className="mt-1">기존 저장값은 유지됩니다. 빈칸이나 확인되지 않은 금액은 0원으로 확정하지 않습니다.</p>
  </div>;
}
