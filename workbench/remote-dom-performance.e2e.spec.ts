import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getReactPackageSet, compileReactPreview } from '../server/workbench/react-compiler.mjs';
import { remoteDomBenchmarkWorkspaces } from './remote-dom-benchmark-fixtures.mjs';

test('local compile/worker/CDP/native-DOM benchmark: 20 cold, 20 update, 20 input; three real workspaces', async ({page}) => {
  test.setTimeout(240000);
  const directory=await mkdtemp(join(tmpdir(),'axr-dom-performance-')), packages=join(directory,'packages.json');
  await writeFile(packages,JSON.stringify(await getReactPackageSet()));
  const sessions=new Map<string,{child:ChildProcessWithoutNullStreams,send:(value:any)=>Promise<any>,close:()=>Promise<void>}>();
  const cold:number[]=[],update:number[]=[],input:number[]=[]; const nodeCounts:number[]=[], routes:number[]=[]; let failures:string[]=[];let cancelledRetiredRequests=0;
  async function createSession(body:any){
    const artifact=await compileReactPreview(body.source),sessionId=randomUUID();
    const worker=fileURLToPath(new URL('../server/workbench/remote-runtime/worker.mjs',import.meta.url));
    const child=spawn(process.execPath,['--input-type=module','-e',`import{runRendererWorker}from${JSON.stringify(worker)};await runRendererWorker({packageFile:${JSON.stringify(packages)}})`],{stdio:['pipe','pipe','pipe']});child.stderr.resume();
    const waits=new Map<string,{resolve:(value:any)=>void,reject:(reason:Error)=>void,timer:ReturnType<typeof setTimeout>}>();
    createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line),wait=waits.get(value.requestId);if(wait){waits.delete(value.requestId);clearTimeout(wait.timer);wait.resolve(value);}});
    const send=(body:any)=>new Promise<any>((resolve,reject)=>{const requestId=randomUUID(),timer=setTimeout(()=>{waits.delete(requestId);reject(new Error('local renderer deadline'));},12000);waits.set(requestId,{resolve,reject,timer});child.stdin.write(JSON.stringify({...body,requestId})+'\n');});
    const close=async()=>{if(child.exitCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.stdin.end();const timer=setTimeout(()=>child.kill('SIGKILL'),2000);await closed;clearTimeout(timer);}for(const value of waits.values()){clearTimeout(value.timer);value.reject(Object.assign(new Error('benchmark session closed'),{code:'fixture_session_closed'}));}waits.clear();};
    sessions.set(sessionId,{child,send,close});
    const frame=await send({type:'init',viewMode:'dom',sessionId,sourceHash:artifact.sourceHash,artifact,viewport:body.viewport});return {sessionId,frame};
  }
  function normalize(sessionId:string,value:any){if(value.type==='error')throw new Error(value.message||'worker rejected');const {type,requestId,...frame}=value;if(frame.kind!=='dom')throw new Error(`Unsupported benchmark fixture: ${JSON.stringify(frame.unsupported)}`);nodeCounts.push(frame.snapshot.nodes.length);return{sessionId,frame,expiresAt:'2099-01-01T00:00:00.000Z',evidence:{}};}
  await page.route('**/api/v1/react-work-pages/remote**',async route=>{
    const start=performance.now(),path=new URL(route.request().url()).pathname,method=route.request().method();
    try{let value:any;
      if(path==='/api/v1/react-work-pages/remote'&&method==='POST'){const created=await createSession(route.request().postDataJSON());value=normalize(created.sessionId,created.frame);}
      else{const id=path.split('/')[5],session=sessions.get(id);if(!session)throw new Error('benchmark session missing');if(method==='DELETE'){await session.close();sessions.delete(id);value={closed:true};}else value=normalize(id,await session.send(path.endsWith('/events')?{type:'event',event:route.request().postDataJSON()}:{type:'frame'}));}
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});routes.push(performance.now()-start);
    }catch(error){if((error as any)?.code==='fixture_session_closed'){cancelledRetiredRequests++;await route.fulfill({status:410,contentType:'application/json',body:JSON.stringify({message:'이전 실행 세션이 종료되었습니다.'})});return;}failures.push(error instanceof Error?error.message:'unknown');await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'벤치마크 실행에 실패했습니다.'})});}
  });
  await page.route('**/performance-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><link rel="stylesheet" href="/studio.css"><main id="fixture" style="max-width:1100px;margin:auto"></main>'}));
  try{
    await page.goto('/performance-fixture');await page.evaluate(async()=>{
      const refresh=await import('/@react-refresh' as string);refresh.default.injectIntoGlobalHook(window);(window as any).$RefreshReg$=()=>{};(window as any).$RefreshSig$=()=>(type:any)=>type;
      const main=await(await fetch('/main.tsx')).text(),React=(await import(main.match(/from "([^"]+\/react\.js[^"]*)"/)![1])).default,ReactDOM=(await import(main.match(/from "([^"]+\/react-dom_client\.js[^"]*)"/)![1])).default;
      const {RemoteReactPreview}=await import('/RemoteReactPreview.tsx' as string);const win=window as any;win.longtasks=[];win.benchmarkErrors=[];new PerformanceObserver(list=>win.longtasks.push(...list.getEntries().map(item=>({start:item.startTime,duration:item.duration})))).observe({type:'longtask',buffered:true});
      const root=ReactDOM.createRoot(document.getElementById('fixture'));win.start=(source:any,key:number)=>{win.started=performance.now();root.render(React.createElement(RemoteReactPreview,{draft:{source,apis:[],key},onResult:(result:any)=>{if(result.status==='error')win.benchmarkErrors.push(result.message);}}));};
      win.elapsed=()=>performance.now()-win.started;
    });
    for(let index=0;index<20;index++){
      const workspace=remoteDomBenchmarkWorkspaces[index%3];await page.evaluate(({workspace,index})=>(window as any).start(workspace,index+1),{workspace,index});
      const heading=['사업 입금 현황','업무 요청서','팀 업무 현황'][index%3];await expect(page.frameLocator('[data-testid="remote-dom-frame"]').getByRole('heading',{name:heading,exact:true})).toBeVisible();
      cold.push(await page.evaluate(()=>(window as any).elapsed()));
      if(index<3){expect(await page.frameLocator('[data-testid="remote-dom-frame"]').locator('body').evaluate(element=>element.ownerDocument.documentElement.scrollWidth<=element.ownerDocument.defaultView!.innerWidth)).toBe(true);await page.getByTestId('remote-dom-frame').screenshot({path:`/tmp/myscube-e4-workspace-${index+1}.png`});}
    }
    const frame=page.frameLocator('[data-testid="remote-dom-frame"]'),status=frame.getByRole('status');
    for(let index=1;index<=20;index++){await page.evaluate(()=>(window as any).started=performance.now());await frame.getByRole('button',{name:'새로 계산'}).click();await expect(status).toHaveText(`${index}|`);update.push(await page.evaluate(()=>(window as any).elapsed()));}
    for(let index=1;index<=20;index++){await page.evaluate(()=>(window as any).started=performance.now());await frame.getByLabel('벤치마크 입력').fill(`sample${index}`);await expect(status).toHaveText(`20|sample${index}`);input.push(await page.evaluate(()=>(window as any).elapsed()));}
    await page.setViewportSize({width:390,height:844});await page.locator('#fixture').evaluate(element=>{element.style.width='100%';});
    for(let index=0;index<3;index++){const workspace=remoteDomBenchmarkWorkspaces[index];await page.evaluate(({workspace,index})=>(window as any).start(workspace,100+index),{workspace,index});await expect(page.frameLocator('[data-testid="remote-dom-frame"]').getByRole('heading',{name:['사업 입금 현황','업무 요청서','팀 업무 현황'][index],exact:true})).toBeVisible();expect(await page.frameLocator('[data-testid="remote-dom-frame"]').locator('body').evaluate(element=>element.ownerDocument.documentElement.scrollWidth<=element.ownerDocument.defaultView!.innerWidth)).toBe(true);await page.getByTestId('remote-dom-frame').screenshot({path:`/tmp/myscube-e4-workspace-${index+1}-mobile.png`});}
    const observations=await page.evaluate(()=>({longtasks:(window as any).longtasks,errors:(window as any).benchmarkErrors,userAgent:navigator.userAgent}));
    const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return{count:values.length,p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1),samples:values};};
    const report={scope:'localhost real compiler + fresh Node renderer/Chromium CDP + trusted browser/native DOM; no Docker, production network, OS IME or screen-reader claim',cache:'browser app/modules and fixed React packages are warm; every cold sample creates a fresh renderer process/session',recordedAt:new Date().toISOString(),thresholdsMs:{cold:3000,update:1000,input:500},cold:stats(cold),update:stats(update),input:stats(input),route:stats(routes),maximumObservedNodes:Math.max(...nodeCounts),...observations,failures,cancelledRetiredRequests};
    await writeFile('/tmp/myscube-e4-local-performance.json',JSON.stringify(report,null,2));
    expect(failures).toEqual([]);expect(observations.errors).toEqual([]);expect(report.cold.p95).toBeLessThanOrEqual(3000);expect(report.update.p95).toBeLessThanOrEqual(1000);expect(report.input.p95).toBeLessThanOrEqual(500);
  }finally{await page.unrouteAll({behavior:'wait'});await Promise.all([...sessions.values()].map(value=>value.close()));await rm(directory,{recursive:true,force:true});}
});

