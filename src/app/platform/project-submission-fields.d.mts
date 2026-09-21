export const PROJECT_SUBMISSION_FIELDS: readonly string[];
export const PROJECT_SUBMISSION_CLEAR_VALUES: Readonly<Record<string, boolean | string>>;
export function projectSubmissionOwnedPatch(payload: Record<string, unknown>, normalized: Record<string, unknown>): Record<string, unknown>;
export function assertProjectSubmissionFields<T extends object>(payload: T): T;
