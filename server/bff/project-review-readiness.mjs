import { projectSettlementConsistencyIssue } from '../../src/app/platform/project-settlement-consistency.mjs';

const text = (value) => typeof value === 'string' ? value.trim() : '';
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const requiredDocuments = [
  ['contractDocument', '계약서'],
  ['customerBusinessRegistrationDocument', '고객사 사업자등록증'],
  ['quoteDocument', '산출내역서(견적서)'],
];

const knownErrors = {
  project_settlement_basis_conflict: ['정산 유형과 정산 기준을 확인해 주세요', '이 문서에 선택된 정산 유형과 정산 기준이 서로 맞지 않습니다. 어떤 내용이 맞는지 확인한 뒤 승인할 수 있습니다.', '작성자: 프로젝트 수정의 계약/재무 > 정산에서 두 항목을 확인한 뒤 최종 제출해 주세요.\n조직장: 수정된 문서가 제출되면 내용을 확인하고 승인해 주세요.'],
  project_attachments_processing: ['제출 파일 준비가 완료되지 않았습니다', '제출된 첨부파일을 결재 문서에서 사용할 수 있도록 준비하는 단계가 아직 끝나지 않았습니다. 파일을 제출하지 않았다는 뜻은 아닙니다.', '조직장은 잠시 후 문서를 다시 열어 주세요. 계속되면 운영 담당자에게 해당 프로젝트의 첨부파일 준비 상태 확인을 요청해 주세요.'],
  project_attachment_unavailable: ['제출 파일을 확인하지 못했습니다', '저장된 첨부 정보와 실제 파일을 대조하지 못했습니다. 파일 누락, 첨부 정보 불일치 또는 파일 접근 문제인지 추가 확인이 필요합니다.', '조직장은 승인을 보류하고 운영 담당자에게 파일 확인을 요청해 주세요. 재첨부가 필요하다고 확인되면 등록자가 프로젝트 수정에서 해당 파일을 다시 첨부하고 최종 제출해 주세요.'],
  review_version_required: ['최신 결재 문서를 다시 열어 주세요', '현재 열어 둔 문서의 확인 정보가 없어 검토한 내용과 승인할 내용이 같은지 확인할 수 없습니다.', '조직장이 문서를 닫고 다시 열어 제출 내용을 확인한 뒤 승인해 주세요.'],
  review_version_conflict: ['검토 중 제출 내용이 변경되었습니다', '문서를 연 이후 프로젝트 또는 결재 요청이 변경되어 현재 화면의 내용으로 승인할 수 없습니다.', '조직장이 문서를 다시 열고 변경된 내용을 확인한 뒤 승인해 주세요.'],
  canonical_version_conflict: ['프로젝트의 최신 내용과 다시 대조해야 합니다', '검토 대상 프로젝트나 제출 요청이 변경되어 기존 검토 정보로 처리할 수 없습니다.', '조직장이 문서를 다시 열어 주세요. 계속되면 등록자와 운영 담당자에게 최신 제출본 확인을 요청해 주세요.'],
  executive_approver_mismatch: ['지정된 조직장만 승인할 수 있습니다', '현재 로그인한 계정이 이 문서에 지정된 조직장과 일치하지 않습니다.', '문서의 조직장 정보를 확인해 주세요. 지정이 잘못되었다면 등록자에게 결재자 수정과 재제출을 요청해 주세요.'],
  project_registration_invalid: ['제출 내용이 현재 승인 검증 조건과 맞지 않습니다', '서버의 승인 검증에서 제출 내용의 형식 또는 필수 연결 정보가 맞지 않는 것으로 확인되었습니다. 어떤 값을 고쳐야 하는지는 추가 확인이 필요합니다.', '조직장은 승인을 보류하고 프로젝트명과 발생 시각을 운영 담당자에게 전달해 주세요. 확인된 항목을 등록자가 프로젝트 수정에서 보완하고 최종 제출한 뒤 다시 검토해 주세요.'],
  invalid_executive_review_state: ['현재 승인 대기 상태가 아닙니다', '이미 처리되었거나 다른 결재 단계로 이동한 문서일 수 있습니다.', '조직장이 목록과 문서를 새로 열어 현재 결재 상태와 처리 이력을 확인해 주세요.'],
};

