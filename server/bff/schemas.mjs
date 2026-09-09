import { z } from 'zod';
import {
  PROJECT_INFO_DOCUMENT_KINDS,
  PROJECT_REGISTRATION_DOCUMENT_KINDS,
} from './project-document-validation.mjs';

const NON_EMPTY_STRING = z.string().trim().min(1);
const RECORD_UNKNOWN = z.record(z.string(), z.unknown());

const PROJECT_REGISTRATION_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const PROJECT_REGISTRATION_ATTACHMENT_BASE64_MAX_LENGTH = 14 * 1024 * 1024;

export const projectRegistrationDraftCreateSchema = z.object({
  payload: z.unknown().optional().default({}),
  stepIndex: z.number().int().nonnegative().optional().default(0),
}).strict();

export const projectRegistrationDraftAliasSchema = z.object({
  alias: z.string().max(60),
}).strict();

export const projectRegistrationDraftPatchSchema = z.object({
  expectedDraftRevision: z.number().int().nonnegative(),
  payload: z.unknown(),
  stepIndex: z.number().int().nonnegative().optional(),
}).strict();

// 내용은 둘 중 하나로 온다: 작은 파일은 base64 인라인, 큰 파일은 서명 URL 로 스토리지에
// 직접 올린 뒤 그 경로(storagePath). Vercel 요청 본문 4.5MB 한도 때문에 큰 파일은
// 인라인으로 올 수 없다.
const projectDraftAttachmentBaseSchema = z.object({
  expectedDraftRevision: z.number().int().nonnegative(),
  documentKind: z.enum(PROJECT_REGISTRATION_DOCUMENT_KINDS),
  fileName: NON_EMPTY_STRING.max(300),
  mimeType: NON_EMPTY_STRING.max(200),
  fileSize: z.number().int().positive().max(PROJECT_REGISTRATION_ATTACHMENT_MAX_BYTES),
  contentBase64: NON_EMPTY_STRING.max(PROJECT_REGISTRATION_ATTACHMENT_BASE64_MAX_LENGTH).optional(),
  storagePath: NON_EMPTY_STRING.max(1024).optional(),
}).strict();
const exactlyOneContent = (value) => Boolean(value.contentBase64) !== Boolean(value.storagePath);
const exactlyOneContentMessage = { message: 'contentBase64 또는 storagePath 중 정확히 하나가 필요합니다.' };

export const projectRegistrationDraftAttachmentSchema = projectDraftAttachmentBaseSchema
  .refine(exactlyOneContent, exactlyOneContentMessage);

/** 서명 URL 발급 요청. 내용 없이 이름·종류·크기만 미리 검증한다. */
export const projectRegistrationDraftAttachmentUploadUrlSchema = z.object({
  documentKind: z.enum(PROJECT_REGISTRATION_DOCUMENT_KINDS),
  fileName: NON_EMPTY_STRING.max(300),
  mimeType: NON_EMPTY_STRING.max(200),
  fileSize: z.number().int().positive().max(PROJECT_REGISTRATION_ATTACHMENT_MAX_BYTES),
}).strict();

export const projectDraftAttachmentDeleteSchema = z.object({
  expectedDraftRevision: z.number().int().nonnegative(),
}).strict();

export const projectRegistrationDraftSubmitSchema = z.object({
  expectedDraftRevision: z.number().int().nonnegative(),
}).strict();

export const projectInfoDraftOpenSchema = z.object({}).strict();

export const projectInfoDraftPatchSchema = z.object({
  expectedDraftRevision: z.number().int().nonnegative(),
  payload: z.unknown(),
  stepIndex: z.number().int().nonnegative().optional(),
}).strict();

export const projectInfoDraftAttachmentSchema = projectDraftAttachmentBaseSchema.extend({
  documentKind: z.enum(PROJECT_INFO_DOCUMENT_KINDS),
}).refine(exactlyOneContent, exactlyOneContentMessage);

export const projectInfoDraftAttachmentUploadUrlSchema = projectRegistrationDraftAttachmentUploadUrlSchema.extend({
  documentKind: z.enum(PROJECT_INFO_DOCUMENT_KINDS),
});

