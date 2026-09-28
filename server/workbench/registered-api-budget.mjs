import { COMPANY_SUMMARY_ENDPOINT } from './myscube-company-summary.mjs';

// Call only with the immutable version returned by the authorized registry read.
export function registeredApiBudgetMs(api, env) {
  return env.WORKBENCH_MYSCUBE_COMPANY_SUMMARY_ENABLED === 'true' && api.definition?.enabled === true
    && api.definition.kind === 'external-read' && api.definition.endpointId === COMPANY_SUMMARY_ENDPOINT.id
    && api.definition.endpointVersion === COMPANY_SUMMARY_ENDPOINT.version ? 55000 : 10000;
}
