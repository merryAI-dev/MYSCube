import * as z from 'zod/v4';

export const REMOTE_DOM_LIMITS = Object.freeze({ nodes: 1500, depth: 40, textBytes: 120000, snapshotBytes: 480000, stylesPerNode: 90, attributesPerNode: 24, inputLength: 2000, eventBytes: 16000, replayFrames: 16, layoutArea: 16000000 });
export const REMOTE_DOM_TAGS = Object.freeze(['div', 'span', 'p', 'main', 'section', 'article', 'header', 'footer', 'aside', 'nav', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'col', 'colgroup', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'button', 'label', 'input', 'textarea', 'select', 'option', 'optgroup', 'form', 'fieldset', 'legend', 'details', 'summary', 'hr', 'br', 'strong', 'b', 'em', 'i', 'small', 'code', 'pre', 'time', 'abbr', 's', 'sup', 'sub', 'blockquote']);
const attributeNames = ['id', 'title', 'lang', 'dir', 'role', 'for', 'name', 'placeholder', 'type', 'value', 'min', 'max', 'step', 'maxlength', 'minlength', 'rows', 'cols', 'size', 'colspan', 'rowspan', 'scope', 'headers', 'start', 'reversed', 'open', 'hidden', 'tabindex', 'autocomplete', 'inputmode', 'required', 'novalidate', 'formnovalidate', 'multiple', 'disabled', 'readonly', 'checked', 'selected', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-expanded', 'aria-hidden', 'aria-live', 'aria-atomic', 'aria-current', 'aria-pressed', 'aria-checked', 'aria-selected', 'aria-required', 'aria-invalid', 'aria-disabled', 'aria-busy', 'aria-sort', 'aria-rowcount', 'aria-colcount', 'aria-rowindex', 'aria-colindex', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext'];
export const REMOTE_DOM_ATTRIBUTE_NAMES = Object.freeze(attributeNames);
export const REMOTE_DOM_REFERENCE_ATTRIBUTES = Object.freeze(['for', 'headers', 'aria-labelledby', 'aria-describedby', 'aria-controls']);
const sizes = ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'top', 'right', 'bottom', 'left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius', 'row-gap', 'column-gap', 'flex-basis', 'letter-spacing', 'text-indent'];
const enums = {
  display: ['none', 'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'table', 'inline-table', 'table-row-group', 'table-header-group', 'table-footer-group', 'table-row', 'table-cell', 'table-column', 'table-column-group', 'table-caption', 'list-item', 'contents'],
  position: ['static', 'relative', 'absolute', 'fixed', 'sticky'], visibility: ['visible', 'hidden', 'collapse'],
  'box-sizing': ['border-box', 'content-box'], 'flex-direction': ['row', 'row-reverse', 'column', 'column-reverse'], 'flex-wrap': ['nowrap', 'wrap', 'wrap-reverse'],
  'justify-content': ['normal', 'start', 'end', 'flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly', 'stretch'],
  'align-items': ['normal', 'start', 'end', 'flex-start', 'flex-end', 'center', 'baseline', 'stretch'], 'align-self': ['auto', 'normal', 'start', 'end', 'flex-start', 'flex-end', 'center', 'baseline', 'stretch'],
  'overflow-x': ['visible', 'hidden', 'clip', 'scroll', 'auto'], 'overflow-y': ['visible', 'hidden', 'clip', 'scroll', 'auto'],
  'font-style': ['normal', 'italic', 'oblique'], 'text-align': ['start', 'end', 'left', 'right', 'center', 'justify'],
  'white-space': ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'], 'word-break': ['normal', 'break-all', 'keep-all', 'break-word'], 'overflow-wrap': ['normal', 'break-word', 'anywhere'],
  'text-transform': ['none', 'capitalize', 'uppercase', 'lowercase'], 'pointer-events': ['auto', 'none'], 'direction': ['ltr', 'rtl'],
  'text-overflow': ['clip', 'ellipsis'], 'text-decoration-line': ['none', 'underline', 'overline', 'line-through', 'underline line-through'],
  'border-collapse': ['collapse', 'separate'], 'table-layout': ['auto', 'fixed'], 'vertical-align': ['baseline', 'top', 'middle', 'bottom', 'text-top', 'text-bottom', 'sub', 'super'],
  'list-style-type': ['none', 'disc', 'circle', 'square', 'decimal', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman'],
};
const colors = ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'];
const borders = ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'];
export const REMOTE_DOM_STYLE_PROPERTIES = Object.freeze([...sizes, ...Object.keys(enums), ...colors, ...borders, 'font-size', 'font-family', 'font-weight', 'line-height', 'opacity', 'flex-grow', 'flex-shrink', 'order', 'z-index', 'grid-template-columns', 'grid-template-rows', 'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end', 'box-shadow']);
export const REMOTE_DOM_UNSUPPORTED_STYLE_DEFAULTS = Object.freeze({ 'background-image': 'none', filter: 'none', 'backdrop-filter': 'none', transform: 'none', translate: 'none', rotate: 'none', scale: 'none', 'clip-path': 'none', clip: 'auto', 'animation-name': 'none', 'mask-image': 'none', 'offset-path': 'none', 'content-visibility': 'visible', '-webkit-text-security': 'none', 'mix-blend-mode': 'normal', perspective: 'none', 'writing-mode': 'horizontal-tb', float: 'none', zoom: '1' });
export const REMOTE_DOM_UNSUPPORTED_STYLES = Object.freeze(Object.keys(REMOTE_DOM_UNSUPPORTED_STYLE_DEFAULTS));
const length = (value, min = -4096, max = 4096) => /^-?(?:\d+|\d*\.\d+)px$/.test(value) && Number(value.slice(0, -2)) >= min && Number(value.slice(0, -2)) <= max;
const color = (value) => /^(?:(?:rgba?|hsla?|oklch|oklab|lab|lch)\([\d.,% /+-]+\)|transparent|currentcolor)$/.test(value) && value.length <= 80;
export function isRemoteDomStyleValue(property, value) {
  if (typeof value !== 'string' || value.length > 400 || /[;{}<>\\]|url|@|expression/i.test(value)) return false;
  if (Object.hasOwn(enums, property)) return enums[property].includes(value);
  if (property.endsWith('-radius')) return /^(?:\d+|\d*\.\d+)%$/.test(value) && Number(value.slice(0, -1)) <= 100 || /^(?:\d+|\d*\.\d+)(?:e\+?\d+)?px$/.test(value) && Number(value.slice(0, -2)) <= 3.5e38;
  if (sizes.includes(property)) return ['auto', 'none', 'normal', 'min-content', 'max-content', 'fit-content'].includes(value) || length(value);
  if (colors.includes(property)) return color(value);
  if (borders.includes(property)) return ['none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'].includes(value);
  if (property === 'font-size') return length(value, 4, 96);
  if (property === 'font-family') return /^[\p{L}\p{N}_\s,"'-]+$/u.test(value) && value.length <= 200;
  if (property === 'font-weight') return /^(?:normal|bold|[1-9]00)$/.test(value);
  if (property === 'line-height') return value === 'normal' || length(value, 0, 256);
  if (property === 'opacity') return /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value);
  if (['flex-grow', 'flex-shrink', 'order', 'z-index'].includes(property)) return value === 'auto' && property === 'z-index' || /^-?\d+(?:\.\d+)?$/.test(value) && Number(value) >= -100 && Number(value) <= 100;
  if (/^grid-(?:row|column)-(?:start|end)$/.test(property)) return value === 'auto' || /^-?\d+$/.test(value) && Math.abs(Number(value)) <= 40 || /^span \d+$/.test(value) && Number(value.slice(5)) <= 20;
  if (property.startsWith('grid-template-')) return value === 'none' || value.split(' ').length <= 20 && value.split(' ').every((part) => length(part, 0));
  if (property === 'box-shadow') {
    if (value === 'none') return true;
    let validColors = true;
    const remainder = value.replace(/(?:rgba?|hsla?|oklch|oklab|lab|lch)\([^)]*\)/g, (item) => { validColors &&= color(item); return ''; }).replace(/\binset\b/g, '');
    return validColors && /^[\d.,px -]+$/.test(remainder) && (remainder.match(/px/g) || []).length <= 32 && [...remainder.matchAll(/(-?[\d.]+)px/g)].every((match) => Math.abs(Number(match[1])) <= 16);
  }
  return false;
}
const nodeId = z.string().regex(/^n_[a-f0-9]{24}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const inputValue = z.string().max(REMOTE_DOM_LIMITS.inputLength);
const selection = z.number().int().min(0).max(REMOTE_DOM_LIMITS.inputLength).nullable();
const attributes = z.record(z.string(), z.string().max(500)).superRefine((value, context) => {
  if (Object.keys(value).length > REMOTE_DOM_LIMITS.attributesPerNode || Object.keys(value).some((key) => !attributeNames.includes(key))) context.addIssue({ code: 'custom', message: '지원하지 않는 속성이 있습니다.' });
  if (value.id && !nodeId.safeParse(value.id).success) context.addIssue({ code: 'custom', message: '화면 요소 ID가 유효하지 않습니다.' });
  if (value.tabindex && !['0', '-1'].includes(value.tabindex)) context.addIssue({ code: 'custom', message: '양수 탭 순서는 지원하지 않습니다.' });
  const numericBounds = { colspan: 50, rowspan: 50, rows: 40, cols: 200, size: 100, maxlength: 2000, minlength: 2000 };
  for (const [key, max] of Object.entries(numericBounds)) if (value[key] !== undefined && (!/^\d+$/.test(value[key]) || Number(value[key]) > max)) context.addIssue({ code: 'custom', message: '화면 요소의 크기 한도를 넘었습니다.' });
  if (value.autocomplete && value.autocomplete !== 'off') context.addIssue({ code: 'custom', message: '자동 완성 입력은 지원하지 않습니다.' });
  if (value.type && !['text', 'search', 'email', 'tel', 'url', 'number', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(value.type)) context.addIssue({ code: 'custom', message: '지원하지 않는 입력 형식입니다.' });
});
const styles = z.record(z.string(), z.string()).superRefine((value, context) => {
  if (Object.keys(value).length > REMOTE_DOM_LIMITS.stylesPerNode || Object.entries(value).some(([key, item]) => !isRemoteDomStyleValue(key, item))) context.addIssue({ code: 'custom', message: '지원하지 않는 화면 스타일입니다.' });
});
export const RemoteDomControlSchema = z.object({ type: z.enum(['text', 'search', 'email', 'tel', 'url', 'number', 'textarea', 'checkbox', 'radio', 'select']), value: inputValue,
  checked: z.boolean(), selectedValues: z.array(inputValue).max(100), disabled: z.boolean(), readOnly: z.boolean(), selectionStart: selection, selectionEnd: selection,
}).strict().superRefine((value, context) => { if ((value.selectionStart === null) !== (value.selectionEnd === null) || value.selectionStart !== null && (value.selectionEnd === null || value.selectionStart > value.selectionEnd || value.selectionEnd > value.value.length)) context.addIssue({ code: 'custom', message: '선택 영역이 입력값 범위를 벗어났습니다.' }); });
export const RemoteDomNodeSchema = z.discriminatedUnion('kind', [
  z.object({ id: nodeId, parentId: nodeId.nullable(), kind: z.literal('text'), text: z.string().max(REMOTE_DOM_LIMITS.textBytes) }).strict(),
  z.object({ id: nodeId, parentId: nodeId.nullable(), kind: z.literal('element'), tag: z.enum(REMOTE_DOM_TAGS), attributes, style: styles, control: RemoteDomControlSchema.optional() }).strict(),
]);
const ack = z.object({ eventId: z.string().uuid(), inputRevision: integer.optional() }).strict();
export const RemoteDomSnapshotSchema = z.object({ schemaVersion: z.literal(1), revision: integer.min(1), rootNodeId: nodeId, nodes: z.array(RemoteDomNodeSchema).min(1).max(REMOTE_DOM_LIMITS.nodes), focusedNodeId: nodeId.nullable(), ack: ack.nullable() }).strict().superRefine((value, context) => {
  const byId = new Map(), depths = new Map(); let textBytes = 0, layoutArea = 0;
  const issue = (message) => context.addIssue({ code: 'custom', message });
  for (const node of value.nodes) {
    if (byId.has(node.id) || node.parentId === null && node.id !== value.rootNodeId || node.parentId !== null && (!byId.has(node.parentId) || byId.get(node.parentId).kind !== 'element')) issue('노드 연결과 순서를 확인할 수 없습니다.');
    const depth = node.parentId === null ? 0 : (depths.get(node.parentId) ?? REMOTE_DOM_LIMITS.depth) + 1;
    if (depth > REMOTE_DOM_LIMITS.depth) issue('화면 중첩이 한도를 넘었습니다.');
    byId.set(node.id, node); depths.set(node.id, depth);
    if (node.kind === 'text') textBytes += new TextEncoder().encode(node.text).length;
    if (node.kind === 'element') {
      const width = Number.parseFloat(node.style.width), height = Number.parseFloat(node.style.height);
      if (Number.isFinite(width) && Number.isFinite(height)) layoutArea += Math.max(0, width) * Math.max(0, height);
      if (node.attributes.id !== node.id) issue('화면 요소 ID가 원본 노드와 다릅니다.');
      if (['input', 'textarea', 'select'].includes(node.tag) ? !node.control || node.control.type !== (node.tag === 'input' ? node.attributes.type || 'text' : node.tag) : node.control !== undefined) issue('입력값이 입력 요소에 연결되지 않았습니다.');
    }
  }
  if (value.nodes[0]?.id !== value.rootNodeId || value.nodes[0]?.parentId !== null || value.nodes[0]?.kind !== 'element') issue('화면 루트가 유효하지 않습니다.');
  for (const node of value.nodes) if (node.kind === 'element') for (const name of REMOTE_DOM_REFERENCE_ATTRIBUTES) if (node.attributes[name]) {
    for (const id of node.attributes[name].split(' ')) if (byId.get(id)?.kind !== 'element') issue('레이블 또는 접근성 연결을 확인할 수 없습니다.');
  }
  if (value.focusedNodeId && byId.get(value.focusedNodeId)?.kind !== 'element') issue('포커스 요소를 확인할 수 없습니다.');
  if (layoutArea > REMOTE_DOM_LIMITS.layoutArea) issue('화면 배치 면적이 한도를 넘었습니다.');
  if (textBytes > REMOTE_DOM_LIMITS.textBytes || new TextEncoder().encode(JSON.stringify(value)).length > REMOTE_DOM_LIMITS.snapshotBytes) issue('화면 데이터가 전달 한도를 넘었습니다.');
});
const identityShape = { sessionId: z.string().uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), documentEpoch: z.string().uuid() };
export const RemoteDomFrameSchema = z.object({ kind: z.literal('dom'), ...identityShape, sequence: integer.min(1), width: z.number().int().min(320).max(1600), height: z.number().int().min(240).max(1200), snapshot: RemoteDomSnapshotSchema }).strict();
const eventShape = { ...identityShape, eventId: z.string().uuid(), nodeId, baseRevision: integer.min(1) };
export const RemoteDomEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventShape, type: z.literal('focus') }).strict(), z.object({ ...eventShape, type: z.literal('click') }).strict(),
  z.object({ ...eventShape, type: z.literal('input'), value: inputValue, inputType: z.enum(['insertText', 'insertFromPaste', 'deleteContentBackward', 'deleteContentForward', 'deleteByCut', 'insertLineBreak', 'historyUndo', 'historyRedo', 'insertReplacementText']), data: inputValue.nullable(), selectionStart: selection, selectionEnd: selection, inputRevision: integer.min(1) }).strict(),
  z.object({ ...eventShape, type: z.literal('check'), checked: z.boolean(), inputRevision: integer.min(1) }).strict(),
  z.object({ ...eventShape, type: z.literal('select'), values: z.array(inputValue).max(100), inputRevision: integer.min(1) }).strict(),
  z.object({ ...eventShape, type: z.literal('composition'), phase: z.enum(['start', 'update', 'end', 'cancel']), text: inputValue, selectionStart: integer.max(2000), selectionEnd: integer.max(2000), inputRevision: integer.min(1) }).strict(),
  z.object({ ...eventShape, type: z.literal('key'), key: z.enum(['Enter', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) }).strict(),
  z.object({ ...eventShape, type: z.literal('submit'), submitterNodeId: nodeId.nullable() }).strict(),
  z.object({ ...eventShape, type: z.literal('scroll'), top: z.number().min(0).max(100000), left: z.number().min(0).max(100000) }).strict(),
]).superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).length > REMOTE_DOM_LIMITS.eventBytes) context.addIssue({ code: 'custom', message: '조작 데이터가 한도를 넘었습니다.' });
  if (value.type === 'input' && ((value.selectionStart === null) !== (value.selectionEnd === null) || value.selectionStart !== null && (value.selectionEnd === null || value.selectionStart > value.selectionEnd || value.selectionEnd > value.value.length))) context.addIssue({ code: 'custom', message: '입력 선택 범위가 유효하지 않습니다.' });
  if (value.type === 'composition' && (value.selectionStart > value.selectionEnd || ['update', 'end'].includes(value.phase) && value.selectionEnd > value.text.length)) context.addIssue({ code: 'custom', message: '조합 선택 범위가 유효하지 않습니다.' });
});
export const RemoteDomUnsupportedSchema = z.array(z.object({ code: z.string().regex(/^[a-z_]+$/).max(80), message: z.string().max(200), nodeId: nodeId.optional() }).strict()).min(1).max(20);
