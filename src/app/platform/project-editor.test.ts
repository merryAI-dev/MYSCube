import { describe, expect, it } from 'vitest';
import type { Project, ProjectTeamMemberAssignment } from '../data/types';
import {
  ACCOUNT_TYPE_LABELS,
  getProjectTypeSelectableOptions,
  INTEREST_REFUND_POLICY_LABELS,
  LABOR_SETTLEMENT_BASIS_LABELS,
  normalizeAccountType,
  normalizeProjectContractType,
  PROJECT_CONTRACT_TYPE_OPTIONS,
  PROJECT_SETTLEMENT_SYSTEM_CODES,
  PROJECT_TYPE_LABELS,
  SETTLEMENT_SYSTEM_LABELS,
  SETTLEMENT_TYPE_LABELS,
} from '../data/types';
import {
  buildProjectEditorDraftFromProject,
  buildProjectEditorProjectPatch,
  buildProjectEditorReviewChanges,
  buildProjectRequestPayloadFromDraft,
  createProjectEditorDraft,
  hasInvalidProjectContractPeriod,
} from './project-editor';

describe('project registration period validation', () => {
  it('accepts a real ordered ISO contract period', () => {
    expect(hasInvalidProjectContractPeriod('2026-01-01', '2026-12-31')).toBe(false);
  });

  it.each([
    ['2026-12-31', '2026-01-01'],
    ['2026-02-30', '2026-12-31'],
    ['2026-01-01', '2026-13-01'],
  ])('rejects invalid contract period %s ~ %s', (start, end) => {
    expect(hasInvalidProjectContractPeriod(start, end)).toBe(true);
  });
});

