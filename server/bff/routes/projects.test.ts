import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  buildProjectRegistrationCanonicalDocuments,
  buildProjectInfoChangeSubmission,
  buildProjectInfoDraftSeed,
  buildProjectPatchFromChangeRequestPayload,
  formatProjectTypeSlackLabel,
  mergeProjectAndRequestDocs,
  mountProjectRoutes,
  readProjectRequestById,
  resolveProjectRequestDocuments,
  resolveProjectTeamMemberLookupKeys,
  tryEnsureProjectRootFolder,
  tryRenameManagedProjectRootFolder,
} from './projects.mjs';
import { upsertVersionedDoc } from '../bff-utils.mjs';

const registrationV2AttachmentKinds = [
  'contract',
  'customer_business_registration',
  'quote',
  'proposal_word_original',
  'proposal_ppt_original',
  'presentation_ppt_original',
  'rfp_request_evidence',
];
const registrationV2RequiredAttachmentKinds = registrationV2AttachmentKinds.slice(0, 3);

function registrationV2Payload(overrides: Record<string, unknown> = {}) {
  return {
    name: '다년도 사업',
    officialContractName: '2026 다년도 사업 운영 계약',
    clientOrg: '발주기관 주식회사',
    projectPurpose: '사내기업가 육성',
    description: '교육 운영 및 성과보고서 제출',
    type: 'D1',
    status: 'CONTRACT_PENDING',
    department: 'AXR',
    registeredById: 'pm-a',
    registeredByName: 'PM A',
    executiveApproverId: 'head-a',
    executiveApproverName: '조직장 A',
    executiveApproverEmail: 'head-a@mysc.co.kr',
    managerId: 'pm-a',
    managerName: 'PM A',
    contractStart: '2026-01-01',
    contractEnd: '2027-12-31',
    participationSheetLink: 'https://docs.google.com/spreadsheets/d/default-participation-sheet/edit',
    contractAmount: 300_000,
    salesVatAmount: 30_000,
    totalRevenueAmount: 120_000,
    totalActualCost: 75_000,
    supportAmount: 10_000,
    settlementType: 'TYPE1',
    basis: '공급가액',
    settlementSystem: 'BOTAEM_E',
    laborSettlementBasis: 'INCLUDE_ACTUAL_SALARY',
    paymentPlan: { contract: 150_000, interim: 60_000, final: 90_000 },
    paymentExpectedMonths: { contract: '2026-01', interim: '2026-06', final: '2027-12' },
    advanceInterimBelow70Reason: '',
    teamMembersDetailed: [
      {
        memberName: '변민욱',
        memberNickname: '보람',
        role: '운영매니저',
        participationRate: 50,
        isDocumentOnly: false,
      },
      {
        memberName: '김세은',
        memberNickname: '람쥐',
        role: '총괄책임자',
        participationRate: 0,
        isDocumentOnly: false,
      },
    ],
    financialInputFlags: {
      contractAmount: true,
      salesVatAmount: true,
      totalRevenueAmount: true,
      totalActualCost: true,
      supportAmount: true,
    },
    registrationRequirementsVersion: 2,
    financialYears: [
      { year: 2026, contractAmount: 100_000, salesVatAmount: 10_000, totalRevenueAmount: 40_000, totalActualCost: 25_000, supportAmount: 0, profitRate: 0.4, confirmed: true, paymentPlan: { contract: 50_000, interim: 20_000, final: 30_000 }, paymentExpectedMonths: { contract: '2026-02', interim: '2026-06', final: '2026-12' }, finalPaymentExpectedWeek: '26-8-1', advanceInterimBelow70Reason: '연차별 일정', isSettled: true },
      { year: 2027, contractAmount: 200_000, salesVatAmount: 20_000, totalRevenueAmount: 80_000, totalActualCost: 50_000, supportAmount: 10_000, profitRate: 0.4, confirmed: true, paymentPlan: { contract: 100_000, interim: 40_000, final: 60_000 }, paymentExpectedMonths: { contract: '2027-02', interim: '2027-06', final: '2027-12' }, finalPaymentExpectedWeek: '27-12-4', advanceInterimBelow70Reason: '', isSettled: false },
    ],
    interestRefundPolicy: 'REFUND',
    finalPaymentExpectedWeek: '27-12-4',
    quoteSubmissionDeferred: false,
    registrationConfirmations: {
      laborIncludesFourInsurance: true,
      laborIncludesRetirementPay: true,
      customerSettlementBasisConfirmed: true,
      modusignContractUsed: false,
      originalContractSubmitted: true,
      proposalPptOriginal: 'https://drive.google.com/file/d/proposal/view',
      presentationPptOriginal: 'http://docs.google.com/presentation/d/presentation/edit',
    },
    registrationOptionalDocumentNotes: {
      proposalWordOriginal: '제안서 Word 원본은 고객사 제공 자료가 없어 제출 제외',
      proposalPptOriginal: '제안서 PPT 원본은 고객사 제공 자료가 없어 제출 제외',
      presentationPptOriginal: '발표자료 PPT 원본은 해당 없음',
    },
    ...overrides,
  };
}

function registrationV2Canonical(
  payload = registrationV2Payload(),
  requiredKinds = registrationV2RequiredAttachmentKinds,
  attachmentKinds: string[] = [],
) {
  return buildProjectRegistrationCanonicalDocuments({
    tenantId: 'mysc',
    projectId: 'project-v2',
    projectRequestId: 'request-v2',
    sourceDraftId: 'draft-v2',
    payload,
    attachmentRefs: attachmentKinds.map((documentKind) => ({
      documentKind,
      path: `orgs/mysc/project-registration-drafts/draft-v2/${documentKind}.pdf`,
      name: `${documentKind}.pdf`,
      size: 3,
      contentType: 'application/pdf',
    })),
    requirementsAttachmentRefs: requiredKinds.map((documentKind) => ({
      documentKind,
      path: `orgs/mysc/project-registration-drafts/draft-v2/${documentKind}.pdf`,
      name: `${documentKind}.pdf`,
      size: 3,
      contentType: 'application/pdf',
    })),
    actorId: 'pm-a',
    actorName: 'PM A',
    actorEmail: 'pm-a@example.com',
    timestamp: '2026-07-14T00:00:00.000Z',
  });
}

function changeSubmission(payload: Record<string, unknown>, project: Record<string, unknown>) {
  return buildProjectInfoChangeSubmission({
    tenantId: 'mysc',
    project,
    previousRequest: null,
    payload,
    attachmentRefs: [],
    actorId: 'pm-a',
    actorName: 'PM A',
    actorEmail: 'pm-a@example.com',
    timestamp: '2026-08-24T00:00:00.000Z',
    targetProjectVersion: 2,
  });
}

