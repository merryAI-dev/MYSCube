import { describe, expect, it, vi } from 'vitest';
import worker from '../src/tiro/index.mjs';
import { composerFrom, noteGuidFromEvent, noteInputFrom, processNote, runOnce, shouldSkip, tiroClientFrom, verifyWebhook } from '../src/tiro/autosave.mjs';
import { memoryKv } from './ema-support.mjs';

const NOW = Date.parse('2026-10-26T06:00:00Z');
const ended = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const note = (overrides = {}) => ({
  guid: 'n1', title: '에코랩 오피스아워', webUrl: 'https://tiro.ooo/n/abc', createdAt: ended(120),
  recordingStartAt: '2026-10-25T23:30:00Z', recordingEndAt: ended(100), recordingDurationSeconds: 1800,
  collaborators: [{ name: '변민욱', role: 'OWNER' }], participants: [{ name: '김대표' }], ...overrides,
});
const summary = (overrides = {}) => ({ id: 7, createdAt: ended(90), updatedAt: ended(90), content: { type: 'text/markdown', content: '# 요약\n- 에코랩 투자 유치 일정과 실증 파트너 논의. 다음 주 자료 공유.' }, ...overrides });
const composed = { counterpart: '에코랩', category: '오피스아워', summary: ['실증 파트너 논의'], details: '## 논의\n내용', followUps: ['자료 공유(변민욱)'] };

function fakeDeps({ summaries = { n1: summary() }, transcript = '' } = {}) {
  const saved = [];
  return {
    saved,
    tiro: {
      latestSummary: vi.fn(async (guid) => summaries[guid] ?? null),
      transcript: vi.fn(async () => transcript),
    },
    compose: vi.fn(async () => composed),
    saveNote: vi.fn(async (input) => { saved.push(input); return { fileId: 'f1', url: 'https://drive/f1', name: input.fileName, updated: false }; }),
    kv: memoryKv(),
    now: NOW,
  };
}

describe('Tiro autosave: one note', () => {
  it('saves a finished note with a summary to the team drive in the standard format', async () => {
    const deps = fakeDeps();
    const result = await processNote(note(), deps);
    expect(result).toMatchObject({ status: 'saved', fileName: '20261026 [오피스아워] 에코랩 미팅_변민욱.md', url: 'https://drive/f1' });
    expect(deps.saved[0].sourceRef).toBe('tiro:n1');
    expect(deps.saved[0].markdown).toContain('source: tiro');
    expect(deps.saved[0].markdown).toContain('## 향후 팔로업\n- 자료 공유(변민욱)');
    expect(deps.saved[0].markdown).toContain('원본: Tiro 노트 https://tiro.ooo/n/abc');
    expect(deps.compose).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: 'summary' }));
  });

  it('does nothing the second time, and re-saves only when the Tiro summary changes', async () => {
    const deps = fakeDeps();
    await processNote(note(), deps);
    expect((await processNote(note(), deps)).status).toBe('unchanged');
    expect(deps.saveNote).toHaveBeenCalledTimes(1);
    deps.tiro.latestSummary.mockResolvedValue(summary({ updatedAt: ended(5) }));
    expect((await processNote(note(), deps)).status).toBe('updated');
    expect(deps.saveNote).toHaveBeenCalledTimes(2);
  });

  it('waits for the summary for a while, then falls back to the transcript', async () => {
    const deps = fakeDeps({ summaries: {}, transcript: '오늘은 에코랩과 실증 파트너 후보를 정리했고 다음 주까지 자료를 공유하기로 했습니다.' });
    expect((await processNote(note({ recordingEndAt: ended(10) }), deps)).status).toBe('waiting_summary');
    expect(deps.compose).not.toHaveBeenCalled();
    expect((await processNote(note({ recordingEndAt: ended(120) }), deps)).status).toBe('saved');
    expect(deps.compose).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: 'transcript' }));
    // 대화록으로 저장한 뒤 요약이 생기면 요약으로 다시 저장한다.
    expect((await processNote(note({ recordingEndAt: ended(120) }), deps)).status).toBe('unchanged');
    deps.tiro.latestSummary.mockResolvedValue(summary());
    expect((await processNote(note({ recordingEndAt: ended(120) }), deps)).status).toBe('updated');
  });

  it('skips notes still recording, test recordings, and private titles', () => {
    expect(shouldSkip(note({ recordingEndAt: null }))).toBe('recording');
    expect(shouldSkip(note({ recordingDurationSeconds: 30 }))).toBe('too_short');
    expect(shouldSkip(note({ title: '[비공개] 팀장 면담' }))).toBe('private_title');
    expect(shouldSkip(note({ title: '1:1 정리' }))).toBe('private_title');
    expect(shouldSkip(note({ title: '1:1 정리' }), { skipPattern: '' })).toBeNull();
    expect(shouldSkip(note())).toBeNull();
  });

  it('uses Tiro metadata (KST date, owner, source) over what the model says', () => {
    const input = noteInputFrom(note({ recordingStartAt: '2026-10-25T16:30:00Z' }), { ...composed, counterpart: '  ' });
    expect(input).toMatchObject({ meetingDate: '2026-10-26', author: '변민욱', counterpart: '에코랩 오피스아워', source: 'tiro', sourceRef: 'tiro:n1' });
  });
});

