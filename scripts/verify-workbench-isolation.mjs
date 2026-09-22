import { mintFirebaseCanaryIdToken } from './verify-cashflow-settlement-candidate.mjs';

const env = process.env;
const candidate = new URL(env.SETTLEMENT_CANARY_BASE_URL).origin;
const canonical = 'https://myscube.myscguard.app';
const baselineOrigin = env.WORKBENCH_BASELINE_HOST ? `https://${env.WORKBENCH_BASELINE_HOST}` : canonical;
if (baselineOrigin !== canonical && !/^https:\/\/[a-zA-Z0-9-]+\.vercel\.app$/.test(baselineOrigin)) throw new Error('Invalid verified baseline deployment host.');
const token = await mintFirebaseCanaryIdToken({ firebaseWebApiKey: env.SETTLEMENT_CANARY_FIREBASE_WEB_API_KEY,
  firebaseRefreshToken: env.SETTLEMENT_CANARY_FIREBASE_REFRESH_TOKEN, actorUid: env.SETTLEMENT_CANARY_ACTOR_UID });
const read = async (origin, path) => {
  const started = performance.now();
  const response = await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}`, origin: canonical,
    'x-tenant-id': 'mysc', 'x-vercel-protection-bypass': env.VERCEL_AUTOMATION_BYPASS_SECRET },
    redirect: 'error', signal: AbortSignal.timeout(25000) });
  const body = await response.json().catch(() => null);
  return { status: response.status, ms: Math.round(performance.now() - started), body };
};
const paths = ['/api/v1/health', '/api/v1/projects?limit=1', '/api/v1/project-registration-drafts', '/api/v1/project-requests/assigned-to-me'];
const evidence = [];
for (const path of paths) {
  const before = await read(baselineOrigin, path);
  const after = await read(candidate, path);
  const valid = (result) => path === '/api/v1/health' ? result.body?.ok === true && result.body?.authMode === 'firebase_required' : path === '/api/v1/project-registration-drafts' ? Array.isArray(result.body?.drafts) : Array.isArray(result.body?.items);
  if (before.status !== 200 || after.status !== 200 || !valid(before) || !valid(after)) throw new Error(`Existing read canary failed: ${path} baseline=${before.status} candidate=${after.status}`);
  evidence.push({ path, baselineMs: before.ms, candidateMs: after.ms });
}
const capabilities = await read(candidate, '/api/v1/workbench-assistant/capabilities');
if (capabilities.status !== 200 || capabilities.body?.manualPages !== true) throw new Error('Workbench capabilities unavailable.');
if (capabilities.body.modelEnabled !== (env.PRODUCT_WORKBENCH_AI_ENABLED === 'true')) throw new Error('Admin Workbench AI activation does not match deployment setting.');
// One bounded new read overlaps existing business reads; never submits or approves a business record.
const concurrent = read(candidate, `/api/v1/cashflow-evidence?yearMonth=${encodeURIComponent(env.SETTLEMENT_CANARY_CYCLE_YEAR_MONTH)}`).catch(() => ({ status: 0, ms: 25000 }));
for (const baseline of evidence) {
  const during = await read(candidate, baseline.path);
  if (during.status !== 200 || during.ms > Math.max(5000, baseline.baselineMs * 3 + 1000)) {
    throw new Error(`Existing read regressed under Workbench load: ${baseline.path} status=${during.status} ms=${during.ms}`);
  }
  baseline.duringMs = during.ms;
}
const newRead = await concurrent;
const expectedReadStatus = env.PRODUCT_WORKBENCH_READS_ENABLED === 'true' ? 200 : 503;
if (newRead.status !== expectedReadStatus || (expectedReadStatus === 503 && newRead.body?.error !== 'workbench_reads_disabled')) throw new Error(`Workbench read failed: ${newRead.status}`);
console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), businessWrites: 0, evidence,
  newRead: { status: newRead.status, ms: newRead.ms }, canaryActorModelEnabled: capabilities.body.modelEnabled, note: 'Bounded smoke, not peak load proof. AI provider verified separately using synthetic evidence.' }));
