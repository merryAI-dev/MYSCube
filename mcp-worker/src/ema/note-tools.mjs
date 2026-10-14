import * as z from 'zod/v4';
import { tool } from './tool-kit.mjs';

// 회의록 마크다운 서식. AI가 요약·팔로업을 쓰고, 이 도구는 파일명·머리말·섹션 순서를 항상 같게 만든다.
// 저장은 사용자의 Drive 커넥터가 한다. 이 서비스는 Google 권한을 갖지 않는다.
export const NOTES_FOLDER_ID = '16jX-kywwIxXxYUGMWk1roj0fiW6yC4v-';

const UNSAFE_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/gu;

export function cleanFileName(value) {
  return String(value).replace(UNSAFE_FILE_CHARS, ' ').replace(/\s+/gu, ' ').trim();
}

const yaml = (value) => JSON.stringify(String(value ?? ''));

function bullets(items) {
  const lines = (items ?? []).map((item) => String(item).trim()).filter(Boolean);
  return lines.length ? lines.map((line) => `- ${line}`).join('\n') : '- (없음)';
}

// 일정이 있으면 일정의 날짜·참석자를 우선한다. 일정과 입력이 다르면 일정이 기준이다.
export function buildMeetingNote(input) {
  const event = input.calendarEvent;
  const date = (event?.start ? event.start.slice(0, 10) : input.meetingDate) || '';
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error('회의 날짜가 필요합니다(meetingDate 또는 calendarEvent.start).');
  const category = input.category?.trim() || '';
  const counterpart = input.counterpart.trim();
  const by = input.author ? `_${input.author.trim()}${input.affiliation ? `(${input.affiliation.trim()})` : ''}` : '';
  const title = `${category ? `[${category}] ` : ''}${counterpart} 미팅${by}`;
  const fileName = `${cleanFileName(`${date.replaceAll('-', '')} ${title}`)}.md`;
  const attendees = (event?.attendees ?? []).map((person) => person.name || person.email).filter(Boolean);
  const header = [
    '---',
    `date: ${date}`,
    `category: ${yaml(category)}`,
    `counterpart: ${yaml(counterpart)}`,
    `author: ${yaml(input.author)}`,
    `affiliation: ${yaml(input.affiliation)}`,
    `source: ${input.source ?? 'manual'}`,
    `sourceRef: ${yaml(input.sourceRef)}`,
    `calendarEventId: ${yaml(event?.id)}`,
    ...(attendees.length ? ['attendees:', ...attendees.map((name) => `  - ${yaml(name)}`)] : []),
    '---',
  ].join('\n');
  const markdown = `${header}\n\n# ${title}\n\n## 요약\n${bullets(input.summary)}\n\n## 향후 팔로업\n${bullets(input.followUps)}\n${
    input.notes?.length ? `\n## 참고\n${bullets(input.notes)}\n` : ''}`;
  return { fileName, title, date, markdown };
}

export function registerNoteTools(server) {
  tool(server, 'ema_meeting_note_markdown', {
    title: '회의록 마크다운 만들기',
    description: `회의록을 팀 표준 마크다운(머리말 + 요약 + 향후 팔로업 + 참고)과 파일명으로 만들어 줍니다. 저장은 하지 않으며, 돌려준 fileName과 markdown을 Drive 커넥터로 folderId 폴더에 저장하세요. 순서: ① 회의록(Gmail·Tiro MCP 등)을 읽는다 ② Google Calendar 커넥터로 회의 시각 전후의 비슷한 일정을 찾아 제목·참석자가 맞는 것을 calendarEvent로 넘긴다(여러 개면 사용자에게 고르게 한다, 없으면 생략) ③ 요약·향후 팔로업·참고를 직접 정리해 넘긴다 ④ 저장 전에 폴더에서 같은 sourceRef나 같은 fileName이 있는지 찾아 있으면 새로 만들지 말고 갱신한다.`,
    input: {
      counterpart: z.string().min(1).max(120).describe('상대 기관·기업·주제. 파일명에 들어감(예: White Box Enterprise)'),
      category: z.string().max(40).optional().describe('분류(예: 호주 파트너, 투자사, 고객사). 모르면 생략'),
      meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional().describe('회의 날짜. calendarEvent가 있으면 일정의 날짜를 씀'),
      author: z.string().max(40).optional().describe('작성자 이름'),
      affiliation: z.string().max(40).optional().describe('작성자 소속'),
      summary: z.array(z.string().max(1000)).min(1).describe('요약 불릿: 배경, 핵심 논의, 상대방 요청'),
      followUps: z.array(z.string().max(500)).optional().describe('향후 팔로업 불릿(다음 행동)'),
      notes: z.array(z.string().max(2000)).optional().describe('참고 불릿(상대 기관 소개, 출처 등). 없으면 섹션 생략'),
      source: z.enum(['meet-calendar', 'meet-gmail', 'tiro', 'manual']).optional().describe('회의록 출처'),
      sourceRef: z.string().max(200).optional().describe('원본 식별자(메일 ID, Tiro 노트 ID 등). 중복 저장 방지에 씀'),
      calendarEvent: z.object({
        id: z.string().max(200).describe('일정 ID'),
        title: z.string().max(300).optional(),
        start: z.string().max(40).describe('시작 시각(ISO 8601)'),
        attendees: z.array(z.object({ name: z.string().max(100).optional(), email: z.string().max(200).optional() })).optional(),
      }).optional().describe('Google Calendar 커넥터로 찾은 매칭 일정'),
    },
  }, async (input) => ({
    ...buildMeetingNote(input),
    folderId: NOTES_FOLDER_ID,
    next: '사용자에게 파일명과 요약을 보여 주고, Drive 커넥터로 folderId 폴더에 fileName으로 저장하세요. 같은 sourceRef/fileName 파일이 이미 있으면 갱신합니다.',
  }));
}
