import { describe, it, expect } from 'vitest';
import { parseIcsEvents, busyIntervalsForDate } from './ics-calendar.mjs';

const vevent = (lines) => ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const busy = (ics, date) => busyIntervalsForDate({ events: parseIcsEvents(ics), date });

describe('parseIcsEvents', () => {
  it('unfolds continuation lines before reading properties', () => {
    const ics = vevent(['UID:fold1', 'SUMMARY:Long meeting nam\r\n e that wraps', 'DTSTART;TZID=Asia/Seoul:20260928T090000', 'DTEND;TZID=Asia/Seoul:20260928T100000']);
    expect(parseIcsEvents(ics)[0].summary).toBe('Long meeting name that wraps');
  });
  it('drops events without a start time rather than guessing one', () => {
    expect(parseIcsEvents(vevent(['UID:no-start']))).toHaveLength(0);
  });
});

describe('busyIntervalsForDate — single and cancelled events', () => {
  it('reports a plain event only on the day it overlaps, clipped to that day', () => {
    const ics = vevent(['UID:single', 'DTSTART;TZID=Asia/Seoul:20260928T090000', 'DTEND;TZID=Asia/Seoul:20260928T103000']);
    expect(busy(ics, '2026-09-28')).toEqual([{ start: '09:00', end: '10:30' }]);
    expect(busy(ics, '2026-09-29')).toEqual([]);
  });
  it('excludes a cancelled event and a transparent (free) event', () => {
    const ics = vevent(['UID:cancelled', 'DTSTART;TZID=Asia/Seoul:20260928T090000', 'DTEND;TZID=Asia/Seoul:20260928T100000', 'STATUS:CANCELLED']);
    expect(busy(ics, '2026-09-28')).toEqual([]);
    const free = vevent(['UID:free', 'DTSTART;TZID=Asia/Seoul:20260928T090000', 'DTEND;TZID=Asia/Seoul:20260928T100000', 'TRANSP:TRANSPARENT']);
    expect(busy(free, '2026-09-28')).toEqual([]);
  });
  it('converts a UTC (Z) start into KST', () => {
    const ics = vevent(['UID:utc', 'DTSTART:20260928T000000Z', 'DTEND:20260928T010000Z']);
    expect(busy(ics, '2026-09-28')).toEqual([{ start: '09:00', end: '10:00' }]);
  });
  it('blocks the full day for an all-day event and nothing on adjacent days', () => {
    const ics = vevent(['UID:allday', 'DTSTART;VALUE=DATE:20261010', 'DTEND;VALUE=DATE:20261011']);
    expect(busy(ics, '2026-10-10')).toEqual([{ start: '00:00', end: '24:00' }]);
    expect(busy(ics, '2026-10-09')).toEqual([]);
    expect(busy(ics, '2026-10-11')).toEqual([]);
  });
});

