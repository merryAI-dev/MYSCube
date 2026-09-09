import { featureFlags, parseFeatureFlag } from '../config/feature-flags';
import type {
  AccountType,
  CashflowSheetLineId,
  Project,
  ProjectRequest,
  ProjectExecutiveReviewStatus,
  ProjectManagementPlanningReviewStatus,
  ProjectSheetSourceSnapshot,
  ProjectSheetSourceType,
  ProjectRequestContractAnalysis,
  TransactionState,
} from '../data/types';
import type { EmploymentState, EmploymentType } from '../platform/person-employment';
import type { ProfessionalProfileInput } from './person-professional-profile-client';
import { PlatformApiClient } from '../platform/api-client';
import { buildStandardHeaders, type RequestActor } from '../platform/request-context';
import {
  cashflowMutationHeaders,
  type CashflowMutationLease,
} from './cashflow-edit-lease';

export interface PlatformApiRuntimeConfig {
  enabled: boolean;
  baseUrl: string;
}

export interface ActorLike {
  uid: string;
  email?: string;
  role?: string;
  idToken?: string;
  googleAccessToken?: string;
}

export interface UpsertProjectPayload {
  id: string;
  name: string;
  expectedVersion?: number;
  [key: string]: unknown;
}

export interface ParticipationDashboardMonth {
  yearMonth: string;
  label: string;
  rate: number;
  isConfirmed: boolean;
  hasMissing: boolean;
  isWarning: boolean;
}

export interface ParticipationDashboardProject {
  projectId: string;
  projectName: string;
  months: ParticipationDashboardMonth[];
}

export interface ParticipationDashboardMember {
  memberId: string;
  memberName: string;
  projectLabel: string;
  projectCount: number;
  months: ParticipationDashboardMonth[];
  projects?: ParticipationDashboardProject[];
  warnings: Array<{ yearMonth: string; rate: number }>;
}

export interface ParticipationDashboardProfileFilterOption {
  value: string;
  label: string;
  memberCount: number;
}

export interface ParticipationDashboardRule {
  id: string;
  alias: string;
  clientOrgs: string[];
  settlementSystems: string[];
}

export interface ParticipationDashboardSnapshot {
  version: number;
  generatedAt: string;
  availableYears: string[];
  selectedYear: string;
  months: Array<{ yearMonth: string; label: string }>;
  selectedRule: ParticipationDashboardRule;
  ruleOptions: ParticipationDashboardRule[];
  userRuleOptions: ParticipationDashboardRule[];
  members: ParticipationDashboardMember[];
  warnings: Array<{ yearMonth: string; rate: number; memberId: string; memberName: string }>;
  warningCount: number;
  hasWarnings: boolean;
  unlinkedEntryCount: number;
  filterOptions: { clientOrgs: string[]; settlementSystems: Array<{ value: string; label: string; projectCount?: number }> };
  projects: Array<{ id: string; name: string; clientOrg: string }>;
}

/** 참여율 시트 검증 결과. 읽기 전용이라 무엇도 바뀌지 않는다. */
export interface ParticipationSheetPreview {
  projectId: string;
  projectName: string;
  sheetLink: string;
  checkedAt: string;
  ok: boolean;
  summary: {
    period: { start: string; end: string };
    monthCount: number;
    rowCount: number;
    linkedCount: number;
    pendingLinkCount: number;
    placeholderCount: number;
    missingCount: number;
    candidateCount: number;
    errorCount: number;
  } | null;
  blocking: Array<{ code: string; message: string; rowIndex?: number; month?: string }>;
  /** 막지는 않지만 사용자가 인지해야 하는 것들 - 기간 불일치 등. 구버전 응답엔 없다. */
  warnings?: Array<{ code: string; message: string }>;
  months: string[];
  rows: Array<{
    rowIndex: number;
    nickname: string;
    name: string;
    role: string;
    stintStart: string;
    stintEnd: string;
    /** 시트의 기본투입률. 월별 값은 monthlyRates 가 원천이다. */
    baseRate: number | null;
    personId: string;
    linkState: 'LINKED' | 'PENDING_LINK' | 'PLACEHOLDER';
    monthlyRates: Record<string, number>;
  }>;
  missing: Array<{ rowIndex: number; label: string; month: string }>;
  candidates: Array<{ key: string; name: string; nickname: string; rowIndexes: number[]; monthCount: number }>;
}

export interface ProjectParticipationSnapshot {
  projectId: string;
  projectName: string;
  headcount: number;
  totalRate: number;
  averageRate: number;
  hasMembers: boolean;
  members: Array<{
    memberId: string;
    memberName: string;
    totalRate: number;
    entryCount: number;
    isWarning: boolean;
    entries: Array<{ id: string; rate: number; settlementSystem: string; clientOrg: string; periodStart: string; periodEnd: string; source: string; note: string }>;
  }>;
}

export interface TrashProjectPayload {
  expectedVersion: number;
  reason?: string;
}

export interface RestoreProjectPayload {
  expectedVersion: number;
}

export interface UpsertLedgerPayload {
  id: string;
  projectId: string;
  name: string;
  expectedVersion?: number;
}

export interface UpsertTransactionPayload {
  id: string;
  projectId: string;
  ledgerId: string;
  counterparty: string;
  expectedVersion?: number;
}

export interface CreateCommentPayload {
  id?: string;
  content: string;
  authorName?: string;
  projectId?: string;
  targetType?: 'transaction' | 'expense_sheet_row';
  sheetRowId?: string;
  fieldKey?: string;
  fieldLabel?: string;
}

export interface CreateEvidencePayload {
  id?: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  category: string;
  status?: 'PENDING' | 'ACCEPTED' | 'REJECTED';
}

export interface ProjectRequestContractUploadPayload {
  fileName: string;
  mimeType: string;
  fileSize: number;
  contentBase64: string;
}

export type BusinessCardConfidence = 'high' | 'medium' | 'low';

export interface BusinessCardExtractedField {
  value: string;
  confidence: BusinessCardConfidence;
  evidence: string;
}

export interface BusinessCardExtractedListField extends BusinessCardExtractedField {}

export interface BusinessCardExtraction {
  name: BusinessCardExtractedField;
  organization: BusinessCardExtractedField;
  department: BusinessCardExtractedField;
  title: BusinessCardExtractedField;
  role: BusinessCardExtractedField;
  emails: BusinessCardExtractedListField[];
  phones: BusinessCardExtractedListField[];
  website: BusinessCardExtractedField;
  address: BusinessCardExtractedField;
  memo: BusinessCardExtractedField;
  rawText: string;
  warnings: string[];
}

export interface BusinessCardProcessPayload {
  fileName: string;
  mimeType: string;
  fileSize: number;
  contentBase64: string;
}

export interface BusinessCardImportResult {
  importId: string;
  status: 'needs_review' | 'saved' | 'failed';
  extracted: BusinessCardExtraction;
  error?: { code?: string; message?: string } | null;
}

export interface BusinessCardImportListItem {
  id: string;
  status: 'needs_review' | 'saved' | 'failed';
  fileName: string;
  mimeType: string;
  fileSize: number;
  uploadedBy?: string;
  uploadedByEmail?: string;
  createdAt: string;
  updatedAt: string;
  extracted: BusinessCardExtraction | null;
  contactId?: string | null;
  error?: { code?: string; message?: string } | null;
}

export interface BusinessCardConfirmPayload {
  name: string;
  organization: string;
  department: string;
  title: string;
  role: string;
  emails: string[];
  phones: string[];
  website: string;
  address: string;
  memo: string;
}

export interface BusinessCardConfirmResult {
  ok: boolean;
  importId: string;
  contactId: string;
  status: 'saved';
}

export interface ContactSearchResult {
  id: string;
  name: string;
  organization: string;
  department?: string;
  title?: string;
  role?: string;
  emails: string[];
  phones: string[];
  website?: string;
  address?: string;
  memo?: string;
  score: number;
  updatedAt?: string;
}

export interface ContactUpdateResult {
  ok: boolean;
  contact: ContactSearchResult;
}

export interface ProvisionProjectEvidenceDriveRootResult {
  projectId: string;
  folderId: string;
  folderName: string;
  webViewLink: string | null;
  sharedDriveId: string | null;
  version: number;
  updatedAt: string;
}

export interface LinkProjectEvidenceDriveRootResult extends ProvisionProjectEvidenceDriveRootResult {}

export interface GoogleSheetPreviewSheet {
  sheetId: number;
  title: string;
  index: number;
}

export interface GoogleSheetImportPreviewResult {
  spreadsheetId: string;
  spreadsheetTitle: string;
  selectedSheetName: string;
  availableSheets: GoogleSheetPreviewSheet[];
  matrix: string[][];
}

export interface GoogleSheetMigrationAnalysisSuggestion {
  sourceHeader: string;
  platformField: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export interface GoogleSheetMigrationAnalysisResult {
  provider: 'anthropic' | 'heuristic';
  model: string;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  likelyTarget: string;
  usageTips: string[];
  warnings: string[];
  nextActions: string[];
  suggestedMappings: GoogleSheetMigrationAnalysisSuggestion[];
  headerPreview?: string[];
}

export interface ProjectSheetSourceUploadPayload {
  sourceType: ProjectSheetSourceType;
  sheetName: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  contentBase64: string;
  rowCount: number;
  columnCount: number;
  matchedColumns?: string[];
  unmatchedColumns?: string[];
  previewMatrix?: string[][];
  applyTarget?: string;
}

export interface ProjectRequestContractAnalysisResult extends ProjectRequestContractAnalysis {}

export interface ProjectRequestRegistrationNotificationResult {
  ok: boolean;
  enabled: boolean;
  delivered: boolean;
  requestId: string;
  projectId: string | null;
  reason?: string;
}

export interface ProjectExecutiveReviewPayload {
  requestId?: string;
  reviewStatus: ProjectExecutiveReviewStatus;
  reviewComment?: string;
  reviewerName?: string;
  projectCode?: string;
}

export interface ProjectExecutiveReviewResult {
  ok: boolean;
  projectId: string;
  requestId: string | null;
  reviewStatus: ProjectExecutiveReviewStatus;
  reviewedAt?: string;
  slackDelivered?: boolean;
  slackReason?: string | null;
}

export interface ProjectExecutiveReviewResubmitPayload {
  requestId?: string;
  reviewComment?: string;
  reviewerName?: string;
}

export interface ProjectExecutiveReviewResubmitResult {
  ok: boolean;
  projectId: string;
  requestId: string | null;
  reviewStatus: 'PENDING';
  reviewedAt?: string;
}

export interface ProjectManagementPlanningReviewPayload {
  requestId?: string;
  reviewStatus: Exclude<ProjectManagementPlanningReviewStatus, 'PENDING'>;
  reviewComment?: string;
  reviewerName?: string;
  projectCode?: string;
}

export interface ProjectManagementPlanningReviewResult {
  ok: boolean;
  projectId: string;
  requestId: string | null;
  reviewStatus: Exclude<ProjectManagementPlanningReviewStatus, 'PENDING'>;
  reviewedAt?: string;
}

export type AuthGovernanceDriftFlag =
  | 'missing_auth'
  | 'missing_canonical_member'
  | 'legacy_only'
  | 'duplicate_member_docs'
  | 'legacy_role_mismatch'
  | 'claim_mismatch'
  | 'bootstrap_admin_not_adopted';

export interface AuthGovernanceMemberSnapshot {
  docId: string;
  uid: string;
  email: string;
  role: string;
  status: string | null;
  name: string;
}

export interface AuthGovernanceProjectPermission {
  id: string;
  name: string;
}

export interface AuthGovernancePermissionOverview {
  isActive: boolean;
  accessibleProjects: AuthGovernanceProjectPermission[];
  organizationHeadProjects: AuthGovernanceProjectPermission[];
  canRequestCashflowClose: boolean;
  canApproveProjectRegistration: boolean;
  canDecideCashflowReopen: boolean;
}

export interface AuthGovernanceUserRow {
  identityKey: string;
  email: string;
  authUid: string | null;
  displayName: string;
  authDisabled: boolean;
  bootstrapAdmin: boolean;
  claimRole: string | null;
  claimTenantId: string | null;
  canonicalMember: AuthGovernanceMemberSnapshot | null;
  legacyMembers: AuthGovernanceMemberSnapshot[];
  effectiveRole: string;
  driftFlags: AuthGovernanceDriftFlag[];
  needsDeepSync: boolean;
  permissionOverview?: AuthGovernancePermissionOverview;
}

export interface AuthGovernanceSummary {
  total: number;
  needsDeepSync: number;
  missingAuth: number;
  missingCanonicalMember: number;
  duplicateMemberDocs: number;
  bootstrapCandidates: number;
}

export interface AuthGovernanceDirectoryResult {
  items: AuthGovernanceUserRow[];
  summary: AuthGovernanceSummary;
}

export interface AuthGovernanceDeepSyncResult {
  identityKey: string;
  email: string;
  canonicalDocId: string;
  role: string;
  mirroredLegacyCount: number;
  claimsUpdated: boolean;
  claimsSyncStatus: 'SYNCED' | 'PENDING' | 'NOT_APPLICABLE';
  updatedAt: string;
}

export type AuthGovernanceBulkDeepSyncOutcome =
  | { identityKey: string; status: 'SUCCEEDED'; result: AuthGovernanceDeepSyncResult }
  | { identityKey: string; status: 'FAILED'; errorCode: string; message: string };

export interface AuthGovernanceBulkDeepSyncResult {
  outcomes: AuthGovernanceBulkDeepSyncOutcome[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    pendingClaimsSync: number;
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeProjectExecutiveReviewPayload(
  payload: ProjectExecutiveReviewPayload,
): ProjectExecutiveReviewPayload {
  const requestId = normalizeOptionalText(payload.requestId);
  const reviewComment = normalizeOptionalText(payload.reviewComment);
  const reviewerName = normalizeOptionalText(payload.reviewerName);
  const projectCode = normalizeOptionalText(payload.projectCode);
  return {
    ...(requestId ? { requestId } : {}),
    reviewStatus: payload.reviewStatus,
    ...(reviewComment ? { reviewComment } : {}),
    ...(reviewerName ? { reviewerName } : {}),
    ...(projectCode ? { projectCode } : {}),
  };
}

function normalizeProjectExecutiveReviewResubmitPayload(
  payload: ProjectExecutiveReviewResubmitPayload,
): ProjectExecutiveReviewResubmitPayload {
  const requestId = normalizeOptionalText(payload.requestId);
  const reviewComment = normalizeOptionalText(payload.reviewComment);
  const reviewerName = normalizeOptionalText(payload.reviewerName);
  return {
    ...(requestId ? { requestId } : {}),
    ...(reviewComment ? { reviewComment } : {}),
    ...(reviewerName ? { reviewerName } : {}),
  };
}

function normalizeProjectManagementPlanningReviewPayload(
  payload: ProjectManagementPlanningReviewPayload,
): ProjectManagementPlanningReviewPayload {
  const requestId = normalizeOptionalText(payload.requestId);
  const reviewComment = normalizeOptionalText(payload.reviewComment);
  const reviewerName = normalizeOptionalText(payload.reviewerName);
  const projectCode = normalizeOptionalText(payload.projectCode);
  return {
    ...(requestId ? { requestId } : {}),
    reviewStatus: payload.reviewStatus,
    ...(reviewComment ? { reviewComment } : {}),
    ...(reviewerName ? { reviewerName } : {}),
    ...(projectCode ? { projectCode } : {}),
  };
}

function normalizeSuggestedMappings(value: unknown): GoogleSheetMigrationAnalysisSuggestion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const sourceHeader = typeof item.sourceHeader === 'string' ? item.sourceHeader.trim() : '';
      const platformField = typeof item.platformField === 'string' ? item.platformField.trim() : '';
      const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
      const confidence = item.confidence === 'high' || item.confidence === 'medium' || item.confidence === 'low'
        ? item.confidence
        : 'medium';
      if (!sourceHeader || !platformField || !reason) return null;
      return {
        sourceHeader,
        platformField,
        confidence,
        reason,
      } satisfies GoogleSheetMigrationAnalysisSuggestion;
    })
    .filter((item): item is GoogleSheetMigrationAnalysisSuggestion => Boolean(item));
}

function normalizeAiConfidence(value: unknown): 'high' | 'medium' | 'low' {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'low';
}

function normalizeProjectRequestTextSuggestion(value: unknown) {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    value: typeof raw.value === 'string' ? raw.value.trim() : '',
    confidence: normalizeAiConfidence(raw.confidence),
    evidence: typeof raw.evidence === 'string' ? raw.evidence.trim() : '',
  };
}

function normalizeProjectRequestNumberSuggestion(value: unknown) {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    value: typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : null,
    confidence: normalizeAiConfidence(raw.confidence),
    evidence: typeof raw.evidence === 'string' ? raw.evidence.trim() : '',
  };
}

