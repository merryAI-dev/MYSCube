import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importHttpLogExport, HTTP_LOG_IMPORT_MAX_BYTES } from './http-log-import.mjs';
import { resolveWorkbenchRuntime } from './runtime-config.mjs';

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write('node server/workbench/http-log-import-cli.mjs --file <operator-export-v1.json>\nImports partial, unverified operator-exported Vercel HTTP observations into the isolated database only.\n'); return; }
  if (args.length !== 2 || args[0] !== '--file' || !args[1] || env.WORKBENCH_HTTP_LOG_IMPORT_ENABLED !== 'true') throw new Error('Import is disabled or arguments are invalid.');
  const runtime = resolveWorkbenchRuntime(env);
  const file = await open(resolve(args[1]), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let input;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > HTTP_LOG_IMPORT_MAX_BYTES) throw new Error('Invalid export file.');
    const buffer = Buffer.alloc(HTTP_LOG_IMPORT_MAX_BYTES + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await file.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
    if (length > HTTP_LOG_IMPORT_MAX_BYTES) throw new Error('Export too large.');
    input = JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { await file.close(); }
  const { Firestore } = await import('@google-cloud/firestore');
  const db = new Firestore({ projectId: runtime.projectId });
  try { process.stdout.write(`${JSON.stringify(await importHttpLogExport({ db, env, input }))}\n`); } finally { await db.terminate(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write('HTTP 기록을 등록하지 못했습니다. 독립 저장소 설정, 승인된 내보내기 파일 및 쓰기 권한을 확인해 주세요. 원본 기록은 변경하지 않았습니다.\n'); process.exitCode = 1; });
