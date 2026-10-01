import { parseIcsEvents, busyIntervalsForDate } from './ics-calendar.mjs';
import { availableRoomWindows, WORKING_HOURS } from './merryhere-request.mjs';

// Live room feeds include years of history (3.8–5.8 MB); bound reads before buffering.
const MAX_BYTES = 16 * 1024 * 1024;
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
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('calendar_response_large'); }
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('calendar_response_large');
  }
  if (!/^BEGIN:VCALENDAR\r?$/m.test(text) || !/^END:VCALENDAR\r?$/m.test(text)) throw new Error('calendar_format_changed');
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
  async function readForDate(date, query) {
    const windows = [], checks = [];
    for (const room of rooms) {
      if (!matches(room.name, query.room)) continue;
      try {
        const events = await eventsFor(room);
        const calendar = { date, slots: slotsForRoom(room, busyIntervalsForDate({ events, date })) };
        const found = availableRoomWindows(calendar, { ...query, room: room.name }, now());
        windows.push(...found);
        checks.push({ room: room.name, status: query.capacity && room.capacity === null ? 'capacity_unknown' : 'checked', windows: found });
      } catch { checks.push({ room: room.name, status: 'failed', windows: [] }); }
    }
    if (query.room && !checks.length) checks.push({ room: query.room, status: 'not_configured', windows: [] });
    return { windows: windows.sort((a, b) => a.start.localeCompare(b.start) || a.room.localeCompare(b.room)), checks };
  }
  return {
    available: rooms.length > 0,
    roomNames: rooms.map(room => room.name),
    findRoom(text) { return text ? rooms.find(room => matches(room.name, text)) || null : null; },
    readForDate,
    async windowsForDate(date, query) { return (await readForDate(date, query)).windows; },
  };
}

export function renderGoogleRoomChecks(checks) {
  return checks.map(check => {
    if (check.status === 'failed') return `${check.room}: 캘린더 조회 실패로 가능 여부를 확인하지 못했습니다.`;
    if (check.status === 'not_configured') return `${check.room}: 연결된 캘린더가 없어 가능 여부를 확인하지 못했습니다.`;
    if (check.status === 'capacity_unknown') return `${check.room}: 정원 정보가 없어 요청 인원 수용 여부를 확인하지 못했습니다.`;
    return `${check.room}: ${check.windows.length ? check.windows.map(w => `${w.start}~${w.end}`).join(', ') + ' 일정상 비어 있음' : '요청 조건에 맞는 빈 시간 없음'} (Google Calendar 조회 기준 · 예약은 Calendar에서 직접 진행)`;
  });
}
