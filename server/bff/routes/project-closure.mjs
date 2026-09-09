import { randomUUID } from 'node:crypto';
import { createHttpError, createMutatingRoute, normalizeRole, readOptionalText } from '../bff-utils.mjs';

function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw createHttpError(400, '프로젝트 또는 요청 식별자를 확인해 주세요.', 'project_closure_invalid_id');
  }
  return value;
}

function validDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function validVersion(value) {
  return Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
}

function submission(body) {
  const date = readOptionalText(body.retentionStartDate);
  if (!validDate(date)
    || !Number.isSafeInteger(body.retentionPeriodYears) || body.retentionPeriodYears < 1 || body.retentionPeriodYears > 100) {
    throw createHttpError(400, '보관 기산일과 보관 기간을 확인해 주세요.', 'project_closure_retention_invalid');
  }
  const fields = ['driveFolderLink', 'handoverNote', 'driveDeletedAt', 'note'];
  const output = { retentionStartDate: date, retentionPeriodYears: body.retentionPeriodYears };
  for (const field of fields) {
    if (body[field] != null && (typeof body[field] !== 'string' || body[field].length > 4000)) {
      throw createHttpError(400, '종료 신청 내용을 확인해 주세요.', 'project_closure_submission_invalid');
    }
    output[field] = readOptionalText(body[field]);
  }
  if (output.driveFolderLink) {
    let url;
    try { url = new URL(output.driveFolderLink); } catch { /* rejected below */ }
    if (!url || url.protocol !== 'https:' || !['drive.google.com', 'docs.google.com'].includes(url.hostname)) {
      throw createHttpError(400, 'Google Drive 링크를 입력해 주세요.', 'project_closure_drive_link_invalid');
    }
  }
  if (output.driveDeletedAt && !validDate(output.driveDeletedAt)) {
    throw createHttpError(400, '드라이브 정리일을 확인해 주세요.', 'project_closure_submission_invalid');
  }
  return output;
}

async function readActor(tx, db, tenantId, actorId) {
  const snap = await tx.get(db.doc(`orgs/${tenantId}/members/${actorId}`));
  const member = snap.data();
  if (!snap.exists || member.status !== 'ACTIVE') {
    throw createHttpError(403, '활성 구성원만 종료 요청을 처리할 수 있습니다.', 'project_closure_forbidden');
  }
  return member;
}

function assertProject(project, tenantId, projectId) {
  if (!project || project.trashedAt || (project.id && project.id !== projectId)
    || (project.tenantId && project.tenantId !== tenantId)) {
    throw createHttpError(404, '프로젝트를 확인할 수 없습니다.', 'project_closure_not_found');
  }
}

