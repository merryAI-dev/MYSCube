import { describe, expect, it } from 'vitest';
import { buildMigrationAuditConsoleRecords, deriveMigrationAuditStatus, resolveMigrationReviewApproverId } from './project-migration-console';
import { resolveProjectRequestKind } from './project-change-request';
import type { Project, ProjectRequest } from '../data/types';

const project = { id: 'p1', name: '종료 검토', status: 'COMPLETED', executiveReviewStatus: 'APPROVED' } as Project;
const closure = { id: 'c1', requestKind: 'CLOSURE', targetProjectId: 'p1', status: 'PENDING',
  payload: { name: '종료 검토' }, requestedAt: '2026-09-09' } as unknown as ProjectRequest;

describe('closure in the existing project review panel', () => {
  it('routes a stale closure to the current head so it can be returned', () => {
    expect(resolveMigrationReviewApproverId({ ...project, executiveApproverId: 'new-head' },
      { ...closure, payload: { ...closure.payload, executiveApproverId: 'old-head' } })).toBe('new-head');
  });
  it('preserves closure as a distinct request kind', () => {
    expect(resolveProjectRequestKind(closure)).toBe('CLOSURE');
  });
  it('does not inherit an approved registration seal', () => {
    expect(deriveMigrationAuditStatus(project, closure)).toBe('PENDING');
  });
  it('keeps registration and closure visible as separate review records', () => {
    const registration = { ...closure, id: 'r1', requestKind: 'REGISTRATION', status: 'APPROVED' } as ProjectRequest;
    const records = buildMigrationAuditConsoleRecords([project], [closure, registration]);
    expect(records.map((record) => record.request?.id).sort()).toEqual(['c1', 'r1']);
  });
});
