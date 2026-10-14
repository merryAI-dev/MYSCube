package dev.merryai.innerplatform.weekly.storage;

import dev.merryai.innerplatform.weekly.domain.CashflowAnnualCellSet;
import dev.merryai.innerplatform.weekly.service.command.CashflowSheetAnnualApplyCommand;
import dev.merryai.innerplatform.weekly.domain.CashflowCumulativeCloseHead;
import dev.merryai.innerplatform.weekly.domain.CashflowLedgerSource;
import dev.merryai.innerplatform.weekly.domain.CashflowMonthCloseState;
import dev.merryai.innerplatform.weekly.domain.CashflowMonthReopenPolicy;
import dev.merryai.innerplatform.weekly.domain.CashflowSettlementCyclePolicy;
import dev.merryai.innerplatform.weekly.domain.CashflowOpeningBalance;
import dev.merryai.innerplatform.weekly.service.port.CashflowMonthReopenPort;
import dev.merryai.innerplatform.weekly.service.port.CashflowReadPort;
import dev.merryai.innerplatform.weekly.api.SaveDraftResponse;
import dev.merryai.innerplatform.weekly.api.MigrateCashflowSettlementCycleHeadV2Request;
import dev.merryai.innerplatform.weekly.api.NormalizeLegacyCashflowSettlementCycleRequest;
import dev.merryai.innerplatform.weekly.api.CancelCashflowSettlementCycleRequest;
import dev.merryai.innerplatform.weekly.api.SubmitCashflowSettlementCycleRequest;
import dev.merryai.innerplatform.weekly.api.TransitionCashflowSettlementCycleRequest;
import dev.merryai.innerplatform.weekly.api.CashflowEditSession;
import dev.merryai.innerplatform.weekly.api.CashflowVarianceRequest;
import dev.merryai.innerplatform.weekly.api.CloseCashflowMonthRequest;
import dev.merryai.innerplatform.weekly.api.CompleteCashflowWeeklyUpdateRequest;
import dev.merryai.innerplatform.weekly.api.ConfirmCashflowWeeklyUpdateRequest;
import dev.merryai.innerplatform.weekly.api.ReopenCashflowWeeklyUpdateRequest;
import dev.merryai.innerplatform.weekly.api.CashflowSheetLabApplyRequest;
import dev.merryai.innerplatform.weekly.api.CashflowSheetBatchApplyRequest;
import dev.merryai.innerplatform.weekly.api.CashflowPendingApprovalAffectedMonth;
import dev.merryai.innerplatform.weekly.api.TrustedActorContext;
import dev.merryai.innerplatform.weekly.api.WeeklyExpenseEditLeaseException;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseActualEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseAuditEventEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseAuditExportEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseBankImportBatchEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseBankImportLineEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseIdempotencyEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseProjectionEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseSheetEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseWeeklyStatusEntity;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Callable;

public interface WeeklyExpensePersistence extends CashflowMonthReopenPort, CashflowReadPort {
    record AppliedCellChangeAuditSource(
        String eventId,
        String projectId,
        String sheetKey,
        String commandName,
        String actorId,
        String idempotencyKey,
        String metadataJson,
        Instant createdAt
    ) {
    }

    record CashflowMonthWeekSnapshot(
        int weekNo,
        Map<String, Object> projection,
        Map<String, Object> actual
    ) {
        public CashflowMonthWeekSnapshot {
            projection = projection == null ? Map.of() : Map.copyOf(projection);
            actual = actual == null ? Map.of() : Map.copyOf(actual);
        }
    }

    record CashflowLedgerWeekSnapshot(
        String yearMonth,
        int weekNo,
        Map<String, Object> projection,
        Map<String, Object> actual
    ) {
        public CashflowLedgerWeekSnapshot {
            projection = projection == null ? Map.of() : Map.copyOf(projection);
            actual = actual == null ? Map.of() : Map.copyOf(actual);
        }
    }

    record CashflowSheetMonthReplacement(
        List<WeeklyExpenseProjectionEntity> projection,
        List<WeeklyExpenseActualEntity> actual,
        List<CashflowMonthWeekSnapshot> weeks,
        List<CashflowLedgerWeekSnapshot> ledgerWeeks,
        String resultingTargetRevision,
        List<CashflowSettledWeekChange> settledWeekChanges
    ) {
        public CashflowSheetMonthReplacement(
            List<WeeklyExpenseProjectionEntity> projection,
            List<WeeklyExpenseActualEntity> actual,
            List<CashflowMonthWeekSnapshot> weeks,
            List<CashflowLedgerWeekSnapshot> ledgerWeeks,
            String resultingTargetRevision
        ) {
            this(projection, actual, weeks, ledgerWeeks, resultingTargetRevision, List.of());
        }

        public CashflowSheetMonthReplacement(
            List<WeeklyExpenseProjectionEntity> projection,
            List<WeeklyExpenseActualEntity> actual,
            List<CashflowMonthWeekSnapshot> weeks,
            String resultingTargetRevision
        ) {
            this(projection, actual, weeks, List.of(), resultingTargetRevision, List.of());
        }
    }

