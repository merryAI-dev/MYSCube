import { createProjectEditorDraft, type ProjectEditorDraft } from './project-editor';
import { PROJECT_DOCUMENTS, projectDocumentFields } from './project-documents';

export function recoverProjectEditorDraft(mine: ProjectEditorDraft, server: ProjectEditorDraft) {
  return createProjectEditorDraft({
    ...mine,
    ...projectDocumentFields(server),
    contractAnalysis: JSON.stringify(mine.contractDocument) === JSON.stringify(server.contractDocument)
      ? mine.contractAnalysis
      : server.contractAnalysis,
  });
}

export function projectEditorRecoveryDifferences(mine: ProjectEditorDraft, server: ProjectEditorDraft) {
  const left = createProjectEditorDraft(mine);
  const right = createProjectEditorDraft(server);
  const documentFields = new Set<string>(PROJECT_DOCUMENTS.map(({ field }) => field));
  return (Object.keys(left) as Array<keyof ProjectEditorDraft>)
    .filter((field) => !documentFields.has(field) && field !== 'contractAnalysis' && JSON.stringify(left[field]) !== JSON.stringify(right[field]))
    .map((field) => ({ field, mine: left[field], theirs: right[field] }));
}
