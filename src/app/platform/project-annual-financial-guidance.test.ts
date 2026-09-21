import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProjectFinancialYear } from '../data/types';
import { submissionAnnualFinancialNeeds, submissionAnnualRate, submissionAmountKnown } from './project-submission-display';
import { ProjectAnnualFinancialNotice } from '../components/projects/ProjectAnnualFinancialNotice';

const year = (number: number): ProjectFinancialYear => ({ year: number, contractAmount: 100, salesVatAmount: 0,
  totalRevenueAmount: 40, totalActualCost: 60, supportAmount: 0, profitRate: 0.4, confirmed: false,
  inputFlags: { contractAmount: true, salesVatAmount: true, totalRevenueAmount: true, totalActualCost: true, supportAmount: true },
});

describe('annual finance completeness and aggregate rate', () => {
  it('names every unconfirmed field and year instead of a generic missing warning', () => {
    const row = { ...year(2026), inputFlags: { contractAmount: false, salesVatAmount: false, totalRevenueAmount: false, totalActualCost: false, supportAmount: false } };
    const result = submissionAnnualFinancialNeeds([row]);
    expect(result[0].fields).toEqual(['contractAmount', 'salesVatAmount', 'totalRevenueAmount', 'totalActualCost', 'supportAmount']);
    expect(result[0].message).toBe('2026년 계약금액, 매출 부가세, 수익, 실비(원가), 지원금 입력 확인이 필요합니다. 해당 금액이 없으면 0원을 직접 입력해 주세요.');
  });
  it('accepts explicit zero but never infers a zero-denominator rate', () => {
    const zero = { ...year(2026), contractAmount: 0, totalRevenueAmount: 0, totalActualCost: 0 };
    expect(submissionAnnualFinancialNeeds([zero])).toEqual([]);
    expect(submissionAnnualRate([zero])).toBe('계산 불가');
    expect(submissionAnnualRate([{ ...year(2026), totalRevenueAmount: 0 }])).toBe('0.00%');
  });
  it('blocks total rate for any unknown annual contract or revenue despite a complete other year', () => {
    const unknown = { ...year(2027), contractAmount: 0, totalRevenueAmount: 0, inputFlags: undefined };
    expect(submissionAnnualRate([year(2026), unknown])).toContain('연도별 계약금액·수익 확인 필요');
    expect(submissionAnnualRate([year(2026), { ...year(2027), inputFlags: { totalRevenueAmount: false } }])).toContain('계산 불가');
    expect(submissionAnnualRate([year(2026), { ...year(2027), inputFlags: undefined }])).toBe('40.00%');
  });
  it('does not hide missing cost or support just because the rate itself is computable', () => {
    const row = { ...year(2026), totalActualCost: 0, supportAmount: 0, inputFlags: { contractAmount: true, totalRevenueAmount: true, salesVatAmount: true } };
    expect(submissionAnnualRate([row])).toBe('40.00%');
    expect(submissionAnnualFinancialNeeds([row])[0].message).toContain('2026년 실비(원가), 지원금');
  });
  it('requires contract-period years that do not have a stored row', () => {
    const period = { contractStart: '2026-01-01', contractEnd: '2027-12-31' };
    expect(submissionAnnualRate([year(2026)], period)).toContain('계산 불가');
    expect(submissionAnnualFinancialNeeds([year(2026)], period)[0]).toMatchObject({ year: 2027, fields: expect.arrayContaining(['contractAmount', 'totalActualCost']) });
  });
  it('rejects negative financial amounts and preserves input state regardless of ordering', () => {
    expect(submissionAmountKnown(-1, true)).toBe(false);
    const rows = [{ ...year(2027), totalActualCost: -1 }, { ...year(2026), inputFlags: undefined }];
    const before = JSON.stringify(rows);
    expect(submissionAnnualFinancialNeeds(rows)).toEqual(submissionAnnualFinancialNeeds([...rows].reverse()));
    expect(submissionAnnualRate(rows)).toBe(submissionAnnualRate([...rows].reverse()));
    expect(JSON.stringify(rows)).toBe(before);
  });
  it('uses one rendered guidance component for the editor and approval table', () => {
    const row = { ...year(2026), totalActualCost: 0, inputFlags: { contractAmount: true, totalRevenueAmount: true, salesVatAmount: true, supportAmount: true } };
    const html = renderToStaticMarkup(createElement(ProjectAnnualFinancialNotice, { years: [row] }));
    expect(html).toContain('2026년 실비(원가) 입력 확인이 필요합니다.');
    expect(html).toContain('0원을 직접 입력');
    expect(html).toContain('기존 저장값은 유지됩니다');
  });
});
