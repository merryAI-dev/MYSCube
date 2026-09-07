import { describe, expect, it, vi } from 'vitest';
import { buildProjectRequestPayloadFromProject } from './routes/projects.mjs';
import {
  applyProjectChangeNormalizationPlan,
  buildProjectChangeNormalizationReport,
} from '../../scripts/normalize-project-change-requests.mjs';

const tenantId = 'mysc';
const projectId = 'project-a';
const projectPath = `orgs/${tenantId}/projects/${projectId}`;
const requestPath = `orgs/${tenantId}/project_requests/change-${projectId}`;
const attachment = {
  attachmentId: 'contract-a',
  path: `orgs/${tenantId}/project-registration-documents/${projectId}/contract-a.pdf`,
  name: 'contract-a.pdf',
  size: 12,
  contentType: 'application/pdf',
};

function source(path, data, updateTime) {
  return { path, data: structuredClone(data), updateTime };
}

function fixture() {
  const project = {
    id: projectId,
    version: 7,
    name: '제출된 이름',
    type: 'C1',
    status: 'IN_PROGRESS',
    phase: 'CONFIRMED',
    contractDocument: attachment,
  };
  const proposedSnapshot = buildProjectRequestPayloadFromProject(project);
  const request = {
    id: `change-${projectId}`,
    tenantId,
    requestKind: 'CHANGE',
    status: 'PENDING',
    approvedProjectId: projectId,
    baseProjectVersion: 6,
    requestVersion: 3,
    proposedSnapshot,
    payload: proposedSnapshot,
    requestedBy: 'pm-a',
    requestedAt: '2026-09-01T00:00:00.000Z',
  };
  return { project, request };
}

async function reportFor({ mutateProject, inspectAttachment } = {}) {
  const { project, request } = fixture();
  mutateProject?.(project);
  return buildProjectChangeNormalizationReport({
    firebaseProjectId: 'demo-project',
    tenantId,
    generatedAt: '2026-09-07T00:00:00.000Z',
    projects: [source(projectPath, project, '70:0')],
    requests: [source(requestPath, request, '30:0')],
    inspectAttachment: inspectAttachment || vi.fn(async () => attachment),
  });
}

function fakeDb(project, request, requestUpdateTime = '30:0') {
  const records = new Map([
    [projectPath, { data: structuredClone(project), updateTime: '70:0' }],
    [requestPath, { data: structuredClone(request), updateTime: requestUpdateTime }],
  ]);
  const writes = [];
  return {
    writes,
    doc: (path) => ({ path }),
    runTransaction: async (callback) => {
      const staged = [];
      const result = await callback({
        get: async (ref) => {
          const record = records.get(ref.path);
          return {
            exists: Boolean(record),
            data: () => structuredClone(record?.data),
            updateTime: record?.updateTime,
          };
        },
        set: (ref, patch, options) => staged.push({ path: ref.path, patch, options }),
      });
      staged.forEach(({ path, patch, options }) => {
        writes.push({ path, patch: structuredClone(patch), options });
        records.get(path).data = { ...records.get(path).data, ...structuredClone(patch) };
      });
      return result;
    },
  };
}

describe('project change request normalization', () => {
  it.each([
    ['safe missing target', {}, 'SAFE', []],
    ['changed project snapshot', { mutateProject: (project) => { project.name = '나중에 바뀐 이름'; } }, 'STALE', ['project_snapshot_mismatch']],
    ['missing attachment', { inspectAttachment: vi.fn(async () => { throw new Error('not found'); }) }, 'STALE', ['attachment_unavailable']],
    ['mismatched attachment', { inspectAttachment: vi.fn(async () => ({ ...attachment, size: 13 })) }, 'STALE', ['attachment_mismatch']],
  ])('classifies %s without changing source records', async (_label, options, classification, reasons) => {
    const report = await reportFor(options);

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ classification, reasons });
    expect(report.rows[0].request).toMatchObject({ path: requestPath, updateTime: '30:0' });
    expect(report.rows[0].project).toMatchObject({ path: projectPath, updateTime: '70:0' });
    expect(report.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('patches only the frozen safe request and rejects a changed update time with zero writes', async () => {
    const report = await reportFor();
    const { project, request } = fixture();
    const db = fakeDb(project, request);

    await applyProjectChangeNormalizationPlan({
      db,
      plan: report,
      reason: 'approved normalization',
      now: () => '2026-09-07T01:00:00.000Z',
    });

    expect(db.writes).toEqual([{
      path: requestPath,
      patch: {
        baseProjectVersion: 7,
        targetProjectVersion: 8,
        beforeSnapshot: report.rows[0].currentProjectSnapshot,
        updatedAt: '2026-09-07T01:00:00.000Z',
      },
      options: { merge: true },
    }]);

    const staleDb = fakeDb(project, request, '31:0');
    await expect(applyProjectChangeNormalizationPlan({
      db: staleDb,
      plan: report,
      reason: 'approved normalization',
      now: () => '2026-09-07T01:00:00.000Z',
    })).rejects.toThrow('changed since dry-run');
    expect(staleDb.writes).toEqual([]);
  });
});
