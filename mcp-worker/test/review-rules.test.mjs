import { describe, expect, it } from 'vitest';
import { nameSimilarity, normalizeOrgName, parseAmount, parseDate, reviewSubmission } from '../src/review/rules.mjs';

const payload = {
  officialContractName: '2026 청년 창업 지원 운영 용역', clientOrg: '(재)가상테스트재단', currency: 'KRW',
  contractStart: '2026-03-01', contractEnd: '2026-12-31', contractEndUndecided: false,
  contractAmount: 110_000_000, salesVatAmount: 10_000_000, paymentPlan: { contract: 33_000_000, interim: 44_000_000, final: 33_000_000 },
};
const contractPages = [
  '용역 계약서\n사업명: 2026년 청년 창업 지원 운영 용역\n발주기관: 재단법인 가상테스트재단\n계약기간: 2026. 3. 1. ~ 2026. 12. 31.\n총 계약금액: 금 일억일천만원정(₩110,000,000, 부가가치세 포함)\n공급가액: 100,000,000원 / 부가가치세: 10,000,000원',
  '제5조(대금의 지급)\n① 선금: 33,000,000원\n② 중도금: 44,000,000원\n③ 잔금: 33,000,000원',
];
const read = (value, quote) => ({ value, quote });
const contractFields = {
  officialContractName: read('2026년 청년 창업 지원 운영 용역', '사업명: 2026년 청년 창업 지원 운영 용역'),
  clientOrg: read('재단법인 가상테스트재단', '발주기관: 재단법인 가상테스트재단'),
  contractStart: read('2026. 3. 1.', '계약기간: 2026. 3. 1. ~ 2026. 12. 31.'),
  contractEnd: read('2026. 12. 31.', '계약기간: 2026. 3. 1. ~ 2026. 12. 31.'),
  contractAmount: read('110,000,000', '총 계약금액: 금 일억일천만원정(₩110,000,000, 부가가치세 포함)'),
  supplyAmount: read('100,000,000', '공급가액: 100,000,000원'),
  salesVatAmount: read('10,000,000', '부가가치세: 10,000,000원'),
};
const contract = (fields = {}, extra = {}) => ({ kind: 'contract', source: 'attachment_text', readable: true, pages: contractPages, fields: { ...contractFields, ...fields }, ...extra });
const find = (result, field, kind = 'contract') => result.findings.find((item) => item.field === field && item.documentKind === kind);
const only = (docs, over = {}) => reviewSubmission({ payload: { ...payload, ...over }, documents: docs, attachedKinds: docs.map((doc) => doc.kind) });

describe('value parsing', () => {
  it('parses amounts strictly and never guesses', () => {
    expect(parseAmount('110,000,000원')).toBe(110_000_000);
    expect(parseAmount('₩ 110,000,000')).toBe(110_000_000);
    expect(parseAmount(5)).toBe(5);
    expect(parseAmount('1.1억')).toBeNull();
    expect(parseAmount('약 1억원')).toBeNull();
    expect(parseAmount(-1)).toBeNull();
  });
  it('parses Korean date notations and rejects impossible dates', () => {
    expect(parseDate('2026. 3. 1.')).toBe('2026-03-01');
    expect(parseDate('2026년 3월 1일')).toBe('2026-03-01');
    expect(parseDate('2026-12-31')).toBe('2026-12-31');
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('3월 1일')).toBeNull();
  });
  it('normalizes legal-form notation and measures name similarity', () => {
    expect(normalizeOrgName('(재)가상테스트재단')).toBe(normalizeOrgName('재단법인 가상테스트재단'));
    expect(nameSimilarity('2026 청년 창업 지원 운영 용역', '2026년 청년 창업 지원 운영 용역')).toBeGreaterThanOrEqual(0.85);
  });
});

