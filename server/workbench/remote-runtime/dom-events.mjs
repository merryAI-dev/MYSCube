import { RemoteDomEventSchema } from '../../../shared/workbench-remote-dom.mjs';
import { remoteError } from './contract.mjs';

export function checkDomEvent(value, frame) {
  const parsed = RemoteDomEventSchema.safeParse(value);
  if (!parsed.success) throw remoteError('remote_dom_event_invalid', '화면 조작 내용을 확인해 주세요.');
  const event = parsed.data;
  if (!frame || frame.kind !== 'dom' || ['sessionId', 'sourceHash', 'documentEpoch'].some(key => event[key] !== frame[key])) throw remoteError('remote_dom_generation_changed', '화면이 변경되었습니다. 새 화면에서 다시 입력해 주세요.', 409);
  if (event.baseRevision !== frame.snapshot.revision) throw remoteError('remote_dom_revision_changed', '화면 내용이 갱신되었습니다. 새 화면에서 다시 입력해 주세요.', 409);
  const node = frame.snapshot.nodes.find(item => item.id === event.nodeId);
  if (node?.kind !== 'element') throw remoteError('remote_dom_node_changed', '입력 요소가 변경되었습니다. 화면을 다시 확인해 주세요.', 409);
  const control = node.control;
  const nodes = new Map(frame.snapshot.nodes.map(item => [item.id, item])); let ancestor = node;
  while (ancestor?.kind === 'element') {
    if (event.type !== 'scroll' && (ancestor.style.display === 'none' || ancestor.style.visibility === 'hidden' || ancestor.style['pointer-events'] === 'none' || Object.hasOwn(ancestor.attributes, 'hidden'))) throw remoteError('remote_dom_control_hidden', '현재 보이지 않는 화면 요소입니다.', 409);
    ancestor = ancestor.parentId ? nodes.get(ancestor.parentId) : null;
  }
  if (event.type !== 'scroll' && (control?.disabled || Object.hasOwn(node.attributes, 'disabled') || node.style['pointer-events'] === 'none')) throw remoteError('remote_dom_control_disabled', '사용할 수 없는 화면 요소입니다.', 409);
  if (['input', 'composition'].includes(event.type) && (!control || ['checkbox', 'radio', 'select'].includes(control.type) || control.readOnly)) throw remoteError('remote_dom_control_invalid', '입력할 수 있는 텍스트 항목을 선택해 주세요.');
  if (event.type === 'composition' && event.phase === 'start' && event.selectionEnd > (control?.value.length ?? 0)) throw remoteError('remote_dom_selection_invalid', '조합을 시작할 선택 범위를 확인해 주세요.');
  if (event.type === 'composition' && !['text', 'search', 'textarea', 'tel', 'url'].includes(control?.type)) throw remoteError('remote_dom_composition_unsupported', '이 입력 형식은 조합 입력을 지원하지 않습니다.');
  if (event.type === 'check' && !['checkbox', 'radio'].includes(control?.type) || event.type === 'select' && control?.type !== 'select') throw remoteError('remote_dom_control_invalid', '입력 형식과 조작이 일치하지 않습니다.');
  if (event.type === 'submit') {
    if (node.tag !== 'form') throw remoteError('remote_dom_control_invalid', '제출할 입력 양식을 확인해 주세요.');
    if (event.submitterNodeId !== null) {
      const submitter = frame.snapshot.nodes.find(item => item.id === event.submitterNodeId);
      const parents = new Map(frame.snapshot.nodes.map(item => [item.id, item.parentId])); let parent = submitter?.parentId;
      while (parent && parent !== node.id) parent = parents.get(parent);
      if (submitter?.kind !== 'element' || submitter.tag !== 'button' || submitter.attributes.type === 'button' || submitter.attributes.type === 'reset' || parent !== node.id) throw remoteError('remote_dom_control_invalid', '제출 버튼과 양식이 일치하지 않습니다.');
    }
  }
  if (event.type === 'select') {
    const parents = new Map(frame.snapshot.nodes.map(item => [item.id, item.parentId]));
    const options = frame.snapshot.nodes.filter(item => item.kind === 'element' && item.tag === 'option' && (() => { let parent = item.parentId; while (parent && parent !== node.id) parent = parents.get(parent); return parent === node.id; })());
    const values = options.map(option => option.attributes.value ?? frame.snapshot.nodes.filter(item => item.parentId === option.id && item.kind === 'text').map(item => item.text).join(''));
    if (event.values.some(value => !values.includes(value)) || new Set(event.values).size !== event.values.length || !Object.hasOwn(node.attributes, 'multiple') && event.values.length !== 1) throw remoteError('remote_dom_control_invalid', '제시된 선택지 중에서 선택해 주세요.');
  }
  return event;
}

