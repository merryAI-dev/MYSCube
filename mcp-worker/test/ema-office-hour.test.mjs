import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStore } from '../src/ema/files.mjs';
import { createEmaMcpServer } from '../src/ema/tools.mjs';
import { fakeEma, memoryKv } from './ema-support.mjs';

let client;
afterEach(async () => { await client?.close(); client = undefined; });

async function connect({ ema, role = 'admin' }) {
  const server = createEmaMcpServer({
    ema, store: createStore(memoryKv()), publicOrigin: 'https://ema-mcp.myscguard.app',
    access: { uid: 'u1', role, canExportAndImport: false },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'office-hour-test', version: '1.0.0' });
  await client.connect(clientTransport);
}

const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { ...result, json: result.isError ? null : JSON.parse(result.content[0].text) };
};

describe('office hour read tools', () => {
  it('passes filters through to the single EMA query and only reads', async () => {
    const seen = [];
    const ema = fakeEma({
      queryOfficeHourForMcp: async (data) => { seen.push(data); return { total: 0, items: [], nextOffset: null }; },
    });
    await connect({ ema });
    await call('ema_office_hour_summary', { from: '2026-09-01', programId: 'p1' });
    await call('ema_office_hour_list', { hasReport: false, includeContent: true, offset: 100, pageSize: 50, query: '투자' });
    await call('ema_office_hour_get', { id: 'app_1', includeRaw: true });
    expect(seen).toEqual([
      { op: 'summary', filters: { from: '2026-09-01', programId: 'p1' } },
      { op: 'list', filters: { hasReport: false, query: '투자' }, includeContent: true, offset: 100, pageSize: 50 },
      { op: 'detail', id: 'app_1', includeRaw: true },
    ]);
  });

  it('is hidden from non-staff roles and rejects malformed ids', async () => {
    await connect({ ema: fakeEma(), role: 'staff' });
    expect((await client.listTools()).tools.some((tool) => tool.name.startsWith('ema_office_hour'))).toBe(false);
    await client.close();
    await connect({ ema: fakeEma() });
    expect((await call('ema_office_hour_get', { id: '../x' })).isError).toBe(true);
    expect((await call('ema_office_hour_summary', { from: '9/1' })).isError).toBe(true);
  });
});