describe('busyIntervalsForDate — recurrence', () => {
  const weeklyMWF = vevent(['UID:weekly', 'DTSTART;TZID=Asia/Seoul:20260928T090000', 'DTEND;TZID=Asia/Seoul:20260928T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR']);
  it.each([['2026-09-28', true], ['2026-09-29', false], ['2026-09-30', true], ['2026-10-02', true], ['2026-10-03', false]])('WEEKLY BYDAY MO,WE,FR on %s -> %s', (date, expected) => {
    expect(busy(weeklyMWF, date)).toEqual(expected ? [{ start: '09:00', end: '10:00' }] : []);
  });
  it('never occurs before DTSTART', () => {
    expect(busy(weeklyMWF, '2026-09-21')).toEqual([]);
  });
  it('WEEKLY with INTERVAL=2 skips the alternating week', () => {
    const ics = vevent(['UID:biweekly', 'DTSTART;TZID=Asia/Seoul:20260928T090000', 'DTEND;TZID=Asia/Seoul:20260928T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO;INTERVAL=2']);
    expect(busy(ics, '2026-09-28')).toHaveLength(1);
    expect(busy(ics, '2026-10-05')).toEqual([]);
    expect(busy(ics, '2026-10-12')).toHaveLength(1);
  });
  it('DAILY with INTERVAL and COUNT stops after the last occurrence', () => {
    const ics = vevent(['UID:daily', 'DTSTART;TZID=Asia/Seoul:20261001T130000', 'DTEND;TZID=Asia/Seoul:20261001T140000', 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3']);
    expect(busy(ics, '2026-10-01')).toHaveLength(1);
    expect(busy(ics, '2026-10-03')).toHaveLength(1);
    expect(busy(ics, '2026-10-05')).toHaveLength(1);
    expect(busy(ics, '2026-10-07')).toEqual([]);
    expect(busy(ics, '2026-10-02')).toEqual([]);
  });
  it('MONTHLY BYDAY ordinal finds the correct Nth and last weekday', () => {
    const secondFriday = vevent(['UID:m2', 'DTSTART;TZID=Asia/Seoul:20261009T150000', 'DTEND;TZID=Asia/Seoul:20261009T160000', 'RRULE:FREQ=MONTHLY;BYDAY=2FR']);
    expect(busy(secondFriday, '2026-10-09')).toHaveLength(1);
    expect(busy(secondFriday, '2026-11-13')).toHaveLength(1);
    expect(busy(secondFriday, '2026-10-16')).toEqual([]);
    const lastMonday = vevent(['UID:mlast', 'DTSTART;TZID=Asia/Seoul:20261026T150000', 'DTEND;TZID=Asia/Seoul:20261026T160000', 'RRULE:FREQ=MONTHLY;BYDAY=-1MO']);
    expect(busy(lastMonday, '2026-10-26')).toHaveLength(1);
    expect(busy(lastMonday, '2026-11-30')).toHaveLength(1);
  });
  it('MONTHLY BYMONTHDAY skips a month where that day does not exist, without shifting', () => {
    const ics = vevent(['UID:m31', 'DTSTART;TZID=Asia/Seoul:20260131T090000', 'DTEND;TZID=Asia/Seoul:20260131T100000', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=31']);
    expect(busy(ics, '2026-01-31')).toHaveLength(1);
    expect(busy(ics, '2026-02-28')).toEqual([]);
    expect(busy(ics, '2026-03-31')).toHaveLength(1);
  });
  it('EXDATE removes exactly one occurrence and leaves the rest', () => {
    const ics = vevent(['UID:ex', 'DTSTART;TZID=Asia/Seoul:20260928T090000', 'DTEND;TZID=Asia/Seoul:20260928T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=Asia/Seoul:20261005T090000']);
    expect(busy(ics, '2026-09-28')).toHaveLength(1);
    expect(busy(ics, '2026-10-05')).toEqual([]);
    expect(busy(ics, '2026-10-12')).toHaveLength(1);
  });
  it('a RECURRENCE-ID override moves one instance without duplicating or losing it', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT', 'UID:series', 'DTSTART;TZID=Asia/Seoul:20260928T090000', 'DTEND;TZID=Asia/Seoul:20260928T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:series', 'RECURRENCE-ID;TZID=Asia/Seoul:20261012T090000', 'DTSTART;TZID=Asia/Seoul:20261012T140000', 'DTEND;TZID=Asia/Seoul:20261012T150000', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(busy(ics, '2026-10-12')).toEqual([{ start: '14:00', end: '15:00' }]);
    expect(busy(ics, '2026-10-19')).toEqual([{ start: '09:00', end: '10:00' }]);
  });
  it('a cancelled RECURRENCE-ID override removes that single instance', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT', 'UID:series2', 'DTSTART;TZID=Asia/Seoul:20260928T090000', 'DTEND;TZID=Asia/Seoul:20260928T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:series2', 'RECURRENCE-ID;TZID=Asia/Seoul:20261012T090000', 'DTSTART;TZID=Asia/Seoul:20261012T090000', 'DTEND;TZID=Asia/Seoul:20261012T100000', 'STATUS:CANCELLED', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(busy(ics, '2026-10-12')).toEqual([]);
    expect(busy(ics, '2026-10-19')).toEqual([{ start: '09:00', end: '10:00' }]);
  });
  it('fails closed (busy every day from DTSTART) for an unsupported RRULE shape', () => {
    const ics = vevent(['UID:unsupported', 'DTSTART;TZID=Asia/Seoul:20261001T090000', 'DTEND;TZID=Asia/Seoul:20261001T100000', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1']);
    expect(busy(ics, '2026-09-30')).toEqual([]);
    expect(busy(ics, '2026-10-01')).toEqual([{ start: '00:00', end: '24:00' }]);
    expect(busy(ics, '2027-06-15')).toEqual([{ start: '00:00', end: '24:00' }]);
  });
  it('fails closed for a non-Asia/Seoul TZID rather than silently misreading the offset', () => {
    const ics = vevent(['UID:othertz', 'DTSTART;TZID=America/New_York:20261001T090000', 'DTEND;TZID=America/New_York:20261001T100000']);
    expect(busy(ics, '2026-10-01')).toEqual([{ start: '00:00', end: '24:00' }]);
  });
});
