import { describe, expect, it } from 'vitest';
import { buildMigrationReviewDossier, resolveMigrationReviewContractDocument } from './project-migration-review-dossier';
import type { Project, ProjectRequest } from '../data/types';

const project: Project = {
  id: 'p-1',
  slug: 'p-1',
  orgId: 'mysc',
  registrationSource: 'pm_portal',
  name: '2026 다자간협력',
  officialContractName: '2026 다자간협력 프로그램',
  status: 'CONTRACT_PENDING',
  type: 'D1',
  phase: 'CONFIRMED',
  contractAmount: 120000000,
  contractStart: '2026-01-01',
  contractEnd: '2026-12-31',
  settlementType: 'TYPE1',
  basis: '공급가액',
  accountType: 'NONE',
  fundInputMode: 'DIRECT_ENTRY',
  paymentPlan: { contract: 48000000, interim: 36000000, final: 36000000 },
  paymentPlanDesc: '선금 40%, 중도금 30%, 잔금 30%',
  clientOrg: 'KOICA',
  groupwareName: '2026 다자간협력 운영',
  participantCondition: '현지 파트너 공동참여',
  teamMembersDetailed: [
    { memberName: '변민욱', memberNickname: '보람', role: 'PM', participationRate: 60, laborAllocationStartMonth: '2026-03', laborAllocationEndMonth: '2026-08' },
    { memberName: '김다은', memberNickname: '데이나', role: '운영', participationRate: 40 },
  ],
  contractType: '계약서(날인)',
  contractDocument: {
    path: 'orgs/mysc/project-request-contracts/u-1/contract.pdf',
    name: '네팔_계약서.pdf',
    downloadURL: 'https://example.com/contract.pdf',
    size: 1234,
    contentType: 'application/pdf',
    uploadedAt: '2026-04-19T09:00:00Z',
  },
  contractAnalysis: {
    provider: 'heuristic',
    model: 'fallback',
    summary: '계약서에서 계약 기간과 계약금액이 식별되었습니다.',
    warnings: ['계약 대상 기관은 사람이 다시 확인해 주세요.'],
    nextActions: ['최종 공식 계약명을 확인하세요.'],
    extractedAt: '2026-04-19T09:01:00Z',
    fields: {
      officialContractName: { value: '2026 다자간협력 프로그램', confidence: 'medium', evidence: '계약서 제목' },
      suggestedProjectName: { value: '2026 다자간협력', confidence: 'medium', evidence: '계약서 제목' },
      clientOrg: { value: 'KOICA', confidence: 'low', evidence: '본문 추정' },
      projectPurpose: { value: '다자간협력 사업 운영 및 성과 확산', confidence: 'low', evidence: '본문 추정' },
      description: { value: '다자간협력 사업 설명', confidence: 'low', evidence: '본문 추정' },
      contractStart: { value: '2026-01-01', confidence: 'medium', evidence: '계약 기간' },
      contractEnd: { value: '2026-12-31', confidence: 'medium', evidence: '계약 기간' },
      contractAmount: { value: 120000000, confidence: 'medium', evidence: '계약금액' },
      salesVatAmount: { value: 10000000, confidence: 'low', evidence: '추정' },
    },
  },
  projectPurpose: '다자간협력 사업 운영 및 성과 확산',
  department: 'CIC1',
  teamName: '임팩트 CIC',
  managerId: 'u-1',
  managerName: '변민욱',
  budgetCurrentYear: 120000000,
  taxInvoiceAmount: 0,
  profitRate: 0.18,
  profitAmount: 21600000,
  isSettled: false,
  finalPaymentNote: '잔금은 최종 검수 후 입금',
  confirmerName: '센터장A',
  lastCheckedAt: '2026-04-20T09:00:00Z',
  cashflowDiffNote: '',
  createdAt: '2026-04-01T09:00:00Z',
  updatedAt: '2026-04-20T09:00:00Z',
  salesVatAmount: 10000000,
};

