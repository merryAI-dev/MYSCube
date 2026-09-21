import {test,expect} from '@playwright/test';

test('actual review UI uses opened token and retains comment through 409 and explicit reread',async({page},info)=>{
 const project={id:'qa-version',version:9,name:'원장 사업명',status:'IN_PROGRESS',department:'CIC1',executiveReviewStatus:'APPROVED',executiveApproverId:'u001',teamMembersDetailed:[]};
 const makeRequest=(version:number)=>({id:'change-qa-version',targetProjectId:project.id,approvedProjectId:project.id,requestKind:'CHANGE',status:'PENDING',requestVersion:version,baseProjectVersion:9,targetProjectVersion:10,requestedAt:'2026-09-21T00:00:00Z',proposedSnapshot:{name:`제출 버전 ${version}`,officialContractName:`계약 버전 ${version}`,status:'IN_PROGRESS',department:'CIC1',executiveApproverId:'u001',teamMembersDetailed:[]}});
 let version=1;const writes:any[]=[];const reads:string[]=[];let approved=false;
 await page.addInitScript(()=>{localStorage.setItem('mysc-auth-user',JSON.stringify({uid:'u001',name:'QA 관리자',email:'qa@mysc.co.kr',role:'admin',source:'firebase',tenantId:'org001',idToken:'isolated-token',defaultWorkspace:'admin',lastWorkspace:'admin'}));localStorage.setItem('MYSC_ACTIVE_TENANT','org001');});
 await page.route('**/api/v1/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  if(path==='/api/v1/projects')return route.fulfill({json:{items:[project],nextCursor:null}});
  if(path==='/api/v1/project-requests/review-inbox')return route.fulfill({json:{items:approved?[]:[makeRequest(version)]}});
  if(path==='/api/v1/projects/qa-version/review-document'){reads.push(url.search);return route.fulfill({json:{project,request:makeRequest(version),reviewToken:`token-${version}`,readiness:{legacy:true,issues:version===1?[{code:'legacy_submission_format',severity:'warning',title:'이전 형식 안내 최초본',detail:'기록 항목을 확인해 주세요.',action:'원문과 대조해 주세요.'}]:[]}}});}
  if(path==='/api/v1/projects/qa-version/executive-review'){
   writes.push(req.postDataJSON());
   if(writes.length===1){version=2;return route.fulfill({status:409,json:{error:'review_version_conflict',message:'검토 중 제출 내용이 변경되었습니다.'}});}
   approved=true;return route.fulfill({json:{reviewStatus:'APPROVED',version:10}});
  }
  if(path==='/api/v1/client-errors')return route.fulfill({json:{ok:true}});
  if(req.method()!=='GET')throw new Error(`unexpected mutation: ${path}`);
  return route.fulfill({json:{items:[]}});
 });
 await page.goto('/approvals');
 await page.getByTestId('migration-review-record-list').getByRole('button',{name:'문서 열기'}).click();
 const doc=page.getByTestId('migration-review-document');
 await expect(doc.getByText('계약 버전 1',{exact:true})).toBeVisible();
 expect(reads).toHaveLength(1);expect(reads[0]).toContain('requestId=change-qa-version');
 await doc.getByRole('button',{name:'승인',exact:true}).click();
 const comment=page.getByPlaceholder('승인 판단 근거를 남길 수 있습니다.');
 await comment.fill('다시 검토할 때도 유지할 승인 의견');
 await page.getByRole('button',{name:'승인 저장',exact:true}).click();
 await expect(page.getByRole('button',{name:'작성한 의견을 유지하고 변경된 문서 다시 검토'})).toBeVisible();
 await expect(comment).toHaveValue('다시 검토할 때도 유지할 승인 의견');
 expect(writes).toHaveLength(1);
 expect(writes[0]).toMatchObject({expectedReviewToken:'token-1',expectedRequestVersion:1,expectedProjectVersion:9,requestId:'change-qa-version',reviewComment:'다시 검토할 때도 유지할 승인 의견'});
 await expect(doc.getByText('계약 버전 1',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'작성한 의견을 유지하고 변경된 문서 다시 검토'}).click();
 await expect(doc.getByText('계약 버전 2',{exact:true})).toBeVisible();
 expect(reads).toHaveLength(2);
 await expect(doc.getByText('이전 형식 안내 최초본',{exact:false})).toHaveCount(0);
 await doc.getByRole('button',{name:'승인',exact:true}).click();
 await expect(comment).toHaveValue('다시 검토할 때도 유지할 승인 의견');
 await expect(comment).toBeVisible();
 const screenshot=info.outputPath('reread-retained-comment.png');
 await page.screenshot({path:screenshot,animations:'disabled'});
 await info.attach('reread-retained-comment',{path:screenshot,contentType:'image/png'});
 await page.getByRole('button',{name:'승인 저장',exact:true}).click();
 await expect(doc).toHaveCount(0);
 expect(writes).toHaveLength(2);
 expect(writes[1]).toMatchObject({expectedReviewToken:'token-2',expectedRequestVersion:2,expectedProjectVersion:9,reviewComment:'다시 검토할 때도 유지할 승인 의견'});
});


