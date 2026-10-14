// 정합성 검토 결과 계약(스펙 5.5절). REA 의 Evidence·coverage·unknowns 방식을 따른다.
// - 같은 입력(서류 해시·규칙 버전·제출 버전)이면 같은 id 가 나온다(재현·재제출 비교용).
// - "문제 없음"과 "확인 못 함"을 섞지 않도록 서류마다 coverage 를 선언한다.
export const RULES_VERSION = 'project-review-rules@1';
export const FINDING_STATUSES = ['mismatch', 'check', 'match'];
export const COVERAGE_STATUSES = ['complete', 'partial', 'unknown'];

// 키를 정렬한 JSON. 배열 순서는 호출한 쪽이 의미 있게 정한다(identity.documents 는 아래에서 정렬).
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export async function hashId(prefix, value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex.slice(0, 24)}`;
}

export function normalizeIdentity({ subject, reviewToken = null, documents = [], extractor, rulesVersion = RULES_VERSION }) {
  return {
    subject,
    reviewToken,
    documents: [...documents]
      .map(({ kind, sha256 = null, source }) => ({ kind, sha256, source }))
      .sort((a, b) => `${a.kind}:${a.source}`.localeCompare(`${b.kind}:${b.source}`)),
    rulesVersion,
    extractor,
  };
}

// expected: 그 서류에서 대조하려던 필드, checked: 실제로 판정한 필드, missing: [{ field, reason }]
export function coverageFor({ kind, readable, expected, checked, missing = [] }) {
  const checkedSet = [...new Set(checked)].filter((field) => expected.includes(field));
  const status = !readable ? 'unknown' : checkedSet.length === expected.length && !missing.length ? 'complete' : checkedSet.length ? 'partial' : 'unknown';
  return { kind, status, checkedFields: checkedSet, missingFields: missing };
}

const findingKey = ({ documentKind, field, rule, submitted, document, quote }) => ({ documentKind, field, rule, submitted, document, quote: quote ?? null });

export async function buildReviewResult({ identity, findings = [], coverage = [], unknowns = [], limitations = [], now = () => new Date().toISOString() }) {
  const normalized = normalizeIdentity(identity);
  const withIds = await Promise.all(findings.map(async (finding) => ({ findingId: await hashId('f', findingKey(finding)), ...finding })));
  const unknownsWithIds = await Promise.all(unknowns.map(async (unknown) => ({ unknownId: await hashId('u', { kind: unknown.kind, question: unknown.question }), ...unknown })));
  const order = (status) => FINDING_STATUSES.indexOf(status);
  const count = (status) => withIds.filter((finding) => finding.status === status).length;
  return {
    review: { reviewId: await hashId('rv', normalized), identity: normalized, createdAt: now() },
    summary: { mismatch: count('mismatch'), check: count('check'), match: count('match'), unknown: unknownsWithIds.length },
    coverage: [...coverage].sort((a, b) => a.kind.localeCompare(b.kind)),
    findings: withIds.sort((a, b) => order(a.status) - order(b.status) || `${a.documentKind}:${a.field}`.localeCompare(`${b.documentKind}:${b.field}`)),
    unknowns: unknownsWithIds,
    limitations: [...new Set(limitations)],
  };
}

// 도구 오류의 공통 형식(REA error contract 방식). MCP 결과의 text 로 실린다.
export function reviewError(code, message, { retryable = false, remediation = '', partial } = {}) {
  return { error: { code, message, retryable, remediation, ...(partial === undefined ? {} : { partial }) } };
}
