import { expect, test, type Page } from '@playwright/test';

const initialName = '저장 정책 검증';
const payload = {
  name: initialName, officialContractName: '계약명', clientOrg: '고객사', department: 'CIC1',
  projectPurpose: '목적', description: '내용', type: 'I1', contractStart: '2026-01-01', contractEnd: '2026-12-31',
  contractAmount: 0, salesVatAmount: 0, totalRevenueAmount: 0, totalActualCost: 0, supportAmount: 0,
  financialYears: [{ year: 2026, contractAmount: 0, salesVatAmount: 0, totalRevenueAmount: 0, totalActualCost: 0, supportAmount: 0, profitRate: 0, confirmed: true }],
  settlementType: 'TYPE1', managerName: '데이나', registeredById: 'u002', executiveApproverId: 'u001', executiveApproverName: '관리자',
  participationSheetLink: 'https://docs.google.com/spreadsheets/d/isolated-test', teamMembersDetailed: [],
  registrationConfirmations: { modusignContractUsed: true },
};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function openDraft(page: Page, options: { fileless?: boolean; firstSaveGate?: Promise<void>; failFirstSubmit?: boolean; rejectSaves?: boolean; edit?: boolean; loseFirstSaveResponse?: boolean } = {}) {
  const draftId = 'isolated-save-policy';
  const apiPath = options.edit ? '/api/v1/project-info-drafts/p009' : `/api/v1/project-registration-drafts/${draftId}`;
  let record = {
    draftId, projectId: 'p009', baseCanonicalVersion: 1, resourceType: options.edit ? 'project-info' : 'project-registration', resourceId: options.edit ? 'p009' : draftId, status: 'ACTIVE', draftRevision: 10,
    payload: { ...payload }, stepIndex: 0,
    attachmentRefs: options.fileless ? [] : ['contract', 'customer_business_registration', 'quote'].map(documentKind => ({
      documentKind, path: `isolated/${documentKind}`, name: `${documentKind}.pdf`, size: 100, contentType: 'application/pdf',
    })),
  };
  const writes: Array<{ expectedDraftRevision: number; payload: typeof payload; stepIndex: number }> = [];
  const submits: Array<{ expectedDraftRevision: number }> = [];
  const releases: string[] = [];
  let rejectSaves = Boolean(options.rejectSaves);
  let lostResponseKey = '';
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/edit-leases/')) {
      if (url.pathname.endsWith('/release')) releases.push(url.pathname);
      return route.fulfill({ json: { serverNow: new Date().toISOString(), state: 'ACTIVE', canEdit: true,
        expiresAt: new Date(Date.now() + 1_800_000).toISOString(), leaseId: 'isolated-lease', fence: 1 } });
    }
    if (url.pathname === apiPath || url.pathname === `${apiPath}/open`) {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON();
        writes.push(body);
        const requestKey = route.request().headers()['idempotency-key'];
        if (lostResponseKey && requestKey === lostResponseKey) return route.abort('failed');
        if (rejectSaves) return route.fulfill({ status: 422, json: { error: 'draft_payload_invalid', message: '격리된 저장 실패' } });
        if (writes.length === 1 && options.firstSaveGate) await options.firstSaveGate;
        if (body.expectedDraftRevision !== record.draftRevision) return route.fulfill({ status: 409, json: { error: 'draft_version_conflict', message: '임시저장이 변경되었습니다.' } });
        record = { ...record, draftRevision: record.draftRevision + 1, payload: body.payload, stepIndex: body.stepIndex };
        if (options.loseFirstSaveResponse && !lostResponseKey) {
          lostResponseKey = requestKey;
          return route.abort('failed');
        }
      }
      return route.fulfill({ json: { draft: record } });
    }
    if (url.pathname === `${apiPath}/submit`) {
      submits.push(route.request().postDataJSON());
      return route.fulfill(options.failFirstSubmit && submits.length === 1
        ? { status: 409, json: { error: 'draft_version_conflict', message: '임시저장이 변경되었습니다.' } }
        : { json: { status: 'SUBMITTED', projectId: 'isolated-project', draftId } });
    }
    if (url.pathname.endsWith('/sheet-preview')) return route.fulfill({ json: {
      ok: true, months: ['2026-01'], warnings: [], blocking: [], rows: [],
      summary: { period: { start: '2026-01', end: '2026-12' }, pendingLinkCount: 0 },
    } });
    if (url.pathname.endsWith('/latest-request')) return route.fulfill({ json: { item: null } });
    return route.fulfill({ status: 200, json: {} });
  });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await expect(page).toHaveURL(/\/portal\/project-select/);
  await page.goto(options.edit ? '/portal/edit-project/p009' : `/portal/register-project/${draftId}`);
  const name = page.getByPlaceholder('예: 26농식품AC');
  await expect(name).toHaveValue(initialName);
  await expect(name).toBeEnabled();
  return { writes, submits, releases, name, record: () => record, allowSaves: () => { rejectSaves = false; } };
}