export function mapProjectReviewReadinessError(error) {
  const code = text(error?.code);
  if (code === 'project_registration_invalid') {
    const message = text(error?.message);
    if (message === 'Project registration participationSheetLink is required for sheet-backed team members') return {
      code: 'participation_sheet_link_missing', severity: 'blocking', field: 'participationSheetLink',
      title: '참여율 시트 연결이 필요합니다',
      detail: '제출된 참여인력의 월별 참여율을 확인할 시트 링크가 없습니다. 현재 승인 검증은 이 연결을 필요로 합니다.',
      action: '등록자가 프로젝트 수정의 팀/인력 단계에서 참여율 시트를 연결하고 인력 내역을 확인한 뒤 최종 제출해 주세요. 조직장은 새 제출본을 다시 열어 승인해 주세요.',
    };
    if (/^Project registration sheet-backed team member \d+ identity is required$/.test(message)) return {
      code: 'participation_member_identity_missing', severity: 'blocking', field: 'teamMembersDetailed',
      title: '참여인력 중 누구인지 확인할 수 없는 행이 있습니다',
      detail: '월별 참여율이 있는 인력 행에 구성원 식별 정보, 이름, 별명이 모두 없어 해당 참여율의 담당자를 확인할 수 없습니다.',
      action: '등록자가 프로젝트 수정의 팀/인력 단계와 참여율 시트에서 이름이 비어 있는 행을 확인하고 구성원을 연결한 뒤 최종 제출해 주세요.',
    };
    if (/^Project registration duplicate monthlyRates ownership for \d{4}-\d{2}$/.test(message)) return {
      code: 'participation_monthly_owner_duplicate', severity: 'blocking', field: 'teamMembersDetailed',
      title: '같은 인력의 월별 참여율이 중복되어 있습니다',
      detail: '동일 인력의 같은 월 참여율이 여러 행에 기록되어 어느 값을 적용해야 하는지 확인할 수 없습니다.',
      action: '등록자가 참여율 시트와 프로젝트 수정의 팀/인력 단계에서 중복 행을 확인하고 정리한 뒤 최종 제출해 주세요. 조직장은 새 제출본의 인력 내역을 다시 확인해 주세요.',
    };
  }
  const known = knownErrors[code];
  if (known) return { code, severity: 'blocking', title: known[0], detail: known[1], action: known[2] };
  return {
    code: 'project_review_check_unavailable', severity: 'warning',
    title: '승인 가능 여부를 끝까지 확인하지 못했습니다',
    detail: '사전 확인 중 문제가 발생했습니다. 입력 누락이나 파일 미제출로 단정할 수 없으며, 이 안내는 승인 가능 확인을 대신하지 않습니다.',
    action: '조직장이 문서를 다시 열어 주세요. 계속되면 프로젝트명과 발생 시각을 운영 담당자에게 전달해 오류 추적을 요청해 주세요.',
  };
}

export function buildProjectReviewReadiness(request, project) {
  const payload = request
    ? object(request.requestKind === 'CHANGE' && request.proposedSnapshot && typeof request.proposedSnapshot === 'object'
      ? request.proposedSnapshot : request.payload)
    : object(project);
  const legacy = payload.registrationRequirementsVersion !== 2;
  const pending = request?.status === 'PENDING';
  const issues = [];
  const settlementIssue = projectSettlementConsistencyIssue(payload, project);
  if (settlementIssue) issues.push({ ...settlementIssue, severity: pending ? 'blocking' : 'warning' });
  if (legacy) issues.push({
    code: 'legacy_submission_format', severity: 'warning', field: 'registrationRequirementsVersion',
    title: '등록 양식을 확인해 주세요',
    detail: '이전 등록 양식이거나 작성 당시 양식을 확인할 수 없는 문서입니다. 제출 당시 내용과 첨부파일을 확인할 수 있으며, 이후 추가된 질문은 답변이 없을 수 있습니다.',
    action: '아래 확인이 필요한 항목을 살펴봐 주세요. 파일 저장 위치나 제출 정보가 승인 기준과 맞지 않으면 작성자가 해당 항목을 수정하거나 파일을 다시 첨부한 뒤 최종 제출해야 합니다.',
  });
  for (const [field, label] of requiredDocuments) {
    if (field === 'quoteDocument' && payload.quoteSubmissionDeferred === true) continue;
    if (text(payload[field]?.path)) continue;
    const absent = !Object.hasOwn(payload, field);
    // Approval only gates an unpublished v2 registration; published and historical requests keep their existing policy.
    const blocking = pending && request?.requestKind === 'REGISTRATION'
      && payload.registrationRequirementsVersion === 2 && !text(request.registrationAttachmentsPublishedAt);
    issues.push({
      code: blocking ? 'project_attachments_processing' : absent ? 'submission_field_unrecorded' : 'submission_document_reference_empty',
      severity: blocking ? 'blocking' : 'warning', field,
      title: `${label} ${absent ? '기록이 없습니다' : '파일 연결을 확인해 주세요'}`,
      detail: absent
        ? `이 제출본에는 ${label} 항목 자체가 기록되어 있지 않습니다. 실제로 제출하지 않은 것인지 이전 형식에 저장되지 않은 것인지는 별도 확인이 필요합니다.`
        : `이 제출본의 ${label} 항목에 파일 연결 정보가 없습니다. 원본 파일이 다른 위치에 남아 있는지는 이 정보만으로 판단할 수 없습니다.`,
      action: blocking
        ? `조직장은 승인을 보류하고 운영 담당자에게 첨부파일 준비 상태 확인을 요청해 주세요. 누락으로 확인되면 등록자가 프로젝트 수정에서 ${label}를 첨부한 뒤 최종 제출해 주세요.`
        : `조직장은 제출 원문과 ${label}를 대조해 주세요. 확인이 어려우면 등록자 또는 운영 담당자에게 기존 파일 확인을 요청해 주세요.`,
    });
  }
  return { legacy, issues };
}
