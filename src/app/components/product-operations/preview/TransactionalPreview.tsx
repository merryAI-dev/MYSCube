import { useEffect, useRef, useState } from 'react';
import { compilePreviewDocument, type PreviewPage } from './document';
import { PreviewCommitState } from './commit-state';
type Frame = { nonce: string; document: string; height: number; hash: string };
export function TransactionalPreview({ page }: { page: PreviewPage }) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [visible, setVisible] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(true);
  const [timing, setTiming] = useState<number | null>(null);
  const state = useRef(new PreviewCommitState());
  const elements = useRef(new Map<string, HTMLIFrameElement>());
  const starts = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const failRef = useRef<(nonce: string) => void>(() => {});
  failRef.current = (nonce) => {
    if (!state.current.fail(nonce)) return;
    clearTimeout(timers.current.get(nonce)); timers.current.delete(nonce);
    setFrames((items) => items.filter((item) => state.current.retained(item.nonce))); setVisible(state.current.active);
    setError('화면 실행에 실패했습니다. 남아 있는 정상 미리보기는 이전 자료입니다. 구성을 확인하고 다시 미리보기 해 주세요.');
    if (nonce === state.current.latest) setPending(false);
  };
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.channel !== 'myscube-preview' || typeof data.nonce !== 'string' || event.origin !== 'null'
        || !elements.current.has(data.nonce) || event.source !== elements.current.get(data.nonce)?.contentWindow) return;
      if (data.type === 'error') { failRef.current(data.nonce); return; }
      if (data.type !== 'ready' || state.current.states.get(data.nonce) !== 'pending') return;
      // Offscreen opaque iframes can throttle rAF; await paint opportunities in the host.
      requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!elements.current.has(data.nonce) || !state.current.ready(data.nonce)) return;
      clearTimeout(timers.current.get(data.nonce)); timers.current.delete(data.nonce);
      setFrames((items) => items.filter((item) => state.current.retained(item.nonce)).map((item) => item.nonce === data.nonce ? { ...item, height: Math.max(240, Math.min(500, Number(data.height) || 500)) } : item));
      setVisible(data.nonce); setPending(false); setError('');
      requestAnimationFrame(() => { if (state.current.active === data.nonce) setTiming(Math.round(performance.now() - (starts.current.get(data.nonce) || performance.now()))); });
      }));
    };
    window.addEventListener('message', receive);
    return () => { window.removeEventListener('message', receive); for (const timer of timers.current.values()) clearTimeout(timer); };
  }, []);
  useEffect(() => {
    const nonce = crypto.randomUUID(); state.current.start(nonce); starts.current.set(nonce, performance.now());
    for (const id of starts.current.keys()) if (!state.current.retained(id)) starts.current.delete(id);
    for (const [id, timer] of timers.current) { clearTimeout(timer); timers.current.delete(id); }
    setPending(true); setError(''); let active = true;
    void import('virtual:workbench-preview-package').then(({ source, packageHash }) => {
      if (!active || state.current.latest !== nonce) return;
      const document = compilePreviewDocument(page, source, nonce);
      setFrames((items) => [...items.filter((item) => state.current.good.includes(item.nonce)), { nonce, document, hash: packageHash, height: 500 }]);
      timers.current.set(nonce, setTimeout(() => failRef.current(nonce), 8000));
    }).catch(() => { if (active) failRef.current(nonce); });
    return () => { active = false; clearTimeout(timers.current.get(nonce)); timers.current.delete(nonce); };
  }, [page]);
  return <section className="space-y-2" aria-label="인사이트 미리보기">
    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground"><span role="status">{pending ? '새 화면 실행 확인 중…' : error ? '이전 정상 화면 · 최신 구성 반영 안 됨' : '화면 반영 완료'}</span>{timing !== null && <span data-testid="preview-duration">화면 준비·반영 {timing}ms (자료 조회 시간 제외)</span>}</div>
    <p className="text-xs text-muted-foreground">긴 내용은 미리보기 안에서 스크롤해 확인할 수 있습니다.</p>
    <div className="relative min-h-60 overflow-hidden rounded-xl border bg-slate-50">
      {frames.map((frame) => <iframe key={frame.nonce} ref={(element) => { if (element) elements.current.set(frame.nonce, element); else elements.current.delete(frame.nonce); }}
        title={frame.nonce === visible ? 'CEO 인사이트 미리보기' : '새 화면 실행 검사'} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={frame.document}
        data-preview-id={frame.nonce} data-package-hash={frame.hash} aria-hidden={frame.nonce !== visible} tabIndex={-1}
        className={frame.nonce === visible ? `block w-full border-0 ${error || pending ? 'pointer-events-none opacity-50' : ''}` : 'pointer-events-none absolute left-0 top-0 w-full border-0 opacity-0'} style={{ height: frame.height }} />)}
      {error && <div role="alert" className="absolute inset-x-4 top-6 rounded-lg border border-red-200 bg-white/95 p-4 text-sm shadow">{error}</div>}
    </div>
  </section>;
}
