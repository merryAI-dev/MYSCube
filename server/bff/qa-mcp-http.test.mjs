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
