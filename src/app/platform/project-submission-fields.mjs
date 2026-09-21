// Field ownership is shared by submission snapshots and approval projection.
export const PROJECT_SUBMISSION_FIELDS = [
  'name', 'officialContractName', 'type', 'status', 'phase', 'description', 'clientOrg', 'businessManagementGoogleFolderLink',
  'participationSheetLink',
  'department', 'groupwareName', 'currency', 'contractAmount', 'salesVatAmount',
  'totalRevenueAmount', 'totalActualCost', 'supportAmount', 'financialInputFlags', 'registrationRequirementsVersion',
  'financialYears', 'registrationConfirmations', 'registrationOptionalDocumentNotes', 'checkout', 'contractStart', 'contractEnd', 'contractEndUndecided',
  'contractType', 'settlementType', 'basis', 'accountType', 'settlementSystem', 'settlementSystemOther',
  'laborSettlementBasis', 'laborTransferPlan', 'fundInputMode', 'settlementSheetPolicy', 'paymentPlan',
  'paymentExpectedMonths', 'finalPaymentExpectedWeek', 'interestRefundPolicy', 'quoteSubmissionDeferred',
  'advanceInterimBelow70Reason', 'paymentPlanDesc', 'settlementGuide',
  'finalPaymentNote', 'projectPurpose', 'registeredById', 'registeredByName',
  'registeredByEmail', 'executiveApproverId', 'executiveApproverName', 'executiveApproverEmail',
  'managerId', 'managerName', 'teamName', 'teamMembers',
  'teamMembersDetailed', 'staffing', 'participantCondition', 'note', 'contractDocument',
  'customerBusinessRegistrationDocument', 'quoteDocument', 'proposalDocument',
  'proposalWordOriginalDocument', 'proposalPptOriginalDocument',
  'presentationPptOriginalDocument', 'rfpRequestEvidenceDocument',
  'performanceCertificateDocument', 'taxInvoiceDocument', 'finalSettlementReportDocument',
  'finalReportDocument',
  'contractAnalysis',
];

export const PROJECT_SUBMISSION_CLEAR_VALUES = Object.freeze({
  contractEndUndecided: false,
  quoteSubmissionDeferred: false,
  businessManagementGoogleFolderLink: '',
  settlementSystemOther: '',
});

export function projectSubmissionOwnedPatch(payload, normalized) {
  const patch = {};
  for (const field of PROJECT_SUBMISSION_FIELDS) {
    if (Object.hasOwn(payload, field) && normalized[field] !== undefined) patch[field] = normalized[field];
  }
  if (Object.hasOwn(payload, 'department') && normalized.cic !== undefined) patch.cic = normalized.cic;
  for (const [source, alias] of [['registeredById', 'managerId'], ['registeredByName', 'managerName'], ['managerId', 'registeredById'], ['managerName', 'registeredByName']]) {
    if (Object.hasOwn(payload, source) && normalized[alias] !== undefined) patch[alias] = normalized[alias];
  }
  return patch;
}

export function assertProjectSubmissionFields(payload) {
  const unknown = Object.keys(payload).filter((key) => !PROJECT_SUBMISSION_FIELDS.includes(key));
  if (unknown.length) throw new Error(`Unknown project submission fields: ${unknown.join(', ')}`);
  return payload;
}
