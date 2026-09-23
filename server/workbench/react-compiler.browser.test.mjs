import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compileReactPreview, getReactPackageSet } from './react-compiler.mjs';
import { createReactRuntimeDocument, reactRuntimeCsp } from './react-compiler-runtime.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
let browser; let host; let runtime; let hostOrigin; let runtimeOrigin; let hostBundle; let studioBundle; let packages; const requests = []; const runtimeDelays = [];
const code = (label) => `import React,{useState}from'react';export default function App(){const[n,setN]=useState(0);return <main className="p-4 bg-blue-50"><h1>${label}</h1><button onClick={()=>setN(n+1)}>횟수 {n}</button></main>}`;
const artifact = (source) => compileReactPreview({ title: 'React 브라우저 검증', code: source });

beforeAll(async () => {
  packages = await getReactPackageSet();
  host = createServer((req, res) => {
    if (req.url.startsWith('/attack')) { requests.push(req.url); res.setHeader('Access-Control-Allow-Origin', '*'); res.end('globalThis.externalScriptRan=true'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<!doctype html><html><body><div id="app"></div><script>${req.url === '/studio' ? studioBundle : hostBundle}</script></body></html>`);
  }); hostOrigin = await listen(host);
  runtime = createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.url === `/packages/${packages.packageSetHash}.js`) {
      res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Content-Type', 'application/javascript'); res.end(packages.bundle); return;
    }
    if (req.url.startsWith('/runtime?')) {
      const options = { nonce: randomBytes(24).toString('base64'), parentOrigin: hostOrigin, packageSetHash: packages.packageSetHash };
      res.setHeader('Content-Security-Policy', reactRuntimeCsp(options)); res.setHeader('Content-Type', 'text/html');
      const delay = runtimeDelays.shift() || 0; setTimeout(() => res.end(createReactRuntimeDocument(options)), delay); return;
    }
    res.statusCode = 404; res.end();
  }); runtimeOrigin = await listen(runtime);
  hostBundle = (await build({ stdin: { contents: `import React from 'react';import {createRoot}from'react-dom/client';import {ReactPreview}from './workbench/ReactPreview';
  function Harness(){const [value,setValue]=React.useState(null);window.setReactPreview=value=>{window.lastResult=null;setValue(value)};return <ReactPreview artifact={value?.artifact??null} runtimeUrl=${JSON.stringify(`${runtimeOrigin}/runtime`)} onResult={value=>{window.lastResult=value}} onApiCall={async(apiId,input)=>{window.apiCalls.push({apiId,input,grant:value.grant});if(window.rejectNext){window.rejectNext=false;throw Error('현재 조회 권한이 없습니다.')}return {grant:value.grant,amount:125}}}/>};window.apiCalls=[];createRoot(document.getElementById('app')).render(<Harness/>);`, loader: 'tsx', sourcefile: 'harness.tsx', resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, platform: 'browser', write: false, minify: true, define: { 'process.env.NODE_ENV': '"production"' } })).outputFiles[0].text;
  studioBundle = (await build({ stdin: { contents: "import React from 'react';import{createRoot}from'react-dom/client';import{ReactStudio}from'./workbench/ReactStudio';createRoot(document.getElementById('app')).render(<ReactStudio/>);", loader: 'tsx', sourcefile: 'studio-harness.tsx', resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, platform: 'browser', write: false, minify: true, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' } })).outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
}, 15000);
afterAll(async () => { await browser?.close(); if (host) await close(host); if (runtime) await close(runtime); });

async function open() {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.framesObserved = [];
    document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
      document.querySelectorAll('iframe').forEach((frame) => {
        if (frame.dataset.probeId) return;
        const record = { id: String(window.framesObserved.length + 1), loads: 0 };
        frame.dataset.probeId = record.id; frame.addEventListener('load', () => record.loads++); window.framesObserved.push(record);
      });
    }).observe(document.body, { subtree: true, childList: true }));
  });
  await page.goto(hostOrigin); await page.waitForFunction(() => typeof window.setReactPreview === 'function'); return page;
}
async function show(page, value, grant = 'A') { await page.evaluate(({ value, grant }) => window.setReactPreview({ artifact: value, grant }), { value, grant }); await page.waitForFunction(() => window.lastResult?.status === 'ready'); }
const committed = (page) => page.frameLocator('[data-testid="react-preview-committed"]');

describe.runIf(process.env.WORKBENCH_REACT_BROWSER_QA === '1')('real React iframe execution and bridge', () => {
  it('renders state and Tailwind, promotes the same candidate DOM once, then replaces the previous frame once', async () => {
    const page = await open(); await page.setViewportSize({ width: 390, height: 844 });
    try {
      await show(page, await artifact(code('첫 화면')));
      await committed(page).getByRole('button', { name: '횟수 0' }).click();
      await committed(page).getByRole('button', { name: '횟수 1' }).waitFor();
      expect(await committed(page).locator('main').evaluate((element) => getComputedStyle(element).padding)).toBe('16px');
      expect(await page.locator('iframe').getAttribute('data-probe-id')).toBe('1');
      await show(page, await artifact(code('다음 화면')), 'B');
      await committed(page).getByRole('heading', { name: '다음 화면' }).waitFor();
      expect(await page.locator('iframe').count()).toBe(1); expect(await page.locator('iframe').getAttribute('data-probe-id')).toBe('2');
      expect(await page.evaluate(() => window.framesObserved)).toEqual([{ id: '1', loads: 1 }, { id: '2', loads: 1 }]);
    } finally { await page.close(); }
  }, 15000);
  it('uses the captured frame grant for API results, reports errors, and permits an explicit retry', async () => {
    const page = await open();
    const source = `import React,{useState}from'react';export default function App(){const[text,setText]=useState('대기');async function load(){setText('조회 중');try{const result=await window.workbench.callApi('copied_metrics',{month:'2026-09'});setText(result.grant+':'+result.amount)}catch(error){setText(error.message)}}return <><button onClick={load}>자료 조회</button><p>{text}</p></>}`;
    try {
      const built = await artifact(source); await show(page, { ...built, executionId: 'execution-a' }, 'A');
      await committed(page).getByRole('button').click(); await committed(page).getByText('A:125', { exact: true }).waitFor();
      await page.evaluate(() => { window.rejectNext = true; });
      await committed(page).getByRole('button').click(); await committed(page).getByText('현재 조회 권한이 없습니다.', { exact: true }).waitFor();
      await committed(page).getByRole('button').click(); await committed(page).getByText('A:125', { exact: true }).waitFor();
      runtimeDelays.push(600);
      await page.evaluate((value) => window.setReactPreview({ artifact: value, grant: 'B' }), { ...built, executionId: 'execution-b' });
      await page.locator('[data-testid="react-preview-candidate"]').waitFor({ state: 'attached' });
      await committed(page).getByRole('button').click(); await committed(page).getByText('A:125', { exact: true }).waitFor();
      await page.waitForFunction(() => window.lastResult?.status === 'ready');
      await committed(page).getByRole('button').click(); await committed(page).getByText('B:125', { exact: true }).waitFor();
      expect(await page.evaluate(() => window.apiCalls.map((call) => call.grant))).toEqual(['A', 'A', 'A', 'A', 'B']);
    } finally { await page.close(); }
  }, 15000);
  it('does not promote a delayed stale candidate after a newer generation commits', async () => {
    const page = await open();
    try {
      const first = await artifact(code('첫 화면')); const stale = await artifact(code('늦은 화면')); const latest = await artifact(code('최신 화면'));
      await show(page, first); runtimeDelays.push(700);
      await page.evaluate((value) => window.setReactPreview({ artifact: value, grant: 'stale' }), stale);
      await page.waitForRequest((request) => request.url().startsWith(`${runtimeOrigin}/runtime?`));
      await show(page, latest, 'latest'); await committed(page).getByRole('heading', { name: '최신 화면' }).waitFor();
      await page.waitForTimeout(800); await committed(page).getByRole('heading', { name: '최신 화면' }).waitFor();
      expect(await page.locator('iframe').count()).toBe(1);
    } finally { runtimeDelays.length = 0; await page.close(); }
  }, 15000);
  it('retains the last good DOM and state after render, passive effect, and artifact hash failures', async () => {
    const page = await open();
    try {
      await show(page, await artifact(code('정상 화면'))); await committed(page).getByRole('button', { name: '횟수 0' }).click();
      for (const source of ["export default function App(){throw Error('render failed')}", "import{useEffect}from'react';export default function App(){useEffect(()=>{throw Error('effect failed')},[]);return <div>실패 후보</div>}"]) {
        const value = await artifact(source); await page.evaluate((value) => window.setReactPreview({ artifact: value, grant: 'failed' }), value);
        await page.waitForFunction(() => window.lastResult?.status === 'error');
        await committed(page).getByRole('button', { name: '횟수 1' }).waitFor(); expect(await page.locator('[data-testid="react-preview-committed"]').getAttribute('data-probe-id')).toBe('1');
      }
      const invalid = { ...await artifact(code('변조 화면')), bundleHash: '0'.repeat(64) };
      await page.evaluate((value) => window.setReactPreview({ artifact: value, grant: 'failed' }), invalid); await page.waitForFunction(() => window.lastResult?.status === 'error');
      expect(await page.locator('iframe').count()).toBe(1); expect((await page.evaluate(() => window.framesObserved))[0]).toEqual({ id: '1', loads: 1 });
    } finally { await page.close(); }
  }, 15000);
  it('blocks external nonce-bearing scripts, fetch, image, CSS, WebSocket and beacon through CSP', async () => {
    const page = await open(); requests.length = 0;
    try {
      const source = `export default function App(){function attack(){const target=${JSON.stringify(hostOrigin)};fetch(target+'/attack-fetch').catch(()=>{});const script=document.createElement('script');script.nonce=document.querySelector('script[nonce]').nonce;script.src=target+'/attack-script';document.head.append(script);const img=new Image();img.src=target+'/attack-image';document.body.append(img);const style=document.createElement('style');style.textContent='@import "'+target+'/attack-css";';document.head.append(style);try{new WebSocket(target.replace('http:','ws:')+'/attack-websocket')}catch{};try{navigator.sendBeacon(target+'/attack-beacon','sample')}catch{}}return <button onClick={attack}>차단 검증</button>}`;
      await show(page, await artifact(source)); await committed(page).getByRole('button').click();
      await page.waitForTimeout(500);
      expect(requests).toEqual([]);
      expect(await committed(page).locator('body').evaluate(() => globalThis.externalScriptRan || false)).toBe(false);
    } finally { await page.close(); }
  }, 15000);
  it('detects self-navigation and closes the bridge, while documenting that the navigation request itself is not prevented', async () => {
    const page = await open(); requests.length = 0;
    try {
      const source = `export default function App(){return <button onClick={()=>location.assign(${JSON.stringify(`${hostOrigin}/attack-navigation`)})}>이동 검증</button>}`;
      await show(page, await artifact(source)); await committed(page).getByRole('button').click(); await page.waitForFunction(() => window.lastResult?.status === 'error');
      expect(requests).toContain('/attack-navigation'); expect(await page.locator('[role="alert"]').textContent()).toContain('API 연결을 닫았습니다');
    } finally { await page.close(); }
  }, 15000);
  it('keeps host evidence with its committed execution through late success/error, failed candidates and a new-page reset', async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000); const errors = []; page.on('pageerror', (error) => errors.push(error.message)); let stage = 'setup';
    const source = (name) => `import React,{useState}from'react';export default function App(){const[value,setValue]=useState('대기');async function load(){try{const result=await window.workbench.callApi('metrics',{});setValue(result.label)}catch(error){setValue(error.message)}}return <><h1>${name}</h1><button onClick={load}>자료 조회</button><p>{value}</p></>}`;
    const sources = { A: source('실행 A'), B: source('실행 B'), C: source('실행 C'), failed: "export default function App(){throw Error('실패 후보입니다')}" };
    const artifacts = {};
    for (const [id, value] of Object.entries(sources)) artifacts[id] = { ...await artifact(value), executionId: id };
    const ids = { A: 'aaaaaaaa-1111-4111-8111-111111111111', B: 'bbbbbbbb-2222-4222-8222-222222222222', C: 'cccccccc-3333-4333-8333-333333333333' };
    const amounts = { A: '111', B: '222', C: '333' }; const counts = { A: 0, B: 0, C: 0 };
    const deferred = {}; const observed = {};
    const response = (id) => ({ evidenceId: ids[id], label: `조회 ${id}` });
    try {
      await page.route('**/api/v1/**', async (route) => {
        const url = new URL(route.request().url()); const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.pathname.endsWith('/capabilities')) return json({ modelEnabled: false, gitEnabled: false, runtimeUrl: `${runtimeOrigin}/runtime`, runtimeMode: 'local-test', example: sources.A });
        if (url.pathname === '/api/v1/react-work-pages' || url.pathname === '/api/v1/workbench-apis') return json({ items: [] });
        if (url.pathname.endsWith('/preview')) {
          const value = route.request().postDataJSON().source.code; const id = Object.keys(sources).find((key) => sources[key] === value); return json(artifacts[id]);
        }
        const match = url.pathname.match(/\/executions\/(A|B|C)\/call$/);
        if (match) {
          const id = match[1]; counts[id]++;
          if (counts[id] === 2) { observed[id] = true; await new Promise((resolve) => { deferred[id] = resolve; }); }
          return id === 'B' && counts[id] === 2 ? json({ message: '폐기된 B의 늦은 권한 오류' }, 403) : json(response(id));
        }
        const id = Object.keys(ids).find((key) => url.pathname.endsWith(ids[key]));
        if (id) return json({ evidenceId: ids[id], columns: [{ name: 'total_amount' }], rows: [{ total_amount: amounts[id] }], semantic: { definitionVersions: { sample: { id: 'cashflow_inflow', version: '1' } } }, metadata: { definition: '격리 QA용 응답', resultScope: '테스트 한 행', completeness: 'complete' } });
        return json({ message: 'unexpected fixture route' }, 404);
      });
      await page.goto(`${hostOrigin}/studio`);
      const apply = async (id) => { stage = `apply ${id}`; await page.getByLabel('React 원문').fill(sources[id]); await page.getByRole('button', { name: 'React 미리보기 적용', exact: true }).click(); if (id !== 'failed') await committed(page).getByRole('heading', { name: `실행 ${id}` }).waitFor(); };
      const query = async (id) => { stage = `query ${id}`; await committed(page).getByRole('button', { name: '자료 조회' }).click(); await page.getByRole('region', { name: '계산 근거', exact: true }).getByText(`${amounts[id]}원`, { exact: true }).waitFor(); };
      await apply('A'); await query('A'); await committed(page).getByRole('button').click(); await expect.poll(() => observed.A).toBe(true);
      await apply('B'); await query('B'); deferred.A(); await page.waitForTimeout(200);
      expect(await page.getByRole('region', { name: '계산 근거', exact: true }).textContent()).toContain('222원');
      expect(await page.getByRole('region', { name: '계산 근거', exact: true }).textContent()).not.toContain('111원');
      await committed(page).getByRole('button').click(); await expect.poll(() => observed.B).toBe(true);
      await apply('C'); await query('C'); deferred.B(); await page.waitForTimeout(200);
      expect(await page.getByRole('region', { name: '계산 근거', exact: true }).textContent()).toContain('333원');
      expect(await page.getByText('폐기된 B의 늦은 권한 오류', { exact: true }).count()).toBe(0);
      await committed(page).getByRole('button').click(); await expect.poll(() => observed.C).toBe(true);
      await apply('failed'); await page.getByRole('alert').filter({ hasText: '새 React 화면을 확인하지 못했습니다' }).first().waitFor();
      await committed(page).getByRole('heading', { name: '실행 C' }).waitFor(); expect(await page.getByRole('region', { name: '계산 근거', exact: true }).textContent()).toContain('333원');
      page.once('dialog', (dialog) => dialog.accept()); await page.getByRole('button', { name: '새 React 화면', exact: true }).click(); deferred.C(); await page.waitForTimeout(200);
      expect(await page.locator('iframe').count()).toBe(0); expect(await page.getByRole('region', { name: '계산 근거', exact: true }).count()).toBe(0);
    } catch (error) { throw new Error(`${stage}: ${error.message}; browser errors: ${JSON.stringify(errors)}; ${await page.locator('body').innerText().catch(() => '')}`); }
    finally { for (const release of Object.values(deferred)) release(); await page.close(); }
  }, 20000);
});
