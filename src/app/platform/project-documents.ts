import documents from '../../../policies/project-documents.json';
import type { FileAttachment, Project } from '../data/types';

export type ProjectDocumentKind = keyof typeof documents;
export type ProjectDocumentField = Extract<keyof Project, `${string}Document`>;
export const PROJECT_DOCUMENTS = Object.entries(documents).map(([documentKind, definition]) => ({
  ...definition,
  documentKind: documentKind as ProjectDocumentKind,
  field: definition.field as ProjectDocumentField,
}));

export function projectDocumentFields(source: object) {
  return Object.fromEntries(PROJECT_DOCUMENTS.map(({ field }) => [field, (source as Record<string, FileAttachment | null | undefined>)[field]])) as Partial<Record<ProjectDocumentField, FileAttachment | null>>;
}
