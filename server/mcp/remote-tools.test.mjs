import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRemoteMcpServer } from './remote-tools.mjs';

const context = { tenantId: 'mysc', actorId: 'pm-1', actorRole: 'pm', actorEmail: 'pm-1@mysc.co.kr', authSource: 'mcp_oauth' };

function projectsDb(projects) {
  return {
    doc(path) {
      const id = path.split('/').at(-1);
      return { async get() { const data = projects[id]; return { exists: data !== undefined, data: () => data }; } };
    },
    collection(path) {
      expect(path).toBe('orgs/mysc/projects');
      let limit = Infinity;
      const query = {
        select: () => query,
        limit: (value) => { limit = value; return query; },
        async get() {
          return { docs: Object.entries(projects).slice(0, limit).map(([id, data]) => ({ id, data: () => data })) };
        },
      };
      return query;
    },
  };
}

let client;

async function connect(options) {
  const server = createRemoteMcpServer({ context, readWeeklyOverview: vi.fn(), readCashflowSnapshot: vi.fn(),
    isProjectVisible: async () => true, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'remote-tools-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { ...result, json: result.isError ? null : JSON.parse(result.content[0].text) };
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe('remote MYSCube MCP tools', () => {
  it('publishes only read-only tools', async () => {
    await connect({ db: projectsDb({}) });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['accounting_read', 'cashflow_status', 'project_get', 'project_search']);
    await client.close();
    await connect({ db: projectsDb({}), inspectCashflowSheet: vi.fn(), readApi: vi.fn() });
    const full = (await client.listTools()).tools;
    expect(full.map((tool) => tool.name).sort()).toEqual(['accounting_read', 'api_catalog', 'api_read', 'cashflow_status', 'project_get', 'project_search', 'sheet_check']);
    for (const tool of full) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.description.length).toBeGreaterThan(20);
      for (const property of Object.values(tool.inputSchema.properties || {})) expect(property.description).toBeTruthy();
    }
  });

  it('searches name and short name within the caller scope and skips trashed projects', async () => {
    const db = projectsDb({
      p1: { name: '에코 스타트업 육성', shortName: '에코', cic: 'CIC1', status: 'IN_PROGRESS' },
      p2: { name: '지역 혁신', shortName: '에코로컬', status: 'IN_PROGRESS' },
      p3: { name: '에코 비공개 사업' },
      p4: { name: '에코 삭제 사업', trashedAt: '2026-09-01T00:00:00Z' },
      p5: { name: '다른 사업' },
    });
    await connect({ db, isProjectVisible: async (id) => id !== 'p3' });
    const { json } = await call('project_search', { query: '에코' });
    expect(json.items.map((item) => item.projectId)).toEqual(['p1', 'p2']);
    expect(json.items[0]).toEqual({ projectId: 'p1', name: '에코 스타트업 육성', shortName: '에코', cic: 'CIC1', status: 'IN_PROGRESS' });
    expect(json.truncated).toBe(false);
  });

  it('marks search results truncated past twenty matches', async () => {
    const projects = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`p${index}`, { name: `사업 ${index}` }]));
    await connect({ db: projectsDb(projects) });
    const { json } = await call('project_search', { query: '사업' });
    expect(json.items).toHaveLength(20);
    expect(json.truncated).toBe(true);
  });

  it('returns whitelisted project fields only and refuses projects outside scope', async () => {
    const db = projectsDb({
      p1: { name: '에코', status: 'IN_PROGRESS', managerName: '홍길동', contractAmount: 1000, clientOrg: '기관',
        registeredByEmail: 'x@mysc.co.kr', participationSheetLink: 'https://docs.google.com/x', contractDocument: { url: 'u' },
        executiveReviewComment: '내부 검토', profitRate: 0.3 },
      p2: { name: '비공개' },
      p3: { name: '삭제', trashedAt: '2026-09-01' },
    });
    await connect({ db, isProjectVisible: async (id) => id !== 'p2' });
    const { json } = await call('project_get', { projectId: 'p1' });
    expect(json).toEqual({ projectId: 'p1', name: '에코', status: 'IN_PROGRESS', managerName: '홍길동', contractAmount: 1000, clientOrg: '기관' });
    expect((await call('project_get', { projectId: 'p2' })).isError).toBe(true);
    expect((await call('project_get', { projectId: 'p3' })).isError).toBe(true);
  });

  it('reads accounting and settlement status with the caller context, never a service principal', async () => {
    const readCashflowSnapshot = vi.fn(async () => ({
      projectId: 'p1', targetRevision: 'rev-1',
      accountingSource: { weeklyYear: 2026, projectName: '에코', projectCurrency: 'KRW', mirror: {} },
      readModel: { months: [] },
    }));
    const readWeeklyOverview = vi.fn(async () => ({ items: [], errors: [] }));
    await connect({ db: projectsDb({}), readCashflowSnapshot, readWeeklyOverview });

    const accounting = await call('accounting_read', { projectId: 'p1', yearMonth: '2026-09' });
    expect(accounting.json).toMatchObject({ projectId: 'p1', yearMonth: '2026-09', availability: 'NOT_RECORDED', amountCurrency: 'KRW' });
    expect(readCashflowSnapshot).toHaveBeenCalledWith({ context, params: { projectId: 'p1' }, query: { yearMonth: '2026-09' } });

    await call('cashflow_status', { yearMonth: '2026-09', projectIds: ['p1'] });
    expect(readWeeklyOverview).toHaveBeenCalledWith({ context, body: { yearMonth: '2026-09', projectIds: ['p1'] } });
  });

  it('surfaces permission errors from the read path as tool errors', async () => {
    const readCashflowSnapshot = vi.fn(async () => { throw new Error('이 프로젝트에 접근할 권한이 없습니다.'); });
    await connect({ db: projectsDb({}), readCashflowSnapshot });
    const result = await call('accounting_read', { projectId: 'p9', yearMonth: '2026-09' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('권한');
  });

  it('inspects a sheet with the caller context and refuses projects outside scope', async () => {
    const inspectCashflowSheet = vi.fn(async ({ projectId }) => ({ projectId, verdict: 'NEEDS_FIX', issues: [{ code: 'cashflow_week_header_invalid', sourceCell: 'E13' }] }));
    await connect({ db: projectsDb({}), inspectCashflowSheet, isProjectVisible: async (id) => id === 'p1' });
    const { json } = await call('sheet_check', { projectId: 'p1', sourceYear: 2026 });
    expect(json).toMatchObject({ verdict: 'NEEDS_FIX', issues: [{ sourceCell: 'E13' }] });
    expect(inspectCashflowSheet).toHaveBeenCalledWith({ context, projectId: 'p1', sourceYear: 2026 });
    expect((await call('sheet_check', { projectId: 'p2' })).isError).toBe(true);
    expect(inspectCashflowSheet).toHaveBeenCalledTimes(1);
  });

  it('lists the vetted API catalog with tags, params schema and a version hash', async () => {
    await connect({ db: projectsDb({}), readApi: vi.fn() });
    const all = (await call('api_catalog', {})).json;
    expect(all.version).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(all.items.length).toBeGreaterThan(5);
    for (const item of all.items) {
      expect(item.tags).toContain('#읽기전용');
      expect(item.params).toMatchObject({ type: 'object' });
    }
    const monthClose = (await call('api_catalog', { tag: '월결산' })).json.items;
    expect(monthClose.length).toBeGreaterThan(0);
    expect(monthClose.every((item) => item.tags.includes('#월결산'))).toBe(true);
    expect((await call('api_catalog', { keyword: 'activity' })).json.items.map((item) => item.id)).toEqual(['cashflow.activity']);
  });

  it('runs a catalog entry through the existing API with validated params and redacts links and emails', async () => {
    const readApi = vi.fn(async () => ({ status: 200, body: { items: [{ id: 'a1', type: 'MIRROR_REFRESH', actorEmail: 'x@mysc.co.kr', fileUrl: 'https://f', nested: { sheetLink: 'https://s', value: 3 } }], nextCursor: 'c2' } }));
    await connect({ db: projectsDb({}), readApi });
    const { json } = await call('api_read', { id: 'cashflow.activity', params: { projectId: 'p1', limit: 10 } });
    expect(readApi).toHaveBeenCalledWith('/api/v1/cashflow/p1/activity', { cursor: undefined, limit: 10 });
    expect(json).toEqual({ id: 'cashflow.activity', data: { items: [{ id: 'a1', type: 'MIRROR_REFRESH', nested: { value: 3 } }], nextCursor: 'c2' } });
  });

  it('rejects unknown ids, malformed params, projects outside scope and API errors', async () => {
    const readApi = vi.fn(async () => ({ status: 403, body: { message: 'Role lacks permission' } }));
    await connect({ db: projectsDb({}), readApi, isProjectVisible: async (id) => id === 'p1' });
    expect((await client.callTool({ name: 'api_read', arguments: { id: 'admin.delete_everything' } })).isError).toBe(true);
    const malformed = await call('api_read', { id: 'settlement.statuses', params: { projectId: 'p1', yearMonth: '2026-9' } });
    expect(malformed.isError).toBe(true);
    expect(malformed.content[0].text).toContain('yearMonth');
    expect((await call('api_read', { id: 'settlement.statuses', params: { projectId: 'p1', yearMonth: '2026-09', extra: 1 } })).isError).toBe(true);
    expect((await call('api_read', { id: 'cashflow.activity', params: { projectId: 'p2' } })).isError).toBe(true);
    expect(readApi).not.toHaveBeenCalled();
    const denied = await call('api_read', { id: 'settlement.statuses', params: { projectId: 'p1', yearMonth: '2026-09' } });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('permission');
  });
});
