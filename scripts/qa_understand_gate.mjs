#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function run(command) {
  return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function fail(message) {
  failures.push(message);
}

function expectContains(relativePath, needle) {
  const source = read(relativePath);
  if (!source.includes(needle)) fail(`${relativePath} must contain: ${needle}`);
}

function expectNotContains(relativePath, needle) {
  const source = read(relativePath);
  if (source.includes(needle)) fail(`${relativePath} must not contain: ${needle}`);
}

function getChangedFiles() {
  const staged = process.argv.includes('--staged');
  const command = staged
    ? 'git diff --cached --name-only --diff-filter=ACM'
    : 'git diff --name-only --diff-filter=ACM';
  return run(command).split('\n').map((item) => item.trim()).filter(Boolean);
}

const repoRoot = run('git rev-parse --show-toplevel');
const failures = [];
const warnings = [];

process.chdir(repoRoot);

function resolveUnderstandRoot() {
  try {
    const commonDir = run('git rev-parse --git-common-dir');
    const gitDir = run('git rev-parse --git-dir');
    const commonAbs = path.resolve(repoRoot, commonDir);
    const gitAbs = path.resolve(repoRoot, gitDir);
    if (commonAbs !== gitAbs) return path.dirname(commonAbs);
  } catch {
    return repoRoot;
  }
  return repoRoot;
}

const understandRoot = resolveUnderstandRoot();
const graphPath = path.join(understandRoot, '.understand-anything', 'knowledge-graph.json');
if (!existsSync(graphPath)) {
  warnings.push('Missing .understand-anything/knowledge-graph.json. Run $understand-anything:understand before architecture-sensitive QA.');
} else {
  try {
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    const nodeIds = new Set((graph.nodes || []).map((node) => node.id));
    for (const filePath of getChangedFiles()) {
      if (!filePath.startsWith('src/app/') && !filePath.startsWith('firebase/')) continue;
      const expectedIds = [`file:${filePath}`, `config:${filePath}`];
      if (!expectedIds.some((id) => nodeIds.has(id))) {
        warnings.push(`Understand graph has no node for changed file: ${filePath}`);
      }
    }
  } catch (error) {
    warnings.push(`Could not parse understand graph: ${error instanceof Error ? error.message : String(error)}`);
  }
}

expectContains('firebase/firestore.rules', 'match /orgs/{orgId}/settings/project-departments');
expectContains('firebase/firestore.rules', 'allow write: if isAdmin(orgId);');
expectContains('firebase/firestore.rules', 'isCatchallExcludedPath(collection, document)');

expectContains('src/app/data/project-department-options.ts', 'sortOrder: number');
expectContains('src/app/data/project-department-options.ts', '.sort((a, b) => {');
expectContains('src/app/data/project-department-options.ts', '`${baseId}-${nextCount}`');
expectContains('src/app/components/settings/SettingsPage.tsx', "const PRIMARY_SETTINGS_TABS = ['members', 'tenants', 'organizations'] as const;");
expectContains('src/app/components/settings/SettingsPage.tsx', '관리자에게 필요한 멤버DB와 조직DB만 관리합니다');
expectNotContains('src/app/components/settings/SettingsPage.tsx', 'renderProjectSelectionValuesCard');
expectNotContains('src/app/components/settings/SettingsPage.tsx', 'handleMoveDepartment');
expectNotContains('src/app/components/settings/SettingsPage.tsx', '이미 등록된 담당조직(CIC)입니다.');
expectNotContains('src/app/components/settings/SettingsPage.tsx', '원장 템플릿');
expectNotContains('src/app/components/settings/SettingsPage.tsx', '데이터 마이그레이션');
expectNotContains('src/app/components/settings/SettingsPage.tsx', '조직 정보</CardTitle>');

expectNotContains('src/app/components/projects/ProjectListPage.tsx', '모니터링 프리셋');
expectNotContains('src/app/components/cashflow/CashflowProjectSheet.tsx', 'copyMonthValues');
expectNotContains('src/app/components/cashflow/CashflowProjectSheet.tsx', 'Projection → Actual');
expectNotContains('src/app/components/cashflow/CashflowProjectSheet.tsx', 'Actual → Projection');
expectContains('src/app/components/cashflow/CashflowProjectSheet.tsx', 'data-cashflow-settlement-actions');
expectContains('src/app/components/cashflow/CashflowProjectSheet.tsx', 'handleOpenMonthCloseReview');
expectContains('src/app/components/cashflow/CashflowProjectSheet.tsx', 'monthClosePreparation');
expectNotContains('src/app/components/cashflow/ImportEditor.tsx', '행 정보');
expectNotContains('src/app/components/cashflow/ImportEditorRow.tsx', '행 정보');
expectNotContains('src/app/components/portal/PortalWeeklyExpensePage.tsx', '저장되지 않은 사업비 입력이 있습니다');
expectNotContains('src/app/components/portal/PortalWeeklyExpensePage.tsx', '지금 이동하면 저장되지 않은 사업비 입력(주간) 편집 내용이 유실될 수 있습니다.');

if (warnings.length) {
  console.warn('[qa:understand:gate] warnings');
  warnings.forEach((warning) => console.warn(`- ${warning}`));
}

if (failures.length) {
  console.error('[qa:understand:gate] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[qa:understand:gate] passed');