export const projectInfoDraftRebaseSchema = z.object({
  expectedDraftRevision: z.number().int().nonnegative(),
  // Absent means "preview only": report the merge outcome without writing.
  resolutions: z.record(z.string().min(1), z.enum(['MINE', 'THEIRS'])).optional(),
}).strict();

export const projectInfoDraftSubmitSchema = z.object({
  expectedDraftRevision: z.number().int().nonnegative(),
  expectedVersion: z.number().int().positive(),
  resubmit: z.boolean().optional().default(false),
  reviewComment: z.string().trim().max(2000).optional(),
}).strict();

export const projectUpsertSchema = z.object({
  id: NON_EMPTY_STRING,
  name: NON_EMPTY_STRING,
  expectedVersion: z.number().int().nonnegative().optional(),
}).passthrough();

export const ledgerUpsertSchema = z.object({
  id: NON_EMPTY_STRING,
  projectId: NON_EMPTY_STRING,
  name: NON_EMPTY_STRING,
  expectedVersion: z.number().int().nonnegative().optional(),
}).passthrough();

export const transactionUpsertSchema = z.object({
  id: NON_EMPTY_STRING,
  projectId: NON_EMPTY_STRING,
  ledgerId: NON_EMPTY_STRING,
  counterparty: NON_EMPTY_STRING,
  state: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']).optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
}).passthrough();

export const transactionStateSchema = z.object({
  newState: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']),
  reason: z.string().trim().optional(),
  expectedVersion: z.number().int().positive(),
}).strict();

export const commentCreateSchema = z.object({
  id: NON_EMPTY_STRING.optional(),
  content: NON_EMPTY_STRING,
  authorName: NON_EMPTY_STRING.optional(),
  projectId: NON_EMPTY_STRING.optional(),
  targetType: z.enum(['transaction', 'expense_sheet_row']).optional(),
  sheetRowId: NON_EMPTY_STRING.optional(),
  fieldKey: NON_EMPTY_STRING.optional(),
  fieldLabel: NON_EMPTY_STRING.optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
}).strict();

export const evidenceCreateSchema = z.object({
  id: NON_EMPTY_STRING.optional(),
  fileName: NON_EMPTY_STRING,
  fileType: NON_EMPTY_STRING,
  fileSize: z.number().int().nonnegative(),
  category: NON_EMPTY_STRING,
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED']).optional(),
  source: z.enum(['MANUAL', 'PLATFORM_UPLOAD', 'DRIVE_SYNC']).optional(),
  driveFileId: NON_EMPTY_STRING.optional(),
  driveFolderId: NON_EMPTY_STRING.optional(),
  driveFolderName: NON_EMPTY_STRING.optional(),
  webViewLink: NON_EMPTY_STRING.optional(),
  mimeType: NON_EMPTY_STRING.optional(),
  parserCategory: NON_EMPTY_STRING.optional(),
  parserConfidence: z.number().min(0).max(1).optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
}).strict();

export const projectDriveRootLinkSchema = z.object({
  value: NON_EMPTY_STRING,
}).strict();

export const projectTrashSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().max(500).optional(),
}).strict();

export const projectRestoreSchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();

export const projectExecutiveReviewSchema = z.object({
  requestId: NON_EMPTY_STRING.optional(),
  reviewStatus: z.enum(['PLANNING_AGREED', 'APPROVED', 'REVISION_REJECTED', 'DUPLICATE_DISCARDED']),
  reviewComment: z.string().trim().max(2000).optional(),
  reviewerName: z.string().trim().max(200).optional(),
  projectCode: z.string().trim().max(100).optional(),
}).strict().superRefine((value, ctx) => {
  if (!['PLANNING_AGREED', 'APPROVED'].includes(value.reviewStatus) && !value.reviewComment) {
    ctx.addIssue({
      code: 'custom',
      path: ['reviewComment'],
      message: 'reviewComment is required when reviewStatus is a rejection or discard',
    });
  }
});

export const projectExecutiveResubmitSchema = z.object({
  requestId: NON_EMPTY_STRING.optional(),
  reviewComment: z.string().trim().max(2000).optional(),
  reviewerName: z.string().trim().max(200).optional(),
}).strict();

