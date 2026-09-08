import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const documents = JSON.parse(readFileSync(new URL('../../policies/project-documents.json', import.meta.url), 'utf8')) as Record<string, { field: string }>;

test('private draft GET to editor save preserves all twelve selected document fields', async ({ page }) => {
  const attachmentRefs = Object.keys(documents).map(documentKind => ({ documentKind, path: `selected/${documentKind}`, name: `${documentKind}.pdf`, size: 100, contentType: 'application/pdf' }));
  let record = { projectId: 'p009', resourceId: 'p009', resourceType: 'project-info', status: 'ACTIVE', baseCanonicalVersion: 1, draftRevision: 1, payload: { name: '열두 문서 확인' }, attachmentRefs, stepIndex: 0 };
  let saved: Record<string, any> | undefined;
  await page.route('**/api/v1/projects/p009/latest-request', route => route.fulfill({ json: { item: null } }));
  await page.route('**/api/v1/edit-leases/**', route => route.fulfill({ json: { serverNow: new Date().toISOString(), state: 'ACTIVE', canEdit: true, expiresAt: new Date(Date.now() + 1_800_000).toISOString(), leaseId: 'test-lease', fence: 1 } }));
  await page.route('**/api/v1/project-info-drafts/p009/open', route => route.fulfill({ json: { draft: record } }));
  await page.route('**/api/v1/project-info-drafts/p009', route => {
    if (route.request().method() === 'PATCH') {
      saved = route.request().postDataJSON().payload;
      record = { ...record, draftRevision: record.draftRevision + 1, payload: saved as typeof record.payload };
    }
    return route.fulfill({ json: { draft: record } });
  });
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await page.goto('/portal/edit-project/p009');
  await expect(page.getByPlaceholder('예: 26농식품AC')).toHaveValue('열두 문서 확인');
  await page.getByRole('button', { name: '임시저장', exact: true }).click();
  await expect.poll(() => saved !== undefined).toBe(true);
  for (const [kind, { field }] of Object.entries(documents)) expect(saved?.[field]?.path, field).toBe(`selected/${kind}`);
});

