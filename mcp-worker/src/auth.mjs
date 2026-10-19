import { AuthorizationError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { createBffClient, BffError } from './bff.mjs';
import { exchangeGoogleCode, googleAuthorizeUrl, IdentityError, s256, signInFirebase } from './identity.mjs';

// /authorize 와 /callback. 동의 화면 → 회사 Google 로그인 → Firebase 세션 → MYSCube 구성원 확인 순서다.
// 동의 화면 위조·프레이밍 방지, state 의 브라우저 묶기는 workers-oauth-provider 의 helper 가 맡는다.
export const SCOPES = Object.freeze(['myscube:read']);

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

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
  return `<h1>${escape(details.clientName)}에서 MYSCube를 조회하도록 허용할까요?</h1>
<p>회사 Google 계정으로 로그인하면, 이 앱이 MYSCube 데이터를 <strong>읽기 전용</strong>으로 조회합니다. 보이는 범위는 MYSCube 화면에서 내가 볼 수 있는 범위와 같고, 데이터를 바꾸지는 못합니다.</p>
<p class="muted">접근 권한이 전달되는 곳: <strong>${escape(details.redirectHost)}</strong>${details.clientDomain ? ` · 게시: ${escape(details.clientDomain)}` : ' · 이 앱이 스스로 등록한 이름입니다.'}</p>
${details.redirectIsLoopback ? '<p><strong>내 컴퓨터의 앱으로 전달됩니다.</strong> 방금 직접 연결을 시작한 경우에만 계속하세요.</p>' : ''}
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<p><button name="decision" value="approve">허용하고 Google로 로그인</button> <button name="decision" value="deny">거부</button></p></form>
<p class="muted">허용하면 30일 동안 다시 묻지 않습니다.</p>`;
}

function errorPage(message, status = 400) {
  return page('MYSCube 연결', `<h1>MYSCube에 연결하지 못했습니다</h1><p>${escape(message)}</p><p class="muted">AI 앱에서 연결을 다시 시작해 주세요.</p>`, new Headers(), status);
}

async function startUpstream(env, oauth, authRequest, headers) {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers: upstreamHeaders } = await oauth.beginUpstream(authRequest, { data: { verifier }, headers });
  upstreamHeaders.set('Location', googleAuthorizeUrl({ clientId: env.GOOGLE_CLIENT_ID, redirectUri: `${env.PUBLIC_ORIGIN}/callback`,
    state, codeChallenge: await s256(verifier), hostedDomain: env.GOOGLE_HOSTED_DOMAIN }));
  return new Response(null, { status: 302, headers: upstreamHeaders });
}

// 동의 화면은 10분 안에 눌러야 하고 한 번만 쓸 수 있다. 라이브러리가 던지는 AuthorizationError 를
// 그대로 두면 Cloudflare 오류 1101 화면이 나오므로 다시 시작하라는 안내로 바꾼다.
export async function handleAuthorize(request, env) {
  try {
    return await authorize(request, env);
  } catch (error) {
    if (error instanceof AuthorizationError) return errorPage('연결 요청이 만료됐습니다. 동의 화면은 10분 안에 한 번만 누를 수 있습니다.');
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
    return page('MYSCube 연결', consentPage(details, consent.handle), consent.headers);
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

export async function handleCallback(request, env, { fetchImpl = fetch } = {}) {
  const oauth = env.OAUTH_PROVIDER;
  let stage = 'upstream_state';
  try {
    const { request: original, data, headers } = await oauth.finishUpstream(request);
    const params = new URL(request.url).searchParams;
    if (params.get('error') || !params.get('code')) {
      headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
      return new Response(null, { status: 302, headers });
    }
    stage = 'google_exchange';
    const google = await exchangeGoogleCode({ code: params.get('code'), verifier: data.verifier, clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: `${env.PUBLIC_ORIGIN}/callback`, hostedDomain: env.GOOGLE_HOSTED_DOMAIN, fetchImpl });
    stage = 'firebase_sign_in';
    const firebase = await signInFirebase({ googleIdToken: google.idToken, apiKey: env.FIREBASE_WEB_API_KEY, requestUri: env.PUBLIC_ORIGIN, fetchImpl });
    // 활성 구성원인지 BFF 가 앱과 같은 규칙으로 판단한다. 구성원이 아니면 토큰을 발급하지 않는다.
    stage = 'member_check';
    await createBffClient({ baseUrl: env.BFF_BASE_URL, idToken: firebase.idToken, tenantId: env.BFF_TENANT_ID, fetchImpl }).get('/api/v1/projects', { limit: 1 });
    stage = 'grant_completion';
    const { redirectTo } = await oauth.completeAuthorization({
      request: original, userId: firebase.uid, metadata: { email: google.email }, scope: original.scope,
      props: { uid: firebase.uid, email: google.email, firebaseIdToken: firebase.idToken, firebaseRefreshToken: firebase.refreshToken,
        firebaseExpiresAt: Date.now() + firebase.expiresIn * 1000 },
    });
    headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return errorPage('연결 요청이 만료됐거나 다른 브라우저에서 시작됐습니다. AI 앱에서 연결을 다시 시작해 주세요.');
    if (error instanceof IdentityError) return errorPage(error.message);
    if (error instanceof BffError && [401, 403].includes(error.status)) return errorPage('MYSCube 활성 구성원만 연결할 수 있습니다. 관리자에게 구성원 등록을 요청해 주세요.', 403);
    console.error('myscube_oauth_callback_failed', { stage, code: error instanceof BffError ? 'bff_request_failed' : 'callback_failed' });
    return errorPage('연결 서버에서 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.', error instanceof BffError && error.status === 503 ? 503 : 502);
  }
}
