import { expect, test, type Page } from '@playwright/test';

async function mockGoogleConnection(page: Page, cancelFirst = false) {
  await page.route('**/src/app/platform/google-drive-metadata-access.ts*', route => route.fulfill({
    contentType: 'application/javascript', body: `let calls=0; export async function requestGoogleDriveMetadataAccess(uid) {
      calls++; if (${cancelFirst} && calls===1) throw new Error('Google 연결이 취소되었습니다. 원할 때 다시 연결해 주세요.');
      return 'qa-google-token-' + calls;
    }`,
  }));
}

async function openInbox(page: Page, options: { staleHead?: boolean; reviewFails?: boolean } = {}) {
  const calls: { url: string; body: any }[] = [];
  const payload = { name: '종료 검토 대상', executiveApproverId: options.staleHead ? 'old-head' : 'u002',
    executiveApproverName: '지정 조직장', department: 'CIC1', contractEnd: '2030-12-31',
    businessManagementGoogleFolderLink: 'https://drive.google.com/drive/folders/qa-root-folder' };
  let closure: any = { id: 'closure-p009', requestKind: 'CLOSURE', targetProjectId: 'p009', status: 'PENDING',
    requestVersion: 1, payload, requestedAt: '2026-09-09T00:00:00Z',
    closureSubmission: { retentionStartDate: '2026-09-09', retentionPeriodYears: 5, handoverNote: '재경팀 보관본', driveDeletedAt: '', note: '미결 정산 유지',
      driveFolderLink: 'https://drive.google.com/drive/folders/qa-root-folder' } };
  const registration = { id: 'registration-p001', requestKind: 'REGISTRATION', approvedProjectId: 'p001',
    status: 'PENDING', payload: { name: '기존 등록 검토', executiveApproverId: 'u002' }, requestedAt: '2026-09-08T00:00:00Z' };
  await page.route('**/api/v1/project-requests/assigned-to-me', route => route.fulfill({ json: {
    items: [closure, registration], projects: [
      { id: 'p009', ...payload, executiveApproverId: 'u002', version: 4, status: 'IN_PROGRESS', executiveReviewStatus: 'APPROVED' },
      { id: 'p001', name: '기존 등록 검토', executiveApproverId: 'u002', executiveReviewStatus: 'PENDING', status: 'IN_PROGRESS' },
    ],
  } }));
  await page.route('**/api/v1/projects/*/closure-requests/*/review', route => {
    const body = route.request().postDataJSON();
    calls.push({ url: route.request().url(), body });
    if (options.reviewFails) return route.fulfill({ status: 409, json: { error: 'project_closure_version_conflict', message: '검토 대상이 변경되었습니다.' } });
    closure = { ...closure, status: body.decision, requestVersion: 2, reviewedBy: 'u002', reviewComment: body.comment };
    return route.fulfill({ json: { item: closure } });
  });
  await page.route('**/api/v1/projects/*/executive-review', route => {
    calls.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ json: { projectId: 'p001', reviewStatus: 'APPROVED' } });
  });
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await page.goto('/portal/project-approvals');
  await expect(page.getByLabel('요청 유형')).toBeVisible();
  return calls;
}

test('existing review panel routes closure approval without changing registration approval', async ({ page }) => {
  const calls = await openInbox(page);
  await page.getByLabel('요청 유형').selectOption('CLOSURE');
  await expect(page.getByRole('button', { name: '문서 열기', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '문서 열기', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '사업 종료 승인서' })).toBeVisible();
  await expect(page.getByTestId('migration-review-document')).toContainText('2026-09-09');
  await expect(page.getByTestId('migration-review-document')).toContainText('5년');
  await page.getByTestId('migration-review-document').locator('header').screenshot({ path: 'test-results/project-closure-document-header.png' });
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('미결 정산 여부는 제외 조건이 아니며');
  await page.getByRole('alertdialog').screenshot({ path: 'test-results/project-closure-approval.png' });
  await page.getByRole('button', { name: '승인 저장', exact: true }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].url).toContain('/closure-requests/closure-p009/review');
  expect(calls[0].body).toMatchObject({ decision: 'APPROVED', expectedRequestVersion: 1 });
  await expect(page.getByRole('dialog', { name: '사업 종료 승인서' })).toHaveCount(0);
  await page.getByLabel('요청 유형').selectOption('REGISTRATION');
  await expect(page.getByRole('button', { name: '문서 열기', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '문서 열기', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '프로젝트 등록 및 승인서' })).toBeVisible();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await page.getByRole('button', { name: '승인 저장', exact: true }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1].url).toContain('/p001/executive-review');
});