export function normalizeGoogleSheetMigrationAnalysisResult(
  value: unknown,
): GoogleSheetMigrationAnalysisResult {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    provider: raw.provider === 'anthropic' ? 'anthropic' : 'heuristic',
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : 'unavailable',
    summary: typeof raw.summary === 'string' && raw.summary.trim()
      ? raw.summary.trim()
      : 'AI 분석 결과를 확인할 수 없어 기본 가이드를 표시합니다.',
    confidence: raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low'
      ? raw.confidence
      : 'medium',
    likelyTarget: typeof raw.likelyTarget === 'string' && raw.likelyTarget.trim() ? raw.likelyTarget.trim() : 'unknown',
    usageTips: normalizeStringArray(raw.usageTips),
    warnings: normalizeStringArray(raw.warnings),
    nextActions: normalizeStringArray(raw.nextActions),
    suggestedMappings: normalizeSuggestedMappings(raw.suggestedMappings),
    headerPreview: normalizeStringArray(raw.headerPreview),
  };
}

export function normalizeProjectRequestContractAnalysisResult(
  value: unknown,
): ProjectRequestContractAnalysisResult {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const fields = raw.fields && typeof raw.fields === 'object' ? raw.fields as Record<string, unknown> : {};
  return {
    provider: raw.provider === 'anthropic' ? 'anthropic' : 'heuristic',
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : 'unavailable',
    summary: typeof raw.summary === 'string' && raw.summary.trim()
      ? raw.summary.trim()
      : '계약서 초안을 확인할 수 없어 직접 입력이 필요합니다.',
    warnings: normalizeStringArray(raw.warnings),
    nextActions: normalizeStringArray(raw.nextActions),
    extractedAt: typeof raw.extractedAt === 'string' && raw.extractedAt.trim()
      ? raw.extractedAt.trim()
      : new Date().toISOString(),
    fields: {
      officialContractName: normalizeProjectRequestTextSuggestion(fields.officialContractName),
      suggestedProjectName: normalizeProjectRequestTextSuggestion(fields.suggestedProjectName),
      clientOrg: normalizeProjectRequestTextSuggestion(fields.clientOrg),
      projectPurpose: normalizeProjectRequestTextSuggestion(fields.projectPurpose),
      description: normalizeProjectRequestTextSuggestion(fields.description),
      contractStart: normalizeProjectRequestTextSuggestion(fields.contractStart),
      contractEnd: normalizeProjectRequestTextSuggestion(fields.contractEnd),
      contractAmount: normalizeProjectRequestNumberSuggestion(fields.contractAmount),
      salesVatAmount: normalizeProjectRequestNumberSuggestion(fields.salesVatAmount),
    },
  };
}

function normalizeBusinessCardConfidence(value: unknown): BusinessCardConfidence {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'low';
}

function normalizeBusinessCardField(value: unknown): BusinessCardExtractedField {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    value: typeof raw.value === 'string' ? raw.value.trim() : '',
    confidence: normalizeBusinessCardConfidence(raw.confidence),
    evidence: typeof raw.evidence === 'string' ? raw.evidence.trim() : '',
  };
}

function normalizeBusinessCardListField(value: unknown): BusinessCardExtractedListField[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeBusinessCardField(item))
    .filter((item) => item.value)
    .slice(0, 8);
}

export function normalizeBusinessCardExtraction(value: unknown): BusinessCardExtraction {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    name: normalizeBusinessCardField(raw.name),
    organization: normalizeBusinessCardField(raw.organization),
    department: normalizeBusinessCardField(raw.department),
    title: normalizeBusinessCardField(raw.title),
    role: normalizeBusinessCardField(raw.role),
    emails: normalizeBusinessCardListField(raw.emails),
    phones: normalizeBusinessCardListField(raw.phones),
    website: normalizeBusinessCardField(raw.website),
    address: normalizeBusinessCardField(raw.address),
    memo: normalizeBusinessCardField(raw.memo),
    rawText: typeof raw.rawText === 'string' ? raw.rawText.trim() : '',
    warnings: normalizeStringArray(raw.warnings),
  };
}

export interface ProvisionTransactionEvidenceDriveResult {
  transactionId: string;
  projectId: string;
  projectFolderId: string;
  projectFolderName: string;
  folderId: string;
  folderName: string;
  webViewLink: string | null;
  sharedDriveId: string | null;
  syncStatus: 'LINKED';
  version: number;
  updatedAt: string;
}

export interface SyncTransactionEvidenceDriveResult {
  transactionId: string;
  projectId: string;
  folderId: string;
  folderName: string;
  webViewLink: string | null;
  sharedDriveId: string | null;
  evidenceCount: number;
  evidenceCompletedDesc: string | null;
  evidenceCompletedManualDesc?: string | null;
  evidenceAutoListedDesc: string | null;
  evidencePendingDesc: string | null;
  supportPendingDocs: string | null;
  evidenceMissing: string[];
  evidenceStatus: 'MISSING' | 'PARTIAL' | 'COMPLETE';
  lastSyncedAt: string;
  version: number;
  updatedAt: string;
}

export interface UploadTransactionEvidenceDrivePayload {
  fileName: string;
  originalFileName?: string;
  mimeType: string;
  fileSize: number;
  contentBase64: string;
  category?: string;
}

export interface UploadTransactionEvidenceDriveResult extends SyncTransactionEvidenceDriveResult {
  driveFileId: string;
  fileName: string;
  originalFileName?: string;
  webViewLink: string | null;
  category: string;
  parserCategory: string;
  parserConfidence: number;
}

export interface OverrideTransactionEvidenceDriveCategoriesPayload {
  items: Array<{
    driveFileId: string;
    category: string;
  }>;
}

export interface CashflowWeekAmountsPayload {
  yearMonth: string;
  weekNo: number;
  mode: 'projection' | 'actual';
  amounts: Record<string, number>;
}

export interface CashflowWeekAmountsResult {
  ok: boolean;
  commandName: string;
  projectId: string;
  savedLineCount: number;
  projection: CashflowProjectionLine[];
  auditId: string;
}

export interface CashflowProjectionLine {
  yearMonth: string;
  weekNo: number;
  cashflowLine: string;
  amount: number;
}

export interface CashflowActualLine extends CashflowProjectionLine {
  sheetKey: string;
}

export interface CashflowModeReadModel {
  rowTotals: Record<string, number>;
  weeks: Array<{
    weekNo: number;
    amounts: Record<string, number>;
    totalIn: number;
    totalOut: number;
    net: number;
    weekIn: number;
    weekOut: number;
  }>;
  monthTotals: { totalIn: number; totalOut: number; net: number };
}

export interface CashflowRangeBoundary {
  yearMonth: string;
  weekNo: number;
}

export interface CashflowRangeTotals {
  rowTotals: Record<string, number>;
  totalIn: number;
  totalOut: number;
  net: number;
}

export interface CashflowComparisonTotals {
  totalIn: number;
  totalOut: number;
  balance: number;
}

export interface CanonicalCashflowAnnualModeTotal {
  lineAmounts: Record<string, number>;
  lineStates: Record<string, 'VALUE' | 'ZERO' | 'EMPTY'>;
  totalIn: number | null;
  totalOut: number | null;
  net: number | null;
}

export interface CanonicalCashflowAnnualTotal {
  year: number;
  projection: CanonicalCashflowAnnualModeTotal;
  actual: CanonicalCashflowAnnualModeTotal;
}

export interface CashflowComparisonWeek {
  weekNo: number;
  amounts: Record<string, number>;
  totalIn: number;
  totalOut: number;
  net: number;
  lines: Array<{
    lineId: string;
    direction: 'IN' | 'OUT';
    projection: number;
    projectionHadValue: boolean;
    actual: number;
    actualHadValue: boolean;
    difference: number;
    mismatch: boolean;
  }>;
  totals: {
    projection: CashflowComparisonTotals;
    actual: CashflowComparisonTotals;
    difference: CashflowComparisonTotals;
  };
}

export interface CashflowComparisonMonth {
  yearMonth: string;
  weeks: CashflowComparisonWeek[];
  rowTotals: Record<string, number>;
  totalIn: number;
  totalOut: number;
  net: number;
  totals: CashflowComparisonWeek['totals'];
}

export interface CashflowProjectionActualComparison {
  projectId: string;
  direction: 'projection_minus_actual';
  asOfDate: string;
  asOfWeek: { yearMonth: string; weekNo: number };
  timeZone: 'Asia/Seoul';
  lineOrder: string[];
  months: CashflowComparisonMonth[];
  ignoredLineIds: string[];
}

export interface CashflowSnapshotResult {
  projectId: string;
  projection: CashflowProjectionLine[];
  actual: CashflowActualLine[];
  comparison: CashflowProjectionActualComparison;
  readModel: {
    weeklyYear?: number;
    annualTotals?: CanonicalCashflowAnnualTotal[];
    range: {
      start: CashflowRangeBoundary;
      end: CashflowRangeBoundary;
      projection: CashflowRangeTotals;
      actual: CashflowRangeTotals;
    };
    months: Array<{
      yearMonth: string;
      projection: CashflowModeReadModel;
      actual: CashflowModeReadModel;
      comparison: CashflowComparisonMonth;
    }>;
  };
}

export type CashflowMonthCloseStatus = 'OPEN' | 'CLOSED' | 'REOPEN_REQUESTED';
export type CashflowMonthReopenDecision = 'APPROVE' | 'REJECT';

export interface CashflowActivityEvent {
  id: string;
  projectId: string;
  runId: string;
  type: 'sheet_refresh' | 'sheet_apply' | 'projection_amount_change' | 'actual_amount_change' | 'projection_completed' | 'actual_completed' | 'admin_closed' | 'sheet_apply_reverted' | 'month_close';
  source?: 'google_sheet_refresh' | 'google_sheet_apply' | 'month_close' | 'manual' | 'revert';
  yearMonth?: string;
  year?: number;
  scope?: 'monthly' | 'annual';
  weekNo?: number;
  mode?: 'projection' | 'actual';
  lineId?: string;
  beforeAmount?: number;
  afterAmount?: number;
  beforeHadValue?: boolean;
  afterHadValue?: boolean;
  beforeState?: 'EMPTY' | 'ZERO' | 'VALUE';
  afterState?: 'EMPTY' | 'ZERO' | 'VALUE';
  appliedLineCount?: number;
  projectionLineCount?: number;
  actualLineCount?: number;
  revertedRunId?: string;
  actorUid?: string;
  actorName?: string;
  actorEmail?: string;
  status?: string;
  operation?: string;
  operationId?: string;
  auditId?: string;
  sourceDetail?: string;
  sourceRevision?: string;
  targetRevision?: string;
  reason?: string;
  sheetName?: string;
  createdAt: string;
}

export type CashflowActivitySource = 'legacy' | 'sheet_refresh' | 'audit';

export interface CashflowActivityPage {
  projectId: string;
  source?: CashflowActivitySource;
  events: CashflowActivityEvent[];
  errors: Array<{
    source: CashflowActivitySource;
    code: 'cashflow_activity_source_unavailable';
  }>;
  nextCursor: string | null;
}

export interface CashflowAppliedCellChange {
  eventId: string;
  cellId: string;
  projectId: string;
  yearMonth: string;
  weekNo: number;
  mode: 'projection' | 'actual';
  lineId: string;
  beforeHadValue: boolean;
  beforeState: 'EMPTY' | 'ZERO' | 'VALUE';
  beforeAmount: number | null;
  afterHadValue: boolean;
  afterState: 'EMPTY' | 'ZERO' | 'VALUE';
  afterAmount: number | null;
  actorUid: string;
  actorName: string;
  actorEmail: string;
  reason: string;
  source: string;
  operationType: string;
  operationId: string;
  auditId: string;
  sourceRevision: string;
  targetRevision: string;
  createdAt: string;
}

export interface CashflowAppliedCellChangePage {
  items: CashflowAppliedCellChange[];
  nextCursor: string;
}

export interface CashflowMonthCloseCell {
  mode: 'projection' | 'actual';
  weekNo: number;
  cashflowLine: string;
  cellState: 'VALUE' | 'ZERO' | 'EMPTY';
  amount?: number | null;
  sourceCell?: string | null;
  sourceLabel?: string | null;
}

export interface CashflowMonthCloseConfirmation {
  mode: 'projection' | 'actual';
  weekNo: number;
  cashflowLine: string;
  decision: 'CONFIRMED' | 'NOT_APPLICABLE';
}

export interface CashflowManagementCheck {
  id: 'labor-transfer' | 'profit-vat-after-deposit' | 'negative-projection-balance' | 'future-prepay-over-million';
  status: 'OK' | 'WARNING' | 'REVIEW_REQUIRED';
  title: string;
  detail: string;
  findings?: string[];
}

export interface CashflowManagementConfirmation {
  checkId: CashflowManagementCheck['id'];
  decision: 'CONFIRMED' | 'NOT_APPLICABLE';
}

export interface CashflowMonthCloseDepositScheduleRow {
  weekNo: number;
  taxInvoiceIssuedDate: string;
  expectedDepositDate: string;
  expectedDepositAmount?: number | null;
  actualDepositDate: string;
  actualDepositAmount?: number | null;
  actualSource: 'SHEET' | 'BANK_TRANSACTION' | 'DIRECT_ENTRY' | 'NOT_APPLICABLE';
  decision: 'CONFIRMED' | 'NOT_APPLICABLE';
}

export interface CashflowOpeningBalances {
  selectedYear: number;
  projection: {
    amount: number;
    lineAmounts: Record<string, number>;
    sources: Array<{ year: number; lineAmounts: Record<string, number>; lineStates: Record<string, 'EMPTY' | 'ZERO' | 'VALUE'> }>;
    includedYears: number[];
    excludedWeeklyYears: number[];
  };
  actual: {
    amount: number;
    lineAmounts: Record<string, number>;
    sources: Array<{ year: number; lineAmounts: Record<string, number>; lineStates: Record<string, 'EMPTY' | 'ZERO' | 'VALUE'> }>;
    includedYears: number[];
    excludedWeeklyYears: number[];
  };
}

export interface CashflowMonthCloseDraftInput {
  sourceRevision: string;
  targetRevision: string;
  yearMonth: string;
  humanReviewed: boolean;
  depositScheduleRows: CashflowMonthCloseDepositScheduleRow[];
  cells: CashflowMonthCloseCell[];
  confirmations: CashflowMonthCloseConfirmation[];
  managementChecks: CashflowManagementCheck[];
  managementConfirmations: CashflowManagementConfirmation[];
  deadlineSummary: CashflowDeadlineSummary;
}

export interface CashflowDeadlineSummary {
  trackingStartedAt: string | null;
  missedCount: number;
  completedCount: number;
  completedWeeks?: Array<{
    yearMonth: string;
    weekNo: number;
    completedAt: string | null;
    completedBy?: string | null;
  }>;
  weeklyStatuses?: Array<{
    yearMonth: string;
    weekNo: number;
    status: 'ON_TIME' | 'COMPLETED_LATE' | 'MISSED' | 'PENDING';
    lockState?: 'SUBMITTED' | 'LOCKED' | null;
    deadline?: string | null;
    // 조직장 확정 마감(실무자 마감 +13시간). 표시 전용 - 미준수 누적 대상이 아니다.
    approverDeadline?: string | null;
    completedAt?: string | null;
    completedBy?: string | null;
    updateResult?: 'CHANGED' | 'NO_CHANGES' | null;
  }>;
  current: {
    yearMonth: string;
    weekNo: number;
    deadline: string;
    approverDeadline?: string | null;
    completedAt: string | null;
    completedBy?: string | null;
    confirmedAt?: string | null;
    status: 'ON_TIME' | 'COMPLETED_LATE' | 'MISSED' | 'PENDING';
    // SUBMITTED = 완료 요청됨(조직장 확정 대기), LOCKED = 확정, 없음 = 완료 요청 전
    lockState?: 'SUBMITTED' | 'LOCKED' | null;
  } | null;
}

