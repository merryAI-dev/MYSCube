import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { mountJvmWeeklyApiRoutes } from './jvm-weekly-api.mjs';

function setup({ weeklyYear = 2026, project = { name: '에코', currency: 'KRW' } } = {}) {
  const records = {
    'orgs/tenant-a/projects/project-a': project,
    'orgs/tenant-a/cashflow_sheet_mirrors/project-a': { projectId: 'project-a', weeklyYear, status: 'FRESH' },
  };
  const db = { doc: (path) => ({ get: async () => ({ exists: Boolean(records[path]), data: () => records[path] }) }) };
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    projectId: 'project-a', targetRevision: 'rev-1', projection: [], actual: [], readModel: { months: [] },
  }), { status: 200 }));
  const port = mountJvmWeeklyApiRoutes(express(), { db, fetchImpl, jvmWeeklyApiBaseUrl: 'http://jvm-weekly.local', jvmWeeklyApiServiceToken: 'test-service-token' });
  return { port, fetchImpl };
}
const req = { context: { tenantId: 'tenant-a', actorId: 'agent', actorRole: 'auditor', requestId: 'read-test' }, params: { projectId: 'project-a' }, query: { yearMonth: '2026-09' } };

describe('shared readonly JVM accounting port', () => {
  it('uses GET only and annotates project/mirror metadata without fabricating cell states', async () => {
    const { port, fetchImpl } = setup();
    const result = await port.readCashflowSnapshot(req);
    expect(result.accountingSource).toMatchObject({ weeklyYear: 2026, projectCurrency: 'KRW' });
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
    expect(fetchImpl.mock.calls[0][0]).toBe('http://jvm-weekly.local/api/v1/cashflow/project-a');
  });
  it('refuses annual/out-of-scope and missing source before JVM lookup', async () => {
    const { port, fetchImpl } = setup({ weeklyYear: 2025 });
    await expect(port.readCashflowSnapshot(req)).rejects.toMatchObject({ code: 'cashflow_accounting_annual_scope' });
    expect(fetchImpl).not.toHaveBeenCalled();
    const missing = setup({ weeklyYear: null });
    await expect(missing.port.readCashflowSnapshot(req)).rejects.toMatchObject({ code: 'cashflow_accounting_source_unavailable' });
    expect(missing.fetchImpl).not.toHaveBeenCalled();
  });
  it('keeps the original GET shape when accounting month was not requested', async () => {
    const { port } = setup({ weeklyYear: null });
    expect((await port.readCashflowSnapshot({ ...req, query: {} })).accountingSource).toBeUndefined();
  });
  it('denies a role outside readCore before proxy execution', async () => {
    const { port, fetchImpl } = setup();
    await expect(port.readCashflowSnapshot({ ...req, context: { ...req.context, actorRole: 'outsider' } })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('denies an unassigned member even when their role can read core data', async () => {
    const { port, fetchImpl } = setup();
    await expect(port.readCashflowSnapshot({ ...req, context: { ...req.context, actorRole: 'pm' } }))
      .rejects.toMatchObject({ code: 'cashflow_project_forbidden' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
