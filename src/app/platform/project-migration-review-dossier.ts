import { submissionAmount, submittedParticipationLines, submissionPaymentPlan } from './project-submission-display';
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
import { resolveProjectRequestPayload } from './project-change-request';
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
    submittedParticipation: string[];
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
  performanceCertificateDocument: '수행실적증명서', taxInvoiceDocument: '세금계산서', finalSettlementReportDocument: '최종 정산 보고서', finalReportDocument: '최종 보고서', contractAnalysis: '계약서 분석',
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
  plan: Partial<NonNullable<Project['paymentPlan']>> | null | undefined,
  contractAmount: number | null | undefined,
  currency?: string,
  months?: Project['paymentExpectedMonths'],
): string {
  if (!plan) return '-';
  const normalizedContractAmount = Number(contractAmount);
  const entries = [
    ['선금/계약금', plan.contract, months?.contract],
    ['중도금', plan.interim, months?.interim],
    ['잔금', plan.final, months?.final],
  ] as const;
  const label = entries
    .map(([name, value, month]) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${name} 미입력${month ? ` · ${month}` : ''}`;
      const amount = Number(value);
      const percent = Number.isFinite(normalizedContractAmount) && normalizedContractAmount > 0
        ? ` (${((amount / normalizedContractAmount) * 100).toFixed(0)}%)`
        : '';
      return `${name} ${submissionAmount(amount, currency)}${percent}${month ? ` · ${month}` : ''}`;
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

function submittedValue<T>(
  request: ProjectRequest | null,
  projectValue: T,
  payloadValue: T | undefined,
): T | undefined {
  return request ? payloadValue : projectValue;
}

export function resolveMigrationReviewContractDocument(
  project: Project,
  request: ProjectRequest | null,
) {
  return (request ? resolveProjectRequestPayload(request)?.contractDocument : project.contractDocument) ?? null;
}

export function buildMigrationReviewDossier(
  project: Project,
  request: ProjectRequest | null,
): MigrationReviewDossier {
  const payload = resolveProjectRequestPayload(request);
  const snapshot = request ? payload : project;
  const formatStoredProjectAmount = (value: unknown, explicit?: boolean) => submissionAmount(value, snapshot?.currency, explicit);
  const contractDocument = resolveMigrationReviewContractDocument(project, request);
  const contractAnalysis = snapshot?.contractAnalysis;
  const currentName = submittedValue(request, project.name, payload?.name);
  const currentOfficialContractName = submittedValue(request, project.officialContractName, payload?.officialContractName);
  const currentClientOrg = submittedValue(request, project.clientOrg, payload?.clientOrg);
  const currentDepartment = submittedValue(request, project.department, payload?.department);
  const currentManagerName = submittedValue(request, project.registeredByName || project.managerName, payload?.registeredByName || payload?.managerName);
  const currentTeamName = submittedValue(request, project.teamName, payload?.teamName);
  const rawMembers = snapshot?.teamMembersDetailed;
  const members = Array.isArray(rawMembers)
    ? normalizeProjectTeamMembers(rawMembers).map(formatProjectTeamMemberLine)
    : readable(request ? payload?.teamMembers : undefined, '')
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
      cic: readable(request ? currentDepartment : (project.cic || currentDepartment)),
      pmName: readable(currentManagerName),
      department: readable(currentDepartment),
      officialContractName: readable(currentOfficialContractName || currentName),
      groupwareName: readable(submittedValue(request, project.groupwareName, payload?.groupwareName)),
    },
    contract: {
      projectTypeLabel: snapshot?.type == null || String(snapshot.type).trim() === '' ? '미입력' : PROJECT_TYPE_LABELS[normalizeProjectType(submittedValue(request, project.type, payload?.type))] || readable(snapshot?.type),
      periodLabel: (() => {
        const start = readable(submittedValue(request, project.contractStart, payload?.contractStart));
        const openEnded = snapshot?.contractEndUndecided === true;
        const end = readable(submittedValue(request, project.contractEnd, payload?.contractEnd));
        // 종료 기간 없음(명시 플래그)은 미입력('-')과 다른 상태라 다르게 적는다.
        return `${start} ~ ${openEnded ? '종료 기간 없음' : end}`;
      })(),
      contractType: snapshot?.contractType == null ? '-' : readable(normalizeProjectContractType(snapshot.contractType)),
      settlementTypeLabel: snapshot?.settlementType == null || String(snapshot.settlementType).trim() === '' ? '미입력' : SETTLEMENT_TYPE_LABELS[normalizeSettlementType(submittedValue(request, project.settlementType, payload?.settlementType))] || '-',
      basisLabel: snapshot?.basis == null || String(snapshot.basis).trim() === '' ? '미입력' : BASIS_LABELS[normalizeBasis(submittedValue(request, project.basis, payload?.basis))] || '-',
      accountTypeLabel: snapshot?.accountType == null || String(snapshot.accountType).trim() === '' ? '미입력' : ACCOUNT_TYPE_LABELS[normalizeAccountType(submittedValue(request, project.accountType, payload?.accountType))] || '-',
      fundInputModeLabel: snapshot?.fundInputMode == null || String(snapshot.fundInputMode).trim() === '' ? '미입력' : PROJECT_FUND_INPUT_MODE_LABELS[normalizeProjectFundInputMode(submittedValue(request, project.fundInputMode, payload?.fundInputMode))] || '-',
      settlementSystemLabel: (() => {
        if (snapshot?.settlementSystem == null || String(snapshot.settlementSystem).trim() === '') return '미입력';
        const code = normalizeSettlementSystemCode(submittedValue(request, project.settlementSystem, payload?.settlementSystem));
        if (code === 'OTHER') {
          const other = readable(submittedValue(request, project.settlementSystemOther, payload?.settlementSystemOther), '');
          return other ? `기타 · ${other}` : '기타';
        }
        return SETTLEMENT_SYSTEM_LABELS[code] || '-';
      })(),
      laborSettlementBasisLabel: snapshot?.laborSettlementBasis == null || String(snapshot.laborSettlementBasis).trim() === '' ? '미입력' : LABOR_SETTLEMENT_BASIS_LABELS[normalizeLaborSettlementBasis(submittedValue(request, project.laborSettlementBasis, payload?.laborSettlementBasis))] || '-',
    },
    budget: {
      currencyLabel: PROJECT_CURRENCY_LABELS[normalizeProjectCurrency(submittedValue(request, project.currency, payload?.currency))] || 'KRW',
      contractAmountLabel: formatStoredProjectAmount(submittedValue(request, project.contractAmount, payload?.contractAmount), snapshot?.financialInputFlags?.contractAmount),
      salesVatAmountLabel: formatStoredProjectAmount(submittedValue(request, project.salesVatAmount, payload?.salesVatAmount), snapshot?.financialInputFlags?.salesVatAmount),
      paymentPlanDesc: readable(submittedValue(request, project.paymentPlanDesc, payload?.paymentPlanDesc)),
      paymentPlanSplitLabel: (submissionPaymentPlan(snapshot).legacy ? '전체 계약기간 계획(연도별 배분 미기록) · ' : '') + formatPaymentPlanSplit(
        submissionPaymentPlan(snapshot).plan,
        submittedValue(request, project.contractAmount, payload?.contractAmount),
        snapshot?.currency,
        submissionPaymentPlan(snapshot).legacy ? snapshot?.paymentExpectedMonths : undefined,
      ),
      finalPaymentNote: readable(submittedValue(request, project.finalPaymentNote, payload?.finalPaymentNote)),
      totalRevenueAmountLabel: formatStoredProjectAmount(submittedValue(request, project.totalRevenueAmount, payload?.totalRevenueAmount), snapshot?.financialInputFlags?.totalRevenueAmount),
      supportAmountLabel: formatStoredProjectAmount(submittedValue(request, project.supportAmount, payload?.supportAmount), snapshot?.financialInputFlags?.supportAmount),
      advanceInterimBelow70Reason: readable(submittedValue(request, project.advanceInterimBelow70Reason, payload?.advanceInterimBelow70Reason), ''),
      finalPaymentExpectedWeek: readable(submittedValue(request, project.finalPaymentExpectedWeek, payload?.finalPaymentExpectedWeek), ''),
    },
    people: {
      teamName: readable(currentTeamName),
      members,
      submittedParticipation: submittedParticipationLines(rawMembers),
      staffingSummary: formatProjectStaffingSummary(
        snapshot?.staffing,
      ),
      participationSheetLink: readable(submittedValue(request, project.participationSheetLink, payload?.participationSheetLink), ''),
    },
    notes: {
      description: readable(submittedValue(request, project.description, payload?.description)),
      projectPurpose: readable(submittedValue(request, project.projectPurpose, payload?.projectPurpose)),
      participantCondition: readable(submittedValue(request, project.participantCondition, payload?.participantCondition)),
      note: readable(snapshot?.note),
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
