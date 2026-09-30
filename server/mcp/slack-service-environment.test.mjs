import { describe, expect, it } from 'vitest';
import { slackServiceEnvironment } from '../../scripts/slack-service-environment.mjs';
const identity = { origin: 'https://mysc-slack-agent.vercel.app', sha: 'a'.repeat(40) };
describe('isolated Slack live environment', () => {
  it('replaces the website-only origin allowlist and uses the existing Slack worker authentication', () => {
    const source = { BFF_LIVE_ALLOWED_ORIGINS: 'https://myscube.myscguard.app', CRON_SECRET: 'unrelated-website-secret' };
    const result = slackServiceEnvironment(source, { ...identity, workerSecret: 's'.repeat(64) });
    expect(result.BFF_LIVE_ALLOWED_ORIGINS).toBe(result.BFF_ALLOWED_ORIGINS);
    expect(result.CRON_SECRET).toBe('s'.repeat(64));
    expect(result.MERRYHERE_CONNECT_ORIGIN).toBe(identity.origin);
    expect(source.BFF_LIVE_ALLOWED_ORIGINS).toBe('https://myscube.myscguard.app');
  });
  it('fails before deployment when cron authentication was not transferred', () => {
    expect(() => slackServiceEnvironment({}, identity)).toThrow(/CRON_SECRET/);
  });
  it('retains the prohibition against live emulator use', () => {
    expect(() => slackServiceEnvironment({ FIRESTORE_EMULATOR_HOST: 'localhost:8080' }, { ...identity, workerSecret: 's'.repeat(64) })).toThrow(/emulator/);
  });
});
