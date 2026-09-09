// ═══════════════════════════════════════════════════════════════
// MYSC 사업관리 통합 플랫폼 — TypeScript Type Definitions
// Firestore 스키마와 1:1 매핑
// ═══════════════════════════════════════════════════════════════

import cashflowPolicyData from '../../../policies/cashflow-policy.json';

// ── Enums ──

export type UserRole = 'admin' | 'finance' | 'pm' | 'viewer';

export type ProjectStatus = 'CONTRACT_PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'COMPLETED_PENDING_PAYMENT';
export type ProjectType =
  | 'C1'  // 컨설팅
  | 'A1'  // 액셀러레이팅 - 국내일반
  | 'A2'  // 액셀러레이팅 - 글로벌
  | 'I1'  // 투자조합운용 - GP성과보수
  | 'I2'  // 투자조합운용 - GP관리보수
  | 'I3'  // 투자조합운용 - LP수익
  | 'D1'  // 개발협력사업 - AVPN 포함
  | 'S1'  // 공간사업 - 메리히어
  | 'S2'  // 공간사업 - 공간운영 용역사업
  | 'E1'  // 교육사업 - 단기 워크숍 등
  | 'P1'  // 출판사업
  | 'Z1'; // 기타사업
export type ProjectPhase = 'PROSPECT' | 'CONFIRMED';  // 입찰예정 / 확정

export type SettlementType = 'TYPE1' | 'TYPE2' | 'TYPE3' | 'TYPE4' | 'TYPE5' | 'NONE';
export type Basis = '공급가액' | '공급대가' | '기타' | 'NONE';
export type ProjectCurrency = 'KRW' | 'USD';

export type AccountType = 'DEDICATED' | 'OPERATING' | 'NONE' | 'OTHER'; // 전용계좌 사업(이나라도움) / 전용계좌(이나라도움x) / 일반 사업 / 기타
export type InterestRefundPolicy = 'REFUND' | 'USE_AS_PROJECT_EXPENSE' | 'MYSC_REVENUE' | 'REVIEW_LATER';
export type ProjectFundInputMode = 'BANK_UPLOAD' | 'DIRECT_ENTRY';
export type SettlementSheetPolicyPreset = 'STANDARD' | 'DIRECT_ENTRY' | 'BALANCE_TRACKING';
export type SettlementSheetDerivedField = 'balance' | 'expenseAmount' | 'bankAmount' | 'vatIn';

export type TransactionState = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
export type Direction = 'IN' | 'OUT';
export type PaymentMethod = 'TRANSFER' | 'CORP_CARD_1' | 'CORP_CARD_2' | 'OTHER';
export type SettlementEntryKind = 'STANDARD' | 'DEPOSIT' | 'EXPENSE' | 'ADJUSTMENT';

export type EvidenceStatus = 'MISSING' | 'PARTIAL' | 'COMPLETE';

export const PROJECT_CURRENCY_LABELS: Record<ProjectCurrency, string> = {
  KRW: 'KRW',
  USD: 'USD',
};

export function normalizeProjectCurrency(raw: unknown): ProjectCurrency {
  return raw === 'USD' ? 'USD' : 'KRW';
}

export type CashflowCategory =
  | 'CONTRACT_PAYMENT'    // 계약금
  | 'INTERIM_PAYMENT'     // 중도금
  | 'FINAL_PAYMENT'       // 잔금
  | 'LABOR_COST'          // 인건비
  | 'OUTSOURCING'         // 외주비
  | 'EQUIPMENT'           // 장비구입비
  | 'TRAVEL'              // 출장비
  | 'SUPPLIES'            // 소모품비
  | 'COMMUNICATION'       // 통신비
  | 'RENT'                // 임차료
  | 'UTILITY'             // 공과금
  | 'TAX_PAYMENT'         // 세금납부
  | 'VAT_REFUND'          // 부가세환급
  | 'INSURANCE'           // 보험료
  | 'MISC_INCOME'         // 기타수입
  | 'MISC_EXPENSE';       // 기타지출

export const CASHFLOW_CATEGORY_LABELS: Record<CashflowCategory, string> = Object.fromEntries(
  cashflowPolicyData.categoryEntries.map((entry) => [entry.category, entry.label]),
) as Record<CashflowCategory, string>;

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  CONTRACT_PENDING: '계약 전',
  IN_PROGRESS: '진행 중',
  COMPLETED: '완료',
  COMPLETED_PENDING_PAYMENT: '완료(잔금 대기)',
};

export function normalizeProjectStatus(raw: unknown): ProjectStatus {
  if (
    raw === 'CONTRACT_PENDING'
    || raw === 'IN_PROGRESS'
    || raw === 'COMPLETED'
    || raw === 'COMPLETED_PENDING_PAYMENT'
  ) {
    return raw;
  }
  return 'CONTRACT_PENDING';
}

export const PROJECT_PHASE_LABELS: Record<ProjectPhase, string> = {
  PROSPECT: '입찰/예정',
  CONFIRMED: '확정',
};

export function normalizeProjectPhase(raw: unknown): ProjectPhase {
  if (raw === 'PROSPECT' || raw === 'CONFIRMED') return raw;
  return 'CONFIRMED';
}

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  C1: 'C-1 컨설팅',
  A1: 'A-1 액셀러레이팅 - 국내일반',
  A2: 'A-2 액셀러레이팅 - 글로벌',
  I1: 'I-1 투자조합운용',
  I2: 'I-2 투자조합운용 - GP관리보수',
  I3: 'I-3 투자조합운용 - LP수익',
  D1: 'D-1 개발협력사업 - AVPN 포함',
  S1: 'S-1 공간사업 - 메리히어',
  S2: 'S-2 공간사업 - 공간운영 용역사업',
  E1: 'E-1 교육사업 - 단기 워크숍 등',
  P1: 'P-1 출판사업',
  Z1: 'Z-1 기타사업',
};

export function normalizeProjectType(raw: unknown): ProjectType {
  const value = String(raw || '').trim();
  if (value in PROJECT_TYPE_LABELS) return value as ProjectType;
  return 'D1';
}

export const PROJECT_TYPE_SHORT_LABELS: Record<ProjectType, string> = {
  C1: '컨설팅',
  A1: 'AC 국내',
  A2: 'AC 글로벌',
  I1: '투자조합운용',
  I2: '투자 GP관리',
  I3: '투자 LP수익',
  D1: '개발협력',
  S1: '공간사업(메리히어)',
  S2: '공간사업(용역)',
  E1: '교육사업',
  P1: '출판사업',
  Z1: '기타',
};

export const SETTLEMENT_TYPE_LABELS: Record<SettlementType, string> = {
  TYPE1: 'Type1. 세금계산서발행+공급가액',
  TYPE2: 'Type2. 세금계산서발행+공급대가',
  TYPE3: 'Type3. 세금계산서미발행 + 공급가액',
  TYPE4: 'Type4. 세금계산서미발행+공급대가',
  TYPE5: 'Type5. 이나라도움+공급가액',
  NONE: '정산 없음',
};

export const SETTLEMENT_TYPE_SHORT: Record<SettlementType, string> = {
  TYPE1: 'Type1',
  TYPE2: 'Type2',
  TYPE3: 'Type3',
  TYPE4: 'Type4',
  TYPE5: 'Type5',
  NONE: '정산 없음',
};

export const BASIS_LABELS: Record<Basis, string> = {
  '공급가액': '공급가액 기준',
  '공급대가': '공급대가 기준',
  기타: '기타',
  NONE: '정산 없음',
};

export const REGISTRATION_V2_BASIS_LABELS: Record<Exclude<Basis, '기타'>, string> = {
  '공급가액': '공급가액 정산',
  '공급대가': '공급대가 정산',
  NONE: '정산 없음',
};

