import { validateInvestigationEvidence } from './session-context.mjs';

// Capture the first reporter-scoped observation before a model outage can stop the run.
// Pagination remains available to the investigator through the unchanged evidence payload.
export async function collectInitialObservation({ tools, policy, runBinding, priorEvidence = [],
  resumeSession, pendingAnswer, authorize, onCheckpoint, signal }) {
  if (resumeSession || pendingAnswer || priorEvidence.some(item =>
    validateInvestigationEvidence(item, runBinding).source === 'query_client_errors')) return;
  const tool = tools.query_client_errors;
  if (!tool) throw Object.assign(new Error('investigation_initial_source_missing'), {code:'investigation_initial_source_missing'});
  const args = {start_at:policy.allowedStartAt, end_at:policy.allowedEndAt};
  signal?.throwIfAborted();
  await authorize();
  const output = await tool.execute(args, {signal});
  await authorize();
  signal?.throwIfAborted();
  const evidence = validateInvestigationEvidence(output, runBinding);
  await onCheckpoint({phase:'tool_completed', origin:'initial_observation', step:0,
    toolCalls:[{name:'query_client_errors',args}], results:[{name:'query_client_errors',result:{output:evidence}}]});
}