function trustedActions(root) {
  const apply = Reflect.apply;
  const getter = (type, name) => Object.getOwnPropertyDescriptor(type.prototype, name)?.get;
  const setter = (type, name) => Object.getOwnPropertyDescriptor(type.prototype, name)?.set;
  const connected = getter(Node, 'isConnected'), contains = Node.prototype.contains, matches = Element.prototype.matches;
  const inputType = getter(HTMLInputElement, 'type'), inputReadOnly = getter(HTMLInputElement, 'readOnly'), textareaReadOnly = getter(HTMLTextAreaElement, 'readOnly');
  const tagName = getter(Element, 'tagName'), checked = getter(HTMLInputElement, 'checked');
  const focus = HTMLElement.prototype.focus, click = HTMLElement.prototype.click, dispatch = EventTarget.prototype.dispatchEvent;
  const inputValue = setter(HTMLInputElement, 'value'), textareaValue = setter(HTMLTextAreaElement, 'value');
  const inputSelection = HTMLInputElement.prototype.setSelectionRange, textareaSelection = HTMLTextAreaElement.prototype.setSelectionRange;
  const options = getter(HTMLSelectElement, 'options'), optionValue = getter(HTMLOptionElement, 'value'), optionSelected = setter(HTMLOptionElement, 'selected');
  const submit = HTMLFormElement.prototype.requestSubmit;
  const scrollTop = setter(Element, 'scrollTop'), scrollLeft = setter(Element, 'scrollLeft');
  const NativeEvent = Event, NativeInputEvent = InputEvent;
  const selectRange = (node, start, end) => { if (start !== null && end !== null) apply(apply(tagName, node, []).toLowerCase() === 'textarea' ? textareaSelection : inputSelection, node, [start, end]); };
  return { perform(node, event, submitter) {
    if (!apply(connected, node, []) || !apply(contains, root, [node]) || apply(matches, node, [':disabled'])) throw new Error('dom_node_changed');
    const tag = apply(tagName, node, []).toLowerCase();
    if (['input', 'composition'].includes(event.type) && (tag === 'input' ? !['text', 'search', 'email', 'tel', 'url', 'number'].includes(apply(inputType, node, [])) || apply(inputReadOnly, node, []) : tag !== 'textarea' || apply(textareaReadOnly, node, []))) throw new Error('dom_control_changed');
    if (['focus', 'key'].includes(event.type)) apply(focus, node, [{ preventScroll: true }]);
    if (event.type === 'click') apply(click, node, []);
    if (event.type === 'input') {
      apply(focus, node, [{ preventScroll: true }]);
      apply(apply(tagName, node, []).toLowerCase() === 'textarea' ? textareaValue : inputValue, node, [event.value]);
      selectRange(node, event.selectionStart, event.selectionEnd);
      apply(dispatch, node, [new NativeInputEvent('input', { bubbles: true, composed: true, inputType: event.inputType, data: event.data })]);
    }
    if (event.type === 'check' && apply(checked, node, []) !== event.checked) apply(click, node, []);
    if (event.type === 'select') {
      for (const option of Array.from(apply(options, node, []))) apply(optionSelected, option, [event.values.includes(apply(optionValue, option, []))]);
      apply(dispatch, node, [new NativeEvent('input', { bubbles: true })]); apply(dispatch, node, [new NativeEvent('change', { bubbles: true })]);
    }
    if (event.type === 'submit') apply(submit, node, submitter ? [submitter] : []);
    if (event.type === 'scroll') { apply(scrollTop, node, [event.top]); apply(scrollLeft, node, [event.left]); }
    if (event.type === 'composition' && event.phase === 'start') { apply(focus, node, [{ preventScroll: true }]); selectRange(node, event.selectionStart, event.selectionEnd); }
  } };
}
export async function createDomEvents({ dom, page }) {
  const cdp = dom.cdp;
  const rootObjectId = await dom.resolveNode(dom.rootBackendNodeId);
  const helper = await cdp.send('Runtime.callFunctionOn', { objectId: rootObjectId, functionDeclaration: `function(){return (${trustedActions.toString()})(this)}`, returnByValue: false });
  await cdp.send('Runtime.releaseObject', { objectId: rootObjectId });
  if (!helper.result.objectId || helper.exceptionDetails) throw new Error('dom_actions_failed');
  const inputRevisions = new Map(); let composing = null;
  return {
    async apply(event) {
      const backend = dom.backendNode(event.nodeId); if (!backend) throw remoteError('remote_dom_node_changed', '입력 요소가 변경되었습니다.', 409);
      const previous = inputRevisions.get(event.nodeId) || 0;
      if (event.inputRevision && event.inputRevision <= previous) throw remoteError('remote_dom_input_changed', '이미 처리된 입력보다 이전 입력입니다.', 409);
      if (composing && (event.nodeId !== composing || !['composition', 'focus', 'scroll'].includes(event.type))) throw remoteError('remote_dom_composition_busy', '조합 입력을 완료한 다음 조작해 주세요.', 409);
      if (event.type === 'composition' && (event.phase === 'start' ? composing !== null : composing !== event.nodeId)) throw remoteError('remote_dom_composition_sequence', '조합 입력의 시작과 완료 순서를 확인해 주세요.', 409);
      const objectId = await dom.resolveNode(backend), submitter = event.type === 'submit' && event.submitterNodeId ? await dom.resolveNode(dom.backendNode(event.submitterNodeId)) : null;
      try {
        const result = await cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(helper,event,submitter){return helper.perform(this,event,submitter)}', arguments: [{ objectId: helper.result.objectId }, { value: event }, submitter ? { objectId: submitter } : { value: null }], returnByValue: true });
        if (result.exceptionDetails) throw remoteError('remote_dom_input_failed', '입력 결과를 확인하지 못했습니다. 화면을 다시 불러와 주세요.', 409);
        if (event.type === 'key') { await page.keyboard.press(event.key); }
        if (event.type === 'composition') {
          if (event.phase === 'start') composing = event.nodeId;
          if (event.phase === 'update') await cdp.send('Input.imeSetComposition', { text: event.text, selectionStart: event.selectionStart, selectionEnd: event.selectionEnd });
          if (event.phase === 'end') { await cdp.send('Input.insertText', { text: event.text }); composing = null; }
          if (event.phase === 'cancel') { await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); composing = null; }
        }
        if (event.inputRevision) inputRevisions.set(event.nodeId, event.inputRevision);
        if (inputRevisions.size > 1500) for (const id of inputRevisions.keys()) if (!dom.backendNode(id)) inputRevisions.delete(id);
      } finally { await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {}); if (submitter) await cdp.send('Runtime.releaseObject', { objectId: submitter }).catch(() => {}); }
    },
  };
}
