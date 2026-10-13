// Google 로그인 → Firebase 세션. MYSCube 앱의 Google 로그인과 같은 Firebase 사용자로 들어가므로
// BFF 는 이 요청을 앱에서 온 요청과 구분하지 않는다.
const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const FIREBASE_SIGN_IN = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp';
const FIREBASE_REFRESH = 'https://securetoken.googleapis.com/v1/token';

export class IdentityError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function googleAuthorizeUrl({ clientId, redirectUri, state, codeChallenge, hostedDomain }) {
  const url = new URL(GOOGLE_AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile',
    state, code_challenge: codeChallenge, code_challenge_method: 'S256', hd: hostedDomain, prompt: 'select_account',
  }).toString();
  return url.toString();
}

export async function s256(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJwtPayload(token) {
  const part = String(token).split('.')[1] || '';
  const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (char) => char.charCodeAt(0))));
}

// id_token 은 Google 토큰 엔드포인트에서 TLS 로 직접 받은 값이라 서명 검증 없이 클레임을 읽는다(OIDC Core 3.1.3.7).
export async function exchangeGoogleCode({ code, verifier, clientId, clientSecret, redirectUri, hostedDomain, fetchImpl = fetch }) {
  const response = await fetchImpl(GOOGLE_TOKEN, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, code_verifier: verifier, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.id_token) throw new IdentityError('google_exchange_failed', 'Google 로그인을 완료하지 못했습니다. 다시 시도해 주세요.');
  const claims = decodeJwtPayload(body.id_token);
  if (claims.aud !== clientId || claims.email_verified !== true || claims.hd !== hostedDomain) {
    throw new IdentityError('google_account_not_allowed', `회사 Google 계정(@${hostedDomain})으로 로그인해 주세요.`);
  }
  return { idToken: body.id_token, email: String(claims.email).toLowerCase() };
}

export async function signInFirebase({ googleIdToken, apiKey, requestUri, fetchImpl = fetch }) {
  const response = await fetchImpl(`${FIREBASE_SIGN_IN}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ postBody: `id_token=${encodeURIComponent(googleIdToken)}&providerId=google.com`,
      requestUri, returnSecureToken: true, returnIdpCredential: false }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.idToken || !body.refreshToken) throw new IdentityError('firebase_sign_in_failed', 'MYSCube 로그인을 완료하지 못했습니다.');
  return { uid: body.localId, idToken: body.idToken, refreshToken: body.refreshToken, expiresIn: Number(body.expiresIn) || 3600 };
}

const REVOKED = new Set(['TOKEN_EXPIRED', 'USER_DISABLED', 'USER_NOT_FOUND', 'INVALID_REFRESH_TOKEN', 'INVALID_GRANT_TYPE', 'MISSING_REFRESH_TOKEN']);

export async function refreshFirebase({ refreshToken, apiKey, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(`${FIREBASE_REFRESH}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new IdentityError('firebase_unavailable', 'MYSCube 로그인 서버에 연결하지 못했습니다.');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = String(body?.error?.message || '').split(' ')[0];
    throw new IdentityError(REVOKED.has(reason) ? 'firebase_revoked' : 'firebase_unavailable', '로그인이 만료됐습니다. 다시 연결해 주세요.');
  }
  return { idToken: body.id_token, refreshToken: body.refresh_token, expiresIn: Number(body.expires_in) || 3600 };
}