test('maximum allowed node count: trusted DOM layout and long-task observation (synthetic snapshot, not remote throughput)', async({page})=>{
  await page.route('**/maximum-dom-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="fixture" style="width:1100px"></div>'}));await page.goto('/maximum-dom-fixture');
  const result=await page.evaluate(async()=>{
    const refresh=await import('/@react-refresh' as string);refresh.default.injectIntoGlobalHook(window);(window as any).$RefreshReg$=()=>{};(window as any).$RefreshSig$=()=>(type:any)=>type;
    const main=await(await fetch('/main.tsx')).text(),React=(await import(main.match(/from "([^"]+\/react\.js[^"]*)"/)![1])).default,ReactDOM=(await import(main.match(/from "([^"]+\/react-dom_client\.js[^"]*)"/)![1])).default;
    const {RemoteDomSurface}=await import('/RemoteDomSurface.tsx' as string);
    const schemaPath=(await(await fetch('/RemoteDomSurface.tsx')).text()).match(/from "([^"]+workbench-remote-dom\.mjs[^"]*)"/)![1];const {RemoteDomFrameSchema,REMOTE_DOM_LIMITS}=await import(schemaPath);
    const id=(value:number)=>`n_${value.toString(16).padStart(24,'0')}`;const nodes:any[]=[{id:id(1),parentId:null,kind:'element',tag:'main',attributes:{id:id(1)},style:{'font-size':'14px','line-height':'20px'}}];
    for(let index=2;index<=REMOTE_DOM_LIMITS.nodes;index++){if(index%2===0)nodes.push({id:id(index),parentId:id(1),kind:'element',tag:'span',attributes:{id:id(index)},style:{display:'inline-block',width:'64px',height:'20px','background-color':'rgb(241, 245, 249)'}});else nodes.push({id:id(index),parentId:id(index-1),kind:'text',text:`값${index}`});}
    let frame:any={kind:'dom',sessionId:'11111111-1111-4111-8111-111111111111',documentEpoch:'22222222-2222-4222-8222-222222222222',sourceHash:'a'.repeat(64),sequence:1,width:1100,height:700,snapshot:{schemaVersion:1,revision:1,rootNodeId:id(1),focusedNodeId:null,ack:null,nodes}};RemoteDomFrameSchema.parse(frame);
    const observerEntries:any[]=[];const observer=new PerformanceObserver(list=>observerEntries.push(...list.getEntries().map(item=>({start:item.startTime,duration:item.duration}))));observer.observe({type:'longtask',buffered:false});
    const root=ReactDOM.createRoot(document.getElementById('fixture'));const render=()=>root.render(React.createElement(RemoteDomSurface,{frame,onEvent:async()=>frame}));
    const wait=async(text:string)=>{const deadline=performance.now()+10000;while(performance.now()<deadline){const doc=document.querySelector('iframe')?.contentDocument;if(doc?.body?.textContent?.startsWith(text)){await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));return;}await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));}throw new Error('maximum DOM did not render');};
    const start=performance.now();render();await wait('값3');const initialMs=performance.now()-start,samples:number[]=[];
    for(let index=1;index<=20;index++){frame=structuredClone(frame);frame.sequence++;frame.snapshot.revision++;for(const node of frame.snapshot.nodes)if(node.kind==='text')node.text=`${index}:${node.id}`;const before=performance.now();render();await wait(`${index}:`);samples.push(performance.now()-before);}
    await new Promise(resolve=>setTimeout(resolve,100));observer.disconnect();
    const invalid=structuredClone(frame);invalid.snapshot.nodes.push({id:id(REMOTE_DOM_LIMITS.nodes+1),parentId:id(1),kind:'text',text:'초과'});
    return{scope:'synthetic validated snapshot at maximum node count; UI renderer only, not worker/network measurement',nodes:nodes.length,limit:REMOTE_DOM_LIMITS.nodes,initialMs,updateSamplesMs:samples,updateP95Ms:[...samples].sort((a,b)=>a-b)[18],longtasks:observerEntries,overLimitRejected:!RemoteDomFrameSchema.safeParse(invalid).success};
  });await writeFile('/tmp/myscube-e4-maximum-dom.json',JSON.stringify(result,null,2));await page.screenshot({path:'/tmp/myscube-e4-maximum-dom.png'});expect(result.nodes).toBe(result.limit);expect(result.overLimitRejected).toBe(true);
});
