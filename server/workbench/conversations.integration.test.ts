import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { createConversationService } from './conversations.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('persistent isolated AXR conversations', () => {
  const db = new Firestore({ projectId: 'demo-html-workbench' });
  const businessDb = new Firestore({ projectId: 'demo-conversation-business' });
  const context = { tenantId: 'conversation-it', actorId: 'admin-a', actorRole: 'admin' };
  const root = `orgs/${context.tenantId}`;
  let clock = '2026-09-22T13:00:00.000Z';
  const instance = () => createConversationService({ db, now: () => clock });
  const service = instance();
  const begin = (id: string, expectedVersion: number, requestId: string, message = requestId) => service.beginTurn(context, id, { expectedVersion, requestId, message });
  const finish = (id: string, turnId: string, answer = '확인한 답변입니다.') => service.completeTurn(context, id, { turnId, result: { answer, status: 'completed' } });
  beforeEach(async () => {
    clock = '2026-09-22T13:00:00.000Z';
    expect(db.projectId).not.toBe(businessDb.projectId);
    await db.recursiveDelete(db.doc(root));
    await businessDb.recursiveDelete(businessDb.doc(root));
    await businessDb.doc(`${root}/projects/real`).set({ amount: 123, revision: 'untouched' });
  });
  afterAll(async () => {
    await db.recursiveDelete(db.doc(root));
    await businessDb.recursiveDelete(businessDb.doc(root));
    await Promise.all([db.terminate(), businessDb.terminate()]);
  });

  it('persists A→B→C context and restores it with a fresh service instance after a reload', async () => {
    const session = await service.create(context, { title: '현금흐름 검토' });
    expect(session.version).toBe(0);
    const a = await begin(session.id, 0, 'request-a', '현금흐름 화면을 만들고 싶어요.');
    expect(a).toMatchObject({ mode: 'started', version: 0, history: [] });
    await finish(session.id, a.turnId, '조회 기간을 알려 주세요.');
    const b = await begin(session.id, 1, 'request-b', '2026년 9월이에요.');
    expect(b.history).toEqual([{ role: 'user', content: '현금흐름 화면을 만들고 싶어요.' }, { role: 'assistant', content: '조회 기간을 알려 주세요.' }]);
    await finish(session.id, b.turnId, '9월 기준 화면을 검토하겠습니다.');
    const reloaded = await instance().get(context, session.id);
    expect(reloaded.version).toBe(2);
    expect(reloaded.turns.map((turn: any) => turn.message)).toEqual(['현금흐름 화면을 만들고 싶어요.', '2026년 9월이에요.']);
    const c = await instance().beginTurn(context, session.id, { expectedVersion: 2, requestId: 'request-c', message: '카드 대신 표를 중심으로 바꿔 주세요.' });
    expect(c.history).toHaveLength(4);
    expect(c.history.at(-1)).toEqual({ role: 'assistant', content: '9월 기준 화면을 검토하겠습니다.' });
    expect((await service.list(context)).items[0].id).toBe(session.id);
    expect((await businessDb.doc(`${root}/projects/real`).get()).data()).toEqual({ amount: 123, revision: 'untouched' });
  });

  it('replays pending and completed request identifiers without applying a result twice', async () => {
    const session = await service.create(context);
    const first = await begin(session.id, 0, 'same-request', 'A');
    expect(await begin(session.id, 0, 'same-request', 'A')).toMatchObject({ mode: 'in_progress', turnId: first.turnId });
    const done = await finish(session.id, first.turnId, '답변 A');
    expect(done.version).toBe(1);
    expect(await begin(session.id, 0, 'same-request', 'A')).toMatchObject({ mode: 'completed', turnId: first.turnId, version: 1 });
    expect(await finish(session.id, first.turnId, '답변 A')).toMatchObject({ replayed: true, version: 1 });
    await expect(begin(session.id, 0, 'same-request', '다른 내용')).rejects.toMatchObject({ code: 'conversation_request_conflict' });
    await expect(finish(session.id, first.turnId, '다른 답변')).rejects.toMatchObject({ code: 'conversation_turn_conflict' });
    const saved = await service.get(context, session.id);
    expect(saved.turns).toHaveLength(1);
    expect(saved.turns[0].result.answer).toBe('답변 A');
  });

  it('admits only one active turn under concurrent requests and rejects a stale version', async () => {
    const session = await service.create(context);
    const results = await Promise.allSettled([begin(session.id, 0, 'window-a'), begin(session.id, 0, 'window-b')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'conversation_in_progress' } });
    const active = results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<any>;
    await finish(session.id, active.value.turnId);
    await expect(begin(session.id, 0, 'stale-window')).rejects.toMatchObject({ code: 'conversation_version_conflict' });
    expect((await service.get(context, session.id)).turns).toHaveLength(1);
  });

  it('retains failed user input, releases the lease and includes the failure in the next turn context', async () => {
    const session = await service.create(context);
    const first = await begin(session.id, 0, 'will-fail', '내가 입력한 요구사항');
    const failed = await service.failTurn(context, session.id, { turnId: first.turnId, error: { code: 'provider_unavailable', message: 'AI 연결을 완료하지 못했습니다.' } });
    expect(failed).toMatchObject({ version: 1, turn: { state: 'failed', message: '내가 입력한 요구사항' } });
    expect((await service.get(context, session.id)).active).toBeNull();
    expect(await service.failTurn(context, session.id, { turnId: first.turnId })).toMatchObject({ version: 1, replayed: true });
    expect(await begin(session.id, 0, 'will-fail', '내가 입력한 요구사항')).toMatchObject({ mode: 'failed' });
    const next = await begin(session.id, 1, 'try-again', '다시 진행해 주세요.');
    expect(next.history[0].content).toBe('내가 입력한 요구사항');
    expect(next.history[1].content).toContain('AI 연결을 완료하지 못했습니다.');
    await expect(finish(session.id, first.turnId)).rejects.toMatchObject({ code: 'conversation_turn_conflict' });
    expect((await service.get(context, session.id)).active.turnId).toBe(next.turnId);
  });

  it('atomically expires an abandoned lease and starts a new request without losing old input', async () => {
    const session = await service.create(context);
    const abandoned = await begin(session.id, 0, 'abandoned', '첫 요청');
    clock = '2026-09-22T13:02:01.000Z';
    const next = await begin(session.id, 0, 'replacement', '이어갈 요청');
    expect(next).toMatchObject({ mode: 'started', version: 1 });
    expect(next.history[0].content).toBe('첫 요청');
    expect(next.history[1].content).toContain('처리 시간이 지나');
    expect((await service.getTurn(context, session.id, abandoned.turnId)).state).toBe('failed');
    expect((await finish(session.id, next.turnId)).version).toBe(2);
    await expect(finish(session.id, abandoned.turnId)).rejects.toMatchObject({ code: 'conversation_turn_conflict' });
  });

  it('replaying an expired identifier records one failure and never starts another model attempt for that identifier', async () => {
    const session = await service.create(context);
    const first = await begin(session.id, 0, 'expired-id');
    clock = '2026-09-22T13:03:00.000Z';
    expect(await begin(session.id, 0, 'expired-id')).toMatchObject({ mode: 'failed', version: 1, turnId: first.turnId });
    expect(await begin(session.id, 0, 'expired-id')).toMatchObject({ mode: 'failed', version: 1 });
    expect((await service.get(context, session.id)).active).toBeNull();
    expect((await service.get(context, session.id)).turns).toHaveLength(1);
  });

  it('commits an expired failure before rejecting a late completion so a lease cannot remain stuck', async () => {
    const session = await service.create(context);
    const first = await begin(session.id, 0, 'late-result');
    clock = '2026-09-22T13:02:00.000Z';
    await expect(finish(session.id, first.turnId)).rejects.toMatchObject({ code: 'conversation_turn_expired' });
    const saved = await service.get(context, session.id);
    expect(saved).toMatchObject({ version: 1, active: null });
    expect(saved.turns[0].state).toBe('failed');
    expect((await begin(session.id, 1, 'new-request')).mode).toBe('started');
  });

  it('bounds model history to 12 turns and UI history to 20 while retaining older individual results', async () => {
    const session = await service.create(context);
    let firstId;
    for (let index = 0; index < 22; index++) {
      const turn = await begin(session.id, index, `turn-${index}`, `질문 ${index}`);
      firstId ||= turn.turnId;
      await finish(session.id, turn.turnId, `답변 ${index}`);
    }
    const saved = await instance().get(context, session.id);
    expect(saved.turns).toHaveLength(20);
    expect(saved.truncated).toBe(true);
    expect(saved.turns[0].sequence).toBe(3);
    expect((await service.getTurn(context, session.id, firstId)).message).toBe('질문 0');
    const next = await begin(session.id, 22, 'turn-22');
    expect(next.history).toHaveLength(24);
    expect(next.historyTruncated).toBe(true);
    expect(next.history[0].content).toBe('질문 10');
  });

  it('bounds textual model context without sending large proposals or evidence in historical messages', async () => {
    const session = await service.create(context);
    for (let index = 0; index < 3; index++) {
      const turn = await begin(session.id, index, `long-${index}`, `질문 ${index}`);
      await service.completeTurn(context, session.id, { turnId: turn.turnId, result: { answer: '가'.repeat(12000), status: 'completed', proposal: { html: '원문'.repeat(50000) } } });
    }
    const next = await begin(session.id, 3, 'after-long');
    expect(next.history).toHaveLength(2);
    expect(next.historyTruncated).toBe(true);
    expect(JSON.stringify(next.history)).not.toContain('원문');
    expect(next.history.reduce((sum: number, message: any) => sum + message.content.length, 0)).toBeLessThanOrEqual(24000);
  });

  it('enforces organization, owner and administrator boundaries on every conversation operation', async () => {
    const session = await service.create(context);
    const turn = await begin(session.id, 0, 'private-turn');
    for (const other of [{ ...context, actorId: 'admin-b' }, { ...context, tenantId: 'another-tenant' }]) {
      expect((await service.list(other)).items).toEqual([]);
      await expect(service.get(other, session.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(service.getTurn(other, session.id, turn.turnId)).rejects.toMatchObject({ statusCode: 404 });
      await expect(service.beginTurn(other, session.id, { expectedVersion: 0, requestId: 'other', message: '침범' })).rejects.toMatchObject({ statusCode: 404 });
      await expect(service.completeTurn(other, session.id, { turnId: turn.turnId, result: { answer: '침범', status: 'completed' } })).rejects.toMatchObject({ statusCode: 404 });
      await expect(service.failTurn(other, session.id, { turnId: turn.turnId })).rejects.toMatchObject({ statusCode: 404 });
    }
    const member = { ...context, actorRole: 'member' };
    await expect(service.create(member)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.list(member)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.get(member, session.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.completeTurn(member, session.id, { turnId: turn.turnId, result: { answer: '권한 없음', status: 'completed' } })).rejects.toMatchObject({ statusCode: 403 });
    expect((await service.get(context, session.id)).active.turnId).toBe(turn.turnId);
  });

  it('rejects oversized result documents and permits an explicit failure to release the pending request', async () => {
    const session = await service.create(context);
    const turn = await begin(session.id, 0, 'too-large');
    await expect(service.completeTurn(context, session.id, { turnId: turn.turnId, result: { answer: '응답', status: 'completed', proposal: { html: '가'.repeat(310_000) } } }))
      .rejects.toMatchObject({ statusCode: 413, code: 'conversation_result_too_large' });
    await service.failTurn(context, session.id, { turnId: turn.turnId, error: { code: 'result_too_large', message: '결과가 너무 큽니다. 범위를 나누어 주세요.' } });
    const saved = await service.get(context, session.id);
    expect(saved).toMatchObject({ version: 1, active: null });
    expect(saved.turns[0].message).toBe('too-large');
  });
});