test('current head can return stale closure through same panel with required reason', async ({ page }) => {
  const calls = await openInbox(page, { staleHead: true });
  await page.getByLabel('요청 유형').selectOption('CLOSURE');
  await page.getByRole('button', { name: '문서 열기', exact: true }).click();
  await page.getByRole('button', { name: '반려', exact: true }).click();
  await expect(page.getByRole('button', { name: '반려 저장', exact: true })).toBeDisabled();
  await page.getByRole('alertdialog').getByRole('textbox').fill('새 조직장 기준으로 다시 제출해주세요.');
  await page.getByRole('button', { name: '반려 저장', exact: true }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].body).toMatchObject({ decision: 'REJECTED', comment: '새 조직장 기준으로 다시 제출해주세요.' });
});

test('closure conflict stays visible and never invokes generic project approval', async ({ page }) => {
  const calls = await openInbox(page, { reviewFails: true });
  await page.getByLabel('요청 유형').selectOption('CLOSURE');
  await page.getByRole('button', { name: '문서 열기', exact: true }).click();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await page.getByRole('button', { name: '승인 저장', exact: true }).click();
  await expect.poll(() => calls.length).toBe(1);
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page.getByRole('button', { name: '승인 저장', exact: true })).toBeEnabled();
  expect(calls.every(call => call.url.includes('/closure-requests/'))).toBe(true);
});