const baseProject: Project = {
  id: 'p-1',
  slug: 'test-project',
  orgId: 'mysc',
  registrationSource: 'pm_portal',
  executiveReviewStatus: 'APPROVED',
  executiveReviewHistory: [{
    status: 'APPROVED',
    previousStatus: 'PENDING',
    reviewedAt: '2026-05-01T00:00:00.000Z',
    reviewedById: 'admin-1',
    reviewedByName: '관리자',
  }],
  name: '기후테크',
  officialContractName: '기후테크 공식 계약',
  status: 'CONTRACT_PENDING',
  type: 'D1',
  phase: 'CONFIRMED',
  currency: 'KRW',
  contractAmount: 100_000,
  contractStart: '2026-01-01',
  contractEnd: '2026-12-31',
  settlementType: 'TYPE5',
  basis: '공급대가',
  accountType: 'DEDICATED',
  fundInputMode: 'BANK_UPLOAD',
  paymentPlan: { contract: 0, interim: 0, final: 0 },
  paymentPlanDesc: '선금 50%, 잔금 50%',
  clientOrg: 'KOICA',
  groupwareName: '기후테크GW',
  participantCondition: '참여기업 조건',
  teamMembersDetailed: [
    { memberName: '김다은', memberNickname: '데이나', role: 'PM', participationRate: 60 },
  ],
  contractType: '계약서(날인)',
  projectPurpose: '목적',
  totalRevenueAmount: 91_000,
  supportAmount: 5_000,
  salesVatAmount: 9_000,
  financialInputFlags: {
    contractAmount: true,
    salesVatAmount: true,
    totalRevenueAmount: true,
    supportAmount: true,
  },
  settlementGuide: '이나라도움 수령',
  contractDocument: null,
  contractAnalysis: null,
  department: '개발협력',
  teamName: '데이나팀',
  managerId: 'pm-1',
  managerName: '김다은',
  budgetCurrentYear: 100_000,
  taxInvoiceAmount: 0,
  profitRate: 0.01,
  profitAmount: 1_000,
  isSettled: false,
  finalPaymentNote: '',
  confirmerName: '',
  lastCheckedAt: '',
  cashflowDiffNote: '',
  description: '주요 내용',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('project editor draft mapping', () => {
  it('serializes executive review clears as null for BFF JSON writes', () => {
    const reviewedProject: Project = {
      ...baseProject,
      registrationSource: 'pm_portal',
      executiveReviewStatus: 'APPROVED',
      executiveReviewedAt: '2026-08-01T00:00:00.000Z',
      executiveReviewedById: 'reviewer-1',
      executiveReviewedByName: '검토자',
    };
    const patch = buildProjectEditorProjectPatch(createProjectEditorDraft(reviewedProject), {
      baseProject: reviewedProject,
      mode: 'portal-edit',
      actorId: 'pm-1',
      actorName: 'PM',
      now: '2026-08-03T00:00:00.000Z',
    });
    const jsonPatch = JSON.parse(JSON.stringify(patch));

    expect(jsonPatch).toMatchObject({
      executiveReviewedAt: null,
      executiveReviewedById: null,
      executiveReviewedByName: null,
    });
  });

  it('normalizes and persists the shared contract-finance fields', () => {
    const legacyFinalWeekPayload = {
      finalPaymentExpectedWeek: '26-8-1',
    };
    const draft = buildProjectEditorDraftFromProject({
      ...baseProject,
      registrationRequirementsVersion: 2,
      contractStart: '2026-01-01',
      contractEnd: '2027-12-31',
      totalActualCost: 12_000,
      interestRefundPolicy: 'MYSC_REVENUE',
      quoteSubmissionDeferred: true,
      teamMembersDetailed: [
        { memberName: '기존 책임자', memberNickname: '', role: '사업 최종 책임자', participationRate: 0, isDocumentOnly: false },
        { memberName: '운영자', memberNickname: '', role: '운영매니저', participationRate: 100, isDocumentOnly: false },
      ],
      financialYears: [
        { year: 2027, contractAmount: 2, salesVatAmount: 0, totalRevenueAmount: 2, totalActualCost: 1, supportAmount: 0, profitRate: 0, confirmed: false },
        { year: 2026, contractAmount: 1, salesVatAmount: 0, totalRevenueAmount: 1, totalActualCost: 3, supportAmount: 0, profitRate: 0, confirmed: true },
      ],
    }, legacyFinalWeekPayload);

    expect(Object.keys(INTEREST_REFUND_POLICY_LABELS)).toEqual([
      'REFUND',
      'USE_AS_PROJECT_EXPENSE',
      'MYSC_REVENUE',
      'REVIEW_LATER',
    ]);
    expect(SETTLEMENT_TYPE_LABELS.TYPE3).toBe('Type3. 세금계산서미발행 + 공급가액');
    expect(draft.finalPaymentExpectedWeek).toBe('26-8-1');
    expect(draft.financialYears.map(({ year, totalActualCost }) => ({ year, totalActualCost }))).toEqual([
      { year: 2026, totalActualCost: 3 },
      { year: 2027, totalActualCost: 1 },
    ]);
    expect(draft.teamMembersDetailed[0].role).toBe('사업 최종 책임자');

    const payload = buildProjectRequestPayloadFromDraft(draft);
    const patch = buildProjectEditorProjectPatch(draft, {
      baseProject,
      mode: 'admin',
      actorId: 'admin-1',
      actorName: '관리자',
      now: '2026-08-03T00:00:00.000Z',
    });

    expect(payload).toMatchObject({
      totalActualCost: 12_000,
      interestRefundPolicy: 'MYSC_REVENUE',
      quoteSubmissionDeferred: true,
    });
    expect(payload).toHaveProperty('finalPaymentExpectedWeek', '26-8-1');
    expect(patch).toMatchObject({
      totalActualCost: 12_000,
      interestRefundPolicy: 'MYSC_REVENUE',
      quoteSubmissionDeferred: true,
    });
    expect(patch.finalPaymentExpectedWeek).toBe('26-8-1');
    expect(payload.teamMembersDetailed?.map((member) => member.role)).toEqual(['사업 최종 책임자', '운영매니저']);
    expect(patch.teamMembersDetailed?.map((member) => member.role)).toEqual(['사업 최종 책임자', '운영매니저']);
  });

  it('uses the same canonical dropdown values for every project editor surface', () => {
    expect(getProjectTypeSelectableOptions()).toEqual(Object.keys(PROJECT_TYPE_LABELS));
    expect(getProjectTypeSelectableOptions()).toContain('I2');
    expect(getProjectTypeSelectableOptions()).toContain('I3');
    expect(PROJECT_CONTRACT_TYPE_OPTIONS).toEqual([
      '계약서(날인)',
      '협약서(날인)',
      '전자계약 시스템',
      '기타',
    ]);
    expect(normalizeProjectContractType('발주기관 전자시스템')).toBe('전자계약 시스템');
  });

  it('hydrates edit draft from project canonical values and normalizes stale profit fields', () => {
    const draft = buildProjectEditorDraftFromProject(baseProject);

    expect(draft.totalRevenueAmount).toBe(91_000);
    expect(draft.currency).toBe('KRW');
    expect(draft.registeredById).toBe('pm-1');
    expect(draft.registeredByName).toBe('김다은');
    expect(draft.profitAmount).toBe(91_000);
    expect(draft.profitRate).toBe(0.91);
    expect(draft.teamMembersDetailed).toEqual([
      { memberName: '김다은', memberNickname: '데이나', role: 'PM', participationRate: 60 },
    ]);
    expect(draft.laborTransferPlan).toEqual({
      mode: 'MONTHLY_WEEK_3',
      milestoneAmounts: { contract: 0, interim: 0, final: 0 },
    });
  });

  it('derives annual profit rates and clears settlement-only fields when the v2 basis is none', () => {
    const draft = createProjectEditorDraft({
      registrationRequirementsVersion: 2,
      contractStart: '2026-01-01',
      contractEnd: '2027-12-31',
      contractAmount: 120_000,
      totalRevenueAmount: 90_000,
      financialYears: [{
        year: 2026,
        contractAmount: 120_000,
        salesVatAmount: 0,
        totalRevenueAmount: 90_000,
        totalActualCost: 0,
        supportAmount: 0,
        profitRate: 0,
        confirmed: true,
      }],
      settlementType: 'TYPE1',
      basis: 'NONE',
      accountType: 'DEDICATED',
      settlementSystem: 'BOTAEM_E',
      laborSettlementBasis: 'INCLUDE_ACTUAL_SALARY',
    });

    expect(draft.financialYears[0].profitRate).toBe(0.75);
    expect(draft).toMatchObject({
      settlementType: 'TYPE1',
      basis: 'NONE',
      accountType: 'NONE',
      settlementSystem: 'NONE',
      laborSettlementBasis: 'NONE',
    });
  });

  it('gives a single-year contract one annual row so amounts have one home', () => {
    const draft = createProjectEditorDraft({
      registrationRequirementsVersion: 2,
      contractStart: '2026-01-01',
      contractEnd: '2026-12-31',
      contractAmount: 120_000,
      salesVatAmount: 12_000,
      totalRevenueAmount: 90_000,
      supportAmount: 5_000,
      financialYears: [{
        year: 2026,
        contractAmount: 120_000,
        salesVatAmount: 12_000,
        totalRevenueAmount: 90_000,
        totalActualCost: 0,
        supportAmount: 5_000,
        profitRate: 0.75,
        confirmed: true,
      }],
    });

    // 단년도도 표 한 줄을 갖는다. 금액을 넣는 자리가 연도 수와 무관하게 하나다.
    expect(draft.financialYears).toHaveLength(1);
    expect(draft.financialYears[0]).toMatchObject({
      year: 2026,
      contractAmount: 120_000,
      salesVatAmount: 12_000,
      totalRevenueAmount: 90_000,
      totalActualCost: 0,
      supportAmount: 5_000,
    });
    // 불러오기만으로 총계가 바뀌지는 않는다. 저장된 값이 그대로 남는다.
    expect(draft).toMatchObject({
      contractAmount: 120_000,
      salesVatAmount: 12_000,
      totalRevenueAmount: 90_000,
      supportAmount: 5_000,
    });
  });

  it('does not rewrite a stored single-year contract amount that disagrees with its items', () => {
    // 2026-08 프로덕션 69건 중 8건만 식과 맞는다. 불러오는 것만으로 값이 줄면 사고다.
    const draft = createProjectEditorDraft({
      registrationRequirementsVersion: 2,
      contractStart: '2026-01-01',
      contractEnd: '2026-12-31',
      contractAmount: 100_000_000,
      salesVatAmount: 0,
      totalRevenueAmount: 40_000_000,
      totalActualCost: 0,
      supportAmount: 0,
    });

    expect(draft.contractAmount).toBe(100_000_000);
    expect(draft.financialYears[0].contractAmount).toBe(100_000_000);
  });

  it('preserves the legacy v1 settlement-type NONE clearing behavior', () => {
    expect(createProjectEditorDraft({
      registrationRequirementsVersion: 1,
      settlementType: 'NONE',
      basis: '공급대가',
      accountType: 'DEDICATED',
      settlementSystem: 'BOTAEM_E',
      laborSettlementBasis: 'INCLUDE_ACTUAL_SALARY',
    })).toMatchObject({
      settlementType: 'NONE',
      basis: 'NONE',
      accountType: 'NONE',
      settlementSystem: 'NONE',
      laborSettlementBasis: 'NONE',
    });
  });

  it('preserves legacy v1 details when the type enables settlement even if the old basis is NONE', () => {
    expect(createProjectEditorDraft({
      registrationRequirementsVersion: 1,
      settlementType: 'TYPE1',
      basis: 'NONE',
      accountType: 'DEDICATED',
      settlementSystem: 'BOTAEM_E',
      laborSettlementBasis: 'INCLUDE_ACTUAL_SALARY',
    })).toMatchObject({
      settlementType: 'TYPE1',
      basis: 'NONE',
      accountType: 'DEDICATED',
      settlementSystem: 'BOTAEM_E',
      laborSettlementBasis: 'INCLUDE_ACTUAL_SALARY',
    });
  });

  it('exposes the exact PPT labels for settlement-none and other account options', () => {
    expect(ACCOUNT_TYPE_LABELS.OTHER).toBe('기타');
    expect(normalizeAccountType('OTHER')).toBe('OTHER');
    expect(SETTLEMENT_SYSTEM_LABELS.NONE).toBe('시스템 미사용');
    expect(LABOR_SETTLEMENT_BASIS_LABELS).toMatchObject({
      INCLUDE_ACTUAL_SALARY: '4대보험, 퇴직금 포함 실급여',
      EXCLUDE_ACTUAL_SALARY: '4대보험, 퇴직금 제외 실급여',
      FIXED_AMOUNT: '정액정산',
      NONE: '정산없음',
    });
  });

  it('exposes the exact PPT page 30 settlement-system options while retaining legacy codes', () => {
    expect(PROJECT_SETTLEMENT_SYSTEM_CODES.map((code) => [code, SETTLEMENT_SYSTEM_LABELS[code]])).toEqual([
      ['NONE', '시스템 미사용'],
      ['E_NARA_DOUM', 'e나라도움 (국고보조금통합관리시스템)'],
      ['BOTAEM_E', '보탬e(지방보조금관리시스템)'],
      ['RCMS', 'RCMS (실시간연구비관리시스템)'],
      ['EZBARO', '통합이지바로 (통합 Ez-plus)'],
      ['SMTECH', 'SMTECH (중소기업기술개발사업종합관리시스템)'],
      ['KOCCA_PMS', 'KOCCA PMS'],
      ['NIPA', 'NIPA 사업관리시스템'],
      ['IRIS', 'IRIS(범부처통합연구지원시스템)'],
      ['OTHER', '기타'],
    ]);
    expect(SETTLEMENT_SYSTEM_LABELS.ACCOUNTANT).toBe('회계사정산');
  });

  it('uses selected registeredBy member as the project owner source of truth', () => {
    const base = {
      ...baseProject,
      registeredById: 'writer-1',
      registeredByName: '기존 작성자',
      registeredByEmail: 'writer@mysc.co.kr',
      managerId: 'writer-1',
      managerName: '기존 작성자',
    };
    const draft = createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject(base),
      registeredById: 'member-2',
      registeredByName: '새 담당자',
      registeredByEmail: 'member2@mysc.co.kr',
    });

    const patch = buildProjectEditorProjectPatch(draft, {
      baseProject: base,
      mode: 'admin',
      actorId: 'admin-1',
      actorName: '관리자',
      now: '2026-05-28T00:00:00.000Z',
    });
    const payload = buildProjectRequestPayloadFromDraft(draft);

    expect(patch.registeredById).toBe('member-2');
    expect(patch.registeredByName).toBe('새 담당자');
    expect(patch.registeredByEmail).toBe('member2@mysc.co.kr');
    expect(patch.managerId).toBe('member-2');
    expect(patch.managerName).toBe('새 담당자');
    expect(payload.registeredById).toBe('member-2');
    expect(payload.managerName).toBe('새 담당자');
  });

  it('keeps a designated executive approver in project patches and request payloads', () => {
    const draft = createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject(baseProject),
      executiveApproverId: 'head-1',
      executiveApproverName: '조직장 A',
      executiveApproverEmail: 'head-a@mysc.co.kr',
    });
    const patch = buildProjectEditorProjectPatch(draft, {
      baseProject,
      mode: 'admin',
      actorId: 'admin-1',
      actorName: '관리자',
      now: '2026-05-28T00:00:00.000Z',
    });

    expect(buildProjectRequestPayloadFromDraft(draft)).toMatchObject({
      executiveApproverId: 'head-1',
      executiveApproverName: '조직장 A',
      executiveApproverEmail: 'head-a@mysc.co.kr',
    });
    expect(patch).toMatchObject({
      executiveApproverId: 'head-1',
      executiveApproverName: '조직장 A',
      executiveApproverEmail: 'head-a@mysc.co.kr',
    });
  });

  it('treats an explicit empty project team list as the current edit value', () => {
    const draft = buildProjectEditorDraftFromProject(
      {
        ...baseProject,
        teamMembersDetailed: [],
      },
      {
        teamMembersDetailed: [
          { memberName: '김다은', memberNickname: '데이나', role: 'PM', participationRate: 60 },
        ],
      },
    );

    expect(draft.teamMembersDetailed).toEqual([]);
  });

  it('serializes the same detailed team, finance, and payment fields into request payload', () => {
    const draft = createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject(baseProject),
      teamMembersDetailed: [
        { memberName: '김다은', memberNickname: '데이나', role: '총괄책임자', participationRate: 60, isDocumentOnly: false, laborAllocationStartMonth: '2026-04', laborAllocationEndMonth: '2026-09' },
        { memberName: '변민욱', memberNickname: '보람', role: '실무책임자', participationRate: 40, isDocumentOnly: true },
      ],
      groupwareName: '기후테크GW',
      currency: 'USD',
      settlementSystem: 'KOCCA_PMS',
      laborSettlementBasis: 'FIXED_AMOUNT',
      paymentPlan: { contract: 50_000, interim: 30_000, final: 20_000 },
      paymentExpectedMonths: { contract: '2026-04', interim: '2026-06', final: '2026-10' },
      advanceInterimBelow70Reason: '발주처 지급 조건',
      finalPaymentNote: '잔금은 검수 후 2주 이내',
      note: '기존 비고 유지',
      businessManagementGoogleFolderLink: 'https://drive.google.com/drive/folders/project-folder',
      quoteDocument: {
        path: 'orgs/mysc/project-request-documents/u001/quote.pdf',
        name: 'quote.pdf',
        downloadURL: 'https://example.com/quote.pdf',
        size: 100,
        contentType: 'application/pdf',
        uploadedAt: '2026-06-02T00:00:00.000Z',
      },
      proposalDocument: {
        path: 'orgs/mysc/project-request-documents/u001/proposal.pdf',
        name: 'proposal.pdf',
        downloadURL: 'https://example.com/proposal.pdf',
        size: 200,
        contentType: 'application/pdf',
        uploadedAt: '2026-06-02T00:00:00.000Z',
      },
      contractAnalysis: { provider: 'heuristic', summary: '기존 분석값' } as never,
    });

    const payload = buildProjectRequestPayloadFromDraft(draft);

    expect(payload.totalRevenueAmount).toBe(91_000);
    expect(payload.currency).toBe('USD');
    expect(payload.teamMembersDetailed).toEqual([
      { memberName: '김다은', memberNickname: '데이나', role: '총괄책임자', participationRate: 60, isDocumentOnly: false, laborAllocationStartMonth: '2026-04', laborAllocationEndMonth: '2026-09' },
      { memberName: '변민욱', memberNickname: '보람', role: '실무책임자', participationRate: 40, isDocumentOnly: true },
    ]);
    expect(payload.teamMembers).toBe('김다은 (데이나) / 총괄책임자 / 60% / 실제 참여 / 인건비 2026-04~2026-09, 변민욱 (보람) / 실무책임자 / 40% / 서류상 인력');
    expect(payload.groupwareName).toBe('기후테크GW');
    expect(payload.businessManagementGoogleFolderLink).toBe('https://drive.google.com/drive/folders/project-folder');
    expect(payload.settlementSystem).toBe('KOCCA_PMS');
    expect(payload.laborSettlementBasis).toBe('FIXED_AMOUNT');
    expect(payload.paymentPlan).toEqual({ contract: 50_000, interim: 30_000, final: 20_000 });
    expect(payload.paymentExpectedMonths).toEqual({ contract: '2026-04', interim: '2026-06', final: '2026-10' });
    expect(payload.advanceInterimBelow70Reason).toBe('발주처 지급 조건');
    expect(payload.finalPaymentNote).toBe('잔금은 검수 후 2주 이내');
    expect(payload.note).toBe('기존 비고 유지');
    expect(payload.registrationConfirmations).toEqual(draft.registrationConfirmations);
    expect(payload).toHaveProperty('finalPaymentExpectedWeek', '');
    expect(payload.quoteDocument?.name).toBe('quote.pdf');
    expect(payload.proposalDocument?.name).toBe('proposal.pdf');
    expect(payload.contractAnalysis).toEqual({ provider: 'heuristic', summary: '기존 분석값' });
  });

  it('keeps registration v2 year coverage explicit and carries checkout evidence through payload mapping', () => {
    const customerBusinessRegistrationDocument = {
      path: 'private/customer-registration.pdf',
      name: 'customer-registration.pdf',
      downloadURL: '',
      size: 10,
      contentType: 'application/pdf',
      uploadedAt: '2026-07-14T00:00:00.000Z',
    };
    const performanceCertificateDocument = {
      ...customerBusinessRegistrationDocument,
      path: 'private/performance.pdf',
      name: 'performance.pdf',
    };
    const draft = createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject(baseProject),
      registrationRequirementsVersion: 2,
      contractStart: '2026-01-01',
      contractEnd: '2027-12-31',
      financialYears: [{
        year: 2026,
        contractAmount: 100_000,
        salesVatAmount: 9_000,
        totalRevenueAmount: 91_000,
        totalActualCost: 0,
        supportAmount: 5_000,
        profitRate: 0.91,
        confirmed: true,
        paymentPlan: { contract: 50_000, interim: 0, final: 50_000 },
        paymentExpectedMonths: { contract: '2026-03', interim: '', final: '2026-12' },
        advanceInterimBelow70Reason: '  발주처 지급 조건  ',
      }],
      registrationConfirmations: {
        laborIncludesFourInsurance: true,
        laborIncludesRetirementPay: true,
        customerSettlementBasisConfirmed: true,
        modusignContractUsed: false,
        originalContractSubmitted: true,
        proposalPptOriginal: 'https://drive.google.com/file/d/proposal/view',
        presentationPptOriginal: 'https://docs.google.com/presentation/d/presentation/edit',
      },
      checkout: {
        finalPaymentReceived: true,
        bankBalanceZero: true,
        performanceCertificateReceived: true,
        taxInvoiceEvidenceConfirmed: false,
        finalSettlementReportConfirmed: false,
        usbEvidenceSubmitted: true,
        evidenceDeletedAfterUsb: true,
      },
      customerBusinessRegistrationDocument,
      performanceCertificateDocument,
    });

    expect(draft.financialYears).toEqual([
      expect.objectContaining({ year: 2026, confirmed: true }),
      expect.objectContaining({ year: 2027, confirmed: false }),
    ]);
    const payload = buildProjectRequestPayloadFromDraft(draft);
    expect(payload.registrationRequirementsVersion).toBe(2);
    expect(payload.registrationConfirmations).toMatchObject({
      modusignContractUsed: false,
      originalContractSubmitted: true,
      proposalPptOriginal: 'https://drive.google.com/file/d/proposal/view',
      presentationPptOriginal: 'https://docs.google.com/presentation/d/presentation/edit',
    });
    expect(payload.checkout?.evidenceDeletedAfterUsb).toBe(true);
    expect(payload.financialYears?.[0]).toMatchObject({
      paymentExpectedMonths: { contract: '2026-03', interim: '', final: '2026-12' },
      advanceInterimBelow70Reason: '발주처 지급 조건',
    });
    expect(payload.customerBusinessRegistrationDocument?.name).toBe('customer-registration.pdf');
    expect(payload.performanceCertificateDocument?.name).toBe('performance.pdf');
  });

  it('resets approved PM portal edits to executive review pending without writing hidden business status fields', () => {
    const draft = createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject(baseProject),
      name: '기후테크수정',
      status: 'IN_PROGRESS',
    });

    const patch = buildProjectEditorProjectPatch(draft, {
      baseProject,
      mode: 'portal-edit',
      actorId: 'pm-1',
      actorName: '김다은',
      now: '2026-05-19T00:00:00.000Z',
    });

    expect(patch.status).toBeUndefined();
    expect(patch.phase).toBeUndefined();
    expect(patch.contractAnalysis).toBeNull();
    expect(patch.executiveReviewStatus).toBe('PENDING');
    expect(patch.executiveReviewHistory?.at(-1)).toMatchObject({
      status: 'PENDING',
      previousStatus: 'APPROVED',
      reviewedById: 'pm-1',
      reviewedByName: '김다은',
    });
    expect(patch.executiveReviewHistory?.at(-1)?.changes).toEqual(
      expect.arrayContaining([
        {
          key: 'name',
          label: '프로젝트명',
          before: '기후테크',
          after: '기후테크수정',
        },
      ]),
    );
  });

  it('logs deterministic changes when an already pending PM portal project is edited again', () => {
    const pendingProject: Project = {
      ...baseProject,
      executiveReviewStatus: 'PENDING',
      executiveReviewHistory: [
        {
          status: 'PENDING',
          previousStatus: null,
          reviewedAt: '2026-05-01T00:00:00.000Z',
          reviewedById: 'pm-1',
          reviewedByName: '김다은',
        },
      ],
    };
    const draft = createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject(pendingProject),
      paymentPlanDesc: '선금 80%, 잔금 20%',
    });

    const patch = buildProjectEditorProjectPatch(draft, {
      baseProject: pendingProject,
      mode: 'portal-edit',
      actorId: 'pm-1',
      actorName: '김다은',
      now: '2026-05-20T00:00:00.000Z',
    });

    expect(patch.executiveReviewStatus).toBe('PENDING');
    expect(patch.executiveReviewHistory?.at(-1)).toMatchObject({
      status: 'PENDING',
      previousStatus: 'PENDING',
      reviewedById: 'pm-1',
      reviewedByName: '김다은',
    });
    expect(patch.executiveReviewHistory?.at(-1)?.changes).toEqual(
      expect.arrayContaining([
        {
          key: 'paymentPlanDesc',
          label: '기타 메모',
          before: '선금 50%, 잔금 50%',
          after: '선금 80%, 잔금 20%',
        },
      ]),
    );
  });

  it('builds deterministic before-after review changes for CIC review', () => {
    const draft = createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject(baseProject),
      name: '기후테크수정',
      totalRevenueAmount: 93_000,
      registeredById: 'pm-2',
      registeredByName: '변민욱',
      registeredByEmail: 'boram@mysc.co.kr',
    });

    const changes = buildProjectEditorReviewChanges(baseProject, draft);

    expect(changes).toEqual(expect.arrayContaining([
      {
        key: 'name',
        label: '프로젝트명',
        before: '기후테크',
        after: '기후테크수정',
      },
      {
        key: 'totalRevenueAmount',
        label: '총수익',
        before: '91,000원',
        after: '93,000원',
      },
      {
        key: 'registeredByName',
        label: '최종 보고자 (실무책임자)',
        before: '김다은',
        after: '변민욱',
      },
    ]));
  });

  it('syncs the stored CIC value from the edited 담당조직', () => {
    const existingProject = {
      ...baseProject,
      cic: 'CIC1',
      department: 'CIC1',
    };
    const draft = createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject(existingProject),
      department: 'CIC2',
    });

    const patch = buildProjectEditorProjectPatch(draft, {
      baseProject: existingProject,
      mode: 'admin',
      actorId: 'admin-1',
      actorName: '관리자',
      now: '2026-05-20T00:00:00.000Z',
    });

    expect(patch.department).toBe('CIC2');
    expect(patch.cic).toBe('CIC2');
  });

  it('normalizes legacy spaced CIC labels before saving 담당조직', () => {
    const existingProject = {
      ...baseProject,
      cic: 'CIC1',
      department: 'CIC1',
    };
    const draft = createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject(existingProject),
      department: 'CIC 2',
    });

    const patch = buildProjectEditorProjectPatch(draft, {
      baseProject: existingProject,
      mode: 'admin',
      actorId: 'admin-1',
      actorName: '관리자',
      now: '2026-05-20T00:00:00.000Z',
    });

    expect(patch.department).toBe('CIC2');
    expect(patch.cic).toBe('CIC2');
  });

  it('preserves a distinct groupware name in direct project patches', () => {
    const draft = createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject(baseProject),
      name: '기후테크',
      groupwareName: '기후테크GW',
    });

    const patch = buildProjectEditorProjectPatch(draft, {
      baseProject,
      mode: 'admin',
      actorId: 'admin-1',
      actorName: '관리자',
      now: '2026-05-20T00:00:00.000Z',
    });

    expect(patch.groupwareName).toBe('기후테크GW');
  });

  it('keeps zero-won payment split values visible in deterministic review changes', () => {
    const draft = createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject({
        ...baseProject,
        paymentPlan: { contract: 50_000, interim: 30_000, final: 20_000 },
      }),
      paymentPlan: { contract: 0, interim: 30_000, final: 0 },
    });

    const changes = buildProjectEditorReviewChanges({
      ...baseProject,
      paymentPlan: { contract: 50_000, interim: 30_000, final: 20_000 },
    }, draft);

    expect(changes).toEqual(expect.arrayContaining([
      {
        key: 'paymentPlan',
        label: '입금 분할',
        before: '선금/계약금 50,000원 · 중도금 30,000원 · 잔금 20,000원',
        after: '선금/계약금 0원 · 중도금 30,000원 · 잔금 0원',
      },
    ]));
  });

  it('normalizes legacy contract type values before payload and project patch serialization', () => {
    const draft = createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject(baseProject),
      contractType: '발주기관 전자시스템',
    });

    const payload = buildProjectRequestPayloadFromDraft(draft);
    const patch = buildProjectEditorProjectPatch(draft, {
      baseProject,
      mode: 'admin',
      actorId: 'admin-1',
      actorName: '관리자',
      now: '2026-05-19T00:00:00.000Z',
    });

    expect(draft.contractType).toBe('전자계약 시스템');
    expect(payload.contractType).toBe('전자계약 시스템');
    expect(patch.contractType).toBe('전자계약 시스템');
  });

  it('normalizes legacy dropdown values before they reach Select components', () => {
    const draft = buildProjectEditorDraftFromProject({
      ...baseProject,
      type: 'UNKNOWN' as never,
      status: 'OLD_STATUS' as never,
      phase: 'OLD_PHASE' as never,
      settlementType: 'MONTHLY' as never,
      basis: 'SUPPLY_AMOUNT' as never,
      accountType: 'LEGACY_ACCOUNT' as never,
      fundInputMode: 'MANUAL' as never,
    });

    expect(draft.type).toBe('D1');
    expect(draft.status).toBe('CONTRACT_PENDING');
    expect(draft.phase).toBe('CONFIRMED');
    expect(draft.settlementType).toBe('NONE');
    expect(draft.basis).toBe('NONE');
    expect(draft.accountType).toBe('NONE');
    expect(draft.fundInputMode).toBe('BANK_UPLOAD');
  });

  it('persists currency into project patches and review changes', () => {
    const draft = createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject(baseProject),
      currency: 'USD',
    });

    const patch = buildProjectEditorProjectPatch(draft, {
      baseProject,
      mode: 'portal-edit',
      actorId: 'pm-1',
      actorName: '김다은',
      now: '2026-05-27T00:00:00.000Z',
    });
    const changes = buildProjectEditorReviewChanges(baseProject, draft);

    expect(patch.currency).toBe('USD');
    expect(changes).toEqual(expect.arrayContaining([
      {
        key: 'currency',
        label: '통화',
        before: 'KRW',
        after: 'USD',
      },
    ]));
  });

  it('persists PM edit notes into the project source of truth as well as request payload', () => {
    const draft = createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject(baseProject, {
        note: '기존 등록 원문 비고',
      } as never),
      note: '마고와 써니 참여율 보정 메모',
    });

    const patch = buildProjectEditorProjectPatch(draft, {
      baseProject,
      mode: 'portal-edit',
      actorId: 'pm-1',
      actorName: '김다은',
      now: '2026-05-29T00:00:00.000Z',
    });
    const payload = buildProjectRequestPayloadFromDraft(draft);

    expect(patch.note).toBe('마고와 써니 참여율 보정 메모');
    expect(payload.note).toBe('마고와 써니 참여율 보정 메모');
  });

  it('preserves spaces while typing a custom settlement system and audits label changes', () => {
    const customProject = {
      ...baseProject,
      settlementSystem: 'OTHER' as const,
      settlementSystemOther: '기존 시스템',
    };
    const draft = createProjectEditorDraft({
      ...buildProjectEditorDraftFromProject(customProject),
      settlementSystem: 'OTHER',
      settlementSystemOther: '새 시스템 ',
    });

    expect(draft.settlementSystemOther).toBe('새 시스템 ');
    expect(buildProjectRequestPayloadFromDraft(draft).settlementSystemOther).toBe('새 시스템');
    expect(buildProjectEditorReviewChanges(customProject, draft)).toEqual(expect.arrayContaining([{
      key: 'settlementSystem',
      label: '정산 시스템',
      before: '기존 시스템',
      after: '새 시스템',
    }]));
  });
});

