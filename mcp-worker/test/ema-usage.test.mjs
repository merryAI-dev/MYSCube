import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStore } from '../src/ema/files.mjs';
import { createNoteStore } from '../src/ema/note-save.mjs';
import { createEmaMcpServer } from '../src/ema/tools.mjs';
import { clientOf, usageRecorder } from '../src/usage.mjs';
import { fakeEma, memoryKv } from './ema-support.mjs';

describe('MCP usage tracking', () => {
  it('tells ChatGPT and Claude apart from the user agent', () => {
    expect(clientOf('openai-mcp/1.0.0')).toBe('chatgpt');
    expect(clientOf('Claude-User (claude-code/2.1)')).toBe('claude');
    expect(clientOf('')).toBe('other');
  });

  it('writes one metadata row per tool call and never the tool input', async () => {
    const points = [];
    const dataset = { writeDataPoint: (point) => points.push(point) };
    const kv = memoryKv();
    const server = createEmaMcpServer({
      ema: fakeEma(), store: createStore(kv), notes: createNoteStore(kv),
      saveNote: async () => ({ fileId: 'f', url: 'u', name: 'n.md', updated: false }), publicOrigin: 'https://ema-mcp.myscguard.app',
      access: { uid: 'u1', role: 'consultant', canExportAndImport: false },
      record: usageRecorder(dataset, { uid: 'u1', role: 'consultant', client: 'chatgpt' }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'usage-test', version: '1.0.0' });
    await client.connect(clientTransport);
    const composed = await client.callTool({ name: 'meeting_note_compose', arguments: { counterpart: '비밀기업', meetingDate: '2026-10-14', summary: ['비밀 내용'] } });
    const { noteId } = JSON.parse(composed.content[0].text);
    await client.callTool({ name: 'meeting_note_save', arguments: { noteId, destination: 'drive' } });
    await client.callTool({ name: 'meeting_note_save', arguments: { noteId: 'x'.repeat(30), destination: 'both' } });
    await client.close();

    expect(points.map((point) => point.blobs.slice(0, 3))).toEqual([
      ['meeting_note_compose', 'tool', 'ok'],
      ['meeting_note_save', 'tool', 'ok'],
      ['meeting_note_save', 'tool', 'error'],
    ]);
    expect(points[1].blobs.slice(3)).toEqual(['consultant', 'chatgpt', 'u1', 'drive']);
    expect(JSON.stringify(points)).not.toContain('비밀');
  });

  it('is a no-op without a dataset and never throws from recording', () => {
    expect(() => usageRecorder(undefined)({ kind: 'tool', name: 'x', outcome: 'ok' })).not.toThrow();
    const broken = usageRecorder({ writeDataPoint: () => { throw new Error('down'); } });
    expect(() => broken({ kind: 'tool', name: 'x', outcome: 'ok' })).not.toThrow();
  });
});

describe('weekly usage report', async () => {
  const { formatUsageReport, summarizeUsage, usageQuery } = await import('../src/usage-report.mjs');
  it('summarizes calls, users, apps, save destinations and failures', () => {
    const rows = [
      { name: 'meeting_note_compose', kind: 'tool', outcome: 'ok', client: 'chatgpt', uid: 'a', detail: '', calls: 3 },
      { name: 'meeting_note_save', kind: 'tool', outcome: 'ok', client: 'claude', uid: 'b', detail: 'drive', calls: 2 },
      { name: 'meeting_note_save', kind: 'tool', outcome: 'error', client: 'chatgpt', uid: 'a', detail: 'both', calls: 1 },
      { name: 'note_save_page', kind: 'page', outcome: 'ok', client: 'web', uid: 'a', detail: 'both', calls: 1 },
    ];
    const summary = summarizeUsage(rows);
    expect(summary).toMatchObject({ calls: 7, errors: 1, users: 2, byClient: { chatgpt: 4, claude: 2 }, destinations: { drive: 2, both: 1 } });
    const text = formatUsageReport(summary, { days: 7, from: '2026-10-07', to: '2026-10-14' });
    expect(text).toContain('전체 호출 7회, 사용자 2명, 실패율 14%');
    expect(text).toContain('회의록 저장: 3회 (사용자 2명, 실패 1회)');
    expect(text).toContain('회의록 저장 위치: 팀 드라이브 2 · 둘 다 1');
    expect(formatUsageReport(summarizeUsage([]), { days: 7, from: 'a', to: 'b' })).toContain('호출이 없습니다');
    expect(usageQuery(7)).toContain("INTERVAL '7' DAY");
  });
});

describe('MYSCube MCP usage tracking', async () => {
  const { createMyscubeMcpServer } = await import('../src/tools.mjs');
  it('records MYSCube tool calls with the catalog id but not the params', async () => {
    const points = [];
    const server = createMyscubeMcpServer({
      bff: { get: async () => ({ items: [] }), post: async () => ({}) },
      record: usageRecorder({ writeDataPoint: (point) => points.push(point) }, { uid: 'm1', role: 'member', client: 'claude' }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'myscube-usage-test', version: '1.0.0' });
    await client.connect(clientTransport);
    await client.callTool({ name: 'api_catalog', arguments: { keyword: '비밀키워드' } });
    await client.close();
    expect(points).toHaveLength(1);
    expect(points[0].blobs.slice(0, 6)).toEqual(['api_catalog', 'tool', 'ok', 'member', 'claude', 'm1']);
    expect(JSON.stringify(points)).not.toContain('비밀키워드');
  });
});