async function backups(page: Page) {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.includes('project-editor-autosave:'))
    .map(key => JSON.parse(localStorage.getItem(key) || '{}')));
}

test('fileless draft persists, reloads, and does not write again during 30 seconds idle', async ({ page }) => {
  const state = await openDraft(page, { fileless: true });
  await state.name.fill('첨부 없는 최신 입력');
  await expect.poll(() => state.record().payload.name).toBe('첨부 없는 최신 입력');
  expect(state.record().attachmentRefs).toHaveLength(0);
  await page.reload();
  await expect(state.name).toHaveValue('첨부 없는 최신 입력');
  await expect(state.name).toBeEnabled();
  await test.info().attach('saved-draft-reload-state.json', { body: JSON.stringify({ server: state.record(), backups: await backups(page) }, null, 2), contentType: 'application/json' });
  await expect(page.getByRole('button', { name: '임시저장 불러오기', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^계약\/재무/ }).click();
  await expect.poll(() => state.record().stepIndex).toBe(1);
  await expect(page.getByText(/^임시저장됨/)).toBeVisible();
  const count = state.writes.length;
  const revision = state.record().draftRevision;
  await page.waitForTimeout(30_000);
  expect(state.writes).toHaveLength(count);
  expect(state.record().draftRevision).toBe(revision);
});

test('returning A to its original value after saved B persists the reversion', async ({ page }) => {
  const state = await openDraft(page);
  await state.name.fill('입력 B');
  await expect.poll(() => state.record().payload.name).toBe('입력 B');
  await state.name.fill(initialName);
  await expect.poll(() => state.record().payload.name).toBe(initialName);
  await page.reload();
  await expect(state.name).toHaveValue(initialName);
});

test('project edit stays idle after successful save on a later wizard step', async ({ page }) => {
  const state = await openDraft(page, { edit: true });
  await state.name.fill('수정 화면 자동저장 확인');
  await expect.poll(() => state.record().payload.name).toBe('수정 화면 자동저장 확인');
  await page.getByRole('button', { name: /^계약\/재무/ }).click();
  await expect.poll(() => state.record().stepIndex).toBe(1);
  await expect(page.getByText(/^임시저장됨/)).toBeVisible();
  const writes = state.writes.length;
  const revision = state.record().draftRevision;
  await page.waitForTimeout(30_000);
  expect(state.writes).toHaveLength(writes);
  expect(state.record().draftRevision).toBe(revision);
});

test('failed save retains local input across reload until explicit restore and successful retry', async ({ page }) => {
  const state = await openDraft(page, { fileless: true, rejectSaves: true });
  await state.name.fill('실패해도 보존할 입력');
  await expect.poll(() => state.writes.length).toBe(1);
  await expect.poll(async () => (await backups(page)).map(item => item.draft.name)).toContain('실패해도 보존할 입력');
  await page.reload();
  await expect(state.name).toHaveValue(initialName);
  const restore = page.getByRole('button', { name: '임시저장 불러오기', exact: true });
  await expect(restore).toBeEnabled();
  await page.getByRole('button', { name: '임시저장', exact: true }).click();
  expect(state.writes).toHaveLength(1);
  await expect.poll(async () => (await backups(page)).map(item => item.draft.name)).toContain('실패해도 보존할 입력');
  state.allowSaves();
  await restore.click();
  await expect(state.name).toHaveValue('실패해도 보존할 입력');
  await expect.poll(() => state.record().payload.name).toBe('실패해도 보존할 입력');
});

test('delayed save A keeps newer B in the form and backup and saves against the returned revision', async ({ page }) => {
  const firstSave = gate();
  const state = await openDraft(page, { firstSaveGate: firstSave.promise });
  await state.name.fill('입력 A');
  await expect.poll(() => state.writes.length).toBe(1);
  await state.name.fill('입력 B');
  await expect.poll(async () => (await backups(page)).map(item => item.draft.name)).toContain('입력 B');
  firstSave.release();
  await expect(state.name).toHaveValue('입력 B');
  await expect.poll(() => state.record().payload.name).toBe('입력 B');
  expect(state.writes[1].expectedDraftRevision).toBe(11);
  expect(state.record().attachmentRefs.map(item => item.path)).toEqual(['isolated/contract', 'isolated/customer_business_registration', 'isolated/quote']);
});

test('a committed save with lost responses preserves newer input through revision conflict and reload', async ({ page }) => {
  const state = await openDraft(page, { fileless: true, loseFirstSaveResponse: true });
  await state.name.fill('응답 유실 전 입력');
  await expect.poll(() => state.record().payload.name).toBe('응답 유실 전 입력');
  await expect(page.getByText('임시저장 실패', { exact: true })).toBeVisible();
  await state.name.fill('충돌해도 보존할 최신 입력');
  await expect.poll(async () => (await backups(page)).map(item => item.draft.name)).toContain('충돌해도 보존할 최신 입력');
  await expect.poll(() => state.writes.some(write => write.payload.name === '충돌해도 보존할 최신 입력')).toBe(true);
  expect(state.record().payload.name).toBe('응답 유실 전 입력');
  await page.reload();
  await expect(state.name).toHaveValue('응답 유실 전 입력');
  await page.getByRole('button', { name: '임시저장 불러오기', exact: true }).click();
  await expect(state.name).toHaveValue('충돌해도 보존할 최신 입력');
  await expect.poll(() => state.record().payload.name).toBe('충돌해도 보존할 최신 입력');
  expect(state.writes.at(-1)?.expectedDraftRevision).toBe(11);
});

test('submit freezes prerequisite saving, retains backup on failure, then clears only after success', async ({ page }) => {
  const firstSave = gate();
  const state = await openDraft(page, { firstSaveGate: firstSave.promise, failFirstSubmit: true });
  await page.getByRole('button', { name: '검토 및 저장', exact: true }).click();
  const submit = page.getByRole('button', { name: '최종 저장', exact: true });
  await submit.click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(submit).toBeDisabled();
  await page.getByRole('button', { name: '나가기', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.releases).toHaveLength(0);
  expect(state.submits).toHaveLength(0);
  firstSave.release();
  await expect.poll(() => state.submits.length).toBe(1);
  await expect(submit).toBeEnabled();
  await expect.poll(async () => (await backups(page)).length).toBe(1);
  expect(state.releases).toHaveLength(0);
  await submit.click();
  await expect(page.getByRole('heading', { name: '프로젝트 등록 요청이 최종 제출되었습니다' })).toBeVisible();
  await expect.poll(async () => (await backups(page)).length).toBe(0);
  expect(state.submits).toHaveLength(2);
});
