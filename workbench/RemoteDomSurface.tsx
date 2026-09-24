import { useEffect, useRef, useState } from 'react';
import { RemoteDomFrameSchema } from '../shared/workbench-remote-dom.mjs';
import { bindDomAction, domIdentity, type DomFrame, type DomEvent, type DomAction, type InputDraft, type DomControl } from './remote-dom-input';
import { createDomRenderer, REMOTE_DOM_DOCUMENT } from './remote-dom-renderer';

type Props = { frame: DomFrame; disabled?: boolean; onEvent: (event: DomEvent) => Promise<DomFrame>; onError?: (reason: unknown) => void; onResync?: () => Promise<DomFrame> };
export function RemoteDomSurface({ frame, disabled = false, onEvent, onError, onResync }: Props) {
  const iframe = useRef<HTMLIFrameElement>(null), callbacks = useRef({ onEvent, onError, onResync, disabled });
  callbacks.current = { onEvent, onError, onResync, disabled };
  const [loaded, setLoaded] = useState(0), [notice, setNotice] = useState(''), [pending, setPending] = useState(0), [failed, setFailed] = useState(false);
  const accept = useRef<(frame: DomFrame) => void>(() => {}), resync = useRef<() => void>(() => {});
  const identity = domIdentity(frame), currentFrame = useRef(frame); currentFrame.current = frame;
  useEffect(() => {
    const frameDocument = iframe.current?.contentDocument;
    if (!frameDocument || !loaded) return;
    const document: Document = frameDocument;
    let alive = true, blocked = false, sending = false, revision = 0, eventOrder = 0, localFocusOrder = 0, acknowledgedOrder = 0, applyingSnapshot = false;
    const eventOrders = new Map<string, number>();
    let latest = RemoteDomFrameSchema.parse(currentFrame.current), renderer = createDomRenderer(document, setNotice);
    const drafts = new Map<string, InputDraft>(), composing = new Set<string>(), compositionEnd = new Set<string>();
    const queue: Array<{ action: DomAction; eventId: string }> = [];
    const listeners: Array<[string, EventListener]> = [];
    function fail(reason: unknown) {
      if (!alive) return;
      blocked = true; setFailed(true); setNotice('입력이 원격 화면에 반영되었는지 확인하지 못했습니다. 작성 중인 내용은 화면에 남겨 두었습니다. 원격 상태를 확인한 뒤 다시 입력해 주세요.'); callbacks.current.onError?.(reason);
    }
    function receive(next: DomFrame) {
      const checked = RemoteDomFrameSchema.parse(next);
      if (domIdentity(checked) !== identity) throw new Error('이전 실행 화면의 응답입니다.');
      if (!alive) return;
      const acknowledged = checked.snapshot.ack && eventOrders.get(checked.snapshot.ack.eventId);
      if (acknowledged) acknowledgedOrder = Math.max(acknowledgedOrder, acknowledged);
      if (checked.snapshot.revision < latest.snapshot.revision) return;
      latest = checked;
      applyingSnapshot = true;
      try { renderer.apply(checked, drafts, acknowledgedOrder >= localFocusOrder && composing.size === 0 && iframe.current?.ownerDocument.activeElement === iframe.current); }
      finally { applyingSnapshot = false; }
    }
    accept.current = next => { try { receive(next); } catch (reason) { fail(reason); } };
    renderer.apply(latest, drafts);
    const allowed = () => alive && !blocked && !callbacks.current.disabled;
    const nodeOf = (target: EventTarget | null) => target && 'nodeType' in target && (target as Node).nodeType === 1 ? target as HTMLElement : null;
    const idOf = (element: Element | null) => element?.getAttribute('data-remote-node');
    function readControl(element: HTMLElement): DomControl | undefined {
      const node = latest.snapshot.nodes.find(node => node.id === idOf(element));
      if (!node || node.kind !== 'element' || !node.control) return;
      const input = element as HTMLInputElement;
      return { ...node.control, value: input.value || '', checked: input.checked || false, selectedValues: element.localName === 'select' ? [...(element as HTMLSelectElement).selectedOptions].map(option => option.value) : [], selectionStart: input.selectionStart ?? null, selectionEnd: input.selectionEnd ?? null };
    }
    async function pump() {
      if (sending || !allowed()) return;
      sending = true;
      try {
        while (queue.length && allowed()) {
          const next = queue[0];
          if (!latest.snapshot.nodes.some(node => node.id === next.action.nodeId)) throw new Error('입력 대상이 바뀌었습니다. 원격 화면을 다시 확인해 주세요.');
          const event = bindDomAction(latest, next.action, next.eventId);
          const result = await callbacks.current.onEvent(event);
          if (!alive) return;
          const parsed = RemoteDomFrameSchema.parse(result);
          if (parsed.snapshot.ack?.eventId !== next.eventId) throw new Error('입력 완료 응답을 확인하지 못했습니다.');
          receive(parsed); queue.shift(); setPending(queue.length);
        }
      } catch (reason) { fail(reason); }
      finally { sending = false; }
    }
    function enqueue(action: DomAction, element?: HTMLElement, inComposition = false) {
      if (!allowed()) return;
      const eventId = crypto.randomUUID();
      if ('inputRevision' in action && element) {
        const control = readControl(element);
        if (control) drafts.set(action.nodeId, { revision: action.inputRevision, eventId, composing: inComposition, control });
      }
      if (queue.length >= 32) { fail(new Error('입력 대기 한도를 넘었습니다.')); return; }
      try { bindDomAction(latest, action, eventId); }
      catch (reason) { fail(reason); return; }
      const order = ++eventOrder; eventOrders.set(eventId, order);
      if (action.type === 'focus') localFocusOrder = order;
      if (eventOrders.size > 64) eventOrders.delete(eventOrders.keys().next().value!);
      queue.push({ action, eventId }); setPending(queue.length); void pump();
    }
    function listen(name: string, handler: (event: Event) => void) { const listener = handler as EventListener; document.addEventListener(name, listener, true); listeners.push([name, listener]); }
    listen('beforeinput', event => { if (!allowed() || queue.length >= 32) { event.preventDefault(); if (queue.length >= 32) fail(new Error('입력 대기 한도를 넘었습니다.')); } });
    listen('focusin', event => { const element = nodeOf(event.target), nodeId = idOf(element); if (nodeId && allowed() && !applyingSnapshot) enqueue({ type: 'focus', nodeId }); });
    listen('click', event => {
      const element = nodeOf(event.target), target = element?.closest('button,input[type="button"],input[type="submit"],input[type="reset"],summary');
      if (!allowed()) { event.preventDefault(); return; }
      const nodeId = idOf(target || null);
      if (nodeId) { event.preventDefault(); enqueue({ type: 'click', nodeId }); }
    });
    listen('submit', event => {
      event.preventDefault(); if (!allowed()) return;
      const form = nodeOf(event.target), nodeId = idOf(form); if (!nodeId) return;
      const submitter = (event as SubmitEvent).submitter;
      if (submitter) return;
      enqueue({ type: 'submit', nodeId, submitterNodeId: null });
    });
    listen('change', event => {
      const element = nodeOf(event.target), nodeId = idOf(element); if (!element || !nodeId || !allowed()) return;
      const control = readControl(element); if (!control) return;
      if (['checkbox', 'radio'].includes(control.type)) enqueue({ type: 'check', nodeId, checked: control.checked, inputRevision: ++revision }, element);
      else if (control.type === 'select') enqueue({ type: 'select', nodeId, values: control.selectedValues, inputRevision: ++revision }, element);
    });
    listen('input', raw => {
      const event = raw as InputEvent, element = nodeOf(event.target), nodeId = idOf(element);
      if (!element || !nodeId || !allowed()) return;
      const control = readControl(element); if (!control || ['checkbox', 'radio', 'select'].includes(control.type)) return;
      if (composing.has(nodeId) || event.isComposing) { const draft = drafts.get(nodeId); if (draft) drafts.set(nodeId, { ...draft, control, composing: true }); return; }
      if (compositionEnd.delete(nodeId)) return;
      enqueue({ type: 'input', nodeId, value: control.value, inputType: event.inputType as Extract<DomEvent, { type: 'input' }>['inputType'], data: event.data, selectionStart: control.selectionStart, selectionEnd: control.selectionEnd, inputRevision: ++revision }, element);
    });
    for (const [name, phase] of [['compositionstart', 'start'], ['compositionupdate', 'update'], ['compositionend', 'end']] as const) listen(name, raw => {
      const event = raw as CompositionEvent, element = nodeOf(event.target), nodeId = idOf(element); if (!element || !nodeId || !allowed()) return;
      if (phase === 'start') { composing.add(nodeId); compositionEnd.delete(nodeId); }
      if (phase === 'end') { composing.delete(nodeId); compositionEnd.add(nodeId); queueMicrotask(() => compositionEnd.delete(nodeId)); }
      const text = event.data || '', control = readControl(element);
      enqueue({ type: 'composition', nodeId, phase: phase === 'end' && !text ? 'cancel' : phase, text, selectionStart: phase === 'start' ? control?.selectionStart || 0 : text.length, selectionEnd: phase === 'start' ? control?.selectionEnd || 0 : text.length, inputRevision: ++revision }, element, phase !== 'end');
    });
    listen('keydown', raw => {
      const event = raw as KeyboardEvent; if (!allowed()) { if (!['Tab', 'Shift', 'Control', 'Meta'].includes(event.key)) event.preventDefault(); return; }
      if (event.isComposing || event.key !== 'Escape') return;
      const nodeId = idOf(nodeOf(event.target)); if (nodeId) { event.preventDefault(); enqueue({ type: 'key', nodeId, key: 'Escape' }); }
    });
    listen('scroll', event => {
      const element = nodeOf(event.target), nodeId = idOf(element); if (!element || !nodeId || !allowed()) return;
      enqueue({ type: 'scroll', nodeId, top: element.scrollTop, left: element.scrollLeft });
    });
    resync.current = () => {
      if (!callbacks.current.onResync || sending || !window.confirm('아직 반영을 확인하지 못한 입력을 버리고 원격 화면의 현재 값을 불러올까요?')) return;
      void callbacks.current.onResync().then(next => {
        if (!alive) return;
        const checked = RemoteDomFrameSchema.parse(next); if (domIdentity(checked) !== identity) throw new Error('실행 화면이 바뀌었습니다.');
        queue.length = 0; drafts.clear(); eventOrders.clear(); localFocusOrder = 0; acknowledgedOrder = 0; composing.clear(); compositionEnd.clear(); renderer.dispose(); renderer = createDomRenderer(document, setNotice); blocked = false; setFailed(false); setPending(0); receive(checked); setNotice('원격 화면의 현재 값을 불러왔습니다.');
      }).catch(fail);
    };
    setNotice(''); setFailed(false); setPending(0);
    return () => { alive = false; queue.length = 0; drafts.clear(); for (const [name, listener] of listeners) document.removeEventListener(name, listener, true); renderer.dispose(); accept.current = () => {}; };
  }, [identity, loaded]);
  useEffect(() => { try { accept.current(frame); } catch (reason) { setFailed(true); setNotice('실행 화면의 내용을 안전하게 확인하지 못했습니다. 마지막 정상 화면을 유지합니다.'); callbacks.current.onError?.(reason); } }, [frame]);
  return <section aria-label="접근 가능한 원격 실행 화면">
    <iframe ref={iframe} srcDoc={REMOTE_DOM_DOCUMENT} sandbox="allow-same-origin" referrerPolicy="no-referrer" title="업무 실행 화면" data-testid="remote-dom-frame" onLoad={() => setLoaded(value => value + 1)} style={{ display: 'block', width: '100%', height: frame.height, border: 0 }} />
    <p role="status" className="subtle">{notice || (pending ? `입력 ${pending}건을 확인하고 있습니다.` : '표의 글자를 선택하고 입력칸과 버튼을 직접 사용할 수 있습니다.')}</p>
    {failed && onResync && <button className="quiet" onClick={() => resync.current()}>원격 상태 다시 불러오기</button>}
  </section>;
}
