import type { RequestActor } from '../platform/request-context';
import { resolveProjectDocumentMimeType } from '../platform/project-contract-upload';
import {
  createPlatformApiClient,
  toRequestActor,
  type ActorLike,
  type PlatformApiClientLike,
} from './platform-bff-client';

/** Vercel 본문 4.5MB - base64 팽창 여유. 넘으면 서명 URL 직접 업로드로 우회한다. */
const DIRECT_UPLOAD_THRESHOLD_BYTES = 3 * 1024 * 1024;
export const PROJECT_REGISTRATION_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export type ProjectRegistrationDocumentKind =
  | 'contract'
  | 'customer_business_registration'
  | 'quote'
  | 'proposal'
  | 'proposal_word_original'
  | 'proposal_ppt_original'
  | 'presentation_ppt_original'
  | 'rfp_request_evidence';

export interface ProjectRegistrationAttachment {
  attachmentId?: string;
  documentKind: ProjectRegistrationDocumentKind;
  path: string;
  name: string;
  size: number;
  contentType: string;
  uploadedAt?: string;
}

export interface ProjectRegistrationDraft {
  draftId: string;
  resourceType: 'project-registration';
  resourceId: string;
  draftRevision: number;
  payload: Record<string, unknown>;
  attachmentRefs: ProjectRegistrationAttachment[];
  stepIndex: number;
  alias?: string;
  status: 'ACTIVE' | 'SUBMITTED' | 'DISCARDED';
  createdAt?: string;
  updatedAt?: string;
  submittedAt?: string;
}

export interface ProjectRegistrationLeaseOwnership {
  serverNow: string;
  state: 'ACTIVE';
  canEdit: true;
  expiresAt: string;
  leaseId: string;
  fence: number;
}

export interface ProjectRegistrationSubmitResult {
  status: 'SUBMITTED';
  projectId: string;
  projectRequestId: string;
  draftId: string;
  draftRevision: number;
  submittedAt: string;
  lease: { state: 'RELEASED'; canEdit: false };
  outbox: { id: string; status: string };
}

export interface ProjectRegistrationFileLike {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type ProjectRegistrationDraftApiClient = Pick<PlatformApiClientLike, 'get' | 'post' | 'patch' | 'request'>;

function safeId(value: string, field: string): string {
  const normalized = value.trim();
  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || !/^[A-Za-z0-9._-]+$/.test(normalized)
  ) throw new Error(`${field} is invalid`);
  return normalized;
}

function revision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('draft revision is invalid');
  return value;
}

