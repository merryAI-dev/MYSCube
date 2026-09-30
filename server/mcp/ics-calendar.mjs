// Minimal RFC5545 (iCalendar) reader, bounded to what a single busy/free check needs.
// No external RRULE library: room calendars only need "is date D an occurrence", which the
// closed-form math below answers directly (verified against rrule.js / ical.js semantics:
// WEEKLY interval steps by 7*interval days from the WKST-aligned week of DTSTART; a MONTHLY
// day that does not exist in a given month is simply skipped, never shifted).
// Korea has no DST, so every timestamp is normalized to a fixed UTC+9 "KST wall clock".

const DAY_MS = 86400000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function kstWallToEpoch(y, mo, d, h = 0, mi = 0, s = 0) {
  return Date.UTC(y, mo - 1, d, h, mi, s) - 9 * 3600000;
}
export function epochToKstParts(epochMs) {
  const d = new Date(epochMs + 9 * 3600000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), weekday: WEEKDAYS[d.getUTCDay()] };
}
const pad = (n, len = 2) => String(n).padStart(len, '0');
export function kstDateKey(epochMs) { const p = epochToKstParts(epochMs); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; }
const timeKey = (h, mi) => `${pad(h)}:${pad(mi)}`;

function unfold(text) {
  return text.replace(/\r\n|\r/g, '\n').split('\n').reduce((lines, line) => {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
    return lines;
  }, []).filter((line) => line.length);
}

function splitProperty(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon), value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(';');
  const params = Object.fromEntries(paramParts.map((part) => {
    const eq = part.indexOf('=');
    return eq < 0 ? [part.toUpperCase(), ''] : [part.slice(0, eq).toUpperCase(), part.slice(eq + 1)];
  }));
  return { name: name.toUpperCase(), params, value };
}

// A bare or TZID-tagged local time is trusted as Asia/Seoul, matching every Korean office
// calendar's own display timezone; an unrecognized TZID is flagged unsupported (see below)
// rather than silently mis-shifted.
function parseDateTime(prop) {
  if (!prop) return null;
  const { params, value } = prop;
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (!m) return null;
    return { epoch: kstWallToEpoch(+m[1], +m[2], +m[3]), allDay: true, unsupported: false };
  }
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (utc) return { epoch: Date.UTC(+utc[1], +utc[2] - 1, +utc[3], +utc[4], +utc[5], +utc[6]), allDay: false, unsupported: false };
  const local = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!local) return null;
  const knownTz = !params.TZID || /^Asia\/Seoul$/i.test(params.TZID);
  return { epoch: kstWallToEpoch(+local[1], +local[2], +local[3], +local[4], +local[5], +local[6]), allDay: false, unsupported: !knownTz };
}

function parseRrule(value) {
  const parts = Object.fromEntries(value.split(';').map((part) => part.split('=')));
  const freq = parts.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return { unsupported: true };
  if (parts.BYSETPOS || parts.BYWEEKNO || parts.BYYEARDAY || (parts.BYMONTHDAY && parts.BYMONTHDAY.includes(','))) return { unsupported: true };
  const interval = Math.max(1, parseInt(parts.INTERVAL || '1', 10));
  if (!Number.isFinite(interval)) return { unsupported: true };
  const byday = parts.BYDAY ? parts.BYDAY.split(',').map((token) => {
    const m = /^(-?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token);
    return m ? { n: m[1] ? Number(m[1]) : null, day: m[2] } : null;
  }) : null;
  if (byday?.some((d) => d === null)) return { unsupported: true };
  const bymonthday = parts.BYMONTHDAY ? Number(parts.BYMONTHDAY) : null;
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  const until = parts.UNTIL ? parseDateTime({ params: {}, value: parts.UNTIL })?.epoch ?? null : null;
  const wkst = WEEKDAYS.includes(parts.WKST) ? parts.WKST : 'MO';
  return { unsupported: false, freq, interval, byday, bymonthday, count, until, wkst };
}

