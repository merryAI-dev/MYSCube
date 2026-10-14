import test from 'node:test';
import assert from 'node:assert/strict';
import { runPublicationSweep } from './publication-worker.mjs';
const id = '9acdd105-b571-48c1-8cd8-e12ee618a224';
const second = '9acdd105-b571-48c1-8cd8-e12ee618a225';
function doc(caseId, overrides = {}) {
 const grant = { case_id: caseId, status: 'ACTIVE', repository: 'merryAI-dev/MYSCube', expires_at: '2099-01-01T00:00:00Z', ...overrides };
 return { name: `projects/test/documents/grants/${caseId}`, fields: Object.fromEntries(Object.entries(grant).map(([k,v])=>[k,{stringValue:v}])) };
}
const waiting = () => ({ authorize: async () => ({ run: { status: 'running' } }), generateDraft: () => assert.fail('unfinished investigation must not draft'), github: { create: () => assert.fail('unfinished investigation must not publish') } });
test('pages through grants and unfinished investigations cause no model or publication call', async () => {
 const results = [], urls = [];
 const pages = [{ documents: [doc(id), doc(second,{status:'REVOKED'})], nextPageToken: 'next' },{documents:[doc(second)]}];
 const result = await runPublicationSweep({ client:{request:async ({url})=>{urls.push(url);return {data:pages.shift()};}},createDelivery:waiting,onResult:async r=>results.push(r) });
 assert.deepEqual(result,{failed:false,visited:2});
 assert.equal(new URL(urls[1]).searchParams.get('pageToken'),'next');
 assert.equal(new URL(urls[0]).searchParams.get('orderBy'),'__name__');
 assert.deepEqual(results.map(r=>r.status),['waiting_for_reviewed_result','waiting_for_reviewed_result']);
});
test('revoked current authority fails only that case, does not expose raw errors, continues sweep', async () => {
 const results=[];
 const result=await runPublicationSweep({client:{request:async()=>({data:{documents:[doc(id),doc(second)]}})},createDelivery:caseId=>caseId===id?{authorize:async()=>{throw new Error('Bearer SECRET');}}:waiting(),onResult:async r=>results.push(r)});
 assert.deepEqual(result,{failed:true,visited:2});
 assert.equal(results[0].error_code,'issue_publication_failed');assert.equal(results[1].status,'waiting_for_reviewed_result');
 assert.ok(!JSON.stringify(results).includes('SECRET'));
});
test('expired, malformed expiry and revoked grants never create delivery; mismatched active grants fail',async()=>{
 let calls=0;const results=[];
 const result=await runPublicationSweep({client:{request:async()=>({data:{documents:[doc(id,{expires_at:'2000-01-01'}),doc(id,{expires_at:'invalid'}),doc(id,{status:'REVOKED'}),doc(id,{case_id:second})]}})},createDelivery:()=>{calls++;return waiting();},onResult:async r=>results.push(r)});
 assert.equal(calls,0);assert.equal(result.failed,true);assert.equal(results[0].error_code,'issue_grant_invalid');
});
test('duplicate documents are processed once and cyclic page tokens fail',async()=>{
 let calls=0,deliveryCalls=0;
 await assert.rejects(runPublicationSweep({client:{request:async()=>({data:{documents:[doc(id)],nextPageToken:++calls%2?'a':'b'}})},createDelivery:()=>{deliveryCalls++;return waiting();},onResult:async()=>{}}),/pagination_stalled/);
 assert.equal(deliveryCalls,1);assert.equal(calls,3);
});

test('a malformed active expiry alone is observable failure rather than a successful empty sweep',async()=>{
 const results=[];
 const result=await runPublicationSweep({client:{request:async()=>({data:{documents:[doc(id,{expires_at:'malformed'})]}})},createDelivery:()=>assert.fail('invalid grant'),onResult:async r=>results.push(r)});
 assert.equal(result.failed,true);assert.equal(results.length,1);assert.equal(results[0].error_code,'issue_grant_invalid');
});

test('failed investigation is an observable failed sweep while other cases continue',async()=>{
 const results=[];
 const result=await runPublicationSweep({client:{request:async()=>({data:{documents:[doc(id),doc(second)]}})},createDelivery:caseId=>caseId===id?{...waiting(),authorize:async()=>({run:{status:'failed',error:'Bearer SECRET'}})}:waiting(),onResult:async r=>results.push(r)});
 assert.deepEqual(result,{failed:true,visited:2});
 assert.deepEqual(results,[{case_id:id,status:'investigation_failed'},{case_id:second,status:'waiting_for_reviewed_result'}]);
});
