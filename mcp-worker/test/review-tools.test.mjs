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
  it('registers six read-only, described tools only when a text store and uid are given', async () => {
    await connect();
    const tools = (await client.listTools()).tools.filter((tool) => tool.name.startsWith('project_review') || tool.name.startsWith('project_attachment') || tool.name === 'project_submission_get');
    expect(tools.map((tool) => tool.name).sort()).toEqual(['project_attachment_page', 'project_attachment_text', 'project_review_check', 'project_review_playbook', 'project_review_queue', 'project_submission_get']);
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
    // 쪽 넘김(textRef)은 캐시만 본다. 검토 문서도, 텍스트 엔드포인트(PDF 재파싱)도 다시 부르지 않는다(2차 리뷰 #2).
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

  it('directs scanned documents to the page tool without requiring another upload', async () => {
    await connect({ bff: fakeBff({ '/api/v1/project-requests/r1/attachments/contract/text': () => ({ kind: 'contract', name: 'scan.pdf', sha256: SHA, pageCount: 1, pages: [''], quality: 'sparse' }) }) });
    const { json } = await call('project_attachment_text', { subject, kind: 'contract' });
    expect(json).toMatchObject({ quality: 'sparse', text: '' });
    expect(json.guidance).toContain('attachment_image');
    expect(json.imageFallback).toEqual({ tool: 'project_attachment_page', arguments: { subject, kind: 'contract', page: 1, expectedSha256: SHA } });
  });

  it('returns an image block with a pinned continuation and checks permission on every page', async () => {
    const body = { name: 'scan.pdf', sha256: SHA, page: 1, pageCount: 2, mimeType: 'image/jpeg', data: '/9j/2Q==' };
    const bff = fakeBff({ '/api/v1/project-requests/r1/attachments/rfp_request_evidence/text': () => body });
    await connect({ bff });
    const args = { subject, kind: 'rfp_request_evidence', page: 1, expectedSha256: SHA };
    const result = await call('project_attachment_page', args);
    expect(result.isError).not.toBe(true);
    expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: body.data });
    expect(result._meta.provenance.untrusted_content).toBe(true);
    expect(result.json).toMatchObject({ evidence: 'unverified', source: 'attachment_image', continuation: { arguments: { page: 2, expectedSha256: SHA } } });
    expect(result.content[0].text).not.toContain(body.data);
    expect(bff.get).toHaveBeenCalledWith('/api/v1/project-requests/r1/attachments/rfp_request_evidence/text', { format: 'image', page: 1 }, { maxBytes: 3 * 1024 * 1024 });
    body.sha256 = 'd'.repeat(64);
    expect((await call('project_attachment_page', args)).isError).toBe(true);
    bff.get.mockRejectedValue(new BffError(403, { code: 'forbidden' }));
    const denied = await call('project_attachment_page', args);
    expect(denied.isError).toBe(true);
    expect(denied.content.some((item) => item.type === 'image')).toBe(false);
  });

  it('does not certify image readings as verified text evidence', async () => {
    await connect();
    const result = await call('project_review_check', { subject, extractions: [{ kind: 'contract', source: 'attachment_image', fields: amount }] });
    expect(result.json.findings.find((item) => item.field === 'contractAmount')).toMatchObject({ status: 'check', evidence: 'unverified' });
    expect(result.json.limitations.join(' ')).toContain('원문 쪽 이미지');
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
    expect(json.unknowns.some((item) => item.question.includes('바뀌었거나'))).toBe(true);
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

  describe('code review fixes', () => {
    it('does not reuse a textRef from another subject (review #1)', async () => {
      const otherPayload = { ...payload, contractDocument: { path: 'orgs/mysc/project-registration-documents/p2/c2.pdf', name: '다른 계약서.pdf' } };
      const bff = fakeBff({
        '/api/v1/projects/p2/review-document': () => ({ request: { requestKind: 'REGISTRATION', payload: otherPayload }, reviewToken: 'tok-2' }),
        '/api/v1/project-requests/r2/attachments/contract/text': () => ({ kind: 'contract', name: '다른 계약서.pdf', sha256: 'e'.repeat(64), pageCount: 1, pages: ['다른 계약서 본문 총 계약금액 ₩120,000,000'], quality: 'ok' }),
      });
      await connect({ bff });
      await call('project_attachment_text', { subject, kind: 'contract' });
      // p1 의 textRef 를 p2 대조에 넘김 → p2 의 실제 첨부를 받아 해시가 달라 판정하지 않는다.
      const { json } = await call('project_review_check', { subject: { type: 'request', projectId: 'p2', requestId: 'r2' }, extractions: [extraction(amount)] });
      expect(json.findings.filter((item) => item.documentKind === 'contract')).toEqual([]);
      expect(json.coverage.find((item) => item.kind === 'contract').status).toBe('unknown');
    });

    it('does not reuse the cache after the author replaced the attachment (review #1)', async () => {
      let currentPath = 'orgs/mysc/project-registration-documents/p1/c.pdf';
      let currentSha = SHA;
      const bff = fakeBff({
        '/api/v1/projects/p1/review-document': () => ({ request: { requestKind: 'REGISTRATION', payload: { ...payload, contractDocument: { path: currentPath, name: '계약서.pdf' } } }, reviewToken: 'tok-1' }),
        '/api/v1/project-requests/r1/attachments/contract/text': () => ({ kind: 'contract', name: '계약서.pdf', sha256: currentSha, pageCount: 2, pages: contractPages, quality: 'ok' }),
      });
      await connect({ bff });
      await call('project_attachment_text', { subject, kind: 'contract' });
      currentPath = 'orgs/mysc/project-registration-documents/p1/new.pdf';
      currentSha = 'f'.repeat(64);
      const { json } = await call('project_review_check', { subject, extractions: [extraction(amount)] });
      expect(json.coverage.find((item) => item.kind === 'contract').status).toBe('unknown');
    });

    it('reports a scanned document once as unreadable instead of a missing quote per field (review #5)', async () => {
      await connect({ bff: fakeBff({ '/api/v1/project-requests/r1/attachments/contract/text': () => ({ kind: 'contract', name: 'scan.pdf', sha256: SHA, pageCount: 1, pages: [''], quality: 'sparse' }) }) });
      const { json } = await call('project_review_check', { subject, extractions: [extraction(amount)] });
      const unknowns = json.unknowns.filter((item) => item.kind === 'contract');
      expect(unknowns).toHaveLength(1);
      expect(unknowns[0].resolveBy).toContain('대화에 첨부');
    });

    it('delivers every character of a page longer than one response (review #4)', async () => {
      const long = `${'가'.repeat(90_000)}끝문장 총 계약금액 ₩110,000,000`;
      await connect({ bff: fakeBff({ '/api/v1/project-requests/r1/attachments/contract/text': () => ({ kind: 'contract', name: 'long.pdf', sha256: SHA, pageCount: 1, pages: [long], quality: 'ok' }) }) });
      let args = { subject, kind: 'contract' };
      let collected = '';
      for (let guard = 0; guard < 10 && args; guard += 1) {
        const { json } = await call('project_attachment_text', args);
        collected += json.text.replace(/\[p\.1( 이어서)?\]\n/gu, '');
        args = json.continuation?.arguments;
      }
      expect(collected).toBe(long);
    });

    it('keeps the attachment path out of what the AI sees', async () => {
      await connect();
      const { json } = await call('project_submission_get', { subject });
      expect(JSON.stringify(json)).not.toContain('orgs/mysc/');
      expect(json.attachments.find((item) => item.kind === 'contract')).toEqual({ kind: 'contract', present: true, name: '계약서.pdf' });
    });

    it('gives a different review id when the extracted inputs differ (review #8)', async () => {
      await connect();
      await call('project_attachment_text', { subject, kind: 'contract' });
      const a = await call('project_review_check', { subject, extractions: [extraction(amount)] });
      const b = await call('project_review_check', { subject, extractions: [extraction({ ...amount, contractStart: { value: '2026. 3. 1.', quote: '계약기간: 2026. 3. 1. ~ 2026. 12. 31.' } })] });
      const a2 = await call('project_review_check', { subject, extractions: [extraction(amount)] });
      expect(b.json.review.reviewId).not.toBe(a.json.review.reviewId);
      expect(a2.json.review.reviewId).toBe(a.json.review.reviewId);
      expect(a.json.review.identity.inputsDigest).toMatch(/^i_[0-9a-f]{24}$/);
    });

    it('reports draft list failures instead of pretending there are no drafts (review #10)', async () => {
      await connect({ bff: fakeBff({ '/api/v1/project-registration-drafts': () => { throw new BffError(504, { code: 'timeout' }, { retryable: true }); } }) });
      const failed = await call('project_review_queue');
      expect(failed.isError).toBe(true);
      expect(failed.json.error.retryable).toBe(true);
      await client.close();
      await connect({ bff: fakeBff({ '/api/v1/project-registration-drafts': () => { throw new BffError(403, { code: 'forbidden' }); } }) });
      const denied = await call('project_review_queue');
      expect(denied.json.drafts).toEqual([]);
      expect(denied.json.requests).toHaveLength(1);
    });

    it('gives the same review id when extractions arrive in a different order (2nd #6)', async () => {
      await connect({ bff: fakeBff({ '/api/v1/projects/p1/review-document': () => ({ request: { requestKind: 'REGISTRATION', payload: { ...payload, quoteDocument: { path: 'orgs/mysc/project-registration-documents/p1/q.pdf', name: 'q.pdf' } } }, reviewToken: 'tok-1' }) }) });
      const quoteExtraction = { kind: 'quote', source: 'chat_attachment', fields: { totalAmount: { value: '110,000,000', quote: '합계 110,000,000원' } } };
      const a = await call('project_review_check', { subject, extractions: [extraction(amount, { source: 'chat_attachment', textRef: undefined }), quoteExtraction] });
      const b = await call('project_review_check', { subject, extractions: [quoteExtraction, extraction(amount, { source: 'chat_attachment', textRef: undefined })] });
      expect(b.json.review.reviewId).toBe(a.json.review.reviewId);
    });

    it('never splits a surrogate pair at a window boundary (2nd #8)', async () => {
      // 헤더 "[p.1]\n"(6자) 뒤 예산 39,994자 안에서, 이모지 쌍이 정확히 경계에 걸치도록 홀수 위치에서 시작한다.
      const page = `${'가'.repeat(39_991)}${'😀'.repeat(40)}끝`;
      await connect({ bff: fakeBff({ '/api/v1/project-requests/r1/attachments/contract/text': () => ({ kind: 'contract', name: 'e.pdf', sha256: SHA, pageCount: 1, pages: [page], quality: 'ok' }) }) });
      let args = { subject, kind: 'contract' };
      let collected = '';
      for (let guard = 0; guard < 10 && args; guard += 1) {
        const { json } = await call('project_attachment_text', args);
        // 응답 하나하나에 짝 없는 서로게이트가 없어야 한다(이어 붙이면 원래대로 보여도 각 응답은 깨진 문자열).
        expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(json.text)).toBe(false);
        collected += json.text.replace(/\[p\.1( 이어서)?\]\n/gu, '');
        args = json.continuation?.arguments;
      }
      expect(collected).toBe(page);
    });

    it('restarts from the first page when the document changed between continuations (2nd #8)', async () => {
      await connect({ bff: fakeBff({ '/api/v1/project-requests/r1/attachments/contract/text': () => ({ kind: 'contract', name: 'n.pdf', sha256: 'f'.repeat(64), pageCount: 2, pages: ['새 1쪽 내용입니다', '새 2쪽 내용입니다'], quality: 'ok' }) }) });
      const { json } = await call('project_attachment_text', { subject, kind: 'contract', textRef: SHA, from: 2, offset: 3 });
      expect(json).toMatchObject({ pages: '1-2', notice: expect.stringContaining('바뀌었습니다') });
      expect(json.text.startsWith('[p.1]\n새 1쪽')).toBe(true);
    });

    it('gives the same review id for same-kind, same-source extractions in either order (3rd #6)', async () => {
      await connect();
      const first = { kind: 'contract', source: 'connector', fields: { contractAmount: { value: '110,000,000', quote: '총액 110,000,000원' } } };
      const second = { kind: 'contract', source: 'connector', fields: { clientOrg: { value: '가상테스트재단', quote: '발주: 가상테스트재단' } } };
      const a = await call('project_review_check', { subject, extractions: [first, second] });
      const b = await call('project_review_check', { subject, extractions: [second, first] });
      expect(b.json.review.reviewId).toBe(a.json.review.reviewId);
    });

    it('never starts a window in the middle of a surrogate pair (3rd #9)', async () => {
      await connect({ bff: fakeBff({ '/api/v1/project-requests/r1/attachments/contract/text': () => ({ kind: 'contract', name: 'e.pdf', sha256: SHA, pageCount: 1, pages: ['😀😀😀 끝'], quality: 'ok' }) }) });
      await call('project_attachment_text', { subject, kind: 'contract' });
      const { json } = await call('project_attachment_text', { subject, kind: 'contract', textRef: SHA, offset: 1 });
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(json.text)).toBe(false);
    });
  });
});
