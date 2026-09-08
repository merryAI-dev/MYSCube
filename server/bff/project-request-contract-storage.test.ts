import { describe, expect, it, vi } from 'vitest';
import {
  createDraftAttachmentCleanupOutboxHandler,
  createProjectRequestContractStorageService,
  normalizeSafeFileName,
} from './project-request-contract-storage.mjs';

describe('project-request-contract-storage', () => {
  describe('pre-upgrade plain-copy compatibility', () => {
    const ownership = { tenantId: 'tenant-a', draftId: 'draft-a', attachmentId: 'attachment-a' };
    async function run(candidateOverrides = {}, candidateOwnership = ownership, method = 'relocateDraftAttachments') {
      const restoring = method === 'restoreProjectRegistrationAttachments';
      const privatePath = 'orgs/tenant-a/project-registration-drafts/draft-a/attachment-a-contract.pdf';
      const permanentPath = 'orgs/tenant-a/project-registration-documents/project-a/attachment-a-contract.pdf';
      const sourcePath = restoring ? permanentPath : privatePath;
      const copy = vi.fn();
      const source = { generation: '10', md5Hash: 'same-bytes', size: '14', contentType: 'application/pdf', metadata: ownership };
      const candidate = { ...source, generation: '20', metadata: candidateOwnership, ...candidateOverrides };
      const bucket = { file: vi.fn((path: string) => ({ copy, getMetadata: async () => [path === sourcePath ? source : candidate] })) };
      const service = createProjectRequestContractStorageService({ projectId: 'demo-bff-it', bucketName: 'demo-bff-it.firebasestorage.app', storage: { bucket: () => bucket } });
      try {
        return await service[method]({ ...ownership, projectId: 'project-a', attachmentRefs: [{ attachmentId: 'attachment-a', documentKind: 'contract', path: sourcePath }] });
      } finally { expect(copy).not.toHaveBeenCalled(); }
    }

    it('reuses an exact pre-upgrade relocation copy without metadata mutation or overwrite', async () => {
      await expect(run()).resolves.toHaveLength(1);
    });

    it.each([
      { ...ownership, tenantId: 'foreign' },
      { ...ownership, draftId: 'foreign' },
      { ...ownership, attachmentId: 'foreign' },
      { ...ownership, attachmentId: '' },
      { ...ownership, relocationSourcePath: 'partial' },
      { ...ownership, relocationSourceGeneration: '10' },
      { ...ownership, restorationSourcePath: 'different-copy' },
      { ...ownership, relocationSourcePath: 'wrong', relocationSourceGeneration: '10' },
    ])('rejects foreign ownership or incomplete/mismatched provenance %#', async (metadata) => {
      await expect(run({}, metadata)).rejects.toThrow();
    });

    it.each([{ md5Hash: 'different' }, { size: '15' }, { contentType: 'text/plain' }])('rejects different plain-copy content %#', async (metadata) => {
      await expect(run(metadata)).rejects.toThrow();
    });

    it('does not relax restoration provenance for legacy-looking metadata', async () => {
      await expect(run({}, ownership, 'restoreProjectRegistrationAttachments')).rejects.toThrow();
    });
  });

  describe.each(['relocateDraftAttachments', 'restoreProjectRegistrationAttachments'] as const)('%s immutable copies', (method) => {
    function harness({ replaceSource = false, existingDestination = false, concurrentDestination = false, loseCopyResponse = false } = {}) {
      const restoring = method === 'restoreProjectRegistrationAttachments';
      const privatePath = 'orgs/tenant-a/project-registration-drafts/draft-a/contract.pdf';
      const permanentPath = 'orgs/tenant-a/project-registration-documents/project-a/contract.pdf';
      const sourcePath = restoring ? permanentPath : privatePath;
      const destinationPath = restoring ? privatePath : permanentPath;
      const original = { generation: '10', md5Hash: 'original-bytes', size: '14', contentType: 'application/pdf', metadata: { draftId: 'draft-a' } };
      let currentSource = original;
      let destination: any = existingDestination ? { ...original, md5Hash: 'foreign-bytes', metadata: {} } : null;
      const copy = vi.fn(async (target: any, options: any, generation: string | undefined) => {
        if (concurrentDestination) destination = { ...original, md5Hash: 'concurrent-bytes', metadata: {} };
        if (destination && options?.preconditionOpts?.ifGenerationMatch === 0) throw Object.assign(new Error('exists'), { code: 412 });
        const source = generation === original.generation ? original : currentSource;
        destination = { ...source, generation: '30', metadata: options?.metadata || source.metadata };
        if (loseCopyResponse) { loseCopyResponse = false; throw Object.assign(new Error('response lost'), { code: 503 }); }
      });
      const bucket = { file: vi.fn((path: string, options?: { generation?: string }) => ({
        path,
        getMetadata: async () => {
          if (path === destinationPath) {
            if (!destination) throw Object.assign(new Error('missing'), { code: 404 });
            return [destination];
          }
          const observed = currentSource;
          if (replaceSource) currentSource = { ...original, generation: '11', md5Hash: 'replacement-bytes' };
          return [observed];
        },
        copy: (target: any, copyOptions: any) => copy(target, copyOptions, options?.generation),
      })) };
      const service = createProjectRequestContractStorageService({ projectId: 'demo-bff-it', bucketName: 'demo-bff-it.firebasestorage.app', storage: { bucket: () => bucket } });
      const run = () => service[method]({ tenantId: 'tenant-a', draftId: 'draft-a', projectId: 'project-a', attachmentRefs: [{ documentKind: 'contract', path: sourcePath }] });
      return { run, copy, destination: () => destination };
    }

    it('copies the observed source generation even when the source is replaced after metadata read', async () => {
      const state = harness({ replaceSource: true });
      await expect(state.run()).resolves.toHaveLength(1);
      expect(state.destination().md5Hash).toBe('original-bytes');
    });

    it('rejects an existing foreign destination without modifying it', async () => {
      const state = harness({ existingDestination: true });
      await expect(state.run()).rejects.toThrow();
      expect(state.destination().md5Hash).toBe('foreign-bytes');
      expect(state.copy).not.toHaveBeenCalled();
    });

    it('retries a lost copy response by verifying the existing copy without overwriting it', async () => {
      const state = harness({ loseCopyResponse: true });
      await expect(state.run()).rejects.toThrow('response lost');
      await expect(state.run()).resolves.toHaveLength(1);
      expect(state.copy).toHaveBeenCalledTimes(1);
      expect(state.destination().md5Hash).toBe('original-bytes');
    });

    it('preserves a different destination created between inspection and copy', async () => {
      const state = harness({ concurrentDestination: true });
      await expect(state.run()).rejects.toThrow();
      expect(state.destination().md5Hash).toBe('concurrent-bytes');
    });
  });

  it('reuses a withdrawal copy only for the same source generation and checksum', async () => {
    const path = 'orgs/tenant-a/project-registration-documents/project-a/contract.pdf';
    const copy = vi.fn();
    const bucket = { file: vi.fn((requestedPath: string) => ({ copy, getMetadata: async () => [{
      generation: requestedPath === path ? '10' : '20', md5Hash: 'same-checksum',
      metadata: { draftId: 'draft-a', restorationSourcePath: path, restorationSourceGeneration: '10' },
    }] })) };
    const service = createProjectRequestContractStorageService({ projectId: 'demo-bff-it', bucketName: 'demo-bff-it.firebasestorage.app', storage: { bucket: () => bucket } });
    const result = await service.restoreProjectRegistrationAttachments({ tenantId: 'tenant-a', draftId: 'draft-a', projectId: 'project-a', attachmentRefs: [{ documentKind: 'contract', path }] });
    expect(result[0].path).toBe('orgs/tenant-a/project-registration-drafts/draft-a/contract.pdf');
    expect(copy).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a different private withdrawal copy', async () => {
    const copy = vi.fn();
    const bucket = { file: vi.fn((path: string) => ({ copy, getMetadata: async () => [{
      generation: '10', md5Hash: path.includes('/project-registration-documents/') ? 'source' : 'other',
      metadata: { draftId: 'draft-a' },
    }] })) };
    const service = createProjectRequestContractStorageService({ projectId: 'demo-bff-it', bucketName: 'demo-bff-it.firebasestorage.app', storage: { bucket: () => bucket } });
    await expect(service.restoreProjectRegistrationAttachments({ tenantId: 'tenant-a', draftId: 'draft-a', projectId: 'project-a', attachmentRefs: [{
      documentKind: 'contract', path: 'orgs/tenant-a/project-registration-documents/project-a/contract.pdf',
    }] })).rejects.toThrow();
    expect(copy).not.toHaveBeenCalled();
  });

  it('rejects a legacy copy whose stored checksum differs from its source', async () => {
    let copied = false;
    const bucket = { file: vi.fn((path: string) => ({
      copy: vi.fn(async () => { copied = true; }),
      getMetadata: vi.fn(async () => {
        if (!path.includes('/project-registration-drafts/') && !copied) throw Object.assign(new Error('missing'), { code: 404 });
        return [{ generation: '10', md5Hash: path.includes('/project-registration-drafts/') ? 'source-checksum' : 'different-checksum' }];
      }),
    })) };
    const service = createProjectRequestContractStorageService({ projectId: 'demo-bff-it', bucketName: 'demo-bff-it.firebasestorage.app', storage: { bucket: () => bucket } });
    await expect(service.relocateDraftAttachments({ tenantId: 'tenant-a', draftId: 'draft-a', projectId: 'project-a', attachmentRefs: [{
      documentKind: 'contract', path: 'orgs/tenant-a/project-registration-drafts/draft-a/contract.pdf', name: 'contract.pdf', size: 7, contentType: 'application/pdf',
    }] })).rejects.toThrow('checksum');
  });

  it('normalizes file names for storage paths', () => {
    expect(normalizeSafeFileName('   계약서   (2025)  최종본.pdf')).toBe('계약서_(2025)_최종본.pdf');
  });

  it('uploads a contract via injected storage bucket', async () => {
    const save = vi.fn(async () => undefined);
    const bucket = {
      file: vi.fn(() => ({ save })),
    };
    const storage = {
      bucket: vi.fn(() => bucket),
    };

    const service = createProjectRequestContractStorageService({
      projectId: 'example-project',
      bucketName: 'example-project.firebasestorage.app',
      storage,
    });

    const result = await service.uploadContract({
      tenantId: 'mysc',
      actorId: 'u001',
      fileName: 'contract.pdf',
      mimeType: 'application/pdf',
      fileSize: 16,
      contentBase64: Buffer.from('fake-pdf', 'utf8').toString('base64'),
    });

    expect(storage.bucket).toHaveBeenCalledWith('example-project.firebasestorage.app');
    expect(save).toHaveBeenCalled();
    expect(result.path).toContain('orgs/mysc/project-request-contracts/u001/');
    expect(result.downloadURL).toContain('firebasestorage.googleapis.com');
  });

  it('uploads a private project change attachment with owning draft metadata', async () => {
    const save = vi.fn(async () => undefined);
    const bucket = {
      file: vi.fn((path: string) => ({ path, save })),
    };
    const service = createProjectRequestContractStorageService({
      projectId: 'demo-bff-it',
      bucketName: 'demo-bff-it.firebasestorage.app',
      storage: { bucket: vi.fn(() => bucket) },
    });

    const result = await service.uploadProjectRegistrationAttachment({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      draftId: 'draft-a',
      attachmentId: 'attachment-a',
      fileName: ' 계약서 최종.pdf ',
      mimeType: 'application/pdf',
      buffer: Buffer.from('private-pdf'),
    });

    expect(result).toMatchObject({
      path: 'orgs/tenant-a/project-registration-documents/project-a/attachment-a-계약서_최종.pdf',
      name: '계약서 최종.pdf',
      size: Buffer.byteLength('private-pdf'),
      contentType: 'application/pdf',
    });
    expect(result).not.toHaveProperty('downloadURL');
    expect(save).toHaveBeenCalledWith(expect.any(Buffer), {
      resumable: false,
      metadata: {
        contentType: 'application/pdf',
        metadata: {
          tenantId: 'tenant-a',
          projectId: 'project-a',
          draftId: 'draft-a',
          attachmentId: 'attachment-a',
        },
      },
    });
    expect(save.mock.calls[0]?.[1]?.metadata?.metadata).not.toHaveProperty('firebaseStorageDownloadTokens');
  });

  it('inspects and deletes only a permanent attachment owned by the current draft', async () => {
    const deleteFile = vi.fn(async () => undefined);
    const getMetadata = vi.fn(async () => [{
      size: '11',
      contentType: 'application/pdf',
      metadata: { tenantId: 'tenant-a', projectId: 'project-a', draftId: 'draft-a', attachmentId: 'attachment-a' },
    }]);
    const bucket = {
      file: vi.fn((path: string) => ({ path, delete: deleteFile, getMetadata })),
    };
    const service = createProjectRequestContractStorageService({
      projectId: 'demo-bff-it',
      bucketName: 'demo-bff-it.firebasestorage.app',
      storage: { bucket: vi.fn(() => bucket) },
    });
    const path = 'orgs/tenant-a/project-registration-documents/project-a/attachment-a-contract.pdf';

    await expect(service.inspectProjectRegistrationAttachment({
      tenantId: 'tenant-a', projectId: 'project-a', path,
    })).resolves.toMatchObject({
      path, size: 11, contentType: 'application/pdf', attachmentId: 'attachment-a', draftId: 'draft-a',
    });
    await service.deleteProjectRegistrationAttachment({
      tenantId: 'tenant-a', projectId: 'project-a', draftId: 'draft-a', path,
    });

    expect(bucket.file).toHaveBeenCalledWith(path);
    expect(deleteFile).toHaveBeenCalledWith({ ignoreNotFound: true });
    await expect(service.deleteProjectRegistrationAttachment({
      tenantId: 'tenant-a', projectId: 'project-a', draftId: 'draft-b', path,
    })).rejects.toThrow('project registration attachment belongs to another draft');
    expect(deleteFile).toHaveBeenCalledTimes(1);
  });

  it('deletes every path in a validated cleanup outbox payload', async () => {
    const deleteDraftAttachment = vi.fn(async () => undefined);
    const deleteProjectRegistrationAttachment = vi.fn(async () => undefined);
    const handler = createDraftAttachmentCleanupOutboxHandler({
      draftStorageService: { deleteDraftAttachment, deleteProjectRegistrationAttachment },
    });

    await handler({
      tenantId: 'tenant-a',
      payload: {
        draftId: 'draft-a',
        projectId: 'project-a',
        paths: [
          'orgs/tenant-a/project-registration-drafts/draft-a/contract.pdf',
          'orgs/tenant-a/project-registration-documents/project-a/quote.pdf',
        ],
      },
    });

    expect(deleteDraftAttachment).toHaveBeenCalledOnce();
    expect(deleteDraftAttachment).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      draftId: 'draft-a',
      path: 'orgs/tenant-a/project-registration-drafts/draft-a/contract.pdf',
    });
    expect(deleteProjectRegistrationAttachment).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      draftId: 'draft-a',
      path: 'orgs/tenant-a/project-registration-documents/project-a/quote.pdf',
    });
    await expect(handler({ tenantId: 'tenant-a', payload: { draftId: 'draft-a', paths: [] } }))
      .rejects.toThrow('Draft attachment cleanup payload is invalid');
  });

  it('downloads only an attachment within the exact tenant and draft prefix', async () => {
    const download = vi.fn(async () => [Buffer.from('private-draft-pdf')]);
    const getMetadata = vi.fn(async () => [{ contentType: 'application/pdf', size: '17' }]);
    const bucket = { file: vi.fn(() => ({ download, getMetadata })) };
    const service = createProjectRequestContractStorageService({
      projectId: 'demo-bff-it',
      bucketName: 'demo-bff-it.firebasestorage.app',
      storage: { bucket: vi.fn(() => bucket) },
    });
    const path = 'orgs/tenant-a/project-registration-drafts/draft-a/attachment-a-contract.pdf';

    await expect(service.downloadDraftAttachment({
      tenantId: 'tenant-a', draftId: 'draft-a', path,
    })).resolves.toMatchObject({
      buffer: Buffer.from('private-draft-pdf'),
      contentType: 'application/pdf',
      size: 17,
    });
    await expect(service.downloadDraftAttachment({
      tenantId: 'tenant-a',
      draftId: 'draft-a',
      path: 'orgs/tenant-a/project-registration-drafts/draft-b/attachment-a-contract.pdf',
    })).rejects.toThrow('draft attachment path is outside its draft prefix');
  });

  it('refuses to delete an object outside the owned draft prefix', async () => {
    const deleteFile = vi.fn(async () => undefined);
    const bucket = {
      file: vi.fn(() => ({ delete: deleteFile })),
    };
    const service = createProjectRequestContractStorageService({
      projectId: 'demo-bff-it',
      bucketName: 'demo-bff-it.firebasestorage.app',
      storage: { bucket: vi.fn(() => bucket) },
    });

    await expect(service.deleteDraftAttachment({
      tenantId: 'tenant-a',
      draftId: 'draft-a',
      path: 'orgs/tenant-a/project-registration-drafts/draft-b/attachment-a-contract.pdf',
    })).rejects.toThrow('draft attachment path is outside its draft prefix');
    expect(bucket.file).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('idempotently copies exact draft-prefix attachments into the canonical private prefix', async () => {
    const metadata = new Map<string, any>();
    const copy = vi.fn(async (destination: any, options: any) => {
      metadata.set(destination.path, { generation: '20', md5Hash: 'same-checksum', metadata: options.metadata });
    });
    const deleteFile = vi.fn(async () => undefined);
    const files = new Map<string, any>();
    const bucket = {
      file: vi.fn((path: string) => {
        const file = files.get(path) || { path, copy, delete: deleteFile, getMetadata: async () => {
          if (path.includes('/project-registration-drafts/')) return [{ generation: '10', md5Hash: 'same-checksum' }];
          if (!metadata.has(path)) throw Object.assign(new Error('missing'), { code: 404 });
          return [metadata.get(path)];
        } };
        files.set(path, file);
        return file;
      }),
    };
    const service = createProjectRequestContractStorageService({
      projectId: 'demo-bff-it',
      bucketName: 'demo-bff-it.firebasestorage.app',
      storage: { bucket: vi.fn(() => bucket) },
    });
    const sourcePath = 'orgs/tenant-a/project-registration-drafts/draft-a/attachment-a-contract.pdf';

    const relocated = await service.relocateDraftAttachments({
      tenantId: 'tenant-a',
      draftId: 'draft-a',
      projectId: 'project-a',
      attachmentRefs: [{
        attachmentId: 'attachment-a',
        documentKind: 'contract',
        path: sourcePath,
        name: 'contract.pdf',
        size: 7,
        contentType: 'application/pdf',
      }],
    });

    const canonicalPath = 'orgs/tenant-a/project-registration-documents/project-a/attachment-a-contract.pdf';
    expect(copy).toHaveBeenCalledWith(files.get(canonicalPath), {
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { relocationSourcePath: sourcePath, relocationSourceGeneration: '10' },
    });
    expect(relocated).toEqual([expect.objectContaining({
      attachmentId: 'attachment-a',
      documentKind: 'contract',
      path: canonicalPath,
      visibility: 'PRIVATE',
    })]);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('refuses to relocate an attachment outside the exact tenant and current draft prefix', async () => {
    const bucket = { file: vi.fn() };
    const service = createProjectRequestContractStorageService({
      projectId: 'demo-bff-it',
      bucketName: 'demo-bff-it.firebasestorage.app',
      storage: { bucket: vi.fn(() => bucket) },
    });

    await expect(service.relocateDraftAttachments({
      tenantId: 'tenant-a',
      draftId: 'draft-a',
      projectId: 'project-a',
      attachmentRefs: [{
        documentKind: 'contract',
        path: 'orgs/tenant-a/project-registration-drafts/draft-b/attachment-a-contract.pdf',
      }],
    })).rejects.toThrow('draft attachment path is outside its draft prefix');
    expect(bucket.file).not.toHaveBeenCalled();
  });

  it('downloads only canonical private project registration attachments', async () => {
    const download = vi.fn(async () => [Buffer.from('private-pdf')]);
    const getMetadata = vi.fn(async () => [{ contentType: 'application/pdf', size: '11' }]);
    const bucket = { file: vi.fn(() => ({ download, getMetadata })) };
    const service = createProjectRequestContractStorageService({
      projectId: 'demo-bff-it',
      bucketName: 'demo-bff-it.firebasestorage.app',
      storage: { bucket: vi.fn(() => bucket) },
    });
    const path = 'orgs/tenant-a/project-registration-documents/project-a/attachment-a-contract.pdf';

    await expect(service.downloadProjectRegistrationAttachment({
      tenantId: 'tenant-a', projectId: 'project-a', path,
    })).resolves.toMatchObject({
      buffer: Buffer.from('private-pdf'),
      contentType: 'application/pdf',
      size: 11,
    });

    await expect(service.downloadProjectRegistrationAttachment({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      path: 'orgs/tenant-a/project-registration-drafts/draft-a/attachment-a-contract.pdf',
    })).rejects.toThrow('project registration attachment path is outside its canonical prefix');
  });
});
