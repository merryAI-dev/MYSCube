import { candidateHash } from '../qa-shared/candidate-integrity.mjs';

export const SEARCH_TOOLS = 'search_investigation_tools';
export const SELECT_TOOL = 'select_investigation_tool';
const fail = () => { throw Error('investigation_tool_discovery_invalid'); };
const object = properties => ({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});

// The registry is already scoped by the caller. Discovery cannot create executors.
export function createToolDiscovery({tools,runBinding,onSelect}) {
  const entries=Object.entries(tools).sort(([a],[b])=>a.localeCompare(b)).map(([name,t])=>({
    name,description:t.description,parameters:structuredClone(t.parameters),
    schema_sha256:candidateHash({name,description:t.description,parameters:t.parameters}),
  }));
  const catalogHash=candidateHash({runBinding,entries});
  const byName=new Map(entries.map(e=>[e.name,e]));
  const reference=e=>({name:e.name,schema_sha256:e.schema_sha256,catalog_sha256:catalogHash});
  function validateSelection(value) {
    const e=byName.get(value?.name);
    if(!e||value.catalog_sha256!==catalogHash||value.schema_sha256!==e.schema_sha256)fail();
    return e;
  }
  const discoveryTools={
    [SEARCH_TOOLS]:{
      description:'Find authorized investigation tools by name or description. Empty query lists all pages. Results are a catalog, never evidence. Select a matching tool to load its arguments for the next step.',
      parameters:object({query:{type:'string',maxLength:300},cursor:{type:['string','null'],maxLength:2000}}),
      execute:({query,cursor=null})=>{
        if(typeof query!=='string'||query.length>300)fail();
        const terms=query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches=entries.filter(e=>terms.every(term=>(e.name+' '+e.description).toLowerCase().includes(term)));
        let offset=0;
        if(cursor){
          let c;try{c=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{fail();}
          if(c.catalog_sha256!==catalogHash||c.query!==query||!Number.isSafeInteger(c.offset)||c.offset<0||c.offset>matches.length)fail();
          offset=c.offset;
        }
        const page=[];let size=0;
        while(offset<matches.length){
          const e=matches[offset];const item={...reference(e),description:e.description};
          const n=Buffer.byteLength(JSON.stringify(item));
          if(n>16384)fail();
          if(size+n>16384&&page.length)break;
          page.push(item);size+=n;offset++;
        }
        return {kind:'tool_catalog',catalog_sha256:catalogHash,tools:page,total:matches.length,
          next_cursor:offset<matches.length?Buffer.from(JSON.stringify({catalog_sha256:catalogHash,query,offset})).toString('base64url'):null};
      },
    },
    [SELECT_TOOL]:{
      description:'Load one authorized tool schema for the next observation step, using its exact search result reference. Does not execute it or collect evidence.',
      parameters:object({name:{type:'string'},schema_sha256:{type:'string'},catalog_sha256:{type:'string'}}),
      execute:args=>{const e=validateSelection(args);if(Buffer.byteLength(JSON.stringify(e))>32768)fail();onSelect(reference(e));return {kind:'tool_selected',...e,catalog_sha256:catalogHash};},
    },
  };
  return {tools:discoveryTools,validateSelection,catalogHash};
}
