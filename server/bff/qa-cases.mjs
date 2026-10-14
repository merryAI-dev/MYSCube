import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { createHttpError } from "./bff-utils.mjs";
import { buildRequestFingerprint } from "./utils.mjs";
import {
  QA_PROJECT_ID,
  requireQaProjectGrant,
  qaPlatformScope,
  qaProjectScope,
} from "./qa-scope.mjs";
import { candidateHash } from "../qa-shared/candidate-integrity.mjs";

const prefix = "/api/v1/qa-cases";
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const qaCaseIdSchema = z.string().uuid();
export const qaCaseInputSchema = z
  .object({
    platform_key: z.literal("myscube"),
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(4000),
    investigation_target: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("platform") }).strict(),
        z
          .object({
            kind: z.literal("project"),
            project_id: z.string().regex(QA_PROJECT_ID),
          })
          .strict(),
      ])
      .optional(),
    reported_context: z
      .object({
        claimed_session_id: identifier.optional(),
        claimed_request_id: identifier.optional(),
        claimed_release_sha: z
          .string()
          .regex(/^[a-f0-9]{40}$/)
          .optional(),
        reported_window_start_at: z.iso.datetime({ offset: true }).optional(),
        reported_window_end_at: z.iso.datetime({ offset: true }).optional(),
      })
      .strict()
      .refine((value) => {
        const start = value.reported_window_start_at;
        const end = value.reported_window_end_at;
        return (
          (!start && !end) ||
          (!!start &&
            !!end &&
            Date.parse(start) <= Date.parse(end) &&
            Date.parse(end) - Date.parse(start) <= 24 * 60 * 60 * 1000)
        );
      }, "Report a complete time window no longer than 24 hours")
      .default({}),
  })
  .strict();

export const qaCaseOutputSchema = z
  .object({
    case_id: qaCaseIdSchema,
    aggregate_version: z.number().int().positive().optional(),
    platform_key: z.literal("myscube"),
    title: z.string().min(1).max(160),
    case_status: z.string().min(1),
    execution_status: z.string().min(1),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
    progress: z
      .object({
        stage: z.enum([
          "preparing",
          "observation",
          "code",
          "logs",
          "state",
          "deployment",
          "writer",
          "evidence_review",
          "resume_pending",
        ]),
        session_count: z.number().int().min(0).max(1000000),
        evidence_count: z.number().int().min(0).max(1000000),
      })
      .strict()
      .optional(),
  })
  .strict();

export const qaCaseActivitySchema = z
  .object({
    schema_version: z.literal(1),
    activity_id: z.string().regex(/^[0-9]{10}$/),
    activity_type: z.literal("case_received"),
    case_id: qaCaseIdSchema,
    aggregate_version: z.number().int().positive().max(9999999999),
    event_id: z.string().uuid(),
    occurred_at: z.iso.datetime({ offset: true }),
    case_status: z.string().min(1),
    execution_status: z.string().min(1),
  })
  .strict();

export const qaCaseActivityOutputSchema = z
  .object({
    case_id: qaCaseIdSchema,
    activities: z.array(qaCaseActivitySchema).max(50),
    truncated: z.boolean(),
    coverage: z.enum(["recorded", "not_recorded"]),
  })
  .strict();
const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(50),
    cursor: qaCaseIdSchema.optional(),
  })
  .strict();

function activityUnavailable() {
  return createHttpError(
    500,
    "접수 이력을 확인할 수 없습니다.",
    "qa_activity_invalid",
  );
}

function parse(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw createHttpError(
      400,
      "QA 제목·내용과 발생 시각 범위를 확인해 주세요.",
      "qa_case_invalid",
    );
  return parsed.data;
}

export async function requireQaMember(tx, db, context) {
  // This API never accepts development identity headers as authentication.
  if (context.authSource !== "firebase")
    throw createHttpError(401, "로그인이 필요합니다.", "qa_auth_required");
  const member = (
    await tx.get(db.doc(`orgs/${context.tenantId}/members/${context.actorId}`))
  ).data();
  // Preserve the existing BFF contract for legacy members without a status field.
  if (
    !member ||
    (Object.hasOwn(member, "status") && member.status !== "ACTIVE")
  ) {
    throw createHttpError(
      403,
      "활성 조직 멤버만 이용할 수 있습니다.",
      "member_inactive",
    );
  }
}