// 참여율 시트를 사업에 묶는 지점. 시트 안에는 사업 식별자를 적지 않으므로(사람이 적는
// 식별자는 어긋난다) 이 링크를 저장하는 것이 곧 바인딩이다. 왕복에서 사라지면 바인딩이 끊긴다.
describe('참여율 시트 링크', () => {
  it('불러오기 → 저장 왕복에서 값을 잃지 않는다', () => {
    const link = 'https://docs.google.com/spreadsheets/d/abc123/edit';
    const project = { ...baseProject, participationSheetLink: link };
    const draft = buildProjectEditorDraftFromProject(project);
    expect(draft.participationSheetLink).toBe(link);
    const patch = buildProjectEditorProjectPatch(draft, {
      mode: 'admin', actorId: 'u1', actorName: '보람', now: '2026-08-21T00:00:00.000Z',
    });
    expect(patch.participationSheetLink).toBe(link);
    expect(buildProjectRequestPayloadFromDraft(draft).participationSheetLink).toBe(link);
  });

  it('값이 없으면 빈 문자열로 시작한다', () => {
    expect(createProjectEditorDraft().participationSheetLink).toBe('');
    expect(buildProjectEditorDraftFromProject(baseProject).participationSheetLink).toBe('');
  });
});

describe('참여율 월별 저장 경로', () => {
  it('keeps blank, zero, changed, and multi-year monthly rates through draft and both write payloads', () => {
    const assignment: ProjectTeamMemberAssignment = {
      personId: 'person-yuja',
      memberName: '유자인',
      memberNickname: '유자',
      role: '',
      participationRate: 20,
      laborAllocationStartMonth: '2026-11',
      laborAllocationEndMonth: '2027-02',
      monthlyRates: {
        '2026-11': 20,
        '2026-12': 0,
        '2027-01': null,
        '2027-02': 5,
      },
    };
    const expected = [assignment];

    const draft = createProjectEditorDraft({
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit',
      contractStart: '2026-01-01',
      contractEnd: '2027-01-01',
      teamMembersDetailed: expected,
    });
    const hydratedDraft = buildProjectEditorDraftFromProject({
      ...baseProject,
      participationSheetLink: draft.participationSheetLink,
      contractStart: draft.contractStart,
      contractEnd: draft.contractEnd,
      teamMembersDetailed: expected,
    });
    const payload = buildProjectRequestPayloadFromDraft(draft);
    const patch = buildProjectEditorProjectPatch(draft, {
      mode: 'admin',
      actorId: 'admin-1',
      actorName: '관리자',
      now: '2026-08-21T00:00:00.000Z',
    });

    expect(draft.teamMembersDetailed).toEqual(expected);
    expect(hydratedDraft.teamMembersDetailed).toEqual(expected);
    expect(payload.teamMembersDetailed).toEqual(expected);
    expect(patch.teamMembersDetailed).toEqual(expected);
  });
});

