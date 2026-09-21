export interface ProjectSettlementConsistencyIssue {
  code: 'project_settlement_basis_conflict';
  severity: 'blocking';
  field: 'basis';
  title: string;
  detail: string;
  action: string;
}
export function projectSettlementConsistencyIssue(payload?: Record<string, unknown>, fallback?: Record<string, unknown>): ProjectSettlementConsistencyIssue | null;
