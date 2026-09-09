package dev.merryai.innerplatform.weekly.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.merryai.innerplatform.weekly.api.CashflowWeeklyOverviewRequest;
import dev.merryai.innerplatform.weekly.api.CashflowWeeklyOverviewResponse;
import dev.merryai.innerplatform.weekly.api.CashflowSettlementStatusesResponse;
import dev.merryai.innerplatform.weekly.api.TrustedActorContext;
import dev.merryai.innerplatform.weekly.domain.CashflowLedgerSource;
import dev.merryai.innerplatform.weekly.domain.CashflowSettlementCyclePolicy;
import dev.merryai.innerplatform.weekly.storage.WeeklyExpensePersistence;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CashflowWeeklyOverviewServiceTest {
    private static final TrustedActorContext ACTOR = new TrustedActorContext(
        "tenant-a", "viewer-a", "viewer@example.com", "viewer", "Viewer A"
    );

    @Test
    void defaultsTheOldJsonRequestToLegacyAndRequiresAnExplicitCycleOptIn() throws Exception {
        ObjectMapper mapper = new ObjectMapper();

        CashflowWeeklyOverviewRequest legacy = mapper.readValue(
            "{\"projectIds\":[\"project-a\"],\"yearMonth\":\"2026-08\"}",
            CashflowWeeklyOverviewRequest.class
        );
        CashflowWeeklyOverviewRequest cycle = mapper.readValue(
            "{\"projectIds\":[\"project-a\"],\"yearMonth\":\"2026-08\",\"settlementCycle\":true}",
            CashflowWeeklyOverviewRequest.class
        );

        assertThat(legacy.settlementCycle()).isFalse();
        assertThat(cycle.settlementCycle()).isTrue();
    }

    @Test
    void combinesCanonicalStatusesAndSummariesInOneApplicationRead() {
        WeeklyExpensePersistence persistence = mock(WeeklyExpensePersistence.class);
        WeeklyExpenseAuthorizationService authorization = mock(WeeklyExpenseAuthorizationService.class);
        WeeklyExpenseCommandService service = new WeeklyExpenseCommandService(
            persistence, authorization, new ObjectMapper(), false, "live"
        );
        List<String> projectIds = List.of("project-a", "project-b");
        WeeklyExpensePersistence.CashflowSettlementStatusRecord completedWeek =
            new WeeklyExpensePersistence.CashflowSettlementStatusRecord("WEEK_5", "COMPLETED", "", "", "", "", 1);
        WeeklyExpensePersistence.CashflowSettlementStatusRecord pendingWeek =
            new WeeklyExpensePersistence.CashflowSettlementStatusRecord("WEEK_5", "PENDING_APPROVAL", "", "", "", "", 1);
        WeeklyExpensePersistence.CashflowSettlementStatusRecord completedJuly =
            new WeeklyExpensePersistence.CashflowSettlementStatusRecord(
                "MONTH", "LOCKED", "2026-08-11T01:00:00Z", "PM A",
                "2026-08-14T01:00:00Z", "Head A", 2
            );
        WeeklyExpensePersistence.CashflowSettlementStatusRecord pendingJuly =
            new WeeklyExpensePersistence.CashflowSettlementStatusRecord(
                "MONTH", "SUBMITTED", "2026-08-12T01:00:00Z", "PM B", "", "", 1
            );
        when(persistence.findCashflowSettlementCyclesBatch(
            ACTOR, projectIds, "2026-08", "2026-07"
        )).thenReturn(Map.of(
            "project-a", new WeeklyExpensePersistence.CashflowSettlementCycleRecord(
                "project-a", "2026-08", "2026-07", List.of(completedJuly, completedWeek), completedJuly,
                new CashflowSettlementCyclePolicy.Projection(
                    CashflowSettlementCyclePolicy.BusinessState.LOCKED,
                    CashflowSettlementCyclePolicy.Health.OK,
                    2,
                    new CashflowSettlementCyclePolicy.ApprovalProvenance(
                        "2023-01", "2026-07", "2026-08", "approval-v1",
                        "project-a-2026-08", 1, "sha256:root"
                    ),
                    ""
                ),
                new WeeklyExpensePersistence.CashflowSettlementCycleAuthority(
                    true, true, false, true, false
                )
            ),
            "project-b", new WeeklyExpensePersistence.CashflowSettlementCycleRecord(
                "project-b", "2026-08", "2026-07", List.of(pendingJuly, pendingWeek), pendingJuly,
                new CashflowSettlementCyclePolicy.Projection(
                    CashflowSettlementCyclePolicy.BusinessState.SUBMITTED,
                    CashflowSettlementCyclePolicy.Health.OK,
                    1,
                    null,
                    ""
                ),
                new WeeklyExpensePersistence.CashflowSettlementCycleAuthority(
                    true, true, true, false, false
                )
            )
        ));
        when(persistence.findCashflowLedgerSources(anyString(), anyList(), anyString(), anyString()))
            .thenReturn(Map.of(
                "project-a", new CashflowLedgerSource(List.of(), List.of()),
                "project-b", new CashflowLedgerSource(List.of(), List.of())
            ));

        CashflowWeeklyOverviewResponse response = service.readCashflowWeeklyOverview(
            ACTOR, new CashflowWeeklyOverviewRequest(projectIds, "2026-08", true)
        );

        assertThat(response.items()).hasSize(2);
        assertThat(response.items().get(0).settlementStatuses().items())
            .extracting(
                CashflowSettlementStatusesResponse.Item::period,
                CashflowSettlementStatusesResponse.Item::status
            )
            .containsExactly(
                org.assertj.core.groups.Tuple.tuple("MONTH", "LOCKED"),
                org.assertj.core.groups.Tuple.tuple("WEEK_5", "COMPLETED")
            );
        assertThat(response.items().get(1).settlementStatuses().items())
            .extracting(
                CashflowSettlementStatusesResponse.Item::period,
                CashflowSettlementStatusesResponse.Item::status
            )
            .containsExactly(
                org.assertj.core.groups.Tuple.tuple("MONTH", "SUBMITTED"),
                org.assertj.core.groups.Tuple.tuple("WEEK_5", "PENDING_APPROVAL")
            );
        assertThat(response.items().get(0).settlementCycle().monthCloseTargetYearMonth()).isEqualTo("2026-07");
        assertThat(response.items().get(0).settlementCycle().closeDeadline()).isEqualTo("2026-08-10");
        assertThat(response.items().get(0).settlementCycle().businessState()).isEqualTo("LOCKED");
        assertThat(response.items().get(0).settlementCycle().monthCloseSettlement().approvedAt())
            .isEqualTo("2026-08-14T01:00:00Z");
        assertThat(response.items().get(1).settlementCycle().businessState()).isEqualTo("SUBMITTED");
        assertThat(response.items().get(0).settlementCycle().commandCapabilities()
            .get("REQUEST_MONTH_REOPEN").allowed()).isTrue();
        assertThat(response.items().get(0).settlementCycle().commandCapabilities()
            .get("APPROVE_MONTH_CLOSE").allowed()).isFalse();
        assertThat(response.items().get(1).settlementCycle().commandCapabilities()
            .get("APPROVE_MONTH_CLOSE").allowed()).isTrue();
        assertThat(response.items()).allSatisfy(item -> {
            assertThat(item.settlementStatuses().items().getFirst())
                .extracting(
                    CashflowSettlementStatusesResponse.Item::deadlineAt,
                    CashflowSettlementStatusesResponse.Item::approverDeadlineAt
                )
                .containsExactly("2026-08-10T15:00:00Z", "2026-08-31T15:00:00Z");
            assertThat(item.settlementStatuses().items().getLast())
                .extracting(
                    CashflowSettlementStatusesResponse.Item::deadlineAt,
                    CashflowSettlementStatusesResponse.Item::approverDeadlineAt
                )
                .containsExactly("2026-08-27T15:00:00Z", "2026-08-28T04:00:00Z");
            assertThat(item.settlementCycle().monthCloseSettlement())
                .extracting(
                    CashflowSettlementStatusesResponse.Item::deadlineAt,
                    CashflowSettlementStatusesResponse.Item::approverDeadlineAt
                )
                .containsExactly("2026-08-10T15:00:00Z", "2026-08-31T15:00:00Z");
        });
        assertThat(response.items()).allSatisfy(item -> assertThat(item.projectionActualSummary()).isNotNull());
        assertThat(response.errors()).isEmpty();
        verify(authorization).requireProjectsAllowedForCommands(
            List.of(WeeklyExpenseCommandService.CASHFLOW_READ_COMMAND, WeeklyExpenseCommandService.CASHFLOW_MONTH_CLOSE_READ_COMMAND),
            ACTOR, projectIds
        );
        verify(persistence).findCashflowLedgerSources(anyString(), anyList(), anyString(), anyString());
        verify(persistence).findCashflowSettlementCyclesBatch(ACTOR, projectIds, "2026-08", "2026-07");
        verify(persistence, never()).findCashflowSettlementStatusesBatch(anyString(), anyList(), anyString());
    }

    @Test
    void keepsTheUnversionedOldBffRequestOnTheLegacyWeeklyOverviewContract() throws Exception {
        WeeklyExpensePersistence persistence = mock(WeeklyExpensePersistence.class);
        WeeklyExpenseAuthorizationService authorization = mock(WeeklyExpenseAuthorizationService.class);
        WeeklyExpenseCommandService service = new WeeklyExpenseCommandService(
            persistence, authorization, new ObjectMapper(), false, "live"
        );
        List<String> projectIds = List.of("project-a");
        WeeklyExpensePersistence.CashflowSettlementStatusRecord completedMonth =
            new WeeklyExpensePersistence.CashflowSettlementStatusRecord(
                "MONTH", "COMPLETED", "2026-08-11T01:00:00Z", "PM A",
                "2026-08-14T01:00:00Z", "Head A", 2
            );
        WeeklyExpensePersistence.CashflowSettlementStatusRecord completedWeek =
            new WeeklyExpensePersistence.CashflowSettlementStatusRecord(
                "WEEK_5", "COMPLETED", "", "", "", "", 1
            );
        when(persistence.findCashflowSettlementStatusesBatch("tenant-a", projectIds, "2026-08"))
            .thenReturn(Map.of("project-a", List.of(completedMonth, completedWeek)));
        when(persistence.findCashflowLedgerSources(anyString(), anyList(), anyString(), anyString()))
            .thenReturn(Map.of("project-a", new CashflowLedgerSource(List.of(), List.of())));

        CashflowWeeklyOverviewResponse response = service.readCashflowWeeklyOverview(
            ACTOR, new CashflowWeeklyOverviewRequest(projectIds, "2026-08")
        );

        assertThat(response.version()).isEqualTo("1");
        assertThat(response.errors()).isEmpty();
        assertThat(response.items()).singleElement().satisfies(item -> {
            assertThat(item.settlementCycle()).isNull();
            assertThat(item.settlementStatuses().items())
                .extracting(CashflowSettlementStatusesResponse.Item::period)
                .containsExactly("MONTH", "WEEK_5");
        });
        List<String> serializedItemKeys = new ArrayList<>();
        new ObjectMapper().readTree(new ObjectMapper().writeValueAsString(response))
            .path("items").get(0).fieldNames().forEachRemaining(serializedItemKeys::add);
        assertThat(serializedItemKeys).containsExactly(
            "projectId", "settlementStatuses", "projectionActualSummary"
        );
        verify(persistence).findCashflowSettlementStatusesBatch("tenant-a", projectIds, "2026-08");
        verify(persistence, never()).findCashflowSettlementCyclesBatch(
            org.mockito.ArgumentMatchers.any(), anyList(), anyString(), anyString()
        );
    }

    @Test
    void keepsLegacyReadFailuresInsideTheOldBffErrorAllowlist() {
        WeeklyExpensePersistence persistence = mock(WeeklyExpensePersistence.class);
        WeeklyExpenseAuthorizationService authorization = mock(WeeklyExpenseAuthorizationService.class);
        WeeklyExpenseCommandService service = new WeeklyExpenseCommandService(
            persistence, authorization, new ObjectMapper(), false, "live"
        );
        List<String> projectIds = List.of("project-a");
        when(persistence.findCashflowSettlementStatusesBatch("tenant-a", projectIds, "2026-08"))
            .thenThrow(new IllegalStateException("legacy status read unavailable"));
        when(persistence.findCashflowLedgerSources(anyString(), anyList(), anyString(), anyString()))
            .thenReturn(Map.of("project-a", new CashflowLedgerSource(List.of(), List.of())));

        CashflowWeeklyOverviewResponse response = service.readCashflowWeeklyOverview(
            ACTOR, new CashflowWeeklyOverviewRequest(projectIds, "2026-08")
        );

        assertThat(response.version()).isEqualTo("1");
        assertThat(response.errors())
            .extracting(
                CashflowWeeklyOverviewResponse.ErrorItem::projectId,
                CashflowWeeklyOverviewResponse.ErrorItem::code
            )
            .containsExactly(org.assertj.core.groups.Tuple.tuple("project-a", "STATUS_UNAVAILABLE"));
        assertThat(response.items()).singleElement().satisfies(item -> {
            assertThat(item.settlementStatuses()).isNull();
            assertThat(item.projectionActualSummary()).isNotNull();
            assertThat(item.settlementCycle()).isNull();
        });
        verify(persistence, never()).findCashflowSettlementCyclesBatch(
            org.mockito.ArgumentMatchers.any(), anyList(), anyString(), anyString()
        );
    }
}
