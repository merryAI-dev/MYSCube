export const OPERATION_KEYS = ['registration.draft.save', 'registration.submit', 'project-change.draft.save', 'project-change.submit', 'project.executive-review'];
export const OPERATION_MODES = ['manual', 'automatic', 'unknown'];

const routes = [
  ['POST', /^\/api\/v1\/project-registration-drafts$/, 'registration.draft.create'],
  ['PATCH', /^\/api\/v1\/project-registration-drafts\/[^/]+$/, 'registration.draft.save'],
  ['POST', /^\/api\/v1\/project-registration-drafts\/[^/]+\/submit$/, 'registration.submit'],
  ['POST', /^\/api\/v1\/project-info-drafts\/[^/]+\/open$/, 'project-change.draft.open'],
  ['PATCH', /^\/api\/v1\/project-info-drafts\/[^/]+$/, 'project-change.draft.save'],
  ['POST', /^\/api\/v1\/project-info-drafts\/[^/]+\/submit$/, 'project-change.submit'],
  ['POST', /^\/api\/v1\/projects\/[^/]+\/executive-review$/, 'project.executive-review'],
];

export function classifyProjectOperation(method, path) {
  return routes.find(([verb, pattern]) => verb === method && pattern.test(path.split('?')[0]))?.[2] || null;
}