export function mountProjectClosureRoutes(app, { db, idempotencyService, now }) {
  app.post('/api/v1/projects/:projectId/closure-requests', createMutatingRoute(idempotencyService, async (req) => {
    const { tenantId, actorId, actorEmail } = req.context;
    const projectId = id(req.params.projectId);
    const details = submission(req.body);
    if (!validVersion(req.body.expectedProjectVersion)) {
      throw createHttpError(400, '프로젝트 버전을 확인해 주세요.', 'project_closure_version_invalid');
    }
    const projectRef = db.doc(`orgs/${tenantId}/projects/${projectId}`);
    const requestId = `closure-${randomUUID()}`;
    const requestRef = db.doc(`orgs/${tenantId}/project_requests/${requestId}`);
    const timestamp = now();
    const item = await db.runTransaction(async (tx) => {
      const member = await readActor(tx, db, tenantId, actorId);
      const project = (await tx.get(projectRef)).data();
      assertProject(project, tenantId, projectId);
      if (![project.managerId, project.registeredById, project.executiveApproverId].includes(actorId)
        && !['admin', 'finance'].includes(normalizeRole(member.role))) {
        throw createHttpError(403, '이 프로젝트의 종료 신청 권한이 없습니다.', 'project_closure_forbidden');
      }
      if (Object.hasOwn(project, 'closure')) {
        throw createHttpError(409, '이미 종료 승인된 프로젝트입니다.', 'project_closed');
      }
      if (!validVersion(project.version) || project.version !== req.body.expectedProjectVersion) {
        throw createHttpError(409, '프로젝트가 변경되었습니다. 새로고침 후 다시 신청해 주세요.', 'version_conflict');
      }
      if (!readOptionalText(project.executiveApproverId)) {
        throw createHttpError(409, '지정 조직장을 먼저 확인해 주세요.', 'executive_approver_required');
      }
      if (project.closureRequestId) {
        const pending = (await tx.get(db.doc(`orgs/${tenantId}/project_requests/${id(project.closureRequestId)}`))).data();
        if (!pending || pending.status === 'PENDING') {
          throw createHttpError(409, '진행 중인 사업 종료 요청을 먼저 확인해 주세요.', 'project_closure_pending');
        }
      }
      const version = project.version + 1;
      const result = {
        id: requestId, tenantId, requestKind: 'CLOSURE', targetProjectId: projectId,
        status: 'PENDING', requestVersion: 1, baseProjectVersion: version,
        payload: project, closureSubmission: details,
        requestedBy: actorId, requestedByName: member.name || actorId, requestedByEmail: actorEmail || '',
        requestedAt: timestamp, updatedAt: timestamp,
      };
      tx.create(requestRef, result);
      tx.update(projectRef, { closureRequestId: requestId, version, updatedAt: timestamp });
      return result;
    });
    return { status: 201, body: { item } };
  }));

  app.post('/api/v1/projects/:projectId/closure-requests/:requestId/review', createMutatingRoute(idempotencyService, async (req) => {
    const { tenantId, actorId } = req.context;
    const projectId = id(req.params.projectId);
    const requestId = id(req.params.requestId);
    const { decision, expectedRequestVersion } = req.body;
    const comment = readOptionalText(req.body.comment);
    if (!['APPROVED', 'REJECTED'].includes(decision) || comment.length > 4000 || (decision === 'REJECTED' && !comment)) {
      throw createHttpError(400, '검토 결과와 보완 사유를 확인해 주세요.', 'project_closure_review_invalid');
    }
    const timestamp = now();
    const projectRef = db.doc(`orgs/${tenantId}/projects/${projectId}`);
    const requestRef = db.doc(`orgs/${tenantId}/project_requests/${requestId}`);
    const item = await db.runTransaction(async (tx) => {
      const member = await readActor(tx, db, tenantId, actorId);
      const project = (await tx.get(projectRef)).data();
      const current = (await tx.get(requestRef)).data();
      assertProject(project, tenantId, projectId);
      if (!current || current.requestKind !== 'CLOSURE' || current.targetProjectId !== projectId || current.tenantId !== tenantId) {
        throw createHttpError(404, '종료 요청을 찾을 수 없습니다.', 'project_closure_not_found');
      }
      if (!current.payload || !current.closureSubmission || !validVersion(project.version)
        || !validVersion(current.requestVersion) || !validVersion(expectedRequestVersion)) {
        throw createHttpError(409, '검토 자료와 버전을 확인해 주세요.', 'project_closure_version_conflict');
      }
      if (project.executiveApproverId !== actorId || (decision === 'APPROVED' && current.payload.executiveApproverId !== actorId)) {
        throw createHttpError(403, '지정 조직장만 사업 종료를 승인할 수 있습니다.', 'executive_approver_mismatch');
      }
      // A lost response can be retried with a new transport key without another approval write.
      if (current.status === decision && current.reviewedBy === actorId && current.reviewComment === comment
        && current.requestVersion === expectedRequestVersion + 1) return current;
      if (current.status !== 'PENDING' || current.requestVersion !== expectedRequestVersion
        || (decision === 'APPROVED' && project.version !== current.baseProjectVersion)
        || project.closureRequestId !== requestId || Object.hasOwn(project, 'closure')) {
        throw createHttpError(409, '검토 대상이 변경되었습니다. 최신 요청을 다시 확인해 주세요.', 'project_closure_version_conflict');
      }
      const result = { ...current, status: decision, requestVersion: current.requestVersion + 1,
        reviewOutcome: decision === 'APPROVED' ? 'APPROVED' : 'REVISION_REJECTED',
        reviewedBy: actorId, reviewedByName: member.name || actorId, reviewedAt: timestamp,
        reviewComment: comment, updatedAt: timestamp };
      tx.set(requestRef, result);
      tx.create(db.doc(`orgs/${tenantId}/project_closure_reviews/${requestId}`), {
        requestId, projectId, actorId, decision, comment, reviewedAt: timestamp,
        submission: current.closureSubmission, baseProjectVersion: current.baseProjectVersion,
      });
      if (decision === 'APPROVED') {
        tx.update(projectRef, { status: 'COMPLETED', version: project.version + 1, updatedAt: timestamp,
          closure: { contractVersion: 'project-closure-v1', requestId, approvedAt: timestamp, approvedBy: actorId } });
      }
      return result;
    });
    return { body: { item } };
  }));
}
