import { GoogleGenAI } from '@google/genai';

// One adapter per run: signed model parts must not cross users or conversations.
export function createGeminiCompletion({ apiKey, model = 'gemini-3.6-flash', client, onUsage = async () => {}, maxInputTokens }) {
  if (!client && !apiKey) throw new Error('Gemini API 키가 설정되지 않았습니다.');
  const ai = client || new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
  const signedReplies = new Map();
  let sequence = 0;
  return async ({ messages, tools, signal }) => {
    signal.throwIfAborted();
    const names = new Map();
    const contents = [];
    for (const message of messages) {
      if (message.role === 'system') continue;
      if (message.role === 'assistant' && message.tool_calls?.length) {
        const saved = signedReplies.get(message.tool_calls[0].id);
        if (!saved) throw new Error('모델 도구 호출 이력이 일치하지 않습니다.');
        contents.push(saved);
        const nativeCalls = saved.parts.filter((part) => part.functionCall);
        for (const [index, call] of message.tool_calls.entries()) names.set(call.id, nativeCalls[index].functionCall);
      } else if (message.role === 'tool') {
        const call = names.get(message.tool_call_id);
        if (!call) throw new Error('도구 응답의 호출 정보가 없습니다.');
        const part = { functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: { result: JSON.parse(message.content) } } };
        if (contents.at(-1)?.role === 'user' && contents.at(-1).parts?.[0]?.functionResponse) contents.at(-1).parts.push(part);
        else contents.push({ role: 'user', parts: [part] });
      } else contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] });
    }
    if (contents.at(-1)?.role !== 'user') throw new Error('마지막 입력은 사용자 또는 도구 응답이어야 합니다.');
    let response;
    try {
      const sharedConfig = {
        abortSignal: signal,
        systemInstruction: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
        ...(tools.length ? { tools: [{ functionDeclarations: tools.map(({ function: f }) => ({ name: f.name, description: f.description, parametersJsonSchema: f.parameters })) }] } : {}),
      };
      if (maxInputTokens) {
        // The Developer API supports the full request, but the SDK's count config does not.
        const counted = await ai.models.countTokens({ model, config: { abortSignal: signal, httpOptions: { extraBody: {
          generateContentRequest: { model: `models/${model}`, contents,
            systemInstruction: { role: 'user', parts: [{ text: sharedConfig.systemInstruction }] },
            ...(sharedConfig.tools ? { tools: sharedConfig.tools } : {}),
          },
        } } } });
        if (!Number.isSafeInteger(counted.totalTokens) || counted.totalTokens > maxInputTokens) throw new Error('input_budget_exceeded');
      }
      response = await ai.models.generateContent({ model, contents, config: {
        ...sharedConfig, maxOutputTokens: 2048,
      } });
    } catch (error) {
      signal.throwIfAborted();
      throw Object.assign(new Error('Gemini 연결에 실패했습니다. 키·모델 접근 권한·사용 한도를 확인해 주세요.'), {
        providerStatus: Number.isInteger(error?.status) ? error.status : null,
        providerReason: String(error?.message).includes('API_KEY_INVALID') ? 'API_KEY_INVALID' : 'PROVIDER_REQUEST_FAILED',
      });
    }
    await onUsage(response.usageMetadata || {});
    const content = response.candidates?.[0]?.content;
    if (!content?.parts?.length) throw new Error('Gemini 응답에 사용할 내용이 없습니다.');
    const calls = content.parts.filter((part) => part.functionCall).map((part) => ({
      id: `gemini_${++sequence}`, type: 'function',
      function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
    }));
    if (calls.length) signedReplies.set(calls[0].id, structuredClone(content));
    return { content: content.parts.filter((part) => part.text && !part.thought).map((part) => part.text).join(''), ...(calls.length ? { tool_calls: calls } : {}) };
  };
}