function publicCase(value) {
  return qaCaseOutputSchema.parse({
    case_id: value.case_id,
    ...(Number.isSafeInteger(value.aggregate_version) ? { aggregate_version: value.aggregate_version } : {}),
    platform_key: value.platform_key,
    title: value.title,
    case_status: value.case_status,
    execution_status: value.execution_status,
    created_at: value.created_at,
    updated_at: value.updated_at,
  });
}

function publicRunProgress(run) {
  const stage = run.current_stage ?? "preparing";
  const sessionCount = run.session_count ?? run.metrics?.session_count ?? 0;
  const evidenceCount = run.evidence_count ?? 0;
  const parsed = qaCaseOutputSchema.shape.progress.unwrap().safeParse({
    stage,
    session_count: sessionCount,
    evidence_count: evidenceCount,
  });
  return parsed.success ? parsed.data : null;
}

async function publicCaseWithRun(tx, db, context, qa, now) {
  const original = publicCase(qa);
  if (
    qa.case_status === "cancelled" ||
    ["cancelled", "completed", "needs_review", "failed"].includes(
      qa.execution_status,
    ) ||
    !qaCaseIdSchema.safeParse(qa.investigation_event_id).success ||
    !Number.isSafeInteger(qa.aggregate_version) ||
    qa.aggregate_version < 1 ||
    qa.workspace_id !== context.tenantId ||
    qa.actor_id !== context.actorId ||
    !qa.investigation_scope
  )
    return original;
  const eventId = qa.investigation_event_id;
  const dispatch = (
    await tx.get(db.doc(`orgs/${context.tenantId}/qa_dispatches/${eventId}`))
  ).data();
  const runId = `qa-${eventId}`;
  if (
    !dispatch ||
    dispatch.status !== "launched" ||
    dispatch.event_id !== eventId ||
    dispatch.dispatch_id !== eventId ||
    dispatch.case_id !== qa.case_id ||
    dispatch.workspace_id !== context.tenantId ||
    dispatch.run_id !== runId ||
    !Number.isSafeInteger(dispatch.task_generation) ||
    dispatch.task_generation < 0 ||
    (dispatch.aggregate_version ?? 1) !== qa.aggregate_version
  )
    return original;
  const run = (
    await tx.get(db.doc(`orgs/${context.tenantId}/qa_runs/${runId}`))
  ).data();
  if (
    !run ||
    run.source !== "authenticated_case" ||
    run.run_id !== runId ||
    run.dispatch_id !== eventId ||
    run.case_id !== qa.case_id ||
    run.tenant_id !== context.tenantId ||
    run.case_actor_id !== context.actorId ||
    run.case_aggregate_version !== qa.aggregate_version ||
    run.case_input_hash !==
      candidateHash({
        actor_id: qa.actor_id,
        aggregate_version: qa.aggregate_version,
        title: qa.title,
        description: qa.description,
        investigation_scope: qa.investigation_scope,
      })
  )
    return original;
  if (run.status === "running") {
    // A recovered dispatch may already have launched a later task while the
    // previous run still says running. The investigator persists resumed_at on
    // lease reacquisition; execution_name and operation_name are different IDs.
    if (dispatch.task_generation > 0) {
      const resumed = Date.parse(run.resumed_at || run.created_at);
      const recovered = Date.parse(dispatch.recovery_observed_at);
      if (
        !Number.isFinite(resumed) ||
        !Number.isFinite(recovered) ||
        resumed <= recovered
      )
        return original;
    }
    if (
      typeof run.lease_owner !== "string" ||
      !run.lease_owner ||
      !Number.isFinite(Date.parse(run.lease_expires_at)) ||
      Date.parse(run.lease_expires_at) <= new Date(now()).getTime()
    )
      return original;
    const progress = publicRunProgress(run);
    return qaCaseOutputSchema.parse({
      ...original,
      execution_status: "running",
      ...(progress ? { progress } : {}),
    });
  }
  // Only the authorized terminal projector may change owner-visible terminal state.
  return original;
}

