import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedMcpRequest } from './mcp-response-budget.mjs';
const options = { maxBytes: 8, maxDurationMs: 100 };
const bytes = value => new TextEncoder().encode(value);

test('actual bytes reject absent and understated Content-Length without partial success', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    const response = await boundedMcpRequest({ ...options,
      request: async () => new Response('0123456789', { headers }),
    });
    await assert.rejects(response.text(), /too_large/);
  }
  await assert.rejects(boundedMcpRequest({ ...options,
    request: async () => new Response('a', { headers: { 'content-length': '99' } }),
  }), /too_large/);
});

test('fixed deadline terminates hanging body even if cancellation never resolves', async () => {
  let cancelled = 0;
  const response = await boundedMcpRequest({ ...options, maxDurationMs: 15,
    request: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes('a')); },
      cancel() { cancelled++; return new Promise(() => {}); },
    })),
  });
  await assert.rejects(response.text(), /response_timeout/);
  assert.equal(cancelled, 1);
});

test('late response after a non-cooperative request timeout is disposed', async () => {
  let complete, cancelled = 0;
  const result = boundedMcpRequest({ ...options, maxDurationMs: 15,
    request: () => new Promise(resolve => { complete = resolve; }),
  });
  await assert.rejects(result, /response_timeout/);
  complete(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
});

test('normal EOF, consumer cancellation and parent abort settle independently', async () => {
  let failures = 0;
  const successful = await boundedMcpRequest({ ...options, request: async () => new Response('good'), onFailure: () => failures++ });
  assert.equal(await successful.text(), 'good');
  let cancelled = 0;
  const response = await boundedMcpRequest({ ...options, request: async () => new Response(new ReadableStream({ cancel() { cancelled++; } })) });
  await response.body.cancel(); assert.equal(cancelled, 1);
  const parent = new AbortController(), reason = Error('cancelled');
  const pending = boundedMcpRequest({ ...options, signal: parent.signal, request: () => new Promise(() => {}) });
  parent.abort(reason); await assert.rejects(pending, e => e === reason);
  assert.equal(failures, 0);
});
