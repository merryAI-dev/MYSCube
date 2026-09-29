import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { localCommandSchema, localResultSchema } from './merryhere-local-contract.mjs';
import { MerryhereError } from './merryhere-client.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const pairingPattern = /^[a-f0-9]{32}$/;
const devicePattern = /^[a-f0-9]{64}$/;
const fail = code => { throw new MerryhereError(code); };
export const localPairCode = text => /^\s*회의실\s+로컬\s+연결\s+([a-f0-9]{32})\s*$/.exec(text)?.[1];

export function createLocalRoomRelay({ db, now = Date.now, sleep = delay }) {
  const deviceRef = id => db.doc(`merryhere_local_devices/${id}`);
  const ownerRef = actor => db.doc(`merryhere_local_owners/${hash(`${actor.tenantId}/${actor.actorId}`)}`);
  const commands = id => `merryhere_local_devices/${id}/commands`;
  const jobRef = (deviceId, id) => db.doc(`${commands(deviceId)}/${id}`);
  async function authenticate(token) {
    if (!/^[a-f0-9]{64}$/.test(token || '')) fail('local_unauthorized');
    const id = hash(token), snap = await deviceRef(id).get();
    const device = snap.data();
    if (!device || device.expiresAt < now()) fail('local_unauthorized');
    if (device.actorId) {
      const owner = (await ownerRef(device).get()).data();
      const member = (await db.doc(`orgs/${device.tenantId}/members/${device.actorId}`).get()).data();
      if (owner?.deviceId !== id || member?.status !== 'ACTIVE') fail('local_unauthorized');
    }
    return { ...device, id };
  }
  return {
    async register(token, code) {
      if (!/^[a-f0-9]{64}$/.test(token || '') || !pairingPattern.test(code || '')) fail('local_invalid');
      const id = hash(token), pair = db.doc(`merryhere_local_pairings/${hash(code)}`);
      await db.runTransaction(async tx => {
        const existing = await tx.get(deviceRef(id)), previous = await tx.get(pair);
        if (existing.exists || previous.exists) fail('local_invalid');
        tx.create(deviceRef(id), { expiresAt: now() + 10 * 60000, lastSeenAt: 0, sessionReady: false });
        tx.create(pair, { deviceId: id, expiresAt: now() + 10 * 60000, used: false });
      });
    },
    async pair(actor, code) {
      if (!pairingPattern.test(code)) fail('local_invalid');
      const ref = db.doc(`merryhere_local_pairings/${hash(code)}`);
      await db.runTransaction(async tx => {
        const pairing = (await tx.get(ref)).data();
        if (!pairing || pairing.used || pairing.expiresAt < now()) fail('local_pair_expired');
        const dev = deviceRef(pairing.deviceId);
        if (!(await tx.get(dev)).exists) fail('local_pair_expired');
        tx.update(ref, { used: true });
        tx.update(dev, { tenantId: actor.tenantId, actorId: actor.actorId, expiresAt: now() + 30 * 86400000 });
        tx.set(ownerRef(actor), { deviceId: pairing.deviceId });
      });
    },
    async connection(actor) {
      const owner = (await ownerRef(actor).get()).data();
      if (!owner) return { issue: 'local_not_connected' };
      const device = (await deviceRef(owner.deviceId).get()).data();
      if (!device || device.expiresAt < now() || device.lastSeenAt < now() - 45000) return { issue: 'local_offline' };
      if (!device.sessionReady) return { issue: 'local_login_required' };
      return { deviceId: owner.deviceId, accountKey: owner.deviceId };
    },
    async disconnect(actor) {
      await db.runTransaction(async tx => {
        const owner = (await tx.get(ownerRef(actor))).data();
        if (owner) { tx.update(deviceRef(owner.deviceId), { expiresAt: 0 }); tx.delete(ownerRef(actor)); }
      });
    },
    async poll(token, sessionReady) {
      const device = await authenticate(token);
      await db.runTransaction(async tx => {
        if ((await tx.get(deviceRef(device.id))).exists) tx.update(deviceRef(device.id), { lastSeenAt: now(), sessionReady: sessionReady === true });
      });
      if (!device.actorId) return { paired: false, command: null };
      const candidates = await db.collection(commands(device.id)).where('expiresAt', '>', now()).limit(100).get();
      for (const snap of candidates.docs) {
        const command = await db.runTransaction(async tx => {
          const value = (await tx.get(jobRef(device.id, snap.id))).data();
          if (value?.state !== 'QUEUED' || value.expiresAt <= now()) return null;
          tx.update(jobRef(device.id, snap.id), { state: 'CLAIMED' });
          return { id: snap.id, expiresAt: value.expiresAt, payload: value.payload };
        });
        if (command) return { paired: true, command };
      }
      return { paired: true, command: null };
    },
    async complete(token, id, result) {
      const device = await authenticate(token);
      if (!/^[a-f0-9-]{36}$/.test(id || '')) fail('local_invalid');
      await db.runTransaction(async tx => {
        const ref = jobRef(device.id, id), command = (await tx.get(ref)).data();
        if (!command || command.deviceId !== device.id || command.state !== 'CLAIMED' || command.expiresAt <= now()) fail('local_invalid');
        const safe = localResultSchema(command.payload).parse(result);
        tx.update(ref, { state: 'DONE', result: safe });
      });
    },
    client(connection) {
      async function invoke(payload) {
        if (!devicePattern.test(connection.deviceId)) fail('local_not_connected');
        payload = localCommandSchema.parse(payload);
        const ref = jobRef(connection.deviceId, randomUUID()), expiresAt = now() + 25000;
        await db.runTransaction(async tx => tx.create(ref, { deviceId: connection.deviceId, payload, state: 'QUEUED', expiresAt }));
        try {
          while (now() < expiresAt) {
            const command = (await ref.get()).data();
            if (command?.state === 'DONE') {
              const result = localResultSchema(payload).parse(command.result);
              if (!result.ok) fail(result.code);
              return result.value;
            }
            await sleep(750);
          }
          fail('local_offline');
        } finally {
          await db.runTransaction(async tx => { await tx.get(ref); tx.delete(ref); });
        }
      }
      return {
        login: () => invoke({ op: 'login' }),
        calendar: date => invoke({ op: 'calendar', date }),
        reservation: id => invoke({ op: 'reservation', id }),
        reserve: (_calendar, intent) => invoke({ op: 'reserve', intent: Object.fromEntries(
          ['id', 'date', 'start', 'end', 'roomId', 'ordinals', 'providerTitle', 'points', 'capacity'].map(key => [key, intent[key]])) }),
      };
    },
  };
}

export function mountLocalRoomRelay(app, relay) {
  const registrations = new Map();
  for (const action of ['register', 'poll', 'complete']) app.post(`/api/merryhere/local/${action}`, async (req, res) => {
    try {
      if (Buffer.byteLength(JSON.stringify(req.body || {})) > 256000) return res.status(413).json({ error: 'local_request_too_large' });
      if (action === 'register') {
        const minute = Math.floor(Date.now() / 60000), key = req.ip;
        const prior = registrations.get(key), count = prior?.minute === minute ? prior.count + 1 : 1;
        if (registrations.size >= 1000 && !registrations.has(key)) registrations.clear();
        registrations.set(key, { minute, count });
        if (count > 3) return res.status(429).json({ error: 'local_pair_rate_limited' });
      }
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.header('authorization') || '')?.[1];
      const value = action === 'register' ? await relay.register(token, req.body?.code)
        : action === 'poll' ? await relay.poll(token, req.body?.sessionReady)
          : await relay.complete(token, req.body?.id, req.body?.result);
      res.json(value || { ok: true });
    } catch (error) { res.status(error.code === 'local_unauthorized' ? 401 : 400).json({ error: 'local_request_rejected' }); }
  });
}