describe('project route helpers', () => {
  it('does not restore canonical contract analysis when a private replacement omits analysis', () => {
    const canonical = registrationV2Canonical(
      registrationV2Payload({ contractAnalysis: { summary: 'canonical contract A analysis' } }),
      registrationV2AttachmentKinds,
      registrationV2AttachmentKinds,
    );
    const privateContract = {
      documentKind: 'contract',
      path: 'orgs/mysc/project-registration-drafts/change-v2/contract-b.pdf',
      name: 'contract-b.pdf',
      size: 3,
      contentType: 'application/pdf',
    };
    const payload = {
      ...canonical.projectRequest.payload,
      contractDocument: { path: privateContract.path },
    };
    delete payload.contractAnalysis;

    const submission = buildProjectInfoChangeSubmission({
      tenantId: 'mysc',
      project: canonical.project,
      previousRequest: null,
      payload,
      attachmentRefs: [privateContract],
      actorId: 'pm-a',
      actorName: 'PM A',
      actorEmail: 'pm-a@example.com',
      timestamp: '2026-07-14T00:00:00.000Z',
      targetProjectVersion: 2,
    });

    expect(submission.projectRequest.proposedSnapshot.contractAnalysis).toBeNull();
    expect(submission.projectRequest.payload.contractAnalysis).toBeNull();
  });

  it('builds a registration v2 canonical record with contract confirmations and no retired finance week', () => {
    const canonical = registrationV2Canonical();

    expect(canonical.projectRequest.payload).toMatchObject({
      registrationRequirementsVersion: 2,
      financialYears: [
        { year: 2026, confirmed: true, profitRate: 0.4, totalActualCost: 25_000, paymentPlan: { contract: 50_000, interim: 20_000, final: 30_000 }, advanceInterimBelow70Reason: '연차별 일정', isSettled: true },
        { year: 2027, confirmed: true, profitRate: 0.4, totalActualCost: 50_000, paymentPlan: { contract: 100_000, interim: 40_000, final: 60_000 }, isSettled: false },
      ],
      totalActualCost: 75_000,
      interestRefundPolicy: 'REFUND',
      quoteSubmissionDeferred: false,
      settlementSystem: 'BOTAEM_E',
      laborSettlementBasis: 'INCLUDE_ACTUAL_SALARY',
      paymentExpectedMonths: { contract: '2026-01', interim: '2026-06', final: '2027-12' },
      teamMembersDetailed: [
        { role: '운영매니저', isDocumentOnly: false },
        { role: '총괄책임자', isDocumentOnly: false },
      ],
      executiveApproverId: 'head-a',
      executiveApproverName: '조직장 A',
      executiveApproverEmail: 'head-a@mysc.co.kr',
    });
    expect(canonical.projectRequest.payload.registrationConfirmations).toMatchObject({
      modusignContractUsed: false,
      originalContractSubmitted: true,
      proposalPptOriginal: 'https://drive.google.com/file/d/proposal/view',
      presentationPptOriginal: 'http://docs.google.com/presentation/d/presentation/edit',
    });
    expect(canonical.project.registrationConfirmations).toMatchObject({ modusignContractUsed: false, originalContractSubmitted: true });
    expect(canonical.projectRequest.payload).not.toHaveProperty('groupwareName');
    expect(canonical.projectRequest.payload).toMatchObject({
      registrationOptionalDocumentNotes: {
        proposalWordOriginal: '제안서 Word 원본은 고객사 제공 자료가 없어 제출 제외',
        proposalPptOriginal: '제안서 PPT 원본은 고객사 제공 자료가 없어 제출 제외',
        presentationPptOriginal: '발표자료 PPT 원본은 해당 없음',
      },
    });
    expect(canonical.project.customerBusinessRegistrationDocument).toBeNull();
    expect(canonical.project.executiveReviewHistory?.[0]?.reviewComment).toBe('PM 신규 등록');
    expect(canonical.project).toMatchObject({
      registrationRequirementsVersion: 2,
      financialYears: [{ year: 2026, confirmed: true }, { year: 2027, confirmed: true }],
      executiveApproverId: 'head-a',
      executiveApproverName: '조직장 A',
      executiveApproverEmail: 'head-a@mysc.co.kr',
    });
    expect(canonical.project).not.toHaveProperty('groupwareName');
    expect(canonical.project).toMatchObject({
      registrationOptionalDocumentNotes: {
        proposalWordOriginal: '제안서 Word 원본은 고객사 제공 자료가 없어 제출 제외',
        proposalPptOriginal: '제안서 PPT 원본은 고객사 제공 자료가 없어 제출 제외',
        presentationPptOriginal: '발표자료 PPT 원본은 해당 없음',
      },
    });
  });

  it('preserves the business-management Google folder link in both review and project records', () => {
    const link = 'https://drive.google.com/drive/folders/project-management-folder';
    const canonical = registrationV2Canonical(registrationV2Payload({
      businessManagementGoogleFolderLink: link,
    }));

    expect(canonical.projectRequest.payload.businessManagementGoogleFolderLink).toBe(link);
    expect(canonical.project.businessManagementGoogleFolderLink).toBe(link);
  });

  it('allows a single-year registration without annual financial rows', () => {
    const canonical = registrationV2Canonical(registrationV2Payload({
      contractEnd: '2026-12-31',
      paymentExpectedMonths: { contract: '2026-01', interim: '2026-06', final: '2026-12' },
      financialYears: [],
    }));

    expect(canonical.projectRequest.payload.financialYears).toEqual([]);
  });

  it('derives annual profit rates and removes settlement-only values when the v2 settlement basis is none', () => {
    const canonical = registrationV2Canonical(registrationV2Payload({
      settlementType: 'TYPE1',
      basis: 'NONE',
      accountType: 'DEDICATED',
      settlementSystem: 'BOTAEM_E',
      laborSettlementBasis: 'INCLUDE_ACTUAL_SALARY',
      financialYears: [
        { year: 2026, contractAmount: 100_000, salesVatAmount: 10_000, totalRevenueAmount: 40_000, totalActualCost: 25_000, supportAmount: 0, profitRate: 0, confirmed: true },
        { year: 2027, contractAmount: 200_000, salesVatAmount: 20_000, totalRevenueAmount: 80_000, totalActualCost: 50_000, supportAmount: 10_000, profitRate: 0.9, confirmed: true },
      ],
    }));

    expect(canonical.projectRequest.payload.financialYears).toEqual([
      expect.objectContaining({ year: 2026, profitRate: 0.4 }),
      expect.objectContaining({ year: 2027, profitRate: 0.4 }),
    ]);
    expect(canonical.projectRequest.payload).toMatchObject({
      settlementType: 'TYPE1',
      basis: 'NONE',
      accountType: 'NONE',
      settlementSystem: 'NONE',
      laborSettlementBasis: 'NONE',
    });
  });

  it('allows a registration whose requester is also the designated organization-head approver', () => {
    expect(registrationV2Canonical(registrationV2Payload({
      executiveApproverId: 'pm-a',
      executiveApproverName: 'PM A',
      executiveApproverEmail: 'pm-a@example.com',
    })).project.executiveApproverId).toBe('pm-a');
  });

  it('preserves a new registration project name longer than 10 characters', () => {
    expect(registrationV2Canonical(registrationV2Payload({
      name: '26프로젝트이름글자수제한없는테스트',
    })).projectRequest.payload.name).toBe('26프로젝트이름글자수제한없는테스트');
  });

  it('accepts a registration without the retired final-responsible role', () => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      teamMembersDetailed: [{
        memberName: '변민욱', memberNickname: '보람', role: '운영매니저', participationRate: 50, isDocumentOnly: false,
      }],
    }))).not.toThrow();
  });

  it('accepts role-free sheet-backed rows and preserves null, zero, changed, and multi-year rates', () => {
    const canonical = registrationV2Canonical(registrationV2Payload({
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit',
      teamMembersDetailed: [{
        memberName: '김정태',
        memberNickname: '에이블',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        laborAllocationEndMonth: '2027-12',
        monthlyRates: {
          '2026-01': null,
          '2026-02': 0,
          '2026-03': 10,
          '2027-01': 5,
        },
      }],
    }));

    expect(canonical.project.teamMembersDetailed).toEqual([
      expect.objectContaining({
        role: '',
        monthlyRates: {
          '2026-01': null,
          '2026-02': 0,
          '2026-03': 10,
          '2027-01': 5,
        },
      }),
    ]);
  });

  it('does not apply manual settlement-support assignment rules to sheet-backed rows', () => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit',
      teamMembersDetailed: [{
        memberName: '새 정산 담당자',
        memberNickname: '',
        role: '정산지원',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        laborAllocationEndMonth: '2026-12',
        monthlyRates: { '2026-01': 20 },
      }],
    }))).not.toThrow();
  });

  it('accepts an open-ended sheet-backed stint and preserves its monthly rates', () => {
    const canonical = registrationV2Canonical(registrationV2Payload({
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit',
      teamMembersDetailed: [{
        memberName: '김정태',
        memberNickname: '에이블',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        monthlyRates: { '2026-01': 20, '2027-01': null },
      }],
    }));

    expect(canonical.project.teamMembersDetailed).toEqual([
      expect.objectContaining({
        laborAllocationStartMonth: '2026-01',
        monthlyRates: { '2026-01': 20, '2027-01': null },
      }),
    ]);
  });

  it('rejects an open-ended sheet-backed rate after the project contract end month', () => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit',
      contractEnd: '2027-12-31',
      teamMembersDetailed: [{
        memberName: '김정태',
        memberNickname: '에이블',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        monthlyRates: { '2099-01': 20 },
      }],
    }))).toThrowError(/outside the labor allocation period/);
  });

  it('rejects an explicitly long sheet stint that extends past the project contract end month', () => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit',
      contractEnd: '2027-12-31',
      teamMembersDetailed: [{
        memberName: '김정태',
        memberNickname: '에이블',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        laborAllocationEndMonth: '2099-12',
        monthlyRates: { '2099-01': 20 },
      }],
    }))).toThrowError(/outside the project contract period/);
  });

  it.each([
    ['starts before the project contract', '2025-01', '2026-12'],
    ['ends after the project contract', '2026-01', '2028-12'],
  ])('rejects a sheet stint that %s even when its saved rate month is inside the contract', (
    _label,
    laborAllocationStartMonth,
    laborAllocationEndMonth,
  ) => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit',
      contractStart: '2026-01-01',
      contractEnd: '2027-12-31',
      teamMembersDetailed: [{
        memberName: '김정태',
        memberNickname: '에이블',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth,
        laborAllocationEndMonth,
        monthlyRates: { '2026-01': 20 },
      }],
    }))).toThrowError(/outside the project contract period/);
  });

  it('requires a sheet link whenever the saved roster contains sheet-backed monthly rates', () => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      participationSheetLink: '',
      teamMembersDetailed: [{
        memberName: '김정태',
        memberNickname: '에이블',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        monthlyRates: { '2026-01': 20 },
      }],
    }))).toThrowError(/participationSheetLink/);
  });

  it.each([
    ['a legacy manual roster', [{
      memberName: '변민욱', memberNickname: '보람', role: '운영매니저', participationRate: 50,
    }]],
    ['a placeholder-only empty roster', []],
  ])('requires the participation sheet link for V2 even with %s', (_label, teamMembersDetailed) => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      participationSheetLink: '',
      teamMembersDetailed,
    }))).toThrowError(/participationSheetLink/);
  });

  it('accepts a linked nickname-only row and an all-placeholder sheet mapped to an empty roster', () => {
    const participationSheetLink = 'https://docs.google.com/spreadsheets/d/sheet-a/edit';
    expect(() => registrationV2Canonical(registrationV2Payload({
      participationSheetLink,
      teamMembersDetailed: [{
        personId: 'person-able',
        memberName: '',
        memberNickname: '에이블',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        monthlyRates: { '2026-01': 20 },
      }],
    }))).not.toThrow();
    expect(() => registrationV2Canonical(registrationV2Payload({
      participationSheetLink,
      teamMembersDetailed: [],
    }))).not.toThrow();
  });

  it.each([
    ['the same linked person under different labels', [
      {
        personId: 'person-able',
        memberName: '김정태',
        memberNickname: '에이블',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        monthlyRates: { '2026-02': 20 },
      },
      {
        personId: 'person-able',
        memberName: '김정태',
        memberNickname: 'ABLE',
        role: '',
        participationRate: 30,
        laborAllocationStartMonth: '2026-02',
        monthlyRates: { '2026-02': 30 },
      },
    ]],
    ['the same pending identity', [
      {
        memberName: '김혜령',
        memberNickname: '테일러',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        monthlyRates: { '2026-03': 0 },
      },
      {
        memberName: '김혜령',
        memberNickname: '테일러',
        role: '',
        participationRate: 30,
        laborAllocationStartMonth: '2026-03',
        monthlyRates: { '2026-03': 30 },
      },
    ]],
    ['a linked and pending row with the same sheet identity', [
      {
        personId: 'person-able',
        memberName: '김정태',
        memberNickname: '에이블',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        monthlyRates: { '2026-04': 20 },
      },
      {
        memberName: '김정태',
        memberNickname: '에이블',
        role: '',
        participationRate: 30,
        laborAllocationStartMonth: '2026-04',
        monthlyRates: { '2026-04': 30 },
      },
    ]],
  ])('rejects duplicate sheet month ownership for %s', (_label, teamMembersDetailed) => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit',
      teamMembersDetailed,
    }))).toThrowError(/duplicate monthlyRates ownership/);
  });

  it('accepts two non-overlapping sheet stints for the same person', () => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit',
      teamMembersDetailed: [
        {
          personId: 'person-able',
          memberName: '김정태',
          memberNickname: '에이블',
          role: '',
          participationRate: 20,
          laborAllocationStartMonth: '2026-01',
          laborAllocationEndMonth: '2026-01',
          monthlyRates: { '2026-01': 20 },
        },
        {
          personId: 'person-able',
          memberName: '김정태',
          memberNickname: '에이블',
          role: '',
          participationRate: 30,
          laborAllocationStartMonth: '2026-02',
          monthlyRates: { '2026-02': 30 },
        },
      ],
    }))).not.toThrow();
  });

  it('keeps parser semantics when one overlapping sheet stint is still missing', () => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit',
      teamMembersDetailed: [
        {
          personId: 'person-able', memberName: '김정태', memberNickname: '에이블', role: '',
          participationRate: 20, laborAllocationStartMonth: '2026-01',
          monthlyRates: { '2026-02': null },
        },
        {
          personId: 'person-able', memberName: '김정태', memberNickname: 'ABLE', role: '',
          participationRate: 30, laborAllocationStartMonth: '2026-02',
          monthlyRates: { '2026-02': 30 },
        },
      ],
    }))).not.toThrow();
  });

  it('treats distinct canonical person IDs as distinct even when their normalized text collides', () => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit',
      teamMembersDetailed: [
        {
          personId: 'person.a',
          memberName: '사람 A',
          memberNickname: 'A',
          role: '',
          participationRate: 20,
          laborAllocationStartMonth: '2026-01',
          monthlyRates: { '2026-01': 20 },
        },
        {
          personId: 'person-a',
          memberName: '사람 B',
          memberNickname: 'B',
          role: '',
          participationRate: 30,
          laborAllocationStartMonth: '2026-01',
          monthlyRates: { '2026-01': 30 },
        },
      ],
    }))).not.toThrow();
  });

  it.each([
    ['invalid month', { '2026-1': 20 }],
    ['out-of-range rate', { '2026-01': 101 }],
    ['month before stint', { '2025-12': 20 }],
  ])('rejects sheet-backed monthlyRates with %s', (_label, monthlyRates) => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      teamMembersDetailed: [{
        memberName: '김정태',
        memberNickname: '에이블',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        laborAllocationEndMonth: '2027-12',
        monthlyRates,
      }],
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit',
    }))).toThrowError(/monthlyRates/);
  });

  it('preserves the participation sheet link through a portal change request and approved project patch', () => {
    const currentLink = 'https://docs.google.com/spreadsheets/d/sheet-a/edit';
    const nextLink = 'https://docs.google.com/spreadsheets/d/sheet-b/edit';
    const canonical = registrationV2Canonical(
      registrationV2Payload({ participationSheetLink: currentLink }),
      registrationV2AttachmentKinds,
      registrationV2AttachmentKinds,
    );
    const payload = {
      ...canonical.projectRequest.payload,
      participationSheetLink: nextLink,
    };
    const submission = buildProjectInfoChangeSubmission({
      tenantId: 'mysc',
      project: canonical.project,
      previousRequest: canonical.projectRequest,
      payload,
      attachmentRefs: [],
      actorId: 'pm-a',
      actorName: 'PM A',
      actorEmail: 'pm-a@example.com',
      timestamp: '2026-08-21T00:00:00.000Z',
      targetProjectVersion: 2,
    });

    expect(canonical.project.participationSheetLink).toBe(currentLink);
    expect(canonical.projectRequest.payload.participationSheetLink).toBe(currentLink);
    expect(submission.projectRequest.proposedSnapshot.participationSheetLink).toBe(nextLink);
    expect(buildProjectPatchFromChangeRequestPayload(payload, canonical.project).participationSheetLink).toBe(nextLink);
  });

  it('rejects a change submission that carries sheet rates without a participation sheet link', () => {
    const currentProject = registrationV2Canonical(registrationV2Payload()).project;
    const payload = {
      ...registrationV2Payload(),
      participationSheetLink: '',
      teamMembersDetailed: [{
        memberName: '김정태',
        memberNickname: '에이블',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        monthlyRates: { '2026-01': 20 },
      }],
    };

    expect(() => changeSubmission(payload, currentProject)).toThrowError(/participationSheetLink/);
    expect(() => buildProjectPatchFromChangeRequestPayload(payload, currentProject))
      .toThrowError(/participationSheetLink/);
  });

  it('rejects a V2 change submission with a manual roster but no participation sheet link', () => {
    const currentProject = registrationV2Canonical(registrationV2Payload()).project;
    const payload = registrationV2Payload({
      participationSheetLink: '',
      teamMembersDetailed: [{
        memberName: '변민욱', memberNickname: '보람', role: '운영매니저', participationRate: 50,
      }],
    });

    expect(() => changeSubmission(payload, currentProject)).toThrowError(/participationSheetLink/);
    expect(() => buildProjectPatchFromChangeRequestPayload(payload, currentProject))
      .toThrowError(/participationSheetLink/);
  });

  it('preserves the current participation roster when a portal change does not touch it', () => {
    const currentProject = registrationV2Canonical(registrationV2Payload()).project;

    const patch = buildProjectPatchFromChangeRequestPayload({ name: '이름만 변경' }, currentProject);

    expect({ ...currentProject, ...patch }.teamMembersDetailed).toEqual(currentProject.teamMembersDetailed);
    expect({ ...currentProject, ...patch }.participationSheetLink).toBe(currentProject.participationSheetLink);
  });

  it('grandfathers an unrelated edit to a V2 project created before sheet links existed', () => {
    const currentProject = {
      ...registrationV2Canonical(registrationV2Payload()).project,
      participationSheetLink: '',
    };

    const patch = buildProjectPatchFromChangeRequestPayload({ name: '이름만 변경' }, currentProject);

    expect({ ...currentProject, ...patch }.teamMembersDetailed).toEqual(currentProject.teamMembersDetailed);
    expect({ ...currentProject, ...patch }.participationSheetLink).toBe('');
  });

  it('requires sheet onboarding at submit when a pre-link V2 project changes its contract period', () => {
    const currentProject = {
      ...registrationV2Canonical(registrationV2Payload()).project,
      participationSheetLink: '',
    };
    const payload = {
      ...registrationV2Payload({ participationSheetLink: '' }),
      contractEnd: '2028-12-31',
    };

    expect(() => changeSubmission(payload, currentProject)).toThrowError(/participationSheetLink/);
    expect(() => buildProjectPatchFromChangeRequestPayload({ contractEnd: '2028-12-31' }, currentProject))
      .toThrowError(/participationSheetLink/);
  });

  it('requires a participation sheet link at submit when a legacy project is upgraded to V2', () => {
    const currentProject = {
      id: 'project-legacy',
      version: 1,
      registrationRequirementsVersion: 1,
      participationSheetLink: '',
      registeredById: 'pm-a',
      managerId: 'pm-a',
      teamMembersDetailed: [{
        memberName: '변민욱', memberNickname: '보람', role: '운영매니저', participationRate: 50,
      }],
    };

    expect(() => changeSubmission(registrationV2Payload({ participationSheetLink: '' }), currentProject))
      .toThrowError(/participationSheetLink/);
    expect(() => buildProjectPatchFromChangeRequestPayload({
      registrationRequirementsVersion: 2,
    }, currentProject)).toThrowError(/participationSheetLink/);
  });

  it('rejects a change submission whose sheet-backed row has no person identity', () => {
    const currentProject = registrationV2Canonical(registrationV2Payload()).project;
    const payload = {
      ...registrationV2Payload(),
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit',
      teamMembersDetailed: [{
        memberName: '',
        memberNickname: '',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        monthlyRates: { '2026-01': 20 },
      }],
    };

    expect(() => changeSubmission(payload, currentProject)).toThrowError(/identity is required/);
    expect(() => buildProjectPatchFromChangeRequestPayload(payload, currentProject))
      .toThrowError(/identity is required/);
  });

  it('opens the edit-form draft seed even when the saved roster is sheet-backed without a sheet link', () => {
    const project = {
      ...registrationV2Canonical(registrationV2Payload()).project,
      participationSheetLink: '',
      teamMembersDetailed: [{
        memberName: '김정태',
        memberNickname: '에이블',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        monthlyRates: { '2026-01': 20 },
      }],
    };

    const seed = buildProjectInfoDraftSeed(project, {});

    expect(seed.teamMembersDetailed).toHaveLength(1);
    expect(seed.teamMembersDetailed[0].monthlyRates).toEqual({ '2026-01': 20 });
  });

  it('submits a repaired sheet link without revalidating the legacy before snapshot', () => {
    const sheetMember = {
      memberName: '김정태',
      memberNickname: '에이블',
      role: '',
      participationRate: 20,
      laborAllocationStartMonth: '2026-01',
      monthlyRates: { '2026-01': 20 },
    };
    const canonical = registrationV2Canonical(
      registrationV2Payload({
        participationSheetLink: 'https://docs.google.com/spreadsheets/d/repaired/edit',
        teamMembersDetailed: [sheetMember],
      }),
      registrationV2AttachmentKinds,
      registrationV2AttachmentKinds,
    );
    const legacyProject = {
      ...canonical.project,
      participationSheetLink: '',
      teamMembersDetailed: [sheetMember],
    };

    const openedDraft = buildProjectInfoDraftSeed(legacyProject, {});
    const submission = changeSubmission({
      ...openedDraft,
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/repaired/edit',
      teamMembersDetailed: [sheetMember],
    }, legacyProject);

    expect(submission.projectRequest.proposedSnapshot.participationSheetLink)
      .toBe('https://docs.google.com/spreadsheets/d/repaired/edit');
  });

  it('uses the current project contract end when a partial change omits contractEnd', () => {
    const currentProject = {
      ...registrationV2Canonical(registrationV2Payload()).project,
      contractEnd: '2027-12-31',
    };
    const payload = {
      teamMembersDetailed: [{
        memberName: '김정태',
        memberNickname: '에이블',
        role: '',
        participationRate: 20,
        laborAllocationStartMonth: '2026-01',
        monthlyRates: { '2099-01': 20 },
      }],
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/sheet-a/edit',
    };

    expect(() => buildProjectPatchFromChangeRequestPayload(payload, currentProject))
      .toThrowError(/outside the labor allocation period/);
  });

  it('allows only 도담 or 써니 as settlement support', () => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      teamMembersDetailed: [
        {
          memberName: '변민욱', memberNickname: '보람', role: '운영매니저', participationRate: 50, isDocumentOnly: false,
        },
        {
          memberName: '김세은', memberNickname: '람쥐', role: '총괄책임자', participationRate: 0, isDocumentOnly: false,
        },
        {
          memberName: '다른 구성원', memberNickname: '', role: '정산지원', participationRate: 0, isDocumentOnly: false,
        },
      ],
    }))).toThrowError('Project registration settlement support must be 도담 or 써니');
  });

  it('allows a change request whose submitter is also the designated organization-head approver', () => {
    const payload = registrationV2Payload({
      executiveApproverId: 'pm-a',
      executiveApproverName: 'PM A',
      executiveApproverEmail: 'pm-a@example.com',
    });
    const attachmentRefs = registrationV2AttachmentKinds.map((documentKind) => ({
      documentKind,
      path: `orgs/mysc/project-registration-drafts/change-v2/${documentKind}.pdf`,
      name: `${documentKind}.pdf`,
      size: 3,
      contentType: 'application/pdf',
    }));

    expect(buildProjectInfoChangeSubmission({
      tenantId: 'mysc',
      project: { id: 'project-v2', version: 4, registeredById: 'pm-a', managerId: 'pm-a' },
      previousRequest: null,
      payload,
      attachmentRefs,
      actorId: 'pm-a',
      actorName: 'PM A',
      actorEmail: 'pm-a@example.com',
      timestamp: '2026-07-14T00:00:00.000Z',
      targetProjectVersion: 5,
    }).projectRequest.payload.executiveApproverId).toBe('pm-a');
  });

  it('keeps an organization-head rejection unchanged while creating a pending request', () => {
    const canonical = registrationV2Canonical(
      registrationV2Payload(),
      registrationV2AttachmentKinds,
      registrationV2AttachmentKinds,
    );
    const submission = buildProjectInfoChangeSubmission({
      tenantId: 'mysc',
      project: {
        ...canonical.project,
        executiveReviewStatus: 'REVISION_REJECTED',
        executiveReviewedAt: '2026-07-13T00:00:00.000Z',
        executiveReviewedById: 'head-a',
        executiveReviewedByName: '조직장 A',
        executiveReviewComment: '계약 기간을 보완해 주세요.',
      },
      previousRequest: null,
      payload: { ...canonical.projectRequest.payload, description: '조직장 반려 보완본' },
      attachmentRefs: [],
      actorId: 'pm-a',
      actorName: 'PM A',
      actorEmail: 'pm-a@example.com',
      timestamp: '2026-07-14T00:00:00.000Z',
      resubmit: false,
      reviewComment: '계약 기간을 보완했습니다.',
    });

    expect(submission).not.toHaveProperty('projectPatch');
    expect(submission.projectRequest).toMatchObject({
      status: 'PENDING',
      baseProjectVersion: 1,
      targetProjectVersion: 2,
    });
  });

  it('keeps a planning rejection unchanged while creating a pending request', () => {
    const canonical = registrationV2Canonical(
      registrationV2Payload(),
      registrationV2AttachmentKinds,
      registrationV2AttachmentKinds,
    );
    const submission = buildProjectInfoChangeSubmission({
      tenantId: 'mysc',
      project: {
        ...canonical.project,
        executiveReviewStatus: 'APPROVED',
        executiveReviewedAt: '2026-07-12T00:00:00.000Z',
        executiveReviewedById: 'head-a',
        executiveReviewedByName: '조직장 A',
        managementPlanningReviewStatus: 'REVISION_REJECTED',
        managementPlanningReviewedAt: '2026-07-13T00:00:00.000Z',
        managementPlanningReviewedById: 'planning-a',
        managementPlanningReviewedByName: '경영기획실 A',
        managementPlanningReviewComment: '프로젝트 코드를 확인해 주세요.',
      },
      previousRequest: null,
      payload: { ...canonical.projectRequest.payload, description: '경영기획실 반려 보완본' },
      attachmentRefs: [],
      actorId: 'pm-a',
      actorName: 'PM A',
      actorEmail: 'pm-a@example.com',
      timestamp: '2026-07-14T00:00:00.000Z',
      resubmit: false,
      reviewComment: '프로젝트 코드 확인 내용을 보완했습니다.',
    });

    expect(submission).not.toHaveProperty('projectPatch');
    expect(submission.projectRequest).toMatchObject({
      status: 'PENDING',
      baseProjectVersion: 1,
      targetProjectVersion: 2,
    });
  });

  it('allows a v2 settlement-none basis with required contract confirmations', () => {
    const canonical = registrationV2Canonical(registrationV2Payload({
      settlementType: 'TYPE1',
      basis: 'NONE',
      settlementSystem: 'NONE',
      laborSettlementBasis: 'NONE',
    }));

    expect(canonical.projectRequest.payload).toMatchObject({
      settlementType: 'TYPE1',
      basis: 'NONE',
    });
    expect(canonical.projectRequest.payload.registrationConfirmations).toBeDefined();
  });

  it.each(registrationV2RequiredAttachmentKinds)('requires the %s registration attachment', (missingKind) => {
    expect(() => registrationV2Canonical(
      registrationV2Payload(),
      registrationV2RequiredAttachmentKinds.filter((kind) => kind !== missingKind),
    )).toThrowError(`Project registration required attachment is missing: ${missingKind}`);
  });

  it('allows optional registration attachments 4 through 7 to be omitted', () => {
    expect(() => registrationV2Canonical(registrationV2Payload(), registrationV2RequiredAttachmentKinds)).not.toThrow();
  });

  it('allows a deferred quote without a quote attachment', () => {
    expect(() => registrationV2Canonical(
      registrationV2Payload({ quoteSubmissionDeferred: true }),
      ['contract', 'customer_business_registration'],
    )).not.toThrow();
  });

  it('accepts all seven required attachments and preserves a legacy proposal as an extra document', () => {
    expect(() => registrationV2Canonical(
      registrationV2Payload(),
      [...registrationV2AttachmentKinds, 'proposal'],
      [...registrationV2AttachmentKinds, 'proposal'],
    )).not.toThrow();
  });

  it('accepts the PPT settlement-none basis for registration v2', () => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      settlementType: 'TYPE1',
      basis: 'NONE',
    }))).not.toThrow();
  });

  it('rejects the removed settlement-none business type for a new registration', () => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      settlementType: 'NONE',
    }))).toThrowError('Project registration settlementType NONE is not available in requirements version 2');
  });

  it('rejects the removed 기타 settlement basis for registration v2', () => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      basis: '기타',
    }))).toThrowError('Project registration basis is invalid for requirements version 2');
  });

  it('preserves the PPT 기타 bank-account type for registration v2', () => {
    const canonical = registrationV2Canonical(registrationV2Payload({
      accountType: 'OTHER',
    }));

    expect(canonical.projectRequest.payload.accountType).toBe('OTHER');
  });

  it.each(['IRIS', 'ACCOUNTANT'])('preserves supported %s settlement-system codes', (settlementSystem) => {
    const canonical = registrationV2Canonical(registrationV2Payload({ settlementSystem }));

    expect(canonical.projectRequest.payload.settlementSystem).toBe(settlementSystem);
    expect(canonical.project.settlementSystem).toBe(settlementSystem);
  });

  it.each([
    ['settlement type', { settlementType: 'TYPE9' }, 'Project registration settlementType is invalid'],
    ['settlement basis', { basis: 'garbage' }, 'Project registration basis is invalid'],
    ['account type', { accountType: 'garbage' }, 'Project registration accountType is invalid'],
    ['settlement system', { settlementSystem: 'garbage' }, 'Project registration settlementSystem is invalid'],
    ['labor settlement basis', { laborSettlementBasis: 'garbage' }, 'Project registration laborSettlementBasis is invalid'],
  ])('rejects an unknown %s instead of normalizing it to NONE', (_label, overrides, message) => {
    expect(() => registrationV2Canonical(registrationV2Payload(overrides))).toThrowError(message);
  });

  it.each([undefined, 1])('rejects new canonical registration requirements version %s', (version) => {
    expect(() => registrationV2Canonical(registrationV2Payload({ registrationRequirementsVersion: version })))
      .toThrowError('New project registration requires requirements version 2');
  });

  it.each([
    ['ID', { executiveApproverId: '' }],
    ['name', { executiveApproverName: '' }],
  ])('rejects a registration without an executive approver %s', (_field, overrides) => {
    expect(() => registrationV2Canonical(registrationV2Payload(overrides)))
      .toThrowError('Project registration is missing required fields');
  });

  it('keeps legacy v1 team rows on the legacy path instead of applying v2 row rules', () => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      registrationRequirementsVersion: 1,
      teamMembersDetailed: [{ memberName: '기존 담당자', role: 'PM', participationRate: 50 }],
    }))).toThrowError('New project registration requires requirements version 2');
  });

  it.each([
    [
      'payment expected month',
      { paymentExpectedMonths: { contract: '', interim: '2026-06', final: '2027-12' } },
      'Project registration paymentExpectedMonths.contract is required',
    ],
    [
      'below 70 percent reason',
      {
        paymentPlan: { contract: 100_000, interim: 50_000, final: 150_000 },
        advanceInterimBelow70Reason: '',
      },
      'Project registration advance/interim below 70% reason is required',
    ],
    [
      'team role',
      { teamMembersDetailed: [{ memberName: '변민욱', role: 'PM', participationRate: 50, isDocumentOnly: false }] },
      'Project registration teamMembersDetailed.0.role is invalid',
    ],
    [
      'operating manager',
      { teamMembersDetailed: [{ memberName: '변민욱', role: '실무책임자', participationRate: 50, isDocumentOnly: false }] },
      'Project registration requires at least one operating manager',
    ],
  ])('rejects registration v2 with incomplete %s', (_label, overrides, message) => {
    expect(() => registrationV2Canonical(registrationV2Payload(overrides))).toThrowError(message);
  });

  it.each([undefined, true])('accepts a legacy operating manager with isDocumentOnly=%s', (isDocumentOnly) => {
    expect(() => registrationV2Canonical(registrationV2Payload({
      teamMembersDetailed: [{
        memberName: '변민욱',
        role: '운영매니저',
        participationRate: 0,
        ...(isDocumentOnly === undefined ? {} : { isDocumentOnly }),
      }],
    }))).not.toThrow();
  });

  it('preserves version 1 compatibility for an existing-project change request', () => {
    const patch = buildProjectPatchFromChangeRequestPayload(
      registrationV2Payload({ registrationRequirementsVersion: 1 }),
      { id: 'existing-project', version: 3 },
    );

    expect(patch.registrationRequirementsVersion).toBe(1);
  });

  it('preserves confirmations and historical finance weeks on an existing-project change', () => {
    const legacyConfirmations = registrationV2Payload().registrationConfirmations;
    const payload = registrationV2Payload({ registrationConfirmations: legacyConfirmations });
    const patch = buildProjectPatchFromChangeRequestPayload(payload, { id: 'existing-project', version: 3, finalPaymentExpectedWeek: '27-12-4', financialYears: payload.financialYears });

    expect(patch.registrationConfirmations).toEqual(legacyConfirmations);
    expect(patch).toMatchObject({
      totalActualCost: 75_000,
      interestRefundPolicy: 'REFUND',
      quoteSubmissionDeferred: false,
      financialYears: [
        expect.objectContaining({ paymentPlan: { contract: 50_000, interim: 20_000, final: 30_000 }, advanceInterimBelow70Reason: '연차별 일정', isSettled: true }),
        expect.objectContaining({ paymentPlan: { contract: 100_000, interim: 40_000, final: 60_000 }, isSettled: false }),
      ],
    });
    expect(patch.finalPaymentExpectedWeek).toBe('27-12-4');
    expect(patch.financialYears?.[0]?.finalPaymentExpectedWeek).toBe('26-8-1');
  });

  it('preserves legacy finance notes when a change request omits or empties their payload fields', () => {
    const payload = registrationV2Payload({ interestRefundPolicy: '' });
    delete (payload as Record<string, unknown>).finalPaymentNote;
    const patch = buildProjectPatchFromChangeRequestPayload(payload, {
      interestRefundPolicy: 'MYSC_REVENUE',
      finalPaymentNote: '레거시 메모',
    });

    expect(patch.interestRefundPolicy).toBe('MYSC_REVENUE');
    expect(patch).not.toHaveProperty('finalPaymentNote');
  });

  it('preserves a legacy groupware name when a v2 project change request omits the hidden field', () => {
    const patch = buildProjectPatchFromChangeRequestPayload(
      registrationV2Payload(),
      { id: 'existing-project', groupwareName: '기존 그룹웨어 등록명' },
    );

    expect(patch.groupwareName).toBe('기존 그룹웨어 등록명');
  });

  it.each(['pm', 'viewer'])('requires the private draft flow when %s creates a project directly', async (actorRole) => {
    const idempotencyService = {
      begin: vi.fn(async () => ({ mode: 'acquired', requestFingerprint: 'fingerprint-a' })),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const db = {
      doc: vi.fn(() => ({ get: vi.fn(async () => ({ exists: false, data: () => undefined })) })),
    };
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.context = {
        tenantId: 'mysc',
        actorId: 'member-a',
        actorRole,
        actorEmail: 'member-a@example.com',
        requestId: 'request-a',
        idempotencyKey: `create-${actorRole}`,
      };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-14T00:00:00.000Z',
      idempotencyService,
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app).post('/api/v1/projects').send({ id: 'project-a', name: 'Project A' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('project_registration_draft_required');
    expect(idempotencyService.complete).not.toHaveBeenCalled();
  });

  it('collects distinct custom staffing roles from stored projects, most used first', async () => {
    const projects = [
      { staffing: { others: [{ role: '멘토' }, { role: '강사' }] } },
      { staffing: { others: [{ role: ' 멘토 ' }, { role: '' }, { role: '촉진자' }] } },
      { staffing: { operators: [] } },
      {},
    ];
    const db = {
      collection: vi.fn(() => ({
        select: vi.fn(() => ({
          get: vi.fn(async () => ({ docs: projects.map((data) => ({ data: () => data })) })),
        })),
      })),
    };
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.context = {
        tenantId: 'mysc', actorId: 'member-a', actorRole: 'pm',
        actorEmail: 'member-a@example.com', requestId: 'request-a',
      };
      next();
    });
    mountProjectRoutes(app, { db, now: () => '2026-09-04T00:00:00.000Z' } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app).get('/api/v1/projects/staffing-roles');

    expect(response.status).toBe(200);
    // 멘토는 두 사업에서 쓰였으므로 먼저. 나머지는 가나다순. 빈 역할명은 목록에 없다.
    expect(response.body.roles).toEqual(['멘토', '강사', '촉진자']);
    expect(db.collection).toHaveBeenCalledWith('orgs/mysc/projects');
  });

  it('requires a participation sheet link when an admin creates a project directly', async () => {
    const db = {
      doc: vi.fn(() => ({ get: vi.fn(async () => ({ exists: false, data: () => undefined })) })),
      runTransaction: vi.fn(),
    };
    const idempotencyService = {
      begin: vi.fn(async () => ({ mode: 'acquired', requestFingerprint: 'fingerprint-a' })),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.context = {
        tenantId: 'mysc', actorId: 'admin-a', actorRole: 'admin', actorEmail: 'admin-a@example.com',
        requestId: 'request-a', idempotencyKey: 'admin-create-without-participation-sheet',
      };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-08-21T00:00:00.000Z',
      idempotencyService,
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app).post('/api/v1/projects').send({
      id: 'project-new',
      name: '신규 사업',
      registrationRequirementsVersion: 2,
    });

    expect(response.status).toBe(422);
    expect(response.body.error).toBe('project_registration_invalid');
    expect(db.runTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['sheet rates', undefined, [{
      memberName: '김정태',
      memberNickname: '에이블',
      role: '',
      participationRate: 20,
      laborAllocationStartMonth: '2026-01',
      monthlyRates: { '2026-01': 20 },
    }]],
    ['a V2 manual roster', 2, [{
      memberName: '변민욱',
      memberNickname: '보람',
      role: '운영매니저',
      participationRate: 50,
    }]],
  ])('rejects direct project updates with %s and no participation sheet link', async (
    _label,
    registrationRequirementsVersion,
    teamMembersDetailed,
  ) => {
    const projectRef = {
      path: 'orgs/mysc/projects/project-a',
      get: vi.fn(async () => ({
        exists: true,
        data: () => ({ id: 'project-a', version: 1, contractEnd: '2027-12-31' }),
      })),
    };
    const db = {
      doc: vi.fn(() => projectRef),
      runTransaction: vi.fn(),
    };
    const idempotencyService = {
      begin: vi.fn(async () => ({ mode: 'acquired', requestFingerprint: 'fingerprint-a' })),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.context = {
        tenantId: 'mysc',
        actorId: 'admin-a',
        actorRole: 'admin',
        actorEmail: 'admin-a@example.com',
        requestId: 'request-a',
        idempotencyKey: 'project-sheet-link-required',
      };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-08-21T00:00:00.000Z',
      idempotencyService,
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app).post('/api/v1/projects').send({
      id: 'project-a',
      name: '시트 링크 누락 사업',
      expectedVersion: 1,
      contractStart: '2026-01-01',
      contractEnd: '2027-12-31',
      ...(registrationRequirementsVersion ? { registrationRequirementsVersion } : {}),
      participationSheetLink: '',
      teamMembersDetailed,
    });

    expect(response.status).toBe(422);
    expect(response.body.error).toBe('project_registration_invalid');
    expect(db.runTransaction).not.toHaveBeenCalled();
  });

  it('applies checkout state and private evidence fields when a change request is approved', () => {
    const document = { path: 'orgs/mysc/project-registration-documents/project-v2/evidence.pdf', name: 'evidence.pdf' };
    const patch = buildProjectPatchFromChangeRequestPayload({
      ...registrationV2Payload(),
      status: 'COMPLETED',
      checkout: {
        finalPaymentReceived: true,
        bankBalanceZero: true,
        performanceCertificateReceived: true,
        taxInvoiceEvidenceConfirmed: true,
        finalSettlementReportConfirmed: true,
        usbEvidenceSubmitted: true,
        evidenceDeletedAfterUsb: true,
      },
      performanceCertificateDocument: document,
      taxInvoiceDocument: document,
      finalSettlementReportDocument: document,
    }, { id: 'project-v2' });

    expect(patch).toMatchObject({
      checkout: { usbEvidenceSubmitted: true, evidenceDeletedAfterUsb: true },
      performanceCertificateDocument: document,
      taxInvoiceDocument: document,
      finalSettlementReportDocument: document,
    });
  });

  it.each([
    [
      'one contract year is missing',
      registrationV2Payload({ financialYears: [
        { year: 2026, contractAmount: 300_000, salesVatAmount: 30_000, totalRevenueAmount: 120_000, totalActualCost: 75_000, supportAmount: 10_000, profitRate: 0.4, confirmed: true },
      ] }),
      registrationV2AttachmentKinds,
    ],
    [
      'annual totals do not match the canonical total',
      registrationV2Payload({ contractAmount: 300_001 }),
      registrationV2AttachmentKinds,
    ],
    [
      'annual profit rate is outside 0..1',
      registrationV2Payload({ financialYears: [
        { year: 2026, contractAmount: 100_000, salesVatAmount: 10_000, totalRevenueAmount: 40_000, totalActualCost: 25_000, supportAmount: 0, profitRate: 1.01, confirmed: true },
        { year: 2027, contractAmount: 200_000, salesVatAmount: 20_000, totalRevenueAmount: 80_000, totalActualCost: 50_000, supportAmount: 10_000, profitRate: 0.4, confirmed: true },
      ] }),
      registrationV2AttachmentKinds,
    ],
    [
      'customer business registration is missing',
      registrationV2Payload(),
      ['contract', 'quote', 'rfp_request_evidence'],
    ],
  ])('rejects registration v2 when %s', (_label, payload, requiredKinds) => {
    let caught: unknown;
    try {
      registrationV2Canonical(payload, requiredKinds);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      statusCode: 422,
      code: 'project_registration_invalid',
    });
  });

  it.each([
    ['invalid interest refund policy', registrationV2Payload({ interestRefundPolicy: 'KEEP' })],
    ['invalid PPT URL', registrationV2Payload({
      registrationConfirmations: {
        ...registrationV2Payload().registrationConfirmations,
        proposalPptOriginal: 'https://example.com/proposal.pptx',
      },
    })],
  ])('rejects registration v2 with %s as 422', (_label, payload) => {
    expect(() => registrationV2Canonical(payload)).toThrow(expect.objectContaining({
      statusCode: 422,
      code: 'project_registration_invalid',
    }));
  });

  it('serves a canonical private attachment only through the authorized BFF route', async () => {
    const path = 'orgs/mysc/project-registration-documents/project-a/attachment-a-contract.pdf';
    const downloadProjectRegistrationAttachment = vi.fn(async () => ({
      buffer: Buffer.from('private-pdf'),
      contentType: 'application/pdf',
      size: 11,
    }));
    const db = {
      doc: vi.fn((documentPath: string) => ({
        get: vi.fn(async () => ({
          exists: true,
          data: () => documentPath.includes('/members/')
            ? { uid: 'admin-a', role: 'admin', status: 'ACTIVE', projectIds: [] }
            : {
                id: 'project-a',
                contractDocument: {
                  path,
                  name: '계약서"\r\nX-Test: injected.pdf',
                  contentType: 'application/pdf',
                },
              },
        })),
      })),
    };
    const app = express();
    app.use((req: any, _res, next) => {
      req.context = { tenantId: 'mysc', actorId: 'admin-a', actorRole: 'admin' };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-10T00:00:00.000Z',
      idempotencyService: {},
      projectRequestContractStorageService: { downloadProjectRegistrationAttachment },
    } as any);

    const response = await request(app).get('/api/v1/projects/project-a/attachments/contract');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-disposition']).toContain('%22%0D%0AX-Test%3A%20injected.pdf');
    expect(response.headers['x-test']).toBeUndefined();
    expect(response.body).toEqual(Buffer.from('private-pdf'));
    expect(downloadProjectRegistrationAttachment).toHaveBeenCalledWith({
      tenantId: 'mysc', projectId: 'project-a', path,
    });
  });

  it('denies an unassigned member who is not the designated approver', async () => {
    const projectGet = vi.fn(async () => ({
      exists: true,
      data: () => ({
        id: 'project-a',
        contractDocument: {
          path: 'orgs/mysc/project-registration-documents/project-a/contract.pdf',
          name: 'contract.pdf',
        },
      }),
    }));
    const db = {
      doc: vi.fn((documentPath: string) => ({
        get: documentPath.includes('/members/')
          ? vi.fn(async () => ({
              exists: true,
              data: () => ({ uid: 'pm-a', role: 'pm', status: 'ACTIVE', projectIds: ['project-b'] }),
            }))
          : projectGet,
      })),
    };
    const downloadProjectRegistrationAttachment = vi.fn();
    const app = express();
    app.use((req: any, _res, next) => {
      req.context = { tenantId: 'mysc', actorId: 'pm-a', actorRole: 'admin' };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-10T00:00:00.000Z',
      idempotencyService: {},
      projectRequestContractStorageService: { downloadProjectRegistrationAttachment },
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app).get('/api/v1/projects/project-a/attachments/contract');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
    expect(projectGet).toHaveBeenCalledTimes(1);
    expect(downloadProjectRegistrationAttachment).not.toHaveBeenCalled();
  });

  it('allows the designated approver to read the final project contract', async () => {
    const path = 'orgs/mysc/project-registration-documents/project-a/contract.pdf';
    const downloadProjectRegistrationAttachment = vi.fn(async () => ({
      buffer: Buffer.from('approver-private-pdf'), contentType: 'application/pdf', size: 20,
    }));
    const db = {
      doc: vi.fn((documentPath: string) => ({
        get: vi.fn(async () => ({
          exists: true,
          data: () => documentPath.includes('/members/')
            ? { uid: 'approver-a', role: 'pm', status: 'ACTIVE', projectIds: [] }
            : { id: 'project-a', executiveApproverId: 'approver-a', contractDocument: { path, name: 'contract.pdf' } },
        })),
      })),
    };
    const app = express();
    app.use((req: any, _res, next) => {
      req.context = { tenantId: 'mysc', actorId: 'approver-a', actorRole: 'pm' };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-10T00:00:00.000Z',
      idempotencyService: {},
      projectRequestContractStorageService: { downloadProjectRegistrationAttachment },
    } as any);

    const response = await request(app).get('/api/v1/projects/project-a/attachments/contract');

    expect(response.status).toBe(200);
    expect(downloadProjectRegistrationAttachment).toHaveBeenCalledWith({
      tenantId: 'mysc', projectId: 'project-a', path,
    });
  });

  it('denies a persisted member document whose uid does not match the authenticated actor', async () => {
    const projectGet = vi.fn(async () => ({
      exists: true,
      data: () => ({
        id: 'project-a',
        contractDocument: {
          path: 'orgs/mysc/project-registration-documents/project-a/contract.pdf',
          name: 'contract.pdf',
        },
      }),
    }));
    const db = {
      doc: vi.fn((documentPath: string) => ({
        get: documentPath.includes('/members/')
          ? vi.fn(async () => ({
              exists: true,
              data: () => ({ uid: 'different-actor', role: 'admin', status: 'ACTIVE' }),
            }))
          : projectGet,
      })),
    };
    const downloadProjectRegistrationAttachment = vi.fn();
    const app = express();
    app.use((req: any, _res, next) => {
      req.context = { tenantId: 'mysc', actorId: 'admin-a', actorRole: 'admin' };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-10T00:00:00.000Z',
      idempotencyService: {},
      projectRequestContractStorageService: { downloadProjectRegistrationAttachment },
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app).get('/api/v1/projects/project-a/attachments/contract');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
    expect(projectGet).not.toHaveBeenCalled();
    expect(downloadProjectRegistrationAttachment).not.toHaveBeenCalled();
  });

  it('allows an ACTIVE PM assigned through the persisted portal profile', async () => {
    const path = 'orgs/mysc/project-registration-documents/project-a/contract.pdf';
    const downloadProjectRegistrationAttachment = vi.fn(async () => ({
      buffer: Buffer.from('assigned-private-pdf'), contentType: 'application/pdf', size: 20,
    }));
    const db = {
      doc: vi.fn((documentPath: string) => ({
        get: vi.fn(async () => ({
          exists: true,
          data: () => documentPath.includes('/members/')
            ? {
                uid: 'pm-a', role: 'pm', status: 'ACTIVE',
                portalProfile: { projectIds: ['project-a'] },
              }
            : { id: 'project-a', contractDocument: { path, name: 'contract.pdf' } },
        })),
      })),
    };
    const app = express();
    app.use((req: any, _res, next) => {
      req.context = { tenantId: 'mysc', actorId: 'pm-a', actorRole: 'viewer' };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-10T00:00:00.000Z',
      idempotencyService: {},
      projectRequestContractStorageService: { downloadProjectRegistrationAttachment },
    } as any);

    const response = await request(app).get('/api/v1/projects/project-a/attachments/contract');

    expect(response.status).toBe(200);
    expect(downloadProjectRegistrationAttachment).toHaveBeenCalledWith({
      tenantId: 'mysc', projectId: 'project-a', path,
    });
  });

  it('serves a historical rejected project request attachment only to an active reviewer', async () => {
    const path = 'orgs/mysc/project-registration-documents/project-a/pending-contract.pdf';
    const downloadProjectRegistrationAttachment = vi.fn(async () => ({
      buffer: Buffer.from('pending-private-pdf'), contentType: 'application/pdf', size: 19,
    }));
    const db = {
      doc: vi.fn((documentPath: string) => ({
        get: vi.fn(async () => {
          if (documentPath.includes('/members/')) {
            return {
              exists: true,
              data: () => ({ uid: 'admin-a', role: 'admin', status: 'ACTIVE' }),
            };
          }
          if (documentPath.includes('/project_requests/')) {
            return {
              exists: true,
              data: () => ({
                id: 'change-project-a',
                status: 'REJECTED',
                requestKind: 'CHANGE',
                targetProjectId: 'project-a',
                approvedProjectId: 'project-a',
                payload: {
                  contractDocument: { path, name: 'pending-contract.pdf', contentType: 'application/pdf' },
                },
              }),
            };
          }
          return { exists: false, data: () => null };
        }),
      })),
    };
    const app = express();
    app.use((req: any, _res, next) => {
      req.context = { tenantId: 'mysc', actorId: 'admin-a', actorRole: 'admin' };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-10T00:00:00.000Z',
      idempotencyService: {},
      projectRequestContractStorageService: { downloadProjectRegistrationAttachment },
    } as any);

    const response = await request(app)
      .get('/api/v1/project-requests/change-project-a/attachments/contract');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(Buffer.from('pending-private-pdf'));
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(downloadProjectRegistrationAttachment).toHaveBeenCalledWith({
      tenantId: 'mysc', projectId: 'project-a', path,
    });
  });

  it('allows the designated organization-head approver to read a pending request contract regardless of member role', async () => {
    const path = 'orgs/mysc/project-registration-documents/project-a/pending-contract.pdf';
    const downloadProjectRegistrationAttachment = vi.fn(async () => ({
      buffer: Buffer.from('approver-request-pdf'), contentType: 'application/pdf', size: 20,
    }));
    const db = {
      doc: vi.fn((documentPath: string) => ({
        get: vi.fn(async () => {
          if (documentPath.includes('/members/')) {
            return {
              exists: true,
              data: () => ({ uid: 'head-a', role: 'pm', status: 'ACTIVE' }),
            };
          }
          if (documentPath.includes('/project_requests/')) {
            return {
              exists: true,
              data: () => ({
                id: 'request-a',
                status: 'PENDING',
                targetProjectId: 'project-a',
                payload: {
                  executiveApproverId: 'head-a',
                  contractDocument: { path, name: 'pending-contract.pdf', contentType: 'application/pdf' },
                },
              }),
            };
          }
          return { exists: false, data: () => null };
        }),
      })),
    };
    const app = express();
    app.use((req: any, _res, next) => {
      req.context = { tenantId: 'mysc', actorId: 'head-a', actorRole: 'pm' };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-10T00:00:00.000Z',
      idempotencyService: {},
      projectRequestContractStorageService: { downloadProjectRegistrationAttachment },
    } as any);

    const response = await request(app)
      .get('/api/v1/project-requests/request-a/attachments/contract');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(Buffer.from('approver-request-pdf'));
    expect(downloadProjectRegistrationAttachment).toHaveBeenCalledWith({
      tenantId: 'mysc', projectId: 'project-a', path,
    });
  });

  it('canonicalizes organization labels in registration documents before they are written', () => {
    const canonical = registrationV2Canonical(registrationV2Payload({ department: 'AXR Team' }));

    expect(canonical.projectRequest.payload.department).toBe('AXR팀');
    expect(canonical.project).toMatchObject({ department: 'AXR팀', cic: 'AXR팀' });
  });

  it('denies an unrelated PM after checking the request approver without downloading the attachment', async () => {
    const requestGet = vi.fn(async () => ({
      exists: true,
      data: () => ({
        id: 'request-a',
        status: 'PENDING',
        targetProjectId: 'project-a',
        payload: {
          executiveApproverId: 'head-a',
          contractDocument: {
            path: 'orgs/mysc/project-registration-documents/project-a/contract.pdf',
            name: 'contract.pdf',
          },
        },
      }),
    }));
    const db = {
      doc: vi.fn((documentPath: string) => ({
        get: documentPath.includes('/members/')
          ? vi.fn(async () => ({
              exists: true,
              data: () => ({ uid: 'pm-a', role: 'pm', status: 'ACTIVE', projectIds: ['project-a'] }),
            }))
          : requestGet,
      })),
    };
    const downloadProjectRegistrationAttachment = vi.fn();
    const app = express();
    app.use((req: any, _res, next) => {
      req.context = { tenantId: 'mysc', actorId: 'pm-a', actorRole: 'admin' };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-10T00:00:00.000Z',
      idempotencyService: {},
      projectRequestContractStorageService: { downloadProjectRegistrationAttachment },
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app)
      .get('/api/v1/project-requests/change-project-a/attachments/contract');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
    expect(requestGet).toHaveBeenCalledOnce();
    expect(downloadProjectRegistrationAttachment).not.toHaveBeenCalled();
  });

  it('builds safe lookup keys when only nickname is present', () => {
    expect(resolveProjectTeamMemberLookupKeys({
      memberNickname: '보람',
      memberName: '',
    })).toEqual(['보람']);
  });

  it('formats project type labels for Slack with canonical dropdown labels', () => {
    expect(formatProjectTypeSlackLabel('D1')).toBe('D-1 개발협력사업 - AVPN 포함');
    expect(formatProjectTypeSlackLabel('I3')).toBe('I-3 투자조합운용 - LP수익');
    expect(formatProjectTypeSlackLabel('UNKNOWN')).toBe('D-1 개발협력사업 - AVPN 포함');
  });

  it('reads project request notifications from canonical project_requests before legacy path', async () => {
    const calls: string[] = [];
    const db = {
      doc: vi.fn((path: string) => {
        calls.push(path);
        return {
          get: vi.fn(async () => ({
            exists: path.includes('/project_requests/'),
            data: () => ({ approvedProjectId: 'p001', payload: { name: 'Canonical' } }),
          })),
        };
      }),
    };

    await expect(readProjectRequestById(db, 'mysc', 'pr001')).resolves.toMatchObject({
      id: 'pr001',
      approvedProjectId: 'p001',
      payload: { name: 'Canonical' },
    });
    expect(calls).toEqual(['orgs/mysc/project_requests/pr001']);
  });

  it('falls back to legacy projectRequests path for old project request notifications', async () => {
    const calls: string[] = [];
    const db = {
      doc: vi.fn((path: string) => {
        calls.push(path);
        return {
          get: vi.fn(async () => ({
            exists: path.includes('/projectRequests/'),
            data: () => ({ approvedProjectId: 'p002', payload: { name: 'Legacy' } }),
          })),
        };
      }),
    };

    await expect(readProjectRequestById(db, 'mysc', 'pr002')).resolves.toMatchObject({
      id: 'pr002',
      approvedProjectId: 'p002',
      payload: { name: 'Legacy' },
    });
    expect(calls).toEqual([
      'orgs/mysc/project_requests/pr002',
      'orgs/mysc/projectRequests/pr002',
    ]);
  });

  it('rejects stale explicit project request ids instead of creating a placeholder request', async () => {
    const db = {
      doc: vi.fn((path: string) => ({
        path,
        get: vi.fn(async () => ({ exists: false, data: () => null })),
      })),
    };

    await expect(resolveProjectRequestDocuments({
      db,
      tenantId: 'mysc',
      requestId: 'missing-request',
      projectId: 'p001',
    })).rejects.toMatchObject({
      statusCode: 404,
      code: 'not_found',
    });
    expect(db.doc).toHaveBeenCalledTimes(2);
  });

  it('rejects explicit project request ids that belong to another project', async () => {
    const db = {
      doc: vi.fn((path: string) => ({
        path,
        get: vi.fn(async () => ({
          exists: path.includes('/project_requests/'),
          data: () => ({ approvedProjectId: 'p-other', payload: { name: 'Wrong project' } }),
        })),
      })),
    };

    await expect(resolveProjectRequestDocuments({
      db,
      tenantId: 'mysc',
      requestId: 'pr001',
      projectId: 'p001',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'request_project_mismatch',
    });
  });

  it('rejects an explicit change request whose target project belongs to another project', async () => {
    const db = {
      doc: vi.fn((path: string) => ({
        path,
        get: vi.fn(async () => ({
          exists: path.includes('/project_requests/'),
          data: () => ({ targetProjectId: 'p-other', requestKind: 'CHANGE', payload: { name: 'Wrong target' } }),
        })),
      })),
    };

    await expect(resolveProjectRequestDocuments({
      db,
      tenantId: 'mysc',
      requestId: 'change-pr001',
      projectId: 'p001',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'request_project_mismatch',
    });
  });

  it('rejects an explicit request without any project binding', async () => {
    const db = {
      doc: vi.fn((path: string) => ({
        path,
        get: vi.fn(async () => ({
          exists: path.includes('/project_requests/'),
          data: () => ({ requestKind: 'CHANGE', payload: { name: 'Unbound request' } }),
        })),
      })),
    };

    await expect(resolveProjectRequestDocuments({
      db,
      tenantId: 'mysc',
      requestId: 'unbound-pr001',
      projectId: 'p001',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'request_project_mismatch',
    });
  });

  it('rejects an explicit request when its project bindings disagree', async () => {
    const db = {
      doc: vi.fn((path: string) => ({
        path,
        get: vi.fn(async () => ({
          exists: path.includes('/project_requests/'),
          data: () => ({ approvedProjectId: 'p001', targetProjectId: 'p-other', payload: { name: 'Split binding' } }),
        })),
      })),
    };

    await expect(resolveProjectRequestDocuments({
      db,
      tenantId: 'mysc',
      requestId: 'split-pr001',
      projectId: 'p001',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'request_project_mismatch',
    });
  });

  it('falls back to approvedProjectId lookup without requestedAt ordering for old request docs', async () => {
    const requestRef = { path: 'orgs/mysc/project_requests/pr001' };
    const orderedGet = vi.fn(async () => ({ empty: true, docs: [] }));
    const unorderedGet = vi.fn(async () => ({
      empty: false,
      docs: [{
        id: 'pr001',
        ref: requestRef,
        data: () => ({ approvedProjectId: 'p001', payload: { name: 'Legacy shape' } }),
      }],
    }));
    const query = {
      where: vi.fn(() => query),
      orderBy: vi.fn(() => ({ limit: vi.fn(() => ({ get: orderedGet })) })),
      limit: vi.fn(() => ({ get: unorderedGet })),
    };
    const db = {
      collection: vi.fn(() => query),
      doc: vi.fn((path: string) => ({ path })),
    };

    await expect(resolveProjectRequestDocuments({
      db,
      tenantId: 'mysc',
      requestId: '',
      projectId: 'p001',
    })).resolves.toMatchObject({
      requestId: 'pr001',
      request: { approvedProjectId: 'p001', payload: { name: 'Legacy shape' } },
    });
    expect(orderedGet).toHaveBeenCalledTimes(1);
    expect(unorderedGet).toHaveBeenCalledTimes(1);
  });

  it('writes executive review project and request patches in one transaction', async () => {
    const projectRef = { path: 'orgs/mysc/projects/p001' };
    const requestRef = { path: 'orgs/mysc/project_requests/pr001' };
    const tx = {
      get: vi.fn(async (ref: { path: string }) => ref === projectRef ? ({
        exists: true,
        data: () => ({
          id: 'p001',
          version: 6,
          createdAt: '2026-05-01T00:00:00.000Z',
          createdBy: 'pm-1',
          executiveReviewStatus: 'APPROVED',
        }),
      }) : ({
        exists: true,
        data: () => ({
          requestKind: 'CHANGE', status: 'PENDING', baseProjectVersion: 6, targetProjectVersion: 7,
        }),
      })),
      set: vi.fn(),
    };
    const db = {
      doc: vi.fn(() => projectRef),
      runTransaction: vi.fn(async (handler) => handler(tx)),
    };

    const result = await mergeProjectAndRequestDocs({
      db,
      projectPath: 'orgs/mysc/projects/p001',
      buildProjectPatch: () => ({ executiveReviewStatus: 'APPROVED' }),
      buildRequestPatch: () => ({ status: 'APPROVED', approvedProjectId: 'p001' }),
      requestRefs: [requestRef],
      enforceChangeRequestVersion: true,
      tenantId: 'mysc',
      actorId: 'admin-1',
      now: '2026-05-20T00:00:00.000Z',
      notFoundMessage: 'Project not found: p001',
    });

    expect(db.runTransaction).toHaveBeenCalledTimes(1);
    expect(tx.set).toHaveBeenCalledTimes(2);
    expect(tx.set).toHaveBeenNthCalledWith(1, projectRef, expect.objectContaining({
      executiveReviewStatus: 'APPROVED',
      version: 7,
      updatedBy: 'admin-1',
    }), { merge: true });
    expect(tx.set).toHaveBeenNthCalledWith(2, requestRef, {
      status: 'APPROVED',
      approvedProjectId: 'p001',
    }, { merge: true });
    expect(result).toMatchObject({ version: 7, data: { executiveReviewStatus: 'APPROVED' } });
  });

  it('does not write a project when its transactional participation sync fails', async () => {
    const projectRef = { path: 'orgs/mysc/projects/p001' };
    const tx = {
      get: vi.fn(async () => ({ exists: false, data: () => null })),
      set: vi.fn(),
    };
    const db = {
      doc: vi.fn(() => projectRef),
      runTransaction: vi.fn(async (handler) => handler(tx)),
    };

    await expect(upsertVersionedDoc({
      db,
      path: projectRef.path,
      payload: { id: 'p001', name: '원자 저장 사업' },
      tenantId: 'mysc',
      actorId: 'admin-1',
      now: '2026-08-21T00:00:00.000Z',
      expectedVersion: 0,
      stageTransactionWrites: async () => {
        throw new Error('participation sync failed');
      },
    })).rejects.toThrow('participation sync failed');

    expect(tx.set).not.toHaveBeenCalled();
  });

  it('does not write review decisions when their transactional participation sync fails', async () => {
    const projectRef = { path: 'orgs/mysc/projects/p001' };
    const requestRef = { path: 'orgs/mysc/project_requests/pr001' };
    const tx = {
      get: vi.fn(async (ref) => ({
        exists: true,
        data: () => ref === projectRef
          ? { id: 'p001', version: 6, executiveReviewStatus: 'APPROVED' }
          : { requestKind: 'CHANGE', status: 'PENDING', baseProjectVersion: 6, targetProjectVersion: 7 },
      })),
      set: vi.fn(),
    };
    const db = {
      doc: vi.fn(() => projectRef),
      runTransaction: vi.fn(async (handler) => handler(tx)),
    };

    await expect(mergeProjectAndRequestDocs({
      db,
      projectPath: projectRef.path,
      buildProjectPatch: () => ({ executiveReviewStatus: 'APPROVED' }),
      buildRequestPatch: () => ({ status: 'APPROVED' }),
      requestRefs: [requestRef],
      enforceChangeRequestVersion: true,
      tenantId: 'mysc',
      actorId: 'admin-1',
      now: '2026-08-21T00:00:00.000Z',
      stageTransactionWrites: async () => {
        throw new Error('participation sync failed');
      },
    })).rejects.toThrow('participation sync failed');

    expect(tx.set).not.toHaveBeenCalled();
  });

  it('only lets the designated executive approver approve and records the server-side approver name', async () => {
    const projectRef = { path: 'orgs/mysc/projects/p001' };
    const requestRef = { path: 'orgs/mysc/project_requests/pr001' };
    const project = {
      id: 'p001',
      version: 1,
      executiveApproverId: 'head-a',
      executiveApproverName: '제출자가 입력한 이름',
      executiveReviewStatus: 'PENDING',
    };
    const projectRequest = { targetProjectId: 'p001', approvedProjectId: 'p001', payload: { name: '등록 요청' } };
    const tx = {
      get: vi.fn(async (ref: { path: string }) => ref.path.includes('/projects/')
        ? { exists: true, data: () => project }
        : { exists: true, data: () => projectRequest }),
      set: vi.fn(),
    };
    const db = {
      doc: vi.fn((path: string) => ({
        path,
        get: vi.fn(async () => {
          if (path === projectRef.path) return { exists: true, data: () => project };
          if (path === requestRef.path) return { exists: true, data: () => projectRequest };
          return { exists: false, data: () => null };
        }),
      })),
      runTransaction: vi.fn(async (handler) => handler(tx)),
    };
    const idempotencyService = {
      begin: vi.fn(async () => ({ mode: 'acquired', requestFingerprint: 'fingerprint-a' })),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.context = {
        tenantId: 'mysc',
        actorId: 'head-a',
        actorRole: 'admin',
        actorEmail: 'head-a@example.com',
        actorName: '인증된 조직장 A',
        requestId: 'request-a',
        idempotencyKey: 'executive-review-a',
      };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-14T00:00:00.000Z',
      idempotencyService,
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app).post('/api/v1/projects/p001/executive-review').send({
      requestId: 'pr001',
      reviewStatus: 'APPROVED',
      reviewerName: '조작된 이름',
    });

    expect(response.status).toBe(200);
    expect(tx.set).toHaveBeenNthCalledWith(1, expect.objectContaining(projectRef), expect.objectContaining({
      executiveReviewedById: 'head-a',
      executiveReviewedByName: '인증된 조직장 A',
    }), { merge: true });
    expect(tx.set).toHaveBeenNthCalledWith(2, expect.objectContaining(requestRef), expect.objectContaining({
      reviewedBy: 'head-a',
      reviewedByName: '인증된 조직장 A',
    }), { merge: true });
  });

  it.each([
    {
      label: 'change request with private draft paths',
      requestId: 'change-p001',
      projectRequest: {
        requestKind: 'CHANGE',
        targetProjectId: 'p001',
        approvedProjectId: 'p001',
        requestedBy: 'pm-a',
        status: 'PENDING',
        baseProjectVersion: 3,
        targetProjectVersion: 4,
        payload: {
          executiveApproverId: 'head-a',
          contractDocument: {
            path: 'orgs/mysc/project-registration-drafts/private-change/contract.pdf',
            name: 'contract.pdf',
          },
        },
        proposedSnapshot: {
          executiveApproverId: 'head-a',
          contractDocument: {
            path: 'orgs/mysc/project-registration-drafts/private-change/contract.pdf',
            name: 'contract.pdf',
          },
        },
        submittedOutboxId: 'outbox-change-p001',
      },
    },
    {
      label: 'new registration before canonical attachments are published',
      requestId: 'registration-p001',
      projectRequest: {
        requestKind: 'REGISTRATION',
        targetProjectId: 'p001',
        approvedProjectId: 'p001',
        requestedBy: 'pm-a',
        status: 'PENDING',
        payload: {
          registrationRequirementsVersion: 2,
          executiveApproverId: 'head-a',
          contractDocument: null,
          customerBusinessRegistrationDocument: null,
          quoteDocument: null,
          proposalDocument: null,
        },
        submittedOutboxId: 'outbox-registration-p001',
      },
    },
    {
      label: 'markerless v2 registration missing the required quote',
      requestId: 'registration-p001',
      projectRequest: {
        requestKind: 'REGISTRATION',
        targetProjectId: 'p001',
        approvedProjectId: 'p001',
        requestedBy: 'pm-a',
        status: 'PENDING',
        payload: {
          registrationRequirementsVersion: 2,
          executiveApproverId: 'head-a',
          contractDocument: {
            path: 'orgs/mysc/project-registration-documents/p001/contract.pdf',
            name: 'contract.pdf',
          },
          customerBusinessRegistrationDocument: {
            path: 'orgs/mysc/project-registration-documents/p001/customer.pdf',
            name: 'customer.pdf',
          },
          quoteDocument: null,
          proposalDocument: {
            path: 'orgs/mysc/project-registration-documents/p001/proposal.pdf',
            name: 'proposal.pdf',
          },
          rfpRequestEvidenceDocument: null,
        },
        submittedOutboxId: 'outbox-registration-p001',
      },
    },
  ])('blocks organization-head approval until attachments are published: $label', async ({ requestId, projectRequest }) => {
    const projectRef = { path: 'orgs/mysc/projects/p001' };
    const requestRef = { path: `orgs/mysc/project_requests/${requestId}` };
    const project = {
      id: 'p001',
      version: 3,
      executiveApproverId: 'head-a',
      executiveApproverName: '조직장 A',
      executiveReviewStatus: projectRequest.requestKind === 'CHANGE' ? 'APPROVED' : 'PENDING',
    };
    const tx = {
      get: vi.fn(async (ref: { path: string }) => ref.path.includes('/projects/')
        ? { exists: true, data: () => project }
        : { exists: true, data: () => projectRequest }),
      set: vi.fn(),
    };
    const db = {
      doc: vi.fn((path: string) => ({
        path,
        get: vi.fn(async () => {
          if (path === projectRef.path) return { exists: true, data: () => project };
          if (path === requestRef.path) return { exists: true, data: () => projectRequest };
          return { exists: false, data: () => null };
        }),
      })),
      runTransaction: vi.fn(async (handler) => handler(tx)),
    };
    const idempotencyService = {
      begin: vi.fn(async () => ({ mode: 'acquired', requestFingerprint: 'fingerprint-a' })),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.context = {
        tenantId: 'mysc',
        actorId: 'head-a',
        actorRole: 'pm',
        actorEmail: 'head-a@example.com',
        requestId: 'request-a',
        idempotencyKey: 'executive-review-pending-attachments',
      };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-14T00:00:00.000Z',
      idempotencyService,
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app).post('/api/v1/projects/p001/executive-review').send({
      requestId,
      reviewStatus: 'APPROVED',
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('project_attachments_processing');
    expect(tx.set).not.toHaveBeenCalled();
  });

  it('allows a legacy v2 registration without a publication marker when all seven document slots are canonical or explained', async () => {
    const projectRef = { path: 'orgs/mysc/projects/p001' };
    const requestRef = { path: 'orgs/mysc/project_requests/registration-p001' };
    const canonicalPrefix = 'orgs/mysc/project-registration-documents/p001/';
    const project = {
      id: 'p001',
      version: 3,
      executiveApproverId: 'head-a',
      executiveApproverName: '조직장 A',
      executiveReviewStatus: 'PENDING',
    };
    const projectRequest = {
      requestKind: 'REGISTRATION',
      approvedProjectId: 'p001',
      requestedBy: 'pm-a',
      status: 'PENDING',
      payload: {
        registrationRequirementsVersion: 2,
        executiveApproverId: 'head-a',
        contractDocument: { path: `${canonicalPrefix}contract.pdf`, name: 'contract.pdf' },
        customerBusinessRegistrationDocument: { path: `${canonicalPrefix}customer.pdf`, name: 'customer.pdf' },
        quoteDocument: { path: `${canonicalPrefix}quote.pdf`, name: 'quote.pdf' },
        proposalDocument: { path: `${canonicalPrefix}proposal.pdf`, name: 'proposal.pdf' },
        rfpRequestEvidenceDocument: null,
        registrationOptionalDocumentNotes: {
          proposalWordOriginal: '고객사 미제공',
          proposalPptOriginal: '해당 없음',
          presentationPptOriginal: '해당 없음',
        },
      },
    };
    const tx = {
      get: vi.fn(async (ref: { path: string }) => ref.path.includes('/projects/')
        ? { exists: true, data: () => project }
        : { exists: true, data: () => projectRequest }),
      set: vi.fn(),
    };
    const db = {
      doc: vi.fn((path: string) => ({
        path,
        get: vi.fn(async () => {
          if (path === projectRef.path) return { exists: true, data: () => project };
          if (path === requestRef.path) return { exists: true, data: () => projectRequest };
          return { exists: false, data: () => null };
        }),
      })),
      runTransaction: vi.fn(async (handler) => handler(tx)),
    };
    const idempotencyService = {
      begin: vi.fn(async () => ({ mode: 'acquired', requestFingerprint: 'fingerprint-a' })),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.context = {
        tenantId: 'mysc',
        actorId: 'head-a',
        actorRole: 'pm',
        actorEmail: 'head-a@example.com',
        requestId: 'request-a',
        idempotencyKey: 'executive-review-legacy-canonical',
      };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-14T00:00:00.000Z',
      idempotencyService,
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app).post('/api/v1/projects/p001/executive-review').send({
      requestId: 'registration-p001',
      reviewStatus: 'APPROVED',
    });

    expect(response.status).toBe(200);
    expect(tx.set).toHaveBeenCalledWith(expect.objectContaining(projectRef), expect.objectContaining({
      executiveReviewStatus: 'APPROVED',
    }), { merge: true });
  });

  it('rejects executive approval from anyone except the designated approver', async () => {
    const project = {
      id: 'p001',
      version: 1,
      executiveApproverId: 'head-a',
      executiveApproverName: '조직장 A',
      executiveReviewStatus: 'PENDING',
    };
    const projectRequest = { targetProjectId: 'p001', approvedProjectId: 'p001', payload: { name: '등록 요청' } };
    const tx = {
      get: vi.fn(async (ref: { path: string }) => ref.path.includes('/projects/')
        ? { exists: true, data: () => project }
        : { exists: true, data: () => projectRequest }),
      set: vi.fn(),
    };
    const db = {
      doc: vi.fn((path: string) => ({
        path,
        get: vi.fn(async () => {
          if (path === 'orgs/mysc/projects/p001') return { exists: true, data: () => project };
          if (path === 'orgs/mysc/project_requests/pr001') return { exists: true, data: () => projectRequest };
          return { exists: false, data: () => null };
        }),
      })),
      runTransaction: vi.fn(async (handler) => handler(tx)),
    };
    const idempotencyService = {
      begin: vi.fn(async () => ({ mode: 'acquired', requestFingerprint: 'fingerprint-a' })),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.context = {
        tenantId: 'mysc',
        actorId: 'admin-a',
        actorRole: 'admin',
        actorEmail: 'admin-a@example.com',
        requestId: 'request-a',
        idempotencyKey: 'executive-review-denied',
      };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-14T00:00:00.000Z',
      idempotencyService,
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app).post('/api/v1/projects/p001/executive-review').send({
      requestId: 'pr001',
      reviewStatus: 'APPROVED',
      reviewerName: '관리자',
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('executive_approver_mismatch');
    expect(tx.set).not.toHaveBeenCalled();
    expect(idempotencyService.fail).toHaveBeenCalledTimes(1);
  });

  it('allows executive approval when the requester is stored as the designated approver', async () => {
    const project = {
      id: 'p001',
      version: 1,
      createdBy: 'pm-a',
      registeredById: 'pm-a',
      managerId: 'pm-a',
      executiveApproverId: 'pm-a',
      executiveReviewStatus: 'PENDING',
    };
    const projectRequest = {
      targetProjectId: 'p001',
      approvedProjectId: 'p001',
      requestedBy: 'pm-a',
      payload: {
        name: '셀프 승인 등록 요청',
        registeredById: 'pm-a',
        managerId: 'pm-a',
        executiveApproverId: 'pm-a',
      },
    };
    const tx = {
      get: vi.fn(async (ref: { path: string }) => ref.path.includes('/projects/')
        ? { exists: true, data: () => project }
        : { exists: true, data: () => projectRequest }),
      set: vi.fn(),
    };
    const db = {
      doc: vi.fn((path: string) => ({
        path,
        get: vi.fn(async () => {
          if (path === 'orgs/mysc/projects/p001') return { exists: true, data: () => project };
          if (path === 'orgs/mysc/project_requests/pr001') return { exists: true, data: () => projectRequest };
          return { exists: false, data: () => null };
        }),
      })),
      runTransaction: vi.fn(async (handler) => handler(tx)),
    };
    const idempotencyService = {
      begin: vi.fn(async () => ({ mode: 'acquired', requestFingerprint: 'fingerprint-a' })),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.context = {
        tenantId: 'mysc',
        actorId: 'pm-a',
        actorRole: 'pm',
        actorEmail: 'pm-a@example.com',
        actorName: 'PM A',
        requestId: 'request-a',
        idempotencyKey: 'executive-review-pm-self',
      };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-14T00:00:00.000Z',
      idempotencyService,
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app).post('/api/v1/projects/p001/executive-review').send({
      requestId: 'pr001',
      reviewStatus: 'APPROVED',
    });

    expect(response.status).toBe(200);
    expect(tx.set).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      executiveReviewStatus: 'APPROVED',
      executiveReviewedById: 'pm-a',
      executiveReviewedByName: 'PM A',
    }), { merge: true });
  });

  it('allows a designated viewer approver without introducing a separate member role', async () => {
    const projectRef = { path: 'orgs/mysc/projects/p001' };
    const requestRef = { path: 'orgs/mysc/project_requests/pr001' };
    const project = {
      id: 'p001',
      version: 1,
      registeredById: 'pm-a',
      managerId: 'pm-a',
      executiveApproverId: 'head-a',
      executiveApproverName: '조직장 A',
      executiveReviewStatus: 'PENDING',
    };
    const projectRequest = {
      targetProjectId: 'p001',
      approvedProjectId: 'p001',
      requestedBy: 'pm-a',
      payload: {
        name: '등록 요청',
        registeredById: 'pm-a',
        managerId: 'pm-a',
        executiveApproverId: 'head-a',
      },
    };
    const tx = {
      get: vi.fn(async (ref: { path: string }) => ref.path.includes('/projects/')
        ? { exists: true, data: () => project }
        : { exists: true, data: () => projectRequest }),
      set: vi.fn(),
    };
    const db = {
      doc: vi.fn((path: string) => ({
        path,
        get: vi.fn(async () => {
          if (path === projectRef.path) return { exists: true, data: () => project };
          if (path === requestRef.path) return { exists: true, data: () => projectRequest };
          return { exists: false, data: () => null };
        }),
      })),
      runTransaction: vi.fn(async (handler) => handler(tx)),
    };
    const idempotencyService = {
      begin: vi.fn(async () => ({ mode: 'acquired', requestFingerprint: 'fingerprint-a' })),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.context = {
        tenantId: 'mysc',
        actorId: 'head-a',
        actorRole: 'viewer',
        actorEmail: 'head-a@example.com',
        actorName: '조직장 A',
        requestId: 'request-a',
        idempotencyKey: 'executive-review-designated-viewer',
      };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-14T00:00:00.000Z',
      idempotencyService,
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app).post('/api/v1/projects/p001/executive-review').send({
      requestId: 'pr001',
      reviewStatus: 'APPROVED',
    });

    expect(response.status).toBe(200);
    expect(tx.set).toHaveBeenNthCalledWith(1, expect.objectContaining(projectRef), expect.objectContaining({
      executiveReviewStatus: 'APPROVED',
      executiveReviewedById: 'head-a',
      executiveReviewedByName: '조직장 A',
    }), { merge: true });
  });

  it('keeps legacy pending projects reviewable when no designated approver is stored', async () => {
    const projectRef = { path: 'orgs/mysc/projects/p001' };
    const requestRef = { path: 'orgs/mysc/project_requests/pr001' };
    const project = {
      id: 'p001',
      version: 1,
      executiveReviewStatus: 'PENDING',
    };
    const projectRequest = { targetProjectId: 'p001', approvedProjectId: 'p001', payload: { name: '레거시 등록 요청' } };
    const tx = {
      get: vi.fn(async (ref: { path: string }) => ref.path.includes('/projects/')
        ? { exists: true, data: () => project }
        : { exists: true, data: () => projectRequest }),
      set: vi.fn(),
    };
    const db = {
      doc: vi.fn((path: string) => ({
        path,
        get: vi.fn(async () => {
          if (path === projectRef.path) return { exists: true, data: () => project };
          if (path === requestRef.path) return { exists: true, data: () => projectRequest };
          return { exists: false, data: () => null };
        }),
      })),
      runTransaction: vi.fn(async (handler) => handler(tx)),
    };
    const idempotencyService = {
      begin: vi.fn(async () => ({ mode: 'acquired', requestFingerprint: 'fingerprint-a' })),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.context = {
        tenantId: 'mysc',
        actorId: 'admin-a',
        actorRole: 'admin',
        actorEmail: 'admin-a@example.com',
        requestId: 'request-a',
        idempotencyKey: 'executive-review-legacy',
      };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-14T00:00:00.000Z',
      idempotencyService,
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app).post('/api/v1/projects/p001/executive-review').send({
      requestId: 'pr001',
      reviewStatus: 'APPROVED',
      reviewerName: '조작된 이름',
    });

    expect(response.status).toBe(200);
    expect(tx.set).toHaveBeenNthCalledWith(1, expect.objectContaining(projectRef), expect.objectContaining({
      executiveReviewedById: 'admin-a',
      executiveReviewedByName: 'admin-a@example.com',
    }), { merge: true });
    expect(tx.set).toHaveBeenNthCalledWith(2, expect.objectContaining(requestRef), expect.objectContaining({
      reviewedBy: 'admin-a',
      reviewedByName: 'admin-a@example.com',
    }), { merge: true });
  });

  it('rejects a stale change request inside the executive approval transaction', async () => {
    const projectRef = { path: 'orgs/mysc/projects/p001' };
    const requestRef = { path: 'orgs/mysc/project_requests/change-p001' };
    const tx = {
      get: vi.fn(async (ref: { path: string }) => ref.path.includes('/projects/')
        ? { exists: true, data: () => ({ id: 'p001', version: 7 }) }
        : {
            exists: true,
            data: () => ({
              id: 'change-p001', requestKind: 'CHANGE', status: 'PENDING',
              baseProjectVersion: 6, targetProjectVersion: 7,
            }),
          }),
      set: vi.fn(),
    };
    const db = {
      doc: vi.fn(() => projectRef),
      runTransaction: vi.fn(async (handler) => handler(tx)),
    };

    await expect(mergeProjectAndRequestDocs({
      db,
      projectPath: projectRef.path,
      buildProjectPatch: () => ({ executiveReviewStatus: 'APPROVED' }),
      buildRequestPatch: () => ({ status: 'APPROVED' }),
      requestRefs: [requestRef],
      enforceChangeRequestVersion: true,
      tenantId: 'mysc',
      actorId: 'admin-1',
      now: '2026-07-12T00:00:00.000Z',
    })).rejects.toMatchObject({ statusCode: 409, code: 'canonical_version_conflict' });
    expect(tx.get).toHaveBeenCalledWith(requestRef);
    expect(tx.set).not.toHaveBeenCalled();
  });

  it('rejects a change request without writing the project', async () => {
    const projectRef = { path: 'orgs/mysc/projects/p001' };
    const requestRef = { path: 'orgs/mysc/project_requests/change-p001' };
    const tx = {
      get: vi.fn(async (ref: { path: string }) => ref.path.includes('/projects/')
        ? { exists: true, data: () => ({ id: 'p001', version: 6, name: 'Original' }) }
        : {
            exists: true,
            data: () => ({
              id: 'change-p001', requestKind: 'CHANGE', status: 'PENDING',
              baseProjectVersion: 6, targetProjectVersion: 7,
            }),
          }),
      set: vi.fn(),
    };
    const db = {
      doc: vi.fn(() => projectRef),
      runTransaction: vi.fn(async (handler) => handler(tx)),
    };

    const result = await mergeProjectAndRequestDocs({
      db,
      projectPath: projectRef.path,
      buildProjectPatch: () => ({ executiveReviewStatus: 'REVISION_REJECTED' }),
      buildRequestPatch: () => ({ status: 'REJECTED' }),
      requestRefs: [requestRef],
      enforceChangeRequestVersion: true,
      writeProject: false,
      tenantId: 'mysc',
      actorId: 'admin-1',
      now: '2026-07-12T00:00:00.000Z',
    });

    expect(result).toMatchObject({ version: 6, data: { version: 6, name: 'Original' } });
    expect(tx.set).toHaveBeenCalledTimes(1);
    expect(tx.set).toHaveBeenCalledWith(requestRef, { status: 'REJECTED' }, { merge: true });
    expect(tx.set).not.toHaveBeenCalledWith(projectRef, expect.anything(), expect.anything());
  });

  it('fails closed when duplicate request collections both exist during approval', async () => {
    const projectRef = { path: 'orgs/mysc/projects/p001' };
    const requestRefs = [
      { path: 'orgs/mysc/project_requests/change-p001' },
      { path: 'orgs/mysc/projectRequests/change-p001' },
    ];
    const tx = {
      get: vi.fn(async (ref: { path: string }) => ref.path.includes('/projects/')
        ? { exists: true, data: () => ({ id: 'p001', version: 4 }) }
        : {
            exists: true,
            data: () => ({
              id: 'change-p001', requestKind: 'CHANGE', status: 'PENDING',
              baseProjectVersion: 3, targetProjectVersion: 4,
            }),
          }),
      set: vi.fn(),
    };
    const db = {
      doc: vi.fn(() => projectRef),
      runTransaction: vi.fn(async (handler) => handler(tx)),
    };

    await expect(mergeProjectAndRequestDocs({
      db,
      projectPath: projectRef.path,
      buildProjectPatch: () => ({ executiveReviewStatus: 'APPROVED' }),
      buildRequestPatch: () => ({ status: 'APPROVED' }),
      requestRefs,
      enforceChangeRequestVersion: true,
      tenantId: 'mysc',
      actorId: 'admin-1',
      now: '2026-07-12T00:00:00.000Z',
    })).rejects.toMatchObject({ statusCode: 409, code: 'request_collection_conflict' });
    expect(tx.set).not.toHaveBeenCalled();
  });

  it('builds safe lookup keys when only name is present', () => {
    expect(resolveProjectTeamMemberLookupKeys({
      memberNickname: '',
      memberName: '변민욱',
    })).toEqual(['변민욱']);
  });

  it('does not fail project save flow when managed Drive root rename throws', async () => {
    const logger = { error: vi.fn() };
    const driveService = {
      renameManagedProjectRootFolder: vi.fn(async () => {
        throw new Error('drive unavailable');
      }),
    };

    await expect(tryRenameManagedProjectRootFolder({
      driveService,
      projectId: 'p001',
      projectName: 'Updated Name',
      existingFolderId: 'folder-001',
      logger,
    })).resolves.toBeNull();

    expect(driveService.renameManagedProjectRootFolder).toHaveBeenCalledWith({
      projectId: 'p001',
      projectName: 'Updated Name',
      existingFolderId: 'folder-001',
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('does not fail project save flow when managed Drive root provision throws', async () => {
    const logger = { error: vi.fn() };
    const driveService = {
      ensureProjectRootFolder: vi.fn(async () => {
        throw new Error('drive unavailable');
      }),
    };

    await expect(tryEnsureProjectRootFolder({
      driveService,
      tenantId: 'mysc',
      projectId: 'p001',
      projectName: 'Created Project',
      existingFolderId: '',
      logger,
    })).resolves.toBeNull();

    expect(driveService.ensureProjectRootFolder).toHaveBeenCalledWith({
      tenantId: 'mysc',
      projectId: 'p001',
      projectName: 'Created Project',
      existingFolderId: '',
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('returns only project requests assigned to the authenticated active reviewer', async () => {
    const collectionRows = {
      projects: [
        { id: 'project-a', executiveApproverId: 'head-a' },
        { id: 'project-change', executiveApproverId: 'head-a' },
        { id: 'project-legacy', executiveApproverId: 'head-a' },
        { id: 'project-processing', executiveApproverId: 'head-a' },
        { id: 'project-payload-only', executiveApproverId: 'head-b', name: '요청 기준 배정 프로젝트' },
        { id: 'project-other', executiveApproverId: 'head-b' },
      ],
      project_requests: [
        {
          id: 'request-assigned',
          approvedProjectId: 'project-a',
          requestedAt: '2026-07-20T02:00:00.000Z',
          payload: { executiveApproverId: 'head-a', contractAmount: 100_000 },
        },
        {
          id: 'request-processing',
          requestKind: 'REGISTRATION',
          approvedProjectId: 'project-processing',
          requestedAt: '2026-07-20T04:30:00.000Z',
          status: 'PENDING',
          payload: { executiveApproverId: 'head-a', registrationRequirementsVersion: 2 },
        },
        {
          id: 'request-change-assigned',
          requestKind: 'CHANGE',
          targetProjectId: 'project-change',
          requestedAt: '2026-07-20T04:00:00.000Z',
          payload: { executiveApproverId: 'head-b', contractAmount: 500_000 },
          proposedSnapshot: { executiveApproverId: 'head-a', contractAmount: 200_000 },
        },
        {
          id: 'request-other',
          approvedProjectId: 'project-other',
          requestedAt: '2026-07-20T03:00:00.000Z',
          payload: { executiveApproverId: 'head-b', contractAmount: 999_000 },
        },
        {
          id: 'request-payload-only',
          targetProjectId: 'project-payload-only',
          requestedAt: '2026-07-20T03:30:00.000Z',
          payload: { executiveApproverId: 'head-a', contractAmount: 300_000 },
        },
        {
          id: 'request-shadowed',
          approvedProjectId: 'project-other',
          requestedAt: '2026-07-20T05:00:00.000Z',
          payload: { executiveApproverId: 'head-b', contractAmount: 777_000 },
        },
      ],
      projectRequests: [
        {
          id: 'request-legacy-assigned',
          approvedProjectId: 'project-legacy',
          requestedAt: '2026-07-20T01:00:00.000Z',
          payload: { name: '기존 요청' },
        },
        {
          id: 'request-shadowed',
          approvedProjectId: 'project-a',
          requestedAt: '2026-07-20T06:00:00.000Z',
          payload: { executiveApproverId: 'head-a', contractAmount: 666_000 },
        },
      ],
    };
    const readField = (row: Record<string, any>, field: string) => field
      .split('.')
      .reduce((value: any, key) => value?.[key], row);
    const queryCalls: Array<{ path: string; clauses: Array<[string, string, unknown]> }> = [];
    const requestQueryLimits: number[] = [];
    const makeQuery = (path: string, clauses: Array<[string, string, unknown]> = []): any => ({
      where: (field: string, operator: string, value: unknown) => makeQuery(path, [...clauses, [field, operator, value]]),
      limit: (value: number) => {
        requestQueryLimits.push(value);
        return makeQuery(path, clauses);
      },
      get: vi.fn(async () => {
        queryCalls.push({ path, clauses });
        if (!clauses.length) throw new Error(`unbounded collection read: ${path}`);
        const collectionName = path.split('/').at(-1) as keyof typeof collectionRows;
        const rows = collectionRows[collectionName] || [];
        const matches = rows.filter((row) => clauses.every(([field, operator, value]) => {
          const actual = readField(row, field);
          if (operator === '==') return actual === value;
          if (operator === 'in') return Array.isArray(value) && value.includes(actual);
          return false;
        }));
        return { docs: matches.map((row) => ({ id: row.id, data: () => row })) };
      }),
    });
    const db = {
      collection: vi.fn((path: string) => makeQuery(path)),
      doc: vi.fn((path: string) => ({
        get: vi.fn(async () => {
          if (path === 'orgs/mysc/members/head-a') {
            return { exists: true, data: () => ({ uid: 'head-a', role: 'pm', status: 'ACTIVE' }) };
          }
          const [collectionName, id] = path.split('/').slice(-2) as [keyof typeof collectionRows, string];
          const row = collectionRows[collectionName]?.find((item) => item.id === id);
          if (row) {
            return { exists: true, id, data: () => row };
          }
          return { exists: false, data: () => null };
        }),
      })),
    };
    const app = express();
    app.use((req: any, _res, next) => {
      req.context = { tenantId: 'mysc', actorId: 'head-a', actorRole: 'pm' };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-20T00:00:00.000Z',
      idempotencyService: {},
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app).get('/api/v1/project-requests/assigned-to-me');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([
      'request-change-assigned',
      'request-payload-only',
      'request-assigned',
      'request-legacy-assigned',
    ]);
    expect(JSON.stringify(response.body)).not.toContain('request-other');
    expect(JSON.stringify(response.body)).not.toContain('999000');
    expect(JSON.stringify(response.body)).not.toContain('666000');
    expect(response.body.projects.map((project: { id: string }) => project.id)).toEqual([
      'project-a',
      'project-change',
      'project-legacy',
      'project-payload-only',
      'project-processing',
    ]);
    expect(queryCalls).not.toContainEqual(expect.objectContaining({ clauses: [] }));
    expect(requestQueryLimits.length).toBeGreaterThan(0);
    expect(new Set(requestQueryLimits)).toEqual(new Set([500]));
  });

  it('serves latest, pending-summary, and review-inbox views without client Firestore access', async () => {
    const collectionRows = {
      project_requests: [
        {
          id: 'change-pending',
          requestKind: 'CHANGE',
          targetProjectId: 'project-a',
          approvedProjectId: 'project-a',
          status: 'PENDING',
          requestedAt: '2026-07-20T01:00:00.000Z',
          targetProjectVersion: 4,
          payload: {
            contractAmount: 999_000,
            contractDocument: {
              path: 'orgs/mysc/project-registration-documents/project-a/submitted-contract.pdf',
            },
          },
          proposedSnapshot: {
            contractAmount: 999_000,
            contractDocument: {
              path: 'orgs/mysc/project-registration-documents/project-a/submitted-contract.pdf',
            },
          },
        },
        {
          id: 'registration-latest',
          requestKind: 'REGISTRATION',
          targetProjectId: 'project-a',
          approvedProjectId: 'project-a',
          status: 'APPROVED',
          requestedAt: '2026-07-20T02:00:00.000Z',
          payload: { name: '프로젝트 A' },
        },
        {
          id: 'registration-processing',
          requestKind: 'REGISTRATION',
          targetProjectId: 'project-a',
          approvedProjectId: 'project-a',
          status: 'PENDING',
          requestedAt: '2026-07-20T00:30:00.000Z',
          payload: { name: '게시 중 프로젝트', registrationRequirementsVersion: 2 },
        },
        {
          id: 'shadowed-cross-project',
          requestKind: 'CHANGE',
          targetProjectId: 'project-b',
          approvedProjectId: 'project-b',
          status: 'PENDING',
          requestedAt: '2026-07-20T04:00:00.000Z',
          payload: { contractAmount: 555_000 },
        },
      ],
      projectRequests: [
        {
          id: 'legacy-other',
          requestKind: 'CHANGE',
          approvedProjectId: 'project-b',
          status: 'PENDING',
          requestedAt: '2026-07-20T03:00:00.000Z',
          payload: { contractAmount: 777_000 },
        },
        {
          id: 'shadowed-cross-project',
          requestKind: 'CHANGE',
          targetProjectId: 'project-a',
          approvedProjectId: 'project-a',
          status: 'PENDING',
          requestedAt: '2026-07-20T04:00:00.000Z',
          payload: { contractAmount: 444_000 },
        },
      ],
    };
    const queryCalls: Array<{ path: string; field: string; operator: string; value: unknown }> = [];
    const requestQueryLimits: number[] = [];
    const readField = (row: Record<string, any>, field: string) => field
      .split('.')
      .reduce((value: any, key) => value?.[key], row);
    const db = {
      collection: vi.fn((path: string) => ({
        where: (field: string, operator: string, value: unknown) => ({
          limit: (queryLimit: number) => ({ get: vi.fn(async () => {
            requestQueryLimits.push(queryLimit);
            queryCalls.push({ path, field, operator, value });
            const rows = path.endsWith('/project_requests')
              ? collectionRows.project_requests
              : collectionRows.projectRequests;
            const matches = rows.filter((row) => {
              const actual = readField(row, field);
              if (operator === '==') return actual === value;
              if (operator === 'in') return Array.isArray(value) && value.includes(actual);
              return false;
            });
            return { docs: matches.map((row) => ({ id: row.id, data: () => row })) };
          }) }),
        }),
      })),
      doc: vi.fn((path: string) => ({
        get: vi.fn(async () => {
          if (path === 'orgs/mysc/members/finance-a') {
            return { exists: true, data: () => ({ uid: 'finance-a', role: 'finance', status: 'ACTIVE' }) };
          }
          if (path === 'orgs/mysc/projects/project-a') {
            return { exists: true, data: () => ({ id: 'project-a', managerId: 'pm-a' }) };
          }
          const id = path.split('/').at(-1);
          const canonical = collectionRows.project_requests.find((row) => row.id === id);
          return canonical
            ? { exists: true, id, data: () => canonical }
            : { exists: false, data: () => null };
        }),
      })),
    };
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.context = { tenantId: 'mysc', actorId: 'finance-a', actorRole: 'finance' };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-20T00:00:00.000Z',
      idempotencyService: {},
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const pending = await request(app)
      .post('/api/v1/project-requests/pending-changes')
      .send({ projectIds: ['project-a'] });
    const oversizedPending = await request(app)
      .post('/api/v1/project-requests/pending-changes')
      .send({ projectIds: Array.from({ length: 201 }, (_, index) => `project-${index}`) });
    const inbox = await request(app).post('/api/v1/project-requests/review-inbox').send({ projectIds: ['project-a'] });
    const latest = await request(app).get('/api/v1/projects/project-a/latest-request');

    expect(pending.status).toBe(200);
    expect(oversizedPending.status).toBe(400);
    expect(oversizedPending.body.error).toBe('project_request_query_invalid');
    expect(pending.body.items).toEqual([expect.objectContaining({ id: 'change-pending' })]);
    expect(JSON.stringify(pending.body)).not.toContain('999000');
    expect(JSON.stringify(pending.body)).not.toContain('777000');
    expect(JSON.stringify(pending.body)).not.toContain('shadowed-cross-project');
    expect(inbox.status).toBe(200);
    expect(inbox.body.items.map((item: { id: string }) => item.id)).toEqual(['registration-latest', 'change-pending']);
    expect(JSON.stringify(inbox.body)).not.toContain('shadowed-cross-project');
    expect(latest.status).toBe(200);
    expect(latest.body.item).toEqual(expect.objectContaining({ id: 'registration-latest' }));
    expect(queryCalls.every((call) => call.field && call.operator)).toBe(true);
    expect(new Set(requestQueryLimits)).toEqual(new Set([500]));
  });

  it('denies pending change summaries for project IDs outside an ACTIVE PM assignment', async () => {
    const db = {
      collection: vi.fn((path: string) => ({
        where: (_field: string, _operator: string, _value: unknown) => ({
          limit: (_queryLimit: number) => ({
            get: vi.fn(async () => ({
              docs: path.endsWith('/project_requests')
                ? [{
                    id: 'change-project-a',
                    data: () => ({
                      requestKind: 'CHANGE',
                      targetProjectId: 'project-a',
                      status: 'PENDING',
                      requestedAt: '2026-07-20T01:00:00.000Z',
                    }),
                  }]
                : [],
            })),
          }),
        }),
      })),
      doc: vi.fn((path: string) => ({
        get: vi.fn(async () => {
          if (path === 'orgs/mysc/members/pm-a') {
            return {
              exists: true,
              data: () => ({ uid: 'pm-a', role: 'pm', status: 'ACTIVE', projectIds: ['project-b'] }),
            };
          }
          if (path === 'orgs/mysc/projects/project-a') {
            return { exists: true, data: () => ({ managerId: 'pm-b', executiveApproverId: 'head-a' }) };
          }
          return { exists: false, data: () => null };
        }),
      })),
    };
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.context = { tenantId: 'mysc', actorId: 'pm-a', actorRole: 'pm' };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-20T00:00:00.000Z',
      idempotencyService: {},
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app)
      .post('/api/v1/project-requests/pending-changes')
      .send({ projectIds: ['project-a'] });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
    expect(db.collection).not.toHaveBeenCalled();
  });

  it('chunks legacy request fallback queries within the Firestore in-query limit', async () => {
    const inQuerySizes: number[] = [];
    const db = {
      collection: vi.fn((path: string) => ({
        where: (field: string, operator: string, value: unknown) => ({
          get: vi.fn(async () => {
            if (operator === 'in') inQuerySizes.push(Array.isArray(value) ? value.length : 0);
            if (path.endsWith('/projects') && field === 'executiveApproverId') {
              return {
                docs: Array.from({ length: 31 }, (_, index) => ({
                  id: `project-${String(index + 1).padStart(2, '0')}`,
                  data: () => ({ executiveApproverId: 'head-a' }),
                })),
              };
            }
            return { docs: [] };
          }),
          limit: (_queryLimit: number) => ({
            get: vi.fn(async () => {
              if (operator === 'in') inQuerySizes.push(Array.isArray(value) ? value.length : 0);
              return { docs: [] };
            }),
          }),
        }),
      })),
      doc: vi.fn((path: string) => ({
        get: vi.fn(async () => path === 'orgs/mysc/members/head-a'
          ? { exists: true, data: () => ({ uid: 'head-a', role: 'pm', status: 'ACTIVE' }) }
          : { exists: false, data: () => null }),
      })),
    };
    const app = express();
    app.use((req: any, _res, next) => {
      req.context = { tenantId: 'mysc', actorId: 'head-a', actorRole: 'pm' };
      next();
    });
    mountProjectRoutes(app, {
      db,
      now: () => '2026-07-20T00:00:00.000Z',
      idempotencyService: {},
    } as any);
    app.use((error: any, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ error: error.code || 'internal_error' });
    });

    const response = await request(app).get('/api/v1/project-requests/assigned-to-me');

    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([]);
    expect(inQuerySizes).toContain(30);
    expect(inQuerySizes).toContain(1);
    expect(Math.max(...inQuerySizes)).toBe(30);
  });
});
