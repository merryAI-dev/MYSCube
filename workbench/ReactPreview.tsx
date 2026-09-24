import type * as z from 'zod/v4';
import { ReactArtifactSchema, ReactExecutionArtifactSchema } from '../shared/workbench-react-workspace.mjs';
import { useEffect, useRef, useState } from 'react';

export type ReactPreviewArtifact = z.infer<typeof ReactArtifactSchema> & Partial<Pick<z.infer<typeof ReactExecutionArtifactSchema>, 'executionId'>>;
export type ReactPreviewResult = { status: 'ready' | 'error'; message?: string; durationMs?: number; executionId?: string };
export type ReactPreviewProps = { artifact: ReactPreviewArtifact | null; runtimeUrl?: string | null; onApiCall: (apiId: string, input: unknown) => Promise<unknown>; onResult?: (result: ReactPreviewResult) => void; canCommit?: (executionId: string) => boolean };
type Frame = { id: string; url: string; artifact: ReactPreviewArtifact; startedAt: number; onApiCall: ReactPreviewProps['onApiCall']; node?: HTMLIFrameElement; port?: MessagePort; connected: boolean; loads: number; calls: number; pending: Set<string>; timer?: ReturnType<typeof setTimeout> };
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');
const byteLength = (value: unknown) => { const serialized = JSON.stringify(value); if (serialized === undefined) throw new Error('JSON 값이 필요합니다.'); return new TextEncoder().encode(serialized).byteLength; };
const retire = (frame?: Frame | null) => { if (!frame) return; clearTimeout(frame.timer); frame.port?.close(); frame.port = undefined; frame.pending.clear(); };
const committedStyle = { display: 'block', width: '100%', minHeight: 540, border: 0, background: '#fff' } as const;
const candidateStyle = { position: 'absolute', left: 0, top: 0, width: 1, height: 1, minHeight: 0, border: 0, visibility: 'hidden', pointerEvents: 'none' } as const;

