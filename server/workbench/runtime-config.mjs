export function resolveWorkbenchRuntime(env) {
  const required = (name) => {
    const value = env[name];
    if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(value)) throw new Error(`${name} must identify a configured project.`);
    return value;
  };
  const projectId = required('WORKBENCH_PROJECT_ID');
  const productionProjectId = required('PRODUCTION_PROJECT_ID');
  const modelProjectId = required('WORKBENCH_MODEL_PROJECT_ID');
  const productionModelProjectId = required('PRODUCTION_MODEL_PROJECT_ID');
  if ([productionProjectId, productionModelProjectId].includes(projectId)
    || [productionProjectId, productionModelProjectId].includes(modelProjectId)) throw new Error('Workbench must not share production data or model projects.');
  for (const key of ['SETTLEMENT_AGENT_GEMINI_API_KEY', 'JVM_WEEKLY_API_BASE_URL', 'JVM_WEEKLY_INTERNAL_API_TOKEN', 'JVM_WEEKLY_API_SERVICE_ACCOUNT_JSON']) {
    if (env[key]) throw new Error(`Production credential or endpoint is forbidden: ${key}`);
  }
  if (env.WORKBENCH_AI_ENABLED === 'true' && !String(env.WORKBENCH_GEMINI_API_KEY || '').trim()) throw new Error('A dedicated Workbench model credential is required.');
  return Object.freeze({ projectId, productionProjectId, modelProjectId, productionModelProjectId });
}
