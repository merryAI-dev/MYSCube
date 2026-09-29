import { describe, it, expect, vi } from 'vitest';
import { parseCalendar, selectBookingSlots, validateBookingTime, createMerryhereClient, kstDate } from './merryhere-client.mjs';
import { validateRoomDate, interpretRoomRequest, availableRoomWindows } from './merryhere-request.mjs';
import { runMerryhereBooking } from './merryhere-booking.mjs';
import { memoryDb } from './slack-test-store.mjs';
import { createSlackWorker } from './slack-runtime.mjs';

const now = Date.parse('2026-09-29T13:47:00+09:00');
const input = { action: 'explore', inherit: false, query: {}, missing: [] };
// Attribute names and values observed on the live 2026-09-30 calendar; no cookies or personal booking data.
const slotHtml = (ordinal, attrs = '') => `<input type="checkbox" name="slot" value="9-${ordinal}-8" data-name="M3-3A" data-cnt="8" data-time="${9 + Math.floor(ordinal / 2)}:${ordinal % 2 ? '30' : '00'}" data-time2="${9 + Math.floor((ordinal + 1) / 2)}:${ordinal % 2 ? '00' : '30'}" data-list-id="" class="" ${attrs}>`;
const html = (slots = slotHtml(0) + slotHtml(1), date = '2026-09-30') => `<a href="https://merryhere.kr/auth/logout">LOG OUT</a><input id="sel-date" value="${date}"><button id="btn-reservation" data-date="${date}"></button><form action="https://merryhere.kr/reserve" method="post"><input name="_token" value="csrf"></form>${slots}`;

describe('Merryhere provider contract', () => {
  it('keeps room catalog identifier distinct from booking record identifier', () => {
    const calendar = parseCalendar(html(), '2026-09-30');
    expect(calendar.slots[0]).toMatchObject({ roomId: '9', reservationId: null, capacity: 8, state: 'available' });
    expect(selectBookingSlots(calendar, { roomId: '9', start: '09:00', end: '10:00' })).toHaveLength(2);
  });
  it.each(['disabled', 'readonly'])('never treats %s empty slots as available', attr => {
    expect(parseCalendar(html(slotHtml(0, attr)), '2026-09-30').slots[0].state).toBe('blocked');
  });
  it.each(['paid-slot', 'studio-outlink-slot'])('preserves external-only %s slots', cls => {
    expect(parseCalendar(html(slotHtml(0).replace('class=""', `class="${cls}"`)), '2026-09-30').slots[0].state).toBe('external');
  });
  it('fails closed for wrong dates, login pages, duplicate and unknown slots', () => {
    expect(() => parseCalendar(html(), '2026-10-01')).toThrow('date_mismatch');
    expect(() => parseCalendar('<form action="/auth/login"></form>', '2026-09-30')).toThrow('login_required');
    expect(() => parseCalendar(html(slotHtml(0) + slotHtml(0)), '2026-09-30')).toThrow('page_changed');
    expect(() => parseCalendar(html(slotHtml(0).replace('class=""', 'class="new-blocked-class"')), '2026-09-30')).toThrow('page_changed');
    expect(() => selectBookingSlots(parseCalendar(html(slotHtml(0)), '2026-09-30'), { roomId: '9', start: '09:00', end: '10:00' })).toThrow('slot_missing');
  });
  it('logs in using CSRF and cookie rotation, without forwarding credentials to other origins', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('<form action="/auth/login" method="post"><input name="_token" value="login-csrf"></form>', { headers: { 'set-cookie': 'session=before; Secure; HttpOnly' } }))
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'https://evil.example/', 'set-cookie': 'session=after; Secure; HttpOnly' } }));
    const client = createMerryhereClient({ email: 'test@example.com', password: 'secret', fetchImpl });
    await expect(client.login()).rejects.toThrow('unexpected_redirect');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1].headers.cookie).toBe('session=before');
    expect(new URLSearchParams(fetchImpl.mock.calls[1][1].body).get('_token')).toBe('login-csrf');
  });
  it('uses provider room ID for submission and booking record ID for detail, with rotated session', async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      if (url.endsWith('/auth/login') && options.method === 'GET') return new Response('<form action="/auth/login" method="post"><input name="_token" value="login-csrf"></form>', { headers: { 'set-cookie': 'session=before; Secure' } });
      if (url.endsWith('/auth/login')) {
        expect(Object.fromEntries(new URLSearchParams(options.body))).toEqual({ _token: 'login-csrf', email: 'test@example.com', password: 'secret' });
        return new Response('', { status: 302, headers: { location: '/reservation?date=2026-09-30', 'set-cookie': 'session=after; Secure' } });
      }
      expect(options.headers.cookie).toBe('session=after');
      if (url.includes('/reservation?')) return new Response(html());
      if (url.endsWith('/reserve')) {
        expect(Object.fromEntries(new URLSearchParams(options.body))).toEqual({ _token: 'csrf', reserve_date: '2026-09-30', reservation_id: '9', reserve_slot: '0,1', title: '팀 회의 [MC:test]' });
        return new Response('', { status: 302, headers: { location: '/reservation' } });
      }
      if (url.endsWith('/reserveinfo')) {
        expect(Object.fromEntries(new URLSearchParams(options.body))).toEqual({ _token: 'csrf', reservation_list_id: 'booking-pk' });
        return Response.json({ title: '팀 회의 [MC:test]', name: 'M3-3A', price: 16 });
      }
      throw new Error('unexpected URL');
    });
    const client = createMerryhereClient({ email: 'test@example.com', password: 'secret', fetchImpl });
    await client.login();
    const calendar = await client.calendar('2026-09-30');
    await client.reserve(calendar, { date: calendar.date, roomId: '9', ordinals: [0, 1], providerTitle: '팀 회의 [MC:test]' });
    expect(await client.reservation('booking-pk', calendar.token)).toMatchObject({ name: 'M3-3A', price: 16 });
  });
});

