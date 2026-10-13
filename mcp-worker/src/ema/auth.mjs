import { AuthorizationError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { createEmaClient, EmaError } from './client.mjs';

// 로그인은 EMA Station 사이트에서만 한다. 이 서비스는 비밀번호를 받지 않고, 로그인한 구성원의
// Firebase 로그인 증명(ID 토큰·갱신 토큰)만 받는다. 연결 확인 화면은 EMA 사이트의 /mcp/authorize 다.
export const SCOPES = Object.freeze(['ema:registry']);

const escape = (value) => String(value).replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);

function page(title, body, headers = new Headers(), status = 200) {
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1f2937}
button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:1px solid #cbd5e1;background:#fff;cursor:pointer}
button[value=approve]{background:#0f172a;color:#fff;border-color:#0f172a}.muted{color:#64748b;font-size:13px}</style>
${body}</html>`, { status, headers });
}

function consentPage(details, handle) {
  return `<h1>${escape(details.clientName)}에서 EMA Station을 조회하도록 허용할까요?</h1>
<p>이 앱이 EMA Station의 <strong>스타트업 등록(FRN) 데이터</strong>를 내 권한으로 조회합니다. 관리자 계정은 엑셀 내려받기와 일괄 등록도 할 수 있지만, 등록은 미리보기를 확인한 뒤에만 실행되고 삭제는 할 수 없습니다.</p>
<p class="muted">접근 권한이 전달되는 곳: <strong>${escape(details.redirectHost)}</strong>${details.clientDomain ? ` · 게시: ${escape(details.clientDomain)}` : ' · 이 앱이 스스로 등록한 이름입니다.'}</p>
${details.redirectIsLoopback ? '<p><strong>내 컴퓨터의 앱으로 전달됩니다.</strong> 방금 직접 연결을 시작한 경우에만 계속하세요.</p>' : ''}
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<p><button name="decision" value="approve">허용하고 EMA Station에서 로그인</button> <button name="decision" value="deny">거부</button></p></form>
<p class="muted">비밀번호는 EMA Station 사이트에서만 입력합니다. 7일 동안 사용하지 않으면 연결이 끊깁니다.</p>`;
}

async function startUpstream(env, oauth, authRequest, headers) {
  const { state, headers: upstreamHeaders } = await oauth.beginUpstream(authRequest, { data: {}, headers });
  upstreamHeaders.set('Location', `${env.EMA_WEB_ORIGIN}/mcp/authorize?state=${encodeURIComponent(state)}`);
  return new Response(null, { status: 302, headers: upstreamHeaders });
}

// 동의 화면은 10분 안에 눌러야 하고, 다른 브라우저에서 이어 누르거나 두 번 누르면 라이브러리가 AuthorizationError 를 던진다.
// 잡지 않으면 Cloudflare 오류 1101 화면이 나오므로 다시 시작하라는 안내로 바꾼다.
export async function handleAuthorize(request, env) {
  try {
    return await authorize(request, env);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return page('EMA Station 연결', '<h1>연결 요청이 만료됐습니다</h1><p>동의 화면은 10분 안에 눌러야 하고, 한 번만 쓸 수 있습니다.</p><p class="muted">AI 앱으로 돌아가 연결을 다시 시작해 주세요.</p>', new Headers(), 400);
    }
    throw error;
  }
}

async function authorize(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  const remember = { secret: env.CONSENT_SECRET };
  if (request.method === 'GET') {
    const authRequest = await oauth.parseAuthRequest(request);
    if (await oauth.isConsentRemembered(request, authRequest, remember)) return startUpstream(env, oauth, authRequest);
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return page('EMA Station 연결', consentPage(details, consent.handle), consent.headers);
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
  const form = await request.formData();
  const handle = String(form.get('handle') || '');
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle, { scope: [...SCOPES], remember });
  return startUpstream(env, oauth, approved.request, approved.headers);
}

function corsHeaders(env) {
  return {
    'access-control-allow-origin': env.EMA_WEB_ORIGIN,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
    'cache-control': 'no-store',
  };
}

function json(env, body, status = 200, extra = new Headers()) {
  const headers = new Headers(extra);
  for (const [key, value] of Object.entries(corsHeaders(env))) headers.set(key, value);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

// EMA 사이트의 연결 확인 화면이 호출한다. 연결 요청을 시작한 브라우저의 쿠키(같은 사이트)로 요청을 묶는다.
export async function handleSession(request, env, { fetchImpl = fetch } = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (request.method !== 'POST') return json(env, { message: 'POST만 허용됩니다.' }, 405);
  if (request.headers.get('origin') !== env.EMA_WEB_ORIGIN) return json(env, { message: '허용되지 않은 요청 위치입니다.' }, 403);

  let body;
  try { body = await request.json(); } catch { return json(env, { message: '요청 형식이 올바르지 않습니다.' }, 400); }
  const state = typeof body?.state === 'string' ? body.state : '';
  const idToken = typeof body?.idToken === 'string' ? body.idToken : '';
  const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken : '';
  if (!state || !idToken || !refreshToken) return json(env, { message: '로그인 정보가 없습니다. 다시 시도해 주세요.' }, 400);

  // 토큰이 EMA 프로젝트의 것이고 레지스트리 권한이 있는지 EMA 서버가 직접 판단한다. 실패하면 연결 요청은 그대로 남는다.
  let access;
  try {
    access = await createEmaClient({ functionsBase: env.EMA_FUNCTIONS_BASE, idToken, fetchImpl }).call('getRegistryAccess');
  } catch (error) {
    if (error instanceof EmaError && ['PERMISSION_DENIED', 'UNAUTHENTICATED'].includes(error.code)) {
      return json(env, { message: '이 계정에는 EMA Station 기업 등록 데이터 권한이 없습니다. 관리자·컨설턴트·직원 계정으로 로그인해 주세요.' }, 403);
    }
    return json(env, { message: 'EMA Station에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.' }, 502);
  }

  const oauth = env.OAUTH_PROVIDER;
  let resumed;
  try {
    const stateRequest = new Request(`${env.PUBLIC_ORIGIN}/callback?state=${encodeURIComponent(state)}`, {
      headers: { cookie: request.headers.get('cookie') || '' },
    });
    resumed = await oauth.finishUpstream(stateRequest);
  } catch {
    return json(env, { message: '연결 요청이 만료됐거나 다른 브라우저에서 시작됐습니다. AI 앱에서 연결을 다시 시작해 주세요.' }, 400);
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: resumed.request,
    userId: access.uid,
    metadata: { email: access.email, role: access.role },
    scope: resumed.request.scope,
    props: {
      uid: access.uid,
      email: access.email,
      role: access.role,
      canExportAndImport: access.canExportAndImport === true,
      idToken,
      refreshToken,
      expiresAt: Date.now() + 55 * 60 * 1000,
    },
  });
  return json(env, { redirectTo }, 200, resumed.headers);
}

export { authorizationErrorRedirect };
