import { createPlatformApiClient, toRequestActor, type ActorLike } from './platform-bff-client';

export interface InsightWidget { id: string; kind: 'cashflow' | 'operations' | 'guidance'; title: string; display: 'cards' | 'table' | 'trend'; days: 7 | 14 | 28; search: string; width: 'half' | 'full' }
export interface QaResult { question: string; queriedAt: string; facts: string[]; candidates: string[]; unknowns: string[]; nextSteps: string[]; correlation: string;
  logs: Array<{ id: string; occurredAt: string | null; code: string | null; requestId: string | null; clientRelease: string | null; ingestionRelease: string | null }>;
  github: { status: string; message: string; items: Array<{ path: string; sha: string; status: string; url?: string; excerpts?: Array<{ text: string; url: string; startLine: number; endLine: number }> }> };
  coverage: { scanned: number; truncated: boolean; nextCursor: string | null; note: string } }
export interface WorkPageConfig {
  schemaVersion: 1 | 2; title: string; description: string; source: 'cashflow-evidence' | 'service-guidance' | 'insight-dashboard';
  widgets?: InsightWidget[];
  presentation: 'table' | 'cards'; yearMonth: string; search: string;
}
export interface WorkPage {
  id: string; config: WorkPageConfig; version: number; updatedAt: string; updatedBy: string; restoredFrom: number | null;
}
export interface CashflowEvidenceRow {
  projectId: string; name: string; cic: string; status: string;
  missingWeeks?: { projection: number[]; actual: number[] };
  projection?: Record<string, number | null>; actual?: Record<string, number | null>;
  error?: { category: string; code: string; message?: string };
  evidence?: { source: { targetRevision: string; retrievedAt: string }; warnings: string[] };
}
export interface CashflowEvidence {
  yearMonth: string; queriedAt: string; rows: CashflowEvidenceRow[]; nextAfter: string | null; catalogComplete: boolean;
  accessibleInPage: number; available: number; failed: number; notRecorded: number; limitations: string[]; conclusion: string;
  code: { release: string | null; version: number; entries: Array<{ topic: string; title: string; facts: string[]; nextSteps: string[]; sources: string[] }> };
}
export interface DiagnosticResult {
  items: Array<{ id: string; occurredAt: string | null; errorClass: string; code: string | null; release: string | null }>;
  warning: string; queriedAt: string; truncated: boolean;
}
export function createWorkbenchClient(params: { tenantId: string; actor: ActorLike }) {
  const client = createPlatformApiClient();
  const request = { tenantId: params.tenantId, actor: toRequestActor(params.actor) };
  const prefix = '/api/v1/personal-work-pages';
  return {
    askQa: async (input: { question: string; area: string; eventId?: string; requestId?: string }) => (await client.request<{ answer: string; status: string; runId: string; review: string }>('/api/v1/workbench-assistant/qa', { ...request, method: 'POST', body: input, timeoutMs: 60000, retries: 0 })).data,
    qa: async (input: { question: string; area: string; eventId?: string; requestId?: string; cursor?: string }) => (await client.request<QaResult>('/api/v1/qa-evidence/query', { ...request, method: 'POST', body: input, timeoutMs: 25000, retries: 0 })).data,
    capabilities: async () => (await client.get<{ modelEnabled: boolean; message: string }>('/api/v1/workbench-assistant/capabilities', request)).data,
    propose: async (question: string, yearMonth: string) => (await client.request<{ config: WorkPageConfig; runId: string }>('/api/v1/workbench-assistant/page-proposal',
      { ...request, method: 'POST', body: { question, yearMonth }, timeoutMs: 60000, retries: 0 })).data,
    ask: async (question: string, yearMonth: string) => (await client.request<{ answer: string; status: string; runId: string; review: string; evidence: Array<CashflowEvidence | DiagnosticResult> }>('/api/v1/workbench-assistant/cashflow',
      { ...request, method: 'POST', body: { question, yearMonth }, timeoutMs: 60000, retries: 0 })).data,
    list: async () => (await client.get<{ items: WorkPage[]; truncated: boolean }>(prefix, request)).data,
    get: async (id: string) => (await client.get<WorkPage>(`${prefix}/${encodeURIComponent(id)}`, request)).data,
    versions: async (id: string) => (await client.get<{ items: WorkPage[]; truncated: boolean }>(`${prefix}/${encodeURIComponent(id)}/versions`, request)).data,
    save: async (id: string | null, expectedVersion: number, config: WorkPageConfig) => (await client.request<WorkPage>(id ? `${prefix}/${encodeURIComponent(id)}` : prefix,
      { ...request, method: id ? 'PUT' : 'POST', body: { expectedVersion, config } })).data,
    restore: async (id: string, expectedVersion: number, version: number) => (await client.request<WorkPage>(`${prefix}/${encodeURIComponent(id)}/restore`,
      { ...request, method: 'POST', body: { expectedVersion, version } })).data,
    remove: async (id: string, expectedVersion: number) => (await client.request(`${prefix}/${encodeURIComponent(id)}`,
      { ...request, method: 'DELETE', body: { expectedVersion } })).data,
    insightReport: async (yearMonth: string) => (await client.get<CashflowEvidence>(`/api/v1/insight-cashflow-report?${new URLSearchParams({ yearMonth })}`, { ...request, timeoutMs: 30000, retries: 0 })).data,
    evidence: async (yearMonth: string, after?: string) => (await client.get<CashflowEvidence>(`/api/v1/cashflow-evidence?${new URLSearchParams({ yearMonth, ...(after ? { after } : {}) })}`,
      { ...request, timeoutMs: 30000, retries: 0 })).data,
    diagnostics: async () => (await client.get<DiagnosticResult>('/api/v1/cashflow-evidence/diagnostics', request)).data,
  };
}
