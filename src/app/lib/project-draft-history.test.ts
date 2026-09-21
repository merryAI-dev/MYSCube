import { describe, expect, it, vi } from 'vitest';
import { parseProjectDraftHistory } from './project-draft-history';
import { createProjectInfoDraftClient, type ProjectInfoDraftApiClient } from './project-info-draft-client';
import { createProjectRegistrationDraftClient } from './project-registration-draft-client';

describe('private history API reads', () => {
  it.each(['registration', 'info'])('reads %s histories with actor and edit session without mutation', async (kind) => {
    const history = { items: [{ draftRevision: 5, payload: { totalActualCost: 0 }, attachmentRefs: [] }], historyAvailableFromRevision: 5 };
    const get = vi.fn(async () => ({ data: history }));
    const post = vi.fn(); const patch = vi.fn(); const request = vi.fn();
    const options = { tenantId: 'tenant-a', actor: { uid: 'actor-a', role: 'pm' as const }, sessionId: 'session-a', client: { get, post, patch, request } as unknown as ProjectInfoDraftApiClient };
    const result = kind === 'registration'
      ? await createProjectRegistrationDraftClient(options).history('draft-a')
      : await createProjectInfoDraftClient({ ...options, projectId: 'project-a' }).history();
    expect(result).toEqual(history);
    expect(get).toHaveBeenCalledWith(kind === 'registration' ? '/api/v1/project-registration-drafts/draft-a/history' : '/api/v1/project-info-drafts/project-a/history', expect.objectContaining({ tenantId: 'tenant-a', headers: { 'x-edit-session-id': 'session-a' }, actor: expect.objectContaining({ id: 'actor-a' }) }));
    expect(post).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
});


describe('history response validation', () => {
  it.each([null, { items: [null] }, { items: [{ draftRevision: 1, payload: {}, attachmentRefs: [null] }] }])('rejects malformed history before rendering', (value) => {
    expect(() => parseProjectDraftHistory(value)).toThrow('임시저장 이력의 형식');
  });
});
