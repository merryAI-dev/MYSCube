import { expect, test } from '@playwright/test';

test('edit recovery waits for the server draft and storage failure does not prevent remote saving', async ({ page }) => {
  const key = 'mysc:project-editor-autosave:portal-edit-mysc-p009-u002';
  let releaseOpen!: () => void;
  const opened = new Promise<void>((resolve) => { releaseOpen = resolve; });
  let record = {
    projectId: 'p009', resourceId: 'p009', resourceType: 'project-info', baseCanonicalVersion: 1,
    draftRevision: 17, payload: { name: '최근 서버 입력' }, attachmentRefs: [], stepIndex: 0,
  };
  const saves: Array<{ expectedDraftRevision: number; payload: { name: string } }> = [];
  await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({
    schemaVersion: 1, draftKey: key, draft: { name: '복구할 내 입력' }, stepIndex: 0, updatedAt: '2026-09-01T00:00:00.000Z',
  })), key);
  await page.route('**/api/v1/edit-leases/**', (route) => route.fulfill({ json: {
    serverNow: new Date().toISOString(), state: 'ACTIVE', canEdit: true,
    expiresAt: new Date(Date.now() + 1_800_000).toISOString(), leaseId: 'test-lease', fence: 1,
  } }));
  await page.route('**/api/v1/projects/p009/latest-request', (route) => route.fulfill({ json: { request: null } }));
  await page.route('**/api/v1/project-info-drafts/p009/open', async (route) => {
    await opened;
    await route.fulfill({ json: { draft: record } });
  });
  await page.route('**/api/v1/project-info-drafts/p009', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      saves.push(body);
      record = { ...record, draftRevision: record.draftRevision + 1, payload: body.payload };
    }
    await route.fulfill({ json: { draft: record } });
  });
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await page.goto('/portal/edit-project/p009');
  const restore = page.getByRole('button', { name: '임시저장 불러오기', exact: true });
  await expect(restore).toBeDisabled();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).draft.name, key)).toBe('복구할 내 입력');
  releaseOpen();
  await expect(restore).toBeEnabled();
  await restore.click();
  await expect(page.getByRole('dialog')).toContainText('최근 서버 입력');
  expect(saves).toHaveLength(0);
  await page.getByRole('button', { name: '내 입력으로 계속', exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].expectedDraftRevision).toBe(17);
  await expect(page.getByText(/^임시저장됨/)).toBeVisible();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.includes('project-editor-autosave:')) throw new DOMException('quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.getByPlaceholder('예: 26농식품AC').fill('저장소가 가득 차도 서버 저장');
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1].expectedDraftRevision).toBe(18);
  expect(saves[1].payload.name).toBe('저장소가 가득 차도 서버 저장');
  await expect(page.getByText(/^임시저장됨/)).toBeVisible();
});

