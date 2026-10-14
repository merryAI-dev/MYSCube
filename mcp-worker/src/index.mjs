import OAuthProvider, { GrantType, OAuthError } from '@cloudflare/workers-oauth-provider';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { handleAuthorize, handleCallback, SCOPES } from './auth.mjs';
import { createBffClient } from './bff.mjs';
import { refreshFirebase } from './identity.mjs';
import { createMyscubeMcpServer } from './tools.mjs';
import { clientOf, usageRecorder } from './usage.mjs';

const ORIGIN = 'https://mcp.myscguard.app';
// MCP 액세스 토큰은 그 안에 담긴 Firebase ID 토큰(1시간)보다 먼저 끝나야 한다.
const ACCESS_TOKEN_TTL = 55 * 60;
const GRANT_IDLE_TTL = 30 * 24 * 60 * 60;

async function refreshedProps(props, env) {
  try {
    const next = await refreshFirebase({ refreshToken: props.firebaseRefreshToken, apiKey: env.FIREBASE_WEB_API_KEY });
    return { ...props, firebaseIdToken: next.idToken, firebaseRefreshToken: next.refreshToken, firebaseExpiresAt: Date.now() + next.expiresIn * 1000 };
  } catch (error) {
    if (error?.code === 'firebase_revoked') throw new OAuthError('invalid_grant', { description: 'MYSCube 로그인이 만료됐습니다. 다시 연결해 주세요.' });
    throw new OAuthError('temporarily_unavailable', { description: 'MYSCube 로그인 서버에 잠시 연결할 수 없습니다.', statusCode: 503 });
  }
}

const mcpHandler = {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    let props = ctx.props;
    if (!props?.firebaseIdToken || props.firebaseExpiresAt < Date.now() + 60_000) props = await refreshedProps(props, env);
    const server = createMyscubeMcpServer({
      bff: createBffClient({ baseUrl: env.BFF_BASE_URL, idToken: props.firebaseIdToken }),
      record: usageRecorder(env.USAGE, { uid: props.uid, role: 'member', client: clientOf(request.headers.get('user-agent')) }),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

const defaultHandler = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/authorize') return handleAuthorize(request, env);
    if (pathname === '/callback') return handleCallback(request, env);
    if (pathname === '/') {
      return new Response(`MYSCube MCP\n\nClaude, ChatGPT 등 MCP 클라이언트에 ${ORIGIN}/mcp 를 등록하세요.\n`, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return new Response('Not found', { status: 404 });
  },
};

export default new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: mcpHandler,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: [...SCOPES],
  resourceMetadata: { resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] },
  accessTokenTTL: ACCESS_TOKEN_TTL,
  refreshTokenTTL: GRANT_IDLE_TTL,
  refreshTokenIdleTTL: GRANT_IDLE_TTL,
  tokenExchangeCallback: async ({ grantType, props, env }) => {
    if (grantType === GrantType.AUTHORIZATION_CODE) return { accessTokenTTL: ACCESS_TOKEN_TTL };
    if (grantType !== GrantType.REFRESH_TOKEN) return undefined;
    return { newProps: await refreshedProps(props, env), accessTokenTTL: ACCESS_TOKEN_TTL };
  },
});
