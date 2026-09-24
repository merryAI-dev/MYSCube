import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHtmlCompletion } from './html-completion.mjs';
import { runConversationTurn } from './conversation-agent.mjs';
import { SemanticQueryPlanSchema } from './semantic-query.mjs';
import * as z from 'zod/v4';
const tool = { type: 'function', function: { name: 'propose_html', description: 'HTML', parameters: { type: 'object' } } };
const input = () => ({ messages: [{ role: 'system', content: 'Use references' }, { role: 'user', content: 'Make HTML' }], tools: [tool], signal: new AbortController().signal });
describe('isolated HTML model completion', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uses the independent full-document output budget and passes usage, references and schema', async () => {
    const onUsage = vi.fn();
    const client = { models: { countTokens: vi.fn(async () => ({ totalTokens: 500 })), generateContent: vi.fn(async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'propose_html', args: { html: '<html></html>' } } }] } }], usageMetadata: { promptTokenCount: 500 } })) } };
    const result = await createHtmlCompletion({ client, onUsage })(input());
    expect(result.tool_calls[0].function.name).toBe('propose_html');
    expect(client.models.generateContent.mock.calls[0][0].config).toMatchObject({ maxOutputTokens: 16384, systemInstruction: 'Use references' });
    expect(client.models.generateContent.mock.calls[0][0].config.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    expect(client.models.generateContent.mock.calls[0][0].config.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(tool.function.parameters);
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
  it('preserves provider status and the failed stage with the actual SDK transport without retrying or exposing its response', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalTokens: 500 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 400, message: 'private request and secret' } }), { status: 400, statusText: 'Bad Request' }));
    vi.stubGlobal('fetch', fetch);
    const failure = await createHtmlCompletion({ apiKey: 'synthetic-test-key' })(input()).catch((error) => error);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(failure).toMatchObject({ code: 'html_model_request_rejected', statusCode: 502, providerStage: 'generateContent', providerStatus: 400 });
    expect(String(failure)).not.toContain('private request');
    expect(JSON.stringify(failure)).not.toContain('secret');
  });
  it('does not generate after token counting fails or retry provider quota failures', async () => {
    const client = { models: { countTokens: vi.fn().mockRejectedValue({ status: 429, message: 'sensitive detail' }), generateContent: vi.fn() } };
    await expect(createHtmlCompletion({ client })(input())).rejects.toMatchObject({ code: 'html_model_unavailable', providerStage: 'countTokens', providerStatus: 429 });
    expect(client.models.countTokens).toHaveBeenCalledTimes(1);
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });
  it('keeps cancellation as cancellation and does not charge usage for an unreturned response', async () => {
    const controller = new AbortController(), onUsage = vi.fn();
    const reason = new Error('cancelled');
    const client = { models: { countTokens: vi.fn(async () => { controller.abort(reason); throw { status: 400 }; }), generateContent: vi.fn() } };
    await expect(createHtmlCompletion({ client, onUsage })({ ...input(), signal: controller.signal })).rejects.toBe(reason);
    expect(client.models.generateContent).not.toHaveBeenCalled();
    expect(onUsage).not.toHaveBeenCalled();
  });
  it.each([
    [{ text: 'invented business answer' }],
    [{ functionCall: { name: 'unregistered', args: {} } }],
    [{ functionCall: { name: 'propose_html', args: {} } }, { functionCall: { name: 'propose_html', args: {} } }],
  ])('rejects unstructured, unregistered or multiple actions without treating text as a result: %j', async (...parts) => {
    const onUsage = vi.fn();
    const client = { models: { countTokens: vi.fn(async () => ({ totalTokens: 10 })), generateContent: vi.fn(async () => ({ candidates: [{ finishReason: 'STOP', content: { parts } }], usageMetadata: { totalTokenCount: 100 } })) } };
    await expect(createHtmlCompletion({ client, onUsage })(input())).rejects.toMatchObject({ code: 'html_model_action_invalid' });
    expect(onUsage).toHaveBeenCalledWith({ totalTokenCount: 100 });
  });
  const interpretation = (datasetIds = []) => ({ summary: '조회 기준 확인', context: { datasetIds, filters: {}, evidenceIds: [] }, ambiguities: [] });
  const conversation = (step, { authorize = vi.fn(async () => {}) } = {}) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalTokens: 500 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'workbench_step', args: step } }] } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const analytics = { catalog: vi.fn(async () => ({ items: [], semantic: { items: [] } })), queryPlan: vi.fn(), evidence: vi.fn(), recordEvidence: vi.fn() };
    let declaredSchema;
    const completion = createHtmlCompletion({ apiKey: 'synthetic-test-key' });
    const result = runConversationTurn({ context: { analyticsScope: { datasetIds: ['weekly_submission'] } }, message: '기준을 확인해 주세요.',
      complete: (request) => { declaredSchema = request.tools[0].function.parameters; return completion(request); }, analytics, authorize,
      qa: vi.fn(), bindHtml: vi.fn(), signal: new AbortController().signal, now: () => '2026-09-24T00:00:00.000Z' });
    return { result, fetch, analytics, schema: () => declaredSchema };
  };
  it('carries the original domain union and mixed filter-value schema through the real SDK without rewriting it', async () => {
    const step = { action: 'clarify', interpretation: { ...interpretation(), ambiguities: [{ field: 'period', reason: '연도가 정해지지 않았습니다.', question: '어느 연도인가요?', options: [] }] } };
    const run = conversation(step);
    await expect(run.result).resolves.toMatchObject({ status: 'clarification_required', answer: '어느 연도인가요?' });
    const requests = run.fetch.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(requests[0].generateContentRequest.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(run.schema());
    expect(requests[1].tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(run.schema());
    const queryBranch = run.schema().oneOf.find((branch) => branch.properties.action.const === 'query');
    const { $schema, ...originalPlan } = z.toJSONSchema(SemanticQueryPlanSchema);
    expect(queryBranch.properties.plan).toEqual(originalPlan);
    expect(requests[1].toolConfig.functionCallingConfig).toEqual({ mode: 'AUTO' });
    expect(run.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('rejects a permitted tool with invalid nested domain arguments before querying', async () => {
    const run = conversation({ action: 'query', interpretation: interpretation(['weekly_submission']),
      plan: { datasetId: 'weekly_submission', definitionVersion: '1', measures: ['observation_count'], filters: [{ field: 'status', op: 'eq', value: { untyped: 'COMPLETED' } }] } });
    await expect(run.result).rejects.toMatchObject({ code: 'conversation_plan_invalid' });
    expect(run.fetch).toHaveBeenCalledTimes(2);
    expect(run.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('keeps the domain permission check after a structurally valid AUTO tool response', async () => {
    const run = conversation({ action: 'query', interpretation: interpretation(['private_dataset']),
      plan: { datasetId: 'private_dataset', definitionVersion: '1', measures: ['observation_count'] } });
    await expect(run.result).rejects.toMatchObject({ code: 'conversation_dataset_forbidden', statusCode: 403 });
    expect(run.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('does not execute a valid response when authorization is revoked during the provider request', async () => {
    let checks = 0;
    const revoked = Object.assign(new Error('권한이 변경되었습니다.'), { statusCode: 403 });
    const authorize = vi.fn(async () => { if (++checks === 4) throw revoked; });
    const run = conversation({ action: 'query', interpretation: interpretation(['weekly_submission']),
      plan: { datasetId: 'weekly_submission', definitionVersion: '1', measures: ['observation_count'] } }, { authorize });
    await expect(run.result).rejects.toBe(revoked);
    expect(run.fetch).toHaveBeenCalledTimes(2);
    expect(run.analytics.queryPlan).not.toHaveBeenCalled();
  });
  it('does not retry an actual SDK transport quota response when retry options are absent', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 429, message: 'private quota detail' } }), { status: 429 }));
    vi.stubGlobal('fetch', fetch);
    const failure = await createHtmlCompletion({ apiKey: 'synthetic-test-key' })(input()).catch((error) => error);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(failure).toMatchObject({ code: 'html_model_unavailable', statusCode: 503, providerStage: 'countTokens', providerStatus: 429 });
    expect(JSON.stringify(failure)).not.toContain('private quota detail');
  });
});
