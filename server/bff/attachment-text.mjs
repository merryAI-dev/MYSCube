import { createHash } from 'node:crypto';
import { extractPdfPages, renderPdfPage } from './pdf-text.mjs';

// 첨부 텍스트 응답(정합성 검토 MCP 용, 읽기 전용).
// 권한 확인과 파일 읽기는 각 라우트의 기존 다운로드 함수가 하고, 여기서는 받은 바이트만 다룬다.
// PDF 의 글자 레이어만 꺼낸다(OCR·AI 없음). 스캔본은 sparse 로 알려 사용자가 직접 첨부하게 한다.
export const ATTACHMENT_TEXT_MAX_BYTES = 30 * 1024 * 1024;
export const ATTACHMENT_TEXT_MAX_PAGES = 300;
// 쪽당 평균 글자(공백 제외)가 이 값보다 적으면 스캔본으로 본다.
export const ATTACHMENT_TEXT_SPARSE_CHARS_PER_PAGE = 40;

const readText = (value) => (typeof value === 'string' ? value.trim() : '');

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.alloc(0);
}

export function attachmentTextQuality(pages) {
  if (!pages.length) return 'sparse';
  const chars = pages.reduce((sum, page) => sum + page.replace(/\s/g, '').length, 0);
  return chars / pages.length >= ATTACHMENT_TEXT_SPARSE_CHARS_PER_PAGE ? 'ok' : 'sparse';
}

// downloaded: 기존 다운로드 함수의 결과({ buffer, contentType, name? })
export async function buildAttachmentTextBody({ kind, downloaded, name, extract = extractPdfPages }) {
  const buffer = toBuffer(downloaded?.buffer);
  const contentType = readText(downloaded?.contentType).toLowerCase() || 'application/octet-stream';
  const base = {
    kind,
    name: readText(name) || readText(downloaded?.name),
    contentType,
    size: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
  const empty = (reason, pageCount = 0) => ({ ...base, pageCount, pages: [], quality: 'sparse', reason });

  if (buffer.byteLength > ATTACHMENT_TEXT_MAX_BYTES) return empty('too_large');
  // 확장자·헤더가 아니라 내용 시그니처로 판단한다.
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return empty('not_pdf');

  let result;
  try {
    result = await extract(buffer, { maxPages: ATTACHMENT_TEXT_MAX_PAGES });
  } catch {
    // 손상·암호화 PDF 등. 원인 문자열은 돌려주지 않는다(파서 내부 메시지 노출 방지).
    return empty('unreadable');
  }
  if (!result.pages) return empty('too_large', result.pageCount);
  return { ...base, pageCount: result.pageCount, pages: result.pages, quality: attachmentTextQuality(result.pages) };
}

export function sendAttachmentText(res, body) {
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.status(200).json(body);
}

export async function buildAttachmentContentBody({ query = {}, ...input }) {
  if (query.format === undefined || query.format === 'text') return buildAttachmentTextBody(input);
  const invalid = (message) => Object.assign(new Error(message), { statusCode: 400, code: 'attachment_format_invalid' });
  if (query.format !== 'image' || typeof query.page !== 'string' || !/^[1-9]\d{0,2}$/.test(query.page)) {
    throw invalid('format=image requires page 1-300');
  }
  const page = Number(query.page);
  if (page > ATTACHMENT_TEXT_MAX_PAGES) throw invalid('page exceeds limit');
  const buffer = toBuffer(input.downloaded?.buffer);
  const base = {
    kind: input.kind, name: readText(input.name) || readText(input.downloaded?.name), page,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
  if (buffer.length > ATTACHMENT_TEXT_MAX_BYTES) return { ...base, reason: 'too_large' };
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return { ...base, reason: 'not_pdf' };
  let rendered;
  try {
    rendered = await renderPdfPage(buffer, { pageNumber: page, maxPages: ATTACHMENT_TEXT_MAX_PAGES });
  } catch {
    return { ...base, reason: 'unreadable' };
  }
  if (rendered.reason) return { ...base, pageCount: rendered.pageCount, reason: rendered.reason };
  if (rendered.bytes.length > 2 * 1024 * 1024) return { ...base, pageCount: rendered.pageCount, reason: 'image_too_large' };
  return { ...base, pageCount: rendered.pageCount, width: rendered.width, height: rendered.height,
    mimeType: 'image/jpeg', data: rendered.bytes.toString('base64') };
}
