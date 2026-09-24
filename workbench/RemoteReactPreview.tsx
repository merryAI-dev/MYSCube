import { useEffect, useRef, useState } from 'react';
import { workbenchRequest } from './client';
import { BoundEvidence } from './BoundEvidence';
import type { ReactSource } from './react-workspace-editor';

export type RemoteFrame = { pngBase64: string; width: number; height: number; sequence: number };
export type RemoteSession = { sessionId: string; frame: RemoteFrame; expiresAt: string; evidence?: Record<string, { evidenceId: string }> };
export type RemoteDraft = { source: ReactSource; apis: Array<{ id: string; version: number }>; key: number };
export type RemotePreviewResult = { status: 'ready' | 'error'; key: number; durationMs?: number; message?: string };
const keys = new Set(['Tab', 'Enter', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const endpoint = (id: string) => `/react-work-pages/remote/${id}`;
const close = (id: string) => workbenchRequest(endpoint(id), 'DELETE').catch(() => {});
function checked(value: unknown, previous?: RemoteSession): RemoteSession {
  const next = { ...previous, ...(value as Partial<RemoteSession>) };
  const frame = next.frame;
  if (typeof next.sessionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(next.sessionId) || previous && next.sessionId !== previous.sessionId || typeof next.expiresAt !== 'string' || !Number.isFinite(Date.parse(next.expiresAt))
    || !frame || !Number.isSafeInteger(frame.sequence) || frame.sequence < 1 || !Number.isSafeInteger(frame.width) || frame.width < 320 || frame.width > 1600 || !Number.isSafeInteger(frame.height) || frame.height < 240 || frame.height > 1200
    || typeof frame.pngBase64 !== 'string' || frame.pngBase64.length > 860000 || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(frame.pngBase64)
    || previous && (frame.width !== previous.frame.width || frame.height !== previous.frame.height)) throw new Error('실행 화면의 이미지와 버전을 확인하지 못했습니다. 이전 정상 화면을 유지합니다.');
  const header = atob(frame.pngBase64.slice(0, 44));
  const numberAt = (offset: number) => [0, 1, 2, 3].reduce((value, index) => value * 256 + header.charCodeAt(offset + index), 0);
  if (header.length < 24 || numberAt(16) !== frame.width || numberAt(20) !== frame.height) throw new Error('실행 화면의 이미지 크기를 확인하지 못했습니다.');
  return next as RemoteSession;
}

async function decodeFrame(frame: RemoteFrame) {
  const image = new Image(); image.src = `data:image/png;base64,${frame.pngBase64}`;
  await image.decode();
  if (image.naturalWidth !== frame.width || image.naturalHeight !== frame.height) throw new Error('실행 화면의 이미지 크기를 확인하지 못했습니다.');
}

export function RemoteReactPreview({ draft, onResult, onPreparing }: { draft: RemoteDraft | null; onResult?: (value: RemotePreviewResult) => void; onPreparing?: (value: boolean) => void }) {
  const [session, setSession] = useState<RemoteSession | null>(null), [error, setError] = useState(''), [liveError, setLiveError] = useState('');
  const [preparing, setPreparing] = useState(false), [acting, setActing] = useState(false), [typing, setTyping] = useState('');
  const generation = useRef(0), live = useRef<RemoteSession | null>(null), network = useRef<Promise<unknown> | null>(null), inputBusy = useRef(false), failed = useRef(false);
  const callbacks = useRef({ onResult, onPreparing }); callbacks.current = { onResult, onPreparing };
  const authorizationFailure = (reason: unknown) => {
    if (![401, 403].includes(Number((reason as { status?: number })?.status))) return false;
    generation.current++; if (live.current) void close(live.current.sessionId); live.current = null; setSession(null); failed.current = true;
    setError(''); setLiveError('조회 권한이 바뀌어 이전 실행 이미지와 계산 근거를 숨겼습니다. 현재 권한을 확인한 뒤 미리보기를 다시 적용해 주세요.');
    setPreparing(false); callbacks.current.onPreparing?.(false); return true;
  };
  const setFailure = (reason: unknown, fallback: string) => { if (authorizationFailure(reason)) return; failed.current = true; setLiveError(reason instanceof Error ? reason.message : fallback); };
  const merge = async (id: string, value: unknown) => {
    const current = live.current; if (!current || current.sessionId !== id) return false;
    const next = checked(value, current);
    if (next.frame.sequence <= current.frame.sequence) return false;
    await decodeFrame(next.frame);
    if (live.current?.sessionId !== id || next.frame.sequence <= live.current.frame.sequence) return false;
    live.current = next; setSession(next); failed.current = false; setLiveError(''); return true;
  };
  useEffect(() => {
    const current = ++generation.current;
    if (!draft) {
      if (live.current) void close(live.current.sessionId);
      live.current = null; setSession(null); setError(''); setLiveError(''); failed.current = false; setPreparing(false); callbacks.current.onPreparing?.(false); return;
    }
    const start = performance.now(), previousSessionId = live.current?.sessionId;
    setPreparing(true); callbacks.current.onPreparing?.(true); setError('');
    void workbenchRequest('/react-work-pages/remote', 'POST', { source: draft.source, apis: draft.apis, viewport: { width: 1100, height: 700 }, ...(previousSessionId ? { previousSessionId } : {}) }).then(async (raw: unknown) => {
      if (generation.current !== current) { const id = (raw as Partial<RemoteSession>)?.sessionId; if (typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id) && id !== previousSessionId) void close(id); return; }
      let value: RemoteSession;
      try { value = checked(raw); await decodeFrame(value.frame); }
      catch (reason) {
        const id = (raw as Partial<RemoteSession>)?.sessionId;
        if (typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id) && id !== previousSessionId) void close(id);
        throw reason;
      }
      if (generation.current !== current) { void close(value.sessionId); return; }
      const previous = live.current;
      live.current = value; setSession(value); setTyping(''); failed.current = false; setLiveError('');
      if (previous && previous.sessionId !== value.sessionId) void close(previous.sessionId);
      callbacks.current.onResult?.({ status: 'ready', key: draft.key, durationMs: Math.round(performance.now() - start) });
    }).catch((reason) => {
      if (generation.current === current) { if (authorizationFailure(reason)) return; setError(reason.message); callbacks.current.onResult?.({ status: 'error', key: draft.key, message: reason.message }); }
    }).finally(() => { if (generation.current === current) { setPreparing(false); callbacks.current.onPreparing?.(false); } });
  }, [draft?.key]);
  useEffect(() => () => { generation.current++; if (live.current) void close(live.current.sessionId); live.current = null; }, []);
  const refresh = async (id: string) => {
    if (network.current || inputBusy.current || live.current?.sessionId !== id) return;
    const pending = workbenchRequest(endpoint(id)); network.current = pending;
    try { await merge(id, await pending); }
    catch (reason) { if (live.current?.sessionId === id) setFailure(reason, '실행 결과를 확인하지 못했습니다.'); }
    finally { if (network.current === pending) network.current = null; }
  };
  useEffect(() => {
    if (!session) return;
    const id = session.sessionId;
    const timer = setInterval(() => { if (!failed.current && document.visibilityState !== 'hidden') void refresh(id); }, 2000);
    return () => clearInterval(timer);
  }, [session?.sessionId]);
  const sendEvent = async (value: object) => {
    const id = live.current?.sessionId; if (!id || inputBusy.current || failed.current) return false;
    inputBusy.current = true; setActing(true);
    let pending: Promise<unknown> | undefined;
    try {
      await network.current?.catch(() => undefined);
      if (live.current?.sessionId !== id || failed.current) return false;
      pending = workbenchRequest(`${endpoint(id)}/events`, 'POST', value); network.current = pending;
      return await merge(id, await pending);
    } catch (reason) { if (live.current?.sessionId === id) setFailure(reason, '입력을 전달하지 못했습니다.'); return false; }
    finally { if (network.current === pending) network.current = null; inputBusy.current = false; setActing(false); }
  };
  return <section aria-label="격리된 React 실행 화면" style={{ minWidth: 0, padding: 16 }}>
    <p role="status" className="subtle">{preparing ? '새 실행 화면을 준비하고 있습니다. 이전 정상 화면은 유지됩니다.' : session ? '별도 실행 공간의 화면입니다. 클릭·키보드 입력을 전달할 수 있습니다.' : '미리보기를 적용하면 실행 화면이 나타납니다.'}</p>
    <p className="subtle">원격 화면은 이미지로 표시되어 화면 안의 글자 선택과 스크린리더 탐색이 제한됩니다. 계산 근거는 아래 별도 표로 확인할 수 있습니다. 키보드 조작 영역에서 Tab으로 이동하거나 입력칸을 클릭한 뒤 글자를 보내 주세요.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {liveError && <p role="alert" className="error">{session && '현재 실행 결과를 확인하지 못했습니다. 보이는 이미지는 마지막 정상 화면이며, 입력과 계산 근거 표시는 중단했습니다. '}{liveError}</p>}
    {session && <>
      <div tabIndex={0} role="group" aria-label="실행 화면 키보드 조작" aria-disabled={acting || Boolean(liveError)} onKeyDown={(key) => {
        if (keys.has(key.key)) { key.preventDefault(); if (!acting && !liveError) void sendEvent({ type: 'key', key: key.shiftKey && key.key === 'Tab' ? 'Shift+Tab' : key.key }); }
      }}>
        <img alt="React 실행 결과" data-testid="remote-react-frame" data-sequence={session.frame.sequence} data-session={session.sessionId} src={`data:image/png;base64,${session.frame.pngBase64}`} style={{ width: '100%', height: 'auto', display: 'block' }}
          onClick={(click) => { if (acting || liveError) return; const box = click.currentTarget.getBoundingClientRect(); if (!box.width || !box.height) return; void sendEvent({ type: 'click', x: Math.max(0, Math.min(session.frame.width - 1, Math.floor((click.clientX - box.left) * session.frame.width / box.width))), y: Math.max(0, Math.min(session.frame.height - 1, Math.floor((click.clientY - box.top) * session.frame.height / box.height))) }); }} />
      </div>
      <fieldset disabled={acting || Boolean(liveError)}><div className="actions"><label>선택한 입력칸에 보낼 글자<input value={typing} maxLength={2000} onChange={(value) => setTyping(value.target.value)} /></label><button disabled={!typing} onClick={async () => { const text = typing; if (await sendEvent({ type: 'type', text })) setTyping((current) => current === text ? '' : current); }}>입력 보내기</button>
        <button className="quiet" onClick={() => void sendEvent({ type: 'scroll', deltaX: 0, deltaY: -500 })}>위로 이동</button><button className="quiet" onClick={() => void sendEvent({ type: 'scroll', deltaX: 0, deltaY: 500 })}>아래로 이동</button></div></fieldset>
      <button className="quiet compact" disabled={acting} onClick={() => void refresh(session.sessionId)}>실행 상태 다시 확인</button>
      {acting && <p role="status" className="subtle">입력을 전달하고 있습니다.</p>}
      {!liveError && <BoundEvidence key={session.sessionId} bindings={session.evidence && Object.keys(session.evidence).length ? session.evidence : undefined} />}
    </>}
  </section>;
}
