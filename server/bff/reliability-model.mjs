import { createHash } from 'node:crypto';
import { z } from 'zod';

import { OPERATION_KEYS, OPERATION_MODES } from '../../shared/product-operations.mjs';
export { OPERATION_KEYS, OPERATION_MODES };
export const OUTCOMES = ['pending', 'unknown', 'validation_blocked', 'rejected', 'system_failed', 'saved'];
export const INCIDENT_STATES = ['investigating', 'confirmed', 'fixing', 'monitoring', 'resolved'];
export const operationObservationSchema = z.object({
  operationId: z.string().uuid(),
  operationKey: z.enum(OPERATION_KEYS),
  mode: z.enum(OPERATION_MODES),
  phase: z.enum(['started', 'validation_blocked', 'unknown']),
}).strict();

export const incidentInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(120),
  status: z.enum(INCIDENT_STATES),
  operationKey: z.enum(OPERATION_KEYS).nullable(),
  cause: z.string().trim().max(3000),
  evidence: z.string().trim().max(3000),
  owner: z.string().trim().max(100),
  action: z.string().trim().max(3000),
  releaseSha: z.string().regex(/^([a-f0-9]{40})?$/i),
  published: z.boolean(),
  publicTitle: z.string().trim().max(120),
  publicMessage: z.string().trim().max(1500),
  publicAction: z.string().trim().max(1000),
}).strict().superRefine((value, ctx) => {
  if (value.published && (!value.publicTitle || !value.publicMessage || !value.publicAction)) {
    ctx.addIssue({ code: 'custom', message: '공개할 제목·안내·다음 행동을 모두 작성해 주세요.' });
  }
  if (value.status !== 'investigating' && (!value.cause || !value.evidence)) {
    ctx.addIssue({ code: 'custom', message: '확인한 원인과 근거를 작성해 주세요.' });
  }
  if (value.status === 'resolved' && !value.action) {
    ctx.addIssue({ code: 'custom', message: '해결 조치와 확인 결과를 작성해 주세요.' });
  }
});

export function observationId(tenantId, actorId, operationKey, operationId) {
  return createHash('sha256').update(JSON.stringify([tenantId, actorId, operationKey, operationId])).digest('hex');
}

export function safeDiagnosticCode(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(value) ? value : null;
}

export function seoulDay(timestamp) {
  return new Date(Date.parse(timestamp) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function mergeObservation(current, event, timestamp) {
  const initial = current || {
    operationId: event.operationId, operationKey: event.operationKey, mode: event.mode || 'unknown',
    actorId: event.actorId, environment: event.environment, day: seoulDay(timestamp),
    createdAt: timestamp, outcome: 'pending', clientStarted: false, serverObserved: false,
    errorCode: null, requestId: null, releaseSha: null, followup: 'not_applicable',
  };
  const next = { ...initial };
  if (event.authority === 'server') {
    next.serverObserved = true;
    // A replayed failed request cannot undo an already committed result.
    if (next.outcome !== 'saved') {
      next.outcome = event.outcome;
      next.errorCode = safeDiagnosticCode(event.errorCode);
      next.followup = event.followup || 'not_applicable';
      next.requestId = event.requestId || next.requestId;
      next.releaseSha = event.releaseSha || next.releaseSha;
    }
  } else {
    if (event.phase === 'started') next.clientStarted = true;
    if (!next.serverObserved && event.phase !== 'started') next.outcome = event.phase;
  }
  if (next.mode === 'unknown' && OPERATION_MODES.includes(event.mode)) next.mode = event.mode;
  const changed = !current || Object.keys(next).some((key) => next[key] !== current[key]);
  return changed ? { ...next, updatedAt: timestamp } : current;
}

export function contribution(operation) {
  const result = Object.fromEntries(['total', 'clientStarted', 'serverObserved', 'followupUnconfirmed', ...OUTCOMES].map((key) => [key, 0]));
  if (!operation) return result;
  result.total = 1;
  result.clientStarted = Number(operation.clientStarted);
  result.serverObserved = Number(operation.serverObserved);
  result[operation.outcome] = 1;
  result.followupUnconfirmed = Number(operation.followup === 'unconfirmed');
  return result;
}

export function publicIncident(record) {
  return {
    id: record.id, title: record.publicTitle, message: record.publicMessage,
    nextAction: record.publicAction, status: record.status, operationKey: record.operationKey,
    updatedAt: record.updatedAt,
  };
}

export function serverOutcome(operationKey, statusCode, body) {
  if (statusCode === 202) return { outcome: 'pending' };
  if (statusCode >= 500) return { outcome: 'system_failed', errorCode: body?.error };
  if (statusCode >= 400) return { outcome: 'rejected', errorCode: body?.error };
  if (statusCode < 200 || statusCode >= 300) return { outcome: 'unknown' };
  if (operationKey.endsWith('.draft.save') && body?.draft?.status === 'ACTIVE' && Number.isInteger(body?.draft?.draftRevision)) {
    return { outcome: 'saved' };
  }
  if (operationKey.endsWith('.submit') && body?.status === 'SUBMITTED' && typeof body?.projectId === 'string') {
    return { outcome: 'saved', followup: body.outbox ? 'unconfirmed' : 'not_applicable' };
  }
  if (operationKey === 'project.executive-review' && body?.ok === true
      && ['APPROVED', 'REJECTED'].includes(body?.reviewStatus) && typeof body?.projectId === 'string') {
    return { outcome: 'saved' };
  }
  return { outcome: 'unknown' };
}
