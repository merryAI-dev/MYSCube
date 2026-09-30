import { assertBffRuntimeSafety, resolveBffRuntimeSafetyConfig } from '../server/bff/runtime-safety.mjs';

export function slackServiceEnvironment(source, { origin, sha, workerSecret }) {
  if (origin !== 'https://mysc-slack-agent.vercel.app' || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid Slack service identity');
  const allowed = `${origin},https://myscube.myscguard.app`;
  // Only the Slack recovery worker is exposed by this service's route boundary.
  const result = { ...source, CRON_SECRET: workerSecret, BFF_ALLOWED_ORIGINS: allowed, BFF_LIVE_ALLOWED_ORIGINS: allowed,
    MERRYHERE_CONNECT_ORIGIN: origin, SLACK_SERVICE_RELEASE: sha,
    PRODUCT_WORKBENCH_READS_ENABLED: 'false', PRODUCT_WORKBENCH_AI_ENABLED: 'false' };
  assertBffRuntimeSafety(resolveBffRuntimeSafetyConfig({ projectId: 'inner-platform-live-20260316', allowedOrigins: allowed.split(',') },
    { ...result, BFF_DEPLOY_ENV: 'live', BFF_SCHEDULER_OWNER: 'vercel', BFF_LIVE_FIREBASE_PROJECT_ID: 'inner-platform-live-20260316' }));
  return result;
}
