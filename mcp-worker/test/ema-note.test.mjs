import { describe, expect, it } from 'vitest';
import { buildMeetingNote, cleanFileName } from '../src/ema/note-tools.mjs';

describe('meeting note markdown', () => {
  it('follows the team format: file name, front matter, section order', () => {
    const note = buildMeetingNote({
      counterpart: 'White Box Enterprise', category: '호주 파트너', author: '김정태', affiliation: '에이블',
      summary: ['협업 논의', 'OBF 펀드 협력 요청'], followUps: ['Asian Working Group 참여 검토'], notes: ['2019년 설립'],
      source: 'tiro', sourceRef: 'tiro:abc',
      calendarEvent: { id: 'ev1', start: '2026-10-12T10:00:00+09:00', attendees: [{ name: 'Luke Terry' }, { email: 'a@b.co' }] },
    });
    expect(note.fileName).toBe('20261012 [호주 파트너] White Box Enterprise 미팅_김정태(에이블).md');
    expect(note.markdown.startsWith('---\ndate: 2026-10-12\n')).toBe(true);
    expect(note.markdown).toContain('calendarEventId: "ev1"');
    expect(note.markdown).toContain('  - "Luke Terry"');
    const order = ['## 요약', '## 향후 팔로업', '## 참고'].map((heading) => note.markdown.indexOf(heading));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index > 0)).toBe(true);
  });

  it('prefers the calendar date, requires some date, and omits empty sections', () => {
    const note = buildMeetingNote({ counterpart: '에코랩', meetingDate: '2026-01-01', summary: ['a'],
      calendarEvent: { id: 'e', start: '2026-10-12T09:00:00Z' } });
    expect(note.date).toBe('2026-10-12');
    expect(note.markdown).not.toContain('## 참고');
    expect(note.fileName).toBe('20261012 에코랩 미팅.md');
    expect(() => buildMeetingNote({ counterpart: 'x', summary: ['a'] })).toThrow();
  });

  it('strips characters that are unsafe in file names', () => {
    expect(cleanFileName('a/b:c*d?  e')).toBe('a b c d e');
  });
});
