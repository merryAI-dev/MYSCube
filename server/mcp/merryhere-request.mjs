import * as z from 'zod/v4';
import { kstDate, MerryhereError } from './merryhere-client.mjs';

export function resolveRoomDate(text, now) {
  const today = kstDate(now), day = Date.parse(`${today}T00:00:00+09:00`);
  if (!text) return today;
  text = text.replace(/\s+/g, '');
  if (['오늘', '내일', '모레'].includes(text)) return kstDate(day + ['오늘', '내일', '모레'].indexOf(text) * 86400000);
  const iso = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(text);
  const monthDay = /^(?:(20\d{2})년)?(\d{1,2})월(\d{1,2})일$/.exec(text);
  let date;
  if (iso || monthDay) {
    const m = iso || monthDay;
    date = `${m[1] || today.slice(0, 4)}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  } else {
    const week = /^(이번주|다음주|다다음주)?([월화수목금토일])요일$/.exec(text);
    if (!week) throw new MerryhereError('date_unclear');
    const todayWeekday = (new Date(day + 9 * 3600000).getUTCDay() + 6) % 7;
    const target = '월화수목금토일'.indexOf(week[2]);
    const weeks = { 이번주: 0, 다음주: 1, 다다음주: 2 }[week[1]] ?? (target < todayWeekday ? 1 : 0);
    date = kstDate(day + (weeks * 7 + target - todayWeekday) * 86400000);
  }
  const parsed = Date.parse(`${date}T00:00:00+09:00`);
  if (!Number.isFinite(parsed) || kstDate(parsed) !== date || date < today || parsed > day + 28 * 86400000) throw new MerryhereError('date_out_of_range');
  return date;
}
export function resolveRoomTime(text) {
  if (!text) return null;
  const m = /^(오전|오후)?\s*(\d{1,2})(?::(\d{2})|시(?:\s*(반|\d{1,2}분))?)$/.exec(text);
  if (!m) throw new MerryhereError('invalid_time');
  let hour = Number(m[2]);
  const minute = m[3] ? Number(m[3]) : m[4] === '반' ? 30 : m[4] ? Number(m[4].replace('분', '')) : 0;
  if (m[1] && (hour < 1 || hour > 12)) throw new MerryhereError('invalid_time');
  if (m[1]) hour = hour % 12 + (m[1] === '오후' ? 12 : 0);
  if (hour > 23 || ![0, 30].includes(minute)) throw new MerryhereError('invalid_time');
  if (!m[1] && !m[3] && hour <= 12) throw new MerryhereError('time_unclear');
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
const quote = z.string().max(120).nullable();
export const roomRequestSchema = z.object({ action: z.enum(['explore', 'prepare', 'clarify']), dateText: quote, startText: quote, endText: quote,
  durationText: quote, roomText: quote, capacityText: quote, title: quote, inherit: z.boolean(), afternoon: z.boolean() }).strict();
export const roomToolDescription = `Merryhere 회의실 탐색·예약 준비. 날짜 미지정은 오늘, 시간 미지정은 가능한 시간대를 먼저 조회합니다.
dateText/startText/endText/durationText/roomText/capacityText/title 은 이번 사용자 발화에서 그대로 인용한 부분 문자열만 사용하세요. 없으면 null. 날짜를 계산하거나 방을 발명하지 마세요.
날짜 미지정은 오늘, 시간 미지정은 가능한 시간대 탐색입니다. "다음주 수요일 가능한 장소"는 explore/dateText="다음주 수요일".
"그중", "거기", "오후만" 같은 후속 요청만 inherit=true. 새 날짜 요청은 이전 시간을 임의로 유지하지 마세요.
afternoon=true는 사용자가 "오후" 시간대 전체를 요청한 경우만. 명시적 예약 요청만 prepare, 조회는 explore.
정산 등 다른 주제 또는 해석 불가능한 조건은 clarify. 취소/변경은 clarify. 예약 생성은 별도 사용자 확정 후 서버가 수행하며 이 도구는 생성하지 않습니다.`;
export function interpretRoomRequest({ text, previous, now, input }) {
  let value;
  try { value = roomRequestSchema.parse(input); } catch { throw new MerryhereError('request_unclear'); }
  for (const key of ['dateText', 'startText', 'endText', 'durationText', 'roomText', 'capacityText', 'title']) {
    if (value[key] !== null && (!value[key] || !text.includes(value[key]))) throw new MerryhereError('request_unclear');
  }
  if (value.action === 'clarify') return { action: 'clarify' };
  const base = value.inherit && previous?.query ? previous.query : {};
  const date = value.dateText ? resolveRoomDate(value.dateText, now) : base.date || resolveRoomDate(null, now);
  // Revalidate inherited dates across midnight and week boundaries.
  resolveRoomDate(date, now);
  const start = value.startText ? resolveRoomTime(value.startText) : value.dateText ? null : base.start || null;
  let end = value.endText ? resolveRoomTime(value.endText) : value.dateText || value.startText ? null : base.end || null;
  let duration = value.dateText ? null : base.duration || null;
  if (value.durationText) {
    const m = /^(반|한|두|세|\d+)\s*(시간|분)$/.exec(value.durationText);
    if (!m) throw new MerryhereError('invalid_time');
    duration = ({ 반: 0.5, 한: 1, 두: 2, 세: 3 }[m[1]] ?? Number(m[1])) * (m[2] === '시간' ? 60 : 1);
    if (!Number.isInteger(duration) || duration < 30 || duration > 840 || duration % 30) throw new MerryhereError('invalid_time');
    if (start && !value.endText) {
      const minutes = Number(start.slice(0, 2)) * 60 + Number(start.slice(3)) + duration;
      if (minutes >= 1440) throw new MerryhereError('invalid_time');
      end = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    }
  }
  if (start && !end && duration) {
    const minutes = Number(start.slice(0, 2)) * 60 + Number(start.slice(3)) + duration;
    if (minutes >= 1440) throw new MerryhereError('invalid_time');
    end = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
  let room = value.roomText ? /(?:M\d-)?([34578][AB])/i.exec(value.roomText)?.[1].toUpperCase()
    || (/메리홀|Merry\s*Hall/i.test(value.roomText) ? 'Merry Hall' : /스튜디오|Studio/i.test(value.roomText) ? 'Merry Studio' : null) : base.room || null;
  if (value.roomText && !room) throw new MerryhereError('request_unclear');
  if (/거기|그곳|그\s*방/.test(text) && !room) {
    if (previous?.options?.length !== 1) throw new MerryhereError('room_unclear');
    room = previous.options[0].room;
  }
  let capacity = base.capacity || null;
  if (value.capacityText) {
    const m = /^(\d+)\s*(?:명|인|인실)$/.exec(value.capacityText);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 100) throw new MerryhereError('request_unclear');
    capacity = Number(m[1]);
  }
  if (value.afternoon && !text.includes('오후')) throw new MerryhereError('request_unclear');
  if (start && end && end <= start) throw new MerryhereError('invalid_time');
  return { action: value.action === 'prepare' ? 'prepare' : 'explore', date, start, end, room, capacity, duration,
    afternoon: value.afternoon || (!value.dateText && Boolean(base.afternoon)), title: value.title || base.title || null };
}

export function availableRoomWindows(calendar, query, now) {
  const cutoff = calendar.date === kstDate(now) ? new Date(now + 9 * 3600000).toISOString().slice(11, 23) : '00:00:00.000';
  const rooms = new Map();
  for (const slot of [...calendar.slots].sort((a, b) => a.ordinal - b.ordinal)) {
    if (slot.state !== 'available' || `${slot.start}:00.000` < cutoff || (query.capacity && slot.capacity < query.capacity)
      || (query.room && slot.name !== query.room && !slot.name.endsWith(`-${query.room}`))) continue;
    if ((query.afternoon && slot.start < '12:00') || (query.start && slot.start < query.start) || (query.end && slot.end > query.end)) continue;
    const windows = rooms.get(slot.roomId) || [];
    const last = windows.at(-1);
    if (last && last.end === slot.start && last.lastOrdinal + 1 === slot.ordinal) {
      last.end = slot.end; last.lastOrdinal = slot.ordinal;
    } else windows.push({ room: slot.name, capacity: slot.capacity, start: slot.start, end: slot.end, lastOrdinal: slot.ordinal });
    rooms.set(slot.roomId, windows);
  }
  const mins = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  return [...rooms.values()].flat().filter(w => (!query.duration || mins(w.end) - mins(w.start) >= query.duration)
    && (!query.start || !query.end || w.start === query.start && w.end === query.end))
    .sort((a, b) => a.start.localeCompare(b.start) || a.room.localeCompare(b.room));
}
