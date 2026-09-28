import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { workbenchShellCsp } from '../server/workbench/shell-csp.mjs';

let server: ReturnType<typeof createServer>, base: string;
const gapi = 'https://apis.google.com/js/api.js?onload=__iframefcb_synthetic';
const untrusted = 'https://untrusted.example.invalid/loader.js';
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://fixture.invalid');
    if (url.pathname === '/loader.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(`
        window.__inlineRan = false; window.__evalRan = false;
        const inline = document.createElement('script'); inline.textContent = 'window.__inlineRan = true'; document.head.appendChild(inline);
        try { new Function('window.__evalRan = true')(); } catch {}
        const target = new URL(location.href).searchParams.get('target') === 'untrusted' ? ${JSON.stringify(untrusted)} : ${JSON.stringify(gapi)};
        const script = document.createElement('script'); script.src = target;
        script.onload = () => document.querySelector('#result').textContent = window.__gapiFixtureExecuted ? 'loaded' : 'wrong-script';
        script.onerror = () => document.querySelector('#result').textContent = 'blocked';
        document.head.appendChild(script);
      `);
      return;
    }
    const current = workbenchShellCsp();
    res.setHeader('Content-Security-Policy', url.pathname === '/baseline' ? current.replace(' https://apis.google.com', '') : current);
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><p id="result">waiting</p><script src="/loader.js"></script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
test.afterAll(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections?.(); }); });
test.beforeEach(async ({ page }) => {
  await page.route('https://apis.google.com/**', route => route.fulfill({ contentType: 'text/javascript', body: 'window.__gapiFixtureExecuted = true;' }));
  await page.route('https://untrusted.example.invalid/**', route => route.fulfill({ contentType: 'text/javascript', body: 'window.__gapiFixtureExecuted = true;' }));
});

test('trusted shell permits the Firebase gapi loader origin without allowing inline or eval code', async ({ page }) => {
  const response = await page.goto(`${base}/current`);
  await expect(page.locator('#result')).toHaveText('loaded');
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self' https://apis.google.com;");
  expect(await page.evaluate(() => ({ inline: (window as any).__inlineRan, eval: (window as any).__evalRan }))).toEqual({ inline: false, eval: false });
});
test('the previous self-only policy blocks the same real script-element loading path', async ({ page }) => {
  await page.goto(`${base}/baseline`);
  await expect(page.locator('#result')).toHaveText('blocked');
  expect(await page.evaluate(() => Boolean((window as any).__gapiFixtureExecuted))).toBe(false);
});
test('an unrelated external script stays blocked under the new trusted-shell policy', async ({ page }) => {
  await page.goto(`${base}/current?target=untrusted`);
  await expect(page.locator('#result')).toHaveText('blocked');
  expect(await page.evaluate(() => Boolean((window as any).__gapiFixtureExecuted))).toBe(false);
});
