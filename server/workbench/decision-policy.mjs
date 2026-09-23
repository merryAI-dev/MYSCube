import { createHash } from 'node:crypto';

const POLICY_VERSION = 'typed-decision-host-v1';
const CATALOG_SCHEMA_VERSION = 'decision-catalog-v1';
const EXPECTED_MODEL = 'jev-1.13.0';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ABSTAIN = '__abstain__';

const hashCandidateSet = (candidates) => createHash('sha256').update(JSON.stringify({ schemaVersion: CATALOG_SCHEMA_VERSION, candidates: candidates.map(({ id, description }) => ({ id, description })) })).digest('hex');
const safeNumber = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const safeUsageNumber = (value) => Number.isFinite(value) && value >= 0 && value <= 10_000_000;
const outcome = (status, reasonCode, candidateSetHash, started, now, fields = {}) => ({
  status, reasonCode, candidateSetHash, policyVersion: POLICY_VERSION, confidenceType: 'provider_distribution_concentration', durationMs: Math.max(0, now() - started), ...fields,
});

function validateCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length > 32) return null;
  const ids = new Set();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Object.keys(candidate).sort().join('|') !== 'description|id'
      || typeof candidate.id !== 'string' || !ID.test(candidate.id) || ids.has(candidate.id)
      || typeof candidate.description !== 'string' || candidate.description.length > 500) return null;
    ids.add(candidate.id);
  }
  return candidates;
}

function parseAnswer(value, candidates, minimumConfidence, minimumProbability) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join('|') !== 'choice|confidence|probabilities|type') return null;
  const { type, choice, confidence, probabilities } = value;
  if (type !== 'choice') return null;
  if (typeof choice !== 'string' || !safeNumber(confidence) || !probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) return null;
  const allowed = [...candidates.map(({ id }) => id), ABSTAIN].sort();
  const probabilityKeys = Object.keys(probabilities).sort();
  if (probabilityKeys.join('|') !== allowed.join('|')) return null;
  const values = probabilityKeys.map((key) => probabilities[key]);
  if (!values.every(safeNumber) || Math.abs(values.reduce((sum, item) => sum + item, 0) - 1) > 0.001) return null;
  const max = Math.max(...values);
  if (probabilities[choice] !== max) return null;
  if (choice === ABSTAIN || !candidates.some(({ id }) => id === choice)) return { abstain: true, confidence, probability: probabilities[choice] };
  if (confidence < minimumConfidence || probabilities[choice] < minimumProbability) return { abstain: true, confidence, probability: probabilities[choice], low: true };
  return { candidateId: choice, confidence, probability: probabilities[choice] };
}

function parseResponse(response, candidates, minimumConfidence, minimumProbability) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  if (Object.keys(response).sort().join('|') !== 'answers|model|usage' || response.model !== EXPECTED_MODEL) return null;
  const { answers, usage } = response;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).join('|') !== 'nextCapability') return null;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage) || Object.keys(usage).sort().join('|') !== 'input_tokens|output_tokens'
    || !safeUsageNumber(usage.input_tokens) || !safeUsageNumber(usage.output_tokens)) return null;
  return { answer: parseAnswer(answers.nextCapability, candidates, minimumConfidence, minimumProbability), model: response.model };
}

function timedEvaluate(evaluate, request, signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('decision_timeout')), timeoutMs);
  return Promise.race([
    Promise.resolve().then(() => evaluate(request, { signal: controller.signal })),
    new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason || new Error('decision_aborted')), { once: true })),
  ]).finally(() => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); });
}

export function createDecisionPolicy({ enabled = false, evaluate, timeoutMs = 1000, minimumConfidence = 0.8, minimumProbability = 0.8, now = () => Date.now() } = {}) {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 10_000) : 1000;
  const confidenceFloor = safeNumber(minimumConfidence) ? minimumConfidence : 0.8;
  const probabilityFloor = safeNumber(minimumProbability) ? minimumProbability : 0.8;
  return {
    async advise(input = {}, { signal } = {}) {
      const started = now();
      const { intentSummary, candidates, evidenceReady, explicitCandidateId } = input || {};
      const valid = validateCandidates(candidates);
      const candidateSetHash = hashCandidateSet(Array.isArray(candidates) ? candidates.filter((candidate) => candidate && typeof candidate.id === 'string' && typeof candidate.description === 'string') : []);
      if (!enabled) return outcome('disabled', 'policy_disabled', candidateSetHash, started, now);
      const inputKeys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input).sort().join('|') : '';
      const expectedInputKeys = explicitCandidateId === undefined ? 'candidates|evidenceReady|intentSummary' : 'candidates|evidenceReady|explicitCandidateId|intentSummary';
      if (!valid || inputKeys !== expectedInputKeys
        || typeof intentSummary !== 'string' || intentSummary.length > 1000) return outcome('unavailable', 'invalid_request', candidateSetHash, started, now);
      if (signal?.aborted) return outcome('unavailable', 'decision_aborted', candidateSetHash, started, now);
      if (!valid.length) return outcome('abstained', 'no_candidates', candidateSetHash, started, now);
      if (evidenceReady !== true) return outcome('abstained', 'evidence_not_ready', candidateSetHash, started, now);
      if (explicitCandidateId !== undefined) {
        if (!valid.some(({ id }) => id === explicitCandidateId)) return outcome('abstained', 'invalid_explicit_candidate', candidateSetHash, started, now);
        return outcome('bypassed', 'explicit_candidate', candidateSetHash, started, now, { candidateId: explicitCandidateId });
      }
      if (typeof evaluate !== 'function') return outcome('unavailable', 'evaluator_unavailable', candidateSetHash, started, now);
      const criteria = Object.fromEntries(valid.map(({ id, description }) => [id, description]));
      criteria[ABSTAIN] = '근거가 부족하거나 후보를 선택할 수 없음';
      try {
        const response = await timedEvaluate(evaluate, { model: EXPECTED_MODEL, state: { intentSummary }, questions: { nextCapability: { type: 'choice', instructions: '근거가 충분할 때만 하나를 선택하세요.', criteria } } }, signal, timeout);
        const parsed = parseResponse(response, valid, confidenceFloor, probabilityFloor);
        const answer = parsed?.answer;
        if (!answer) return outcome('unavailable', 'invalid_response', candidateSetHash, started, now);
        if (answer.abstain) return outcome('abstained', answer.low ? 'low_confidence_or_probability' : 'model_abstained', candidateSetHash, started, now, { confidence: answer.confidence, probability: answer.probability });
        return outcome('selected', 'model_selected', candidateSetHash, started, now, { candidateId: answer.candidateId, confidence: answer.confidence, probability: answer.probability, model: parsed.model });
      } catch (error) {
        const reasonCode = signal?.aborted ? 'decision_aborted' : error instanceof Error && error.message === 'decision_timeout' ? 'decision_timeout' : 'evaluation_unavailable';
        return outcome('unavailable', reasonCode, candidateSetHash, started, now);
      }
    },
  };
}
