import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createEmaMcpServer } from '../src/ema/tools.mjs';
import { validateNewsRange, projectNewsSnapshot } from '../src/ema/news-tools.mjs';

const NOW = Date.parse('2026-10-19T03:00:00Z');
const RANGE = { from: '2026-10-01', to: '2026-10-19' };
let client;
afterEach(async () => { await client?.close(); client = undefined; });
const story = () => ({
  id: 'a1', title: '검증 기업 뉴스', url: 'https://platum.kr/archives/1', publisher: '플래텀', sourceId: 'platum',
  publishedAt: '2026-10-18T03:00:00Z', summary: '검증 요약',
  analysis: { evidenceText: 'INTERNAL' }, contactEmail: 'PRIVATE',
  companies: [{ key: 'company:c1', name: '검증 기업', programIds: ['p1'], programNames: ['검증 사업'],
    contactEmail: 'PRIVATE', businessSummary: 'PRIVATE', frn: 'UNVERIFIED' }],
  relations: [{ key: 'company:c1', evidenceText: 'INTERNAL', events: [{ type: 'innovation', status: 'confirmed', partners: ['협력사'], amount: { kind: 'unknown', text: '' }, evidenceText: 'INTERNAL' }] }],
});
const response = (inbox = [story()]) => ({ source: 'publishers', period: { ...RANGE, timezone: 'Asia/Seoul', asOf: new Date(NOW).toISOString() }, inbox,
  inboxTruncated: false, directory: [{ name: 'GLOBAL DIRECTORY MUST NOT LEAK' }], rawError: 'INTERNAL' });

async function connect(ema, canExportAndImport = true, canReadNews = true) {
  const server = createEmaMcpServer({ ema, store: {}, publicOrigin: 'https://example.test', access: { uid: 'u1', role: 'admin', canExportAndImport, canReadNews }, now: () => NOW });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  client = new Client({ name: 'news-test', version: '1' });
  await client.connect(a);
}
const call = () => client.callTool({ name: 'ema_news_read', arguments: RANGE });

