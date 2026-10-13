// EMA Station 의 Firebase 콜러블 함수를 로그인한 구성원 본인의 ID 토큰으로 부른다.
// 권한 판단(관리자·컨설턴트·직원, 관리자 전용 기능)은 함수가 하고, 이 서비스에는 권한 코드가 없다.
export class EmaError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const FRIENDLY = {
  UNAUTHENTICATED: 'EMA Station 로그인이 만료됐습니다. AI 앱에서 연결을 다시 해 주세요.',
  PERMISSION_DENIED: '이 계정에는 이 작업의 권한이 없습니다.',
  RESOURCE_EXHAUSTED: '결과가 너무 커서 한 번에 처리할 수 없습니다. 조건을 좁혀 다시 시도하세요.',
};

export function createEmaClient({ functionsBase, idToken, fetchImpl = fetch, timeoutMs = 150_000 }) {
  async function call(name, data = {}) {
    if (!/^[A-Za-z][A-Za-z0-9]{2,60}$/u.test(name)) throw new Error('ema_function_invalid');
    const response = await fetchImpl(`${functionsBase}/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ data: { ...data, via: 'mcp' } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.error) {
      const error = body?.error || {};
      const code = String(error.status || 'UNKNOWN');
      throw new EmaError(response.status, code, error.message || FRIENDLY[code] || `EMA Station 요청 실패(HTTP ${response.status})`);
    }
    return body?.result;
  }
  return { call };
}