export function createQaCaseService({
  db,
  idempotencyService,
  now = () => new Date().toISOString(),
}) {
  return {
    async list(context, query = {}) {
      const input = listQuerySchema.safeParse(query);
      if (!input.success)
        throw createHttpError(
          400,
          "QA 목록 범위를 확인해 주세요.",
          "qa_case_list_invalid",
        );
      return db.runTransaction(async (tx) => {
        await requireQaMember(tx, db, context);
        let cases = db
          .collection(`orgs/${context.tenantId}/qa_cases`)
          .where("actor_id", "==", context.actorId)
          .orderBy("__name__");
        if (input.data.cursor) cases = cases.startAfter(input.data.cursor);
        const snapshot = await tx.get(cases.limit(input.data.limit + 1));
        const page = snapshot.docs.slice(0, input.data.limit);
        const items = [];
        for (const doc of page)
          items.push(await publicCaseWithRun(tx, db, context, doc.data(), now));
        return {
          items,
          next_cursor:
            snapshot.docs.length > input.data.limit ? page.at(-1).id : null,
        };
      });
    },
    async create(context, input) {
      const body = parse(qaCaseInputSchema, input);
      const key = parse(z.string().min(1).max(200), context.idempotencyKey);
      const fingerprint = buildRequestFingerprint({
        method: "POST",
        path: prefix,
        body,
      });
      const case_id = randomUUID();
      const event_id = randomUUID();
      const base = `orgs/${context.tenantId}`;
      return db.runTransaction(async (tx) => {
        await requireQaMember(tx, db, context);
        const link = (
          await tx.get(
            db.doc(
              `orgs/${context.tenantId}/qa_actor_business_links/${context.actorId}`,
            ),
          )
        ).data();
        if (
          !link ||
          link.status !== "ACTIVE" ||
          link.qa_actor_id !== context.actorId ||
          link.source !== "dual_firebase_tokens"
        )
          throw createHttpError(
            403,
            "실제 사업 계정을 연결한 뒤 QA를 접수해 주세요.",
            "qa_identity_link_required",
          );
        const at = new Date(now());
        const scope =
          body.investigation_target?.kind === "project"
            ? qaProjectScope(
                context.tenantId,
                body.investigation_target.project_id,
                await requireQaProjectGrant(tx, db, {
                  tenantId: context.tenantId,
                  actorId: context.actorId,
                  projectId: body.investigation_target.project_id,
                  at: at.toISOString(),
                }),
              )
            : qaPlatformScope(context.tenantId);
        const lock = await idempotencyService.checkInTransaction(tx, {
          tenantId: context.tenantId,
          actorId: context.actorId,
          idempotencyKey: key,
          requestFingerprint: fingerprint,
          nowDate: at,
        });
        if (lock.mode === "replay")
          return {
            status: lock.status,
            body: publicCase(lock.body),
            replayed: true,
          };
        if (lock.mode !== "started")
          throw createHttpError(
            409,
            "같은 요청 키가 이미 사용 중이거나 다른 요청에 사용되었습니다.",
            `idempotency_${lock.mode}`,
          );
        const timestamp = at.toISOString();
        const value = {
          ...body,
          case_id,
          workspace_id: context.tenantId,
          actor_id: context.actorId,
          case_type: "bug",
          case_status: "received",
          execution_status: "queued",
          aggregate_version: 1,
          correlation_status: "unverified",
          investigation_event_id: event_id,
          investigation_scope: scope,
          created_at: timestamp,
          updated_at: timestamp,
        };
        const response = publicCase(value);
        tx.create(db.doc(`${base}/qa_cases/${case_id}`), value);
        const activity = qaCaseActivitySchema.parse({
          schema_version: 1,
          activity_id: "0000000001",
          activity_type: "case_received",
          case_id,
          aggregate_version: 1,
          event_id,
          occurred_at: timestamp,
          case_status: value.case_status,
          execution_status: value.execution_status,
        });
        tx.create(
          db.doc(
            `${base}/qa_cases/${case_id}/activity/${activity.activity_id}`,
          ),
          activity,
        );
        // Separate from the legacy notification outbox. No free text or log payloads.
        tx.create(db.doc(`${base}/qa_kafka_outbox/${event_id}`), {
          event_id,
          schema_version: 1,
          event_type: "qa.investigation.requested",
          workspace_id: context.tenantId,
          case_id,
          aggregate_type: "qa_case",
          aggregate_id: case_id,
          aggregate_version: 1,
          partition_key: `${context.tenantId}:${case_id}`,
          occurred_at: timestamp,
          delivery_status: "intent_saved",
          attempt_count: 0,
        });
        idempotencyService.completeInTransaction(tx, {
          ref: lock.ref,
          tenantId: context.tenantId,
          actorId: context.actorId,
          idempotencyKey: key,
          requestFingerprint: fingerprint,
          requestId: context.requestId,
          method: "POST",
          path: prefix,
          responseStatus: 201,
          responseBody: response,
          nowDate: at,
          ttlSeconds: 86400,
        });
        return { status: 201, body: response, replayed: false };
      });
    },
    async activity(context, id) {
      const case_id = parse(qaCaseIdSchema, id);
      const parent = db.doc(`orgs/${context.tenantId}/qa_cases/${case_id}`);
      return db.runTransaction(async (tx) => {
        await requireQaMember(tx, db, context);
        const value = (await tx.get(parent)).data();
        if (!value || value.actor_id !== context.actorId) {
          throw createHttpError(
            404,
            "QA 접수를 찾을 수 없습니다.",
            "qa_case_not_found",
          );
        }
        if (
          value.case_id !== case_id ||
          !Number.isSafeInteger(value.aggregate_version) ||
          value.aggregate_version < 1
        ) {
          throw activityUnavailable();
        }
        const snapshot = await tx.get(
          parent
            .collection("activity")
            .orderBy("aggregate_version", "desc")
            .limit(51),
        );
        const records = snapshot.docs.map((doc) => {
          const parsed = qaCaseActivitySchema.safeParse(doc.data());
          if (!parsed.success) throw activityUnavailable();
          const item = parsed.data;
          if (
            item.case_id !== case_id ||
            item.activity_id !== doc.id ||
            item.activity_id !==
              String(item.aggregate_version).padStart(10, "0") ||
            item.aggregate_version > value.aggregate_version
          )
            throw activityUnavailable();
          return item;
        });
        return qaCaseActivityOutputSchema.parse({
          case_id,
          activities: records.slice(0, 50).reverse(),
          truncated: records.length > 50,
          coverage: records.length ? "recorded" : "not_recorded",
        });
      });
    },
    async get(context, id) {
      const case_id = parse(qaCaseIdSchema, id);
      return db.runTransaction(async (tx) => {
        await requireQaMember(tx, db, context);
        const value = (
          await tx.get(db.doc(`orgs/${context.tenantId}/qa_cases/${case_id}`))
        ).data();
        if (!value || value.actor_id !== context.actorId)
          throw createHttpError(
            404,
            "QA 접수를 찾을 수 없습니다.",
            "qa_case_not_found",
          );
        return publicCaseWithRun(tx, db, context, value, now);
      });
    },
  };
}

export function mountQaCaseRoutes(
  app,
  { db, now, asyncHandler, idempotencyService },
) {
  const service = createQaCaseService({ db, now, idempotencyService });
  app.get(
    prefix,
    asyncHandler(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(await service.list(req.context, req.query));
    }),
  );
  app.post(
    prefix,
    asyncHandler(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const result = await service.create(req.context, req.body);
      if (result.replayed) res.setHeader("x-idempotency-replayed", "1");
      res.status(result.status).json(result.body);
    }),
  );
  app.get(
    `${prefix}/:id/activity`,
    asyncHandler(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(await service.activity(req.context, req.params.id));
    }),
  );
  app.get(
    `${prefix}/:id`,
    asyncHandler(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(await service.get(req.context, req.params.id));
    }),
  );
}
