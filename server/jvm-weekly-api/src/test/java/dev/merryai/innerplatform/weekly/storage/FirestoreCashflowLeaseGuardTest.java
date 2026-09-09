package dev.merryai.innerplatform.weekly.storage;

import dev.merryai.innerplatform.weekly.domain.CashflowAnnualCellSet;
import dev.merryai.innerplatform.weekly.service.command.CashflowSheetAnnualApplyCommand;
import dev.merryai.innerplatform.weekly.domain.CashflowCumulativeCloseHead;
import dev.merryai.innerplatform.weekly.domain.CashflowLedgerSource;
import dev.merryai.innerplatform.weekly.domain.CashflowMonthCloseState;
import dev.merryai.innerplatform.weekly.domain.CashflowMonthReopenPolicy;
import dev.merryai.innerplatform.weekly.domain.CashflowSettlementCyclePolicy;
import dev.merryai.innerplatform.weekly.domain.CashflowOpeningBalance;
import dev.merryai.innerplatform.weekly.service.command.CashflowMonthReopenCommands;
import dev.merryai.innerplatform.weekly.service.port.CashflowReadPort;
import com.google.api.core.ApiFutures;
import com.google.cloud.firestore.CollectionReference;
import com.google.cloud.firestore.DocumentReference;
import com.google.cloud.firestore.DocumentSnapshot;
import com.google.cloud.firestore.Firestore;
import com.google.cloud.firestore.Query;
import com.google.cloud.firestore.QueryDocumentSnapshot;
import com.google.cloud.firestore.QuerySnapshot;
import com.google.cloud.firestore.Transaction;
import com.google.cloud.firestore.TransactionOptions;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.merryai.innerplatform.weekly.api.CashflowEditSession;
import dev.merryai.innerplatform.weekly.api.CancelCashflowSettlementCycleRequest;
import dev.merryai.innerplatform.weekly.api.CashflowSettlementCycleCommandResponse;
import dev.merryai.innerplatform.weekly.api.CashflowMonthCloseResponse;
import dev.merryai.innerplatform.weekly.api.CashflowPendingApprovalAffectedMonth;
import dev.merryai.innerplatform.weekly.api.CashflowOpeningBalancesResponse;
import dev.merryai.innerplatform.weekly.api.CashflowOpeningBalanceCell;
import dev.merryai.innerplatform.weekly.api.CashflowSheetBatchApplyRequest;
import dev.merryai.innerplatform.weekly.api.CashflowSheetBatchApplyResponse;
import dev.merryai.innerplatform.weekly.api.CashflowSheetLabApplyRequest;
import dev.merryai.innerplatform.weekly.api.CashflowSheetLabApplyResponse;
import dev.merryai.innerplatform.weekly.api.CashflowVarianceRequest;
import dev.merryai.innerplatform.weekly.api.CashflowVarianceResponse;
import dev.merryai.innerplatform.weekly.api.CloseCashflowMonthRequest;
import dev.merryai.innerplatform.weekly.api.CompleteCashflowWeeklyUpdateRequest;
import dev.merryai.innerplatform.weekly.api.CashflowSettlementCycleHeadMigrationResponse;
import dev.merryai.innerplatform.weekly.api.CashflowWeeklyUpdateCompletionResponse;
import dev.merryai.innerplatform.weekly.api.CashflowWeeklyComplianceHistoryResponse;
import dev.merryai.innerplatform.weekly.api.CloseWeekRequest;
import dev.merryai.innerplatform.weekly.api.ConfirmCashflowWeeklyUpdateRequest;
import dev.merryai.innerplatform.weekly.api.ReopenCashflowWeeklyUpdateRequest;
import dev.merryai.innerplatform.weekly.api.MigrateCashflowSettlementCycleHeadV2Request;
import dev.merryai.innerplatform.weekly.api.NormalizeLegacyCashflowSettlementCycleRequest;
import dev.merryai.innerplatform.weekly.api.CashflowSettlementCycleLegacyRequestNormalizationResponse;
import dev.merryai.innerplatform.weekly.api.SaveDraftResponse;
import dev.merryai.innerplatform.weekly.api.SaveDraftRequest;
import dev.merryai.innerplatform.weekly.api.SubmitWeekRequest;
import dev.merryai.innerplatform.weekly.api.SubmitCashflowSettlementCycleRequest;
import dev.merryai.innerplatform.weekly.api.TransitionCashflowSettlementCycleRequest;
import dev.merryai.innerplatform.weekly.api.TrustedActorContext;
import dev.merryai.innerplatform.weekly.api.UpsertProjectionRequest;
import dev.merryai.innerplatform.weekly.api.UpsertProjectionResponse;
import dev.merryai.innerplatform.weekly.api.WeeklyExpenseEditLeaseException;
import dev.merryai.innerplatform.weekly.api.WeeklyExpenseConflictException;
import dev.merryai.innerplatform.weekly.api.WeeklyExpenseForbiddenException;
import dev.merryai.innerplatform.weekly.domain.CashflowLineCatalog;
import dev.merryai.innerplatform.weekly.domain.CashflowSettlementCycleWorkflow;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseActualEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseProjectionEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseIdempotencyEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseSheetEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseWeeklyStatusEntity;
import dev.merryai.innerplatform.weekly.service.WeeklyExpenseAuthorizationService;
import dev.merryai.innerplatform.weekly.service.WeeklyExpenseCommandService;
import dev.merryai.innerplatform.weekly.service.WeeklyProjectExistenceRepository;
import dev.merryai.innerplatform.weekly.service.port.CashflowMonthReopenPort;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class FirestoreCashflowLeaseGuardTest {
    private static final String SOURCE_REVISION = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final Instant NOW = Instant.parse("2026-07-10T10:00:00Z");
    private static final TrustedActorContext ACTOR = new TrustedActorContext(
        "tenant-a",
        "pm-1",
        "pm@example.com",
        "spoofed-client-role"
    );
    private static final TrustedActorContext READ_ACTOR = new TrustedActorContext(
        "tenant-a",
        "pm-1",
        "pm@example.com",
        "viewer"
    );
    private static final TrustedActorContext FINANCE_ACTOR = new TrustedActorContext(
        "tenant-a",
        "finance-1",
        "finance@example.com",
        "finance"
    );
    private static final CashflowEditSession SESSION = new CashflowEditSession(
        "stage-data-project",
        "session-a",
        "lease-a",
        7
    );
    private static final CashflowEditSession FINAL_SESSION = new CashflowEditSession(
        "stage-data-project",
        "session-a",
        "lease-a",
        7,
        true
    );

    @Test
    void readsTheScopedAuthoritativeIdempotencyRecordWithoutStageDocumentFallbacks() {
        Fixture fixture = fixture(activeMember(), activeLease());
        String path = idempotencyPath(
            "tenant-a",
            "project-a",
            WeeklyExpenseCommandService.CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            "operation-key"
        );
        fixture.documents.put(path, Map.of(
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "idempotencyKey", "operation-key",
            "commandName", WeeklyExpenseCommandService.CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            "requestHash", "request-hash",
            "responseJson", "{\"projectId\":\"project-a\",\"yearMonth\":\"2026-07\"}",
            "createdAt", "2026-07-30T01:02:03Z"
        ));

        WeeklyExpenseIdempotencyEntity found = fixture.persistence.findIdempotency(
            "tenant-a",
            "project-a",
            WeeklyExpenseCommandService.CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            "operation-key"
        ).orElseThrow();

        assertThat(found.getTenantId()).isEqualTo("tenant-a");
        assertThat(found.getProjectId()).isEqualTo("project-a");
        assertThat(found.getIdempotencyKey()).isEqualTo("operation-key");
        assertThat(found.getCreatedAt()).isEqualTo(Instant.parse("2026-07-30T01:02:03Z"));
        verify(fixture.db).document(path);
    }

    @Test
    void propagatesFirestoreIdempotencyReadFailureInsteadOfReportingNotFound() {
        Fixture fixture = fixture(activeMember(), activeLease());
        String path = idempotencyPath(
            "tenant-a",
            "project-a",
            WeeklyExpenseCommandService.CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            "read-failure"
        );
        DocumentReference failing = mock(DocumentReference.class);
        when(failing.getPath()).thenReturn(path);
        when(failing.get()).thenReturn(ApiFutures.immediateFailedFuture(new RuntimeException("Firestore unavailable")));
        when(fixture.db.document(path)).thenReturn(failing);

        assertThatThrownBy(() -> fixture.persistence.findIdempotency(
            "tenant-a",
            "project-a",
            WeeklyExpenseCommandService.CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            "read-failure"
        ))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("Could not read Firestore document")
            .hasRootCauseMessage("Firestore unavailable");
    }

    @Test
    void isolatesFailedSettlementStatusReadAndKeepsStoredStatus() {
        Fixture fixture = fixture(activeMember(), activeLease());
        String successPath = "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08";
        fixture.documents.put(successPath, Map.of("periods", Map.of(
            "MONTH", Map.of("status", "COMPLETED", "revision", 3)
        )));
        String failedPath = "orgs/tenant-a/cashflow_settlement_statuses/project-b-2026-08";
        DocumentReference failing = mock(DocumentReference.class);
        when(failing.getPath()).thenReturn(failedPath);
        when(failing.get()).thenReturn(ApiFutures.immediateFailedFuture(new RuntimeException("Firestore unavailable")));
        when(fixture.db.document(failedPath)).thenReturn(failing);

        Map<String, List<WeeklyExpensePersistence.CashflowSettlementStatusRecord>> result =
            fixture.persistence.findCashflowSettlementStatusesBatch(
                "tenant-a", List.of("project-a", "project-b"), "2026-08"
            );

        assertThat(result).containsOnlyKeys("project-a");
        assertThat(result.get("project-a")).hasSize(6);
        assertThat(result.get("project-a").getFirst().status()).isEqualTo("COMPLETED");
    }

    @Test
    void readsWeeklySettlementStatusBeforeTheFirstTransactionalWrite() {
        Fixture fixture = fixture(activeMember(), Map.of());
        putCompleteProjectionWindow(fixture, "2026-08", 2);

        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .completeCashflowWeeklyUpdate(
                ACTOR,
                "project-a",
                new CompleteCashflowWeeklyUpdateRequest(
                    "read-before-write", "2026-08", 2, "2026-08-04T01:21:00Z", "NO_CHANGES"
                )
            ));

        InOrder order = inOrder(fixture.transaction);
        order.verify(fixture.transaction).get(fixture.refs.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08"
        ));
        order.verify(fixture.transaction).set(argThat(ref -> ref.getPath().equals(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-08-w2"
        )), any(), any());
    }

    @Test
    void writesCanonicalJanuaryAndAugustWeeklySettlementKeys() {
        Fixture january = fixture(activeMember(), Map.of());
        Fixture august = fixture(activeMember(), Map.of());
        putCompleteProjectionWindow(january, "2026-01", 1);
        putCompleteProjectionWindow(august, "2026-08", 2);

        january.persistence.runCommandTransaction(() -> commandService(january.persistence)
            .completeCashflowWeeklyUpdate(
                ACTOR,
                "project-a",
                new CompleteCashflowWeeklyUpdateRequest(
                    "january-week-one", "2026-01", 1, "2026-01-02T01:00:00Z", "NO_CHANGES"
                )
            ));
        august.persistence.runCommandTransaction(() -> commandService(august.persistence)
            .completeCashflowWeeklyUpdate(
                ACTOR,
                "project-a",
                new CompleteCashflowWeeklyUpdateRequest(
                    "august-week-two", "2026-08", 2, "2026-08-04T01:21:00Z", "NO_CHANGES"
                )
            ));

        assertThat(january.documents)
            .containsKey("orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-01-w1")
            .containsKey("orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-01");
        assertThat(((Map<?, ?>) ((Map<?, ?>) january.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-01"
        ).get("periods")).get("WEEK_1")).get("status")).isEqualTo("PENDING_APPROVAL");
        assertThat(august.documents)
            .containsKey("orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-08-w2")
            .containsKey("orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08");
        assertThat(((Map<?, ?>) ((Map<?, ?>) august.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08"
        ).get("periods")).get("WEEK_2")).get("status")).isEqualTo("PENDING_APPROVAL");
    }

    @Test
    void rejectsManagerApprovalBeforeWeeklyCompletion() {
        Fixture fixture = fixture(activeMember(), Map.of());
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a",
            "tenantId", "tenant-a",
            "executiveApproverId", "manager-1"
        ));
        TrustedActorContext manager = new TrustedActorContext(
            "tenant-a", "manager-1", "manager@example.com", "manager", "Manager"
        );

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
            fixture.persistence.transitionCashflowSettlementStatus(
                manager, "project-a", "2026-08", "WEEK_2", "APPROVE"
            )
        ))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("status changed");
    }

    @Test
    void allowsManagerApprovalAfterWeeklyCompletion() {
        Fixture fixture = fixture(activeMember(), Map.of());
        putCompleteProjectionWindow(fixture, "2026-08", 2);
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a",
            "tenantId", "tenant-a",
            "executiveApproverId", "manager-1"
        ));
        TrustedActorContext manager = new TrustedActorContext(
            "tenant-a", "manager-1", "manager@example.com", "manager", "Manager"
        );

        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .completeCashflowWeeklyUpdate(
                ACTOR,
                "project-a",
                new CompleteCashflowWeeklyUpdateRequest(
                    "complete-then-approve", "2026-08", 2, "2026-08-04T01:21:00Z", "NO_CHANGES"
                )
            ));
        WeeklyExpensePersistence.CashflowSettlementStatusRecord approved = fixture.persistence
            .runCommandTransaction(() -> fixture.persistence.transitionCashflowSettlementStatus(
                manager, "project-a", "2026-08", "WEEK_2", "APPROVE"
            ));

        assertThat(approved.status()).isEqualTo("COMPLETED");
        assertThat(approved.approvedBy()).isEqualTo("Manager");
        Map<?, ?> week = (Map<?, ?>) ((Map<?, ?>) fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08"
        ).get("periods")).get("WEEK_2");
        assertThat(week.get("status")).isEqualTo("COMPLETED");
    }

    @Test
    void preservesTheLegacyMonthSettlementTransitionUntilTheBffCutover() {
        Fixture fixture = fixture(activeMember(), Map.of());
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a",
            "tenantId", "tenant-a",
            "executiveApproverId", "manager-1"
        ));
        fixture.documents.put("orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08", Map.of(
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-08",
            "periods", Map.of("MONTH", Map.of("status", "PENDING_APPROVAL", "revision", 1L))
        ));
        TrustedActorContext manager = new TrustedActorContext(
            "tenant-a", "manager-1", "manager@example.com", "manager", "Manager"
        );
        WeeklyExpensePersistence.CashflowSettlementStatusRecord approved =
            fixture.persistence.runCommandTransaction(() ->
            fixture.persistence.transitionCashflowSettlementStatus(
                manager, "project-a", "2026-08", "MONTH", "APPROVE"
            ));

        assertThat(approved.status()).isEqualTo("COMPLETED");
        assertThat(approved.approvedBy()).isEqualTo("Manager");
        assertThat(((Map<?, ?>) ((Map<?, ?>) fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08"
        ).get("periods")).get("MONTH")).get("status")).isEqualTo("COMPLETED");
    }

    @Test
    void validatesStoredMemberAndLeaseInTheSameTransactionAsCanonicalWrite() {
        Fixture fixture = fixture(activeMember(), activeLease());

        assertThatCode(() -> fixture.persistence.runCommandTransaction(() -> {
            org.assertj.core.api.Assertions.assertThat(
                fixture.persistence.requireCashflowWriteLease(ACTOR, "project-a", SESSION)
            ).isEqualTo("pm");
            WeeklyExpenseProjectionEntity projection = new WeeklyExpenseProjectionEntity(
                "tenant-a", "project-a", "2026-07", 1, "SALES_IN"
            );
            projection.setAmount(BigDecimal.valueOf(1000));
            fixture.persistence.saveProjection(projection);
            return null;
        })).doesNotThrowAnyException();

        verify(fixture.transaction).get(fixture.refs.get("orgs/tenant-a/members/pm-1"));
        verify(fixture.transaction).get(fixture.refs.get(leasePath("project-a")));
        verify(fixture.transaction).set(any(DocumentReference.class), any(), any());
        assertThat(fixture.documents.get(leasePath("project-a")))
            .containsEntry("state", "ACTIVE")
            .doesNotContainKeys("releasedAt", "releaseReason");
    }

    @Test
    void finalCommandCommitsCanonicalWriteAndExactLeaseReleaseTogether() {
        Fixture fixture = fixture(activeMember(), activeLease());

        fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWriteLease(ACTOR, "project-a", FINAL_SESSION);
            fixture.persistence.saveProjection(projection("project-a"));
            return null;
        });

        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_weeks/project-a-2026-07-w1"))
            .containsEntry("projectId", "project-a")
            .containsEntry("projectionUpdated", true)
            .containsKey("projection");
        assertThat(fixture.documents.get(leasePath("project-a")))
            .containsEntry("state", "RELEASED")
            .containsEntry("releaseReason", "FINAL_SAVE")
            .containsEntry("leaseId", "lease-a")
            .containsEntry("fence", 7L);
    }

    @Test
    void projectionWritePersistsCanonicalDataWithoutChangingAnExistingLease() {
        Fixture fixture = fixture(activeMember(), activeLease());
        WeeklyExpenseCommandService service = commandService(fixture.persistence);

        UpsertProjectionResponse response = fixture.persistence.runCommandTransaction(() -> service.upsertProjection(
            ACTOR,
            "project-a",
            FINAL_SESSION,
            new UpsertProjectionRequest("projection-without-lease", List.of(
                new UpsertProjectionRequest.ProjectionLinePatch(
                    "2026-07", 1, "SALES_IN", BigDecimal.ONE
                )
            ))
        ));

        assertThat(response.savedLineCount()).isEqualTo(1);
        assertThat(fixture.documents.keySet())
            .anyMatch(path -> path.startsWith("orgs/tenant-a/weekly_api_audit_events/"))
            .anyMatch(path -> path.startsWith("orgs/tenant-a/weekly_api_idempotency/"));
        assertThat(fixture.documents.keySet())
            .anyMatch(path -> path.startsWith("orgs/tenant-a/cashflow_weeks/"));
        assertThat(fixture.documents.get(leasePath("project-a")))
            .containsEntry("state", "ACTIVE")
            .containsEntry("sessionId", "session-a")
            .containsEntry("leaseId", "lease-a")
            .containsEntry("fence", 7L)
            .doesNotContainKeys("releasedAt", "releaseReason");
    }

    @Test
    void projectionCommandPreservesExistingAndMultipleSameWeekLines() {
        Fixture fixture = fixture(activeMember(), activeLease());
        String path = "orgs/tenant-a/cashflow_weeks/project-a-2026-07-w1";
        fixture.documents.put(path, new LinkedHashMap<>(Map.of(
            "id", "project-a-2026-07-w1",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-07",
            "weekNo", 1,
            "projection", new LinkedHashMap<>(Map.of("BANK_INTEREST_IN", 7L))
        )));

        UpsertProjectionResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).upsertProjection(
            ACTOR,
            "project-a",
            SESSION,
            new UpsertProjectionRequest("projection-same-week-merge", List.of(
                new UpsertProjectionRequest.ProjectionLinePatch(
                    "2026-07", 1, "SALES_IN", BigDecimal.valueOf(2_300_000)
                ),
                new UpsertProjectionRequest.ProjectionLinePatch(
                    "2026-07", 1, "MYSC_LABOR_OUT", BigDecimal.valueOf(300_000)
                )
            ))
        ));

        assertThat(response.savedLineCount()).isEqualTo(2);
        assertThat((Map<String, Object>) fixture.documents.get(path).get("projection"))
            .containsEntry("BANK_INTEREST_IN", 7L)
            .containsEntry("SALES_IN", 2_300_000L)
            .containsEntry("MYSC_LABOR_OUT", 300_000L);
    }

    @Test
    void projectionCommandPersistsAnExplicitZeroForAPreviouslyMissingLine() {
        Fixture fixture = fixture(activeMember(), activeLease());

        UpsertProjectionResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).upsertProjection(
            ACTOR,
            "project-a",
            SESSION,
            new UpsertProjectionRequest("projection-explicit-zero", List.of(
                new UpsertProjectionRequest.ProjectionLinePatch(
                    "2026-07", 3, "MYSC_LABOR_OUT", BigDecimal.ZERO
                )
            ))
        ));

        assertThat(response.savedLineCount()).isEqualTo(1);
        assertThat((Map<String, Object>) fixture.documents.get(
            "orgs/tenant-a/cashflow_weeks/project-a-2026-07-w3"
        ).get("projection"))
            .containsEntry("MYSC_LABOR_OUT", 0L);
    }

    @Test
    void lockedNoOpProjectionDoesNotBlockAChangedOpenWeekInTheSameCommand() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weeks/project-a-2026-07-w3",
            new LinkedHashMap<>(Map.of(
                "id", "project-a-2026-07-w3",
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "yearMonth", "2026-07",
                "weekNo", 3,
                "projection", Map.of("SALES_IN", 100L)
            ))
        );
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3",
            lockedWeeklyCompletion("2026-07", 3, 1)
        );

        UpsertProjectionResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).upsertProjection(
            ACTOR,
            "project-a",
            SESSION,
            new UpsertProjectionRequest("locked-noop-open-change", List.of(
                new UpsertProjectionRequest.ProjectionLinePatch(
                    "2026-07", 3, "SALES_IN", BigDecimal.valueOf(100)
                ),
                new UpsertProjectionRequest.ProjectionLinePatch(
                    "2026-07", 4, "SALES_IN", BigDecimal.valueOf(200)
                )
            ))
        ));

        assertThat(response.savedLineCount()).isEqualTo(1);
        assertThat((Map<String, Object>) fixture.documents.get(
            "orgs/tenant-a/cashflow_weeks/project-a-2026-07-w4"
        ).get("projection"))
            .containsEntry("SALES_IN", 200L);
    }

    @Test
    void noChangeFinalRejectsWrongSessionOrFenceWithoutAnyWrite() {
        for (CashflowEditSession invalid : List.of(
            new CashflowEditSession("stage-data-project", "session-other", "lease-a", 7, true),
            new CashflowEditSession("stage-data-project", "session-a", "lease-a", 8, true)
        )) {
            Fixture fixture = fixture(activeMember(), activeLease());

            assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> {
                fixture.persistence.requireCashflowWriteLease(ACTOR, "project-a", invalid);
                return null;
            }))
                .isInstanceOf(WeeklyExpenseEditLeaseException.class)
                .extracting(error -> ((WeeklyExpenseEditLeaseException) error).statusCode())
                .isEqualTo(423);
            verify(fixture.transaction, never()).set(any(DocumentReference.class), any(), any());
            assertThat(fixture.documents.get(leasePath("project-a")))
                .containsEntry("state", "ACTIVE")
                .doesNotContainKeys("releasedAt", "releaseReason");
        }
    }

    @Test
    void compoundCloseCommitsProjectionStatusAndLeaseReleaseTogether() {
        Fixture fixture = fixture(
            member(Map.of("role", "finance", "projectIds", List.of())),
            activeLease()
        );
        fixture.documents.put(weekPath(), submittedWeek());

        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence).closeWeek(
            ACTOR,
            "project-a",
            FINAL_SESSION,
            closeRequest("compound-close-success", BigDecimal.valueOf(2500))
        ));

        assertThat(fixture.documents.get(weekPath()))
            .containsEntry("weeklyStatusState", "closed")
            .containsEntry("adminClosed", true);
        assertThat((Map<String, Object>) fixture.documents.get(weekPath()).get("projection"))
            .containsEntry("SALES_IN", 2500L);
        assertThat(fixture.documents.get(leasePath("project-a")))
            .containsEntry("state", "RELEASED")
            .containsEntry("releaseReason", "FINAL_SAVE");
    }

    @Test
    void compoundCloseStatusFailureRollsBackStagedProjectionAndLeaseRelease() {
        Fixture fixture = fixture(
            member(Map.of("role", "finance", "projectIds", List.of())),
            activeLease()
        );
        fixture.documents.put(weekPath(), draftWeek());
        Map<String, Object> weekBefore = new LinkedHashMap<>(fixture.documents.get(weekPath()));
        Map<String, Object> leaseBefore = new LinkedHashMap<>(fixture.documents.get(leasePath("project-a")));

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence).closeWeek(
            ACTOR,
            "project-a",
            FINAL_SESSION,
            closeRequest("compound-close-failure", BigDecimal.valueOf(9999))
        ))).isInstanceOf(dev.merryai.innerplatform.weekly.api.WeeklyExpenseConflictException.class);

        assertThat(fixture.documents.get(weekPath())).isEqualTo(weekBefore);
        assertThat(fixture.documents.get(leasePath("project-a"))).isEqualTo(leaseBefore);
    }

    @Test
    void compoundSubmitCommitsRowsActualStatusAndLeaseReleaseTogether() {
        Fixture fixture = fixture(activeMember(), activeLease());

        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence).submitWeek(
            ACTOR,
            "project-a",
            FINAL_SESSION,
            submitRequest("compound-submit-success")
        ));

        assertThat(fixture.documents.get(weekPath()))
            .containsEntry("weeklyStatusState", "submitted")
            .containsEntry("pmSubmitted", true)
            .containsKey("actual");
        assertThat(fixture.documents.get(sheetPath()))
            .containsEntry("projectId", "project-a")
            .containsKey("rows");
        assertThat(fixture.documents.get(leasePath("project-a")))
            .containsEntry("state", "RELEASED")
            .containsEntry("releaseReason", "FINAL_SAVE");
    }

    @Test
    void compoundSubmitStatusFailureRollsBackStagedRowsActualAndLeaseRelease() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(weekPath(), closedWeek());
        Map<String, Object> weekBefore = new LinkedHashMap<>(fixture.documents.get(weekPath()));
        Map<String, Object> leaseBefore = new LinkedHashMap<>(fixture.documents.get(leasePath("project-a")));

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence).submitWeek(
            ACTOR,
            "project-a",
            FINAL_SESSION,
            submitRequest("compound-submit-failure")
        ))).isInstanceOf(dev.merryai.innerplatform.weekly.api.WeeklyExpenseConflictException.class);

        assertThat(fixture.documents).doesNotContainKey(sheetPath());
        assertThat(fixture.documents.get(weekPath())).isEqualTo(weekBefore);
        assertThat(fixture.documents.get(leasePath("project-a"))).isEqualTo(leaseBefore);
    }

    @Test
    void failedFinalCommandRollsBackCanonicalWriteAndLeaseRelease() {
        Fixture fixture = fixture(activeMember(), activeLease());
        Map<String, Object> leaseBefore = new LinkedHashMap<>(fixture.documents.get(leasePath("project-a")));

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWriteLease(ACTOR, "project-a", FINAL_SESSION);
            fixture.persistence.saveProjection(projection("project-a"));
            throw new IllegalStateException("fail after canonical write");
        })).isInstanceOf(IllegalStateException.class);

        assertThat(fixture.documents).doesNotContainKey("orgs/tenant-a/cashflow_weeks/project-a-2026-07-w1");
        assertThat(fixture.documents.get(leasePath("project-a"))).isEqualTo(leaseBefore);
    }

    @Test
    void rejectsExpiredOrReleasedLeaseBeforeAnyCanonicalWrite() {
        for (Map<String, Object> invalid : List.of(
            lease(Map.of("expiresAt", NOW.toString())),
            lease(Map.of("state", "RELEASED", "expiresAt", NOW.plusSeconds(600).toString()))
        )) {
            Fixture fixture = fixture(activeMember(), invalid);

            assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> {
                fixture.persistence.requireCashflowWriteLease(ACTOR, "project-a", SESSION);
                return null;
            }))
                .isInstanceOf(WeeklyExpenseEditLeaseException.class)
                .extracting(error -> ((WeeklyExpenseEditLeaseException) error).statusCode())
                .isEqualTo(410);
            verify(fixture.transaction, never()).set(any(DocumentReference.class), any(), any());
        }
    }

    @Test
    void rejectsStaleFenceAfterReacquireAndResourceMismatch() {
        for (Map<String, Object> invalid : List.of(
            lease(Map.of("leaseId", "lease-new", "fence", 8L)),
            lease(Map.of("resourceId", "project-b")),
            lease(Map.of("tenantId", "tenant-b"))
        )) {
            Fixture fixture = fixture(activeMember(), invalid);

            assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> {
                fixture.persistence.requireCashflowWriteLease(ACTOR, "project-a", SESSION);
                return null;
            }))
                .isInstanceOf(WeeklyExpenseEditLeaseException.class)
                .extracting(error -> ((WeeklyExpenseEditLeaseException) error).statusCode())
                .isEqualTo(423);
            verify(fixture.transaction, never()).set(any(DocumentReference.class), any(), any());
        }
    }

    @Test
    void rejectsMismatchedDataProjectAndUnassignedStoredMemberRole() {
        Fixture projectMismatch = fixture(activeMember(), activeLease());
        CashflowEditSession wrongProject = new CashflowEditSession("other-data-project", "session-a", "lease-a", 7);
        assertThatThrownBy(() -> projectMismatch.persistence.runCommandTransaction(() -> {
            projectMismatch.persistence.requireCashflowWriteLease(ACTOR, "project-a", wrongProject);
            return null;
        }))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .extracting(error -> ((WeeklyExpenseEditLeaseException) error).statusCode())
            .isEqualTo(503);

        Fixture unassigned = fixture(member(Map.of("role", "viewer", "projectIds", List.of("project-b"))), activeLease());
        assertThatThrownBy(() -> unassigned.persistence.runCommandTransaction(() -> {
            unassigned.persistence.requireCashflowWriteLease(ACTOR, "project-a", SESSION);
            return null;
        }))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .extracting(error -> ((WeeklyExpenseEditLeaseException) error).statusCode())
            .isEqualTo(403);
    }

    @Test
    void allowsAssignedViewerToUseCashflowLeaseForSheetApplyAuthorization() {
        Fixture fixture = fixture(
            member(Map.of("role", "viewer", "projectIds", List.of("project-a"))),
            activeLease()
        );

        assertThat(fixture.persistence.runCommandTransaction(() ->
            fixture.persistence.requireCashflowWriteLease(ACTOR, "project-a", SESSION)
        )).isEqualTo("viewer");
    }

    @Test
    void allowsActiveDesignatedOrganizationHeadForMonthCloseWithoutOpeningGeneralWrites() {
        Fixture fixture = fixture(
            member(Map.of("role", "viewer", "projectIds", List.of())),
            activeLease()
        );
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a",
            "tenantId", "tenant-a",
            "executiveApproverId", "pm-1"
        ));

        assertThat(fixture.persistence.runCommandTransaction(() ->
            fixture.persistence.requireCashflowMonthClosePermission(ACTOR, "project-a")
        )).isEqualTo("viewer");

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
            fixture.persistence.requireCashflowWritePermission(ACTOR, "project-a")
        ))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .extracting(error -> ((WeeklyExpenseEditLeaseException) error).statusCode())
            .isEqualTo(403);
    }

    @Test
    void rejectsInactiveDesignatedOrganizationHeadForMonthClose() {
        Fixture fixture = fixture(
            member(Map.of("role", "viewer", "status", "INACTIVE", "projectIds", List.of())),
            activeLease()
        );
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a",
            "tenantId", "tenant-a",
            "executiveApproverId", "pm-1"
        ));

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
            fixture.persistence.requireCashflowMonthClosePermission(ACTOR, "project-a")
        ))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .extracting(error -> ((WeeklyExpenseEditLeaseException) error).statusCode())
            .isEqualTo(403);
    }

    @Test
    void reopenDecisionAllowsOnlyExactActiveOrganizationHeadOrRuntimeAdmin() {
        for (String role : List.of("pm", "viewer")) {
            Fixture head = fixture(member(Map.of("role", role, "projectIds", List.of())), Map.of());
            head.documents.put("orgs/tenant-a/projects/project-a", Map.of(
                "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1"
            ));

            assertThat(head.persistence.runCommandTransaction(() ->
                authorizeMonthReopenDecision(head.persistence, ACTOR, "project-a")
            ).storedRole()).isEqualTo(role);
        }

        Fixture pathIdentifiedHead = fixture(member(Map.of("role", "viewer", "projectIds", List.of())), Map.of());
        pathIdentifiedHead.documents.put(
            "orgs/tenant-a/projects/project-a",
            Map.of("executiveApproverId", "pm-1")
        );
        assertThat(pathIdentifiedHead.persistence.runCommandTransaction(() ->
            authorizeMonthReopenDecision(pathIdentifiedHead.persistence, ACTOR, "project-a")
        ).storedRole()).isEqualTo("viewer");

        Fixture admin = fixture(member(Map.of("role", "admin", "projectIds", List.of())), Map.of());
        admin.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "someone-else"
        ));
        assertThat(admin.persistence.runCommandTransaction(() ->
            authorizeMonthReopenDecision(admin.persistence, ACTOR, "project-a")
        ).storedRole()).isEqualTo("admin");

        for (String role : List.of("finance", "pm", "viewer")) {
            Fixture denied = fixture(member(Map.of("role", role, "projectIds", List.of("project-a"))), Map.of());
            denied.documents.put("orgs/tenant-a/projects/project-a", Map.of(
                "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "someone-else"
            ));

            assertThatThrownBy(() -> denied.persistence.runCommandTransaction(() ->
                authorizeMonthReopenDecision(denied.persistence, ACTOR, "project-a")
            ))
                .isInstanceOfSatisfying(CashflowMonthReopenPolicy.Violation.class, error ->
                    assertThat(error.reason()).isEqualTo(
                        CashflowMonthReopenPolicy.ViolationReason.DECISION_FORBIDDEN
                    ));
            assertThat(denied.pendingWrites).isEmpty();
        }

        Fixture mismatchedProject = fixture(member(Map.of("role", "admin", "projectIds", List.of())), Map.of());
        mismatchedProject.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "another-project", "tenantId", "tenant-a", "executiveApproverId", "pm-1"
        ));
        assertThatThrownBy(() -> mismatchedProject.persistence.runCommandTransaction(() ->
            authorizeMonthReopenDecision(mismatchedProject.persistence, ACTOR, "project-a")
        ))
            .isInstanceOfSatisfying(CashflowMonthReopenPolicy.Violation.class, error ->
                assertThat(error.reason()).isEqualTo(
                    CashflowMonthReopenPolicy.ViolationReason.DECISION_FORBIDDEN
                ));
        assertThat(mismatchedProject.pendingWrites).isEmpty();
    }

    @Test
    void reopenDecisionRejectsAdminWithoutExactlyOneCanonicalPeopleUid() {
        Fixture unlinked = fixture(member(Map.of("role", "admin", "projectIds", List.of())), Map.of());
        unlinked.documents.remove("orgs/tenant-a/persons/person-pm-1");
        unlinked.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "someone-else"
        ));

        assertThatThrownBy(() -> unlinked.persistence.runCommandTransaction(() ->
            authorizeMonthReopenDecision(unlinked.persistence, ACTOR, "project-a")
        ))
            .isInstanceOfSatisfying(CashflowMonthReopenPolicy.Violation.class, error ->
                assertThat(error.reason()).isEqualTo(
                    CashflowMonthReopenPolicy.ViolationReason.DECISION_FORBIDDEN
                ));

        Fixture ambiguous = fixture(member(Map.of("role", "admin", "projectIds", List.of())), Map.of());
        ambiguous.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "someone-else"
        ));
        ambiguous.documents.put("orgs/tenant-a/persons/person-pm-1-duplicate", Map.of("uid", "pm-1"));

        assertThatThrownBy(() -> ambiguous.persistence.runCommandTransaction(() ->
            authorizeMonthReopenDecision(ambiguous.persistence, ACTOR, "project-a")
        ))
            .isInstanceOfSatisfying(CashflowMonthReopenPolicy.Violation.class, error ->
                assertThat(error.reason()).isEqualTo(
                    CashflowMonthReopenPolicy.ViolationReason.DECISION_FORBIDDEN
                ));
    }

    @Test
    void usesStoredRoleForCrossProjectAccessAndRequiresCanonicalProjectInTransaction() {
        Fixture finance = fixture(member(Map.of("role", "finance", "projectIds", List.of())), activeLease());
        assertThatCode(() -> finance.persistence.runCommandTransaction(() -> {
            finance.persistence.requireCashflowWriteLease(ACTOR, "project-a", SESSION);
            return null;
        })).doesNotThrowAnyException();

        Fixture missingProject = fixture(activeMember(), activeLease(), false);
        assertThatThrownBy(() -> missingProject.persistence.runCommandTransaction(() -> {
            missingProject.persistence.requireCashflowWriteLease(ACTOR, "project-a", SESSION);
            return null;
        }))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .extracting(error -> ((WeeklyExpenseEditLeaseException) error).statusCode())
            .isEqualTo(403);
        verify(missingProject.transaction, never()).set(any(DocumentReference.class), any(), any());
    }

    @Test
    void everyCashflowWeekWriterFailsClosedWithoutValidatedWritePermission() {
        Fixture fixture = fixture(activeMember(), activeLease());

        assertMissingScope(fixture, () -> fixture.persistence.saveProjection(projection("project-a")));
        assertMissingScope(fixture, () -> fixture.persistence.replaceActualLines(
            "tenant-a",
            "project-a",
            "cashflow-sheet-lab",
            List.of(new SaveDraftResponse.ActualDelta("2026-07", 1, "DIRECT_COST_OUT", BigDecimal.ONE))
        ));
        WeeklyExpenseSheetEntity sheet = new WeeklyExpenseSheetEntity("tenant-a", "project-a", "default", "Default");
        assertMissingScope(fixture, () -> fixture.persistence.replaceActuals(
            sheet,
            List.of(new SaveDraftResponse.ActualDelta("2026-07", 1, "DIRECT_COST_OUT", BigDecimal.ONE))
        ));
        assertMissingScope(fixture, () -> fixture.persistence.saveWeeklyStatus(
            new WeeklyExpenseWeeklyStatusEntity("tenant-a", "project-a", "2026-07", 1)
        ));

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWriteLease(ACTOR, "project-a", SESSION);
            fixture.persistence.saveProjection(projection("project-b"));
            return null;
        }))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .satisfies(error -> {
                WeeklyExpenseEditLeaseException lease = (WeeklyExpenseEditLeaseException) error;
                org.assertj.core.api.Assertions.assertThat(lease.statusCode()).isEqualTo(423);
                org.assertj.core.api.Assertions.assertThat(lease.code()).isEqualTo("cashflow_write_scope_mismatch");
            });
    }

    @Test
    void validatedLegacyLeaseScopeDoesNotCreateWritePermissionInTheNextTransaction() {
        Fixture fixture = fixture(activeMember(), activeLease());

        fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWriteLease(ACTOR, "project-a", SESSION);
            return null;
        });

        assertMissingScope(fixture, () -> fixture.persistence.saveProjection(projection("project-a")));
    }

    @Test
    void targetRevisionMatchesThePinnedBffCanonicalHash() {
        assertThat(FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of(Map.of(
            "yearMonth", "2026-07",
            "weekNo", 1,
            "projection", Map.of("SALES_IN", 100L),
            "actual", Map.of("DIRECT_COST_OUT", 60L),
            "weeklyExpenseActualBySheet", Map.of(
                "z-source", Map.of("DIRECT_COST_OUT", 10L),
                "A_source", Map.of("DIRECT_COST_OUT", 20L),
                "_source", Map.of("DIRECT_COST_OUT", 30L)
            ),
            "adminClosed", false
        )))).isEqualTo("sha256:013247d9be20befa6593d6a8dc9c39d3a39456651513458be7391d3aafc5383f");
    }

    @Test
    void targetRevisionChangesWhenActualSourceProvenanceChangesButAggregateDoesNot() {
        Map<String, Object> first = new LinkedHashMap<>();
        first.put("yearMonth", "2026-07");
        first.put("weekNo", 1);
        first.put("actual", Map.of("SALES_IN", 600L));
        first.put("weeklyExpenseActualBySheet", Map.of(
            "bank", Map.of("SALES_IN", 500L),
            "cashflow-sheet-lab", Map.of("SALES_IN", 100L)
        ));
        Map<String, Object> second = new LinkedHashMap<>(first);
        second.put("weeklyExpenseActualBySheet", Map.of(
            "bank", Map.of("SALES_IN", 400L),
            "cashflow-sheet-lab", Map.of("SALES_IN", 200L)
        ));

        assertThat(FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of(first)))
            .isNotEqualTo(FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of(second)));
    }

    @Test
    @SuppressWarnings("unchecked")
    void monthlyApplyReplacesProjectionAndOnlyTheSheetActualSource() {
        Fixture fixture = fixture(activeMember(), activeLease());
        Map<String, Object> july = draftWeek();
        july.put("projection", Map.of("SALES_IN", 999L, "STALE_LINE", 123L));
        july.put("weeklyExpenseActualBySheet", Map.of(
            "bank-import", Map.of("SALES_IN", 500L),
            "cashflow-sheet-lab", Map.of("DIRECT_COST_OUT", 999L)
        ));
        july.put("actual", Map.of("SALES_IN", 500L, "DIRECT_COST_OUT", 999L));
        fixture.documents.put(weekPath(), july);
        Map<String, Object> august = new LinkedHashMap<>(draftWeek());
        august.put("yearMonth", "2026-08");
        august.put("projection", Map.of("SALES_IN", 777L));
        String augustPath = "orgs/tenant-a/cashflow_weeks/project-a-2026-08-w1";
        fixture.documents.put(augustPath, august);
        Map<String, Object> augustBefore = new LinkedHashMap<>(august);
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
            List.of(july, august)
        );
        String mirrorPath = "orgs/tenant-a/cashflow_sheet_mirrors/project-a";
        fixture.documents.put(mirrorPath, new LinkedHashMap<>(Map.of(
            "projectId", "project-a",
            "weeklyYear", 2026,
            "status", "FRESH",
            "sourceRevision", SOURCE_REVISION,
            "targetRevisionAtFetch", targetRevision
        )));

        CashflowSheetLabApplyResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            monthlyRequest("monthly-authoritative", targetRevision, "projection:SALES_IN")
        ));

        Map<String, Object> saved = fixture.documents.get(weekPath());
        Map<String, Object> projection = (Map<String, Object>) saved.get("projection");
        Map<String, Object> bySheet = (Map<String, Object>) saved.get("weeklyExpenseActualBySheet");
        Map<String, Object> actual = (Map<String, Object>) saved.get("actual");
        assertThat(response.savedProjectionLineCount()).isEqualTo(79);
        assertThat(response.savedActualLineCount()).isEqualTo(80);
        assertThat(projection)
            .doesNotContainKeys("SALES_IN", "STALE_LINE")
            .containsEntry("DIRECT_COST_OUT", 100L);
        assertThat(bySheet).containsOnlyKeys("bank-import", "cashflow-sheet-lab");
        assertThat((Map<String, Object>) bySheet.get("bank-import")).containsEntry("SALES_IN", 500L);
        assertThat((Map<String, Object>) bySheet.get("cashflow-sheet-lab"))
            .containsEntry("DIRECT_COST_OUT", 100L)
            .containsEntry("SALES_IN", 100L);
        assertThat(actual).containsEntry("SALES_IN", 600L).containsEntry("DIRECT_COST_OUT", 100L);
        assertThat(saved.get("projectionTotals")).isEqualTo(Map.of("totalIn", 600L, "totalOut", 900L, "net", -300L));
        assertThat(saved.get("actualTotals")).isEqualTo(Map.of("totalIn", 1200L, "totalOut", 900L, "net", 300L));
        assertThat(fixture.documents.get(augustPath)).isEqualTo(augustBefore);
        assertThat(fixture.documents.get(mirrorPath))
            .containsEntry("sourceRevision", SOURCE_REVISION)
            .containsEntry("targetRevisionAtFetch", response.resultingTargetRevision())
            .containsEntry("targetRevisionUpdateSource", "JVM_CANONICAL_APPLY");
        verify(fixture.transaction, never()).get(argThat((DocumentReference ref) ->
            ref.getPath().startsWith("orgs/tenant-a/cashflow_weeks/")
        ));
        verify(fixture.transaction).getAll(
            argThat(ref -> ref.getPath().endsWith("-w1")),
            argThat(ref -> ref.getPath().endsWith("-w2")),
            argThat(ref -> ref.getPath().endsWith("-w3")),
            argThat(ref -> ref.getPath().endsWith("-w4")),
            argThat(ref -> ref.getPath().endsWith("-w5"))
        );
    }

    @Test
    void monthlyApplyAcceptsPristineLegacyOpenMonthCloseWithoutCounters() {
        Fixture fixture = fixture(activeMember(), activeLease());
        Map<String, Object> legacyOpen = Map.of(
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-07",
            "status", "OPEN"
        );
        fixture.documents.put(monthClosePath("project-a", "2026-07"), legacyOpen);
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());

        CashflowSheetLabApplyResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            monthlyRequest("legacy-open-month", targetRevision, "")
        ));

        assertThat(response.savedProjectionLineCount()).isEqualTo(80);
        assertThat(response.savedActualLineCount()).isEqualTo(80);
        assertThat(fixture.documents.keySet()).anyMatch(path -> path.contains("/cashflow_weeks/"));
        assertThat(fixture.documents.get(monthClosePath("project-a", "2026-07"))).isEqualTo(legacyOpen);
    }

    @Test
    void monthlyApplyRequiresMigrationForCanonicalOpenWithHistoricalEvidence() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(monthClosePath("project-a", "2026-07"), Map.of(
            "contractVersion", "cashflow-month-close-v1",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-07",
            "status", "OPEN",
            "revision", 0L,
            "reopenCount", 0L,
            "snapshot", Map.of("version", 1)
        ));
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            monthlyRequest("historical-open-month", targetRevision, "")
        )))
            .isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error ->
                assertThat(error.code()).isEqualTo("cashflow_month_close_migration_required"));
        assertThat(fixture.documents.keySet()).noneMatch(path -> path.contains("/cashflow_weeks/"));
    }

    @Test
    void monthlyApplyRequiresMigrationForCanonicalOpenWithLatestVersionEvidence() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(monthClosePath("project-a", "2026-07"), Map.of(
            "contractVersion", "cashflow-month-close-v1",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-07",
            "status", "OPEN",
            "revision", 0L,
            "reopenCount", 0L,
            "latestVersionId", "project-a-2026-07-r1"
        ));
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            monthlyRequest("latest-version-open-month", targetRevision, "")
        )))
            .isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error ->
                assertThat(error.code()).isEqualTo("cashflow_month_close_migration_required"));
        assertThat(fixture.documents.keySet()).noneMatch(path -> path.contains("/cashflow_weeks/"));
    }

    @Test
    void monthlyApplyRequiresMigrationForCanonicalOpenWithNonMapEvidence() {
        for (String evidenceField : List.of(
            "snapshot", "previousSnapshot", "lastAmendmentEvidence", "reopenRequest", "reopenDecision"
        )) {
            Fixture fixture = fixture(activeMember(), activeLease());
            Map<String, Object> close = new LinkedHashMap<>(Map.of(
                "contractVersion", "cashflow-month-close-v1",
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "yearMonth", "2026-07",
                "status", "OPEN",
                "revision", 0L,
                "reopenCount", 0L
            ));
            close.put(evidenceField, "legacy-evidence");
            fixture.documents.put(monthClosePath("project-a", "2026-07"), close);
            String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());

            assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
                fixture.persistence
            ).applyCashflowSheetLab(
                ACTOR,
                "project-a",
                SESSION,
                monthlyRequest("non-map-open-month-" + evidenceField, targetRevision, "")
            )))
                .as(evidenceField)
                .isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error ->
                    assertThat(error.code()).isEqualTo("cashflow_month_close_migration_required"));
            assertThat(fixture.documents.keySet()).noneMatch(path -> path.contains("/cashflow_weeks/"));
        }
    }

    @Test
    void monthCloseReadDoesNotDropRawHistoricalEvidenceBeforeTheDomainPredicate() {
        for (Map.Entry<String, String> evidence : Map.of(
            "latestVersionId", "project-a-2026-07-r1",
            "snapshot", "legacy-evidence"
        ).entrySet()) {
            Fixture fixture = fixture(activeMember(), activeLease());
            Map<String, Object> close = new LinkedHashMap<>(Map.of(
                "contractVersion", "cashflow-month-close-v1",
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "yearMonth", "2026-07",
                "status", "OPEN",
                "revision", 0L,
                "reopenCount", 0L
            ));
            close.put(evidence.getKey(), evidence.getValue());
            fixture.documents.put(monthClosePath("project-a", "2026-07"), close);

            CashflowMonthCloseState state = fixture.persistence.findCashflowMonthClose(
                "tenant-a", "project-a", "2026-07"
            );

            assertThat(state.isPristineOpen()).as(evidence.getKey()).isFalse();
        }
    }

    @Test
    void monthlyApplyAcceptsPristineLegacyOpenWithZeroOrEmptyFields() {
        List<Map<String, Object>> pristineFields = List.of(
            Map.of("revision", 0L),
            Map.of("reopenCount", 0L),
            Map.of("reopenRequest", Map.of()),
            Map.of("reopenDecision", Map.of()),
            Map.of("late", false),
            Map.of("reopenContext", Map.of())
        );
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());

        for (Map<String, Object> pristine : pristineFields) {
            Fixture fixture = fixture(activeMember(), activeLease());
            Map<String, Object> legacyOpen = new LinkedHashMap<>(Map.of(
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "yearMonth", "2026-07",
                "status", "OPEN"
            ));
            legacyOpen.putAll(pristine);
            fixture.documents.put(monthClosePath("project-a", "2026-07"), legacyOpen);

            CashflowSheetLabApplyResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
                fixture.persistence
            ).applyCashflowSheetLab(
                ACTOR,
                "project-a",
                SESSION,
                monthlyRequest("pristine-legacy-open", targetRevision, "")
            ));

            assertThat(response.savedProjectionLineCount()).isEqualTo(80);
            assertThat(fixture.documents.keySet()).anyMatch(path -> path.contains("/cashflow_weeks/"));
            assertThat(fixture.documents.get(monthClosePath("project-a", "2026-07"))).isEqualTo(legacyOpen);
        }
    }

    @Test
    void monthlyApplyRequiresMigrationForLegacyOpenWithHistoricalEvidence() {
        List<Map<String, Object>> historicalEvidence = List.of(
            Map.of("revision", 1L),
            Map.of("revision", "1"),
            Map.of("reopenCount", 1L),
            Map.of("snapshotHash", "sha256:legacy"),
            Map.of("closedAt", "2026-07-31T00:00:00Z"),
            Map.of("reopenRequest", Map.of("reason", "정정")),
            Map.of("reopenDecision", Map.of("decision", "APPROVE")),
            Map.of("latestVersionId", "project-a-2026-07-r1"),
            Map.of("reopenContext", Map.of("request", Map.of("reason", "정정"))),
            Map.of("lastAmendmentAt", "2026-07-31T00:00:00Z")
        );
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());

        for (Map<String, Object> evidence : historicalEvidence) {
            Fixture fixture = fixture(activeMember(), activeLease());
            Map<String, Object> legacyOpen = new LinkedHashMap<>(Map.of(
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "yearMonth", "2026-07",
                "status", "OPEN"
            ));
            legacyOpen.putAll(evidence);
            fixture.documents.put(monthClosePath("project-a", "2026-07"), legacyOpen);

            assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
                fixture.persistence
            ).applyCashflowSheetLab(
                ACTOR,
                "project-a",
                SESSION,
                monthlyRequest("historical-legacy-open", targetRevision, "")
            )))
                .isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error ->
                    assertThat(error.code()).isEqualTo("cashflow_month_close_migration_required"));
            assertThat(fixture.documents.keySet()).noneMatch(path -> path.contains("/cashflow_weeks/"));
            assertThat(fixture.documents.get(monthClosePath("project-a", "2026-07"))).isEqualTo(legacyOpen);
        }
    }

    @Test
    void fullYearApplySortsMonthsAndReadsAllSixtyWeeksInOneCommandTransaction() {
        Fixture fixture = fixture(activeMember(), activeLease());
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());
        List<CashflowSheetBatchApplyRequest.Month> requestedMonths = new ArrayList<>();
        List<String> expectedMonths = new ArrayList<>();
        for (int month = 12; month >= 1; month -= 1) {
            String yearMonth = "2026-" + String.format("%02d", month);
            CashflowSheetLabApplyRequest monthly = monthlyRequest(
                "month-" + month,
                targetRevision,
                yearMonth,
                ""
            );
            requestedMonths.add(new CashflowSheetBatchApplyRequest.Month(
                yearMonth, monthly.calculationChecks(), monthly.cells()
            ));
            expectedMonths.addFirst(yearMonth);
        }
        CashflowSheetBatchApplyRequest request = new CashflowSheetBatchApplyRequest(
            "batch-full-year",
            SOURCE_REVISION,
            targetRevision,
            false,
            null,
            null,
            openingBalanceCells(),
            requestedMonths
        );

        CashflowSheetBatchApplyResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetBatch(ACTOR, "project-a", SESSION, request));

        assertThat(response.months()).extracting(CashflowSheetBatchApplyResponse.MonthResult::yearMonth)
            .containsExactlyElementsOf(expectedMonths);
        assertThat(response.months().get(1).calculationChecks())
            .filteredOn(check -> check.mode().equals("projection") && check.weekNo() == 1)
            .singleElement()
            .satisfies(check -> assertThat(check.calculated().openingBalance()).isEqualByComparingTo("1999000"));
        assertThat(response.savedProjectionLineCount()).isEqualTo(960);
        assertThat(response.savedActualLineCount()).isEqualTo(960);
        assertThat(fixture.documents.keySet().stream()
            .filter(path -> path.contains("/cashflow_weeks/project-a-2026-")))
            .hasSize(60);
        assertThat(fixture.getAllSizes).containsExactly(60);
        verify(fixture.collections.get("orgs/tenant-a/cashflow_weeks"), times(1))
            .whereEqualTo("projectId", "project-a");
        verify(fixture.transaction, times(1)).get(any(Query.class));
    }

    @Test
    void pendingApprovalWarningsPersistOncePerMonthWithEveryCellAndReplayWithoutDuplicates() {
        Fixture fixture = fixture(activeMember(), activeLease());
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());
        CashflowSheetLabApplyRequest base = monthlyRequest("pending-100", targetRevision, "2026-07", "");
        CashflowPendingApprovalAffectedMonth instruction = pendingApprovalInstruction("2026-07", "request-a", 100);
        CashflowSheetLabApplyRequest request = new CashflowSheetLabApplyRequest(
            base.idempotencyKey(), base.sourceRevision(), base.targetRevision(), base.yearMonth(),
            base.replaceAllActualSources(), base.settledWeekChangeConfirmation(), base.closedMonthChangeReason(),
            base.openingBalanceCells(), base.calculationChecks(), base.cells(), List.of(instruction),
            base.acceptFormulaMismatches()
        );
        WeeklyExpenseCommandService service = commandService(fixture.persistence);

        CashflowSheetLabApplyResponse first = fixture.persistence.runCommandTransaction(() ->
            service.applyCashflowSheetLab(ACTOR, "project-a", SESSION, request)
        );
        CashflowSheetLabApplyResponse replay = fixture.persistence.runCommandTransaction(() ->
            service.applyCashflowSheetLab(ACTOR, "project-a", SESSION, request)
        );

        assertThat(replay).isEqualTo(first);
        List<Map<String, Object>> warnings = fixture.documents.entrySet().stream()
            .filter(entry -> entry.getKey().contains("/cashflow_pending_approval_change_warnings/"))
            .map(Map.Entry::getValue)
            .toList();
        assertThat(warnings).singleElement().satisfies(warning -> {
            assertThat(warning).containsEntry("yearMonth", "2026-07")
                .containsEntry("warningCountIncrement", 1)
                .containsEntry("differenceCount", 100)
                .containsEntry("idempotencyKey", "pending-100");
            List<Map<String, Object>> differences = (List<Map<String, Object>>) warning.get("approvalDifferences");
            assertThat((List<?>) differences.getFirst().get("changes")).hasSize(100);
        });
        Map<String, Object> audit = fixture.documents.entrySet().stream()
            .filter(entry -> entry.getKey().contains("/weekly_api_audit_events/"))
            .map(Map.Entry::getValue).findFirst().orElseThrow();
        assertThat(String.valueOf(audit.get("metadataJson")))
            .contains("pendingApprovalAffectedMonths").contains("\"differenceCount\":100");
        verify(fixture.transaction).create(argThat(ref -> ref.getPath().matches(
            "orgs/tenant-a/cashflow_pending_approval_change_warnings/[a-f0-9]{64}"
        )), any());
    }

    @Test
    void batchPendingApprovalWarningsPersistOneDocumentForEachAffectedMonth() {
        Fixture fixture = fixture(activeMember(), activeLease());
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());
        CashflowSheetLabApplyRequest july = monthlyRequest("pending-july", targetRevision, "2026-07", "");
        CashflowSheetLabApplyRequest august = monthlyRequest("pending-august", targetRevision, "2026-08", "");
        CashflowSheetBatchApplyRequest request = new CashflowSheetBatchApplyRequest(
            "pending-two-months", SOURCE_REVISION, targetRevision, false, null, null, List.of(),
            List.of(
                new CashflowSheetBatchApplyRequest.Month("2026-07", july.calculationChecks(), july.cells()),
                new CashflowSheetBatchApplyRequest.Month("2026-08", august.calculationChecks(), august.cells())
            ),
            List.of(
                pendingApprovalInstruction("2026-07", "request-a", 160),
                pendingApprovalInstruction("2026-08", "request-a", 160)
            ),
            true
        );

        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .applyCashflowSheetBatch(ACTOR, "project-a", SESSION, request));

        assertThat(fixture.documents.entrySet().stream()
            .filter(entry -> entry.getKey().contains("/cashflow_pending_approval_change_warnings/"))
            .map(entry -> entry.getValue().get("yearMonth")))
            .containsExactlyInAnyOrder("2026-07", "2026-08");
    }

    @Test
    void pendingApprovalWarningRollsBackWithCanonicalAuditAndIdempotencyOnLateFailure() {
        Fixture fixture = fixture(activeMember(), activeLease());
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());
        CashflowSheetLabApplyRequest base = monthlyRequest("pending-rollback", targetRevision, "2026-07", "");
        CashflowSheetLabApplyRequest request = new CashflowSheetLabApplyRequest(
            base.idempotencyKey(), base.sourceRevision(), base.targetRevision(), base.yearMonth(),
            base.replaceAllActualSources(), base.settledWeekChangeConfirmation(), base.closedMonthChangeReason(),
            base.openingBalanceCells(), base.calculationChecks(), base.cells(),
            List.of(pendingApprovalInstruction("2026-07", "request-a", 1)), true
        );

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> {
            commandService(fixture.persistence).applyCashflowSheetLab(ACTOR, "project-a", SESSION, request);
            throw new IllegalStateException("simulated response-path failure");
        })).isInstanceOf(IllegalStateException.class).hasMessageContaining("simulated");

        assertThat(fixture.documents.keySet()).noneMatch(path ->
            path.contains("/cashflow_weeks/")
                || path.contains("/cashflow_pending_approval_change_warnings/")
                || path.contains("/weekly_api_audit_events/")
                || path.contains("/weekly_api_idempotency/")
        );
    }

    @Test
    void multiMonthApplyRequiresReasonAndAmendsAClosedMonthBeforeItsDeadlineWithoutAWarning() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", closedThrough("2026-08"));
        fixture.documents.put("orgs/tenant-a/monthly_closes/project-a-2026-08", Map.of(
            "contractVersion", "cashflow-month-close-v1",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-08",
            "status", "CLOSED",
            "revision", 1L,
            "reopenCount", 0L,
            "snapshotHash", "sha256:" + "f".repeat(64)
        ));
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());
        CashflowSheetLabApplyRequest july = monthlyRequest("july-source", targetRevision, "2026-07", "");
        CashflowSheetLabApplyRequest august = monthlyRequest("august-source", targetRevision, "2026-08", "");
        CashflowSheetBatchApplyRequest request = new CashflowSheetBatchApplyRequest(
            "batch-with-closed-august",
            SOURCE_REVISION,
            targetRevision,
            false,
            List.of(
                new CashflowSheetBatchApplyRequest.Month("2026-07", july.calculationChecks(), july.cells()),
                new CashflowSheetBatchApplyRequest.Month("2026-08", august.calculationChecks(), august.cells())
            )
        );

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetBatch(ACTOR, "project-a", SESSION, request)))
            .isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error -> {
                assertThat(error.statusCode()).isEqualTo(409);
                assertThat(error.code()).isEqualTo("cashflow_closed_month_reason_required");
                assertThat(error.details().get("closedMonths")).isEqualTo(List.of("2026-07", "2026-08"));
            });
        assertThat(fixture.documents.keySet()).noneMatch(path -> path.contains("/cashflow_weeks/"));

        CashflowSheetBatchApplyRequest confirmed = new CashflowSheetBatchApplyRequest(
            "batch-with-confirmed-closed-august",
            SOURCE_REVISION,
            targetRevision,
            false,
            "결산 완료 월 다중 반영 확인",
            request.months()
        );
        CashflowSheetBatchApplyResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetBatch(ACTOR, "project-a", SESSION, confirmed));

        assertThat(response.months()).extracting(CashflowSheetBatchApplyResponse.MonthResult::yearMonth)
            .containsExactly("2026-07", "2026-08");
        assertThat(fixture.documents.get("orgs/tenant-a/monthly_closes/project-a-2026-08"))
            .containsEntry("revision", 2L)
            .containsEntry("amendmentCount", 1L)
            .containsEntry("postDeadlineAmendmentWarningCount", 0L)
            .containsEntry("lastAmendmentReason", "결산 완료 월 다중 반영 확인")
            .containsEntry("lastAmendmentPostDeadline", false);
        assertThat(fixture.documents.keySet()).anyMatch(path -> path.contains("/cashflow_month_amendments/"));
    }

    @Test
    void multiMonthApplyReportsEveryLateClosedMonthAndRecordsEachOnce() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-10-11"));
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", closedThrough("2026-08"));
        fixture.documents.put("orgs/tenant-a/monthly_closes/project-a-2026-07", Map.of(
            "contractVersion", "cashflow-month-close-v1",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-07",
            "status", "CLOSED",
            "revision", 1L,
            "reopenCount", 0L,
            "snapshotHash", "sha256:" + "f".repeat(64)
        ));
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3",
            lockedWeeklyCompletion("2026-07", 3, 1)
        );
        fixture.documents.put("orgs/tenant-a/monthly_closes/project-a-2026-08", Map.of(
            "contractVersion", "cashflow-month-close-v1",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-08",
            "status", "CLOSED",
            "revision", 1L,
            "reopenCount", 0L,
            "snapshotHash", "sha256:" + "e".repeat(64)
        ));
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());
        CashflowSheetLabApplyRequest july = monthlyRequest("batch-late-july", targetRevision, "2026-07", "");
        CashflowSheetLabApplyRequest august = monthlyRequest("batch-late-august", targetRevision, "2026-08", "");
        List<CashflowSheetBatchApplyRequest.Month> months = List.of(
            new CashflowSheetBatchApplyRequest.Month("2026-07", july.calculationChecks(), july.cells()),
            new CashflowSheetBatchApplyRequest.Month("2026-08", august.calculationChecks(), august.cells())
        );
        CashflowSheetBatchApplyRequest withoutReason = new CashflowSheetBatchApplyRequest(
            "batch-late-no-reason", SOURCE_REVISION, targetRevision, false, null, months
        );

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetBatch(ACTOR, "project-a", SESSION, withoutReason)))
            .isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error -> {
                assertThat(error.statusCode()).isEqualTo(409);
                assertThat(error.code()).isEqualTo("cashflow_closed_month_reason_required");
                assertThat(error.details().get("closedMonths"))
                    .isEqualTo(List.of("2026-07", "2026-08"));
            });
        assertThat(fixture.documents.keySet()).noneMatch(path -> path.contains("/cashflow_weeks/"));
        assertThat(fixture.documents.keySet()).noneMatch(path -> path.contains("/cashflow_month_amendments/"));

        CashflowSheetBatchApplyRequest corrected = new CashflowSheetBatchApplyRequest(
            "batch-late-with-reason",
            SOURCE_REVISION,
            targetRevision,
            false,
            "결산 후 다중 월 입금액 정정",
            months
        );
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        CashflowSheetBatchApplyResponse first = fixture.persistence.runCommandTransaction(() ->
            service.applyCashflowSheetBatch(ACTOR, "project-a", SESSION, corrected)
        );
        CashflowSheetBatchApplyResponse replay = fixture.persistence.runCommandTransaction(() ->
            service.applyCashflowSheetBatch(ACTOR, "project-a", SESSION, corrected)
        );

        assertThat(replay).isEqualTo(first);
        assertThat(fixture.documents.get("orgs/tenant-a/monthly_closes/project-a-2026-07"))
            .containsEntry("amendmentCount", 1L)
            .containsEntry("postDeadlineAmendmentWarningCount", 1L)
            .containsEntry("lastAmendmentReason", "결산 후 다중 월 입금액 정정");
        assertThat(fixture.documents.get("orgs/tenant-a/monthly_closes/project-a-2026-08"))
            .containsEntry("amendmentCount", 1L)
            .containsEntry("postDeadlineAmendmentWarningCount", 1L)
            .containsEntry("lastAmendmentReason", "결산 후 다중 월 입금액 정정");
        assertThat(fixture.documents.keySet().stream()
            .filter(path -> path.contains("/cashflow_month_amendments/")))
            .hasSize(2);
        assertThat(fixture.documents.keySet().stream()
            .filter(path -> path.contains("/weekly_api_audit_events/")))
            .hasSize(1);
        assertThat(fixture.documents.keySet().stream()
            .filter(path -> path.contains("/cashflow_weeks/project-a-2026-")))
            .hasSize(10);
    }

    @Test
    void sheetBatchDoesNotTreatAReopenRequestAsAClosedMonthAmendment() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-08-11"));
        fixture.documents.put("orgs/tenant-a/monthly_closes/project-a-2026-07", Map.of(
            "contractVersion", "cashflow-month-close-v1",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-07",
            "status", "REOPEN_REQUESTED",
            "revision", 2L,
            "reopenCount", 0L
        ));
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());
        CashflowSheetLabApplyRequest july = monthlyRequest("batch-reopen-requested", targetRevision, "2026-07", "");
        CashflowSheetBatchApplyRequest request = new CashflowSheetBatchApplyRequest(
            "batch-reopen-requested",
            SOURCE_REVISION,
            targetRevision,
            false,
            "승인 전 변경 시도",
            List.of(new CashflowSheetBatchApplyRequest.Month(
                "2026-07", july.calculationChecks(), july.cells()
            ))
        );

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetBatch(ACTOR, "project-a", SESSION, request)))
            .isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error ->
                assertThat(error.code()).isEqualTo("cashflow_month_close_migration_required"));
        assertThat(fixture.documents.keySet()).noneMatch(path -> path.contains("/cashflow_weeks/"));
        assertThat(fixture.documents.keySet()).noneMatch(path -> path.contains("/cashflow_month_amendments/"));
        assertThat(fixture.documents.keySet()).noneMatch(path -> path.contains("/weekly_api_audit_events/"));
    }

    @Test
    void annualTotalWriteDoesNotRequireAMonthKey() {
        Fixture fixture = fixture(activeMember(), activeLease());
        CashflowSheetAnnualApplyCommand request = new CashflowSheetAnnualApplyCommand(
            "annual-2025",
            SOURCE_REVISION,
            2025,
            0,
            annualCells()
        );

        fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            fixture.persistence.replaceCashflowSheetYearTotal(
                "tenant-a",
                "project-a",
                "cashflow-sheet-lab",
                request
            );
            return null;
        });

        assertThat(fixture.documents.values()).anySatisfy(document -> assertThat(document)
            .containsEntry("projectId", "project-a")
            .containsEntry("year", 2025)
            .doesNotContainKey("yearMonth"));
        assertThat(fixture.persistence.findCashflowSheetYearTotals("tenant-a", "project-a"))
            .singleElement()
            .satisfies(total -> {
                assertThat(total.year()).isEqualTo(2025);
                assertThat(total.projection()).isEmpty();
                assertThat(total.actual()).isEmpty();
                assertThat(total.projectionStates()).containsEntry("MYSC_PREPAY_IN", "EMPTY");
                assertThat(total.actualStates()).containsEntry("MYSC_PREPAY_IN", "EMPTY");
            });
    }

    @Test
    void annualTotalWriteKeepsRevisionGuardUnlessExplicitOverwriteIsRequested() {
        Fixture fixture = fixture(activeMember(), activeLease());
        CashflowSheetAnnualApplyCommand first = new CashflowSheetAnnualApplyCommand(
            "annual-revision-2025-first",
            SOURCE_REVISION,
            2025,
            0,
            annualCells()
        );
        fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            fixture.persistence.replaceCashflowSheetYearTotal(
                "tenant-a", "project-a", "cashflow-sheet-lab", first
            );
            return null;
        });

        CashflowSheetAnnualApplyCommand stale = new CashflowSheetAnnualApplyCommand(
            "annual-revision-2025-stale",
            SOURCE_REVISION,
            2025,
            0,
            annualCells()
        );
        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            fixture.persistence.replaceCashflowSheetYearTotal(
                "tenant-a", "project-a", "cashflow-sheet-lab", stale
            );
            return null;
        }))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("revision changed");

        CashflowSheetAnnualApplyCommand overwrite = new CashflowSheetAnnualApplyCommand(
            "annual-revision-2025-overwrite",
            SOURCE_REVISION,
            2025,
            0,
            annualCells(),
            "",
            true
        );
        assertThatCode(() -> fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            fixture.persistence.replaceCashflowSheetYearTotal(
                "tenant-a", "project-a", "cashflow-sheet-lab", overwrite
            );
            return null;
        })).doesNotThrowAnyException();
    }

    @Test
    void annualTotalWritePreservesExplicitZeroAsARowValueAndState() {
        Fixture fixture = fixture(activeMember(), activeLease());
        List<CashflowAnnualCellSet.Cell> cells = annualCells().stream()
            .map(cell -> "projection".equals(cell.mode()) && "SALES_IN".equals(cell.cashflowLine())
                ? new CashflowAnnualCellSet.Cell(
                    cell.mode(), cell.cashflowLine(), "ZERO", BigDecimal.ZERO, "A1", cell.sourceLabel()
                )
                : cell)
            .toList();
        CashflowSheetAnnualApplyCommand request = new CashflowSheetAnnualApplyCommand(
            "annual-zero-2025",
            SOURCE_REVISION,
            2025,
            0,
            cells
        );

        fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            fixture.persistence.replaceCashflowSheetYearTotal(
                "tenant-a", "project-a", "cashflow-sheet-lab", request
            );
            return null;
        });

        assertThat(fixture.persistence.findCashflowSheetYearTotals("tenant-a", "project-a"))
            .singleElement()
            .satisfies(total -> {
                assertThat(total.projection()).containsEntry("SALES_IN", BigDecimal.ZERO);
                assertThat(total.projectionStates()).containsEntry("SALES_IN", "ZERO");
            });
    }

    @Test
    void monthlyApplyRejectsTargetDriftAndRequiresReasonForAClosedMonthBeforeItsDeadline() {
        Fixture drifted = fixture(activeMember(), activeLease());
        CashflowSheetLabApplyRequest driftedBase = monthlyRequest(
            "monthly-drift-base",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ""
        );
        CashflowSheetLabApplyRequest driftedRequest = new CashflowSheetLabApplyRequest(
            "monthly-drift", driftedBase.sourceRevision(), driftedBase.targetRevision(), driftedBase.yearMonth(),
            driftedBase.replaceAllActualSources(), null, "결산 완료 월 변경 확인",
            driftedBase.calculationChecks(), driftedBase.cells()
        );
        assertThatThrownBy(() -> drifted.persistence.runCommandTransaction(() -> commandService(
            drifted.persistence
        ).applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            driftedRequest
        ))).isInstanceOf(WeeklyExpenseConflictException.class).hasMessageContaining("revision");
        assertThat(drifted.documents.keySet()).noneMatch(path -> path.contains("cashflow_weeks"));

        Fixture overwrite = fixture(activeMember(), activeLease());
        CashflowSheetLabApplyRequest overwriteBase = monthlyRequest(
            "monthly-overwrite-base",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ""
        );
        CashflowSheetLabApplyRequest overwriteRequest = new CashflowSheetLabApplyRequest(
            "monthly-overwrite",
            overwriteBase.sourceRevision(),
            overwriteBase.targetRevision(),
            overwriteBase.yearMonth(),
            true,
            null,
            null,
            overwriteBase.calculationChecks(),
            overwriteBase.cells()
        );
        assertThatCode(() -> overwrite.persistence.runCommandTransaction(() -> commandService(
            overwrite.persistence
        ).applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            overwriteRequest
        ))).doesNotThrowAnyException();
        assertThat(overwrite.documents.keySet()).anyMatch(path -> path.contains("/cashflow_weeks/"));

        Fixture legacyClosed = fixture(activeMember(), activeLease());
        legacyClosed.documents.put("orgs/tenant-a/monthly_closes/project-a-2026-07", Map.of(
            "contractVersion", "cashflow-month-close-v1",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-07",
            "status", "CLOSED",
            "revision", 1L,
            "reopenCount", 0L
        ));
        CashflowSheetLabApplyRequest legacyBase = monthlyRequest(
            "monthly-legacy-closed-base",
            "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44",
            ""
        );
        CashflowSheetLabApplyRequest legacyRequest = new CashflowSheetLabApplyRequest(
            "monthly-legacy-closed", legacyBase.sourceRevision(), legacyBase.targetRevision(), legacyBase.yearMonth(),
            legacyBase.replaceAllActualSources(), null, "결산 완료 월 변경 확인",
            legacyBase.calculationChecks(), legacyBase.cells()
        );
        assertThatThrownBy(() -> legacyClosed.persistence.runCommandTransaction(() -> commandService(
            legacyClosed.persistence
        ).applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            legacyRequest
        ))).isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error ->
            assertThat(error.code()).isEqualTo("cashflow_month_close_migration_required"));
        assertThat(legacyClosed.documents.keySet()).noneMatch(path -> path.contains("cashflow_weeks"));

        Fixture closed = fixture(activeMember(), activeLease());
        closed.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", closedThrough("2026-07"));
        closed.documents.put("orgs/tenant-a/monthly_closes/project-a-2026-07", Map.of(
            "contractVersion", "cashflow-month-close-v1",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-07",
            "status", "CLOSED",
            "revision", 1L,
            "reopenCount", 0L,
            "snapshotHash", "sha256:" + "f".repeat(64)
        ));
        String closedTargetRevision = "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44";
        CashflowSheetLabApplyRequest unconfirmed = monthlyRequest(
            "monthly-closed-unconfirmed", closedTargetRevision, ""
        );
        assertThatThrownBy(() -> closed.persistence.runCommandTransaction(() -> commandService(
            closed.persistence
        ).applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            unconfirmed
        ))).isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error -> {
            assertThat(error.statusCode()).isEqualTo(409);
            assertThat(error.code()).isEqualTo("cashflow_closed_month_reason_required");
            assertThat(error.details().get("closedMonths")).isEqualTo(List.of("2026-07"));
        });
        assertThat(closed.documents.keySet()).noneMatch(path -> path.contains("/cashflow_weeks/"));

        CashflowSheetLabApplyRequest confirmed = new CashflowSheetLabApplyRequest(
            "monthly-closed-confirmed", unconfirmed.sourceRevision(), unconfirmed.targetRevision(), unconfirmed.yearMonth(),
            unconfirmed.replaceAllActualSources(), null, "결산 완료 월 변경 확인",
            unconfirmed.calculationChecks(), unconfirmed.cells()
        );
        CashflowSheetLabApplyResponse closedResponse = closed.persistence.runCommandTransaction(() -> commandService(
            closed.persistence
        ).applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            confirmed
        ));
        assertThat(closedResponse.yearMonth()).isEqualTo("2026-07");
        assertThat(closedResponse.calculationChecks())
            .filteredOn(check -> check.mode().equals("projection") && check.weekNo() == 1)
            .singleElement()
            .satisfies(check -> {
                assertThat(check.reported().depositTotal()).isEqualByComparingTo("800");
                assertThat(check.calculated().depositTotal()).isEqualByComparingTo("700");
                assertThat(check.calculated().withdrawalTotal()).isEqualByComparingTo("900");
                assertThat(check.matches().depositTotal()).isFalse();
            });
        assertThat(closed.documents.get("orgs/tenant-a/monthly_closes/project-a-2026-07"))
            .containsEntry("revision", 2L)
            .containsEntry("amendmentCount", 1L)
            .containsEntry("postDeadlineAmendmentWarningCount", 0L)
            .containsEntry("lastAmendmentReason", "결산 완료 월 변경 확인")
            .hasEntrySatisfying("lastAmendmentEvidence", value -> {
                Map<String, Object> evidence = (Map<String, Object>) value;
                assertThat(evidence)
                    .containsEntry("closeRevision", 1L)
                    .containsEntry("resultingCloseRevision", 2L)
                    .containsEntry("closeSnapshotHash", SOURCE_REVISION)
                    .containsEntry("sourceRevision", SOURCE_REVISION)
                    .containsEntry("targetRevision", "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44");
                assertThat((List<?>) evidence.get("calculationChecks")).hasSize(10);
            });
    }

    @Test
    void postDeadlineClosedMonthSheetChangeRequiresReasonAndRecordsOneWarning() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-08-11"));
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", closedThrough("2026-07"));
        fixture.documents.put("orgs/tenant-a/monthly_closes/project-a-2026-07", Map.of(
            "contractVersion", "cashflow-month-close-v1",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-07",
            "status", "CLOSED",
            "revision", 1L,
            "reopenCount", 0L,
            "snapshotHash", "sha256:" + "d".repeat(64)
        ));
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3",
            lockedWeeklyCompletion("2026-07", 3, 1)
        );
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());
        CashflowSheetLabApplyRequest base = monthlyRequest("late-no-reason", targetRevision, "");

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetLab(ACTOR, "project-a", SESSION, base)))
            .isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error -> {
                assertThat(error.statusCode()).isEqualTo(409);
                assertThat(error.code()).isEqualTo("cashflow_closed_month_reason_required");
            });
        assertThat(fixture.documents.keySet()).noneMatch(path -> path.contains("/cashflow_weeks/"));

        CashflowSheetLabApplyRequest corrected = new CashflowSheetLabApplyRequest(
            "late-with-reason", base.sourceRevision(), base.targetRevision(), base.yearMonth(),
            base.replaceAllActualSources(), null, "결산 후 실제 입금액 정정",
            base.calculationChecks(), base.cells()
        );
        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .applyCashflowSheetLab(ACTOR, "project-a", SESSION, corrected));
        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .applyCashflowSheetLab(ACTOR, "project-a", SESSION, corrected));

        assertThat(fixture.documents.get("orgs/tenant-a/monthly_closes/project-a-2026-07"))
            .containsEntry("amendmentCount", 1L)
            .containsEntry("postDeadlineAmendmentWarningCount", 1L)
            .containsEntry("lastAmendmentReason", "결산 후 실제 입금액 정정");
        assertThat(fixture.documents.keySet()).anyMatch(path -> path.contains("/cashflow_month_amendments/"));
        CashflowMonthCloseResponse close = commandService(fixture.persistence)
            .readCashflowMonthClose(READ_ACTOR, "project-a", "2026-07");
        assertThat(close.amendmentCount()).isEqualTo(1L);
        assertThat(close.postDeadlineAmendmentWarningCount()).isEqualTo(1L);
        assertThat(close.projectWarningCount()).isEqualTo(1L);
        assertThat(close.lastAmendmentReason()).isEqualTo("결산 후 실제 입금액 정정");
    }

    @Test
    void monthlyPersistenceRejectsOmittedWeeksBeforeReplacingExistingValues() {
        Fixture fixture = fixture(activeMember(), activeLease());
        Map<String, Object> existingWeekFive = new LinkedHashMap<>(draftWeek());
        existingWeekFive.put("weekNo", 5);
        existingWeekFive.put("projection", Map.of("SALES_IN", 555L));
        String weekFivePath = "orgs/tenant-a/cashflow_weeks/project-a-2026-07-w5";
        fixture.documents.put(weekFivePath, existingWeekFive);
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
            List.of(existingWeekFive)
        );
        List<CashflowSheetLabApplyRequest.Cell> firstFourWeeks = monthlyRequest(
            "direct-persistence-incomplete",
            targetRevision,
            ""
        ).cells().stream().filter(cell -> cell.weekNo() <= 4).toList();

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWriteLease(ACTOR, "project-a", SESSION);
            return fixture.persistence.replaceCashflowSheetMonth(
                "tenant-a",
                "project-a",
                "cashflow-sheet-lab",
                "2026-07",
                targetRevision,
                firstFourWeeks
            );
        }))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("five weeks");

        assertThat(fixture.documents.get(weekFivePath)).isEqualTo(existingWeekFive);
    }

    @Test
    void monthlyApplyRejectsLegacySixthWeekUntilItIsMigrated() {
        Fixture fixture = fixture(activeMember(), activeLease());
        Map<String, Object> legacyWeekSix = new LinkedHashMap<>(draftWeek());
        legacyWeekSix.put("weekNo", 6);
        legacyWeekSix.put("projection", Map.of("SALES_IN", 666L));
        String weekSixPath = "orgs/tenant-a/cashflow_weeks/project-a-2026-07-w6";
        fixture.documents.put(weekSixPath, legacyWeekSix);
        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            monthlyRequest(
                "monthly-legacy-week-six",
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                ""
            )
        )))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("migration");

        assertThat(fixture.documents.get(weekSixPath)).isEqualTo(legacyWeekSix);
        assertThat(fixture.documents.keySet())
            .noneMatch(path -> path.matches(".*/project-a-2026-07-w[1-5]$"));
    }

    @Test
    void monthlyApplyRejectsNonCanonicalWeekDocumentIdsUntilTheyAreMigrated() {
        Fixture fixture = fixture(activeMember(), activeLease());
        Map<String, Object> legacyWeekOne = draftWeek();
        String legacyPath = "orgs/tenant-a/cashflow_weeks/legacy-july-week-one";
        fixture.documents.put(legacyPath, legacyWeekOne);
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
            List.of(legacyWeekOne)
        );

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            monthlyRequest("monthly-noncanonical-id", targetRevision, "")
        )))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("migration");

        assertThat(fixture.documents.get(legacyPath)).isEqualTo(legacyWeekOne);
        assertThat(fixture.documents.keySet())
            .noneMatch(path -> path.matches(".*/project-a-2026-07-w[1-5]$"));
    }

    @Test
    void monthlyApplyRejectsCanonicalIdsWithMissingMonthMetadataUntilTheyAreMigrated() {
        Fixture fixture = fixture(activeMember(), activeLease());
        Map<String, Object> malformedWeekOne = draftWeek();
        malformedWeekOne.remove("yearMonth");
        fixture.documents.put(weekPath(), malformedWeekOne);

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            monthlyRequest(
                "monthly-missing-month-metadata",
                "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44",
                ""
            )
        )))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("migration");

        assertThat(fixture.documents.get(weekPath())).isEqualTo(malformedWeekOne);
        assertThat(fixture.documents.keySet())
            .noneMatch(path -> path.matches(".*/project-a-2026-07-w[2-5]$"));
    }

    @Test
    void monthlyApplyRejectsCanonicalIdsWithMissingOrMismatchedProjectMetadata() {
        List<Map<String, Object>> malformedWeeks = new ArrayList<>();
        Map<String, Object> missingProject = draftWeek();
        missingProject.remove("projectId");
        malformedWeeks.add(missingProject);
        Map<String, Object> mismatchedProject = draftWeek();
        mismatchedProject.put("projectId", "project-b");
        malformedWeeks.add(mismatchedProject);

        for (int index = 0; index < malformedWeeks.size(); index += 1) {
            Fixture fixture = fixture(activeMember(), activeLease());
            Map<String, Object> malformedWeek = malformedWeeks.get(index);
            String idempotencyKey = "monthly-project-metadata-" + index;
            fixture.documents.put(weekPath(), malformedWeek);

            assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
                fixture.persistence
            ).applyCashflowSheetLab(
                ACTOR,
                "project-a",
                SESSION,
                monthlyRequest(
                    idempotencyKey,
                    "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44",
                    ""
                )
            )))
                .isInstanceOf(WeeklyExpenseConflictException.class)
                .hasMessageContaining("migration");

            assertThat(fixture.documents.get(weekPath())).isEqualTo(malformedWeek);
        }
    }

    @Test
    void monthlyApplyRejectsCanonicalIdsWithFractionalWeekNumbers() {
        Fixture fixture = fixture(activeMember(), activeLease());
        Map<String, Object> malformedWeek = draftWeek();
        malformedWeek.put("weekNo", 1.5d);
        fixture.documents.put(weekPath(), malformedWeek);
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
            List.of(malformedWeek)
        );

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            monthlyRequest("monthly-fractional-week", targetRevision, "")
        )))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("migration");

        assertThat(fixture.documents.get(weekPath())).isEqualTo(malformedWeek);
    }

    @Test
    void monthlyApplyRejectsExistingNonCanonicalCashflowAmounts() {
        List<Map<String, Object>> malformedWeeks = new ArrayList<>();
        Map<String, Object> stringProjection = draftWeek();
        stringProjection.put("projection", Map.of("SALES_IN", "100"));
        malformedWeeks.add(stringProjection);
        Map<String, Object> stringActual = draftWeek();
        stringActual.put("actual", Map.of("SALES_IN", "100"));
        malformedWeeks.add(stringActual);
        Map<String, Object> stringActualSource = draftWeek();
        stringActualSource.put("weeklyExpenseActualBySheet", Map.of(
            "bank-import", Map.of("SALES_IN", "100")
        ));
        malformedWeeks.add(stringActualSource);
        Map<String, Object> fractionalProjection = draftWeek();
        fractionalProjection.put("projection", Map.of("SALES_IN", 1.5d));
        malformedWeeks.add(fractionalProjection);
        Map<String, Object> overflowingActual = draftWeek();
        overflowingActual.put("actual", Map.of("SALES_IN", new BigDecimal("9223372036854775808")));
        malformedWeeks.add(overflowingActual);

        for (int index = 0; index < malformedWeeks.size(); index += 1) {
            Fixture fixture = fixture(activeMember(), activeLease());
            Map<String, Object> malformedWeek = malformedWeeks.get(index);
            String idempotencyKey = "monthly-non-numeric-" + index;
            fixture.documents.put(weekPath(), malformedWeek);
            String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
                List.of(malformedWeek)
            );

            assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
                fixture.persistence
            ).applyCashflowSheetLab(
                ACTOR,
                "project-a",
                SESSION,
                monthlyRequest(idempotencyKey, targetRevision, "")
            )))
                .isInstanceOf(WeeklyExpenseConflictException.class)
                .hasMessageContaining("migration");

            assertThat(fixture.documents.get(weekPath())).isEqualTo(malformedWeek);
        }
    }

    @Test
    void exactReplayReturnsWithoutChangingAnExistingLease() {
        Fixture fixture = fixture(activeMember(), activeLease());
        CashflowSheetLabApplyRequest request = monthlyRequest(
            "monthly-final-replay",
            "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44",
            ""
        );
        WeeklyExpenseCommandService service = commandService(fixture.persistence);

        CashflowSheetLabApplyResponse first = fixture.persistence.runCommandTransaction(() -> service.applyCashflowSheetLab(
            ACTOR, "project-a", FINAL_SESSION, request
        ));
        CashflowSheetLabApplyResponse replay = fixture.persistence.runCommandTransaction(() -> service.applyCashflowSheetLab(
            ACTOR, "project-a", FINAL_SESSION, request
        ));

        assertThat(replay).isEqualTo(first);
        assertThat(fixture.documents.get(leasePath("project-a")))
            .containsEntry("state", "ACTIVE")
            .doesNotContainKeys("releasedAt", "releaseReason");
    }

    @Test
    void resultingRevisionChainsSequentialMonthApplies() {
        Fixture fixture = fixture(activeMember(), activeLease());
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        String emptyRevision = "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44";

        CashflowSheetLabApplyResponse july = fixture.persistence.runCommandTransaction(() -> service.applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            monthlyRequest("monthly-chain-july", emptyRevision, "2026-07", "")
        ));
        CashflowSheetLabApplyResponse august = fixture.persistence.runCommandTransaction(() -> service.applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            monthlyRequest("monthly-chain-august", july.resultingTargetRevision(), "2026-08", "")
        ));

        assertThat(july.resultingTargetRevision()).isNotEqualTo(emptyRevision);
        assertThat(august.resultingTargetRevision()).isNotEqualTo(july.resultingTargetRevision());
        assertThat(fixture.documents)
            .containsKeys(
                "orgs/tenant-a/cashflow_weeks/project-a-2026-07-w1",
                "orgs/tenant-a/cashflow_weeks/project-a-2026-08-w1"
            );
        assertThat(fixture.persistence.findCashflowDeclaredWeeklyYear("tenant-a", "project-a"))
            .isEqualTo(2026);
    }

    @Test
    void dashboardLedgerSourceReadsOnlyTheDeclaredWeeklyYear() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put("orgs/tenant-a/cashflow_sheet_mirrors/project-a", Map.of(
            "projectId", "project-a", "weeklyYear", 2026
        ));
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weeks/project-a-2025-12-w5",
            new LinkedHashMap<>(Map.of(
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "yearMonth", "2025-12",
                "weekNo", 5,
                "projection", Map.of("SALES_IN", 2_000_000L),
                "weeklyExpenseActualBySheet", Map.of(
                    "cashflow-sheet-lab",
                    Map.of("SALES_IN", 1_800_000L)
                )
            ))
        );
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weeks/project-a-2026-01-w1",
            new LinkedHashMap<>(Map.of(
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "yearMonth", "2026-01",
                "weekNo", 1,
                "projection", Map.of("SALES_IN", 2_000_000L),
                "weeklyExpenseActualBySheet", Map.of(
                    "cashflow-sheet-lab",
                    Map.of("SALES_IN", 1_800_000L)
                )
            ))
        );

        CashflowLedgerSource source = fixture.persistence
            .findCashflowLedgerSource("tenant-a", "project-a", 2026);

        assertThat(source.projection()).singleElement().satisfies(line ->
            assertThat(line.getAmount()).isEqualByComparingTo("2000000")
        );
        assertThat(source.actual()).singleElement().satisfies(line ->
            assertThat(line.getAmount()).isEqualByComparingTo("1800000")
        );
        assertThat(source.targetRevision()).isEqualTo(FirestoreInheritedWeeklyExpensePersistence
            .computeCashflowTargetRevision(List.of(fixture.documents.get(
                "orgs/tenant-a/cashflow_weeks/project-a-2026-01-w1"
            ))));
        assertThat(fixture.queryReadSizes.getLast()).isEqualTo(1);
    }

    @Test
    void dashboardLedgerSourceIsAbsentWhenTheDeclaredYearHasNoWeekDocuments() {
        Fixture fixture = fixture(activeMember(), activeLease());

        CashflowLedgerSource source = fixture.persistence
            .findCashflowLedgerSource("tenant-a", "project-a", 2026);

        assertThat(source).isNull();
        assertThat(fixture.queryReadSizes.getLast()).isZero();
    }

    @Test
    void dashboardLedgerSourceKeepsARealZeroWhenAWeekDocumentExists() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weeks/project-a-2026-01-w1",
            new LinkedHashMap<>(Map.of(
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "yearMonth", "2026-01",
                "weekNo", 1,
                "projection", Map.of("SALES_IN", 0L),
                "weeklyExpenseActualBySheet", Map.of(
                    "cashflow-sheet-lab",
                    Map.of("SALES_IN", 0L)
                )
            ))
        );

        CashflowLedgerSource source = fixture.persistence
            .findCashflowLedgerSource("tenant-a", "project-a", 2026);

        assertThat(source).isNotNull();
        assertThat(source.projection()).singleElement()
            .extracting(WeeklyExpenseProjectionEntity::getAmount).isEqualTo(BigDecimal.ZERO);
        assertThat(source.actual()).singleElement()
            .extracting(WeeklyExpenseActualEntity::getAmount).isEqualTo(BigDecimal.ZERO);
    }

    @Test
    void absentWeeklyYearDeclarationReturnsNullForExistingAndMissingMirrors() {
        Fixture fixture = fixture(activeMember(), activeLease());
        String mirrorPath = "orgs/tenant-a/cashflow_sheet_mirrors/project-a";
        fixture.documents.put(mirrorPath, Map.of("projectId", "project-a"));

        assertThat(fixture.persistence.findCashflowDeclaredWeeklyYear("tenant-a", "project-a")).isNull();

        fixture.documents.remove(mirrorPath);
        assertThat(fixture.persistence.findCashflowDeclaredWeeklyYear("tenant-a", "project-a")).isNull();
    }

    @Test
    void invalidWeeklyYearDeclarationIsUnavailableInsteadOfThrowingOnARead() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put("orgs/tenant-a/cashflow_sheet_mirrors/project-a", Map.of(
            "projectId", "project-a", "weeklyYear", "2026.0"
        ));

        assertThat(fixture.persistence.findCashflowDeclaredWeeklyYear("tenant-a", "project-a")).isNull();
    }

    @Test
    void projectionSummaryBatchReadsMirrorsAndLedgerOnceForOneWeeklyYear() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put("orgs/tenant-a/cashflow_sheet_mirrors/project-a", Map.of("weeklyYear", 2026));
        fixture.documents.put("orgs/tenant-a/cashflow_sheet_mirrors/project-b", Map.of("weeklyYear", 2026));
        fixture.documents.put("orgs/tenant-a/cashflow_weeks/project-a-2026-07-w1", new LinkedHashMap<>(Map.of(
            "tenantId", "tenant-a", "projectId", "project-a", "yearMonth", "2026-07", "weekNo", 1,
            "projection", Map.of("SALES_IN", 10L)
        )));
        fixture.documents.put("orgs/tenant-a/cashflow_weeks/project-b-2026-07-w1", new LinkedHashMap<>(Map.of(
            "tenantId", "tenant-a", "projectId", "project-b", "yearMonth", "2026-07", "weekNo", 1,
            "projection", Map.of("SALES_IN", 20L)
        )));

        Map<String, Integer> years = fixture.persistence.findCashflowDeclaredWeeklyYears(
            "tenant-a", List.of("project-a", "project-b")
        );
        Map<String, CashflowLedgerSource> sources = fixture.persistence.findCashflowLedgerSources(
            "tenant-a", years, "2023-01", "2026-07"
        );

        assertThat(years).containsExactlyInAnyOrderEntriesOf(Map.of("project-a", 2026, "project-b", 2026));
        assertThat(sources.get("project-a").projection()).singleElement()
            .extracting(WeeklyExpenseProjectionEntity::getAmount).isEqualTo(BigDecimal.TEN);
        assertThat(sources.get("project-b").projection()).singleElement()
            .extracting(WeeklyExpenseProjectionEntity::getAmount).isEqualTo(BigDecimal.valueOf(20));
        assertThat(fixture.getAllSizes).contains(2);
        assertThat(fixture.queryReadSizes.getLast()).isEqualTo(2);
    }

    @Test
    void projectionSummaryBatchOmitsProjectsWithoutWeekDocuments() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put("orgs/tenant-a/cashflow_weeks/project-a-2026-07-w1", new LinkedHashMap<>(Map.of(
            "tenantId", "tenant-a", "projectId", "project-a", "yearMonth", "2026-07", "weekNo", 1,
            "projection", Map.of("SALES_IN", 0L)
        )));

        Map<String, CashflowLedgerSource> sources = fixture.persistence.findCashflowLedgerSources(
            "tenant-a", Map.of("project-a", 2026, "project-b", 2026), "2023-01", "2026-07"
        );

        assertThat(sources).containsOnlyKeys("project-a");
        assertThat(sources.get("project-a").projection()).singleElement()
            .extracting(WeeklyExpenseProjectionEntity::getAmount).isEqualTo(BigDecimal.ZERO);
    }

    @Test
    void weeklyOverviewBatchOmitsProjectsWithoutWeekDocuments() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put("orgs/tenant-a/cashflow_weeks/project-a-2026-07-w1", new LinkedHashMap<>(Map.of(
            "tenantId", "tenant-a", "projectId", "project-a", "yearMonth", "2026-07", "weekNo", 1,
            "projection", Map.of("SALES_IN", 0L)
        )));

        Map<String, CashflowLedgerSource> sources = fixture.persistence.findCashflowLedgerSources(
            "tenant-a", List.of("project-a", "project-b"), "2023-01", "2026-07"
        );

        assertThat(sources).containsOnlyKeys("project-a");
    }

    @Test
    void projectionActualSummaryLedgerReadIsBoundedAndFiltersTheRequestedHorizon() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put("orgs/tenant-a/cashflow_weeks/project-a-2022-12-w5", new LinkedHashMap<>(Map.of(
            "tenantId", "tenant-a", "projectId", "project-a", "yearMonth", "2022-12", "weekNo", 5,
            "projection", Map.of("SALES_IN", 99L)
        )));
        fixture.documents.put("orgs/tenant-a/cashflow_weeks/project-a-2026-07-w5", new LinkedHashMap<>(Map.of(
            "tenantId", "tenant-a", "projectId", "project-a", "yearMonth", "2026-07", "weekNo", 5,
            "projection", Map.of("SALES_IN", 10L)
        )));
        fixture.documents.put("orgs/tenant-a/cashflow_weeks/project-a-2026-08-w1", new LinkedHashMap<>(Map.of(
            "tenantId", "tenant-a", "projectId", "project-a", "yearMonth", "2026-08", "weekNo", 1,
            "projection", Map.of("SALES_IN", 88L)
        )));

        CashflowLedgerSource source = fixture.persistence
            .findCashflowLedgerSource("tenant-a", "project-a", 2026, "2023-01", "2026-07");

        assertThat(source.projection()).singleElement().satisfies(line -> {
            assertThat(line.getYearMonth()).isEqualTo("2026-07");
            assertThat(line.getAmount()).isEqualByComparingTo("10");
        });
    }

    @Test
    void oneMonthLedgerReadDropsFromFiveHundredFortyDocumentsToFive() {
        Fixture fixture = fixture(activeMember(), activeLease());
        YearMonth start = YearMonth.of(2024, 1);
        for (int monthOffset = 0; monthOffset < 108; monthOffset++) {
            String yearMonth = start.plusMonths(monthOffset).toString();
            for (int weekNo = 1; weekNo <= 5; weekNo++) {
                fixture.documents.put(
                    "orgs/tenant-a/cashflow_weeks/project-a-" + yearMonth + "-w" + weekNo,
                    Map.of("projectId", "project-a", "yearMonth", yearMonth, "weekNo", weekNo)
                );
            }
        }
        assertThat(fixture.documents.keySet().stream().filter(path -> path.contains("/cashflow_weeks/")).count())
            .as("unscoped baseline")
            .isEqualTo(540);

        fixture.persistence.findCashflowLedgerSource("tenant-a", "project-a", 2026, "2026-07", "2026-07");

        assertThat(fixture.queryReadSizes.getLast()).isEqualTo(5).isLessThanOrEqualTo(10);

        fixture.persistence.findCashflowLedgerSource("tenant-a", "project-a", 2026, "2026-07", "2026-09");

        assertThat(fixture.queryReadSizes.getLast()).isEqualTo(15);
    }

    @Test
    void cashflowWeekQueriesHaveNoProjectOnlyScanExceptions() throws Exception {
        String source = Files.readString(Path.of(
            "src/main/java/dev/merryai/innerplatform/weekly/storage/FirestoreInheritedWeeklyExpensePersistence.java"
        ));
        assertThat(source).doesNotContain("SPEC-12 approved full scan:");
        assertThat(source).contains(
            "SPEC-16: completion targetRevision remains global",
            "SPEC-16: LIVE_AMENDED compares the historical global targetRevision",
            "QuerySnapshot projectWeekSnapshot = query(cashflowWeeks(actor.tenantId()).whereEqualTo(\"projectId\", projectId))"
        );
        assertThat(source.split(Pattern.quote("cashflowWeeks(tenantId).whereEqualTo(\"projectId\", projectId)"), -1).length - 1)
            .as("only the bounded helper and SPEC-16 LIVE_AMENDED global read use this shape")
            .isEqualTo(2);
    }

    @Test
    void monthCloseAtomicallyPersistsCanonicalValuesAndSnapshotWithoutLease() {
        CloseCashflowMonthRequest request = monthCloseRequest("month-close-1", 0, 3);
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(
            "orgs/tenant-a/cashflow_sheet_mirrors/project-a",
            pinnedMirror(request)
        );
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-06-w3",
            lockedWeeklyCompletion("2026-06", 3, 1)
        );
        WeeklyExpenseCommandService service = commandService(fixture.persistence);

        CashflowMonthCloseResponse response = fixture.persistence.runCommandTransaction(() -> service.closeCashflowMonth(
            ACTOR,
            "project-a",
            SESSION,
            request
        ));
        CashflowMonthCloseResponse replay = fixture.persistence.runCommandTransaction(() -> service.closeCashflowMonth(
            ACTOR,
            "project-a",
            SESSION,
            request
        ));

        Map<String, Object> close = fixture.documents.get(monthClosePath("project-a", "2026-06"));
        Map<String, Object> closeVersion = fixture.documents.get(monthCloseVersionPath("project-a", "2026-06", 1));
        assertThat(response.status()).isEqualTo("CLOSED");
        assertThat(response.revision()).isEqualTo(1);
        assertThat(response.reopenCount()).isZero();
        assertThat(replay.status()).isEqualTo(response.status());
        assertThat(replay.revision()).isEqualTo(response.revision());
        assertThat(replay.snapshotHash()).isEqualTo(response.snapshotHash());
        assertThat(replay.auditId()).isEqualTo(response.auditId());
        assertThat(response.snapshotHash()).startsWith("sha256:");
        assertThat(close)
            .containsEntry("status", "CLOSED")
            .containsEntry("revision", 1L)
            .containsEntry("reopenCount", 0L)
            .containsEntry("amendmentCount", 0)
            .containsEntry("postDeadlineAmendmentWarningCount", 0)
            .containsEntry("lastAmendmentEvidence", Map.of())
            .containsEntry("snapshotHash", response.snapshotHash())
            .containsKeys("snapshot", "closedAt", "closedByUid");
        assertThat((Map<String, Object>) close.get("snapshot"))
            .containsEntry("sourceFingerprint", SOURCE_REVISION)
            .containsEntry("sourceReadAt", NOW.minusSeconds(120).toString())
            .containsEntry("draftRevision", 3L)
            .hasEntrySatisfying("draftInputHash", value -> assertThat(value).asString().startsWith("sha256:"))
            .containsKeys(
                "project", "sheetFacts", "depositScheduleRows", "confirmations",
                "managementChecks", "managementConfirmations", "deadlineSummary",
                "openingBalances", "cells", "weeklyTotals", "projectionTotal", "actualTotal"
            );
        assertThat((List<Map<String, Object>>) ((Map<String, Object>) close.get("snapshot")).get("cells"))
            .hasSize(CashflowSheetLabApplyRequest.EXPECTED_CELL_COUNT)
            .allSatisfy(cell -> assertThat(cell).containsEntry("cellState", "VALUE"));
        assertThat(closeVersion)
            .containsEntry("projectId", "project-a")
            .containsEntry("yearMonth", "2026-06")
            .containsEntry("revision", 1L)
            .containsEntry("snapshotHash", response.snapshotHash())
            .containsKeys("snapshot", "closedAt", "closedByUid");
        assertThat(response.previousSnapshot()).isEmpty();
        assertThat((List<?>) ((Map<String, Object>) close.get("snapshot")).get("depositScheduleRows"))
            .hasSize(5);
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_weeks/project-a-2026-06-w1"))
            .containsKeys("projection", "actual")
            .containsEntry("yearMonth", "2026-06");
        assertThat(fixture.documents.get(leasePath("project-a")))
            .containsEntry("state", "ACTIVE")
            .doesNotContainKeys("releasedAt", "releaseReason");
        assertThat(fixture.documents.keySet())
            .anyMatch(path -> path.startsWith("orgs/tenant-a/weekly_api_audit_events/"))
            .anyMatch(path -> path.startsWith("orgs/tenant-a/weekly_api_idempotency/"));
    }

    @Test
    void monthCloseRejectsAnApplyingSheetPublicationInsideTheFirestoreTransaction() {
        CloseCashflowMonthRequest request = monthCloseRequest("month-close-publication-applying", 0, 3);
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(
            "orgs/tenant-a/cashflow_sheet_publications/project-a",
            new LinkedHashMap<>(Map.of(
                "projectId", "project-a",
                "status", "APPLYING",
                "stagedRunId", "annual-only-stage-run",
                "sourceRevision", SOURCE_REVISION
            ))
        );
        fixture.documents.put(
            "orgs/tenant-a/cashflow_sheet_mirrors/project-a",
            pinnedMirror(request)
        );

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, request)))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("being applied");

        verify(fixture.transaction).get(
            fixture.refs.get("orgs/tenant-a/cashflow_sheet_publications/project-a")
        );
        assertThat(fixture.documents).doesNotContainKey(monthClosePath("project-a", request.yearMonth()));
        assertThat(fixture.documents.keySet()).noneMatch(path ->
            path.startsWith("orgs/tenant-a/cashflow_month_close_versions/")
        );
    }

    @Test
    void monthCloseContinuesWhenTheSheetPublicationLeaseHasExpired() {
        CloseCashflowMonthRequest request = monthCloseRequest("month-close-publication-expired", 0, 3);
        Fixture fixture = fixture(activeMember(), activeLease());
        String publicationPath = "orgs/tenant-a/cashflow_sheet_publications/project-a";
        fixture.documents.put(
            publicationPath,
            new LinkedHashMap<>(Map.of(
                "projectId", "project-a",
                "status", "APPLYING",
                "stagedRunId", "abandoned-stage-run",
                "applyStartedAt", NOW.minusMillis(600_000).toString(),
                "sourceRevision", SOURCE_REVISION
            ))
        );
        fixture.documents.put(
            "orgs/tenant-a/cashflow_sheet_mirrors/project-a",
            pinnedMirror(request)
        );

        fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, request));

        assertThat(fixture.documents).containsKey(monthClosePath("project-a", request.yearMonth()));
        assertThat(fixture.documents.get(publicationPath))
            .containsEntry("status", "APPLYING")
            .containsEntry("stagedRunId", "abandoned-stage-run");
    }

    @Test
    void monthCloseRejectsAnApplyingSheetPublicationWhileItsLeaseIsValid() {
        CloseCashflowMonthRequest request = monthCloseRequest("month-close-publication-valid-lease", 0, 3);
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(
            "orgs/tenant-a/cashflow_sheet_publications/project-a",
            new LinkedHashMap<>(Map.of(
                "projectId", "project-a",
                "status", "APPLYING",
                "applyStartedAt", NOW.minusMillis(599_999).toString()
            ))
        );
        fixture.documents.put(
            "orgs/tenant-a/cashflow_sheet_mirrors/project-a",
            pinnedMirror(request)
        );

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, request)))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessage("Cashflow sheet values are being applied. Retry the month close after the apply finishes.");

        assertThat(fixture.documents).doesNotContainKey(monthClosePath("project-a", request.yearMonth()));
    }

    @Test
    @SuppressWarnings("unchecked")
    void monthCloseTransactionRetriesAndRejectsAnAnnualOnlyPublicationReservedAfterItsFirstRead() {
        CloseCashflowMonthRequest request = monthCloseRequest("month-close-publication-race", 0, 3);
        Fixture fixture = fixture(activeMember(), activeLease());
        String publicationPath = "orgs/tenant-a/cashflow_sheet_publications/project-a";
        fixture.documents.put(publicationPath, new LinkedHashMap<>(Map.of(
            "projectId", "project-a",
            "status", "READY"
        )));
        fixture.documents.put(
            "orgs/tenant-a/cashflow_sheet_mirrors/project-a",
            pinnedMirror(request)
        );

        when(fixture.db.runTransaction(any())).thenAnswer(invocation -> {
            Transaction.Function<Object> callback = invocation.getArgument(0);
            fixture.pendingWrites.clear();
            try {
                callback.updateCallback(fixture.transaction);
                fixture.pendingWrites.clear();
                fixture.documents.put(publicationPath, new LinkedHashMap<>(Map.of(
                    "projectId", "project-a",
                    "status", "APPLYING",
                    "stagedRunId", "annual-only-race",
                    "sourceScope", "ANNUAL",
                    "sourceRevision", SOURCE_REVISION
                )));
                Object retried = callback.updateCallback(fixture.transaction);
                for (PendingWrite write : fixture.pendingWrites) {
                    Map<String, Object> document = write.merge()
                        ? new LinkedHashMap<>(fixture.documents.getOrDefault(write.ref().getPath(), Map.of()))
                        : new LinkedHashMap<>();
                    document.putAll(write.data());
                    fixture.documents.put(write.ref().getPath(), document);
                }
                fixture.pendingWrites.clear();
                return ApiFutures.immediateFuture(retried);
            } catch (Throwable error) {
                fixture.pendingWrites.clear();
                return ApiFutures.immediateFailedFuture(error);
            }
        });

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, request)))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("being applied");

        verify(fixture.transaction, times(2)).get(fixture.refs.get(publicationPath));
        assertThat(fixture.documents).doesNotContainKey(monthClosePath("project-a", request.yearMonth()));
        assertThat(fixture.documents.keySet()).noneMatch(path ->
            path.startsWith("orgs/tenant-a/cashflow_month_close_versions/")
        );
    }

    @Test
    void weeklyCashflowCompletionLocksTheCurrentLedgerSnapshotAndKeepsItsFirstActor() {
        Fixture fixture = fixture(activeMember(), Map.of());
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weeks/project-a-2026-07-w3",
            new LinkedHashMap<>(Map.of(
                "id", "project-a-2026-07-w3",
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "yearMonth", "2026-07",
                "weekNo", 3,
                "projection", Map.of("SALES_IN", 100L),
                "actual", Map.of("SALES_IN", 90L)
            ))
        );
        putCompleteProjectionWindow(fixture, "2026-07", 3);
        String appliedTargetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
            fixture.documents.entrySet().stream()
                .filter(entry -> entry.getKey().contains("/cashflow_weeks/"))
                .map(Map.Entry::getValue)
                .toList()
        );
        fixture.documents.put(
            "orgs/tenant-a/cashflow_sheet_mirrors/project-a",
            Map.of(
                "projectId", "project-a",
                "weeklyYear", 2026,
                "status", "FRESH",
                "sourceRevision", SOURCE_REVISION,
                "appliedSourceRevision", SOURCE_REVISION,
                "targetRevisionAtFetch", appliedTargetRevision,
                "appliedTargetRevision", appliedTargetRevision,
                "sheetFacts", Map.of("weeklyCalculationChecks", List.of(Map.of(
                    "mode", "projection",
                    "yearMonth", "2026-07",
                    "weekNo", 3,
                    "reported", Map.of(
                        "openingBalance", 900L,
                        "depositTotal", 150L,
                        "withdrawalTotal", 50L,
                        "balance", 1_000L
                    ),
                    "sourceCells", Map.of(
                        "openingBalance", "D20",
                        "depositTotal", "AN20",
                        "withdrawalTotal", "AN29",
                        "balance", "AN30"
                    )
                ), Map.of(
                    "mode", "projection",
                    "yearMonth", "2026-07",
                    "weekNo", 4,
                    "reported", Map.of(
                        "openingBalance", 1_000L,
                        "depositTotal", 200L,
                        "withdrawalTotal", 50L,
                        "balance", 1_150L
                    ),
                    "sourceCells", Map.of(
                        "openingBalance", "D20",
                        "depositTotal", "AO20",
                        "withdrawalTotal", "AO29",
                        "balance", "AO30"
                    )
                )))
            )
        );
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        CompleteCashflowWeeklyUpdateRequest firstRequest = new CompleteCashflowWeeklyUpdateRequest(
            "weekly-complete-1", "2026-07", 3, "2026-07-16T09:00:00Z"
        );
        CompleteCashflowWeeklyUpdateRequest secondRequest = new CompleteCashflowWeeklyUpdateRequest(
            "weekly-complete-2", "2026-07", 3, "2026-07-16T10:00:00Z"
        );

        CashflowWeeklyUpdateCompletionResponse first = fixture.persistence.runCommandTransaction(() ->
            service.completeCashflowWeeklyUpdate(ACTOR, "project-a", firstRequest)
        );
        CashflowWeeklyUpdateCompletionResponse second = fixture.persistence.runCommandTransaction(() ->
            service.completeCashflowWeeklyUpdate(ACTOR, "project-a", secondRequest)
        );
        CashflowWeeklyUpdateCompletionResponse read = fixture.persistence.runCommandTransaction(() ->
            service.readCashflowWeeklyUpdate(READ_ACTOR, "project-a", "2026-07", 3)
        );

        assertThat(first.alreadyCompleted()).isFalse();
        assertThat(second.alreadyCompleted()).isTrue();
        assertThat(second.completedAt()).isEqualTo(first.completedAt());
        assertThat(read.status()).isEqualTo("SUBMITTED");
        assertThat(read.snapshotHash()).isEqualTo(first.snapshotHash());
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3"
        ))
            .containsEntry("projectId", "project-a")
            .containsEntry("yearMonth", "2026-07")
            .containsEntry("weekNo", 3)
            .containsEntry("status", "SUBMITTED")
            .containsEntry("revision", 1L)
            .containsEntry("sourceRevision", SOURCE_REVISION)
            .containsEntry("completedAt", "2026-07-16T09:00:00Z")
            .containsEntry("completedByUid", "pm-1")
            .satisfies(value -> assertThat(value.get("snapshotHash")).asString().startsWith("sha256:"))
            .satisfies(value -> assertThat(value.get("targetRevision")).asString().startsWith("sha256:"))
            .containsKey("snapshot");
        Map<?, ?> completionSnapshot = (Map<?, ?>) fixture.documents.get(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3"
        ).get("snapshot");
        Map<?, ?> forecastBaseline = (Map<?, ?>) completionSnapshot.get("forecastBaseline");
        assertThat(forecastBaseline.get("contractVersion")).isEqualTo("cashflow-forecast-baseline-v1");
        assertThat(forecastBaseline.get("status")).isEqualTo("AVAILABLE");
        assertThat(forecastBaseline.get("yearMonth")).isEqualTo("2026-07");
        assertThat(forecastBaseline.get("weekNo")).isEqualTo(4);
        assertThat(forecastBaseline.get("sourceRevision")).isEqualTo(SOURCE_REVISION);
        assertThat(forecastBaseline.get("reported")).isEqualTo(Map.of(
            "openingBalance", 1_000L,
            "depositTotal", 200L,
            "withdrawalTotal", 50L,
            "balance", 1_150L
        ));
        Map<?, ?> baselineSourceCells = (Map<?, ?>) forecastBaseline.get("sourceCells");
        assertThat(baselineSourceCells.get("openingBalance")).isEqualTo("AN30");
        assertThat(baselineSourceCells.get("balance")).isEqualTo("AO30");
        assertThat(fixture.documents.keySet())
            .anyMatch(path -> path.startsWith(
                "orgs/tenant-a/cashflow_weekly_update_completion_versions/project-a-2026-07-w3-r1"
            ));
        assertThat(fixture.documents.keySet().stream()
            .filter(path -> path.contains("/cashflow_weekly_update_completions/")))
            .containsExactly("orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3");
        assertThat(fixture.documents.keySet().stream()
            .filter(path -> path.contains("/cashflow_weekly_update_completion_versions/")))
            .containsExactly("orgs/tenant-a/cashflow_weekly_update_completion_versions/project-a-2026-07-w3-r1");
    }

    @Test
    void weeklyCompletionWhitelistsForecastBaselineFieldsWithoutTrustingMirrorExtras() {
        Fixture fixture = fixture(activeMember(), Map.of());
        putCompleteProjectionWindow(fixture, "2026-07", 3);
        String appliedTargetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
            fixture.documents.entrySet().stream()
                .filter(entry -> entry.getKey().contains("/cashflow_weeks/"))
                .map(Map.Entry::getValue)
                .toList()
        );
        Map<String, Object> reported = new LinkedHashMap<>(Map.of(
            "openingBalance", 1_000L,
            "depositTotal", 200L,
            "withdrawalTotal", 50L,
            "balance", 1_150L
        ));
        reported.put("legacyExtra", null);
        Map<String, Object> sourceCells = new LinkedHashMap<>(Map.of(
            "openingBalance", "D20",
            "depositTotal", "AO20",
            "withdrawalTotal", "AO29",
            "balance", "AO30"
        ));
        sourceCells.put("legacyExtra", null);
        fixture.documents.put(
            "orgs/tenant-a/cashflow_sheet_mirrors/project-a",
            Map.of(
                "projectId", "project-a",
                "weeklyYear", 2026,
                "status", "FRESH",
                "sourceRevision", SOURCE_REVISION,
                "appliedSourceRevision", SOURCE_REVISION,
                "targetRevisionAtFetch", appliedTargetRevision,
                "appliedTargetRevision", appliedTargetRevision,
                "sheetFacts", Map.of("weeklyCalculationChecks", List.of(Map.of(
                    "mode", "projection",
                    "yearMonth", "2026-07",
                    "weekNo", 3,
                    "sourceCells", Map.of("balance", "AN30")
                ), Map.of(
                    "mode", "projection",
                    "yearMonth", "2026-07",
                    "weekNo", 4,
                    "reported", reported,
                    "sourceCells", sourceCells
                )))
            )
        );

        CashflowWeeklyUpdateCompletionResponse response = fixture.persistence.runCommandTransaction(() ->
            commandService(fixture.persistence).completeCashflowWeeklyUpdate(
                ACTOR,
                "project-a",
                new CompleteCashflowWeeklyUpdateRequest(
                    "weekly-baseline-extra-null", "2026-07", 3, "2026-07-16T09:00:00Z"
                )
            )
        );

        assertThat(response.status()).isEqualTo("SUBMITTED");
        Map<?, ?> completion = fixture.documents.get(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3"
        );
        Map<?, ?> snapshot = (Map<?, ?>) completion.get("snapshot");
        Map<?, ?> baseline = (Map<?, ?>) snapshot.get("forecastBaseline");
        assertThat(baseline.get("status")).isEqualTo("AVAILABLE");
        assertThat(((Map<?, ?>) baseline.get("reported")).keySet()).isEqualTo(Set.of(
            "openingBalance", "depositTotal", "withdrawalTotal", "balance"
        ));
        assertThat(((Map<?, ?>) baseline.get("sourceCells")).keySet()).isEqualTo(Set.of(
            "openingBalance", "depositTotal", "withdrawalTotal", "balance"
        ));
    }

    @Test
    void malformedForecastMirrorEvidenceNeverAbortsTheCanonicalWeeklyCompletion() {
        List<Object> malformedChecks = List.of(
            List.of(Map.of(
                "mode", "projection",
                "yearMonth", "2026-07",
                "weekNo", 3,
                "sourceCells", Map.of("balance", "AN30")
            ), Map.of(
                "mode", "projection",
                "yearMonth", "2026-07",
                "weekNo", 4,
                "reported", Map.of(
                    "openingBalance", 1_000L,
                    "depositTotal", "200",
                    "withdrawalTotal", 50L,
                    "balance", 1_150L
                ),
                "sourceCells", Map.of(
                    "openingBalance", "D20",
                    "depositTotal", "AO20",
                    "withdrawalTotal", "AO29",
                    "balance", "AO30"
                )
            )),
            List.of("not-a-weekly-check", 42L)
        );

        for (int index = 0; index < malformedChecks.size(); index++) {
            int scenario = index;
            Fixture fixture = fixture(activeMember(), Map.of());
            putCompleteProjectionWindow(fixture, "2026-07", 3);
            String appliedTargetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
                fixture.documents.entrySet().stream()
                    .filter(entry -> entry.getKey().contains("/cashflow_weeks/"))
                    .map(Map.Entry::getValue)
                    .toList()
            );
            fixture.documents.put(
                "orgs/tenant-a/cashflow_sheet_mirrors/project-a",
                Map.of(
                    "projectId", "project-a",
                    "weeklyYear", 2026,
                    "status", "FRESH",
                    "sourceRevision", SOURCE_REVISION,
                    "appliedSourceRevision", SOURCE_REVISION,
                    "targetRevisionAtFetch", appliedTargetRevision,
                    "appliedTargetRevision", appliedTargetRevision,
                    "sheetFacts", Map.of("weeklyCalculationChecks", malformedChecks.get(scenario))
                )
            );

            CashflowWeeklyUpdateCompletionResponse response = fixture.persistence.runCommandTransaction(() ->
                commandService(fixture.persistence).completeCashflowWeeklyUpdate(
                    ACTOR,
                    "project-a",
                    new CompleteCashflowWeeklyUpdateRequest(
                        "weekly-baseline-malformed-" + scenario,
                        "2026-07",
                        3,
                        "2026-07-16T09:00:00Z"
                    )
                )
            );

            assertThat(response.status()).isEqualTo("SUBMITTED");
            Map<?, ?> completion = fixture.documents.get(
                "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3"
            );
            Map<?, ?> snapshot = (Map<?, ?>) completion.get("snapshot");
            Map<?, ?> baseline = (Map<?, ?>) snapshot.get("forecastBaseline");
            assertThat(baseline.get("status")).isEqualTo("UNAVAILABLE");
            assertThat(baseline.get("reason")).isEqualTo("SHEET_PROJECTION_FORMULA_UNAVAILABLE");
            assertThat(baseline.containsKey("reported")).isFalse();
        }
    }

    @Test
    void weeklyCompletionDoesNotInventAForecastBaselineFromAnUnappliedMirror() {
        Fixture fixture = fixture(activeMember(), Map.of());
        putCompleteProjectionWindow(fixture, "2026-07", 3);
        fixture.documents.put(
            "orgs/tenant-a/cashflow_sheet_mirrors/project-a",
            Map.of(
                "projectId", "project-a",
                "weeklyYear", 2026,
                "sourceRevision", SOURCE_REVISION,
                "sheetFacts", Map.of("weeklyCalculationChecks", List.of(Map.of(
                    "mode", "projection",
                    "yearMonth", "2026-07",
                    "weekNo", 4,
                    "reported", Map.of(
                        "openingBalance", 1_000L,
                        "depositTotal", 200L,
                        "withdrawalTotal", 50L,
                        "balance", 1_150L
                    )
                )))
            )
        );

        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .completeCashflowWeeklyUpdate(
                ACTOR,
                "project-a",
                new CompleteCashflowWeeklyUpdateRequest(
                    "weekly-baseline-unapplied", "2026-07", 3, "2026-07-16T09:00:00Z"
                )
            ));

        Map<?, ?> completion = fixture.documents.get(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3"
        );
        Map<?, ?> snapshot = (Map<?, ?>) completion.get("snapshot");
        Map<?, ?> baseline = (Map<?, ?>) snapshot.get("forecastBaseline");
        assertThat(baseline.get("status")).isEqualTo("UNAVAILABLE");
        assertThat(baseline.get("reason")).isEqualTo("SHEET_REVISION_MISMATCH");
        assertThat(baseline.containsKey("reported")).isFalse();
    }

    @Test
    void weeklyCompletionDoesNotCreateAForecastBaselineOutsideTheSheetWeeklyYear() {
        Fixture fixture = fixture(activeMember(), Map.of());
        putCompleteProjectionWindow(fixture, "2026-12", 5);
        String appliedTargetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
            fixture.documents.entrySet().stream()
                .filter(entry -> entry.getKey().contains("/cashflow_weeks/"))
                .map(Map.Entry::getValue)
                .toList()
        );
        fixture.documents.put(
            "orgs/tenant-a/cashflow_sheet_mirrors/project-a",
            Map.of(
                "projectId", "project-a",
                "weeklyYear", 2026,
                "status", "FRESH",
                "sourceRevision", SOURCE_REVISION,
                "appliedSourceRevision", SOURCE_REVISION,
                "targetRevisionAtFetch", appliedTargetRevision,
                "appliedTargetRevision", appliedTargetRevision,
                "sheetFacts", Map.of("weeklyCalculationChecks", List.of())
            )
        );

        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .completeCashflowWeeklyUpdate(
                ACTOR,
                "project-a",
                new CompleteCashflowWeeklyUpdateRequest(
                    "weekly-baseline-outside-grain", "2026-12", 5, "2026-12-31T09:00:00Z"
                )
            ));

        Map<?, ?> completion = fixture.documents.get(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-12-w5"
        );
        Map<?, ?> snapshot = (Map<?, ?>) completion.get("snapshot");
        assertThat(snapshot.containsKey("forecastBaseline")).isFalse();
    }

    @Test
    void weeklyCompletionDoesNotCaptureAForecastBaselineFromTargetRevisionDrift() {
        Fixture fixture = fixture(activeMember(), Map.of());
        putCompleteProjectionWindow(fixture, "2026-07", 3);
        String appliedTargetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
            fixture.documents.entrySet().stream()
                .filter(entry -> entry.getKey().contains("/cashflow_weeks/"))
                .map(Map.Entry::getValue)
                .toList()
        );
        fixture.documents.put(
            "orgs/tenant-a/cashflow_sheet_mirrors/project-a",
            Map.of(
                "projectId", "project-a",
                "weeklyYear", 2026,
                "status", "FRESH",
                "sourceRevision", SOURCE_REVISION,
                "appliedSourceRevision", SOURCE_REVISION,
                "targetRevisionAtFetch", "sha256:stale-target",
                "appliedTargetRevision", appliedTargetRevision,
                "sheetFacts", Map.of("weeklyCalculationChecks", List.of(Map.of(
                    "mode", "projection",
                    "yearMonth", "2026-07",
                    "weekNo", 4,
                    "reported", Map.of(
                        "openingBalance", 1_000L,
                        "depositTotal", 200L,
                        "withdrawalTotal", 50L,
                        "balance", 1_150L
                    ),
                    "sourceCells", Map.of(
                        "openingBalance", "D20",
                        "depositTotal", "AO20",
                        "withdrawalTotal", "AO29",
                        "balance", "AO30"
                    )
                )))
            )
        );

        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .completeCashflowWeeklyUpdate(
                ACTOR,
                "project-a",
                new CompleteCashflowWeeklyUpdateRequest(
                    "weekly-baseline-target-drift", "2026-07", 3, "2026-07-16T09:00:00Z"
                )
            ));

        Map<?, ?> completion = fixture.documents.get(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3"
        );
        Map<?, ?> snapshot = (Map<?, ?>) completion.get("snapshot");
        Map<?, ?> baseline = (Map<?, ?>) snapshot.get("forecastBaseline");
        assertThat(baseline.get("status")).isEqualTo("UNAVAILABLE");
        assertThat(baseline.get("reason")).isEqualTo("SHEET_REVISION_MISMATCH");
        assertThat(baseline.containsKey("reported")).isFalse();
    }

    @Test
    void weeklyCompletionRetryIgnoresRegeneratedTimestampButRejectsADifferentScope() {
        Fixture fixture = fixture(activeMember(), Map.of());
        putCompleteProjectionWindow(fixture, "2026-07", 3);
        putCompleteProjectionWindow(fixture, "2026-07", 4);
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        CompleteCashflowWeeklyUpdateRequest firstRequest = new CompleteCashflowWeeklyUpdateRequest(
            "weekly-retry-stable", "2026-07", 3, "2026-07-16T09:00:00Z"
        );
        CompleteCashflowWeeklyUpdateRequest retriedRequest = new CompleteCashflowWeeklyUpdateRequest(
            "weekly-retry-stable", "2026-07", 3, "2026-07-16T09:00:15Z"
        );

        CashflowWeeklyUpdateCompletionResponse first = fixture.persistence.runCommandTransaction(() ->
            service.completeCashflowWeeklyUpdate(ACTOR, "project-a", firstRequest)
        );
        CashflowWeeklyUpdateCompletionResponse replay = fixture.persistence.runCommandTransaction(() ->
            service.completeCashflowWeeklyUpdate(ACTOR, "project-a", retriedRequest)
        );

        assertThat(replay).isEqualTo(first);
        Map<?, ?> periods = (Map<?, ?>) fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-07"
        ).get("periods");
        Map<?, ?> weeklyStatus = (Map<?, ?>) periods.get("WEEK_3");
        assertThat(weeklyStatus.get("status")).isEqualTo("PENDING_APPROVAL");
        assertThat(weeklyStatus.get("revision")).isEqualTo(1L);
        assertThat(fixture.documents.keySet().stream()
            .filter(path -> path.contains("/cashflow_weekly_update_completion_versions/")))
            .hasSize(1);
        assertThat(fixture.documents.keySet().stream()
            .filter(path -> path.contains("/weekly_api_audit_events/")))
            .hasSize(1);

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
            service.completeCashflowWeeklyUpdate(
                ACTOR,
                "project-a",
                new CompleteCashflowWeeklyUpdateRequest(
                    "weekly-retry-stable", "2026-07", 4, "2026-07-16T09:00:30Z"
                )
            )
        ))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("Idempotency key");
    }

    @Test
    void weeklyLockReadAndReplayAllowCanonicalLedgerDriftWithoutReopen() {
        Fixture fixture = fixture(activeMember(), Map.of());
        String path = "orgs/tenant-a/cashflow_weeks/project-a-2026-07-w3";
        fixture.documents.put(path, new LinkedHashMap<>(Map.of(
            "id", "project-a-2026-07-w3",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-07",
            "weekNo", 3,
            "projection", Map.of("SALES_IN", 100L),
            "actual", Map.of()
        )));
        putCompleteProjectionWindow(fixture, "2026-07", 3);
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        fixture.persistence.runCommandTransaction(() -> service.completeCashflowWeeklyUpdate(
            ACTOR,
            "project-a",
            new CompleteCashflowWeeklyUpdateRequest(
                "weekly-drift-lock", "2026-07", 3, "2026-07-16T09:00:00Z"
            )
        ));
        Map<String, Object> drifted = new LinkedHashMap<>(fixture.documents.get(path));
        Map<String, Object> driftedProjection = new LinkedHashMap<>((Map<String, Object>) drifted.get("projection"));
        driftedProjection.put("SALES_IN", 999L);
        drifted.put("projection", driftedProjection);
        fixture.documents.put(path, drifted);

        CashflowWeeklyUpdateCompletionResponse read = fixture.persistence.runCommandTransaction(() ->
            service.readCashflowWeeklyUpdate(READ_ACTOR, "project-a", "2026-07", 3)
        );
        CashflowWeeklyUpdateCompletionResponse replay = fixture.persistence.runCommandTransaction(() ->
            service.completeCashflowWeeklyUpdate(
                ACTOR,
                "project-a",
                new CompleteCashflowWeeklyUpdateRequest(
                    "weekly-drift-replay", "2026-07", 3, "2026-07-16T10:00:00Z"
                )
            )
        );

        assertThat(read.status()).isEqualTo("SUBMITTED");
        assertThat(replay.alreadyCompleted()).isTrue();
        assertThat(replay.revision()).isEqualTo(1L);

        String completionPath = "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3";
        Map<String, Object> tamperedCompletion = new LinkedHashMap<>(fixture.documents.get(completionPath));
        Map<String, Object> tamperedSnapshot = new LinkedHashMap<>((Map<String, Object>) tamperedCompletion.get("snapshot"));
        tamperedSnapshot.put("projection", Map.of("SALES_IN", 777L));
        tamperedCompletion.put("snapshot", tamperedSnapshot);
        fixture.documents.put(completionPath, tamperedCompletion);

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
            service.readCashflowWeeklyUpdate(READ_ACTOR, "project-a", "2026-07", 3)
        ))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("snapshot integrity");
    }

    @Test
    void lockedCashflowWeekRemainsOperationalStatusWhileProjectionChanges() {
        Fixture fixture = fixture(activeMember(), Map.of());
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weeks/project-a-2026-07-w3",
            new LinkedHashMap<>(Map.of(
                "id", "project-a-2026-07-w3",
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "yearMonth", "2026-07",
                "weekNo", 3,
                "projection", Map.of("SALES_IN", 100L),
                "actual", Map.of()
            ))
        );
        putCompleteProjectionWindow(fixture, "2026-07", 3);
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        CompleteCashflowWeeklyUpdateRequest lock = new CompleteCashflowWeeklyUpdateRequest(
            "weekly-lock-1", "2026-07", 3, "2026-07-16T09:00:00Z"
        );

        fixture.persistence.runCommandTransaction(() ->
            service.completeCashflowWeeklyUpdate(ACTOR, "project-a", lock)
        );

        assertThatCode(() -> fixture.persistence.runCommandTransaction(() -> service.upsertProjection(
            ACTOR,
            "project-a",
            FINAL_SESSION,
            new UpsertProjectionRequest("projection-while-locked", List.of(
                new UpsertProjectionRequest.ProjectionLinePatch("2026-07", 3, "SALES_IN", BigDecimal.valueOf(200))
            ))
        ))).doesNotThrowAnyException();

        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_weeks/project-a-2026-07-w3"))
            .hasEntrySatisfying("projection", value -> assertThat((Map<String, Object>) value)
                .containsEntry("SALES_IN", 200L));
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3"
        )).containsEntry("status", "SUBMITTED");
    }

    @Test
    void aLockedWeekDoesNotBlockProjectionInAnotherWeek() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3",
            lockedWeeklyCompletion("2026-07", 3, 1)
        );

        assertThatCode(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).upsertProjection(
            ACTOR,
            "project-a",
            SESSION,
            new UpsertProjectionRequest("different-week", List.of(
                new UpsertProjectionRequest.ProjectionLinePatch(
                    "2026-07", 4, "SALES_IN", BigDecimal.valueOf(200)
                )
            ))
        ))).doesNotThrowAnyException();

        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_weeks/project-a-2026-07-w4"))
            .hasEntrySatisfying("projection", value -> assertThat((Map<String, Object>) value)
                .containsEntry("SALES_IN", 200L));
    }

    @Test
    void sheetApplyChangesASettledWeekWithoutWeeklyConfirmation() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3",
            lockedWeeklyCompletion("2026-07", 3, 1)
        );
        String targetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());
        CashflowSheetLabApplyResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetLab(
            ACTOR,
            "project-a",
            SESSION,
            monthlyRequest("locked-sheet-apply", targetRevision, "")
        ));

        assertThat(response.settledWeekChanges()).isEmpty();
        assertThat(fixture.documents.keySet()).anyMatch(path -> path.contains("/cashflow_weeks/"));
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3"
        ))
            .containsEntry("status", "LOCKED")
            .doesNotContainKeys("postSettlementChangeWarningCount", "lastPostSettlementChangeByUid");
        assertThat(fixture.documents.keySet())
            .noneMatch(path -> path.contains("/cashflow_weekly_settlement_change_warnings/"));
    }

    @Test
    void sheetApplySkipsAnUnchangedLockedWeekAndUpdatesOnlyTheChangedOpenWeek() {
        Fixture fixture = fixture(activeMember(), activeLease());
        String emptyRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());
        CashflowSheetLabApplyRequest initialRequest = monthlyRequest(
            "sheet-initial-before-week-lock",
            emptyRevision,
            ""
        );
        CashflowSheetLabApplyResponse initial = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetLab(ACTOR, "project-a", SESSION, initialRequest));
        String lockedPath = "orgs/tenant-a/cashflow_weeks/project-a-2026-07-w3";
        Map<String, Object> lockedBefore = new LinkedHashMap<>(fixture.documents.get(lockedPath));
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3",
            lockedWeeklyCompletion("2026-07", 3, 1)
        );
        List<CashflowSheetLabApplyRequest.Cell> changedCells = initialRequest.cells().stream()
            .map(cell -> "projection".equals(cell.mode())
                && cell.weekNo() == 4
                && "SALES_IN".equals(cell.cashflowLine())
                    ? new CashflowSheetLabApplyRequest.Cell(
                        cell.mode(), cell.weekNo(), cell.cashflowLine(), "VALUE", BigDecimal.valueOf(101),
                        cell.sourceCell(), cell.sourceLabel()
                    )
                    : cell)
            .toList();
        CashflowSheetLabApplyRequest changedRequest = new CashflowSheetLabApplyRequest(
            "sheet-open-week-change",
            SOURCE_REVISION,
            initial.resultingTargetRevision(),
            "2026-07",
            false,
            null,
            null,
            initialRequest.calculationChecks(),
            changedCells
        );

        assertThatCode(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetLab(ACTOR, "project-a", SESSION, changedRequest)))
            .doesNotThrowAnyException();

        assertThat(fixture.documents.get(lockedPath)).isEqualTo(lockedBefore);
        assertThat((Map<String, Object>) fixture.documents.get(
            "orgs/tenant-a/cashflow_weeks/project-a-2026-07-w4"
        ).get("projection"))
            .containsEntry("SALES_IN", 101L);
    }

    @Test
    void sheetApplyMaterializesAnAbsentAllEmptyWeekAndKeepsTargetRevisionStable() {
        Fixture fixture = fixture(activeMember(), activeLease());
        String emptyRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(List.of());
        CashflowSheetLabApplyRequest base = monthlyRequest("sheet-empty-week", emptyRevision, "");
        List<CashflowSheetLabApplyRequest.Cell> cells = base.cells().stream()
            .map(cell -> cell.weekNo() == 5
                ? new CashflowSheetLabApplyRequest.Cell(
                    cell.mode(), cell.weekNo(), cell.cashflowLine(), "EMPTY", null,
                    cell.sourceCell(), cell.sourceLabel()
                )
                : cell)
            .toList();
        CashflowSheetLabApplyRequest request = new CashflowSheetLabApplyRequest(
            base.idempotencyKey(),
            base.sourceRevision(),
            base.targetRevision(),
            base.yearMonth(),
            base.replaceAllActualSources(),
            null,
            null,
            base.calculationChecks(),
            cells
        );

        CashflowSheetLabApplyResponse first = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetLab(ACTOR, "project-a", SESSION, request));
        String emptyWeekPath = "orgs/tenant-a/cashflow_weeks/project-a-2026-07-w5";
        assertThat(fixture.documents).containsKey(emptyWeekPath);
        List<Map<String, Object>> persistedWeeks = fixture.documents.entrySet().stream()
            .filter(entry -> entry.getKey().startsWith("orgs/tenant-a/cashflow_weeks/project-a-2026-07-w"))
            .map(Map.Entry::getValue)
            .toList();
        assertThat(first.resultingTargetRevision()).isEqualTo(
            FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(persistedWeeks)
        );

        CashflowSheetLabApplyRequest replay = new CashflowSheetLabApplyRequest(
            "sheet-empty-week-replay",
            SOURCE_REVISION,
            first.resultingTargetRevision(),
            "2026-07",
            false,
            null,
            null,
            base.calculationChecks(),
            cells
        );
        CashflowSheetLabApplyResponse second = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).applyCashflowSheetLab(ACTOR, "project-a", SESSION, replay));
        assertThat(second.resultingTargetRevision()).isEqualTo(first.resultingTargetRevision());
    }

    @Test
    void weeklyExpenseActualReplacementIgnoresWeeklySettlementStatus() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(weekPath(), draftWeek());
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w1",
            lockedWeeklyCompletion("2026-07", 1, 1)
        );

        assertThatCode(() -> fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            fixture.persistence.replaceActualLines(
                "tenant-a",
                "project-a",
                "cashflow-sheet-lab",
                List.of(new SaveDraftResponse.ActualDelta(
                    "2026-07", 1, "SALES_IN", BigDecimal.valueOf(50)
                ))
            );
            return null;
        })).doesNotThrowAnyException();
        assertThat(fixture.documents.get(weekPath()))
            .hasEntrySatisfying("actual", value -> assertThat((Map<String, Object>) value)
                .containsEntry("SALES_IN", 50L));
    }

    @Test
    void weeklySheetActualReplacementIgnoresWeeklySettlementStatus() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(weekPath(), draftWeek());
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w1",
            lockedWeeklyCompletion("2026-07", 1, 1)
        );
        WeeklyExpenseSheetEntity sheet = new WeeklyExpenseSheetEntity(
            "tenant-a", "project-a", "default", "Default"
        );

        assertThatCode(() -> fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            fixture.persistence.replaceActuals(
                sheet,
                List.of(new SaveDraftResponse.ActualDelta(
                    "2026-07", 1, "SALES_IN", BigDecimal.valueOf(50)
                ))
            );
            return null;
        })).doesNotThrowAnyException();
        assertThat(fixture.documents.get(weekPath()))
            .hasEntrySatisfying("actual", value -> assertThat((Map<String, Object>) value)
                .containsEntry("SALES_IN", 50L));
    }

    @Test
    void submitAndCloseCommandsIgnoreWeeklySettlementStatus() {
        Fixture submitFixture = fixture(activeMember(), activeLease());
        submitFixture.documents.put(weekPath(), draftWeek());
        submitFixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w1",
            lockedWeeklyCompletion("2026-07", 1, 1)
        );

        assertThatCode(() -> submitFixture.persistence.runCommandTransaction(() -> commandService(
            submitFixture.persistence
        ).submitWeek(
            ACTOR,
            "project-a",
            SESSION,
            new SubmitWeekRequest("locked-submit", "2026-07", 1)
        ))).doesNotThrowAnyException();

        Fixture closeFixture = fixture(
            member(Map.of("role", "finance", "projectIds", List.of())),
            activeLease()
        );
        closeFixture.documents.put(weekPath(), submittedWeek());
        closeFixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w1",
            lockedWeeklyCompletion("2026-07", 1, 1)
        );

        assertThatCode(() -> closeFixture.persistence.runCommandTransaction(() -> commandService(
            closeFixture.persistence
        ).closeWeek(
            ACTOR,
            "project-a",
            SESSION,
            closeRequest("locked-close", BigDecimal.valueOf(100))
        ))).doesNotThrowAnyException();
    }

    @Test
    void submitWithASheetDoesNotReadWeeklySettlementAsAWriteGuard() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(weekPath(), draftWeek());
        SubmitWeekRequest request = new SubmitWeekRequest(
            "submit-read-before-write",
            "2026-07",
            1,
            new SubmitWeekRequest.WeeklySheetSnapshot("default", null, "Default", List.of())
        );

        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence).submitWeek(
            ACTOR,
            "project-a",
            SESSION,
            request
        ));

        verify(fixture.transaction, never()).get(argThat((DocumentReference ref) -> ref.getPath().equals(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w1"
        )));
        verify(fixture.transaction).set(argThat((DocumentReference ref) -> ref.getPath().equals(sheetPath())), any(), any());
    }

    @Test
    void unchangedWeeklyStatusIsANoOpInsideALockedWeek() {
        Fixture fixture = fixture(
            member(Map.of("role", "finance", "projectIds", List.of())),
            activeLease()
        );
        Map<String, Object> closed = closedWeek();
        fixture.documents.put(weekPath(), new LinkedHashMap<>(closed));
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w1",
            lockedWeeklyCompletion("2026-07", 1, 1)
        );
        WeeklyExpenseWeeklyStatusEntity status = new WeeklyExpenseWeeklyStatusEntity(
            "tenant-a", "project-a", "2026-07", 1
        );
        status.restorePersistenceState(
            "status-1",
            "closed",
            "pm-1",
            Instant.parse(String.valueOf(closed.get("pmSubmittedAt"))),
            "finance-1",
            Instant.parse(String.valueOf(closed.get("adminClosedAt"))),
            NOW
        );

        assertThatCode(() -> fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowMonthClosePermission(ACTOR, "project-a");
            fixture.persistence.saveWeeklyStatus(status);
            return null;
        })).doesNotThrowAnyException();
        assertThat(fixture.documents.get(weekPath())).isEqualTo(closed);
    }

    @Test
    void tenantAdminCanCompleteAWeeklySettlementWithoutProjectAssignment() {
        Fixture fixture = fixture(
            member(Map.of("role", "tenant_admin", "projectIds", List.of())),
            Map.of()
        );
        putCompleteProjectionWindow(fixture, "2026-07", 3);

        CashflowWeeklyUpdateCompletionResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).completeCashflowWeeklyUpdate(
            ACTOR,
            "project-a",
            new CompleteCashflowWeeklyUpdateRequest(
                "tenant-admin-weekly-complete", "2026-07", 3, "2026-07-16T09:00:00Z"
            )
        ));

        assertThat(response.status()).isEqualTo("SUBMITTED");
        assertThat(response.completedBy()).isEqualTo("pm@example.com");
    }

    @Test
    void legacyWeeklyCompletionIsUpgradedInsteadOfBeingTreatedAsALock() {
        Fixture fixture = fixture(activeMember(), Map.of());
        putCompleteProjectionWindow(fixture, "2026-07", 3);
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3",
            new LinkedHashMap<>(Map.of(
                "projectId", "project-a",
                "yearMonth", "2026-07",
                "weekNo", 3,
                "completedAt", "2026-07-10T09:00:00Z",
                "completedByUid", "legacy-user"
            ))
        );

        CashflowWeeklyUpdateCompletionResponse upgraded = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).completeCashflowWeeklyUpdate(
            ACTOR,
            "project-a",
            new CompleteCashflowWeeklyUpdateRequest(
                "upgrade-legacy-week", "2026-07", 3, "2026-07-16T09:00:00Z"
            )
        ));

        assertThat(upgraded.alreadyCompleted()).isFalse();
        assertThat(upgraded.status()).isEqualTo("SUBMITTED");
        assertThat(upgraded.revision()).isEqualTo(1L);
        assertThat(fixture.documents).containsKey(
            "orgs/tenant-a/cashflow_weekly_update_completion_versions/project-a-2026-07-w3-r1"
        );
    }

    @Test
    void weeklyLockIdempotencyCreatesOneVersionAndOneAuditEvent() {
        Fixture fixture = fixture(activeMember(), Map.of());
        putCompleteProjectionWindow(fixture, "2026-07", 3);
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        CompleteCashflowWeeklyUpdateRequest request = new CompleteCashflowWeeklyUpdateRequest(
            "same-weekly-lock", "2026-07", 3, "2026-07-16T09:00:00Z"
        );

        CashflowWeeklyUpdateCompletionResponse first = fixture.persistence.runCommandTransaction(() ->
            service.completeCashflowWeeklyUpdate(ACTOR, "project-a", request)
        );
        Map<String, Object> settlement = fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-07"
        );
        Map<String, Object> periods = new LinkedHashMap<>((Map<String, Object>) settlement.get("periods"));
        Map<String, Object> approved = new LinkedHashMap<>((Map<String, Object>) periods.get("WEEK_3"));
        approved.put("status", "COMPLETED");
        approved.put("revision", 2L);
        periods.put("WEEK_3", approved);
        settlement.put("periods", periods);
        CashflowWeeklyUpdateCompletionResponse replay = fixture.persistence.runCommandTransaction(() ->
            service.completeCashflowWeeklyUpdate(ACTOR, "project-a", request)
        );

        assertThat(replay).isEqualTo(first);
        assertThat(((Map<?, ?>) ((Map<?, ?>) settlement.get("periods")).get("WEEK_3")).get("status"))
            .isEqualTo("COMPLETED");
        assertThat(fixture.documents.keySet().stream()
            .filter(path -> path.contains("/cashflow_weekly_update_completion_versions/")))
            .hasSize(1);
        assertThat(fixture.documents.keySet().stream()
            .filter(path -> path.contains("/weekly_api_audit_events/")))
            .hasSize(1);
    }

    @Test
    void weeklyCompletionValidatesCanonicalSixteenWeekWindowAndAllowsAuditedOverride() {
        Fixture fixture = fixture(activeMember(), Map.of());
        fixture.documents.put("orgs/tenant-a/cashflow_sheet_mirrors/project-a", Map.of(
            "projectId", "project-a", "weeklyYear", 2026
        ));
        putCompleteProjectionWindow(fixture, "2026-09", 4);
        String missingPath = "orgs/tenant-a/cashflow_weeks/project-a-2026-10-w2";
        Map<String, Object> missingWeek = new LinkedHashMap<>(fixture.documents.get(missingPath));
        Map<String, Object> projection = new LinkedHashMap<>((Map<String, Object>) missingWeek.get("projection"));
        projection.remove("SALES_IN");
        missingWeek.put("projection", projection);
        fixture.documents.put(missingPath, missingWeek);
        CompleteCashflowWeeklyUpdateRequest initial = new CompleteCashflowWeeklyUpdateRequest(
            "window-in-weekly-year", "2026-09", 4, "2026-09-24T14:59:00Z", "NO_CHANGES"
        );

        Throwable failure = catchThrowable(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).completeCashflowWeeklyUpdate(ACTOR, "project-a", initial)));
        assertThat(failure).isInstanceOf(WeeklyExpenseEditLeaseException.class);
        WeeklyExpenseEditLeaseException incomplete = (WeeklyExpenseEditLeaseException) failure;
        assertThat(incomplete.code()).isEqualTo("cashflow_projection_window_incomplete");
        assertThat(incomplete.details())
            .containsEntry("tenantId", "tenant-a")
            .containsEntry("projectId", "project-a")
            .containsEntry("yearMonth", "2026-09")
            .containsEntry("weekNo", 4)
            .containsEntry("windowStart", "2026-09-w4")
            .containsEntry("windowEnd", "2026-12-w4")
            .containsEntry("requiredWeekCount", 16)
            .containsEntry("requiredCellCount", 256);
        assertThat((List<Map<String, Object>>) incomplete.details().get("missingCells"))
            .containsExactly(Map.of("yearMonth", "2026-10", "weekNo", 2, "lineId", "SALES_IN"));
        assertThat(fixture.documents.keySet()).noneMatch(path -> path.contains("/cashflow_weekly_update_completions/")
            || path.contains("/cashflow_weekly_update_completion_versions/")
            || path.contains("/weekly_api_audit_events/"));
        verify(fixture.transaction, never()).set(any(DocumentReference.class), any(), any());

        String evidenceHash = String.valueOf(incomplete.details().get("evidenceHash"));
        Throwable staleOverride = catchThrowable(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).completeCashflowWeeklyUpdate(ACTOR, "project-a", new CompleteCashflowWeeklyUpdateRequest(
            "window-in-weekly-year-stale", "2026-09", 4, "2026-09-24T14:59:00Z", "NO_CHANGES",
            true, "sha256:" + "f".repeat(64), 1
        ))));
        assertThat(staleOverride).isInstanceOf(WeeklyExpenseEditLeaseException.class);
        assertThat(((WeeklyExpenseEditLeaseException) staleOverride).code())
            .isEqualTo("cashflow_projection_window_changed");
        assertThat(fixture.documents.keySet()).noneMatch(path -> path.contains("/cashflow_weekly_update_completions/")
            || path.contains("/cashflow_weekly_update_completion_versions/")
            || path.contains("/weekly_api_audit_events/"));

        projection.put("SALES_IN", 0L);
        missingWeek.put("projection", projection);
        fixture.documents.put(missingPath, missingWeek);
        Throwable resolvedOverride = catchThrowable(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).completeCashflowWeeklyUpdate(ACTOR, "project-a", new CompleteCashflowWeeklyUpdateRequest(
            "window-in-weekly-year-resolved", "2026-09", 4, "2026-09-24T14:59:00Z", "NO_CHANGES",
            true, evidenceHash, 1
        ))));
        assertThat(resolvedOverride).isInstanceOf(WeeklyExpenseEditLeaseException.class);
        assertThat(((WeeklyExpenseEditLeaseException) resolvedOverride).code())
            .isEqualTo("cashflow_projection_window_changed");

        projection.remove("SALES_IN");
        missingWeek.put("projection", projection);
        fixture.documents.put(missingPath, missingWeek);

        CompleteCashflowWeeklyUpdateRequest override = new CompleteCashflowWeeklyUpdateRequest(
            "window-in-weekly-year-override", "2026-09", 4, "2026-09-24T14:59:00Z", "NO_CHANGES",
            true, evidenceHash, 1
        );
        CashflowWeeklyUpdateCompletionResponse completed = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).completeCashflowWeeklyUpdate(ACTOR, "project-a", override));
        assertThat(completed.status()).isEqualTo("SUBMITTED");
        assertThat(completed.updateResult()).isEqualTo("NO_CHANGES");
        assertThat(completed.complianceStatus()).isEqualTo("ON_TIME");
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-09-w4"
        ))
            .containsEntry("projectionValidationOverride", true)
            .containsEntry("projectionValidationIssueCount", 1)
            .containsEntry("projectionValidationEvidenceHash", evidenceHash);
        assertThat(fixture.documents.entrySet().stream()
            .filter(entry -> entry.getKey().contains("/weekly_api_audit_events/"))
            .map(entry -> String.valueOf(entry.getValue().get("metadataJson"))))
            .singleElement()
            .satisfies(metadata -> assertThat(metadata)
                .contains("\"projectionValidationOverride\":true")
                .contains("\"projectionValidationIssueCount\":1")
                .contains(evidenceHash));
        Map<?, ?> periods = (Map<?, ?>) fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-09"
        ).get("periods");
        assertThat(((Map<?, ?>) periods.get("WEEK_4")).get("status")).isEqualTo("PENDING_APPROVAL");

        CashflowWeeklyUpdateCompletionResponse replay = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).completeCashflowWeeklyUpdate(ACTOR, "project-a", override));
        assertThat(replay).isEqualTo(completed);
        assertThat(fixture.documents.keySet().stream()
            .filter(path -> path.contains("/cashflow_weekly_update_completion_versions/")))
            .hasSize(1);
        assertThat(fixture.documents.keySet().stream()
            .filter(path -> path.contains("/weekly_api_audit_events/")))
            .hasSize(1);
    }

    @Test
    void weeklyComplianceHistoryUsesImmutableVersionsForLateStatusPaginationAndCounts() {
        Fixture fixture = fixture(activeMember(), Map.of());
        putCompleteProjectionWindow(fixture, "2026-07", 3);
        putCompleteProjectionWindow(fixture, "2026-07", 4);
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        fixture.persistence.runCommandTransaction(() -> service.completeCashflowWeeklyUpdate(
            ACTOR, "project-a", new CompleteCashflowWeeklyUpdateRequest(
                "history-on-time", "2026-07", 3, "2026-07-16T14:59:00Z", "CHANGED"
            )
        ));
        fixture.persistence.runCommandTransaction(() -> service.completeCashflowWeeklyUpdate(
            ACTOR, "project-a", new CompleteCashflowWeeklyUpdateRequest(
                "history-late", "2026-07", 4, "2026-07-24T00:01:00Z", "NO_CHANGES"
            )
        ));

        CashflowWeeklyComplianceHistoryResponse first = service.readCashflowWeeklyComplianceHistory(
            READ_ACTOR, "project-a", 1, ""
        );
        CashflowWeeklyComplianceHistoryResponse second = service.readCashflowWeeklyComplianceHistory(
            READ_ACTOR, "project-a", 1, first.nextCursor()
        );
        assertThat(first.items()).hasSize(1);
        assertThat(second.items()).hasSize(1);
        assertThat(first.onTimeCount()).isEqualTo(1);
        assertThat(first.missedCount()).isEqualTo(1);
        assertThat(java.util.stream.Stream.concat(first.items().stream(), second.items().stream()).map(
            CashflowWeeklyComplianceHistoryResponse.Item::status
        )).containsExactlyInAnyOrder("ON_TIME", "COMPLETED_LATE");
        assertThat(java.util.stream.Stream.concat(first.items().stream(), second.items().stream()).map(
            CashflowWeeklyComplianceHistoryResponse.Item::updateResult
        )).containsExactlyInAnyOrder("CHANGED", "NO_CHANGES");
    }

    @Test
    void weeklyComplianceTimelineIncludesUncompletedPastMissedAndCurrentPending() {
        Fixture fixture = fixture(
            activeMember(), Map.of(), true, null, Instant.parse("2026-07-08T10:00:00Z")
        );
        fixture.documents.put("orgs/tenant-a/cashflow_weekly_compliance_heads/project-a", Map.of(
            "tenantId", "tenant-a", "projectId", "project-a", "trackingYearMonth", "2026-07",
            "trackingWeekNo", 1, "trackingStartedAt", "2026-07-01T00:00:00Z"
        ));

        CashflowWeeklyComplianceHistoryResponse history = commandService(fixture.persistence)
            .readCashflowWeeklyComplianceHistory(READ_ACTOR, "project-a", 10, "");

        assertThat(history.items()).extracting(
            CashflowWeeklyComplianceHistoryResponse.Item::weekNo,
            CashflowWeeklyComplianceHistoryResponse.Item::status
        ).containsExactly(org.assertj.core.groups.Tuple.tuple(2, "PENDING"), org.assertj.core.groups.Tuple.tuple(1, "MISSED"));
        assertThat(history.onTimeCount()).isZero();
        assertThat(history.missedCount()).isEqualTo(1);
    }

    @Test
    void weeklyComplianceReadsLegacyTrackingResetAndNewProjectFallsBackToCurrentPending() {
        Instant beforeDeadline = Instant.parse("2026-07-08T10:00:00Z");
        Fixture legacy = fixture(activeMember(), Map.of(), true, null, beforeDeadline);
        legacy.documents.put("orgs/tenant-a/cashflow_weekly_update_reset_controls/project-a", Map.of(
            "trackingStartedAt", "2026-07-01T00:00:00Z"
        ));

        CashflowWeeklyComplianceHistoryResponse migrated = commandService(legacy.persistence)
            .readCashflowWeeklyComplianceHistory(READ_ACTOR, "project-a", 10, "");
        assertThat(migrated.items()).extracting(
            CashflowWeeklyComplianceHistoryResponse.Item::weekNo,
            CashflowWeeklyComplianceHistoryResponse.Item::status
        ).containsExactly(org.assertj.core.groups.Tuple.tuple(2, "PENDING"), org.assertj.core.groups.Tuple.tuple(1, "MISSED"));

        Fixture fresh = fixture(activeMember(), Map.of(), true, null, beforeDeadline);
        CashflowWeeklyComplianceHistoryResponse current = commandService(fresh.persistence)
            .readCashflowWeeklyComplianceHistory(READ_ACTOR, "project-a", 10, "");
        assertThat(current.items()).singleElement().satisfies(item -> {
            assertThat(item.yearMonth()).isEqualTo("2026-07");
            assertThat(item.weekNo()).isEqualTo(2);
            assertThat(item.status()).isEqualTo("PENDING");
        });
    }

    @Test
    void weeklyCompletionFirestoreTransactionRollsBackCompletionVersionAuditAndIdempotencyTogether() {
        Fixture fixture = fixture(activeMember(), Map.of());
        putCompleteProjectionWindow(fixture, "2026-07", 3);

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> {
            commandService(fixture.persistence).completeCashflowWeeklyUpdate(
                ACTOR, "project-a", new CompleteCashflowWeeklyUpdateRequest(
                    "weekly-atomic-failure", "2026-07", 3, "2026-07-16T14:59:00Z", "CHANGED"
                )
            );
            throw new IllegalStateException("fail after all weekly completion writes");
        })).isInstanceOf(IllegalStateException.class);

        assertThat(fixture.documents.keySet()).noneMatch(path ->
            path.contains("/cashflow_weekly_update_completions/")
                || path.contains("/cashflow_weekly_update_completion_versions/")
                || path.contains("/weekly_api_audit_events/")
                || path.contains("/weekly_api_idempotency/")
        );
    }

    private static Map<String, Object> submittedWeeklyCompletion(String yearMonth, int weekNo, long revision) {
        Map<String, Object> value = lockedWeeklyCompletion(yearMonth, weekNo, revision);
        value.put("status", "SUBMITTED");
        return value;
    }

    @Test
    void weeklyReopenNeedsNoReasonAndReopensALockedWeek() {
        // 완료 요청(SUBMITTED) 상태의 회수는 결재 없는 가벼운 되돌림이라 사유 없이도 된다. 있으면 기록만 한다.
        Fixture fixture = fixture(activeMember(), Map.of());
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3",
            submittedWeeklyCompletion("2026-07", 3, 1)
        );
        var response = fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .reopenCashflowWeeklyUpdate(
                ACTOR,
                "project-a",
                new ReopenCashflowWeeklyUpdateRequest("reopen-no-reason", "2026-07", 3, 1, null)
            ));
        assertThat(response.status()).isEqualTo("OPEN");
        assertThat(response.revision()).isEqualTo(2L);
        Map<String, Object> stored = fixture.documents.get(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3"
        );
        assertThat(stored.get("status")).isEqualTo("OPEN");
        assertThat(stored.get("reopenReason")).isEqualTo("");
        // 회수도 불변 버전을 남긴다. 준수 이력은 최고 revision 을 읽으므로 이게 없으면 회수 뒤에도 "완료" 로 남는다.
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_weekly_update_completion_versions/project-a-2026-07-w3-r2"
        ))
            .containsEntry("complianceStatus", "REOPENED")
            .containsEntry("revision", 2L)
            .containsEntry("completedAt", "");
    }

    @Test
    void weeklyConfirmMovesASubmittedWeekToLockedForTheProjectApproverOnly() {
        // 확정은 프로젝트 조직장만. SUBMITTED → LOCKED, revision +1, 준수 판정은 요청 시각 그대로.
        Fixture fixture = fixture(activeMember(), Map.of());
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "manager-1"
        ));
        Map<String, Object> submitted = submittedWeeklyCompletion("2026-07", 3, 1);
        submitted.put("complianceStatus", "ON_TIME");
        submitted.put("deadline", "2026-07-16T14:59:59Z");
        fixture.documents.put("orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3", submitted);
        fixture.documents.put("orgs/tenant-a/members/manager-1", member(Map.of("uid", "manager-1", "role", "pm", "projectIds", List.of("project-a"))));
        fixture.documents.put("orgs/tenant-a/persons/person-manager-1", Map.of("uid", "manager-1"));
        TrustedActorContext manager = new TrustedActorContext("tenant-a", "manager-1", "manager@example.com", "pm", "Manager");

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .confirmCashflowWeeklyUpdate(ACTOR, "project-a",
                new ConfirmCashflowWeeklyUpdateRequest("confirm-by-pm", "2026-07", 3, 1))))
            .isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error ->
                assertThat(error.code()).isEqualTo("cashflow_weekly_confirm_forbidden"));

        var response = fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .confirmCashflowWeeklyUpdate(manager, "project-a",
                new ConfirmCashflowWeeklyUpdateRequest("confirm-by-manager", "2026-07", 3, 1)));
        assertThat(response.status()).isEqualTo("LOCKED");
        assertThat(response.revision()).isEqualTo(2L);
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_weekly_update_completion_versions/project-a-2026-07-w3-r2"
        ))
            .containsEntry("lockState", "LOCKED")
            .containsEntry("complianceStatus", "ON_TIME");

        // 확정된 주는 사유 없이 못 되돌리고, 사유가 있어도 조직장/관리자만 되돌린다.
        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .reopenCashflowWeeklyUpdate(manager, "project-a",
                new ReopenCashflowWeeklyUpdateRequest("reopen-locked-no-reason", "2026-07", 3, 2, null))))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("reason");
        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .reopenCashflowWeeklyUpdate(ACTOR, "project-a",
                new ReopenCashflowWeeklyUpdateRequest("reopen-locked-by-pm", "2026-07", 3, 2, "정정"))))
            .isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error ->
                assertThat(error.code()).isEqualTo("cashflow_weekly_reopen_forbidden"));
        var reopened = fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .reopenCashflowWeeklyUpdate(manager, "project-a",
                new ReopenCashflowWeeklyUpdateRequest("reopen-locked-by-manager", "2026-07", 3, 2, "정정")));
        assertThat(reopened.status()).isEqualTo("OPEN");
        assertThat(reopened.revision()).isEqualTo(3L);
    }

    @Test
    void weeklyComplianceHistoryTreatsAReopenedWeekAsNotCompleted() {
        // 완료 요청(r1 ON_TIME, SUBMITTED) 뒤 회수(r2 REOPENED): 이력은 그 주를 완료 아님(PENDING/MISSED) 으로 되돌리고 완료 수에서 뺀다.
        // 그래야 대시보드의 현재 주가 "완료 대기" 로 바뀌고 회수 버튼이 다시 뜨지 않는다.
        Fixture fixture = fixture(activeMember(), Map.of());
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w2",
            submittedWeeklyCompletion("2026-07", 2, 1)
        );
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completion_versions/project-a-2026-07-w2-r1",
            new LinkedHashMap<>(Map.ofEntries(
                Map.entry("id", "project-a-2026-07-w2-r1"),
                Map.entry("tenantId", "tenant-a"),
                Map.entry("projectId", "project-a"),
                Map.entry("yearMonth", "2026-07"),
                Map.entry("weekNo", 2),
                Map.entry("revision", 1L),
                Map.entry("complianceStatus", "ON_TIME"),
                Map.entry("deadline", "2026-07-09T14:59:59Z"),
                Map.entry("completedAt", "2026-07-08T09:00:00Z"),
                Map.entry("completedBy", "pm-1")
            ))
        );
        WeeklyExpensePersistence.CashflowWeeklyCompliancePage before = fixture.persistence
            .findCashflowWeeklyComplianceHistory("tenant-a", "project-a", 50, "");
        assertThat(before.items()).anySatisfy(item -> {
            assertThat(item.id()).isEqualTo("2026-07-w2");
            assertThat(item.status()).isEqualTo("ON_TIME");
            // lockState 없는 옛 버전은 확정으로 본다 (회수 판정은 status 가 한다)
            assertThat(item.lockState()).isEqualTo("LOCKED");
        });
        assertThat(before.onTimeCount()).isEqualTo(1L);

        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .reopenCashflowWeeklyUpdate(
                ACTOR,
                "project-a",
                new ReopenCashflowWeeklyUpdateRequest("reopen-w2", "2026-07", 2, 1, null)
            ));

        WeeklyExpensePersistence.CashflowWeeklyCompliancePage after = fixture.persistence
            .findCashflowWeeklyComplianceHistory("tenant-a", "project-a", 50, "");
        assertThat(after.items()).anySatisfy(item -> {
            assertThat(item.id()).isEqualTo("2026-07-w2");
            assertThat(item.status()).isIn("PENDING", "MISSED");
            assertThat(item.completedAt()).isEmpty();
        });
        assertThat(after.onTimeCount()).isEqualTo(0L);
    }

    @Test
    void weeklyComplianceHistoryTrustsAnOpenCompletionDocumentOverOldVersions() {
        // REOPENED 버전 도입 이전에 회수된 주(완료 문서 OPEN, 버전은 r1 ON_TIME 뿐)도 완료 아님으로 보여야 한다.
        Fixture fixture = fixture(activeMember(), Map.of());
        Map<String, Object> reopened = lockedWeeklyCompletion("2026-07", 2, 2);
        reopened.put("status", "OPEN");
        reopened.put("reopenCount", 1L);
        fixture.documents.put("orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w2", reopened);
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completion_versions/project-a-2026-07-w2-r1",
            new LinkedHashMap<>(Map.ofEntries(
                Map.entry("id", "project-a-2026-07-w2-r1"),
                Map.entry("tenantId", "tenant-a"),
                Map.entry("projectId", "project-a"),
                Map.entry("yearMonth", "2026-07"),
                Map.entry("weekNo", 2),
                Map.entry("revision", 1L),
                Map.entry("complianceStatus", "ON_TIME"),
                Map.entry("deadline", "2026-07-09T14:59:59Z"),
                Map.entry("completedAt", "2026-07-08T09:00:00Z"),
                Map.entry("completedBy", "pm-1")
            ))
        );
        WeeklyExpensePersistence.CashflowWeeklyCompliancePage page = fixture.persistence
            .findCashflowWeeklyComplianceHistory("tenant-a", "project-a", 50, "");
        assertThat(page.items()).anySatisfy(item -> {
            assertThat(item.id()).isEqualTo("2026-07-w2");
            assertThat(item.status()).isIn("PENDING", "MISSED");
            assertThat(item.completedAt()).isEmpty();
        });
        assertThat(page.onTimeCount()).isEqualTo(0L);
    }

    @Test
    void weeklyReopenRejectsRevisionDriftAndClosedMonth() {
        Fixture revisionFixture = fixture(activeMember(), Map.of());
        revisionFixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3",
            lockedWeeklyCompletion("2026-07", 3, 2)
        );
        assertThatThrownBy(() -> revisionFixture.persistence.runCommandTransaction(() -> commandService(
            revisionFixture.persistence
        ).reopenCashflowWeeklyUpdate(
            ACTOR,
            "project-a",
            new ReopenCashflowWeeklyUpdateRequest(
                "reopen-stale", "2026-07", 3, 1, "긴급 정정"
            )
        )))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("revision");

        Fixture closedFixture = fixture(activeMember(), Map.of());
        closedFixture.documents.put(
            "orgs/tenant-a/cashflow_cumulative_close_heads/project-a",
            closedThrough("2026-07")
        );
        closedFixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w3",
            lockedWeeklyCompletion("2026-07", 3, 1)
        );
        closedFixture.documents.put(monthClosePath("project-a", "2026-07"), Map.of(
            "contractVersion", "cashflow-month-close-v1",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-07",
            "status", "CLOSED",
            "revision", 1L,
            "reopenCount", 0L
        ));
        assertThatThrownBy(() -> closedFixture.persistence.runCommandTransaction(() -> commandService(
            closedFixture.persistence
        ).reopenCashflowWeeklyUpdate(
            ACTOR,
            "project-a",
            new ReopenCashflowWeeklyUpdateRequest(
                "reopen-closed-month", "2026-07", 3, 1, "긴급 정정"
            )
        )))
            .isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error ->
                assertThat(error.code()).isEqualTo("cashflow_month_closed"));
    }

    @Test
    void monthCloseUsesRequestTimeEvidenceWhenTheLiveMirrorChangesAfterDesignatedApproval() {
        CloseCashflowMonthRequest pinned = monthCloseRequest("month-close-pinned-values", 0, 3);
        List<CashflowSheetLabApplyRequest.Cell> changedCells = new ArrayList<>(pinned.cells());
        CashflowSheetLabApplyRequest.Cell first = changedCells.getFirst();
        changedCells.set(0, new CashflowSheetLabApplyRequest.Cell(
            first.mode(),
            first.weekNo(),
            first.cashflowLine(),
            first.cellState(),
            first.amount().add(BigDecimal.ONE),
            first.sourceCell(),
            first.sourceLabel()
        ));
        CloseCashflowMonthRequest changed = new CloseCashflowMonthRequest(
            pinned.idempotencyKey(),
            pinned.sourceRevision(),
            pinned.targetRevision(),
            pinned.yearMonth(),
            pinned.expectedRevision(),
            pinned.expectedDraftRevision(),
            pinned.humanReviewed(),
            pinned.depositScheduleRows(),
            changedCells,
            pinned.confirmations(),
            pinned.managementChecks(),
            pinned.managementConfirmations(),
            pinned.openingBalances(),
            pinned.deadlineSummary()
        );
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(draftPath("project-a", "pm-1"), activeDraft("project-a", 3, changed));
        fixture.documents.put("orgs/tenant-a/cashflow_sheet_mirrors/project-a", pinnedMirror(pinned));

        CashflowMonthCloseResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, changed));

        assertThat(response.status()).isEqualTo("CLOSED");
        Map<String, Object> snapshot = monthCloseVersionSnapshot(fixture, pinned.yearMonth());
        assertThat(monthCloseWarningCodes(fixture, pinned.yearMonth())).isEmpty();
        assertThat((Map<String, Object>) snapshot.get("sourceEvidence"))
            .containsEntry("sourceRevision", SOURCE_REVISION)
            .containsEntry("targetRevision", pinned.targetRevision())
            .containsEntry("capturedAt", NOW.minusSeconds(120).toString());
        assertThat(snapshot.get("sourceReadAt")).isEqualTo(NOW.minusSeconds(120).toString());
        assertThat((Map<String, Object>) snapshot.get("sheetFacts")).isEmpty();
    }

    @Test
    void monthCloseRetainsApprovedRequestEvidenceWhenTheRequestTimeMirrorWasMissing() {
        CloseCashflowMonthRequest request = monthCloseRequest("month-close-missing-mirror", 0, 3);
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(draftPath("project-a", "pm-1"), activeDraft("project-a", 3, request));
        String approvalPath = "orgs/tenant-a/cashflow_month_close_requests/project-a-2026-06";
        Map<String, Object> approval = new LinkedHashMap<>(fixture.documents.get(approvalPath));
        approval.put("reviewWarnings", List.of(Map.of(
            "code", "SOURCE_MIRROR_MISSING",
            "message", "요청 시점에 mirror가 없었습니다."
        )));
        Map<String, Object> sourceEvidence = new LinkedHashMap<>();
        sourceEvidence.put("sourceRevision", SOURCE_REVISION);
        sourceEvidence.put("targetRevision", request.targetRevision());
        sourceEvidence.put("capturedAt", NOW.minusSeconds(180).toString());
        sourceEvidence.put("spreadsheetId", null);
        approval.put("monthSnapshot", Map.of(
            "schemaVersion", 1,
            "projectId", "project-a",
            "yearMonth", "2026-06",
            "source", sourceEvidence
        ));
        fixture.documents.put(approvalPath, approval);

        CashflowMonthCloseResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, request));

        assertThat(response.status()).isEqualTo("CLOSED");
        Map<String, Object> snapshot = monthCloseVersionSnapshot(fixture, request.yearMonth());
        assertThat(monthCloseWarningCodes(fixture, request.yearMonth()))
            .containsExactly("SOURCE_MIRROR_MISSING");
        assertThat((Map<String, Object>) snapshot.get("sourceEvidence"))
            .containsEntry("sourceRevision", SOURCE_REVISION)
            .containsEntry("targetRevision", request.targetRevision())
            .containsEntry("capturedAt", NOW.minusSeconds(180).toString())
            .containsEntry("spreadsheetId", null);
        assertThat(snapshot.get("sourceReadAt")).isEqualTo(NOW.minusSeconds(180).toString());
        assertThat((Map<String, Object>) snapshot.get("sheetFacts")).isEmpty();
        assertThat((Map<String, Object>) snapshot.get("approvedMonthSnapshot"))
            .containsEntry("projectId", "project-a")
            .containsEntry("yearMonth", "2026-06");
    }

    @Test
    void monthCloseRejectsChangedOpeningRowsEvenWhenTheNetTotalIsUnchanged() {
        Fixture fixture = fixture(activeMember(), activeLease());
        CashflowSheetAnnualApplyCommand annual = new CashflowSheetAnnualApplyCommand(
            "annual-opening-rows",
            SOURCE_REVISION,
            2025,
            0,
            annualCellsWithProjection("SALES_IN", new BigDecimal("2000000"))
        );
        fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            fixture.persistence.replaceCashflowSheetYearTotal(
                "tenant-a",
                "project-a",
                "cashflow-sheet-lab",
                annual
            );
            return null;
        });

        CloseCashflowMonthRequest base = monthCloseRequest("month-close-opening-row-drift", 0, 3);
        CashflowOpeningBalancesResponse staleOpening = openingBalanceForProjection(
            2026,
            2025,
            "TEAM_SUPPORT_IN",
            new BigDecimal("2000000")
        );
        CloseCashflowMonthRequest request = new CloseCashflowMonthRequest(
            base.idempotencyKey(),
            base.sourceRevision(),
            base.targetRevision(),
            base.yearMonth(),
            base.expectedRevision(),
            base.expectedDraftRevision(),
            base.humanReviewed(),
            base.depositScheduleRows(),
            base.cells(),
            base.confirmations(),
            base.managementChecks(),
            base.managementConfirmations(),
            staleOpening,
            base.deadlineSummary()
        );
        fixture.documents.put("orgs/tenant-a/cashflow_sheet_mirrors/project-a", pinnedMirror(request));

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, request)))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("opening balance changed");

        assertThat(fixture.documents).doesNotContainKey(monthClosePath("project-a", request.yearMonth()));
    }

    @Test
    void monthCloseAllowsPinnedSheetControlMismatchAfterDesignatedApproval() {
        CloseCashflowMonthRequest request = monthCloseRequest("month-close-control-mismatch", 0, 3);
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(draftPath("project-a", "pm-1"), activeDraft("project-a", 3, request));
        Map<String, Object> mirror = pinnedMirror(request);
        Map<String, Object> facts = new LinkedHashMap<>((Map<String, Object>) mirror.get("sheetFacts"));
        Map<String, Object> controls = new LinkedHashMap<>((Map<String, Object>) facts.get("controlTotals"));
        controls.put("deposit", Map.of("sourceCell", "BO9", "value", 1_000_000L, "computed", 999_999L, "matches", false));
        facts.put("controlTotals", controls);
        mirror.put("sheetFacts", facts);
        fixture.documents.put("orgs/tenant-a/cashflow_sheet_mirrors/project-a", mirror);
        CashflowMonthCloseResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, request));

        assertThat(response.status()).isEqualTo("CLOSED");
        assertThat(fixture.documents).containsKey(monthClosePath("project-a", "2026-06"));
    }

    @Test
    void monthClosePersistsApprovedWarningsWithoutManagementConfirmations() {
        CloseCashflowMonthRequest base = monthCloseRequest("month-close-approved-warnings", 0, 3);
        List<CloseCashflowMonthRequest.ManagementCheck> managementChecks = List.of(
            new CloseCashflowMonthRequest.ManagementCheck(
                "labor-transfer", "WARNING", "MYSC 인건비 이관", "승인자가 확인한 경고", List.of("미이관 1건")
            ),
            new CloseCashflowMonthRequest.ManagementCheck("profit-vat-after-deposit", "OK", "수익·부가세 이관", "확인"),
            new CloseCashflowMonthRequest.ManagementCheck("negative-projection-balance", "OK", "Projection 잔액", "확인"),
            new CloseCashflowMonthRequest.ManagementCheck("future-prepay-over-million", "OK", "선입금 요청", "확인")
        );
        CloseCashflowMonthRequest request = new CloseCashflowMonthRequest(
            base.idempotencyKey(),
            base.sourceRevision(),
            base.targetRevision(),
            base.yearMonth(),
            base.expectedRevision(),
            base.expectedDraftRevision(),
            base.humanReviewed(),
            base.depositScheduleRows(),
            base.cells(),
            base.confirmations(),
            managementChecks,
            List.of(),
            base.openingBalances(),
            base.deadlineSummary()
        );
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(draftPath("project-a", "pm-1"), activeDraft("project-a", 3, request));
        Map<String, Object> mirror = pinnedMirror(request);
        Map<String, Object> facts = new LinkedHashMap<>((Map<String, Object>) mirror.get("sheetFacts"));
        Map<String, Object> controls = new LinkedHashMap<>((Map<String, Object>) facts.get("controlTotals"));
        controls.put("deposit", Map.of("sourceCell", "BO9", "value", 1_000_000L, "computed", 999_999L, "matches", false));
        facts.put("controlTotals", controls);
        mirror.put("sheetFacts", facts);
        fixture.documents.put("orgs/tenant-a/cashflow_sheet_mirrors/project-a", mirror);
        String approvalPath = "orgs/tenant-a/cashflow_month_close_requests/project-a-2026-06";
        Map<String, Object> approval = new LinkedHashMap<>(fixture.documents.get(approvalPath));
        approval.put("reviewWarnings", List.of(Map.of(
            "code", "DEPOSIT_CONTROL_MISMATCH",
            "message", "요청 시점 입금 통제값 불일치"
        )));
        fixture.documents.put(approvalPath, approval);

        CashflowMonthCloseResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, request));

        assertThat(response.status()).isEqualTo("CLOSED");
        Map<String, Object> snapshot = (Map<String, Object>) fixture.documents
            .get(monthCloseVersionPath("project-a", "2026-06", 1))
            .get("snapshot");
        assertThat((List<?>) snapshot.get("managementConfirmations")).isEmpty();
        assertThat((List<Map<String, Object>>) snapshot.get("managementChecks"))
            .anySatisfy(check -> assertThat(check)
                .containsEntry("id", "labor-transfer")
                .containsEntry("status", "WARNING"));
        assertThat(monthCloseWarningCodes(fixture, request.yearMonth()))
            .containsExactly("DEPOSIT_CONTROL_MISMATCH");
        assertThat((Map<String, Object>) snapshot.get("sheetFacts")).isEmpty();
    }

    @Test
    void monthCloseRequiresTheDesignatedApproverRequestInsideTheJVM() {
        CloseCashflowMonthRequest request = monthCloseRequest("month-close-without-approval", 0, 3);
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.remove("orgs/tenant-a/cashflow_month_close_requests/project-a-2026-06");
        fixture.documents.put("orgs/tenant-a/cashflow_sheet_mirrors/project-a", pinnedMirror(request));

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, request)))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("designated approver");

        assertThat(fixture.documents).doesNotContainKey(monthClosePath("project-a", "2026-06"));
    }

    @Test
    void serverClockAllowsNextMonthCloseAndSetsStoredTimestamps() {
        CloseCashflowMonthRequest request = monthCloseRequest("month-close-server-date", 0, 3, "2026-07");
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-08-01"));
        fixture.documents.put(draftPath("project-a", "pm-1"), activeDraft("project-a", 3, request));
        fixture.documents.put("orgs/tenant-a/cashflow_sheet_mirrors/project-a", pinnedMirror(request));

        CashflowMonthCloseResponse open = commandService(fixture.persistence).readCashflowMonthClose(
            new TrustedActorContext("tenant-a", "pm-1", "pm@example.com", "pm"), "project-a", "2026-07"
        );
        assertThat(open.closeEligible()).isTrue();
        assertThat(open.evaluatedBusinessDate()).isEqualTo("2026-08-01");
        assertThat(open.closeDeadline()).isEqualTo("2026-08-10");

        CashflowMonthCloseResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, request));

        assertThat(response.status()).isEqualTo("CLOSED");
        assertThat(response.late()).isFalse();
        assertThat(response.closedAt()).isEqualTo("2026-07-31T15:00:00Z");
        assertThat(response.snapshot()).containsEntry("evaluatedBusinessDate", "2026-08-01");
        assertThat(fixture.documents.get(leasePath("project-a")))
            .containsEntry("state", "ACTIVE")
            .doesNotContainKeys("releasedAt", "releaseReason");
    }

    @Test
    void serverBusinessDateKeepsTheTenthOnTimeAndMarksTheEleventhLate() {
        for (Map.Entry<LocalDate, Boolean> boundary : Map.of(
            LocalDate.parse("2026-08-10"), false,
            LocalDate.parse("2026-08-11"), true
        ).entrySet()) {
            CloseCashflowMonthRequest request = monthCloseRequest(
                "month-close-boundary-" + boundary.getKey(),
                0,
                3,
                "2026-07"
            );
            Fixture fixture = fixture(activeMember(), activeLease(), true, boundary.getKey());
            fixture.documents.put(draftPath("project-a", "pm-1"), activeDraft("project-a", 3, request));
            fixture.documents.put("orgs/tenant-a/cashflow_sheet_mirrors/project-a", pinnedMirror(request));

            CashflowMonthCloseResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
                fixture.persistence
            ).closeCashflowMonth(ACTOR, "project-a", SESSION, request));

            assertThat(response.late()).isEqualTo(boundary.getValue());
        }
    }

    @Test
    void serverBusinessDateStillRejectsClosingBeforeTheTargetMonthEnds() {
        CloseCashflowMonthRequest request = monthCloseRequest("month-close-too-early", 0, 3, "2026-07");
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-07-31"));
        fixture.documents.put(draftPath("project-a", "pm-1"), activeDraft("project-a", 3, request));
        fixture.documents.put("orgs/tenant-a/cashflow_sheet_mirrors/project-a", pinnedMirror(request));

        CashflowMonthCloseResponse open = commandService(fixture.persistence).readCashflowMonthClose(
            new TrustedActorContext("tenant-a", "pm-1", "pm@example.com", "pm"), "project-a", "2026-07"
        );
        assertThat(open.closeEligible()).isFalse();
        assertThat(open.evaluatedBusinessDate()).isEqualTo("2026-07-31");

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, request)))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("after the target month ends");
    }

    @Test
    void varianceFlagReplyResolveUsesStoredRolesRevisionFenceAndAppendOnlyHistory() {
        Fixture fixture = fixture(member(Map.of(
            "role", "tenant_admin",
            "projectIds", List.of(),
            "name", "Tenant Admin"
        )), activeLease());
        fixture.documents.put(varianceWeekPath(), varianceWeek());
        WeeklyExpenseCommandService service = commandService(fixture.persistence);

        CashflowVarianceRequest flagRequest = new CashflowVarianceRequest(
            "variance-flag",
            "week-a",
            0L,
            "FLAG",
            "입금 편차 확인"
        );
        CashflowVarianceResponse flagged = fixture.persistence.runCommandTransaction(() -> service.updateCashflowVariance(
            ACTOR, "project-a", SESSION, flagRequest
        ));
        CashflowVarianceResponse replay = fixture.persistence.runCommandTransaction(() -> service.updateCashflowVariance(
            ACTOR, "project-a", SESSION, flagRequest
        ));

        assertThat(replay).isEqualTo(flagged);
        assertThat(flagged.week().id()).isEqualTo("week-a");
        assertThat(flagged.week().projectId()).isEqualTo("project-a");
        assertThat(flagged.week().varianceRevision()).isEqualTo(1);
        assertThat(flagged.week().varianceFlag())
            .containsEntry("status", "OPEN")
            .containsEntry("reason", "입금 편차 확인")
            .containsEntry("flaggedBy", "Tenant Admin")
            .containsEntry("flaggedByUid", "pm-1");
        assertThat(flagged.week().varianceHistory()).singleElement().satisfies(event ->
            assertThat(event)
                .containsEntry("id", "vf-1")
                .containsEntry("action", "FLAG")
                .containsEntry("content", "입금 편차 확인")
        );

        fixture.documents.put("orgs/tenant-a/members/pm-1", member(Map.of(
            "role", "pm",
            "name", "Project Manager"
        )));
        CashflowVarianceResponse replied = fixture.persistence.runCommandTransaction(() -> service.updateCashflowVariance(
            ACTOR,
            "project-a",
            SESSION,
            new CashflowVarianceRequest("variance-reply", "week-a", 1L, "REPLY", "입금일 확인 완료")
        ));
        assertThat(replied.week().varianceRevision()).isEqualTo(2);
        assertThat(replied.week().varianceFlag())
            .containsEntry("status", "REPLIED")
            .containsEntry("pmReply", "입금일 확인 완료")
            .containsEntry("pmRepliedBy", "Project Manager");
        assertThat(replied.week().varianceHistory()).hasSize(2);

        fixture.documents.put("orgs/tenant-a/members/pm-1", member(Map.of(
            "role", "finance",
            "projectIds", List.of(),
            "name", "Finance Admin"
        )));
        CashflowVarianceResponse resolved = fixture.persistence.runCommandTransaction(() -> service.updateCashflowVariance(
            ACTOR,
            "project-a",
            SESSION,
            new CashflowVarianceRequest("variance-resolve", "week-a", 2L, "RESOLVE", "")
        ));

        assertThat(resolved.week().varianceRevision()).isEqualTo(3);
        assertThat(resolved.week().varianceFlag())
            .containsEntry("status", "RESOLVED")
            .containsEntry("resolvedBy", "Finance Admin");
        assertThat(resolved.week().varianceHistory()).hasSize(3);
        assertThat(resolved.week().varianceHistory().get(2))
            .containsEntry("id", "vf-3")
            .containsEntry("action", "RESOLVE")
            .containsEntry("content", "해결 처리");
        assertThat(fixture.documents.get(varianceWeekPath()))
            .containsEntry("varianceRevision", 3L)
            .containsEntry("updatedByUid", "pm-1");
        assertThat(fixture.documents.get(leasePath("project-a")))
            .containsEntry("state", "ACTIVE")
            .doesNotContainKeys("releasedAt", "releaseReason");
        assertThat(fixture.documents.keySet())
            .anyMatch(path -> path.startsWith("orgs/tenant-a/weekly_api_audit_events/"))
            .anyMatch(path -> path.startsWith("orgs/tenant-a/weekly_api_idempotency/"));
    }

    @Test
    void varianceRejectsWrongActionRolesBeforeWriting() {
        for (Map.Entry<String, String> denied : Map.of(
            "pm", "FLAG",
            "admin", "REPLY",
            "finance", "REPLY",
            "tenant_admin", "REPLY"
        ).entrySet()) {
            Fixture fixture = fixture(member(Map.of("role", denied.getKey())), activeLease());
            fixture.documents.put(varianceWeekPath(), varianceWeek());

            assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
                fixture.persistence
            ).updateCashflowVariance(
                ACTOR,
                "project-a",
                SESSION,
                new CashflowVarianceRequest(
                    "variance-role-" + denied.getKey(),
                    "week-a",
                    0L,
                    denied.getValue(),
                    "검토"
                )
            )))
                .isInstanceOf(WeeklyExpenseForbiddenException.class);
            assertThat(fixture.documents.get(varianceWeekPath()))
                .doesNotContainKeys("varianceRevision", "varianceFlag", "varianceHistory");
        }
    }

    @Test
    void varianceRejectsClosedMonthsStaleRevisionsAndInvalidStateWithoutPartialWrites() {
        for (String status : List.of("CLOSED", "REOPEN_REQUESTED")) {
            Fixture fixture = fixture(member(Map.of("role", "admin")), activeLease());
            fixture.documents.put(
                "orgs/tenant-a/cashflow_cumulative_close_heads/project-a",
                closedThrough("2026-07")
            );
            fixture.documents.put(varianceWeekPath(), varianceWeek());
            fixture.documents.put(monthClosePath("project-a", "2026-07"), new LinkedHashMap<>(Map.of(
                "contractVersion", "cashflow-month-close-v1",
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "yearMonth", "2026-07",
                "status", status,
                "revision", 1L,
                "reopenCount", 0L
            )));

            assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
                fixture.persistence
            ).updateCashflowVariance(
                ACTOR,
                "project-a",
                SESSION,
                new CashflowVarianceRequest("variance-closed-" + status, "week-a", 0L, "FLAG", "검토")
            )))
                .isInstanceOf(WeeklyExpenseEditLeaseException.class)
                .satisfies(error -> assertThat(((WeeklyExpenseEditLeaseException) error).code())
                    .isEqualTo("cashflow_month_closed"));
            assertThat(fixture.documents.get(varianceWeekPath()))
                .doesNotContainKeys("varianceRevision", "varianceFlag", "varianceHistory");
        }

        Fixture stale = fixture(member(Map.of("role", "admin")), activeLease());
        Map<String, Object> staleWeek = varianceWeek();
        staleWeek.put("varianceRevision", 1L);
        staleWeek.put("varianceFlag", Map.of("status", "OPEN", "reason", "기존 검토"));
        staleWeek.put("varianceHistory", List.of(Map.of("id", "vf-1", "action", "FLAG")));
        stale.documents.put(varianceWeekPath(), staleWeek);

        assertThatThrownBy(() -> stale.persistence.runCommandTransaction(() -> commandService(
            stale.persistence
        ).updateCashflowVariance(
            ACTOR,
            "project-a",
            SESSION,
            new CashflowVarianceRequest("variance-stale", "week-a", 0L, "FLAG", "새 검토")
        )))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .satisfies(error -> assertThat(((WeeklyExpenseEditLeaseException) error).code())
                .isEqualTo("cashflow_metadata_version_conflict"));
        assertThat(stale.documents.get(varianceWeekPath())).isEqualTo(staleWeek);

        Fixture invalidState = fixture(member(Map.of("role", "finance")), activeLease());
        Map<String, Object> openWeek = varianceWeek();
        openWeek.put("varianceRevision", 1L);
        openWeek.put("varianceFlag", Map.of("status", "OPEN", "reason", "기존 검토"));
        openWeek.put("varianceHistory", List.of(Map.of("id", "vf-1", "action", "FLAG")));
        invalidState.documents.put(varianceWeekPath(), openWeek);
        assertThatThrownBy(() -> invalidState.persistence.runCommandTransaction(() -> commandService(
            invalidState.persistence
        ).updateCashflowVariance(
            ACTOR,
            "project-a",
            SESSION,
            new CashflowVarianceRequest("variance-resolve-too-early", "week-a", 1L, "RESOLVE", "")
        )))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .satisfies(error -> assertThat(((WeeklyExpenseEditLeaseException) error).code())
                .isEqualTo("cashflow_variance_state_conflict"));
        assertThat(invalidState.documents.get(varianceWeekPath())).isEqualTo(openWeek);
    }

    @Test
    void monthlyRunWithoutAnAuthorityHeadRequiresMigrationBeforeProjectionWrites() {
        for (String status : List.of("CLOSED", "REOPEN_REQUESTED")) {
            Fixture fixture = fixture(activeMember(), activeLease());
            fixture.documents.put(monthClosePath("project-a", "2026-07"), Map.of(
                "contractVersion", "cashflow-month-close-v1",
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "yearMonth", "2026-07",
                "status", status,
                "revision", 1L,
                "reopenCount", 0L
            ));

            assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
                fixture.persistence
            ).upsertProjection(
                ACTOR,
                "project-a",
                SESSION,
                new UpsertProjectionRequest("closed-" + status, List.of(
                    new UpsertProjectionRequest.ProjectionLinePatch("2026-07", 1, "SALES_IN", BigDecimal.TEN)
                ))
            )))
                .isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error ->
                    assertThat(error.code()).isEqualTo("cashflow_month_close_migration_required"));

            assertThat(fixture.documents).doesNotContainKey(weekPath());
            assertThat(fixture.documents.get(leasePath("project-a")))
                .containsEntry("state", "ACTIVE")
                .doesNotContainKeys("releasedAt", "releaseReason");
        }

        for (String status : List.of("DONE", "BROKEN", "open", " CLOSED ")) {
            Fixture fixture = fixture(activeMember(), activeLease());
            fixture.documents.put(monthClosePath("project-a", "2026-07"), Map.of(
                "contractVersion", "cashflow-month-close-v1",
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "yearMonth", "2026-07",
                "status", status,
                "revision", 1L,
                "reopenCount", 0L
            ));

            assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
                fixture.persistence
            ).upsertProjection(
                ACTOR,
                "project-a",
                SESSION,
                new UpsertProjectionRequest("invalid-run-" + status, List.of(
                    new UpsertProjectionRequest.ProjectionLinePatch("2026-07", 1, "SALES_IN", BigDecimal.TEN)
                ))
            )))
                .isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error ->
                    assertThat(error.code()).isEqualTo("cashflow_month_close_migration_required"));
        }
    }

    @Test
    void unchangedClosedPastActualDoesNotBlockAChangedOpenMonth() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(monthClosePath("project-a", "2026-06"), closedMonth("2026-06", 1, 0));
        Map<String, Object> june = new LinkedHashMap<>(Map.of(
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-06",
            "weekNo", 1,
            "weeklyExpenseActualBySheet", Map.of("default", Map.of("SALES_IN", 500L)),
            "actual", Map.of("SALES_IN", 500L)
        ));
        String junePath = "orgs/tenant-a/cashflow_weeks/project-a-2026-06-w1";
        fixture.documents.put(junePath, june);

        fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWriteLease(ACTOR, "project-a", SESSION);
            fixture.persistence.replaceActualLines(
                "tenant-a",
                "project-a",
                "default",
                List.of(
                    new SaveDraftResponse.ActualDelta("2026-06", 1, "SALES_IN", BigDecimal.valueOf(500)),
                    new SaveDraftResponse.ActualDelta("2026-07", 1, "SALES_IN", BigDecimal.valueOf(200))
                )
            );
            return null;
        });

        assertThat(fixture.documents.get(junePath)).isEqualTo(june);
        assertThat(fixture.documents.get(weekPath()))
            .containsEntry("yearMonth", "2026-07")
            .containsEntry("weekNo", 1);
        assertThat((Map<String, Object>) fixture.documents.get(weekPath()).get("actual"))
            .containsEntry("SALES_IN", 200L);
    }

    @Test
    void changedClosedPastActualRollsBackTheOpenMonthWrite() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", closedThrough("2026-06"));
        fixture.documents.put(monthClosePath("project-a", "2026-06"), closedMonth("2026-06", 1, 0));
        Map<String, Object> june = new LinkedHashMap<>(Map.of(
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-06",
            "weekNo", 1,
            "weeklyExpenseActualBySheet", Map.of("default", Map.of("SALES_IN", 500L)),
            "actual", Map.of("SALES_IN", 500L)
        ));
        String junePath = "orgs/tenant-a/cashflow_weeks/project-a-2026-06-w1";
        fixture.documents.put(junePath, june);

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWriteLease(ACTOR, "project-a", SESSION);
            fixture.persistence.replaceActualLines(
                "tenant-a",
                "project-a",
                "default",
                List.of(
                    new SaveDraftResponse.ActualDelta("2026-06", 1, "SALES_IN", BigDecimal.valueOf(501)),
                    new SaveDraftResponse.ActualDelta("2026-07", 1, "SALES_IN", BigDecimal.valueOf(200))
                )
            );
            return null;
        }))
            .isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error ->
                assertThat(error.code()).isEqualTo("cashflow_month_closed"));

        assertThat(fixture.documents.get(junePath)).isEqualTo(june);
        assertThat(fixture.documents).doesNotContainKey(weekPath());
        assertThat(fixture.documents.get(leasePath("project-a")))
            .containsEntry("state", "ACTIVE")
            .doesNotContainKeys("releasedAt", "releaseReason");
    }

    @Test
    void monthReopenRejectsMismatchedDataProjectBeforeChangingTheClose() {
        Fixture fixture = fixture(activeMember(), activeLease());
        Map<String, Object> closed = closedMonth("2026-06", 1, 0);
        fixture.documents.put(monthClosePath("project-a", "2026-06"), closed);

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).requestCashflowMonthReopen(
            ACTOR,
            "project-a",
            "other-data-project",
            new CashflowMonthReopenCommands.RequestReopen("reopen-wrong-project", "2026-06", 1, "정정 필요")
        )))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .satisfies(error -> assertThat(((WeeklyExpenseEditLeaseException) error).code())
                .isEqualTo("cashflow_data_project_mismatch"));

        assertThat(fixture.documents.get(monthClosePath("project-a", "2026-06"))).isEqualTo(closed);
        assertThat(fixture.documents.keySet()).noneMatch(path -> path.contains("reopen-wrong-project"));
    }

    @Test
    void reopenReasonAndApprovalDriveStateAndWarningCountExactlyOnce() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(monthClosePath("project-a", "2026-05"), Map.of(
            "contractVersion", "cashflow-month-close-v1",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-05",
            "status", "OPEN",
            "revision", 4L,
            "reopenCount", 2L
        ));
        fixture.documents.put(monthClosePath("project-a", "2026-06"), closedMonth("2026-06", 1, 0));
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weeks/project-a-2026-06-w3",
            new LinkedHashMap<>(Map.of(
                "id", "project-a-2026-06-w3",
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "yearMonth", "2026-06",
                "weekNo", 3,
                "projection", Map.of("SALES_IN", 200L),
                "actual", Map.of()
            ))
        );
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-06-w3",
            lockedWeeklyCompletion("2026-06", 3, 1)
        );
        WeeklyExpenseCommandService service = commandService(fixture.persistence);

        CashflowMonthCloseResponse requested = fixture.persistence.runCommandTransaction(() -> service.requestCashflowMonthReopen(
            ACTOR,
            "project-a",
            "stage-data-project",
            new CashflowMonthReopenCommands.RequestReopen("reopen-request-1", "2026-06", 1, "6월 입금 반영 오류 수정")
        ));
        assertThat(requested.status()).isEqualTo("REOPEN_REQUESTED");
        assertThat(requested.reopenReason()).isEqualTo("6월 입금 반영 오류 수정");
        assertThat(requested.projectWarningCount()).isEqualTo(2);

        fixture.documents.put("orgs/tenant-a/members/pm-1", member(Map.of(
            "role", "finance",
            "projectIds", List.of()
        )));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1"
        ));
        fixture.documents.put("orgs/tenant-a/members/finance-1", member(Map.of(
            "uid", "finance-1",
            "role", "finance",
            "projectIds", List.of()
        )));
        CashflowMonthReopenCommands.DecideReopen decision = new CashflowMonthReopenCommands.DecideReopen(
            "reopen-decision-1",
            "2026-06",
            requested.revision(),
            "APPROVE",
            "증빙 확인 완료"
        );
        CashflowMonthCloseResponse approved = fixture.persistence.runCommandTransaction(() -> service.decideCashflowMonthReopen(
            ACTOR,
            "project-a",
            "stage-data-project",
            decision
        ));
        CashflowMonthCloseResponse replay = fixture.persistence.runCommandTransaction(() -> service.decideCashflowMonthReopen(
            ACTOR,
            "project-a",
            "stage-data-project",
            decision
        ));

        assertThat(approved.status()).isEqualTo("OPEN");
        assertThat(approved.reopenCount()).isEqualTo(1);
        assertThat(approved.projectWarningCount()).isEqualTo(3);
        assertThat(approved.reopenDecision()).isEqualTo("APPROVE");
        assertThat(approved.reopenDecisionReason()).isEqualTo("증빙 확인 완료");
        assertThat(replay).isEqualTo(approved);
        assertThat(fixture.documents.get(monthClosePath("project-a", "2026-06")))
            .containsEntry("status", "OPEN")
            .containsEntry("reopenCount", 1L)
            .containsEntry("revision", 3L)
            .hasEntrySatisfying("reopenDecision", value -> assertThat((Map<String, Object>) value)
                .containsEntry("autoReopenedWeeklyCount", 1));
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-06-w3"
        ))
            .containsEntry("status", "OPEN")
            .containsEntry("revision", 2L)
            .containsEntry("reopenSource", "MONTH_REOPEN_APPROVAL")
            .hasEntrySatisfying("reopenReason", value -> assertThat(value).asString().contains("증빙 확인 완료"));
        assertThat(fixture.persistence.runCommandTransaction(() -> service.readCashflowWeeklyUpdate(
            READ_ACTOR, "project-a", "2026-06", 3
        )).status()).isEqualTo("OPEN");
        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> service.upsertProjection(
            ACTOR,
            "project-a",
            SESSION,
            new UpsertProjectionRequest("projection-after-month-reopen", List.of(
                new UpsertProjectionRequest.ProjectionLinePatch(
                    "2026-06", 3, "SALES_IN", BigDecimal.valueOf(300)
                )
            ))
        )))
            .isInstanceOfSatisfying(WeeklyExpenseEditLeaseException.class, error ->
                assertThat(error.code()).isEqualTo("cashflow_month_close_migration_required"));
    }

    @Test
    void preservesLegacyCumulativeReopenApprovalUntilTheBffCutover() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1"
        ));
        fixture.documents.put(
            "orgs/tenant-a/cashflow_cumulative_close_heads/project-a",
            closedThrough("2026-06")
        );
        Map<String, Object> legacyClose = closedMonth("2026-07", 1, 0);
        legacyClose.put("snapshot", Map.of(
            "schemaVersion", 2L,
            "contractVersion", "cashflow-cumulative-close-v2",
            "sourceFingerprint", SOURCE_REVISION
        ));
        fixture.documents.put(monthClosePath("project-a", "2026-07"), legacyClose);
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-06-w3",
            lockedWeeklyCompletion("2026-06", 3, 1)
        );
        String olderCompletionPath =
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-05-w3";
        String settlementPath = "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-06";
        fixture.documents.put(olderCompletionPath, lockedWeeklyCompletion("2026-05", 3, 1));
        fixture.documents.put(settlementPath, completedSettlement("2026-06", false));
        Map<String, Map<String, Object>> before = deepCopy(fixture.documents);
        WeeklyExpenseCommandService service = commandService(fixture.persistence);

        CashflowMonthCloseResponse requested = fixture.persistence.runCommandTransaction(() ->
            service.requestCashflowMonthReopen(
                ACTOR,
                "project-a",
                "stage-data-project",
                new CashflowMonthReopenCommands.RequestReopen(
                    "legacy-cumulative-reopen-request", "2026-07", 1, "6월 누적 결산 정정"
                )
            )
        );
        CashflowMonthCloseResponse reopened = fixture.persistence.runCommandTransaction(() ->
            service.decideCashflowMonthReopen(
                ACTOR,
                "project-a",
                "stage-data-project",
                new CashflowMonthReopenCommands.DecideReopen(
                    "legacy-cumulative-reopen-approve",
                    "2026-07",
                    requested.revision(),
                    "APPROVE",
                    "기존 월결산 회수 승인"
                )
            )
        );

        assertThat(reopened.status()).isEqualTo("OPEN");
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a"))
            .containsEntry("status", "CLOSED")
            .containsEntry("closedThrough", "2026-05")
            .containsEntry("settlementMonth", "2026-06")
            .containsEntry("revision", 2L);
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-06-w3"
        ))
            .containsEntry("status", "OPEN")
            .containsEntry("revision", 2L)
            .containsEntry("reopenSource", "MONTH_REOPEN_APPROVAL");
        assertThat(fixture.documents.get(olderCompletionPath)).isEqualTo(before.get(olderCompletionPath));
        assertThat(fixture.documents.get(settlementPath)).isEqualTo(before.get(settlementPath));
        assertThat(fixture.documents).doesNotContainKey(
            "orgs/tenant-a/cashflow_weekly_update_completion_versions/project-a-2026-06-w3-r2"
        );
    }

    @Test
    void legacyReopenRequestWithoutRequesterCanStillBeDecided() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(monthClosePath("project-a", "2026-06"), closedMonth("2026-06", 1, 0));
        fixture.persistence.runCommandTransaction(() -> requestMonthReopen(
            fixture.persistence,
            ACTOR,
            "project-a",
            new CashflowMonthReopenCommands.RequestReopen("legacy-request", "2026-06", 1, "레거시 정정")
        ));
        Map<String, Object> close = fixture.documents.get(monthClosePath("project-a", "2026-06"));
        ((Map<String, Object>) close.get("reopenRequest")).remove("requestedByUid");

        CashflowMonthCloseState decided = fixture.persistence.runCommandTransaction(() ->
            decideMonthReopen(
                fixture.persistence,
                ACTOR,
                "project-a",
                new CashflowMonthReopenCommands.DecideReopen("legacy-decision", "2026-06", 2, "APPROVE", "승인")
            )
        );

        assertThat(decided.status()).isEqualTo("OPEN");
    }

    @Test
    void legacySnapshotNullEvidenceDoesNotAbortAValidMonthReopen() {
        Fixture fixture = fixture(activeMember(), activeLease());
        Map<String, Object> close = closedMonth("2026-06", 1, 0);
        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("legacyOptionalEvidence", null);
        close.put("snapshot", snapshot);
        fixture.documents.put(monthClosePath("project-a", "2026-06"), close);

        CashflowMonthCloseState reopened = fixture.persistence.runCommandTransaction(() -> requestMonthReopen(
            fixture.persistence,
            ACTOR,
            "project-a",
            new CashflowMonthReopenCommands.RequestReopen(
                "legacy-null-evidence", "2026-06", 1, "레거시 증빙 정정"
            )
        ));

        assertThat(reopened.status()).isEqualTo("REOPEN_REQUESTED");
        assertThat(reopened.snapshot()).containsEntry("legacyOptionalEvidence", null);
    }

    @Test
    void monthCloseCountersRejectNegativeFractionalAndOutOfRangeValues() {
        for (String field : List.of("revision", "reopenCount")) {
            for (Number invalid : List.<Number>of(
                -1L,
                new BigDecimal("1.5"),
                new BigDecimal("9223372036854775808")
            )) {
                Fixture fixture = fixture(activeMember(), activeLease());
                Map<String, Object> close = closedMonth("2026-06", 1, 0);
                close.put(field, invalid);
                fixture.documents.put(monthClosePath("project-a", "2026-06"), close);

                assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
                    fixture.persistence.findCashflowMonthClose("tenant-a", "project-a", "2026-06")
                ))
                    .isInstanceOf(WeeklyExpenseConflictException.class)
                    .hasMessageContaining("non-negative whole numbers");
            }
        }
    }

    @Test
    void monthCloseReadAcceptsLegacyOpenDocument() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(
            monthClosePath("project-a", "2026-06"),
            new LinkedHashMap<>(Map.of("status", "OPEN"))
        );

        CashflowMonthCloseState result = fixture.persistence.runCommandTransaction(() ->
            fixture.persistence.findCashflowMonthClose("tenant-a", "project-a", "2026-06")
        );
        assertThat(result.status()).isEqualTo("OPEN");
        assertThat(result.revision()).isZero();
    }

    @Test
    void monthCloseQueriesSelectOnlyTheSixFieldsUsedAcrossAllMonths() {
        assertThat(FirestoreInheritedWeeklyExpensePersistence.CASHFLOW_MONTH_CLOSE_READ_FIELDS)
            .containsExactly(
                "contractVersion", "yearMonth", "revision", "reopenCount", "status",
                "postDeadlineAmendmentWarningCount"
            );

        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(monthClosePath("project-a", "2026-06"), Map.of(
            "projectId", "project-a", "status", "OPEN", "reopenCount", 2L,
            "postDeadlineAmendmentWarningCount", 3L, "snapshot", Map.of("large", "payload")
        ));

        assertThat(fixture.persistence.findCashflowMonthClose("tenant-a", "project-a", "2026-06")
            .projectWarningCount()).isEqualTo(5L);
    }

    @Test
    void monthCloseWritesStillRejectAnotherLegacyMonth() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put(monthClosePath("project-a", "2026-05"), new LinkedHashMap<>(Map.of(
            "projectId", "project-a",
            "yearMonth", "2026-05",
            "status", "CLOSED"
        )));
        fixture.documents.put(monthClosePath("project-a", "2026-06"), closedMonth("2026-06", 1, 0));

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
            requestMonthReopen(
                fixture.persistence,
                ACTOR,
                "project-a",
                new CashflowMonthReopenCommands.RequestReopen("legacy-write-guard", "2026-06", 1, "증빙 재확인")
            )
        ))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("canonical");
    }

    @Test
    void projectWarningCountAndRevisionIncrementFailClosedOnOverflow() {
        Fixture warningFixture = fixture(activeMember(), activeLease());
        warningFixture.documents.put(
            monthClosePath("project-a", "2026-05"),
            closedMonth("2026-05", 1, Long.MAX_VALUE)
        );
        warningFixture.documents.put(
            monthClosePath("project-a", "2026-06"),
            closedMonth("2026-06", 1, 1)
        );

        assertThatThrownBy(() -> warningFixture.persistence.runCommandTransaction(() ->
            warningFixture.persistence.findCashflowMonthClose("tenant-a", "project-a", "2026-06")
        ))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("exceeds the supported range");

        Fixture revisionFixture = fixture(activeMember(), activeLease());
        revisionFixture.documents.put(
            monthClosePath("project-a", "2026-06"),
            closedMonth("2026-06", Long.MAX_VALUE, 0)
        );

        assertThatThrownBy(() -> revisionFixture.persistence.runCommandTransaction(() ->
            requestMonthReopen(
                revisionFixture.persistence,
                ACTOR,
                "project-a",
                new CashflowMonthReopenCommands.RequestReopen(
                    "overflow-revision",
                    "2026-06",
                    Long.MAX_VALUE,
                    "revision overflow must fail closed"
                )
            )
        ))
            .isInstanceOf(CashflowMonthReopenPolicy.Violation.class)
            .satisfies(error -> assertThat(((CashflowMonthReopenPolicy.Violation) error).reason())
                .isEqualTo(CashflowMonthReopenPolicy.ViolationReason.COUNTER_OUT_OF_RANGE));
        assertThat(revisionFixture.documents.get(monthClosePath("project-a", "2026-06")))
            .containsEntry("status", "CLOSED")
            .containsEntry("revision", Long.MAX_VALUE);
    }

    private static void assertMissingScope(Fixture fixture, Runnable writer) {
        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> {
            writer.run();
            return null;
        }))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .satisfies(error -> {
                WeeklyExpenseEditLeaseException lease = (WeeklyExpenseEditLeaseException) error;
                org.assertj.core.api.Assertions.assertThat(lease.statusCode()).isEqualTo(503);
                org.assertj.core.api.Assertions.assertThat(lease.code()).isEqualTo("cashflow_write_permission_required");
            });
    }

    private static WeeklyExpenseProjectionEntity projection(String projectId) {
        WeeklyExpenseProjectionEntity projection = new WeeklyExpenseProjectionEntity(
            "tenant-a", projectId, "2026-07", 1, "SALES_IN"
        );
        projection.setAmount(BigDecimal.ONE);
        return projection;
    }

    private static CloseWeekRequest closeRequest(String idempotencyKey, BigDecimal amount) {
        return new CloseWeekRequest(
            idempotencyKey,
            "2026-07",
            1,
            List.of(new UpsertProjectionRequest.ProjectionLinePatch(
                "2026-07", 1, "SALES_IN", amount
            ))
        );
    }

    private static SubmitWeekRequest submitRequest(String idempotencyKey) {
        return new SubmitWeekRequest(
            idempotencyKey,
            "2026-07",
            1,
            new SubmitWeekRequest.WeeklySheetSnapshot(
                "default",
                null,
                "기본 탭",
                List.of(new SaveDraftRequest.RowPatch(
                    0,
                    "row-0",
                    null,
                    "manual",
                    List.of(
                        new SaveDraftRequest.CellPatch(3, "2026-07-W1", true),
                        new SaveDraftRequest.CellPatch(8, "매출액", true),
                        new SaveDraftRequest.CellPatch(11, "500", true)
                    )
                ))
            )
        );
    }

    private static CashflowSheetLabApplyRequest monthlyRequest(
        String idempotencyKey,
        String targetRevision,
        String emptyCellKey
    ) {
        return monthlyRequest(idempotencyKey, targetRevision, "2026-07", emptyCellKey);
    }

    private static CloseCashflowMonthRequest monthCloseRequest(
        String idempotencyKey,
        long expectedRevision,
        long expectedDraftRevision
    ) {
        return monthCloseRequest(idempotencyKey, expectedRevision, expectedDraftRevision, "2026-06");
    }

    private static CloseCashflowMonthRequest monthCloseRequest(
        String idempotencyKey,
        long expectedRevision,
        long expectedDraftRevision,
        String yearMonth
    ) {
        CashflowSheetLabApplyRequest month = monthlyRequest(
            idempotencyKey,
            "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44",
            yearMonth,
            ""
        );
        List<CloseCashflowMonthRequest.Confirmation> confirmations = month.cells().stream()
            .map(cell -> new CloseCashflowMonthRequest.Confirmation(
                cell.mode(),
                cell.weekNo(),
                cell.cashflowLine(),
                "CONFIRMED"
            ))
            .toList();
        List<CloseCashflowMonthRequest.DepositScheduleRow> depositScheduleRows = new ArrayList<>();
        for (int weekNo = 1; weekNo <= 5; weekNo += 1) {
            depositScheduleRows.add(new CloseCashflowMonthRequest.DepositScheduleRow(
                weekNo,
                weekNo == 1 ? "2026-06-03" : "",
                weekNo == 1 ? "2026-06-10" : "",
                weekNo == 1 ? BigDecimal.valueOf(1_000_000) : null,
                weekNo == 1 ? "2026-06-10" : "",
                weekNo == 1 ? BigDecimal.valueOf(1_000_000) : null,
                weekNo == 1 ? "SHEET" : "NOT_APPLICABLE",
                weekNo == 1 ? "CONFIRMED" : "NOT_APPLICABLE"
            ));
        }
        return new CloseCashflowMonthRequest(
            idempotencyKey,
            SOURCE_REVISION,
            month.targetRevision(),
            month.yearMonth(),
            expectedRevision,
            expectedDraftRevision,
            true,
            depositScheduleRows,
            month.cells(),
            confirmations,
            List.of(
                new CloseCashflowMonthRequest.ManagementCheck("labor-transfer", "OK", "MYSC 인건비 이관", "확인"),
                new CloseCashflowMonthRequest.ManagementCheck("profit-vat-after-deposit", "OK", "수익·부가세 이관", "확인"),
                new CloseCashflowMonthRequest.ManagementCheck("negative-projection-balance", "OK", "Projection 잔액", "확인"),
                new CloseCashflowMonthRequest.ManagementCheck("future-prepay-over-million", "OK", "선입금 요청", "확인")
            ),
            List.of(
                new CloseCashflowMonthRequest.ManagementConfirmation("labor-transfer", "CONFIRMED"),
                new CloseCashflowMonthRequest.ManagementConfirmation("profit-vat-after-deposit", "CONFIRMED"),
                new CloseCashflowMonthRequest.ManagementConfirmation("negative-projection-balance", "CONFIRMED"),
                new CloseCashflowMonthRequest.ManagementConfirmation("future-prepay-over-million", "CONFIRMED")
            ),
            new CashflowOpeningBalancesResponse(
                Integer.parseInt(month.yearMonth().substring(0, 4)),
                new CashflowOpeningBalancesResponse.Mode(BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of()),
                new CashflowOpeningBalancesResponse.Mode(BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of())
            ),
            new CloseCashflowMonthRequest.DeadlineSummary("", 0, 0, null)
        );
    }

    private static List<CashflowAnnualCellSet.Cell> annualCells() {
        List<CashflowAnnualCellSet.Cell> cells = new ArrayList<>();
        for (String mode : List.of("projection", "actual")) {
            for (String lineId : CashflowLineCatalog.ALL_LINES) {
                cells.add(new CashflowAnnualCellSet.Cell(
                    mode,
                    lineId,
                    "EMPTY",
                    null,
                    null,
                    lineId
                ));
            }
        }
        return cells;
    }

    @Test
    void missingCumulativeCloseHeadIsReportedAsMissingInsteadOfOpen() {
        Fixture fixture = fixture(activeMember(), Map.of());

        assertThat(fixture.persistence.findCashflowCumulativeCloseHead("tenant-a", "project-a"))
            .isNull();
    }

    @Test
    void malformedCumulativeCloseHeadUsesTheTypedApplicationReadSignal() {
        Fixture fixture = fixture(activeMember(), Map.of());
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", Map.of(
            "tenantId", "tenant-a",
            "projectId", "project-a"
        ));

        assertThatThrownBy(() -> fixture.persistence.findCashflowCumulativeCloseHead(
            "tenant-a", "project-a"
        )).isInstanceOf(CashflowReadPort.InvalidCumulativeCloseAuthority.class);
    }

    @Test
    void cumulativeAuthorityRequiresAnExactSettlementMonthImmediatelyAfterClosedThrough() {
        for (String settlementMonth : List.of("", "2026-1", "2026-02")) {
            Fixture fixture = fixture(activeMember(), Map.of());
            fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", Map.of(
                "contractVersion", "cashflow-cumulative-close-v2",
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "status", "CLOSED",
                "fromMonth", "2023-01",
                "settlementMonth", settlementMonth,
                "closedThrough", "2025-12",
                "rootHash", SOURCE_REVISION,
                "revision", 1L
            ));

            assertThatThrownBy(() -> fixture.persistence.findCashflowCumulativeCloseHead(
                "tenant-a", "project-a"
            )).as(settlementMonth).isInstanceOf(CashflowReadPort.InvalidCumulativeCloseAuthority.class);
        }
    }

    @Test
    void januarySettlementLocksThePreviousMonthAcrossTheYearBoundary() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", Map.of(
            "contractVersion", "cashflow-cumulative-close-v2",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "status", "CLOSED",
            "fromMonth", "2023-01",
            "settlementMonth", "2026-01",
            "closedThrough", "2025-12",
            "rootHash", SOURCE_REVISION,
            "revision", 1L
        ));

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            fixture.persistence.requireCashflowMonthsOpen(
                "tenant-a", "project-a", List.of("2025-12", "2026-01")
            );
            return null;
        })).isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .hasMessageContaining("2025-12");
    }

    @Test
    void cumulativeCloseUsesThePreviousMonthDataAndPublishesHeadAtomically() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-08-01"));
        CloseCashflowMonthRequest request = cumulativeCloseRequest(fixture, "2026-08", "cumulative-44");

        CashflowMonthCloseResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, request));

        assertThat(response.status()).isEqualTo("CLOSED");
        assertThat(response.requestId()).isEqualTo("cumulative-44");
        assertThat(response.requestRevision()).isEqualTo(1);
        assertThat(response.rootHash()).isEqualTo(request.manifestHash());
        assertThat(response.headRevision()).isEqualTo(1);
        assertThat(response.closeDeadline()).isEqualTo("2026-08-10");
        assertThat(response.late()).isFalse();
        assertThat(fixture.getAllSizes).contains(43);
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a"))
            .containsEntry("closedThrough", "2026-07")
            .containsEntry("rootHash", request.manifestHash())
            .containsEntry("revision", 1L);
    }

    @Test
    @SuppressWarnings("unchecked")
    void settlementCycleSubmitUsesTheCycleMonthWithoutChangingThePreviousCycle() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-09-01"));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
        ));
        String previousCyclePath = "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08";
        String currentCyclePath = "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-09";
        fixture.documents.put(previousCyclePath, completedSettlement("2026-08", true));
        fixture.documents.put(currentCyclePath, completedSettlement("2026-09", false));
        ((Map<String, Object>) ((Map<String, Object>) fixture.documents.get(previousCyclePath)
            .get("periods")).get("MONTH")).put("status", "LOCKED");
        Map<String, Object> previousCycleBefore = deepCopy(fixture.documents.get(previousCyclePath));
        Map<String, Object> currentWeekBefore = deepCopy((Map<String, Object>) ((Map<String, Object>)
            fixture.documents.get(currentCyclePath).get("periods")).get("WEEK_2"));
        SubmitCashflowSettlementCycleRequest submit = stagedSettlementCycle(
            fixture, "2026-09", "stage-cycle-key", "submit-cycle-key", 0
        );

        var submitted = fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .submitCashflowSettlementCycle(ACTOR, "project-a", submit));

        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_month_close_requests/project-a-2026-09"))
            .containsEntry("status", "PENDING_APPROVAL")
            .containsEntry("cycleYearMonth", "2026-09")
            .containsEntry("monthCloseTargetYearMonth", "2026-08");
        Map<String, Object> currentPeriods = (Map<String, Object>) fixture.documents
            .get(currentCyclePath).get("periods");
        assertThat(currentPeriods).containsKey("MONTH");
        assertThat((Map<String, Object>) currentPeriods.get("MONTH"))
            .containsEntry("status", "SUBMITTED");
        assertThat(submitted.businessState()).isEqualTo("SUBMITTED");
        assertThat(fixture.documents.get(previousCyclePath)).isEqualTo(previousCycleBefore);
        assertThat((Map<String, Object>) currentPeriods.get("WEEK_2")).isEqualTo(currentWeekBefore);

        WeeklyExpensePersistence.CashflowSettlementCycleRecord projected = fixture.persistence
            .findCashflowSettlementCyclesBatch(
                ACTOR, List.of("project-a"), "2026-09", "2026-08"
            ).get("project-a");
        assertThat(projected.projection().businessState())
            .isEqualTo(CashflowSettlementCyclePolicy.BusinessState.SUBMITTED);
        assertThat(projected.monthSettlement().status()).isEqualTo("SUBMITTED");
        assertThat(projected.weeklySettlements())
            .filteredOn(record -> record.period().equals("WEEK_2"))
            .extracting(WeeklyExpensePersistence.CashflowSettlementStatusRecord::status)
            .containsExactly("COMPLETED");

        Map<String, Object> legacySubmitted = new LinkedHashMap<>((Map<String, Object>)
            currentPeriods.get("MONTH"));
        legacySubmitted.put("status", "PENDING_APPROVAL");
        currentPeriods.put("MONTH", legacySubmitted);

        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .transitionCashflowSettlementCycle(ACTOR, "project-a", new TransitionCashflowSettlementCycleRequest(
                "withdraw-cycle-key", "WITHDRAW", "2026-09", "2026-08", "project-a-2026-09",
                1, submit.manifestHash(), 1, "입력 다시 확인"
            )));
        currentPeriods = (Map<String, Object>) fixture.documents.get(currentCyclePath).get("periods");
        assertThat((Map<String, Object>) currentPeriods.get("MONTH"))
            .containsEntry("status", "WAITING_FOR_UPDATE");
        assertThat((Map<String, Object>) currentPeriods.get("WEEK_2")).isEqualTo(currentWeekBefore);
        assertThat(fixture.documents.get(previousCyclePath)).isEqualTo(previousCycleBefore);
    }

    @Test
    void settlementCycleSubmitClaimsStagedEvidenceAndWithdrawsAllCanonicalStateAtomically() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-08-01"));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
        ));
        SubmitCashflowSettlementCycleRequest submit = stagedSettlementCycle(
            fixture, "2026-08", "stage-submit", "submit-cycle", 0
        );

        var submitted = fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .submitCashflowSettlementCycle(ACTOR, "project-a", submit));

        assertThat(submitted.businessState()).isEqualTo("SUBMITTED");
        assertThat(submitted.workflowRevision()).isEqualTo(1);
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08"))
            .containsEntry("documentType", "REQUEST")
            .containsEntry("status", "PENDING_APPROVAL")
            .containsEntry("cycleYearMonth", "2026-08")
            .containsEntry("monthCloseTargetYearMonth", "2026-07")
            .containsEntry("workflowRevision", 1L);
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_month_close_requests/__active__-project-a"))
            .containsEntry("activeCycleYearMonth", "2026-08")
            .containsEntry("activeRequestId", "project-a-2026-08")
            .containsEntry("activeState", "PENDING_APPROVAL")
            .containsEntry("workflowRevision", 1L);
        Map<String, Object> augustPeriods = (Map<String, Object>) fixture.documents
            .get("orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08").get("periods");
        assertThat((Map<String, Object>) augustPeriods.get("MONTH"))
            .containsEntry("status", "SUBMITTED")
            .containsEntry("submittedBy", "pm-1");
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08/stages/stage-submit"
        )).containsEntry("status", "STAGED").doesNotContainKey("claimedAt");

        var withdrawn = fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .transitionCashflowSettlementCycle(ACTOR, "project-a", new TransitionCashflowSettlementCycleRequest(
                "withdraw-cycle", "WITHDRAW", "2026-08", "2026-07", "project-a-2026-08",
                1, submit.manifestHash(), 1, "입력 다시 확인"
            )));

        assertThat(withdrawn.businessState()).isEqualTo("WITHDRAWN");
        assertThat(withdrawn.workflowRevision()).isEqualTo(2);
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08"))
            .containsEntry("status", "WITHDRAWN")
            .containsEntry("workflowRevision", 2L);
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_month_close_requests/__active__-project-a"))
            .containsEntry("activeState", "INACTIVE")
            .containsEntry("workflowRevision", 2L);
        augustPeriods = (Map<String, Object>) fixture.documents
            .get("orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08").get("periods");
        assertThat((Map<String, Object>) augustPeriods.get("MONTH"))
            .containsEntry("status", "WAITING_FOR_UPDATE")
            .containsEntry("submittedAt", "")
            .containsEntry("approvedAt", "");
        assertThat(fixture.documents).doesNotContainKey("orgs/tenant-a/cashflow_cumulative_close_heads/project-a");
    }

    @Test
    void settlementCycleCoordinatorRejectsAnotherCycleBeforeAnyCanonicalWrite() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-09-01"));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
        ));
        SubmitCashflowSettlementCycleRequest august = stagedSettlementCycle(
            fixture, "2026-08", "stage-august", "submit-august", 0
        );
        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .submitCashflowSettlementCycle(ACTOR, "project-a", august));
        SubmitCashflowSettlementCycleRequest september = stagedSettlementCycle(
            fixture, "2026-09", "stage-september", "submit-september", 1
        );
        Map<String, Map<String, Object>> before = deepCopy(fixture.documents);

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .submitCashflowSettlementCycle(ACTOR, "project-a", september)))
            .isInstanceOf(CashflowSettlementCycleWorkflow.Violation.class)
            .satisfies(error -> assertThat(((CashflowSettlementCycleWorkflow.Violation) error).reason())
                .isEqualTo(CashflowSettlementCycleWorkflow.ViolationReason.ACTIVE_CYCLE_EXISTS));
        assertThat(fixture.documents).isEqualTo(before);
    }

    @Test
    void settlementCycleSubmitOwnsEvidenceRevisionSequenceAndStageCommandIdentity() {
        for (int invalidRevision : List.of(1, 3)) {
            Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-09-01"));
            fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
                "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
            ));
            WeeklyExpenseCommandService service = commandService(fixture.persistence);
            SubmitCashflowSettlementCycleRequest first = stagedSettlementCycle(
                fixture, "2026-09", "stage-evidence-first-" + invalidRevision,
                "submit-evidence-first-" + invalidRevision, 0
            );
            fixture.persistence.runCommandTransaction(() -> service.submitCashflowSettlementCycle(
                ACTOR, "project-a", first
            ));
            fixture.persistence.runCommandTransaction(() -> service.transitionCashflowSettlementCycle(
                ACTOR,
                "project-a",
                new TransitionCashflowSettlementCycleRequest(
                    "withdraw-before-resubmit-" + invalidRevision,
                    "WITHDRAW",
                    first.cycleYearMonth(),
                    first.monthCloseTargetYearMonth(),
                    first.requestId(),
                    first.evidenceRevision(),
                    first.manifestHash(),
                    1,
                    "재제출 근거 교체"
                )
            ));
            String currentTargetRevision = FirestoreInheritedWeeklyExpensePersistence
                .computeCashflowTargetRevision(fixture.documents.entrySet().stream()
                    .filter(entry -> entry.getKey().contains("/cashflow_weeks/"))
                    .map(Map.Entry::getValue)
                    .toList());
            SubmitCashflowSettlementCycleRequest invalid = stagedSettlementCycle(
                fixture, "2026-09", "stage-evidence-invalid-" + invalidRevision,
                "submit-evidence-invalid-" + invalidRevision, 2, invalidRevision, currentTargetRevision
            );
            Map<String, Map<String, Object>> before = deepCopy(fixture.documents);

            assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
                service.submitCashflowSettlementCycle(ACTOR, "project-a", invalid)
            ))
                .isInstanceOf(WeeklyExpenseConflictException.class)
                .hasMessageContaining("evidence revision");
            assertThat(fixture.documents).isEqualTo(before);
        }

        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-09-01"));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
        ));
        SubmitCashflowSettlementCycleRequest staged = stagedSettlementCycle(
            fixture, "2026-09", "stage-command-mismatch", "stage-command-key", 0
        );
        SubmitCashflowSettlementCycleRequest mismatched = new SubmitCashflowSettlementCycleRequest(
            "different-command-key",
            staged.cycleYearMonth(),
            staged.monthCloseTargetYearMonth(),
            staged.requestId(),
            staged.stageId(),
            staged.evidenceRevision(),
            staged.manifestHash(),
            staged.expectedWorkflowRevision(),
            staged.expectedApproverUid(),
            staged.expectedProjectVersion()
        );
        Map<String, Map<String, Object>> before = deepCopy(fixture.documents);

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
            commandService(fixture.persistence).submitCashflowSettlementCycle(ACTOR, "project-a", mismatched)
        ))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("staging evidence changed");
        assertThat(fixture.documents).isEqualTo(before);
    }

    @Test
    void settlementCycleApprovalClosesLedgerRequestCoordinatorAndCycleMonthInOneTransaction() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-08-01"));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
        ));
        String previousCyclePath = "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-07";
        String currentCyclePath = "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08";
        fixture.documents.put(previousCyclePath, completedSettlement("2026-07", true));
        fixture.documents.put(currentCyclePath, completedSettlement("2026-08", false));
        Map<String, Object> previousCycleBefore = deepCopy(fixture.documents.get(previousCyclePath));
        Map<String, Object> currentWeekBefore = deepCopy((Map<String, Object>) ((Map<String, Object>)
            fixture.documents.get(currentCyclePath).get("periods")).get("WEEK_2"));
        SubmitCashflowSettlementCycleRequest submit = stagedSettlementCycle(
            fixture, "2026-08", "stage-approve", "submit-approve", 0
        );
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        fixture.persistence.runCommandTransaction(() -> service.submitCashflowSettlementCycle(
            ACTOR, "project-a", submit
        ));
        Map<String, Object> currentPeriods = (Map<String, Object>) fixture.documents
            .get(currentCyclePath).get("periods");
        Map<String, Object> legacySubmitted = new LinkedHashMap<>((Map<String, Object>)
            currentPeriods.get("MONTH"));
        legacySubmitted.put("status", "PENDING_APPROVAL");
        currentPeriods.put("MONTH", legacySubmitted);
        CloseCashflowMonthRequest approve = new CloseCashflowMonthRequest(
            "approve-cycle", "", "", "2026-08", 0, 0, true,
            List.of(), List.of(), List.of(), List.of(), List.of(), null, null,
            submit.requestId(), submit.evidenceRevision(), submit.manifestHash(),
            submit.cycleYearMonth(), submit.monthCloseTargetYearMonth(), 1, "조직장 확인 완료"
        );

        CashflowMonthCloseResponse response = fixture.persistence.runCommandTransaction(() -> service
            .closeCashflowMonth(ACTOR, "project-a", SESSION, approve));

        assertThat(response.status()).isEqualTo("CLOSED");
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08"))
            .containsEntry("status", "APPROVED")
            .containsEntry("evidenceRevision", 1L)
            .containsEntry("workflowRevision", 2L)
            .containsEntry("reviewedByUid", "pm-1")
            .containsEntry("decisionReason", "조직장 확인 완료")
            .containsEntry("approvalVersionId", "project-a-2026-08-r1");
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_month_close_requests/__active__-project-a"))
            .containsEntry("activeState", "INACTIVE")
            .containsEntry("workflowRevision", 2L);
        Map<String, Object> augustPeriods = (Map<String, Object>) fixture.documents
            .get("orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08").get("periods");
        assertThat((Map<String, Object>) augustPeriods.get("MONTH"))
            .containsEntry("status", "LOCKED")
            .containsEntry("revision", 2L)
            .containsEntry("approvedBy", "pm-1");
        assertThat((Map<String, Object>) augustPeriods.get("WEEK_2")).isEqualTo(currentWeekBefore);
        assertThat(fixture.documents.get(previousCyclePath)).isEqualTo(previousCycleBefore);
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a"))
            .containsEntry("closedThrough", "2026-07")
            .containsEntry("requestId", "project-a-2026-08")
            .containsEntry("requestRevision", 1L);
    }

    @Test
    void settlementCycleReopenClaimsAndRestoresEveryCanonicalStateInJvmTransactions() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-08-01"));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
        ));
        String previousCyclePath = "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-07";
        String currentCyclePath = "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08";
        fixture.documents.put(previousCyclePath, completedSettlement("2026-07", true));
        fixture.documents.put(currentCyclePath, completedSettlement("2026-08", false));
        Map<String, Object> currentWeekBefore = deepCopy((Map<String, Object>) ((Map<String, Object>)
            fixture.documents.get(currentCyclePath).get("periods")).get("WEEK_2"));
        SubmitCashflowSettlementCycleRequest submit = stagedSettlementCycle(
            fixture, "2026-08", "stage-reopen", "submit-reopen", 0
        );
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        fixture.persistence.runCommandTransaction(() -> service.submitCashflowSettlementCycle(
            ACTOR, "project-a", submit
        ));
        CashflowMonthCloseResponse approved = fixture.persistence.runCommandTransaction(() -> service
            .closeCashflowMonth(ACTOR, "project-a", SESSION, new CloseCashflowMonthRequest(
                "approve-before-reopen", "", "", "2026-08", 0, 0, true,
                List.of(), List.of(), List.of(), List.of(), List.of(), null, null,
                submit.requestId(), submit.evidenceRevision(), submit.manifestHash(),
                submit.cycleYearMonth(), submit.monthCloseTargetYearMonth(), 1, "최초 승인"
            )));
        Map<String, Object> cyclePeriods = (Map<String, Object>) fixture.documents
            .get(currentCyclePath).get("periods");
        Map<String, Object> legacyLocked = new LinkedHashMap<>((Map<String, Object>)
            cyclePeriods.get("MONTH"));
        legacyLocked.put("status", "COMPLETED");
        cyclePeriods.put("MONTH", legacyLocked);

        CashflowMonthCloseResponse requested = fixture.persistence.runCommandTransaction(() -> service
            .requestCashflowMonthReopen(
                ACTOR,
                "project-a",
                "stage-data-project",
                new CashflowMonthReopenCommands.RequestReopen(
                    "request-cycle-reopen",
                    submit.cycleYearMonth(),
                    approved.revision(),
                    "원장 정정",
                    submit.requestId(),
                    submit.cycleYearMonth(),
                    submit.monthCloseTargetYearMonth(),
                    submit.evidenceRevision(),
                    submit.manifestHash(),
                    2
                )
            ));

        assertThat(requested.status()).isEqualTo("REOPEN_REQUESTED");
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08"))
            .containsEntry("status", "REOPEN_REQUESTED")
            .containsEntry("workflowRevision", 3L)
            .hasEntrySatisfying("reopenRequest", value -> assertThat((Map<String, Object>) value)
                .containsEntry("requestedByUid", "pm-1")
                .containsEntry("reason", "원장 정정"));
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_month_close_requests/__active__-project-a"))
            .containsEntry("activeState", "REOPEN_REQUESTED")
            .containsEntry("activeRequestId", submit.requestId())
            .containsEntry("workflowRevision", 3L);
        WeeklyExpensePersistence.CashflowSettlementCycleRecord reopenProjection = fixture.persistence
            .findCashflowSettlementCyclesBatch(
                ACTOR, List.of("project-a"), submit.cycleYearMonth(), submit.monthCloseTargetYearMonth()
            ).get("project-a");
        assertThat(reopenProjection.projection().businessState())
            .isEqualTo(CashflowSettlementCyclePolicy.BusinessState.REOPEN_REQUESTED);
        assertThat(reopenProjection.projection().health())
            .isEqualTo(CashflowSettlementCyclePolicy.Health.OK);
        assertThat(reopenProjection.projection().provenance())
            .isNotNull()
            .extracting(CashflowSettlementCyclePolicy.ApprovalProvenance::ledgerRevision)
            .isEqualTo(approved.revision());
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08"))
            .containsEntry("ledgerRevision", requested.revision());
        Map<String, Object> lockedAugust = (Map<String, Object>) ((Map<String, Object>) fixture.documents
            .get("orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08").get("periods")).get("MONTH");
        assertThat(lockedAugust).containsEntry("status", "COMPLETED");

        CashflowMonthCloseResponse rejected = fixture.persistence.runCommandTransaction(() -> service
            .decideCashflowMonthReopen(
                ACTOR,
                "project-a",
                "stage-data-project",
                new CashflowMonthReopenCommands.DecideReopen(
                    "reject-cycle-reopen",
                    submit.cycleYearMonth(),
                    requested.revision(),
                    "REJECT",
                    "정정 반려",
                    submit.requestId(),
                    submit.cycleYearMonth(),
                    submit.monthCloseTargetYearMonth(),
                    submit.evidenceRevision(),
                    submit.manifestHash(),
                    3
                )
            ));
        assertThat(rejected.status()).isEqualTo("CLOSED");
        WeeklyExpensePersistence.CashflowSettlementCycleRecord rejectedProjection = fixture.persistence
            .findCashflowSettlementCyclesBatch(
                ACTOR, List.of("project-a"), submit.cycleYearMonth(), submit.monthCloseTargetYearMonth()
            ).get("project-a");
        assertThat(rejectedProjection.projection().businessState())
            .isEqualTo(CashflowSettlementCyclePolicy.BusinessState.LOCKED);
        assertThat(rejectedProjection.projection().provenance())
            .isNotNull()
            .extracting(CashflowSettlementCyclePolicy.ApprovalProvenance::ledgerRevision)
            .isEqualTo(approved.revision());

        CashflowMonthCloseResponse requestedAgain = fixture.persistence.runCommandTransaction(() -> service
            .requestCashflowMonthReopen(
                ACTOR,
                "project-a",
                "stage-data-project",
                new CashflowMonthReopenCommands.RequestReopen(
                    "request-cycle-reopen-again",
                    submit.cycleYearMonth(),
                    rejected.revision(),
                    "원장 재정정",
                    submit.requestId(),
                    submit.cycleYearMonth(),
                    submit.monthCloseTargetYearMonth(),
                    submit.evidenceRevision(),
                    submit.manifestHash(),
                    4
                )
            ));

        CashflowMonthCloseResponse reopened = fixture.persistence.runCommandTransaction(() -> service
            .decideCashflowMonthReopen(
                ACTOR,
                "project-a",
                "stage-data-project",
                new CashflowMonthReopenCommands.DecideReopen(
                    "approve-cycle-reopen",
                    submit.cycleYearMonth(),
                    requestedAgain.revision(),
                    "APPROVE",
                    "정정 승인",
                    submit.requestId(),
                    submit.cycleYearMonth(),
                    submit.monthCloseTargetYearMonth(),
                    submit.evidenceRevision(),
                    submit.manifestHash(),
                    5
                )
            ));

        assertThat(reopened.status()).isEqualTo("OPEN");
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08"))
            .containsEntry("status", "REOPENED")
            .containsEntry("workflowRevision", 6L)
            .hasEntrySatisfying("reopenDecision", value -> assertThat((Map<String, Object>) value)
                .containsEntry("decision", "APPROVE")
                .containsEntry("decidedByUid", "pm-1")
                .containsEntry("reason", "정정 승인"));
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_month_close_requests/__active__-project-a"))
            .containsEntry("activeState", "REOPENED")
            .containsEntry("workflowRevision", 6L);
        Map<String, Object> resetAugust = (Map<String, Object>) ((Map<String, Object>) fixture.documents
            .get("orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08").get("periods")).get("MONTH");
        assertThat(resetAugust)
            .containsEntry("status", "WAITING_FOR_UPDATE")
            .doesNotContainKeys("submittedAt", "submittedBy", "approvedAt", "approvedBy");
        assertThat((Map<String, Object>) ((Map<String, Object>) fixture.documents
            .get(previousCyclePath).get("periods")).get("MONTH"))
            .containsEntry("status", "COMPLETED");
        assertThat((Map<String, Object>) ((Map<String, Object>) fixture.documents
            .get(currentCyclePath).get("periods")).get("WEEK_2"))
            .isEqualTo(currentWeekBefore);
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a"))
            .containsEntry("authorityExists", false)
            .containsEntry("revision", 2L)
            .hasEntrySatisfying("closedRanges", value -> assertThat((List<?>) value).isEmpty());
    }

    @Test
    void settlementCycleReadProjectsCatchUpProvenanceAndCompensatingReopenAcrossPinnedCycles() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-10-01"));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
        ));
        fixture.documents.remove("orgs/tenant-a/cashflow_month_close_requests/project-a-2026-06");
        fixture.documents.remove("orgs/tenant-a/cashflow_month_close_requests/project-a-2026-07");
        WeeklyExpenseCommandService service = commandService(fixture.persistence);

        SubmitCashflowSettlementCycleRequest june = stagedSettlementCycle(
            fixture, "2026-06", "stage-june-authority", "submit-june-authority", 0
        );
        fixture.persistence.runCommandTransaction(() -> service.submitCashflowSettlementCycle(
            ACTOR, "project-a", june
        ));
        fixture.persistence.runCommandTransaction(() -> service.closeCashflowMonth(
            ACTOR, "project-a", SESSION, settlementCycleApproval(june, "approve-june", 1)
        ));

        String currentTargetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
            fixture.documents.entrySet().stream()
                .filter(entry -> entry.getKey().contains("/cashflow_weeks/"))
                .map(Map.Entry::getValue)
                .toList()
        );
        SubmitCashflowSettlementCycleRequest october = stagedSettlementCycle(
            fixture, "2026-10", "stage-october-catch-up", "submit-october-catch-up", 2,
            currentTargetRevision
        );
        fixture.persistence.runCommandTransaction(() -> service.submitCashflowSettlementCycle(
            ACTOR, "project-a", october
        ));
        var lockedWhileOctoberIsActive = service.readCashflowSettlementCycleDashboardItem(
            READ_ACTOR, "project-a", "2026-06"
        ).settlementCycle();
        assertThat(lockedWhileOctoberIsActive.businessState()).isEqualTo("LOCKED");
        assertThat(lockedWhileOctoberIsActive.commandCapabilities().get("REQUEST_MONTH_REOPEN"))
            .extracting(
                value -> value.allowed(),
                value -> value.reasonCode()
            )
            .containsExactly(false, "ACTIVE_CYCLE_EXISTS");
        var futureWhileOctoberIsActive = service.readCashflowSettlementCycleDashboardItem(
            READ_ACTOR, "project-a", "2026-11"
        ).settlementCycle();
        assertThat(futureWhileOctoberIsActive.businessState()).isEqualTo("NOT_REQUESTED");
        assertThat(futureWhileOctoberIsActive.commandCapabilities().get("SUBMIT_MONTH_CLOSE"))
            .extracting(
                value -> value.allowed(),
                value -> value.reasonCode()
            )
            .containsExactly(false, "ACTIVE_CYCLE_EXISTS");
        var activeOctober = service.readCashflowSettlementCycleDashboardItem(
            READ_ACTOR, "project-a", "2026-10"
        ).settlementCycle();
        assertThat(activeOctober.businessState()).isEqualTo("SUBMITTED");
        assertThat(activeOctober.commandCapabilities().get("WITHDRAW_MONTH_CLOSE").allowed()).isTrue();
        assertThat(activeOctober.commandCapabilities().get("APPROVE_MONTH_CLOSE").allowed()).isTrue();
        CashflowMonthCloseResponse approved = fixture.persistence.runCommandTransaction(() ->
            service.closeCashflowMonth(
                ACTOR, "project-a", SESSION, settlementCycleApproval(october, "approve-october", 3)
            )
        );
        for (String cycleYearMonth : List.of("2026-07", "2026-08", "2026-09", "2026-10")) {
            String targetYearMonth = YearMonth.parse(cycleYearMonth).minusMonths(1).toString();
            WeeklyExpensePersistence.CashflowSettlementCycleRecord cycle = fixture.persistence
                .findCashflowSettlementCyclesBatch(
                    ACTOR, List.of("project-a"), cycleYearMonth, targetYearMonth
                ).get("project-a");
            assertThat(cycle.projection().businessState())
                .as(cycleYearMonth)
                .isEqualTo(CashflowSettlementCyclePolicy.BusinessState.LOCKED);
            assertThat(cycle.projection().provenance())
                .as(cycleYearMonth)
                .isNotNull()
                .extracting(
                    CashflowSettlementCyclePolicy.ApprovalProvenance::affectedFromMonth,
                    CashflowSettlementCyclePolicy.ApprovalProvenance::affectedThroughMonth,
                    CashflowSettlementCyclePolicy.ApprovalProvenance::closedByCycleYearMonth,
                    CashflowSettlementCyclePolicy.ApprovalProvenance::requestId
                )
                .containsExactly("2026-06", "2026-09", "2026-10", october.requestId());
        }
        assertThat(service.readCashflowSettlementCycleDashboardItem(
            READ_ACTOR, "project-a", "2026-06"
        ).settlementCycle().commandCapabilities().get("REQUEST_MONTH_REOPEN"))
            .extracting(
                value -> value.allowed(),
                value -> value.reasonCode()
            )
            .containsExactly(false, "LATEST_APPROVAL_REQUIRED");
        assertThat(service.readCashflowSettlementCycleDashboardItem(
            READ_ACTOR, "project-a", "2026-09"
        ).settlementCycle().commandCapabilities().get("REQUEST_MONTH_REOPEN").allowed()).isTrue();

        CashflowMonthCloseResponse reopenRequested = fixture.persistence.runCommandTransaction(() ->
            service.requestCashflowMonthReopen(
                ACTOR,
                "project-a",
                "stage-data-project",
                new CashflowMonthReopenCommands.RequestReopen(
                    "request-october-catch-up-reopen",
                    october.cycleYearMonth(),
                    approved.revision(),
                    "catch-up 승인 회수",
                    october.requestId(),
                    october.cycleYearMonth(),
                    october.monthCloseTargetYearMonth(),
                    october.evidenceRevision(),
                    october.manifestHash(),
                    4
                )
            )
        );
        var coveredReopen = service.readCashflowSettlementCycleDashboardItem(
            READ_ACTOR, "project-a", "2026-09"
        );
        assertThat(coveredReopen.settlementCycle())
            .extracting(
                value -> value.businessState(),
                value -> value.health(),
                value -> value.monthCloseSettlement()
            )
            .containsExactly("REOPEN_REQUESTED", "OK", null);
        assertThat(coveredReopen.settlementStatuses().items().getFirst())
            .extracting(
                value -> value.period(),
                value -> value.status()
            )
            .containsExactly("MONTH", "WAITING_FOR_UPDATE");
        assertThat(coveredReopen.settlementCycle().commandCapabilities()
            .get("REQUEST_MONTH_REOPEN").allowed()).isFalse();
        String coordinatorPath = "orgs/tenant-a/cashflow_month_close_requests/__active__-project-a";
        Map<String, Object> reopenCoordinator = fixture.documents.get(coordinatorPath);
        Map<String, Object> inactiveCoordinator = new LinkedHashMap<>(reopenCoordinator);
        inactiveCoordinator.put("activeState", "INACTIVE");
        inactiveCoordinator.put("activeCycleYearMonth", "");
        inactiveCoordinator.put("activeRequestId", "");
        fixture.documents.put(coordinatorPath, inactiveCoordinator);
        assertThat(service.readCashflowSettlementCycleDashboardItem(
            READ_ACTOR, "project-a", "2026-09"
        ).settlementCycle().businessState()).isEqualTo("INCONSISTENT");
        fixture.documents.put(coordinatorPath, reopenCoordinator);
        fixture.persistence.runCommandTransaction(() -> service.decideCashflowMonthReopen(
            ACTOR,
            "project-a",
            "stage-data-project",
            new CashflowMonthReopenCommands.DecideReopen(
                "approve-october-catch-up-reopen",
                october.cycleYearMonth(),
                reopenRequested.revision(),
                "APPROVE",
                "5월 authority 복원",
                october.requestId(),
                october.cycleYearMonth(),
                october.monthCloseTargetYearMonth(),
                october.evidenceRevision(),
                october.manifestHash(),
                5
            )
        ));

        for (String cycleYearMonth : List.of("2026-07", "2026-08", "2026-09")) {
            String targetYearMonth = YearMonth.parse(cycleYearMonth).minusMonths(1).toString();
            assertThat(fixture.persistence.findCashflowSettlementCyclesBatch(
                ACTOR, List.of("project-a"), cycleYearMonth, targetYearMonth
            ).get("project-a").projection().businessState())
                .as(cycleYearMonth)
                .isEqualTo(CashflowSettlementCyclePolicy.BusinessState.NOT_REQUESTED);
        }
        assertThat(fixture.persistence.findCashflowSettlementCyclesBatch(
            ACTOR, List.of("project-a"), "2026-10", "2026-09"
        ).get("project-a").projection().businessState())
            .isEqualTo(CashflowSettlementCyclePolicy.BusinessState.REOPENED);
    }

    @Test
    void settlementCycleReadUsesOneReadOnlyTransactionForPrimaryAndProvenanceDocuments() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-08-01"));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
        ));
        SubmitCashflowSettlementCycleRequest submit = stagedSettlementCycle(
            fixture, "2026-08", "stage-read-snapshot", "submit-read-snapshot", 0
        );
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        fixture.persistence.runCommandTransaction(() -> service.submitCashflowSettlementCycle(
            ACTOR, "project-a", submit
        ));
        fixture.persistence.runCommandTransaction(() -> service.closeCashflowMonth(
            ACTOR, "project-a", SESSION, settlementCycleApproval(submit, "approve-read-snapshot", 1)
        ));
        clearInvocations(fixture.db, fixture.transaction);

        WeeklyExpensePersistence.CashflowSettlementCycleRecord projected = fixture.persistence
            .findCashflowSettlementCyclesBatch(
                ACTOR, List.of("project-a"), "2026-08", "2026-07"
            ).get("project-a");

        assertThat(projected.projection().businessState())
            .isEqualTo(CashflowSettlementCyclePolicy.BusinessState.LOCKED);
        assertThat(projected.weeklySettlements())
            .extracting(WeeklyExpensePersistence.CashflowSettlementStatusRecord::period)
            .containsExactly("MONTH", "WEEK_1", "WEEK_2", "WEEK_3", "WEEK_4", "WEEK_5");
        assertThat(projected.authority()).isEqualTo(
            new WeeklyExpensePersistence.CashflowSettlementCycleAuthority(
                true, true, true, true, false
            )
        );
        verify(fixture.db).runTransaction(
            any(Transaction.Function.class),
            argThat(options -> options != null
                && options.getType() == TransactionOptions.TransactionOptionsType.READ_ONLY)
        );
        verify(fixture.db, never()).getAll(any(DocumentReference[].class));
        verify(fixture.transaction, times(2)).getAll(any(DocumentReference[].class));
    }

    @Test
    void settlementCycleReadFailsClosedWhenNoRequestHasAStoredLockedMonth() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-08-01"));
        fixture.documents.put(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08",
            completedSettlement("2026-08", true)
        );

        WeeklyExpensePersistence.CashflowSettlementCycleRecord cycle = fixture.persistence
            .findCashflowSettlementCyclesBatch(
                ACTOR, List.of("project-a"), "2026-08", "2026-07"
            ).get("project-a");

        assertThat(cycle.projection().businessState())
            .isEqualTo(CashflowSettlementCyclePolicy.BusinessState.INCONSISTENT);
        assertThat(cycle.monthSettlement()).isNull();
    }

    @Test
    void settlementCycleReadFailsClosedWhenTheCoordinatorDoesNotMatchTheActiveRequest() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-08-01"));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
        ));
        SubmitCashflowSettlementCycleRequest submit = stagedSettlementCycle(
            fixture, "2026-08", "stage-coordinator-read", "submit-coordinator-read", 0
        );
        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .submitCashflowSettlementCycle(ACTOR, "project-a", submit));
        String coordinatorPath = "orgs/tenant-a/cashflow_month_close_requests/__active__-project-a";
        Map<String, Object> tampered = new LinkedHashMap<>(fixture.documents.get(coordinatorPath));
        tampered.put("activeRequestId", "project-a-2026-09");
        fixture.documents.put(coordinatorPath, tampered);

        WeeklyExpensePersistence.CashflowSettlementCycleRecord cycle = fixture.persistence
            .findCashflowSettlementCyclesBatch(
                ACTOR, List.of("project-a"), "2026-08", "2026-07"
            ).get("project-a");

        assertThat(cycle.projection().businessState())
            .isEqualTo(CashflowSettlementCyclePolicy.BusinessState.INCONSISTENT);
        assertThat(cycle.projection().workflowRevision()).isEqualTo(-1);
    }

    @Test
    void settlementCycleReadFailsClosedWhenAnActiveCoordinatorHasNoRequestDocument() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-08-01"));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
        ));
        SubmitCashflowSettlementCycleRequest submit = stagedSettlementCycle(
            fixture, "2026-08", "stage-missing-active-request", "submit-missing-active-request", 0
        );
        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .submitCashflowSettlementCycle(ACTOR, "project-a", submit));
        fixture.documents.remove(
            "orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08"
        );

        WeeklyExpensePersistence.CashflowSettlementCycleRecord cycle = fixture.persistence
            .findCashflowSettlementCyclesBatch(
                ACTOR, List.of("project-a"), "2026-08", "2026-07"
            ).get("project-a");

        assertThat(cycle.projection().businessState())
            .isEqualTo(CashflowSettlementCyclePolicy.BusinessState.INCONSISTENT);
        assertThat(cycle.projection().workflowRevision()).isEqualTo(-1);
    }

    @Test
    @SuppressWarnings("unchecked")
    void settlementCycleReadRequiresExactV3SnapshotAndLedgerProvenance() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-08-01"));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
        ));
        SubmitCashflowSettlementCycleRequest submit = stagedSettlementCycle(
            fixture, "2026-08", "stage-v3-provenance", "submit-v3-provenance", 0
        );
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        fixture.persistence.runCommandTransaction(() -> service.submitCashflowSettlementCycle(
            ACTOR, "project-a", submit
        ));
        fixture.persistence.runCommandTransaction(() -> service.closeCashflowMonth(
            ACTOR, "project-a", SESSION, settlementCycleApproval(submit, "approve-v3-provenance", 1)
        ));
        String versionPath = monthCloseVersionPath("project-a", "2026-08", 1);
        String ledgerPath = monthClosePath("project-a", "2026-08");
        Map<String, Object> canonicalVersion = deepCopy(fixture.documents.get(versionPath));
        Map<String, Object> canonicalLedger = deepCopy(fixture.documents.get(ledgerPath));

        Map<String, Object> missingRequiredVersion = deepCopy(canonicalVersion);
        ((Map<String, Object>) missingRequiredVersion.get("snapshot")).remove("approvalVersionId");
        fixture.documents.put(versionPath, missingRequiredVersion);
        assertThat(fixture.persistence.findCashflowSettlementCyclesBatch(
            ACTOR, List.of("project-a"), "2026-08", "2026-07"
        ).get("project-a").projection().businessState())
            .isEqualTo(CashflowSettlementCyclePolicy.BusinessState.INCONSISTENT);

        Map<String, Object> hashDriftedVersion = deepCopy(canonicalVersion);
        ((Map<String, Object>) hashDriftedVersion.get("snapshot")).put("operationId", "tampered-operation");
        fixture.documents.put(versionPath, hashDriftedVersion);
        assertThat(fixture.persistence.findCashflowSettlementCyclesBatch(
            ACTOR, List.of("project-a"), "2026-08", "2026-07"
        ).get("project-a").projection().businessState())
            .isEqualTo(CashflowSettlementCyclePolicy.BusinessState.INCONSISTENT);

        fixture.documents.put(versionPath, canonicalVersion);
        Map<String, Object> wrongLedger = deepCopy(canonicalLedger);
        wrongLedger.put("latestVersionId", "project-a-2026-08-r999");
        fixture.documents.put(ledgerPath, wrongLedger);
        assertThat(fixture.persistence.findCashflowSettlementCyclesBatch(
            ACTOR, List.of("project-a"), "2026-08", "2026-07"
        ).get("project-a").projection().businessState())
            .isEqualTo(CashflowSettlementCyclePolicy.BusinessState.INCONSISTENT);
    }

    @Test
    void settlementCycleApprovalUsesTheCurrentApproverAndDoesNotDeadlockOnTheStagedAssignee() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-08-01"));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
        ));
        SubmitCashflowSettlementCycleRequest submit = stagedSettlementCycle(
            fixture, "2026-08", "stage-current-approver", "submit-current-approver", 0
        );
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        fixture.persistence.runCommandTransaction(() -> service.submitCashflowSettlementCycle(
            ACTOR, "project-a", submit
        ));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "head-2", "version", 4L
        ));
        fixture.documents.put("orgs/tenant-a/members/head-2", member(Map.of(
            "uid", "head-2", "role", "viewer"
        )));
        fixture.documents.put("orgs/tenant-a/persons/person-head-2", Map.of("uid", "head-2"));
        CloseCashflowMonthRequest approval = settlementCycleApproval(
            submit, "approve-current-approver", 1
        );

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> service
            .closeCashflowMonth(ACTOR, "project-a", SESSION, approval)))
            .isInstanceOf(CashflowMonthReopenPolicy.Violation.class)
            .satisfies(error -> assertThat(((CashflowMonthReopenPolicy.Violation) error).reason())
                .isEqualTo(CashflowMonthReopenPolicy.ViolationReason.DECISION_FORBIDDEN));

        TrustedActorContext currentApprover = new TrustedActorContext(
            "tenant-a", "head-2", "head-2@example.com", "spoofed", "새 조직장"
        );
        CashflowMonthCloseResponse closed = fixture.persistence.runCommandTransaction(() -> service
            .closeCashflowMonth(currentApprover, "project-a", SESSION, approval));

        assertThat(closed.closedByUid()).isEqualTo("head-2");
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08"
        )).containsEntry("reviewedByUid", "head-2");
    }

    @Test
    void settlementCycleApprovalReceiptIsBoundToTheApprovingActor() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-08-01"));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
        ));
        fixture.documents.put("orgs/tenant-a/members/admin-2", member(Map.of(
            "uid", "admin-2", "role", "admin"
        )));
        fixture.documents.put("orgs/tenant-a/persons/person-admin-2", Map.of("uid", "admin-2"));
        SubmitCashflowSettlementCycleRequest submit = stagedSettlementCycle(
            fixture, "2026-08", "stage-actor-receipt", "submit-actor-receipt", 0
        );
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        fixture.persistence.runCommandTransaction(() -> service.submitCashflowSettlementCycle(
            ACTOR, "project-a", submit
        ));
        CloseCashflowMonthRequest approval = settlementCycleApproval(
            submit, "approve-actor-receipt", 1
        );
        fixture.persistence.runCommandTransaction(() -> service.closeCashflowMonth(
            ACTOR, "project-a", SESSION, approval
        ));
        TrustedActorContext otherAdmin = new TrustedActorContext(
            "tenant-a", "admin-2", "admin-2@example.com", "spoofed", "다른 관리자"
        );

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> service
            .closeCashflowMonth(otherAdmin, "project-a", SESSION, approval)))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("different request body");
    }

    @Test
    void latestApprovedCycleCanReopenAfterALaterCycleWasRejectedOrWithdrawn() {
        for (String terminalAction : List.of("REJECT", "WITHDRAW")) {
            Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-10-01"));
            fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
                "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
            ));
            WeeklyExpenseCommandService service = commandService(fixture.persistence);
            SubmitCashflowSettlementCycleRequest september = stagedSettlementCycle(
                fixture, "2026-09", "stage-september-approved-" + terminalAction,
                "submit-september-approved-" + terminalAction, 0
            );
            fixture.persistence.runCommandTransaction(() -> service.submitCashflowSettlementCycle(
                ACTOR, "project-a", september
            ));
            CashflowMonthCloseResponse approved = fixture.persistence.runCommandTransaction(() -> service
                .closeCashflowMonth(
                    ACTOR, "project-a", SESSION,
                    settlementCycleApproval(september, "approve-september-" + terminalAction, 1)
                ));
            String currentTargetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
                fixture.documents.entrySet().stream()
                    .filter(entry -> entry.getKey().contains("/cashflow_weeks/"))
                    .map(Map.Entry::getValue)
                    .toList()
            );
            SubmitCashflowSettlementCycleRequest october = stagedSettlementCycle(
                fixture, "2026-10", "stage-october-terminal-" + terminalAction,
                "submit-october-terminal-" + terminalAction, 2, currentTargetRevision
            );
            fixture.persistence.runCommandTransaction(() -> service.submitCashflowSettlementCycle(
                ACTOR, "project-a", october
            ));
            fixture.persistence.runCommandTransaction(() -> service.transitionCashflowSettlementCycle(
                ACTOR,
                "project-a",
                new TransitionCashflowSettlementCycleRequest(
                    "terminal-october-" + terminalAction,
                    terminalAction,
                    october.cycleYearMonth(),
                    october.monthCloseTargetYearMonth(),
                    october.requestId(),
                    october.evidenceRevision(),
                    october.manifestHash(),
                    3,
                    "다음 사이클 종료"
                )
            ));
            WeeklyExpensePersistence.CashflowSettlementCycleRecord projected = fixture.persistence
                .findCashflowSettlementCyclesBatch(
                    ACTOR, List.of("project-a"), "2026-09", "2026-08"
                ).get("project-a");
            assertThat(projected.projection().businessState())
                .as(terminalAction)
                .isEqualTo(CashflowSettlementCyclePolicy.BusinessState.LOCKED);
            assertThat(projected.projection().workflowRevision()).as(terminalAction).isEqualTo(4);

            CashflowMonthCloseResponse requested = fixture.persistence.runCommandTransaction(() -> service
                .requestCashflowMonthReopen(
                    ACTOR,
                    "project-a",
                    "stage-data-project",
                    new CashflowMonthReopenCommands.RequestReopen(
                        "reopen-september-after-" + terminalAction,
                        september.cycleYearMonth(),
                        approved.revision(),
                        "최신 승인 회수",
                        september.requestId(),
                        september.cycleYearMonth(),
                        september.monthCloseTargetYearMonth(),
                        september.evidenceRevision(),
                        september.manifestHash(),
                        4
                    )
                ));

            assertThat(requested.status()).as(terminalAction).isEqualTo("REOPEN_REQUESTED");
            assertThat(fixture.documents.get(
                "orgs/tenant-a/cashflow_month_close_requests/__active__-project-a"
            )).containsEntry("activeRequestId", september.requestId())
                .containsEntry("activeState", "REOPEN_REQUESTED")
                .containsEntry("workflowRevision", 5L);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void adminCancelActiveCycleReleasesTheCoordinatorAndResetsOnlyTheCanonicalPendingState() {
        Fixture fixture = fixture(member(Map.of("role", "admin")), activeLease(), true, LocalDate.parse("2026-08-01"));
        fixture.documents.put("orgs/tenant-a/members/admin-2", member(Map.of(
            "uid", "admin-2", "role", "admin"
        )));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1", "version", 3L
        ));
        String previousCyclePath = "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-07";
        String currentCyclePath = "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08";
        fixture.documents.put(previousCyclePath, completedSettlement("2026-07", true));
        fixture.documents.put(currentCyclePath, completedSettlement("2026-08", false));
        Map<String, Object> previousCycleBefore = deepCopy(fixture.documents.get(previousCyclePath));
        Map<String, Object> currentWeekBefore = deepCopy((Map<String, Object>) ((Map<String, Object>)
            fixture.documents.get(currentCyclePath).get("periods")).get("WEEK_2"));
        SubmitCashflowSettlementCycleRequest submit = stagedSettlementCycle(
            fixture, "2026-08", "stage-admin-cancel", "submit-admin-cancel", 0
        );
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        fixture.persistence.runCommandTransaction(() -> service.submitCashflowSettlementCycle(
            ACTOR, "project-a", submit
        ));
        Map<String, Object> headSentinel = Map.of(
            "contractVersion", "cashflow-cumulative-close-v2",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "authorityExists", false,
            "status", "OPEN",
            "fromMonth", "2023-01",
            "revision", 7L,
            "closedRanges", List.of()
        );
        fixture.documents.put(
            "orgs/tenant-a/cashflow_cumulative_close_heads/project-a", headSentinel
        );
        CancelCashflowSettlementCycleRequest cancel = new CancelCashflowSettlementCycleRequest(
            "admin-cancel-active", "2026-08", "2026-07", submit.requestId(), 1,
            "퇴사자 요청 정리"
        );

        CashflowSettlementCycleCommandResponse cancelled = fixture.persistence.runCommandTransaction(() ->
            service.cancelCashflowSettlementCycle(ACTOR, "project-a", cancel)
        );

        assertThat(cancelled.businessState()).isEqualTo("WITHDRAWN");
        assertThat(cancelled.workflowRevision()).isEqualTo(2);
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08"
        )).containsEntry("status", "WITHDRAWN")
            .containsEntry("workflowRevision", 2L)
            .containsEntry("cancelledByUid", "pm-1")
            .containsEntry("cancelReason", "퇴사자 요청 정리");
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/__active__-project-a"
        )).containsEntry("activeState", "INACTIVE")
            .containsEntry("workflowRevision", 2L);
        Map<String, Object> month = (Map<String, Object>) ((Map<String, Object>) fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08"
        ).get("periods")).get("MONTH");
        assertThat(month).containsEntry("status", "WAITING_FOR_UPDATE")
            .containsEntry("revision", 2L)
            .containsEntry("submittedAt", "")
            .containsEntry("approvedAt", "");
        assertThat((Map<String, Object>) ((Map<String, Object>) fixture.documents
            .get(currentCyclePath).get("periods")).get("WEEK_2"))
            .isEqualTo(currentWeekBefore);
        assertThat(fixture.documents.get(previousCyclePath)).isEqualTo(previousCycleBefore);
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_cumulative_close_heads/project-a"
        )).isEqualTo(headSentinel);
        assertThat(fixture.documents).doesNotContainKey(monthClosePath("project-a", "2026-08"));
        assertThat(fixture.documents.values().stream()
            .filter(document -> WeeklyExpenseCommandService.CANCEL_CASHFLOW_SETTLEMENT_CYCLE_COMMAND
                .equals(document.get("commandName")))
            .filter(document -> document.containsKey("metadataJson"))
            .count()).isEqualTo(1);
        assertThat(cancelled.auditId()).startsWith("settlement-cycle-recovery-");
        assertThat(fixture.documents).containsKey(idempotencyPath(
            "tenant-a",
            "project-a",
            WeeklyExpenseCommandService.CANCEL_CASHFLOW_SETTLEMENT_CYCLE_COMMAND,
            "admin-cancel-active"
        ));

        Map<String, Map<String, Object>> afterCancel = deepCopy(fixture.documents);
        CashflowSettlementCycleCommandResponse replay = fixture.persistence.runCommandTransaction(() ->
            service.cancelCashflowSettlementCycle(ACTOR, "project-a", cancel)
        );
        assertThat(replay).isEqualTo(cancelled);
        assertThat(fixture.documents).isEqualTo(afterCancel);

        TrustedActorContext otherAdmin = new TrustedActorContext(
            "tenant-a", "admin-2", "admin-2@example.com", "admin", "다른 관리자"
        );
        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
            service.cancelCashflowSettlementCycle(otherAdmin, "project-a", cancel)
        ))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("different request body");
        assertThat(fixture.documents).isEqualTo(afterCancel);
    }

    @Test
    @SuppressWarnings("unchecked")
    void verifiedLegacyCumulativeHeadMigrationIsAtomicActorBoundAndIdempotent() {
        Fixture fixture = fixture(member(Map.of("role", "admin")), Map.of());
        seedVerifiedLegacyCumulativeApproval(fixture);
        Map<String, Object> sourceRequest = deepCopy(fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08"
        ));
        Map<String, Object> sourceLedger = deepCopy(fixture.documents.get(
            monthClosePath("project-a", "2026-08")
        ));
        Map<String, Object> protectedStatus = deepCopy(fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-09"
        ));
        fixture.documents.put("orgs/tenant-a/members/admin-2", member(Map.of(
            "uid", "admin-2", "role", "admin"
        )));
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        MigrateCashflowSettlementCycleHeadV2Request dryRun =
            new MigrateCashflowSettlementCycleHeadV2Request(
                "migrate-v1-head", 4, SOURCE_REVISION, "검증된 legacy authority 복구", true, ""
            );
        Map<String, Map<String, Object>> beforeDryRun = deepCopy(fixture.documents);
        CashflowSettlementCycleHeadMigrationResponse validated = fixture.persistence.runCommandTransaction(() ->
            service.migrateCashflowSettlementCycleHeadV2(ACTOR, "project-a", dryRun)
        );
        assertThat(validated.auditId()).isEmpty();
        assertThat(validated.migrationFingerprint()).matches("sha256:[0-9a-f]{64}");
        assertThat(fixture.documents).isEqualTo(beforeDryRun);

        MigrateCashflowSettlementCycleHeadV2Request request =
            new MigrateCashflowSettlementCycleHeadV2Request(
                "migrate-v1-head", 4, SOURCE_REVISION, "검증된 legacy authority 복구",
                false, validated.migrationFingerprint()
            );

        CashflowSettlementCycleHeadMigrationResponse migrated = fixture.persistence.runCommandTransaction(() ->
            service.migrateCashflowSettlementCycleHeadV2(ACTOR, "project-a", request)
        );
        Map<String, Map<String, Object>> afterFirstMigration = deepCopy(fixture.documents);
        CashflowSettlementCycleHeadMigrationResponse replay = fixture.persistence.runCommandTransaction(() ->
            service.migrateCashflowSettlementCycleHeadV2(ACTOR, "project-a", request)
        );

        assertThat(replay).isEqualTo(migrated);
        assertThat(fixture.documents).isEqualTo(afterFirstMigration);
        assertThat(migrated)
            .extracting(
                CashflowSettlementCycleHeadMigrationResponse::closedThrough,
                CashflowSettlementCycleHeadMigrationResponse::cycleYearMonth,
                CashflowSettlementCycleHeadMigrationResponse::approvalVersionId,
                CashflowSettlementCycleHeadMigrationResponse::headRevision
            )
            .containsExactly("2026-08", "2026-09", "project-a-2026-09-r3-migrated-v3", 5L);
        Map<String, Object> head = fixture.documents.get(
            "orgs/tenant-a/cashflow_cumulative_close_heads/project-a"
        );
        assertThat(head)
            .containsEntry("authorityExists", true)
            .containsEntry("revision", 5L)
            .containsEntry("closedThrough", "2026-08")
            .containsEntry("rootHash", SOURCE_REVISION);
        assertThat((List<Map<String, Object>>) head.get("closedRanges"))
            .singleElement()
            .satisfies(range -> assertThat(range)
                .containsEntry("affectedFromMonth", "2023-01")
                .containsEntry("affectedThroughMonth", "2026-08")
                .containsEntry("closedByCycleYearMonth", "2026-09")
                .containsEntry("approvalVersionId", "project-a-2026-09-r3-migrated-v3")
                .containsEntry("requestId", "project-a-2026-09")
                .containsEntry("ledgerRevision", 3L)
                .containsEntry("rootHash", SOURCE_REVISION));
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/project-a-2026-09"
        )).containsEntry("documentType", "REQUEST")
            .containsEntry("cycleYearMonth", "2026-09")
            .containsEntry("monthCloseTargetYearMonth", "2026-08")
            .containsEntry("approvalVersionId", "project-a-2026-09-r3-migrated-v3")
            .containsEntry("ledgerRevision", 3L);
        Map<String, Object> cycleLedger = fixture.documents.get(monthClosePath("project-a", "2026-09"));
        Map<String, Object> cycleVersion = fixture.documents.get(
            "orgs/tenant-a/monthly_close_versions/project-a-2026-09-r3-migrated-v3"
        );
        assertThat(cycleLedger)
            .containsEntry("latestVersionId", "project-a-2026-09-r3-migrated-v3")
            .containsEntry("revision", 3L)
            .containsEntry("snapshotHash", cycleVersion.get("snapshotHash"));
        assertThat(cycleVersion)
            .containsEntry("schemaVersion", 3L)
            .containsEntry("yearMonth", "2026-09")
            .containsEntry("revision", 3L);
        assertThat((Map<String, Object>) cycleVersion.get("snapshot"))
            .containsEntry("schemaVersion", 3L)
            .containsEntry("approvalVersionId", "project-a-2026-09-r3-migrated-v3")
            .containsEntry("affectedFromMonth", "2023-01")
            .containsEntry("affectedThroughMonth", "2026-08")
            .containsEntry("headRevision", 5L);
        assertThat(fixture.persistence.hashCanonicalJson((Map<String, Object>) cycleVersion.get("snapshot")))
            .isEqualTo(cycleVersion.get("snapshotHash"));
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08"
        )).isEqualTo(sourceRequest);
        assertThat(fixture.documents.get(monthClosePath("project-a", "2026-08"))).isEqualTo(sourceLedger);
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-09"
        )).isEqualTo(protectedStatus);
        assertThat(fixture.documents.values().stream()
            .filter(document -> WeeklyExpenseCommandService.MIGRATE_CASHFLOW_SETTLEMENT_CYCLE_HEAD_V2_COMMAND
                .equals(document.get("commandName")))
            .filter(document -> document.containsKey("metadataJson"))
            .count()).isEqualTo(1);
        assertThat(fixture.documents.values().stream()
            .filter(document -> WeeklyExpenseCommandService.MIGRATE_CASHFLOW_SETTLEMENT_CYCLE_HEAD_V2_COMMAND
                .equals(document.get("commandName")))
            .filter(document -> document.containsKey("metadataJson"))
            .map(document -> String.valueOf(document.get("metadataJson")))
            .toList())
            .singleElement()
            .asString()
            .contains("\"reason\":\"검증된 legacy authority 복구\"");
        assertThat(fixture.documents).containsKey(idempotencyPath(
            "tenant-a",
            "project-a",
            WeeklyExpenseCommandService.MIGRATE_CASHFLOW_SETTLEMENT_CYCLE_HEAD_V2_COMMAND,
            "migrate-v1-head"
        ));
        WeeklyExpensePersistence.CashflowSettlementCycleRecord projected = fixture.persistence
            .findCashflowSettlementCyclesBatch(
                ACTOR, List.of("project-a"), "2026-09", "2026-08"
            ).get("project-a");
        assertThat(projected.projection().businessState())
            .isEqualTo(CashflowSettlementCyclePolicy.BusinessState.LOCKED);
        assertThat(projected.projection().health())
            .isEqualTo(CashflowSettlementCyclePolicy.Health.OK);
        assertThat(projected.projection().provenance())
            .isNotNull()
            .extracting(
                CashflowSettlementCyclePolicy.ApprovalProvenance::affectedFromMonth,
                CashflowSettlementCyclePolicy.ApprovalProvenance::affectedThroughMonth,
                CashflowSettlementCyclePolicy.ApprovalProvenance::approvalVersionId
            )
            .containsExactly("2023-01", "2026-08", "project-a-2026-09-r3-migrated-v3");

        MigrateCashflowSettlementCycleHeadV2Request changedReason =
            new MigrateCashflowSettlementCycleHeadV2Request(
                "migrate-v1-head", 4, SOURCE_REVISION, "같은 키의 다른 migration 사유"
            );
        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
            service.migrateCashflowSettlementCycleHeadV2(ACTOR, "project-a", changedReason)
        ))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("different request body");
        assertThat(fixture.documents).isEqualTo(afterFirstMigration);

        TrustedActorContext otherAdmin = new TrustedActorContext(
            "tenant-a", "admin-2", "admin-2@example.com", "admin", "다른 관리자"
        );
        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
            service.migrateCashflowSettlementCycleHeadV2(otherAdmin, "project-a", request)
        ))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("different request body");
        assertThat(fixture.documents).isEqualTo(afterFirstMigration);
    }

    @Test
    @SuppressWarnings("unchecked")
    void legacyHeadMigrationPreservesPostCloseLedgerRevisionWhileUsingApprovalRevision() {
        Fixture fixture = fixture(member(Map.of("role", "admin")), Map.of());
        seedVerifiedLegacyCumulativeApproval(fixture);
        String ledgerPath = monthClosePath("project-a", "2026-08");
        Map<String, Object> amendedLedger = new LinkedHashMap<>(fixture.documents.get(ledgerPath));
        amendedLedger.put("revision", 4L);
        amendedLedger.put("lastAmendmentEvidence", Map.of("kind", "POST_CLOSE", "revision", 4L));
        fixture.documents.put(ledgerPath, amendedLedger);
        fixture.documents.put("orgs/tenant-a/members/admin-2", member(Map.of(
            "uid", "admin-2", "role", "admin"
        )));
        WeeklyExpenseCommandService service = commandService(fixture.persistence);

        CashflowSettlementCycleHeadMigrationResponse validated = fixture.persistence.runCommandTransaction(() ->
            service.migrateCashflowSettlementCycleHeadV2(
                ACTOR,
                "project-a",
                new MigrateCashflowSettlementCycleHeadV2Request(
                    "migrate-amended-ledger", 4, SOURCE_REVISION,
                    "승인 뒤 ledger amendment 보존", true, ""
                )
            )
        );
        CashflowSettlementCycleHeadMigrationResponse migrated = fixture.persistence.runCommandTransaction(() ->
            service.migrateCashflowSettlementCycleHeadV2(
                ACTOR,
                "project-a",
                new MigrateCashflowSettlementCycleHeadV2Request(
                    "migrate-amended-ledger", 4, SOURCE_REVISION,
                    "승인 뒤 ledger amendment 보존", false, validated.migrationFingerprint()
                )
            )
        );

        assertThat(migrated.approvalVersionId())
            .isEqualTo("project-a-2026-09-r3-migrated-v3");
        Map<String, Object> request = fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/project-a-2026-09"
        );
        Map<String, Object> ledger = fixture.documents.get(monthClosePath("project-a", "2026-09"));
        Map<String, Object> version = fixture.documents.get(
            "orgs/tenant-a/monthly_close_versions/project-a-2026-09-r3-migrated-v3"
        );
        Map<String, Object> head = fixture.documents.get(
            "orgs/tenant-a/cashflow_cumulative_close_heads/project-a"
        );
        assertThat(request).containsEntry("ledgerRevision", 4L);
        assertThat(ledger)
            .containsEntry("revision", 4L)
            .containsEntry("lastAmendmentEvidence", Map.of("kind", "POST_CLOSE", "revision", 4L));
        assertThat(version).containsEntry("revision", 3L);
        assertThat((List<Map<String, Object>>) head.get("closedRanges"))
            .singleElement()
            .satisfies(range -> assertThat(range).containsEntry("ledgerRevision", 3L));
    }

    @Test
    @SuppressWarnings("unchecked")
    void legacyActiveRequestNormalizationIsAtomicAndPreservesWeeklyStatus() {
        Fixture fixture = fixture(member(Map.of("role", "admin")), Map.of());
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.ofEntries(
            Map.entry("id", "project-a"),
            Map.entry("tenantId", "tenant-a"),
            Map.entry("version", 3L),
            Map.entry("executiveApproverId", "pm-1")
        ));
        String requestId = "project-a-2026-09";
        cumulativeCloseRequest(fixture, "2026-09", requestId, false, 1);
        String requestPath = "orgs/tenant-a/cashflow_month_close_requests/" + requestId;
        Map<String, Object> rawRequest = new LinkedHashMap<>(fixture.documents.get(requestPath));
        rawRequest.remove("reviewIdempotencyKey");
        rawRequest.remove("approvalId");
        rawRequest.remove("operationId");
        rawRequest.put("tenantId", "tenant-a");
        rawRequest.put("status", "PENDING");
        rawRequest.put("requestedAt", NOW.minusSeconds(120).toString());
        rawRequest.put("requestedByUid", "pm-1");
        rawRequest.put("approverUid", "pm-1");
        fixture.documents.put(requestPath, rawRequest);
        String statusPath = "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-09";
        Map<String, Object> weekOne = Map.of(
            "status", "COMPLETED", "revision", 3L,
            "submittedAt", NOW.minusSeconds(300).toString(), "submittedBy", "pm-1",
            "approvedAt", NOW.minusSeconds(240).toString(), "approvedBy", "pm-1"
        );
        fixture.documents.put(statusPath, new LinkedHashMap<>(Map.ofEntries(
            Map.entry("tenantId", "tenant-a"),
            Map.entry("projectId", "project-a"),
            Map.entry("yearMonth", "2026-09"),
            Map.entry("periods", Map.of("WEEK_1", weekOne)),
            Map.entry("updatedAt", NOW.minusSeconds(240).toString())
        )));
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        NormalizeLegacyCashflowSettlementCycleRequest dryRun =
            new NormalizeLegacyCashflowSettlementCycleRequest(
                "normalize-september-request", "2026-09", 1,
                String.valueOf(rawRequest.get("manifestHash")), "legacy active request", true, ""
            );
        Map<String, Map<String, Object>> beforeDryRun = deepCopy(fixture.documents);

        CashflowSettlementCycleLegacyRequestNormalizationResponse validated =
            fixture.persistence.runCommandTransaction(() ->
                service.normalizeLegacyCashflowSettlementCycleRequest(ACTOR, "project-a", dryRun)
            );
        assertThat(fixture.documents).isEqualTo(beforeDryRun);

        NormalizeLegacyCashflowSettlementCycleRequest apply =
            new NormalizeLegacyCashflowSettlementCycleRequest(
                "normalize-september-request", "2026-09", 1,
                String.valueOf(rawRequest.get("manifestHash")), "legacy active request", false,
                validated.migrationFingerprint()
            );
        Map<String, Object> changedStatus = deepCopy(fixture.documents.get(statusPath));
        Map<String, Object> changedPeriods = new LinkedHashMap<>((Map<String, Object>) changedStatus.get("periods"));
        changedPeriods.put("WEEK_2", Map.of("status", "SUBMITTED", "revision", 1L));
        changedStatus.put("periods", changedPeriods);
        fixture.documents.put(statusPath, changedStatus);
        Map<String, Map<String, Object>> beforeConflict = deepCopy(fixture.documents);
        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
            service.normalizeLegacyCashflowSettlementCycleRequest(ACTOR, "project-a", apply)
        ))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("fingerprint changed");
        assertThat(fixture.documents).isEqualTo(beforeConflict);
        fixture.documents.put(statusPath, deepCopy(beforeDryRun.get(statusPath)));
        CashflowSettlementCycleLegacyRequestNormalizationResponse normalized =
            fixture.persistence.runCommandTransaction(() ->
                service.normalizeLegacyCashflowSettlementCycleRequest(ACTOR, "project-a", apply)
            );
        Map<String, Map<String, Object>> afterApply = deepCopy(fixture.documents);
        assertThat(fixture.persistence.runCommandTransaction(() ->
            service.normalizeLegacyCashflowSettlementCycleRequest(ACTOR, "project-a", apply)
        )).isEqualTo(normalized);
        assertThat(fixture.documents).isEqualTo(afterApply);
        CashflowSettlementCycleLegacyRequestNormalizationResponse resumedDryRun =
            fixture.persistence.runCommandTransaction(() ->
                service.normalizeLegacyCashflowSettlementCycleRequest(ACTOR, "project-a", dryRun)
            );
        assertThat(resumedDryRun.migrationRequired()).isFalse();
        assertThat(fixture.documents).isEqualTo(afterApply);

        assertThat(fixture.documents.get(requestPath))
            .containsEntry("documentType", "REQUEST")
            .containsEntry("status", "PENDING_APPROVAL")
            .containsEntry("cycleYearMonth", "2026-09")
            .containsEntry("monthCloseTargetYearMonth", "2026-08")
            .containsEntry("evidenceRevision", 1L)
            .containsEntry("workflowRevision", 1L);
        assertThat(fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/__active__-project-a"
        ))
            .containsEntry("activeCycleYearMonth", "2026-09")
            .containsEntry("activeRequestId", requestId)
            .containsEntry("activeState", "PENDING_APPROVAL")
            .containsEntry("workflowRevision", 1L);
        Map<String, Object> periods = (Map<String, Object>) fixture.documents.get(statusPath).get("periods");
        assertThat(periods.get("WEEK_1")).isEqualTo(weekOne);
        assertThat((Map<String, Object>) periods.get("MONTH"))
            .containsEntry("status", "SUBMITTED")
            .containsEntry("revision", 1L)
            .containsEntry("submittedAt", rawRequest.get("requestedAt"))
            .containsEntry("submittedBy", "pm-1")
            .containsEntry("approvedAt", "")
            .containsEntry("approvedBy", "");
        assertThat(fixture.documents).doesNotContainKeys(
            monthClosePath("project-a", "2026-09"),
            "orgs/tenant-a/cashflow_cumulative_close_heads/project-a",
            "orgs/tenant-a/monthly_close_versions/project-a-2026-09-r1"
        );
    }

    @Test
    void legacyCumulativeHeadMigrationRejectsIncompleteOrTamperedEvidenceWithoutWrites() {
        for (String missingPath : List.of(
            "orgs/tenant-a/monthly_close_versions/project-a-2026-08-r3",
            "orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08",
            idempotencyPath(
                "tenant-a", "project-a", WeeklyExpenseCommandService.CLOSE_CASHFLOW_MONTH_COMMAND,
                "legacy-jvm-close"
            )
        )) {
            Fixture fixture = fixture(member(Map.of("role", "admin")), Map.of());
            seedVerifiedLegacyCumulativeApproval(fixture);
            fixture.documents.remove(missingPath);
            Map<String, Map<String, Object>> before = deepCopy(fixture.documents);

            assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
                fixture.persistence
            ).migrateCashflowSettlementCycleHeadV2(
                ACTOR,
                "project-a",
                new MigrateCashflowSettlementCycleHeadV2Request(
                    "missing-" + missingPath.hashCode(), 4, SOURCE_REVISION, "누락 증거 거부 검증"
                )
            )))
                .isInstanceOf(WeeklyExpenseConflictException.class);
            assertThat(fixture.documents).isEqualTo(before);
        }

        Fixture tampered = fixture(member(Map.of("role", "admin")), Map.of());
        seedVerifiedLegacyCumulativeApproval(tampered);
        String versionPath = "orgs/tenant-a/monthly_close_versions/project-a-2026-08-r3";
        Map<String, Object> version = new LinkedHashMap<>(tampered.documents.get(versionPath));
        Map<String, Object> snapshot = new LinkedHashMap<>((Map<String, Object>) version.get("snapshot"));
        snapshot.put("requestRevision", 8L);
        version.put("snapshot", snapshot);
        tampered.documents.put(versionPath, version);
        Map<String, Map<String, Object>> before = deepCopy(tampered.documents);

        assertThatThrownBy(() -> tampered.persistence.runCommandTransaction(() -> commandService(
            tampered.persistence
        ).migrateCashflowSettlementCycleHeadV2(
            ACTOR,
            "project-a",
            new MigrateCashflowSettlementCycleHeadV2Request(
                "tampered-v1-head", 4, SOURCE_REVISION, "변조 증거 거부 검증"
            )
        )))
            .isInstanceOf(WeeklyExpenseConflictException.class);
        assertThat(tampered.documents).isEqualTo(before);

        Fixture mixedShape = fixture(member(Map.of("role", "admin")), Map.of());
        seedVerifiedLegacyCumulativeApproval(mixedShape);
        String mixedVersionPath = "orgs/tenant-a/monthly_close_versions/project-a-2026-08-r3";
        Map<String, Object> mixedVersion = new LinkedHashMap<>(mixedShape.documents.get(mixedVersionPath));
        mixedVersion.put("yearMonth", "2026-09");
        mixedShape.documents.put(mixedVersionPath, mixedVersion);
        Map<String, Map<String, Object>> beforeMixedShape = deepCopy(mixedShape.documents);

        assertThatThrownBy(() -> mixedShape.persistence.runCommandTransaction(() -> commandService(
            mixedShape.persistence
        ).migrateCashflowSettlementCycleHeadV2(
            ACTOR,
            "project-a",
            new MigrateCashflowSettlementCycleHeadV2Request(
                "mixed-v1-head", 4, SOURCE_REVISION, "혼합 shape 거부 검증"
            )
        )))
            .isInstanceOf(WeeklyExpenseConflictException.class);
        assertThat(mixedShape.documents).isEqualTo(beforeMixedShape);
    }

    @Test
    void legacyCumulativeHeadMigrationRequiresCanonicalActiveAdmin() {
        Fixture fixture = fixture(member(Map.of("role", "finance")), Map.of());
        seedVerifiedLegacyCumulativeApproval(fixture);
        Map<String, Map<String, Object>> before = deepCopy(fixture.documents);

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).migrateCashflowSettlementCycleHeadV2(
            ACTOR,
            "project-a",
            new MigrateCashflowSettlementCycleHeadV2Request(
                "finance-cannot-migrate", 4, SOURCE_REVISION, "관리자 권한 검증"
            )
        )))
            .isInstanceOf(WeeklyExpenseForbiddenException.class);
        assertThat(fixture.documents).isEqualTo(before);
    }

    @Test
    void cumulativeCloseUsesTheCycleTenthForPersistedLateStatus() {
        for (Map.Entry<LocalDate, Boolean> boundary : Map.of(
            LocalDate.parse("2026-08-10"), false,
            LocalDate.parse("2026-08-11"), true
        ).entrySet()) {
            Fixture fixture = fixture(activeMember(), activeLease(), true, boundary.getKey());
            String requestId = "cumulative-boundary-" + boundary.getKey();
            CloseCashflowMonthRequest request = cumulativeCloseRequest(fixture, "2026-08", requestId);

            CashflowMonthCloseResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
                fixture.persistence
            ).closeCashflowMonth(ACTOR, "project-a", SESSION, request));

            assertThat(response.closeDeadline()).isEqualTo("2026-08-10");
            assertThat(response.late()).isEqualTo(boundary.getValue());
            assertThat(fixture.documents.get(monthClosePath("project-a", "2026-08")))
                .containsEntry("late", boundary.getValue());
        }
    }

    @Test
    void cumulativeCloseRejectsALegacyHeadWithoutSettlementMonthAsContractInvalid() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-10-01"));
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", Map.of(
            "contractVersion", "cashflow-cumulative-close-v2",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "status", "CLOSED",
            "fromMonth", "2023-01",
            "closedThrough", "2026-08",
            "rootHash", SOURCE_REVISION,
            "revision", 1L
        ));
        CloseCashflowMonthRequest request = cumulativeCloseRequest(fixture, "2026-09", "legacy-head-next-close");
        Map<String, Map<String, Object>> before = new HashMap<>(fixture.documents);

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .closeCashflowMonth(ACTOR, "project-a", SESSION, request)))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .satisfies(error -> assertThat(((WeeklyExpenseEditLeaseException) error).code())
                .isEqualTo("cashflow_month_close_contract_invalid"));
        assertThat(fixture.documents).isEqualTo(before);
    }

    @Test
    void cumulativeCloseStillRejectsANonExtendingNewFormatHead() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-09-01"));
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", Map.of(
            "contractVersion", "cashflow-cumulative-close-v2",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "status", "CLOSED",
            "fromMonth", "2023-01",
            "settlementMonth", "2026-08",
            "closedThrough", "2026-07",
            "rootHash", SOURCE_REVISION,
            "revision", 1L
        ));
        CloseCashflowMonthRequest request = cumulativeCloseRequest(fixture, "2026-08", "new-head-same-close");

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .closeCashflowMonth(ACTOR, "project-a", SESSION, request)))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("horizon must extend");
    }

    @Test
    void cumulativeCloseRejectsMissingOrTamperedShardWithoutPartialWrites() {
        Fixture missing = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-09-01"));
        CloseCashflowMonthRequest missingRequest = cumulativeCloseRequest(missing, "2026-08", "cumulative-missing");
        missing.documents.remove("orgs/tenant-a/cashflow_month_close_request_months/cumulative-missing-r1-2024-01");

        assertThatThrownBy(() -> missing.persistence.runCommandTransaction(() -> commandService(
            missing.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, missingRequest)))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("missing");
        assertThat(missing.documents).doesNotContainKey("orgs/tenant-a/cashflow_cumulative_close_heads/project-a");

        Fixture tampered = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-09-01"));
        CloseCashflowMonthRequest tamperedRequest = cumulativeCloseRequest(tampered, "2026-08", "cumulative-tampered");
        String path = "orgs/tenant-a/cashflow_month_close_request_months/cumulative-tampered-r1-2025-01";
        Map<String, Object> shard = new LinkedHashMap<>(tampered.documents.get(path));
        List<Map<String, Object>> cells = new ArrayList<>((List<Map<String, Object>>) shard.get("cells"));
        Map<String, Object> cell = new LinkedHashMap<>(cells.getFirst());
        cell.put("cellState", "ZERO");
        cell.put("amount", 0L);
        cells.set(0, cell);
        shard.put("cells", cells);
        tampered.documents.put(path, shard);

        assertThatThrownBy(() -> tampered.persistence.runCommandTransaction(() -> commandService(
            tampered.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, tamperedRequest)))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("hash mismatch");
        assertThat(tampered.documents).doesNotContainKey("orgs/tenant-a/cashflow_cumulative_close_heads/project-a");
    }

    @Test
    void cumulativeHeadGuardsBoundaryAndRequiresExplicitAmendmentReason() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", Map.of(
            "contractVersion", "cashflow-cumulative-close-v2",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "status", "CLOSED",
            "fromMonth", "2023-01",
            "settlementMonth", "2026-09",
            "closedThrough", "2026-08",
            "rootHash", SOURCE_REVISION,
            "revision", 1L
        ));

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            fixture.persistence.requireCashflowMonthsOpen("tenant-a", "project-a", List.of("2026-08"));
            return null;
        })).isInstanceOf(WeeklyExpenseEditLeaseException.class).hasMessageContaining("명시적 변경 사유");

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            fixture.persistence.authorizeCashflowSheetMonthAmendments(
                ACTOR, "project-a", List.of("2026-08"), SOURCE_REVISION, "", "guard-reason"
            );
            return null;
        })).isInstanceOf(WeeklyExpenseEditLeaseException.class).hasMessageContaining("사유");

        assertThatCode(() -> fixture.persistence.runCommandTransaction(() -> {
            fixture.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            fixture.persistence.authorizeCashflowSheetMonthAmendments(
                ACTOR, "project-a", List.of("2026-08"), SOURCE_REVISION, "승인된 정정", "guard-amend"
            );
            fixture.persistence.requireCashflowMonthsOpen("tenant-a", "project-a", List.of("2026-08", "2026-09"));
            return null;
        })).doesNotThrowAnyException();
    }

    @Test
    void partialCumulativeHeadFailsClosedWithoutCanonicalWritesOrAmendments() {
        Fixture write = fixture(activeMember(), activeLease());
        write.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", Map.of(
            "tenantId", "tenant-a",
            "projectId", "project-a"
        ));
        Map<String, Map<String, Object>> beforeWrite = new HashMap<>(write.documents);

        assertThatThrownBy(() -> write.persistence.runCommandTransaction(() -> commandService(
            write.persistence
        ).upsertProjection(
            ACTOR,
            "project-a",
            SESSION,
            new UpsertProjectionRequest("partial-head-write", List.of(
                new UpsertProjectionRequest.ProjectionLinePatch("2026-08", 1, "SALES_IN", BigDecimal.TEN)
            ))
        )))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .satisfies(error -> {
                assertThat(((WeeklyExpenseEditLeaseException) error).code())
                    .isEqualTo("cashflow_month_close_contract_invalid");
                assertThat(error.getMessage())
                    .doesNotContain("Cashflow", "Stored", "Firestore", "revision");
            });
        assertThat(write.documents).isEqualTo(beforeWrite);

        Fixture amendment = fixture(activeMember(), activeLease());
        amendment.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", Map.of(
            "tenantId", "tenant-a",
            "projectId", "project-a"
        ));
        Map<String, Map<String, Object>> beforeAmendment = new HashMap<>(amendment.documents);

        assertThatThrownBy(() -> amendment.persistence.runCommandTransaction(() -> {
            amendment.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            amendment.persistence.authorizeCashflowSheetMonthAmendments(
                ACTOR,
                "project-a",
                List.of("2026-08"),
                SOURCE_REVISION,
                "승인된 정정",
                "partial-head-amendment"
            );
            return null;
        }))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .satisfies(error -> assertThat(((WeeklyExpenseEditLeaseException) error).code())
                .isEqualTo("cashflow_month_close_contract_invalid"));
        assertThat(amendment.documents).isEqualTo(beforeAmendment);
    }

    @Test
    void settlementMonthHistoryDoesNotExtendTheCumulativeCloseBoundary() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", Map.of(
            "contractVersion", "cashflow-cumulative-close-v2",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "status", "CLOSED",
            "fromMonth", "2023-01",
            "settlementMonth", "2026-08",
            "closedThrough", "2026-07",
            "rootHash", SOURCE_REVISION,
            "revision", 1L
        ));
        fixture.documents.put(monthClosePath("project-a", "2026-08"), closedMonth("2026-08", 1, 0));

        assertThatCode(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).upsertProjection(
            ACTOR,
            "project-a",
            SESSION,
            new UpsertProjectionRequest("open-settlement-month", List.of(
                new UpsertProjectionRequest.ProjectionLinePatch("2026-08", 1, "SALES_IN", BigDecimal.TEN)
            ))
        ))).doesNotThrowAnyException();

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).upsertProjection(
            ACTOR,
            "project-a",
            SESSION,
            new UpsertProjectionRequest("closed-through-month", List.of(
                new UpsertProjectionRequest.ProjectionLinePatch("2026-07", 1, "SALES_IN", BigDecimal.TEN)
            ))
        )))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .satisfies(error -> assertThat(((WeeklyExpenseEditLeaseException) error).code())
                .isEqualTo("cashflow_month_closed"));
    }

    @Test
    void weeklyCompletionUsesClosedThroughInsteadOfSettlementMonthAsItsWriteBoundary() {
        Fixture fixture = fixture(activeMember(), Map.of());
        putCompleteProjectionWindow(fixture, "2026-08", 3);
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", Map.ofEntries(
            Map.entry("contractVersion", "cashflow-cumulative-close-v2"),
            Map.entry("tenantId", "tenant-a"),
            Map.entry("projectId", "project-a"),
            Map.entry("status", "CLOSED"),
            Map.entry("fromMonth", "2023-01"),
            Map.entry("settlementMonth", "2026-08"),
            Map.entry("closedThrough", "2026-07"),
            Map.entry("rootHash", SOURCE_REVISION),
            Map.entry("revision", 1L)
        ));

        CashflowWeeklyUpdateCompletionResponse august = fixture.persistence.runCommandTransaction(() ->
            commandService(fixture.persistence).completeCashflowWeeklyUpdate(
                ACTOR,
                "project-a",
                new CompleteCashflowWeeklyUpdateRequest(
                    "weekly-open-after-july-close", "2026-08", 3, "2026-08-13T07:00:00Z"
                )
            )
        );

        assertThat(august.status()).isEqualTo("SUBMITTED");
        assertThat(fixture.documents).containsKey(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-08-w3"
        );

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
            commandService(fixture.persistence).completeCashflowWeeklyUpdate(
                ACTOR,
                "project-a",
                new CompleteCashflowWeeklyUpdateRequest(
                    "weekly-blocked-inside-july-close", "2026-07", 5, "2026-07-31T07:00:00Z"
                )
            )
        ))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .satisfies(error -> {
                WeeklyExpenseEditLeaseException lease = (WeeklyExpenseEditLeaseException) error;
                assertThat(lease.code()).isEqualTo("cashflow_month_closed");
                assertThat(lease.getMessage()).contains("누적 결산 완료 월");
                assertThat(lease.getMessage()).doesNotContain("Cashflow month is closed");
            });
        assertThat(fixture.documents).doesNotContainKey(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w5"
        );
    }

    @Test
    void cumulativeAuthorityOnlyLocksTheCanonicalHeadYear() {
        Fixture annualYear = fixture(activeMember(), activeLease());
        annualYear.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", Map.of(
            "contractVersion", "cashflow-cumulative-close-v2",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "status", "CLOSED",
            "fromMonth", "2023-01",
            "settlementMonth", "2026-08",
            "closedThrough", "2026-07",
            "rootHash", SOURCE_REVISION,
            "revision", 1L
        ));

        assertThatCode(() -> annualYear.persistence.runCommandTransaction(() -> {
            annualYear.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            annualYear.persistence.requireCashflowMonthsOpen(
                "tenant-a", "project-a", List.of("2025-12", "2026-08")
            );
            return null;
        })).doesNotThrowAnyException();

        Fixture driftedMirror = fixture(activeMember(), activeLease());
        driftedMirror.documents.put(
            "orgs/tenant-a/cashflow_cumulative_close_heads/project-a",
            annualYear.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a")
        );
        driftedMirror.documents.put("orgs/tenant-a/cashflow_sheet_mirrors/project-a", Map.of(
            "projectId", "project-a", "weeklyYear", 2027
        ));
        assertThatThrownBy(() -> driftedMirror.persistence.runCommandTransaction(() -> {
            driftedMirror.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            driftedMirror.persistence.requireCashflowMonthsOpen(
                "tenant-a", "project-a", List.of("2026-07")
            );
            return null;
        }))
            .isInstanceOf(WeeklyExpenseEditLeaseException.class)
            .satisfies(error -> assertThat(((WeeklyExpenseEditLeaseException) error).code())
                .isEqualTo("cashflow_month_closed"));

        Fixture missingGrain = fixture(activeMember(), activeLease());
        missingGrain.documents.put(
            "orgs/tenant-a/cashflow_cumulative_close_heads/project-a",
            annualYear.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a")
        );
        missingGrain.documents.remove("orgs/tenant-a/cashflow_sheet_mirrors/project-a");
        assertThatCode(() -> missingGrain.persistence.runCommandTransaction(() -> {
            missingGrain.persistence.requireCashflowWritePermission(ACTOR, "project-a");
            missingGrain.persistence.requireCashflowMonthsOpen(
                "tenant-a", "project-a", List.of("2026-08")
            );
            return null;
        })).doesNotThrowAnyException();
    }

    @Test
    void legacyCumulativeRequestWithoutThroughMonthKeepsItsOriginalHorizon() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-09-01"));
        CloseCashflowMonthRequest request = cumulativeCloseRequest(fixture, "2026-08", "legacy-cumulative", true);

        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .closeCashflowMonth(ACTOR, "project-a", SESSION, request));

        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a"))
            .containsEntry("settlementMonth", "2026-09")
            .containsEntry("closedThrough", "2026-08");
        assertThat(fixture.persistence.findCashflowCumulativeCloseHead("tenant-a", "project-a"))
            .isNotNull();
    }

    @Test
    void legacyCumulativeRevisionTwoClosesItsPreservedFortyFourMonthHorizon() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-09-01"));
        CloseCashflowMonthRequest request = cumulativeCloseRequest(
            fixture, "2026-08", "legacy-cumulative-r2", true, 2
        );

        CashflowMonthCloseResponse response = fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, request));

        assertThat(response.requestRevision()).isEqualTo(2);
        assertThat(fixture.getAllSizes).contains(44);
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a"))
            .containsEntry("settlementMonth", "2026-09")
            .containsEntry("closedThrough", "2026-08");
    }

    @Test
    void legacyCumulativeClosePreservesTheFrozenPreB7DocumentsForRollback() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-09-01"));
        Map<String, Object> legacyHead = new LinkedHashMap<>(closedThrough("2026-07"));
        legacyHead.put("requestId", "project-a-2026-08");
        legacyHead.put("approvalId", "");
        legacyHead.put("operationId", "");
        legacyHead.put("rollbackSentinel", "preserve-old-merge");
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", legacyHead);
        CloseCashflowMonthRequest request = cumulativeCloseRequest(
            fixture, "2026-08", "legacy-frozen-pre-b7", true
        );

        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .closeCashflowMonth(ACTOR, "project-a", SESSION, request));

        Map<String, Object> close = fixture.documents.get(monthClosePath("project-a", "2026-08"));
        Map<String, Object> snapshot = (Map<String, Object>) close.get("snapshot");
        Map<String, Object> version = fixture.documents.get(
            "orgs/tenant-a/monthly_close_versions/project-a-2026-08-r1"
        );
        Map<String, Object> head = fixture.documents.get(
            "orgs/tenant-a/cashflow_cumulative_close_heads/project-a"
        );

        assertThat(((Number) snapshot.get("schemaVersion")).longValue()).isEqualTo(2);
        assertThat(snapshot).doesNotContainKeys(
            "approvalVersionId", "previousAuthorityExists", "preApprovalAuthority",
            "affectedFromMonth", "affectedThroughMonth"
        );
        assertThat(((Number) version.get("schemaVersion")).longValue()).isEqualTo(1);
        assertThat(version).doesNotContainKeys(
            "previousAuthorityExists", "preApprovalAuthority", "affectedFromMonth", "affectedThroughMonth"
        );
        assertThat(head)
            .containsEntry("rollbackSentinel", "preserve-old-merge")
            .containsEntry("closedThrough", "2026-08")
            .containsEntry("settlementMonth", "2026-09")
            .containsEntry("approvalId", "approval-legacy-frozen-pre-b7")
            .containsEntry("operationId", "operation-legacy-frozen-pre-b7")
            .doesNotContainKeys("authorityExists", "closedRanges");
    }

    @Test
    void legacyCumulativeCloseCannotDowngradeCanonicalCycleAuthority() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-09-01"));
        Map<String, Object> canonicalHead = new LinkedHashMap<>(Map.ofEntries(
            Map.entry("contractVersion", "cashflow-cumulative-close-v2"),
            Map.entry("tenantId", "tenant-a"),
            Map.entry("projectId", "project-a"),
            Map.entry("authorityExists", true),
            Map.entry("status", "CLOSED"),
            Map.entry("fromMonth", "2023-01"),
            Map.entry("closedThrough", "2026-07"),
            Map.entry("settlementMonth", "2026-08"),
            Map.entry("rootHash", SOURCE_REVISION),
            Map.entry("revision", 1L),
            Map.entry("requestId", "project-a-2026-08"),
            Map.entry("requestRevision", 1L),
            Map.entry("approvalId", "settlement-cycle-approval:project-a-2026-08:w2"),
            Map.entry("operationId", "approve-cycle-1"),
            Map.entry("closedAt", NOW.minusSeconds(60).toString()),
            Map.entry("closedByUid", "pm-1"),
            Map.entry("closedRanges", List.of(Map.ofEntries(
                Map.entry("affectedFromMonth", "2023-01"),
                Map.entry("affectedThroughMonth", "2026-07"),
                Map.entry("closedByCycleYearMonth", "2026-08"),
                Map.entry("approvalVersionId", "project-a-2026-08-r1"),
                Map.entry("requestId", "project-a-2026-08"),
                Map.entry("ledgerRevision", 1L),
                Map.entry("rootHash", SOURCE_REVISION)
            )))
        ));
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", canonicalHead);
        CloseCashflowMonthRequest request = cumulativeCloseRequest(
            fixture, "2026-08", "legacy-cannot-downgrade-v3", true
        );
        Map<String, Map<String, Object>> before = deepCopy(fixture.documents);

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .closeCashflowMonth(ACTOR, "project-a", SESSION, request)))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("canonical settlement cycle authority");

        assertThat(fixture.documents).isEqualTo(before);
        verify(fixture.transaction, never()).set(any(DocumentReference.class), any(), any());
        verify(fixture.transaction, never()).create(any(DocumentReference.class), any());
    }

    @Test
    void legacyCumulativeReopenCannotMutateCanonicalCycleAuthority() {
        Fixture fixture = fixture(activeMember(), activeLease());
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", Map.ofEntries(
            Map.entry("contractVersion", "cashflow-cumulative-close-v2"),
            Map.entry("tenantId", "tenant-a"),
            Map.entry("projectId", "project-a"),
            Map.entry("authorityExists", true),
            Map.entry("status", "CLOSED"),
            Map.entry("fromMonth", "2023-01"),
            Map.entry("closedThrough", "2026-07"),
            Map.entry("settlementMonth", "2026-08"),
            Map.entry("rootHash", SOURCE_REVISION),
            Map.entry("revision", 3L),
            Map.entry("closedRanges", List.of())
        ));
        Map<String, Object> close = closedMonth("2026-08", 1, 0);
        close.put("snapshot", Map.of(
            "schemaVersion", 2L,
            "contractVersion", "cashflow-cumulative-close-v2",
            "sourceFingerprint", SOURCE_REVISION
        ));
        fixture.documents.put(monthClosePath("project-a", "2026-08"), close);

        fixture.persistence.runCommandTransaction(() -> requestMonthReopen(
            fixture.persistence,
            ACTOR,
            "project-a",
            new CashflowMonthReopenCommands.RequestReopen(
                "legacy-cannot-reopen-v3-request", "2026-08", 1, "정정"
            )
        ));
        Map<String, Map<String, Object>> beforeDecision = deepCopy(fixture.documents);

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> decideMonthReopen(
            fixture.persistence,
            FINANCE_ACTOR,
            "project-a",
            new CashflowMonthReopenCommands.DecideReopen(
                "legacy-cannot-reopen-v3-decision", "2026-08", 2, "APPROVE", "승인"
            )
        )))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("canonical settlement cycle authority");
        assertThat(fixture.documents).isEqualTo(beforeDecision);
    }

    @Test
    void newSettlementAdvancesAfterALegacyRequestClosedByTheCurrentCode() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-10-01"));
        CloseCashflowMonthRequest legacy = cumulativeCloseRequest(
            fixture, "2026-08", "legacy-current-code", true
        );
        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .closeCashflowMonth(ACTOR, "project-a", SESSION, legacy));
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a"))
            .containsEntry("settlementMonth", "2026-09")
            .containsEntry("closedThrough", "2026-08");

        String currentTargetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
            fixture.documents.entrySet().stream()
                .filter(entry -> entry.getKey().contains("/cashflow_weeks/"))
                .map(Map.Entry::getValue)
                .toList()
        );
        CloseCashflowMonthRequest next = cumulativeCloseRequest(
            fixture, "2026-10", "new-after-legacy-current-code", false, 1, currentTargetRevision
        );
        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .closeCashflowMonth(ACTOR, "project-a", SESSION, next));

        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a"))
            .containsEntry("settlementMonth", "2026-10")
            .containsEntry("closedThrough", "2026-09")
            .containsEntry("revision", 2L);
        assertThat(fixture.documents.keySet()).noneMatch(path -> path.contains("/cashflow_month_amendments/"));
    }

    @Test
    void legacyRequestPublishesCanonicalNextCycleAuthorityAndDoesNotInventAnOldMonthReopen() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-09-01"));
        CloseCashflowMonthRequest first = cumulativeCloseRequest(
            fixture, "2026-08", "legacy-before-reopen", true
        );
        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .closeCashflowMonth(ACTOR, "project-a", SESSION, first));
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a"))
            .containsEntry("settlementMonth", "2026-09")
            .containsEntry("closedThrough", "2026-08");

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> requestMonthReopen(
            fixture.persistence, ACTOR, "project-a", new CashflowMonthReopenCommands.RequestReopen(
                "legacy-reopen-request", "2026-08", 1, "레거시 결산 정정"
            )
        )))
            .isInstanceOf(CashflowMonthReopenPolicy.Violation.class)
            .satisfies(error -> assertThat(((CashflowMonthReopenPolicy.Violation) error).reason())
                .isEqualTo(CashflowMonthReopenPolicy.ViolationReason.LATEST_HORIZON_ONLY));
    }

    @Test
    void legacyCumulativeRequestCannotCloseItsTargetMonthEarly() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-08-01"));
        CloseCashflowMonthRequest request = cumulativeCloseRequest(fixture, "2026-08", "legacy-cumulative-early", true);

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .closeCashflowMonth(ACTOR, "project-a", SESSION, request)))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("after the target month ends");
        assertThat(fixture.documents).doesNotContainKey("orgs/tenant-a/cashflow_cumulative_close_heads/project-a");
    }

    @Test
    void legacyCumulativeApprovalWithoutV3EvidenceUsesTheFrozenOneMonthRollback() {
        Fixture fixture = fixture(activeMember(), Map.of());
        Map<String, Object> authorityHead = new LinkedHashMap<>(Map.of(
            "contractVersion", "cashflow-cumulative-close-v2", "tenantId", "tenant-a", "projectId", "project-a",
            "status", "CLOSED", "fromMonth", "2023-01", "settlementMonth", "2026-08", "closedThrough", "2026-07",
            "rootHash", SOURCE_REVISION, "revision", 1L
        ));
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", authorityHead);
        fixture.documents.put(monthClosePath("project-a", "2026-08"), Map.of(
            "contractVersion", "cashflow-month-close-v1", "tenantId", "tenant-a", "projectId", "project-a",
            "yearMonth", "2026-08", "status", "CLOSED", "revision", 1L, "reopenCount", 0L,
            "snapshotHash", SOURCE_REVISION
        ));

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
            requestMonthReopen(fixture.persistence, ACTOR, "project-a", new CashflowMonthReopenCommands.RequestReopen(
                "reopen-old", "2026-07", 1, "과거 월"
            )))).isInstanceOf(CashflowMonthReopenPolicy.Violation.class)
            .satisfies(error -> assertThat(((CashflowMonthReopenPolicy.Violation) error).reason())
                .isEqualTo(CashflowMonthReopenPolicy.ViolationReason.LATEST_HORIZON_ONLY));
        verify(fixture.transaction, never()).set(any(DocumentReference.class), any(), any());

        fixture.persistence.runCommandTransaction(() -> requestMonthReopen(
            fixture.persistence, ACTOR, "project-a", new CashflowMonthReopenCommands.RequestReopen("reopen-latest", "2026-08", 1, "정정")
        ));
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a"))
            .isEqualTo(authorityHead);
        fixture.persistence.runCommandTransaction(() -> decideMonthReopen(
            fixture.persistence, FINANCE_ACTOR, "project-a", new CashflowMonthReopenCommands.DecideReopen("reopen-decision", "2026-08", 2, "APPROVE", "승인")
        ));
        assertThat(fixture.documents.get(monthClosePath("project-a", "2026-08")))
            .containsEntry("status", "OPEN")
            .containsEntry("revision", 3L);
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a"))
            .containsEntry("status", "CLOSED")
            .containsEntry("closedThrough", "2026-06")
            .containsEntry("settlementMonth", "2026-07")
            .containsEntry("revision", 2L)
            .doesNotContainKeys("authorityExists", "closedRanges");
    }

    @Test
    void cumulativeReopenRejectionDoesNotMutateTheAuthorityHead() {
        Fixture fixture = fixture(activeMember(), Map.of());
        Map<String, Object> authorityHead = new LinkedHashMap<>(Map.of(
            "contractVersion", "cashflow-cumulative-close-v2", "tenantId", "tenant-a", "projectId", "project-a",
            "status", "CLOSED", "fromMonth", "2023-01", "settlementMonth", "2026-08", "closedThrough", "2026-07",
            "rootHash", SOURCE_REVISION, "revision", 1L
        ));
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", authorityHead);
        fixture.documents.put(monthClosePath("project-a", "2026-08"), Map.of(
            "contractVersion", "cashflow-month-close-v1", "tenantId", "tenant-a", "projectId", "project-a",
            "yearMonth", "2026-08", "status", "CLOSED", "revision", 1L, "reopenCount", 0L,
            "snapshotHash", SOURCE_REVISION
        ));

        fixture.persistence.runCommandTransaction(() -> requestMonthReopen(
            fixture.persistence, ACTOR, "project-a", new CashflowMonthReopenCommands.RequestReopen(
                "reopen-rejected", "2026-08", 1, "정정"
            )
        ));
        fixture.persistence.runCommandTransaction(() -> decideMonthReopen(
            fixture.persistence, FINANCE_ACTOR, "project-a", new CashflowMonthReopenCommands.DecideReopen(
                "reopen-rejected-decision", "2026-08", 2, "REJECT", "반려"
            )
        ));

        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a"))
            .isEqualTo(authorityHead);
    }

    @Test
    void legacyCumulativeApprovalReopensOnlyTheHeadDefinedDataMonth() {
        Fixture fixture = fixture(activeMember(), Map.of());
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", Map.of(
            "contractVersion", "cashflow-cumulative-close-v2", "tenantId", "tenant-a", "projectId", "project-a",
            "status", "CLOSED", "fromMonth", "2023-01", "settlementMonth", "2026-08", "closedThrough", "2026-07",
            "rootHash", SOURCE_REVISION, "revision", 1L
        ));
        fixture.documents.put(monthClosePath("project-a", "2026-08"), Map.of(
            "contractVersion", "cashflow-month-close-v1", "tenantId", "tenant-a", "projectId", "project-a",
            "yearMonth", "2026-08", "status", "CLOSED", "revision", 1L, "reopenCount", 0L,
            "snapshotHash", SOURCE_REVISION
        ));
        String completionPath = "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w1";
        fixture.documents.put(completionPath, lockedWeeklyCompletion("2026-07", 1, 1));

        fixture.persistence.runCommandTransaction(() -> requestMonthReopen(
            fixture.persistence, ACTOR, "project-a", new CashflowMonthReopenCommands.RequestReopen("reopen-request", "2026-08", 1, "정정")
        ));
        fixture.persistence.runCommandTransaction(() -> decideMonthReopen(
            fixture.persistence, FINANCE_ACTOR, "project-a", new CashflowMonthReopenCommands.DecideReopen("reopen-decision", "2026-08", 2, "APPROVE", "승인")
        ));
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a"))
            .containsEntry("settlementMonth", "2026-07")
            .containsEntry("closedThrough", "2026-06");
        assertThat(fixture.persistence.findCashflowCumulativeCloseHead("tenant-a", "project-a"))
            .isNotNull();
        assertThat(fixture.documents.get(completionPath))
            .containsEntry("status", "OPEN")
            .containsEntry("revision", 2L)
            .containsEntry("reopenSource", "MONTH_REOPEN_APPROVAL");
        assertThat(fixture.documents).doesNotContainKey(
            "orgs/tenant-a/cashflow_weekly_update_completion_versions/project-a-2026-07-w1-r2"
        );
    }

    @Test
    @SuppressWarnings("unchecked")
    void cumulativeCatchUpRangeCanCrossAYearBoundaryAndRestoreThePriorAuthority() {
        Fixture fixture = fixture(
            member(Map.of("role", "finance")),
            activeLease(),
            true,
            LocalDate.parse("2026-10-01")
        );
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a",
            "tenantId", "tenant-a",
            "executiveApproverId", "pm-1"
        ));
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        String initialTargetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
            fixture.documents.entrySet().stream()
                .filter(entry -> entry.getKey().contains("/cashflow_weeks/"))
                .map(Map.Entry::getValue)
                .toList()
        );

        fixture.persistence.runCommandTransaction(() -> service.closeCashflowMonth(
            ACTOR,
            "project-a",
            SESSION,
            explicitSettlementCycleCloseRequest(
                fixture,
                "2025-12",
                "cross-year-prior",
                initialTargetRevision
            )
        ));
        Map<String, Object> priorHead = deepCopy(fixture.documents.get(
            "orgs/tenant-a/cashflow_cumulative_close_heads/project-a"
        ));
        String currentTargetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
            fixture.documents.entrySet().stream()
                .filter(entry -> entry.getKey().contains("/cashflow_weeks/"))
                .filter(entry -> String.valueOf(entry.getValue().get("yearMonth")).startsWith("2026-"))
                .map(Map.Entry::getValue)
                .toList()
        );
        fixture.persistence.runCommandTransaction(() -> service.closeCashflowMonth(
            ACTOR,
            "project-a",
            SESSION,
            explicitSettlementCycleCloseRequest(
                fixture,
                "2026-09",
                "cross-year-catch-up",
                currentTargetRevision
            )
        ));

        Map<String, Object> currentHead = fixture.documents.get(
            "orgs/tenant-a/cashflow_cumulative_close_heads/project-a"
        );
        List<Map<String, Object>> ranges = (List<Map<String, Object>>) currentHead.get("closedRanges");
        assertThat(ranges.getLast())
            .containsEntry("affectedFromMonth", "2025-12")
            .containsEntry("affectedThroughMonth", "2026-08")
            .containsEntry("closedByCycleYearMonth", "2026-09");
        assertThat(fixture.persistence.findCashflowCumulativeCloseHead("tenant-a", "project-a"))
            .isNotNull();
        fixture.documents.put(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08",
            completedSettlement("2026-08", true)
        );
        Map<String, Object> currentCycleSettlement = completedSettlement("2026-09", true);
        fixture.documents.put(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-09",
            currentCycleSettlement
        );

        CashflowMonthCloseResponse requested = fixture.persistence.runCommandTransaction(() ->
            service.requestCashflowMonthReopen(
                ACTOR,
                "project-a",
                "stage-data-project",
                explicitSettlementCycleReopenRequest(
                    fixture, "2026-09", 1, "cross-year-reopen-request",
                    "연도 경계 catch-up 승인 정정"
                )
            )
        );
        fixture.persistence.runCommandTransaction(() -> service.decideCashflowMonthReopen(
            ACTOR,
            "project-a",
            "stage-data-project",
            explicitSettlementCycleReopenDecision(
                fixture, "2026-09", requested.revision(), "cross-year-reopen-decision",
                "이전 authority로 정확히 복원"
            )
        ));

        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a"))
            .containsEntry("authorityExists", true)
            .containsEntry("closedThrough", "2025-11")
            .containsEntry("settlementMonth", "2025-12")
            .containsEntry("closedRanges", priorHead.get("closedRanges"))
            .containsEntry("revision", 3L);
        Map<String, Object> targetPeriods = (Map<String, Object>) fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08"
        ).get("periods");
        assertThat((Map<String, Object>) targetPeriods.get("MONTH"))
            .containsEntry("status", "COMPLETED");
        Map<String, Object> cyclePeriods = (Map<String, Object>) fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-09"
        ).get("periods");
        assertThat((Map<String, Object>) cyclePeriods.get("MONTH"))
            .containsEntry("status", "WAITING_FOR_UPDATE");
    }

    @Test
    @SuppressWarnings("unchecked")
    void fortyFourMonthWorstCaseReopenStaysWithinTheTransactionWriteBudget() {
        Fixture fixture = fixture(
            member(Map.of("role", "finance")),
            activeLease(),
            true,
            LocalDate.parse("2026-10-01")
        );
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a",
            "tenantId", "tenant-a",
            "executiveApproverId", "pm-1"
        ));
        WeeklyExpenseCommandService service = commandService(fixture.persistence);

        fixture.persistence.runCommandTransaction(() -> service.closeCashflowMonth(
            ACTOR,
            "project-a",
            SESSION,
            explicitSettlementCycleCloseRequest(
                fixture,
                "2026-09",
                "forty-four-month-baseline",
                "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44"
            )
        ));
        Map<String, Object> immutableSnapshot = (Map<String, Object>) fixture.documents.get(
            monthCloseVersionPath("project-a", "2026-09", 1)
        ).get("snapshot");
        assertThat(immutableSnapshot)
            .containsEntry("affectedFromMonth", "2023-01")
            .containsEntry("affectedThroughMonth", "2026-08");
        YearMonth affectedMonth = YearMonth.parse("2023-01");
        for (int offset = 0; offset < 44; offset++) {
            String yearMonth = affectedMonth.plusMonths(offset).toString();
            for (int weekNo = 1; weekNo <= 5; weekNo++) {
                fixture.documents.put(
                    "orgs/tenant-a/cashflow_weekly_update_completions/project-a-"
                        + yearMonth + "-w" + weekNo,
                    lockedWeeklyCompletion(yearMonth, weekNo, 1)
                );
            }
        }

        CashflowMonthCloseResponse requested = fixture.persistence.runCommandTransaction(() ->
            service.requestCashflowMonthReopen(
                ACTOR,
                "project-a",
                "stage-data-project",
                explicitSettlementCycleReopenRequest(
                    fixture, "2026-09", 1, "forty-four-month-reopen-request",
                    "baseline 전체 승인 정정"
                )
            )
        );
        org.mockito.Mockito.clearInvocations(fixture.transaction);
        fixture.persistence.runCommandTransaction(() -> service.decideCashflowMonthReopen(
            ACTOR,
            "project-a",
            "stage-data-project",
            explicitSettlementCycleReopenDecision(
                fixture, "2026-09", requested.revision(), "forty-four-month-reopen-decision",
                "44개월 authority 보상 복원"
            )
        ));
        long transactionWrites = org.mockito.Mockito.mockingDetails(fixture.transaction)
            .getInvocations()
            .stream()
            .filter(invocation -> Set.of("set", "create").contains(invocation.getMethod().getName()))
            .count();

        assertThat(transactionWrites).isEqualTo(491);
        assertThat(fixture.documents.get("orgs/tenant-a/cashflow_cumulative_close_heads/project-a"))
            .containsEntry("authorityExists", false)
            .containsEntry("closedRanges", List.of())
            .containsEntry("revision", 2L);
        Map<String, Object> firstPeriods = (Map<String, Object>) fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2023-01"
        ).get("periods");
        Map<String, Object> lastPeriods = (Map<String, Object>) fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08"
        ).get("periods");
        assertThat((Map<String, Object>) firstPeriods.get("WEEK_1"))
            .containsEntry("status", "WAITING_FOR_UPDATE");
        assertThat((Map<String, Object>) lastPeriods.get("WEEK_5"))
            .containsEntry("status", "WAITING_FOR_UPDATE");
        Map<String, Object> cyclePeriods = (Map<String, Object>) fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-09"
        ).get("periods");
        assertThat((Map<String, Object>) cyclePeriods.get("MONTH"))
            .containsEntry("status", "WAITING_FOR_UPDATE");
        assertThat(lastPeriods).doesNotContainKey("MONTH");
    }

    @Test
    void cumulativeApprovalRejectsAFortyFiveMonthAffectedRangeWithoutCanonicalWrites() {
        Fixture fixture = fixture(
            member(Map.of("role", "finance")),
            activeLease(),
            true,
            LocalDate.parse("2026-11-01")
        );
        CloseCashflowMonthRequest request = cumulativeCloseRequest(
            fixture,
            "2026-10",
            "forty-five-month-baseline"
        );

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() -> commandService(
            fixture.persistence
        ).closeCashflowMonth(ACTOR, "project-a", SESSION, request)))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("exceeds 44 months");
        assertThat(fixture.documents)
            .doesNotContainKeys(
                "orgs/tenant-a/cashflow_cumulative_close_heads/project-a",
                monthClosePath("project-a", "2026-10")
            );
    }

    @Test
    @SuppressWarnings("unchecked")
    void cumulativeCatchUpReopenRestoresTheExactMayAuthorityAndAtomicallyReopensItsAffectedRange() throws Exception {
        Fixture fixture = fixture(
            member(Map.of("role", "finance")),
            activeLease(),
            true,
            LocalDate.parse("2026-10-01")
        );
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a",
            "tenantId", "tenant-a",
            "executiveApproverId", "pm-1"
        ));
        WeeklyExpenseCommandService service = commandService(fixture.persistence);

        CloseCashflowMonthRequest mayApproval = explicitSettlementCycleCloseRequest(
            fixture,
            "2026-06",
            "exact-restore-may",
            "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44"
        );
        fixture.persistence.runCommandTransaction(() -> service.closeCashflowMonth(
            ACTOR, "project-a", SESSION, mayApproval
        ));
        Map<String, Object> mayHead = deepCopy(fixture.documents.get(
            "orgs/tenant-a/cashflow_cumulative_close_heads/project-a"
        ));

        String currentTargetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
            fixture.documents.entrySet().stream()
                .filter(entry -> entry.getKey().contains("/cashflow_weeks/"))
                .map(Map.Entry::getValue)
                .toList()
        );
        CloseCashflowMonthRequest augustCatchUp = explicitSettlementCycleCloseRequest(
            fixture, "2026-08", "exact-restore-august", currentTargetRevision
        );
        fixture.persistence.runCommandTransaction(() -> service.closeCashflowMonth(
            ACTOR, "project-a", SESSION, augustCatchUp
        ));

        String augustVersionPath = monthCloseVersionPath("project-a", "2026-08", 1);
        Map<String, Object> augustVersionBeforeReopen = deepCopy(fixture.documents.get(augustVersionPath));
        Map<String, Object> augustSnapshot = (Map<String, Object>) augustVersionBeforeReopen.get("snapshot");
        assertThat(augustSnapshot)
            .containsEntry("previousAuthorityExists", true)
            .containsEntry("affectedFromMonth", "2026-06")
            .containsEntry("affectedThroughMonth", "2026-07");
        assertThat((Map<String, Object>) augustSnapshot.get("preApprovalAuthority"))
            .containsEntry("closedThrough", "2026-05")
            .containsEntry("settlementMonth", "2026-06")
            .containsEntry("rootHash", mayHead.get("rootHash"));

        for (String yearMonth : List.of("2026-06", "2026-07")) {
            for (int weekNo = 1; weekNo <= 5; weekNo++) {
                fixture.documents.put(
                    "orgs/tenant-a/cashflow_weekly_update_completions/project-a-"
                        + yearMonth + "-w" + weekNo,
                    lockedWeeklyCompletion(yearMonth, weekNo, 1)
                );
            }
            fixture.documents.put(
                "orgs/tenant-a/cashflow_settlement_statuses/project-a-" + yearMonth,
                completedSettlement(yearMonth, false)
            );
        }
        Map<String, Object> julyPeriodsBeforeReopen = (Map<String, Object>) fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-07"
        ).get("periods");
        Map<String, Object> julyMonthOnly = (Map<String, Object>) completedSettlement(
            "2026-07", true
        ).get("periods");
        julyPeriodsBeforeReopen.put("MONTH", julyMonthOnly.get("MONTH"));
        Map<String, Object> augustSettlementBeforeReopen = completedSettlement("2026-08", true);
        fixture.documents.put(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08",
            augustSettlementBeforeReopen
        );

        CashflowMonthCloseResponse requested = fixture.persistence.runCommandTransaction(() ->
            service.requestCashflowMonthReopen(
                ACTOR,
                "project-a",
                "stage-data-project",
                explicitSettlementCycleReopenRequest(
                    fixture, "2026-08", 1, "exact-restore-request", "6~7월 누적 승인 정정"
                )
            )
        );
        CashflowMonthReopenCommands.DecideReopen decision = explicitSettlementCycleReopenDecision(
            fixture, "2026-08", requested.revision(), "exact-restore-decision",
            "May authority로 보상 복원"
        );
        CashflowMonthCloseResponse approved = fixture.persistence.runCommandTransaction(() ->
            service.decideCashflowMonthReopen(ACTOR, "project-a", "stage-data-project", decision)
        );
        Map<String, Map<String, Object>> afterFirstDecision = deepCopy(fixture.documents);
        CashflowMonthCloseResponse replay = fixture.persistence.runCommandTransaction(() ->
            service.decideCashflowMonthReopen(ACTOR, "project-a", "stage-data-project", decision)
        );

        assertThat(replay.status()).isEqualTo(approved.status());
        assertThat(replay.revision()).isEqualTo(approved.revision());
        assertThat(replay.reopenCount()).isEqualTo(approved.reopenCount());
        assertThat(replay.snapshotHash()).isEqualTo(approved.snapshotHash());
        assertThat(fixture.documents).isEqualTo(afterFirstDecision);
        assertThat(fixture.documents.get(augustVersionPath)).isEqualTo(augustVersionBeforeReopen);
        Map<String, Object> restoredHead = fixture.documents.get(
            "orgs/tenant-a/cashflow_cumulative_close_heads/project-a"
        );
        assertThat(restoredHead)
            .containsEntry("authorityExists", true)
            .containsEntry("closedThrough", "2026-05")
            .containsEntry("settlementMonth", "2026-06")
            .containsEntry("rootHash", mayHead.get("rootHash"))
            .containsEntry("revision", 3L)
            .containsEntry("closedRanges", mayHead.get("closedRanges"));

        for (String yearMonth : List.of("2026-06", "2026-07")) {
            for (int weekNo = 1; weekNo <= 5; weekNo++) {
                String documentId = "project-a-" + yearMonth + "-w" + weekNo;
                assertThat(fixture.documents.get(
                    "orgs/tenant-a/cashflow_weekly_update_completions/" + documentId
                )).containsEntry("status", "OPEN");
                assertThat(fixture.documents.get(
                    "orgs/tenant-a/cashflow_weekly_update_completion_versions/" + documentId + "-r2"
                ))
                    .containsEntry("complianceStatus", "REOPENED")
                    .containsEntry("approvalVersionId", "project-a-2026-08-r1");
            }
            Map<String, Object> periods = (Map<String, Object>) fixture.documents.get(
                "orgs/tenant-a/cashflow_settlement_statuses/project-a-" + yearMonth
            ).get("periods");
            for (int weekNo = 1; weekNo <= 5; weekNo++) {
                assertThat((Map<String, Object>) periods.get("WEEK_" + weekNo))
                    .containsEntry("status", "WAITING_FOR_UPDATE")
                    .doesNotContainKeys("submittedAt", "submittedBy", "approvedAt", "approvedBy");
            }
        }
        Map<String, Object> julyPeriods = (Map<String, Object>) fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-07"
        ).get("periods");
        assertThat((Map<String, Object>) julyPeriods.get("MONTH"))
            .containsEntry("status", "COMPLETED");
        Map<String, Object> augustPeriods = (Map<String, Object>) fixture.documents.get(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-08"
        ).get("periods");
        assertThat((Map<String, Object>) augustPeriods.get("MONTH"))
            .containsEntry("status", "WAITING_FOR_UPDATE")
            .doesNotContainKeys("submittedAt", "submittedBy", "approvedAt", "approvedBy");
        Map<String, Object> decisionAudit = fixture.documents.values().stream()
            .filter(document -> "exact-restore-decision".equals(document.get("idempotencyKey")))
            .filter(document -> "cashflowMonth.decideReopen".equals(document.get("commandName")))
            .filter(document -> document.containsKey("metadataJson"))
            .findFirst()
            .orElseThrow();
        Map<String, Object> decisionMetadata = new ObjectMapper().readValue(
            String.valueOf(decisionAudit.get("metadataJson")),
            Map.class
        );
        assertThat(decisionMetadata)
            .containsEntry("previousAuthorityExists", true)
            .containsEntry("affectedFromMonth", "2026-06")
            .containsEntry("affectedThroughMonth", "2026-07")
            .containsEntry("approvalVersionId", "project-a-2026-08-r1");
    }

    @Test
    @SuppressWarnings("unchecked")
    void firstCumulativeApprovalReopenKeepsAMonotonicPhysicalTombstoneForTheNextApproval() {
        Fixture fixture = fixture(
            member(Map.of("role", "finance")),
            activeLease(),
            true,
            LocalDate.parse("2026-10-01")
        );
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a",
            "tenantId", "tenant-a",
            "executiveApproverId", "pm-1"
        ));
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        CloseCashflowMonthRequest firstApproval = explicitSettlementCycleCloseRequest(
            fixture,
            "2026-08",
            "first-authority",
            "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44"
        );
        fixture.persistence.runCommandTransaction(() -> service.closeCashflowMonth(
            ACTOR, "project-a", SESSION, firstApproval
        ));
        CashflowMonthCloseResponse requested = fixture.persistence.runCommandTransaction(() ->
            service.requestCashflowMonthReopen(
                ACTOR,
                "project-a",
                "stage-data-project",
                explicitSettlementCycleReopenRequest(
                    fixture, "2026-08", 1, "first-authority-reopen", "최초 승인 회수"
                )
            )
        );
        fixture.persistence.runCommandTransaction(() -> service.decideCashflowMonthReopen(
            ACTOR,
            "project-a",
            "stage-data-project",
            explicitSettlementCycleReopenDecision(
                fixture, "2026-08", requested.revision(), "first-authority-decision",
                "최초 승인 회수 승인"
            )
        ));

        String headPath = "orgs/tenant-a/cashflow_cumulative_close_heads/project-a";
        assertThat(fixture.documents.get(headPath))
            .containsEntry("authorityExists", false)
            .containsEntry("status", "OPEN")
            .containsEntry("revision", 2L)
            .containsEntry("closedRanges", List.of())
            .doesNotContainKeys("closedThrough", "settlementMonth", "rootHash");
        assertThat(fixture.persistence.findCashflowCumulativeCloseHead("tenant-a", "project-a"))
            .isNull();

        String currentTargetRevision = FirestoreInheritedWeeklyExpensePersistence.computeCashflowTargetRevision(
            fixture.documents.entrySet().stream()
                .filter(entry -> entry.getKey().contains("/cashflow_weeks/"))
                .map(Map.Entry::getValue)
                .toList()
        );
        CloseCashflowMonthRequest nextApproval = explicitSettlementCycleCloseRequest(
            fixture, "2026-09", "after-tombstone", currentTargetRevision
        );
        fixture.persistence.runCommandTransaction(() -> service.closeCashflowMonth(
            ACTOR, "project-a", SESSION, nextApproval
        ));

        assertThat(fixture.documents.get(headPath))
            .containsEntry("authorityExists", true)
            .containsEntry("revision", 3L)
            .containsEntry("closedThrough", "2026-08");
        Map<String, Object> nextSnapshot = (Map<String, Object>) fixture.documents.get(
            monthCloseVersionPath("project-a", "2026-09", 1)
        ).get("snapshot");
        assertThat(nextSnapshot)
            .containsEntry("previousAuthorityExists", false)
            .containsEntry("preApprovalAuthority", Map.of());
    }

    @Test
    @SuppressWarnings("unchecked")
    void cumulativeAuthorityRejectsAnIncompleteClosedRangeContract() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-10-01"));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1"
        ));
        CloseCashflowMonthRequest approval = explicitSettlementCycleCloseRequest(
            fixture,
            "2026-06",
            "range-contract",
            "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44"
        );
        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .closeCashflowMonth(ACTOR, "project-a", SESSION, approval));

        String headPath = "orgs/tenant-a/cashflow_cumulative_close_heads/project-a";
        Map<String, Object> tamperedHead = deepCopy(fixture.documents.get(headPath));
        List<Map<String, Object>> ranges = new ArrayList<>((List<Map<String, Object>>) tamperedHead.get("closedRanges"));
        Map<String, Object> incomplete = new LinkedHashMap<>(ranges.getFirst());
        incomplete.remove("approvalVersionId");
        ranges.set(0, incomplete);
        tamperedHead.put("closedRanges", ranges);
        fixture.documents.put(headPath, tamperedHead);

        assertThatThrownBy(() -> fixture.persistence.findCashflowCumulativeCloseHead("tenant-a", "project-a"))
            .isInstanceOf(CashflowReadPort.InvalidCumulativeCloseAuthority.class);
    }

    @Test
    @SuppressWarnings("unchecked")
    void cumulativeReopenRevalidatesImmutableEvidenceBeforeAnyCompensatingWrite() {
        Fixture fixture = fixture(activeMember(), activeLease(), true, LocalDate.parse("2026-10-01"));
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1"
        ));
        fixture.persistence.runCommandTransaction(() -> commandService(fixture.persistence)
            .closeCashflowMonth(
                ACTOR,
                "project-a",
                SESSION,
                explicitSettlementCycleCloseRequest(
                    fixture,
                    "2026-08",
                    "tamper-evidence-close",
                    "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44"
                )
            ));
        fixture.documents.put(
            "orgs/tenant-a/cashflow_weekly_update_completions/project-a-2026-07-w1",
            lockedWeeklyCompletion("2026-07", 1, 1)
        );
        fixture.persistence.runCommandTransaction(() -> requestMonthReopen(
            fixture.persistence,
            ACTOR,
            "project-a",
            explicitSettlementCycleReopenRequest(
                fixture, "2026-08", 1, "tamper-evidence-request", "증거 변조 방어"
            )
        ));
        CashflowMonthReopenPolicy.DecisionTransition transition = fixture.persistence.runCommandTransaction(() -> {
            CashflowMonthReopenPolicy.Facts facts = fixture.persistence.findCashflowMonthReopenFacts(
                "tenant-a", "project-a", "2026-08"
            );
            return CashflowMonthReopenPolicy.decide(
                facts, "2026-08", 2, CashflowMonthReopenPolicy.Decision.APPROVE
            );
        });
        CashflowMonthReopenPort.SettlementCycleContext settlementCycle = explicitSettlementCycleContext(
            fixture, "2026-08", "tamper-evidence-decision"
        );
        Map<String, Object> canonicalRequest = fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/project-a-2026-08"
        );
        assertThat(canonicalRequest)
            .containsEntry("documentType", "REQUEST")
            .containsEntry("status", "REOPEN_REQUESTED")
            .containsEntry("tenantId", "tenant-a")
            .containsEntry("projectId", "project-a")
            .containsEntry("requestId", settlementCycle.requestId())
            .containsEntry("cycleYearMonth", settlementCycle.cycleYearMonth())
            .containsEntry("monthCloseTargetYearMonth", settlementCycle.monthCloseTargetYearMonth())
            .containsEntry("evidenceRevision", settlementCycle.evidenceRevision())
            .containsEntry("manifestHash", settlementCycle.manifestHash());

        String versionPath = monthCloseVersionPath("project-a", "2026-08", 1);
        Map<String, Object> tamperedVersion = deepCopy(fixture.documents.get(versionPath));
        Map<String, Object> tamperedSnapshot = (Map<String, Object>) tamperedVersion.get("snapshot");
        tamperedSnapshot.put("affectedThroughMonth", "2026-06");
        fixture.documents.put(versionPath, tamperedVersion);
        Map<String, Map<String, Object>> beforeDecision = deepCopy(fixture.documents);

        assertThatThrownBy(() -> fixture.persistence.runCommandTransaction(() ->
            fixture.persistence.applyCashflowMonthReopenDecision(
                reopenActor(FINANCE_ACTOR), "project-a", transition, "변조된 승인은 적용하지 않음",
                settlementCycle
            )
        ))
            .isInstanceOf(WeeklyExpenseConflictException.class)
            .hasMessageContaining("restoration evidence");
        assertThat(fixture.documents).isEqualTo(beforeDecision);
    }

    @Test
    void appliedProjectionHistoryIsExactAndIdempotentRetryDoesNotDuplicateIt() throws Exception {
        Fixture fixture = fixture(activeMember(), activeLease());
        WeeklyExpenseCommandService service = commandService(fixture.persistence);
        UpsertProjectionRequest request = new UpsertProjectionRequest("history-retry", List.of(
            new UpsertProjectionRequest.ProjectionLinePatch("2026-07", 2, "SALES_IN", BigDecimal.valueOf(1234))
        ));

        fixture.persistence.runCommandTransaction(() -> service.upsertProjection(ACTOR, "project-a", SESSION, request));
        fixture.persistence.runCommandTransaction(() -> service.upsertProjection(ACTOR, "project-a", SESSION, request));

        List<Map<String, Object>> auditDocs = fixture.documents.entrySet().stream()
            .filter(entry -> entry.getKey().contains("/weekly_api_audit_events/"))
            .map(Map.Entry::getValue)
            .toList();
        assertThat(auditDocs).hasSize(1);
        Map<String, Object> metadata = new ObjectMapper().readValue(String.valueOf(auditDocs.getFirst().get("metadataJson")), Map.class);
        assertThat(metadata).containsEntry("appliedCellChangeCount", 1);
        List<Map<String, Object>> changes = (List<Map<String, Object>>) metadata.get("appliedCellChanges");
        // The ten shared values live once on the event, not on every cell: repeating them per cell
        // pushed a full sheet apply past the 1 MB Firestore field limit and blocked the apply entirely.
        assertThat(metadata).containsKeys("actorId", "changedAt", "reason", "sourceRevision", "targetRevision",
            "requestId", "approvalId", "operationId", "auditId", "idempotencyKey");
        assertThat(changes).singleElement().satisfies(change -> {
            assertThat(change).containsEntry("yearMonth", "2026-07").containsEntry("weekNo", 2)
                .containsEntry("mode", "projection").containsEntry("cashflowLine", "SALES_IN")
                .doesNotContainKeys("actorId", "changedAt", "reason", "sourceRevision", "targetRevision",
                    "requestId", "approvalId", "operationId", "auditId", "idempotencyKey");
            assertThat((Map<String, Object>) change.get("before")).containsEntry("cellState", "EMPTY").containsEntry("amount", null);
            assertThat((Map<String, Object>) change.get("after")).containsEntry("cellState", "VALUE").containsEntry("amount", 1234);
        });
    }

    private static CloseCashflowMonthRequest cumulativeCloseRequest(Fixture fixture, String yearMonth, String requestId) {
        return cumulativeCloseRequest(fixture, yearMonth, requestId, false);
    }

    private static CloseCashflowMonthRequest explicitSettlementCycleCloseRequest(
        Fixture fixture,
        String cycleYearMonth,
        String idempotencyKey,
        String targetRevision
    ) {
        String requestId = "project-a-" + cycleYearMonth;
        CloseCashflowMonthRequest evidence = cumulativeCloseRequest(
            fixture, cycleYearMonth, requestId, false, 1, targetRevision
        );
        String requestPath = "orgs/tenant-a/cashflow_month_close_requests/" + requestId;
        Map<String, Object> request = new LinkedHashMap<>(fixture.documents.get(requestPath));
        String targetYearMonth = YearMonth.parse(cycleYearMonth).minusMonths(1).toString();
        String coordinatorPath = "orgs/tenant-a/cashflow_month_close_requests/__active__-project-a";
        Map<String, Object> currentCoordinator = fixture.documents.get(coordinatorPath);
        long currentWorkflowRevision = currentCoordinator == null
            ? 0
            : ((Number) currentCoordinator.get("workflowRevision")).longValue();
        long pendingWorkflowRevision = Math.addExact(currentWorkflowRevision, 1);

        request.put("documentType", "REQUEST");
        request.put("tenantId", "tenant-a");
        request.put("yearMonth", cycleYearMonth);
        request.put("cycleYearMonth", cycleYearMonth);
        request.put("monthCloseTargetYearMonth", targetYearMonth);
        request.put("status", "PENDING_APPROVAL");
        request.put("evidenceRevision", evidence.requestRevision());
        request.put("workflowRevision", pendingWorkflowRevision);
        request.put("requestedByUid", "pm-1");
        fixture.documents.put(requestPath, request);
        fixture.documents.put(coordinatorPath, new LinkedHashMap<>(Map.of(
            "documentType", "ACTIVE_COORDINATOR",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "activeCycleYearMonth", cycleYearMonth,
            "activeRequestId", requestId,
            "activeState", "PENDING_APPROVAL",
            "workflowRevision", pendingWorkflowRevision,
            "updatedAt", NOW.toString()
        )));
        fixture.documents.put(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-" + cycleYearMonth,
            new LinkedHashMap<>(Map.of(
                "tenantId", "tenant-a",
                "projectId", "project-a",
                "yearMonth", cycleYearMonth,
                "periods", Map.of("MONTH", Map.of(
                    "status", "SUBMITTED",
                    "revision", 1L,
                    "submittedAt", NOW.minusSeconds(60).toString(),
                    "submittedBy", "pm-1",
                    "approvedAt", "",
                    "approvedBy", ""
                )),
                "updatedAt", NOW.toString()
            ))
        );
        return new CloseCashflowMonthRequest(
            idempotencyKey, "", "", cycleYearMonth, 0, 0, true,
            List.of(), List.of(), List.of(), List.of(), List.of(), null, null,
            requestId, evidence.requestRevision(), evidence.manifestHash(),
            cycleYearMonth, targetYearMonth, pendingWorkflowRevision, "조직장 확인 완료"
        );
    }

    private static CashflowMonthReopenCommands.RequestReopen explicitSettlementCycleReopenRequest(
        Fixture fixture,
        String cycleYearMonth,
        long expectedRevision,
        String idempotencyKey,
        String reason
    ) {
        Map<String, Object> request = fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/project-a-" + cycleYearMonth
        );
        Map<String, Object> coordinator = fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/__active__-project-a"
        );
        return new CashflowMonthReopenCommands.RequestReopen(
            idempotencyKey,
            cycleYearMonth,
            expectedRevision,
            reason,
            "project-a-" + cycleYearMonth,
            cycleYearMonth,
            YearMonth.parse(cycleYearMonth).minusMonths(1).toString(),
            ((Number) request.get("evidenceRevision")).longValue(),
            String.valueOf(request.get("manifestHash")),
            ((Number) coordinator.get("workflowRevision")).longValue()
        );
    }

    private static CashflowMonthReopenCommands.DecideReopen explicitSettlementCycleReopenDecision(
        Fixture fixture,
        String cycleYearMonth,
        long expectedRevision,
        String idempotencyKey,
        String reason
    ) {
        Map<String, Object> request = fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/project-a-" + cycleYearMonth
        );
        Map<String, Object> coordinator = fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/__active__-project-a"
        );
        return new CashflowMonthReopenCommands.DecideReopen(
            idempotencyKey,
            cycleYearMonth,
            expectedRevision,
            "APPROVE",
            reason,
            "project-a-" + cycleYearMonth,
            cycleYearMonth,
            YearMonth.parse(cycleYearMonth).minusMonths(1).toString(),
            ((Number) request.get("evidenceRevision")).longValue(),
            String.valueOf(request.get("manifestHash")),
            ((Number) coordinator.get("workflowRevision")).longValue()
        );
    }

    private static CashflowMonthReopenPort.SettlementCycleContext explicitSettlementCycleContext(
        Fixture fixture,
        String cycleYearMonth,
        String commandId
    ) {
        Map<String, Object> request = fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/project-a-" + cycleYearMonth
        );
        Map<String, Object> coordinator = fixture.documents.get(
            "orgs/tenant-a/cashflow_month_close_requests/__active__-project-a"
        );
        return new CashflowMonthReopenPort.SettlementCycleContext(
            commandId,
            "project-a-" + cycleYearMonth,
            cycleYearMonth,
            YearMonth.parse(cycleYearMonth).minusMonths(1).toString(),
            ((Number) request.get("evidenceRevision")).longValue(),
            String.valueOf(request.get("manifestHash")),
            ((Number) coordinator.get("workflowRevision")).longValue()
        );
    }

    private static SubmitCashflowSettlementCycleRequest stagedSettlementCycle(
        Fixture fixture,
        String cycleYearMonth,
        String stageId,
        String idempotencyKey,
        long expectedWorkflowRevision
    ) {
        return stagedSettlementCycle(
            fixture, cycleYearMonth, stageId, idempotencyKey, expectedWorkflowRevision,
            1,
            "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44"
        );
    }

    private static SubmitCashflowSettlementCycleRequest stagedSettlementCycle(
        Fixture fixture,
        String cycleYearMonth,
        String stageId,
        String idempotencyKey,
        long expectedWorkflowRevision,
        String targetRevision
    ) {
        return stagedSettlementCycle(
            fixture, cycleYearMonth, stageId, idempotencyKey, expectedWorkflowRevision, 1, targetRevision
        );
    }

    private static SubmitCashflowSettlementCycleRequest stagedSettlementCycle(
        Fixture fixture,
        String cycleYearMonth,
        String stageId,
        String idempotencyKey,
        long expectedWorkflowRevision,
        int evidenceRevision,
        String targetRevision
    ) {
        String requestId = "project-a-" + cycleYearMonth;
        String requestPath = "orgs/tenant-a/cashflow_month_close_requests/" + requestId;
        Map<String, Object> previousRequest = fixture.documents.containsKey(requestPath)
            ? deepCopy(fixture.documents.get(requestPath)) : null;
        CloseCashflowMonthRequest close = cumulativeCloseRequest(
            fixture, cycleYearMonth, requestId, false, evidenceRevision, targetRevision
        );
        Map<String, Object> stage = new LinkedHashMap<>(fixture.documents.remove(requestPath));
        if (previousRequest != null) fixture.documents.put(requestPath, previousRequest);
        stage.put("documentType", "EVIDENCE_STAGE");
        stage.put("tenantId", "tenant-a");
        stage.put("stageId", stageId);
        stage.put("status", "STAGED");
        stage.put("cycleYearMonth", cycleYearMonth);
        stage.put("evidenceRevision", close.requestRevision());
        stage.put("expectedWorkflowRevision", expectedWorkflowRevision);
        stage.put("expectedProjectVersion", 3L);
        stage.put("requestedByUid", "pm-1");
        stage.put("createIdempotencyKey", idempotencyKey);
        fixture.documents.put(requestPath + "/stages/" + stageId, stage);
        return new SubmitCashflowSettlementCycleRequest(
            idempotencyKey,
            cycleYearMonth,
            YearMonth.parse(cycleYearMonth).minusMonths(1).toString(),
            requestId,
            stageId,
            close.requestRevision(),
            close.manifestHash(),
            expectedWorkflowRevision,
            "pm-1",
            3
        );
    }

    private static CloseCashflowMonthRequest settlementCycleApproval(
        SubmitCashflowSettlementCycleRequest submit,
        String idempotencyKey,
        long expectedWorkflowRevision
    ) {
        return new CloseCashflowMonthRequest(
            idempotencyKey, "", "", submit.cycleYearMonth(), 0, 0, true,
            List.of(), List.of(), List.of(), List.of(), List.of(), null, null,
            submit.requestId(), submit.evidenceRevision(), submit.manifestHash(),
            submit.cycleYearMonth(), submit.monthCloseTargetYearMonth(),
            expectedWorkflowRevision, "조직장 확인 완료"
        );
    }

    private static CloseCashflowMonthRequest cumulativeCloseRequest(
        Fixture fixture,
        String yearMonth,
        String requestId,
        boolean legacy
    ) {
        return cumulativeCloseRequest(fixture, yearMonth, requestId, legacy, 1);
    }

    private static CloseCashflowMonthRequest cumulativeCloseRequest(
        Fixture fixture,
        String yearMonth,
        String requestId,
        boolean legacy,
        int revision
    ) {
        return cumulativeCloseRequest(
            fixture,
            yearMonth,
            requestId,
            legacy,
            revision,
            "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44"
        );
    }

    private static CloseCashflowMonthRequest cumulativeCloseRequest(
        Fixture fixture,
        String yearMonth,
        String requestId,
        boolean legacy,
        int revision,
        String targetRevision
    ) {
        List<String> lines = List.of(
            "MYSC_PREPAY_IN", "MYSC_PREPAY_LABOR_IN", "MYSC_PREPAY_INPUT_VAT_IN", "SALES_IN",
            "SALES_VAT_IN", "TEAM_SUPPORT_IN", "BANK_INTEREST_IN", "MYSC_PREPAY_DIRECT_OUT",
            "MYSC_PREPAY_LABOR_OUT", "DIRECT_COST_OUT", "INPUT_VAT_OUT", "MYSC_LABOR_OUT",
            "MYSC_PROFIT_OUT", "SALES_VAT_OUT", "TEAM_SUPPORT_OUT", "BANK_INTEREST_OUT"
        );
        List<Map<String, Object>> manifestMonths = new ArrayList<>();
        java.time.YearMonth target = java.time.YearMonth.parse(yearMonth).minusMonths(legacy ? 0 : 1);
        long count = java.time.temporal.ChronoUnit.MONTHS.between(java.time.YearMonth.of(2023, 1), target) + 1;
        for (long offset = 0; offset < count; offset++) {
            String month = java.time.YearMonth.of(2023, 1).plusMonths(offset).toString();
            List<Map<String, Object>> cells = new ArrayList<>();
            for (String mode : List.of("projection", "actual")) {
                for (int weekNo = 1; weekNo <= 5; weekNo++) {
                    for (String line : lines) {
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
            Map<String, Object> source = Map.of(
                "sourceRevision", SOURCE_REVISION,
                "targetRevision", targetRevision
            );
            Map<String, Object> hashInput = new LinkedHashMap<>();
            hashInput.put("contractVersion", "cashflow-cumulative-close-v2");
            hashInput.put("requestId", requestId);
            hashInput.put("requestRevision", (long) revision);
            hashInput.put("projectId", "project-a");
            hashInput.put("yearMonth", month);
            hashInput.put("cells", cells);
            hashInput.put("source", source);
            String shardHash = fixture.persistence.hashCanonicalJson(hashInput);
            Map<String, Object> shard = new LinkedHashMap<>(hashInput);
            shard.put("shardHash", shardHash);
            fixture.documents.put(
                "orgs/tenant-a/cashflow_month_close_request_months/" + requestId + "-r" + revision + "-" + month,
                shard
            );
            manifestMonths.add(Map.of("yearMonth", month, "shardHash", shardHash));
        }
        Map<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("contractVersion", "cashflow-cumulative-close-v2");
        manifest.put("requestId", requestId);
        manifest.put("requestRevision", (long) revision);
        manifest.put("projectId", "project-a");
        manifest.put("fromMonth", "2023-01");
        manifest.put("yearMonth", yearMonth);
        manifest.put("months", manifestMonths);
        String manifestHash = fixture.persistence.hashCanonicalJson(manifest);
        Map<String, Object> header = new LinkedHashMap<>(Map.ofEntries(
            Map.entry("contractVersion", "cashflow-cumulative-close-v2"),
            Map.entry("requestId", requestId),
            Map.entry("projectId", "project-a"),
            Map.entry("yearMonth", yearMonth),
            Map.entry("fromMonth", "2023-01"),
            Map.entry("status", "APPROVING"),
            Map.entry("revision", (long) revision),
            Map.entry("manifestHash", manifestHash),
            Map.entry("monthCount", count),
            Map.entry("approverUid", "pm-1"),
            Map.entry("reviewIdempotencyKey", "idem-" + requestId),
            Map.entry("approvalId", "approval-" + requestId),
            Map.entry("operationId", "operation-" + requestId)
        ));
        if (!legacy) header.put("throughMonth", target.toString());
        fixture.documents.put("orgs/tenant-a/cashflow_month_close_requests/" + requestId, header);
        return new CloseCashflowMonthRequest(
            "idem-" + requestId, "", "", yearMonth, 0, 0, false,
            List.of(), List.of(), List.of(), List.of(), List.of(), null, null,
            requestId, revision, manifestHash
        );
    }

    private static void putCompleteProjectionWindow(Fixture fixture, String yearMonth, int weekNo) {
        java.time.YearMonth month = java.time.YearMonth.parse(yearMonth);
        int week = weekNo;
        for (int index = 0; index < 16; index++) {
            String path = "orgs/tenant-a/cashflow_weeks/project-a-" + month + "-w" + week;
            Map<String, Object> document = new LinkedHashMap<>(fixture.documents.getOrDefault(path, Map.of()));
            Map<String, Object> projection = new LinkedHashMap<>((Map<String, Object>) document.getOrDefault("projection", Map.of()));
            for (String line : List.of(
                "MYSC_PREPAY_IN", "MYSC_PREPAY_LABOR_IN", "MYSC_PREPAY_INPUT_VAT_IN", "SALES_IN",
                "SALES_VAT_IN", "TEAM_SUPPORT_IN", "BANK_INTEREST_IN", "MYSC_PREPAY_DIRECT_OUT",
                "MYSC_PREPAY_LABOR_OUT", "DIRECT_COST_OUT", "INPUT_VAT_OUT", "MYSC_LABOR_OUT",
                "MYSC_PROFIT_OUT", "SALES_VAT_OUT", "TEAM_SUPPORT_OUT", "BANK_INTEREST_OUT"
            )) projection.putIfAbsent(line, 0L);
            document.put("id", "project-a-" + month + "-w" + week);
            document.put("tenantId", "tenant-a");
            document.put("projectId", "project-a");
            document.put("yearMonth", month.toString());
            document.put("weekNo", week);
            document.put("projection", projection);
            fixture.documents.put(path, document);
            if (++week > 5) {
                week = 1;
                month = month.plusMonths(1);
            }
        }
    }

    private static List<CashflowAnnualCellSet.Cell> annualCellsWithProjection(
        String lineId,
        BigDecimal amount
    ) {
        return annualCells().stream()
            .map(cell -> "projection".equals(cell.mode()) && lineId.equals(cell.cashflowLine())
                ? new CashflowAnnualCellSet.Cell(
                    cell.mode(), cell.cashflowLine(), "VALUE", amount, "A1", cell.sourceLabel()
                )
                : cell)
            .toList();
    }

    private static CashflowOpeningBalancesResponse openingBalanceForProjection(
        int selectedYear,
        int sourceYear,
        String lineId,
        BigDecimal amount
    ) {
        Map<String, BigDecimal> rows = Map.of(lineId, amount);
        Map<String, String> states = new LinkedHashMap<>();
        for (String canonicalLine : CashflowLineCatalog.ALL_LINES) {
            states.put(canonicalLine, canonicalLine.equals(lineId) ? "VALUE" : "EMPTY");
        }
        CashflowOpeningBalancesResponse.YearSource source = new CashflowOpeningBalancesResponse.YearSource(
            sourceYear,
            rows,
            states
        );
        return new CashflowOpeningBalancesResponse(
            selectedYear,
            new CashflowOpeningBalancesResponse.Mode(
                amount,
                rows,
                List.of(source),
                List.of(sourceYear),
                List.of()
            ),
            new CashflowOpeningBalancesResponse.Mode(BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of())
        );
    }

    private static CashflowSheetLabApplyRequest monthlyRequest(
        String idempotencyKey,
        String targetRevision,
        String yearMonth,
        String emptyCellKey
    ) {
        List<CashflowSheetLabApplyRequest.Cell> cells = new ArrayList<>();
        for (int weekNo = 1; weekNo <= 5; weekNo += 1) {
            for (String mode : List.of("projection", "actual")) {
                for (String lineId : CashflowLineCatalog.ALL_LINES.stream().sorted(Comparator.naturalOrder()).toList()) {
                    boolean empty = weekNo == 1 && (mode + ":" + lineId).equals(emptyCellKey);
                    cells.add(new CashflowSheetLabApplyRequest.Cell(
                        mode,
                        weekNo,
                        lineId,
                        empty ? "EMPTY" : "VALUE",
                        empty ? null : BigDecimal.valueOf(100),
                        "D" + weekNo,
                        lineId
                    ));
                }
            }
        }
        return new CashflowSheetLabApplyRequest(
            idempotencyKey,
            SOURCE_REVISION,
            targetRevision,
            yearMonth,
            false,
            null,
            null,
            List.of(),
            completeCalculationChecks(yearMonth),
            cells
        );
    }

    private static CashflowPendingApprovalAffectedMonth pendingApprovalInstruction(
        String yearMonth,
        String requestId,
        int count
    ) {
        List<CashflowPendingApprovalAffectedMonth.Change> changes = new ArrayList<>();
        outer:
        for (String mode : List.of("projection", "actual")) {
            for (int weekNo = 1; weekNo <= 5; weekNo += 1) {
                for (String lineId : CashflowLineCatalog.ALL_LINES) {
                    changes.add(new CashflowPendingApprovalAffectedMonth.Change(
                        mode, weekNo, lineId, false, "EMPTY", null, true, "VALUE", BigDecimal.valueOf(100)
                    ));
                    if (changes.size() == count) break outer;
                }
            }
        }
        List<Integer> weeks = changes.stream().map(CashflowPendingApprovalAffectedMonth.Change::weekNo)
            .distinct().toList();
        CashflowPendingApprovalAffectedMonth.ApprovalDifference difference =
            new CashflowPendingApprovalAffectedMonth.ApprovalDifference(
                requestId, 1, "APPROVING", "sha256:" + "f".repeat(64), yearMonth,
                count, weeks, changes, 0
            );
        return new CashflowPendingApprovalAffectedMonth(yearMonth, 1, count, List.of(difference));
    }

    private static List<CashflowOpeningBalanceCell> openingBalanceCells() {
        List<CashflowOpeningBalanceCell> cells = new ArrayList<>();
        for (int year : List.of(2024, 2025)) {
            for (String mode : List.of("projection", "actual")) {
                for (String lineId : CashflowLineCatalog.ALL_LINES) {
                    boolean opening = year == 2025 && mode.equals("projection") && lineId.equals("SALES_IN");
                    cells.add(new CashflowOpeningBalanceCell(
                        year,
                        mode,
                        lineId,
                        opening ? "VALUE" : "EMPTY",
                        opening ? BigDecimal.valueOf(2_000_000) : null
                    ));
                }
            }
        }
        return List.copyOf(cells);
    }

    private static List<Map<String, Object>> completeCalculationChecks(String yearMonth) {
        List<Map<String, Object>> checks = new ArrayList<>();
        for (String mode : List.of("projection", "actual")) {
            for (int weekNo = 1; weekNo <= 5; weekNo += 1) {
                checks.add(Map.of(
                    "mode", mode,
                    "yearMonth", yearMonth,
                    "weekNo", weekNo,
                    "reported", Map.of(
                        "openingBalance", 0L,
                        "depositTotal", 800L,
                        "withdrawalTotal", 800L,
                        "balance", 0L
                    )
                ));
            }
        }
        return List.copyOf(checks);
    }

    private static Fixture fixture(Map<String, Object> member, Map<String, Object> lease) {
        return fixture(member, lease, true);
    }

    private static Fixture fixture(Map<String, Object> member, Map<String, Object> lease, boolean projectExists) {
        return fixture(member, lease, projectExists, null);
    }

    @SuppressWarnings("unchecked")
    private static Fixture fixture(
        Map<String, Object> member,
        Map<String, Object> lease,
        boolean projectExists,
        LocalDate businessDate
    ) {
        return fixture(member, lease, projectExists, businessDate, NOW);
    }

    @SuppressWarnings("unchecked")
    private static Fixture fixture(
        Map<String, Object> member,
        Map<String, Object> lease,
        boolean projectExists,
        LocalDate businessDate,
        Instant now
    ) {
        Firestore db = mock(Firestore.class);
        Transaction transaction = mock(Transaction.class);
        Map<String, DocumentReference> refs = new HashMap<>();
        Map<String, CollectionReference> collections = new HashMap<>();
        Map<Query, QueryScope> queryScopes = new HashMap<>();
        Map<String, Map<String, Object>> docs = new HashMap<>();
        List<PendingWrite> pendingWrites = new ArrayList<>();
        List<Integer> getAllSizes = new ArrayList<>();
        List<Integer> queryReadSizes = new ArrayList<>();
        docs.put("orgs/tenant-a/members/pm-1", member);
        docs.put("orgs/tenant-a/persons/person-pm-1", Map.of("uid", "pm-1"));
        docs.put(leasePath("project-a"), lease);
        docs.put("orgs/tenant-a/cashflow_sheet_mirrors/project-a", Map.of(
            "projectId", "project-a", "weeklyYear", 2026
        ));
        for (String yearMonth : List.of("2026-06", "2026-07")) {
            docs.put("orgs/tenant-a/cashflow_month_close_requests/project-a-" + yearMonth, Map.of(
                "requestId", "project-a-" + yearMonth,
                "projectId", "project-a",
                "yearMonth", yearMonth,
                "status", "APPROVING",
                "approverUid", "pm-1",
                "reviewedByUid", "pm-1",
                "monthSnapshot", Map.of(
                    "schemaVersion", 1,
                    "projectId", "project-a",
                    "yearMonth", yearMonth,
                    "source", Map.of(
                        "sourceRevision", SOURCE_REVISION,
                        "targetRevision", "sha256:298012959db83e193536ff7f60735889252ceaa4325de6944465e2dd197fcb44",
                        "capturedAt", NOW.minusSeconds(120).toString()
                    )
                )
            ));
        }
        if (projectExists) {
            docs.put("orgs/tenant-a/projects/project-a", Map.of(
                "id", "project-a",
                "tenantId", "tenant-a"
            ));
        }

        when(db.document(anyString())).thenAnswer(invocation -> {
            DocumentReference document = ref(refs, invocation.getArgument(0));
            org.mockito.Mockito.doAnswer(ignored -> {
                Map<String, Object> data = docs.get(document.getPath());
                DocumentSnapshot snapshot = mock(DocumentSnapshot.class);
                when(snapshot.exists()).thenReturn(data != null);
                when(snapshot.getData()).thenReturn(data);
                when(snapshot.getReference()).thenReturn(document);
                return ApiFutures.immediateFuture(snapshot);
            }).when(document).get();
            return document;
        });
        when(db.collection(anyString())).thenAnswer(invocation -> collection(
            collections,
            refs,
            queryScopes,
            docs,
            queryReadSizes,
            invocation.getArgument(0)
        ));
        when(transaction.get(any(DocumentReference.class))).thenAnswer(invocation -> {
            DocumentReference document = invocation.getArgument(0);
            Map<String, Object> data = docs.get(document.getPath());
            DocumentSnapshot snapshot = mock(DocumentSnapshot.class);
            when(snapshot.exists()).thenReturn(data != null);
            when(snapshot.getData()).thenReturn(data);
            when(snapshot.getReference()).thenReturn(document);
            return ApiFutures.immediateFuture(snapshot);
        });
        when(transaction.getAll(any(DocumentReference[].class))).thenAnswer(invocation -> {
            Object[] arguments = invocation.getArguments();
            DocumentReference[] documents = arguments.length == 1 && arguments[0] instanceof DocumentReference[] refsArgument
                ? refsArgument
                : java.util.Arrays.stream(arguments)
                .map(DocumentReference.class::cast)
                .toArray(DocumentReference[]::new);
            getAllSizes.add(documents.length);
            List<DocumentSnapshot> snapshots = java.util.Arrays.stream(documents).map(document -> {
                Map<String, Object> data = docs.get(document.getPath());
                String documentId = document.getId();
                DocumentSnapshot snapshot = mock(DocumentSnapshot.class);
                when(snapshot.exists()).thenReturn(data != null);
                when(snapshot.getData()).thenReturn(data);
                when(snapshot.getReference()).thenReturn(document);
                when(snapshot.getId()).thenReturn(documentId);
                return snapshot;
            }).toList();
            return ApiFutures.immediateFuture(snapshots);
        });
        when(db.getAll(any(DocumentReference[].class))).thenAnswer(invocation -> {
            Object[] arguments = invocation.getArguments();
            DocumentReference[] documents = arguments.length == 1 && arguments[0] instanceof DocumentReference[] refsArgument
                ? refsArgument
                : java.util.Arrays.stream(arguments).map(DocumentReference.class::cast).toArray(DocumentReference[]::new);
            return transaction.getAll(documents);
        });
        when(transaction.get(any(Query.class))).thenAnswer(invocation -> {
            QueryScope scope = queryScopes.get(invocation.getArgument(0));
            List<QueryDocumentSnapshot> snapshots = docs.entrySet().stream()
                .filter(entry -> scope != null && entry.getKey().startsWith(scope.collectionPath + "/"))
                .filter(entry -> scope != null && scope.matches(entry.getValue()))
                .map(entry -> queryDocumentSnapshot(refs, entry.getKey(), scope.project(entry.getValue())))
                .toList();
            QuerySnapshot querySnapshot = mock(QuerySnapshot.class);
            when(querySnapshot.getDocuments()).thenReturn(snapshots);
            queryReadSizes.add(snapshots.size());
            return ApiFutures.immediateFuture(querySnapshot);
        });
        when(transaction.set(any(DocumentReference.class), any(), any())).thenAnswer(invocation -> {
            pendingWrites.add(new PendingWrite(
                invocation.getArgument(0),
                new LinkedHashMap<>((Map<String, Object>) invocation.getArgument(1)),
                true
            ));
            return transaction;
        });
        when(transaction.set(any(DocumentReference.class), any())).thenAnswer(invocation -> {
            pendingWrites.add(new PendingWrite(
                invocation.getArgument(0),
                new LinkedHashMap<>((Map<String, Object>) invocation.getArgument(1)),
                false
            ));
            return transaction;
        });
        when(transaction.create(any(DocumentReference.class), any())).thenAnswer(invocation -> {
            pendingWrites.add(new PendingWrite(
                invocation.getArgument(0),
                new LinkedHashMap<>((Map<String, Object>) invocation.getArgument(1)),
                false
            ));
            return transaction;
        });
        when(db.runTransaction(any())).thenAnswer(invocation -> {
            Transaction.Function<?> function = invocation.getArgument(0);
            pendingWrites.clear();
            try {
                Object result = function.updateCallback(transaction);
                for (PendingWrite write : pendingWrites) {
                    Map<String, Object> document = write.merge()
                        ? new LinkedHashMap<>(docs.getOrDefault(write.ref().getPath(), Map.of()))
                        : new LinkedHashMap<>();
                    document.putAll(write.data());
                    docs.put(write.ref().getPath(), document);
                }
                pendingWrites.clear();
                return ApiFutures.immediateFuture(result);
            } catch (Throwable error) {
                pendingWrites.clear();
                return ApiFutures.immediateFailedFuture(error);
            }
        });
        when(db.runTransaction(any(), any(TransactionOptions.class))).thenAnswer(invocation -> {
            Transaction.Function<?> function = invocation.getArgument(0);
            pendingWrites.clear();
            try {
                Object result = function.updateCallback(transaction);
                if (!pendingWrites.isEmpty()) {
                    throw new IllegalStateException("Read-only transaction attempted to write.");
                }
                return ApiFutures.immediateFuture(result);
            } catch (Throwable error) {
                pendingWrites.clear();
                return ApiFutures.immediateFailedFuture(error);
            }
        });

        Instant effectiveNow = businessDate == null
            ? now
            : businessDate.atStartOfDay(ZoneOffset.ofHours(9)).toInstant();
        FirestoreInheritedWeeklyExpensePersistence persistence = new FirestoreInheritedWeeklyExpensePersistence(
            db,
            "stage-data-project",
            Clock.fixed(effectiveNow, ZoneOffset.UTC)
        );
        return new Fixture(persistence, db, transaction, refs, collections, docs, pendingWrites, getAllSizes, queryReadSizes);
    }

    private static DocumentReference ref(Map<String, DocumentReference> refs, String path) {
        return refs.computeIfAbsent(path, key -> {
            DocumentReference document = mock(DocumentReference.class);
            when(document.getPath()).thenReturn(key);
            when(document.getId()).thenReturn(key.substring(key.lastIndexOf('/') + 1));
            return document;
        });
    }

    private static CollectionReference collection(
        Map<String, CollectionReference> collections,
        Map<String, DocumentReference> refs,
        Map<Query, QueryScope> queryScopes,
        Map<String, Map<String, Object>> docs,
        List<Integer> queryReadSizes,
        String path
    ) {
        return collections.computeIfAbsent(path, key -> {
            CollectionReference collection = mock(CollectionReference.class);
            when(collection.document(anyString())).thenAnswer(invocation -> ref(refs, key + "/" + invocation.getArgument(0)));
            when(collection.document()).thenAnswer(invocation -> ref(refs, key + "/generated-audit-id"));
            when(collection.whereEqualTo(anyString(), any())).thenAnswer(invocation -> {
                Query query = mock(Query.class);
                QueryScope scope = new QueryScope(key, invocation.getArgument(0), invocation.getArgument(1));
                queryScopes.put(query, scope);
                when(query.whereEqualTo(anyString(), any())).thenAnswer(filter -> {
                    scope.equals.put(filter.getArgument(0), filter.getArgument(1));
                    return query;
                });
                when(query.whereIn(anyString(), anyList())).thenAnswer(filter -> {
                    scope.in.put(filter.getArgument(0), List.copyOf(filter.getArgument(1)));
                    return query;
                });
                when(query.select(any(String[].class))).thenAnswer(selection -> {
                    scope.selected = java.util.Arrays.stream(selection.getArguments())
                        .map(String.class::cast)
                        .toList();
                    return query;
                });
                when(query.whereGreaterThanOrEqualTo(anyString(), any())).thenReturn(query);
                when(query.whereLessThanOrEqualTo(anyString(), any())).thenReturn(query);
                when(query.limit(org.mockito.ArgumentMatchers.anyInt())).thenReturn(query);
                org.mockito.Mockito.doAnswer(ignored -> {
                    List<QueryDocumentSnapshot> snapshots = docs.entrySet().stream()
                        .filter(entry -> entry.getKey().startsWith(scope.collectionPath + "/"))
                        .filter(entry -> scope.matches(entry.getValue()))
                        .map(entry -> queryDocumentSnapshot(refs, entry.getKey(), scope.project(entry.getValue())))
                        .toList();
                    QuerySnapshot querySnapshot = mock(QuerySnapshot.class);
                    when(querySnapshot.getDocuments()).thenReturn(snapshots);
                    queryReadSizes.add(snapshots.size());
                    return ApiFutures.immediateFuture(querySnapshot);
                }).when(query).get();
                return query;
            });
            when(collection.whereIn(anyString(), anyList())).thenAnswer(invocation -> {
                Query query = mock(Query.class);
                QueryScope scope = new QueryScope(key, "", "");
                scope.in.put(invocation.getArgument(0), List.copyOf(invocation.getArgument(1)));
                queryScopes.put(query, scope);
                when(query.whereEqualTo(anyString(), any())).thenAnswer(filter -> {
                    scope.equals.put(filter.getArgument(0), filter.getArgument(1));
                    return query;
                });
                when(query.whereIn(anyString(), anyList())).thenAnswer(filter -> {
                    scope.in.put(filter.getArgument(0), List.copyOf(filter.getArgument(1)));
                    return query;
                });
                when(query.whereGreaterThanOrEqualTo(anyString(), any())).thenReturn(query);
                when(query.whereLessThanOrEqualTo(anyString(), any())).thenReturn(query);
                when(query.limit(org.mockito.ArgumentMatchers.anyInt())).thenReturn(query);
                org.mockito.Mockito.doAnswer(ignored -> {
                    List<QueryDocumentSnapshot> snapshots = docs.entrySet().stream()
                        .filter(entry -> entry.getKey().startsWith(scope.collectionPath + "/"))
                        .filter(entry -> scope.matches(entry.getValue()))
                        .map(entry -> queryDocumentSnapshot(refs, entry.getKey(), scope.project(entry.getValue())))
                        .toList();
                    QuerySnapshot querySnapshot = mock(QuerySnapshot.class);
                    when(querySnapshot.getDocuments()).thenReturn(snapshots);
                    queryReadSizes.add(snapshots.size());
                    return ApiFutures.immediateFuture(querySnapshot);
                }).when(query).get();
                return query;
            });
            return collection;
        });
    }

    private static DocumentSnapshot snapshot(
        Map<String, DocumentReference> refs,
        String path,
        Map<String, Object> data
    ) {
        DocumentReference reference = ref(refs, path);
        DocumentSnapshot snapshot = mock(DocumentSnapshot.class);
        when(snapshot.exists()).thenReturn(data != null);
        when(snapshot.getData()).thenReturn(data);
        when(snapshot.getReference()).thenReturn(reference);
        when(snapshot.getId()).thenReturn(path.substring(path.lastIndexOf('/') + 1));
        return snapshot;
    }

    private static QueryDocumentSnapshot queryDocumentSnapshot(
        Map<String, DocumentReference> refs,
        String path,
        Map<String, Object> data
    ) {
        DocumentReference reference = ref(refs, path);
        QueryDocumentSnapshot snapshot = mock(QueryDocumentSnapshot.class);
        when(snapshot.exists()).thenReturn(true);
        when(snapshot.getData()).thenReturn(data);
        when(snapshot.getReference()).thenReturn(reference);
        when(snapshot.getId()).thenReturn(path.substring(path.lastIndexOf('/') + 1));
        return snapshot;
    }

    private static WeeklyExpenseCommandService commandService(WeeklyExpensePersistence persistence) {
        WeeklyExpenseAuthorizationService authorization = new WeeklyExpenseAuthorizationService(
            (actor, projectId) -> true,
            new WeeklyProjectExistenceRepository() {
                @Override
                public boolean exists(String tenantId, String projectId) {
                    return true;
                }

                @Override
                public boolean existsCanonicalProject(String tenantId, String projectId) {
                    return true;
                }
            },
            "strict"
        );
        return new WeeklyExpenseCommandService(
            persistence,
            authorization,
            new ObjectMapper(),
            true,
            "live"
        );
    }

    private static CashflowMonthCloseState requestMonthReopen(
        WeeklyExpensePersistence persistence,
        TrustedActorContext actor,
        String projectId,
        CashflowMonthReopenCommands.RequestReopen request
    ) {
        CashflowMonthReopenPolicy.Facts facts = persistence.findCashflowMonthReopenFacts(
            actor.tenantId(), projectId, request.yearMonth()
        );
        return persistence.applyCashflowMonthReopenRequest(
            new CashflowMonthReopenPort.Actor(actor.tenantId(), actor.id(), actor.name()),
            projectId,
            CashflowMonthReopenPolicy.request(facts, request.yearMonth(), request.expectedRevision()),
            request.reason(),
            new CashflowMonthReopenPort.SettlementCycleContext(
                request.idempotencyKey(), request.requestId(), request.cycleYearMonth(),
                request.monthCloseTargetYearMonth(), request.evidenceRevision(), request.manifestHash(),
                request.expectedWorkflowRevision()
            )
        );
    }

    private static CashflowMonthCloseState decideMonthReopen(
        WeeklyExpensePersistence persistence,
        TrustedActorContext actor,
        String projectId,
        CashflowMonthReopenCommands.DecideReopen request
    ) {
        CashflowMonthReopenPolicy.Facts facts = persistence.findCashflowMonthReopenFacts(
            actor.tenantId(), projectId, request.yearMonth()
        );
        CashflowMonthReopenPort.SettlementCycleContext settlementCycle =
            new CashflowMonthReopenPort.SettlementCycleContext(
                request.idempotencyKey(), request.requestId(), request.cycleYearMonth(),
                request.monthCloseTargetYearMonth(), request.evidenceRevision(), request.manifestHash(),
                request.expectedWorkflowRevision()
            );
        return persistence.applyCashflowMonthReopenDecision(
            new CashflowMonthReopenPort.Actor(actor.tenantId(), actor.id(), actor.name()),
            projectId,
            settlementCycle.present()
                ? CashflowMonthReopenPolicy.decide(
                    facts,
                    request.yearMonth(),
                    request.expectedRevision(),
                    CashflowMonthReopenPolicy.Decision.valueOf(request.decision())
                )
                : CashflowMonthReopenPolicy.decideLegacy(
                    facts,
                    request.yearMonth(),
                    request.expectedRevision(),
                    CashflowMonthReopenPolicy.Decision.valueOf(request.decision())
                ),
            request.reason(),
            settlementCycle
        );
    }

    private static Map<String, Object> activeMember() {
        return member(Map.of());
    }

    private static Map<String, Object> member(Map<String, Object> overrides) {
        Map<String, Object> value = new HashMap<>(Map.of(
            "uid", "pm-1",
            "status", "ACTIVE",
            "role", "pm",
            "projectIds", List.of("project-a")
        ));
        value.putAll(overrides);
        return value;
    }

    private static void seedVerifiedLegacyCumulativeApproval(Fixture fixture) {
        String requestId = "project-a-2026-08";
        String versionId = "project-a-2026-08-r3";
        Map<String, Object> snapshot = Map.ofEntries(
            Map.entry("schemaVersion", 2),
            Map.entry("contractVersion", "cashflow-cumulative-close-v2"),
            Map.entry("projectId", "project-a"),
            Map.entry("yearMonth", "2026-08"),
            Map.entry("requestId", requestId),
            Map.entry("requestRevision", 7L),
            Map.entry("manifestHash", SOURCE_REVISION),
            Map.entry("rootHash", SOURCE_REVISION),
            Map.entry("headRevision", 4L),
            Map.entry("approvalId", ""),
            Map.entry("operationId", "")
        );
        String snapshotHash = fixture.persistence.hashCanonicalJson(snapshot);
        fixture.documents.put("orgs/tenant-a/projects/project-a", Map.of(
            "id", "project-a", "tenantId", "tenant-a", "executiveApproverId", "pm-1"
        ));
        fixture.documents.put("orgs/tenant-a/cashflow_cumulative_close_heads/project-a", Map.ofEntries(
            Map.entry("contractVersion", "cashflow-cumulative-close-v2"),
            Map.entry("tenantId", "tenant-a"),
            Map.entry("projectId", "project-a"),
            Map.entry("status", "CLOSED"),
            Map.entry("fromMonth", "2023-01"),
            Map.entry("closedThrough", "2026-08"),
            Map.entry("settlementMonth", "2026-09"),
            Map.entry("rootHash", SOURCE_REVISION),
            Map.entry("revision", 4L),
            Map.entry("requestId", requestId),
            Map.entry("requestRevision", 7L),
            Map.entry("approvalId", ""),
            Map.entry("operationId", ""),
            Map.entry("closedAt", NOW.minusSeconds(60).toString()),
            Map.entry("closedByUid", "pm-1")
        ));
        fixture.documents.put("orgs/tenant-a/cashflow_month_close_requests/" + requestId, Map.ofEntries(
            Map.entry("contractVersion", "cashflow-cumulative-close-v2"),
            Map.entry("requestId", requestId),
            Map.entry("tenantId", "tenant-a"),
            Map.entry("projectId", "project-a"),
            Map.entry("yearMonth", "2026-08"),
            Map.entry("fromMonth", "2023-01"),
            Map.entry("status", "APPROVED"),
            Map.entry("revision", 7L),
            Map.entry("manifestHash", SOURCE_REVISION),
            Map.entry("reviewIdempotencyKey", "legacy-jvm-close"),
            Map.entry("monthCloseResult", Map.ofEntries(
                Map.entry("commandName", WeeklyExpenseCommandService.CLOSE_CASHFLOW_MONTH_COMMAND),
                Map.entry("projectId", "project-a"),
                Map.entry("yearMonth", "2026-08"),
                Map.entry("status", "CLOSED"),
                Map.entry("revision", 3L),
                Map.entry("requestId", requestId),
                Map.entry("requestRevision", 7L),
                Map.entry("manifestHash", SOURCE_REVISION),
                Map.entry("rootHash", SOURCE_REVISION),
                Map.entry("headRevision", 4L)
            ))
        ));
        fixture.documents.put(monthClosePath("project-a", "2026-08"), Map.ofEntries(
            Map.entry("contractVersion", "cashflow-month-close-v1"),
            Map.entry("tenantId", "tenant-a"),
            Map.entry("projectId", "project-a"),
            Map.entry("yearMonth", "2026-08"),
            Map.entry("status", "CLOSED"),
            Map.entry("revision", 3L),
            Map.entry("snapshotHash", snapshotHash),
            Map.entry("latestVersionId", versionId),
            Map.entry("closedAt", NOW.minusSeconds(60).toString()),
            Map.entry("closedByUid", "pm-1")
        ));
        fixture.documents.put(
            "orgs/tenant-a/cashflow_settlement_statuses/project-a-2026-09",
            completedSettlement("2026-09", true)
        );
        fixture.documents.put("orgs/tenant-a/monthly_close_versions/" + versionId, Map.ofEntries(
            Map.entry("id", versionId),
            Map.entry("contractVersion", "cashflow-month-close-v1"),
            Map.entry("schemaVersion", 1),
            Map.entry("tenantId", "tenant-a"),
            Map.entry("projectId", "project-a"),
            Map.entry("yearMonth", "2026-08"),
            Map.entry("status", "CLOSED"),
            Map.entry("revision", 3L),
            Map.entry("snapshotHash", snapshotHash),
            Map.entry("closedAt", NOW.minusSeconds(60).toString()),
            Map.entry("closedByUid", "pm-1"),
            Map.entry("snapshot", snapshot)
        ));
        fixture.documents.put(idempotencyPath(
            "tenant-a", "project-a", WeeklyExpenseCommandService.CLOSE_CASHFLOW_MONTH_COMMAND,
            "legacy-jvm-close"
        ), Map.ofEntries(
            Map.entry("tenantId", "tenant-a"),
            Map.entry("projectId", "project-a"),
            Map.entry("idempotencyKey", "legacy-jvm-close"),
            Map.entry("commandName", WeeklyExpenseCommandService.CLOSE_CASHFLOW_MONTH_COMMAND),
            Map.entry("requestHash", "sha256:legacy-request"),
            Map.entry("responseJson", "{\"ok\":true,\"commandName\":\"cashflowMonth.close\","
                + "\"projectId\":\"project-a\",\"yearMonth\":\"2026-08\",\"status\":\"CLOSED\","
                + "\"revision\":3,\"requestId\":\"project-a-2026-08\",\"requestRevision\":7,"
                + "\"manifestHash\":\"" + SOURCE_REVISION + "\",\"rootHash\":\""
                + SOURCE_REVISION + "\",\"headRevision\":4}"),
            Map.entry("createdAt", NOW.minusSeconds(60).toString())
        ));
    }

    private static CashflowMonthReopenPort.Actor reopenActor(TrustedActorContext actor) {
        return new CashflowMonthReopenPort.Actor(actor.tenantId(), actor.id(), actor.name());
    }

    private static CashflowMonthReopenPolicy.DecisionAuthority authorizeMonthReopenDecision(
        WeeklyExpensePersistence persistence,
        TrustedActorContext actor,
        String projectId
    ) {
        CashflowMonthReopenPolicy.DecisionAuthority authority =
            CashflowMonthReopenPolicy.requireDecisionAuthority(
                persistence.findCashflowMonthReopenDecisionAuthorityFacts(reopenActor(actor), projectId)
            );
        persistence.bindCashflowMonthReopenDecisionAuthority(authority);
        return authority;
    }

    private static Map<String, Object> activeLease() {
        return lease(Map.of());
    }

    private static Map<String, Object> lease(Map<String, Object> overrides) {
        Map<String, Object> value = new HashMap<>(Map.of(
            "tenantId", "tenant-a",
            "resourceType", "cashflow",
            "resourceId", "project-a",
            "holderUid", "pm-1",
            "sessionId", "session-a",
            "leaseId", "lease-a",
            "fence", 7L,
            "state", "ACTIVE",
            "expiresAt", NOW.plusSeconds(600).toString()
        ));
        value.putAll(overrides);
        return value;
    }

    private static String leasePath(String projectId) {
        String json = "[\"cashflow\",\"" + projectId + "\"]";
        String id = "v1_" + Base64.getUrlEncoder().withoutPadding().encodeToString(json.getBytes());
        return "orgs/tenant-a/editLeases/" + id;
    }

    private static String draftPath(String projectId, String actorId) {
        String json = "[\"cashflow\",\"" + projectId + "\",\"" + actorId + "\"]";
        String id = "v1_" + Base64.getUrlEncoder().withoutPadding().encodeToString(json.getBytes());
        return "orgs/tenant-a/privateEditDrafts/" + id;
    }

    private static String idempotencyPath(
        String tenantId,
        String projectId,
        String commandName,
        String idempotencyKey
    ) {
        String identity = projectId + "\n" + commandName + "\n" + idempotencyKey;
        return "orgs/" + tenantId + "/weekly_api_idempotency/"
            + Base64.getUrlEncoder().withoutPadding().encodeToString(identity.getBytes(StandardCharsets.UTF_8));
    }

    private static Map<String, Object> activeDraft(
        String projectId,
        long revision,
        CloseCashflowMonthRequest request
    ) {
        Map<String, Object> closeInput = new LinkedHashMap<>();
        closeInput.put("yearMonth", request.yearMonth());
        closeInput.put("sourceRevision", request.sourceRevision());
        closeInput.put("targetRevision", request.targetRevision());
        closeInput.put("depositScheduleRows", request.depositScheduleRows());
        closeInput.put("cells", request.cells());
        closeInput.put("confirmations", request.confirmations());
        closeInput.put("managementChecks", request.managementChecks());
        closeInput.put("managementConfirmations", request.managementConfirmations());
        closeInput.put("deadlineSummary", request.deadlineSummary());
        Map<String, Object> storedCloseInput = (Map<String, Object>) stripNullValues(
            new ObjectMapper().convertValue(closeInput, Map.class)
        );
        Map<String, Object> draft = new LinkedHashMap<>(Map.of(
            "tenantId", "tenant-a",
            "ownerUid", "pm-1",
            "resourceType", "cashflow",
            "resourceId", projectId,
            "draftRevision", revision,
            "status", "ACTIVE",
            "createdAt", NOW.minusSeconds(300).toString(),
            "updatedAt", NOW.minusSeconds(30).toString()
        ));
        draft.put("payload", Map.of("monthClose", storedCloseInput));
        return draft;
    }

    private static Object stripNullValues(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> result = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (entry.getValue() != null) {
                    result.put(String.valueOf(entry.getKey()), stripNullValues(entry.getValue()));
                }
            }
            return result;
        }
        if (value instanceof List<?> list) {
            return list.stream().map(FirestoreCashflowLeaseGuardTest::stripNullValues).toList();
        }
        return value;
    }

    private static Map<String, Object> pinnedMirror(CloseCashflowMonthRequest request) {
        List<Map<String, Object>> sourceCells = request.cells().stream().map(cell -> {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("mode", cell.mode());
            value.put("yearMonth", request.yearMonth());
            value.put("weekNo", cell.weekNo());
            value.put("lineId", cell.cashflowLine());
            value.put("state", cell.cellState());
            value.put("sourceCell", cell.sourceCell());
            value.put("sourceLabel", cell.sourceLabel());
            if (cell.amount() != null) value.put("amount", cell.amount());
            return value;
        }).toList();
        List<Map<String, Object>> sourceDeposits = request.depositScheduleRows().stream().map(row -> {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("yearMonth", request.yearMonth());
            value.put("weekNo", row.weekNo());
            value.put("taxInvoiceIssuedDate", row.taxInvoiceIssuedDate());
            value.put("expectedDepositDate", row.expectedDepositDate());
            value.put("expectedDepositAmount", row.expectedDepositAmount());
            return value;
        }).toList();
        List<Map<String, Object>> projectionControls = new ArrayList<>();
        List<Map<String, Object>> actualControls = new ArrayList<>();
        for (int index = 0; index < 19; index += 1) {
            projectionControls.add(Map.of(
                "sourceCell", "BO" + (14 + index), "value", 0L, "computed", 0L, "matches", true
            ));
            actualControls.add(Map.of(
                "sourceCell", "BO" + (37 + index), "value", 0L, "computed", 0L, "matches", true
            ));
        }
        long depositTotal = request.depositScheduleRows().stream()
            .map(CloseCashflowMonthRequest.DepositScheduleRow::expectedDepositAmount)
            .filter(Objects::nonNull)
            .mapToLong(BigDecimal::longValueExact)
            .sum();
        Map<String, Object> controls = new LinkedHashMap<>();
        controls.put("deposit", Map.of(
            "sourceCell", "BO9", "value", depositTotal, "computed", depositTotal, "matches", true
        ));
        controls.put("unpaid", Map.of("sourceCell", "BP9", "value", 0L));
        controls.put("projection", projectionControls);
        controls.put("actual", actualControls);
        Map<String, Object> facts = new LinkedHashMap<>();
        facts.put("metadata", Map.of());
        facts.put("depositScheduleRows", sourceDeposits);
        facts.put("controlTotals", controls);
        facts.put("issues", List.of());
        Map<String, Object> mirror = new LinkedHashMap<>();
        mirror.put("projectId", "project-a");
        mirror.put("weeklyYear", Integer.parseInt(request.yearMonth().substring(0, 4)));
        mirror.put("status", "FRESH");
        mirror.put("sourceRevision", request.sourceRevision());
        mirror.put("appliedSourceRevision", request.sourceRevision());
        mirror.put("targetRevisionAtFetch", request.targetRevision());
        mirror.put("yearMonths", List.of(request.yearMonth()));
        mirror.put("capturedAt", NOW.minusSeconds(120).toString());
        mirror.put("cells", sourceCells);
        mirror.put("sheetFacts", facts);
        return mirror;
    }

    private static String monthClosePath(String projectId, String yearMonth) {
        return "orgs/tenant-a/monthly_closes/" + projectId + "-" + yearMonth;
    }

    private static String monthCloseVersionPath(String projectId, String yearMonth, long revision) {
        return "orgs/tenant-a/monthly_close_versions/" + projectId + "-" + yearMonth + "-r" + revision;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> monthCloseVersionSnapshot(Fixture fixture, String yearMonth) {
        return (Map<String, Object>) fixture.documents
            .get(monthCloseVersionPath("project-a", yearMonth, 1))
            .get("snapshot");
    }

    @SuppressWarnings("unchecked")
    private static List<String> monthCloseWarningCodes(Fixture fixture, String yearMonth) {
        return ((List<Map<String, Object>>) monthCloseVersionSnapshot(fixture, yearMonth).get("reviewWarnings"))
            .stream()
            .map(warning -> String.valueOf(warning.get("code")))
            .toList();
    }

    private static Map<String, Object> closedMonth(String yearMonth, long revision, long reopenCount) {
        return new LinkedHashMap<>(Map.of(
            "contractVersion", "cashflow-month-close-v1",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", yearMonth,
            "status", "CLOSED",
            "revision", revision,
            "reopenCount", reopenCount,
            "snapshotHash", SOURCE_REVISION,
            "snapshot", Map.of("sourceFingerprint", SOURCE_REVISION)
        ));
    }

    private static Map<String, Object> closedThrough(String yearMonth) {
        return Map.of(
            "contractVersion", "cashflow-cumulative-close-v2",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "status", "CLOSED",
            "fromMonth", "2023-01",
            "settlementMonth", YearMonth.parse(yearMonth).plusMonths(1).toString(),
            "closedThrough", yearMonth,
            "rootHash", SOURCE_REVISION,
            "revision", 1L
        );
    }

    private static Map<String, Object> completedSettlement(String yearMonth, boolean monthOnly) {
        Map<String, Object> periods = new LinkedHashMap<>();
        List<String> names = monthOnly
            ? List.of("MONTH")
            : List.of("WEEK_1", "WEEK_2", "WEEK_3", "WEEK_4", "WEEK_5");
        for (String name : names) {
            periods.put(name, new LinkedHashMap<>(Map.of(
                "status", "COMPLETED",
                "revision", 2L,
                "submittedAt", NOW.minusSeconds(120).toString(),
                "submittedBy", "pm-1",
                "approvedAt", NOW.minusSeconds(60).toString(),
                "approvedBy", "pm-1"
            )));
        }
        return new LinkedHashMap<>(Map.of(
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", yearMonth,
            "periods", periods,
            "updatedAt", NOW.toString()
        ));
    }

    @SuppressWarnings("unchecked")
    private static <T> T deepCopy(T value) {
        return (T) new ObjectMapper().convertValue(value, Object.class);
    }

    private static String weekPath() {
        return "orgs/tenant-a/cashflow_weeks/project-a-2026-07-w1";
    }

    private static String varianceWeekPath() {
        return "orgs/tenant-a/cashflow_weeks/week-a";
    }

    private static Map<String, Object> varianceWeek() {
        return new LinkedHashMap<>(Map.of(
            "id", "week-a",
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-07",
            "weekNo", 1
        ));
    }

    private static String sheetPath() {
        return "orgs/tenant-a/projects/project-a/expense_sheets/default";
    }

    private static Map<String, Object> draftWeek() {
        return new LinkedHashMap<>(Map.of(
            "tenantId", "tenant-a",
            "projectId", "project-a",
            "yearMonth", "2026-07",
            "weekNo", 1,
            "weeklyStatusState", "draft",
            "pmSubmitted", false,
            "adminClosed", false,
            "projection", Map.of("SALES_IN", 100L)
        ));
    }

    private static Map<String, Object> lockedWeeklyCompletion(String yearMonth, int weekNo, long revision) {
        return new LinkedHashMap<>(Map.ofEntries(
            Map.entry("id", "project-a-" + yearMonth + "-w" + weekNo),
            Map.entry("tenantId", "tenant-a"),
            Map.entry("projectId", "project-a"),
            Map.entry("yearMonth", yearMonth),
            Map.entry("weekNo", weekNo),
            Map.entry("status", "LOCKED"),
            Map.entry("revision", revision),
            Map.entry("reopenCount", 0L),
            Map.entry("snapshotHash", "sha256:" + "a".repeat(64)),
            Map.entry("completedAt", NOW.toString()),
            Map.entry("completedByUid", "pm-1")
        ));
    }

    private static Map<String, Object> submittedWeek() {
        Map<String, Object> value = draftWeek();
        value.put("weeklyStatusState", "submitted");
        value.put("pmSubmitted", true);
        value.put("pmSubmittedAt", NOW.minusSeconds(60).toString());
        value.put("pmSubmittedBy", "pm-1");
        return value;
    }

    private static Map<String, Object> closedWeek() {
        Map<String, Object> value = submittedWeek();
        value.put("weeklyStatusState", "closed");
        value.put("adminClosed", true);
        value.put("adminClosedAt", NOW.minusSeconds(30).toString());
        value.put("adminClosedBy", "finance-1");
        return value;
    }

    private record Fixture(
        FirestoreInheritedWeeklyExpensePersistence persistence,
        Firestore db,
        Transaction transaction,
        Map<String, DocumentReference> refs,
        Map<String, CollectionReference> collections,
        Map<String, Map<String, Object>> documents,
        List<PendingWrite> pendingWrites,
        List<Integer> getAllSizes,
        List<Integer> queryReadSizes
    ) {
    }

    private record PendingWrite(DocumentReference ref, Map<String, Object> data, boolean merge) {
    }

    private static final class QueryScope {
        private final String collectionPath;
        private final Map<String, Object> equals = new LinkedHashMap<>();
        private final Map<String, List<?>> in = new LinkedHashMap<>();
        private List<String> selected;

        private QueryScope(String collectionPath, String field, Object value) {
            this.collectionPath = collectionPath;
            if (field != null && !field.isBlank()) equals.put(field, value);
        }

        private boolean matches(Map<String, Object> document) {
            return equals.entrySet().stream().allMatch(filter -> Objects.equals(document.get(filter.getKey()), filter.getValue()))
                && in.entrySet().stream().allMatch(filter -> filter.getValue().contains(document.get(filter.getKey())));
        }

        private Map<String, Object> project(Map<String, Object> document) {
            if (selected == null) return document;
            Map<String, Object> projection = new LinkedHashMap<>();
            selected.forEach(name -> {
                if (document.containsKey(name)) projection.put(name, document.get(name));
            });
            return projection;
        }
    }
}
