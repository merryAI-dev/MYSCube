import { asyncHandler, createHttpError, normalizeRole } from '../bff-utils.mjs';
import { verifyClosureGoogleAccess } from '../project-closure-google-auth.mjs';

function folderId(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com' || url.username || url.password || url.port) return '';
    return url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{1,200})\/?$/)?.[1] || '';
  } catch { return ''; }
}

export function mountProjectClosureDriveRoutes(app, { db, googleSheetsService, verifyGoogleAccess = verifyClosureGoogleAccess }) {
  app.get('/api/v1/projects/:projectId/closure-drive', asyncHandler(async (req, res) => {
    res.setHeader('cache-control', 'private, no-store');
    const { tenantId, actorId } = req.context;
    const { projectId } = req.params;
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(projectId)) {
      throw createHttpError(400, '프로젝트 식별자를 확인해 주세요.', 'project_closure_invalid_id');
    }
    const member = (await db.doc(`orgs/${tenantId}/members/${actorId}`).get()).data();
    if (!member || member.status !== 'ACTIVE') {
      throw createHttpError(403, '활성 구성원만 자료 목록을 확인할 수 있습니다.', 'project_closure_forbidden');
    }
    const project = (await db.doc(`orgs/${tenantId}/projects/${projectId}`).get()).data();
    if (!project || project.trashedAt || (project.tenantId && project.tenantId !== tenantId) || (project.id && project.id !== projectId)) {
      throw createHttpError(404, '프로젝트를 확인할 수 없습니다.', 'project_closure_not_found');
    }
    if (![project.managerId, project.registeredById, project.executiveApproverId].includes(actorId)
      && !['admin', 'finance'].includes(normalizeRole(member.role))) {
      throw createHttpError(403, '이 프로젝트의 자료 조회 권한이 없습니다.', 'project_closure_forbidden');
    }
    const roots = [folderId(project.businessManagementGoogleFolderLink), folderId(project.evidenceDriveRootFolderLink)];
    if (typeof project.evidenceDriveRootFolderId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(project.evidenceDriveRootFolderId)) {
      roots.push(project.evidenceDriveRootFolderId);
    }
    const rootFolderId = req.query.link === undefined ? roots.find(Boolean) : folderId(req.query.link);
    if (req.query.link !== undefined && (!rootFolderId || !roots.includes(rootFolderId))) {
      throw createHttpError(403, '프로젝트에 연결된 폴더만 조회할 수 있습니다.', 'project_closure_drive_forbidden');
    }
    if (!rootFolderId) {
      throw createHttpError(409, '프로젝트에 연결된 Drive 폴더가 없습니다.', 'project_closure_drive_unlinked');
    }
    const pageSize = req.query.pageSize === undefined ? 50 : Number(req.query.pageSize);
    const pageToken = req.query.pageToken === undefined ? '' : req.query.pageToken;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
      || typeof pageToken !== 'string' || pageToken.length > 2048) {
      throw createHttpError(400, '목록 조회 범위를 확인해 주세요.', 'project_closure_drive_pagination_invalid');
    }
    if (typeof googleSheetsService?.listDriveFolderMetadata !== 'function') {
      throw createHttpError(503, 'Drive 자료 목록을 지금 확인할 수 없습니다.', 'project_closure_drive_unavailable');
    }
    const accessToken = req.header('x-google-access-token');
    await verifyGoogleAccess(accessToken, req.context);
    const result = await googleSheetsService.listDriveFolderMetadata({ folderId: rootFolderId, pageSize, pageToken, accessToken });
    res.setHeader('cache-control', 'private, no-store');
    res.status(200).json({ ...result, rootFolderId });
  }));
}
