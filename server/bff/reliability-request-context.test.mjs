import { describe, it, expect } from 'vitest';
import { reliabilityRequestContext } from './reliability-request-context.mjs';

const context = (path, statusCode = 200, method = 'POST') => reliabilityRequestContext({
  method, path, statusCode, deployEnvironment: 'live', release: 'a'.repeat(40),
});

describe('reliability request classification', () => {
  it('covers registration, change drafts and executive review without identifiers in labels', () => {
    expect(context('/api/v1/project-registration-drafts/draft-private', 200, 'PATCH').operationKey).toBe('registration.draft.save');
    expect(context('/api/v1/project-info-drafts/project-private/submit').operationKey).toBe('project-change.submit');
    const review = context('/api/v1/projects/project-private/executive-review');
    expect(review.operationKey).toBe('project.executive-review');
    expect(JSON.stringify(review)).not.toContain('project-private');
    expect(review.measurementScope).toBe('http_request');
    expect(review.requestOutcome).toBe('http_acknowledged');
  });
  it('does not count pending as success or client rejection as server failure', () => {
    const path = '/api/v1/project-registration-drafts/d/submit';
    expect(context(path, 202).requestOutcome).toBe('accepted_pending');
    for (const status of [400, 401, 403, 409, 422, 429]) {
      expect(context(path, status).requestOutcome).toBe('request_rejected');
    }
    expect(context(path, 503).requestOutcome).toBe('server_error');
  });
  it('excludes reads, unrelated routes and unverified release metadata', () => {
    expect(context('/api/v1/project-info-drafts/p', 200, 'GET')).toEqual({});
    expect(context('/api/v1/project-info-drafts/p/attachments')).toEqual({});
    expect(context('/api/v1/cashflow/submit')).toEqual({});
    expect(reliabilityRequestContext({ method: 'POST', path: '/api/v1/project-registration-drafts', statusCode: 200, release: 'secret', deployEnvironment: 'arbitrary' })).toMatchObject({ releaseSha: null, deployEnvironment: 'unknown' });
  });
});
