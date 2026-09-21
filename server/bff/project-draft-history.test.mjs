import { describe, expect, it } from 'vitest';
import { prepareProjectDraftHistorySave, projectDraftHistoryCollectionPath, readProjectDraftHistory } from './project-draft-history.mjs';

function harness(seed = {}) {
  const store = new Map(Object.entries(seed));
  const pending = [];
  let writesStarted = false;
  const db = {
    doc: (path) => ({ path }),
    collection: (path) => {
      let direction = 'asc'; let count = 20;
      const query = {
        orderBy: (field, dir) => { expect(field).toBe('draftRevision'); direction = dir; return query; },
        limit: (limit) => { count = limit; return query; },
        get: async () => ({ docs: [...store.entries()].filter(([key]) => key.startsWith(`${path}/`))
          .map(([, data]) => data).sort((a, b) => (a.draftRevision - b.draftRevision) * (direction === 'asc' ? 1 : -1))
          .slice(0, count).map((data) => ({ data: () => structuredClone(data) })) }),
      };
      return query;
    },
  };
  const tx = {
    get: async (ref) => { if (writesStarted) throw new Error('read after write'); return { exists: store.has(ref.path) }; },
    create: (ref, item) => { writesStarted = true; pending.push([ref.path, structuredClone(item)]); },
  };
  return { db, tx, store, pending, commit: () => pending.forEach(([path, item]) => store.set(path, item)) };
}
const ref = { path: 'orgs/test/privateEditDrafts/project-person' };
const draft = (revision, name = '초안') => ({ ownerUid: 'person', createdAt: '2026-09-21T00:00:00Z', draftRevision: revision, payload: { name, totalActualCost: '', nested: { untouched: false } }, attachmentRefs: [{ name: '계약서.hwp', path: 'private/original.hwp' }], updatedAt: '2026-09-21T01:00:00Z' });

describe('private draft history', () => {
  it('captures the existing legacy revision and the new revision atomically, preserving raw values', async () => {
    const h = harness(); const before = draft(7); const after = draft(8, '수정');
    const save = await prepareProjectDraftHistorySave({ db: h.db, tx: h.tx, draftRef: ref, before, after });
    expect(h.pending).toHaveLength(0);
    save(); expect(h.pending).toHaveLength(2); h.commit();
    const history = await readProjectDraftHistory({ db: h.db, draftRef: ref, draft: after });
    expect(history.items.map((item) => item.draftRevision)).toEqual([8, 7]);
    expect(history.historyAvailableFromRevision).toBe(7);
    expect(history.items[1].payload.totalActualCost).toBe('');
    expect(history.items[1].attachmentRefs[0].name).toBe('계약서.hwp');
  });
  it('never overwrites an existing revision and rejects duplicate next revision', async () => {
    const path = projectDraftHistoryCollectionPath(ref.path, draft(1));
    const h = harness({ [`${path}/1`]: { draftRevision: 1, payload: { name: '기존 이력' } } });
    const save = await prepareProjectDraftHistorySave({ db: h.db, tx: h.tx, draftRef: ref, before: draft(1, '다른 값'), after: draft(2) });
    save(); expect(h.pending).toHaveLength(1); h.commit();
    expect(h.store.get(`${path}/1`).payload.name).toBe('기존 이력');
    const duplicate = harness(Object.fromEntries(h.store));
    await expect(prepareProjectDraftHistorySave({ db: duplicate.db, tx: duplicate.tx, draftRef: ref, before: draft(1), after: draft(2) })).rejects.toMatchObject({ code: 'draft_version_conflict' });
    expect(duplicate.pending).toHaveLength(0);
  });
  it('separates a reopened draft generation but preserves history when the canonical base changes', () => {
    const path = projectDraftHistoryCollectionPath(ref.path, draft(1));
    expect(projectDraftHistoryCollectionPath(ref.path, { ...draft(0), createdAt: '2026-09-22T00:00:00Z' })).not.toBe(path);
    expect(projectDraftHistoryCollectionPath(ref.path, { ...draft(1), baseCanonicalVersion: 5 })).toBe(path);
    expect(projectDraftHistoryCollectionPath(ref.path, { ...draft(0), historyGeneration: 'new-uuid' })).not.toBe(path);
    expect(projectDraftHistoryCollectionPath(ref.path, { ...draft(0), historyGeneration: 'new-uuid' })).not.toBe(projectDraftHistoryCollectionPath(ref.path, { ...draft(0), historyGeneration: 'other-uuid' }));
  });
  it('shows only current content when no historical revisions exist', async () => {
    const h = harness(); const result = await readProjectDraftHistory({ db: h.db, draftRef: ref, draft: draft(12) });
    expect(result.items).toHaveLength(1); expect(result.historyAvailableFromRevision).toBe(12);
  });
  it('bounds the response to 20 newest snapshots and reports the actual oldest recorded revision', async () => {
    const path = projectDraftHistoryCollectionPath(ref.path, draft(1));
    const h = harness(Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`${path}/${index + 3}`, draft(index + 3)])));
    const result = await readProjectDraftHistory({ db: h.db, draftRef: ref, draft: draft(32) });
    expect(result.items).toHaveLength(20); expect(result.items[0].draftRevision).toBe(32); expect(result.historyAvailableFromRevision).toBe(3);
  });
});