export interface CashflowMonthCloseDashboard {
  source: {
    kind: 'PINNED_MIRROR' | 'MONTH_CLOSE_SNAPSHOT' | 'MONTH_CLOSE_AMENDED_CURRENT';
    status: string;
    sourceRevision: string;
    targetRevision: string;
    capturedAt: string | null;
  };
  project: Record<string, unknown>;
  projectMetadata: { businessType: string; accountType: string; settlementStatus: string };
  sheetMetadata: Record<string, unknown>;
  sheetCalculationChecks: Array<{
    mode: 'projection' | 'actual';
    yearMonth: string;
    weekNo: number;
    reported: {
      depositTotal: number | null;
      withdrawalTotal: number | null;
      balance: number | null;
    };
  }>;
  sheetFormulaValues: {
    status: 'AVAILABLE' | 'UNAVAILABLE';
    reason: string | null;
    sourceRevision: string | null;
    targetRevision: string | null;
    weekly: CashflowMonthCloseDashboard['sheetCalculationChecks'];
    annual: Array<{
      year: number;
      projection: CashflowSheetFormulaModeTotal;
      actual: CashflowSheetFormulaModeTotal;
    }>;
    grandTotals: {
      projection?: CashflowSheetFormulaModeTotal;
      actual?: CashflowSheetFormulaModeTotal;
    };
    projectionActualDifferences: Array<{
      yearMonth: string;
      weekNo: number;
      amount: number | null;
      sourceCell: string;
    }>;
  };
  sheetControlTotals: {
    deposit: {
      sourceCell: string;
      value: number | null;
      computed?: number | null;
      matches?: boolean;
    } | null;
    unpaid: {
      sourceCell: string;
      value: number | null;
    } | null;
  };
  sheetDepositScheduleRows: Array<{
    yearMonth: string;
    weekNo: number;
    taxInvoiceIssuedDate: string;
    expectedDepositDate: string;
    expectedDepositAmount?: number | null;
    sourceCells?: Record<string, string>;
  }>;
  depositScheduleRows: Array<Record<string, unknown>>;
  cells: CashflowMonthCloseCell[];
  confirmations: CashflowMonthCloseConfirmation[];
  managementChecks: CashflowManagementCheck[];
  managementConfirmations: CashflowManagementConfirmation[];
  openingBalances?: CashflowOpeningBalances | null;
  snapshotCompatibility: {
    status: 'LIVE_CURRENT' | 'LIVE_AMENDED' | 'FROZEN_COMPLETE' | 'LEGACY_EVIDENCE_ONLY' | 'AUTHORITY_UNAVAILABLE';
    missingEvidence: Array<'OPENING_BALANCES' | 'LEDGER_WEEKS'>;
  };
  // 주간 준수 이력을 못 읽으면 서버가 null 로 내리고 sectionErrors 로 알린다.
  deadlineSummary: CashflowDeadlineSummary | null;
  projectionActualSummary: CashflowProjectionActualSummary | null;
  cumulativeCloseAuthority: {
    availability: 'AVAILABLE' | 'MISSING' | 'INVALID' | 'UNAVAILABLE';
    status: 'CLOSED' | 'REOPEN_REQUESTED' | null;
    fromMonth: string | null;
    closedThrough: string | null;
    rootHash: string | null;
    headRevision: number | null;
  };
  cumulativeCloseScope: CashflowCumulativeCloseScope | null;
  monthCloseStatuses?: Array<{
    yearMonth: string;
    status: 'OPEN' | 'CLOSED' | 'REOPEN_REQUESTED' | string;
    closeDeadline?: string | null;
    closeDeadlineAt?: string | null;
    approverDeadlineAt?: string | null;
    closeOverdue?: boolean;
    sheetCalculationChecks?: CashflowMonthCloseDashboard['sheetCalculationChecks'] | null;
  }> | null;
  postCloseAdjustment: {
    reason: string;
    changedCount: number;
    changes: Array<{
      mode: 'projection' | 'actual';
      weekNo: number;
      cashflowLine: string;
      beforeAmount: number;
      afterAmount: number;
    }>;
  } | null;
  draftRevision: number | null;
  totals: {
    projection: {
      totalIn: number | null;
      totalOut: number | null;
      balance: number | null;
      rowTotals: Record<string, number>;
      weeks: CashflowModeReadModel['weeks'];
    };
    actual: {
      totalIn: number | null;
      totalOut: number | null;
      balance: number | null;
      rowTotals: Record<string, number>;
      weeks: CashflowModeReadModel['weeks'];
    };
    difference: {
      totalIn: number | null;
      totalOut: number | null;
      balance: number | null;
    };
  };
  comparison: CashflowComparisonMonth | null;
  summary: {
    projectionProgressPercent: number | null;
    projectionContractAmount?: number | null;
    projectionTotalIn?: number | null;
    projectionSalesAndVatTotal?: number | null;
    contractDifference?: number | null;
    contractCoveragePercent?: number | null;
    actualProgressPercent: number | null;
    confirmationProgressPercent: number | null;
    settlementProgressPercent: number | null;
    settlementDifferenceAmount?: number;
    settlementMatches?: boolean;
    settlementCompletedWeekCount: number;
    settlementTargetWeekCount: number;
    settlementIncompleteWeeks: Array<{
      yearMonth: string;
      weekNo: number;
      totalIn: number;
      totalOut: number;
      balance: number;
      reason: 'DIFFERENCE_REVIEW_REQUIRED' | 'SOURCE_INCOMPLETE';
    }>;
    comparisonMatches: boolean;
    comparisonAsOfDate: string;
    comparisonAsOfWeek: { yearMonth: string; weekNo: number };
    evaluatedBusinessDate: string | null;
    cycleYearMonth?: string;
    targetYearMonth?: string;
    closeDeadline: string | null;
    closeDeadlineAt?: string | null;
    approverDeadlineAt?: string | null;
    late: boolean;
  };
  validation: {
    canClose: boolean;
    blockers: Array<{ code: string; message: string; details?: unknown }>;
    warnings: Array<{ code: string; message: string; details?: unknown }>;
  };
  canonical: CashflowSnapshotResult['readModel'] | null;
}

export interface CashflowSheetFormulaModeTotal {
  lineAmounts: Partial<Record<CashflowSheetLineId, number>>;
  lineStates: Partial<Record<CashflowSheetLineId, 'VALUE' | 'ZERO' | 'EMPTY' | 'INVALID'>>;
  totalIn: number | null;
  totalOut: number | null;
  net: number | null;
}

export interface CloseCashflowMonthPayload {
  contractVersion?: 'cashflow-cumulative-close-v2';
  yearMonth: string;
  expectedRevision: number;
  expectedWorkflowRevision: number;
  expectedApproverUid: string;
  expectedProjectVersion: number;
  expectedOpeningBalances: CashflowOpeningBalances;
  closeInput: CashflowMonthCloseDraftInput;
}

export type CashflowMonthCloseRequestStatus = 'BUILDING' | 'PENDING' | 'PENDING_APPROVAL' | 'APPROVING' | 'UNCERTAIN' | 'APPROVED' | 'REOPEN_REQUESTED' | 'REJECTED' | 'REOPENED' | 'WITHDRAWN';

export interface CashflowMonthCloseStoredSource {
  sourceRevision: string | null;
  targetRevision: string | null;
  capturedAt: string | null;
  spreadsheetId: string | null;
  spreadsheetTitle: string | null;
  selectedSheetName: string | null;
  spreadsheetUrl: string | null;
}

export interface CashflowMonthCloseCumulativeTotals {
  projection: number;
  actual: number;
  difference: number;
}

export interface CashflowMonthCloseAnnualSummary extends CashflowMonthCloseCumulativeTotals {
  year: number;
  monthCount: number;
}

export interface CashflowMonthCloseLockRange {
  fromMonth: string;
  fromWeekNo: number;
  throughMonth: string;
  throughWeekNo: number;
}

export interface CashflowCumulativeCloseScope {
  contractVersion: 'cashflow-cumulative-close-v2';
  fromMonth: string;
  throughMonth: string;
  lockRange: CashflowMonthCloseLockRange;
  monthCount: number;
  weekCount: number;
  cellCount: number;
  source: CashflowMonthCloseStoredSource;
}

export interface CashflowMonthCloseMonthSnapshotCell {
  cashflowLine: string;
  cellState: 'VALUE' | 'ZERO' | 'EMPTY';
  amount: number | null;
}

export interface CashflowMonthCloseMonthSnapshot {
  schemaVersion: 1;
  projectId: string;
  yearMonth: string;
  source: {
    sourceRevision: string;
    targetRevision: string;
    capturedAt: string | null;
    spreadsheetId: string | null;
    spreadsheetTitle: string | null;
    selectedSheetName: string | null;
    spreadsheetUrl: string | null;
  };
  projection: {
    totalIn: number;
    totalOut: number;
    balance: number;
    rowTotals: Record<string, number>;
    weeks: Array<CashflowModeReadModel['weeks'][number] & {
      cells: CashflowMonthCloseMonthSnapshotCell[];
    }>;
  };
  actual: {
    totalIn: number;
    totalOut: number;
    balance: number;
    rowTotals: Record<string, number>;
    weeks: Array<CashflowModeReadModel['weeks'][number] & {
      cells: CashflowMonthCloseMonthSnapshotCell[];
    }>;
  };
  difference: {
    totalIn: number;
    totalOut: number;
    balance: number;
  };
}

export interface CashflowMonthCloseRequest {
  documentType: 'MONTHLY_CLOSE';
  contractVersion?: 'cashflow-cumulative-close-v2';
  requestId: string;
  projectId: string;
  yearMonth: string;
  cycleYearMonth?: string;
  monthCloseTargetYearMonth?: string;
  throughMonth?: string;
  status: CashflowMonthCloseRequestStatus;
  canDecideReopen: boolean;
  reopenAuthorityAvailability?: 'ALLOWED' | 'FORBIDDEN' | 'UNAVAILABLE';
  revision: number;
  workflowRevision?: number;
  ledgerRevision?: number;
  fromMonth?: string;
  manifestHash?: string;
  monthCount?: number;
  weekCount?: number;
  cellCount?: number;
  lockRange?: CashflowMonthCloseLockRange;
  source?: CashflowMonthCloseStoredSource;
  totals?: CashflowMonthCloseCumulativeTotals;
  annualSummaries?: CashflowMonthCloseAnnualSummary[];
  approverUid: string;
  approverName?: string;
  requestedByUid: string;
  requestedByName?: string;
  requestedAt: string;
  reviewedByUid: string | null;
  reviewedByName?: string | null;
  reviewedAt: string | null;
  decisionReason: string | null;
  withdrawnAt?: string | null;
  withdrawReason?: string | null;
  reopenRequest?: {
    reason: string | null;
    requestedByUid: string | null;
    requestedAt: string | null;
  } | null;
  reopenDecision?: {
    decision: CashflowMonthReopenDecision | null;
    reason: string | null;
    decidedByUid: string | null;
    decidedAt: string | null;
  } | null;
  reviewWarnings: Array<{ code: string; message: string; details?: unknown }>;
  monthSnapshot: CashflowMonthCloseMonthSnapshot | null;
}

export interface CashflowMonthCloseRevisionDiff {
  requestId: string;
  yearMonth: string;
  currentRevision: number;
  previousRevision: number | null;
  changes: Array<{
    mode: 'projection' | 'actual';
    weekNo: number;
    cashflowLine: string;
    previousState: CashflowMonthCloseMonthSnapshotCell['cellState'] | 'MISSING';
    previousAmount: number | null;
    currentState: CashflowMonthCloseMonthSnapshotCell['cellState'] | 'MISSING';
    currentAmount: number | null;
    amountDelta: number | null;
  }>;
}

export interface ReviewCashflowMonthCloseRequestPayload {
  decision: 'APPROVE' | 'REJECT';
  expectedRevision: number;
  expectedManifestHash?: string;
  reason?: string;
}

export interface CashflowMonthCloseMonthShard {
  contractVersion: 'cashflow-cumulative-close-v2';
  requestId: string;
  projectId: string;
  yearMonth: string;
  shardHash: string;
  cells: Array<CashflowMonthCloseMonthSnapshotCell & {
    mode: 'projection' | 'actual';
    weekNo: number;
  }>;
  source: CashflowMonthCloseStoredSource;
}

export interface CashflowMonthCloseMonthShardPage {
  requestId: string;
  requestRevision: number;
  manifestHash: string;
  monthCount: number;
  months: CashflowMonthCloseMonthShard[];
  nextCursor: string | null;
}

export interface CashflowMonthCloseApproverResult {
  projectId: string;
  executiveApproverId: string;
  executiveApproverName: string;
  executiveApproverEmail: string;
  version: number;
  updatedAt: string;
}

export interface RequestCashflowMonthReopenPayload {
  requestId: string;
  yearMonth: string;
  expectedRevision: number;
  reason: string;
}

export interface DecideCashflowMonthReopenPayload {
  requestId: string;
  yearMonth: string;
  expectedRevision: number;
  decision: CashflowMonthReopenDecision;
  reason: string;
}

export interface CashflowMonthCloseActionDecision {
  enabled: boolean;
  guide: string;
}

export interface CashflowMonthCloseActions {
  completeWeekly: CashflowMonthCloseActionDecision;
  reopenWeekly: CashflowMonthCloseActionDecision;
  confirmWeekly: CashflowMonthCloseActionDecision;
  changeExecutiveApprover: CashflowMonthCloseActionDecision;
  requestMonthClose: CashflowMonthCloseActionDecision & { label: string };
  withdrawMonthClose: CashflowMonthCloseActionDecision;
  requestMonthReopen: CashflowMonthCloseActionDecision;
  cumulativeScope: { ready: boolean; guide: string };
}

export interface CashflowOperationsRate {
  state: 'AVAILABLE' | 'ZERO_CONTRACT' | 'UNAVAILABLE';
  percent: number | null;
  barPercent: number;
  statusLabel: string;
}

export interface CashflowOperationsSummary {
  status: {
    kind: 'ready' | 'review' | 'blocked' | 'unavailable';
    tone: 'success' | 'warning' | 'danger';
    count: number;
    label: string;
    detail: string;
  };
  rates: {
    projection: CashflowOperationsRate;
    actual: CashflowOperationsRate;
  };
}

export interface CashflowMonthClosePresentationYear {
  year: number;
  label: string;
}

export interface CashflowMonthClosePresentationWeek {
  yearMonth: string;
  weekNo: number;
  weekStart: string;
  weekEnd: string;
  label: string;
  isCurrent: boolean;
  monthStatus: 'OPEN' | 'CLOSED' | 'REOPEN_REQUESTED' | null;
  monthStatusLabel: string;
  weeklyStatus: 'ON_TIME' | 'COMPLETED_LATE' | 'MISSED' | 'PENDING' | null;
  weeklyLockState?: 'SUBMITTED' | 'LOCKED' | null;
  weeklyStatusLabel: string;
  statusLabel: string;
  surfaceTone: 'unavailable' | 'closed' | 'danger' | 'warning' | 'success' | 'current' | 'default';
  // 월 결산 기한 초과. 배경(주간 상태)과 별개로 테두리로 그린다.
  overdue: boolean;
}

export interface CashflowMonthClosePresentation {
  asOfDate: string;
  annualBefore: CashflowMonthClosePresentationYear[];
  annualAfter: CashflowMonthClosePresentationYear[];
  weeks: CashflowMonthClosePresentationWeek[];
  months: Array<{
    yearMonth: string;
    label: string;
    columnCount: number;
    status: 'OPEN' | 'CLOSED' | 'REOPEN_REQUESTED' | null;
    locked: boolean;
    overdue: boolean;
    badgeLabel: string;
    tone: 'unavailable' | 'closed' | 'danger' | 'warning' | 'default';
  }>;
  comparison: {
    annualBefore: CashflowMonthClosePresentationYear[];
    annualAfter: CashflowMonthClosePresentationYear[];
    weeks: CashflowMonthClosePresentationWeek[];
    cells: Array<{
      yearMonth: string;
      weekNo: number;
      weekLabel: string;
      weekRange: string;
      difference: number | null;
    }>;
    changed: boolean;
    periodLabel: string;
  };
  monthClose: {
    status?: CashflowSettlementStatus;
    statusLabel: string;
    tone: 'danger' | 'warning' | 'success' | 'neutral';
    approvedAt?: string;
  };
  evidenceSource: 'DASHBOARD';
}

export interface CashflowMonthCloseResult {
  ok: boolean;
  commandName: string;
  projectId: string;
  yearMonth: string;
  cycleYearMonth: string;
  targetYearMonth: string;
  closeDeadline: string;
  closeDeadlineAt: string;
  approverDeadlineAt: string;
  monthState: CashflowMonthCloseRequest | null;
  settlementCycle: CashflowSettlementCycle;
  status: CashflowMonthCloseStatus;
  revision: number;
  reopenCount: number;
  projectWarningCount: number;
  amendmentCount: number;
  postDeadlineAmendmentWarningCount: number;
  lastAmendmentAt: string | null;
  lastAmendmentByUid: string | null;
  lastAmendmentByName: string | null;
  lastAmendmentReason: string | null;
  lastAmendmentDeadline: string | null;
  lastAmendmentPostDeadline: boolean;
  snapshotHash: string | null;
  previousSnapshotHash: string | null;
  snapshot: Record<string, unknown>;
  previousSnapshot: Record<string, unknown>;
  late: boolean;
  closeEligible?: boolean;
  closedAt: string | null;
  closedByUid: string | null;
  closedByName: string | null;
  reopenReason: string | null;
  reopenRequestedAt: string | null;
  reopenRequestedByUid: string | null;
  reopenDecision: CashflowMonthReopenDecision | null;
  reopenDecisionReason: string | null;
  reopenDecidedAt: string | null;
  reopenDecidedByUid: string | null;
  auditId: string | null;
  actions: CashflowMonthCloseActions;
  operationsSummary: CashflowOperationsSummary;
  presentation: CashflowMonthClosePresentation;
  dashboard?: CashflowMonthCloseDashboard;
  blockers?: Array<{ code: string; message: string; details?: unknown }>;
  // 본체(dashboard-source)는 성공했지만 부가 조회가 실패해 일부 섹션이 비었을 때.
  // 화면은 그대로 그리되 이 목록으로 사용자에게 알리고 재시도 경로를 준다.
  sectionErrors?: Array<{ section: 'sheetPublication' | 'deadlineSummary' | string; code: string; label: string; cause?: string }>;
}

