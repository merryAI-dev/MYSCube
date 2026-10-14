import { createHash, randomUUID } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SOURCE = 'query_jvm_request_diagnostics';
const PROJECT = 'inner-platform-live-20260316';
const SERVICE = 'innerplatform-jvm-weekly-api-live';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
export function createRequestDiagnosticTools({ auth, policy, authorize, requestLogAnchors }) {
  const p = structuredClone(policy), start = Date.parse(p?.allowedStartAt), end = Date.parse(p?.allowedEndAt);
  if (p?.cloudProject !== PROJECT || p.tenant !== 'mysc' || !Number.isFinite(start) || !Number.isFinite(end)
      || start >= end || end-start > 86400000 || !p.services?.length
      || p.services.some(s => s.name !== SERVICE || !['us-central1','asia-northeast3'].includes(s.region))
      || typeof authorize !== 'function' || typeof requestLogAnchors !== 'function') throw Error('invalid_request_diagnostic_policy');
  const evidence = new Map(), pages = new Map(), progress = new Map();
  // Only server-returned, persisted evidence enters this callback. Model input cannot register anchors.
  function observeEvidence(item) {
    if (requestLogAnchors(item).length) evidence.set(item.evidence_id, structuredClone(item));
  }
  const envelope = result => {
    const body = { source: SOURCE, ...result, cause_status: 'not_established' }, content_hash = hash(body);
    return { ...body, content_hash, evidence_id: `ev_${content_hash}`, observed_at: new Date().toISOString() };
  };
  const tool = {
    description: 'Read JVM request diagnostic metadata for an exact request already matched in authenticated BFF logs. Select its stored BFF evidence ID and request ID. No project ID is required. Request-ID correlation is not actor authorization or causal proof. Preserves separate invocation IDs and revisions. Empty pages do not prove no invocation; HTTP 200 does not prove UI success. Continue with the opaque continuation until exhausted.',
    parameters: {type:'object',additionalProperties:false,required:['evidence_id','request_id','region'],properties:{
      evidence_id:{type:'string',pattern:'^ev_[a-f0-9]{64}$'},request_id:{type:'string',pattern:'^req_[0-9]{13}_[a-f0-9]{12,64}$'},
      region:{type:'string',enum:[...new Set(p.services.map(s=>s.region))]},continuation:{type:'string'} }},
    async execute(args, { signal } = {}) {
      // Authority errors must propagate, not become evidence about source availability.
      await authorize(); signal?.throwIfAborted();
      let result, queryScope=null;
      try {
        if (!args || typeof args !== 'object' || Array.isArray(args)
            || Object.keys(args).some(k=>!['evidence_id','request_id','region','continuation'].includes(k))
            || !/^ev_[a-f0-9]{64}$/.test(args.evidence_id || '')
            || !/^req_[0-9]{13}_[a-f0-9]{12,64}$/.test(args.request_id || '')
            || !p.services.some(s=>s.region===args.region)) fail('invalid_scope');
        const stored = evidence.get(args.evidence_id);
        const anchors = stored ? requestLogAnchors(stored).filter(a=>a.request_id===args.request_id) : [];
        if (!anchors.length) fail('server_request_anchor_missing');
        const binding = hash({ anchors, region:args.region, start, end });
        let pageToken;
        if (args.continuation !== undefined) {
          const page = pages.get(args.continuation);
          if (!page || page.binding !== binding) fail('invalid_continuation');
          pageToken=page.token;
        }
        queryScope={cloud_project:PROJECT,service:SERVICE,region:args.region,
          start_at:new Date(start).toISOString(),end_at:new Date(end).toISOString(),
          request_id:args.request_id,anchor_evidence_id:args.evidence_id,
          page_token_sha256:pageToken ? hash(pageToken) : null};
        const client = await auth.getClient();
        const {data} = await client.request({url:'https://logging.googleapis.com/v2/entries:list',method:'POST',
          headers:{'x-goog-user-project':'inner-platform-qa-20260310'},data:{resourceNames:[`projects/${PROJECT}`],
            filter:[`resource.type="cloud_run_revision"`,`resource.labels.project_id="${PROJECT}"`,
              `resource.labels.service_name="${SERVICE}"`,`resource.labels.location="${args.region}"`,
              'jsonPayload.message="jvm.request.diagnostic"','jsonPayload.schema_version=1',
              `jsonPayload.request_id="${args.request_id}"`,`timestamp >= "${new Date(start).toISOString()}"`,
              `timestamp < "${new Date(end).toISOString()}"`].join('\n'),orderBy:'timestamp asc',pageSize:100,...(pageToken?{pageToken}:{})},
          signal,timeout:20000,retry:false,maxRedirects:0});
        signal?.throwIfAborted();
        if (!data || !Array.isArray(data.entries ?? []) || (data.entries||[]).length>100
            || Buffer.byteLength(JSON.stringify(data))>2000000) fail('source_invalid_response');
        const rows=[];let excluded=0;
        for (const entry of data.entries || []) {
          const l=entry.resource?.labels,j=entry.jsonPayload,t=Date.parse(entry.timestamp);
          const valid = entry.resource?.type==='cloud_run_revision' && l?.project_id===PROJECT
            && l.service_name===SERVICE && l.location===args.region
            && typeof l.revision_name==='string' && new RegExp(`^${SERVICE}-[a-z0-9-]+$`).test(l.revision_name)
            && Number.isFinite(t) && t>=start && t<end
            && j?.message==='jvm.request.diagnostic' && j.schema_version===1
            && j.service===SERVICE && j.revision===l.revision_name && j.request_id===args.request_id
            && j.request_id_source==='supplied_header' && uuid(j.invocation_id)
            && j.correlation_scope==='request_id_only_not_actor_authorization'
            && ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','OTHER'].includes(j.method)
            && (j.route_template===null || typeof j.route_template==='string' && j.route_template.length<=300 && /^\/[A-Za-z0-9_./{}:*\-]*$/.test(j.route_template))
            && Number.isSafeInteger(j.duration_ms) && j.duration_ms>=0
            && (j.phase==='started' && j.http_status===null && j.status_final===false && j.outcome==='pending' && j.duration_ms===0
              || j.phase==='completed' && j.status_final===true && j.outcome==='response_returned' && Number.isInteger(j.http_status) && j.http_status>=100 && j.http_status<=599
              || j.phase==='completed' && j.status_final===false && j.outcome==='escaped_exception' && j.http_status===null
              || j.phase==='completion_unobserved' && j.status_final===false && ['async_started','escaped_exception'].includes(j.outcome) && j.http_status===null);
          if (!valid) {excluded++;continue;}
          rows.push({timestamp:new Date(t).toISOString(),service:SERVICE,region:args.region,revision:l.revision_name,
            request_id:j.request_id,invocation_id:j.invocation_id,phase:j.phase,method:j.method,route_template:j.route_template,
            http_status:j.http_status,status_final:j.status_final,outcome:j.outcome,duration_ms:j.duration_ms});
        }
        let continuation=null;
        if (data.nextPageToken !== undefined && data.nextPageToken !== '') {
          if (typeof data.nextPageToken!=='string' || data.nextPageToken.length>8192) fail('source_invalid_response');
          continuation=randomUUID();pages.set(continuation,{binding,token:data.nextPageToken});
        }
        result=envelope({status:'available',query_scope:queryScope,start_at:new Date(start).toISOString(),end_at:new Date(end).toISOString(),
          request_id:args.request_id,anchor_evidence_id:args.evidence_id,anchors,rows,continuation,
          coverage:{complete:false,page_exhausted:!continuation,excluded_rows:excluded,scope:'server_anchored_request_diagnostics',
            raw_messages_included:false,request_id_is_actor_authorization:false,causal_association_verified:false,
            instrumentation_completeness_verified:false,empty_is_absence_proof:false}});
      } catch (error) {
        signal?.throwIfAborted();
        const codes=['invalid_scope','invalid_continuation','server_request_anchor_missing','source_invalid_response'];
        result=envelope({status:'unavailable',query_scope:queryScope,rows:[],error_code:codes.includes(error.safeCode)?error.safeCode:
          Number(error.response?.status)===403?'source_access_denied':'source_unavailable',coverage:{complete:false,empty_is_absence_proof:false}});
      }
      await authorize(); signal?.throwIfAborted();
      if (evidence.has(args?.evidence_id) && /^req_[0-9]{13}_[a-f0-9]{12,64}$/.test(args?.request_id || '')
          && p.services.some(s=>s.region===args.region)
          && !['invalid_scope','invalid_continuation','server_request_anchor_missing'].includes(result.error_code)) {
        progress.set(`${args.evidence_id}:${args.request_id}:${args.region}`, result.continuation || null);
      }
      return result;
    }
  };
  function revisionAnchors(item) {
    if (item?.source !== SOURCE || item.status !== 'available' || !Array.isArray(item.rows)
        || item.evidence_id !== `ev_${item.content_hash}`) return [];
    const {observed_at, evidence_id, content_hash, ...body}=item;
    if (hash(body)!==content_hash || item.start_at!==new Date(start).toISOString() || item.end_at!==new Date(end).toISOString()) return [];
    const q=item.query_scope;
    if (!q || q.cloud_project!==PROJECT || q.service!==SERVICE || !p.services.some(s=>s.region===q.region)
        || q.request_id!==item.request_id || q.anchor_evidence_id!==item.anchor_evidence_id
        || q.start_at!==item.start_at || q.end_at!==item.end_at) return [];
    const parent=evidence.get(item.anchor_evidence_id);
    const anchors=parent ? requestLogAnchors(parent).filter(a=>a.request_id===item.request_id) : [];
    if (!anchors.length || hash(anchors)!==hash(item.anchors)) return [];
    const refs=[];
    for (const row of item.rows) {
      const t=Date.parse(row.timestamp);
      if (row.request_id!==item.request_id || !uuid(row.invocation_id) || !Number.isFinite(t) || t<start || t>=end
          || row.service!==SERVICE || row.region!==q.region || !p.services.some(s=>s.region===row.region)
          || !new RegExp(`^${SERVICE}-[a-z0-9-]+$`).test(row.revision || '')) return [];
      refs.push({region:row.region,revision:row.revision,evidence_id:item.evidence_id});
    }
    return [...new Map(refs.map(r=>[hash(r),r])).values()];
  }
  function requiredFollowups() {
    const followups=[];
    for (const item of evidence.values()) for (const anchor of requestLogAnchors(item)) for (const {region} of p.services) {
      const key=`${item.evidence_id}:${anchor.request_id}:${region}`;
      if (progress.has(key) && progress.get(key)===null) continue;
      const args={evidence_id:item.evidence_id,request_id:anchor.request_id,region,
        ...(progress.get(key)?{continuation:progress.get(key)}:{})};
      followups.push({tool:SOURCE,reason:`An authenticated BFF request is available. Read its JVM diagnostic metadata with ${JSON.stringify(args)} before concluding. A missing or unavailable record is not proof of absence. After process resume, cursors restart from the first page.`});
    }
    return followups;
  }
  return { tools:{[SOURCE]:tool}, observeEvidence, requiredFollowups, revisionAnchors };
}
