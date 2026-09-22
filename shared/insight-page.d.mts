import type { WorkPageConfig } from '../src/app/lib/workbench-client';
export function proposeInsightLayout(question: string, yearMonth: string): { config: WorkPageConfig | null; interpretation: string; unsupported: string };

export const WIDGETS: Record<'cashflow' | 'operations' | 'guidance', { label: string; unit: string; source: string }>;
