import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { parseAuthorizationBearer } from './auth.mjs';
import { asyncHandler, createHttpError, readOptionalText } from './bff-utils.mjs';

const SCOPE = 'cashflow.read';
const CODE_TTL_MS = 60_000;
// 비개발자가 Google 로그인까지 마칠 시간을 준다.
const REQUEST_TTL_MS = 10 * 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
// 갱신 토큰은 쓸 때마다 새로 발급되고 30일 동안 쓰지 않으면 만료된다. 매번 구성원 상태를 다시 확인한다.
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const LOCAL_CLIENT_ID = 'myscube-local-launcher';

const hash = (value) => createHash('sha256').update(value).digest('base64url');
const secret = () => randomBytes(32).toString('base64url');
const nowMs = (now) => now().getTime();

function required(value, code = 'invalid_request') {
  const text = readOptionalText(value);
  if (!text) throw createHttpError(400, 'OAuth 요청 값이 올바르지 않습니다.', code);
  return text;
}

function publicUrl(value, name) {
  let url;
  try { url = new URL(required(value)); } catch { throw createHttpError(500, `${name} 설정이 올바르지 않습니다.`, 'mcp_oauth_config_invalid'); }
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw createHttpError(500, `${name}은 HTTPS여야 합니다.`, 'mcp_oauth_config_invalid');
  }
  return url.toString().replace(/\/$/, '');
}


function loopbackRedirect(uri) {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname === '/callback';
  } catch { return false; }
}

function validRedirect(uri) {
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' || loopbackRedirect(uri);
  } catch { return false; }
}

function appendQuery(uri, values) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(values)) if (value) url.searchParams.set(key, value);
  return url.toString();
}

function memberContext(member, context) {
  const role = readOptionalText(member?.role).toLowerCase();
  const hasStatus = member
    ? Object.prototype.hasOwnProperty.call(member, 'status')
    : false;
  if (!member || (hasStatus && member.status !== 'ACTIVE') || !role) {
    throw createHttpError(403, '활성 MYSCube 구성원만 MCP를 사용할 수 있습니다.', 'mcp_member_inactive');
  }
  return {
    tenantId: context.tenantId,
    actorId: context.actorId,
    actorRole: role === 'viewer' ? 'pm' : role,
    actorEmail: readOptionalText(member.email).toLowerCase() || context.actorEmail,
    actorName: readOptionalText(member.name) || context.actorName,
    authSource: 'mcp_oauth',
    requestId: randomUUID(),
  };
}