describe('normalized room query contract', () => {
  it('defaults an independent search to today without inventing a time', () => {
    const result = interpretRoomRequest({ input, now });
    expect(result).toMatchObject({ action: 'explore', date: '2026-09-29', bookingContext: { missing: [] } });
    expect(result.start).toBeUndefined();
    expect(result.end).toBeUndefined();
  });
  it('accepts normalized dates and duration independently of the original Korean phrase', () => {
    expect(interpretRoomRequest({ now, input: { ...input, query: { date: '2026-09-29', start: '17:00', duration: 60 } } }))
      .toMatchObject({ start: '17:00', end: '18:00', duration: 60 });
    expect(validateRoomDate('2026-10-07', now)).toBe('2026-10-07');
    expect(validateRoomDate('2027-01-01', Date.parse('2026-12-31T23:59:00+09:00'))).toBe('2027-01-01');
  });
  it.each(['2026-09-31', '2026-09-28', '2026-10-28'])('rejects invalid or out-of-range date %s', date => {
    expect(() => interpretRoomRequest({ now, input: { ...input, query: { date } } })).toThrow('date_out_of_range');
  });
  it.each([
    { start: '17:15' }, { start: '24:00' }, { start: '오후 5시' }, { duration: 15 }, { duration: 45 },
    { capacity: 0 }, { capacity: 1.5 }, { actorRole: 'admin' },
  ])('rejects invalid normalized fields %j before reading provider data', query => {
    expect(() => interpretRoomRequest({ now, input: { ...input, query } })).toThrow('request_unclear');
  });
  it.each([
    { start: '18:00', end: '17:00' }, { start: '17:00', end: '18:00', duration: 30 },
    { start: '23:30', duration: 60 },
  ])('rejects inconsistent time intervals %j', query => {
    expect(() => interpretRoomRequest({ now, input: { ...input, query } })).toThrow('invalid_time');
  });
  it('keeps a clarification draft without authenticating and resolves it through a later model query', async () => {
    const clientFactory = vi.fn();
    const args = { actor: {}, job: {}, env: {}, now, clientFactory };
    const first = await runMerryhereBooking({ ...args, text: '다음 주 수요일 5시부터 1시간 4명',
      input: { ...input, query: { date: '2026-10-07', duration: 60, capacity: 4 }, missing: ['meridiem'] } });
    expect(first.answer).toContain('오전인가요, 오후인가요');
    expect(first.bookingContext).toMatchObject({ query: { date: '2026-10-07', duration: 60, capacity: 4 }, missing: ['meridiem'] });
    expect(clientFactory).not.toHaveBeenCalled();
    const second = await runMerryhereBooking({ ...args, text: '점심 먹은 뒤니까 오후를 말했어', previous: first.bookingContext,
      input: { ...input, inherit: true, query: { start: '17:00' } } });
    expect(second.bookingContext.query).toMatchObject({ date: '2026-10-07', start: '17:00', end: '18:00', capacity: 4 });
    expect(second.bookingContext.missing).toEqual([]);
    expect(second.answer).toContain('계정 연결');
  });
  it.each([
    [{ start: '14:00' }, { end: '17:00' }, '14:00', '17:00'],
    [{ end: '18:00' }, { start: '17:00' }, '17:00', '18:00'],
    [{ start: '09:00' }, { end: '17:00' }, '09:00', '17:00'],
  ])('preserves explicit clock fields while the model resolves the ambiguous field %j', (known, patch, start, end) => {
    const first = interpretRoomRequest({ now, input: { ...input, query: { date: '2026-09-30', ...known }, missing: ['meridiem'] } });
    expect(interpretRoomRequest({ now, previous: first.bookingContext, input: { ...input, inherit: true, query: patch } }))
      .toMatchObject({ start, end });
  });
  it('changes the start using the prior duration and preserves other known conditions', () => {
    const previous = { query: { date: '2026-09-30', start: '14:00', end: '15:00', duration: 60, title: '팀 회의', capacity: 8 } };
    expect(interpretRoomRequest({ previous, now, input: { ...input, inherit: true, query: { start: '15:00' } } }))
      .toMatchObject({ start: '15:00', end: '16:00', duration: 60, title: '팀 회의', capacity: 8 });
    expect(interpretRoomRequest({ previous, now, input: { ...input, inherit: true, query: { duration: 90 } } }))
      .toMatchObject({ start: '14:00', end: '15:30', duration: 90 });
  });
  it('resets time on a new date and supports explicit null clearing without clearing omitted fields', () => {
    const previous = { query: { date: '2026-09-30', start: '14:00', end: '15:00', duration: 60, afternoon: true, room: '3A', capacity: 8, title: '팀 회의' } };
    const changed = interpretRoomRequest({ previous, now, input: { ...input, inherit: true, query: { date: '2026-10-01' } } });
    expect(changed).toMatchObject({ date: '2026-10-01', room: '3A', capacity: 8 });
    for (const key of ['start', 'end', 'duration', 'afternoon']) expect(changed[key]).toBeUndefined();
    const cleared = interpretRoomRequest({ previous, now, input: { ...input, inherit: true,
      query: { start: null, end: null, duration: null, room: null, capacity: null, title: null, afternoon: false } } });
    expect(cleared).toMatchObject({ date: '2026-09-30', start: null, end: null, duration: null, room: null, capacity: null, title: null, afternoon: false });
    expect(interpretRoomRequest({ previous, now, input }).room).toBeUndefined();
  });
  it('retains an inherited date rather than silently rolling it across midnight', () => {
    expect(() => interpretRoomRequest({ previous: { query: { date: '2026-09-29' }, missing: ['meridiem'] },
      now: Date.parse('2026-09-30T00:01:00+09:00'), input: { ...input, inherit: true, query: { start: '17:00' } } })).toThrow('date_out_of_range');
  });
  it('adds required preparation fields and never submits a query with unresolved conditions', () => {
    const result = interpretRoomRequest({ now, input: { ...input, action: 'prepare', query: { date: '2026-09-30' } } });
    expect(result.action).toBe('clarify');
    expect(result.bookingContext.missing).toEqual(expect.arrayContaining(['room', 'time', 'duration', 'title']));
    expect(result.bookingContext.requestedAction).toBe('prepare');
    expect(interpretRoomRequest({ now, input: { ...input, missing: ['intent'] } }).action).toBe('clarify');
  });
  it('only returns rooms available at the requested start, never later fragments', () => {
    const blocked = parseCalendar(html(slotHtml(0, 'disabled') + slotHtml(1)), '2026-09-30');
    expect(availableRoomWindows(blocked, { start: '09:00' }, now)).toEqual([]);
    expect(availableRoomWindows(blocked, {}, now)).toHaveLength(1);
    const split = parseCalendar(html(slotHtml(0) + slotHtml(1, 'disabled') + slotHtml(2)), '2026-09-30');
    expect(availableRoomWindows(split, { start: '09:00' }, now).map(w => `${w.start}~${w.end}`)).toEqual(['09:00~09:30']);
    expect(availableRoomWindows(split, { start: '09:00', duration: 60 }, now)).toEqual([]);
  });
  it('does not merge across blocked or missing slots or offer already-started slots', () => {
    const calendar = parseCalendar(html(slotHtml(0) + slotHtml(1, 'disabled') + slotHtml(2)), '2026-09-30');
    expect(availableRoomWindows(calendar, {}, now).map(w => `${w.start}~${w.end}`)).toEqual(['09:00~09:30', '10:00~10:30']);
    expect(availableRoomWindows(calendar, { duration: 60 }, now)).toEqual([]);
    expect(availableRoomWindows(parseCalendar(html(), '2026-09-30'), {}, Date.parse('2026-09-30T09:00:30+09:00'))[0].start).toBe('09:30');
  });
  it.each([
    ['2026-09-29', '13:30', '14:00'], ['2026-09-30', '09:15', '10:00'],
    ['2026-09-30', '10:00', '09:00'], ['2026-11-01', '09:00', '10:00'],
  ])('rejects invalid reservation %s %s %s', (date, start, end) => {
    expect(() => validateBookingTime({ date, start, end }, now)).toThrow();
  });
});

