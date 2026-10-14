// 주간 MCP 사용량 요약(Analytics Engine SQL 결과 → Slack 문구). 사람 이름 대신 사용자 수만 센다.
export const DATASET = 'ema_mcp_usage';

export function usageQuery(days) {
  return `SELECT blob1 AS name, blob2 AS kind, blob3 AS outcome, blob5 AS client, blob6 AS uid, blob7 AS detail,
SUM(_sample_interval) AS calls FROM ${DATASET}
WHERE timestamp > NOW() - INTERVAL '${Number(days)}' DAY
GROUP BY name, kind, outcome, client, uid, detail`;
}

const LABELS = {
  meeting_note_compose: '회의록 정리', meeting_note_save: '회의록 저장', meeting_note_guide: '회의록 가이드',
  note_save_page: '회의록 저장 링크(버튼)', registry_confirm_page: '기업 등록 확정 링크(버튼)',
};
const DESTINATION_LABELS = { drive: '팀 드라이브', ema_draft: 'EMA 보고서 초안함', both: '둘 다' };

export function summarizeUsage(rows) {
  const total = { calls: 0, errors: 0 };
  const users = new Set();
  const byClient = new Map();
  const byName = new Map();
  const destinations = new Map();
  for (const row of rows) {
    const calls = Number(row.calls) || 0;
    total.calls += calls;
    if (row.outcome === 'error') total.errors += calls;
    if (row.uid) users.add(row.uid);
    if (row.kind === 'tool') byClient.set(row.client || 'other', (byClient.get(row.client || 'other') || 0) + calls);
    const entry = byName.get(row.name) || { calls: 0, errors: 0, users: new Set() };
    entry.calls += calls;
    if (row.outcome === 'error') entry.errors += calls;
    if (row.uid) entry.users.add(row.uid);
    byName.set(row.name, entry);
    if (row.detail && row.outcome === 'ok' && ['meeting_note_save', 'note_save_page'].includes(row.name)) {
      destinations.set(row.detail, (destinations.get(row.detail) || 0) + calls);
    }
  }
  return {
    calls: total.calls, errors: total.errors, users: users.size,
    byClient: Object.fromEntries([...byClient.entries()].sort((a, b) => b[1] - a[1])),
    byName: [...byName.entries()].map(([name, entry]) => ({ name, calls: entry.calls, errors: entry.errors, users: entry.users.size }))
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    destinations: Object.fromEntries(destinations),
  };
}

const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '0%');

export function formatUsageReport(summary, { days, from, to }) {
  if (!summary.calls) return `*EMA Station MCP 사용량 (${from} ~ ${to}, ${days}일)*\n이 기간에 기록된 호출이 없습니다.`;
  const clients = Object.entries(summary.byClient).map(([client, calls]) => `${client} ${calls}`).join(' · ') || '없음';
  const lines = summary.byName.map((entry) => `- ${LABELS[entry.name] || entry.name}: ${entry.calls}회 (사용자 ${entry.users}명${entry.errors ? `, 실패 ${entry.errors}회` : ''})`);
  const dest = Object.entries(summary.destinations).map(([key, calls]) => `${DESTINATION_LABELS[key] || key} ${calls}`).join(' · ');
  return [
    `*EMA Station MCP 사용량 (${from} ~ ${to}, ${days}일)*`,
    `- 전체 호출 ${summary.calls}회, 사용자 ${summary.users}명, 실패율 ${pct(summary.errors, summary.calls)}`,
    `- 앱별(도구 호출): ${clients}`,
    ...(dest ? [`- 회의록 저장 위치: ${dest}`] : []),
    '',
    '*도구별*',
    ...lines,
  ].join('\n');
}
