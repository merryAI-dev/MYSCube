import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStore } from '../src/ema/files.mjs';
import { createGoogleService, decryptText, encryptText, handleGoogleCallback, handleGoogleStart } from '../src/ema/google.mjs';
import { extractMessageText } from '../src/ema/meeting-tools.mjs';
import { createEmaMcpServer } from '../src/ema/tools.mjs';
import { fakeEma, memoryKv } from './ema-support.mjs';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_TOKEN_KEY: KEY, PUBLIC_ORIGIN: 'https://ema-mcp.myscguard.app' };
const b64url = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function googleFetch(routes) {
  return vi.fn(async (url, init = {}) => {
    const key = String(url).split('?')[0];
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected fetch ${key}`);
    return handler(String(url), init);
  });
}

const tokenRoute = {
  'https://oauth2.googleapis.com/token': async (_url, init) => {
    const body = new URLSearchParams(init.body);
    if (body.get('grant_type') === 'authorization_code') {
      return json({ access_token: 'at', refresh_token: 'rt-secret', scope: 'https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/drive.readonly' });
    }
    return json({ access_token: 'fresh-at' });
  },
};

let client;
afterEach(async () => { await client?.close(); client = undefined; });

async function connect({ kv, fetchImpl, ema, role = 'consultant' }) {
  const google = createGoogleService({ kv, env, fetchImpl, now: () => Date.parse('2026-10-14T00:00:00Z') });
  const server = createEmaMcpServer({
    ema, store: createStore(kv), publicOrigin: env.PUBLIC_ORIGIN, google,
    access: { uid: 'c1', email: 'consultant@mysc.co.kr', role, canExportAndImport: false, idToken: 't', idTokenExpiresAt: Date.now() + 3_000_000 },
    now: () => Date.parse('2026-10-14T00:00:00Z'),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'meeting-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { google };
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { ...result, json: result.isError ? null : JSON.parse(result.content[0].text) };
}

describe('Google connection', () => {
  it('encrypts the refresh token at rest and round-trips it', async () => {
    const cipher = await encryptText(KEY, 'rt-secret');
    expect(cipher).not.toContain('rt-secret');
    expect(await decryptText(KEY, cipher)).toBe('rt-secret');
  });

  it('asks which EMA account first, binds the flow to the browser, and stores only an encrypted token', async () => {
    const kv = memoryKv();
    const { google } = await connect({ kv, ema: fakeEma(), fetchImpl: googleFetch(tokenRoute) });
    const { json: link } = await call('ema_google_connect', { sources: ['calendar'] });
    const token = link.connectUrl.split('/').pop();

    const shown = await handleGoogleStart(new Request(link.connectUrl), google, token);
    const html = await shown.text();
    expect(html).toContain('consultant@mysc.co.kr');
    expect(shown.headers.get('location')).toBeNull();

    const started = await handleGoogleStart(new Request(link.connectUrl, { method: 'POST' }), google, token);
    expect(started.status).toBe(302);
    const target = new URL(started.headers.get('location'));
    expect(target.searchParams.get('scope')).toContain('calendar.events.readonly');
    expect(target.searchParams.get('scope')).not.toContain('gmail');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    const cookie = started.headers.get('set-cookie').split(';')[0];

    const foreign = await handleGoogleCallback(new Request(`https://x/google/callback?code=abc&state=${token}`), google);
    expect(foreign.status).toBe(400);

    const done = await handleGoogleCallback(new Request(`https://x/google/callback?code=abc&state=${token}`, { headers: { cookie } }), google);
    expect(done.status).toBe(200);
    const stored = [...kv.map.values()].map((entry) => entry.value).join('|');
    expect(stored).not.toContain('rt-secret');
    expect((await call('ema_google_status')).json).toMatchObject({ connected: true, sources: ['calendar'] });
    expect((await call('ema_google_disconnect')).json.disconnected).toBe(true);
    expect((await call('ema_google_status')).json.connected).toBe(false);
  });
});

