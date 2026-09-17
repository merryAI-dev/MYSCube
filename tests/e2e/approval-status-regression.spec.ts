import { expect, test, type Page } from '@playwright/test';

const projects = [
  ['kosa', 'QA KOSA', 'APPROVED', 'u001', 'CIC1'],
  ['seed', 'QA Seed0', 'APPROVED', 'u001', 'CIC1'],
  ['jung', 'QA 중서원', 'APPROVED', 'u001', 'CIC2'],
  ['pending', 'QA 대기', 'PENDING', 'u001', 'CIC1'],
  ['rejected', 'QA 반려', 'REVISION_REJECTED', 'u001', 'CIC2'],
  ['other', 'QA 다른조직장', 'APPROVED', 'u002', 'CIC2'],
].map(([id, name, executiveReviewStatus, executiveApproverId, department]) => ({
  id, name, officialContractName: name, executiveReviewStatus, executiveApproverId, department,
  clientOrg: '격리 테스트 고객', managerName: '담당자', status: 'IN_PROGRESS',
  contractStart: '2026-01-01', contractEnd: '2026-12-31', contractAmount: 100,
  salesVatAmount: 100, totalRevenueAmount: 100, totalActualCost: 0,
  registeredAt: '2026-09-16T00:00:00Z', teamMembers: [], teamMembersDetailed: [],
}));

async function openApproval(page: Page, error = false, path = '/projects/migration-audit', changePending = false) {
  const writes: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('mysc-auth-user', JSON.stringify({ uid: 'u001', name: 'QA 관리자',
      email: 'qa@mysc.co.kr', role: 'admin', tenantId: 'org001', source: 'firebase',
      idToken: 'isolated-test-token', defaultWorkspace: 'admin', lastWorkspace: 'admin' }));
    localStorage.setItem('MYSC_ACTIVE_TENANT', 'org001');
  });
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/projects') return route.fulfill({ json: { items: projects, nextCursor: null } });
    if (path === '/api/v1/project-requests/review-inbox') return route.fulfill(error
      ? { status: 422, json: { error: 'qa_read_failure', message: '격리된 조회 실패' } }
      : { json: { items: changePending ? [{ id: 'change-kosa', targetProjectId: 'kosa', requestKind: 'CHANGE', status: 'PENDING', requestedAt: '2026-09-17T00:00:00Z', proposedSnapshot: projects[0] }] : [] } });
    if (!['GET', 'HEAD'].includes(route.request().method())) writes.push(path);
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto(path);
  await expect(page.getByRole('heading', { name: '프로젝트 등록/승인', exact: true, level: 1 })).toBeVisible();
  return writes;
}

async function choose(page: Page, index: number, label: string) {
  await page.getByTestId('migration-review-search-bar').getByRole('combobox').nth(index).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

test('completed decisions remain visible with aligned counts, filters and read-only approval documents', async ({ page }, testInfo) => {
  const writes = await openApproval(page);
  const list = page.getByTestId('migration-review-record-list');
  await expect(list.getByText('QA 대기', { exact: true })).toBeVisible();
  await expect(list.getByText('QA KOSA', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('검토 대기 1건, 승인 완료 3건, 반려 1건', { exact: true })).toBeVisible();
  await expect(page.getByText('대기 1건', { exact: true })).toBeVisible();
  await choose(page, 2, '승인 완료');
  for (const name of ['QA KOSA', 'QA Seed0', 'QA 중서원']) await expect(list.getByText(name, { exact: true })).toBeVisible();
  await expect(list.getByText('QA 다른조직장', { exact: true })).toHaveCount(0);
  const screenshotPath = testInfo.outputPath('three-approved-projects.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach('three-approved-projects', { path: screenshotPath, contentType: 'image/png' });
  await list.getByRole('row').filter({ hasText: 'QA KOSA' }).getByRole('button', { name: '문서 열기' }).click();
  const dialog = page.getByTestId('migration-review-document');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '승인', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '반려', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await choose(page, 2, '수정 요청 후 반려');
  await expect(list.getByText('QA 반려', { exact: true })).toBeVisible();
  await choose(page, 0, '전체 검토 문서');
  await choose(page, 2, '승인 완료');
  await expect(list.getByText('QA 다른조직장', { exact: true })).toBeVisible();
  await expect(page.getByLabel('검토 대기 1건, 승인 완료 4건, 반려 1건', { exact: true })).toBeVisible();
  await choose(page, 1, 'CIC2');
  await expect(page.getByText('대기 0건', { exact: true })).toBeVisible();
  await expect(page.getByLabel('검토 대기 0건, 승인 완료 2건, 반려 1건', { exact: true })).toBeVisible();
  await testInfo.attach('approval-status-aligned', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  expect(writes).toEqual([]);
});

test('inbox load failure is labeled as an error rather than an authoritative pending count', async ({ page }) => {
  await openApproval(page, true);
  await expect(page.getByText('조회 오류', { exact: true })).toBeVisible();
  await expect(page.getByText('PM 등록 프로젝트와 접수 이력을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')).toBeVisible();
});

test('approvals route exposes the same complete review data', async ({ page }) => {
  await openApproval(page, false, '/approvals');
  await expect(page.getByLabel('검토 대기 1건, 승인 완료 3건, 반려 1건', { exact: true })).toBeVisible();
  await choose(page, 2, '승인 완료');
  await expect(page.getByTestId('migration-review-record-list').getByText('QA KOSA', { exact: true })).toBeVisible();
});

test('pending change request aligns the approved canonical project with pending badge and row', async ({ page }) => {
  await openApproval(page, false, '/approvals', true);
  await expect(page.getByText('대기 2건', { exact: true })).toBeVisible();
  await expect(page.getByLabel('검토 대기 2건, 승인 완료 2건, 반려 1건', { exact: true })).toBeVisible();
  await expect(page.getByTestId('migration-review-record-list').getByText('QA KOSA', { exact: true })).toBeVisible();
});