describe('contract review', () => {
  it('matches a contract that agrees, with verified evidence and complete coverage', () => {
    const result = only([contract({}, { lists: { paymentSchedule: [{ label: '선금', amount: '33,000,000', quote: '① 선금: 33,000,000원' }, { label: '중도금', amount: '44,000,000', quote: '② 중도금: 44,000,000원' }, { label: '잔금', amount: '33,000,000', quote: '③ 잔금: 33,000,000원' }] } })]);
    expect(result.findings.filter((item) => item.status !== 'match')).toEqual([]);
    expect(find(result, 'contractAmount')).toMatchObject({ evidence: 'verified', page: 1 });
    expect(find(result, 'paymentPlan')).toMatchObject({ status: 'match', page: 2 });
    expect(result.coverage.find((item) => item.kind === 'contract').status).toBe('complete');
  });

  it('flags a different amount only when its quote is really in the document', () => {
    const pages = [contractPages[0].replace('110,000,000', '120,000,000'), contractPages[1]];
    const result = only([contract({ contractAmount: read('120,000,000', '(₩120,000,000, 부가가치세 포함)') }, { pages })]);
    expect(find(result, 'contractAmount')).toMatchObject({ status: 'mismatch', submitted: '110,000,000원', document: '120,000,000원', evidence: 'verified' });
  });

  it('does not judge a value whose quote is not in the document and records it as unknown', () => {
    const result = only([contract({ contractAmount: read('120,000,000', '총 계약금액: 120,000,000원') })]);
    expect(find(result, 'contractAmount')).toMatchObject({ status: 'check', evidence: 'not_found' });
    expect(result.unknowns.some((item) => item.question.includes('계약금액'))).toBe(true);
    expect(result.coverage.find((item) => item.kind === 'contract')).toMatchObject({ status: 'partial', missingFields: [{ field: 'contractAmount', reason: '인용을 서류에서 찾지 못함' }] });
  });

  it('downgrades a mismatch from an unverifiable source (chat attachment or connector) to a check', () => {
    const result = only([contract({ contractAmount: read('120,000,000', '아무 문장') }, { source: 'chat_attachment', pages: undefined })]);
    expect(find(result, 'contractAmount')).toMatchObject({ status: 'check', evidence: 'unverified' });
    expect(result.limitations.some((item) => item.includes('대화 첨부'))).toBe(true);
  });

  it('treats small notation differences in the contract name as the same, and clear differences as different', () => {
    expect(find(only([contract()]), 'officialContractName').status).toBe('match');
    const pages = [`${contractPages[0]}\n별칭: 해외 진출 액셀러레이팅 프로그램`, contractPages[1]];
    const different = only([contract({ officialContractName: read('해외 진출 액셀러레이팅 프로그램', '별칭: 해외 진출 액셀러레이팅 프로그램') }, { pages })]);
    expect(find(different, 'officialContractName').status).toBe('mismatch');
  });

  it('uses supply amount plus VAT when the contract has no total, verified only if both quotes are', () => {
    const noTotal = only([contract({ contractAmount: read('', '') })]);
    expect(find(noTotal, 'contractAmount')).toMatchObject({ status: 'match', rule: 'amount.supply_plus_vat', evidence: 'verified' });
    const fakeVat = only([contract({ contractAmount: read('', ''), salesVatAmount: read('20,000,000', '부가가치세: 20,000,000원') })]);
    expect(find(fakeVat, 'contractAmount')).toMatchObject({ status: 'check', evidence: 'not_found' });
  });

  it('flags an end date in the contract when the submission says there is no end, and does not claim absence as checked', () => {
    const withEnd = only([contract()], { contractEndUndecided: true, contractEnd: '' });
    expect(find(withEnd, 'contractEnd')).toMatchObject({ status: 'mismatch', submitted: '종료 기간 없음' });
    const noEnd = only([contract({ contractEnd: undefined })], { contractEndUndecided: true, contractEnd: '' });
    expect(find(noEnd, 'contractEnd')).toBeUndefined();
    expect(noEnd.coverage.find((item) => item.kind === 'contract').status).toBe('partial');
  });

  it('compares the payment plan total and composition', () => {
    const rows = (amounts) => amounts.map((amount, index) => ({ label: `회차${index + 1}`, amount, quote: null }));
    const split = only([contract({}, { source: 'connector', pages: undefined, lists: { paymentSchedule: rows([50_000_000, 60_000_000]) } })]);
    expect(find(split, 'paymentPlan').status).toBe('check');
    const pages = [contractPages[0], '① 선금: 50,000,000원\n② 잔금: 50,000,000원'];
    const bad = only([contract({}, { pages, lists: { paymentSchedule: [{ label: '선금', amount: 50_000_000, quote: '① 선금: 50,000,000원' }, { label: '잔금', amount: 50_000_000, quote: '② 잔금: 50,000,000원' }] } })]);
    expect(find(bad, 'paymentPlan')).toMatchObject({ status: 'mismatch', evidence: 'verified' });
  });

  it('skips amount comparison for non-KRW submissions and says so in coverage', () => {
    const result = only([contract()], { currency: 'USD' });
    expect(find(result, 'contractAmount')).toMatchObject({ status: 'check', rule: 'currency.non_krw' });
    expect(result.coverage.find((item) => item.kind === 'contract').status).toBe('partial');
  });

  it('accepts submitted amounts that arrive as strings', () => {
    expect(find(only([contract()], { contractAmount: '110000000' }), 'contractAmount').status).toBe('match');
  });
});

describe('business registration, quote and cross-document review', () => {
  const registration = (companyName, quote, pages) => ({ kind: 'customer_business_registration', source: 'attachment_text', readable: true, pages, fields: { companyName: read(companyName, quote) } });
  const quoteDoc = (fields, pages) => ({ kind: 'quote', source: 'attachment_text', readable: true, pages, fields });

  it('checks the registration and the quote against the submission and each other', () => {
    const result = only([
      contract(),
      registration('주식회사 다른회사', '상호: 주식회사 다른회사', ['사업자등록증\n상호: 주식회사 다른회사']),
      quoteDoc({ recipient: read('가상테스트재단', '수신: 가상테스트재단 귀하'), totalAmount: read('99,000,000', '합계금액: 99,000,000원') }, ['견적서\n수신: 가상테스트재단 귀하\n합계금액: 99,000,000원']),
    ]);
    expect(find(result, 'clientOrg', 'customer_business_registration').status).toBe('mismatch');
    expect(result.findings.some((item) => item.rule === 'cross.org' && item.status === 'mismatch')).toBe(true);
    expect(find(result, 'contractAmount', 'quote')).toMatchObject({ status: 'mismatch', document: '99,000,000원' });
    expect(find(result, 'clientOrg', 'quote').status).toBe('match');
  });

  it('reports missing and unreadable documents as unknown coverage without inventing findings', () => {
    const result = reviewSubmission({
      payload,
      documents: [{ kind: 'quote', source: 'attachment_text', readable: false, reason: 'sparse' }],
      attachedKinds: ['customer_business_registration', 'quote'],
    });
    expect(result.findings).toEqual([]);
    expect(result.coverage.map((item) => [item.kind, item.status])).toEqual([['contract', 'unknown'], ['customer_business_registration', 'unknown'], ['quote', 'unknown']]);
    expect(result.unknowns.map((item) => item.kind)).toEqual(['contract', 'customer_business_registration', 'quote']);
    expect(result.unknowns.find((item) => item.kind === 'quote').resolveBy).toContain('대화에 첨부');
  });
});
