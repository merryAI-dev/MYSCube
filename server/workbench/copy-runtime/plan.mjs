import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateCopyEnvironment } from './runtime.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const command = (...args) => args.map(quote).join(' ');

export function createCopyDeploymentPlan(input) {
  const keys = ['projectId', 'productionProjectId', 'modelProjectId', 'productionModelProjectId', 'region', 'tenantId', 'image', 'grants', 'sourceReadApproved'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(input, key))
    || typeof input.sourceReadApproved !== 'boolean' || !/^[a-z]+-[a-z]+[0-9]$/.test(input.region || '')) throw new Error('Invalid copy deployment plan.');
  const { projectId, productionProjectId, modelProjectId, productionModelProjectId, region, tenantId, image, grants, sourceReadApproved } = input;
  if (typeof image !== 'string' || !new RegExp(`^${region}-docker\\.pkg\\.dev/${projectId}/[a-z0-9_-]+/[a-z0-9_-]+@sha256:[a-f0-9]{64}$`).test(image)) throw new Error('An immutable image in the isolated project and region is required.');
  const environment = { WORKBENCH_PROJECT_ID: projectId, PRODUCTION_PROJECT_ID: productionProjectId, WORKBENCH_MODEL_PROJECT_ID: modelProjectId,
    PRODUCTION_MODEL_PROJECT_ID: productionModelProjectId, WORKBENCH_TENANT_ID: tenantId, WORKBENCH_COPY_SOURCE_PROJECT_ID: productionProjectId,
    WORKBENCH_COPY_DATASET_GRANTS: JSON.stringify(grants), WORKBENCH_AI_ENABLED: 'false', WORKBENCH_COPY_ENABLED: 'false', WORKBENCH_COPY_SOURCE_READ_APPROVED: 'false' };
  validateCopyEnvironment(environment, { executionRequired: false });
  const job = 'axr-copy-worker', scheduler = 'axr-copy-every-two-minutes';
  const worker = `${job}@${projectId}.iam.gserviceaccount.com`, invoker = `axr-copy-scheduler@${projectId}.iam.gserviceaccount.com`;
  const common = [`--project=${projectId}`, `--region=${region}`];
  const uri = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${job}:run`;
  return {
    schemaVersion: 1, printOnly: true, sourceReadApproved, environmentFile: { name: 'copy-disabled.env.json', content: JSON.stringify(environment, null, 2) + '\n' },
    identities: { worker, scheduler: invoker, applicationHost: 'must use a different identity with no source permissions' },
    prepare: [command('gcloud', 'run', 'jobs', 'create', job, ...common, `--image=${image}`, `--service-account=${worker}`, '--tasks=1', '--parallelism=1', '--max-retries=0', '--task-timeout=100s', '--cpu=1', '--memory=512Mi', '--command=node', '--args=server/workbench/copy-runtime/run.mjs', '--env-vars-file=copy-disabled.env.json')],
    activation: sourceReadApproved ? [
      command('gcloud', 'run', 'jobs', 'update', job, ...common, '--update-env-vars=WORKBENCH_COPY_ENABLED=true,WORKBENCH_COPY_SOURCE_READ_APPROVED=true'),
      command('gcloud', 'run', 'jobs', 'execute', job, ...common, '--wait'),
      '# STOP: verify the execution completed, copied permissions, source-read-only IAM, and absence of source writes before creating the schedule.',
      command('gcloud', 'scheduler', 'jobs', 'create', 'http', scheduler, `--project=${projectId}`, `--location=${region}`, '--schedule=*/2 * * * *', '--time-zone=Etc/UTC', `--uri=${uri}`, '--http-method=POST', '--headers=Content-Type=application/json', '--message-body={}', `--oauth-service-account-email=${invoker}`, '--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform', '--attempt-deadline=30s', '--max-retry-attempts=0', '--max-retry-duration=0s'),
    ] : ['Source read permission is not approved. No activation or scheduler creation commands are available.'],
    pause: [command('gcloud', 'scheduler', 'jobs', 'pause', scheduler, `--project=${projectId}`, `--location=${region}`), command('gcloud', 'run', 'jobs', 'update', job, ...common, '--update-env-vars=WORKBENCH_COPY_ENABLED=false')],
    notes: ['No command is executed by this module. IAM/API enablement and image publication require separate review.', 'The preparation command does not execute the job. The scheduler is created only after a manually verified first copy.', 'A retained execution lock requires confirmed terminal execution and an owner-matching transaction to recover; it never expires automatically.', 'The permissions copy expires after five minutes. A two-minute schedule and retries are not an availability guarantee.'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node plan.mjs approved-plan.json');
    const text = await readFile(process.argv[2], 'utf8');
    if (Buffer.byteLength(text) > 40000) throw new Error('Plan input is too large.');
    process.stdout.write(JSON.stringify(createCopyDeploymentPlan(JSON.parse(text)), null, 2) + '\n');
  } catch { process.stderr.write('Copy deployment plan is invalid; no cloud command was executed.\n'); process.exitCode = 1; }
}