describe('Tiro autosave: cron run', () => {
  it('keeps going when one note fails and caps the work per run', async () => {
    const deps = fakeDeps({ summaries: { a: summary(), b: summary(), c: summary() } });
    deps.tiro.listRecentNotes = vi.fn(async () => [note({ guid: 'a' }), note({ guid: 'b' }), note({ guid: 'c' }), note({ guid: 'd', recordingEndAt: null })]);
    deps.saveNote.mockImplementationOnce(async () => { throw new Error('drive down'); });
    const report = await runOnce({ ...deps, maxPerRun: 2 });
    expect(report.results.map((r) => r.status)).toEqual(['skipped:recording', 'error', 'saved', 'deferred']);
    expect(deps.tiro.listRecentNotes).toHaveBeenCalledWith({ since: '2026-10-23T06:00:00.000Z', scope: undefined });
  });
});

describe('Tiro API client', () => {
  it('lists workspace notes with paging and reads the newest summary', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push([url, init.headers.authorization]);
      const path = url.replace('https://api.tiro.ooo/v1/external', '');
      const bodies = {
        '/workspaces/me': { guid: 'ws1' },
        '/notes/n1/summaries': { content: [{ id: 1, createdAt: '2026-10-01' }, { id: 2, createdAt: '2026-10-02' }] },
        '/notes/n1/summaries/2': summary({ id: 2 }),
      };
      if (path.startsWith('/workspaces/ws1/notes')) {
        return Response.json(path.includes('cursor=c2') ? { content: [{ guid: 'n2' }], nextCursor: null } : { content: [{ guid: 'n1' }], nextCursor: 'c2' });
      }
      return bodies[path] ? Response.json(bodies[path]) : new Response('', { status: 404 });
    });
    const tiro = tiroClientFrom({ apiKey: 'k', fetchImpl });
    expect((await tiro.listRecentNotes({ since: '2026-10-23T00:00:00Z' })).map((n) => n.guid)).toEqual(['n1', 'n2']);
    expect((await tiro.latestSummary('n1')).id).toBe(2);
    expect(await tiro.getNote('missing')).toBeNull();
    expect(calls.every(([, auth]) => auth === 'Bearer k')).toBe(true);
    expect(calls.find(([url]) => url.includes('/workspaces/ws1/notes'))[0]).toContain('createdAtFrom=2026-10-23T00%3A00%3A00Z');
  });

  it('uses the organization listing for an organization key', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ content: [], nextCursor: null }));
    await tiroClientFrom({ apiKey: 'k', fetchImpl }).listRecentNotes({ since: '2026-10-23T00:00:00Z', scope: 'organization' });
    expect(fetchImpl.mock.calls[0][0]).toContain('/organizations/me/notes?endedAfter=');
  });
});

