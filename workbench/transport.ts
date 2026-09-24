export type PendingWrite = { key: string; path: string; method: string; fingerprint: string; startedAt: string };
export type RecoveredWrite = PendingWrite & { state: 'completed' | 'pending' | 'failed' | 'not_found' | 'scope_changed'; body?: unknown; message?: string; recoveredAfterScopeChange?: boolean };
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Options = { fetchImpl?: typeof fetch; actor: () => string | null; token: () => Promise<string | undefined>; storage?: StoragePort; timeoutMs?: number };
const durable = (path: string, method: string) => ['POST', 'PUT'].includes(method) && /^\/(?:react-work-pages|html-work-pages|workbench-apis)(?:\/[a-f0-9-]{36}(?:\/restore)?)?$/.test(path);
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, '0')).join('');

export function createWorkbenchTransport(options: Options) {
  const fetchImpl = options.fetchImpl || fetch;
  const fallback = new Map<string, string>();
  const authorizationVersions = new Map<string | null, number>();
  const recoveredVersions = new WeakMap<PendingWrite, { actor: string; version: number }>();
  const authorizationVersion = (actor: string | null) => authorizationVersions.get(actor) || 0;
  const authorizationChanged = () => Object.assign(new Error('조회 권한이 바뀌어 이전 응답을 표시하지 않았습니다. 작성 내용과 저장 요청 번호는 보존됩니다. 다시 로그인한 후 저장 결과를 확인해 주세요.'), { status: 403, code: 'workbench_authorization_changed' });
  const assertAuthorization = (actor: string | null, version: number) => { if (authorizationVersion(actor) !== version) throw authorizationChanged(); };
  const storage = options.storage || { getItem: (key: string) => fallback.get(key) || null, setItem: (key: string, value: string) => { fallback.set(key, value); }, removeItem: (key: string) => { fallback.delete(key); } };
  const storageKey = (actor: string) => `axr:pending-writes:v1:${encodeURIComponent(actor)}`;
  const records = (actor: string): PendingWrite[] => {
    try {
      const value = JSON.parse(storage.getItem(storageKey(actor)) || '[]');
      return Array.isArray(value) ? value.filter((entry) => entry && typeof entry.key === 'string' && /^[a-f0-9-]{36}$/.test(entry.key) && durable(entry.path, entry.method) && /^[a-f0-9]{64}$/.test(entry.fingerprint)).slice(0, 20) : [];
    } catch { return []; }
  };
  const persist = (actor: string, values: PendingWrite[]) => {
    try { storage.setItem(storageKey(actor), JSON.stringify(values)); }
    catch { throw new Error('저장 요청 번호를 보관할 수 없습니다. 브라우저 저장 공간을 확인해 주세요.'); }
  };
  const acknowledge = (value: PendingWrite, actor = options.actor()) => {
    const recovered = recoveredVersions.get(value);
    if (recovered) {
      if (actor !== recovered.actor) throw authorizationChanged();
      assertAuthorization(actor, recovered.version);
    }
    if (actor) persist(actor, records(actor).filter((item) => item.key !== value.key));
  };
  const assertActor = (actor: string | null) => { if (options.actor() !== actor) throw new Error('계정이 바뀌었습니다. 현재 계정으로 다시 확인해 주세요.'); };
  async function send(path: string, method: string, body: unknown, actor: string | null, version: number, key?: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? (method === 'GET' ? 20000 : 125000));
    let rejectDeadline: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = setTimeout(() => reject(new Error('workbench_request_timeout')), options.timeoutMs ?? (method === 'GET' ? 20000 : 125000));
    });
    try {
      return await Promise.race([deadline, (async () => {
        assertActor(actor);
        const token = await options.token();
        assertActor(actor);
        assertAuthorization(actor, version);
        controller.signal.throwIfAborted();
        const response = await fetchImpl(`/api/v1${path}`, { method, credentials: 'omit', signal: controller.signal,
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'Idempotency-Key': key || crypto.randomUUID() } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if ([401, 403].includes(response.status)) authorizationVersions.set(actor, authorizationVersion(actor) + 1);
        const data = await response.json();
        return { response, data };
      })()]);
    } finally { clearTimeout(timeout); clearTimeout(rejectDeadline!); }
  }
  const matchingPending = (actor: string, value: PendingWrite) => records(actor).find((record) => record.key === value.key && record.path === value.path && record.method === value.method && record.fingerprint === value.fingerprint);
  async function recoverOne(value: PendingWrite): Promise<RecoveredWrite> {
    const actor = options.actor();
    const version = authorizationVersion(actor);
    const record = actor && matchingPending(actor, value);
    if (!actor || !record) throw new Error('현재 계정에서 확인 중인 저장 요청이 아닙니다. 저장 결과를 다시 확인해 주세요.');
    const query = new URLSearchParams({ path: record.path, method: record.method });
    const { response, data } = await send(`/workbench-requests/${record.key}?${query}`, 'GET', undefined, actor, version);
    assertActor(actor);
    if (!response.ok) throw Object.assign(new Error(data?.message || '이전 저장 결과를 확인하지 못했습니다.'), { status: response.status, code: data?.error });
    assertAuthorization(actor, version);
    if (!matchingPending(actor, record)) throw new Error('저장 요청의 확인 상태가 바뀌었습니다. 저장 결과를 다시 확인해 주세요.');
    if (!data || !['completed', 'pending', 'failed', 'not_found', 'scope_changed'].includes(data.state)) throw new Error('저장 결과의 상태를 확인하지 못했습니다. 저장 요청은 보존됩니다.');
    const recovered = { ...data, ...record };
    recoveredVersions.set(recovered, { actor, version });
    return recovered;
  }
  return {
    pending: () => options.actor() ? records(options.actor()!) : [],
    acknowledge,
    recoverOne,
    async recover(): Promise<RecoveredWrite[]> {
      const actor = options.actor(); if (!actor) return [];
      const version = authorizationVersion(actor);
      const results: RecoveredWrite[] = [];
      for (const record of records(actor)) {
        assertActor(actor);
        results.push(await recoverOne(record));
      }
      assertActor(actor);
      assertAuthorization(actor, version);
      return results;
    },
    async request(path: string, method = 'GET', body?: unknown) {
      const operationsRead = method === 'GET' && /^\/product-operations\/summary(?:\?days=(?:7|14|28))?$/.test(path);
      if (!operationsRead && !/^\/(?:html-work-pages|workbench-conversations|react-work-pages|workbench-apis)(?:\/|$)/.test(path)) throw new Error('지원하지 않는 제작 공간 요청입니다.');
      const actor = options.actor();
      const version = authorizationVersion(actor);
      let pending: PendingWrite | undefined;
      let uncertain = false;
      if (actor && durable(path, method)) {
        const fingerprint = await hash(JSON.stringify([method, path, body]));
        assertActor(actor);
        const previous = records(actor); pending = previous.find((entry) => entry.path === path && entry.method === method);
        uncertain = Boolean(pending);
        if (pending && pending.fingerprint !== fingerprint) throw new Error('이전 저장 결과가 아직 확인되지 않았습니다. 작성 내용은 유지됩니다. 저장 결과 확인 후 이전 저장본을 불러오거나 같은 내용으로 다시 시도해 주세요.');
        if (!pending) {
          if (previous.length >= 20) throw new Error('확인하지 않은 저장 요청이 많습니다. 저장 결과를 먼저 확인해 주세요.');
          pending = { key: crypto.randomUUID(), path, method, fingerprint, startedAt: new Date().toISOString() };
          persist(actor, [...previous, pending]);
        }
      }
      let result;
      try { result = await send(path, method, body, actor, version, pending?.key); }
      catch {
        assertActor(actor);
        assertAuthorization(actor, version);
        throw new Error(pending ? '응답을 받지 못해 저장 결과를 아직 확인할 수 없습니다. 작성 내용은 유지됩니다. 저장 결과를 확인하거나 같은 내용으로 다시 시도해 주세요.' : '응답을 받지 못했습니다. 작성 내용은 유지됩니다. 잠시 후 다시 시도해 주세요.');
      }
      if (options.actor() !== actor) throw new Error('계정이 바뀌어 이전 계정의 응답을 표시하지 않았습니다.');
      if (![401, 403].includes(result.response.status)) assertAuthorization(actor, version);
      if (!result.response.ok) {
        if (pending && actor && !uncertain && result.response.status < 500 && (![401, 403, 408, 409, 429].includes(result.response.status) || ['react_page_conflict', 'html_page_conflict', 'registered_api_conflict'].includes(result.data?.error))) acknowledge(pending, actor);
        throw Object.assign(new Error(result.data?.message || `요청을 완료하지 못했습니다 (${result.response.status}).`), { status: result.response.status, code: result.data?.error, details: result.data?.details });
      }
      if (pending && actor) acknowledge(pending, actor);
      return result.data;
    },
  };
}
