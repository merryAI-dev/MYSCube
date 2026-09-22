import { describe, expect, it, vi } from 'vitest';
import {
  createProjectRegistrationDraftClient,
  PROJECT_REGISTRATION_ATTACHMENT_MAX_BYTES,
  type ProjectRegistrationDraftApiClient,
} from './project-registration-draft-client';

const DRAFT = {
  draftId: 'draft-a',
  resourceType: 'project-registration' as const,
  resourceId: 'draft-a',
  draftRevision: 2,
  payload: { name: 'Project A' },
  attachmentRefs: [],
  stepIndex: 1,
  status: 'ACTIVE' as const,
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:01:00.000Z',
};

const LEASE = {
  serverNow: '2026-07-12T00:00:00.000Z',
  state: 'ACTIVE' as const,
  canEdit: true as const,
  expiresAt: '2026-07-12T00:30:00.000Z',
  leaseId: 'lease-a',
  fence: 3,
};

function harness() {
  const api = {
    get: vi.fn(async () => ({ data: { draft: DRAFT } })),
    post: vi.fn()
      .mockResolvedValueOnce({ data: { draft: { ...DRAFT, draftRevision: 0 }, lease: LEASE } })
      .mockResolvedValueOnce({ data: {
        draft: { ...DRAFT, draftRevision: 4 },
        attachment: {
          attachmentId: 'attachment-a',
          documentKind: 'contract',
          path: 'orgs/mysc/project-registration-drafts/draft-a/attachment-a-contract.pdf',
          name: 'contract.pdf',
          size: 3,
          contentType: 'application/pdf',
          uploadedAt: '2026-07-12T00:02:00.000Z',
        },
      } })
      .mockResolvedValueOnce({ data: {
        status: 'SUBMITTED',
        projectId: 'project-a',
        projectRequestId: 'request-a',
        draftId: 'draft-a',
        draftRevision: 4,
        submittedAt: '2026-07-12T00:03:00.000Z',
        lease: { state: 'RELEASED', canEdit: false },
        outbox: { id: 'outbox-a', status: 'PENDING' },
      } }),
    patch: vi.fn(async () => ({ data: { draft: { ...DRAFT, draftRevision: 3 } } })),
    request: vi.fn(async () => ({ data: { draft: { ...DRAFT, draftRevision: 5 } } })),
  } as unknown as ProjectRegistrationDraftApiClient;
  const client = createProjectRegistrationDraftClient({
    tenantId: 'mysc',
    actor: { uid: 'actor-a', role: 'pm', idToken: 'token-a' },
    sessionId: '11111111-1111-4111-8111-111111111111',
    client: api,
  });
  return { api, client };
}