export function parseIcsEvents(text) {
  const lines = unfold(text);
  const events = [];
  let current = null;
  for (const raw of lines) {
    if (raw === 'BEGIN:VEVENT') { current = { exdates: [] }; continue; }
    if (raw === 'END:VEVENT') { if (current) events.push(current); current = null; continue; }
    if (!current) continue;
    const prop = splitProperty(raw);
    if (!prop) continue;
    switch (prop.name) {
      case 'UID': current.uid = prop.value; break;
      case 'DTSTART': current.dtstart = parseDateTime(prop); break;
      case 'DTEND': current.dtend = parseDateTime(prop); break;
      case 'RECURRENCE-ID': current.recurrenceId = parseDateTime(prop); break;
      case 'RRULE': current.rrule = parseRrule(prop.value); break;
      case 'STATUS': current.status = prop.value.toUpperCase(); break;
      case 'TRANSP': current.transparent = prop.value.toUpperCase() === 'TRANSPARENT'; break;
      case 'SUMMARY': current.summary = prop.value; break;
      case 'EXDATE': for (const token of prop.value.split(',')) { const parsed = parseDateTime({ ...prop, value: token }); if (parsed) current.exdates.push(parsed.epoch); } break;
      default: break;
    }
  }
  return events.filter((event) => event.dtstart);
}

function busy(event) { return event.status !== 'CANCELLED' && !event.transparent; }
function kstDayStart(epochMs) { const p = epochToKstParts(epochMs); return kstWallToEpoch(p.y, p.mo, p.d); }

