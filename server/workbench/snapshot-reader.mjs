import { createHttpError } from '../bff/bff-utils.mjs';

export function createWorkbenchSnapshotReader({ db, now = Date.now }) {
  return async ({ context, params, query, signal }) => {
    signal.throwIfAborted();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(params.projectId) || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(query.yearMonth)) {
      throw createHttpError(400, '사업과 조회 연월을 확인해 주세요.', 'workbench_snapshot_invalid');
    }
    const document = (await db.doc(`orgs/${context.tenantId}/workbench_snapshots/${params.projectId}-${query.yearMonth}`).get()).data();
    signal.throwIfAborted();
    if (!document || !document.snapshot || !document.sourceRevision || !Number.isFinite(Date.parse(document.capturedAt))) {
      throw createHttpError(503, '분석용 자료가 아직 도착하지 않았습니다. 기존 업무 화면은 계속 이용할 수 있습니다.', 'workbench_snapshot_unavailable');
    }
    if (Date.parse(document.capturedAt) > now() || now() - Date.parse(document.capturedAt) > 86400000) {
      throw createHttpError(503, '분석용 자료의 갱신이 지연되었습니다. 운영 시스템으로 추가 조회하지 않습니다.', 'workbench_snapshot_stale');
    }
    return structuredClone(document.snapshot);
  };
}
