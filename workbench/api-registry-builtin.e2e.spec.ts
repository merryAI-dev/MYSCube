import { test, expect } from '@playwright/test';
import { REACT_EXAMPLE } from '../server/workbench/react-pages.mjs';

test('built-in MYSCube connections are listed as read-only while stored connections stay editable', async ({ page }) => {
  const parameters = { limit: { type: 'integer', required: false, label: '페이지 사업 수(최대 20)', example: 20 } };
  const definition = (name: string) => ({ name, description: '합성 검증용 연결', enabled: true, kind: 'external-read', endpointId: 'myscube-projects', endpointVersion: 1, parameters });
  const builtIn = { id: '11111111-1111-5111-8111-111111111111', version: 1, builtIn: true, definition: definition('MYSCube 사업 목록'), responseKind: 'external-read' };
  const stored = { id: '22222222-2222-4222-8222-222222222222', version: 3, definition: definition('직접 등록한 사업 연결'), responseKind: 'external-read' };
  const mutations: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() !== 'GET') mutations.push(path);
    if (path.endsWith('/capabilities')) return reply({ modelEnabled: false, gitEnabled: false, runtimeUrl: null, remoteRuntime: false, runtimeMode: 'not-configured', example: REACT_EXAMPLE });
    if (path === '/api/v1/workbench-apis') return reply({ items: [builtIn, stored], truncated: false });
    if (path === '/api/v1/workbench-apis/endpoints') return reply({ items: [{ id: 'myscube-projects', version: 1, name: 'MYSCube 사업 목록', description: '합성', parameters, responseSchema: { type: 'object' }, contractHash: 'a'.repeat(64) }] });
    if (path === '/api/v1/workbench-apis/catalog') return reply({ items: [] });
    if (path.endsWith('/conversations')) return reply({ items: [] });
    if (path === '/api/v1/react-work-pages') return reply({ items: [], truncated: false });
    return reply({ items: [] });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'API 등록·관리' }).click();
  const select = page.getByLabel('등록한 API 연결');
  await expect(select.locator('option', { hasText: 'MYSCube 사업 목록 · 기본 제공' })).toHaveCount(1);
  await expect(select.locator('option', { hasText: '직접 등록한 사업 연결 · v3 · 사용 중' })).toHaveCount(1);
  await select.selectOption(builtIn.id);
  await expect(page.getByText('기본 제공 MYSCube 연결입니다')).toBeVisible();
  await expect(page.getByRole('button', { name: '변경 내용 저장' })).toBeDisabled();
  await select.selectOption(stored.id);
  await expect(page.getByText('기본 제공 MYSCube 연결입니다')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '변경 내용 저장' })).toBeEnabled();
  expect(mutations).toEqual([]); expect(errors).toEqual([]);
});
