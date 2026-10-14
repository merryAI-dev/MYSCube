import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStore } from '../src/ema/files.mjs';
import { createNoteStore, handleNotePage, noteSaverFrom } from '../src/ema/note-save.mjs';
import { createEmaMcpServer } from '../src/ema/tools.mjs';
import { fakeEma, memoryKv } from './ema-support.mjs';

let client;
afterEach(async () => { await client?.close(); client = undefined; });

const noteInput = { counterpart: 'White Box Enterprise', category: '호주 파트너', meetingDate: '2026-10-12', summary: ['협업 논의'], sourceRef: 'tiro:1' };

async function connect({ kv = memoryKv(), saveNote = null } = {}) {
  const notes = createNoteStore(kv);
  const server = createEmaMcpServer({
    ema: fakeEma(), store: createStore(kv), notes, saveNote, publicOrigin: 'https://ema-mcp.myscguard.app',
    access: { uid: 'u1', role: 'consultant', canExportAndImport: false },
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

describe('saving meeting notes to the team drive', () => {
  it('returns a save link from the markdown tool and saves directly when allowed', async () => {
    const saved = [];
    const notes = await connect({ saveNote: async (note) => { saved.push(note); return { fileId: 'f1', url: 'https://drive/f1', name: note.fileName, updated: false }; } });
    const { json } = await call('ema_meeting_note_markdown', noteInput);
    expect(json.saveUrl).toBe(`https://ema-mcp.myscguard.app/note/${json.noteId}`);
    expect(json.driveSaveReady).toBe(true);
    expect((await notes.get(json.noteId)).uid).toBe('u1');
    const result = await call('ema_meeting_note_save', { noteId: json.noteId });
    expect(result.json.fileId).toBe('f1');
    expect(saved[0]).toMatchObject({ fileName: '20261012 [호주 파트너] White Box Enterprise 미팅.md', sourceRef: 'tiro:1' });
  });

  it('explains when drive saving is not configured yet', async () => {
    await connect();
    const { json } = await call('ema_meeting_note_markdown', noteInput);
    expect(json.driveSaveReady).toBe(false);
    const result = await call('ema_meeting_note_save', { noteId: json.noteId });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('관리자 설정');
  });

  it('the save page previews on GET, saves only on POST, and offers a .md download', async () => {
    const notes = createNoteStore(memoryKv());
    const token = await notes.put('u1', { fileName: '20261012 회의.md', markdown: '# <b>제목</b>', sourceRef: '' });
    let saves = 0;
    const save = async () => { saves += 1; return { url: 'https://drive/f', name: '20261012 회의.md', updated: true }; };
    const url = `https://ema-mcp.myscguard.app/note/${token}`;
    const get = await handleNotePage(new Request(url), { notes, token, save });
    const html = await get.text();
    expect(html).toContain('&#60;b&#62;제목');
    expect(saves).toBe(0);
    const post = await handleNotePage(new Request(url, { method: 'POST' }), { notes, token, save });
    expect(await post.text()).toContain('기존 파일을 갱신했습니다');
    expect(saves).toBe(1);
    const download = await handleNotePage(new Request(`${url}?download=1`), { notes, token, save });
    expect(download.headers.get('content-disposition')).toContain(encodeURIComponent('20261012 회의.md'));
    expect(await download.text()).toBe('# <b>제목</b>');
    expect((await handleNotePage(new Request(url), { notes, token: 'x'.repeat(30), save })).status).toBe(410);
  });

  it('the saver posts the note to the Apps Script and surfaces failures', async () => {
    expect(noteSaverFrom({})).toBeNull();
    const calls = [];
    const saver = noteSaverFrom({ NOTES_SAVE_URL: 'https://script.google.com/x' }, async (target, init) => {
      calls.push([target, JSON.parse(init.body)]);
      return new Response(JSON.stringify({ ok: true, fileId: 'f', url: 'u', name: 'n.md', updated: false }));
    });
    expect((await saver({ fileName: 'n.md', markdown: 'm' })).fileId).toBe('f');
    expect(calls[0][1]).toEqual({ fileName: 'n.md', markdown: 'm', sourceRef: '' });
    const failing = noteSaverFrom({ NOTES_SAVE_URL: 'u' }, async () => new Response(JSON.stringify({ ok: false })));
    await expect(failing({ fileName: 'n.md', markdown: 'm' })).rejects.toThrow('드라이브');
  });
});
