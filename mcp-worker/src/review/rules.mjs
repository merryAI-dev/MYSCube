import { coverageFor } from './contract.mjs';
import { verifyQuote } from './quote.mjs';

// 제출값과 첨부 서류의 대조 규칙(스펙 7절). 결과는 경고이며 제출·승인을 막지 않는다.
// AI 가 서류에서 읽은 값은 { value, quote, page? } 로 받는다. 판정 근거는 AI 의 자신감이 아니라
// "인용이 서류 텍스트에 실제로 있는가"(출처 검증)이다.
//   mismatch - 근거가 검증된 서류 값과 제출값이 다름
//   check    - 못 읽음·근거 미검증·비슷하지만 다름 → 사람 확인
//   match    - 일치
export const DOCUMENT_LABELS = { contract: '계약서', customer_business_registration: '사업자등록증', quote: '견적서' };
export const REVIEW_DOCUMENT_KINDS = Object.keys(DOCUMENT_LABELS);
// 서류마다 반드시 대조하려는 필드. 이 필드를 모두 판정해야 coverage 가 complete 다.
export const EXPECTED_FIELDS = {
  contract: ['officialContractName', 'clientOrg', 'contractStart', 'contractEnd', 'contractAmount'],
  customer_business_registration: ['companyName'],
  quote: ['totalAmount'],
};
const PAYMENT_LABELS = { contract: '선금/계약금', interim: '중도금', final: '잔금' };

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const won = (value) => (Number.isSafeInteger(value) ? `${value.toLocaleString('ko-KR')}원` : '(없음)');

// 금액: 쉼표·공백·"원"·"₩"만 허용하고 정수가 아니면 해석하지 않는다(추측 금지).
export function parseAmount(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\s,원₩]/gu, '');
  return /^\d{1,15}$/u.test(cleaned) ? Number(cleaned) : null;
}

