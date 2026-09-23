import { describe, expect, it } from 'vitest';
import { generateReactPage } from './react-pages.mjs';

const tool = (name, value) => ({ tool_calls: [{ function: { name, arguments: JSON.stringify(value) } }] });
const source = { title: '편집본', code: 'export default function App(){return <div>그대로</div>}' };
const run = (complete, extra = {}) => generateReactPage({ complete, prompt: '이 화면을 다듬어 주세요.', currentSource: source, apis: [], authorize: async () => {}, signal: AbortSignal.timeout(10000), ...extra });
describe('typed React generation outcomes', () => {
  it('returns explicit clarification with no replacement source or execution artifact', async () => {
    const result = await run(async () => tool('clarify_react_request', { question: '어느 API를 연결할까요?', reason: '조회할 자료가 정해지지 않았습니다.', options: [] }));
    expect(result.type).toBe('clarification'); expect(result.source).toBeUndefined(); expect(result.artifact).toBeUndefined();
    expect(result.clarification.originalMessage).toBe('이 화면을 다듬어 주세요.'); expect(result.clarification.id).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('returns explanations without rewriting source, preserving trusted conversation and proposal context', async () => {
    let input;
    const result = await run(async (value) => { input = value; return tool('answer_react_request', { answer: '조회 API를 선택하면 연결할 수 있습니다.' }); }, { history: [{ role: 'user', content: '기존 질문' }], previousProposal: { ...source, title: '이전 제안' }, businessContext: { filters: { yearMonth: '2026-09' } } });
    expect(result.type).toBe('answer'); expect(result.source).toBeUndefined();
    expect(JSON.stringify(input.messages)).toContain('기존 질문'); expect(JSON.stringify(input.messages)).toContain('이전 제안'); expect(JSON.stringify(input.messages)).toContain('2026-09');
  });
  it('repairs invalid React only once and records actual model and compile stage durations', async () => {
    const stages = []; let calls = 0;
    const result = await run(async () => ++calls === 1 ? tool('render_react_source', { title: '실패', code: 'import bad from "node:fs"; export default bad;' }) : tool('render_react_source', source), { onStage: (stage) => stages.push(stage) });
    expect(result.type).toBe('source'); expect(result.source).toEqual(source); expect(result.attempts).toBe(2); expect(result.artifact.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stages.map((stage) => stage.stage)).toEqual(['model', 'compile', 'model', 'compile']);
    expect(stages.every((stage) => Number.isInteger(stage.durationMs) && stage.durationMs >= 0)).toBe(true);
  });
});
