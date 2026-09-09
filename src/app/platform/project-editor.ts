import type {
  AccountType,
  InterestRefundPolicy,
  Basis,
  FileAttachment,
  Project,
  ProjectExecutiveReviewHistoryEntry,
  ProjectCurrency,
  ProjectFinancialInputFlags,
  ProjectFundInputMode,
  ProjectFinancialYear,
  ProjectPaymentExpectedMonths,
  ProjectLaborTransferPlan,
  ProjectRegistrationConfirmations,
  ProjectRegistrationOptionalDocumentNotes,
  ProjectCheckout,
  ProjectPhase,
  ProjectRequestContractAnalysis,
  ProjectRequestPayload,
  ProjectStatus,
  ProjectTeamMemberAssignment,
  ProjectType,
  LaborSettlementBasis,
  SettlementSystemCode,
  SettlementSheetPolicy,
  SettlementType,
  ProjectStaffing,
  ProjectStaffingOtherRole,
  ProjectStaffingSlot,
} from '../data/types';
import {
  ACCOUNT_TYPE_LABELS,
  BASIS_LABELS,
  createSettlementSheetPolicy,
  LABOR_SETTLEMENT_BASIS_LABELS,
  normalizeAccountType,
  normalizeBasis,
  normalizeProjectCurrency,
  normalizeProjectContractType,
  normalizeProjectFundInputMode,
  normalizeLaborSettlementBasis,
  normalizeInterestRefundPolicy,
  normalizeProjectPhase,
  normalizeProjectStatus,
  normalizeProjectType,
  normalizeSettlementSheetPolicy,
  normalizeSettlementSystemCode,
  normalizeSettlementType,
  PROJECT_FUND_INPUT_MODE_LABELS,
  PROJECT_CURRENCY_LABELS,
  PROJECT_TYPE_LABELS,
  SETTLEMENT_SYSTEM_LABELS,
  SETTLEMENT_TYPE_LABELS,
} from '../data/types';
import {
  createEmptyProjectFinancialInputFlags,
  normalizeProjectFinancialInputFlagsForAmounts,
} from './project-contract-amount';
import { normalizeProjectRevenueFields } from './project-financials';
import {
  formatProjectTeamMembersSummary,
  normalizeProjectTeamMembers,
  projectTeamMembersForWrite,
} from './project-team-members';
import { normalizeProjectDepartment, resolveProjectCic } from './project-cic';
import { getYearFinanceWeeks } from './cashflow-week-core.mjs';

export type ProjectEditorMode = 'portal-register' | 'portal-edit' | 'admin';

function isRealIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function hasInvalidProjectContractPeriod(startValue: unknown, endValue: unknown) {
  const start = String(startValue || '').trim();
  const end = String(endValue || '').trim();
  return !isRealIsoDate(start) || !isRealIsoDate(end) || start > end;
}

export interface ProjectEditorDraft {
  name: string;
  officialContractName: string;
  type: ProjectType;
  description: string;
  clientOrg: string;
  businessManagementGoogleFolderLink: string;
  participationSheetLink: string;
  department: string;
  projectPurpose: string;
  status: ProjectStatus;
  phase: ProjectPhase;
  contractType: string;
  contractStart: string;
  contractEnd: string;
  /** 종료 기간 없음(무기한 계약). 미입력(빈 종료일)과 구분하는 명시 플래그. */
  contractEndUndecided: boolean;
  currency: ProjectCurrency;
  contractAmount: number;
  salesVatAmount: number;
  totalRevenueAmount: number;
  totalActualCost: number;
  supportAmount: number;
  financialInputFlags: ProjectFinancialInputFlags;
  registrationRequirementsVersion: 1 | 2;
  financialYears: ProjectFinancialYear[];
  registrationConfirmations: ProjectRegistrationConfirmations;
  registrationOptionalDocumentNotes: ProjectRegistrationOptionalDocumentNotes;
  checkout: ProjectCheckout;
  settlementType: SettlementType;
  basis: Basis;
  accountType: AccountType;
  interestRefundPolicy: InterestRefundPolicy | '';
  settlementSystem: SettlementSystemCode;
  settlementSystemOther: string;
  laborSettlementBasis: LaborSettlementBasis;
  fundInputMode: ProjectFundInputMode;
  settlementSheetPolicy: SettlementSheetPolicy;
  profitRate: number;
  profitAmount: number;
  registeredById: string;
  registeredByName: string;
  registeredByEmail: string;
  executiveApproverId: string;
  executiveApproverName: string;
  executiveApproverEmail: string;
  managerId: string;
  managerName: string;
  teamName: string;
  teamMembersDetailed: ProjectTeamMemberAssignment[];
  staffing: ProjectStaffing;
  participantCondition: string;
  note: string;
  paymentPlanDesc: string;
  settlementGuide: string;
  groupwareName: string;
  paymentPlan: Project['paymentPlan'];
  paymentExpectedMonths: ProjectPaymentExpectedMonths;
  finalPaymentExpectedWeek: string;
  laborTransferPlan: ProjectLaborTransferPlan;
  advanceInterimBelow70Reason: string;
  finalPaymentNote: string;
  budgetCurrentYear: number;
  taxInvoiceAmount: number;
  contractDocument: FileAttachment | null;
  quoteDocument: FileAttachment | null;
  quoteSubmissionDeferred: boolean;
  proposalDocument: FileAttachment | null;
  proposalWordOriginalDocument: FileAttachment | null;
  proposalPptOriginalDocument: FileAttachment | null;
  presentationPptOriginalDocument: FileAttachment | null;
  rfpRequestEvidenceDocument: FileAttachment | null;
  customerBusinessRegistrationDocument: FileAttachment | null;
  performanceCertificateDocument: FileAttachment | null;
  taxInvoiceDocument: FileAttachment | null;
  finalSettlementReportDocument: FileAttachment | null;
  finalReportDocument: FileAttachment | null;
  contractAnalysis: ProjectRequestContractAnalysis | null;
}

export interface ProjectEditorPatchOptions {
  baseProject?: Project | null;
  mode: ProjectEditorMode;
  actorId: string;
  actorName: string;
  now: string;
  forceExecutiveReviewPending?: boolean;
  executiveReviewComment?: string | null;
}

