import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const htmlDocument = (heading: string) => `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>미리보기 커밋 검증</title></head><body><main><h1>${heading}</h1><p>전체 문서 교체 검증용 화면</p></main></body></html>`;

async function observePreviewFrames(page: Page) {
  await page.addInitScript(() => {
    type ObservedFrame = { node: HTMLIFrameElement; id: number; originalRole: string; srcdoc: string; loads: number; roles: string[] };
    const frames: ObservedFrame[] = [];
    const entries = new WeakMap<HTMLIFrameElement, ObservedFrame>();
    const register = (node: HTMLIFrameElement) => {
      const role = node.getAttribute('data-testid') || '';
      if (!role.startsWith('source-preview-')) return;
      let entry = entries.get(node);
      if (!entry) {
        entry = { node, id: frames.length + 1, originalRole: role, srcdoc: node.srcdoc, loads: 0, roles: [role] };
        frames.push(entry); entries.set(node, entry);
        node.addEventListener('load', () => { entry!.loads++; }, { capture: true });
      }
      if (entry.roles.at(-1) !== role) entry.roles.push(role);
    };
    const inspect = (node: Node) => {
      if (node instanceof HTMLIFrameElement) register(node);
      if (node instanceof Element) node.querySelectorAll('iframe').forEach(register);
    };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.target instanceof HTMLIFrameElement) register(mutation.target);
        for (const node of mutation.addedNodes) inspect(node);
      }
    });
    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid'] });
    (window as unknown as { previewCommitProbe: { snapshot: () => unknown } }).previewCommitProbe = {
      snapshot: () => {
        const committed = document.querySelector<HTMLIFrameElement>('[data-testid="source-preview-committed"]');
        return {
          committedId: committed ? entries.get(committed)?.id : null,
          committedWasCandidate: Boolean(committed && entries.get(committed)?.originalRole === 'source-preview-candidate'),
          frames: frames.map(({ node, ...entry }) => ({ ...entry, connected: node.isConnected, currentRole: node.getAttribute('data-testid') })),
          frameCount: document.querySelectorAll('iframe[data-testid^="source-preview-"]').length,
        };
      },
    };
  });
}

async function snapshot(page: Page) {
  return page.evaluate(() => (window as unknown as { previewCommitProbe: { snapshot: () => { committedId: number | null; committedWasCandidate: boolean; frames: Array<{ id: number; originalRole: string; srcdoc: string; loads: number; connected: boolean; roles: string[] }>; frameCount: number } } }).previewCommitProbe.snapshot());
}

async function openPreview(page: Page, heading: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '미리보기 적용', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'HTML 원문', exact: true }).fill(htmlDocument(heading));
  await page.getByRole('button', { name: '미리보기 적용', exact: true }).click();
  await expect(page.getByTestId('source-preview-committed')).toBeVisible();
  await expect(page.frameLocator('[data-testid="source-preview-committed"]').getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect(page.getByTestId('source-preview-candidate')).toHaveCount(0);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('a successfully loaded candidate commits the same iframe node with one load per source document', async ({ page }, testInfo) => {
  await observePreviewFrames(page);
  await openPreview(page, '한 번만 실행한 문서');
  const result = await snapshot(page);
  await writeFile(testInfo.outputPath('node-load-evidence.json'), JSON.stringify(result, null, 2));
  await testInfo.attach('candidate-commit-node-and-loads', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(result.committedWasCandidate, 'Committing a candidate must retain its actual DOM node').toBe(true);
  expect(result.frames).toHaveLength(1);
  expect(result.frames[0].roles).toEqual(['source-preview-candidate', 'source-preview-committed']);
  expect(result.frames[0].loads).toBe(1);
  expect(result.frameCount).toBe(1);
  await page.getByRole('button', { name: '미리보기 적용', exact: true }).click();
  await expect(page.getByRole('button', { name: '미리보기 적용', exact: true })).toBeEnabled();
  await expect.poll(async () => (await snapshot(page)).committedId).toBe(result.committedId);
  expect((await snapshot(page)).frames).toEqual(result.frames);
});

test('a second successful document replaces the prior frame by promoting its loaded candidate node', async ({ page }, testInfo) => {
  await observePreviewFrames(page);
  await openPreview(page, '첫 번째 정상 문서');
  const before = await snapshot(page);
  await page.route('**/api/v1/html-work-pages/preview', async (route) => {
    const response = await route.fetch({ postData: JSON.stringify({ source: { title: '두 번째 문서', html: htmlDocument('두 번째 정상 문서') } }) });
    expect(response.ok()).toBe(true);
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '미리보기 적용', exact: true }).click();
  await expect(page.frameLocator('[data-testid="source-preview-committed"]').getByRole('heading', { name: '두 번째 정상 문서', exact: true })).toBeVisible();
  await expect(page.getByTestId('source-preview-candidate')).toHaveCount(0);
  const after = await snapshot(page);
  await writeFile(testInfo.outputPath('replacement-node-load-evidence.json'), JSON.stringify({ before, after }, null, 2));
  await testInfo.attach('second-document-promotes-candidate', { body: JSON.stringify({ before, after }, null, 2), contentType: 'application/json' });
  expect(after.committedWasCandidate).toBe(true);
  expect(after.committedId).not.toBe(before.committedId);
  expect(after.frames).toHaveLength(2);
  expect(new Set(after.frames.map((frame) => frame.srcdoc)).size).toBe(2);
  expect(after.frames.map((frame) => frame.loads)).toEqual([1, 1]);
  expect(after.frames.map((frame) => frame.roles)).toEqual([
    ['source-preview-candidate', 'source-preview-committed'],
    ['source-preview-candidate', 'source-preview-committed'],
  ]);
  expect(after.frames.map((frame) => frame.connected)).toEqual([false, true]);
  expect(after.frameCount).toBe(1);
});

test('a rejected preview artifact preserves the last committed node without another document load', async ({ page }, testInfo) => {
  await observePreviewFrames(page);
  await openPreview(page, '이전 정상 문서');
  const before = await snapshot(page);
  const hash = await page.getByTestId('source-preview-committed').getAttribute('data-source-hash');
  await page.route('**/api/v1/html-work-pages/preview', async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.fulfill({ response, json: { ...await response.json(), previewHash: '0'.repeat(64) } });
  });
  await page.getByRole('button', { name: '미리보기 적용', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('실행본 식별값');
  await expect(page.getByTestId('source-preview-committed')).toHaveAttribute('data-source-hash', hash!);
  await expect(page.frameLocator('[data-testid="source-preview-committed"]').getByRole('heading', { name: '이전 정상 문서', exact: true })).toBeVisible();
  const after = await snapshot(page);
  await writeFile(testInfo.outputPath('rejected-artifact-evidence.json'), JSON.stringify({ before, after }, null, 2));
  await testInfo.attach('failed-candidate-preserves-committed', { body: JSON.stringify({ before, after }, null, 2), contentType: 'application/json' });
  expect(after.committedId).toBe(before.committedId);
  expect(after.frames).toEqual(before.frames);
  expect(after.frameCount).toBe(1);
});