export const projectManagementPlanningReviewSchema = z.object({
  requestId: NON_EMPTY_STRING.optional(),
  reviewStatus: z.enum(['AGREED', 'REVISION_REJECTED']),
  reviewComment: z.string().trim().max(2000).optional(),
  reviewerName: z.string().trim().max(200).optional(),
  projectCode: z.string().trim().max(100).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.reviewStatus === 'AGREED' && !value.projectCode) {
    ctx.addIssue({
      code: 'custom',
      path: ['projectCode'],
      message: 'projectCode is required when management planning agrees a project',
    });
  }
  if (value.reviewStatus === 'REVISION_REJECTED' && !value.reviewComment) {
    ctx.addIssue({
      code: 'custom',
      path: ['reviewComment'],
      message: 'reviewComment is required when management planning rejects a project',
    });
  }
});

export const googleSheetImportPreviewSchema = z.object({
  value: NON_EMPTY_STRING,
  sheetName: NON_EMPTY_STRING.optional(),
}).strict();

export const cashflowSheetLabPreviewSchema = z.object({
  value: NON_EMPTY_STRING.optional(),
  sheetName: NON_EMPTY_STRING.optional(),
  startWeek: NON_EMPTY_STRING.optional(),
  endWeek: NON_EMPTY_STRING.optional(),
  includeValues: z.boolean().optional(),
}).strict();

export const cashflowSheetLabMirrorRefreshSchema = z.object({
  sourceYear: z.number().int().min(2000).max(2100).optional(),
  value: NON_EMPTY_STRING.optional(),
  sheetName: NON_EMPTY_STRING.optional(),
  startWeek: NON_EMPTY_STRING.optional(),
  endWeek: NON_EMPTY_STRING.optional(),
  idempotencyKey: NON_EMPTY_STRING,
}).strict();

export const cashflowSheetLabApplySchema = z.object({
  value: NON_EMPTY_STRING.optional(),
  sheetName: NON_EMPTY_STRING.optional(),
  startWeek: NON_EMPTY_STRING.optional(),
  endWeek: NON_EMPTY_STRING.optional(),
  stageRunId: NON_EMPTY_STRING.optional(),
  replaceAllActualSources: z.boolean().optional(),
  applyRiskCandidates: z.boolean().optional(),
  settledWeekChangeConfirmationId: NON_EMPTY_STRING.optional(),
  closedMonthChangeReason: z.string().trim().max(1000).optional(),
  closedMonthDifferenceCount: z.number().int().min(0).optional(),
  closedMonthDifferenceManifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  acceptPendingApprovalDifferences: z.boolean().optional(),
  pendingApprovalDifferenceCount: z.number().int().min(0).optional(),
  pendingApprovalDifferenceManifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  acceptFormulaMismatches: z.boolean().optional(),
  idempotencyKey: NON_EMPTY_STRING.optional(),
}).strict();

export const cashflowSheetLabStageSchema = z.object({
  expectedMirrorRevision: NON_EMPTY_STRING,
  yearMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/).optional(),
  replaceAllActualSources: z.boolean().optional(),
  idempotencyKey: NON_EMPTY_STRING,
}).strict();

export const cashflowSheetLabWritebackPreviewSchema = z.object({
  value: NON_EMPTY_STRING.optional(),
  sheetName: NON_EMPTY_STRING.optional(),
  startWeek: NON_EMPTY_STRING.optional(),
  endWeek: NON_EMPTY_STRING.optional(),
}).strict();

export const cashflowSheetLabWritebackApplySchema = z.object({
  value: NON_EMPTY_STRING.optional(),
  sheetName: NON_EMPTY_STRING.optional(),
  startWeek: NON_EMPTY_STRING.optional(),
  endWeek: NON_EMPTY_STRING.optional(),
  baselineHash: NON_EMPTY_STRING.optional(),
  conflictResolution: z.enum(['abort', 'overwrite']).optional(),
  idempotencyKey: NON_EMPTY_STRING.optional(),
}).strict();

export const cashflowSheetLabConfigSchema = z.object({
  sourceYear: z.number().int().min(2000).max(2100).optional(),
  value: NON_EMPTY_STRING,
  sheetName: NON_EMPTY_STRING.optional(),
  startWeek: NON_EMPTY_STRING.optional(),
  endWeek: NON_EMPTY_STRING.optional(),
}).strict();

