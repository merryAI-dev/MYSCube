import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..');
const workflowText = readFileSync(resolve(repoRoot, '.github/workflows/cashflow-weekly-digest.yml'), 'utf8');

// 다이제스트는 조용히 안 나가도 아무도 모른다. 시각과 대상 경로를 여기서 고정한다.
describe('cashflow weekly digest workflow', () => {
  it('19:00 / 23:59 KST 두 번 돈다', () => {
    expect(workflowText).toContain("- cron: '0 10 * * *'");
    expect(workflowText).toContain("- cron: '59 14 * * *'");
  });

  it('손으로도 쏠 수 있다', () => {
    expect(workflowText).toContain('workflow_dispatch:');
  });

  it('라이브 다이제스트 워커를 부른다', () => {
    expect(workflowText).toContain('https://myscube.myscguard.app/api/internal/workers/cashflow-weekly-digest/run');
  });

  it('시크릿이 없으면 조용히 넘어가지 않고 실패한다', () => {
    expect(workflowText).toContain('Missing repository secret: CRON_SECRET');
    expect(workflowText).toContain('CRON_SECRET: ${{ secrets.CRON_SECRET }}');
  });

  it('200 이 아니면 실패한다', () => {
    expect(workflowText).toContain('if [ "${status}" != "200" ]');
  });

  // Cloudflare 가 기본 curl UA 를 봇으로 보고 403 을 준다.
  it('브라우저 UA 로 부른다', () => {
    expect(workflowText).toContain("-A 'Mozilla/5.0");
  });
});
