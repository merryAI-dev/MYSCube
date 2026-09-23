import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { checkArtifact, checkEvent, checkViewport, dockerRunArguments, REMOTE_LIMITS, remoteError } from './contract.mjs';

const scopeKey = (context) => {
  if (![context?.tenantId, context?.actorId, context?.analyticsScope?.fingerprint].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200)) throw remoteError('remote_scope_invalid', '미리보기의 계정과 자료 권한을 확인해 주세요.', 403);
  return JSON.stringify([context.tenantId, context.actorId, context.analyticsScope.fingerprint]);
};
const fail = (message, code = 'remote_runtime_failed', status = 503) => remoteError(code, message, status);
const defaultSpawn = (args) => spawn('docker', args, { env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

export function createRemoteRuntimeBroker({ authorize, callApi, spawnDocker = defaultSpawn, now = () => Date.now(), limits = {} }) {
  if (typeof authorize !== 'function' || typeof callApi !== 'function') throw new Error('Remote renderer requires explicit authorization and API routing');
  const cap = Object.fromEntries(Object.entries(REMOTE_LIMITS).map(([key, value]) => [key, Number.isFinite(limits[key]) && limits[key] > 0 ? Math.min(value, limits[key]) : value]));
  const sessions = new Map();
  const release = (session) => {
    sessions.delete(session.id);
    const previous = sessions.get(session.previousSessionId);
    if (previous?.candidateId === session.id) previous.candidateId = null;
  };
  const removeContainer = (session) => {
    if (session.removing || !sessions.has(session.id)) return;
    session.removing = true; session.cleanupAttempts++;
    let removal, settled = false;
    const finish = (success) => {
      if (settled) return; settled = true; clearTimeout(timer); session.removing = false;
      if (success) { release(session); return; }
      session.cleanupFailed = true;
      if (session.cleanupAttempts < 3) {
        session.cleanupRetry = setTimeout(() => removeContainer(session), 100); session.cleanupRetry.unref();
      }
    };
    const timer = setTimeout(() => { removal?.kill('SIGKILL'); finish(false); }, 3000); timer.unref();
    try {
      removal = spawnDocker(['rm', '-f', session.container]);
      removal.once('error', () => finish(false)); removal.once('close', code => finish(code === 0));
      removal.stdout?.resume(); removal.stderr?.resume();
    } catch { finish(false); }
  };
  const clean = (session, reason = fail('미리보기 실행이 종료되었습니다.', 'remote_session_closed', 410)) => {
    if (session.closed) return; session.closed = true; clearTimeout(session.ttl); clearInterval(session.authPoll);
    for (const request of session.pending.values()) { clearTimeout(request.timer); request.reject(reason); } session.pending.clear();
    for (const controller of session.apiControllers.values()) controller.abort(); session.apiControllers.clear();
    session.process.stdin.destroy(); session.process.kill('SIGKILL');
    session.cleanupAttempts = 0; removeContainer(session);
  };
  const sameOwner = (session, context) => session.context.tenantId === context?.tenantId && session.context.actorId === context?.actorId;
  const pollAuthorization = async (session) => {
    if (session.closed || session.authPolling) return; session.authPolling = true;
    let timer;
    try {
      await Promise.race([authorize(session.context), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(fail('미리보기 권한 확인 시간이 지났습니다.', 'remote_auth_timeout', 504)), 10000); timer.unref(); })]);
      if (scopeKey(session.context) !== session.scope) throw fail('조회 권한이 변경되었습니다.', 'remote_scope_changed', 403);
    } catch { clean(session, fail('미리보기 조회 권한을 확인하지 못했습니다.', 'remote_scope_changed', 403)); }
    finally { clearTimeout(timer); session.authPolling = false; }
  };
  const send = (session, message) => {
    if (session.closed) throw fail('미리보기 실행이 종료되었습니다.', 'remote_session_closed', 410);
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > cap.inputBytes || session.process.stdin.writableLength + Buffer.byteLength(line) > cap.inputBytes * 2) { clean(session); throw fail('미리보기 전달 한도를 넘었습니다.', 'remote_input_limit', 413); }
    session.process.stdin.write(line);
  };
  const request = (session, type, data = {}) => {
    if (session.pending.size >= 1) return Promise.reject(fail('화면 처리 중입니다. 잠시 후 다시 시도해 주세요.', 'remote_busy', 409));
    if (++session.commands > cap.commands) { clean(session); return Promise.reject(fail('미리보기 조작 한도에 도달했습니다. 새 미리보기를 열어 주세요.', 'remote_command_limit', 429)); }
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => clean(session, fail('React 실행 시간이 한도를 넘었습니다. 마지막 정상 화면을 유지합니다.', 'remote_command_timeout', 504)), cap.commandMs); timer.unref();
      session.pending.set(requestId, { resolve, reject, timer });
      try { send(session, { type, requestId, ...data }); } catch (error) { clearTimeout(timer); session.pending.delete(requestId); reject(error); }
    });
  };
  const withOwner = async (context, id) => {
    const session = sessions.get(id);
    try { await authorize(context); }
    catch (error) { if (session && sameOwner(session, context)) clean(session); throw error; }
    let scope;
    try { scope = scopeKey(context); }
    catch (error) { if (session && sameOwner(session, context)) clean(session); throw error; }
    if (session && sameOwner(session, context) && session.scope !== scope) clean(session);
    if (!session || session.scope !== scope || session.closed || session.expiresAt <= now()) throw fail('현재 계정에서 열 수 없거나 만료된 미리보기입니다.', 'remote_session_not_found', 404);
    return session;
  };
  const bridge = async (session, message) => {
    if (++session.apiCalls > cap.apiCalls || session.apiControllers.size >= cap.pendingApi || typeof message.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(message.requestId) || session.seenApi.has(message.requestId)) { clean(session, fail('API 호출 한도를 넘었습니다.', 'remote_api_limit', 429)); return; }
    const binding = session.bindings.find(item => item.id === message.apiId);
    if (!binding || !message.input || typeof message.input !== 'object' || Array.isArray(message.input) || Buffer.byteLength(JSON.stringify(message.input)) > 32768) { clean(session, fail('이 화면에 허용되지 않은 API 요청입니다.', 'remote_api_forbidden', 403)); return; }
    session.seenApi.add(message.requestId);
    const controller = new AbortController(); session.apiControllers.set(message.requestId, controller);
    const timer = setTimeout(() => controller.abort(), cap.apiMs); timer.unref();
    try {
      const timedOut = () => fail('API 조회 시간이 지났습니다.', 'remote_api_timeout', 504);
      const assertActive = () => { if (controller.signal.aborted || session.closed) throw timedOut(); };
      let abort;
      const deadline = new Promise((_resolve, reject) => {
        abort = () => reject(timedOut());
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
      });
      const operation = async () => {
        assertActive(); await authorize(session.context); assertActive();
        if (scopeKey(session.context) !== session.scope) throw fail('조회 권한이 변경되었습니다.', 'remote_scope_changed', 403);
        const result = await callApi(session.context, { apiId: binding.id, apiVersion: binding.version, input: message.input, signal: controller.signal });
        assertActive(); await authorize(session.context); assertActive();
        if (scopeKey(session.context) !== session.scope) throw fail('조회 권한이 변경되었습니다.', 'remote_scope_changed', 403);
        if (Buffer.byteLength(JSON.stringify(result)) > 256000) throw fail('API 결과가 전달 한도를 넘었습니다.', 'remote_api_result_large', 413);
        return result;
      };
      let result;
      try { result = await Promise.race([operation(), deadline]); }
      finally { controller.signal.removeEventListener('abort', abort); }
      send(session, { type: 'api-result', requestId: message.requestId, ok: true, result });
    } catch (error) {
      if (error.statusCode === 403 || error.statusCode === 401) clean(session, fail('미리보기 조회 권한이 변경되었습니다.', 'remote_scope_changed', 403));
      else if (!session.closed) { try { send(session, { type: 'api-result', requestId: message.requestId, ok: false, message: error.expose ? error.message.slice(0, 500) : '연결 자료를 조회하지 못했습니다.' }); } catch {} }
    } finally { clearTimeout(timer); session.apiControllers.delete(message.requestId); }
  };
  const receive = (session, message) => {
    if (message.type === 'api-call') { void bridge(session, message); return; }
    if (message.type === 'runtime-error') { clean(session, fail('React 화면에서 오류가 발생했습니다. 저장된 코드를 확인해 주세요.', 'remote_react_error', 422)); return; }
    const pending = session.pending.get(message.requestId);
    if (!pending || !['frame', 'error'].includes(message.type)) { clean(session, fail('실행 공간의 응답 형식을 확인하지 못했습니다.', 'remote_protocol_invalid')); return; }
    if (message.type === 'error') { clean(session, fail('React 미리보기를 완성하지 못했습니다.', 'remote_react_error', 422)); return; }
    let png;
    if (typeof message.pngBase64 === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(message.pngBase64)) png = Buffer.from(message.pngBase64, 'base64');
    if (!png || png.length < 24 || png.length > 640000 || png.toString('base64') !== message.pngBase64 || png.readUInt32BE(16) !== session.viewport.width || png.readUInt32BE(20) !== session.viewport.height || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || message.width !== session.viewport.width || message.height !== session.viewport.height
      || !Number.isSafeInteger(message.sequence) || message.sequence <= session.sequence) { clean(session, fail('미리보기 이미지와 순서를 확인하지 못했습니다.', 'remote_frame_invalid')); return; }
    session.sequence = message.sequence;
    clearTimeout(pending.timer); session.pending.delete(message.requestId);
    pending.resolve({ pngBase64: message.pngBase64, width: message.width, height: message.height, sequence: message.sequence, sourceHash: session.sourceHash });
  };
  return {
    async create(context, input) {
      await authorize(context); const scope = scopeKey(context);
      const artifact = checkArtifact(input.artifact); const viewport = checkViewport(input.viewport);
      if (!/^[a-f0-9]{64}$/.test(input.sourceHash || '') || input.artifact.sourceHash !== input.sourceHash || !Array.isArray(input.apiBindings) || input.apiBindings.length > 12 || input.apiBindings.some(item => !item || !/^[a-f0-9-]{36}$/.test(item.id || '') || !Number.isSafeInteger(item.version) || item.version < 1) || new Set(input.apiBindings.map(item => item.id)).size !== input.apiBindings.length) throw fail('실행할 원문과 API 연결 버전을 확인해 주세요.', 'remote_binding_invalid', 400);
      const owned = [...sessions.values()].filter(item => item.context.tenantId === context.tenantId && item.context.actorId === context.actorId);
      let previous;
      if (input.previousSessionId) {
        previous = sessions.get(input.previousSessionId);
        if (!previous || previous.scope !== scope || previous.closed || previous.candidateId || previous.pending.size || previous.sequence < 1) throw fail('교체할 정상 미리보기를 확인해 주세요.', 'remote_previous_invalid', 409);
      }
      if (sessions.size >= cap.sessions || (owned.length >= cap.actorSessions && !(previous && owned.length === cap.actorSessions))) throw fail('열린 미리보기 수가 한도에 도달했습니다. 기존 미리보기를 닫아 주세요.', 'remote_capacity', 429);
      const id = randomUUID(); const container = `axr-render-${id}`;
      const process = spawnDocker(dockerRunArguments(container));
      const session = { id, container, process, scope, previousSessionId: previous?.id, context: { ...context, analyticsScope: structuredClone(context.analyticsScope), ...(context.remoteEvidence ? { remoteEvidence: context.remoteEvidence } : {}) }, sourceHash: input.sourceHash, viewport, bindings: input.apiBindings.map(item => ({ id: item.id, version: item.version })), expiresAt: now() + cap.ttlMs,
        pending: new Map(), apiControllers: new Map(), seenApi: new Set(), buffer: '', bytes: 0, apiCalls: 0, commands: 0, sequence: 0, closed: false };
      sessions.set(id, session); if (previous) previous.candidateId = id; session.ttl = setTimeout(() => clean(session), cap.ttlMs); session.ttl.unref();
      session.authPoll = setInterval(() => { void pollAuthorization(session); }, 30000); session.authPoll.unref();
      process.once('error', () => clean(session, fail('독립 실행 공간을 시작하지 못했습니다.', 'remote_unavailable')));
      process.once('close', () => clean(session, fail('실행 공간이 종료되었거나 자원 한도를 넘었습니다.', 'remote_exited')));
      process.stdin.on('error', () => clean(session, fail('실행 공간에 요청을 전달하지 못했습니다.', 'remote_pipe_closed')));
      let stderrBytes = 0; process.stderr.on('data', (chunk) => { stderrBytes += chunk.length; if (stderrBytes > 64000) clean(session, fail('실행 공간의 진단 출력 한도를 넘었습니다.', 'remote_output_limit')); });
      process.stdout.on('data', (chunk) => {
        if (session.closed) return; session.bytes += chunk.length; session.buffer += chunk.toString('utf8');
        if (session.bytes > cap.totalOutputBytes || Buffer.byteLength(session.buffer) > cap.outputBytes) { clean(session, fail('미리보기 출력 한도를 넘었습니다.', 'remote_output_limit')); return; }
        let newline;
        while ((newline = session.buffer.indexOf('\n')) >= 0) {
          const line = session.buffer.slice(0, newline); session.buffer = session.buffer.slice(newline + 1);
          try { const message = JSON.parse(line); if (!message || typeof message !== 'object') throw new Error(); receive(session, message); } catch { clean(session, fail('실행 공간의 응답을 확인하지 못했습니다.', 'remote_protocol_invalid')); return; }
        }
      });
      try { const frame = await request(session, 'init', { artifact, viewport }); await authorize(context); if (scopeKey(context) !== scope) throw fail('조회 권한이 변경되었습니다.', 'remote_scope_changed', 403); return { sessionId: id, frame, expiresAt: new Date(session.expiresAt).toISOString() }; }
      catch (error) { clean(session, error); throw error; }
    },
    async frame(context, id) { const session = await withOwner(context, id); const frame = await request(session, 'frame'); await withOwner(context, id); return frame; },
    async event(context, id, value) { const session = await withOwner(context, id); const event = checkEvent(value, session.viewport); const frame = await request(session, 'event', { event }); await withOwner(context, id); return frame; },
    async close(context, id) { const session = await withOwner(context, id); clean(session); return { closed: true }; },
    closeAll() { for (const session of sessions.values()) clean(session); },
    revokeOwner(context) { for (const session of sessions.values()) if (sameOwner(session, context)) clean(session); },
    reapCleanup() {
      for (const session of sessions.values()) if (session.closed && !session.removing && session.cleanupAttempts >= 3) {
        session.cleanupAttempts = 0; session.cleanupFailed = false; removeContainer(session);
      }
    },
    get cleanupStatus() { return [...sessions.values()].filter(session => session.closed).map(session => ({ sessionId: session.id, attempts: session.cleanupAttempts, failed: Boolean(session.cleanupFailed), pending: session.removing || session.cleanupAttempts < 3 })); },
    get reservedSessions() { return sessions.size; },
    get activeSessions() { return [...sessions.values()].filter(session => !session.closed).length; },
  };
}