export function normalizeSettlementType(raw: unknown): SettlementType {
  if (raw === 'TYPE1' || raw === 'TYPE2' || raw === 'TYPE3' || raw === 'TYPE4' || raw === 'TYPE5') return raw;
  return 'NONE';
}

/** Firestore 하위호환: 구 영문 enum도 인식 */
export function normalizeBasis(raw: unknown): Basis {
  if (raw === 'SUPPLY_AMOUNT' || raw === '공급가액') return '공급가액';
  if (raw === 'SUPPLY_PRICE' || raw === '공급대가') return '공급대가';
  if (raw === 'OTHER' || raw === '기타') return '기타';
  return 'NONE';
}

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  DEDICATED: '전용계좌 사업(이나라도움)',
  OPERATING: '전용계좌(이나라도움x)',
  NONE: '일반사업(MYSC법인통장)',
  OTHER: '기타',
};

export const INTEREST_REFUND_POLICY_LABELS: Record<InterestRefundPolicy, string> = {
  REFUND: '반납',
  USE_AS_PROJECT_EXPENSE: '사업비로 모두 사용 (미사용액 반납)',
  MYSC_REVENUE: 'MYSC 수익화',
  REVIEW_LATER: '확인 필요 (이후 업데이트 하겠음)',
};

export function normalizeInterestRefundPolicy(raw: unknown): InterestRefundPolicy | '' {
  return raw === 'REFUND'
    || raw === 'USE_AS_PROJECT_EXPENSE'
    || raw === 'MYSC_REVENUE'
    || raw === 'REVIEW_LATER'
    ? raw
    : '';
}

export function normalizeAccountType(raw: unknown): AccountType {
  if (raw === 'DEDICATED' || raw === 'OPERATING' || raw === 'OTHER') return raw;
  return 'NONE';
}

export const PROJECT_FUND_INPUT_MODE_LABELS: Record<ProjectFundInputMode, string> = {
  BANK_UPLOAD: '통장내역 업로드',
  DIRECT_ENTRY: '직접 입력',
};

export function normalizeProjectFundInputMode(raw: unknown): ProjectFundInputMode {
  if (raw === 'DIRECT_ENTRY') return 'DIRECT_ENTRY';
  return 'BANK_UPLOAD';
}

export interface SettlementSheetPolicy {
  preset: SettlementSheetPolicyPreset;
  allowAdjustmentRows: boolean;
  allowRowDelete: boolean;
  autoComputeBalance: boolean;
  autoComputeExpenseFromBank: boolean;
  autoComputeBankFromExpense: boolean;
  requireCounterparty: boolean;
  requireNoteForAdjustment: boolean;
  requireEvidenceBeforeSubmit: boolean;
  preserveExplicitZero: boolean;
  readOnlyDerivedFields: SettlementSheetDerivedField[];
}

export const SETTLEMENT_SHEET_POLICY_PRESET_LABELS: Record<SettlementSheetPolicyPreset, string> = {
  STANDARD: '표준형',
  DIRECT_ENTRY: '직접 입력형',
  BALANCE_TRACKING: '잔액 추적형',
};

export const SETTLEMENT_SHEET_POLICY_PRESET_DESCRIPTIONS: Record<SettlementSheetPolicyPreset, string> = {
  STANDARD: '통장내역 업로드와 자동 계산 보조를 함께 사용하는 기본 운영 방식',
  DIRECT_ENTRY: 'PM이 직접 입력하고 시스템은 계산만 보조하는 방식',
  BALANCE_TRACKING: '입금·지출·잔액 흐름을 중심으로 관리하는 방식',
};

const SETTLEMENT_SHEET_POLICY_PRESETS: Record<SettlementSheetPolicyPreset, SettlementSheetPolicy> = {
  STANDARD: {
    preset: 'STANDARD',
    allowAdjustmentRows: false,
    allowRowDelete: true,
    autoComputeBalance: true,
    autoComputeExpenseFromBank: true,
    autoComputeBankFromExpense: true,
    requireCounterparty: true,
    requireNoteForAdjustment: true,
    requireEvidenceBeforeSubmit: false,
    preserveExplicitZero: true,
    readOnlyDerivedFields: [],
  },
  DIRECT_ENTRY: {
    preset: 'DIRECT_ENTRY',
    allowAdjustmentRows: true,
    allowRowDelete: true,
    autoComputeBalance: true,
    autoComputeExpenseFromBank: false,
    autoComputeBankFromExpense: true,
    requireCounterparty: true,
    requireNoteForAdjustment: true,
    requireEvidenceBeforeSubmit: false,
    preserveExplicitZero: true,
    readOnlyDerivedFields: ['balance'],
  },
  BALANCE_TRACKING: {
    preset: 'BALANCE_TRACKING',
    allowAdjustmentRows: true,
    allowRowDelete: false,
    autoComputeBalance: true,
    autoComputeExpenseFromBank: false,
    autoComputeBankFromExpense: true,
    requireCounterparty: true,
    requireNoteForAdjustment: true,
    requireEvidenceBeforeSubmit: false,
    preserveExplicitZero: true,
    readOnlyDerivedFields: ['balance', 'expenseAmount', 'bankAmount', 'vatIn'],
  },
};

export function createSettlementSheetPolicy(
  preset: SettlementSheetPolicyPreset = 'STANDARD',
): SettlementSheetPolicy {
  return {
    ...SETTLEMENT_SHEET_POLICY_PRESETS[preset],
    readOnlyDerivedFields: [...SETTLEMENT_SHEET_POLICY_PRESETS[preset].readOnlyDerivedFields],
  };
}

export function getDefaultSettlementSheetPolicyForFundInputMode(
  mode: ProjectFundInputMode | null | undefined,
): SettlementSheetPolicy {
  return mode === 'DIRECT_ENTRY'
    ? createSettlementSheetPolicy('DIRECT_ENTRY')
    : createSettlementSheetPolicy('STANDARD');
}

export function normalizeSettlementSheetPolicy(
  raw: SettlementSheetPolicy | null | undefined,
  fundInputMode?: ProjectFundInputMode | null,
): SettlementSheetPolicy {
  const preset = raw?.preset && raw.preset in SETTLEMENT_SHEET_POLICY_PRESETS
    ? raw.preset
    : getDefaultSettlementSheetPolicyForFundInputMode(fundInputMode).preset;
  const base = createSettlementSheetPolicy(preset);
  return {
    ...base,
    ...(raw || {}),
    preset,
    readOnlyDerivedFields: Array.isArray(raw?.readOnlyDerivedFields)
      ? raw.readOnlyDerivedFields.filter((field): field is SettlementSheetDerivedField => (
        field === 'balance' || field === 'expenseAmount' || field === 'bankAmount' || field === 'vatIn'
      ))
      : base.readOnlyDerivedFields,
  };
}

export function formatSettlementSheetPolicySummary(policy: SettlementSheetPolicy): string {
  return [
    SETTLEMENT_SHEET_POLICY_PRESET_LABELS[policy.preset],
    `잔액 자동 계산 ${policy.autoComputeBalance ? 'ON' : 'OFF'}`,
    `조정행 ${policy.allowAdjustmentRows ? '허용' : '숨김'}`,
  ].join(' · ');
}

export interface ProjectFinancialInputFlags {
  contractAmount?: boolean;
  salesVatAmount?: boolean;
  totalRevenueAmount?: boolean;
  totalActualCost?: boolean;
  supportAmount?: boolean;
}

export const PROJECT_TYPE_REGISTER_OPTIONS: ProjectType[] = [
  'C1',
  'A1',
  'A2',
  'I1',
  'I2',
  'I3',
  'D1',
  'S1',
  'S2',
  'E1',
  'P1',
  'Z1',
];

export function getProjectTypeSelectableOptions(currentType?: ProjectType): ProjectType[] {
  if (!currentType || PROJECT_TYPE_REGISTER_OPTIONS.includes(currentType)) {
    return [...PROJECT_TYPE_REGISTER_OPTIONS];
  }
  const next = [...PROJECT_TYPE_REGISTER_OPTIONS];
  const insertIndex = currentType === 'I2' || currentType === 'I3'
    ? next.indexOf('I1') + 1
    : next.length;
  next.splice(insertIndex, 0, currentType);
  return next;
}

