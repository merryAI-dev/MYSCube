import { createPrivateKey, sign } from 'node:crypto';
import { createHttpError } from '../bff/bff-utils.mjs';

const failure = (code, message) => createHttpError(503, message, code);
const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
export function createGitCredentialProvider({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  let cached = null;
  return async ({ repository, signal }) => {
    signal?.throwIfAborted();
    const mode = env.WORKBENCH_GIT_CREDENTIAL_MODE || 'token';
    if (mode === 'token') {
      if (!env.WORKBENCH_GITHUB_TOKEN) throw failure('git_delivery_disabled', 'GitHub 전용 인증 정보가 아직 설정되지 않았습니다. 저장 버전은 유지됩니다.');
      return env.WORKBENCH_GITHUB_TOKEN;
    }
    if (mode !== 'github-app') throw failure('git_credential_config_invalid', 'GitHub 인증 방식 설정을 확인해 주세요.');
    const appId = env.WORKBENCH_GITHUB_APP_ID;
    const installationId = env.WORKBENCH_GITHUB_INSTALLATION_ID;
    const privateKey = env.WORKBENCH_GITHUB_APP_PRIVATE_KEY;
    if (!/^\d+$/.test(appId || '') || !/^\d+$/.test(installationId || '') || !privateKey || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw failure('git_credential_config_invalid', 'GitHub App의 식별자·설치·전용 키 설정을 확인해 주세요.');
    const cacheKey = `${appId}:${installationId}:${repository.toLowerCase()}`;
    if (cached?.key === cacheKey && cached.expiresAt > now() + 60_000) return cached.token;
    const issued = Math.floor(now() / 1000);
    const input = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ iat: issued - 60, exp: issued + 540, iss: appId })}`;
    let jwt;
    try { jwt = `${input}.${sign('RSA-SHA256', Buffer.from(input), createPrivateKey(privateKey)).toString('base64url')}`; }
    catch { throw failure('git_credential_config_invalid', 'GitHub App 서명 키를 확인해 주세요.'); }
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, { method: 'POST', redirect: 'error', signal,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10' },
        body: JSON.stringify({ repositories: [repository.split('/')[1]], permissions: { contents: 'write', pull_requests: 'write' } }) });
    } catch { throw failure('git_credential_unavailable', 'GitHub 전용 인증을 준비하지 못했습니다. 같은 저장 버전으로 다시 시도해 주세요.'); }
    if (!response.ok) throw failure('git_credential_denied', 'GitHub App의 저장소 설치와 코드·검토 요청 권한을 확인해 주세요.');
    let value;
    try { value = await response.json(); } catch { throw failure('git_credential_invalid', 'GitHub 인증 응답을 확인하지 못했습니다.'); }
    const permissions = value?.permissions;
    if (typeof value?.token !== 'string' || !value.token || !Number.isFinite(Date.parse(value.expires_at)) || Date.parse(value.expires_at) <= now() + 60_000
      || !permissions || permissions.contents !== 'write' || permissions.pull_requests !== 'write'
      || Object.keys(permissions).some((name) => !['contents', 'pull_requests', 'metadata'].includes(name))
      || (permissions.metadata !== undefined && permissions.metadata !== 'read')
      || (value.repositories && (!Array.isArray(value.repositories) || value.repositories.length !== 1 || value.repositories[0].full_name?.toLowerCase() !== repository.toLowerCase()))) {
      throw failure('git_credential_scope_invalid', 'GitHub 인증의 대상 저장소와 최소 권한을 확인하지 못했습니다.');
    }
    signal?.throwIfAborted();
    cached = { key: cacheKey, token: value.token, expiresAt: Date.parse(value.expires_at) };
    return cached.token;
  };
}
