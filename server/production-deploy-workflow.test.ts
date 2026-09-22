import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildVercelProductionDeployArgs } from '../scripts/deploy-vercel-production-candidate.mjs';
import { classifyCashflowSettlementProductionRelease } from '../scripts/verify-cashflow-settlement-release-boundary.mjs';

const env = {
  LIVE_FIREBASE_PROJECT_ID: 'live-project',
  BFF_DEPLOY_ENV: 'live',
  BFF_AUTH_MODE: 'firebase_required',
  BFF_EDIT_LEASES_ENABLED: 'true',
  BFF_ALLOWED_ORIGINS: 'https://myscube.myscguard.app',
  JVM_WEEKLY_FIRESTORE_PROJECT_ID: 'live-project',
  JVM_WEEKLY_AUTH_MODE: 'strict',
  JVM_WEEKLY_API_BASE_URL: 'https://candidate.example.test',
  JVM_WEEKLY_API_ID_TOKEN_AUDIENCE: 'https://service.example.test',
  JVM_WEEKLY_INTERNAL_API_TOKEN: 'internal-token',
  JVM_WEEKLY_API_SERVICE_ACCOUNT_JSON: '{}',
  SLACK_ALERT_BOT_TOKEN: 'slack-token',
  SLACK_ALERT_CHANNEL_ID: 'channel',
  VERCEL_TOKEN: 'vercel-token',
  VERCEL_ORG_ID: 'team',
  VERCEL_PROJECT_ID: 'project',
  VERCEL_CLI_PACKAGE: 'vercel@50.14.0',
};

describe('production deployment decisions', () => {
  it('isolates agent credentials from the shared Gemini key', () => {
    const deployment = buildVercelProductionDeployArgs({ sourceDir: '/tmp/agent', commitSha: 'a'.repeat(40), invocation: '1-1', maintenance: false,
      env: { ...env, SETTLEMENT_AGENT_ENABLED: 'true', SLACK_SIGNING_SECRET: 'signature', SETTLEMENT_AGENT_GEMINI_API_KEY: 'agent-key', SETTLEMENT_AGENT_WORKER_SECRET: 'worker-key' } });
    expect(deployment.args).toContain('SETTLEMENT_AGENT_GEMINI_API_KEY=agent-key');
    expect(deployment.args).toContain('SETTLEMENT_AGENT_WORKER_SECRET=worker-key');
    expect(deployment.args.some((arg: string) => arg.startsWith('GEMINI_API_KEY='))).toBe(false);
  });
  it.each([false, true])('isolates Workbench activation with settlement enabled=%s', (settlement) => {
    for (const workbench of [false, true]) for (const maintenance of [false, true]) {
      const deployment = buildVercelProductionDeployArgs({ sourceDir: '/tmp/agent', commitSha: 'a'.repeat(40), invocation: '1-1', maintenance,
        env: { ...env, SETTLEMENT_AGENT_ENABLED: String(settlement), PRODUCT_WORKBENCH_AI_ENABLED: String(workbench), SLACK_SIGNING_SECRET: 'signature', SETTLEMENT_AGENT_GEMINI_API_KEY: 'agent-key', SETTLEMENT_AGENT_WORKER_SECRET: 'worker-key' } });
      expect(deployment.args).toContain(`PRODUCT_WORKBENCH_AI_ENABLED=${workbench && !maintenance}`);
      expect(deployment.args).toContain(`SETTLEMENT_AGENT_ENABLED=${settlement && !maintenance}`);
      expect(deployment.args.includes('SETTLEMENT_AGENT_GEMINI_API_KEY=agent-key')).toBe(settlement || workbench);
      expect(deployment.args.includes('SLACK_SIGNING_SECRET=signature')).toBe(settlement);
    }
  });
  it('requires Workbench isolation on every web release before alias promotion', () => {
    const workflow = readFileSync('.github/workflows/production-deploy.yml', 'utf8');
    const gate = workflow.split('- name: Verify Workbench isolation before alias')[1].split('- name: Promote canonical production alias')[0];
    expect(gate).toContain("if: steps.release_mode.outputs.release_mode == 'web'");
    expect(gate).not.toContain('settlement_cutover');
    expect(gate).toContain('node scripts/verify-workbench-isolation.mjs');
    expect(gate).toContain('steps.previous_alias.outputs.deployment_host');
  });
  it('keeps the reviewed active September request in the read-only cutover inventory', () => {
    const workflow = readFileSync('.github/workflows/production-deploy.yml', 'utf8');
    const inventoryStep = workflow.split('- name: Verify settlement-cycle cutover inventory')[1].split('- name: Deploy to Vercel production')[0];
    expect(inventoryStep).toContain('p1779869011617');
    expect(inventoryStep).toContain('--verify-cutover');
    expect(inventoryStep).not.toMatch(/--apply\b/);
  });
  it('runs the settlement behavior canary only against the verified direct deployment', () => {
    const workflow = readFileSync('.github/workflows/production-deploy.yml', 'utf8');
    expect(workflow.match(/node scripts\/verify-cashflow-settlement-candidate\.mjs/g)).toHaveLength(1);
  });

  it('classifies web and JVM changes against their own deployed baselines', () => {
    const workflow = readFileSync('.github/workflows/production-deploy.yml', 'utf8');
    const classification = workflow.split('- name: Classify Production release mode')[1]
      .split('- name: Skip Production for JVM-only release')[0];
    expect(classification).toContain('classifyCashflowSettlementProductionBaselines(');
    expect(classification).toContain('jvmDeployedSha ? changedPathsBetween(jvmDeployedSha, head) : null');
    expect(classification).not.toContain('...changedPathsBetween(jvmDeployedSha, head)');
  });

  it('routes mixed settlement code only through the atomic cutover owner', () => {
    expect(classifyCashflowSettlementProductionRelease([
      'server/jvm-weekly-api/src/main/java/example/Settlement.java',
      'server/bff/routes/jvm-weekly-api.mjs',
    ])).toMatchObject({ releaseMode: 'atomic_cutover' });
    expect(classifyCashflowSettlementProductionRelease([
      'server/jvm-weekly-api/src/main/java/example/Settlement.java',
    ])).toMatchObject({ releaseMode: 'jvm_only' });
    expect(classifyCashflowSettlementProductionRelease([
      'src/app/components/people/PeoplePage.tsx',
    ])).toMatchObject({ releaseMode: 'web' });
    expect(classifyCashflowSettlementProductionRelease([], { alreadyDeployed: true }))
      .toMatchObject({ releaseMode: 'already_deployed' });
  });

  it('uses one executable deploy command for locked B0 and writable B1', () => {
    const live = buildVercelProductionDeployArgs({
      sourceDir: '/tmp/b1', commitSha: 'a'.repeat(40), invocation: '1-1', maintenance: false, env,
    });
    const maintenance = buildVercelProductionDeployArgs({
      sourceDir: '/tmp/b0', commitSha: 'b'.repeat(40), invocation: '1-1', maintenance: true, env,
    });

    expect(live.args).toEqual(expect.arrayContaining([
      'BFF_MAINTENANCE_READ_ONLY=false',
      'BFF_WORKERS_ENABLED=true',
      'BFF_SCHEDULER_OWNER=vercel',
    ]));
    expect(maintenance.args).toEqual(expect.arrayContaining([
      'BFF_MAINTENANCE_READ_ONLY=true',
      'BFF_WORKERS_ENABLED=false',
      'BFF_SCHEDULER_OWNER=disabled',
      'JVM_WEEKLY_API_BASE_URL=https://candidate.example.test',
    ]));
  });
});
