import * as z from 'zod/v4';
import { DESTINATIONS, saveToDestinations } from './note-save.mjs';
import { tool, WRITES } from './tool-kit.mjs';

// 회의록 정리·저장. AI가 요약·상세내용·팔로업을 쓰고, 이 도구는 파일명·머리말·섹션 순서를 항상 같게 만든다.
// 저장 위치는 명시적으로 고른다: drive(팀 드라이브 전사 회의록 폴더), ema_draft(EMA 보고서 초안함), both.
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

export const GUIDE = `# 회의록 정리·저장 가이드

## 용어
- **팀 드라이브**: 전사 회의록 공유 드라이브 폴더(회사 계정만 접근). 회의록 .md 파일이 쌓이는 곳.
- **EMA 보고서 초안함**: EMA Station의 오피스아워 보고서 초안 보관함. 확정은 EMA 화면 "회의록 추가 → 초안 불러오기"에서 사람이 한다. 오피스아워 원장에는 쓰지 않는다.
- **원본**: Gmail 회의록 메일, Tiro 노트, Meet 노트 등. 여러 건이면 하나의 회의록으로 묶을 수 있다.

## 저장 위치(destination) 고르기
| 값 | 저장되는 곳 | 언제 |
|---|---|---|
| drive | 팀 드라이브 폴더에 .md 파일 | 기본. 모든 회의록 축적 |
| ema_draft | EMA 보고서 초안함 | 오피스아워 보고서를 써야 하는 회의 |
| both | 둘 다 | 오피스아워 회의를 기록도 남기고 보고서도 쓸 때 |
사용자가 말하지 않았으면 drive로 하되, 기업 오피스아워·자문 회의로 보이면 both를 제안한다.

## 순서
1. 원본을 읽는다(Gmail 커넥터의 회의록 메일, Tiro MCP 노트 등).
2. Google Calendar 커넥터로 회의 시각 전후의 비슷한 일정을 찾는다. 후보가 여러 개면 사용자에게 고르게 하고, 없으면 생략한다.
3. meeting_note_compose 로 정리한다(요약·상세내용·향후 팔로업·참고). 원본이 여러 건이면 sourceRefs에 모두 넣는다.
4. 파일명과 요약을 보여 주고 저장 위치를 확인받는다.
5. meeting_note_save(noteId, destination)로 저장한다. 이 도구가 차단되면(ChatGPT 등) saveUrl을 주고 화면에서 저장 위치 버튼을 누르게 한다.

## 하지 말 것
- AI 앱의 Google Drive 커넥터로 직접 업로드하지 않는다. 공유 드라이브 폴더를 경로로 찾지 못하거나(not_found) 새로 만든 파일을 넘기지 못해(file_uri must be a connector file reference) 실패한다.
- 저장했다고 말하기 전에 meeting_note_save 결과나 사용자의 화면 확인을 받는다.

## 예시 요청
- "어제 Gmail로 온 회의록을 캘린더와 맞춰서 팀 드라이브에 저장해 줘"
- "오늘 에코랩 오피스아워 Tiro 노트, 드라이브랑 EMA 초안함 둘 다 넣어 줘"

## 같은 회의를 다시 저장하면
팀 드라이브는 같은 파일명이나 같은 원본 묶음이면 새로 만들지 않고 갱신한다. EMA 초안함도 같은 원본이면 기존 초안을 갱신한다.`;

const destinationShape = z.enum(DESTINATIONS).describe('저장 위치. drive=팀 드라이브(전사 회의록 폴더), ema_draft=EMA 보고서 초안함, both=둘 다');

