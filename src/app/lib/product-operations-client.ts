import { createPlatformApiClient, readPlatformApiRuntimeConfig, toRequestActor, type ActorLike } from './platform-bff-client';
import { enqueueOperationObservation } from '../platform/operation-observations';
import type { OperationKey } from '../../../shared/product-operations.mjs';

export type IncidentStatus = 'investigating' | 'confirmed' | 'fixing' | 'monitoring' | 'resolved';
export interface IncidentInput {
  expectedVersion: number; title: string; status: IncidentStatus; operationKey: OperationKey | null;
  cause: string; evidence: string; owner: string; action: string; releaseSha: string;
  published: boolean; publicTitle: string; publicMessage: string; publicAction: string;
}
export interface Incident extends Omit<IncidentInput, 'expectedVersion'> {
  id: string; version: number; createdAt: string; updatedAt: string; updatedBy: string; reopenedCount: number;
}
export interface PublicIncident {
  id: string; title: string; message: string; nextAction: string; status: IncidentStatus; operationKey: OperationKey | null; updatedAt: string;
}
export interface OperationCounts {
  total: number; clientStarted: number; serverObserved: number; followupUnconfirmed: number;
  pending: number; unknown: number; validation_blocked: number; rejected: number; system_failed: number; saved: number;
}
export interface ReliabilitySummary {
  from: string; to: string; environment: string; metricVersion: number; queriedAt: string; truncated: boolean;
  counts: OperationCounts; observedSystemFailureRate: number | null;
  rows: Array<{ day: string; operationKey: OperationKey; mode: string; counts: OperationCounts }>;
  collection: { status: 'unverified' | 'partial' | 'degraded'; lastKnownFailureAt: string | null; completeness: string; note: string };
}

export function createProductOperationsClient(params: { tenantId: string; actor: ActorLike }) {
  const client = createPlatformApiClient();
  const request = { tenantId: params.tenantId, actor: toRequestActor(params.actor) };
  const path = '/api/v1/product-operations';
  return {
    summary: async (days = 7) => (await client.get<ReliabilitySummary>(`${path}/summary?days=${days}`, request)).data,
    incidents: async () => (await client.get<{ items: Incident[]; truncated: boolean }>(`${path}/incidents`, request)).data,
    guidance: async () => (await client.get<{ items: PublicIncident[]; truncated: boolean }>(`${path}/guidance`, request)).data,
    history: async (id: string) => (await client.get<{ items: Incident[]; truncated: boolean }>(`${path}/incidents/${encodeURIComponent(id)}/history`, request)).data,
    saveIncident: async (id: string | null, body: IncidentInput) => (await client.request<Incident>(
      id ? `${path}/incidents/${encodeURIComponent(id)}` : `${path}/incidents`, { ...request, method: id ? 'PUT' : 'POST', body })).data,
  };
}

export function recordProjectValidationBlock(params: { tenantId: string; actor: ActorLike }, operationKey: OperationKey) {
  try {
    const operationId = globalThis.crypto?.randomUUID?.();
    if (!operationId) return;
    const context = { tenantId: params.tenantId, actor: toRequestActor(params.actor), baseUrl: readPlatformApiRuntimeConfig().baseUrl };
    enqueueOperationObservation(context, { operationId, operationKey, mode: 'manual', phase: 'started' });
    enqueueOperationObservation(context, { operationId, operationKey, mode: 'manual', phase: 'validation_blocked' });
  } catch { /* Input guidance remains available even without observation collection. */ }
}
