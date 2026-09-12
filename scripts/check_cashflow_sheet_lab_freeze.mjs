import { execFileSync } from 'node:child_process';

export const CASHFLOW_SHEET_LAB_FREEZE_APPROVER = 'merryAI-dev';
export const CASHFLOW_SHEET_LAB_FREEZE_MARKER = 'CASHFLOW_SHEET_LAB_FREEZE_APPROVED';

export const CASHFLOW_SHEET_LAB_FREEZE_PATHS = [
  '.github/workflows/ci.yml',
  'scripts/check_cashflow_sheet_lab_freeze.mjs',
  'src/app/components/cashflow/CashflowProjectSheet.tsx',
  'src/app/features/cashflow-sheet-compare/CashflowSheetLabPage.tsx',
  'src/app/lib/sheets-cashflow-readonly-client.ts',
  'server/bff/java-weekly-client.mjs',
  'server/bff/routes/cashflow-sheet-lab.mjs',
  'server/bff/google-sheets.mjs',
  'server/bff/cashflow-sheet-template.mjs',
  'server/bff/cashflow-sheet-snapshot.mjs',
  'server/bff/cashflow-policy.mjs',
  'server/bff/cashflow-annual-total.mjs',
  'server/bff/cashflow-apply-lease.mjs',
  'server/bff/cashflow-close-hash.mjs',
  'server/bff/cashflow-close-calendar.mjs',
  'server/bff/schemas.mjs',
  'src/app/platform/cashflow-week-core.mjs',
  'server/jvm-weekly-api/src/main/java/dev/merryai/innerplatform/weekly/api/CashflowSheetLabApplyRequest.java',
  'server/jvm-weekly-api/src/main/java/dev/merryai/innerplatform/weekly/api/CashflowSheetLabApplyResponse.java',
  'server/jvm-weekly-api/src/main/java/dev/merryai/innerplatform/weekly/api/WeeklyExpenseController.java',
  'server/jvm-weekly-api/src/main/java/dev/merryai/innerplatform/weekly/domain/CashflowMonthCellSet.java',
  'server/jvm-weekly-api/src/main/java/dev/merryai/innerplatform/weekly/service/WeeklyExpenseCommandService.java',
  'server/jvm-weekly-api/src/main/java/dev/merryai/innerplatform/weekly/storage/FirestoreInheritedWeeklyExpensePersistence.java',
  'server/jvm-weekly-api/src/main/java/dev/merryai/innerplatform/weekly/storage/WeeklyExpensePersistence.java',
];

function latestReviewByLogin(reviews, login) {
  return reviews
    .filter((review) => review?.user?.login === login)
    .sort((left, right) => String(left.submitted_at || '').localeCompare(String(right.submitted_at || '')))
    .at(-1) || null;
}

export function evaluateCashflowSheetLabFreeze({ changedFiles, reviews, headSha }) {
  const protectedFiles = changedFiles.filter((file) => CASHFLOW_SHEET_LAB_FREEZE_PATHS.includes(file));
  if (protectedFiles.length === 0) return { ok: true, protectedFiles, approval: null };

  const approval = latestReviewByLogin(reviews, CASHFLOW_SHEET_LAB_FREEZE_APPROVER);
  const approved = approval?.state === 'APPROVED'
    && approval?.commit_id === headSha
    && String(approval?.body || '').includes(CASHFLOW_SHEET_LAB_FREEZE_MARKER);
  return { ok: approved, protectedFiles, approval };
}

function changedFiles(baseSha, headSha) {
  return execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', baseSha, headSha], { encoding: 'utf8' })
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean);
}

async function fetchReviews({ repository, pullNumber, token }) {
  const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${pullNumber}/reviews?per_page=100`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`승인 기록을 읽지 못했습니다. GitHub 응답: ${response.status}`);
  return response.json();
}

export async function runCashflowSheetLabFreeze(env = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return { ok: true, protectedFiles: [], approval: null };
  const files = changedFiles(env.CASHFLOW_SHEET_LAB_FREEZE_BASE_SHA, env.CASHFLOW_SHEET_LAB_FREEZE_HEAD_SHA);
  const reviews = await fetchReviews({
    repository: env.GITHUB_REPOSITORY,
    pullNumber: env.CASHFLOW_SHEET_LAB_FREEZE_PULL_NUMBER,
    token: env.GITHUB_TOKEN,
  });
  return evaluateCashflowSheetLabFreeze({ changedFiles: files, reviews, headSha: env.CASHFLOW_SHEET_LAB_FREEZE_HEAD_SHA });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCashflowSheetLabFreeze();
  if (!result.ok) {
    console.error('시트 연동 one-way 루프 변경은 별도 승인 후에만 병합할 수 있습니다.');
    console.error(`필요 승인: ${CASHFLOW_SHEET_LAB_FREEZE_APPROVER}의 ${CASHFLOW_SHEET_LAB_FREEZE_MARKER} 리뷰 (현재 PR HEAD 기준)`);
    console.error(`보호 파일: ${result.protectedFiles.join(', ')}`);
    process.exit(1);
  }
}
