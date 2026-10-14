import Ajv from 'ajv/dist/2020.js';
import { validateInvestigationEvidence } from './session-context.mjs';
const PROJECT = /^p[0-9]{10,20}$/;
const fail = code => { throw Object.assign(new Error(code), {code,safeCode:code}); };

// Source state is isolated by project; a denied invocation invalidates its cached pagination.
export function createDiscoveredProjectTools({runBinding,requestLogAnchors,authorizeProject,createSources}) {
  const projects=new Set(), evidence=new Map(), sources=new Map();
  const schemaOnly=createSources('p0000000000',()=>fail('discovered_project_schema_only'));
  const tools={};
  for(const [name,template] of Object.entries(schemaOnly.tools)) {
    // Reporter-scoped errors discover projects; requiring a discovered project here would create a cycle.
    if(name === 'query_client_errors' || !template.parameters?.properties?.project_id) continue;
    const parameters=structuredClone(template.parameters);
    parameters.properties.project_id={type:'string',pattern:'^p[0-9]{10,20}$'};
    const valid=new Ajv({strict:false,formats:{'date-time':value=>Number.isFinite(Date.parse(value))}}).compile(parameters);
    tools[name]={
      description:template.description+' For a platform-wide report, first identify this project in correlated server request logs. Current reporter access is checked before and after reading.',
      parameters,
      async execute(args,options={}) {
        if(!valid(args)||!PROJECT.test(args.project_id||'')||!projects.has(args.project_id))fail('investigation_project_unobserved');
        args=structuredClone(args);
        const check=async()=>{options.signal?.throwIfAborted();await authorizeProject(args.project_id);options.signal?.throwIfAborted();};
        try { await check(); } catch(error) { sources.delete(args.project_id);throw error; }
        let source=sources.get(args.project_id);
        if(!source) {
          source=createSources(args.project_id,()=>authorizeProject(args.project_id));
          for(const item of evidence.values())source.observeEvidence?.(item);
          sources.set(args.project_id,source);
        }
        try {
          const tool=source.tools[name];
          if(!tool)fail('investigation_project_tool_missing');
          const output=await tool.execute(args,options);
          await check();
          return output;
        } catch(error) { sources.delete(args.project_id);throw error; }
      },
    };
    if(typeof template.blockedBy === 'function') {
      Object.defineProperty(tools[name],'blockedBy',{value(input) {
        const blocks=[];
        for(const project of projects) {
          const source=createSources(project,()=>authorizeProject(project));
          for(const item of evidence.values())source.observeEvidence?.(item);
          const blocked=source.tools[name]?.blockedBy?.(input);
          if(!blocked)return null;
          blocks.push(blocked);
        }
        if(!blocks.length||blocks.some(b=>b.reason_code!==blocks[0].reason_code))return null;
        return {reason_code:blocks[0].reason_code,evidence_ids:[...new Set(blocks.flatMap(b=>b.evidence_ids))]};
      }});
    }
  }
  return {tools,observeEvidence(item){
    const value=validateInvestigationEvidence(item,runBinding);
    for(const anchor of requestLogAnchors(value)) {
      const match=/^\/api\/v1\/(?:cashflow|projects)\/(p[0-9]{10,20})(?:\/|$)/.exec(anchor.path||'');
      if(match)projects.add(match[1]);
    }
    evidence.set(value.evidence_id,value);
    for(const source of sources.values())source.observeEvidence?.(value);
  }};
}
