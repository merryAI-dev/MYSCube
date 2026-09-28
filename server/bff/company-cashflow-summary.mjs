import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { FieldPath } from 'firebase-admin/firestore';
import * as z from 'zod/v4';
import { createHttpError } from './bff-utils.mjs';
import { isActiveActorMember, isProjectInActorScope } from './cashflow-project-scope.mjs';
import { weekOrdinal } from './cashflow-coordinates.mjs';
import { accountingEvidence } from '../mcp/accounting-read.mjs';
import { getMonthFinanceWeeks } from '../../src/app/platform/cashflow-week-core.mjs';

export const COMPANY_SUMMARY_LIMITS = Object.freeze({ projects: 200, startMs: 20000, responseMs: 50000, leaseMs: 360000, global: 2, actorPerMinute: 2, globalPerMinute: 12 });
export const COMPANY_SUMMARY_ADMISSION_PATH = '_bff_operational/company_cashflow_summary';
const inputSchema = z.object({ yearMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/), weekNo: z.string().regex(/^[1-5]$/).transform(Number).optional() }).strict();
const modes = ['projection', 'actual', 'difference'];
const metrics = ['inflow', 'outflow', 'cumulativeBalance'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const denied = () => createHttpError(403, '조회 중 권한을 확인하지 못해 자료를 표시하지 않습니다.', 'company_summary_forbidden');
const timeout = () => createHttpError(504, '조회 시간이 초과되었습니다. 잠시 후 다시 확인해 주세요.', 'company_summary_timeout');
const busy = () => createHttpError(429, '전사 조회가 진행 중입니다. 잠시 후 다시 확인해 주세요. 기존 업무는 계속 이용할 수 있습니다.', 'company_summary_busy');
const monotonicWall = () => { const wall = Date.now(); const start = performance.now(); return () => wall + performance.now() - start; };

export function createCompanySummaryAdmission({ db, clock = monotonicWall() }) {
  return { async acquire(context, signal) {
    const ref = db.doc(COMPANY_SUMMARY_ADMISSION_PATH);
    const token = randomUUID();
    const actor = hash(`${context.tenantId}\0${context.actorId}`);
    await db.runTransaction(async (tx) => {
      signal?.throwIfAborted();
      const doc = await tx.get(ref);
      signal?.throwIfAborted();
      const data = doc.data() || {};
      // Firestore read time is shared across instances; the persisted floor also rejects clock rewind.
      const at = Math.max(doc.readTime?.toMillis?.() ?? clock(), data.lastObservedAt || 0);
      const active = (data.active || []).filter((entry) => entry.expiresAt > at);
      const recent = (data.recent || []).filter((entry) => entry.at + 60000 > at);
      if (active.length >= COMPANY_SUMMARY_LIMITS.global || active.some((entry) => entry.actor === actor)) throw busy();
      if (recent.length >= COMPANY_SUMMARY_LIMITS.globalPerMinute || recent.filter((entry) => entry.actor === actor).length >= COMPANY_SUMMARY_LIMITS.actorPerMinute) throw busy();
      tx.set(ref, { schemaVersion: 1, lastObservedAt: at, active: [...active, { token, actor, expiresAt: at + COMPANY_SUMMARY_LIMITS.leaseMs }], recent: [...recent, { actor, at }] });
    });
    return { async release() {
      await db.runTransaction(async (tx) => {
        const data = (await tx.get(ref)).data();
        if (data?.active?.some((entry) => entry.token === token)) tx.set(ref, { ...data, active: data.active.filter((entry) => entry.token !== token) });
      });
    } };
  } };
}

function sum(values, eligible, complete) {
  let amount = 0n;
  let included = 0;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (!Number.isSafeInteger(value)) throw createHttpError(502, '금액 형식을 확인할 수 없습니다.', 'company_summary_amount_invalid');
    amount += BigInt(value); included++;
  }
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER)) throw createHttpError(502, '집계 금액이 지원 범위를 벗어났습니다.', 'company_summary_amount_overflow');
  const partialValue = included ? Number(amount) : null;
  const full = complete && eligible > 0 && included === eligible;
  return { value: full ? partialValue : null, partialValue, included, excluded: eligible - included, complete: full };
}

