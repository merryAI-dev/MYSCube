import { describe, it, expect, vi } from 'vitest';
import { runConversationTurn } from './conversation-agent.mjs';
import { validateReactScreenBindings } from './react-screen-bindings.mjs';
const apiId='11111111-1111-4111-8111-111111111111', evidenceId='22222222-2222-4222-8222-222222222222';
const api={id:apiId,version:1,kind:'external-read',enabled:true,endpointId:'myscube-cashflow-evidence',endpointVersion:1,definitionHash:'a'.repeat(64),endpointHash:'b'.repeat(64),parameters:{yearMonth:{type:'string',required:true,label:'월',example:'2026-09'}}};
const binding={apiId,apiVersion:1,input:{yearMonth:'2026-09'},evidenceId};
const evidence={kind:'registered-api',...binding,definitionHash:api.definitionHash,endpointHash:api.endpointHash,data:{amount:null},metadata:{asOf:'2026-09-28'},datasetVersions:{}};
const interpretation={summary:'실시간 9월 자료',context:{datasetIds:[],filters:{},evidenceIds:[]},ambiguities:[]};
const tool=step=>({tool_calls:[{function:{name:'workbench_step',arguments:JSON.stringify(step)}}]});
describe('live registered API conversation bindings',()=>{
 it('queries the selected server API and carries actual evidence into automatic screen generation',async()=>{
  const complete=vi.fn().mockResolvedValueOnce(tool({action:'query_api',apiId,apiVersion:1,input:binding.input,interpretation})).mockResolvedValueOnce(tool({action:'build_screen',interpretation,request:'월별 화면',purpose:'connected',bindings:[binding],evidenceIds:[evidenceId]}));
  const invokeRegisteredApi=vi.fn(async()=>evidence), screenBuilder=vi.fn(async()=>({type:'source',source:{title:'실시간'}}));
  const queryPlan=vi.fn();
  const result=await runConversationTurn({context:{analyticsScope:{datasetIds:[]}},message:'9월 화면',complete,registeredApis:[api],invokeRegisteredApi,screenBuilder,analytics:{catalog:async()=>({items:[]}),queryPlan},authorize:async()=>{},signal:new AbortController().signal});
  expect(invokeRegisteredApi).toHaveBeenCalledTimes(1);expect(queryPlan).not.toHaveBeenCalled();expect(screenBuilder.mock.calls[0][0].evidence).toEqual([evidence]);expect(result.evidence).toEqual([evidence]);
 });
 it('binds only the exact registered version, verified input and definition',()=>{
  const args={bindings:[binding],evidence:[evidence],apis:[api],catalog:{items:[]}};
  expect(validateReactScreenBindings(args)[0].plan.kind).toBe('external-read');
  for(const patch of [{apiVersion:2},{input:{yearMonth:'2026-10'}},{definitionHash:'c'.repeat(64)},{endpointHash:'c'.repeat(64)},{kind:'qa'}])expect(()=>validateReactScreenBindings({...args,evidence:[{...evidence,...patch}]})).toThrow();
  expect(()=>validateReactScreenBindings({...args,apis:[{...api,enabled:false}]})).toThrow();
 });
});
