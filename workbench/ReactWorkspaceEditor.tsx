import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import { normalizeReactSource, ReactSourceSchema } from '../shared/workbench-react-workspace.mjs';
import { lineDiff, proposalProblem, type EditorAction, type EditorState } from './react-workspace-editor';

export function ReactWorkspaceEditor({ state, dispatch, disabled, focusLocation }: { state: EditorState; dispatch: Dispatch<EditorAction>; disabled: boolean; focusLocation?: { file: string; line: number; column: number; sequence: number } | null }) {
  const [path, setPath] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!focusLocation || focusLocation.file !== state.activeFile || !textarea.current) return;
    const input = textarea.current, lines = input.value.split('\n'), row = Math.min(lines.length - 1, focusLocation.line - 1);
    const offset = lines.slice(0, row).reduce((sum, line) => sum + line.length + 1, 0) + Math.min(lines[row].length, focusLocation.column - 1);
    input.closest('details')?.setAttribute('open', ''); input.focus(); input.setSelectionRange(offset, Math.min(input.value.length, offset + 1));
  }, [focusLocation, state.activeFile]);
  const { source, activeFile } = state, workspace = source.workspace;
  const bytes = new TextEncoder().encode(Object.entries(workspace.files).map(([key, value]) => key + value).join('')).length;
  return <details className="react-source-editor" open><summary>파일 보기·편집</summary>
    <fieldset disabled={disabled}><label>화면 제목<input value={source.title} maxLength={80} onChange={event => dispatch({ type: 'title', value: event.target.value })} /></label>
      <div className="workspace-file-controls"><label>시작 파일<select value={workspace.entry} onChange={event => dispatch({ type: 'entry', path: event.target.value })}>{Object.keys(workspace.files).sort().map(file => <option key={file}>{file}</option>)}</select></label><span className="subtle">{Object.keys(workspace.files).length}/32개 · {bytes.toLocaleString()} / 180,000바이트</span></div>
      <div className="workspace-file-tabs" role="tablist" aria-label="React 파일">{Object.keys(workspace.files).sort().map(file => <button type="button" role="tab" key={file} aria-selected={activeFile === file} className={`quiet compact ${activeFile === file ? 'active' : ''}`} onClick={() => dispatch({ type: 'select', path: file })}>{file}{workspace.entry === file && ' · 시작'}</button>)}</div>
      <label>{activeFile} 원문<textarea ref={textarea} aria-label="React 원문" className="code" spellCheck={false} value={workspace.files[activeFile] ?? ''} onChange={event => dispatch({ type: 'code', path: activeFile, value: event.target.value })} /></label>
      <div className="workspace-file-controls"><label>새 파일 경로<input value={path} maxLength={160} placeholder="components/Summary.tsx" onChange={event => setPath(event.target.value)} /></label><button type="button" className="quiet compact" disabled={!path.trim()} onClick={() => { dispatch({ type: 'add', path: path.trim() }); setPath(''); }}>파일 추가</button><button type="button" className="quiet compact" disabled={activeFile === workspace.entry} onClick={() => { if (window.confirm(`${activeFile} 파일을 삭제할까요? 해당 파일의 import도 확인해 주세요.`)) dispatch({ type: 'remove', path: activeFile }); }}>선택 파일 삭제</button></div>
      <p className="subtle">TS·TSX 파일을 추가하고 상대 경로로 연결할 수 있습니다. 시작 파일은 React 컴포넌트를 기본 내보내기(default export) 해야 합니다. Tailwind CSS 클래스와 준비된 React 패키지를 사용합니다.</p>
    </fieldset>
  </details>;
}

export function ReactProposalReview({ state, dispatch, disabled }: { state: EditorState; dispatch: Dispatch<EditorAction>; disabled: boolean }) {
  const [shown, setShown] = useState<Record<string, number>>({});
  useEffect(() => setShown({}), [state.proposal, state.source]);
  const parsed = state.proposal && ReactSourceSchema.safeParse(state.proposal.source);
  const proposed = parsed && parsed.success ? normalizeReactSource(parsed.data) : null;
  const diffs = useMemo(() => {
    if (!proposed) return [];
    const before = state.source.workspace.files, after = proposed.workspace.files;
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(file => before[file] !== after[file]).map(file => ({ file, kind: !Object.hasOwn(before, file) ? '추가' : !Object.hasOwn(after, file) ? '삭제' : '수정', lines: lineDiff(before[file] || '', after[file] || '') }));
  }, [state.source, state.proposal]);
  if (!state.proposal) return <p className="subtle">AI 제안을 받으면 파일별 추가·수정·삭제 내용을 검토할 수 있습니다. 편집 중인 파일은 자동으로 바뀌지 않습니다.</p>;
  const problem = proposalProblem(state);
  return <section className="proposal" aria-label="React 파일 변경 제안"><h3>{proposed?.title || '제안 확인 필요'}</h3>
    {problem && <p className="notice" role="status">{problem}</p>}
    {proposed && <><p>제목: {state.source.title} → {proposed.title}</p><p>시작 파일: {state.source.workspace.entry} → {proposed.workspace.entry}</p><p className="subtle">API {state.proposal.apis?.length ?? 0}개 연결도 함께 적용합니다.</p>
      {!diffs.length && <p>파일 내용은 동일합니다.</p>}{diffs.map(diff => <details key={diff.file} open className="workspace-diff"><summary>{diff.kind} · {diff.file}</summary><pre aria-label={`${diff.file} 변경 내용`}>{diff.lines.slice(0, shown[diff.file] || 1200).map((line, index) => <span className={`diff-line diff-${line.kind}`} key={index}><span className="diff-number">{line.before ?? ' '} / {line.after ?? ' '}</span>{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '} {line.text}{'\n'}</span>)}</pre>{diff.lines.length > (shown[diff.file] || 1200) && <div className="notice"><p>{(shown[diff.file] || 1200).toLocaleString()} / {diff.lines.length.toLocaleString()}줄을 표시합니다. 적용 전에 나머지 변경도 확인할 수 있습니다.</p><button type="button" className="quiet compact" onClick={() => setShown(current => ({ ...current, [diff.file]: (current[diff.file] || 1200) + 1200 }))}>변경 내용 1,200줄 더 보기 · {diff.file}</button></div>}</details>)}
    </>}
    <button disabled={disabled || Boolean(problem)} onClick={() => dispatch({ type: 'apply' })}>검토한 변경 적용</button><button className="quiet" disabled={disabled} onClick={() => dispatch({ type: 'dismiss' })}>제안 닫기</button>
  </section>;
}
