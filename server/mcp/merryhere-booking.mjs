import { createHash } from 'node:crypto';
import { createMerryhereClient, MerryhereError, validateBookingTime, selectBookingSlots } from './merryhere-client.mjs';
import { interpretRoomRequest, availableRoomWindows, renderRoomClarification } from './merryhere-request.mjs';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const messages = {
  local_not_connected: '개인 컴퓨터의 회의실 실행기를 연결해주세요. 터미널에서 npm run merryhere:local -- login, 이어서 npm run merryhere:local -- pair 를 실행하면 Slack 연결 코드를 안내합니다. 비밀번호는 본인 터미널에서만 입력해주세요.',
  local_offline: '개인 컴퓨터의 회의실 실행기가 연결되지 않았거나 응답 시간이 지났습니다. 컴퓨터에서 npm run merryhere:local -- run 을 실행해주세요. 기존 예약 확인번호가 있으면 같은 번호로 결과를 재조회해주세요.',
  local_login_required: '개인 컴퓨터에서 Merryhere 로그인이 필요합니다. 터미널에서 npm run merryhere:local -- login 을 실행한 뒤 이 스레드에서 원래 요청을 다시 보내주세요. 비밀번호·쿠키는 Slack에 보내지 마세요.',
  local_pair_expired: '로컬 연결 코드가 만료되었거나 이미 사용되었습니다. 개인 컴퓨터에서 npm run merryhere:local -- pair 로 새 코드를 발급해주세요.',
  local_uncertain: '로컬 실행기에 이미 예약 제출 기록이 있습니다. 다시 제출하지 않았습니다. 기존 예약 확인번호로 결과를 재조회해주세요.',
  local_account_changed: '로컬 Merryhere 로그인 계정이 요청 이후 바뀌었습니다. 이전 예약 확인번호는 원래 계정으로 로그인한 뒤 재조회해주세요. 새 계정으로 예약하려면 조건을 다시 요청해주세요.',
  account_not_connected: 'Merryhere 계정 연결이 필요합니다. 아래 링크에서 한 번만 연결하면 이후에는 Slack에서 바로 조회·예약할 수 있습니다.\n{{MERRYHERE_CONNECT_LINK}}\n링크는 요청하신 분에게만 보이며 15분 동안 한 번 사용할 수 있습니다. 비밀번호는 Slack에 보내지 마세요. 이번 요청에서는 조회·예약을 하지 않았습니다.',
  login_failed: 'Merryhere 로그인이 거부되었습니다. 비밀번호가 바뀌었다면 아래 링크에서 다시 연결해주세요.\n{{MERRYHERE_CONNECT_LINK}}\n링크는 요청하신 분에게만 보이며 15분 동안 한 번 사용할 수 있습니다. 이전 예약 확인번호가 있다면 연결 후 같은 번호로 결과를 재조회해주세요.',
  login_required: 'Merryhere 로그인 후에도 인증 상태를 확인하지 못했습니다. 아래 링크에서 계정을 다시 연결해주세요.\n{{MERRYHERE_CONNECT_LINK}}\n예약 확인번호가 있다면 연결 후 같은 번호로 결과를 재조회해주세요.',
  connect_unavailable: 'Merryhere 계정 연결 기능이 아직 준비되지 않았습니다. 관리자에게 알려주세요. 이번 요청에서는 조회·예약을 하지 않았습니다.',
  session_expired: 'Merryhere 로그인 세션이 만료되었습니다. 같은 요청을 다시 보내면 서버가 로그인부터 다시 진행합니다. 예약 확인번호가 있다면 반드시 같은 번호를 사용해주세요. 이미 제출한 예약은 재제출하지 않고 결과만 조회합니다.',
  invalid_time: '존재하는 날짜와 30분 단위의 시작·종료 시각을 지정해주세요. 종료는 시작보다 늦어야 합니다.',
  past_time: '이미 지난 시간은 예약할 수 없습니다. 한국시간 기준으로 미래 시간을 지정해주세요.',
  date_out_of_range: '오늘부터 4주 이내 날짜만 예약할 수 있습니다.',
  date_mismatch: '요청한 날짜와 Merryhere가 반환한 날짜가 달라 예약을 중단했습니다.',
  page_changed: 'Merryhere 응답 형식이 예상과 달라 가용 여부를 확인하지 못했습니다. 빈 시간으로 처리하지 않았습니다.',
  slot_missing: '요청 구간의 모든 30분 슬롯을 확인하지 못했습니다. 예약을 제출하지 않았습니다.',
  intent_not_found: '이 스레드에서 본인이 요청한 예약 확인번호가 아닙니다.',
  intent_expired: '예약 확인 시간이 지났습니다. 날짜·시간·회의실을 다시 요청해주세요.',
  changed: '확인 이후 예약 가능 상태나 포인트가 바뀌었습니다. 예약을 제출하지 않았습니다. 다시 조회해주세요.',
  locked: '이 시간대에 이미 처리 중이거나 결과 확인이 필요한 예약 요청이 있습니다. 중복 제출하지 않았습니다.',
  transport_error: 'Merryhere 연결에 실패했습니다. 현재 가용 여부를 확인하지 못했습니다.',
  provider_error: 'Merryhere가 정상 응답을 반환하지 않았습니다. 현재 가용 여부를 확인하지 못했습니다.',
  unexpected_redirect: 'Merryhere가 예상하지 않은 주소로 이동시켜 처리를 중단했습니다.',
  date_unclear: '날짜를 정확히 확인하지 못했습니다. 오늘·내일·다음 주 수요일처럼 알려주세요.',
  time_unclear: '오전인지 오후인지 알려주세요. 가능한 시간대 조회는 시간 없이도 가능합니다.',
  request_unclear: '요청 조건을 정확히 확인하지 못했습니다. 날짜나 필요한 인원을 알려주세요.',
  room_unclear: '앞서 나온 회의실이 여러 개입니다. 예약할 회의실 이름을 알려주세요.',
};
const help = '원하는 조건을 조금만 더 알려주세요. “가능한 회의실”, “다음 주 수요일 가능한 곳”, “그중 4명 가능한 곳”처럼 물어볼 수 있습니다. 시간은 한국시간 기준입니다.';

