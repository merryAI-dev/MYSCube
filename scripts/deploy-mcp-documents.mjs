import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageDocumentService } from './stage-mcp-documents.mjs';

const env = process.env;
if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Only main GitHub Actions may deploy');
for (const key of ['TARGET_SHA', 'VERCEL_TOKEN', 'VERCEL_ORG_ID', 'MCP_DOCUMENTS_ORIGIN', 'VERCEL_PROJECT_ID']) {
  if (!env[key]) throw new Error(`${key} is required`);
}
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (sha !== env.TARGET_SHA || !/^[a-f0-9]{40}$/u.test(sha)) throw new Error('Deployment SHA mismatch');
if (execFileSync('git', ['log', '-1', '--format=%ae'], { encoding: 'utf8' }).trim() !== 'ai@mysc.co.kr') throw new Error('Deployment author policy failed');
if (env.MCP_DOCUMENTS_PROJECT_ID === env.VERCEL_PROJECT_ID) throw new Error('Document service must not use the website project');
const origin = new URL(env.MCP_DOCUMENTS_ORIGIN);
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid document origin');
const api = async (path, method = 'GET', body) => {
  const response = await fetch(`https://api.vercel.com${path}?teamId=${encodeURIComponent(env.VERCEL_ORG_ID)}`, {
    method, headers: { authorization: `Bearer ${env.VERCEL_TOKEN}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw new Error(`Vercel ${method} failed: ${response.status}`);
  return response.json();
};
const projectName = 'myscube-mcp-documents';
let project = await api(`/v9/projects/${encodeURIComponent(env.MCP_DOCUMENTS_PROJECT_ID || projectName)}`);
if (!project && env.MCP_DOCUMENTS_PROVISION_APPROVED === 'true' && origin.origin === `https://${projectName}.vercel.app` && !env.MCP_DOCUMENTS_PROJECT_ID) {
  project = await api('/v11/projects', 'POST', { name: projectName, framework: null, ssoProtection: null });
}
if (!project || (env.MCP_DOCUMENTS_PROJECT_ID && project.id !== env.MCP_DOCUMENTS_PROJECT_ID) || project.name !== projectName || project.id === env.VERCEL_PROJECT_ID || project.rootDirectory) throw new Error('Wrong project or non-isolated root directory');
const environment = await api(`/v9/projects/${project.id}/env`);
if (!environment || (environment.envs || []).some((item) => /FIREBASE.*(SECRET|ACCOUNT|PRIVATE)|JVM_|SETTLEMENT_|OPENAI_|GEMINI_|ANTHROPIC_/u.test(item.key))) {
  throw new Error('Document service must not inherit business or inference credentials');
}
const directory = join(await mkdtemp(join(tmpdir(), 'myscube-documents-deploy-')), 'source');
await stageDocumentService(directory);
await mkdir(join(directory, '.vercel'));
await writeFile(join(directory, '.vercel/project.json'), JSON.stringify({ projectId: project.id, orgId: env.VERCEL_ORG_ID }));
const output = execFileSync('npx', ['--yes', 'vercel@50.14.0', 'deploy', '--prod', '--yes', '--skip-domain',
  '--token', env.VERCEL_TOKEN, '--scope', 'merryai-devs-projects', '--env', `RELEASE_SHA=${sha}`,
  '--meta', `githubCommitSha=${sha}`], {
  cwd: directory,
  env: { ...env, VERCEL_PROJECT_ID: project.id, VERCEL_ORG_ID: env.VERCEL_ORG_ID },
  encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});
const candidate = output.match(/https:\/\/[A-Za-z0-9.-]+\.vercel\.app/gu)?.at(-1);
if (!candidate) throw new Error('Missing candidate URL');
const deployment = await api(`/v13/deployments/${new URL(candidate).host}`);
if (deployment?.projectId !== project.id || deployment.meta?.githubCommitSha !== sha) throw new Error('Wrong candidate identity');
async function verify(base, protectedCandidate = false) {
  const headers = protectedCandidate && env.VERCEL_AUTOMATION_BYPASS_SECRET ? { 'x-vercel-protection-bypass': env.VERCEL_AUTOMATION_BYPASS_SECRET } : {};
  const health = await fetch(`${base}/healthz`, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!health.ok) throw new Error(`Document readiness failed: ${health.status}`);
  const body = await health.json();
  if (body.service !== 'myscube-mcp-documents' || body.release !== sha || body.renderer !== 'ready') throw new Error('Document readiness identity mismatch');
  for (const [path, status] of [
    ['/api/v1/projects', 404], ['/api/v1/cashflow/p1', 404],
    ['/api/v1/projects/p1/attachments/contract/text?format=image&page=1', 401],
  ]) {
    const response = await fetch(`${base}${path}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (response.status !== status) throw new Error(`Document route isolation failed: ${path}`);
  }
}
await verify(candidate, true);
const main = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { encoding: 'utf8' }).split(/\s/u)[0];
if (main !== sha) throw new Error('main advanced; candidate not promoted');
const aliases = await api(`/v9/projects/${project.id}/domains`);
if (!(aliases?.domains || []).some((domain) => domain.name === origin.hostname)) throw new Error('Stable domain must already belong to document project');
const previous = await api(`/v4/aliases/${origin.hostname}`);
const previousId = previous?.deployment?.id || previous?.deploymentId;
if (previousId) {
  const previousDeployment = await api(`/v13/deployments/${previousId}`);
  if (previousDeployment?.projectId !== project.id) throw new Error('Stable alias points outside document service');
}
try {
  await api(`/v2/deployments/${deployment.id}/aliases`, 'POST', { alias: origin.hostname });
  for (let attempt = 0; ; attempt++) {
    try { await verify(origin.origin); break; }
    catch (error) {
      if (attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
} catch (error) {
  if (previousId) await api(`/v2/deployments/${previousId}/aliases`, 'POST', { alias: origin.hostname });
  throw error;
}
console.log(JSON.stringify({ service: 'myscube-mcp-documents', projectId: project.id, origin: origin.origin, release: sha, renderer: 'ready' }));