const DEFAULT_DRAFT: ProjectEditorDraft = {
  name: '',
  officialContractName: '',
  type: 'D1',
  description: '',
  clientOrg: '',
  businessManagementGoogleFolderLink: '',
  participationSheetLink: '',
  department: '',
  projectPurpose: '',
  status: 'CONTRACT_PENDING',
  phase: 'CONFIRMED',
  contractType: '계약서(날인)',
  contractStart: '',
  contractEnd: '',
  contractEndUndecided: false,
  currency: 'KRW',
  contractAmount: 0,
  salesVatAmount: 0,
  totalRevenueAmount: 0,
  totalActualCost: 0,
  supportAmount: 0,
  financialInputFlags: createEmptyProjectFinancialInputFlags(),
  registrationRequirementsVersion: 1,
  financialYears: [],
  registrationConfirmations: {
    laborIncludesFourInsurance: null,
    laborIncludesRetirementPay: null,
    customerSettlementBasisConfirmed: false,
    modusignContractUsed: null,
    originalContractSubmitted: null,
    proposalPptOriginal: '',
    presentationPptOriginal: '',
  },
  registrationOptionalDocumentNotes: {
    proposalWordOriginal: '',
    proposalPptOriginal: '',
    presentationPptOriginal: '',
  },
  checkout: {
    finalPaymentReceived: false,
    bankBalanceZero: false,
    performanceCertificateReceived: false,
    performanceCertificateDocumentApplicable: false,
    taxInvoiceEvidenceConfirmed: false,
    finalSettlementReportConfirmed: false,
    usbEvidenceSubmitted: false,
    evidenceDeletedAfterUsb: false,
  },
  settlementType: 'NONE',
  basis: 'NONE',
  accountType: 'NONE',
  interestRefundPolicy: '',
  settlementSystem: 'NONE',
  settlementSystemOther: '',
  laborSettlementBasis: 'NONE',
  fundInputMode: 'BANK_UPLOAD',
  settlementSheetPolicy: createSettlementSheetPolicy('STANDARD'),
  profitRate: 0,
  profitAmount: 0,
  registeredById: '',
  registeredByName: '',
  registeredByEmail: '',
  executiveApproverId: '',
  executiveApproverName: '',
  executiveApproverEmail: '',
  managerId: '',
  managerName: '',
  teamName: '',
  teamMembersDetailed: [],
  staffing: { lead: null, pm: null, operators: [], others: [], settlementSupport: '' },
  participantCondition: '',
  note: '',
  paymentPlanDesc: '',
  settlementGuide: '',
  groupwareName: '',
  paymentPlan: { contract: 0, interim: 0, final: 0 },
  paymentExpectedMonths: { contract: '', interim: '', final: '' },
  finalPaymentExpectedWeek: '',
  laborTransferPlan: { mode: 'MONTHLY_WEEK_3', milestoneAmounts: { contract: 0, interim: 0, final: 0 } },
  advanceInterimBelow70Reason: '',
  finalPaymentNote: '',
  budgetCurrentYear: 0,
  taxInvoiceAmount: 0,
  contractDocument: null,
  quoteDocument: null,
  quoteSubmissionDeferred: false,
  proposalDocument: null,
  proposalWordOriginalDocument: null,
  proposalPptOriginalDocument: null,
  presentationPptOriginalDocument: null,
  rfpRequestEvidenceDocument: null,
  customerBusinessRegistrationDocument: null,
  performanceCertificateDocument: null,
  taxInvoiceDocument: null,
  finalSettlementReportDocument: null,
  finalReportDocument: null,
  contractAnalysis: null,
};

function nonNegativeAmount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed));
}

function text(value: unknown): string {
  return String(value || '').trim();
}

function normalizeFinanceWeek(value: unknown, expectedYear?: number | null): string {
  const label = text(value);
  const match = /^(\d{2})-(\d{1,2})-([1-5])$/.exec(label);
  if (!match) return '';
  const labelYear = 2000 + Number(match[1]);
  if (expectedYear && labelYear !== expectedYear) return '';
  return getYearFinanceWeeks(labelYear).some((week) => week.label === label) ? label : '';
}

function registrationRequirementsVersion(value: unknown): 1 | 2 {
  return value === 2 ? 2 : 1;
}

function dateYear(value: unknown): number | null {
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(text(value));
  return match ? Number(match[1]) : null;
}

function projectFinancialYearProfitRate(contractAmount: number, totalRevenueAmount: number): number {
  if (contractAmount <= 0) return 0;
  return Math.min(1, totalRevenueAmount / contractAmount);
}

function projectFinancialYears(
  value: unknown,
  contractStart: unknown,
  contractEnd: unknown,
  totals: Pick<ProjectEditorDraft, 'contractAmount' | 'salesVatAmount' | 'totalRevenueAmount' | 'totalActualCost' | 'supportAmount' | 'profitRate'>,
  version: 1 | 2,
): ProjectFinancialYear[] {
  const rows = Array.isArray(value) ? value : [];
  const normalized = new Map<number, ProjectFinancialYear>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const source = row as Partial<ProjectFinancialYear>;
    const year = Number(source.year);
    if (!Number.isSafeInteger(year) || year < 2000 || year > 2099 || normalized.has(year)) continue;
    const contractAmount = nonNegativeAmount(source.contractAmount);
    const totalRevenueAmount = nonNegativeAmount(source.totalRevenueAmount);
    normalized.set(year, {
      year,
      contractAmount,
      salesVatAmount: nonNegativeAmount(source.salesVatAmount),
      totalRevenueAmount,
      totalActualCost: nonNegativeAmount(source.totalActualCost),
      supportAmount: nonNegativeAmount(source.supportAmount),
      profitRate: projectFinancialYearProfitRate(contractAmount, totalRevenueAmount),
      confirmed: source.confirmed === true,
      paymentPlan: normalizePaymentPlan(source.paymentPlan),
      paymentExpectedMonths: normalizePaymentExpectedMonths(source.paymentExpectedMonths),
      finalPaymentExpectedWeek: normalizeFinanceWeek(source.finalPaymentExpectedWeek, year),
      advanceInterimBelow70Reason: String(source.advanceInterimBelow70Reason || ''),
      isSettled: source.isSettled === true,
    });
  }
  if (version !== 2) return [...normalized.values()].sort((a, b) => a.year - b.year);
  const startYear = dateYear(contractStart);
  const endYear = dateYear(contractEnd);
  if (!startYear || !endYear || startYear > endYear || endYear - startYear > 20) return [];
  // 단년도도 행 하나를 만든다. 금액을 넣는 자리를 연도 수와 무관하게 표 하나로 통일한다.
  return Array.from({ length: endYear - startYear + 1 }, (_, offset) => {
    const year = startYear + offset;
    return normalized.get(year) || {
      year,
      contractAmount: offset === 0 ? nonNegativeAmount(totals.contractAmount) : 0,
      salesVatAmount: offset === 0 ? nonNegativeAmount(totals.salesVatAmount) : 0,
      totalRevenueAmount: offset === 0 ? nonNegativeAmount(totals.totalRevenueAmount) : 0,
      totalActualCost: offset === 0 ? nonNegativeAmount(totals.totalActualCost) : 0,
      supportAmount: offset === 0 ? nonNegativeAmount(totals.supportAmount) : 0,
      profitRate: offset === 0
        ? projectFinancialYearProfitRate(
          nonNegativeAmount(totals.contractAmount),
          nonNegativeAmount(totals.totalRevenueAmount),
        )
        : 0,
      confirmed: false,
      paymentPlan: { contract: 0, interim: 0, final: 0 },
      paymentExpectedMonths: { contract: '', interim: '', final: '' },
      finalPaymentExpectedWeek: '',
      advanceInterimBelow70Reason: '',
      isSettled: false,
    };
  });
}

function projectFinancialYearsForWrite(rows: ProjectFinancialYear[]): ProjectFinancialYear[] {
  return rows.map(({ finalPaymentExpectedWeek: _historicalWeek, ...row }) => ({
    ...row,
    paymentExpectedMonths: normalizePaymentExpectedMonths(row.paymentExpectedMonths),
    advanceInterimBelow70Reason: text(row.advanceInterimBelow70Reason),
  }));
}

function registrationConfirmations(value: unknown): ProjectRegistrationConfirmations {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<ProjectRegistrationConfirmations>
    : {};
  const optionalBoolean = (input: unknown) => typeof input === 'boolean' ? input : null;
  return {
    laborIncludesFourInsurance: optionalBoolean(source.laborIncludesFourInsurance),
    laborIncludesRetirementPay: optionalBoolean(source.laborIncludesRetirementPay),
    customerSettlementBasisConfirmed: source.customerSettlementBasisConfirmed === true,
    modusignContractUsed: optionalBoolean(source.modusignContractUsed),
    originalContractSubmitted: optionalBoolean(source.originalContractSubmitted),
    proposalPptOriginal: text(source.proposalPptOriginal),
    presentationPptOriginal: text(source.presentationPptOriginal),
  };
}

function registrationOptionalDocumentNotes(value: unknown): ProjectRegistrationOptionalDocumentNotes {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<ProjectRegistrationOptionalDocumentNotes>
    : {};
  return {
    proposalWordOriginal: text(source.proposalWordOriginal),
    proposalPptOriginal: text(source.proposalPptOriginal),
    presentationPptOriginal: text(source.presentationPptOriginal),
  };
}

