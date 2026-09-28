import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const rootArg = process.argv.indexOf('--source-root');
if(rootArg<0 || !process.argv[rootArg+1]) throw new Error('Pass --source-root pointing to the extracted 5b15c717 source archive.');
const sourceRoot = resolve(process.argv[rootArg+1]);
globalThis.fetch = async()=>{throw new Error('Network calls are forbidden in this static audit.');};
const sourcePins = {
  "server/workbench/conversation-agent.mjs": "6a1d3ec9f746f777d3ef10190d4b7b2345fb3a66e634de4c71db305528e63df5",
  "server/workbench/semantic-catalog.mjs": "903260ef6909519ef21b003ed013fe610742cbaf619a929ad00478909a4cbaf4",
  "server/workbench/semantic-query-guide.mjs": "c074613a2be2b8af975080bbe663ac94cc06a9ef64e4abea5acdefe8588a54f0",
  "server/workbench/table-query.mjs": "93d948723400b93fe0603307a598ec41205f2e218bb33a0eb30b14e32ca5e9e5",
  "server/workbench/analytics-contract.mjs": "108368f0a54cee753e688920e2ee551e613be949464afc51236e0388c7d01246",
  "server/workbench/react-pages.mjs": "518cb1025ab7308136dc5ef3c58c2dfcd50009f893e434d5f2d3b19dfb941b64",
  "server/workbench/html-references.mjs": "dd488cee798d0baa08653ef45a884b9488da66974bbab756bef68c5fddebc4a7",
  "server/workbench/cashflow-inflow-definition.mjs": "c0830d98467cf5f2fd817880e7805b5bad4454fb1913dc85cb4f295d3d90533b"
};
for(const [file,expected] of Object.entries(sourcePins)){
 const actual=createHash('sha256').update(await readFile(resolve(sourceRoot,file))).digest('hex');
 if(actual!==expected) throw new Error(`Pinned source mismatch: ${file}`);
}
const {runConversationTurn} = await import(pathToFileURL(resolve(sourceRoot,'server/workbench/conversation-agent.mjs')).href);
const {SEMANTIC_DEFINITIONS,resolveSemanticCatalog} = await import(pathToFileURL(resolve(sourceRoot,'server/workbench/semantic-catalog.mjs')).href);
const {buildSemanticQueryGuide} = await import(pathToFileURL(resolve(sourceRoot,'server/workbench/semantic-query-guide.mjs')).href);
const {buildTableQueryGuide} = await import(pathToFileURL(resolve(sourceRoot,'server/workbench/table-query.mjs')).href);
const {ANALYTICS_LIMITS,ANALYTICS_ENGINE_VERSION} = await import(pathToFileURL(resolve(sourceRoot,'server/workbench/analytics-contract.mjs')).href);
const {generateReactPage} = await import(pathToFileURL(resolve(sourceRoot,'server/workbench/react-pages.mjs')).href);
const {htmlReferencePrompt} = await import(pathToFileURL(resolve(sourceRoot,'server/workbench/html-references.mjs')).href);
import assert from 'node:assert/strict';
const len=x=>typeof x==='string'?x.length:JSON.stringify(x).length;
const bytes=x=>Buffer.byteLength(typeof x==='string'?x:JSON.stringify(x));
const measure=x=>({characters:len(x),utf8Bytes:bytes(x)});
const base={version:'a'.repeat(64),sourceRevision:'synthetic-v1',asOf:'2026-09-01T00:00:00.000Z',capturedAt:'2026-09-01T00:00:00.000Z',completeness:'partial',coverage:{description:'공개 합성 자료이며 실제 업무 데이터가 아닙니다.',expectedRows:0},rowCount:0,columnCoverage:{},importedAt:'2026-09-01T00:00:00.000Z',importedBy:'synthetic',contentHash:'a'.repeat(64)};
const semantic=SEMANTIC_DEFINITIONS.map(d=>({...base,datasetId:d.id,semanticDefinitionId:d.id,semanticDefinitionVersion:d.version,schema:[...new Map(Object.values(d.fields).map(f=>[f.physicalColumn,{name:f.physicalColumn,type:f.type,...(f.scale===undefined?{}:{scale:f.scale})}])).values()]}));
const table={...base,datasetId:'synthetic_projects',tableQuery:{schemaVersion:1},schema:[{name:'project_id',type:'string',label:'사업 식별자'},{name:'project_name',type:'string',label:'사업 이름'},{name:'start_date',type:'date',label:'계약 시작일'},{name:'end_date',type:'date',label:'계약 종료일'},{name:'status',type:'string',label:'저장된 상태 원문'}]};
const catalogFor=items=>({scopeFingerprint:'b'.repeat(64),engineVersion:ANALYTICS_ENGINE_VERSION,items,semantic:resolveSemanticCatalog({catalogItems:items}),tables:buildTableQueryGuide({catalogItems:items}),missingDatasetIds:[],limits:ANALYTICS_LIMITS});
const source={title:'공개 합성 카운터',code:"import React,{useState} from 'react'; export default function App(){const [n,setN]=useState(0);return <button onClick={()=>setN(n+1)}>확인 {n}</button>}"};
const registeredApis=[{id:'11111111-1111-4111-8111-111111111111',version:1,name:'합성 상태 조회',description:'공개 합성 API',kind:'analytics-copy',enabled:true,parameters:{yearMonth:{type:'string',required:true},weekNo:{type:'integer',required:true}},plan:{datasetId:'weekly_submission',definitionVersion:'1',select:['project_id','status','health'],time:{yearMonth:{$input:'yearMonth'},weekNo:{$input:'weekNo'}}}}];
const report={sourceSha:'5b15c717c6b90f24c4ec1a0e142d28db093c0408',archiveSha256:'201dd7e4d69d8be7ed9f83e13180244fd974f3e6cb56fdc208d5a1b6b9c6a353',method:'Actual pinned runConversationTurn first complete boundary capture, no provider/network/database. Characters are JS UTF-16 code units, not tokens.',fixtures:[],checks:[]};
for(const [name,items] of [['empty',[]],['two_semantic',semantic],['two_semantic_one_table',[...semantic,table]]]) for(const mode of ['react','legacy_html']) {
 const catalog=catalogFor(items);const queryGuide=buildSemanticQueryGuide({catalogItems:items});const tableGuide=buildTableQueryGuide({catalogItems:items});let captured;
 const STOP=Object.assign(new Error('audit-stop'),{code:'audit_stop'});
 try{await runConversationTurn({context:{tenantId:'synthetic',actorId:'synthetic',analyticsScope:{datasetIds:items.map(x=>x.datasetId)}},message:'현재 조회할 수 있는 자료를 설명해 주세요.',currentSource:mode==='react'?source:undefined,registeredApis:mode==='react'?registeredApis:[],screenBuilder:mode==='react'?async()=>{throw Error('not expected')}:undefined,analytics:{catalog:async()=>catalog},authorize:async()=>{},complete:async args=>{captured=structuredClone({messages:args.messages,tools:args.tools});throw STOP;},signal:new AbortController().signal,now:()=> '2026-09-28T00:00:00.000Z'});}catch(e){assert.equal(e,STOP);}
 assert.ok(captured);const system=captured.messages[0].content;const schema=captured.tools[0].function.parameters;
 assert.equal(JSON.stringify(catalog.tables),JSON.stringify(tableGuide));assert.equal(system.split(JSON.stringify(tableGuide)).length-1,2);
 assert.deepEqual(queryGuide.time.parameters,schema.oneOf.find(branch=>branch.properties.action.const==='query').properties.plan.properties.time.properties);
 const interpretation=schema.oneOf.map(x=>x.properties.interpretation);assert.ok(interpretation.every(x=>JSON.stringify(x)===JSON.stringify(interpretation[0])));
 const projected=structuredClone(catalog);projected.semantic.items=projected.semantic.items.map(({datasetId,definition,definitionHash})=>({datasetId,definition,definitionHash}));
 for(const entry of projected.semantic.items){const restored={...items.find(x=>x.datasetId===entry.datasetId),...entry};assert.deepEqual(restored,catalog.semantic.items.find(x=>x.datasetId===entry.datasetId));}
 const appendLine='\n승인된 원문 표 조회 계약(물리 스키마에서 생성):'+JSON.stringify(tableGuide);assert.ok(system.endsWith(appendLine));
 const repeatedMetaChars=len(catalog)-len(projected);const duplicateTableChars=appendLine.length;const totalContent=system.length+captured.messages.slice(1).reduce((n,m)=>n+m.content.length,0)+len(captured.tools);
 const parts={};for(const [key,value]of Object.entries(catalog))parts[key]=measure(value);
 const branchSizes=schema.oneOf.map(b=>({action:b.properties.action.const,...measure(b),interpretationChars:len(b.properties.interpretation)}));
 const actionContract=schema.oneOf.map(b=>({action:b.properties.action.const,requiredFields:b.required}));
 const sections={system:measure(system),toolWrapper:measure(captured.tools),toolSchema:measure(schema),catalog:measure(catalog),catalogFields:parts,semanticQueryGuide:measure(queryGuide),tableGuide:measure(tableGuide),actionContract:measure(actionContract),registeredApis:measure(mode==='react'?registeredApis:[]),currentSourceMessage:measure(mode==='react'?captured.messages[1].content:''),userMessage:measure(captured.messages.at(-1).content),htmlReferenceChars:mode==='legacy_html'?htmlReferencePrompt().length:0};
 report.fixtures.push({name,mode,sections,totalContentCharacters:totalContent,requestJson:measure(captured),branches:branchSizes,exactDuplicates:{tableGuideExtraCopyCharacters:duplicateTableChars,semanticRepeatedMetadataCharacters:repeatedMetaChars,interpretationExtraCopies:interpretation.length-1,interpretationExtraCharacters:(interpretation.length-1)*len(interpretation[0]),timeParameterSchemaDuplicateCharacters:len(queryGuide.time.parameters)},smallestProjection:{removedCharacters:duplicateTableChars+repeatedMetaChars,percentageOfSystem:100*(duplicateTableChars+repeatedMetaChars)/system.length,percentageOfTotalContent:100*(duplicateTableChars+repeatedMetaChars)/totalContent},semanticDefinitionCharacters:catalog.semantic.items.map(i=>({id:i.datasetId,...measure(i.definition)}))});
}
report.checks=['Each captured prompt contains tableGuide exactly twice.','Each oneOf interpretation subtree byte-for-byte equal.','Projected semantic entries can reconstruct original semantic catalog entries exactly using catalog.items keyed by datasetId.','Actual prompt captured before any tool execution; no provider/db/network calls.'];
report.author=[];
for(const [name,currentSource]of [['new',undefined],['edit',source]]){
 let captured;const STOP=new Error('audit author stop');
 try{await generateReactPage({complete:async args=>{captured=structuredClone({messages:args.messages,tools:args.tools});throw STOP;},prompt:'공개 합성 화면의 여백을 정리해 주세요.',currentSource,apis:registeredApis,authorize:async()=>{},signal:new AbortController().signal});}catch(e){assert.equal(e,STOP);}
 const system=captured.messages[0].content;
 report.author.push({name,system:measure(system),toolWrapper:measure(captured.tools),userPayload:measure(captured.messages.at(-1).content),requestJson:measure(captured),newExamplePresent:system.includes('NEW-SCREEN EXAMPLE'),fullCatalogPresent:system.includes('허용 catalog:')});
}
report.sourcePins=sourcePins;
console.log(JSON.stringify(report,null,2));
