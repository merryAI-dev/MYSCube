// Synthetic test data only. Never use this helper when accepting a real submission.
export function completeProjectSubmissionFixture(overrides = {}) {
  const financial = { contractAmount: 100, salesVatAmount: 0, totalRevenueAmount: 20, totalActualCost: 80, supportAmount: 0 };
  const flags = Object.fromEntries(Object.keys(financial).map((key) => [key, true]));
  const paymentPlan = { contract: 100, interim: 0, final: 0 };
  const paymentPlanInputFlags = { contract: true, interim: true, final: true };
  return {
    name: '필수 정책 검증 사업', officialContractName: '필수 정책 검증 계약', clientOrg: '검증 고객사', projectPurpose: '검증 목적', description: '검증 내용', department: 'CIC1', type: 'C1', currency: 'KRW',
    contractType: '계약서(날인)', settlementType: 'TYPE1', basis: 'NONE', contractStart: '2026-01-01', contractEnd: '2026-12-31', contractEndUndecided: false,
    registrationRequirementsVersion: 2, participationSheetLink: 'https://docs.google.com/spreadsheets/d/completeness-test/edit',
    registeredById: 'person-pm', registeredByName: '검증 실무자', executiveApproverId: 'person-lead', executiveApproverName: '검증 조직장',
    ...financial, financialInputFlags: flags, financialYears: [{ year: 2026, ...financial, inputFlags: flags, profitRate: 0.2, confirmed: false }],
    paymentPlan, paymentPlanInputFlags, paymentExpectedMonths: { contract: '2026-01' },
    submissionResponses: Object.fromEntries(['businessManagementGoogleFolderLink', 'paymentPlanDesc', 'staffing.others', 'staffing.settlementSupport'].map((key) => [key, 'NOT_APPLICABLE'])),
    registrationConfirmations: { laborIncludesFourInsurance: false, laborIncludesRetirementPay: false, customerSettlementBasisConfirmed: false, modusignContractUsed: true },
    registrationOptionalDocumentNotes: { proposalWordOriginal: '해당 없음', proposalPptOriginal: '해당 없음', presentationPptOriginal: '해당 없음', rfpRequestEvidence: '해당 없음' },
    contractDocument: { path: 'test/contract.pdf' }, customerBusinessRegistrationDocument: { path: 'test/business.pdf' }, quoteDocument: { path: 'test/quote.pdf' },
    teamMembersDetailed: [], staffing: {
      lead: { personId: 'person-lead', name: '검증 조직장' },
      pm: { personId: 'person-pm', name: '검증 실무자' },
      operators: [{ personId: 'person-operator', name: '검증 운영매니저' }],
      others: [], settlementSupport: '',
    },
    ...overrides,
  };
}
