import Ajv from 'ajv/dist/2020.js';

// Official docs reviewed 2026-10-12:
// https://developers.openai.com/api/docs/guides/function-calling
// https://developers.openai.com/api/docs/guides/structured-outputs
// OpenAI strict objects require additionalProperties:false and every property required.
// Optional fields need nullable schemas, plus application-side null/absence handling.
// This preflight accepts the already-required answer/review contracts, without silently
// changing their semantics. Official non-fine-tuned schemas support maxItems; it
// remains intact and is checked again by local AJV. Fine-tuned models have extra limits.
// OpenAI actual status: NOT TESTED. Vertex's corrected schema reached HTTP 200 in
// the parent's probe; that neither proves full investigation success nor an OpenAI result.
// This is synthetic schema compatibility testing, NOT a production provider adapter.
const ENDPOINT = 'https://api.openai.com/v1/responses';
function fail(code) {
  return Object.assign(new Error(code), { code });
}
function strictSchema(schema) {
  const serialized = JSON.stringify(schema);
  if (!serialized || Buffer.byteLength(serialized) > 65536)
    throw fail('openai_preflight_schema_invalid');
  const copy = JSON.parse(serialized);
  function visit(node, depth = 0) {
    if (depth > 30) throw fail('openai_preflight_schema_invalid');
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (node.type === 'object') {
      const keys = Object.keys(node.properties || {});
      if (
        node.additionalProperties !== false ||
        !Array.isArray(node.required) ||
        keys.some((key) => !node.required.includes(key)) ||
        node.required.some((key) => !keys.includes(key))
      )
        throw fail('openai_preflight_schema_not_strict');
    }
    for (const child of Object.values(node)) visit(child, depth + 1);
  }
  if (copy.type !== 'object') throw fail('openai_preflight_schema_invalid');
  visit(copy);
  return copy;
}
function numericUsage(value) {
  return Object.fromEntries(
    ['input_tokens', 'output_tokens', 'total_tokens']
      .filter((key) => Number.isSafeInteger(value?.[key]) && value[key] >= 0)
      .map((key) => [key, value[key]])
  );
}
async function request(apiKey, body, signal) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw fail(
      signal.aborted
        ? 'openai_preflight_aborted'
        : 'openai_preflight_network_error'
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const category =
      {
        400: 'invalid_request',
        401: 'authentication',
        403: 'access_denied',
        404: 'model_or_route_unavailable',
        429: 'rate_limit',
      }[response.status] || 'provider_error';
    throw fail(`openai_preflight_${category}`);
  }
  // Bound response reads, including reasoning tokens; never log/return the raw body.
  const reader = response.body?.getReader();
  if (!reader) throw fail('openai_preflight_invalid_response');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1048576) {
        await reader.cancel();
        throw fail('openai_preflight_response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    throw fail('openai_preflight_response_read_failed');
  }
  let result;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw fail('openai_preflight_invalid_response');
  }
  if (result.status !== 'completed' || !Array.isArray(result.output))
    throw fail('openai_preflight_incomplete');
  return result;
}

/** Two paid requests using synthetic content only. No key means no network call.
 * A future tool loop must carry original response.output reasoning items in memory,
 * preserve encrypted_content returned with store:false, and match function_call_output
 * using the exact call_id. This probe does not implement or claim that loop.
 */
export async function preflightOpenAI({
  apiKey,
  model,
  answerSchema,
  reviewSchema,
  signal,
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim())
    return { status: 'not_tested', reason: 'api_key_missing' };
  if (
    /[\r\n]/.test(apiKey) ||
    apiKey.length > 4096 ||
    typeof model !== 'string' ||
    !model.trim() ||
    model.length > 200 ||
    /[\r\n]/.test(model)
  )
    throw fail('openai_preflight_config_invalid');
  const answerContract = strictSchema(answerSchema),
    reviewContract = strictSchema(reviewSchema);
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const validateAnswer = ajv.compile(answerContract),
    validateReview = ajv.compile(reviewContract);
  const timeout = AbortSignal.timeout(180000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const common = { model, store: false, max_output_tokens: 4096 };
  const first = await request(
    apiKey,
    {
      ...common,
      input:
        'Synthetic schema compatibility test only. Call finalize_investigation with facts=[], hypotheses=[], unknowns=["Synthetic test: no investigation performed"], user_reply="합성 schema 점검입니다.", next_actions=[], cause_status="not_established". Do not invent evidence.',
      tools: [
        {
          type: 'function',
          name: 'finalize_investigation',
          description: 'Return the synthetic schema test answer.',
          parameters: answerContract,
          strict: true,
        },
      ],
      tool_choice: { type: 'function', name: 'finalize_investigation' },
      parallel_tool_calls: false,
    },
    combined
  );
  const calls = first.output.filter((item) => item.type === 'function_call');
  if (
    calls.length !== 1 ||
    calls[0].name !== 'finalize_investigation' ||
    typeof calls[0].call_id !== 'string' ||
    !calls[0].call_id
  )
    throw fail('openai_preflight_invalid_tool_call');
  let answer;
  try {
    answer = JSON.parse(calls[0].arguments);
  } catch {
    throw fail('openai_preflight_invalid_arguments');
  }
  if (!validateAnswer(answer))
    throw fail('openai_preflight_answer_schema_failed');
  // The critic request is deliberately independent, with no first-response history.
  const second = await request(
    apiKey,
    {
      ...common,
      input:
        'Synthetic schema compatibility test only. Return accepted=true and findings=[]. This is not a review of business data.',
      text: {
        format: {
          type: 'json_schema',
          name: 'investigation_review',
          schema: reviewContract,
          strict: true,
        },
      },
    },
    combined
  );
  const parts = second.output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || []);
  if (parts.some((part) => part.type === 'refusal'))
    throw fail('openai_preflight_refused');
  let review;
  try {
    review = JSON.parse(
      parts
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text)
        .join('')
    );
  } catch {
    throw fail('openai_preflight_invalid_review');
  }
  if (!validateReview(review))
    throw fail('openai_preflight_review_schema_failed');
  return {
    status: 'passed',
    model,
    scope: 'synthetic_schema_compatibility_only',
    checks: [
      'strict_function_call',
      'original_answer_schema',
      'structured_review',
      'original_review_schema',
    ],
    usage: {
      answer: numericUsage(first.usage),
      review: numericUsage(second.usage),
    },
  };
}
