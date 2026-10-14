import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const start = html.indexOf('      function renderOwnCaseAnswer(');
const end = html.indexOf('      function renderDetail(', start);
assert.ok(start > 0 && end > start, 'owner renderer is present in the served page');

function node(tag, cls = '', value = '') {
  return {
    tag, cls, textContent: String(value), children: [],
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
  };
}
const render = runInNewContext(`${html.slice(start, end)}\nrenderOwnCaseAnswer`, { el: node });
const labels = (parent) => parent.children.map((item) => item.textContent);

test('owner result puts reviewed plain-language fields first and folds stored raw details', () => {
  const target = node('div');
  render(target, {
    user_result: {
      headline: '저장 결과를 아직 확인할 수 없습니다.',
      what_happened: '등록 뒤 첫 화면은 보였지만 저장 완료 여부는 확인되지 않았습니다.',
      observed_expected: '관측: 화면 표시 / 기대: 저장 완료 확인',
      next_action: '담당자가 해당 시각의 저장 상태를 조회해 주세요.',
      result_kind: 'needs_input',
    },
    user_reply: '원문 기술 답변: trace_id=abc',
    cause_status: 'not_established',
    facts: ['기술 근거 1'], unknowns: ['서버 기록 없음'], next_actions: ['서버 로그 조회'],
  });
  assert.deepEqual(target.children.slice(0, 4).map((item) => item.tag), ['h4', 'p', 'p', 'h4']);
  assert.deepEqual(labels(target).slice(0, 5), [
    '저장 결과를 아직 확인할 수 없습니다.',
    '등록 뒤 첫 화면은 보였지만 저장 완료 여부는 확인되지 않았습니다.',
    '관측: 화면 표시 / 기대: 저장 완료 확인',
    '다음에 할 일',
    '담당자가 해당 시각의 저장 상태를 조회해 주세요.',
  ]);
  const technical = target.children.at(-1);
  assert.equal(technical.tag, 'details');
  assert.equal(technical.children[0].tag, 'summary');
  assert.equal(technical.children[2].textContent, '원문 기술 답변: trace_id=abc');
  assert.ok(technical.children.some((item) => item.tag === 'ul' && item.children[0].textContent === '기술 근거 1'));
  assert.equal(target.children.some((item) => item.textContent.includes('trace_id')), false);
});

test('legacy owner result is clearly labeled and still folds raw fact lists', () => {
  const target = node('div');
  render(target, { user_reply: '이전 답변 원문', cause_status: 'not_established',
    facts: ['기술 사실'], unknowns: [], next_actions: [] });
  assert.match(target.children[0].textContent, /이전 방식/);
  assert.equal(target.children[1].textContent, '이전 답변 원문');
  assert.equal(target.children[2].tag, 'details');
  assert.ok(target.children[2].children.some((item) => item.tag === 'ul'));
});

test('malformed structured result does not silently fall back to raw answer', () => {
  const target = node('div');
  render(target, { user_result: { headline: '부분 응답' }, user_reply: '내부 원문' });
  assert.equal(target.children.length, 1);
  assert.match(target.children[0].textContent, /형식을 확인할 수 없습니다/);
  assert.doesNotMatch(target.children[0].textContent, /내부 원문/);
});

test('owner issue link uses only the exact public repository receipt and never implies the bug is fixed',()=>{
 const renderIssue=runInNewContext(`${html.slice(start,end)}\nrenderOwnIssueLink`,{el:node});
 const issue={number:123,url:'https://github.com/merryAI-dev/MYSCube/issues/123',verified_at:'2026-10-13T00:00:00Z'};
 const target=node('div');renderIssue(target,issue);
 assert.equal(target.children[0].href,issue.url);assert.equal(target.children[0].textContent,'GitHub 이슈 보기');
 assert.equal(target.children[0].rel,'noopener noreferrer');
 for(const invalid of [null,{...issue,url:'javascript:alert(1)'},{...issue,url:issue.url+'?secret=value'},{...issue,number:124},{...issue,verified_at:'bad'}]){
  const empty=node('div');renderIssue(empty,invalid);assert.equal(empty.children.length,0);
 }
});
const renderFailure=runInNewContext(`${html.slice(start,end)}\nrenderOwnCaseFailure`,{el:node});
test('owner credit failure explains administrator action without showing supplied raw error or stale answer',()=>{
 const target=node('div');target.append(node('a','','old issue'));
 renderFailure(target,{state:'failed',failure:{category:'provider_credit_exhausted',message:'PRIVATE'},answer:{user_reply:'unreviewed'}});
 assert.match(labels(target).join(' '),/크레딧/);assert.match(labels(target).join(' '),/관리자/);
 assert.ok(!JSON.stringify(target).includes('PRIVATE'));assert.ok(!JSON.stringify(target).includes('old issue'));assert.ok(!JSON.stringify(target).includes('unreviewed'));
});
test('unknown failure and nonfailed states cannot become credit failure',()=>{
 for(const result of [{state:'failed',failure:{category:'PRIVATE'}},{state:'pending',failure:{category:'provider_credit_exhausted'}},{state:'needs_review',failure:{category:'provider_credit_exhausted'}}]){
  const target=node('div');renderFailure(target,result);assert.doesNotMatch(labels(target).join(' '),/크레딧|PRIVATE/);
 }
});
