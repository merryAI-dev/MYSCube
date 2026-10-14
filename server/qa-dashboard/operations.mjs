const PROJECT = 'inner-platform-qa-20260310';
const BASE = `projects/${PROJECT}/databases/qa-assistant/documents/orgs/mysc`;
export const WORKERS = Object.freeze([
  {role:'relay', instance:'4861305577917178057'},
  {role:'consumer', instance:'4434581279771517181'},
  {role:'projection', instance:'2760120582151395596'},
]);
const statusNames = ['running','completed','needs_review','failed'];
const quarantineStates = ['blocked','dead_lettered','replay_authorized'];
const quarantineReasons = ['invalid_message','invalid_event','unsupported_aggregate_version','dispatch_response_invalid','dispatch_http_rejected','event_tenant_forbidden','event_schema_unsupported','event_type_unsupported','message_key_mismatch'];
const offset = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value)>9223372036854775807n) throw Error('invalid_offset');
  return BigInt(value);
};
const fresh = (value, now) => Number.isFinite(Date.parse(value)) && now-Date.parse(value)>=-5000 && now-Date.parse(value)<=60000;
const unavailable = (code='source_unavailable') => ({status:'unavailable',error_code:code});

export function projectWorker(entry, worker, now) {
  if (!entry) return {...unavailable('not_observed'),role:worker.role};
  // The separate collector observes the worker's localhost health endpoint.
  const resource=entry.resource;
  const payload=entry.jsonPayload;
  if (entry.logName!==`projects/${PROJECT}/logs/qa-pipeline-health` || payload?.producer!=='health_forwarder_v1' || !/^[a-f0-9-]{36}$/.test(payload.instance_id||'') || resource?.type!=='gce_instance' || resource.labels?.project_id!==PROJECT ||
      resource.labels?.instance_id!==worker.instance || resource.labels?.zone!=='asia-northeast3-a' ||
      payload?.phase!=='worker_heartbeat' || payload.role!==worker.role ||
      !['starting','running','degraded','stopping','failed'].includes(payload.process_state) ||
      typeof payload.ready!=='boolean' || !Number.isSafeInteger(payload.blocked_partition_count) || payload.blocked_partition_count<0 ||
      !Number.isFinite(Date.parse(entry.timestamp)) || !Number.isFinite(Date.parse(payload.observed_at)))
    return {...unavailable('invalid_observation'),role:worker.role};
  const recent = fresh(entry.timestamp,now)&&fresh(payload.observed_at,now);
  const expected=worker.role==='relay'?['outbox_poll','dispatch_tick']:['kafka_heartbeat'];
  const dependenciesGood=expected.every(key=>payload.dependencies?.[key]?.stale===false && fresh(payload.dependencies[key].last_success_at,now));
  const state= !recent?'stale':payload.ready && payload.process_state==='running' && payload.blocked_partition_count===0 && dependenciesGood?'ready':'attention';
  const result={role:worker.role,status:state,observed_at:payload.observed_at,received_at:entry.timestamp,
    valid_until:new Date(Math.min(Date.parse(entry.timestamp),Date.parse(payload.observed_at),...expected.map(k=>Date.parse(payload.dependencies?.[k]?.last_success_at)).filter(Number.isFinite))+60000).toISOString(),blocked_partitions:payload.blocked_partition_count,lag:{status:'not_applicable'}};
  if(worker.role==='relay') return result;
  result.lag={status:'unavailable'};
  if(!recent || payload.lag_stale!==false || !fresh(payload.lag_observed_at,now)) {result.lag.status='stale';return result;}
  const rows=payload.partitions;
  if(!Array.isArray(rows)||rows.length!==3||new Set(rows.map(p=>p.partition)).size!==3 || rows.some(p=>![0,1,2].includes(p.partition))) return result;
  try {
    let total=0n, rangeError=false;
    for(const p of rows) {
      const low=offset(p.log_start_offset), high=offset(p.high_watermark), next=offset(p.committed_next_offset), lag=offset(p.lag);
      if(low>high || typeof p.offset_out_of_range!=='boolean' || p.offset_out_of_range!==(next<low||next>high) || lag!==(high>next?high-next:0n)) throw Error('invalid_lag');
      total+=lag; rangeError ||=p.offset_out_of_range;
    }
    result.lag={status:rangeError?'out_of_range':total>0n?'pending':'caught_up',count:total.toString(),observed_at:payload.lag_observed_at,valid_until:new Date(Math.min(Date.parse(payload.lag_observed_at),Date.parse(result.valid_until)-60000)+60000).toISOString()};
  }catch {}
  return result;
}

