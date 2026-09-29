import { it, expect, vi } from 'vitest';
import { startLocalRoomSetup } from './merryhere-local-setup.mjs';

it('keeps login local, rejects foreign origins and starts the runner only after approving the displayed request', async () => {
  const values = new Map(), store = { read: async key => values.get(key), write: async (key, value) => values.set(key, value) };
  const login = vi.fn(async () => { values.set('session.json', { cookies: { session: 'private-cookie' }, accountKey: 'account' }); });
  const api = vi.fn(async action => action === 'poll' ? { pending: { name: '본인', email: 'self@example.test', requestId: 'request-id' } } : { ok: true });
  const startRunner = vi.fn();
  const setup = await startLocalRoomSetup({ store, login, api, startRunner });
  const origin = new URL(setup.url).origin;
  const post = (action, body = {}, custom = {}) => fetch(`${setup.url}/${action}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...custom }, body: JSON.stringify(body) });
  try {
    const page = await fetch(setup.url);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect((await post('login', {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('login', {}, { origin: 'null' })).status).toBe(403);
    expect((await post('login', {}, { 'content-type': 'text/plain' })).status).toBe(403);
    expect((await fetch(`${origin}/wrong-nonce`)).status).toBe(403);
    expect((await post('login', { password: 'a'.repeat(9000) })).status).toBe(400);
    expect(login).not.toHaveBeenCalled();
    const response = await post('login', { email: 'self@example.test', password: 'private-password' });
    expect(await response.json()).toEqual({ ok: true });
    expect(login.mock.calls[0][0].password).toBe('private-password');
    expect(JSON.stringify([...values])).not.toContain('private-password');
    expect((await (await post('pair')).json()).code).toMatch(/^[a-f0-9]{32}$/);
    const checked = await (await post('check')).json();
    expect(checked.pending.requestId).toBe('request-id');
    expect(startRunner).not.toHaveBeenCalled();
    expect((await post('approve', { requestId: checked.pending.requestId })).status).toBe(200);
    expect(api.mock.calls.find(([action]) => action === 'approve')[2]).toEqual({ requestId: 'request-id', accepted: true });
    expect(startRunner).toHaveBeenCalledTimes(1);
  } finally { setup.server.close(); }
});
