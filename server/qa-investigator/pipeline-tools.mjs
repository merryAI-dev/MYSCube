import { createDiscoveredProjectTools } from './discovered-project-tools.mjs';
import { createRequestDiagnosticTools } from './request-diagnostic-tools.mjs';
import { createReporterOperationTools } from './reporter-operation-tools.mjs';
import { createRevisionResolver } from './revision-resolver.mjs';
import { createLiveSourceTools } from "./live-source-tools.mjs";
import { createCloudDeploymentTools } from "./cloud-deployment-tools.mjs";
import { createSlackHistoryTools } from "./slack-history-tools.mjs";
import { createSheetSourceTools } from "./sheet-source-tools.mjs";
import { createRuntimeTraceTools } from "./runtime-trace-tools.mjs";
import { createMonthCloseApprovalTools } from "./month-close-approval-tools.mjs";
import { readFile } from 'node:fs/promises';
import { GoogleAuth } from 'google-auth-library';
import { createInvestigationTools } from './tools.mjs';

// Shared source construction preserves the same policy and evidence observers across transports.
export async function createPipelineInvestigationTools({
  pipeline, request, auth, priorEvidence = [], runBinding, env = process.env, labelContract,
}) {
  let tools, dependencyResolvers, observeSourceEvidence, observeRuntimeEvidence, requiredFollowups;
  const paths = [
    "src/app/components/cashflow/CashflowProjectSheet.tsx",
    "server/bff/routes/cashflow-sheet-lab.mjs",
    "server/bff/cashflow-sheet-template.mjs",
    "server/bff/cashflow-coordinates.mjs",
    "policies/cashflow-policy.json",
    "server/bff/java-weekly-client.mjs",
    "server/bff/routes/jvm-weekly-api.mjs",
    "server/bff/app.mjs",
  ];
  let live;
  let requestDiagnostics;
  let discovered;
  const cloudDeployment = createCloudDeploymentTools({ auth, policy: request.policy,
    diagnosticRevisionAnchors: evidence => requestDiagnostics?.revisionAnchors(evidence) || [],
    diagnosticsReady: () => Boolean(requestDiagnostics) && requestDiagnostics.requiredFollowups().length === 0,
  });
  const resolveDeployedRevision = createRevisionResolver({
    priorEvidence,
    readWeb: (args, options) => live.read_live_vercel_deployment.execute(args, options),
    readJvm: (args, options) => cloudDeployment.read_live_jvm_deployment.execute(args, options),
  });
  live = createLiveSourceTools({
    policy: {
      repository: "MYSCube",
      scopeKind: request.policy.scopeKind,
      trustedActorId: request.policy.trustedActorId,
      allowedPaths: paths,
      allowedProjectIds: request.policy.allowedProjectIds,
      allowedSourceRoots: [
        "src/",
        "server/",
        "policies/",
        "api/",
        "scripts/",
        ".github/workflows/",
      ],
      allowedRequestPaths: request.policy.scopeKind === 'platform' ? [] : request.policy.allowedProjectIds.flatMap((id) => [
        ...[
          "month-close",
          "month-close/preview",
          "month-close/submit",
          "month-close/requests",
          "month-close/approver",
          "month-close/reopen-request",
          "month-close/reopen-decision",
          "dashboard-source",
        ].map((path) => `/api/v1/cashflow/${id}/${path}`),
        ...["mirror", "mirror/refresh", "stage", "apply"].map(
          (path) => `/api/v1/projects/${id}/cashflow-sheet-lab/${path}`,
        ),
      ]),
      allowedRequestIds: request.report.server_context.reported_request_id
        ? [request.report.server_context.reported_request_id]
        : [],
      startAt: request.policy.allowedStartAt,
      endAt: request.policy.allowedEndAt,
    },
    github: {
      publicRepository: env.QA_GITHUB_PUBLIC_SOURCE === 'true',
      tokenPath: env.QA_GITHUB_TOKEN_FILE,
      appId: env.QA_GITHUB_APP_ID,
      installationId: env.QA_GITHUB_INSTALLATION_ID,
      privateKeyPath: env.QA_GITHUB_PRIVATE_KEY_FILE,
    },
    vercel: {
      teamId: "team_A7cbzLIfAhnrz35sykcSyM5L",
      projectId: "prj_aYK7ibY0SrmbuGpRPVz2PAl0Ioq0",
      tokenPath: env.QA_VERCEL_TOKEN_FILE,
    },
    resolveDeployedRevision,
  });
  observeSourceEvidence = (evidence) => {
    live.observeEvidence(evidence);
    discovered?.observeEvidence(evidence);
    cloudDeployment.observeEvidence(evidence);
  };
  for (const evidence of priorEvidence) observeSourceEvidence(evidence);
  const slackHistory = pipeline.slackHistory
    ? createSlackHistoryTools({
        policy: pipeline.slackHistory,
        tokenPath: env.QA_SLACK_HISTORY_BOT_TOKEN_FILE,
        threadUserTokenPath: env.QA_SLACK_HISTORY_USER_TOKEN_FILE,
        threadUserId: env.QA_SLACK_HISTORY_USER_ID,
        authorize: () => pipeline.authorizeSlackHistory(),
      })
    : {};
  labelContract ??= JSON.parse(
    await readFile(
      new URL("./sheet-label-contract.json", import.meta.url),
      "utf8",
    ),
  );
  const hasProjects = request.policy.scopeKind !== "platform";
  const sheetSource = hasProjects
    ? createSheetSourceTools({
        policy: request.policy,
        firestoreAuth: auth,
        sheetsAuth: new GoogleAuth({
          scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
        }),
        authorize: () => pipeline.authorize(),
        labelContract,
      })
    : {};
  const traceSource = hasProjects
    ? createRuntimeTraceTools({
        auth,
        policy: request.policy,
      })
    : { tools: {}, observeEvidence() {} };
  requestDiagnostics = createRequestDiagnosticTools({
    auth, policy: request.policy, authorize: () => pipeline.authorize(),
    requestLogAnchors: evidence => live.requestLogAnchors(evidence),
  });
  requiredFollowups = () => [...live.requiredFollowups(), ...requestDiagnostics.requiredFollowups()];
  const operationSource = createReporterOperationTools({
    auth, policy: request.policy, authorize: () => pipeline.authorize(), runBinding,
  });
  observeRuntimeEvidence = (evidence) => {
    traceSource.observeEvidence(evidence);
    requestDiagnostics.observeEvidence(evidence);
    cloudDeployment.observeEvidence(evidence);
    operationSource.observeEvidence(evidence);
  };
  for (const evidence of priorEvidence) observeRuntimeEvidence(evidence);
  if(!hasProjects) {
    discovered=createDiscoveredProjectTools({runBinding,
      requestLogAnchors: evidence=>live.requestLogAnchors(evidence),
      authorizeProject: projectId=>pipeline.authorizeProject(projectId),
      createSources(projectId,authorize) {
        const policy={...request.policy,scopeKind:'project',allowedProjectIds:[projectId]};
        const trace=createRuntimeTraceTools({auth,policy});
        return {tools:{
          ...createInvestigationTools({auth,policy,allowDynamicScope:true}),
          ...createSheetSourceTools({policy,firestoreAuth:auth,
            sheetsAuth:new GoogleAuth({scopes:['https://www.googleapis.com/auth/spreadsheets.readonly']}),authorize,labelContract}),
          ...createMonthCloseApprovalTools({auth,policy,authorize}),
          ...trace.tools,
        },observeEvidence:trace.observeEvidence};
      },
    });
    for(const evidence of priorEvidence)discovered.observeEvidence(evidence);
  }
  const raw = {
    ...(hasProjects
      ? createMonthCloseApprovalTools({
          auth,
          policy: request.policy,
          authorize: () => pipeline.authorize(),
        })
      : {}),
    ...slackHistory,
    ...sheetSource,
    ...traceSource.tools,
    ...requestDiagnostics.tools,
    ...operationSource,
    ...createInvestigationTools({
      auth,
      policy: request.policy,
      allowDynamicScope: true,
    }),
    ...cloudDeployment,
    ...live,
    ...discovered?.tools,
  };
  dependencyResolvers = Object.fromEntries(
    Object.entries(raw)
      .filter(([, tool]) => typeof tool.blockedBy === "function")
      .map(([name, tool]) => [name, tool.blockedBy]),
  );
  tools = Object.fromEntries(
    Object.entries(raw).map(([name, tool]) => [
      name,
      {
        ...tool,
        execute: async (args, options) => {
          await pipeline.authorize();
          return tool.execute(args, options);
        },
      },
    ]),
  );
  return { tools, dependencyResolvers, observeSourceEvidence, observeRuntimeEvidence, requiredFollowups };
}
