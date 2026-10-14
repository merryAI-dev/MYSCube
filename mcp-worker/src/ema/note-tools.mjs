import * as z from 'zod/v4';
import { NOT_CONFIGURED } from './note-save.mjs';
import { tool, WRITES } from './tool-kit.mjs';

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

// 원본이 여러 건(예: Tiro 녹음 2건을 한 회의록으로)이면 정렬해 하나의 키로 묶는다. 같은 묶음이면 같은 파일을 갱신한다.
export function sourceKeyOf(input) {
  const refs = [...new Set([input.sourceRef, ...(input.sourceRefs ?? [])].map((ref) => String(ref ?? '').trim()).filter(Boolean))].sort();
  return { refs, key: refs.join('+') };
}

// 일정이 있으면 일정의 날짜·참석자를 우선한다. 일정과 입력이 다르면 일정이 기준이다.
export function buildMeetingNote(input) {
  const event = input.calendarEvent;
  const date = (event?.start ? event.start.slice(0, 10) : input.meetingDate) || '';
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error('회의 날짜가 필요합니다(meetingDate 또는 calendarEvent.start).');
  const category = input.category?.trim() || '';
  const counterpart = input.counterpart.trim();
  const by = input.author ? `_${input.author.trim()}${input.affiliation ? `(${input.affiliation.trim()})` : ''}` : '';
  // 행사·발표회처럼 "미팅"이 어색하면 title로 이름을 직접 준다.
  const name = input.title?.trim() || `${counterpart} 미팅`;
  const title = `${category ? `[${category}] ` : ''}${name}${by}`;
  const { refs } = sourceKeyOf(input);
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
    ...(refs.length > 1 ? ['sourceRefs:', ...refs.map((ref) => `  - ${yaml(ref)}`)] : [`sourceRef: ${yaml(refs[0])}`]),
    `calendarEventId: ${yaml(event?.id)}`,
    ...(attendees.length ? ['attendees:', ...attendees.map((name) => `  - ${yaml(name)}`)] : []),
    '---',
  ].join('\n');
  const details = input.details?.trim();
  const markdown = `${header}\n\n# ${title}\n\n## 요약\n${bullets(input.summary)}\n${details ? `\n## 상세내용\n${details}\n` : ''}\n## 향후 팔로업\n${bullets(input.followUps)}\n${
    input.notes?.length ? `\n## 참고\n${bullets(input.notes)}\n` : ''}`;
  return { fileName, title, date, markdown };
}

export function registerNoteTools(server, { notes, saveNote, publicOrigin, uid } = {}) {
  tool(server, 'ema_meeting_note_markdown', {
    title: '회의록 마크다운 만들기',
    description: `회의록을 팀 표준 마크다운(머리말 + 요약 + 상세내용 + 향후 팔로업 + 참고)과 파일명으로 만들어 줍니다. 이 도구는 저장하지 않습니다. 저장은 Drive 커넥터로 직접 올리지 말고(ChatGPT 등에서 파일 참조 형식 오류로 실패함) 다음 중 하나로 하세요: (가) ema_meeting_note_save(noteId)로 바로 저장(대화 안 쓰기가 허용되는 환경) (나) 그게 차단되면 사용자에게 saveUrl을 주고 화면의 "드라이브에 저장"을 누르게 한다. 순서: ① 회의록(Gmail·Tiro MCP 등)을 읽는다 ② Google Calendar 커넥터로 회의 시각 전후의 비슷한 일정을 찾아 제목·참석자가 맞는 것을 calendarEvent로 넘긴다(여러 개면 사용자에게 고르게 한다, 없으면 생략) ③ 요약·상세내용·향후 팔로업·참고를 직접 정리해 넘긴다. 원본이 여러 건이면 sourceRefs에 모두 넣는다. 같은 fileName이나 같은 원본 묶음이 폴더에 있으면 자동으로 갱신된다.`,
    input: {
      counterpart: z.string().min(1).max(120).describe('상대 기관·기업·주제. 파일명에 들어감(예: White Box Enterprise)'),
      title: z.string().max(120).optional().describe('제목을 직접 줄 때(행사·발표회 등 "미팅"이 어색한 경우). 예: MYSC 임팩트 스타트업 IR+AR'),
      category: z.string().max(40).optional().describe('분류(예: 호주 파트너, 투자사, 고객사). 모르면 생략'),
      meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional().describe('회의 날짜. calendarEvent가 있으면 일정의 날짜를 씀'),
      author: z.string().max(40).optional().describe('작성자 이름'),
      affiliation: z.string().max(40).optional().describe('작성자 소속'),
      summary: z.array(z.string().max(1000)).min(1).describe('요약 불릿: 배경, 핵심 논의, 상대방 요청'),
      followUps: z.array(z.string().max(500)).optional().describe('향후 팔로업 불릿(다음 행동)'),
      details: z.string().max(50_000).optional().describe('상세내용(마크다운). 발표·논의별 소제목과 질의응답 등. 없으면 섹션 생략'),
      notes: z.array(z.string().max(2000)).optional().describe('참고 불릿(상대 기관 소개, 출처 등). 없으면 섹션 생략'),
      source: z.enum(['meet-calendar', 'meet-gmail', 'tiro', 'manual']).optional().describe('회의록 출처'),
      sourceRef: z.string().max(200).optional().describe('원본 식별자(메일 ID, Tiro 노트 ID 등). 중복 저장 방지에 씀'),
      sourceRefs: z.array(z.string().max(200)).optional().describe('원본이 여러 건일 때 모든 식별자(예: Tiro 녹음 2건)'),
      calendarEvent: z.object({
        id: z.string().max(200).describe('일정 ID'),
        title: z.string().max(300).optional(),
        start: z.string().max(40).describe('시작 시각(ISO 8601)'),
        attendees: z.array(z.object({ name: z.string().max(100).optional(), email: z.string().max(200).optional() })).optional(),
      }).optional().describe('Google Calendar 커넥터로 찾은 매칭 일정'),
    },
  }, async (input) => {
    const note = buildMeetingNote(input);
    const noteId = notes ? await notes.put(uid, { fileName: note.fileName, markdown: note.markdown, sourceRef: sourceKeyOf(input).key }) : null;
    return {
      ...note,
      folderId: NOTES_FOLDER_ID,
      ...(noteId ? { noteId, saveUrl: `${publicOrigin}/note/${noteId}` } : {}),
      driveSaveReady: Boolean(saveNote),
      next: noteId
        ? '사용자에게 파일명과 요약을 보여 주고 확인을 받으세요. 확인하면 ema_meeting_note_save(noteId)로 저장하고, 그 도구가 차단되면 saveUrl을 전달하세요(링크 화면의 "드라이브에 저장", 24시간 유효). Drive 커넥터로 직접 올리지 마세요.'
        : '사용자에게 파일명과 요약을 보여 주고, Drive 커넥터로 folderId 폴더에 fileName으로 저장하세요.',
    };
  });

  if (!notes) return;
  tool(server, 'ema_meeting_note_save', {
    title: '회의록 드라이브 저장',
    description: 'ema_meeting_note_markdown으로 만든 회의록을 팀 드라이브 폴더에 바로 저장합니다. 같은 파일명이나 같은 sourceRef 파일이 있으면 갱신합니다. 사용자가 저장을 확인한 뒤에만 호출하세요. 이 도구가 차단되는 환경(ChatGPT 등)에서는 saveUrl을 사용자에게 주세요.',
    input: { noteId: z.string().min(20).max(80).regex(/^[A-Za-z0-9_-]+$/u).describe('ema_meeting_note_markdown이 돌려준 noteId') },
    annotations: WRITES,
  }, async ({ noteId }) => {
    const note = await notes.get(noteId);
    if (!note || note.uid !== uid) throw new Error('회의록을 찾을 수 없습니다. ema_meeting_note_markdown을 다시 호출하세요.');
    if (!saveNote) throw new Error(NOT_CONFIGURED);
    return saveNote(note);
  });
}
