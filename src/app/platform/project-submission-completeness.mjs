import { hasMultiYearProjectContract, projectContractEndYear, projectPaymentIssues } from './project-input-policy.mjs';

const text = (value) => typeof value === 'string' && value.trim().length > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const amount = (value) => Number.isSafeInteger(value) && value >= 0;
const moneyLabels = { contractAmount: '계약금액', salesVatAmount: '매출 부가세', totalRevenueAmount: '수익', totalActualCost: '실비(원가)', supportAmount: '지원금' };
const paymentLabels = { contract: '선금/계약금', interim: '중도금', final: '잔금' };
const systemCodes = ['E_NARA_DOUM', 'IRIS', 'RCMS', 'EZBARO', 'E_HIJO', 'EDUFINE', 'HAPPYEUM', 'AGRIX', 'BOTAEM_E', 'SMTECH', 'KOCCA_PMS', 'NIPA', 'ACCOUNTANT', 'PRIVATE', 'OTHER', 'NONE'];
export const PROJECT_REQUIRED_STAFFING_FIELDS = ['staffing.lead', 'staffing.pm', 'staffing.operators'];
const date = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};
const driveUrl = (value, folder = false) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && ['drive.google.com', 'docs.google.com'].includes(url.hostname)
      && (!folder || /\/folders\/[^/]+/.test(url.pathname));
  } catch { return false; }
};

