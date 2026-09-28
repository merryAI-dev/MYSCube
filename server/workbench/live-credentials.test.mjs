import { describe, it, expect } from 'vitest';
import { createLiveCredentialLease } from './live-credentials.mjs';
const context = { tenantId: 'tenant', actorId: 'actor', analyticsScope: { fingerprint: 'scope' } };
const claims = { uid: 'actor', exp: 1000 };
describe('private live credential lease', () => {
 it('never adds credentials to a serializable context and revalidates per use', async () => {
  let calls = 0; const lease = createLiveCredentialLease({ now: () => 1000, verifyToken: async () => { calls++; return claims; } });
  lease.accept(context, 'Bearer canary-secret', claims, lease.begin());
  expect(await lease.get({ ...context })).toBe('Bearer canary-secret'); expect(calls).toBe(1);
  expect(JSON.stringify(context)).not.toContain('canary');
  await expect(lease.get({ ...context, actorId: 'other' })).rejects.toMatchObject({statusCode:401});
  await expect(lease.get({ ...context, analyticsScope: { fingerprint: 'other' } })).rejects.toMatchObject({statusCode:401});
 });
 it('rejects expiry, revocation and malformed identities without disclosing the token', async () => {
  let time = 1000, revoked = false;
  const lease = createLiveCredentialLease({now:()=>time, verifyToken:async()=>{if(revoked)throw Error('canary-secret');return claims;}});
  lease.accept(context, 'Bearer canary-secret', claims, lease.begin()); time += 60001;
  await expect(lease.get(context)).rejects.toMatchObject({code:'myscube_live_auth_required'});
  lease.accept(context, 'Bearer canary-secret', claims, lease.begin()); revoked=true;
  await expect(lease.get(context)).rejects.toThrow(/로그인/);
  revoked=false; await expect(lease.get(context)).rejects.toMatchObject({statusCode:401});
  expect(()=>lease.accept(context,'Bearer token',{...claims,uid:'other'},lease.begin())).toThrow();
 });
 it('an older verified request cannot overwrite a newer token or return it after rotation', async()=>{
  let finish; const lease=createLiveCredentialLease({now:()=>1000,verifyToken:()=>new Promise(r=>finish=r)});
  const old=lease.begin(), fresh=lease.begin(); lease.accept(context,'Bearer fresh',claims,fresh);lease.accept(context,'Bearer old',claims,old);
  const pending=lease.get(context); lease.accept(context,'Bearer freshest',claims,lease.begin());finish(claims);
  await expect(pending).rejects.toMatchObject({statusCode:401});
 });
 it('bounds the number of independent leases and explicitly revokes all actor scopes',async()=>{
  const lease=createLiveCredentialLease({capacity:1,now:()=>1000,verifyToken:async()=>claims});
  lease.accept(context,'Bearer token',claims,lease.begin());
  expect(()=>lease.accept({...context,analyticsScope:{fingerprint:'next'}},'Bearer token',claims,lease.begin())).toThrow();
  lease.revoke(context);await expect(lease.get(context)).rejects.toMatchObject({statusCode:401});
 });
});

it('keeps a pending verification valid across a same-token refresh but not past expiry', async () => {
 let time=1000, finish;
 const lease=createLiveCredentialLease({now:()=>time,verifyToken:()=>new Promise(resolve=>finish=resolve)});
 lease.accept(context,'Bearer token',claims,lease.begin());
 const request=lease.get(context);lease.accept(context,'Bearer token',claims,lease.begin());finish(claims);
 await expect(request).resolves.toBe('Bearer token');
 const expired=lease.get(context);time+=60001;finish(claims);
 await expect(expired).rejects.toMatchObject({statusCode:401});
});
