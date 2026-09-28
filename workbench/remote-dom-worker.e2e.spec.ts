import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRemoteRuntimeBroker } from '../server/workbench/remote-runtime/broker.mjs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getReactPackageSet, compileReactPreview } from '../server/workbench/react-compiler.mjs';
const source = `import React,{useState} from 'react';export default function App(){const[q,setQ]=useState('');const[c,setC]=useState(false);const[s,setS]=useState('a');const[n,setN]=useState(0);const[k,setK]=useState(0);const[ime,setIme]=useState('');return <main className={q==='pause'?'p-4 bg-slate-50 max-[500px]:rotate-3':'p-4 bg-slate-50 max-[360px]:rotate-3'}><h1>사업 검색 화면</h1><form onSubmit={e=>{e.preventDefault();setN(v=>v+1)}}><label htmlFor="q">사업명</label><input id="q" required value={q} onChange={e=>setQ(e.target.value)} onCompositionStart={()=>setIme(v=>v+'S')} onCompositionEnd={()=>setIme(v=>v+'E')}/><label><input type="checkbox" checked={c} onChange={e=>setC(e.target.checked)}/>활성 사업</label><select aria-label="유형" value={s} onChange={e=>setS(e.target.value)}><option value="a">전체</option><option value="b">계약</option></select><button type="submit" onClick={()=>setK(v=>v+1)}>확인</button></form><p role="status">결과 {q}|{String(c)}|{s}|{n}|{k}|{ime}</p><table><thead><tr><th>사업</th><th>금액</th></tr></thead><tbody><tr><td>합성 사업</td><td>100</td></tr></tbody></table></main>}`;
let directory: string, packages: string;
test.beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'axr-dom-browser-'));packages=join(directory,'packages.json');await writeFile(packages,JSON.stringify(await getReactPackageSet()));});
test.afterAll(async()=>{await rm(directory,{recursive:true,force:true});});
test('actual compiled React worker → HTTP bridge → native controls/IME/validation; no Docker isolation claim', async({page})=>{
  const children: ChildProcessWithoutNullStreams[]=[];let denied=false;
  let holdInputAck: Promise<void> | null = null;
  const requests: any[]=[];let sessionId='';
  const context={tenantId:'synthetic',actorId:'browser-fixture',analyticsScope:{fingerprint:'fixture'}};
  const worker=fileURLToPath(new URL('../server/workbench/remote-runtime/worker.mjs',import.meta.url));
  const broker=createRemoteRuntimeBroker({authorize:async()=>{if(denied)throw Object.assign(new Error('조회 권한이 변경되었습니다.'),{statusCode:403});},callApi:async()=>({}),spawnDocker:(args:string[])=>{
    const child=args[0]==='run'?spawn(process.execPath,['--input-type=module','-e',`import{runRendererWorker}from${JSON.stringify(worker)};await runRendererWorker({packageFile:${JSON.stringify(packages)}})`],{stdio:['pipe','pipe','pipe']}):spawn(process.execPath,['-e',''],{stdio:['pipe','pipe','pipe']});children.push(child);return child;
  }});
  await page.route('**/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname,method=route.request().method();
    const reply=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(path.endsWith('/capabilities'))return reply({modelEnabled:false,gitEnabled:false,gitRepository:null,runtimeUrl:null,remoteRuntime:true,runtimeMode:'remote-container',example:source});
    if(path==='/api/v1/react-work-pages/remote'&&method==='POST'){
      const body=route.request().postDataJSON();expect(body.viewMode).toBe('dom');
      const artifact=await compileReactPreview(body.source);
      const result=await broker.create(context,{artifact,sourceHash:artifact.sourceHash,apiBindings:[],viewMode:'dom',viewport:body.viewport});sessionId=result.sessionId;return reply({...result,evidence:{}});
    }
    if(path.endsWith(`/remote/${sessionId}/events`)){
      if(denied)return reply({message:'조회 권한이 변경되었습니다.'},403);
      const event=route.request().postDataJSON();requests.push(event);const result={sessionId,frame:await broker.event(context,sessionId,event),expiresAt:'2099-01-01T00:00:00.000Z',evidence:{}};if(event.type==='input'&&holdInputAck)await holdInputAck;return reply(result);
    }
    if(path.endsWith(`/remote/${sessionId}`))return method==='DELETE'?reply(await broker.close(context,sessionId).catch(()=>({closed:true}))):reply({sessionId,frame:await broker.frame(context,sessionId),expiresAt:'2099-01-01T00:00:00.000Z',evidence:{}});
    return reply({items:[],truncated:false});
  });
  try{
    await page.goto('/');await page.getByRole('button',{name:'원문·파일',exact:true}).click();await expect(page.getByLabel('React 원문')).toHaveValue(source);
    await page.getByRole('button',{name:'미리보기 적용'}).click();const view=page.frameLocator('[data-testid="remote-dom-frame"]');
    await expect(view.getByRole('heading',{name:'사업 검색 화면'})).toBeVisible();await expect(view.getByRole('columnheader',{name:'금액'})).toBeVisible();
    await view.getByRole('button',{name:'확인'}).click();await expect(view.getByRole('status')).toHaveText('결과 |false|a|0|1|');await expect(view.getByLabel('사업명')).toBeFocused();
    const input=view.getByLabel('사업명');let releaseInput!:()=>void;holdInputAck=new Promise<void>(resolve=>{releaseInput=resolve;});await input.fill('AB');await expect.poll(()=>requests.some(v=>v.type==='input')).toBe(true);await page.setViewportSize({width:500,height:844});await page.waitForTimeout(350);expect(requests.filter(v=>v.type==='resize')).toHaveLength(0);await expect(input).toHaveValue('AB');releaseInput();holdInputAck=null;await expect(view.getByRole('status')).toHaveText('결과 AB|false|a|0|1|');await expect.poll(()=>requests.filter(v=>v.type==='resize').length).toBe(1);await expect.poll(()=>view.locator('main').evaluate(el=>Math.round(el.getBoundingClientRect().width))).toBe(requests.find(v=>v.type==='resize').width);await page.setViewportSize({width:1280,height:900});await expect.poll(()=>requests.filter(v=>v.type==='resize').length).toBe(2);await expect(input).toHaveValue('AB');
    await view.getByLabel('활성 사업').check();await expect(view.getByRole('status')).toHaveText('결과 AB|true|a|0|1|');
    await view.getByLabel('유형').selectOption('b');await expect(view.getByRole('status')).toHaveText('결과 AB|true|b|0|1|');
    await input.focus();await input.evaluate((el:HTMLInputElement)=>{el.setSelectionRange(1,1);el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));el.value='AㅎB';el.setSelectionRange(2,2);el.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'ㅎ'}));el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'ㅎ'}));});const beforeImeResize=requests.filter(v=>v.type==='resize').length;await page.setViewportSize({width:600,height:844});await page.waitForTimeout(350);expect(requests.filter(v=>v.type==='resize')).toHaveLength(beforeImeResize);await input.evaluate((el:HTMLInputElement)=>{el.value='A한B';el.setSelectionRange(2,2);el.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'한'}));el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'한'}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'한'}));});
    await expect(view.getByRole('status')).toHaveText('결과 A한B|true|b|0|1|SE');await expect(input).toHaveValue('A한B');await expect.poll(()=>requests.filter(v=>v.type==='resize').length).toBe(beforeImeResize+1);await expect(page.getByText('입력 상태를 유지하며 화면 크기를 맞추고 있습니다.',{exact:true})).toHaveCount(0);
    await input.press('Enter');await expect(view.getByRole('status')).toHaveText('결과 A한B|true|b|1|2|SE');
    expect(requests.filter(event=>event.type==='click')).toHaveLength(2);expect(requests.filter(event=>event.type==='submit')).toHaveLength(0);
    await page.screenshot({path:'/tmp/myscube-e4-native-dom-desktop.png',fullPage:true});
    await page.setViewportSize({width:430,height:844});
    await expect.poll(()=>view.locator('body').evaluate(element=>element.ownerDocument.documentElement.scrollWidth<=element.ownerDocument.defaultView!.innerWidth)).toBe(true);
    await expect(input).toHaveValue('A한B');await expect(view.getByRole('status')).toHaveText('결과 A한B|true|b|1|2|SE');
    const resizeEvents=requests.filter(v=>v.type==='resize');expect(resizeEvents.length).toBeGreaterThanOrEqual(3);expect(new Set(resizeEvents.map(v=>v.sessionId)).size).toBe(1);expect(new Set(resizeEvents.map(v=>v.documentEpoch)).size).toBe(1);
    await writeFile('/tmp/myscube-e4-existing-session-resize.json',JSON.stringify({scope:'same React session desktop/mobile resize with input ACK preservation; local worker not Docker',sessionId,resizeCount:resizeEvents.length,state:'A한B|true|b|1|2|SE',overflow:false},null,2));
    await page.setViewportSize({width:390,height:844});await expect(page.getByTestId('remote-react-frame')).toBeVisible();await expect(page.getByTestId('remote-dom-frame')).toBeVisible();
    const fallbackCount=requests.length;await page.getByTestId('remote-react-frame').click();expect(requests.length).toBe(fallbackCount);
    await page.setViewportSize({width:1280,height:900});await expect(view.getByRole('status')).toHaveText('결과 A한B|true|b|1|2|SE');await expect(view.getByLabel('사업명')).toHaveValue('A한B');
    await page.setViewportSize({width:500,height:844});await expect.poll(()=>view.locator('main').evaluate(el=>Math.round(el.getBoundingClientRect().width))).toBe(442);
    holdInputAck=new Promise<void>(resolve=>{releaseInput=resolve;});await input.fill('pause');await expect.poll(()=>requests.some(v=>v.type==='input'&&v.value==='pause')).toBe(true);await input.fill('resumed');releaseInput();holdInputAck=null;await expect(page.getByTestId('remote-react-frame')).toBeVisible();await expect(input).toHaveValue('resumed');expect(requests.some(v=>v.type==='input'&&v.value==='resumed')).toBe(false);
    await page.setViewportSize({width:1280,height:900});await expect(view.getByRole('status')).toHaveText('결과 resumed|true|b|1|2|SE');await expect(input).toHaveValue('resumed');
    denied=true;await view.getByRole('button',{name:'확인'}).click();await expect(page.getByTestId('remote-dom-frame')).toHaveCount(0);await expect(page.getByLabel('React 원문')).toHaveValue(source);
  }finally{
    broker.shutdown();await Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():new Promise<void>(resolve=>{child.once('close',()=>resolve());setTimeout(()=>{child.kill('SIGKILL');resolve();},2000).unref();})));
  }
});
