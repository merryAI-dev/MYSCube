import { GoogleGenAI } from '@google/genai';
import { createHttpError } from '../bff/bff-utils.mjs';
import { attachCompletionContent, getNativeMessageContent } from './model-turn-history.mjs';

export function createHtmlCompletion({ apiKey, model = 'gemini-3.6-flash', client, onUsage = async () => {} }) {
  if (!client && !apiKey) throw createHttpError(503, 'HTML 생성용 AI 연결 설정이 필요합니다.', 'html_model_unconfigured');
  // The SDK retry wrapper drops the HTTP status of non-retryable failures.
  // Its ordinary transport makes one request and preserves ApiError.status.
  const ai = client || new GoogleGenAI({ apiKey });
  return async ({ messages, tools, signal }) => {
    signal.throwIfAborted();
    const call = async (stage, operation) => {
      try { return await operation(); }
      catch (error) {
        signal.throwIfAborted();
        const status = Number.isInteger(error?.status) ? error.status : null;
        const mapped = status === 400
          ? createHttpError(502, 'AI가 작업 요청 형식을 처리하지 못했습니다. 운영 담당자에게 알려주세요. 작성한 내용은 유지됩니다.', 'html_model_request_rejected')
          : createHttpError(503, 'AI 연결을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요. 작성한 내용은 유지됩니다.', 'html_model_unavailable');
        mapped.providerStage = stage;
        mapped.providerStatus = status;
        throw mapped;
      }
    };
    const systemInstruction = messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n');
    const contents = messages.filter((item) => item.role !== 'system').map((item) => getNativeMessageContent(item)
      || { role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.content }] });
    const declarations = tools.map(({ function: fn }) => ({ name: fn.name, description: fn.description, parametersJsonSchema: fn.parameters }));
    const counted = await call('countTokens', () => ai.models.countTokens({ model, config: { abortSignal: signal, httpOptions: { extraBody: { generateContentRequest: {
      model: `models/${model}`, contents, systemInstruction: { role: 'user', parts: [{ text: systemInstruction }] }, tools: [{ functionDeclarations: declarations }],
    } } } } }));
    if (!Number.isSafeInteger(counted.totalTokens) || counted.totalTokens > 32000) throw createHttpError(413, '참고 자료와 현재 소스가 AI 입력 한도를 넘었습니다. 소스를 나누어 요청해 주세요. 일부를 임의로 생략하지 않았습니다.', 'html_input_too_large');
    const response = await call('generateContent', () => ai.models.generateContent({ model, contents, config: { abortSignal: signal, systemInstruction,
      // ANY rejects the full discriminated action/filter schema before inference.
      // AUTO preserves that schema; domain parsers still reject invalid actions.
      maxOutputTokens: 16384, tools: [{ functionDeclarations: declarations }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    } }));
    await onUsage(response.usageMetadata || {});
    if (response.candidates?.[0]?.finishReason !== 'STOP') {
      const error = createHttpError(502, 'AI 응답이 끝까지 생성되지 않았습니다. 기존 소스를 유지합니다.', 'html_generation_incomplete');
      const reason = response.candidates?.[0]?.finishReason;
      error.providerFinishReason = ['MAX_TOKENS', 'SAFETY', 'RECITATION', 'LANGUAGE', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL'].includes(reason) ? reason : 'UNKNOWN';
      throw error;
    }
    const content = response.candidates[0].content;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const malformed = !Array.isArray(content?.parts) || parts.some((part) => !part || typeof part !== 'object' || Array.isArray(part)
      || (part.functionCall !== undefined && (!part.functionCall || typeof part.functionCall !== 'object' || Array.isArray(part.functionCall))));
    const calls = parts.filter((part) => part?.functionCall);
    if (malformed || calls.length !== 1 || !declarations.some(({ name }) => name === calls[0].functionCall.name)) {
      const error = createHttpError(502, 'AI가 실행할 작업을 명확히 지정하지 못했습니다. 요청을 다시 확인해 주세요. 작성한 내용은 유지됩니다.', 'html_model_action_invalid');
      error.providerActionReason = malformed ? 'malformed_response' : !calls.length ? 'no_function_call' : calls.length > 1 ? 'multiple_function_calls' : 'unknown_function';
      error.providerCallCount = Math.min(calls.length, 100);
      error.providerHasText = parts.some((part) => part?.thought !== true && typeof part?.text === 'string' && part.text.length > 0);
      throw error;
    }
    const result = { tool_calls: calls.map((part, index) => ({ id: part.functionCall.id || `html_${index}`, type: 'function',
      function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) } })) };
    return attachCompletionContent(result, { ...content, role: 'model' });
  };
}
