import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createRemoteRuntimeBroker } from './broker.mjs';
import { digest } from './contract.mjs';
import { domFrame, domEvent } from './dom-test-fixtures.mjs';
const context = { tenantId: 'synthetic', actorId: 'owner', analyticsScope: { fingerprint: 'scope-a' } }, sourceHash = 'a'.repeat(64);
const artifact = { bundle: 'window.AXRCompiledApp={default(){return null}}', css: '', sourceHash, packageSetHash: 'b'.repeat(64), runtimeVersion: 'react-preview-v1' }; artifact.bundleHash = digest(artifact.bundle); artifact.cssHash = digest('');
const input = { artifact, sourceHash, apiBindings: [], viewMode: 'dom' };
function fixture({ transform = (value) => value, delayed = false, authorize = async () => {} } = {}) {
  const commands = []; let frame, child, reply;
  const spawnDocker = (args) => {
    const process = new EventEmitter(); process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.kill = vi.fn(() => { process.emit('close', 137); });
    process.stdin = new Writable({ write(chunk, _encoding, done) {
      const message = JSON.parse(chunk); commands.push(message);
      if (message.type === 'init') frame = domFrame(message.sessionId, message.sourceHash);
      else { frame = structuredClone(frame); frame.sequence++; frame.snapshot.revision++; frame.snapshot.ack = message.event ? { eventId: message.event.eventId, ...(message.event.inputRevision ? { inputRevision: message.event.inputRevision } : {}) } : null; }
      reply = () => process.stdout.write(JSON.stringify(transform({ type: 'frame', requestId: message.requestId, ...frame }, message))+'\n');
      if (!delayed || message.type === 'init') queueMicrotask(reply); done();
    } });
    if (args[0] === 'run') child = process; else queueMicrotask(() => process.emit('close', 0)); return process;
  };
  const broker = createRemoteRuntimeBroker({ authorize, callApi: async () => ({}), spawnDocker });
  return { broker, commands, reply: () => reply(), child: () => child };
}
describe('DOM broker generation, native event idempotence and authorization', () => {
  it('replays the same completed event without re-executing it and refuses altered payload', async () => {
    const fake = fixture(); try {
      const result = await fake.broker.create(context, input), event = domEvent(result.frame);
      const first = await fake.broker.event(context, result.sessionId, event), replay = await fake.broker.event(context, result.sessionId, event);
      expect(replay).toEqual(first); expect(first.snapshot.ack.eventId).toBe(event.eventId); expect(fake.commands.filter(item => item.type === 'event')).toHaveLength(1);
      await expect(fake.broker.event(context, result.sessionId, { ...event, type: 'focus' })).rejects.toMatchObject({ code: 'remote_dom_event_conflict' });
    } finally { fake.broker.shutdown(); }
  });
  it('shares an in-flight identical event result with one native execution', async () => {
    const fake = fixture({ delayed: true }); try {
      const result = await fake.broker.create(context, input), event = domEvent(result.frame);
      const first = fake.broker.event(context, result.sessionId, event), second = fake.broker.event(context, result.sessionId, event);
      await new Promise(resolve => setTimeout(resolve, 5)); expect(fake.commands.filter(item => item.type === 'event')).toHaveLength(1); fake.reply();
      expect(await first).toEqual(await second);
    } finally { fake.broker.shutdown(); }
  });
  it('keeps a valid session on stale revision while refusing the stale event', async () => {
    const fake = fixture(); try {
      const result = await fake.broker.create(context, input); await fake.broker.frame(context, result.sessionId);
      await expect(fake.broker.event(context, result.sessionId, domEvent(result.frame))).rejects.toMatchObject({ code: 'remote_dom_revision_changed' });
      expect(fake.broker.activeSessions).toBe(1); expect(fake.commands.filter(item => item.type === 'event')).toHaveLength(0);
    } finally { fake.broker.shutdown(); }
  });
  it('rechecks current permission before returning even a cached completed event', async () => {
    let allowed = true; const fake = fixture({ authorize: async () => { if (!allowed) throw Object.assign(new Error('revoked'), { statusCode: 403 }); } });
    try {
      const result = await fake.broker.create(context, input), event = domEvent(result.frame); await fake.broker.event(context, result.sessionId, event); allowed = false;
      await expect(fake.broker.event(context, result.sessionId, event)).rejects.toMatchObject({ statusCode: 403 }); expect(fake.broker.activeSessions).toBe(0);
    } finally { fake.broker.shutdown(); }
  });
  it.each(['source', 'epoch', 'ack', 'cycle'])('closes a session on forged %s from the worker', async (kind) => {
    const fake = fixture({ transform(value, message) { if (message.type === 'event') {
      if (kind === 'source') value.sourceHash = 'f'.repeat(64);
      if (kind === 'epoch') value.documentEpoch = '22222222-2222-4222-8222-222222222222';
      if (kind === 'ack') value.snapshot.ack.eventId = '22222222-2222-4222-8222-222222222222';
      if (kind === 'cycle') value.snapshot.nodes[1].parentId = value.snapshot.nodes[1].id;
    } return value; } });
    try { const result = await fake.broker.create(context, input); await expect(fake.broker.event(context, result.sessionId, domEvent(result.frame))).rejects.toMatchObject({ code: 'remote_dom_frame_invalid' }); expect(fake.broker.activeSessions).toBe(0); }
    finally { fake.broker.shutdown(); }
  });
});
