import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
import { compileReactPreview } from './react-compiler.mjs';
import { fixtureArtifact } from './react-contract-fixtures.mjs';

const source = { title: '기한 검증', code: 'export default ()=> <div/>' };
function fakeChild() {
  const child = new EventEmitter(); child.pid = 123456789;
  child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.end = vi.fn();
  spawn.mockReturnValueOnce(child); return child;
}
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(process, 'kill').mockImplementation(() => true); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); spawn.mockReset(); });

describe('compiler termination and real close admission boundary', () => {
  it('bounds the timeout and V8 heap and keeps the slot until the killed child closes', async () => {
    const child = fakeChild(); let settled = false;
    const result = compileReactPreview(source, { timeoutMs: 60000 }).catch((error) => { settled = true; return error; });
    expect(spawn.mock.calls[0][1]).toContain('--max-old-space-size=256');
    expect(spawn.mock.calls[0][2].env).toEqual({ TZ: 'UTC', LANG: 'C.UTF-8' });
    await vi.advanceTimersByTimeAsync(7999); expect(process.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(process.kill).toHaveBeenCalledWith(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
    expect(settled).toBe(false);
    await expect(compileReactPreview(source)).rejects.toMatchObject({ code: 'react_compile_busy' });
    child.emit('close', null, 'SIGKILL');
    expect(await result).toMatchObject({ code: 'react_compile_timeout' });
    const next = fakeChild(); const nextResult = compileReactPreview(source);
    const artifact = fixtureArtifact(source);
    next.stdout.emit('data', JSON.stringify({ ok: true, artifact })); next.emit('close', 0);
    expect(await nextResult).toEqual(artifact);
  });
  it('does not count an abort or kill request as a completed child', async () => {
    const child = fakeChild(); const controller = new AbortController();
    const result = compileReactPreview(source, { signal: controller.signal }).catch((error) => error);
    controller.abort(); expect(process.kill).toHaveBeenCalledOnce();
    await expect(compileReactPreview(source)).rejects.toMatchObject({ code: 'react_compile_busy' });
    child.stdout.emit('data', JSON.stringify({ ok: true, artifact: { stale: true } }));
    child.emit('close', 0);
    expect(await result).toMatchObject({ code: 'react_compile_cancelled' });
  });
  it.each(['shape', 'identity', 'bytes'])('rejects a successful worker message with invalid %s', async (kind) => {
    const child = fakeChild(); const result = compileReactPreview(source).catch((error) => error);
    const artifact = fixtureArtifact(source);
    if (kind === 'shape') delete artifact.typecheck;
    if (kind === 'identity') artifact.workspaceHash = 'f'.repeat(64);
    if (kind === 'bytes') artifact.bundle += ' changed';
    child.stdout.emit('data', JSON.stringify({ ok: true, artifact })); child.emit('close', 0);
    expect(await result).toMatchObject({ code: 'react_compile_artifact_invalid' });
  });
});
