export function toPdfJsData(buffer) {
  return new Uint8Array(buffer);
}

export async function extractTextFromPdfBuffer(buffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Node.js Buffer extends Uint8Array, but pdfjs explicitly rejects Buffer.
  // Always create a plain Uint8Array copy before handing binary data to pdfjs.
  const data = toPdfJsData(buffer);
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .filter((item) => item && typeof item === 'object' && 'str' in item)
      .map((item) => item.str)
      .join(' ')
      .trim();
    if (pageText) {
      pages.push(pageText);
    }
  }

  return pages.join('\n\n');
}

// 정합성 검토용: 쪽별 텍스트를 돌려준다. 쪽 수가 maxPages 를 넘으면 텍스트를 만들지 않는다.
// 외부에서 올라온 PDF 를 서버에서 여므로 글꼴용 eval 경로를 끈다(CVE-2024-4367 계열 방어).
export async function extractPdfPages(buffer, { maxPages = Infinity } = {}) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjsLib.getDocument({
    data: toPdfJsData(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  try {
    if (pdf.numPages > maxPages) return { pageCount: pdf.numPages, pages: null };
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      pages.push(textContent.items
        .map((item) => (item && typeof item === 'object' && typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim());
      page.cleanup();
    }
    return { pageCount: pdf.numPages, pages };
  } finally {
    await pdf.destroy();
  }
}

export async function renderPdfPage(buffer, { pageNumber, maxPages = 300, maxDimension = 2400 } = {}) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createRequire } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const packageDirectory = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const pdf = await pdfjsLib.getDocument({
    data: toPdfJsData(buffer), isEvalSupported: false, useSystemFonts: false, verbosity: 0,
    standardFontDataUrl: join(packageDirectory, 'standard_fonts/'),
    cMapUrl: join(packageDirectory, 'cmaps/'), cMapPacked: true,
    wasmUrl: join(packageDirectory, 'wasm/'),
  }).promise;
  let surface;
  try {
    if (pdf.numPages > maxPages) return { pageCount: pdf.numPages, reason: 'too_large' };
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) {
      return { pageCount: pdf.numPages, reason: 'invalid_page' };
    }
    const page = await pdf.getPage(pageNumber);
    const original = page.getViewport({ scale: 1 });
    const longest = Math.max(original.width, original.height);
    if (!Number.isFinite(longest) || longest <= 0) throw new Error('Invalid page dimensions');
    const viewport = page.getViewport({ scale: maxDimension / longest });
    surface = pdf.canvasFactory.create(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    await page.render({ canvasContext: surface.context, viewport, background: 'rgb(255,255,255)' }).promise;
    const bytes = await surface.canvas.encode('jpeg', 92);
    return { pageCount: pdf.numPages, width: surface.canvas.width, height: surface.canvas.height, bytes };
  } finally {
    if (surface) pdf.canvasFactory.destroy(surface);
    await pdf.destroy();
  }
}
