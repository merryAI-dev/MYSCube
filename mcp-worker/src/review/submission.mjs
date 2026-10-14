// 검토 대상(subject)의 제출값과 첨부 목록을 BFF 에서 사용자 권한으로 읽는다(스펙 4·5.3절).
// 제출값은 허용 목록(SUBMISSION_FIELDS)에 있는 필드만 내보낸다. 새 필드가 생겨도 자동으로 빠진다(개인정보 보호).
export const SUBJECT_TYPES = ['request', 'registration_draft', 'edit_draft', 'project'];

// 서류 종류 → 제출값의 첨부 필드(BFF PROJECT_REQUEST_ATTACHMENT_FIELDS 와 같은 이름).
export const ATTACHMENT_FIELDS = {
  contract: 'contractDocument',
  customer_business_registration: 'customerBusinessRegistrationDocument',
  quote: 'quoteDocument',
  proposal: 'proposalDocument',
};

// 대조와 화면 안내에 쓰는 필드만. 인력은 S2 에서 필요한 범위로 따로 다룬다.
export const SUBMISSION_FIELDS = [
  'name', 'officialContractName', 'clientOrg', 'type', 'department', 'currency',
  'contractStart', 'contractEnd', 'contractEndUndecided',
  'contractAmount', 'salesVatAmount', 'totalRevenueAmount', 'totalActualCost', 'supportAmount',
  'paymentPlan', 'paymentPlanDesc', 'projectPurpose', 'description',
];

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const enc = encodeURIComponent;

export function parseSubject(input) {
  const type = input?.type;
  if (!SUBJECT_TYPES.includes(type)) throw new Error(`검토 대상 종류는 ${SUBJECT_TYPES.join(', ')} 중 하나입니다.`);
  const need = (key) => {
    const value = text(input?.[key]);
    if (!ID.test(value)) throw new Error(`${key} 형식이 올바르지 않습니다.`);
    return value;
  };
  if (type === 'request') return { type, projectId: need('projectId'), requestId: need('requestId') };
  if (type === 'registration_draft') return { type, draftId: need('draftId') };
  return { type, projectId: need('projectId') };
}

// 첨부 텍스트 엔드포인트 경로(BFF 5.7절). 권한은 BFF 가 판단한다.
export function attachmentTextPath(subject, kind) {
  if (!ATTACHMENT_FIELDS[kind]) throw new Error('서류 종류가 올바르지 않습니다.');
  switch (subject.type) {
    case 'request': return `/api/v1/project-requests/${enc(subject.requestId)}/attachments/${kind}/text`;
    case 'registration_draft': return `/api/v1/project-registration-drafts/${enc(subject.draftId)}/attachments/${kind}/text`;
    case 'edit_draft': return `/api/v1/project-info-drafts/${enc(subject.projectId)}/attachments/${kind}/text`;
    default: return `/api/v1/projects/${enc(subject.projectId)}/attachments/${kind}/text`;
  }
}

// BFF resolveProjectRequestPayloadForReview 와 같은 규칙: 수정 요청은 제안 스냅숏, 그 밖은 payload.
function requestPayload(request) {
  if (text(request?.requestKind) === 'CHANGE' && request?.proposedSnapshot && typeof request.proposedSnapshot === 'object') return request.proposedSnapshot;
  return request?.payload && typeof request.payload === 'object' ? request.payload : {};
}

function pick(source) {
  return Object.fromEntries(SUBMISSION_FIELDS.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));
}

function attachmentsFrom(source, refs = []) {
  return Object.entries(ATTACHMENT_FIELDS).map(([kind, field]) => {
    const ref = [...refs].reverse().find((item) => item?.documentKind === kind && text(item?.path));
    const stored = source?.[field];
    const present = Boolean(ref || text(stored?.path));
    return { kind, present, name: text(ref?.name) || text(stored?.name) };
  });
}

const httpsLink = (value) => (/^https:\/\//u.test(text(value)) ? text(value) : '');

export async function loadSubmission(bff, input) {
  const subject = parseSubject(input);
  let source;
  let refs = [];
  let reviewToken = null;
  let serverReadiness = [];
  if (subject.type === 'request' || subject.type === 'project') {
    const response = await bff.get(`/api/v1/projects/${enc(subject.projectId)}/review-document`, subject.type === 'request' ? { requestId: subject.requestId } : {});
    source = subject.type === 'request' ? requestPayload(response?.request) : (response?.project ?? {});
    reviewToken = response?.reviewToken ?? null;
    serverReadiness = (response?.readiness?.issues ?? []).map((issue) => ({ code: issue.code ?? null, field: issue.field ?? null, message: issue.message ?? null }));
  } else {
    const path = subject.type === 'registration_draft'
      ? `/api/v1/project-registration-drafts/${enc(subject.draftId)}`
      : `/api/v1/project-info-drafts/${enc(subject.projectId)}`;
    const response = await bff.get(path);
    source = response?.draft?.payload ?? {};
    refs = Array.isArray(response?.draft?.attachmentRefs) ? response.draft.attachmentRefs : [];
    reviewToken = response?.draft ? `draft-revision:${response.draft.draftRevision ?? 0}` : null;
  }
  const attachments = attachmentsFrom(source, refs);
  return {
    subject,
    reviewToken,
    submission: pick(source),
    attachments,
    attachedKinds: attachments.filter((item) => item.present).map((item) => item.kind),
    links: {
      participationSheetLink: httpsLink(source?.participationSheetLink),
      businessManagementGoogleFolderLink: httpsLink(source?.businessManagementGoogleFolderLink),
    },
    serverReadiness,
  };
}
