import { randomUUID } from 'node:crypto';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { copyLogPage, sanitizeCopiedLog, LOG_COPY_SCHEMA_VERSION } from './copy-feed.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('log copy schema upgrades across two real emulator databases', () => {
  const source = new Firestore({ projectId: 'demo-copy-schema-source' }), db = new Firestore({ projectId: 'demo-copy-schema-target' });
  const root = 'orgs/copy-schema-qa', now = () => '2026-09-23T16:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: source.projectId, WORKBENCH_MODEL_PROJECT_ID: 'demo-copy-schema-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-copy-schema-business', WORKBENCH_COPY_ENABLED: 'true', WORKBENCH_COPY_SOURCE_PROJECT_ID: source.projectId, WORKBENCH_TENANT_ID: 'copy-schema-qa' };
  const operation = () => ({ operationId: randomUUID(), operationKey: 'registration.submit', actorId: 'alice', mode: 'manual', environment: 'live', day: '2026-09-24', createdAt: now(), updatedAt: now(), metricVersion: 1, outcome: 'system_failed', serverObserved: true, clientStarted: false, followup: 'unconfirmed', requestId: 'request-a', errorCode: 'submit_failed', releaseSha: 'a'.repeat(40), message: 'private-user-input', extraToken: 'secret-not-copied' });
  const run = kind => copyLogPage({ source, db, env, kind, now });
  beforeEach(async () => { await source.recursiveDelete(source.doc(root)); await db.recursiveDelete(db.doc(root)); });
  afterAll(async () => { await source.recursiveDelete(source.doc(root)); await db.recursiveDelete(db.doc(root)); await source.terminate(); await db.terminate(); });

  it('repairs old same-source-time schema, deduplicates repeats and preserves source data plus updateTime', async () => {
    const original = operation(), ref = source.doc(`${root}/reliability_operations/a`); await ref.set(original); const before = await ref.get();
    await db.doc(`${root}/reliability_operations/a`).set({ actorId: 'alice', outcome: 'system_failed', copySourceUpdatedAt: before.updateTime, copySchemaVersion: 1 });
    expect((await run('reliability_operations')).count).toBe(1);
    const repaired = (await db.doc(`${root}/reliability_operations/a`).get()).data();
    expect(repaired).toMatchObject({ operationId: original.operationId, mode: 'manual', environment: 'live', day: '2026-09-24', metricVersion: 1, clientStarted: false, serverObserved: true, followup: 'unconfirmed', copySchemaVersion: LOG_COPY_SCHEMA_VERSION, copyValidation: { invalidFields: [], ambiguousFields: [] } });
    expect(JSON.stringify(repaired)).not.toMatch(/private-user-input|secret-not-copied/);
    const targetTime = (await db.doc(`${root}/reliability_operations/a`).get()).updateTime;
    expect((await run('reliability_operations')).count).toBe(0);
    expect((await db.doc(`${root}/reliability_operations/a`).get()).updateTime?.isEqual(targetTime!)).toBe(true);
    expect((await db.collection(`${root}/reliability_operations`).get()).size).toBe(1);
    const after = await ref.get(); expect(after.data()).toEqual(original); expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true);
  });
  it('propagates later outcome correction behind the cursor without changing operation identity or writing the source', async () => {
    const ref = source.doc(`${root}/reliability_operations/a`), original = operation(); await ref.set(original); await run('reliability_operations');
    await ref.update({ outcome: 'saved', errorCode: null, followup: 'not_applicable', clientStarted: true }); const sourceCorrection = await ref.get();
    expect((await run('reliability_operations')).count).toBe(1);
    expect((await db.doc(`${root}/reliability_operations/a`).get()).data()).toMatchObject({ operationId: original.operationId, outcome: 'saved', errorCode: null, clientStarted: true, followup: 'not_applicable' });
    expect((await ref.get()).updateTime?.isEqual(sourceCorrection.updateTime!)).toBe(true);
    expect((await run('reliability_operations')).count).toBe(0); expect((await db.collection(`${root}/reliability_operations`).get()).size).toBe(1);
  });
  it('never overwrites a target copied from a newer source revision, even during a schema upgrade', async () => {
    const ref = source.doc(`${root}/reliability_operations/a`); await ref.set(operation()); const original = await ref.get();
    const newer = { outcome: 'saved', copySchemaVersion: 1, copySourceUpdatedAt: Timestamp.fromMillis(original.updateTime!.toMillis() + 60000) };
    await db.doc(`${root}/reliability_operations/a`).set(newer);
    expect((await run('reliability_operations')).count).toBe(0); expect((await db.doc(`${root}/reliability_operations/a`).get()).data()).toEqual(newer);
    expect((await ref.get()).updateTime?.isEqual(original.updateTime!)).toBe(true);
  });
  it('upgrades an unversioned errorCode producer record without a new source write', async () => {
    const ref = source.doc(`${root}/client_error_events/a`); await ref.set({ actorId: 'alice', createdAt: now(), extra: { errorCode: 'draft_conflict', status: 409 } }); const original = await ref.get();
    await db.doc(`${root}/client_error_events/a`).set({ extra: { code: null }, copySourceUpdatedAt: original.updateTime });
    expect((await run('client_error_events')).count).toBe(1); expect((await db.doc(`${root}/client_error_events/a`).get()).data()).toMatchObject({ copySchemaVersion: 2, extra: { code: 'draft_conflict', status: 409, codeAmbiguous: false } });
    expect((await run('client_error_events')).count).toBe(0); expect((await ref.get()).updateTime?.isEqual(original.updateTime!)).toBe(true);
  });
});

