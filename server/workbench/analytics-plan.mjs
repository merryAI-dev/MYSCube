import * as z from 'zod/v4';
import { SemanticQueryPlanSchema, compileSemanticQuery } from './semantic-query.mjs';
import { TableQueryPlanSchema, compileTableQuery } from './table-query.mjs';

export const AnalyticsQueryPlanSchema = z.union([SemanticQueryPlanSchema, TableQueryPlanSchema]);
export function compileAnalyticsPlan(input) {
  return input.plan?.kind === 'table' ? compileTableQuery(input) : compileSemanticQuery(input);
}
