import { it, expect, vi } from 'vitest';
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

it('counts the complete Developer API request through the real SDK and stops over budget', async () => {
  const requests = [];
  let totalTokens = 100;
  vi.stubGlobal('fetch', async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(JSON.stringify(String(url).includes(':countTokens') ? { totalTokens } : {
      candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const complete = createGeminiCompletion({ apiKey: 'test-not-a-secret', maxInputTokens: 16000 });
    const input = { messages: [{ role: 'system', content: 'Only verified facts' }, { role: 'user', content: '조회' }],
      tools: [{ function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } } }], signal: AbortSignal.timeout(5000) };
    await complete(input);
    expect(requests).toHaveLength(2);
    expect(requests[0].body).not.toHaveProperty('contents');
    expect(requests[0].body.generateContentRequest.contents).toEqual(requests[1].body.contents);
    expect(requests[0].body.generateContentRequest.tools).toEqual(requests[1].body.tools);
    expect(requests[0].body.generateContentRequest.systemInstruction).toEqual(requests[1].body.systemInstruction);
    totalTokens = 16001;
    await expect(complete(input)).rejects.toThrow('Gemini');
    expect(requests).toHaveLength(3);
  } finally { vi.unstubAllGlobals(); }
});
