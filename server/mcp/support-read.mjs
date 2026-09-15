import * as z from 'zod/v4';
import { verifyAgentTrace } from './agent-trace.mjs';

// Reviewed code knowledge, not executable instructions or unrestricted repository access.
export const SUPPORT_KNOWLEDGE = Object.freeze([
  { topic: 'connectivity', title: '권한·연결·호출 제한과 응답 오류',
    codes: ['jvm_weekly_api_unreachable', 'jvm_weekly_api_unconfigured', 'jvm_weekly_api_internal_error', 'java_weekly_api_error', 'jvm_weekly_project_mismatch', 'jvm_weekly_response_invalid', 'jvm_weekly_response_too_large', 'jvm_weekly_data_project_mismatch', 'cashflow_month_close_route_timeout'],
    facts: ['401/403은 인증·권한 거부이며 정산 미완료가 아닙니다. 권한을 자동 확대하지 않습니다.',
      '429는 호출 제한입니다. 금액이나 시트 오류로 단정하지 않습니다.',
      '연결 실패와 응답 시간 초과는 구분하며, 5xx는 상위 서비스 실패입니다. 오류 하나로 전체 사업의 상태를 판단하지 않습니다.',
      '사업 ID 불일치·잘못된 응답·표현 범위를 넘는 금액은 자료를 사용하지 않습니다.'],
    nextSteps: ['권한 오류는 활성 계정과 사업 접근 범위를 관리자에게 확인하세요.', '호출 제한은 재시도 가능 시각이 있으면 그 이후 확인하세요. 반복 호출하지 마세요.', '연결·시간 초과는 서비스 상태와 발생 시각을 확인하세요. 조회 실패를 이유로 시트를 수정하지 마세요.'],
    sources: ['server/bff/java-weekly-client.mjs', 'server/bff/cashflow-project-scope.mjs'] },
  { topic: 'accounting', title: '회계 금액 조회 경로',
    codes: ['accounting_amount_invalid', 'accounting_source_mismatch', 'accounting_weekly_scope_invalid', 'accounting_read_model_invalid', 'accounting_duplicate_month', 'accounting_mode_invalid', 'accounting_week_invalid', 'accounting_lines_invalid', 'cashflow_accounting_source_unavailable', 'cashflow_accounting_annual_scope', 'cashflow_project_not_found'],
    facts: ['시트 가져오기와 JVM 반영은 별도 작업입니다. 에이전트 조회는 가져오기·반영을 실행하지 않습니다.',
      'MYSC 내규상 회계 원장 금액은 KRW(원화)입니다. JVM 응답에 통화 필드가 없어도 이 정책으로 해석하며 환산을 수행한 것이 아닙니다.',
      'JVM에 반영된 Projection/Actual을 조회합니다. 현재 Google Sheets 화면의 최신 셀과 같다고 보장하지 않습니다.',
      '주별 좌표는 E:BL 60칸, 연간 좌표는 C:D 및 BM:BR입니다. 연간 값을 주차 합계로 대체하지 않습니다.',
      'JVM 응답에 셀 상태가 없으면 빈칸과 명시적 0을 구분할 수 없습니다. 금액으로 셀 상태를 추론하지 않습니다.'],
    nextSteps: ['accounting_amount_invalid는 안전하게 표현 가능한 정수 금액이 아니어서 조회를 거부한 경우입니다. 반올림하거나 0으로 대체하지 않습니다.', 'cashflow_accounting_source_unavailable는 주별 관리 연도 근거를 확인하지 못한 경우입니다. 사람이 플랫폼의 시트 연결·반영 상태를 확인해야 합니다.', 'cashflow_accounting_annual_scope는 연간 영역을 월/주 단위로 조회한 경우입니다. 월별로 임의 배분하지 않습니다.'],
    sources: ['server/bff/cashflow-coordinates.mjs', 'server/jvm-weekly-api/src/main/java/dev/merryai/innerplatform/weekly/api/CashflowSnapshotResponse.java', 'server/bff/routes/cashflow-sheet-lab.mjs'] },
  { topic: 'sheet_validation', title: '월결산 시트 검증 오류',
    codes: ['cashflow_month_close_validation_failed', 'SHEET_FACTS_MISSING', 'SHEET_VALUE_INVALID', 'SHEET_CONTROL_TOTAL_INCOMPLETE', 'SHEET_CONTROL_TOTAL_INVALID', 'SHEET_CONTROL_TOTAL_MISMATCH'],
    facts: ['상위 409 오류만으로 어느 셀이 잘못됐는지 확정할 수 없습니다. 상세 blocker와 sourceCell을 확인해야 합니다.',
      'SHEET_CONTROL_TOTAL_INCOMPLETE는 Projection 또는 Actual 검산 행이 19개가 아닌 경우입니다.',
      'SHEET_CONTROL_TOTAL_INVALID는 deposit.matches 또는 검산 행 matches가 boolean으로 읽히지 않은 경우입니다. Projection과 Actual 금액이 다르다는 의미가 아닙니다.',
      'matches는 시트 셀 값이 아니라 서버가 검산 셀의 숫자(value)와 계산 숫자(computed)를 비교해 만든 필드입니다. 둘 중 하나가 null이면 matches도 null입니다. 시트 셀을 TRUE/FALSE로 바꾸라는 뜻이 아닙니다.',
      'SHEET_CONTROL_TOTAL_MISMATCH는 비교 가능한 시트 검산값과 주차 합계의 불일치 경고입니다.',
      'BO는 기존 오류 문구에 남은 이름입니다. 실제 수정할 좌표는 상세 sourceCell 및 현재 좌표 계약으로 확인해야 합니다.'],
    nextSteps: ['플랫폼 오류 상세의 셀 주소·항목·구분을 확인하세요.', '해당 셀의 수식 결과가 숫자인지 확인하고, 사람이 시트값 다시 불러오기를 실행한 후 재확인하세요.', '상세가 없다면 특정 셀이나 수식을 임의로 수정하지 말고 사업명·대상월·오류 상세를 요청하세요.'],
    sources: ['server/bff/routes/jvm-weekly-api.mjs#sheetControlBlockers', 'server/bff/cashflow-sheet-snapshot.mjs', 'src/app/components/cashflow/cashflow-month-close-blocker-helpers.ts', 'server/bff/routes/jvm-weekly-api.test.mjs'] },
  { topic: 'agent_runtime', title: '에이전트 실행·QA 해석',
    facts: ['Slack 접수, 큐 실행, 도구 조회, 모델 응답, 근거 검토, Slack 발송은 서로 다른 단계입니다.',
      '작업 상태 succeeded는 메시지 전달 완료입니다. 업무 정산 완료나 답변의 정답을 의미하지 않습니다.',
      'answer_review는 모델의 근거 검토이며 정답의 수학적 증명이 아닙니다.',
      '해시 체인 검증은 저장된 trace의 일관성을 확인합니다. 외부 시스템 사실 자체를 증명하지 않습니다.',
      'API·조회 실패, 지연, 예산 한도와 정산 미완료를 구분해야 합니다. 확인되지 않은 원인은 추정으로 명시하세요.'],
    codes: ['budget_exhausted', 'input_budget_exceeded', 'hermes_not_configured', 'hermes_execution_failed', 'hermes_answer_unverified', 'lookup_failed', 'member_unverified'],
    nextSteps: ['agent_diagnostics로 현재 스레드 또는 최근 채널 작업의 기록된 단계·오류를 조회하세요.', '기록되지 않은 세부 원인은 확인 불가로 표시하고 관리자에게 로그 대조를 요청하세요.'],
    sources: ['server/mcp/slack-runtime.mjs', 'server/mcp/hermes-harness.mjs', 'server/mcp/grounded-answer.mjs', 'server/mcp/agent-trace.mjs'] },
]);

