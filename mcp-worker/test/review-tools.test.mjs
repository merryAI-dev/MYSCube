import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BffError } from '../src/bff.mjs';
import { createTextStore } from '../src/review/text-store.mjs';
import { createMyscubeMcpServer } from '../src/tools.mjs';
import { memoryKv } from './ema-support.mjs';

const SHA = 'c'.repeat(64);
const contractPages = [
  '용역 계약서\n사업명: 2026년 청년 창업 지원 운영 용역\n발주기관: 재단법인 가상테스트재단\n계약기간: 2026. 3. 1. ~ 2026. 12. 31.\n총 계약금액: 금 일억이천만원정(₩120,000,000, 부가가치세 포함)',
  '제5조(대금의 지급) 잔금: 120,000,000원',
];
const payload = {
  name: '청년 창업', officialContractName: '2026 청년 창업 지원 운영 용역', clientOrg: '가상테스트재단', currency: 'KRW',
  contractStart: '2026-03-01', contractEnd: '2026-12-31', contractAmount: 110_000_000,
  contractDocument: { path: 'orgs/mysc/project-registration-documents/p1/c.pdf', name: '계약서.pdf' },
};
const subject = { type: 'request', projectId: 'p1', requestId: 'r1' };

function fakeBff(overrides = {}) {
  const routes = {
    '/api/v1/projects/p1/review-document': () => ({ request: { requestKind: 'REGISTRATION', payload }, reviewToken: 'tok-1', readiness: { issues: [] } }),
    '/api/v1/project-requests/r1/attachments/contract/text': () => ({ kind: 'contract', name: '계약서.pdf', sha256: SHA, pageCount: 2, pages: contractPages, quality: 'ok' }),
    '/api/v1/project-requests/assigned-to-me': () => ({ items: [{ id: 'r1', targetProjectId: 'p1', requestKind: 'REGISTRATION', status: 'PENDING', payload: { name: '청년 창업' }, createdAt: '2026-10-10' }] }),
    '/api/v1/project-registration-drafts': () => ({ drafts: [{ draftId: 'd1', name: '작성 중 사업', updatedAt: '2026-10-11' }] }),
    ...overrides,
  };
  return { get: vi.fn(async (path, _query, options) => {
    const route = routes[path];
    if (!route) throw new BffError(404, { code: 'not_found' });
    return route(options);
  }) };
}

let client;
afterEach(async () => { await client?.close(); client = undefined; });

async function connect({ bff = fakeBff(), kv = memoryKv(), uid = 'u1' } = {}) {
  const server = createMyscubeMcpServer({ bff, textStore: createTextStore(kv), uid });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'review-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { bff, kv };
}
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { ...result, json: JSON.parse(result.content[0].text) };
};
const extraction = (fields, extra = {}) => ({ kind: 'contract', source: 'attachment_text', textRef: SHA, fields, ...extra });
const amount = { contractAmount: { value: '120,000,000', quote: '(₩120,000,000, 부가가치세 포함)' } };

