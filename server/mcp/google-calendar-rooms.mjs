import { parseIcsEvents, busyIntervalsForDate } from './ics-calendar.mjs';
import { availableRoomWindows, WORKING_HOURS } from './merryhere-request.mjs';

const MAX_BYTES = 2000000;
const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const timeOf = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// The private ICS address is a bearer credential (RFC5545 "private address"), configured only
// through GOOGLE_CALENDAR_ROOMS_JSON at deploy time, never accepted from a request or logged.
export function parseCalendarRoomsConfig(env = process.env) {
  const raw = env.GOOGLE_CALENDAR_ROOMS_JSON;
  if (!raw || !raw.trim()) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const rooms = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    let url;
    try { url = new URL(item.icsUrl); } catch { continue; }
    if (!name || name.length > 100 || url.protocol !== 'https:' || url.hostname !== 'calendar.google.com') continue;
    const capacity = Number.isInteger(item.capacity) && item.capacity > 0 && item.capacity <= 100 ? item.capacity : null;
    rooms.push({ name, icsUrl: url.href, capacity });
  }
  return rooms;
}

function slotsForRoom(room, busy) {
  const slots = [];
  for (let m = minutesOf(WORKING_HOURS.start), ordinal = 0; m < minutesOf(WORKING_HOURS.end); m += 30, ordinal++) {
    const start = timeOf(m), end = timeOf(m + 30);
    const blocked = busy.some((b) => b.start < end && b.end > start);
    slots.push({ roomId: room.name, name: room.name, capacity: room.capacity, start, end, ordinal, state: blocked ? 'blocked' : 'available' });
  }
  return slots;
}

async function fetchIcsText(url, fetchImpl) {
  let response;
  try { response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(10000) }); }
  catch { throw new Error('calendar_transport_error'); }
  if (!response.ok) throw new Error('calendar_provider_error');
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('calendar_response_large');
  return text;
}

// Read-only: this only reports free/busy from the room's own calendar. Booking still happens
// in Google Calendar directly, since a private ICS feed grants no write access.
export function createGoogleCalendarRooms({ env = process.env, fetchImpl = fetch, now = Date.now, cacheMs = 60000 } = {}) {
  const rooms = parseCalendarRoomsConfig(env);
  const cache = new Map();
  async function eventsFor(room) {
    const cached = cache.get(room.icsUrl);
    if (cached && now() - cached.at < cacheMs) return cached.events;
    const events = parseIcsEvents(await fetchIcsText(room.icsUrl, fetchImpl));
    cache.set(room.icsUrl, { at: now(), events });
    return events;
  }
  const matches = (name, text) => !text || name.includes(text) || text.includes(name);
  return {
    available: rooms.length > 0,
    roomNames: rooms.map((room) => room.name),
    findRoom(text) { return rooms.find((room) => matches(room.name, text)) || null; },
    async windowsForDate(date, query) {
      const windows = [];
      for (const room of rooms) {
        if (!matches(room.name, query.room)) continue;
        let events;
        try { events = await eventsFor(room); } catch { continue; }
        const calendar = { date, slots: slotsForRoom(room, busyIntervalsForDate({ events, date })) };
        windows.push(...availableRoomWindows(calendar, { ...query, room: query.room ? room.name : undefined }, now()));
      }
      return windows.sort((a, b) => a.start.localeCompare(b.start) || a.room.localeCompare(b.room));
    },
  };
}
