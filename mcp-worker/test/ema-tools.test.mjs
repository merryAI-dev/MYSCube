import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStore, handleConfirm } from '../src/ema/files.mjs';
import { runImportCommit } from '../src/ema/commit.mjs';
import { createEmaMcpServer, maskBusinessNumber } from '../src/ema/tools.mjs';
import { readXlsx } from '../src/ema/xlsx.mjs';
import { fakeEma, memoryKv } from './ema-support.mjs';

let client;
afterEach(async () => { await client?.close(); client = undefined; });

async function connect({ ema, kv = memoryKv(), admin = true, now } = {}) {
  const store = createStore(kv);
  const server = createEmaMcpServer({
    ema, store, publicOrigin: 'https://ema-mcp.myscguard.app',
    access: { uid: 'u1', role: admin ? 'admin' : 'staff', canExportAndImport: admin, idToken: 'id-token-1', idTokenExpiresAt: Date.now() + 50 * 60_000 }, ...(now ? { now } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'ema-tools-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { store, kv };
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { ...result, json: result.isError ? null : JSON.parse(result.content[0].text) };
}

const company = {
  frn: 'AIR-KR-26-001', displayName: '에코랩', legalName: '주식회사 에코랩', founderName: '홍길동', owner: '김담당',
  programCode: 'AIR', countryCode: 'KR', stage: 'seed', status: 'ACTIVE', completeness: 80, completenessTier: '무성',
  businessRegistrationNo: '123-45-67890', contactEmail: 'secret@eco.co', updatedAt: '2026-10-01T00:00:00Z', businessSummary: '소개'.repeat(400),
};

describe('EMA tool surface', () => {
  it('shows read tools to every registry member and admin tools only to admins, all described', async () => {
    await connect({ ema: fakeEma(), admin: false });
    const staff = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(staff).toEqual(['ema_registry_get', 'ema_registry_search', 'ema_registry_status', 'meeting_note_compose', 'meeting_note_guide']);
    await client.close();
    await connect({ ema: fakeEma(), admin: true });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'ema_meeting_draft_create', 'ema_meeting_draft_delete', 'ema_meeting_draft_get', 'ema_meeting_drafts_list',
      'ema_office_hour_get', 'ema_office_hour_list', 'ema_office_hour_summary',
      'ema_registry_export', 'ema_registry_get', 'ema_registry_import_commit', 'ema_registry_import_confirm_link', 'ema_registry_import_preview',
      'ema_registry_import_template', 'ema_registry_import_upload_link', 'ema_registry_search', 'ema_registry_status',
      'meeting_note_compose', 'meeting_note_guide',
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(30);
      for (const property of Object.values(tool.inputSchema.properties || {})) expect(property.description).toBeTruthy();
    }
    const commit = tools.find((tool) => tool.name === 'ema_registry_import_commit');
    expect(commit.annotations.readOnlyHint).toBe(false);
    const writes = new Set(['ema_registry_import_commit', 'ema_meeting_draft_create', 'ema_meeting_draft_delete']);
    expect(tools.filter((tool) => !writes.has(tool.name)).every((tool) => tool.annotations.readOnlyHint !== false)).toBe(true);
    expect(client.getInstructions()).toContain('ema_registry_status');
  });
});

describe('status, search and detail', () => {
  it('status is passed through from the EMA function', async () => {
    const ema = fakeEma({ getRegistryStatusSummary: async () => ({ total: 120, bySector: { AIR: 40 } }) });
    await connect({ ema });
    expect((await call('ema_registry_status', { recentCount: 3 })).json).toEqual({ total: 120, bySector: { AIR: 40 } });
    expect(ema.call).toHaveBeenCalledWith('getRegistryStatusSummary', { recentCount: 3 });
  });

  it('search and detail never put contact data or the full business number into the chat', async () => {
    const ema = fakeEma({
      listRegistryCompanies: async () => ({ companies: [company] }),
      getRegistryCompanyDetail: async () => ({ company, history: [{ date: '2026-09-01', type: 'interaction', note: '미팅'.repeat(300), contributorName: '김담당' }] }),
    });
    await connect({ ema, admin: false });
    const search = await call('ema_registry_search', { query: '에코' });
    expect(search.json.companies[0]).toMatchObject({ frn: 'AIR-KR-26-001', name: '에코랩', businessNumber: '123-45-*****' });
    expect(JSON.stringify(search.json)).not.toContain('secret@eco.co');
    expect(JSON.stringify(search.json)).not.toContain('67890');
    expect(ema.call).toHaveBeenCalledWith('listRegistryCompanies', { queryText: '에코', limit: 500 });
    const detail = await call('ema_registry_get', { frn: 'AIR-KR-26-001' });
    expect(detail.json.company.businessSummary.length).toBeLessThanOrEqual(600);
    expect(detail.json.history[0].note.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(detail.json)).not.toContain('secret@eco.co');
  });

  it('flags a search that may have been cut by the EMA server', async () => {
    const many = Array.from({ length: 500 }, (_, index) => ({ ...company, frn: `AIR-KR-26-${index}` }));
    await connect({ ema: fakeEma({ listRegistryCompanies: async () => ({ companies: many }) }) });
    expect((await call('ema_registry_search', { query: '에코' })).json).toMatchObject({ total: 500, possiblyIncomplete: true });
  });

  it('masks business numbers', () => {
    expect(maskBusinessNumber('1234567890')).toBe('123-45-*****');
    expect(maskBusinessNumber('123-45-67890')).toBe('123-45-*****');
    expect(maskBusinessNumber('')).toBe('');
    expect(maskBusinessNumber('12')).toBe('(형식 확인 필요)');
  });
});

describe('export', () => {
  const exported = { total: 2, filters: { sectorCode: 'AIR' }, headers: ['FRN', '기업명', '이메일'], rows: [['AIR-KR-26-001', '에코랩', 'a@b.co'], ['AIR-KR-26-002', '블루', '']] };

  it('builds a one-time xlsx download link and keeps the contents out of the chat', async () => {
    const ema = fakeEma({ exportRegistryRows: async () => exported });
    const { store } = await connect({ ema, now: () => Date.parse('2026-10-13T00:00:00Z') });
    const { json } = await call('ema_registry_export', { sectorCode: 'AIR' });
    expect(ema.call).toHaveBeenCalledWith('exportRegistryRows', { filters: { sectorCode: 'AIR' } });
    expect(json).toMatchObject({ total: 2, fileName: 'EMA-기업등록-2026-10-13.xlsx', singleUse: true, expiresInMinutes: 15 });
    expect(json.downloadUrl).toMatch(/^https:\/\/ema-mcp\.myscguard\.app\/files\/[A-Za-z0-9_-]{20,}$/);
    expect(JSON.stringify(json)).not.toContain('a@b.co');

    const token = json.downloadUrl.split('/').pop();
    const file = await store.takeFile(token);
    const sheet = readXlsx(new Uint8Array(file.bytes));
    expect(sheet.headers).toEqual(exported.headers);
    expect(sheet.rows[0]).toMatchObject({ FRN: 'AIR-KR-26-001', 이메일: 'a@b.co' });
    expect(await store.takeFile(token)).toBeNull();
  });

  it('can produce CSV instead', async () => {
    const { store } = await connect({ ema: fakeEma({ exportRegistryRows: async () => exported }) });
    const { json } = await call('ema_registry_export', { format: 'csv' });
    const file = await store.takeFile(json.downloadUrl.split('/').pop());
    expect(file.contentType).toContain('text/csv');
    expect(new TextDecoder().decode(file.bytes)).toContain('AIR-KR-26-001,에코랩,a@b.co');
  });
});

describe('bulk import', () => {
  const previewItems = [
    { index: 0, rowNumber: 1, status: 'new', action: 'create', record: { displayName: '새기업', routeType: 'COLD_CALL' }, errors: [], warnings: ['섹터가 비어 GEN으로 등록합니다.'], match: null },
    { index: 1, rowNumber: 2, status: 'match', action: 'link', record: { displayName: '에코랩', routeType: 'COLD_CALL' }, errors: [], warnings: [], match: { frn: 'AIR-KR-26-001', name: '에코랩', matchField: 'displayIdentityKey' } },
    { index: 2, rowNumber: 3, status: 'invalid', action: 'skip', record: { displayName: '' }, errors: ['기업명 또는 법인명이 필요합니다.'], warnings: [], match: null },
  ];
  const previewResponse = { generatedAt: 'now', summary: { rowCount: 3, counts: { new: 1, match: 1, invalid: 1 }, willCreate: 1, willLink: 1, willSkip: 1, unknownColumns: [] }, items: previewItems };

  it('previews rows sent from the chat without registering and keeps the batch for the commit', async () => {
    const ema = fakeEma({ previewRegistryImport: async () => previewResponse });
    const { store } = await connect({ ema });
    const { json } = await call('ema_registry_import_preview', {
      rows: [{ 기업명: '새기업' }, { 기업명: '에코랩' }, { 기업명: '' }], routeType: 'COLD_CALL',
    });
    expect(ema.call).toHaveBeenCalledWith('previewRegistryImport', { rows: [{ 기업명: '새기업' }, { 기업명: '에코랩' }, { 기업명: '' }], defaults: { routeType: 'COLD_CALL' } });
    expect(json.summary.willCreate).toBe(1);
    expect(json.problems.map((row) => row.status)).toEqual(['match', 'invalid']);
    expect(json.problems[0]).toMatchObject({ sheetRow: 2, matchFrn: 'AIR-KR-26-001' });
    expect(json.newRows).toHaveLength(1);
    expect(json.next).toContain('ema_registry_import_commit');
    expect(await store.loadBatch(json.batchId, 'u1')).toMatchObject({ source: 'chat' });
    expect(await store.loadBatch(json.batchId, 'someone-else')).toBeNull();
  });

  it('requires either an uploaded batch or rows, and a known batch', async () => {
    await connect({ ema: fakeEma() });
    expect((await call('ema_registry_import_preview', {})).isError).toBe(true);
    const missing = await call('ema_registry_import_preview', { batchId: 'does-not-exist-1' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('배치');
  });

  it('commits in chunks, excludes chosen rows, and a second call does not redo finished rows', async () => {
    const committed = [];
    const ema = fakeEma({
      previewRegistryImport: async () => previewResponse,
      commitRegistryImport: async ({ rows }) => {
        committed.push(rows.map((row) => `${row.index}:${row.action}`));
        return { results: rows.map((row) => (row.action === 'skip'
          ? { index: row.index, status: 'skipped', name: '' }
          : { index: row.index, status: row.action === 'create' ? 'created' : 'linked', frn: row.action === 'create' ? 'AIR-KR-26-002' : 'AIR-KR-26-001', name: '' })) };
      },
    });
    await connect({ ema });
    const { json: preview } = await call('ema_registry_import_preview', { rows: [{ 기업명: 'a' }, { 기업명: 'b' }, { 기업명: '' }], routeType: 'COLD_CALL' });

    const first = (await call('ema_registry_import_commit', { batchId: preview.batchId, excludeRows: [2] })).json;
    expect(committed[0]).toEqual(['0:create', '1:skip', '2:skip']);
    expect(first).toMatchObject({ status: 'done', remaining: 0, counts: { created: 1, skipped: 2 } });
    expect(first.created[0]).toMatchObject({ sheetRow: 1, frn: 'AIR-KR-26-002' });
    expect(ema.call).toHaveBeenCalledWith('commitRegistryImport', expect.objectContaining({ awardCredits: false }));

    const again = (await call('ema_registry_import_commit', { batchId: preview.batchId, excludeRows: [2] })).json;
    expect(committed).toHaveLength(1);
    expect(again).toMatchObject({ status: 'done', counts: { created: 1, skipped: 2 } });
  });

  it('web confirm link registers nothing until the button is pressed, then commits once', async () => {
    const committed = [];
    const ema = fakeEma({
      previewRegistryImport: async () => previewResponse,
      commitRegistryImport: async ({ rows }) => {
        committed.push(rows.map((row) => row.action));
        return { results: rows.map((row) => ({ index: row.index, status: row.action === 'create' ? 'created' : 'skipped', frn: 'AIR-KR-26-002', name: '모닥불' })) };
      },
    });
    const { store } = await connect({ ema });
    const { json: preview } = await call('ema_registry_import_preview', { rows: [{ 기업명: 'a' }, { 기업명: 'b' }, { 기업명: '' }], routeType: 'COLD_CALL' });
    const { json: link } = await call('ema_registry_import_confirm_link', { batchId: preview.batchId });
    expect(link.confirmUrl).toMatch(/^https:\/\/ema-mcp\.myscguard\.app\/confirm\/[A-Za-z0-9_-]{20,}$/);
    expect(committed).toHaveLength(0);
    const token = link.confirmUrl.split('/').pop();
    const options = { store, ema, token, runCommit: (o) => runImportCommit({ ...o, store }) };

    const shown = await handleConfirm(new Request(link.confirmUrl), options);
    expect(shown.status).toBe(200);
    expect(await shown.text()).toContain('등록 확정');
    expect(committed).toHaveLength(0);

    const done = await handleConfirm(new Request(link.confirmUrl, { method: 'POST' }), options);
    expect(await done.text()).toContain('등록을 마쳤습니다');
    expect(committed).toHaveLength(1);
    const reused = await handleConfirm(new Request(link.confirmUrl, { method: 'POST' }), options);
    expect(reused.status).toBe(410);
    expect(committed).toHaveLength(1);
  });

  it('confirm link is refused for another member batch, an unknown batch and an almost-expired login', async () => {
    const { store } = await connect({ ema: fakeEma({ previewRegistryImport: async () => previewResponse }) });
    const foreign = await store.createBatch('someone-else', { source: 'chat', rows: [{ 기업명: 'x' }], rowNumbers: [1], preview: { summary: {}, items: [] } });
    expect((await call('ema_registry_import_confirm_link', { batchId: foreign })).isError).toBe(true);
    expect((await call('ema_registry_import_confirm_link', { batchId: 'does-not-exist-1' })).isError).toBe(true);
    await expect(store.createConfirmLink({ uid: 'u1', batchId: 'b', excludeRows: [], idToken: 't', idTokenExpiresAt: Date.now() + 40_000 })).rejects.toThrow('유효 시간');
  });

  it('refuses to commit without a preview, and reports a mid-way failure so it can be resumed', async () => {
    let calls = 0;
    const many = Array.from({ length: 60 }, (_, index) => ({ index, rowNumber: index + 1, status: 'new', action: 'create', record: { displayName: `기업${index}`, routeType: 'COLD_CALL' }, errors: [], warnings: [], match: null }));
    const ema = fakeEma({
      previewRegistryImport: async () => ({ generatedAt: 'now', summary: { rowCount: 60, counts: { new: 60 }, willCreate: 60, willLink: 0, willSkip: 0, unknownColumns: [] }, items: many }),
      commitRegistryImport: async ({ rows }) => {
        calls += 1;
        if (calls === 2) throw new Error('EMA 서버 오류');
        return { results: rows.map((row) => ({ index: row.index, status: 'created', frn: `AIR-KR-26-${row.index}`, name: '' })) };
      },
    });
    const { store } = await connect({ ema });
    const unpreviewed = await store.createBatch('u1', { source: 'chat', rows: [{ 기업명: 'x' }], rowNumbers: [1] });
    expect((await call('ema_registry_import_commit', { batchId: unpreviewed })).isError).toBe(true);

    const { json: preview } = await call('ema_registry_import_preview', { rows: many.map((_, index) => ({ 기업명: `기업${index}` })), routeType: 'COLD_CALL' });
    const partial = (await call('ema_registry_import_commit', { batchId: preview.batchId })).json;
    expect(partial).toMatchObject({ status: 'in_progress', remaining: 35, counts: { created: 25 } });
    expect(partial.error).toContain('EMA');
    const resumed = (await call('ema_registry_import_commit', { batchId: preview.batchId })).json;
    expect(resumed).toMatchObject({ status: 'done', remaining: 0, counts: { created: 60 } });
    expect(calls).toBe(4);
  });

  it('stops after the time budget and tells the caller to continue', async () => {
    let clock = 0;
    const many = Array.from({ length: 80 }, (_, index) => ({ index, rowNumber: index + 1, status: 'new', action: 'create', record: { displayName: `기업${index}`, routeType: 'COLD_CALL' }, errors: [], warnings: [], match: null }));
    const ema = fakeEma({
      previewRegistryImport: async () => ({ generatedAt: 'now', summary: { rowCount: 80, counts: { new: 80 }, willCreate: 80, willLink: 0, willSkip: 0, unknownColumns: [] }, items: many }),
      commitRegistryImport: async ({ rows }) => { clock += 30_000; return { results: rows.map((row) => ({ index: row.index, status: 'created', frn: 'F', name: '' })) }; },
    });
    await connect({ ema, now: () => clock });
    const { json: preview } = await call('ema_registry_import_preview', { rows: many.map((_, index) => ({ 기업명: `기업${index}` })), routeType: 'COLD_CALL' });
    const result = (await call('ema_registry_import_commit', { batchId: preview.batchId })).json;
    expect(result.status).toBe('in_progress');
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.retry).toContain('다시 호출');
  });

  it('tells the AI the form is just company, founder and sector, with no route question', async () => {
    await connect({ ema: fakeEma() });
    const instructions = client.getInstructions();
    expect(instructions).toContain('기업명, 대표자/창업자, 섹터');
    expect(instructions).toContain('발굴 경로는 자동');
    expect(instructions).toContain('ema_registry_import_template');
  });

  it('serves a template workbook with only the form fields, dropdowns and a sector code sheet', async () => {
    const { store } = await connect({ ema: fakeEma() });
    const { json } = await call('ema_registry_import_template');
    expect(json.columns).toEqual(['기업명', '대표자/창업자', '섹터', '지역', '국가(해외만)']);
    expect(json.downloadUrl).toMatch(/^https:\/\/ema-mcp\.myscguard\.app\/files\/[A-Za-z0-9_-]{20,}$/);
    const file = await store.takeFile(json.downloadUrl.split('/').pop());
    expect(file.name).toMatch(/\.xlsx$/);
    const text = new TextDecoder('utf-8').decode(unzipSync(new Uint8Array(file.bytes))['xl/worksheets/sheet1.xml']);
    expect(text).toContain('type="list"');
    expect(text).toContain('국내,해외');
    expect(Object.keys(unzipSync(new Uint8Array(file.bytes)))).toContain('xl/worksheets/sheet2.xml');
  });

  it('hands out a one-time upload link bound to the signed-in member', async () => {
    const { store } = await connect({ ema: fakeEma() });
    const { json } = await call('ema_registry_import_upload_link');
    expect(json.uploadUrl).toMatch(/^https:\/\/ema-mcp\.myscguard\.app\/upload\/[A-Za-z0-9_-]{20,}$/);
    expect(await store.readUpload(json.uploadUrl.split('/').pop())).toEqual({ uid: 'u1' });
  });
});