export function ReactPreview({ artifact, runtimeUrl, onApiCall, onResult, canCommit }: ReactPreviewProps) {
  const [frames, setFrames] = useState<Frame[]>([]); const [committedId, setCommittedId] = useState(''); const [error, setError] = useState(''); const [preparing, setPreparing] = useState(false);
  const current = useRef<{ candidate: Frame | null; committed: Frame | null }>({ candidate: null, committed: null });
  const sequence = useRef(0); const resultCallback = useRef(onResult); resultCallback.current = onResult;
  const commitGuard = useRef(canCommit); commitGuard.current = canCommit;
  const failure = (frame: Frame | null, message: string, executionId = frame?.artifact.executionId) => {
    if (frame && current.current.candidate !== frame && current.current.committed !== frame) return;
    if (frame === current.current.candidate) { retire(frame); current.current.candidate = null; setFrames(current.current.committed ? [current.current.committed] : []); }
    else if (frame) retire(frame);
    setPreparing(false); setError(message); resultCallback.current?.({ status: 'error', message, executionId });
  };
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const frame = current.current.candidate;
      if (!frame || frame.connected || event.source !== frame.node?.contentWindow || event.origin !== 'null' || event.data?.type !== 'axr-react-runtime-ready' || event.data.channelId !== frame.id) return;
      frame.connected = true;
      const channel = new MessageChannel(); frame.port = channel.port1;
      const active = () => current.current.candidate === frame || current.current.committed === frame;
      frame.port.onmessage = async (message: MessageEvent) => {
        const data = message.data;
        if (!active() || data?.channelId !== frame.id) return;
        if (data.type === 'ready') {
          if (current.current.candidate !== frame) return;
          if (commitGuard.current && (!frame.artifact.executionId || !commitGuard.current(frame.artifact.executionId))) { failure(frame, '화면을 준비하는 동안 편집 내용이 바뀌었습니다. 현재 내용으로 다시 미리보기를 확인해 주세요.'); return; }
          clearTimeout(frame.timer); retire(current.current.committed);
          current.current.committed = frame; current.current.candidate = null;
          setCommittedId(frame.id); setFrames([frame]); setPreparing(false); setError('');
          resultCallback.current?.({ status: 'ready', durationMs: Math.round(performance.now() - frame.startedAt), executionId: frame.artifact.executionId });
        } else if (data.type === 'error') {
          failure(frame, `새 React 화면을 확인하지 못했습니다. ${String(data.message || '').slice(0, 500)}`);
        } else if (data.type === 'api-call') {
          const reply = (value: Record<string, unknown>) => { if (active() && frame.port) frame.port.postMessage({ ...value, type: 'api-result', channelId: frame.id, requestId: data.requestId }); };
          if (typeof data.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(data.requestId) || frame.pending.has(data.requestId)) return;
          try {
            if (frame.pending.size >= 8 || ++frame.calls > 60 || typeof data.apiId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.apiId) || byteLength(data.input) > 32768) throw new Error('API 요청의 범위·횟수·크기를 확인해 주세요.');
            frame.pending.add(data.requestId);
            const result = await frame.onApiCall(data.apiId, data.input);
            if (byteLength(result) > 260000) throw new Error('API 응답이 256KB 한도를 넘었습니다. 필요한 자료만 조회해 주세요.');
            reply({ ok: true, result });
          } catch (reason) { reply({ ok: false, message: reason instanceof Error ? reason.message.slice(0, 500) : 'API 요청을 완료하지 못했습니다.' }); }
          finally { frame.pending.delete(data.requestId); }
        }
      };
      frame.port.start(); frame.node!.contentWindow!.postMessage({ type: 'axr-react-connect', channelId: frame.id, artifact: frame.artifact }, '*', [channel.port2]);
    };
    window.addEventListener('message', listener); return () => window.removeEventListener('message', listener);
  }, []);
  useEffect(() => {
    const generation = ++sequence.current;
    retire(current.current.candidate); current.current.candidate = null; setFrames(current.current.committed ? [current.current.committed] : []);
    if (!artifact) { setPreparing(false); return; }
    if (!runtimeUrl) { failure(null, '독립 React 실행 공간이 설정되지 않았습니다. 현재 HTML 미리보기는 계속 사용할 수 있습니다.', artifact.executionId); return; }
    let destination: URL;
    try { destination = new URL(runtimeUrl); if (!['http:', 'https:'].includes(destination.protocol) || destination.origin === window.location.origin || destination.username || destination.password || destination.hash) throw new Error('invalid_runtime_origin'); }
    catch { failure(null, 'React 미리보기는 별도로 분리된 실행 공간 주소가 필요합니다.', artifact.executionId); return; }
    setPreparing(true); setError('');
    void (async () => {
      (artifact.executionId ? ReactExecutionArtifactSchema : ReactArtifactSchema).parse(artifact);
      if (await hash(artifact.bundle) !== artifact.bundleHash || await hash(artifact.css) !== artifact.cssHash) throw new Error('React 실행본의 내용 또는 버전이 일치하지 않습니다.');
      if (sequence.current !== generation) return;
      const id = crypto.randomUUID(); destination.searchParams.set('channel', id);
      const frame: Frame = { id, url: destination.toString(), artifact, startedAt: performance.now(), onApiCall, connected: false, loads: 0, calls: 0, pending: new Set() };
      current.current.candidate = frame;
      frame.timer = setTimeout(() => failure(frame, '새 React 화면이 제한 시간 안에 준비되지 않았습니다. 이전 정상 화면을 유지합니다.'), 8000);
      setFrames(current.current.committed ? [current.current.committed, frame] : [frame]);
    })().catch((reason) => { if (sequence.current === generation) failure(null, reason instanceof Error ? reason.message : 'React 실행본을 확인하지 못했습니다.', artifact.executionId); });
    return () => { sequence.current++; };
  }, [artifact?.bundleHash, artifact?.cssHash, artifact?.packageSetHash, artifact?.sourceHash, artifact?.runtimeVersion, artifact?.executionId, runtimeUrl]);
  useEffect(() => () => { sequence.current++; retire(current.current.candidate); retire(current.current.committed); }, []);
  return <section aria-label="React 미리보기" style={{ minWidth: 0 }}><p role="status" style={{ color: '#64748b', fontSize: 12 }}>{preparing ? '새 화면을 확인하고 있습니다…' : committedId ? '별도 실행 공간에서 확인한 화면' : '대화로 화면을 만든 뒤 미리보기를 적용해 주세요.'}</p>
    <details className="preview-runtime-note"><summary>실행 환경 안내</summary><p>API는 등록된 항목과 현재 권한으로만 요청합니다. 브라우저 검증 환경은 무제한 자원 격리를 보장하지 않습니다.</p></details>
    <div style={{ position: 'relative', minHeight: 240, overflow: 'hidden', border: '1px solid #cbd5e1', borderRadius: 12 }}>
      {!frames.length && !preparing && <div className="preview-empty"><strong>어떤 화면을 만들까요?</strong><span>업무를 설명하면 변경 내용을 제안해 드립니다.</span></div>}
      {frames.map((frame) => <iframe key={frame.id} ref={(node) => { if (node) frame.node = node; }} title={frame.id === committedId ? '정상 React 미리보기' : '새 React 미리보기 확인'} src={frame.url} sandbox="allow-scripts" referrerPolicy="no-referrer" data-testid={frame.id === committedId ? 'react-preview-committed' : 'react-preview-candidate'} data-source-hash={frame.artifact.sourceHash} aria-hidden={frame.id === committedId ? undefined : true} tabIndex={frame.id === committedId ? undefined : -1} style={frame.id === committedId ? committedStyle : candidateStyle} onLoad={() => { frame.loads++; if (frame.loads > 1) failure(frame, '실행 공간이 다른 문서로 이동하여 API 연결을 닫았습니다.'); }} />)}
      {error && <div role="alert" style={{ position: 'absolute', inset: '12px 12px auto', background: '#fff', border: '1px solid #fecaca', borderRadius: 8, padding: 12, color: '#991b1b', fontSize: 13 }}>{error}</div>}
    </div></section>;
}
