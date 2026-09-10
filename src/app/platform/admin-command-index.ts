import type { UserRole } from '../data/types';
import { canShowAdminNavItem } from './admin-nav';

export type AdminCommandIcon =
  | 'approval'
  | 'bank'
  | 'budget'
  | 'cashflow'
  | 'dashboard'
  | 'expense'
  | 'payroll'
  | 'project'
  | 'settings'
  | 'users';

export type AdminCommandScope = 'admin' | 'pm';

export type AdminCommandKind = 'page' | 'project';

export interface AdminCommandItem {
  id: string;
  label: string;
  description?: string;
  category: '관리자' | 'PM';
  scope: AdminCommandScope;
  to: string;
  icon: AdminCommandIcon;
  kind: AdminCommandKind;
  keywords: string[];
  priority: number;
  featured?: boolean;
}

interface AdminCommandProject {
  id: string;
  name: string;
  shortName?: string;
  officialContractName?: string;
  department?: string;
  clientOrg?: string;
  managerName?: string;
  groupwareName?: string;
}

export interface BuildAdminCommandItemsInput {
  role?: UserRole;
  projects: AdminCommandProject[];
  projectLimit?: number;
}

const ADMIN_COMMAND_DEFINITIONS: AdminCommandItem[] = [
  {
    id: 'admin:dashboard',
    label: '대시보드',
    description: '전사 프로젝트 현황, 운영 상태, 오늘 확인할 항목을 봅니다.',
    category: '관리자',
    scope: 'admin',
    to: '/dashboard',
    icon: 'dashboard',
    kind: 'page',
    priority: 120,
    featured: true,
    keywords: [
      '홈',
      '메인',
      'dashboard',
      '현황',
      '상태',
      '지표',
      '알림',
      '이상징후',
      '오늘 할 일',
      '할일',
      '모니터링',
      '운영',
      '관제',
      '리스크',
      '위험',
      '대기',
      '요약',
      '전체',
      'overview',
      'status',
      'health',
    ],
  },
  {
    id: 'admin:projects',
    label: '프로젝트',
    description: '프로젝트 목록, 담당조직, PM, 발주기관을 찾습니다.',
    category: '관리자',
    scope: 'admin',
    to: '/projects',
    icon: 'project',
    kind: 'page',
    priority: 118,
    featured: true,
    keywords: [
      '사업',
      '사업 목록',
      '프로젝트 목록',
      '검색',
      '담당조직',
      'CIC',
      'PM',
      '담당자',
      '발주기관',
      '계약기관',
      '진행중',
      '종료',
      '상세',
      '찾기',
      '목록',
      '리스트',
      '필터',
      '발주처',
      '클라이언트',
      '고객',
      '계약명',
      '공식명',
      '그룹웨어',
      '담당',
      '팀',
      '부서',
      '경기팀',
      '조직',
      '프로젝트 상세',
      '사업 상세',
      '종료 사업',
      '진행 사업',
      '정산대상',
      '해당없음',
    ],
  },
  {
    id: 'admin:project-registration',
    label: '프로젝트 등록/승인',
    description: '신규 등록, 수정 제출, CIC 검토, 계약서 PDF를 확인합니다.',
    category: '관리자',
    scope: 'admin',
    to: '/projects/migration-audit',
    icon: 'approval',
    kind: 'page',
    priority: 116,
    featured: true,
    keywords: [
      '등록',
      '승인',
      '신규 등록',
      '수정 제출',
      '다시 제출',
      'CIC',
      '대표자',
      '임원',
      '검토',
      '반려',
      '승인요청',
      '요청',
      'diff',
      '변경사항',
      '계약서',
      'PDF',
      '미리보기',
      '업로드',
      '프로젝트 승인',
      '등록 프로젝트 검토',
      '등록 요청',
      '등록신청',
      '프로젝트 등록 요청',
      '신청',
      '재제출',
      '재승인',
      '검토 요청',
      '검토대기',
      '승인대기',
      '승인 대기',
      '승인 대기열',
      '승인 큐',
      '승인 처리',
      '검수',
      '심사',
      '대표 검토',
      'CIC 대표',
      'CIC 검토',
      '담당조직 변경',
      '담당조직',
      '통화',
      '화폐',
      'USD',
      'KRW',
      '달러',
      '정산유형',
      '계약정보',
      '계약 금액',
      '계약금액',
      '계약기간',
      '서류',
      '파일',
      '첨부',
      '문서',
      '등록서류',
      '검토서류',
    ],
  },
  {
    id: 'admin:cashflow',
    label: '캐시플로 모니터링',
    description: '입금, 지출, 계약금, 지원금, 수익 흐름을 확인합니다.',
    category: '관리자',
    scope: 'admin',
    to: '/cashflow',
    icon: 'cashflow',
    kind: 'page',
    priority: 114,
    featured: true,
    keywords: [
      'cashflow',
      '캐시플로우',
      '현금흐름',
      '입금',
      '지출',
      '계약금',
      '중도금',
      '잔금',
      '지원금',
      '수익',
      '분할',
      '주간',
      '월간',
      '편차',
      '추출',
      '엑셀',
      'export',
      '라이브러리',
      '재무',
      '재무관리',
      '정산',
      '사업비',
      '사업비 입력',
      '사업비 관리',
      '예산',
      '예산 편성',
      '총예산',
      '예산총괄',
      '비목',
      '세목',
      '집행',
      '집행액',
      '잔액',
      '소진율',
      '은행',
      '통장',
      '통장내역',
      '입출금',
      '거래내역',
      '증빙',
      '영수증',
      '세금계산서',
      '부가세',
      'VAT',
      '매출',
      '매입',
      '공급가액',
      '공급대가',
      '계약금',
      '선금',
      '중도',
      '최종',
      '최종금',
      '수익금',
      'MYSC 수익',
      'MYSC 인건비',
      '선입금',
      'projection',
      '프로젝션',
      'cash flow',
      '다운로드',
    ],
  },
  {
    id: 'admin:users',
    label: '권한/사용자',
    description: '사용자, 역할, 조직장, 접근 권한을 관리합니다.',
    category: '관리자',
    scope: 'admin',
    to: '/users',
    icon: 'users',
    kind: 'page',
    priority: 112,
    featured: true,
    keywords: [
      '권한',
      '사용자',
      '유저',
      '멤버',
      '계정',
      '계정관리',
      'role',
      '역할',
      'admin',
      '관리자',
      'finance',
      '재무',
      'pm',
      'PM',
      'viewer',
      '뷰어',
      '조직장',
      '팀장',
      '리더',
      '접근',
      '접근권한',
      '초대',
      '로그인',
      '인증',
      'Google',
      '구글',
      'RBAC',
      'auth',
      '사용자 추가',
      '사용자 삭제',
      '권한 변경',
      '역할 변경',
    ],
  },
];

