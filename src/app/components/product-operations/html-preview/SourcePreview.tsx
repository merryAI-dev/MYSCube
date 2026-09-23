import { useEffect, useMemo, useRef, useState } from 'react';
import { validateHtmlPreviewArtifact, validateHtmlSource } from '../../../../../shared/workbench-html.mjs';

export type SourcePreviewResult = {
  status: 'ready' | 'error';
  message?: string;
  durationMs?: number;
};

type PreviewFrame = {
  id: string;
  document: string;
  sourceHash: string;
  startedAt: number;
};

export type SourcePreviewProps = {
  html: string;
  artifact?: { expectedHash: string };
  onResult?: (result: SourcePreviewResult) => void;
};

const PREVIEW_TIMEOUT_MS = 6_000;

export const SOURCE_PREVIEW_COMMITTED_STYLE = { display: 'block', width: '100%', minHeight: 540, border: 0, background: '#fff' } as const;
export const SOURCE_PREVIEW_CANDIDATE_STYLE = {
  position: 'absolute', left: 0, top: 0, width: 1, minWidth: 0, height: 1, minHeight: 0,
  border: 0, visibility: 'hidden', pointerEvents: 'none',
} as const;
export const SOURCE_PREVIEW_HASH_STYLE = { minWidth: 0, overflowWrap: 'anywhere', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10 } as const;

