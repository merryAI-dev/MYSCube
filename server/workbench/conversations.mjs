import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { createHttpError } from '../bff/bff-utils.mjs';

const scopeId = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,199}$/;
const uuid = z.string().uuid();
const createInput = z.object({ title: z.string().trim().min(1).max(80).optional() }).strict();
const beginInput = z.object({ expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 2),
  requestId: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/), message: z.string().trim().min(1).max(4000), sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), scopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const resultInput = z.object({ answer: z.string().min(1).max(12000), status: z.string().min(1).max(80) }).passthrough();
const failureInput = z.object({ code: z.string().regex(/^[a-zA-Z0-9_]{1,100}$/), message: z.string().min(1).max(1000) }).strict();
const expiredError = { code: 'conversation_turn_expired', message: '이전 요청의 처리 시간이 지나 완료하지 못했습니다. 내용을 확인한 뒤 새 요청으로 다시 시도해 주세요.' };
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) throw createHttpError(400, '대화 내용·저장 버전·요청 정보를 확인해 주세요.', 'conversation_invalid');
  return result.data;
};
const jsonValue = (input) => {
  let nodes = 0;
  const normalize = (value, depth) => {
    if (++nodes > 20000 || depth > 40) throw createHttpError(413, '대화 결과의 구조가 너무 큽니다. 더 작은 범위로 나누어 요청해 주세요.', 'conversation_result_too_large');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map((item) => normalize(item, depth + 1));
    if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item, depth + 1)]));
    throw createHttpError(400, '대화 결과에 저장할 수 없는 형식이 있습니다.', 'conversation_result_invalid');
  };
  return normalize(input, 0);
};
const assertSize = (value) => {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 900_000) throw createHttpError(413, '대화 한 차례의 결과가 900KB 한도를 넘었습니다. 자료나 화면 소스를 나누어 요청해 주세요.', 'conversation_result_too_large');
};
const assertSession = (value) => {
  if (!value) throw createHttpError(404, '저장된 대화를 찾을 수 없습니다.', 'conversation_not_found');
  return value;
};
const history = (turns, totalAvailable, scopeFingerprint) => {
  const chosen = [];
  let chars = 0;
  const ended = turns.filter((turn) => (!scopeFingerprint || turn.result?.scopeFingerprint === scopeFingerprint) && (turn.state === 'completed' || turn.state === 'failed')).sort((a, b) => b.sequence - a.sequence);
  for (const turn of ended.slice(0, 12)) {
    const answer = turn.state === 'completed' ? turn.result?.answer : `이 요청은 완료되지 않았습니다. ${turn.error?.message || '처리 결과를 확인할 수 없습니다.'}`;
    if (chars + turn.message.length + answer.length > 24000) break;
    chars += turn.message.length + answer.length;
    chosen.push({ turnId: turn.id, sequence: turn.sequence, message: turn.message, answer });
  }
  chosen.reverse();
  return { history: chosen.flatMap((turn) => [{ role: 'user', content: turn.message }, { role: 'assistant', content: turn.answer }]),
    historyTurnIds: chosen.map((turn) => turn.turnId), historyTruncated: totalAvailable > chosen.length };
};

