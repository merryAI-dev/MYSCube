import { expect, test, type Page } from '@playwright/test';

const initialName = '저장 정책 검증';
const payload = {
  name: initialName, officialContractName: '계약명', clientOrg: '고객사', department: 'CIC1',
  projectPurpose: '목적', description: '내용', type: 'I1', contractStart: '2026-01-01', contractEnd: '2026-12-31',
  contractAmount: 35521200, salesVatAmount: 35521200, totalRevenueAmount: 0, totalActualCost: 0, supportAmount: 0,
  financialYears: [{ year: 2026, contractAmount: 35521200, salesVatAmount: 35521200, totalRevenueAmount: 0, totalActualCost: 0, supportAmount: 0, profitRate: 0, confirmed: true }],
  settlementType: 'TYPE1', managerName: '데이나', registeredById: 'u002', executiveApproverId: 'u001', executiveApproverName: '관리자',
  participationSheetLink: 'https://docs.google.com/spreadsheets/d/isolated-test', teamMembersDetailed: [],
  registrationConfirmations: { modusignContractUsed: true },
};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function openDraft(page: Page, options: { fileless?: boolean; firstSaveGate?: Promise<void>; failFirstSubmit?: boolean; rejectSaves?: boolean; edit?: boolean; loseFirstSaveResponse?: boolean; initialPayload?: typeof payload; uploadGate?: Promise<void> } = {}) {
  const draftId = 'isolated-amount-investigation';
  const apiPath = options.edit ? '/api/v1/project-info-drafts/p009' : `/api/v1/project-registration-drafts/${draftId}`;
  let record = {
    draftId, projectId: 'p009', baseCanonicalVersion: 1, resourceType: options.edit ? 'project-info' : 'project-registration', resourceId: options.edit ? 'p009' : draftId, status: 'ACTIVE', draftRevision: 10,
    payload: { ...(options.initialPayload || payload) }, stepIndex: 0,
    attachmentRefs: options.fileless ? [] : ['contract', 'customer_business_registration', 'quote'].map(documentKind => ({
      documentKind, path: `isolated/${documentKind}`, name: `${documentKind}.pdf`, size: 100, contentType: 'application/pdf',
    })),
  };
  const writes: Array<{ expectedDraftRevision: number; payload: typeof payload; stepIndex: number }> = [];
  const submits: Array<{ expectedDraftRevision: number }> = [];
  const releases: string[] = [];
  const uploads: Array<Record<string, unknown>> = [];
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
    if (url.pathname === `${apiPath}/attachments` && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      uploads.push(body);
      if (options.uploadGate) await options.uploadGate;
      const attachment = { documentKind: body.documentKind, path: `isolated/replaced/${body.documentKind}`,
        name: body.fileName, size: body.fileSize, contentType: body.mimeType, attachmentId: 'replacement-file' };
      record = { ...record, draftRevision: record.draftRevision + 1,
        attachmentRefs: [...record.attachmentRefs.filter(item => item.documentKind !== body.documentKind), attachment] };
      return route.fulfill({ json: { draft: record, attachment } });
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
  return { writes, submits, releases, uploads, name, record: () => record, allowSaves: () => { rejectSaves = false; } };
}

async function backups(page: Page) {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.includes('project-editor-autosave:'))
    .map(key => JSON.parse(localStorage.getItem(key) || '{}')));
}


const annualPayload = {
  ...payload, contractStart: '2025-01-01', contractEnd: '2026-12-31',
  contractAmount: 300, salesVatAmount: 30, totalRevenueAmount: 270,
  financialYears: [2025, 2026].map((year, index) => ({
    year, contractAmount: (index + 1) * 100, salesVatAmount: (index + 1) * 10,
    totalRevenueAmount: (index + 1) * 90, totalActualCost: 0, supportAmount: 0, profitRate: 0.9, confirmed: true,
    paymentPlan: { contract: (index + 1) * 100, interim: 0, final: 0 },
    paymentExpectedMonths: { contract: `${year}-06`, interim: '', final: '' },
    advanceInterimBelow70Reason: `${year}년 입력 사유`,
  })),
};

