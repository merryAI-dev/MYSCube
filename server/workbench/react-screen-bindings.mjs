import * as z from 'zod/v4';
import { createHttpError } from '../bff/bff-utils.mjs';
import { compileSemanticQuery } from './semantic-query.mjs';
import { resolveApiPlan, validateApiInput } from './registered-apis.mjs';
import { ReactScreenBindingSchema, ScreenQueryExpectationSchema } from '../../shared/workbench-screen-bindings.mjs';
export { ReactScreenBindingSchema } from '../../shared/workbench-screen-bindings.mjs';

const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const mismatch = (message) => createHttpError(422, message, 'react_screen_binding_mismatch');
const planIdentity = (plan) => canonical({ ...plan, filters: [...(plan.filters || [])].sort((a, b) => canonical(a).localeCompare(canonical(b))) });

export function resolveSelectedApiPlan({ apiId, apiVersion, input, apis }) {
  const api = apis.find((item) => item.id === apiId && item.version === apiVersion);
  if (!api) throw mismatch('현재 화면에 선택한 API 버전과 조회 연결이 다릅니다. 사용할 API를 선택한 뒤 다시 요청해 주세요.');
  const definition = api.definition || api;
  if (definition.kind !== 'analytics-copy') throw mismatch('이 외부 API와 분석 자료가 같은 기준인지 확인할 수 없습니다. 분석용 API를 연결하거나 외부 자료의 조회 기준을 먼저 확인해 주세요.');
  if (definition.enabled === false) throw mismatch('선택한 API의 사용이 중지되었습니다. 사용 가능한 연결을 선택해 주세요.');
  validateApiInput(definition.parameters, input);
  return resolveApiPlan(definition.plan, input);
}

export function validateReactScreenBindings({ bindings, evidence, apis, catalog }) {
  const checked = z.array(ReactScreenBindingSchema).min(1).max(6).parse(bindings);
  if (new Set(checked.map((item) => item.apiId)).size !== checked.length) throw mismatch('같은 API에 서로 다른 조회 조건이 연결되어 있습니다. 화면에서 사용할 조건을 하나씩 정해 주세요.');
  return checked.map((binding) => {
    const plan = resolveSelectedApiPlan({ ...binding, apis });
    const item = evidence.find((value) => value.evidenceId === binding.evidenceId);
    if (!item?.semantic?.appliedPlan) throw mismatch('화면에 연결할 자료의 조회 조건이 없습니다. 필요한 자료를 먼저 조회해 주세요.');
    const compiled = compileSemanticQuery({ plan, catalogItems: catalog.items });
    if (canonical(compiled.datasetVersions) !== canonical(item.datasetVersions)) throw mismatch('조회 후 분석 자료의 버전이 달라졌습니다. 최신 자료를 다시 확인한 뒤 화면에 연결해 주세요.');
    if (planIdentity(compiled.appliedPlan) !== planIdentity(item.semantic.appliedPlan)
      || canonical(compiled.definitionVersions) !== canonical(item.semantic.definitionVersions)) {
      throw mismatch('확인한 자료와 연결 API의 기간·항목·집계 조건이 다릅니다. 같은 조건으로 조회할 API를 선택하거나 조회 범위를 다시 알려주세요.');
    }
    return ScreenQueryExpectationSchema.parse({ ...binding, datasetVersions: compiled.datasetVersions, definitionVersions: compiled.definitionVersions, plan: compiled.appliedPlan });
  });
}
