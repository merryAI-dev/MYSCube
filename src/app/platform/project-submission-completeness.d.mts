export interface ProjectSubmissionCompletenessIssue {
  field: string;
  label: string;
  step: 'basic' | 'financial' | 'review' | 'team';
  message: string;
}
export function projectSubmissionCompletenessIssues(payload: unknown): ProjectSubmissionCompletenessIssue[];
export const PROJECT_REQUIRED_STAFFING_FIELDS: readonly string[];