const PM_COMMAND_DEFINITIONS: AdminCommandItem[] = [
  {
    id: 'pm:budget',
    label: 'PM 예산총괄',
    description: '예산 배정, 소진, 잔액 현황을 조회합니다.',
    category: 'PM',
    scope: 'pm',
    to: '/portal/budget',
    icon: 'budget',
    kind: 'page',
    priority: 106,
    featured: true,
    keywords: ['예산', '예산총괄', '사업비', '사업비 계획', '비목', '세목', '예산 구성', '예산 항목', '총예산', '지원금', '수익'],
  },
  {
    id: 'pm:cashflow',
    label: 'PM 캐시플로',
    description: '주간 projection, 입금, 지출, 잔액 흐름을 입력합니다.',
    category: 'PM',
    scope: 'pm',
    to: '/portal/cashflow',
    icon: 'cashflow',
    kind: 'page',
    priority: 102,
    keywords: ['캐시플로', '캐시플로우', 'projection', '프로젝션', '주간', '입금', '지출', '잔액', '계약금', '중도금', '잔금', '수익', '지원금'],
  },
  {
    id: 'pm:project-edit',
    label: 'PM 프로젝트 수정',
    description: '등록된 프로젝트 정보를 수정 제출합니다.',
    category: 'PM',
    scope: 'pm',
    to: '/portal/edit-project',
    icon: 'approval',
    kind: 'page',
    priority: 96,
    keywords: ['프로젝트 수정', '사업 수정', '수정 제출', '다시 제출', '담당조직', '계약서', '계약정보', 'CIC', '검토', '반려', '재제출'],
  },
  {
    id: 'pm:project-register',
    label: 'PM 프로젝트 등록 요청',
    description: '신규 프로젝트 등록 요청과 계약서 첨부를 시작합니다.',
    category: 'PM',
    scope: 'pm',
    to: '/portal/register-project',
    icon: 'project',
    kind: 'page',
    priority: 94,
    keywords: ['프로젝트 등록', '사업 등록', '등록 요청', '신규 등록', '계약서', 'PDF', '첨부', '발주기관', '담당조직', 'CIC', '통화', 'USD', 'KRW'],
  },
  {
    id: 'pm:my-page',
    label: 'PM 마이페이지',
    description: '내 인사정보를 확인하고 학력·어학·자격을 증빙과 함께 등록합니다.',
    category: 'PM',
    scope: 'pm',
    to: '/portal/career-profile',
    icon: 'users',
    kind: 'page',
    priority: 92,
    keywords: ['마이페이지', '내 정보', '인사정보', '프로필', '학력', '어학', '토익', '자격증', '증빙', '닉네임', '생년월일', '근무지'],
  },
];

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeSearchText(value).split(' ').filter(Boolean);
}

