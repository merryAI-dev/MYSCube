import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { accountingEvidence, accountingInput } from '../../server/mcp/accounting-read.mjs';
import { API_CATALOG, API_CATALOG_VERSION, PROJECT_FIELDS, catalogView, projectId, redact, yearMonth } from '../../server/mcp/api-catalog.mjs';

// 모든 도구는 읽기 전용이고, 데이터는 로그인한 구성원의 토큰으로 MYSCube BFF 에서만 읽는다.
// 권한 판단은 BFF 가 앱 화면과 똑같이 한다.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// MCP 쪽에는 건수 상한을 두지 않는다. 남는 제약은 BFF 가 강제하는 것뿐이고, 그것도 여기서 나눠 부른다.
// BFF /api/v1/projects 는 요청당 200건까지 준다.
const PROJECT_PAGE_SIZE = 200;
// BFF weekly-overview 는 요청당 100개 사업까지 받는다.
const OVERVIEW_BATCH = 100;
const PROJECT_SUMMARY_FIELDS = Object.freeze(['name', 'shortName', 'cic', 'status', 'phase', 'department', 'teamName', 'managerName',
  'clientOrg', 'contractStart', 'contractEnd', 'contractAmount', 'currency', 'settlementType', 'isSettled']);

const INSTRUCTIONS = [
  'MYSCube 사업관리 데이터를 읽기 전용으로 조회합니다. 결과는 로그인한 구성원이 MYSCube 화면에서 볼 수 있는 범위와 같습니다.',
  '사업 이름만 알면 project_search로 projectId를 먼저 찾으세요. 전체 사업을 훑어야 하면(전수조사, 집계) project_list로 모든 사업을 한 번에 받으세요. 금액 단위는 원(KRW)입니다.',
  '전용 도구로 답할 수 없으면 api_catalog에서 맞는 조회를 찾아 api_read로 실행하세요. 목록 결과에 nextCursor가 있으면 cursor로 다음 페이지를 받습니다.',
].join(' ');

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(error, fallback) {
  return { content: [{ type: 'text', text: error instanceof Error && error.message ? error.message : fallback }], isError: true };
}

function tool(server, name, { title, description, input = {}, annotations = READ_ONLY }, run) {
  server.registerTool(name, { title, description, inputSchema: input, annotations }, async (args) => {
    try { return ok(await run(args)); }
    catch (error) { return fail(error, `${title} 조회에 실패했습니다.`); }
  });
}