test('weekly and monthly worklist excludes approved closure but preserves history and unavailable projects', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mysc-auth-user', JSON.stringify({
    uid: 'u001', name: '검증 관리자', email: 'qa@mysc.co.kr', role: 'admin', source: 'dev_harness',
    tenantId: 'mysc', idToken: 'closure-browser-test-token', defaultWorkspace: 'admin', lastWorkspace: 'admin',
  })));
  await page.route('**/api/v1/projects?**', route => route.fulfill({ json: { items: [
    { id: 'p001', name: '종료된 검증 사업', status: 'COMPLETED', executiveApproverId: 'u001', department: 'CIC1' },
    { id: 'p009', name: '확인이 필요한 사업', status: 'IN_PROGRESS', executiveApproverId: 'u001', department: 'CIC1' },
    { id: 'p002', name: '진행 중인 사업', status: 'IN_PROGRESS', executiveApproverId: 'u001', department: 'CIC1' },
  ], nextCursor: null } }));
  await page.route('**/api/v1/cashflow/weekly-overview', route => {
    const { projectIds, yearMonth } = route.request().postDataJSON();
    const [year, month] = yearMonth.split('-').map(Number);
    const target = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
    const commands = ['SUBMIT_MONTH_CLOSE', 'WITHDRAW_MONTH_CLOSE', 'APPROVE_MONTH_CLOSE', 'REJECT_MONTH_CLOSE',
      'REQUEST_MONTH_REOPEN', 'APPROVE_MONTH_REOPEN', 'REJECT_MONTH_REOPEN', 'CANCEL_ACTIVE_CYCLE'];
    return route.fulfill({ json: { version: '5', yearMonth, monthCloseTargetYearMonth: target, monthCloseTargetLabel: '전월분 결산', errors: [],
      items: projectIds.map((projectId: string) => ({ projectId,
        settlementEligibility: { status: projectId === 'p001' ? 'CLOSED' : projectId === 'p009' ? 'UNAVAILABLE' : 'ACTIVE',
          weekly: !['p001', 'p009'].includes(projectId), monthly: !['p001', 'p009'].includes(projectId), writable: !['p001', 'p009'].includes(projectId) },
        settlementStatuses: { projectId, yearMonth, items: ['MONTH', 'WEEK_1', 'WEEK_2', 'WEEK_3', 'WEEK_4', 'WEEK_5'].map(period => ({
          period, status: 'WAITING_FOR_UPDATE', deadlineAt: `${yearMonth}-10T00:00:00.000Z`, approverDeadlineAt: `${yearMonth}-11T00:00:00.000Z`,
          submittedAt: '', submittedBy: '', approvedAt: '', approvedBy: '', revision: 0,
        })) },
        projectionActualSummary: null, sheetCapturedAt: null,
        settlementCycle: { cycleYearMonth: yearMonth, weeklyYearMonth: yearMonth, monthCloseTargetYearMonth: target,
          closeDeadline: `${yearMonth}-10`, businessState: 'NOT_REQUESTED', health: 'OK', workflowRevision: 0,
          monthCloseSettlement: null, provenance: null, supersededAttempt: null,
          commandCapabilities: Object.fromEntries(commands.map(command => [command, { allowed: true, reasonCode: '' }])) },
      })),
    } });
  });
  await page.goto('/cashflow/weekly');
  await expect(page.getByText('정산 대상 확인 필요', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('진행 중인 사업', { exact: true })).toBeVisible();
  await expect(page.getByText('종료된 검증 사업', { exact: true })).toHaveCount(0);
  await expect(page.getByText('종료 승인 · 이력 조회', { exact: true })).toHaveCount(0);
  const table = page.locator('table').last();
  const activeRows = await table.locator('tbody tr').count();
  await page.getByLabel('종료 사업 이력 포함').check();
  await expect(page.getByText('종료 승인 · 이력 조회', { exact: true })).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(activeRows + 1);
  const closedRow = table.getByRole('row').filter({ hasText: '종료 승인 · 이력 조회' });
  await expect(closedRow.getByRole('button')).toHaveCount(1);
  await expect(closedRow.getByRole('button', { name: '현금흐름 보기', exact: true })).toBeEnabled();
  await expect(closedRow).toContainText('종료 사업 · 이력 조회');
  await page.screenshot({ path: 'test-results/project-closure-weekly-history.png' });
  await page.getByLabel('종료 사업 이력 포함').uncheck();
  await expect(table.locator('tbody tr')).toHaveCount(activeRows);
});

test('checkout pending request hydrates retention fields and disables duplicate submission', async ({ page }) => {
  await page.route('**/api/v1/projects/*/latest-request*', route => route.fulfill({ json: { item: {
    id: 'closure-p009', requestKind: 'CLOSURE', targetProjectId: 'p009', status: 'PENDING', requestVersion: 1,
    payload: {}, closureSubmission: { retentionStartDate: '2026-09-09', retentionPeriodYears: 5,
      driveFolderLink: '', handoverNote: '재경팀 보관본', driveDeletedAt: '2026-09-10', note: '' },
  } } }));
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await page.goto('/portal/project-checkout');
  await expect(page.getByText('조직장 종료 승인 대기', { exact: true })).toBeVisible();
  await expect(page.getByLabel('보관 기산일')).toHaveValue('2026-09-09');
  await expect(page.getByLabel('보관 기산일')).toBeDisabled();
  await expect(page.getByRole('button', { name: '종료 승인 요청', exact: true })).toBeDisabled();
  await expect(page.locator('input[type=file]').first()).toBeDisabled();
});

