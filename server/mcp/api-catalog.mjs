import { createHash } from 'node:crypto';
import * as z from 'zod/v4';

// MYSCube MCP 의 입력 형식, 사업 필드 화이트리스트, 조회 API 목록. BFF 안의 원격 MCP 와
// Cloudflare Worker MCP 서비스(mcp-worker/)가 같은 정의를 쓴다.

export const projectId = z.string().min(1).max(120).regex(/^[^/]+$/)
  .describe('MYSCube 프로젝트 ID. 모르면 project_search로 먼저 찾습니다.');
export const yearMonth = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/).describe('조회월, YYYY-MM 형식');
export const cursor = z.string().max(500).optional().describe('이전 응답의 nextCursor. 첫 페이지는 비워 둡니다.');
export const limit = z.number().int().min(1).optional().describe('한 번에 받을 건수. 서버가 허용하는 최대치보다 크면 최대치로 맞춰집니다.');

export const PROJECT_FIELDS = Object.freeze([
  'name', 'shortName', 'officialContractName', 'projectCode', 'groupwareName',
  'status', 'type', 'phase', 'cic', 'department', 'teamName', 'managerName', 'settlementSupportName',
  'clientOrg', 'contractType', 'contractStart', 'contractEnd', 'contractEndUndecided',
  'currency', 'contractAmount', 'budgetCurrentYear', 'paymentPlan', 'paymentPlanDesc',
  'settlementType', 'basis', 'accountType', 'isSettled', 'projectPurpose',
]);

// 내부 API 응답에서 링크·이메일·파일 위치·비밀값은 도구 결과로 내보내지 않는다.
const REDACTED_KEY = /(url|link|email|storagepath|bucket|token|secret|password|signature)$/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !REDACTED_KEY.test(key)).map(([key, item]) => [key, redact(item)]));
}

// 검증된 BFF 조회 API 목록. 라우트마다 도구를 만들지 않고, AI 가 api_catalog 로 고른 뒤 api_read 로
// 실행한다. 여기 없는 경로는 실행되지 않는다. 권한 검사는 각 API 가 앱 화면과 똑같이 한다.
// 새 항목은 GET 이고, 개인정보·첨부 원본을 돌려주지 않는 API 만 추가한다.
const requestId = z.string().min(1).max(200).describe('월결산 요청 ID');
const history = z.boolean().optional().describe('true면 변경 이력을 돌려줍니다.');