it('persists the unresolved time in the Slack thread and applies an AM/PM reply before a real provider read', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T14:36:00+09:00'));
  try {
    const { db, records } = memoryDb();
    const identity = { teamId: 'T099F304GAY', channelId: 'C0BQ6980HR6', slackUserId: 'UQA', threadTs: '1.1' };
    const threadPath = 'settlement_agent_threads/conversation';
    const job = { ...identity, status: 'queued', attempts: 0, conversationId: 'conversation', createdAt: new Date().toISOString(), question: '오늘 5시에 가능한 회의실 알려줘' };
    records.set('orgs/mysc/members/member-pk', { email: 'qa@mysc.co.kr', role: 'finance', status: 'ACTIVE' });
    records.set('settlement_agent_jobs/first', job);
    records.set(threadPath, { ...identity, queue: ['first'], turns: [] });
    const providerCalls = [];
    const completion = vi.fn(async ({ messages, tools }) => {
      const followup = completion.mock.calls.length === 2;
      const roomTool = tools.find(t => t.function.name === 'merryhere_rooms');
      expect(roomTool).toBeDefined();
      if (followup) {
        expect(messages.some(m => m.role === 'user' && m.content.includes('오늘 5시에'))).toBe(true);
        expect(messages.at(-1).content).toContain('아하 오후야');
        expect(roomTool.function.description).toContain('2026-09-29');
        expect(roomTool.function.description).toContain('meridiem');
      }
      return { tool_calls: [{ id: 'rooms', function: { name: 'merryhere_rooms', arguments: JSON.stringify(followup
        ? { ...input, inherit: true, query: { start: '17:00' } }
        : { ...input, query: { date: '2026-09-29' }, missing: ['meridiem'] }) } }] };
    });
    const worker = createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture', SETTLEMENT_AGENT_GEMINI_API_KEY: 'fixture',
      MERRYHERE_ACCOUNTS_JSON: JSON.stringify({ 'member-pk': { email: 'provider@example.com', password: 'secret' } }) },
      completeFactory: () => completion,
      fetchImpl: async (url, options) => {
        if (url.includes('users.info')) return Response.json({ ok: true, user: { team_id: identity.teamId, profile: { email: 'qa@mysc.co.kr' } } });
        if (url.startsWith('https://slack.com/')) return Response.json({ ok: true, ts: '2.1', message_ts: '3.1' });
        providerCalls.push(url);
        if (url.endsWith('/auth/login')) return new Response('<form action="/auth/login" method="post"><input name="_token" value="csrf"></form>');
        if (url.includes('/reservation?date=')) return new Response(html(slotHtml(16) + slotHtml(17), '2026-09-29'));
        throw new Error('unexpected HTTP');
      },
    });
    await worker();
    expect(providerCalls).toHaveLength(0);
    expect(records.get(threadPath).turns[0].bookingContext).toMatchObject({ query: { date: '2026-09-29' }, missing: ['meridiem'] });
    records.set('settlement_agent_jobs/second', { ...job, question: '아하 오후야' });
    records.set(threadPath, { ...records.get(threadPath), queue: ['second'] });
    await worker();
    expect(completion).toHaveBeenCalledTimes(2);
    expect(providerCalls).toContain('https://merryhere.kr/reservation?date=2026-09-29');
    const second = records.get('settlement_agent_jobs/second');
    expect(second.bookingContext.query).toMatchObject({ date: '2026-09-29', start: '17:00' });
    expect(second.answer).toContain('17:00~18:00');
    expect(second.answer).toContain('Merryhere 회의실 도구');
    expect(second.bookingContext.missing).toEqual([]);
  } finally { vi.useRealTimers(); }
});