export const PROJECT_CONTRACT_TYPE_OPTIONS = [
  '계약서(날인)',
  '협약서(날인)',
  '전자계약 시스템',
  '기타',
] as const;

export function normalizeProjectContractType(raw: unknown): string {
  const value = String(raw || '').trim();
  if (!value) return '계약서(날인)';
  if (value === '계약서') return '계약서(날인)';
  if (value === '협약서') return '협약서(날인)';
  if (value === '발주기관 전자시스템') return '전자계약 시스템';
  if (value === '일반') return '기타';
  return value;
}

export function getProjectContractTypeSelectableOptions(currentType?: string): string[] {
  const current = normalizeProjectContractType(currentType);
  const options = [...PROJECT_CONTRACT_TYPE_OPTIONS];
  return options.includes(current as (typeof PROJECT_CONTRACT_TYPE_OPTIONS)[number])
    ? options
    : [current, ...options];
}

export const DIRECTION_LABELS: Record<Direction, string> = {
  IN: '입금',
  OUT: '출금',
};

export const TX_STATE_LABELS: Record<TransactionState, string> = {
  DRAFT: '작성중',
  SUBMITTED: '제출완료',
  APPROVED: '승인',
  REJECTED: '반려',
};

export const EVIDENCE_STATUS_LABELS: Record<EvidenceStatus, string> = {
  MISSING: '미제출',
  PARTIAL: '일부제출',
  COMPLETE: '완료',
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  TRANSFER: '계좌이체',
  CORP_CARD_1: '사업비카드',
  CORP_CARD_2: '개인법인카드',
  OTHER: '기타',
};

// ── 참여율 관리 (Participation Rate) ──

export type SettlementSystemCode =
  | 'E_NARA_DOUM'   // e나라도움 (국고보조금통합관리시스템)
  | 'IRIS'           // 범부처통합연구지원시스템
  | 'RCMS'           // 실시간연구비통합관리시스템
  | 'EZBARO'         // 이지바로
  | 'E_HIJO'         // e호조 (지방재정관리시스템)
  | 'EDUFINE'        // 에듀파인 (교육청 예산)
  | 'HAPPYEUM'       // 행복이음/희망이음 (사회보장정보시스템)
  | 'AGRIX'          // 아그릭스 (농림사업정보시스템)
  | 'BOTAEM_E'       // 보탬e (지방보조금관리시스템)
  | 'SMTECH'         // 중소기업기술개발사업 종합관리시스템
  | 'KOCCA_PMS'      // 한국콘텐츠진흥원 사업관리시스템
  | 'NIPA'           // 정보통신산업진흥원 사업관리시스템
  | 'ACCOUNTANT'     // 회계사정산 (전문 회계법인 정산)
  | 'PRIVATE'        // 민간사업
  | 'OTHER'          // 기타 직접 입력
  | 'NONE';          // 미정/없음

export type LaborSettlementBasis =
  | 'INCLUDE_ACTUAL_SALARY'
  | 'EXCLUDE_ACTUAL_SALARY'
  | 'FIXED_AMOUNT'
  | 'NONE';

export interface ProjectPaymentExpectedMonths {
  contract: string;
  interim: string;
  final: string;
}

export type ProjectLaborTransferMode = 'UNDECIDED' | 'MONTHLY_WEEK_3' | 'PAYMENT_MILESTONE';

export interface ProjectLaborTransferPlan {
  mode: ProjectLaborTransferMode;
  milestoneAmounts: {
    contract: number;
    interim: number;
    final: number;
  };
}

export const SETTLEMENT_SYSTEM_LABELS: Record<SettlementSystemCode, string> = {
  E_NARA_DOUM: 'e나라도움 (국고보조금통합관리시스템)',
  IRIS: 'IRIS(범부처통합연구지원시스템)',
  RCMS: 'RCMS (실시간연구비관리시스템)',
  EZBARO: '통합이지바로 (통합 Ez-plus)',
  E_HIJO: 'e호조 (지방재정)',
  EDUFINE: '에듀파인 (교육재정)',
  HAPPYEUM: '행복이음 (사회보장)',
  AGRIX: '아그릭스 (농림사업)',
  BOTAEM_E: '보탬e(지방보조금관리시스템)',
  SMTECH: 'SMTECH (중소기업기술개발사업종합관리시스템)',
  KOCCA_PMS: 'KOCCA PMS',
  NIPA: 'NIPA 사업관리시스템',
  ACCOUNTANT: '회계사정산',
  PRIVATE: '민간사업',
  OTHER: '기타',
  NONE: '시스템 미사용',
};

export const PROJECT_SETTLEMENT_SYSTEM_CODES: SettlementSystemCode[] = [
  'NONE',
  'E_NARA_DOUM',
  'BOTAEM_E',
  'RCMS',
  'EZBARO',
  'SMTECH',
  'KOCCA_PMS',
  'NIPA',
  'IRIS',
  'OTHER',
];

export const SETTLEMENT_SYSTEM_SHORT: Record<SettlementSystemCode, string> = {
  E_NARA_DOUM: 'e나라도움',
  IRIS: 'IRIS',
  RCMS: 'RCMS',
  EZBARO: '통합이지바로',
  E_HIJO: 'e호조',
  EDUFINE: '에듀파인',
  HAPPYEUM: '행복이음',
  AGRIX: '아그릭스',
  BOTAEM_E: '보탬e',
  SMTECH: 'SMTECH',
  KOCCA_PMS: 'KOCCA PMS',
  NIPA: 'NIPA',
  ACCOUNTANT: '회계사정산',
  PRIVATE: '민간',
  OTHER: '기타',
  NONE: '정산없음',
};

export const LABOR_SETTLEMENT_BASIS_LABELS: Record<LaborSettlementBasis, string> = {
  INCLUDE_ACTUAL_SALARY: '4대보험, 퇴직금 포함 실급여',
  EXCLUDE_ACTUAL_SALARY: '4대보험, 퇴직금 제외 실급여',
  FIXED_AMOUNT: '정액정산',
  NONE: '정산없음',
};

export function normalizeSettlementSystemCode(raw: unknown): SettlementSystemCode {
  const value = String(raw || '').trim();
  return value in SETTLEMENT_SYSTEM_LABELS ? value as SettlementSystemCode : 'NONE';
}

export function normalizeLaborSettlementBasis(raw: unknown): LaborSettlementBasis {
  const value = String(raw || '').trim();
  return value in LABOR_SETTLEMENT_BASIS_LABELS ? value as LaborSettlementBasis : 'NONE';
}

export type ProjectPhaseStatus = '계약전' | '계약완료' | '계약완료(변경진행중)';

export interface ParticipationProject {
  id: string;
  name: string;
  shortName: string;
  clientOrg: string;
  settlement: SettlementSystemCode;
  settlementNote: string;
  phase: ProjectPhaseStatus;
  periodDesc: string;
}

export interface MyscEmployee {
  id: string;
  realName: string;
  nickname: string;
}

/**
 * 참여율 항목: 한 직원이 한 프로젝트에 배정된 참여율
 */
export interface ParticipationEntry {
  id: string;
  /** People SSOT. Legacy rows may not have this until backfill completes. */
  personId?: string;
  memberId: string;
  memberName: string;
  projectId: string;
  projectName: string;
  projectShortName?: string;
  rate: number;                          // 0~100 (%)
  settlementSystem: SettlementSystemCode;
  clientOrg: string;                     // 발주기관
  periodStart: string;                   // YYYY-MM
  periodEnd: string;                     // YYYY-MM
  isDocumentOnly: boolean;               // 서류상 인력 여부
  note: string;
  source?: 'MANUAL' | 'PROJECT_TEAM_SYNC';
  projectTeamMemberKey?: string;
  /** YYYY-MM별 서류 참여율. null은 원본 시트 미입력, 0은 명시적 0%다. */
  monthlyRates?: Record<string, number | null>;
  updatedAt: string;
}

