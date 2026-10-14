import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const between = (start, end) => {
  const first = html.indexOf(start), last = html.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return html.slice(first, last);
};

class Node {
  constructor(tag, cls = '', value = '') {
    this.tagName = tag.toUpperCase();
    this.className = cls;
    this.textContent = String(value);
    this.children = [];
    this.dataset = {};
    this.parentElement = null;
    this.listeners = new Map();
  }
  get classList() { return { contains: (name) => this.className.split(/\s+/).includes(name) }; }
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
    this.parentElement = null;
  }
  querySelector(selector) {
    const cls = selector.startsWith('.') ? selector.slice(1) : null;
    for (const child of this.children) {
      if (cls && child.classList.contains(cls)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  get isConnected() { return !!this.parentElement; }
  setAttribute(name, value) { this[name] = value; }
  reportValidity() { return true; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
}

const caseId = 'd70a4b7f-b461-4f4e-82fe-10f142929584';
const item = (execution_status) => ({ case_id: caseId, title: '로그인 흐름',
  case_status: 'received', execution_status, updated_at: '2026-10-13T00:00:00Z' });
function harness(request) {
  const elements = { 'my-cases': new Node('div'), 'own-flow-summary': new Node('p'),
    'case-message': new Node('p'), ...Object.fromEntries(['shared-refresh','shared-next','shared-cases','shared-time','assignment-refresh','assignment-next','assignment-inbox'].map(id=>[id,new Node('div')])) };
  const state = {
    crypto: { randomUUID }, document: { hidden:false, createTextNode: value=>new Node('text','',value) }, setInterval: () => {}, qaAuth: { currentUser: { uid: 'owner' } }, linked: true,
    caseItems: [], caseNextCursor: null, caseListExpanded: false,
    caseSessionVersion: 1, caseRefreshPromise: null,
    caseLastCheckedAt: null, caseRefreshFailed: false,
    caseIdPattern: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
    caseStatusLabels: { received: '접수됨', dispatch_pending: '조사 준비 중', running: '조사 중' },
    entryRequest: request, entryMessage: (id, message) => { elements[id].textContent = message; },
    friendlyError: (error) => error.message,
    $: (id) => elements[id], el: (tag, cls, value) => new Node(tag, cls, value),
    format: () => '10. 13. 오전 9:00', renderOwnCaseAnswer: () => {},
  };
  const source = between('      function mergeCasePage(', '      $("qa-sign-in").addEventListener(');
  runInNewContext(`${source}\nglobalThis.actions={refreshCases,clearLinkedCases,renderCases,refreshSharedCases,renderSharedCases,refreshAssignments};`, state);
  return { state, elements, ...state.actions };
}

test('owner refresh promotes only server-read running state and preserves opened row content', async () => {
  let status = 'dispatch_pending';
  const h = harness(async () => ({ items: [item(status)], next_cursor: null }));
  await h.refreshCases();
  const row = h.elements['my-cases'].children[0];
  const result = row.querySelector('.own-result');
  const draft = new Node('input');
  draft.value = '입력 중인 이유';
  result.hidden = false;
  result.append(draft);
  assert.match(row.querySelector('.own-case-status').textContent, /조사 준비 중/);

  status = 'running';
  await h.refreshCases({ automatic: true });
  assert.equal(h.elements['my-cases'].children[0], row);
  assert.equal(row.querySelector('.own-result'), result);
  assert.equal(result.children[0], draft);
  assert.equal(draft.value, '입력 중인 이유');
  assert.match(row.querySelector('.own-case-status').textContent, /조사 중/);
  assert.match(h.elements['own-flow-summary'].textContent, /조사 중 1건/);
});

test('owner row shows only allowlisted running session stage and counts', async () => {
  let current = { ...item('running'), progress: { stage: 'code', session_count: 2, evidence_count: 3 } };
  const h = harness(async () => ({ items: [current], next_cursor: null }));
  await h.refreshCases();
  const row = h.elements['my-cases'].children[0];
  assert.match(row.querySelector('.own-case-status').textContent,
    /코드 확인 · 작업 세션 2회 · 근거 3건/);
  current = { ...current, progress: { stage: 'logs', session_count: 3, evidence_count: 5 } };
  await h.refreshCases({ automatic: true });
  assert.equal(h.elements['my-cases'].children[0], row);
  assert.match(row.querySelector('.own-case-status').textContent, /로그 대조 · 작업 세션 3회/);
  for (const [stage, label] of [['deployment', '설정 확인'], ['state', '데이터 확인'],
    ['writer', '답변 작성'], ['evidence_review', '근거 검토']]) {
    current = { ...current, progress: { stage, session_count: 4, evidence_count: 5 } };
    await h.refreshCases({ automatic: true });
    assert.match(row.querySelector('.own-case-status').textContent, new RegExp(label));
  }
  current = { ...current, progress: { stage: 'private_payload', session_count: 9, evidence_count: 9 } };
  await h.refreshCases();
  assert.doesNotMatch(row.querySelector('.own-case-status').textContent, /private_payload|작업 세션/);
  current = { ...current, execution_status: 'completed', progress: {
    stage: 'evidence_review', session_count: 10, evidence_count: 10 } };
  await h.refreshCases();
  assert.doesNotMatch(row.querySelector('.own-case-status').textContent, /근거 검토|작업 세션/);
});

test('response started before unlink cannot restore private case rows', async () => {
  let finish;
  const h = harness(() => new Promise((resolve) => { finish = resolve; }));
  const pending = h.refreshCases();
  h.clearLinkedCases('계정 연결이 해제됐습니다.');
  finish({ items: [item('running')], next_cursor: null });
  await pending;
  assert.equal(h.state.linked, false);
  assert.equal(h.state.caseItems.length, 0);
  assert.match(h.elements['my-cases'].children[0].textContent, /해제/);
});

test('automatic and manual refresh share one request and keep previously loaded cases', async () => {
  let finish, requests = 0;
  const h = harness(() => { requests++; return new Promise((resolve) => { finish = resolve; }); });
  const olderId = '11111111-1111-4111-8111-111111111111';
  h.state.caseItems = [{ ...item('completed'), case_id: olderId }];
  h.state.caseListExpanded = true;
  h.state.caseNextCursor = olderId;
  h.renderCases();
  const automatic = h.refreshCases({ automatic: true });
  const manual = h.refreshCases();
  assert.equal(requests, 1);
  finish({ items: [item('running')], next_cursor: caseId });
  await Promise.all([automatic, manual]);
  assert.deepEqual(Array.from(h.state.caseItems, (row) => row.case_id), [caseId, olderId]);
  assert.equal(h.state.caseNextCursor, olderId);
  assert.equal(h.elements['my-cases'].children.filter((node) => node.classList.contains('own-case')).length, 2);
});

test('existing timer refreshes linked visible owner state only', () => {
  let tick, calls = 0;
  const state = { linked: true, qaAuth: { currentUser: { uid: 'owner' } }, entryBusy: false,
    document: { hidden: false }, busy: true, refreshCases: () => { calls++; },
    $: () => ({ open: false }), load: () => {},
    setInterval: (callback) => { tick = callback; } };
  const source = between('      setInterval(() => {', '      document.addEventListener("visibilitychange"');
  runInNewContext(source, state);
  tick();
  assert.equal(calls, 1);
  state.document.hidden = true; tick();
  state.document.hidden = false; state.linked = false; tick();
  assert.equal(calls, 1);
});

test('zero reported usage is not rendered as zero measured tokens', () => {
  const parent = new Node('div');
  const source = between('      function renderMetrics(', '      function renderStages(');
  const render = runInNewContext(`${source}\nrenderMetrics`, { el: (tag, cls, value) => new Node(tag, cls, value) });
  render(parent, { metrics: { reported_usage_response_count: 0, total_tokens: 0 }, count_policy: 'unset' });
  const cards = parent.children[0].children[1].children;
  const tokens = cards.find((card) => card.children[0].textContent === '기록된 토큰');
  assert.equal(tokens.children[1].textContent, '미집계');
  render(parent, { metrics: { reported_usage_response_count: 1, total_tokens: 120 }, count_policy: 'unset' });
  const latest = parent.children[1].children[1].children;
  assert.equal(latest.find((card) => card.children[0].textContent === '기록된 토큰').children[1].textContent, '120');
});

const allNodes = node => [node,...node.children.flatMap(allNodes)];
const findText = (node,text) => allNodes(node).find(n=>n.textContent===text);
const settle = async () => { for(let i=0;i<8;i++) await new Promise(resolve=>setImmediate(resolve)); };
test('publication draft and delayed POST survive owner refresh and success requires readback',async()=>{
 let publication={case_id:caseId,case_version:1,publication_version:0,status:'private',content:null};
 let finishPost,posted,reads=0;
 const h=harness(async(path,method,body)=>{
  if(path.endsWith('/publication')) {
   if(method==='POST') {posted=body;await new Promise(resolve=>{finishPost=resolve;});publication={...publication,publication_version:1,status:'published',content:body.content};return publication;}
   reads++;return publication;
  }
  if(path.includes('shared-cases'))return {items:[],next_cursor:null};
  return {items:[item('completed')],next_cursor:null};
 });
 await h.refreshCases();const row=h.elements['my-cases'].children[0];
 findText(row,'회사 공유 요약 관리').listeners.get('click')();await settle();
 const editor=row.querySelector('.publication-editor'), fields=allNodes(editor).filter(n=>n.id?.startsWith('publication-'));
 fields.forEach((field,i)=>{field.value=['<img src=x onerror=alert(1)>','업무 영향','담당자가 확인합니다.'][i];});
 const checkbox=allNodes(editor).find(n=>n.type==='checkbox');checkbox.checked=true;
 await h.refreshCases({automatic:true});assert.equal(row,h.elements['my-cases'].children[0]);assert.equal(fields[0].value,'<img src=x onerror=alert(1)>');
 allNodes(editor).find(n=>n.tagName==='FORM').listeners.get('submit')({preventDefault(){}});await settle();assert.ok(finishPost);
 await h.refreshCases({automatic:true});assert.equal(editor,row.querySelector('.publication-editor'));
 finishPost();await settle();assert.equal(reads,2);assert.equal(posted.expected_version,0);
 assert.ok(findText(editor,'공유 내용을 저장하고 다시 확인했습니다.'));
 h.renderSharedCases([{...posted.content,case_status:'received',execution_status:'completed'}]);
 assert.equal(h.elements['shared-cases'].children[0].children[0].textContent,posted.content.title);
 assert.equal(h.elements['shared-cases'].children[0].children[0].children.length,0);
});
test('publication does not claim success when persisted readback disagrees',async()=>{
 const publication={case_id:caseId,case_version:1,publication_version:1,status:'published',content:{title:'제목',impact:'영향',next_action:'확인'}};
 const h=harness(async path=>path.endsWith('/publication')?publication:{items:[item('completed')],next_cursor:null});
 await h.refreshCases();const row=h.elements['my-cases'].children[0];findText(row,'회사 공유 요약 관리').listeners.get('click')();await settle();
 const editor=row.querySelector('.publication-editor');await findText(editor,'회사 공유 회수').listeners.get('click')();await settle();
 assert.ok(findText(editor,'readback_mismatch'));assert.equal(findText(editor,'공유를 회수했습니다.'),undefined);
});
test('shared request from a revoked session cannot repopulate cards',async()=>{
 let finish;const h=harness(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=h.refreshSharedCases();h.clearLinkedCases('연결 해제');finish({items:[{title:'늦은 응답'}],next_cursor:null});await pending;
 assert.equal(findText(h.elements['shared-cases'],'늦은 응답'),undefined);
});

test('reinvestigation clears prior result and delayed old response cannot restore it',async()=>{
 let version=1,resolveResult;
 const h=harness(async path=>path.endsWith('/result')?new Promise(resolve=>{resolveResult=resolve;}):{items:[{...item('completed'),aggregate_version:version}],next_cursor:null});
 h.state.renderOwnIssueLink=(target)=>target.append(new Node('a','','old issue'));
 await h.refreshCases();const row=h.elements['my-cases'].children[0],result=row.querySelector('.own-result');
 result.append(new Node('a','','previous issue'));
 const request=row.querySelector('.own-result-button').listeners.get('click')();
 version=2;await h.refreshCases({automatic:true});assert.equal(result.children.length,0);
 resolveResult({case_id:caseId,state:'completed',answer:{},github_issue:{}});await request;
 assert.equal(result.children.length,0);assert.equal(row.querySelector('.own-result-button').disabled,false);
});


test('assignment list accepts only its stored version and refreshes after success', async () => {
  let accepted = false, calls = [];
  const h = harness(async (path, method, body) => {
    calls.push({ path, method, body });
    if (method === 'POST') { accepted = true; return { lifecycle_version: 3 }; }
    return { items: accepted ? [] : [{ case_id: caseId, lifecycle_version: 2, severity: 'high' }], next_cursor: null };
  });
  await h.refreshAssignments();
  const card = h.elements['assignment-inbox'].children[0];
  const button = card.children.find(node => node.tagName === 'BUTTON');
  await button.listeners.get('click')();
  assert.equal(calls[1].body.action, 'accept_assignment');
  assert.equal(calls[1].body.expected_version, 2);
  assert.equal(calls.length, 3);
  assert.match(h.elements['assignment-inbox'].children[0].textContent, /수락할 담당 제안이 없습니다/);
});

test('late assignment inbox response cannot restore data after unlink', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  const pending = h.refreshAssignments();
  h.clearLinkedCases('연결 해제');
  resolve({ items: [{ case_id: caseId, lifecycle_version: 2 }], next_cursor: null });
  await pending;
  assert.match(h.elements['assignment-inbox'].children[0].textContent, /계정을 연결/);
});

test('assignment acceptance denial removes stale cards and disables paging', async () => {
  const h = harness(async (path, method) => {
    if (method === 'POST') throw Object.assign(Error('권한이 변경됐습니다.'), { status: 403 });
    return { items: [{ case_id: caseId, lifecycle_version: 2 }], next_cursor: caseId };
  });
  await h.refreshAssignments();
  const button = h.elements['assignment-inbox'].children[0].children.find(node => node.tagName === 'BUTTON');
  await button.listeners.get('click')();
  assert.equal(h.elements['assignment-next'].disabled, true);
  assert.match(h.elements['assignment-inbox'].children[0].textContent, /권한이 변경/);
});

test('real entryRequest preserves HTTP conflict so assignment acceptance refreshes the inbox', async () => {
  let accepted = false;
  const realRequest = runInNewContext(between('      async function entryRequest(', '      function friendlyError(') + '\nentryRequest', {
    qaAuth: { currentUser: { getIdToken: async () => 'test-token' } },
    fetch: async () => ({ ok: false, status: 409, json: async () => ({ error: 'qa_lifecycle_version_changed' }) }),
  });
  await assert.rejects(realRequest('/test'), { status: 409, message: 'qa_lifecycle_version_changed' });
  const h = harness(async (path, method) => {
    if (method === 'POST') { accepted = true; return realRequest(path, method); }
    return { items: accepted ? [] : [{ case_id: caseId, lifecycle_version: 2 }], next_cursor: null };
  });
  await h.refreshAssignments();
  const button = h.elements['assignment-inbox'].children[0].children.find(node => node.tagName === 'BUTTON');
  await button.listeners.get('click')();
  assert.match(h.elements['assignment-inbox'].children[0].textContent, /수락할 담당 제안이 없습니다/);
});