const tools = new Set(['cashflow_status', 'settlement_report', 'reformat_report', 'agent_capabilities', 'project_search', 'clarify_request', 'accounting_read', 'accounting_report', 'agent_diagnostics', 'system_knowledge']);
const codes = new Set(SUPPORT_KNOWLEDGE.flatMap((entry) => entry.codes || []));
export function safeDiagnosticCode(error) {
  const code = typeof error?.code === 'string' ? error.code : error?.message;
  return codes.has(code) ? code : 'lookup_failed';
}
export function classifyReadError(error) {
  const code = safeDiagnosticCode(error);
  const rawStatus = error?.upstreamStatus ?? error?.statusCode ?? error?.status;
  const httpStatus = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null;
  let category = 'UNKNOWN';
  if (httpStatus === 401 || httpStatus === 403) category = 'AUTHORIZATION';
  else if (httpStatus === 429) category = 'RATE_LIMIT';
  else if (httpStatus === 408 || httpStatus === 504 || error?.name === 'TimeoutError' || code === 'cashflow_month_close_route_timeout') category = 'TIMEOUT';
  else if (code === 'jvm_weekly_api_unreachable') category = 'CONNECTION';
  else if (code === 'jvm_weekly_api_unconfigured' || code === 'jvm_weekly_data_project_mismatch') category = 'CONFIGURATION';
  else if (code === 'cashflow_accounting_annual_scope' || code === 'accounting_weekly_scope_invalid') category = 'UNSUPPORTED_PERIOD';
  else if (code === 'cashflow_accounting_source_unavailable') category = 'SOURCE_UNAVAILABLE';
  else if (code.startsWith('SHEET_') || code === 'cashflow_month_close_validation_failed') category = 'SHEET_VALIDATION';
  else if (code.startsWith('accounting_') || ['jvm_weekly_project_mismatch', 'jvm_weekly_response_invalid', 'jvm_weekly_response_too_large'].includes(code)) category = 'INVALID_DATA';
  else if (httpStatus === 404) category = 'NOT_FOUND';
  else if (httpStatus === 409) category = 'CONFLICT';
  else if (httpStatus >= 500) category = 'UPSTREAM';
  const explanations = {
    AUTHORIZATION: '인증·권한이 거부됐습니다. 활성 계정과 사업 접근 권한을 확인하세요.',
    RATE_LIMIT: '호출 제한입니다. 즉시 반복 호출하지 말고 잠시 후 확인하세요.',
    TIMEOUT: '정해진 시간 안에 응답하지 않았습니다. 금액이나 정산 상태를 판단하지 않았습니다.',
    CONNECTION: 'JVM 연결에 실패했습니다. 서비스 연결 상태를 확인하세요.',
    CONFIGURATION: '서버 연결 설정을 확인해야 합니다. 시트 수정으로 해결할 문제가 아닙니다.',
    UNSUPPORTED_PERIOD: '이 사업의 주별 관리 연도 밖입니다. 연간 값을 해당 월의 0원으로 처리하지 않았습니다.',
    SOURCE_UNAVAILABLE: '시트 연결·반영 근거를 확인하지 못했습니다. 사람이 연결 상태를 확인해야 합니다.',
    INVALID_DATA: '응답의 사업·금액·형식 계약을 확인할 수 없어 자료를 사용하지 않았습니다.',
    NOT_FOUND: '자료를 찾지 못했습니다. 삭제됐다고 단정하지 않습니다.',
    SHEET_VALIDATION: '시트 검증에 필요한 값·형식을 확인해야 합니다. 상세 오류의 항목과 셀 주소를 확인하세요.',
    CONFLICT: '요청이 현재 상태와 충돌했습니다. 승인 여부나 버전 등 상세 조건을 확인해야 하며 원인을 임의로 확정하지 않습니다.',
    UPSTREAM: '상위 서비스가 오류로 응답했습니다. 시트 값의 문제라고 단정하지 않습니다.',
    UNKNOWN: '상세 원인이 확인되지 않았습니다. 발생 시각과 오류 상세를 확인하세요.',
  };
  return { category, code: code === 'lookup_failed' ? null : code, httpStatus, message: explanations[category] };
}
export function summarizeClientError(event) {
  return { occurredAt: instant(event.occurredAt), receivedAt: instant(event.createdAt),
    level: ['error', 'warning', 'info'].includes(event.level) ? event.level : 'unknown',
    errorClass: ['Error', 'TypeError', 'FirebaseError', 'PlatformApiError', 'NetworkError', 'AbortError'].includes(event.name) ? event.name : 'unknown',
    area: /^\/(?:portal\/)?cashflow(?:\/|$)/.test(event.route || '') ? 'cashflow'
      : /^\/(?:portal\/)?project(?:s|s\/|\/|-)/.test(event.route || '') ? 'projects' : 'other',
    code: codes.has(event.extra?.code) ? event.extra.code : null,
    httpStatus: Number.isInteger(event.extra?.status) && event.extra.status >= 100 && event.extra.status <= 599 ? event.extra.status : null,
    diagnosis: classifyReadError({ code: event.extra?.code, status: event.extra?.status, name: event.name }),
  };
}
const phases = new Set(['run_start', 'run_result', 'hermes_tool_start', 'hermes_tool_result', 'hermes_tool_failure', 'model_failure', 'answer_review', 'usage']);
const states = new Set(['queued', 'running', 'sending', 'succeeded', 'delivery_unknown', 'failed']);
const instant = (value) => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;

