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
      { role: 'system', content: `${roomToolDescription}\n테스트 기준 한국시각: 2026-09-29 화요일 14:36. 반드시 merryhere_rooms를 한 번 호출하세요. 서버 상태: ${JSON.stringify(previous || null)}` },
      ...history, { role: 'user', content: text },
    ], tools: [{ type: 'function', function: { name: 'merryhere_rooms', description: roomToolDescription, parameters: z.toJSONSchema(roomRequestSchema) } }] });
    if (reply.tool_calls?.length !== 1 || reply.tool_calls[0].function.name !== 'merryhere_rooms') throw new Error('missing_tool_call');
    const input = roomRequestSchema.parse(JSON.parse(reply.tool_calls[0].function.arguments));
    const result = interpretRoomRequest({ input, previous, now });
    console.log(JSON.stringify({ text, input, query: result.bookingContext.query, missing: result.bookingContext.missing }));
    return result;
  }
  const firstText = '오늘 5시에 가능한 회의실 알려줘';
  const first = await check(firstText);
  if (!first.bookingContext.missing.includes('meridiem')) throw new Error('missing_ambiguity_check');
  const second = await check('아하 오후야', first.bookingContext, [
    { role: 'user', content: firstText }, { role: 'assistant', content: '말씀하신 시각은 오전인가요, 오후인가요?' },
  ]);
  if (second.start !== '17:00' || second.date !== '2026-09-29' || second.action !== 'explore') throw new Error('followup_mismatch');
  const third = await check('9월 29일 오후 5시부터 1시간 정도');
  if (third.start !== '17:00' || third.end !== '18:00' || third.action !== 'explore') throw new Error('duration_mismatch');
  const fourth = await check('다음 주 수요일에 넷이 들어갈 회의실 있어?');
  if (fourth.date !== '2026-10-07' || fourth.capacity !== 4 || fourth.action !== 'explore') throw new Error('date_capacity_mismatch');
  console.log(JSON.stringify({ passed: 4, calls: usage.length, inputTokens: usage.reduce((n, u) => n + (u.promptTokenCount || 0), 0),
    outputTokens: usage.reduce((n, u) => n + (u.candidatesTokenCount || 0), 0), thinkingTokens: usage.reduce((n, u) => n + (u.thoughtsTokenCount || 0), 0) }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, code: /^[a-z_]+$/.test(error.message || '') ? error.message : 'model_check_failed', calls: usage.length }));
  process.exitCode = 1;
}
