import { expect, it } from 'vitest';
import { createWorkbenchTransport } from '../../workbench/transport';

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
