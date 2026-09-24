import { test, expect, type Page } from '@playwright/test';
const id = (value: number) => `n_${value.toString(16).padStart(24, '0')}`;
const sessionId = '11111111-1111-4111-8111-111111111111', epoch = '22222222-2222-4222-8222-222222222222';
const control = (value = '') => ({ type: 'text', value, checked: false, selectedValues: [], disabled: false, readOnly: false, selectionStart: value.length, selectionEnd: value.length });
function fixture() {
  const element = (n: number, parent: number | null, tag: string, attributes: object = {}, extra: object = {}) => ({ id: id(n), parentId: parent === null ? null : id(parent), kind: 'element', tag, attributes: { id: id(n), ...attributes }, style: {}, ...extra });
  const text = (n: number, parent: number, value: string) => ({ id: id(n), parentId: id(parent), kind: 'text', text: value });
  return { kind: 'dom', sessionId, documentEpoch: epoch, sourceHash: 'a'.repeat(64), sequence: 1, width: 640, height: 500, snapshot: { schemaVersion: 1, revision: 1, focusedNodeId: null, ack: null, rootNodeId: id(1), nodes: [element(1,null,'main'),element(2,1,'h1'),text(3,2,'현금흐름 조회'),element(4,1,'form'),element(5,4,'label',{ for: id(6) }),text(7,5,'사업 검색'),element(6,4,'input',{type:'text'}, { control: control() }),element(8,4,'button',{type:'submit'}),text(9,8,'조회'),element(10,1,'table'),element(11,10,'thead'),element(12,11,'tr'),element(13,12,'th',{scope:'col'}),text(14,13,'사업명'),element(15,10,'tbody'),element(16,15,'tr'),element(17,16,'td'),text(18,17,'합성 사업')] } };
}
async function mount(page: Page) {
  await page.route('**/dom-surface-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="fixture"></div>' }));
  await page.goto('/dom-surface-fixture');
  await page.evaluate(async initial => {
    const RefreshRuntime = await import('/@react-refresh' as string); RefreshRuntime.default.injectIntoGlobalHook(window); (window as any).$RefreshReg$=()=>{}; (window as any).$RefreshSig$=()=> (type:any)=>type;
    const main = await (await fetch('/main.tsx')).text();
    const React = (await import(main.match(/from "([^"]+\/react\.js[^"]*)"/)![1])).default, ReactDOM = (await import(main.match(/from "([^"]+\/react-dom_client\.js[^"]*)"/)![1])).default;
    const { RemoteDomSurface } = await import('/RemoteDomSurface.tsx' as string);
    const win = window as any; win.events = []; win.errors = []; win.frame = initial; win.hold = false; win.releases = [];
    const root = ReactDOM.createRoot(document.getElementById('fixture'));
    win.render = () => root.render(React.createElement(RemoteDomSurface, { frame: win.frame, disabled: win.disabled || false, suspended: win.suspended || false, onInputState: (busy:boolean) => {win.inputBusy=busy;}, onError: (error: any) => win.errors.push(error.message), onEvent: async (event: any) => {
      win.events.push(event);
      if (win.hold) await new Promise(resolve => win.releases.push(resolve));
      const next = structuredClone(win.frame); next.sequence++; next.snapshot.revision++; next.snapshot.ack = { eventId: event.eventId, ...('inputRevision' in event ? { inputRevision: event.inputRevision } : {}) };
      if (['focus', 'input'].includes(event.type)) next.snapshot.focusedNodeId=event.nodeId;
      if (event.type === 'click') next.snapshot.focusedNodeId='n_000000000000000000000006';
      if (event.type === 'input') { const node = next.snapshot.nodes.find((node: any) => node.id === event.nodeId); node.control.value = event.value.toUpperCase(); node.control.selectionStart = event.selectionStart; node.control.selectionEnd = event.selectionEnd; }
      if(win.fallback){win.fallback=false;win.suspended=true;win.render();return {kind:'png',sessionId:next.sessionId,sourceHash:next.sourceHash,documentEpoch:next.documentEpoch,sequence:next.sequence,width:next.width,height:next.height,documentRevision:next.snapshot.revision,ack:next.snapshot.ack,unsupported:[{code:'dom_style_unsupported',message:'지원하지 않는 화면 효과'}],pngBase64:'iVBORw0KGgo='};}
      win.frame = next; win.render(); return next;
    } })); win.render();
  }, fixture());
  await expect(page.frameLocator('iframe').getByRole('heading',{name:'현금흐름 조회'})).toBeVisible();
}
test('safe native DOM preserves labels, tables, text selection and keyboard button behavior without generated script', async ({page}) => {
  await mount(page); const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('columnheader',{name:'사업명'})).toBeVisible(); await expect(frame.getByLabel('사업 검색')).toBeVisible();
  await expect(page.locator('iframe')).toHaveAttribute('sandbox','allow-same-origin');
  await frame.getByLabel('사업 검색').fill('alpha'); await expect(frame.getByLabel('사업 검색')).toHaveValue('ALPHA');
  await frame.getByLabel('사업 검색').press('Tab'); await frame.getByRole('button',{name:'조회'}).press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).events.filter((event:any)=>event.type==='click').length)).toBe(1);
  expect(await page.evaluate(() => (window as any).events.filter((event:any)=>event.type==='submit').length)).toBe(0);
  const selected = await frame.getByRole('cell',{name:'합성 사업'}).evaluate(element => { const range = element.ownerDocument.createRange();range.selectNodeContents(element);const selection=element.ownerDocument.getSelection()!;selection.removeAllRanges();selection.addRange(range);return selection.toString(); }); expect(selected).toBe('합성 사업');
  const result = await page.evaluate(() => { const doc=document.querySelector('iframe')!.contentDocument!; const script=doc.createElement('script');script.textContent='parent.__injected=true';doc.body.append(script);const button=doc.createElement('button');button.setAttribute('onclick','parent.__injected=true');doc.body.append(button);button.click();return (window as any).__injected; }); expect(result).toBeUndefined();
});
test('slow ACK cannot replace newer input or middle cursor; FIFO keeps typed transitions', async ({page}) => {
  await mount(page); const input=page.frameLocator('iframe').getByLabel('사업 검색');
  await input.focus(); await expect.poll(()=>page.evaluate(()=>(window as any).events.length)).toBe(1);
  await page.evaluate(() => { (window as any).hold=true; });
  await input.fill('first'); await expect.poll(()=>page.evaluate(()=>(window as any).releases.length)).toBe(1);
  await input.fill('second'); await input.evaluate((element: HTMLInputElement)=>element.setSelectionRange(2,2));
  await page.evaluate(()=>{(window as any).releases.shift()();});
  await expect(input).toHaveValue('second'); await expect.poll(()=>input.evaluate((element:HTMLInputElement)=>element.selectionStart)).toBe(2);
  await expect.poll(()=>page.evaluate(()=>(window as any).releases.length)).toBe(1);
  await page.evaluate(()=>{(window as any).hold=false;(window as any).releases.shift()();});
  await expect(input).toHaveValue('SECOND');
  expect(await page.evaluate(()=>(window as any).events.filter((event:any)=>event.type==='input').map((event:any)=>event.value))).toEqual(['first','second']);
});
test('unsupported tags, CSS URLs and missing ARIA references are rejected before rendering', async ({page}) => {
  await mount(page);
  const rejected = await page.evaluate(async () => {
    const { RemoteDomFrameSchema } = await import((await (await fetch('/RemoteDomSurface.tsx')).text()).match(/from "([^"]+workbench-remote-dom\.mjs[^"]*)"/)![1]);const base=(window as any).frame;
    const mutations=[(v:any)=>{v.snapshot.nodes[0].tag='script';},(v:any)=>{v.snapshot.nodes[0].style={'background-image':'url(https://outside.invalid/x)'};},(v:any)=>{v.snapshot.nodes[0].attributes['aria-labelledby']='n_ffffffffffffffffffffffff';},(v:any)=>{v.snapshot.nodes[0].attributes.onclick='alert(1)';}];
    return mutations.map(change=>{const next=structuredClone(base);change(next);return !RemoteDomFrameSchema.safeParse(next).success;});
  }); expect(rejected).toEqual([true,true,true,true]);
});
test('composition cancellation and late snapshots retain the local draft until its own ACK', async ({page}) => {
  await mount(page);const input=page.frameLocator('iframe').getByLabel('사업 검색');await input.fill('AB');await expect(input).toHaveValue('AB');
  await input.evaluate((el:HTMLInputElement)=>{el.setSelectionRange(1,1);el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));el.value='AㅎB';el.setSelectionRange(2,2);el.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'ㅎ'}));el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'ㅎ'}));});
  await expect.poll(()=>page.evaluate(()=>(window as any).events.filter((e:any)=>e.type==='composition').length)).toBe(2);await expect(input).toHaveValue('AㅎB');
  await input.evaluate((el:HTMLInputElement)=>{el.value='AB';el.setSelectionRange(1,1);el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}));});
  await expect.poll(()=>page.evaluate(()=>(window as any).events.filter((e:any)=>e.phase==='cancel').length)).toBe(1);await expect(input).toHaveValue('AB');
  expect(await page.evaluate(()=>(window as any).errors)).toEqual([]);
});
test('removed focused controls restore focus deterministically without guessing missing references', async ({page}) => {
  await mount(page);const frame=page.frameLocator('iframe');await frame.getByLabel('사업 검색').focus();
  await expect.poll(()=>page.evaluate(()=>(window as any).events.length)).toBe(1);
  await page.evaluate(()=>{const win=window as any,next=structuredClone(win.frame);next.sequence++;next.snapshot.revision++;next.snapshot.nodes=next.snapshot.nodes.filter((node:any)=>![`n_${(5).toString(16).padStart(24,'0')}`,`n_${(6).toString(16).padStart(24,'0')}`,`n_${(7).toString(16).padStart(24,'0')}`].includes(node.id));next.snapshot.ack=null;next.snapshot.focusedNodeId=null;win.frame=next;win.render();});
  await expect(frame.getByRole('main')).toBeFocused();await expect(page.getByRole('status')).toContainText('화면의 시작');
});
test('input queue overflow is explicit and preserves unsent text instead of silent dropping', async ({page}) => {
  await mount(page);const input=page.frameLocator('iframe').getByLabel('사업 검색');await input.focus();await expect.poll(()=>page.evaluate(()=>(window as any).events.length)).toBe(1);await page.evaluate(()=>{(window as any).hold=true;});
  await input.evaluate((el:HTMLInputElement)=>{for(let i=1;i<=35;i++){el.value=String(i);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:String(i)}));}});
  await expect(page.getByRole('status')).toContainText('반영되었는지 확인하지 못했습니다');await expect(input).toHaveValue('35');expect(await page.evaluate(()=>(window as any).errors.length)).toBe(1);
});