function projectCheckout(value: unknown, settlementApplicable = true): ProjectCheckout {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<ProjectCheckout>
    : {};
  return {
    finalPaymentReceived: source.finalPaymentReceived === true,
    bankBalanceZero: source.bankBalanceZero === true,
    performanceCertificateReceived: source.performanceCertificateReceived === true,
    performanceCertificateDocumentApplicable: source.performanceCertificateDocumentApplicable === true,
    taxInvoiceEvidenceConfirmed: source.taxInvoiceEvidenceConfirmed === true,
    finalSettlementReportConfirmed: settlementApplicable && source.finalSettlementReportConfirmed === true,
    usbEvidenceSubmitted: settlementApplicable && source.usbEvidenceSubmitted === true,
    evidenceDeletedAfterUsb: settlementApplicable && source.evidenceDeletedAfterUsb === true,
  };
}

function normalizePaymentPlan(value: Project['paymentPlan'] | null | undefined): Project['paymentPlan'] {
  return {
    contract: nonNegativeAmount(value?.contract),
    interim: nonNegativeAmount(value?.interim),
    final: nonNegativeAmount(value?.final),
  };
}

function normalizeExpectedMonth(value: unknown): string {
  const normalized = text(value);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(normalized) ? normalized : '';
}

function normalizePaymentExpectedMonths(
  value: Partial<ProjectPaymentExpectedMonths> | null | undefined,
): ProjectPaymentExpectedMonths {
  return {
    contract: normalizeExpectedMonth(value?.contract),
    interim: normalizeExpectedMonth(value?.interim),
    final: normalizeExpectedMonth(value?.final),
  };
}

function normalizeLaborTransferPlan(_value: Partial<ProjectLaborTransferPlan> | null | undefined): ProjectLaborTransferPlan {
  return {
    mode: 'MONTHLY_WEEK_3',
    milestoneAmounts: { contract: 0, interim: 0, final: 0 },
  };
}

function formatAmountForChange(value: unknown) {
  const amount = nonNegativeAmount(value);
  return amount > 0 ? `${amount.toLocaleString('ko-KR')}원` : '-';
}

function formatDateRangeForChange(start: unknown, end: unknown) {
  const startText = text(start);
  const endText = text(end);
  return startText || endText ? `${startText || '-'} ~ ${endText || '-'}` : '-';
}

function formatPaymentPlanForChange(value: Project['paymentPlan'] | null | undefined) {
  const plan = normalizePaymentPlan(value);
  const entries = [
    ['선금/계약금', plan.contract],
    ['중도금', plan.interim],
    ['잔금', plan.final],
  ] as const;
  const label = entries
    .map(([name, amount]) => `${name} ${amount.toLocaleString('ko-KR')}원`)
    .join(' · ');
  return label || '-';
}

function formatPaymentExpectedMonthsForChange(value: Partial<ProjectPaymentExpectedMonths> | null | undefined) {
  const months = normalizePaymentExpectedMonths(value);
  return [
    months.contract ? `선금 ${months.contract}` : '',
    months.interim ? `중도금 ${months.interim}` : '',
    months.final ? `잔금 ${months.final}` : '',
  ].filter(Boolean).join(' · ') || '-';
}

function formatTeamMembersForChange(value: ProjectTeamMemberAssignment[] | null | undefined) {
  return formatProjectTeamMembersSummary(normalizeProjectTeamMembers(value), '-', ', ');
}

function normalizeChangeValue(value: unknown) {
  const normalized = text(value);
  return normalized || '-';
}

