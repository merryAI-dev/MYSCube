import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const document = (body: string) => `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>격리 검증</title></head><body>${body}</body></html>`;

test('static HTML sandbox retains its last safe document and never requests blocked resources', async ({ page }, testInfo) => {
  const attempted: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.route('https://isolation-probe.invalid/**', async (route) => { attempted.push(route.request().url()); await route.abort(); });
  await page.goto('/');
  await page.getByRole('tab', { name: '소스', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'HTML 원문', exact: true });
  await expect(editor).toBeVisible();
  await expect(page.getByRole('button', { name: '현재 소스 저장', exact: true })).toBeEnabled();
  await editor.fill(document('<h1 id="safe">정상 격리 화면</h1><a href="#safe">같은 문서 이동</a>'));
  await page.getByRole('button', { name: '미리보기 적용', exact: true }).click();
  const committed = page.getByTestId('source-preview-committed');
  await expect(committed).toBeVisible();
  await expect(committed).toHaveAttribute('sandbox', '');
  await expect(page.frameLocator('[data-testid="source-preview-committed"]').getByRole('heading', { name: '정상 격리 화면' })).toBeVisible();
  const acceptedHash = await committed.getAttribute('data-source-hash');
  const attacks = [
    '<script>parent.document.body.dataset.compromised="yes";fetch("https://isolation-probe.invalid/script")</script>',
    '<img src="https://isolation-probe.invalid/image" onerror="top.location.href=\'https://isolation-probe.invalid/navigation\'">',
    '<a href="https://isolation-probe.invalid/link" target="_top">외부 이동</a>',
    '<meta http-equiv="refresh" content="0;url=https://isolation-probe.invalid/refresh">',
    '<style>@import "https://isolation-probe.invalid/style"; body{background:url(https://isolation-probe.invalid/css)}</style>',
    '<iframe src="https://isolation-probe.invalid/frame"></iframe><form action="https://isolation-probe.invalid/form"><button>전송</button></form>',
    '<div class="bg-[url(https://isolation-probe.invalid/tailwind)]">차단</div>',
    '<div>'.repeat(10000) + '</div>'.repeat(10000),
  ];
  for (const attack of attacks) {
    await page.getByRole('tab', { name: '소스', exact: true }).click();
    await editor.fill(document(attack));
    await page.getByRole('button', { name: '미리보기 적용', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByRole('tab', { name: '미리보기', exact: true }).click();
    await expect(committed).toHaveAttribute('data-source-hash', acceptedHash!);
    await expect(page.getByTestId('source-preview-candidate')).toHaveCount(0);
  }
  await page.screenshot({ path: testInfo.outputPath('html-network-isolation.png'), fullPage: true });
  await testInfo.attach('browser-evidence', { body: JSON.stringify({ attempted, pageErrors, consoleErrors, acceptedHash }, null, 2), contentType: 'application/json' });
  expect(pageErrors).toEqual([]);
  expect(attempted).toEqual([]);
  expect(await page.locator('body').getAttribute('data-compromised')).toBeNull();
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.frameLocator('[data-testid="source-preview-committed"]').getByRole('heading', { name: '정상 격리 화면' })).toBeVisible();
});

test('real model-disabled service refuses generation and remains available', async ({ request }) => {
  const before = await request.get('/api/v1/html-work-pages/capabilities');
  expect(before.status()).toBe(200);
  expect((await before.json()).modelEnabled).toBe(false);
  const response = await request.post('/api/v1/html-work-pages/generate', { headers: { 'Idempotency-Key': randomUUID() }, data: { prompt: '업무 화면' } });
  expect(response.status()).toBe(503);
  expect((await response.json()).error).toBe('html_model_unconfigured');
  expect((await request.get('/api/v1/html-work-pages')).status()).toBe(200);
});


test('compiled Tailwind styles render without a CDN or external stylesheet request', async ({ page }, testInfo) => {
  const external: string[] = [];
  page.on('request', (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:4178/')) external.push(request.url()); });
  await page.goto('/');
  await page.getByRole('tab', { name: '소스', exact: true }).click();
  await expect(page.getByRole('button', { name: '현재 소스 저장', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'HTML 원문', exact: true }).fill(document('<div id="tailwind-proof" class="p-8 grid grid-cols-2 gap-4 font-bold">자료 미연결</div>'));
  await page.getByRole('button', { name: '미리보기 적용', exact: true }).click();
  const preview = page.frameLocator('[data-testid="source-preview-committed"]').locator('#tailwind-proof');
  await expect(preview).toBeVisible();
  const styles = await preview.evaluate((element) => { const style = getComputedStyle(element); return { display: style.display, padding: style.paddingTop, weight: style.fontWeight, gap: style.gap }; });
  expect(styles).toEqual({ display: 'grid', padding: '32px', weight: '700', gap: '16px' });
  expect(external).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('tailwind-compiled-preview.png'), fullPage: true });
});
