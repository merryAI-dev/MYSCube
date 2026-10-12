export const REMINDER_SCHEDULER_NAME = 'myscube-settlement-reminders-weekly';
export const REMINDER_SCHEDULER_LOCATION = 'us-central1';
export const REMINDER_SCHEDULER_PROJECT = 'inner-platform-live-20260316';

export function buildSettlementReminderScheduler({ workerSecret }) {
  if (!/^[a-f0-9]{64}$/.test(workerSecret || '')) throw new Error('missing_worker_secret');
  const parent = `projects/${REMINDER_SCHEDULER_PROJECT}/locations/${REMINDER_SCHEDULER_LOCATION}`;
  return {
    parent,
    job: {
      name: `${parent}/jobs/${REMINDER_SCHEDULER_NAME}`,
      description: 'Paused-by-default weekly settlement reminder; distinct from settlement-agent recovery.',
      schedule: '0 0 * * 5',
      timeZone: 'Asia/Seoul',
      attemptDeadline: '300s',
      retryConfig: { retryCount: 0 },
      httpTarget: {
        uri: 'https://mysc-slack-agent.vercel.app/api/internal/workers/settlement-reminders/run',
        httpMethod: 'GET',
        headers: { Authorization: `Bearer ${workerSecret}` },
      },
    },
  };
}
