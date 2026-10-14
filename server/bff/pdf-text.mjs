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
