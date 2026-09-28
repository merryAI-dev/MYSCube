import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectCopyProducer } from './project-copy.mjs';
import { resolveWorkbenchRuntime } from './runtime-config.mjs';

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write('node server/workbench/project-copy-cli.mjs --tenant <tenant> --actor <approved-admin-uid>\nReads at most 1001 projected source documents; imports only a complete snapshot of at most 1000 into the independent database. No source writes or automatic grants. Uses the copy operator ADC, never app VM credentials.\n'); return; }
  if (args.length !== 4 || args[0] !== '--tenant' || args[2] !== '--actor' || ![args[1], args[3]].every(value => /^[a-zA-Z0-9_-]{1,128}$/.test(value))) throw new Error('Invalid arguments');
  const runtime = resolveWorkbenchRuntime(env);
  if (env.WORKBENCH_PROJECT_COPY_ENABLED !== 'true' || env.WORKBENCH_IMPORT_ENABLED !== 'true' || env.WORKBENCH_COPY_SOURCE_PROJECT_ID !== runtime.productionProjectId || env.WORKBENCH_TENANT_ID !== args[1]) throw new Error('Project copy is disabled');
  const [{ Firestore }, { createIsolatedWorkbenchCore }] = await Promise.all([import('@google-cloud/firestore'), import('./core.mjs')]);
  const source = new Firestore({ projectId: runtime.productionProjectId }), db = new Firestore({ projectId: runtime.projectId });
  try {
    const core = createIsolatedWorkbenchCore({ env, db });
    const result = await createProjectCopyProducer({ env, source, db, authorize: core.authorize }).run({ tenantId: args[1], actorId: args[3], actorRole: 'admin' });
    process.stdout.write(`${JSON.stringify({ datasetId: result.datasetId, version: result.version, rowCount: result.rowCount, sourceReadTime: result.sourceReadTime, projectionHash: result.projectionHash })}\n`);
  } finally { await source.terminate(); await db.terminate(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.expose ? error.message : '사업 사본 연결을 완료하지 못했습니다. 독립 저장소·읽기 전용 원본 연결·이 계정의 자료 권한을 확인해 주세요.'}\n`); process.exitCode = 1; });
