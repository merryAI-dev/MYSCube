import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { mountProjectClosureDriveRoutes } from './routes/project-closure-drive.mjs';
import { createGoogleSheetsService } from './google-sheets.mjs';

const rootId = 'canonical_project_root';
const link = `https://drive.google.com/drive/folders/${rootId}`;
function harness({ member = { status: 'ACTIVE', role: 'member' }, project = { registeredById: 'actor', businessManagementGoogleFolderLink: link }, list = vi.fn(async () => ({ items: [], nextPageToken: null })), verifyGoogleAccess = async () => {} } = {}) {
  const app = express();
  app.use((req, _res, next) => { req.context = { tenantId: 'tenant', actorId: 'actor', actorRole: 'admin', authSource: 'firebase', googleSubject: 'google-person' }; next(); });
  const db = { doc: (path) => ({ get: async () => {
    const data = path.includes('/members/') ? member : project;
    return { exists: !!data, data: () => data };
  } }) };
  mountProjectClosureDriveRoutes(app, { db, googleSheetsService: { listDriveFolderMetadata: list }, verifyGoogleAccess });
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ code: error.code }));
  return { app, list };
}

describe('project closure Drive boundary', () => {
  it('real authentication rejects missing user bearer without calling Drive', async () => {
    const { verifyClosureGoogleAccess } = await import('./project-closure-google-auth.mjs');
    const { app, list } = harness({ verifyGoogleAccess: verifyClosureGoogleAccess });
    const response = await request(app).get('/api/v1/projects/project/closure-drive');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('project_closure_google_reconnect');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(list).not.toHaveBeenCalled();
  });
  it('lists only the saved root and passes bounded pagination', async () => {
    const { app, list } = harness();
    const response = await request(app).get('/api/v1/projects/project/closure-drive').set('x-google-access-token', 'user-token').query({ link, pageSize: 20, pageToken: 'opaque-token' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [], nextPageToken: null, rootFolderId: rootId });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(list).toHaveBeenCalledWith({ folderId: rootId, pageSize: 20, pageToken: 'opaque-token', accessToken: 'user-token' });
  });
  it.each([
    { member: { status: 'INACTIVE', role: 'admin' } },
    { member: { status: 'ACTIVE', role: 'member' }, project: { registeredById: 'someone-else', businessManagementGoogleFolderLink: link } },
    { member: null },
  ])('denies inactive and unauthorized members despite the header role', async (options) => {
    const { app, list } = harness(options);
    expect((await request(app).get('/api/v1/projects/project/closure-drive')).status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });
  it.each(['https://drive.google.com/drive/folders/other_project_root', 'https://drive.google.com.evil.test/drive/folders/secret', 'https://evil@drive.google.com/drive/folders/canonical_project_root', 'http://drive.google.com/drive/folders/canonical_project_root'])('rejects arbitrary or deceptive links: %s', async (value) => {
    const { app, list } = harness();
    expect((await request(app).get('/api/v1/projects/project/closure-drive').query({ link: value })).status).toBeGreaterThanOrEqual(400);
    expect(list).not.toHaveBeenCalled();
  });
  it('does not treat an unlinked project as an empty folder', async () => {
    const { app, list } = harness({ project: { registeredById: 'actor' } });
    expect((await request(app).get('/api/v1/projects/project/closure-drive')).status).toBe(409);
    expect(list).not.toHaveBeenCalled();
  });
  it.each([0, 101, -1, '1.5', 'invalid'])('rejects unbounded pagination %s', async (pageSize) => {
    const { app, list } = harness();
    expect((await request(app).get('/api/v1/projects/project/closure-drive').query({ pageSize })).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });
  it.each(['admin', 'finance'])('uses the stored %s role', async (role) => {
    const { app } = harness({ member: { status: 'ACTIVE', role }, project: { businessManagementGoogleFolderLink: link } });
    expect((await request(app).get('/api/v1/projects/project/closure-drive')).status).toBe(200);
  });
  it('allows the designated reviewer and a provisioned project root', async () => {
    const { app, list } = harness({ project: { executiveApproverId: 'actor', evidenceDriveRootFolderId: rootId } });
    expect((await request(app).get('/api/v1/projects/project/closure-drive')).status).toBe(200);
    expect(list).toHaveBeenCalledWith({ folderId: rootId, pageSize: 50, pageToken: '', accessToken: undefined });
  });
  it.each([{ tenantId: 'other' }, { trashedAt: '2026-01-01' }, { id: 'other' }])('rejects mismatched or trashed project records', async (fields) => {
    const { app, list } = harness({ project: { registeredById: 'actor', businessManagementGoogleFolderLink: link, ...fields } });
    expect((await request(app).get('/api/v1/projects/project/closure-drive')).status).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('Drive metadata transport', () => {
  function service(fetchImpl) {
    return createGoogleSheetsService({ fetchImpl, config: { enabled: false } });
  }
  it('checks the folder and fetches depth-one metadata only, preserving pagination', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: rootId, mimeType: 'application/vnd.google-apps.folder', trashed: false })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: 'child', name: '정산서', mimeType: 'application/pdf', modifiedTime: '2026-01-01T00:00:00Z' }], nextPageToken: 'next' })));
    const result = await service(fetchImpl).listDriveFolderMetadata({ folderId: rootId, pageSize: 25, pageToken: 'prev', accessToken: 'user-token' });
    expect(result.items).toHaveLength(1);
    expect(result.nextPageToken).toBe('next');
    const url = new URL(fetchImpl.mock.calls[1][0]);
    expect(url.origin).toBe('https://www.googleapis.com');
    expect(url.searchParams.get('q')).toBe(`'${rootId}' in parents and trashed = false`);
    expect(url.searchParams.get('pageSize')).toBe('25');
    expect(url.searchParams.get('pageToken')).toBe('prev');
    expect(url.searchParams.get('fields')).not.toMatch(/content|exportLinks|shortcutDetails/);
    expect(fetchImpl.mock.calls.every(([, init]) => !init.method || init.method === 'GET')).toBe(true);
    expect(fetchImpl.mock.calls.every(([, init]) => init.headers.authorization === 'Bearer user-token')).toBe(true);
  });
  it.each([[403, 'project_closure_drive_forbidden'], [404, 'project_closure_drive_not_found'], [503, 'project_closure_drive_unavailable']])('distinguishes upstream %i', async (status, code) => {
    await expect(service(vi.fn(async () => new Response('{}', { status }))).listDriveFolderMetadata({ folderId: rootId, accessToken: 'user-token' })).rejects.toMatchObject({ code });
  });
  it.each([{ mimeType: 'application/pdf' }, { mimeType: 'application/vnd.google-apps.folder', trashed: true }])('rejects files and trashed folders without listing their contents', async (root) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(root)));
    await expect(service(fetchImpl).listDriveFolderMetadata({ folderId: rootId, accessToken: 'user-token' })).rejects.toMatchObject({ code: 'project_closure_drive_not_folder' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('rejects query injection before fetching', async () => {
    const fetchImpl = vi.fn();
    await expect(service(fetchImpl).listDriveFolderMetadata({ folderId: "root' or true" })).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('exposes a real empty list through the route without swallowing incomplete searches', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url) => new Response(JSON.stringify(
      new URL(url).pathname.endsWith(`/files/${rootId}`) ? { mimeType: 'application/vnd.google-apps.folder' } : { files: [] },
    )));
    const { app } = harness({ list: service(fetchImpl).listDriveFolderMetadata });
    const result = await request(app).get('/api/v1/projects/project/closure-drive').set('x-google-access-token', 'user-token');
    expect(result.status).toBe(200);
    expect(result.body.items).toEqual([]);
    fetchImpl.mockReset().mockResolvedValueOnce(new Response(JSON.stringify({ mimeType: 'application/vnd.google-apps.folder' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [], incompleteSearch: true })));
    expect((await request(app).get('/api/v1/projects/project/closure-drive').set('x-google-access-token', 'user-token')).status).toBe(503);
  });
  it('never falls back to service credentials when the user token is absent', async () => {
    const fetchImpl = vi.fn();
    const metadataFactory = vi.fn();
    const google = createGoogleSheetsService({ fetchImpl, driveMetadataAuthHeadersFactory: metadataFactory, config: { enabled: true, serviceAccount: { client_email: 'server', private_key: 'not-used' } } });
    await expect(google.listDriveFolderMetadata({ folderId: rootId })).rejects.toMatchObject({ code: 'project_closure_google_reconnect' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(metadataFactory).not.toHaveBeenCalled();
  });
});