export function projectProvider(entry, now) {
  if(!entry)return unavailable('not_observed');
  const p=entry.jsonPayload,r=entry.resource,at=Date.parse(p?.observed_at),received=Date.parse(entry.timestamp);
  if(entry.logName!==`projects/${PROJECT}/logs/run.googleapis.com%2Fstdout`||r?.type!=='cloud_run_job'||r.labels?.project_id!==PROJECT||r.labels?.job_name!=='qa-investigator-pipeline'||r.labels?.location!=='asia-northeast3'||p?.producer!=='qa_provider_observer_v1'||p.phase!=='provider_request_observed'||p.provider!=='openai'||!/^gpt-[a-z0-9.-]+$/.test(p.model||'')||!['accepted_http','credit_exhausted','http_error','network_error'].includes(p.outcome)||!Number.isFinite(at)||!Number.isFinite(received)||at>now+5000||received>now+5000)return unavailable('invalid_observation');
  const validStatus=p.outcome==='network_error'?p.http_status===null:p.outcome==='credit_exhausted'?p.http_status===429:p.outcome==='accepted_http'?Number.isInteger(p.http_status)&&p.http_status>=200&&p.http_status<300:Number.isInteger(p.http_status)&&p.http_status>=300&&p.http_status<=599;
  if(!validStatus)return unavailable('invalid_observation');
  const expires=Math.min(at,received)+15*60000;
  return {status:expires<now?'stale':'observed',provider:'openai',model:p.model,outcome:p.outcome,http_status:p.http_status,observed_at:p.observed_at,valid_until:new Date(expires).toISOString()};
}

export function ageOperations(value,now) {
  const result=structuredClone(value);
  if(result.provider?.valid_until&&Date.parse(result.provider.valid_until)<now)result.provider.status='stale';
  for(const w of result.workers||[]) {
    if(w.valid_until && Date.parse(w.valid_until)<now && w.status!=='unavailable')w.status='stale';
    if(w.lag?.valid_until && Date.parse(w.lag.valid_until)<now)w.lag={status:'stale',observed_at:w.lag.observed_at,valid_until:w.lag.valid_until};
  }
  return result;
}

