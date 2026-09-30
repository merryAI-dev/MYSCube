import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMerryhereConnections, MERRYHERE_CONNECT_PATH } from './merryhere-connection.mjs';
import { mountMerryhereConnect, verifyMerryhereLogin } from './merryhere-connect-route.mjs';
import { MerryhereError } from './merryhere-client.mjs';
import { memoryDb, TEST_MERRYHERE_KEY } from './slack-test-store.mjs';

const env = { MERRYHERE_CREDENTIAL_KEY: TEST_MERRYHERE_KEY };
const actor = { tenantId: 'mysc', actorId: 'member-pk' };
const tokenOf = link => link.split('#')[1];
function setup({ clock = { now: Date.parse('2026-09-30T10:00:00+09:00') }, key = env } = {}) {
  const { db, records } = memoryDb();
  records.set('orgs/mysc/members/member-pk', { status: 'ACTIVE', role: 'pm' });
  records.set('orgs/mysc/members/other-pk', { status: 'ACTIVE', role: 'pm' });
  return { db, records, clock, connections: createMerryhereConnections({ db, env: key, now: () => clock.now }) };
}
const connectWith = (connections, link, overrides = {}, verify = async () => {}) =>
  connections.connect({ token: tokenOf(link), loginId: 'person@mysc.co.kr', password: ' pass word ', consent: true, ...overrides }, verify);

