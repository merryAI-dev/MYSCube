import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { runImportCommit } from './commit.mjs';
import { registerMeetingTools } from './meeting-tools.mjs';
import { READ_ONLY, tool, WRITES } from './tool-kit.mjs';
import { buildCsv, buildWorkbook, buildXlsx } from './xlsx.mjs';

// EMA Station 기업 등록(FRN) 도구. 데이터는 로그인한 구성원 본인의 권한으로 EMA 함수에서만 읽고 쓴다.
// 현황 조회가 기본 진입점이고, 쓰기는 "미리보기 → 사용자 확인 → 등록" 두 단계로만 한다.

const PREVIEW_SAMPLE_NEW_ROWS = 20;

const ROUTE_TYPES = ['AC_SELECTED_TEAM', 'AC_APPLICANT_TEAM', 'COLD_CALL', 'EXTERNAL_JUDGE_REFERRAL', 'EXTERNAL_JUDGING_ENCOUNTER', 'INTERACTION'];

// EMA 화면의 "FRN 발급" 양식과 같은 섹터·국가 목록.
export const SECTORS = [
  ['AGF', '농식품·수산식품'], ['AIR', 'AI·로봇·자동화'], ['CLT', '기후테크·환경'], ['CLF', '문화·라이프스타일'],
  ['DIT', '딥테크·산업혁신'], ['EDU', '교육·콘텐츠'], ['FIN', '금융포용·핀테크'], ['GBL', '글로벌·국제개발'],
  ['HCR', '헬스케어·돌봄'], ['INF', '인프라·에너지·모빌리티'], ['LCL', '로컬·지역재생'], ['SPI', '사회혁신·공공혁신'], ['OTH', '미분류'],
];
export const OVERSEAS_COUNTRIES = [
  ['VN', '베트남'], ['SG', '싱가포르'], ['JP', '일본'], ['ID', '인도네시아'], ['IN', '인도'], ['PH', '필리핀'], ['US', '미국'],
  ['FR', '프랑스'], ['HK', '홍콩'], ['TH', '태국'], ['MN', '몽골'], ['BD', '방글라데시'], ['SN', '세네갈'], ['TW', '대만'],
];
const TEMPLATE_HEADERS = ['기업명', '대표자/창업자', '섹터', '지역', '국가(해외만)'];
const TEMPLATE_ROWS = 1000;

const INSTRUCTIONS = [
  'EMA Station 스타트업 등록(FRN) 데이터를 다룹니다. 현황·개수·"어때?" 같은 일반 질문은 먼저 ema_registry_status를 호출하세요.',
  '특정 기업은 ema_registry_search로 찾고 ema_registry_get으로 상세를 봅니다. 연락처·사업자번호 전체는 AI에게 보이지 않으며 다운로드 파일에만 들어갑니다.',
  '등록에 필요한 것은 EMA 화면의 "FRN 발급"과 같습니다: 기업명, 대표자/창업자, 섹터(이름이나 코드), 지역(국내/해외, 해외면 국가). 이 3~4가지만 있으면 되고 법인명·설립연도·홈페이지·발굴 경로 등은 묻지 마세요.',
  '발굴 경로는 자동으로 정해지므로 사용자에게 묻거나 열로 요구하지 마세요. 형식을 만들어 달라고 하면 긴 열 목록을 만들지 말고 ema_registry_import_template으로 양식 파일 링크를 주세요.',
  '엑셀로 여러 기업을 등록하려면: 파일이 작으면 대화에 올린 표를 rows로 넘겨 ema_registry_import_preview를 부르고, 크면 ema_registry_import_upload_link로 업로드 링크를 받으세요.',
  '등록은 반드시 미리보기 결과를 사용자에게 보여 주고 확인받은 뒤에만 하세요. 기본은 ema_registry_import_confirm_link로 웹 확정 링크를 받아 사용자가 화면에서 "등록 확정"을 누르게 하는 방식이고, 대화 안에서 직접 등록이 허용되는 환경에서만 ema_registry_import_commit을 쓸 수 있습니다.',
  '엑셀 내려받기는 ema_registry_export로 다운로드 링크를 만들어 사용자에게 전달합니다(파일 내용은 대화에 싣지 않습니다).',
  '컨설턴트·관리자는 회의록으로 보고서 초안을 만들 수 있습니다: 사용자의 Gmail·Drive·Calendar 커넥터(Meet 노트, 회의록 메일)나 Tiro MCP로 회의록을 먼저 읽고, 그 텍스트를 ema_meeting_draft_create에 넘기세요. 초안은 원장에 쓰이지 않으며 사용자가 EMA 화면 "회의록 추가 → 초안 불러오기"에서 확정합니다. 새로 올릴 때 "미작성"으로 거르지 마세요.',
].join(' ');

