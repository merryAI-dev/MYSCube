import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import * as parse5 from 'parse5';
import { createHttpError } from '../bff/bff-utils.mjs';
import { HTML_RUNTIME_VERSION, HTML_DATA_CONTRACT_VERSION, validateHtmlSource, validateHtmlPreviewArtifact } from '../../shared/workbench-html.mjs';

export const TAILWIND_VERSION = '4.1.12';
const MAX_CANDIDATES = 1500;
const MAX_CSS_LENGTH = 80_000;
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const base = fileURLToPath(new URL('../../', import.meta.url));
let activeWorkers = 0;

if (!isMainThread && workerData?.kind === 'compile-workbench-tailwind') {
  try {
    const require = createRequire(import.meta.url);
    const compilerPackage = JSON.parse(readFileSync(resolve(dirname(require.resolve('@tailwindcss/node')), '../package.json'), 'utf8'));
    if (require('tailwindcss/package.json').version !== TAILWIND_VERSION || compilerPackage.version !== TAILWIND_VERSION) {
      throw new Error('compiler_version_mismatch');
    }
    const { compile } = await import('@tailwindcss/node');
    const compiler = await compile('@import "tailwindcss";', { base, onDependency: () => {} });
    const css = compiler.build(workerData.candidates);
    parentPort.postMessage({ ok: true, css });
  } catch {
    parentPort.postMessage({ ok: false });
  }
}

function compileCandidates(candidates, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (activeWorkers >= 2) {
      reject(createHttpError(429, '다른 화면의 스타일을 만들고 있습니다. 잠시 후 다시 시도해 주세요.', 'html_style_busy'));
      return;
    }
    activeWorkers++;
    let worker;
    try {
      worker = new Worker(new URL(import.meta.url), { execArgv: [], workerData: { kind: 'compile-workbench-tailwind', candidates },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    } catch {
      activeWorkers--;
      reject(createHttpError(422, '스타일 생성 작업을 시작하지 못했습니다.', 'html_style_compile_failed'));
      return;
    }
    let settled = false;
    const finish = (error, css) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const terminated = () => {
        activeWorkers--;
        if (error) reject(error); else resolve(css);
      };
      void worker.terminate().then(terminated, terminated);
    };
    const timeout = setTimeout(() => finish(createHttpError(422, '스타일 생성 시간이 한도를 넘었습니다. 복잡한 클래스와 반복 구역을 줄여 주세요.', 'html_style_timeout')), timeoutMs);
    worker.once('message', (result) => {
      if (!result?.ok || typeof result.css !== 'string') finish(createHttpError(422, '스타일을 완성하지 못했습니다. 클래스 구성을 확인해 주세요.', 'html_style_compile_failed'));
      else finish(null, result.css);
    });
    worker.once('error', () => finish(createHttpError(422, '스타일 생성에 필요한 자원 한도를 넘었거나 처리에 실패했습니다. 복잡한 클래스를 줄여 주세요.', 'html_style_compile_failed')));
    worker.once('exit', () => finish(createHttpError(422, '스타일 생성 작업이 완료되지 않았습니다.', 'html_style_compile_failed')));
  });
}

export async function compileHtmlPreview(source, { timeoutMs = 3000 } = {}) {
  const validation = validateHtmlSource(source);
  if (!validation.ok) {
    const error = createHttpError(400, validation.issues.map((issue) => issue.message).join(' '), 'html_source_invalid');
    error.issues = validation.issues;
    throw error;
  }
  const document = parse5.parse(validation.document);
  const pending = [document];
  const candidates = new Set();
  let head;
  while (pending.length) {
    const node = pending.pop();
    if (node.tagName === 'head') head = node;
    for (const attr of node.attrs || []) {
      if (attr.name !== 'class') continue;
      for (const token of attr.value.split(/\s+/).filter(Boolean)) {
        if (token.length > 512) throw createHttpError(400, '스타일 클래스 하나는 512자 이내로 작성해 주세요.', 'html_style_class_too_long');
        candidates.add(token);
        if (candidates.size > MAX_CANDIDATES) throw createHttpError(400, '서로 다른 스타일 클래스는 1,500개까지 사용할 수 있습니다. 반복되는 스타일을 정리해 주세요.', 'html_style_class_limit');
      }
    }
    for (const child of node.childNodes || []) pending.push(child);
  }
  const css = await compileCandidates([...candidates].sort(), Math.max(1, Math.min(Number(timeoutMs) || 3000, 3000)));
  if (css.length > MAX_CSS_LENGTH) throw createHttpError(422, '생성된 스타일이 80,000자 한도를 넘었습니다. 스타일 종류를 줄여 주세요.', 'html_style_size_exceeded');
  const normalized = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\(?:\r\n|[\r\n\f])/g, '')
    .replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi, (_, hex, char) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char);
  if (/<\s*\/\s*style\b/i.test(css) || /@(?:import|font-face|namespace)\b|\b(?:url|image-set|-webkit-image-set|expression)\s*\(|-moz-binding\s*:/i.test(normalized)) {
    throw createHttpError(400, '생성된 스타일에 외부 파일 요청이나 문서 밖으로 나가는 구문이 있습니다. 해당 클래스를 제거해 주세요.', 'html_style_unsafe');
  }
  const style = { nodeName: 'style', tagName: 'style', namespaceURI: 'http://www.w3.org/1999/xhtml', attrs: [], parentNode: head, childNodes: [] };
  style.childNodes.push({ nodeName: '#text', value: css, parentNode: style });
  // Keep the policy first and authored overrides after the compiled framework.
  head.childNodes.splice(1, 0, style);
  const previewHtml = parse5.serialize(document);
  const artifactValidation = validateHtmlPreviewArtifact(previewHtml);
  if (!artifactValidation.ok) {
    const error = createHttpError(400, artifactValidation.issues.map((issue) => issue.message).join(' '), 'html_style_unsafe');
    error.issues = artifactValidation.issues;
    throw error;
  }
  return { previewHtml, previewHash: hash(previewHtml), css, cssHash: hash(css), contentHash: hash(source.html),
    runtimeVersion: HTML_RUNTIME_VERSION, dataContractVersion: HTML_DATA_CONTRACT_VERSION, dependencies: [{ name: 'tailwindcss', version: TAILWIND_VERSION }] };
}