test('Drive refresh failure does not leave stale empty-folder confirmation', async ({ page }) => {
  let calls = 0;
  await mockGoogleConnection(page);
  await openInbox(page);
  await page.route('**/api/v1/projects/*/closure-drive?**', route => {
    calls += 1;
    return route.fulfill(calls === 1 ? { json: { rootFolderId: 'root-folder', items: [], nextPageToken: null } }
      : { status: 503, json: { error: 'drive_unavailable', message: 'Drive unavailable' } });
  });
  await page.getByLabel('요청 유형').selectOption('CLOSURE');
  await page.getByRole('button', { name: '문서 열기', exact: true }).click();
  await page.getByRole('button', { name: 'Google 연결 후 조회', exact: true }).click();
  await expect(page.getByText('이 페이지에 표시할 파일이나 폴더가 없습니다.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '처음부터 다시 조회', exact: true }).click();
  await expect(page.getByText('자료 목록을 확인하지 못했습니다. 연결 상태와 Drive 공유 권한을 확인한 뒤 다시 조회해 주세요.', { exact: true })).toBeVisible();
  await expect(page.getByText('이 페이지에 표시할 파일이나 폴더가 없습니다.', { exact: true })).toHaveCount(0);
});

for (const code of ['project_closure_google_reconnect', 'project_closure_google_account_mismatch']) {
test(`Google cancellation makes no Drive request and reconnect replaces token after ${code}`, async ({ page }) => {
  await mockGoogleConnection(page, true);
  await openInbox(page);
  const tokens: string[] = [];
  await page.route('**/api/v1/projects/*/closure-drive?**', route => {
    tokens.push(route.request().headers()['x-google-access-token']);
    expect(route.request().url()).not.toContain('qa-google-token');
    return route.fulfill(tokens.length === 1
      ? { status: code.endsWith('mismatch') ? 403 : 401, json: { error: code, message: '현재 Google 계정으로 다시 연결해 주세요.' } }
      : { json: { rootFolderId: 'qa-root-folder', nextPageToken: null, items: [{ id: 'doc1', name: '보관 목록', mimeType: 'application/pdf' }] } });
  });
  await page.getByLabel('요청 유형').selectOption('CLOSURE');
  await page.getByRole('button', { name: '문서 열기', exact: true }).click();
  const connect = page.getByRole('button', { name: 'Google 연결 후 조회', exact: true });
  await connect.click();
  await expect(page.getByRole('alert')).toContainText('Google 연결이 취소되었습니다.');
  expect(tokens).toHaveLength(0);
  await connect.click();
  await expect(page.getByRole('alert')).toContainText('현재 Google 계정으로 다시 연결해 주세요.');
  await connect.click();
  await expect(page.getByRole('link', { name: '보관 목록', exact: true })).toBeVisible();
  expect(tokens).toEqual(['qa-google-token-2', 'qa-google-token-3']);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('qa-google-token');
});
}

for (const status of [403, 404]) {
  test(`Google Drive ${status} exposes safe access-request link without claiming empty folder`, async ({ page }) => {
    await mockGoogleConnection(page);
    await openInbox(page);
    await page.route('**/api/v1/projects/*/closure-drive?**', route => route.fulfill({ status, json: {
      error: status === 403 ? 'project_closure_drive_forbidden' : 'project_closure_drive_not_found', message: '폴더 접근을 확인해 주세요.',
    } }));
    await page.getByLabel('요청 유형').selectOption('CLOSURE');
    await page.getByRole('button', { name: '문서 열기', exact: true }).click();
    await page.getByRole('button', { name: 'Google 연결 후 조회', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('폴더 접근을 확인해 주세요.');
    await expect(page.getByRole('link', { name: 'Drive에서 열어 접근 권한 요청' })).toHaveAttribute('href', 'https://drive.google.com/drive/folders/qa-root-folder');
    await expect(page.getByText('이 페이지에 표시할 파일이나 폴더가 없습니다.', { exact: true })).toHaveCount(0);
  });
}
