import { describe, it, expect, vi } from 'vitest';
import { createGoogleCalendarRooms, parseCalendarRoomsConfig } from './google-calendar-rooms.mjs';

const vevent = (lines) => ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const floor8 = { name: '8층 회의실', icsUrl: 'https://calendar.google.com/calendar/ical/floor8/private-abc/basic.ics', capacity: 10 };
const floor6 = { name: '6층 회의실', icsUrl: 'https://calendar.google.com/calendar/ical/floor6/private-def/basic.ics', capacity: null };
const env = { GOOGLE_CALENDAR_ROOMS_JSON: JSON.stringify([floor8, floor6]) };

describe('parseCalendarRoomsConfig', () => {
  it('keeps only https calendar.google.com entries with a usable name', () => {
    const rooms = parseCalendarRoomsConfig({ GOOGLE_CALENDAR_ROOMS_JSON: JSON.stringify([
      floor8,
      { name: 'evil', icsUrl: 'http://calendar.google.com/x' },
      { name: 'evil2', icsUrl: 'https://attacker.example/x' },
      { name: '', icsUrl: floor6.icsUrl },
      { icsUrl: floor6.icsUrl },
      'not-an-object',
    ]) });
    expect(rooms).toEqual([{ name: '8층 회의실', icsUrl: floor8.icsUrl, capacity: 10 }]);
  });
  it('returns an empty list for missing or malformed config, never throwing', () => {
    expect(parseCalendarRoomsConfig({})).toEqual([]);
    expect(parseCalendarRoomsConfig({ GOOGLE_CALENDAR_ROOMS_JSON: 'not json' })).toEqual([]);
    expect(parseCalendarRoomsConfig({ GOOGLE_CALENDAR_ROOMS_JSON: '{}' })).toEqual([]);
  });
  it('drops an out-of-range or non-integer capacity instead of trusting it', () => {
    const rooms = parseCalendarRoomsConfig({ GOOGLE_CALENDAR_ROOMS_JSON: JSON.stringify([{ ...floor8, capacity: 0 }, { ...floor6, capacity: 4.5 }]) });
    expect(rooms.map((r) => r.capacity)).toEqual([null, null]);
  });
});

function fetchFor(byUrl) {
  return vi.fn(async (url) => {
    const ics = byUrl[url];
    if (ics === undefined) throw new Error('unexpected url ' + url);
    return { ok: true, text: async () => ics };
  });
}

