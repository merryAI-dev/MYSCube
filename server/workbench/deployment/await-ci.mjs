import { execFileSync } from 'node:child_process';

const sha = process.env.RELEASE_SHA;
const repository = 'merryAI-dev/MYSCube';
const branch = 'feat/axr-isolated-workbench-complete';
if (!/^[a-f0-9]{40}$/.test(sha || '') || process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== `refs/heads/${branch}`) throw new Error('Unapproved deployment source');
const deadline = Date.now() + 35 * 60_000;
const commandOptions = { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 };
for (;;) {
  const head = execFileSync('git', ['ls-remote', 'origin', `refs/heads/${branch}`], commandOptions).trim().split(/\s+/)[0];
  if (head !== sha) throw new Error('Deployment source was superseded');
  const { workflow_runs: runs } = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`], commandOptions));
  const selected = [['CI', '.github/workflows/ci.yml'], ['Workbench CI', '.github/workflows/workbench-ci.yml']].map(([name, path]) => runs.filter(run => run.name === name && run.path === path && run.head_sha === sha && run.head_branch === branch && run.head_repository?.full_name === repository && run.event === 'push').sort((a, b) => b.id - a.id)[0]);
  if (selected.some(run => run?.status === 'completed' && run.conclusion !== 'success')) throw new Error('Required CI did not succeed');
  if (selected.every(run => run?.status === 'completed' && run.conclusion === 'success')) {
    console.log(JSON.stringify({ sourceSha: sha, ci: selected.map(run => ({ name: run.name, id: run.id, conclusion: run.conclusion })) }));
    break;
  }
  if (Date.now() >= deadline) throw new Error('Timed out waiting for exact-source CI');
  console.log('Waiting for General and Workbench CI on the exact source SHA');
  await new Promise(resolve => setTimeout(resolve, 20_000));
}
