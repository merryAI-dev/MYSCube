import { createHttpError } from '../bff/bff-utils.mjs';

const denied = () => createHttpError(401, '실시간 자료 조회를 위해 로그인 상태를 다시 확인해 주세요.', 'myscube_live_auth_required');
const identity = context => JSON.stringify([context.tenantId, context.actorId, context.analyticsScope?.fingerprint]);
export function createLiveCredentialLease({ verifyToken, now = Date.now, ttlMs = 60000, capacity = 100 }) {
  const leases = new Map();
  let sequence = 0;
  const begin = () => ++sequence;
  const prune = () => { for (const [key, lease] of leases) if (lease.expiresAt <= now()) leases.delete(key); };
  return {
    begin,
    accept(context, bearer, claims, ticket) {
      prune();
      if (!/^Bearer [^\s]{1,16384}$/.test(bearer || '') || claims?.uid !== context.actorId || !context.analyticsScope?.fingerprint || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now()) throw denied();
      const key = identity(context), prior = leases.get(key);
      if (prior && prior.ticket >= ticket) return;
      if (!prior && leases.size >= capacity) throw createHttpError(429, '실시간 조회 요청이 많습니다. 잠시 후 다시 시도해 주세요.', 'myscube_live_busy');
      const expiresAt = Math.min(claims.exp * 1000, now() + ttlMs);
      if (prior?.bearer === bearer) Object.assign(prior, { ticket, expiresAt });
      else leases.set(key, { bearer, ticket, expiresAt });
    },
    async get(context) {
      prune();
      const key = identity(context), lease = leases.get(key);
      if (!lease || typeof verifyToken !== 'function') throw denied();
      let claims;
      try { claims = await verifyToken(lease.bearer); }
      catch { if (leases.get(key) === lease) leases.delete(key); throw denied(); }
      if (claims?.uid !== context.actorId || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now() || lease.expiresAt <= now() || leases.get(key) !== lease) throw denied();
      return lease.bearer;
    },
    revoke(context) { for (const [key] of leases) { const [tenant, actor] = JSON.parse(key); if (tenant === context.tenantId && actor === context.actorId) leases.delete(key); } },
    clear() { leases.clear(); },
  };
}