describe('durable reservation through existing Slack actor', () => {
  it('starts missing-account onboarding without claiming browser login connects the server', async () => {
    const clientFactory = vi.fn();
    const reply = await runMerryhereBooking({ db: {}, actor: { actorId: 'not-connected' }, job: {}, env: {},
      text: '가능한 회의실', input, now, clientFactory });
    expect(reply.answer).toContain('https://merryhere.kr/auth/login');
    expect(reply.answer).toContain('브라우저 로그인만으로 Slack 서버에 연결되지는 않습니다');
    expect(reply.answer).toContain('비밀번호는 Slack에 보내지 마세요');
    expect(clientFactory).not.toHaveBeenCalled();
  });
  const setup = () => {
    const { db, records } = memoryDb();
    const calendar = parseCalendar(html(), '2026-09-30');
    const client = { login: vi.fn(), calendar: vi.fn(async () => calendar), reserve: vi.fn(), reservation: vi.fn() };
    const args = { db, actor: { actorId: 'member-pk' }, job: { id: 'slack-job', teamId: 'T', channelId: 'C', threadTs: '1.2' },
      env: { MERRYHERE_ACCOUNTS_JSON: JSON.stringify({ 'member-pk': { email: 'test@example.com', password: 'secret' } }) }, now, clientFactory: () => client };
    return { args, records, client, calendar };
  };
  const prepare = '2026-09-30 09:00~10:00 3A 회의실 예약, 회의명: 팀 회의';
  const preparation = { text: prepare, input: { ...input, action: 'prepare', query: { date: '2026-09-30', start: '09:00', end: '10:00', room: '3A', title: '팀 회의' } } };
  it('prepares without a write and rejects a foreign requester confirmation', async () => {
    const { args, records, client } = setup();
    const reply = await runMerryhereBooking({ ...args, ...preparation });
    expect(reply.answer).toContain('16P');
    expect(client.reserve).not.toHaveBeenCalled();
    const intent = [...records.values()][0];
    expect(intent.actorId).toBe('member-pk');
    const wrong = await runMerryhereBooking({ ...args, job: { ...args.job, threadTs: 'foreign' }, text: `회의실 예약 확정 ${intent.id}` });
    expect(wrong.answer).toContain('본인이 요청한');
    expect(client.reserve).not.toHaveBeenCalled();
  });
  it('never resubmits after POST timeout or a worker restart', async () => {
    const { args, records, client } = setup();
    await runMerryhereBooking({ ...args, ...preparation });
    const intent = [...records.values()][0];
    client.reserve.mockRejectedValue(new Error('timeout'));
    const text = `회의실 예약 확정 ${intent.id}`;
    expect((await runMerryhereBooking({ ...args, text })).answer).toContain('결과 확인 필요');
    expect((await runMerryhereBooking({ ...args, text })).answer).toContain('자동 재제출하지 않습니다');
    expect(client.reserve).toHaveBeenCalledTimes(1);
    expect(records.get(`merryhere_booking_intents/${intent.id}`).state).toBe('UNKNOWN');
  });
  it('rejects over-capacity preparations and preserves incomplete preparation context', async () => {
    const { args, records } = setup();
    const request = { ...input, action: 'prepare', query: { date: '2026-09-30', start: '09:00', end: '10:00', room: '3A', capacity: 10, title: '팀 회의' } };
    const reply = await runMerryhereBooking({ ...args, text: '내일 09:00~10:00 3A 10명 예약 팀 회의', input: request });
    expect(reply.answer).toContain('인원 조건');
    expect(records.size).toBe(0);
    const partial = await runMerryhereBooking({ ...args, text: '내일 09:00~10:00 3A 예약', input: { ...request, query: { ...request.query, capacity: null, title: null } } });
    expect(partial.bookingContext.query).toMatchObject({ date: '2026-09-30', room: '3A', start: '09:00' });
  });
  it('rechecks blocked state and points before submitting', async () => {
    const { args, records, client, calendar } = setup();
    await runMerryhereBooking({ ...args, ...preparation });
    const intent = [...records.values()][0];
    calendar.slots[1].state = 'blocked';
    expect((await runMerryhereBooking({ ...args, text: `회의실 예약 확정 ${intent.id}` })).answer).toContain('바뀌었습니다');
    expect(client.reserve).not.toHaveBeenCalled();
  });
  it('only confirms after exact owned slots and marked booking detail match', async () => {
    const { args, records, client, calendar } = setup();
    await runMerryhereBooking({ ...args, ...preparation });
    const intent = [...records.values()][0];
    client.reserve.mockImplementation(async () => { for (const s of calendar.slots) Object.assign(s, { state: 'booked', owned: true, reservationId: 'booking-pk' }); });
    client.reservation.mockResolvedValue({ title: intent.providerTitle, name: intent.roomName, price: intent.points });
    const text = `회의실 예약 확정 ${intent.id}`;
    expect((await runMerryhereBooking({ ...args, text })).answer).toContain('예약 완료');
    await runMerryhereBooking({ ...args, text });
    expect(client.reserve).toHaveBeenCalledTimes(1);
  });
});