test('an older remote focus ACK cannot steal newer local focus or active composition', async({page})=>{
  await mount(page);const frame=page.frameLocator('iframe'),input=frame.getByLabel('사업 검색'),button=frame.getByRole('button',{name:'조회'});
  await input.focus();await expect.poll(()=>page.evaluate(()=>(window as any).events.length)).toBe(1);await page.evaluate(()=>{(window as any).hold=true;});
  await input.fill('pending');await expect.poll(()=>page.evaluate(()=>(window as any).releases.length)).toBe(1);await button.focus();await page.evaluate(()=>{(window as any).releases.shift()();});await expect(button).toBeFocused();
  await expect.poll(()=>page.evaluate(()=>(window as any).releases.length)).toBe(1);await page.evaluate(()=>{(window as any).hold=false;(window as any).releases.shift()();});await expect(button).toBeFocused();
  await input.focus();await input.evaluate((el:HTMLInputElement)=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));el.value='조합';el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'조합'}));});
  await page.evaluate(()=>{const win=window as any,next=structuredClone(win.frame);next.snapshot.revision++;next.sequence++;next.snapshot.focusedNodeId='n_000000000000000000000008';next.snapshot.ack=null;win.frame=next;win.render();});
  await expect(input).toBeFocused();await expect(input).toHaveValue('조합');
});

