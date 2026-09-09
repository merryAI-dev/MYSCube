import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarRange,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  ClipboardList,
  FileText,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
  Users,
  Wallet,
  Circle,
  CircleCheck,
  Clock3,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useAuth } from '../../data/auth-store';
import { useFirebase } from '../../lib/firebase-context';
import { PlatformApiError } from '../../platform/api-client';
import { resolveApiErrorPresentation } from '../../platform/api-error-messages';
import {
  fetchParticipationSystemAccountViaBff,
  previewParticipationSheetByLinkViaBff,
  type ParticipationSheetPreview,
} from '../../lib/platform-bff-client';
import { ProjectStaffingSection } from './ProjectStaffingSection';
import {
  FIELD_W_MD,
  FIELD_W_SM,
  FIELD_W_XS,
  FORM_CONTROL_CLASS,
  FORM_ERROR_CLASS,
  FORM_FIELD_STACK_CLASS,
  FORM_HINT_CLASS,
  FORM_LABEL_CLASS,
  FORM_NUMERIC_CONTROL_CLASS,
  FORM_NUMERIC_VALUE_CLASS,
  FORM_SECTION_CLASS,
  FORM_SECTION_STACK_CLASS,
  FORM_VALUE_CLASS,
  ProjectFormRow,
  ProjectFormSection,
  describeSubmitIssue,
} from './project-form-layout';
import { toast } from 'sonner';
import { useBlocker } from 'react-router';
import {
  ACCOUNT_TYPE_LABELS,
  INTEREST_REFUND_POLICY_LABELS,
  BASIS_LABELS,
  LABOR_SETTLEMENT_BASIS_LABELS,
  getProjectContractTypeSelectableOptions,
  getProjectTypeSelectableOptions,
  normalizeProjectContractType,
  PROJECT_CURRENCY_LABELS,
  PROJECT_PHASE_LABELS,
  PROJECT_SETTLEMENT_SYSTEM_CODES,
  REGISTRATION_V2_BASIS_LABELS,
  PROJECT_STATUS_LABELS,
  PROJECT_TYPE_LABELS,
  SETTLEMENT_TYPE_LABELS,
  SETTLEMENT_SYSTEM_LABELS,
  type AccountType,
  type InterestRefundPolicy,
  type Basis,
  type LaborSettlementBasis,
  type OrgMember,
  type FileAttachment,
  type ProjectCurrency,
  type ProjectFinancialYear,
  type ProjectFinancialInputFlags,
  type ProjectPaymentExpectedMonths,
  type ProjectPhase,
  type ProjectRequestContractAnalysis,
  type ProjectStatus,
  type ProjectTeamMemberAssignment,
  type ProjectType,
  type SettlementType,
  type SettlementSystemCode,
} from '../../data/types';
import { PROJECT_DEPARTMENT_OPTIONS, dedupeProjectDepartmentLabels } from '../../data/project-department-options';
import { checkContractAmount } from '../../platform/project-contract-amount-check';
import type { DirectoryPerson } from '../../platform/person-directory';
import {
} from '../../data/project-team-member-options';
import {
  CONTRACT_AMOUNT_ITEM_FIELDS,
  deriveContractAmountFromItems,
  formatProjectAmountInput,
  formatStoredProjectAmount,
  hasExplicitProjectAmountInput,
  normalizeProjectFinancialInputFlags,
  parseProjectAmountInput,
  type ContractAmountItemField,
} from '../../platform/project-contract-amount';
import { buildContractDocumentEditPolicy } from '../../platform/project-contract-document-policy';
import { deriveProjectStatusFromContractPeriod } from '../../platform/project-status-from-period';
import { advanceFocusToNextInput, shouldAdvanceOnEnter } from '../../platform/form-advance-on-enter';
import {
  PROJECT_REQUEST_DOCUMENT_UPLOAD_MAX_SIZE_BYTES,
  PROJECT_REQUEST_DOCUMENT_UPLOAD_MAX_SIZE_LABEL,
  PROJECT_PRIVATE_DRAFT_DOCUMENT_UPLOAD_MAX_SIZE_BYTES,
  PROJECT_PRIVATE_DRAFT_DOCUMENT_UPLOAD_MAX_SIZE_LABEL,
  getProjectDocumentUploadAccept,
  isProjectDocumentFileAllowed,
  type ProjectRequestDocumentKind,
} from '../../platform/project-contract-upload';
import { formatProfitRatePercentInput } from '../../platform/project-financials';
import { isValidDriveUrl } from '../../platform/evidence-helpers';
import {
  createProjectEditorDraft,
  formatProjectStaffingSummary,
  hasInvalidProjectContractPeriod,
  type ProjectEditorDraft,
  type ProjectEditorMode,
} from '../../platform/project-editor';
import { normalizeProjectDepartment } from '../../platform/project-cic';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import {
  formatProjectTeamMembersSummary,
  hasIncompleteProjectTeamMembers,
  isProjectSettlementSupportMember,
  mapParticipationSheetPreviewToProjectTeamMembers,
  normalizeProjectTeamMemberDraftRows,
  parseProjectTeamMemberIdentityInput,
  participationSheetLinkRequired,
  participationSheetSyncIssue,
  participationSheetSyncSignature,
  PROJECT_TEAM_MEMBER_ROLES,
  RETIRED_PROJECT_TEAM_MEMBER_ROLES,
} from '../../platform/project-team-members';
import { MemberPicker } from '../ui/member-picker';
import {
  buildOrgMemberPickerOptions,
  withSavedOrgMemberOption,
} from '../../data/project-team-member-options';
import { shouldResetProjectEditorDraft } from './project-editor-reset';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Progress } from '../ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Textarea } from '../ui/textarea';
import { ContractDocumentPreview } from './ContractDocumentPreview';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '../ui/command';
import { cn } from '../ui/utils';

type ProjectEditorStep = 'basic' | 'financial' | 'team' | 'review';

export interface ProjectEditorAction {
  id: string;
  label: string;
  icon?: typeof Save;
  variant?: 'default' | 'outline' | 'secondary' | 'destructive';
  disabled?: boolean;
}

interface ProjectEditorWizardProps {
  mode: ProjectEditorMode;
  initialDraft: ProjectEditorDraft;
  draftKey: string;
  title: string;
  description?: string;
  embeddedInShell?: boolean;
  members?: OrgMember[];
  /** 인력 명부. 계정 목록을 못 받았을 때 팀원 후보의 안전망이 된다. */
  roster?: DirectoryPerson[];
  departmentOptions?: string[];
  settlementSystemOptions?: string[];
  topSlot?: ReactNode;
  showCheckoutEntry?: boolean;
  actions: ProjectEditorAction[];
  busyActionId?: string | null;
  readOnly?: boolean;
  trustedParticipationSheetDraft?: ProjectEditorDraft;
  onContractFileUpload?: (file: File) => Promise<{
    contractDocument: ProjectEditorDraft['contractDocument'];
    contractAnalysis: ProjectRequestContractAnalysis | null;
  }>;
  onProjectDocumentFileUpload?: (input: { kind: ProjectRequestDocumentKind; file: File }) => Promise<{
    document: FileAttachment;
    contractAnalysis: ProjectRequestContractAnalysis | null;
  }>;
  documentPreviewUrls?: Partial<Record<ProjectRequestDocumentKind, string>>;
  documentPreviewStates?: Partial<Record<ProjectRequestDocumentKind, {
    status: 'idle' | 'loading' | 'ready' | 'error';
    error?: string;
  }>>;
  onLoadDocumentPreview?: (kind: ProjectRequestDocumentKind) => void | Promise<void>;
  onRemoveProjectDocument?: (kind: ProjectRequestDocumentKind) => void | Promise<void>;
  contractAnalysisMergeMode?: 'fill-empty' | 'none';
  canRemoveContractDocument?: boolean;
  canRemoveProjectDocuments?: boolean;
  autosave?: {
    key: string;
    disabled?: boolean;
    onSave?: (draft: ProjectEditorDraft, stepIndex: number) => void | Promise<void>;
    onDiscard?: () => void | Promise<void>;
  };
  onCancel?: () => void | Promise<void>;
  onLeave?: () => void | Promise<void>;
  onSubmit: (draft: ProjectEditorDraft, actionId: string) => void | Promise<void>;
}

const PROJECT_EDITOR_AUTOSAVE_SCHEMA_VERSION = 1;

type ContractUploadState = 'idle' | 'extracting' | 'ready' | 'error';
const REGISTRATION_DOCUMENT_KINDS: ProjectRequestDocumentKind[] = [
  'contract',
  'customer_business_registration',
  'quote',
  'proposal_word_original',
  'proposal_ppt_original',
  'presentation_ppt_original',
  'rfp_request_evidence',
];
const CHECKOUT_DOCUMENT_KINDS: ProjectRequestDocumentKind[] = [
  'performance_certificate',
  'tax_invoice',
  'final_settlement_report',
];
const PROJECT_DOCUMENT_LABELS: Record<ProjectRequestDocumentKind, string> = {
  contract: '계약서 PDF',
  customer_business_registration: '고객사 사업자등록증 PDF',
  quote: '산출내역서(견적서) PDF',
  proposal: '제안서 PDF',
  proposal_word_original: '제안서 Word 원본',
  proposal_ppt_original: '제안서 PPT 원본',
  presentation_ppt_original: '발표자료 PPT 원본',
  rfp_request_evidence: 'RFP/요청 메일 증빙',
  performance_certificate: '수행확인서 PDF',
  tax_invoice: '세금계산서 PDF',
  final_settlement_report: '최종 정산보고서 PDF',
  final_report: '최종 결과보고서',
};
const PROJECT_DOCUMENT_BUTTON_LABELS: Record<ProjectRequestDocumentKind, string> = {
  contract: '계약서',
  customer_business_registration: '사업자등록증',
  quote: '산출내역서(견적서)',
  proposal: '제안서',
  proposal_word_original: '제안서 Word 원본',
  proposal_ppt_original: '제안서 PPT 원본',
  presentation_ppt_original: '발표자료 PPT 원본',
  rfp_request_evidence: 'RFP/요청 메일 증빙',
  performance_certificate: '수행확인서',
  tax_invoice: '세금계산서',
  final_settlement_report: '최종 정산보고서',
  final_report: '최종 결과보고서',
};
const PROJECT_DOCUMENT_FIELD: Record<ProjectRequestDocumentKind, keyof ProjectEditorDraft> = {
  contract: 'contractDocument',
  customer_business_registration: 'customerBusinessRegistrationDocument',
  quote: 'quoteDocument',
  proposal: 'proposalDocument',
  proposal_word_original: 'proposalWordOriginalDocument',
  proposal_ppt_original: 'proposalPptOriginalDocument',
  presentation_ppt_original: 'presentationPptOriginalDocument',
  rfp_request_evidence: 'rfpRequestEvidenceDocument',
  performance_certificate: 'performanceCertificateDocument',
  tax_invoice: 'taxInvoiceDocument',
  final_settlement_report: 'finalSettlementReportDocument',
  final_report: 'finalReportDocument',
};
const OPTIONAL_REGISTRATION_DOCUMENT_NOTE_FIELD = {
  proposal_word_original: 'proposalWordOriginal',
  proposal_ppt_original: 'proposalPptOriginal',
  presentation_ppt_original: 'presentationPptOriginal',
} as const;
type RegistrationDocumentSlot = {
  number: number;
  label: string;
  description: string;
  kinds: ProjectRequestDocumentKind[];
};
const REGISTRATION_DOCUMENT_SLOTS: RegistrationDocumentSlot[] = [
  {
    number: 1,
    label: '계약서 *',
    description: '',
    kinds: ['contract'],
  },
  {
    number: 2,
    label: '고객사 사업자등록증 *',
    description: '',
    kinds: ['customer_business_registration'],
  },
  {
    number: 3,
    label: '산출내역서(견적서) *',
    description: '',
    kinds: ['quote'],
  },
  {
    number: 4,
    label: '제안서(워드)',
    description: '있을 시',
    kinds: ['proposal_word_original'],
  },
  {
    number: 5,
    label: '제안서 PPT 링크(구글드라이브 링크)',
    description: '있을 시',
    kinds: ['proposal_ppt_original'],
  },
  {
    number: 6,
    label: '발표자료(구글드라이브 링크)',
    description: '있을 시',
    kinds: ['presentation_ppt_original'],
  },
  {
    number: 7,
    label: 'RFP',
    description: '없으면 사업요청사항을 확인할 수 있는 메일 본문 등 첨부',
    kinds: ['rfp_request_evidence'],
  },
];
type AutosaveState = 'idle' | 'saving' | 'saved' | 'error';
type StoredProjectEditorDraft = {
  schemaVersion: number;
  draftKey: string;
  draft: ProjectEditorDraft;
  stepIndex: number;
  updatedAt: string;
};

const STEPS: Array<{
  id: ProjectEditorStep;
  label: string;
  icon: typeof Building2;
}> = [
  { id: 'basic', label: '기본 정보', icon: Building2 },
  { id: 'financial', label: '계약/재무', icon: Wallet },
  { id: 'team', label: '팀/인력', icon: Users },
  { id: 'review', label: '검토 및 저장', icon: ClipboardList },
];

/*
 * 강조색 #0176D3 은 단 하나의 의미만 갖는다: "여기가 지금 초점" — 필수 마커 · 포커스 링 ·
 * 활성 단계 칩. 그 밖에는 회색조를 쓴다. 상태(오류)는 red 하나로만 말하고,
 * 계산된 값은 색이 아니라 형태(입력칸 없음 + 세로선)로 구분한다.
 * Tailwind 임의값은 리터럴이어야 해서 상수로 빼지 않고 클래스 문자열로 직접 쓴다.
 */

/**
 * 글자는 네 역할만 쓴다. 예전에는 text-sm / text-xs / text-[12px] / text-[11px] / text-[10px] 가
 * 섞여 있었고 그중 text-xs 와 text-[12px] 는 같은 12px 를 두 이름으로 부르던 우연한 중복이었다.
 * 개별 화면에서 새 크기를 만들지 말고 아래 네 개만 쓴다.
 */






/**
 * 간격은 세 값만 쓴다: 8(라벨↔입력) / 16(필드↔필드) / 24(섹션↔섹션).
 * 묶음 안쪽이 바깥쪽보다 항상 좁아야 그룹이 뒤집혀 보이지 않는다.
 */



const PROJECT_EDITOR_FORM_SURFACE_CLASS = [
  '[&_[data-slot=input]]:border-slate-300',
  '[&_[data-slot=input]]:bg-white',
  '[&_[data-slot=input]]:shadow-[inset_0_1px_0_rgba(15,23,42,0.03)]',
  '[&_[data-slot=input]]:focus-visible:border-[#0176D3]',
  '[&_[data-slot=input]]:focus-visible:ring-[#0176D3]/25',
  '[&_[data-slot=select-trigger]]:border',
  '[&_[data-slot=select-trigger]]:border-slate-300',
  '[&_[data-slot=select-trigger]]:bg-white',
  '[&_[data-slot=select-trigger]]:shadow-[inset_0_1px_0_rgba(15,23,42,0.03)]',
  '[&_[data-slot=select-trigger]]:focus-visible:border-[#0176D3]',
  '[&_[data-slot=select-trigger]]:focus-visible:ring-[#0176D3]/25',
  '[&_[data-slot=textarea]]:border-slate-300',
  '[&_[data-slot=textarea]]:bg-white',
  '[&_[data-slot=textarea]]:shadow-[inset_0_1px_0_rgba(15,23,42,0.03)]',
  '[&_[data-slot=textarea]]:focus-visible:border-[#0176D3]',
  '[&_[data-slot=textarea]]:focus-visible:ring-[#0176D3]/25',
  '[&_[role=combobox]]:border-slate-300',
  '[&_[role=combobox]]:bg-white',
  '[&_[role=combobox]]:shadow-[inset_0_1px_0_rgba(15,23,42,0.03)]',
].join(' ');



/** 단계마다 "이 단계에서 준비할 것"을 같은 자리에서 한 번만 알려준다. */
const STEP_PREPARATION_NOTES: Record<ProjectEditorStep, string[]> = {
  basic: [
    '계약서와 고객사 사업자등록증을 옆에 두고 시작해 주세요.',
    '표기는 문서에 적힌 그대로 옮겨 적습니다. 줄여 쓰거나 띄어쓰기를 바꾸지 않습니다.',
  ],
  financial: [
    '계약서 · 고객사 사업자등록증 · 산출내역서(견적서) 파일을 먼저 준비해 주세요.',
    '계약금액과 선금 · 중도금 · 잔금 입금 시점을 계약서에서 확인해 두면 한 번에 끝납니다.',
  ],
  team: [
    '최종 보고자 (실무책임자)와 최종 결재자 (총괄책임자)를 구성원 원장에서 고를 수 있어야 합니다.',
    '참여인력은 참여율 시트에서 연동합니다. 시트 링크를 먼저 넣어 주세요.',
  ],
  review: [
    '저장 전 마지막 확인 단계입니다.',
    '남은 항목이 있으면 아래 목록에서 해당 단계로 바로 이동할 수 있습니다.',
  ],
};

function getProjectEditorAutosaveStorageKey(key: string) {
  return `mysc:project-editor-autosave:${key}`;
}

function readStoredProjectEditorDraft(key: string): StoredProjectEditorDraft | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(getProjectEditorAutosaveStorageKey(key)) || 'null') as StoredProjectEditorDraft | null;
    if (!parsed || parsed.schemaVersion !== PROJECT_EDITOR_AUTOSAVE_SCHEMA_VERSION || !parsed.draft) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredProjectEditorDraft(key: string, value: StoredProjectEditorDraft) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(getProjectEditorAutosaveStorageKey(key), JSON.stringify(value));
}

function removeStoredProjectEditorDraft(key: string) {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(getProjectEditorAutosaveStorageKey(key));
}

function normalizeRestoredProjectEditorDraft(draft: ProjectEditorDraft, mode: ProjectEditorMode) {
  return createProjectEditorWizardDraft({
    ...draft,
    ...(mode === 'portal-register' || mode === 'portal-edit'
      ? { registrationRequirementsVersion: 2 as const }
      : {}),
  });
}

