import { test, expect } from '@playwright/test';

test('personal page persists versions and restores; cashflow failed read is explicit', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: '관리자 샘플 로그인' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await page.goto('/work-pages');
  await expect(page.getByRole('heading', { name: '내 업무 페이지', exact: true })).toBeVisible();
  await expect(page.getByText('목록을 불러오고 있습니다.')).toHaveCount(0);
  const title = `QA 개인 페이지 ${Date.now()}`;
  await page.getByLabel('제목', { exact: true }).fill(title);
  await page.getByRole('button', { name: '현재 구성 저장' }).click();
  await expect(page.getByRole('status')).toContainText('페이지를 저장했습니다. 버전 1');
  await page.reload();
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByLabel('제목', { exact: true })).toHaveValue(title);
  await page.getByLabel('제목', { exact: true }).fill(`${title} 수정`);
  await page.getByRole('button', { name: '현재 구성 저장' }).click();
  await expect(page.getByRole('status')).toContainText('페이지를 저장했습니다. 버전 2');
  await page.getByRole('button', { name: '저장 이력' }).click();
  await page.getByRole('button', { name: '이 구성 복원' }).last().click();
  await expect(page.getByRole('status')).toContainText('새 버전 3으로 복원');
  await expect(page.getByLabel('제목', { exact: true })).toHaveValue(title);
  await page.getByRole('button', { name: '미리보기' }).click();
  await page.getByRole('button', { name: '현재 자료 조회' }).click();
  await expect(page.getByText('QA 격리 사업', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '조회 실패', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '확인되지 않음', exact: true })).toHaveCount(3);
  await page.getByText('QA 격리 사업 — 조회 근거', { exact: true }).click();
  await expect(page.getByText('시트 연결·반영 근거를 확인하지 못했습니다. 사람이 연결 상태를 확인해야 합니다.')).toBeVisible();
  await page.screenshot({ path: '/tmp/myscube-workbench-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => { const box = await page.locator('aside').first().boundingBox(); return box ? Math.round(box.x + box.width) : 0; }).toBeLessThanOrEqual(0);
  await page.screenshot({ path: '/tmp/myscube-workbench-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('admin publishes selected guidance fields and member sees them', async ({ page, browser }) => {
  const publicTitle = `QA 저장 지연 안내 ${Date.now()}`;
  await page.goto('/login');
  await page.getByRole('button', { name: '관리자 샘플 로그인' }).click();
  await page.goto('/axr/product-operations');
  await page.getByRole('button', { name: '사건 등록' }).click();
  await page.getByLabel('사건 제목', { exact: true }).fill('QA 비공개 내부 제목');
  await page.getByLabel('확인한 원인', { exact: true }).fill('QA 내부 근거는 공개하지 않음');
  await page.getByLabel('내용을 검토했고 구성원에게 공개합니다').check();
  await page.getByLabel('안내 제목', { exact: true }).fill(publicTitle);
  await page.getByLabel('현재 상황', { exact: true }).fill('저장 응답을 확인하고 있습니다.');
  await page.getByLabel('구성원이 할 일', { exact: true }).fill('입력 화면을 유지해 주세요.');
  await page.getByRole('button', { name: '사건 저장', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '사건을 저장했습니다.' })).toContainText('버전 1');
  await expect(page.getByText('운영 기록을 불러오고 있습니다.')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/myscube-operations-admin.png', fullPage: true });
  const memberContext = await browser.newContext({ baseURL: 'http://localhost:4173' });
  const memberPage = await memberContext.newPage();
  await memberPage.goto('/login');
  await memberPage.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await memberPage.goto('/portal/service-guidance');
  await expect(memberPage.getByText(publicTitle)).toBeVisible();
  await expect(memberPage.locator('article').filter({ hasText: publicTitle }).getByText('입력 화면을 유지해 주세요.', { exact: false })).toBeVisible();
  await expect(memberPage.getByText('QA 내부 근거는 공개하지 않음')).toHaveCount(0);
  await memberPage.screenshot({ path: '/tmp/myscube-public-guidance.png', fullPage: true });
  await memberContext.close();
});

test('CEO dashboard persists variable widgets, renders isolated bundle and preserves last good frame on failure', async ({ page }) => {
  await page.goto('/login'); await page.getByRole('button', { name: '관리자 샘플 로그인' }).click(); await page.goto('/work-pages');
  await expect(page.getByText('목록을 불러오고 있습니다.')).toHaveCount(0);
  await page.getByLabel('조회할 자료').selectOption('insight-dashboard');
  const title = `QA CEO ${Date.now()}`; await page.getByLabel('제목', { exact: true }).fill(title);
  await page.getByRole('button', { name: '위젯 추가', exact: true }).click();
  await page.getByLabel('위젯 3 지표').selectOption('guidance'); await page.getByLabel('위젯 3 위로').click();
  await page.getByRole('button', { name: '현재 구성 저장' }).click();
  await expect(page.getByRole('status')).toContainText('버전 1');
  await page.reload(); await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByLabel('위젯 2 지표')).toHaveValue('guidance');
  await page.getByRole('button', { name: '미리보기', exact: true }).click();
  await page.getByRole('button', { name: '인사이트 자료 조회·미리보기' }).click();
  const frame = page.frameLocator('iframe[title="CEO 인사이트 미리보기"]');
  await expect(frame.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(frame.getByText('QA 격리 사업 / CIC1')).toBeVisible();
  await expect(frame.getByText('확인되지 않음', { exact: true })).toHaveCount(3);
  await expect(page.getByTestId('preview-duration')).toContainText('ms');
  const durations: number[] = [];
  for (let i = 0; i < 5; i++) {
    await page.getByRole('button', { name: '인사이트 자료 조회·미리보기' }).click();
    await expect(page.getByText('새 화면 실행 확인 중…')).toHaveCount(0);
    await expect(page.locator('iframe[title="CEO 인사이트 미리보기"]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '인사이트 자료 조회·미리보기' })).toBeEnabled();
    await expect(frame.getByRole('heading', { name: title, exact: true })).toBeVisible();
    durations.push(Number((await page.getByTestId('preview-duration').innerText()).match(/(\d+)ms/)?.[1]));
  }
  console.log('CEO warm preview samples ms:', JSON.stringify(durations));
  await page.getByLabel('위젯 1 제목').fill('편집 중인 지표');
  await expect(page.getByText('미리보기는 이전 구성입니다.', { exact: false })).toBeVisible();
  await page.getByLabel('위젯 1 제목').fill('저장·제출·승인 품질');
  const visible = page.locator('iframe[title="CEO 인사이트 미리보기"]');
  await page.locator('section[aria-label="인사이트 미리보기"]').screenshot({ path: '/tmp/myscube-ceo-desktop.png' });
  const currentFrame = await (await visible.elementHandle())!.contentFrame();
  await currentFrame!.evaluate(() => { setTimeout(() => { throw new Error('QA runtime failure'); }, 0); });
  await expect(page.getByRole('alert')).toContainText('실행에 실패');
  await expect(page.frameLocator('iframe[title="CEO 인사이트 미리보기"]').getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.locator('section[aria-label="인사이트 미리보기"]').screenshot({ path: '/tmp/myscube-ceo-runtime-error.png' });
  await page.getByRole('button', { name: '인사이트 자료 조회·미리보기' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => { const box = await page.locator('aside').first().boundingBox(); return box ? Math.round(box.x + box.width) : 0; }).toBeLessThanOrEqual(0);
  await page.locator('section[aria-label="인사이트 미리보기"]').screenshot({ path: '/tmp/myscube-ceo-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('preview performance: cold/warm desktop and throttled mobile with explicit render samples', async ({ browser }) => {
  const records: Array<{ profile: string; cold: number[]; warm: number[]; endToEnd: number[] }> = [];
  for (const mobile of [false, true]) {
    const record = { profile: mobile ? 'mobile-390px-cpu4-network120ms-1Mbps' : 'desktop-1280px-local', cold: [] as number[], warm: [] as number[], endToEnd: [] as number[] };
    for (let sample = 0; sample < 5; sample++) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page); await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      if (mobile) { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 120, downloadThroughput: 128000, uploadThroughput: 64000 }); }
      await page.goto('http://localhost:4173/login'); await page.getByRole('button', { name: '관리자 샘플 로그인' }).click(); const navigationStarted = Date.now(); await page.goto('http://localhost:4173/work-pages');
      await expect(page.getByText('목록을 불러오고 있습니다.')).toHaveCount(0);
      await page.getByLabel('조회할 자료').selectOption('insight-dashboard'); await page.getByRole('button', { name: '미리보기', exact: true }).click();
      for (const mode of ['cold', 'warm'] as const) {
        const previous = await page.locator('iframe[title="CEO 인사이트 미리보기"]').count() ? await page.locator('iframe[title="CEO 인사이트 미리보기"]').getAttribute('data-preview-id') : null;
        const start = Date.now(); await page.getByRole('button', { name: '인사이트 자료 조회·미리보기' }).click();
        await expect.poll(() => page.locator('iframe[title="CEO 인사이트 미리보기"]').getAttribute('data-preview-id').catch(() => null)).not.toBe(previous);
        await expect(page.getByTestId('preview-duration')).toContainText('ms');
        if (mode === 'cold') console.log('FIRST_VISIBLE_NAVIGATION', record.profile, Date.now() - navigationStarted);
        record[mode].push(Number((await page.getByTestId('preview-duration').innerText()).match(/(\d+)ms/)?.[1])); record.endToEnd.push(Date.now() - start);
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
      }
      await context.close();
    }
    records.push(record);
  }
  console.log('PREVIEW_PERFORMANCE', JSON.stringify(records));
});

test('QA inquiry reads persisted logs while unknown version and private data remain explicit', async ({ page }) => {
  await page.goto('/login'); await page.getByRole('button', { name: '관리자 샘플 로그인' }).click(); await page.goto('/axr/qa-evidence');
  await page.getByRole('button', { name: '로그와 코드 확인', exact: true }).click();
  await page.getByRole('button', { name: /project_draft_conflict/ }).click();
  await expect(page.getByText('기록에 정확한 코드 버전이 없어 해당 시점 코드를 확인할 수 없습니다.')).toBeVisible();
  await expect(page.getByText('QA 비공개 오류 원문')).toHaveCount(0); await expect(page.getByText('private@example.test')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/myscube-qa-evidence.png', fullPage: true });
});
