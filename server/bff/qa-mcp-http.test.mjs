import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mountQaMcpRoutes} from './qa-mcp.mjs';
import {once} from 'node:events';
test('HTTP MCP rejects missing identity, browser origin, foreign sessions and batches before database access',async()=>{
 let transactions=0;
 const app=express();app.use(express.json());app.use((req,_res,next)=>{if(req.header('x-test-member')==='yes')req.context={tenantId:'mysc',actorId:'a',authSource:'firebase'};next();});
 mountQaMcpRoutes(app,{db:{runTransaction:async()=>{transactions++;throw Error('must not reach db');}},idempotencyService:{},authorizeCase:async()=>{},asyncHandler:fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next)});
 app.use((err,_req,res,_next)=>res.status(500).json({error:'unexpected'}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/api/v1/mcp`;
 try{
 for(const [headers,body,expected] of [[{}, {},401],[{'x-test-member':'yes',origin:'https://example.invalid'}, {},403],[{'x-test-member':'yes','mcp-session-id':'foreign'}, {},400],[{'x-test-member':'yes'}, [],400]]){
 const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});assert.equal(response.status,expected);assert.equal(response.headers.get('cache-control'),'no-store');await response.text();
 }
 for(const method of ['GET','DELETE']){const response=await fetch(url,{method});assert.equal(response.status,405);assert.equal(response.headers.get('allow'),'POST');await response.text();}
 assert.equal(transactions,0);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('real HTTP SDK initializes, discovers tools and reaches authorized case service',async()=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const calls=[];
 const db={doc:path=>({path}),runTransaction:async fn=>fn({get:async ref=>{calls.push(ref.path);return {exists:ref.path.endsWith('/members/a'),data:()=>ref.path.endsWith('/members/a')?{status:'ACTIVE',role:'pm'}:undefined};}})};
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.context={tenantId:'mysc',actorId:'a',authSource:'firebase'};next();});
 mountQaMcpRoutes(app,{db,idempotencyService:{},authorizeCase:async()=>{},asyncHandler:fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next)});
 app.use((_err,_req,res,_next)=>res.status(500).json({error:'unexpected'}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const client=new Client({name:'http-test',version:'1'});
 try{
 await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/api/v1/mcp`)));
 const catalog=await client.listTools();assert.deepEqual(catalog.tools.map(t=>t.name).sort(),['qa_activity','qa_list','qa_read','qa_report','qa_result']);
 const result=await client.callTool({name:'qa_read',arguments:{case_id:'11111111-1111-4111-8111-111111111111'}});
 assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).error,'qa_case_not_found');
 assert(calls.includes('orgs/mysc/qa_cases/11111111-1111-4111-8111-111111111111'));
 }finally{await client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
