import { randomUUID } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { getOrInitAdminApp, resolveProjectId } from './firestore.mjs';

function readOptionalText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSafeFileName(fileName) {
  const trimmed = readOptionalText(fileName) || 'contract.pdf';
  const normalized = trimmed
    .replace(/\s+/g, '_')
    .replace(/[^\w.\-가-힣()]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || `contract_${Date.now()}.pdf`;
}

function resolveBucketName(env = process.env) {
  return readOptionalText(env.FIREBASE_STORAGE_BUCKET)
    || readOptionalText(env.VITE_FIREBASE_STORAGE_BUCKET)
    || `${resolveProjectId(env)}.firebasestorage.app`;
}

function buildDownloadUrl(bucketName, objectPath, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectPath)}?alt=media&token=${encodeURIComponent(token)}`;
}

function requireStoragePathSegment(value, fieldName) {
  const normalized = readOptionalText(value);
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized) || normalized === '.' || normalized === '..') {
    throw new Error(`${fieldName} must be a safe storage path segment`);
  }
  return normalized;
}

function draftAttachmentPrefix(tenantId, draftId) {
  return `orgs/${requireStoragePathSegment(tenantId, 'tenantId')}/project-registration-drafts/${requireStoragePathSegment(draftId, 'draftId')}/`;
}

function projectRegistrationAttachmentPrefix(tenantId, projectId) {
  return `orgs/${requireStoragePathSegment(tenantId, 'tenantId')}/project-registration-documents/${requireStoragePathSegment(projectId, 'projectId')}/`;
}

function objectNameWithinPrefix(path, prefix, errorMessage) {
  const normalized = readOptionalText(path);
  const objectName = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : '';
  if (!objectName || objectName.includes('/') || objectName === '.' || objectName === '..') {
    throw new Error(errorMessage);
  }
  return { path: normalized, objectName };
}

export function createDraftAttachmentCleanupOutboxHandler({ draftStorageService } = {}) {
  return async (event) => {
    if (
      typeof draftStorageService?.deleteDraftAttachment !== 'function'
      && typeof draftStorageService?.deleteProjectRegistrationAttachment !== 'function'
    ) {
      throw new Error('Draft attachment storage service is required');
    }
    const draftId = readOptionalText(event?.payload?.draftId);
    const projectId = readOptionalText(event?.payload?.projectId);
    const paths = event?.payload?.paths;
    if (!draftId || !Array.isArray(paths) || paths.length < 1 || paths.length > 100) {
      throw new Error('Draft attachment cleanup payload is invalid');
    }
    const permanentPrefix = projectId
      ? projectRegistrationAttachmentPrefix(event?.tenantId, projectId)
      : '';
    await Promise.all(paths.map((path) => (
      permanentPrefix && readOptionalText(path).startsWith(permanentPrefix)
        ? draftStorageService.deleteProjectRegistrationAttachment({
            tenantId: event?.tenantId, projectId, draftId, path,
          })
        : draftStorageService.deleteDraftAttachment({
            tenantId: event?.tenantId, draftId, path,
          })
    )));
  };
}

export function createProjectRequestContractStorageService(options = {}) {
  const bucketName = options.bucketName || resolveBucketName(options.env || process.env);
  const adminApp = options.adminApp || getOrInitAdminApp({ projectId: options.projectId });
  const storage = options.storage || getStorage(adminApp);
  const bucket = storage.bucket(bucketName);

  return {
    async uploadContract(input) {
      const tenantId = readOptionalText(input?.tenantId) || 'mysc';
      const actorId = readOptionalText(input?.actorId) || 'system';
      const fileName = normalizeSafeFileName(input?.fileName);
      const mimeType = readOptionalText(input?.mimeType) || 'application/pdf';
      const fileSize = Number.isFinite(input?.fileSize) ? input.fileSize : 0;
      const buffer = input?.buffer instanceof Uint8Array
        ? Buffer.from(input.buffer)
        : Buffer.isBuffer(input?.buffer)
          ? input.buffer
          : null;
      const contentBase64 = readOptionalText(input?.contentBase64);
      if (!buffer && !contentBase64) {
        throw new Error('buffer or contentBase64 is required');
      }

      const uploadedAt = new Date().toISOString();
      const token = randomUUID();
      const path = `orgs/${tenantId}/project-request-contracts/${actorId}/${Date.now()}-${fileName}`;
      const file = bucket.file(path);
      const uploadBuffer = buffer || Buffer.from(contentBase64, 'base64');

      await file.save(uploadBuffer, {
        resumable: false,
        metadata: {
          contentType: mimeType,
          metadata: {
            firebaseStorageDownloadTokens: token,
          },
        },
      });

      return {
        path,
        name: readOptionalText(input?.fileName) || fileName,
        downloadURL: buildDownloadUrl(bucketName, path, token),
        size: fileSize || uploadBuffer.byteLength,
        contentType: mimeType,
        uploadedAt,
      };
    },

    /**
     * 브라우저가 스토리지에 직접 올릴 서명 URL(10분, PUT). Vercel 서버리스의 요청 본문
     * 4.5MB 한도를 우회하는 유일한 정석 경로다 - 큰 파일은 BFF 를 거치지 않고 올라오고,
     * 등록 시점에 BFF 가 스토리지에서 내용을 검증한다.
     */
    async createIncomingUploadUrl(input) {
      const tenantId = requireStoragePathSegment(input?.tenantId, 'tenantId');
      const draftId = requireStoragePathSegment(input?.draftId, 'draftId');
      const fileName = normalizeSafeFileName(input?.fileName);
      const mimeType = readOptionalText(input?.mimeType) || 'application/octet-stream';
      const path = `${draftAttachmentPrefix(tenantId, draftId)}incoming/${randomUUID()}-${fileName}`;
      const expiresAtMs = Date.now() + (10 * 60 * 1000);
      const [uploadUrl] = await bucket.file(path).getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: expiresAtMs,
        contentType: mimeType,
      });
      return { path, uploadUrl, expiresAt: new Date(expiresAtMs).toISOString() };
    },

    /** 직접 업로드된 파일을 읽는다. 이 드래프트의 incoming/ 밑이 아니면 거부 - 경로는 신뢰하지 않는다. */
    async readIncomingUpload(input) {
      const tenantId = requireStoragePathSegment(input?.tenantId, 'tenantId');
      const draftId = requireStoragePathSegment(input?.draftId, 'draftId');
      const path = readOptionalText(input?.path);
      const prefix = `${draftAttachmentPrefix(tenantId, draftId)}incoming/`;
      if (!path || !path.startsWith(prefix) || path.includes('..')) {
        throw new Error('Incoming upload path is invalid');
      }
      const file = bucket.file(path);
      const [buffer] = await file.download();
      return { path, buffer };
    },

    async deleteIncomingUpload(input) {
      const tenantId = requireStoragePathSegment(input?.tenantId, 'tenantId');
      const draftId = requireStoragePathSegment(input?.draftId, 'draftId');
      const path = readOptionalText(input?.path);
      const prefix = `${draftAttachmentPrefix(tenantId, draftId)}incoming/`;
      if (!path || !path.startsWith(prefix)) return;
      await bucket.file(path).delete({ ignoreNotFound: true });
    },

    async uploadDraftAttachment(input) {
      const tenantId = requireStoragePathSegment(input?.tenantId, 'tenantId');
      const draftId = requireStoragePathSegment(input?.draftId, 'draftId');
      const attachmentId = requireStoragePathSegment(input?.attachmentId, 'attachmentId');
      const fileName = normalizeSafeFileName(input?.fileName);
      const mimeType = readOptionalText(input?.mimeType) || 'application/octet-stream';
      const buffer = input?.buffer instanceof Uint8Array
        ? Buffer.from(input.buffer)
        : Buffer.isBuffer(input?.buffer)
          ? input.buffer
          : null;
      if (!buffer) throw new Error('buffer is required');

      const uploadedAt = new Date().toISOString();
      const path = `${draftAttachmentPrefix(tenantId, draftId)}${attachmentId}-${fileName}`;
      await bucket.file(path).save(buffer, {
        resumable: false,
        metadata: {
          contentType: mimeType,
          metadata: { tenantId, draftId, attachmentId },
        },
      });

      return {
        path,
        name: readOptionalText(input?.fileName) || fileName,
        size: buffer.byteLength,
        contentType: mimeType,
        uploadedAt,
      };
    },

    /**
     * 종료사업 체크아웃 증빙을 프로젝트 문서 자리에 바로 올린다.
     *
     * 등록 초안을 거치지 않는다. 이미 승인이 끝난 사업의 마무리 증빙이라 초안으로 올리고
     * 제출하면 조직장 결재가 다시 열린다(projects.mjs 의 executiveReviewReopens).
     * 결재를 건드리지 않는 것이 이 경로의 존재 이유다.
     */
    async uploadProjectRegistrationAttachment(input) {
      const tenantId = requireStoragePathSegment(input?.tenantId, 'tenantId');
      const projectId = requireStoragePathSegment(input?.projectId, 'projectId');
      const draftId = readOptionalText(input?.draftId)
        ? requireStoragePathSegment(input.draftId, 'draftId')
        : '';
      const attachmentId = requireStoragePathSegment(input?.attachmentId, 'attachmentId');
      const fileName = normalizeSafeFileName(input?.fileName);
      const mimeType = readOptionalText(input?.mimeType) || 'application/octet-stream';
      const buffer = input?.buffer instanceof Uint8Array
        ? Buffer.from(input.buffer)
        : Buffer.isBuffer(input?.buffer)
          ? input.buffer
          : null;
      if (!buffer) throw new Error('buffer is required');

      const uploadedAt = new Date().toISOString();
      // 다운로드 라우트가 prefix 바로 아래 한 칸만 허용하므로 하위 경로를 만들지 않는다.
      const path = `${projectRegistrationAttachmentPrefix(tenantId, projectId)}${attachmentId}-${fileName}`;
      await bucket.file(path).save(buffer, {
        resumable: false,
        metadata: {
          contentType: mimeType,
          metadata: { tenantId, projectId, attachmentId, ...(draftId ? { draftId } : {}) },
        },
      });

      return {
        path,
        name: readOptionalText(input?.fileName) || fileName,
        size: buffer.byteLength,
        contentType: mimeType,
        uploadedAt,
      };
    },

    async deleteDraftAttachment(input) {
      const prefix = draftAttachmentPrefix(input?.tenantId, input?.draftId);
      const { path } = objectNameWithinPrefix(
        input?.path,
        prefix,
        'draft attachment path is outside its draft prefix',
      );
      await bucket.file(path).delete({ ignoreNotFound: true });
    },

    async downloadDraftAttachment(input) {
      const prefix = draftAttachmentPrefix(input?.tenantId, input?.draftId);
      const { path } = objectNameWithinPrefix(
        input?.path,
        prefix,
        'draft attachment path is outside its draft prefix',
      );
      const file = bucket.file(path);
      const [[buffer], [metadata]] = await Promise.all([file.download(), file.getMetadata()]);
      return {
        buffer,
        contentType: readOptionalText(metadata?.contentType) || 'application/octet-stream',
        size: Number.parseInt(String(metadata?.size || buffer.byteLength), 10) || buffer.byteLength,
      };
    },

    async relocateDraftAttachments(input) {
      const sourcePrefix = draftAttachmentPrefix(input?.tenantId, input?.draftId);
      const destinationPrefix = projectRegistrationAttachmentPrefix(input?.tenantId, input?.projectId);
      const attachments = (Array.isArray(input?.attachmentRefs) ? input.attachmentRefs : []).map((attachment) => {
        const { path, objectName } = objectNameWithinPrefix(
          attachment?.path,
          sourcePrefix,
          'draft attachment path is outside its draft prefix',
        );
        return { attachment: attachment || {}, sourcePath: path, destinationPath: `${destinationPrefix}${objectName}` };
      });

      return Promise.all(attachments.map(async ({ attachment, sourcePath, destinationPath }) => {
        await bucket.file(sourcePath).copy(bucket.file(destinationPath));
        return {
          ...(readOptionalText(attachment.attachmentId) ? { attachmentId: readOptionalText(attachment.attachmentId) } : {}),
          documentKind: readOptionalText(attachment.documentKind),
          path: destinationPath,
          name: readOptionalText(attachment.name),
          size: Number.isSafeInteger(attachment.size) && attachment.size >= 0 ? attachment.size : 0,
          contentType: readOptionalText(attachment.contentType) || 'application/octet-stream',
          ...(readOptionalText(attachment.uploadedAt) ? { uploadedAt: readOptionalText(attachment.uploadedAt) } : {}),
          visibility: 'PRIVATE',
        };
      }));
    },

    async downloadProjectRegistrationAttachment(input) {
      const prefix = projectRegistrationAttachmentPrefix(input?.tenantId, input?.projectId);
      const { path } = objectNameWithinPrefix(
        input?.path,
        prefix,
        'project registration attachment path is outside its canonical prefix',
      );
      const file = bucket.file(path);
      const [[buffer], [metadata]] = await Promise.all([file.download(), file.getMetadata()]);
      return {
        buffer,
        contentType: readOptionalText(metadata?.contentType) || 'application/octet-stream',
        size: Number.parseInt(String(metadata?.size || buffer.byteLength), 10) || buffer.byteLength,
      };
    },

    async inspectProjectRegistrationAttachment(input) {
      const prefix = projectRegistrationAttachmentPrefix(input?.tenantId, input?.projectId);
      const { path } = objectNameWithinPrefix(
        input?.path,
        prefix,
        'project registration attachment path is outside its canonical prefix',
      );
      const [metadata] = await bucket.file(path).getMetadata();
      return {
        path,
        size: Number.parseInt(String(metadata?.size || 0), 10) || 0,
        contentType: readOptionalText(metadata?.contentType) || 'application/octet-stream',
        attachmentId: readOptionalText(metadata?.metadata?.attachmentId),
        draftId: readOptionalText(metadata?.metadata?.draftId),
      };
    },

    async deleteProjectRegistrationAttachment(input) {
      const draftId = requireStoragePathSegment(input?.draftId, 'draftId');
      const prefix = projectRegistrationAttachmentPrefix(input?.tenantId, input?.projectId);
      const { path } = objectNameWithinPrefix(
        input?.path,
        prefix,
        'project registration attachment path is outside its canonical prefix',
      );
      const file = bucket.file(path);
      const [metadata] = await file.getMetadata();
      if (readOptionalText(metadata?.metadata?.draftId) !== draftId) {
        throw new Error('project registration attachment belongs to another draft');
      }
      await file.delete({ ignoreNotFound: true });
    },
  };
}

export {
  normalizeSafeFileName,
  resolveBucketName,
  buildDownloadUrl,
};