describe('sealed Merryhere connections', () => {
  it('stores only owner-bound ciphertext and returns the exact password to the owner', async () => {
    const { connections, records } = setup();
    const link = await connections.issueLink(actor, 'job');
    expect(link).toMatch(/^https:\/\/myscube\.myscguard\.app\/api\/v1\/merryhere\/connect#[A-Za-z0-9_-]{43}$/);
    await connectWith(connections, link);
    const stored = JSON.stringify([...records]);
    expect(stored).not.toContain('pass word');
    expect(stored).not.toContain('person@mysc.co.kr');
    expect(stored).not.toContain(tokenOf(link));
    expect(await connections.credentials(actor)).toMatchObject({ email: 'person@mysc.co.kr', password: ' pass word ' });
    expect(await connections.status(actor)).toBe('ACTIVE');
  });

  it('cannot decrypt a sealed record moved to another member or read with another key', async () => {
    const { connections, records, db } = setup();
    await connectWith(connections, await connections.issueLink(actor));
    const [, value] = [...records].find(([key]) => key.startsWith('merryhere_connections/'));
    const other = { tenantId: 'mysc', actorId: 'other-pk' };
    const otherPath = `merryhere_connections/${createHash('sha256').update('mysc/other-pk').digest('hex')}`;
    records.set(otherPath, { ...value, actorId: 'other-pk' });
    await expect(connections.credentials(other)).rejects.toMatchObject({ code: 'account_not_connected' });
    const rotated = createMerryhereConnections({ db, env: { MERRYHERE_CREDENTIAL_KEY: Buffer.alloc(32, 9).toString('base64') } });
    await expect(rotated.credentials(actor)).rejects.toMatchObject({ code: 'account_not_connected' });
    expect(await rotated.status(actor)).not.toBe('ACTIVE');
  });

  it('refuses to issue links or store passwords without a 32-byte key', async () => {
    for (const key of [{}, { MERRYHERE_CREDENTIAL_KEY: 'short' }]) {
      const { connections, records } = setup({ key });
      expect(connections.available).toBe(false);
      await expect(connections.issueLink(actor)).rejects.toMatchObject({ code: 'connect_unavailable' });
      await expect(connections.connect({ token: 'a'.repeat(43), loginId: 'x', password: 'y', consent: true }, async () => {})).rejects.toMatchObject({ code: 'connect_unavailable' });
      expect([...records.keys()].some(k => k.startsWith('merryhere_'))).toBe(false);
    }
  });

  it('uses each link once, expires it, and requires consent and an active member', async () => {
    const { connections, records, clock } = setup();
    const link = await connections.issueLink(actor);
    await expect(connectWith(connections, link, { consent: false })).rejects.toMatchObject({ code: 'input_invalid' });
    await connectWith(connections, link);
    await expect(connectWith(connections, link)).rejects.toMatchObject({ code: 'link_invalid' });
    const expired = await connections.issueLink(actor);
    clock.now += 15 * 60000;
    await expect(connectWith(connections, expired)).rejects.toMatchObject({ code: 'link_invalid' });
    const inactive = await connections.issueLink(actor);
    records.set('orgs/mysc/members/member-pk', { status: 'INACTIVE', role: 'pm' });
    await expect(connectWith(connections, inactive)).rejects.toMatchObject({ code: 'link_invalid' });
  });

  it('stores nothing after a rejected login and locks the link after five attempts', async () => {
    const { connections, records } = setup();
    const link = await connections.issueLink(actor);
    const reject = vi.fn(async () => { throw new MerryhereError('login_failed'); });
    for (let i = 0; i < 5; i++) await expect(connectWith(connections, link, {}, reject)).rejects.toMatchObject({ code: 'login_failed' });
    expect([...records.keys()].some(k => k.startsWith('merryhere_connections/'))).toBe(false);
    await expect(connectWith(connections, link)).rejects.toMatchObject({ code: 'link_invalid' });
    expect(reject).toHaveBeenCalledTimes(5);
  });

  it('marks a rejected stored login and deletes the connection on disconnect', async () => {
    const { connections, records } = setup();
    await connectWith(connections, await connections.issueLink(actor));
    await connections.markLoginFailed(actor);
    expect(await connections.status(actor)).toBe('LOGIN_FAILED');
    await expect(connections.credentials(actor)).rejects.toMatchObject({ code: 'login_failed' });
    await connections.disconnect(actor);
    expect(await connections.status(actor)).toBe('NONE');
    expect([...records.keys()].some(k => k.startsWith('merryhere_connections/'))).toBe(false);
  });
});

const calendarHtml = date => `<a href="https://merryhere.kr/auth/logout">LOG OUT</a><input id="sel-date" value="${date}"><button id="btn-reservation" data-date="${date}"></button><form action="https://merryhere.kr/reserve" method="post"><input name="_token" value="csrf"></form><input type="checkbox" name="slot" value="9-0-8" data-name="M3-3A" data-cnt="8" data-time="9:00" data-time2="9:30" data-list-id="" class="">`;
const loginHtml = '<form action="/auth/login" method="post"><input name="_token" value="csrf"></form>';
function provider(accepted) {
  return vi.fn(async (url, options) => {
    if (url.endsWith('/auth/login')) {
      if (options.method === 'POST') return new Response(null, { status: 302, headers: { location: accepted ? '/reservation' : '/auth/login' } });
      return new Response(loginHtml);
    }
    if (url.includes('/reservation?date=')) return new Response(accepted ? calendarHtml(new URL(url).searchParams.get('date')) : loginHtml);
    if (url.endsWith('/reservation')) return new Response('ok');
    throw new Error(`unexpected ${url}`);
  });
}

describe('connect page and verification', () => {
  const now = () => Date.parse('2026-09-30T10:00:00+09:00');
  it('proves login by opening the reservation calendar and maps a silent login rejection to login_failed', async () => {
    await expect(verifyMerryhereLogin({ fetchImpl: provider(true), now })({ email: 'a@b.c', password: 'p' })).resolves.toBeUndefined();
    await expect(verifyMerryhereLogin({ fetchImpl: provider(false), now })({ email: 'a@b.c', password: 'p' })).rejects.toMatchObject({ code: 'login_failed' });
  });

  it('serves a locked-down page and connects through JSON without echoing secrets', async () => {
    const { connections } = setup();
    const app = express(); app.use(express.json());
    mountMerryhereConnect(app, { connections, verify: verifyMerryhereLogin({ fetchImpl: provider(true), now }) });
    const page = await request(app).get(MERRYHERE_CONNECT_PATH);
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    const nonce = /script-src 'nonce-([^']+)'/.exec(page.headers['content-security-policy'])?.[1];
    expect(page.text).toContain(`<script nonce="${nonce}">`);
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    const token = tokenOf(await connections.issueLink(actor));
    const response = await request(app).post(MERRYHERE_CONNECT_PATH).send({ token, loginId: 'person@mysc.co.kr', password: 'secret-value', consent: true });
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('secret-value');
    expect(await connections.status(actor)).toBe('ACTIVE');
    const reused = await request(app).post(MERRYHERE_CONNECT_PATH).send({ token, loginId: 'person@mysc.co.kr', password: 'secret-value', consent: true });
    expect(reused.status).toBe(410);
  });

  it('reports a wrong password without storing it and rate-limits bursts', async () => {
    const { connections, records } = setup();
    const app = express(); app.use(express.json());
    mountMerryhereConnect(app, { connections, verify: verifyMerryhereLogin({ fetchImpl: provider(false), now }), clock: now });
    const token = tokenOf(await connections.issueLink(actor));
    const wrong = await request(app).post(MERRYHERE_CONNECT_PATH).send({ token, loginId: 'person@mysc.co.kr', password: 'wrong-value', consent: true });
    expect(wrong.status).toBe(401);
    expect(JSON.stringify(wrong.body)).not.toContain('wrong-value');
    expect(JSON.stringify([...records])).not.toContain('wrong-value');
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await request(app).post(MERRYHERE_CONNECT_PATH).send({})).status);
    expect(statuses.at(-1)).toBe(429);
  });
});