describe('meeting sources and drafts', () => {
  async function connected(routes, ema) {
    const kv = memoryKv();
    const fetchImpl = googleFetch({ ...tokenRoute, ...routes });
    const { google } = await connect({ kv, ema, fetchImpl });
    const { json: link } = await call('ema_google_connect', { sources: ['calendar', 'gmail'] });
    const token = link.connectUrl.split('/').pop();
    const started = await handleGoogleStart(new Request(link.connectUrl, { method: 'POST' }), google, token);
    const cookie = started.headers.get('set-cookie').split(';')[0];
    // 토큰 교환이 두 소스 권한을 모두 돌려주도록
    fetchImpl.mockImplementationOnce(async () => json({ access_token: 'at', refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.readonly' }));
    await handleGoogleCallback(new Request(`https://x/google/callback?code=c&state=${token}`, { headers: { cookie } }), google);
    return fetchImpl;
  }

  it('lists calendar events that carry Meet note documents, without any unwritten filter', async () => {
    await connected({
      'https://www.googleapis.com/calendar/v3/calendars/primary/events': async () => json({ items: [
        { id: 'e1', summary: '모닥불 에너지 오피스아워', start: { dateTime: '2026-10-13T10:00:00+09:00' }, attendees: [{}, {}], attachments: [{ fileId: 'doc_1', title: 'Notes by Gemini', mimeType: 'application/vnd.google-apps.document' }] },
        { id: 'e2', summary: '점심', start: { date: '2026-10-13' } },
      ] }),
    }, fakeEma());
    const { json: result } = await call('ema_meeting_sources_list', { source: 'calendar' });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ eventId: 'e1', documents: [{ fileId: 'doc_1' }] });
  });

  it('turns a Drive note into a draft on the server without passing the text through the model, then saves raw text', async () => {
    const noteText = '모닥불 에너지 대표와 투자 유치 전략을 논의했다. 후속으로 IR 자료 수정과 데모데이 일정 확정이 필요하다.';
    const ema = fakeEma({
      draftMeetingRecordFromFile: async ({ text }) => {
        expect(text).toBe(noteText);
        return { draft: { topic: '투자 유치 전략', companyStatus: 'a', advisoryContent: 'b', followUp: 'c', participants: ['이창섭'] }, model: 'm' };
      },
      saveMeetingDraft: async (data) => ({ id: 'draft123456', replaced: false, expiresAt: '2027-01-12T00:00:00.000Z', echo: data }),
    });
    await connected({
      'https://www.googleapis.com/drive/v3/files/doc_1/export': async () => new Response(noteText),
    }, ema);
    const { json: result } = await call('ema_meeting_draft_create', { source: 'calendar', id: 'doc_1', meetingDate: '2026-10-13' });
    expect(result).toMatchObject({ draftId: 'draft123456', truncated: false, draft: { topic: '투자 유치 전략' } });
    const saved = ema.call.mock.calls.find(([name]) => name === 'saveMeetingDraft')[1];
    expect(saved).toMatchObject({ source: 'calendar', sourceRef: 'calendar:doc_1', rawText: noteText, meetingDate: '2026-10-13' });
  });

  it('accepts text from another MCP such as Tiro', async () => {
    const ema = fakeEma({
      draftMeetingRecordFromFile: async () => ({ draft: { topic: 't', companyStatus: '', advisoryContent: 'x', followUp: '', participants: [] } }),
      saveMeetingDraft: async () => ({ id: 'draft_tiro_1', replaced: false, expiresAt: 'x' }),
    });
    await connect({ kv: memoryKv(), ema, fetchImpl: googleFetch(tokenRoute) });
    const { json: result } = await call('ema_meeting_draft_create', { source: 'tiro', text: '티로에서 가져온 회의록 요약입니다. 투자 이야기를 했습니다.', sourceRef: 'tiro:n1' });
    expect(result.draftId).toBe('draft_tiro_1');
    expect((await call('ema_meeting_draft_create', { source: 'tiro' })).isError).toBe(true);
  });

  it('does not show the raw text when a draft is fetched, and hides meeting tools from non-internal roles', async () => {
    const ema = fakeEma({ getMeetingDraft: async () => ({ id: 'd', title: 't', draft: { topic: 'x' }, rawText: '비밀 원문' }) });
    await connect({ kv: memoryKv(), ema, fetchImpl: googleFetch(tokenRoute) });
    const { json } = await call('ema_meeting_draft_get', { id: 'draft_abcdefg' });
    expect(JSON.stringify(json)).not.toContain('비밀 원문');
    expect(json.hasRawText).toBe(true);
    await client.close();
    await connect({ kv: memoryKv(), ema, fetchImpl: googleFetch(tokenRoute), role: 'staff' });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.some((name) => name.startsWith('ema_meeting') || name.startsWith('ema_google'))).toBe(false);
  });
});

describe('Gmail message text', () => {
  it('prefers text/plain and falls back to stripped html', () => {
    const plain = { mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/plain', body: { data: b64url('평문 회의록') } },
      { mimeType: 'text/html', body: { data: b64url('<p>HTML 회의록</p>') } },
    ] };
    expect(extractMessageText(plain)).toBe('평문 회의록');
    const htmlOnly = { mimeType: 'text/html', body: { data: b64url('<p>요약</p><p>다음 단계 &amp; 일정</p>') } };
    expect(extractMessageText(htmlOnly)).toContain('다음 단계 & 일정');
  });
});
