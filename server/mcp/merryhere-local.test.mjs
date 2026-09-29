import { it, expect, vi } from 'vitest';
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalRoomRelay } from './merryhere-local-relay.mjs';
import { localStore } from './merryhere-local-store.mjs';
import { executeLocalRoomCommand } from './merryhere-local-executor.mjs';
import { memoryDb } from './slack-test-store.mjs';
import { localResultSchema } from './merryhere-local-contract.mjs';

const token = 'a'.repeat(64), code = 'b'.repeat(32);
const actor = { tenantId: 'mysc', actorId: 'member' };
async function fixture() {
  const { db, records } = memoryDb();
  let now = 1000000;
  records.set('orgs/mysc/members/member', { status: 'ACTIVE' });
  const relay = createLocalRoomRelay({ db, now: () => now, sleep: async () => { now += 1000; } });
  await relay.register(token, code);
  return { db, records, relay, advance: ms => { now += ms; }, now: () => now };
}

it('pairs once, isolates owners, distinguishes login/offline and revokes the capability', async () => {
  const f = await fixture();
  expect((await f.relay.connection(actor)).issue).toBe('local_not_connected');
  await f.relay.pair(actor, code);
  await expect(f.relay.pair({ ...actor, actorId: 'other' }, code)).rejects.toThrow('local_pair_expired');
  await f.relay.poll(token, false);
  expect((await f.relay.connection(actor)).issue).toBe('local_login_required');
  await f.relay.poll(token, true);
  expect((await f.relay.connection(actor)).deviceId).toBeDefined();
  expect((await f.relay.connection({ ...actor, actorId: 'other' })).issue).toBe('local_not_connected');
  f.advance(46000);
  expect((await f.relay.connection(actor)).issue).toBe('local_offline');
  await f.relay.disconnect(actor);
  await expect(f.relay.poll(token, true)).rejects.toThrow('local_unauthorized');
  expect(JSON.stringify([...f.records])).not.toContain(token);
  expect(JSON.stringify([...f.records])).not.toContain(code);
});

it('rejects expired pairing codes', async () => {
  const f = await fixture(); f.advance(600001);
  await expect(f.relay.pair(actor, code)).rejects.toThrow('local_pair_expired');
});

it('claims commands once and rejects cross-device results and secret-bearing results', async () => {
  const f = await fixture(); await f.relay.pair(actor, code); await f.relay.poll(token, true);
  const connection = await f.relay.connection(actor);
  const id = '12345678-1234-1234-1234-123456789012';
  const path = `merryhere_local_devices/${connection.deviceId}/commands/${id}`;
  f.records.set(path, { deviceId: connection.deviceId, state: 'QUEUED', expiresAt: f.now() + 10000, payload: { op: 'login' } });
  expect((await f.relay.poll(token, true)).command.id).toBe(id);
  expect((await f.relay.poll(token, true)).command).toBeNull();
  const other = 'c'.repeat(64); await f.relay.register(other, 'd'.repeat(32));
  await expect(f.relay.complete(other, id, { ok: true, value: null })).rejects.toThrow();
  await expect(f.relay.complete(token, id, { ok: true, value: null, cookies: 'secret' })).rejects.toThrow();
  await f.relay.complete(token, id, { ok: true, value: null });
  await expect(f.relay.complete(token, id, { ok: true, value: null })).rejects.toThrow();
});

it('relays typed results and cleans commands without returning CSRF', async () => {
  const f = await fixture(); await f.relay.pair(actor, code); await f.relay.poll(token, true);
  const connection = await f.relay.connection(actor);
  const live = createLocalRoomRelay({ db: f.db, now: f.now, sleep: async () => {
    const { command } = await f.relay.poll(token, true);
    if (command) await f.relay.complete(token, command.id, { ok: true, value: null });
  } });
  await live.client(connection).login();
  expect([...f.records.keys()].some(key => key.includes('/commands/'))).toBe(false);
  expect(localResultSchema({ op: 'calendar' }).safeParse({ ok: true, value: { date: '2026-09-30', slots: [], token: 'csrf' } }).success).toBe(false);
});

const calendar = '<a href="https://merryhere.kr/auth/logout">out</a><input id="sel-date" value="2026-09-30"><button id="btn-reservation" data-date="2026-09-30"></button><form action="/reserve" method="post"><input name="_token" value="private-csrf"></form><input name="slot" value="9-0-8" data-name="3A" data-cnt="8" data-time="09:00" data-time2="09:30" data-list-id="" class="">';
it('keeps sessions local and prevents a second POST after a timeout or restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'merryhere-test-'));
  try {
    const store = await localStore(directory);
    await store.write('session.json', { laravel_session: 'private-cookie' });
    const clock = Date.parse('2026-09-29T09:00:00+09:00');
    let posts = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/reserve')) { posts++; throw new Error('timeout'); }
      return new Response(calendar);
    });
    const read = await executeLocalRoomCommand({ command: { payload: { op: 'calendar', date: '2026-09-30' }, expiresAt: clock + 10000 }, store, fetchImpl, now: () => clock });
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read)).not.toMatch(/private-cookie|private-csrf|token/);
    const payload = { op: 'reserve', intent: { id: 'a'.repeat(24), date: '2026-09-30', start: '09:00', end: '09:30', roomId: '9', ordinals: [0], points: 8, capacity: 4, providerTitle: '회의' } };
    const command = { payload, expiresAt: clock + 10000 };
    expect((await executeLocalRoomCommand({ command, store, fetchImpl, now: () => clock })).ok).toBe(false);
    const restarted = await localStore(directory);
    expect((await executeLocalRoomCommand({ command, store: restarted, fetchImpl, now: () => clock })).code).toBe('local_uncertain');
    expect(posts).toBe(1);
    expect((await stat(join(directory, 'session.json'))).mode & 0o777).toBe(0o600);
    await symlink(join(directory, 'session.json'), join(directory, 'link.json'));
    await expect(store.read('link.json')).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