describe('project registration draft client', () => {
  it('creates and reads an opaque private draft with the tab session header', async () => {
    const { api, client } = harness();
    const created = await client.create({ payload: { name: 'Project A' }, stepIndex: 0 });
    const loaded = await client.get('draft-a');

    expect(created).toMatchObject({ draft: { draftId: 'draft-a' }, lease: LEASE });
    expect(loaded.draft).toMatchObject({ draftId: 'draft-a', draftRevision: 2 });
    expect(api.post).toHaveBeenNthCalledWith(1, '/api/v1/project-registration-drafts', expect.objectContaining({
      headers: { 'x-edit-session-id': '11111111-1111-4111-8111-111111111111' },
      body: { payload: { name: 'Project A' }, stepIndex: 0 },
    }));
    expect(api.get).toHaveBeenCalledWith('/api/v1/project-registration-drafts/draft-a', expect.objectContaining({
      headers: { 'x-edit-session-id': '11111111-1111-4111-8111-111111111111' },
    }));
  });

  it('saves, uploads, removes, and submits with the exact revision and lease fence', async () => {
    const { api, client } = harness();
    const ownership = { leaseId: 'lease-a', fence: 3 };
    await client.create({ payload: {}, stepIndex: 0 });
    await client.save('draft-a', ownership, { expectedDraftRevision: 2, payload: { name: 'Saved' }, stepIndex: 3 });
    const uploaded = await client.upload('draft-a', ownership, {
      expectedDraftRevision: 3,
      documentKind: 'contract',
      file: {
        name: 'contract.pdf',
        type: 'application/octet-stream',
        size: 3,
        arrayBuffer: async () => new Uint8Array([0x70, 0x64, 0x66]).buffer,
      },
    });
    const removed = await client.removeAttachment('draft-a', ownership, {
      expectedDraftRevision: 4,
      documentKind: 'contract',
    });
    const submitted = await client.submit('draft-a', ownership, { expectedDraftRevision: 5 });

    const headers = {
      'x-edit-session-id': '11111111-1111-4111-8111-111111111111',
      'x-edit-lease-id': 'lease-a',
      'x-edit-fence': '3',
    };
    expect(api.patch).toHaveBeenCalledWith('/api/v1/project-registration-drafts/draft-a', expect.objectContaining({
      headers: { ...headers, 'x-operation-mode': 'unknown' },
      body: { expectedDraftRevision: 2, payload: { name: 'Saved' }, stepIndex: 3 },
    }));
    expect(api.post).toHaveBeenNthCalledWith(2, '/api/v1/project-registration-drafts/draft-a/attachments', expect.objectContaining({
      headers,
      body: expect.objectContaining({
        contentBase64: 'cGRm',
        fileSize: 3,
        mimeType: 'application/pdf',
      }),
    }));
    expect(api.post).toHaveBeenNthCalledWith(3, '/api/v1/project-registration-drafts/draft-a/submit', expect.objectContaining({
      headers,
      body: { expectedDraftRevision: 5 },
    }));
    expect(api.request).toHaveBeenCalledWith(
      '/api/v1/project-registration-drafts/draft-a/attachments/contract',
      expect.objectContaining({
        method: 'DELETE',
        headers,
        body: { expectedDraftRevision: 4 },
      }),
    );
    expect(uploaded.attachment.path).toContain('/draft-a/');
    expect(removed.draft.draftRevision).toBe(5);
    expect(submitted).toMatchObject({ status: 'SUBMITTED', projectId: 'project-a' });
  });

  it('fails before the request for unsafe IDs, fences, and oversized attachments', async () => {
    const { api, client } = harness();
    await expect(client.get('draft/a')).rejects.toThrow(/draft/i);
    await expect(client.get('..')).rejects.toThrow(/draft/i);
    await expect(client.save('draft-a', { leaseId: 'lease-a', fence: 0 }, {
      expectedDraftRevision: 0,
      payload: {},
    })).rejects.toThrow(/fence/i);
    await expect(client.upload('draft-a', LEASE, {
      expectedDraftRevision: 0,
      documentKind: 'contract',
      file: {
        name: 'large.pdf',
        type: 'application/pdf',
        size: PROJECT_REGISTRATION_ATTACHMENT_MAX_BYTES + 1,
        arrayBuffer: async () => new ArrayBuffer(0),
      },
    })).rejects.toThrow(/10MB/i);
    expect(api.patch).not.toHaveBeenCalled();
  });
});


 it('loads older history and restores only a server revision with lease and CAS protection', async () => {
   const { api, client } = harness();
   vi.mocked(api.get).mockResolvedValueOnce({ data: { items: [], historyAvailableFromRevision: 0, historyGeneration: 'generation-a', hasMore: false, nextBeforeRevision: null } } as never);
   const history = await client.history('draft-a', 20);
   expect(history.historyGeneration).toBe('generation-a');
   expect(api.get).toHaveBeenCalledWith('/api/v1/project-registration-drafts/draft-a/history?beforeRevision=20', expect.any(Object));
   vi.mocked(api.post).mockReset().mockResolvedValueOnce({ data: { draft: { ...DRAFT, draftRevision: 31 } } } as never);
   const restored = await client.restoreHistory('draft-a', { leaseId: 'lease-a', fence: 3 }, { revision: 12, expectedDraftRevision: 30, historyGeneration: 'generation-a' }, 'restore-a');
   expect(restored.draft.draftRevision).toBe(31);
   expect(api.post).toHaveBeenCalledWith('/api/v1/project-registration-drafts/draft-a/history/12/restore', expect.objectContaining({
     body: { expectedDraftRevision: 30, historyGeneration: 'generation-a' },
     headers: expect.objectContaining({ 'x-edit-lease-id': 'lease-a', 'x-edit-fence': '3', 'Idempotency-Key': 'restore-a' }),
   }));
   vi.mocked(api.post).mockRejectedValueOnce(new Error('draft_version_conflict'));
   await expect(client.restoreHistory('draft-a', { leaseId: 'lease-a', fence: 3 }, { revision: 12, expectedDraftRevision: 30, historyGeneration: 'generation-a' }, 'restore-b')).rejects.toThrow('draft_version_conflict');
 });