export const googleSheetImportAnalyzeSchema = z.object({
  spreadsheetTitle: z.string().trim().optional(),
  selectedSheetName: NON_EMPTY_STRING,
  matrix: z.array(z.array(z.string())).min(1),
}).strict();

const settlementKernelImportRowSchema = z.object({
  tempId: NON_EMPTY_STRING,
  sourceTxId: z.string().trim().optional(),
  entryKind: z.enum(['STANDARD', 'EXPENSE', 'DEPOSIT', 'ADJUSTMENT']).optional(),
  cells: z.array(z.string()),
  error: z.string().trim().optional(),
  reviewHints: z.array(z.string().trim()).optional(),
  reviewRequiredCellIndexes: z.array(z.number().int().nonnegative()).optional(),
  reviewStatus: z.enum(['pending', 'confirmed']).optional(),
  reviewFingerprint: z.string().trim().optional(),
  reviewConfirmedAt: z.string().trim().optional(),
  userEditedCells: z.array(z.number().int().nonnegative()).optional(),
}).strict();

export const projectSheetSourceUploadSchema = z.object({
  sourceType: z.enum(['usage', 'budget', 'evidence_rules', 'cashflow', 'bank_statement']),
  sheetName: NON_EMPTY_STRING.max(200),
  fileName: NON_EMPTY_STRING.max(300),
  mimeType: NON_EMPTY_STRING.max(200),
  fileSize: z.number().int().nonnegative(),
  contentBase64: NON_EMPTY_STRING,
  rowCount: z.number().int().nonnegative(),
  columnCount: z.number().int().nonnegative(),
  matchedColumns: z.array(z.string().trim().max(300)).max(80).optional(),
  unmatchedColumns: z.array(z.string().trim().max(300)).max(80).optional(),
  previewMatrix: z.array(z.array(z.string().max(1000)).max(24)).max(60).optional(),
  applyTarget: z.string().trim().max(120).optional(),
}).strict();

export const clientErrorIngestSchema = z.object({
  eventType: z.enum(['exception', 'message']).optional(),
  message: NON_EMPTY_STRING.max(4000),
  name: z.string().trim().max(200).optional(),
  stack: z.string().max(16000).optional(),
  level: z.enum(['info', 'warning', 'error', 'fatal']).optional(),
  source: NON_EMPTY_STRING.max(120),
  route: z.string().trim().max(500).optional(),
  href: z.string().trim().max(2000).optional(),
  clientRequestId: z.string().trim().max(200).optional(),
  fingerprint: z.array(z.string().trim().max(200)).max(8).optional(),
  tags: RECORD_UNKNOWN.optional(),
  extra: RECORD_UNKNOWN.optional(),
  occurredAt: z.string().trim().max(100).optional(),
}).strict();

export const projectRequestContractAnalyzeSchema = z.object({
  fileName: NON_EMPTY_STRING.max(300),
  documentText: z.string().max(200000).optional(),
}).strict();

export const projectRequestContractUploadSchema = z.object({
  fileName: NON_EMPTY_STRING.max(300),
  mimeType: NON_EMPTY_STRING.max(200),
  fileSize: z.number().int().nonnegative(),
  contentBase64: NON_EMPTY_STRING,
}).strict();

const BUSINESS_CARD_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const BUSINESS_CARD_CONTENT_BASE64_MAX_LENGTH = 12 * 1024 * 1024;

export const businessCardProcessSchema = z.object({
  fileName: NON_EMPTY_STRING.max(300),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  fileSize: z.number().int().positive().max(BUSINESS_CARD_MAX_IMAGE_BYTES),
  contentBase64: NON_EMPTY_STRING.max(BUSINESS_CARD_CONTENT_BASE64_MAX_LENGTH),
}).strict();

export const businessCardExtractedFieldSchema = z.object({
  value: z.string().trim().max(2000).default(''),
  confidence: z.enum(['high', 'medium', 'low']).default('low'),
  evidence: z.string().trim().max(2000).default(''),
}).strict();

export const businessCardExtractedListFieldSchema = z.object({
  value: z.string().trim().max(500),
  confidence: z.enum(['high', 'medium', 'low']).default('low'),
  evidence: z.string().trim().max(2000).default(''),
}).strict();

