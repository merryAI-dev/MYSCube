import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');
const vercelConfig = JSON.parse(readFileSync(resolve(repoRoot, 'vercel.json'), 'utf8'));

// 한 워커가 하루 여러 번 돌 수 있어 경로별 단일 스케줄이 아니라 (경로, 스케줄) 쌍으로 고정한다.
const VERCEL_OWNED_CRONS = [
  ['/api/internal/workers/work-queue/run', '15 2 * * *'],
  ['/api/internal/workers/outbox/run', '30 2 * * *'],
  ['/api/internal/workers/payroll/run', '45 2 * * *'],
  // 주정산 완료 다이제스트. 18:30 / 23:59 KST = 09:30 / 14:59 UTC.
  ['/api/internal/workers/cashflow-weekly-digest/run', '30 9 * * *'],
  ['/api/internal/workers/cashflow-weekly-digest/run', '59 14 * * *'],
];

const VERCEL_OWNED_WORKERS = new Set(VERCEL_OWNED_CRONS.map(([path]) => path));

describe('scheduler ownership config', () => {
  it('keeps every Vercel cron on the documented Vercel-owned worker set', () => {
    const crons = (vercelConfig.crons || []).map((cron: { path: string; schedule: string }) => [
      cron.path,
      cron.schedule,
    ]);

    expect(crons.slice().sort()).toEqual(VERCEL_OWNED_CRONS.slice().sort());
  });

  it('rewrites every Vercel-owned worker route into the BFF function', () => {
    const rewrites = new Map((vercelConfig.rewrites || []).map((rewrite: { source: string; destination: string }) => [
      rewrite.source,
      rewrite.destination,
    ]));

    for (const workerPath of VERCEL_OWNED_WORKERS) {
      expect(rewrites.get(workerPath)).toBe(`/api/bff?__path=${workerPath}`);
    }
  });

  it('allows the cashflow sheet sync enough runtime to finish every connected project', () => {
    expect(vercelConfig.functions?.['api/bff.js']?.maxDuration).toBeGreaterThanOrEqual(300);
  });
});
