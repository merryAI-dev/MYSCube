import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { deployVercelProductionCandidate } from './deploy-vercel-production-candidate.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Only main GitHub Actions may deploy');
const env = process.env;
const name = 'mysc-slack-agent';
const origin = `https://${name}.vercel.app`;
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (sha !== env.TARGET_SHA) throw new Error('Deployment SHA mismatch');
const api = async (path, method = 'GET', body) => {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`https://api.vercel.com${path}${separator}teamId=${env.VERCEL_ORG_ID}`, {
    method, headers: { authorization: `Bearer ${env.VERCEL_TOKEN}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw new Error(`Vercel ${method} ${path.split('?')[0]} failed: ${response.status}`);
  return response.json();
};
let project = await api(`/v9/projects/${name}`);
if (!project) project = await api('/v11/projects', 'POST', { name, framework: null });
if (project.id === env.VERCEL_PROJECT_ID) throw new Error('Must not deploy over the website project');
await api(`/v9/projects/${project.id}`, 'PATCH', { ssoProtection: null, framework: null });
// Copy only the existing server configuration; credentials never leave this runner or Vercel.
const source = await api(`/v9/projects/${env.VERCEL_PROJECT_ID}/env?target=production`);
const selected = source.envs.filter(item => /^(FIREBASE_|BFF_|JVM_|SETTLEMENT_|MERRYHERE_|GOOGLE_CALENDAR_ROOMS_JSON$)/.test(item.key));
const copied = {};
for (const item of selected) {
  const value = await api(`/v1/projects/${env.VERCEL_PROJECT_ID}/env/${item.id}`);
  if (typeof value?.value !== 'string') throw new Error(`Cannot transfer server setting ${item.key}`);
  copied[item.key] = value.value;
}
if (!copied.FIREBASE_SERVICE_ACCOUNT_JSON && !copied.FIREBASE_SERVICE_ACCOUNT_BASE64) throw new Error('Existing Firestore credentials unavailable');
Object.assign(copied, { BFF_ALLOWED_ORIGINS: `${origin},https://myscube.myscguard.app`, MERRYHERE_CONNECT_ORIGIN: origin,
  SLACK_SERVICE_RELEASE: sha, PRODUCT_WORKBENCH_READS_ENABLED: 'false', PRODUCT_WORKBENCH_AI_ENABLED: 'false' });
await api(`/v10/projects/${project.id}/env?upsert=true`, 'POST', Object.entries(copied).map(([key, value]) => ({ key, value, type: 'encrypted', target: ['production'] })));
mkdirSync('.vercel', { recursive: true });
writeFileSync('.vercel/project.json', JSON.stringify({ projectId: project.id, orgId: env.VERCEL_ORG_ID }));
env.VERCEL_PROJECT_ID = project.id;
env.BFF_ALLOWED_ORIGINS = copied.BFF_ALLOWED_ORIGINS;
writeFileSync('api/bff.js', "export { default } from '../server/mcp/slack-service-entry.mjs';\n");
rmSync('api/static-asset-not-found.js');
writeFileSync('vercel.json', JSON.stringify({ version: 2, framework: null, buildCommand: 'mkdir -p slack-dist', outputDirectory: 'slack-dist',
  functions: { 'api/bff.js': { maxDuration: 300, regions: ['iad1'] } },
  rewrites: [{ source: '/:path*', destination: '/api/bff?__path=/:path*' }],
}));
const deployment = await deployVercelProductionCandidate({ sourceDir: process.cwd(), commitSha: sha, invocation: `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`, maintenance: false });
const identity = await api(`/v13/deployments/${deployment.deploymentHost}`);
if (identity.projectId !== project.id || identity.meta?.githubCommitSha !== sha) throw new Error('Candidate identity mismatch');
function verify(base) {
  execFileSync('node', ['scripts/check-settlement-runtime.mjs'], { env: { ...env, SETTLEMENT_CANARY_BASE_URL: base }, stdio: 'inherit' });
}
verify(deployment.deploymentUrl);
for (const path of ['/api/v1/projects', '/api/v1/health', '/']) {
  const response = await fetch(`${deployment.deploymentUrl}${path}`, { redirect: 'manual' });
  if (response.status !== 404) throw new Error(`Unrelated route exposed: ${path}`);
}
const latestMain = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { encoding: 'utf8' }).split(/\s+/)[0];
if (latestMain !== sha) {
  console.log('Newer main exists; candidate not promoted.');
  process.exit(0);
}
const prior = await api(`/v4/aliases/${name}.vercel.app`);
try {
  await api(`/v2/deployments/${identity.id}/aliases`, 'POST', { alias: `${name}.vercel.app` });
  verify(origin);
  const health = await (await fetch(`${origin}/healthz`)).json();
  if (health.release !== sha || health.service !== name) throw new Error('Stable service identity mismatch');
} catch (error) {
  const oldId = prior?.deployment?.id || prior?.deploymentId;
  if (oldId) await api(`/v2/deployments/${oldId}/aliases`, 'POST', { alias: `${name}.vercel.app` });
  throw error;
}
console.log(JSON.stringify({ origin, release: sha, projectId: project.id, businessWrites: false }));
writeFileSync(process.env.GITHUB_STEP_SUMMARY, `Slack service deployed: ${origin}\n\nRelease: ${sha}\n\nSigned ingress, interaction authentication, worker authentication and route isolation checks passed. Slack app URLs must be checked separately.\n`);
