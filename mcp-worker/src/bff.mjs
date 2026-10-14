// MYSCube BFF 를 로그인한 구성원 본인의 Firebase ID 토큰으로 부른다. BFF 는 앱 화면과 똑같이
// 토큰을 검증하고 구성원·역할·프로젝트 범위를 확인하므로, 이 서비스에는 권한 판단 코드가 없다.
const USER_AGENT = 'myscube-mcp-worker/1.0';
// 응답 본문 상한. 헤더(content-length)를 믿지 않고 읽는 동안 센다. 호출마다 maxBytes 로 낮출 수 있다.
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
// GET 만 재시도한다. POST 조회는 지금처럼 한 번만 부른다.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 5_000;

export class BffError extends Error {
  constructor(status, body, { retryable = false } = {}) {
    super(body?.message || body?.error || `MYSCube 조회 실패(HTTP ${status})`);
    this.status = status;
    this.code = body?.code || body?.error || null;
    this.retryable = retryable;
  }
}

async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new BffError(response.status, { code: 'response_too_large', message: 'MYSCube 응답이 너무 커서 읽지 않았습니다.' });
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BffError(response.status, { code: 'response_too_large', message: 'MYSCube 응답이 너무 커서 읽지 않았습니다.' });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function retryDelayMs(response, attempt, random) {
  const retryAfter = response?.headers.get('retry-after');
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  // 지수 백오프와 지터: 300ms, 600ms 기준에 0~50%를 더한다.
  const base = 300 * 2 ** attempt;
  return Math.round(base + base * 0.5 * random());
}

export function createBffClient({
  baseUrl, idToken, fetchImpl = fetch, timeoutMs = 25_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = Math.random, now = () => Date.now(),
}) {
  async function request(method, path, { query, body, maxBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
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
    // 재시도를 포함한 전체 시간이 timeoutMs 를 넘지 않는다.
    const deadline = now() + timeoutMs;
    for (let attempt = 0; ; attempt += 1) {
      const remaining = deadline - now();
      if (remaining <= 0) throw new BffError(504, { code: 'timeout', message: 'MYSCube 응답이 늦어 중단했습니다.' }, { retryable: true });
      let response;
      try {
        response = await fetchImpl(url, {
          method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(remaining),
        });
      } catch (error) {
        const canRetry = method === 'GET' && attempt < MAX_RETRIES;
        if (canRetry) { await sleep(Math.min(retryDelayMs(null, attempt, random), Math.max(0, deadline - now()))); continue; }
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw new BffError(504, { code: 'timeout', message: 'MYSCube 응답이 늦어 중단했습니다.' }, { retryable: true });
        }
        throw new BffError(502, { code: 'network_error', message: 'MYSCube 에 연결하지 못했습니다.' }, { retryable: true });
      }
      if (method === 'GET' && RETRY_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
        const wait = retryDelayMs(response, attempt, random);
        // 재시도할 때만 본문을 버린다. 시간이 모자라 재시도하지 않으면 아래에서 오류 본문을 읽어 돌려준다.
        if (now() + wait < deadline) {
          await response.body?.cancel().catch(() => {});
          await sleep(wait);
          continue;
        }
      }
      let text;
      try {
        text = await readCapped(response, maxBytes);
      } catch (error) {
        // 본문을 읽는 중에도 같은 시간 한도가 적용된다. 시간 초과·연결 끊김을 공통 오류로 바꾼다(코드 리뷰 #3).
        if (error instanceof BffError) throw error;
        // 오류 응답(403 등)의 본문을 읽다 끊겼으면 원래 상태 코드를 유지한다(2차 리뷰 #9).
        if (!response.ok) throw new BffError(response.status, null, { retryable: RETRY_STATUSES.has(response.status) });
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw new BffError(504, { code: 'timeout', message: 'MYSCube 응답이 늦어 중단했습니다.' }, { retryable: true });
        }
        throw new BffError(502, { code: 'network_error', message: 'MYSCube 응답을 끝까지 받지 못했습니다.' }, { retryable: true });
      }
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { message: text.slice(0, 300) }; }
      if (!response.ok) throw new BffError(response.status, parsed, { retryable: RETRY_STATUSES.has(response.status) });
      return parsed;
    }
  }
  return {
    get: (path, query, options) => request('GET', path, { query, ...options }),
    post: (path, body, options) => request('POST', path, { body, ...options }),
  };
}
