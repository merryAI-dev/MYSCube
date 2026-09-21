import { test, expect, type Page } from '@playwright/test';

const attachment = (name: string) => ({ name, path: `orgs/org001/project-registration-documents/qa-review/${name}`, size: 9, contentType: 'application/pdf' });
const project = { id: 'qa-review', name: '원장 사업명', officialContractName: '원장 계약명',
  executiveReviewStatus: 'APPROVED', executiveApproverId: 'u001', status: 'COMPLETED', department: 'CIC1',
  contractStart: '2025-01-01', contractEnd: '2029-12-31', contractAmount: 3500000000,
  contractDocument: attachment('canonical-only.pdf'), proposalDocument: attachment('canonical-proposal.pdf'),
  teamMembersDetailed: [], checkout: { finalPaymentReceived: true } };
const submitted = { ...project, name: '제출 사업명', officialContractName: '제출 계약명', status: 'IN_PROGRESS', department: 'CIC2',
  contractDocument: attachment('submitted-contract.pdf'), proposalDocument: attachment('submitted-proposal.pdf'),
  proposalPptOriginalDocument: attachment('submitted-slide.pdf'),
  registrationConfirmations: { proposalPptOriginal: 'https://drive.google.com/file/d/submitted-proposal/view' },
  paymentPlan: { contract: 490000000, interim: 0, final: 210000000 },
  financialYears: [2025, 2026, 2027, 2028, 2029].map(year => ({ year, contractAmount: 700000000,
    paymentPlan: { contract: 490000000, interim: 0, final: 210000000 } })),
};

async function openDocument(page: Page, options: { payload?: Record<string, unknown>; canonical?: Record<string, unknown> } = {}) {
  const mutations: string[] = [];
  const draftReads: string[] = [];
  const payload = options.payload || submitted;
  await page.addInitScript(() => {
    localStorage.setItem('mysc-auth-user', JSON.stringify({ uid: 'u001', name: 'QA 관리자', email: 'qa@mysc.co.kr',
      role: 'admin', source: 'firebase', tenantId: 'org001', idToken: 'isolated-token', defaultWorkspace: 'admin', lastWorkspace: 'admin' }));
    localStorage.setItem('MYSC_ACTIVE_TENANT', 'org001');
    localStorage.setItem('project-editor-autosave:qa-review', JSON.stringify({ draft: { name: '미제출 초안 전용',
      registrationConfirmations: { proposalPptOriginal: 'https://drive.google.com/file/d/draft-only/view' } } }));
  });
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('draft')) draftReads.push(path);
    if (path === '/api/v1/projects') return route.fulfill({ json: { items: [options.canonical || project], nextCursor: null } });
    if (path === '/api/v1/project-requests/review-inbox') return route.fulfill({ json: { items: [{ id: 'change-qa-review',
      targetProjectId: project.id, requestKind: 'CHANGE', status: 'PENDING', requestVersion: 2,
      requestedAt: '2026-09-21T00:00:00Z', proposedSnapshot: payload }] } });
    if (route.request().method() !== 'GET') mutations.push(path);
    if (path.includes('/attachments/')) return route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4\n' });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto('/approvals');
  await page.getByTestId('migration-review-record-list').getByRole('button', { name: '문서 열기' }).click();
  const doc = page.getByTestId('migration-review-document');
  await expect(doc).toBeVisible();
  return { doc, mutations, draftReads };
}

test('submitted snapshot controls checkout and annual payment while files and submitted links remain visible', async ({ page }, info) => {
  const { doc, mutations, draftReads } = await openDocument(page);
  await expect(doc.getByRole('heading', { name: '종료사업 체크아웃' })).toHaveCount(0);
  await expect(doc.getByText('제출 계약명', { exact: true })).toBeVisible();
  await expect(doc.getByText('기안 부서', { exact: true }).locator('..')).toContainText('CIC2');
  await expect(doc.getByText('원장 계약명', { exact: true })).toHaveCount(0);
  await expect(doc.getByText(/선금\/계약금 2,450,000,000원 \(70%\)/)).toBeVisible();
  await expect(doc.getByText(/490,000,000원 \(14%\)/)).toHaveCount(0);
  await expect(doc.getByText('submitted-proposal.pdf', { exact: true })).toBeVisible();
  await expect(doc.getByText('submitted-slide.pdf', { exact: true })).toBeVisible();
  await expect(doc.getByRole('link', { name: submitted.registrationConfirmations.proposalPptOriginal, exact: true })).toBeVisible();
  await expect(doc.getByText('canonical-only.pdf', { exact: true })).toHaveCount(0);
  await expect(doc.getByText('미제출 초안 전용', { exact: true })).toHaveCount(0);
  await expect(doc.locator('a[href*="draft-only"]')).toHaveCount(0);
  expect(draftReads).toEqual([]);
  expect(mutations).toEqual([]);
  await doc.getByText('submitted-slide.pdf', { exact: true }).scrollIntoViewIfNeeded();
  const screenshot = info.outputPath('submitted-snapshot.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach('submitted-snapshot', { path: screenshot, contentType: 'image/png' });
});

for (const absence of ['null', 'missing']) {
  test(`submitted ${absence} attachments do not resurrect canonical files`, async ({ page }) => {
    const payload: Record<string, unknown> = { ...submitted, contractDocument: null, proposalDocument: null, proposalPptOriginalDocument: null, registrationConfirmations: {} };
    if (absence === 'missing') { delete payload.contractDocument; delete payload.proposalDocument; }
    const { doc } = await openDocument(page, { payload });
    await expect(doc.getByText('canonical-only.pdf', { exact: true })).toHaveCount(0);
    await expect(doc.getByText('canonical-proposal.pdf', { exact: true })).toHaveCount(0);
    await expect(doc.locator('a[href*="submitted-proposal"]')).toHaveCount(0);
    await expect(doc.getByText('미제출', { exact: true }).first()).toBeVisible();
  });
}

test('submitted completion exposes checkout and final report despite an in-progress canonical record', async ({ page }) => {
  const { doc } = await openDocument(page, { canonical: { ...project, status: 'IN_PROGRESS' },
    payload: { ...submitted, status: 'COMPLETED', finalReportDocument: attachment('submitted-final-report.pdf'),
      performanceCertificateDocument: attachment('submitted-certificate.pdf'), finalSettlementReportDocument: attachment('submitted-settlement.pdf') } });
  await expect(doc.getByRole('heading', { name: '종료사업 체크아웃' })).toBeVisible();
  for (const name of ['submitted-final-report.pdf', 'submitted-certificate.pdf', 'submitted-settlement.pdf']) {
    await expect(doc.getByText(name, { exact: true })).toBeVisible();
  }
});
