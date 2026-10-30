#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noteSaverFrom } from '../src/ema/note-save.mjs';
import { composerFrom, runOnce, tiroClientFrom } from '../src/tiro/autosave.mjs';

// Tiro 회의록 자동 저장을 이 컴퓨터에서 한 번 돌린다. Cloudflare Worker 크론과 같은 코드다.
// launchd(scripts/tiro-autosave.plist.example)로 10분마다 실행하면 이 컴퓨터를 서버처럼 쓸 수 있다.
// 설정: mcp-worker/.tiro-local/env (KEY=VALUE 줄). TIRO_API_KEY, ANTHROPIC_API_KEY, NOTES_SAVE_URL 필수.
// 처리 기록은 .tiro-local/state.json 에 남는다(Worker 의 KV 와 같은 역할).
// 사용법: node scripts/tiro-autosave-local.mjs [--dry-run]   (--dry-run: 드라이브에 쓰지 않고 정리 결과만 출력)

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.tiro-local');
mkdirSync(root, { recursive: true, mode: 0o700 });

function readEnv(path) {
  try {
    return Object.fromEntries(readFileSync(path, 'utf8').split('\n')
      .map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
  } catch { return {}; }
}

function fileKv(path) {
  let state = {};
  try { state = JSON.parse(readFileSync(path, 'utf8')); } catch { /* 처음 실행 */ }
  return {
    async get(key) {
      const entry = state[key];
      return entry && (!entry.expiresAt || entry.expiresAt > Date.now()) ? entry.value : null;
    },
    async put(key, value, { expirationTtl } = {}) {
      state[key] = { value, ...(expirationTtl ? { expiresAt: Date.now() + expirationTtl * 1000 } : {}) };
      writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    },
  };
}

const dryRun = process.argv.includes('--dry-run');
const env = { ...readEnv(join(root, 'env')), ...process.env };
const missing = ['TIRO_API_KEY', 'ANTHROPIC_API_KEY', ...(dryRun ? [] : ['NOTES_SAVE_URL'])].filter((name) => !env[name]);
if (missing.length) {
  console.error(`설정이 빠졌습니다: ${missing.join(', ')} (${join(root, 'env')})`);
  process.exit(2);
}

const saveNote = dryRun
  ? async ({ fileName, markdown }) => { console.log(`\n===== ${fileName}\n${markdown}`); return { fileId: 'dry-run', url: null, name: fileName, updated: false }; }
  : noteSaverFrom(env);
const report = await runOnce({
  tiro: tiroClientFrom({ apiKey: env.TIRO_API_KEY }),
  compose: composerFrom({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || undefined }),
  saveNote,
  // 미리보기는 처리 기록을 남기지 않는다(실제 실행이 같은 노트를 건너뛰지 않게).
  kv: dryRun ? { get: async () => null, put: async () => {} } : fileKv(join(root, 'state.json')),
  scope: env.TIRO_SCOPE === 'organization' ? 'organization' : 'workspace',
  skipPattern: env.TIRO_SKIP_PATTERN ?? undefined,
  maxPerRun: Number(env.TIRO_MAX_PER_RUN) || 8,
});
console.log(JSON.stringify({ at: new Date().toISOString(), dryRun, ...report, results: report.results.filter((r) => r.status !== 'unchanged') }));
if (report.results.some((r) => r.status === 'error')) process.exitCode = 1;
