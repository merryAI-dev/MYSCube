import { createMerryhereClient, MerryhereError, kstDate, selectBookingSlots, validateBookingTime } from './merryhere-client.mjs';
import { localCommandSchema, localErrors, localResultSchema } from './merryhere-local-contract.mjs';

export async function executeLocalRoomCommand({ command, store, fetchImpl = fetch, now = Date.now, authorizeWrite = async () => { throw new MerryhereError('transport_error'); } }) {
  let payload;
  try {
    payload = localCommandSchema.parse(command.payload);
    if (command.expiresAt <= now()) throw new MerryhereError('transport_error');
    const session = await store.read('session.json');
    if (!session?.cookies || !Object.keys(session.cookies).length) throw new MerryhereError('login_required');
    if (!session.accountKey || command.accountKey !== session.accountKey) throw new MerryhereError('local_account_changed');
    const client = createMerryhereClient({ sessionCookies: session.cookies, fetchImpl,
      saveSession: async cookies => {
        if ((await store.read('session.json'))?.accountKey === session.accountKey) await store.write('session.json', { ...session, cookies });
      } });
    let value = null;
    if (payload.op === 'login') await client.login();
    if (payload.op === 'calendar') {
      const calendar = await client.calendar(payload.date);
      value = { date: calendar.date, slots: calendar.slots };
    }
    if (payload.op === 'reservation') {
      const calendar = await client.calendar(kstDate(now()));
      const detail = await client.reservation(payload.id, calendar.token);
      value = { name: detail.name, title: detail.title, price: Number(detail.price) };
    }
    if (payload.op === 'reserve') {
      const intent = payload.intent, ledger = `reservation-${intent.id}.json`;
      if (await store.read(ledger)) throw new MerryhereError('local_uncertain');
      validateBookingTime(intent, now());
      const calendar = await client.calendar(intent.date), slots = selectBookingSlots(calendar, intent);
      if (slots.some(slot => slot.state !== 'available' || intent.capacity && slot.capacity < intent.capacity)
        || slots.reduce((sum, slot) => sum + slot.points, 0) !== intent.points
        || JSON.stringify(slots.map(slot => slot.ordinal)) !== JSON.stringify(intent.ordinals)) throw new MerryhereError('changed');
      if (command.expiresAt <= now()) throw new MerryhereError('transport_error');
      await authorizeWrite(command.id);
      if (!await store.claim(ledger, { state: 'SUBMITTING', date: intent.date })) throw new MerryhereError('local_uncertain');
      if (command.expiresAt <= now()) throw new MerryhereError('transport_error');
      await client.reserve(calendar, intent);
      await store.write(ledger, { state: 'SUBMITTED', date: intent.date });
    }
    return localResultSchema(payload).parse({ ok: true, value });
  } catch (error) {
    return { ok: false, code: localErrors.safeParse(error.code).success ? error.code : 'provider_error' };
  }
}