export interface CashflowWeeklyUpdateCompletionResult {
  ok?: boolean;
  commandName?: string;
  projectId: string;
  yearMonth: string;
  weekNo: number;
  completedAt: string;
  completedBy: string | null;
  alreadyCompleted: boolean;
  status: 'SUBMITTED' | 'LOCKED' | 'OPEN';
  revision: number;
  reopenCount: number;
  snapshotHash: string;
  sourceRevision: string;
  targetRevision: string;
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenReason: string | null;
  deadline?: string | null;
  complianceStatus?: string | null;
  operationId?: string | null;
  auditId?: string | null;
  updateResult?: 'CHANGED' | 'NO_CHANGES' | null;
}

export interface CashflowWeeklyComplianceItem {
  yearMonth: string;
  weekNo: number;
  deadline: string;
  status: 'PENDING' | 'MISSED' | 'ON_TIME' | 'COMPLETED_LATE';
  lockState?: 'SUBMITTED' | 'LOCKED' | '' | null;
  statusLabel: string;
  completedAt: string | null;
  completedBy: string | null;
  operationId: string | null;
  auditId: string | null;
  updateResult: 'CHANGED' | 'NO_CHANGES' | null;
}

export interface CashflowWeeklyCompliancePage {
  items: CashflowWeeklyComplianceItem[];
  nextCursor: string;
  onTimeCount: number;
  missedCount: number;
}

export type CashflowSettlementPeriod = 'MONTH' | `WEEK_${1 | 2 | 3 | 4 | 5}`;
export type CashflowSettlementStatus = 'WAITING_FOR_UPDATE' | 'SUBMITTED' | 'LOCKED' | 'PENDING_APPROVAL' | 'COMPLETED';

export interface CashflowSettlementStatusItem {
  period: CashflowSettlementPeriod;
  status: CashflowSettlementStatus;
  deadlineAt: string;
  approverDeadlineAt: string;
  submittedAt: string;
  submittedBy: string;
  approvedAt: string;
  approvedBy: string;
  revision: number;
}

export interface CashflowSettlementStatusesResult {
  projectId: string;
  yearMonth: string;
  items: CashflowSettlementStatusItem[];
}

export interface CashflowSettlementStatusesBatchResult {
  items: CashflowSettlementStatusesResult[];
  errors: Array<{ projectId: string; code: 'STATUS_UNAVAILABLE' }>;
}

export interface CashflowProjectionActualSummary {
  projectId: string;
  source: 'SHEET_FORMULA';
  sourceRevision: string;
  fromMonth: string;
  comparisonAsOfWeek: { yearMonth: string; weekNo: number };
  differenceAmount: number;
  settlementDifferenceAmount: number;
  settlementMatches: boolean;
  display?: {
    periodLabel: string;
    statusLabel: string;
    statusTone: 'success' | 'danger';
    differenceLabel: string;
  };
  periods: Array<{
    period: CashflowSettlementPeriod;
    differenceAmount: number | null;
  }>;
}

export interface CashflowProjectionActualSummaryBatch {
  version: string;
  items: CashflowProjectionActualSummary[];
  errors: Array<{
    projectId: string;
    code: 'SUMMARY_UNAVAILABLE';
  }>;
}

export type CashflowSettlementCycleCommand =
  | 'SUBMIT_MONTH_CLOSE'
  | 'WITHDRAW_MONTH_CLOSE'
  | 'APPROVE_MONTH_CLOSE'
  | 'REJECT_MONTH_CLOSE'
  | 'REQUEST_MONTH_REOPEN'
  | 'APPROVE_MONTH_REOPEN'
  | 'REJECT_MONTH_REOPEN'
  | 'CANCEL_ACTIVE_CYCLE';

export interface CashflowSettlementCycle {
  cycleYearMonth: string;
  weeklyYearMonth: string;
  monthCloseTargetYearMonth: string;
  closeDeadline?: string;
  businessState: 'NOT_REQUESTED' | 'SUBMITTED' | 'LOCKED' | 'REOPEN_REQUESTED' | 'REOPENED' | 'REJECTED' | 'WITHDRAWN' | 'INCONSISTENT';
  health: 'OK' | 'RECONCILING' | 'UNAVAILABLE';
  workflowRevision: number;
  monthCloseSettlement: CashflowSettlementStatusItem | null;
  provenance: {
    affectedFromMonth: string;
    affectedThroughMonth: string;
    closedByCycleYearMonth: string;
    approvalVersionId: string;
    requestId: string;
    ledgerRevision: number;
    rootHash: string;
  } | null;
  supersededAttempt: 'REJECTED' | 'WITHDRAWN' | null;
  commandCapabilities: Record<CashflowSettlementCycleCommand, { allowed: boolean; reasonCode: string }>;
}

export interface CashflowWeeklyOverviewResult {
  version: '5';
  yearMonth: string;
  monthCloseTargetYearMonth: string;
  monthCloseTargetLabel: string;
  items: Array<{
    projectId: string;
    settlementStatuses: CashflowSettlementStatusesResult;
    projectionActualSummary: CashflowProjectionActualSummary | null;
    sheetCapturedAt: string | null;
    settlementCycle: CashflowSettlementCycle;
  }>;
  errors: Array<{
    projectId: string;
    code: 'SUMMARY_UNAVAILABLE';
  }>;
}

export interface ProjectCashflowActualSyncResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  projectId: string;
  sourceRows: number;
  sheetCount: number;
  upsertedWeeks: number;
  clearedWeeks: number;
  weeks: Array<{
    yearMonth: string;
    weekNo: number;
    weekStart?: string;
    weekEnd?: string;
    amounts?: Record<string, number>;
  }>;
  cleared: Array<{
    yearMonth: string;
    weekNo: number;
    weekStart?: string;
    weekEnd?: string;
    amounts?: Record<string, number>;
  }>;
  updatedAt: string;
}

export interface CashflowLaborRiskWeek {
  yearMonth: string;
  weekNo: number;
  label: string;
  weekStart: string;
  weekEnd: string;
  weekRange: string;
}

export interface CashflowLaborRiskResult {
  projectId: string;
  asOfDate: string;
  snapshotKind: 'cashflow_labor_risk';
  range: {
    startYearMonth: string;
    endYearMonth: string;
    weekCount: number;
  };
  current: {
    balance: number;
    week: CashflowLaborRiskWeek | null;
  };
  labor: {
    lastMonth: {
      yearMonth: string;
      label: string;
      actualAmount: number;
    };
    latestActualMonth: {
      yearMonth: string;
      label: string;
      actualAmount: number;
    } | null;
    referenceActualAmount: number;
    nextProjection: (CashflowLaborRiskWeek & { amount: number }) | null;
    nextMonthProjection: {
      yearMonth: string;
      label: string;
      isWritten: boolean;
      status: 'written' | 'missing';
      projectionAmount: number;
      laborWeeks: Array<CashflowLaborRiskWeek & { amount: number }>;
    };
    projectionCoverageMonths: Array<{
      yearMonth: string;
      label: string;
      isWritten: boolean;
      status: 'written' | 'missing';
      projectionAmount: number;
      laborWeeks: Array<CashflowLaborRiskWeek & { amount: number }>;
    }>;
    missingProjectionMonths: Array<{
      yearMonth: string;
      label: string;
      referenceActualAmount: number;
      weeks: CashflowLaborRiskWeek[];
    }>;
    balanceAfterNextLabor: number;
  };
  shortage: {
    status: 'ok' | 'warning' | 'danger';
    reliable: boolean;
    week: CashflowLaborRiskWeek | null;
    projectedBalance: number | null;
    shortageAmount: number;
    message: string;
    actions: string[];
  };
  snapshot?: {
    persisted: boolean;
    path: string;
  };
}

export interface BankStatementImportBatchPayload {
  idempotencyKey: string;
  uploadName?: string;
  columns: string[];
  lines: Array<{
    lineIndex: number;
    sourceLineKey: string;
    transactionDate: string;
    counterparty: string;
    memo: string;
    signedAmount: number | null;
    balanceAfter: number;
    rawCells: string[];
  }>;
}

export interface BankStatementImportBatchResult {
  ok: boolean;
  commandName: string;
  projectId: string;
  batchId: string;
  stagedLineCount: number;
  duplicateLineCount: number;
  lines: Array<{
    id: string | null;
    lineIndex: number;
    sourceLineKey: string;
    status: string;
    signedAmount: number;
    duplicate: boolean;
  }>;
  auditId: string;
}

export interface BankStatementImportLineResult {
  id: string;
  batchId: string;
  uploadName: string;
  batchStatus: string;
  batchCreatedBy: string;
  batchCreatedAt: string;
  columns: string[];
  lineIndex: number;
  sourceLineKey: string;
  transactionDate: string;
  counterparty: string;
  memo: string;
  signedAmount: number;
  balanceAfter: number;
  rawCells: string[];
  status: string;
  appliedSheetKey?: string | null;
  appliedRowId?: string | null;
  appliedAt?: string | null;
  appliedBy?: string | null;
}

export interface BankStatementImportLinesResult {
  ok: boolean;
  projectId: string;
  status: string;
  lines: BankStatementImportLineResult[];
}

export interface ApplyBankStatementItemsPayload {
  idempotencyKey: string;
  sheetKey: string;
  expectedSheetVersion?: number | null;
  sheetName?: string;
  items: Array<{
    importLineId: string;
    cells: Array<{
      columnIndex: number;
      rawValue: string;
      userEdited?: boolean;
    }>;
  }>;
}

export interface ApplyBankStatementItemsResult {
  ok: boolean;
  commandName: string;
  projectId: string;
  sheetId: string;
  sheetKey: string;
  sheetVersion: number;
  appliedLineCount: number;
  touchedRows: number[];
  cellIssues?: unknown[];
  actualDelta?: unknown[];
  auditId: string;
}

export interface WeeklyExpenseSheetResult {
  ok: boolean;
  projectId: string;
  sheetId: string;
  sheetKey: string;
  sheetName: string;
  sheetVersion: number;
  rows: Array<{
    id: string;
    rowIndex: number;
    rowVersion: number;
    sourceTxId?: string | null;
    entryKind?: string | null;
    cells: Array<{
      columnIndex: number;
      rawValue: string;
      normalizedValue: string;
      valueType: string;
      validationStatus: string;
      validationMessage?: string | null;
      userEdited: boolean;
    }>;
  }>;
  recentAuditEvents?: unknown[];
}

export interface WeeklyExpenseDraftPayload {
  expectedSheetVersion?: number | null;
  sheetName?: string;
  rows: Array<{
    rowIndex: number;
    tempId?: string;
    sourceTxId?: string;
    entryKind?: string;
    cells: Array<{
      columnIndex: number;
      rawValue: string;
      userEdited?: boolean;
    }>;
  }>;
}

export interface WeeklyExpenseDraftResult {
  ok: boolean;
  commandName: string;
  projectId: string;
  sheetId: string;
  sheetKey: string;
  sheetVersion: number;
  savedRowCount: number;
  savedCellCount: number;
  touchedRows: number[];
  cellIssues: unknown[];
  actualDelta: Array<{
    yearMonth: string;
    weekNo: number;
    cashflowLine: string;
    amount: number;
  }>;
  auditId: string;
}

export interface CashflowVarianceIntent {
  sheetId: string;
  expectedRevision: number;
  action: 'FLAG' | 'REPLY' | 'RESOLVE';
  content?: string;
}

export interface CashflowVarianceMetadataResult {
  week: {
    id: string;
    projectId: string;
    varianceFlag: import('../data/types').VarianceFlag;
    varianceHistory: import('../data/types').VarianceFlagEvent[];
    varianceRevision: number;
    updatedAt: string;
  };
}

export interface WeeklySubmissionStatusIntent {
  yearMonth: string;
  weekNo: number;
  expectedRevision: number;
  changes: {
    projectionEdited?: boolean;
    projectionUpdated?: boolean;
    expenseEdited?: boolean;
    expenseUpdated?: boolean;
    expenseSyncState?: 'pending' | 'review_required' | 'synced' | 'sync_failed';
    expenseReviewPendingCount?: number;
  };
}

export interface WeeklySubmissionStatusMetadataResult {
  status: import('../data/types').WeeklySubmissionStatus;
}

export interface EvidenceRequiredMapIntent {
  expectedRevision: number;
  map: Record<string, string>;
}

export interface EvidenceRequiredMapMetadataResult {
  evidenceRequiredMap: {
    tenantId: string;
    projectId: string;
    map: Record<string, string>;
    evidenceMapRevision: number;
    updatedAt: string;
    updatedBy: string;
  };
}

export interface PlatformApiClientLike {
  get<T>(path: string, options: {
    tenantId: string;
    actor: RequestActor;
    body?: unknown;
    headers?: HeadersInit;
    idempotencyKey?: string;
    requestId?: string;
    signal?: AbortSignal;
    retries?: number;
    timeoutMs?: number;
  }): Promise<{ data: T }>;
  post<T>(path: string, options: {
    tenantId: string;
    actor: RequestActor;
    body?: unknown;
    headers?: HeadersInit;
    idempotencyKey?: string;
    requestId?: string;
    retries?: number;
    timeoutMs?: number;
  }): Promise<{ data: T }>;
  patch<T>(path: string, options: {
    tenantId: string;
    actor: RequestActor;
    body?: unknown;
    headers?: HeadersInit;
    idempotencyKey?: string;
    requestId?: string;
    retries?: number;
    timeoutMs?: number;
  }): Promise<{ data: T }>;
  request<T>(path: string, options: {
    method?: string;
    tenantId: string;
    actor: RequestActor;
    body?: unknown;
    headers?: HeadersInit;
    idempotencyKey?: string;
    requestId?: string;
    retries?: number;
    timeoutMs?: number;
  }): Promise<{ data: T }>;
}

const DEFAULT_BFF_BASE_URL = 'http://127.0.0.1:8787';

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_BFF_BASE_URL;
  return value.trim().replace(/\/$/, '');
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function resolveBrowserBffBaseUrl(configured: string): string {
  if (typeof window === 'undefined' || !window.location?.origin) return configured;
  const runtimeHost = window.location.hostname;
  if (isLoopbackHostname(runtimeHost)) return configured;
  try {
    const configuredUrl = new URL(configured);
    if (
      isLoopbackHostname(configuredUrl.hostname)
      || configuredUrl.hostname.includes('innerplatform-jvm-weekly-api')
    ) {
      return window.location.origin;
    }
  } catch {
    return configured;
  }
  return configured;
}

export function readPlatformApiRuntimeConfig(
  env: Record<string, unknown> = import.meta.env,
): PlatformApiRuntimeConfig {
  const baseUrl = normalizeBaseUrl(env.VITE_PLATFORM_API_BASE_URL);
  return {
    enabled: parseFeatureFlag(env.VITE_PLATFORM_API_ENABLED, false),
    baseUrl: resolveBrowserBffBaseUrl(baseUrl),
  };
}

export function toRequestActor(actor: ActorLike): RequestActor {
  const mapped: RequestActor = {
    id: actor.uid,
    email: actor.email,
    role: actor.role,
  };
  if (actor.idToken) {
    mapped.idToken = actor.idToken;
  }
  return mapped;
}

export function createPlatformApiClient(
  env: Record<string, unknown> = import.meta.env,
): PlatformApiClient {
  const config = readPlatformApiRuntimeConfig(env);
  return new PlatformApiClient({
    baseUrl: config.baseUrl,
    maxRetries: 2,
    retryDelayMs: 200,
    timeoutMs: 4000,
  });
}

export async function fetchProjectsViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  client?: PlatformApiClientLike;
}): Promise<Project[]> {
  const apiClient = resolveClient(params.client);
  const projects: Project[] = [];
  const seenCursors = new Set<string>();
  let cursor = '';

  for (;;) {
    const response = await apiClient.get<{ items: Project[]; nextCursor: string | null }>(
      `/api/v1/projects?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      {
        tenantId: params.tenantId,
        actor: toRequestActor(params.actor),
        timeoutMs: 10000,
      },
    );
    if (Array.isArray(response.data?.items)) {
      projects.push(...response.data.items);
    }
    const nextCursor = typeof response.data?.nextCursor === 'string' ? response.data.nextCursor : '';
    if (!nextCursor || seenCursors.has(nextCursor)) return projects;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export async function fetchParticipationDashboardViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  year?: string;
  ruleId?: string;
  signal?: AbortSignal;
  client?: PlatformApiClientLike;
}): Promise<ParticipationDashboardSnapshot> {
  const query = new URLSearchParams();
  if (/^\d{4}$/.test(params.year || '')) query.set('year', params.year || '');
  if (params.ruleId) query.set('ruleId', params.ruleId);
  const response = await resolveClient(params.client).get<ParticipationDashboardSnapshot>(
    `/api/v1/participation-dashboard${query.size ? `?${query}` : ''}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      signal: params.signal,
      timeoutMs: 10_000,
    },
  );
  return response.data;
}

