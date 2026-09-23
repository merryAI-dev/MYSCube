import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkbenchRuntime } from '../runtime-config.mjs';

const fail = message => { throw new Error(message); };
const projectPattern = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
export function validateExistingWorkbenchCandidate(service, approved) {
  if (approved.WORKBENCH_SERVICE !== 'myscube-axr-workbench' || service?.metadata?.name !== approved.WORKBENCH_SERVICE) fail('Approved existing Workbench service is required.');
  for (const key of ['WORKBENCH_PROJECT_ID', 'WORKBENCH_MODEL_PROJECT_ID', 'PRODUCTION_PROJECT_ID', 'PRODUCTION_MODEL_PROJECT_ID', 'WORKBENCH_AUTH_PROJECT_ID']) if (!projectPattern.test(approved[key] || '')) fail(`Approved ${key} is required.`);
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(approved.WORKBENCH_AUTH_API_KEY || '') || !/^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(approved.WORKBENCH_AUTH_DOMAIN || '')) fail('Approved frontend authentication build settings are required.');
  const containers = service?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1 || !Array.isArray(containers[0].env)) fail('Existing single-container runtime configuration is required.');
  const entries = containers[0].env, seen = new Set(), runtime = {};
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || seen.has(entry.name)) fail('Runtime environment names must be unique.');
    seen.add(entry.name);
    if (typeof entry.value === 'string') runtime[entry.name] = entry.value;
    else if (entry.valueFrom?.secretKeyRef) runtime[entry.name] = '[configured-secret-reference]';
  }
  for (const key of ['WORKBENCH_PROJECT_ID', 'WORKBENCH_MODEL_PROJECT_ID', 'PRODUCTION_PROJECT_ID', 'PRODUCTION_MODEL_PROJECT_ID', 'WORKBENCH_AUTH_PROJECT_ID']) {
    if (runtime[key] !== approved[key]) fail(`Existing ${key} does not match the approved target.`);
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(runtime.WORKBENCH_TENANT_ID || '')) fail('Existing WORKBENCH_TENANT_ID is required.');
  for (const key of ['SETTLEMENT_AGENT_GEMINI_API_KEY', 'JVM_WEEKLY_API_BASE_URL', 'JVM_WEEKLY_INTERNAL_API_TOKEN', 'JVM_WEEKLY_API_SERVICE_ACCOUNT_JSON']) if (seen.has(key)) fail('A production credential or endpoint is configured in the isolated service.');
  if (runtime.WORKBENCH_AUTH_MODE === 'emulator' || seen.has('FIRESTORE_EMULATOR_HOST')) fail('Emulator authentication is forbidden in the Cloud Run candidate.');
  if (runtime.WORKBENCH_REMOTE_RUNTIME_ENABLED === 'true' || runtime.WORKBENCH_REACT_RUNTIME_URL) fail('This Cloud Run candidate cannot enable the Docker-host React runtime.');
  if (runtime.WORKBENCH_BIND_HOST !== undefined && runtime.WORKBENCH_BIND_HOST !== '0.0.0.0') fail('The Cloud Run candidate must bind its container interface.');
  resolveWorkbenchRuntime(runtime);
  return { ready: true, existingServiceVerified: true, runtimeConfigurationValidated: true, authConfigurationValidated: true };
}
async function main() {
  if (process.argv.length !== 3) fail('An existing service JSON file is required.');
  const file = resolve(process.argv[2]); const info = await stat(file); if (!info.isFile() || info.size > 1000000) fail('Service metadata exceeds its limit.');
  const text = await readFile(file, 'utf8'); if (Buffer.byteLength(text) > 1000000) fail('Service metadata exceeds its limit.');
  process.stdout.write(`${JSON.stringify(validateExistingWorkbenchCandidate(JSON.parse(text), process.env))}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write('Workbench candidate preflight failed. Review approved target, existing runtime and frontend authentication settings; configuration values are not logged.\n'); process.exitCode = 1; });
