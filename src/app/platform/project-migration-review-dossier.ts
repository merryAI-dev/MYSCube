import {
  ACCOUNT_TYPE_LABELS,
  BASIS_LABELS,
  LABOR_SETTLEMENT_BASIS_LABELS,
  normalizeLaborSettlementBasis,
  normalizeSettlementSystemCode,
  SETTLEMENT_SYSTEM_LABELS,
  normalizeAccountType,
  normalizeBasis,
  normalizeProjectContractType,
  normalizeProjectCurrency,
  normalizeProjectFundInputMode,
  normalizeProjectType,
  normalizeSettlementType,
  PROJECT_FUND_INPUT_MODE_LABELS,
  PROJECT_CURRENCY_LABELS,
  PROJECT_TYPE_LABELS,
  type ProjectExecutiveReviewStatus,
  type ProjectExecutiveReviewHistoryEntry,
  SETTLEMENT_TYPE_LABELS,
  type Project,
  type ProjectRequest,
} from '../data/types';
import {
  formatProjectTeamMemberLine,
  normalizeProjectTeamMembers,
} from './project-team-members';
import { getMigrationAuditStatusLabel } from './project-migration-console';
import { resolveProjectRequestKind, resolveProjectRequestPayload } from './project-change-request';
import { formatProjectStaffingSummary } from './project-editor';

export interface MigrationReviewDossier {
  headerTitle: string;
  identity: {
    clientOrg: string;
    cic: string;
    pmName: string;
    department: string;
    officialContractName: string;
    groupwareName: string;
  };
  contract: {
    projectTypeLabel: string;
    periodLabel: string;
    contractType: string;
    settlementTypeLabel: string;
    basisLabel: string;
    accountTypeLabel: string;
    fundInputModeLabel: string;
    settlementSystemLabel: string;
    laborSettlementBasisLabel: string;
  };
  budget: {
    currencyLabel: string;
    contractAmountLabel: string;
    salesVatAmountLabel: string;
    paymentPlanDesc: string;
    paymentPlanSplitLabel: string;
    finalPaymentNote: string;
    totalRevenueAmountLabel: string;
    supportAmountLabel: string;
    advanceInterimBelow70Reason: string;
    finalPaymentExpectedWeek: string;
  };
  people: {
    teamName: string;
    members: string[];
    staffingSummary: string;
    participationSheetLink: string;
  };
  notes: {
    description: string;
    projectPurpose: string;
    participantCondition: string;
    note: string;
  };
  audit: {
    requestSummary: string;
    requestVersion: string;
    requestedByName: string;
    requestedAt: string;
    requestUpdatedAt: string;
    reviewedByName: string;
    reviewedAt: string;
    reviewComment: string;
    history: Array<{
      status: ProjectExecutiveReviewStatus;
      statusLabel: string;
      reviewedByName: string;
      reviewedAt: string;
      reviewComment: string;
      changes: Array<{
        key: string;
        label: string;
        before: string;
        after: string;
      }>;
    }>;
  };
  changes: Array<{
    key: string;
    label: string;
    before: string;
    after: string;
  }>;
  analysis: {
    summary: string;
    warnings: string[];
    nextActions: string[];
  };
  contractDocument: {
    name: string;
    downloadURL: string;
    uploadedAt: string;
  };
  submittedFields: Array<{
    key: string;
    label: string;
    value: string;
    wide: boolean;
    missing: boolean;
  }>;
  missingSubmittedFields: string[];
}

