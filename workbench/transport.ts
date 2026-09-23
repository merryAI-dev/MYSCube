export type PendingWrite = { key: string; path: string; method: string; fingerprint: string; startedAt: string };
export type RecoveredWrite = PendingWrite & { state: 'completed' | 'pending' | 'failed' | 'not_found' | 'scope_changed'; body?: unknown; message?: string; recoveredAfterScopeChange?: boolean };
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Options = { fetchImpl?: typeof fetch; actor: () => string | null; token: () => Promise<string | undefined>; storage?: StoragePort; timeoutMs?: number };
const durable = (path: string, method: string) => ['POST', 'PUT'].includes(method) && /^\/(?:react-work-pages|html-work-pages|workbench-apis)(?:\/[a-f0-9-]{36}(?:\/restore)?)?$/.test(path);
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, '0')).join('');

export function createWorkbenchTransport(options: Options) {
  const fetchImpl = options.fetchImpl || fetch;
  const fallback = new Map<string, string>();
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
    if (actor) persist(actor, records(actor).filter((item) => item.key !== value.key));
  };
  const assertActor = (actor: string | null) => { if (options.actor() !== actor) throw new Error('계정이 바뀌었습니다. 현재 계정으로 다시 확인해 주세요.'); };
  async function send(path: string, method: string, body: unknown, actor: string | null, key?: string) {
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
        controller.signal.throwIfAborted();
        const response = await fetchImpl(`/api/v1${path}`, { method, credentials: 'omit', signal: controller.signal,
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'Idempotency-Key': key || crypto.randomUUID() } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await response.json();
        return { response, data };
      })()]);
    } finally { clearTimeout(timeout); clearTimeout(rejectDeadline!); }
  }
  return {
    pending: () => options.actor() ? records(options.actor()!) : [],
    acknowledge,
    async recover(): Promise<RecoveredWrite[]> {
      const actor = options.actor(); if (!actor) return [];
      const results: RecoveredWrite[] = [];
      for (const record of records(actor)) {
        const query = new URLSearchParams({ path: record.path, method: record.method });
        const { response, data } = await send(`/workbench-requests/${record.key}?${query}`, 'GET', undefined, actor);
        if (options.actor() !== actor) throw new Error('계정이 바뀌었습니다. 현재 계정으로 다시 확인해 주세요.');
        if (!response.ok) throw new Error(data?.message || '이전 저장 결과를 확인하지 못했습니다.');
        results.push({ ...record, ...data });
      }
      return results;
    },
    async request(path: string, method = 'GET', body?: unknown) {
      const operationsRead = method === 'GET' && /^\/product-operations\/summary(?:\?days=(?:7|14|28))?$/.test(path);
      if (!operationsRead && !/^\/(?:html-work-pages|workbench-conversations|react-work-pages|workbench-apis)(?:\/|$)/.test(path)) throw new Error('지원하지 않는 제작 공간 요청입니다.');
      const actor = options.actor();
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
      try { result = await send(path, method, body, actor, pending?.key); }
      catch {
        assertActor(actor);
        throw new Error(pending ? '응답을 받지 못해 저장 결과를 아직 확인할 수 없습니다. 작성 내용은 유지됩니다. 저장 결과를 확인하거나 같은 내용으로 다시 시도해 주세요.' : '응답을 받지 못했습니다. 작성 내용은 유지됩니다. 잠시 후 다시 시도해 주세요.');
      }
      if (options.actor() !== actor) throw new Error('계정이 바뀌어 이전 계정의 응답을 표시하지 않았습니다.');
      if (!result.response.ok) {
        if (pending && actor && !uncertain && result.response.status < 500 && (![408, 409, 429].includes(result.response.status) || ['react_page_conflict', 'html_page_conflict', 'registered_api_conflict'].includes(result.data?.error))) acknowledge(pending, actor);
        throw Object.assign(new Error(result.data?.message || `요청을 완료하지 못했습니다 (${result.response.status}).`), { status: result.response.status, code: result.data?.error });
      }
      if (pending && actor) acknowledge(pending, actor);
      return result.data;
    },
  };
}
