import { escape, page } from './files.mjs';

// 컨설턴트가 직접 동의한 Google 계정으로 Meet 회의록(캘린더 첨부 문서, Gmail)을 읽는다.
// 읽기 전용 권한만 요청하고, 갱신 토큰은 AES-GCM 으로 암호화해 계정(uid)별로 보관한다.
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const STATE_TTL_SECONDS = 10 * 60;

export const GOOGLE_SOURCE_SCOPES = Object.freeze({
  calendar: ['https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/drive.readonly'],
  gmail: ['https://www.googleapis.com/auth/gmail.readonly'],
});

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
const b64url = (bytes) => b64(bytes).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

async function aesKey(keyBase64) {
  const raw = unb64(keyBase64);
  if (raw.length !== 32) throw new Error('GOOGLE_TOKEN_KEY 는 32바이트(base64)여야 합니다.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptText(keyBase64, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyBase64), new TextEncoder().encode(plaintext));
  return `${b64(iv)}.${b64(cipher)}`;
}

export async function decryptText(keyBase64, payload) {
  const [iv, cipher] = String(payload).split('.');
  if (!iv || !cipher) throw new Error('저장된 Google 연결 정보를 읽을 수 없습니다.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(keyBase64), unb64(cipher));
  return new TextDecoder().decode(plain);
}

export class GoogleNotConnectedError extends Error {}

export function createGoogleService({ kv, env, fetchImpl = fetch, now = () => Date.now() }) {
  const configured = () => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_TOKEN_KEY);
  const redirectUri = () => `${env.PUBLIC_ORIGIN}/google/callback`;
  const connKey = (uid) => `ema:google:conn:${uid}`;

  async function formPost(url, body) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, json };
  }

  return {
    configured,

    async beginConnect(uid, sources, email = '') {
      if (!configured()) throw new Error('Google 연결이 아직 설정되지 않았습니다. 관리자에게 문의해 주세요.');
      const picked = [...new Set(sources)].filter((source) => GOOGLE_SOURCE_SCOPES[source]);
      if (!picked.length) throw new Error('연결할 소스(calendar 또는 gmail)를 고르세요.');
      const token = randomToken(24);
      const verifier = randomToken(48);
      await kv.put(`ema:google:state:${token}`, JSON.stringify({ uid, sources: picked, verifier, email }), { expirationTtl: STATE_TTL_SECONDS });
      return { token, expiresInMinutes: STATE_TTL_SECONDS / 60, sources: picked };
    },

    async readState(token) {
      const raw = await kv.get(`ema:google:state:${token}`);
      return raw ? JSON.parse(raw) : null;
    },

    async authorizeUrl(token) {
      const state = await this.readState(token);
      if (!state) return null;
      const { sources, verifier } = state;
      const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri(),
        response_type: 'code',
        scope: sources.flatMap((source) => GOOGLE_SOURCE_SCOPES[source]).join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'false',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: token,
      });
      return `${AUTH_URL}?${params}`;
    },

    async finishConnect({ code, state }) {
      const raw = await kv.get(`ema:google:state:${state}`);
      if (!raw) throw new Error('연결 요청이 만료됐습니다. AI 대화에서 Google 연결을 다시 요청해 주세요.');
      await kv.delete(`ema:google:state:${state}`);
      const { uid, sources, verifier } = JSON.parse(raw);
      const result = await formPost(TOKEN_URL, {
        code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(), grant_type: 'authorization_code', code_verifier: verifier,
      });
      if (!result.ok || !result.json.refresh_token) throw new Error('Google 연결을 완료하지 못했습니다. 다시 시도해 주세요.');
      const granted = String(result.json.scope || '').split(' ').filter(Boolean);
      const usable = sources.filter((source) => GOOGLE_SOURCE_SCOPES[source].every((scope) => granted.includes(scope)));
      if (!usable.length) throw new Error('필요한 권한이 허용되지 않았습니다. 요청한 권한을 모두 허용해 주세요.');
      const payload = await encryptText(env.GOOGLE_TOKEN_KEY, JSON.stringify({ refreshToken: result.json.refresh_token, sources: usable }));
      await kv.put(connKey(uid), JSON.stringify({ payload, connectedAt: new Date(now()).toISOString(), sources: usable }));
      return { uid, sources: usable };
    },

    async status(uid) {
      const raw = await kv.get(connKey(uid));
      if (!raw) return { connected: false, configured: configured(), sources: [] };
      const { connectedAt, sources } = JSON.parse(raw);
      return { connected: true, configured: configured(), sources, connectedAt };
    },

    async accessToken(uid, source) {
      const raw = await kv.get(connKey(uid));
      if (!raw) throw new GoogleNotConnectedError('Google 계정이 연결돼 있지 않습니다. ema_google_connect 로 연결해 주세요.');
      const conn = JSON.parse(raw);
      if (source && !conn.sources.includes(source)) throw new GoogleNotConnectedError(`${source} 권한이 연결돼 있지 않습니다. ema_google_connect 로 해당 소스를 연결해 주세요.`);
      const { refreshToken } = JSON.parse(await decryptText(env.GOOGLE_TOKEN_KEY, conn.payload));
      const result = await formPost(TOKEN_URL, {
        refresh_token: refreshToken, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token',
      });
      if (!result.ok || !result.json.access_token) {
        if (result.json.error === 'invalid_grant') {
          await kv.delete(connKey(uid));
          throw new GoogleNotConnectedError('Google 연결이 만료됐거나 해제됐습니다. ema_google_connect 로 다시 연결해 주세요.');
        }
        throw new Error('Google 로그인 서버에 잠시 연결할 수 없습니다.');
      }
      return result.json.access_token;
    },

    async disconnect(uid) {
      const raw = await kv.get(connKey(uid));
      if (!raw) return { disconnected: false };
      try {
        const { refreshToken } = JSON.parse(await decryptText(env.GOOGLE_TOKEN_KEY, JSON.parse(raw).payload));
        await formPost(REVOKE_URL, { token: refreshToken });
      } catch { /* 해제 요청이 실패해도 우리 쪽 보관본은 지운다 */ }
      await kv.delete(connKey(uid));
      return { disconnected: true };
    },

    // 읽기 전용 GET. 권한이 모자라면 읽을 수 있는 말로 바꿔 돌려준다.
    async getJson(uid, source, url) {
      const token = await this.accessToken(uid, source);
      const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
      if (response.status === 403 || response.status === 401) throw new GoogleNotConnectedError('Google 권한이 부족합니다. ema_google_connect 로 다시 연결해 주세요.');
      if (!response.ok) throw new Error(`Google 요청 실패(HTTP ${response.status})`);
      return response;
    },
  };
}

