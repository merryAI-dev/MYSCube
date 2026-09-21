export interface ProjectInputIssue { field: string; label?: string; step: 'financial' | 'team'; message: string }
export function hasMultiYearProjectContract(project: object, currentYear?: number): boolean;
export function projectPaymentIssues(project: object): ProjectInputIssue[];
export function projectFinancialYearsWithPaymentPlan<Row extends { year: number }>(
  project: (object & { financialYears?: Row[] | null }) | null | undefined,
): Row[];
export function projectParticipationPeriodWarnings(project: object): ProjectInputIssue[];

export function projectContractEndYear(project: object, currentYear?: number): number;

export function projectEffectivePaymentPlan(project: object | null | undefined): { contract: number; interim: number; final: number } | undefined;