// ── Interfaces ──

export interface OrgMember {
  uid: string;
  /**
   * Legacy combined display string, historically '이름(별명)'. Several sign-in paths still
   * write this field, so screens should prefer nameKo and nickname when they are present.
   */
  name: string;
  /** Owned by the employee roster import. */
  nameKo?: string;
  /** Owned by the employee roster import. */
  nickname?: string;
  email: string;
  role: UserRole;
  status?: string;
  avatarUrl?: string;
}

export interface Organization {
  id: string;
  name: string;
  createdAt: string;
  members: OrgMember[];
}

export interface LedgerTemplate {
  id: string;
  orgId: string;
  name: string;
  version: number;
  cashflowEnums: CashflowCategory[];
  evidenceRules: string[];         // 필수 증빙 체크리스트 항목명
  approvalThreshold: number;       // 이 금액 이상이면 승인 필요
  defaultBasis: Basis;
  allowedSettlementTypes: SettlementType[];
  createdAt: string;
}

export interface ProjectFinancialYear {
  year: number;
  contractAmount: number;
  salesVatAmount: number;
  totalRevenueAmount: number;
  totalActualCost: number;
  supportAmount: number;
  profitRate: number;
  confirmed: boolean;
  paymentPlan?: Project['paymentPlan'];
  paymentExpectedMonths?: ProjectPaymentExpectedMonths;
  finalPaymentExpectedWeek?: string;
  advanceInterimBelow70Reason?: string;
  isSettled?: boolean;
}

export interface ProjectRegistrationConfirmations {
  laborIncludesFourInsurance: boolean | null;
  laborIncludesRetirementPay: boolean | null;
  customerSettlementBasisConfirmed: boolean;
  modusignContractUsed: boolean | null;
  originalContractSubmitted: boolean | null;
  proposalPptOriginal?: string;
  presentationPptOriginal?: string;
}

export interface ProjectRegistrationOptionalDocumentNotes {
  proposalWordOriginal: string;
  proposalPptOriginal: string;
  presentationPptOriginal: string;
}

export interface ProjectCheckout {
  finalPaymentReceived: boolean;
  bankBalanceZero: boolean;
  performanceCertificateReceived: boolean;
  performanceCertificateDocumentApplicable?: boolean;
  taxInvoiceEvidenceConfirmed: boolean;
  finalSettlementReportConfirmed: boolean;
  usbEvidenceSubmitted: boolean;
  evidenceDeletedAfterUsb: boolean;
}

