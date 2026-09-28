import { renderToolFailures, modelContinuationFailure } from './agent-failure-message.mjs';
import WebSocket from 'ws';
import * as z from 'zod/v4';
import { fetchGoogleIdentityToken, resolveJavaWeeklyApiServiceAccountJson } from '../bff/java-weekly-auth.mjs';
import { classifyReadError } from './support-read.mjs';

export const HERMES_READ_TOOLS = Object.freeze(['cashflow_status', 'settlement_status_report', 'settlement_report', 'reformat_report', 'agent_capabilities', 'project_search', 'clarify_request', 'accounting_read', 'accounting_report', 'accounting_compare', 'cfo_brief', 'agent_diagnostics', 'system_knowledge']);

async function openSocket({ url, headers, signal }) {
  const socket = new WebSocket(url, { headers, maxPayload: 200000, handshakeTimeout: 15000, followRedirects: false });
  await new Promise((resolve, reject) => {
    const abort = () => { socket.terminate(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    socket.once('open', () => { signal.removeEventListener('abort', abort); resolve(); });
    socket.once('error', (error) => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
  return socket;
}

export async function runHermesAgent({ question, history = [], tools, signal = AbortSignal.timeout(100000),
  record = async () => {}, loadFeedback = async () => [], env = process.env,
  connect = openSocket, getToken = () => fetchGoogleIdentityToken(fetch, env.SETTLEMENT_HERMES_URL,
    resolveJavaWeeklyApiServiceAccountJson({}, env), undefined, signal),
}) {
  signal.throwIfAborted();
  const base = new URL(env.SETTLEMENT_HERMES_URL);
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.run.app') || base.username || base.password || base.pathname !== '/' || base.search || base.hash || base.port) throw new Error('hermes_endpoint_invalid');
  if (typeof question !== 'string' || !question.trim() || question.length > 8000) throw new Error('hermes_question_invalid');
  if (!Array.isArray(history) || history.length > 12 || history.length % 2 || history.some((m, i) => m?.role !== (i % 2 ? 'assistant' : 'user') || typeof m.content !== 'string')) throw new Error('hermes_history_invalid');
  history = structuredClone(history);
  while (history.reduce((size, message) => size + message.content.length, 0) > 12000) history.splice(0, 2);
  const registry = new Map();
  for (const tool of tools) {
    if (!HERMES_READ_TOOLS.includes(tool.name)) continue;
    if (registry.has(tool.name)) throw new Error('hermes_duplicate_tool');
    registry.set(tool.name, tool);
  }
  if (!registry.size) throw new Error('hermes_tools_missing');
  const start = { type: 'start', question, history, tools: [...registry.values()].map(({ name, description, schema }) => ({ name, description, parameters: z.toJSONSchema(schema) })) };
  if (Buffer.byteLength(JSON.stringify(start)) > 200000) throw new Error('hermes_input_too_large');
  const token = await getToken();
  if (!token) throw new Error('hermes_identity_missing');
  signal.throwIfAborted();
  const socket = await connect({ url: `${base.origin.replace('https:', 'wss:')}/run`, headers: { Authorization: `Bearer ${token}` }, signal });
  const disconnected = new AbortController();
  signal = AbortSignal.any([signal, disconnected.signal]);
  const answers = [];
  const seen = new Set();
  const failures = [];
  let terminal = false;
  let finalQueued = false;
  let queued = 0;
  let chain = Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      if (terminal) return;
      terminal = true;
      signal.removeEventListener('abort', abort);
      socket.close();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(signal.reason || new Error('hermes_cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    socket.on('error', () => finish(new Error('hermes_transport_failed')));
    socket.on('close', () => {
      if (!terminal && !finalQueued) disconnected.abort(new Error('hermes_disconnected'));
    });
    socket.on('message', (raw, binary) => {
      if (terminal) return;
      if (binary || Buffer.byteLength(raw) > 200000 || ++queued > 16) { finish(new Error('hermes_frame_invalid')); return; }
      let message;
      try { message = JSON.parse(raw.toString()); } catch { finish(new Error('hermes_frame_invalid')); return; }
      if (!message || typeof message !== 'object' || finalQueued) { finish(new Error('hermes_frame_invalid')); return; }
      if (message.type === 'final') finalQueued = true;
      chain = chain.then(async () => {
        if (terminal) return;
        signal.throwIfAborted();
        if (message.type === 'error') {
          if (message.usage && ['input', 'output', 'thinking'].every((key) => Number.isSafeInteger(message.usage[key]) && message.usage[key] >= 0)) {
            await record({ type: 'usage', phase: 'hermes_failed', input: message.usage.input, output: message.usage.output, thinking: message.usage.thinking });
          }
          throw new Error('hermes_execution_failed');
        }
        if (message.type === 'tool_call') {
          if (typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.id) || seen.has(message.id) || seen.size >= 12) throw new Error('hermes_call_invalid');
          seen.add(message.id);
          const tool = registry.get(message.name);
          if (!tool) throw new Error('hermes_tool_denied');
          let result;
          let stage = 'input';
          try {
            const input = tool.schema.parse(message.arguments);
            stage = 'policy';
            const scope = { question: question.trim(), tool: tool.name, input: structuredClone(input) };
            if (Array.isArray(scope.input.projectIds)) scope.input.projectIds.sort();
            await loadFeedback(scope);
            signal.throwIfAborted();
            stage = 'record';
            await record({ type: 'hermes_tool_start', tool: tool.name, input });
            signal.throwIfAborted();
            stage = 'execute';
            const value = await tool.execute(input, { signal });
            signal.throwIfAborted();
            stage = 'render';
            result = tool.modelResult ? tool.modelResult(value) : value;
            if (!result || Buffer.byteLength(JSON.stringify(result)) > 100000) throw new Error('hermes_result_too_large');
            if (typeof tool.render !== 'function') throw new Error('hermes_renderer_missing');
            const rendered = tool.render(value);
            if (typeof rendered !== 'string' || !rendered.trim() || rendered.length > 100000) throw new Error('hermes_render_invalid');
            stage = 'record';
            await record({ type: 'hermes_tool_result', tool: tool.name, input, result });
            if (tool.requiresReply) { finish(null, { status: 'needs_clarification', answer: rendered }); return; }
            if (!answers.includes(rendered)) answers.push(rendered);
          } catch (error) {
            signal.throwIfAborted();
            const failure = classifyReadError(error);
            failures.push({ tool: tool.name, stage, category: failure.category });
            result = { ...failure, error: failure.code || 'lookup_failed' };
            await record({ type: 'hermes_tool_failure', tool: tool.name, stage, category: failure.category, code: result.error });
          }
          if (!terminal) socket.send(JSON.stringify({ type: 'tool_result', id: message.id, result }));
          return;
        }
        if (message.type !== 'final' || typeof message.answer !== 'string' || !message.answer.trim() || message.answer.length > 38000) throw new Error('hermes_final_invalid');
        const usage = message.usage || {};
        if (['input', 'output', 'thinking'].some((key) => !Number.isSafeInteger(usage[key]) || usage[key] < 0)) throw new Error('hermes_usage_invalid');
        await record({ type: 'usage', phase: 'hermes', input: usage.input, output: usage.output, thinking: usage.thinking });
        await record({ type: 'answer_policy', policy: 'server_evidence_only', harness: 'hermes', renderedResults: answers.length });
        const partial = failures.length > 0 || message.partial === true;
        if (!answers.length) { finish(null, { status: failures.length ? 'partial' : 'unverified', answer: renderToolFailures(failures) || '조회 근거를 확인하지 못했습니다. 사업과 기간을 확인해 다시 요청해주세요.' }); return; }
        finish(null, { status: partial ? 'partial' : 'answered', answer: [...answers,
          ...(failures.length ? [renderToolFailures(failures)] : []),
          ...(message.partial === true ? [modelContinuationFailure] : [])].join('\n\n') });
      }).catch((error) => finish(error));
    });
    if (signal.aborted) abort();
    else socket.send(JSON.stringify(start));
  });
}
