import { createHttpError } from './bff-utils.mjs';

export async function verifyClosureGoogleAccess(accessToken, context, {
  clientId = process.env.BFF_GOOGLE_OAUTH_CLIENT_ID,
  fetchImpl = fetch,
} = {}) {
  const reconnect = () => createHttpError(401, 'Google 연결이 만료되었거나 조회 동의가 필요합니다. 다시 연결해 주세요.', 'project_closure_google_reconnect');
  if (typeof accessToken !== 'string' || !/^[A-Za-z0-9._~+\/-]{1,8192}$/.test(accessToken)) throw reconnect();
  if (context.authSource !== 'firebase' || typeof context.googleSubject !== 'string' || !context.googleSubject) {
    throw createHttpError(403, '현재 로그인 계정에 연결된 Google 계정으로 다시 로그인해 주세요.', 'project_closure_google_account_mismatch');
  }
  if (!clientId) throw createHttpError(503, 'Google 조회 연결 설정을 관리자에게 확인해 주세요.', 'project_closure_google_not_configured');
  let response;
  let info;
  try {
    response = await fetchImpl('https://oauth2.googleapis.com/tokeninfo', {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    if (response.ok) info = await response.json();
  } catch {
    throw createHttpError(503, 'Google 연결을 지금 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.', 'project_closure_drive_unavailable');
  }
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) throw reconnect();
    throw createHttpError(503, 'Google 연결을 지금 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.', 'project_closure_drive_unavailable');
  }
  if (info?.aud !== clientId || !Number.isFinite(Number(info?.expires_in)) || Number(info.expires_in) <= 0
    || !String(info?.scope || '').split(' ').includes('https://www.googleapis.com/auth/drive.metadata.readonly')) throw reconnect();
  if (info.sub !== context.googleSubject) {
    throw createHttpError(403, '현재 로그인 계정과 같은 Google 계정으로 다시 연결해 주세요.', 'project_closure_google_account_mismatch');
  }
}