function ownershipHeaders(sessionId: string, ownership: { leaseId: string; fence: number }) {
  if (!Number.isSafeInteger(ownership.fence) || ownership.fence < 1) throw new Error('lease fence is invalid');
  return {
    'x-edit-session-id': sessionId,
    'x-edit-lease-id': safeId(ownership.leaseId, 'lease ID'),
    'x-edit-fence': String(ownership.fence),
  };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label} response`);
  return value as Record<string, unknown>;
}

function parseDraft(value: unknown): ProjectRegistrationDraft {
  const draft = requireObject(value, 'draft');
  const draftId = safeId(String(draft.draftId || ''), 'draft ID');
  if (draft.resourceType !== 'project-registration' || draft.resourceId !== draftId) {
    throw new Error('Invalid draft response');
  }
  const payload = requireObject(draft.payload ?? {}, 'draft payload');
  const attachmentRefs = Array.isArray(draft.attachmentRefs) ? draft.attachmentRefs : [];
  return {
    ...(draft as unknown as ProjectRegistrationDraft),
    draftId,
    resourceType: 'project-registration',
    resourceId: draftId,
    draftRevision: revision(Number(draft.draftRevision)),
    payload,
    attachmentRefs: attachmentRefs as ProjectRegistrationAttachment[],
    stepIndex: revision(Number(draft.stepIndex || 0)),
  };
}

function parseDraftBody(value: unknown): { draft: ProjectRegistrationDraft } {
  const body = requireObject(value, 'draft');
  return { draft: parseDraft(body.draft) };
}

function parseLease(value: unknown): ProjectRegistrationLeaseOwnership {
  const lease = requireObject(value, 'lease');
  const fence = Number(lease.fence);
  if (
    lease.state !== 'ACTIVE'
    || lease.canEdit !== true
    || !Number.isSafeInteger(fence)
    || fence < 1
    || typeof lease.leaseId !== 'string'
  ) throw new Error('Invalid lease response');
  return lease as unknown as ProjectRegistrationLeaseOwnership;
}

function parseAttachment(value: unknown): ProjectRegistrationAttachment {
  const attachment = requireObject(value, 'draft attachment');
  if (
    ![
      'contract',
      'customer_business_registration',
      'quote',
      'proposal',
      'proposal_word_original',
      'proposal_ppt_original',
      'presentation_ppt_original',
      'rfp_request_evidence',
    ].includes(String(attachment.documentKind))
    || typeof attachment.path !== 'string'
    || !attachment.path.trim()
    || typeof attachment.name !== 'string'
  ) throw new Error('Invalid draft attachment response');
  return attachment as unknown as ProjectRegistrationAttachment;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function createProjectRegistrationDraftClient(options: {
  tenantId: string;
  actor: ActorLike;
  sessionId: string;
  client?: ProjectRegistrationDraftApiClient;
}) {
  const client = options.client || createPlatformApiClient();
  const actor: RequestActor = toRequestActor(options.actor);
  const sessionId = safeId(options.sessionId, 'edit session ID');
  const sessionHeaders = { 'x-edit-session-id': sessionId };
  const pathFor = (draftId: string) => `/api/v1/project-registration-drafts/${safeId(draftId, 'draft ID')}`;
  const request = { tenantId: options.tenantId, actor };

  return {
    async create(input: { payload: Record<string, unknown>; stepIndex?: number }) {
      const response = await client.post<unknown>('/api/v1/project-registration-drafts', {
        ...request,
        headers: sessionHeaders,
        body: { payload: input.payload, stepIndex: revision(input.stepIndex || 0) },
      });
      const body = requireObject(response.data, 'draft create');
      return { draft: parseDraft(body.draft), lease: parseLease(body.lease) };
    },

    async get(draftId: string) {
      const response = await client.get<unknown>(pathFor(draftId), { ...request, headers: sessionHeaders });
      return parseDraftBody(response.data);
    },

    /** 임시저장 이름(별칭) 저장. 편집 세션(리스)을 쥔 상태에서만 쓴다. */
    async setAlias(draftId: string, ownership: { leaseId: string; fence: number }, alias: string) {
      const response = await client.patch<unknown>(`${pathFor(draftId)}/alias`, {
        ...request,
        headers: ownershipHeaders(sessionId, ownership),
        body: { alias },
      });
      return parseDraftBody(response.data);
    },

    /** 임시저장 삭제(소프트). 목록에서 사라지고 첨부는 서버가 정리한다. */
    async discard(draftId: string) {
      await client.request<unknown>(pathFor(draftId), {
        ...request,
        method: 'DELETE',
        headers: sessionHeaders,
      });
    },

    /** 내가 임시저장한 진행 중 등록 초안 요약 목록. 이어서 작성할 초안을 고르는 용도. */
    async list() {
      const response = await client.get<unknown>('/api/v1/project-registration-drafts', {
        ...request,
        headers: sessionHeaders,
      });
      const body = requireObject(response.data, 'draft list');
      const rows = Array.isArray(body.drafts) ? body.drafts : [];
      return {
        drafts: rows.flatMap((row) => {
          if (!row || typeof row !== 'object') return [];
          const entry = row as Record<string, unknown>;
          const draftId = typeof entry.draftId === 'string' ? entry.draftId.trim() : '';
          if (!draftId) return [];
          return [{
            draftId,
            alias: typeof entry.alias === 'string' ? entry.alias : '',
            name: typeof entry.name === 'string' ? entry.name : '',
            updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
            stepIndex: typeof entry.stepIndex === 'number' && Number.isInteger(entry.stepIndex) ? entry.stepIndex : 0,
          }];
        }),
      };
    },

    async save(
      draftId: string,
      ownership: { leaseId: string; fence: number },
      input: { expectedDraftRevision: number; payload: Record<string, unknown>; stepIndex?: number },
    ) {
      const response = await client.patch<unknown>(pathFor(draftId), {
        ...request,
        headers: ownershipHeaders(sessionId, ownership),
        body: {
          expectedDraftRevision: revision(input.expectedDraftRevision),
          payload: input.payload,
          ...(input.stepIndex === undefined ? {} : { stepIndex: revision(input.stepIndex) }),
        },
      });
      return parseDraftBody(response.data);
    },

    async upload(
      draftId: string,
      ownership: { leaseId: string; fence: number },
      input: {
        expectedDraftRevision: number;
        documentKind: ProjectRegistrationDocumentKind;
        file: ProjectRegistrationFileLike;
      },
    ) {
      if (input.file.size < 1 || input.file.size > PROJECT_REGISTRATION_ATTACHMENT_MAX_BYTES) {
        throw new Error('첨부파일은 10MB 이하만 업로드할 수 있습니다.');
      }
      const bytes = new Uint8Array(await input.file.arrayBuffer());
      if (bytes.byteLength !== input.file.size) throw new Error('Attachment size does not match its content');
      const mimeType = resolveProjectDocumentMimeType(input.documentKind, input.file);
      const common = {
        expectedDraftRevision: revision(input.expectedDraftRevision),
        documentKind: input.documentKind,
        fileName: input.file.name,
        mimeType,
        fileSize: input.file.size,
      };

      // Vercel 서버리스는 요청 본문을 4.5MB 에서 자른다(413). base64 팽창(~33%)을 감안해
      // 3MB 를 넘는 파일은 BFF 가 발급한 서명 URL 로 스토리지에 직접 올리고, BFF 에는
      // 경로만 보낸다 - 검증·저장 계약은 인라인 경로와 동일하다.
      let contentBody: Record<string, unknown>;
      if (input.file.size > DIRECT_UPLOAD_THRESHOLD_BYTES) {
        const session = await client.post<unknown>(`${pathFor(draftId)}/attachments/upload-url`, {
          ...request,
          headers: ownershipHeaders(sessionId, ownership),
          body: {
            documentKind: input.documentKind,
            fileName: input.file.name,
            mimeType,
            fileSize: input.file.size,
          },
        });
        const sessionBody = requireObject(session.data, 'attachment upload session');
        const uploadUrl = String(sessionBody.uploadUrl || '');
        const storagePath = String(sessionBody.storagePath || '');
        if (!uploadUrl || !storagePath) throw new Error('Invalid attachment upload session response');
        const put = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': mimeType },
          body: bytes,
        });
        if (!put.ok) throw new Error('파일 저장소 업로드에 실패했습니다. 잠시 후 다시 시도해 주세요.');
        contentBody = { ...common, storagePath };
      } else {
        contentBody = { ...common, contentBase64: bytesToBase64(bytes) };
      }

      const response = await client.post<unknown>(`${pathFor(draftId)}/attachments`, {
        ...request,
        headers: ownershipHeaders(sessionId, ownership),
        body: contentBody,
      });
      const body = requireObject(response.data, 'draft attachment');
      return { draft: parseDraft(body.draft), attachment: parseAttachment(body.attachment) };
    },

    async removeAttachment(
      draftId: string,
      ownership: { leaseId: string; fence: number },
      input: { expectedDraftRevision: number; documentKind: ProjectRegistrationDocumentKind },
    ) {
      const response = await client.request<unknown>(
        `${pathFor(draftId)}/attachments/${encodeURIComponent(input.documentKind)}`,
        {
          method: 'DELETE',
          ...request,
          headers: ownershipHeaders(sessionId, ownership),
          body: { expectedDraftRevision: revision(input.expectedDraftRevision) },
        },
      );
      return parseDraftBody(response.data);
    },

    async submit(
      draftId: string,
      ownership: { leaseId: string; fence: number },
      input: { expectedDraftRevision: number },
    ) {
      const response = await client.post<ProjectRegistrationSubmitResult>(`${pathFor(draftId)}/submit`, {
        ...request,
        headers: ownershipHeaders(sessionId, ownership),
        body: { expectedDraftRevision: revision(input.expectedDraftRevision) },
      });
      const body = requireObject(response.data, 'draft submit');
      if (body.status !== 'SUBMITTED' || typeof body.projectId !== 'string') throw new Error('Invalid draft submit response');
      return body as unknown as ProjectRegistrationSubmitResult;
    },
  };
}
