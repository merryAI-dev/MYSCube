import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {runInNewContext} from 'node:vm';
const html=await readFile(new URL('./index.html',import.meta.url),'utf8');const code=html.slice(html.indexOf('      let latestOperations='),html.indexOf('      let opsBusy='));
const make=(tag,cls='',text='')=>({tag,textContent:String(text),children:[],append(...x){this.children.push(...x);},replaceChildren(...x){this.children=x;}});
function setup(){let at=Date.parse('2026-10-13T03:00:00Z');const nodes={};const $=key=>nodes[key]??=(make('div'));class Clock extends Date{static now(){return at;}}const render=runInNewContext(code+';renderOperations',{$,el:make,Date:Clock,structuredClone,JSON,Number});return {nodes,render,later:()=>{at+=60001;}};}
const texts=x=>[x.textContent,...x.children.flatMap(texts)].join('|');
test('served renderer shows safe counts, independent errors and aging without source content',()=>{
 const x=setup();const payload={observed_at:'2026-10-13T03:00:00Z',runs:{status:'available',read_at:'2026-10-13T03:00:00Z',counts:{running:0,completed:7,needs_review:3,failed:8}},workers:[{role:'consumer',status:'ready',valid_until:'2026-10-13T03:01:00Z',observed_at:'2026-10-13T03:00:00Z',private:'<script>private</script>',lag:{status:'caught_up',valid_until:'2026-10-13T03:01:00Z'}}]};
 x.render(payload);assert.match(texts(x.nodes['ops-workers']),/동작 확인/);assert.match(texts(x.nodes['ops-workers']),/상태 조회 불가/);assert(!texts(x.nodes['ops-workers']).includes('private'));assert.match(x.nodes['ops-count-note'].textContent,/검증 요청도 포함/);
 x.later();x.render(payload);assert.match(texts(x.nodes['ops-workers']),/최근 상태 미확인/);assert(!texts(x.nodes['ops-workers']).includes('동작 확인'));
 x.render(null);assert(!texts(x.nodes['ops-counts']).includes('|7'));assert.match(x.nodes['ops-count-note'].textContent,/0건으로 판단하지/);
});

test('DLQ delivery remains visible as review needed alongside caught-up Kafka and missing data is not zero',()=>{
 const x=setup();x.render({quarantine:{status:'available',read_at:'2026-10-13T03:00:00Z',counts:{total:2,blocked:0,dead_lettered:2,replay_authorized:0},reasons:{invalid_message:2},other:0,other_reasons:0}});
 assert.match(texts(x.nodes['ops-quarantine-counts']),/별도 보관 큐에 전달한 기록\|2/);
 assert.match(x.nodes['ops-quarantine-reasons'].textContent,/읽을 수 없는 메시지 2건/);
 assert.match(x.nodes['ops-quarantine-note'].textContent,/해결 완료가 아닙니다/);
 x.render({quarantine:{status:'available',read_at:'2026-10-13T03:00:00Z',counts:{total:1,blocked:0,dead_lettered:0,replay_authorized:0},reasons:{},other:1,other_reasons:1}});
 assert.match(x.nodes['ops-quarantine-reasons'].textContent,/미확인/);assert(!x.nodes['ops-quarantine-reasons'].textContent.includes('없습니다'));
 x.render(null);assert.match(texts(x.nodes['ops-quarantine-counts']),/—/);assert.match(x.nodes['ops-quarantine-note'].textContent,/0건으로 판단하지/);
});

test('provider card separates HTTP acceptance from answer completion and preserves stale failures',()=>{
 const x=setup(),provider={status:'observed',model:'gpt-6-sol',outcome:'accepted_http',observed_at:'2026-10-13T03:00:00Z',valid_until:'2026-10-13T03:00:30Z'};
 x.render({provider});assert.match(x.nodes['ops-provider-state'].textContent,/HTTP 요청 성공/);assert.match(x.nodes['ops-provider-note'].textContent,/답변 생성 완료를 뜻하지/);
 x.later();x.render({provider});assert.match(x.nodes['ops-provider-state'].textContent,/최근 상태 미확인/);
 x.render({provider:{...provider,outcome:'credit_exhausted'}});assert.match(x.nodes['ops-provider-state'].textContent,/잔액 부족/);
 x.render(null);assert.match(x.nodes['ops-provider-state'].textContent,/확인하지 못/);
});