export const businessCardConfirmSchema = z.object({
  name: z.string().trim().max(300).default(''),
  organization: z.string().trim().max(500).default(''),
  department: z.string().trim().max(300).default(''),
  title: z.string().trim().max(300).default(''),
  role: z.string().trim().max(300).default(''),
  emails: z.array(z.string().trim().max(320)).max(8).default([]),
  phones: z.array(z.string().trim().max(80)).max(8).default([]),
  website: z.string().trim().max(500).default(''),
  address: z.string().trim().max(1000).default(''),
  memo: z.string().trim().max(2000).default(''),
}).strict().superRefine((value, ctx) => {
  const hasIdentity = Boolean(value.name || value.organization);
  const hasContact = value.emails.length > 0 || value.phones.length > 0;
  if (!hasIdentity) {
    ctx.addIssue({
      code: 'custom',
      path: ['name'],
      message: 'name or organization is required',
    });
  }
  if (!hasContact) {
    ctx.addIssue({
      code: 'custom',
      path: ['emails'],
      message: 'email or phone is required',
    });
  }
});

export const businessCardContactUpdateSchema = businessCardConfirmSchema;

export const businessCardSearchSchema = z.object({
  query: z.string().trim().max(200).default(''),
  limit: z.number().int().positive().max(100).optional(),
  cursor: z.string().trim().max(300).optional(),
}).strict();

export const claudeSdkHelpAskSchema = z.object({
  question: NON_EMPTY_STRING.max(2000),
  history: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: NON_EMPTY_STRING.max(4000),
    }).strict(),
  ).max(12).optional(),
}).strict();

export const evidenceDriveUploadSchema = z.object({
  fileName: NON_EMPTY_STRING,
  originalFileName: NON_EMPTY_STRING.optional(),
  mimeType: NON_EMPTY_STRING,
  fileSize: z.number().int().nonnegative(),
  contentBase64: NON_EMPTY_STRING,
  category: NON_EMPTY_STRING.optional(),
}).strict();

export const evidenceDriveOverrideSchema = z.object({
  items: z.array(
    z.object({
      driveFileId: NON_EMPTY_STRING,
      category: NON_EMPTY_STRING,
    }).strict(),
  ).min(1),
}).strict();

export const memberRoleUpdateSchema = z.object({
  role: z.enum(['admin', 'finance', 'pm', 'viewer', 'auditor', 'tenant_admin', 'support', 'security']),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

export const memberDeepSyncSchema = memberRoleUpdateSchema;

export const memberBulkDeepSyncSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  items: z.array(z.object({
    identityKey: NON_EMPTY_STRING.max(320),
    role: memberRoleUpdateSchema.shape.role,
  }).strict()).min(1).max(100),
}).strict().refine(
  ({ items }) => new Set(items.map(({ identityKey }) => identityKey.trim().toLowerCase())).size === items.length,
  { message: 'identityKey must be unique', path: ['items'] },
);

// ── 인력 명부 (persons) ──
// 근로형태와 재직상태는 다른 축이다. 파트너도 휴직할 수 있고, 정규직도 퇴사한다
// (= 계약에 endDate 가 붙는다). 둘을 한 필드로 합치면 표현할 수 없는 조합이 생긴다.

const ISO_DATE_STRING = z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'YYYY-MM-DD 형식으로 입력해 주세요');
const EMPLOYMENT_TYPE = z.enum(['FULL_TIME', 'INTERN', 'PARTNER', 'PLACEHOLDER']);
const EMPLOYMENT_STATE = z.enum(['WORKING', 'ON_LEAVE', 'PARENTAL_LEAVE']);

export const personEmploymentSchema = z.object({
  /** change = 기존 계약을 적용일 직전에 닫고 잇는다, add = 겹치지 않는 별도 구간을 끼운다 */
  mode: z.enum(['change', 'add']),
  type: EMPLOYMENT_TYPE,
  state: EMPLOYMENT_STATE,
  effectiveFrom: ISO_DATE_STRING,
  endDate: ISO_DATE_STRING.nullish(),
  note: z.string().trim().max(500).optional(),
}).strict();

const PROFESSIONAL_PROFILE_TEXT = z.string().max(80);

