import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { verifyAgentTrace } from '../server/mcp/agent-trace.mjs';
import { HERMES_READ_TOOLS } from '../server/mcp/hermes-harness.mjs';

// Read-only production QA: credentials stay in memory; no messages or DB updates.
const args = process.argv.slice(2);
const harness = args.find((arg) => arg.startsWith('--harness='))?.slice(10) || 'hermes-readonly-v1';
const requiredTool = args.find((arg) => arg.startsWith('--tool='))?.slice(7);
assert(['hermes-readonly-v1', 'settlement-read-v2'].includes(harness));
assert(!requiredTool || HERMES_READ_TOOLS.includes(requiredTool));
assert(args.filter((arg) => arg.startsWith('--')).every((arg) => arg.startsWith('--harness=') || arg.startsWith('--tool=')));
const ids = args.filter((arg) => !arg.startsWith('--'));
assert(ids.length > 0 && ids.length <= 10 && ids.every((id) => /^[a-f0-9]{64}$/.test(id)), 'Supply 1–10 job hashes');
const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
const base = 'https://firestore.googleapis.com/v1/projects/inner-platform-live-20260316/databases/(default)/documents';
const decode = (value) => value?.mapValue ? Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, decode(item)]))
  : value?.arrayValue ? (value.arrayValue.values || []).map(decode)
  : value?.integerValue !== undefined ? Number(value.integerValue)
  : value?.doubleValue !== undefined ? value.doubleValue : value?.stringValue ?? value?.booleanValue ?? null;
const get = async (path) => {
  const response = await fetch(`${base}/${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  assert(response.ok, `Firestore read failed: ${response.status}`);
  return response.json();
};
for (const id of ids) {
  const job = decode({ mapValue: await get(`settlement_agent_jobs/${id}`) });
  assert.equal(job.teamId, 'T099F304GAY');
  assert.equal(job.channelId, 'C0BQ6980HR6');
  assert.equal(job.status, 'succeeded', 'Job must be delivered before verification');
  const documents = [];
  let cursor;
  do {
    const page = await get(`settlement_agent_jobs/${id}/trace?pageSize=100${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''}`);
    documents.push(...(page.documents || []));
    cursor = page.nextPageToken;
    assert(documents.length <= 500, 'Trace inspection bound exceeded');
  } while (cursor);
  const trace = documents.filter((doc) => doc.name.split('/').at(-1).startsWith(`${job.traceAnchor.leaseId}-`))
    .map((doc) => decode({ mapValue: doc })).sort((a, b) => a.sequence - b.sequence);
  assert(verifyAgentTrace(trace, job.traceAnchor), 'Trace hash chain failed');
  const events = trace.map((row) => row.event);
  assert.equal(events.find((event) => event.type === 'run_start')?.harness, harness, 'Wrong runner');
  assert.equal(events.findLast((event) => event.type === 'run_result')?.status, 'answered', 'Answer must be complete');
  const reviews = events.filter((event) => event.type === 'answer_review');
  assert(reviews.length && reviews.at(-1).review?.supported === true && reviews.at(-1).review?.addressesRequest === true, 'Final evidence review failed');
  assert(!events.some((event) => ['tool_failure', 'hermes_tool_failure', 'model_failure'].includes(event.type) || event.outcome === 'rejected'), 'Execution failure observed');
  const called = events.filter((event) => ['tool_result', 'hermes_tool_result'].includes(event.type)).map((event) => event.tool);
  assert(called.every((tool) => HERMES_READ_TOOLS.includes(tool)), 'Non-read tool observed');
  assert(events.filter((event) => event.tool).every((event) => HERMES_READ_TOOLS.includes(event.tool)), 'Non-read tool attempt observed');
  assert(!requiredTool || called.includes(requiredTool), 'Required evidence tool missing');
  const usage = [...events, ...(job.audit || [])].filter((event) => event.type === 'usage');
  const tokens = Object.fromEntries(['input', 'output', 'thinking'].map((key) => [key, usage.reduce((sum, event) => sum + (event[key] || 0), 0)]));
  console.log(JSON.stringify({ job: id, delivered: true, traceValid: true,
    harness: events.find((event) => event.type === 'run_start')?.harness,
    result: events.findLast((event) => event.type === 'run_result')?.status,
    called, callCount: called.length, tokens, reviews: reviews.map((event) => ({ supported: event.review?.supported, addressesRequest: event.review?.addressesRequest })),
    failureCount: events.filter((event) => ['tool_failure', 'hermes_tool_failure', 'model_failure'].includes(event.type)).length,
    note: 'No write capability was observed. This does not prove no concurrent external business changes occurred.' }));
}