function compactStrings(values: Array<string | null | undefined>): string[] {
  return values.map((value) => String(value || '').trim()).filter(Boolean);
}

export function buildAdminCommandItems(input: BuildAdminCommandItemsInput): AdminCommandItem[] {
  const staticItems = ADMIN_COMMAND_DEFINITIONS.filter((item) => canShowAdminNavItem(input.role, item.to));
  const pmItems = PM_COMMAND_DEFINITIONS.filter(() => canShowAdminNavItem(input.role, '/portal'));

  const projectItems = input.projects.slice(0, input.projectLimit ?? 30).map((project, index): AdminCommandItem => ({
    id: `project:${project.id}`,
    label: project.name,
    description: compactStrings([project.department, project.clientOrg, project.managerName]).join(' · '),
    category: '관리자',
    scope: 'admin',
    to: `/projects/${project.id}`,
    icon: 'project',
    kind: 'project',
    priority: 40 - index,
    keywords: compactStrings([
      project.id,
      project.name,
      project.shortName,
      project.officialContractName,
      project.groupwareName,
      project.department,
      project.clientOrg,
      project.managerName,
      '프로젝트',
      '사업',
      '상세',
      '계약서',
      '담당자',
      '담당조직',
      'CIC',
      'PM',
      '담당자',
      '발주기관',
      '계약기관',
      '계약명',
      '공식명',
      '그룹웨어명',
      '클라이언트',
      '고객',
      '계약서',
      'PDF',
      '캐시플로',
      '예산',
      '사업비',
      '정산',
    ]),
  }));

  return [...staticItems, ...pmItems, ...projectItems];
}

function isProjectRegistrationIntent(normalizedQuery: string): boolean {
  if (!normalizedQuery) return false;
  if (!normalizedQuery.includes('등록')) return false;
  return [
    '프로젝트',
    '사업',
    '신규',
    '요청',
    '승인',
  ].some((keyword) => normalizedQuery.includes(keyword));
}

function scoreCommandItem(item: AdminCommandItem, query: string): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return item.priority;

  const tokens = tokenize(query);
  const label = normalizeSearchText(item.label);
  const description = normalizeSearchText(item.description || '');
  const category = normalizeSearchText(item.category);
  const keywords = item.keywords.map(normalizeSearchText);
  const haystack = [label, description, category, ...keywords].filter(Boolean).join(' ');

  if (!tokens.every((token) => haystack.includes(token))) return 0;

  let score = item.priority;
  if (label === normalizedQuery) score += 120;
  else if (label.startsWith(normalizedQuery)) score += 95;
  else if (label.includes(normalizedQuery)) score += 80;

  if (keywords.some((keyword) => keyword === normalizedQuery)) score += 75;
  else if (keywords.some((keyword) => keyword.includes(normalizedQuery))) score += 55;

  if (description.includes(normalizedQuery)) score += 35;
  if (category.includes(normalizedQuery)) score += 20;
  if (item.featured) score += 12;
  if (item.kind === 'project') score += 8;

  score += tokens.length * 3;
  return score;
}

export function searchAdminCommandItems(
  items: AdminCommandItem[],
  query: string,
  limit = 12,
): AdminCommandItem[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return [...items]
      .sort((a, b) => Number(b.featured) - Number(a.featured) || b.priority - a.priority)
      .slice(0, limit);
  }

  const candidates = isProjectRegistrationIntent(normalizedQuery)
    ? items.filter((item) => item.kind !== 'project')
    : items;

  return candidates
    .map((item) => ({ item, score: scoreCommandItem(item, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.priority - a.item.priority || a.item.label.localeCompare(b.item.label))
    .slice(0, limit)
    .map((entry) => entry.item);
}