const REVIEW_CHANGE_FIELDS: Array<{
  key: string;
  label: string;
  before: (project: Project) => string;
  after: (draft: ProjectEditorDraft) => string;
}> = [
  { key: 'name', label: '프로젝트명', before: (project) => normalizeChangeValue(project.name), after: (draft) => normalizeChangeValue(draft.name) },
  { key: 'officialContractName', label: '공식 계약명', before: (project) => normalizeChangeValue(project.officialContractName), after: (draft) => normalizeChangeValue(draft.officialContractName) },
  { key: 'clientOrg', label: '계약 대상', before: (project) => normalizeChangeValue(project.clientOrg), after: (draft) => normalizeChangeValue(draft.clientOrg) },
  { key: 'businessManagementGoogleFolderLink', label: '사업관리 구글폴더링크', before: (project) => normalizeChangeValue(project.businessManagementGoogleFolderLink), after: (draft) => normalizeChangeValue(draft.businessManagementGoogleFolderLink) },
  { key: 'participationSheetLink', label: '참여율 시트 링크', before: (project) => normalizeChangeValue(project.participationSheetLink), after: (draft) => normalizeChangeValue(draft.participationSheetLink) },
  { key: 'department', label: '담당조직(CIC)', before: (project) => normalizeChangeValue(project.department), after: (draft) => normalizeChangeValue(draft.department) },
  { key: 'type', label: '프로젝트 유형', before: (project) => PROJECT_TYPE_LABELS[normalizeProjectType(project.type)] || '-', after: (draft) => PROJECT_TYPE_LABELS[normalizeProjectType(draft.type)] || '-' },
  { key: 'contractPeriod', label: '계약 기간', before: (project) => formatDateRangeForChange(project.contractStart, project.contractEndUndecided === true ? '종료 기간 없음' : project.contractEnd), after: (draft) => formatDateRangeForChange(draft.contractStart, draft.contractEndUndecided ? '종료 기간 없음' : draft.contractEnd) },
  { key: 'currency', label: '통화', before: (project) => PROJECT_CURRENCY_LABELS[normalizeProjectCurrency(project.currency)] || '-', after: (draft) => PROJECT_CURRENCY_LABELS[normalizeProjectCurrency(draft.currency)] || '-' },
  { key: 'contractAmount', label: '계약금액', before: (project) => formatAmountForChange(project.contractAmount), after: (draft) => formatAmountForChange(draft.contractAmount) },
  { key: 'totalRevenueAmount', label: '총수익', before: (project) => formatAmountForChange(project.totalRevenueAmount), after: (draft) => formatAmountForChange(draft.totalRevenueAmount) },
  { key: 'totalActualCost', label: '총실비(원가)', before: (project) => formatAmountForChange(project.totalActualCost), after: (draft) => formatAmountForChange(draft.totalActualCost) },
  { key: 'supportAmount', label: '총지원금', before: (project) => formatAmountForChange(project.supportAmount), after: (draft) => formatAmountForChange(draft.supportAmount) },
  { key: 'settlementType', label: '정산 유형', before: (project) => SETTLEMENT_TYPE_LABELS[normalizeSettlementType(project.settlementType)] || '-', after: (draft) => SETTLEMENT_TYPE_LABELS[normalizeSettlementType(draft.settlementType)] || '-' },
  { key: 'basis', label: '정산 기준', before: (project) => BASIS_LABELS[normalizeBasis(project.basis)] || '-', after: (draft) => BASIS_LABELS[normalizeBasis(draft.basis)] || '-' },
  { key: 'accountType', label: '통장 유형', before: (project) => ACCOUNT_TYPE_LABELS[normalizeAccountType(project.accountType)] || '-', after: (draft) => ACCOUNT_TYPE_LABELS[normalizeAccountType(draft.accountType)] || '-' },
  { key: 'settlementSystem', label: '정산 시스템', before: (project) => normalizeSettlementSystemCode(project.settlementSystem) === 'OTHER' ? normalizeChangeValue(project.settlementSystemOther) : SETTLEMENT_SYSTEM_LABELS[normalizeSettlementSystemCode(project.settlementSystem)] || '-', after: (draft) => normalizeSettlementSystemCode(draft.settlementSystem) === 'OTHER' ? normalizeChangeValue(draft.settlementSystemOther) : SETTLEMENT_SYSTEM_LABELS[normalizeSettlementSystemCode(draft.settlementSystem)] || '-' },
  { key: 'laborSettlementBasis', label: '인건비 정산 기준', before: (project) => LABOR_SETTLEMENT_BASIS_LABELS[normalizeLaborSettlementBasis(project.laborSettlementBasis)] || '-', after: (draft) => LABOR_SETTLEMENT_BASIS_LABELS[normalizeLaborSettlementBasis(draft.laborSettlementBasis)] || '-' },
  { key: 'fundInputMode', label: '자금 입력 방식', before: (project) => PROJECT_FUND_INPUT_MODE_LABELS[normalizeProjectFundInputMode(project.fundInputMode)] || '-', after: (draft) => PROJECT_FUND_INPUT_MODE_LABELS[normalizeProjectFundInputMode(draft.fundInputMode)] || '-' },
  { key: 'registeredByName', label: '최종 보고자 (실무책임자)', before: (project) => normalizeChangeValue(project.registeredByName || project.managerName), after: (draft) => normalizeChangeValue(draft.registeredByName || draft.managerName) },
  { key: 'executiveApproverName', label: '최종 결재자 (총괄책임자)', before: (project) => normalizeChangeValue(project.executiveApproverName), after: (draft) => normalizeChangeValue(draft.executiveApproverName) },
  { key: 'teamName', label: '사내기업팀', before: (project) => normalizeChangeValue(project.teamName), after: (draft) => normalizeChangeValue(draft.teamName) },
  { key: 'staffing', label: '실제 투입인력', before: (project) => formatProjectStaffingSummary(project.staffing), after: (draft) => formatProjectStaffingSummary(draft.staffing) },
  { key: 'teamMembersDetailed', label: '서류상 참여인력', before: (project) => formatTeamMembersForChange(project.teamMembersDetailed), after: (draft) => formatTeamMembersForChange(draft.teamMembersDetailed) },
  { key: 'paymentPlan', label: '입금 분할', before: (project) => formatPaymentPlanForChange(project.paymentPlan), after: (draft) => formatPaymentPlanForChange(draft.paymentPlan) },
  { key: 'paymentExpectedMonths', label: '입금 예상월', before: (project) => formatPaymentExpectedMonthsForChange(project.paymentExpectedMonths), after: (draft) => formatPaymentExpectedMonthsForChange(draft.paymentExpectedMonths) },
  { key: 'advanceInterimBelow70Reason', label: '선금·중도금 70% 미만 사유', before: (project) => normalizeChangeValue(project.advanceInterimBelow70Reason), after: (draft) => normalizeChangeValue(draft.advanceInterimBelow70Reason) },
  { key: 'paymentPlanDesc', label: '기타 메모', before: (project) => normalizeChangeValue(project.paymentPlanDesc), after: (draft) => normalizeChangeValue(draft.paymentPlanDesc) },
  { key: 'finalPaymentNote', label: '최종 입금 메모', before: (project) => normalizeChangeValue(project.finalPaymentNote), after: (draft) => normalizeChangeValue(draft.finalPaymentNote) },
  { key: 'projectPurpose', label: '프로젝트 목적', before: (project) => normalizeChangeValue(project.projectPurpose), after: (draft) => normalizeChangeValue(draft.projectPurpose) },
  { key: 'description', label: '주요 내용', before: (project) => normalizeChangeValue(project.description), after: (draft) => normalizeChangeValue(draft.description) },
  { key: 'note', label: '비고', before: (project) => normalizeChangeValue(project.note), after: (draft) => normalizeChangeValue(draft.note) },
  { key: 'contractDocument', label: '계약서 PDF', before: (project) => normalizeChangeValue(project.contractDocument?.name), after: (draft) => normalizeChangeValue(draft.contractDocument?.name) },
  { key: 'quoteDocument', label: '산출내역서(견적서) PDF', before: (project) => normalizeChangeValue(project.quoteDocument?.name), after: (draft) => normalizeChangeValue(draft.quoteDocument?.name) },
  { key: 'quoteSubmissionDeferred', label: '산출내역서(견적서) 이후 제출', before: (project) => project.quoteSubmissionDeferred === true ? '예' : '아니오', after: (draft) => draft.quoteSubmissionDeferred ? '예' : '아니오' },
  { key: 'proposalDocument', label: '제안서 PDF', before: (project) => normalizeChangeValue(project.proposalDocument?.name), after: (draft) => normalizeChangeValue(draft.proposalDocument?.name) },
  { key: 'proposalWordOriginalDocument', label: '제안서 Word 원본', before: (project) => normalizeChangeValue(project.proposalWordOriginalDocument?.name), after: (draft) => normalizeChangeValue(draft.proposalWordOriginalDocument?.name) },
  { key: 'proposalPptOriginalDocument', label: '제안서 PPT 원본', before: (project) => normalizeChangeValue(project.proposalPptOriginalDocument?.name), after: (draft) => normalizeChangeValue(draft.proposalPptOriginalDocument?.name) },
  { key: 'presentationPptOriginalDocument', label: '발표자료 PPT 원본', before: (project) => normalizeChangeValue(project.presentationPptOriginalDocument?.name), after: (draft) => normalizeChangeValue(draft.presentationPptOriginalDocument?.name) },
  { key: 'proposalPptOriginal', label: '제안서(구글드라이브 링크)', before: (project) => normalizeChangeValue(project.registrationConfirmations?.proposalPptOriginal), after: (draft) => normalizeChangeValue(draft.registrationConfirmations.proposalPptOriginal) },
  { key: 'presentationPptOriginal', label: '발표자료(구글드라이브 링크)', before: (project) => normalizeChangeValue(project.registrationConfirmations?.presentationPptOriginal), after: (draft) => normalizeChangeValue(draft.registrationConfirmations.presentationPptOriginal) },
  { key: 'rfpRequestEvidenceDocument', label: 'RFP 또는 요청 메일 증빙', before: (project) => normalizeChangeValue(project.rfpRequestEvidenceDocument?.name), after: (draft) => normalizeChangeValue(draft.rfpRequestEvidenceDocument?.name) },
  { key: 'customerBusinessRegistrationDocument', label: '고객사 사업자등록증 PDF', before: (project) => normalizeChangeValue(project.customerBusinessRegistrationDocument?.name), after: (draft) => normalizeChangeValue(draft.customerBusinessRegistrationDocument?.name) },
  { key: 'performanceCertificateDocument', label: '수행확인서 PDF', before: (project) => normalizeChangeValue(project.performanceCertificateDocument?.name), after: (draft) => normalizeChangeValue(draft.performanceCertificateDocument?.name) },
  { key: 'taxInvoiceDocument', label: '세금계산서 PDF', before: (project) => normalizeChangeValue(project.taxInvoiceDocument?.name), after: (draft) => normalizeChangeValue(draft.taxInvoiceDocument?.name) },
  { key: 'finalSettlementReportDocument', label: '최종 정산보고서 PDF', before: (project) => normalizeChangeValue(project.finalSettlementReportDocument?.name), after: (draft) => normalizeChangeValue(draft.finalSettlementReportDocument?.name) },
  { key: 'finalReportDocument', label: '최종 결과보고서 PDF', before: (project) => normalizeChangeValue(project.finalReportDocument?.name), after: (draft) => normalizeChangeValue(draft.finalReportDocument?.name) },
];

