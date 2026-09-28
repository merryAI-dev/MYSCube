import * as parse5 from 'parse5';

export const HTML_RUNTIME_VERSION = 'static-html-tailwind-v1';
export const HTML_DATA_CONTRACT_VERSION = 'no-data-v1';
export const MAX_HTML_LENGTH = 200_000;
export const HTML_PREVIEW_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const allowedTags = new Set(('html head body title meta style main header footer section article aside nav h1 h2 h3 h4 h5 h6 p span strong em b i u s small mark abbr time address cite blockquote code pre kbd samp ul ol li dl dt dd div hr br wbr table caption thead tbody tfoot tr td th colgroup col details summary a img figure figcaption progress meter').split(' '));
const commonAttrs = new Set(['id', 'class', 'lang', 'dir', 'role', 'title', 'hidden', 'tabindex', 'style']);
const tagAttrs = {
  meta: new Set(['charset', 'name', 'content']), a: new Set(['href']), img: new Set(['src', 'alt', 'width', 'height', 'loading', 'decoding']),
  th: new Set(['colspan', 'rowspan', 'scope', 'headers']), td: new Set(['colspan', 'rowspan', 'headers']),
  col: new Set(['span']), colgroup: new Set(['span']), details: new Set(['open', 'name']), time: new Set(['datetime']),
  ol: new Set(['start', 'reversed', 'type']), li: new Set(['value']), progress: new Set(['value', 'max']), meter: new Set(['value', 'min', 'max', 'low', 'high', 'optimum']),
};
const decodeCss = (value) => value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\(?:\r\n|[\r\n\f])/g, '').replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi,
  (_, hex, char) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char);

