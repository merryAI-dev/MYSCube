import { Firestore } from '@google-cloud/firestore';
import { runScheduledCopy, validateCopyEnvironment } from './runtime.mjs';

let db;
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
try {
  const config = validateCopyEnvironment(process.env);
  if (!config.enabled) {
    process.stdout.write(JSON.stringify({ event: 'workbench.copy', status: 'disabled', sourceReadStarted: false }) + '\n');
  } else {
    db = new Firestore({ projectId: config.projectId });
    const result = await runScheduledCopy({ db, env: process.env, signal: controller.signal });
    process.stdout.write(JSON.stringify({ event: 'workbench.copy', ...result }) + '\n');
    if (!['complete', 'backoff'].includes(result.status)) process.exitCode = 1;
  }
} catch {
  process.stderr.write(JSON.stringify({ event: 'workbench.copy', status: 'failed', code: 'copy_runtime_failed' }) + '\n');
  process.exitCode = 1;
} finally {
  await db?.terminate();
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
}