it('uses the existing Slack agent, member PK and delivery path for room exploration', async () => {
  const { db, records } = memoryDb();
  const date = kstDate(Date.now());
  records.set('orgs/mysc/members/member-pk', { email: 'qa@mysc.co.kr', role: 'finance', status: 'ACTIVE' });
  records.set('settlement_agent_jobs/j', { status: 'queued', attempts: 0, createdAt: new Date().toISOString(),
    teamId: 'T099F304GAY', channelId: 'C0BQ6980HR6', slackUserId: 'UQA', threadTs: '1.1', question: '가능한 회의실 알려줘' });
  const calls = [];
  const worker = createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture', SETTLEMENT_AGENT_GEMINI_API_KEY: 'fixture',
    MERRYHERE_ACCOUNTS_JSON: JSON.stringify({ 'member-pk': { email: 'provider@example.com', password: 'secret' } }) },
    completeFactory: () => async ({ tools }) => {
      expect(tools.map(t => t.function.name)).toContain('merryhere_rooms');
      return { tool_calls: [{ id: 'rooms', function: { name: 'merryhere_rooms', arguments: JSON.stringify(input) } }] };
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('users.info')) return Response.json({ ok: true, user: { team_id: 'T099F304GAY', profile: { email: 'qa@mysc.co.kr' } } });
      if (url.startsWith('https://slack.com/')) return Response.json({ ok: true, ts: '2.1', message_ts: '3.1' });
      if (url.endsWith('/auth/login')) return new Response('<form action="/auth/login" method="post"><input name="_token" value="csrf"></form>', { headers: { 'set-cookie': 'session=fixture; Secure' } });
      if (url.includes('/reservation?date=')) return new Response(html(undefined, date));
      throw new Error('unexpected HTTP request');
    },
  });
  await worker();
  const job = records.get('settlement_agent_jobs/j');
  expect(job.status).toBe('succeeded');
  expect(job.bookingContext.query.date).toBe(date);
  const message = calls.find(c => c.url.endsWith('/chat.postMessage'));
  expect(JSON.parse(message.options.body).text).toContain('예약 가능 시간');
  expect(job.answer).not.toContain('secret');
  expect(calls.some(c => c.url.endsWith('/reserve'))).toBe(false);
});
