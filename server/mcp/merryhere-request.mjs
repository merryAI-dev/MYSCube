import * as z from 'zod/v4';
import { kstDate, MerryhereError } from './merryhere-client.mjs';

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[03]0$/).nullable().optional();
const querySchema = z.object({
  date: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).nullable().optional(), start: time, end: time,
  duration: z.number().int().min(30).max(840).multipleOf(30).nullable().optional(),
  room: z.string().trim().min(1).max(100).nullable().optional(),
  capacity: z.number().int().min(1).max(100).nullable().optional(), title: z.string().trim().min(1).max(100).nullable().optional(),
  afternoon: z.boolean().optional(),
}).strict();
export const roomRequestSchema = z.object({ action: z.enum(['explore', 'prepare', 'clarify']), inherit: z.boolean(),
  query: querySchema, missing: z.array(z.enum(['date', 'time', 'meridiem', 'duration', 'room', 'title', 'intent'])).max(7),
  assumptions: z.array(z.enum(['meridiem'])).max(1).optional(),
}).strict();
export const WORKING_HOURS = Object.freeze({ start: '08:00', end: '19:00' });

export const roomToolDescription = `Merryhere 회의실 탐색·예약 준비.
자연어 날짜/시각/기간을 현재 한국시간과 대화 문맥으로 해석하세요. date는 YYYY-MM-DD, start/end는 24시간 HH:mm, duration은 분, capacity는 인원입니다. 다음 주는 월요일 시작 주 기준입니다.
"5시부터 한 시간 정도" 등 표현은 의미를 해석해 숫자로 전달하세요. 방은 사용자가 지칭한 이름(예:3A), 실제 ID는 서버가 조회합니다.
독립 요청은 inherit=false. 추가 질문에 대한 답/정정은 inherit=true로 바뀐 조건만 query에 넣으세요. 생략 필드는 유지, null은 해제입니다.
날짜가 없으면 오늘, 시간이 없으면 가능한 시간대를 먼저 조회합니다. 이전 발화는 대화 이력, 확인된 조건은 아래 서버 상태를 사용하세요.
오전/오후: 사용자가 오전·오후를 말했거나 아침·점심·저녁·밤·새벽 같은 단서가 있으면 그대로 따르세요. 단서 없이 1~12시만 말하면 사람처럼 업무 시간(08:00~19:00) 안의 시각으로 해석하세요. 8~11시는 오전, 12시는 정오, 1~7시는 오후입니다(예: "5시"→17:00, "10시"→10:00, "12시 반"→12:30). 이렇게 해석했으면 assumptions=["meridiem"]을 넣으세요. 오늘인데 그 해석 시각이 이미 지났거나 단서와 업무 시간 해석이 맞지 않을 때만 start를 비우고 missing=["meridiem"]으로 질문하세요.
시작을 바꿀 때 이전 end를 복사하지 마세요. 서버가 유지된 duration으로 다시 계산합니다. 새 날짜는 이전 시간 조건을 임의로 상속하지 마세요.
추가 답변을 받으면 이전 미해결 조건을 문맥으로 해석하고 해결된 missing을 제거하세요. "오후만"은 오후 시간대 탐색(afternoon=true)입니다.
조회는 explore, 명시적 예약 요청은 prepare입니다. 준비에 room/start/end/title이 부족하면 missing에 포함합니다. 취소/다른 주제는 clarify/intent.
missing은 이번 답변 이후에도 남은 미해결 조건 전체입니다. 예약 생성은 이 도구가 하지 않으며, 호스트가 별도의 사용자 확인번호 확정 후 수행합니다.`;

