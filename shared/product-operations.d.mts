export type OperationKey = 'registration.draft.save' | 'registration.submit' | 'project-change.draft.save' | 'project-change.submit' | 'project.executive-review';
export type OperationMode = 'manual' | 'automatic' | 'unknown';
export const OPERATION_KEYS: readonly OperationKey[];
export const OPERATION_MODES: readonly OperationMode[];
export function classifyProjectOperation(method: string, path: string): OperationKey | 'registration.draft.create' | 'project-change.draft.open' | null;
