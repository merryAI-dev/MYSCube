import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
const start=html.indexOf('      async function qaTool('),end=html.indexOf('      function friendlyError(',start);
assert(start>0&&end>start);
function harness(reply){
 const calls=[],state={qaAuth:{currentUser:{uid:'a'}},crypto:{randomUUID}};
 state.entryRequest=async(path,method,body)=>{calls.push({path,method,body});return reply(body,state);};
 const invoke=runInNewContext(html.slice(start,end)+'\nqaTool',state);
 return {invoke,calls,state};
}
const respond=body=>({jsonrpc:'2.0',id:body.id,result:body.method==='tools/call'?{content:[{type:'text',text:JSON.stringify({case_id:'case',state:'failed'})}]}:{protocolVersion:'2025-03-26'}});
test('served browser client initializes, notifies and reads MCP result without treating failed investigation as success',async()=>{
 const h=harness(respond);const value=await h.invoke('qa_result',{case_id:'case'});
 assert.equal(value.state,'failed');assert.deepEqual(h.calls.map(c=>c.body.method),['initialize','notifications/initialized','tools/call']);
 assert(h.calls.every(c=>c.path==='/api/me/mcp'&&c.method==='POST'));
});
test('served client stops on account change, mismatched RPC identity and tool error',async()=>{
 const switched=harness((body,state)=>{state.qaAuth.currentUser={uid:'b'};return respond(body);});
 await assert.rejects(switched.invoke('qa_result',{case_id:'case'}),/qa_login_required/);assert.equal(switched.calls.length,1);
 const mismatch=harness(body=>({...respond(body),id:'wrong'}));await assert.rejects(mismatch.invoke('qa_result',{}),/request_failed/);
 const denied=harness(body=>body.method==='tools/call'?{jsonrpc:'2.0',id:body.id,result:{isError:true,content:[{type:'text',text:'{"error":"qa_case_not_found"}'}]}}:respond(body));
 await assert.rejects(denied.invoke('qa_result',{}),/qa_case_not_found/);
});
