import { describe, expect, it } from 'vitest';
import { createProjectEditorDraft } from './project-editor';
import { PROJECT_DOCUMENTS } from './project-documents';
import { recoverProjectEditorDraft, projectEditorRecoveryDifferences } from './project-editor-recovery';

describe('private draft recovery', () => {
  it.each([undefined, null, { path: 'server/B', name: 'B.pdf' }])('keeps every server document state (%s)', (document) => {
    const mine = createProjectEditorDraft({ name: '내 입력', ...Object.fromEntries(PROJECT_DOCUMENTS.map(({ field }) => [field, { path: 'local/A' }])) });
    const server = createProjectEditorDraft({ name: '최근 입력', ...Object.fromEntries(PROJECT_DOCUMENTS.map(({ field }) => [field, document])) });
    const recovered = recoverProjectEditorDraft(mine, server);
    expect(recovered.name).toBe('내 입력');
    for (const { field } of PROJECT_DOCUMENTS) expect(recovered[field]).toEqual(document);
    expect(projectEditorRecoveryDifferences(mine, server).map(({ field }) => field)).toEqual(['name']);
  });
  it('preserves analysis only when its source document has not changed', () => {
    const document = { path: 'same', uploadedAt: 'today', name: 'a.pdf' };
    const mine = createProjectEditorDraft({ contractDocument: document as never, contractAnalysis: { summary: '내 분석' } as never });
    const server = createProjectEditorDraft({ contractDocument: document as never, contractAnalysis: null });
    expect(recoverProjectEditorDraft(mine, server).contractAnalysis).toEqual(mine.contractAnalysis);
    expect(recoverProjectEditorDraft(mine, { ...server, contractDocument: null }).contractAnalysis).toBeNull();
  });
  it('compares all normalized input fields including nested team/money and fields omitted from review summaries', () => {
    const mine = createProjectEditorDraft({ participationSheetLink: 'https://mine', paymentPlan: { contract: 10, interim: 20, final: 30 } });
    const server = createProjectEditorDraft({ participationSheetLink: 'https://server', paymentPlan: { contract: 11, interim: 20, final: 30 } });
    expect(projectEditorRecoveryDifferences(mine, server).map(({ field }) => field)).toEqual(expect.arrayContaining(['participationSheetLink', 'paymentPlan']));
  });
});
