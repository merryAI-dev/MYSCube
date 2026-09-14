import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createGeminiCompletion } from '../server/mcp/gemini-model.mjs';
import { runSettlementAgent } from '../server/mcp/settlement-agent.mjs';
import { createSettlementReportTools } from '../server/mcp/settlement-reporting.mjs';
import { reviewGroundedAnswer } from '../server/mcp/grounded-answer.mjs';

// Opt-in live model QA with synthetic evidence only; no Slack or business database writes.
assert(process.argv.includes('--live'), 'Use --live to run paid Gemini QA with synthetic data.');
try {
  const apiKey = (process.env.GEMINI_API_KEY || execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest',
    '--secret=myscube-settlement-agent-gemini-key', '--project=inner-platform-live-20260316'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  const usage = [];
  const history = [];
  let snapshot;
  let reads = 0;
  const report = { kind: 'month_incomplete', yearMonth: '2026-09', monthCloseTargetYearMonth: '2026-08',
    queriedAt: '2026-09-14T06:20:00.000Z', complete: true, coverage: 'accessible_registered_projects', checked: 3,
    warning: '테스트 자료입니다. 등록 사업 기준이며 정산 의무 대상 미준수 명단은 아닙니다.',
    rows: [{ projectId: 'qa-project-a', name: '테스트 가', cic: 'CIC1', leaderId: 'qa-leader-a', leader: '테스트 조직장 가', state: 'NOT_REQUESTED' },
      { projectId: 'qa-project-b', name: '테스트 나', cic: 'CIC2', leaderId: 'qa-leader-b', leader: '테스트 조직장 나', state: 'SUBMITTED' },
      { projectId: 'qa-project-c', name: '테스트 다', cic: '', leaderId: '', leader: '조직장 확인 필요', state: 'UNKNOWN' }] };
  for (const question of ['2026년 8월 월결산 미완료 사업 중 조직장이 설정된 것만 CIC별로 리포팅해줘. 이모지도 써줘.',
    '피드백: 표 말고 조직장: 사업1,2 형태로 간결하게 다시 써줘. 월결산만이야.']) {
    const signal = AbortSignal.timeout(100000);
    const adapter = (phase) => createGeminiCompletion({ apiKey, maxInputTokens: 16000, onUsage: async (value) => usage.push({ phase, ...value }) });
    const reviewer = adapter('review');
    const events = [];
    const tools = createSettlementReportTools({ readReport: async (input) => {
      assert.equal(input.kind, 'month_incomplete'); assert.equal(input.yearMonth, '2026-09'); reads++;
      return structuredClone(report);
    }, saveReport: async (value) => { snapshot = structuredClone(value); }, loadPreviousReports: async () => snapshot ? [snapshot] : [] });
    const result = await runSettlementAgent({ question, tools, history, complete: adapter('answer'), signal, maxSteps: 4,
      reviewAnswer: (input) => reviewGroundedAnswer({ ...input, complete: reviewer }), record: async (event) => events.push(event) });
    console.log(JSON.stringify({ syntheticData: true, question, ...result, tools: events.filter((event) => event.type === 'tool_result').map((event) => ({ name: event.tool, input: event.input })),
      reviews: events.filter((event) => event.type === 'answer_review').map((event) => event.review) }));
    assert.equal(result.status, 'answered');
    assert(!result.answer.includes('테스트 다'), 'prior leader-only filter must be preserved');
    assert(!result.answer.includes('qa-project-'), 'internal IDs must not be shown');
    history.push({ role: 'user', content: question }, { role: 'assistant', content: result.answer });
  }
  assert.equal(reads, 1, 'format correction must not requery');
  console.log(JSON.stringify({ passed: true, reads, actualUsage: usage }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, reason: error?.code === 'ERR_ASSERTION' ? error.message : 'Model QA or credential access failed; no key is logged.' }));
  process.exitCode = 1;
}