function formatAutosaveTime(value: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtKRW(value: number) {
  return value ? value.toLocaleString('ko-KR') : '0';
}

const KOREAN_AMOUNT_UNITS: Array<[number, string]> = [
  [1000000000000, '조'],
  [100000000, '억'],
  [10000, '만'],
];

/**
 * 금액 옆 한글 단위 보조 표기(예: 270000000 → "2억 7,000만 원").
 * 읽기 전용 표시일 뿐이고 저장값은 원 단위 숫자 그대로다.
 */
function formatKoreanAmountUnit(value: number) {
  if (!Number.isFinite(value) || value === 0) return '';
  const negative = value < 0;
  let rest = Math.floor(Math.abs(value));
  const parts: string[] = [];
  KOREAN_AMOUNT_UNITS.forEach(([unit, label]) => {
    const quotient = Math.floor(rest / unit);
    if (quotient <= 0) return;
    parts.push(`${quotient.toLocaleString('ko-KR')}${label}`);
    rest -= quotient * unit;
  });
  if (rest > 0) parts.push(rest.toLocaleString('ko-KR'));
  if (parts.length === 0) return '';
  return `${negative ? '-' : ''}${parts.join(' ')} 원`;
}

function readText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumberSuggestion(value: ProjectRequestContractAnalysis['fields']['contractAmount'] | undefined) {
  return typeof value?.value === 'number' && Number.isFinite(value.value) ? value.value : null;
}

function mergeContractAnalysisIntoDraft(
  prev: ProjectEditorDraft,
  analysis: ProjectRequestContractAnalysis | null,
): ProjectEditorDraft {
  if (!analysis) return prev;
  const currentFlags = normalizeProjectFinancialInputFlags(prev.financialInputFlags);
  const suggestedContractAmount = readNumberSuggestion(analysis.fields.contractAmount);
  const suggestedSalesVatAmount = readNumberSuggestion(analysis.fields.salesVatAmount);
  const shouldApplyContractAmount = !currentFlags.contractAmount && suggestedContractAmount != null;
  const shouldApplySalesVatAmount = !currentFlags.salesVatAmount && suggestedSalesVatAmount != null;

  return createProjectEditorDraft({
    ...prev,
    officialContractName: prev.officialContractName || readText(analysis.fields.officialContractName?.value),
    clientOrg: prev.clientOrg || readText(analysis.fields.clientOrg?.value),
    contractStart: prev.contractStart || readText(analysis.fields.contractStart?.value),
    contractEnd: prev.contractEnd || readText(analysis.fields.contractEnd?.value),
    projectPurpose: prev.projectPurpose || readText(analysis.fields.projectPurpose?.value),
    description: prev.description || readText(analysis.fields.description?.value),
    contractAmount: shouldApplyContractAmount ? suggestedContractAmount : prev.contractAmount,
    salesVatAmount: shouldApplySalesVatAmount ? suggestedSalesVatAmount : prev.salesVatAmount,
    financialInputFlags: {
      ...currentFlags,
      contractAmount: currentFlags.contractAmount || suggestedContractAmount != null,
      salesVatAmount: currentFlags.salesVatAmount || suggestedSalesVatAmount != null,
    },
  });
}

function formatPaymentPlanAmount(amount: number, contractAmount: number) {
  if (!Number.isFinite(amount)) return '-';
  const amountLabel = formatStoredProjectAmount(amount, true);
  if (!Number.isFinite(contractAmount) || contractAmount <= 0) return amountLabel;
  return `${amountLabel} (${((amount / contractAmount) * 100).toFixed(0)}%)`;
}

function updateFlag(flags: ProjectFinancialInputFlags, key: keyof ProjectFinancialInputFlags, rawValue: string) {
  return {
    ...normalizeProjectFinancialInputFlags(flags),
    [key]: hasExplicitProjectAmountInput(rawValue),
  };
}

function formatTeamMemberIdentityInput(member: ProjectTeamMemberAssignment): string {
  const name = String(member.memberName || '').trim();
  const nickname = String(member.memberNickname || '').trim();
  if (!nickname) return name;
  return `${name}(${nickname})`;
}

function isAdminMode(mode: ProjectEditorMode) {
  return mode === 'admin';
}

function canEditProjectStatus(mode: ProjectEditorMode) {
  return mode === 'admin' || mode === 'portal-edit';
}

function createProjectEditorWizardDraft(overrides: Partial<ProjectEditorDraft> = {}): ProjectEditorDraft {
  const draft = createProjectEditorDraft(overrides);
  if (!Array.isArray(overrides.teamMembersDetailed)) {
    return draft;
  }
  return {
    ...draft,
    teamMembersDetailed: normalizeProjectTeamMemberDraftRows(overrides.teamMembersDetailed),
  };
}

/**
 * 필드 옆에 붙는 오류 문구. 판정은 submitIssues 그대로이고 여기서는 읽기 좋게만 만든다.
 * 항목 이름만 적힌 문구('PM', '계약금액')는 빨간 글씨로 이름만 되풀이하는 꼴이라,
 * 마지막 단계 안내와 똑같은 뒷말을 붙인다. 이미 문장인 문구는 그대로 둔다.
 */

/**
 * 계산된 값은 입력칸이 아니다. 테두리와 배경을 걷어내고 얇은 세로선과 `계산됨` 마이크로
 * 라벨만 남긴다. 색이 아니라 형태로 구분하는 것이라 회색조를 유지한다.
 */
function ProjectComputedValue({ value, numeric = true }: { value: string; numeric?: boolean }) {
  return (
    <div className="flex h-9 items-center gap-2 border-l-2 border-slate-300 pl-2.5">
      <span className={cn(numeric ? FORM_NUMERIC_VALUE_CLASS : FORM_VALUE_CLASS, 'font-medium text-slate-900')}>
        {value}
      </span>
      <span className="text-[11px] font-normal leading-5 text-slate-400">계산됨</span>
    </div>
  );
}

export function ProjectEditorWizard({
  mode,
  initialDraft,
  draftKey,
  title,
  description,
  embeddedInShell = false,
  members = [],
  roster = [],
  departmentOptions,
  settlementSystemOptions = [],
  topSlot,
  showCheckoutEntry = false,
  actions,
  busyActionId,
  readOnly = false,
  trustedParticipationSheetDraft,
  onContractFileUpload,
  onProjectDocumentFileUpload,
  documentPreviewUrls,
  documentPreviewStates,
  onLoadDocumentPreview,
  onRemoveProjectDocument,
  contractAnalysisMergeMode = 'fill-empty',
  canRemoveContractDocument,
  canRemoveProjectDocuments = true,
  autosave,
  onCancel,
  onLeave,
  onSubmit,
}: ProjectEditorWizardProps) {
  const { user } = useAuth();
  const { orgId } = useFirebase();
  const [teamSyncing, setTeamSyncing] = useState(false);
  const [teamSyncNotice, setTeamSyncNotice] = useState('');
  const [teamSyncError, setTeamSyncError] = useState('');
  const [teamSyncWarning, setTeamSyncWarning] = useState('');
  // 표는 시트를 그대로 옮긴 것이다. 저장된 명단이 아니라 방금 읽은 시트를 보여 준다.
  const [teamSyncPreview, setTeamSyncPreview] = useState<ParticipationSheetPreview | null>(null);
  const [teamSyncSignature, setTeamSyncSignature] = useState<string | null>(null);
  const [teamSyncYear, setTeamSyncYear] = useState('');
  // 시트를 공유해야 할 상대. 오류가 난 뒤에 알려주면 늦다 - 링크를 넣는 그 자리에 있어야 한다.
  const [sheetSystemAccount, setSheetSystemAccount] = useState('');
  const [stepIndex, setStepIndex] = useState(0);
  const [draft, setDraft] = useState<ProjectEditorDraft>(() => createProjectEditorWizardDraft(initialDraft));
  const [documentUploadState, setDocumentUploadState] = useState<Record<ProjectRequestDocumentKind, ContractUploadState>>({
    contract: 'idle',
    customer_business_registration: 'idle',
    quote: 'idle',
    proposal: 'idle',
    proposal_word_original: 'idle',
    proposal_ppt_original: 'idle',
    presentation_ppt_original: 'idle',
    rfp_request_evidence: 'idle',
    performance_certificate: 'idle',
    tax_invoice: 'idle',
    final_settlement_report: 'idle',
    final_report: 'idle',
  });
  const [documentUploadError, setDocumentUploadError] = useState<Record<ProjectRequestDocumentKind, string>>({
    contract: '',
    customer_business_registration: '',
    quote: '',
    proposal: '',
    proposal_word_original: '',
    proposal_ppt_original: '',
    presentation_ppt_original: '',
    rfp_request_evidence: '',
    performance_certificate: '',
    tax_invoice: '',
    final_settlement_report: '',
    final_report: '',
  });
  const [restoreCandidate, setRestoreCandidate] = useState<StoredProjectEditorDraft | null>(null);
  const [autosaveState, setAutosaveState] = useState<AutosaveState>('idle');
  const [exitDialogOpen, setExitDialogOpen] = useState(false);
  const [exitIntent, setExitIntent] = useState<'cancel' | 'route' | null>(null);
  const [submitBlockedNotice, setSubmitBlockedNotice] = useState(false);
  const [exitBusy, setExitBusy] = useState(false);
  const [lastAutosavedAt, setLastAutosavedAt] = useState('');
  const [preloadWarningVisible, setPreloadWarningVisible] = useState(false);
  const contractUploadInputRef = useRef<HTMLInputElement | null>(null);
  const quoteUploadInputRef = useRef<HTMLInputElement | null>(null);
  const proposalUploadInputRef = useRef<HTMLInputElement | null>(null);
  const proposalWordOriginalUploadInputRef = useRef<HTMLInputElement | null>(null);
  const proposalPptOriginalUploadInputRef = useRef<HTMLInputElement | null>(null);
  const presentationPptOriginalUploadInputRef = useRef<HTMLInputElement | null>(null);
  const rfpRequestEvidenceUploadInputRef = useRef<HTMLInputElement | null>(null);
  const customerBusinessRegistrationUploadInputRef = useRef<HTMLInputElement | null>(null);
  const performanceCertificateUploadInputRef = useRef<HTMLInputElement | null>(null);
  const taxInvoiceUploadInputRef = useRef<HTMLInputElement | null>(null);
  const finalSettlementReportUploadInputRef = useRef<HTMLInputElement | null>(null);
  const finalReportUploadInputRef = useRef<HTMLInputElement | null>(null);
  const retryDocumentFileRef = useRef<Partial<Record<ProjectRequestDocumentKind, File>>>({});
  /**
   * Bumped when an upload is cancelled. The request itself cannot be recalled, so a run
   * whose token no longer matches stops applying its result and undoes the attachment if
   * it had already reached the server.
   */
  const documentUploadRunRef = useRef<Partial<Record<ProjectRequestDocumentKind, number>>>({});
  const submitInFlightRef = useRef(false);
  const exitInFlightRef = useRef(false);
  const leaveApprovedRef = useRef(false);
  const draftRef = useRef(draft);
  const autosaveErrorRef = useRef<string>('');
  const lastPersistedFingerprintRef = useRef(JSON.stringify(createProjectEditorDraft(initialDraft)));
  const lastResetKeyRef = useRef<string | null>(null);
  const initialDraftFingerprint = useMemo(() => JSON.stringify(createProjectEditorDraft(initialDraft)), [initialDraft]);
  const initialContractDocument = initialDraft.contractDocument ?? null;
  const initialContractAnalysis = initialDraft.contractAnalysis ?? null;
  const normalizedDepartmentOptions = useMemo(
    () => dedupeProjectDepartmentLabels(departmentOptions ? departmentOptions : [...PROJECT_DEPARTMENT_OPTIONS]),
    [departmentOptions],
  );
  const departmentOptionSet = useMemo(() => new Set(normalizedDepartmentOptions), [normalizedDepartmentOptions]);
  const selectedDepartment = normalizeProjectDepartment(draft.department);
  const canUseSelectedDepartment = selectedDepartment && departmentOptionSet.has(selectedDepartment);
  const canRemoveExistingContractDocument = canRemoveContractDocument ?? isAdminMode(mode);
  const contractDocumentEditPolicy = buildContractDocumentEditPolicy({
    current: draft.contractDocument,
    initial: initialContractDocument,
    canRemoveExistingContractDocument,
  });
  const currentDraftFingerprint = JSON.stringify(createProjectEditorDraft(draft));
  const uploadInProgress = Object.values(documentUploadState).some((state) => state === 'extracting');
  const registrationDocumentKinds = onProjectDocumentFileUpload
    ? REGISTRATION_DOCUMENT_KINDS
    : REGISTRATION_DOCUMENT_KINDS.filter((kind) => kind === 'contract');
  const hasRequiredRegistrationDocuments = Boolean(
    draft.contractDocument
    && draft.customerBusinessRegistrationDocument
    && (draft.quoteDocument || draft.quoteSubmissionDeferred),
  );
  const checkoutDocumentKinds = onProjectDocumentFileUpload ? CHECKOUT_DOCUMENT_KINDS : [];
  const documentUploadMaxBytes = mode === 'admin'
    ? PROJECT_REQUEST_DOCUMENT_UPLOAD_MAX_SIZE_BYTES
    : PROJECT_PRIVATE_DRAFT_DOCUMENT_UPLOAD_MAX_SIZE_BYTES;
  const documentUploadMaxLabel = mode === 'admin'
    ? PROJECT_REQUEST_DOCUMENT_UPLOAD_MAX_SIZE_LABEL
    : PROJECT_PRIVATE_DRAFT_DOCUMENT_UPLOAD_MAX_SIZE_LABEL;
  const hasPendingRetryFile = [...registrationDocumentKinds, ...checkoutDocumentKinds]
    .some((kind) => Boolean(retryDocumentFileRef.current[kind]));
  const hasUnsavedInput = currentDraftFingerprint !== lastPersistedFingerprintRef.current;
  const shouldBlockNavigation = hasUnsavedInput || uploadInProgress || hasPendingRetryFile;
  const shouldConfirmExit = shouldBlockNavigation || (Boolean(onLeave) && !readOnly);
  const blocker = useBlocker(shouldConfirmExit);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    const resetKey = `${draftKey}::${autosave?.key || ''}`;
    const isNewEditorSession = lastResetKeyRef.current !== resetKey;
    const currentFingerprint = JSON.stringify(createProjectEditorDraft(draftRef.current));
    if (!shouldResetProjectEditorDraft({
      lastResetKey: lastResetKeyRef.current,
      resetKey,
      currentFingerprint,
      lastPersistedFingerprint: lastPersistedFingerprintRef.current,
      incomingFingerprint: initialDraftFingerprint,
    })) return;
    lastResetKeyRef.current = resetKey;
    const nextDraft = createProjectEditorWizardDraft(initialDraft);
    lastPersistedFingerprintRef.current = JSON.stringify(createProjectEditorDraft(nextDraft));
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    if (isNewEditorSession) setStepIndex(0);
    setTeamSyncPreview(null);
    setTeamSyncSignature(null);
    setTeamSyncYear('');
    setTeamSyncNotice('');
    setTeamSyncError('');
    setDocumentUploadState({
      contract: 'idle',
      customer_business_registration: 'idle',
      quote: 'idle',
      proposal: 'idle',
      proposal_word_original: 'idle',
      proposal_ppt_original: 'idle',
      presentation_ppt_original: 'idle',
      rfp_request_evidence: 'idle',
      performance_certificate: 'idle',
      tax_invoice: 'idle',
      final_settlement_report: 'idle',
      final_report: 'idle',
    });
    setDocumentUploadError({
      contract: '',
      customer_business_registration: '',
      quote: '',
      proposal: '',
      proposal_word_original: '',
      proposal_ppt_original: '',
      presentation_ppt_original: '',
      rfp_request_evidence: '',
      performance_certificate: '',
      tax_invoice: '',
      final_settlement_report: '',
      final_report: '',
    });
    setAutosaveState('idle');
    setLastAutosavedAt('');
    setPreloadWarningVisible(false);
    setRestoreCandidate(autosave?.key ? readStoredProjectEditorDraft(autosave.key) : null);
  }, [autosave?.key, draftKey, initialDraft, initialDraftFingerprint]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handlePreloadError = () => setPreloadWarningVisible(true);
    window.addEventListener('mysc:preloadError', handlePreloadError);
    return () => window.removeEventListener('mysc:preloadError', handlePreloadError);
  }, []);

  const persistAutosaveSnapshot = useCallback(async (
    nextDraft: ProjectEditorDraft,
    nextStepIndex: number,
  ) => {
    // 재시도 대기 여부는 렌더 시점 값이 아니라 ref 를 즉석에서 본다 - 나가기 직전에
    // 대기 파일을 버린 경우에도 임시저장이 진행돼야 한다.
    const pendingRetryNow = [...registrationDocumentKinds, ...checkoutDocumentKinds]
      .some((kind) => Boolean(retryDocumentFileRef.current[kind]));
    if (uploadInProgress || pendingRetryNow) return false;
    if (readOnly || !autosave?.key || autosave.disabled) return false;
    if (mode === 'portal-register' && !hasRequiredRegistrationDocuments) return false;
    const now = new Date().toISOString();
    const storedDraft: StoredProjectEditorDraft = {
      schemaVersion: PROJECT_EDITOR_AUTOSAVE_SCHEMA_VERSION,
      draftKey,
      draft: createProjectEditorDraft(nextDraft),
      stepIndex: nextStepIndex,
      updatedAt: now,
    };
    setAutosaveState('saving');
    try {
      writeStoredProjectEditorDraft(autosave.key, storedDraft);
      await autosave.onSave?.(storedDraft.draft, nextStepIndex);
      lastPersistedFingerprintRef.current = JSON.stringify(storedDraft.draft);
      autosaveErrorRef.current = '';
      setLastAutosavedAt(now);
      setAutosaveState('saved');
      return true;
    } catch (error) {
      console.error('[ProjectEditorWizard] autosave failed:', error);
      // 서버가 적어 준 원인을 실패 토스트가 보여줄 수 있게 남겨 둔다 - "잠시 후 다시"만으로는
      // 리스 만료·검증 거부·네트워크를 구분할 수 없어 사람이 같은 실패를 반복한다.
      autosaveErrorRef.current = error instanceof Error ? (
        (error as { serverMessage?: string }).serverMessage || error.message
      ) : String(error);
      setLastAutosavedAt(now);
      setAutosaveState('error');
      return false;
    }
  }, [autosave?.disabled, autosave?.key, autosave?.onSave, draftKey, hasPendingRetryFile, hasRequiredRegistrationDocuments, mode, readOnly, uploadInProgress]);

  const saveDraftAndRelease = useCallback(async () => {
    if (uploadInProgress) {
      toast.error('첨부파일을 업로드하는 중입니다. 잠시 기다리거나 해당 파일의 업로드 취소를 누른 뒤 나가 주세요.');
      return false;
    }
    // 업로드가 실패해 재시도 대기 중인 파일은 사람을 폼에 가두는 이유가 못 된다.
    // 버리고 나간다 - 파일은 사용자 컴퓨터에 그대로 있으니 다시 첨부하면 된다.
    if (hasPendingRetryFile) {
      retryDocumentFileRef.current = {};
      toast.info('업로드에 실패했던 첨부파일은 저장되지 않았습니다. 다음에 다시 첨부해 주세요.');
    }
    if (hasUnsavedInput && autosave?.key && !autosave.disabled && !readOnly) {
      if (!await persistAutosaveSnapshot(draft, stepIndex)) {
        toast.error(`임시저장에 실패해 수정 세션을 종료하지 않았습니다.${autosaveErrorRef.current ? ` (${autosaveErrorRef.current})` : ''}`);
        return false;
      }
    }
    try {
      await onLeave?.();
      return true;
    } catch (error) {
      console.error('[ProjectEditorWizard] edit session release failed:', error);
      toast.error('수정 세션을 종료하지 못했습니다. 현재 화면에서 다시 시도해 주세요.');
      return false;
    }
  }, [autosave?.disabled, autosave?.key, draft, hasPendingRetryFile, hasUnsavedInput, onLeave, persistAutosaveSnapshot, readOnly, stepIndex, uploadInProgress]);

  const releaseWithoutSaving = useCallback(async () => {
    if (uploadInProgress || hasPendingRetryFile) {
      toast.error('첨부파일 업로드를 완료한 뒤 나갈 수 있습니다.');
      return false;
    }
    try {
      await onLeave?.();
      if (autosave?.key) removeStoredProjectEditorDraft(autosave.key);
      return true;
    } catch (error) {
      console.error('[ProjectEditorWizard] edit session release failed:', error);
      toast.error('수정 세션을 종료하지 못했습니다. 현재 화면에서 다시 시도해 주세요.');
      return false;
    }
  }, [autosave?.key, hasPendingRetryFile, onLeave, uploadInProgress]);

  const finishExit = useCallback(async (saveBeforeExit: boolean) => {
    if (exitInFlightRef.current) return;
    exitInFlightRef.current = true;
    setExitBusy(true);
    try {
      const canLeave = saveBeforeExit
        ? await saveDraftAndRelease()
        : await releaseWithoutSaving();
      if (!canLeave) return;
      leaveApprovedRef.current = true;
      setExitDialogOpen(false);
      if (exitIntent === 'route' && blocker.state === 'blocked') blocker.proceed();
      else await onCancel?.();
      setExitIntent(null);
    } finally {
      exitInFlightRef.current = false;
      setExitBusy(false);
    }
  }, [blocker, exitIntent, onCancel, releaseWithoutSaving, saveDraftAndRelease]);

  const requestCancel = () => {
    if (exitInFlightRef.current) return;
    if (!shouldConfirmExit) {
      void onCancel?.();
      return;
    }
    setExitIntent('cancel');
    setExitDialogOpen(true);
  };

  useEffect(() => {
    if (!shouldConfirmExit || typeof window === 'undefined') return undefined;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [shouldConfirmExit]);

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (leaveApprovedRef.current) {
      leaveApprovedRef.current = false;
      blocker.proceed();
      return;
    }
    setExitIntent('route');
    setExitDialogOpen(true);
  }, [blocker]);

  useEffect(() => {
    if (readOnly || !autosave?.key || autosave.disabled || restoreCandidate || uploadInProgress || hasPendingRetryFile) return undefined;
    const isInitialDraft = stepIndex === 0 && JSON.stringify(createProjectEditorDraft(draft)) === initialDraftFingerprint;
    if (isInitialDraft) return undefined;

    const timer = window.setTimeout(() => {
      void persistAutosaveSnapshot(draft, stepIndex);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [autosave?.disabled, autosave?.key, draft, hasPendingRetryFile, initialDraftFingerprint, persistAutosaveSnapshot, readOnly, restoreCandidate, stepIndex, uploadInProgress]);

  const restoreLocalDraft = () => {
    if (!restoreCandidate) return;
    setDraft(normalizeRestoredProjectEditorDraft(restoreCandidate.draft, mode));
    setStepIndex(Math.max(0, Math.min(STEPS.length - 1, restoreCandidate.stepIndex || 0)));
    setLastAutosavedAt(restoreCandidate.updatedAt);
    setAutosaveState('saved');
    setRestoreCandidate(null);
  };

  const discardLocalDraft = () => {
    if (autosave?.key) removeStoredProjectEditorDraft(autosave.key);
    setRestoreCandidate(null);
    void autosave?.onDiscard?.();
  };

  const handleManualAutosave = async () => {
    if (uploadInProgress || hasPendingRetryFile) {
      toast.error('첨부파일 처리를 완료한 뒤 임시저장해 주세요.');
      return;
    }
    const saved = await persistAutosaveSnapshot(draft, stepIndex);
    if (saved) toast.success('임시저장되었습니다.');
    else toast.error(`임시저장에 실패했습니다.${autosaveErrorRef.current ? ` (${autosaveErrorRef.current})` : ' 잠시 후 다시 시도해 주세요.'}`);
  };

  const handleActionSubmit = async (actionId: string) => {
    if (submitInFlightRef.current) return;
    if (uploadInProgress || hasPendingRetryFile) {
      toast.error('첨부파일 처리를 완료한 뒤 최종 저장해 주세요.');
      return;
    }
    submitInFlightRef.current = true;
    try {
      if (autosave?.key && !await persistAutosaveSnapshot(draft, stepIndex)) {
        throw new Error('최신 입력을 임시저장하지 못해 최종 저장을 중단했습니다.');
      }
      await onSubmit(createProjectEditorDraft(draft), actionId);
      lastPersistedFingerprintRef.current = JSON.stringify(createProjectEditorDraft(draft));
      if (autosave?.key) removeStoredProjectEditorDraft(autosave.key);
      setAutosaveState('idle');
      setLastAutosavedAt('');
    } catch (error) {
      console.error('[ProjectEditorWizard] submit failed:', error);
      toast.error(error instanceof Error ? error.message : '저장에 실패했습니다.');
    } finally {
      submitInFlightRef.current = false;
    }
  };

  const step = STEPS[stepIndex];
  const financialInputFlags = useMemo(
    () => normalizeProjectFinancialInputFlags(draft.financialInputFlags),
    [draft.financialInputFlags],
  );
  const hasContractAmountInput = financialInputFlags.contractAmount;
  const hasSalesVatAmountInput = financialInputFlags.salesVatAmount;
  const hasTotalRevenueAmountInput = financialInputFlags.totalRevenueAmount;
  const hasTotalActualCostInput = financialInputFlags.totalActualCost;
  const hasSupportAmountInput = financialInputFlags.supportAmount;
  const usesRegistrationV2 = draft.registrationRequirementsVersion === 2;
  const hasMultiYearContract = Boolean(
    /^\d{4}-\d{2}-\d{2}$/.test(draft.contractStart)
    && (draft.contractEndUndecided
      ? Number(draft.contractStart.slice(0, 4)) < new Date().getFullYear()
      : /^\d{4}-\d{2}-\d{2}$/.test(draft.contractEnd)
        && draft.contractStart.slice(0, 4) !== draft.contractEnd.slice(0, 4)),
  );
  const settlementDetailsEnabled = usesRegistrationV2 ? draft.basis !== 'NONE' : draft.settlementType !== 'NONE';
  const requiresSettlementConfirmations = usesRegistrationV2 ? draft.basis !== 'NONE' : draft.settlementType !== 'NONE';
  const showProjectCheckout = draft.status === 'COMPLETED' || draft.status === 'COMPLETED_PENDING_PAYMENT';
  const effectivePaymentPlan = hasMultiYearContract
    ? draft.financialYears.reduce((total, row) => ({
      contract: total.contract + (row.paymentPlan?.contract || 0),
      interim: total.interim + (row.paymentPlan?.interim || 0),
      final: total.final + (row.paymentPlan?.final || 0),
    }), { contract: 0, interim: 0, final: 0 })
    : draft.paymentPlan;
  const paymentPlanTotal = effectivePaymentPlan.contract + effectivePaymentPlan.interim + effectivePaymentPlan.final;
  const advanceInterimRatio = draft.contractAmount > 0
    ? (effectivePaymentPlan.contract + effectivePaymentPlan.interim) / draft.contractAmount
    : null;
  const requiresAdvanceInterimReason = paymentPlanTotal > 0
    && advanceInterimRatio !== null
    && advanceInterimRatio < 0.7;
  const profitRateLabel = formatProfitRatePercentInput(draft.profitRate);
  const teamMembersSummary = formatProjectTeamMembersSummary(draft.teamMembersDetailed, '', '\n');
  const projectTypeOptions = getProjectTypeSelectableOptions(draft.type);
  const contractTypeOptions = getProjectContractTypeSelectableOptions(draft.contractType);
  // The ledger list decides whether a stored value is still linked, so the "not in the
  // member ledger" warning keeps working. The picker lists carry the stored value on top
  // of it so opening an old project never silently drops its owner or approver.
  // PM·최종 결재자는 로그인해서 승인해야 하므로 계정이 필수다. 명부는 문지기로만 쓴다 -
  // 명부에 없는 사람(퇴사 후 계정이 남은 경우, 서비스 계정)은 후보에서 빠진다.
  const ledgerMemberOptions = useMemo(
    () => buildOrgMemberPickerOptions(members, roster),
    [members, roster],
  );
  const ownerOptions = useMemo(
    () => withSavedOrgMemberOption(ledgerMemberOptions, {
      uid: draft.registeredById,
      name: draft.registeredByName,
      email: draft.registeredByEmail,
    }),
    [draft.registeredByEmail, draft.registeredById, draft.registeredByName, ledgerMemberOptions],
  );
  const executiveApproverOptions = useMemo(
    () => withSavedOrgMemberOption(ledgerMemberOptions, {
      uid: draft.executiveApproverId,
      name: draft.executiveApproverName,
      email: draft.executiveApproverEmail,
    }),
    [draft.executiveApproverEmail, draft.executiveApproverId, draft.executiveApproverName, ledgerMemberOptions],
  );
  const selectedOwner = useMemo(
    () => ledgerMemberOptions.find((member) => member.uid === draft.registeredById) || null,
    [draft.registeredById, ledgerMemberOptions],
  );
  const linkedExecutiveApprover = useMemo(
    () => ledgerMemberOptions.find((member) => member.uid === draft.executiveApproverId) || null,
    [draft.executiveApproverId, ledgerMemberOptions],
  );
  const selectedExecutiveApprover = useMemo(
    () => executiveApproverOptions.find((member) => member.uid === draft.executiveApproverId) || null,
    [draft.executiveApproverId, executiveApproverOptions],
  );
  const hasUnlinkedStoredOwner = Boolean(draft.registeredById && !selectedOwner);
  const hasUnlinkedStoredExecutiveApprover = Boolean(
    draft.executiveApproverId && !linkedExecutiveApprover,
  );

  useEffect(() => {
    if (!draft.registeredById) return;
    const member = members.find((item) => item.uid === draft.registeredById);
    if (!member) return;
    if (
      draft.registeredByName === member.name
      && draft.registeredByEmail === (member.email || '')
      && draft.managerId === member.uid
      && draft.managerName === member.name
    ) return;
    setDraft((prev) => createProjectEditorDraft({
      ...prev,
      registeredById: member.uid,
      registeredByName: member.name,
      registeredByEmail: member.email || '',
      managerId: member.uid,
      managerName: member.name,
    }));
  }, [draft.managerId, draft.managerName, draft.registeredByEmail, draft.registeredById, draft.registeredByName, members]);

  useEffect(() => {
    if (!draft.executiveApproverId) return;
    const member = members.find((item) => item.uid === draft.executiveApproverId);
    if (!member) return;
    const name = member.name || member.email || member.uid;
    const email = member.email || '';
    if (draft.executiveApproverName === name && draft.executiveApproverEmail === email) return;
    setDraft((prev) => createProjectEditorDraft({
      ...prev,
      executiveApproverId: member.uid,
      executiveApproverName: name,
      executiveApproverEmail: email,
    }));
  }, [draft.executiveApproverEmail, draft.executiveApproverId, draft.executiveApproverName, members]);

  const update = <K extends keyof ProjectEditorDraft>(key: K, value: ProjectEditorDraft[K]) => {
    setDraft((prev) => createProjectEditorWizardDraft({ ...prev, [key]: value }));
  };

  const updateSettlementSystem = (value: string) => {
    setDraft((prev) => createProjectEditorWizardDraft({
      ...prev,
      settlementSystem: (value.startsWith('OTHER:') ? 'OTHER' : value) as SettlementSystemCode,
      settlementSystemOther: value.startsWith('OTHER:') ? value.slice('OTHER:'.length) : '',
    }));
  };

  const updateAmount = (key: 'contractAmount' | 'salesVatAmount' | 'totalRevenueAmount' | 'totalActualCost' | 'supportAmount', rawValue: string) => {
    setDraft((prev) => createProjectEditorWizardDraft({
      ...prev,
      [key]: parseProjectAmountInput(rawValue),
      financialInputFlags: updateFlag(prev.financialInputFlags, key, rawValue),
    }));
  };

  /**
   * 계약 기간을 고치면 진행 상태가 따라온다. 사람이 고르는 값이 아니라 날짜에서 나오는 값이다.
   * 불러오기만으로 저장된 상태를 바꾸지는 않는다 - 사람이 기간을 손댈 때만 다시 계산한다.
   */
  const updateContractEndUndecided = (undecided: boolean) => {
    setDraft((prev) => {
      const next = { ...prev, contractEndUndecided: undecided, contractEnd: undecided ? '' : prev.contractEnd };
      return createProjectEditorWizardDraft({
        ...next,
        status: deriveProjectStatusFromContractPeriod({
          contractStart: next.contractStart,
          contractEnd: next.contractEnd,
          contractEndUndecided: next.contractEndUndecided,
          currentStatus: next.status,
          today: new Date().toISOString().slice(0, 10),
        }),
      });
    });
  };

  const updateContractPeriod = (key: 'contractStart' | 'contractEnd', value: string) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      return createProjectEditorWizardDraft({
        ...next,
        status: deriveProjectStatusFromContractPeriod({
          contractStart: next.contractStart,
          contractEnd: next.contractEnd,
          contractEndUndecided: next.contractEndUndecided,
          currentStatus: next.status,
          today: new Date().toISOString().slice(0, 10),
        }),
      });
    });
  };

  const updateFinancialYear = (
    index: number,
    key: 'contractAmount' | 'salesVatAmount' | 'totalRevenueAmount' | 'totalActualCost' | 'supportAmount' | 'paymentPlan' | 'paymentExpectedMonths' | 'advanceInterimBelow70Reason' | 'isSettled' | 'confirmed',
    value: number | string | boolean | ProjectFinancialYear['paymentPlan'] | ProjectFinancialYear['paymentExpectedMonths'],
  ) => {
    setDraft((prev) => {
      const financialYears = prev.financialYears.map((row, rowIndex) => {
        if (rowIndex !== index) return row;
        const next = { ...row, [key]: value };
        /*
         * 단년도는 계약금액을 항목 합계로 둔다. 연도가 하나뿐이라 "총 계약금액"과
         * "그 해의 계약금액"이 같은 값이고, 사람이 둘을 따로 넣을 이유가 없다.
         * 다년도는 연도마다 계약금액이 따로 있으므로 그대로 입력받는다.
         */
        if (!hasMultiYearContract && CONTRACT_AMOUNT_ITEM_FIELDS.includes(key as ContractAmountItemField)) {
          next.contractAmount = deriveContractAmountFromItems(next);
        }
        return next;
      });
      const total = (field: 'contractAmount' | 'salesVatAmount' | 'totalRevenueAmount' | 'totalActualCost' | 'supportAmount') => (
        financialYears.reduce((sum, row) => sum + row[field], 0)
      );
      return createProjectEditorWizardDraft({
        ...prev,
        financialYears,
        contractAmount: total('contractAmount'),
        salesVatAmount: total('salesVatAmount'),
        totalRevenueAmount: total('totalRevenueAmount'),
        totalActualCost: total('totalActualCost'),
        supportAmount: total('supportAmount'),
        financialInputFlags: {
          contractAmount: true,
          salesVatAmount: true,
          totalRevenueAmount: true,
          totalActualCost: true,
          supportAmount: true,
        },
      });
    });
  };

  /*
   * 참여율 시트에서 참여인력을 읽어 명단을 채운다.
   *
   * 사람이 두 곳에 같은 내용을 적지 않게 하는 것이 목적이다. 월별 참여율의 원천은 시트이고,
   * 여기에는 승인 서류·인력 현황·사업 검색이 쓰는 명단(이름·역할·투입기간·기본투입률)만 남긴다.
   * 저장 전에도 눌러야 하므로 화면의 링크와 계약 기간을 그대로 보낸다.
   */
  useEffect(() => {
    if (!orgId || !user) return;
    let cancelled = false;
    void fetchParticipationSystemAccountViaBff({ tenantId: orgId, actor: user })
      .then((result) => { if (!cancelled) setSheetSystemAccount(result.systemAccountEmail || ''); })
      .catch(() => { /* 안내 문구일 뿐이라 실패해도 화면을 막지 않는다. */ });
    return () => { cancelled = true; };
  }, [orgId, user]);

  /*
   * 저장된 링크가 있으면 열 때 시트를 다시 읽어 화면을 복원한다. 새로고침할 때마다
   * "다시 연동해 주세요" 가 뜨면 이미 연동한 사실 자체를 못 믿게 된다. 시트가 저장본과
   * 같으면 조용히 연동 상태로 인정하고, 달라졌으면 명단은 덮지 않은 채 갱신을 안내한다.
   */
  const sheetRestoreAttemptedRef = useRef(false);
  useEffect(() => {
    if (sheetRestoreAttemptedRef.current) return;
    const sheetLink = String(draft.participationSheetLink || '').trim();
    if (!sheetLink || !draft.contractStart || (!draft.contractEnd && !draft.contractEndUndecided) || !orgId || !user) return;
    if (teamSyncPreview || teamSyncing) return;
    sheetRestoreAttemptedRef.current = true;
    const { contractStart, contractEnd, teamMembersDetailed } = draft;
    setTeamSyncing(true);
    void previewParticipationSheetByLinkViaBff({
      tenantId: orgId, actor: user, sheetLink, contractStart, contractEnd,
      contractEndUndecided: draft.contractEndUndecided,
    })
      .then((preview) => {
        if (!preview.ok) return;
        const mapped = mapParticipationSheetPreviewToProjectTeamMembers(preview);
        const sheetSignature = participationSheetSyncSignature({
          sheetLink, contractStart, contractEnd, teamMembersDetailed: mapped,
        });
        const persistedSignature = participationSheetSyncSignature({
          sheetLink, contractStart, contractEnd, teamMembersDetailed,
        });
        setTeamSyncPreview(preview);
        setTeamSyncYear(preview.months[0]?.slice(0, 4) || '');
        setTeamSyncWarning((preview.warnings || []).map((warning) => warning.message).slice(0, 2).join(' / '));
        if (sheetSignature === persistedSignature) {
          setTeamSyncSignature(sheetSignature);
          setTeamSyncNotice(`저장된 참여율 시트 연동을 확인했습니다. 참여인력 ${preview.rows.length}명.`);
        } else {
          setTeamSyncNotice('시트 내용이 저장된 명단과 달라졌습니다. [연동하기]를 눌러 갱신해 주세요.');
        }
      })
      .catch(() => { /* 자동 복원 실패는 화면을 막지 않는다. 연동하기 버튼이 그대로 있다. */ })
      .finally(() => setTeamSyncing(false));
  }, [draft, orgId, user, teamSyncPreview, teamSyncing]);

  const syncTeamFromSheet = () => {
    if (teamSyncing) return;
    const sheetLink = String(draft.participationSheetLink || '').trim();
    setTeamSyncNotice('');
    if (!sheetLink) {
      setTeamSyncError('참여율 시트 링크를 먼저 입력해 주세요.');
      return;
    }
    if (!draft.contractStart || (!draft.contractEnd && !draft.contractEndUndecided)) {
      setTeamSyncError('계약 시작일과 종료일을 먼저 입력해 주세요. 시트의 기간과 대조합니다.');
      return;
    }
    if (!orgId || !user) {
      setTeamSyncError('로그인 정보를 확인하지 못했습니다.');
      return;
    }
    setTeamSyncing(true);
    setTeamSyncSignature(null);
    setTeamSyncError('');
    setTeamSyncWarning('');
    void previewParticipationSheetByLinkViaBff({
      tenantId: orgId,
      actor: user,
      sheetLink,
      contractStart: draft.contractStart,
      contractEnd: draft.contractEnd,
      contractEndUndecided: draft.contractEndUndecided,
    })
      .then((preview) => {
        if (!preview.ok) {
          // 막는 이유를 서버가 적어 준 대로 보여 준다. 화면이 다시 판정하지 않는다.
          setTeamSyncPreview(null);
          setTeamSyncError(preview.blocking.map((issue) => issue.message).slice(0, 3).join(' / ')
            || '시트를 반영할 수 없는 상태입니다.');
          return;
        }
        const mappedTeamMembers = mapParticipationSheetPreviewToProjectTeamMembers(preview);
        update('teamMembersDetailed', mappedTeamMembers);
        setTeamSyncPreview(preview);
        // 막지는 않지만 알아야 하는 것들(기간 불일치 등). 서버가 적어 준 문구 그대로.
        setTeamSyncWarning((preview.warnings || []).map((warning) => warning.message).slice(0, 2).join(' / '));
        setTeamSyncSignature(participationSheetSyncSignature({
          sheetLink,
          contractStart: draft.contractStart,
          contractEnd: draft.contractEnd,
          teamMembersDetailed: mappedTeamMembers,
        }));
        // 저장은 전체 계약기간을 유지하고, 확인 화면만 선택 연도 12개월로 자른다.
        setTeamSyncYear(preview.months[0]?.slice(0, 4) || '');
        const pending = preview.summary?.pendingLinkCount || 0;
        setTeamSyncNotice(pending > 0
          ? `참여인력 ${preview.rows.length}명을 가져왔습니다. 그중 ${pending}명은 People 등록 전이라 연결 대기입니다.`
          : `참여인력 ${preview.rows.length}명을 가져왔습니다.`);
      })
      .catch((error) => {
        setTeamSyncPreview(null);
        const status = error instanceof PlatformApiError ? error.status : 500;
        const code = error instanceof PlatformApiError ? error.code : '';
        // serverMessage 가 서버가 적어 준 안내다. message 는 상태코드별 일반 문구라 원인을 가린다.
        const serverMessage = error instanceof PlatformApiError ? String(error.serverMessage || '').trim() : '';
        setTeamSyncError(serverMessage || resolveApiErrorPresentation(code, status).guide);
      })
      .finally(() => setTeamSyncing(false));
  };



  const getDocumentInputRef = (kind: ProjectRequestDocumentKind) => ({
    contract: contractUploadInputRef,
    customer_business_registration: customerBusinessRegistrationUploadInputRef,
    quote: quoteUploadInputRef,
    proposal: proposalUploadInputRef,
    proposal_word_original: proposalWordOriginalUploadInputRef,
    proposal_ppt_original: proposalPptOriginalUploadInputRef,
    presentation_ppt_original: presentationPptOriginalUploadInputRef,
    rfp_request_evidence: rfpRequestEvidenceUploadInputRef,
    performance_certificate: performanceCertificateUploadInputRef,
    tax_invoice: taxInvoiceUploadInputRef,
    final_settlement_report: finalSettlementReportUploadInputRef,
    final_report: finalReportUploadInputRef,
  }[kind]);

  const uploadProjectDocument = async (kind: ProjectRequestDocumentKind, file: File) => {
    if (onProjectDocumentFileUpload) {
      return onProjectDocumentFileUpload({ kind, file });
    }
    if (kind === 'contract' && onContractFileUpload) {
      const processed = await onContractFileUpload(file);
      return {
        document: processed.contractDocument as FileAttachment,
        contractAnalysis: processed.contractAnalysis,
      };
    }
    throw new Error(`${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 업로드를 사용할 수 없는 화면입니다.`);
  };

  const processProjectDocument = async (
    kind: ProjectRequestDocumentKind,
    file: File,
    input?: HTMLInputElement,
  ) => {
    retryDocumentFileRef.current[kind] = file;
    const runId = (documentUploadRunRef.current[kind] || 0) + 1;
    documentUploadRunRef.current[kind] = runId;
    setDocumentUploadState((prev) => ({ ...prev, [kind]: 'extracting' }));
    setDocumentUploadError((prev) => ({ ...prev, [kind]: '' }));
    try {
      const processed = await uploadProjectDocument(kind, file);
      if (documentUploadRunRef.current[kind] !== runId) {
        // Cancelled while the upload was in flight. It still reached the server, so take it
        // back rather than leaving a file the screen does not show.
        if (input) input.value = '';
        try { await onRemoveProjectDocument?.(kind); } catch { /* already cancelled; nothing to report */ }
        return;
      }
      setDraft((prev) => {
        if (kind === 'contract') {
          const nextDraft = createProjectEditorWizardDraft({
            ...prev,
            contractDocument: processed.document,
            contractAnalysis: processed.contractAnalysis,
          });
          return contractAnalysisMergeMode === 'none'
            ? nextDraft
            : mergeContractAnalysisIntoDraft(nextDraft, processed.contractAnalysis);
        }
        const noteField = OPTIONAL_REGISTRATION_DOCUMENT_NOTE_FIELD[
          kind as keyof typeof OPTIONAL_REGISTRATION_DOCUMENT_NOTE_FIELD
        ];
        return createProjectEditorWizardDraft({
          ...prev,
          [PROJECT_DOCUMENT_FIELD[kind]]: processed.document,
          ...(noteField ? {
            registrationOptionalDocumentNotes: {
              ...prev.registrationOptionalDocumentNotes,
              [noteField]: '',
            },
          } : {}),
        });
      });
      setDocumentUploadState((prev) => ({ ...prev, [kind]: 'ready' }));
      toast.success(`${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 업로드 완료: ${file.name}`);
      delete retryDocumentFileRef.current[kind];
      if (input) input.value = '';
    } catch (error) {
      if (documentUploadRunRef.current[kind] !== runId) return;
      console.error(`[ProjectEditorWizard] ${kind} upload failed:`, error);
      const message = error instanceof Error ? error.message : `${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 업로드에 실패했습니다.`;
      setDocumentUploadState((prev) => ({ ...prev, [kind]: 'error' }));
      setDocumentUploadError((prev) => ({ ...prev, [kind]: message }));
      toast.error(message);
    }
  };

  const cancelProjectDocumentUpload = (kind: ProjectRequestDocumentKind) => {
    documentUploadRunRef.current[kind] = (documentUploadRunRef.current[kind] || 0) + 1;
    delete retryDocumentFileRef.current[kind];
    const input = getDocumentInputRef(kind).current;
    if (input) input.value = '';
    setDocumentUploadState((prev) => ({ ...prev, [kind]: 'idle' }));
    setDocumentUploadError((prev) => ({ ...prev, [kind]: '' }));
    toast.info(`${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 업로드를 취소했습니다.`);
  };

  const handleProjectDocumentSelect = async (kind: ProjectRequestDocumentKind, event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    if (!isProjectDocumentFileAllowed(kind, file)) {
      toast.error(`${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 파일 형식을 확인해 주세요.`);
      input.value = '';
      return;
    }
    if (file.size > documentUploadMaxBytes) {
      const message = `${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 파일은 ${documentUploadMaxLabel} 이하만 업로드할 수 있습니다.`;
      setDocumentUploadState((prev) => ({ ...prev, [kind]: 'error' }));
      setDocumentUploadError((prev) => ({ ...prev, [kind]: message }));
      toast.error(message);
      input.value = '';
      return;
    }
    await processProjectDocument(kind, file, input);
  };

  const removeProjectDocument = async (kind: ProjectRequestDocumentKind) => {
    setDocumentUploadState((prev) => ({ ...prev, [kind]: 'extracting' }));
    setDocumentUploadError((prev) => ({ ...prev, [kind]: '' }));
    try {
      await onRemoveProjectDocument?.(kind);
      setDraft((prev) => createProjectEditorWizardDraft({
        ...prev,
        ...(kind === 'contract'
          ? {
              contractDocument: initialContractDocument && !contractDocumentEditPolicy.canRemoveExistingContractDocument
                ? initialContractDocument
                : null,
              contractAnalysis: initialContractDocument && !contractDocumentEditPolicy.canRemoveExistingContractDocument
                ? initialContractAnalysis
                : null,
            }
          : { [PROJECT_DOCUMENT_FIELD[kind]]: null }),
      }));
      setDocumentUploadState((prev) => ({ ...prev, [kind]: 'idle' }));
      delete retryDocumentFileRef.current[kind];
      toast.success(`${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 첨부를 제거했습니다.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : `${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 첨부 제거에 실패했습니다.`;
      setDocumentUploadState((prev) => ({ ...prev, [kind]: 'error' }));
      setDocumentUploadError((prev) => ({ ...prev, [kind]: message }));
      toast.error('첨부 제거 실패', { description: message });
    }
  };

  const participationSheetBaseline = trustedParticipationSheetDraft || initialDraft;
  const participationSyncIssue = participationSheetSyncIssue({
    draft,
    initialDraft: participationSheetBaseline,
    syncedSignature: teamSyncSignature,
    trustInitialPersistedSheetState: Boolean(trustedParticipationSheetDraft),
  });
  const requiresParticipationSheetLink = participationSheetLinkRequired({
    draft,
    initialDraft: participationSheetBaseline,
    allowLegacyNoLink: Boolean(trustedParticipationSheetDraft),
  });

  const submitIssues = useMemo(() => {
    const issues: Array<{ step: ProjectEditorStep; label: string }> = [];
    const normalizedDepartment = normalizeProjectDepartment(draft.department);
    if (!normalizedDepartment || !departmentOptionSet.has(normalizedDepartment)) issues.push({ step: 'basic', label: '담당조직(CIC)' });
    if (!draft.name.trim()) issues.push({ step: 'basic', label: '프로젝트명' });
    if ((usesRegistrationV2 || draft.type !== 'I1') && !draft.contractStart.trim()) issues.push({ step: 'financial', label: '계약 시작일' });
    if ((usesRegistrationV2 || draft.type !== 'I1') && !draft.contractEnd.trim() && !draft.contractEndUndecided) issues.push({ step: 'financial', label: '계약 종료일' });
    if (draft.type !== 'I1' && !hasContractAmountInput) issues.push({ step: 'financial', label: '계약금액' });
    if (usesRegistrationV2) {
      if (!draft.officialContractName.trim()) issues.push({ step: 'basic', label: '공식 계약명' });
      if (!draft.clientOrg.trim()) issues.push({ step: 'basic', label: '계약 대상' });
      if (!draft.projectPurpose.trim()) issues.push({ step: 'basic', label: '프로젝트 목적' });
      if (!draft.description.trim()) issues.push({ step: 'basic', label: '프로젝트 주요 내용' });
      if (!draft.contractDocument) issues.push({ step: 'financial', label: '계약서 PDF' });
      if (draft.registrationConfirmations.modusignContractUsed === null) issues.push({ step: 'financial', label: '모두 싸인으로 진행하셨나요?' });
      if (draft.registrationConfirmations.modusignContractUsed === false && draft.registrationConfirmations.originalContractSubmitted !== true) {
        issues.push({ step: 'financial', label: '계약서를 써니(사업지원팀)에게 제출했습니다.' });
      }
      if (draft.registrationConfirmations.proposalPptOriginal && !isValidDriveUrl(draft.registrationConfirmations.proposalPptOriginal)) {
        issues.push({ step: 'financial', label: '제안서 PPT 링크' });
      }
      if (draft.registrationConfirmations.presentationPptOriginal && !isValidDriveUrl(draft.registrationConfirmations.presentationPptOriginal)) {
        issues.push({ step: 'financial', label: '발표자료 구글드라이브 링크' });
      }
      if (onProjectDocumentFileUpload) {
        if (!draft.customerBusinessRegistrationDocument) issues.push({ step: 'financial', label: '고객사 사업자등록증 PDF' });
      }
      if (!draft.quoteDocument && !draft.quoteSubmissionDeferred) issues.push({ step: 'financial', label: '산출내역서(견적서) PDF 또는 이후 제출' });
      if (
        draft.contractStart.trim()
        && draft.contractEnd.trim()
        && hasInvalidProjectContractPeriod(draft.contractStart, draft.contractEnd)
      ) {
        issues.push({ step: 'financial', label: '계약 종료일은 시작일 이후여야 합니다.' });
      }
      const startYear = Number(draft.contractStart.slice(0, 4));
      // 종료 기간 없음이면 재무 계획은 시작연도~현재 연도까지를 요구한다.
      const endYear = draft.contractEndUndecided && !draft.contractEnd.trim()
        ? new Date().getFullYear()
        : Number(draft.contractEnd.slice(0, 4));
      const expectedYears = Number.isSafeInteger(startYear) && Number.isSafeInteger(endYear) && startYear <= endYear
        ? Array.from({ length: endYear - startYear + 1 }, (_, offset) => startYear + offset)
        : [];
      const financialYearsComplete = expectedYears.length > 0
        && draft.financialYears.length === expectedYears.length
        && expectedYears.every((year) => draft.financialYears.some((row) => row.year === year));
      const annualTotal = (field: 'contractAmount' | 'salesVatAmount' | 'totalRevenueAmount' | 'totalActualCost' | 'supportAmount') => (
        draft.financialYears.reduce((sum, row) => sum + row[field], 0)
      );
      const annualTotalsMatch = annualTotal('contractAmount') === draft.contractAmount
        && annualTotal('salesVatAmount') === draft.salesVatAmount
        && annualTotal('totalRevenueAmount') === draft.totalRevenueAmount
        && annualTotal('totalActualCost') === draft.totalActualCost
        && annualTotal('supportAmount') === draft.supportAmount;
      /*
       * 금액을 연도별 표로 넣는 동안에는 연도 수와 무관하게 같은 조건을 건다.
       * 표는 미확인 연도를 빨갛게 알려주는데 단년도만 제출이 통과하면
       * 그 빨간 글씨가 아무 뜻도 갖지 못한다.
       */
      if (usesRegistrationV2 && (!financialYearsComplete || !annualTotalsMatch)) {
        issues.push({ step: 'financial', label: '계약기간 전체 연도별 재무 확인' });
      }
      if (draft.settlementType === 'NONE') issues.push({ step: 'financial', label: '사업유형' });
      if (settlementDetailsEnabled && draft.settlementSystem === 'OTHER') {
        const customSystem = draft.settlementSystemOther.trim();
        if (!customSystem) issues.push({ step: 'financial', label: '기타 정산 시스템 이름' });
        if (customSystem.length > 100) issues.push({ step: 'financial', label: '기타 정산 시스템 이름은 100자 이하여야 합니다.' });
      }
      (!hasMultiYearContract ? ['contract', 'interim', 'final'] as const : []).forEach((field) => {
        if (draft.paymentPlan[field] > 0 && !draft.paymentExpectedMonths[field]) {
          const label = field === 'contract' ? '선금/계약금 입금 예상월' : field === 'interim' ? '중도금 입금 예상월' : '잔금 입금 예상월';
          issues.push({ step: 'financial', label });
        }
      });
      if (hasMultiYearContract) {
        draft.financialYears.forEach((row) => {
          (['contract', 'interim', 'final'] as const).forEach((field) => {
            if ((row.paymentPlan?.[field] || 0) > 0 && !row.paymentExpectedMonths?.[field]) {
              const label = field === 'contract' ? '선금/계약금' : field === 'interim' ? '중도금' : '잔금';
              issues.push({ step: 'financial', label: `${row.year}년 ${label} 예상 입금 시점` });
            }
          });
        });
      }
      const missingAnnualAdvanceInterimReason = hasMultiYearContract && draft.financialYears.some((row) => {
        const paymentPlan = row.paymentPlan || { contract: 0, interim: 0, final: 0 };
        const paymentTotal = paymentPlan.contract + paymentPlan.interim + paymentPlan.final;
        return paymentTotal > 0
          && row.contractAmount > 0
          && (paymentPlan.contract + paymentPlan.interim) / row.contractAmount < 0.7
          && !row.advanceInterimBelow70Reason?.trim();
      });
      if ((!hasMultiYearContract && requiresAdvanceInterimReason && !draft.advanceInterimBelow70Reason.trim()) || missingAnnualAdvanceInterimReason) {
        issues.push({ step: 'financial', label: '선금·중도금 70% 미만 사유' });
      }
    }
    if (showProjectCheckout) {
      if (draft.checkout.performanceCertificateDocumentApplicable && !draft.performanceCertificateDocument) {
        issues.push({ step: 'financial', label: '수행확인서 PDF' });
      }
      if (draft.checkout.taxInvoiceEvidenceConfirmed && !draft.taxInvoiceDocument) {
        issues.push({ step: 'financial', label: '세금계산서 PDF' });
      }
      if (requiresSettlementConfirmations && draft.checkout.finalSettlementReportConfirmed && !draft.finalSettlementReportDocument) {
        issues.push({ step: 'financial', label: '최종 정산보고서 PDF' });
      }
      if (requiresSettlementConfirmations && draft.checkout.evidenceDeletedAfterUsb && !draft.checkout.usbEvidenceSubmitted) {
        issues.push({ step: 'financial', label: 'USB 제출 확인' });
      }
    }
    if (!draft.managerName.trim()) issues.push({ step: 'team', label: 'PM' });
    if (!draft.executiveApproverId || !selectedExecutiveApprover) {
      issues.push({ step: 'team', label: '최종 결재자 (총괄책임자)' });
    }
    // 참여인력은 시트에서 온다. 역할 구성(운영매니저 1인 이상)은 시트를 보고 사람이 판단할
    // 일이라 저장을 막지 않는다. 대신 시트 링크가 없으면 참여율을 적을 곳 자체가 없어 막는다.
    if (requiresParticipationSheetLink && !draft.participationSheetLink.trim()) {
      issues.push({ step: 'team', label: '참여율 시트 링크' });
    }
    if (participationSyncIssue) {
      issues.push({ step: 'team', label: participationSyncIssue });
    }
    // 정산지원 담당자는 저장을 막지 않는다. 담당이 정해져 있다는 안내일 뿐이고,
    // 담당자가 바뀌거나 자리를 비운 사이에 프로젝트 등록 자체가 막히면 안 된다.
    return issues;
  }, [departmentOptionSet, draft, hasContractAmountInput, hasMultiYearContract, onProjectDocumentFileUpload, participationSyncIssue, requiresAdvanceInterimReason, requiresParticipationSheetLink, requiresSettlementConfirmations, selectedExecutiveApprover, showProjectCheckout, usesRegistrationV2]);

  const canSubmit = submitIssues.length === 0;

  // 아래 세 가지는 모두 submitIssues 를 그대로 읽기만 한다. 판정 규칙은 손대지 않고
  // 보여주는 자리(단계 칩 배지 · 필드 옆 문구 · 이동 후 포커스)만 늘린다.
  const stepIssueCounts = useMemo(() => {
    const counts: Record<ProjectEditorStep, number> = { basic: 0, financial: 0, team: 0, review: 0 };
    submitIssues.forEach((issue) => { counts[issue.step] += 1; });
    return counts;
  }, [submitIssues]);
  const issueLabelSet = useMemo(() => new Set(submitIssues.map((issue) => issue.label)), [submitIssues]);
  /** 마지막 단계 목록과 같은 문구를 필드 바로 아래에서도 쓴다. */
  const fieldIssues = useCallback(
    (...labels: string[]) => labels.filter((label) => issueLabelSet.has(label)),
    [issueLabelSet],
  );
  const [pendingIssueFocus, setPendingIssueFocus] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingIssueFocus || typeof document === 'undefined') return undefined;
    const timer = window.setTimeout(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-issue-label]'))
        .find((node) => node.dataset.issueLabel === pendingIssueFocus);
      setPendingIssueFocus(null);
      if (!row) return;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.querySelector<HTMLElement>('input, textarea, select, button, [role=combobox]')?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pendingIssueFocus, stepIndex]);

  const goToIssue = (issue: { step: ProjectEditorStep; label: string }) => {
    setStepIndex(Math.max(0, STEPS.findIndex((step) => step.id === issue.step)));
    setPendingIssueFocus(issue.label);
  };

  const submitBlockedStatusReason = uploadInProgress
    ? '첨부파일을 처리하고 있습니다. 처리가 끝난 뒤 최종 저장해 주세요.'
    : hasPendingRetryFile
      ? '업로드하지 못한 첨부파일이 있습니다. 해당 파일을 다시 첨부해 주세요.'
      : autosaveState === 'saving'
        ? '임시저장을 진행하고 있습니다. 잠시 후 다시 시도해 주세요.'
        : null;
  const submitBlocked = !canSubmit || Boolean(submitBlockedStatusReason);

  useEffect(() => {
    if (!submitBlocked) setSubmitBlockedNotice(false);
  }, [submitBlocked]);

  const renderSubmitBlockers = () => {
    if (!submitBlocked) return null;
    return (
      <div
        aria-live="polite"
        className={cn(
          'rounded-lg border bg-white px-4 py-3 text-red-700',
          FORM_VALUE_CLASS,
          submitBlockedNotice ? 'border-red-400' : 'border-slate-200',
        )}
      >
        <p className="font-medium">
          {submitBlockedNotice ? '아직 최종 저장할 수 없습니다' : '최종 저장 전 확인이 필요합니다'}
        </p>
        {submitBlockedStatusReason ? <p className="mt-1.5">{submitBlockedStatusReason}</p> : null}
        {submitIssues.length > 0 ? (
          <ul className="mt-1.5 grid gap-1">
            {submitIssues.map((issue, index) => (
              <li key={`${issue.step}-${issue.label}-${index}`}>
                <button
                  type="button"
                  onClick={() => goToIssue(issue)}
                  className="text-left underline underline-offset-2 hover:text-red-900"
                >
                  {issue.label} · {STEPS.find((step) => step.id === issue.step)?.label} 단계로 이동
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  };

  const renderBasicStep = () => (
    <ProjectFormSection title="기본 정보">
      <ProjectFormRow label="담당조직(CIC)" required issueLabel="담당조직(CIC)" errors={fieldIssues('담당조직(CIC)')}>
      <Select value={canUseSelectedDepartment ? selectedDepartment : undefined} onValueChange={(value) => update('department', value)}>
        <SelectTrigger className={cn(FIELD_W_SM, FORM_CONTROL_CLASS)}>
          <SelectValue placeholder="담당조직 선택" />
        </SelectTrigger>
        <SelectContent>
          {normalizedDepartmentOptions.map((department) => (
            <SelectItem key={department} value={department}>{department}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </ProjectFormRow>
      <ProjectFormRow label="프로젝트 유형" required>
      <Select value={draft.type} onValueChange={(value) => update('type', value as ProjectType)}>
        <SelectTrigger className={cn(FIELD_W_MD, FORM_CONTROL_CLASS)}><SelectValue /></SelectTrigger>
        <SelectContent>
          {projectTypeOptions.map((type) => (
            <SelectItem key={type} value={type}>{PROJECT_TYPE_LABELS[type]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </ProjectFormRow>

      <ProjectFormRow
        label="공식 계약명"
        required={usesRegistrationV2}
        issueLabel="공식 계약명"
        errors={fieldIssues('공식 계약명')}
        hints={['띄어쓰기를 포함해 계약서 표기와 동일하게 입력해 주세요.']}
      >
        <Input
          value={draft.officialContractName}
          onChange={(event) => update('officialContractName', event.target.value)}
          placeholder="계약서에 기재된 계약명 그대로 입력"
          className={FORM_CONTROL_CLASS}
        />
      </ProjectFormRow>

      <ProjectFormRow
        label="프로젝트명"
        required
        issueLabel="프로젝트명"
        errors={fieldIssues('프로젝트명')}
        hints={[
          '계약연도+프로젝트명 형식으로 입력해 주세요. 다년도 사업은 같은 연도만 변경된 동일 프로젝트명을 사용해주세요.(재경팀이 부여하는 A_, C_와 같은 코드는 기입하지 않습니다)',
        ]}
      >
        <Input
          value={draft.name}
          onChange={(event) => update('name', event.target.value)}
          placeholder="예: 26농식품AC"
          className={FORM_CONTROL_CLASS}
        />
      </ProjectFormRow>

      <ProjectFormRow
        label="계약 대상"
        required={usesRegistrationV2}
        issueLabel="계약 대상"
        errors={fieldIssues('계약 대상')}
        hints={['사업자등록증상 법인명을 띄어쓰기까지 동일하게 입력해 주세요.']}
      >
        <Input
          value={draft.clientOrg}
          onChange={(event) => update('clientOrg', event.target.value)}
          placeholder="예: 주식회사 ○○"
          className={FORM_CONTROL_CLASS}
        />
      </ProjectFormRow>

      <ProjectFormRow
        label="사업관리 구글폴더링크"
        hints={['사업관리용 Google Drive 폴더 링크를 입력해 주세요.']}
      >
        <Input
          type="url"
          value={draft.businessManagementGoogleFolderLink}
          onChange={(event) => update('businessManagementGoogleFolderLink', event.target.value)}
          placeholder="https://drive.google.com/drive/folders/..."
          className={FORM_CONTROL_CLASS}
        />
      </ProjectFormRow>


      <ProjectFormRow
        label="프로젝트 목적"
        required={usesRegistrationV2}
        issueLabel="프로젝트 목적"
        errors={fieldIssues('프로젝트 목적')}
        hints={[
          '어떤 대상에게 어떤 가치를 제공하는 프로젝트인지 입력',
          <span key="purpose-example" className="block">예: CJ푸드빌 새로운 점포를 만들어갈 사내기업가 육성</span>,
        ]}
      >
        <Textarea
          value={draft.projectPurpose}
          onChange={(event) => update('projectPurpose', event.target.value)}
          className={cn('min-h-[88px]', FORM_VALUE_CLASS)}
        />
      </ProjectFormRow>

      <ProjectFormRow
        label="프로젝트 주요 내용"
        required={usesRegistrationV2}
        issueLabel="프로젝트 주요 내용"
        errors={fieldIssues('프로젝트 주요 내용')}
        hints={[
          '프로젝트 주요 수행 내용, 범위, 산출물 등 프로그램 핵심 내용 요약',
          <span key="description-example" className="block">
            예:
            <span className="block">1. 사업제안서 작성 교육</span>
            <span className="block">2. 사업제안서 작성 - 25개팀 이상 1:1 코칭</span>
            <span className="block">3. 선정된 10개 팀 사업제안 구체화 1:1 컨설팅</span>
          </span>,
        ]}
      >
        <Textarea
          value={draft.description}
          onChange={(event) => update('description', event.target.value)}
          className={cn('min-h-[110px]', FORM_VALUE_CLASS)}
        />
      </ProjectFormRow>
    </ProjectFormSection>
  );

  const renderContractTypeSelect = () => (
    <ProjectFormRow label="계약서 유형">
      <Select
        value={normalizeProjectContractType(draft.contractType)}
        onValueChange={(value) => update('contractType', normalizeProjectContractType(value))}
      >
        <SelectTrigger className={cn(FIELD_W_MD, FORM_CONTROL_CLASS)}><SelectValue /></SelectTrigger>
        <SelectContent>
          {contractTypeOptions.map((contractType) => (
            <SelectItem key={contractType} value={contractType}>{contractType}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </ProjectFormRow>
  );

  const renderProjectDocumentUpload = (
    kind: ProjectRequestDocumentKind,
    options: {
      slotNumber?: number;
      label?: string;
      description?: string;
      embedded?: boolean;
      disabled?: boolean;
      /** Renders only the upload/replace and remove controls, for use inside a table row. */
      rowAction?: boolean;
    } = {},
  ) => {
    const document = draft[PROJECT_DOCUMENT_FIELD[kind]] as FileAttachment | null;
    const documentDownloadURL = document ? (documentPreviewUrls?.[kind] || document.downloadURL) : '';
    const previewState = documentPreviewStates?.[kind];
    const uploadState = documentUploadState[kind];
    const uploadError = documentUploadError[kind];
    const inputRef = getDocumentInputRef(kind);
    const canRemove = canRemoveProjectDocuments && (kind === 'contract'
      ? contractDocumentEditPolicy.canRemoveCurrentContractDocument
      : Boolean(document));
    const removeLabel = kind === 'contract' ? contractDocumentEditPolicy.removeButtonLabel : '첨부 제거';
    const remove = () => { void removeProjectDocument(kind); };
    const description = options.description ?? (kind === 'contract'
      ? (contractAnalysisMergeMode === 'none'
          ? 'PDF를 올리면 계약서 원문과 검토용 첨부를 저장합니다. 입력값은 자동으로 바꾸지 않습니다.'
          : 'PDF를 올리면 계약명, 계약기간, 계약금액, 계약 대상 후보를 읽어와 빈 항목만 채웁니다.')
      : kind === 'proposal_word_original'
        ? '원본 DOCX를 올립니다. 파일이 없으면 아래에 미첨부 사유 또는 해당 없음을 적어주세요.'
        : kind === 'proposal_ppt_original' || kind === 'presentation_ppt_original'
          ? '원본 PPTX를 올립니다. 파일이 없으면 아래에 미첨부 사유 또는 해당 없음을 적어주세요.'
          : kind === 'rfp_request_evidence'
            ? 'RFP 또는 요청 메일 원본을 PDF, DOCX, EML, MSG 중 하나로 올려주세요.'
            : 'PDF를 올리면 검토용 첨부로 저장합니다.');

    const uploadButton = (
      <>
        <input
          ref={inputRef}
          type="file"
          accept={getProjectDocumentUploadAccept(kind)}
          className="hidden"
          onChange={(event) => handleProjectDocumentSelect(kind, event)}
        />
        <Button
          type="button"
          variant="outline"
          size={options.rowAction ? 'sm' : 'default'}
          className={options.rowAction ? 'h-8 gap-1.5 px-2 text-[11px]' : 'w-full gap-2 lg:w-auto'}
          disabled={uploadState === 'extracting' || options.disabled}
          onClick={() => {
            const retryFile = retryDocumentFileRef.current[kind];
            if (retryFile) void processProjectDocument(kind, retryFile, inputRef.current || undefined);
            else inputRef.current?.click();
          }}
        >
          {uploadState === 'extracting' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {retryDocumentFileRef.current[kind]
            ? `${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 다시 시도`
            : document
              ? `${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 교체`
              : `${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 업로드`}
        </Button>
      </>
    );

    if (options.rowAction) {
      return (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {documentDownloadURL ? (
            <Button asChild type="button" variant="outline" size="sm" className="h-8 px-2 text-[11px]">
              <a href={documentDownloadURL} target="_blank" rel="noreferrer">원문 보기</a>
            </Button>
          ) : document && previewState && onLoadDocumentPreview ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-2 text-[11px]"
              disabled={previewState.status === 'loading'}
              onClick={() => void onLoadDocumentPreview(kind)}
            >
              {previewState.status === 'loading' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              {previewState.status === 'error' ? '다시 불러오기' : previewState.status === 'loading' ? '불러오는 중' : '원문 불러오기'}
            </Button>
          ) : null}
          {uploadState === 'extracting' ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-[11px]"
              onClick={() => cancelProjectDocumentUpload(kind)}
            >
              업로드 취소
            </Button>
          ) : null}
          {uploadButton}
          {canRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-[11px] text-slate-500 hover:text-red-700"
              disabled={uploadState === 'extracting'}
              onClick={remove}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              {removeLabel}
            </Button>
          ) : null}
        </div>
      );
    }

    return (
      <div
        key={kind}
        className={cn(
          options.embedded
            ? 'rounded-lg border border-slate-200 bg-white p-3'
            : 'rounded-xl border border-slate-200 bg-slate-50/70 p-4',
        )}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {options.slotNumber ? (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#001e46] text-[11px] font-semibold text-white">
                  {options.slotNumber}
                </span>
              ) : <FileText className="h-4 w-4 text-slate-600" />}
              <Label className={FORM_LABEL_CLASS}>{options.label || PROJECT_DOCUMENT_LABELS[kind]}</Label>
            </div>
            <p className={cn('mt-2', FORM_HINT_CLASS)}>
              {description}
            </p>
            {document ? (
              <div className={cn('mt-3 flex flex-wrap items-center gap-2', FORM_VALUE_CLASS)}>
                <span className="max-w-full truncate font-medium text-slate-900">{document.name}</span>
                <span className="text-muted-foreground">
                  {(document.size / 1024 / 1024).toFixed(2)} MB
                </span>
                {documentDownloadURL ? (
                  <Button asChild type="button" variant="outline" size="sm" className="h-7 px-2 text-[11px]">
                    <a href={documentDownloadURL} target="_blank" rel="noreferrer">원문 보기</a>
                  </Button>
                ) : document && previewState && onLoadDocumentPreview ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    disabled={previewState.status === 'loading'}
                    onClick={() => void onLoadDocumentPreview(kind)}
                  >
                    {previewState.status === 'loading' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                    {previewState.status === 'error' ? '원문 다시 불러오기' : previewState.status === 'loading' ? '불러오는 중' : '원문 불러오기'}
                  </Button>
                ) : null}
                {canRemove ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px] text-slate-500 hover:text-red-700"
                    disabled={uploadState === 'extracting'}
                    onClick={remove}
                  >
                    <X className="mr-1 h-3.5 w-3.5" />
                    {removeLabel}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {kind === 'contract' && contractDocumentEditPolicy.isExistingContractDocumentLocked ? (
              <p className={cn('mt-2', FORM_HINT_CLASS)}>
                기존 계약서는 관리자 화면에서만 제거할 수 있습니다.
              </p>
            ) : null}
            {kind === 'contract' && draft.contractAnalysis ? (
              <div className={cn('mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-700', FORM_VALUE_CLASS)}>
                <span className="font-semibold text-[#001e46]">분석 요약</span>
                <span className="ml-2">{draft.contractAnalysis.summary}</span>
              </div>
            ) : null}
            {uploadError ? (
              <p className={cn('mt-2', FORM_ERROR_CLASS)}>{uploadError}</p>
            ) : null}
            {previewState?.status === 'error' ? (
              <p className={cn('mt-2', FORM_ERROR_CLASS)} role="alert">
                {previewState.error || '첨부 파일을 불러오지 못했습니다.'}
              </p>
            ) : null}
          </div>
          <div className="shrink-0">
            <input
              ref={inputRef}
              type="file"
              accept={getProjectDocumentUploadAccept(kind)}
              className="hidden"
              onChange={(event) => handleProjectDocumentSelect(kind, event)}
            />
            <Button
              type="button"
              variant="outline"
              className="w-full gap-2 lg:w-auto"
              disabled={uploadState === 'extracting' || options.disabled}
              onClick={() => {
                const retryFile = retryDocumentFileRef.current[kind];
                if (retryFile) void processProjectDocument(kind, retryFile, inputRef.current || undefined);
                else inputRef.current?.click();
              }}
            >
              {uploadState === 'extracting' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {retryDocumentFileRef.current[kind]
                ? `${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 다시 시도`
                : document
                  ? `${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 교체`
                  : `${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 업로드`}
            </Button>
          </div>
        </div>
      </div>
    );
  };

  /**
   * The seven registration documents as one scannable list.
   *
   * As stacked cards each slot rendered a different shape — one carried a contract
   * analysis, another a checkbox, two a URL field — so telling at a glance which
   * documents were still missing meant scrolling and remembering. The row states what a
   * reviewer needs (number, document, what is attached, whether it is required) and any
   * slot-specific control opens underneath it.
   */
  const renderRegistrationDocumentTable = () => {
    // 필수는 상태가 아니라 성격이다. 오류색(red)이 아니라 강조색을 써서
    // 필드 라벨의 `*` 와 같은 뜻으로 읽히게 한다.
    const requirementOf = (slotNumber: number) => (
      slotNumber <= 3
        ? { label: '필수', tone: 'border-[#0176D3]/30 bg-[#0176D3]/5 text-[#0176D3]' }
        : { label: '선택', tone: 'border-slate-200 bg-slate-50 text-slate-500' }
    );

    return (
      /*
       * 표(5열)가 아니라 체크리스트다. 서류 준비는 "칸을 채우는 일"이 아니라 "항목을
       * 끝내는 일"이라, 행마다 상태 아이콘이 먼저 말하고 액션은 오른쪽 끝 한 곳에 둔다.
       * 미첨부는 오류가 아니라 대기이므로 필수만 앰버로, 선택은 슬레이트로 말한다.
       */
      <div className={cn('divide-y divide-slate-100 border-y border-slate-200 bg-white', FORM_VALUE_CLASS)}>
        {REGISTRATION_DOCUMENT_SLOTS.map((slot) => {
          const kind = slot.kinds[0];
          const requirement = requirementOf(slot.number);
          const isLinkSlot = slot.number === 5 || slot.number === 6;
          const linkValue = slot.number === 5
            ? draft.registrationConfirmations.proposalPptOriginal
            : draft.registrationConfirmations.presentationPptOriginal;
          const document = draft[PROJECT_DOCUMENT_FIELD[kind]] as FileAttachment | null;
          const deferred = slot.number === 3 && draft.quoteSubmissionDeferred;
          const attached = isLinkSlot ? Boolean(String(linkValue || '').trim()) : Boolean(document);
          const unmet = !attached && !deferred && slot.number <= 3;
          const uploadError = documentUploadError[kind];
          const previewState = documentPreviewStates?.[kind];
          const previewError = previewState?.status === 'error'
            ? (previewState.error || '첨부 파일을 불러오지 못했습니다.')
            : '';
          const contractLocked = kind === 'contract'
            && contractDocumentEditPolicy.isExistingContractDocumentLocked;
          const contractSummary = kind === 'contract' ? draft.contractAnalysis?.summary : '';

          const statusIcon = attached
            ? <CircleCheck className="h-4 w-4 text-emerald-600" aria-label="첨부됨" />
            : deferred
              ? <Clock3 className="h-4 w-4 text-amber-600" aria-label="이후 제출" />
              : <Circle className={cn('h-4 w-4', unmet ? 'text-amber-500' : 'text-slate-300')} aria-label="미첨부" />;
          const statusText = isLinkSlot
            ? null
            : document ? `${document.name} · ${(document.size / 1024 / 1024).toFixed(2)} MB`
              : deferred ? '이후 제출(예외 처리)' : '미첨부';

          return (
            <div key={slot.number} className="flex gap-3 py-3">
              <div className="mt-0.5 shrink-0">{statusIcon}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={cn('tabular-nums text-slate-400', FORM_HINT_CLASS)}>{slot.number}</span>
                  <p className="font-medium text-slate-900">{slot.label}</p>
                  <span className={cn('rounded-full border px-1.5 py-px text-[11px] font-semibold leading-4', requirement.tone)}>
                    {requirement.label}
                  </span>
                </div>
                {slot.description ? <p className={cn('mt-0.5', FORM_HINT_CLASS)}>{slot.description}</p> : null}
                {statusText ? (
                  <p className={cn('mt-1 break-all', attached ? 'text-slate-700' : unmet ? 'text-amber-700' : 'text-slate-400')}>
                    {statusText}
                  </p>
                ) : null}
                {isLinkSlot ? (
                  <Input
                    type="url"
                    aria-label={slot.label}
                    value={linkValue}
                    onChange={(event) => update('registrationConfirmations', {
                      ...draft.registrationConfirmations,
                      [slot.number === 5 ? 'proposalPptOriginal' : 'presentationPptOriginal']: event.target.value,
                    })}
                    placeholder="https://drive.google.com/..."
                    className={cn('mt-1.5', FIELD_W_MD, FORM_CONTROL_CLASS)}
                  />
                ) : null}
                {uploadError ? <p className={cn('mt-1', FORM_ERROR_CLASS)} role="alert">{uploadError}</p> : null}
                {previewError ? <p className={cn('mt-1', FORM_ERROR_CLASS)} role="alert">{previewError}</p> : null}
                {contractLocked ? (
                  <p className={cn('mt-1', FORM_HINT_CLASS)}>기존 계약서는 관리자 화면에서만 제거할 수 있습니다.</p>
                ) : null}
                {contractSummary ? (
                  <p className={cn('mt-1 text-slate-700', FORM_HINT_CLASS)}>
                    <span className="font-semibold text-[#001e46]">분석 요약</span>
                    <span className="ml-2">{contractSummary}</span>
                  </p>
                ) : null}
                {slot.number === 3 ? (
                  <label className={cn('mt-1.5 flex items-center gap-2 text-slate-700', FORM_VALUE_CLASS)}>
                    <Checkbox
                      checked={draft.quoteSubmissionDeferred === true}
                      onCheckedChange={(checked) => update('quoteSubmissionDeferred', checked === true)}
                    />
                    산출내역서(견적서) 이후 제출(예외 처리)
                  </label>
                ) : null}
              </div>
              <div className="shrink-0 self-start">
                {isLinkSlot ? null : renderProjectDocumentUpload(kind, {
                  slotNumber: slot.number,
                  label: slot.label,
                  description: slot.description,
                  rowAction: true,
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderRegistrationDocumentSlot = (slot: RegistrationDocumentSlot) => {
    return renderProjectDocumentUpload(slot.kinds[0], {
      slotNumber: slot.number,
      label: slot.label,
      description: slot.description,
    });
  };

  /**
   * 금액은 단년도·다년도 모두 연도별 표가 가진다. 표의 합계 행이 저장되는 총계이므로
   * 위쪽 총계 입력칸 5개는 v1 등록에만 남는다. 예전에는 다년도만 표였고 단년도는
   * 입력칸이었는데, 같은 값을 두 모양으로 넣게 되어 화면마다 다르게 읽혔다.
   */
  const annualTotalsOwnAmounts = usesRegistrationV2;
  /** 단년도는 계약금액이 항목 합계에서 나온다. 다년도는 연도마다 따로 입력받는다. */
  const contractAmountIsDerived = annualTotalsOwnAmounts && !hasMultiYearContract;
  /**
   * 자동 계산 이전에 저장된 계약금액이 항목 합계와 어긋나는 경우. 값은 여기서 고치지 않는다.
   * 사람이 금액을 한 번이라도 고치면 그때 합계로 바뀌므로, 그 전에 차이를 보여준다.
   */
  const storedContractAmountConflict = (() => {
    if (!contractAmountIsDerived) return null;
    const row = draft.financialYears[0];
    if (!row) return null;
    const derived = deriveContractAmountFromItems(row);
    if (row.contractAmount === derived) return null;
    return { stored: row.contractAmount, derived };
  })();
  const annualTotal = (field: 'contractAmount' | 'salesVatAmount' | 'totalRevenueAmount' | 'totalActualCost' | 'supportAmount') => (
    draft.financialYears.reduce((sum, row) => sum + row[field], 0)
  );

  /**
   * 계약금액과 항목 합계를 대조한다. 값을 고치지는 않는다 - 프로덕션 69건 중 식과 맞는
   * 것이 8건뿐이라 자동 계산으로 바꾸면 56건의 계약금액이 다음 저장에 조용히 줄어든다.
   * 다년도는 표 합계가 곧 저장값이므로 그 합계로 대조한다.
   */
  const contractAmountCheck = annualTotalsOwnAmounts
    ? checkContractAmount({
      contractAmount: annualTotal('contractAmount'),
      salesVatAmount: annualTotal('salesVatAmount'),
      totalRevenueAmount: annualTotal('totalRevenueAmount'),
      totalActualCost: annualTotal('totalActualCost'),
      supportAmount: annualTotal('supportAmount'),
    })
    : checkContractAmount({
      contractAmount: draft.contractAmount,
      salesVatAmount: draft.salesVatAmount,
      totalRevenueAmount: draft.totalRevenueAmount,
      totalActualCost: draft.totalActualCost,
      supportAmount: draft.supportAmount,
    });

  /** 금액 입력 아래 보조 표기. 한글 단위는 읽기 전용이고 저장값은 원 단위 그대로다. */
  const amountHint = (value: number, entered: boolean, prefix = '') => {
    if (!entered) return '미입력';
    const base = `${prefix ? `${prefix} ` : ''}${fmtKRW(value)}원`;
    const korean = draft.currency === 'KRW' ? formatKoreanAmountUnit(value) : '';
    return korean ? `${base} · ${korean}` : base;
  };

  /**
   * 연도별 계약·재무를 표 하나로 읽는다. 연도=행 · 항목=열이라 라벨이 한 번만 나오고,
   * Tab 은 한 연도를 열 방향(왼쪽→오른쪽)으로 훑는다.
   * 합계 행이 위쪽 총계 입력칸을 대신하므로 배경색과 강조색을 여기에만 쓴다.
   */
  const renderAnnualFinanceTable = () => {
    const columns = [
      ['contractAmount', '계약금액'],
      ['salesVatAmount', '매출 부가세'],
      ['totalRevenueAmount', '수익'],
      ['totalActualCost', '실비(원가)'],
      ['supportAmount', '지원금'],
    ] as const;
    const emptyContractYears = draft.financialYears.filter((row) => row.contractAmount <= 0).map((row) => `${row.year}년`);
    // 저장된 총계와 연도 합계가 어긋나면 이미 submitIssues 가 잡는다. 여기서는 같은 사실을
    // 표 밑에서 보여주기만 하고 판정은 하지 않는다.
    const totalsDrifted = columns.some(([field]) => annualTotal(field) !== draft[field]);
    const koreanContractTotal = formatKoreanAmountUnit(annualTotal('contractAmount'));

    return (
      <div className="space-y-2">
        {/* 통화는 사업 단위로 하나라 표 밖에서 한 번 고른다. 행마다 빈 통화 칸을 두면
            표가 넓어지고 합계 행의 드롭다운은 무엇의 단위인지 안 읽혔다. */}
        <ProjectFormRow label="통화">
          <Select value={draft.currency} onValueChange={(value) => update('currency', (value === 'USD' ? 'USD' : 'KRW') as ProjectCurrency)}>
            <SelectTrigger className={cn(FIELD_W_SM, FORM_CONTROL_CLASS)} aria-label="통화"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(PROJECT_CURRENCY_LABELS) as ProjectCurrency[]).map((currency) => (
                <SelectItem key={currency} value={currency}>{PROJECT_CURRENCY_LABELS[currency]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ProjectFormRow>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead>
              <tr className="border-y border-slate-200 bg-slate-50">
                <th scope="col" className={cn('py-2 pr-3', FORM_LABEL_CLASS)}>연도</th>
                {columns.map(([field, label]) => (
                  <Fragment key={field}>
                    <th scope="col" className={cn('px-3 py-2 text-right', FORM_LABEL_CLASS)}>{label}</th>
                  </Fragment>
                ))}
                <th scope="col" className={cn('px-3 py-2 text-right', FORM_LABEL_CLASS)}>수익률</th>
              </tr>
            </thead>
            <tbody>
              {draft.financialYears.map((row, index) => (
                <tr key={row.year} className="border-b border-slate-100">
                  <th scope="row" className={cn('whitespace-nowrap py-2 pr-3 font-semibold text-slate-900', FORM_NUMERIC_VALUE_CLASS)}>
                    {row.year}년
                  </th>
                  {columns.map(([field, label]) => (
                    <Fragment key={field}>
                    <td className="px-3 py-2">
                      {field === 'contractAmount' && contractAmountIsDerived ? (
                        /* 숫자 열이라 오른쪽 정렬을 지킨다. 입력칸 모양은 쓰지 않는다. */
                        <div className="flex h-9 min-w-[116px] flex-col items-end justify-center">
                          <span className={cn('font-medium text-slate-900', FORM_NUMERIC_VALUE_CLASS)}>
                            {fmtKRW(row.contractAmount)}
                          </span>
                          <span className="text-[11px] font-normal leading-4 text-slate-400">계산됨</span>
                        </div>
                      ) : (
                        <Input
                          inputMode="numeric"
                          aria-label={`${row.year}년 ${label}`}
                          value={formatProjectAmountInput(row[field], true)}
                          onChange={(event) => updateFinancialYear(index, field, parseProjectAmountInput(event.target.value))}
                          className={cn('min-w-[116px]', FORM_NUMERIC_CONTROL_CLASS)}
                        />
                      )}
                    </td>
                    </Fragment>
                  ))}
                  <td className={cn('px-3 py-2 text-right text-slate-600', FORM_NUMERIC_VALUE_CLASS)}>
                    {`${(row.profitRate * 100).toFixed(2)}%`}
                  </td>
                </tr>
              ))}
              <tr className="bg-slate-100">
                <th scope="row" className={cn('py-2.5 pr-3 text-slate-900', FORM_LABEL_CLASS)}>합계</th>
                {columns.map(([field]) => (
                  <Fragment key={field}>
                    <td className={cn('px-3 py-2.5 text-right font-semibold text-[#0176D3]', FORM_NUMERIC_VALUE_CLASS)}>
                      {fmtKRW(annualTotal(field))}
                    </td>
                  </Fragment>
                ))}
                <td className={cn('px-3 py-2.5 text-right font-semibold text-slate-900', FORM_NUMERIC_VALUE_CLASS)}>
                  {profitRateLabel ? `${profitRateLabel}%` : '-'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <ul className={cn('space-y-1', FORM_HINT_CLASS)}>
          <li className="flex gap-1.5">
            <span aria-hidden>•</span>
            <span>계약금액 합계 {koreanContractTotal || '0 원'}</span>
          </li>
          {contractAmountIsDerived ? (
            <li className="flex gap-1.5">
              <span aria-hidden>•</span>
              <span>계약금액은 매출 부가세 · 수익 · 실비(원가) · 지원금의 합으로 계산됩니다.</span>
            </li>
          ) : null}
          {/* 다년도는 계약금액을 사람이 넣으므로 항목 합계와 다르면 알려만 준다. 값은 고치지 않는다. */}
          {!contractAmountIsDerived && contractAmountCheck.message ? (
            <li className="flex gap-1.5 text-amber-700">
              <span aria-hidden>•</span>
              <span>{contractAmountCheck.message}</span>
            </li>
          ) : null}
        </ul>
        {/*
         * 단년도 계약금액을 자동 계산으로 바꾸기 전에 저장된 값은 항목 합계와 다를 수 있다.
         * 2026-08 프로덕션 기준 69건 중 식과 맞는 것이 8건뿐이고 실비(원가)는 전부 비어 있다.
         * 조용히 줄어드는 것이 사고이므로, 저장 전에 바뀔 금액을 눈에 보이게 둔다.
         */}
        {contractAmountIsDerived && storedContractAmountConflict ? (
          <p className={cn('rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800', FORM_HINT_CLASS)}>
            저장된 계약금액 {fmtKRW(storedContractAmountConflict.stored)}원이 항목 합계
            {' '}{fmtKRW(storedContractAmountConflict.derived)}원과 다릅니다.
            금액을 한 번 고쳐 넣으면 항목 합계로 바뀌어 저장되니, 어느 쪽이 맞는지 먼저 확인해 주세요.
          </p>
        ) : null}
        {emptyContractYears.length > 0 || totalsDrifted ? (
          <ul className={cn('space-y-1', FORM_ERROR_CLASS)}>
            {emptyContractYears.length > 0 ? (
              <li className="flex gap-1.5">
                <span aria-hidden>·</span>
                <span>{emptyContractYears.join(', ')} 계약금액이 아직 비어 있습니다.</span>
              </li>
            ) : null}
            {totalsDrifted ? (
              <li className="flex gap-1.5">
                <span aria-hidden>·</span>
                <span>저장된 총계가 연도 합계와 다릅니다. 금액을 한 번 고쳐 넣으면 합계가 다시 맞춰집니다.</span>
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
    );
  };

  const renderFinancialStep = () => (
    <div className={FORM_SECTION_STACK_CLASS}>
      {onContractFileUpload || onProjectDocumentFileUpload ? (
        <div>
          {usesRegistrationV2 ? (
            <ProjectFormSection
              title="등록 제출서류 7종"
              description="1~2번은 필수, 3번은 첨부 또는 이후 제출로 진행할 수 있으며 4~7번은 선택입니다."
              flushBelow
            >
              {renderRegistrationDocumentTable()}
              {/* Contract-specific confirmations stay below the list; they belong to slot 1
                  but are questions about the contract rather than an attachment. */}
              <ProjectFormRow
                label="모두 싸인으로 진행하셨나요?"
                required
                issueLabel="모두 싸인으로 진행하셨나요?"
                errors={fieldIssues('모두 싸인으로 진행하셨나요?', '계약서를 써니(사업지원팀)에게 제출했습니다.')}
              >
                <div className={cn('flex gap-4 pt-2 text-slate-700', FORM_VALUE_CLASS)}>
                  {[true, false].map((value) => (
                    <label key={String(value)} className="flex items-center gap-2">
                      <input type="radio" checked={draft.registrationConfirmations.modusignContractUsed === value} onChange={() => update('registrationConfirmations', { ...draft.registrationConfirmations, modusignContractUsed: value, originalContractSubmitted: value ? null : draft.registrationConfirmations.originalContractSubmitted })} />
                      {value ? '예' : '아니오'}
                    </label>
                  ))}
                </div>
                {draft.registrationConfirmations.modusignContractUsed === false ? (
                  <label className={cn('mt-2 flex items-center gap-2 text-slate-700', FORM_VALUE_CLASS)}>
                    <Checkbox checked={draft.registrationConfirmations.originalContractSubmitted === true} onCheckedChange={(checked) => update('registrationConfirmations', { ...draft.registrationConfirmations, originalContractSubmitted: checked === true })} />
                    계약서를 써니(사업지원팀)에게 제출했습니다.
                  </label>
                ) : null}
              </ProjectFormRow>
            </ProjectFormSection>
          ) : (
            <ProjectFormSection title="첨부 서류">
              {registrationDocumentKinds.map((kind) => renderProjectDocumentUpload(kind))}
            </ProjectFormSection>
          )}
        </div>
      ) : null}

      {/*
        계약 기간 · 계약 금액 · 연도별 계약·재무를 한 묶음으로 읽는다. 셋은 같은 계약을
        기간 / 통화 / 금액으로 나눠 말할 뿐이라 제목을 세 번 끊으면 관계가 보이지 않았다.
      */}
      <ProjectFormSection title="계약 정보">
        <ProjectFormRow label="계약 시작일" required issueLabel="계약 시작일" errors={fieldIssues('계약 시작일')}>
          <Input type="date" value={draft.contractStart} onChange={(event) => updateContractPeriod('contractStart', event.target.value)} className={cn(FIELD_W_XS, FORM_NUMERIC_CONTROL_CLASS, 'text-left')} />
        </ProjectFormRow>
        <ProjectFormRow
          label="계약 종료일"
          required
          issueLabel="계약 종료일"
          errors={fieldIssues('계약 종료일', '계약 종료일은 시작일 이후여야 합니다.')}
        >
          <div className="flex flex-wrap items-center gap-3">
            <Input
              type="date"
              value={draft.contractEnd}
              onChange={(event) => updateContractPeriod('contractEnd', event.target.value)}
              disabled={draft.contractEndUndecided}
              className={cn(FIELD_W_XS, FORM_NUMERIC_CONTROL_CLASS, 'text-left')}
            />
            {/* 종료일이 정해지지 않은 계약이 있다. 빈칸(미입력)과 구분하는 명시 선택이라
                체크하면 종료일을 비우고 잠근다. */}
            <label className="flex items-center gap-1.5 text-[13px] text-slate-700">
              <Checkbox
                checked={draft.contractEndUndecided}
                onCheckedChange={(checked) => updateContractEndUndecided(checked === true)}
                aria-label="종료 기간 없음"
              />
              종료 기간 없음
            </label>
          </div>
        </ProjectFormRow>

      {canEditProjectStatus(mode) && isAdminMode(mode) ? (
        <ProjectFormRow label="프로젝트 구분">
          <Select value={draft.phase} onValueChange={(value) => update('phase', value as ProjectPhase)}>
            <SelectTrigger className={cn(FIELD_W_MD, FORM_CONTROL_CLASS)}><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(PROJECT_PHASE_LABELS) as ProjectPhase[]).map((phase) => (
                <SelectItem key={phase} value={phase}>{PROJECT_PHASE_LABELS[phase]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ProjectFormRow>
      ) : null}
        {/* 계약서 유형은 관리자 화면에서만 상태·구분과 나란히 있었고, 포털에서는 단독으로
            보였다. 행 컴포넌트를 쓰면서 두 경우 모두 같은 자리에 한 번만 놓는다. */}
      {!canEditProjectStatus(mode) || isAdminMode(mode) ? renderContractTypeSelect() : null}

        {annualTotalsOwnAmounts ? (
          <p className={FORM_HINT_CLASS}>
            {hasMultiYearContract
              ? '계약금액 · 총매출부가세 · 총수익 · 총실비(원가) · 총지원금은 아래 연도별 표의 합계 행이 그대로 저장값입니다.'
              : '계약금액 · 총매출부가세 · 총수익 · 총실비(원가) · 총지원금은 아래 표에서 입력하며, 합계 행이 그대로 저장값입니다.'}
          </p>
        ) : (
          <>
            <ProjectFormRow
              label="계약금액"
              required
              issueLabel="계약금액"
              errors={fieldIssues('계약금액')}
              hints={[
                amountHint(draft.contractAmount, hasContractAmountInput, PROJECT_CURRENCY_LABELS[draft.currency]),
                contractAmountCheck.message,
              ]}
            >
              <Input
                inputMode="numeric"
                value={formatProjectAmountInput(draft.contractAmount, hasContractAmountInput)}
                onChange={(event) => updateAmount('contractAmount', event.target.value)}
                placeholder="0"
                className={cn('max-w-[220px]', FORM_NUMERIC_CONTROL_CLASS)}
              />
            </ProjectFormRow>
            <ProjectFormRow label="총매출부가세" hints={[amountHint(draft.salesVatAmount, hasSalesVatAmountInput)]}>
              <Input
                inputMode="numeric"
                value={formatProjectAmountInput(draft.salesVatAmount, hasSalesVatAmountInput)}
                onChange={(event) => updateAmount('salesVatAmount', event.target.value)}
                placeholder="0"
                className={cn('max-w-[220px]', FORM_NUMERIC_CONTROL_CLASS)}
              />
            </ProjectFormRow>
            <ProjectFormRow label="총수익" hints={[amountHint(draft.totalRevenueAmount, hasTotalRevenueAmountInput)]}>
              <Input
                inputMode="numeric"
                value={formatProjectAmountInput(draft.totalRevenueAmount, hasTotalRevenueAmountInput)}
                onChange={(event) => updateAmount('totalRevenueAmount', event.target.value)}
                placeholder="0"
                className={cn('max-w-[220px]', FORM_NUMERIC_CONTROL_CLASS)}
              />
            </ProjectFormRow>
            <ProjectFormRow label="총실비(원가)" hints={[amountHint(draft.totalActualCost, hasTotalActualCostInput)]}>
              <Input
                inputMode="numeric"
                value={formatProjectAmountInput(draft.totalActualCost, hasTotalActualCostInput)}
                onChange={(event) => updateAmount('totalActualCost', event.target.value)}
                placeholder="0"
                className={cn('max-w-[220px]', FORM_NUMERIC_CONTROL_CLASS)}
              />
            </ProjectFormRow>
            <ProjectFormRow label="총지원금" hints={[amountHint(draft.supportAmount, hasSupportAmountInput)]}>
              <Input
                inputMode="numeric"
                value={formatProjectAmountInput(draft.supportAmount, hasSupportAmountInput)}
                onChange={(event) => updateAmount('supportAmount', event.target.value)}
                placeholder="0"
                className={cn('max-w-[220px]', FORM_NUMERIC_CONTROL_CLASS)}
              />
            </ProjectFormRow>
          </>
        )}

        {/*
          총수익률은 파생값이라 표의 합계 행 `수익률` 칸이 이미 같은 값을 보여준다.
          표를 쓸 때 위에 따로 떼어 두면 어느 값의 비율인지 읽히지 않으므로 여기서는 접는다.
        */}
        {annualTotalsOwnAmounts ? null : (
          <ProjectFormRow label="총수익률" note="총수익 / 계약금액">
            <ProjectComputedValue value={profitRateLabel ? `${profitRateLabel}%` : '-'} />
          </ProjectFormRow>
        )}

        {/* 금액 표는 「계약 정보」 안에 그대로 둔다. 통화·기간과 떨어지면 무엇의 금액인지 멀어진다. */}
        {annualTotalsOwnAmounts ? (
          <div data-issue-label="계약기간 전체 연도별 재무 확인">
            {draft.financialYears.length === 0 ? (
              <p className={cn('rounded-lg border border-dashed border-slate-300 bg-white px-3 py-4', FORM_HINT_CLASS)}>
                계약 시작일과 종료일을 먼저 입력해 주세요.
              </p>
            ) : renderAnnualFinanceTable()}
          </div>
        ) : null}
      </ProjectFormSection>

      {/* 입금 계획은 금액 표와 별개 경로다. 다년도만 연도별로 쪼갠다. */}
      {annualTotalsOwnAmounts && hasMultiYearContract ? (
        <>
          {draft.financialYears.map((row, index) => (
            <ProjectFormSection key={row.year} title={`${row.year}년 입금 계획`} flushBelow>
              {renderPaymentFields(row, index)}
            </ProjectFormSection>
          ))}
          <ProjectFormRow label="기타 메모">
            <Textarea value={draft.paymentPlanDesc} onChange={(event) => update('paymentPlanDesc', event.target.value)} className={cn('min-h-[92px]', FORM_VALUE_CLASS)} />
          </ProjectFormRow>
        </>
      ) : null}

      {mode === 'admin' ? (
        <ProjectFormSection title="관리자 입력">
          <ProjectFormRow label="당해연도 예산" hints={[amountHint(draft.budgetCurrentYear, draft.budgetCurrentYear > 0)]}>
            <Input
              inputMode="numeric"
              value={formatProjectAmountInput(draft.budgetCurrentYear, draft.budgetCurrentYear > 0)}
              onChange={(event) => update('budgetCurrentYear', parseProjectAmountInput(event.target.value))}
              placeholder="0"
              className={cn('max-w-[220px]', FORM_NUMERIC_CONTROL_CLASS)}
            />
          </ProjectFormRow>
          <ProjectFormRow label="세금계산서 발행액" hints={[amountHint(draft.taxInvoiceAmount, draft.taxInvoiceAmount > 0)]}>
            <Input
              inputMode="numeric"
              value={formatProjectAmountInput(draft.taxInvoiceAmount, draft.taxInvoiceAmount > 0)}
              onChange={(event) => update('taxInvoiceAmount', parseProjectAmountInput(event.target.value))}
              placeholder="0"
              className={cn('max-w-[220px]', FORM_NUMERIC_CONTROL_CLASS)}
            />
          </ProjectFormRow>
        </ProjectFormSection>
      ) : null}


      {!hasMultiYearContract ? (
        <ProjectFormSection title="입금 계획" flushBelow>
          {renderPaymentFields()}
        </ProjectFormSection>
      ) : null}
      {/*
        정산은 계약 내용과 입금 계획을 다 넣은 뒤에 정리한다. 앞에 두었더니 아직
        아무 값도 없는 상태에서 정산 유형부터 고르게 되어 판단할 근거가 없었다.
      */}
      <ProjectFormSection title="정산">
        {/* 사업유형이 정산 기준을 결정한다. 둘을 세로로 쌓으면 그 관계가 보이지 않아 나란히 둔다. */}
      <ProjectFormRow
        label={usesRegistrationV2 ? '사업유형' : '정산 유형'}
        required={usesRegistrationV2}
        issueLabel="사업유형"
        errors={fieldIssues('사업유형')}
      >
        <Select
          value={usesRegistrationV2 && draft.settlementType === 'NONE' ? undefined : draft.settlementType}
          onValueChange={(value) => update('settlementType', value as SettlementType)}
        >
          <SelectTrigger className={cn(FIELD_W_MD, FORM_CONTROL_CLASS)}><SelectValue placeholder={usesRegistrationV2 ? '사업유형 선택' : '정산 유형 선택'} /></SelectTrigger>
          <SelectContent>
            {(Object.entries(SETTLEMENT_TYPE_LABELS) as [SettlementType, string][]).filter(([key]) => !usesRegistrationV2 || key !== 'NONE').map(([key, value]) => (
              <SelectItem key={key} value={key}>{value}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ProjectFormRow>
      {usesRegistrationV2 ? (
        <ProjectFormRow label="정산 기준">
          <Select value={draft.basis} onValueChange={(value) => update('basis', value as Basis)}>
            <SelectTrigger className={cn(FIELD_W_MD, FORM_CONTROL_CLASS)}><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.entries(BASIS_LABELS) as [Basis, string][]).filter(([key]) => usesRegistrationV2 ? key !== '기타' : key !== 'NONE').map(([key]) => (
                <SelectItem key={key} value={key}>{REGISTRATION_V2_BASIS_LABELS[key as Exclude<Basis, '기타'>]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ProjectFormRow>
      ) : draft.settlementType === 'NONE' ? (
        <p className={cn('rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-3', FORM_HINT_CLASS)}>
          정산 없음은 정산 기준·통장·정산 시스템 입력이 필요하지 않습니다.
        </p>
      ) : (
        <ProjectFormRow label="정산 기준">
          <Select value={draft.basis === 'NONE' ? undefined : draft.basis} onValueChange={(value) => update('basis', value as Basis)}>
            <SelectTrigger className={cn(FIELD_W_MD, FORM_CONTROL_CLASS)}><SelectValue placeholder="정산 기준 선택" /></SelectTrigger>
            <SelectContent>
              {(Object.entries(BASIS_LABELS) as [Basis, string][]).filter(([key]) => usesRegistrationV2 ? key !== '기타' : key !== 'NONE').map(([key, value]) => (
                <SelectItem key={key} value={key}>{value}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ProjectFormRow>
      )}
        {settlementDetailsEnabled ? (
          <>
            <ProjectFormRow label="통장 유형">
              <Select value={draft.accountType} onValueChange={(value) => update('accountType', value as AccountType)}>
                <SelectTrigger className={cn(FIELD_W_MD, FORM_CONTROL_CLASS)}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.entries(ACCOUNT_TYPE_LABELS) as [AccountType, string][]).map(([key, value]) => (
                    <SelectItem key={key} value={key}>{value}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ProjectFormRow>
            <ProjectFormRow label="이자 반납 여부">
              <Select value={draft.interestRefundPolicy || undefined} onValueChange={(value) => update('interestRefundPolicy', value as InterestRefundPolicy)}>
                <SelectTrigger className={cn(FIELD_W_MD, FORM_CONTROL_CLASS)}><SelectValue placeholder="이자 반납 여부 선택" /></SelectTrigger>
                <SelectContent>
                  {(Object.entries(INTEREST_REFUND_POLICY_LABELS) as [InterestRefundPolicy, string][]).map(([key, value]) => (
                    <SelectItem key={key} value={key}>{value}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ProjectFormRow>
            <ProjectFormRow
              label="정산 시스템"
              issueLabel="기타 정산 시스템 이름"
              errors={fieldIssues('기타 정산 시스템 이름', '기타 정산 시스템 이름은 100자 이하여야 합니다.')}
            >
              <Select
                value={draft.settlementSystem === 'OTHER' && draft.settlementSystemOther.trim() ? `OTHER:${draft.settlementSystemOther.trim()}` : draft.settlementSystem}
                onValueChange={updateSettlementSystem}
              >
                <SelectTrigger className={cn(FIELD_W_MD, FORM_CONTROL_CLASS)}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[
                    ...PROJECT_SETTLEMENT_SYSTEM_CODES,
                    ...(PROJECT_SETTLEMENT_SYSTEM_CODES.includes(draft.settlementSystem) ? [] : [draft.settlementSystem]),
                  ].map((key) => (
                    <SelectItem key={key} value={key}>{SETTLEMENT_SYSTEM_LABELS[key]}</SelectItem>
                  ))}
                  {[...settlementSystemOptions, draft.settlementSystemOther]
                    .map((value) => value.replace(/\s+/g, ' ').trim())
                    .filter((value, index, values) => value && values.findIndex((candidate) => candidate.toLocaleLowerCase('ko-KR') === value.toLocaleLowerCase('ko-KR')) === index)
                    .map((value) => (
                    <SelectItem key={`OTHER:${value}`} value={`OTHER:${value}`}>{value}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {draft.settlementSystem === 'OTHER' ? (
                <Input
                  value={draft.settlementSystemOther}
                  onChange={(event) => update('settlementSystemOther', event.target.value)}
                  placeholder="정산 시스템 이름 직접 입력"
                  aria-label="기타 정산 시스템 이름"
                  className={cn('mt-2 w-full', FORM_CONTROL_CLASS)}
                />
              ) : null}
            </ProjectFormRow>
            <ProjectFormRow label="인건비 정산 기준">
              <Select value={draft.laborSettlementBasis} onValueChange={(value) => update('laborSettlementBasis', value as LaborSettlementBasis)}>
                <SelectTrigger className={cn(FIELD_W_MD, FORM_CONTROL_CLASS)}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.entries(LABOR_SETTLEMENT_BASIS_LABELS) as [LaborSettlementBasis, string][]).map(([key, value]) => (
                    <SelectItem key={key} value={key}>{value}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ProjectFormRow>
          </>
        ) : usesRegistrationV2 ? (
          <p className={cn('rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-3', FORM_HINT_CLASS)}>
            정산 기준이 정산없음이면 통장·정산 시스템 입력이 필요하지 않습니다.
          </p>
        ) : null}
      </ProjectFormSection>
    </div>
  );

  const renderTeamStep = () => (
    <div className={FORM_SECTION_STACK_CLASS}>
      <ProjectStaffingSection
        orgId={orgId}
        actor={user}
        staffing={draft.staffing}
        onChange={(next) => update('staffing', next)}
      />
      <ProjectFormSection title="담당자와 결재자">
        <ProjectFormRow
          label="최종 보고자 (실무책임자)"
          required
          issueLabel="PM"
          errors={[
            ...fieldIssues('PM'),
            ...(hasUnlinkedStoredOwner
              ? ['현재 저장된 담당자 값이 구성원 원장에 없습니다. 원장에서 다시 선택해야 저장 후 연결됩니다.']
              : []),
          ]}
          hints={[
            <span key="owner-uid">
              구성원 원장(orgs/{'{'}orgId{'}'}/members)의 UID를 저장합니다. 프로젝트 현황과 실무자 포털 노출은 이 UID 기준으로 연결됩니다.
            </span>,
          ]}
        >
          <MemberPicker
            className={cn(FIELD_W_MD, FORM_CONTROL_CLASS)}
            options={ownerOptions}
            value={draft.registeredById}
            placeholder="구성원 원장에서 선택"
            onChange={(value) => {
              const member = ownerOptions.find((item) => item.uid === value);
              if (!member) return;
              setDraft((prev) => createProjectEditorDraft({
                ...prev,
                registeredById: member.uid,
                registeredByName: member.label.replace(' · 기존 선택', ''),
                registeredByEmail: member.email,
                managerId: member.uid,
                managerName: member.label.replace(' · 기존 선택', ''),
              }));
            }}
          />
        </ProjectFormRow>
        <ProjectFormRow
          label="최종 결재자 (총괄책임자)"
          required
          issueLabel="최종 결재자 (총괄책임자)"
          errors={[
            ...fieldIssues('최종 결재자 (총괄책임자)'),
            ...(hasUnlinkedStoredExecutiveApprover
              ? ['현재 저장된 결재자 값이 구성원 원장에 없습니다. 원장에서 다시 선택해야 저장 후 연결됩니다.']
              : []),
          ]}
          hints={['선택한 구성원이 조직장 승인 결재선의 대기 결재자로 표시됩니다.']}
        >
          <MemberPicker
            className={cn(FIELD_W_MD, FORM_CONTROL_CLASS)}
            options={executiveApproverOptions}
            value={draft.executiveApproverId}
            placeholder="구성원 원장에서 선택"
            onChange={(value) => {
              const member = executiveApproverOptions.find((item) => item.uid === value);
              if (!member) return;
              setDraft((prev) => createProjectEditorDraft({
                ...prev,
                executiveApproverId: member.uid,
                executiveApproverName: member.label.replace(' · 기존 선택', ''),
                executiveApproverEmail: member.email,
              }));
            }}
          />
        </ProjectFormRow>
      </ProjectFormSection>

      <ProjectFormSection
        title="서류상 참여인력"
        description="계약·협약서에 남길 참여인력과 역할을 저장합니다."
        action={(
          <Button type="button" onClick={syncTeamFromSheet} disabled={teamSyncing} className="gap-2">
            {teamSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {teamSyncing ? '연동 중' : '연동하기'}
          </Button>
        )}
      >
        {/* 이 섹션이 참여인력을 다루는 곳이라 시트 링크도 여기 있어야 한다. 기본 정보에 두면
            참여율을 입력하는 사람이 이 칸을 영영 만나지 못한다. 링크 저장이 곧 사업 바인딩이고,
            시트 안에는 사업 식별자를 적지 않는다 - 사람이 적는 식별자는 어긋난다. */}
        <ProjectFormRow
          label="참여율 시트 링크"
          hints={[
            '월별 참여율은 이 시트의 [참여율 관리] 탭에 적습니다. 표준양식을 복사해 이 사업 전용 시트를 만든 뒤 링크를 넣어 주세요.',
            sheetSystemAccount
              ? `만든 시트를 ${sheetSystemAccount} 에 편집자 권한으로 공유해 주세요. 공유하지 않으면 연동·명단 자동 갱신이 되지 않습니다.`
              : '만든 시트를 MYSC 시스템 계정에 편집자 권한으로 공유해야 연동·명단 자동 갱신이 됩니다.',
            '저장한 시트 내용은 참여율 연동과 사람별 참여율 집계에 사용됩니다.',
          ]}
        >
          <Input
            type="url"
            value={draft.participationSheetLink}
            onChange={(event) => update('participationSheetLink', event.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/..."
            className={FORM_CONTROL_CLASS}
          />
        </ProjectFormRow>

        <div data-issue-label={participationSyncIssue || '참여율 시트 링크'} className={FORM_FIELD_STACK_CLASS}>
          {fieldIssues('참여율 시트 링크', participationSyncIssue || '').length > 0 ? (
            <ul className={cn('space-y-1', FORM_ERROR_CLASS)} role="alert">
              {fieldIssues('참여율 시트 링크', participationSyncIssue || '').map((message) => (
                <li key={message} className="flex gap-1.5">
                  <span aria-hidden className="shrink-0">•</span>
                  <span className="min-w-0">{describeSubmitIssue(message)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {teamSyncError ? (
            <p className={cn('rounded-lg border border-red-200 bg-red-50 px-4 py-3', FORM_ERROR_CLASS)} role="alert">
              {teamSyncError}
            </p>
          ) : null}
          {teamSyncWarning ? (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="alert">
              ⚠ {teamSyncWarning}
            </p>
          ) : null}
          {teamSyncNotice ? (
            <p className={cn('rounded-lg border border-slate-200 bg-slate-50 px-4 py-3', FORM_HINT_CLASS)}>
              {teamSyncNotice}
            </p>
          ) : null}
          {teamSyncPreview ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={FORM_HINT_CLASS}>
                  {teamSyncPreview.summary?.period.start} ~ {teamSyncPreview.summary?.period.end}
                  {' · '}참여인력 {teamSyncPreview.rows.length}명
                </span>
                {/* 저장은 전체 계약기간을 유지하고, 확인 화면만 선택 연도 12개월로 자른다. */}
                <Select value={teamSyncYear} onValueChange={setTeamSyncYear}>
                  <SelectTrigger className="h-8 w-[120px] text-[13px]" aria-label="확인할 연도">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[...new Set(teamSyncPreview.months.map((month) => month.slice(0, 4)))].map((year) => (
                      <SelectItem key={year} value={year}>{year}년</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50">
                      <th className="sticky left-0 z-10 min-w-[140px] bg-slate-50 px-3 py-2 text-[12px] font-semibold text-slate-700">이름</th>
                      <th className="min-w-[110px] px-3 py-2 text-[12px] font-semibold text-slate-700">역할</th>
                      <th className="min-w-[150px] px-3 py-2 text-[12px] font-semibold text-slate-700">투입기간</th>
                      {teamSyncPreview.months.filter((month) => month.startsWith(teamSyncYear)).map((month) => (
                        <th key={month} className="min-w-[56px] px-2 py-2 text-center text-[12px] font-semibold text-slate-700">
                          {Number(month.slice(5))}월
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {teamSyncPreview.rows.map((row) => (
                      <tr key={`sheet-row-${row.rowIndex}`} className="border-b border-slate-100 last:border-b-0">
                        <td className="sticky left-0 z-10 bg-white px-3 py-2 text-[13px] font-medium text-slate-800">
                          {row.name || row.nickname || '이름 없음'}
                          {row.name && row.nickname ? <span className="ml-1 text-slate-500">({row.nickname})</span> : null}
                          {row.linkState === 'LINKED'
                            ? null
                            : <span className="ml-1 text-[11px] font-semibold text-amber-700">
                              {row.linkState === 'PLACEHOLDER' ? '사람 미정' : '연결 대기'}
                            </span>}
                        </td>
                        <td className="px-3 py-2 text-[13px] text-slate-600">{row.role || '―'}</td>
                        <td className="px-3 py-2 text-[13px] text-slate-600">
                          {row.stintStart || '미입력'} ~ {row.stintEnd || '진행 중'}
                        </td>
                        {teamSyncPreview.months.filter((month) => month.startsWith(teamSyncYear)).map((month) => {
                          const inStint = Boolean(row.stintStart)
                            && month >= row.stintStart
                            && (!row.stintEnd || month <= row.stintEnd);
                          const value = row.monthlyRates[month];
                          const hasValue = value !== undefined;
                          // 시트의 색 규칙을 그대로 옮긴다. 미입력은 빨강, 투입기간 밖은 흐리게.
                          return (
                            <td
                              key={month}
                              className={cn(
                                'px-2 py-2 text-center text-[13px] tabular-nums',
                                hasValue ? 'font-semibold text-slate-800'
                                  : inStint ? 'bg-red-50 font-semibold text-red-700' : 'text-slate-300',
                              )}
                            >
                              {hasValue ? value : inStint ? '미입력' : '―'}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className={cn('rounded-lg border border-dashed border-slate-300 bg-white px-4 py-5', FORM_HINT_CLASS)}>
              시트 링크를 넣고 연동하기를 누르면 시트 내용이 여기에 표로 나타납니다.
            </p>
          )}
        </div>
      </ProjectFormSection>
    </div>
  );

  const renderPaymentFields = (financialYear?: ProjectFinancialYear, financialYearIndex?: number) => {
    const paymentPlan = financialYear?.paymentPlan || draft.paymentPlan;
    const updatePaymentPlan = (field: keyof typeof paymentPlan, value: number) => {
      if (financialYear && financialYearIndex !== undefined) {
        updateFinancialYear(financialYearIndex, 'paymentPlan', { ...paymentPlan, [field]: value });
      } else {
        update('paymentPlan', { ...paymentPlan, [field]: value });
      }
    };
    const paymentExpectedMonths = financialYear?.paymentExpectedMonths || draft.paymentExpectedMonths;
    const updatePaymentExpectedMonth = (field: keyof ProjectPaymentExpectedMonths, value: string) => {
      if (financialYear && financialYearIndex !== undefined) {
        updateFinancialYear(financialYearIndex, 'paymentExpectedMonths', { ...paymentExpectedMonths, [field]: value });
      } else {
        update('paymentExpectedMonths', { ...paymentExpectedMonths, [field]: value });
      }
    };
    const yearAdvanceInterimRatio = financialYear && financialYear.contractAmount > 0
      ? (paymentPlan.contract + paymentPlan.interim) / financialYear.contractAmount
      : null;
    const requiresYearAdvanceInterimReason = financialYear
      && paymentPlan.contract + paymentPlan.interim + paymentPlan.final > 0
      && yearAdvanceInterimRatio !== null
      && yearAdvanceInterimRatio < 0.7;
    const yearPrefix = financialYear ? `${financialYear.year}년 ` : '';
    const paymentRows = [
      ['contract', '선금/계약금', financialYear ? `${financialYear.year}년 선금/계약금 예상 입금 시점` : '선금/계약금 입금 예상월'],
      ['interim', '중도금', financialYear ? `${financialYear.year}년 중도금 예상 입금 시점` : '중도금 입금 예상월'],
      ['final', '잔금', financialYear ? `${financialYear.year}년 잔금 예상 입금 시점` : '잔금 입금 예상월'],
    ] as const;
    const paymentBase = financialYear?.contractAmount || draft.contractAmount;
    const paymentSum = paymentPlan.contract + paymentPlan.interim + paymentPlan.final;
    const koreanPaymentSum = formatKoreanAmountUnit(paymentSum);
    const advanceRatio = financialYear ? yearAdvanceInterimRatio : advanceInterimRatio;
    const missingMonths = fieldIssues(...paymentRows.map(([, , issueLabel]) => issueLabel));
    return (
    <div className={FORM_FIELD_STACK_CLASS}>
      {/* 금액과 예상 입금 시점이 같은 행에 있어야 "얼마를 언제"가 한 눈에 붙는다.
          라벨은 헤더에 한 번만 나오고, 합계 행이 표의 결론이다. */}
      <div className="space-y-2">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr className="border-y border-slate-200 bg-slate-50">
                <th scope="col" className={cn('py-2 pr-3', FORM_LABEL_CLASS)}>구분</th>
                <th scope="col" className={cn('px-3 py-2 text-right', FORM_LABEL_CLASS)}>금액 (원)</th>
                <th scope="col" className={cn('px-3 py-2 text-right', FORM_LABEL_CLASS)}>계약금액 대비</th>
                <th scope="col" className={cn('px-3 py-2', FORM_LABEL_CLASS)}>예상 입금 시점</th>
              </tr>
            </thead>
            <tbody>
              {paymentRows.map(([field, label, issueLabel]) => (
                <tr key={field} className="border-b border-slate-100" data-issue-label={issueLabel}>
                  <th scope="row" className={cn('whitespace-nowrap py-2 pr-3 text-slate-900', FORM_LABEL_CLASS)}>{label}</th>
                  <td className="px-3 py-2">
                    <Input
                      aria-label={`${yearPrefix}${label} 금액`}
                      value={formatProjectAmountInput(paymentPlan[field], true)}
                      onChange={(event) => updatePaymentPlan(field, parseProjectAmountInput(event.target.value))}
                      className={cn('min-w-[130px]', FORM_NUMERIC_CONTROL_CLASS)}
                    />
                  </td>
                  <td className={cn('whitespace-nowrap px-3 py-2 text-right text-slate-600', FORM_NUMERIC_VALUE_CLASS)}>
                    {formatPaymentPlanAmount(paymentPlan[field], paymentBase)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <Input
                        type="month"
                        aria-label={`${yearPrefix}${label} 예상 입금 시점`}
                        aria-required={paymentPlan[field] > 0}
                        value={paymentExpectedMonths[field]}
                        onChange={(event) => updatePaymentExpectedMonth(field, event.target.value)}
                        className={cn('min-w-[150px]', FORM_CONTROL_CLASS)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
              <tr className="bg-slate-100">
                <th scope="row" className={cn('py-2.5 pr-3 text-slate-900', FORM_LABEL_CLASS)}>합계</th>
                <td className={cn('px-3 py-2.5 text-right font-semibold text-[#0176D3]', FORM_NUMERIC_VALUE_CLASS)}>
                  {fmtKRW(paymentSum)}
                </td>
                <td className={cn('whitespace-nowrap px-3 py-2.5 text-right text-slate-600', FORM_NUMERIC_VALUE_CLASS)}>
                  {advanceRatio === null ? '-' : `선금+중도금 ${(advanceRatio * 100).toFixed(1)}%`}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        <ul className={cn('space-y-1', FORM_HINT_CLASS)}>
          <li className="flex gap-1.5">
            <span aria-hidden>·</span>
            <span>입금 합계 {koreanPaymentSum || '0 원'}</span>
          </li>
        </ul>
        {missingMonths.length > 0 || requiresYearAdvanceInterimReason || (!financialYear && requiresAdvanceInterimReason) ? (
          <ul className={cn('space-y-1', FORM_ERROR_CLASS)} role="alert">
            {missingMonths.map((message) => (
              <li key={message} className="flex gap-1.5">
                <span aria-hidden>·</span>
                <span>{describeSubmitIssue(message)}</span>
              </li>
            ))}
            {requiresYearAdvanceInterimReason || (!financialYear && requiresAdvanceInterimReason) ? (
              <li className="flex gap-1.5">
                <span aria-hidden>·</span>
                <span>선금+중도금이 70% 미만이라 사유가 필요합니다.</span>
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
      {requiresYearAdvanceInterimReason ? (
        <ProjectFormRow
          label={`${financialYear.year}년 선금·중도금 합계 70% 미만 사유`}
          required
          issueLabel="선금·중도금 70% 미만 사유"
        >
          <Textarea
            value={financialYear.advanceInterimBelow70Reason || ''}
            onChange={(event) => updateFinancialYear(financialYearIndex!, 'advanceInterimBelow70Reason', event.target.value)}
            placeholder="고객사 지급 조건 등 70% 미만인 이유를 입력"
            className={cn('min-h-[72px]', FORM_VALUE_CLASS)}
          />
        </ProjectFormRow>
      ) : null}
      {!financialYear && requiresAdvanceInterimReason ? (
        <ProjectFormRow
          label="선금·중도금 합계 70% 미만 사유"
          required
          issueLabel="선금·중도금 70% 미만 사유"
          errors={fieldIssues('선금·중도금 70% 미만 사유')}
        >
          <Textarea
            value={draft.advanceInterimBelow70Reason}
            onChange={(event) => update('advanceInterimBelow70Reason', event.target.value)}
            placeholder="고객사 지급 조건 등 70% 미만인 이유를 입력"
            className={cn('min-h-[72px]', FORM_VALUE_CLASS)}
          />
        </ProjectFormRow>
      ) : null}
      {!financialYear ? (
        <ProjectFormRow label="기타 메모">
          <Textarea
            value={draft.paymentPlanDesc}
            onChange={(event) => update('paymentPlanDesc', event.target.value)}
            placeholder="예: 검수 완료 후 세금계산서 발행, 발행일로부터 14일 이내 입금"
            className={cn('min-h-[92px]', FORM_VALUE_CLASS)}
          />
        </ProjectFormRow>
      ) : null}
      {showProjectCheckout ? (
        <ProjectFormSection
          title="종료사업 체크아웃"
          description="완료 프로젝트의 입금·잔액·증빙·USB 인계를 확인합니다."
        >
          {([
            ['finalPaymentReceived', '최종 잔금 입금을 확인했습니다.'],
            ['bankBalanceZero', '프로젝트 계좌 잔액을 0원으로 정리했습니다.'],
            ['performanceCertificateReceived', '실적증명 원본 5부 이상을 제출했거나 전자 플랫폼 업로드를 완료했습니다.'],
            ['taxInvoiceEvidenceConfirmed', '발행된 세금계산서가 있어 전체 PDF를 첨부해야 합니다.'],
            ...(requiresSettlementConfirmations
              ? [['finalSettlementReportConfirmed', '회계사 최종 정산보고서가 있어 PDF를 첨부해야 합니다.'] as const]
              : []),
          ] as const).map(([field, label]) => (
            <label key={field} className={cn('flex items-center gap-2 text-slate-700', FORM_VALUE_CLASS)}>
              <Checkbox
                checked={draft.checkout[field]}
                onCheckedChange={(checked) => update('checkout', { ...draft.checkout, [field]: checked === true })}
              />
              {label}
            </label>
          ))}
          <label className={cn('flex items-center gap-2 text-slate-700', FORM_VALUE_CLASS)}>
            <Checkbox
              checked={draft.checkout.performanceCertificateDocumentApplicable === true}
              onCheckedChange={(checked) => update('checkout', {
                ...draft.checkout,
                performanceCertificateDocumentApplicable: checked === true,
              })}
            />
            고객사가 발급한 실적증명 PDF가 있어 첨부해야 합니다.
          </label>
          {onProjectDocumentFileUpload ? (
            <div className="space-y-3 pt-1">
              {checkoutDocumentKinds.map((kind) => renderProjectDocumentUpload(kind))}
            </div>
          ) : null}
          {requiresSettlementConfirmations ? (
            <>
              <label className={cn('flex items-center gap-2 text-slate-700', FORM_VALUE_CLASS)}>
                <Checkbox
                  checked={draft.checkout.usbEvidenceSubmitted}
                  onCheckedChange={(checked) => update('checkout', {
                    ...draft.checkout,
                    usbEvidenceSubmitted: checked === true,
                    evidenceDeletedAfterUsb: checked === true ? draft.checkout.evidenceDeletedAfterUsb : false,
                  })}
                />
                정산 종료 후 모든 정산 자료를 USB에 저장해 재무팀에 제출했습니다.
              </label>
              <label className={cn('flex items-center gap-2 text-slate-700', FORM_VALUE_CLASS)}>
                <Checkbox
                  checked={draft.checkout.evidenceDeletedAfterUsb}
                  disabled={!draft.checkout.usbEvidenceSubmitted}
                  onCheckedChange={(checked) => update('checkout', {
                    ...draft.checkout,
                    evidenceDeletedAfterUsb: checked === true,
                  })}
                />
                사용 내역은 유지하고 증빙 파일을 삭제했습니다.
              </label>
            </>
          ) : null}
        </ProjectFormSection>
      ) : null}
    </div>
    );
  };

  const registrationDocumentReviewItems = [
    { number: 1, label: '계약서', value: draft.contractDocument?.name || '미첨부' },
    { number: 2, label: '고객사 사업자등록증', value: draft.customerBusinessRegistrationDocument?.name || '미첨부' },
    { number: 3, label: '산출내역서(견적서)', value: draft.quoteDocument?.name || (draft.quoteSubmissionDeferred ? '이후 제출(예외 처리)' : '미첨부') },
    {
      number: 4,
      label: '제안서(워드)',
      value: draft.proposalWordOriginalDocument?.name || '미첨부',
    },
    {
      number: 5,
      label: '제안서 PPT 링크(구글드라이브 링크)',
      value: draft.registrationConfirmations.proposalPptOriginal || draft.proposalPptOriginalDocument?.name || '미입력',
    },
    {
      number: 6,
      label: '발표자료(구글드라이브 링크)',
      value: draft.registrationConfirmations.presentationPptOriginal || draft.presentationPptOriginalDocument?.name || '미입력',
    },
    { number: 7, label: 'RFP', value: draft.rfpRequestEvidenceDocument?.name || '미첨부' },
  ];

  const ReviewRow = ({ label, value, stacked = false }: { label: string; value: ReactNode; stacked?: boolean }) => (
    <div className={cn(
      'border-b border-border/50 last:border-0',
      stacked ? 'py-3' : 'flex items-start justify-between gap-3 py-2',
    )}>
      <span className={cn('shrink-0', FORM_LABEL_CLASS)}>{label}</span>
      <div className={cn(
        'whitespace-pre-line font-medium text-slate-900',
        FORM_NUMERIC_VALUE_CLASS,
        stacked ? 'mt-2 w-full text-left' : 'text-right',
      )}>
        {value || '-'}
      </div>
    </div>
  );

  const renderReviewStep = () => (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <Card className="shadow-none lg:col-start-1 lg:row-start-1 lg:self-start">
          <CardHeader className="pb-2"><CardTitle className={FORM_SECTION_CLASS}>기본 정보</CardTitle></CardHeader>
          <CardContent>
            <ReviewRow label="담당조직(CIC)" value={draft.department} />
            <ReviewRow label="공식 계약명" value={draft.officialContractName} />
            <ReviewRow label="프로젝트명" value={draft.name} />
            <ReviewRow label="프로젝트 유형" value={PROJECT_TYPE_LABELS[draft.type]} />
            <ReviewRow label="계약서 유형" value={normalizeProjectContractType(draft.contractType)} />
            <ReviewRow label="계약 대상" value={draft.clientOrg} />
            <ReviewRow label="사업관리 구글폴더링크" value={draft.businessManagementGoogleFolderLink} />
            <ReviewRow label="프로젝트 목적" value={draft.projectPurpose} />
            <ReviewRow label="프로젝트 주요 내용" value={draft.description} />
            {canEditProjectStatus(mode) ? (
              <>
                <ReviewRow label="프로젝트 진행 상태" value={PROJECT_STATUS_LABELS[draft.status]} />
                {isAdminMode(mode) ? <ReviewRow label="프로젝트 구분" value={PROJECT_PHASE_LABELS[draft.phase]} /> : null}
              </>
            ) : null}
          </CardContent>
        </Card>
        <Card className="shadow-none lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:self-start">
          <CardHeader className="pb-2"><CardTitle className={FORM_SECTION_CLASS}>계약/재무</CardTitle></CardHeader>
          <CardContent>
            <ReviewRow label="기간" value={`${draft.contractStart || '-'} ~ ${draft.contractEndUndecided ? '종료 기간 없음' : draft.contractEnd || '-'}`} />
            <ReviewRow label="통화" value={PROJECT_CURRENCY_LABELS[draft.currency]} />
            <ReviewRow label="계약금액" value={formatStoredProjectAmount(draft.contractAmount, financialInputFlags.contractAmount)} />
            <ReviewRow label="총매출부가세" value={formatStoredProjectAmount(draft.salesVatAmount, financialInputFlags.salesVatAmount)} />
            <ReviewRow label="총수익" value={formatStoredProjectAmount(draft.totalRevenueAmount, financialInputFlags.totalRevenueAmount)} />
            <ReviewRow label="총실비(원가)" value={formatStoredProjectAmount(draft.totalActualCost, financialInputFlags.totalActualCost)} />
            <ReviewRow label="총지원금" value={formatStoredProjectAmount(draft.supportAmount, financialInputFlags.supportAmount)} />
            <ReviewRow label="총수익률" value={profitRateLabel ? `${profitRateLabel}%` : '-'} />
            <ReviewRow label={usesRegistrationV2 ? '사업유형' : '정산 유형'} value={SETTLEMENT_TYPE_LABELS[draft.settlementType]} />
            {usesRegistrationV2 && hasMultiYearContract ? (
              <ReviewRow label="정산 기준" value={REGISTRATION_V2_BASIS_LABELS[draft.basis as Exclude<Basis, '기타'>]} />
            ) : settlementDetailsEnabled ? (
              <ReviewRow label="정산 기준" value={draft.basis === 'NONE' ? '-' : BASIS_LABELS[draft.basis]} />
            ) : null}
            {settlementDetailsEnabled ? (
              <>
                <ReviewRow label="통장 유형" value={ACCOUNT_TYPE_LABELS[draft.accountType]} />
                <ReviewRow label="이자 반납 여부" value={draft.interestRefundPolicy ? INTEREST_REFUND_POLICY_LABELS[draft.interestRefundPolicy] : '-'} />
                <ReviewRow label="정산 시스템" value={draft.settlementSystem === 'OTHER' ? draft.settlementSystemOther : SETTLEMENT_SYSTEM_LABELS[draft.settlementSystem]} />
                <ReviewRow label="인건비 정산 기준" value={LABOR_SETTLEMENT_BASIS_LABELS[draft.laborSettlementBasis]} />
              </>
            ) : null}
            {usesRegistrationV2 ? (
              <>
                <ReviewRow
                  label="연도별 재무"
                  value={draft.financialYears.map((row) => (
                    `${row.year}년 계약 ${fmtKRW(row.contractAmount)}원 · 매출VAT ${fmtKRW(row.salesVatAmount)}원 · 총수익 ${fmtKRW(row.totalRevenueAmount)}원 · 총실비 ${fmtKRW(row.totalActualCost)}원 · 지원금 ${fmtKRW(row.supportAmount)}원 · 선금 ${fmtKRW(row.paymentPlan?.contract || 0)}원 (${row.paymentExpectedMonths?.contract || '-'}) · 중도금 ${fmtKRW(row.paymentPlan?.interim || 0)}원 (${row.paymentExpectedMonths?.interim || '-'}) · 잔금 ${fmtKRW(row.paymentPlan?.final || 0)}원 (${row.paymentExpectedMonths?.final || '-'}) · 정산 ${row.isSettled ? '완료' : '미완료'}${row.advanceInterimBelow70Reason ? ` · 70% 미만 사유 ${row.advanceInterimBelow70Reason}` : ''} · 수익률 ${(row.profitRate * 100).toFixed(2)}%${row.confirmed ? ' · 확인' : ' · 미확인'}`
                  )).join('\n')}
                />
                <ReviewRow
                  label="등록 제출서류 7종"
                  stacked
                  value={(
                    <div className="grid gap-1.5 text-left">
                      {registrationDocumentReviewItems.map((item) => (
                        <div
                          key={item.number}
                          className="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-2 rounded-md bg-slate-50 px-2.5 py-2"
                        >
                          <span className="flex h-5 w-5 items-center justify-center rounded bg-[#001e46] text-[11px] font-semibold text-white">
                            {item.number}
                          </span>
                          <div className="min-w-0">
                            <p className={FORM_LABEL_CLASS}>{item.label}</p>
                            <p className={cn('mt-1 break-words text-slate-950', FORM_VALUE_CLASS)}>{item.value}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                />
              </>
            ) : null}
          </CardContent>
        </Card>
        <Card className="shadow-none lg:col-start-1 lg:row-start-2 lg:self-start">
          <CardHeader className="pb-2"><CardTitle className={FORM_SECTION_CLASS}>팀/인력</CardTitle></CardHeader>
          <CardContent>
            <ReviewRow label="PM" value={draft.managerName} />
            <ReviewRow label="담당자 계정" value={draft.managerId || '-'} />
            <ReviewRow label="최종 결재자 (총괄책임자)" value={draft.executiveApproverName} />
            <ReviewRow label="실제 투입인력" value={formatProjectStaffingSummary(draft.staffing)} />
            <ReviewRow label="서류상 참여인력" value={teamMembersSummary} />
            <ReviewRow label="참여율 시트 링크" value={draft.participationSheetLink} />
          </CardContent>
        </Card>
        <Card className="shadow-none lg:col-start-1 lg:row-start-3 lg:self-start">
          <CardHeader className="pb-2"><CardTitle className={FORM_SECTION_CLASS}>계약/재무 입금 계획</CardTitle></CardHeader>
          <CardContent>
            <ReviewRow label="선금/계약금" value={formatPaymentPlanAmount(effectivePaymentPlan.contract, draft.contractAmount)} />
            {!hasMultiYearContract ? <ReviewRow label="선금/계약금 예상월" value={draft.paymentExpectedMonths.contract} /> : null}
            <ReviewRow label="중도금" value={formatPaymentPlanAmount(effectivePaymentPlan.interim, draft.contractAmount)} />
            {!hasMultiYearContract ? <ReviewRow label="중도금 예상월" value={draft.paymentExpectedMonths.interim} /> : null}
            <ReviewRow label="잔금" value={formatPaymentPlanAmount(effectivePaymentPlan.final, draft.contractAmount)} />
            {!hasMultiYearContract ? <ReviewRow label="잔금 예상월" value={draft.paymentExpectedMonths.final} /> : null}
            <ReviewRow label="선금+중도금 비율" value={advanceInterimRatio === null ? '-' : `${(advanceInterimRatio * 100).toFixed(1)}%`} />
            {requiresAdvanceInterimReason ? <ReviewRow label="70% 미만 사유" value={draft.advanceInterimBelow70Reason} /> : null}
            <ReviewRow label="기타 메모" value={draft.paymentPlanDesc} />
            {showProjectCheckout ? (
              <ReviewRow
                label="종료사업 체크아웃"
                value={`${[
                  draft.checkout.finalPaymentReceived,
                  draft.checkout.bankBalanceZero,
                  draft.checkout.performanceCertificateReceived,
                  draft.checkout.taxInvoiceEvidenceConfirmed,
                  draft.checkout.finalSettlementReportConfirmed,
                  draft.checkout.usbEvidenceSubmitted,
                  draft.checkout.evidenceDeletedAfterUsb,
                ].filter(Boolean).length}/7 확인`}
              />
            ) : null}
          </CardContent>
        </Card>
        {draft.contractDocument ? (
          <div className="lg:col-span-2">
            <ContractDocumentPreview
              document={{
                ...draft.contractDocument,
                downloadURL: documentPreviewUrls?.contract || draft.contractDocument.downloadURL,
              }}
              privateDraftAttachment={Boolean(documentPreviewStates?.contract) && !(documentPreviewUrls?.contract || draft.contractDocument.downloadURL)}
              previewState={documentPreviewStates?.contract}
              onLoadPreview={onLoadDocumentPreview ? () => onLoadDocumentPreview('contract') : undefined}
              title="계약서 원문"
              description="등록하려는 계약서가 맞는지 꼭 확인해주세요!"
              descriptionClassName="text-red-700"
            />
          </div>
        ) : null}
        {draft.quoteDocument ? (
          <div className="lg:col-span-2">
            <ContractDocumentPreview
              document={{
                ...draft.quoteDocument,
                downloadURL: documentPreviewUrls?.quote || draft.quoteDocument.downloadURL,
              }}
              privateDraftAttachment={Boolean(documentPreviewStates?.quote) && !(documentPreviewUrls?.quote || draft.quoteDocument.downloadURL)}
              previewState={documentPreviewStates?.quote}
              onLoadPreview={onLoadDocumentPreview ? () => onLoadDocumentPreview('quote') : undefined}
              title="견적서 원문"
              description="첨부한 견적서가 맞는지 확인해주세요."
            />
          </div>
        ) : null}
        {draft.proposalDocument ? (
          <div className="lg:col-span-2">
            <ContractDocumentPreview
              document={{
                ...draft.proposalDocument,
                downloadURL: documentPreviewUrls?.proposal || draft.proposalDocument.downloadURL,
              }}
              privateDraftAttachment={Boolean(documentPreviewStates?.proposal) && !(documentPreviewUrls?.proposal || draft.proposalDocument.downloadURL)}
              previewState={documentPreviewStates?.proposal}
              onLoadPreview={onLoadDocumentPreview ? () => onLoadDocumentPreview('proposal') : undefined}
              title="제안서 원문"
              description="첨부한 제안서가 맞는지 확인해주세요."
            />
          </div>
        ) : null}
        {draft.rfpRequestEvidenceDocument ? (
          <div className="lg:col-span-2">
            <ContractDocumentPreview
              document={{
                ...draft.rfpRequestEvidenceDocument,
                downloadURL: documentPreviewUrls?.rfp_request_evidence || draft.rfpRequestEvidenceDocument.downloadURL,
              }}
              privateDraftAttachment={Boolean(documentPreviewStates?.rfp_request_evidence) && !(documentPreviewUrls?.rfp_request_evidence || draft.rfpRequestEvidenceDocument.downloadURL)}
              previewState={documentPreviewStates?.rfp_request_evidence}
              onLoadPreview={onLoadDocumentPreview ? () => onLoadDocumentPreview('rfp_request_evidence') : undefined}
              title="RFP/요청 메일 증빙 원문"
              description="첨부한 RFP 또는 요청 메일 증빙이 맞는지 확인해주세요."
            />
          </div>
        ) : null}
        {draft.customerBusinessRegistrationDocument ? (
          <div className="lg:col-span-2">
            <ContractDocumentPreview
              document={{
                ...draft.customerBusinessRegistrationDocument,
                downloadURL: documentPreviewUrls?.customer_business_registration || draft.customerBusinessRegistrationDocument.downloadURL,
              }}
              privateDraftAttachment={Boolean(documentPreviewStates?.customer_business_registration) && !(documentPreviewUrls?.customer_business_registration || draft.customerBusinessRegistrationDocument.downloadURL)}
              previewState={documentPreviewStates?.customer_business_registration}
              onLoadPreview={onLoadDocumentPreview ? () => onLoadDocumentPreview('customer_business_registration') : undefined}
              title="고객사 사업자등록증 원문"
              description="첨부한 고객사 사업자등록증이 맞는지 확인해주세요."
            />
          </div>
        ) : null}
        {showProjectCheckout && draft.performanceCertificateDocument ? (
          <div className="lg:col-span-2">
            <ContractDocumentPreview
              document={{
                ...draft.performanceCertificateDocument,
                downloadURL: documentPreviewUrls?.performance_certificate || draft.performanceCertificateDocument.downloadURL,
              }}
              privateDraftAttachment={Boolean(documentPreviewStates?.performance_certificate) && !(documentPreviewUrls?.performance_certificate || draft.performanceCertificateDocument.downloadURL)}
              previewState={documentPreviewStates?.performance_certificate}
              onLoadPreview={onLoadDocumentPreview ? () => onLoadDocumentPreview('performance_certificate') : undefined}
              title="수행확인서 원문"
              description="종료사업 수행확인서 증빙입니다."
            />
          </div>
        ) : null}
        {showProjectCheckout && draft.taxInvoiceDocument ? (
          <div className="lg:col-span-2">
            <ContractDocumentPreview
              document={{
                ...draft.taxInvoiceDocument,
                downloadURL: documentPreviewUrls?.tax_invoice || draft.taxInvoiceDocument.downloadURL,
              }}
              privateDraftAttachment={Boolean(documentPreviewStates?.tax_invoice) && !(documentPreviewUrls?.tax_invoice || draft.taxInvoiceDocument.downloadURL)}
              previewState={documentPreviewStates?.tax_invoice}
              onLoadPreview={onLoadDocumentPreview ? () => onLoadDocumentPreview('tax_invoice') : undefined}
              title="세금계산서 원문"
              description="종료사업 세금계산서 증빙입니다."
            />
          </div>
        ) : null}
        {showProjectCheckout && draft.finalSettlementReportDocument ? (
          <div className="lg:col-span-2">
            <ContractDocumentPreview
              document={{
                ...draft.finalSettlementReportDocument,
                downloadURL: documentPreviewUrls?.final_settlement_report || draft.finalSettlementReportDocument.downloadURL,
              }}
              privateDraftAttachment={Boolean(documentPreviewStates?.final_settlement_report) && !(documentPreviewUrls?.final_settlement_report || draft.finalSettlementReportDocument.downloadURL)}
              previewState={documentPreviewStates?.final_settlement_report}
              onLoadPreview={onLoadDocumentPreview ? () => onLoadDocumentPreview('final_settlement_report') : undefined}
              title="최종 정산보고서 원문"
              description="종료사업 최종 정산보고서 증빙입니다."
            />
          </div>
        ) : null}
        {showProjectCheckout && draft.finalReportDocument ? (
          <div className="lg:col-span-2">
            <ContractDocumentPreview
              document={{
                ...draft.finalReportDocument,
                downloadURL: documentPreviewUrls?.final_report || draft.finalReportDocument.downloadURL,
              }}
              privateDraftAttachment={Boolean(documentPreviewStates?.final_report) && !(documentPreviewUrls?.final_report || draft.finalReportDocument.downloadURL)}
              previewState={documentPreviewStates?.final_report}
              onLoadPreview={onLoadDocumentPreview ? () => onLoadDocumentPreview('final_report') : undefined}
              title="최종 결과보고서 원문"
              description="종료사업 최종 결과보고서(원본) 증빙입니다."
            />
          </div>
        ) : null}
      </div>
      {usesRegistrationV2 ? (
        <div className={cn('rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-slate-700', FORM_VALUE_CLASS)}>
          최종 저장 후 사업관리 폴더가 자동 생성되며, 프로젝트 상세 화면에서 열 수 있습니다.
        </div>
      ) : null}
    </div>
  );

  const renderStep = () => {
    if (step.id === 'basic') return renderBasicStep();
    if (step.id === 'financial') return renderFinancialStep();
    if (step.id === 'team') return renderTeamStep();
    return renderReviewStep();
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      {embeddedInShell ? (
        onCancel ? (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" className="gap-2" onClick={requestCancel}>
              <ArrowLeft className="h-4 w-4" />
              나가기
            </Button>
          </div>
        ) : null
      ) : (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="rounded-full">{STEPS.length}단계</Badge>
              <Badge variant="outline" className="rounded-full">{mode === 'admin' ? 'Admin' : 'Portal'}</Badge>
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">{title}</h1>
            {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {onCancel ? (
            <Button variant="outline" className="gap-2" onClick={requestCancel}>
              <ArrowLeft className="h-4 w-4" />
              나가기
            </Button>
          ) : null}
        </div>
      )}

      {topSlot}

      {showCheckoutEntry && showProjectCheckout ? (
        <Button
          type="button"
          variant="outline"
          className="w-full justify-between border-[#001e46] text-[#001e46]"
          data-testid="project-checkout-entry"
          onClick={() => setStepIndex(STEPS.findIndex((item) => item.id === 'financial'))}
        >
          <span>Project Check out</span>
          <span className={FORM_HINT_CLASS}>체크리스트와 증빙 업로드 열기</span>
        </Button>
      ) : null}

      {preloadWarningVisible ? (
        <div className={cn('rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 shadow-sm', FORM_VALUE_CLASS)}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className={cn('font-semibold text-slate-950', FORM_VALUE_CLASS)}>새 버전이 배포되었습니다</p>
              <p className={cn('mt-1', FORM_HINT_CLASS)}>
                작성 중인 내용 보호를 위해 자동 새로고침은 막았습니다. 임시저장 후 새로고침하면 됩니다.
              </p>
            </div>
            {autosave?.key ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleManualAutosave()}
              >
                지금 임시저장
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {restoreCandidate ? (
        <div className={cn('rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-slate-800', FORM_VALUE_CLASS)}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className={cn('font-semibold text-slate-950', FORM_VALUE_CLASS)}>이전에 작성 중이던 임시저장이 있습니다</p>
              <p className={cn('mt-1', FORM_HINT_CLASS)}>
                {formatAutosaveTime(restoreCandidate.updatedAt) || '최근'}에 저장된 작성 내용을 불러올 수 있습니다.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={discardLocalDraft}>
                버리기
              </Button>
              <Button type="button" size="sm" onClick={restoreLocalDraft}>
                임시저장 불러오기
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="space-y-4">
      <Card className="border-slate-200/80 shadow-sm">
        <CardContent className="p-3">
          <div className={cn('mb-4 flex items-center justify-between', FORM_HINT_CLASS)}>
            <span>{stepIndex + 1} / {STEPS.length}</span>
            <span>{step.label}</span>
          </div>
          <Progress value={((stepIndex + 1) / STEPS.length) * 100} />
          {/* 원형 번호 인디케이터. 남은 필수 개수는 submitIssues 를 그대로 세어 배지로만
              얹는다(판정은 그대로). 칩을 누르면 그 단계로 이동한다. */}
          {/* 레퍼런스(RCS Biz Center 가입 흐름)와 같은 형태 - 원형 번호를 선으로 잇고
              라벨은 아래에 둔다. 남은 필수 개수는 라벨 옆 작은 숫자로만 얹는다. */}
          <ol className="mt-5 flex items-start">
            {STEPS.map((item, index) => {
              const active = index === stepIndex;
              const done = index < stepIndex;
              const remaining = stepIssueCounts[item.id];
              return (
                <li key={item.id} className="flex min-w-0 flex-1 items-start">
                  {index > 0 ? (
                    <span
                      aria-hidden
                      className={cn('mt-[13px] h-px flex-1', done || active ? 'bg-[#0176D3]' : 'bg-slate-200')}
                    />
                  ) : null}
                  <button
                    type="button"
                    aria-current={active ? 'step' : undefined}
                    onClick={() => setStepIndex(index)}
                    className="flex w-[96px] shrink-0 flex-col items-center gap-2 px-1 text-center"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'flex h-[27px] w-[27px] items-center justify-center rounded-full border text-[12px] font-bold transition-colors',
                        done && 'border-[#0176D3] bg-[#0176D3] text-white',
                        active && 'border-[#0176D3] bg-[#0176D3] text-white ring-4 ring-[#0176D3]/15',
                        !done && !active && 'border-slate-300 bg-white text-slate-400',
                      )}
                    >
                      {done ? '✓' : index + 1}
                    </span>
                    <span className={cn('flex items-center gap-1', FORM_LABEL_CLASS, active ? 'text-slate-900' : 'text-slate-500')}>
                      <span className="truncate">{item.label}</span>
                      {remaining > 0 ? (
                        <span className="font-bold text-red-600" title={`남은 필수 항목 ${remaining}개`}>{remaining}</span>
                      ) : null}
                    </span>
                  </button>
                  {index < STEPS.length - 1 ? (
                    <span
                      aria-hidden
                      className={cn('mt-[13px] h-px flex-1', index < stepIndex ? 'bg-[#0176D3]' : 'bg-slate-200')}
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>

      {/* 단계 이름은 위 칩과 진행 표시에 이미 두 번 나온다. 카드 제목까지 두면 같은 말이
          섹션 제목 바로 위에서 세 번 반복되므로, 카드 안에서는 섹션 제목만 남긴다. */}
      <Card className="border-slate-200/90 shadow-sm">
        <CardContent
          className={cn('space-y-6 pt-6', PROJECT_EDITOR_FORM_SURFACE_CLASS)}
          /*
           * 한 칸을 다 넣고 Enter 를 누르면 다음 입력으로 넘어간다. 숫자를 연달아 넣는
           * 화면이라 손이 Tab 보다 Enter 로 간다. 판정은 form-advance-on-enter 가 한다
           * (textarea · 한글 조합 중 · 셀렉트 · 수식 키는 건드리지 않는다).
           */
          onKeyDown={(event) => {
            if (!shouldAdvanceOnEnter(event)) return;
            const moved = advanceFocusToNextInput(event.currentTarget, event.target as HTMLInputElement);
            if (moved) event.preventDefault();
          }}
        >
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <p className={FORM_LABEL_CLASS}>이 단계에서 준비할 것</p>
            <ul className={cn('mt-2 space-y-1', FORM_HINT_CLASS)}>
              {STEP_PREPARATION_NOTES[step.id].map((note) => (
                <li key={note} className="flex gap-1.5">
                  <span aria-hidden className="shrink-0">•</span>
                  <span className="min-w-0">{note}</span>
                </li>
              ))}
            </ul>
          </div>
          <fieldset disabled={readOnly} className="contents">
            {renderStep()}
          </fieldset>
        </CardContent>
      </Card>
      </div>

      <div className="z-20 rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
        {stepIndex === STEPS.length - 1 && !readOnly ? (
          <div className="mb-3 empty:mb-0">{renderSubmitBlockers()}</div>
        ) : null}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className={cn('flex items-center gap-2', FORM_HINT_CLASS)}>
            <CalendarRange className="h-4 w-4" />
            <span>{draft.contractStart || '-'} ~ {draft.contractEndUndecided ? '종료 기간 없음' : draft.contractEnd || '-'}</span>
            <span className="hidden lg:inline">·</span>
            <span className="hidden lg:inline">{draft.name || '프로젝트명 미입력'}</span>
            {autosave?.key ? (
              <>
                <span className="hidden lg:inline">·</span>
                <span className={autosaveState === 'error' ? 'text-red-600' : 'text-muted-foreground'}>
                  {autosaveState === 'saving'
                    ? '임시저장 중'
                    : autosaveState === 'saved'
                      ? `임시저장됨${lastAutosavedAt ? ` ${formatAutosaveTime(lastAutosavedAt)}` : ''}`
                      : autosaveState === 'error'
                        ? '임시저장 실패'
                        : '임시저장 대기'}
                </span>
              </>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {autosave?.key ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleManualAutosave()}
                disabled={readOnly || autosaveState === 'saving' || uploadInProgress || hasPendingRetryFile || (mode === 'portal-register' && !hasRequiredRegistrationDocuments)}
                className="gap-2"
              >
                {autosaveState === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                임시저장
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={() => setStepIndex((value) => Math.max(0, value - 1))}
              disabled={stepIndex === 0}
              className="gap-2"
            >
              <ArrowLeft className="h-4 w-4" />
              이전
            </Button>
            {stepIndex < STEPS.length - 1 ? (
              <Button type="button" onClick={() => setStepIndex((value) => Math.min(STEPS.length - 1, value + 1))} className="gap-2">
                다음
                <ArrowRight className="h-4 w-4" />
              </Button>
            ) : (
              actions.map((action) => {
                const Icon = action.icon || CheckCircle2;
                return (
                  <Button
                    key={action.id}
                    type="button"
                    variant={action.variant || 'default'}
                    disabled={readOnly || !!busyActionId || action.disabled}
                    onClick={() => {
                      if (submitBlocked) {
                        setSubmitBlockedNotice(true);
                        return;
                      }
                      void handleActionSubmit(action.id);
                    }}
                    className="gap-2"
                  >
                    <Icon className={`h-4 w-4 ${busyActionId === action.id ? 'animate-spin' : ''}`} />
                    {busyActionId === action.id ? '저장 중...' : action.label}
                  </Button>
                );
              })
            )}
          </div>
        </div>
      </div>

      <AlertDialog
        open={exitDialogOpen}
        onOpenChange={(open) => {
          if (open || exitBusy) return;
          setExitDialogOpen(false);
          setExitIntent(null);
          if (blocker.state === 'blocked') blocker.reset();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>수정 세션을 종료할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              {shouldBlockNavigation
                ? '작성 중인 내용과 첨부 상태를 확인한 뒤 종료 방법을 선택해 주세요.'
                : '페이지를 이동하면 현재 프로젝트의 수정 선점이 종료됩니다.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={exitBusy}>계속 작성</AlertDialogCancel>
            <Button
              type="button"
              variant="outline"
              disabled={exitBusy}
              onClick={() => void finishExit(false)}
            >
              저장하지 않고 종료
            </Button>
            <AlertDialogAction
              disabled={exitBusy || uploadInProgress || hasPendingRetryFile}
              onClick={(event) => {
                event.preventDefault();
                void finishExit(true);
              }}
            >
              임시저장 후 종료
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
