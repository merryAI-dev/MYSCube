import { createMerryhereClient, MerryhereError, kstDate, selectBookingSlots, validateBookingTime } from './merryhere-client.mjs';
import { localCommandSchema, localErrors, localResultSchema } from './merryhere-local-contract.mjs';

export async function executeLocalRoomCommand({ command, store, fetchImpl = fetch, now = Date.now }) {
  let payload;
  try {
    payload = localCommandSchema.parse(command.payload);
    if (command.expiresAt <= now()) throw new MerryhereError('transport_error');
    const cookies = await store.read('session.json');
    if (!cookies || !Object.keys(cookies).length) throw new MerryhereError('login_required');
    const client = createMerryhereClient({ sessionCookies: cookies, fetchImpl, saveSession: value => store.write('session.json', value) });
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
      if (!await store.claim(ledger, { state: 'SUBMITTING', date: intent.date })) throw new MerryhereError('local_uncertain');
      await client.reserve(calendar, intent);
      await store.write(ledger, { state: 'SUBMITTED', date: intent.date });
    }
    return localResultSchema(payload).parse({ ok: true, value });
  } catch (error) {
    return { ok: false, code: localErrors.safeParse(error.code).success ? error.code : 'provider_error' };
  }
}