// Occurrence-count formulas mirror rrule.js's own approach (jump by whole periods from the
// WKST-aligned anchor) so COUNT/UNTIL/INTERVAL agree with it without iterating occurrences.
function weeklyOccurrencesOnDate(event, targetEpoch) {
  const rule = event.rrule, start = epochToKstParts(event.dtstart.epoch), target = epochToKstParts(targetEpoch);
  const days = rule.byday?.map((d) => d.day) || [start.weekday];
  if (!days.includes(target.weekday)) return null;
  const weekdayIndex = (day) => (WEEKDAYS.indexOf(day) - WEEKDAYS.indexOf(rule.wkst) + 7) % 7;
  const weekStart = (epoch) => epoch - weekdayIndex(epochToKstParts(epoch).weekday) * DAY_MS;
  const startWeek = weekStart(kstWallToEpoch(start.y, start.mo, start.d)), targetWeek = weekStart(kstWallToEpoch(target.y, target.mo, target.d));
  const weekDiff = Math.round((targetWeek - startWeek) / (7 * DAY_MS));
  if (weekDiff < 0 || weekDiff % rule.interval !== 0) return null;
  if (rule.count != null) {
    const fullWeeks = Math.floor(weekDiff / rule.interval);
    const daysInOrder = [...days].sort((a, b) => weekdayIndex(a) - weekdayIndex(b));
    const startDayIdx = daysInOrder.indexOf(start.weekday);
    const firstWeekCount = daysInOrder.length - (startDayIdx < 0 ? 0 : startDayIdx);
    const before = fullWeeks <= 0 ? 0 : firstWeekCount + (fullWeeks - 1) * daysInOrder.length;
    const indexInWeek = daysInOrder.indexOf(target.weekday);
    const occurrenceIndex = before + indexInWeek + 1 - (fullWeeks === 0 ? (daysInOrder.length - firstWeekCount) : 0);
    if (occurrenceIndex > rule.count) return null;
  }
  return true;
}
function nthWeekdayOfMonth(y, mo, day, n) {
  const first = kstWallToEpoch(y, mo, 1);
  const firstWeekdayIdx = WEEKDAYS.indexOf(epochToKstParts(first).weekday);
  const targetIdx = WEEKDAYS.indexOf(day);
  if (n > 0) { const offset = (targetIdx - firstWeekdayIdx + 7) % 7; return offset + 1 + (n - 1) * 7; }
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const last = kstWallToEpoch(y, mo, daysInMonth);
  const lastWeekdayIdx = WEEKDAYS.indexOf(epochToKstParts(last).weekday);
  const offset = (lastWeekdayIdx - targetIdx + 7) % 7;
  return daysInMonth - offset + (n + 1) * 7;
}
function monthlyOrYearlyOccursOnDate(event, targetEpoch) {
  const rule = event.rrule, start = epochToKstParts(event.dtstart.epoch), target = epochToKstParts(targetEpoch);
  const monthIndex = (p) => p.y * 12 + (p.mo - 1);
  const periodDiff = rule.freq === 'YEARLY' ? target.y - start.y : monthIndex(target) - monthIndex(start);
  if (periodDiff < 0 || periodDiff % rule.interval !== 0) return null;
  if (rule.freq === 'YEARLY' && target.mo !== start.mo) return null;
  const ordinal = rule.byday?.[0];
  const day = ordinal ? nthWeekdayOfMonth(target.y, target.mo, ordinal.day, ordinal.n) : (rule.bymonthday ?? start.d);
  const daysInMonth = new Date(Date.UTC(target.y, target.mo, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth || day !== target.d) return null;
  if (rule.count != null && Math.floor(periodDiff / rule.interval) + 1 > rule.count) return null;
  return true;
}

// Returns [{ start, end }] in HH:mm KST, clipped to [00:00, 24:00) of `date`, one entry per
// event judged busy that day. Unsupported RRULE shapes and non-Asia/Seoul TZIDs fail closed:
// they are reported as busy on any date on/after DTSTART rather than guessed free.
export function busyIntervalsForDate({ events, date }) {
  const [y, mo, d] = date.split('-').map(Number);
  const dayStart = kstWallToEpoch(y, mo, d), dayEnd = dayStart + DAY_MS;
  const overrides = new Map(events.filter((e) => e.recurrenceId).map((e) => [`${e.uid}:${e.recurrenceId.epoch}`, e]));
  const results = [];
  const timeOf = (epochMs) => epochMs >= dayEnd ? '24:00' : timeKey(epochToKstParts(epochMs).h, epochToKstParts(epochMs).mi);
  const push = (event, startEpoch, endEpoch, allDay) => {
    if (!busy(event) || endEpoch <= dayStart || startEpoch >= dayEnd) return;
    results.push({ start: allDay ? '00:00' : timeOf(Math.max(startEpoch, dayStart)), end: allDay ? '24:00' : timeOf(Math.min(endEpoch, dayEnd)) });
  };
  for (const event of events) {
    const singleOccurrence = event.recurrenceId || !event.rrule;
    if (singleOccurrence) {
      if (event.dtstart.unsupported) push(event, kstDayStart(event.dtstart.epoch), kstDayStart(event.dtstart.epoch) + DAY_MS, true);
      else push(event, event.dtstart.epoch, event.dtend?.epoch ?? event.dtstart.epoch, event.dtstart.allDay);
      continue;
    }
    const seriesStartDay = kstDayStart(event.dtstart.epoch);
    if (event.dtstart.unsupported || event.rrule.unsupported) {
      if (dayStart >= seriesStartDay && (event.rrule.until == null || dayStart <= event.rrule.until)) push(event, dayStart, dayEnd, true);
      continue;
    }
    if (dayStart < seriesStartDay || (event.rrule.until != null && dayStart > event.rrule.until)) continue;
    const startOfDay = epochToKstParts(event.dtstart.epoch);
    const originEpoch = kstWallToEpoch(y, mo, d, startOfDay.h, startOfDay.mi, startOfDay.s);
    if (event.exdates.includes(originEpoch) || overrides.has(`${event.uid}:${originEpoch}`)) continue;
    const occurs = event.rrule.freq === 'WEEKLY' ? weeklyOccurrencesOnDate(event, dayStart)
      : event.rrule.freq === 'DAILY' ? (() => { const daysSince = (dayStart - seriesStartDay) / DAY_MS;
          return daysSince % event.rrule.interval === 0 && (event.rrule.count == null || Math.floor(daysSince / event.rrule.interval) + 1 <= event.rrule.count); })()
      : monthlyOrYearlyOccursOnDate(event, dayStart);
    if (!occurs) continue;
    const duration = (event.dtend?.epoch ?? event.dtstart.epoch) - event.dtstart.epoch;
    push(event, originEpoch, originEpoch + duration, event.dtstart.allDay);
  }
  return results.filter((r) => r.start < r.end).sort((a, b) => a.start.localeCompare(b.start));
}
