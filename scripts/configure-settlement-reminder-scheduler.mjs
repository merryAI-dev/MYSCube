import { execFileSync } from 'node:child_process';
import { buildSettlementReminderScheduler } from '../server/mcp/settlement-reminder-scheduler.mjs';

// Creates a separate PAUSED job. Running this script is an explicitly approved
// production operation; committing it does not create or resume any resource.
try {
  const { parent, job } = buildSettlementReminderScheduler({
    workerSecret: process.env.SETTLEMENT_AGENT_WORKER_SECRET,
  });
  const token = execFileSync('gcloud', ['auth', 'print-access-token'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const request = async (path, method, body) => {
    const response = await fetch(`https://cloudscheduler.googleapis.com/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`scheduler_http_${response.status}`);
  };
  await request(`${parent}/jobs`, 'POST', job);
  await request(`${job.name}:pause`, 'POST');
  console.log(JSON.stringify({ name: job.name, state: 'PAUSED' }));
} catch (error) {
  console.error(/^scheduler_http_\d+$/.test(error.message) ? error.message : 'Reminder scheduler setup failed; details suppressed.');
  process.exitCode = 1;
}
