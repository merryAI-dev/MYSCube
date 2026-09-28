import { Firestore } from '@google-cloud/firestore';
import { applyPermissionCopy, readPermissionCopy, copyLogPage } from './copy-feed.mjs';
import { resolveWorkbenchRuntime } from './runtime-config.mjs';

const env = process.env, runtime = resolveWorkbenchRuntime(env);
if (env.WORKBENCH_COPY_ENABLED !== 'true' || !env.WORKBENCH_COPY_SOURCE_PROJECT_ID || env.WORKBENCH_COPY_SOURCE_PROJECT_ID === runtime.projectId) throw new Error('Independent copy worker is disabled or incorrectly configured.');
const source = new Firestore({ projectId: env.WORKBENCH_COPY_SOURCE_PROJECT_ID });
const target = new Firestore({ projectId: runtime.projectId });
try {
  const permissions = await applyPermissionCopy({ db: target, env, input: await readPermissionCopy({ source, env }) });
  const logs = {};
  for (const kind of ['client_error_events', 'reliability_operations']) logs[kind] = await copyLogPage({ source, db: target, env, kind });
  process.stdout.write(JSON.stringify({ status: 'complete', permissions, logs }));
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'failed', code: error.expose ? error.code : 'workbench_copy_failed' }));
  process.exitCode = 1;
} finally { await source.terminate(); await target.terminate(); }
