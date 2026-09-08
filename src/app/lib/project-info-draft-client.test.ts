import { describe, expect, it, vi } from 'vitest';
import {
  createProjectInfoDraftClient,
  type ProjectInfoDraftApiClient,
} from './project-info-draft-client';

const DRAFT = {
  projectId: 'project-a',
  resourceType: 'project-info' as const,
  resourceId: 'project-a',
  draftRevision: 2,
  baseCanonicalVersion: 3,
  payload: { name: 'Project A' },
  attachmentRefs: [],
  stepIndex: 1,
  status: 'ACTIVE' as const,
};

function harness() {
  const api = {
    get: vi.fn(async () => ({ data: { draft: DRAFT } })),
    post: vi.fn()
      .mockResolvedValueOnce({ data: { draft: { ...DRAFT, draftRevision: 0 } } })
      .mockResolvedValueOnce({ data: {
        draft: { ...DRAFT, draftRevision: 3 },
        attachment: {
          attachmentId: 'attachment-a', documentKind: 'contract', path: 'private/contract.pdf',
          name: 'contract.pdf', size: 3, contentType: 'application/pdf',
        },
      } })
      .mockResolvedValueOnce({ data: {
        status: 'SUBMITTED', projectId: 'project-a', projectRequestId: 'change-project-a',
        projectVersion: 4, draftRevision: 4, submittedAt: '2026-07-12T00:03:00.000Z',
        lease: { state: 'RELEASED', canEdit: false }, outbox: { id: 'outbox-a', status: 'PENDING' },
      } }),
    patch: vi.fn(async () => ({ data: { draft: { ...DRAFT, draftRevision: 3 } } })),
    request: vi.fn(async () => ({ data: { draft: { ...DRAFT, draftRevision: 4 } } })),
  } as unknown as ProjectInfoDraftApiClient;
  const client = createProjectInfoDraftClient({
    tenantId: 'mysc',
    actor: { uid: 'actor-a', role: 'pm', idToken: 'token-a' },
    sessionId: '11111111-1111-4111-8111-111111111111',
    projectId: 'project-a',
    client: api,
  });
  return { api, client };
}

