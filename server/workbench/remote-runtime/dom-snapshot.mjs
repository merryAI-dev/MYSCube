import { randomBytes } from 'node:crypto';
import { REMOTE_DOM_TAGS, REMOTE_DOM_ATTRIBUTE_NAMES, REMOTE_DOM_REFERENCE_ATTRIBUTES, REMOTE_DOM_STYLE_PROPERTIES, REMOTE_DOM_UNSUPPORTED_STYLES, REMOTE_DOM_UNSUPPORTED_STYLE_DEFAULTS, REMOTE_DOM_LIMITS, RemoteDomSnapshotSchema, isRemoteDomStyleValue } from '../../../shared/workbench-remote-dom.mjs';

function trustedRealm() {
  const getter = (type, name) => Object.getOwnPropertyDescriptor(type.prototype, name)?.get;
  const call = Function.prototype.call.bind(Function.prototype.call);
  const computed = window.getComputedStyle.bind(window), cssValue = CSSStyleDeclaration.prototype.getPropertyValue;
  const input = Object.fromEntries(['type', 'value', 'checked', 'disabled', 'readOnly', 'selectionStart', 'selectionEnd'].map(key => [key, getter(HTMLInputElement, key)]));
  const textarea = Object.fromEntries(['value', 'disabled', 'readOnly', 'selectionStart', 'selectionEnd'].map(key => [key, getter(HTMLTextAreaElement, key)]));
  const select = Object.fromEntries(['value', 'disabled', 'options'].map(key => [key, getter(HTMLSelectElement, key)]));
  const optionSelected = getter(HTMLOptionElement, 'selected'), optionValue = getter(HTMLOptionElement, 'value');
  const tagName = getter(Element, 'tagName'), active = getter(Document, 'activeElement'), matches = Element.prototype.matches;
  const value = (descriptor, node) => descriptor ? call(descriptor, node) : null;
  return {
    styles(node, properties) { const style = computed(node); return properties.map(property => call(cssValue, style, property)); },
    control(node) {
      const tag = value(tagName, node).toLowerCase();
      const fields = tag === 'input' ? input : tag === 'textarea' ? textarea : select;
      const type = tag === 'input' ? value(input.type, node) : tag;
      const options = tag === 'select' ? Array.from(value(select.options, node)) : [];
      return { type, value: value(fields.value, node), checked: tag === 'input' ? value(input.checked, node) : false,
        selectedValues: options.filter(option => value(optionSelected, option)).map(option => value(optionValue, option)),
        disabled: call(matches, node, ':disabled'), readOnly: fields.readOnly ? value(fields.readOnly, node) : false,
        selectionStart: fields.selectionStart ? value(fields.selectionStart, node) : null, selectionEnd: fields.selectionEnd ? value(fields.selectionEnd, node) : null };
    },
    active() { return value(active, document); },
  };
}
const rareValue = (rare, index, strings) => { const position = rare?.index?.indexOf(index) ?? -1; return position < 0 ? null : strings[rare.value[position]]; };
const issue = (code, message, nodeId) => ({ code, message, ...(nodeId ? { nodeId } : {}) });

