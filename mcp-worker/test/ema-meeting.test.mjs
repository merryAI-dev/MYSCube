import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStore } from '../src/ema/files.mjs';
import { createEmaMcpServer } from '../src/ema/tools.mjs';
import { fakeEma, memoryKv } from './ema-support.mjs';

let client;
afterEach(async () => { await client?.close(); client = undefined; });

async function connect({ ema, role = 'consultant' }) {
  const server = createEmaMcpServer({
    ema, store: createStore(memoryKv()), publicOrigin: 'https://ema-mcp.myscguard.app',
    access: { uid: 'c1', role, canExportAndImport: false },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'meeting-test', version: '1.0.0' });
  await client.connect(clientTransport);
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { ...result, json: result.isError ? null : JSON.parse(result.content[0].text) };
}

const note = '모닥불 에너지 대표와 투자 유치 전략을 논의했다. 후속으로 IR 자료 수정과 데모데이 일정 확정이 필요하다.';

describe('meeting drafts from connector text', () => {
  it('drafts the text on the EMA side, saves the raw text with it, and writes nothing to the ledger', async () => {
    const ema = fakeEma({
      draftMeetingRecordFromFile: async ({ text }) => {
        expect(text).toBe(note);
        return { draft: { topic: '투자 유치 전략', companyStatus: 'a', advisoryContent: 'b', followUp: 'c', participants: ['이창섭'] } };
      },
      saveMeetingDraft: async () => ({ id: 'draft123456', replaced: false, expiresAt: '2027-01-12T00:00:00.000Z' }),
    });
    await connect({ ema });
    const { json } = await call('ema_meeting_draft_create', { text: note, source: 'meet-gmail', sourceRef: 'gmail:m1', meetingDate: '2026-10-13' });
    expect(json).toMatchObject({ draftId: 'draft123456', truncated: false, draft: { topic: '투자 유치 전략' } });
    const saved = ema.call.mock.calls.find(([name]) => name === 'saveMeetingDraft')[1];
    expect(saved).toMatchObject({ source: 'meet-gmail', sourceRef: 'gmail:m1', rawText: note, meetingDate: '2026-10-13', title: '투자 유치 전략' });
    expect(ema.call.mock.calls.map(([name]) => name).every((name) => ['draftMeetingRecordFromFile', 'saveMeetingDraft'].includes(name))).toBe(true);
  });

  it('truncates very long minutes and says so', async () => {
    const ema = fakeEma({
      draftMeetingRecordFromFile: async ({ text }) => { expect(text).toHaveLength(60000); return { draft: { topic: 't' } }; },
      saveMeetingDraft: async () => ({ id: 'draft_long_1', replaced: false, expiresAt: 'x' }),
    });
    await connect({ ema });
    const { json } = await call('ema_meeting_draft_create', { text: '가'.repeat(70000) });
    expect(json.truncated).toBe(true);
  });

  it('never returns the raw text on get, and hides meeting tools from other roles', async () => {
    const ema = fakeEma({ getMeetingDraft: async () => ({ id: 'd', title: 't', draft: { topic: 'x' }, rawText: '비밀 원문' }) });
    await connect({ ema });
    const { json } = await call('ema_meeting_draft_get', { id: 'draft_abcdefg' });
    expect(JSON.stringify(json)).not.toContain('비밀 원문');
    expect(json.hasRawText).toBe(true);
    await client.close();
    await connect({ ema, role: 'staff' });
    expect((await client.listTools()).tools.some((tool) => tool.name.startsWith('ema_meeting'))).toBe(false);
  });

  it('has no Google dependency: no google tools are exposed', async () => {
    await connect({ ema: fakeEma() });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => name.includes('google'))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['ema_meeting_draft_create', 'ema_meeting_drafts_list', 'ema_meeting_draft_get', 'ema_meeting_draft_delete']));
  });
});