export function createProjectEditorDraft(overrides: Partial<ProjectEditorDraft> = {}): ProjectEditorDraft {
  const version = registrationRequirementsVersion(overrides.registrationRequirementsVersion);
  const settlementType = normalizeSettlementType(overrides.settlementType ?? DEFAULT_DRAFT.settlementType);
  const basis = normalizeBasis(overrides.basis ?? DEFAULT_DRAFT.basis);
  const settlementDetailsEnabled = version === 2 ? basis !== 'NONE' : settlementType !== 'NONE';
  const totals = {
    contractAmount: nonNegativeAmount(overrides.contractAmount ?? DEFAULT_DRAFT.contractAmount),
    salesVatAmount: nonNegativeAmount(overrides.salesVatAmount ?? DEFAULT_DRAFT.salesVatAmount),
    totalRevenueAmount: nonNegativeAmount(overrides.totalRevenueAmount ?? DEFAULT_DRAFT.totalRevenueAmount),
    totalActualCost: nonNegativeAmount(overrides.totalActualCost ?? DEFAULT_DRAFT.totalActualCost),
    supportAmount: nonNegativeAmount(overrides.supportAmount ?? DEFAULT_DRAFT.supportAmount),
    profitRate: Math.min(1, Math.max(0, Number(overrides.profitRate ?? DEFAULT_DRAFT.profitRate) || 0)),
  };
  const draft = {
    ...DEFAULT_DRAFT,
    ...overrides,
    financialInputFlags: normalizeProjectFinancialInputFlagsForAmounts(
      overrides.financialInputFlags ?? DEFAULT_DRAFT.financialInputFlags,
      {
        contractAmount: overrides.contractAmount ?? DEFAULT_DRAFT.contractAmount,
        salesVatAmount: overrides.salesVatAmount ?? DEFAULT_DRAFT.salesVatAmount,
        totalRevenueAmount: overrides.totalRevenueAmount ?? DEFAULT_DRAFT.totalRevenueAmount,
        totalActualCost: overrides.totalActualCost ?? DEFAULT_DRAFT.totalActualCost,
        supportAmount: overrides.supportAmount ?? DEFAULT_DRAFT.supportAmount,
      },
    ),
    type: normalizeProjectType(overrides.type ?? DEFAULT_DRAFT.type),
    status: normalizeProjectStatus(overrides.status ?? DEFAULT_DRAFT.status),
    phase: normalizeProjectPhase(overrides.phase ?? DEFAULT_DRAFT.phase),
    settlementType,
    basis: version === 2 || settlementDetailsEnabled ? basis : 'NONE',
    accountType: !settlementDetailsEnabled
      ? 'NONE'
      : normalizeAccountType(overrides.accountType ?? DEFAULT_DRAFT.accountType),
    interestRefundPolicy: normalizeInterestRefundPolicy(overrides.interestRefundPolicy),
    settlementSystem: !settlementDetailsEnabled
      ? 'NONE'
      : normalizeSettlementSystemCode(overrides.settlementSystem ?? DEFAULT_DRAFT.settlementSystem),
    settlementSystemOther: !settlementDetailsEnabled
      ? ''
      : String(overrides.settlementSystemOther || ''),
    laborSettlementBasis: !settlementDetailsEnabled
      ? 'NONE'
      : normalizeLaborSettlementBasis(overrides.laborSettlementBasis ?? DEFAULT_DRAFT.laborSettlementBasis),
    fundInputMode: normalizeProjectFundInputMode(overrides.fundInputMode ?? DEFAULT_DRAFT.fundInputMode),
    settlementSheetPolicy: normalizeSettlementSheetPolicy(
      overrides.settlementSheetPolicy ?? DEFAULT_DRAFT.settlementSheetPolicy,
      normalizeProjectFundInputMode(overrides.fundInputMode ?? DEFAULT_DRAFT.fundInputMode),
    ),
    contractType: normalizeProjectContractType(overrides.contractType ?? DEFAULT_DRAFT.contractType),
    currency: normalizeProjectCurrency(overrides.currency ?? DEFAULT_DRAFT.currency),
    registeredById: text(overrides.registeredById ?? overrides.managerId ?? DEFAULT_DRAFT.registeredById),
    registeredByName: text(overrides.registeredByName ?? overrides.managerName ?? DEFAULT_DRAFT.registeredByName),
    registeredByEmail: text(overrides.registeredByEmail ?? DEFAULT_DRAFT.registeredByEmail),
    executiveApproverId: text(overrides.executiveApproverId ?? DEFAULT_DRAFT.executiveApproverId),
    executiveApproverName: text(overrides.executiveApproverName ?? DEFAULT_DRAFT.executiveApproverName),
    executiveApproverEmail: text(overrides.executiveApproverEmail ?? DEFAULT_DRAFT.executiveApproverEmail),
    managerId: text(overrides.registeredById ?? overrides.managerId ?? DEFAULT_DRAFT.managerId),
    managerName: text(overrides.registeredByName ?? overrides.managerName ?? DEFAULT_DRAFT.managerName),
    paymentPlan: normalizePaymentPlan(overrides.paymentPlan ?? DEFAULT_DRAFT.paymentPlan),
    paymentExpectedMonths: normalizePaymentExpectedMonths(
      overrides.paymentExpectedMonths ?? DEFAULT_DRAFT.paymentExpectedMonths,
    ),
    finalPaymentExpectedWeek: normalizeFinanceWeek(overrides.finalPaymentExpectedWeek),
    laborTransferPlan: normalizeLaborTransferPlan(
      overrides.laborTransferPlan ?? DEFAULT_DRAFT.laborTransferPlan,
    ),
    teamMembersDetailed: normalizeProjectTeamMembers(overrides.teamMembersDetailed),
    staffing: normalizeProjectStaffing(overrides.staffing ?? DEFAULT_DRAFT.staffing),
    registrationRequirementsVersion: version,
    contractEndUndecided: overrides.contractEndUndecided === true && !text(overrides.contractEnd),
    financialYears: projectFinancialYears(
      overrides.financialYears,
      overrides.contractStart ?? DEFAULT_DRAFT.contractStart,
      // 종료 기간 없음이면 재무 계획은 시작연도~현재 연도까지 편다.
      overrides.contractEndUndecided === true && !text(overrides.contractEnd)
        ? `${new Date().getFullYear()}-12-31`
        : (overrides.contractEnd ?? DEFAULT_DRAFT.contractEnd),
      totals,
      version,
    ),
    registrationConfirmations: registrationConfirmations(overrides.registrationConfirmations),
    registrationOptionalDocumentNotes: registrationOptionalDocumentNotes(overrides.registrationOptionalDocumentNotes),
    checkout: projectCheckout(overrides.checkout, settlementDetailsEnabled),
    quoteSubmissionDeferred: overrides.quoteSubmissionDeferred === true,
  };
  return normalizeProjectRevenueFields(draft, 'totalRevenueAmount');
}

