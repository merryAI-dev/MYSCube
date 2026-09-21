import { createHash } from 'node:crypto';
import { stableStringify } from './utils.mjs';
import { PROJECT_SUBMISSION_FIELDS } from '../../src/app/platform/project-submission-fields.mjs';

export function projectReviewVersionToken(project, request) {
  const projectFields = [...PROJECT_SUBMISSION_FIELDS, 'version', 'executiveReviewStatus',
    'executiveApproverId', 'executiveReviewHistory', 'managementPlanningReviewStatus', 'projectCode'];
  const decisionProject = Object.fromEntries(projectFields
    .filter((key) => Object.hasOwn(project, key)).map((key) => [key, project[key]]));
  const { id: _id, ...requestData } = request || {};
  return createHash('sha256').update(stableStringify({ project: decisionProject, request: request ? requestData : null })).digest('hex');
}

export function assertProjectReviewVersion(expected, project, request, createError) {
  if (!expected.expectedReviewToken) {
    throw createError(409, '결재 문서를 다시 열어 최신 제출 내용을 확인해 주세요.', 'review_version_required');
  }
  if (expected.expectedReviewToken !== projectReviewVersionToken(project, request)
    || (expected.expectedRequestVersion !== undefined && expected.expectedRequestVersion !== request?.requestVersion)
    || (expected.expectedProjectVersion !== undefined && expected.expectedProjectVersion !== project.version)) {
    throw createError(409, '검토 중 제출 내용이 변경되었습니다. 문서를 다시 열어 변경 내용을 확인한 뒤 결재해 주세요.', 'review_version_conflict');
  }
}