for (const edit of [false, true]) {
  test(`amount input preserves typing and normalizes fullwidth and currency paste ${edit ? 'edit' : 'register'}`, async ({ page }) => {
    const state = await openDraft(page, { edit });
    await page.getByRole('button', { name: /^계약\/재무/ }).click();
    const vat = page.getByRole('textbox', { name: '2026년 매출 부가세', exact: true });
    const revenue = page.getByRole('textbox', { name: '2026년 수익', exact: true });
    const cost = page.getByRole('textbox', { name: '2026년 실비(원가)', exact: true });
    await expect(page.getByText('첨부파일은 파일당 10MB까지 업로드할 수 있습니다.').first()).toBeVisible();
    await expect(vat).toHaveValue('35,521,200');
    await revenue.fill('');
    for (const key of '1234567') {
      await revenue.press(key);
      await expect(revenue).toBeFocused();
    }
    await revenue.blur();
    await expect(revenue).toHaveValue('1,234,567');
    await cost.fill('7654321');
    await cost.blur();
    await expect(cost).toHaveValue('7,654,321');
    await expect.poll(() => state.record().payload.totalRevenueAmount).toBe(1234567);
    await expect.poll(() => state.record().payload.totalActualCost).toBe(7654321);
    await revenue.fill('12,345,678');
    await revenue.blur();
    await expect(revenue).toHaveValue('12,345,678');
    await revenue.fill('１２３４５');
    await revenue.blur();
    await expect(revenue).toHaveValue('12,345');
    await cost.fill('12,345원');
    await cost.blur();
    await expect(cost).toHaveValue('12,345');
    await expect.poll(() => state.record().payload.totalRevenueAmount).toBe(12345);
    await expect.poll(() => state.record().payload.totalActualCost).toBe(12345);
    await revenue.dispatchEvent('compositionstart');
    await revenue.fill('１２３');
    await revenue.dispatchEvent('compositionend', { data: '１２３' });
    await revenue.blur();
    await expect(revenue).toHaveValue('123');
    await expect.poll(() => state.record().payload.totalRevenueAmount).toBe(123);
  });

  test(`invalid amount never saves zero and blocks manual and final saves ${edit ? 'edit' : 'register'}`, async ({ page }) => {
    const state = await openDraft(page, { edit });
    await page.getByRole('button', { name: /^계약\/재무/ }).click();
    const revenue = page.getByRole('textbox', { name: '2026년 수익', exact: true });
    await revenue.fill('9000');
    await revenue.blur();
    await expect.poll(() => state.record().payload.totalRevenueAmount).toBe(9000);
    await expect(page.getByText(/^임시저장됨/)).toBeVisible();
    const savedCount = state.writes.length;
    await revenue.fill('원');
    await revenue.blur();
    await expect(revenue).toHaveValue('원');
    await expect(revenue).toHaveAttribute('aria-invalid', 'true');
    expect(state.record().payload.totalRevenueAmount).toBe(9000);
    await revenue.fill('알수없는금액');
    await revenue.blur();
    await expect(revenue).toHaveValue('알수없는금액');
    await expect(revenue).toHaveAttribute('aria-invalid', 'true');
    await page.waitForTimeout(1_500);
    const save = page.getByRole('button', { name: '임시저장', exact: true });
    if (await save.isEnabled()) await save.click();
    expect(state.writes).toHaveLength(savedCount);
    expect(state.record().payload.totalRevenueAmount).toBe(9000);
    await page.getByRole('button', { name: '검토 및 저장', exact: true }).click();
    const submit = page.getByRole('button', { name: '최종 저장', exact: true });
    if (await submit.isEnabled()) await submit.click();
    expect(state.submits).toHaveLength(0);
    expect(state.writes).toHaveLength(savedCount);
    await page.getByRole('button', { name: /^계약\/재무/ }).click();
    await expect(revenue).toHaveValue('알수없는금액');
    await revenue.fill('12000');
    await revenue.blur();
    await expect.poll(() => state.record().payload.totalRevenueAmount).toBe(12000);
  });
}

test('clearing and restoring contract end preserves all annual financial input', async ({ page }) => {
  const state = await openDraft(page, { initialPayload: annualPayload });
  await page.getByRole('button', { name: /^계약\/재무/ }).click();
  await expect(page.getByRole('textbox', { name: '2025년 계약금액', exact: true })).toHaveValue('100');
  const contractEnd = page.locator('input[type="date"]').nth(1);
  await contractEnd.fill('');
  await expect(page.getByRole('textbox', { name: '2025년 수익', exact: true })).toHaveValue('90');
  await expect(page.getByRole('textbox', { name: '2026년 수익', exact: true })).toHaveValue('180');
  await page.waitForTimeout(1_300);
  expect(state.record().payload.financialYears).toEqual(annualPayload.financialYears.map(row => expect.objectContaining(row)));
  await contractEnd.fill('2026-12-31');
  await expect(page.getByRole('textbox', { name: '2025년 계약금액', exact: true })).toHaveValue('100');
  await expect(page.getByRole('textbox', { name: '2026년 계약금액', exact: true })).toHaveValue('200');
  await expect.poll(() => state.record().payload.contractEnd).toBe('2026-12-31');
  expect(state.record().payload.financialYears).toEqual(annualPayload.financialYears.map(row => expect.objectContaining(row)));
});

