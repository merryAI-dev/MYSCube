import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_TEXT_MAX_BYTES, attachmentTextQuality, buildAttachmentTextBody, buildAttachmentContentBody } from './attachment-text.mjs';
import { makePdf } from './test-pdf.fixture.mjs';

const contractText = 'Total contract amount 110,000,000 KRW including VAT, period 2026-03-01 to 2026-12-31';

describe('attachment text body', () => {
  it('renders only the requested page as a bounded JPEG without requiring a text layer', async () => {
    const buffer = makePdf([contractText, '']);
    const downloaded = { buffer, contentType: 'application/pdf' };
    const image = await buildAttachmentContentBody({ kind: 'contract', downloaded, query: { format: 'image', page: '2' } });
    expect(image).toMatchObject({ page: 2, pageCount: 2, mimeType: 'image/jpeg' });
    expect(image.sha256).toBe(createHash('sha256').update(buffer).digest('hex'));
    const bytes = Buffer.from(image.data, 'base64');
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([255, 216, 255]));
    expect(bytes.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(2400);
    const missing = await buildAttachmentContentBody({ kind: 'contract', downloaded, query: { format: 'image', page: '3' } });
    expect(missing).toMatchObject({ reason: 'invalid_page', pageCount: 2 });
    expect(missing.data).toBeUndefined();
    expect((await buildAttachmentContentBody({ kind: 'contract', downloaded })).pages[0]).toContain('110,000,000');
  });

  it.each([
    { format: 'other', page: '1' }, { format: 'image', page: '0' }, { format: 'image', page: '301' },
    { format: 'image', page: '1.5' }, { format: 'image', page: ['1'] }, { format: 'image' },
  ])('rejects malformed image queries %j', async (query) => {
    await expect(buildAttachmentContentBody({ kind: 'contract', downloaded: {}, query })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses non-PDF and oversized image inputs without returning bytes', async () => {
    const query = { format: 'image', page: '1' };
    const invalid = await buildAttachmentContentBody({ kind: 'contract', downloaded: { buffer: Buffer.from('not pdf') }, query });
    expect(invalid).toMatchObject({ reason: 'not_pdf' });
    const huge = await buildAttachmentContentBody({ kind: 'contract', downloaded: { buffer: Buffer.alloc(ATTACHMENT_TEXT_MAX_BYTES + 1) }, query });
    expect(huge).toMatchObject({ reason: 'too_large' });
    expect(huge.data).toBeUndefined();
  });
  it('returns page texts with a content hash and the original metadata', async () => {
    const pdf = makePdf([contractText, 'Article 9 Liquidated damages 0.3 percent per day of delay for the service']);
    const body = await buildAttachmentTextBody({ kind: 'contract', name: '계약서.pdf', downloaded: { buffer: pdf, contentType: 'application/pdf' } });
    expect(body).toMatchObject({ kind: 'contract', name: '계약서.pdf', contentType: 'application/pdf', size: pdf.byteLength, pageCount: 2, quality: 'ok' });
    expect(body.sha256).toBe(createHash('sha256').update(pdf).digest('hex'));
    expect(body.pages[0]).toContain('110,000,000');
    expect(body.pages[1]).toContain('Article 9');
    expect(body.reason).toBeUndefined();
  });

  it('marks a PDF without a text layer as sparse for page-image reading', async () => {
    const body = await buildAttachmentTextBody({ kind: 'contract', downloaded: { buffer: makePdf(['', '']), contentType: 'application/pdf' } });
    expect(body).toMatchObject({ pageCount: 2, quality: 'sparse', pages: ['', ''] });
  });

  it('judges by content signature, not by the declared type', async () => {
    const notPdf = await buildAttachmentTextBody({ kind: 'contract', downloaded: { buffer: Buffer.from('PK\x03\x04 docx'), contentType: 'application/pdf' } });
    expect(notPdf).toMatchObject({ reason: 'not_pdf', pages: [], quality: 'sparse' });
    const pdfWithOddType = await buildAttachmentTextBody({ kind: 'contract', downloaded: { buffer: makePdf([contractText]), contentType: 'application/octet-stream' } });
    expect(pdfWithOddType.quality).toBe('ok');
  });

  it('refuses files over the size limit without parsing them', async () => {
    const extract = vi.fn();
    const huge = Buffer.alloc(ATTACHMENT_TEXT_MAX_BYTES + 1);
    huge.write('%PDF-1.4', 0, 'latin1');
    const body = await buildAttachmentTextBody({ kind: 'proposal', downloaded: { buffer: huge, contentType: 'application/pdf' }, extract });
    expect(body).toMatchObject({ reason: 'too_large', pages: [] });
    expect(extract).not.toHaveBeenCalled();
  });

  it('refuses documents over the page limit and keeps the page count', async () => {
    const extract = vi.fn(async () => ({ pageCount: 412, pages: null }));
    const body = await buildAttachmentTextBody({ kind: 'proposal', downloaded: { buffer: makePdf(['x']), contentType: 'application/pdf' }, extract });
    expect(body).toMatchObject({ reason: 'too_large', pageCount: 412, pages: [] });
    expect(extract.mock.calls[0][1]).toEqual({ maxPages: 300 });
  });

  it('reports a broken PDF as unreadable without leaking the parser message', async () => {
    const body = await buildAttachmentTextBody({ kind: 'quote', downloaded: { buffer: Buffer.from('%PDF-1.4\ngarbage'), contentType: 'application/pdf' } });
    expect(body).toMatchObject({ reason: 'unreadable', pages: [] });
    expect(JSON.stringify(body)).not.toMatch(/Error|xref|Invalid/);
  });

  it('accepts ArrayBuffer and Uint8Array downloads as well as Buffer', async () => {
    const pdf = makePdf([contractText]);
    const fromArrayBuffer = await buildAttachmentTextBody({ kind: 'contract', downloaded: { buffer: pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) } });
    expect(fromArrayBuffer.pageCount).toBe(1);
    const fromUint8 = await buildAttachmentTextBody({ kind: 'contract', downloaded: { buffer: new Uint8Array(pdf) } });
    expect(fromUint8.sha256).toBe(fromArrayBuffer.sha256);
  });

  it('computes quality from the average non-space characters per page', () => {
    expect(attachmentTextQuality([])).toBe('sparse');
    expect(attachmentTextQuality(['a'.repeat(80), ''])).toBe('ok');
    expect(attachmentTextQuality(['a'.repeat(30), 'b'.repeat(30)])).toBe('sparse');
  });
});