const REQUEST_FIELD_LABELS: Record<string, string> = {
  name: '프로젝트명', officialContractName: '공식 계약명', type: '프로젝트 유형', status: '프로젝트 상태', phase: '프로젝트 단계',
  description: '상세 설명', clientOrg: '계약 대상', businessManagementGoogleFolderLink: '사업관리 구글 드라이브',
  participationSheetLink: '참여율 시트 링크', staffing: '실제 투입인력', department: '담당조직',
  currency: '통화', contractAmount: '계약금액', salesVatAmount: '매출부가세', totalRevenueAmount: '총수익',
  totalActualCost: '총실비(원가)', supportAmount: '총지원금', financialInputFlags: '재무 입력 상태', registrationRequirementsVersion: '등록 양식 버전',
  financialYears: '연도별 계약·재무', registrationConfirmations: '등록 확인 사항', registrationOptionalDocumentNotes: '선택 증빙 메모', checkout: '종료 확인 사항',
  contractStart: '계약 시작일', contractEnd: '계약 종료일', contractType: '계약서 유형', settlementType: '정산 유형', basis: '정산 기준',
  accountType: '통장 유형', interestRefundPolicy: '이자 반납 여부', settlementSystem: '정산 시스템', settlementSystemOther: '기타 정산 시스템',
  laborSettlementBasis: '인건비 정산 기준', fundInputMode: '자금 입력 방식', settlementSheetPolicy: '현금흐름 시트 정책', paymentPlan: '입금 분할',
  paymentExpectedMonths: '입금 예정월', finalPaymentExpectedWeek: '잔금 입금 예정 주차', laborTransferPlan: '인건비 이관 계획', advanceInterimBelow70Reason: '선금·중도금 70% 미만 사유',
  paymentPlanDesc: '입금 계획 메모', settlementGuide: '정산 가이드', finalPaymentNote: '잔금 메모', projectPurpose: '프로젝트 목적',
  registeredById: '등록자 ID', registeredByName: '등록자', registeredByEmail: '등록자 이메일', executiveApproverId: '조직장 ID', executiveApproverName: '조직장',
  executiveApproverEmail: '조직장 이메일', managerId: '책임자 ID', managerName: '책임자', teamName: '팀명', teamMembers: '팀원 요약',
  teamMembersDetailed: '팀원·참여율 상세', participantCondition: '참여 조건', note: '등록 메모', contractDocument: '계약서', quoteDocument: '견적서',
  quoteSubmissionDeferred: '견적서 추후 제출', proposalDocument: '제안서', proposalWordOriginalDocument: '제안서 원본(워드)', proposalPptOriginalDocument: '제안서 원본(PPT)',
  presentationPptOriginalDocument: '발표자료 원본(PPT)', rfpRequestEvidenceDocument: 'RFP·요청 근거', customerBusinessRegistrationDocument: '계약 대상 사업자등록증',
  performanceCertificateDocument: '수행실적증명서', taxInvoiceDocument: '세금계산서', finalSettlementReportDocument: '최종 정산 보고서', contractAnalysis: '계약서 분석',
};

function formatSubmittedValue(value: unknown): string {
  if (value == null || value === '') return '미입력';
  if (typeof value === 'boolean') return value ? '예' : '아니오';
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString('ko-KR') : '미입력';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length ? value.map(formatSubmittedValue).join('\n') : '미입력';
  if (typeof value === 'object') {
    const rows = Object.entries(value as Record<string, unknown>);
    return rows.length
      ? rows.map(([key, item]) => `${REQUEST_FIELD_LABELS[key] || key}: ${formatSubmittedValue(item)}`).join('\n')
      : '미입력';
  }
  return String(value);
}

function buildSubmittedFields(request: ProjectRequest | null) {
  const payload = resolveProjectRequestPayload(request);
  if (!payload) return [{ key: 'payload', label: '제출 원문', value: '요청 문서가 없습니다.', wide: true, missing: true }];
  // 위저드에서 걷어낸 레거시 필드는 결재 문서에 그리지 않는다.
  const hiddenKeys = new Set(['groupwareName']);
  const keys = [...Object.keys(REQUEST_FIELD_LABELS), ...Object.keys(payload).filter((key) => !(key in REQUEST_FIELD_LABELS))]
    .filter((key) => !hiddenKeys.has(key));
  return keys.map((key) => {
    const value = (payload as unknown as Record<string, unknown>)[key];
    const formatted = key === 'staffing' ? formatProjectStaffingSummary(value) : formatSubmittedValue(value);
    return {
      key,
      label: REQUEST_FIELD_LABELS[key] || key,
      value: formatted,
      wide: true,
      missing: formatted === '미입력',
    };
  });
}

