import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_TEXT_MAX_BYTES, attachmentTextQuality, buildAttachmentTextBody } from './attachment-text.mjs';
import { makePdf } from './test-pdf.fixture.mjs';

const contractText = 'Total contract amount 110,000,000 KRW including VAT, period 2026-03-01 to 2026-12-31';

describe('attachment text body', () => {
  it('returns page texts with a content hash and the original metadata', async () => {
    const pdf = makePdf([contractText, 'Article 9 Liquidated damages 0.3 percent per day of delay for the service']);
    const body = await buildAttachmentTextBody({ kind: 'contract', name: '계약서.pdf', downloaded: { buffer: pdf, contentType: 'application/pdf' } });
    expect(body).toMatchObject({ kind: 'contract', name: '계약서.pdf', contentType: 'application/pdf', size: pdf.byteLength, pageCount: 2, quality: 'ok' });
    expect(body.sha256).toBe(createHash('sha256').update(pdf).digest('hex'));
    expect(body.pages[0]).toContain('110,000,000');
    expect(body.pages[1]).toContain('Article 9');
    expect(body.reason).toBeUndefined();
  });

  it('marks a PDF without a text layer as sparse so the user attaches it to the chat', async () => {
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