export function createMcpOAuthService({ db, issuer, publicOrigin, now = () => new Date() }) {
  const safeIssuer = publicUrl(issuer, 'MYSCUBE_MCP_OAUTH_ISSUER');
  const safeOrigin = publicUrl(publicOrigin || issuer, 'MYSCUBE_MCP_PUBLIC_ORIGIN');
  const resource = `${safeOrigin}/mcp`;
  const collection = (name, key) => db.collection(name).doc(hash(key));

  async function clientFor(clientId, redirectUri) {
    if (clientId === LOCAL_CLIENT_ID) {
      if (!loopbackRedirect(redirectUri)) throw createHttpError(400, '등록되지 않은 OAuth 반환 주소입니다.', 'invalid_redirect_uri');
      return { clientId, redirectUri };
    }
    const snap = await collection('mcp_oauth_clients', clientId).get();
    const client = snap.exists ? snap.data() : null;
    if (!client || client.clientId !== clientId || !Array.isArray(client.redirectUris) || !client.redirectUris.includes(redirectUri)) {
      throw createHttpError(400, '등록되지 않은 OAuth 클라이언트 또는 반환 주소입니다.', 'invalid_client');
    }
    return client;
  }

  async function activeContext(context) {
    const member = await db.doc(`orgs/${context.tenantId}/members/${context.actorId}`).get();
    return memberContext(member.exists ? member.data() : null, context);
  }

  async function issueTokens({ context, clientId }) {
    const accessToken = secret();
    const refreshToken = secret();
    const createdAt = now().toISOString();
    await collection('mcp_oauth_tokens', accessToken).set({ context, clientId, scope: SCOPE, resource, expiresAtMs: nowMs(now) + ACCESS_TTL_MS, createdAt });
    await collection('mcp_oauth_refresh_tokens', refreshToken).set({ context, clientId, resource, expiresAtMs: nowMs(now) + REFRESH_TTL_MS, createdAt });
    return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refreshToken, scope: SCOPE };
  }

  async function refresh(input) {
    const clientId = required(input.client_id);
    const ref = collection('mcp_oauth_refresh_tokens', required(input.refresh_token));
    const record = await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const current = snap.exists ? snap.data() : null;
      if (!current || current.usedAt || current.expiresAtMs < nowMs(now) || current.clientId !== clientId || current.resource !== resource) {
        throw createHttpError(400, '로그인이 만료됐습니다. 다시 연결해 주세요.', 'invalid_grant');
      }
      transaction.set(ref, { usedAt: now().toISOString() }, { merge: true });
      return current;
    });
    return issueTokens({ context: await activeContext(record.context), clientId });
  }

  return {
    issuer: safeIssuer,
    resource,
    metadata() {
      return {
        issuer: safeIssuer,
        authorization_endpoint: `${safeIssuer}/api/v1/mcp/oauth/authorize`,
        token_endpoint: `${safeIssuer}/api/v1/mcp/oauth/token`,
        registration_endpoint: `${safeIssuer}/api/v1/mcp/oauth/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'], scopes_supported: [SCOPE],
        grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
      };
    },
    async register({ redirectUris }) {
      if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 5 || redirectUris.some((uri) => !validRedirect(uri))) {
        throw createHttpError(400, 'OAuth 반환 주소가 올바르지 않습니다.', 'invalid_client_metadata');
      }
      const clientId = `myscube-${secret()}`;
      await collection('mcp_oauth_clients', clientId).set({ clientId, redirectUris, createdAt: now().toISOString() });
      return { client_id: clientId, redirect_uris: redirectUris, token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
    },
    async startAuthorization(input) {
      const clientId = required(input.client_id);
      const redirectUri = required(input.redirect_uri);
      await clientFor(clientId, redirectUri);
      if (required(input.response_type) !== 'code' || required(input.code_challenge_method) !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(required(input.code_challenge))) {
        throw createHttpError(400, 'PKCE S256 인증 요청이 필요합니다.', 'invalid_request');
      }
      // 요청한 scope 와 무관하게 읽기 전용 권한 하나만 발급한다.
      if (input.resource && readOptionalText(input.resource) !== resource) throw createHttpError(400, 'MCP 리소스 주소가 일치하지 않습니다.', 'invalid_target');
      const requestId = secret();
      await collection('mcp_oauth_requests', requestId).set({
        clientId, redirectUri, codeChallenge: input.code_challenge, state: readOptionalText(input.state),
        expiresAtMs: nowMs(now) + REQUEST_TTL_MS, createdAt: now().toISOString(),
      });
      return `${safeOrigin}/mcp/authorize?request_id=${encodeURIComponent(requestId)}`;
    },
    async completeAuthorization({ requestId, context }) {
      const requestRef = collection('mcp_oauth_requests', required(requestId));
      const snap = await requestRef.get();
      const request = snap.exists ? snap.data() : null;
      if (!request || request.expiresAtMs < nowMs(now) || request.completedAt) throw createHttpError(400, 'OAuth 로그인 요청이 만료됐습니다. 다시 시작해 주세요.', 'invalid_request');
      const active = await activeContext(context);
      const code = secret();
      await collection('mcp_oauth_codes', code).set({
        clientId: request.clientId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge,
        context: active, expiresAtMs: nowMs(now) + CODE_TTL_MS, createdAt: now().toISOString(),
      });
      await requestRef.set({ completedAt: now().toISOString() }, { merge: true });
      return appendQuery(request.redirectUri, { code, state: request.state });
    },
    async exchangeCode(input) {
      if (input.grant_type === 'refresh_token') return refresh(input);
      const code = required(input.code);
      const verifier = required(input.code_verifier);
      const clientId = required(input.client_id);
      const redirectUri = required(input.redirect_uri);
      await clientFor(clientId, redirectUri);
      if (input.grant_type !== 'authorization_code' || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) throw createHttpError(400, 'OAuth 코드 교환 요청이 올바르지 않습니다.', 'invalid_request');
      const ref = collection('mcp_oauth_codes', code);
      const accessToken = secret();
      const context = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        const record = snap.exists ? snap.data() : null;
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (!record || record.usedAt || record.expiresAtMs < nowMs(now) || record.clientId !== clientId || record.redirectUri !== redirectUri || record.codeChallenge !== challenge) {
          throw createHttpError(400, 'OAuth 인증 코드가 올바르지 않거나 이미 사용됐습니다.', 'invalid_grant');
        }
        transaction.set(ref, { usedAt: now().toISOString() }, { merge: true });
        return record.context;
      });
      return issueTokens({ context, clientId });
    },
    async resolveAccessToken(authorization) {
      const accessToken = parseAuthorizationBearer(authorization);
      if (!accessToken) throw createHttpError(401, 'MCP access token is required.', 'invalid_token');
      const snap = await collection('mcp_oauth_tokens', accessToken).get();
      const record = snap.exists ? snap.data() : null;
      if (!record || record.expiresAtMs < nowMs(now) || record.scope !== SCOPE || record.resource !== resource) throw createHttpError(401, 'MCP access token is invalid or expired.', 'invalid_token');
      return activeContext(record.context);
    },
  };
}

export function mountMcpOAuthRoutes(app, { service, resolveFirebaseContext }) {
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(service.metadata()));
  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json({ resource: service.resource, authorization_servers: [service.issuer] }));
  app.post('/api/v1/mcp/oauth/register', asyncHandler(async (req, res) => res.status(201).json(await service.register({ redirectUris: req.body?.redirect_uris }))));
  app.get('/api/v1/mcp/oauth/authorize', asyncHandler(async (req, res) => res.redirect(302, await service.startAuthorization(req.query))));
  app.post('/api/v1/mcp/oauth/authorize/complete', asyncHandler(async (req, res) => {
    const context = await resolveFirebaseContext(req);
    res.status(200).json({ redirectUri: await service.completeAuthorization({ requestId: req.body?.requestId, context }) });
  }));
  app.post('/api/v1/mcp/oauth/token', asyncHandler(async (req, res) => res.json(await service.exchangeCode(req.body || {}))));
}
