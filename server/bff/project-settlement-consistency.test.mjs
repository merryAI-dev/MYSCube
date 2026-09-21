import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { projectSettlementConsistencyIssue } from '../../src/app/platform/project-settlement-consistency.mjs';
import { buildProjectInfoDraftSeed, buildProjectInfoChangeSubmission, buildProjectPatchFromChangeRequestPayload, buildProjectRequestPayloadFromProject, mountProjectRoutes } from './routes/projects.mjs';
import { projectReviewVersionToken } from './project-review-version.mjs';
import { buildProjectReviewReadiness, mapProjectReviewReadinessError } from './project-review-readiness.mjs';

describe('legacy settlement meaning preservation', () => {
  it.each(['공급가액', '공급대가', '기타', 'SUPPLY_AMOUNT', 'SUPPLY_PRICE', 'OTHER'])('rejects implicit removal of %s on approval while retaining the input', basis => {
    const payload = { settlementType: 'NONE', basis };
    const before = structuredClone(payload);
    expect(() => buildProjectPatchFromChangeRequestPayload(payload)).toThrow(/정산 유형.*정산 없음.*정산 기준/);
    expect(payload).toEqual(before);
    expect(projectSettlementConsistencyIssue(payload)).toMatchObject({ code: 'project_settlement_basis_conflict', severity: 'blocking', field: 'basis' });
  });
  it.each([undefined, '', 'unrecognized'])('does not turn a missing or unrecognized settlement type %s into an effective approval', settlementType => {
    expect(() => buildProjectPatchFromChangeRequestPayload({ settlementType, basis: '공급대가' })).toThrow(/최종 제출/);
  });
  it.each(['TYPE1', 'TYPE2', 'TYPE3', 'TYPE4', 'TYPE5'])('preserves a valid legacy type %s and its basis', settlementType => {
    expect(projectSettlementConsistencyIssue({ settlementType, basis: '공급대가' })).toBeNull();
    expect(buildProjectPatchFromChangeRequestPayload({ settlementType, basis: '공급대가' })).toMatchObject({ settlementType, basis: '공급대가' });
  });
  it.each([{}, { settlementType: 'NONE', basis: 'NONE' }, { settlementType: 'TYPE1', basis: 'NONE' }])('does not add restrictions to unrelated legacy combinations %j', payload => {
    expect(projectSettlementConsistencyIssue(payload)).toBeNull();
    expect(buildProjectPatchFromChangeRequestPayload(payload).basis).toBe(payload.basis);
  });
  it('retains the independent version 2 basis policy and explicit version ownership', () => {
    const payload = { registrationRequirementsVersion: 2, settlementType: 'NONE', basis: '공급대가' };
    expect(projectSettlementConsistencyIssue(payload)).toBeNull();
    expect(buildProjectPatchFromChangeRequestPayload(payload, { registrationRequirementsVersion: 2 }).basis).toBe('공급대가');
    expect(projectSettlementConsistencyIssue({ settlementType: 'NONE', basis: '공급대가' }, { registrationRequirementsVersion: 2 })).toBeNull();
    expect(projectSettlementConsistencyIssue({ ...payload, registrationRequirementsVersion: 1 }, { registrationRequirementsVersion: 2 })).not.toBeNull();
  });
  it('opens the original pending draft with its basis and settlement details intact', () => {
    const payload = { settlementType: 'NONE', basis: '공급대가', accountType: 'DEDICATED', settlementSystem: 'E_NARA_DOUM', laborSettlementBasis: 'ACTUAL' };
    const project = { settlementType: 'TYPE2', basis: '공급가액', version: 20 };
    const request = { requestKind: 'CHANGE', status: 'PENDING', proposedSnapshot: payload };
    const before = structuredClone({ payload, project, request });
    const result = buildProjectInfoDraftSeed(project, request);
    expect(result).toMatchObject({ settlementType: 'NONE', basis: '공급대가', accountType: 'DEDICATED', settlementSystem: 'E_NARA_DOUM' });
    expect(buildProjectRequestPayloadFromProject(payload)).toMatchObject({ settlementType: 'NONE', basis: '공급대가' });
    expect({ payload, project, request }).toEqual(before);
  });
  it('explains the conflict on final submission instead of accepting a coerced value', () => {
    expect(() => buildProjectInfoChangeSubmission({ project: {}, payload: { settlementType: 'NONE', basis: '공급대가' } })).toThrow(/작성자.*최종 제출/);
  });
  it('shows the pending conflict before approval and warns on history without changing the document', () => {
    const proposedSnapshot = { settlementType: 'NONE', basis: '공급대가' };
    const request = { requestKind: 'CHANGE', status: 'PENDING', proposedSnapshot, payload: { basis: 'NONE' } };
    const before = structuredClone(request);
    const issue = buildProjectReviewReadiness(request, {}).issues.find(i => i.code === 'project_settlement_basis_conflict');
    expect(issue).toMatchObject({ severity: 'blocking', field: 'basis' });
    expect(issue.detail).toContain('공급대가');
    expect(issue.action).toContain('임시저장');
    expect(buildProjectReviewReadiness({ ...request, status: 'APPROVED' }, {}).issues.find(i => i.code === issue.code).severity).toBe('warning');
    expect(mapProjectReviewReadinessError({ code: issue.code }).severity).toBe('blocking');
    expect(request).toEqual(before);
  });
  it.each(['CHANGE', 'REGISTRATION'])('blocks a direct %s approval even with a matching review token and project version', async requestKind => {
    const project = { id: 'p1', version: 20, executiveApproverId: 'head', executiveReviewStatus: 'PENDING', settlementType: 'TYPE2', basis: '공급대가' };
    const payload = { executiveApproverId: 'head', settlementType: 'NONE', basis: '공급대가' };
    const submission = { requestKind, status: 'PENDING', targetProjectId: 'p1', approvedProjectId: 'p1', baseProjectVersion: 20, targetProjectVersion: 21, requestVersion: 2, payload, ...(requestKind === 'CHANGE' ? { proposedSnapshot: payload } : {}) };
    const records = { 'orgs/mysc/projects/p1': project, 'orgs/mysc/project_requests/r1': submission };
    const snapshot = path => ({ exists: !!records[path], data: () => records[path] });
    const tx = { get: vi.fn(async ref => snapshot(ref.path)), set: vi.fn() };
    const db = { doc: path => ({ path, get: async () => snapshot(path) }), runTransaction: async fn => fn(tx) };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.context = { tenantId: 'mysc', actorId: 'head', actorRole: 'admin', requestId: 'test', idempotencyKey: `test-${requestKind}` }; next(); });
    mountProjectRoutes(app, { db, idempotencyService: { begin: async () => ({ mode: 'acquired', requestFingerprint: 'test' }), complete: vi.fn(), fail: vi.fn() } });
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ code: error.code, message: error.message }));
    const response = await request(app).post('/api/v1/projects/p1/executive-review').send({ requestId: 'r1', reviewStatus: 'APPROVED', expectedReviewToken: projectReviewVersionToken(project, submission) });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('project_settlement_basis_conflict');
    expect(response.body.message).toContain('공급대가');
    expect(response.body.message).toContain('최종 제출');
    expect(tx.set).not.toHaveBeenCalled();
  });
});
