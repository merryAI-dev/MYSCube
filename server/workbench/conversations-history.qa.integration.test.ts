import { Firestore } from '@google-cloud/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { createConversationService } from './conversations.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('independent immutable history / transaction version boundary', () => {
  const db = new Firestore({ projectId: 'demo-conversation-history-boundary' });
  const context = { tenantId: 'history-boundary-qa', actorId: 'qa', actorRole: 'admin' };
  const now = () => '2026-09-24T10:00:00.000Z';
  afterAll(async () => { await db.recursiveDelete(db.doc(`orgs/${context.tenantId}`)); await db.terminate(); });

  it('rejects an old requested version when another turn finishes between history read and transaction', async () => {
    const service = createConversationService({ db, now });
    const session = await service.create(context);
    const active = await service.beginTurn(context, session.id, { expectedVersion: 0, requestId: 'first', message: '첫 질문' });
    let reached!: () => void, release!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    // Only scheduling is controlled. Queries, transaction, writes and reads use the real emulator.
    const delayedDb = new Proxy(db, { get(target, key) {
      if (key === 'runTransaction') return async (callback: any) => { reached(); await resume; return target.runTransaction(callback); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const delayed = createConversationService({ db: delayedDb, now });
    const pending = delayed.beginTurn(context, session.id, { expectedVersion: 0, requestId: 'stale-followup', message: '오래된 창 질문' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'conversation_version_conflict' });
    await paused;
    try { await service.completeTurn(context, session.id, { turnId: active.turnId, result: { answer: '최신 완료 답변', status: 'completed' } }); }
    finally { release(); }
    await rejected;
    const saved = await service.get(context, session.id);
    expect(saved.version).toBe(1); expect(saved.turns).toHaveLength(1); expect(saved.active).toBeNull();
    const next = await service.beginTurn(context, session.id, { expectedVersion: 1, requestId: 'fresh-followup', message: '새 버전 질문' });
    expect(next.history).toEqual([{ role: 'user', content: '첫 질문' }, { role: 'assistant', content: '최신 완료 답변' }]);
  });
});
