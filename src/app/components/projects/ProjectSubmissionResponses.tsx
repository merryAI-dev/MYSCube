import type { ProjectEditorDraft } from '../../platform/project-editor';
import { ProjectFormSection, ProjectFormRow } from './project-form-layout';

type ResponseProps = {
  draft: ProjectEditorDraft;
  onChange: (patch: Partial<ProjectEditorDraft>) => void;
};

const confirmations = [
  ['laborIncludesFourInsurance', '인건비에 4대보험을 포함하나요?'],
  ['laborIncludesRetirementPay', '인건비에 퇴직금을 포함하나요?'],
  ['customerSettlementBasisConfirmed', '고객사 정산 기준을 확인했나요?'],
] as const;

export function ProjectAbsenceChoice({ draft, onChange, field, label }: ResponseProps & {
  field: 'businessManagementGoogleFolderLink' | 'paymentPlanDesc';
  label: string;
}) {
  const checked = draft.submissionResponses[field] === 'NOT_APPLICABLE';
  const absent = (value: boolean) => {
    const next = { ...draft.submissionResponses };
    if (value) next[field] = 'NOT_APPLICABLE'; else delete next[field];
    onChange({ submissionResponses: next });
  };
  if (draft[field].trim()) return checked ? <button type="button" className="text-[13px] underline" onClick={() => absent(false)}>입력값 사용 · 해당 없음 해제</button> : null;
  return <label className="flex shrink-0 items-center gap-2 text-[13px]">
    <input type="checkbox" aria-label={`${label} 해당 없음`} checked={checked} onChange={event => absent(event.target.checked)} /> 해당 없음
  </label>;
}

export function ProjectRegistrationConfirmations({ draft, onChange }: ResponseProps) {
  return <>{confirmations.map(([field, label]) => <ProjectFormRow key={field} label={label} required issueLabel={`registrationConfirmations.${field}`}>
    <div className="flex flex-wrap gap-x-5 gap-y-2">{[true, false].map(value => <label key={String(value)} className="flex items-center gap-2 text-[13px]">
      <input type="radio" name={`submission-${field}`} aria-label={`${label} ${value ? '예' : '아니오 / 해당 없음'}`} checked={draft.registrationConfirmations[field] === value} onChange={() => onChange({ registrationConfirmations: { ...draft.registrationConfirmations, [field]: value } })} />
      {value ? '예' : '아니오 / 해당 없음'}
    </label>)}</div>
  </ProjectFormRow>)}</>;
}

export function ProjectSubmissionResponses({ draft }: { draft: ProjectEditorDraft }) {
  const choices = [
    ['businessManagementGoogleFolderLink', '사업관리 폴더', Boolean(draft.businessManagementGoogleFolderLink.trim())],
    ['paymentPlanDesc', '기타 메모', Boolean(draft.paymentPlanDesc.trim())],
    ['staffing.others', '기타 인력', draft.staffing.others.length > 0],
    ['staffing.settlementSupport', '정산지원', Boolean(draft.staffing.settlementSupport.trim())],
  ] as const;
  return <ProjectFormSection title="입력 내용 확인" description="각 단계에서 선택한 내용입니다. 미응답 항목은 아래 안내를 눌러 해당 입력칸에서 선택해 주세요.">
    {choices.map(([field, label, hasValue]) => <ProjectFormRow key={field} label={label}>
      <span>{hasValue ? (draft.submissionResponses[field] === 'NOT_APPLICABLE' ? '입력 내용과 해당 없음 선택을 확인해 주세요' : '입력됨') : draft.submissionResponses[field] === 'NOT_APPLICABLE' ? '해당 없음' : '미응답'}</span>
    </ProjectFormRow>)}
    {confirmations.map(([field, label]) => <ProjectFormRow key={field} label={label}>
      <span>{draft.registrationConfirmations[field] === true ? '예' : draft.registrationConfirmations[field] === false ? '아니오 / 해당 없음' : '미응답'}</span>
    </ProjectFormRow>)}
  </ProjectFormSection>;
}
