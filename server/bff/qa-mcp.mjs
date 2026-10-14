import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createQaCaseService, qaCaseInputSchema, qaCaseIdSchema, requireQaMember } from './qa-cases.mjs';
import { createQaCaseResultService } from './qa-case-result.mjs';

export function createQaMcpServer({ context, cases, results, authorize }) {
  const bound = Object.freeze({tenantId:context.tenantId,actorId:context.actorId,
    authSource:context.authSource,requestId:context.requestId});
  const server = new McpServer({name:'mysc-qa',version:'0.1.0'});
  const register = (name, title, inputSchema, readOnlyHint, execute) => server.registerTool(name, {
    title, description:title, inputSchema,
    annotations:{readOnlyHint,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  }, async args => {
    try {
      await authorize(bound);
      const output = await execute(args);
      await authorize(bound);
      return {content:[{type:'text',text:JSON.stringify(output)}]};
    } catch(error) {
      const code = error?.expose === true && /^qa_[a-z_]+$/.test(error.code || '') ? error.code
        : error?.expose === true && /^idempotency_[a-z_]+$/.test(error.code || '') ? error.code : 'qa_mcp_request_failed';
      return {isError:true,content:[{type:'text',text:JSON.stringify({error:code,message:'요청을 처리하지 못했습니다. 계정 권한과 접수 상태를 확인해 주세요.'})}]};
    }
  });
  register('qa_report','문제 접수 후 본인의 저장된 접수를 확인합니다. 조사 완료를 뜻하지 않습니다.',
    z.object({idempotency_key:z.string().trim().min(1).max(200),report:qaCaseInputSchema}).strict(),false,
    async ({idempotency_key,report}) => {
      const result=await cases.create({...bound,idempotencyKey:idempotency_key},report);
      const saved=await cases.get(bound,result.body.case_id);
      return {case:saved,replayed:result.replayed===true,confirms:'qa_intake_persisted'};
    });
  register('qa_read','본인이 접수한 문제의 현재 상태를 조회합니다.',z.object({case_id:qaCaseIdSchema}).strict(),true,
    args=>cases.get(bound,args.case_id));
  register('qa_activity','본인 접수의 저장된 처리 이력을 조회합니다.',z.object({case_id:qaCaseIdSchema}).strict(),true,
    args=>cases.activity(bound,args.case_id));
  register('qa_result','본인 접수의 검토된 답변 또는 현재 중단 이유를 조회합니다.',z.object({case_id:qaCaseIdSchema}).strict(),true,
    args=>results.get(bound,args.case_id));
  register('qa_list','본인의 접수 목록을 조회합니다.',z.object({limit:z.number().int().min(1).max(50).optional(),cursor:qaCaseIdSchema.optional()}).strict(),true,
    args=>cases.list(bound,args));
  return server;
}

export function mountQaMcpRoutes(app,{db,idempotencyService,authorizeCase,asyncHandler}) {
  const cases=createQaCaseService({db,idempotencyService});
  const results=createQaCaseResultService({db,authorizeCase});
  const authorize=context=>db.runTransaction(tx=>requireQaMember(tx,db,context));
  app.post('/api/v1/mcp',asyncHandler(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(!req.context?.tenantId || !req.context?.actorId) return res.status(401).json({error:'qa_mcp_auth_required'});
    // Bearer-only internal endpoint; browser OAuth clients use a separate future public adapter.
    if(req.header('origin')) return res.status(403).json({error:'qa_mcp_origin_denied'});
    if(req.header('mcp-session-id')) return res.status(400).json({error:'qa_mcp_stateless_only'});
    if(Array.isArray(req.body)) return res.status(400).json({error:'qa_mcp_batch_unsupported'});
    await authorize(req.context);
    const server=createQaMcpServer({context:req.context,cases,results,authorize});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.once('close',()=>{void transport.close();void server.close();});
    await server.connect(transport);
    await transport.handleRequest(req,res,req.body);
  }));
  for(const method of ['get','delete'])app[method]('/api/v1/mcp',(_req,res)=>res.status(405).set('Allow','POST').end());
}