export function createOperationsReader({request,now=Date.now}) {
  let cached, inFlight;
  async function quarantines(readTime) {
    try {
      const specifications=[['total',null,null],...quarantineStates.map(s=>[s,'state',s]),...quarantineReasons.map(s=>[s,'reason_code',s])];
      const values=await Promise.all(specifications.map(async ([name,field,value])=>{
        const query={from:[{collectionId:'qa_pipeline_quarantines'}],...(field?{where:{fieldFilter:{field:{fieldPath:field},op:'EQUAL',value:{stringValue:value}}}}:{})};
        const rows=await request({url:`https://firestore.googleapis.com/v1/${BASE}:runAggregationQuery`,method:'POST',
          data:{structuredAggregationQuery:{structuredQuery:query,aggregations:[{alias:'count',count:{}}]},readTime}});
        const count=rows?.[0]?.result?.aggregateFields?.count?.integerValue;
        if(!Array.isArray(rows)||rows.length!==1||typeof count!=='string'||!/^(0|[1-9][0-9]*)$/.test(count)||BigInt(count)>BigInt(Number.MAX_SAFE_INTEGER))throw Error('invalid_count');
        return[name,Number(count)];
      }));
      const counts=Object.fromEntries(values),known=quarantineStates.reduce((sum,k)=>sum+counts[k],0),reasons=quarantineReasons.reduce((sum,k)=>sum+counts[k],0);
      if(!Number.isSafeInteger(known)||!Number.isSafeInteger(reasons)||known>counts.total||reasons>counts.total)throw Error('invalid_count');
      return{status:'available',read_at:readTime,scope:'retained_per_consumer_group_including_tests',counts:Object.fromEntries(['total',...quarantineStates].map(k=>[k,counts[k]])),other:counts.total-known,
        reasons:Object.fromEntries(quarantineReasons.map(k=>[k,counts[k]])),other_reasons:counts.total-reasons};
    }catch{return unavailable();}
  }
  async function counts(readTime) {
    try {
      const values=await Promise.all(['total',...statusNames].map(async name=>{
        const query={from:[{collectionId:'qa_runs'}],...(name==='total'?{}:{where:{fieldFilter:{field:{fieldPath:'status'},op:'EQUAL',value:{stringValue:name}}}})};
        const data=await request({url:`https://firestore.googleapis.com/v1/${BASE}:runAggregationQuery`,method:'POST',
          data:{structuredAggregationQuery:{structuredQuery:query,aggregations:[{alias:'count',count:{}}]},readTime}});
        if(!Array.isArray(data)||data.length!==1) throw Error('invalid_count');
        const value=data[0]?.result?.aggregateFields?.count?.integerValue;
        if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)||BigInt(value)>BigInt(Number.MAX_SAFE_INTEGER)) throw Error('invalid_count');
        return [name,Number(value)];
      }));
      const counts=Object.fromEntries(values),known=statusNames.reduce((sum,k)=>sum+counts[k],0);
      if(!Number.isSafeInteger(known)||known>counts.total) throw Error('invalid_count');
      return {status:'available',read_at:readTime,scope:'all_retained_runs_including_tests',counts:{...counts,other:counts.total-known}};
    }catch{return unavailable();}
  }
  async function workerState(worker, at) {
    try {
      const filter=[`resource.type="gce_instance"`,`resource.labels.project_id="${PROJECT}"`,
        `resource.labels.instance_id="${worker.instance}"`,`resource.labels.zone="asia-northeast3-a"`,
        `timestamp>="${new Date(at-10*60000).toISOString()}"`,`logName="projects/${PROJECT}/logs/qa-pipeline-health"`,'jsonPayload.producer="health_forwarder_v1"','jsonPayload.phase="worker_heartbeat"',`jsonPayload.role="${worker.role}"`].join(' AND ');
      const data=await request({url:'https://logging.googleapis.com/v2/entries:list',method:'POST',
        data:{resourceNames:[`projects/${PROJECT}`],filter,orderBy:'timestamp desc',pageSize:1}});
      if(!data || (data.entries!==undefined&&!Array.isArray(data.entries))) throw Error('invalid_logs');
      return projectWorker(data.entries?.[0],worker,now());
    }catch{return {...unavailable(),role:worker.role};}
  }
  async function providerState(at) {
    try{
      const filter=[`resource.type="cloud_run_job"`,`resource.labels.project_id="${PROJECT}"`,'resource.labels.job_name="qa-investigator-pipeline"','resource.labels.location="asia-northeast3"',`logName="projects/${PROJECT}/logs/run.googleapis.com%2Fstdout"`,'jsonPayload.producer="qa_provider_observer_v1"','jsonPayload.phase="provider_request_observed"',`timestamp>="${new Date(at-24*3600000).toISOString()}"`].join(' AND ');
      const data=await request({url:'https://logging.googleapis.com/v2/entries:list',method:'POST',data:{resourceNames:[`projects/${PROJECT}`],filter,orderBy:'timestamp desc',pageSize:1}});
      if(!data||(data.entries!==undefined&&!Array.isArray(data.entries)))return unavailable('invalid_observation');
      return projectProvider(data.entries?.[0],now());
    }catch{return unavailable();}
  }
  return async function read() {
    if(cached && now()-cached.at<10000) return ageOperations(cached.result,now());
    if(inFlight) return ageOperations(await inFlight,now());
    const at=now(),readTime=new Date(Math.floor(at/1000)*1000-1000).toISOString();
    inFlight=(async()=>{
      const [runs,quarantine,provider,...workers]=await Promise.all([counts(readTime),quarantines(readTime),providerState(at),...WORKERS.map(w=>workerState(w,at))]);
      const result={observed_at:new Date(at).toISOString(),runs,quarantine,provider,workers};
      cached={at,result};return result;
    })();
    try{return ageOperations(await inFlight,now());}finally{inFlight=null;}
  };
}
