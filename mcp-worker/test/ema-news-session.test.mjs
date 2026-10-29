import { afterEach, describe, expect, it, vi } from 'vitest';
const bridge=vi.hoisted(()=>({options:null,access:null, fresh:{uid:'u',role:'admin',canExportAndImport:true}}));
vi.mock('@cloudflare/workers-oauth-provider',()=>({default:class{constructor(options){bridge.options=options;}fetch(){return new Response('fixture');}},GrantType:{AUTHORIZATION_CODE:'authorization_code',REFRESH_TOKEN:'refresh_token'},OAuthError:class extends Error{},AuthorizationError:class extends Error{},authorizationErrorRedirect:vi.fn()}));
vi.mock('../src/ema/tools.mjs',()=>({createEmaMcpServer:({access})=>{bridge.access=access;return {connect:async()=>{}};}}));
vi.mock('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js',()=>({WebStandardStreamableHTTPServerTransport:class{handleRequest(){return Response.json(bridge.access);}}}));
const {default:worker}=await import('../src/ema/index.mjs');
const E={FIREBASE_WEB_API_KEY:'fixture',EMA_FUNCTIONS_BASE:'https://f.test'};
const P={uid:'u',role:'admin',idToken:'fixture',refreshToken:'fixture',expiresAt:Date.now()+3600000,canExportAndImport:true,grantedScopes:['ema:news:read'],newsConsentVersion:'news-read.v1'};
worker.fetch(new Request('https://mcp.test'),E,{});
afterEach(()=>{vi.unstubAllGlobals();bridge.fresh={uid:'u',role:'admin',canExportAndImport:true};});
const req=()=>new Request('https://mcp.test/mcp',{method:'POST'});
function fetcher(){vi.stubGlobal('fetch',vi.fn(async(url)=>{if(String(url).includes('securetoken.googleapis.com'))return Response.json({id_token:'newfixture',refresh_token:'fixture',expires_in:3600});return Response.json({result:bridge.fresh});}));}
describe('actual EMA MCP handler scope binding',()=>{
 it.each([false,true])('passes only news privilege after exact grant and fresh admin, refresh=%s',async(expired)=>{fetcher();const response=await bridge.options.apiHandler.fetch(req(),E,{props:{...P,expiresAt:expired?0:P.expiresAt},auth:{scope:['ema:news:read']}});expect(response.status).toBe(200);expect(bridge.access.canReadNews).toBe(true);expect(bridge.access.canReadRegistry).toBe(false);});
 it('keeps news absent after token downscope even when original grant had news',async()=>{fetcher();await bridge.options.apiHandler.fetch(req(),E,{props:P,auth:{scope:['ema:registry']}});expect(bridge.access.canReadNews).toBe(false);expect(fetch).not.toHaveBeenCalled();});
 it('never promotes an old grant on refresh',async()=>{fetcher();const props={...P,expiresAt:0};delete props.grantedScopes;delete props.newsConsentVersion;await bridge.options.apiHandler.fetch(req(),E,{props,auth:{scope:['ema:registry']}});expect(bridge.access.canReadNews).toBe(false);});
 it.each([{uid:'u',role:'staff',canExportAndImport:false},{uid:'other',role:'admin',canExportAndImport:true}])('rejects changed current account privileges %j',async(fresh)=>{bridge.fresh=fresh;fetcher();await bridge.options.apiHandler.fetch(req(),E,{props:P,auth:{scope:['ema:news:read']}});expect(bridge.access.canReadNews).toBe(false);});
 it('fails closed without exposing raw errors when access lookup fails',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('private fixture');}));const res=await bridge.options.apiHandler.fetch(req(),E,{props:P,auth:{scope:['ema:news:read']}});expect(res.status).toBe(403);expect(await res.text()).not.toContain('private fixture');});
});
