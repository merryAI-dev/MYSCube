import { describe, expect, it } from 'vitest';
import { slackServiceEnvironment } from './slack-service-environment.mjs';
const identity = { origin: 'https://mysc-slack-agent.vercel.app', sha: 'a'.repeat(40) };
describe('isolated Slack live environment', () => {
  it('replaces the website-only origin allowlist and preserves cron authentication', () => {
    const source = { BFF_LIVE_ALLOWED_ORIGINS: 'https://myscube.myscguard.app', CRON_SECRET: 's'.repeat(64) };
    const result = slackServiceEnvironment(source, identity);
    expect(result.BFF_LIVE_ALLOWED_ORIGINS).toBe(result.BFF_ALLOWED_ORIGINS);
    expect(result.CRON_SECRET).toBe(source.CRON_SECRET);
    expect(result.MERRYHERE_CONNECT_ORIGIN).toBe(identity.origin);
    expect(source.BFF_LIVE_ALLOWED_ORIGINS).toBe('https://myscube.myscguard.app');
  });
  it('fails before deployment when cron authentication was not transferred', () => {
    expect(() => slackServiceEnvironment({}, identity)).toThrow(/CRON_SECRET/);
  });
  it('retains the prohibition against live emulator use', () => {
    expect(() => slackServiceEnvironment({ CRON_SECRET: 's'.repeat(64), FIRESTORE_EMULATOR_HOST: 'localhost:8080' }, identity)).toThrow(/emulator/);
  });
});
