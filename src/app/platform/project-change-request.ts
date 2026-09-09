import type {
  Project,
  ProjectExecutiveReviewHistoryEntry,
  ProjectRequest,
  ProjectRequestKind,
  ProjectRequestPayload,
} from '../data/types';
import { normalizeProjectStatus } from '../data/types';
import { buildProjectRequestPayloadFromDraft, type ProjectEditorDraft } from './project-editor';
import { buildProjectEditorReviewChanges } from './project-editor';
import { normalizeProjectRevenueFields } from './project-financials';
import { normalizeProjectDepartment, resolveProjectCic } from './project-cic';

function text(value: unknown): string {
  return String(value || '').trim();
}

function numeric(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function nextPositiveInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed + 1 : 1;
}

function omitUndefinedFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => omitUndefinedFields(item)) as T;
  }
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, omitUndefinedFields(item)]),
  ) as T;
}

function formatKst(iso: string): string {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatKstSentence(iso: string): string {
  const value = text(iso);
  if (!value) return '시간 미상';

  try {
    const parts = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(value));
    const part = (type: string) => parts.find((item) => item.type === type)?.value || '';
    const month = part('month');
    const day = part('day');
    const hour = part('hour');
    const minute = part('minute');
    if (month && day && hour && minute) return `${month}월 ${day}일 ${hour}시 ${minute}분`;
  } catch {
    // fall through to raw value
  }

  return value;
}

export function resolveProjectRequestKind(request: ProjectRequest | null | undefined): ProjectRequestKind {
  return request?.requestKind === 'CHANGE' ? 'CHANGE' : 'REGISTRATION';
}

export function resolveProjectRequestPayload(request: ProjectRequest | null | undefined): ProjectRequestPayload | undefined {
  if (!request) return undefined;
  if (resolveProjectRequestKind(request) === 'CHANGE' && request.proposedSnapshot) {
    return request.proposedSnapshot;
  }
  return request.payload;
}

export function describeProjectRequestVersion(input: {
  request?: ProjectRequest | null;
  project?: Project | null;
  fallbackActorName?: string;
  fallbackRequestedAt?: string;
}): string {
  const request = input.request || null;
  const project = input.project || null;
  const actorName = text(
    request?.requestedByName
    || input.fallbackActorName
    || project?.registeredByName
    || project?.managerName,
  ) || '요청자';
  const requestedAt = text(request?.requestedAt || input.fallbackRequestedAt || project?.createdAt);
  const action = request
    ? resolveProjectRequestKind(request) === 'CHANGE' ? '수정 요청' : '등록 요청'
    : '등록';
  const version = request?.requestVersion || request?.targetProjectVersion || request?.baseProjectVersion;
  return `${actorName} 님이 ${formatKstSentence(requestedAt)}에 ${action}한 버전입니다${version ? ` · v${version}` : ''}`;
}

export function buildProjectPayloadFromProject(project: Project): ProjectRequestPayload {
  return {
    name: text(project.name),
    officialContractName: text(project.officialContractName || project.name),
    type: project.type,
    status: normalizeProjectStatus(project.status),
    phase: project.phase,
    description: text(project.description),
    clientOrg: text(project.clientOrg),
    businessManagementGoogleFolderLink: text(project.businessManagementGoogleFolderLink),
    department: normalizeProjectDepartment(project.department),
    groupwareName: text(project.groupwareName),
    currency: project.currency || 'KRW',
    contractAmount: numeric(project.contractAmount),
    salesVatAmount: numeric(project.salesVatAmount),
    totalRevenueAmount: numeric(project.totalRevenueAmount),
    totalActualCost: numeric(project.totalActualCost),
    supportAmount: numeric(project.supportAmount),
    financialInputFlags: project.financialInputFlags,
    registrationRequirementsVersion: project.registrationRequirementsVersion,
    financialYears: project.financialYears,
    registrationConfirmations: project.registrationConfirmations,
    registrationOptionalDocumentNotes: project.registrationOptionalDocumentNotes,
    checkout: project.checkout,
    contractStart: text(project.contractStart),
    contractEnd: text(project.contractEnd),
    contractType: text(project.contractType),
    settlementType: project.settlementType,
    basis: project.basis,
    accountType: project.accountType,
    interestRefundPolicy: project.interestRefundPolicy,
    settlementSystem: project.settlementSystem,
    laborSettlementBasis: project.laborSettlementBasis,
    fundInputMode: project.fundInputMode,
    settlementSheetPolicy: project.settlementSheetPolicy,
    paymentPlan: project.paymentPlan,
    paymentExpectedMonths: project.paymentExpectedMonths,
    finalPaymentExpectedWeek: text(project.finalPaymentExpectedWeek),
    advanceInterimBelow70Reason: text(project.advanceInterimBelow70Reason),
    paymentPlanDesc: text(project.paymentPlanDesc),
    settlementGuide: text(project.settlementGuide),
    finalPaymentNote: text(project.finalPaymentNote),
    projectPurpose: text(project.projectPurpose),
    registeredById: text(project.registeredById || project.managerId),
    registeredByName: text(project.registeredByName || project.managerName),
    registeredByEmail: text(project.registeredByEmail),
    executiveApproverId: text(project.executiveApproverId),
    executiveApproverName: text(project.executiveApproverName),
    executiveApproverEmail: text(project.executiveApproverEmail),
    managerId: text(project.registeredById || project.managerId),
    managerName: text(project.registeredByName || project.managerName),
    teamName: text(project.teamName),
    teamMembers: '',
    teamMembersDetailed: project.teamMembersDetailed || [],
    participantCondition: text(project.participantCondition),
    note: text(project.note),
    contractDocument: project.contractDocument || null,
    quoteDocument: project.quoteDocument || null,
    quoteSubmissionDeferred: project.quoteSubmissionDeferred,
    proposalDocument: project.proposalDocument || null,
    proposalWordOriginalDocument: project.proposalWordOriginalDocument || null,
    proposalPptOriginalDocument: project.proposalPptOriginalDocument || null,
    presentationPptOriginalDocument: project.presentationPptOriginalDocument || null,
    rfpRequestEvidenceDocument: project.rfpRequestEvidenceDocument || null,
    customerBusinessRegistrationDocument: project.customerBusinessRegistrationDocument || null,
    performanceCertificateDocument: project.performanceCertificateDocument || null,
    taxInvoiceDocument: project.taxInvoiceDocument || null,
    finalSettlementReportDocument: project.finalSettlementReportDocument || null,
    contractAnalysis: project.contractAnalysis || null,
  };
}