for(const severity of ['warning','blocking'] as const){
 test(`readiness ${severity} explains legacy fields and only blockers disable approval`,async({page},info)=>{
  const project={id:'qa-readiness',name:'안내 검증',version:3,status:'IN_PROGRESS',department:'CIC1',executiveReviewStatus:'PENDING',executiveApproverId:'u001',teamMembersDetailed:[]};
  const requestDoc={id:'pr-readiness',targetProjectId:project.id,approvedProjectId:project.id,requestKind:'REGISTRATION',status:'PENDING',requestVersion:1,requestedAt:'2026-09-21T00:00:00Z',payload:{...project}};
  const readiness={legacy:true,issues:[{code:severity==='blocking'?'project_attachment_unavailable':'legacy_submission_format',severity,title:severity==='blocking'?'계약서 파일을 확인하지 못했습니다':'이전 형식으로 제출된 문서입니다',detail:severity==='blocking'?'계약서의 저장 정보와 실제 파일을 대조하지 못했습니다.':'이전 형식이라는 이유만으로 승인이 제한되지는 않습니다.',action:severity==='blocking'?'운영 담당자가 계약서 파일을 확인하고 등록자가 필요한 경우 재첨부해 주세요.':'조직장은 제출 원문과 미기록 항목을 함께 확인해 주세요.',field:'contractDocument'}]};
  await page.addInitScript(()=>{localStorage.setItem('mysc-auth-user',JSON.stringify({uid:'u001',name:'QA 관리자',role:'admin',email:'qa@mysc.co.kr',source:'firebase',tenantId:'org001',idToken:'isolated-token',defaultWorkspace:'admin',lastWorkspace:'admin'}));localStorage.setItem('MYSC_ACTIVE_TENANT','org001');});
  const mutations:string[]=[];
  await page.route('**/api/v1/**',route=>{const r=route.request(),p=new URL(r.url()).pathname;
   if(p==='/api/v1/projects')return route.fulfill({json:{items:[project]}});
   if(p==='/api/v1/project-requests/review-inbox')return route.fulfill({json:{items:[requestDoc]}});
   if(p==='/api/v1/projects/qa-readiness/review-document')return route.fulfill({json:{project,request:requestDoc,reviewToken:'readiness-token',readiness}});
   if(r.method()!=='GET')mutations.push(p);
   return route.fulfill({json:{items:[]}});
  });
  await page.goto('/approvals');
  await page.getByTestId('migration-review-record-list').getByRole('button',{name:'문서 열기'}).click();
  const doc=page.getByTestId('migration-review-document'),panel=doc.getByRole('region',{name:'승인 전 확인사항'});
  await expect(panel).toContainText(readiness.issues[0].title);
  await expect(panel).toContainText(readiness.issues[0].detail);
  await expect(panel).toContainText(readiness.issues[0].action);
  await expect(panel).toContainText('조치 방법:');
  if(severity==='blocking')await expect(doc.getByRole('button',{name:'승인',exact:true})).toBeDisabled();
  else await expect(doc.getByRole('button',{name:'승인',exact:true})).toBeEnabled();
  await expect(doc.getByRole('button',{name:'반려',exact:true})).toBeEnabled();
  expect(mutations).toEqual([]);
  const screenshot=info.outputPath(`readiness-${severity}.png`);await panel.scrollIntoViewIfNeeded();await page.screenshot({path:screenshot,animations:'disabled'});await info.attach(`readiness-${severity}`,{path:screenshot,contentType:'image/png'});
 });
}

test('closing a delayed reread restores the list and ignores the late document response',async({page})=>{
 const project={id:'qa-close',version:1,name:'재조회 닫기 검증',status:'IN_PROGRESS',department:'CIC1',executiveReviewStatus:'PENDING',executiveApproverId:'u001',teamMembersDetailed:[]};
 const requestDoc={id:'pr-close',targetProjectId:project.id,approvedProjectId:project.id,requestKind:'REGISTRATION',status:'PENDING',requestVersion:1,payload:{...project}};
 let reads=0,writes=0;let release!:()=>void;let released!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;});
 const responded=new Promise<void>(resolve=>{released=resolve;});
 await page.addInitScript(()=>{localStorage.setItem('mysc-auth-user',JSON.stringify({uid:'u001',name:'QA 관리자',role:'admin',email:'qa@mysc.co.kr',source:'firebase',tenantId:'org001',idToken:'isolated-token',defaultWorkspace:'admin',lastWorkspace:'admin'}));localStorage.setItem('MYSC_ACTIVE_TENANT','org001');});
 await page.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/v1/projects')return route.fulfill({json:{items:[project]}});
  if(path==='/api/v1/project-requests/review-inbox')return route.fulfill({json:{items:[requestDoc]}});
  if(path==='/api/v1/projects/qa-close/review-document'){
   const current=++reads;if(current===2)await held;
   await route.fulfill({json:{project,request:requestDoc,reviewToken:`token-${current}`,readiness:{legacy:true,issues:[]}}});
   if(current===2)released();return;
  }
  if(path==='/api/v1/projects/qa-close/executive-review'){writes++;return route.fulfill({status:409,json:{error:'review_version_conflict',message:'문서가 변경되었습니다.'}});}
  return route.fulfill({json:{items:[]}});
 });
 await page.goto('/approvals');
 const list=page.getByTestId('migration-review-record-list');
 await list.getByRole('button',{name:'문서 열기'}).click();
 const doc=page.getByTestId('migration-review-document');
 await doc.getByRole('button',{name:'승인',exact:true}).click();
 await page.getByRole('button',{name:'승인 저장',exact:true}).click();
 await page.getByRole('button',{name:'작성한 의견을 유지하고 변경된 문서 다시 검토'}).click();
 await expect.poll(()=>reads).toBe(2);
 await page.keyboard.press('Escape');
 await expect(doc).toHaveCount(0);
 await expect(list).toBeVisible();
 release();await responded;
 await expect(doc).toHaveCount(0);
 await list.getByRole('button',{name:'문서 열기'}).click();
 await expect(doc).toBeVisible();
 await expect(doc.getByRole('button',{name:'승인',exact:true})).toBeEnabled();
 expect(reads).toBe(3);expect(writes).toBe(1);
});
