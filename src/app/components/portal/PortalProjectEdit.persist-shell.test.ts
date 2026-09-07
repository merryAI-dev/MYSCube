import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, 'PortalProjectEdit.tsx'), 'utf8');

describe('PortalProjectEdit persistence shell', () => {
  it('stores portal edits as approval-gated change requests instead of mutating the project snapshot', () => {
    expect(source).toContain('createProjectInfoDraftClient');
    expect(source).toContain('draftClient.submit(ownership');
    expect(source).not.toContain('patchProjectSnapshot');
    expect(source).not.toContain('upsertProjectViaBff');
    expect(source).not.toContain('setDoc(');
  });

  it('forces every rejected edit through the stage-aware resubmission path', () => {
    expect(source).toContain("const shouldResubmit = canResubmit || actionId === 'resubmit'");
    expect(source).toContain('resubmit: shouldResubmit');
    expect(source).toContain('shouldResubmit && resubmitComment.trim()');
    expect(source).not.toContain("resubmit: actionId === 'resubmit'");
    expect(source).not.toContain('resubmitProjectExecutiveReviewViaBff');
  });

  it('shows a single resubmit action after either approval stage rejects the project', () => {
    expect(source).toContain("canResubmit\n            ? [{ id: 'resubmit', label: '수정 후 다시 제출'");
    expect(source).toContain(": [{ id: 'save', label: '최종 저장', icon: Save }]");
    expect(source).not.toContain("{ id: 'save', label: '최종 저장', icon: Save },\n          ...(canResubmit");
  });

  it('reads the latest canonical-preferred request through the permission-checked BFF', () => {
    expect(source).toContain('fetchLatestProjectRequestViaBff');
    expect(source).toContain('latest project request fetch failed');
    expect(source).not.toContain("['project_requests', 'projectRequests']");
    expect(source).not.toContain("collection(db, 'tenants'");
  });

  it('uses the latest change request state while the approved project waits unchanged', () => {
    expect(source).toContain("const changeRequestStatus = resolveProjectRequestKind(requestDoc) === 'CHANGE'");
    expect(source).toContain("const canExecutiveResubmit = changeRequestStatus === 'REJECTED'");
    expect(source).toContain("const canWithdrawRequest = changeRequestStatus === 'PENDING'");
    expect(source).toContain('resolveExecutiveBanner(project, changeRequestStatus, requestDoc)');
  });

  it('keeps the project edit draft key stable across request listener updates', () => {
    expect(source).toContain('const autosaveKey = `portal-edit-${orgId}-${project.id}-${actor.uid}`');
    expect(source).toContain('draftKey={autosaveKey}');
    expect(source).not.toContain('requestDoc?.updatedAt');
  });

  it('shows a centered confirmation dialog instead of a corner toast after saving', () => {
    expect(source).toContain('saveSuccessDialogOpen');
    expect(source).toContain('<AlertDialog open={saveSuccessDialogOpen}');
    expect(source).toContain('프로젝트 수정 요청이 등록되었습니다');
    expect(source).not.toContain("toast.success('프로젝트 변경 요청을 저장했습니다.");
    expect(source).not.toContain("toast.success('프로젝트 변경 요청을 다시 제출했습니다.");
  });

  it('keeps a management planning rejection distinct from the CIC review and enables resubmission', () => {
    expect(source).toContain('getManagementPlanningReview(project)');
    expect(source).toContain('hasManagementPlanningReview(project)');
    expect(source).toContain("managementPlanningReview.status === 'REVISION_REJECTED'");
    expect(source).toContain('data-testid="portal-management-planning-review"');
    expect(source).toContain('buildPortalProjectReviewFeedback(project, requestDoc)');
    expect(source).toContain('기존 조직장 승인 이력은 유지되며, 보완한 요청은 경영기획실 재검토 화면에 표시됩니다.');
    expect(source).toContain("canManagementPlanningResubmit\n                ?");
    expect(source).toContain('조직장 승인 전까지 프로젝트 원장은 바뀌지 않으며');
  });

  it('matches the BFF 2,000-character resubmission memo limit in the editor', () => {
    expect(source).toContain('maxLength={2000}');
    expect(source).toContain('{resubmitComment.length.toLocaleString()}/2,000자');
  });
});
