import * as z from 'zod/v4';
import { READS_EXTERNAL, tool, WRITES } from './tool-kit.mjs';

// 회의록 가져오기 도구. Meet(Gemini 노트)는 두 경로로 읽는다.
//  - calendar: 일정에 첨부된 노트 문서  - gmail: 회의 종료 후 오는 회의록 메일
// 읽은 내용은 보고서 칸 초안으로 정리해 "초안함"에 저장하고, 원장에는 쓰지 않는다.
// 확정은 EMA 화면 "회의록 추가"의 "초안 불러오기"에서 사람이 한다.
const MAX_TEXT = 60_000;
const CALENDAR_SOURCE = 'calendar';
const GMAIL_SOURCE = 'gmail';
const DOC_MIME = 'application/vnd.google-apps.document';
const DEFAULT_GMAIL_QUERY = '(subject:("Notes by Gemini") OR subject:(회의록) OR subject:("Meeting notes") OR from:(meet-recordings-noreply@google.com) OR from:(gemini-notes@google.com))';

const decodeBase64Url = (data) => {
  const raw = atob(String(data).replace(/-/gu, '+').replace(/_/gu, '/'));
  return new TextDecoder('utf-8').decode(Uint8Array.from(raw, (char) => char.charCodeAt(0)));
};

const htmlToText = (html) => html
  .replace(/<(script|style)[\s\S]*?<\/\1>/giu, '')
  .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/giu, '\n')
  .replace(/<[^>]+>/gu, '')
  .replace(/&nbsp;/gu, ' ').replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&#39;|&apos;/gu, "'").replace(/&quot;/gu, '"')
  .replace(/\n{3,}/gu, '\n\n')
  .trim();

export function extractMessageText(payload) {
  const plain = [];
  const html = [];
  const walk = (part) => {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data) plain.push(decodeBase64Url(part.body.data));
    else if (part.mimeType === 'text/html' && part.body?.data) html.push(decodeBase64Url(part.body.data));
    (part.parts ?? []).forEach(walk);
  };
  walk(payload);
  return (plain.join('\n').trim() || htmlToText(html.join('\n'))).trim();
}

const header = (message, name) => message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? '';