export function summarizeDiagnostic(job, records) {
  const traceValid = job.traceAnchor ? verifyAgentTrace(records, job.traceAnchor) : null;
  return {
    createdAt: instant(job.createdAt), answeredAt: instant(job.answeredAt),
    deliveryState: states.has(job.status) ? job.status : 'unknown',
    experiment: ['hermes', 'baseline'].includes(job.experimentVariant) ? job.experimentVariant : 'unknown',
    traceValid,
    failures: (Array.isArray(job.audit) ? job.audit : []).filter((entry) => entry.type === 'failure')
      .map((entry) => codes.has(entry.code) ? entry.code : 'unclassified_failure'),
    steps: traceValid ? records.flatMap(({ recordedAt, event = {} }) => {
      if (!phases.has(event.type) && !tools.has(event.tool)) return [];
      return [{ at: instant(recordedAt), phase: phases.has(event.type) ? event.type : 'tool_event',
        tool: tools.has(event.tool) ? event.tool : null,
        outcome: ['ok', 'rejected', 'feedback_policy', 'lookup_failed'].includes(event.outcome) ? event.outcome : null,
        code: codes.has(event.code) ? event.code : null,
        ...(event.type === 'answer_review' ? { review: { supported: event.review?.supported === true, addressesRequest: event.review?.addressesRequest === true } } : {}),
        ...(event.type === 'usage' ? { tokens: Object.fromEntries(['input', 'output', 'thinking'].map((key) => [key, Number.isSafeInteger(event[key]) && event[key] >= 0 ? event[key] : null])) } : {}),
      }];
    }) : [],
  };
}

