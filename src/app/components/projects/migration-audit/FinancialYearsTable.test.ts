import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FinancialYearsTable } from './FinancialYearsTable';
import type { ProjectFinancialYear } from '../../../data/types';

describe('submitted annual financial table', () => {
  it('renders VAT, derived profit, unknown confirmation and USD without mutating sparse rows', () => {
    const row = { year: 2026, contractAmount: 100, salesVatAmount: 0, totalRevenueAmount: 25, finalPaymentExpectedWeek: '2026-W12' } as ProjectFinancialYear;
    const before = JSON.stringify(row);
    const html = renderToStaticMarkup(createElement(FinancialYearsTable, { years: [row], currency: 'USD' }));
    expect(html).toContain('매출부가세');
    expect(html).toContain('2026-W12');
    expect(html).toContain('표를 좌우로 이동');
    expect(html).toContain('0 USD');
    expect(html).toContain('25.00%');
    expect(html).toContain('기록 없음');
    expect(html).toContain('미입력');
    expect(html).not.toContain('100원');
    expect(JSON.stringify(row)).toBe(before);
  });
});