export function registerNoteTools(server, { ema, notes, saveNote, publicOrigin, access = {} } = {}) {
  tool(server, 'meeting_note_guide', {
    title: '회의록 정리·저장 가이드',
    description: '회의록 정리·저장의 용어, 저장 위치(팀 드라이브 / EMA 보고서 초안함) 고르는 법, 순서, 하지 말 것, 예시 요청을 돌려줍니다. 회의록 저장 요청을 처음 받았거나 사용자가 방법을 물으면 먼저 읽으세요.',
  }, () => ({ guide: GUIDE }));

  tool(server, 'meeting_note_compose', {
    title: '회의록 정리(표준 형식)',
    description: '회의록을 팀 표준 마크다운(머리말 + 요약 + 상세내용 + 향후 팔로업 + 참고)과 파일명으로 정리합니다. 아직 아무 데도 저장하지 않습니다. 결과를 사용자에게 보여 주고 저장 위치를 확인받은 뒤 meeting_note_save로 저장하세요(차단되면 saveUrl). AI 앱의 Drive 커넥터로 직접 업로드하지 마세요. 처음이면 meeting_note_guide를 먼저 읽으세요.',
    input: {
      counterpart: z.string().min(1).max(120).describe('상대 기관·기업·주제. 파일명에 들어감(예: White Box Enterprise)'),
      title: z.string().max(120).optional().describe('제목을 직접 줄 때(행사·발표회 등 "미팅"이 어색한 경우). 예: MYSC 임팩트 스타트업 IR+AR'),
      category: z.string().max(40).optional().describe('분류(예: 호주 파트너, 투자사, 고객사). 모르면 생략'),
      meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional().describe('회의 날짜. calendarEvent가 있으면 일정의 날짜를 씀'),
      author: z.string().max(40).optional().describe('작성자 이름'),
      affiliation: z.string().max(40).optional().describe('작성자 소속'),
      summary: z.array(z.string().max(1000)).min(1).describe('요약 불릿: 배경, 핵심 논의, 상대방 요청'),
      details: z.string().max(50_000).optional().describe('상세내용(마크다운). 발표·논의별 소제목과 질의응답 등. 없으면 섹션 생략'),
      followUps: z.array(z.string().max(500)).optional().describe('향후 팔로업 불릿(다음 행동)'),
      notes: z.array(z.string().max(2000)).optional().describe('참고 불릿(상대 기관 소개, 출처 등). 없으면 섹션 생략'),
      source: z.enum(['meet-calendar', 'meet-gmail', 'tiro', 'manual']).optional().describe('원본 종류. Gmail 회의록 메일: meet-gmail, 캘린더 첨부 노트: meet-calendar, Tiro: tiro, 그 외: manual'),
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
    const record = {
      fileName: note.fileName, title: note.title, date: note.date, markdown: note.markdown,
      sourceRef: sourceKeyOf(input).key, source: input.source ?? 'manual',
      // 저장 링크 화면에서 EMA 초안함 저장을 할 수 있을 때만 로그인 증명을 함께 둔다(만료 후에는 버튼이 사라짐).
      ...(ema ? { idToken: access.idToken ?? null, idTokenExpiresAt: access.idTokenExpiresAt ?? null } : {}),
    };
    const noteId = notes ? await notes.put(access.uid, record) : null;
    return {
      fileName: note.fileName, title: note.title, date: note.date, markdown: note.markdown,
      ...(noteId ? { noteId, saveUrl: `${publicOrigin}/note/${noteId}` } : {}),
      destinations: { drive: Boolean(saveNote), ema_draft: Boolean(ema) },
      next: '파일명과 요약을 사용자에게 보여 주고 저장 위치(drive=팀 드라이브, ema_draft=EMA 보고서 초안함, both)를 확인받은 뒤 meeting_note_save로 저장하세요. 그 도구가 차단되면 saveUrl을 주세요(링크 화면에서 저장 위치 버튼을 누름).',
    };
  });

  if (!notes) return;
  tool(server, 'meeting_note_save', {
    title: '회의록 저장(저장 위치 선택)',
    description: 'meeting_note_compose로 정리한 회의록을 고른 위치에 저장합니다. drive=팀 드라이브 전사 회의록 폴더에 .md 파일, ema_draft=EMA 보고서 초안함(오피스아워 원장에는 쓰지 않음), both=둘 다. 같은 회의(같은 파일명·원본)는 새로 만들지 않고 갱신합니다. 사용자가 저장 위치를 확인한 뒤에만 호출하세요. 차단되는 환경에서는 saveUrl을 사용자에게 주세요.',
    input: {
      noteId: z.string().min(20).max(80).regex(/^[A-Za-z0-9_-]+$/u).describe('meeting_note_compose가 돌려준 noteId'),
      destination: destinationShape,
    },
    annotations: WRITES,
  }, async ({ noteId, destination }) => {
    const note = await notes.get(noteId);
    if (!note || note.uid !== access.uid) throw new Error('회의록을 찾을 수 없습니다. meeting_note_compose를 다시 호출하세요.');
    return saveToDestinations({ note, destination, saveNote, ema });
  });
}
