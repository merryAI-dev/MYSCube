import { it, expect } from 'vitest';
import { saveLocalRoomLogin } from './merryhere-local-login.mjs';
import { kstDate } from './merryhere-client.mjs';

it.each(['MemberID', 'member@example.test'])('posts %s as the provider login identifier without email-only validation', async loginId => {
  const records = new Map(), posts = [];
  const store = { read: async key => records.get(key), write: async (key, value) => records.set(key, value) };
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/auth/login')) {
      if (options.method === 'POST') posts.push(Object.fromEntries(new URLSearchParams(options.body)));
      return new Response('<form action="/auth/login" method="post"><input name="_token" value="csrf"></form>', { headers: { 'set-cookie': 'laravel_session=local-session; HttpOnly' } });
    }
    const date = kstDate();
    return new Response(`<a href="https://merryhere.kr/auth/logout">out</a><input id="sel-date" value="${date}"><button id="btn-reservation" data-date="${date}"></button><form action="/reserve" method="post"><input name="_token" value="csrf"></form><input name="slot" value="9-0-8" data-name="3A" data-cnt="8" data-time="09:00" data-time2="09:30" data-list-id="" class="">`);
  };
  await saveLocalRoomLogin({ store, loginId, password: 'private-password', fetchImpl });
  const key = records.get('session.json').accountKey;
  await saveLocalRoomLogin({ store, loginId, password: 'private-password', fetchImpl });
  expect(posts[0]).toEqual({ _token: 'csrf', email: loginId, password: 'private-password' });
  expect(records.get('session.json').accountKey).toBe(key);
  expect(JSON.stringify([...records])).not.toContain('private-password');
});