const request: ProjectRequest = {
  id: 'pr-1',
  tenantId: 'mysc',
  status: 'APPROVED',
  reviewOutcome: 'APPROVED',
  requestedBy: 'u-1',
  requestedByName: '변민욱',
  requestedByEmail: 'pm@example.com',
  requestedAt: '2026-04-20T08:00:00Z',
  reviewedBy: 'u-admin',
  reviewedByName: '임원A',
  reviewedAt: '2026-04-20T10:00:00Z',
  reviewComment: '승인',
  updatedAt: '2026-04-20T08:30:00Z',
  approvedProjectId: 'p-1',
  payload: {
    name: '2026 다자간협력',
    officialContractName: '2026 다자간협력 프로그램',
    type: 'D1',
    description: '다자간협력 사업 설명',
    clientOrg: 'KOICA',
    department: 'CIC1',
    contractAmount: 120000000,
    salesVatAmount: 10000000,
    totalRevenueAmount: 120000000,
    totalActualCost: 0,
    supportAmount: 0,
    contractStart: '2026-01-01',
    contractEnd: '2026-12-31',
    settlementType: 'TYPE1',
    basis: '공급가액',
    accountType: 'NONE',
    fundInputMode: 'DIRECT_ENTRY',
    settlementSheetPolicy: project.settlementSheetPolicy,
    paymentPlanDesc: '선금 40%, 중도금 30%, 잔금 30%',
    settlementGuide: '정산 가이드',
    projectPurpose: '다자간협력 사업 운영 및 성과 확산',
    managerName: '변민욱',
    teamName: '임팩트 CIC',
    teamMembers: '변민욱(보람), 김다은(데이나)',
    teamMembersDetailed: project.teamMembersDetailed,
    participantCondition: '현지 파트너 공동참여',
    note: '임원 검토 메모 없음',
    contractDocument: null,
    contractAnalysis: null,
  },
};

