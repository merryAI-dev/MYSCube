import * as z from 'zod/v4';
import { READ_ONLY, tool } from './tool-kit.mjs';

const DAY = 86_400_000;
const PUBLISHERS = new Set(['platum', 'wowtale', 'venturesquare']);
const TYPES = new Set(['investment', 'selection', 'partnership', 'innovation']);
const text = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';
const strings = (value) => Array.isArray(value) ? value.filter((v) => typeof v === 'string').map((v) => text(v, 300)) : [];

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return NaN;
  const parsed = Date.parse(`${value}T00:00:00+09:00`);
  return Number.isFinite(parsed) && new Date(parsed + 9 * 3_600_000).toISOString().slice(0, 10) === value ? parsed : NaN;
}

export function validateNewsRange({ from, to }, now = Date.now()) {
  const start = date(from);
  const end = date(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end > now || (end - start) / DAY + 1 > 31) {
    throw new Error('뉴스 조회 기간은 미래를 제외한 올바른 KST 날짜로 최대 31일까지 지정해 주세요.');
  }
  return { from, to, start, endExclusive: Math.min(end + DAY, now + 1) };
}

function company(row) {
  return {
    key: text(row.key, 200), name: text(row.name, 300),
    programIds: strings(row.programIds), currentProgramNames: strings(row.currentProgramNames ?? row.programNames),
    programBasis: 'reader_directory_companies.programs',
    programStatus: Array.isArray(row.programIds) && Array.isArray(row.currentProgramNames ?? row.programNames) ? 'reader_projection' : 'not_queried',
    identityBasis: 'reader_relation_key_not_independently_reconciled',
    portfolio: { status: 'not_queried', value: null },
  };
}

function article(row, range) {
  const published = Date.parse(row?.publishedAt);
  let url;
  try { url = new URL(row.url); } catch { return null; }
  if (!PUBLISHERS.has(row.sourceId) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || !Number.isFinite(published) || published < range.start || published >= range.endExclusive
    || !row.id || !row.title || !Array.isArray(row.companies) || !row.companies.length || !Array.isArray(row.relations)) return null;
  const relations = row.relations.filter((r) => typeof r.key === 'string').map((r) => ({
    key: text(r.key, 200), events: (Array.isArray(r.events) ? r.events : []).filter((e) => TYPES.has(e.type) && ['confirmed', 'planned', 'uncertain'].includes(e.status)).map((e) => ({
      type: e.type, status: e.status, partners: strings(e.partners),
      amount: { kind: text(e.amount?.kind, 40), text: text(e.amount?.text, 300) },
    })),
  }));
  const keys = new Set(relations.map((r) => r.key));
  const companies = row.companies.filter((c) => c && typeof c.key === 'string' && keys.has(c.key)).map(company);
  if (!companies.length) return null;
  return {
    id: text(row.id, 200), title: text(row.title, 1000), url: url.href,
    publisher: text(row.publisher, 100), sourceId: row.sourceId, publishedAt: new Date(published).toISOString(),
    summary: text(row.summary, 6000), companies, relations,
    firstSeenAt: null, collectedAt: null, eventIdentity: { status: 'not_determined' },
  };
}

export function projectNewsSnapshot(result, range) {
  if (result?.source !== 'publishers' || result?.period?.timezone !== 'Asia/Seoul'
    || result.period.from !== range.from || result.period.to !== range.to
    || !Number.isFinite(Date.parse(result.period.asOf)) || !Array.isArray(result.inbox)) {
    throw new Error('뉴스 응답 계약을 확인하지 못했습니다. 발행을 보류하고 조회 연결을 점검해 주세요.');
  }
  const tooLarge = result.inbox.length > 100;
  const projected = tooLarge ? [] : result.inbox.map((row) => article(row, range));
  const rejectedCount = projected.filter((row) => !row).length;
  const partial = tooLarge || rejectedCount > 0 || result.inboxTruncated !== false;
  return {
    schemaVersion: 'ema.news.reader.v1', source: 'publishers',
    period: { from: range.from, to: range.to, timezone: 'Asia/Seoul', asOf: result.period.asOf,
      start: new Date(range.start).toISOString(), endExclusive: new Date(range.endExclusive).toISOString() },
    status: partial ? 'partial' : result.inbox.length ? 'ok' : 'no_matches_in_saved_corpus',
    coverage: { savedCorpusCompleteness: 'unknown', sourceHealth: 'unknown', readerTruncated: result.inboxTruncated !== false,
      receivedCount: result.inbox.length, rejectedCount, maxArticles: 100, narrowRangeRequired: tooLarge },
    articles: projected.filter(Boolean),
    sendEligible: false,
    next: partial ? '조회 범위를 좁히거나 계약 오류를 점검한 뒤 다시 검수하세요.' : '사건·발송 원장 대조와 사내 홍보실 검수가 필요합니다. 빈 결과는 수집 성공 또는 전체 뉴스 부재의 증거가 아닙니다.',
  };
}

export function registerNewsTools(server, { ema, now = () => Date.now() }) {
  tool(server, 'ema_news_read', {
    title: '사내 뉴스레터 기사 읽기',
    description: '관리자 전용: 기존 EMA 뉴스 reader에서 최대 31 KST일·100기사의 검증된 매체 기사와 연결 기업·참여사업만 읽습니다. FRN·투자·수집 건강·전체 수집 여부를 추정하지 않으며 발행과 신규 사건 판정은 별도 검수·원장이 필요합니다.',
    annotations: READ_ONLY,
    input: { from: z.string().max(10).describe('시작일 YYYY-MM-DD, KST 포함'), to: z.string().max(10).describe('종료일 YYYY-MM-DD, KST 포함, 미래 제외') },
  }, async (args) => {
    const range = validateNewsRange(args, now());
    let result;
    try { result = await ema.call('getAdminLabNews', { source: 'publishers', period: 'custom', from: range.from, to: range.to }); }
    catch (error) {
      const code = ['UNAUTHENTICATED', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'DEADLINE_EXCEEDED', 'UNAVAILABLE'].includes(error?.code) ? error.code : 'READER_FAILED';
      throw new Error(`뉴스 조회 실패(${code}). 발행을 보류하고 연결·권한·기간을 확인해 주세요.`);
    }
    return projectNewsSnapshot(result, range);
  });
}