export function buildProjectEditorDraftFromProject(
  project: Project,
  payload?: Partial<ProjectRequestPayload> | null,
): ProjectEditorDraft {
  const normalizedProject = normalizeProjectRevenueFields(project, 'totalRevenueAmount');
  const teamMembersDetailed = normalizeProjectTeamMembers(
    Array.isArray(normalizedProject.teamMembersDetailed)
      ? normalizedProject.teamMembersDetailed
      : payload?.teamMembersDetailed,
  );
  const contractDocument = normalizedProject.contractDocument ?? payload?.contractDocument ?? null;
  const quoteDocument = normalizedProject.quoteDocument ?? payload?.quoteDocument ?? null;
  const proposalDocument = normalizedProject.proposalDocument ?? payload?.proposalDocument ?? null;
  const proposalWordOriginalDocument = normalizedProject.proposalWordOriginalDocument
    ?? payload?.proposalWordOriginalDocument
    ?? null;
  const proposalPptOriginalDocument = normalizedProject.proposalPptOriginalDocument
    ?? payload?.proposalPptOriginalDocument
    ?? null;
  const presentationPptOriginalDocument = normalizedProject.presentationPptOriginalDocument
    ?? payload?.presentationPptOriginalDocument
    ?? null;
  const rfpRequestEvidenceDocument = normalizedProject.rfpRequestEvidenceDocument
    ?? payload?.rfpRequestEvidenceDocument
    ?? null;
  const customerBusinessRegistrationDocument = normalizedProject.customerBusinessRegistrationDocument
    ?? payload?.customerBusinessRegistrationDocument
    ?? null;
  const performanceCertificateDocument = normalizedProject.performanceCertificateDocument
    ?? payload?.performanceCertificateDocument
    ?? null;
  const taxInvoiceDocument = normalizedProject.taxInvoiceDocument ?? payload?.taxInvoiceDocument ?? null;
  const finalReportDocument = normalizedProject.finalReportDocument
    ?? payload?.finalReportDocument
    ?? null;
  const finalSettlementReportDocument = normalizedProject.finalSettlementReportDocument
    ?? payload?.finalSettlementReportDocument
    ?? null;

  return createProjectEditorDraft({
    name: text(normalizedProject.name || payload?.name),
    officialContractName: text(normalizedProject.officialContractName || payload?.officialContractName),
    type: normalizeProjectType(normalizedProject.type || payload?.type),
    description: text(normalizedProject.description || payload?.description),
    clientOrg: text(normalizedProject.clientOrg || payload?.clientOrg),
    businessManagementGoogleFolderLink: text(
      normalizedProject.businessManagementGoogleFolderLink || payload?.businessManagementGoogleFolderLink,
    ),
    participationSheetLink: text(
      normalizedProject.participationSheetLink || payload?.participationSheetLink,
    ),
    department: normalizeProjectDepartment(
      normalizedProject.department || normalizedProject.cic || payload?.department,
    ),
    projectPurpose: text(normalizedProject.projectPurpose || payload?.projectPurpose),
    status: normalizeProjectStatus(normalizedProject.status),
    phase: normalizeProjectPhase(normalizedProject.phase),
    contractType: normalizeProjectContractType(normalizedProject.contractType || payload?.contractType),
    contractStart: text(normalizedProject.contractStart || payload?.contractStart),
    contractEnd: text(normalizedProject.contractEnd || payload?.contractEnd),
    contractEndUndecided: (normalizedProject.contractEndUndecided ?? payload?.contractEndUndecided) === true,
    currency: normalizeProjectCurrency(normalizedProject.currency || payload?.currency),
    contractAmount: nonNegativeAmount(normalizedProject.contractAmount ?? payload?.contractAmount),
    salesVatAmount: nonNegativeAmount(normalizedProject.salesVatAmount ?? payload?.salesVatAmount),
    totalRevenueAmount: nonNegativeAmount(normalizedProject.totalRevenueAmount ?? payload?.totalRevenueAmount),
    totalActualCost: nonNegativeAmount(normalizedProject.totalActualCost ?? payload?.totalActualCost),
    supportAmount: nonNegativeAmount(normalizedProject.supportAmount ?? payload?.supportAmount),
    financialInputFlags: normalizeProjectFinancialInputFlagsForAmounts(
      normalizedProject.financialInputFlags || payload?.financialInputFlags,
      {
        contractAmount: normalizedProject.contractAmount ?? payload?.contractAmount,
        salesVatAmount: normalizedProject.salesVatAmount ?? payload?.salesVatAmount,
        totalRevenueAmount: normalizedProject.totalRevenueAmount ?? payload?.totalRevenueAmount,
        totalActualCost: normalizedProject.totalActualCost ?? payload?.totalActualCost,
        supportAmount: normalizedProject.supportAmount ?? payload?.supportAmount,
      },
    ),
    registrationRequirementsVersion: registrationRequirementsVersion(
      normalizedProject.registrationRequirementsVersion ?? payload?.registrationRequirementsVersion,
    ),
    financialYears: normalizedProject.financialYears ?? payload?.financialYears,
    registrationConfirmations: normalizedProject.registrationConfirmations ?? payload?.registrationConfirmations,
    registrationOptionalDocumentNotes: normalizedProject.registrationOptionalDocumentNotes
      ?? payload?.registrationOptionalDocumentNotes,
    checkout: normalizedProject.checkout ?? payload?.checkout,
    settlementType: normalizeSettlementType(normalizedProject.settlementType || payload?.settlementType),
    basis: normalizeBasis(normalizedProject.basis || payload?.basis),
    accountType: normalizeAccountType(normalizedProject.accountType || payload?.accountType),
    interestRefundPolicy: normalizeInterestRefundPolicy(
      normalizedProject.interestRefundPolicy || payload?.interestRefundPolicy,
    ),
    settlementSystem: normalizeSettlementSystemCode(
      normalizedProject.settlementSystem || payload?.settlementSystem,
    ),
    settlementSystemOther: text(
      normalizedProject.settlementSystemOther || payload?.settlementSystemOther,
    ),
    laborSettlementBasis: normalizeLaborSettlementBasis(
      normalizedProject.laborSettlementBasis || payload?.laborSettlementBasis,
    ),
    fundInputMode: normalizeProjectFundInputMode(normalizedProject.fundInputMode || payload?.fundInputMode),
    settlementSheetPolicy: normalizeSettlementSheetPolicy(
      normalizedProject.settlementSheetPolicy || payload?.settlementSheetPolicy,
      normalizeProjectFundInputMode(normalizedProject.fundInputMode || payload?.fundInputMode),
    ),
    profitRate: normalizedProject.profitRate,
    profitAmount: normalizedProject.profitAmount,
    registeredById: text(normalizedProject.registeredById || payload?.registeredById || normalizedProject.managerId || payload?.managerId),
    registeredByName: text(normalizedProject.registeredByName || payload?.registeredByName || normalizedProject.managerName || payload?.managerName),
    registeredByEmail: text(normalizedProject.registeredByEmail || payload?.registeredByEmail),
    executiveApproverId: text(normalizedProject.executiveApproverId || payload?.executiveApproverId),
    executiveApproverName: text(normalizedProject.executiveApproverName || payload?.executiveApproverName),
    executiveApproverEmail: text(normalizedProject.executiveApproverEmail || payload?.executiveApproverEmail),
    managerId: text(normalizedProject.registeredById || payload?.registeredById || normalizedProject.managerId || payload?.managerId),
    managerName: text(normalizedProject.registeredByName || payload?.registeredByName || normalizedProject.managerName || payload?.managerName),
    teamName: text(normalizedProject.teamName || payload?.teamName),
    teamMembersDetailed,
    staffing: normalizeProjectStaffing(normalizedProject.staffing ?? payload?.staffing),
    participantCondition: text(normalizedProject.participantCondition || payload?.participantCondition),
    note: text(normalizedProject.note || payload?.note),
    paymentPlanDesc: text(normalizedProject.paymentPlanDesc || payload?.paymentPlanDesc),
    settlementGuide: text(normalizedProject.settlementGuide || payload?.settlementGuide),
    groupwareName: text(normalizedProject.groupwareName || payload?.groupwareName),
    paymentPlan: normalizePaymentPlan(normalizedProject.paymentPlan || payload?.paymentPlan),
    paymentExpectedMonths: normalizePaymentExpectedMonths(
      normalizedProject.paymentExpectedMonths || payload?.paymentExpectedMonths,
    ),
    finalPaymentExpectedWeek: normalizeFinanceWeek(
      normalizedProject.finalPaymentExpectedWeek || payload?.finalPaymentExpectedWeek,
    ),
    laborTransferPlan: normalizeLaborTransferPlan(
      normalizedProject.laborTransferPlan || payload?.laborTransferPlan,
    ),
    advanceInterimBelow70Reason: text(
      normalizedProject.advanceInterimBelow70Reason || payload?.advanceInterimBelow70Reason,
    ),
    finalPaymentNote: text(normalizedProject.finalPaymentNote),
    budgetCurrentYear: nonNegativeAmount(normalizedProject.budgetCurrentYear),
    taxInvoiceAmount: nonNegativeAmount(normalizedProject.taxInvoiceAmount),
    contractDocument,
    quoteDocument,
    quoteSubmissionDeferred: normalizedProject.quoteSubmissionDeferred === true || payload?.quoteSubmissionDeferred === true,
    proposalDocument,
    proposalWordOriginalDocument,
    proposalPptOriginalDocument,
    presentationPptOriginalDocument,
    rfpRequestEvidenceDocument,
    customerBusinessRegistrationDocument,
    performanceCertificateDocument,
    taxInvoiceDocument,
    finalSettlementReportDocument,
    finalReportDocument,
    contractAnalysis: normalizedProject.contractAnalysis ?? payload?.contractAnalysis ?? null,
  });
}