describe('createGoogleCalendarRooms', () => {
  it('is unavailable and inert with no configured calendars', async () => {
    const rooms = createGoogleCalendarRooms({ env: {}, fetchImpl: vi.fn() });
    expect(rooms.available).toBe(false);
    expect(rooms.findRoom('8층')).toBeNull();
    expect(await rooms.windowsForDate('2026-09-30', {})).toEqual([]);
  });

  it('lists free windows across both rooms, merged and sorted by start time', async () => {
    const fetchImpl = fetchFor({
      [floor8.icsUrl]: vevent(['UID:f8', 'DTSTART;TZID=Asia/Seoul:20260930T080000', 'DTEND;TZID=Asia/Seoul:20260930T093000']),
      [floor6.icsUrl]: vevent(['UID:f6', 'DTSTART;TZID=Asia/Seoul:20260930T080000', 'DTEND;TZID=Asia/Seoul:20260930T100000']),
    });
    const rooms = createGoogleCalendarRooms({ env, fetchImpl, now: () => Date.parse('2026-09-30T00:00:00+09:00') });
    const windows = await rooms.windowsForDate('2026-09-30', {});
    expect(windows.map((w) => ({ room: w.room, capacity: w.capacity, start: w.start, end: w.end }))).toEqual([
      { room: '8층 회의실', capacity: 10, start: '09:30', end: '19:00' },
      { room: '6층 회의실', capacity: null, start: '10:00', end: '19:00' },
    ]);
  });

  it('matches a bare keyword against the configured name in either direction', () => {
    const rooms = createGoogleCalendarRooms({ env, fetchImpl: vi.fn() });
    expect(rooms.findRoom('8층')?.name).toBe('8층 회의실');
    expect(rooms.findRoom('8층 회의실')?.name).toBe('8층 회의실');
    expect(rooms.findRoom('3A')).toBeNull();
  });

  it('excludes a room from a capacity-filtered search when its capacity is unknown', async () => {
    const fetchImpl = fetchFor({ [floor6.icsUrl]: vevent(['UID:f6', 'DTSTART;TZID=Asia/Seoul:20260930T090000', 'DTEND;TZID=Asia/Seoul:20260930T100000']) });
    const rooms = createGoogleCalendarRooms({ env: { GOOGLE_CALENDAR_ROOMS_JSON: JSON.stringify([floor6]) }, fetchImpl, now: () => Date.parse('2026-09-30T00:00:00+09:00') });
    expect(await rooms.windowsForDate('2026-09-30', { capacity: 4 })).toEqual([]);
    expect(await rooms.windowsForDate('2026-09-30', {})).not.toEqual([]);
  });

  it('only fetches the calendars matching a requested room name', async () => {
    const fetchImpl = fetchFor({ [floor8.icsUrl]: vevent(['UID:f8', 'DTSTART;TZID=Asia/Seoul:20260930T090000', 'DTEND;TZID=Asia/Seoul:20260930T100000']) });
    const rooms = createGoogleCalendarRooms({ env, fetchImpl, now: () => Date.parse('2026-09-30T00:00:00+09:00') });
    await rooms.windowsForDate('2026-09-30', { room: '8층' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(floor8.icsUrl);
  });

  it('caches a calendar fetch within cacheMs and refetches after it expires', async () => {
    const fetchImpl = fetchFor({ [floor8.icsUrl]: vevent(['UID:f8', 'DTSTART;TZID=Asia/Seoul:20260930T090000', 'DTEND;TZID=Asia/Seoul:20260930T100000']), [floor6.icsUrl]: vevent(['UID:f6', 'DTSTART;TZID=Asia/Seoul:20260930T090000', 'DTEND;TZID=Asia/Seoul:20260930T100000']) });
    let clock = 0;
    const rooms = createGoogleCalendarRooms({ env, fetchImpl, now: () => clock, cacheMs: 1000 });
    await rooms.windowsForDate('2026-09-30', {});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    clock = 500;
    await rooms.windowsForDate('2026-09-30', {});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    clock = 1500;
    await rooms.windowsForDate('2026-09-30', {});
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('skips a room whose calendar fetch fails rather than throwing the whole search', async () => {
    const fetchImpl = vi.fn(async (url) => url === floor8.icsUrl
      ? { ok: true, text: async () => vevent(['UID:f8', 'DTSTART;TZID=Asia/Seoul:20260930T090000', 'DTEND;TZID=Asia/Seoul:20260930T100000']) }
      : { ok: false });
    const rooms = createGoogleCalendarRooms({ env, fetchImpl, now: () => Date.parse('2026-09-30T00:00:00+09:00') });
    const windows = await rooms.windowsForDate('2026-09-30', {});
    expect(windows.every((w) => w.room === '8층 회의실')).toBe(true);
  });

  it('rejects an oversized calendar response instead of parsing it', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => 'X'.repeat(2000001) }));
    const rooms = createGoogleCalendarRooms({ env: { GOOGLE_CALENDAR_ROOMS_JSON: JSON.stringify([floor8]) }, fetchImpl, now: () => Date.parse('2026-09-30T00:00:00+09:00') });
    expect(await rooms.windowsForDate('2026-09-30', {})).toEqual([]);
  });
});

it('distinguishes provider failure, unconfigured room and a genuinely occupied interval', async () => {
  const rooms = createGoogleCalendarRooms({ env, fetchImpl: vi.fn(async url => url === floor6.icsUrl ? new Response('unavailable', { status: 403 }) : new Response(vevent(['UID:busy', 'DTSTART;TZID=Asia/Seoul:20261001T110000', 'DTEND;TZID=Asia/Seoul:20261001T120000']))), now: () => Date.parse('2026-09-30T00:00:00+09:00') });
  const result = await rooms.readForDate('2026-10-01', { start: '11:00', end: '12:00', duration: 60 });
  expect(result.windows).toEqual([]);
  expect(result.checks).toEqual(expect.arrayContaining([{ room: floor6.name, status: 'failed', windows: [] }, { room: floor8.name, status: 'checked', windows: [] }]));
  expect((await rooms.readForDate('2026-10-01', { room: '10층' })).checks[0].status).toBe('not_configured');
});
it('never treats an HTML login response as an empty, available calendar', async () => {
  const rooms = createGoogleCalendarRooms({ env, fetchImpl: async () => new Response('<html>login</html>') });
  const result = await rooms.readForDate('2026-10-01', {});
  expect(result.windows).toEqual([]);
  expect(result.checks.every(c => c.status === 'failed')).toBe(true);
});

it('reads a valid historical feed larger than 2 MB and still enforces a streaming ceiling', async () => {
  const large = vevent(['UID:busy', 'DTSTART;TZID=Asia/Seoul:20261001T130000', 'DTEND;TZID=Asia/Seoul:20261001T140000', 'DESCRIPTION:' + 'x'.repeat(6000000)]);
  const rooms = createGoogleCalendarRooms({ env: { GOOGLE_CALENDAR_ROOMS_JSON: JSON.stringify([floor6]) }, fetchImpl: async () => new Response(large), now: () => Date.parse('2026-09-30T00:00:00+09:00') });
  expect((await rooms.readForDate('2026-10-01', { start: '11:00', end: '12:00', duration: 60 })).windows).toHaveLength(1);
  const cancel = vi.fn();
  const blocked = createGoogleCalendarRooms({ env, fetchImpl: async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel })) });
  const result = await blocked.readForDate('2026-10-01', {});
  expect(result.windows).toEqual([]);
  expect(result.checks.every(x => x.status === 'failed')).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(2);
});