describe('copy metadata validation without inferred defaults', () => {
  it('preserves missing fields as null and explicit booleans without zero/false inference', () => {
    const missing = sanitizeCopiedLog('reliability_operations', {});
    expect(missing).toMatchObject({ operationId: null, operationKey: null, mode: null, environment: null, day: null, createdAt: null, metricVersion: null, clientStarted: null, serverObserved: null, outcome: null, followup: null });
    expect(missing.copyValidation.invalidFields).toEqual([]);
    expect(sanitizeCopiedLog('reliability_operations', { clientStarted: false, serverObserved: true, mode: 'unknown', outcome: 'unknown' })).toMatchObject({ clientStarted: false, serverObserved: true, mode: 'unknown', outcome: 'unknown' });
  });
  it('redacts invalid enum, oversized identifiers, impossible dates and a conflicting Seoul day', () => {
    const copied = sanitizeCopiedLog('reliability_operations', { operationId: 'x'.repeat(1000), mode: 'fast', environment: 'private-other-env', outcome: 'success-ish', followup: 'do-private-action', metricVersion: -1, clientStarted: 'true', day: '2026-09-23', createdAt: '2026-09-23T16:00:00Z', updatedAt: '2026-02-30T00:00:00Z' });
    for (const name of ['operationId','mode','environment','outcome','followup','metricVersion','clientStarted','day','updatedAt']) { expect(copied[name]).toBeNull(); expect(copied.copyValidation.invalidFields).toContain(name); }
    expect(sanitizeCopiedLog('reliability_operations', { day: '2026-02-30', createdAt: 'yesterday' })).toMatchObject({ day: null, createdAt: null });
  });
  it.each([
    [{ errorCode: 'draft_conflict', status: 0 }, 'draft_conflict', 0, false],
    [{ code: 'draft_conflict', statusCode: 409 }, 'draft_conflict', 409, false],
    [{ code: 'draft_conflict', errorCode: 'draft_conflict', status: 409, statusCode: 409 }, 'draft_conflict', 409, false],
    [{ code: 'draft_conflict', errorCode: 'another_error', status: 400, statusCode: 409 }, null, null, true],
    [{ code: 'private raw error', errorCode: 'draft_conflict', status: '409', statusCode: 409 }, null, null, true],
  ])('normalizes compatible aliases and makes conflicts explicit: %j', (extra, code, status, ambiguous) => {
    const copied = sanitizeCopiedLog('client_error_events', { extra });
    expect(copied.extra).toMatchObject({ code, status, codeAmbiguous: ambiguous, statusAmbiguous: ambiguous });
    if (ambiguous) expect(copied.copyValidation.ambiguousFields).toEqual(['extra.code', 'extra.status']);
    expect(JSON.stringify(copied)).not.toContain('private raw error');
  });
  it('does not accept arbitrary numeric status values or expose invalid raw codes', () => {
    const copied = sanitizeCopiedLog('client_error_events', { extra: { code: 'secret '.repeat(300), status: 9000 } });
    expect(copied.extra).toMatchObject({ code: null, status: null, codeAmbiguous: false, statusAmbiguous: false }); expect(copied.copyValidation.invalidFields).toEqual(['extra.code', 'extra.status']);
  });
});