export function projectSubmissionCompletenessIssues(input) {
  const payload = object(input) ? input : {};
  const issues = [];
  const add = (field, label, step, message = `${label}을(를) 입력해 주세요. 해당하지 않으면 해당 없음으로 명시해 주세요.`) => issues.push({ field, label, step, message });
  const absent = (field) => payload.submissionResponses?.[field] === 'NOT_APPLICABLE';
  const requiredText = (field, label, step, canBeAbsent = false) => {
    if (canBeAbsent && text(payload[field]) && absent(field)) add(field, label, step, `${label} 입력 내용과 해당 없음 선택이 함께 있습니다. 입력을 유지하려면 해당 없음 선택을 해제해 주세요.`);
    if (!text(payload[field]) && !(canBeAbsent && absent(field))) add(field, label, step);
  };
  for (const [field, label] of Object.entries({ name: '프로젝트명', officialContractName: '공식 계약명', clientOrg: '계약 대상', projectPurpose: '프로젝트 목적', description: '주요 내용', department: '담당조직' })) requiredText(field, label, 'basic');
  requiredText('businessManagementGoogleFolderLink', '사업관리 구글폴더링크', 'basic', true);
  if (text(payload.businessManagementGoogleFolderLink) && !driveUrl(payload.businessManagementGoogleFolderLink, true)) add('businessManagementGoogleFolderLink', '사업관리 구글폴더링크', 'basic', 'Google Drive 폴더 링크를 입력해 주세요. 폴더가 없으면 해당 없음을 선택해 주세요.');
  requiredText('paymentPlanDesc', '기타 메모', 'financial', true);
  const enumValue = (field, label, step, values) => {
    if (!values.includes(payload[field])) add(field, label, step, `${label}에서 유효한 값을 선택해 주세요.`);
  };
  enumValue('type', '프로젝트 유형', 'basic', ['C1', 'A1', 'A2', 'I1', 'I2', 'I3', 'D1', 'S1', 'S2', 'E1', 'P1', 'Z1']);
  enumValue('currency', '통화', 'financial', ['KRW', 'USD']);
  requiredText('contractType', '계약서 유형', 'financial');
  enumValue('settlementType', '사업유형', 'financial', ['TYPE1', 'TYPE2', 'TYPE3', 'TYPE4', 'TYPE5']);
  enumValue('basis', '정산 기준', 'financial', ['SUPPLY_AMOUNT', '공급가액', 'SUPPLY_PRICE', '공급대가', 'NONE']);
  if (payload.basis !== 'NONE') {
    enumValue('accountType', '통장 유형', 'financial', ['DEDICATED', 'OPERATING', 'NONE', 'OTHER']);
    enumValue('settlementSystem', '정산 시스템', 'financial', systemCodes);
    enumValue('laborSettlementBasis', '인건비 정산 기준', 'financial', ['INCLUDE_ACTUAL_SALARY', 'EXCLUDE_ACTUAL_SALARY', 'FIXED_AMOUNT', 'NONE']);
    enumValue('interestRefundPolicy', '이자 반납 여부', 'financial', ['REFUND', 'USE_AS_PROJECT_EXPENSE', 'MYSC_REVENUE', 'REVIEW_LATER']);
    if (payload.settlementSystem === 'OTHER') requiredText('settlementSystemOther', '기타 정산 시스템명', 'financial');
  }
  if (!date(payload.contractStart)) add('contractStart', '계약 시작일', 'financial', '실제 날짜로 계약 시작일을 입력해 주세요.');
  if (payload.contractEndUndecided !== true && (!date(payload.contractEnd) || payload.contractEnd < payload.contractStart)) add('contractEnd', '계약 종료일', 'financial', '계약 시작일 이후 종료일을 입력하거나 종료 기간 없음을 선택해 주세요.');
  if (payload.contractEndUndecided === true && text(payload.contractEnd)) add('contractEnd', '계약 종료일', 'financial', '종료 기간 없음을 선택한 경우 종료일을 비워 주세요.');

  const financial = (source, prefix, label, flags) => {
    for (const [field, name] of Object.entries(moneyLabels)) {
      if (!amount(source?.[field]) || flags?.[field] !== true) add(`${prefix}${field}`, `${label}${name}`, 'financial', `${label}${name}을(를) 직접 입력해 주세요. 금액이 없으면 0원을 입력합니다. 빈칸은 0원으로 인정하지 않습니다.`);
    }
    if (Object.keys(moneyLabels).every((field) => amount(source?.[field])) && source.contractAmount !== source.salesVatAmount + source.totalRevenueAmount + source.totalActualCost + source.supportAmount) add(`${prefix}contractAmount`, `${label}계약금액`, 'financial', `${label}계약금액과 매출 부가세·수익·실비(원가)·지원금 합계가 다릅니다. 계약서와 대조하여 금액을 확인해 주세요.`);
  };
  financial(payload, '', '총 ', payload.financialInputFlags);
  const rows = Array.isArray(payload.financialYears) ? payload.financialYears : [];
  const startYear = Number(String(payload.contractStart || '').slice(0, 4));
  const endYear = projectContractEndYear(payload);
  if (!rows.length) add('financialYears', '연도별 계약/재무', 'financial', '계약기간에 해당하는 연도별 금액을 입력해 주세요. 단년도도 금액별 입력이 필요합니다.');
  const years = new Set();
  for (const row of rows) {
    if (!object(row)) { add('financialYears', '연도별 계약/재무', 'financial', '연도별 금액 행의 형식이 올바르지 않습니다.'); continue; }
    if (!Number.isSafeInteger(row.year) || row.year < startYear || row.year > endYear || years.has(row.year)) add('financialYears', '연도별 계약/재무', 'financial', '계약기간의 각 연도는 한 번씩만 입력해 주세요.');
    years.add(row.year);
    financial(row, `financialYears.${row.year}.`, `${row.year}년 `, row.inputFlags);
  }
  if (Number.isSafeInteger(startYear) && Number.isSafeInteger(endYear) && endYear >= startYear && endYear - startYear <= 20) {
    for (let year = startYear; year <= endYear; year += 1) if (!years.has(year)) add(`financialYears.${year}`, `${year}년 계약/재무`, 'financial', `${year}년 금액이 누락되었습니다. 해당 연도 금액이 없으면 각 항목에 0원을 입력해 주세요.`);
  }
  if (rows.length && rows.every(object)) for (const [field, name] of Object.entries(moneyLabels)) {
    if (amount(payload[field]) && rows.every((row) => amount(row[field])) && rows.reduce((sum, row) => sum + row[field], 0) !== payload[field]) add(field, `총 ${name}`, 'financial', `${name}의 연도별 합계와 전체 금액이 다릅니다. 연도별 금액을 확인해 주세요.`);
  }
  const annual = hasMultiYearProjectContract(payload);
  for (const source of annual ? rows.filter(object) : [payload]) {
    const prefix = annual ? `financialYears.${source.year}.` : '';
    const label = annual ? `${source.year}년 ` : '';
    for (const [field, name] of Object.entries(paymentLabels)) if (!amount(source.paymentPlan?.[field]) || source.paymentPlanInputFlags?.[field] !== true) add(`${prefix}paymentPlan.${field}`, `${label}${name}`, 'financial', `${label}${name} 금액을 입력해 주세요. 입금 계획이 없으면 0원을 입력합니다.`);
    if (Object.keys(paymentLabels).every((field) => amount(source.paymentPlan?.[field])) && amount(source.contractAmount) && Object.keys(paymentLabels).reduce((sum, field) => sum + source.paymentPlan[field], 0) !== source.contractAmount) add(`${prefix}paymentPlan`, `${label}입금 계획 합계`, 'financial', `${label}입금 계획의 합계가 계약금액과 다릅니다. 선금·중도금·잔금을 확인해 주세요.`);
  }
  issues.push(...projectPaymentIssues(payload));

  const confirmations = payload.registrationConfirmations || {};
  for (const [field, label] of Object.entries({ laborIncludesFourInsurance: '인건비 4대보험 포함 여부', laborIncludesRetirementPay: '인건비 퇴직금 포함 여부', customerSettlementBasisConfirmed: '고객사 정산 기준 확인', modusignContractUsed: '모두싸인 사용 여부' })) {
    if (typeof confirmations[field] !== 'boolean') add(`registrationConfirmations.${field}`, label, 'financial', `${label}에 예 또는 아니오를 선택해 주세요.`);
  }
  if (confirmations.modusignContractUsed === false && confirmations.originalContractSubmitted !== true) add('registrationConfirmations.originalContractSubmitted', '계약서 원본 제출', 'financial', '모두싸인을 사용하지 않는 경우 계약서 원본을 제출하고 확인해 주세요.');
  const attached = (field) => object(payload[field]) && text(payload[field].path);
  for (const [field, label] of [['contractDocument', '계약서'], ['customerBusinessRegistrationDocument', '고객사 사업자등록증'], ['quoteDocument', '산출내역서(견적서)']]) {
    if (!(field === 'quoteDocument' && payload.quoteSubmissionDeferred === true) && !attached(field)) add(field, label, 'financial', `${label} 파일을 첨부해 주세요.${field === 'quoteDocument' ? ' 아직 제출할 수 없으면 이후 제출을 선택해 주세요.' : ''}`);
  }
  const notes = payload.registrationOptionalDocumentNotes || {};
  for (const [key, field, label, link] of [
    ['proposalWordOriginal', 'proposalWordOriginalDocument', '제안서 원본', ''],
    ['proposalPptOriginal', 'proposalPptOriginalDocument', '제안서 구글드라이브 링크', confirmations.proposalPptOriginal],
    ['presentationPptOriginal', 'presentationPptOriginalDocument', '발표자료 구글드라이브 링크', confirmations.presentationPptOriginal],
    ['rfpRequestEvidence', 'rfpRequestEvidenceDocument', 'RFP/요청 메일 증빙', ''],
  ]) {
    if ((attached(field) || text(link)) && notes[key] === '해당 없음') add(field, label, 'financial', `${label} 제출 내용과 해당 없음 선택이 함께 있습니다. 파일·링크를 유지하려면 해당 없음 선택을 해제해 주세요.`);
    if (text(link) && !driveUrl(link)) add(`registrationConfirmations.${key}`, label, 'financial', `${label}에 Google Drive 또는 Google Docs 링크를 입력해 주세요.`);
    if (!attached(field) && !text(link) && !text(notes[key])) add(field, label, 'financial', `${label}을(를) 제출하거나 해당 없음과 미제출 사유를 명시해 주세요.`);
  }

  if (!(text(payload.registeredById) || text(payload.managerId)) || !(text(payload.registeredByName) || text(payload.managerName))) add('registeredById', '최종 보고자(실무책임자)', 'team', '구성원 원장에서 최종 보고자를 선택해 주세요.');
  if (!text(payload.executiveApproverId) || !text(payload.executiveApproverName)) add('executiveApproverId', '최종 결재자(총괄책임자)', 'team', '구성원 원장에서 최종 결재자를 선택해 주세요.');
  const staffing = payload.staffing || {};
  const person = (slot) => object(slot) && text(slot.personId) && text(slot.name);
  for (const [key, hasValue, label] of [
    ['lead', object(staffing.lead) && text(staffing.lead.personId), '실제 투입 총괄책임자'],
    ['pm', object(staffing.pm) && text(staffing.pm.personId), '실제 투입 실무책임자'],
    ['operators', Array.isArray(staffing.operators) && staffing.operators.length > 0, '실제 투입 운영매니저'],
    ['others', Array.isArray(staffing.others) && staffing.others.length > 0, '기타 인력'],
    ['settlementSupport', text(staffing.settlementSupport), '정산지원'],
  ]) if (hasValue && absent(`staffing.${key}`)) add(`staffing.${key}`, label, 'team', `${label} 입력 내용과 해당 없음 선택이 함께 있습니다. 입력을 유지하려면 해당 없음 선택을 해제해 주세요.`);
  for (const [key, label] of [['lead', '실제 투입 총괄책임자'], ['pm', '실제 투입 실무책임자']]) if (!person(staffing[key])) add(`staffing.${key}`, label, 'team', `${label}는 필수 항목입니다. 담당자를 선택해 주세요.`);
  if (!(Array.isArray(staffing.operators) && staffing.operators.length > 0 && staffing.operators.every(person))) add('staffing.operators', '실제 투입 운영매니저', 'team', '운영매니저는 1명 이상 필수입니다. 담당자를 선택해 주세요.');
  if (!text(staffing.settlementSupport) && !absent('staffing.settlementSupport')) add('staffing.settlementSupport', '정산지원', 'team');
  const others = Array.isArray(staffing.others) ? staffing.others : [];
  if (!others.length && !absent('staffing.others')) add('staffing.others', '기타 인력', 'team');
  others.forEach((entry, index) => {
    if (!text(entry?.role)) add(`staffing.others.${index}.role`, `기타 인력 ${index + 1} 역할`, 'team');
    if (!person(entry?.slot)) add(`staffing.others.${index}.slot`, `기타 인력 ${index + 1} 담당자`, 'team');
  });
  return issues;
}
