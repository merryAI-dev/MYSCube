import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMyscubeMcpServer } from '../src/tools.mjs';
import { BffError } from '../src/bff.mjs';

let client;
afterEach(async () => { await client?.close(); client = undefined; });

async function connect(bff) {
  const server = createMyscubeMcpServer({ bff });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'worker-tools-test', version: '1.0.0' });
  await client.connect(clientTransport);
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { ...result, json: result.isError ? null : JSON.parse(result.content[0].text) };
}

const projects = [
  { id: 'p1', name: '에코 스타트업 육성', shortName: '에코', cic: 'CIC1', status: 'IN_PROGRESS', managerName: '홍길동',
    contractAmount: 1000, registeredByEmail: 'x@mysc.co.kr', participationSheetLink: 'https://docs/x', profitRate: 0.3 },
  { id: 'p2', name: '에코 삭제', trashedAt: '2026-09-01' },
  { id: 'p3', name: '다른 사업' },
];

describe('MYSCube MCP worker tools', () => {
  it('publishes read-only tools with described inputs and server instructions', async () => {
    await connect({ get: vi.fn(), post: vi.fn() });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['accounting_read', 'api_catalog', 'api_read', 'cashflow_status', 'project_get', 'project_list', 'project_search', 'sheet_check']);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      for (const property of Object.values(tool.inputSchema.properties || {})) expect(property.description).toBeTruthy();
    }
    expect(client.getInstructions()).toContain('project_search');
  });

  it('searches every searchable field and reads projects through the BFF list, paging the BFF once per request', async () => {
    const get = vi.fn(async (path, query) => (query.cursor ? { items: [projects[2]], nextCursor: null } : { items: projects.slice(0, 2), nextCursor: 'p2' }));
    await connect({ get, post: vi.fn() });
    expect((await call('project_search', { query: '에코' })).json).toEqual({ total: 1, offset: 0, count: 1, nextOffset: null, complete: true,
      items: [{ projectId: 'p1', name: '에코 스타트업 육성', shortName: '에코', cic: 'CIC1', status: 'IN_PROGRESS', managerName: '홍길동' }] });
    expect((await call('project_search', { query: '홍길동 CIC1' })).json.items.map((item) => item.projectId)).toEqual(['p1']);
    expect((await call('project_search', { query: '에코', includeTrashed: true })).json.total).toBe(2);
    expect((await call('project_get', { projectId: 'p1' })).json).toEqual({ projectId: 'p1', name: '에코 스타트업 육성', shortName: '에코',
      cic: 'CIC1', status: 'IN_PROGRESS', managerName: '홍길동', contractAmount: 1000 });
    expect((await call('project_get', { projectId: 'p2' })).json).toMatchObject({ projectId: 'p2', trashed: true });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('lists every project without a cap, following BFF pages to the end', async () => {
    const all = Array.from({ length: 3500 }, (_, index) => ({ id: `p${index}`, name: `사업 ${index}`, status: index % 2 ? 'IN_PROGRESS' : 'COMPLETED', cic: `C${index % 12}` }));
    const get = vi.fn(async (path, { cursor }) => {
      const start = cursor ? Number(cursor) : 0;
      const items = all.slice(start, start + 200);
      return { items, nextCursor: start + 200 < all.length ? String(start + 200) : null };
    });
    await connect({ get, post: vi.fn() });
    const listed = (await call('project_list', {})).json;
    expect(listed).toMatchObject({ total: 3500, count: 3500, complete: true, nextOffset: null });
    expect((await call('project_list', { status: 'IN_PROGRESS', cic: 'C1' })).json.items.every((item) => item.status === 'IN_PROGRESS' && item.cic === 'C1')).toBe(true);
    expect((await call('project_list', { offset: 3000, limit: 400 })).json).toMatchObject({ offset: 3000, count: 400, nextOffset: 3400 });
    expect(get).toHaveBeenCalledTimes(18);
  });

  it('checks settlement status for every project in BFF-sized batches when no ids are given', async () => {
    const all = Array.from({ length: 250 }, (_, index) => ({ id: `p${index}`, name: `사업 ${index}` }));
    const get = vi.fn(async () => ({ items: all, nextCursor: null }));
    const post = vi.fn(async (path, { projectIds }) => ({ yearMonth: '2026-09', items: projectIds.map((id) => ({ projectId: id })), errors: [] }));
    await connect({ get, post });
    const result = (await call('cashflow_status', { yearMonth: '2026-09' })).json;
    expect(result.projectCount).toBe(250);
    expect(result.items).toHaveLength(250);
    expect(post.mock.calls.map(([, body]) => body.projectIds.length)).toEqual([100, 100, 50]);
  });

  it('maps dedicated tools to the existing BFF APIs', async () => {
    const get = vi.fn(async (path) => (path.endsWith('/inspect') ? { verdict: 'NEEDS_FIX', issues: [{ sourceCell: 'E13' }] }
      : { projectId: 'p1', targetRevision: 'rev', accountingSource: { weeklyYear: 2026, projectName: '에코', mirror: {} }, readModel: { months: [] } }));
    const post = vi.fn(async () => ({ items: [], errors: [] }));
    await connect({ get, post });
    await call('cashflow_status', { yearMonth: '2026-09', projectIds: ['p1'] });
    expect(post).toHaveBeenCalledWith('/api/v1/cashflow/weekly-overview', { yearMonth: '2026-09', projectIds: ['p1'] });
    expect((await call('accounting_read', { projectId: 'p1', yearMonth: '2026-09' })).json).toMatchObject({ projectId: 'p1', amountCurrency: 'KRW' });
    expect(get).toHaveBeenCalledWith('/api/v1/cashflow/p1', { yearMonth: '2026-09' });
    expect((await call('sheet_check', { projectId: 'p1', sourceYear: 2026 })).json).toMatchObject({ verdict: 'NEEDS_FIX' });
    expect(get).toHaveBeenCalledWith('/api/v1/projects/p1/cashflow-sheet-lab/inspect', { sourceYear: 2026 });
  });

  it('runs only catalog entries, validates params and redacts links and emails', async () => {
    const get = vi.fn(async () => ({ items: [{ id: 'a', actorEmail: 'x@mysc.co.kr', fileUrl: 'https://f', value: 1 }], nextCursor: 'c' }));
    await connect({ get, post: vi.fn() });
    const catalog = (await call('api_catalog', { tag: '월결산' })).json;
    expect(catalog.version).toMatch(/^sha256:/);
    expect(catalog.items.every((item) => item.tags.includes('#월결산'))).toBe(true);
    expect((await call('api_read', { id: 'cashflow.activity', params: { projectId: 'p1', limit: 5 } })).json)
      .toEqual({ id: 'cashflow.activity', data: { items: [{ id: 'a', value: 1 }], nextCursor: 'c' } });
    expect(get).toHaveBeenCalledWith('/api/v1/cashflow/p1/activity', { cursor: undefined, limit: 5 });
    expect((await client.callTool({ name: 'api_read', arguments: { id: 'admin.delete' } })).isError).toBe(true);
    expect((await call('api_read', { id: 'settlement.statuses', params: { projectId: 'p1', yearMonth: '2026-9' } })).isError).toBe(true);
  });

  it('surfaces BFF permission errors as tool errors', async () => {
    await connect({ get: vi.fn(async () => { throw new BffError(403, { message: '이 프로젝트에 접근할 권한이 없습니다.' }); }), post: vi.fn() });
    const result = await call('accounting_read', { projectId: 'p9', yearMonth: '2026-09' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('권한');
  });
});