describe('EMA newsletter reader adapter', () => {
  it('news-only grants expose no registry or writing tools', async () => {
    const server = createEmaMcpServer({ ema: { call: vi.fn() }, store: {}, publicOrigin: 'https://example.test', access: { uid:'u',role:'admin',canExportAndImport:true,canReadNews:true,canReadRegistry:false }, now:()=>NOW });
    const [a,b]=InMemoryTransport.createLinkedPair(); await server.connect(b);
    client=new Client({name:'news-only-test',version:'1'});await client.connect(a);
    expect((await client.listTools()).tools.map(t=>t.name)).toEqual(['ema_news_read']);
    expect((await client.callTool({name:'ema_registry_import_commit',arguments:{batchId:'x'}})).isError).toBe(true);
  });

  it('accepts inclusive KST 31 days and validates real dates, reversed, future and 32-day ranges before reading', () => {
    expect(validateNewsRange({ from: '2026-09-19', to: '2026-10-19' }, NOW).start).toBe(Date.parse('2026-09-18T15:00:00Z'));
    for (const args of [{ from: '2026-09-18', to: '2026-10-19' }, { from: '2026-02-29', to: '2026-03-01' },
      { from: '2026-10-19', to: '2026-10-18' }, { from: '2026-10-19', to: '2026-10-20' }, { from: 'bad', to: '2026-10-19' }]) {
      expect(() => validateNewsRange(args, NOW)).toThrow();
    }
  });
  it('hides the tool unless the existing admin capability is strictly true even with a mocked news grant', async () => {
    for (const capability of [false, 'true', undefined]) {
      await connect({ call: vi.fn() }, capability === undefined ? null : capability);
      expect((await client.listTools()).tools.some((t) => t.name === 'ema_news_read')).toBe(false);
      await client.close();
    }
  });
  it('does not expose news for any existing registry-only grant, including administrators', async () => {
    for (const newsGrant of [undefined, null, false, 'true', 1]) {
      const ema = { call: vi.fn() };
      const server = createEmaMcpServer({ ema, store: {}, publicOrigin: 'https://example.test',
        access: { uid: 'u1', role: 'admin', canExportAndImport: true, ...(newsGrant === undefined ? {} : { canReadNews: newsGrant }) }, now: () => NOW });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      client = new Client({ name: 'existing-grant-test', version: '1' });
      await client.connect(a);
      expect((await client.listTools()).tools.some((t) => t.name === 'ema_news_read')).toBe(false);
      const denied = await call();
      expect(denied.isError).toBe(true);
      expect(ema.call).not.toHaveBeenCalled();
      await client.close();
    }
  });
  it('calls only the signed-in existing callable with an explicit mocked news grant and exposes a read-only tool', async () => {
    const ema = { call: vi.fn(async () => response()) };
    await connect(ema);
    const definition = (await client.listTools()).tools.find((t) => t.name === 'ema_news_read');
    expect(definition.annotations.readOnlyHint).toBe(true);
    const output = await call();
    expect(output.isError).not.toBe(true);
    expect(ema.call).toHaveBeenCalledExactlyOnceWith('getAdminLabNews', { source: 'publishers', period: 'custom', ...RANGE });
    const data = JSON.parse(output.content[0].text);
    expect(data).toMatchObject({ status: 'ok', sendEligible: false, coverage: { sourceHealth: 'unknown', savedCorpusCompleteness: 'unknown' } });
    expect(data.articles[0].relations[0].events[0].type).toBe('innovation');
    expect(data.articles[0].companies[0]).toMatchObject({ currentProgramNames: ['검증 사업'], portfolio: { status: 'not_queried' } });
    expect(data.articles[0].companies[0]).not.toHaveProperty('frn');
    expect(JSON.stringify(data)).not.toMatch(/PRIVATE|INTERNAL|UNVERIFIED|GLOBAL DIRECTORY/);
  });
  it('does not leak backend details or bypass permission denial', async () => {
    const ema = { call: vi.fn(async () => { throw Object.assign(new Error('token=SECRET email=PRIVATE'), { code: 'PERMISSION_DENIED' }); }) };
    await connect(ema);
    const output = await call();
    expect(output.isError).toBe(true);
    expect(output.content[0].text).toContain('PERMISSION_DENIED');
    expect(output.content[0].text).not.toMatch(/SECRET|PRIVATE/);
    expect(ema.call).toHaveBeenCalledTimes(1);
  });
  it('distinguishes no stored matches from source failure or complete corpus', () => {
    expect(projectNewsSnapshot(response([]), validateNewsRange(RANGE, NOW))).toMatchObject({ status: 'no_matches_in_saved_corpus', coverage: { sourceHealth: 'unknown', savedCorpusCompleteness: 'unknown' }, sendEligible: false });
  });
  it('does not silently truncate 101 articles; requires narrower range and returns no article subset', () => {
    const output = projectNewsSnapshot(response(Array.from({ length: 101 }, story)), validateNewsRange(RANGE, NOW));
    expect(output).toMatchObject({ status: 'partial', articles: [], coverage: { receivedCount: 101, narrowRangeRequired: true }, sendEligible: false });
  });
  it('flags filtered out-of-range, non-publisher and invalid articles and any backend truncation', () => {
    const bad = [{ ...story(), sourceId: 'google-news' }, { ...story(), publishedAt: '2026-09-30T14:59:59Z' }, { ...story(), url: 'https://user:password@example.test' }, { ...story(), relations: [] }];
    const output = projectNewsSnapshot(response([story(), ...bad]), validateNewsRange(RANGE, NOW));
    expect(output).toMatchObject({ status: 'partial', coverage: { rejectedCount: 4 }, articles: [expect.objectContaining({ id: 'a1' })] });
    expect(projectNewsSnapshot({ ...response(), inboxTruncated: true }, validateNewsRange(RANGE, NOW)).status).toBe('partial');
  });
  it('rejects mixed or old reader contracts rather than inventing asOf and range', () => {
    for (const result of [{ ...response(), source: 'google' }, { ...response(), period: {} }, { ...response(), inbox: undefined }]) {
      expect(() => projectNewsSnapshot(result, validateNewsRange(RANGE, NOW))).toThrow();
    }
  });
});