test('unresolved backup survives manual save; restore is explicit and another server change conflicts again', async ({ page }) => {
  const draftId = 'recovery-conflict-test';
  const key = `mysc:project-editor-autosave:portal-register-mysc-u002-${draftId}`;
  const attachments = (version: string) => ['contract', 'customer_business_registration', 'quote'].map((documentKind) => ({
    documentKind, path: `server/${version}/${documentKind}`, name: `${version}.pdf`, size: 100, contentType: 'application/pdf', uploadedAt: '2026-09-01T00:00:00.000Z',
  }));
  let record = { draftId, resourceType: 'project-registration', resourceId: draftId, draftRevision: 2, payload: { name: '서버 B' }, attachmentRefs: attachments('B'), stepIndex: 0 };
  const saves: Array<{ expectedDraftRevision: number; payload: { name: string; contractDocument: { path: string } } }> = [];
  await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
    schemaVersion: 1, draftKey: 'backup', draft: { name: '내 입력 A', contractDocument: { path: 'local/A' } }, stepIndex: 0, updatedAt: '2026-09-01T00:00:00.000Z',
  })), { key });
  await page.route('**/api/v1/edit-leases/**', (route) => route.fulfill({ json: {
    serverNow: new Date().toISOString(), state: 'ACTIVE', canEdit: true,
    expiresAt: new Date(Date.now() + 1_800_000).toISOString(), leaseId: 'test-lease', fence: 1,
  } }));
  await page.route(`**/api/v1/project-registration-drafts/${draftId}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      saves.push(body);
      if (body.expectedDraftRevision !== record.draftRevision) {
        await route.fulfill({ status: 409, json: { error: 'draft_version_conflict' } });
        return;
      }
      record = { ...record, draftRevision: record.draftRevision + 1, payload: body.payload };
    }
    await route.fulfill({ json: { draft: record } });
  });
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await page.goto(`/portal/register-project/${draftId}`);
  await page.getByRole('button', { name: '임시저장', exact: true }).click();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).draft.name, key)).toBe('내 입력 A');
  expect(saves).toHaveLength(0);
  await page.getByRole('button', { name: '임시저장 불러오기', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('서버 B');
  expect(saves).toHaveLength(0);
  record = { ...record, draftRevision: 3, payload: { name: '서버 C' }, attachmentRefs: attachments('C') };
  await page.getByRole('button', { name: '내 입력으로 계속', exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].expectedDraftRevision).toBe(2);
  expect(saves[0].payload.contractDocument.path).toBe('server/B/contract');
  await expect(page.getByRole('dialog')).toContainText('서버 C');
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  const name = page.getByPlaceholder('예: 26농식품AC');
  await name.fill('내 입력 D');
  await page.getByRole('button', { name: '입력 비교하기', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('내 입력 D');
  expect(saves).toHaveLength(1);
  await page.getByRole('button', { name: '내 입력으로 계속', exact: true }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1].expectedDraftRevision).toBe(3);
  expect(saves[1].payload.name).toBe('내 입력 D');
  expect(saves[1].payload.contractDocument.path).toBe('server/C/contract');
});

test('fileless registration keeps latest text locally across lease loss and reload without a server save', async ({ page }) => {
  const draftId = 'recovery-browser-test';
  let saves = 0;
  let canEdit = true;
  await page.route('**/api/v1/edit-leases/**', (route) => route.fulfill({ json: {
    serverNow: new Date().toISOString(), state: canEdit ? 'ACTIVE' : 'EXPIRED', canEdit,
    expiresAt: canEdit ? new Date(Date.now() + 1_800_000).toISOString() : null,
    ...(canEdit ? { leaseId: 'test-lease', fence: 1 } : {}),
  } }));
  await page.route(`**/api/v1/project-registration-drafts/${draftId}`, (route) => {
    if (route.request().method() === 'PATCH') saves += 1;
    return route.fulfill({ json: { draft: {
      draftId, resourceType: 'project-registration', resourceId: draftId,
      draftRevision: 1, payload: {}, attachmentRefs: [], stepIndex: 0,
    } } });
  });
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await page.goto(`/portal/register-project/${draftId}`);
  const name = page.getByPlaceholder('예: 26농식품AC');
  await expect(name).toBeEnabled();
  await name.fill('파일 없는 최신 입력');
  canEdit = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(name).toBeDisabled();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.includes('project-editor-autosave:'))
    .map((key) => JSON.parse(localStorage.getItem(key) || '{}').draft?.name))).toContain('파일 없는 최신 입력');
  expect(saves).toBe(0);
  page.on('dialog', (dialog) => dialog.accept());
  canEdit = true;
  await page.reload();
  await page.getByRole('button', { name: '임시저장 불러오기', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('내 입력');
  expect(saves).toBe(0);
  await page.getByRole('button', { name: '내 입력으로 계속', exact: true }).click();
  await expect(name).toHaveValue('파일 없는 최신 입력');
  await expect(page.getByText('이 기기에 보관됨', { exact: true })).toBeVisible();
  expect(saves).toBe(0);
});

test('deferred save A keeps newer form and local B, and saves B against returned revision', async ({ page }) => {
  const draftId = 'recovery-deferred-test';
  let releaseFirst!: () => void;
  const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const requests: Array<{ expectedDraftRevision: number; payload: { name: string } }> = [];
  const attachmentRefs = ['contract', 'customer_business_registration', 'quote'].map((documentKind) => ({
    documentKind, path: `server/${documentKind}`, name: `${documentKind}.pdf`, size: 100, contentType: 'application/pdf', uploadedAt: '2026-09-01T00:00:00.000Z',
  }));
  let record = { draftId, resourceType: 'project-registration', resourceId: draftId, draftRevision: 1, payload: {}, attachmentRefs, stepIndex: 0 };
  await page.route('**/api/v1/edit-leases/**', (route) => route.fulfill({ json: {
    serverNow: new Date().toISOString(), state: 'ACTIVE', canEdit: true,
    expiresAt: new Date(Date.now() + 1_800_000).toISOString(), leaseId: 'test-lease', fence: 1,
  } }));
  await page.route(`**/api/v1/project-registration-drafts/${draftId}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      requests.push(body);
      if (requests.length === 1) await firstResponse;
      record = { ...record, draftRevision: record.draftRevision + 1, payload: body.payload };
    }
    await route.fulfill({ json: { draft: record } });
  });
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await page.goto(`/portal/register-project/${draftId}`);
  const name = page.getByPlaceholder('예: 26농식품AC');
  await name.fill('입력 A');
  await expect.poll(() => requests.length).toBe(1);
  await name.fill('입력 B');
  releaseFirst();
  await expect(name).toHaveValue('입력 B');
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.includes('project-editor-autosave:'))
    .map((key) => JSON.parse(localStorage.getItem(key) || '{}').draft?.name))).toContain('입력 B');
  await expect(page.getByText(/^임시저장됨/)).toHaveCount(0);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].payload.name).toBe('입력 B');
  expect(requests[1].expectedDraftRevision).toBe(2);
});