for (const scenario of ['stale-apply', 'stale-submit', 'malformed-apply']) {
  test(`rebase choice protocol preserves files and requires fresh confirmation: ${scenario}`, async ({ page }) => {
    const file = (name: string) => ({ documentKind: 'contract', path: `server/${name}.pdf`, name: `${name}.pdf`, size: 100, contentType: 'application/pdf' });
    const payload = {
      name: '비교 후 제출', officialContractName: '계약명', clientOrg: '고객사', department: 'CIC1',
      projectPurpose: '목적', description: '내용', type: 'I1', contractStart: '2026-01-01', contractEnd: '', contractEndUndecided: true,
      contractAmount: 0, salesVatAmount: 0, totalRevenueAmount: 0, totalActualCost: 0, supportAmount: 0,
      financialYears: [{ year: 2026, contractAmount: 0, salesVatAmount: 0, totalRevenueAmount: 0, totalActualCost: 0, supportAmount: 0, profitRate: 0, confirmed: true }],
      settlementType: 'TYPE1', managerName: '데이나', executiveApproverId: 'u001', executiveApproverName: '관리자',
      participationSheetLink: 'https://docs.google.com/spreadsheets/d/test', registrationConfirmations: { modusignContractUsed: true },
      contractDocument: file('A'),
    };
    let record = { projectId: 'p009', resourceType: 'project-info', resourceId: 'p009', status: 'ACTIVE', baseCanonicalVersion: 1, draftRevision: 1, payload, attachmentRefs: [file('A'), ...['customer_business_registration', 'quote'].map(kind => ({ ...file(kind), documentKind: kind }))], stepIndex: 0 };
    let previews = 0;
    const applies: any[] = [];
    const submits: any[] = [];
    await page.route('**/api/v1/projects/p009/latest-request', route => route.fulfill({ json: { item: null } }));
    await page.route('**/api/v1/edit-leases/**', route => route.fulfill({ json: { serverNow: new Date().toISOString(), state: 'ACTIVE', canEdit: true, expiresAt: new Date(Date.now() + 1_800_000).toISOString(), leaseId: 'test-lease', fence: 1 } }));
    await page.route('**/api/v1/project-info-drafts/p009/open', route => route.fulfill({ json: { draft: record } }));
    await page.route('**/api/v1/project-info-drafts/p009', route => {
      if (route.request().method() === 'PATCH') record = { ...record, draftRevision: record.draftRevision + 1, payload: route.request().postDataJSON().payload };
      return route.fulfill({ json: { draft: record } });
    });
    await page.route('**/api/v1/project-info-drafts/p009/submit', route => {
      submits.push(route.request().postDataJSON());
      if (submits.length === 1 || (scenario === 'stale-submit' && submits.length === 2)) return route.fulfill({ status: 409, json: { error: 'draft_source_conflict', message: '다시 비교해 주세요.' } });
      return route.fulfill({ json: { status: 'SUBMITTED', projectId: 'p009', projectRequestId: 'change-p009', projectVersion: 1, draftRevision: record.draftRevision + 1 } });
    });
    await page.route('**/api/v1/project-info-drafts/p009/rebase', route => {
      const body = route.request().postDataJSON();
      if (!body.resolutions) {
        previews += 1;
        return route.fulfill({ json: { rebased: false, sourceFingerprint: (previews === 1 ? 'b' : 'c').repeat(64), canonicalVersion: 1, autoMerged: [], conflicts: [{ field: 'contractDocument', base: null, mine: record.payload.contractDocument, theirs: file(previews === 1 ? 'B' : 'C') }] } });
      }
      applies.push(body);
      if (scenario === 'stale-apply' && applies.length === 1) return route.fulfill({ status: 409, json: { error: 'draft_source_conflict', message: '다시 비교해 주세요.' } });
      if (scenario === 'malformed-apply') return route.fulfill({ json: { rebased: false, sourceFingerprint: 'b'.repeat(64), canonicalVersion: 1, autoMerged: [], conflicts: [] } });
      const selected = file(previews === 1 ? 'B' : 'C');
      record = { ...record, draftRevision: record.draftRevision + 1, payload: { ...record.payload, contractDocument: selected }, attachmentRefs: [selected, ...record.attachmentRefs.slice(1)] };
      return route.fulfill({ json: { rebased: true, sourceFingerprint: (previews === 1 ? 'b' : 'c').repeat(64), canonicalVersion: 1, autoMerged: [], conflicts: [], draft: record } });
    });
    await page.goto('/login');
    await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
    await page.goto('/portal/edit-project/p009');
    await expect(page.getByPlaceholder('예: 26농식품AC')).toHaveValue('비교 후 제출');
    await page.getByRole('button', { name: '검토 및 저장', exact: true }).click();
    await page.getByRole('button', { name: '최종 저장', exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: '수정하는 동안 프로젝트가 변경되었습니다' });
    await expect(dialog).toContainText('B.pdf');
    await dialog.getByRole('radio').nth(1).click();
    await dialog.getByRole('button', { name: '선택한 내용으로 계속', exact: true }).click();
    if (scenario === 'malformed-apply') {
      await expect(page.getByText('Invalid project information rebase response', { exact: true })).toBeVisible();
      expect(submits).toHaveLength(1);
      expect(record.payload.contractDocument.name).toBe('A.pdf');
      await expect(dialog).toBeVisible();
      return;
    }
    await expect(dialog).toContainText('C.pdf');
    await expect(dialog.getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '1건 선택 필요' })).toBeDisabled();
    expect(applies).toHaveLength(1);
    expect(submits).toHaveLength(scenario === 'stale-submit' ? 2 : 1);
    await dialog.getByRole('radio').nth(1).click();
    await page.screenshot({ path: `test-results/rebase-${scenario}-fresh-choice.png` });
    await dialog.getByRole('button', { name: '선택한 내용으로 계속', exact: true }).click();
    await expect.poll(() => submits.length).toBe(scenario === 'stale-submit' ? 3 : 2);
    expect(applies[0].sourceFingerprint).toBe('b'.repeat(64));
    expect(applies[1].sourceFingerprint).toBe('c'.repeat(64));
    expect(submits.at(-1).expectedDraftRevision).toBe(record.draftRevision);
    expect(record.payload.contractDocument.name).toBe('C.pdf');
    expect(record.attachmentRefs[0].name).toBe('C.pdf');
  });
}

