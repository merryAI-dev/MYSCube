import * as z from 'zod/v4';
import { createGeminiCompletion } from '../server/mcp/gemini-model.mjs';
import { roomRequestSchema, roomToolDescription, interpretRoomRequest } from '../server/mcp/merryhere-request.mjs';

// Explicit, bounded model-only check: no room provider access or reservation writes.
const now = Date.parse('2026-09-29T14:36:00+09:00');
const usage = [];
try {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main'
    || process.env.GITHUB_REPOSITORY !== 'merryAI-dev/MYSCube') throw new Error('main_workflow_required');
  const apiKey = process.env.SETTLEMENT_AGENT_GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('model_not_configured');
  const complete = createGeminiCompletion({ apiKey, maxInputTokens: 4000, onUsage: u => usage.push(u) });
  async function check(text, previous, history = []) {
    const reply = await complete({ signal: AbortSignal.timeout(30000), messages: [
      { role: 'system', content: `${roomToolDescription}\n현재 한국 시각: 2026-09-29(화) 14:36. 반드시 merryhere_rooms를 한 번 호출하세요. 서버 상태: ${JSON.stringify(previous || null)}` },
      ...history, { role: 'user', content: text },
    ], tools: [{ type: 'function', function: { name: 'merryhere_rooms', description: roomToolDescription, parameters: z.toJSONSchema(roomRequestSchema) } }] });
    if (reply.tool_calls?.length !== 1 || reply.tool_calls[0].function.name !== 'merryhere_rooms') throw new Error('missing_tool_call');
    const input = roomRequestSchema.parse(JSON.parse(reply.tool_calls[0].function.arguments));
    const result = interpretRoomRequest({ input, previous, now });
    console.log(JSON.stringify({ text, input, query: result.bookingContext.query, missing: result.bookingContext.missing }));
    return result;
  }
  // Bare hours follow working hours (08:00~19:00); only an already-past or conflicting reading is asked back.
  const first = await check('오늘 5시에 가능한 회의실 알려줘');
  if (first.start !== '17:00' || !first.bookingContext.meridiemAssumed || first.action !== 'explore') throw new Error('working_hours_mismatch');
  const firstText = '오늘 10시에 가능한 회의실 알려줘';
  const past = await check(firstText);
  if (!past.bookingContext.missing.includes('meridiem')) throw new Error('past_time_not_asked');
  const second = await check('저녁 8시로 할게', past.bookingContext, [
    { role: 'user', content: firstText }, { role: 'assistant', content: '말씀하신 시각은 오전인가요, 오후인가요?' },
  ]);
  if (second.start !== '20:00' || second.date !== '2026-09-29' || second.action !== 'explore' || second.bookingContext.meridiemAssumed) throw new Error('followup_mismatch');
  const third = await check('9월 29일 오후 5시부터 1시간 정도');
  if (third.start !== '17:00' || third.end !== '18:00' || third.action !== 'explore') throw new Error('duration_mismatch');
  const fourth = await check('다음 주 수요일에 넷이 들어갈 회의실 있어?');
  if (fourth.date !== '2026-10-07' || fourth.capacity !== 4 || fourth.action !== 'explore') throw new Error('date_capacity_mismatch');
  const booking = await check('다음 주 목요일 오전 10시부터 90분, 네 명 가능한 곳 찾아서 예약해줘');
  if (booking.date !== '2026-10-08' || booking.end !== '11:30' || booking.action !== 'explore' || booking.bookingContext.requestedAction !== 'prepare') throw new Error('explore_before_booking_failed');
  const selection = await check('M4-4A로 할게. 그런데 6층과 8층도 가능한지 알려줘', booking.bookingContext);
  if (selection.room !== 'M4-4A' || !selection.relatedRooms.some(x => x.includes('6')) || !selection.relatedRooms.some(x => x.includes('8'))) throw new Error('compound_room_request_failed');
  const ack = await check('확인했어 고마워', { ...selection.bookingContext, missing: [], intentId: 'a'.repeat(24) }, [
    { role: 'assistant', content: '예약 결과를 자동 확인하지 못했습니다.' },
  ]);
  if (ack.action !== 'acknowledge') throw new Error('acknowledgment_failed');
  console.log(JSON.stringify({ passed: 8, calls: usage.length, inputTokens: usage.reduce((n, u) => n + (u.promptTokenCount || 0), 0),
    outputTokens: usage.reduce((n, u) => n + (u.candidatesTokenCount || 0), 0), thinkingTokens: usage.reduce((n, u) => n + (u.thoughtsTokenCount || 0), 0) }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, code: /^[a-z_]+$/.test(error.message || '') ? error.message : 'model_check_failed', calls: usage.length }));
  process.exitCode = 1;
}