    record CashflowSheetBatchMonthReplacement(
        String yearMonth,
        List<WeeklyExpenseProjectionEntity> projection,
        List<WeeklyExpenseActualEntity> actual,
        List<CashflowMonthWeekSnapshot> weeks
    ) {
    }

    record CashflowSheetBatchReplacement(
        List<CashflowSheetBatchMonthReplacement> months,
        List<CashflowLedgerWeekSnapshot> ledgerWeeks,
        String resultingTargetRevision,
        List<CashflowSettledWeekChange> settledWeekChanges
    ) {
    }

    record CashflowPendingApprovalWarningEvidence(
        String warningId,
        String yearMonth,
        int warningCountIncrement,
        int differenceCount
    ) {
    }

    record CashflowSettledWeekChange(
        String yearMonth,
        int weekNo,
        long completionRevision,
        long warningCount
    ) {
    }

    record CashflowClosedMonthAmendment(
        String yearMonth,
        long closeRevision,
        String closeSnapshotHash,
        String deadline,
        boolean postDeadline,
        long amendmentCount,
        long warningCount,
        boolean monthlyCloseExists
    ) {
    }

    record CashflowSheetAnnualReplacement(
        long revision,
        Map<String, java.math.BigDecimal> projection,
        Map<String, java.math.BigDecimal> actual,
        Map<String, String> projectionStates,
        Map<String, String> actualStates
    ) {
    }

    record CashflowSheetAnnualTotal(
        int year,
        Map<String, java.math.BigDecimal> projection,
        Map<String, java.math.BigDecimal> actual,
        Map<String, String> projectionStates,
        Map<String, String> actualStates
    ) {
    }

    /** One authoritative read of the single weekly cashflow block. */


    record CashflowVarianceRecord(
        String sheetId,
        String projectId,
        String tenantId,
        String yearMonth,
        Map<String, Object> varianceFlag,
        List<Map<String, Object>> varianceHistory,
        long varianceRevision,
        String updatedAt,
        String updatedByUid,
        String updatedByName
    ) {
        public CashflowVarianceRecord {
            varianceFlag = varianceFlag == null ? Map.of() : Map.copyOf(varianceFlag);
            varianceHistory = varianceHistory == null
                ? List.of()
                : varianceHistory.stream().map(Map::copyOf).toList();
        }
    }

    record CashflowWeeklyUpdateCompletionRecord(
        String projectId,
        String yearMonth,
        int weekNo,
        String completedAt,
        String completedBy,
        boolean alreadyCompleted,
        String status,
        long revision,
        long reopenCount,
        String snapshotHash,
        String sourceRevision,
        String targetRevision,
        String reopenedAt,
        String reopenedBy,
        String reopenReason,
        String deadline,
        String complianceStatus,
        String operationId,
        String auditId,
        String updateResult,
        boolean projectionValidationOverride,
        int projectionValidationIssueCount,
        String projectionValidationEvidenceHash
    ) {
        public CashflowWeeklyUpdateCompletionRecord(
            String projectId, String yearMonth, int weekNo, String completedAt, String completedBy,
            boolean alreadyCompleted, String status, long revision, long reopenCount, String snapshotHash,
            String sourceRevision, String targetRevision, String reopenedAt, String reopenedBy, String reopenReason
        ) {
            this(projectId, yearMonth, weekNo, completedAt, completedBy, alreadyCompleted, status, revision,
                reopenCount, snapshotHash, sourceRevision, targetRevision, reopenedAt, reopenedBy, reopenReason,
                "", "", "", "", "", false, 0, "");
        }
    }

    // lockState: SUBMITTED(완료 요청, 확정 대기) | LOCKED(확정) | ""(완료 아님)
    record CashflowWeeklyComplianceRecord(
        String id,
        String yearMonth,
        int weekNo,
        String deadline,
        String status,
        String completedAt,
        String completedBy,
        String operationId,
        String auditId,
        String updateResult,
        String lockState
    ) {}