test('fallback retains unsent input and refuses to transplant it when its original node disappears',async({page})=>{
  await mount(page);const input=page.frameLocator('iframe').getByLabel('사업 검색');await input.focus();await expect.poll(()=>page.evaluate(()=>(window as any).events.length)).toBe(1);
  await page.evaluate(()=>{const w=window as any;w.hold=true;w.fallback=true;});await input.fill('first');await expect.poll(()=>page.evaluate(()=>(window as any).releases.length)).toBe(1);await input.fill('unsent draft');
  await page.evaluate(()=>{const w=window as any;w.hold=false;w.releases.shift()();});await expect(page.getByRole('status')).toContainText('대기 중인 입력을 보존');await expect(input).toHaveValue('unsent draft');
  expect(await page.evaluate(()=>(window as any).events.filter((e:any)=>e.type==='input').map((e:any)=>e.value))).toEqual(['first']);expect(await page.evaluate(()=>(window as any).inputBusy)).toBe(false);
  await page.evaluate(()=>{const w=window as any,next=structuredClone(w.frame);next.sequence+=2;next.snapshot.revision+=2;next.snapshot.ack=null;next.snapshot.focusedNodeId=null;next.snapshot.nodes=next.snapshot.nodes.filter((n:any)=>!['n_000000000000000000000005','n_000000000000000000000006','n_000000000000000000000007'].includes(n.id));w.frame=next;w.suspended=false;w.render();});
  await expect(page.getByRole('status')).toContainText('입력하던 요소가 사라졌습니다');await expect(input).toHaveValue('unsent draft');expect(await page.evaluate(()=>(window as any).events.filter((e:any)=>e.type==='input').length)).toBe(1);
});
test('poll fallback during composition preserves visible draft and explicitly blocks resize until a safe recovery',async({page})=>{
  await mount(page);const input=page.frameLocator('iframe').getByLabel('사업 검색');await input.fill('AB');await expect(input).toHaveValue('AB');
  await input.evaluate((el:HTMLInputElement)=>{el.setSelectionRange(1,1);el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));el.value='AㅎB';el.setSelectionRange(2,2);el.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'ㅎ'}));el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'ㅎ'}));});
  await expect.poll(()=>page.evaluate(()=>(window as any).events.filter((e:any)=>e.type==='composition').length)).toBe(2);
  await page.evaluate(()=>{const w=window as any;w.suspended=true;w.render();});await expect(page.getByRole('status')).toContainText('크기 변경으로 자동 복귀하지 않습니다');await expect(input).toBeVisible();await expect(input).toHaveValue('AㅎB');expect(await page.evaluate(()=>(window as any).inputBusy)).toBe(true);
});

