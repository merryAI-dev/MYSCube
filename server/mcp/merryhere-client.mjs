import parse5 from 'parse5';

const origin = 'https://merryhere.kr';
export class MerryhereError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new MerryhereError(code); };
function elements(html) {
  const result = [];
  const visit = (node) => {
    if (node.tagName) result.push({ tag: node.tagName, attrs: Object.fromEntries((node.attrs || []).map(a => [a.name, a.value])) });
    for (const child of node.childNodes || []) visit(child);
  };
  visit(parse5.parse(html));
  return result;
}
function tokenFrom(html, action) {
  const nodes = elements(html);
  if (!nodes.some(n => n.tag === 'form' && new URL(n.attrs.action || '/', origin).href === origin + action && n.attrs.method?.toLowerCase() === 'post')) fail('page_changed');
  const tokens = [...new Set(nodes.filter(n => n.tag === 'input' && n.attrs.name === '_token').map(n => n.attrs.value).filter(Boolean))];
  if (tokens.length !== 1) fail('page_changed');
  return tokens[0];
}
export function kstDate(now = Date.now()) { return new Date(Number(now) + 9 * 3600000).toISOString().slice(0, 10); }
export function validateBookingTime({ date, start, end }, now = Date.now()) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date || '') || !/^([01]\d|2[0-3]):[03]0$/.test(start || '') || !/^([01]\d|2[0-3]):[03]0$/.test(end || '')) fail('invalid_time');
  const day = Date.parse(`${date}T00:00:00+09:00`);
  if (!Number.isFinite(day) || kstDate(day) !== date || end <= start) fail('invalid_time');
  if (Date.parse(`${date}T${start}:00+09:00`) <= now) fail('past_time');
  const today = Date.parse(`${kstDate(now)}T00:00:00+09:00`);
  if (day < today || day > today + 28 * 86400000) fail('date_out_of_range');
}
export function parseCalendar(html, date) {
  const nodes = elements(html);
  if (!nodes.some(n => n.tag === 'a' && n.attrs.href === origin + '/auth/logout')) fail('login_required');
  if (nodes.find(n => n.attrs.id === 'sel-date')?.attrs.value !== date || nodes.find(n => n.attrs.id === 'btn-reservation')?.attrs['data-date'] !== date) fail('date_mismatch');
  const slots = nodes.filter(n => n.tag === 'input' && n.attrs.name === 'slot').map(({ attrs: a }) => {
    const parts = /^(\d+)-(\d+)-(\d+)$/.exec(a.value || '');
    const time = v => /^(?:[01]?\d|2[0-3]):[03]0$/.test(v || '') ? v.padStart(5, '0') : null;
    const start = time(a['data-time']), end = time(a['data-time2']);
    if (!parts || !start || !end || end <= start || !a['data-name']) fail('page_changed');
    const minutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    if (minutes(end) - minutes(start) !== 30 || !Number.isSafeInteger(Number(parts[2])) || !Number.isSafeInteger(Number(parts[3]))) fail('page_changed');
    const classes = (a.class || '').trim().split(/\s+/).filter(Boolean);
    if (classes.some(c => !['free-slot', 'paid-slot', 'studio-outlink-slot', 'my-reserve', 'my-group', 'other-reserve'].includes(c))) fail('page_changed');
    const external = classes.includes('paid-slot') || classes.includes('studio-outlink-slot');
    const booked = Boolean(a['data-list-id']) || classes.includes('my-reserve') || classes.includes('other-reserve');
    if (!/^\d+$/.test(a['data-cnt'] || '')) fail('page_changed');
    return { roomId: parts[1], ordinal: Number(parts[2]), points: Number(parts[3]), name: a['data-name'], capacity: Number(a['data-cnt']), start, end,
      state: booked ? 'booked' : external ? 'external' : ('disabled' in a || 'readonly' in a) ? 'blocked' : 'available',
      reservationId: a['data-list-id'] || null, owned: classes.includes('my-reserve') && !classes.includes('my-group') };
  });
  if (!slots.length || new Set(slots.map(s => `${s.roomId}/${s.ordinal}`)).size !== slots.length) fail('page_changed');
  return { date, slots, token: tokenFrom(html, '/reserve') };
}
export function selectBookingSlots(calendar, { roomId, start, end }) {
  const slots = calendar.slots.filter(s => s.roomId === roomId && s.start >= start && s.end <= end).sort((a, b) => a.ordinal - b.ordinal);
  const minutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  if (!slots.length || slots[0].start !== start || slots.at(-1).end !== end || slots.length !== (minutes(end) - minutes(start)) / 30
    || slots.some((s, i) => minutes(s.end) - minutes(s.start) !== 30 || (i && (s.ordinal !== slots[i - 1].ordinal + 1 || s.start !== slots[i - 1].end)))) fail('slot_missing');
  return slots;
}

// Sessions are local to one operation; neither cookies nor credentials enter agent evidence.
export function createMerryhereClient({ email, password, fetchImpl = fetch, sessionCookies, saveSession = async () => {} }) {
  if ((!email || !password) && !sessionCookies) fail('account_not_connected');
  const cookies = new Map(Object.entries(sessionCookies || {}));
  async function request(path, form, follow = true) {
    let url = new URL(path, origin);
    for (let hop = 0; hop < 5; hop++) {
      if (url.origin !== origin) fail('unexpected_redirect');
      let response;
      try {
        response = await fetchImpl(url.href, { method: form ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(12000),
          headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
            ...(form ? { 'content-type': 'application/x-www-form-urlencoded', origin, referer: origin + '/reservation' } : {}) },
          ...(form ? { body: new URLSearchParams(form).toString() } : {}) });
      } catch { fail('transport_error'); }
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(';')[0], index = pair.indexOf('=');
        if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      await saveSession(Object.fromEntries(cookies));
      if (response.status >= 300 && response.status < 400) {
        if (!follow) return;
        const location = response.headers.get('location');
        if (!location || ![301, 302, 303].includes(response.status)) fail('unexpected_redirect');
        url = new URL(location, url); form = null; continue;
      }
      if (!response.ok) fail(response.status === 419 ? 'session_expired' : response.status === 401 || response.status === 403 ? 'login_failed' : 'provider_error');
      const html = await response.text();
      if (html.length > 2000000) fail('page_changed');
      return html;
    }
    fail('unexpected_redirect');
  }
  return {
    async login() {
      if (!email || !password) {
        parseCalendar(await request(`/reservation?date=${kstDate()}`), kstDate());
        return;
      }
      const html = await request('/auth/login');
      await request('/auth/login', { _token: tokenFrom(html, '/auth/login'), email, password });
    },
    async calendar(date) { return parseCalendar(await request(`/reservation?date=${date}`), date); },
    async reserve(calendar, intent) {
      await request('/reserve', { _token: calendar.token, reserve_date: intent.date, reservation_id: intent.roomId,
        reserve_slot: intent.ordinals.join(','), title: intent.providerTitle }, false);
    },
    async reservation(id, token) {
      const body = await request('/reserveinfo', { _token: token, reservation_list_id: id });
      try { return JSON.parse(body); } catch { fail('page_changed'); }
    },
  };
}
