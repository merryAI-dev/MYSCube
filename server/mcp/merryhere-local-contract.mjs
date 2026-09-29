import * as z from 'zod/v4';

const date = z.string().regex(/^20\d{2}-\d{2}-\d{2}$/);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[03]0$/);
export const localCommandSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('login') }).strict(),
  z.object({ op: z.literal('calendar'), date }).strict(),
  z.object({ op: z.literal('reservation'), id: z.string().regex(/^\d+$/) }).strict(),
  z.object({ op: z.literal('reserve'), intent: z.object({
    id: z.string().regex(/^[a-f0-9]{24}$/), date, start: time, end: time,
    roomId: z.string().regex(/^\d+$/), ordinals: z.array(z.number().int().nonnegative()).min(1).max(48),
    providerTitle: z.string().min(1).max(200), points: z.number().int().nonnegative(), capacity: z.number().int().positive().nullable(),
  }).strict() }).strict(),
]);
export const localErrors = z.enum(['login_required', 'login_failed', 'session_expired', 'page_changed', 'date_mismatch',
  'invalid_time', 'past_time', 'date_out_of_range', 'changed', 'slot_missing', 'transport_error', 'provider_error', 'unexpected_redirect', 'local_uncertain', 'local_account_changed']);
const slot = z.object({ roomId: z.string().regex(/^\d+$/), ordinal: z.number().int().nonnegative(), points: z.number().int().nonnegative(),
  name: z.string().max(100), capacity: z.number().int().nonnegative(), start: time, end: time,
  state: z.enum(['booked', 'external', 'blocked', 'available']), reservationId: z.string().max(100).nullable(), owned: z.boolean() }).strict();
export function localResultSchema(command) {
  const value = command.op === 'calendar' ? z.object({ date: z.literal(command.date), slots: z.array(slot).min(1).max(2000) }).strict().refine(calendar => {
    const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    return new Set(calendar.slots.map(s => `${s.roomId}/${s.ordinal}`)).size === calendar.slots.length
      && calendar.slots.every(s => minutes(s.end) - minutes(s.start) === 30 && (s.state !== 'available' || !s.reservationId && !s.owned));
  })
    : command.op === 'reservation' ? z.object({ name: z.string().max(100), title: z.string().max(300), price: z.number().nonnegative() }).strict()
      : z.null();
  return z.union([z.object({ ok: z.literal(true), value }).strict(), z.object({ ok: z.literal(false), code: localErrors }).strict()]);
}
