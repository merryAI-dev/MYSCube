import OAuthProvider, { GrantType, OAuthError } from '@cloudflare/workers-oauth-provider';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { refreshFirebase } from '../identity.mjs';
import { handleAuthorize, handleSession, SCOPES } from './auth.mjs';
import { createEmaClient } from './client.mjs';
import { runImportCommit } from './commit.mjs';
import { createStore, handleConfirm, handleFileDownload, handleUpload } from './files.mjs';
import { createEmaMcpServer } from './tools.mjs';

// MCP 액세스 토큰은 안에 담긴 Firebase ID 토큰(1시간)보다 먼저 끝나야 한다.
const ACCESS_TOKEN_TTL = 55 * 60;
const GRANT_MAX_TTL = 30 * 24 * 60 * 60;
const GRANT_IDLE_TTL = 7 * 24 * 60 * 60;

async function refreshedProps(props, env) {
  try {
    const next = await refreshFirebase({ refreshToken: props.refreshToken, apiKey: env.FIREBASE_WEB_API_KEY });
    return { ...props, idToken: next.idToken, refreshToken: next.refreshToken, expiresAt: Date.now() + next.expiresIn * 1000 };
  } catch (error) {
    if (error?.code === 'firebase_revoked') throw new OAuthError('invalid_grant', { description: 'EMA Station 로그인이 만료됐습니다. 다시 연결해 주세요.' });
    throw new OAuthError('temporarily_unavailable', { description: 'EMA Station 로그인 서버에 잠시 연결할 수 없습니다.', statusCode: 503 });
  }
}

const mcpHandler = {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    let props = ctx.props;
    if (!props?.idToken || props.expiresAt < Date.now() + 16 * 60_000) props = await refreshedProps(props, env);
    const server = createEmaMcpServer({
      ema: createEmaClient({ functionsBase: env.EMA_FUNCTIONS_BASE, idToken: props.idToken }),
      store: createStore(env.OAUTH_KV),
      publicOrigin: env.PUBLIC_ORIGIN,
      access: { uid: props.uid, role: props.role, canExportAndImport: props.canExportAndImport === true, idToken: props.idToken, idTokenExpiresAt: props.expiresAt },
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
    if (pathname === '/ema/session') return handleSession(request, env);
    const upload = /^\/upload\/([A-Za-z0-9_-]{20,80})$/u.exec(pathname);
    if (upload) return handleUpload(request, createStore(env.OAUTH_KV), upload[1]);
    const confirm = /^\/confirm\/([A-Za-z0-9_-]{20,80})$/u.exec(pathname);
    if (confirm) {
      const store = createStore(env.OAUTH_KV);
      const link = await store.readConfirm(confirm[1]);
      const ema = link ? createEmaClient({ functionsBase: env.EMA_FUNCTIONS_BASE, idToken: link.idToken }) : null;
      return handleConfirm(request, {
        store, ema, token: confirm[1],
        runCommit: (options) => runImportCommit({ ...options, store }),
      });
    }
    const file = /^\/files\/([A-Za-z0-9_-]{20,80})$/u.exec(pathname);
    if (file && request.method === 'GET') return handleFileDownload(createStore(env.OAUTH_KV), file[1]);
    if (pathname === '/') {
      return new Response(`EMA Station MCP\n\nClaude, ChatGPT 등 MCP 클라이언트에 ${env.PUBLIC_ORIGIN}/mcp 를 등록하세요.\n`, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return new Response('Not found', { status: 404 });
  },
};

let provider;

export default {
  fetch(request, env, ctx) {
    provider ||= new OAuthProvider({
      apiRoute: '/mcp',
      apiHandler: mcpHandler,
      defaultHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [...SCOPES],
      resourceMetadata: { resource: `${env.PUBLIC_ORIGIN}/mcp`, authorization_servers: [env.PUBLIC_ORIGIN] },
      accessTokenTTL: ACCESS_TOKEN_TTL,
      refreshTokenTTL: GRANT_MAX_TTL,
      refreshTokenIdleTTL: GRANT_IDLE_TTL,
      tokenExchangeCallback: async ({ grantType, props, env: exchangeEnv }) => {
        if (grantType === GrantType.AUTHORIZATION_CODE) return { accessTokenTTL: ACCESS_TOKEN_TTL };
        if (grantType !== GrantType.REFRESH_TOKEN) return undefined;
        return { newProps: await refreshedProps(props, exchangeEnv), accessTokenTTL: ACCESS_TOKEN_TTL };
      },
    });
    return provider.fetch(request, env, ctx);
  },
};
