import { it, expect } from 'vitest';
import { observeConversationFeedback, validateSemanticFeedback } from './conversation-feedback.mjs';

it.each(['감사합니다', '음…', '좋네요 근데 틀렸어요', '', '짜증나'])('does not manufacture factual labels from tone: %s', (text) => {
  const result = observeConversationFeedback({ text, previousAnswerId: 'prior' });
  expect(result.trainingEligible).toBe(false);
  expect(result.interpretation).toBe('unresolved');
});
it('stores traceable correction cues but never flips truth or infers feedback without a prior answer', () => {
  const text = '그 사업 말고 AXR, 이번 달 말고 지난달';
  const result = observeConversationFeedback({ text, previousAnswerId: 'prior' });
  expect(result.observations[0].kind).toBe('correction');
  expect(text.slice(result.observations[0].start, result.observations[0].end)).toBe(result.observations[0].quote);
  expect(result.trainingEligible).toBe(false);
  expect(observeConversationFeedback({ text }).observations).toEqual([]);
});
it('rejects invented evidence and keeps semantic interpretation shadow-only', () => {
  expect(() => validateSemanticFeedback({ text: '고마워요', previousAnswerId: 'prior', kind: 'correction', quote: '틀렸어' })).toThrow();
  expect(validateSemanticFeedback({ text: '좋아 이걸로 공지하자', previousAnswerId: 'prior', kind: 'use_intent', quote: '공지하자' }).trainingEligible).toBe(false);
});
