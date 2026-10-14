import test from 'node:test';
import assert from 'node:assert/strict';
import policyData from '../../policies/cashflow-policy.json' with { type: 'json' };
import { LINE_ROWS } from '../bff/cashflow-coordinates.mjs';
import { createPipelineInvestigationTools } from './pipeline-tools.mjs';
const projectId = 'p1779092105308';
const labelContract = {
  source_revision: 'a'.repeat(40), coordinates_blob_sha: 'b'.repeat(40), policy_blob_sha: 'c'.repeat(40),
  ...Object.fromEntries(['projection', 'actual'].map(mode => [mode, LINE_ROWS[mode].map((r, i) => ({
    row: r + 1, line_id: policyData.lineEntries[i].lineId,
    label: policyData.lineEntries[i][mode + 'Label'] || policyData.lineEntries[i].label,
  }))])),
};
function configuration(scopeKind) {
  let calls = 0;
  const denied = Error('authority_revoked');
  const config = { labelContract, env: {}, runBinding: { run_id: 'test-run' },
    request: { policy: { cloudProject: 'inner-platform-live-20260316', tenant: 'mysc', scopeKind,
      trustedActorId: 'reporter', allowedProjectIds: scopeKind === 'platform' ? [] : [projectId],
      allowedStartAt: '2026-10-12T08:00:00Z', allowedEndAt: '2026-10-12T08:10:00Z',
      services: [{ name: 'innerplatform-jvm-weekly-api-live', region: 'us-central1' }],
    }, report: { server_context: {} } },
    pipeline: { authorize: async () => { throw denied; } },
    auth: { getClient: async () => { calls++; throw Error('source must not be called'); } },
  };
  return { config, denied, calls: () => calls };
}

for (const scope of ['platform', 'project']) {
  test(`shared factory preserves ${scope} scope and denies before source I/O`, async () => {
    const fixture = configuration(scope);
    const result = await createPipelineInvestigationTools(fixture.config);
    assert.equal(fixture.calls(), 0);
    assert.ok(!JSON.stringify(result.tools).includes('p0000000000'));
    assert.ok(result.tools.query_reporter_operations);
    assert.ok(result.tools.query_jvm_request_diagnostics);
    const names = Object.keys(result.tools);
    const sheets = names.filter(name => name.includes('sheet'));
    assert.equal(sheets.length > 0, true);
    for (const tool of Object.values(result.tools)) {
      await assert.rejects(tool.execute({}), error => error === fixture.denied);
    }
    assert.equal(fixture.calls(), 0);
    assert.deepEqual(result.requiredFollowups(), []);
    if(scope==='platform')assert.throws(()=>result.observeSourceEvidence({}));
    else result.observeSourceEvidence({});
    result.observeRuntimeEvidence({});
    for (const tool of Object.values(result.tools)) {
      const constraint = tool.parameters.properties?.project_id;
      if (constraint?.enum) assert.deepEqual(constraint.enum, scope === 'platform' ? [] : [projectId]);
    }
  });
}
