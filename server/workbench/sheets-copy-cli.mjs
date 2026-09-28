import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSheetsCopyProducer, SHEETS_READONLY_SCOPE } from './sheets-copy.mjs';
import { resolveWorkbenchRuntime } from './runtime-config.mjs';

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write('node server/workbench/sheets-copy-cli.mjs --manifest <approved.json> --tenant <tenant> --actor <admin> --month YYYY-MM --weeks 1,2\nDisabled by default. Reads approved Sheets A1:BT60 only and imports into the isolated analytics database. Never updates source Sheets.\n'); return; }
  const options = {};
  for (let i = 0; i < args.length; i += 2) { if (!['--manifest', '--tenant', '--actor', '--month', '--weeks'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid arguments'); options[args[i]] = args[i + 1]; }
  if (Object.keys(options).length !== 5 || !/^[1-5](,[1-5])*$/.test(options['--weeks'])) throw new Error('Missing or invalid arguments');
  const runtime = resolveWorkbenchRuntime(env);
  if (env.WORKBENCH_SHEETS_COPY_ENABLED !== 'true' || env.WORKBENCH_IMPORT_ENABLED !== 'true') throw new Error('Sheets copy is disabled');
  const file = resolve(options['--manifest']); const info = await stat(file); if (!info.isFile() || info.size > 100000) throw new Error('Manifest must be a local approved file under 100KB');
  const text = await readFile(file, 'utf8'); if (Buffer.byteLength(text) > 100000) throw new Error('Manifest too large'); const manifest = JSON.parse(text);
  const [{ Firestore }, { GoogleAuth }, { createIsolatedWorkbenchCore }] = await Promise.all([import('@google-cloud/firestore'), import('google-auth-library'), import('./core.mjs')]);
  const db = new Firestore({ projectId: runtime.projectId });
  try {
    const auth = new GoogleAuth({ scopes: [SHEETS_READONLY_SCOPE] }); const core = createIsolatedWorkbenchCore({ env, db });
    const producer = createSheetsCopyProducer({ env, db, manifest, authorize: core.authorize, getToken: async () => { const client = await auth.getClient(); return (await client.getAccessToken()).token; } });
    const result = await producer.run({ tenantId: options['--tenant'], actorId: options['--actor'], actorRole: 'admin' }, { yearMonth: options['--month'], weekNos: options['--weeks'].split(',').map(Number) });
    process.stdout.write(`${JSON.stringify({ datasetId: result.datasetId, version: result.version, rowCount: result.rowCount, sources: result.sources })}\n`);
  } finally { await db.terminate(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.expose ? error.message : '시트 사본 수집을 완료하지 못했습니다. 독립 저장소 설정·승인된 연결 목록·읽기 권한을 확인해 주세요.'}\n`); process.exitCode = 1; });
