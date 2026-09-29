import { describe, it, expect, vi } from 'vitest';
import { parseCalendar, selectBookingSlots, validateBookingTime, createMerryhereClient } from './merryhere-client.mjs';
import { resolveRoomDate, interpretRoomRequest, availableRoomWindows } from './merryhere-request.mjs';
import { runMerryhereBooking } from './merryhere-booking.mjs';
import { memoryDb } from './slack-test-store.mjs';
import { createSlackWorker } from './slack-runtime.mjs';

const now = Date.parse('2026-09-29T13:47:00+09:00');
const input = { action: 'explore', dateText: null, startText: null, endText: null, durationText: null, roomText: null, capacityText: null, title: null, inherit: false, afternoon: false };
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

describe('contextual exploration', () => {
  it('resolves next Wednesday with a Monday-based Korean calendar', () => {
    expect(resolveRoomDate('다음주 수요일', now)).toBe('2026-10-07');
    expect(resolveRoomDate('수요일', now)).toBe('2026-09-30');
    expect(resolveRoomDate(null, now)).toBe('2026-09-29');
    expect(resolveRoomDate('내일', Date.parse('2026-12-31T23:59:00+09:00'))).toBe('2027-01-01');
    expect(() => resolveRoomDate('2026-09-31', now)).toThrow();
  });
  it('defaults missing date and time to exploration without a clarification round', () => {
    expect(interpretRoomRequest({ text: '가능한 회의실 어디야', input, now })).toMatchObject({ action: 'explore', date: '2026-09-29', start: null, end: null });
  });
  it('preserves the previous date for a capacity follow-up but refreshes availability', () => {
    const previous = { query: { date: '2026-10-07' } };
    expect(interpretRoomRequest({ text: '그중 4명 가능한 곳', previous, now, input: { ...input, inherit: true, capacityText: '4명' } })).toMatchObject({ date: '2026-10-07', capacity: 4 });
    expect(() => interpretRoomRequest({ text: '그중 4명', previous, now, input: { ...input, capacityText: '8명' } })).toThrow('request_unclear');
  });
  it('does not merge across blocked or missing intermediate slots', () => {
    const calendar = parseCalendar(html(slotHtml(0) + slotHtml(1, 'disabled') + slotHtml(2)), '2026-09-30');
    expect(availableRoomWindows(calendar, {}, now).map(w => `${w.start}~${w.end}`)).toEqual(['09:00~09:30', '10:00~10:30']);
    expect(availableRoomWindows(calendar, { duration: 60 }, now)).toEqual([]);
  });
  it('excludes a slot whose starting minute is current but whose second has passed', () => {
    expect(availableRoomWindows(parseCalendar(html(), '2026-09-30'), {}, Date.parse('2026-09-30T09:00:30+09:00'))[0].start).toBe('09:30');
  });
  it('changes start time using prior duration, and retains a supplied meeting title', () => {
    const previous = { query: { date: '2026-09-30', start: '14:00', end: '15:00', duration: 60, title: '팀 회의' } };
    expect(interpretRoomRequest({ text: '오후 3시부터', previous, now, input: { ...input, inherit: true, startText: '오후 3시' } }))
      .toMatchObject({ start: '15:00', end: '16:00', title: '팀 회의' });
  });
  it.each([
    ['2026-09-29', '13:30', '14:00'], ['2026-09-30', '09:15', '10:00'],
    ['2026-09-30', '10:00', '09:00'], ['2026-11-01', '09:00', '10:00'],
  ])('rejects invalid reservation %s %s %s', (date, start, end) => {
    expect(() => validateBookingTime({ date, start, end }, now)).toThrow();
  });
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
  const preparation = { text: prepare, input: { ...input, action: 'prepare', dateText: '2026-09-30', startText: '09:00', endText: '10:00', roomText: '3A', title: '팀 회의' } };
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
    const request = { ...input, action: 'prepare', dateText: '내일', startText: '09:00', endText: '10:00', roomText: '3A', capacityText: '10명', title: '팀 회의' };
    const reply = await runMerryhereBooking({ ...args, text: '내일 09:00~10:00 3A 10명 예약 팀 회의', input: request });
    expect(reply.answer).toContain('인원 조건');
    expect(records.size).toBe(0);
    const partial = await runMerryhereBooking({ ...args, text: '내일 09:00~10:00 3A 예약', input: { ...request, capacityText: null, title: null } });
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
  const date = resolveRoomDate(null, Date.now());
  records.set('orgs/mysc/members/member-pk', { email: 'qa@mysc.co.kr', role: 'finance', status: 'ACTIVE' });
  records.set('settlement_agent_jobs/j', { status: 'queued', attempts: 0, createdAt: new Date().toISOString(),
    teamId: 'T099F304GAY', channelId: 'C0BQ6980HR6', slackUserId: 'UQA', threadTs: '1.1', question: '가능한 회의실 알려줘' });
  const calls = [];
  const worker = createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture', SETTLEMENT_AGENT_GEMINI_API_KEY: 'fixture',
    MERRYHERE_ACCOUNTS_JSON: JSON.stringify({ 'member-pk': { email: 'provider@example.com', password: 'secret' } }) },
    completeFactory: () => async ({ tools }) => {
      expect(tools.map(t => t.function.name)).toEqual(['merryhere_rooms']);
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
