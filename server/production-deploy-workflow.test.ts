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
  it.each([false, true])('ignores all Workbench flags while preserving settlement enabled=%s', (settlement) => {
    for (const maintenance of [false, true]) {
      const input = { sourceDir: '/tmp/agent', commitSha: 'a'.repeat(40), invocation: '1-1', maintenance,
        env: { ...env, SETTLEMENT_AGENT_ENABLED: String(settlement), SLACK_SIGNING_SECRET: 'signature', SETTLEMENT_AGENT_GEMINI_API_KEY: 'agent-key', SETTLEMENT_AGENT_WORKER_SECRET: 'worker-key' } };
      const baseline = buildVercelProductionDeployArgs(input);
      for (const ai of [false, true]) for (const reads of [false, true]) {
        const deployment = buildVercelProductionDeployArgs({ ...input, env: { ...input.env, PRODUCT_WORKBENCH_AI_ENABLED: String(ai), PRODUCT_WORKBENCH_READS_ENABLED: String(reads), WORKBENCH_AI_ENABLED: String(ai), WORKBENCH_GEMINI_API_KEY: 'independent-key' } });
        expect(deployment).toEqual(baseline);
        expect(deployment.args.some((arg: string) => arg.includes('WORKBENCH') || arg.includes('independent-key'))).toBe(false);
        expect(deployment.args).toContain(`SETTLEMENT_AGENT_ENABLED=${settlement && !maintenance}`);
        for (const ownCredential of ['SLACK_SIGNING_SECRET=signature', 'SETTLEMENT_AGENT_GEMINI_API_KEY=agent-key', 'SETTLEMENT_AGENT_WORKER_SECRET=worker-key']) expect(deployment.args.includes(ownCredential)).toBe(settlement);
      }
    }
  });
  it('continues requiring settlement own credentials and never borrows Workbench credentials', () => {
    for (const required of ['SLACK_SIGNING_SECRET', 'SETTLEMENT_AGENT_GEMINI_API_KEY', 'SETTLEMENT_AGENT_WORKER_SECRET']) {
      for (const maintenance of [false, true]) {
        const configured: Record<string, string> = { ...env, SETTLEMENT_AGENT_ENABLED: 'true', SLACK_SIGNING_SECRET: 'signature', SETTLEMENT_AGENT_GEMINI_API_KEY: 'agent-key', SETTLEMENT_AGENT_WORKER_SECRET: 'worker-key', PRODUCT_WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'independent-key' };
        delete configured[required];
        expect(() => buildVercelProductionDeployArgs({ sourceDir: '/tmp/agent', commitSha: 'a'.repeat(40), invocation: '1-1', maintenance, env: configured })).toThrow(required);
      }
    }
  });
  it('removes the main Workbench deployment gate without altering the settlement canary contract', () => {
    const workflow = readFileSync('.github/workflows/production-deploy.yml', 'utf8');
    expect(workflow).not.toContain('WORKBENCH');
    expect(workflow).not.toContain('Verify Workbench isolation before alias');
    expect(workflow).not.toContain('node scripts/verify-workbench-isolation.mjs');
    const capture = workflow.indexOf('- name: Capture current canonical alias');
    const verify = workflow.indexOf('- name: Verify authenticated settlement reads before alias');
    const promote = workflow.indexOf('- name: Promote canonical production alias');
    expect(capture).toBeGreaterThan(-1); expect(verify).toBeGreaterThan(capture); expect(promote).toBeGreaterThan(verify);
    const canary = workflow.slice(verify, promote);
    expect(canary).toContain("if: steps.release_mode.outputs.settlement_cutover == 'true'");
    expect(canary).toContain('run: |\n          node scripts/verify-cashflow-settlement-candidate.mjs');
    const canaryEnv = Object.fromEntries([...canary.matchAll(/^          ([A-Z_]+): (.+)$/gm)].map(match => [match[1], match[2]]));
    expect(canaryEnv).toEqual({
      SETTLEMENT_CANARY_BASE_URL: '${{ steps.vercel_deploy.outputs.deployment_url }}',
      SETTLEMENT_CANARY_FIREBASE_WEB_API_KEY: '${{ vars.FIREBASE_WEB_API_KEY_LIVE }}',
      SETTLEMENT_CANARY_FIREBASE_REFRESH_TOKEN: '${{ secrets.FIREBASE_SETTLEMENT_READ_CANARY_REFRESH_TOKEN_LIVE }}',
      VERCEL_AUTOMATION_BYPASS_SECRET: '${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}',
      SETTLEMENT_CANARY_ACTOR_UID: '${{ vars.SETTLEMENT_READ_CANARY_ACTOR_UID_LIVE }}',
      SETTLEMENT_CANARY_PROJECT_ID: '${{ vars.JVM_SETTLEMENT_CANARY_PROJECT_ID_LIVE }}',
      SETTLEMENT_CANARY_CYCLE_YEAR_MONTH: '${{ vars.JVM_SETTLEMENT_CANARY_CYCLE_YEAR_MONTH_LIVE }}',
      SETTLEMENT_CANARY_EXPECTED_REQUEST_ID: '${{ vars.SETTLEMENT_CANARY_EXPECTED_REQUEST_ID_LIVE }}',
      SETTLEMENT_CANARY_EXPECTED_STATUS: '${{ vars.SETTLEMENT_CANARY_EXPECTED_STATUS_LIVE }}',
      SETTLEMENT_CANARY_EXPECTED_WORKFLOW_REVISION: '${{ vars.SETTLEMENT_CANARY_EXPECTED_WORKFLOW_REVISION_LIVE }}',
      SETTLEMENT_CANARY_EXPECTED_EVIDENCE_REVISION: '${{ vars.SETTLEMENT_CANARY_EXPECTED_EVIDENCE_REVISION_LIVE }}',
      SETTLEMENT_CANARY_EXPECTED_TARGET_YEAR_MONTH: '${{ vars.SETTLEMENT_CANARY_EXPECTED_TARGET_YEAR_MONTH_LIVE }}',
      SETTLEMENT_CANARY_EXPECTED_ACTIONS: '${{ vars.SETTLEMENT_CANARY_EXPECTED_ACTIONS_LIVE }}',
      SETTLEMENT_CANARY_TENANT_ID: 'mysc',
      SETTLEMENT_CANARY_CANONICAL_ORIGIN: 'https://myscube.myscguard.app',
    });
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
