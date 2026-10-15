import { attachmentRoute } from '../../mcp-worker/src/review/attachment-route.mjs';
import { ATTACHMENT_TEXT_MAX_BYTES, buildAttachmentContentBody } from '../bff/attachment-text.mjs';
import { renderPdfPage } from '../bff/pdf-text.mjs';
import { makePdf } from '../bff/test-pdf.fixture.mjs';

const BFF_ORIGIN = 'https://myscube.myscguard.app';

async function readPdf(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > ATTACHMENT_TEXT_MAX_BYTES) {
    await response.body?.cancel();
    throw Object.assign(new Error('too_large'), { status: 413 });
  }
  const chunks = [];
  let size = 0;
  if (!response.body) throw new Error('empty_response');
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ATTACHMENT_TEXT_MAX_BYTES) {
      await reader.cancel();
      throw Object.assign(new Error('too_large'), { status: 413 });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

export function createDocumentService({ fetchImpl = fetch, build = buildAttachmentContentBody, render = renderPdfPage, release = process.env.RELEASE_SHA || 'local' } = {}) {
  let ready;
  return async function documentService(req, res) {
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    const reply = (status, body) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method !== 'GET') return reply(405, { code: 'method_not_allowed' });
      const url = new URL(req.url, 'https://service.invalid');
      if (url.pathname === '/healthz' || url.pathname === '/api/healthz') {
        ready ||= render(makePdf(['MCP document renderer readiness']), { pageNumber: 1, maxDimension: 64 }).then((result) => {
          if (result.pageCount !== 1 || result.bytes?.subarray(0, 2).toString('hex') !== 'ffd8') throw new Error('renderer_not_ready');
        }).catch((error) => { ready = undefined; throw error; });
        await ready;
        return reply(200, { service: 'myscube-mcp-documents', release, renderer: 'ready' });
      }
      const path = url.pathname === '/api/render' ? url.searchParams.get('__path') : url.pathname;
      const route = attachmentRoute(path || '');
      if (!route) return reply(404, { code: 'not_found' });
      const authorization = req.headers.authorization;
      if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/u.test(authorization)) return reply(401, { code: 'unauthorized' });
      const format = url.searchParams.get('format') || 'text';
      const page = url.searchParams.get('page');
      if (!['text', 'image'].includes(format) || (format === 'image' && (!/^[1-9]\d{0,2}$/u.test(page || '') || Number(page) > 300))) {
        return reply(400, { code: 'attachment_format_invalid' });
      }
      const response = await fetchImpl(new URL(route.downloadPath, BFF_ORIGIN), {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { authorization, accept: 'application/pdf', 'user-agent': 'myscube-mcp-documents/1.0' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        const status = [401, 403, 404, 409, 429].includes(response.status) ? response.status : 502;
        return reply(status, { code: 'attachment_download_failed' });
      }
      const buffer = await readPdf(response);
      const result = await build({ kind: route.kind, downloaded: { buffer, contentType: response.headers.get('content-type') }, query: { format, ...(page ? { page } : {}) } });
      return reply(200, result);
    } catch (error) {
      return reply(error.status === 413 ? 413 : 503, { code: error.status === 413 ? 'too_large' : 'document_service_unavailable' });
    }
  };
}
