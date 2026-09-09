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

export function projectUpdatePayload(existing: Project, updates: Partial<Project>) {
  const payload = { ...existing, ...updates };
  delete payload.closure;
  delete payload.closureRequestId;
  const expectedProjectDocuments: Partial<Record<ProjectDocumentField, FileAttachment | null>> = {};
  for (const { field } of PROJECT_DOCUMENTS) {
    if (Object.hasOwn(updates, field)) expectedProjectDocuments[field] = existing[field] ?? null;
    else delete payload[field];
  }
  return { ...payload, expectedProjectDocuments };
}