// 날짜: 2026-03-01, 2026.3.1, 2026. 3. 1., 2026년 3월 1일 → 2026-03-01. 실제 날짜가 아니면 null.
export function parseDate(value) {
  // ISO 날짜·시각(2026-03-01T00:00:00Z)은 날짜 부분만 본다.
  const iso8601 = /^(\d{4}-\d{2}-\d{2})T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?$/u.exec(text(value));
  if (iso8601) return parseDate(iso8601[1]);
  const match = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*(?:일|\.)?$/u.exec(text(value));
  if (!match) return null;
  const iso = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

// 기관명 비교용: 법인 형태 표기, 괄호, 공백, 구두점을 지운다.
export function normalizeOrgName(value) {
  return text(value).toLowerCase()
    .replace(/주식회사|유한회사|유한책임회사|재단법인|사단법인|사회적협동조합|협동조합|\(주\)|\(유\)|\(재\)|\(사\)|㈜|㈔|㈕/gu, '')
    .replace(/[\s()[\]{}.,·・\-_'"]/gu, '');
}

// 정규화 후 같을 때만 확실한 일치로 본다. 포함 관계("삼성" ⊂ "삼성물산")는 다른 기관일 수 있어 사람 확인으로 돌린다.
const sameName = (left, right) => {
  const a = normalizeOrgName(left);
  return Boolean(a) && a === normalizeOrgName(right);
};

// 문자 2-gram 겹침(Dice 계수, 0~1). 계약명처럼 표기가 조금씩 다른 이름에 쓴다("2026" / "2026년").
export function nameSimilarity(left, right) {
  const grams = (value) => {
    const chars = [...normalizeOrgName(value)];
    const list = [];
    for (let index = 0; index < chars.length - 1; index += 1) list.push(chars[index] + chars[index + 1]);
    return list;
  };
  const a = grams(left);
  const b = grams(right);
  if (!a.length || !b.length) return normalizeOrgName(left) === normalizeOrgName(right) && normalizeOrgName(left) ? 1 : 0;
  const pool = new Map();
  for (const gram of b) pool.set(gram, (pool.get(gram) || 0) + 1);
  let shared = 0;
  for (const gram of a) {
    if (pool.get(gram) > 0) { shared += 1; pool.set(gram, pool.get(gram) - 1); }
  }
  return (2 * shared) / (a.length + b.length);
}
const NAME_SAME = 0.85;
const NAME_CLOSE = 0.5;
// 이름 비교: true(일치) / 'close'(사람 확인) / false(다름).
function compareNames(a, b) {
  if (sameName(a, b)) return true;
  const left = normalizeOrgName(a);
  const right = normalizeOrgName(b);
  if (!left || !right) return false;
  const score = nameSimilarity(a, b);
  if (score >= NAME_SAME) return true;
  if (score >= NAME_CLOSE || left.includes(right) || right.includes(left)) return 'close';
  return false;
}
const orgCompare = compareNames;
const contractNameCompare = compareNames;

// 서류 하나의 판정 상태(필드별 판정·빠진 항목·미해결)를 모은다.
function documentState(doc) {
  return { doc, label: DOCUMENT_LABELS[doc.kind], checked: [], missing: [] };
}

// 인용 안에 그 값이 실제로 들어 있는가. 인용이 서류에 있어도 값이 인용 밖이면 근거가 아니다.
// 금액은 인용 속 아라비아 숫자(쉼표 제거) 중 하나와 같아야 한다. 한글로만 쓴 금액은 인정하지 않는다(보수적).
export function valueInQuote(valueType, value, quote) {
  const q = String(quote ?? '').normalize('NFKC');
  if (valueType === 'amount') {
    const amount = parseAmount(value);
    return amount !== null && (q.replace(/(\d),(?=\d{3})/gu, '$1').match(/\d+/gu) ?? []).includes(String(amount));
  }
  if (valueType === 'date') {
    const target = parseDate(value);
    const found = q.match(/\d{4}\s*[-./년]\s*\d{1,2}\s*[-./월]\s*\d{1,2}\s*(?:일|\.)?/gu) ?? [];
    return target !== null && found.some((candidate) => parseDate(candidate.trim()) === target);
  }
  const name = normalizeOrgName(value);
  return Boolean(name) && normalizeOrgName(q).includes(name);
}

// 인용 근거 상태: attachment_text 는 서류 텍스트에서 찾고, 그 밖의 출처는 MCP 가 원문을 못 보므로 unverified.
// 인용이 서류에 있어도 값이 인용 안에 없으면 unverified(valueNotInQuote)다.
function evidenceOf(doc, read, valueType = 'text') {
  if (doc.source !== 'attachment_text' || !Array.isArray(doc.pages)) return { evidence: 'unverified', page: read?.page ?? null };
  const result = verifyQuote(doc.pages, read?.quote);
  if (result.status === 'verified') {
    return valueInQuote(valueType, read?.value, read?.quote)
      ? { evidence: 'verified', page: result.page }
      : { evidence: 'unverified', page: result.page, valueNotInQuote: true };
  }
  if (result.status === 'not_found') return { evidence: 'not_found', page: null };
  return { evidence: 'unverified', page: read?.page ?? null };
}

function judge(out, state, { field, docField = field, label, rule, submitted, read, parse = text, compare, show = (value) => value || '(없음)', evidenceOverride = null, valueType = 'text' }) {
  const { doc } = state;
  const base = { documentKind: doc.kind, field, label, rule, submitted: show(submitted) };
  const value = read ? parse(read.value) : null;
  if (value === null || value === '' || value === undefined) {
    state.missing.push({ field: docField, reason: read ? '서류 값을 해석하지 못함' : '서류 값 없음' });
    out.findings.push({ ...base, status: 'check', document: '(읽지 못함)', quote: read?.quote ?? null, page: null, evidence: 'unverified',
      message: `${state.label}에서 ${label}을(를) 읽지 못했습니다. 직접 확인해 주세요.` });
    return;
  }
  const { evidence, page, valueNotInQuote } = evidenceOverride ?? evidenceOf(doc, read, valueType);
  const shown = { ...base, document: show(value), quote: read.quote ?? null, page, evidence };
  if (evidence === 'not_found') {
    state.missing.push({ field: docField, reason: '인용을 서류에서 찾지 못함' });
    out.unknowns.push({ kind: doc.kind, question: `${state.label}의 ${label} 인용을 서류에서 찾지 못했습니다`, resolveBy: '서류에서 해당 문장을 다시 찾아 인용' });
    out.findings.push({ ...shown, status: 'check', message: `${label}의 근거 인용이 ${state.label}에 없어 판정하지 않았습니다.` });
    return;
  }
  state.checked.push(docField);
  const same = compare(submitted, value);
  if (same === true) {
    out.findings.push({ ...shown, status: 'match', message: `${label} 일치` });
  } else if (same === 'close') {
    out.findings.push({ ...shown, status: 'check', message: `${label}이(가) ${state.label}과 비슷하지만 표기가 다릅니다. 같은 것인지 확인해 주세요.` });
  } else if (evidence !== 'verified') {
    const why = valueNotInQuote ? '인용 문장에 그 값이 없어 근거로 인정하지 않음' : '근거 미검증';
    out.findings.push({ ...shown, status: 'check', message: `${label}이(가) ${state.label}과 다를 수 있습니다(${why}). 직접 확인해 주세요.` });
  } else {
    out.findings.push({ ...shown, status: 'mismatch', message: `${label}이(가) ${state.label}과 다릅니다.` });
  }
}

// 제출값도 같은 규칙으로 해석해 비교한다(문자열로 와도 숫자와 같게 본다).
const amountRule = { parse: parseAmount, compare: (a, b) => parseAmount(a) === b, show: (value) => won(parseAmount(value)), rule: 'amount.exact', valueType: 'amount' };
const dateRule = { parse: parseDate, compare: (a, b) => parseDate(a) === b, rule: 'date.exact', valueType: 'date' };

// 총액 판정. 서류에 총액이 없으면 공급가액+부가세로 만든다.
// 합산값은 인용 하나로 검증할 수 없으므로, 두 인용이 모두 검증돼야 verified, 하나라도 못 찾으면 not_found.
function judgeTotal(out, state, { field, docField, label, submitted, totalField, supplyField, vatField }) {
  const fields = state.doc.fields ?? {};
  const total = fields[totalField];
  if (parseAmount(total?.value) !== null || parseAmount(fields[supplyField]?.value) === null || parseAmount(fields[vatField]?.value) === null) {
    judge(out, state, { field, docField, label, ...amountRule, submitted, read: total });
    return;
  }
  const supply = fields[supplyField];
  const vat = fields[vatField];
  const a = evidenceOf(state.doc, supply, 'amount');
  const b = evidenceOf(state.doc, vat, 'amount');
  const evidence = a.evidence === 'not_found' || b.evidence === 'not_found' ? 'not_found'
    : a.evidence === 'verified' && b.evidence === 'verified' ? 'verified' : 'unverified';
  judge(out, state, {
    field, docField, label, ...amountRule, rule: 'amount.supply_plus_vat', submitted,
    read: { value: parseAmount(supply.value) + parseAmount(vat.value), quote: [supply.quote, vat.quote].filter(Boolean).join(' / ') },
    evidenceOverride: { evidence, page: a.page },
  });
}

function reviewContract(payload, state, out) {
  const f = state.doc.fields ?? {};
  judge(out, state, { field: 'officialContractName', label: '공식 계약명', rule: 'name.similarity', submitted: payload.officialContractName, read: f.officialContractName, compare: contractNameCompare });
  judge(out, state, { field: 'clientOrg', label: '계약 상대방', rule: 'org.normalized', submitted: payload.clientOrg, read: f.clientOrg, compare: orgCompare });
  judge(out, state, { field: 'contractStart', label: '계약 시작일', ...dateRule, submitted: payload.contractStart, read: f.contractStart });
  if (payload.contractEndUndecided === true) {
    if (f.contractEnd?.value) {
      judge(out, state, { field: 'contractEnd', label: '계약 종료일', ...dateRule, rule: 'date.end_undecided', submitted: '종료 기간 없음', read: f.contractEnd, compare: () => false });
    } else {
      // "서류에 종료일이 없다"는 인용으로 증명할 수 없다. 못 읽은 것과 구분할 수 없으므로 판정한 것으로 치지 않는다.
      state.missing.push({ field: 'contractEnd', reason: '종료 기간 없음으로 제출. 계약서에 종료일이 없는지는 인용으로 확인할 수 없음' });
    }
  } else {
    judge(out, state, { field: 'contractEnd', label: '계약 종료일', ...dateRule, submitted: payload.contractEnd, read: f.contractEnd });
  }
  if (payload.currency && payload.currency !== 'KRW') {
    state.missing.push({ field: 'contractAmount', reason: `통화가 ${payload.currency}라 금액은 자동 대조하지 않음` });
    out.findings.push({ documentKind: 'contract', field: 'contractAmount', label: '계약금액', rule: 'currency.non_krw', status: 'check', submitted: String(payload.contractAmount ?? ''), document: '-', quote: null, page: null, evidence: 'unverified', message: `통화가 ${payload.currency}라 금액은 자동 대조하지 않았습니다.` });
    return;
  }
  judgeTotal(out, state, { field: 'contractAmount', docField: 'contractAmount', label: '계약금액', submitted: payload.contractAmount, totalField: 'contractAmount', supplyField: 'supplyAmount', vatField: 'salesVatAmount' });
  if (f.salesVatAmount && parseAmount(f.salesVatAmount.value) !== null) {
    judge(out, state, { field: 'salesVatAmount', label: '매출 부가세', ...amountRule, submitted: payload.salesVatAmount, read: f.salesVatAmount });
  }
  reviewPaymentSchedule(payload, state, out);
}

function reviewPaymentSchedule(payload, state, out) {
  const rows = (state.doc.lists?.paymentSchedule ?? []).map((row) => ({ ...row, amount: parseAmount(row.amount) })).filter((row) => row.amount !== null);
  const plan = payload.paymentPlan && typeof payload.paymentPlan === 'object' ? payload.paymentPlan : null;
  if (!rows.length || !plan) return;
  const evidences = rows.map((row) => evidenceOf(state.doc, { value: row.amount, quote: row.quote }, 'amount').evidence);
  if (evidences.includes('not_found')) {
    out.unknowns.push({ kind: 'contract', question: '대금 지급 조건 인용 중 서류에서 찾지 못한 것이 있습니다', resolveBy: '서류에서 해당 문장을 다시 찾아 인용' });
    return;
  }
  const evidence = evidences.every((item) => item === 'verified') ? 'verified' : 'unverified';
  const scheduleTotal = rows.reduce((sum, row) => sum + row.amount, 0);
  const planParts = Object.keys(PAYMENT_LABELS).map((key) => parseAmount(plan[key]) ?? 0);
  const planTotal = planParts.reduce((sum, value) => sum + value, 0);
  const sorted = (list) => list.filter((value) => value > 0).sort((a, b) => a - b);
  const sameParts = JSON.stringify(sorted(planParts)) === JSON.stringify(sorted(rows.map((row) => row.amount)));
  const base = {
    documentKind: 'contract', field: 'paymentPlan', label: '입금 계획', rule: 'payment.schedule', evidence, page: evidenceOf(state.doc, { value: rows[0].amount, quote: rows[0].quote }, 'amount').page,
    submitted: `${won(planTotal)} (${Object.entries(PAYMENT_LABELS).map(([key, label]) => `${label} ${won(parseAmount(plan[key]))}`).join(', ')})`,
    document: `${won(scheduleTotal)} (${rows.map((row) => `${text(row.label) || '회차'} ${won(row.amount)}`).join(', ')})`,
    quote: rows.map((row) => row.quote).filter(Boolean).join(' / ') || null,
  };
  if (scheduleTotal !== planTotal) {
    out.findings.push({ ...base, status: evidence === 'verified' ? 'mismatch' : 'check', message: '입금 계획 합계가 계약서의 대금 지급 조건과 다릅니다.' });
  } else if (!sameParts) {
    out.findings.push({ ...base, status: 'check', message: '입금 계획 합계는 같지만 회차별 금액 구성이 계약서와 다릅니다. 확인해 주세요.' });
  } else {
    out.findings.push({ ...base, status: 'match', message: '입금 계획 일치' });
  }
}

function reviewBusinessRegistration(payload, state, out) {
  judge(out, state, { field: 'clientOrg', docField: 'companyName', label: '계약 대상(상호)', rule: 'org.normalized', submitted: payload.clientOrg, read: state.doc.fields?.companyName, compare: orgCompare });
}

function reviewQuote(payload, state, out) {
  const f = state.doc.fields ?? {};
  if (f.recipient?.value) judge(out, state, { field: 'clientOrg', docField: 'recipient', label: '견적 수신처', rule: 'org.normalized', submitted: payload.clientOrg, read: f.recipient, compare: orgCompare });
  if (payload.currency && payload.currency !== 'KRW') {
    state.missing.push({ field: 'totalAmount', reason: `통화가 ${payload.currency}라 금액은 자동 대조하지 않음` });
    return;
  }
  judgeTotal(out, state, { field: 'contractAmount', docField: 'totalAmount', label: '견적 총액과 계약금액', submitted: payload.contractAmount, totalField: 'totalAmount', supplyField: 'supplyAmount', vatField: 'vatAmount' });
}

const REVIEWERS = { contract: reviewContract, customer_business_registration: reviewBusinessRegistration, quote: reviewQuote };

// 서류 사이 대조: 계약서 상대방과 사업자등록증 상호(다른 기관 서류가 첨부됐는지).
function reviewAcrossDocuments(states, out) {
  const contract = states.find((state) => state.doc.kind === 'contract');
  const registration = states.find((state) => state.doc.kind === 'customer_business_registration');
  const a = contract?.doc.fields?.clientOrg;
  const b = registration?.doc.fields?.companyName;
  if (!text(a?.value) || !text(b?.value)) return;
  const same = orgCompare(a.value, b.value);
  if (same === true) return;
  const ea = evidenceOf(contract.doc, a, 'text').evidence;
  const eb = evidenceOf(registration.doc, b, 'text').evidence;
  if (ea === 'not_found' || eb === 'not_found') return;
  const verified = ea === 'verified' && eb === 'verified';
  out.findings.push({
    documentKind: 'customer_business_registration', field: 'clientOrg', label: '계약서 상대방과 사업자등록증 상호', rule: 'cross.org',
    status: verified && same === false ? 'mismatch' : 'check', submitted: text(a.value), document: text(b.value), quote: b.quote ?? null, page: null, evidence: verified ? 'verified' : 'unverified',
    message: '계약서의 상대방과 사업자등록증의 상호가 다릅니다. 다른 기관의 사업자등록증이 첨부됐을 수 있습니다.',
  });
}

// documents: [{ kind, source: 'attachment_text'|'chat_attachment'|'connector', readable, reason?, pages?, fields, lists? }]
// attachedKinds: 제출에 첨부가 있는 서류 종류(없는 종류는 "첨부 없음"으로 남긴다).
export function reviewSubmission({ payload, documents, attachedKinds = REVIEW_DOCUMENT_KINDS }) {
  const out = { findings: [], unknowns: [], limitations: [] };
  const coverage = [];
  const states = [];
  for (const kind of REVIEW_DOCUMENT_KINDS) {
    const doc = documents.find((item) => item.kind === kind);
    if (!attachedKinds.includes(kind)) {
      coverage.push(coverageFor({ kind, readable: false, expected: EXPECTED_FIELDS[kind], checked: [], missing: [{ field: '*', reason: '첨부 없음' }] }));
      out.unknowns.push({ kind, question: `${DOCUMENT_LABELS[kind]} 첨부가 없어 대조하지 못했습니다`, resolveBy: '작성자에게 첨부 요청' });
      continue;
    }
    if (!doc || doc.readable === false) {
      coverage.push(coverageFor({ kind, readable: false, expected: EXPECTED_FIELDS[kind], checked: [], missing: [{ field: '*', reason: doc?.reason || '서류를 읽지 않음' }] }));
      out.unknowns.push({ kind, question: `${DOCUMENT_LABELS[kind]}을(를) 읽지 못했습니다${doc?.reason ? `(${doc.reason})` : ''}`, resolveBy: doc?.reason === 'sparse' ? '파일을 대화에 첨부해 AI가 직접 읽기' : '서류를 다시 읽기' });
      continue;
    }
    const state = documentState(doc);
    states.push(state);
    REVIEWERS[kind](payload ?? {}, state, out);
    coverage.push(coverageFor({ kind, readable: true, expected: EXPECTED_FIELDS[kind], checked: state.checked, missing: state.missing }));
    if (doc.source !== 'attachment_text') out.limitations.push(`${DOCUMENT_LABELS[kind]}은(는) ${doc.source === 'connector' ? '커넥터' : '대화 첨부'}로 읽어 MCP가 원문을 확인하지 못했습니다(근거 미검증).`);
  }
  reviewAcrossDocuments(states, out);
  out.limitations.push('PDF 글자 레이어만 대조합니다(OCR 없음). 판정은 경고이며 승인은 사람이 합니다.');
  return { ...out, coverage };
}
