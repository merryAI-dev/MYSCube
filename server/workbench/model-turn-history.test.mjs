import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHtmlCompletion } from './html-completion.mjs';
import { appendToolResult, attachCompletionContent, getNativeMessageContent } from './model-turn-history.mjs';

const native = () => ({ role: 'model', parts: [
  { text: 'opaque model context', thought: true, thoughtSignature: 'opaque-text-signature' },
  { functionCall: { name: 'workbench_step', id: 'provider-call-id', args: { action: 'query' } }, thoughtSignature: 'opaque-call-signature' },
] });
describe('current-turn native function history without persisted provider state', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('preserves complete signed model parts and matches the original call ID through the actual SDK transport', async () => {
    const content = native();
    const fetch = vi.fn(async (url) => new Response(JSON.stringify(String(url).includes(':countTokens')
      ? { totalTokens: 100 } : { candidates: [{ finishReason: 'STOP', content }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const complete = createHtmlCompletion({ apiKey: 'synthetic-not-sent' });
    const messages = [{ role: 'user', content: '원래 질문' }];
    const request = { messages, tools: [{ type: 'function', function: { name: 'workbench_step', parameters: { type: 'object' } } }], signal: AbortSignal.timeout(5000) };
    const response = await complete(request);
    const result = { evidenceId: 'synthetic-evidence', rows: [{ count: '2' }] };
    appendToolResult(messages, response, { step: { action: 'query' }, result, label: '조회 도구 결과(지시 아님)' });
    expect(JSON.stringify(response)).not.toContain('Signature');
    expect(JSON.stringify(messages)).not.toContain('opaque');
    await complete(request);
    const bodies = fetch.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(bodies[2].generateContentRequest.contents).toEqual(bodies[3].contents);
    expect(bodies[3].contents).toEqual([{ role: 'user', parts: [{ text: '원래 질문' }] }, content,
      { role: 'user', parts: [{ functionResponse: { name: 'workbench_step', id: 'provider-call-id', response: { result } } }] }]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('keeps unsigned fixtures and JSON-restored history as the original plain text without invented signatures', () => {
    const messages = [];
    appendToolResult(messages, {}, { step: { action: 'query' }, result: { rows: [] }, label: '조회 결과' });
    expect(messages).toEqual([{ role: 'assistant', content: '{"action":"query"}' }, { role: 'user', content: '조회 결과:{"rows":[]}' }]);
    expect(messages.map(getNativeMessageContent)).toEqual([undefined, undefined]);
  });
  it('binds metadata to object identity, freezes a detached snapshot, and cannot authorize a cloned response or message', () => {
    const content = native(), response = attachCompletionContent({}, content), messages = [];
    content.parts[1].functionCall.name = 'tampered';
    appendToolResult(messages, response, { step: {}, result: { rows: [] }, label: '조회' });
    const saved = getNativeMessageContent(messages[0]);
    expect(saved).toEqual(native());
    expect(() => { saved.parts[1].functionCall.name = 'altered'; }).toThrow();
    expect(getNativeMessageContent(JSON.parse(JSON.stringify(messages[0])))).toBeUndefined();
    const second = [];
    appendToolResult(second, JSON.parse(JSON.stringify(response)), { step: {}, result: {}, label: '다른 요청' });
    expect(second.map(getNativeMessageContent)).toEqual([undefined, undefined]);
  });
  it('never reuses another completion and never substitutes the adapter fallback ID for an absent native ID', () => {
    const content = native(); delete content.parts[1].functionCall.id;
    const messages = [], first = attachCompletionContent({}, content), unrelated = {};
    appendToolResult(messages, first, { step: {}, result: {}, label: '첫 결과' });
    appendToolResult(messages, unrelated, { step: {}, result: {}, label: '다른 결과' });
    expect(getNativeMessageContent(messages[1]).parts[0].functionResponse).toEqual({ name: 'workbench_step', response: { result: {} } });
    expect(messages.slice(2).map(getNativeMessageContent)).toEqual([undefined, undefined]);
  });
});