export function createConversationService({ db, now = () => new Date().toISOString() }) {
  const sessions = (context) => {
    if (context?.actorRole !== 'admin' || typeof context?.tenantId !== 'string' || typeof context?.actorId !== 'string'
      || !scopeId.test(context.tenantId) || !scopeId.test(context.actorId)) {
      throw createHttpError(403, '관리자 본인의 대화만 이용할 수 있습니다.', 'conversation_admin_required');
    }
    return db.collection(`orgs/${context.tenantId}/axr_conversations/${hash(context.actorId)}/sessions`);
  };
  const sessionRef = (context, id) => sessions(context).doc(parse(uuid, id));
  const requestRef = (ref, requestId) => ref.collection('requests').doc(hash(requestId));
  const queryHistory = (ref, version) => ref.collection('turns').where('sequence', '<=', version).orderBy('sequence', 'desc').limit(13)
    .select('id', 'state', 'sequence', 'message', 'result.answer', 'result.scopeFingerprint', 'error.message');
  const finishValue = (turn, state, version, at, fields) => {
    const value = { ...turn, state, version, completedAt: at, ...fields };
    assertSize(value);
    return value;
  };
  const writeFinished = (tx, ref, session, turn, value, at) => {
    tx.set(ref.collection('turns').doc(turn.id), value);
    tx.update(requestRef(ref, turn.requestId), { state: value.state, version: value.version });
    const next = { ...session, version: value.version, updatedAt: at, active: null, lastTurnId: turn.id, lastState: value.state };
    if (value.state === 'completed') {
      if (value.result.context) next.workContext = value.result.context;
      next.pendingClarification = value.result.clarification || null;
    }
    tx.set(ref, next);
    return next;
  };
  return {
    async list(context) {
      const result = await sessions(context).orderBy('updatedAt', 'desc').limit(51).get();
      return { items: result.docs.slice(0, 50).map((doc) => doc.data()), truncated: result.size > 50 };
    },
    async create(context, input = {}) {
      const { title } = parse(createInput, input);
      const ref = sessions(context).doc(randomUUID());
      const at = now();
      const value = { id: ref.id, title: title || '새 대화', version: 0, createdAt: at, updatedAt: at, createdBy: context.actorId, active: null, lastTurnId: null, lastState: null };
      await ref.create(value);
      return value;
    },
    async get(context, id) {
      const ref = sessionRef(context, id);
      return db.runTransaction(async (tx) => {
        const session = assertSession((await tx.get(ref)).data());
        const snapshot = await tx.get(ref.collection('turns').orderBy('sequence', 'desc').limit(21));
        const turns = [];
        let bytes = 0;
        for (const doc of snapshot.docs.slice(0, 20)) {
          const value = doc.data();
          const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
          if (bytes + size > 1_800_000) break;
          bytes += size;
          turns.push(value);
        }
        return { ...session, turns: turns.reverse(), truncated: snapshot.size > turns.length,
          historyNotice: '최근 20차례, 합계 1.8MB 이내의 대화를 표시합니다. 저장된 개별 결과는 해당 대화 항목에서 다시 확인할 수 있습니다.' };
      });
    },
    async getTurn(context, id, turnId) {
      const ref = sessionRef(context, id);
      assertSession((await ref.get()).data());
      const value = (await ref.collection('turns').doc(parse(uuid, turnId)).get()).data();
      if (!value) throw createHttpError(404, '저장된 대화 항목을 찾을 수 없습니다.', 'conversation_turn_not_found');
      return value;
    },
    async beginTurn(context, id, input) {
      const request = parse(beginInput, input);
      const ref = sessionRef(context, id);
      const fingerprint = hash(JSON.stringify(request));
      // Finished turns are immutable. The transaction's version check below binds
      // this read to the same head without holding a write lock during a query stream.
      const prior = await queryHistory(ref, request.expectedVersion).get();
      return db.runTransaction(async (tx) => {
        const [sessionDoc, previousRequest] = await tx.getAll(ref, requestRef(ref, request.requestId));
        let session = assertSession(sessionDoc.data());
        const at = now();
        if (previousRequest.exists) {
          const previous = previousRequest.data();
          if (previous.fingerprint !== fingerprint) throw createHttpError(409, '같은 요청 번호에 다른 내용이 들어왔습니다. 새 요청으로 보내 주세요.', 'conversation_request_conflict');
          const oldTurn = (await tx.get(ref.collection('turns').doc(previous.turnId))).data();
          if (!oldTurn) throw createHttpError(500, '대화 요청 기록을 확인할 수 없습니다.', 'conversation_integrity_failed');
          if (oldTurn.state === 'pending' && Date.parse(oldTurn.leaseExpiresAt) <= Date.parse(at)) {
            if (session.active?.turnId !== oldTurn.id) throw createHttpError(409, '대화 처리 상태가 변경되었습니다. 새로 조회해 주세요.', 'conversation_turn_conflict');
            const ended = finishValue(oldTurn, 'failed', session.version + 1, at, { error: expiredError });
            session = writeFinished(tx, ref, session, oldTurn, ended, at);
            return { mode: 'failed', turnId: ended.id, version: session.version, turn: ended };
          }
          return { mode: oldTurn.state === 'pending' ? 'in_progress' : oldTurn.state, turnId: oldTurn.id, version: session.version, turn: oldTurn };
        }
        if (session.version !== request.expectedVersion) throw createHttpError(409, '다른 창에서 대화가 진행되었습니다. 최신 대화를 불러온 뒤 다시 보내 주세요.', 'conversation_version_conflict');
        let activeTurn;
        if (session.active) {
          if (Date.parse(session.active.expiresAt) > Date.parse(at)) throw createHttpError(409, '이 대화의 이전 요청을 처리 중입니다. 완료된 뒤 이어서 보내 주세요.', 'conversation_in_progress');
          activeTurn = (await tx.get(ref.collection('turns').doc(session.active.turnId))).data();
          if (!activeTurn || activeTurn.state !== 'pending') throw createHttpError(500, '대화 처리 기록을 확인할 수 없습니다.', 'conversation_integrity_failed');
        }
        const priorTurns = prior.docs.map((doc) => doc.data());
        if (activeTurn) {
          const ended = finishValue(activeTurn, 'failed', session.version + 1, at, { error: expiredError });
          session = writeFinished(tx, ref, session, activeTurn, ended, at);
          priorTurns.push(ended);
        }
        const turnId = randomUUID();
        const leaseExpiresAt = new Date(Date.parse(at) + 120_000).toISOString();
        const turn = { id: turnId, requestId: request.requestId, fingerprint, message: request.message, state: 'pending', sequence: session.version + 1,
          baseVersion: session.version, version: null, createdAt: at, createdBy: context.actorId, leaseExpiresAt, completedAt: null };
        tx.create(ref.collection('turns').doc(turnId), turn);
        tx.create(requestRef(ref, request.requestId), { turnId, fingerprint, state: 'pending', version: null });
        tx.set(ref, { ...session, updatedAt: at, active: { turnId, expiresAt: leaseExpiresAt } });
        return { mode: 'started', turnId, version: session.version, leaseExpiresAt, workContext: session.workContext || {}, pendingClarification: session.pendingClarification || null, ...history(priorTurns, session.version, request.scopeFingerprint) };
      });
    },
    async completeTurn(context, id, input) {
      const turnId = parse(uuid, input?.turnId);
      const result = jsonValue(parse(resultInput, input?.result));
      const resultHash = hash(JSON.stringify(result));
      assertSize({ result });
      const ref = sessionRef(context, id);
      const outcome = await db.runTransaction(async (tx) => {
        const [sessionDoc, turnDoc] = await tx.getAll(ref, ref.collection('turns').doc(turnId));
        const session = assertSession(sessionDoc.data());
        const turn = turnDoc.data();
        if (!turn) throw createHttpError(404, '대화 항목을 찾을 수 없습니다.', 'conversation_turn_not_found');
        if (turn.state === 'completed') {
          if (turn.resultHash !== resultHash) throw createHttpError(409, '이미 저장한 응답과 다른 결과입니다. 기존 결과를 유지했습니다.', 'conversation_turn_conflict');
          return { turn, version: session.version, replayed: true };
        }
        if (turn.state !== 'pending' || session.active?.turnId !== turnId || session.version !== turn.baseVersion) {
          throw createHttpError(409, '이 대화 요청은 이미 종료되었거나 새 요청으로 이어졌습니다. 이전 결과를 덮어쓰지 않았습니다.', 'conversation_turn_conflict');
        }
        const at = now();
        const expired = Date.parse(turn.leaseExpiresAt) <= Date.parse(at);
        const value = finishValue(turn, expired ? 'failed' : 'completed', session.version + 1, at, expired ? { error: expiredError } : { result, resultHash });
        const next = writeFinished(tx, ref, session, turn, value, at);
        return { turn: value, version: next.version, replayed: false, expired };
      });
      if (outcome.expired) throw createHttpError(409, expiredError.message, expiredError.code);
      return outcome;
    },
    async failTurn(context, id, input) {
      const turnId = parse(uuid, input?.turnId);
      const error = parse(failureInput, input?.error || { code: 'conversation_request_failed', message: '요청을 완료하지 못했습니다. 작성 내용은 저장되어 있으니 새 요청으로 다시 시도해 주세요.' });
      const ref = sessionRef(context, id);
      return db.runTransaction(async (tx) => {
        const [sessionDoc, turnDoc] = await tx.getAll(ref, ref.collection('turns').doc(turnId));
        const session = assertSession(sessionDoc.data());
        const turn = turnDoc.data();
        if (!turn) throw createHttpError(404, '대화 항목을 찾을 수 없습니다.', 'conversation_turn_not_found');
        if (turn.state !== 'pending') return { turn, version: session.version, replayed: true };
        if (session.active?.turnId !== turnId || session.version !== turn.baseVersion) throw createHttpError(409, '대화 처리 상태가 변경되었습니다. 최신 결과를 확인해 주세요.', 'conversation_turn_conflict');
        const at = now();
        const value = finishValue(turn, 'failed', session.version + 1, at, { error });
        const next = writeFinished(tx, ref, session, turn, value, at);
        return { turn: value, version: next.version, replayed: false };
      });
    },
  };
}
