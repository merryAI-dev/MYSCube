import { FieldPath } from 'firebase-admin/firestore';
import * as z from 'zod/v4';
import { createHttpError } from './bff-utils.mjs';
import { isProjectInActorScope, memberProjectIds, TENANT_WIDE_PROJECT_ROLES } from './cashflow-project-scope.mjs';
import { accountingEvidence } from '../mcp/accounting-read.mjs';
import { summarizeAccountingRows } from '../mcp/accounting-report.mjs';
import { SUPPORT_KNOWLEDGE, summarizeClientError, classifyReadError } from '../mcp/support-read.mjs';

export const evidenceQuery = z.object({
  yearMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
  after: z.string().min(1).max(100).regex(/^[^/]+$/).optional(),
}).strict();

export function createCashflowEvidenceQuery({ db, readSnapshot, now = () => new Date().toISOString(), release = '', readBudgetMs = 5000 }) {
  return async (context, raw, signal) => {
    const parsed = evidenceQuery.safeParse(raw);
    if (!parsed.success) throw createHttpError(400, '조회할 연월을 선택해 주세요.', 'cashflow_evidence_invalid');
    const input = parsed.data;
    const member = (await db.doc(`orgs/${context.tenantId}/members/${context.actorId}`).get()).data();
    if (!member || member.status !== 'ACTIVE') throw createHttpError(403, '활성 계정으로 다시 로그인해 주세요.', 'cashflow_evidence_member_required');
    // Re-check the persisted role; a saved page never grants access to its data source.
    if (member.role !== context.actorRole) throw createHttpError(403, '변경된 권한을 확인하려면 다시 로그인해 주세요.', 'cashflow_evidence_role_changed');
    const collection = db.collection(`orgs/${context.tenantId}/projects`);
    let page;
    if (TENANT_WIDE_PROJECT_ROLES.includes(context.actorRole)) {
      let query = collection.orderBy(FieldPath.documentId()).select('name', 'cic', 'trashedAt');
      if (input.after) query = query.startAfter(input.after);
      page = await query.limit(11).get();
    } else {
      const ids = [...memberProjectIds(member)].filter((id) => !id.includes('/') && (!input.after || id > input.after)).sort().slice(0, 11);
      const docs = ids.length ? await db.getAll(...ids.map((id) => collection.doc(id))) : [];
      page = { docs, size: docs.length };
    }
    const scanned = page.docs.slice(0, 10);
    const projects = scanned.filter((doc) => doc.exists && !doc.data().trashedAt && isProjectInActorScope({ role: context.actorRole, members: [member], actorId: context.actorId, projectId: doc.id }));
    const rows = new Array(projects.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, projects.length) }, async () => {
      while (next < projects.length) {
      const index = next++;
      const doc = projects[index];
      signal.throwIfAborted();
      const project = doc.data();
      const row = { projectId: doc.id, name: project.name || '사업명 확인 필요', cic: project.cic || 'CIC 미지정' };
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      let timer;
      try {
        const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(Object.assign(new Error('조회 시간이 초과되었습니다.'), { name: 'TimeoutError' }));
        }, readBudgetMs); });
        const snapshot = await Promise.race([readSnapshot({ context, params: { projectId: doc.id }, query: { yearMonth: input.yearMonth }, signal: controller.signal }), timeout]);
        const evidence = accountingEvidence(snapshot, { projectId: doc.id, yearMonth: input.yearMonth, detail: 'summary' }, now());
        const recorded = ['projection', 'actual'].some((mode) => evidence[mode].some((week) => week.availability === 'AVAILABLE'));
        const missingWeeks = Object.fromEntries(['projection', 'actual'].map((mode) => [mode, evidence[mode].filter((week) => week.availability !== 'AVAILABLE').map((week) => week.weekNo)]));
        rows[index] = { ...row, status: recorded ? 'AVAILABLE' : 'NOT_RECORDED', projection: evidence.monthlyTotals.projection,
          actual: evidence.monthlyTotals.actual, difference: evidence.difference.monthlyTotals, missingWeeks, evidence };
      } catch (error) {
        signal.throwIfAborted();
        rows[index] = { ...row, status: 'FAILED', error: classifyReadError(error) };
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
      }
      }
    }));
    const current = (await db.doc(`orgs/${context.tenantId}/members/${context.actorId}`).get()).data();
    if (JSON.stringify(current) !== JSON.stringify(member)) throw createHttpError(409, '조회 중 계정 정보가 변경되었습니다. 다시 조회해 주세요.', 'cashflow_evidence_scope_changed');
    signal.throwIfAborted();
    return { yearMonth: input.yearMonth, queriedAt: now(), rows, totals: summarizeAccountingRows(rows),
      scope: 'accessible_projects_in_this_page', totalsScope: 'THIS_PAGE_ONLY', amountCurrency: 'KRW',
      accessibleInPage: projects.length, available: rows.filter((row) => row.status === 'AVAILABLE').length,
      notRecorded: rows.filter((row) => row.status === 'NOT_RECORDED').length, failed: rows.filter((row) => row.status === 'FAILED').length,
      nextAfter: page.size > 10 ? scanned.at(-1).id : null, catalogComplete: page.size <= 10 && !input.after,
      code: { authority: 'reviewed_code_knowledge', version: 1, release: /^[a-f0-9]{40}$/.test(release) ? release : null,
        entries: SUPPORT_KNOWLEDGE.filter((entry) => ['accounting', 'connectivity'].includes(entry.topic)) },
      conclusion: '조회 결과는 관측 사실입니다. 코드 설명은 가능한 원인을 이해하는 자료이며, 이 조회만으로 장애 원인을 확정하지 않습니다.',
      limitations: ['합계는 이번 페이지에서 조회된 금액만 포함합니다. 전사 합계가 아닙니다.',
        '페이지마다 별도 시점에 조회합니다. 여러 페이지 결과를 동일 시점의 전사 합계로 합치지 마세요.',
        '조회 실패·자료 없음은 0원이 아닙니다. 누락 사업 수를 함께 확인하세요.',
        'JVM에 반영된 자료이며 현재 시트의 최신 값인지 확인하지 않았습니다.'] };
  };
}