describe('실제 투입인력 (staffing)', () => {
  it('personId 없는 슬롯은 미정(null)으로 정규화하고 운영매니저는 채워진 슬롯만 남긴다', async () => {
    const { normalizeProjectStaffing } = await import('./project-editor');
    const staffing = normalizeProjectStaffing({
      lead: { personId: 'p-1', name: '김신영', nickname: '가든' },
      pm: { personId: '', name: '이름만' },
      operators: [null, { personId: 'p-2', name: '최유진', nickname: '고야' }, { name: '아이디없음' }],
      settlementSupport: '도담',
    });
    expect(staffing.lead).toEqual({ personId: 'p-1', name: '김신영', nickname: '가든' });
    expect(staffing.pm).toBeNull();
    expect(staffing.operators).toEqual([{ personId: 'p-2', name: '최유진', nickname: '고야' }]);
    expect(staffing.settlementSupport).toBe('도담');
  });

  it('드래프트→페이로드→요약까지 staffing 이 유지된다', async () => {
    const { createProjectEditorDraft, buildProjectRequestPayloadFromDraft, formatProjectStaffingSummary } = await import('./project-editor');
    const draft = createProjectEditorDraft({
      staffing: {
        lead: { personId: 'p-1', name: '김신영', nickname: '가든' },
        pm: null,
        operators: [],
        others: [{ role: '멘토', slot: { personId: 'p-9', name: '박하늘', nickname: '하늘' } }],
        settlementSupport: '써니',
      },
    });
    const payload = buildProjectRequestPayloadFromDraft(draft);
    expect(payload.staffing?.lead?.personId).toBe('p-1');
    expect(payload.staffing?.others).toEqual([
      { role: '멘토', slot: { personId: 'p-9', name: '박하늘', nickname: '하늘' } },
    ]);
    expect(formatProjectStaffingSummary(payload.staffing))
      .toBe('총괄 가든 / 실무 미정 / 운영 미정 / 멘토 하늘 / 정산지원 써니');
  });

  it('기타 역할은 역할명이 있어야 남고, 사람은 미정이어도 된다', async () => {
    const { normalizeProjectStaffing } = await import('./project-editor');
    const staffing = normalizeProjectStaffing({
      others: [
        { role: '  멘토  ', slot: { personId: 'p-1', name: '김신영', nickname: '가든' } },
        { role: '강 사', slot: null },
        { role: '', slot: { personId: 'p-2', name: '최유진', nickname: '고야' } },
        { slot: { personId: 'p-3' } },
      ],
    });
    expect(staffing.others).toEqual([
      { role: '멘토', slot: { personId: 'p-1', name: '김신영', nickname: '가든' } },
      { role: '강 사', slot: null },
    ]);
  });

  it('기타 역할명은 20자로 자르고 10개를 넘기지 않는다', async () => {
    const { normalizeProjectStaffing, PROJECT_STAFFING_OTHERS_MAX, PROJECT_STAFFING_ROLE_MAX_LENGTH } =
      await import('./project-editor');
    const staffing = normalizeProjectStaffing({
      others: Array.from({ length: PROJECT_STAFFING_OTHERS_MAX + 3 }, (_unused, index) => ({
        role: `역${index}`.padEnd(PROJECT_STAFFING_ROLE_MAX_LENGTH + 5, '가'),
        slot: null,
      })),
    });
    expect(staffing.others).toHaveLength(PROJECT_STAFFING_OTHERS_MAX);
    for (const item of staffing.others) {
      expect(item.role.length).toBe(PROJECT_STAFFING_ROLE_MAX_LENGTH);
    }
  });
});
