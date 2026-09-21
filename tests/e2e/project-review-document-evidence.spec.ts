import { test, expect } from '@playwright/test';

test('attachment audit: submitted filenames and Drive links survive actual approval document rendering', async ({page}, info) => {
 const project={id:'qa-attachments',name:'현재 원장',version:3,status:'COMPLETED',department:'CIC1',executiveReviewStatus:'PENDING',executiveApproverId:'u001',teamMembersDetailed:[]};
 const payload={name:'제출된 사업',status:'IN_PROGRESS',department:'CIC1',executiveApproverId:'u001',teamMembersDetailed:[],contractDocument:{path:'orgs/org001/project-registration-documents/qa-attachments/contract.pdf',name:'검증 계약서 원본.pdf'},proposalPptOriginalDocument:{path:'orgs/org001/project-registration-documents/qa-attachments/proposal.pptx',name:'제출 제안서 원본.pptx'},customerBusinessRegistrationDocument:null,registrationOptionalDocumentNotes:{rfpRequestEvidence:'해당 없음',proposalWordOriginal:'고객사에게 원본을 받지 못했습니다'},registrationConfirmations:{proposalPptOriginal:'https://drive.google.com/file/d/audit-submitted-proposal/view',presentationPptOriginal:'https://docs.google.com/presentation/d/audit-presentation/edit'}};
 const requestDoc={id:'request-attachments',targetProjectId:project.id,approvedProjectId:project.id,requestKind:'REGISTRATION',status:'PENDING',requestVersion:1,requestedAt:'2026-09-21T00:00:00Z',payload};
 const unexpectedWrites:string[]=[];const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{localStorage.setItem('mysc-auth-user',JSON.stringify({uid:'u001',name:'QA 관리자',email:'qa@example.com',role:'admin',source:'firebase',tenantId:'org001',idToken:'isolated-fixture',defaultWorkspace:'admin',lastWorkspace:'admin'}));localStorage.setItem('MYSC_ACTIVE_TENANT','org001');});
 await page.route('**/api/v1/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  if(path==='/api/v1/projects')return route.fulfill({json:{items:[project]}});
  if(path==='/api/v1/project-requests/review-inbox')return route.fulfill({json:{items:[requestDoc]}});
  if(path==='/api/v1/projects/qa-attachments/review-document')return route.fulfill({json:{project,request:requestDoc,reviewToken:'read-only-fixture',readiness:{legacy:true,issues:[{code:'legacy_submission_format',severity:'warning',title:'이전 형식으로 제출된 문서',detail:'일부 항목이 기록되지 않았을 수 있습니다.',action:'첨부 원문과 제출 내용을 대조해 주세요.'}]}}});
  if(path==='/api/v1/client-errors')return route.fulfill({json:{ok:true}});
  if(req.method()!=='GET')unexpectedWrites.push(path);
  return route.fulfill({json:{items:[]}});
 });
 await page.goto('/approvals');await page.getByTestId('migration-review-record-list').getByRole('button',{name:'문서 열기'}).click();
 const doc=page.getByTestId('migration-review-document');
 await expect(doc.getByText('검증 계약서 원본.pdf',{exact:true}).first()).toBeVisible();
 await expect(doc.getByText('제출 제안서 원본.pptx',{exact:true})).toBeVisible();
 await expect(doc.locator('a[href="https://drive.google.com/file/d/audit-submitted-proposal/view"]')).toHaveCount(2);
 await expect(doc.locator('a[href="https://docs.google.com/presentation/d/audit-presentation/edit"]')).toHaveCount(2);
 await expect(doc.getByText('진행 중',{exact:true})).toBeVisible();
 await expect(doc.getByTestId('migration-review-document-slot-6').getByRole('link',{name:'링크 열기'})).toBeVisible();
 await expect(doc.getByTestId('migration-review-document-slot-6')).not.toContainText('해당 없음');
 await expect(doc.getByTestId('migration-review-document-slot-2')).toContainText('미입력');
 await expect(doc.getByTestId('migration-review-document-slot-3')).toContainText('기록 없음');
 await expect(doc.getByTestId('migration-review-document-slot-4')).toContainText('고객사에게 원본을 받지 못했습니다');
 await expect(doc.getByTestId('migration-review-document-slot-7')).toContainText('해당 없음');
 await expect(doc.getByTestId('migration-review-document-slots')).not.toContainText('선택 · 미제출');
 await expect(doc.getByRole('region',{name:'승인 전 확인사항'})).toContainText('이전 형식으로 제출된 문서');
 await expect(doc.getByRole('button',{name:'승인',exact:true})).toBeEnabled();
 await doc.getByText('제출 제안서 원본.pptx',{exact:true}).scrollIntoViewIfNeeded();
 const screenshot=info.outputPath('attachments-links-status.png');await page.screenshot({path:screenshot,fullPage:true});await info.attach('approval-file-link-audit',{path:screenshot,contentType:'image/png'});
 expect(errors).toEqual([]);expect(unexpectedWrites).toEqual([]);
});
