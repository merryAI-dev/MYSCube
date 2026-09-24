import { describe, expect, it, vi } from 'vitest';
import { createCapabilityExecutor } from './capability-executor.mjs';
import { createDecisionPolicy } from './decision-policy.mjs';

const context = { actorId: 'test-admin', tenantId: 'test-org' };
const request = { turnId: 'turn-1', intentSummary: '자료 조회', evidenceReady: true, explicitCandidateId: 'query', input: { period: '2026-09' }, evidenceRefs: [{ id: 'copy', version: 'rev-1' }] };
function fixture() {
  const execute = vi.fn().mockResolvedValue({ rows: [{ value: 0 }] });
  const authorize = vi.fn().mockResolvedValue({ capabilityIds: ['query'], scopeFingerprint: 'scope-v1' });
  const recordDecision = vi.fn().mockResolvedValue(undefined);
  const run = createCapabilityExecutor({ capabilities: [{ id: 'query', description: '등록된 자료를 조회합니다.', effect: 'read', execute }],
    authorize, recordDecision, decisionPolicy: createDecisionPolicy({ enabled: true }) });
  return { run, execute, authorize, recordDecision };
}
describe('registered read capability execution', () => {
  it('keeps explicit reads independent of a provider and records evidence versions without input text', async () => {
    const f = fixture();
    const result = await f.run(context, request);
    expect(result).toMatchObject({ execution: 'completed', output: { rows: [{ value: 0 }] } });
    expect(f.execute).toHaveBeenCalledWith(context, request.input, expect.any(AbortSignal));
    expect(f.recordDecision.mock.calls[0][1]).toMatchObject({ scopeFingerprint: 'scope-v1', evidenceRefs: request.evidenceRefs, phase: 'decision' });
    expect(JSON.stringify(f.recordDecision.mock.calls)).not.toContain('2026-09');
  });
  it('blocks execution when project scope changes even if the same capability remains allowed', async () => {
    const f = fixture();
    f.authorize.mockResolvedValueOnce({ capabilityIds: ['query'], scopeFingerprint: 'scope-v1' });
    f.authorize.mockResolvedValue({ capabilityIds: ['query'], scopeFingerprint: 'scope-v2' });
    await expect(f.run(context, request)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.recordDecision.mock.calls.at(-1)[1]).toMatchObject({ phase: 'failed', executionStage: 'not_started', reasonCode: 'authorization_denied' });
  });
  it('withholds a finished read when scope changes and records that output was withheld', async () => {
    const f = fixture();
    f.authorize.mockResolvedValueOnce({ capabilityIds: ['query'], scopeFingerprint: 'scope-v1' });
    f.authorize.mockResolvedValueOnce({ capabilityIds: ['query'], scopeFingerprint: 'scope-v1' });
    f.authorize.mockResolvedValue({ capabilityIds: ['query'], scopeFingerprint: 'scope-v2' });
    await expect(f.run(context, request)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.recordDecision.mock.calls.at(-1)[1]).toMatchObject({ phase: 'failed', executionStage: 'output_ready' });
  });
  it('records an executor failure without copying the raw error to the trace', async () => {
    const f = fixture();
    f.execute.mockRejectedValue(new Error('private-details'));
    await expect(f.run(context, request)).rejects.toThrow('private-details');
    expect(f.recordDecision.mock.calls.at(-1)[1]).toMatchObject({ phase: 'failed', executionStage: 'started', reasonCode: 'capability_failed' });
    expect(JSON.stringify(f.recordDecision.mock.calls)).not.toContain('private-details');
  });
  it('rejects write registrations, unknown authorized IDs, and forged evidence fields', async () => {
    expect(() => createCapabilityExecutor({ capabilities: [{ id: 'save', description: 'write', effect: 'write', execute() {} }], authorize() {}, recordDecision() {}, decisionPolicy: { advise() {} } })).toThrow('Only registered');
    const f = fixture();
    f.authorize.mockResolvedValue({ capabilityIds: ['unknown'], scopeFingerprint: 'scope-v1' });
    await expect(f.run(context, request)).rejects.toThrow('Invalid authorized');
    await expect(f.run(context, { ...request, evidenceRefs: [{ id: 'copy', version: 'rev', token: 'private' }] })).rejects.toMatchObject({ statusCode: 400 });
    expect(f.execute).not.toHaveBeenCalled();
  });
});