export function summarizeCompanyCashflowRows({ rows, yearMonth, weekNo, catalogComplete }) {
  const eligible = rows.length;
  const aggregate = (read, valid = true) => Object.fromEntries(modes.map((mode) => [mode, Object.fromEntries(metrics.map((key) => [key,
    sum(valid ? rows.map((row) => read(row, mode)?.[key]) : [], eligible, catalogComplete && valid),
  ]))]));
  const weeks = getMonthFinanceWeeks(yearMonth).filter((week) => !weekNo || week.weekNo === weekNo).map((week) => {
    let observed = 0; let uniform = true;
    for (const row of rows) {
      if (!row.evidence) continue;
      observed++;
      if (row.evidence.yearMonth !== yearMonth || weekOrdinal(row.weeklyYear, yearMonth, week.weekNo) === -1) uniform = false;
      for (const mode of ['projection', 'actual']) {
        const matches = row.evidence[mode]?.filter((item) => item.weekNo === week.weekNo) || [];
        if (matches.length !== 1 || matches[0].start !== week.weekStart || matches[0].end !== week.weekEnd) uniform = false;
      }
    }
    const weekCalendarUniform = observed ? uniform : null;
    const totals = weekCalendarUniform === false ? null : aggregate((row, mode) => {
      if (mode === 'difference') return row.evidence?.difference.weeks.find((item) => item.weekNo === week.weekNo);
      return row.evidence?.[mode]?.find((item) => item.weekNo === week.weekNo)?.totals;
    }, weekCalendarUniform === true);
    return { weekNo: week.weekNo, start: observed ? week.weekStart : null, end: observed ? week.weekEnd : null, weekCalendarUniform, totals };
  });
  const weekCalendarUniform = weeks.some((week) => week.weekCalendarUniform === false) ? false : weeks.every((week) => week.weekCalendarUniform === true) ? true : null;
  const totals = weekNo ? weeks[0]?.totals ?? null : aggregate((row, mode) => mode === 'difference' ? row.evidence?.difference.monthlyTotals : row.evidence?.monthlyTotals?.[mode]);
  return { totals, weeks, weekCalendarUniform };
}

function safeStatus(error) {
  if (error?.code === 'cashflow_accounting_annual_scope' || error?.message === 'accounting_weekly_scope_invalid') return 'OUT_OF_SCOPE';
  return 'FAILED';
}