export async function fetchProjectParticipationViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  client?: PlatformApiClientLike;
}): Promise<ProjectParticipationSnapshot> {
  const response = await resolveClient(params.client).get<ProjectParticipationSnapshot>(
    `/api/v1/participation-dashboard/projects/${encodeURIComponent(params.projectId)}`,
    { tenantId: params.tenantId, actor: toRequestActor(params.actor), timeoutMs: 10_000 },
  );
  return response.data;
}

export async function fetchParticipationSheetPreviewViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  client?: PlatformApiClientLike;
}): Promise<ParticipationSheetPreview> {
  // 시트를 다섯 범위 읽고 해석하므로 목록 조회보다 느리다. 넉넉히 준다.
  const response = await resolveClient(params.client).get<ParticipationSheetPreview>(
    `/api/v1/participation-dashboard/projects/${encodeURIComponent(params.projectId)}/sheet-preview`,
    { tenantId: params.tenantId, actor: toRequestActor(params.actor), timeoutMs: 30_000 },
  );
  return response.data;
}

/**
 * 참여율 시트를 공유해야 할 상대. 전사 하나지만 공유는 사업마다 해야 하므로 폼에서 보여 준다.
 */
export async function fetchParticipationSystemAccountViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  client?: PlatformApiClientLike;
}): Promise<{ systemAccountEmail: string; configured: boolean }> {
  const response = await resolveClient(params.client).get<{ systemAccountEmail: string; configured: boolean }>(
    '/api/v1/participation-dashboard/system-account',
    { tenantId: params.tenantId, actor: toRequestActor(params.actor), timeoutMs: 10_000 },
  );
  return response.data;
}

/**
 * 저장 전 시트 연동. 등록 중에는 사업 문서가 아직 없고, 수정 중에는 화면의 링크가 저장본과
 * 다를 수 있어 링크와 계약 기간을 함께 보낸다. 읽기만 하며 아무것도 쓰지 않는다.
 */
export async function previewParticipationSheetByLinkViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  sheetLink: string;
  contractStart: string;
  contractEnd: string;
  contractEndUndecided?: boolean;
  projectId?: string;
  client?: PlatformApiClientLike;
}): Promise<ParticipationSheetPreview> {
  /*
   * 조회이므로 GET 이다. BFF 는 POST 를 mutating 으로 보고 idempotency-key 헤더를 요구하며,
   * 없으면 요청이 컨텍스트 미들웨어에서 끊긴다(본문 없는 502). 캐시플로우 시트 연동도 같은
   * 규칙이다 - 미러·공유 계정 조회는 GET, stage·apply 는 POST + 멱등키.
   *
   * retries: 0 - 시트 읽기는 쿼터를 쓴다. 실패를 자동으로 되풀이하면 쿼터만 더 먹는다.
   */
  const query = new URLSearchParams({
    sheetLink: params.sheetLink,
    contractStart: params.contractStart,
    contractEnd: params.contractEnd,
    ...(params.contractEndUndecided ? { contractEndUndecided: '1' } : {}),
    ...(params.projectId ? { projectId: params.projectId } : {}),
  });
  const response = await resolveClient(params.client).get<ParticipationSheetPreview>(
    `/api/v1/participation-dashboard/sheet-preview?${query}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      timeoutMs: 30000,
      retries: 0,
    },
  );
  return response.data;
}

export async function saveParticipationRuleViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  id?: string;
  alias: string;
  clientOrgs: string[];
  settlementSystems: string[];
  idempotencyKey: string;
  client?: PlatformApiClientLike;
}): Promise<Pick<ParticipationDashboardRule, 'id' | 'alias' | 'clientOrgs' | 'settlementSystems'>> {
  const response = await resolveClient(params.client).post<Pick<ParticipationDashboardRule, 'id' | 'alias' | 'clientOrgs' | 'settlementSystems'>>(
    '/api/v1/participation-dashboard/rules',
    { tenantId: params.tenantId, actor: toRequestActor(params.actor), body: { id: params.id, alias: params.alias, clientOrgs: params.clientOrgs, settlementSystems: params.settlementSystems }, idempotencyKey: params.idempotencyKey, retries: 0, timeoutMs: 10_000 },
  );
  return response.data;
}

export async function fetchAssignedProjectRequestsViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  client?: PlatformApiClientLike;
}): Promise<{ requests: ProjectRequest[]; projects: Project[] }> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.get<{ items: ProjectRequest[]; projects: Project[] }>(
    '/api/v1/project-requests/assigned-to-me',
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      timeoutMs: 10000,
    },
  );
  return {
    requests: Array.isArray(response.data?.items) ? response.data.items : [],
    projects: Array.isArray(response.data?.projects) ? response.data.projects : [],
  };
}

const PROJECT_REQUEST_PROJECT_ID_BATCH_SIZE = 200;

async function fetchProjectRequestsByProjectIds(params: {
  apiClient: PlatformApiClientLike;
  path: string;
  tenantId: string;
  actor: ActorLike;
  projectIds: string[];
}): Promise<ProjectRequest[]> {
  const projectIds = Array.from(new Set(params.projectIds.map((id) => id.trim()).filter(Boolean)));
  const batches: string[][] = [];
  for (let index = 0; index < projectIds.length; index += PROJECT_REQUEST_PROJECT_ID_BATCH_SIZE) {
    batches.push(projectIds.slice(index, index + PROJECT_REQUEST_PROJECT_ID_BATCH_SIZE));
  }
  const responses = await Promise.all(batches.map((batch) => params.apiClient.post<{ items: ProjectRequest[] }>(
    params.path,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: { projectIds: batch },
      timeoutMs: 10000,
    },
  )));
  const requestsById = new Map<string, ProjectRequest>();
  responses.forEach((response) => {
    if (!Array.isArray(response.data?.items)) return;
    response.data.items.forEach((request) => requestsById.set(request.id, request));
  });
  return Array.from(requestsById.values()).sort((left, right) => (
    String(right.requestedAt || '').localeCompare(String(left.requestedAt || ''))
    || String(left.id).localeCompare(String(right.id))
  ));
}

export async function fetchPendingProjectChangeRequestsViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectIds: string[];
  client?: PlatformApiClientLike;
}): Promise<ProjectRequest[]> {
  const apiClient = resolveClient(params.client);
  return fetchProjectRequestsByProjectIds({
    apiClient,
    path: '/api/v1/project-requests/pending-changes',
    tenantId: params.tenantId,
    actor: params.actor,
    projectIds: params.projectIds,
  });
}

export async function fetchProjectReviewInboxViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectIds: string[];
  client?: PlatformApiClientLike;
}): Promise<ProjectRequest[]> {
  const apiClient = resolveClient(params.client);
  return fetchProjectRequestsByProjectIds({
    apiClient,
    path: '/api/v1/project-requests/review-inbox',
    tenantId: params.tenantId,
    actor: params.actor,
    projectIds: params.projectIds,
  });
}

export async function fetchLatestProjectRequestViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  client?: PlatformApiClientLike;
}): Promise<ProjectRequest | null> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.get<{ item: ProjectRequest | null }>(
    `/api/v1/projects/${encodeURIComponent(params.projectId)}/latest-request`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      timeoutMs: 10000,
    },
  );
  return response.data?.item || null;
}

let defaultPlatformApiClient: PlatformApiClientLike | undefined;

function resolveClient(client?: PlatformApiClientLike): PlatformApiClientLike {
  return client || (defaultPlatformApiClient ||= createPlatformApiClient());
}

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value);
}

export async function upsertProjectViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  project: UpsertProjectPayload;
  client?: PlatformApiClientLike;
}): Promise<{ id: string; tenantId: string; version: number; updatedAt: string }> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<{ id: string; tenantId: string; version: number; updatedAt: string }>('/api/v1/projects', {
    tenantId: params.tenantId,
    actor: toRequestActor(params.actor),
    body: params.project,
  });

  return response.data;
}

/**
 * 종료사업 체크아웃 증빙 업로드.
 *
 * 수정 초안을 거치지 않는다. 이미 승인이 끝난 사업이라 초안으로 올리고 제출하면 조직장
 * 결재가 다시 열린다. 이 경로는 문서 칸과 version 만 올린다.
 */
export async function uploadProjectCheckoutAttachmentViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  documentKind: string;
  file: { name: string; size: number; type?: string; contentBase64: string };
  client?: PlatformApiClientLike;
}): Promise<{ id: string; version: number; updatedAt: string; documentKind: string }> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<{ id: string; version: number; updatedAt: string; documentKind: string }>(
    `/api/v1/projects/${params.projectId}/checkout-attachments/${params.documentKind}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: {
        fileName: params.file.name,
        fileSize: params.file.size,
        mimeType: params.file.type || 'application/pdf',
        contentBase64: params.file.contentBase64,
      },
    },
  );

  return response.data;
}

export async function trashProjectViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  payload: TrashProjectPayload;
  client?: PlatformApiClientLike;
}): Promise<{ id: string; tenantId: string; version: number; updatedAt: string; trashedAt: string }> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<{ id: string; tenantId: string; version: number; updatedAt: string; trashedAt: string }>(
    `/api/v1/projects/${params.projectId}/trash`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.payload,
    },
  );

  return response.data;
}

export async function restoreProjectViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  payload: RestoreProjectPayload;
  client?: PlatformApiClientLike;
}): Promise<{ id: string; tenantId: string; version: number; updatedAt: string }> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<{ id: string; tenantId: string; version: number; updatedAt: string }>(
    `/api/v1/projects/${params.projectId}/restore`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.payload,
    },
  );

  return response.data;
}

export async function upsertLedgerViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  ledger: UpsertLedgerPayload;
  client?: PlatformApiClientLike;
}): Promise<{ id: string; tenantId: string; version: number; updatedAt: string }> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<{ id: string; tenantId: string; version: number; updatedAt: string }>('/api/v1/ledgers', {
    tenantId: params.tenantId,
    actor: toRequestActor(params.actor),
    body: params.ledger,
  });
  return response.data;
}

export async function upsertTransactionViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  transaction: UpsertTransactionPayload;
  lease?: CashflowMutationLease;
  client?: PlatformApiClientLike;
}): Promise<{ id: string; tenantId: string; version: number; updatedAt: string; state: string }> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<{ id: string; tenantId: string; version: number; updatedAt: string; state: string }>('/api/v1/transactions', {
    tenantId: params.tenantId,
    actor: toRequestActor(params.actor),
    body: params.transaction,
    ...(params.lease ? { headers: cashflowMutationHeaders(params.lease) } : {}),
  });
  return response.data;
}

export async function changeTransactionStateViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  transactionId: string;
  newState: TransactionState;
  expectedVersion: number;
  reason?: string;
  lease?: CashflowMutationLease;
  client?: PlatformApiClientLike;
}): Promise<{ id: string; state: string; rejectedReason: string | null; version: number; updatedAt: string }> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.request<{ id: string; state: string; rejectedReason: string | null; version: number; updatedAt: string }>(
    `/api/v1/transactions/${params.transactionId}/state`,
    {
      method: 'PATCH',
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: {
        newState: params.newState,
        expectedVersion: params.expectedVersion,
        reason: params.reason,
      },
      ...(params.lease ? { headers: cashflowMutationHeaders(params.lease) } : {}),
    },
  );

  return response.data;
}

export async function addCommentViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  transactionId: string;
  comment: CreateCommentPayload;
  lease?: CashflowMutationLease;
  client?: PlatformApiClientLike;
}): Promise<{ id: string; transactionId: string; version: number; createdAt: string }> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<{ id: string; transactionId: string; version: number; createdAt: string }>(
    `/api/v1/transactions/${params.transactionId}/comments`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.comment,
      ...(params.lease ? { headers: cashflowMutationHeaders(params.lease) } : {}),
    },
  );
  return response.data;
}

export async function addEvidenceViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  transactionId: string;
  evidence: CreateEvidencePayload;
  lease?: CashflowMutationLease;
  client?: PlatformApiClientLike;
}): Promise<{ id: string; transactionId: string; version: number; uploadedAt: string }> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<{ id: string; transactionId: string; version: number; uploadedAt: string }>(
    `/api/v1/transactions/${params.transactionId}/evidences`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.evidence,
      ...(params.lease ? { headers: cashflowMutationHeaders(params.lease) } : {}),
    },
  );
  return response.data;
}

export async function fetchAuthGovernanceUsersViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  client?: PlatformApiClientLike;
}): Promise<AuthGovernanceDirectoryResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.get<AuthGovernanceDirectoryResult>(
    '/api/v1/admin/auth-governance/users',
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      timeoutMs: 10000,
    },
  );
  return response.data;
}

export async function deepSyncAuthGovernanceUserViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  identityKey: string;
  role: string;
  reason?: string;
  client?: PlatformApiClientLike;
}): Promise<AuthGovernanceDeepSyncResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<AuthGovernanceDeepSyncResult>(
    `/api/v1/admin/auth-governance/users/${encodeURIComponent(params.identityKey)}/deep-sync`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: {
        role: params.role,
        ...(params.reason ? { reason: params.reason } : {}),
      },
      timeoutMs: 10000,
    },
  );
  return response.data;
}

export async function deepSyncAuthGovernanceUsersViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  items: Array<{ identityKey: string; role: string }>;
  reason: string;
  client?: PlatformApiClientLike;
}): Promise<AuthGovernanceBulkDeepSyncResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<AuthGovernanceBulkDeepSyncResult>(
    '/api/v1/admin/auth-governance/users/deep-sync-bulk',
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: { items: params.items, reason: params.reason },
      timeoutMs: 120000,
    },
  );
  return response.data;
}

/**
 * 기타 역할명 후보. 원천은 프로젝트 문서에 이미 저장된 값이고, 서버가 모아서 돌려준다.
 * 실패해도 화면은 그대로 쓴다 - 직접 입력이 본래 동작이고 목록은 편의다.
 */
export async function fetchProjectStaffingRolesViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  signal?: AbortSignal;
  client?: PlatformApiClientLike;
}): Promise<string[]> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.get<{ roles: unknown }>(
    '/api/v1/projects/staffing-roles',
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      signal: params.signal,
      timeoutMs: 10000,
    },
  );
  const roles = response.data?.roles;
  if (!Array.isArray(roles)) throw new Error('역할 목록 응답이 올바르지 않습니다.');
  return roles.filter((role): role is string => typeof role === 'string' && role.trim() !== '');
}

// ── 인력 명부 (persons) ──
// 명부는 BFF 를 통해서만 읽고 쓴다. 화면이 Firestore 를 직접 만지면 감사 기록이 남지 않고,
// 명부는 참여율·정산 서류의 근거라 누가 언제 계약을 바꿨는지가 반드시 남아야 한다.

export async function fetchPersonsViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  signal?: AbortSignal;
  client?: PlatformApiClientLike;
}): Promise<{
  items: PersonRecord[];
  total: number;
  capabilities: { professionalProfileRead: boolean; professionalProfileWrite: boolean };
}> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.get<{
    items: PersonRecord[];
    total: number;
    capabilities: { professionalProfileRead: boolean; professionalProfileWrite: boolean };
  }>(
    '/api/v1/persons',
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      signal: params.signal,
      timeoutMs: 10000,
    },
  );
  return response.data;
}

export interface MyHrProfileResponse {
  linked: boolean;
  person: PersonRecord | null;
  profile: {
    educationRecords: Array<Record<string, unknown>>;
    englishEvidence: Array<Record<string, unknown>>;
    certifications: Array<{ key: string; label: string; acquiredAt: string | null }>;
  } | null;
}

/** 내 인사정보. 남의 것은 못 보고 자기 것만 본다 - 인사 담당자 조회 경로와 다른 문이다. */
export async function fetchMyHrProfileViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  signal?: AbortSignal;
  client?: PlatformApiClientLike;
}): Promise<MyHrProfileResponse> {
  const response = await resolveClient(params.client).get<MyHrProfileResponse>(
    '/api/v1/persons/me/hr-profile',
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      signal: params.signal,
      timeoutMs: 10000,
    },
  );
  return response.data;
}

/** 인적사항 수정. 계약 이력과 달리 사람이 적는 값이라 부분 갱신(merge)으로 보낸다. */
/** 본인 기본정보 수정. 대상은 서버가 로그인 계정의 uid 로 정한다. */
export async function updateMyPersonProfileViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  profile: { nickname?: string; birthDate?: string | null; workLocation?: string };
  client?: PlatformApiClientLike;
}): Promise<{ personId: string; updatedAt: string }> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.patch<{ personId: string; updatedAt: string }>(
    '/api/v1/persons/me/profile',
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.profile,
      timeoutMs: 15000,
    },
  );
  return response.data;
}

