import { describe, expect, it, vi } from 'vitest';
import {
  createDraftAttachmentCleanupOutboxHandler,
  createProjectRequestContractStorageService,
  normalizeSafeFileName,
} from './project-request-contract-storage.mjs';

describe('project-request-contract-storage', () => {
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
    const copy = vi.fn(async () => undefined);
    const deleteFile = vi.fn(async () => undefined);
    const files = new Map<string, any>();
    const bucket = {
      file: vi.fn((path: string) => {
        const file = files.get(path) || { path, copy, delete: deleteFile };
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
    expect(copy).toHaveBeenCalledWith(files.get(canonicalPath));
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
