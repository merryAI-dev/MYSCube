import { GoogleGenAI } from '@google/genai';
import { createHttpError } from '../bff/bff-utils.mjs';

export function createHtmlCompletion({ apiKey, model = 'gemini-3.6-flash', client, onUsage = async () => {} }) {
  if (!client && !apiKey) throw createHttpError(503, 'HTML 생성용 AI 연결 설정이 필요합니다.', 'html_model_unconfigured');
  const ai = client || new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
  return async ({ messages, tools, signal }) => {
    signal.throwIfAborted();
    const systemInstruction = messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n');
    const contents = messages.filter((item) => item.role !== 'system').map((item) => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.content }] }));
    const declarations = tools.map(({ function: fn }) => ({ name: fn.name, description: fn.description, parametersJsonSchema: fn.parameters }));
    const counted = await ai.models.countTokens({ model, config: { abortSignal: signal, httpOptions: { extraBody: { generateContentRequest: {
      model: `models/${model}`, contents, systemInstruction: { role: 'user', parts: [{ text: systemInstruction }] }, tools: [{ functionDeclarations: declarations }],
    } } } } });
    if (!Number.isSafeInteger(counted.totalTokens) || counted.totalTokens > 32000) throw createHttpError(413, '참고 자료와 현재 소스가 AI 입력 한도를 넘었습니다. 소스를 나누어 요청해 주세요. 일부를 임의로 생략하지 않았습니다.', 'html_input_too_large');
    const response = await ai.models.generateContent({ model, contents, config: { abortSignal: signal, systemInstruction,
      maxOutputTokens: 16384, tools: [{ functionDeclarations: declarations }], toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    } });
    await onUsage(response.usageMetadata || {});
    if (response.candidates?.[0]?.finishReason !== 'STOP') throw createHttpError(502, 'HTML 응답이 끝까지 생성되지 않았습니다. 기존 소스를 유지합니다.', 'html_generation_incomplete');
    const parts = response.candidates[0].content?.parts || [];
    return { tool_calls: parts.filter((part) => part.functionCall).map((part, index) => ({ id: `html_${index}`, type: 'function',
      function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) } })) };
  };
}
