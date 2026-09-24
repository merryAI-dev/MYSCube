import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getReactPackageSet, compileReactPreview } from '../server/workbench/react-compiler.mjs';
const source = `import React,{useState} from 'react';export default function App(){const[q,setQ]=useState('');const[c,setC]=useState(false);const[s,setS]=useState('a');const[n,setN]=useState(0);const[k,setK]=useState(0);const[ime,setIme]=useState('');return <main className="p-4 bg-slate-50"><h1>사업 검색 화면</h1><form onSubmit={e=>{e.preventDefault();setN(v=>v+1)}}><label htmlFor="q">사업명</label><input id="q" required value={q} onChange={e=>setQ(e.target.value)} onCompositionStart={()=>setIme(v=>v+'S')} onCompositionEnd={()=>setIme(v=>v+'E')}/><label><input type="checkbox" checked={c} onChange={e=>setC(e.target.checked)}/>활성 사업</label><select aria-label="유형" value={s} onChange={e=>setS(e.target.value)}><option value="a">전체</option><option value="b">계약</option></select><button type="submit" onClick={()=>setK(v=>v+1)}>확인</button></form><p role="status">결과 {q}|{String(c)}|{s}|{n}|{k}|{ime}</p><table><thead><tr><th>사업</th><th>금액</th></tr></thead><tbody><tr><td>합성 사업</td><td>100</td></tr></tbody></table></main>}`;
let directory: string, packages: string;
test.beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'axr-dom-browser-'));packages=join(directory,'packages.json');await writeFile(packages,JSON.stringify(await getReactPackageSet()));});
test.afterAll(async()=>{await rm(directory,{recursive:true,force:true});});
test('actual compiled React worker → HTTP bridge → native controls/IME/validation; no Docker isolation claim', async({page})=>{
  let child: ChildProcessWithoutNullStreams | undefined, sequence=0, denied=false;
  const requests: any[]=[]; const waiting=new Map<string,{resolve:(v:any)=>void,reject:(e:Error)=>void,timer:ReturnType<typeof setTimeout>}>();
  const sessionId=randomUUID();
  const send=(message:any)=>new Promise<any>((resolve,reject)=>{const requestId=randomUUID();const timer=setTimeout(()=>reject(new Error('fixture renderer timed out')),10000);waiting.set(requestId,{resolve,reject,timer});child!.stdin.write(JSON.stringify({...message,requestId})+'\n');});
  const response=(raw:any)=>{if(raw.type==='error')throw new Error(raw.message||'renderer error');const {type,requestId,...frame}=raw;return {sessionId,frame,expiresAt:'2099-01-01T00:00:00.000Z',evidence:{}};};
  await page.route('**/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname,method=route.request().method();
    const reply=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(path.endsWith('/capabilities'))return reply({modelEnabled:false,gitEnabled:false,gitRepository:null,runtimeUrl:null,remoteRuntime:true,runtimeMode:'remote-container',example:source});
    if(path==='/api/v1/react-work-pages/remote'&&method==='POST'){
      const body=route.request().postDataJSON();expect(body.viewMode).toBe('dom');
      const artifact=await compileReactPreview(body.source);
      const worker=fileURLToPath(new URL('../server/workbench/remote-runtime/worker.mjs',import.meta.url));
      child=spawn(process.execPath,['--input-type=module','-e',`import{runRendererWorker}from${JSON.stringify(worker)};await runRendererWorker({packageFile:${JSON.stringify(packages)}})`],{stdio:['pipe','pipe','pipe']});
      createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line),pending=waiting.get(value.requestId);if(pending){waiting.delete(value.requestId);clearTimeout(pending.timer);pending.resolve(value);}});
      child.stderr.resume();
      return reply(response(await send({type:'init',viewMode:'dom',sessionId,sourceHash:artifact.sourceHash,artifact,viewport:body.viewport})));
    }
    if(path.endsWith(`/remote/${sessionId}/events`)){
      if(denied)return reply({message:'조회 권한이 변경되었습니다.'},403);
      const event=route.request().postDataJSON();requests.push(event);return reply(response(await send({type:'event',event})));
    }
    if(path.endsWith(`/remote/${sessionId}`))return method==='DELETE'?reply({closed:true}):reply(response(await send({type:'frame'})));
    return reply({items:[],truncated:false});
  });
  try{
    await page.goto('/');await page.getByRole('button',{name:'원문·파일',exact:true}).click();await expect(page.getByLabel('React 원문')).toHaveValue(source);
    await page.getByRole('button',{name:'미리보기 적용'}).click();const view=page.frameLocator('[data-testid="remote-dom-frame"]');
    await expect(view.getByRole('heading',{name:'사업 검색 화면'})).toBeVisible();await expect(view.getByRole('columnheader',{name:'금액'})).toBeVisible();
    await view.getByRole('button',{name:'확인'}).click();await expect(view.getByRole('status')).toHaveText('결과 |false|a|0|1|');await expect(view.getByLabel('사업명')).toBeFocused();
    const input=view.getByLabel('사업명');await input.fill('AB');await expect(view.getByRole('status')).toHaveText('결과 AB|false|a|0|1|');
    await view.getByLabel('활성 사업').check();await expect(view.getByRole('status')).toHaveText('결과 AB|true|a|0|1|');
    await view.getByLabel('유형').selectOption('b');await expect(view.getByRole('status')).toHaveText('결과 AB|true|b|0|1|');
    await input.focus();await input.evaluate((el:HTMLInputElement)=>{el.setSelectionRange(1,1);el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));el.value='AㅎB';el.setSelectionRange(2,2);el.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'ㅎ'}));el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'ㅎ'}));el.value='A한B';el.setSelectionRange(2,2);el.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'한'}));el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'한'}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'한'}));});
    await expect(view.getByRole('status')).toHaveText('결과 A한B|true|b|0|1|SE');await expect(input).toHaveValue('A한B');
    await input.press('Enter');await expect(view.getByRole('status')).toHaveText('결과 A한B|true|b|1|2|SE');
    expect(requests.filter(event=>event.type==='click')).toHaveLength(2);expect(requests.filter(event=>event.type==='submit')).toHaveLength(0);
    await page.screenshot({path:'/tmp/myscube-e4-native-dom-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    const resizeObservation=await view.locator('body').evaluate(element=>({browserWidth:parent.innerWidth,iframeWidth:element.ownerDocument.defaultView!.innerWidth,documentWidth:element.ownerDocument.documentElement.scrollWidth,overflow:element.ownerDocument.documentElement.scrollWidth>element.ownerDocument.defaultView!.innerWidth}));
    await writeFile('/tmp/myscube-e4-existing-session-resize.json',JSON.stringify({scope:'existing desktop session resized without creating a new preview; no responsive-equivalence claim',...resizeObservation},null,2));
    denied=true;await view.getByRole('button',{name:'확인'}).click();await expect(page.getByTestId('remote-dom-frame')).toHaveCount(0);await expect(page.getByLabel('React 원문')).toHaveValue(source);
  }finally{
    if(child&&child.exitCode===null){const closed=new Promise(resolve=>child!.once('close',resolve));child.stdin.end();const kill=setTimeout(()=>child!.kill('SIGKILL'),2000);await closed;clearTimeout(kill);}
    for(const pending of waiting.values()){clearTimeout(pending.timer);pending.reject(new Error('fixture closed'));}waiting.clear();
  }
});
