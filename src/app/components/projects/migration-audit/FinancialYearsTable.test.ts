import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FinancialYearsTable } from './FinancialYearsTable';
import type { ProjectFinancialYear } from '../../../data/types';

describe('submitted annual financial table', () => {
  it('keeps unconfirmed stored amounts visible while separating absent evidence from explicit zero', () => {
    const row = { year: 2026, contractAmount: 120, salesVatAmount: 0, totalRevenueAmount: 48,
      totalActualCost: 72, supportAmount: 0, inputFlags: { totalActualCost: false, supportAmount: true },
      paymentPlan: { contract: 0, interim: 0, final: 0 }, paymentPlanInputFlags: { contract: true, interim: false },
    } as ProjectFinancialYear;
    const before = JSON.stringify(row);
    const html = renderToStaticMarkup(createElement(FinancialYearsTable, { years: [row] }));
    expect(html).toContain('미확인 (저장값 72원)');
    expect(html).toContain('입력 기록 없음');
    expect(html).toContain('미입력');
    expect(html.match(/>0원</g)).toHaveLength(2);
    expect(JSON.stringify(row)).toBe(before);
  });
  it('renders VAT, derived profit, unknown confirmation and USD without mutating sparse rows', () => {
    const row = { year: 2026, contractAmount: 100, salesVatAmount: 0, inputFlags: { salesVatAmount: true }, totalRevenueAmount: 25, finalPaymentExpectedWeek: '2026-W12' } as ProjectFinancialYear;
    const before = JSON.stringify(row);
    const html = renderToStaticMarkup(createElement(FinancialYearsTable, { years: [row], currency: 'USD' }));
    expect(html).toContain('매출부가세');
    expect(html).toContain('2026-W12');
    expect(html).toContain('표를 좌우로 이동');
    expect(html).toContain('0 USD');
    expect(html).toContain('25.00%');
    expect(html).toContain('기록 없음');
    expect(html).toContain('입력 기록 없음');
    expect(html).not.toContain('100원');
    expect(JSON.stringify(row)).toBe(before);
  });
});