test('resize completion resumes retained FIFO inputs immediately without waiting for polling',async({page})=>{
  await mount(page);const input=page.frameLocator('iframe').getByLabel('사업 검색');await input.focus();await expect.poll(()=>page.evaluate(()=>(window as any).events.length)).toBe(1);
  await page.evaluate(()=>{const w=window as any;w.hold=true;w.fallback=true;});await input.fill('first');await expect.poll(()=>page.evaluate(()=>(window as any).releases.length)).toBe(1);await input.fill('queued');await page.evaluate(()=>{const w=window as any;w.hold=false;w.releases.shift()();});await expect(page.getByRole('status')).toContainText('대기 중인 입력을 보존');
  await page.evaluate(()=>{const w=window as any,next=structuredClone(w.frame);next.sequence+=2;next.snapshot.revision+=2;next.snapshot.ack=null;w.frame=next;w.disabled=true;w.suspended=false;w.render();});
  expect(await page.evaluate(()=>(window as any).events.filter((e:any)=>e.type==='input').length)).toBe(1);
  await page.evaluate(()=>{const w=window as any;w.disabled=false;w.render();});await expect(input).toHaveValue('QUEUED');expect(await page.evaluate(()=>(window as any).events.filter((e:any)=>e.type==='input').map((e:any)=>e.value))).toEqual(['first','queued']);
});