/** 실제 투입인력 슬롯 정규화. personId 없는 슬롯은 미정(null)으로 본다 - 명부 밖 인물은 담지 않는다. */
function normalizeStaffingSlot(value: unknown): ProjectStaffingSlot | null {
  if (!value || typeof value !== 'object') return null;
  const slot = value as Partial<ProjectStaffingSlot>;
  const personId = text(slot.personId);
  if (!personId) return null;
  return { personId, name: text(slot.name), nickname: text(slot.nickname) };
}

export const PROJECT_STAFFING_ROLE_MAX_LENGTH = 20;
export const PROJECT_STAFFING_OTHERS_MAX = 10;

/** 기타 역할명 표기 통일. 앞뒤·중복 공백을 없애고 길이를 제한한다. */
export function normalizeStaffingRoleName(value: unknown): string {
  return text(value).replace(/\s+/g, ' ').slice(0, PROJECT_STAFFING_ROLE_MAX_LENGTH);
}

export function normalizeProjectStaffing(value: unknown): ProjectStaffing {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<ProjectStaffing>;
  const operators = (Array.isArray(source.operators) ? source.operators : [])
    .map((slot) => normalizeStaffingSlot(slot))
    .filter((slot): slot is ProjectStaffingSlot => slot !== null);
  // 역할명이 비면 저장하지 않는다 - 사람만 있고 역할이 없는 줄은 읽는 쪽에서 뜻을 알 수 없다.
  const others: ProjectStaffingOtherRole[] = [];
  for (const item of Array.isArray(source.others) ? source.others : []) {
    const role = normalizeStaffingRoleName((item as ProjectStaffingOtherRole | undefined)?.role);
    if (!role) continue;
    others.push({ role, slot: normalizeStaffingSlot((item as ProjectStaffingOtherRole).slot) });
    if (others.length >= PROJECT_STAFFING_OTHERS_MAX) break;
  }
  return {
    lead: normalizeStaffingSlot(source.lead),
    pm: normalizeStaffingSlot(source.pm),
    operators,
    others,
    settlementSupport: text(source.settlementSupport),
  };
}

/** 변경 비교·검토 카드용 한 줄 요약. */
export function formatProjectStaffingSummary(value: unknown): string {
  const staffing = normalizeProjectStaffing(value);
  const slotLabel = (slot: ProjectStaffingSlot | null) => (slot ? `${slot.nickname || slot.name}` : '미정');
  const parts = [
    `총괄 ${slotLabel(staffing.lead)}`,
    `실무 ${slotLabel(staffing.pm)}`,
    `운영 ${staffing.operators.length ? staffing.operators.map((slot) => slot.nickname || slot.name).join('·') : '미정'}`,
    ...(staffing.others.length
      ? [staffing.others.map((item) => `${item.role} ${slotLabel(item.slot)}`).join(' / ')]
      : []),
    `정산지원 ${staffing.settlementSupport || '해당 없음'}`,
  ];
  return parts.join(' / ');
}

export function buildProjectRequestPayloadFromDraft(draftInput: ProjectEditorDraft): ProjectRequestPayload {
  const draft = createProjectEditorDraft(draftInput);
  const teamMembersDetailed = projectTeamMembersForWrite(draft.teamMembersDetailed);
  return {
    name: text(draft.name),
    officialContractName: text(draft.officialContractName),
    type: normalizeProjectType(draft.type),
    status: normalizeProjectStatus(draft.status),
    phase: normalizeProjectPhase(draft.phase),
    description: text(draft.description),
    clientOrg: text(draft.clientOrg),
    businessManagementGoogleFolderLink: text(draft.businessManagementGoogleFolderLink),
    participationSheetLink: text(draft.participationSheetLink),
    staffing: normalizeProjectStaffing(draft.staffing),
    department: normalizeProjectDepartment(draft.department),
    groupwareName: text(draft.groupwareName),
    currency: normalizeProjectCurrency(draft.currency),
    contractAmount: nonNegativeAmount(draft.contractAmount),
    salesVatAmount: nonNegativeAmount(draft.salesVatAmount),
    totalRevenueAmount: nonNegativeAmount(draft.totalRevenueAmount),
    totalActualCost: nonNegativeAmount(draft.totalActualCost),
    supportAmount: nonNegativeAmount(draft.supportAmount),
    financialInputFlags: normalizeProjectFinancialInputFlagsForAmounts(draft.financialInputFlags, draft),
    registrationRequirementsVersion: draft.registrationRequirementsVersion,
    financialYears: projectFinancialYearsForWrite(draft.financialYears),
    registrationOptionalDocumentNotes: draft.registrationOptionalDocumentNotes,
    registrationConfirmations: draft.registrationConfirmations,
    checkout: draft.checkout,
    contractStart: text(draft.contractStart),
    contractEnd: text(draft.contractEnd),
    contractEndUndecided: draft.contractEndUndecided === true && !text(draft.contractEnd),
    contractType: normalizeProjectContractType(draft.contractType),
    settlementType: normalizeSettlementType(draft.settlementType),
    basis: normalizeBasis(draft.basis),
    accountType: normalizeAccountType(draft.accountType),
    interestRefundPolicy: normalizeInterestRefundPolicy(draft.interestRefundPolicy) || undefined,
    settlementSystem: normalizeSettlementSystemCode(draft.settlementSystem),
    settlementSystemOther: draft.settlementSystem === 'OTHER' ? text(draft.settlementSystemOther) : '',
    laborSettlementBasis: normalizeLaborSettlementBasis(draft.laborSettlementBasis),
    fundInputMode: normalizeProjectFundInputMode(draft.fundInputMode),
    settlementSheetPolicy: normalizeSettlementSheetPolicy(draft.settlementSheetPolicy, normalizeProjectFundInputMode(draft.fundInputMode)),
    paymentPlan: normalizePaymentPlan(draft.paymentPlan),
    paymentExpectedMonths: normalizePaymentExpectedMonths(draft.paymentExpectedMonths),
    finalPaymentExpectedWeek: normalizeFinanceWeek(draft.finalPaymentExpectedWeek),
    laborTransferPlan: normalizeLaborTransferPlan(draft.laborTransferPlan),
    advanceInterimBelow70Reason: text(draft.advanceInterimBelow70Reason),
    paymentPlanDesc: text(draft.paymentPlanDesc),
    settlementGuide: text(draft.settlementGuide),
    finalPaymentNote: text(draft.finalPaymentNote),
    note: text(draft.note),
    projectPurpose: text(draft.projectPurpose),
    registeredById: text(draft.registeredById),
    registeredByName: text(draft.registeredByName),
    registeredByEmail: text(draft.registeredByEmail),
    executiveApproverId: text(draft.executiveApproverId),
    executiveApproverName: text(draft.executiveApproverName),
    executiveApproverEmail: text(draft.executiveApproverEmail),
    managerId: text(draft.registeredById),
    managerName: text(draft.registeredByName),
    teamName: text(draft.teamName),
    teamMembers: formatProjectTeamMembersSummary(teamMembersDetailed, '', ', '),
    teamMembersDetailed,
    participantCondition: text(draft.participantCondition),
    contractDocument: draft.contractDocument,
    quoteDocument: draft.quoteDocument,
    quoteSubmissionDeferred: draft.quoteSubmissionDeferred,
    proposalDocument: draft.proposalDocument,
    proposalWordOriginalDocument: draft.proposalWordOriginalDocument,
    proposalPptOriginalDocument: draft.proposalPptOriginalDocument,
    presentationPptOriginalDocument: draft.presentationPptOriginalDocument,
    rfpRequestEvidenceDocument: draft.rfpRequestEvidenceDocument,
    customerBusinessRegistrationDocument: draft.customerBusinessRegistrationDocument,
    performanceCertificateDocument: draft.performanceCertificateDocument,
    taxInvoiceDocument: draft.taxInvoiceDocument,
    finalSettlementReportDocument: draft.finalSettlementReportDocument,
    contractAnalysis: draft.contractAnalysis,
  };
}

