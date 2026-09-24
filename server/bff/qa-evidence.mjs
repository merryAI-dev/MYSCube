import { FieldPath } from 'firebase-admin/firestore';
import * as z from 'zod/v4';
import { createHttpError } from './bff-utils.mjs';
import { createGithubCodeReader, validSha } from './github-code-evidence.mjs';
import { classifyReadError } from '../mcp/support-read.mjs';
import { safeDiagnosticCode } from './reliability-model.mjs';

export const qaQuestion = z.object({
  question: z.string().trim().min(1).max(1000),
  area: z.enum(['cashflow', 'draft', 'approval', 'frontend']),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  eventId: z.string().regex(/^[A-Za-z0-9_-]{1,150}$/).optional(),
  cursor: z.string().max(1000).optional(),
}).strict();
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(value) ? value : null;
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
export async function authorizeQa(db, context) {
  const member = (await db.doc(`orgs/${context.tenantId}/members/${context.actorId}`).get()).data();
  if (context.actorRole !== 'admin' || member?.role !== 'admin' || member?.status !== 'ACTIVE') throw createHttpError(403, '운영 관리자만 로그와 코드 근거를 확인할 수 있습니다.', 'qa_admin_required');
  return JSON.stringify(member);
}

export function createQaEvidenceService({ db, now = () => new Date().toISOString(), readCode = createGithubCodeReader({ now }), readHttpEvidence }) {
  return async (context, raw, signal = AbortSignal.timeout(20000)) => {
    const parsed = qaQuestion.safeParse(raw);
    if (!parsed.success) throw createHttpError(400, '질문·업무 종류·오류 기록 번호를 확인해 주세요.', 'qa_question_invalid');
    const input = parsed.data;
    const membership = await authorizeQa(db, context);
    let cursor;
    if (input.cursor) {
      try { cursor = z.object({ at: z.string().datetime(), id: z.string().regex(/^[A-Za-z0-9_-]{1,150}$/), cutoff: z.string().datetime() }).strict().parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
      catch { throw createHttpError(400, '이전 기록 조회 위치가 유효하지 않습니다. 처음부터 조회해 주세요.', 'qa_cursor_invalid'); }
    }
    const cutoff = cursor?.cutoff || now();
    const collection = db.collection(`orgs/${context.tenantId}/client_error_events`);
    let docs;
    if (input.eventId) {
      const doc = await collection.doc(input.eventId).get(); docs = doc.exists ? [doc] : [];
    } else {
      let query = collection;
      if (input.requestId) query = query.where('clientRequestId', '==', input.requestId);
      else { query = query.where('createdAt', '<=', cutoff).orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc'); if (cursor) query = query.startAfter(cursor.at, cursor.id); }
      docs = (await query.limit(101).get()).docs;
    }
    const logs = docs.slice(0, 100).map((doc) => {
      const item = doc.data();
      return { id: doc.id, occurredAt: date(item.occurredAt), receivedAt: date(item.createdAt),
        requestId: safeId(item.clientRequestId), ingestionRequestId: safeId(item.requestId),
        code: safeDiagnosticCode(item.extra?.code), httpStatus: Number.isInteger(item.extra?.status) ? item.extra.status : null,
        clientRelease: validSha(item.release) ? item.release : null, ingestionRelease: validSha(item.ingestRelease) ? item.ingestRelease : null,
        diagnosis: classifyReadError({ code: item.extra?.code, status: item.extra?.status, name: item.name }) };
    });
    const selected = input.eventId ? logs[0] : null;
    const requestId = input.requestId || selected?.requestId;
    const operationDocs = requestId ? (await db.collection(`orgs/${context.tenantId}/reliability_operations`).where('requestId', '==', requestId).limit(11).get()).docs : [];
    const selectedRaw = input.eventId ? docs[0]?.data() : null;
    const keys = { draft: ['registration.draft.save', 'project-change.draft.save'], approval: ['project.executive-review', 'registration.submit', 'project-change.submit'], cashflow: [], frontend: [] };
    const matches = operationDocs.filter((doc) => { const row = doc.data(); return selectedRaw && row.actorId === selectedRaw.actorId && keys[input.area].includes(row.operationKey)
      && row.serverObserved === true && Number.isFinite(Date.parse(row.updatedAt)) && Math.abs(Date.parse(row.updatedAt) - Date.parse(selectedRaw.createdAt)) <= 120000; });
    const operations = matches.slice(0, 10).map((doc) => {
      const value = doc.data();
      return { id: doc.id, requestId: safeId(value.requestId), operationKey: value.operationKey, outcome: value.outcome,
        code: safeDiagnosticCode(value.errorCode), release: validSha(value.releaseSha) ? value.releaseSha : null,
        at: date(value.updatedAt), serverObserved: value.serverObserved === true };
    });
    const http = readHttpEvidence ? await readHttpEvidence(context, { requestId, actorId: selectedRaw?.actorId,
      receivedAt: selectedRaw?.createdAt, expectedStatus: selected?.httpStatus, area: input.area, signal }) : null;
    const candidatesFromServer = [...operations, ...(http?.candidates || [])];
    const ambiguousServer = operationDocs.length > 10 || http?.truncated || http?.invalidRecords > 0 || candidatesFromServer.length > 1;
    const server = !ambiguousServer && candidatesFromServer.length === 1 ? candidatesFromServer[0] : null;
    // Ingesting a browser error is a different request from the request that failed.
    const revision = input.area === 'frontend' ? selected?.clientRelease : server?.release;
    const code = input.area === 'frontend' ? selected?.code : server?.code || selected?.code;
    const github = await readCode({ sha: revision, area: input.area, code, signal });
    if (membership !== await authorizeQa(db, context)) throw createHttpError(409, '조회 중 계정 정보가 변경되었습니다. 다시 확인해 주세요.', 'qa_scope_changed');
    signal.throwIfAborted();
    const facts = [`저장된 화면 오류 ${logs.length}건을 조회했습니다. 조회 범위의 기록이며 전체 장애 건수가 아닙니다.`];
    if (selected) facts.push(`선택한 기록의 오류 코드: ${selected.code || '기록 없음'}. ${selected.diagnosis.message}`);
    if (server) facts.push(`동일 계정·업무·수신 시각 근처의 요청 번호가 일치하는 서버 처리 후보: ${server.outcome}. 업무: ${server.operationKey}.`);
    if (http?.records.length) facts.push(`운영자가 가져온 HTTP 응답 완료 기록 ${http.records.length}건을 함께 대조했습니다. 내보낸 파일의 진위·누락 여부는 독립적으로 확인하지 못했습니다.`);
    const candidates = github.items.flatMap((item) => item.matchedCode ? [`${item.path}: 같은 오류 코드가 코드에 있습니다. 해당 분기가 실행됐는지 확인이 필요합니다.`] : []);
    return { question: input.question, answerMode: 'deterministic_evidence', queriedAt: now(), facts, candidates,
      unknowns: ['요청 번호는 호출자가 지정할 수 있습니다. 계정·업무·시각까지 일치해도 인과관계 확정은 아닙니다.', '코드 위치 일치만으로 근본 원인을 확정하지 않습니다.',
        ...(ambiguousServer ? ['여러 서버 기록이 겹치거나 조회 한도·기록 검증에 문제가 있어 코드 버전을 선택하지 않았습니다.'] : []),
        ...(!revision ? ['실패 요청의 코드 버전을 확인하지 못했습니다. 오류 수집 서버 버전이나 최신 main으로 대신하지 않았습니다.'] : []),
        'Vercel·Cloud Run 전체 서버 로그는 이 조회에 연결되지 않았습니다. 서버 스택·외부 서비스 응답까지 확인한 진단이 아닙니다.',
        ...(http?.records.length ? ['가져온 HTTP 기록은 응답 완료 시점만 보여줍니다. 연결 중단·미완료 요청과 실시간 수집을 포함하지 않습니다.'] : [])],
      nextSteps: !selected ? ['아래에서 오류 기록을 선택하면 요청 번호와 해당 버전 코드를 대조합니다.'] : !server && input.area !== 'frontend' ? ['실패 요청의 서버 기록과 배포 SHA를 확인해 주세요. 오류 수집 요청 번호와 구분해야 합니다.'] : ['표시된 코드 위치와 같은 요청의 처리 결과를 대조하고 재현 결과로 원인을 확인해 주세요.'],
      logs, operations, ...(http ? { httpLogs: http.records, httpCoverage: { truncated: http.truncated, invalidRecords: http.invalidRecords, provenance: http.provenance } } : {}), github, correlation: server ? 'REQUEST_METADATA_CANDIDATE' : 'NOT_ESTABLISHED',
      coverage: { source: 'persisted_client_errors_and_server_observations', scanned: Math.min(docs.length, 100), truncated: docs.length > 100,
        nextCursor: !input.requestId && !input.eventId && docs.length > 100 ? Buffer.from(JSON.stringify({ at: docs[99].data().createdAt, id: docs[99].id, cutoff })).toString('base64url') : null,
        note: '최초 조회 시각 이전 기록을 시각·기록 번호 순으로 100건씩 탐색합니다. 수신 시각이 없는 옛 기록·삭제된 기록·미수집 오류는 포함되지 않습니다. 업무 종류는 코드 대조 범위이고 아래 로그 목록은 전체 업무입니다.' } };
  };
}
export function mountQaEvidenceRoutes(app, { db, now, asyncHandler, readCode, query = createQaEvidenceService({ db, now, readCode }) }) {
  app.post('/api/v1/qa-evidence/query', asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await query(req.context, req.body));
  }));
}
