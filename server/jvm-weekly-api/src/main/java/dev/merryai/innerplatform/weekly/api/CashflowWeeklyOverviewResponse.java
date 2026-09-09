package dev.merryai.innerplatform.weekly.api;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.Map;

public record CashflowWeeklyOverviewResponse(
    String version,
    String yearMonth,
    List<Item> items,
    List<ErrorItem> errors
) {
    public static final String STATUS_UNAVAILABLE = "STATUS_UNAVAILABLE";
    public static final String SUMMARY_UNAVAILABLE = "SUMMARY_UNAVAILABLE";
    public static final String MONTH_CLOSE_UNAVAILABLE = "MONTH_CLOSE_UNAVAILABLE";

    public CashflowWeeklyOverviewResponse {
        items = items == null ? List.of() : List.copyOf(items);
        errors = errors == null ? List.of() : List.copyOf(errors);
        if (items.size() > CashflowWeeklyOverviewRequest.MAX_PROJECT_COUNT
            || errors.size() > CashflowWeeklyOverviewRequest.MAX_PROJECT_COUNT * 3) {
            throw new IllegalArgumentException("Cashflow weekly overview response exceeds the project limit.");
        }
    }

    public record Item(
        String projectId,
        CashflowSettlementStatusesResponse settlementStatuses,
        CashflowProjectionActualSummaryBatchResponse.Item projectionActualSummary,
        @JsonInclude(JsonInclude.Include.NON_NULL)
        SettlementCycle settlementCycle
    ) {}

    public record SettlementCycle(
        String cycleYearMonth,
        String weeklyYearMonth,
        String monthCloseTargetYearMonth,
        String closeDeadline,
        String businessState,
        String health,
        long workflowRevision,
        CashflowSettlementStatusesResponse.Item monthCloseSettlement,
        ApprovalProvenance provenance,
        String supersededAttempt,
        Map<String, CommandCapability> commandCapabilities
    ) {
        public SettlementCycle {
            commandCapabilities = commandCapabilities == null ? Map.of() : Map.copyOf(commandCapabilities);
        }
    }

    public record CommandCapability(boolean allowed, String reasonCode) {}

    public record ApprovalProvenance(
        String affectedFromMonth,
        String affectedThroughMonth,
        String closedByCycleYearMonth,
        String approvalVersionId,
        String requestId,
        long ledgerRevision,
        String rootHash
    ) {}

    public record ErrorItem(String projectId, String code) {}
}
