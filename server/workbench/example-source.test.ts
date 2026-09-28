import { describe, expect, it } from 'vitest';
import { isHtmlStarterExample, isReactStarterExample } from '../../workbench/example-source';
import { normalizeReactSource } from '../../shared/workbench-react-workspace.mjs';
import { REACT_EXAMPLE } from './react-pages.mjs';
import { HTML_EXAMPLE } from './html-references.mjs';

const source = () => normalizeReactSource({ title: '직접 정한 제목', code: REACT_EXAMPLE });
describe('exact server-provided starter example identity', () => {
  it('recognizes the legacy and canonical source without classifying by title', () => {
    expect(isReactStarterExample({ title: '기본 제목과 다른 제목', code: REACT_EXAMPLE }, REACT_EXAMPLE)).toBe(true);
    expect(isReactStarterExample(source(), REACT_EXAMPLE)).toBe(true);
  });
  it.each([`${REACT_EXAMPLE} `, REACT_EXAMPLE.replace('실행 확인', '직접 변경'), 'export default function App(){return <h1>기본 예제</h1>}'])('does not classify edited or similarly labelled user code', code => {
    expect(isReactStarterExample({ title: '나의 업무 화면', code }, REACT_EXAMPLE)).toBe(false);
  });
  it('does not classify additional or differently named files', () => {
    const extra = source(); extra.workspace.files['Extra.ts'] = '';
    expect(isReactStarterExample(extra, REACT_EXAMPLE)).toBe(false);
    const renamed = source(); renamed.workspace.entry = 'Custom.tsx'; renamed.workspace.files = { 'Custom.tsx': REACT_EXAMPLE };
    expect(isReactStarterExample(renamed, REACT_EXAMPLE)).toBe(false);
  });
  it('does not infer an example before the server supplies one', () => {
    expect(isReactStarterExample(source(), undefined)).toBe(false);
    expect(isReactStarterExample({ title: '빈 원문', code: '' }, '')).toBe(false);
    expect(isHtmlStarterExample('', '')).toBe(false);
  });
  it('compares HTML bytes exactly and does not use business labels as a heuristic', () => {
    expect(isHtmlStarterExample(HTML_EXAMPLE, HTML_EXAMPLE)).toBe(true);
    expect(isHtmlStarterExample(`${HTML_EXAMPLE}\n`, HTML_EXAMPLE)).toBe(false);
    expect(isHtmlStarterExample(HTML_EXAMPLE.replace('현금흐름, 한눈에', '나의 현금흐름'), HTML_EXAMPLE)).toBe(false);
    expect(isHtmlStarterExample('<p>자료 미연결</p>', HTML_EXAMPLE)).toBe(false);
  });
});