export interface Project {
  id: string;
  version?: number;
  slug: string;        // URL-safe unique key
  orgId: string;
  cic?: string;
  registrationSource?: string;
  registeredById?: string;
  registeredByName?: string;
  registeredByEmail?: string;
  executiveApproverId?: string;
  executiveApproverName?: string;
  executiveApproverEmail?: string;
  projectCode?: string;
  registeredAt?: string;
  executiveReviewStatus?: ProjectExecutiveReviewStatus;
  executiveReviewedAt?: string | null;
  executiveReviewedById?: string | null;
  executiveReviewedByName?: string | null;
  executiveReviewComment?: string | null;
  executiveReviewHistory?: ProjectExecutiveReviewHistoryEntry[];
  managementPlanningReviewStatus?: ProjectManagementPlanningReviewStatus;
  managementPlanningReviewedAt?: string | null;
  managementPlanningReviewedById?: string | null;
  managementPlanningReviewedByName?: string | null;
  managementPlanningReviewComment?: string | null;
  managementPlanningReviewHistory?: ProjectManagementPlanningReviewHistoryEntry[];
  projectCodeKey?: string | null;
  trashedAt?: string | null;
  trashedById?: string | null;
  trashedByEmail?: string | null;
  trashedReason?: string | null;
  name: string;
  shortName?: string;
  officialContractName?: string;
  status: ProjectStatus;
  type: ProjectType;
  phase: ProjectPhase;
  currency?: ProjectCurrency;
  contractAmount: number;        // 총 사업비 금액(매출부가세 포함)
  contractStart: string;
  contractEnd: string;
  contractEndUndecided?: boolean;
  settlementType: SettlementType;
  basis: Basis;
  accountType: AccountType;      // 전용통장/운영통장
  interestRefundPolicy?: InterestRefundPolicy;
  settlementSystem?: SettlementSystemCode;
  settlementSystemOther?: string;
  laborSettlementBasis?: LaborSettlementBasis;
  fundInputMode?: ProjectFundInputMode;
  settlementSheetPolicy?: SettlementSheetPolicy;
  // 입금계획
  paymentPlan: {
    contract: number;    // 계약금
    interim: number;     // 중도금
    final: number;       // 잔금
  };
  paymentExpectedMonths?: ProjectPaymentExpectedMonths;
  finalPaymentExpectedWeek?: string;
  laborTransferPlan?: ProjectLaborTransferPlan;
  advanceInterimBelow70Reason?: string;
  paymentPlanDesc: string;       // 입금계획 텍스트 (e.g. "선금80%, 잔금20%")
  // MYSC-specific fields
  clientOrg: string;             // 발주기관(계약기관)
  businessManagementGoogleFolderLink?: string;
  participationSheetLink?: string; // 참여율 입력 시트(표준양식 사본) 링크
  groupwareName: string;         // 그룹웨어 프로젝트등록명
  participantCondition: string;  // 참여기업 조건
  note?: string;                  // PM/관리자 참고 메모
  teamMembersDetailed?: ProjectTeamMemberAssignment[];
  staffing?: ProjectStaffing;    // 실제 투입인력 (총괄·실무책임자·운영매니저·정산지원)
  contractType: string;          // 계약서 유형 (계약서(날인), 기타 등)
  projectPurpose?: string;
  totalRevenueAmount?: number;
  totalActualCost?: number;
  supportAmount?: number;
  salesVatAmount?: number;
  financialInputFlags?: ProjectFinancialInputFlags;
  registrationRequirementsVersion?: 1 | 2;
  financialYears?: ProjectFinancialYear[];
  registrationConfirmations?: ProjectRegistrationConfirmations;
  registrationOptionalDocumentNotes?: ProjectRegistrationOptionalDocumentNotes;
  checkout?: ProjectCheckout;
  settlementGuide?: string;
  contractDocument?: FileAttachment | null;
  quoteDocument?: FileAttachment | null;
  quoteSubmissionDeferred?: boolean;
  proposalDocument?: FileAttachment | null;
  proposalWordOriginalDocument?: FileAttachment | null;
  proposalPptOriginalDocument?: FileAttachment | null;
  presentationPptOriginalDocument?: FileAttachment | null;
  rfpRequestEvidenceDocument?: FileAttachment | null;
  customerBusinessRegistrationDocument?: FileAttachment | null;
  performanceCertificateDocument?: FileAttachment | null;
  taxInvoiceDocument?: FileAttachment | null;
  finalSettlementReportDocument?: FileAttachment | null;
  finalReportDocument?: FileAttachment | null;
  contractAnalysis?: ProjectRequestContractAnalysis | null;
  // 팀/담당자
  department: string;            // 담당조직
  teamName: string;              // 사내기업팀 (팀장)
  managerId: string;             // PM uid
  managerName: string;           // 메인 담당자
  settlementSupportId?: string;
  settlementSupportName?: string;
  // 재무
  budgetCurrentYear: number;     // 2026년 총사업비(매출부가세 포함)
  taxInvoiceAmount: number;      // 2025년 세금계산서 금액
  profitRate: number;            // 수익률 (소수점, e.g. 0.5918)
  profitAmount: number;          // 수익금액
  isSettled: boolean;            // 사업정산 여부
  finalPaymentNote: string;      // 잔금입금여부/메모
  // 대시보드 가이드 체크리스트
  confirmerName: string;         // 확인자 닉네임 (센터장/그룹장)
  lastCheckedAt: string;         // 마지막 확인 일시
  cashflowDiffNote: string;      // 입출금합계 차이 사유
  // 증빙 Shared Drive
  evidenceDriveSharedDriveId?: string;
  evidenceDriveRootFolderId?: string;
  evidenceDriveRootFolderName?: string;
  evidenceDriveRootFolderLink?: string;
  evidenceDriveProvisionedAt?: string;
  // 메타
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export type ProjectRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type ProjectExecutiveReviewStatus = 'PENDING' | 'PLANNING_AGREED' | 'APPROVED' | 'REVISION_REJECTED' | 'DUPLICATE_DISCARDED';
export type ProjectRequestReviewOutcome = 'APPROVED' | 'REVISION_REJECTED' | 'DUPLICATE_DISCARDED';
export type ProjectRequestKind = 'REGISTRATION' | 'CHANGE';

export interface ProjectReviewFieldChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

export interface ProjectExecutiveReviewHistoryEntry {
  status: ProjectExecutiveReviewStatus;
  previousStatus?: ProjectExecutiveReviewStatus | null;
  reviewedAt: string;
  reviewedById: string;
  reviewedByName: string;
  reviewComment?: string | null;
  projectCode?: string;
  changes?: ProjectReviewFieldChange[];
}

export type ProjectManagementPlanningReviewStatus = 'PENDING' | 'AGREED' | 'REVISION_REJECTED';

export interface ProjectManagementPlanningReviewHistoryEntry {
  status: ProjectManagementPlanningReviewStatus;
  previousStatus?: ProjectManagementPlanningReviewStatus | null;
  reviewedAt: string;
  reviewedById: string;
  reviewedByName: string;
  reviewComment?: string | null;
  projectCode?: string | null;
}

export interface FileAttachment {
  path: string;
  name: string;
  downloadURL: string;
  size: number;
  contentType: string;
  uploadedAt: string;
}

export type ProjectSheetSourceType =
  | 'usage'
  | 'budget'
  | 'evidence_rules'
  | 'cashflow'
  | 'bank_statement';

export interface ProjectSheetSourceSnapshot {
  sourceType: ProjectSheetSourceType;
  projectId: string;
  sheetName: string;
  fileName: string;
  storagePath: string;
  downloadURL: string;
  contentType: string;
  uploadedAt: string;
  rowCount: number;
  columnCount: number;
  matchedColumns: string[];
  unmatchedColumns: string[];
  previewMatrix: string[][];
  applyTarget?: string;
  lastAppliedAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export type AiSuggestionConfidence = 'high' | 'medium' | 'low';

export interface ProjectRequestContractTextSuggestion {
  value: string;
  confidence: AiSuggestionConfidence;
  evidence: string;
}

export interface ProjectRequestContractNumberSuggestion {
  value: number | null;
  confidence: AiSuggestionConfidence;
  evidence: string;
}

export interface ProjectRequestContractAnalysis {
  provider: 'anthropic' | 'heuristic';
  model: string;
  summary: string;
  warnings: string[];
  nextActions: string[];
  extractedAt: string;
  fields: {
    officialContractName: ProjectRequestContractTextSuggestion;
    suggestedProjectName: ProjectRequestContractTextSuggestion;
    clientOrg: ProjectRequestContractTextSuggestion;
    projectPurpose: ProjectRequestContractTextSuggestion;
    description: ProjectRequestContractTextSuggestion;
    contractStart: ProjectRequestContractTextSuggestion;
    contractEnd: ProjectRequestContractTextSuggestion;
    contractAmount: ProjectRequestContractNumberSuggestion;
    salesVatAmount: ProjectRequestContractNumberSuggestion;
  };
}

/** 실제 투입인력 역할 슬롯. 인력 명부(persons) 스냅샷 - 참여율 시트와 독립인 책임 메타데이터다. */
export interface ProjectStaffingSlot {
  /** 인력 명부(orgs/{org}/persons) 문서 id. 명부 밖 인물은 담지 않는다. */
  personId: string;
  name: string;
  nickname: string;
}

/**
 * 고정 역할(총괄·실무·운영) 밖의 역할. 역할명은 사용자가 직접 적는다 - 멘토, 강사처럼
 * 사업마다 다르기 때문이다. 적힌 역할명은 프로젝트 문서에 그대로 남고, 다음 사람이
 * 고를 수 있게 목록으로 모아 준다 (별도 사전 컬렉션을 두지 않는다 - 원천이 둘이 되면 갈린다).
 */
export interface ProjectStaffingOtherRole {
  /** 역할명. 예: 멘토, 강사 */
  role: string;
  slot: ProjectStaffingSlot | null;
}

/** 실제 투입인력. 슬롯이 비어 있으면(null) "미정" 상태다 - 채용 전 자리를 허용한다. */
export interface ProjectStaffing {
  /** 총괄책임자 - 사업 최종 책임자 */
  lead: ProjectStaffingSlot | null;
  /** 실무책임자 (PM) */
  pm: ProjectStaffingSlot | null;
  /** 운영 매니저 (1인 이상, 가변) */
  operators: ProjectStaffingSlot[];
  /** 기타 역할 - 역할명을 직접 적는다 */
  others: ProjectStaffingOtherRole[];
  /** 정산지원 - 도담/써니 중 택1, 해당 없으면 빈 문자열 */
  settlementSupport: string;
}

export interface ProjectTeamMemberAssignment {
  /** 인력 명부(orgs/{org}/persons)의 SSOT 식별자 */
  personId?: string;
  inputMode?: 'search' | 'manual';
  identityInput?: string;
  memberName: string;
  memberNickname: string;
  role: string;
  participationRate: number;
  isDocumentOnly?: boolean;
  laborAllocationStartMonth?: string;
  laborAllocationEndMonth?: string;
  /** YYYY-MM별 참여율. null은 시트의 미입력, 0은 명시적으로 입력한 0%다. */
  monthlyRates?: Record<string, number | null>;
}

export interface ProjectRequestPayload {
  name: string;
  officialContractName: string;
  type: ProjectType;
  status?: ProjectStatus;
  phase?: ProjectPhase;
  description: string;
  clientOrg: string;
  businessManagementGoogleFolderLink?: string;
  participationSheetLink?: string;
  department: string;
  groupwareName?: string;
  currency?: ProjectCurrency;
  contractAmount: number;
  salesVatAmount: number;
  totalRevenueAmount: number;
  totalActualCost: number;
  supportAmount: number;
  financialInputFlags?: ProjectFinancialInputFlags;
  registrationRequirementsVersion?: 1 | 2;
  financialYears?: ProjectFinancialYear[];
  registrationConfirmations?: ProjectRegistrationConfirmations;
  registrationOptionalDocumentNotes?: ProjectRegistrationOptionalDocumentNotes;
  checkout?: ProjectCheckout;
  contractStart: string;
  contractEnd: string;
  contractEndUndecided?: boolean;
  contractType?: string;
  settlementType: SettlementType;
  basis: Basis;
  accountType: AccountType;
  interestRefundPolicy?: InterestRefundPolicy;
  settlementSystem?: SettlementSystemCode;
  settlementSystemOther?: string;
  laborSettlementBasis?: LaborSettlementBasis;
  fundInputMode?: ProjectFundInputMode;
  settlementSheetPolicy?: SettlementSheetPolicy;
  paymentPlan?: Project['paymentPlan'];
  paymentExpectedMonths?: ProjectPaymentExpectedMonths;
  finalPaymentExpectedWeek?: string;
  laborTransferPlan?: ProjectLaborTransferPlan;
  advanceInterimBelow70Reason?: string;
  paymentPlanDesc: string;
  settlementGuide: string;
  finalPaymentNote?: string;
  projectPurpose: string;
  registeredById?: string;
  registeredByName?: string;
  registeredByEmail?: string;
  executiveApproverId?: string;
  executiveApproverName?: string;
  executiveApproverEmail?: string;
  managerId?: string;
  managerName: string;
  teamName: string;
  teamMembers: string;
  teamMembersDetailed?: ProjectTeamMemberAssignment[];
  staffing?: ProjectStaffing;
  participantCondition: string;
  note: string;
  contractDocument: FileAttachment | null;
  quoteDocument?: FileAttachment | null;
  quoteSubmissionDeferred?: boolean;
  proposalDocument?: FileAttachment | null;
  proposalWordOriginalDocument?: FileAttachment | null;
  proposalPptOriginalDocument?: FileAttachment | null;
  presentationPptOriginalDocument?: FileAttachment | null;
  rfpRequestEvidenceDocument?: FileAttachment | null;
  customerBusinessRegistrationDocument?: FileAttachment | null;
  performanceCertificateDocument?: FileAttachment | null;
  taxInvoiceDocument?: FileAttachment | null;
  finalSettlementReportDocument?: FileAttachment | null;
  finalReportDocument?: FileAttachment | null;
  contractAnalysis?: ProjectRequestContractAnalysis | null;
}

export interface ProjectRequest {
  id: string;
  tenantId?: string;
  requestKind?: ProjectRequestKind;
  targetProjectId?: string;
  baseProjectVersion?: number;
  requestVersion?: number;
  targetProjectVersion?: number;
  approvedProjectVersion?: number;
  beforeSnapshot?: ProjectRequestPayload | null;
  proposedSnapshot?: ProjectRequestPayload | null;
  approvedSnapshot?: ProjectRequestPayload | null;
  changedFields?: ProjectReviewFieldChange[];
  humanSummary?: string;
  status: ProjectRequestStatus;
  reviewOutcome?: ProjectRequestReviewOutcome;
  payload: ProjectRequestPayload;
  requestedBy: string;
  requestedByName: string;
  requestedByEmail: string;
  requestedAt: string;
  reviewedBy?: string;
  reviewedByName?: string;
  reviewedAt?: string;
  reviewComment?: string | null;
  rejectedReason?: string;
  approvedProjectId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type ProjectRequestDraftKind = 'REGISTRATION' | 'CHANGE';
export type ProjectRequestDraftStatus = 'DRAFT' | 'SUBMITTED' | 'DISCARDED';

export interface ProjectRequestDraft {
  id: string;
  tenantId: string;
  kind: ProjectRequestDraftKind;
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  targetProjectId?: string;
  draftKey: string;
  payloadSnapshot: ProjectRequestPayload;
  stepIndex: number;
  status: ProjectRequestDraftStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
}

export interface Ledger {
  id: string;
  version?: number;
  projectId: string;
  templateId: string;
  name: string;
  basis: Basis;
  settlementType: SettlementType;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionAmounts {
  bankAmount: number;      // 은행 기준 금액
  depositAmount: number;   // 입금액 (IN 방향)
  expenseAmount: number;   // 출금액 (OUT 방향)
  vatIn: number;           // 매입세액
  vatOut: number;          // 매출세액
  vatRefund: number;       // 부가세환급
  balanceAfter: number;    // 거래 후 잔액
}

export interface Transaction {
  id: string;
  version?: number;
  ledgerId: string;
  projectId: string;
  state: TransactionState;
  dateTime: string;        // ISO 날짜
  weekCode: string;        // e.g. "2026-W07"
  direction: Direction;
  entryKind?: SettlementEntryKind;
  method: PaymentMethod;
  cashflowCategory: CashflowCategory;
  cashflowLabel: string;   // 표시용 라벨
  budgetCategory?: string; // 비목/세목
  counterparty: string;    // 거래처
  memo: string;
  amounts: TransactionAmounts;
  // 증빙
  evidenceRequired: string[];
  evidenceStatus: EvidenceStatus;
  evidenceMissing: string[];
  attachmentsCount: number;
  // 승인
  submittedBy?: string;
  submittedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedReason?: string;
  // 감사
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  // ── 정산 대장 확장 필드 (Settlement Ledger) ──
  author?: string;                 // 작성자
  budgetSubCategory?: string;      // 세목
  budgetSubSubCategory?: string;   // 세세목
  // 증빙 추적 (사업팀)
  evidenceRequiredDesc?: string;   // 필수증빙자료 리스트 (텍스트)
  evidenceCompletedDesc?: string;  // 구비 완료된 증빙자료 리스트 (자동+수기 보정 적용 결과)
  evidenceCompletedManualDesc?: string; // 구비 완료 수기 보정 목록
  evidencePendingDesc?: string;    // 준비필요자료
  // 정산지원 담당자
  evidenceDriveLink?: string;      // 증빙자료 드라이브 링크
  evidenceDriveSharedDriveId?: string;
  evidenceDriveFolderId?: string;  // 거래별 증빙 폴더 id
  evidenceDriveFolderName?: string;// 거래별 증빙 폴더명
  evidenceDriveSyncStatus?: 'NOT_LINKED' | 'LINKED' | 'UPLOADED' | 'SYNCING' | 'SYNCED' | 'ERROR';
  evidenceDriveLastSyncedAt?: string;
  evidenceAutoListedDesc?: string; // 드라이브 파일 기준 자동 집계 목록
  supportPendingDocs?: string;     // 도담/써니 준비 필요자료
  // 도담 (정부 보고)
  eNaraRegistered?: string;        // e나라 등록
  eNaraExecuted?: string;          // e나라 집행
  vatSettlementDone?: boolean;     // 부가세 지결 완료여부
  settlementComplete?: boolean;    // 최종완료
  settlementNote?: string;         // 비고
  // 감사 로그 (회계부정 방지)
  editHistory?: Array<{
    field: string;
    before: unknown;
    after: unknown;
    editedBy: string;
    editedAt: string;
  }>;
}

export interface BudgetPlanRow {
  budgetCode: string;
  subCode: string;
  initialBudget: number;
  revisedBudget?: number;
  note?: string;
}

export interface BudgetCodeEntry {
  code: string;
  subCodes: string[];
}

export interface BudgetTreeLeafItem {
  subSubCode?: string;
  initialBudget: number;
  revisedBudget?: number;
  note?: string;
}

export interface BudgetTreeSubItem {
  subCode: string;
  initialBudget?: number;
  revisedBudget?: number;
  note?: string;
  leafItems: BudgetTreeLeafItem[];
}

export interface BudgetTreeCode {
  code: string;
  subItems: BudgetTreeSubItem[];
}

export interface BudgetTreeV2 {
  version: 2;
  projectId: string;
  codes: BudgetTreeCode[];
  updatedAt?: string;
  updatedBy?: string;
}

export interface BudgetCodeRename {
  fromCode: string;
  fromSub: string;
  toCode: string;
  toSub: string;
}

export interface WeeklySubmissionStatus {
  id: string; // `${projectId}-${yearMonth}-w${weekNo}`
  tenantId?: string;
  projectId: string;
  yearMonth: string; // "YYYY-MM"
  weekNo: number; // financeWeek 1..5
  statusRevision?: number;
  projectionEdited?: boolean;
  projectionEditedAt?: string;
  projectionEditedByName?: string;
  projectionUpdated?: boolean;
  projectionUpdatedAt?: string;
  projectionUpdatedByName?: string;
  expenseEdited?: boolean;
  expenseEditedAt?: string;
  expenseEditedByName?: string;
  expenseUpdated?: boolean;
  expenseUpdatedAt?: string;
  expenseUpdatedByName?: string;
  expenseSyncState?: 'pending' | 'review_required' | 'synced' | 'sync_failed';
  expenseSyncUpdatedAt?: string;
  expenseSyncUpdatedByName?: string;
  expenseReviewPendingCount?: number;
  updatedAt?: string;
  updatedByName?: string;
}

export type BankImportMatchState = 'AUTO_CONFIRMED' | 'PENDING_INPUT' | 'REVIEW_REQUIRED' | 'IGNORED';
export type BankImportProjectionStatus = 'NOT_PROJECTED' | 'PROJECTED' | 'PROJECTED_WITH_PENDING_EVIDENCE';

export interface BankImportSnapshot {
  accountNumber: string;
  dateTime: string;
  counterparty: string;
  memo: string;
  signedAmount: number;
  entryKind?: Extract<SettlementEntryKind, 'DEPOSIT' | 'EXPENSE'>;
  balanceAfter: number;
}

export interface BankImportManualFields {
  expenseAmount?: number;
  budgetCategory?: string;
  budgetSubCategory?: string;
  cashflowLineId?: CashflowSheetLineId;
  cashflowCategory?: CashflowCategory;
  memo?: string;
  evidenceCompletedDesc?: string;
}

export interface BankImportIntakeItem {
  id: string;
  projectId: string;
  sourceTxId: string;
  bankFingerprint: string;
  bankSnapshot: BankImportSnapshot;
  matchState: BankImportMatchState;
  projectionStatus: BankImportProjectionStatus;
  evidenceStatus: EvidenceStatus;
  manualFields: BankImportManualFields;
  existingExpenseSheetId?: string;
  existingExpenseRowTempId?: string;
  reviewReasons: string[];
  lastUploadBatchId: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface BudgetPlanSnapshot {
  projectId: string;
  rows: BudgetPlanRow[];
  updatedAt: string;
  updatedBy: string;
}

export interface Evidence {
  id: string;
  version?: number;
  transactionId: string;
  fileName: string;
  originalFileName?: string;
  fileType: string;
  fileSize: number;
  uploadedBy: string;
  uploadedAt: string;
  category: string;        // 증빙 유형 (세금계산서, 영수증, 계약서 등)
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  source?: 'MANUAL' | 'PLATFORM_UPLOAD' | 'DRIVE_SYNC';
  driveFileId?: string;
  driveFolderId?: string;
  driveFolderName?: string;
  webViewLink?: string;
  mimeType?: string;
  parserCategory?: string;
  parserConfidence?: number;
  rejectedReason?: string;
}

export interface Comment {
  id: string;
  version?: number;
  transactionId: string;
  projectId?: string;
  targetType?: 'transaction' | 'expense_sheet_row';
  sheetRowId?: string;
  authorId: string;
  authorName: string;
  fieldKey?: string;
  fieldLabel?: string;
  content: string;
  createdAt: string;
}

// ── Company Board (전사 게시판) ──

export type BoardChannel = 'general' | 'qna' | 'ideas' | 'help' | 'training';

export const BOARD_CHANNEL_LABELS: Record<BoardChannel, string> = {
  general: '일반',
  qna: '질문',
  ideas: '아이디어',
  help: '도움요청',
  training: '교육',
};

export interface BoardPost {
  id: string;
  tenantId?: string;
  channel: BoardChannel;
  title: string;
  body: string;
  tags: string[];
  createdBy: string;
  createdByName: string;
  createdByRole?: string;
  createdByAvatarUrl?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  commentCount: number;
  upvoteCount: number;
  downvoteCount: number;
  voteScore: number;
  deletedAt?: string | null;
}

export interface BoardComment {
  id: string;
  tenantId?: string;
  postId: string;
  parentId?: string | null;
  body: string;
  createdBy: string;
  createdByName: string;
  createdByAvatarUrl?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface BoardVote {
  id: string;
  tenantId?: string;
  postId: string;
  voterId: string;
  value: -1 | 1;
  createdAt: string;
  updatedAt: string;
}

// ── Payroll (인건비 공지/확인) ──

export type PayrollPaidStatus = 'UNKNOWN' | 'AUTO_MATCHED' | 'CONFIRMED' | 'MISSING';

export type PayrollCandidateReviewDecision = 'PENDING' | 'PAYROLL' | 'NOT_PAYROLL' | 'HOLD';

export type PayrollReviewStatus = 'PENDING' | 'COMPLETED' | 'MISSING_CANDIDATE';

export interface PayrollReviewCandidate {
  txId: string;
  detectedFrom: 'rule_engine' | 'future_llm';
  signals: string[];
  decision: PayrollCandidateReviewDecision;
  decidedAt?: string;
  decidedByUid?: string;
  decidedByName?: string;
  note?: string;
}

export interface PayrollSchedule {
  /** doc id = projectId */
  id: string;
  tenantId?: string;
  projectId: string;
  /** 1..31 (없는 날짜면 월 말일로 clamp) */
  dayOfMonth: number;
  timezone: string; // e.g. "Asia/Seoul"
  noticeLeadBusinessDays: number; // default 3
  active: boolean;
  updatedAt: string;
  updatedBy: string;
  updatedByName?: string;
  createdAt?: string;
  createdBy?: string;
}

export interface PayrollRun {
  /** doc id = `${projectId}-${yearMonth}` */
  id: string;
  tenantId?: string;
  projectId: string;
  yearMonth: string; // "2026-02"
  plannedPayDate: string; // "YYYY-MM-DD"
  noticeDate: string; // "YYYY-MM-DD"
  noticeLeadBusinessDays: number;
  acknowledged: boolean;
  acknowledgedAt?: string;
  acknowledgedByUid?: string;
  acknowledgedByName?: string;
  paidStatus: PayrollPaidStatus;
  matchedTxIds?: string[];
  reviewCandidates?: PayrollReviewCandidate[];
  pmReviewStatus?: PayrollReviewStatus;
  pmReviewCompletedAt?: string;
  pmReviewCompletedByUid?: string;
  pmReviewCompletedByName?: string;
  missingCandidateAlertAt?: string;
  pmExpectedPayrollAmount?: number;
  pmExpectedPayrollAmountUpdatedAt?: string;
  pmExpectedPayrollAmountUpdatedByUid?: string;
  pmExpectedPayrollAmountUpdatedByName?: string;
  confirmedAt?: string;
  confirmedByUid?: string;
  confirmedByName?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Cashflow Weekly Sheet (주간 캐시플로 시트) ──

export type CashflowSheetLineId =
  // IN
  | 'MYSC_PREPAY_IN'        // MYSC 선입금(필요 시 - 금액)
  | 'MYSC_PREPAY_LABOR_IN'  // MYSC 선입금 - MYSC 인건비
  | 'MYSC_PREPAY_INPUT_VAT_IN' // MYSC 선입금 - 매입부가세
  | 'SALES_IN'              // 매출액(입금)
  | 'SALES_VAT_IN'          // 매출부가세(입금)
  | 'TEAM_SUPPORT_IN'       // 팀지원금(입금)
  | 'BANK_INTEREST_IN'      // 은행이자(입금)
  // OUT
  | 'MYSC_PREPAY_DIRECT_OUT' // MYSC 선입금 - 직접사업비 등
  | 'MYSC_PREPAY_LABOR_OUT' // MYSC 선입금 - MYSC 인건비
  | 'DIRECT_COST_OUT'       // 직접사업비(공급가액/공급대가)
  | 'INPUT_VAT_OUT'         // 매입부가세(출금)
  | 'MYSC_LABOR_OUT'        // MYSC 인건비
  | 'MYSC_PROFIT_OUT'       // MYSC 수익(간접비 등)
  | 'SALES_VAT_OUT'         // 매출부가세(출금)
  | 'TEAM_SUPPORT_OUT'      // 팀지원금(출금)
  | 'BANK_INTEREST_OUT';    // 은행이자(출금)

export const CASHFLOW_SHEET_LINE_LABELS: Record<CashflowSheetLineId, string> = Object.fromEntries(
  cashflowPolicyData.lineEntries.map((entry) => [entry.lineId, entry.label]),
) as Record<CashflowSheetLineId, string>;

export interface CashflowWeekSheet {
  /** doc id = `${projectId}-${yearMonth}-w${weekNo}` */
  id: string;
  tenantId?: string;
  projectId: string;
  yearMonth: string; // "2026-01"
  weekNo: number; // financeWeek 1..5
  weekStart: string; // "YYYY-MM-DD"
  weekEnd: string; // "YYYY-MM-DD"
  sheetWeekSource?: 'cashflow-sheet-lab';
  projection: Partial<Record<CashflowSheetLineId, number>>;
  actual: Partial<Record<CashflowSheetLineId, number>>;
  projectionTotals?: CashflowWeekTotals;
  actualTotals?: CashflowWeekTotals;
  projectionUpdated?: boolean;
  projectionUpdatedAt?: string;
  projectionUpdatedByUid?: string;
  projectionUpdatedByName?: string;
  projectionChangeAlert?: ProjectionChangeAlert | null;
  pmSubmitted: boolean;
  pmSubmittedAt?: string;
  pmSubmittedByUid?: string;
  pmSubmittedByName?: string;
  adminClosed: boolean;
  adminClosedAt?: string;
  adminClosedByUid?: string;
  adminClosedByName?: string;
  createdAt: string;
  updatedAt: string;
  updatedByUid?: string;
  updatedByName?: string;
  // ── 편차 확인 티켓 (Admin ↔ PM) ──
  varianceFlag?: VarianceFlag;
  // 편차 확인 영구 이력 — 모든 플래그/답변/해결 기록 (삭제 불가)
  varianceHistory?: VarianceFlagEvent[];
  varianceRevision?: number;
}

export interface CashflowWeekTotals {
  totalIn: number;
  totalOut: number;
  net: number;
}

export interface ProjectionChangeAlert {
  triggered: true;
  reason: 'near_week_large_projection_change';
  changedAt: string;
  changedByUid?: string;
  changedByName?: string;
  daysBeforeWeekStart: number;
  thresholdAmount: number;
  totalAbsDelta: number;
  netDelta: number;
  largestLineId?: CashflowSheetLineId;
  largestLineDelta: number;
  previousAmount?: number;
  nextAmount?: number;
}

// 편차 확인 티켓 — 현재 상태
export type VarianceFlagStatus = 'OPEN' | 'REPLIED' | 'RESOLVED';

export interface VarianceFlag {
  status: VarianceFlagStatus;
  reason: string;                // Admin이 작성한 확인 사유
  flaggedBy: string;             // Admin 이름
  flaggedByUid?: string;
  flaggedAt: string;             // ISO
  pmReply?: string;              // PM 답변
  pmRepliedBy?: string;
  pmRepliedByUid?: string;
  pmRepliedAt?: string;
  resolvedBy?: string;
  resolvedByUid?: string;
  resolvedAt?: string;
}

// 편차 확인 영구 이력 — 한 번 기록되면 삭제/수정 불가
export interface VarianceFlagEvent {
  id: string;
  action: 'FLAG' | 'REPLY' | 'RESOLVE';
  actor: string;                 // 이름
  actorUid?: string;
  content: string;               // 사유 / 답변 / 해결 코멘트
  timestamp: string;             // ISO
}

export interface AuditLog {
  id: string;
  tenantId?: string;
  entityType:
    | 'project'
    | 'ledger'
    | 'transaction'
    | 'evidence'
    | 'comment'
    | 'part_entry'
    | 'part_project'
    | 'employee'
    | 'member'
    | 'system';
  entityId: string;
  action: string;
  userId: string;
  userName: string;
  userRole?: string;
  requestId?: string;
  details: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ── Rollup (집계) ──

export interface CategoryRollup {
  category: CashflowCategory;
  label: string;
  inAmount: number;
  outAmount: number;
  netAmount: number;
  count: number;
}

export interface MonthlyRollup {
  month: string;           // "2026-01"
  totalIn: number;
  totalOut: number;
  totalNet: number;
  totalCount: number;
  byCategory: CategoryRollup[];
}

// ── 경력 프로필 (Career Profile) ──

export type DegreeType = '학사' | '석사' | '박사' | '전문학사' | '수료' | '기타';

/**
 * 개인 경력 프로필 (Firestore: orgs/{orgId}/careerProfiles/{uid})
 * 참여경력(ParticipationEntry)과 사내교육(TrainingEnrollment)은 별도 컬렉션에서 join
 */
// ── 사내 강의 (Internal Training) ──

export type TrainingCategory = 'technical' | 'compliance' | 'soft-skills' | 'management' | 'language' | 'other';
export type TrainingStatus = 'DRAFT' | 'OPEN' | 'CLOSED' | 'COMPLETED';
export type EnrollmentStatus = 'ENROLLED' | 'COMPLETED' | 'DROPPED';

export const TRAINING_CATEGORY_LABELS: Record<TrainingCategory, string> = {
  technical: '직무/기술',
  compliance: '컴플라이언스',
  'soft-skills': '소프트스킬',
  management: '사업관리',
  language: '어학',
  other: '기타',
};

export const TRAINING_STATUS_LABELS: Record<TrainingStatus, string> = {
  DRAFT: '준비중',
  OPEN: '모집중',
  CLOSED: '모집마감',
  COMPLETED: '종료',
};

export const ENROLLMENT_STATUS_LABELS: Record<EnrollmentStatus, string> = {
  ENROLLED: '수강중',
  COMPLETED: '이수완료',
  DROPPED: '수강취소',
};

/**
 * 사내 강의 (Firestore: orgs/{orgId}/trainingCourses/{courseId})
 */
export interface TrainingCourse {
  id: string;
  orgId: string;
  title: string;
  description: string;
  category: TrainingCategory;
  durationHours: number;      // 수강 시간 (h)
  instructor: string;         // 강사명
  instructorId?: string;      // 내부 강사 uid
  startDate: string;          // YYYY-MM-DD
  endDate: string;            // YYYY-MM-DD
  maxParticipants: number;
  isRequired: boolean;        // 필수 교육 여부
  status: TrainingStatus;
  createdBy: string;          // admin uid
  createdAt: string;
  updatedAt: string;
}

/**
 * 수강 신청/이수 (Firestore: orgs/{orgId}/trainingEnrollments/{id})
 */
export interface TrainingEnrollment {
  id: string;
  courseId: string;
  courseTitle: string;        // denormalized
  memberId: string;
  memberName: string;         // denormalized
  enrolledAt: string;
  status: EnrollmentStatus;
  completedAt?: string;
  certificate?: string;       // 수료증 Storage URL
  notes?: string;
}

// ── 사업비 가이드 Q&A 챗봇 ──

export type GuideStatus = 'CALIBRATING' | 'READY';

export interface GuideMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface GuideDocument {
  id: string;
  tenantId?: string;
  title: string;
  content: string;                    // 원문 전체 텍스트
  sourceType: 'pdf' | 'text' | 'markdown';
  sourceFileName?: string;
  charCount: number;
  status: GuideStatus;
  calibrationMessages: GuideMessage[];  // 캘리브레이션 대화 기록
  calibrationSummary?: string;          // finalize 시 생성된 요약
  uploadedBy: string;
  uploadedByName: string;
  createdAt: string;
  updatedAt: string;
}

export interface GuideQA {
  id: string;
  tenantId?: string;
  guideId: string;
  question: string;
  answer: string;
  askedBy: string;
  askedByName: string;
  askedByRole: string;
  tokensUsed?: number;
  modelUsed?: string;
  createdAt: string;
}

// ── Filter ──

export interface TransactionFilter {
  dateFrom?: string;
  dateTo?: string;
  direction?: Direction | 'ALL';
  cashflowCategory?: CashflowCategory | 'ALL';
  state?: TransactionState | 'ALL';
  method?: PaymentMethod | 'ALL';
  searchText?: string;
}