export function createCompanyCashflowSummary({ db, readSnapshot, now = () => new Date().toISOString(), clock = () => performance.now(), admission = createCompanySummaryAdmission({ db }), startBudgetMs = COMPANY_SUMMARY_LIMITS.startMs, responseBudgetMs = COMPANY_SUMMARY_LIMITS.responseMs }) {
  return async (context, raw, externalSignal) => {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) throw createHttpError(400, '조회 연월과 선택 주차(1~5)를 확인해 주세요.', 'company_summary_invalid');
    if (context?.actorRole !== 'admin' || ![context.tenantId, context.actorId].every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128 && !id.includes('/'))) throw denied();
    const input = parsed.data;
    const controller = new AbortController();
    const started = clock(); const startedAt = now();
    const memberRef = db.doc(`orgs/${context.tenantId}/members/${context.actorId}`);
    const abort = () => controller.abort(externalSignal?.reason || timeout());
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted) abort();
    const check = () => { if (clock() - started >= responseBudgetMs && !controller.signal.aborted) controller.abort(timeout()); controller.signal.throwIfAborted(); };
    let memberIdentity;
    const authorize = async () => {
      check();
      const doc = await memberRef.get(); check();
      const member = doc.data();
      if (!isActiveActorMember(member, context.actorId) || member.role !== 'admin') throw denied();
      const identity = JSON.stringify(member);
      if (memberIdentity !== undefined && memberIdentity !== identity) throw denied();
      memberIdentity = identity;
      return member;
    };
    const catalogRead = async () => {
      check();
      const page = await db.collection(`orgs/${context.tenantId}/projects`).orderBy(FieldPath.documentId()).select('trashedAt').limit(COMPANY_SUMMARY_LIMITS.projects + 1).get();
      check();
      const docs = page.docs.slice(0, COMPANY_SUMMARY_LIMITS.projects);
      return { docs, overflow: page.size > COMPANY_SUMMARY_LIMITS.projects, asOf: page.readTime?.toDate?.().toISOString() ?? null,
        identity: hash(JSON.stringify(page.docs.map((doc) => [doc.id, Boolean(doc.data().trashedAt)]))) };
    };
    let lease;
    const task = (async () => {
      try {
        await authorize();
        lease = await admission.acquire(context, controller.signal); check();
        const catalog = await catalogRead();
        const projects = catalog.docs.filter((doc) => doc.exists && !doc.data().trashedAt);
        const rows = projects.map((doc) => ({ projectId: doc.id, status: 'NOT_ATTEMPTED', weeklyYear: null, evidence: null }));
        for (const row of rows) {
          check();
          if (clock() - started >= startBudgetMs) break;
          const member = await authorize();
          if (!isProjectInActorScope({ role: context.actorRole, members: [member], actorId: context.actorId, projectId: row.projectId })) throw denied();
          check();
          if (clock() - started >= startBudgetMs) break;
          try {
            const snapshot = await readSnapshot({ context, params: { projectId: row.projectId }, query: { yearMonth: input.yearMonth }, signal: controller.signal });
            check();
            row.weeklyYear = snapshot.accountingSource?.weeklyYear ?? null;
            row.evidence = accountingEvidence(snapshot, { projectId: row.projectId, yearMonth: input.yearMonth, ...(input.weekNo ? { weekNo: input.weekNo } : {}), detail: 'summary' }, now());
            row.status = ['projection', 'actual'].some((mode) => row.evidence[mode].some((week) => week.availability === 'AVAILABLE')) ? 'AVAILABLE' : 'NOT_RECORDED';
          } catch (error) {
            check();
            if ([401, 403].includes(error?.statusCode)) throw denied();
            row.status = safeStatus(error); row.evidence = null;
          }
        }
        const finalCatalog = await catalogRead();
        await authorize(); check();
        const catalogStable = finalCatalog.identity === catalog.identity;
        const catalogComplete = !catalog.overflow && catalogStable && catalog.asOf !== null;
        const aggregate = summarizeCompanyCashflowRows({ rows, ...input, catalogComplete });
        check();
        const complete = aggregate.totals !== null && modes.every((mode) => metrics.every((metric) => aggregate.totals[mode][metric].complete));
        const result = { schemaVersion: 1, period: { yearMonth: input.yearMonth, weekNo: input.weekNo ?? null }, amountCurrency: 'KRW',
          scope: 'accessible_registered_projects', totalsScope: complete ? 'COMPLETE_REGISTERED_PROJECTS' : 'PARTIAL_REGISTERED_PROJECTS',
          catalogComplete, catalog: { asOf: catalog.asOf, limit: COMPANY_SUMMARY_LIMITS.projects, enumeratedCount: catalog.docs.length, eligibleCount: rows.length, complete: catalogComplete, stable: catalogStable, knownTotal: catalogComplete ? rows.length : null, projectSetHash: catalog.identity },
          readWindow: { startedAt, finishedAt: now(), atomicSnapshot: false }, ...aggregate,
          counts: { eligible: rows.length, available: rows.filter((row) => row.status === 'AVAILABLE').length, notRecorded: rows.filter((row) => row.status === 'NOT_RECORDED').length, failed: rows.filter((row) => row.status === 'FAILED').length, outOfScope: rows.filter((row) => row.status === 'OUT_OF_SCOPE').length, notAttempted: rows.filter((row) => row.status === 'NOT_ATTEMPTED').length },
          rows: rows.map((row) => ({ projectId: row.projectId, status: row.status, weeklyYear: row.weeklyYear,
            sourceRevision: row.evidence?.source.targetRevision ?? null, retrievedAt: row.evidence?.source.retrievedAt ?? null,
            periodTotals: row.evidence ? Object.fromEntries(modes.map((mode) => [mode, input.weekNo
              ? mode === 'difference' ? Object.fromEntries(metrics.map((key) => [key, row.evidence.difference.weeks.find((week) => week.weekNo === input.weekNo)?.[key] ?? null])) : row.evidence[mode].find((week) => week.weekNo === input.weekNo)?.totals ?? null
              : mode === 'difference' ? row.evidence.difference.monthlyTotals : row.evidence.monthlyTotals[mode]])) : null,
            missingWeeks: row.evidence ? Object.fromEntries(['projection', 'actual'].map((mode) => [mode, row.evidence[mode].filter((week) => week.availability !== 'AVAILABLE').map((week) => week.weekNo)])) : null })),
          calendarAuthority: 'BFF_FIXED_FINANCE_CALENDAR', fieldStateAvailability: 'NOT_EXPOSED', liveSheetVerified: false,
          limitations: ['부분값(partialValue)은 확인된 사업만 포함하며 전사 총액이 아닙니다. 미확인·실패는 0원이 아닙니다.',
            '사업 목록은 최대 200개이며 20초 뒤 새 사업 조회를 시작하지 않습니다. 전체 조회 완료를 보장하지 않습니다.',
            '각 사업은 서로 다른 시점의 JVM 원장입니다. 동시점 확정 결산·은행 잔고나 현재 Sheets 값을 검증한 결과가 아닙니다.',
            '주차 날짜는 BFF 고정 재무 달력 기준입니다. 원본 시트 날짜를 직접 확인한 결과가 아닙니다.'] };
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 256000) throw createHttpError(502, '조회 결과가 지원 크기를 벗어났습니다.', 'company_summary_response_too_large');
        check();
        return result;
      } finally {
        // Only this task's settlement releases admission; an HTTP timeout or disconnect alone does not.
        if (lease) await lease.release().catch(() => {});
      }
    })();
    let timer; let onAbort;
    try {
      const result = await Promise.race([task, new Promise((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason || timeout());
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
        timer = setTimeout(() => controller.abort(timeout()), responseBudgetMs);
        timer.unref?.();
      })]);
      check();
      return result;
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort);
      externalSignal?.removeEventListener('abort', abort);
    }
  };
}

export function mountCompanyCashflowSummary(app, { asyncHandler, ...dependencies }) {
  const query = createCompanyCashflowSummary(dependencies);
  app.get('/api/v1/company-cashflow-summary', asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const controller = new AbortController();
    const abort = () => controller.abort(timeout());
    const close = () => { if (!res.writableEnded) abort(); };
    req.once('aborted', abort); res.once('close', close);
    try { res.json(await query(req.context, req.query, controller.signal)); }
    finally { req.off('aborted', abort); res.off('close', close); }
  }));
}