    record CashflowWeeklyCompliancePage(
        List<CashflowWeeklyComplianceRecord> items,
        String nextCursor,
        long onTimeCount,
        long missedCount
    ) {}


    record CashflowWeekScope(String yearMonth, int weekNo) {
    }

    record CashflowSettlementStatusRecord(
        String period,
        String status,
        String submittedAt,
        String submittedBy,
        String approvedAt,
        String approvedBy,
        long revision
    ) {
    }

    record CashflowSettlementCycleRecord(
        String projectId,
        String cycleYearMonth,
        String monthCloseTargetYearMonth,
        List<CashflowSettlementStatusRecord> weeklySettlements,
        CashflowSettlementStatusRecord monthSettlement,
        CashflowSettlementCyclePolicy.Projection projection,
        CashflowSettlementCycleAuthority authority
    ) {
        public CashflowSettlementCycleRecord(
            String projectId,
            String cycleYearMonth,
            String monthCloseTargetYearMonth,
            List<CashflowSettlementStatusRecord> weeklySettlements,
            CashflowSettlementStatusRecord monthSettlement,
            CashflowSettlementCyclePolicy.Projection projection
        ) {
            this(
                projectId, cycleYearMonth, monthCloseTargetYearMonth, weeklySettlements,
                monthSettlement, projection,
                new CashflowSettlementCycleAuthority(false, false, false, false, false, true, true)
            );
        }
    }

    record CashflowSettlementCycleAuthority(
        boolean activeMember,
        boolean projectWriter,
        boolean currentApprover,
        boolean requester,
        boolean recoveryAdmin,
        boolean coordinatorInactive,
        boolean latestApprovalAuthority
    ) {
        public CashflowSettlementCycleAuthority(
            boolean activeMember,
            boolean projectWriter,
            boolean currentApprover,
            boolean requester,
            boolean recoveryAdmin,
            boolean coordinatorInactive
        ) {
            this(
                activeMember, projectWriter, currentApprover,
                requester, recoveryAdmin, coordinatorInactive, true
            );
        }

        public CashflowSettlementCycleAuthority(
            boolean activeMember,
            boolean projectWriter,
            boolean currentApprover,
            boolean requester,
            boolean recoveryAdmin
        ) {
            this(
                activeMember, projectWriter, currentApprover,
                requester, recoveryAdmin, true, true
            );
        }
    }

    record CashflowSettlementCycleCommandState(
        String projectId,
        String cycleYearMonth,
        String monthCloseTargetYearMonth,
        String requestId,
        String businessState,
        long workflowRevision,
        long evidenceRevision,
        String manifestHash,
        String submittedAt,
        String submittedByUid,
        String approverUid,
        String decidedAt,
        String decidedByUid,
        String reason
    ) {
    }

    record CashflowSettlementCycleHeadMigrationState(
        String projectId,
        String closedThrough,
        String cycleYearMonth,
        String approvalVersionId,
        long headRevision,
        String migrationFingerprint,
        boolean migrationRequired
    ) {
    }

    record CashflowSettlementCycleLegacyRequestNormalizationState(
        String projectId,
        String cycleYearMonth,
        String monthCloseTargetYearMonth,
        String requestId,
        long workflowRevision,
        long evidenceRevision,
        String migrationFingerprint,
        boolean migrationRequired
    ) {
    }

    default <T> T runCommandTransaction(Callable<T> action) {
        try {
            return action.call();
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalStateException("Weekly expense command transaction failed.", error);
        }
    }

