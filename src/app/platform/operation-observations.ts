import { buildStandardHeaders, type RequestActor } from './request-context';
import { OPERATION_KEYS, OPERATION_MODES, type OperationKey, type OperationMode } from '../../../shared/product-operations.mjs';

type Observation = { operationId: string; operationKey: OperationKey; mode: OperationMode; phase: 'started' | 'validation_blocked' | 'unknown' };
type Context = { tenantId: string; actor: RequestActor; baseUrl: string; fetchImpl?: typeof fetch };
const memory = new Map<string, Observation[]>();
const running = new Set<string>();
let dropped = 0;
export const getOperationQueueHealth = () => ({ pending: [...memory.values()].reduce((sum, queue) => sum + queue.length, 0), dropped });
const queueKey = ({ tenantId, actor }: Context) => `mysc-operation-observations:${tenantId}:${actor.id}`;

function read(key: string): Observation[] {
  if (memory.has(key)) return memory.get(key)!;
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (Array.isArray(value)) {
      const queue = value.filter((item) => item && typeof item.operationId === 'string' && /^[a-f0-9-]{36}$/i.test(item.operationId)
        && OPERATION_KEYS.includes(item.operationKey) && OPERATION_MODES.includes(item.mode)
        && ['started', 'validation_blocked', 'unknown'].includes(item.phase)).slice(-100);
      memory.set(key, queue);
      return queue;
    }
  } catch { /* A blocked browser store must not block the business request. */ }
  return memory.get(key) || [];
}

function write(key: string, queue: Observation[]) {
  memory.set(key, queue);
  try { sessionStorage.setItem(key, JSON.stringify(queue)); } catch { /* Memory retains this tab's queue. */ }
}

export async function flushOperationObservations(context: Context) {
  const key = queueKey(context);
  if (running.has(key)) return;
  running.add(key);
  try {
    for (let count = 0; count < 100; count += 1) {
      const item = read(key)[0];
      if (!item) break;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await (context.fetchImpl || fetch)(`${context.baseUrl}/api/v1/product-operations/observations`, {
          method: 'POST', headers: buildStandardHeaders({ tenantId: context.tenantId, actor: context.actor, method: 'POST',
            headers: { 'content-type': 'application/json' } }),
          body: JSON.stringify(item), signal: controller.signal, keepalive: true,
        });
        if (!response.ok) break;
        write(key, read(key).filter((entry) => entry.operationId !== item.operationId || entry.phase !== item.phase));
      } catch { break; } finally { clearTimeout(timeout); }
    }
  } finally { running.delete(key); }
}

export function enqueueOperationObservation(context: Context, observation: Observation) {
  try {
    const key = queueKey(context);
    const queue = read(key);
    if (!queue.some((item) => item.operationId === observation.operationId && item.phase === observation.phase)) {
      if (queue.length >= 100) dropped += 1;
      write(key, [...queue, observation].slice(-100));
    }
    void flushOperationObservations(context);
  } catch { /* Telemetry is never a prerequisite for saving. */ }
}
