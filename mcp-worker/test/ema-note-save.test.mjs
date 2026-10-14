import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStore } from '../src/ema/files.mjs';
import { createNoteStore, handleNotePage, noteSaverFrom, saveToDestinations } from '../src/ema/note-save.mjs';
import { createEmaMcpServer } from '../src/ema/tools.mjs';
import { fakeEma, memoryKv } from './ema-support.mjs';

let client;
afterEach(async () => { await client?.close(); client = undefined; });

const noteInput = { counterpart: 'White Box Enterprise', category: '호주 파트너', meetingDate: '2026-10-12', summary: ['협업 논의'], sourceRefs: ['tiro:2', 'tiro:1'], source: 'tiro' };
const draftEma = (calls) => fakeEma({
  draftMeetingRecordFromFile: async ({ text }) => { calls.push(['draft', text]); return { draft: { topic: '협업', companyStatus: 'a', advisoryContent: 'b', followUp: 'c', participants: [] } }; },
  saveMeetingDraft: async (data) => { calls.push(['save', data]); return { id: 'draft123456', replaced: false, expiresAt: '2027-01-12T00:00:00.000Z' }; },
});

async function connect({ role = 'consultant', ema = fakeEma(), saveNote = null, kv = memoryKv() } = {}) {
  const notes = createNoteStore(kv);
  const server = createEmaMcpServer({
    ema, store: createStore(kv), notes, saveNote, publicOrigin: 'https://ema-mcp.myscguard.app',
    access: { uid: 'u1', role, canExportAndImport: false, idToken: 'id-token', idTokenExpiresAt: Date.now() + 50 * 60_000 },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'note-save-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return notes;
}

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  return { ...result, json: result.isError ? null : JSON.parse(result.content[0].text) };
};

const driveSaver = (saved) => async (note) => { saved.push(note); return { fileId: 'f1', url: 'https://drive/f1', name: note.fileName, updated: false }; };

describe('meeting notes: compose, then save to an explicit destination', () => {
  it('offers a guide that names both destinations', async () => {
    await connect();
    const { json } = await call('meeting_note_guide', {});
    expect(json.guide).toContain('팀 드라이브');
    expect(json.guide).toContain('EMA 보고서 초안함');
    expect(json.guide).toContain('file_uri');
  });

  it('saves to the team drive only when destination is drive', async () => {
    const saved = [];
    const calls = [];
    await connect({ ema: draftEma(calls), saveNote: driveSaver(saved) });
    const { json } = await call('meeting_note_compose', noteInput);
    expect(json.saveUrl).toBe(`https://ema-mcp.myscguard.app/note/${json.noteId}`);
    expect(json.destinations).toEqual({ drive: true, ema_draft: true });
    const result = await call('meeting_note_save', { noteId: json.noteId, destination: 'drive' });
    expect(result.json.results.drive).toMatchObject({ ok: true, fileId: 'f1' });
    expect(result.json.results.ema_draft).toBeUndefined();
    expect(saved[0]).toMatchObject({ fileName: '20261012 [호주 파트너] White Box Enterprise 미팅.md', sourceRef: 'tiro:1+tiro:2' });
    expect(calls).toEqual([]);
  });

  it('saves to both and reports each destination separately', async () => {
    const calls = [];
    await connect({ ema: draftEma(calls), saveNote: driveSaver([]) });
    const { json } = await call('meeting_note_compose', noteInput);
    const result = await call('meeting_note_save', { noteId: json.noteId, destination: 'both' });
    expect(result.json.allSaved).toBe(true);
    expect(result.json.results.ema_draft).toMatchObject({ ok: true, draftId: 'draft123456' });
    const save = calls.find(([kind]) => kind === 'save')[1];
    expect(save).toMatchObject({ source: 'tiro', sourceRef: 'tiro:1+tiro:2', meetingDate: '2026-10-12' });
    expect(save.rawText).toContain('## 요약');
  });

  it('lets every member save to the drive, but the EMA draft box only for admins and consultants', async () => {
    await connect({ role: 'staff', saveNote: driveSaver([]) });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['meeting_note_guide', 'meeting_note_compose', 'meeting_note_save']));
    const { json } = await call('meeting_note_compose', noteInput);
    expect(json.destinations.ema_draft).toBe(false);
    const result = await call('meeting_note_save', { noteId: json.noteId, destination: 'both' });
    expect(result.json.allSaved).toBe(false);
    expect(result.json.results.drive.ok).toBe(true);
    expect(result.json.results.ema_draft.error).toContain('관리자·컨설턴트');
  });

  it('keeps one destination result when the other fails', async () => {
    const result = await saveToDestinations({ note: { fileName: 'a.md', markdown: '# a' }, destination: 'both', saveNote: null, ema: null });
    expect(result.results.drive.error).toContain('관리자 설정');
    await expect(saveToDestinations({ note: {}, destination: 'nowhere' })).rejects.toThrow('drive');
  });
});

