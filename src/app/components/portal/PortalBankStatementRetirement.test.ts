import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('retired legacy bank statement surface', () => {
  it('removes the page and every navigation entry, retaining cashflow and budget', () => {
    expect(existsSync(resolve(import.meta.dirname, 'PortalBankStatementPage.tsx'))).toBe(false);
    for (const path of ['../../routes.tsx', 'PortalLayout.tsx', 'PortalPayrollPage.tsx', 'PortalWeeklyExpensePage.tsx', '../../platform/admin-command-index.ts']) {
      const source = readFileSync(resolve(import.meta.dirname, path), 'utf8');
      expect(source).not.toContain('/portal/bank-statements');
      expect(source).not.toContain('PortalBankStatementPage');
    }
    const routes = readFileSync(resolve(import.meta.dirname, '../../routes.tsx'), 'utf8');
    expect(routes).toContain('PortalCashflowPage');
    expect(routes).toContain('PortalBudget');
  });
});
