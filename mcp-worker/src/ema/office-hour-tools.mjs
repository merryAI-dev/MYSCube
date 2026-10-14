import * as z from 'zod/v4';
import { tool } from './tool-kit.mjs';

// 오피스아워 현황 조회(읽기 전용). 관리자는 전체, 컨설턴트는 본인 담당 건만 보인다(EMA 함수가 판단).
// 파일(엑셀·워드 등)이 필요하면 조회 결과로 AI가 직접 만든다. 이 서비스는 파일을 만들지 않는다.
export function registerOfficeHourTools(server, { ema }) {
  const dateShape = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).describe('YYYY-MM-DD');
  const filterShape = {
    from: dateShape.optional().describe('이 날짜부터(진행일 기준)'),
    to: dateShape.optional().describe('이 날짜까지'),
    programId: z.string().max(128).optional().describe('사업(프로그램) ID'),
    companyId: z.string().max(128).optional().describe('기업 ID'),
    consultantId: z.string().max(128).optional().describe('컨설턴트 계정 ID(관리자만 의미 있음)'),
    status: z.string().max(40).optional().describe('상태. 예: completed(완료), confirmed(확정), pending, cancelled'),
    performanceType: z.string().max(40).optional().describe('실적 유형. 예: type1'),
    hasReport: z.boolean().optional().describe('true=보고서 있는 건만, false=보고서 없는 건만. 지정하지 않으면 모두'),
    query: z.string().max(100).optional().describe('기업명·주제·컨설턴트·보고서 내용에서 찾을 말'),
  };

  tool(server, 'ema_office_hour_summary', {
    title: '오피스아워 진행 현황 집계',
    description: '조건에 맞는 오피스아워의 진행 횟수와 시간을 집계합니다(상태별·사업별·기업별·컨설턴트별·월별). "진행횟수", "몇 건", "보고서 안 쓴 건" 같은 질문은 이 도구로 먼저 답하세요. 진행 횟수는 completed 기준입니다.',
    input: filterShape,
  }, (filters) => ema.call('queryOfficeHourForMcp', { op: 'summary', filters }));

  tool(server, 'ema_office_hour_list', {
    title: '오피스아워 목록 조회',
    description: '조건에 맞는 오피스아워를 최신순으로 보여 줍니다. includeContent=true면 건마다 보고서 내용(주제·내용·후속 조치·참석자)을 함께 돌려주며, 내용 모음이나 다운로드용 파일을 만들 때 쓰세요. 결과가 많으면 nextOffset이 있으니 null이 될 때까지 offset으로 이어서 가져오세요.',
    input: {
      ...filterShape,
      includeContent: z.boolean().optional().describe('보고서 내용 포함 여부(기본 false)'),
      offset: z.number().int().min(0).optional().describe('이전 응답의 nextOffset'),
      pageSize: z.number().int().min(1).optional().describe('한 번에 가져올 건수(기본 100)'),
    },
  }, ({ includeContent, offset, pageSize, ...filters }) =>
    ema.call('queryOfficeHourForMcp', { op: 'list', filters, includeContent, offset, pageSize }));

  tool(server, 'ema_office_hour_get', {
    title: '오피스아워 기록·보고서 보기',
    description: '오피스아워 한 건의 기본 정보와 보고서 전문(주제·내용·후속 조치·참석자·만족도)을 돌려줍니다. 회의록 원문은 includeRaw=true일 때만 포함합니다.',
    input: {
      id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u).describe('ema_office_hour_list의 id'),
      includeRaw: z.boolean().optional().describe('회의록 원문 포함 여부(기본 false)'),
    },
  }, ({ id, includeRaw }) => ema.call('queryOfficeHourForMcp', { op: 'detail', id, includeRaw }));
}