export const API_CATALOG = Object.freeze([
  { id: 'month_close.status', tags: ['#월결산', '#사업단위'], input: { projectId },
    description: '한 사업의 월결산 상태(결산 여부, 마감, 재오픈 요청 등).',
    path: ({ projectId: id }) => `/api/v1/cashflow/${id}/month-close` },
  { id: 'month_close.pending_requests', tags: ['#월결산', '#검토대기', '#전체'], input: {},
    description: '검토를 기다리는 월결산·재오픈 요청 목록. 권한 있는 사업만 포함됩니다.',
    path: () => '/api/v1/cashflow/month-close/requests/pending' },
  { id: 'month_close.request_months', tags: ['#월결산', '#요청상세'], input: { projectId, requestId, cursor, limit },
    description: '한 월결산 요청이 다루는 월별 결산 내용.',
    path: ({ projectId: id, requestId: rid }) => `/api/v1/cashflow/${id}/month-close/requests/${encodeURIComponent(rid)}/months`, query: ['cursor', 'limit'] },
  { id: 'month_close.request_diff', tags: ['#월결산', '#요청상세', '#변경내역'], input: { projectId, requestId },
    description: '한 월결산 요청에서 결산 이후 바뀐 셀(이전 값과 새 값).',
    path: ({ projectId: id, requestId: rid }) => `/api/v1/cashflow/${id}/month-close/requests/${encodeURIComponent(rid)}/revision-diff` },
  { id: 'settlement.statuses', tags: ['#주정산', '#사업단위'], input: { projectId, yearMonth },
    description: '한 사업의 한 달 주차별 정산 상태와 제출·승인 시각.',
    path: ({ projectId: id }) => `/api/v1/cashflow/${id}/settlement-statuses`, query: ['yearMonth'] },
  { id: 'settlement.weekly_compliance', tags: ['#주정산', '#준수이력'], input: { projectId, cursor, limit },
    description: '한 사업의 주간 사업비 업데이트를 기한 안에 완료했는지 이력.',
    path: ({ projectId: id }) => `/api/v1/cashflow/${id}/weekly-update-compliance`, query: ['cursor', 'limit'] },
  { id: 'cashflow.activity', tags: ['#사업비', '#활동이력'], input: { projectId, cursor, limit },
    description: '한 사업의 사업비 관련 활동(시트 불러오기·반영, 결산, 승인 등) 이력, 최신순.',
    path: ({ projectId: id }) => `/api/v1/cashflow/${id}/activity`, query: ['cursor', 'limit'] },
  { id: 'cashflow.applied_changes', tags: ['#사업비', '#변경내역'], input: { projectId, cursor, limit },
    description: '시트에서 원장으로 반영된 셀 변경(항목·주차·이전 값·새 값).',
    path: ({ projectId: id }) => `/api/v1/cashflow/${id}/applied-cell-changes`, query: ['cursor', 'limit'] },
  { id: 'cashflow.sheet_apply_status', tags: ['#사업비', '#시트', '#반영상태'], input: { projectId },
    description: '시트 값 반영 작업의 현재 상태(진행 중, 완료, 실패와 잠금).',
    path: ({ projectId: id }) => `/api/v1/projects/${id}/cashflow-sheet-lab/apply-status` },
  { id: 'project_request.list', tags: ['#사업등록', '#사업정보변경', '#승인', '#전체'], input: {
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional().describe('요청 상태로 거르기. 비우면 전부'),
      requestKind: z.enum(['REGISTRATION', 'CHANGE']).optional().describe('등록(REGISTRATION) 또는 정보 변경(CHANGE). 비우면 둘 다'),
    },
    description: '사업 등록·정보 변경 요청 전체 목록(사업명, CIC, 담당자, 승인자, 요청자·요청일, 검토자·검토일·사유)과 상태별 건수. 관리자·재무는 조직 전체가, 그 밖에는 접근 가능한 사업과 본인 관련 요청만 나옵니다. 응답의 scope가 ORGANIZATION일 때만 조직 전체 건수로 보고하세요.',
    path: () => '/api/v1/project-requests', query: ['status', 'requestKind'] },
  { id: 'project_request.registration_drafts', tags: ['#사업등록', '#목록'], input: {},
    description: '권한 있는 사업 등록 초안(작성 중·검토 중) 목록.',
    path: () => '/api/v1/project-registration-drafts' },
  { id: 'project_request.registration_draft', tags: ['#사업등록', '#상세'], input: { draftId: z.string().min(1).max(200).describe('사업 등록 초안 ID'), history },
    description: '사업 등록 초안 하나의 내용 또는 변경 이력. 첨부 파일 내용은 포함하지 않습니다.',
    path: ({ draftId, history: withHistory }) => `/api/v1/project-registration-drafts/${encodeURIComponent(draftId)}${withHistory ? '/history' : ''}` },
  { id: 'project_request.assigned_to_me', tags: ['#사업등록', '#승인', '#내업무'], input: {},
    description: '로그인한 사용자가 검토·승인하도록 배정된 사업 등록·변경 요청 목록.',
    path: () => '/api/v1/project-requests/assigned-to-me' },
  { id: 'project_request.info_draft', tags: ['#사업정보변경', '#상세'], input: { projectId, history },
    description: '등록된 사업의 정보 변경 초안 또는 그 변경 이력.',
    path: ({ projectId: id, history: withHistory }) => `/api/v1/project-info-drafts/${id}${withHistory ? '/history' : ''}` },
  { id: 'project_request.latest', tags: ['#사업등록', '#사업정보변경', '#검토상태'], input: { projectId },
    description: '한 사업에 대한 가장 최근 등록·변경 요청과 그 검토 상태.',
    path: ({ projectId: id }) => `/api/v1/projects/${id}/latest-request` },
].map((entry) => ({ ...entry, tags: [...entry.tags, '#읽기전용'], schema: z.object(entry.input).strict() })));

export function catalogView(entry) {
  const { $schema: _ignored, ...params } = z.toJSONSchema(entry.schema);
  return { id: entry.id, tags: entry.tags, description: entry.description, params };
}

export const API_CATALOG_VERSION = `sha256:${createHash('sha256')
  .update(JSON.stringify(API_CATALOG.map(catalogView))).digest('hex').slice(0, 16)}`;


