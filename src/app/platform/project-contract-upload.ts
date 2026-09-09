import { getDownloadURL, ref, uploadBytesResumable, type UploadTaskSnapshot } from 'firebase/storage';
import { getStorageInstance } from '../lib/firebase';
import type { FileAttachment } from '../data/types';
import type { ActorLike } from '../lib/platform-bff-client';

export type ProjectRequestDocumentKind =
  | 'contract'
  | 'customer_business_registration'
  | 'quote'
  | 'proposal'
  | 'proposal_word_original'
  | 'proposal_ppt_original'
  | 'presentation_ppt_original'
  | 'rfp_request_evidence'
  | 'performance_certificate'
  | 'tax_invoice'
  | 'final_settlement_report'
  | 'final_report';

export const PROJECT_REQUEST_DOCUMENT_UPLOAD_MAX_SIZE_BYTES = 1024 * 1024 * 1024;
export const PROJECT_REQUEST_DOCUMENT_UPLOAD_MAX_SIZE_LABEL = '1GB';
export const PROJECT_PRIVATE_DRAFT_DOCUMENT_UPLOAD_MAX_SIZE_BYTES = 10 * 1024 * 1024;
export const PROJECT_PRIVATE_DRAFT_DOCUMENT_UPLOAD_MAX_SIZE_LABEL = '10MB';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PDF_ONLY_KINDS = new Set<ProjectRequestDocumentKind>([
  'contract', 'customer_business_registration', 'quote', 'proposal',
  'performance_certificate', 'tax_invoice', 'final_settlement_report', 'final_report',
]);

export function getProjectDocumentUploadAccept(kind: ProjectRequestDocumentKind): string {
  if (kind === 'proposal_word_original') return `${DOCX_MIME},.docx`;
  if (kind === 'proposal_ppt_original' || kind === 'presentation_ppt_original') return `${PPTX_MIME},.pptx`;
  if (kind === 'rfp_request_evidence') {
    return `application/pdf,${DOCX_MIME},message/rfc822,application/vnd.ms-outlook,application/x-msg,.pdf,.docx,.eml,.msg`;
  }
  return 'application/pdf,.pdf';
}

export function isProjectDocumentFileAllowed(kind: ProjectRequestDocumentKind, file: Pick<File, 'name'>): boolean {
  const name = file.name.trim().toLowerCase();
  if (PDF_ONLY_KINDS.has(kind)) return name.endsWith('.pdf');
  if (kind === 'proposal_word_original') return name.endsWith('.docx');
  if (kind === 'proposal_ppt_original' || kind === 'presentation_ppt_original') return name.endsWith('.pptx');
  return ['.pdf', '.docx', '.eml', '.msg'].some((suffix) => name.endsWith(suffix));
}

export function resolveProjectDocumentMimeType(
  kind: ProjectRequestDocumentKind,
  file: Pick<File, 'name' | 'type'>,
): string {
  const name = file.name.trim().toLowerCase();
  if (name.endsWith('.docx')) return DOCX_MIME;
  if (name.endsWith('.pptx')) return PPTX_MIME;
  if (name.endsWith('.eml')) return 'message/rfc822';
  if (name.endsWith('.msg')) return 'application/vnd.ms-outlook';
  if (name.endsWith('.pdf') || PDF_ONLY_KINDS.has(kind)) return 'application/pdf';
  return file.type.trim().toLowerCase() || 'application/octet-stream';
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSafeFileName(fileName: string, fallback: string) {
  const normalized = (readText(fileName) || fallback)
    .replace(/\s+/g, '_')
    .replace(/[^\w.\-가-힣()]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function assertProjectDocumentUploadAllowed(params: {
  actor: ActorLike | null | undefined;
  file: File;
}) {
  if (!params.actor?.uid) {
    throw new Error('로그인 정보를 확인할 수 없습니다.');
  }
  if (params.file.size > PROJECT_REQUEST_DOCUMENT_UPLOAD_MAX_SIZE_BYTES) {
    throw new Error(`첨부파일은 ${PROJECT_REQUEST_DOCUMENT_UPLOAD_MAX_SIZE_LABEL} 이하만 업로드할 수 있습니다.`);
  }
}

async function uploadProjectRequestDocumentDirectly(params: {
  tenantId: string;
  actor: ActorLike;
  file: File;
  kind: ProjectRequestDocumentKind;
}): Promise<FileAttachment> {
  const storage = getStorageInstance();
  if (!storage) {
    throw new Error('Firebase Storage 설정을 확인할 수 없습니다.');
  }

  const tenantId = readText(params.tenantId) || 'mysc';
  const actorId = readText(params.actor.uid) || 'system';
  const fileName = normalizeSafeFileName(params.file.name, params.kind);
  const contentType = resolveProjectDocumentMimeType(params.kind, params.file);
  const path = `orgs/${tenantId}/project-request-documents/${actorId}/${Date.now()}-${params.kind}-${fileName}`;
  const storageRef = ref(storage, path);
  const task = uploadBytesResumable(storageRef, params.file, {
    contentType,
    customMetadata: {
      tenantId,
      actorId,
      documentKind: params.kind,
      originalFileName: params.file.name,
    },
  });

  const snapshot = await new Promise<UploadTaskSnapshot>((resolve, reject) => {
    task.on('state_changed', undefined, reject, () => resolve(task.snapshot));
  });
  const downloadURL = await getDownloadURL(snapshot.ref);
  return {
    path: snapshot.ref.fullPath,
    name: params.file.name || fileName,
    downloadURL,
    size: params.file.size,
    contentType,
    uploadedAt: new Date().toISOString(),
  };
}

export async function uploadProjectRequestContractFile(params: {
  tenantId: string;
  actor: ActorLike | null | undefined;
  file: File;
}) {
  assertProjectDocumentUploadAllowed({ actor: params.actor, file: params.file });
  if (!params.actor) throw new Error('로그인 정보를 확인할 수 없습니다.');

  const contractDocument = await uploadProjectRequestDocumentDirectly({
    tenantId: params.tenantId,
    actor: params.actor,
    file: params.file,
    kind: 'contract',
  });
  return {
    contractDocument,
    contractAnalysis: null,
  };
}