test('shortening the contract preserves excluded years and blocks final submission', async ({ page }) => {
  const state = await openDraft(page, { initialPayload: annualPayload });
  await page.getByRole('button', { name: /^계약\/재무/ }).click();
  await page.locator('input[type="date"]').nth(1).fill('2025-12-31');
  await expect(page.getByRole('textbox', { name: '2026년 수익', exact: true })).toHaveValue('180');
  await expect.poll(() => state.record().payload.contractEnd).toBe('2025-12-31');
  expect(state.record().payload.financialYears).toEqual(annualPayload.financialYears.map(row => expect.objectContaining(row)));
  await page.getByRole('button', { name: '검토 및 저장', exact: true }).click();
  const submit = page.getByRole('button', { name: '최종 저장', exact: true });
  if (await submit.isEnabled()) await submit.click();
  expect(state.submits).toHaveLength(0);
  await expect(page.getByText(/2026.*계약|계약.*2026/).first()).toBeVisible();
});

test('a future start with an undecided end keeps the start year available and saved', async ({ page }) => {
  const state = await openDraft(page, { initialPayload: {
    ...payload, contractStart: '2027-01-01', contractEnd: '', contractEndUndecided: true,
    financialYears: [{ ...payload.financialYears[0], year: 2027 }],
  } as typeof payload });
  await state.name.fill('미래 시작 기간 확인');
  await page.getByRole('button', { name: /^계약\/재무/ }).click();
  await expect(page.getByRole('checkbox', { name: '종료 기간 없음', exact: true })).toBeChecked();
  const revenue = page.getByRole('textbox', { name: '2027년 수익', exact: true });
  await expect(revenue).toBeEditable();
  await revenue.fill('456');
  await revenue.blur();
  await expect.poll(() => state.record().payload.financialYears.length).toBe(1);
  await expect.poll(() => state.record().payload.financialYears[0].totalRevenueAmount).toBe(456);
  expect(state.record().payload.financialYears[0].year).toBe(2027);
});

test('excluded years are removed only after explicit confirmation and remaining values survive', async ({ page }) => {
  const state = await openDraft(page, { initialPayload: annualPayload });
  await page.getByRole('button', { name: /^계약\/재무/ }).click();
  await page.locator('input[type="date"]').nth(1).fill('2025-12-31');
  await expect.poll(() => state.record().payload.contractEnd).toBe('2025-12-31');
  await page.getByRole('button', { name: '제외 연도 정리', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('2026');
  await page.getByRole('button', { name: '유지하기', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '2026년 수익', exact: true })).toHaveValue('180');
  expect(state.record().payload.financialYears).toHaveLength(2);
  await page.getByRole('button', { name: '제외 연도 정리', exact: true }).click();
  await page.getByRole('button', { name: '확인 후 제외', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '2026년 수익', exact: true })).toHaveCount(0);
  await expect.poll(() => state.record().payload.financialYears.length).toBe(1);
  expect(state.record().payload.financialYears[0]).toMatchObject(annualPayload.financialYears[0]);
  expect(state.record().payload.contractAmount).toBe(100);
  expect(state.record().payload.salesVatAmount).toBe(10);
  expect(state.record().payload.totalRevenueAmount).toBe(90);
  expect((state.record().payload as Record<string, unknown>).paymentPlan).toEqual({ contract: 100, interim: 0, final: 0 });
  expect((state.record().payload as Record<string, unknown>).paymentExpectedMonths).toEqual({ contract: '2025-06', interim: '', final: '' });
  expect((state.record().payload as Record<string, unknown>).advanceInterimBelow70Reason).toBe('2025년 입력 사유');
  await expect(page.getByRole('textbox', { name: '선금/계약금 금액', exact: true })).toHaveValue('100');
});

test('invalid amount checkpoint survives reload and remains blocked until corrected', async ({ page }) => {
  const state = await openDraft(page);
  await page.getByRole('button', { name: /^계약\/재무/ }).click();
  const revenue = page.getByRole('textbox', { name: '2026년 수익', exact: true });
  await revenue.fill('4321');
  await revenue.blur();
  await expect.poll(() => state.record().payload.totalRevenueAmount).toBe(4321);
  await revenue.fill('잘못된입력');
  await revenue.blur();
  await expect.poll(async () => (await backups(page)).some(item => Object.values(item.amountInputs || {}).includes('잘못된입력'))).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '임시저장 불러오기', exact: true }).click();
  await expect(revenue).toHaveValue('잘못된입력');
  await expect(revenue).toHaveAttribute('aria-invalid', 'true');
  const count = state.writes.length;
  await page.waitForTimeout(1_300);
  expect(state.writes).toHaveLength(count);
  expect(state.record().payload.totalRevenueAmount).toBe(4321);
  await revenue.fill('5678');
  await revenue.blur();
  await expect.poll(() => state.record().payload.totalRevenueAmount).toBe(5678);
});