    default void requireCashflowDataProject(String dataProjectId) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_data_project_backend_unavailable",
            "Cashflow data-project validation requires the Firestore transaction backend."
        );
    }

    default String requireCashflowWriteLease(
        TrustedActorContext actor,
        String projectId,
        CashflowEditSession session
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_edit_lease_backend_unavailable",
            "Cashflow edit leases require the Firestore transaction backend."
        );
    }

    default String requireCashflowWritePermission(TrustedActorContext actor, String projectId) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_write_permission_backend_unavailable",
            "Cashflow write permission checks require the Firestore transaction backend."
        );
    }

    default String requireCashflowMonthClosePermission(TrustedActorContext actor, String projectId) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_month_close_permission_backend_unavailable",
            "Cashflow month-close permission checks require the Firestore transaction backend."
        );
    }

    @Override
    default CashflowMonthReopenPolicy.DecisionAuthorityFacts findCashflowMonthReopenDecisionAuthorityFacts(
        CashflowMonthReopenPort.Actor actor,
        String projectId
    ) {
        throw new CashflowMonthReopenPort.DecisionAuthorityUnavailable();
    }

    @Override
    default void bindCashflowMonthReopenDecisionAuthority(
        CashflowMonthReopenPolicy.DecisionAuthority authority
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_month_reopen_decision_permission_backend_unavailable",
            "Cashflow month-reopen decision permission checks require the Firestore transaction backend."
        );
    }

    default List<CashflowSettlementStatusRecord> findCashflowSettlementStatuses(
        String tenantId,
        String projectId,
        String yearMonth
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_settlement_status_backend_unavailable",
            "Cashflow settlement status reads require the Firestore transaction backend."
        );
    }

    default Map<String, List<CashflowSettlementStatusRecord>> findCashflowSettlementStatusesBatch(
        String tenantId,
        List<String> projectIds,
        String yearMonth
    ) {
        Map<String, List<CashflowSettlementStatusRecord>> result = new LinkedHashMap<>();
        for (String projectId : projectIds) {
            result.put(projectId, findCashflowSettlementStatuses(tenantId, projectId, yearMonth));
        }
        return Map.copyOf(result);
    }

    default Map<String, String> findCashflowMonthCloseRequestStatusesBatch(
        String tenantId,
        List<String> projectIds,
        String yearMonth
    ) {
        return Map.of();
    }

    default Map<String, CashflowSettlementCycleRecord> findCashflowSettlementCyclesBatch(
        TrustedActorContext actor,
        List<String> projectIds,
        String cycleYearMonth,
        String monthCloseTargetYearMonth
    ) {
        return Map.of();
    }

    default CashflowSettlementCycleCommandState submitCashflowSettlementCycle(
        TrustedActorContext actor,
        String projectId,
        SubmitCashflowSettlementCycleRequest request
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_settlement_cycle_backend_unavailable",
            "Cashflow settlement cycle submission requires the Firestore transaction backend."
        );
    }

    default CashflowSettlementCycleCommandState transitionCashflowSettlementCycle(
        TrustedActorContext actor,
        String projectId,
        TransitionCashflowSettlementCycleRequest request
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_settlement_cycle_backend_unavailable",
            "Cashflow settlement cycle transition requires the Firestore transaction backend."
        );
    }

    default CashflowSettlementCycleCommandState cancelCashflowSettlementCycle(
        TrustedActorContext actor,
        String projectId,
        CancelCashflowSettlementCycleRequest request
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_settlement_cycle_backend_unavailable",
            "Cashflow settlement cycle recovery requires the Firestore transaction backend."
        );
    }

    default CashflowSettlementCycleHeadMigrationState migrateCashflowSettlementCycleHeadV2(
        TrustedActorContext actor,
        String projectId,
        MigrateCashflowSettlementCycleHeadV2Request request
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_settlement_cycle_migration_backend_unavailable",
            "Cashflow settlement cycle migration requires the Firestore transaction backend."
        );
    }

    default CashflowSettlementCycleLegacyRequestNormalizationState normalizeLegacyCashflowSettlementCycleRequest(
        TrustedActorContext actor,
        String projectId,
        NormalizeLegacyCashflowSettlementCycleRequest request
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_settlement_cycle_migration_backend_unavailable",
            "Cashflow settlement cycle migration requires the Firestore transaction backend."
        );
    }

    default CashflowSettlementStatusRecord transitionCashflowSettlementStatus(
        TrustedActorContext actor,
        String projectId,
        String yearMonth,
        String period,
        String action
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_settlement_status_backend_unavailable",
            "Cashflow settlement status updates require the Firestore transaction backend."
        );
    }

    default void requireCashflowMonthsOpen(
        String tenantId,
        String projectId,
        Collection<String> yearMonths
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_month_guard_backend_unavailable",
            "Cashflow month locking requires the Firestore transaction backend."
        );
    }

    default void requireCashflowWeeksOpen(
        String tenantId,
        String projectId,
        Collection<CashflowWeekScope> weeks
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_week_guard_backend_unavailable",
            "Cashflow week validation requires the Firestore transaction backend."
        );
    }

    default CashflowMonthCloseState findCashflowMonthClose(
        String tenantId,
        String projectId,
        String yearMonth
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_month_close_backend_unavailable",
            "Cashflow month close reads require the Firestore transaction backend."
        );
    }

    default CashflowVarianceRecord updateCashflowVariance(
        TrustedActorContext actor,
        String projectId,
        CashflowVarianceRequest request
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_variance_backend_unavailable",
            "Cashflow variance updates require the Firestore transaction backend."
        );
    }

    default CashflowMonthCloseState closeCashflowMonth(
        TrustedActorContext actor,
        String projectId,
        String sourceSheetKey,
        CloseCashflowMonthRequest request
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_month_close_backend_unavailable",
            "Cashflow month close requires the Firestore transaction backend."
        );
    }

    default CashflowWeeklyUpdateCompletionRecord completeCashflowWeeklyUpdate(
        TrustedActorContext actor,
        String projectId,
        CompleteCashflowWeeklyUpdateRequest request
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_weekly_completion_backend_unavailable",
            "Cashflow weekly completion requires the Firestore transaction backend."
        );
    }

    default CashflowWeeklyUpdateCompletionRecord findCashflowWeeklyUpdateCompletion(
        String tenantId,
        String projectId,
        String yearMonth,
        int weekNo
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_weekly_update_backend_unavailable",
            "Cashflow weekly update reads require the Firestore transaction backend."
        );
    }

    default CashflowWeeklyCompliancePage findCashflowWeeklyComplianceHistory(
        String tenantId,
        String projectId,
        int limit,
        String cursor
    ) {
        return new CashflowWeeklyCompliancePage(List.of(), "", 0, 0);
    }

    default CashflowCumulativeCloseHead findCashflowCumulativeCloseHead(String tenantId, String projectId) {
        return null;
    }

    default CashflowWeeklyUpdateCompletionRecord confirmCashflowWeeklyUpdate(
        TrustedActorContext actor,
        String projectId,
        ConfirmCashflowWeeklyUpdateRequest request
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_weekly_confirm_backend_unavailable",
            "Cashflow weekly confirm requires the Firestore transaction backend."
        );
    }

    default CashflowWeeklyUpdateCompletionRecord reopenCashflowWeeklyUpdate(
        TrustedActorContext actor,
        String projectId,
        ReopenCashflowWeeklyUpdateRequest request
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_weekly_reopen_backend_unavailable",
            "Cashflow weekly reopen requires the Firestore transaction backend."
        );
    }

    @Override
    default CashflowMonthReopenPolicy.Facts findCashflowMonthReopenFacts(
        String tenantId,
        String projectId,
        String yearMonth
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_month_reopen_backend_unavailable",
            "Cashflow month reopen facts require the Firestore transaction backend."
        );
    }

    @Override
    default CashflowMonthCloseState applyCashflowMonthReopenRequest(
        CashflowMonthReopenPort.Actor actor,
        String projectId,
        CashflowMonthReopenPolicy.RequestTransition transition,
        String reason
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_month_reopen_backend_unavailable",
            "Cashflow month reopen requires the Firestore transaction backend."
        );
    }

    @Override
    default CashflowMonthCloseState applyCashflowMonthReopenDecision(
        CashflowMonthReopenPort.Actor actor,
        String projectId,
        CashflowMonthReopenPolicy.DecisionTransition transition,
        String reason
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_month_reopen_backend_unavailable",
            "Cashflow month reopen decisions require the Firestore transaction backend."
        );
    }

    default CashflowSheetMonthReplacement replaceCashflowSheetMonth(
        String tenantId,
        String projectId,
        String sourceSheetKey,
        String yearMonth,
        String targetRevision,
        List<CashflowSheetLabApplyRequest.Cell> cells
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_month_replace_backend_unavailable",
            "Authoritative monthly cashflow replacement requires the Firestore transaction backend."
        );
    }

    default CashflowSheetBatchReplacement replaceCashflowSheetMonths(
        String tenantId,
        String projectId,
        String sourceSheetKey,
        String targetRevision,
        CashflowSheetBatchApplyRequest request
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_month_batch_replace_backend_unavailable",
            "Authoritative multi-month cashflow replacement requires the Firestore transaction backend."
        );
    }

    default CashflowSheetMonthReplacement replaceCashflowSheetMonth(
        String tenantId,
        String projectId,
        String sourceSheetKey,
        String yearMonth,
        String targetRevision,
        List<CashflowSheetLabApplyRequest.Cell> cells,
        boolean replaceAllActualSources,
        dev.merryai.innerplatform.weekly.api.CashflowSettledWeekChangeConfirmation settledWeekChangeConfirmation,
        String sourceRevision,
        String idempotencyKey
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_month_replace_backend_unavailable",
            "Authoritative monthly cashflow replacement requires the Firestore transaction backend."
        );
    }

    default List<CashflowClosedMonthAmendment> authorizeCashflowSheetMonthAmendments(
        TrustedActorContext actor,
        String projectId,
        Collection<String> yearMonths,
        String sourceRevision,
        String reason,
        String idempotencyKey
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_month_amendment_backend_unavailable",
            "Cashflow closed-month amendments require the Firestore transaction backend."
        );
    }

    default void recordCashflowSheetMonthAmendments(
        TrustedActorContext actor,
        String projectId,
        List<CashflowClosedMonthAmendment> amendments,
        String sourceRevision,
        String targetRevision,
        String resultingTargetRevision,
        Map<String, List<Map<String, Object>>> calculationChecksByMonth,
        String reason,
        String idempotencyKey
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_month_amendment_backend_unavailable",
            "Cashflow closed-month amendment records require the Firestore transaction backend."
        );
    }

    default List<CashflowPendingApprovalWarningEvidence> recordCashflowPendingApprovalWarnings(
        TrustedActorContext actor,
        String projectId,
        String commandName,
        String sourceRevision,
        String targetRevision,
        String resultingTargetRevision,
        String idempotencyKey,
        List<CashflowPendingApprovalAffectedMonth> instructions
    ) {
        if (instructions == null || instructions.isEmpty()) return List.of();
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_pending_approval_warning_backend_unavailable",
            "Pending approval warning evidence requires the Firestore transaction backend."
        );
    }

    default CashflowSheetMonthReplacement replaceCashflowSheetMonth(
        String tenantId,
        String projectId,
        String sourceSheetKey,
        String yearMonth,
        String targetRevision,
        List<CashflowSheetLabApplyRequest.Cell> cells,
        boolean replaceAllActualSources
    ) {
        return replaceCashflowSheetMonth(tenantId, projectId, sourceSheetKey, yearMonth, targetRevision, cells);
    }

    default int countCashflowActualReplacementWrites(
        String tenantId,
        String projectId,
        String sourceSheetKey,
        List<String> requestedWeekDocumentIds
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_atomic_plan_backend_unavailable",
            "Cashflow atomic write planning requires the Firestore transaction backend."
        );
    }

    default CashflowSheetAnnualReplacement replaceCashflowSheetYearTotal(
        String tenantId,
        String projectId,
        String sourceSheetKey,
        CashflowSheetAnnualApplyCommand request
    ) {
        throw new WeeklyExpenseEditLeaseException(
            503,
            "cashflow_annual_replace_backend_unavailable",
            "Authoritative annual cashflow replacement requires the Firestore transaction backend."
        );
    }

    default List<CashflowSheetAnnualTotal> findCashflowSheetYearTotals(String tenantId, String projectId) {
        return List.of();
    }

    default Integer findCashflowDeclaredWeeklyYear(String tenantId, String projectId) {
        return null;
    }

    default Map<String, Integer> findCashflowDeclaredWeeklyYears(String tenantId, List<String> projectIds) {
        Map<String, Integer> yearsByProject = new LinkedHashMap<>();
        for (String projectId : projectIds) {
            Integer weeklyYear = findCashflowDeclaredWeeklyYear(tenantId, projectId);
            if (weeklyYear != null) yearsByProject.put(projectId, weeklyYear);
        }
        return Map.copyOf(yearsByProject);
    }

    default CashflowLedgerSource findCashflowLedgerSource(String tenantId, String projectId, int weeklyYear) {
        List<WeeklyExpenseProjectionEntity> projection = findProjectionLines(tenantId, projectId);
        List<WeeklyExpenseActualEntity> actual = findActualLines(tenantId, projectId);
        String yearPrefix = weeklyYear + "-";
        return new CashflowLedgerSource(
            projection.stream().filter(line -> line.getYearMonth().startsWith(yearPrefix)).toList(),
            actual.stream().filter(line -> line.getYearMonth().startsWith(yearPrefix)).toList()
        );
    }

    default CashflowLedgerSource findCashflowGlobalLedgerSource(String tenantId, String projectId) {
        return new CashflowLedgerSource(findProjectionLines(tenantId, projectId), findActualLines(tenantId, projectId));
    }

    default CashflowLedgerSource findCashflowLedgerSource(
        String tenantId,
        String projectId,
        int weeklyYear,
        String fromMonth,
        String throughMonth
    ) {
        CashflowLedgerSource source = findCashflowLedgerSource(tenantId, projectId, weeklyYear);
        List<WeeklyExpenseProjectionEntity> projection = source.projection().stream()
            .filter(line -> line.getYearMonth().compareTo(fromMonth) >= 0 && line.getYearMonth().compareTo(throughMonth) <= 0)
            .toList();
        List<WeeklyExpenseActualEntity> actual = source.actual().stream()
            .filter(line -> line.getYearMonth().compareTo(fromMonth) >= 0 && line.getYearMonth().compareTo(throughMonth) <= 0)
            .toList();
        return new CashflowLedgerSource(projection, actual, source.targetRevision());
    }

    default Map<String, CashflowLedgerSource> findCashflowLedgerSources(
        String tenantId,
        List<String> projectIds,
        String fromMonth,
        String throughMonth
    ) {
        Map<String, CashflowLedgerSource> result = new LinkedHashMap<>();
        for (String projectId : projectIds) {
            CashflowLedgerSource source = findCashflowGlobalLedgerSource(tenantId, projectId);
            List<WeeklyExpenseProjectionEntity> projection = source.projection().stream()
                .filter(line -> line.getYearMonth().compareTo(fromMonth) >= 0 && line.getYearMonth().compareTo(throughMonth) <= 0)
                .toList();
            List<WeeklyExpenseActualEntity> actual = source.actual().stream()
                .filter(line -> line.getYearMonth().compareTo(fromMonth) >= 0 && line.getYearMonth().compareTo(throughMonth) <= 0)
                .toList();
            result.put(projectId, new CashflowLedgerSource(projection, actual, source.targetRevision()));
        }
        return Map.copyOf(result);
    }

    default Map<String, CashflowLedgerSource> findCashflowLedgerSources(
        String tenantId,
        Map<String, Integer> weeklyYearsByProject,
        String fromMonth,
        String throughMonth
    ) {
        Map<String, CashflowLedgerSource> result = new LinkedHashMap<>();
        for (Map.Entry<String, Integer> entry : weeklyYearsByProject.entrySet()) {
            result.put(entry.getKey(), findCashflowLedgerSource(
                tenantId, entry.getKey(), entry.getValue(), fromMonth, throughMonth
            ));
        }
        return Map.copyOf(result);
    }

    /**
     * Canonical carry-forward policy for cashflow reads and month-close snapshots.
     * A prior year uses weekly ledger lines when that year exists in the weekly ledger;
     * the annual-total document is only a fallback, so a year can never be counted twice.
     */
    default CashflowOpeningBalance findCashflowOpeningBalance(
        String tenantId,
        String projectId,
        int selectedYear
    ) {
        if (selectedYear < 2000 || selectedYear > 2099) {
            throw new IllegalArgumentException("Cashflow opening-balance year must be between 2000 and 2099.");
        }
        List<CashflowSheetAnnualTotal> annualTotals = findCashflowSheetYearTotals(tenantId, projectId).stream()
            .filter(total -> total.year() < selectedYear)
            .sorted(java.util.Comparator.comparingInt(CashflowSheetAnnualTotal::year))
            .toList();
        List<Integer> includedYears = annualTotals.stream().map(CashflowSheetAnnualTotal::year).toList();
        List<CashflowOpeningBalance.YearSource> projectionSources = annualTotals.stream()
            .map(total -> new CashflowOpeningBalance.YearSource(
                total.year(),
                total.projection(),
                total.projectionStates()
            ))
            .toList();
        List<CashflowOpeningBalance.YearSource> actualSources = annualTotals.stream()
            .map(total -> new CashflowOpeningBalance.YearSource(
                total.year(),
                total.actual(),
                total.actualStates()
            ))
            .toList();
        Map<String, BigDecimal> projectionLines = cashflowAggregateLines(projectionSources);
        Map<String, BigDecimal> actualLines = cashflowAggregateLines(actualSources);

        return new CashflowOpeningBalance(
            selectedYear,
            new CashflowOpeningBalance.Mode(
                cashflowMapNet(projectionLines),
                projectionLines,
                projectionSources,
                includedYears,
                List.of()
            ),
            new CashflowOpeningBalance.Mode(
                cashflowMapNet(actualLines),
                actualLines,
                actualSources,
                includedYears,
                List.of()
            )
        );
    }

    private static Map<String, BigDecimal> cashflowAggregateLines(
        List<CashflowOpeningBalance.YearSource> sources
    ) {
        Map<String, BigDecimal> totals = new java.util.TreeMap<>();
        for (CashflowOpeningBalance.YearSource source : sources) {
            source.lineAmounts().forEach((rawLine, value) -> {
                String line = dev.merryai.innerplatform.weekly.domain.CashflowLineCatalog.canonicalize(rawLine);
                if (!dev.merryai.innerplatform.weekly.domain.CashflowLineCatalog.ALL_LINES.contains(line)) return;
                totals.merge(line, value == null ? BigDecimal.ZERO : value, BigDecimal::add);
            });
        }
        return Map.copyOf(totals);
    }

    private static BigDecimal cashflowMapNet(Map<String, BigDecimal> amounts) {
        if (amounts == null) return BigDecimal.ZERO;
        BigDecimal totalIn = dev.merryai.innerplatform.weekly.domain.CashflowLineCatalog.IN_LINES.stream()
            .map(line -> amounts.getOrDefault(line, BigDecimal.ZERO))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        BigDecimal totalOut = dev.merryai.innerplatform.weekly.domain.CashflowLineCatalog.OUT_LINES.stream()
            .map(line -> amounts.getOrDefault(line, BigDecimal.ZERO))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        return totalIn.subtract(totalOut);
    }

    Optional<WeeklyExpenseIdempotencyEntity> findIdempotency(
        String tenantId,
        String projectId,
        String commandName,
        String idempotencyKey
    );

    WeeklyExpenseIdempotencyEntity saveIdempotency(WeeklyExpenseIdempotencyEntity idempotency);

    Optional<WeeklyExpenseSheetEntity> findSheetForUpdate(String tenantId, String projectId, String sheetKey);

    List<WeeklyExpenseSheetEntity> findSheets(String tenantId, String projectId);

    WeeklyExpenseSheetEntity saveSheet(WeeklyExpenseSheetEntity sheet);

    void flushSheet(WeeklyExpenseSheetEntity sheet);

    List<SaveDraftResponse.ActualDelta> replaceActuals(
        WeeklyExpenseSheetEntity sheet,
        List<SaveDraftResponse.ActualDelta> deltas
    );

    List<WeeklyExpenseActualEntity> replaceActualLines(
        String tenantId,
        String projectId,
        String sheetKey,
        List<SaveDraftResponse.ActualDelta> deltas
    );

    List<WeeklyExpenseActualEntity> findActualLines(String tenantId, String projectId);

    List<WeeklyExpenseActualEntity> findActualLinesForAudit(String tenantId, String projectId);

    WeeklyExpenseAuditEventEntity saveAuditEvent(WeeklyExpenseAuditEventEntity auditEvent);

    List<WeeklyExpenseAuditEventEntity> findAuditEventsForAudit(String tenantId, String projectId);

    default List<AppliedCellChangeAuditSource> findAppliedCellChangeAuditSources(
        String tenantId,
        String projectId
    ) {
        return findAuditEventsForAudit(tenantId, projectId).stream()
            .map(event -> new AppliedCellChangeAuditSource(
                event.getId(), event.getProjectId(), event.getSheetKey(), event.getCommandName(),
                event.getActorId(), event.getIdempotencyKey(), event.getMetadataJson(), event.getCreatedAt()
            ))
            .toList();
    }

    List<WeeklyExpenseAuditEventEntity> findRecentAuditEvents(String tenantId, String projectId, int limit);

    WeeklyExpenseAuditExportEntity saveAuditExport(WeeklyExpenseAuditExportEntity auditExport);

    WeeklyExpenseBankImportBatchEntity saveBankImportBatch(WeeklyExpenseBankImportBatchEntity batch);

    Optional<WeeklyExpenseBankImportLineEntity> findBankImportLineBySourceKey(
        String tenantId,
        String projectId,
        String sourceLineKey
    );

    List<WeeklyExpenseBankImportLineEntity> findBankImportLines(String tenantId, String projectId, String status);

    List<WeeklyExpenseBankImportLineEntity> findBankImportLinesForUpdate(
        String tenantId,
        String projectId,
        Collection<String> ids
    );

    List<WeeklyExpenseBankImportLineEntity> saveBankImportLines(List<WeeklyExpenseBankImportLineEntity> lines);

    Optional<WeeklyExpenseProjectionEntity> findProjectionLine(
        String tenantId,
        String projectId,
        String yearMonth,
        int weekNo,
        String cashflowLine
    );

    WeeklyExpenseProjectionEntity saveProjection(WeeklyExpenseProjectionEntity projection);

    List<WeeklyExpenseProjectionEntity> findProjectionLines(String tenantId, String projectId);

    List<WeeklyExpenseProjectionEntity> findProjectionLinesForAudit(String tenantId, String projectId);

    Optional<WeeklyExpenseWeeklyStatusEntity> findWeeklyStatus(
        String tenantId,
        String projectId,
        String yearMonth,
        int weekNo
    );

    WeeklyExpenseWeeklyStatusEntity saveWeeklyStatus(WeeklyExpenseWeeklyStatusEntity status);

    List<WeeklyExpenseWeeklyStatusEntity> findWeeklyStatuses(String tenantId, String projectId);
}
