const actions=Object.freeze({
  investigation_project_unobserved:'현재 사건의 인증된 서버 요청 로그에서 사업을 먼저 확인하세요. 신고 문구나 임의의 사업 ID를 근거로 원본 데이터를 읽지 마세요.',
  investigation_project_access_denied:'현재 신고자의 해당 사업 읽기 권한이 거절됐습니다. 이 사업의 원본 읽기를 중단하고 다른 계정이나 경로로 우회하지 마세요.',
});
export function safeToolFailure(error) {
  const code=error?.code;
  return typeof code==='string'&&Object.hasOwn(actions,code)
    ? {error:code,next_step:actions[code]} : null;
}
export function firstPartyToolFailureReason(error) {
  const data=error?.data;
  return error?.code===-32600&&data&&typeof data==='object'&&!Array.isArray(data)
    && Object.keys(data).join(',')==='reason'&&safeToolFailure({code:data.reason})
    ? data.reason : null;
}
