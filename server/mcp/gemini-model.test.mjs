import { it, expect } from 'vitest';
import { createGeminiCompletion } from './gemini-model.mjs';

it('preserves signed tool parts and ends follow-up input with user role', async () => {
  const requests = [];
  const signed = { role: 'model', parts: [{ functionCall: { id: 'native-1', name: 'lookup', args: {} }, thoughtSignature: 'test-signature' }] };
  const complete = createGeminiCompletion({ client: { models: { generateContent: async (request) => {
    requests.push(request);
    return { candidates: [{ content: requests.length === 1 ? signed : { role: 'model', parts: [{ text: '확인 완료' }] } }] };
  } } } });
  const signal = AbortSignal.timeout(1000);
  const messages = [{ role: 'user', content: '조회' }];
  const first = await complete({ messages, tools: [], signal });
  messages.push({ role: 'assistant', tool_calls: first.tool_calls });
  messages.push({ role: 'tool', tool_call_id: first.tool_calls[0].id, content: '{"status":"pending"}' });
  await complete({ messages, tools: [], signal });
  expect(requests[1].contents[1]).toEqual(signed);
  expect(requests[1].contents.at(-1).role).toBe('user');
  expect(requests[1].contents.at(-1).parts[0].functionResponse.id).toBe('native-1');
  expect(requests[1].config).not.toHaveProperty('temperature');
});
