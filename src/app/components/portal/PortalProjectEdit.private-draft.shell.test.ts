import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./PortalProjectEdit.tsx', import.meta.url), 'utf8');

describe('PortalProjectEdit private draft boundary', () => {
  it('starts read-only and uses project-info lease plus BFF draft commands', () => {
    expect(source).toContain("resourceType: 'project-info'");
    expect(source).toContain('createProjectInfoDraftClient');
    expect(source).toContain('readOnly={!editorCanEdit}');
    expect(source).toContain('lease.checkBeforeSave()');
    expect(source).toContain('<EditLeaseDialogs');
  });

  it('fails closed and releases ownership when the private draft cannot open', () => {
    expect(source).toContain('const editorCanEdit = lease.canEdit && record !== null');
    expect(source).toContain('await lease.release()');
    expect(source).toContain('recordLoadedRef.current = false');
    expect(source).toContain("toast.error('수정 임시저장이 준비되지 않았습니다.')");
  });

  it('reopens the owner draft when the same tab refreshes with an active lease', () => {
    expect(source).toContain('const status = await lease.checkStatus()');
    expect(source).toContain('!status.ownership || recordLoadedRef.current');
    expect(source).toContain('draftClient.open(status.ownership)');
  });

  it('refreshes the BFF clients when Firebase rotates the ID token', () => {
    expect(source).toContain('current.actor.idToken === idToken');
    expect(source).toContain('createProjectInfoDraftClient({');
    expect(source).toContain('user?.idToken, user?.uid');
  });

  it('keeps local editor state isolated when the route switches projects', () => {
    expect(source).toContain('<ProjectInfoEditor');
    expect(source).toContain('key={project.id}');
  });

  it('does not write project drafts, requests, or canonical projects through the browser Firestore SDK', () => {
    expect(source).not.toContain('projectRequestDrafts');
    expect(source).not.toContain('setDoc(');
    expect(source).not.toContain('resubmitProjectExecutiveReviewViaBff');
    expect(source).not.toContain('uploadProjectRequestContractFile');
  });

  it('loads private edit-draft attachment blobs through the owner-authorized BFF for review previews', () => {
    expect(source).toContain('downloadProjectInfoDraftAttachmentViaBff');
    expect(source).toContain('usePrivateDraftDocumentPreviews');
    expect(source).toContain('enabled: record !== null');
    expect(source).toContain('signal,');
    expect(source).toContain('documentPreviewUrls={documentPreviewUrls}');
    expect(source).toContain('documentPreviewStates={documentPreviewStates}');
    expect(source).toContain('onLoadDocumentPreview={loadDocumentPreview}');
    expect(source).not.toContain('Promise.all(attachments');
  });

  it('analyzes a replacement contract without creating a second public upload', () => {
    expect(source).toContain('extractTextFromPdf(file)');
    expect(source).toContain('analyzeProjectRequestContractViaBff({');
    expect(source).toContain("kind === 'contract'");
    expect(source).toMatch(/return\s*\{\s*document:\s*attachmentDocument\(uploaded\.attachment\),\s*contractAnalysis\s*\}/);
    expect(source).not.toContain('processProjectRequestContractViaBff');
    expect(source).not.toContain('contractAnalysis: null }');
  });

  it('upgrades the private draft while retaining the canonical project version for the participation gate', () => {
    const privateDraftSource = source.slice(
      source.indexOf('function editorDraftFromPrivate'),
      source.indexOf('function previewAttachmentsFromPrivateDraft'),
    );
    const canonicalDraftSource = source.slice(
      source.indexOf('const canonicalDraft = useMemo'),
      source.indexOf("if (!project && portalLoading)"),
    );

    expect(privateDraftSource).toContain('registrationRequirementsVersion: 2');
    expect(canonicalDraftSource).toContain('...buildProjectEditorDraftFromProject(');
    expect(canonicalDraftSource).not.toContain('registrationRequirementsVersion: 2');
    expect(source).toContain('trustedParticipationSheetDraft={canonicalDraft}');
    expect(source).toContain('previewAttachmentsFromPrivateDraft');
    expect(source).toContain('attachments: previewAttachments');
    expect(source).toContain('[...attachments.values()]');
  });

  it('restores only the latest private proposal alternative after a refresh', () => {
    expect(source).toContain('latestPrivateAlternativeDocumentKind');
    expect(source).toContain("latestAlternativeKind === 'rfp_request_evidence' ? { proposalDocument: null }");
    expect(source).toContain("latestAlternativeKind === 'proposal' ? { rfpRequestEvidenceDocument: null }");
    expect(source).toContain("attachments.delete('proposal')");
    expect(source).toContain("attachments.delete('rfp_request_evidence')");
  });

  it('removes private replacement attachments through the fenced draft API before clearing editor state', () => {
    expect(source).toContain('const removeDocument = useCallback');
    expect(source).toContain('draftClient.removeAttachment(ownership');
    expect(source).toContain('onRemoveProjectDocument={removeDocument}');
    expect(source).toContain('canRemoveProjectDocuments');
  });

  it('closes the editable session and private previews after a successful submission', () => {
    expect(source).toContain('const [submitted, setSubmitted] = useState(false)');
    expect(source).toContain('lease.canEdit && record !== null && !submitted');
    expect(source).toContain('enabled: record !== null && !submitted');
    expect(source).toContain('setSubmitted(true)');
    expect(source).toContain('setRecord(null)');
    expect(source).toContain("navigate('/portal/project-select')");
  });
});
