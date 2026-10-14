import {decodeFields} from './pipeline-context.mjs';
import {verifyIssueSourceProof} from './issue-source-proof.mjs';
const root='https://firestore.googleapis.com/v1/projects/inner-platform-qa-20260310/databases/qa-assistant/documents';
const prefix='projects/inner-platform-qa-20260310/databases/qa-assistant/documents/orgs/mysc';
const fail=code=>{throw Object.assign(new Error(code),{code});};
function encode(value){
 if(value===null)return {nullValue:null};
 if(typeof value==='string')return {stringValue:value};
 if(typeof value==='boolean')return {booleanValue:value};
 if(Number.isSafeInteger(value))return {integerValue:String(value)};
 if(typeof value==='number'&&Number.isFinite(value))return {doubleValue:value};
 if(Array.isArray(value))return {arrayValue:{values:value.map(encode)}};
 if(value&&typeof value==='object')return {mapValue:{fields:fields(value)}};
 fail('issue_storage_value_invalid');
}
const fields=value=>Object.fromEntries(Object.entries(value).map(([key,v])=>[key,encode(v)]));
export function createIssueCloudStore({client,caseId,authorizeScope}){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(caseId)||typeof authorizeScope!=='function')fail('issue_storage_configuration_invalid');
 const receiptName=`${prefix}/qa_github_publications/${caseId}`;
 let authorizedRunId;
 let authorizationFence;
 async function request(url,method='GET',data,allowMissing=false,conditional=false){
  try{return (await client.request({url,method,...(data?{data}:{})})).data;}catch(error){
   if(allowMissing&&error.response?.status===404)return null;
   if(conditional&&([409,412].includes(error.response?.status)||['FAILED_PRECONDITION','ABORTED','ALREADY_EXISTS'].includes(error.response?.data?.error?.status)))fail('issue_storage_conflict');
   fail('issue_storage_unavailable');
  }
 }
 async function readName(name,transaction){
  if(transaction){const rows=await request(`${root}:batchGet`,'POST',{documents:[name],transaction});const document=rows?.find(r=>r.found)?.found;return document?{value:decodeFields(document.fields),version:document.updateTime}:null;}
  const document=await request('https://firestore.googleapis.com/v1/'+name,'GET',undefined,true);return document?{value:decodeFields(document.fields),version:document.updateTime}:null;
 }
 const store={
  read:()=>readName(receiptName),
  async compareAndSet(version,value){
   let transaction,committed=false;
   try{
    if(value.status==='posting'){
     if(!authorizationFence)fail('issue_authorization_changed');
     transaction=(await request(`${root}:beginTransaction`,'POST',{options:{readWrite:{}}}))?.transaction;
     if(!transaction)fail('issue_storage_unavailable');
     await checkFence(authorizationFence,transaction);
    }
    await request(`${root}:commit`,'POST',{writes:[{update:{name:receiptName,fields:fields(value)},currentDocument:version?{updateTime:version}:{exists:false}}],...(transaction?{transaction}:{})},false,true);
    committed=true;return true;
   }catch(error){if(error.code==='issue_storage_conflict')return false;throw error;}
   finally{if(transaction&&!committed)await request(`${root}:rollback`,'POST',{transaction});}
  },
 };
 async function checkFence(fence,transaction){
  for(const bound of fence.documents){
   const current=await readName(bound.name,transaction);
   if(!current||current.version!==bound.version)fail('issue_authorization_changed');
  }
  if(Date.parse(fence.expires_at)<=Date.now())fail('issue_authorization_changed');
 }
 async function authorize(){
  authorizationFence=null;
  const transaction=(await request(`${root}:beginTransaction`,'POST',{options:{readOnly:{}}}))?.transaction;
  if(!transaction)fail('issue_storage_unavailable');
  let source,fence;
  try{
   const caseName=`${prefix}/qa_cases/${caseId}`;
   const caseDocument=await readName(caseName,transaction);
   const qa=caseDocument?.value;
   if(!qa||!/^[a-f0-9-]{36}$/.test(qa.investigation_event_id||''))fail('issue_source_missing');
   const runId=`qa-${qa.investigation_event_id}`;
   const names=['qa_runs/'+runId,'qa_dispatches/'+qa.investigation_event_id,'qa_external_deliveries/'+runId,'qa_github_publication_grants/'+caseId].map(path=>`${prefix}/${path}`);
   const values=await Promise.all(names.map(name=>readName(name,transaction)));
   const [run,dispatch,delivery,grant]=values.map(x=>x?.value);
   source={case:qa,run,dispatch,delivery,grant};
   if(run?.status!=='completed')return {...source,run:run||{status:'pending'}};
   const checkpoints=[];let cursor;
   for(;;){
    const rows=await request(`${root}/orgs/mysc/qa_runs/${runId}:runQuery`,'POST',{transaction,structuredQuery:{from:[{collectionId:'checkpoints'}],orderBy:[{field:{fieldPath:'sequence'},direction:'DESCENDING'}],limit:50,...(cursor?{startAt:{values:[{integerValue:String(cursor)}],before:false}}:{})}});
    const docs=(rows||[]).filter(r=>r.document).map(r=>decodeFields(r.document.fields));
    for(const doc of docs){let payload;try{payload=JSON.parse(doc.payload_json);}catch{fail('issue_source_proof_invalid');}checkpoints.push({...doc,payload});}
    const final=checkpoints.find(c=>c.phase==='tool_completed'&&c.payload.results?.some(r=>r.name==='finalize_investigation'&&r.result?.accepted===true));
    if(final&&checkpoints.some(c=>c.phase==='review_completed'&&c.sequence<final.sequence))break;
    if(docs.length<50)break;
    const next=docs.at(-1).sequence;if(!Number.isSafeInteger(next)||(cursor!==undefined&&next>=cursor))fail('issue_source_proof_invalid');cursor=next;
   }
   source.proof=verifyIssueSourceProof({...source,checkpoints});
   fence={expires_at:grant.expires_at,documents:[{name:caseName,version:caseDocument.version},...names.map((name,index)=>({name,version:values[index]?.version}))]};
   if(fence.documents.some(d=>!d.version))fail('issue_source_proof_invalid');
  }finally{await request(`${root}:rollback`,'POST',{transaction});}
  await authorizeScope({caseId,runId:source.run.run_id,phase:'run',actorId:source.case.actor_id,scope:source.case.investigation_scope});
  const confirmation=(await request(`${root}:beginTransaction`,'POST',{options:{readOnly:{}}}))?.transaction;
  if(!confirmation)fail('issue_storage_unavailable');
  try{await checkFence(fence,confirmation);}finally{await request(`${root}:rollback`,'POST',{transaction:confirmation});}
  authorizationFence=fence;
  authorizedRunId=source.run.run_id;
  return source;
 }
 return {store,authorize,async recordModelEvent(event){
  if(!authorizedRunId)fail('issue_source_not_reviewed');
  const safe=Object.fromEntries(['phase','stage','model','usage','error_code'].filter(k=>event[k]!==undefined).map(k=>[k,event[k]]));
  const id=crypto.randomUUID();
  await request(`${root}:commit`,'POST',{writes:[{update:{name:`${prefix}/qa_github_publication_events/${id}`,fields:fields({...safe,case_id:caseId,run_id:authorizedRunId,occurred_at:new Date().toISOString()})},currentDocument:{exists:false}}]});
 }};
}