export function registerMeetingTools(server, { ema, google, access, now = () => Date.now() }) {
  const idShape = z.string().min(3).max(200).regex(/^[A-Za-z0-9_-]+$/u, '영문·숫자·_·- 만 가능한 ID입니다.');

  async function readCalendarDoc(fileId) {
    const response = await google.getJson(access.uid, CALENDAR_SOURCE,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text%2Fplain`);
    return response.text();
  }

  async function readGmail(messageId) {
    const response = await google.getJson(access.uid, GMAIL_SOURCE,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`);
    const message = await response.json();
    return { text: extractMessageText(message.payload), subject: header(message, 'Subject'), date: header(message, 'Date') };
  }

  async function readSource(source, id) {
    if (source === CALENDAR_SOURCE) return { text: await readCalendarDoc(id) };
    return readGmail(id);
  }

  const clip = (text) => ({ text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT });

  tool(server, 'ema_google_status', {
    title: 'Google 연결 상태',
    description: '내 Google 계정이 회의록 가져오기용으로 연결돼 있는지, 어떤 소스(calendar/gmail)가 연결됐는지 보여 줍니다.',
  }, () => google.status(access.uid));

  tool(server, 'ema_google_connect', {
    title: 'Google 연결',
    description: 'Meet 회의록을 읽기 위해 내 Google 계정을 연결하는 링크를 만듭니다. calendar는 Meet 일정에 첨부된 Gemini 노트(캘린더·Drive 읽기), gmail은 회의 후 오는 회의록 메일(Gmail 읽기)입니다. 필요한 소스만 고르게 하세요. 링크를 열면 어느 EMA 계정용인지 확인한 뒤 Google 동의 화면으로 넘어갑니다. 읽기 전용이며 ema_google_disconnect로 해제할 수 있습니다.',
    input: { sources: z.array(z.enum([CALENDAR_SOURCE, GMAIL_SOURCE])).min(1).describe('연결할 소스. calendar: 일정에 첨부된 회의 노트, gmail: 회의록 메일') },
    annotations: WRITES,
  }, async ({ sources }) => {
    const { token, expiresInMinutes, sources: picked } = await google.beginConnect(access.uid, sources, access.email);
    return {
      connectUrl: `${access.publicOrigin}/google/start/${token}`,
      sources: picked,
      expiresInMinutes,
      next: '사용자에게 링크를 전달하세요. 같은 브라우저에서 확인 후 Google 동의를 마치면 연결됩니다.',
    };
  });

  tool(server, 'ema_google_disconnect', {
    title: 'Google 연결 해제',
    description: '연결한 Google 계정 권한을 해제하고 보관 중인 연결 정보를 삭제합니다.',
    annotations: WRITES,
  }, () => google.disconnect(access.uid));

  tool(server, 'ema_meeting_sources_list', {
    title: '회의록 후보 찾기',
    description: '내 Google에서 회의록 후보를 찾습니다. source=calendar는 최근 일정 중 Gemini 노트 등 문서가 첨부된 일정, source=gmail은 회의록 메일입니다. 미작성 여부로 거르지 않으며, 원하는 회의를 고르면 ema_meeting_draft_create로 초안을 만듭니다.',
    input: {
      source: z.enum([CALENDAR_SOURCE, GMAIL_SOURCE]).describe('calendar: 일정에 첨부된 노트, gmail: 회의록 메일'),
      daysBack: z.number().int().min(1).max(180).optional().describe('며칠 전까지 볼지(기본 14)'),
      query: z.string().max(200).optional().describe('gmail 검색식을 직접 지정할 때(비우면 회의록 메일 기본 검색). calendar는 일정 제목에 포함된 단어'),
    },
    annotations: READS_EXTERNAL,
  }, async ({ source, daysBack = 14, query }) => {
    const since = new Date(now() - daysBack * 24 * 60 * 60 * 1000);
    if (source === CALENDAR_SOURCE) {
      const params = new URLSearchParams({
        timeMin: since.toISOString(), timeMax: new Date(now()).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
        fields: 'items(id,summary,start,end,attendees(email),attachments(fileId,title,mimeType))',
      });
      const response = await google.getJson(access.uid, CALENDAR_SOURCE, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
      const { items = [] } = await response.json();
      const events = items
        .map((event) => ({
          eventId: event.id,
          title: event.summary || '(제목 없음)',
          start: event.start?.dateTime || event.start?.date || '',
          attendees: (event.attendees ?? []).length,
          documents: (event.attachments ?? []).filter((file) => file.mimeType === DOC_MIME && file.fileId).map((file) => ({ fileId: file.fileId, title: file.title })),
        }))
        .filter((event) => event.documents.length > 0 && (!query || event.title.toLowerCase().includes(query.toLowerCase())));
      return { source, count: events.length, events, next: 'documents[].fileId 를 ema_meeting_draft_create({ source: "calendar", id })에 넘기세요.' };
    }
    const q = `${query || DEFAULT_GMAIL_QUERY} newer_than:${daysBack}d`;
    const list = await (await google.getJson(access.uid, GMAIL_SOURCE,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q, maxResults: '50' })}`)).json();
    const messages = [];
    for (const { id } of list.messages ?? []) {
      const message = await (await google.getJson(access.uid, GMAIL_SOURCE,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=From`)).json();
      messages.push({ messageId: id, subject: header(message, 'Subject'), date: header(message, 'Date'), from: header(message, 'From'), snippet: String(message.snippet || '').slice(0, 160) });
    }
    return { source, count: messages.length, messages, next: 'messageId 를 ema_meeting_draft_create({ source: "gmail", id })에 넘기세요.' };
  });

  tool(server, 'ema_meeting_source_read', {
    title: '회의록 원문 보기',
    description: '선택한 회의록의 원문 텍스트를 읽어 보여 줍니다(최대 6만 자). 초안만 만들 거라면 이 도구 없이 ema_meeting_draft_create에 source와 id만 넘기면 됩니다.',
    input: {
      source: z.enum([CALENDAR_SOURCE, GMAIL_SOURCE]).describe('calendar 또는 gmail'),
      id: idShape.describe('calendar: 첨부 문서 fileId, gmail: messageId'),
    },
    annotations: READS_EXTERNAL,
  }, async ({ source, id }) => {
    const { text, subject, date } = await readSource(source, id);
    return { source, id, ...(subject ? { subject, date } : {}), ...clip(text) };
  });

  tool(server, 'ema_meeting_draft_create', {
    title: '회의록 초안 만들기',
    description: '회의록을 보고서 칸(주제·기업 현황·자문 내용·후속 조치·참석자) 초안으로 정리해 내 초안함에 저장합니다. 원장에는 아무것도 쓰지 않습니다. 입력은 (1) Google 소스: source+id, 또는 (2) 다른 도구(예: Tiro MCP)에서 읽은 내용: text 중 하나입니다. 같은 sourceRef로 다시 만들면 기존 초안을 갱신합니다. 만든 뒤 사용자에게 EMA 화면의 "회의록 추가 → 초안 불러오기"에서 확정하라고 안내하세요.',
    input: {
      source: z.enum([CALENDAR_SOURCE, GMAIL_SOURCE, 'tiro', 'manual']).describe('calendar/gmail은 id로 Google에서 읽고, tiro/manual은 text를 직접 넘깁니다.'),
      id: idShape.optional().describe('calendar: 첨부 문서 fileId, gmail: messageId'),
      text: z.string().min(20).max(200_000).optional().describe('회의록 텍스트(Tiro 요약·대화록 등). source가 tiro/manual일 때 필수'),
      title: z.string().max(200).optional().describe('초안 제목(예: 기업명 + 회의 주제)'),
      meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional().describe('회의 일자 YYYY-MM-DD'),
      sourceRef: z.string().max(200).optional().describe('원본 식별자. 같은 값이면 기존 초안을 갱신'),
    },
    annotations: WRITES,
  }, async ({ source, id, text, title, meetingDate, sourceRef }) => {
    let body = text;
    let resolvedTitle = title;
    if (source === CALENDAR_SOURCE || source === GMAIL_SOURCE) {
      if (!id) throw new Error('calendar/gmail 소스는 id가 필요합니다.');
      const read = await readSource(source, id);
      body = read.text;
      resolvedTitle ||= read.subject;
    }
    if (!body || body.trim().length < 20) throw new Error('회의록 내용이 비어 있거나 너무 짧습니다.');
    const { text: clipped, truncated } = clip(body.trim());
    const { draft } = await ema.call('draftMeetingRecordFromFile', { text: clipped });
    const saved = await ema.call('saveMeetingDraft', {
      source, sourceRef: sourceRef || (id ? `${source}:${id}` : ''), title: resolvedTitle || draft.topic,
      meetingDate, rawText: clipped, draft,
    });
    return {
      draftId: saved.id,
      replaced: saved.replaced === true,
      expiresAt: saved.expiresAt,
      truncated,
      draft,
      next: '초안을 사용자에게 보여 주세요. 확정은 EMA 화면의 "회의록 추가 → 초안 불러오기"에서 합니다(기업·참여사업·아젠다 선택과 회의록 파일 첨부는 화면에서).',
    };
  });

  tool(server, 'ema_meeting_drafts_list', {
    title: '내 회의록 초안함',
    description: '내 초안함에 저장된 회의록 초안 목록입니다(원문은 포함하지 않음). 90일이 지나면 자동으로 사라집니다.',
  }, () => ema.call('listMeetingDrafts', {}));

  tool(server, 'ema_meeting_draft_get', {
    title: '회의록 초안 보기',
    description: '초안 하나의 보고서 칸 내용을 보여 줍니다. 원문은 포함하지 않습니다.',
    input: { id: idShape.describe('ema_meeting_drafts_list의 id') },
  }, async ({ id }) => {
    const { rawText, ...rest } = await ema.call('getMeetingDraft', { id });
    return { ...rest, hasRawText: Boolean(rawText) };
  });

  tool(server, 'ema_meeting_draft_delete', {
    title: '회의록 초안 삭제',
    description: '내 초안함의 초안 하나를 원문과 함께 삭제합니다. 사용자가 삭제를 요청했을 때만 호출하세요.',
    input: { id: idShape.describe('삭제할 초안 id') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ id }) => ema.call('deleteMeetingDraft', { id }));

}
