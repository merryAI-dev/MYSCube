import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import parse5 from 'parse5';
import { createMerryhereConnections } from '../server/mcp/merryhere-connection.mjs';
import { createMerryhereClient, selectBookingSlots } from '../server/mcp/merryhere-client.mjs';
import { parseIcsEvents, busyIntervalsForDate } from '../server/mcp/ics-calendar.mjs';
import { createGoogleCalendarRooms, parseCalendarRoomsConfig } from '../server/mcp/google-calendar-rooms.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Main CI only');
const date = process.env.ROOM_CHECK_DATE;
if (!/^20\d{2}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Invalid date');
const safeFetch = async (url, options) => {
  const target = new URL(url);
  if (!['merryhere.kr', 'calendar.google.com'].includes(target.hostname)) throw new Error('Unexpected provider');
  if (options?.method === 'POST' && !['/auth/login', '/reserveinfo'].includes(target.pathname)) throw new Error('Read-only check');
  const response = await fetch(url, options);
  if (target.pathname === '/reserveinfo') {
    const body = await response.clone().text();
    let shape;
    try { const data = JSON.parse(body); shape = { jsonKeys: Object.keys(data), nestedKeys: Object.fromEntries(Object.entries(data).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [k, Object.keys(v)])) }; }
    catch {
      const nodes = [];
      const visit = n => { if (n.tagName && n.tagName !== 'script') nodes.push({ tag: n.tagName, attributes: (n.attrs || []).filter(a => ['class', 'id', 'name'].includes(a.name)).map(a => [a.name, a.value]) }); for (const c of n.childNodes || []) visit(c); };
      visit(parse5.parse(body)); shape = { htmlNodes: nodes.slice(0, 80) };
    }
    console.log(JSON.stringify({ endpoint: '/reserveinfo', status: response.status, contentType: response.headers.get('content-type'), ...shape }));
  }
  return response;
};
const rooms = createGoogleCalendarRooms({ env: process.env, fetchImpl: safeFetch });
for (const room of parseCalendarRoomsConfig(process.env)) {
  try {
    const response = await safeFetch(room.icsUrl, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    const events = parseIcsEvents(text);
    console.log(JSON.stringify({ calendar: room.name, events: events.length, unsupportedRules: events.filter(e => e.rrule?.unsupported).length, unsupportedZones: events.filter(e => e.dtstart.unsupported).length, busy: busyIntervalsForDate({ events, date }), ruleShapes: [...new Set((text.match(/^RRULE:.+$/gm) || []).map(line => line.replace(/(?:UNTIL|COUNT)=([^;\r]+)/g, '$&')))].filter(rule => /BYSETPOS|BYWEEKNO|BYYEARDAY|BYMONTHDAY=[^;]*,/.test(rule)).slice(0, 10), status: response.status, isIcs: text.includes('BEGIN:VCALENDAR'), windows: response.ok ? await rooms.windowsForDate(date, { room: room.name, start: '11:00', end: '12:00', duration: 60 }) : [] }));
  } catch { console.log(JSON.stringify({ calendar: room.name, error: 'calendar_fetch_failed' })); }
}
console.log(JSON.stringify({ configuredCalendars: rooms.roomNames }));
const id = process.env.ROOM_CHECK_INTENT;
if (id) {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid intent');
  const api = async path => {
    const response = await fetch(`https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=${process.env.VERCEL_ORG_ID}`, { headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Existing server credential unavailable');
    return response.json();
  };
  const configured = await api(`/v9/projects/${process.env.VERCEL_PROJECT_ID}/env?target=production`);
  const entry = configured.envs.find(e => e.key === 'FIREBASE_SERVICE_ACCOUNT_JSON' && e.target?.includes('production') && !e.gitBranch);
  if (!entry) throw new Error('Existing server credential unavailable');
  const credential = await api(`/v1/projects/${process.env.VERCEL_PROJECT_ID}/env/${entry.id}`);
  const app = initializeApp({ credential: cert(JSON.parse(credential.value)), projectId: 'inner-platform-live-20260316' });
  const db = getFirestore(app);
  const intent = (await db.doc(`merryhere_booking_intents/${id}`).get()).data();
  if (!intent || !['SUBMITTING', 'UNKNOWN', 'CONFIRMED'].includes(intent.state)) throw new Error('Existing submitted intent required');
  const credentials = await createMerryhereConnections({ db, env: process.env }).credentials({ tenantId: 'mysc', actorId: intent.actorId });
  const client = createMerryhereClient({ ...credentials, fetchImpl: safeFetch });
  let stage = 'login';
  try {
    await client.login(); stage = 'calendar';
    const calendar = await client.calendar(intent.date); stage = 'slots';
    const slots = selectBookingSlots(calendar, intent);
    const ids = [...new Set(slots.map(s => s.reservationId))];
    console.log(JSON.stringify({ state: intent.state, slots: slots.map(s => ({ start: s.start, end: s.end, state: s.state, owned: s.owned, hasReservationId: !!s.reservationId })), singleReservation: ids.length === 1 && !!ids[0] }));
    if (ids.length === 1 && ids[0] && slots.every(s => s.owned)) {
      stage = 'detail'; const detail = await client.reservation(ids[0], calendar.token);
      console.log(JSON.stringify({ titleMatches: detail.title === intent.providerTitle, roomMatches: detail.name === intent.roomName, priceMatches: Number(detail.price) === intent.points }));
    }
  } catch (error) { console.log(JSON.stringify({ stage, code: error.code || 'check_failed' })); }
}
