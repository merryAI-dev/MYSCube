import { test, expect } from '@playwright/test';

// UI-only contract fixture. Server persistence/idempotency is covered by conversation-routes.integration.test.ts.
const source = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>현재 화면</title></head><body><main><h1>현재 화면</h1></main></body></html>';
const turnOne = { id: 'turn-1', sequence: 1, state: 'completed', message: '9월 미제출 사업을 확인해 주세요.', createdAt: '2026-09-22T13:00:00.000Z', result: { status: 'clarification_required', answer: '연도를 먼저 확인해 주세요.', clarification: { id: 'clarification-year', question: '어느 연도 9월인가요?', options: [{ id: 'year-2026', label: '2026년 9월' }] } } };
const turnTwo = { id: 'turn-2', sequence: 2, state: 'completed', message: '2026년 9월', createdAt: '2026-09-22T13:01:00.000Z', result: { status: 'answered', answer: '확인된 자료를 표시합니다.', evidence: [{ evidenceId: 'submission-status', columns: [{ name: 'project', label: '프로젝트' }, { name: 'count', type: 'number', label: '건수' }, { name: 'note', label: '메모' }], rows: [{ project: 'A 사업', count: 0, note: null }], metadata: { provenance: '승인 원장', asOf: '2026-09-22', completeness: '완료' }, sql: 'status = submitted', normalizedSql: 'status = submitted', coverage: { cic: ['CIC4'], month: ['2026-09'] } }] } };

test('conversation UI refreshes canonical turns, preserves evidence values, and disables stale clarification options', async ({ page }) => {
  const consoleErrors: string[] = []; const sent: string[] = []; let phase = 0;
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(); const url = new URL(request.url()); const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/v1/html-work-pages/capabilities') return respond({ modelEnabled: true, message: 'AI 연결됨' });
    if (url.pathname === '/api/v1/html-work-pages' && request.method() === 'GET') return respond({ items: [] });
    if (url.pathname === '/api/v1/html-work-pages/references') return respond({ references: [], example: source });
    if (url.pathname === '/api/v1/workbench-conversations' && request.method() === 'GET') return respond({ items: phase ? [{ id: 'session-1', title: '9월 미제출', version: phase, updatedAt: '2026-09-22T13:01:00.000Z' }] : [] });
    if (url.pathname === '/api/v1/workbench-conversations' && request.method() === 'POST') return respond({ id: 'session-1', title: '9월 미제출', version: 0, updatedAt: '2026-09-22T13:00:00.000Z' }, 201);
    if (url.pathname === '/api/v1/workbench-conversations/session-1' && request.method() === 'GET') return respond({ id: 'session-1', title: '9월 미제출', version: phase, turns: phase > 1 ? [turnOne, turnTwo] : phase ? [turnOne] : [], truncated: false });
    if (url.pathname === '/api/v1/workbench-conversations/session-1/turns' && request.method() === 'POST') {
      const body = request.postDataJSON(); sent.push(body.message); phase += 1;
      return respond({ version: phase, turnId: `turn-${phase}`, result: phase === 1 ? turnOne.result : turnTwo.result });
    }
    return respond({ error: 'unexpected_fixture_request' }, 500);
  });
  await page.goto('/?mode=html');
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await page.getByRole('textbox', { name: '업무 대화 입력', exact: true }).fill(turnOne.message);
  await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
  await expect(page.getByText('어느 연도 9월인가요?')).toBeVisible();
  await page.getByRole('button', { name: '2026년 9월', exact: true }).click();
  await expect(page.getByText('확인된 자료를 표시합니다.')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /프로젝트/ })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /건수/ })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /메모/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: '0', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '값 없음', exact: true })).toBeVisible();
  const metadata = page.locator('.evidence-metadata');
  await expect(metadata.getByText('출처', { exact: true })).toBeVisible(); await expect(metadata.getByText('승인 원장', { exact: true })).toBeVisible();
  await expect(metadata.getByText('기준 일자', { exact: true })).toBeVisible(); await expect(metadata.getByText('2026-09-22', { exact: true })).toBeVisible();
  await expect(metadata.getByText('자료 완전성', { exact: true })).toBeVisible(); await expect(metadata.getByText('완료', { exact: true })).toBeVisible();
  await page.getByText('조회 범위 확인', { exact: true }).click();
  await expect(page.getByText('CIC4', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '2026년 9월', exact: true })).toBeDisabled();
  expect(sent).toEqual([turnOne.message, '2026년 9월']);
  expect(consoleErrors).toEqual([]);
  await page.screenshot({ path: '/tmp/myscube-s14-conversation-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/myscube-s14-conversation-mobile.png', fullPage: true });
});