export function resolveProjectRequestAuditTitle(input: {
  actorName: string;
  requestedAt: string;
  baseProjectVersion: number;
  requestVersion: number;
}): string {
  return `${input.actorName || '요청자'}가 ${formatKst(input.requestedAt)}에 요청한 프로젝트 변경입니다. 기준 프로젝트 v${input.baseProjectVersion} · 요청 v${input.requestVersion}`;
}

export function buildProjectChangeRequest(input: {
  baseProject: Project;
  draft: ProjectEditorDraft;
  previousRequest?: ProjectRequest | null;
  actorId: string;
  actorName: string;
  actorEmail: string;
  tenantId: string;
  requestedAt: string;
}): ProjectRequest {
  const proposedSnapshot = buildProjectRequestPayloadFromDraft(input.draft);
  const beforeSnapshot = buildProjectPayloadFromProject(input.baseProject);
  const changedFields = buildProjectEditorReviewChanges(input.baseProject, input.draft);
  const requestVersion = nextPositiveInt(input.previousRequest?.requestVersion);
  const baseProjectVersion = Number.isInteger(input.baseProject.version) && Number(input.baseProject.version) > 0
    ? Number(input.baseProject.version)
    : 1;
  const id = text(input.previousRequest?.id) || `change-${input.baseProject.id}`;
  return omitUndefinedFields({
    id,
    tenantId: input.tenantId,
    requestKind: 'CHANGE',
    targetProjectId: input.baseProject.id,
    baseProjectVersion,
    requestVersion,
    beforeSnapshot,
    proposedSnapshot,
    changedFields,
    humanSummary: resolveProjectRequestAuditTitle({
      actorName: input.actorName,
      requestedAt: input.requestedAt,
      baseProjectVersion,
      requestVersion,
    }),
    status: 'PENDING',
    payload: proposedSnapshot,
    requestedBy: input.actorId,
    requestedByName: input.actorName,
    requestedByEmail: input.actorEmail,
    requestedAt: input.requestedAt,
    reviewComment: null,
    rejectedReason: null,
    approvedProjectId: input.baseProject.id,
    createdAt: input.previousRequest?.createdAt || input.requestedAt,
    updatedAt: input.requestedAt,
  });
}

