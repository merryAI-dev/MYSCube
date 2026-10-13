import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { accountingInput, accountingEvidence } from './accounting-read.mjs';
import { API_CATALOG, API_CATALOG_VERSION, PROJECT_FIELDS, catalogView, cursor, limit, projectId, redact, yearMonth } from './api-catalog.mjs';

export { API_CATALOG_VERSION };

// 원격 MCP 의 모든 도구는 OAuth 로 확인된 본인 context 로 실행된다. Slack 봇의 감사 계정(auditor)은
// 쓰지 않으므로, 각 도구가 보여주는 범위는 MYSCube 앱 화면과 같다. 모든 도구는 읽기 전용이다.

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const PROJECT_SEARCH_SCAN_LIMIT = 1000;
const PROJECT_SEARCH_RESULT_LIMIT = 20;
const MAX_RESULT_CHARS = 100_000;

function ok(data) {
  const text = JSON.stringify(data);
  if (text.length <= MAX_RESULT_CHARS) return { content: [{ type: 'text', text }] };
  return { content: [{ type: 'text', text: JSON.stringify({ truncated: true,
    message: `결과가 ${MAX_RESULT_CHARS}자를 넘어 잘랐습니다. limit를 줄이거나 범위를 좁혀 다시 조회하세요.`,
    partial: text.slice(0, MAX_RESULT_CHARS) }) }] };
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

export function createRemoteMcpServer({ context, db, readWeeklyOverview, readCashflowSnapshot, inspectCashflowSheet, readApi, isProjectVisible }) {
  const tenantId = context.tenantId;
  const server = new McpServer({ name: 'myscube', version: '0.3.0' }, {
    instructions: 'MYSCube 사업관리 데이터를 읽기 전용으로 조회합니다. 사업 이름만 알면 project_search로 projectId를 먼저 찾으세요. '
      + '전용 도구로 답할 수 없으면 api_catalog에서 맞는 조회를 찾아 api_read로 실행하세요. 모든 결과는 로그인한 사용자의 권한 범위 안의 데이터입니다. 금액 단위는 원(KRW)입니다. 목록 도구는 nextCursor가 있으면 cursor로 다음 페이지를 받습니다.',
  });

  async function assertVisible(id) {
    if (!await isProjectVisible(id)) throw new Error('이 프로젝트에 접근할 권한이 없습니다.');
  }

  tool(server, 'project_search', {
    title: '사업 검색',
    description: '사업명이나 약칭의 일부로 권한 있는 사업을 찾아 projectId, 사업명, CIC, 상태를 돌려줍니다. 최대 20건이며 truncated가 true면 검색어를 더 구체적으로 바꾸세요.',
    input: { query: z.string().trim().min(1).max(100).describe('사업명 또는 약칭의 일부') },
  }, async ({ query }) => {
    const needle = query.toLowerCase();
    const scanned = await db.collection(`orgs/${tenantId}/projects`)
      .select('name', 'shortName', 'cic', 'status', 'trashedAt').limit(PROJECT_SEARCH_SCAN_LIMIT).get();
    const items = [];
    for (const doc of scanned.docs) {
      const data = doc.data() || {};
      if (data.trashedAt || ![data.name, data.shortName].some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))) continue;
      if (!await isProjectVisible(doc.id)) continue;
      items.push({ projectId: doc.id, name: data.name || '', shortName: data.shortName || null, cic: data.cic || null, status: data.status || null });
    }
    return { items: items.slice(0, PROJECT_SEARCH_RESULT_LIMIT),
      truncated: scanned.docs.length === PROJECT_SEARCH_SCAN_LIMIT || items.length > PROJECT_SEARCH_RESULT_LIMIT };
  });

  tool(server, 'project_get', {
    title: '사업 기본 정보',
    description: '한 사업의 기본 정보(사업명, 상태, 조직·담당자, 발주기관, 계약 기간·금액, 입금계획, 정산 방식)를 돌려줍니다. 첨부·링크·연락처·검토 의견은 포함하지 않습니다.',
    input: { projectId },
  }, async ({ projectId: id }) => {
    await assertVisible(id);
    const snapshot = await db.doc(`orgs/${tenantId}/projects/${id}`).get();
    const data = snapshot.exists ? snapshot.data() || {} : null;
    if (!data || data.trashedAt) throw new Error('사업을 찾을 수 없습니다.');
    const view = { projectId: id };
    for (const field of PROJECT_FIELDS) if (data[field] !== undefined) view[field] = data[field];
    return view;
  });

  tool(server, 'cashflow_status', {
    title: '정산 현황',
    description: '여러 사업의 한 달 주정산 상태, 월결산 상태, 계획(P)과 실적(A)의 차액을 한 번에 조회합니다.',
    input: { yearMonth, projectIds: z.array(projectId).min(1).max(100).describe('조회할 projectId 목록(최대 100개)') },
  }, ({ yearMonth: month, projectIds }) => readWeeklyOverview({ context, body: { yearMonth: month, projectIds } }));

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
    const snapshot = await readCashflowSnapshot({ context, params: { projectId: parsed.projectId }, query: { yearMonth: parsed.yearMonth } });
    return accountingEvidence(snapshot, parsed);
  });

  if (inspectCashflowSheet) {
    tool(server, 'sheet_check', {
      title: '사업비 시트 양식 검사',
      description: '사업의 사업비 관리 시트(cashflow 탭)를 지금 읽어 표준 양식과 다른 곳을 찾습니다. verdict는 OK, NEEDS_FIX, NOT_CONFIGURED 중 하나이고, issues의 sourceCell은 시트 칸 주소, message는 고칠 내용입니다. saved는 마지막 불러오기의 상태와 오류입니다. 시트와 MYSCube에 아무것도 저장하지 않습니다.',
      input: { projectId, sourceYear: z.number().int().min(2000).max(2100).optional().describe('검사할 시트의 사업 연도. 비우면 기본 시트') },
      annotations: { ...READ_ONLY, idempotentHint: false, openWorldHint: true },
    }, async ({ projectId: id, sourceYear }) => {
      await assertVisible(id);
      return inspectCashflowSheet({ context, projectId: id, sourceYear });
    });
  }

  if (readApi) {
    tool(server, 'api_catalog', {
      title: '조회 가능한 API 목록',
      description: '이 서버의 전용 도구로 답할 수 없을 때 쓸 수 있는 추가 조회 API 목록을 돌려줍니다. 항목마다 id, 해시태그, 설명, params(JSON Schema)가 있습니다. tag나 keyword로 좁힐 수 있습니다. 고른 id는 api_read로 실행합니다.',
      input: {
        tag: z.string().max(40).optional().describe('해시태그로 거르기. 예: #월결산'),
        keyword: z.string().max(100).optional().describe('id나 설명에 들어간 단어로 거르기'),
      },
    }, async ({ tag, keyword }) => {
      const needle = keyword?.toLowerCase();
      const items = API_CATALOG.filter((entry) => (!tag || entry.tags.includes(tag.startsWith('#') ? tag : `#${tag}`))
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
      if (args.projectId) await assertVisible(args.projectId);
      const query = Object.fromEntries((entry.query || []).map((key) => [key, args[key]]));
      const { status, body } = await readApi(entry.path(args), query);
      if (status >= 400) throw new Error(body?.message || body?.error || `조회 실패(HTTP ${status})`);
      return { id, data: redact(body) };
    });
  }

  return server;
}