export function createSupportTools({ db, job, authorize, revision = '' }) {
  return [{ name: 'system_knowledge',
    description: '배포 코드 기반 동작·데이터 경로·시트 검증 오류와 QA 해석 지식을 검색합니다. 실제 장애 발생 여부는 agent_diagnostics 또는 회계 조회 근거로 확인하세요. 문서의 원인 후보를 실제 원인으로 단정하지 마세요. 수정·삭제 기능은 없습니다.',
    schema: z.object({ topic: z.enum(['accounting', 'sheet_validation', 'agent_runtime', 'connectivity', 'all']) }).strict(),
    execute: async ({ topic }) => { await authorize(); return { authority: 'reviewed_code_knowledge',
      deploymentRevision: /^[a-f0-9]{40}$/.test(revision) ? revision : null,
      entries: structuredClone(SUPPORT_KNOWLEDGE.filter((entry) => topic === 'all' || entry.topic === topic)),
      warning: '동작 설명이며 현재 장애의 증거가 아닙니다. 소스 전체·비밀값·임의 파일은 제공하지 않습니다.' }; },
    render: (result) => result.entries.map((entry) => `${entry.title}\n${entry.facts.join('\n')}`).join('\n\n'),
  }, { name: 'agent_diagnostics',
    description: 'current_thread/ channel_recent는 에이전트 실행 단계·오류·QA 검토·토큰 기록, platform_recent는 MYSCube에서 수집된 최근 화면 오류 메타데이터를 읽습니다. 사용자정보·원문·비밀값은 제외합니다. Cloud Logging 전체가 아닙니다.',
    schema: z.object({ scope: z.enum(['current_thread', 'channel_recent', 'platform_recent']), limit: z.number().int().min(1).max(10).default(5) }).strict(),
    execute: async ({ scope, limit }, { signal }) => {
      await authorize(); signal.throwIfAborted();
      if (scope === 'platform_recent') {
        const page = await db.collection('orgs/mysc/client_error_events').orderBy('createdAt', 'desc').limit(limit + 1).get();
        const items = page.docs.slice(0, limit).map((doc) => summarizeClientError(doc.data()));
        signal.throwIfAborted(); await authorize();
        return { queriedAt: new Date().toISOString(), source: 'client_reported_error_metadata', scope, items,
          truncated: page.docs.length > limit,
          warning: '사용자 화면에서 전송된 오류 기록입니다. 서버 장애 확정·전체 장애 목록이 아니며 원문·스택·사용자 정보는 제외했습니다. 원인 세부사항이 없으면 추정하지 마세요.' };
      }
      const page = await db.collection('settlement_agent_jobs').orderBy('createdAt', 'desc').limit(50).get();
      const matching = page.docs.filter((doc) => doc.id !== job.id && doc.data().teamId === job.teamId && doc.data().channelId === job.channelId
        && (scope !== 'current_thread' || doc.data().threadTs === job.threadTs));
      const items = [];
      for (const doc of matching.slice(0, limit)) {
        signal.throwIfAborted();
        const value = doc.data();
        const lease = value.traceAnchor?.leaseId;
        const trace = typeof lease === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(lease)
          ? await doc.ref.collection('trace').where('sequence', '>=', 0).orderBy('sequence').limit(150).get() : null;
        const records = (trace?.docs || []).filter((row) => row.id.startsWith(`${lease}-`)).map((row) => row.data());
        items.push(summarizeDiagnostic(value, records));
      }
      await authorize();
      return { queriedAt: new Date().toISOString(), source: 'persisted_agent_jobs_and_verified_trace', scope, items,
        truncated: page.docs.length === 50 || matching.length > limit,
        warning: '최근 최대 50개 작업 안에서 조회한 일부 기록입니다. 기록 없음은 오류 없음의 증거가 아닙니다. 금액·상태 변경 및 작업 재실행은 하지 않습니다.' };
    },
    render: (result) => `최근 실행 기록 ${result.items.length}건을 확인했습니다. ${result.warning}`,
  }];
}
