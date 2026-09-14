import { execFileSync } from 'node:child_process';

// Creates a paused job only. Resume after the canonical deployment passes its runtime checks.
const parent = 'projects/inner-platform-live-20260316/locations/us-central1';
const name = `${parent}/jobs/myscube-settlement-agent`;
try {
  const secret = process.env.SETTLEMENT_AGENT_WORKER_SECRET;
  if (!/^[a-f0-9]{64}$/.test(secret || '')) throw new Error('missing_secret');
  const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const request = async (path, method, body) => {
    const response = await fetch(`https://cloudscheduler.googleapis.com/v1/${path}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`scheduler_http_${response.status}`);
  };
  await request(`${parent}/jobs`, 'POST', { name, description: 'MYSCube settlement agent only; pause before rollback or maintenance.',
    schedule: '0 0 1 1 *', timeZone: 'Asia/Seoul', attemptDeadline: '300s', retryConfig: { retryCount: 0 },
    httpTarget: { uri: 'https://myscube.myscguard.app/api/internal/workers/settlement-agent/run', httpMethod: 'GET',
      headers: { Authorization: `Bearer ${secret}` } } });
  await request(`${name}:pause`, 'POST');
  await request(`${name}?updateMask=schedule`, 'PATCH', { name, schedule: '* * * * *' });
  console.log(JSON.stringify({ name, state: 'PAUSED' }));
} catch (error) {
  console.error(/^scheduler_http_\d+$/.test(error.message) ? error.message : 'Scheduler setup failed; details suppressed.');
  process.exitCode = 1;
}
