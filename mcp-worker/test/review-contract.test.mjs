import { describe, expect, it } from 'vitest';
import { buildReviewResult, coverageFor, hashId, RULES_VERSION, reviewError, stableJson } from '../src/review/contract.mjs';

const identity = {
  subject: { type: 'request', projectId: 'p1', requestId: 'r1' },
  reviewToken: 'tok-1',
  documents: [
    { kind: 'quote', sha256: 'b'.repeat(64), source: 'attachment_text' },
    { kind: 'contract', sha256: 'a'.repeat(64), source: 'attachment_text' },
  ],
  extractor: 'bff-pdfjs@5.4.624',
};
const finding = (over = {}) => ({ status: 'mismatch', documentKind: 'contract', field: 'contractAmount', label: '계약금액', submitted: '110,000,000원', document: '120,000,000원', quote: '총 계약금액: 120,000,000원', page: 1, evidence: 'verified', rule: 'amount.exact', message: '다름', ...over });
const fixedNow = () => '2026-10-14T00:00:00.000Z';

describe('review result contract', () => {
  it('serializes objects with sorted keys and drops undefined values', () => {
    expect(stableJson({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe('{"a":{"c":[2,1]},"b":1}');
  });

  it('gives the same review id for the same inputs, regardless of key or document order', async () => {
    const first = await buildReviewResult({ identity, now: fixedNow });
    const reordered = await buildReviewResult({
      identity: { ...identity, documents: [...identity.documents].reverse(), subject: { requestId: 'r1', projectId: 'p1', type: 'request' } },
      now: fixedNow,
    });
    expect(first.review.reviewId).toMatch(/^rv_[0-9a-f]{24}$/);
    expect(reordered.review.reviewId).toBe(first.review.reviewId);
    expect(first.review.identity.rulesVersion).toBe(RULES_VERSION);
  });

  it('changes the review id when a document, the request version or the rules change', async () => {
    const base = (await buildReviewResult({ identity })).review.reviewId;
    const changedDoc = { ...identity, documents: [{ ...identity.documents[0], sha256: 'c'.repeat(64) }, identity.documents[1]] };
    expect((await buildReviewResult({ identity: changedDoc })).review.reviewId).not.toBe(base);
    expect((await buildReviewResult({ identity: { ...identity, reviewToken: 'tok-2' } })).review.reviewId).not.toBe(base);
    expect((await buildReviewResult({ identity: { ...identity, rulesVersion: 'project-review-rules@2' } })).review.reviewId).not.toBe(base);
  });

  it('gives a finding the same id across reviews when its content is the same, ignoring the message wording', async () => {
    const a = await hashId('f', { documentKind: 'contract', field: 'contractAmount', rule: 'amount.exact', submitted: '1', document: '2', quote: 'q' });
    const result = await buildReviewResult({ identity, findings: [finding({ submitted: '1', document: '2', quote: 'q', message: '문구 A' })] });
    const again = await buildReviewResult({ identity: { ...identity, reviewToken: 'tok-9' }, findings: [finding({ submitted: '1', document: '2', quote: 'q', message: '문구 B' })] });
    expect(result.findings[0].findingId).toBe(a);
    expect(again.findings[0].findingId).toBe(a);
  });

  it('counts findings and unknowns and orders mismatches first', async () => {
    const result = await buildReviewResult({
      identity,
      findings: [finding({ status: 'match', field: 'clientOrg' }), finding(), finding({ status: 'check', field: 'contractEnd' })],
      unknowns: [{ kind: 'quote', question: '스캔본이라 금액 근거를 확인하지 못함', resolveBy: '대화에 파일 첨부' }],
      limitations: ['OCR 없음', 'OCR 없음'],
    });
    expect(result.summary).toEqual({ mismatch: 1, check: 1, match: 1, unknown: 1 });
    expect(result.findings.map((item) => item.status)).toEqual(['mismatch', 'check', 'match']);
    expect(result.unknowns[0].unknownId).toMatch(/^u_[0-9a-f]{24}$/);
    expect(result.limitations).toEqual(['OCR 없음']);
  });

  it('declares coverage so that "no problems" is never confused with "not checked"', () => {
    const expected = ['contractAmount', 'clientOrg', 'contractStart'];
    expect(coverageFor({ kind: 'contract', readable: true, expected, checked: expected }).status).toBe('complete');
    expect(coverageFor({ kind: 'contract', readable: true, expected, checked: ['contractAmount'], missing: [{ field: 'clientOrg', reason: '근거 없음' }] }))
      .toMatchObject({ status: 'partial', checkedFields: ['contractAmount'], missingFields: [{ field: 'clientOrg', reason: '근거 없음' }] });
    expect(coverageFor({ kind: 'contract', readable: false, expected, checked: [] }).status).toBe('unknown');
    expect(coverageFor({ kind: 'contract', readable: true, expected, checked: [] }).status).toBe('unknown');
    // 모든 필드를 봤어도 빠진 항목 보고가 있으면 complete 가 아니다.
    expect(coverageFor({ kind: 'contract', readable: true, expected, checked: expected, missing: [{ field: 'x', reason: 'y' }] }).status).toBe('partial');
    // 기대하지 않은 필드는 checked 로 세지 않는다.
    expect(coverageFor({ kind: 'contract', readable: true, expected: ['a'], checked: ['a', 'zzz'] }).checkedFields).toEqual(['a']);
  });

  it('formats tool errors in one shape', () => {
    expect(reviewError('forbidden', '권한 없음', { remediation: '지정 결재자에게 요청' }))
      .toEqual({ error: { code: 'forbidden', message: '권한 없음', retryable: false, remediation: '지정 결재자에게 요청' } });
    expect(reviewError('timeout', '지연', { retryable: true, partial: { pages: 3 } }).error).toMatchObject({ retryable: true, partial: { pages: 3 } });
  });
});
