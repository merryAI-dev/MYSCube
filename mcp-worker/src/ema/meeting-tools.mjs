import * as z from 'zod/v4';
import { tool, WRITES } from './tool-kit.mjs';

// 회의록 초안함. 회의록은 사용자의 Gmail·Drive·Calendar 커넥터(또는 Tiro MCP)로 AI가 읽어 text로 넘긴다.
// 이 서비스는 Google 권한을 갖지 않는다. 초안은 원장에 쓰이지 않고, 확정은 EMA 화면에서 사람이 한다.
const MAX_TEXT = 60_000;

export function registerMeetingTools(server, { ema }) {
  const idShape = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/u, '영문·숫자·_·- 만 가능한 ID입니다.');

  tool(server, 'ema_meeting_draft_create', {
    title: '회의록 초안 만들기',
    description: '회의록 텍스트를 보고서 칸(주제·기업 현황·자문 내용·후속 조치·참석자) 초안으로 정리해 내 초안함에 저장합니다. 원장에는 아무것도 쓰지 않습니다. 회의록은 사용자의 Gmail·Drive·Calendar 커넥터(Meet 노트·회의록 메일)나 Tiro MCP 등으로 먼저 읽어서 text로 넘기세요. 새로 올리는 것이면 "미작성"으로 거르지 마세요. 같은 sourceRef로 다시 만들면 기존 초안을 갱신합니다. 만든 뒤 사용자에게 EMA 화면의 "회의록 추가 → 초안 불러오기"에서 확정하라고 안내하세요.',
    input: {
      text: z.string().min(20).max(200_000).describe('회의록 텍스트(Meet 노트, 회의록 메일 본문, Tiro 요약·대화록 등). 6만 자를 넘으면 앞부분만 사용'),
      source: z.enum(['meet-calendar', 'meet-gmail', 'tiro', 'manual']).optional().describe('출처. 일정 첨부 노트: meet-calendar, 회의록 메일: meet-gmail, Tiro: tiro, 그 외: manual(기본)'),
      title: z.string().max(200).optional().describe('초안 제목(예: 기업명 + 회의 주제)'),
      meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional().describe('회의 일자 YYYY-MM-DD'),
      sourceRef: z.string().max(200).optional().describe('원본 식별자(메일 ID, 일정 ID, 노트 ID 등). 같은 값이면 기존 초안을 갱신'),
    },
    annotations: WRITES,
  }, async ({ text, source = 'manual', title, meetingDate, sourceRef }) => {
    const body = text.trim();
    const clipped = body.slice(0, MAX_TEXT);
    const { draft } = await ema.call('draftMeetingRecordFromFile', { text: clipped });
    const saved = await ema.call('saveMeetingDraft', {
      source, sourceRef: sourceRef || '', title: title || draft.topic, meetingDate, rawText: clipped, draft,
    });
    return {
      draftId: saved.id,
      replaced: saved.replaced === true,
      expiresAt: saved.expiresAt,
      truncated: body.length > MAX_TEXT,
      draft,
      next: '초안을 사용자에게 보여 주세요. 확정은 EMA 화면의 "회의록 추가 → 초안 불러오기"에서 합니다(기업·참여사업·아젠다 선택과 회의록 파일 첨부는 화면에서).',
    };
  });

  tool(server, 'ema_meeting_drafts_list', {
    title: '내 회의록 초안함',
    description: '내 초안함에 저장된 회의록 초안 목록입니다(원문은 포함하지 않음). 90일이 지나면 사라집니다.',
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
