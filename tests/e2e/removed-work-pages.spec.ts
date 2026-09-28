import { test, expect } from '@playwright/test';

const paths = ['work-pages', 'cashflow-assistant', 'service-guidance'];
const labels = ['내 업무 페이지', '현금흐름 조회·진단', '서비스 이용 안내'];

for (const role of ['admin', 'portal'] as const) {
  test(`${role}: removed menus and direct URLs cannot open unapproved pages`, async ({ page }) => {
    const calls: string[] = [];
    const errors: string[] = [];
    const destination = role === 'admin' ? '/' : '/portal';
    page.on('request', request => {
      if (/\/api\/v1\/(personal-work-pages|cashflow-evidence|service-guidance|assistant)/.test(request.url())) {
        calls.push(request.url());
      }
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/login');
    await page.getByRole('button', {
      name: role === 'admin' ? '관리자 샘플 로그인' : 'PM 샘플 로그인',
    }).click();
    await expect.poll(() => new URL(page.url()).pathname).toMatch(
      role === 'admin' ? /^\/$/ : /^\/portal/,
    );
    const absent = async () => {
      for (const label of labels) {
        await expect(page.getByRole('link', { name: label, exact: true })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: label, exact: true })).toHaveCount(0);
      }
    };
    await absent();
    for (const path of paths) {
      await page.goto(`${role === 'portal' ? '/portal' : ''}/${path}`);
      await expect.poll(() => new URL(page.url()).pathname).toBe(destination);
      await absent();
      await page.reload();
      await expect.poll(() => new URL(page.url()).pathname).toBe(destination);
      await expect(page.getByRole('heading', {
        name: role === 'admin' ? /안녕하세요/ : '오늘 작업할 프로젝트 선택',
      })).toBeVisible();
      await absent();
    }
    if (role === 'admin') {
      await page.goto('/projects');
      await expect(page.getByRole('heading', { name: '프로젝트 통합 관리' })).toBeVisible();
    }
    // Let the existing entrance animation finish before capturing navigation evidence.
    await page.waitForTimeout(500);
    await page.screenshot({ path: `/tmp/myscube-removal-${role}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', {
      name: role === 'admin' ? '메뉴 열기' : '포털 메뉴 열기',
      exact: true,
    }).click();
    await absent();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `/tmp/myscube-removal-${role}-mobile.png`, fullPage: true });
    expect(calls).toEqual([]);
    expect(errors).toEqual([]);
  });
}