const professionalProfileEvidenceSchema = z.object({
  evidenceId: PROFESSIONAL_PROFILE_TEXT,
  path: z.string().trim().min(1).max(500),
  name: PROFESSIONAL_PROFILE_TEXT.nullish(),
  size: z.number().int().nonnegative().optional(),
  contentType: PROFESSIONAL_PROFILE_TEXT.nullish(),
  uploadedAt: PROFESSIONAL_PROFILE_TEXT.nullish(),
}).strict();

const professionalProfileEducationRecordSchema = z.object({
  attainmentCode: PROFESSIONAL_PROFILE_TEXT,
  institutionName: PROFESSIONAL_PROFILE_TEXT.nullish(),
  regionCode: PROFESSIONAL_PROFILE_TEXT.nullish(),
  // 249개 ISO 국가 코드로 저장하던 시절의 값. 받아서 국내/해외로 옮겨 읽는다.
  countryCode: PROFESSIONAL_PROFILE_TEXT.nullish(),
  major: PROFESSIONAL_PROFILE_TEXT.nullish(),
  admissionYear: PROFESSIONAL_PROFILE_TEXT.nullish(),
  degreeYear: PROFESSIONAL_PROFILE_TEXT.nullish(),
  evidence: professionalProfileEvidenceSchema.nullish(),
}).strict();

const professionalProfileEnglishEvidenceSchema = z.object({
  testCode: PROFESSIONAL_PROFILE_TEXT,
  scaleCode: PROFESSIONAL_PROFILE_TEXT,
  resultValue: PROFESSIONAL_PROFILE_TEXT,
  otherTestName: PROFESSIONAL_PROFILE_TEXT.nullish(),
  testedAt: PROFESSIONAL_PROFILE_TEXT.nullish(),
  evidence: professionalProfileEvidenceSchema.nullish(),
}).strict();

const professionalProfileCertificationSchema = z.object({
  label: PROFESSIONAL_PROFILE_TEXT,
  acquiredAt: PROFESSIONAL_PROFILE_TEXT.nullish(),
  evidence: professionalProfileEvidenceSchema.nullish(),
}).strict();

export const professionalProfileInputSchema = z.object({
  educationRecords: z.array(professionalProfileEducationRecordSchema).max(10).optional(),
  englishEvidence: z.array(professionalProfileEnglishEvidenceSchema).max(10).optional(),
  certifications: z.array(professionalProfileCertificationSchema).max(20).optional(),
}).strict();

export const personHrEvidenceUploadUrlSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(1).max(150),
  fileSize: z.number().int().positive().max(20 * 1024 * 1024),
}).strict();

export const personProfessionalProfilePutSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  profile: professionalProfileInputSchema,
}).strict();

export const personCreateSchema = z.object({
  personId: z.string().trim().min(1).max(200).regex(/^[^/]+$/).optional(),
  name: z.string().trim().min(1).max(100),
  nickname: z.string().trim().max(100).optional(),
  email: z.string().trim().max(200).optional(),
  departmentTop: z.string().trim().max(100).optional(),
  departmentMid: z.string().trim().max(100).optional(),
  departmentSub: z.string().trim().max(100).optional(),
  title: z.string().trim().max(100).optional(),
  grade: z.string().trim().max(100).optional(),
  workLocation: z.string().trim().max(100).optional(),
  birthDate: ISO_DATE_STRING.nullish(),
  note: z.string().trim().max(500).optional(),
  employment: z.object({
    type: EMPLOYMENT_TYPE,
    state: EMPLOYMENT_STATE,
    effectiveFrom: ISO_DATE_STRING,
    endDate: ISO_DATE_STRING.nullish(),
    note: z.string().trim().max(500).optional(),
  }).strict(),
  professionalProfile: professionalProfileInputSchema.optional(),
}).strict();

/**
 * 본인이 마이페이지에서 고치는 값. 증빙이 필요 없는 것만 둔다 -
 * 소속·직급·직책·입사일은 회사가 관리하고, 학력·어학·자격은 증빙과 함께 전문 프로필로 들어간다.
 */
export const personSelfProfileSchema = z.object({
  nickname: z.string().trim().max(100).optional(),
  birthDate: ISO_DATE_STRING.nullish(),
  workLocation: z.string().trim().max(100).optional(),
}).strict();