export async function readCashflowDiagnostics({ db, context, now = () => new Date().toISOString() }) {
  if (context.actorRole !== 'admin') throw createHttpError(403, '오류 기록은 서비스 운영 관리자만 확인할 수 있습니다.', 'cashflow_diagnostics_admin_required');
  const page = await db.collection(`orgs/${context.tenantId}/client_error_events`).orderBy('createdAt', 'desc').limit(101).get();
  const events = page.docs.slice(0, 100).map((doc) => ({ id: doc.id, ...summarizeClientError(doc.data()),
    release: /^[a-f0-9]{40}$/.test(doc.data().ingestRelease || '') ? doc.data().ingestRelease : null })).filter((row) => row.area === 'cashflow');
  return { items: events, queriedAt: now(), scanned: Math.min(100, page.size), truncated: page.size > 100,
    correlation: 'NOT_ESTABLISHED', source: 'client_reported_error_metadata',
    warning: '최근 화면 오류 100건 안의 현금흐름 관련 기록입니다. 이번 금액 조회와 같은 장애라는 근거는 아직 없습니다. 원문·개인정보는 제외했습니다.' };
}

export function mountCashflowEvidenceRoutes(app, { db, readSnapshot, now, release, asyncHandler }) {
  const query = createCashflowEvidenceQuery({ db, readSnapshot, now, release });
  app.get('/api/v1/cashflow-evidence', asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const signal = AbortSignal.timeout(25000);
    res.json(await query(req.context, req.query, signal));
  }));
  app.get('/api/v1/cashflow-evidence/diagnostics', asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await readCashflowDiagnostics({ db, context: req.context, now }));
  }));
}
