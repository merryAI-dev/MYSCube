import { createIdempotencyKey } from '../../platform/request-context';

export interface GovernanceOperation<T> { idempotencyKey: string; body: T; acknowledged: boolean }
export function operationStorageKey(tenantId: string, actorId: string, identityKey: string, kind: 'link' | 'role') {
  return `mysc-governance-operation:${JSON.stringify([tenantId, actorId, identityKey, kind])}`;
}
export function readGovernanceOperation<T>(key: string): GovernanceOperation<T> | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null');
    return value && typeof value.idempotencyKey === 'string' && value.body && typeof value.acknowledged === 'boolean' ? value : null;
  } catch { return null; }
}
export function saveGovernanceOperation<T>(key: string, operation: GovernanceOperation<T> | null) {
  try { if (operation) sessionStorage.setItem(key, JSON.stringify(operation)); else sessionStorage.removeItem(key); } catch { /* In-memory state still preserves retries when storage is unavailable. */ }
}
export function newGovernanceOperation<T>(actorId: string, body: T): GovernanceOperation<T> {
  return { idempotencyKey: createIdempotencyKey('POST', actorId), body, acknowledged: false };
}
export function isUncertainGovernanceError(error: unknown) {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return !status || status >= 500 || [408, 425, 429].includes(status) || code === 'idempotency_in_progress';
}
