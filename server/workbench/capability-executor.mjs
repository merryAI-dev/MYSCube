import { randomUUID } from 'node:crypto';
import { createHttpError } from '../bff/bff-utils.mjs';

const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function assertScope(value, registry) {
  if (!value || !safeId(value.scopeFingerprint) || !Array.isArray(value.capabilityIds)
    || value.capabilityIds.some((id) => !registry.has(id))) throw new Error('Invalid authorized capability scope.');
  return value;
}

export function createCapabilityExecutor({ capabilities, authorize, decisionPolicy, recordDecision }) {
  if (!Array.isArray(capabilities) || capabilities.length > 32 || typeof authorize !== 'function'
    || typeof decisionPolicy?.advise !== 'function' || typeof recordDecision !== 'function') throw new Error('Invalid capability executor configuration.');
  const registry = new Map();
  for (const capability of capabilities) {
    if (!safeId(capability.id) || registry.has(capability.id) || !['read', 'preview'].includes(capability.effect)
      || typeof capability.description !== 'string' || typeof capability.execute !== 'function') throw new Error('Only registered read and preview capabilities may be executed.');
    registry.set(capability.id, Object.freeze({ ...capability }));
  }

  return async (context, { turnId, intentSummary, input, evidenceReady, explicitCandidateId, evidenceRefs = [] }, { signal = new AbortController().signal } = {}) => {
    if (!safeId(turnId)) throw createHttpError(400, '대화 요청 번호를 확인해 주세요.', 'workbench_turn_invalid');
    if (!Array.isArray(evidenceRefs) || evidenceRefs.length > 32 || evidenceRefs.some((ref) => !ref || !safeId(ref.id) || !safeId(ref.version)
      || Object.keys(ref).sort().join('|') !== 'id|version')) throw createHttpError(400, '조회 근거 버전을 확인해 주세요.', 'workbench_evidence_invalid');
    signal.throwIfAborted();
    // Authorization returns the server-owned candidate set, never a set supplied by the model.
    const scope = assertScope(await authorize(context), registry);
    const candidates = [...new Set(scope.capabilityIds)].map((id) => ({ id, description: registry.get(id).description }));
    const decision = await decisionPolicy.advise({ intentSummary, candidates, evidenceReady,
      ...(explicitCandidateId === undefined ? {} : { explicitCandidateId }) }, { signal });
    signal.throwIfAborted();
    const trace = { decisionId: randomUUID(), turnId, scopeFingerprint: scope.scopeFingerprint, evidenceRefs: structuredClone(evidenceRefs), decision };
    await recordDecision(context, { ...trace, phase: 'decision' });
    if (!['selected', 'bypassed'].includes(decision.status)) return { decisionId: trace.decisionId, decision, execution: 'not_run' };
    let executionStage = 'not_started';
    try {
      if (!candidates.some(({ id }) => id === decision.candidateId)) throw createHttpError(403, '허용되지 않은 조회입니다.', 'workbench_capability_denied');
      const current = assertScope(await authorize(context), registry);
      signal.throwIfAborted();
      if (current.scopeFingerprint !== scope.scopeFingerprint || !current.capabilityIds.includes(decision.candidateId)) throw createHttpError(403, '조회 권한이 변경되었습니다.', 'workbench_capability_denied');
      executionStage = 'started';
      const output = await registry.get(decision.candidateId).execute(context, input, signal);
      executionStage = 'output_ready';
      const after = assertScope(await authorize(context), registry);
      signal.throwIfAborted();
      if (after.scopeFingerprint !== scope.scopeFingerprint || !after.capabilityIds.includes(decision.candidateId)) throw createHttpError(403, '조회 중 권한이 변경되어 결과를 표시하지 않습니다.', 'workbench_capability_denied');
      await recordDecision(context, { ...trace, phase: 'completed' });
      return { decisionId: trace.decisionId, decision, execution: 'completed', output };
    } catch (error) {
      try {
        await recordDecision(context, { ...trace, phase: 'failed', executionStage,
          reasonCode: signal.aborted ? 'execution_aborted' : error?.statusCode === 403 ? 'authorization_denied' : 'capability_failed' });
      } catch { /* An unavailable audit store must not replace the original execution failure. */ }
      throw error;
    }
  };
}