function validateHtmlDocument(source, maxLength) {
  const issues = [];
  const add = (code, message) => { if (!issues.some((issue) => issue.code === code)) issues.push({ code, message }); };
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { ok: false, issues: [{ code: 'source_required', message: '제목과 HTML 문서가 필요합니다.' }] };
  }
  if (typeof source.title !== 'string' || !source.title.trim() || source.title.trim().length > 80) {
    add('title_invalid', '페이지 제목은 1~80자로 입력해 주세요.');
  }
  if (typeof source.html !== 'string' || !source.html.trim() || source.html.length > maxLength) {
    add('html_size_invalid', `HTML 문서는 1~${maxLength.toLocaleString('en-US')}자까지 사용할 수 있습니다.`);
    return { ok: false, issues };
  }
  if (!/^\s*<!doctype\s+html\s*>/i.test(source.html) || !/<html\b[^>]*>/i.test(source.html)
    || !/<head\b[^>]*>[\s\S]*<\/head\s*>/i.test(source.html) || !/<body\b[^>]*>[\s\S]*<\/body\s*>/i.test(source.html)
    || !/<\/html\s*>\s*$/i.test(source.html)) {
    add('document_incomplete', 'DOCTYPE, html, head, body와 닫는 태그가 있는 완전한 HTML 문서가 필요합니다.');
  }
  let document;
  try {
    document = parse5.parse(source.html, { onParseError: (error) => {
      if (error.code === 'duplicate-attribute') add('duplicate_attribute', '같은 HTML 속성을 중복 지정할 수 없습니다.');
      else add('document_parse_error', 'HTML 태그나 속성의 문법이 맞지 않습니다. 열고 닫는 태그와 인코딩을 확인해 주세요.');
    } });
  } catch {
    return { ok: false, issues: [{ code: 'document_invalid', message: 'HTML 문서를 해석할 수 없습니다.' }] };
  }
  let head;
  let viewport = false;
  let cssLength = 0;
  const inspectCss = (value) => {
    cssLength += value.length;
    if (cssLength > 80_000) add('css_size_exceeded', 'CSS와 인라인 스타일은 합계 80,000자 이내로 구성해 주세요. 반복되는 스타일을 공통 클래스로 줄일 수 있습니다.');
    const css = decodeCss(value);
    if (/@(?:import|font-face|namespace)\b|\b(?:url|image-set|-webkit-image-set|expression)\s*\(|-moz-binding\s*:/i.test(css)) {
      add('css_resource_forbidden', 'CSS에서 외부 파일·글꼴을 불러오거나 URL을 사용할 수 없습니다. CSS 도형과 내장 이미지를 이용해 주세요.');
    }
  };
  const pending = [{ node: document, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (++nodes > 5000 || depth > 128) {
      add('document_complexity_exceeded', 'HTML 요소는 5,000개, 중첩은 128단계 이내로 구성해 주세요. 지나치게 반복되거나 겹친 구역을 줄여 주세요.');
      break;
    }
    if (node.tagName) {
      const tag = node.tagName;
      if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !allowedTags.has(tag)) {
        add('element_forbidden', '지원하지 않는 HTML 요소가 있습니다. script·이벤트·폼·외부 문서 없이 HTML/CSS와 details/summary로 구성해 주세요.');
      }
      if (tag === 'head') head = node;
      const attrs = Object.fromEntries((node.attrs || []).map(({ name, value }) => [name, value]));
      for (const attr of node.attrs || []) {
        if (attr.namespace || /^on/i.test(attr.name) || (!commonAttrs.has(attr.name) && !tagAttrs[tag]?.has(attr.name) && !/^aria-[a-z-]+$/.test(attr.name))) {
          add('attribute_forbidden', '실행 코드·외부 이동·지원하지 않는 HTML 속성은 사용할 수 없습니다.');
        }
        if (attr.name === 'style') inspectCss(attr.value);
      }
      if (tag === 'meta') {
        if (attrs.charset && !/^utf-?8$/i.test(attrs.charset)) add('charset_invalid', '문자 인코딩은 UTF-8을 사용해 주세요.');
        if (attrs.name === 'viewport' && /width\s*=\s*device-width/i.test(attrs.content || '')) viewport = true;
        else if (attrs.name && attrs.name !== 'description') add('meta_forbidden', 'meta는 UTF-8·viewport·페이지 설명에만 사용할 수 있습니다.');
      }
      if (tag === 'a' && attrs.href && !/^#[A-Za-z][\w:.-]*$/.test(attrs.href)) {
        add('resource_url_forbidden', '링크는 같은 문서의 제목이나 구역(#구역명)으로만 연결할 수 있습니다.');
      }
      if (tag === 'img' && (!attrs.src || !/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(attrs.src))) {
        add('resource_url_forbidden', '이미지는 문서 안에 포함된 PNG·JPEG·GIF·WebP만 사용할 수 있습니다.');
      }
      if (tag === 'style') inspectCss((node.childNodes || []).map((child) => child.value || '').join(''));
    }
    for (const child of node.childNodes || []) pending.push({ node: child, depth: depth + 1 });
    if (node.content) pending.push({ node: node.content, depth: depth + 1 });
  }
  if (!viewport) add('viewport_missing', '모바일 화면에 맞도록 head에 viewport width=device-width 설정을 넣어 주세요.');
  if (issues.length) return { ok: false, issues };
  // The stored source remains exact; only the execution copy receives the host policy.
  head.childNodes.unshift({ nodeName: 'meta', tagName: 'meta', namespaceURI: 'http://www.w3.org/1999/xhtml', parentNode: head,
    attrs: [{ name: 'http-equiv', value: 'Content-Security-Policy' }, { name: 'content', value: HTML_PREVIEW_CSP }], childNodes: [] });
  try {
    return { ok: true, issues: [], document: parse5.serialize(document) };
  } catch {
    return { ok: false, issues: [{ code: 'document_serialization_failed', message: '미리보기 문서를 만들지 못했습니다. HTML 중첩과 크기를 줄여 주세요.' }] };
  }
}

export function validateHtmlSource(source) {
  return validateHtmlDocument(source, MAX_HTML_LENGTH);
}

export function validateHtmlPreviewArtifact(html) {
  const failure = () => ({ ok: false, issues: [{ code: 'preview_policy_invalid', message: '미리보기 실행 정책이나 문서 검증값이 맞지 않아 표시하지 않았습니다. 원문에서 미리보기를 다시 만들어 주세요.' }] });
  if (typeof html !== 'string' || html.length > 400_000) return failure();
  let document;
  let parseError = false;
  try { document = parse5.parse(html, { sourceCodeLocationInfo: true, onParseError: () => { parseError = true; } }); }
  catch { return failure(); }
  if (parseError) return failure();
  const root = document.childNodes.find((node) => node.tagName === 'html');
  const head = root?.childNodes.find((node) => node.tagName === 'head');
  const policy = head?.childNodes[0];
  const attrs = Object.fromEntries((policy?.attrs || []).map(({ name, value }) => [name, value]));
  if (policy?.tagName !== 'meta' || policy.attrs.length !== 2 || attrs['http-equiv'] !== 'Content-Security-Policy'
    || attrs.content !== HTML_PREVIEW_CSP || !policy.sourceCodeLocation) return failure();
  const { startOffset, endOffset } = policy.sourceCodeLocation;
  const validation = validateHtmlDocument({ title: '저장된 미리보기', html: html.slice(0, startOffset) + html.slice(endOffset) }, 400_000);
  if (!validation.ok) return validation;
  return validation.document === html ? validation : failure();
}
