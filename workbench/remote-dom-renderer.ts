import { RemoteDomFrameSchema, REMOTE_DOM_REFERENCE_ATTRIBUTES } from '../shared/workbench-remote-dom.mjs';
import { settleDrafts, type DomFrame, type InputDraft } from './remote-dom-input';

export const REMOTE_DOM_DOCUMENT = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; form-action &#39;none&#39;; base-uri &#39;none&#39;"><meta name="referrer" content="no-referrer"><title>업무 실행 화면</title></head><body></body></html>';
export function createDomRenderer(document: Document, announce: (message: string) => void) {
  const nodes = new Map<string, Node>();
  let last: DomFrame | null = null;
  document.body.style.margin = '0';
  const prefix = `view-${crypto.randomUUID()}-`;
  function apply(raw: DomFrame, drafts: Map<string, InputDraft>, followRemoteFocus = false) {
    const frame = RemoteDomFrameSchema.parse(raw);
    if (last && (frame.sessionId !== last.sessionId || frame.sourceHash !== last.sourceHash || frame.documentEpoch !== last.documentEpoch)) throw new Error('실행 화면이 바뀌었습니다. 새 화면을 다시 확인해 주세요.');
    if (last && frame.snapshot.revision <= last.snapshot.revision) return;
    const active = document.activeElement, focusedId = active?.getAttribute('data-remote-node');
    settleDrafts(drafts, frame);
    const retained = new Set(frame.snapshot.nodes.map(node => node.id));
    for (const [id, node] of nodes) if (!retained.has(id)) { node.parentNode?.removeChild(node); nodes.delete(id); }
    const positions = new Map<Node, number>();
    for (const item of frame.snapshot.nodes) {
      let node = nodes.get(item.id);
      const valid = node && (item.kind === 'text' ? node.nodeType === 3 : node.nodeType === 1 && (node as Element).localName === item.tag);
      if (!valid) { node?.parentNode?.removeChild(node); node = item.kind === 'text' ? document.createTextNode(item.text) : document.createElement(item.tag); nodes.set(item.id, node); }
      const target = node!;
      if (item.kind === 'text') { if (target.textContent !== item.text) target.textContent = item.text; }
      else {
        const element = target as HTMLElement;
        const attributes: Record<string, string> = { ...item.attributes, id: prefix + item.id, 'data-remote-node': item.id };
        if (item.id === frame.snapshot.rootNodeId && document.activeElement === element && !('tabindex' in attributes)) attributes.tabindex = '-1';
        for (const name of REMOTE_DOM_REFERENCE_ATTRIBUTES) if (attributes[name]) attributes[name] = attributes[name].split(' ').map(id => prefix + id).join(' ');
        for (const attribute of [...element.attributes]) if (!(attribute.name in attributes) && attribute.name !== 'style') element.removeAttribute(attribute.name);
        for (const [name, value] of Object.entries(attributes)) if (!['checked', 'selected'].includes(name) && !(name === 'value' && ['input', 'textarea'].includes(item.tag)) && element.getAttribute(name) !== value) element.setAttribute(name, value);
        for (const name of [...element.style]) if (!(name in item.style)) element.style.removeProperty(name);
        for (const [name, value] of Object.entries(item.style)) if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
        if (['input', 'textarea'].includes(item.tag)) element.setAttribute('autocomplete', 'off');
        if (item.tag === 'form') (element as HTMLFormElement).noValidate = true;
      }
      const parent = item.parentId ? nodes.get(item.parentId)! : document.body;
      const position = positions.get(parent) || 0;
      if (parent.childNodes[position] !== target) parent.insertBefore(target, parent.childNodes[position] || null);
      positions.set(parent, position + 1);
    }
    for (const item of frame.snapshot.nodes) if (item.kind === 'element' && item.control) {
      const element = nodes.get(item.id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      const state = drafts.get(item.id)?.control || item.control;
      const changed = element.value !== state.value && element.localName !== 'select';
      const selection = 'selectionStart' in element ? { start: element.selectionStart, end: element.selectionEnd } : null;
      if (changed) element.value = state.value;
      if ('maxLength' in element) element.maxLength = Math.min(Number(item.attributes.maxlength || 2000), 2000);
      element.disabled = item.control.disabled;
      if ('readOnly' in element) element.readOnly = item.control.readOnly;
      if ('checked' in element) element.checked = state.checked;
      if (element.localName === 'select') for (const option of (element as HTMLSelectElement).options) option.selected = state.selectedValues.includes(option.value);
      if (changed && document.activeElement === element && 'setSelectionRange' in element && (drafts.get(item.id)?.control.selectionStart ?? selection?.start) !== null) {
        try { element.setSelectionRange(Math.min(state.value.length, drafts.get(item.id)?.control.selectionStart ?? selection?.start ?? 0), Math.min(state.value.length, drafts.get(item.id)?.control.selectionEnd ?? selection?.end ?? 0)); } catch { /* Numeric inputs have no text selection. */ }
      }
    }
    if (focusedId && !retained.has(focusedId)) {
      const root = nodes.get(frame.snapshot.rootNodeId) as HTMLElement; root.tabIndex = -1; root.focus({ preventScroll: true }); announce('선택한 입력 항목이 사라져 화면의 시작으로 이동했습니다.');
    }
    if (followRemoteFocus && frame.snapshot.focusedNodeId && drafts.size === 0) {
      const target = nodes.get(frame.snapshot.focusedNodeId) as HTMLElement | undefined;
      if (target && document.activeElement !== target) target.focus({ preventScroll: true });
    }
    last = frame;
  }
  return { apply, nodes, dispose() { nodes.clear(); document.body.replaceChildren(); last = null; } };
}
