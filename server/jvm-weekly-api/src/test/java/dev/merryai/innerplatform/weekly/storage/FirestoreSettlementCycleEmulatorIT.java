package dev.merryai.innerplatform.weekly.storage;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.cloud.NoCredentials;
import com.google.cloud.firestore.DocumentSnapshot;
import com.google.cloud.firestore.Firestore;
import com.google.cloud.firestore.FirestoreOptions;
import com.google.cloud.firestore.QueryDocumentSnapshot;
import com.google.cloud.firestore.WriteBatch;
import dev.merryai.innerplatform.weekly.api.CashflowMonthCloseResponse;
import dev.merryai.innerplatform.weekly.api.CashflowSettlementCycleHeadMigrationResponse;
import dev.merryai.innerplatform.weekly.api.CashflowSettlementCycleCommandResponse;
import dev.merryai.innerplatform.weekly.api.CloseCashflowMonthRequest;
import dev.merryai.innerplatform.weekly.api.MigrateCashflowSettlementCycleHeadV2Request;
import dev.merryai.innerplatform.weekly.api.SubmitCashflowSettlementCycleRequest;
import dev.merryai.innerplatform.weekly.api.TransitionCashflowSettlementCycleRequest;
import dev.merryai.innerplatform.weekly.api.TrustedActorContext;
import dev.merryai.innerplatform.weekly.api.WeeklyExpenseConflictException;
import dev.merryai.innerplatform.weekly.domain.CashflowSettlementCycleWorkflow;
import dev.merryai.innerplatform.weekly.service.WeeklyExpenseAuthorizationService;
import dev.merryai.innerplatform.weekly.service.WeeklyExpenseCommandService;
import dev.merryai.innerplatform.weekly.service.WeeklyProjectExistenceRepository;
import dev.merryai.innerplatform.weekly.service.command.CashflowMonthReopenCommands;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;

import java.time.Clock;
import java.time.Instant;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;

