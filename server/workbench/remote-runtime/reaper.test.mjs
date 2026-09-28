import { describe, expect, it } from 'vitest';
import { assertRendererHostReady, reapExpiredRenderers } from './reaper.mjs';
import { REMOTE_RUNTIME_IMAGE, REMOTE_RENDERER_LABEL, REMOTE_RENDERER_LABEL_VALUE } from './contract.mjs';
const now = () => Date.parse('2026-09-23T12:00:00Z');
const id = number => number.toString(16).padStart(64, '0');
const record = number => ({ Id: id(number), Name: '/axr-render-11111111-1111-4111-8111-111111111111', Created: '2026-09-23T11:50:00Z', Config: { Image: REMOTE_RUNTIME_IMAGE, Labels: { [REMOTE_RENDERER_LABEL]: REMOTE_RENDERER_LABEL_VALUE } } });
function fixture(records, failRemove = false) {
  const calls = [];
  const execute = async (args, options) => {
    calls.push(args); expect(options.timeoutMs).toBeLessThanOrEqual(3000); expect(options.maxBuffer).toBe(65536);
    if (args[0] === 'ps') return records.map(item => item.Id).join('\n');
    if (args[0] === 'inspect') return JSON.stringify([records.find(item => item.Id === args.at(-1))]);
    if (failRemove) throw new Error('daemon unavailable');
    return args.at(-1);
  };
  return { execute, calls };
}
describe('independent Docker orphan reaper', () => {
  it('removes only labeled fixed-image UUID containers older than TTL plus grace using inspected immutable IDs', async () => {
    const expired = record(1), recent = { ...record(2), Created: '2026-09-23T11:54:00Z' }, future = { ...record(3), Created: '2026-09-23T12:10:00Z' };
    const wrongName = { ...record(4), Name: '/production-api' }, wrongImage = record(5), wrongLabel = record(6), invalidDate = { ...record(7), Created: 'unknown' };
    wrongImage.Config.Image = 'business-production:latest'; wrongLabel.Config.Labels[REMOTE_RENDERER_LABEL] = 'other';
    const fake = fixture([expired, recent, future, wrongName, wrongImage, wrongLabel, invalidDate]);
    expect(await reapExpiredRenderers({ ...fake, now })).toMatchObject({ examined: 7, removed: [id(1)], skipped: 6, failures: [] });
    expect(fake.calls.filter(args => args[0] === 'rm')).toEqual([['rm', '-f', id(1)]]);
    expect(fake.calls[0]).toContain(`label=${REMOTE_RENDERER_LABEL}=${REMOTE_RENDERER_LABEL_VALUE}`);
  });
  it('does not release an orphan after failed deletion and retries it on the next timer pass', async () => {
    const failed = fixture([record(1)], true); expect((await reapExpiredRenderers({ ...failed, now })).failures).toEqual([id(1)]);
    const next = fixture([record(1)]); expect((await reapExpiredRenderers({ ...next, now })).removed).toEqual([id(1)]);
  });
  it('rejects malformed or shell-like Docker IDs without inspecting or deleting arbitrary names', async () => {
    const calls = []; const execute = async args => { calls.push(args); return 'name;rm-other'; };
    await expect(reapExpiredRenderers({ execute, now })).rejects.toThrow(); expect(calls).toHaveLength(1);
  });
  it('bounds a single sweep to 100 inspections and leaves remaining work observable', async () => {
    const fake = fixture(Array.from({ length: 101 }, (_, index) => record(index + 1)));
    const result = await reapExpiredRenderers({ ...fake, now }); expect(result.examined).toBe(100); expect(result.truncated).toBe(true); expect(result.removed).toHaveLength(100);
  });
});

describe('renderer host startup gate', () => {
  it('permits listener startup only when no owned labeled container remains', async () => {
    const calls = [];
    const execute = async (args, options) => { calls.push(args); expect(options).toEqual({ timeoutMs: 3000, maxBuffer: 65536 }); return ''; };
    expect(await assertRendererHostReady({ execute })).toEqual({ ready: true, ownedContainers: 0 });
    expect(calls).toEqual([['ps', '-aq', '--no-trunc', '--filter', `label=${REMOTE_RENDERER_LABEL}=${REMOTE_RENDERER_LABEL_VALUE}`]]);
  });
  it('rejects startup on any old labeled container without spawning, deleting or ignoring stopped containers', async () => {
    const calls = []; const execute = async args => { calls.push(args); return id(1); };
    await expect(assertRendererHostReady({ execute })).rejects.toMatchObject({ code: 'remote_host_not_ready', statusCode: 503 });
    expect(calls).toHaveLength(1); expect(calls[0]).toContain('-aq');
    await expect(assertRendererHostReady({ execute: async () => 'unexpected daemon output' })).rejects.toMatchObject({ code: 'remote_host_not_ready' });
  });
  it('fails closed when the local Docker daemon cannot be inspected', async () => {
    await expect(assertRendererHostReady({ execute: async () => { throw new Error('private daemon diagnostic'); } })).rejects.toMatchObject({ code: 'remote_host_unavailable', statusCode: 503 });
  });
});
