const names = {
  settlement_report: '정산 보고서', settlement_status_report: '정산 상태', cashflow_status: '정산 상세',
  accounting_read: '원장', accounting_report: '금액 보고서', accounting_compare: '기간 비교',
  cfo_brief: 'CFO 브리핑', reformat_report: '보고서 재구성', project_search: '사업 검색',
  agent_diagnostics: '실행 기록', system_knowledge: '시스템 근거', clarify_request: '요청 범위 확인',
};
export function toolFailureMessage({ tool, stage, category }) {
  const name = names[tool] || '요청';
  if (stage === 'input') return `${name}: 호출 입력을 확인하지 못해 실행하지 않았습니다.`;
  if (stage === 'authorization' || category === 'AUTHORIZATION') return `${name}: 조회 권한을 확인하지 못했습니다.`;
  if (stage === 'policy') return `${name}: 조회 범위 확인 처리를 완료하지 못했습니다.`;
  if (stage === 'execute') return `${name}: 자료 조회·처리를 완료하지 못했습니다. 해당 호출의 결과는 확인되지 않았습니다.`;
  if (stage === 'render') return `${name}: 조회 결과를 답변으로 구성하지 못했습니다.`;
  return `${name}: 실행 기록 처리를 완료하지 못했습니다.`;
}
export function renderToolFailures(failures) {
  return failures.length ? `[처리 안내]\n${[...new Set(failures.map(toolFailureMessage))].join('\n')}\n성공한 호출과 실패한 호출은 별개입니다. 결과가 표시된 경우 해당 결과의 조회 범위·미확인 표시를 기준으로 확인해주세요.` : '';
}
export const modelContinuationFailure = '추가 답변 처리를 완료하지 못했습니다. 위 조회 결과는 유지되며, 추가 요청 사항의 처리 여부는 확인되지 않았습니다.';
