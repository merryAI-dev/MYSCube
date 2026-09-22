import { describe, it, expect } from 'vitest';
import { mergeObservation, contribution, observationId, serverOutcome, publicIncident, operationObservationSchema } from './reliability-model.mjs';

const event = { operationId: 'b9bf1270-158c-49ef-8a9a-26976085bd63', operationKey: 'registration.submit', actorId: 'actor', mode: 'manual', environment: 'local', phase: 'started' };
const at = '2026-09-22T01:00:00.000Z';

describe('reliability observation contract', () => {
  it('deduplicates starts and does not let late client events replace server results', () => {
    const start = mergeObservation(null, event, at);
    expect(mergeObservation(start, event, '2026-09-22T02:00:00Z')).toBe(start);
    const saved = mergeObservation(start, { ...event, authority: 'server', outcome: 'saved' }, at);
    expect(mergeObservation(saved, { ...event, phase: 'unknown' }, at).outcome).toBe('saved');
    expect(mergeObservation(saved, { ...event, authority: 'server', outcome: 'system_failed' }, at).outcome).toBe('saved');
    expect(contribution(saved)).toMatchObject({ total: 1, saved: 1, unknown: 0, clientStarted: 1, serverObserved: 1 });
  });
  it('reconciles a response loss once and separates actor and operation scopes', () => {
    const unknown = mergeObservation(null, { ...event, phase: 'unknown' }, at);
    const saved = mergeObservation(unknown, { ...event, authority: 'server', outcome: 'saved' }, at);
    expect(contribution(unknown).unknown).toBe(1);
    expect(contribution(saved).unknown).toBe(0);
    expect(observationId('t', 'a', 'registration.submit', event.operationId)).not.toBe(observationId('t', 'b', 'registration.submit', event.operationId));
  });
  it('never accepts client success or private public fields', () => {
    const client = { operationId: event.operationId, operationKey: event.operationKey, mode: event.mode, phase: 'started' };
    expect(operationObservationSchema.safeParse(client).success).toBe(true);
    expect(operationObservationSchema.safeParse({ ...client, phase: 'saved' }).success).toBe(false);
    expect(publicIncident({ id: 'incident', cause: 'private', evidence: 'private', actorId: 'other' })).not.toHaveProperty('cause');
  });
  it('requires a known persisted response shape and exposes unconfirmed followup', () => {
    expect(serverOutcome(event.operationKey, 200, { ok: true }).outcome).toBe('unknown');
    expect(serverOutcome(event.operationKey, 202, { status: 'SUBMITTED' }).outcome).toBe('pending');
    expect(serverOutcome(event.operationKey, 200, { status: 'SUBMITTED', projectId: 'p', outbox: { status: 'PENDING' } })).toEqual({ outcome: 'saved', followup: 'unconfirmed' });
    expect(serverOutcome(event.operationKey, 409, { error: 'version_conflict' }).outcome).toBe('rejected');
  });
});
