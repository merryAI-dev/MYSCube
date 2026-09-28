import { expect, it } from 'vitest';
import { createWorkbenchTransport } from '../../workbench/transport';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

it('retains a committed write receipt when a concurrent 403 precedes its late success', async () => {
  const held = deferred<Response>(), sent = deferred<void>();
  const keys: string[] = []; let attempt = 0;
  const transport = createWorkbenchTransport({ actor: () => 'owner', token: async () => undefined, fetchImpl: async (url, init) => {
    if (String(url).includes('workbench-apis')) return reply({ message: '권한이 회수되었습니다.' }, 403);
    keys.push(new Headers(init?.headers).get('Idempotency-Key')!);
    if (++attempt === 1) { sent.resolve(); return held.promise; }
    return reply({ id: 'one-page', version: 1 });
  } });
  const writing = transport.request('/react-work-pages', 'POST', { source: 'user edits' });
  const rejected = expect(writing).rejects.toMatchObject({ status: 403, code: 'workbench_authorization_changed' });
  await sent.promise;
  await expect(transport.request('/workbench-apis')).rejects.toMatchObject({ status: 403 });
  held.resolve(reply({ id: 'one-page', version: 1 }));
  await rejected;
  expect(transport.pending()).toHaveLength(1);
  await expect(transport.request('/react-work-pages', 'POST', { source: 'new edits' })).rejects.toThrow('이전 저장 결과');
  await expect(transport.request('/react-work-pages', 'POST', { source: 'user edits' })).resolves.toMatchObject({ version: 1 });
  expect(keys[1]).toBe(keys[0]); expect(transport.pending()).toHaveLength(0);
});

it('discards a late recovered body and refuses acknowledgement of an earlier recovered body after 401', async () => {
  const held = deferred<Response>(), sent = deferred<void>(); let queries = 0;
  const transport = createWorkbenchTransport({ actor: () => 'owner', token: async () => undefined, fetchImpl: async (url, init) => {
    if (init?.method === 'POST') throw Error('lost after commit');
    if (String(url).includes('workbench-apis')) return reply({ message: '다시 로그인해 주세요.' }, 401);
    if (++queries === 2) { sent.resolve(); return held.promise; }
    return reply({ state: 'completed', body: { private: 'owner source' } });
  } });
  await expect(transport.request('/react-work-pages', 'POST', {})).rejects.toThrow('저장 결과');
  const record = transport.pending()[0];
  const earlier = await transport.recoverOne(record);
  const recovering = transport.recoverOne(record);
  const rejected = expect(recovering).rejects.toMatchObject({ status: 403, code: 'workbench_authorization_changed' });
  await sent.promise;
  await expect(transport.request('/workbench-apis')).rejects.toMatchObject({ status: 401 });
  held.resolve(reply({ state: 'completed', body: { private: 'owner source' } }));
  await rejected;
  expect(() => transport.acknowledge(earlier)).toThrow('권한이 바뀌어');
  expect(transport.pending()).toEqual([record]);
  transport.acknowledge(await transport.recoverOne(record));
  expect(transport.pending()).toEqual([]);
});

it('does not send a mutation after a concurrent auth rejection while its token was pending', async () => {
  const held = deferred<string>(), started = deferred<void>(); let first = true, writes = 0;
  const transport = createWorkbenchTransport({ actor: () => 'owner', token: async () => { if (first) { first = false; started.resolve(); return held.promise; } return 'token'; },
    fetchImpl: async (_url, init) => { if (init?.method === 'POST') writes++; return reply({}, 403); } });
  const writing = transport.request('/react-work-pages', 'POST', {});
  const rejected = expect(writing).rejects.toMatchObject({ status: 403 });
  await started.promise;
  await expect(transport.request('/workbench-apis')).rejects.toMatchObject({ status: 403 });
  held.resolve('token'); await rejected;
  expect(writes).toBe(0); expect(transport.pending()).toHaveLength(1);
});

it('does not send an earlier actor write if identity changes during token acquisition', async () => {
  let actor = 'actor-a'; let calls = 0;
  const transport = createWorkbenchTransport({ actor: () => actor, token: async () => { actor = 'actor-b'; return 'actor-b-token'; },
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ id: 'created-under-b' }), { status: 201 }); } });
  await expect(transport.request('/react-work-pages', 'POST', { expectedVersion: 0, source: { title: 'A source', code: 'A confidential source' }, apis: [] })).rejects.toThrow('계정');
  expect(calls).toBe(0);
});

it('retains an uncertain prior write key when a retry is rejected by authentication', async () => {
  const keys: string[] = []; let attempt = 0;
  const transport = createWorkbenchTransport({ actor: () => 'actor-a', token: async () => 'fixture-token',
    fetchImpl: async (_url, options) => {
      keys.push(new Headers(options?.headers).get('Idempotency-Key')!);
      if (++attempt === 1) throw new Error('response lost after server commit');
      return new Response(JSON.stringify({ message: '다시 로그인해 주세요.' }), { status: 401 });
    } });
  const body = { expectedVersion: 0, source: { title: 'A', code: 'A' }, apis: [] };
  await expect(transport.request('/react-work-pages', 'POST', body)).rejects.toThrow();
  expect(transport.pending()).toHaveLength(1);
  await expect(transport.request('/react-work-pages', 'POST', body)).rejects.toThrow();
  expect(keys[0]).toBe(keys[1]);
  expect(transport.pending()).toHaveLength(1);
});

it('allows only the bounded read-only operations summary through the shared transport', async () => {
  const sent: string[] = [];
  const transport = createWorkbenchTransport({ actor: () => 'actor-a', token: async () => 'fixture-token',
    fetchImpl: async (url) => { sent.push(String(url)); return new Response('{}', { status: 200 }); } });
  await transport.request('/product-operations/summary?days=28');
  for (const [path, method] of [
    ['/product-operations/summary?days=365', 'GET'], ['/product-operations/summary?days=7&tenant=other', 'GET'],
    ['/product-operations/summary', 'POST'], ['/product-operations/observations', 'POST'],
  ]) await expect(transport.request(path, method)).rejects.toThrow('지원하지 않는');
  expect(sent).toEqual(['/api/v1/product-operations/summary?days=28']);
});
