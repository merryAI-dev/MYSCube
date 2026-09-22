import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFirestoreDb } from './firestore.mjs';
import { createQaEvidenceService } from './qa-evidence.mjs';
import { createPersonalWorkPageService } from './personal-work-pages.mjs';
import { proposeInsightLayout } from '../../shared/insight-page.mjs';
const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('QA evidence and executive page contracts', () => {
  const db = createFirestoreDb({ projectId: 'demo-bff-it' });
  const context = { tenantId: 'qa-evidence-test', actorId: 'a', actorRole: 'admin' };
  const base = `orgs/${context.tenantId}`;
  const now = () => '2026-09-22T02:01:00.000Z';
  const readCode = vi.fn(async (input) => ({ status: input.sha ? 'available' : 'missing_revision', items: [], message: '' }));
  const query = createQaEvidenceService({ db, now, readCode });
  const input = { question: '임시저장 실패 원인은?', area: 'draft' };
  beforeEach(async () => { await db.recursiveDelete(db.doc(base)); readCode.mockClear(); await db.doc(`${base}/members/a`).set({ role: 'admin', status: 'ACTIVE' }); });
  afterAll(async () => { await db.recursiveDelete(db.doc(base)); });
  it('paginates all equal-timestamp logs without gaps and strips private data', async () => {
    const batch = db.batch(); for (let i = 0; i < 105; i++) batch.set(db.doc(`${base}/client_error_events/e${String(i).padStart(3,'0')}`), { createdAt: now(), message: 'private-secret', actorEmail: 'secret@example.com' }); await batch.commit();
    const one = await query(context, input); const two = await query(context, { ...input, cursor: one.coverage.nextCursor });
    expect(one.logs).toHaveLength(100); expect(two.logs).toHaveLength(5); expect(new Set([...one.logs,...two.logs].map((row) => row.id)).size).toBe(105);
    expect(JSON.stringify(one)).not.toContain('private-secret'); expect(JSON.stringify(one)).not.toContain('secret@example.com');
    await expect(query({ ...context, actorRole: 'pm' }, input)).rejects.toMatchObject({ statusCode: 403 });
  });
  it('never treats ingestion SHA or another actor request as failed code revision; rejects ambiguity', async () => {
    await db.doc(`${base}/client_error_events/e`).set({ actorId: 'a', createdAt: now(), clientRequestId: 'r', ingestRelease: 'b'.repeat(40), release: 'c'.repeat(40), extra: { code: 'draft_conflict' } });
    await db.doc(`${base}/reliability_operations/o`).set({ actorId: 'other', requestId: 'r', operationKey: 'registration.draft.save', updatedAt: now(), serverObserved: true, releaseSha: 'a'.repeat(40) });
    await query(context, { ...input, eventId: 'e' }); expect(readCode.mock.lastCall[0].sha).toBeUndefined();
    await db.doc(`${base}/reliability_operations/o`).update({ actorId: 'a' });
    const candidate = await query(context, { ...input, eventId: 'e' }); expect(candidate.correlation).toBe('REQUEST_METADATA_CANDIDATE'); expect(readCode.mock.lastCall[0].sha).toBe('a'.repeat(40));
    await db.doc(`${base}/reliability_operations/o2`).set((await db.doc(`${base}/reliability_operations/o`).get()).data());
    const ambiguous = await query(context, { ...input, eventId: 'e' }); expect(ambiguous.correlation).toBe('NOT_ESTABLISHED'); expect(readCode.mock.lastCall[0].sha).toBeUndefined();
    await query(context, { ...input, eventId: 'e', area: 'frontend' }); expect(readCode.mock.lastCall[0].sha).toBe('c'.repeat(40));
  });
  it('drops results if admin membership changes while GitHub responds', async () => {
    const changed = createQaEvidenceService({ db, now, readCode: async () => { await db.doc(`${base}/members/a`).update({ role: 'pm' }); return { items: [] }; } });
    await expect(changed(context, input)).rejects.toMatchObject({ statusCode: 403 });
  });
  it('persists dashboard configuration, restores as new version and keeps owners isolated', async () => {
    const pages = createPersonalWorkPageService({ db, now }); const config = proposeInsightLayout('현금흐름과 오류 추이', '2026-09').config;
    const first = await pages.save(context, null, { expectedVersion: 0, config });
    await pages.save(context, first.id, { expectedVersion: 1, config: { ...config, widgets: [...config.widgets].reverse() } });
    const restored = await pages.restore(context, first.id, { expectedVersion: 2, version: 1 });
    expect(restored.version).toBe(3); expect(restored.config).toEqual(config);
    await expect(pages.get({ ...context, actorId: 'other' }, first.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