export function buildProjectPatchFromRequestPayload(
  payload: ProjectRequestPayload,
  input: {
    baseProject: Project;
    approvedAt: string;
    reviewerId: string;
    reviewerName: string;
    reviewComment?: string | null;
    changedFields?: ProjectExecutiveReviewHistoryEntry['changes'];
  },
): Partial<Project> {
  const patch = normalizeProjectRevenueFields({
    name: text(payload.name),
    officialContractName: text(payload.officialContractName),
    type: payload.type,
    status: normalizeProjectStatus(payload.status || input.baseProject.status),
    phase: payload.phase || input.baseProject.phase,
    description: text(payload.description),
    clientOrg: text(payload.clientOrg),
    businessManagementGoogleFolderLink: text(payload.businessManagementGoogleFolderLink),
    department: normalizeProjectDepartment(payload.department),
    cic: resolveProjectCic({ department: payload.department }),
    groupwareName: text(payload.groupwareName),
    currency: payload.currency || 'KRW',
    contractAmount: numeric(payload.contractAmount),
    salesVatAmount: numeric(payload.salesVatAmount),
    totalRevenueAmount: numeric(payload.totalRevenueAmount),
    totalActualCost: numeric(payload.totalActualCost),
    supportAmount: numeric(payload.supportAmount),
    financialInputFlags: payload.financialInputFlags,
    registrationRequirementsVersion: payload.registrationRequirementsVersion,
    financialYears: payload.financialYears,
    registrationConfirmations: payload.registrationConfirmations,
    registrationOptionalDocumentNotes: payload.registrationOptionalDocumentNotes,
    checkout: payload.checkout,
    contractStart: text(payload.contractStart),
    contractEnd: text(payload.contractEnd),
    contractType: text(payload.contractType),
    settlementType: payload.settlementType,
    basis: payload.basis,
    accountType: payload.accountType,
    interestRefundPolicy: payload.interestRefundPolicy,
    settlementSystem: payload.settlementSystem,
    ...(Object.prototype.hasOwnProperty.call(payload, 'settlementSystemOther')
      ? { settlementSystemOther: text(payload.settlementSystemOther) }
      : {}),
    laborSettlementBasis: payload.laborSettlementBasis,
    ...(Object.prototype.hasOwnProperty.call(payload, 'laborTransferPlan')
      ? { laborTransferPlan: payload.laborTransferPlan }
      : {}),
    fundInputMode: payload.fundInputMode,
    settlementSheetPolicy: payload.settlementSheetPolicy,
    paymentPlan: payload.paymentPlan || input.baseProject.paymentPlan,
    paymentExpectedMonths: payload.paymentExpectedMonths || input.baseProject.paymentExpectedMonths,
    ...(Object.prototype.hasOwnProperty.call(payload, 'finalPaymentExpectedWeek')
      ? { finalPaymentExpectedWeek: text(payload.finalPaymentExpectedWeek) }
      : {}),
    advanceInterimBelow70Reason: text(payload.advanceInterimBelow70Reason),
    paymentPlanDesc: text(payload.paymentPlanDesc),
    settlementGuide: text(payload.settlementGuide),
    ...(Object.prototype.hasOwnProperty.call(payload, 'finalPaymentNote')
      ? { finalPaymentNote: text(payload.finalPaymentNote) }
      : {}),
    projectPurpose: text(payload.projectPurpose),
    registeredById: text(payload.registeredById || payload.managerId),
    registeredByName: text(payload.registeredByName || payload.managerName),
    registeredByEmail: text(payload.registeredByEmail),
    executiveApproverId: text(payload.executiveApproverId),
    executiveApproverName: text(payload.executiveApproverName),
    executiveApproverEmail: text(payload.executiveApproverEmail),
    managerId: text(payload.registeredById || payload.managerId),
    managerName: text(payload.registeredByName || payload.managerName),
    teamName: text(payload.teamName),
    teamMembersDetailed: payload.teamMembersDetailed || [],
    participantCondition: text(payload.participantCondition),
    note: text(payload.note),
    contractDocument: payload.contractDocument || null,
    quoteDocument: payload.quoteDocument || null,
    quoteSubmissionDeferred: payload.quoteSubmissionDeferred,
    proposalDocument: payload.proposalDocument || null,
    proposalWordOriginalDocument: payload.proposalWordOriginalDocument || null,
    proposalPptOriginalDocument: payload.proposalPptOriginalDocument || null,
    presentationPptOriginalDocument: payload.presentationPptOriginalDocument || null,
    rfpRequestEvidenceDocument: payload.rfpRequestEvidenceDocument || null,
    customerBusinessRegistrationDocument: payload.customerBusinessRegistrationDocument || null,
    performanceCertificateDocument: payload.performanceCertificateDocument || null,
    taxInvoiceDocument: payload.taxInvoiceDocument || null,
    finalSettlementReportDocument: payload.finalSettlementReportDocument || null,
    contractAnalysis: payload.contractAnalysis || null,
    budgetCurrentYear: numeric(payload.contractAmount || input.baseProject.budgetCurrentYear),
    taxInvoiceAmount: input.baseProject.taxInvoiceAmount,
    profitRate: input.baseProject.profitRate,
    profitAmount: input.baseProject.profitAmount,
    executiveReviewStatus: 'APPROVED',
    executiveReviewedAt: input.approvedAt,
    executiveReviewedById: input.reviewerId,
    executiveReviewedByName: input.reviewerName,
    executiveReviewComment: input.reviewComment || null,
    executiveReviewHistory: [
      ...(Array.isArray(input.baseProject.executiveReviewHistory) ? input.baseProject.executiveReviewHistory : []),
      {
        status: 'APPROVED',
        previousStatus: input.baseProject.executiveReviewStatus || 'PENDING',
        reviewedAt: input.approvedAt,
        reviewedById: input.reviewerId,
        reviewedByName: input.reviewerName,
        reviewComment: input.reviewComment || undefined,
        ...(input.changedFields?.length ? { changes: input.changedFields } : {}),
      },
    ],
    updatedAt: input.approvedAt,
  }, 'totalRevenueAmount');
  return patch as Partial<Project>;
}