export async function updatePersonProfileViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  personId: string;
  profile: {
    nickname?: string;
    email?: string;
    departmentTop?: string;
    departmentMid?: string;
    departmentSub?: string;
    title?: string;
    grade?: string;
    workLocation?: string;
    birthDate?: string | null;
    note?: string;
  };
  client?: PlatformApiClientLike;
}): Promise<{ personId: string; updatedAt: string }> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.patch<{ personId: string; updatedAt: string }>(
    `/api/v1/persons/${encodeURIComponent(params.personId)}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.profile,
      timeoutMs: 15000,
    },
  );
  return response.data;
}

export async function changePersonEmploymentViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  personId: string;
  mode: 'change' | 'add';
  type: string;
  state: string;
  effectiveFrom: string;
  endDate?: string | null;
  note?: string;
  client?: PlatformApiClientLike;
}): Promise<{ personId: string; employments: PersonEmploymentRecord[]; updatedAt: string }> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<{ personId: string; employments: PersonEmploymentRecord[]; updatedAt: string }>(
    `/api/v1/persons/${encodeURIComponent(params.personId)}/employments`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: {
        mode: params.mode,
        type: params.type,
        state: params.state,
        effectiveFrom: params.effectiveFrom,
        ...(params.endDate ? { endDate: params.endDate } : {}),
        ...(params.note ? { note: params.note } : {}),
      },
      timeoutMs: 15000,
    },
  );
  return response.data;
}

export async function createPersonViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  idempotencyKey: string;
  person: {
    name: string;
    nickname?: string;
    email?: string;
    departmentTop?: string;
    title?: string;
    grade?: string;
    note?: string;
    employment: { type: string; state: string; effectiveFrom: string; endDate?: string | null; note?: string };
    professionalProfile?: ProfessionalProfileInput;
  };
  client?: PlatformApiClientLike;
}): Promise<{
  person: PersonRecord;
  professionalProfile?: { revision: number; changed: boolean };
}> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<{
    person: PersonRecord;
    professionalProfile?: { revision: number; changed: boolean };
  }>(
    '/api/v1/persons',
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.person,
      idempotencyKey: params.idempotencyKey,
      retries: 0,
      timeoutMs: 15000,
    },
  );
  return response.data;
}

// 근로형태·재직상태는 도메인 타입을 그대로 쓴다. 여기서 string 으로 느슨하게 두면
// 서버가 새 값을 보내도 컴파일이 통과해 화면에서만 조용히 깨진다.
export interface PersonEmploymentRecord {
  id: string;
  type: EmploymentType;
  state: EmploymentState;
  startDate: string;
  endDate: string | null;
  note: string;
}

export interface PersonRecord {
  personId: string;
  name: string;
  nickname: string;
  email: string;
  departmentTop: string;
  departmentMid: string;
  departmentSub: string;
  title: string;
  grade: string;
  /** 생년월일 (YYYY-MM-DD). 만 나이는 저장하지 않고 조회 시 계산한다. */
  birthDate: string;
  workLocation: string;
  joinedAt: string | null;
  employments: PersonEmploymentRecord[];
  uid: string | null;
  note?: string;
  /** 인사정보 읽기 권한이 있을 때만 실린다. 원문이 아니라 화면이 바로 읽을 요약이다. */
  hrSummary?: {
    highestEducationDisplayText: string;
    highestDegreeYear: string;
    highestEducationCode: string;
    highestEducationInstitution: string;
    highestEducationMajor: string;
    englishEvidenceDisplayText: string;
    certificationsDisplayText: string;
  };
}

export async function provisionProjectEvidenceDriveRootViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  client?: PlatformApiClientLike;
}): Promise<ProvisionProjectEvidenceDriveRootResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<ProvisionProjectEvidenceDriveRootResult>(
    `/api/v1/projects/${params.projectId}/evidence-drive/root/provision`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
    },
  );
  return response.data;
}

export async function previewGoogleSheetImportViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  value: string;
  sheetName?: string;
  client?: PlatformApiClientLike;
}): Promise<GoogleSheetImportPreviewResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<GoogleSheetImportPreviewResult>(
    `/api/v1/projects/${params.projectId}/google-sheet-import/preview`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      headers: params.actor.googleAccessToken
        ? { 'x-google-access-token': params.actor.googleAccessToken }
        : undefined,
      body: {
        value: params.value,
        ...(params.sheetName ? { sheetName: params.sheetName } : {}),
      },
      timeoutMs: 20000,
    },
  );
  return response.data;
}

export async function analyzeGoogleSheetImportViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  spreadsheetTitle?: string;
  selectedSheetName: string;
  matrix: string[][];
  client?: PlatformApiClientLike;
}): Promise<GoogleSheetMigrationAnalysisResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<GoogleSheetMigrationAnalysisResult>(
    `/api/v1/projects/${params.projectId}/google-sheet-import/analyze`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: {
        ...(params.spreadsheetTitle ? { spreadsheetTitle: params.spreadsheetTitle } : {}),
        selectedSheetName: params.selectedSheetName,
        matrix: params.matrix,
      },
      timeoutMs: 25000,
    },
  );
  return normalizeGoogleSheetMigrationAnalysisResult(response.data);
}

export async function uploadProjectSheetSourceViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  upload: ProjectSheetSourceUploadPayload;
  client?: PlatformApiClientLike;
}): Promise<ProjectSheetSourceSnapshot> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<ProjectSheetSourceSnapshot>(
    `/api/v1/projects/${params.projectId}/sheet-sources/upload`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.upload,
      timeoutMs: 45000,
    },
  );
  return response.data;
}

export async function analyzeProjectRequestContractViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  fileName: string;
  documentText?: string;
  client?: PlatformApiClientLike;
}): Promise<ProjectRequestContractAnalysisResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<ProjectRequestContractAnalysisResult>(
    '/api/v1/project-requests/contract/analyze',
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: {
        fileName: params.fileName,
        ...(params.documentText ? { documentText: params.documentText } : {}),
      },
      timeoutMs: 45000,
    },
  );
  return normalizeProjectRequestContractAnalysisResult(response.data);
}

export async function uploadProjectRequestContractViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  upload: ProjectRequestContractUploadPayload;
  client?: PlatformApiClientLike;
}) {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<{
    path: string;
    name: string;
    downloadURL: string;
    size: number;
    contentType: string;
    uploadedAt: string;
  }>(
    '/api/v1/project-requests/contract/upload',
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.upload,
      timeoutMs: 45000,
    },
  );
  return response.data;
}

export async function processProjectRequestContractViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  file: File;
  client?: PlatformApiClientLike;
}): Promise<{
  contractDocument: {
    path: string;
    name: string;
    downloadURL: string;
    size: number;
    contentType: string;
    uploadedAt: string;
  };
  analysis: ProjectRequestContractAnalysisResult;
}> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.request<{
    contractDocument: {
      path: string;
      name: string;
      downloadURL: string;
      size: number;
      contentType: string;
      uploadedAt: string;
    };
    analysis: ProjectRequestContractAnalysisResult;
  }>(
    '/api/v1/project-requests/contract/process',
    {
      method: 'POST',
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-name': encodeHeaderValue(params.file.name),
        'x-file-type': params.file.type || 'application/pdf',
        'x-file-size': String(params.file.size || 0),
      },
      body: params.file,
      timeoutMs: 45000,
      retries: 0,
    },
  );
  return {
    contractDocument: response.data.contractDocument,
    analysis: normalizeProjectRequestContractAnalysisResult(response.data.analysis),
  };
}

export async function notifyProjectRequestRegistrationViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectRequestId: string;
  client?: PlatformApiClientLike;
}): Promise<ProjectRequestRegistrationNotificationResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<ProjectRequestRegistrationNotificationResult>(
    `/api/v1/project-requests/${encodeURIComponent(params.projectRequestId)}/notify-registration`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: {},
      idempotencyKey: `project-request-registration-notify:${params.projectRequestId}`,
      timeoutMs: 10000,
      retries: 0,
    },
  );
  return response.data;
}

export async function reviewProjectExecutiveStatusViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  review: ProjectExecutiveReviewPayload;
  client?: PlatformApiClientLike;
}): Promise<ProjectExecutiveReviewResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<ProjectExecutiveReviewResult>(
    `/api/v1/projects/${encodeURIComponent(params.projectId)}/executive-review`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: normalizeProjectExecutiveReviewPayload(params.review),
      timeoutMs: 10000,
      retries: 0,
    },
  );
  return response.data;
}

export async function resubmitProjectExecutiveReviewViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  payload: ProjectExecutiveReviewResubmitPayload;
  client?: PlatformApiClientLike;
}): Promise<ProjectExecutiveReviewResubmitResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<ProjectExecutiveReviewResubmitResult>(
    `/api/v1/projects/${encodeURIComponent(params.projectId)}/executive-review/resubmit`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: normalizeProjectExecutiveReviewResubmitPayload(params.payload),
      timeoutMs: 10000,
      retries: 0,
    },
  );
  return response.data;
}

export async function reviewProjectManagementPlanningStatusViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  review: ProjectManagementPlanningReviewPayload;
  client?: PlatformApiClientLike;
}): Promise<ProjectManagementPlanningReviewResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<ProjectManagementPlanningReviewResult>(
    `/api/v1/projects/${encodeURIComponent(params.projectId)}/management-planning-review`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: normalizeProjectManagementPlanningReviewPayload(params.review),
      timeoutMs: 10000,
      retries: 0,
    },
  );
  return response.data;
}

export async function linkProjectEvidenceDriveRootViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  value: string;
  client?: PlatformApiClientLike;
}): Promise<LinkProjectEvidenceDriveRootResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<LinkProjectEvidenceDriveRootResult>(
    `/api/v1/projects/${params.projectId}/evidence-drive/root/link`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: { value: params.value },
    },
  );
  return response.data;
}

export async function provisionTransactionEvidenceDriveViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  transactionId: string;
  lease?: CashflowMutationLease;
  client?: PlatformApiClientLike;
}): Promise<ProvisionTransactionEvidenceDriveResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.request<ProvisionTransactionEvidenceDriveResult>(
    `/api/v1/transactions/${params.transactionId}/evidence-drive/provision`,
    {
      method: 'POST',
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      retries: 0,
      timeoutMs: 15000,
      ...(params.lease ? { headers: cashflowMutationHeaders(params.lease) } : {}),
    },
  );
  return response.data;
}

export async function syncTransactionEvidenceDriveViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  transactionId: string;
  lease?: CashflowMutationLease;
  client?: PlatformApiClientLike;
}): Promise<SyncTransactionEvidenceDriveResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.request<SyncTransactionEvidenceDriveResult>(
    `/api/v1/transactions/${params.transactionId}/evidence-drive/sync`,
    {
      method: 'POST',
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      retries: 0,
      timeoutMs: 20000,
      ...(params.lease ? { headers: cashflowMutationHeaders(params.lease) } : {}),
    },
  );
  return response.data;
}

export async function uploadTransactionEvidenceDriveViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  transactionId: string;
  upload: UploadTransactionEvidenceDrivePayload;
  lease?: CashflowMutationLease;
  client?: PlatformApiClientLike;
}): Promise<UploadTransactionEvidenceDriveResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.request<UploadTransactionEvidenceDriveResult>(
    `/api/v1/transactions/${params.transactionId}/evidence-drive/upload`,
    {
      method: 'POST',
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.upload,
      retries: 0,
      timeoutMs: 30000,
      ...(params.lease ? { headers: cashflowMutationHeaders(params.lease) } : {}),
    },
  );
  return response.data;
}

export async function processBusinessCardViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  upload: BusinessCardProcessPayload;
  client?: PlatformApiClientLike;
}): Promise<BusinessCardImportResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<BusinessCardImportResult>(
    '/api/v1/business-card-imports/process',
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.upload,
      retries: 0,
      timeoutMs: 60000,
    },
  );
  return {
    ...response.data,
    extracted: normalizeBusinessCardExtraction(response.data.extracted),
  };
}

export async function listBusinessCardImportsViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  status?: 'needs_review' | 'saved' | 'failed';
  client?: PlatformApiClientLike;
}): Promise<{ items: BusinessCardImportListItem[]; count: number; nextCursor: string | null }> {
  const apiClient = resolveClient(params.client);
  const searchParams = new URLSearchParams();
  if (params.status) searchParams.set('status', params.status);
  const response = await apiClient.get<{ items: BusinessCardImportListItem[]; count: number; nextCursor: string | null }>(
    `/api/v1/business-card-imports${searchParams.size ? `?${searchParams.toString()}` : ''}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      timeoutMs: 10000,
    },
  );
  return {
    ...response.data,
    items: (response.data.items || []).map((item) => ({
      ...item,
      extracted: item.extracted ? normalizeBusinessCardExtraction(item.extracted) : null,
    })),
  };
}

export async function confirmBusinessCardImportViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  importId: string;
  contact: BusinessCardConfirmPayload;
  client?: PlatformApiClientLike;
}): Promise<BusinessCardConfirmResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<BusinessCardConfirmResult>(
    `/api/v1/business-card-imports/${encodeURIComponent(params.importId)}/confirm`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.contact,
      retries: 0,
      timeoutMs: 20000,
    },
  );
  return response.data;
}

export async function searchContactsViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  query: string;
  client?: PlatformApiClientLike;
}): Promise<{ items: ContactSearchResult[]; count: number; nextCursor: string | null }> {
  const apiClient = resolveClient(params.client);
  const searchParams = new URLSearchParams();
  searchParams.set('query', params.query);
  const response = await apiClient.get<{ items: ContactSearchResult[]; count: number; nextCursor: string | null }>(
    `/api/v1/contacts?${searchParams.toString()}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      timeoutMs: 10000,
    },
  );
  return response.data;
}

export async function updateContactViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  contactId: string;
  contact: BusinessCardConfirmPayload;
  client?: PlatformApiClientLike;
}): Promise<ContactUpdateResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.patch<ContactUpdateResult>(
    `/api/v1/contacts/${encodeURIComponent(params.contactId)}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.contact,
      retries: 0,
      timeoutMs: 20000,
    },
  );
  return response.data;
}

export async function overrideTransactionEvidenceDriveCategoriesViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  transactionId: string;
  overrides: OverrideTransactionEvidenceDriveCategoriesPayload;
  client?: PlatformApiClientLike;
}): Promise<SyncTransactionEvidenceDriveResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.request<SyncTransactionEvidenceDriveResult>(
    `/api/v1/transactions/${params.transactionId}/evidence-drive/overrides`,
    {
      method: 'POST',
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.overrides,
      retries: 0,
      timeoutMs: 15000,
    },
  );
  return response.data;
}

export async function upsertCashflowWeekAmountsViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  payload: CashflowWeekAmountsPayload;
  idempotencyKey: string;
  lease: CashflowMutationLease;
  finalize?: boolean;
  client?: PlatformApiClientLike;
}): Promise<CashflowWeekAmountsResult> {
  if (params.payload.mode !== 'projection') {
    throw new Error('Canonical actual cashflow must be saved through a weekly expense sheet');
  }
  return saveCashflowProjectionBatchViaBff({
    tenantId: params.tenantId,
    actor: params.actor,
    projectId: params.projectId,
    idempotencyKey: params.idempotencyKey,
    lease: params.lease,
    finalize: params.finalize,
    client: params.client,
    lines: Object.entries(params.payload.amounts).map(([cashflowLine, amount]) => ({
      yearMonth: params.payload.yearMonth,
      weekNo: params.payload.weekNo,
      cashflowLine,
      amount,
    })),
  });
}

export async function applyCashflowVarianceIntentViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  intent: CashflowVarianceIntent;
  idempotencyKey: string;
  lease: CashflowMutationLease;
  client?: PlatformApiClientLike;
}): Promise<CashflowVarianceMetadataResult> {
  const response = await resolveClient(params.client).post<CashflowVarianceMetadataResult>(
    `/api/v1/cashflow-metadata/${encodeURIComponent(params.projectId)}/variance`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.intent,
      headers: cashflowMutationHeaders(params.lease),
      idempotencyKey: params.idempotencyKey,
      retries: 0,
      timeoutMs: 12_000,
    },
  );
  return response.data;
}

export async function applyWeeklySubmissionStatusIntentViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  intent: WeeklySubmissionStatusIntent;
  idempotencyKey: string;
  lease: CashflowMutationLease;
  client?: PlatformApiClientLike;
}): Promise<WeeklySubmissionStatusMetadataResult> {
  const response = await resolveClient(params.client).post<WeeklySubmissionStatusMetadataResult>(
    `/api/v1/cashflow-metadata/${encodeURIComponent(params.projectId)}/weekly-submission-status`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.intent,
      headers: cashflowMutationHeaders(params.lease),
      idempotencyKey: params.idempotencyKey,
      retries: 0,
      timeoutMs: 12_000,
    },
  );
  return response.data;
}

export async function applyEvidenceRequiredMapIntentViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  intent: EvidenceRequiredMapIntent;
  idempotencyKey: string;
  lease: CashflowMutationLease;
  client?: PlatformApiClientLike;
}): Promise<EvidenceRequiredMapMetadataResult> {
  const response = await resolveClient(params.client).post<EvidenceRequiredMapMetadataResult>(
    `/api/v1/cashflow-metadata/${encodeURIComponent(params.projectId)}/evidence-required-map`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.intent,
      headers: cashflowMutationHeaders(params.lease),
      idempotencyKey: params.idempotencyKey,
      retries: 0,
      timeoutMs: 12_000,
    },
  );
  return response.data;
}

export async function saveCashflowProjectionBatchViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  lines: Array<{ yearMonth: string; weekNo: number; cashflowLine: string; amount: number }>;
  idempotencyKey: string;
  lease: CashflowMutationLease;
  finalize?: boolean;
  client?: PlatformApiClientLike;
}): Promise<CashflowWeekAmountsResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<CashflowWeekAmountsResult>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/projection`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: { lines: params.lines },
      headers: {
        ...cashflowMutationHeaders(params.lease),
        ...(params.finalize ? { 'x-edit-finalize': 'true' } : {}),
      },
      idempotencyKey: params.idempotencyKey,
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return response.data;
}

export async function fetchCashflowSnapshotViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  asOf?: string;
  rangeStart?: CashflowRangeBoundary;
  rangeEnd?: CashflowRangeBoundary;
  client?: PlatformApiClientLike;
}): Promise<CashflowSnapshotResult> {
  const apiClient = resolveClient(params.client);
  const query = new URLSearchParams();
  if (params.asOf) query.set('asOf', params.asOf);
  if (params.rangeStart) query.set('rangeStart', `${params.rangeStart.yearMonth}:${params.rangeStart.weekNo}`);
  if (params.rangeEnd) query.set('rangeEnd', `${params.rangeEnd.yearMonth}:${params.rangeEnd.weekNo}`);
  const serializedQuery = query.toString();
  const queryString = serializedQuery ? `?${serializedQuery}` : '';
  const response = await apiClient.get<CashflowSnapshotResult>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}${queryString}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      retries: 0,
      timeoutMs: 20000,
    },
  );
  return response.data;
}

const cashflowMonthCloseRequests = new WeakMap<
  PlatformApiClientLike,
  Map<string, Promise<CashflowMonthCloseResult>>
>();

export async function fetchCashflowMonthCloseViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  yearMonth: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowMonthCloseResult> {
  const client = resolveClient(params.client);
  let clientRequests = cashflowMonthCloseRequests.get(client);
  if (!clientRequests) {
    clientRequests = new Map();
    cashflowMonthCloseRequests.set(client, clientRequests);
  }
  const requestKey = [params.tenantId, params.actor.uid, params.projectId, params.yearMonth].join(':');
  const existing = clientRequests.get(requestKey);
  if (existing) return existing;

  const request = (async () => {
    const response = await client.get<CashflowMonthCloseResult>(
      `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/month-close?yearMonth=${encodeURIComponent(params.yearMonth)}`,
      {
        tenantId: params.tenantId,
        actor: toRequestActor(params.actor),
        retries: 0,
        timeoutMs: 27_000,
      },
    );
    return response.data;
  })();
  clientRequests.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (clientRequests.get(requestKey) === request) clientRequests.delete(requestKey);
  }
}

export async function completeCashflowWeeklyUpdateViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  yearMonth?: string;
  weekNo?: number;
  updateResult: 'CHANGED' | 'NO_CHANGES';
  ignoreProjectionValidation?: boolean;
  projectionValidationEvidenceHash?: string;
  projectionValidationIssueCount?: number;
  client?: PlatformApiClientLike;
}): Promise<CashflowWeeklyUpdateCompletionResult> {
  const hasExplicitScope = params.yearMonth !== undefined || params.weekNo !== undefined;
  const response = await resolveClient(params.client).post<CashflowWeeklyUpdateCompletionResult>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/weekly-update-complete`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: {
        ...(hasExplicitScope ? { yearMonth: params.yearMonth, weekNo: params.weekNo } : {}),
        updateResult: params.updateResult,
        ...(params.ignoreProjectionValidation ? {
          ignoreProjectionValidation: true,
          projectionValidationEvidenceHash: params.projectionValidationEvidenceHash,
          projectionValidationIssueCount: params.projectionValidationIssueCount,
        } : {}),
      },
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return response.data;
}

export async function fetchCashflowWeeklyUpdateViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  yearMonth: string;
  weekNo: number;
  client?: PlatformApiClientLike;
}): Promise<CashflowWeeklyUpdateCompletionResult> {
  const query = new URLSearchParams({
    yearMonth: params.yearMonth,
    weekNo: String(params.weekNo),
  });
  const response = await resolveClient(params.client).get<CashflowWeeklyUpdateCompletionResult>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/weekly-update-complete?${query.toString()}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return response.data;
}

export async function fetchCashflowWeeklyComplianceViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  limit?: number;
  cursor?: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowWeeklyCompliancePage> {
  const query = new URLSearchParams({ limit: String(params.limit || 50) });
  if (params.cursor) query.set('cursor', params.cursor);
  const response = await resolveClient(params.client).get<CashflowWeeklyCompliancePage>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/weekly-update-compliance?${query.toString()}`,
    { tenantId: params.tenantId, actor: toRequestActor(params.actor), retries: 0, timeoutMs: 12000 },
  );
  return response.data;
}

const cashflowSettlementPeriods = new Set<CashflowSettlementPeriod>([
  'MONTH', 'WEEK_1', 'WEEK_2', 'WEEK_3', 'WEEK_4', 'WEEK_5',
]);
const cashflowMonthSettlementStatuses = new Set<CashflowSettlementStatus>([
  'WAITING_FOR_UPDATE', 'SUBMITTED', 'LOCKED',
]);
const cashflowWeekSettlementStatuses = new Set<CashflowSettlementStatus>([
  'WAITING_FOR_UPDATE', 'PENDING_APPROVAL', 'COMPLETED',
]);

function isCashflowSettlementInstant(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value) return false;
  const match = /^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isCashflowSettlementStatusItem(value: unknown): value is CashflowSettlementStatusItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.period !== 'string' || !cashflowSettlementPeriods.has(item.period as CashflowSettlementPeriod)) return false;
  const statuses = item.period === 'MONTH' ? cashflowMonthSettlementStatuses : cashflowWeekSettlementStatuses;
  return typeof item.status === 'string'
    && statuses.has(item.status as CashflowSettlementStatus)
    && typeof item.submittedAt === 'string'
    && typeof item.submittedBy === 'string'
    && typeof item.approvedAt === 'string'
    && typeof item.approvedBy === 'string'
    && Number.isSafeInteger(item.revision)
    && Number(item.revision) >= 0
    && (item.submittedAt === '' || isCashflowSettlementInstant(item.submittedAt))
    && (item.approvedAt === '' || isCashflowSettlementInstant(item.approvedAt))
    && isCashflowSettlementInstant(item.deadlineAt)
    && isCashflowSettlementInstant(item.approverDeadlineAt);
}

function isCashflowSettlementStatusesResult(
  value: unknown,
  projectId: string,
  yearMonth: string,
): value is CashflowSettlementStatusesResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const settlement = value as Record<string, unknown>;
  const items = Array.isArray(settlement.items) ? settlement.items : [];
  const periodKeys = items.map((item) => (
    item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>).period : undefined
  ));
  return settlement.projectId === projectId
    && settlement.yearMonth === yearMonth
    && Array.isArray(settlement.items)
    && items.length === cashflowSettlementPeriods.size
    && items.every(isCashflowSettlementStatusItem)
    && new Set(periodKeys).size === periodKeys.length;
}

export async function fetchCashflowSettlementStatusesBatchViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectIds: string[];
  yearMonth: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowSettlementStatusesBatchResult> {
  const response = await resolveClient(params.client).post<CashflowSettlementStatusesBatchResult>(
    '/api/v1/cashflow/settlement-statuses/batch',
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: { projectIds: params.projectIds, ...(params.yearMonth ? { yearMonth: params.yearMonth } : {}) },
      retries: 0,
      timeoutMs: 12000,
    },
  );
  const result = response.data;
  const requestedIds = new Set(params.projectIds);
  const itemIds = Array.isArray(result?.items) ? result.items.map((item) => item?.projectId) : [];
  const errorIds = Array.isArray(result?.errors) ? result.errors.map((error) => error?.projectId) : [];
  const returnedIds = [...itemIds, ...errorIds];
  if (requestedIds.size !== params.projectIds.length
    || !Array.isArray(result?.items)
    || result.items.some((item) => !requestedIds.has(item?.projectId)
      || !isCashflowSettlementStatusesResult(item, item?.projectId, params.yearMonth))
    || !Array.isArray(result?.errors)
    || result.errors.some((error) => error?.code !== 'STATUS_UNAVAILABLE'
      || !requestedIds.has(error?.projectId))
    || returnedIds.length !== params.projectIds.length
    || new Set(returnedIds).size !== returnedIds.length) {
    throw new Error('현금흐름 정산 상태 응답이 올바르지 않습니다.');
  }
  return result;
}

export async function transitionCashflowSettlementStatusViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  yearMonth: string;
  period: Exclude<CashflowSettlementPeriod, 'MONTH'>;
  action: 'SUBMIT' | 'APPROVE';
  client?: PlatformApiClientLike;
}): Promise<CashflowSettlementStatusesResult> {
  const response = await resolveClient(params.client).post<CashflowSettlementStatusesResult>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/settlement-statuses/transition`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: { yearMonth: params.yearMonth, period: params.period, action: params.action },
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return response.data;
}

export async function fetchCashflowProjectionActualSummariesViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectIds: string[];
  yearMonth?: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowProjectionActualSummaryBatch> {
  const response = await resolveClient(params.client).post<CashflowProjectionActualSummaryBatch>(
    '/api/v1/cashflow/projection-actual-summary/batch',
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: { projectIds: params.projectIds, yearMonth: params.yearMonth },
      retries: 0,
      timeoutMs: 12000,
    },
  );
  const result = response.data;
  const requestedIds = new Set(params.projectIds);
  const itemIds = Array.isArray(result?.items) ? result.items.map((item) => item?.projectId) : [];
  const errorIds = Array.isArray(result?.errors) ? result.errors.map((error) => error?.projectId) : [];
  if (result?.version !== '2'
    || !Array.isArray(result?.items)
    || result.items.length > params.projectIds.length
    || itemIds.some((projectId) => !requestedIds.has(projectId))
    || new Set(itemIds).size !== itemIds.length
    || result.items.some((item) => item?.source !== 'SHEET_FORMULA'
      || typeof item?.sourceRevision !== 'string'
      || !Number.isFinite(item?.differenceAmount)
      || !Number.isFinite(item?.settlementDifferenceAmount)
      || typeof item?.settlementMatches !== 'boolean'
      || !Array.isArray(item?.periods)
      || item.periods.some((period) => !['MONTH', 'WEEK_1', 'WEEK_2', 'WEEK_3', 'WEEK_4', 'WEEK_5'].includes(period?.period)
        || (period?.differenceAmount !== null && !Number.isFinite(period?.differenceAmount))))
    || !Array.isArray(result?.errors)
    || result.errors.length > params.projectIds.length
    || result.errors.some((error) => error?.code !== 'SUMMARY_UNAVAILABLE' || !requestedIds.has(error?.projectId))
    || new Set(errorIds).size !== errorIds.length
    || errorIds.some((projectId) => itemIds.includes(projectId))) {
    throw new Error('JVM 누적 Projection-Actual 요약 응답이 올바르지 않습니다.');
  }
  return result;
}

export async function fetchCashflowWeeklyOverviewViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectIds: string[];
  yearMonth: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowWeeklyOverviewResult> {
  const response = await resolveClient(params.client).post<CashflowWeeklyOverviewResult>(
    '/api/v1/cashflow/weekly-overview',
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: { projectIds: params.projectIds, yearMonth: params.yearMonth },
      retries: 0,
      timeoutMs: 12000,
    },
  );
  const result = response.data;
  const requestedIds = new Set(params.projectIds);
  const [cycleYear, cycleMonth] = params.yearMonth.split('-').map(Number);
  const expectedMonthCloseTargetYearMonth = cycleMonth === 1
    ? `${cycleYear - 1}-12`
    : `${cycleYear}-${String(cycleMonth - 1).padStart(2, '0')}`;
  const itemIds = Array.isArray(result?.items) ? result.items.map((item) => item?.projectId) : [];
  const cycleCommands = new Set([
    'SUBMIT_MONTH_CLOSE', 'WITHDRAW_MONTH_CLOSE', 'APPROVE_MONTH_CLOSE', 'REJECT_MONTH_CLOSE',
    'REQUEST_MONTH_REOPEN', 'APPROVE_MONTH_REOPEN', 'REJECT_MONTH_REOPEN', 'CANCEL_ACTIVE_CYCLE',
  ]);
  const objectValue = (value: unknown): Record<string, any> | null => (
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
  );
  const validSummary = (summary: CashflowProjectionActualSummary | null, projectId: string) => {
    if (summary === null) return true;
    const periodKeys = Array.isArray(summary?.periods) ? summary.periods.map((period) => period?.period) : [];
    return summary?.projectId === projectId
      && summary.source === 'SHEET_FORMULA'
      && typeof summary.sourceRevision === 'string'
      && /^20\d{2}-(0[1-9]|1[0-2])$/.test(summary.fromMonth)
      && /^20\d{2}-(0[1-9]|1[0-2])$/.test(summary.comparisonAsOfWeek?.yearMonth)
      && Number.isInteger(summary.comparisonAsOfWeek?.weekNo)
      && summary.comparisonAsOfWeek.weekNo >= 1
      && summary.comparisonAsOfWeek.weekNo <= 5
      && Number.isSafeInteger(summary.differenceAmount)
      && Number.isSafeInteger(summary.settlementDifferenceAmount)
      && typeof summary.settlementMatches === 'boolean'
      && typeof summary.display?.periodLabel === 'string'
      && typeof summary.display.statusLabel === 'string'
      && ['success', 'danger'].includes(summary.display.statusTone)
      && typeof summary.display.differenceLabel === 'string'
      && Array.isArray(summary.periods)
      && summary.periods.every((period) => cashflowSettlementPeriods.has(period?.period)
        && (period?.differenceAmount === null || Number.isSafeInteger(period?.differenceAmount)))
      && new Set(periodKeys).size === periodKeys.length;
  };
  const validCycle = (cycle: CashflowSettlementCycle) => {
    const source = objectValue(cycle);
    const capabilities = objectValue(source?.commandCapabilities);
    const provenance = source?.provenance === null ? null : objectValue(source?.provenance);
    const monthCloseSettlement = source?.monthCloseSettlement === null ? null : objectValue(source?.monthCloseSettlement);
    const capabilityNames = capabilities ? Object.keys(capabilities) : [];
    return Boolean(source)
      && source?.cycleYearMonth === params.yearMonth
      && source?.weeklyYearMonth === params.yearMonth
      && source?.monthCloseTargetYearMonth === result.monthCloseTargetYearMonth
      && isIsoCalendarDate(source?.closeDeadline)
      && ['NOT_REQUESTED', 'SUBMITTED', 'LOCKED', 'REOPEN_REQUESTED', 'REOPENED', 'REJECTED', 'WITHDRAWN', 'INCONSISTENT'].includes(source?.businessState)
      && ['OK', 'RECONCILING', 'UNAVAILABLE'].includes(source?.health)
      && Number.isSafeInteger(source?.workflowRevision)
      && source.workflowRevision >= (source.businessState === 'INCONSISTENT' ? -1 : 0)
      && (source?.monthCloseSettlement === null
        || (Boolean(monthCloseSettlement) && isCashflowSettlementStatusItem(monthCloseSettlement)
          && monthCloseSettlement?.period === 'MONTH'))
      && (source?.provenance === null || (Boolean(provenance)
        && /^20\d{2}-(0[1-9]|1[0-2])$/.test(provenance?.affectedFromMonth)
        && /^20\d{2}-(0[1-9]|1[0-2])$/.test(provenance?.affectedThroughMonth)
        && /^20\d{2}-(0[1-9]|1[0-2])$/.test(provenance?.closedByCycleYearMonth)
        && typeof provenance?.approvalVersionId === 'string'
        && typeof provenance?.requestId === 'string'
        && Number.isSafeInteger(provenance?.ledgerRevision)
        && /^sha256:[a-f0-9]{64}$/.test(provenance?.rootHash)))
      && [null, 'REJECTED', 'WITHDRAWN'].includes(source?.supersededAttempt)
      && capabilityNames.length === cycleCommands.size
      && capabilityNames.every((command) => cycleCommands.has(command))
      && capabilityNames.every((command) => {
        const capability = objectValue(capabilities?.[command]);
        return typeof capability?.allowed === 'boolean'
          && typeof capability?.reasonCode === 'string'
          && (capability.allowed ? capability.reasonCode === '' : /^[A-Z][A-Z0-9_]*$/.test(capability.reasonCode));
      });
  };
  const errorKeys = Array.isArray(result?.errors)
    ? result.errors.map((error) => `${error?.projectId}:${error?.code}`)
    : [];
  if (result?.version !== '5'
    || result?.yearMonth !== params.yearMonth
    || result?.monthCloseTargetYearMonth !== expectedMonthCloseTargetYearMonth
    || typeof result?.monthCloseTargetLabel !== 'string'
    || !Array.isArray(result?.items)
    || itemIds.length !== params.projectIds.length
    || itemIds.some((projectId) => !requestedIds.has(projectId))
    || new Set(itemIds).size !== itemIds.length
    || result.items.some((item) => !isCashflowSettlementStatusesResult(item?.settlementStatuses, item?.projectId, params.yearMonth)
      || !validCycle(item?.settlementCycle)
      || !validSummary(item?.projectionActualSummary, item?.projectId)
      || (item?.sheetCapturedAt !== null && !isCashflowSettlementInstant(item?.sheetCapturedAt)))
    || !Array.isArray(result?.errors)
    || result.errors.some((error) => !requestedIds.has(error?.projectId)
      || error?.code !== 'SUMMARY_UNAVAILABLE')
    || new Set(errorKeys).size !== errorKeys.length) {
    throw new Error('현금흐름 현황 응답이 올바르지 않습니다.');
  }
  return result;
}

