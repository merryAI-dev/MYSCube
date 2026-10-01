import { it, expect, vi, beforeEach, afterEach } from 'vitest';

// 예약 가능 기간("오늘부터 4주")은 오늘 날짜로 판정한다. 픽스처가 2026-09-30 기준이라 Date 만 그날로 고정한다.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-30T01:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); });
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalRoomRelay } from './merryhere-local-relay.mjs';
import { localStore } from './merryhere-local-store.mjs';
import { executeLocalRoomCommand } from './merryhere-local-executor.mjs';
import { memoryDb } from './slack-test-store.mjs';
import { localResultSchema } from './merryhere-local-contract.mjs';
import { createSlackWorker } from './slack-runtime.mjs';
import express from 'express';
import request from 'supertest';
import { mountLocalRoomRelay } from './merryhere-local-relay.mjs';
import { parseCalendar } from './merryhere-client.mjs';

const token = 'a'.repeat(64), code = 'b'.repeat(32);
const accountKey = 'e'.repeat(32);
const actor = { tenantId: 'mysc', actorId: 'member' };
async function connect(relay) {
  await relay.pair(actor, code);
  const { pending } = await relay.poll(token, true, accountKey);
  await relay.approve(token, pending.requestId, true);
}
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
  expect((await f.relay.connection(actor)).issue).toBe('local_not_connected');
  const { pending } = await f.relay.poll(token, false);
  await f.relay.approve(token, pending.requestId, true);
  await f.relay.poll(token, false);
  expect((await f.relay.connection(actor)).issue).toBe('local_login_required');
  await f.relay.poll(token, true, accountKey);
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

it('requires local approval even if another Slack member captures the public code', async () => {
  const f = await fixture();
  f.records.set('orgs/mysc/members/other', { status: 'ACTIVE', email: 'other@example.test' });
  const otherActor = { ...actor, actorId: 'other' };
  await f.relay.pair(otherActor, code);
  expect((await f.relay.connection(otherActor)).issue).toBe('local_not_connected');
  const { pending } = await f.relay.poll(token, false);
  expect(pending.email).toBe('other@example.test');
  await f.relay.approve(token, pending.requestId, false);
  expect((await f.relay.connection(otherActor)).issue).toBe('local_not_connected');
  await expect(f.relay.poll(token, false)).rejects.toThrow('local_unauthorized');
});

it('rechecks revocation within the command claim transaction', async () => {
  const f = await fixture(); await connect(f.relay); await f.relay.poll(token, true, accountKey);
  const connection = await f.relay.connection(actor);
  const path = `merryhere_local_devices/${connection.deviceId}`;
  const original = f.db.runTransaction;
  f.db.runTransaction = async fn => {
    f.records.set(path, { ...f.records.get(path), expiresAt: 0 });
    return original(fn);
  };
  await expect(f.relay.poll(token, true, accountKey)).rejects.toThrow('local_unauthorized');
});

it('exposes relay endpoints under the existing API rewrite and denies missing capabilities', async () => {
  const f = await fixture(), app = express(); app.use(express.json()); mountLocalRoomRelay(app, f.relay);
  await request(app).post('/api/v1/merryhere/local/poll').send({ sessionReady: true }).expect(401);
  const reply = await request(app).post('/api/v1/merryhere/local/poll').set('authorization', `Bearer ${token}`).send({ sessionReady: false }).expect(200);
  expect(reply.body.paired).toBe(false);
});

it('claims commands once and rejects cross-device results and secret-bearing results', async () => {
  const f = await fixture(); await connect(f.relay); await f.relay.poll(token, true, accountKey);
  const connection = await f.relay.connection(actor);
  const id = '12345678-1234-1234-1234-123456789012';
  const path = `merryhere_local_devices/${connection.deviceId}/commands/${id}`;
  f.records.set(path, { deviceId: connection.deviceId, state: 'QUEUED', expiresAt: f.now() + 10000, payload: { op: 'login' } });
  expect((await f.relay.poll(token, true, accountKey)).command.id).toBe(id);
  expect((await f.relay.poll(token, true, accountKey)).command).toBeNull();
  const other = 'c'.repeat(64); await f.relay.register(other, 'd'.repeat(32));
  await expect(f.relay.complete(other, id, { ok: true, value: null })).rejects.toThrow();
  await expect(f.relay.complete(token, id, { ok: true, value: null, cookies: 'secret' })).rejects.toThrow();
  await f.relay.complete(token, id, { ok: true, value: null });
  await expect(f.relay.complete(token, id, { ok: true, value: null })).rejects.toThrow();
});

it('relays typed results and cleans commands without returning CSRF', async () => {
  const f = await fixture(); await connect(f.relay); await f.relay.poll(token, true, accountKey);
  const connection = await f.relay.connection(actor);
  const live = createLocalRoomRelay({ db: f.db, now: f.now, sleep: async () => {
    const { command } = await f.relay.poll(token, true, accountKey);
    if (command) await f.relay.complete(token, command.id, { ok: true, value: null });
  } });
  await live.client(connection).login();
  expect([...f.records.keys()].some(key => key.includes('/commands/'))).toBe(false);
  expect(localResultSchema({ op: 'calendar' }).safeParse({ ok: true, value: { date: '2026-09-30', slots: [], token: 'csrf' } }).success).toBe(false);
});

