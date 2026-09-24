import { describe, expect, it, vi } from 'vitest';
import { createDecisionPolicy } from './decision-policy.mjs';

const candidates = [{ id: 'cashflow', description: '현금흐름을 확인합니다.' }, { id: 'projects', description: '프로젝트를 확인합니다.' }];
const request = { intentSummary: '이번 달 현황', candidates, evidenceReady: true };
const answer = (choice = 'cashflow', confidence = 0.9, probabilities = { cashflow: 0.9, projects: 0.05, __abstain__: 0.05 }) => ({ model: 'jev-1.13.0', answers: { nextCapability: { type: 'choice', choice, confidence, probabilities } }, usage: { input_tokens: 12, output_tokens: 8 } });

describe('typed decision policy', () => {
  it('does not call an evaluator when disabled, empty, evidence is absent, or explicitly authorized', async () => {
    const evaluate = vi.fn();
    await expect(createDecisionPolicy({ evaluate }).advise(request)).resolves.toMatchObject({ status: 'disabled' });
    const policy = createDecisionPolicy({ enabled: true, evaluate });
    await expect(policy.advise({ ...request, candidates: [] })).resolves.toMatchObject({ status: 'abstained', reasonCode: 'no_candidates' });
    await expect(policy.advise({ ...request, evidenceReady: false })).resolves.toMatchObject({ status: 'abstained', reasonCode: 'evidence_not_ready' });
    await expect(policy.advise({ ...request, explicitCandidateId: 'projects' })).resolves.toMatchObject({ status: 'bypassed', candidateId: 'projects' });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('does not auto-select the only candidate when it may not answer the user intent', async () => {
    const onlyPreview = [{ id: 'preview', description: 'HTML 미리보기만 확인합니다.' }];
    const evaluate = vi.fn().mockResolvedValue(answer('__abstain__', 0.96, { preview: 0.04, __abstain__: 0.96 }));
    const result = await createDecisionPolicy({ enabled: true, evaluate }).advise({ intentSummary: '9월 미제출 사업을 확인해 주세요.', candidates: onlyPreview, evidenceReady: true });
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ questions: { nextCapability: expect.objectContaining({ criteria: expect.objectContaining({ preview: onlyPreview[0].description, __abstain__: expect.any(String) }) }) } }), expect.anything());
    expect(result).toMatchObject({ status: 'abstained', reasonCode: 'model_abstained', confidenceType: 'provider_distribution_concentration' });
  });

  it('returns unavailable for one candidate when no evaluator can decide intent', async () => {
    await expect(createDecisionPolicy({ enabled: true }).advise({ ...request, candidates: [candidates[0]] })).resolves.toMatchObject({ status: 'unavailable', reasonCode: 'evaluator_unavailable' });
  });

  it('uses the constrained choice contract and returns only an allowed argmax', async () => {
    const evaluate = vi.fn().mockResolvedValue(answer());
    const result = await createDecisionPolicy({ enabled: true, evaluate }).advise(request);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ model: 'jev-1.13.0', state: { intentSummary: request.intentSummary }, questions: { nextCapability: expect.objectContaining({ type: 'choice' }) } }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result).toMatchObject({ status: 'selected', candidateId: 'cashflow', confidence: 0.9, probability: 0.9, model: 'jev-1.13.0', policyVersion: 'typed-decision-host-v1' });
    expect(result.candidateSetHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['unknown answer field', { ...answer(), answers: { nextCapability: { ...answer().answers.nextCapability, extra: true } } }],
    ['malicious id', answer('DROP TABLE', 0.9, { cashflow: 0.05, projects: 0.05, __abstain__: 0.9 })],
    ['nan probability', answer('cashflow', 0.9, { cashflow: Number.NaN, projects: 0.05, __abstain__: 0.05 })],
    ['bad distribution', answer('cashflow', 0.9, { cashflow: 0.8, projects: 0.1, __abstain__: 0.3 })],
    ['not argmax', answer('projects', 0.9, { cashflow: 0.9, projects: 0.05, __abstain__: 0.05 })],
  ])('rejects %s', async (_, response) => {
    const result = await createDecisionPolicy({ enabled: true, evaluate: vi.fn().mockResolvedValue(response) }).advise(request);
    expect(result).toMatchObject({ status: 'unavailable', reasonCode: 'invalid_response' });
    expect(result).not.toHaveProperty('candidateId');
  });

  it.each([
    ['changed model', { ...answer(), model: 'jev-1.12.0' }],
    ['missing choice type', { ...answer(), answers: { nextCapability: (() => { const { type, ...rest } = answer().answers.nextCapability; return rest; })() } }],
    ['invalid usage', { ...answer(), usage: { input_tokens: -1, output_tokens: 8 } }],
  ])('rejects %s in the official response envelope', async (_, response) => {
    await expect(createDecisionPolicy({ enabled: true, evaluate: vi.fn().mockResolvedValue(response) }).advise(request)).resolves.toMatchObject({ status: 'unavailable', reasonCode: 'invalid_response' });
  });

  it('does not pass malformed candidate ids to the evaluator', async () => {
    const evaluate = vi.fn();
    const result = await createDecisionPolicy({ enabled: true, evaluate }).advise({ ...request, candidates: [{ id: 'cashflow<script>', description: 'public' }, candidates[1]] });
    expect(result).toMatchObject({ status: 'unavailable', reasonCode: 'invalid_request' });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('rejects fields outside the typed decision input instead of forwarding execution context', async () => {
    const evaluate = vi.fn();
    const policy = createDecisionPolicy({ enabled: true, evaluate });
    await expect(policy.advise({ ...request, datasetIds: ['private'] })).resolves.toMatchObject({ status: 'unavailable', reasonCode: 'invalid_request' });
    await expect(policy.advise({ ...request, candidates: [{ ...candidates[0], execute: 'write' }, candidates[1]] })).resolves.toMatchObject({ status: 'unavailable', reasonCode: 'invalid_request' });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('changes the safe candidate hash when a catalog description changes', async () => {
    const policy = createDecisionPolicy({ enabled: true });
    const first = await policy.advise(request);
    const second = await policy.advise({ ...request, candidates: [{ ...candidates[0], description: '변경된 공개 설명' }, candidates[1]] });
    expect(first.candidateSetHash).not.toBe(second.candidateSetHash);
  });

  it('abstains for sentinel or low confidence, and handles timeout and caller abort without leaking errors', async () => {
    const abstain = await createDecisionPolicy({ enabled: true, evaluate: vi.fn().mockResolvedValue(answer('__abstain__', 0.9, { cashflow: 0.05, projects: 0.05, __abstain__: 0.9 })) }).advise(request);
    expect(abstain).toMatchObject({ status: 'abstained', reasonCode: 'model_abstained' });
    const low = await createDecisionPolicy({ enabled: true, evaluate: vi.fn().mockResolvedValue(answer('cashflow', 0.2, { cashflow: 0.9, projects: 0.05, __abstain__: 0.05 })) }).advise(request);
    expect(low).toMatchObject({ status: 'abstained', reasonCode: 'low_confidence_or_probability' });
    const timeout = await createDecisionPolicy({ enabled: true, timeoutMs: 5, evaluate: () => new Promise(() => {}) }).advise(request);
    expect(timeout).toMatchObject({ status: 'unavailable', reasonCode: 'decision_timeout' });
    const controller = new AbortController(); controller.abort(new Error('private'));
    const aborted = await createDecisionPolicy({ enabled: true, evaluate: vi.fn() }).advise(request, { signal: controller.signal });
    expect(aborted).toMatchObject({ status: 'unavailable', reasonCode: 'decision_aborted' });
    const bypassed = await createDecisionPolicy({ enabled: true, evaluate: vi.fn() }).advise({ ...request, explicitCandidateId: 'cashflow' }, { signal: controller.signal });
    expect(bypassed).toMatchObject({ status: 'unavailable', reasonCode: 'decision_aborted' });
  });
});