export async function createDomSnapshot({ cdp, frameId, rootBackendNodeId }) {
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: `axr-dom-${randomBytes(12).toString('hex')}` });
  const helper = await cdp.send('Runtime.evaluate', { expression: `(${trustedRealm.toString()})()`, contextId: executionContextId, returnByValue: false });
  if (!helper.result?.objectId || helper.exceptionDetails) throw new Error('dom_realm_failed');
  let revision = 0, nodeMap = new Map(), lastSnapshot = null;
  const resolveNode = async (backendNodeId) => (await cdp.send('DOM.resolveNode', { backendNodeId, executionContextId })).object.objectId;
  const callNode = async (backendNodeId, method, args = []) => {
    const objectId = await resolveNode(backendNodeId);
    try {
      const result = await cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(helper,method,args){return helper[method](this,...args)}', arguments: [{ objectId: helper.result.objectId }, { value: method }, { value: args }], returnByValue: true });
      if (result.exceptionDetails) throw new Error('dom_property_failed'); return result.result.value;
    } finally { await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {}); }
  };
  const capture = async (ack = null) => {
    const properties = [...REMOTE_DOM_STYLE_PROPERTIES, ...REMOTE_DOM_UNSUPPORTED_STYLES];
    const raw = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: properties });
    const document = raw.documents[0], tree = document?.nodes, strings = raw.strings;
    if (!tree || tree.nodeType.length > 6000 || strings.length > 30000) return { unsupported: [issue('dom_budget', '화면 요소가 많아 이미지 미리보기로만 확인할 수 있습니다.')] };
    const rootIndex = tree.backendNodeId.indexOf(rootBackendNodeId);
    if (rootIndex < 0) return { unsupported: [issue('dom_root_changed', '화면의 시작 요소가 변경되어 새 미리보기가 필요합니다.')] };
    const outsideRoot = tree.parentIndex.some((parent, index) => index !== rootIndex && parent === tree.parentIndex[rootIndex] && (tree.nodeType[index] === 1 || tree.nodeType[index] === 3 && (tree.nodeValue[index] === -1 ? '' : strings[tree.nodeValue[index]]).trim()));
    if (outsideRoot) return { unsupported: [issue('dom_portal_unsupported', '시작 화면 밖에 표시된 요소는 이미지 미리보기에서 확인해 주세요.')] };
    const selected = [], included = new Set(), idMap = new Map(), nextMap = new Map(), duplicateIds = new Set();
    const issues = [], addIssue = (value) => { if (issues.length < 20) issues.push(value); };
    for (let index = rootIndex; index < tree.nodeType.length; index++) {
      if (index !== rootIndex && !included.has(tree.parentIndex[index])) continue;
      included.add(index); selected.push(index);
      const backend = tree.backendNodeId[index], id = nodeMap.get(backend)?.id || `n_${randomBytes(12).toString('hex')}`;
      nextMap.set(backend, { id, backend });
      if (selected.length > REMOTE_DOM_LIMITS.nodes) return { unsupported: [issue('dom_budget', '화면 요소 수가 한도를 넘어 이미지로 표시합니다.')] };
      const flat = tree.attributes[index] || [];
      for (let offset = 0; offset < flat.length; offset += 2) if (strings[flat[offset]] === 'id') {
        const original = flat[offset + 1] === -1 ? '' : strings[flat[offset + 1]]; if (idMap.has(original)) duplicateIds.add(original); else idMap.set(original, id);
      }
    }
    const layout = new Map(document.layout.nodeIndex.map((index, position) => [index, document.layout.styles[position].map(item => strings[item])]));
    const nodes = [];
    for (const index of selected) {
      const entry = nextMap.get(tree.backendNodeId[index]), parentId = index === rootIndex ? null : nextMap.get(tree.backendNodeId[tree.parentIndex[index]])?.id;
      if (tree.nodeType[index] === 8) continue;
      if (tree.nodeType[index] === 3) { nodes.push({ id: entry.id, parentId, kind: 'text', text: tree.nodeValue[index] === -1 ? '' : strings[tree.nodeValue[index]] }); continue; }
      const tag = strings[tree.nodeName[index]].toLowerCase();
      if (tree.nodeType[index] !== 1 || !REMOTE_DOM_TAGS.includes(tag) || rareValue(tree.shadowRootType, index, strings) || rareValue(tree.pseudoType, index, strings)) {
        addIssue(issue('dom_element_unsupported', '이 화면의 일부 요소는 아직 텍스트 미리보기를 지원하지 않습니다.', entry.id)); continue;
      }
      const attributes = { id: entry.id }, flat = tree.attributes[index] || [];
      for (let offset = 0; offset < flat.length; offset += 2) {
        const name = strings[flat[offset]], value = flat[offset + 1] === -1 ? '' : strings[flat[offset + 1]];
        if (name === 'id' || name === 'class' || name === 'style' || name.startsWith('data-') || name.startsWith('on')) continue;
        if (['href', 'src', 'srcset', 'action', 'formaction', 'contenteditable', 'autofocus', 'accesskey'].includes(name)) { addIssue(issue('dom_attribute_unsupported', '링크 이동·파일·직접 편집 기능은 이미지 미리보기를 이용해 주세요.', entry.id)); continue; }
        if (!REMOTE_DOM_ATTRIBUTE_NAMES.includes(name)) { addIssue(issue('dom_attribute_unsupported', '일부 요소 속성은 아직 텍스트 미리보기를 지원하지 않습니다.', entry.id)); continue; }
        if (REMOTE_DOM_REFERENCE_ATTRIBUTES.includes(name)) {
          const referenced = value.trim().split(/\s+/);
          if (referenced.some(original => !idMap.has(original) || duplicateIds.has(original))) addIssue(issue('dom_reference_invalid', '레이블 또는 접근성 연결을 확인하지 못했습니다.', entry.id));
          else attributes[name] = referenced.map(original => idMap.get(original)).join(' ');
        } else attributes[name] = value;
      }
      const values = layout.get(index) || await callNode(entry.backend, 'styles', [properties]);
      const style = {};
      for (let position = 0; position < properties.length; position++) {
        const name = properties[position], value = values[position];
        if (REMOTE_DOM_UNSUPPORTED_STYLES.includes(name)) {
          if (value && value !== REMOTE_DOM_UNSUPPORTED_STYLE_DEFAULTS[name]) addIssue(issue('dom_style_unsupported', '효과·배경 그림·애니메이션은 이미지 미리보기에서 확인해 주세요.', entry.id));
        } else if (isRemoteDomStyleValue(name, value)) style[name] = value;
        else addIssue(issue('dom_style_unsupported', '일부 화면 스타일은 아직 텍스트 미리보기를 지원하지 않습니다.', entry.id));
      }
      const control = ['input', 'textarea', 'select'].includes(tag) ? await callNode(entry.backend, 'control') : undefined;
      nodes.push({ id: entry.id, parentId, kind: 'element', tag, attributes, style, ...(control ? { control } : {}) });
    }
    if (issues.length) return { unsupported: issues };
    const active = await cdp.send('Runtime.callFunctionOn', { objectId: helper.result.objectId, functionDeclaration: 'function(){return this.active()}', returnByValue: false });
    let focusedNodeId = null;
    if (active.result.objectId) {
      try { const description = await cdp.send('DOM.describeNode', { objectId: active.result.objectId }); focusedNodeId = nextMap.get(description.node.backendNodeId)?.id || null; }
      finally { await cdp.send('Runtime.releaseObject', { objectId: active.result.objectId }).catch(() => {}); }
    }
    const result = RemoteDomSnapshotSchema.safeParse({ schemaVersion: 1, revision: revision + 1, rootNodeId: nextMap.get(rootBackendNodeId).id, nodes, focusedNodeId, ack });
    if (!result.success) return { unsupported: [issue('dom_contract_unsupported', '요소·입력값·레이아웃이 지원 범위를 넘어 이미지 미리보기를 표시합니다.')] };
    nodeMap = nextMap; lastSnapshot = result.data; revision++;
    return { snapshot: lastSnapshot };
  };
  return { capture, cdp, executionContextId, rootBackendNodeId, resolveNode, get snapshot() { return lastSnapshot; }, backendNode(id) { return [...nodeMap.values()].find(value => value.id === id)?.backend; } };
}
