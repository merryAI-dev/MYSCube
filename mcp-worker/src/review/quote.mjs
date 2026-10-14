// 출처 검증: AI 가 넘긴 인용(quote)이 서류의 쪽별 텍스트에 실제로 있는지 확인한다(스펙 5.5절).
// PDF 텍스트는 줄바꿈·띄어쓰기가 원문과 달라지기 쉬워 공백을 모두 지우고 비교한다.
// 너무 짧은 인용은 어디에나 있어 아무것도 증명하지 못하므로 검증하지 않는다.
export const MIN_QUOTE_CHARS = 6;

const DASHES = /[‐-―−﹘﹣－]/gu;
const QUOTES = /[‘’‚‛′`´]/gu;
const DOUBLE_QUOTES = /[“”„‟″«»]/gu;

export function normalizeForQuote(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(DASHES, '-')
    .replace(QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/\s+/gu, '')
    .toLowerCase();
}

// pages: 쪽별 텍스트 배열(0번이 1쪽). 반환: { status: 'verified'|'not_found'|'too_short', page?, pages? }
export function verifyQuote(pages, quote) {
  const needle = normalizeForQuote(quote);
  if ([...needle].length < MIN_QUOTE_CHARS) return { status: 'too_short' };
  const normalized = pages.map(normalizeForQuote);
  const found = [];
  normalized.forEach((page, index) => { if (page.includes(needle)) found.push(index + 1); });
  if (found.length) return { status: 'verified', page: found[0], pages: found };
  // 쪽 경계에 걸친 인용: 이어 붙인 두 쪽에서 찾고, 시작 쪽을 돌려준다.
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const joined = normalized[index] + normalized[index + 1];
    const at = joined.indexOf(needle);
    if (at >= 0 && at < normalized[index].length && at + needle.length > normalized[index].length) {
      return { status: 'verified', page: index + 1, pages: [index + 1, index + 2] };
    }
  }
  return { status: 'not_found' };
}
