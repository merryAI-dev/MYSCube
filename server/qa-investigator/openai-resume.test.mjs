import assert from 'node:assert/strict';
import { runOpenAIInvestigation } from './openai-agent.mjs';
const answer = {
  facts: [],
  hypotheses: [],
  unknowns: ['historical state unknown'],
  user_reply: '확인되지 않았습니다.',
  next_actions: [],
  cause_status: 'not_established',
};
const prior = [
  {
    evidence_id: 'ev_' + 'a'.repeat(64),
    source: 'read_project_state',
    status: 'available',
    rows: [],
  },
];
let count = 0,
  authorized = 0;
const events = [];
globalThis.fetch = async (_, options) => {
  count++;
  const body = JSON.parse(options.body);
  const context = JSON.parse(body.input[0].content);
  assert.deepEqual(context.prior_observations, prior);
  assert.equal(JSON.stringify(body.input).includes('encrypted_content'), false);
  return Response.json({
    status: 'completed',
    output: [
      {
        type: 'function_call',
        call_id: 'next',
        name: 'finalize_investigation',
        arguments: JSON.stringify(answer),
      },
    ],
  });
};
await runOpenAIInvestigation({
  apiKey: 'mock',
  model: 'test',
  report: {},
  tools: {},
  priorEvidence: prior,
  startStep: 45,
  beforeStep: async () => authorized++,
  onCheckpoint: async (e) => events.push(e),
  validateAnswer: async () => ({ accepted: true }),
});
assert.equal(authorized, 1);
assert.equal(count, 1);
assert.equal(events[0].step, 45);
assert.equal(events.find((e) => e.phase === 'tools_requested').step, 46);
globalThis.fetch = async () =>
  assert.fail('revoked authority must not call provider');
await assert.rejects(
  runOpenAIInvestigation({
    apiKey: 'mock',
    model: 'test',
    report: {},
    tools: {},
    beforeStep: async () => {
      throw Error('revoked');
    },
    onCheckpoint: async () => {},
    validateAnswer: async () => ({ accepted: true }),
  }),
  /revoked/
);
console.log(
  JSON.stringify({ checks: 2, status: 'passed', actual_api_called: false })
);