export function buildProjectEditorReviewChanges(
  project: Project,
  draftInput: ProjectEditorDraft,
): ProjectExecutiveReviewHistoryEntry['changes'] {
  const draft = createProjectEditorDraft(draftInput);
  return REVIEW_CHANGE_FIELDS
    .map((field) => ({
      key: field.key,
      label: field.label,
      before: normalizeChangeValue(field.before(project)),
      after: normalizeChangeValue(field.after(draft)),
    }))
    .filter((change) => change.before !== change.after);
}

function shouldResetApprovedPortalEdit(
  draft: ProjectEditorDraft,
  options: ProjectEditorPatchOptions,
) {
  return options.mode === 'portal-edit'
    && options.baseProject?.registrationSource === 'pm_portal'
    && options.baseProject?.executiveReviewStatus === 'APPROVED'
    && text(draft.name);
}

function appendPendingReviewHistory(
  project: Project,
  draft: ProjectEditorDraft,
  options: ProjectEditorPatchOptions,
  changes = buildProjectEditorReviewChanges(project, draft),
): ProjectExecutiveReviewHistoryEntry[] {
  const current = Array.isArray(project.executiveReviewHistory) ? project.executiveReviewHistory : [];
  const previousStatus = project.executiveReviewStatus || 'PENDING';
  return [
    ...current,
    {
      status: 'PENDING',
      previousStatus,
      reviewedAt: options.now,
      reviewedById: options.actorId,
      reviewedByName: options.actorName,
      reviewComment: text(options.executiveReviewComment) || undefined,
      ...(changes && changes.length > 0 ? { changes } : {}),
    },
  ];
}

export function buildProjectEditorProjectPatch(
  draftInput: ProjectEditorDraft,
  options: ProjectEditorPatchOptions,
): Partial<Project> {
  const draft = createProjectEditorDraft(draftInput);
  const flags = normalizeProjectFinancialInputFlagsForAmounts(draft.financialInputFlags, draft);
  const teamMembersDetailed = projectTeamMembersForWrite(draft.teamMembersDetailed);
  const reviewChanges = options.baseProject
    ? (buildProjectEditorReviewChanges(options.baseProject, draft) || [])
    : [];
  const patch: Partial<Project> = {
    name: text(draft.name),
    officialContractName: text(draft.officialContractName),
    type: normalizeProjectType(draft.type),
    currency: normalizeProjectCurrency(draft.currency),
    contractAmount: nonNegativeAmount(draft.contractAmount),
    contractStart: text(draft.contractStart),
    contractEnd: text(draft.contractEnd),
    contractEndUndecided: draft.contractEndUndecided === true && !text(draft.contractEnd),
    settlementType: normalizeSettlementType(draft.settlementType),
    basis: normalizeBasis(draft.basis),
    accountType: normalizeAccountType(draft.accountType),
    interestRefundPolicy: normalizeInterestRefundPolicy(draft.interestRefundPolicy) || undefined,
    settlementSystem: normalizeSettlementSystemCode(draft.settlementSystem),
    settlementSystemOther: draft.settlementSystem === 'OTHER' ? text(draft.settlementSystemOther) : '',
    laborSettlementBasis: normalizeLaborSettlementBasis(draft.laborSettlementBasis),
    fundInputMode: normalizeProjectFundInputMode(draft.fundInputMode),
    settlementSheetPolicy: normalizeSettlementSheetPolicy(draft.settlementSheetPolicy, normalizeProjectFundInputMode(draft.fundInputMode)),
    paymentPlan: normalizePaymentPlan(draft.paymentPlan),
    paymentExpectedMonths: normalizePaymentExpectedMonths(draft.paymentExpectedMonths),
    laborTransferPlan: normalizeLaborTransferPlan(draft.laborTransferPlan),
    staffing: normalizeProjectStaffing(draft.staffing),
    advanceInterimBelow70Reason: text(draft.advanceInterimBelow70Reason),
    paymentPlanDesc: text(draft.paymentPlanDesc),
    clientOrg: text(draft.clientOrg),
    businessManagementGoogleFolderLink: text(draft.businessManagementGoogleFolderLink),
    participationSheetLink: text(draft.participationSheetLink),
    groupwareName: text(draft.groupwareName),
    participantCondition: text(draft.participantCondition),
    teamMembersDetailed,
    contractType: normalizeProjectContractType(draft.contractType),
    projectPurpose: text(draft.projectPurpose),
    totalRevenueAmount: nonNegativeAmount(draft.totalRevenueAmount),
    totalActualCost: nonNegativeAmount(draft.totalActualCost),
    supportAmount: nonNegativeAmount(draft.supportAmount),
    salesVatAmount: nonNegativeAmount(draft.salesVatAmount),
    financialInputFlags: flags,
    registrationRequirementsVersion: draft.registrationRequirementsVersion,
    financialYears: projectFinancialYearsForWrite(draft.financialYears),
    registrationOptionalDocumentNotes: draft.registrationOptionalDocumentNotes,
    registrationConfirmations: draft.registrationConfirmations,
    finalPaymentExpectedWeek: normalizeFinanceWeek(draft.finalPaymentExpectedWeek),
    checkout: draft.checkout,
    settlementGuide: text(draft.settlementGuide),
    note: text(draft.note),
    contractDocument: draft.contractDocument,
    quoteDocument: draft.quoteDocument,
    quoteSubmissionDeferred: draft.quoteSubmissionDeferred,
    proposalDocument: draft.proposalDocument,
    proposalWordOriginalDocument: draft.proposalWordOriginalDocument,
    proposalPptOriginalDocument: draft.proposalPptOriginalDocument,
    presentationPptOriginalDocument: draft.presentationPptOriginalDocument,
    rfpRequestEvidenceDocument: draft.rfpRequestEvidenceDocument,
    customerBusinessRegistrationDocument: draft.customerBusinessRegistrationDocument,
    performanceCertificateDocument: draft.performanceCertificateDocument,
    taxInvoiceDocument: draft.taxInvoiceDocument,
    finalSettlementReportDocument: draft.finalSettlementReportDocument,
    contractAnalysis: draft.contractAnalysis,
    department: normalizeProjectDepartment(draft.department),
    cic: resolveProjectCic({ department: draft.department }),
    teamName: text(draft.teamName),
    registeredById: text(draft.registeredById),
    registeredByName: text(draft.registeredByName),
    registeredByEmail: text(draft.registeredByEmail),
    executiveApproverId: text(draft.executiveApproverId),
    executiveApproverName: text(draft.executiveApproverName),
    executiveApproverEmail: text(draft.executiveApproverEmail),
    managerId: text(draft.registeredById),
    managerName: text(draft.registeredByName),
    budgetCurrentYear: nonNegativeAmount(draft.budgetCurrentYear || draft.contractAmount),
    taxInvoiceAmount: nonNegativeAmount(draft.taxInvoiceAmount),
    profitRate: draft.profitRate,
    profitAmount: draft.profitAmount,
    description: text(draft.description),
    updatedAt: options.now,
  };

  if (options.mode === 'admin') {
    patch.status = normalizeProjectStatus(draft.status);
    patch.phase = normalizeProjectPhase(draft.phase);
  }

  if (
    options.forceExecutiveReviewPending
    || shouldResetApprovedPortalEdit(draft, options)
    || (
      options.mode === 'portal-edit'
      && options.baseProject?.registrationSource === 'pm_portal'
      && options.baseProject?.executiveReviewStatus === 'PENDING'
      && reviewChanges.length > 0
    )
  ) {
    patch.executiveReviewStatus = 'PENDING';
    patch.executiveReviewedAt = null;
    patch.executiveReviewedById = null;
    patch.executiveReviewedByName = null;
    patch.executiveReviewComment = null;
    if (options.baseProject) {
      patch.executiveReviewHistory = appendPendingReviewHistory(options.baseProject, draft, options, reviewChanges);
    }
  }

  return normalizeProjectRevenueFields(patch, 'totalRevenueAmount');
}