test('an earlier valid save acknowledgement does not mark a newer invalid amount as saved', async ({ page }) => {
  const firstSave = gate();
  const state = await openDraft(page, { firstSaveGate: firstSave.promise });
  await page.getByRole('button', { name: /^계약\/재무/ }).click();
  const revenue = page.getByRole('textbox', { name: '2026년 수익', exact: true });
  await revenue.fill('9000');
  await revenue.blur();
  await expect.poll(() => state.writes.length).toBe(1);
  await revenue.fill('알수없는금액');
  await revenue.blur();
  firstSave.release();
  await expect.poll(() => state.record().payload.totalRevenueAmount).toBe(9000);
  await expect(revenue).toHaveValue('알수없는금액');
  await expect(revenue).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText(/^임시저장됨/)).toHaveCount(0);
  await page.waitForTimeout(1_300);
  expect(state.writes).toHaveLength(1);
});


test('expanding a single-year contract moves its payment plan only to the original annual row', async ({ page }) => {
  const state = await openDraft(page, { initialPayload: {
    ...annualPayload, contractEnd: '2025-12-31', contractAmount: 100, salesVatAmount: 10, totalRevenueAmount: 90,
    paymentPlan: { contract: 100, interim: 0, final: 0 },
    paymentExpectedMonths: { contract: '2025-06', interim: '', final: '' },
    advanceInterimBelow70Reason: '기존 단년도 사유',
    financialYears: [{ ...annualPayload.financialYears[0], paymentPlan: { contract: 0, interim: 0, final: 0 },
      paymentExpectedMonths: { contract: '', interim: '', final: '' }, advanceInterimBelow70Reason: '' }],
  } as typeof payload });
  await page.getByRole('button', { name: /^계약\/재무/ }).click();
  await expect(page.getByRole('textbox', { name: '선금/계약금 금액', exact: true })).toHaveValue('100');
  await page.locator('input[type="date"]').nth(1).fill('2026-12-31');
  await expect.poll(() => state.record().payload.financialYears.length).toBe(2);
  const rows = state.record().payload.financialYears;
  expect(rows[0]).toMatchObject({ year: 2025, paymentPlan: { contract: 100, interim: 0, final: 0 },
    paymentExpectedMonths: { contract: '2025-06', interim: '', final: '' }, advanceInterimBelow70Reason: '기존 단년도 사유' });
  expect(rows[1]).toMatchObject({ year: 2026, paymentPlan: { contract: 0, interim: 0, final: 0 },
    paymentExpectedMonths: { contract: '', interim: '', final: '' } });
});


test('attachment acknowledgement preserves a newer invalid amount and the user can correct it', async ({ page }) => {
  const upload = gate();
  const state = await openDraft(page, { uploadGate: upload.promise });
  await page.getByRole('button', { name: /^계약\/재무/ }).click();
  await expect.poll(() => state.record().stepIndex).toBe(1);
  await expect(page.getByText(/^임시저장됨/)).toBeVisible();
  const revenue = page.getByRole('textbox', { name: '2026년 수익', exact: true });
  await revenue.fill('첨부중잘못된금액');
  await revenue.blur();
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '산출내역서(견적서) 교체', exact: true }).click();
  await (await choosing).setFiles({
    name: 'replacement-quote.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF'),
  });
  await expect.poll(() => state.uploads.length).toBe(1);
  await expect(revenue).toHaveValue('첨부중잘못된금액');
  upload.release();
  await expect.poll(() => state.record().attachmentRefs.some(item => item.path === 'isolated/replaced/quote')).toBe(true);
  await expect(revenue).toHaveValue('첨부중잘못된금액');
  await expect(revenue).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: '임시저장 불러오기', exact: true })).toHaveCount(0);
  await revenue.scrollIntoViewIfNeeded();
  const screenshotPath = test.info().outputPath('attachment-ack-invalid-amount-preserved.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await test.info().attach('attachment ACK preserves invalid amount', { path: screenshotPath, contentType: 'image/png' });
  await revenue.fill('7000');
  await revenue.blur();
  await expect.poll(() => state.record().payload.totalRevenueAmount).toBe(7000);
  expect(state.record().attachmentRefs.some(item => item.path === 'isolated/replaced/quote')).toBe(true);
});
