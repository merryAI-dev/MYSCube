import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { createConversationService } from './conversations.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('independent conversation history scope regression', () => {
  const db = new Firestore({ projectId: 'demo-workbench-scope-qa' });
  const context = { tenantId: `scope-qa-${randomUUID()}`, actorId: 'same-admin', actorRole: 'admin' };
  const service = () => createConversationService({ db, now: () => '2026-09-22T13:00:00.000Z' });
  const fingerprint = (scope: string) => createHash('sha256').update(scope).digest('hex');
  afterAll(async () => {
    await db.recursiveDelete(db.doc(`orgs/${context.tenantId}`));
    await db.terminate();
  });

  it('keeps A history excluded after the first B result becomes the saved current context', async () => {
    const aScope = fingerprint('dataset-A/revision-1');
    const bScope = fingerprint('dataset-B/revision-2');
    const session = await service().create(context);
    const a = await service().beginTurn(context, session.id, {
      expectedVersion: 0, requestId: 'a', message: 'A에만 허용된 비공개 질문', scopeFingerprint: aScope,
    });
    await service().completeTurn(context, session.id, {
      turnId: a.turnId, result: { status: 'answered', answer: 'A에만 허용된 비공개 답변', scopeFingerprint: aScope, context: { scopeFingerprint: aScope } },
    });
    const b = await service().beginTurn(context, session.id, {
      expectedVersion: 1, requestId: 'b', message: 'B 범위의 질문', scopeFingerprint: bScope,
    });
    expect(b.history).toEqual([]);
    await service().completeTurn(context, session.id, {
      turnId: b.turnId, result: { status: 'answered', answer: 'B 범위의 답변', scopeFingerprint: bScope, context: { scopeFingerprint: bScope } },
    });
    const reloaded = await service().get(context, session.id);
    expect(reloaded.workContext.scopeFingerprint).toBe(bScope);
    expect(reloaded.turns).toHaveLength(2);
    const nextB = await service().beginTurn(context, session.id, {
      expectedVersion: 2, requestId: 'b-followup', message: '그 결과를 표로 보여 주세요.', scopeFingerprint: bScope,
    });
    expect(nextB.workContext.scopeFingerprint).toBe(bScope);
    expect(nextB.historyTurnIds).toEqual([b.turnId]);
    expect(nextB.history).toEqual([
      { role: 'user', content: 'B 범위의 질문' },
      { role: 'assistant', content: 'B 범위의 답변' },
    ]);
    expect(JSON.stringify(nextB.history)).not.toContain('비공개');
    expect(nextB.historyTruncated).toBe(true);
  });
});
