import { resolveWorkbenchRuntime } from './runtime-config.mjs';
import { createWorkbenchSnapshotReader } from './snapshot-reader.mjs';
import { createQaEvidenceService } from '../bff/qa-evidence.mjs';
import { createPersonalWorkPageService } from '../bff/personal-work-pages.mjs';
import { createCashflowEvidenceQuery } from '../bff/cashflow-evidence-query.mjs';
import { createInsightCashflowReport } from '../bff/insight-cashflow-report.mjs';
import { createHttpError } from '../bff/bff-utils.mjs';
import { createHash } from 'node:crypto';
import { createHttpLogEvidence } from './http-log-evidence.mjs';

export function createIsolatedWorkbenchCore({ env, db, now = () => new Date().toISOString(), readCode }) {
  const runtime = resolveWorkbenchRuntime(env);
  if (db.projectId !== runtime.projectId) throw new Error('Workbench store does not match its isolated project.');
  const readSnapshot = createWorkbenchSnapshotReader({ db, now: () => Date.parse(now()) });
  const evidence = createCashflowEvidenceQuery({ db, now, readSnapshot });
  const authorize = async (context) => {
    if (![context.actorId, context.tenantId].every((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw createHttpError(403, '로그인 정보를 확인해 주세요.', 'workbench_identity_invalid');
    const member = (await db.doc(`orgs/${context.tenantId}/members/${context.actorId}`).get()).data();
    const age = Date.parse(now()) - Date.parse(member?.permissionsCapturedAt);
    if (!member || member.status !== 'ACTIVE' || member.role !== context.actorRole || !Number.isFinite(age) || age < 0 || age > 300000) {
      throw createHttpError(403, '분석 도구의 권한 정보가 갱신되지 않았습니다. 기존 업무 화면은 계속 이용할 수 있습니다.', 'workbench_permissions_stale');
    }
    const datasetIds = Array.isArray(member.analyticsDatasetIds) && typeof member.analyticsScopeRevision === 'string'
      ? [...new Set(member.analyticsDatasetIds.filter((id) => typeof id === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(id)))].sort() : [];
    const fingerprint = createHash('sha256').update(JSON.stringify([context.tenantId, context.actorId, context.actorRole, datasetIds, member.analyticsScopeRevision || null])).digest('hex');
    if (context.analyticsScope && context.analyticsScope.fingerprint !== fingerprint) throw createHttpError(403, '조회 가능한 자료 범위가 변경되었습니다. 새 요청으로 다시 확인해 주세요.', 'workbench_scope_changed');
    context.analyticsScope = { fingerprint, datasetIds };
    return context.analyticsScope;
  };
  const guarded = (query) => async (context, ...args) => {
    await authorize(context);
    const result = await query(context, ...args);
    await authorize(context);
    return result;
  };
  const httpLogs = createHttpLogEvidence({ db, env, now, authorize });
  const qa = createQaEvidenceService({ db, now, readCode, readHttpEvidence: httpLogs.findRequest });
  return {
    runtime, authorize, httpLogs,
    pages: createPersonalWorkPageService({ db, now }),
    qa: guarded(qa), evidence: guarded(evidence),
    report: guarded(createInsightCashflowReport({ db, now, readSnapshot })),
  };
}
