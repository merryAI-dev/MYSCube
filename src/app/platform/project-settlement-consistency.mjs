const text = (value) => typeof value === 'string' ? value.trim() : '';
const settlementTypes = new Set(['TYPE1', 'TYPE2', 'TYPE3', 'TYPE4', 'TYPE5']);
const basisLabels = {
  SUPPLY_AMOUNT: '공급가액', 공급가액: '공급가액',
  SUPPLY_PRICE: '공급대가', 공급대가: '공급대가',
  OTHER: '기타', 기타: '기타',
};

export function projectSettlementConsistencyIssue(payload = {}, fallback = {}) {
  const version = Object.hasOwn(payload, 'registrationRequirementsVersion')
    ? payload.registrationRequirementsVersion : fallback.registrationRequirementsVersion;
  if (version === 2) return null;
  const type = text(payload.settlementType);
  const basis = basisLabels[text(payload.basis)];
  if (!basis || settlementTypes.has(type)) return null;
  const typeLabel = type === 'NONE' ? '정산 없음' : type ? `확인되지 않은 값(${type})` : '기록 없음';
  return {
    code: 'project_settlement_basis_conflict', severity: 'blocking', field: 'basis',
    title: '정산 유형과 정산 기준을 확인해 주세요',
    detail: `이 문서에는 정산 유형은 ‘${typeLabel}’, 정산 기준은 ‘${basis}’로 선택되어 있습니다. 두 항목이 서로 맞지 않아 어떤 내용이 맞는지 확인이 필요합니다.`,
    action: '작성자: 프로젝트 수정의 계약/재무 > 정산에서 두 항목을 확인한 뒤 최종 제출해 주세요.\n조직장: 수정된 문서가 제출되면 내용을 확인하고 승인해 주세요. 작성 중인 내용은 임시저장할 수 있습니다.',
  };
}