export function validateRoomDate(date, now) {
  const day = Date.parse(`${date}T00:00:00+09:00`);
  const today = kstDate(now), min = Date.parse(`${today}T00:00:00+09:00`);
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(day) || kstDate(day) !== date || day < min || day > min + 28 * 86400000) throw new MerryhereError('date_out_of_range');
  return date;
}
const minutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
export function interpretRoomRequest({ previous, now, input }) {
  let value;
  try { value = roomRequestSchema.parse(input); } catch { throw new MerryhereError('request_unclear'); }
  const base = value.inherit && previous?.query ? querySchema.parse(Object.fromEntries(
    Object.entries(previous.query).filter(([key]) => Object.hasOwn(querySchema.shape, key)))) : {};
  const patch = value.query;
  const query = { ...base, ...patch };
  const dateDefaulted = (!query.date && !value.missing.includes('date'))
    || Boolean(value.inherit && previous?.dateDefaulted && !Object.hasOwn(patch, 'date') && query.date);
  query.date = query.date || (value.missing.includes('date') ? null : kstDate(now));
  if (query.date) validateRoomDate(query.date, now);
  // A new date starts a new time search; an edited start retains duration, never an obsolete end.
  if (patch.date && patch.date !== base.date) {
    for (const key of ['start', 'end', 'duration', 'afternoon']) if (!(key in patch)) delete query[key];
  }
  if ('start' in patch && base.start && patch.start !== base.start && !('end' in patch)) delete query.end;
  if ('duration' in patch && !('end' in patch)) delete query.end;
  if (query.start && query.duration && !query.end) {
    const end = minutes(query.start) + query.duration;
    if (end >= 1440) throw new MerryhereError('invalid_time');
    query.end = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
  }
  if (query.start && query.end && (query.end <= query.start || query.duration && minutes(query.end) - minutes(query.start) !== query.duration)) throw new MerryhereError('invalid_time');
  if (query.start && query.end && !query.duration) query.duration = minutes(query.end) - minutes(query.start);
  if (!querySchema.safeParse(query).success) throw new MerryhereError('invalid_time');
  const missing = new Set(value.missing);
  // The model resolves bare hours to working hours; the server only refuses assumptions that break that rule.
  const meridiemAssumed = value.assumptions?.includes('meridiem')
    || Boolean(value.inherit && previous?.meridiemAssumed && !Object.hasOwn(patch, 'start') && !Object.hasOwn(patch, 'end'));
  const nowClock = new Date(now + 9 * 3600000).toISOString().slice(11, 16);
  if (meridiemAssumed && query.start && (query.start < WORKING_HOURS.start || query.start > WORKING_HOURS.end
    || (query.date === kstDate(now) && query.start <= nowClock))) {
    for (const key of ['start', 'end']) delete query[key];
    missing.add('meridiem');
  }
  if (value.action === 'prepare') {
    if (!query.room) missing.add('room');
    if (!query.start) missing.add('time');
    if (!query.end) missing.add('duration');
    if (!query.title) missing.add('title');
  }
  const bookingContext = { query, missing: [...missing], requestedAction: value.action, dateDefaulted, meridiemAssumed: Boolean(meridiemAssumed && query.start) };
  return { ...query, action: missing.size || value.action === 'clarify' ? 'clarify' : value.action, bookingContext };
}
export function meridiemNote(context) {
  const start = context?.meridiemAssumed && context.query?.start;
  if (!start) return '';
  const hour = Number(start.slice(0, 2)), label = hour < 12 ? '오전' : '오후';
  return `오전·오후를 말씀하지 않아 업무 시간 기준 ${label} ${hour % 12 || 12}시${start.endsWith(':30') ? ' 반' : ''}(${start})로 이해했습니다. 다르면 알려주세요.`;
}
export function renderRoomClarification(context) {
  const labels = { date: '이용할 날짜를 알려주세요.', time: '몇 시부터 이용할까요?', meridiem: '말씀하신 시각은 오전인가요, 오후인가요?',
    duration: '얼마 동안 이용할까요?', room: '어느 회의실을 예약할까요?', title: '회의명을 알려주세요.', intent: '조회 또는 예약할 조건을 알려주세요.' };
  const q = context?.query || {};
  const known = [q.date, q.room, q.start && `${q.start}${q.end ? `~${q.end}` : '부터'}`, q.capacity && `${q.capacity}명`].filter(Boolean);
  return [context?.dateDefaulted ? '날짜를 지정하지 않아 오늘 기준입니다.' : '', meridiemNote(context), known.length ? `확인한 조건: ${known.join(' · ')} (한국시간)` : '',
    ...[...new Set(context?.missing?.length ? context.missing : ['intent'])].map(key => labels[key])].filter(Boolean).join('\n');
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
  return [...rooms.values()].flat().filter(w => (!query.duration || minutes(w.end) - minutes(w.start) >= query.duration)
    && (!query.start || w.start === query.start) && (!query.start || !query.end || w.end === query.end))
    .sort((a, b) => a.start.localeCompare(b.start) || a.room.localeCompare(b.room));
}
