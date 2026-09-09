import { expect, test, type Page } from '@playwright/test';

const requiredColor = 'rgb(255, 241, 242)';
const optionalColor = 'rgb(239, 246, 255)';

async function mountControls(page: Page) {
  await page.goto('/login');
  await page.evaluate(async () => {
    const read = (path: string) => import(path);
    const React = (await read('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await read('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { Input } = await read('/src/app/components/ui/input.tsx');
    const { Textarea } = await read('/src/app/components/ui/textarea.tsx');
    const { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } = await read('/src/app/components/ui/select.tsx');
    const { MemberPicker } = await read('/src/app/components/ui/member-picker.tsx');
    const h = React.createElement;
    document.getElementById('root')!.style.display = 'none';
    const host = document.createElement('main');
    host.id = 'field-qa';
    host.style.cssText = 'padding:20px;max-width:700px;margin:auto';
    document.body.append(host);
    const field = (name: string, element: any) => h('label', { style: { display: 'block', marginBottom: '12px' } }, name, element);
    createRoot(host).render(h('section', null,
      h('h1', null, '입력 상태 검증'),
      field('공통 필수 입력', h(Input, { required: true, 'aria-label': '공통 필수 입력', defaultValue: '입력 완료' })),
      field('공통 선택 입력', h(Input, { 'aria-label': '공통 선택 입력' })),
      field('필수 내용', h(Textarea, { 'aria-required': true, 'aria-label': '필수 내용' })),
      field('기본 날짜', h('input', { type: 'date', required: true, 'aria-label': '기본 날짜' })),
      field('기본 선택', h('select', { 'aria-label': '기본 선택' }, h('option', null, '선택'))),
      field('범위 선택 셀', h('input', { 'data-field-selected': true, 'aria-label': '범위 선택 셀' })),
      h('div', { 'data-field-required': 'true' },
        field('행에서 상속', h(Input, { 'aria-label': '행에서 상속' })),
        field('명시적 선택', h(Input, { 'aria-required': false, 'aria-label': '명시적 선택' })),
        h('div', { 'data-field-required': 'false' }, field('안쪽 선택 행', h(Input, { 'aria-label': '안쪽 선택 행' }))),
        h(MemberPicker, { options: [{ uid: 'u1', label: '검증 구성원', email: 'qa@mysc.co.kr', searchText: '검증 구성원' }],
          value: 'u1', onChange: () => {} })),
      field('읽기 전용', h(Input, { required: true, readOnly: true, 'aria-label': '읽기 전용', defaultValue: '고정 값' })),
      h('fieldset', { disabled: true }, field('그룹 비활성', h(Input, { required: true, 'aria-label': '그룹 비활성' }))),
      field('오류 입력', h(Input, { 'aria-required': true, 'aria-invalid': true, 'aria-label': '오류 입력' })),
      h(Select, { defaultValue: 'a', required: true },
        h(SelectTrigger, { 'aria-label': '공통 필수 선택', 'aria-required': true }, h(SelectValue)),
        h(SelectContent, null, h(SelectItem, { value: 'a' }, '선택된 항목'), h(SelectItem, { value: 'b' }, '다른 항목'))),
    ));
  });
  await expect(page.getByLabel('공통 필수 입력')).toBeVisible();
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`shared actual controls have semantic colors and stable focus at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mountControls(page);
    for (const label of ['공통 필수 입력', '필수 내용', '기본 날짜', '행에서 상속', '공통 필수 선택']) {
      await expect(page.getByLabel(label, { exact: true })).toHaveCSS('background-color', requiredColor);
    }
    for (const label of ['공통 선택 입력', '기본 선택', '명시적 선택', '안쪽 선택 행']) {
      await expect(page.getByLabel(label, { exact: true })).toHaveCSS('background-color', optionalColor);
    }
    const neutralColor = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--field-neutral-background').trim());
    for (const label of ['읽기 전용', '그룹 비활성']) {
      const color = await page.getByLabel(label).evaluate(element => getComputedStyle(element).backgroundColor);
      expect([requiredColor, optionalColor]).not.toContain(color);
      expect(neutralColor).toBeTruthy();
    }
    const field = page.getByLabel('공통 선택 입력', { exact: true });
    await expect(page.getByLabel('범위 선택 셀')).toHaveCSS('outline-width', '3px');
    const before = await field.boundingBox();
    await field.focus();
    await expect(field).toHaveCSS('outline-width', '3px');
    await expect(field).toHaveCSS('outline-offset', '-3px');
    expect(await field.boundingBox()).toEqual(before);
    const invalid = page.getByLabel('오류 입력');
    await invalid.focus();
    await expect(invalid).toHaveCSS('background-color', requiredColor);
    expect(await invalid.evaluate(element => getComputedStyle(element).borderColor))
      .not.toBe(await field.evaluate(element => getComputedStyle(element).borderColor));
    const picker = page.getByRole('combobox').filter({ hasText: '검증 구성원' });
    await expect(picker).toHaveCSS('background-color', requiredColor);
    await picker.click();
    await expect(picker).toHaveCSS('outline-width', '3px');
    await page.keyboard.press('Escape');
    await page.getByLabel('공통 필수 선택').click();
    await expect(page.getByRole('option', { name: '선택된 항목', exact: true })).toHaveCSS('outline-width', '3px');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { name: '선택된 항목', exact: true })).toHaveCSS('outline-width', '3px');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `/tmp/mola-field-controls-${viewport.width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect(page.getByLabel('공통 필수 입력', { exact: true })).toHaveCSS('background-color', 'rgb(53, 35, 45)');
    await expect(field).toHaveCSS('background-color', 'rgb(22, 43, 67)');
    await expect(page.getByLabel('읽기 전용')).toHaveCSS('background-color', 'rgb(23, 35, 52)');
    await expect(page.getByLabel('그룹 비활성')).toHaveCSS('background-color', 'rgb(23, 35, 52)');
  });
}

test('project registration uses actual required rows before validation and keeps optional link blue', async ({ page }) => {
  const payload = { name: '', officialContractName: '', department: 'CIC1', type: 'A1', clientOrg: '',
    projectPurpose: '', description: '', registrationRequirementsVersion: 2, contractStart: '', contractEnd: '' };
  await page.route('**/api/v1/edit-leases/**', route => route.fulfill({ json: { state: 'ACTIVE', canEdit: true,
    serverNow: new Date().toISOString(), expiresAt: new Date(Date.now() + 1800000).toISOString(), leaseId: 'field-lease', fence: 1 } }));
  await page.route('**/api/v1/project-registration-drafts/field-style', route => route.fulfill({ json: { draft: {
    draftId: 'field-style', resourceType: 'project-registration', resourceId: 'field-style', draftRevision: 1,
    payload, attachmentRefs: [], stepIndex: 0,
  } } }));
  await page.goto('/login');
  await page.getByRole('button', { name: 'PM 샘플 로그인' }).click();
  await page.goto('/portal/register-project/field-style');
  const required = page.getByPlaceholder('예: 26농식품AC');
  await expect(required).toHaveCSS('background-color', requiredColor);
  const optional = page.getByPlaceholder('https://drive.google.com/drive/folders/...');
  await expect(optional).toHaveCSS('background-color', optionalColor);
  await required.fill('필수 항목 입력 후');
  await expect(required).toHaveCSS('background-color', requiredColor);
  await optional.focus();
  await expect(optional).toHaveCSS('outline-width', '3px');
  await page.screenshot({ path: '/tmp/mola-field-project-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(required).toBeVisible();
  await expect(optional).toHaveCSS('background-color', optionalColor);
  await page.screenshot({ path: '/tmp/mola-field-project-mobile.png', fullPage: true });
});
