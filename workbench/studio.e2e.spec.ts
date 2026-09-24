import { test, expect, type Page } from '@playwright/test';

async function applyPreview(page: Page) {
  const response = page.waitForResponse((result) => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/v1/html-work-pages/preview');
  const apply = page.getByRole('button', { name: '미리보기 적용', exact: true });
  await apply.click(); expect((await response).ok()).toBe(true); await expect(apply).toBeEnabled();
  await expect(page.getByRole('tab', { name: '미리보기', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('iframe[title="정상 HTML 미리보기"]')).toBeVisible();
}

test('exact HTML persists through reload and restore with matching review bytes', async ({ page }) => {
  await page.goto('/?mode=html');
  await expect(page.getByRole('heading', { name: 'HTML 제작 공간', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'HTML 원문', exact: true })).not.toHaveValue('');
  const title = `HTML QA ${Date.now()}`;
  await page.getByLabel('화면 제목').fill(title);
  const original = await page.getByRole('textbox', { name: 'HTML 원문', exact: true }).inputValue();
  await page.getByRole('button', { name: '현재 소스 저장', exact: true }).click();
  await expect(page.locator('.notice')).toContainText('버전 1으로 저장');
  await page.reload();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await page.getByRole('tab', { name: '소스', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'HTML 원문', exact: true })).toHaveValue(original);
  await applyPreview(page);
  await expect(page.locator('iframe[title="정상 HTML 미리보기"]')).toHaveCount(1);
  await expect(page.locator('iframe[title="정상 HTML 미리보기"]')).toBeVisible();
  await page.getByRole('tab', { name: '소스', exact: true }).click();
  const changed = original.replace('</main>', '<section><h2>추가 검토 항목</h2><p>변경한 HTML 원문</p></section></main>');
  await page.getByRole('textbox', { name: 'HTML 원문', exact: true }).fill(changed);
  await page.getByRole('button', { name: '현재 소스 저장', exact: true }).click();
  await expect(page.locator('.notice')).toContainText('버전 2으로 저장');
  await page.getByRole('button', { name: '저장 버전 리뷰·내보내기', exact: true }).click();
  await expect(page.getByText('리뷰 대상: 저장 버전 2')).toBeVisible();
  await page.getByText('index.html', { exact: true }).click();
  await expect(page.locator('.review pre').first()).toHaveText(changed);
  await page.getByRole('button', { name: '버전 이력', exact: true }).click();
  await page.locator('.history-row').filter({ hasText: '버전 1' }).getByRole('button', { name: '복원', exact: true }).click();
  await expect(page.locator('.notice')).toContainText('새 버전 3으로 복원');
  await page.getByRole('tab', { name: '소스', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'HTML 원문', exact: true })).toHaveValue(original);
  await applyPreview(page);
  await expect(page.locator('iframe[title="정상 HTML 미리보기"]')).toBeVisible();
  await page.screenshot({ path: '/tmp/myscube-html-studio-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/myscube-html-studio-mobile.png', fullPage: true });
});

test('disabled model is clear; reference material and exact source stay usable', async ({ page }) => {
  await page.goto('/?mode=html');
  await expect(page.getByRole('textbox', { name: 'HTML 원문', exact: true })).not.toHaveValue('');
  await expect(page.getByRole('button', { name: 'HTML 생성·수정 요청' })).toBeDisabled();
  await expect(page.locator('.notice')).toContainText('AI 연결 설정 전');
  await page.getByText(/생성에 참고할 레퍼런스/).click();
  await expect(page.getByRole('link', { name: '공식 문서 보기 ↗' }).first()).toHaveAttribute('href', 'https://toss.tech/article/52885');
});