// 주정산 확정: 완료 요청된 주를 프로젝트 조직장이 잠금으로 확정. revision 은 BFF 가 읽는다.
export async function confirmCashflowWeeklyUpdateViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  yearMonth: string;
  weekNo: number;
  client?: PlatformApiClientLike;
}): Promise<CashflowWeeklyUpdateCompletionResult> {
  const response = await resolveClient(params.client).post<CashflowWeeklyUpdateCompletionResult>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/weekly-update-complete/confirm`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: { yearMonth: params.yearMonth, weekNo: params.weekNo },
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return response.data;
}

// 주정산 회수: 완료 요청 상태에서 사유 없이 즉시. 현재 revision 은 BFF 가 완료 기록에서 읽는다.
export async function reopenCashflowWeeklyUpdateViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  yearMonth: string;
  weekNo: number;
  /** 조직장이 확정한 주를 되돌릴 때만 필요하다. BFF·JVM 은 이미 받고 있다. */
  reason?: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowWeeklyUpdateCompletionResult> {
  const response = await resolveClient(params.client).post<CashflowWeeklyUpdateCompletionResult>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/weekly-update-complete/reopen`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: {
        yearMonth: params.yearMonth,
        weekNo: params.weekNo,
        ...(params.reason ? { reason: params.reason } : {}),
      },
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return response.data;
}

export async function fetchCashflowActivityViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  source?: CashflowActivitySource;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
  client?: PlatformApiClientLike;
}): Promise<CashflowActivityPage> {
  const query = new URLSearchParams({ limit: String(params.limit ?? 50) });
  if (params.source) query.set('source', params.source);
  if (params.cursor) query.set('cursor', params.cursor);
  const response = await resolveClient(params.client).get<CashflowActivityPage>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/activity?${query.toString()}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      signal: params.signal,
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return response.data;
}

export async function fetchCashflowAppliedCellChangesViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  limit?: number;
  cursor?: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowAppliedCellChangePage> {
  const query = new URLSearchParams({ limit: String(params.limit ?? 50) });
  if (params.cursor) query.set('cursor', params.cursor);
  const response = await resolveClient(params.client).get<CashflowAppliedCellChangePage>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/applied-cell-changes?${query.toString()}`,
    { tenantId: params.tenantId, actor: toRequestActor(params.actor), retries: 0, timeoutMs: 12000 },
  );
  return response.data;
}

export async function requestCashflowMonthCloseViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  payload: CloseCashflowMonthPayload;
  idempotencyKey: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowMonthCloseRequest> {
  const response = await resolveClient(params.client).post<CashflowMonthCloseRequest>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/month-close/requests`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: { ...params.payload, settlementCycle: true },
      idempotencyKey: params.idempotencyKey,
      retries: 0,
      timeoutMs: 27_000,
    },
  );
  return response.data;
}

export async function saveCashflowMonthCloseApproverViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  payload: { approverUid: string; yearMonth: string; expectedVersion?: number };
  idempotencyKey: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowMonthCloseApproverResult> {
  const response = await resolveClient(params.client).post<CashflowMonthCloseApproverResult>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/month-close/approver`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.payload,
      idempotencyKey: params.idempotencyKey,
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return response.data;
}

export async function fetchPendingCashflowMonthCloseRequestsViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  client?: PlatformApiClientLike;
}): Promise<CashflowMonthCloseRequest[]> {
  const response = await resolveClient(params.client).get<{ items: CashflowMonthCloseRequest[] }>(
    '/api/v1/cashflow/month-close/requests/pending',
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return Array.isArray(response.data.items) ? response.data.items : [];
}

export async function fetchCashflowMonthCloseRequestMonthsViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  requestId: string;
  requestRevision: number;
  cursor?: string;
  limit?: number;
  client?: PlatformApiClientLike;
}): Promise<CashflowMonthCloseMonthShardPage> {
  const query = new URLSearchParams({ limit: String(params.limit ?? 12) });
  if (params.cursor) query.set('cursor', params.cursor);
  const response = await resolveClient(params.client).get<CashflowMonthCloseMonthShardPage>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/month-close/requests/${encodeURIComponent(params.requestId)}/months?${query.toString()}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return response.data;
}

export async function fetchCashflowMonthCloseRevisionDiffViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  requestId: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowMonthCloseRevisionDiff> {
  const response = await resolveClient(params.client).get<CashflowMonthCloseRevisionDiff>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/month-close/requests/${encodeURIComponent(params.requestId)}/revision-diff`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return response.data;
}

export async function reviewCashflowMonthCloseRequestViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  requestId: string;
  payload: ReviewCashflowMonthCloseRequestPayload;
  idempotencyKey: string;
  client?: PlatformApiClientLike;
}): Promise<{
  request: CashflowMonthCloseRequest;
}> {
  const response = await resolveClient(params.client).post<{
    request: CashflowMonthCloseRequest;
  }>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/month-close/requests/${encodeURIComponent(params.requestId)}/${params.payload.expectedManifestHash ? 'status-review' : 'review'}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: { ...params.payload, settlementCycle: true },
      idempotencyKey: params.idempotencyKey,
      retries: 0,
      timeoutMs: 12_000,
    },
  );
  if (
    params.payload.decision === 'APPROVE'
    && response.data.request.status !== 'APPROVED'
  ) {
    throw new Error('월 결산 승인 상태를 확인하지 못했습니다.');
  }
  return response.data;
}

export async function approveCashflowMonthCloseUntilLedgerClosed(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  requestId: string;
  payload: ReviewCashflowMonthCloseRequestPayload;
  idempotencyKey: string;
  client?: PlatformApiClientLike;
}) {
  return reviewCashflowMonthCloseRequestViaBff(params);
}

export async function withdrawCashflowMonthCloseRequestViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  requestId: string;
  payload: {
    cycleYearMonth: string;
    monthCloseTargetYearMonth: string;
    expectedRevision: number;
    expectedManifestHash: string;
    expectedWorkflowRevision: number;
    reason: string;
  };
  idempotencyKey: string;
  client?: PlatformApiClientLike;
}): Promise<{ request: CashflowMonthCloseRequest }> {
  const response = await resolveClient(params.client).post<{ request: CashflowMonthCloseRequest }>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/month-close/requests/${encodeURIComponent(params.requestId)}/withdraw`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: { ...params.payload, settlementCycle: true },
      idempotencyKey: params.idempotencyKey,
      retries: 0,
      timeoutMs: 12000,
    },
  );
  if (response.data.request.status !== 'WITHDRAWN') {
    throw new Error('월 결산 요청 회수 결과를 확인하지 못했습니다.');
  }
  return response.data;
}

export async function requestCashflowMonthReopenViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  payload: RequestCashflowMonthReopenPayload;
  idempotencyKey: string;
  client?: PlatformApiClientLike;
}): Promise<{ request: CashflowMonthCloseRequest }> {
  const response = await resolveClient(params.client).post<{ request: CashflowMonthCloseRequest }>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/month-close/reopen-request`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: { ...params.payload, settlementCycle: true },
      idempotencyKey: params.idempotencyKey,
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return response.data;
}

export async function decideCashflowMonthReopenViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  payload: DecideCashflowMonthReopenPayload;
  idempotencyKey: string;
  client?: PlatformApiClientLike;
}): Promise<{ request: CashflowMonthCloseRequest }> {
  const response = await resolveClient(params.client).post<{ request: CashflowMonthCloseRequest }>(
    `/api/v1/cashflow/${encodeURIComponent(params.projectId)}/month-close/reopen-decision`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: { ...params.payload, settlementCycle: true },
      idempotencyKey: params.idempotencyKey,
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return response.data;
}

export async function syncProjectCashflowActualsViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  client?: PlatformApiClientLike;
}): Promise<ProjectCashflowActualSyncResult> {
  const snapshot = await fetchCashflowSnapshotViaBff(params);
  const weeks = snapshot.readModel.months.flatMap((month) => month.actual.weeks.map((week) => ({
    yearMonth: month.yearMonth,
    weekNo: week.weekNo,
    amounts: week.amounts,
  })));
  return {
    ok: true,
    projectId: snapshot.projectId,
    sourceRows: snapshot.actual.length,
    sheetCount: new Set(snapshot.actual.map((line) => line.sheetKey)).size,
    upsertedWeeks: weeks.length,
    clearedWeeks: 0,
    weeks,
    cleared: [],
    updatedAt: new Date().toISOString(),
  };
}

export async function readWeeklyExpenseSheetViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  sheetKey?: string;
  client?: PlatformApiClientLike;
}): Promise<WeeklyExpenseSheetResult> {
  const apiClient = resolveClient(params.client);
  const sheetKey = params.sheetKey || 'default';
  const response = await apiClient.get<WeeklyExpenseSheetResult>(
    `/api/v1/weekly-expenses/${encodeURIComponent(params.projectId)}/sheets/${encodeURIComponent(sheetKey)}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return response.data;
}

export async function saveWeeklyExpenseDraftViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  sheetKey?: string;
  payload: WeeklyExpenseDraftPayload;
  idempotencyKey: string;
  lease: CashflowMutationLease;
  finalize?: boolean;
  client?: PlatformApiClientLike;
}): Promise<WeeklyExpenseDraftResult> {
  const apiClient = resolveClient(params.client);
  const sheetKey = params.sheetKey || 'default';
  const response = await apiClient.post<WeeklyExpenseDraftResult>(
    `/api/v1/weekly-expenses/${encodeURIComponent(params.projectId)}/sheets/${encodeURIComponent(sheetKey)}/save-draft`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.payload,
      headers: {
        ...cashflowMutationHeaders(params.lease),
        ...(params.finalize ? { 'x-edit-finalize': 'true' } : {}),
      },
      idempotencyKey: params.idempotencyKey,
      retries: 0,
      timeoutMs: 20000,
    },
  );
  return response.data;
}

export async function fetchCashflowLaborRiskViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  client?: PlatformApiClientLike;
}): Promise<CashflowLaborRiskResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.get<CashflowLaborRiskResult>(
    `/api/v1/projects/${encodeURIComponent(params.projectId)}/cashflow-labor-risk`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return response.data;
}

export async function importBankStatementBatchViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  payload: BankStatementImportBatchPayload;
  idempotencyKey: string;
  lease: CashflowMutationLease;
  finalize?: boolean;
  client?: PlatformApiClientLike;
}): Promise<BankStatementImportBatchResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<BankStatementImportBatchResult>(
    `/api/v1/weekly-expenses/${encodeURIComponent(params.projectId)}/bank-statements/import-batch`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.payload,
      headers: {
        ...cashflowMutationHeaders(params.lease),
        ...(params.finalize ? { 'x-edit-finalize': 'true' } : {}),
      },
      idempotencyKey: params.idempotencyKey,
      retries: 0,
      timeoutMs: 20000,
    },
  );
  return response.data;
}

export async function applyBankStatementItemsViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  payload: ApplyBankStatementItemsPayload;
  idempotencyKey: string;
  lease: CashflowMutationLease;
  finalize?: boolean;
  client?: PlatformApiClientLike;
}): Promise<ApplyBankStatementItemsResult> {
  const apiClient = resolveClient(params.client);
  const response = await apiClient.post<ApplyBankStatementItemsResult>(
    `/api/v1/weekly-expenses/${encodeURIComponent(params.projectId)}/bank-statements/apply-items`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      body: params.payload,
      headers: {
        ...cashflowMutationHeaders(params.lease),
        ...(params.finalize ? { 'x-edit-finalize': 'true' } : {}),
      },
      idempotencyKey: params.idempotencyKey,
      retries: 0,
      timeoutMs: 20000,
    },
  );
  return response.data;
}

export async function listBankStatementImportLinesViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  status?: 'staged' | 'applied' | 'all';
  client?: PlatformApiClientLike;
}): Promise<BankStatementImportLinesResult> {
  const apiClient = resolveClient(params.client);
  const suffix = params.status ? `?status=${encodeURIComponent(params.status)}` : '';
  const response = await apiClient.get<BankStatementImportLinesResult>(
    `/api/v1/weekly-expenses/${encodeURIComponent(params.projectId)}/bank-statements/import-lines${suffix}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      retries: 0,
      timeoutMs: 12000,
    },
  );
  return response.data;
}

export function isPlatformApiEnabled(): boolean {
  return featureFlags.platformApiEnabled;
}

function resolveBinaryErrorMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '파일 다운로드 요청에 실패했습니다.';
  try {
    const parsed = JSON.parse(trimmed) as { message?: string; error?: string };
    return parsed.message || parsed.error || trimmed;
  } catch {
    return trimmed;
  }
}

function parseContentDispositionFileName(headerValue: string | null): string {
  const value = String(headerValue || '').trim();
  if (!value) return '';
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const basicMatch = value.match(/filename="([^"]+)"/i) || value.match(/filename=([^;]+)/i);
  return basicMatch?.[1]?.trim() || '';
}

export async function exportCashflowWorkbookViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  body: {
    scope: 'all' | 'single' | 'selected';
    projectId?: string;
    projectIds?: string[];
    accountType?: AccountType;
    accountTypes?: AccountType[];
    department?: string;
    sortBy?: 'PROJECT_NAME' | 'DEPARTMENT';
    startYearMonth: string;
    endYearMonth: string;
    variant: 'single-project' | 'combined' | 'multi-sheet';
  };
}): Promise<{ blob: Blob; fileName: string }> {
  const config = readPlatformApiRuntimeConfig();
  const headers = buildStandardHeaders({
    tenantId: params.tenantId,
    actor: toRequestActor(params.actor),
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
  });
  const response = await fetch(`${config.baseUrl}/api/v1/cashflow-exports`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params.body),
  });

  if (!response.ok) {
    throw new Error(resolveBinaryErrorMessage(await response.text()));
  }

  return {
    blob: await response.blob(),
    fileName: parseContentDispositionFileName(response.headers.get('content-disposition')) || 'cashflow-export.xlsx',
  };
}

// ─── Budget Suggestion ───────────────────────────────────────────────────────

export interface BudgetSuggestion {
  budgetCategory: string;
  budgetSubCategory: string;
  /** 'history' = 과거 거래 패턴 기반, 'codebook' = 코드북 키워드 매칭 */
  confidence: 'history' | 'codebook';
}

/**
 * 거래처 이름 기반 비목/세목 제안을 BFF에서 조회한다.
 * 히스토리가 없으면 null 반환.
 */
export async function fetchBudgetSuggestionViaBff(params: {
  tenantId: string;
  actor: ActorLike;
  projectId: string;
  counterparty: string;
  client?: PlatformApiClientLike;
}): Promise<BudgetSuggestion | null> {
  if (!params.counterparty.trim() || !params.projectId.trim()) return null;
  const apiClient = resolveClient(params.client);
  const qs = new URLSearchParams({
    counterparty: params.counterparty.trim(),
    projectId: params.projectId.trim(),
  });
  const response = await apiClient.get<{ suggestion: BudgetSuggestion | null }>(
    `/api/v1/budget/suggest?${qs}`,
    {
      tenantId: params.tenantId,
      actor: toRequestActor(params.actor),
      retries: 0,
      timeoutMs: 3000,
    },
  );
  return response.data.suggestion ?? null;
}
