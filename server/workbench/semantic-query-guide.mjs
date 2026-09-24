import * as z from 'zod/v4';
import { assertIdentifier } from './analytics-contract.mjs';
import { bindSemanticDefinition } from './semantic-catalog.mjs';
import { SemanticQueryPlanSchema, SEMANTIC_SELECTION_POLICY, SEMANTIC_REQUIRED_FILTER_POLICY, semanticFilterOperators } from './semantic-query.mjs';

const planSchema = z.toJSONSchema(SemanticQueryPlanSchema);
const timeSchema = planSchema.properties.time;

export function buildSemanticQueryGuide({ catalogItems, definitionRegistry }) {
  const datasets = [];
  for (const item of catalogItems) {
    let definition;
    try {
      assertIdentifier(item.datasetId);
      if (!/^[a-f0-9]{64}$/.test(item.version)) continue;
      ({ definition } = bindSemanticDefinition(item, definitionRegistry ? { definitionRegistry } : undefined));
    }
    catch { continue; }
    const time = definition.timeFields || {};
    const timeFields = [time.yearMonth, time.weekNo].filter(Boolean);
    const requiredFilters = new Set((definition.requiredFilters || []).map(({ field }) => field));
    datasets.push({
      datasetId: item.datasetId, definitionVersion: definition.version,
      time: {
        bindings: Object.fromEntries(['yearMonth', 'weekNo'].filter((key) => time[key]).map((key) => [key, time[key]])),
        required: [...(time.requireYearMonth ? ['yearMonth'] : []), ...(time.requireWeekScope ? ['weekNo OR weekScope'] : [])],
        excludedFromFilters: timeFields,
        ...(time.basis ? { basis: time.basis } : {}),
      },
      filterFields: Object.entries(definition.fields).filter(([id, field]) => field.filterable && !timeFields.includes(id)).map(([id, field]) => ({
        field: id, type: field.type, operators: semanticFilterOperators(field).filter((operator) => !requiredFilters.has(id) || operator === SEMANTIC_REQUIRED_FILTER_POLICY.operator),
        ...Object.fromEntries(['enumValues', 'min', 'max', 'format', 'scale'].filter((key) => field[key] !== undefined).map((key) => [key, field[key]])),
        ...(requiredFilters.has(id) ? { required: SEMANTIC_REQUIRED_FILTER_POLICY } : {}),
      })),
      selectFields: Object.keys(definition.fields),
      groupByFields: Object.keys(definition.fields).filter((id) => definition.fields[id].groupable),
      measures: Object.entries(definition.metrics).filter(([, metric]) => metric.approved).map(([id, metric]) => ({ id, ...(metric.companions?.length ? { companions: metric.companions } : {}) })),
      context: {
        mirrorRequiredFilterValues: [...requiredFilters],
        ...(time.basis ? { only: { period_basis: time.basis } } : {}),
      },
    });
  }
  return {
    schemaVersion: 1,
    selection: SEMANTIC_SELECTION_POLICY,
    time: {
      location: 'plan.time', parameters: timeSchema.properties,
      exactlyOneWhenWeekRequired: ['weekNo', 'weekScope'],
      specificWeek: 'Set weekNo and omit weekScope. The only weekScope value is the schema literal for all weeks.',
    },
    placement: {
      period: 'Set the period only in plan.time; never duplicate its bound fields in plan.filters. interpretation.context.period describes that same period.',
      filters: 'Only dataset.filterFields may appear in plan.filters. Do not copy interpretation.context.filters wholesale into plan.filters.',
      context: 'interpretation.context stores confirmed conversation meaning. context.only keys are not query columns or predicates. Mirror required filter values there without adding context-only keys to the plan.',
      missing: 'Ask for missing period or required values; the guide supplies no default business choice.',
    },
    datasets,
  };
}