test('request lookup clears a prior approval intention before authority is restored', async ({ page }) => {
  let calls = 0;
  let release!: () => void;
  const refresh = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/project-requests/assigned-to-me', async (route) => {
    calls += 1;
    if (calls === 2) await refresh;
    await route.fulfill({ json: { items: [{ id: 'review', requestKind: 'CHANGE', targetProjectId: 'p009', status: 'PENDING', proposedSnapshot: { name: '재확인할 요청', executiveApproverId: 'u002' } }], projects: [{ id: 'p009', name: '원장', status: 'IN_PROGRESS' }] } });
  });
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await page.goto('/portal/project-approvals');
  await page.getByRole('button', { name: '문서 열기', exact: true }).click();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  const confirm = page.getByRole('button', { name: '승인 저장', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.evaluate((element) => {
    let fiber = (element as any)[Object.keys(element).find((key) => key.startsWith('__reactFiber$'))!];
    while (fiber && fiber.type?.name !== 'AuthProvider') fiber = fiber.return;
    if (!fiber) throw new Error('AuthProvider missing');
    fiber.memoizedState.queue.dispatch((user: any) => ({ ...user, idToken: 'review-token-rotation' }));
  });
  await expect.poll(() => calls).toBe(2);
  await expect(confirm).toHaveCount(0);
  const response = page.waitForResponse('**/api/v1/project-requests/assigned-to-me');
  release();
  await response;
  await expect(page.getByTestId('migration-review-document')).toBeVisible();
  await expect(confirm).toHaveCount(0);
});

test('late request from the prior project cannot replace the current project source', async ({ page }) => {
  let requested = false;
  let releaseOld!: () => void;
  const oldResponse = new Promise<void>((resolve) => { releaseOld = resolve; });
  await page.route('**/api/v1/projects/p009/latest-request', async (route) => {
    requested = true;
    await oldResponse;
    await route.fulfill({ json: { item: { id: 'old', requestKind: 'CHANGE', status: 'PENDING', proposedSnapshot: { name: '이전 프로젝트 요청' } } } });
  });
  await page.route('**/api/v1/projects/p001/latest-request', (route) => route.fulfill({ json: { item: { id: 'new', requestKind: 'CHANGE', status: 'PENDING', proposedSnapshot: { name: '현재 프로젝트 요청' } } } }));
  await page.route('**/api/v1/edit-leases/**', (route) => route.fulfill({ json: { serverNow: new Date().toISOString(), state: 'AVAILABLE', canEdit: false } }));
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem('mysc-dev-auth-harness')!);
    localStorage.setItem('mysc-dev-auth-harness', JSON.stringify({ ...session, projectIds: ['p009', 'p001'] }));
  });
  await page.goto('/portal/edit-project/p009');
  await expect.poll(() => requested).toBe(true);
  await expect(page.getByRole('button', { name: '수정 시작', exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    history.pushState({ ...history.state, idx: history.state.idx + 1 }, '', '/portal/edit-project/p001');
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  });
  await expect(page.getByPlaceholder('예: 26농식품AC')).toHaveValue('현재 프로젝트 요청');
  releaseOld();
  await expect(page.getByPlaceholder('예: 26농식품AC')).toHaveValue('현재 프로젝트 요청');
  await expect(page.getByText('이전 프로젝트 요청', { exact: true })).toHaveCount(0);
});