export function createMyscubeMcpServer({ bff }) {
  const server = new McpServer({ name: 'myscube', version: '1.0.0' }, { instructions: INSTRUCTIONS });

  // /api/v1/projects 는 화면의 사업 목록과 같은 응답이다. 한 요청 안에서만 재사용한다.
  let projectsPromise;
  function listProjects() {
    projectsPromise ||= (async () => {
      const items = [];
      let cursor;
      const seen = new Set();
      for (;;) {
        const body = await bff.get('/api/v1/projects', { limit: PROJECT_PAGE_SIZE, cursor });
        items.push(...(body?.items || []));
        cursor = body?.nextCursor;
        if (!cursor) return { items, complete: true };
        if (seen.has(cursor)) return { items, complete: false };
        seen.add(cursor);
      }
    })();
    return projectsPromise;
  }

  function pick(project, fields) {
    const view = { projectId: project.id };
    for (const field of fields) if (project[field] !== undefined) view[field] = project[field];
    return view;
  }

  function page(items, offset, size, complete) {
    const slice = size === undefined ? items.slice(offset) : items.slice(offset, offset + size);
    const next = offset + slice.length;
    return { total: items.length, offset, count: slice.length, items: slice,
      nextOffset: next < items.length ? next : null, complete: complete && next >= items.length };
  }

  const offset = z.number().int().min(0).optional().describe('건너뛸 건수. 이전 응답의 nextOffset을 넣으면 다음 페이지입니다.');

  tool(server, 'project_list', {
    title: '전체 사업 목록',
    description: '권한 있는 모든 사업을 한 번에 돌려줍니다. 전수조사, CIC·상태별 집계, 이름이 기억나지 않는 사업 찾기에 쓰세요. total은 조건에 맞는 전체 건수이고, complete가 true면 빠진 사업이 없습니다. offset·limit은 나눠 받고 싶을 때만 쓰세요.',
    input: {
      status: z.string().max(40).optional().describe('사업 상태로 거르기. 예: IN_PROGRESS, CONTRACT_PENDING, COMPLETED'),
      cic: z.string().max(100).optional().describe('CIC 이름으로 거르기(정확히 일치)'),
      includeTrashed: z.boolean().optional().describe('true면 삭제된 사업도 포함합니다(기본 제외).'),
      offset,
      limit: z.number().int().min(1).optional().describe('나눠 받을 때 한 번에 받을 건수. 비우면 전부'),
    },
  }, async ({ status, cic, includeTrashed = false, offset: start = 0, limit }) => {
    const { items, complete } = await listProjects();
    const rows = items.filter((item) => (includeTrashed || !item.trashedAt) && (!status || item.status === status) && (!cic || item.cic === cic))
      .map((item) => ({ ...pick(item, PROJECT_SUMMARY_FIELDS), ...(item.trashedAt ? { trashed: true } : {}) }));
    return page(rows, start, limit, complete);
  });

  tool(server, 'project_search', {
    title: '사업 검색',
    description: '사업명, 약칭, 공식 계약명, 그룹웨어 등록명, 발주기관, 담당자, 사업 코드, CIC의 일부로 사업을 찾아 맞는 사업을 모두 돌려줍니다. 여러 사업을 훑어야 할 때는 검색을 반복하지 말고 project_list를 쓰세요.',
    input: {
      query: z.string().trim().min(1).max(100).describe('찾을 단어. 공백으로 나누면 모든 단어를 포함하는 사업만 찾습니다.'),
      includeTrashed: z.boolean().optional().describe('true면 삭제된 사업도 포함합니다(기본 제외).'),
      offset,
      limit: z.number().int().min(1).optional().describe('나눠 받을 때 한 번에 받을 건수. 비우면 전부'),
    },
  }, async ({ query, includeTrashed = false, offset: start = 0, limit }) => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const { items, complete } = await listProjects();
    const searchable = ['name', 'shortName', 'officialContractName', 'groupwareName', 'clientOrg', 'managerName', 'projectCode', 'cic', 'department', 'teamName'];
    const rows = items.filter((item) => (includeTrashed || !item.trashedAt) && terms.every((term) => searchable
      .some((field) => typeof item[field] === 'string' && item[field].toLowerCase().includes(term))))
      .map((item) => ({ ...pick(item, ['name', 'shortName', 'cic', 'status', 'managerName', 'clientOrg']), ...(item.trashedAt ? { trashed: true } : {}) }));
    return page(rows, start, limit, complete);
  });

  tool(server, 'project_get', {
    title: '사업 기본 정보',
    description: '한 사업의 기본 정보(사업명, 상태, 조직·담당자, 발주기관, 계약 기간·금액, 입금계획, 정산 방식)를 돌려줍니다. 첨부·링크·연락처·검토 의견은 포함하지 않습니다.',
    input: { projectId },
  }, async ({ projectId: id }) => {
    const { items } = await listProjects();
    const project = items.find((item) => item.id === id);
    if (!project) throw new Error('사업을 찾을 수 없습니다. project_search로 projectId를 확인하세요.');
    return { ...pick(project, PROJECT_FIELDS), ...(project.trashedAt ? { trashed: true } : {}) };
  });

  tool(server, 'cashflow_status', {
    title: '정산 현황',
    description: '사업들의 한 달 주정산 상태, 월결산 상태, 계획(P)과 실적(A)의 차액을 조회합니다. projectIds를 비우면 삭제되지 않은 모든 사업을 조회합니다(전수조사). 내부적으로 100개씩 나눠 조회해 합칩니다.',
    input: {
      yearMonth,
      projectIds: z.array(projectId).min(1).optional().describe('조회할 projectId 목록. 비우면 전체 사업'),
    },
  }, async ({ yearMonth: month, projectIds }) => {
    const ids = projectIds || (await listProjects()).items.filter((item) => !item.trashedAt).map((item) => item.id);
    const batches = [];
    for (let index = 0; index < ids.length; index += OVERVIEW_BATCH) batches.push(ids.slice(index, index + OVERVIEW_BATCH));
    const results = [];
    for (const batch of batches) results.push(await bff.post('/api/v1/cashflow/weekly-overview', { yearMonth: month, projectIds: batch }));
    const [first = {}] = results;
    return { ...first, projectCount: ids.length, items: results.flatMap((result) => result?.items || []), errors: results.flatMap((result) => result?.errors || []) };
  });

  tool(server, 'accounting_read', {
    title: '사업 입출금',
    description: '한 사업의 월 또는 주차별 계획(Projection)·실적(Actual) 입금, 출금, 누적잔액을 조회합니다. detail=lines면 항목별 금액과 실적−계획 차이를 포함합니다. 원장에 반영된 값이며 Google Sheets의 실시간 값은 아닙니다.',
    input: {
      projectId,
      yearMonth,
      weekNo: z.number().int().min(1).max(5).optional().describe('주차(1~5). 비우면 한 달 전체'),
      detail: z.enum(['summary', 'lines']).optional().describe('summary(주별 합계, 기본) 또는 lines(항목별)'),
    },
  }, async (input) => {
    const parsed = accountingInput.parse(input);
    const snapshot = await bff.get(`/api/v1/cashflow/${encodeURIComponent(parsed.projectId)}`, { yearMonth: parsed.yearMonth });
    return accountingEvidence(snapshot, parsed);
  });

  tool(server, 'sheet_check', {
    title: '사업비 시트 양식 검사',
    description: '사업의 사업비 관리 시트(cashflow 탭)를 지금 읽어 표준 양식과 다른 곳을 찾습니다. verdict는 OK, NEEDS_FIX, NOT_CONFIGURED 중 하나이고, issues의 sourceCell은 시트 칸 주소, message는 고칠 내용입니다. saved는 마지막 불러오기의 상태와 오류입니다. 시트와 MYSCube에 아무것도 저장하지 않습니다.',
    input: { projectId, sourceYear: z.number().int().min(2000).max(2100).optional().describe('검사할 시트의 사업 연도. 비우면 기본 시트') },
    annotations: { ...READ_ONLY, idempotentHint: false, openWorldHint: true },
  }, ({ projectId: id, sourceYear }) => bff.get(`/api/v1/projects/${encodeURIComponent(id)}/cashflow-sheet-lab/inspect`, { sourceYear }));

  tool(server, 'api_catalog', {
    title: '조회 가능한 API 목록',
    description: '전용 도구로 답할 수 없을 때 쓸 수 있는 추가 조회 API 목록을 돌려줍니다. 항목마다 id, 해시태그, 설명, params(JSON Schema)가 있습니다. tag나 keyword로 좁힐 수 있고, 고른 id는 api_read로 실행합니다.',
    input: {
      tag: z.string().max(40).optional().describe('해시태그로 거르기. 예: #월결산'),
      keyword: z.string().max(100).optional().describe('id나 설명에 들어간 단어로 거르기'),
    },
  }, async ({ tag, keyword }) => {
    const needle = keyword?.toLowerCase();
    const wanted = tag && (tag.startsWith('#') ? tag : `#${tag}`);
    const items = API_CATALOG.filter((entry) => (!wanted || entry.tags.includes(wanted))
      && (!needle || entry.id.includes(needle) || entry.description.toLowerCase().includes(needle))).map(catalogView);
    return { version: API_CATALOG_VERSION, tags: [...new Set(API_CATALOG.flatMap((entry) => entry.tags))], items };
  });

  tool(server, 'api_read', {
    title: '목록의 API 조회',
    description: 'api_catalog에 있는 조회 API 하나를 실행합니다. params는 그 항목의 params 형식을 따릅니다. 목록에 없는 id는 실행되지 않습니다. 결과의 링크·이메일·파일 위치 필드는 제거됩니다.',
    input: {
      id: z.enum(API_CATALOG.map((entry) => entry.id)).describe('api_catalog의 id'),
      params: z.record(z.string(), z.unknown()).optional().describe('그 항목의 params에 맞춘 값'),
    },
  }, async ({ id, params = {} }) => {
    const entry = API_CATALOG.find((candidate) => candidate.id === id);
    const parsed = entry.schema.safeParse(params);
    if (!parsed.success) {
      throw new Error(`params가 형식과 다릅니다: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(전체)'} ${issue.message}`).join('; ')}`);
    }
    const args = parsed.data;
    const query = Object.fromEntries((entry.query || []).map((key) => [key, args[key]]));
    return { id, data: redact(await bff.get(entry.path(args), query)) };
  });

  return server;
}