export async function sha256Source(source: string) {
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function matchesExpectedArtifactHash(actualHash: string, expectedHash: string) {
  return !expectedHash || actualHash === expectedHash;
}

function errorMessage(issues: Array<{ message: string }>) {
  if (!issues.length) return '미리보기를 준비하지 못했습니다. HTML 문서를 확인해 주세요.';
  return issues.map((issue) => issue.message).join(' ');
}

export function SourcePreview({ html, artifact, onResult }: SourcePreviewProps) {
  const expectedHash = artifact?.expectedHash || '';
  const validation = useMemo(
    () => artifact ? validateHtmlPreviewArtifact(html) : validateHtmlSource({ title: 'HTML 미리보기', html }),
    [html, expectedHash],
  );
  const [committed, setCommitted] = useState<PreviewFrame | null>(null);
  const [candidate, setCandidate] = useState<PreviewFrame | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const candidateRef = useRef<PreviewFrame | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const failCandidate = (id: string, message: string) => {
    if (candidateRef.current?.id !== id) return;
    clearTimer();
    candidateRef.current = null;
    setCandidate(null);
    setPreparing(false);
    setError(message);
    onResult?.({ status: 'error', message });
  };

  useEffect(() => {
    const generation = ++generationRef.current;
    clearTimer();
    candidateRef.current = null;
    setCandidate(null);

    if (!validation.ok) {
      const message = errorMessage(validation.issues);
      setPreparing(false);
      setError(message);
      onResult?.({ status: 'error', message });
      return undefined;
    }

    let active = true;
    setPreparing(true);
    setError('');
    void sha256Source(html).then((sourceHash) => {
      if (!active || generationRef.current !== generation) return;
      if (!matchesExpectedArtifactHash(sourceHash, expectedHash)) {
        setPreparing(false);
        const message = '실행본 식별값이 요청한 미리보기와 일치하지 않습니다. 이전에 정상으로 확인된 화면을 유지합니다.';
        setError(message);
        onResult?.({ status: 'error', message });
        return;
      }
      const frame: PreviewFrame = {
        id: crypto.randomUUID(),
        // The shared parser is the source of truth: it serializes a separate execution copy with CSP.
        document: validation.document,
        sourceHash,
        startedAt: performance.now(),
      };
      candidateRef.current = frame;
      setCandidate(frame);
      timerRef.current = setTimeout(() => {
        failCandidate(frame.id, '새 미리보기를 불러오지 못했습니다. 이전에 정상으로 확인된 화면을 유지합니다.');
      }, PREVIEW_TIMEOUT_MS);
    }).catch(() => {
      if (!active || generationRef.current !== generation) return;
      setPreparing(false);
      const message = '소스 식별값을 만들지 못했습니다. 이전에 정상으로 확인된 화면을 유지합니다.';
      setError(message);
      onResult?.({ status: 'error', message });
    });

    return () => {
      active = false;
      clearTimer();
    };
  // A preview is deliberately refreshed only when its source changes; the parent owns explicit preview timing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, expectedHash, validation.ok]);

  useEffect(() => () => clearTimer(), []);

  const commitCandidate = (frame: PreviewFrame, iframe: HTMLIFrameElement) => {
    if (candidateRef.current?.id !== frame.id) return;
    // srcDoc can emit an initial about:blank load in some browsers. Commit only the exact candidate document.
    if (iframe.srcdoc !== frame.document) return;
    clearTimer();
    candidateRef.current = null;
    setCommitted(frame);
    setCandidate(null);
    setPreparing(false);
    setError('');
    onResult?.({ status: 'ready', durationMs: Math.round(performance.now() - frame.startedAt) });
  };

  const visibleFrame = committed || candidate;
  const hasPendingCandidate = preparing || Boolean(candidate);

  return (
    <section aria-label="HTML 소스 미리보기" style={{ display: 'grid', minWidth: 0, gap: 8 }}>
      <div style={{ display: 'flex', minWidth: 0, flexWrap: 'wrap', alignItems: 'center', gap: 8, color: '#64748b', fontSize: 12 }}>
        <span role="status">
          {hasPendingCandidate ? '새 미리보기를 확인하고 있습니다…' : error ? '이전 정상 미리보기를 유지하고 있습니다.' : committed ? '정적 HTML/CSS 미리보기' : '미리보기할 HTML을 입력해 주세요.'}
        </span>
        {visibleFrame && <span style={SOURCE_PREVIEW_HASH_STYLE} data-testid="source-preview-hash">실행본 SHA-256 {visibleFrame.sourceHash}</span>}
      </div>
      <p style={{ margin: 0, color: '#64748b', fontSize: 12 }}>HTML과 CSS만 표시합니다. 스크립트·외부 연결·다른 페이지 이동은 실행할 수 없습니다.</p>
      <div style={{ position: 'relative', minHeight: 240, overflow: 'hidden', border: '1px solid #cbd5e1', borderRadius: 12, background: '#f8fafc' }}>
        {[committed, candidate].filter((frame): frame is PreviewFrame => frame !== null).map((frame) => {
          const isCandidate = frame.id === candidate?.id;
          return <iframe
            key={frame.id}
            title={isCandidate ? '새 HTML 미리보기 확인' : '정상 HTML 미리보기'}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={frame.document}
            data-testid={isCandidate ? 'source-preview-candidate' : 'source-preview-committed'}
            data-source-hash={frame.sourceHash}
            aria-hidden={isCandidate ? true : undefined}
            tabIndex={isCandidate ? -1 : undefined}
            // Keep the verified document mounted when it becomes visible; recreating it would start a second document load after validation.
            style={isCandidate ? SOURCE_PREVIEW_CANDIDATE_STYLE : SOURCE_PREVIEW_COMMITTED_STYLE}
            onLoad={(event) => { if (isCandidate) commitCandidate(frame, event.currentTarget); }}
            onError={() => { if (isCandidate) failCandidate(frame.id, '새 미리보기를 불러오지 못했습니다. 이전에 정상으로 확인된 화면을 유지합니다.'); }}
          />;
        })}
        {!visibleFrame && <div style={{ padding: 24, color: '#64748b', fontSize: 14 }}>안전한 전체 HTML 문서를 입력하면 이곳에서 확인할 수 있습니다.</div>}
        {error && <div role="alert" style={{ position: 'absolute', top: 16, right: 16, left: 16, border: '1px solid #fecaca', borderRadius: 8, background: 'rgba(255, 255, 255, 0.96)', padding: 12, color: '#991b1b', fontSize: 14, boxShadow: '0 1px 3px rgba(15, 23, 42, 0.12)' }}>{error}</div>}
      </div>
    </section>
  );
}
