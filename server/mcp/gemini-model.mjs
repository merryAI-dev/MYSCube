import { GoogleGenAI } from '@google/genai';

// One adapter per run: signed model parts must not cross users or conversations.
export function createGeminiCompletion({ apiKey, model = 'gemini-3.6-flash', client, onUsage = async () => {} }) {
  if (!client && !apiKey) throw new Error('Gemini API 키가 설정되지 않았습니다.');
  const ai = client || new GoogleGenAI({ apiKey });
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
        for (const call of message.tool_calls) names.set(call.id, call.function.name);
      } else if (message.role === 'tool') {
        const call = names.get(message.tool_call_id);
        if (!call) throw new Error('도구 응답의 호출 정보가 없습니다.');
        const part = { functionResponse: { name: call, response: { result: JSON.parse(message.content) } } };
        if (contents.at(-1)?.role === 'user' && contents.at(-1).parts?.[0]?.functionResponse) contents.at(-1).parts.push(part);
        else contents.push({ role: 'user', parts: [part] });
      } else contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] });
    }
    if (contents.at(-1)?.role !== 'user') throw new Error('마지막 입력은 사용자 또는 도구 응답이어야 합니다.');
    let response;
    try {
      response = await ai.models.generateContent({ model, contents, config: {
        abortSignal: signal, maxOutputTokens: 2048,
        systemInstruction: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
        ...(tools.length ? { tools: [{ functionDeclarations: tools.map(({ function: f }) => ({ name: f.name, description: f.description, parametersJsonSchema: f.parameters })) }] } : {}),
      } });
    } catch { signal.throwIfAborted(); throw new Error('Gemini 연결에 실패했습니다. 키·모델 접근 권한·사용 한도를 확인해 주세요.'); }
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