test('all twelve submitted originals preview through the request before project completion', async ({ page }) => {
  const downloads: string[] = [];
  const fixtureFor = (kind: string) => kind === 'proposal_word_original'
    ? { path: 'server/bff/fixtures/project-registration-attachment.docx', extension: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    : kind === 'proposal_ppt_original' || kind === 'presentation_ppt_original'
      ? { path: 'server/bff/fixtures/mola-project-attachment.pptx', extension: 'pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
      : { path: 'server/bff/fixtures/project-registration-attachment.pdf', extension: 'pdf', contentType: 'application/pdf' };
  const payload = Object.fromEntries(Object.entries(documents).map(([kind, { field }]) => {
    const fixture = fixtureFor(kind);
    return [field, { path: `requests/${kind}.${fixture.extension}`, name: `${kind}.${fixture.extension}`, contentType: fixture.contentType }];
  }));
  await page.route('**/api/v1/project-requests/assigned-to-me', (route) => route.fulfill({ json: {
    items: [{ id: 'request-p009', approvedProjectId: 'p009', requestKind: 'CHANGE', status: 'PENDING', payload: {}, proposedSnapshot: { ...payload, name: '제출 원문 12종', executiveApproverId: 'u002' } }],
    projects: [{ id: 'p009', name: '확정 원장', status: 'IN_PROGRESS', executiveReviewStatus: 'APPROVED' }],
  } }));
  await page.route('**/api/v1/project-requests/request-p009/attachments/*', (route) => {
    const kind = route.request().url().split('/').at(-1)!;
    downloads.push(kind);
    const fixture = fixtureFor(kind);
    return route.fulfill({ path: fixture.path, contentType: fixture.contentType, headers: { 'content-disposition': `attachment; filename="${kind}.${fixture.extension}"` } });
  });
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await page.goto('/portal/project-approvals');
  await page.getByRole('button', { name: '문서 열기', exact: true }).click();
  await expect(page.getByTestId('organization-head-approval-pending')).toBeVisible();
  for (const kind of Object.keys(documents)) {
    const slot = page.locator('[data-testid^="migration-review-document-slot-"]').filter({ has: page.locator(`[data-document-kind="${kind}"]`) });
    await slot.getByRole('button', { name: '원문 보기', exact: true }).click();
    await expect.poll(() => downloads.includes(kind)).toBe(true);
    const preview = page.getByTestId('contract-document-preview');
    const fixture = fixtureFor(kind);
    if (fixture.extension === 'pdf') {
      await expect(preview.locator('iframe')).toHaveAttribute('src', /^blob:/);
    } else {
      const link = preview.getByRole('link', { name: '새 탭', exact: true });
      await expect(link).toHaveAttribute('href', /^blob:/);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(preview.locator('iframe')).toHaveCount(0);
      await expect(preview).toContainText(`${kind}.${fixture.extension}`);
      const actual = await link.evaluate(async (element) => {
        const blob = await (await fetch((element as HTMLAnchorElement).href)).blob();
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        return { contentType: blob.type, digest: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') };
      });
      expect(actual).toEqual({ contentType: fixture.contentType, digest: createHash('sha256').update(readFileSync(fixture.path)).digest('hex') });
    }
  }
  expect(new Set(downloads).size).toBe(12);
});

test('token refresh failure preserves unsaved input and blocks writes until retry succeeds', async ({ page }) => {
  let lookups = 0;
  let opens = 0;
  const saves: string[] = [];
  let record = { projectId: 'p009', resourceId: 'p009', resourceType: 'project-info', baseCanonicalVersion: 1, draftRevision: 1, payload: { name: '서버 입력' }, attachmentRefs: [], stepIndex: 0 };
  await page.route('**/api/v1/projects/p009/latest-request', (route) => {
    lookups += 1;
    return route.fulfill({ json: lookups === 2 ? {} : { item: null } });
  });
  await page.route('**/api/v1/edit-leases/**', (route) => route.fulfill({ json: { serverNow: new Date().toISOString(), state: 'ACTIVE', canEdit: true, expiresAt: new Date(Date.now() + 1_800_000).toISOString(), leaseId: 'test-lease', fence: 1 } }));
  await page.route('**/api/v1/project-info-drafts/p009/open', (route) => { opens += 1; return route.fulfill({ json: { draft: record } }); });
  await page.route('**/api/v1/project-info-drafts/p009', (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      saves.push(body.payload.name);
      record = { ...record, payload: body.payload, draftRevision: record.draftRevision + 1 };
    }
    return route.fulfill({ json: { draft: record } });
  });
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await page.goto('/portal/edit-project/p009');
  const input = page.getByPlaceholder('예: 26농식품AC');
  await expect(input).toBeEditable();
  await input.fill('토큰 갱신 중 보존할 내 입력');
  // Drive the same AuthProvider state update as Firebase's onIdTokenChanged callback.
  await input.evaluate((element) => {
    let fiber = (element as any)[Object.keys(element).find((key) => key.startsWith('__reactFiber$'))!];
    while (fiber && fiber.type?.name !== 'AuthProvider') fiber = fiber.return;
    if (!fiber) throw new Error('AuthProvider missing');
    fiber.memoizedState.queue.dispatch((user: any) => ({ ...user, idToken: 'rotated-test-token' }));
  });
  await expect(page.getByRole('button', { name: '접수 이력 다시 확인', exact: true })).toBeVisible();
  await expect(input).toHaveValue('토큰 갱신 중 보존할 내 입력');
  await expect(input).not.toBeEditable();
  expect(opens).toBe(1);
  expect(saves).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mysc:project-editor-autosave:portal-edit-mysc-p009-u002')!).draft.name)).toBe('토큰 갱신 중 보존할 내 입력');
  await page.getByRole('button', { name: '접수 이력 다시 확인', exact: true }).click();
  await expect(input).toBeEditable();
  await expect(input).toHaveValue('토큰 갱신 중 보존할 내 입력');
  await expect.poll(() => saves).toEqual(['토큰 갱신 중 보존할 내 입력']);
  expect(opens).toBe(1);
});

test('review inbox error cannot become a legacy project review and retry restores authority', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/v1/project-requests/assigned-to-me', (route) => {
    calls += 1;
    return route.fulfill({ json: calls === 1 ? {} : {
      items: [{ id: 'request-p009', approvedProjectId: 'p009', requestKind: 'CHANGE', status: 'PENDING', attachmentReviewStatus: 'REPAIR_REQUIRED', payload: {}, proposedSnapshot: { name: '첨부 복구 필요 요청', executiveApproverId: 'u002' } }],
      projects: [{ id: 'p009', name: '확정 원장', status: 'IN_PROGRESS', executiveReviewStatus: 'REVISION_REJECTED' }],
    } });
  });
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await page.goto('/portal/project-approvals');
  await expect(page.getByText('PM 등록 프로젝트와 접수 이력을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '문서 열기', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '접수 이력 다시 확인', exact: true }).click();
  await page.getByRole('button', { name: '문서 열기', exact: true }).click();
  await expect(page.getByTestId('migration-review-document')).toContainText('첨부 복구 필요 요청');
  await expect(page.getByRole('button', { name: '승인', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '반려', exact: true })).toBeEnabled();
});

test('request authority failure blocks editing and retry opens the submitted source', async ({ page }) => {
  let calls = 0;
  let opens = 0;
  await page.route('**/api/v1/projects/p009/latest-request', (route) => {
    calls += 1;
    return route.fulfill({ json: calls === 1 ? {} : { item: { id: 'change-p009', requestKind: 'CHANGE', status: 'REJECTED', payload: {}, proposedSnapshot: { name: '제출 원문의 프로젝트', contractDocument: null } } } });
  });
  await page.route('**/api/v1/edit-leases/**', (route) => route.fulfill({ json: { serverNow: new Date().toISOString(), state: 'AVAILABLE', canEdit: false } }));
  await page.route('**/api/v1/project-info-drafts/**', (route) => { opens += 1; return route.fulfill({ json: {} }); });
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await page.goto('/portal/edit-project/p009');
  await expect(page.getByText('프로젝트 접수 이력을 확인하지 못했습니다. 다시 시도해 주세요.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '수정 시작', exact: true })).toHaveCount(0);
  expect(opens).toBe(0);
  await page.getByRole('button', { name: '접수 이력 다시 확인', exact: true }).click();
  await expect(page.getByPlaceholder('예: 26농식품AC')).toHaveValue('제출 원문의 프로젝트');
  await expect(page.getByRole('button', { name: '수정 시작', exact: true })).toBeEnabled();
});

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
  await page.route('**/api/v1/projects/p009/latest-request', (route) => route.fulfill({ json: { item: null } }));
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
