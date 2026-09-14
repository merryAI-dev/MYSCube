const signals = [
  ['correction', /(?:말고|아니라|지난달로|이번\s*달로|다시\s*확인)/],
  ['scope_concern', /(?:왜\s*이것만|빠졌|누락|전체.*(?:아니|맞)|이게\s*다)/],
  ['use_intent', /(?:이걸로\s*공지|공유하자|그대로\s*보내)/],
];

export function observeConversationFeedback({ text, previousAnswerId = null }) {
  const observations = [];
  if (previousAnswerId) for (const [kind, pattern] of signals) {
    const match = pattern.exec(text);
    if (match) observations.push({ kind, quote: match[0], start: match.index, end: match.index + match[0].length, source: 'lexical_candidate' });
  }
  return { version: 'conversation-shadow-v1', previousAnswerId, observations,
    interpretation: observations.length ? 'candidate_feedback' : 'unresolved',
    trainingEligible: false, reason: 'Conversation cues are not verified preference pairs or factual labels.' };
}

export function validateSemanticFeedback({ text, previousAnswerId, kind, quote }) {
  if (!previousAnswerId || !['correction', 'scope_concern', 'use_intent', 'ambiguous'].includes(kind)
    || typeof quote !== 'string' || !quote.trim() || quote.length > 500 || !text.includes(quote)) throw new Error('feedback_evidence_invalid');
  return { version: 'conversation-shadow-v1', previousAnswerId, kind, quote,
    source: 'model_candidate', trainingEligible: false };
}
