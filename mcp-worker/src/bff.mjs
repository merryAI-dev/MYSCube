// MYSCube BFF 를 로그인한 구성원 본인의 Firebase ID 토큰으로 부른다. BFF 는 앱 화면과 똑같이
// 토큰을 검증하고 구성원·역할·프로젝트 범위를 확인하므로, 이 서비스에는 권한 판단 코드가 없다.
const USER_AGENT = 'myscube-mcp-worker/1.0';

export class BffError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `MYSCube 조회 실패(HTTP ${status})`);
    this.status = status;
    this.code = body?.code || body?.error || null;
  }
}

export function createBffClient({ baseUrl, idToken, fetchImpl = fetch, timeoutMs = 25_000 }) {
  async function request(method, path, { query, body } = {}) {
    if (!path.startsWith('/api/v1/')) throw new Error('bff_path_invalid');
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const headers = { authorization: `Bearer ${idToken}`, accept: 'application/json', 'user-agent': USER_AGENT };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers['idempotency-key'] = crypto.randomUUID();
    }
    const response = await fetchImpl(url, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { message: text.slice(0, 300) }; }
    if (!response.ok) throw new BffError(response.status, parsed);
    return parsed;
  }
  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
  };
}
