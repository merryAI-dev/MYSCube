// MCP 사용량 기록(Workers Analytics Engine). 도구 이름·결과·시간 같은 메타데이터만 남기고 입력·응답 내용은 남기지 않는다.
// blobs: [이름, 종류(tool|page), 결과(ok|error), 역할, 클라이언트, uid, 세부(저장 위치 등)] / doubles: [소요 ms]
const DETAIL_KEYS = ['destination'];

export function clientOf(userAgent) {
  const agent = String(userAgent || '').toLowerCase();
  if (agent.includes('openai') || agent.includes('chatgpt')) return 'chatgpt';
  if (agent.includes('claude') || agent.includes('anthropic')) return 'claude';
  return 'other';
}

export function usageRecorder(dataset, { uid = '', role = '', client = '' } = {}) {
  if (!dataset?.writeDataPoint) return () => {};
  return ({ kind, name, outcome, ms = 0, detail = '' }) => {
    try {
      dataset.writeDataPoint({
        indexes: [String(name).slice(0, 96)],
        blobs: [name, kind, outcome, role, client, uid, detail].map((value) => String(value ?? '').slice(0, 200)),
        doubles: [Math.max(0, Math.round(ms))],
      });
    } catch { /* 기록 실패가 도구 실행을 막지 않는다 */ }
  };
}

// 모든 도구 등록을 감싸 호출마다 한 줄씩 기록한다. 도구 파일은 바꿀 필요가 없다.
export function instrumentServer(server, record, now = () => Date.now()) {
  const register = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => register(name, config, async (args, extra) => {
    const started = now();
    let result;
    try {
      result = await handler(args, extra);
      return result;
    } finally {
      const detail = DETAIL_KEYS.map((key) => args?.[key]).filter((value) => typeof value === 'string').join(',');
      record({ kind: 'tool', name, outcome: result && !result.isError ? 'ok' : 'error', ms: now() - started, detail });
    }
  });
}
