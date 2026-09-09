import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GoogleAuth } from 'google-auth-library';

const PROJECT = 'inner-platform-live-20260316';
const PREFIX = `projects/${PROJECT}`;
const RELEASE = `${PREFIX}/releases/cloud.firestore`;
const FILE = 'firebase/firestore.rules';
const SHA = /^[0-9a-f]{40}$/;

function filesOf(ruleset) {
  const files = ruleset?.source?.files;
  if (files?.length !== 1 || files[0].name !== FILE || !files[0].content?.trim()) {
    throw new Error('Unexpected Firestore rules source; refusing to publish.');
  }
  return [{ name: FILE, content: files[0].content }];
}

function rulesetName(name) {
  if (typeof name !== 'string' || !name.startsWith(`${PREFIX}/rulesets/`)
    || !/^[a-zA-Z0-9-]+$/.test(name.slice(`${PREFIX}/rulesets/`.length))) {
    throw new Error('Invalid production ruleset name.');
  }
  return name;
}

export async function prepareRules({ request, baseline, target, baseSha, targetSha }) {
  if (!SHA.test(baseSha) || !SHA.test(targetSha) || !baseline.trim() || !target.trim()) {
    throw new Error('Missing verified deployment baseline or target.');
  }
  const release = await request('GET', RELEASE);
  if (release.name !== RELEASE) throw new Error('Unexpected Firestore release.');
  const oldName = rulesetName(release.rulesetName);
  const source = filesOf(await request('GET', oldName));
  if (source[0].content !== target && source[0].content !== baseline) {
    throw new Error('Live Firestore rules drifted from deployed BFF; manual review required.');
  }
  return { project: PROJECT, release: RELEASE, oldName, source, baseSha, targetSha,
    target: [{ name: FILE, content: target }] };
}

export async function publishRules({ request, plan }) {
  if (plan.project !== PROJECT || plan.release !== RELEASE
    || !SHA.test(plan.baseSha) || !SHA.test(plan.targetSha)) throw new Error('Invalid rules deployment plan.');
  rulesetName(plan.oldName);
  filesOf({ source: { files: plan.source } });
  filesOf({ source: { files: plan.target } });
  const current = await request('GET', RELEASE);
  const currentSource = filesOf(await request('GET', rulesetName(current.rulesetName)));
  if (currentSource[0].content === plan.target[0].content) return { unchanged: true, rulesetName: current.rulesetName };
  if (current.name !== RELEASE || current.rulesetName !== plan.oldName
    || currentSource[0].content !== plan.source[0].content) throw new Error('Rules changed after backup; refusing to publish.');
  const created = await request('POST', `${PREFIX}/rulesets`, { source: { files: plan.target } });
  const nextName = rulesetName(created.name);
  // Rules releases have no CAS field; CI shares one lock and rechecks immediately before publication.
  if ((await request('GET', RELEASE)).rulesetName !== plan.oldName) throw new Error('Rules changed before publication.');
  try {
    await request('PATCH', RELEASE, { release: { name: RELEASE, rulesetName: nextName } });
  } catch {
    // A lost response does not prove the update failed; the release readback is authoritative.
  }
  const actual = await request('GET', RELEASE);
  const actualSource = filesOf(await request('GET', rulesetName(actual.rulesetName)));
  if (actual.name !== RELEASE || actual.rulesetName !== nextName
    || actualSource[0].content !== plan.target[0].content) throw new Error('Published rules verification failed.');
  return { unchanged: false, rulesetName: nextName };
}

async function main() {
  const [mode, planPath] = process.argv.slice(2);
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'merryAI-dev/MYSCube'
    || process.env.GITHUB_REF !== 'refs/heads/main' || !['prepare', 'publish'].includes(mode) || !planPath) {
    throw new Error('Production rules publishing is restricted to main CI.');
  }
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const request = async (method, path, body) => {
    const headers = await client.getRequestHeaders();
    const response = await fetch(`https://firebaserules.googleapis.com/v1/${path}`, {
      method, headers: { ...headers, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Firestore rules ${method} failed (${response.status}).`);
    return response.json();
  };
  const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (mode === 'prepare') {
    const baseSha = process.env.BFF_DEPLOYED_SHA;
    if (!SHA.test(baseSha || '')) throw new Error('Invalid deployed BFF SHA.');
    execFileSync('git', ['merge-base', '--is-ancestor', baseSha, targetSha]);
    const baseline = execFileSync('git', ['show', `${baseSha}:${FILE}`], { encoding: 'utf8' });
    const plan = await prepareRules({ request, baseline, target: readFileSync(FILE, 'utf8'), baseSha, targetSha });
    writeFileSync(planPath, JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`Rules backup prepared: ${plan.oldName}`);
  } else {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    if (plan.targetSha !== targetSha || plan.target?.[0]?.content !== readFileSync(FILE, 'utf8')) {
      throw new Error('Rules plan does not match checked-out deployment.');
    }
    console.log(JSON.stringify(await publishRules({ request, plan })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Firestore rules deployment failed; inspect backup and live release before retrying.'); process.exitCode = 1; });
}
