import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkbenchRuntime } from './runtime-config.mjs';
import { createAnalyticsService } from './analytics-service.mjs';
import { ANALYTICS_LIMITS, analyticsError } from './analytics-contract.mjs';
import { buildCashflowInflowDataset } from './cashflow-inflow-copy.mjs';

export async function importAnalyticsSnapshot({ env, db, authorize, context, input, now, format = 'dataset' }) {
  const runtime = resolveWorkbenchRuntime(env);
  if (env.WORKBENCH_IMPORT_ENABLED !== 'true' || db.projectId !== runtime.projectId || typeof authorize !== 'function') {
    throw analyticsError(403, 'analytics_import_disabled', '독립 분석 저장소의 사본 등록이 활성화되어야 합니다.');
  }
  await authorize(context);
  if (!['dataset', 'sheets-inflow'].includes(format)) throw analyticsError(400, 'analytics_import_format_invalid', '지원하지 않는 분석 사본 형식입니다.');
  const dataset = format === 'sheets-inflow' ? buildCashflowInflowDataset(input) : input;
  const result = await createAnalyticsService({ db, now }).importDataset(context, dataset);
  await authorize(context);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('node server/workbench/analytics-import.mjs --file <snapshot.json> --tenant <tenant> --actor <admin> [--format dataset|sheets-inflow]\nRequires WORKBENCH_IMPORT_ENABLED=true and an isolated Workbench project. Reads one local JSON snapshot; never reads production datasets. sheets-inflow validates copied A1:BT60 matrices; it does not call Google Sheets.\n');
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--file', '--tenant', '--actor', '--format'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid importer arguments');
    options[args[i]] = args[i + 1];
  }
  if (!options['--file'] || !options['--tenant'] || !options['--actor']) throw new Error('Missing importer arguments');
  const runtime = resolveWorkbenchRuntime(process.env);
  if (process.env.WORKBENCH_IMPORT_ENABLED !== 'true') throw new Error('Importer is disabled');
  const file = resolve(options['--file']);
  const info = await stat(file);
  if (!info.isFile() || info.size > ANALYTICS_LIMITS.datasetBytes) throw new Error('Snapshot must be a local file within 5MB');
  const text = await readFile(file, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > ANALYTICS_LIMITS.datasetBytes) throw new Error('Snapshot exceeds 5MB');
  const input = JSON.parse(text);
  const { Firestore } = await import('@google-cloud/firestore');
  const { createIsolatedWorkbenchCore } = await import('./core.mjs');
  const db = new Firestore({ projectId: runtime.projectId });
  try {
    const core = createIsolatedWorkbenchCore({ env: process.env, db });
    const context = { tenantId: options['--tenant'], actorId: options['--actor'], actorRole: 'admin' };
    const result = await importAnalyticsSnapshot({ env: process.env, db, authorize: core.authorize, context, input, format: options['--format'] || 'dataset' });
    process.stdout.write(`${JSON.stringify({ datasetId: result.datasetId, version: result.version, rowCount: result.rowCount, capturedAt: result.capturedAt })}\n`);
  } finally { await db.terminate(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.expose ? error.message : '분석 사본 등록을 완료하지 못했습니다. 독립 저장소 설정·권한·입력 파일을 확인해 주세요.'}\n`);
    process.exitCode = 1;
  });
}
