import { describe, expect, it } from 'vitest';
import { normalizeForQuote, verifyQuote } from '../src/review/quote.mjs';

const pages = [
  '용역 계약서\n사업명: 2026년 청년 창업 지원 운영 용역\n총 계약금액: 금 일억일천만원정(₩110,000,000, 부가가치세 포함)',
  '제5조(대금의 지급)\n① 선금: 33,000,000원을 계약 체결 후\n14일 이내에 지급한다.',
  '제9조(지체상금) 지체일수 1일당 계약금액의 1천분의 3에 해당하는 금액',
];

describe('quote verification', () => {
  it('finds a quote even when the PDF text broke lines or spacing differently', () => {
    expect(verifyQuote(pages, '총 계약금액: 금 일억일천만원정(₩110,000,000, 부가가치세 포함)')).toMatchObject({ status: 'verified', page: 1 });
    expect(verifyQuote(pages, '선금: 33,000,000원을 계약 체결 후 14일 이내에 지급한다')).toMatchObject({ status: 'verified', page: 2 });
    expect(verifyQuote(pages, '지체 일수 1일당   계약금액의 1천분의3')).toMatchObject({ status: 'verified', page: 3 });
  });

  it('unifies full-width characters, dashes and quotes', () => {
    expect(normalizeForQuote('１２０，０００ － “갑”')).toBe(normalizeForQuote('120,000 - "갑"'));
    expect(verifyQuote(['계약기간: 2026‐03‐01 ～ 2026‐12‐31'], '계약기간: 2026-03-01 ~ 2026-12-31').status).toBe('verified');
  });

  it('finds a quote that spans a page break and reports the starting page', () => {
    const split = ['…제12조(지식재산권) 본 용역의 결과물 및', '을이 보유한 방법론 일체에 대한 권리는 갑에게 귀속된다.'];
    expect(verifyQuote(split, '본 용역의 결과물 및 을이 보유한 방법론')).toEqual({ status: 'verified', page: 1, pages: [1, 2] });
  });

  it('reports every page that contains the quote', () => {
    expect(verifyQuote(['계약금액 110,000,000원', '다시 한 번 계약금액 110,000,000원'], '계약금액 110,000,000원')).toEqual({ status: 'verified', page: 1, pages: [1, 2] });
  });

  it('rejects a quote that is not in the document, including near misses on the amount', () => {
    expect(verifyQuote(pages, '총 계약금액: 금 일억이천만원정(₩120,000,000').status).toBe('not_found');
    expect(verifyQuote(pages, '계약금액의 1천분의 5').status).toBe('not_found');
  });

  it('refuses quotes too short to prove anything', () => {
    expect(verifyQuote(pages, '2026').status).toBe('too_short');
    expect(verifyQuote(pages, '  원  ').status).toBe('too_short');
    expect(verifyQuote(pages, '').status).toBe('too_short');
  });

  it('handles no pages', () => {
    expect(verifyQuote([], '총 계약금액 110,000,000원').status).toBe('not_found');
  });
});
