const failure = code => Object.assign(Error(code), { code });
const cancel = (body, reason) => { try { void body?.cancel(reason).catch(() => {}); } catch {} };

// Bound bytes before the SDK's JSON/SSE parsers, without treating partial data as a result.
export async function boundedMcpRequest({ request, signal, maxBytes, maxDurationMs, onFailure }) {
  if (typeof request !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 2147483647) {
    throw failure('investigation_mcp_budget_invalid');
  }
  const deadline = new AbortController();
  const active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(failure('investigation_mcp_response_timeout')), maxDurationMs);
  const clear = () => clearTimeout(timer);
  const report = error => {
    if (/^investigation_mcp_response_(timeout|too_large|invalid)$/.test(error?.code || '')) {
      try { onFailure?.(error); } catch {}
    }
  };
  let response;
  try {
    active.throwIfAborted();
    response = await new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => { if (!settled) { settled = true; reject(active.reason); } };
      active.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { active.throwIfAborted(); return request(active); }).then(value => {
        active.removeEventListener('abort', abort);
        if (settled) { cancel(value?.body, active.reason); return; }
        settled = true; resolve(value);
      }, error => {
        active.removeEventListener('abort', abort);
        if (!settled) { settled = true; reject(error); }
      });
    });
    active.throwIfAborted();
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      throw failure('investigation_mcp_response_too_large');
    }
    if (!response.body) { clear(); return response; }
    const reader = response.body.getReader();
    let size = 0, ended = false, controller;
    function stop(error) {
      if (ended) return;
      ended = true; clear(); active.removeEventListener('abort', abort);
      if (error) { controller.error(error); cancel(reader, error); report(error); }
      try { reader.releaseLock(); } catch {}
    }
    const abort = () => stop(active.reason);
    const body = new ReadableStream({
      start(value) { controller = value; active.addEventListener('abort', abort, { once: true }); if (active.aborted) abort(); },
      async pull() {
        try {
          active.throwIfAborted();
          const chunk = await reader.read();
          if (ended) return;
          active.throwIfAborted();
          if (chunk.done) { stop(); controller.close(); return; }
          if (!(chunk.value instanceof Uint8Array)) throw failure('investigation_mcp_response_invalid');
          size += chunk.value.byteLength;
          if (size > maxBytes) throw failure('investigation_mcp_response_too_large');
          controller.enqueue(chunk.value);
        } catch (error) { stop(error); }
      },
      cancel(reason) { cancel(reader, reason); stop(); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    clear(); cancel(response?.body, error); report(error); throw error;
  }
}

export async function boundedMcpOperation({ operation, signal, maxDurationMs, timeoutCode = 'investigation_mcp_operation_timeout' }) {
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 2147483647) {
    throw failure('investigation_mcp_budget_invalid');
  }
  const deadline = new AbortController();
  const active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(failure(timeoutCode)), maxDurationMs);
  let abort;
  try {
    active.throwIfAborted();
    const result = await new Promise((resolve, reject) => {
      abort = () => reject(active.reason);
      active.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { active.throwIfAborted(); return operation(active); }).then(resolve, reject);
    });
    active.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    if (abort) active.removeEventListener('abort', abort);
  }
}

export function boundedMcpAuthorization({ authorize, ...options }) {
  return boundedMcpOperation({ ...options, operation: authorize, timeoutCode: 'investigation_mcp_authority_timeout' });
}