describe('Claude composer', () => {
  const fakeClient = (response) => ({ beta: { messages: { create: vi.fn(async () => response) } } });

  it('asks for structured JSON output with refusal fallback and returns it', async () => {
    const client = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(composed) }] });
    const result = await composerFrom({ client })({ note: note(), sourceText: '원문', sourceKind: 'summary' });
    expect(result).toEqual(composed);
    const request = client.beta.messages.create.mock.calls[0][0];
    expect(request.model).toBe('claude-opus-5-5');
    expect(request.output_config.format).toMatchObject({ type: 'json_schema' });
    expect(request).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    expect(request.tool_choice).toBeUndefined();
    expect(request.messages[0].content).toContain('<원문>\n원문\n</원문>');
  });

  it('fails instead of saving an empty or refused note', async () => {
    const empty = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"counterpart":"","summary":[]}' }] });
    await expect(composerFrom({ client: empty })({ note: note(), sourceText: 'x', sourceKind: 'summary' })).rejects.toThrow('비었습니다');
    const refused = fakeClient({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] });
    await expect(composerFrom({ client: refused })({ note: note(), sourceText: 'x', sourceKind: 'summary' })).rejects.toThrow('거절');
  });
});

describe('Tiro webhook', () => {
  const secret = 'whsec_test';
  const sign = async (body) => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  };

  it('accepts only the shared secret and a matching body signature', async () => {
    const rawBody = '{"type":"note.ended"}';
    expect(await verifyWebhook({ secret, rawBody, authorization: `Bearer ${secret}`, signature: await sign(rawBody) })).toBe(true);
    expect(await verifyWebhook({ secret, rawBody, authorization: `Bearer ${secret}` })).toBe(true);
    expect(await verifyWebhook({ secret, rawBody, authorization: 'Bearer wrong', signature: await sign(rawBody) })).toBe(false);
    expect(await verifyWebhook({ secret, rawBody: `${rawBody} `, authorization: `Bearer ${secret}`, signature: await sign(rawBody) })).toBe(false);
    expect(await verifyWebhook({ secret: '', rawBody, authorization: 'Bearer ' })).toBe(false);
  });

  it('finds the note GUID in note and summary events and ignores the rest', () => {
    expect(noteGuidFromEvent({ type: 'note_summary.generated', data: { resourceType: 'NoteSummary', resourceId: '7', resource: { noteGuid: 'n1' } } })).toBe('n1');
    expect(noteGuidFromEvent({ type: 'note_summary.updated', data: { resourceType: 'NoteSummary', resource: { note: { guid: 'n2' } } } })).toBe('n2');
    expect(noteGuidFromEvent({ type: 'note.ended', data: { resourceType: 'Note', resourceId: 'n3', resource: {} } })).toBe('n3');
    expect(noteGuidFromEvent({ type: 'note.deleted', data: { resourceType: 'Note', resourceId: 'n4' } })).toBeNull();
  });

  it('answers 401 without the secret, and processes the note after a 200', async () => {
    const env = { TIRO_WEBHOOK_SECRET: secret, STATE_KV: memoryKv() };
    const waits = [];
    const ctx = { waitUntil: (promise) => waits.push(promise) };
    const body = JSON.stringify({ type: 'note.deleted', data: { resourceType: 'Note', resourceId: 'n1' } });
    const bad = await worker.fetch(new Request('https://t/tiro/webhook', { method: 'POST', body, headers: { authorization: 'Bearer nope' } }), env, ctx);
    expect(bad.status).toBe(401);
    const ignored = await worker.fetch(new Request('https://t/tiro/webhook', { method: 'POST', body, headers: { authorization: `Bearer ${secret}`, 'x-tiro-signature': await sign(body) } }), env, ctx);
    expect(await ignored.json()).toEqual({ ok: true, ignored: true });
    expect(waits).toHaveLength(0);
  });

  it('reports configuration on /healthz without exposing values', async () => {
    const response = await worker.fetch(new Request('https://t/healthz'), { TIRO_API_KEY: 'secret-value', STATE_KV: memoryKv() }, {});
    const body = await response.json();
    expect(body).toMatchObject({ service: 'myscube-tiro-autosave', configured: { tiro: true, claude: false, drive: false, webhook: false }, lastRun: null });
    expect(JSON.stringify(body)).not.toContain('secret-value');
  });
});