test('submit freezes before prerequisite save, preserves backup on 409, and clears it only on success', async ({ page }) => {
  const draftId = 'recovery-submit-test';
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  let saves = 0;
  let submits = 0;
  const attachmentRefs = ['contract', 'customer_business_registration', 'quote'].map((documentKind) => ({
    documentKind, path: `server/${documentKind}`, name: `${documentKind}.pdf`, size: 100, contentType: 'application/pdf', uploadedAt: '2026-09-01T00:00:00.000Z',
  }));
  const payload = {
    name: '제출 스냅샷', officialContractName: '계약명', clientOrg: '고객사', department: 'CIC1',
    projectPurpose: '목적', description: '내용', type: 'I1', contractStart: '2026-01-01', contractEnd: '', contractEndUndecided: true,
    contractAmount: 0, salesVatAmount: 0, totalRevenueAmount: 0, totalActualCost: 0, supportAmount: 0,
    financialYears: [{ year: 2026, contractAmount: 0, salesVatAmount: 0, totalRevenueAmount: 0, totalActualCost: 0, supportAmount: 0, profitRate: 0, confirmed: true }],
    settlementType: 'TYPE1', managerName: '데이나', executiveApproverId: 'u001', executiveApproverName: '관리자',
    participationSheetLink: 'https://docs.google.com/spreadsheets/d/test',
    registrationConfirmations: { modusignContractUsed: true },
  };
  let record = { draftId, resourceType: 'project-registration', resourceId: draftId, draftRevision: 1, payload, attachmentRefs, stepIndex: 0 };
  await page.route('**/api/v1/edit-leases/**', (route) => route.fulfill({ json: {
    serverNow: new Date().toISOString(), state: 'ACTIVE', canEdit: true,
    expiresAt: new Date(Date.now() + 1_800_000).toISOString(), leaseId: 'test-lease', fence: 1,
  } }));
  await page.route(`**/api/v1/project-registration-drafts/${draftId}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      saves += 1;
      if (saves === 1) await saveGate;
      record = { ...record, draftRevision: record.draftRevision + 1, payload: route.request().postDataJSON().payload };
    }
    await route.fulfill({ json: { draft: record } });
  });
  await page.route(`**/api/v1/project-registration-drafts/${draftId}/submit`, (route) => {
    submits += 1;
    return route.fulfill(submits === 1
      ? { status: 409, json: { error: 'draft_version_conflict', message: '임시저장이 변경되었습니다.' } }
      : { json: { draftId, requestId: 'request-test', projectId: 'project-test', status: 'SUBMITTED' } });
  });
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await page.goto(`/portal/register-project/${draftId}`);
  await page.getByRole('button', { name: '검토 및 저장', exact: true }).click();
  const submit = page.getByRole('button', { name: '최종 저장', exact: true });
  await submit.click();
  await expect.poll(() => saves).toBe(1);
  await expect(page.getByRole('textbox', { name: '임시저장 이름' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '기본 정보', exact: true })).toBeDisabled();
  await submit.dispatchEvent('click');
  expect(saves).toBe(1);
  expect(submits).toBe(0);
  releaseSave();
  await expect(page.getByRole('dialog')).toContainText('내 입력');
  await expect(page.getByPlaceholder('예: 관광벤처 멘토링')).toBeEnabled();
  const backups = () => page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('project-editor-autosave:')));
  await expect.poll(backups).toHaveLength(1);
  await page.getByRole('button', { name: '내 입력으로 계속', exact: true }).click();
  await submit.click();
  await expect(page.getByRole('heading', { name: '프로젝트 등록 요청이 최종 제출되었습니다' })).toBeVisible();
  await expect.poll(backups).toHaveLength(0);
  expect(saves).toBe(2);
  expect(submits).toBe(2);
});
