import { describe, expect, it } from 'vitest';
import { resolveAdminProviderScope, isCashflowOverviewRoute } from './admin-route-providers';

describe('admin route provider scope', () => {
  it('does not mount unrelated realtime providers on project routes', () => {
    expect(resolveAdminProviderScope('/projects')).toEqual({
      hrAnnouncements: false,
      payroll: false,
      cashflowWeeks: false,
      board: false,
      training: false,
    });
  });

  it('mounts only the provider owned by the active admin feature', () => {
    expect(resolveAdminProviderScope('/board/post-1').board).toBe(true);
    expect(resolveAdminProviderScope('/payroll').payroll).toBe(true);
    expect(resolveAdminProviderScope('/training').training).toBe(true);
    expect(resolveAdminProviderScope('/cashflow/projects/p1').cashflowWeeks).toBe(true);
    expect(resolveAdminProviderScope('/payroll')).toMatchObject({ payroll: true, cashflowWeeks: true });
    expect(resolveAdminProviderScope('/dashboard')).toMatchObject({
      hrAnnouncements: true,
      payroll: true,
      cashflowWeeks: true,
    });
  });

  it('keeps the export dashboard off the legacy cashflow week subscription', () => {
    expect(resolveAdminProviderScope('/cashflow/export').cashflowWeeks).toBe(false);
    expect(resolveAdminProviderScope('/cashflow/weekly').cashflowWeeks).toBe(true);
    expect(resolveAdminProviderScope('/cashflow/projects/p1').cashflowWeeks).toBe(true);
  });
});

 it('loads only month navigation on overview routes while keeping detail data enabled', () => {
   for (const path of ['/cashflow', '/cashflow/', '/cashflow/weekly', '/cashflow/projects']) {
     expect(isCashflowOverviewRoute(path)).toBe(true);
   }
   for (const path of ['/cashflow/projects/p1', '/cashflow/analytics', '/dashboard', '/payroll', '/portal/cashflow']) {
     expect(isCashflowOverviewRoute(path)).toBe(false);
   }
 });