export function localRoomIssue(code) { return { status: 'partial', code, answer: messages[code] || messages.local_offline }; }

export function isMerryhereRequest(text) { return /회의실|메리히어|merryhere|가능한\s*(?:장소|공간)/i.test(text); }
export function parseBookingRequest(text) {
  const confirm = /^\s*(?:회의실\s*)?예약\s*확정\s+([a-f0-9]{24})\s*$/.exec(text);
  if (confirm) return { action: 'confirm', id: confirm[1] };
  if (/취소|변경/.test(text)) return { action: 'unsupported' };
  return { action: 'clarify' };
}
const summary = i => `${i.date} ${i.start}~${i.end} (한국시간) · ${i.roomName} · ${i.points}P`;
const result = answer => ({ status: 'answered', answer });
const uncertain = i => result(`예약 결과 확인 필요: ${summary(i)}\n예약 제출이 시작됐으나 생성 결과를 확인하지 못했습니다. 자동 재제출하지 않습니다. 같은 확인번호로 “회의실 예약 확정 ${i.id}”을 보내면 결과만 다시 조회합니다.\nMerryhere에서 직접 확인: https://merryhere.kr/mypage/reservation`);

export async function runMerryhereBooking({ db, actor, job, text, input, previous, now = Date.now(), clientFactory = createMerryhereClient, localConnection, credentials }) {
  let queryContext;
  try {
    if (!localConnection && !credentials?.email) throw new MerryhereError('account_not_connected');
    const request = input ? interpretRoomRequest({ text, previous, now, input }) : parseBookingRequest(text, now);
    if (request.action === 'clarify') return { ...result(request.bookingContext ? renderRoomClarification(request.bookingContext) : help),
      ...(request.bookingContext ? { bookingContext: request.bookingContext } : {}) };
    if (request.action === 'unsupported') return result('예약 취소·변경은 현재 Slack에서 지원하지 않습니다. Merryhere 내 예약현황에서 처리해주세요: https://merryhere.kr/mypage/reservation');
    if (['explore', 'prepare'].includes(request.action)) queryContext = { ...request.bookingContext, options: [] };
    const accountKey = localConnection ? localConnection.accountKey : credentials.accountKey || hash(credentials.email.toLowerCase());
    const client = clientFactory(localConnection ? null : { email: credentials.email, password: credentials.password });
    const scope = { actorId: actor.actorId, teamId: job.teamId, channelId: job.channelId, threadTs: job.threadTs, accountKey };
    const refFor = id => db.doc(`merryhere_booking_intents/${id}`);
    if (request.action === 'confirm') {
      const ref = refFor(request.id);
      let intent = (await ref.get()).data();
      if (!intent || Object.entries(scope).some(([k, v]) => intent[k] !== v)) throw new MerryhereError('intent_not_found');
      if (intent.state === 'CONFIRMED') return result(`예약 완료: ${summary(intent)}\n회의명: ${intent.title}\n예약번호: ${intent.reservationId}\nhttps://merryhere.kr/mypage/reservation`);
      if (intent.state === 'PREPARED' && intent.expiresAt < now) throw new MerryhereError('intent_expired');
      await client.login();
      const reconcile = async () => {
        try {
          const calendar = await client.calendar(intent.date);
          const slots = selectBookingSlots(calendar, intent);
          const ids = [...new Set(slots.map(s => s.reservationId))];
          if (ids.length !== 1 || !ids[0] || !slots.every(s => s.owned)) return uncertain(intent);
          const detail = await client.reservation(ids[0], calendar.token);
          if (detail.title !== intent.providerTitle || detail.name !== intent.roomName || Number(detail.price) !== intent.points) return uncertain(intent);
          await db.runTransaction(async tx => {
            const current = (await tx.get(ref)).data();
            if (!current || !['SUBMITTING', 'UNKNOWN', 'CONFIRMED'].includes(current.state)) throw new Error('invalid_state');
            const locks = await Promise.all(intent.ordinals.map(ordinal => tx.get(db.doc(`merryhere_booking_locks/${intent.date}_${intent.roomId}_${ordinal}`))));
            tx.update(ref, { state: 'CONFIRMED', reservationId: ids[0], verifiedAt: new Date().toISOString() });
            for (const lock of locks) if (lock.data()?.intentId === intent.id) tx.delete(lock.ref);
          });
          return result(`예약 완료: ${summary(intent)}\n회의명: ${intent.title}\n예약번호: ${ids[0]}\nhttps://merryhere.kr/mypage/reservation`);
        } catch (error) { return { ...uncertain(intent), ...(error.code === 'page_changed' ? { code: error.code } : {}) }; }
      };
      if (intent.state !== 'PREPARED') return reconcile();
      validateBookingTime(intent, now);
      const calendar = await client.calendar(intent.date);
      const slots = selectBookingSlots(calendar, intent);
      if (slots.some(s => s.state !== 'available') || slots.reduce((n, s) => n + s.points, 0) !== intent.points
        || slots.some(s => intent.capacity && s.capacity < intent.capacity)
        || JSON.stringify(slots.map(s => s.ordinal)) !== JSON.stringify(intent.ordinals)) throw new MerryhereError('changed');
      const shouldSubmit = await db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (current.state !== 'PREPARED') return false;
        const locks = slots.map(s => db.doc(`merryhere_booking_locks/${intent.date}_${s.roomId}_${s.ordinal}`));
        for (const lock of locks) {
          const existing = (await tx.get(lock)).data();
          if (!existing) continue;
          if (typeof existing.intentId !== 'string' || !/^[a-f0-9]{24}$/.test(existing.intentId)) throw new MerryhereError('locked');
          const owner = (await tx.get(refFor(existing.intentId))).data();
          // Legacy confirmed locks can be replaced only after the live calendar above shows these slots free.
          if (owner?.state !== 'CONFIRMED' || owner.date !== intent.date || owner.roomId !== intent.roomId) throw new MerryhereError('locked');
        }
        for (const lock of locks) tx.set(lock, { intentId: intent.id, createdAt: now });
        tx.update(ref, { state: 'SUBMITTING', submittedAt: now });
        return true;
      });
      if (shouldSubmit) {
        try { await client.reserve(calendar, intent); }
        catch {
          await db.runTransaction(async tx => {
            if ((await tx.get(ref)).data()?.state === 'SUBMITTING') tx.update(ref, { state: 'UNKNOWN' });
          });
        }
      }
      return reconcile();
    }
    await client.login();
    const calendar = await client.calendar(request.date);
    if (request.action === 'explore') {
      const options = availableRoomWindows(calendar, request, now);
      const shown = options.slice(0, 12);
      return { status: 'answered', bookingContext: { ...request.bookingContext, options: shown }, answer: [
        ...(request.bookingContext.dateDefaulted ? ['날짜를 지정하지 않아 오늘 기준으로 조회했습니다.'] : []),
        `${request.date} · 한국시간 · Merryhere 예약 가능 시간`,
        ...(shown.length ? shown.map(w => `• ${w.room} (${w.capacity}인): ${w.start}~${w.end}`) : ['요청 조건에 맞는 예약 가능 구간이 없습니다.']),
        '기예약·이용 차단(blocked)·외부 신청 슬롯은 제외했습니다.',
        ...(options.length > shown.length ? ['가장 빠른 시간부터 12개 표시했습니다. 시간이나 인원으로 좁힐 수 있습니다.'] : []),
        '원하는 방과 이용 시간을 말씀해주세요. 예약 직전에 상태와 포인트를 다시 확인합니다.',
      ].join('\n') };
    }
    if (request.action === 'prepare' && (!request.room || !request.start || !request.end || !request.title)) return {
      ...result('예약할 회의실·시작 및 종료 시간·회의명 중 빠진 정보를 알려주세요. 아직 예약을 제출하지 않았습니다.'),
      bookingContext: { ...request.bookingContext, options: previous?.options || [] },
    };
    validateBookingTime(request, now);
    const rooms = [...new Map(calendar.slots.map(s => [s.roomId, { roomId: s.roomId, name: s.name }])).values()]
      .filter(r => !request.room || r.name === request.room || r.name.endsWith(`-${request.room}`));
    if (rooms.length === 0) return result('해당 회의실을 Merryhere 예약표에서 찾지 못했습니다. 회의실 이름을 확인해주세요.');
    const views = rooms.map(r => {
      const slots = selectBookingSlots(calendar, { ...request, roomId: r.roomId });
      return { ...r, slots, points: slots.reduce((n, s) => n + s.points, 0) };
    });
    const room = views[0];
    if (views.length !== 1 || room.slots.some(s => s.state !== 'available' || request.capacity && s.capacity < request.capacity)) return result('요청 시간 전체를 예약할 수 없습니다. 인원 조건을 충족하지 않거나, 기예약·이용 차단(blocked)·외부 신청 슬롯이 포함되어 있습니다. 예약을 제출하지 않았습니다.');
    const id = hash(`${job.id}/${actor.actorId}`);
    const intent = { id, ...scope, date: request.date, start: request.start, end: request.end, roomId: room.roomId, roomName: room.name,
      title: request.title, providerTitle: `${request.title} [MC:${id}]`, points: room.points, ordinals: room.slots.map(s => s.ordinal),
      capacity: request.capacity || null,
      state: 'PREPARED', createdAt: now, expiresAt: now + 10 * 60000 };
    const saved = await db.runTransaction(async tx => {
      const existing = await tx.get(refFor(id));
      if (existing.exists) return existing.data();
      tx.create(refFor(id), intent); return intent;
    });
    return { ...result(`예약 확정 전 확인: ${summary(saved)}\n회의명: ${saved.title}\n현재 전체 구간 예약 가능 · 아직 예약하지 않았습니다. 확정 시 ${saved.points}P가 차감됩니다.\n10분 이내 같은 스레드에서 “회의실 예약 확정 ${id}”을 보내주세요.`), bookingContext: { ...request.bookingContext, intentId: id, options: [] } };
  } catch (error) {
    if (localConnection && ['login_required', 'login_failed', 'session_expired'].includes(error.code)) error = new MerryhereError('local_login_required');
    return { status: 'partial', ...(messages[error.code] ? { code: error.code } : {}), ...(error.bookingContext || queryContext ? { bookingContext: error.bookingContext || queryContext } : {}),
      answer: messages[error.code] || '예약 처리를 마치지 못했습니다. 예약이 생성됐다고 판단하지 마세요. 확인번호가 있다면 같은 번호로 결과를 조회해주세요.' };
  }
}