describe('buildMigrationReviewDossier', () => {
  it('builds an executive review dossier from the PM portal project and request payload', () => {
    const dossier = buildMigrationReviewDossier(project, request);

    expect(dossier.headerTitle).toBe('2026 다자간협력');
    expect(dossier.identity.clientOrg).toBe('KOICA');
    expect(dossier.identity.groupwareName).toBe('2026 다자간협력 운영');
    expect(dossier.identity.cic).toBe('CIC1');
    expect(dossier.identity.pmName).toBe('변민욱');

    expect(dossier.contract.projectTypeLabel).toBeTruthy();
    expect(dossier.contract.contractType).toBe('계약서(날인)');
    expect(dossier.contract.periodLabel).toContain('2026-01-01');
    expect(dossier.contract.basisLabel).toBe('공급가액 기준');
    expect(dossier.contract.accountTypeLabel).toBe('일반사업(MYSC법인통장)');
    expect(dossier.contract.fundInputModeLabel).toBe('직접 입력');

    expect(dossier.budget.contractAmountLabel).toContain('120,000,000');
    expect(dossier.budget.salesVatAmountLabel).toContain('10,000,000');
    expect(dossier.budget.paymentPlanSplitLabel).toBe('선금/계약금 48,000,000원 (40%) · 중도금 36,000,000원 (30%) · 잔금 36,000,000원 (30%)');
    expect(dossier.budget.finalPaymentNote).toBe('잔금은 최종 검수 후 입금');
    expect(dossier.people.teamName).toBe('임팩트 CIC');
    expect(dossier.people.members[0]).toContain('변민욱');
    expect(dossier.people.members[0]).toContain('PM');

    expect(dossier.notes.projectPurpose).toContain('성과 확산');
    expect(dossier.notes.participantCondition).toContain('공동참여');
    expect(dossier.audit.requestedByName).toBe('변민욱');
    expect(dossier.audit.requestUpdatedAt).toBe('2026. 04. 20. 17:30');
    expect(dossier.audit.reviewedByName).toBe('임원A');
    expect(dossier.analysis.summary).toContain('계약 기간과 계약금액');
    expect(dossier.contractDocument.name).toBe('네팔_계약서.pdf');
    expect(dossier.contractDocument.downloadURL).toContain('contract.pdf');
    expect(dossier.submittedFields.find((field) => field.label === '인건비 정산 기준')?.value).toBe('미입력');
    expect(dossier.submittedFields.find((field) => field.label === '정산 가이드')?.value).toBe('정산 가이드');
    expect(dossier.submittedFields.find((field) => field.label === '등록 메모')?.value).toBe('임원 검토 메모 없음');
    expect(dossier.missingSubmittedFields).toContain('인건비 정산 기준');
    expect(Object.keys(request.payload).every((key) => dossier.submittedFields.some((field) => field.key === key))).toBe(true);
  });

  it('falls back to project fields even when no project request document is attached', () => {
    const dossier = buildMigrationReviewDossier({
      ...project,
      contractType: '발주기관 전자시스템',
    }, null);

    expect(dossier.headerTitle).toBe('2026 다자간협력');
    expect(dossier.identity.clientOrg).toBe('KOICA');
    expect(dossier.identity.cic).toBe('CIC1');
    expect(dossier.identity.pmName).toBe('변민욱');
    expect(dossier.contract.contractType).toBe('전자계약 시스템');
    expect(dossier.contract.accountTypeLabel).toBe('일반사업(MYSC법인통장)');
    expect(dossier.people.members[0]).toContain('변민욱');
    // 요청 문서가 없어도 기안자는 프로젝트 등록자에서 이어받는다 - 결재 문서에 빈 기안자를 남기지 않는다.
    expect(dossier.audit.requestedByName).toBe('변민욱');
    expect(dossier.audit.reviewedByName).toBe('-');
    expect(dossier.contractDocument.name).toBe('네팔_계약서.pdf');
  });

  it('normalizes legacy dropdown values before approval display formatting', () => {
    const dossier = buildMigrationReviewDossier({
      ...project,
      type: 'UNKNOWN' as never,
      settlementType: 'MONTHLY' as never,
      basis: 'SUPPLY_AMOUNT' as never,
      accountType: 'LEGACY_ACCOUNT' as never,
      fundInputMode: 'MANUAL' as never,
    }, null);

    expect(dossier.contract.projectTypeLabel).toBe('D-1 개발협력사업 - AVPN 포함');
    expect(dossier.contract.settlementTypeLabel).toBe('정산 없음');
    expect(dossier.contract.basisLabel).toBe('공급가액 기준');
    expect(dossier.contract.accountTypeLabel).toBe('일반사업(MYSC법인통장)');
    expect(dossier.contract.fundInputModeLabel).toBe('통장내역 업로드');
  });

  it('includes executive review history entries with the latest reversal reason', () => {
    const dossier = buildMigrationReviewDossier(
      {
        ...project,
        executiveReviewStatus: 'REVISION_REJECTED',
        executiveReviewedAt: '2026-04-21T10:00:00Z',
        executiveReviewedByName: '임원B',
        executiveReviewComment: '예산 근거 보완 필요',
        executiveReviewHistory: [
          {
            status: 'APPROVED',
            previousStatus: 'PENDING',
            reviewedAt: '2026-04-20T10:00:00Z',
            reviewedById: 'u-admin-1',
            reviewedByName: '임원A',
            reviewComment: '초안 승인',
          },
          {
            status: 'REVISION_REJECTED',
            previousStatus: 'APPROVED',
            reviewedAt: '2026-04-21T10:00:00Z',
            reviewedById: 'u-admin-2',
            reviewedByName: '임원B',
            reviewComment: '예산 근거 보완 필요',
          },
        ],
      } as Project,
      request,
    );

    expect(dossier.audit.reviewedByName).toBe('임원B');
    expect(dossier.audit.reviewComment).toBe('예산 근거 보완 필요');
    expect(dossier.audit.history).toHaveLength(2);
    expect(dossier.audit.history[0]).toMatchObject({
      status: 'REVISION_REJECTED',
      statusLabel: '수정 요청 후 반려',
      reviewedByName: '임원B',
      reviewComment: '예산 근거 보완 필요',
    });
    expect(dossier.audit.history[1]).toMatchObject({
      status: 'APPROVED',
      statusLabel: '승인 완료',
      reviewedByName: '임원A',
      reviewComment: '초안 승인',
    });
  });

  it('surfaces the latest PM edit before-after changes for CIC review', () => {
    const dossier = buildMigrationReviewDossier(
      {
        ...project,
        executiveReviewStatus: 'PENDING',
        executiveReviewHistory: [
          {
            status: 'APPROVED',
            previousStatus: 'PENDING',
            reviewedAt: '2026-04-20T10:00:00Z',
            reviewedById: 'u-admin-1',
            reviewedByName: '임원A',
            reviewComment: '초안 승인',
          },
          {
            status: 'PENDING',
            previousStatus: 'APPROVED',
            reviewedAt: '2026-04-22T10:00:00Z',
            reviewedById: 'u-1',
            reviewedByName: '변민욱',
            reviewComment: 'PM 수정 저장',
            changes: [
              { key: 'contractAmount', label: '계약금액', before: '120,000,000원', after: '130,000,000원' },
              { key: 'managerName', label: 'PM', before: '변민욱', after: '김다은' },
            ],
          },
        ],
      } as Project,
      request,
    );

    expect(dossier.changes).toEqual([
      { key: 'contractAmount', label: '계약금액', before: '120,000,000원', after: '130,000,000원' },
      { key: 'managerName', label: 'PM', before: '변민욱', after: '김다은' },
    ]);
    expect(dossier.audit.history[0].changes).toHaveLength(2);
  });

  it('shows the pending change request contract document instead of the current project document', () => {
    const dossier = buildMigrationReviewDossier(
      project,
      {
        ...request,
        requestKind: 'CHANGE',
        status: 'PENDING',
        targetProjectId: project.id,
        payload: {
          ...request.payload,
          contractDocument: {
            path: 'orgs/mysc/project-request-documents/u-1/new-contract.pdf',
            name: '수정_계약서.pdf',
            downloadURL: 'https://example.com/new-contract.pdf',
            size: 4321,
            contentType: 'application/pdf',
            uploadedAt: '2026-04-22T09:00:00Z',
          },
          contractAnalysis: {
            ...project.contractAnalysis!,
            summary: '새 계약서 분석',
          },
        },
        proposedSnapshot: {
          ...request.payload,
          contractDocument: {
            path: 'orgs/mysc/project-request-documents/u-1/proposed-contract.pdf',
            name: '제안_계약서.pdf',
            downloadURL: 'https://example.com/proposed-contract.pdf',
            size: 5432,
            contentType: 'application/pdf',
            uploadedAt: '2026-04-22T10:00:00Z',
          },
          contractAnalysis: {
            ...project.contractAnalysis!,
            summary: '제안 계약서 분석',
          },
        },
      },
    );

    expect(dossier.contractDocument.name).toBe('제안_계약서.pdf');
    expect(dossier.contractDocument.downloadURL).toContain('proposed-contract.pdf');
    expect(dossier.analysis.summary).toBe('제안 계약서 분석');
    expect(resolveMigrationReviewContractDocument(project, {
      ...request,
      requestKind: 'CHANGE',
      status: 'PENDING',
      proposedSnapshot: {
        ...request.payload,
        contractDocument: {
          path: 'orgs/mysc/project-request-documents/u-1/proposed-contract.pdf',
          name: '제안_계약서.pdf',
          downloadURL: 'https://example.com/proposed-contract.pdf',
          size: 5432,
          contentType: 'application/pdf',
          uploadedAt: '2026-04-22T10:00:00Z',
        },
      },
    })?.name).toBe('제안_계약서.pdf');

    expect(resolveMigrationReviewContractDocument(project, {
      ...request,
      requestKind: 'CHANGE',
      status: 'REJECTED',
      proposedSnapshot: {
        ...request.payload,
        contractDocument: {
          path: 'orgs/mysc/project-request-documents/u-1/proposed-contract.pdf',
          name: '제안_계약서.pdf',
          downloadURL: 'https://example.com/proposed-contract.pdf',
          size: 5432,
          contentType: 'application/pdf',
          uploadedAt: '2026-04-22T10:00:00Z',
        },
      },
    })?.name).toBe('제안_계약서.pdf');
  });

  it('prefers current project team members over stale request payload values', () => {
    const dossier = buildMigrationReviewDossier(
      {
        ...project,
        teamMembersDetailed: [
          { memberName: '변민욱', memberNickname: '보람', role: 'PM', participationRate: 80 },
          { memberName: '이지영', memberNickname: '이지', role: '정산', participationRate: 20 },
        ],
      },
      {
        ...request,
        payload: {
          ...request.payload,
          teamMembers: '김다은(데이나)',
          teamMembersDetailed: [
            { memberName: '김다은', memberNickname: '데이나', role: '운영', participationRate: 100 },
          ],
        },
      },
    );

    expect(dossier.people.members).toEqual([
      '변민욱 (보람) / PM / 80%',
      '이지영 (이지) / 정산 / 20%',
    ]);
  });

  it('treats an explicit empty project team list as current in CIC review', () => {
    const dossier = buildMigrationReviewDossier(
      {
        ...project,
        teamMembersDetailed: [],
      },
      {
        ...request,
        payload: {
          ...request.payload,
          teamMembers: '김다은(데이나)',
          teamMembersDetailed: [
            { memberName: '김다은', memberNickname: '데이나', role: '운영', participationRate: 100 },
          ],
        },
      },
    );

    expect(dossier.people.members).toEqual([]);
  });

  it('keeps zero-won payment split entries visible for CIC review', () => {
    const dossier = buildMigrationReviewDossier(
      {
        ...project,
        contractAmount: 100_000,
        paymentPlan: { contract: 0, interim: 20_000, final: 0 },
      },
      {
        ...request,
        payload: {
          ...request.payload,
          paymentPlan: { contract: 50_000, interim: 30_000, final: 20_000 },
        },
      },
    );

    expect(dossier.budget.paymentPlanSplitLabel).toBe('선금/계약금 0원 (0%) · 중도금 20,000원 (20%) · 잔금 0원 (0%)');
  });

  it('prefers current project settlement fields over stale request payload values', () => {
    const dossier = buildMigrationReviewDossier(
      {
        ...project,
        settlementType: 'TYPE1',
        basis: '공급가액',
        accountType: 'DEDICATED',
        fundInputMode: 'DIRECT_ENTRY',
      },
      {
        ...request,
        payload: {
          ...request.payload,
          settlementType: 'NONE',
          basis: 'NONE',
          accountType: 'NONE',
          fundInputMode: 'BANK_UPLOAD',
        },
      },
    );

    expect(dossier.contract.settlementTypeLabel).toBe('Type1. 세금계산서발행+공급가액');
    expect(dossier.contract.basisLabel).toBe('공급가액 기준');
    expect(dossier.contract.accountTypeLabel).toBe('전용계좌 사업(이나라도움)');
    expect(dossier.contract.fundInputModeLabel).toBe('직접 입력');
  });
});