export const personProfileSchema = z.object({
  nickname: z.string().trim().max(100).optional(),
  email: z.string().trim().max(200).optional(),
  departmentTop: z.string().trim().max(100).optional(),
  departmentMid: z.string().trim().max(100).optional(),
  departmentSub: z.string().trim().max(100).optional(),
  title: z.string().trim().max(100).optional(),
  grade: z.string().trim().max(100).optional(),
  workLocation: z.string().trim().max(100).optional(),
  birthDate: ISO_DATE_STRING.nullish(),
  note: z.string().trim().max(500).optional(),
}).strict();

export const cashflowExportSchema = z.object({
  scope: z.enum(['all', 'single', 'selected']),
  projectId: z.string().trim().optional(),
  projectIds: z.array(z.string().trim().min(1).max(200).regex(/^[^/]+$/)).min(1).max(200).optional(),
  accountType: z.enum(['DEDICATED', 'OPERATING', 'NONE', 'OTHER']).optional(),
  accountTypes: z.array(z.enum(['DEDICATED', 'OPERATING', 'NONE', 'OTHER'])).min(1).max(4).optional(),
  department: z.string().trim().min(1).max(100).optional(),
  sortBy: z.enum(['PROJECT_NAME', 'DEPARTMENT']).default('PROJECT_NAME'),
  basis: z.enum(['공급가액', '공급대가', '기타', 'NONE']).optional(),
  startYearMonth: z.string().trim().regex(/^\d{4}-\d{2}$/),
  endYearMonth: z.string().trim().regex(/^\d{4}-\d{2}$/),
  variant: z.enum(['single-project', 'combined', 'multi-sheet']),
}).strict().superRefine((value, ctx) => {
  if (value.scope === 'single' && !value.projectId) {
    ctx.addIssue({
      code: 'custom',
      path: ['projectId'],
      message: 'projectId is required when scope=single',
    });
  }
  if (value.scope !== 'single' && value.variant === 'single-project') {
    ctx.addIssue({
      code: 'custom',
      path: ['variant'],
      message: 'single-project variant requires scope=single',
    });
  }
  if (value.scope === 'single' && value.projectIds) {
    ctx.addIssue({
      code: 'custom',
      path: ['projectIds'],
      message: 'projectIds is only supported for multi-project scopes',
    });
  }
  if (value.scope === 'selected' && !value.projectIds) {
    ctx.addIssue({
      code: 'custom',
      path: ['projectIds'],
      message: 'projectIds is required when scope=selected',
    });
  }
  if (value.projectIds && new Set(value.projectIds).size !== value.projectIds.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['projectIds'],
      message: 'projectIds must not contain duplicates',
    });
  }
  if (value.accountTypes && new Set(value.accountTypes).size !== value.accountTypes.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['accountTypes'],
      message: 'accountTypes must not contain duplicates',
    });
  }
  if (value.accountType && value.accountTypes) {
    ctx.addIssue({
      code: 'custom',
      path: ['accountTypes'],
      message: 'accountType and accountTypes cannot be used together',
    });
  }
});

export const cashflowWeekAmountsSchema = z.object({
  yearMonth: z.string().trim().regex(/^\d{4}-\d{2}$/),
  weekNo: z.number().int().min(1).max(5),
  mode: z.enum(['projection', 'actual']),
  amounts: z.record(z.string().trim().min(1), z.number().finite()),
}).strict();

export const cashflowActualSyncSchema = z.object({
  reason: z.string().trim().max(300).optional(),
}).strict();

export const genericWriteSchema = z.object({
  entityType: NON_EMPTY_STRING,
  entityId: NON_EMPTY_STRING.optional(),
  patch: RECORD_UNKNOWN,
  expectedVersion: z.number().int().nonnegative().optional(),
  options: z.object({
    sync: z.boolean().optional(),
  }).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.patch || Object.keys(value.patch).length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['patch'],
      message: 'patch must include at least one field',
    });
  }
});

export function parseWithSchema(schema, body, fallbackMessage = 'Invalid request body') {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;

  const message = parsed.error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : 'body';
    return `${path}: ${issue.message}`;
  }).join('; ');

  const error = new Error(message || fallbackMessage);
  error.statusCode = 400;
  throw error;
}