/**
 * Real Firestore Emulator contract test for the canonical JVM settlement-cycle transaction path.
 *
 * <p>The class deliberately ends in {@code IT}, so the ordinary unit-test gate does not discover it.
 * Run it only through {@code scripts/test-settlement-cycle-emulator.sh}; that runner provides an
 * isolated demo project, a credential-free Firestore client, and an ephemeral emulator process.</p>
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class FirestoreSettlementCycleEmulatorIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DATA_PROJECT_ID = "demo-jvm-settlement-cycle-it";
    private static final String SOURCE_REVISION =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final Instant NOW = Instant.parse("2026-11-01T00:00:00Z");
    private static final List<String> CUMULATIVE_LINES = List.of(
        "MYSC_PREPAY_IN", "MYSC_PREPAY_LABOR_IN", "MYSC_PREPAY_INPUT_VAT_IN", "SALES_IN",
        "SALES_VAT_IN", "TEAM_SUPPORT_IN", "BANK_INTEREST_IN", "MYSC_PREPAY_DIRECT_OUT",
        "MYSC_PREPAY_LABOR_OUT", "DIRECT_COST_OUT", "INPUT_VAT_OUT", "MYSC_LABOR_OUT",
        "MYSC_PROFIT_OUT", "SALES_VAT_OUT", "TEAM_SUPPORT_OUT", "BANK_INTEREST_OUT"
    );
    private static final List<String> PROJECT_STATE_COLLECTIONS = List.of(
        "cashflow_month_close_requests",
        "cashflow_month_close_request_months",
        "cashflow_cumulative_close_heads",
        "monthly_closes",
        "monthly_close_versions",
        "cashflow_settlement_statuses",
        "cashflow_weekly_update_completions",
        "cashflow_weekly_update_completion_versions",
        "cashflow_weeks",
        "weekly_api_audit_events",
        "weekly_api_idempotency"
    );

    private Firestore db;

    @BeforeAll
    void connectToCredentialFreeDemoEmulator() {
        String emulatorHost = requiredEnvironment("FIRESTORE_EMULATOR_HOST");
        String projectId = requiredEnvironment("FIREBASE_PROJECT_ID");
        assertThat(projectId)
            .as("The integration harness must never point at a non-demo Firebase project")
            .startsWith("demo-");
        FirestoreOptions options = FirestoreOptions.newBuilder()
            .setProjectId(projectId)
            .setHost(emulatorHost)
            .setCredentials(NoCredentials.getInstance())
            .setEmulatorHost(emulatorHost)
            .build();
        assertThat(options.getHost()).isEqualTo(emulatorHost);
        assertThat(options.getEmulatorHost()).isEqualTo(emulatorHost);
        db = options.getService();
    }

    @AfterAll
    void closeEmulatorClient() throws Exception {
        if (db != null) db.close();
    }

    @Test
    @SuppressWarnings("unchecked")
    void fortyFourMonthCycleIsAtomicReplaySafeAndCanReopenResubmitAndReapprove() throws Exception {
        Harness harness = harness("it-cycle-44", "project-cycle-44");
        seedCanonicalActorsAndProject(harness);
        String cycleYearMonth = "2026-09";
        String targetYearMonth = "2026-08";
        String emptyTargetRevision = FirestoreInheritedWeeklyExpensePersistence
            .computeCashflowTargetRevision(List.of());
        Evidence firstEvidence = seedStagedEvidence(
            harness,
            cycleYearMonth,
            1,
            emptyTargetRevision,
            0,
            Map.of("stage-v1", "submit-v1")
        );
        Map<String, Object> previousCycle = new LinkedHashMap<>();
        previousCycle.put("tenantId", harness.tenantId());
        previousCycle.put("projectId", harness.projectId());
        previousCycle.put("yearMonth", targetYearMonth);
        previousCycle.put("periods", Map.of(
            "MONTH", Map.of("status", "COMPLETED", "revision", 2L)
        ));
        Map<String, Object> currentCycle = new LinkedHashMap<>();
        currentCycle.put("tenantId", harness.tenantId());
        currentCycle.put("projectId", harness.projectId());
        currentCycle.put("yearMonth", cycleYearMonth);
        currentCycle.put("periods", Map.of(
            "WEEK_2", Map.of("status", "COMPLETED", "revision", 2L)
        ));
        seedDocuments(Map.of(
            harness.settlementPath(targetYearMonth), previousCycle,
            harness.settlementPath(cycleYearMonth), currentCycle
        ));
        Map<String, Object> previousCycleBeforeSubmit = document(harness.settlementPath(targetYearMonth));
        Map<String, Object> currentWeekBeforeSubmit = nestedMap(nestedMap(
            document(harness.settlementPath(cycleYearMonth)).get("periods")
        ).get("WEEK_2"));

        CashflowSettlementCycleCommandResponse submitted = transaction(harness, () ->
            harness.service().submitCashflowSettlementCycle(
                harness.approver(), harness.projectId(),
                firstEvidence.submit("submit-v1", "stage-v1", 0)
            )
        );

        assertThat(submitted.businessState()).isEqualTo("SUBMITTED");
        assertThat(submitted.workflowRevision()).isEqualTo(1);
        assertThat(document(harness.requestPath())).containsEntry("status", "PENDING_APPROVAL");
        assertThat(document(harness.coordinatorPath()))
            .containsEntry("activeRequestId", firstEvidence.requestId())
            .containsEntry("activeState", "PENDING_APPROVAL")
            .containsEntry("workflowRevision", 1L);
        assertPeriod(harness, cycleYearMonth, "MONTH", "SUBMITTED");
        assertThat(document(harness.settlementPath(targetYearMonth))).isEqualTo(previousCycleBeforeSubmit);
        assertThat(nestedMap(nestedMap(document(harness.settlementPath(cycleYearMonth)).get("periods"))
            .get("WEEK_2"))).isEqualTo(currentWeekBeforeSubmit);
        assertCommandArtifacts(harness, WeeklyExpenseCommandService.SUBMIT_CASHFLOW_SETTLEMENT_CYCLE_COMMAND, 1);

        CashflowMonthCloseResponse firstApproval = transaction(harness, () ->
            harness.service().closeCashflowMonth(
                harness.approver(), harness.projectId(), null,
                firstEvidence.approval("approve-v1", 0, 1, "최초 44개월 catch-up 승인")
            )
        );

        assertThat(firstApproval.status()).isEqualTo("CLOSED");
        assertThat(firstApproval.revision()).isEqualTo(1);
        assertThat(firstApproval.headRevision()).isEqualTo(1);
        assertThat(document(harness.requestPath()))
            .containsEntry("status", "APPROVED")
            .containsEntry("workflowRevision", 2L);
        assertThat(document(harness.coordinatorPath()))
            .containsEntry("activeState", "INACTIVE")
            .containsEntry("workflowRevision", 2L);
        assertPeriod(harness, cycleYearMonth, "MONTH", "LOCKED");
        assertThat(document(harness.settlementPath(targetYearMonth))).isEqualTo(previousCycleBeforeSubmit);

        String firstVersionId = harness.projectId() + "-" + cycleYearMonth + "-r1";
        Map<String, Object> firstLedger = document(harness.monthlyClosePath());
        Map<String, Object> firstVersion = document(harness.monthlyCloseVersionPath(firstVersionId));
        Map<String, Object> firstSnapshot = nestedMap(firstVersion.get("snapshot"));
        Map<String, Object> firstHead = document(harness.headPath());
        Map<String, Object> firstRange = ((List<Map<String, Object>>) firstHead.get("closedRanges")).getFirst();
        assertThat(firstHead)
            .containsEntry("closedThrough", targetYearMonth)
            .containsEntry("settlementMonth", cycleYearMonth)
            .containsEntry("requestId", firstEvidence.requestId());
        assertThat(firstLedger)
            .containsEntry("latestVersionId", firstVersionId)
            .containsEntry("revision", 1L)
            .containsEntry("snapshotHash", firstVersion.get("snapshotHash"));
        assertThat(firstVersion)
            .containsEntry("schemaVersion", 3L)
            .containsEntry("revision", 1L)
            .containsEntry("snapshotHash", harness.persistence().hashCanonicalJson(firstSnapshot));
        assertThat(firstSnapshot)
            .containsEntry("contractVersion", "cashflow-cumulative-close-v2")
            .containsEntry("approvalVersionId", firstVersionId)
            .containsEntry("previousAuthorityExists", false)
            .containsEntry("preApprovalAuthority", Map.of())
            .containsEntry("affectedFromMonth", "2023-01")
            .containsEntry("affectedThroughMonth", targetYearMonth)
            .containsEntry("headRevision", 1L)
            .containsEntry("rootHash", firstEvidence.manifestHash())
            .containsEntry("requestId", firstEvidence.requestId());
        assertThat(firstVersion)
            .containsEntry("previousAuthorityExists", false)
            .containsEntry("preApprovalAuthority", Map.of())
            .containsEntry("affectedFromMonth", "2023-01")
            .containsEntry("affectedThroughMonth", targetYearMonth);
        Map<String, Object> firstLedgerSnapshot = nestedMap(firstLedger.get("snapshot"));
        assertThat(snapshotDifferences(firstLedgerSnapshot, firstSnapshot)).isEmpty();
        assertThat(harness.persistence().hashCanonicalJson(firstLedgerSnapshot))
            .isEqualTo(harness.persistence().hashCanonicalJson(firstSnapshot));
        assertThat(firstRange)
            .containsEntry("affectedFromMonth", "2023-01")
            .containsEntry("affectedThroughMonth", targetYearMonth)
            .containsEntry("closedByCycleYearMonth", cycleYearMonth)
            .containsEntry("approvalVersionId", firstVersionId)
            .containsEntry("requestId", firstEvidence.requestId())
            .containsEntry("ledgerRevision", 1L)
            .containsEntry("rootHash", firstEvidence.manifestHash());
        assertThat(document(harness.requestPath()))
            .containsEntry("approvalVersionId", firstVersionId)
            .containsEntry("ledgerRevision", 1L);

        seedLockedWeeklyCompletions(harness, "2023-01", targetYearMonth);
        CashflowMonthReopenCommands.RequestReopen reopenRequest =
            new CashflowMonthReopenCommands.RequestReopen(
                "reopen-request-v1",
                cycleYearMonth,
                firstApproval.revision(),
                "원장 정정",
                firstEvidence.requestId(),
                cycleYearMonth,
                targetYearMonth,
                firstEvidence.evidenceRevision(),
                firstEvidence.manifestHash(),
                2
            );
        CashflowMonthCloseResponse reopenRequested = transaction(harness, () ->
            harness.service().requestCashflowMonthReopen(
                harness.approver(), harness.projectId(), DATA_PROJECT_ID,
                reopenRequest
            )
        );
        assertThat(reopenRequested.status()).isEqualTo("REOPEN_REQUESTED");
        assertThat(reopenRequested.revision()).isEqualTo(2);
        assertThat(document(harness.requestPath()))
            .containsEntry("status", "REOPEN_REQUESTED")
            .containsEntry("workflowRevision", 3L);
        Map<String, Map<String, Map<String, Object>>> afterReopenRequest = projectState(harness);
        CashflowMonthReopenCommands.RequestReopen changedReopenRequest =
            new CashflowMonthReopenCommands.RequestReopen(
                reopenRequest.idempotencyKey(), reopenRequest.yearMonth(), reopenRequest.expectedRevision(),
                "같은 키의 다른 재오픈 사유", reopenRequest.requestId(), reopenRequest.cycleYearMonth(),
                reopenRequest.monthCloseTargetYearMonth(), reopenRequest.evidenceRevision(),
                reopenRequest.manifestHash(), reopenRequest.expectedWorkflowRevision()
            );
        assertThatThrownBy(() -> transaction(harness, () ->
            harness.service().requestCashflowMonthReopen(
                harness.approver(), harness.projectId(), DATA_PROJECT_ID, changedReopenRequest
            )
        )).isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("different request body");
        assertThatThrownBy(() -> transaction(harness, () ->
            harness.service().requestCashflowMonthReopen(
                harness.admin(), harness.projectId(), DATA_PROJECT_ID, reopenRequest
            )
        )).isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("different request body");
        assertThat(projectState(harness)).isEqualTo(afterReopenRequest);

        CashflowMonthReopenCommands.DecideReopen reopenDecision =
            new CashflowMonthReopenCommands.DecideReopen(
                "reopen-approve-v1",
                cycleYearMonth,
                reopenRequested.revision(),
                "APPROVE",
                "44개월 exact restoration 승인",
                firstEvidence.requestId(),
                cycleYearMonth,
                targetYearMonth,
                firstEvidence.evidenceRevision(),
                firstEvidence.manifestHash(),
                3
            );
        Map<String, Map<String, Map<String, Object>>> beforeAbortedReopen = projectState(harness);
        Throwable forcedAbort = catchThrowable(() -> transaction(harness, () -> {
            harness.service().decideCashflowMonthReopen(
                harness.approver(), harness.projectId(), DATA_PROJECT_ID, reopenDecision
            );
            throw new ForcedTransactionAbort();
        }));

        assertThat(rootCause(forcedAbort)).isInstanceOf(ForcedTransactionAbort.class);
        assertThat(projectState(harness))
            .as("An aborted Firestore transaction must not leak any canonical or receipt write")
            .isEqualTo(beforeAbortedReopen);

        CashflowMonthCloseResponse reopened = transaction(harness, () ->
            harness.service().decideCashflowMonthReopen(
                harness.approver(), harness.projectId(), DATA_PROJECT_ID, reopenDecision
            )
        );

        assertThat(reopened.status()).isEqualTo("OPEN");
        assertThat(reopened.revision()).isEqualTo(3);
        assertThat(document(harness.requestPath()))
            .containsEntry("status", "REOPENED")
            .containsEntry("workflowRevision", 4L);
        assertThat(document(harness.coordinatorPath()))
            .containsEntry("activeState", "REOPENED")
            .containsEntry("workflowRevision", 4L);
        assertThat(document(harness.headPath()))
            .containsEntry("authorityExists", false)
            .containsEntry("status", "OPEN")
            .containsEntry("revision", 2L)
            .containsEntry("closedRanges", List.of());
        assertThat(document(harness.monthlyClosePath()))
            .containsEntry("status", "OPEN")
            .containsEntry("revision", 3L);
        assertThat(document(harness.monthlyCloseVersionPath(firstVersionId)))
            .as("The approved V3 ledger version is immutable during compensating reopen")
            .isEqualTo(firstVersion);
        Map<String, Map<String, Map<String, Object>>> afterReopenDecision = projectState(harness);
        CashflowMonthReopenCommands.DecideReopen changedReopenDecision =
            new CashflowMonthReopenCommands.DecideReopen(
                reopenDecision.idempotencyKey(), reopenDecision.yearMonth(), reopenDecision.expectedRevision(),
                reopenDecision.decision(), "같은 키의 다른 재오픈 결정 사유", reopenDecision.requestId(),
                reopenDecision.cycleYearMonth(), reopenDecision.monthCloseTargetYearMonth(),
                reopenDecision.evidenceRevision(), reopenDecision.manifestHash(),
                reopenDecision.expectedWorkflowRevision()
            );
        assertThatThrownBy(() -> transaction(harness, () ->
            harness.service().decideCashflowMonthReopen(
                harness.approver(), harness.projectId(), DATA_PROJECT_ID, changedReopenDecision
            )
        )).isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("different request body");
        assertThatThrownBy(() -> transaction(harness, () ->
            harness.service().decideCashflowMonthReopen(
                harness.admin(), harness.projectId(), DATA_PROJECT_ID, reopenDecision
            )
        )).isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("different request body");
        assertThat(projectState(harness)).isEqualTo(afterReopenDecision);

        List<String> affectedMonths = monthsBetween("2023-01", targetYearMonth);
        for (String yearMonth : affectedMonths) {
            for (int weekNo = 1; weekNo <= 5; weekNo++) {
                assertPeriod(harness, yearMonth, "WEEK_" + weekNo, "WAITING_FOR_UPDATE");
                Map<String, Object> completion = document(harness.weeklyCompletionPath(yearMonth, weekNo));
                assertThat(completion)
                    .as(yearMonth + " WEEK_" + weekNo)
                    .containsEntry("status", "OPEN")
                    .containsEntry("revision", 2L)
                    .containsEntry("reopenSource", "MONTH_REOPEN_APPROVAL");
                assertThat(document(harness.weeklyCompletionVersionPath(yearMonth, weekNo, 2)))
                    .containsEntry("complianceStatus", "REOPENED")
                    .containsEntry("approvalVersionId", firstVersionId);
            }
        }
        assertPeriod(harness, cycleYearMonth, "MONTH", "WAITING_FOR_UPDATE");
        assertPeriod(harness, targetYearMonth, "MONTH", "COMPLETED");
        assertThat(projectDocuments(harness, "cashflow_weekly_update_completion_versions"))
            .hasSize(44 * 5);

        String currentTargetRevision = FirestoreInheritedWeeklyExpensePersistence
            .computeCashflowTargetRevision(projectDocuments(harness, "cashflow_weeks").values());
        Evidence secondEvidence = seedStagedEvidence(
            harness,
            cycleYearMonth,
            2,
            currentTargetRevision,
            4,
            Map.of(
                "stage-v2-a", "resubmit-v2-a",
                "stage-v2-b", "resubmit-v2-b"
            )
        );
        SubmitCashflowSettlementCycleRequest resubmitA = secondEvidence.submit(
            "resubmit-v2-a", "stage-v2-a", 4
        );
        SubmitCashflowSettlementCycleRequest resubmitB = secondEvidence.submit(
            "resubmit-v2-b", "stage-v2-b", 4
        );
        List<Attempt> concurrentAttempts = concurrentSubmit(harness, resubmitA, resubmitB);

        assertThat(concurrentAttempts.stream().filter(Attempt::succeeded).toList()).hasSize(1);
        assertThat(concurrentAttempts.stream()
            .filter(Attempt::succeeded)
            .map(attempt -> attempt.response().businessState()))
            .containsExactly("SUBMITTED");
        List<Throwable> concurrentFailures = concurrentAttempts.stream()
            .filter(attempt -> !attempt.succeeded())
            .map(attempt -> rootCause(attempt.failure()))
            .toList();
        assertThat(concurrentFailures).singleElement().satisfies(failure -> {
            assertThat(failure).isInstanceOf(CashflowSettlementCycleWorkflow.Violation.class);
            assertThat(((CashflowSettlementCycleWorkflow.Violation) failure).reason())
                .isEqualTo(CashflowSettlementCycleWorkflow.ViolationReason.REVISION_CHANGED);
        });
        assertThat(document(harness.requestPath()))
            .containsEntry("status", "PENDING_APPROVAL")
            .containsEntry("workflowRevision", 5L)
            .containsEntry("evidenceRevision", 2L);

        Map<String, Map<String, Map<String, Object>>> beforeStaleMutation = projectState(harness);
        Throwable stale = catchThrowable(() -> transaction(harness, () ->
            harness.service().transitionCashflowSettlementCycle(
                harness.approver(), harness.projectId(),
                new TransitionCashflowSettlementCycleRequest(
                    "stale-withdraw-v2", "WITHDRAW", cycleYearMonth, targetYearMonth,
                    secondEvidence.requestId(), secondEvidence.evidenceRevision(),
                    secondEvidence.manifestHash(), 4, "stale revision must fail"
                )
            )
        ));
        assertThat(rootCause(stale)).isInstanceOfSatisfying(
            CashflowSettlementCycleWorkflow.Violation.class,
            violation -> assertThat(violation.reason())
                .isEqualTo(CashflowSettlementCycleWorkflow.ViolationReason.REVISION_CHANGED)
        );
        assertThat(projectState(harness)).isEqualTo(beforeStaleMutation);

        CloseCashflowMonthRequest finalApprovalRequest = secondEvidence.approval(
            "approve-v2", reopened.revision(), 5, "재제출 승인"
        );
        CashflowMonthCloseResponse finalApproval = transaction(harness, () ->
            harness.service().closeCashflowMonth(
                harness.approver(), harness.projectId(), null, finalApprovalRequest
            )
        );
        assertThat(finalApproval.status()).isEqualTo("CLOSED");
        assertThat(finalApproval.revision()).isEqualTo(4);
        assertThat(document(harness.requestPath()))
            .containsEntry("status", "APPROVED")
            .containsEntry("workflowRevision", 6L)
            .containsEntry("evidenceRevision", 2L);
        assertThat(document(harness.coordinatorPath()))
            .containsEntry("activeState", "INACTIVE")
            .containsEntry("workflowRevision", 6L);
        assertThat(document(harness.headPath()))
            .containsEntry("authorityExists", true)
            .containsEntry("closedThrough", targetYearMonth)
            .containsEntry("settlementMonth", cycleYearMonth)
            .containsEntry("revision", 3L);
        assertPeriod(harness, cycleYearMonth, "MONTH", "LOCKED");
        assertPeriod(harness, cycleYearMonth, "WEEK_2", "COMPLETED");
        assertPeriod(harness, targetYearMonth, "MONTH", "COMPLETED");

        Map<String, Map<String, Map<String, Object>>> beforeReplay = projectState(harness);
        CashflowMonthCloseResponse replay = transaction(harness, () ->
            harness.service().closeCashflowMonth(
                harness.approver(), harness.projectId(), null, finalApprovalRequest
            )
        );
        JsonNode finalJson = JSON.readTree(JSON.writeValueAsBytes(finalApproval));
        JsonNode replayJson = JSON.readTree(JSON.writeValueAsBytes(replay));
        assertThat(replayJson).isEqualTo(finalJson);
        assertThat(projectState(harness))
            .as("Same actor/key/body replay must not duplicate state, audit, or receipt writes")
            .isEqualTo(beforeReplay);

        CloseCashflowMonthRequest changedBody = secondEvidence.approval(
            "approve-v2", reopened.revision(), 5, "같은 키의 다른 본문"
        );
        assertThatThrownBy(() -> transaction(harness, () ->
            harness.service().closeCashflowMonth(
                harness.approver(), harness.projectId(), null, changedBody
            )
        ))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("different request body");
        assertThat(projectState(harness)).isEqualTo(beforeReplay);

        assertThatThrownBy(() -> transaction(harness, () ->
            harness.service().closeCashflowMonth(
                harness.admin(), harness.projectId(), null, finalApprovalRequest
            )
        ))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("different request body");
        assertThat(projectState(harness))
            .as("Approval idempotency is bound to actorUid as well as key and body")
            .isEqualTo(beforeReplay);

        assertThat(projectDocuments(harness, "weekly_api_audit_events")).hasSize(6);
        assertThat(projectDocuments(harness, "weekly_api_idempotency")).hasSize(6);
        assertThat(projectDocuments(harness, "monthly_close_versions")).hasSize(2);
    }

    @Test
    void fortyFiveMonthCycleIsRejectedBeforeAnyCanonicalOrReceiptWrite() throws Exception {
        Harness harness = harness("it-cycle-45", "project-cycle-45");
        seedCanonicalActorsAndProject(harness);
        String emptyTargetRevision = FirestoreInheritedWeeklyExpensePersistence
            .computeCashflowTargetRevision(List.of());
        Evidence evidence = seedDirectApprovalEvidence(
            harness, "2026-10", 1, emptyTargetRevision, "close-45"
        );
        Map<String, Map<String, Map<String, Object>>> before = projectState(harness);

        assertThatThrownBy(() -> transaction(harness, () ->
            harness.service().closeCashflowMonth(
                harness.approver(), harness.projectId(), null,
                evidence.directApproval("close-45", 0)
            )
        ))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("exceeds 44 months");

        assertThat(projectState(harness))
            .as("The 45-month guard must fail before ledger/head/audit/idempotency writes")
            .isEqualTo(before);
        assertThat(documentOrEmpty(harness.headPath())).isEmpty();
        assertThat(documentOrEmpty(harness.monthlyClosePath("2026-10"))).isEmpty();
        assertThat(projectDocuments(harness, "weekly_api_audit_events")).isEmpty();
        assertThat(projectDocuments(harness, "weekly_api_idempotency")).isEmpty();
        assertThat(projectDocuments(harness, "cashflow_weeks")).isEmpty();
    }

    @Test
    @SuppressWarnings("unchecked")
    void legacyApprovalMigrationBuildsOneCanonicalCycleWithoutTouchingStatus() throws Exception {
        for (boolean targetKeyed : List.of(true, false)) {
            Harness harness = harness(
                targetKeyed ? "it-target-v1" : "it-cycle-v1",
                targetKeyed ? "project-target-v1" : "project-cycle-v1"
            );
            seedCanonicalActorsAndProject(harness);
            seedLegacyMigrationCandidate(harness, targetKeyed, targetKeyed);
            long expectedHeadRevision = targetKeyed ? 5 : 4;
            String sourceMonth = targetKeyed ? "2026-08" : "2026-09";
            String sourceVersionId = harness.projectId() + "-" + sourceMonth + "-r3";
            String migratedVersionId = harness.projectId() + "-2026-09-r3-migrated-v3";
            Map<String, Object> oldRequest = document(harness.requestPath(
                harness.projectId() + "-" + sourceMonth
            ));
            Map<String, Object> oldLedger = document(harness.monthlyClosePath(sourceMonth));
            Map<String, Object> oldVersion = document(harness.monthlyCloseVersionPath(sourceVersionId));
            Map<String, Map<String, Object>> oldReceipts = projectDocuments(
                harness, "weekly_api_idempotency"
            );
            assertThat(oldReceipts).hasSize(targetKeyed ? 2 : 1);
            DocumentSnapshot statusBefore = db.document(harness.settlementPath("2026-09"))
                .get().get(60, TimeUnit.SECONDS);
            Map<String, Map<String, Map<String, Object>>> beforeDryRun = projectState(harness);
            Map<String, String> updateTimesBeforeDryRun = projectUpdateTimes(harness);

            CashflowSettlementCycleHeadMigrationResponse validated = transaction(harness, () ->
                harness.service().migrateCashflowSettlementCycleHeadV2(
                    harness.admin(), harness.projectId(),
                    new MigrateCashflowSettlementCycleHeadV2Request(
                        "settlement-cycle-v3:" + harness.projectId(), expectedHeadRevision,
                        SOURCE_REVISION, "canonical v3 migration", true, ""
                    )
                )
            );
            assertThat(validated.auditId()).isEmpty();
            assertThat(validated.migrationRequired()).isTrue();
            assertThat(validated.migrationFingerprint()).matches("sha256:[0-9a-f]{64}");
            assertThat(projectState(harness)).isEqualTo(beforeDryRun);
            assertThat(projectUpdateTimes(harness)).isEqualTo(updateTimesBeforeDryRun);

            MigrateCashflowSettlementCycleHeadV2Request apply =
                new MigrateCashflowSettlementCycleHeadV2Request(
                    "settlement-cycle-v3:" + harness.projectId(), expectedHeadRevision,
                    SOURCE_REVISION, "canonical v3 migration", false,
                    validated.migrationFingerprint()
                );
            CashflowSettlementCycleHeadMigrationResponse migrated = transaction(harness, () ->
                harness.service().migrateCashflowSettlementCycleHeadV2(
                    harness.admin(), harness.projectId(), apply
                )
            );

            Map<String, Object> request = document(harness.requestPath(harness.projectId() + "-2026-09"));
            Map<String, Object> ledger = document(harness.monthlyClosePath("2026-09"));
            Map<String, Object> version = document(harness.monthlyCloseVersionPath(migratedVersionId));
            assertThat(migrated.approvalVersionId()).isEqualTo(migratedVersionId);
            assertThat(migrated.migrationRequired()).isTrue();
            assertThat(request)
                .containsEntry("documentType", "REQUEST")
                .containsEntry("cycleYearMonth", "2026-09")
                .containsEntry("monthCloseTargetYearMonth", "2026-08")
                .containsEntry("approvalVersionId", migratedVersionId)
                .containsEntry("ledgerRevision", 3L);
            assertThat(ledger)
                .containsEntry("yearMonth", "2026-09")
                .containsEntry("latestVersionId", migratedVersionId)
                .containsEntry("snapshotHash", version.get("snapshotHash"));
            assertThat(version)
                .containsEntry("schemaVersion", 3L)
                .containsEntry("yearMonth", "2026-09")
                .containsEntry("revision", 3L);
            assertThat(nestedMap(version.get("snapshot")))
                .containsEntry("schemaVersion", 3L)
                .containsEntry("approvalVersionId", migratedVersionId)
                .containsEntry("headRevision", expectedHeadRevision + 1);
            assertThat(harness.persistence().hashCanonicalJson(nestedMap(version.get("snapshot"))))
                .isEqualTo(version.get("snapshotHash"));
            assertThat(document(harness.monthlyCloseVersionPath(sourceVersionId))).isEqualTo(oldVersion);
            assertThat(projectDocuments(harness, "weekly_api_idempotency"))
                .containsAllEntriesOf(oldReceipts);
            if (targetKeyed) {
                assertThat(document(harness.requestPath(harness.projectId() + "-2026-08")))
                    .isEqualTo(oldRequest);
                assertThat(document(harness.monthlyClosePath("2026-08"))).isEqualTo(oldLedger);
            }
            DocumentSnapshot statusAfter = db.document(harness.settlementPath("2026-09"))
                .get().get(60, TimeUnit.SECONDS);
            assertThat(statusAfter.getData()).isEqualTo(statusBefore.getData());
            assertThat(statusAfter.getUpdateTime()).isEqualTo(statusBefore.getUpdateTime());
            WeeklyExpensePersistence.CashflowSettlementCycleRecord projected = harness.persistence()
                .findCashflowSettlementCyclesBatch(
                    harness.admin(), List.of(harness.projectId()), "2026-09", "2026-08"
                ).get(harness.projectId());
            assertThat(projected.projection().businessState())
                .isEqualTo(dev.merryai.innerplatform.weekly.domain.CashflowSettlementCyclePolicy.BusinessState.LOCKED);
            assertThat(projected.projection().health())
                .isEqualTo(dev.merryai.innerplatform.weekly.domain.CashflowSettlementCyclePolicy.Health.OK);
            assertThat(projected.projection().provenance())
                .extracting(
                    dev.merryai.innerplatform.weekly.domain.CashflowSettlementCyclePolicy.ApprovalProvenance::requestId,
                    dev.merryai.innerplatform.weekly.domain.CashflowSettlementCyclePolicy.ApprovalProvenance::approvalVersionId
                )
                .containsExactly(harness.projectId() + "-2026-09", migratedVersionId);
            Map<String, Map<String, Map<String, Object>>> beforeReplay = projectState(harness);
            Map<String, String> updateTimesBeforeReplay = projectUpdateTimes(harness);
            assertThat(transaction(harness, () -> harness.service().migrateCashflowSettlementCycleHeadV2(
                harness.admin(), harness.projectId(), apply
            ))).isEqualTo(migrated);
            assertThat(projectState(harness)).isEqualTo(beforeReplay);
            assertThat(projectUpdateTimes(harness)).isEqualTo(updateTimesBeforeReplay);

            CashflowSettlementCycleHeadMigrationResponse canonical = transaction(harness, () ->
                harness.service().migrateCashflowSettlementCycleHeadV2(
                    harness.admin(), harness.projectId(), new MigrateCashflowSettlementCycleHeadV2Request(
                        "settlement-cycle-v3:verify:" + harness.projectId(), expectedHeadRevision + 1,
                        SOURCE_REVISION, "canonical classification", true, ""
                    )
                )
            );
            assertThat(canonical.migrationRequired()).isFalse();
            assertThat(canonical.headRevision()).isEqualTo(expectedHeadRevision + 1);
            assertThat(projectState(harness)).isEqualTo(beforeReplay);
            assertThat(projectUpdateTimes(harness)).isEqualTo(updateTimesBeforeReplay);
        }

        Harness collision = harness("it-v3-collision", "project-v3-collision");
        seedCanonicalActorsAndProject(collision);
        seedLegacyMigrationCandidate(collision, true, false);
        CashflowSettlementCycleHeadMigrationResponse validated = transaction(collision, () ->
            collision.service().migrateCashflowSettlementCycleHeadV2(
                collision.admin(), collision.projectId(),
                new MigrateCashflowSettlementCycleHeadV2Request(
                    "settlement-cycle-v3:collision", 4, SOURCE_REVISION,
                    "collision guard", true, ""
                )
            )
        );
        Map<String, Object> unchangedStatus = document(collision.settlementPath("2026-09"));
        DocumentSnapshot statusBeforeTouch = db.document(collision.settlementPath("2026-09"))
            .get().get(60, TimeUnit.SECONDS);
        Map<String, Object> touchedStatus = new LinkedHashMap<>(unchangedStatus);
        touchedStatus.put("fingerprintProbe", true);
        seedDocuments(Map.of(collision.settlementPath("2026-09"), touchedStatus));
        seedDocuments(Map.of(collision.settlementPath("2026-09"), unchangedStatus));
        DocumentSnapshot statusAfterTouch = db.document(collision.settlementPath("2026-09"))
            .get().get(60, TimeUnit.SECONDS);
        assertThat(statusAfterTouch.getData()).isEqualTo(statusBeforeTouch.getData());
        assertThat(statusAfterTouch.getUpdateTime()).isNotEqualTo(statusBeforeTouch.getUpdateTime());
        Map<String, Map<String, Map<String, Object>>> afterStatusTouch = projectState(collision);
        Map<String, String> updateTimesAfterStatusTouch = projectUpdateTimes(collision);
        assertThatThrownBy(() -> transaction(collision, () ->
            collision.service().migrateCashflowSettlementCycleHeadV2(
                collision.admin(), collision.projectId(), new MigrateCashflowSettlementCycleHeadV2Request(
                    "settlement-cycle-v3:collision", 4, SOURCE_REVISION,
                    "collision guard", false, validated.migrationFingerprint()
                )
            )
        )).isInstanceOf(WeeklyExpenseConflictException.class);
        assertThat(projectState(collision)).isEqualTo(afterStatusTouch);
        assertThat(projectUpdateTimes(collision)).isEqualTo(updateTimesAfterStatusTouch);

        CashflowSettlementCycleHeadMigrationResponse revalidated = transaction(collision, () ->
            collision.service().migrateCashflowSettlementCycleHeadV2(
                collision.admin(), collision.projectId(), new MigrateCashflowSettlementCycleHeadV2Request(
                    "settlement-cycle-v3:collision", 4, SOURCE_REVISION,
                    "collision guard", true, ""
                )
            )
        );
        seedDocuments(Map.of(
            collision.monthlyCloseVersionPath(collision.projectId() + "-2026-09-r3-migrated-v3"),
            Map.of("projectId", collision.projectId(), "collision", true)
        ));
        Map<String, Map<String, Map<String, Object>>> beforeCollision = projectState(collision);
        Map<String, String> updateTimesBeforeCollision = projectUpdateTimes(collision);
        assertThatThrownBy(() -> transaction(collision, () ->
            collision.service().migrateCashflowSettlementCycleHeadV2(
                collision.admin(), collision.projectId(),
                new MigrateCashflowSettlementCycleHeadV2Request(
                    "settlement-cycle-v3:collision", 4, SOURCE_REVISION,
                    "collision guard", false, revalidated.migrationFingerprint()
                )
            )
        )).isInstanceOf(WeeklyExpenseConflictException.class);
        assertThat(projectState(collision)).isEqualTo(beforeCollision);
        assertThat(projectUpdateTimes(collision)).isEqualTo(updateTimesBeforeCollision);
    }

    @Test
    void legacyApprovalMigrationArchivesStaleActiveRequestBeforeCanonicalRecovery() throws Exception {
        Harness harness = harness("it-stale-request", "project-stale-request");
        seedCanonicalActorsAndProject(harness);
        seedLegacyMigrationCandidate(harness, false, false);
        String requestId = harness.projectId() + "-2026-09";
        String requestPath = harness.requestPath(requestId);
        Map<String, Object> staleRequest = new LinkedHashMap<>(document(requestPath));
        staleRequest.remove("reviewIdempotencyKey");
        staleRequest.remove("monthCloseResult");
        staleRequest.put("documentType", "REQUEST");
        staleRequest.put("status", "UNCERTAIN");
        staleRequest.put("revision", 9L);
        staleRequest.put("evidenceRevision", 9L);
        staleRequest.put("manifestHash", "sha256:" + "b".repeat(64));
        seedDocuments(Map.of(requestPath, staleRequest));
        Map<String, Object> statusBefore = document(harness.settlementPath("2026-09"));
        Map<String, Map<String, Map<String, Object>>> beforeDryRun = projectState(harness);

        CashflowSettlementCycleHeadMigrationResponse validated = transaction(harness, () ->
            harness.service().migrateCashflowSettlementCycleHeadV2(
                harness.admin(), harness.projectId(), new MigrateCashflowSettlementCycleHeadV2Request(
                    "settlement-cycle-v3:stale-request", 4, SOURCE_REVISION,
                    "archive stale request and recover approval", true, ""
                )
            )
        );
        assertThat(projectState(harness)).isEqualTo(beforeDryRun);

        MigrateCashflowSettlementCycleHeadV2Request apply =
            new MigrateCashflowSettlementCycleHeadV2Request(
                "settlement-cycle-v3:stale-request", 4, SOURCE_REVISION,
                "archive stale request and recover approval", false,
                validated.migrationFingerprint()
            );
        String archivePath = requestPath + "/migration_archives/stale-r9";
        seedDocuments(Map.of(archivePath, Map.of("collision", true)));
        assertThatThrownBy(() -> transaction(harness, () ->
            harness.service().migrateCashflowSettlementCycleHeadV2(
                harness.admin(), harness.projectId(), apply
            )
        ))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("archive collision");
        assertThat(document(requestPath)).isEqualTo(staleRequest);
        db.document(archivePath).delete().get(60, TimeUnit.SECONDS);

        CashflowSettlementCycleHeadMigrationResponse migrated = transaction(harness, () ->
            harness.service().migrateCashflowSettlementCycleHeadV2(
                harness.admin(), harness.projectId(), apply
            )
        );

        assertThat(document(archivePath))
            .isEqualTo(staleRequest);
        assertThat(document(requestPath))
            .containsEntry("documentType", "REQUEST")
            .containsEntry("status", "APPROVED")
            .containsEntry("revision", 7L)
            .containsEntry("evidenceRevision", 7L)
            .containsEntry("manifestHash", SOURCE_REVISION)
            .containsEntry("ledgerRevision", 3L)
            .containsEntry("approvalVersionId", migrated.approvalVersionId());
        assertThat(document(harness.settlementPath("2026-09"))).isEqualTo(statusBefore);
    }

    private Harness harness(String tenantId, String projectId) {
        FirestoreInheritedWeeklyExpensePersistence persistence =
            new FirestoreInheritedWeeklyExpensePersistence(
                db,
                DATA_PROJECT_ID,
                Clock.fixed(NOW, ZoneOffset.UTC)
            );
        WeeklyExpenseAuthorizationService authorization = new WeeklyExpenseAuthorizationService(
            (actor, requestedProjectId) -> true,
            new WeeklyProjectExistenceRepository() {
                @Override
                public boolean exists(String requestedTenantId, String requestedProjectId) {
                    return true;
                }

                @Override
                public boolean existsCanonicalProject(String requestedTenantId, String requestedProjectId) {
                    return true;
                }
            },
            "strict"
        );
        WeeklyExpenseCommandService service = new WeeklyExpenseCommandService(
            persistence,
            authorization,
            JSON,
            true,
            "live"
        );
        TrustedActorContext approver = new TrustedActorContext(
            tenantId, "approver-1", "approver@example.test", "untrusted", "테스트 조직장"
        );
        TrustedActorContext admin = new TrustedActorContext(
            tenantId, "admin-2", "admin@example.test", "untrusted", "테스트 관리자"
        );
        return new Harness(tenantId, projectId, persistence, service, approver, admin);
    }

    private void seedCanonicalActorsAndProject(Harness harness) throws Exception {
        Map<String, Map<String, Object>> documents = new LinkedHashMap<>();
        documents.put(harness.projectPath(), Map.of(
            "id", harness.projectId(),
            "tenantId", harness.tenantId(),
            "executiveApproverId", harness.approver().id(),
            "version", 3L
        ));
        documents.put(harness.memberPath(harness.approver().id()), Map.of(
            "uid", harness.approver().id(),
            "status", "ACTIVE",
            "role", "pm",
            "projectIds", List.of(harness.projectId())
        ));
        documents.put(harness.personPath("person-approver"), Map.of(
            "uid", harness.approver().id(),
            "name", harness.approver().name()
        ));
        documents.put(harness.memberPath(harness.admin().id()), Map.of(
            "uid", harness.admin().id(),
            "status", "ACTIVE",
            "role", "admin",
            "projectIds", List.of()
        ));
        documents.put(harness.personPath("person-admin"), Map.of(
            "uid", harness.admin().id(),
            "name", harness.admin().name()
        ));
        seedDocuments(documents);
    }

    private Evidence seedStagedEvidence(
        Harness harness,
        String cycleYearMonth,
        long evidenceRevision,
        String targetRevision,
        long expectedWorkflowRevision,
        Map<String, String> stageCommands
    ) throws Exception {
        Evidence evidence = evidence(harness, cycleYearMonth, evidenceRevision, targetRevision);
        Map<String, Map<String, Object>> documents = new LinkedHashMap<>(evidence.shards());
        for (Map.Entry<String, String> stageCommand : stageCommands.entrySet()) {
            String stageId = stageCommand.getKey();
            Map<String, Object> stage = new LinkedHashMap<>(evidence.header());
            stage.put("documentType", "EVIDENCE_STAGE");
            stage.put("tenantId", harness.tenantId());
            stage.put("stageId", stageId);
            stage.put("status", "STAGED");
            stage.put("cycleYearMonth", cycleYearMonth);
            stage.put("evidenceRevision", evidenceRevision);
            stage.put("expectedWorkflowRevision", expectedWorkflowRevision);
            stage.put("expectedProjectVersion", 3L);
            stage.put("requestedByUid", harness.approver().id());
            stage.put("createIdempotencyKey", stageCommand.getValue());
            documents.put(harness.stagePath(evidence.requestId(), stageId), stage);
        }
        seedDocuments(documents);
        return evidence;
    }

    private Evidence seedDirectApprovalEvidence(
        Harness harness,
        String cycleYearMonth,
        long evidenceRevision,
        String targetRevision,
        String idempotencyKey
    ) throws Exception {
        Evidence evidence = evidence(harness, cycleYearMonth, evidenceRevision, targetRevision);
        Map<String, Map<String, Object>> documents = new LinkedHashMap<>(evidence.shards());
        Map<String, Object> header = new LinkedHashMap<>(evidence.header());
        header.put("status", "APPROVING");
        header.put("reviewIdempotencyKey", idempotencyKey);
        documents.put(harness.requestPath(evidence.requestId()), header);
        seedDocuments(documents);
        return evidence;
    }

    private void seedLegacyMigrationCandidate(
        Harness harness,
        boolean targetKeyed,
        boolean headOnlyMarker
    ) throws Exception {
        String cycleYearMonth = "2026-09";
        String targetYearMonth = "2026-08";
        String sourceMonth = targetKeyed ? targetYearMonth : cycleYearMonth;
        String requestId = harness.projectId() + "-" + sourceMonth;
        String versionId = harness.projectId() + "-" + sourceMonth + "-r3";
        Map<String, Object> snapshot = new LinkedHashMap<>(Map.ofEntries(
            Map.entry("schemaVersion", 2L),
            Map.entry("contractVersion", "cashflow-cumulative-close-v2"),
            Map.entry("projectId", harness.projectId()),
            Map.entry("yearMonth", sourceMonth),
            Map.entry("requestId", requestId),
            Map.entry("requestRevision", 7L),
            Map.entry("manifestHash", SOURCE_REVISION),
            Map.entry("rootHash", SOURCE_REVISION),
            Map.entry("headRevision", 4L),
            Map.entry("approvalId", ""),
            Map.entry("operationId", "")
        ));
        String snapshotHash = harness.persistence().hashCanonicalJson(snapshot);
        Map<String, Object> result = new LinkedHashMap<>(Map.ofEntries(
            Map.entry("commandName", WeeklyExpenseCommandService.CLOSE_CASHFLOW_MONTH_COMMAND),
            Map.entry("projectId", harness.projectId()),
            Map.entry("yearMonth", sourceMonth),
            Map.entry("status", "CLOSED"),
            Map.entry("revision", 3L),
            Map.entry("requestId", requestId),
            Map.entry("requestRevision", 7L),
            Map.entry("manifestHash", SOURCE_REVISION),
            Map.entry("rootHash", SOURCE_REVISION),
            Map.entry("headRevision", 4L)
        ));
        String closeIdempotencyKey = targetKeyed
            ? "legacy-close"
            : "cashflow-settlement:" + requestId + ":r7:approve";
        Map<String, Object> request = new LinkedHashMap<>(Map.ofEntries(
            Map.entry("contractVersion", "cashflow-cumulative-close-v2"),
            Map.entry("requestId", requestId),
            Map.entry("tenantId", harness.tenantId()),
            Map.entry("projectId", harness.projectId()),
            Map.entry("yearMonth", sourceMonth),
            Map.entry("fromMonth", "2023-01"),
            Map.entry("status", "APPROVED"),
            Map.entry("revision", 7L),
            Map.entry("manifestHash", SOURCE_REVISION),
            Map.entry("reviewIdempotencyKey", closeIdempotencyKey),
            Map.entry("monthCloseResult", result)
        ));
        if (!targetKeyed) {
            request.put("cycleYearMonth", cycleYearMonth);
            request.put("throughMonth", targetYearMonth);
        }
        Map<String, Object> head = new LinkedHashMap<>(Map.ofEntries(
            Map.entry("contractVersion", "cashflow-cumulative-close-v2"),
            Map.entry("tenantId", harness.tenantId()),
            Map.entry("projectId", harness.projectId()),
            Map.entry("status", "CLOSED"),
            Map.entry("fromMonth", "2023-01"),
            Map.entry("closedThrough", targetYearMonth),
            Map.entry("settlementMonth", cycleYearMonth),
            Map.entry("rootHash", SOURCE_REVISION),
            Map.entry("revision", headOnlyMarker ? 5L : 4L),
            Map.entry("requestId", requestId),
            Map.entry("requestRevision", 7L),
            Map.entry("approvalId", ""),
            Map.entry("operationId", ""),
            Map.entry("closedAt", NOW.minusSeconds(60).toString()),
            Map.entry("closedByUid", harness.approver().id())
        ));
        if (headOnlyMarker) {
            head.put("authorityExists", true);
            head.put("closedRanges", List.of(Map.ofEntries(
                Map.entry("affectedFromMonth", "2023-01"),
                Map.entry("affectedThroughMonth", targetYearMonth),
                Map.entry("closedByCycleYearMonth", cycleYearMonth),
                Map.entry("approvalVersionId", versionId),
                Map.entry("requestId", requestId),
                Map.entry("ledgerRevision", 3L),
                Map.entry("rootHash", SOURCE_REVISION)
            )));
            head.put("migratedAt", NOW.minusSeconds(30).toString());
            head.put("migratedByUid", harness.admin().id());
        }
        Map<String, Object> receipt = new LinkedHashMap<>(Map.ofEntries(
            Map.entry("tenantId", harness.tenantId()),
            Map.entry("projectId", harness.projectId()),
            Map.entry("idempotencyKey", closeIdempotencyKey),
            Map.entry("commandName", WeeklyExpenseCommandService.CLOSE_CASHFLOW_MONTH_COMMAND),
            Map.entry("requestHash", "sha256:legacy-request"),
            Map.entry("responseJson", JSON.writeValueAsString(result)),
            Map.entry("createdAt", NOW.minusSeconds(60).toString())
        ));
        Map<String, Map<String, Object>> documents = new LinkedHashMap<>();
        documents.put(harness.headPath(), head);
        documents.put(harness.requestPath(requestId), request);
        documents.put(harness.monthlyClosePath(sourceMonth), Map.ofEntries(
            Map.entry("id", harness.projectId() + "-" + sourceMonth),
            Map.entry("contractVersion", "cashflow-month-close-v1"),
            Map.entry("tenantId", harness.tenantId()),
            Map.entry("projectId", harness.projectId()),
            Map.entry("yearMonth", sourceMonth),
            Map.entry("status", "CLOSED"),
            Map.entry("revision", 3L),
            Map.entry("snapshot", snapshot),
            Map.entry("snapshotHash", snapshotHash),
            Map.entry("latestVersionId", versionId),
            Map.entry("closedAt", NOW.minusSeconds(60).toString()),
            Map.entry("closedByUid", harness.approver().id())
        ));
        documents.put(harness.monthlyCloseVersionPath(versionId), Map.ofEntries(
            Map.entry("id", versionId),
            Map.entry("contractVersion", "cashflow-month-close-v1"),
            Map.entry("schemaVersion", 1L),
            Map.entry("tenantId", harness.tenantId()),
            Map.entry("projectId", harness.projectId()),
            Map.entry("yearMonth", sourceMonth),
            Map.entry("status", "CLOSED"),
            Map.entry("revision", 3L),
            Map.entry("snapshot", snapshot),
            Map.entry("snapshotHash", snapshotHash),
            Map.entry("closedAt", NOW.minusSeconds(60).toString()),
            Map.entry("closedByUid", harness.approver().id())
        ));
        documents.put(harness.settlementPath(cycleYearMonth), Map.of(
            "tenantId", harness.tenantId(),
            "projectId", harness.projectId(),
            "yearMonth", cycleYearMonth,
            "periods", Map.of("MONTH", Map.of("status", "COMPLETED", "revision", 2L)),
            "updatedAt", NOW.minusSeconds(60).toString()
        ));
        String receiptId = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
            (harness.projectId() + "\n" + WeeklyExpenseCommandService.CLOSE_CASHFLOW_MONTH_COMMAND
                + "\n" + closeIdempotencyKey).getBytes(java.nio.charset.StandardCharsets.UTF_8)
        );
        documents.put("orgs/" + harness.tenantId() + "/weekly_api_idempotency/" + receiptId, receipt);
        if (headOnlyMarker) {
            String oldMigrationKey = "settlement-cycle-head-v2:" + harness.projectId();
            String oldMigrationReceiptId = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                (harness.projectId() + "\n"
                    + WeeklyExpenseCommandService.MIGRATE_CASHFLOW_SETTLEMENT_CYCLE_HEAD_V2_COMMAND
                    + "\n" + oldMigrationKey).getBytes(java.nio.charset.StandardCharsets.UTF_8)
            );
            documents.put(
                "orgs/" + harness.tenantId() + "/weekly_api_idempotency/" + oldMigrationReceiptId,
                Map.ofEntries(
                    Map.entry("tenantId", harness.tenantId()),
                    Map.entry("projectId", harness.projectId()),
                    Map.entry("idempotencyKey", oldMigrationKey),
                    Map.entry("commandName",
                        WeeklyExpenseCommandService.MIGRATE_CASHFLOW_SETTLEMENT_CYCLE_HEAD_V2_COMMAND),
                    Map.entry("requestHash", "sha256:old-head-only-migration"),
                    Map.entry("responseJson", JSON.writeValueAsString(Map.ofEntries(
                        Map.entry("ok", true),
                        Map.entry("commandName",
                            WeeklyExpenseCommandService.MIGRATE_CASHFLOW_SETTLEMENT_CYCLE_HEAD_V2_COMMAND),
                        Map.entry("projectId", harness.projectId()),
                        Map.entry("closedThrough", targetYearMonth),
                        Map.entry("cycleYearMonth", cycleYearMonth),
                        Map.entry("approvalVersionId", versionId),
                        Map.entry("headRevision", 5L),
                        Map.entry("auditId", "old-head-only-audit")
                    ))),
                    Map.entry("createdAt", NOW.minusSeconds(30).toString())
                )
            );
        }
        seedDocuments(documents);
    }

    private Evidence evidence(
        Harness harness,
        String cycleYearMonth,
        long evidenceRevision,
        String targetRevision
    ) {
        String requestId = harness.projectId() + "-" + cycleYearMonth;
        String targetYearMonth = YearMonth.parse(cycleYearMonth).minusMonths(1).toString();
        long monthCount = ChronoUnit.MONTHS.between(
            YearMonth.parse("2023-01"), YearMonth.parse(targetYearMonth)
        ) + 1;
        List<Map<String, Object>> cells = emptyCumulativeCells();
        Map<String, Map<String, Object>> shards = new LinkedHashMap<>();
        List<Map<String, Object>> manifestMonths = new ArrayList<>();
        for (long offset = 0; offset < monthCount; offset++) {
            String yearMonth = YearMonth.parse("2023-01").plusMonths(offset).toString();
            Map<String, Object> source = Map.of(
                "sourceRevision", SOURCE_REVISION,
                "targetRevision", targetRevision
            );
            Map<String, Object> hashInput = new LinkedHashMap<>();
            hashInput.put("contractVersion", "cashflow-cumulative-close-v2");
            hashInput.put("requestId", requestId);
            hashInput.put("requestRevision", evidenceRevision);
            hashInput.put("projectId", harness.projectId());
            hashInput.put("yearMonth", yearMonth);
            hashInput.put("cells", cells);
            hashInput.put("source", source);
            String shardHash = harness.persistence().hashCanonicalJson(hashInput);
            Map<String, Object> shard = new LinkedHashMap<>(hashInput);
            shard.put("shardHash", shardHash);
            shards.put(harness.shardPath(requestId, evidenceRevision, yearMonth), shard);
            manifestMonths.add(Map.of("yearMonth", yearMonth, "shardHash", shardHash));
        }
        Map<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("contractVersion", "cashflow-cumulative-close-v2");
        manifest.put("requestId", requestId);
        manifest.put("requestRevision", evidenceRevision);
        manifest.put("projectId", harness.projectId());
        manifest.put("fromMonth", "2023-01");
        manifest.put("yearMonth", cycleYearMonth);
        manifest.put("months", manifestMonths);
        String manifestHash = harness.persistence().hashCanonicalJson(manifest);
        Map<String, Object> header = new LinkedHashMap<>();
        header.put("contractVersion", "cashflow-cumulative-close-v2");
        header.put("requestId", requestId);
        header.put("projectId", harness.projectId());
        header.put("yearMonth", cycleYearMonth);
        header.put("cycleYearMonth", cycleYearMonth);
        header.put("monthCloseTargetYearMonth", targetYearMonth);
        header.put("throughMonth", targetYearMonth);
        header.put("fromMonth", "2023-01");
        header.put("status", "APPROVING");
        header.put("revision", evidenceRevision);
        header.put("manifestHash", manifestHash);
        header.put("monthCount", monthCount);
        header.put("approverUid", harness.approver().id());
        header.put("approvalId", "approval-" + requestId + "-r" + evidenceRevision);
        header.put("operationId", "operation-" + requestId + "-r" + evidenceRevision);
        return new Evidence(
            harness.projectId(), cycleYearMonth, targetYearMonth, requestId, evidenceRevision,
            manifestHash, header, Map.copyOf(shards), harness.approver().id()
        );
    }

    private static List<Map<String, Object>> emptyCumulativeCells() {
        List<Map<String, Object>> cells = new ArrayList<>();
        for (String mode : List.of("projection", "actual")) {
            for (int weekNo = 1; weekNo <= 5; weekNo++) {
                for (String line : CUMULATIVE_LINES) {
                    Map<String, Object> cell = new LinkedHashMap<>();
                    cell.put("mode", mode);
                    cell.put("weekNo", weekNo);
                    cell.put("cashflowLine", line);
                    cell.put("cellState", "EMPTY");
                    cell.put("amount", null);
                    cells.add(cell);
                }
            }
        }
        return List.copyOf(cells);
    }

    private void seedLockedWeeklyCompletions(
        Harness harness,
        String fromYearMonth,
        String throughYearMonth
    ) throws Exception {
        Map<String, Map<String, Object>> documents = new LinkedHashMap<>();
        for (String yearMonth : monthsBetween(fromYearMonth, throughYearMonth)) {
            for (int weekNo = 1; weekNo <= 5; weekNo++) {
                Map<String, Object> completion = new LinkedHashMap<>();
                completion.put("id", harness.projectId() + "-" + yearMonth + "-w" + weekNo);
                completion.put("tenantId", harness.tenantId());
                completion.put("projectId", harness.projectId());
                completion.put("yearMonth", yearMonth);
                completion.put("weekNo", weekNo);
                completion.put("status", "LOCKED");
                completion.put("revision", 1L);
                completion.put("reopenCount", 0L);
                completion.put("snapshotHash", SOURCE_REVISION);
                completion.put("completedAt", NOW.minusSeconds(60).toString());
                completion.put("completedByUid", harness.approver().id());
                documents.put(harness.weeklyCompletionPath(yearMonth, weekNo), completion);
            }
        }
        seedDocuments(documents);
    }

    private void seedDocuments(Map<String, Map<String, Object>> documents) throws Exception {
        List<Map.Entry<String, Map<String, Object>>> entries = new ArrayList<>(documents.entrySet());
        for (int start = 0; start < entries.size(); start += 400) {
            WriteBatch batch = db.batch();
            for (Map.Entry<String, Map<String, Object>> entry : entries.subList(
                start, Math.min(start + 400, entries.size())
            )) {
                batch.set(db.document(entry.getKey()), entry.getValue());
            }
            batch.commit().get(60, TimeUnit.SECONDS);
        }
    }

    private List<Attempt> concurrentSubmit(
        Harness harness,
        SubmitCashflowSettlementCycleRequest first,
        SubmitCashflowSettlementCycleRequest second
    ) throws Exception {
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        try (ExecutorService executor = Executors.newFixedThreadPool(2)) {
            List<Future<Attempt>> futures = List.of(
                executor.submit(() -> submitAttempt(harness, first, ready, start)),
                executor.submit(() -> submitAttempt(harness, second, ready, start))
            );
            assertThat(ready.await(30, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            List<Attempt> attempts = new ArrayList<>();
            for (Future<Attempt> future : futures) {
                attempts.add(future.get(90, TimeUnit.SECONDS));
            }
            return List.copyOf(attempts);
        }
    }

    private Attempt submitAttempt(
        Harness harness,
        SubmitCashflowSettlementCycleRequest request,
        CountDownLatch ready,
        CountDownLatch start
    ) {
        ready.countDown();
        try {
            if (!start.await(30, TimeUnit.SECONDS)) {
                return Attempt.failure(new IllegalStateException("Concurrent submit start latch timed out."));
            }
            return Attempt.success(transaction(harness, () ->
                harness.service().submitCashflowSettlementCycle(
                    harness.approver(), harness.projectId(), request
                )
            ));
        } catch (Throwable error) {
            return Attempt.failure(error);
        }
    }

    private <T> T transaction(Harness harness, java.util.concurrent.Callable<T> action) {
        return harness.persistence().runCommandTransaction(action);
    }

    private void assertCommandArtifacts(Harness harness, String commandName, int expectedCount) throws Exception {
        long audits = projectDocuments(harness, "weekly_api_audit_events").values().stream()
            .filter(document -> commandName.equals(document.get("commandName")))
            .count();
        long receipts = projectDocuments(harness, "weekly_api_idempotency").values().stream()
            .filter(document -> commandName.equals(document.get("commandName")))
            .count();
        assertThat(audits).isEqualTo(expectedCount);
        assertThat(receipts).isEqualTo(expectedCount);
    }

    private void assertPeriod(Harness harness, String yearMonth, String period, String status) throws Exception {
        Map<String, Object> settlement = document(harness.settlementPath(yearMonth));
        assertThat(settlement)
            .containsEntry("tenantId", harness.tenantId())
            .containsEntry("projectId", harness.projectId())
            .containsEntry("yearMonth", yearMonth);
        assertThat(nestedMap(nestedMap(settlement.get("periods")).get(period)))
            .as(yearMonth + " " + period)
            .containsEntry("status", status);
    }

    private Map<String, Map<String, Map<String, Object>>> projectState(Harness harness) throws Exception {
        Map<String, Map<String, Map<String, Object>>> state = new TreeMap<>();
        for (String collection : PROJECT_STATE_COLLECTIONS) {
            state.put(collection, projectDocuments(harness, collection));
        }
        return state;
    }

    private Map<String, Map<String, Object>> projectDocuments(
        Harness harness,
        String collection
    ) throws Exception {
        List<QueryDocumentSnapshot> snapshots = db.collection(
            "orgs/" + harness.tenantId() + "/" + collection
        ).whereEqualTo("projectId", harness.projectId()).get().get(60, TimeUnit.SECONDS).getDocuments();
        Map<String, Map<String, Object>> documents = new TreeMap<>();
        for (QueryDocumentSnapshot snapshot : snapshots) {
            documents.put(snapshot.getId(), new LinkedHashMap<>(snapshot.getData()));
        }
        return documents;
    }

    private Map<String, String> projectUpdateTimes(Harness harness) throws Exception {
        Map<String, String> updateTimes = new TreeMap<>();
        for (String collection : PROJECT_STATE_COLLECTIONS) {
            for (QueryDocumentSnapshot snapshot : db.collection(
                "orgs/" + harness.tenantId() + "/" + collection
            ).whereEqualTo("projectId", harness.projectId()).get()
                .get(60, TimeUnit.SECONDS).getDocuments()) {
                updateTimes.put(collection + "/" + snapshot.getId(), snapshot.getUpdateTime().toString());
            }
        }
        return updateTimes;
    }

    private Map<String, Object> document(String path) throws Exception {
        DocumentSnapshot snapshot = db.document(path).get().get(60, TimeUnit.SECONDS);
        assertThat(snapshot.exists()).as(path).isTrue();
        return new LinkedHashMap<>(snapshot.getData());
    }

    private Map<String, Object> documentOrEmpty(String path) throws Exception {
        DocumentSnapshot snapshot = db.document(path).get().get(60, TimeUnit.SECONDS);
        return snapshot.exists() ? new LinkedHashMap<>(snapshot.getData()) : Map.of();
    }

    private static Map<String, Object> nestedMap(Object value) {
        if (!(value instanceof Map<?, ?> map)) return Map.of();
        Map<String, Object> nested = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            nested.put(String.valueOf(entry.getKey()), entry.getValue());
        }
        return nested;
    }

    private static Map<String, List<Object>> snapshotDifferences(
        Map<String, Object> left,
        Map<String, Object> right
    ) {
        Map<String, List<Object>> differences = new TreeMap<>();
        LinkedHashSet<String> keys = new LinkedHashSet<>(left.keySet());
        keys.addAll(right.keySet());
        for (String key : keys) {
            if (!Objects.equals(left.get(key), right.get(key))) {
                differences.put(key, java.util.Arrays.asList(left.get(key), right.get(key)));
            }
        }
        return differences;
    }

    private static List<String> monthsBetween(String from, String through) {
        YearMonth first = YearMonth.parse(from);
        YearMonth last = YearMonth.parse(through);
        long count = ChronoUnit.MONTHS.between(first, last) + 1;
        return java.util.stream.LongStream.range(0, count)
            .mapToObj(first::plusMonths)
            .map(YearMonth::toString)
            .toList();
    }

    private static Throwable rootCause(Throwable error) {
        if (error == null) return null;
        Throwable current = error;
        while (current.getCause() != null && current.getCause() != current) {
            current = current.getCause();
        }
        return current;
    }

    private static String requiredEnvironment(String key) {
        String value = System.getenv(key);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(
                key + " is required. Run scripts/test-settlement-cycle-emulator.sh."
            );
        }
        return value.trim();
    }

    private record Harness(
        String tenantId,
        String projectId,
        FirestoreInheritedWeeklyExpensePersistence persistence,
        WeeklyExpenseCommandService service,
        TrustedActorContext approver,
        TrustedActorContext admin
    ) {
        String projectPath() {
            return "orgs/" + tenantId + "/projects/" + projectId;
        }

        String memberPath(String uid) {
            return "orgs/" + tenantId + "/members/" + uid;
        }

        String personPath(String personId) {
            return "orgs/" + tenantId + "/persons/" + personId;
        }

        String requestPath() {
            return requestPath(projectId + "-2026-09");
        }

        String requestPath(String requestId) {
            return "orgs/" + tenantId + "/cashflow_month_close_requests/" + requestId;
        }

        String coordinatorPath() {
            return "orgs/" + tenantId + "/cashflow_month_close_requests/__active__-" + projectId;
        }

        String stagePath(String requestId, String stageId) {
            return requestPath(requestId) + "/stages/" + stageId;
        }

        String shardPath(String requestId, long revision, String yearMonth) {
            return "orgs/" + tenantId + "/cashflow_month_close_request_months/"
                + requestId + "-r" + revision + "-" + yearMonth;
        }

        String headPath() {
            return "orgs/" + tenantId + "/cashflow_cumulative_close_heads/" + projectId;
        }

        String monthlyClosePath() {
            return monthlyClosePath("2026-09");
        }

        String monthlyClosePath(String yearMonth) {
            return "orgs/" + tenantId + "/monthly_closes/" + projectId + "-" + yearMonth;
        }

        String monthlyCloseVersionPath(String versionId) {
            return "orgs/" + tenantId + "/monthly_close_versions/" + versionId;
        }

        String settlementPath(String yearMonth) {
            return "orgs/" + tenantId + "/cashflow_settlement_statuses/" + projectId + "-" + yearMonth;
        }

        String weeklyCompletionPath(String yearMonth, int weekNo) {
            return "orgs/" + tenantId + "/cashflow_weekly_update_completions/"
                + projectId + "-" + yearMonth + "-w" + weekNo;
        }

        String weeklyCompletionVersionPath(String yearMonth, int weekNo, long revision) {
            return "orgs/" + tenantId + "/cashflow_weekly_update_completion_versions/"
                + projectId + "-" + yearMonth + "-w" + weekNo + "-r" + revision;
        }
    }

    private record Evidence(
        String projectId,
        String cycleYearMonth,
        String targetYearMonth,
        String requestId,
        long evidenceRevision,
        String manifestHash,
        Map<String, Object> header,
        Map<String, Map<String, Object>> shards,
        String approverUid
    ) {
        SubmitCashflowSettlementCycleRequest submit(
            String idempotencyKey,
            String stageId,
            long expectedWorkflowRevision
        ) {
            return new SubmitCashflowSettlementCycleRequest(
                idempotencyKey,
                cycleYearMonth,
                targetYearMonth,
                requestId,
                stageId,
                evidenceRevision,
                manifestHash,
                expectedWorkflowRevision,
                approverUid,
                3
            );
        }

        CloseCashflowMonthRequest approval(
            String idempotencyKey,
            long expectedLedgerRevision,
            long expectedWorkflowRevision,
            String reason
        ) {
            return new CloseCashflowMonthRequest(
                idempotencyKey, "", "", cycleYearMonth,
                expectedLedgerRevision, 0, true,
                List.of(), List.of(), List.of(), List.of(), List.of(), null, null,
                requestId, evidenceRevision, manifestHash,
                cycleYearMonth, targetYearMonth, expectedWorkflowRevision, reason
            );
        }

        CloseCashflowMonthRequest directApproval(String idempotencyKey, long expectedLedgerRevision) {
            return new CloseCashflowMonthRequest(
                idempotencyKey, "", "", cycleYearMonth,
                expectedLedgerRevision, 0, false,
                List.of(), List.of(), List.of(), List.of(), List.of(), null, null,
                requestId, evidenceRevision, manifestHash
            );
        }
    }

    private record Attempt(CashflowSettlementCycleCommandResponse response, Throwable failure) {
        static Attempt success(CashflowSettlementCycleCommandResponse response) {
            return new Attempt(response, null);
        }

        static Attempt failure(Throwable error) {
            return new Attempt(null, error);
        }

        boolean succeeded() {
            return response != null;
        }
    }

    private static final class ForcedTransactionAbort extends RuntimeException {
    }
}