function readable(value: string | null | undefined, fallback = '-') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function formatStoredProjectAmount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${Number(value).toLocaleString('ko-KR')}원`;
}

function formatDate(value: string | null | undefined): string {
  const normalized = readable(value, '');
  if (!normalized) return '-';
  return normalized.slice(0, 10).replace(/-/g, '.');
}

function formatDateTime(value: string | null | undefined): string {
  const normalized = readable(value, '');
  if (!normalized) return '-';
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(normalized));
  } catch {
    return normalized;
  }
}

function formatPaymentPlanSplit(
  plan: Project['paymentPlan'] | ProjectRequest['payload']['paymentPlan'] | null | undefined,
  contractAmount: number | null | undefined,
): string {
  if (!plan) return '-';
  const normalizedContractAmount = Number(contractAmount);
  const entries = [
    ['선금/계약금', plan.contract],
    ['중도금', plan.interim],
    ['잔금', plan.final],
  ] as const;
  const label = entries
    .filter(([, value]) => Number.isFinite(Number(value)))
    .map(([name, value]) => {
      const amount = Number(value);
      const percent = Number.isFinite(normalizedContractAmount) && normalizedContractAmount > 0
        ? ` (${((amount / normalizedContractAmount) * 100).toFixed(0)}%)`
        : '';
      return `${name} ${amount.toLocaleString('ko-KR')}원${percent}`;
    })
    .join(' · ');
  return label || '-';
}

function buildAuditHistory(project: Project, request: ProjectRequest | null) {
  const history = Array.isArray(project.executiveReviewHistory) ? project.executiveReviewHistory : [];
  if (history.length > 0) {
    return [...history]
      .sort((left, right) => String(right.reviewedAt || '').localeCompare(String(left.reviewedAt || '')))
      .map((entry: ProjectExecutiveReviewHistoryEntry) => ({
        status: entry.status,
        statusLabel: getMigrationAuditStatusLabel(entry.status),
        reviewedByName: readable(entry.reviewedByName),
        reviewedAt: formatDate(entry.reviewedAt),
        reviewComment: readable(entry.reviewComment),
        changes: normalizeReviewChanges(entry.changes),
      }));
  }

  const fallbackStatus = project.executiveReviewStatus || request?.reviewOutcome;
  const fallbackReviewedAt = project.executiveReviewedAt || request?.reviewedAt;
  const fallbackReviewedByName = project.executiveReviewedByName || request?.reviewedByName;
  const fallbackReviewComment = project.executiveReviewComment || request?.reviewComment || request?.rejectedReason;
  if (!fallbackStatus && !fallbackReviewedAt && !fallbackReviewedByName && !fallbackReviewComment) {
    return [];
  }

  const status = (fallbackStatus || 'PENDING') as ProjectExecutiveReviewStatus;
  return [{
    status,
    statusLabel: getMigrationAuditStatusLabel(status),
    reviewedByName: readable(fallbackReviewedByName),
    reviewedAt: formatDate(fallbackReviewedAt),
    reviewComment: readable(fallbackReviewComment),
    changes: [],
  }];
}

function normalizeReviewChanges(value: ProjectExecutiveReviewHistoryEntry['changes']) {
  return (Array.isArray(value) ? value : [])
    .map((change) => ({
      key: readable(change?.key, 'change'),
      label: readable(change?.label, '변경 항목'),
      before: readable(change?.before),
      after: readable(change?.after),
    }))
    .filter((change) => change.before !== change.after);
}

function findLatestReviewChanges(history: ReturnType<typeof buildAuditHistory>) {
  return history.find((entry) => entry.changes.length > 0)?.changes || [];
}

function readReviewChangesFromRequest(request: ProjectRequest | null) {
  return normalizeReviewChanges(request?.changedFields);
}

function preferRequestPayloadForChange<T>(
  request: ProjectRequest | null,
  projectValue: T,
  payloadValue: T | undefined,
): T | undefined {
  return resolveProjectRequestKind(request) === 'CHANGE'
    ? (payloadValue ?? projectValue)
    : (projectValue ?? payloadValue);
}

/**
 * A pending change request is the source of truth while it is being reviewed;
 * otherwise keep the registered project's contract as the primary preview.
 */
export function resolveMigrationReviewContractDocument(
  project: Project,
  request: ProjectRequest | null,
) {
  const payload = resolveProjectRequestPayload(request);
  const useRequestDocument = resolveProjectRequestKind(request) === 'CHANGE' && Boolean(payload?.contractDocument);
  return useRequestDocument
    ? (payload?.contractDocument || project.contractDocument || null)
    : (project.contractDocument || payload?.contractDocument || null);
}

export function buildMigrationReviewDossier(
  project: Project,
  request: ProjectRequest | null,
): MigrationReviewDossier {
  const payload = resolveProjectRequestPayload(request);
  const usePayloadAsCurrent = resolveProjectRequestKind(request) === 'CHANGE' && request?.status === 'PENDING';
  const contractDocument = resolveMigrationReviewContractDocument(project, request);
  const contractAnalysis = usePayloadAsCurrent
    ? (payload?.contractAnalysis || project.contractAnalysis || null)
    : (project.contractAnalysis || payload?.contractAnalysis || null);
  const currentName = preferRequestPayloadForChange(request, project.name, payload?.name);
  const currentOfficialContractName = preferRequestPayloadForChange(request, project.officialContractName, payload?.officialContractName);
  const currentClientOrg = preferRequestPayloadForChange(request, project.clientOrg, payload?.clientOrg);
  const currentDepartment = preferRequestPayloadForChange(request, project.department, payload?.department);
  const currentManagerName = preferRequestPayloadForChange(request, project.registeredByName || project.managerName, payload?.registeredByName || payload?.managerName);
  const currentTeamName = preferRequestPayloadForChange(request, project.teamName, payload?.teamName);
  const rawMembers = usePayloadAsCurrent && Array.isArray(payload?.teamMembersDetailed)
    ? payload?.teamMembersDetailed
    : Array.isArray(project.teamMembersDetailed)
      ? project.teamMembersDetailed
      : payload?.teamMembersDetailed;
  const members = Array.isArray(rawMembers)
    ? normalizeProjectTeamMembers(rawMembers).map(formatProjectTeamMemberLine)
    : readable(payload?.teamMembers, '')
        .split(/[,\n]/)
        .map((member) => member.trim())
        .filter(Boolean);
  const auditHistory = buildAuditHistory(project, request);
  const changes = readReviewChangesFromRequest(request).length > 0
    ? readReviewChangesFromRequest(request)
    : findLatestReviewChanges(auditHistory);

  const submittedFields = buildSubmittedFields(request);
  return {
    headerTitle: readable(currentName),
    identity: {
      clientOrg: readable(currentClientOrg),
      cic: readable(project.cic || currentDepartment),
      pmName: readable(currentManagerName),
      department: readable(currentDepartment),
      officialContractName: readable(currentOfficialContractName || currentName),
      groupwareName: readable(preferRequestPayloadForChange(request, project.groupwareName, payload?.groupwareName)),
    },
    contract: {
      projectTypeLabel: PROJECT_TYPE_LABELS[normalizeProjectType(preferRequestPayloadForChange(request, project.type, payload?.type))] || readable(project.type || payload?.type),
      periodLabel: (() => {
        const start = readable(preferRequestPayloadForChange(request, project.contractStart, payload?.contractStart));
        const openEnded = (usePayloadAsCurrent ? payload?.contractEndUndecided : (project.contractEndUndecided ?? payload?.contractEndUndecided)) === true;
        const end = readable(preferRequestPayloadForChange(request, project.contractEnd, payload?.contractEnd));
        // 종료 기간 없음(명시 플래그)은 미입력('-')과 다른 상태라 다르게 적는다.
        return `${start} ~ ${openEnded ? '종료 기간 없음' : end}`;
      })(),
      contractType: readable(normalizeProjectContractType(preferRequestPayloadForChange(request, project.contractType, payload?.contractType))),
      settlementTypeLabel: SETTLEMENT_TYPE_LABELS[normalizeSettlementType(preferRequestPayloadForChange(request, project.settlementType, payload?.settlementType))] || '-',
      basisLabel: BASIS_LABELS[normalizeBasis(preferRequestPayloadForChange(request, project.basis, payload?.basis))] || '-',
      accountTypeLabel: ACCOUNT_TYPE_LABELS[normalizeAccountType(preferRequestPayloadForChange(request, project.accountType, payload?.accountType))] || '-',
      fundInputModeLabel: PROJECT_FUND_INPUT_MODE_LABELS[normalizeProjectFundInputMode(preferRequestPayloadForChange(request, project.fundInputMode, payload?.fundInputMode))] || '-',
      settlementSystemLabel: (() => {
        const code = normalizeSettlementSystemCode(preferRequestPayloadForChange(request, project.settlementSystem, payload?.settlementSystem));
        if (code === 'OTHER') {
          const other = readable(preferRequestPayloadForChange(request, project.settlementSystemOther, payload?.settlementSystemOther), '');
          return other ? `기타 · ${other}` : '기타';
        }
        return SETTLEMENT_SYSTEM_LABELS[code] || '-';
      })(),
      laborSettlementBasisLabel: LABOR_SETTLEMENT_BASIS_LABELS[normalizeLaborSettlementBasis(preferRequestPayloadForChange(request, project.laborSettlementBasis, payload?.laborSettlementBasis))] || '-',
    },
    budget: {
      currencyLabel: PROJECT_CURRENCY_LABELS[normalizeProjectCurrency(preferRequestPayloadForChange(request, project.currency, payload?.currency))] || 'KRW',
      contractAmountLabel: formatStoredProjectAmount(preferRequestPayloadForChange(request, project.contractAmount, payload?.contractAmount)),
      salesVatAmountLabel: formatStoredProjectAmount(preferRequestPayloadForChange(request, project.salesVatAmount, payload?.salesVatAmount)),
      paymentPlanDesc: readable(preferRequestPayloadForChange(request, project.paymentPlanDesc, payload?.paymentPlanDesc)),
      paymentPlanSplitLabel: formatPaymentPlanSplit(
        preferRequestPayloadForChange(request, project.paymentPlan, payload?.paymentPlan),
        preferRequestPayloadForChange(request, project.contractAmount, payload?.contractAmount),
      ),
      finalPaymentNote: readable(preferRequestPayloadForChange(request, project.finalPaymentNote, payload?.finalPaymentNote)),
      totalRevenueAmountLabel: formatStoredProjectAmount(preferRequestPayloadForChange(request, project.totalRevenueAmount, payload?.totalRevenueAmount)),
      supportAmountLabel: formatStoredProjectAmount(preferRequestPayloadForChange(request, project.supportAmount, payload?.supportAmount)),
      advanceInterimBelow70Reason: readable(preferRequestPayloadForChange(request, project.advanceInterimBelow70Reason, payload?.advanceInterimBelow70Reason), ''),
      finalPaymentExpectedWeek: readable(preferRequestPayloadForChange(request, project.finalPaymentExpectedWeek, payload?.finalPaymentExpectedWeek), ''),
    },
    people: {
      teamName: readable(currentTeamName),
      members,
      staffingSummary: formatProjectStaffingSummary(
        usePayloadAsCurrent ? (payload?.staffing ?? project.staffing) : (project.staffing ?? payload?.staffing),
      ),
      participationSheetLink: readable(preferRequestPayloadForChange(request, project.participationSheetLink, payload?.participationSheetLink), ''),
    },
    notes: {
      description: readable(preferRequestPayloadForChange(request, project.description, payload?.description)),
      projectPurpose: readable(preferRequestPayloadForChange(request, project.projectPurpose, payload?.projectPurpose)),
      participantCondition: readable(preferRequestPayloadForChange(request, project.participantCondition, payload?.participantCondition)),
      note: readable(payload?.note),
    },
    audit: {
      requestSummary: readable(request?.humanSummary),
      requestVersion: request?.requestVersion ? `v${request.requestVersion}` : '-',
      requestedByName: readable(request?.requestedByName || payload?.registeredByName || project.registeredByName || project.managerName),
      requestedAt: formatDate(request?.requestedAt),
      requestUpdatedAt: formatDateTime(request?.updatedAt || request?.requestedAt),
      reviewedByName: readable(project.executiveReviewedByName || request?.reviewedByName),
      reviewedAt: formatDate(project.executiveReviewedAt || request?.reviewedAt),
      reviewComment: readable(project.executiveReviewComment || request?.reviewComment || request?.rejectedReason),
      history: auditHistory,
    },
    changes,
    analysis: {
      summary: readable(contractAnalysis?.summary),
      warnings: contractAnalysis?.warnings || [],
      nextActions: contractAnalysis?.nextActions || [],
    },
    contractDocument: {
      name: readable(contractDocument?.name),
      downloadURL: readable(contractDocument?.downloadURL),
      uploadedAt: formatDate(contractDocument?.uploadedAt),
    },
    submittedFields,
    missingSubmittedFields: submittedFields.filter((field) => field.missing).map((field) => field.label),
  };
}
