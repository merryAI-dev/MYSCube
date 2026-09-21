import { createProjectEditorDraft, type ProjectEditorDraft } from './project-editor';

const editorFields = Object.keys(createProjectEditorDraft()) as (keyof ProjectEditorDraft)[];

export function serializeProjectEditorPrivateDraft(draft: ProjectEditorDraft): Record<string, unknown> {
  const payload = Object.fromEntries(editorFields.map((key) => [key, draft[key]]));
  // Final submission normalizes business values; a private draft retains the editor's input.
  return JSON.parse(JSON.stringify(payload, (_key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('금액 입력 형식을 확인해 주세요. 기존 임시저장은 유지됩니다.');
    }
    return value;
  }));
}