describe('save link page', () => {
  const setup = async (note) => {
    const notes = createNoteStore(memoryKv());
    const token = await notes.put('u1', { fileName: '20261012 회의.md', title: '회의', date: '2026-10-12', markdown: '# <b>제목</b>', sourceRef: 'm1', source: 'meet-gmail', ...note });
    return { notes, token, url: `https://ema-mcp.myscguard.app/note/${token}` };
  };
  const form = (destination) => { const body = new FormData(); body.set('destination', destination); return body; };

  it('shows destination buttons, saves only on POST and offers a .md download', async () => {
    const { notes, token, url } = await setup({ idToken: 't', idTokenExpiresAt: Date.now() + 30 * 60_000 });
    const calls = [];
    let drives = 0;
    const deps = { notes, token, saveNote: async () => { drives += 1; return { url: 'https://drive/f', name: '20261012 회의.md', updated: true }; }, emaFor: () => draftEma(calls) };
    const html = await (await handleNotePage(new Request(url), deps)).text();
    expect(html).toContain('&#60;b&#62;제목');
    expect(html).toContain('value="drive"');
    expect(html).toContain('value="ema_draft"');
    expect(html).toContain('value="both"');
    expect(drives).toBe(0);
    const post = await handleNotePage(new Request(url, { method: 'POST', body: form('both') }), deps);
    const text = await post.text();
    expect(text).toContain('기존 것을 갱신했습니다');
    expect(text).toContain('EMA 보고서 초안함');
    expect(drives).toBe(1);
    expect(calls.some(([kind]) => kind === 'save')).toBe(true);
    const download = await handleNotePage(new Request(`${url}?download=1`), deps);
    expect(await download.text()).toBe('# <b>제목</b>');
    expect((await handleNotePage(new Request(url), { ...deps, token: 'x'.repeat(30) })).status).toBe(410);
  });

  it('hides the EMA draft button once the login proof has expired', async () => {
    const { notes, token, url } = await setup({ idToken: 't', idTokenExpiresAt: Date.now() - 1 });
    const deps = { notes, token, saveNote: async () => ({}), emaFor: () => fakeEma() };
    const html = await (await handleNotePage(new Request(url), deps)).text();
    expect(html).toContain('value="drive"');
    expect(html).not.toContain('value="ema_draft"');
    expect(html).not.toContain('value="both"');
    expect((await handleNotePage(new Request(url, { method: 'POST', body: form('nowhere') }), deps)).status).toBe(400);
  });

  it('the saver posts the note to the Apps Script and surfaces failures', async () => {
    expect(noteSaverFrom({})).toBeNull();
    const calls = [];
    const saver = noteSaverFrom({ NOTES_SAVE_URL: 'https://script.google.com/x' }, async (target, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, fileId: 'f', url: 'u', name: 'n.md', updated: false }));
    });
    expect((await saver({ fileName: 'n.md', markdown: 'm' })).fileId).toBe('f');
    expect(calls[0]).toEqual({ fileName: 'n.md', markdown: 'm', sourceRef: '' });
    const failing = noteSaverFrom({ NOTES_SAVE_URL: 'u' }, async () => new Response(JSON.stringify({ ok: false })));
    await expect(failing({ fileName: 'n.md', markdown: 'm' })).rejects.toThrow('팀 드라이브');
  });
});
