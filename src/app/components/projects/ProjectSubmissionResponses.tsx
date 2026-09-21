import type { ProjectEditorDraft } from '../../platform/project-editor';
import { ProjectFormSection, ProjectFormRow } from './project-form-layout';

export function ProjectSubmissionResponses({ draft, onChange }: {
  draft: ProjectEditorDraft;
  onChange: (patch: Partial<ProjectEditorDraft>) => void;
}) {
  const absent = (field: string, checked: boolean) => {
    const next = { ...draft.submissionResponses };
    if (checked) next[field] = 'NOT_APPLICABLE'; else delete next[field];
    onChange({ submissionResponses: next });
  };
  const choices = [
    ['businessManagementGoogleFolderLink', '사업관리 폴더', Boolean(draft.businessManagementGoogleFolderLink.trim())],
    ['paymentPlanDesc', '기타 메모', Boolean(draft.paymentPlanDesc.trim())],
    ['staffing.lead', '총괄책임자', Boolean(draft.staffing.lead)],
    ['staffing.pm', '실무책임자', Boolean(draft.staffing.pm)],
    ['staffing.operators', '운영매니저', draft.staffing.operators.length > 0],
    ['staffing.others', '기타 역할', draft.staffing.others.length > 0],
    ['staffing.settlementSupport', '정산지원', Boolean(draft.staffing.settlementSupport.trim())],
  ] as const;
  const confirmations = [
    ['laborIncludesFourInsurance', '인건비에 4대보험을 포함하나요?'],
    ['laborIncludesRetirementPay', '인건비에 퇴직금을 포함하나요?'],
    ['customerSettlementBasisConfirmed', '고객사 정산 기준을 확인했나요?'],
  ] as const;
  return <ProjectFormSection title="필수 응답 확인" description="빈 항목을 그대로 제출할 수 없습니다. 값이 없으면 해당 없음을 직접 선택해 주세요. 숫자는 앞 단계에서 0원을 입력할 수 있습니다.">
    {choices.map(([field, label, hasValue]) => <ProjectFormRow key={field} label={label} required>
      {hasValue ? <span>입력됨</span> : <label className="flex items-center gap-2">
        <input type="checkbox" aria-label={`${label} 해당 없음`} checked={draft.submissionResponses[field] === 'NOT_APPLICABLE'} onChange={e => absent(field, e.target.checked)} />
        해당 없음{field === 'businessManagementGoogleFolderLink' ? ' (현재 지정할 폴더 없음)' : ''}
      </label>}
      {hasValue && draft.submissionResponses[field] === 'NOT_APPLICABLE' ? <button type="button" className="ml-3 underline" onClick={() => absent(field, false)}>입력값 사용 · 해당 없음 해제</button> : null}
    </ProjectFormRow>)}
    {confirmations.map(([field, label]) => <ProjectFormRow key={field} label={label} required>
      <div className="flex gap-5">{[true, false].map(value => <label key={String(value)} className="flex items-center gap-2">
        <input type="radio" name={`submission-${field}`} aria-label={`${label} ${value ? '예' : '아니오 / 해당 없음'}`} checked={draft.registrationConfirmations[field] === value} onChange={() => onChange({ registrationConfirmations: { ...draft.registrationConfirmations, [field]: value } })} />
        {value ? '예' : '아니오 / 해당 없음'}
      </label>)}</div>
    </ProjectFormRow>)}
  </ProjectFormSection>;
}