export function maskBusinessNumber(value) {
  const digits = String(value ?? '').replace(/\D/gu, '');
  return digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-*****` : value ? '(형식 확인 필요)' : '';
}

// AI 대화에 실어도 되는 필드만 남긴다. 연락처·사업자번호 전체·사업 소개 전문은 파일로만 나간다.
function conciseCompany(company) {
  return {
    frn: company.frn,
    name: company.displayName || company.companyName || company.legalName || '',
    legalName: company.legalName || '',
    founder: company.founderName || '',
    owner: company.owner || company.primaryContactName || '',
    sector: company.programCode || company.sectorCode || '',
    country: company.countryCode || '',
    stage: company.stage || '',
    status: company.status || 'ACTIVE',
    completeness: company.completeness ?? null,
    tier: company.completenessTier || '',
    businessNumber: maskBusinessNumber(company.businessRegistrationNo || company.businessNumber),
    updatedAt: company.updatedAt || '',
  };
}

const filterShape = {
  query: z.string().max(100).optional().describe('기업명·법인명·창업자·담당자·FRN의 일부(공백으로 나누면 모두 포함)'),
  sectorCode: z.string().max(20).optional().describe('섹터 코드. 예: AIR'),
  countryCode: z.string().length(2).optional().describe('국가 코드(영문 2자). 예: KR'),
  year: z.number().int().min(2000).optional().describe('등록 연도'),
  owner: z.string().max(60).optional().describe('내부 담당자 이름의 일부'),
  status: z.string().max(20).optional().describe('상태. 예: ACTIVE'),
  completenessMin: z.number().min(0).max(100).optional().describe('완성도 최소값(0~100)'),
  updatedAfter: z.string().max(30).optional().describe('이 시각 이후 수정된 기업만(ISO 날짜). 예: 2026-09-01'),
};

const rowShape = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export function createEmaMcpServer({ ema, store, publicOrigin, access, now = () => Date.now() }) {
  const server = new McpServer({ name: 'ema-station', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const isAdmin = access.canExportAndImport === true;

  tool(server, 'ema_registry_status', {
    title: '등록 현황',
    description: '스타트업 등록 현황 요약(기본 진입점). 전체 기업 수, 섹터·국가·연도·완성도 등급·출처별 건수, 빠진 정보 건수, 중복 의심 묶음, 최근 수정 기업. 삭제된 기업은 제외합니다.',
    input: { recentCount: z.number().int().min(0).optional().describe('최근 수정 기업을 몇 건 볼지(기본 10)') },
  }, ({ recentCount }) => ema.call('getRegistryStatusSummary', recentCount === undefined ? {} : { recentCount }));

  tool(server, 'ema_registry_search', {
    title: '기업 검색',
    description: '기업명·법인명·창업자·담당자·FRN으로 기업을 찾습니다. 연락처와 사업자번호 전체는 보여 주지 않습니다(사업자번호는 가려서 표시). 많은 기업을 한 번에 보려면 ema_registry_export를 쓰세요.',
    input: { query: z.string().min(1).max(100).describe('찾을 단어. 기업명·법인명·창업자·담당자·FRN의 일부') },
  }, async ({ query }) => {
    const result = await ema.call('listRegistryCompanies', { queryText: query, limit: 500 });
    const companies = (result?.companies ?? []).map(conciseCompany);
    return { total: companies.length, possiblyIncomplete: companies.length >= 500, companies };
  });

  tool(server, 'ema_registry_get', {
    title: '기업 상세',
    description: 'FRN 하나의 기업 정보와 등록·상호작용 이력을 보여 줍니다. 연락처와 사업자번호 전체는 가려집니다.',
    input: { frn: z.string().min(3).max(60).describe('기업의 FRN. 예: AIR-KR-26-001') },
  }, async ({ frn }) => {
    const result = await ema.call('getRegistryCompanyDetail', { frn });
    return {
      company: {
        ...conciseCompany(result.company),
        website: result.company?.website || '',
        businessSummary: String(result.company?.businessSummary || '').slice(0, 600),
        routeTypes: result.company?.routeTypes ?? [],
        sourceRecordCount: result.company?.sourceRecordCount ?? 0,
      },
      history: (result.history ?? []).map((entry) => ({
        date: entry.date, type: entry.type, interactionType: entry.interactionType || '',
        note: String(entry.note || '').slice(0, 300), by: entry.contributorName || '',
      })),
    };
  });

  if (isAdmin) {
    tool(server, 'ema_registry_export', {
      title: '엑셀·CSV 내려받기',
      description: '조건에 맞는 기업 목록을 엑셀(.xlsx) 또는 CSV 파일로 만들어 다운로드 링크를 돌려줍니다. 링크는 한 번만 쓸 수 있고 15분 뒤 만료됩니다. 파일에는 연락처·사업자번호 등 전체 정보가 들어가므로 내용은 대화에 싣지 않고 링크만 사용자에게 전달하세요. 조건을 비우면 전체입니다.',
      input: {
        format: z.enum(['xlsx', 'csv']).optional().describe('파일 형식(기본 xlsx)'),
        ...filterShape,
      },
    }, async ({ format = 'xlsx', ...filters }) => {
      const exported = await ema.call('exportRegistryRows', { filters });
      const date = new Date(now()).toISOString().slice(0, 10);
      const base = `EMA-기업등록-${date}`;
      const payload = format === 'csv'
        ? { name: `${base}.csv`, contentType: 'text/csv; charset=utf-8', bytes: new TextEncoder().encode(buildCsv(exported)) }
        : { name: `${base}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          bytes: buildXlsx({ sheetName: '기업 목록', headers: exported.headers, rows: exported.rows }) };
      const { token, expiresInMinutes } = await store.saveFile(access.uid, payload);
      return {
        total: exported.total,
        filters: exported.filters,
        fileName: payload.name,
        downloadUrl: `${publicOrigin}/files/${token}`,
        expiresInMinutes,
        singleUse: true,
        columns: exported.headers,
      };
    });

    tool(server, 'ema_registry_import_template', {
      title: '등록 양식 받기',
      description: '일괄 등록용 엑셀 양식(.xlsx)의 다운로드 링크를 돌려줍니다. 열은 기업명, 대표자/창업자, 섹터, 지역(국내/해외), 국가(해외만) 5개뿐이고 섹터·지역은 드롭다운, 두 번째 시트에 섹터 코드표가 있습니다. 링크는 한 번만 쓸 수 있고 15분 뒤 만료됩니다. 사용자가 양식을 요청하면 열 목록을 직접 만들지 말고 이 도구를 쓰세요.',
    }, async () => {
      const sheets = [
        {
          name: '등록',
          headers: TEMPLATE_HEADERS,
          rows: [],
          validations: [
            { ref: `C2:C${TEMPLATE_ROWS}`, list: SECTORS.map(([, label]) => label) },
            { ref: `D2:D${TEMPLATE_ROWS}`, list: ['국내', '해외'] },
            { ref: `E2:E${TEMPLATE_ROWS}`, list: OVERSEAS_COUNTRIES.map(([, label]) => label) },
          ],
        },
        { name: '섹터 코드표', headers: ['섹터', '코드'], rows: SECTORS.map(([code, label]) => [label, code]) },
        {
          name: '작성 안내',
          headers: ['안내'],
          rows: [
            ['기업명, 대표자/창업자, 섹터 3가지만 있으면 등록할 수 있습니다.'],
            ['지역은 국내/해외 중에서 고르고, 해외면 국가를 함께 고르세요(비우면 국내).'],
            ['섹터를 비우면 "미분류"로 등록됩니다.'],
            ['이미 등록된 기업은 새로 만들지 않고 기존 FRN에 연결됩니다.'],
          ],
        },
      ];
      const payload = {
        name: 'EMA-기업등록-양식.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: buildWorkbook(sheets),
      };
      const { token, expiresInMinutes } = await store.saveFile(access.uid, payload);
      return {
        fileName: payload.name,
        downloadUrl: `${publicOrigin}/files/${token}`,
        expiresInMinutes,
        singleUse: true,
        columns: TEMPLATE_HEADERS,
        next: '사용자가 양식을 채워 업로드하면 ema_registry_import_upload_link → ema_registry_import_preview 순서로 진행하세요.',
      };
    });

    tool(server, 'ema_registry_import_upload_link', {
      title: '엑셀 업로드 링크',
      description: '큰 엑셀 파일을 올릴 1회용 업로드 링크를 만듭니다(15분). 사용자가 링크에서 파일을 올리면 읽은 내용이 배치로 저장되고, 그 batchId로 ema_registry_import_preview를 호출합니다. 파일이 작고 대화에 표가 이미 있으면 링크 없이 rows를 바로 넘기세요.',
    }, async () => {
      const { token, expiresInMinutes } = await store.createUploadLink(access.uid);
      return {
        uploadUrl: `${publicOrigin}/upload/${token}`,
        expiresInMinutes,
        singleUse: true,
        next: '사용자에게 링크를 전달하고, 업로드를 마쳤다고 하면 ema_registry_import_preview를 호출하세요(batchId는 업로드 완료 화면에 표시됩니다).',
      };
    });

    tool(server, 'ema_registry_import_preview', {
      title: '일괄 등록 미리보기',
      description: '엑셀 내용을 검증하고 기존 기업과의 중복을 판정합니다. 아무것도 등록하지 않습니다. 필수 값은 기업명·대표자/창업자(+섹터, 지역)뿐이며 열 이름은 한글/영문 어느 쪽이든 인식합니다. 발굴 경로·법인명 등은 요구하지 마세요. 결과의 상태: new(신규 등록), match(기존 기업에 근거 추가), match_deleted(삭제된 기업과 같음, 건너뜀), match_migrated(이관 기업과 같음, 건너뜀), duplicate_in_batch(같은 파일 안 중복, 건너뜀), invalid(오류, 건너뜀). batchId(업로드한 파일) 또는 rows(대화의 표) 중 하나를 넘깁니다.',
      input: {
        batchId: z.string().max(80).optional().describe('업로드 링크로 올린 파일의 배치 ID'),
        rows: z.array(rowShape).min(1).optional().describe('열 이름 → 값 객체의 배열. 첫 행이 머리글인 표를 객체로 바꿔 넘깁니다.'),
        routeType: z.enum(ROUTE_TYPES).optional().describe('발굴 경로. 보통 비워 두세요(자동으로 정해짐). 사용자가 직접 지정한 경우에만 쓰세요.'),
        sourceYear: z.number().int().min(2000).optional().describe('등록 연도 일괄값(비우면 올해)'),
        programCode: z.string().max(20).optional().describe('섹터 일괄값(코드 또는 이름). 섹터 열이 비었을 때만 적용'),
        countryCode: z.string().length(2).optional().describe('국가 코드 일괄값(비우면 KR)'),
        detail: z.enum(['problems', 'all']).optional().describe('problems(기본): 신규가 아닌 행은 모두, 신규는 일부만. all: 전부'),
      },
    }, async ({ batchId, rows, detail = 'problems', ...defaults }) => {
      let batch;
      let id = batchId;
      if (id) {
        batch = await store.loadBatch(id, access.uid);
        if (!batch) throw new Error('배치를 찾을 수 없거나 만료됐습니다. 업로드 링크를 다시 받아 올려 주세요.');
      } else if (rows) {
        batch = { uid: access.uid, source: 'chat', rows, rowNumbers: rows.map((_, index) => index + 1) };
      } else {
        throw new Error('batchId(업로드한 파일) 또는 rows(대화의 표) 중 하나가 필요합니다.');
      }
      const preview = await ema.call('previewRegistryImport', { rows: batch.rows, defaults });
      const sheetRow = (index) => batch.rowNumbers?.[index] ?? index + 1;
      const items = preview.items.map((item) => ({
        index: item.index, sheetRow: sheetRow(item.index), name: item.record.displayName || item.record.legalName || '',
        status: item.status, action: item.action, record: item.record, errors: item.errors, warnings: item.warnings,
        match: item.match, duplicateOfSheetRow: item.duplicateOfRow ? sheetRow(item.duplicateOfRow - 1) : null,
      }));
      const saved = { ...batch, defaults, preview: { generatedAt: preview.generatedAt, summary: preview.summary, items }, commit: undefined };
      if (id) await store.saveBatch(id, saved);
      else id = await store.createBatch(access.uid, saved);

      const brief = (item) => ({
        sheetRow: item.sheetRow, name: item.name, status: item.status, action: item.action,
        ...(item.match ? { matchFrn: item.match.frn, matchName: item.match.name, matchedBy: item.match.matchField } : {}),
        ...(item.duplicateOfSheetRow ? { duplicateOfSheetRow: item.duplicateOfSheetRow } : {}),
        ...(item.errors.length ? { errors: item.errors } : {}),
        ...(item.warnings.length ? { warnings: item.warnings } : {}),
      });
      const fresh = items.filter((item) => item.status === 'new');
      return {
        batchId: id,
        source: batch.source,
        rowCount: preview.summary.rowCount,
        summary: preview.summary,
        problems: items.filter((item) => item.status !== 'new').map(brief),
        newRows: (detail === 'all' ? fresh : fresh.slice(0, PREVIEW_SAMPLE_NEW_ROWS)).map(brief),
        newRowsShown: detail === 'all' ? fresh.length : Math.min(fresh.length, PREVIEW_SAMPLE_NEW_ROWS),
        next: '요약과 문제 행을 사용자에게 보여 주고 확인받으세요. 확인되면 ema_registry_import_commit({ batchId })를 호출합니다. 빼고 싶은 행은 excludeRows(sheetRow 번호)로 넘깁니다.',
      };
    });

    tool(server, 'ema_registry_import_commit', {
      title: '일괄 등록 실행',
      description: '미리보기를 사용자에게 보여 주고 확인받은 뒤에만 호출하세요. 미리보기의 new는 새 FRN으로 등록하고, match는 기존 기업에 근거를 추가합니다(기존 값은 덮어쓰지 않고 빈 칸만 채움). 같은 batchId로 다시 호출해도 이미 처리한 행은 중복 등록되지 않으며, 시간이 오래 걸리면 remaining이 남고 다시 호출하면 이어서 처리합니다. 기본적으로 기여 크레딧은 부여하지 않습니다.',
      annotations: WRITES,
      input: {
        batchId: z.string().max(80).describe('ema_registry_import_preview가 돌려준 batchId'),
        excludeRows: z.array(z.number().int().min(1)).optional().describe('등록에서 뺄 행의 sheetRow 번호'),
        awardCredits: z.boolean().optional().describe('true면 등록한 관리자에게 기여 크레딧을 부여합니다(기본 false). 사용자가 명시적으로 원할 때만.'),
      },
    }, ({ batchId, excludeRows = [], awardCredits = false }) => runImportCommit({ ema, store, uid: access.uid, batchId, excludeRows, awardCredits, now }));

    tool(server, 'ema_registry_import_confirm_link', {
      title: '등록 확정 링크',
      description: '미리보기를 사용자에게 보여 주고 등록 의사를 확인받은 뒤 이 도구로 웹 확정 화면 링크를 만듭니다. 이 도구는 아무것도 등록하지 않습니다. 사용자가 링크를 열어 화면에서 "등록 확정"을 눌러야 실제 등록이 됩니다. 링크는 15분 뒤 만료됩니다. ChatGPT처럼 대화 안에서 등록 도구가 차단되는 환경에서는 ema_registry_import_commit 대신 이 도구를 쓰세요.',
      input: {
        batchId: z.string().max(80).describe('ema_registry_import_preview가 돌려준 batchId'),
        excludeRows: z.array(z.number().int().min(1)).optional().describe('등록에서 뺄 행의 sheetRow 번호'),
      },
    }, async ({ batchId, excludeRows = [] }) => {
      const batch = await store.loadBatch(batchId, access.uid);
      if (!batch?.preview) throw new Error('이 배치는 미리보기가 없습니다. 먼저 ema_registry_import_preview를 호출하세요.');
      if (!access.idToken) throw new Error('로그인 정보를 확인하지 못했습니다. AI 앱에서 연결을 다시 해 주세요.');
      const { token, expiresInMinutes } = await store.createConfirmLink({
        uid: access.uid, batchId, excludeRows, idToken: access.idToken, idTokenExpiresAt: access.idTokenExpiresAt,
      }, now());
      return {
        confirmUrl: `${publicOrigin}/confirm/${token}`,
        expiresInMinutes,
        summary: batch.preview.summary,
        next: '사용자에게 링크를 전달하세요. 링크의 화면에서 "등록 확정"을 누르면 등록됩니다. 사용자가 완료했다고 말하면 ema_registry_status로 확인할 수 있습니다.',
      };
    });
  }

  // 회의록 초안함은 관리자와 활성 컨설턴트만 쓴다(최종 권한 판단은 EMA 함수가 한다).
  if (['admin', 'consultant'].includes(access.role)) registerMeetingTools(server, { ema });

  return server;
}
