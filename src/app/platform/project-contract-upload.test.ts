import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_PROPOSAL_FILE_FORMATS } from './project-proposal-file-formats.mjs';
import {
  getProjectDocumentUploadAccept,
  isProjectDocumentFileAllowed,
  resolveProjectDocumentMimeType,
  uploadProjectRequestContractFile,
} from './project-contract-upload';

const mocks = vi.hoisted(() => ({
  getAuthInstance: vi.fn(),
  getStorageInstance: vi.fn(),
  getDownloadURL: vi.fn(),
  ref: vi.fn(),
  uploadBytesResumable: vi.fn(),
}));

vi.mock('../lib/firebase', () => ({
  getAuthInstance: mocks.getAuthInstance,
  getStorageInstance: mocks.getStorageInstance,
}));

vi.mock('firebase/storage', () => ({
  getDownloadURL: mocks.getDownloadURL,
  ref: mocks.ref,
  uploadBytesResumable: mocks.uploadBytesResumable,
}));

const file = new File(['pdf'], 'contract.pdf', { type: 'application/pdf' });

function fileWithSize(size: number, name = 'contract.pdf') {
  const next = new File(['pdf'], name, { type: 'application/pdf' });
  Object.defineProperty(next, 'size', { value: size });
  return next;
}

describe('project-contract-upload', () => {
  it.each(PROJECT_PROPOSAL_FILE_FORMATS)('accepts proposal $extension with a consistent server MIME', format => {
    const candidate = { name: `proposal${format.extension.toUpperCase()}`, type: 'application/octet-stream' } as File;
    expect(isProjectDocumentFileAllowed('proposal_word_original', candidate)).toBe(true);
    expect(getProjectDocumentUploadAccept('proposal_word_original')).toContain(format.extension);
    expect(resolveProjectDocumentMimeType('proposal_word_original', candidate)).toBe(format.mimeType);
    expect(isProjectDocumentFileAllowed('proposal_word_original', { name: `${candidate.name}.exe` } as File)).toBe(false);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStorageInstance.mockReturnValue({ app: 'storage' });
    mocks.ref.mockImplementation((_storage, path) => ({ fullPath: path }));
    mocks.getDownloadURL.mockResolvedValue('https://example.com/direct.pdf');
    mocks.uploadBytesResumable.mockImplementation((storageRef) => ({
      snapshot: { ref: storageRef },
      on: (_event: string, _next: unknown, _error: unknown, complete: () => void) => complete(),
    }));
    mocks.getAuthInstance.mockReturnValue({
      currentUser: {
        getIdToken: vi.fn(async () => 'fresh-token'),
      },
    });
  });

  it('fails before touching storage when login context is missing', async () => {
    await expect(uploadProjectRequestContractFile({
      tenantId: 'mysc',
      actor: null,
      file,
    })).rejects.toThrow('로그인 정보를 확인할 수 없습니다.');

    expect(mocks.uploadBytesResumable).not.toHaveBeenCalled();
  });

  it('uploads contract files directly to Firebase Storage without live analysis', async () => {
    const result = await uploadProjectRequestContractFile({
      tenantId: 'mysc',
      actor: { uid: 'u-1', email: 'pm@mysc.co.kr', role: 'pm' },
      file,
    });

    expect(result.contractDocument.path).toContain('project-request-documents/u-1/');
    expect(result.contractAnalysis).toBeNull();
    expect(mocks.uploadBytesResumable).toHaveBeenCalled();
    expect(mocks.getAuthInstance).not.toHaveBeenCalled();
  });

  it('normalizes the direct contract upload path and ignores actor id tokens', async () => {
    const result = await uploadProjectRequestContractFile({
      tenantId: 'mysc',
      actor: { uid: 'u-1', email: 'pm@mysc.co.kr', role: 'pm', idToken: 'existing-token' },
      file,
    });

    expect(result.contractDocument.name).toBe('contract.pdf');
    expect(mocks.getAuthInstance).not.toHaveBeenCalled();
    expect(mocks.ref).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('contract-contract.pdf'));
  });

  it('uploads large contract files directly to Firebase Storage', async () => {
    const largeFile = fileWithSize(26 * 1024 * 1024);

    const result = await uploadProjectRequestContractFile({
      tenantId: 'mysc',
      actor: { uid: 'u-1', email: 'pm@mysc.co.kr', role: 'pm' },
      file: largeFile,
    });

    expect(result.contractAnalysis).toBeNull();
    expect(mocks.uploadBytesResumable).toHaveBeenCalled();
  });

  it('maps each PPT attachment slot to its allowed browser file contract', () => {
    expect(isProjectDocumentFileAllowed('proposal_word_original', { name: 'proposal.docx' } as File)).toBe(true);
    expect(isProjectDocumentFileAllowed('proposal_ppt_original', { name: 'proposal.pptx' } as File)).toBe(true);
    expect(isProjectDocumentFileAllowed('rfp_request_evidence', { name: 'request.msg' } as File)).toBe(true);
    expect(isProjectDocumentFileAllowed('proposal_word_original', { name: 'proposal.pdf' } as File)).toBe(true);
    expect(getProjectDocumentUploadAccept('rfp_request_evidence')).toContain('.eml');
    expect(resolveProjectDocumentMimeType('proposal_word_original', { name: 'proposal.docx', type: '' } as File))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it.each([
    ['contract', 'contract.pdf', 'application/pdf'],
    ['proposal_word_original', 'proposal.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['proposal_ppt_original', 'proposal.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['rfp_request_evidence', 'request.eml', 'message/rfc822'],
    ['rfp_request_evidence', 'request.msg', 'application/vnd.ms-outlook'],
  ] as const)('canonicalizes generic browser MIME for %s', (kind, name, expected) => {
    expect(resolveProjectDocumentMimeType(kind, { name, type: 'application/octet-stream' } as File)).toBe(expected);
  });
});
