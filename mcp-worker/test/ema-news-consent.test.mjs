import { describe, expect, it, vi } from 'vitest';
vi.mock('@cloudflare/workers-oauth-provider', () => ({ AuthorizationError: class extends Error {}, authorizationErrorRedirect: vi.fn() }));
const { handleAuthorize, handleSession } = await import('../src/ema/auth.mjs');
const { scopedAccess, requestedScopes, NEWS_CONSENT_VERSION } = await import('../src/ema/scopes.mjs');
const N = 'ema:news:read', R = 'ema:registry';
const env = (oauth) => ({ OAUTH_PROVIDER: oauth, EMA_WEB_ORIGIN: 'https://ema.test', PUBLIC_ORIGIN: 'https://mcp.test', EMA_FUNCTIONS_BASE: 'https://f.test', CONSENT_SECRET: 'fixture'.repeat(8) });
const upstream = { state: 'fixture', headers: new Headers() };
function provider(scope) { return {
 parseAuthRequest: vi.fn(async () => ({ scope })), isConsentRemembered: vi.fn(async () => true),
 describeConsent: vi.fn(async () => ({ clientName: 'fixture', redirectHost: 'client.test' })), beginConsent: vi.fn(async () => ({ handle: 'fixture', headers: new Headers() })),
 approveConsent: vi.fn(async () => ({ request: { scope }, headers: new Headers() })), beginUpstream: vi.fn(async () => upstream),
 finishUpstream: vi.fn(async () => ({ request: { scope }, headers: new Headers() })), completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://client.test' })),
}; }
function approve(checked) { const body = new FormData(); body.set('handle','fixture'); body.set('decision','approve'); if(checked)body.set('newsConsent','yes'); return new Request('https://mcp.test/authorize',{ method:'POST',body }); }
function session() { return new Request('https://mcp.test/ema/session',{method:'POST',headers:{origin:'https://ema.test','content-type':'application/json'},body:JSON.stringify({state:'fixture',idToken:'fixture-id',refreshToken:'fixture-refresh'})}); }
describe('EMA scope consent boundary', () => {
 it('requires a new explicit news consent even with remembered registry approval',async()=>{const o=provider([N]); const res=await handleAuthorize(new Request('https://mcp.test/authorize'),env(o));expect(res.status).toBe(200);expect(await res.text()).toContain('newsConsent');expect(o.beginUpstream).not.toHaveBeenCalled();expect(o.isConsentRemembered).not.toHaveBeenCalled();});
 it.each([[[R]],[[N]],[[R,N]],[[]]])('approves only requested scopes: %j',async(scope)=>{const o=provider(scope); const res=await handleAuthorize(approve(scope.includes(N)),env(o));expect(res.status).toBe(302);expect(o.approveConsent.mock.calls[0][2]).not.toHaveProperty('scope');expect(o.beginUpstream.mock.calls[0][0].scope).toEqual(scope.length?scope:[R]);});
 it('adds news to an existing registry client only after explicit optional selection',async()=>{const o=provider([R]);const res=await handleAuthorize(approve(true),env(o));expect(res.status).toBe(302);expect(o.beginUpstream.mock.calls[0][0].scope).toEqual([R,N]);});
 it('rejects a missing checkbox without starting upstream',async()=>{const o=provider([N]);expect((await handleAuthorize(approve(false),env(o))).status).toBe(400);expect(o.beginUpstream).not.toHaveBeenCalled();});
 it('does not grant unknown scopes',async()=>{const o=provider(['admin']);expect((await handleAuthorize(new Request('https://mcp.test/authorize'),env(o))).status).toBe(400);expect(o.beginConsent).not.toHaveBeenCalled();expect(()=>requestedScopes(['admin'])).toThrow();});
 it.each(['staff','consultant'])('denies news to %s without grant',async(role)=>{const o=provider([N]);const res=await handleSession(session(),env(o),{fetchImpl:async()=>Response.json({result:{uid:'u',role,canExportAndImport:true}})});expect(res.status).toBe(403);expect(o.completeAuthorization).not.toHaveBeenCalled();});
 it('binds a new admin grant to the consent receipt and exact scopes',async()=>{const o=provider([N]);expect((await handleSession(session(),env(o),{fetchImpl:async()=>Response.json({result:{uid:'u',role:'admin',canExportAndImport:true}})})).status).toBe(200);const g=o.completeAuthorization.mock.calls[0][0];expect(g.scope).toEqual([N]);expect(g.props.grantedScopes).toEqual([N]);expect(g.props.newsConsentVersion).toBe(NEWS_CONSENT_VERSION);});
 it('never derives news from old props or a downscoped token',()=>{const p={grantedScopes:[N],newsConsentVersion:NEWS_CONSENT_VERSION};expect(scopedAccess(p,[N])).toEqual({canReadNews:true,canReadRegistry:false});expect(scopedAccess(p,[R]).canReadNews).toBe(false);expect(scopedAccess({},[R,N]).canReadNews).toBe(false);expect(scopedAccess(p,undefined).canReadNews).toBe(false);});
});