const STATE_COOKIE = '__Host-ema-google-state';

// 연결 링크를 다른 사람에게 건네 그 사람의 Google 계정을 내 계정에 붙이는 공격을 막기 위해,
// 어느 EMA 계정용 연결인지 보여 주고 확인 버튼을 눌러야 Google 로 넘어간다.
export async function handleGoogleStart(request, google, token) {
  const state = await google.readState(token);
  if (!state) return page('Google 연결', '<h1>링크가 만료됐습니다</h1><p>AI 대화에서 Google 연결을 다시 요청해 주세요.</p>', 410);
  if (request.method === 'GET') {
    const labels = { calendar: 'Meet 일정에 첨부된 회의록(캘린더·Drive 읽기)', gmail: 'Gmail 회의록 메일(Gmail 읽기)' };
    return page('Google 연결', `<h1>Google 계정을 연결할까요?</h1>
<p>EMA Station 계정 <strong>${escape(state.email || '(이메일 없음)')}</strong> 에 연결합니다.</p>
<ul>${state.sources.map((source) => `<li>${escape(labels[source])}</li>`).join('')}</ul>
<p><strong>본인 EMA 계정이 맞을 때만</strong> 계속하세요. 읽기 전용이며 언제든 해제할 수 있습니다.</p>
<form method="post"><p><button type="submit">계속 (Google 로그인)</button></p></form>`);
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
  const url = await google.authorizeUrl(token);
  return new Response(null, {
    status: 302,
    headers: {
      location: url,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'set-cookie': `${STATE_COOKIE}=${token}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

export async function handleGoogleCallback(request, google) {
  const params = new URL(request.url).searchParams;
  if (params.get('error')) return page('Google 연결', '<h1>연결을 취소했습니다</h1><p>필요하면 AI 대화에서 다시 요청해 주세요.</p>', 400);
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return page('Google 연결', '<h1>연결 정보가 올바르지 않습니다</h1>', 400);
  const cookie = (request.headers.get('cookie') || '').split(/;\s*/u).find((part) => part.startsWith(`${STATE_COOKIE}=`));
  if (!cookie || cookie.slice(STATE_COOKIE.length + 1) !== state) {
    return page('Google 연결', '<h1>연결을 시작한 브라우저가 아닙니다</h1><p>AI 대화에서 Google 연결을 다시 요청하고, 같은 브라우저에서 진행해 주세요.</p>', 400);
  }
  try {
    const { sources } = await google.finishConnect({ code, state });
    const labels = { calendar: 'Meet 일정에 첨부된 회의록', gmail: 'Gmail 회의록 메일' };
    return page('Google 연결', `<h1>Google 연결을 마쳤습니다</h1><p>읽기 전용으로 연결됐습니다: ${sources.map((source) => escape(labels[source])).join(', ')}</p><p>이제 AI 대화로 돌아가 "회의록 가져와줘"라고 말해 주세요. 연결은 AI 대화에서 언제든 해제할 수 있습니다.</p>`);
  } catch (error) {
    return page('Google 연결', `<h1>연결하지 못했습니다</h1><p>${escape(error instanceof Error ? error.message : '다시 시도해 주세요.')}</p>`, 400);
  }
}
