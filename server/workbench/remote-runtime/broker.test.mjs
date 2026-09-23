import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createRemoteRuntimeBroker } from './broker.mjs';
import { dockerRunArguments, REMOTE_RUNTIME_IMAGE, digest } from './contract.mjs';

const context = { tenantId: 'qa', actorId: 'admin', analyticsScope: { fingerprint: 'scope-one' } };
const sourceHash = 'a'.repeat(64);
const artifact = { bundle: 'window.AXRCompiledApp={default(){return null}}', css: '', sourceHash, packageSetHash: 'b'.repeat(64), runtimeVersion: 'react-preview-v1' };
artifact.bundleHash = digest(artifact.bundle); artifact.cssHash = digest(artifact.css);
const png = (width, height) => { const bytes = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes.toString('base64'); };
function fixture({ respond = true, onCommand } = {}) {
  const calls = []; let process;
  const spawnDocker = (args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn(() => { child.emit('close', 137); return true; });
    let sequence = 0;
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const message = JSON.parse(chunk); calls.push(message);
      if (onCommand) onCommand(message, child);
      else if (respond && ['init', 'event', 'frame'].includes(message.type)) queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'frame', requestId: message.requestId, sequence: ++sequence, width: 1280, height: 720, pngBase64: png(1280,720) }) + '\n'));
      done();
    } });
    child.args = args;
    if (args[0] === 'run') process = child; else queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  return { calls, spawnDocker, process: () => process };
}
const input = { artifact, sourceHash, apiBindings: [] };
describe('remote renderer broker bounds and ownership', () => {
  it('does not create a container when authorization finishes after shutdown starts', async () => {
    let authorizeReady;
    const authorization = new Promise(resolve => { authorizeReady = resolve; });
    const spawnDocker = vi.fn();
    const broker = createRemoteRuntimeBroker({ authorize: () => authorization, callApi: async () => ({}), spawnDocker });
    const pending = broker.create(context, input);
    broker.shutdown(); authorizeReady();
    await expect(pending).rejects.toMatchObject({ code: 'remote_shutdown' });
    expect(spawnDocker).not.toHaveBeenCalled(); expect(broker.reservedSessions).toBe(0);
  });
  it('uses fixed local image and cgroup/network/filesystem restrictions without mounts, credentials or shell commands', () => {
    const args = dockerRunArguments('axr-render-11111111-1111-1111-1111-111111111111');
    expect(args).toContain('--label'); expect(args).toContain('io.myscube.axr.renderer=v1'); expect(args).toContain('--pull=never'); expect(args.at(-1)).toBe(REMOTE_RUNTIME_IMAGE);
    for (const [flag, value] of [['--network','none'], ['--memory','512m'], ['--memory-swap','512m'], ['--cpus','1'], ['--pids-limit','128'], ['--user','10001:10001'], ['--cap-drop','ALL'], ['--security-opt','no-new-privileges']]) expect(args[args.indexOf(flag)+1]).toBe(value);
    expect(args).toContain('--read-only'); expect(args).not.toContain('--privileged'); expect(args).not.toContain('-v'); expect(args).not.toContain('-e');
    expect(() => dockerRunArguments('x; curl attacker')).toThrow();
  });
  it('returns PNG-only frames, supports bounded interaction and removes the container on close', async () => {
    const fake = fixture(); const broker = createRemoteRuntimeBroker({ authorize: async () => {}, callApi: async () => ({}), spawnDocker: fake.spawnDocker });
    const created = await broker.create(context, input);
    expect(created.frame).toMatchObject({ sourceHash, sequence: 1, width: 1280, height: 720 });
    expect(created.frame).not.toHaveProperty('bundle');
    expect((await broker.event(context, created.sessionId, { type: 'click', x: 20, y: 20 })).sequence).toBe(2);
    await broker.close(context, created.sessionId); expect(broker.activeSessions).toBe(0); expect(fake.process().kill).toHaveBeenCalled();
  });
  it('blocks other actors, scopes, unsupported keys and arbitrary input fields', async () => {
    const fake = fixture(); const broker = createRemoteRuntimeBroker({ authorize: async () => {}, callApi: async () => ({}), spawnDocker: fake.spawnDocker });
    const created = await broker.create(context, input);
    await expect(broker.frame({ ...context, actorId: 'other' }, created.sessionId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(broker.event(context, created.sessionId, { type: 'key', key: 'Control+L' })).rejects.toMatchObject({ code: 'remote_event_invalid' });
    await expect(broker.event(context, created.sessionId, { type: 'click', x: 20, y: 20, script: 'eval' })).rejects.toMatchObject({ code: 'remote_event_invalid' });
    await expect(broker.frame({ ...context, analyticsScope: { fingerprint: 'changed' } }, created.sessionId)).rejects.toMatchObject({ statusCode: 404 });
    broker.closeAll();
  });
  it('terminates hung commands and output floods without keeping a session slot', async () => {
    const hung = fixture({ respond: false }); const broker = createRemoteRuntimeBroker({ authorize: async () => {}, callApi: async () => ({}), spawnDocker: hung.spawnDocker, limits: { commandMs: 30 } });
    await expect(broker.create(context, input)).rejects.toMatchObject({ code: 'remote_command_timeout' }); expect(broker.activeSessions).toBe(0);
    const flood = fixture({ onCommand: (_message, child) => queueMicrotask(() => child.stdout.write('x'.repeat(1001))) });
    const limited = createRemoteRuntimeBroker({ authorize: async () => {}, callApi: async () => ({}), spawnDocker: flood.spawnDocker, limits: { outputBytes: 1000 } });
    await expect(limited.create(context, input)).rejects.toMatchObject({ code: 'remote_output_limit' }); expect(limited.activeSessions).toBe(0);
  });
  it('routes only declared API versions through the trusted callback and suppresses results after revocation', async () => {
    const apiId = '11111111-1111-4111-8111-111111111111'; const fake = fixture(); let allowed = true;
    const callApi = vi.fn(async () => ({ data: { value: 0 } }));
    const broker = createRemoteRuntimeBroker({ authorize: async () => { if (!allowed) throw Object.assign(new Error('revoked'), { statusCode: 403 }); }, callApi, spawnDocker: fake.spawnDocker });
    await broker.create(context, { ...input, apiBindings: [{ id: apiId, version: 7 }] });
    fake.process().stdout.write(JSON.stringify({ type: 'api-call', requestId: '22222222-2222-4222-8222-222222222222', apiId, input: { month: '2026-09' } }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(callApi.mock.calls[0][1]).toMatchObject({ apiId, apiVersion: 7, input: { month: '2026-09' } });
    expect(fake.calls.find(item => item.type === 'api-result')).toMatchObject({ ok: true, result: { data: { value: 0 } } });
    allowed = false;
    fake.process().stdout.write(JSON.stringify({ type: 'api-call', requestId: '33333333-3333-4333-8333-333333333333', apiId, input: {} }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 5)); expect(broker.activeSessions).toBe(0);
  });
  it('keeps the last good session on candidate failure and bounds replacement overlap', async () => {
    const fake = fixture(); let failNext = false;
    const spawnDocker = args => {
      const child = fake.spawnDocker(args);
      if (args[0] === 'run' && failNext) { failNext = false; queueMicrotask(() => child.emit('close', 137)); }
      return child;
    };
    const broker = createRemoteRuntimeBroker({ authorize: async () => {}, callApi: async () => ({}), spawnDocker });
    const original = await broker.create(context, input);
    failNext = true;
    await expect(broker.create(context, { ...input, previousSessionId: original.sessionId })).rejects.toMatchObject({ code: 'remote_exited' });
    expect(broker.activeSessions).toBe(1);
    expect((await broker.frame(context, original.sessionId)).sequence).toBe(2);
    const candidate = await broker.create(context, { ...input, previousSessionId: original.sessionId });
    expect(broker.activeSessions).toBe(2);
    await expect(broker.create(context, { ...input, previousSessionId: original.sessionId })).rejects.toMatchObject({ code: 'remote_previous_invalid' });
    await expect(broker.create(context, { ...input, previousSessionId: candidate.sessionId })).rejects.toMatchObject({ code: 'remote_capacity' });
    await broker.close(context, original.sessionId);
    expect((await broker.frame(context, candidate.sessionId)).sequence).toBe(2);
    broker.closeAll();
  });
  it('keeps server-owned evidence by reference through the API bridge', async () => {
    const apiId = '11111111-1111-4111-8111-111111111111'; const remoteEvidence = { items: [] };
    const fake = fixture();
    const broker = createRemoteRuntimeBroker({ authorize: async () => {}, spawnDocker: fake.spawnDocker, callApi: async current => {
      expect(current.remoteEvidence).toBe(remoteEvidence); current.remoteEvidence.items.push({ apiId, version: 2 }); return { data: [] };
    } });
    await broker.create({ ...context, remoteEvidence }, { ...input, apiBindings: [{ id: apiId, version: 2 }] });
    fake.process().stdout.write(JSON.stringify({ type: 'api-call', requestId: '22222222-2222-4222-8222-222222222222', apiId, input: {} }) + '\n');
    await vi.waitFor(() => expect(remoteEvidence.items).toEqual([{ apiId, version: 2 }]));
    broker.closeAll();
  });
  it('reserves global and actor capacity until container removal is confirmed', async () => {
    const fake = fixture(); const removals = [];
    const spawnDocker = args => {
      if (args[0] === 'run') return fake.spawnDocker(args);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn(); removals.push(child); return child;
    };
    const broker = createRemoteRuntimeBroker({ authorize: async () => {}, callApi: async () => ({}), spawnDocker, limits: { sessions: 1 } });
    const created = await broker.create(context, input); await broker.close(context, created.sessionId);
    expect(broker.activeSessions).toBe(0); expect(broker.reservedSessions).toBe(1); expect(broker.cleanupStatus[0]).toMatchObject({ attempts: 1, pending: true });
    await expect(broker.create(context, input)).rejects.toMatchObject({ code: 'remote_capacity' });
    await expect(broker.create({ ...context, actorId: 'another' }, input)).rejects.toMatchObject({ code: 'remote_capacity' });
    removals[0].emit('close', 0); expect(broker.reservedSessions).toBe(0);
    const next = await broker.create(context, input); await broker.close(context, next.sessionId); removals[1].emit('close', 0);
  });
  it('retries failed cleanup only three times, remains fail-closed and permits explicit reaping', async () => {
    const fake = fixture(); let successful = false; let attempts = 0;
    const spawnDocker = args => {
      if (args[0] === 'run') return fake.spawnDocker(args);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn(); attempts++;
      queueMicrotask(() => child.emit('close', successful ? 0 : 1)); return child;
    };
    const broker = createRemoteRuntimeBroker({ authorize: async () => {}, callApi: async () => ({}), spawnDocker });
    const created = await broker.create(context, input); await broker.close(context, created.sessionId);
    await vi.waitFor(() => expect(broker.cleanupStatus[0]).toMatchObject({ attempts: 3, failed: true, pending: false }));
    expect(attempts).toBe(3); expect(broker.reservedSessions).toBe(1);
    await expect(broker.create(context, input)).rejects.toMatchObject({ code: 'remote_capacity' });
    successful = true; broker.reapCleanup(); await vi.waitFor(() => expect(broker.reservedSessions).toBe(0)); expect(attempts).toBe(4);
  });
  it('revokes only matching verified owners and closes on owner authorization or scope loss', async () => {
    const fake = fixture(); let allowed = true;
    const broker = createRemoteRuntimeBroker({ authorize: async () => { if (!allowed) throw Object.assign(new Error('revoked'), { statusCode: 403 }); }, callApi: async () => ({}), spawnDocker: fake.spawnDocker });
    const created = await broker.create(context, input);
    broker.revokeOwner({ ...context, actorId: 'other' }); expect(broker.activeSessions).toBe(1);
    allowed = false;
    await expect(broker.frame({ ...context, actorId: 'other' }, created.sessionId)).rejects.toMatchObject({ statusCode: 403 }); expect(broker.activeSessions).toBe(1);
    await expect(broker.frame(context, created.sessionId)).rejects.toMatchObject({ statusCode: 403 }); expect(broker.activeSessions).toBe(0);
    allowed = true; const next = await broker.create(context, input);
    await expect(broker.frame({ ...context, analyticsScope: { fingerprint: 'changed' } }, next.sessionId)).rejects.toMatchObject({ statusCode: 404 }); expect(broker.activeSessions).toBe(0);
    await broker.create(context, input); broker.revokeOwner(context); expect(broker.activeSessions).toBe(0);
  });
  it('rechecks idle session authorization and releases revoked sessions without another browser request', async () => {
    vi.useFakeTimers(); const fake = fixture(); let allowed = true;
    const broker = createRemoteRuntimeBroker({ authorize: async () => { if (!allowed) throw new Error('revoked'); }, callApi: async () => ({}), spawnDocker: fake.spawnDocker });
    try {
      await broker.create(context, input); allowed = false;
      await vi.advanceTimersByTimeAsync(30000); expect(broker.activeSessions).toBe(0); expect(broker.reservedSessions).toBe(0);
    } finally { broker.closeAll(); vi.useRealTimers(); }
  });
  it('automatically reaps failed tombstones once per minute and stops polling at shutdown', async () => {
    vi.useFakeTimers(); const fake = fixture(); let succeeds = false, removals = 0;
    const spawnDocker = args => {
      if (args[0] === 'run') return fake.spawnDocker(args);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn(); removals++;
      queueMicrotask(() => child.emit('close', succeeds ? 0 : 1)); return child;
    };
    const broker = createRemoteRuntimeBroker({ authorize: async () => {}, callApi: async () => ({}), spawnDocker });
    try {
      const created = await broker.create(context, input); await broker.close(context, created.sessionId);
      await vi.advanceTimersByTimeAsync(300); expect(removals).toBe(3); expect(broker.reservedSessions).toBe(1);
      succeeds = true; await vi.advanceTimersByTimeAsync(60000); expect(removals).toBe(4); expect(broker.reservedSessions).toBe(0);
      broker.shutdown(); await vi.advanceTimersByTimeAsync(120000); expect(removals).toBe(4);
      await expect(broker.create(context, input)).rejects.toMatchObject({ code: 'remote_shutdown' });
    } finally { broker.shutdown(); vi.useRealTimers(); }
  });
  it('checks source integrity and allows only one session per actor even when the grant changes', async () => {
    const fake = fixture(); const broker = createRemoteRuntimeBroker({ authorize: async () => {}, callApi: async () => ({}), spawnDocker: fake.spawnDocker });
    await expect(broker.create(context, { ...input, sourceHash: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'remote_binding_invalid' });
    await broker.create(context, input);
    await expect(broker.create({ ...context, analyticsScope: { fingerprint: 'changed' } }, input)).rejects.toMatchObject({ code: 'remote_capacity' });
    broker.closeAll();
  });
});