describe('project information draft client', () => {
  const rebaseBody = { rebased: false, sourceFingerprint: 'a'.repeat(64), canonicalVersion: 3, baseCanonicalVersion: 3, autoMerged: [], conflicts: [] };
  it('carries the preview source fingerprint into apply and requires a committed draft', async () => {
    const { api, client } = harness();
    vi.mocked(api.post).mockReset().mockResolvedValueOnce({ data: rebaseBody }).mockResolvedValueOnce({ data: { ...rebaseBody, rebased: true, draft: DRAFT } });
    const ownership = { leaseId: 'lease-a', fence: 1 };
    const preview = await client.rebase(ownership, { expectedDraftRevision: 2 });
    expect(preview.sourceFingerprint).toBe(rebaseBody.sourceFingerprint);
    const applied = await client.rebase(ownership, { expectedDraftRevision: 2, resolutions: {}, sourceFingerprint: preview.sourceFingerprint });
    expect(applied).toMatchObject({ rebased: true, draft: DRAFT });
    expect(api.post).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ body: { expectedDraftRevision: 2, resolutions: {}, sourceFingerprint: preview.sourceFingerprint } }));
  });

  it.each([
    { sourceFingerprint: undefined }, { sourceFingerprint: 'bad' }, { rebased: 'false' },
    { canonicalVersion: 0 }, { canonicalVersion: '3' }, { baseCanonicalVersion: -1 },
    { conflicts: null }, { conflicts: {} }, { conflicts: [{ field: '' }] },
    { autoMerged: undefined }, { autoMerged: [{ field: 5 }] },
    { rebased: true }, { rebased: true, draft: { ...DRAFT, payload: null } },
  ])('fails closed on malformed rebase response %j', async (override) => {
    const { api, client } = harness();
    vi.mocked(api.post).mockReset().mockResolvedValue({ data: { ...rebaseBody, ...override } });
    await expect(client.rebase({ leaseId: 'lease-a', fence: 1 }, { expectedDraftRevision: 2, ...(override.rebased === true ? { resolutions: {}, sourceFingerprint: rebaseBody.sourceFingerprint } : {}) })).rejects.toThrow();
  });

  it('never treats a preview response as successful apply', async () => {
    const { api, client } = harness();
    vi.mocked(api.post).mockReset().mockResolvedValue({ data: rebaseBody });
    await expect(client.rebase({ leaseId: 'lease-a', fence: 1 }, { expectedDraftRevision: 2, resolutions: {}, sourceFingerprint: rebaseBody.sourceFingerprint })).rejects.toThrow();
  });

  it('accepts final report upload metadata and rejects an unknown kind', async () => {
    const { api, client } = harness();
    const attachment = { documentKind: 'final_report', path: 'private/report.pdf', name: 'report.pdf', size: 3, contentType: 'application/pdf' };
    vi.mocked(api.post).mockReset().mockResolvedValue({ data: { draft: DRAFT, attachment } });
    const input = { expectedDraftRevision: 2, documentKind: 'final_report' as const, file: { name: 'report.pdf', type: 'application/pdf', size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } };
    expect((await client.upload({ leaseId: 'lease-a', fence: 3 }, input)).attachment).toEqual(attachment);
    vi.mocked(api.post).mockResolvedValue({ data: { draft: DRAFT, attachment: { ...attachment, documentKind: 'unknown' } } });
    await expect(client.upload({ leaseId: 'lease-a', fence: 3 }, input)).rejects.toThrow('Invalid project information attachment response');
  });

  it('gets, opens, saves, uploads, removes and submits only through the project-scoped BFF contract', async () => {
    const { api, client } = harness();
    const ownership = { leaseId: 'lease-a', fence: 3 };
    await client.get();
    await client.open(ownership);
    await client.save(ownership, { expectedDraftRevision: 2, payload: { name: 'Saved' }, stepIndex: 3 });
    await client.upload(ownership, {
      expectedDraftRevision: 3,
      documentKind: 'contract',
      file: {
        name: 'contract.pdf', type: 'application/pdf', size: 3,
        arrayBuffer: async () => new Uint8Array([0x70, 0x64, 0x66]).buffer,
      },
    });
    const removed = await client.removeAttachment(ownership, {
      expectedDraftRevision: 3,
      documentKind: 'contract',
    });
    const submitted = await client.submit(ownership, {
      expectedDraftRevision: 4,
      expectedVersion: 3,
      resubmit: true,
      reviewComment: '보완 완료',
    });

    const path = '/api/v1/project-info-drafts/project-a';
    const headers = {
      'x-edit-session-id': '11111111-1111-4111-8111-111111111111',
      'x-edit-lease-id': 'lease-a',
      'x-edit-fence': '3',
    };
    expect(api.get).toHaveBeenCalledWith(path, expect.any(Object));
    expect(api.post).toHaveBeenNthCalledWith(1, `${path}/open`, expect.objectContaining({ headers, body: {} }));
    expect(api.patch).toHaveBeenCalledWith(path, expect.objectContaining({
      headers, body: { expectedDraftRevision: 2, payload: { name: 'Saved' }, stepIndex: 3 },
    }));
    expect(api.post).toHaveBeenNthCalledWith(2, `${path}/attachments`, expect.objectContaining({
      headers, body: expect.objectContaining({ contentBase64: 'cGRm', fileSize: 3 }),
    }));
    expect(api.post).toHaveBeenNthCalledWith(3, `${path}/submit`, expect.objectContaining({
      headers,
      body: {
        expectedDraftRevision: 4, expectedVersion: 3, resubmit: true, reviewComment: '보완 완료',
      },
    }));
    expect(api.request).toHaveBeenCalledWith(`${path}/attachments/contract`, expect.objectContaining({
      method: 'DELETE', headers, body: { expectedDraftRevision: 3 },
    }));
    expect(removed.draft.draftRevision).toBe(4);
    expect(submitted).toMatchObject({ status: 'SUBMITTED', projectVersion: 4 });
  });

  it('uploads files over the direct-upload threshold via a signed URL instead of base64', async () => {
    const size = 4 * 1024 * 1024;
    const api = {
      post: vi.fn()
        .mockResolvedValueOnce({ data: {
          uploadUrl: 'https://storage.example/signed-put',
          storagePath: 'orgs/mysc/project-registration-drafts/draft-a/incoming/uuid-big.docx',
          expiresAt: '2026-08-26T00:10:00.000Z',
        } })
        .mockResolvedValueOnce({ data: {
          draft: { ...DRAFT, draftRevision: 3 },
          attachment: {
            attachmentId: 'attachment-b', documentKind: 'proposal_word_original', path: 'private/big.docx',
            name: 'big.docx', size, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          },
        } }),
    } as unknown as ProjectInfoDraftApiClient;
    const fetchMock = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = createProjectInfoDraftClient({
        tenantId: 'mysc',
        actor: { uid: 'actor-a', role: 'pm', idToken: 'token-a' },
        sessionId: '11111111-1111-4111-8111-111111111111',
        projectId: 'project-a',
        client: api,
      });
      await client.upload({ leaseId: 'lease-a', fence: 3 }, {
        expectedDraftRevision: 2,
        documentKind: 'proposal_word_original',
        file: {
          name: 'big.docx',
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size,
          arrayBuffer: async () => new Uint8Array(size).buffer,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    const path = '/api/v1/project-info-drafts/project-a';
    expect(api.post).toHaveBeenNthCalledWith(1, `${path}/attachments/upload-url`, expect.objectContaining({
      body: expect.objectContaining({ documentKind: 'proposal_word_original', fileSize: size }),
    }));
    expect(fetchMock).toHaveBeenCalledWith('https://storage.example/signed-put', expect.objectContaining({ method: 'PUT' }));
    const confirmBody = (api.post as ReturnType<typeof vi.fn>).mock.calls[1][1].body;
    expect(confirmBody.storagePath).toBe('orgs/mysc/project-registration-drafts/draft-a/incoming/uuid-big.docx');
    expect(confirmBody.contentBase64).toBeUndefined();
  });

  it('rejects unsafe project IDs and ownership before making requests', async () => {
    const { api } = harness();
    expect(() => createProjectInfoDraftClient({
      tenantId: 'mysc', actor: { uid: 'actor-a' }, sessionId: 'session-a', projectId: '../other', client: api,
    })).toThrow(/project/i);
  });
});