const calendar = '<a href="https://merryhere.kr/auth/logout">out</a><input id="sel-date" value="2026-09-30"><button id="btn-reservation" data-date="2026-09-30"></button><form action="/reserve" method="post"><input name="_token" value="private-csrf"></form><input name="slot" value="9-0-8" data-name="3A" data-cnt="8" data-time="09:00" data-time2="09:30" data-list-id="" class="">';
it('rejects wrong dates, duplicate slots, malformed intervals and contradictory availability', () => {
  const parsed = parseCalendar(calendar, '2026-09-30');
  const valid = { date: parsed.date, slots: parsed.slots }, schema = localResultSchema({ op: 'calendar', date: parsed.date });
  expect(schema.safeParse({ ok: true, value: valid }).success).toBe(true);
  for (const value of [{ ...valid, date: '2026-10-01' }, { ...valid, slots: [valid.slots[0], valid.slots[0]] },
    { ...valid, slots: [{ ...valid.slots[0], end: '10:00' }] }, { ...valid, slots: [{ ...valid.slots[0], reservationId: '7' }] }]) {
    expect(schema.safeParse({ ok: true, value }).success).toBe(false);
  }
});

it('pairs through Slack without a model call and routes subsequent reads to the local runner', async () => {
  const { db, records } = memoryDb(), relay = createLocalRoomRelay({ db });
  records.set('orgs/mysc/members/member', { email: 'qa@mysc.co.kr', role: 'finance', status: 'ACTIVE' });
  await relay.register(token, code);
  const identity = { teamId: 'T099F304GAY', channelId: 'C0BQ6980HR6', slackUserId: 'UQA', threadTs: '1.1' };
  const enqueue = (id, question) => records.set(`settlement_agent_jobs/${id}`, { ...identity, question, status: 'queued', attempts: 0, createdAt: new Date().toISOString() });
  const completeFactory = vi.fn(() => async () => ({ tool_calls: [{ id: 'room', function: { name: 'merryhere_rooms', arguments: JSON.stringify({ action: 'explore', inherit: false, query: { date: '2026-09-30' }, missing: [] }) } }] }));
  const fetchImpl = vi.fn(async (url) => {
    if (!url.startsWith('https://slack.com/')) throw new Error('server must not access Merryhere');
    return Response.json(url.includes('users.info') ? { ok: true, user: { team_id: identity.teamId, profile: { email: 'qa@mysc.co.kr' } } } : { ok: true, ts: '2.1', message_ts: '3.1' });
  });
  const worker = createSlackWorker({ db, env: { MERRYHERE_EXECUTION_MODE: 'local', SLACK_ALERT_BOT_TOKEN: 'fixture', SETTLEMENT_AGENT_GEMINI_API_KEY: 'fixture' }, completeFactory, fetchImpl });
  enqueue('pair', `회의실 로컬 연결 ${code}`); await worker();
  expect(completeFactory).not.toHaveBeenCalled();
  const { pending } = await relay.poll(token, true, accountKey);
  await relay.approve(token, pending.requestId, true); await relay.poll(token, true, accountKey);
  let busy = false;
  const errors = [];
  const timer = setInterval(async () => {
    if (busy) return; busy = true;
    try {
      const { command } = await relay.poll(token, true, accountKey);
      if (command) {
        const parsed = parseCalendar(calendar, '2026-09-30');
        await relay.complete(token, command.id, { ok: true, value: command.payload.op === 'calendar' ? { date: parsed.date, slots: parsed.slots } : null });
      }
    } catch (error) { errors.push(error); } finally { busy = false; }
  }, 10);
  try { enqueue('read', '내일 가능한 회의실'); await worker(); }
  finally { clearInterval(timer); }
  expect(errors).toEqual([]);
  expect(records.get('settlement_agent_jobs/read').answer).toContain('예약 가능 시간');
  expect(completeFactory).toHaveBeenCalledTimes(1);
  expect(JSON.stringify([...records])).not.toContain('private-csrf');
  expect(fetchImpl.mock.calls.every(([url]) => url.startsWith('https://slack.com/'))).toBe(true);
});
it('keeps sessions local and prevents a second POST after a timeout or restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'merryhere-test-'));
  try {
    const store = await localStore(directory);
    await store.write('session.json', { cookies: { laravel_session: 'private-cookie' }, accountKey });
    const clock = Date.parse('2026-09-29T09:00:00+09:00');
    let posts = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/reserve')) { posts++; throw new Error('timeout'); }
      return new Response(calendar);
    });
    const read = await executeLocalRoomCommand({ command: { accountKey, payload: { op: 'calendar', date: '2026-09-30' }, expiresAt: clock + 10000 }, store, fetchImpl, now: () => clock });
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read)).not.toMatch(/private-cookie|private-csrf|token/);
    expect((await executeLocalRoomCommand({ command: { accountKey: 'f'.repeat(32), payload: { op: 'login' }, expiresAt: clock + 10000 }, store, fetchImpl, now: () => clock })).code).toBe('local_account_changed');
    const payload = { op: 'reserve', intent: { id: 'a'.repeat(24), date: '2026-09-30', start: '09:00', end: '09:30', roomId: '9', ordinals: [0], points: 8, capacity: 4, providerTitle: '회의' } };
    const command = { payload, accountKey, expiresAt: clock + 10000 };
    expect((await executeLocalRoomCommand({ command, store, fetchImpl, now: () => clock, authorizeWrite: async () => {} })).ok).toBe(false);
    const restarted = await localStore(directory);
    expect((await executeLocalRoomCommand({ command, store: restarted, fetchImpl, now: () => clock })).code).toBe('local_uncertain');
    expect(posts).toBe(1);
    expect((await stat(join(directory, 'session.json'))).mode & 0o777).toBe(0o600);
    await symlink(join(directory, 'session.json'), join(directory, 'link.json'));
    await expect(store.read('link.json')).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
