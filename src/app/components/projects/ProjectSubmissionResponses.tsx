import type { ProjectEditorDraft } from '../../platform/project-editor';
import { ProjectFormSection, ProjectFormRow } from './project-form-layout';

export function ProjectSubmissionResponses({ draft, onChange, step }: {
  draft: ProjectEditorDraft;
  onChange: (patch: Partial<ProjectEditorDraft>) => void;
  step: 'basic' | 'financial' | 'team' | 'review';
}) {
  const absent = (field: string, checked: boolean) => {
    const next = { ...draft.submissionResponses };
    if (checked) next[field] = 'NOT_APPLICABLE'; else delete next[field];
    onChange({ submissionResponses: next });
  };
  const choices = [
    ['businessManagementGoogleFolderLink', '사업관리 폴더', Boolean(draft.businessManagementGoogleFolderLink.trim()), 'basic'],
    ['paymentPlanDesc', '기타 메모', Boolean(draft.paymentPlanDesc.trim()), 'financial'],
    ['staffing.lead', '총괄책임자', Boolean(draft.staffing.lead), 'team'],
    ['staffing.pm', '실무책임자', Boolean(draft.staffing.pm), 'team'],
    ['staffing.operators', '운영매니저', draft.staffing.operators.length > 0, 'team'],
    ['staffing.others', '기타 인력', draft.staffing.others.length > 0, 'team'],
    ['staffing.settlementSupport', '정산지원', Boolean(draft.staffing.settlementSupport.trim()), 'review'],
  ] as const;
  const confirmations = [
    ['laborIncludesFourInsurance', '인건비에 4대보험을 포함하나요?'],
    ['laborIncludesRetirementPay', '인건비에 퇴직금을 포함하나요?'],
    ['customerSettlementBasisConfirmed', '고객사 정산 기준을 확인했나요?'],
  ] as const;
  return <ProjectFormSection title="필수 응답 확인" description={step === 'review' ? '각 단계에서 선택한 내용입니다. 미응답 항목은 아래 안내를 눌러 해당 입력칸에서 선택해 주세요.' : '이 단계의 항목을 확인해 주세요. 해당하는 내용이 없으면 해당 없음을 직접 선택합니다.'}>
    {choices.filter(([, , , ownerStep]) => step === 'review' || ownerStep === step).map(([field, label, hasValue]) => <ProjectFormRow key={field} label={label} required issueLabel={step === 'review' ? undefined : field}>
      {step === 'review' ? <span>{hasValue ? (draft.submissionResponses[field] === 'NOT_APPLICABLE' ? '입력 내용과 해당 없음 선택을 확인해 주세요' : '입력됨') : draft.submissionResponses[field] === 'NOT_APPLICABLE' ? '해당 없음' : '미응답'}</span> : hasValue ? <span>입력됨</span> : <label className="flex items-center gap-2">
        <input type="checkbox" aria-label={`${label} 해당 없음`} checked={draft.submissionResponses[field] === 'NOT_APPLICABLE'} onChange={e => absent(field, e.target.checked)} />
        해당 없음{field === 'businessManagementGoogleFolderLink' ? ' (현재 지정할 폴더 없음)' : ''}
      </label>}
      {step !== 'review' && hasValue && draft.submissionResponses[field] === 'NOT_APPLICABLE' ? <button type="button" className="ml-3 underline" onClick={() => absent(field, false)}>입력값 사용 · 해당 없음 해제</button> : null}
    </ProjectFormRow>)}
    {step === 'financial' || step === 'review' ? confirmations.map(([field, label]) => <ProjectFormRow key={field} label={label} required issueLabel={step === 'review' ? undefined : `registrationConfirmations.${field}`}>
      {step === 'review' ? <span>{draft.registrationConfirmations[field] === true ? '예' : draft.registrationConfirmations[field] === false ? '아니오 / 해당 없음' : '미응답'}</span> : <div className="flex gap-5">{[true, false].map(value => <label key={String(value)} className="flex items-center gap-2">
        <input type="radio" name={`submission-${field}`} aria-label={`${label} ${value ? '예' : '아니오 / 해당 없음'}`} checked={draft.registrationConfirmations[field] === value} onChange={() => onChange({ registrationConfirmations: { ...draft.registrationConfirmations, [field]: value } })} />
        {value ? '예' : '아니오 / 해당 없음'}
      </label>)}</div>}
    </ProjectFormRow>) : null}
  </ProjectFormSection>;
}
