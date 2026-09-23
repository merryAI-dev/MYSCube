import { describe, expect, it, vi } from 'vitest';
import { createHtmlCompletion } from './html-completion.mjs';
const tool = { type: 'function', function: { name: 'propose_html', description: 'HTML', parameters: { type: 'object' } } };
const input = () => ({ messages: [{ role: 'system', content: 'Use references' }, { role: 'user', content: 'Make HTML' }], tools: [tool], signal: new AbortController().signal });
describe('isolated HTML model completion', () => {
  it('uses the independent full-document output budget and passes usage, references and schema', async () => {
    const onUsage = vi.fn();
    const client = { models: { countTokens: vi.fn(async () => ({ totalTokens: 500 })), generateContent: vi.fn(async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'propose_html', args: { html: '<html></html>' } } }] } }], usageMetadata: { promptTokenCount: 500 } })) } };
    const result = await createHtmlCompletion({ client, onUsage })(input());
    expect(result.tool_calls[0].function.name).toBe('propose_html');
    expect(client.models.generateContent.mock.calls[0][0].config).toMatchObject({ maxOutputTokens: 16384, systemInstruction: 'Use references' });
    expect(onUsage).toHaveBeenCalledWith({ promptTokenCount: 500 });
  });
  it('does not truncate an oversized current source or call generation', async () => {
    const client = { models: { countTokens: vi.fn(async () => ({ totalTokens: 32001 })), generateContent: vi.fn() } };
    await expect(createHtmlCompletion({ client })(input())).rejects.toMatchObject({ statusCode: 413 });
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });
  it('rejects token-truncated HTML as incomplete', async () => {
    const client = { models: { countTokens: vi.fn(async () => ({ totalTokens: 10 })), generateContent: vi.fn(async () => ({ candidates: [{ finishReason: 'MAX_TOKENS' }] })) } };
    await expect(createHtmlCompletion({ client })(input())).rejects.toMatchObject({ code: 'html_generation_incomplete' });
  });
});
