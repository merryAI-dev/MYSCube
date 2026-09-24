import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import { ACCEPTANCE_SUITE, ACCEPTANCE_CASES, EVALUATION_PRESETS, buildEvaluationDatasets } from './acceptance-cases.mjs';
import { createAnalyticsService } from '../analytics-service.mjs';
import { createHtmlCompletion } from '../html-completion.mjs';
import { runConversationTurn } from '../conversation-agent.mjs';
import { generateReactPage } from '../react-pages.mjs';
import { validateReactScreenBindings } from '../react-screen-bindings.mjs';
import { createRemoteRuntimeBroker } from '../remote-runtime/broker.mjs';
import { resolveApiPlan, validateApiInput } from '../registered-apis.mjs';
import { REMOTE_RUNTIME_IMAGE } from '../remote-runtime/contract.mjs';
import { readEvaluationManifest, verifyEvaluationManifest } from './manifest.mjs';

const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeError = (error) => ({ code: typeof error?.code === 'string' && /^[a-zA-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'evaluation_failed', message: error?.expose ? String(error.message).slice(0, 1000) : '평가 단계를 완료하지 못했습니다. 비밀값을 포함할 수 있는 원문 오류는 기록하지 않았습니다.',
  ...(Number.isInteger(error?.providerStatus) ? { providerStatus: error.providerStatus } : {}),
  ...(['countTokens', 'generateContent'].includes(error?.providerStage) ? { providerStage: error.providerStage } : {}),
  ...(/^[A-Z_]{1,40}$/.test(error?.providerFinishReason || '') ? { providerFinishReason: error.providerFinishReason } : {}),
  ...(['no_function_call', 'multiple_function_calls', 'unknown_function', 'malformed_response'].includes(error?.providerActionReason) ? { providerActionReason: error.providerActionReason } : {}),
  ...(Number.isInteger(error?.providerCallCount) && error.providerCallCount >= 0 && error.providerCallCount <= 100 ? { providerCallCount: error.providerCallCount } : {}),
  ...(typeof error?.providerHasText === 'boolean' ? { providerHasText: error.providerHasText } : {}) });

export async function runAcceptance({ db, complete, outputDirectory, sourceSha, model, executionManifest = null, spawnDocker, now = () => ACCEPTANCE_SUITE.clock, render = true }) {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const report = { suite: ACCEPTANCE_SUITE, suiteHash: digest(ACCEPTANCE_CASES), runId, sourceSha, model, startedAt,
    environment: { model: executionManifest ? 'actual configured model' : 'fixture harness validation', database: db.projectId, syntheticDataOnly: true, renderer: render ? 'Docker' : 'disabled' }, executionManifest,
    actualUserAuthentication: false, productionBusinessReads: 0, productionBusinessWrites: 0, caseResults: [], status: 'review_required' };
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const write = async () => writeFile(resolve(outputDirectory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await write();
  for (const scenario of ACCEPTANCE_CASES) {
    const tenantId = `c4-eval-${runId}-${scenario.id}`;
    const allowedIds = scenario.allowedDatasetIds || ['weekly_submission', 'cashflow_inflow'];
    const context = { tenantId, actorId: 'synthetic-c4', actorRole: 'admin', analyticsScope: { datasetIds: allowedIds, fingerprint: digest([runId, scenario.id, allowedIds]) } };
    await db.doc(`orgs/${tenantId}`).create({ evaluationOnly: true, runId, caseId: scenario.id, createdAt: startedAt, sourceSha, expiresAfterReview: true });
    const analytics = createAnalyticsService({ db, now });
    for (const dataset of buildEvaluationDatasets(scenario.fixture)) if (allowedIds.includes(dataset.datasetId)) await analytics.importDataset(context, dataset);
    const preset = EVALUATION_PRESETS[scenario.apiPreset];
    const apis = preset ? [{ id: '11111111-1111-4111-8111-111111111111', version: 1, ...preset.definition, responseKind: preset.definition.kind }] : [];
    const currentSource = EVALUATION_PRESETS[scenario.editorPreset] || EVALUATION_PRESETS['counter-layout'];
    let workContext = {}, pendingClarification = null;
    const history = [];
    const caseReport = { id: scenario.id, expected: scenario.turns.map((turn) => turn.expected), tenantId, turns: [], executionStatus: 'running' };
    report.caseResults.push(caseReport);
    for (const [index, turn] of scenario.turns.entries()) {
      const trace = [], queries = [], runtimeCalls = [], stages = [];
      const start = performance.now();
      const signal = AbortSignal.timeout(110000);
      const authorize = async () => signal.throwIfAborted();
      const measuredComplete = async (args) => {
        const result = await complete(args);
        trace.push(...result.tool_calls.map((call) => ({ name: call.function.name, arguments: JSON.parse(call.function.arguments) })));
        return result;
      };
      const observedAnalytics = { ...analytics, queryPlan: async (...args) => {
        const result = await analytics.queryPlan(...args); queries.push(result); return result;
      } };
      let broker;
      try {
        const result = await runConversationTurn({ context, message: turn.message, history, workContext, pendingClarification, currentSource,
          complete: measuredComplete, analytics: observedAnalytics, authorize, signal, now, registeredApis: apis,
          qa: async () => {
            const { source, errorCode, releaseSha, message: logMessage } = EVALUATION_PRESETS['injected-log'];
            return { facts: [JSON.stringify({ source, errorCode, releaseSha, message: logMessage })], coverage: { productionObserved: false, exactRevisionAvailable: false } };
          },
          screenBuilder: async ({ request, purpose, bindings, evidence, businessContext }) => {
            const checked = purpose === 'connected' ? validateReactScreenBindings({ bindings, evidence, apis, catalog: await analytics.catalog(context) }) : [];
            return generateReactPage({ complete: measuredComplete, prompt: request, currentSource, apis, history, pendingClarification,
              businessContext: { ...businessContext, screenBindings: checked, purpose }, signal, authorize, onStage: (stage) => stages.push(stage) });
          },
        });
        const { artifact, ...publicResult } = result;
        const turnReport = { index, message: turn.message, trace, queries, result: publicResult, stages, runtimeCalls, elapsedMs: Math.round(performance.now() - start) };
        if (result.source && artifact && render) {
          broker = createRemoteRuntimeBroker({ authorize, spawnDocker, callApi: async (_context, { apiId, apiVersion, input, signal: apiSignal }) => {
            const api = apis.find((item) => item.id === apiId && item.version === apiVersion);
            if (!api) throw Object.assign(new Error('Unselected evaluation API'), { code: 'evaluation_api_forbidden', statusCode: 403 });
            validateApiInput(api.parameters, input);
            const evidence = await analytics.queryPlan(context, resolveApiPlan(api.plan, input), { signal: apiSignal });
            runtimeCalls.push({ apiId, apiVersion, input, evidence });
            return { apiId, apiVersion, evidenceId: evidence.evidenceId, columns: evidence.columns, rows: evidence.rows, metadata: evidence.metadata, semantic: evidence.semantic, truncated: evidence.truncated };
          }, limits: { sessions: 1, actorSessions: 1 } });
          const session = await broker.create(context, { artifact, sourceHash: artifact.sourceHash, apiBindings: apis.map(({ id, version }) => ({ id, version })), viewport: { width: 1100, height: 700 } });
          if (turn.expected.runtimeApiInput) {
            const until = performance.now() + 10000;
            while (!runtimeCalls.length && performance.now() < until) { signal.throwIfAborted(); await pause(50); }
            if (!runtimeCalls.length) throw Object.assign(new Error('Initial API call not observed'), { code: 'evaluation_initial_api_missing' });
          }
          await pause(100);
          const first = await broker.frame(context, session.sessionId);
          await writeFile(resolve(outputDirectory, `${scenario.id}-${index}-initial.png`), Buffer.from(first.pngBase64, 'base64'));
          turnReport.runtime = { initialFrameHash: digest(first.pngBase64), actualApiCalls: runtimeCalls.length };
          if (turn.expected.runtimeBehavior) {
            await broker.event(context, session.sessionId, { type: 'key', key: 'Tab' });
            await broker.event(context, session.sessionId, { type: 'key', key: 'Enter' });
            const next = await broker.frame(context, session.sessionId);
            await writeFile(resolve(outputDirectory, `${scenario.id}-${index}-after-input.png`), Buffer.from(next.pngBase64, 'base64'));
            turnReport.runtime.afterInputFrameHash = digest(next.pngBase64);
          }
          await broker.close(context, session.sessionId);
        }
        workContext = result.context;
        pendingClarification = result.clarification || null;
        history.push({ role: 'user', content: turn.message }, { role: 'assistant', content: JSON.stringify(publicResult) });
        caseReport.turns.push(turnReport);
      } catch (error) {
        caseReport.turns.push({ index, message: turn.message, trace, queries, runtimeCalls, error: safeError(error), elapsedMs: Math.round(performance.now() - start) });
        caseReport.executionStatus = 'failed';
        break;
      } finally {
        if (broker) {
          broker.shutdown();
          const until = performance.now() + 5000;
          while (broker.reservedSessions && performance.now() < until) await pause(50);
          if (broker.reservedSessions) {
            caseReport.cleanupFailed = true;
            await write();
            throw Object.assign(new Error('Evaluation renderer cleanup did not finish'), { code: 'evaluation_cleanup_failed' });
          }
        }
      }
      await write();
    }
    if (caseReport.executionStatus !== 'failed') caseReport.executionStatus = 'executed';
    await write();
    process.stdout.write(`${JSON.stringify({ caseId: scenario.id, executionStatus: caseReport.executionStatus, turns: caseReport.turns.length })}\n`);
  }
  report.completedAt = new Date().toISOString();
  await write();
  return report;
}

async function main() {
  const env = process.env;
  if (env.WORKBENCH_REAL_MODEL_EVAL !== 'true' || env.WORKBENCH_PROJECT_ID !== 'myscube-axr-prod-20260924'
    || env.WORKBENCH_MODEL_PROJECT_ID !== 'myscube-axr-model-20260924' || !env.WORKBENCH_GEMINI_API_KEY
    || !/^[a-f0-9]{40}$/.test(env.WORKBENCH_EVAL_SOURCE_SHA || '') || !env.WORKBENCH_EVAL_MANIFEST || !process.argv[2]) throw new Error('evaluation_configuration_required');
  const manifest = await readEvaluationManifest({ file: env.WORKBENCH_EVAL_MANIFEST, expectedManifestSha256: env.WORKBENCH_EVAL_MANIFEST_SHA256 });
  await verifyEvaluationManifest({ directory: fileURLToPath(new URL('../../../', import.meta.url)), manifest,
    expectedManifestSha256: env.WORKBENCH_EVAL_MANIFEST_SHA256, expectedSourceSha: env.WORKBENCH_EVAL_SOURCE_SHA,
    expectedArchiveSha256: env.WORKBENCH_EVAL_ARCHIVE_SHA256, expectedRendererImageId: env.WORKBENCH_EVAL_RENDERER_IMAGE });
  const spawnDocker = (args) => {
    if (args[0] === 'run' && args.at(-1) !== REMOTE_RUNTIME_IMAGE) throw new Error('evaluation_renderer_command_invalid');
    const command = args[0] === 'run' ? [...args.slice(0, -1), manifest.renderer.id] : args;
    return spawn('docker', ['--host', 'unix:///var/run/docker.sock', ...command], { env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  };
  const db = new Firestore({ projectId: env.WORKBENCH_PROJECT_ID });
  const model = env.WORKBENCH_HTML_MODEL || 'gemini-3.6-flash';
  let calls = 0, totalTokens = 0;
  const complete = createHtmlCompletion({ apiKey: env.WORKBENCH_GEMINI_API_KEY, model, onUsage: async (usage) => {
    if (Number.isSafeInteger(usage.totalTokenCount)) totalTokens += usage.totalTokenCount;
  } });
  try {
    await runAcceptance({ db, model, executionManifest: manifest, spawnDocker, sourceSha: env.WORKBENCH_EVAL_SOURCE_SHA, outputDirectory: resolve(process.argv[2]), complete: async (args) => {
      if (++calls > 60 || totalTokens >= 700000) throw Object.assign(new Error('Evaluation budget reached'), { code: 'evaluation_budget_reached' });
      return complete(args);
    } });
  } finally {
    try { await writeFile(resolve(process.argv[2], 'usage.json'), JSON.stringify({ model, calls, totalTokens, maxCalls: 60, maxTokensBeforeNextCall: 700000 }, null, 2), { mode: 0o600 }); }
    finally { await db.terminate(); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${JSON.stringify(safeError(error))}\n`); process.exitCode = 1; });
}
