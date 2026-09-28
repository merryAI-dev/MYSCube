import { describe, expect, it } from 'vitest';
import { generateReactPage, REACT_EXAMPLE } from './react-pages.mjs';
const source={title:'기존 카운터',workspace:{schemaVersion:1,entry:'App.tsx',packageSetId:'react18-tailwind4-v1',files:{
  'App.tsx':"import React,{useState} from 'react';import {format} from './lib/format';export default function App(){const[n,setN]=useState(0);return <main><h1>기존 제목</h1><button onClick={()=>setN(n+1)}>{format(n)}</button></main>}",
  'lib/format.ts':'export const format=(n:number)=>String(n);',
  'lib/unreferenced.ts':'export const retained = "unused but intentional";',
}}};
const tool=(args)=>{
  const {code,...rest}=args; const workspace=args.workspace||{schemaVersion:1,entry:'App.tsx',packageSetId:'react18-tailwind4-v1',files:{'App.tsx':code}};
  return {tool_calls:[{function:{name:'render_react_source',arguments:JSON.stringify({...rest,workspace:{...workspace,files:Object.entries(workspace.files).map(([path,content])=>({path,content}))}})}}]};
};
const edited=()=>({...structuredClone(source),title:'작업 현황',workspace:{...source.workspace,files:{...source.workspace.files,'App.tsx':source.workspace.files['App.tsx'].replace('기존 제목','작업 현황').replace('<button ','<button className="mt-6 px-5 py-3" ')}}});
const run=(complete,extra={})=>generateReactPage({complete,prompt:'독립 HTML 화면을 구성해 주세요.',businessContext:{originalRequest:'제목과 버튼 간격만 바꾸고 카운터와 다른 파일은 유지해줘.',clarificationReply:null},currentSource:source,apis:[],authorize:async()=>{},signal:AbortSignal.timeout(15000),...extra});
describe('React source-author editing contract and bounded compile repair',()=>{
  it('keeps original intent and complete source separate from a planner summary, without a competing new-app example',async()=>{
    let request;const result=await run(async value=>{request=value;return tool(edited());});
    const context=JSON.parse(request.messages.at(-1).content);
    expect(context.request).toContain('HTML');expect(context.confirmedBusinessContext).toMatchObject({originalRequest:expect.stringContaining('다른 파일은 유지'),clarificationReply:null});
    expect(context.currentSource).toEqual(source);expect(request.messages[0].content).not.toContain(REACT_EXAMPLE);expect(request.messages[0].content).toContain('read-only image fallback');expect(request.messages[0].content).toContain('do not silently remove existing behavior');
    expect(request.tools[0].function.parameters.properties).toHaveProperty('workspace');expect(request.tools[0].function.parameters.properties).not.toHaveProperty('html');
    expect(result.source.workspace.files['lib/format.ts']).toBe(source.workspace.files['lib/format.ts']);expect(result.source.workspace.files['lib/unreferenced.ts']).toBe(source.workspace.files['lib/unreferenced.ts']);
    expect(result.source.workspace.files['App.tsx']).toContain('onClick={()=>setN(n+1)}');expect(result.artifact.bundleHash).toMatch(/^[a-f0-9]{64}$/);expect(result.attempts).toBe(1);
  });
  it('rejects an omitted unused file and supplies its path and actual failed proposal before one repair',async()=>{
    const invalid=edited();delete invalid.workspace.files['lib/unreferenced.ts'];let calls=0,repairInput;
    const result=await run(async input=>{if(++calls===1)return tool(invalid);repairInput=JSON.parse(input.messages.at(-1).content);return tool(edited());});
    expect(result.attempts).toBe(2);expect(repairInput.currentSource).toEqual(source);expect(repairInput.repair.failedProposal).toEqual(invalid);
    expect(repairInput.repair.diagnostics).toContainEqual(expect.objectContaining({file:'lib/unreferenced.ts',code:'file_omitted'}));
    expect(result.source.workspace.files['lib/unreferenced.ts']).toBe(source.workspace.files['lib/unreferenced.ts']);
  });
  it('carries actual TypeScript file/line diagnostics and rejected code into the second attempt',async()=>{
    const invalid=edited();invalid.workspace.files['lib/format.ts']='export const format=(n:number): string => n;';let calls=0,repairInput;
    const result=await run(async input=>{if(++calls===1)return tool(invalid);repairInput=JSON.parse(input.messages.at(-1).content);return tool(edited());});
    expect(result.attempts).toBe(2);expect(repairInput.repair.failedProposal).toEqual(invalid);expect(repairInput.currentSource).toEqual(source);
    expect(repairInput.repair.diagnostics).toContainEqual(expect.objectContaining({file:'lib/format.ts',line:1,column:expect.any(Number)}));
    expect(repairInput.repair.diagnostics.length).toBeLessThanOrEqual(50);
  });
  it('accepts only exact declared deletions and never stores author-only removal metadata in source',async()=>{
    const proposal=edited();delete proposal.workspace.files['lib/unreferenced.ts'];
    const result=await run(async()=>tool({...proposal,removedFiles:['lib/unreferenced.ts']}));
    expect(result.source).toEqual(proposal);expect(result.source).not.toHaveProperty('removedFiles');expect(result.attempts).toBe(1);
    for(const removedFiles of [['lib/format.ts'],['lib/unreferenced.ts','lib/unreferenced.ts'],['unknown.ts']]){
      let calls=0;await expect(run(async()=>{calls++;return tool({...proposal,removedFiles});})).rejects.toMatchObject({code:'react_generation_invalid'});expect(calls).toBe(2);
    }
  });
  it('uses an explicitly selected previous proposal without resurrecting editor-only files',async()=>{
    const previous=edited();delete previous.workspace.files['lib/unreferenced.ts'];previous.workspace.files['lib/proposal-only.ts']='export const proposed = true;';
    const proposal=structuredClone(previous);proposal.title='제안 제목 변경';
    const result=await run(async()=>tool({...proposal,editBaseline:'previousProposal'}),{previousProposal:previous});
    expect(result.source).toEqual(proposal);expect(result.source).not.toHaveProperty('editBaseline');
    const editorResult=await run(async()=>tool(edited()));expect(result.baseEditorIdentity).toBe(editorResult.baseEditorIdentity);
    const omitted=structuredClone(proposal);delete omitted.workspace.files['lib/proposal-only.ts'];let calls=0,repair;
    const repaired=await run(async input=>{if(++calls===1)return tool({...omitted,editBaseline:'previousProposal'});repair=JSON.parse(input.messages.at(-1).content).repair;return tool({...proposal,editBaseline:'previousProposal'});},{previousProposal:previous});
    expect(repaired.attempts).toBe(2);expect(repair.editBaseline).toBe('previousProposal');expect(repair.diagnostics).toContainEqual(expect.objectContaining({file:'lib/proposal-only.ts',code:'file_omitted'}));
    const deleted=await run(async()=>tool({...omitted,editBaseline:'previousProposal',removedFiles:['lib/proposal-only.ts']}),{previousProposal:previous});expect(deleted.source).toEqual(omitted);
  });
  it('rejects unavailable or malformed selected previous baselines without inferring another baseline',async()=>{
    for(const previousProposal of [undefined,{title:'잘못된 제안',workspace:{}}]){
      let calls=0;await expect(run(async()=>{calls++;return tool({...edited(),editBaseline:'previousProposal'});},{previousProposal})).rejects.toMatchObject({code:'react_generation_invalid'});expect(calls).toBe(2);
    }
  });
  it('normalizes a legacy one-file editor only for generation and keeps its editor identity',async()=>{
    const legacy={title:'이전 단일 파일',code:'export default function App(){return <main>기존</main>}'};
    const result=await run(async()=>tool({...legacy,title:'제목 변경'}),{currentSource:legacy});
    expect(Object.keys(result.source.workspace.files)).toEqual(['App.tsx']);expect(result.source.workspace.files['App.tsx']).toBe(legacy.code);expect(result.baseEditorIdentity).toEqual(expect.any(String));
  });
  it('keeps compiler restrictions and stops after two invalid attempts without returning an artifact',async()=>{
    const proposal=edited();proposal.workspace.files['App.tsx']='import fs from "node:fs"; export default fs;';let calls=0;
    await expect(run(async()=>{calls++;return tool(proposal);})).rejects.toMatchObject({code:'react_generation_invalid'});expect(calls).toBe(2);
  });
  it('honors permission revocation before a repaired proposal and does not invoke the provider again',async()=>{
    let calls=0,guards=0;const proposal=edited();delete proposal.workspace.files['lib/unreferenced.ts'];
    await expect(run(async()=>{calls++;return tool(proposal);},{authorize:async()=>{if(++guards===3)throw Object.assign(new Error('revoked'),{statusCode:403});}})).rejects.toMatchObject({statusCode:403});expect(calls).toBe(1);
  });
});