describe('project review tools', () => {
  it('registers five read-only, described tools only when a text store and uid are given', async () => {
    await connect();
    const tools = (await client.listTools()).tools.filter((tool) => tool.name.startsWith('project_review') || tool.name.startsWith('project_attachment') || tool.name === 'project_submission_get');
    expect(tools.map((tool) => tool.name).sort()).toEqual(['project_attachment_text', 'project_review_check', 'project_review_playbook', 'project_review_queue', 'project_submission_get']);
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.description.length).toBeGreaterThan(40);
      for (const property of Object.values(tool.inputSchema.properties || {})) expect(property.description).toBeTruthy();
    }
    await client.close();
    const plain = createMyscubeMcpServer({ bff: fakeBff() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await plain.connect(b);
    client = new Client({ name: 'plain', version: '1.0.0' });
    await client.connect(a);
    expect((await client.listTools()).tools.some((tool) => tool.name.startsWith('project_review'))).toBe(false);
  });

  it('lists my review queue as ready-to-use subjects', async () => {
    await connect();
    const { json } = await call('project_review_queue');
    expect(json.requests).toEqual([{ subject, projectName: '청년 창업', requestKind: 'REGISTRATION', status: 'PENDING', submittedAt: '2026-10-10' }]);
    expect(json.drafts[0].subject).toEqual({ type: 'registration_draft', draftId: 'd1' });
  });

  it('returns page-numbered text marked untrusted, caches it, and serves the next call from the cache', async () => {
    const { bff } = await connect();
    const first = await call('project_attachment_text', { subject, kind: 'contract' });
    expect(first._meta).toEqual({ provenance: { untrusted_content: true, source: 'project_document' } });
    expect(first.json).toMatchObject({ textRef: SHA, pageCount: 2, pages: '1-2', quality: 'ok' });
    expect(first.json.text).toContain('[p.2]\n제5조');
    expect(bff.get.mock.calls.find(([path]) => path.endsWith('/text'))[2]).toEqual({ maxBytes: 8 * 1024 * 1024 });
    bff.get.mockClear();
    await call('project_attachment_text', { subject, kind: 'contract', textRef: SHA });
    expect(bff.get).not.toHaveBeenCalled();
  });

  it('splits long documents and hands back a ready-to-call continuation', async () => {
    const big = ['가'.repeat(25_000), '나'.repeat(25_000), '다'.repeat(100)];
    await connect({ bff: fakeBff({ '/api/v1/project-requests/r1/attachments/contract/text': () => ({ kind: 'contract', name: 'big.pdf', sha256: SHA, pageCount: 3, pages: big, quality: 'ok' }) }) });
    const first = await call('project_attachment_text', { subject, kind: 'contract' });
    expect(first.json.pages).toBe('1-1');
    expect(first.json.continuation).toEqual({ tool: 'project_attachment_text', arguments: { subject, kind: 'contract', textRef: SHA, from: 2 } });
    const second = await call('project_attachment_text', first.json.continuation.arguments);
    expect(second.json.pages).toBe('2-3');
    expect(second.json.continuation).toBeUndefined();
  });

  it('tells the user to attach a scanned document to the chat instead of returning empty text', async () => {
    await connect({ bff: fakeBff({ '/api/v1/project-requests/r1/attachments/contract/text': () => ({ kind: 'contract', name: 'scan.pdf', sha256: SHA, pageCount: 1, pages: [''], quality: 'sparse' }) }) });
    const { json } = await call('project_attachment_text', { subject, kind: 'contract' });
    expect(json).toMatchObject({ quality: 'sparse', text: '' });
    expect(json.guidance).toContain('chat_attachment');
  });

  it('judges against the submission read fresh from MYSCube, with verified evidence and a reproducible review id', async () => {
    await connect();
    await call('project_attachment_text', { subject, kind: 'contract' });
    const { json } = await call('project_review_check', { subject, extractions: [extraction(amount)] });
    const finding = json.findings.find((item) => item.field === 'contractAmount');
    expect(finding).toMatchObject({ status: 'mismatch', submitted: '110,000,000원', document: '120,000,000원', evidence: 'verified', page: 1 });
    expect(json.review.identity).toMatchObject({ reviewToken: 'tok-1', extractor: 'bff-pdfjs@5.4.624', documents: [{ kind: 'contract', sha256: SHA, source: 'attachment_text' }] });
    expect(json.coverage.find((item) => item.kind === 'contract').status).toBe('partial');
    const again = await call('project_review_check', { subject, extractions: [extraction(amount)] });
    expect(again.json.review.reviewId).toBe(json.review.reviewId);
  });

  it('does not judge a quote that is not in the document', async () => {
    await connect();
    await call('project_attachment_text', { subject, kind: 'contract' });
    const { json } = await call('project_review_check', { subject, extractions: [extraction({ contractAmount: { value: '110,000,000', quote: '총 계약금액: 110,000,000원' } })] });
    expect(json.findings.find((item) => item.field === 'contractAmount')).toMatchObject({ status: 'check', evidence: 'not_found' });
    expect(json.summary.unknown).toBeGreaterThan(0);
  });

  it('refetches when the cache is gone and refuses to judge a document that changed since it was read', async () => {
    const kv = memoryKv();
    const bff = fakeBff({ '/api/v1/project-requests/r1/attachments/contract/text': () => ({ kind: 'contract', name: '계약서.pdf', sha256: 'd'.repeat(64), pageCount: 2, pages: contractPages, quality: 'ok' }) });
    await connect({ bff, kv });
    const { json } = await call('project_review_check', { subject, extractions: [extraction(amount)] });
    expect(json.coverage.find((item) => item.kind === 'contract').status).toBe('unknown');
    expect(json.unknowns.some((item) => item.question.includes('바뀌었습니다'))).toBe(true);
    expect(json.findings.filter((item) => item.documentKind === 'contract')).toEqual([]);
  });

  it('downgrades a mismatch read from a chat attachment to a check', async () => {
    await connect();
    const { json } = await call('project_review_check', { subject, extractions: [{ kind: 'contract', source: 'chat_attachment', fields: amount }] });
    expect(json.findings.find((item) => item.field === 'contractAmount')).toMatchObject({ status: 'check', evidence: 'unverified' });
  });

  it('turns BFF permission errors into one error shape with remediation, still marked untrusted on text tools', async () => {
    await connect({ bff: fakeBff({ '/api/v1/project-requests/r1/attachments/contract/text': () => { throw new BffError(403, { code: 'forbidden', message: 'Project attachment access denied' }); } }) });
    const result = await call('project_attachment_text', { subject, kind: 'contract' });
    expect(result.isError).toBe(true);
    expect(result.json.error).toMatchObject({ code: 'forbidden', retryable: false, remediation: expect.stringContaining('지정 결재자') });
    expect(result._meta?.provenance?.untrusted_content).toBe(true);
    const bad = await call('project_submission_get', { subject: { type: 'request', projectId: '../x', requestId: 'r1' } });
    expect(bad.json.error.code).toBe('invalid_request');
  });
});
