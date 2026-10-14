package dev.merryai.innerplatform.weekly.service;

import dev.merryai.innerplatform.weekly.domain.CashflowAnnualCellSet;
import dev.merryai.innerplatform.weekly.service.command.CashflowSheetAnnualApplyCommand;
import dev.merryai.innerplatform.weekly.domain.CashflowCumulativeCloseHead;
import dev.merryai.innerplatform.weekly.domain.CashflowLedgerSource;
import dev.merryai.innerplatform.weekly.domain.CashflowMonthCloseState;
import dev.merryai.innerplatform.weekly.domain.CashflowMonthReopenPolicy;
import dev.merryai.innerplatform.weekly.domain.CashflowOpeningBalance;
import dev.merryai.innerplatform.weekly.domain.CashflowSettlementCyclePolicy;
import dev.merryai.innerplatform.weekly.service.command.CashflowMonthReopenCommands;
import dev.merryai.innerplatform.weekly.service.port.CashflowMonthReopenPort;
import dev.merryai.innerplatform.weekly.service.query.CashflowMonthReopenAuthorityResult;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.merryai.innerplatform.weekly.api.CellCommandResponse;
import dev.merryai.innerplatform.weekly.api.CellPatchCommandRequest;
import dev.merryai.innerplatform.weekly.api.CashflowEditSession;
import dev.merryai.innerplatform.weekly.api.CashflowAppliedCellChangesResponse;
import dev.merryai.innerplatform.weekly.api.CashflowMonthCloseResponse;
import dev.merryai.innerplatform.weekly.api.CashflowSheetLabApplyRequest;
import dev.merryai.innerplatform.weekly.api.CashflowSheetLabApplyResponse;
import dev.merryai.innerplatform.weekly.api.CashflowSheetBatchApplyRequest;
import dev.merryai.innerplatform.weekly.api.CashflowSheetBatchApplyResponse;
import dev.merryai.innerplatform.weekly.api.CashflowSheetAnnualApplyResponse;
import dev.merryai.innerplatform.weekly.api.CashflowSheetOperationStatusResponse;
import dev.merryai.innerplatform.weekly.api.CashflowPendingApprovalAffectedMonth;
import dev.merryai.innerplatform.weekly.api.CashflowProjectionActualSummaryBatchRequest;
import dev.merryai.innerplatform.weekly.api.CashflowProjectionActualSummaryBatchResponse;
import dev.merryai.innerplatform.weekly.api.CashflowWeeklyOverviewRequest;
import dev.merryai.innerplatform.weekly.api.CashflowWeeklyOverviewResponse;
import dev.merryai.innerplatform.weekly.api.CashflowSheetFormulaPreflightRequest;
import dev.merryai.innerplatform.weekly.api.CashflowSheetFormulaPreflightResponse;
import dev.merryai.innerplatform.weekly.api.CashflowSnapshotResponse;
import dev.merryai.innerplatform.weekly.api.CashflowSettlementStatusesResponse;
import dev.merryai.innerplatform.weekly.api.CashflowSettlementStatusesBatchRequest;
import dev.merryai.innerplatform.weekly.api.CashflowSettlementStatusesBatchResponse;
import dev.merryai.innerplatform.weekly.api.CashflowSettlementCycleCommandResponse;
import dev.merryai.innerplatform.weekly.api.CashflowSettlementCycleHeadMigrationResponse;
import dev.merryai.innerplatform.weekly.api.CashflowSettlementCycleLegacyRequestNormalizationResponse;
import dev.merryai.innerplatform.weekly.api.CancelCashflowSettlementCycleRequest;
import dev.merryai.innerplatform.weekly.api.CashflowVarianceRequest;
import dev.merryai.innerplatform.weekly.api.CashflowVarianceResponse;
import dev.merryai.innerplatform.weekly.api.CloseWeekRequest;
import dev.merryai.innerplatform.weekly.api.CloseWeekResponse;
import dev.merryai.innerplatform.weekly.api.CloseCashflowMonthRequest;
import dev.merryai.innerplatform.weekly.api.CompleteCashflowWeeklyUpdateRequest;
import dev.merryai.innerplatform.weekly.api.CashflowWeeklyUpdateCompletionResponse;
import dev.merryai.innerplatform.weekly.api.CashflowWeeklyComplianceHistoryResponse;
import dev.merryai.innerplatform.weekly.api.ApplyBankStatementItemsRequest;
import dev.merryai.innerplatform.weekly.api.ApplyBankStatementItemsResponse;
import dev.merryai.innerplatform.weekly.api.BankStatementImportLinesResponse;
import dev.merryai.innerplatform.weekly.api.CopyCellsRequest;
import dev.merryai.innerplatform.weekly.api.CreateAuditExportRequest;
import dev.merryai.innerplatform.weekly.api.CreateAuditExportResponse;
import dev.merryai.innerplatform.weekly.api.CutCellsRequest;
import dev.merryai.innerplatform.weekly.api.ImportBankStatementBatchRequest;
import dev.merryai.innerplatform.weekly.api.ImportBankStatementBatchResponse;
import dev.merryai.innerplatform.weekly.api.PasteCellsRequest;
import dev.merryai.innerplatform.weekly.api.RowCommandResponse;
import dev.merryai.innerplatform.weekly.api.RowDeleteRequest;
import dev.merryai.innerplatform.weekly.api.RowInsertRequest;
import dev.merryai.innerplatform.weekly.api.ConfirmCashflowWeeklyUpdateRequest;
import dev.merryai.innerplatform.weekly.api.ReopenCashflowWeeklyUpdateRequest;
import dev.merryai.innerplatform.weekly.api.MigrateCashflowSettlementCycleHeadV2Request;
import dev.merryai.innerplatform.weekly.api.NormalizeLegacyCashflowSettlementCycleRequest;
import dev.merryai.innerplatform.weekly.observability.CashflowReadMetrics;
import dev.merryai.innerplatform.weekly.api.SaveDraftRequest;
import dev.merryai.innerplatform.weekly.api.SaveDraftResponse;
import dev.merryai.innerplatform.weekly.api.SubmitWeekRequest;
import dev.merryai.innerplatform.weekly.api.SubmitCashflowSettlementCycleRequest;
import dev.merryai.innerplatform.weekly.api.SubmitWeekResponse;
import dev.merryai.innerplatform.weekly.api.TrustedActorContext;
import dev.merryai.innerplatform.weekly.api.TransitionCashflowSettlementStatusRequest;
import dev.merryai.innerplatform.weekly.api.TransitionCashflowSettlementCycleRequest;
import dev.merryai.innerplatform.weekly.api.UpsertProjectionRequest;
import dev.merryai.innerplatform.weekly.api.UpsertProjectionResponse;
import dev.merryai.innerplatform.weekly.api.WeeklyExpenseConflictException;
import dev.merryai.innerplatform.weekly.api.WeeklyExpenseAtomicWriteLimitException;
import dev.merryai.innerplatform.weekly.api.WeeklyExpenseEditLeaseException;
import dev.merryai.innerplatform.weekly.api.WeeklyExpenseForbiddenException;
import dev.merryai.innerplatform.weekly.api.WeeklyExpenseRequestLimits;
import dev.merryai.innerplatform.weekly.api.WeeklyExpenseSheetResponse;
import dev.merryai.innerplatform.weekly.api.WeeklyExpenseSheetsResponse;
import dev.merryai.innerplatform.weekly.domain.CellValidationIssue;
import dev.merryai.innerplatform.weekly.domain.CellAddress;
import dev.merryai.innerplatform.weekly.domain.CellValidationStatus;
import dev.merryai.innerplatform.weekly.domain.CashflowLineCatalog;
import dev.merryai.innerplatform.weekly.domain.CashflowProjectionActualSummaryCalculator;
import dev.merryai.innerplatform.weekly.domain.ApproverDeadlineCalculator;
import dev.merryai.innerplatform.weekly.domain.CashflowCloseDeadline;
import dev.merryai.innerplatform.weekly.domain.CashflowWeekDeadline;
import dev.merryai.innerplatform.weekly.domain.CashflowFormulaValidator;
import dev.merryai.innerplatform.weekly.domain.ClipboardCell;
import dev.merryai.innerplatform.weekly.domain.ClipboardPayload;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseActualEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseAuditEventEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseAuditExportEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseBankImportBatchEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseBankImportLineEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseCellEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseColumn;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseFormulaEngine;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseIdempotencyEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseProjectionEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseRowEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseSheetEntity;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseSpreadsheetService;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseWeeklyStatusEntity;
import dev.merryai.innerplatform.weekly.domain.PasteResult;
import dev.merryai.innerplatform.weekly.domain.SpreadsheetOperationType;
import dev.merryai.innerplatform.weekly.domain.SpreadsheetSelection;
import dev.merryai.innerplatform.weekly.domain.SpreadsheetValueType;
import dev.merryai.innerplatform.weekly.storage.WeeklyExpensePersistence;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Value;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.Clock;
import java.time.YearMonth;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class WeeklyExpenseCommandService {
    public static final String SAVE_DRAFT_COMMAND = "weeklyExpense.saveDraft";
    public static final String SHEET_READ_COMMAND = "weeklyExpense.sheet.read";
    public static final String BANK_IMPORT_BATCH_COMMAND = "weeklyExpense.bankStatement.importBatch";
    public static final String BANK_IMPORT_LIST_LINES_COMMAND = "weeklyExpense.bankStatement.listLines";
    public static final String BANK_IMPORT_APPLY_ITEMS_COMMAND = "weeklyExpense.bankStatement.applyItems";
    public static final String UPSERT_PROJECTION_COMMAND = "weeklyExpense.projection.upsert";
    public static final String CASHFLOW_SHEET_LAB_APPLY_COMMAND = "weeklyExpense.cashflowSheetLab.apply";
    public static final String SUBMIT_WEEK_COMMAND = "weeklyExpense.submitWeek";
    public static final String CLOSE_WEEK_COMMAND = "weeklyExpense.closeWeek";
    public static final String WEEKLY_STATUS_READ_COMMAND = "weeklyExpense.status.read";
    public static final String CELL_PATCH_COMMAND = "weeklyExpense.cell.patch";
    public static final String CELLS_COPY_COMMAND = "weeklyExpense.cells.copy";
    public static final String CELLS_PASTE_COMMAND = "weeklyExpense.cells.paste";
    public static final String CELLS_CUT_COMMAND = "weeklyExpense.cells.cut";
    public static final String ROW_INSERT_COMMAND = "weeklyExpense.row.insert";
    public static final String ROW_DELETE_COMMAND = "weeklyExpense.row.delete";
    public static final String CASHFLOW_READ_COMMAND = "weeklyExpense.cashflow.read";
    public static final String CASHFLOW_VARIANCE_COMMAND = "cashflowVariance.update";
    public static final String CASHFLOW_MONTH_CLOSE_READ_COMMAND = "cashflowMonth.read";
    public static final String CLOSE_CASHFLOW_MONTH_COMMAND = "cashflowMonth.close";
    public static final String READ_CASHFLOW_WEEKLY_UPDATE_COMMAND = "cashflowWeeklyUpdate.read";
    public static final String COMPLETE_CASHFLOW_WEEKLY_UPDATE_COMMAND = "cashflowWeeklyUpdate.complete";
    public static final String REOPEN_CASHFLOW_WEEKLY_UPDATE_COMMAND = "cashflowWeeklyUpdate.reopen";
    public static final String CONFIRM_CASHFLOW_WEEKLY_UPDATE_COMMAND = "cashflowWeeklyUpdate.confirm";
    public static final String REQUEST_CASHFLOW_MONTH_REOPEN_COMMAND = "cashflowMonth.requestReopen";
    public static final String DECIDE_CASHFLOW_MONTH_REOPEN_COMMAND = "cashflowMonth.decideReopen";
    public static final String READ_CASHFLOW_MONTH_REOPEN_AUTHORITY_COMMAND = "cashflowMonth.readReopenAuthority";
    public static final String SUBMIT_CASHFLOW_SETTLEMENT_CYCLE_COMMAND = "cashflowSettlementCycle.submit";
    public static final String TRANSITION_CASHFLOW_SETTLEMENT_CYCLE_COMMAND = "cashflowSettlementCycle.transition";
    public static final String CANCEL_CASHFLOW_SETTLEMENT_CYCLE_COMMAND =
        "cashflowSettlementCycle.cancelActive";
    public static final String MIGRATE_CASHFLOW_SETTLEMENT_CYCLE_HEAD_V2_COMMAND =
        "cashflowSettlementCycle.migrateHeadV2";
    public static final String NORMALIZE_LEGACY_CASHFLOW_SETTLEMENT_CYCLE_REQUEST_COMMAND =
        "cashflowSettlementCycle.normalizeLegacyActiveRequest";
    public static final String AUDIT_EXPORT_CREATE_COMMAND = "weeklyExpense.auditExport.create";

    private static final Pattern WEEK_LABEL_PATTERN = Pattern.compile("(20\\d{2}-\\d{2}).*?([1-6])");
    private static final Pattern SHORT_WEEK_LABEL_PATTERN = Pattern.compile("^(\\d{2})-(\\d{1,2})-([1-6])$");
    private static final int ROW_REINDEX_TEMPORARY_OFFSET = 1_000_000;
    private static final String CASHFLOW_SHEET_LAB_ACTUAL_SOURCE = "cashflow-sheet-lab";
    private static final Set<String> CASHFLOW_VARIANCE_REVIEW_ROLES = Set.of("admin", "finance", "tenant_admin");

    private final WeeklyExpensePersistence persistence;
    private final CashflowMonthReopenPort cashflowMonthReopenPort;
    private final WeeklyExpenseAuthorizationService authorizationService;
    private final WeeklyExpenseSpreadsheetService spreadsheetService;
    private final ObjectMapper objectMapper;
    private final boolean cashflowEditLeasesEnabled;

    public WeeklyExpenseCommandService(
        WeeklyExpensePersistence persistence,
        WeeklyExpenseAuthorizationService authorizationService,
        ObjectMapper objectMapper,
        @Value("${weekly.cashflow-edit-leases-enabled:false}") boolean cashflowEditLeasesEnabled,
        @Value("${weekly.deploy-env:local}") String deployEnv
    ) {
        String runtime = deployEnv == null ? "" : deployEnv.trim().toLowerCase(Locale.ROOT);
        if (cashflowEditLeasesEnabled && !"live".equals(runtime)) {
            throw new IllegalStateException("Cashflow edit leases require a deployed JVM runtime.");
        }
        this.persistence = persistence;
        this.cashflowMonthReopenPort = persistence;
        this.authorizationService = authorizationService;
        this.objectMapper = objectMapper;
        this.cashflowEditLeasesEnabled = cashflowEditLeasesEnabled;
        this.spreadsheetService = new WeeklyExpenseSpreadsheetService(new dev.merryai.innerplatform.weekly.domain.WeeklyExpenseCellValidator());
    }

    public void requireAllowed(String commandName, TrustedActorContext actor) {
        authorizationService.requireAllowed(commandName, actor);
    }

    public void requireProjectAllowed(String commandName, TrustedActorContext actor, String projectId) {
        authorizationService.requireProjectAllowed(commandName, actor, projectId);
    }

    public CashflowSettlementStatusesResponse readCashflowSettlementStatuses(
        TrustedActorContext actor,
        String projectId,
        String yearMonth
    ) {
        return readCashflowSettlementStatuses(actor, projectId, yearMonth, false);
    }

    public CashflowSettlementStatusesResponse readCashflowSettlementStatuses(
        TrustedActorContext actor,
        String projectId,
        String yearMonth,
        boolean settlementCycle
    ) {
        if (settlementCycle) {
            CashflowWeeklyOverviewResponse.Item item =
                readCashflowSettlementCycleDashboardItem(actor, projectId, yearMonth);
            if (!"OK".equals(item.settlementCycle().health())
                || "INCONSISTENT".equals(item.settlementCycle().businessState())) {
                throw new WeeklyExpenseEditLeaseException(
                    503,
                    "cashflow_settlement_cycle_read_unavailable",
                    "Cashflow settlement cycle projection is unavailable."
                );
            }
            return item.settlementStatuses();
        }
        authorizationService.requireProjectAllowed(CASHFLOW_MONTH_CLOSE_READ_COMMAND, actor, projectId);
        return settlementStatusesResponse(
            projectId,
            yearMonth,
            yearMonth,
            persistence.findCashflowSettlementStatuses(actor.tenantId(), projectId, yearMonth)
        );
    }

    public CashflowSettlementStatusesBatchResponse readCashflowSettlementStatusesBatch(
        TrustedActorContext actor,
        CashflowSettlementStatusesBatchRequest request
    ) {
        return readCashflowSettlementStatusesBatch(actor, request, false);
    }

    public CashflowSettlementStatusesBatchResponse readCashflowSettlementStatusesBatch(
        TrustedActorContext actor,
        CashflowSettlementStatusesBatchRequest request,
        boolean settlementCycle
    ) {
        List<String> projectIds = request.requireUniqueProjectIds();
        authorizationService.requireProjectsAllowed(CASHFLOW_MONTH_CLOSE_READ_COMMAND, actor, projectIds);
        if (settlementCycle) {
            CashflowSettlementCyclePolicy.Identity identity =
                CashflowSettlementCyclePolicy.identity(request.yearMonth());
            Map<String, WeeklyExpensePersistence.CashflowSettlementCycleRecord> cyclesByProject;
            try {
                cyclesByProject = persistence.findCashflowSettlementCyclesBatch(
                    actor, projectIds, identity.cycleYearMonth(), identity.monthCloseTargetYearMonth()
                );
            } catch (RuntimeException unavailable) {
                cyclesByProject = Map.of();
            }
            List<CashflowSettlementStatusesResponse> items = new ArrayList<>();
            List<CashflowSettlementStatusesBatchResponse.ErrorItem> errors = new ArrayList<>();
            for (String projectId : projectIds) {
                WeeklyExpensePersistence.CashflowSettlementCycleRecord cycle = cyclesByProject.get(projectId);
                if (cycle == null
                    || cycle.projection().health() != CashflowSettlementCyclePolicy.Health.OK
                    || cycle.projection().businessState() == CashflowSettlementCyclePolicy.BusinessState.INCONSISTENT) {
                    errors.add(new CashflowSettlementStatusesBatchResponse.ErrorItem(
                        projectId, CashflowSettlementStatusesBatchResponse.STATUS_UNAVAILABLE
                    ));
                } else {
                    items.add(settlementStatusesResponse(
                        projectId,
                        cycle.cycleYearMonth(),
                        cycle.monthCloseTargetYearMonth(),
                        cycle.weeklySettlements()
                    ));
                }
            }
            return new CashflowSettlementStatusesBatchResponse(items, errors);
        }
        Map<String, List<WeeklyExpensePersistence.CashflowSettlementStatusRecord>> recordsByProject =
            persistence.findCashflowSettlementStatusesBatch(actor.tenantId(), projectIds, request.yearMonth());
        List<CashflowSettlementStatusesResponse> items = new ArrayList<>();
        List<CashflowSettlementStatusesBatchResponse.ErrorItem> errors = new ArrayList<>();
        for (String projectId : projectIds) {
            List<WeeklyExpensePersistence.CashflowSettlementStatusRecord> records = recordsByProject.get(projectId);
            if (records == null) {
                errors.add(new CashflowSettlementStatusesBatchResponse.ErrorItem(
                    projectId, CashflowSettlementStatusesBatchResponse.STATUS_UNAVAILABLE
                ));
            } else {
                items.add(settlementStatusesResponse(
                    projectId,
                    request.yearMonth(),
                    request.yearMonth(),
                    records
                ));
            }
        }
        return new CashflowSettlementStatusesBatchResponse(items, errors);
    }

    public CashflowSettlementStatusesResponse transitionCashflowSettlementStatus(
        TrustedActorContext actor,
        String projectId,
        TransitionCashflowSettlementStatusRequest request
    ) {
        CashflowSettlementCyclePolicy.requireWeeklyTransitionPeriod(request.period());
        if ("APPROVE".equals(request.action())) {
            requireCashflowMonthClosePermission(CLOSE_CASHFLOW_MONTH_COMMAND, actor, projectId);
        } else {
            throw new WeeklyExpenseForbiddenException("A settlement can only be submitted by its completion workflow.");
        }
        List<WeeklyExpensePersistence.CashflowSettlementStatusRecord> records = new ArrayList<>(
            persistence.findCashflowSettlementStatuses(actor.tenantId(), projectId, request.yearMonth())
        );
        WeeklyExpensePersistence.CashflowSettlementStatusRecord updated = persistence.transitionCashflowSettlementStatus(
            actor, projectId, request.yearMonth(), request.period(), request.action()
        );
        records.replaceAll(record -> record.period().equals(updated.period()) ? updated : record);
        return settlementStatusesResponse(
            projectId,
            request.yearMonth(),
            request.yearMonth(),
            records
        );
    }

    public CashflowSettlementCycleCommandResponse submitCashflowSettlementCycle(
        TrustedActorContext actor,
        String projectId,
        SubmitCashflowSettlementCycleRequest request
    ) {
        TrustedActorContext writer = requireCashflowMonthClosePermission(
            SUBMIT_CASHFLOW_SETTLEMENT_CYCLE_COMMAND, actor, projectId
        );
        String requestHash = hashJson(Map.of("actorUid", writer.id(), "request", request));
        Optional<CashflowSettlementCycleCommandResponse> replay = readIdempotentResponse(
            writer.tenantId(), projectId, SUBMIT_CASHFLOW_SETTLEMENT_CYCLE_COMMAND,
            request.idempotencyKey(), requestHash, CashflowSettlementCycleCommandResponse.class
        );
        if (replay.isPresent()) return replay.get();

        WeeklyExpensePersistence.CashflowSettlementCycleCommandState saved =
            persistence.submitCashflowSettlementCycle(writer, projectId, request);
        WeeklyExpenseAuditEventEntity audit = saveSettlementCycleAudit(
            writer, projectId, SUBMIT_CASHFLOW_SETTLEMENT_CYCLE_COMMAND,
            request.idempotencyKey(), saved
        );
        CashflowSettlementCycleCommandResponse response = settlementCycleCommandResponse(
            SUBMIT_CASHFLOW_SETTLEMENT_CYCLE_COMMAND, saved, audit.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(), projectId, request.idempotencyKey(),
            SUBMIT_CASHFLOW_SETTLEMENT_CYCLE_COMMAND, requestHash, writeJson(response)
        ));
        return response;
    }

    public CashflowSettlementCycleCommandResponse transitionCashflowSettlementCycle(
        TrustedActorContext actor,
        String projectId,
        TransitionCashflowSettlementCycleRequest request
    ) {
        TrustedActorContext writer;
        if ("REJECT".equals(request.action())) {
            if (request.reason().isBlank()) {
                throw new IllegalArgumentException("A reason is required to reject a cashflow settlement cycle.");
            }
            writer = requireCashflowMonthReopenDecisionPermission(actor, projectId);
        } else if ("WITHDRAW".equals(request.action())) {
            writer = requireCashflowMonthClosePermission(
                TRANSITION_CASHFLOW_SETTLEMENT_CYCLE_COMMAND, actor, projectId
            );
        } else {
            throw new IllegalArgumentException("Cashflow settlement cycle action must be WITHDRAW or REJECT.");
        }
        String requestHash = hashJson(Map.of("actorUid", writer.id(), "request", request));
        Optional<CashflowSettlementCycleCommandResponse> replay = readIdempotentResponse(
            writer.tenantId(), projectId, TRANSITION_CASHFLOW_SETTLEMENT_CYCLE_COMMAND,
            request.idempotencyKey(), requestHash, CashflowSettlementCycleCommandResponse.class
        );
        if (replay.isPresent()) return replay.get();

        WeeklyExpensePersistence.CashflowSettlementCycleCommandState saved =
            persistence.transitionCashflowSettlementCycle(writer, projectId, request);
        WeeklyExpenseAuditEventEntity audit = saveSettlementCycleAudit(
            writer, projectId, TRANSITION_CASHFLOW_SETTLEMENT_CYCLE_COMMAND,
            request.idempotencyKey(), saved
        );
        CashflowSettlementCycleCommandResponse response = settlementCycleCommandResponse(
            TRANSITION_CASHFLOW_SETTLEMENT_CYCLE_COMMAND, saved, audit.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(), projectId, request.idempotencyKey(),
            TRANSITION_CASHFLOW_SETTLEMENT_CYCLE_COMMAND, requestHash, writeJson(response)
        ));
        return response;
    }

    public CashflowSettlementCycleCommandResponse cancelCashflowSettlementCycle(
        TrustedActorContext actor,
        String projectId,
        CancelCashflowSettlementCycleRequest request
    ) {
        if (request.reason().isBlank()) {
            throw new IllegalArgumentException(
                "A reason is required to cancel an active cashflow settlement cycle."
            );
        }
        TrustedActorContext writer = requireCashflowMonthClosePermission(
            CANCEL_CASHFLOW_SETTLEMENT_CYCLE_COMMAND, actor, projectId
        );
        String requestHash = hashJson(Map.of("actorUid", writer.id(), "request", request));
        Optional<CashflowSettlementCycleCommandResponse> replay = readIdempotentResponse(
            writer.tenantId(), projectId, CANCEL_CASHFLOW_SETTLEMENT_CYCLE_COMMAND,
            request.idempotencyKey(), requestHash, CashflowSettlementCycleCommandResponse.class
        );
        if (replay.isPresent()) return replay.get();

        WeeklyExpensePersistence.CashflowSettlementCycleCommandState saved =
            persistence.cancelCashflowSettlementCycle(writer, projectId, request);
        WeeklyExpenseAuditEventEntity audit = saveDeterministicSettlementCycleAudit(
            writer, projectId, CANCEL_CASHFLOW_SETTLEMENT_CYCLE_COMMAND,
            request.idempotencyKey(), saved
        );
        CashflowSettlementCycleCommandResponse response = settlementCycleCommandResponse(
            CANCEL_CASHFLOW_SETTLEMENT_CYCLE_COMMAND, saved, audit.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(), projectId, request.idempotencyKey(),
            CANCEL_CASHFLOW_SETTLEMENT_CYCLE_COMMAND, requestHash, writeJson(response)
        ));
        return response;
    }

    public CashflowSettlementCycleHeadMigrationResponse migrateCashflowSettlementCycleHeadV2(
        TrustedActorContext actor,
        String projectId,
        MigrateCashflowSettlementCycleHeadV2Request request
    ) {
        TrustedActorContext writer = requireCashflowMonthClosePermission(
            MIGRATE_CASHFLOW_SETTLEMENT_CYCLE_HEAD_V2_COMMAND, actor, projectId
        );
        String requestHash = hashJson(Map.of("actorUid", writer.id(), "request", request));
        Optional<CashflowSettlementCycleHeadMigrationResponse> replay = request.dryRun()
            ? Optional.empty()
            : readIdempotentResponse(
                writer.tenantId(), projectId, MIGRATE_CASHFLOW_SETTLEMENT_CYCLE_HEAD_V2_COMMAND,
                request.idempotencyKey(), requestHash, CashflowSettlementCycleHeadMigrationResponse.class
            );
        if (replay.isPresent()) return replay.get();

        WeeklyExpensePersistence.CashflowSettlementCycleHeadMigrationState saved =
            persistence.migrateCashflowSettlementCycleHeadV2(writer, projectId, request);
        if (request.dryRun() || !saved.migrationRequired()) {
            return new CashflowSettlementCycleHeadMigrationResponse(
                true,
                MIGRATE_CASHFLOW_SETTLEMENT_CYCLE_HEAD_V2_COMMAND,
                saved.projectId(),
                saved.closedThrough(),
                saved.cycleYearMonth(),
                saved.approvalVersionId(),
                saved.headRevision(),
                saved.migrationFingerprint(),
                saved.migrationRequired(),
                ""
            );
        }
        String auditId = "settlement-cycle-head-migration-" + hashJson(Map.of(
            "tenantId", writer.tenantId(),
            "projectId", projectId,
            "actorUid", writer.id(),
            "idempotencyKey", request.idempotencyKey()
        )).replace("sha256:", "");
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("closedThrough", saved.closedThrough());
        metadata.put("cycleYearMonth", saved.cycleYearMonth());
        metadata.put("approvalVersionId", saved.approvalVersionId());
        metadata.put("headRevision", saved.headRevision());
        metadata.put("migrationFingerprint", saved.migrationFingerprint());
        metadata.put("reason", request.reason());
        putActorMetadata(metadata, writer);
        WeeklyExpenseAuditEventEntity audit = new WeeklyExpenseAuditEventEntity(
            writer.tenantId(), projectId, "settlement-cycle", MIGRATE_CASHFLOW_SETTLEMENT_CYCLE_HEAD_V2_COMMAND,
            writer.id(), normalizeRole(writer.role()), request.idempotencyKey(), writeJson(metadata)
        );
        audit.restorePersistenceState(auditId, audit.getCreatedAt());
        persistence.saveAuditEvent(audit);
        CashflowSettlementCycleHeadMigrationResponse response =
            new CashflowSettlementCycleHeadMigrationResponse(
                true,
                MIGRATE_CASHFLOW_SETTLEMENT_CYCLE_HEAD_V2_COMMAND,
                saved.projectId(),
                saved.closedThrough(),
                saved.cycleYearMonth(),
                saved.approvalVersionId(),
                saved.headRevision(),
                saved.migrationFingerprint(),
                true,
                auditId
            );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(), projectId, request.idempotencyKey(),
            MIGRATE_CASHFLOW_SETTLEMENT_CYCLE_HEAD_V2_COMMAND, requestHash, writeJson(response)
        ));
        return response;
    }

    public CashflowSettlementCycleLegacyRequestNormalizationResponse normalizeLegacyCashflowSettlementCycleRequest(
        TrustedActorContext actor,
        String projectId,
        NormalizeLegacyCashflowSettlementCycleRequest request
    ) {
        TrustedActorContext writer = requireCashflowMonthClosePermission(
            NORMALIZE_LEGACY_CASHFLOW_SETTLEMENT_CYCLE_REQUEST_COMMAND, actor, projectId
        );
        String requestHash = hashJson(Map.of("actorUid", writer.id(), "request", request));
        Optional<CashflowSettlementCycleLegacyRequestNormalizationResponse> replay = request.dryRun()
            ? Optional.empty()
            : readIdempotentResponse(
                writer.tenantId(), projectId,
                NORMALIZE_LEGACY_CASHFLOW_SETTLEMENT_CYCLE_REQUEST_COMMAND,
                request.idempotencyKey(), requestHash,
                CashflowSettlementCycleLegacyRequestNormalizationResponse.class
            );
        if (replay.isPresent()) return replay.get();

        WeeklyExpensePersistence.CashflowSettlementCycleLegacyRequestNormalizationState saved =
            persistence.normalizeLegacyCashflowSettlementCycleRequest(writer, projectId, request);
        if (request.dryRun() || !saved.migrationRequired()) {
            return legacyRequestNormalizationResponse(saved, "");
        }
        String auditId = "settlement-cycle-request-normalization-" + hashJson(Map.of(
            "tenantId", writer.tenantId(),
            "projectId", projectId,
            "actorUid", writer.id(),
            "idempotencyKey", request.idempotencyKey()
        )).replace("sha256:", "");
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("cycleYearMonth", saved.cycleYearMonth());
        metadata.put("monthCloseTargetYearMonth", saved.monthCloseTargetYearMonth());
        metadata.put("requestId", saved.requestId());
        metadata.put("workflowRevision", saved.workflowRevision());
        metadata.put("evidenceRevision", saved.evidenceRevision());
        metadata.put("migrationFingerprint", saved.migrationFingerprint());
        metadata.put("reason", request.reason());
        putActorMetadata(metadata, writer);
        WeeklyExpenseAuditEventEntity audit = new WeeklyExpenseAuditEventEntity(
            writer.tenantId(), projectId, "settlement-cycle",
            NORMALIZE_LEGACY_CASHFLOW_SETTLEMENT_CYCLE_REQUEST_COMMAND,
            writer.id(), normalizeRole(writer.role()), request.idempotencyKey(), writeJson(metadata)
        );
        audit.restorePersistenceState(auditId, audit.getCreatedAt());
        persistence.saveAuditEvent(audit);
        CashflowSettlementCycleLegacyRequestNormalizationResponse response =
            legacyRequestNormalizationResponse(saved, auditId);
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(), projectId, request.idempotencyKey(),
            NORMALIZE_LEGACY_CASHFLOW_SETTLEMENT_CYCLE_REQUEST_COMMAND,
            requestHash, writeJson(response)
        ));
        return response;
    }

    private CashflowSettlementCycleLegacyRequestNormalizationResponse legacyRequestNormalizationResponse(
        WeeklyExpensePersistence.CashflowSettlementCycleLegacyRequestNormalizationState saved,
        String auditId
    ) {
        return new CashflowSettlementCycleLegacyRequestNormalizationResponse(
            true,
            NORMALIZE_LEGACY_CASHFLOW_SETTLEMENT_CYCLE_REQUEST_COMMAND,
            saved.projectId(),
            saved.cycleYearMonth(),
            saved.monthCloseTargetYearMonth(),
            saved.requestId(),
            saved.workflowRevision(),
            saved.evidenceRevision(),
            saved.migrationFingerprint(),
            saved.migrationRequired(),
            auditId
        );
    }

    private WeeklyExpenseAuditEventEntity saveSettlementCycleAudit(
        TrustedActorContext actor,
        String projectId,
        String commandName,
        String idempotencyKey,
        WeeklyExpensePersistence.CashflowSettlementCycleCommandState state
    ) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("cycleYearMonth", state.cycleYearMonth());
        metadata.put("monthCloseTargetYearMonth", state.monthCloseTargetYearMonth());
        metadata.put("requestId", state.requestId());
        metadata.put("businessState", state.businessState());
        metadata.put("workflowRevision", state.workflowRevision());
        metadata.put("evidenceRevision", state.evidenceRevision());
        metadata.put("manifestHash", state.manifestHash());
        metadata.put("reason", state.reason());
        putActorMetadata(metadata, actor);
        return persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            actor.tenantId(), projectId, "settlement-cycle", commandName,
            actor.id(), normalizeRole(actor.role()), idempotencyKey, writeJson(metadata)
        ));
    }

    private WeeklyExpenseAuditEventEntity saveDeterministicSettlementCycleAudit(
        TrustedActorContext actor,
        String projectId,
        String commandName,
        String idempotencyKey,
        WeeklyExpensePersistence.CashflowSettlementCycleCommandState state
    ) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("cycleYearMonth", state.cycleYearMonth());
        metadata.put("monthCloseTargetYearMonth", state.monthCloseTargetYearMonth());
        metadata.put("requestId", state.requestId());
        metadata.put("businessState", state.businessState());
        metadata.put("workflowRevision", state.workflowRevision());
        metadata.put("reason", state.reason());
        putActorMetadata(metadata, actor);
        WeeklyExpenseAuditEventEntity audit = new WeeklyExpenseAuditEventEntity(
            actor.tenantId(), projectId, "settlement-cycle", commandName,
            actor.id(), normalizeRole(actor.role()), idempotencyKey, writeJson(metadata)
        );
        String auditId = "settlement-cycle-recovery-" + hashJson(Map.of(
            "tenantId", actor.tenantId(),
            "projectId", projectId,
            "commandName", commandName,
            "actorUid", actor.id(),
            "idempotencyKey", idempotencyKey
        )).replace("sha256:", "");
        Instant decidedAt;
        try {
            decidedAt = Instant.parse(state.decidedAt());
        } catch (RuntimeException error) {
            decidedAt = audit.getCreatedAt();
        }
        audit.restorePersistenceState(auditId, decidedAt);
        return persistence.saveAuditEvent(audit);
    }

    private CashflowSettlementCycleCommandResponse settlementCycleCommandResponse(
        String commandName,
        WeeklyExpensePersistence.CashflowSettlementCycleCommandState state,
        String auditId
    ) {
        return new CashflowSettlementCycleCommandResponse(
            true, commandName, state.projectId(), state.cycleYearMonth(),
            state.monthCloseTargetYearMonth(), state.requestId(), state.businessState(),
            state.workflowRevision(), state.evidenceRevision(), state.manifestHash(),
            state.submittedAt(), state.submittedByUid(), state.approverUid(),
            state.decidedAt(), state.decidedByUid(), state.reason(), auditId
        );
    }

    private CashflowSettlementStatusesResponse settlementStatusesResponse(
        String projectId,
        String weeklyYearMonth,
        String monthYearMonth,
        List<WeeklyExpensePersistence.CashflowSettlementStatusRecord> records
    ) {
        return new CashflowSettlementStatusesResponse(
            projectId,
            weeklyYearMonth,
            records.stream().map(record -> settlementStatusItem(
                "MONTH".equals(record.period()) ? monthYearMonth : weeklyYearMonth,
                record
            )).toList()
        );
    }

    private static CashflowSettlementStatusesResponse.Item settlementStatusItem(
        String yearMonth,
        WeeklyExpensePersistence.CashflowSettlementStatusRecord record
    ) {
        String deadlineAt = null;
        String approverDeadlineAt = null;
        if ("MONTH".equals(record.period())) {
            YearMonth targetMonth = YearMonth.parse(yearMonth);
            deadlineAt = CashflowCloseDeadline.settlementDeadlineAt(targetMonth).toString();
            approverDeadlineAt = ApproverDeadlineCalculator.monthly(yearMonth).toString();
        } else if (record.period() != null && record.period().matches("WEEK_[1-5]")) {
            // 주정산도 JVM 이 기한의 단일 소스다. 이전에는 BFF 가 같은 규칙 사본으로 채웠는데,
            // 사본만 살아 있으면 규칙이 조용히 갈린다 (CashflowWeekDeadline Javadoc 참고).
            int weekNo = record.period().charAt(5) - '0';
            Instant practitionerDeadline =
                CashflowWeekDeadline.practitionerDeadlineAt(YearMonth.parse(yearMonth), weekNo);
            deadlineAt = practitionerDeadline.toString();
            // 조직장 승인은 실무자 마감 + 13시간 = 같은 날 13:00 KST.
            approverDeadlineAt =
                ApproverDeadlineCalculator.weekly(practitionerDeadline, Duration.ofHours(13)).toString();
        }
        return new CashflowSettlementStatusesResponse.Item(
            record.period(), record.status(), record.submittedAt(), record.submittedBy(),
            record.approvedAt(), record.approvedBy(), record.revision(), deadlineAt, approverDeadlineAt
        );
    }

    public CashflowProjectionActualSummaryBatchResponse readCashflowProjectionActualSummaries(
        TrustedActorContext actor,
        CashflowProjectionActualSummaryBatchRequest request
    ) {
        List<String> projectIds = request.requireUniqueProjectIds();
        try {
            authorizationService.requireProjectsAllowed(CASHFLOW_READ_COMMAND, actor, projectIds);
        } catch (WeeklyExpenseForbiddenException denied) {
            throw new WeeklyExpenseForbiddenException("One or more projects are not accessible.");
        }
        CashflowProjectionActualSummaryCalculator.FinanceWeek boundary =
            CashflowProjectionActualSummaryCalculator.currentFinanceWeek(Clock.systemUTC());
        String selectedYearMonth = request.yearMonth() == null ? boundary.yearMonth() : request.yearMonth();
        String throughMonth = selectedYearMonth.compareTo(boundary.yearMonth()) > 0 ? selectedYearMonth : boundary.yearMonth();
        List<CashflowProjectionActualSummaryBatchResponse.Item> items = new ArrayList<>();
        List<CashflowProjectionActualSummaryBatchResponse.ErrorItem> errors = new ArrayList<>();
        Map<String, Integer> weeklyYearsByProject;
        Map<String, CashflowLedgerSource> sourcesByProject;
        try {
            weeklyYearsByProject = persistence.findCashflowDeclaredWeeklyYears(actor.tenantId(), projectIds);
            sourcesByProject = persistence.findCashflowLedgerSources(
                actor.tenantId(), weeklyYearsByProject,
                CashflowProjectionActualSummaryCalculator.FROM_MONTH, throughMonth
            );
        } catch (RuntimeException unavailable) {
            return new CashflowProjectionActualSummaryBatchResponse(
                "1", List.of(), projectIds.stream().map(projectId -> new CashflowProjectionActualSummaryBatchResponse.ErrorItem(
                    projectId, CashflowProjectionActualSummaryBatchResponse.SUMMARY_UNAVAILABLE
                )).toList()
            );
        }
        for (String projectId : projectIds) {
            CashflowLedgerSource source = sourcesByProject.get(projectId);
            if (source == null) {
                errors.add(new CashflowProjectionActualSummaryBatchResponse.ErrorItem(
                    projectId, CashflowProjectionActualSummaryBatchResponse.SUMMARY_UNAVAILABLE
                ));
                continue;
            }
            try {
                items.add(toProjectionActualSummary(projectId, source, boundary, selectedYearMonth));
            } catch (WeeklyExpenseForbiddenException denied) {
                throw denied;
            } catch (RuntimeException unavailable) {
                errors.add(new CashflowProjectionActualSummaryBatchResponse.ErrorItem(
                    projectId, CashflowProjectionActualSummaryBatchResponse.SUMMARY_UNAVAILABLE
                ));
            }
        }
        return new CashflowProjectionActualSummaryBatchResponse("1", items, errors);
    }

    public CashflowWeeklyOverviewResponse readCashflowWeeklyOverview(
        TrustedActorContext actor,
        CashflowWeeklyOverviewRequest request
    ) {
        List<String> projectIds = request.requireUniqueProjectIds();
        authorizationService.requireProjectsAllowedForCommands(
            List.of(CASHFLOW_READ_COMMAND, CASHFLOW_MONTH_CLOSE_READ_COMMAND), actor, projectIds
        );
        if (!request.settlementCycle()) {
            return readLegacyCashflowWeeklyOverview(actor, request, projectIds);
        }
        CashflowProjectionActualSummaryCalculator.FinanceWeek boundary =
            CashflowProjectionActualSummaryCalculator.currentFinanceWeek(Clock.systemUTC());
        String throughMonth = request.yearMonth().compareTo(boundary.yearMonth()) > 0
            ? request.yearMonth() : boundary.yearMonth();
        Map<String, CashflowLedgerSource> sourcesByProject;
        Map<String, WeeklyExpensePersistence.CashflowSettlementCycleRecord> cyclesByProject;
        CashflowSettlementCyclePolicy.Identity cycleIdentity =
            CashflowSettlementCyclePolicy.identity(request.yearMonth());
        CompletableFuture<Map<String, CashflowLedgerSource>> sourcesFuture =
            CompletableFuture.supplyAsync(() -> persistence.findCashflowLedgerSources(
                actor.tenantId(), projectIds, CashflowProjectionActualSummaryCalculator.FROM_MONTH, throughMonth
            ));
        CompletableFuture<Map<String, WeeklyExpensePersistence.CashflowSettlementCycleRecord>> cyclesFuture =
            CompletableFuture.supplyAsync(() -> persistence.findCashflowSettlementCyclesBatch(
                actor, projectIds, cycleIdentity.cycleYearMonth(),
                cycleIdentity.monthCloseTargetYearMonth()
            ));
        try {
            sourcesByProject = sourcesFuture.join();
        } catch (RuntimeException unavailable) {
            sourcesByProject = Map.of();
        }
        try {
            cyclesByProject = cyclesFuture.join();
        } catch (RuntimeException unavailable) {
            cyclesByProject = Map.of();
        }
        List<CashflowWeeklyOverviewResponse.Item> items = new ArrayList<>();
        List<CashflowWeeklyOverviewResponse.ErrorItem> errors = new ArrayList<>();
        for (String projectId : projectIds) {
            WeeklyExpensePersistence.CashflowSettlementCycleRecord cycle = cyclesByProject.get(projectId);
            CashflowSettlementStatusesResponse statuses = null;
            List<WeeklyExpensePersistence.CashflowSettlementStatusRecord> records = cycle == null
                ? null : cycle.weeklySettlements();
            if (records == null) {
                errors.add(new CashflowWeeklyOverviewResponse.ErrorItem(
                    projectId, CashflowWeeklyOverviewResponse.STATUS_UNAVAILABLE
                ));
            } else {
                statuses = settlementStatusesResponse(
                    projectId,
                    cycle.cycleYearMonth(),
                    cycle.monthCloseTargetYearMonth(),
                    records
                );
            }
            CashflowProjectionActualSummaryBatchResponse.Item summary = null;
            CashflowLedgerSource source = sourcesByProject.get(projectId);
            if (source == null) {
                errors.add(new CashflowWeeklyOverviewResponse.ErrorItem(
                    projectId, CashflowWeeklyOverviewResponse.SUMMARY_UNAVAILABLE
                ));
            } else {
                summary = toProjectionActualSummary(projectId, source, boundary, request.yearMonth());
            }
            CashflowWeeklyOverviewResponse.SettlementCycle settlementCycle = null;
            if (cycle == null) {
                errors.add(new CashflowWeeklyOverviewResponse.ErrorItem(
                    projectId, CashflowWeeklyOverviewResponse.MONTH_CLOSE_UNAVAILABLE
                ));
            } else {
                settlementCycle = settlementCycleResponse(cycle);
            }
            items.add(new CashflowWeeklyOverviewResponse.Item(projectId, statuses, summary, settlementCycle));
        }
        return new CashflowWeeklyOverviewResponse("2", request.yearMonth(), items, errors);
    }

    private CashflowWeeklyOverviewResponse readLegacyCashflowWeeklyOverview(
        TrustedActorContext actor,
        CashflowWeeklyOverviewRequest request,
        List<String> projectIds
    ) {
        CashflowProjectionActualSummaryCalculator.FinanceWeek boundary =
            CashflowProjectionActualSummaryCalculator.currentFinanceWeek(Clock.systemUTC());
        String throughMonth = request.yearMonth().compareTo(boundary.yearMonth()) > 0
            ? request.yearMonth() : boundary.yearMonth();
        Map<String, List<WeeklyExpensePersistence.CashflowSettlementStatusRecord>> statusesByProject;
        Map<String, CashflowLedgerSource> sourcesByProject;
        CompletableFuture<Map<String, List<WeeklyExpensePersistence.CashflowSettlementStatusRecord>>> statusesFuture =
            CompletableFuture.supplyAsync(() -> persistence.findCashflowSettlementStatusesBatch(
                actor.tenantId(), projectIds, request.yearMonth()
            ));
        CompletableFuture<Map<String, CashflowLedgerSource>> sourcesFuture =
            CompletableFuture.supplyAsync(() -> persistence.findCashflowLedgerSources(
                actor.tenantId(), projectIds,
                CashflowProjectionActualSummaryCalculator.FROM_MONTH, throughMonth
            ));
        try {
            statusesByProject = statusesFuture.join();
        } catch (RuntimeException unavailable) {
            statusesByProject = Map.of();
        }
        try {
            sourcesByProject = sourcesFuture.join();
        } catch (RuntimeException unavailable) {
            sourcesByProject = Map.of();
        }
        List<CashflowWeeklyOverviewResponse.Item> items = new ArrayList<>();
        List<CashflowWeeklyOverviewResponse.ErrorItem> errors = new ArrayList<>();
        for (String projectId : projectIds) {
            List<WeeklyExpensePersistence.CashflowSettlementStatusRecord> records =
                statusesByProject.get(projectId);
            CashflowSettlementStatusesResponse statuses = null;
            if (records == null) {
                errors.add(new CashflowWeeklyOverviewResponse.ErrorItem(
                    projectId, CashflowWeeklyOverviewResponse.STATUS_UNAVAILABLE
                ));
            } else {
                statuses = settlementStatusesResponse(
                    projectId,
                    request.yearMonth(),
                    request.yearMonth(),
                    records
                );
            }
            CashflowLedgerSource source = sourcesByProject.get(projectId);
            CashflowProjectionActualSummaryBatchResponse.Item summary = null;
            if (source == null) {
                errors.add(new CashflowWeeklyOverviewResponse.ErrorItem(
                    projectId, CashflowWeeklyOverviewResponse.SUMMARY_UNAVAILABLE
                ));
            } else {
                summary = toProjectionActualSummary(projectId, source, boundary, request.yearMonth());
            }
            items.add(new CashflowWeeklyOverviewResponse.Item(projectId, statuses, summary, null));
        }
        return new CashflowWeeklyOverviewResponse("1", request.yearMonth(), items, errors);
    }

    public CashflowWeeklyOverviewResponse.Item readCashflowSettlementCycleDashboardItem(
        TrustedActorContext actor,
        String projectId,
        String cycleYearMonth
    ) {
        authorizationService.requireProjectAllowed(
            CASHFLOW_MONTH_CLOSE_READ_COMMAND, actor, projectId
        );
        CashflowSettlementCyclePolicy.Identity identity =
            CashflowSettlementCyclePolicy.identity(cycleYearMonth);
        WeeklyExpensePersistence.CashflowSettlementCycleRecord cycle = persistence
            .findCashflowSettlementCyclesBatch(
                actor, List.of(projectId), identity.cycleYearMonth(),
                identity.monthCloseTargetYearMonth()
            )
            .get(projectId);
        if (cycle == null) {
            throw new WeeklyExpenseEditLeaseException(
                503,
                "cashflow_settlement_cycle_read_unavailable",
                "Cashflow settlement cycle projection is unavailable."
            );
        }
        return new CashflowWeeklyOverviewResponse.Item(
            projectId,
            settlementStatusesResponse(
                projectId,
                cycle.cycleYearMonth(),
                cycle.monthCloseTargetYearMonth(),
                cycle.weeklySettlements()
            ),
            null,
            settlementCycleResponse(cycle)
        );
    }

    private CashflowWeeklyOverviewResponse.SettlementCycle settlementCycleResponse(
        WeeklyExpensePersistence.CashflowSettlementCycleRecord cycle
    ) {
        CashflowSettlementCyclePolicy.Projection projection = cycle.projection();
        CashflowSettlementCyclePolicy.ApprovalProvenance provenance = projection.provenance();
        WeeklyExpensePersistence.CashflowSettlementCycleAuthority authority = cycle.authority();
        Map<String, CashflowWeeklyOverviewResponse.CommandCapability> commandCapabilities =
            new LinkedHashMap<>();
        CashflowSettlementCyclePolicy.commandCapabilities(
            new CashflowSettlementCyclePolicy.CapabilityFacts(
                projection,
                authority.activeMember(),
                authority.projectWriter(),
                authority.currentApprover(),
                authority.requester(),
                authority.recoveryAdmin(),
                authority.coordinatorInactive(),
                authority.latestApprovalAuthority()
            )
        ).forEach((command, capability) -> commandCapabilities.put(
            command.name(),
            new CashflowWeeklyOverviewResponse.CommandCapability(
                capability.allowed(), capability.reasonCode()
            )
        ));
        return new CashflowWeeklyOverviewResponse.SettlementCycle(
            cycle.cycleYearMonth(), cycle.cycleYearMonth(), cycle.monthCloseTargetYearMonth(),
            CashflowCloseDeadline.forCumulativeCycle(YearMonth.parse(cycle.cycleYearMonth())).toString(),
            projection.businessState().name(), projection.health().name(),
            projection.workflowRevision(),
            cycle.monthSettlement() == null
                ? null
                : settlementStatusItem(cycle.monthCloseTargetYearMonth(), cycle.monthSettlement()),
            provenance == null ? null : new CashflowWeeklyOverviewResponse.ApprovalProvenance(
                provenance.affectedFromMonth(), provenance.affectedThroughMonth(),
                provenance.closedByCycleYearMonth(), provenance.approvalVersionId(),
                provenance.requestId(), provenance.ledgerRevision(), provenance.rootHash()
            ),
            projection.supersededAttempt().isBlank() ? null : projection.supersededAttempt(),
            commandCapabilities
        );
    }

    public CashflowProjectionActualSummaryBatchResponse.Item readCashflowProjectionActualSummary(
        TrustedActorContext actor,
        String projectId,
        CashflowLedgerSource source
    ) {
        authorizationService.requireProjectAllowed(CASHFLOW_READ_COMMAND, actor, projectId);
        CashflowProjectionActualSummaryCalculator.FinanceWeek boundary =
            CashflowProjectionActualSummaryCalculator.currentFinanceWeek(Clock.systemUTC());
        return toProjectionActualSummary(projectId, source, boundary, boundary.yearMonth());
    }

    private CashflowProjectionActualSummaryBatchResponse.Item toProjectionActualSummary(
        String projectId,
        CashflowLedgerSource source,
        CashflowProjectionActualSummaryCalculator.FinanceWeek boundary,
        String selectedYearMonth
    ) {
        CashflowProjectionActualSummaryCalculator.Summary summary =
            CashflowProjectionActualSummaryCalculator.calculate(projectId, source.projection(), source.actual(), boundary, selectedYearMonth);
        return new CashflowProjectionActualSummaryBatchResponse.Item(
            summary.projectId(), summary.fromMonth(),
            new CashflowProjectionActualSummaryBatchResponse.ComparisonAsOfWeek(
                summary.comparisonAsOfWeek().yearMonth(), summary.comparisonAsOfWeek().weekNo()
            ),
            summary.projectionAmount(), summary.actualAmount(), summary.projectionActualDifferenceAmount(),
            summary.settlementDifferenceAmount(), summary.settlementMatches(),
            summary.periods().stream().map(period -> new CashflowProjectionActualSummaryBatchResponse.PeriodSummary(
                period.period(), period.projectionAmount(), period.actualAmount(), period.projectionActualDifferenceAmount()
            )).toList()
        );
    }

    public WeeklyExpenseSheetResponse readSheet(TrustedActorContext actor, String projectId, String sheetKey) {
        authorizationService.requireProjectAllowed(SHEET_READ_COMMAND, actor, projectId);
        Optional<WeeklyExpenseSheetEntity> found = persistence.findSheetForUpdate(actor.tenantId(), projectId, sheetKey);
        if (found.isEmpty()) {
            return new WeeklyExpenseSheetResponse(true, projectId, "", sheetKey, sheetKey, 0, List.of(), recentAuditEvents(actor.tenantId(), projectId));
        }
        return toSheetResponse(projectId, found.get(), recentAuditEvents(actor.tenantId(), projectId));
    }

    public WeeklyExpenseSheetsResponse listSheets(TrustedActorContext actor, String projectId) {
        authorizationService.requireProjectAllowed(SHEET_READ_COMMAND, actor, projectId);
        List<WeeklyExpenseSheetResponse> sheets = persistence.findSheets(actor.tenantId(), projectId).stream()
            .map(sheet -> toSheetResponse(projectId, sheet, List.of()))
            .toList();
        return new WeeklyExpenseSheetsResponse(true, projectId, sheets, recentAuditEvents(actor.tenantId(), projectId));
    }

    public CashflowSheetOperationStatusResponse readCashflowSheetOperationStatus(
        TrustedActorContext actor,
        String projectId,
        String operationType,
        String idempotencyKey
    ) {
        CashflowSheetOperation operation = CashflowSheetOperation.parse(operationType);
        requireOperationLookupKey(idempotencyKey);
        authorizationService.requireProjectAllowed(CASHFLOW_READ_COMMAND, actor, projectId);
        String keyHash = "sha256:" + sha256(idempotencyKey);
        Optional<WeeklyExpenseIdempotencyEntity> found = persistence.findIdempotency(
            actor.tenantId(),
            projectId,
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            idempotencyKey
        );
        if (found.isEmpty() || !matchesOperationIdentity(found.get(), actor, projectId, idempotencyKey)) {
            return missingOperation(projectId, operation, keyHash);
        }

        JsonNode result = readJsonNode(found.get().getResponseJson());
        if (!projectId.equals(result.path("projectId").asText()) || operation != CashflowSheetOperation.detect(result)) {
            return missingOperation(projectId, operation, keyHash);
        }
        String sourceRevision = requiredResultText(result, "sourceRevision");
        String auditId = requiredResultText(result, "auditId");
        return switch (operation) {
            case MONTH_APPLY -> new CashflowSheetOperationStatusResponse(
                "1", projectId, operation.name(), keyHash, "APPLIED", sourceRevision,
                requiredResultText(result, "expectedTargetRevision", "targetRevision"),
                requiredResultText(result, "resultingTargetRevision"),
                List.of(requiredYearMonth(result.path("yearMonth").asText())),
                List.of(), List.of(), auditId, found.get().getCreatedAt()
            );
            case BATCH_APPLY -> new CashflowSheetOperationStatusResponse(
                "1", projectId, operation.name(), keyHash, "APPLIED", sourceRevision,
                requiredResultText(result, "expectedTargetRevision", "targetRevision"),
                requiredResultText(result, "resultingTargetRevision"),
                appliedMonths(result.path("months")),
                List.of(), List.of(), auditId, found.get().getCreatedAt()
            );
            case ANNUAL_APPLY -> {
                int year = result.path("year").asInt();
                long revision = result.path("revision").asLong();
                if (year < 2000 || year > 2099 || revision < 0) {
                    throw new IllegalStateException("Stored annual cashflow operation evidence is invalid.");
                }
                yield new CashflowSheetOperationStatusResponse(
                    "1", projectId, operation.name(), keyHash, "APPLIED", sourceRevision,
                    null, null, List.of(), List.of(year),
                    List.of(new CashflowSheetOperationStatusResponse.AnnualRevisionEvidence(year, revision)),
                    auditId, found.get().getCreatedAt()
                );
            }
        };
    }

    private WeeklyExpenseSheetResponse toSheetResponse(
        String projectId,
        WeeklyExpenseSheetEntity sheet,
        List<dev.merryai.innerplatform.weekly.api.WeeklyExpenseAuditEventResponse> recentAuditEvents
    ) {
        return new WeeklyExpenseSheetResponse(
            true,
            projectId,
            text(sheet.getId()),
            sheet.getSheetKey(),
            sheet.getName(),
            sheet.getSheetVersion(),
            sheet.getRows().stream()
                .sorted((left, right) -> Integer.compare(left.getRowIndex(), right.getRowIndex()))
                .map(row -> new WeeklyExpenseSheetResponse.Row(
                    text(row.getId()),
                    row.getRowIndex(),
                    row.getRowVersion(),
                    text(row.getSourceTxId()),
                    text(row.getEntryKind()),
                    row.getCells().stream()
                        .sorted((left, right) -> Integer.compare(left.getColumnIndex(), right.getColumnIndex()))
                        .map(cell -> new WeeklyExpenseSheetResponse.Cell(
                            cell.getColumnIndex(),
                            text(cell.getRawValue()),
                            text(cell.getNormalizedValue()),
                            cell.getValueType().name(),
                            cell.getValidationStatus().name(),
                            text(cell.getValidationMessage()),
                            cell.isUserEdited()
                        ))
                        .toList()
                ))
                .toList(),
            recentAuditEvents
        );
    }

    private List<dev.merryai.innerplatform.weekly.api.WeeklyExpenseAuditEventResponse> recentAuditEvents(
        String tenantId,
        String projectId
    ) {
        return persistence.findRecentAuditEvents(tenantId, projectId, 5).stream()
            .map(this::toAuditEventResponse)
            .toList();
    }

    private dev.merryai.innerplatform.weekly.api.WeeklyExpenseAuditEventResponse toAuditEventResponse(
        WeeklyExpenseAuditEventEntity event
    ) {
        JsonNode metadata = readMetadataNode(event.getMetadataJson());
        return new dev.merryai.innerplatform.weekly.api.WeeklyExpenseAuditEventResponse(
            text(event.getId()),
            text(event.getCommandName()),
            text(event.getSheetKey()),
            text(event.getActorId()),
            metadataText(metadata, "actorEmail"),
            metadataText(metadata, "actorName", "actorDisplayName"),
            text(event.getActorRole()),
            text(event.getIdempotencyKey()),
            event.getCreatedAt()
        );
    }

    private JsonNode readMetadataNode(String metadataJson) {
        try {
            return objectMapper.readTree(metadataJson == null || metadataJson.isBlank() ? "{}" : metadataJson);
        } catch (JsonProcessingException error) {
            return objectMapper.createObjectNode();
        }
    }

    private String metadataText(JsonNode node, String... keys) {
        if (node == null) return "";
        for (String key : keys) {
            JsonNode value = node.get(key);
            if (value != null && value.isTextual() && !value.asText().isBlank()) {
                return value.asText().trim();
            }
        }
        return "";
    }

    public SaveDraftResponse saveDraft(
        TrustedActorContext actor,
        String projectId,
        String sheetKey,
        CashflowEditSession editSession,
        SaveDraftRequest request
    ) {
        actor = requireWeeklyExpenseWriteLease(SAVE_DRAFT_COMMAND, actor, projectId, editSession);
        String requestHash = hashJson(request);
        Optional<SaveDraftResponse> replay = readIdempotentResponse(
            actor.tenantId(),
            projectId,
            SAVE_DRAFT_COMMAND,
            request.idempotencyKey(),
            requestHash,
            SaveDraftResponse.class
        );
        if (replay.isPresent()) return replay.get();

        WeeklyExpenseSheetEntity sheet = loadSheet(actor.tenantId(), projectId, sheetKey, request.sheetName(), request.expectedSheetVersion());
        sheet.setName(request.sheetName());
        replaceRows(sheet, request.rows());
        List<CellValidationIssue> issues = spreadsheetService.validateAndRecalculateRows(sheet);
        List<SaveDraftResponse.ActualDelta> actualDelta = persistActuals(sheet);
        WeeklyExpenseSheetEntity savedSheet = persistence.saveSheet(sheet);

        WeeklyExpenseAuditEventEntity auditEvent = persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            actor.tenantId(),
            projectId,
            sheetKey,
            SAVE_DRAFT_COMMAND,
            actor.id(),
            normalizeRole(actor.role()),
            request.idempotencyKey(),
            metadataJson(actor, savedSheet, issues, actualDelta)
        ));

        SaveDraftResponse response = new SaveDraftResponse(
            true,
            SAVE_DRAFT_COMMAND,
            projectId,
            savedSheet.getId(),
            savedSheet.getSheetKey(),
            savedSheet.getSheetVersion(),
            savedSheet.getRows().size(),
            countCells(savedSheet),
            touchedRows(request.rows()),
            issues,
            actualDelta,
            auditEvent.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            actor.tenantId(),
            projectId,
            request.idempotencyKey(),
            SAVE_DRAFT_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public BankStatementImportLinesResponse listBankStatementImportLines(
        TrustedActorContext actor,
        String projectId,
        String status
    ) {
        authorizationService.requireProjectAllowed(BANK_IMPORT_LIST_LINES_COMMAND, actor, projectId);
        String normalizedStatus = normalizeImportLineStatus(status);
        List<WeeklyExpenseBankImportLineEntity> lines = persistence.findBankImportLines(actor.tenantId(), projectId, normalizedStatus);
        List<BankStatementImportLinesResponse.Line> responseLines = lines.stream()
            .map(line -> new BankStatementImportLinesResponse.Line(
                line.getId(),
                line.getBatch().getId(),
                line.getBatch().getUploadName(),
                line.getBatch().getStatus(),
                line.getBatch().getCreatedBy(),
                line.getBatch().getCreatedAt(),
                readStringList(line.getBatch().getColumnJson()),
                line.getLineIndex(),
                line.getSourceLineKey(),
                line.getTransactionDate(),
                line.getCounterparty(),
                line.getMemo(),
                line.getSignedAmount(),
                line.getBalanceAfter(),
                readStringList(line.getRawCellsJson()),
                line.getStatus(),
                line.getAppliedSheetKey(),
                line.getAppliedRowId(),
                line.getAppliedAt(),
                line.getAppliedBy()
            ))
            .toList();
        return new BankStatementImportLinesResponse(
            true,
            projectId,
            normalizedStatus == null ? "all" : normalizedStatus,
            responseLines
        );
    }

    public ImportBankStatementBatchResponse importBankStatementBatch(
        TrustedActorContext actor,
        String projectId,
        CashflowEditSession editSession,
        ImportBankStatementBatchRequest request
    ) {
        actor = requireWeeklyExpenseWriteLease(BANK_IMPORT_BATCH_COMMAND, actor, projectId, editSession);
        assertAtomicWriteBudget(request.lines().size(), 3 + finalizeWriteCount(editSession), "Bank statement import");
        String requestHash = hashJson(request);
        Optional<ImportBankStatementBatchResponse> replay = readIdempotentResponse(
            actor.tenantId(),
            projectId,
            BANK_IMPORT_BATCH_COMMAND,
            request.idempotencyKey(),
            requestHash,
            ImportBankStatementBatchResponse.class
        );
        if (replay.isPresent()) return replay.get();

        WeeklyExpenseBankImportBatchEntity batch = new WeeklyExpenseBankImportBatchEntity(
            actor.tenantId(),
            projectId,
            request.uploadName(),
            writeJson(request.columns()),
            actor.id()
        );

        Set<String> seenSourceLineKeys = new LinkedHashSet<>();
        List<ImportBankStatementBatchResponse.LineResult> duplicateLines = new ArrayList<>();
        for (ImportBankStatementBatchRequest.LinePatch line : request.lines()) {
            CanonicalBankImportLine canonicalLine = canonicalizeBankImportLine(request.columns(), line);
            if (!seenSourceLineKeys.add(canonicalLine.sourceLineKey())) {
                duplicateLines.add(new ImportBankStatementBatchResponse.LineResult(
                    null,
                    canonicalLine.lineIndex(),
                    canonicalLine.sourceLineKey(),
                    "duplicate",
                    canonicalLine.signedAmount(),
                    true
                ));
                continue;
            }
            var duplicate = persistence.findBankImportLineBySourceKey(
                actor.tenantId(),
                projectId,
                canonicalLine.sourceLineKey()
            );
            if (duplicate.isPresent()) {
                WeeklyExpenseBankImportLineEntity existingLine = duplicate.get();
                duplicateLines.add(new ImportBankStatementBatchResponse.LineResult(
                    existingLine.getId(),
                    existingLine.getLineIndex(),
                    existingLine.getSourceLineKey(),
                    existingLine.getStatus(),
                    existingLine.getSignedAmount(),
                    true
                ));
                continue;
            }
            batch.addLine(new WeeklyExpenseBankImportLineEntity(
                batch,
                canonicalLine.lineIndex(),
                canonicalLine.sourceLineKey(),
                canonicalLine.transactionDate(),
                canonicalLine.counterparty(),
                canonicalLine.memo(),
                canonicalLine.signedAmount(),
                canonicalLine.balanceAfter(),
                writeJson(canonicalLine.rawCells())
            ));
        }

        WeeklyExpenseBankImportBatchEntity savedBatch = persistence.saveBankImportBatch(batch);
        List<ImportBankStatementBatchResponse.LineResult> lineResults = new ArrayList<>();
        for (WeeklyExpenseBankImportLineEntity line : savedBatch.getLines()) {
            lineResults.add(new ImportBankStatementBatchResponse.LineResult(
                line.getId(),
                line.getLineIndex(),
                line.getSourceLineKey(),
                line.getStatus(),
                line.getSignedAmount(),
                false
            ));
        }
        lineResults.addAll(duplicateLines);

        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("batchId", savedBatch.getId());
        metadata.put("stagedLineCount", savedBatch.getLines().size());
        metadata.put("duplicateLineCount", duplicateLines.size());
        putActorMetadata(metadata, actor);

        WeeklyExpenseAuditEventEntity auditEvent = persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            actor.tenantId(),
            projectId,
            "bank-import",
            BANK_IMPORT_BATCH_COMMAND,
            actor.id(),
            normalizeRole(actor.role()),
            request.idempotencyKey(),
            writeJson(metadata)
        ));

        ImportBankStatementBatchResponse response = new ImportBankStatementBatchResponse(
            true,
            BANK_IMPORT_BATCH_COMMAND,
            projectId,
            savedBatch.getId(),
            savedBatch.getLines().size(),
            duplicateLines.size(),
            lineResults,
            auditEvent.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            actor.tenantId(),
            projectId,
            request.idempotencyKey(),
            BANK_IMPORT_BATCH_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public ApplyBankStatementItemsResponse applyBankStatementItems(
        TrustedActorContext actor,
        String projectId,
        CashflowEditSession editSession,
        ApplyBankStatementItemsRequest request
    ) {
        actor = requireWeeklyExpenseWriteLease(BANK_IMPORT_APPLY_ITEMS_COMMAND, actor, projectId, editSession);
        String requestHash = hashJson(request);
        Optional<ApplyBankStatementItemsResponse> replay = readIdempotentResponse(
            actor.tenantId(),
            projectId,
            BANK_IMPORT_APPLY_ITEMS_COMMAND,
            request.idempotencyKey(),
            requestHash,
            ApplyBankStatementItemsResponse.class
        );
        if (replay.isPresent()) return replay.get();

        List<String> requestedLineIds = request.items().stream()
            .map(ApplyBankStatementItemsRequest.ItemPatch::importLineId)
            .distinct()
            .toList();
        if (requestedLineIds.size() != request.items().size()) {
            throw new IllegalArgumentException("Bank import line cannot be applied more than once in the same request.");
        }
        if (requestedLineIds.isEmpty()) {
            throw new IllegalArgumentException("At least one bank import line must be selected.");
        }
        List<WeeklyExpenseBankImportLineEntity> lockedLines = persistence
            .findBankImportLinesForUpdate(actor.tenantId(), projectId, requestedLineIds);
        if (lockedLines.size() != requestedLineIds.size()) {
            throw new WeeklyExpenseConflictException("Selected bank import lines changed. Reload and retry.");
        }
        Map<String, WeeklyExpenseBankImportLineEntity> linesById = new LinkedHashMap<>();
        for (WeeklyExpenseBankImportLineEntity line : lockedLines) {
            if (line.isApplied()) {
                throw new WeeklyExpenseConflictException("Bank import line is already applied: " + line.getId());
            }
            linesById.put(line.getId(), line);
        }

        WeeklyExpenseSheetEntity sheet = loadSheet(
            actor.tenantId(),
            projectId,
            request.sheetKey(),
            request.sheetName(),
            request.expectedSheetVersion()
        );
        int nextRowIndex = sheet.getRows().stream()
            .mapToInt(WeeklyExpenseRowEntity::getRowIndex)
            .max()
            .orElse(-1) + 1;
        Set<Integer> touchedRows = new LinkedHashSet<>();
        Map<String, WeeklyExpenseRowEntity> rowsByLineId = new LinkedHashMap<>();

        for (ApplyBankStatementItemsRequest.ItemPatch item : request.items()) {
            WeeklyExpenseBankImportLineEntity line = linesById.get(item.importLineId());
            if (line == null) {
                throw new WeeklyExpenseConflictException("Selected bank import line is unavailable: " + item.importLineId());
            }
            WeeklyExpenseRowEntity row = sheet.rowAt(nextRowIndex);
            nextRowIndex += 1;
            row.setSourceTxId("bank:" + line.getSourceLineKey());
            row.setEntryKind("bank_import");
            setRawCell(row, WeeklyExpenseColumn.DATE, line.getTransactionDate(), false);
            setRawCell(row, WeeklyExpenseColumn.BALANCE_AFTER, moneyText(line.getBalanceAfter()), false);
            setRawCell(row, WeeklyExpenseColumn.BANK_AMOUNT, moneyText(line.getSignedAmount()), false);
            if (line.getSignedAmount().signum() < 0) {
                setRawCell(row, WeeklyExpenseColumn.EXPENSE_AMOUNT, moneyText(line.getSignedAmount().abs()), false);
            } else {
                setRawCell(row, WeeklyExpenseColumn.DEPOSIT_AMOUNT, moneyText(line.getSignedAmount()), false);
            }
            setRawCell(row, WeeklyExpenseColumn.COUNTERPARTY, line.getCounterparty(), false);
            setRawCell(row, WeeklyExpenseColumn.MEMO, line.getMemo(), false);

            for (ApplyBankStatementItemsRequest.CellPatch patch : item.cells()) {
                requireColumnIndex(patch.columnIndex());
                WeeklyExpenseCellEntity cell = row.cellAt(patch.columnIndex());
                cell.setRawValue(patch.rawValue());
                cell.setUserEdited(Boolean.TRUE.equals(patch.userEdited()));
            }
            touchedRows.add(row.getRowIndex());
            rowsByLineId.put(line.getId(), row);
        }

        List<CellValidationIssue> issues = spreadsheetService.validateAndRecalculateRows(sheet);
        List<SaveDraftResponse.ActualDelta> actualDelta = persistActuals(sheet);
        WeeklyExpenseSheetEntity savedSheet = persistence.saveSheet(sheet);
        for (WeeklyExpenseBankImportLineEntity line : lockedLines) {
            WeeklyExpenseRowEntity row = rowsByLineId.get(line.getId());
            line.markApplied(savedSheet.getSheetKey(), row == null ? null : row.getId(), actor.id());
        }
        persistence.saveBankImportLines(lockedLines);

        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("sheetId", savedSheet.getId());
        metadata.put("sheetKey", savedSheet.getSheetKey());
        metadata.put("sheetVersion", savedSheet.getSheetVersion());
        metadata.put("appliedLineCount", lockedLines.size());
        metadata.put("touchedRows", touchedRows);
        metadata.put("validationIssueCount", issues.size());
        metadata.put("actualDeltaCount", actualDelta.size());
        putActorMetadata(metadata, actor);

        WeeklyExpenseAuditEventEntity auditEvent = persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            actor.tenantId(),
            projectId,
            savedSheet.getSheetKey(),
            BANK_IMPORT_APPLY_ITEMS_COMMAND,
            actor.id(),
            normalizeRole(actor.role()),
            request.idempotencyKey(),
            writeJson(metadata)
        ));

        ApplyBankStatementItemsResponse response = new ApplyBankStatementItemsResponse(
            true,
            BANK_IMPORT_APPLY_ITEMS_COMMAND,
            projectId,
            savedSheet.getId(),
            savedSheet.getSheetKey(),
            savedSheet.getSheetVersion(),
            lockedLines.size(),
            touchedRows,
            issues,
            actualDelta,
            auditEvent.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            actor.tenantId(),
            projectId,
            request.idempotencyKey(),
            BANK_IMPORT_APPLY_ITEMS_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public UpsertProjectionResponse upsertProjection(
        TrustedActorContext actor,
        String projectId,
        CashflowEditSession editSession,
        UpsertProjectionRequest request
    ) {
        if (request.lines().isEmpty()) {
            throw new IllegalArgumentException("At least one projection line is required.");
        }
        assertAtomicWriteBudget(request.lines().size(), 2, "Projection command");
        TrustedActorContext writer = requireCashflowWritePermission(UPSERT_PROJECTION_COMMAND, actor, projectId);
        String requestHash = hashJson(request);
        Optional<UpsertProjectionResponse> replay = readIdempotentResponse(
            writer.tenantId(),
            projectId,
            UPSERT_PROJECTION_COMMAND,
            request.idempotencyKey(),
            requestHash,
            UpsertProjectionResponse.class
        );
        if (replay.isPresent()) return replay.get();

        List<WeeklyExpenseProjectionEntity> projectionEntities = prepareProjectionEntities(
            writer,
            projectId,
            request.lines()
        );
        List<CashflowSnapshotResponse.ProjectionLine> projection = saveProjectionEntities(projectionEntities);

        WeeklyExpenseAuditEventEntity auditEvent = persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            writer.tenantId(),
            projectId,
            "projection",
            UPSERT_PROJECTION_COMMAND,
            writer.id(),
            normalizeRole(writer.role()),
            request.idempotencyKey(),
            projectionMetadataJson(writer, projection.size())
        ));

        UpsertProjectionResponse response = new UpsertProjectionResponse(
            true,
            UPSERT_PROJECTION_COMMAND,
            projectId,
            projection.size(),
            projection,
            auditEvent.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(),
            projectId,
            request.idempotencyKey(),
            UPSERT_PROJECTION_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public CashflowMonthCloseResponse readCashflowMonthClose(
        TrustedActorContext actor,
        String projectId,
        String yearMonth
    ) {
        requireYearMonth(yearMonth);
        authorizationService.requireProjectAllowed(CASHFLOW_MONTH_CLOSE_READ_COMMAND, actor, projectId);
        return monthCloseResponse(
            CASHFLOW_MONTH_CLOSE_READ_COMMAND,
            persistence.findCashflowMonthClose(actor.tenantId(), projectId, yearMonth),
            ""
        );
    }

    public CashflowMonthReopenAuthorityResult readCashflowMonthReopenAuthority(
        CashflowMonthReopenPort.Actor actor,
        String projectId
    ) {
        try {
            readCashflowMonthReopenDecisionAuthority(actor, projectId);
            return CashflowMonthReopenAuthorityResult.allowed(
                READ_CASHFLOW_MONTH_REOPEN_AUTHORITY_COMMAND,
                projectId
            );
        } catch (CashflowMonthReopenPolicy.Violation error) {
            if (error.reason() != CashflowMonthReopenPolicy.ViolationReason.DECISION_FORBIDDEN) {
                throw error;
            }
            return CashflowMonthReopenAuthorityResult.forbidden(
                READ_CASHFLOW_MONTH_REOPEN_AUTHORITY_COMMAND,
                projectId
            );
        } catch (CashflowMonthReopenPort.DecisionAuthorityUnavailable error) {
            return CashflowMonthReopenAuthorityResult.unavailable(
                READ_CASHFLOW_MONTH_REOPEN_AUTHORITY_COMMAND,
                projectId
            );
        }
    }

    public CashflowVarianceResponse updateCashflowVariance(
        TrustedActorContext actor,
        String projectId,
        CashflowEditSession editSession,
        CashflowVarianceRequest request
    ) {
        String idempotencyKey = requireIdempotencyKey(request.idempotencyKey());
        requireVarianceContent(request);
        TrustedActorContext writer = requireCashflowWritePermission(
            CASHFLOW_VARIANCE_COMMAND,
            actor,
            projectId
        );
        requireVarianceActionRole(writer.role(), request.action());
        String requestHash = hashJson(request);
        Optional<CashflowVarianceResponse> replay = readIdempotentResponse(
            writer.tenantId(),
            projectId,
            CASHFLOW_VARIANCE_COMMAND,
            idempotencyKey,
            requestHash,
            CashflowVarianceResponse.class
        );
        if (replay.isPresent()) return replay.get();

        WeeklyExpensePersistence.CashflowVarianceRecord saved = persistence.updateCashflowVariance(
            writer,
            projectId,
            request
        );
        persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            writer.tenantId(),
            projectId,
            saved.sheetId(),
            CASHFLOW_VARIANCE_COMMAND,
            writer.id(),
            normalizeRole(writer.role()),
            idempotencyKey,
            varianceAuditMetadataJson(writer, saved, request.action())
        ));
        CashflowVarianceResponse response = new CashflowVarianceResponse(new CashflowVarianceResponse.Week(
            saved.sheetId(),
            saved.projectId(),
            saved.tenantId(),
            saved.varianceFlag(),
            saved.varianceHistory(),
            saved.varianceRevision(),
            saved.updatedAt(),
            saved.updatedByUid(),
            saved.updatedByName()
        ));
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(),
            projectId,
            idempotencyKey,
            CASHFLOW_VARIANCE_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    private static void requireYearMonth(String yearMonth) {
        if (yearMonth == null || !yearMonth.matches("20\\d{2}-(0[1-9]|1[0-2])")) {
            throw new IllegalArgumentException("yearMonth must use YYYY-MM.");
        }
    }

    public CashflowMonthCloseResponse closeCashflowMonth(
        TrustedActorContext actor,
        String projectId,
        CashflowEditSession editSession,
        CloseCashflowMonthRequest request
    ) {
        boolean settlementCycleApproval = !request.cycleYearMonth().isBlank()
            || !request.monthCloseTargetYearMonth().isBlank();
        TrustedActorContext writer = settlementCycleApproval
            ? requireCashflowMonthReopenDecisionPermission(actor, projectId)
            : requireCashflowMonthClosePermission(
                CLOSE_CASHFLOW_MONTH_COMMAND,
                actor,
                projectId
            );
        if (!request.cumulativeV2()) {
            CloseCashflowMonthRequest.requireOpeningBalances(request.openingBalances(), request.yearMonth());
        }
        String actorBoundRequestHash = hashJson(new ActorBoundIdempotencyRequest(writer.id(), request));
        String requestFirstActorBoundHash = hashJson(new RequestFirstActorBoundIdempotencyRequest(request, writer.id()));
        String legacyRequestHash = legacyCloseCashflowMonthRequestHash(request);
        String requestHash = legacyRequestHash == null ? actorBoundRequestHash : legacyRequestHash;
        Optional<CashflowMonthCloseResponse> replay = readCompatibleIdempotentResponse(
            writer.tenantId(),
            projectId,
            CLOSE_CASHFLOW_MONTH_COMMAND,
            request.idempotencyKey(),
            requestHash,
            legacyRequestHash == null
                ? List.of(requestFirstActorBoundHash)
                : List.of(actorBoundRequestHash, requestFirstActorBoundHash),
            CashflowMonthCloseResponse.class
        );
        if (replay.isPresent()) return replay.get();

        if (!request.cumulativeV2()) {
            CashflowSheetLabApplyRequest.requireCompleteMonth(request.cells());
            CloseCashflowMonthRequest.requireCompleteDepositSchedule(request.depositScheduleRows());
            CloseCashflowMonthRequest.requireCompleteConfirmations(request.confirmations());
            CloseCashflowMonthRequest.requireCompleteManagementChecks(request.managementChecks());
            CloseCashflowMonthRequest.requireCompleteManagementConfirmations(request.managementConfirmations());
        }
        assertAtomicWriteBudget(
            CashflowSheetLabApplyRequest.FINANCE_WEEK_COUNT,
            5,
            "Cashflow month close"
        );
        CashflowMonthCloseState saved = persistence.closeCashflowMonth(
            writer,
            projectId,
            CASHFLOW_SHEET_LAB_ACTUAL_SOURCE,
            request
        );
        WeeklyExpenseAuditEventEntity audit = saveMonthCloseAudit(
            writer,
            projectId,
            CLOSE_CASHFLOW_MONTH_COMMAND,
            request.idempotencyKey(),
            saved
        );
        CashflowMonthCloseResponse response = monthCloseResponse(CLOSE_CASHFLOW_MONTH_COMMAND, saved, audit.getId());
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(),
            projectId,
            request.idempotencyKey(),
            CLOSE_CASHFLOW_MONTH_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public CashflowWeeklyUpdateCompletionResponse completeCashflowWeeklyUpdate(
        TrustedActorContext actor,
        String projectId,
        CompleteCashflowWeeklyUpdateRequest request
    ) {
        TrustedActorContext writer = requireCashflowMonthClosePermission(
            COMPLETE_CASHFLOW_WEEKLY_UPDATE_COMMAND,
            actor,
            projectId
        );
        Map<String, Object> requestHashInput = new LinkedHashMap<>(Map.of(
            "yearMonth", request.yearMonth(),
            "weekNo", request.weekNo(),
            "updateResult", request.updateResult()
        ));
        if (request.ignoreProjectionValidation()) {
            requestHashInput.put("ignoreProjectionValidation", true);
            requestHashInput.put("projectionValidationEvidenceHash", normalizeText(request.projectionValidationEvidenceHash()));
            requestHashInput.put("projectionValidationIssueCount", request.projectionValidationIssueCount());
        }
        String requestHash = hashJson(requestHashInput);
        Optional<CashflowWeeklyUpdateCompletionResponse> replay = readIdempotentResponse(
            writer.tenantId(),
            projectId,
            COMPLETE_CASHFLOW_WEEKLY_UPDATE_COMMAND,
            request.idempotencyKey(),
            requestHash,
            CashflowWeeklyUpdateCompletionResponse.class
        );
        if (replay.isPresent()) return replay.get();

        WeeklyExpensePersistence.CashflowWeeklyUpdateCompletionRecord saved = persistence.completeCashflowWeeklyUpdate(
            writer,
            projectId,
            request
        );
        if (!saved.alreadyCompleted() || request.ignoreProjectionValidation()) {
            String auditEventId = saved.alreadyCompleted()
                ? "weekly-override-" + hashJson(Map.of(
                    "tenantId", writer.tenantId(),
                    "projectId", projectId,
                    "idempotencyKey", request.idempotencyKey()
                )).replace("sha256:", "")
                : saved.auditId();
            WeeklyExpenseAuditEventEntity event = new WeeklyExpenseAuditEventEntity(
                writer.tenantId(),
                projectId,
                projectId + "-" + saved.yearMonth() + "-w" + saved.weekNo(),
                COMPLETE_CASHFLOW_WEEKLY_UPDATE_COMMAND,
                writer.id(),
                normalizeRole(writer.role()),
                request.idempotencyKey(),
                writeJson(Map.ofEntries(
                    Map.entry("yearMonth", saved.yearMonth()),
                    Map.entry("weekNo", saved.weekNo()),
                    Map.entry("completedAt", saved.completedAt()),
                    Map.entry("completedBy", saved.completedBy()),
                    Map.entry("deadline", saved.deadline()),
                    Map.entry("status", saved.complianceStatus()),
                    Map.entry("operationId", saved.operationId()),
                    Map.entry("auditId", auditEventId),
                    Map.entry("updateResult", saved.updateResult()),
                    Map.entry("projectionValidationOverride", saved.projectionValidationOverride()),
                    Map.entry("projectionValidationIssueCount", saved.projectionValidationIssueCount()),
                    Map.entry("projectionValidationEvidenceHash", saved.projectionValidationEvidenceHash()),
                    Map.entry("snapshotHash", saved.snapshotHash()),
                    Map.entry("sourceRevision", saved.sourceRevision()),
                    Map.entry("targetRevision", saved.targetRevision()),
                    Map.entry("revision", saved.revision())
                ))
            );
            event.restorePersistenceState(auditEventId, event.getCreatedAt());
            persistence.saveAuditEvent(event);
        }
        CashflowWeeklyUpdateCompletionResponse response = weeklyCompletionResponse(
            COMPLETE_CASHFLOW_WEEKLY_UPDATE_COMMAND,
            saved
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(),
            projectId,
            request.idempotencyKey(),
            COMPLETE_CASHFLOW_WEEKLY_UPDATE_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public CashflowWeeklyUpdateCompletionResponse readCashflowWeeklyUpdate(
        TrustedActorContext actor,
        String projectId,
        String yearMonth,
        int weekNo
    ) {
        authorizationService.requireProjectAllowed(READ_CASHFLOW_WEEKLY_UPDATE_COMMAND, actor, projectId);
        WeeklyExpensePersistence.CashflowWeeklyUpdateCompletionRecord record = persistence
            .findCashflowWeeklyUpdateCompletion(actor.tenantId(), projectId, yearMonth, weekNo);
        return weeklyCompletionResponse(READ_CASHFLOW_WEEKLY_UPDATE_COMMAND, record);
    }

    public CashflowWeeklyComplianceHistoryResponse readCashflowWeeklyComplianceHistory(
        TrustedActorContext actor,
        String projectId,
        int limit,
        String cursor
    ) {
        authorizationService.requireProjectAllowed(READ_CASHFLOW_WEEKLY_UPDATE_COMMAND, actor, projectId);
        // C 단계 측정: 대시보드가 부르는 두 번째 JVM 읽기. 읽기 수·소요를 같은 형식으로.
        WeeklyExpensePersistence.CashflowWeeklyCompliancePage page;
        try (CashflowReadMetrics.Scope scope = CashflowReadMetrics.begin("cashflow.weekly_compliance", "", projectId)) {
            try {
                page = persistence.findCashflowWeeklyComplianceHistory(actor.tenantId(), projectId, limit, cursor);
            } catch (RuntimeException error) {
                scope.failed(error);
                throw error;
            }
        }
        return new CashflowWeeklyComplianceHistoryResponse(
            page.items().stream().map(item -> new CashflowWeeklyComplianceHistoryResponse.Item(
                item.yearMonth(), item.weekNo(), item.deadline(), item.status(), item.completedAt(),
                item.completedBy(), item.operationId(), item.auditId(), item.updateResult(), item.lockState()
            )).toList(),
            page.nextCursor(),
            page.onTimeCount(),
            page.missedCount()
        );
    }

    public CashflowAppliedCellChangesResponse readCashflowAppliedCellChanges(
        TrustedActorContext actor,
        String projectId,
        int limit,
        String cursor
    ) {
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("limit must be between 1 and 100.");
        }
        authorizationService.requireProjectAllowed(CASHFLOW_READ_COMMAND, actor, projectId);
        List<AppliedCellChangeCandidate> all = new ArrayList<>();
        for (WeeklyExpensePersistence.AppliedCellChangeAuditSource source
            : persistence.findAppliedCellChangeAuditSources(actor.tenantId(), projectId)) {
            if (!projectId.equals(source.projectId())) {
                throw new WeeklyExpenseConflictException("Stored applied cell change project scope is invalid.");
            }
            JsonNode metadata = readAppliedCellChangeMetadata(source.metadataJson());
            JsonNode changes = metadata.path("appliedCellChanges");
            if (!changes.isArray()) continue;
            for (int index = 0; index < changes.size(); index++) {
                all.add(new AppliedCellChangeCandidate(
                    appliedCellChangeItem(projectId, source, metadata, changes.get(index), index), index
                ));
            }
        }
        all.sort(Comparator
            .comparing((AppliedCellChangeCandidate candidate) -> candidate.item().createdAt()).reversed()
            .thenComparing(candidate -> candidate.item().eventId(), Comparator.reverseOrder())
            .thenComparingInt(AppliedCellChangeCandidate::ordinal));

        int start = appliedCellChangeCursorStart(all, cursor);
        int end = Math.min(start + limit, all.size());
        List<CashflowAppliedCellChangesResponse.Item> items = all.subList(start, end).stream()
            .map(AppliedCellChangeCandidate::item)
            .toList();
        String nextCursor = end < all.size()
            ? Base64.getUrlEncoder().withoutPadding().encodeToString(
                items.getLast().cellId().getBytes(StandardCharsets.UTF_8)
            )
            : "";
        return new CashflowAppliedCellChangesResponse(items, nextCursor);
    }

    private CashflowAppliedCellChangesResponse.Item appliedCellChangeItem(
        String projectId,
        WeeklyExpensePersistence.AppliedCellChangeAuditSource source,
        JsonNode metadata,
        JsonNode change,
        int ordinal
    ) {
        if (change == null || !change.isObject() || source.eventId() == null || source.eventId().isBlank()) {
            throw new WeeklyExpenseConflictException("Stored applied cell change evidence is invalid.");
        }
        String yearMonth = metadataText(change, "yearMonth");
        int weekNo = change.path("weekNo").asInt(0);
        String mode = metadataText(change, "mode").toLowerCase(Locale.ROOT);
        String lineId = metadataText(change, "lineId", "cashflowLine");
        boolean monthly = yearMonth.matches("20\\d{2}-(0[1-9]|1[0-2])") && weekNo >= 1 && weekNo <= 5;
        boolean annual = yearMonth.matches("20\\d{2}-ANNUAL") && weekNo == 0;
        if (!(monthly || annual) || !("projection".equals(mode) || "actual".equals(mode)) || lineId.isBlank()) {
            throw new WeeklyExpenseConflictException("Stored applied cell change coordinates are invalid.");
        }
        JsonNode before = change.path("before");
        JsonNode after = change.path("after");
        String beforeState = appliedCellState(before);
        String afterState = appliedCellState(after);
        BigDecimal beforeAmount = appliedCellAmount(before, beforeState);
        BigDecimal afterAmount = appliedCellAmount(after, afterState);
        String eventId = source.eventId().trim();
        return new CashflowAppliedCellChangesResponse.Item(
            eventId,
            eventId + ":" + ordinal,
            projectId,
            yearMonth,
            weekNo,
            mode,
            lineId,
            !"EMPTY".equals(beforeState),
            beforeState,
            beforeAmount,
            !"EMPTY".equals(afterState),
            afterState,
            afterAmount,
            firstText(metadataText(change, "actorId", "actorUid"), source.actorId()),
            firstText(metadataText(change, "actorName"), metadataText(metadata, "actorName", "actorDisplayName")),
            firstText(metadataText(change, "actorEmail"), metadataText(metadata, "actorEmail")),
            firstText(metadataText(change, "reason"), metadataText(metadata, "reason", "amendmentReason")),
            firstText(
                metadataText(change, "source"),
                metadataText(metadata, "source", "sourceSheetKey"),
                source.sheetKey()
            ),
            firstText(
                metadataText(change, "operationType", "operation", "type"),
                metadataText(metadata, "operationType", "operation", "type"),
                source.commandName()
            ),
            firstText(metadataText(change, "operationId"), metadataText(metadata, "operationId"), source.idempotencyKey()),
            firstText(metadataText(change, "auditId"), eventId),
            firstText(metadataText(change, "sourceRevision"), metadataText(metadata, "sourceRevision")),
            firstText(metadataText(change, "targetRevision"), metadataText(metadata, "targetRevision")),
            appliedCellChangeInstant(metadataText(change, "changedAt"), source.createdAt())
        );
    }

    private String appliedCellState(JsonNode value) {
        String state = metadataText(value, "cellState").toUpperCase(Locale.ROOT);
        if (!Set.of("EMPTY", "ZERO", "VALUE").contains(state)) {
            throw new WeeklyExpenseConflictException("Stored applied cell state is invalid.");
        }
        return state;
    }

    private BigDecimal appliedCellAmount(JsonNode value, String state) {
        JsonNode amount = value.get("amount");
        if ("EMPTY".equals(state)) {
            if (amount != null && !amount.isNull()) {
                throw new WeeklyExpenseConflictException("Stored EMPTY cell amount must be null.");
            }
            return null;
        }
        try {
            BigDecimal parsed = amount != null && amount.isNumber()
                ? amount.decimalValue()
                : new BigDecimal(amount == null ? "" : amount.asText());
            if ("ZERO".equals(state) && parsed.compareTo(BigDecimal.ZERO) != 0) {
                throw new WeeklyExpenseConflictException("Stored ZERO cell amount must be zero.");
            }
            return parsed;
        } catch (NumberFormatException error) {
            throw new WeeklyExpenseConflictException("Stored applied cell amount is invalid.");
        }
    }

    private Instant appliedCellChangeInstant(String changedAt, Instant fallback) {
        if (changedAt == null || changedAt.isBlank()) {
            if (fallback == null) throw new WeeklyExpenseConflictException("Stored applied cell change time is invalid.");
            return fallback;
        }
        try {
            return Instant.parse(changedAt);
        } catch (RuntimeException error) {
            throw new WeeklyExpenseConflictException("Stored applied cell change time is invalid.");
        }
    }

    private JsonNode readAppliedCellChangeMetadata(String metadataJson) {
        try {
            JsonNode metadata = objectMapper.readTree(metadataJson == null ? "" : metadataJson);
            if (metadata == null || !metadata.isObject()) {
                throw new WeeklyExpenseConflictException("Stored applied cell change metadata is invalid.");
            }
            return metadata;
        } catch (JsonProcessingException error) {
            throw new WeeklyExpenseConflictException("Stored applied cell change metadata is invalid.");
        }
    }

    private int appliedCellChangeCursorStart(List<AppliedCellChangeCandidate> all, String cursor) {
        if (cursor == null || cursor.isBlank()) return 0;
        String cellId;
        try {
            cellId = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("cursor is invalid.", error);
        }
        for (int index = 0; index < all.size(); index++) {
            if (all.get(index).item().cellId().equals(cellId)) return index + 1;
        }
        throw new IllegalArgumentException("cursor is invalid.");
    }

    private String firstText(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) return value.trim();
        }
        return "";
    }

    private record AppliedCellChangeCandidate(CashflowAppliedCellChangesResponse.Item item, int ordinal) {
    }

    // 주정산 확정: 완료 요청된 주를 프로젝트 조직장이 잠금으로 확정한다. 조직장 검사는 저장소에서 프로젝트 문서로.
    public CashflowWeeklyUpdateCompletionResponse confirmCashflowWeeklyUpdate(
        TrustedActorContext actor,
        String projectId,
        ConfirmCashflowWeeklyUpdateRequest request
    ) {
        TrustedActorContext writer = requireCashflowMonthClosePermission(
            CONFIRM_CASHFLOW_WEEKLY_UPDATE_COMMAND,
            actor,
            projectId
        );
        String requestHash = hashJson(request);
        Optional<CashflowWeeklyUpdateCompletionResponse> replay = readIdempotentResponse(
            writer.tenantId(),
            projectId,
            CONFIRM_CASHFLOW_WEEKLY_UPDATE_COMMAND,
            request.idempotencyKey(),
            requestHash,
            CashflowWeeklyUpdateCompletionResponse.class
        );
        if (replay.isPresent()) return replay.get();

        WeeklyExpensePersistence.CashflowWeeklyUpdateCompletionRecord saved = persistence.confirmCashflowWeeklyUpdate(
            writer,
            projectId,
            request
        );
        persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            writer.tenantId(),
            projectId,
            projectId + "-" + saved.yearMonth() + "-w" + saved.weekNo(),
            CONFIRM_CASHFLOW_WEEKLY_UPDATE_COMMAND,
            writer.id(),
            normalizeRole(writer.role()),
            request.idempotencyKey(),
            writeJson(Map.of(
                "yearMonth", saved.yearMonth(),
                "weekNo", saved.weekNo(),
                "revision", saved.revision(),
                "snapshotHash", saved.snapshotHash()
            ))
        ));
        CashflowWeeklyUpdateCompletionResponse response = weeklyCompletionResponse(
            CONFIRM_CASHFLOW_WEEKLY_UPDATE_COMMAND,
            saved
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(),
            projectId,
            request.idempotencyKey(),
            CONFIRM_CASHFLOW_WEEKLY_UPDATE_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public CashflowWeeklyUpdateCompletionResponse reopenCashflowWeeklyUpdate(
        TrustedActorContext actor,
        String projectId,
        ReopenCashflowWeeklyUpdateRequest request
    ) {
        TrustedActorContext writer = requireCashflowMonthClosePermission(
            REOPEN_CASHFLOW_WEEKLY_UPDATE_COMMAND,
            actor,
            projectId
        );
        String requestHash = hashJson(request);
        Optional<CashflowWeeklyUpdateCompletionResponse> replay = readIdempotentResponse(
            writer.tenantId(),
            projectId,
            REOPEN_CASHFLOW_WEEKLY_UPDATE_COMMAND,
            request.idempotencyKey(),
            requestHash,
            CashflowWeeklyUpdateCompletionResponse.class
        );
        if (replay.isPresent()) return replay.get();

        WeeklyExpensePersistence.CashflowWeeklyUpdateCompletionRecord saved = persistence.reopenCashflowWeeklyUpdate(
            writer,
            projectId,
            request
        );
        persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            writer.tenantId(),
            projectId,
            projectId + "-" + saved.yearMonth() + "-w" + saved.weekNo(),
            REOPEN_CASHFLOW_WEEKLY_UPDATE_COMMAND,
            writer.id(),
            normalizeRole(writer.role()),
            request.idempotencyKey(),
            writeJson(Map.of(
                "yearMonth", saved.yearMonth(),
                "weekNo", saved.weekNo(),
                "revision", saved.revision(),
                "reopenedAt", saved.reopenedAt(),
                "reopenedBy", saved.reopenedBy(),
                "reason", saved.reopenReason() == null ? "" : saved.reopenReason(),
                "previousSnapshotHash", saved.snapshotHash()
            ))
        ));
        CashflowWeeklyUpdateCompletionResponse response = weeklyCompletionResponse(
            REOPEN_CASHFLOW_WEEKLY_UPDATE_COMMAND,
            saved
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(),
            projectId,
            request.idempotencyKey(),
            REOPEN_CASHFLOW_WEEKLY_UPDATE_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public CashflowMonthCloseResponse requestCashflowMonthReopen(
        TrustedActorContext actor,
        String projectId,
        String dataProjectId,
        CashflowMonthReopenCommands.RequestReopen request
    ) {
        if (request.reason().isBlank()) {
            throw new IllegalArgumentException("A reason is required to request a cashflow month reopen.");
        }
        TrustedActorContext writer = requireCashflowMonthClosePermission(
            REQUEST_CASHFLOW_MONTH_REOPEN_COMMAND,
            actor,
            projectId
        );
        persistence.requireCashflowDataProject(dataProjectId);
        String actorBoundRequestHash = hashJson(new ActorBoundIdempotencyRequest(writer.id(), request));
        String requestFirstActorBoundHash = hashJson(new RequestFirstActorBoundIdempotencyRequest(request, writer.id()));
        String legacyRequestHash = legacyRequestReopenHash(request);
        String requestHash = legacyRequestHash == null ? actorBoundRequestHash : legacyRequestHash;
        Optional<CashflowMonthCloseResponse> replay = readCompatibleIdempotentResponse(
            writer.tenantId(),
            projectId,
            REQUEST_CASHFLOW_MONTH_REOPEN_COMMAND,
            request.idempotencyKey(),
            requestHash,
            legacyRequestHash == null
                ? List.of(requestFirstActorBoundHash)
                : List.of(actorBoundRequestHash, requestFirstActorBoundHash),
            CashflowMonthCloseResponse.class
        );
        if (replay.isPresent()) return replay.get();

        CashflowMonthReopenPolicy.Facts facts = cashflowMonthReopenPort.findCashflowMonthReopenFacts(
            writer.tenantId(),
            projectId,
            request.yearMonth()
        );
        CashflowMonthReopenPolicy.RequestTransition transition = CashflowMonthReopenPolicy.request(
            facts,
            request.yearMonth(),
            request.expectedRevision()
        );
        CashflowMonthCloseState saved = cashflowMonthReopenPort.applyCashflowMonthReopenRequest(
            reopenActor(writer),
            projectId,
            transition,
            request.reason(),
            settlementCycleContext(request)
        );
        WeeklyExpenseAuditEventEntity audit = saveMonthCloseAudit(
            writer,
            projectId,
            REQUEST_CASHFLOW_MONTH_REOPEN_COMMAND,
            request.idempotencyKey(),
            saved
        );
        CashflowMonthCloseResponse response = monthCloseResponse(
            REQUEST_CASHFLOW_MONTH_REOPEN_COMMAND,
            saved,
            audit.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(),
            projectId,
            request.idempotencyKey(),
            REQUEST_CASHFLOW_MONTH_REOPEN_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public CashflowMonthCloseResponse decideCashflowMonthReopen(
        TrustedActorContext actor,
        String projectId,
        String dataProjectId,
        CashflowMonthReopenCommands.DecideReopen request
    ) {
        if (!("APPROVE".equals(request.decision()) || "REJECT".equals(request.decision()))
            || request.reason().isBlank()) {
            throw new IllegalArgumentException("A decision and reason are required for a cashflow month reopen request.");
        }
        TrustedActorContext writer = requireCashflowMonthReopenDecisionPermission(
            actor,
            projectId
        );
        persistence.requireCashflowDataProject(dataProjectId);
        String actorBoundRequestHash = hashJson(new ActorBoundIdempotencyRequest(writer.id(), request));
        String requestFirstActorBoundHash = hashJson(new RequestFirstActorBoundIdempotencyRequest(request, writer.id()));
        String legacyRequestHash = legacyDecideReopenHash(request);
        String requestHash = legacyRequestHash == null ? actorBoundRequestHash : legacyRequestHash;
        Optional<CashflowMonthCloseResponse> replay = readCompatibleIdempotentResponse(
            writer.tenantId(),
            projectId,
            DECIDE_CASHFLOW_MONTH_REOPEN_COMMAND,
            request.idempotencyKey(),
            requestHash,
            legacyRequestHash == null
                ? List.of(requestFirstActorBoundHash)
                : List.of(actorBoundRequestHash, requestFirstActorBoundHash),
            CashflowMonthCloseResponse.class
        );
        if (replay.isPresent()) return replay.get();

        CashflowMonthReopenPolicy.Facts facts = cashflowMonthReopenPort.findCashflowMonthReopenFacts(
            writer.tenantId(),
            projectId,
            request.yearMonth()
        );
        CashflowMonthReopenPort.SettlementCycleContext cycleContext = settlementCycleContext(request);
        CashflowMonthReopenPolicy.Decision decision =
            CashflowMonthReopenPolicy.Decision.valueOf(request.decision());
        CashflowMonthReopenPolicy.DecisionTransition transition = cycleContext.present()
            ? CashflowMonthReopenPolicy.decide(
                facts, request.yearMonth(), request.expectedRevision(), decision
            )
            : CashflowMonthReopenPolicy.decideLegacy(
                facts, request.yearMonth(), request.expectedRevision(), decision
            );
        CashflowMonthCloseState saved = cashflowMonthReopenPort.applyCashflowMonthReopenDecision(
            reopenActor(writer),
            projectId,
            transition,
            request.reason(),
            cycleContext
        );
        WeeklyExpenseAuditEventEntity audit = saveMonthCloseAudit(
            writer,
            projectId,
            DECIDE_CASHFLOW_MONTH_REOPEN_COMMAND,
            request.idempotencyKey(),
            saved
        );
        CashflowMonthCloseResponse response = monthCloseResponse(
            DECIDE_CASHFLOW_MONTH_REOPEN_COMMAND,
            saved,
            audit.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(),
            projectId,
            request.idempotencyKey(),
            DECIDE_CASHFLOW_MONTH_REOPEN_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public CashflowSheetLabApplyResponse applyCashflowSheetLab(
        TrustedActorContext actor,
        String projectId,
        CashflowEditSession editSession,
        CashflowSheetLabApplyRequest request
    ) {
        TrustedActorContext writer = requireCashflowWritePermission(
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            actor,
            projectId
        );
        String requestHash = hashJson(request);
        Optional<CashflowSheetLabApplyResponse> replay = readIdempotentResponse(
            writer.tenantId(),
            projectId,
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            request.idempotencyKey(),
            requestHash,
            CashflowSheetLabApplyResponse.class
        );
        if (replay.isPresent()) return replay.get();

        List<CashflowSheetLabApplyRequest.Cell> cells = requireCompleteCashflowSheetMonth(request);
        List<CashflowPendingApprovalAffectedMonth> pendingApprovalWarnings =
            CashflowPendingApprovalAffectedMonth.requireValid(
                request.pendingApprovalAffectedMonths(), List.of(request.yearMonth())
            );
        List<WeeklyExpensePersistence.CashflowClosedMonthAmendment> amendments = persistence
            .authorizeCashflowSheetMonthAmendments(
                writer,
                projectId,
                List.of(request.yearMonth()),
                request.sourceRevision(),
                request.closedMonthChangeReason(),
                request.idempotencyKey()
            );
        List<Map<String, Object>> calculationChecks = CashflowSheetLabApplyRequest.recalculateCalculationChecks(
            request.yearMonth(),
            cells,
            request.calculationChecks(),
            request.calculatedOpeningBalances()
        );
        requireFormulaMismatchConfirmation(
            Map.of(request.yearMonth(), calculationChecks),
            request.acceptFormulaMismatches()
        );
        assertAtomicWriteBudget(cells.size(), 3 + pendingApprovalWarnings.size(), "Cashflow sheet apply");
        String sourceSheetKey = CASHFLOW_SHEET_LAB_ACTUAL_SOURCE;
        WeeklyExpensePersistence.CashflowSheetMonthReplacement replacement = persistence.replaceCashflowSheetMonth(
            writer.tenantId(),
            projectId,
            sourceSheetKey,
            request.yearMonth(),
            request.targetRevision(),
            cells,
            request.replaceAllActualSources(),
            request.settledWeekChangeConfirmation(),
            request.sourceRevision(),
            request.idempotencyKey()
        );
        persistence.recordCashflowSheetMonthAmendments(
            writer,
            projectId,
            amendments,
            request.sourceRevision(),
            request.targetRevision(),
            replacement.resultingTargetRevision(),
            Map.of(request.yearMonth(), calculationChecks),
            request.closedMonthChangeReason(),
            request.idempotencyKey()
        );
        List<WeeklyExpensePersistence.CashflowPendingApprovalWarningEvidence> pendingApprovalEvidence =
            pendingApprovalWarnings.isEmpty() ? List.of() : persistence.recordCashflowPendingApprovalWarnings(
                writer,
                projectId,
                "MONTH_APPLY",
                request.sourceRevision(),
                request.targetRevision(),
                replacement.resultingTargetRevision(),
                request.idempotencyKey(),
                pendingApprovalWarnings
            );
        List<CashflowSnapshotResponse.ActualLine> actual = replacement.actual().stream()
            .map(line -> new CashflowSnapshotResponse.ActualLine(
                line.getSheetKey(),
                line.getYearMonth(),
                line.getWeekNo(),
                line.getCashflowLine(),
                line.getAmount()
            ))
            .toList();
        List<CashflowSnapshotResponse.ProjectionLine> projection = replacement.projection().stream()
            .map(line -> new CashflowSnapshotResponse.ProjectionLine(
                line.getYearMonth(),
                line.getWeekNo(),
                line.getCashflowLine(),
                line.getAmount()
            ))
            .toList();

        WeeklyExpenseAuditEventEntity auditEvent = persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            writer.tenantId(),
            projectId,
            sourceSheetKey,
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            writer.id(),
            normalizeRole(writer.role()),
            request.idempotencyKey(),
            cashflowSheetLabMetadataJson(
                writer,
                sourceSheetKey,
                request.yearMonth(),
                request.sourceRevision(),
                request.targetRevision(),
                replacement.resultingTargetRevision(),
                projection.size(),
                actual.size(),
                request.replaceAllActualSources(),
                amendments,
                pendingApprovalEvidence
            )
        ));

        CashflowSheetLabApplyResponse response = new CashflowSheetLabApplyResponse(
            true,
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            projectId,
            sourceSheetKey,
            request.yearMonth(),
            request.sourceRevision(),
            request.targetRevision(),
            replacement.resultingTargetRevision(),
            projection.size(),
            actual.size(),
            projection,
            actual,
            CashflowSheetLabApplyRequest.calculationCheckResponses(calculationChecks),
            replacement.settledWeekChanges().stream()
                .map(change -> new CashflowSheetBatchApplyResponse.SettledWeekChange(
                    change.yearMonth(),
                    change.weekNo(),
                    change.completionRevision(),
                    change.warningCount()
                ))
                .toList(),
            auditEvent.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(),
            projectId,
            request.idempotencyKey(),
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public CashflowSheetBatchApplyResponse applyCashflowSheetBatch(
        TrustedActorContext actor,
        String projectId,
        CashflowEditSession editSession,
        CashflowSheetBatchApplyRequest request
    ) {
        long startedAt = System.nanoTime();
        TrustedActorContext writer = requireCashflowWritePermission(
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            actor,
            projectId
        );
        String requestHash = hashJson(request);
        Optional<CashflowSheetBatchApplyResponse> replay = readIdempotentResponse(
            writer.tenantId(),
            projectId,
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            request.idempotencyKey(),
            requestHash,
            CashflowSheetBatchApplyResponse.class
        );
        if (replay.isPresent()) return replay.get();

        var cellsByMonth = CashflowSheetBatchApplyRequest
            .requireCompleteMonths(request.months());
        var appliedCellsByMonth = request.requireAppliedMonths();
        List<CashflowPendingApprovalAffectedMonth> pendingApprovalWarnings =
            CashflowPendingApprovalAffectedMonth.requireValid(
                request.pendingApprovalAffectedMonths(), appliedCellsByMonth.keySet()
            );
        List<WeeklyExpensePersistence.CashflowClosedMonthAmendment> amendments = persistence
            .authorizeCashflowSheetMonthAmendments(
                writer,
                projectId,
                appliedCellsByMonth.keySet(),
                request.sourceRevision(),
                request.closedMonthChangeReason(),
                request.idempotencyKey()
            );
        Map<String, List<Map<String, Object>>> calculationChecksByMonth = new LinkedHashMap<>();
        Map<String, CashflowSheetBatchApplyRequest.Month> requestMonthsByYearMonth = request.months().stream()
            .collect(java.util.stream.Collectors.toMap(
                CashflowSheetBatchApplyRequest.Month::yearMonth,
                month -> month
            ));
        Map<String, BigDecimal> openingBalances = request.calculatedOpeningBalances(cellsByMonth.firstKey());
        for (Map.Entry<String, List<CashflowSheetLabApplyRequest.Cell>> entry : cellsByMonth.entrySet()) {
            CashflowSheetBatchApplyRequest.Month month = requestMonthsByYearMonth.get(entry.getKey());
            List<Map<String, Object>> calculationChecks = CashflowSheetLabApplyRequest.recalculateCalculationChecks(
                month.yearMonth(),
                entry.getValue(),
                month.calculationChecks(),
                openingBalances
            );
            calculationChecksByMonth.put(month.yearMonth(), calculationChecks);
            openingBalances = CashflowSheetLabApplyRequest.closingBalances(calculationChecks);
        }
        requireFormulaMismatchConfirmation(calculationChecksByMonth, request.acceptFormulaMismatches());
        assertAtomicWriteBudget(
            Math.multiplyExact(appliedCellsByMonth.size(), CashflowSheetLabApplyRequest.FINANCE_WEEK_COUNT),
            3 + pendingApprovalWarnings.size(),
            "Cashflow sheet batch apply"
        );
        String sourceSheetKey = CASHFLOW_SHEET_LAB_ACTUAL_SOURCE;
        WeeklyExpensePersistence.CashflowSheetBatchReplacement replacement = persistence.replaceCashflowSheetMonths(
            writer.tenantId(),
            projectId,
            sourceSheetKey,
            request.targetRevision(),
            request
        );
        persistence.recordCashflowSheetMonthAmendments(
            writer,
            projectId,
            amendments,
            request.sourceRevision(),
            request.targetRevision(),
            replacement.resultingTargetRevision(),
            calculationChecksByMonth,
            request.closedMonthChangeReason(),
            request.idempotencyKey()
        );
        List<WeeklyExpensePersistence.CashflowPendingApprovalWarningEvidence> pendingApprovalEvidence =
            pendingApprovalWarnings.isEmpty() ? List.of() : persistence.recordCashflowPendingApprovalWarnings(
                writer,
                projectId,
                "BATCH_APPLY",
                request.sourceRevision(),
                request.targetRevision(),
                replacement.resultingTargetRevision(),
                request.idempotencyKey(),
                pendingApprovalWarnings
            );
        List<String> requestedMonths = List.copyOf(appliedCellsByMonth.keySet());
        List<String> replacedMonths = replacement.months().stream()
            .map(WeeklyExpensePersistence.CashflowSheetBatchMonthReplacement::yearMonth)
            .toList();
        if (!replacedMonths.equals(requestedMonths)) {
            throw new IllegalStateException("Cashflow sheet batch replacement scope does not match the request.");
        }
        List<CashflowSheetBatchApplyResponse.MonthResult> months = replacement.months().stream()
            .map(month -> new CashflowSheetBatchApplyResponse.MonthResult(
                month.yearMonth(),
                month.projection().size(),
                month.actual().size(),
                month.projection().stream().map(line -> new CashflowSnapshotResponse.ProjectionLine(
                    line.getYearMonth(),
                    line.getWeekNo(),
                    line.getCashflowLine(),
                    line.getAmount()
                )).toList(),
                month.actual().stream().map(line -> new CashflowSnapshotResponse.ActualLine(
                    line.getSheetKey(),
                    line.getYearMonth(),
                    line.getWeekNo(),
                    line.getCashflowLine(),
                    line.getAmount()
                )).toList(),
                CashflowSheetLabApplyRequest.calculationCheckResponses(
                    calculationChecksByMonth.getOrDefault(month.yearMonth(), List.of())
                )
            ))
            .toList();
        int projectionLineCount = months.stream().mapToInt(CashflowSheetBatchApplyResponse.MonthResult::savedProjectionLineCount).sum();
        int actualLineCount = months.stream().mapToInt(CashflowSheetBatchApplyResponse.MonthResult::savedActualLineCount).sum();
        long durationMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt);

        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("sourceSheetKey", sourceSheetKey);
        metadata.put("scope", "multi-month");
        metadata.put("months", months.stream().map(CashflowSheetBatchApplyResponse.MonthResult::yearMonth).toList());
        metadata.put("sourceRevision", request.sourceRevision());
        metadata.put("targetRevision", request.targetRevision());
        metadata.put("resultingTargetRevision", replacement.resultingTargetRevision());
        metadata.put("projectionLineCount", projectionLineCount);
        metadata.put("actualLineCount", actualLineCount);
        metadata.put("durationMs", durationMs);
        metadata.put("closedMonthAmendments", amendments);
        metadata.put("settledWeekChanges", replacement.settledWeekChanges());
        metadata.put("pendingApprovalAffectedMonths", pendingApprovalEvidence);
        putActorMetadata(metadata, writer);
        WeeklyExpenseAuditEventEntity auditEvent = persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            writer.tenantId(),
            projectId,
            sourceSheetKey,
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            writer.id(),
            normalizeRole(writer.role()),
            request.idempotencyKey(),
            writeJson(metadata)
        ));
        CashflowSheetBatchApplyResponse response = new CashflowSheetBatchApplyResponse(
            true,
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            projectId,
            sourceSheetKey,
            request.sourceRevision(),
            request.targetRevision(),
            replacement.resultingTargetRevision(),
            projectionLineCount,
            actualLineCount,
            months,
            replacement.settledWeekChanges().stream()
                .map(change -> new CashflowSheetBatchApplyResponse.SettledWeekChange(
                    change.yearMonth(),
                    change.weekNo(),
                    change.completionRevision(),
                    change.warningCount()
                ))
                .toList(),
            durationMs,
            auditEvent.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(),
            projectId,
            request.idempotencyKey(),
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public CashflowSheetFormulaPreflightResponse validateCashflowSheetFormulas(
        TrustedActorContext actor,
        String projectId,
        CashflowSheetFormulaPreflightRequest request
    ) {
        requireCashflowWritePermission(CASHFLOW_SHEET_LAB_APPLY_COMMAND, actor, projectId);
        requireCompleteAnnualFormulaEvidence(request);
        var cellsByMonth = CashflowSheetBatchApplyRequest.requireCompleteMonths(request.months());
        if (cellsByMonth.keySet().stream().anyMatch(yearMonth -> !yearMonth.startsWith(request.sourceYear() + "-"))) {
            throw new IllegalArgumentException("Cashflow formula preflight months must belong to the source year.");
        }

        List<CashflowFormulaValidator.OpeningCell> annualCells = request.annualCells().stream()
            .map(cell -> new CashflowFormulaValidator.OpeningCell(
                cell.year(), cell.mode(), cell.cashflowLine(), cell.cellState(), cell.amount()
            ))
            .toList();
        List<CashflowFormulaValidator.AnnualCheck> annualChecks = new ArrayList<>();
        Map<String, BigDecimal> balances = Map.of("projection", BigDecimal.ZERO, "actual", BigDecimal.ZERO);
        List<CashflowFormulaValidator.AnnualCheck> priorChecks = CashflowFormulaValidator.validateAnnualPeriods(
            annualCells.stream().filter(cell -> cell.year() < request.sourceYear()).toList(),
            reportedAnnuals(request, "ANNUAL", true),
            balances
        );
        annualChecks.addAll(priorChecks);
        balances = annualClosingBalances(priorChecks, balances);
        boolean completeSourceYear = cellsByMonth.firstKey().equals(request.sourceYear() + "-01")
            && cellsByMonth.lastKey().equals(request.sourceYear() + "-12")
            && cellsByMonth.size() == 12;
        if (!cellsByMonth.firstKey().endsWith("-01")) balances = Map.of();

        Map<String, List<Map<String, Object>>> weeklyChecksByMonth = new LinkedHashMap<>();
        Map<String, CashflowSheetBatchApplyRequest.Month> monthsByKey = request.months().stream()
            .collect(java.util.stream.Collectors.toMap(CashflowSheetBatchApplyRequest.Month::yearMonth, month -> month));
        for (Map.Entry<String, List<CashflowSheetLabApplyRequest.Cell>> monthEntry : cellsByMonth.entrySet()) {
            CashflowSheetBatchApplyRequest.Month month = monthsByKey.get(monthEntry.getKey());
            List<Map<String, Object>> checks = CashflowSheetLabApplyRequest.recalculateCalculationChecks(
                month.yearMonth(), monthEntry.getValue(), month.calculationChecks(), balances
            );
            weeklyChecksByMonth.put(month.yearMonth(), checks);
            balances = CashflowSheetLabApplyRequest.closingBalances(checks);
        }

        List<CashflowFormulaValidator.AnnualCheck> futureChecks = completeSourceYear
            ? CashflowFormulaValidator.validateAnnualPeriods(
                annualCells.stream().filter(cell -> cell.year() > request.sourceYear()).toList(),
                reportedAnnuals(request, "ANNUAL", false),
                balances
            )
            : List.of();
        annualChecks.addAll(futureChecks);
        List<CashflowFormulaValidator.AnnualCheck> grandTotalChecks = CashflowFormulaValidator.validateAnnualPeriods(
            annualCells.stream().filter(cell -> cell.year() == request.sourceYear()).toList(),
            reportedAnnuals(request, "GRAND_TOTAL", false),
            Map.of("projection", BigDecimal.ZERO, "actual", BigDecimal.ZERO)
        );
        annualChecks.addAll(grandTotalChecks);

        requireFormulaMismatchConfirmation(weeklyChecksByMonth, annualChecks, request.acceptFormulaMismatches());
        return new CashflowSheetFormulaPreflightResponse(
            true,
            projectId,
            annualChecks.size(),
            weeklyChecksByMonth.values().stream().mapToInt(List::size).sum()
        );
    }

    private void requireCompleteAnnualFormulaEvidence(CashflowSheetFormulaPreflightRequest request) {
        Set<Integer> years = request.annualCells().stream()
            .map(cell -> cell.year())
            .collect(java.util.stream.Collectors.toSet());
        Set<String> keys = new java.util.HashSet<>();
        for (CashflowSheetFormulaPreflightRequest.AnnualDerivedCell cell : request.annualDerivedCells()) {
            String expectedKind = cell.year() == request.sourceYear() ? "GRAND_TOTAL" : "ANNUAL";
            if (!years.contains(cell.year()) || !expectedKind.equals(cell.periodKind())
                || !keys.add(cell.year() + ":" + cell.mode() + ":" + cell.field())) {
                throw new IllegalArgumentException("Cashflow annual formula evidence is invalid.");
            }
        }
        if (keys.size() != years.size() * 2 * 3) {
            throw new IllegalArgumentException("Cashflow annual formula evidence is incomplete.");
        }
    }

    private List<CashflowFormulaValidator.ReportedAnnual> reportedAnnuals(
        CashflowSheetFormulaPreflightRequest request,
        String periodKind,
        boolean beforeSourceYear
    ) {
        Map<String, Map<String, CashflowSheetFormulaPreflightRequest.AnnualDerivedCell>> byPeriod = new LinkedHashMap<>();
        request.annualDerivedCells().stream()
            .filter(cell -> cell.periodKind().equals(periodKind))
            .filter(cell -> "GRAND_TOTAL".equals(periodKind)
                ? cell.year() == request.sourceYear()
                : beforeSourceYear ? cell.year() < request.sourceYear() : cell.year() > request.sourceYear())
            .forEach(cell -> byPeriod
                .computeIfAbsent(cell.year() + ":" + cell.mode(), ignored -> new LinkedHashMap<>())
                .put(cell.field(), cell));
        return byPeriod.entrySet().stream().map(entry -> {
            Map<String, CashflowSheetFormulaPreflightRequest.AnnualDerivedCell> fields = entry.getValue();
            if (!fields.keySet().equals(Set.of("depositTotal", "withdrawalTotal", "balance"))) {
                throw new IllegalArgumentException("Cashflow annual formula evidence is incomplete.");
            }
            CashflowSheetFormulaPreflightRequest.AnnualDerivedCell balance = fields.get("balance");
            Map<String, String> sourceCells = new LinkedHashMap<>();
            sourceCells.put("depositTotal", fields.get("depositTotal").sourceCell());
            sourceCells.put("withdrawalTotal", fields.get("withdrawalTotal").sourceCell());
            sourceCells.put("balance", balance.sourceCell());
            return new CashflowFormulaValidator.ReportedAnnual(
                balance.year(),
                balance.mode(),
                fields.get("depositTotal").amount(),
                fields.get("withdrawalTotal").amount(),
                balance.amount(),
                sourceCells
            );
        }).toList();
    }

    private Map<String, BigDecimal> annualClosingBalances(
        List<CashflowFormulaValidator.AnnualCheck> checks,
        Map<String, BigDecimal> fallback
    ) {
        Map<String, BigDecimal> balances = new LinkedHashMap<>(fallback);
        checks.forEach(check -> balances.put(check.mode(), check.balance()));
        return Map.copyOf(balances);
    }

    private void requireFormulaMismatchConfirmation(
        Map<String, List<Map<String, Object>>> checksByMonth,
        boolean accepted
    ) {
        requireFormulaMismatchConfirmation(checksByMonth, List.of(), accepted);
    }

    private void requireFormulaMismatchConfirmation(
        Map<String, List<Map<String, Object>>> checksByMonth,
        List<CashflowFormulaValidator.AnnualCheck> annualChecks,
        boolean accepted
    ) {
        if (accepted) return;
        List<Map<String, Object>> mismatches = new ArrayList<>();
        for (Map.Entry<String, List<Map<String, Object>>> month : checksByMonth.entrySet()) {
            for (Map<String, Object> check : month.getValue()) {
                Map<?, ?> matches = check.get("matches") instanceof Map<?, ?> value ? value : Map.of();
                Map<?, ?> reported = check.get("reported") instanceof Map<?, ?> value ? value : Map.of();
                Map<?, ?> calculated = check.get("calculated") instanceof Map<?, ?> value ? value : Map.of();
                Map<?, ?> sourceCells = check.get("sourceCells") instanceof Map<?, ?> value ? value : Map.of();
                for (String field : List.of("depositTotal", "withdrawalTotal", "balance")) {
                    if (!Boolean.FALSE.equals(matches.get(field))) continue;
                    Map<String, Object> mismatch = new LinkedHashMap<>();
                    mismatch.put("yearMonth", month.getKey());
                    mismatch.put("mode", String.valueOf(check.getOrDefault("mode", "")));
                    mismatch.put("weekNo", check.get("weekNo"));
                    mismatch.put("field", field);
                    mismatch.put("reported", reported.get(field));
                    mismatch.put("calculated", calculated.get(field));
                    if (sourceCells.get(field) != null) mismatch.put("sourceCell", sourceCells.get(field));
                    mismatches.add(java.util.Collections.unmodifiableMap(mismatch));
                }
            }
        }
        for (CashflowFormulaValidator.AnnualCheck check : annualChecks) {
            Map<String, Boolean> matches = Map.of(
                "depositTotal", check.depositTotalMatches(),
                "withdrawalTotal", check.withdrawalTotalMatches(),
                "balance", check.balanceMatches()
            );
            Map<String, BigDecimal> reported = annualReportedValues(check);
            Map<String, BigDecimal> calculated = Map.of(
                "depositTotal", check.depositTotal(),
                "withdrawalTotal", check.withdrawalTotal(),
                "balance", check.balance()
            );
            for (String field : List.of("depositTotal", "withdrawalTotal", "balance")) {
                if (!Boolean.FALSE.equals(matches.get(field))) continue;
                Map<String, Object> mismatch = new LinkedHashMap<>();
                mismatch.put("year", check.year());
                mismatch.put("mode", check.mode());
                mismatch.put("field", field);
                mismatch.put("reported", reported.get(field));
                mismatch.put("calculated", calculated.get(field));
                if (check.sourceCells().get(field) != null) mismatch.put("sourceCell", check.sourceCells().get(field));
                mismatches.add(java.util.Collections.unmodifiableMap(mismatch));
            }
        }
        if (mismatches.isEmpty()) return;
        throw new WeeklyExpenseEditLeaseException(
            409,
            "cashflow_formula_mismatch_confirmation_required",
            "시트 합산 수식과 JVM 계산 결과가 다릅니다. 확인 후 다시 반영해 주세요.",
            Map.of(
                "mismatchCount", mismatches.size(),
                "mismatches", List.copyOf(mismatches)
            )
        );
    }

    private Map<String, BigDecimal> annualReportedValues(CashflowFormulaValidator.AnnualCheck check) {
        Map<String, BigDecimal> values = new LinkedHashMap<>();
        values.put("depositTotal", check.reportedDepositTotal());
        values.put("withdrawalTotal", check.reportedWithdrawalTotal());
        values.put("balance", check.reportedBalance());
        return values;
    }

    public CashflowSheetAnnualApplyResponse applyCashflowSheetAnnualTotal(
        TrustedActorContext actor,
        String projectId,
        CashflowEditSession editSession,
        CashflowSheetAnnualApplyCommand request
    ) {
        TrustedActorContext writer = requireCashflowWritePermission(
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            actor,
            projectId
        );
        String requestHash = hashJson(request);
        Optional<CashflowSheetAnnualApplyResponse> replay = readIdempotentResponse(
            writer.tenantId(),
            projectId,
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            request.idempotencyKey(),
            requestHash,
            CashflowSheetAnnualApplyResponse.class
        );
        if (replay.isPresent()) return replay.get();

        CashflowAnnualCellSet.requireComplete(request.cells());
        assertAtomicWriteBudget(1, 2, "Cashflow annual total apply");
        String sourceSheetKey = CASHFLOW_SHEET_LAB_ACTUAL_SOURCE;
        List<String> annualMonths = java.util.stream.IntStream.rangeClosed(1, 12)
            .mapToObj(month -> "%04d-%02d".formatted(request.year(), month))
            .toList();
        List<WeeklyExpensePersistence.CashflowClosedMonthAmendment> amendments = persistence
            .authorizeCashflowSheetMonthAmendments(
                writer,
                projectId,
                annualMonths,
                request.sourceRevision(),
                request.amendmentReason(),
                request.idempotencyKey()
            );
        WeeklyExpensePersistence.CashflowSheetAnnualReplacement replacement = persistence
            .replaceCashflowSheetYearTotal(writer.tenantId(), projectId, sourceSheetKey, request);
        persistence.recordCashflowSheetMonthAmendments(
            writer,
            projectId,
            amendments,
            request.sourceRevision(),
            String.valueOf(request.expectedRevision()),
            String.valueOf(replacement.revision()),
            Map.of(),
            request.amendmentReason(),
            request.idempotencyKey()
        );

        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("sourceSheetKey", sourceSheetKey);
        metadata.put("scope", "annual");
        metadata.put("year", request.year());
        metadata.put("sourceRevision", request.sourceRevision());
        metadata.put("revision", replacement.revision());
        metadata.put("projectionLineCount", replacement.projection().size());
        metadata.put("actualLineCount", replacement.actual().size());
        metadata.put("amendmentReason", request.amendmentReason());
        metadata.put("closedMonthAmendmentCount", amendments.size());
        putActorMetadata(metadata, writer);
        WeeklyExpenseAuditEventEntity auditEvent = persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            writer.tenantId(),
            projectId,
            sourceSheetKey,
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            writer.id(),
            normalizeRole(writer.role()),
            request.idempotencyKey(),
            writeJson(metadata)
        ));
        CashflowSheetAnnualApplyResponse response = new CashflowSheetAnnualApplyResponse(
            true,
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            projectId,
            sourceSheetKey,
            request.year(),
            request.sourceRevision(),
            replacement.revision(),
            replacement.projection(),
            replacement.actual(),
            replacement.projectionStates(),
            replacement.actualStates(),
            auditEvent.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            writer.tenantId(),
            projectId,
            request.idempotencyKey(),
            CASHFLOW_SHEET_LAB_APPLY_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public SubmitWeekResponse submitWeek(
        TrustedActorContext actor,
        String projectId,
        CashflowEditSession editSession,
        SubmitWeekRequest request
    ) {
        actor = requireWeeklyExpenseWriteLease(SUBMIT_WEEK_COMMAND, actor, projectId, editSession);
        String tenantId = actor.tenantId();
        String requestHash = hashJson(request);
        Optional<SubmitWeekResponse> replay = readIdempotentResponse(
            tenantId,
            projectId,
            SUBMIT_WEEK_COMMAND,
            request.idempotencyKey(),
            requestHash,
            SubmitWeekResponse.class
        );
        if (replay.isPresent()) return replay.get();
        persistence.requireCashflowMonthsOpen(tenantId, projectId, List.of(request.yearMonth()));

        SubmitWeekRequest.WeeklySheetSnapshot weeklySheet = request.weeklySheet();
        WeeklyExpenseSheetEntity sheet = weeklySheet == null
            ? null
            : loadSheet(
                tenantId,
                projectId,
                weeklySheet.sheetKey(),
                weeklySheet.sheetName(),
                weeklySheet.expectedSheetVersion()
            );
        WeeklyExpenseWeeklyStatusEntity status = persistence
            .findWeeklyStatus(
                tenantId,
                projectId,
                request.yearMonth(),
                request.weekNo()
            )
            .orElseGet(() -> new WeeklyExpenseWeeklyStatusEntity(
                tenantId,
                projectId,
                request.yearMonth(),
                request.weekNo()
            ));
        persistence.requireCashflowWeeksOpen(
            tenantId,
            projectId,
            List.of(new WeeklyExpensePersistence.CashflowWeekScope(request.yearMonth(), request.weekNo()))
        );
        List<CellValidationIssue> issues = List.of();
        List<SaveDraftResponse.ActualDelta> actualDelta = List.of();
        int actualWriteCount = 0;
        if (sheet != null) {
            replaceRows(sheet, weeklySheet.rows());
            issues = spreadsheetService.validateAndRecalculateRows(sheet);
            actualDelta = calculateActuals(sheet);
            actualWriteCount = persistence.countCashflowActualReplacementWrites(
                tenantId,
                projectId,
                weeklySheet.sheetKey(),
                actualDelta.stream()
                    .map(delta -> projectId + "-" + delta.yearMonth() + "-w" + delta.weekNo())
                    .distinct()
                    .toList()
            );
        }
        assertAtomicWriteBudget(
            actualWriteCount,
            (sheet == null ? 3 : 4) + finalizeWriteCount(editSession),
            "Weekly submit"
        );
        WeeklyExpenseSheetEntity savedSheet = null;
        if (sheet != null) {
            persistence.replaceActuals(sheet, actualDelta);
            savedSheet = persistence.saveSheet(sheet);
        }
        try {
            status.submit(actor.id());
        } catch (IllegalStateException error) {
            throw new WeeklyExpenseConflictException(error.getMessage());
        }
        WeeklyExpenseWeeklyStatusEntity saved = persistence.saveWeeklyStatus(status);

        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("yearMonth", request.yearMonth());
        metadata.put("weekNo", request.weekNo());
        metadata.put("state", saved.getState());
        if (savedSheet != null) {
            metadata.put("sheetKey", savedSheet.getSheetKey());
            metadata.put("sheetVersion", savedSheet.getSheetVersion());
            metadata.put("savedRowCount", savedSheet.getRows().size());
            metadata.put("validationIssueCount", issues.size());
            metadata.put("actualDeltaCount", actualDelta.size());
        }
        putActorMetadata(metadata, actor);

        WeeklyExpenseAuditEventEntity auditEvent = persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            actor.tenantId(),
            projectId,
            "weekly-status",
            SUBMIT_WEEK_COMMAND,
            actor.id(),
            normalizeRole(actor.role()),
            request.idempotencyKey(),
            writeJson(metadata)
        ));

        SubmitWeekResponse response = new SubmitWeekResponse(
            true,
            SUBMIT_WEEK_COMMAND,
            projectId,
            saved.getYearMonth(),
            saved.getWeekNo(),
            saved.getState(),
            auditEvent.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            actor.tenantId(),
            projectId,
            request.idempotencyKey(),
            SUBMIT_WEEK_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public CloseWeekResponse closeWeek(
        TrustedActorContext actor,
        String projectId,
        CashflowEditSession editSession,
        CloseWeekRequest request
    ) {
        actor = requireWeeklyExpenseWriteLease(CLOSE_WEEK_COMMAND, actor, projectId, editSession);
        requireProjectionLinesMatchWeek(request);
        assertAtomicWriteBudget(
            request.projectionLines().size(),
            3 + finalizeWriteCount(editSession),
            "Weekly close"
        );
        String requestHash = hashJson(request);
        Optional<CloseWeekResponse> replay = readIdempotentResponse(
            actor.tenantId(),
            projectId,
            CLOSE_WEEK_COMMAND,
            request.idempotencyKey(),
            requestHash,
            CloseWeekResponse.class
        );
        if (replay.isPresent()) return replay.get();
        persistence.requireCashflowMonthsOpen(actor.tenantId(), projectId, List.of(request.yearMonth()));

        List<WeeklyExpenseProjectionEntity> projectionEntities = prepareProjectionEntities(
            actor,
            projectId,
            request.projectionLines()
        );
        WeeklyExpenseWeeklyStatusEntity status = persistence
            .findWeeklyStatus(
                actor.tenantId(),
                projectId,
                request.yearMonth(),
                request.weekNo()
            )
            .orElseThrow(() -> new WeeklyExpenseConflictException("Week must be submitted before close."));
        persistence.requireCashflowWeeksOpen(
            actor.tenantId(),
            projectId,
            List.of(new WeeklyExpensePersistence.CashflowWeekScope(request.yearMonth(), request.weekNo()))
        );
        saveProjectionEntities(projectionEntities);
        try {
            status.close(actor.id());
        } catch (IllegalStateException error) {
            throw new WeeklyExpenseConflictException(error.getMessage());
        }
        WeeklyExpenseWeeklyStatusEntity saved = persistence.saveWeeklyStatus(status);

        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("yearMonth", request.yearMonth());
        metadata.put("weekNo", request.weekNo());
        metadata.put("state", saved.getState());
        metadata.put("projectionLineCount", projectionEntities.size());
        putActorMetadata(metadata, actor);

        WeeklyExpenseAuditEventEntity auditEvent = persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            actor.tenantId(),
            projectId,
            "weekly-status",
            CLOSE_WEEK_COMMAND,
            actor.id(),
            normalizeRole(actor.role()),
            request.idempotencyKey(),
            writeJson(metadata)
        ));

        CloseWeekResponse response = new CloseWeekResponse(
            true,
            CLOSE_WEEK_COMMAND,
            projectId,
            saved.getYearMonth(),
            saved.getWeekNo(),
            saved.getState(),
            auditEvent.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            actor.tenantId(),
            projectId,
            request.idempotencyKey(),
            CLOSE_WEEK_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public CreateAuditExportResponse createAuditExport(
        TrustedActorContext actor,
        String projectId,
        CreateAuditExportRequest request
    ) {
        authorizationService.requireProjectAllowed(AUDIT_EXPORT_CREATE_COMMAND, actor, projectId);
        String requestHash = hashJson(request);
        Optional<CreateAuditExportResponse> replay = readIdempotentResponse(
            actor.tenantId(),
            projectId,
            AUDIT_EXPORT_CREATE_COMMAND,
            request.idempotencyKey(),
            requestHash,
            CreateAuditExportResponse.class
        );
        if (replay.isPresent()) return replay.get();

        String artifactType = normalizeExportFormat(request.format());
        List<WeeklyExpenseProjectionEntity> projection = persistence.findProjectionLinesForAudit(actor.tenantId(), projectId);
        List<WeeklyExpenseActualEntity> actual = persistence.findActualLinesForAudit(actor.tenantId(), projectId);
        List<WeeklyExpenseAuditEventEntity> auditEvents = Boolean.FALSE.equals(request.includeAuditSummary())
            ? List.of()
            : persistence.findAuditEventsForAudit(actor.tenantId(), projectId);

        String content = buildAuditExportCsv(projectId, projection, actual, auditEvents);
        String digest = sha256(content);
        String fileName = sanitizeFileName(projectId) + "-weekly-expense-audit.csv";
        WeeklyExpenseAuditExportEntity artifact = persistence.saveAuditExport(new WeeklyExpenseAuditExportEntity(
            actor.tenantId(),
            projectId,
            artifactType,
            fileName,
            digest,
            content,
            projection.size(),
            actual.size(),
            auditEvents.size(),
            actor.id()
        ));

        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("artifactId", artifact.getId());
        metadata.put("artifactType", artifact.getArtifactType());
        metadata.put("fileName", artifact.getArtifactFileName());
        metadata.put("sha256", artifact.getArtifactSha256());
        metadata.put("projectionLineCount", artifact.getProjectionLineCount());
        metadata.put("actualLineCount", artifact.getActualLineCount());
        metadata.put("auditEventCount", artifact.getAuditEventCount());
        putActorMetadata(metadata, actor);

        WeeklyExpenseAuditEventEntity auditEvent = persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            actor.tenantId(),
            projectId,
            "audit-export",
            AUDIT_EXPORT_CREATE_COMMAND,
            actor.id(),
            normalizeRole(actor.role()),
            request.idempotencyKey(),
            writeJson(metadata)
        ));

        CreateAuditExportResponse response = new CreateAuditExportResponse(
            true,
            AUDIT_EXPORT_CREATE_COMMAND,
            projectId,
            artifact.getId(),
            artifact.getArtifactType(),
            artifact.getArtifactFileName(),
            artifact.getArtifactSha256(),
            artifact.getProjectionLineCount(),
            artifact.getActualLineCount(),
            artifact.getAuditEventCount(),
            artifact.getArtifactContent(),
            auditEvent.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            actor.tenantId(),
            projectId,
            request.idempotencyKey(),
            AUDIT_EXPORT_CREATE_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    public CellCommandResponse patchCells(
        TrustedActorContext actor,
        String projectId,
        String sheetKey,
        CashflowEditSession editSession,
        CellPatchCommandRequest request
    ) {
        actor = requireWeeklyExpenseWriteLease(CELL_PATCH_COMMAND, actor, projectId, editSession);
        String requestHash = hashJson(request);
        Optional<CellCommandResponse> replay = readIdempotentResponse(
            actor.tenantId(),
            projectId,
            CELL_PATCH_COMMAND,
            request.idempotencyKey(),
            requestHash,
            CellCommandResponse.class
        );
        if (replay.isPresent()) return replay.get();

        WeeklyExpenseSheetEntity sheet = loadSheet(actor.tenantId(), projectId, sheetKey, request.sheetName(), request.expectedSheetVersion());
        Set<Integer> touchedRows = new LinkedHashSet<>();
        for (CellPatchCommandRequest.CellPatch patch : request.cells()) {
            requireCellCoordinate(patch.rowIndex(), patch.columnIndex());
            WeeklyExpenseRowEntity row = sheet.rowAt(patch.rowIndex());
            WeeklyExpenseCellEntity cell = row.cellAt(patch.columnIndex());
            cell.setRawValue(patch.rawValue());
            cell.setUserEdited(Boolean.TRUE.equals(patch.userEdited()));
            touchedRows.add(patch.rowIndex());
        }
        return finishCellCommand(
            CELL_PATCH_COMMAND,
            projectId,
            sheetKey,
            actor.tenantId(),
            actor,
            request.idempotencyKey(),
            requestHash,
            sheet,
            touchedRows,
            request.cells().size(),
            null
        );
    }

    public CellCommandResponse copyCells(
        TrustedActorContext actor,
        String projectId,
        String sheetKey,
        CashflowEditSession editSession,
        CopyCellsRequest request
    ) {
        actor = requireWeeklyExpenseWriteLease(CELLS_COPY_COMMAND, actor, projectId, editSession);
        String requestHash = hashJson(request);
        Optional<CellCommandResponse> replay = readIdempotentResponse(
            actor.tenantId(),
            projectId,
            CELLS_COPY_COMMAND,
            request.idempotencyKey(),
            requestHash,
            CellCommandResponse.class
        );
        if (replay.isPresent()) return replay.get();

        WeeklyExpenseSheetEntity sheet = loadExistingSheet(actor.tenantId(), projectId, sheetKey, request.expectedSheetVersion());
        requireSelectionBounds(request.startRow(), request.startColumn(), request.endRow(), request.endColumn());
        SpreadsheetSelection selection = new SpreadsheetSelection(
            request.startRow(),
            request.startColumn(),
            request.endRow(),
            request.endColumn()
        );
        ClipboardPayload clipboard = spreadsheetService.copy(sheet, selection, request.depth());
        Set<Integer> touchedRows = new LinkedHashSet<>();
        for (int rowIndex = selection.top(); rowIndex <= selection.bottom(); rowIndex += 1) {
            touchedRows.add(rowIndex);
        }
        return finishCopyCommand(
            projectId,
            sheetKey,
            actor.tenantId(),
            actor,
            request.idempotencyKey(),
            requestHash,
            sheet,
            touchedRows,
            clipboard
        );
    }

    public CellCommandResponse pasteCells(
        TrustedActorContext actor,
        String projectId,
        String sheetKey,
        CashflowEditSession editSession,
        PasteCellsRequest request
    ) {
        actor = requireWeeklyExpenseWriteLease(CELLS_PASTE_COMMAND, actor, projectId, editSession);
        String requestHash = hashJson(request);
        Optional<CellCommandResponse> replay = readIdempotentResponse(
            actor.tenantId(),
            projectId,
            CELLS_PASTE_COMMAND,
            request.idempotencyKey(),
            requestHash,
            CellCommandResponse.class
        );
        if (replay.isPresent()) return replay.get();

        WeeklyExpenseSheetEntity sheet = loadSheet(actor.tenantId(), projectId, sheetKey, request.sheetName(), request.expectedSheetVersion());
        requirePasteRectangle(request);
        ClipboardPayload payload = new ClipboardPayload(
            SpreadsheetOperationType.COPY,
            request.depth(),
            new SpreadsheetSelection(0, 0, request.rowCount() - 1, request.columnCount() - 1),
            request.rowCount(),
            request.columnCount(),
            request.cells().stream()
                .map(cell -> new ClipboardCell(
                    cell.relativeRow(),
                    cell.relativeColumn(),
                    cell.rawValue(),
                    cell.normalizedValue() == null ? cell.rawValue() : cell.normalizedValue(),
                    cell.valueType() == null ? SpreadsheetValueType.TEXT : cell.valueType(),
                    cell.validationStatus() == null ? CellValidationStatus.UNKNOWN : cell.validationStatus(),
                    cell.validationMessage() == null ? "" : cell.validationMessage()
                ))
                .toList()
        );
        PasteResult result = spreadsheetService.paste(sheet, new CellAddress(request.anchorRow(), request.anchorColumn()), payload);
        return finishCellCommand(
            CELLS_PASTE_COMMAND,
            projectId,
            sheetKey,
            actor.tenantId(),
            actor,
            request.idempotencyKey(),
            requestHash,
            sheet,
            result.touchedRows(),
            result.touchedCellCount(),
            null
        );
    }

    public CellCommandResponse cutCells(
        TrustedActorContext actor,
        String projectId,
        String sheetKey,
        CashflowEditSession editSession,
        CutCellsRequest request
    ) {
        actor = requireWeeklyExpenseWriteLease(CELLS_CUT_COMMAND, actor, projectId, editSession);
        String requestHash = hashJson(request);
        Optional<CellCommandResponse> replay = readIdempotentResponse(
            actor.tenantId(),
            projectId,
            CELLS_CUT_COMMAND,
            request.idempotencyKey(),
            requestHash,
            CellCommandResponse.class
        );
        if (replay.isPresent()) return replay.get();

        WeeklyExpenseSheetEntity sheet = loadSheet(actor.tenantId(), projectId, sheetKey, null, request.expectedSheetVersion());
        requireSelectionBounds(request.startRow(), request.startColumn(), request.endRow(), request.endColumn());
        SpreadsheetSelection selection = new SpreadsheetSelection(
            request.startRow(),
            request.startColumn(),
            request.endRow(),
            request.endColumn()
        );
        ClipboardPayload clipboard = spreadsheetService.cut(sheet, selection, request.depth());
        Set<Integer> touchedRows = new LinkedHashSet<>();
        for (int rowIndex = selection.top(); rowIndex <= selection.bottom(); rowIndex += 1) {
            touchedRows.add(rowIndex);
        }
        return finishCellCommand(
            CELLS_CUT_COMMAND,
            projectId,
            sheetKey,
            actor.tenantId(),
            actor,
            request.idempotencyKey(),
            requestHash,
            sheet,
            touchedRows,
            clipboard.cells().size(),
            clipboard
        );
    }

    public RowCommandResponse insertRows(
        TrustedActorContext actor,
        String projectId,
        String sheetKey,
        CashflowEditSession editSession,
        RowInsertRequest request
    ) {
        actor = requireWeeklyExpenseWriteLease(ROW_INSERT_COMMAND, actor, projectId, editSession);
        String requestHash = hashJson(request);
        Optional<RowCommandResponse> replay = readIdempotentResponse(
            actor.tenantId(),
            projectId,
            ROW_INSERT_COMMAND,
            request.idempotencyKey(),
            requestHash,
            RowCommandResponse.class
        );
        if (replay.isPresent()) return replay.get();

        WeeklyExpenseSheetEntity sheet = loadSheet(actor.tenantId(), projectId, sheetKey, request.sheetName(), request.expectedSheetVersion());
        requireRowSpan(request.startRow(), request.rowCount());
        requireInsertDoesNotOverflowExistingRows(sheet, request.startRow(), request.rowCount());
        if (sheet.getRows().size() + request.rowCount() > WeeklyExpenseRequestLimits.MAX_ROW_COUNT) {
            throw new IllegalArgumentException("Row insert would exceed weekly expense sheet row limit.");
        }
        sheet.moveRowsToTemporaryIndexesFrom(request.startRow(), ROW_REINDEX_TEMPORARY_OFFSET);
        persistence.flushSheet(sheet);
        Set<Integer> touchedRows = new LinkedHashSet<>(sheet.finishInsertRowsFromTemporaryIndexes(
            request.startRow(),
            request.rowCount(),
            ROW_REINDEX_TEMPORARY_OFFSET
        ));
        return finishRowCommand(
            ROW_INSERT_COMMAND,
            projectId,
            sheetKey,
            actor.tenantId(),
            actor,
            request.idempotencyKey(),
            requestHash,
            sheet,
            touchedRows,
            request.rowCount()
        );
    }

    public RowCommandResponse deleteRows(
        TrustedActorContext actor,
        String projectId,
        String sheetKey,
        CashflowEditSession editSession,
        RowDeleteRequest request
    ) {
        actor = requireWeeklyExpenseWriteLease(ROW_DELETE_COMMAND, actor, projectId, editSession);
        String requestHash = hashJson(request);
        Optional<RowCommandResponse> replay = readIdempotentResponse(
            actor.tenantId(),
            projectId,
            ROW_DELETE_COMMAND,
            request.idempotencyKey(),
            requestHash,
            RowCommandResponse.class
        );
        if (replay.isPresent()) return replay.get();

        WeeklyExpenseSheetEntity sheet = loadSheet(actor.tenantId(), projectId, sheetKey, null, request.expectedSheetVersion());
        requireRowSpan(request.startRow(), request.rowCount());
        requireExpectedRowVersions(sheet, request.expectedRowVersions());
        sheet.moveRowsToTemporaryIndexesFrom(request.startRow(), ROW_REINDEX_TEMPORARY_OFFSET);
        persistence.flushSheet(sheet);
        Set<Integer> touchedRows = new LinkedHashSet<>(sheet.finishDeleteRowsFromTemporaryIndexes(
            request.startRow(),
            request.rowCount(),
            ROW_REINDEX_TEMPORARY_OFFSET
        ));
        return finishRowCommand(
            ROW_DELETE_COMMAND,
            projectId,
            sheetKey,
            actor.tenantId(),
            actor,
            request.idempotencyKey(),
            requestHash,
            sheet,
            touchedRows,
            request.rowCount()
        );
    }

    private WeeklyExpenseSheetEntity loadSheet(
        String tenantId,
        String projectId,
        String sheetKey,
        String sheetName,
        Long expectedSheetVersion
    ) {
        Optional<WeeklyExpenseSheetEntity> existing = persistence.findSheetForUpdate(tenantId, projectId, sheetKey);
        if (existing.isEmpty()) {
            return new WeeklyExpenseSheetEntity(tenantId, projectId, sheetKey, sheetName);
        }
        WeeklyExpenseSheetEntity sheet = existing.get();
        if (expectedSheetVersion == null) {
            throw new WeeklyExpenseConflictException("Existing sheet mutations require expectedSheetVersion.");
        }
        if (sheet.getSheetVersion() != expectedSheetVersion) {
            throw new WeeklyExpenseConflictException("Sheet version mismatch. Reload the sheet before applying this command.");
        }
        if (sheetName != null) {
            sheet.setName(sheetName);
        }
        return sheet;
    }

    private List<WeeklyExpenseProjectionEntity> prepareProjectionEntities(
        TrustedActorContext actor,
        String projectId,
        List<UpsertProjectionRequest.ProjectionLinePatch> lines
    ) {
        Map<String, ProjectionLineAccumulator> projectionPatches = new LinkedHashMap<>();
        for (UpsertProjectionRequest.ProjectionLinePatch line : lines) {
            String cashflowLine = requireKnownCashflowLine(line.cashflowLine());
            String key = line.yearMonth() + ":" + line.weekNo() + ":" + cashflowLine;
            ProjectionLineAccumulator accumulator = projectionPatches.get(key);
            BigDecimal amount = line.amount() == null ? BigDecimal.ZERO : line.amount();
            if (accumulator == null) {
                projectionPatches.put(key, new ProjectionLineAccumulator(
                    line.yearMonth(), line.weekNo(), cashflowLine, amount
                ));
            } else {
                accumulator.add(amount);
            }
        }

        List<WeeklyExpenseProjectionEntity> entities = new ArrayList<>();
        for (ProjectionLineAccumulator line : projectionPatches.values()) {
            Optional<WeeklyExpenseProjectionEntity> existing = persistence.findProjectionLine(
                actor.tenantId(),
                projectId,
                line.yearMonth,
                line.weekNo,
                line.cashflowLine
            );
            if (existing.isPresent() && line.amount.compareTo(existing.get().getAmount()) == 0) {
                continue;
            }
            WeeklyExpenseProjectionEntity entity = existing.orElseGet(() -> new WeeklyExpenseProjectionEntity(
                actor.tenantId(),
                projectId,
                line.yearMonth,
                line.weekNo,
                line.cashflowLine
            ));
            entity.setAmount(line.amount);
            entities.add(entity);
        }
        return entities;
    }

    private List<CashflowSnapshotResponse.ProjectionLine> saveProjectionEntities(
        List<WeeklyExpenseProjectionEntity> entities
    ) {
        if (!entities.isEmpty()) {
            WeeklyExpenseProjectionEntity first = entities.getFirst();
            persistence.requireCashflowMonthsOpen(
                first.getTenantId(),
                first.getProjectId(),
                entities.stream().map(WeeklyExpenseProjectionEntity::getYearMonth).distinct().toList()
            );
            persistence.requireCashflowWeeksOpen(
                first.getTenantId(),
                first.getProjectId(),
                entities.stream()
                    .map(entity -> new WeeklyExpensePersistence.CashflowWeekScope(
                        entity.getYearMonth(),
                        entity.getWeekNo()
                    ))
                    .distinct()
                    .toList()
            );
        }
        List<CashflowSnapshotResponse.ProjectionLine> savedLines = new ArrayList<>();
        for (WeeklyExpenseProjectionEntity entity : entities) {
            WeeklyExpenseProjectionEntity saved = persistence.saveProjection(entity);
            savedLines.add(new CashflowSnapshotResponse.ProjectionLine(
                saved.getYearMonth(),
                saved.getWeekNo(),
                saved.getCashflowLine(),
                saved.getAmount()
            ));
        }
        return savedLines;
    }

    private void requireProjectionLinesMatchWeek(CloseWeekRequest request) {
        for (UpsertProjectionRequest.ProjectionLinePatch line : request.projectionLines()) {
            if (!request.yearMonth().equals(line.yearMonth()) || request.weekNo() != line.weekNo()) {
                throw new IllegalArgumentException("Close projection lines must match the week being closed.");
            }
        }
    }

    private WeeklyExpenseSheetEntity loadExistingSheet(
        String tenantId,
        String projectId,
        String sheetKey,
        Long expectedSheetVersion
    ) {
        WeeklyExpenseSheetEntity sheet = persistence
            .findSheetForUpdate(tenantId, projectId, sheetKey)
            .orElseThrow(() -> new WeeklyExpenseConflictException("Cannot copy from a sheet that does not exist."));
        if (expectedSheetVersion == null) {
            throw new WeeklyExpenseConflictException("Existing sheet copy requires expectedSheetVersion.");
        }
        if (sheet.getSheetVersion() != expectedSheetVersion) {
            throw new WeeklyExpenseConflictException("Sheet version mismatch. Reload the sheet before applying this command.");
        }
        return sheet;
    }

    private CellCommandResponse finishCopyCommand(
        String projectId,
        String sheetKey,
        String tenantId,
        TrustedActorContext actor,
        String idempotencyKey,
        String requestHash,
        WeeklyExpenseSheetEntity sheet,
        Set<Integer> touchedRows,
        ClipboardPayload clipboard
    ) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("sheetId", sheet.getId());
        metadata.put("sheetKey", sheet.getSheetKey());
        metadata.put("sheetVersion", sheet.getSheetVersion());
        metadata.put("sourceSelection", clipboard.sourceSelection());
        metadata.put("touchedRows", touchedRows);
        metadata.put("touchedCellCount", clipboard.cells().size());
        metadata.put("depth", clipboard.depth());
        putActorMetadata(metadata, actor);

        WeeklyExpenseAuditEventEntity auditEvent = persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            tenantId,
            projectId,
            sheetKey,
            CELLS_COPY_COMMAND,
            actor.id(),
            normalizeRole(actor.role()),
            idempotencyKey,
            writeJson(metadata)
        ));

        CellCommandResponse response = new CellCommandResponse(
            true,
            CELLS_COPY_COMMAND,
            projectId,
            sheet.getId(),
            sheet.getSheetKey(),
            sheet.getSheetVersion(),
            touchedRows,
            clipboard.cells().size(),
            List.of(),
            List.of(),
            clipboard,
            auditEvent.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            tenantId,
            projectId,
            idempotencyKey,
            CELLS_COPY_COMMAND,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    private CellCommandResponse finishCellCommand(
        String commandName,
        String projectId,
        String sheetKey,
        String tenantId,
        TrustedActorContext actor,
        String idempotencyKey,
        String requestHash,
        WeeklyExpenseSheetEntity sheet,
        Set<Integer> touchedRows,
        int touchedCellCount,
        ClipboardPayload clipboard
    ) {
        List<CellValidationIssue> issues = spreadsheetService.validateAndRecalculateRows(sheet);
        List<SaveDraftResponse.ActualDelta> actualDelta = persistActuals(sheet);
        WeeklyExpenseSheetEntity savedSheet = persistence.saveSheet(sheet);

        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("sheetId", savedSheet.getId());
        metadata.put("sheetKey", savedSheet.getSheetKey());
        metadata.put("sheetVersion", savedSheet.getSheetVersion());
        metadata.put("touchedRows", touchedRows);
        metadata.put("touchedCellCount", touchedCellCount);
        metadata.put("validationIssueCount", issues.size());
        metadata.put("actualDeltaCount", actualDelta.size());
        putActorMetadata(metadata, actor);

        WeeklyExpenseAuditEventEntity auditEvent = persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            tenantId,
            projectId,
            sheetKey,
            commandName,
            actor.id(),
            normalizeRole(actor.role()),
            idempotencyKey,
            writeJson(metadata)
        ));

        CellCommandResponse response = new CellCommandResponse(
            true,
            commandName,
            projectId,
            savedSheet.getId(),
            savedSheet.getSheetKey(),
            savedSheet.getSheetVersion(),
            touchedRows,
            touchedCellCount,
            issues,
            actualDelta,
            clipboard,
            auditEvent.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            tenantId,
            projectId,
            idempotencyKey,
            commandName,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    private RowCommandResponse finishRowCommand(
        String commandName,
        String projectId,
        String sheetKey,
        String tenantId,
        TrustedActorContext actor,
        String idempotencyKey,
        String requestHash,
        WeeklyExpenseSheetEntity sheet,
        Set<Integer> touchedRows,
        int affectedRowCount
    ) {
        List<CellValidationIssue> issues = spreadsheetService.validateAndRecalculateRows(sheet);
        List<SaveDraftResponse.ActualDelta> actualDelta = persistActuals(sheet);
        WeeklyExpenseSheetEntity savedSheet = persistence.saveSheet(sheet);

        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("sheetId", savedSheet.getId());
        metadata.put("sheetKey", savedSheet.getSheetKey());
        metadata.put("sheetVersion", savedSheet.getSheetVersion());
        metadata.put("touchedRows", touchedRows);
        metadata.put("affectedRowCount", affectedRowCount);
        metadata.put("validationIssueCount", issues.size());
        metadata.put("actualDeltaCount", actualDelta.size());
        putActorMetadata(metadata, actor);

        WeeklyExpenseAuditEventEntity auditEvent = persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            tenantId,
            projectId,
            sheetKey,
            commandName,
            actor.id(),
            normalizeRole(actor.role()),
            idempotencyKey,
            writeJson(metadata)
        ));

        RowCommandResponse response = new RowCommandResponse(
            true,
            commandName,
            projectId,
            savedSheet.getId(),
            savedSheet.getSheetKey(),
            savedSheet.getSheetVersion(),
            touchedRows,
            rowVersionsFor(savedSheet, touchedRows),
            affectedRowCount,
            issues,
            actualDelta,
            auditEvent.getId()
        );
        persistence.saveIdempotency(new WeeklyExpenseIdempotencyEntity(
            tenantId,
            projectId,
            idempotencyKey,
            commandName,
            requestHash,
            writeJson(response)
        ));
        return response;
    }

    private List<RowCommandResponse.RowVersion> rowVersionsFor(
        WeeklyExpenseSheetEntity sheet,
        Set<Integer> rowIndexes
    ) {
        List<RowCommandResponse.RowVersion> rowVersions = new ArrayList<>();
        for (Integer rowIndex : rowIndexes) {
            if (rowIndex == null) continue;
            sheet.findRow(rowIndex)
                .map(row -> new RowCommandResponse.RowVersion(row.getRowIndex(), row.getRowVersion()))
                .ifPresent(rowVersions::add);
        }
        rowVersions.sort(Comparator.comparingInt(RowCommandResponse.RowVersion::rowIndex));
        return rowVersions;
    }

    private void requirePasteRectangle(PasteCellsRequest request) {
        requireRowSpan(request.anchorRow(), request.rowCount());
        requireColumnSpan(request.anchorColumn(), request.columnCount());
        long expectedCellCount = (long) request.rowCount() * request.columnCount();
        if (expectedCellCount != request.cells().size()) {
            throw new IllegalArgumentException("Paste cells must exactly match rowCount * columnCount.");
        }
        Set<String> positions = new LinkedHashSet<>();
        for (PasteCellsRequest.PasteCell cell : request.cells()) {
            if (cell.relativeRow() >= request.rowCount() || cell.relativeColumn() >= request.columnCount()) {
                throw new IllegalArgumentException("Paste cell coordinate is outside the declared rectangle.");
            }
            String key = cell.relativeRow() + ":" + cell.relativeColumn();
            if (!positions.add(key)) {
                throw new IllegalArgumentException("Paste rectangle contains duplicate cell coordinates.");
            }
        }
    }

    private void requireInsertDoesNotOverflowExistingRows(WeeklyExpenseSheetEntity sheet, int startRow, int rowCount) {
        for (WeeklyExpenseRowEntity row : sheet.getRows()) {
            if (row.getRowIndex() >= startRow && row.getRowIndex() + rowCount > WeeklyExpenseRequestLimits.MAX_ROW_INDEX) {
                throw new IllegalArgumentException("Row insert would move existing rows beyond the weekly expense sheet row limit.");
            }
        }
    }

    private void requireSelectionBounds(int startRow, int startColumn, int endRow, int endColumn) {
        int top = Math.min(startRow, endRow);
        int bottom = Math.max(startRow, endRow);
        int left = Math.min(startColumn, endColumn);
        int right = Math.max(startColumn, endColumn);
        requireRowSpan(top, bottom - top + 1);
        requireColumnSpan(left, right - left + 1);
    }

    private void requireCellCoordinate(int rowIndex, int columnIndex) {
        requireRowIndex(rowIndex);
        requireColumnIndex(columnIndex);
    }

    private void requireRowSpan(int startRow, int rowCount) {
        requireRowIndex(startRow);
        if (rowCount <= 0 || (long) startRow + rowCount > WeeklyExpenseRequestLimits.MAX_ROW_COUNT) {
            throw new IllegalArgumentException("Row range exceeds weekly expense sheet row limit.");
        }
    }

    private void requireColumnSpan(int startColumn, int columnCount) {
        requireColumnIndex(startColumn);
        if (columnCount <= 0 || startColumn + columnCount > WeeklyExpenseRequestLimits.COLUMN_COUNT) {
            throw new IllegalArgumentException("Column range exceeds weekly expense sheet schema.");
        }
    }

    private void requireRowIndex(int rowIndex) {
        if (rowIndex < 0 || rowIndex > WeeklyExpenseRequestLimits.MAX_ROW_INDEX) {
            throw new IllegalArgumentException("rowIndex exceeds weekly expense sheet row limit.");
        }
    }

    private void requireColumnIndex(int columnIndex) {
        if (columnIndex < 0 || columnIndex > WeeklyExpenseRequestLimits.MAX_COLUMN_INDEX) {
            throw new IllegalArgumentException("columnIndex is outside the weekly expense sheet schema.");
        }
    }

    private void requireExpectedRowVersions(
        WeeklyExpenseSheetEntity sheet,
        List<RowDeleteRequest.ExpectedRowVersion> expectedRowVersions
    ) {
        if (expectedRowVersions == null || expectedRowVersions.isEmpty()) {
            throw new WeeklyExpenseConflictException("Deleting rows requires explicit row version checks.");
        }
        for (RowDeleteRequest.ExpectedRowVersion expected : expectedRowVersions) {
            WeeklyExpenseRowEntity row = sheet.findRow(expected.rowIndex())
                .orElseThrow(() -> new WeeklyExpenseConflictException("Expected row does not exist: " + expected.rowIndex()));
            if (row.getRowVersion() != expected.rowVersion()) {
                throw new WeeklyExpenseConflictException("Row version mismatch for row " + expected.rowIndex() + ".");
            }
        }
    }

    private void replaceRows(WeeklyExpenseSheetEntity sheet, List<SaveDraftRequest.RowPatch> rows) {
        requireUniqueRowPatchIdentities(rows);
        Map<Integer, ExistingRowIdentity> existingByIndex = new LinkedHashMap<>();
        Map<String, ExistingRowIdentity> existingById = new LinkedHashMap<>();
        Map<String, ExistingRowIdentity> existingBySourceTx = new LinkedHashMap<>();
        for (WeeklyExpenseRowEntity existing : sheet.getRows()) {
            ExistingRowIdentity identity = new ExistingRowIdentity(existing.getId(), existing.getRowVersion(), existing.getSourceTxId());
            existingByIndex.put(existing.getRowIndex(), identity);
            if (existing.getId() != null && !existing.getId().isBlank()) {
                existingById.put(existing.getId(), identity);
            }
            if (existing.getSourceTxId() != null && !existing.getSourceTxId().isBlank()) {
                existingBySourceTx.put(existing.getSourceTxId(), identity);
            }
        }
        sheet.getRows().clear();
        for (SaveDraftRequest.RowPatch rowPatch : rows) {
            WeeklyExpenseRowEntity row = sheet.rowAt(rowPatch.rowIndex());
            ExistingRowIdentity identity = resolveExistingRowIdentity(rowPatch, existingById, existingBySourceTx, existingByIndex);
            if (identity != null) {
                row.restorePersistenceState(identity.id(), identity.rowVersion());
            }
            row.setSourceTxId(rowPatch.sourceTxId());
            row.setEntryKind(rowPatch.entryKind());
            for (SaveDraftRequest.CellPatch cellPatch : rowPatch.cells()) {
                requireCellCoordinate(rowPatch.rowIndex(), cellPatch.columnIndex());
                WeeklyExpenseCellEntity cell = row.cellAt(cellPatch.columnIndex());
                cell.setRawValue(cellPatch.rawValue());
                cell.setUserEdited(Boolean.TRUE.equals(cellPatch.userEdited()));
            }
        }
    }

    private void requireUniqueRowPatchIdentities(List<SaveDraftRequest.RowPatch> rows) {
        Set<Integer> rowIndexes = new LinkedHashSet<>();
        Set<String> tempIds = new LinkedHashSet<>();
        Set<String> sourceTxIds = new LinkedHashSet<>();
        for (SaveDraftRequest.RowPatch row : rows) {
            if (!rowIndexes.add(row.rowIndex())) {
                throw new WeeklyExpenseConflictException("Duplicate row index in save draft request: " + row.rowIndex());
            }
            String tempId = normalizeOptionalIdentity(row.tempId());
            if (tempId != null && !tempIds.add(tempId)) {
                throw new WeeklyExpenseConflictException("Duplicate row tempId in save draft request.");
            }
            String sourceTxId = normalizeOptionalIdentity(row.sourceTxId());
            if (sourceTxId != null && !sourceTxIds.add(sourceTxId)) {
                throw new WeeklyExpenseConflictException("Duplicate source transaction in save draft request.");
            }
        }
    }

    private String normalizeOptionalIdentity(String value) {
        if (value == null) return null;
        String normalized = value.trim();
        return normalized.isBlank() ? null : normalized;
    }

    private ExistingRowIdentity resolveExistingRowIdentity(
        SaveDraftRequest.RowPatch rowPatch,
        Map<String, ExistingRowIdentity> existingById,
        Map<String, ExistingRowIdentity> existingBySourceTx,
        Map<Integer, ExistingRowIdentity> existingByIndex
    ) {
        if (rowPatch.tempId() != null && !rowPatch.tempId().isBlank()) {
            ExistingRowIdentity byId = existingById.get(rowPatch.tempId());
            if (byId != null) return byId;
        }
        if (rowPatch.sourceTxId() != null && !rowPatch.sourceTxId().isBlank()) {
            ExistingRowIdentity bySourceTx = existingBySourceTx.get(rowPatch.sourceTxId());
            if (bySourceTx != null) return bySourceTx;
        }
        return existingByIndex.get(rowPatch.rowIndex());
    }

    private List<SaveDraftResponse.ActualDelta> persistActuals(WeeklyExpenseSheetEntity sheet) {
        return persistence.replaceActuals(sheet, calculateActuals(sheet));
    }

    private List<SaveDraftResponse.ActualDelta> calculateActuals(WeeklyExpenseSheetEntity sheet) {
        Map<String, SaveDraftResponse.ActualDelta> deltas = new LinkedHashMap<>();
        for (WeeklyExpenseRowEntity row : sheet.getRows()) {
            if (row.getValidationErrorCount() > 0 || row.getReviewRequiredCount() > 0) {
                continue;
            }
            WeekKey week = parseWeek(row);
            String cashflowLine = CashflowLineCatalog.canonicalize(textAt(row, WeeklyExpenseColumn.CASHFLOW_LINE));
            if (week == null || cashflowLine.isBlank()) continue;
            BigDecimal amount = WeeklyExpenseFormulaEngine.evaluateRow(row).actualAmount();
            if (amount.signum() == 0) continue;
            String key = week.yearMonth + ":" + week.weekNo + ":" + cashflowLine;
            SaveDraftResponse.ActualDelta previous = deltas.get(key);
            BigDecimal nextAmount = previous == null ? amount : previous.amount().add(amount);
            deltas.put(key, new SaveDraftResponse.ActualDelta(week.yearMonth, week.weekNo, cashflowLine, nextAmount));
        }

        return new ArrayList<>(deltas.values());
    }

    private WeekKey parseWeek(WeeklyExpenseRowEntity row) {
        String label = textAt(row, WeeklyExpenseColumn.WEEK);
        Matcher matcher = WEEK_LABEL_PATTERN.matcher(label);
        if (matcher.find()) {
            return new WeekKey(matcher.group(1), Integer.parseInt(matcher.group(2)));
        }
        Matcher shortMatcher = SHORT_WEEK_LABEL_PATTERN.matcher(label);
        if (!shortMatcher.find()) return null;
        int year = 2000 + Integer.parseInt(shortMatcher.group(1));
        int month = Integer.parseInt(shortMatcher.group(2));
        int weekNo = Integer.parseInt(shortMatcher.group(3));
        return new WeekKey(String.format("%04d-%02d", year, month), weekNo);
    }

    private String textAt(WeeklyExpenseRowEntity row, WeeklyExpenseColumn column) {
        return row.findCell(column.index())
            .map(WeeklyExpenseCellEntity::getNormalizedValue)
            .filter(value -> !value.isBlank())
            .or(() -> row.findCell(column.index()).map(WeeklyExpenseCellEntity::getRawValue))
            .orElse("")
            .trim();
    }

    private void setRawCell(WeeklyExpenseRowEntity row, WeeklyExpenseColumn column, String rawValue, boolean userEdited) {
        WeeklyExpenseCellEntity cell = row.cellAt(column.index());
        cell.setRawValue(rawValue);
        cell.setUserEdited(userEdited);
    }

    private String moneyText(BigDecimal value) {
        if (value == null) return "0";
        return value.stripTrailingZeros().toPlainString();
    }

    private CanonicalBankImportLine canonicalizeBankImportLine(
        List<String> columns,
        ImportBankStatementBatchRequest.LinePatch line
    ) {
        List<String> safeColumns = columns == null ? List.of() : columns.stream().map(this::normalizeText).toList();
        List<String> sourceCells = line.rawCells() == null ? List.of() : line.rawCells();
        List<String> rawCells = new ArrayList<>();
        for (int i = 0; i < safeColumns.size(); i++) {
            rawCells.add(i < sourceCells.size() ? normalizeText(sourceCells.get(i)) : "");
        }
        int dateIndex = firstHeaderIndex(safeColumns, List.of("거래일자", "거래일시", "거래일", "일자", "날짜", "date"));
        String rawDate = dateIndex >= 0 ? rawCells.get(dateIndex) : rawCells.stream()
            .map(this::normalizeDateTimeToSecond)
            .filter(value -> !value.isBlank())
            .findFirst()
            .orElse("");
        String dateTime = normalizeDateTimeToSecond(rawDate);
        String counterparty = pickBankCounterparty(safeColumns, rawCells);
        BankImportAmount amount = pickBankAmount(safeColumns, rawCells);
        if (dateTime.isBlank() || counterparty.isBlank() || amount.signedAmount() == null) {
            throw new IllegalArgumentException("Bank import row requires transaction date, counterparty, and amount.");
        }
        BigDecimal signedAmount = amount.signedAmount();
        String sourceLineKey = "bank-" + sha256(dateTime + "|" + normalizeKey(counterparty) + "|" + moneyText(signedAmount));
        return new CanonicalBankImportLine(
            line.lineIndex(),
            sourceLineKey,
            dateTime.substring(0, Math.min(10, dateTime.length())),
            counterparty,
            pickBankMemo(safeColumns, rawCells),
            signedAmount,
            pickBankBalanceAfter(safeColumns, rawCells),
            rawCells
        );
    }

    private String normalizeDateTimeToSecond(String raw) {
        String value = normalizeText(raw).replace('.', '-').replace('T', ' ');
        if (value.isBlank()) return "";
        Matcher ymd = Pattern
            .compile("(\\d{4})\\D(\\d{1,2})\\D(\\d{1,2})(?:\\s+(\\d{1,2})(?::(\\d{1,2}))?(?::(\\d{1,2}))?)?")
            .matcher(value);
        if (ymd.find()) {
            String date = ymd.group(1) + "-" + twoDigits(ymd.group(2)) + "-" + twoDigits(ymd.group(3));
            if (ymd.group(4) == null) return date;
            return date + " " + twoDigits(ymd.group(4)) + ":" + twoDigits(defaultText(ymd.group(5), "0")) + ":" + twoDigits(defaultText(ymd.group(6), "0"));
        }
        Matcher mdy = Pattern
            .compile("(\\d{1,2})/(\\d{1,2})/(\\d{2}|\\d{4})(?:\\s+(\\d{1,2})(?::(\\d{1,2}))?(?::(\\d{1,2}))?)?")
            .matcher(value);
        if (mdy.find()) {
            int year = Integer.parseInt(mdy.group(3));
            if (year < 100) year += 2000;
            String date = year + "-" + twoDigits(mdy.group(1)) + "-" + twoDigits(mdy.group(2));
            if (mdy.group(4) == null) return date;
            return date + " " + twoDigits(mdy.group(4)) + ":" + twoDigits(defaultText(mdy.group(5), "0")) + ":" + twoDigits(defaultText(mdy.group(6), "0"));
        }
        return "";
    }

    private String pickBankCounterparty(List<String> columns, List<String> rawCells) {
        List<List<String>> groups = List.of(
            List.of("사용처", "가맹점", "상호", "거래처", "지급처"),
            List.of("의뢰인/수취인", "의뢰인수취인", "수취인", "의뢰인", "상대계좌명"),
            List.of("내용", "거래내용"),
            List.of("적요", "메모")
        );
        for (List<String> aliases : groups) {
            for (int idx : headerIndices(columns, aliases)) {
                String value = cell(rawCells, idx);
                if (!value.isBlank()) return value;
            }
        }
        return "";
    }

    private String pickBankMemo(List<String> columns, List<String> rawCells) {
        for (int idx : headerIndices(columns, List.of("적요", "메모", "내용", "거래내용", "상세적요"))) {
            String value = cell(rawCells, idx);
            if (!value.isBlank()) return value;
        }
        return "";
    }

    private BigDecimal pickBankBalanceAfter(List<String> columns, List<String> rawCells) {
        int idx = firstHeaderIndex(columns, List.of("잔액"));
        if (idx < 0) return BigDecimal.ZERO;
        BigDecimal parsed = parseBankMoney(cell(rawCells, idx));
        return parsed == null ? BigDecimal.ZERO : parsed;
    }

    private BankImportAmount pickBankAmount(List<String> columns, List<String> rawCells) {
        BigDecimal deposit = null;
        BigDecimal withdrawal = null;
        BigDecimal generic = null;
        for (int i = 0; i < columns.size(); i++) {
            String header = normalizeKey(columns.get(i));
            if (header.contains(normalizeKey("잔액"))) continue;
            BigDecimal parsed = parseBankMoney(cell(rawCells, i));
            if (parsed == null || parsed.compareTo(BigDecimal.ZERO) == 0) continue;
            if (header.contains(normalizeKey("입금"))) {
                deposit = parsed.abs();
            } else if (header.contains(normalizeKey("출금")) || header.contains(normalizeKey("공급가액"))) {
                withdrawal = parsed.abs();
            } else if (header.contains(normalizeKey("금액")) || header.contains("amount")) {
                generic = parsed;
            }
        }
        if (deposit != null) return new BankImportAmount(deposit);
        if (withdrawal != null) return new BankImportAmount(withdrawal.negate());
        if (generic != null) return new BankImportAmount(generic);
        return new BankImportAmount(null);
    }

    private BigDecimal parseBankMoney(String raw) {
        String value = normalizeText(raw);
        if (value.isBlank()) return null;
        boolean wrappedNegative = value.startsWith("(") && value.endsWith(")");
        String cleaned = value.replace(",", "").replace("원", "").replace("+", "").replace("(", "").replace(")", "").trim();
        if (cleaned.isBlank() || "-".equals(cleaned)) return null;
        try {
            BigDecimal parsed = new BigDecimal(cleaned);
            return wrappedNegative ? parsed.abs().negate() : parsed;
        } catch (NumberFormatException error) {
            return null;
        }
    }

    private int firstHeaderIndex(List<String> columns, List<String> aliases) {
        for (String alias : aliases) {
            String key = normalizeKey(alias);
            for (int i = 0; i < columns.size(); i++) {
                if (normalizeKey(columns.get(i)).equals(key)) return i;
            }
        }
        for (String alias : aliases) {
            String key = normalizeKey(alias);
            for (int i = 0; i < columns.size(); i++) {
                String header = normalizeKey(columns.get(i));
                if (!header.isBlank() && header.contains(key)) return i;
            }
        }
        return -1;
    }

    private List<Integer> headerIndices(List<String> columns, List<String> aliases) {
        List<Integer> indices = new ArrayList<>();
        Set<Integer> seen = new LinkedHashSet<>();
        for (String alias : aliases) {
            String key = normalizeKey(alias);
            for (int i = 0; i < columns.size(); i++) {
                String header = normalizeKey(columns.get(i));
                if (!header.isBlank() && (header.equals(key) || header.contains(key)) && seen.add(i)) {
                    indices.add(i);
                }
            }
        }
        return indices;
    }

    private String normalizeText(String value) {
        return value == null ? "" : value.replace('\u00a0', ' ').trim().replaceAll("\\s+", " ");
    }

    private String normalizeKey(String value) {
        return normalizeText(value).toLowerCase(Locale.ROOT).replaceAll("[\\s_\\-./()\\[\\]]+", "");
    }

    private String cell(List<String> cells, int index) {
        return index >= 0 && index < cells.size() ? normalizeText(cells.get(index)) : "";
    }

    private String defaultText(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }

    private String twoDigits(String value) {
        return String.format("%02d", Integer.parseInt(value));
    }

    private Set<Integer> touchedRows(List<SaveDraftRequest.RowPatch> rows) {
        Set<Integer> touched = new LinkedHashSet<>();
        for (SaveDraftRequest.RowPatch row : rows) touched.add(row.rowIndex());
        return touched;
    }

    private int countCells(WeeklyExpenseSheetEntity sheet) {
        int count = 0;
        for (WeeklyExpenseRowEntity row : sheet.getRows()) count += row.getCells().size();
        return count;
    }

    private String normalizeRole(String role) {
        return role == null || role.isBlank() ? "unknown" : role.trim().toLowerCase(Locale.ROOT);
    }

    private String metadataJson(
        TrustedActorContext actor,
        WeeklyExpenseSheetEntity sheet,
        List<CellValidationIssue> issues,
        List<SaveDraftResponse.ActualDelta> actualDelta
    ) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("sheetId", sheet.getId());
        metadata.put("sheetKey", sheet.getSheetKey());
        metadata.put("sheetVersion", sheet.getSheetVersion());
        metadata.put("rowCount", sheet.getRows().size());
        metadata.put("cellCount", countCells(sheet));
        metadata.put("validationIssueCount", issues.size());
        metadata.put("actualDeltaCount", actualDelta.size());
        putActorMetadata(metadata, actor);
        return writeJson(metadata);
    }

    private String projectionMetadataJson(TrustedActorContext actor, int lineCount) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("lineCount", lineCount);
        putActorMetadata(metadata, actor);
        return writeJson(metadata);
    }

    private String cashflowSheetLabMetadataJson(
        TrustedActorContext actor,
        String sourceSheetKey,
        String yearMonth,
        String sourceRevision,
        String targetRevision,
        String resultingTargetRevision,
        int projectionLineCount,
        int actualLineCount,
        boolean replaceAllActualSources,
        List<WeeklyExpensePersistence.CashflowClosedMonthAmendment> amendments,
        List<WeeklyExpensePersistence.CashflowPendingApprovalWarningEvidence> pendingApprovalEvidence
    ) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("sourceSheetKey", sourceSheetKey);
        metadata.put("yearMonth", yearMonth);
        metadata.put("sourceRevision", sourceRevision);
        metadata.put("targetRevision", targetRevision);
        metadata.put("resultingTargetRevision", resultingTargetRevision);
        metadata.put("projectionLineCount", projectionLineCount);
        metadata.put("actualLineCount", actualLineCount);
        metadata.put("replaceAllActualSources", replaceAllActualSources);
        metadata.put("closedMonthAmendments", amendments);
        metadata.put("pendingApprovalAffectedMonths", pendingApprovalEvidence);
        putActorMetadata(metadata, actor);
        return writeJson(metadata);
    }

    private void putActorMetadata(Map<String, Object> metadata, TrustedActorContext actor) {
        metadata.put("actorEmail", actor.email());
        metadata.put("actorName", actor.name());
        metadata.put("actorRole", normalizeRole(actor.role()));
    }

    private String normalizeExportFormat(String format) {
        String value = format == null || format.isBlank() ? "CSV" : format.trim().toUpperCase(Locale.ROOT);
        if (!"CSV".equals(value)) {
            throw new IllegalArgumentException("Only CSV audit exports are supported.");
        }
        return value;
    }

    private String buildAuditExportCsv(
        String projectId,
        List<WeeklyExpenseProjectionEntity> projection,
        List<WeeklyExpenseActualEntity> actual,
        List<WeeklyExpenseAuditEventEntity> auditEvents
    ) {
        StringBuilder out = new StringBuilder();
        out.append(csvLine("section", "projectId", "yearMonth", "weekNo", "sheetKey", "cashflowLine", "amount", "commandName", "actorId", "actorRole", "idempotencyKey", "createdAt", "actorEmail", "actorName"));
        for (WeeklyExpenseProjectionEntity line : projection) {
            out.append(csvLine(
                "PROJECTION",
                projectId,
                line.getYearMonth(),
                String.valueOf(line.getWeekNo()),
                "",
                line.getCashflowLine(),
                line.getAmount().toPlainString(),
                "",
                "",
                "",
                "",
                "",
                "",
                ""
            ));
        }
        for (WeeklyExpenseActualEntity line : actual) {
            out.append(csvLine(
                "ACTUAL",
                projectId,
                line.getYearMonth(),
                String.valueOf(line.getWeekNo()),
                line.getSheetKey(),
                line.getCashflowLine(),
                line.getAmount().toPlainString(),
                "",
                "",
                "",
                "",
                "",
                "",
                ""
            ));
        }
        for (WeeklyExpenseAuditEventEntity event : auditEvents) {
            JsonNode metadata = readMetadataNode(event.getMetadataJson());
            out.append(csvLine(
                "AUDIT_SUMMARY",
                projectId,
                "",
                "",
                event.getSheetKey(),
                "",
                "",
                event.getCommandName(),
                event.getActorId(),
                event.getActorRole(),
                event.getIdempotencyKey(),
                event.getCreatedAt().toString(),
                metadataText(metadata, "actorEmail"),
                metadataText(metadata, "actorName", "actorDisplayName")
            ));
        }
        return out.toString();
    }

    private String csvLine(String... values) {
        List<String> escaped = new ArrayList<>();
        for (String value : values) {
            escaped.add(csvEscape(value));
        }
        return String.join(",", escaped) + "\n";
    }

    private String csvEscape(String value) {
        String text = csvFormulaSafeValue(value == null ? "" : value);
        if (text.contains("\"") || text.contains(",") || text.contains("\n") || text.contains("\r")) {
            return "\"" + text.replace("\"", "\"\"") + "\"";
        }
        return text;
    }

    private String csvFormulaSafeValue(String value) {
        String text = value == null ? "" : value;
        String leadingTrimmed = text.stripLeading();
        if (leadingTrimmed.isEmpty()) return text;
        char first = leadingTrimmed.charAt(0);
        if (first == '=' || first == '+' || first == '-' || first == '@') {
            return "'" + text;
        }
        return text;
    }

    private String sanitizeFileName(String value) {
        String text = value == null || value.isBlank() ? "project" : value.trim();
        return text.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private CashflowEditSession finalizedSession(CashflowEditSession session) {
        if (session == null) return null;
        return new CashflowEditSession(
            session.dataProjectId(),
            session.sessionId(),
            session.leaseId(),
            session.fence(),
            true
        );
    }

    private CashflowEditSession nonFinalSession(CashflowEditSession session) {
        if (session == null) return null;
        return new CashflowEditSession(
            session.dataProjectId(),
            session.sessionId(),
            session.leaseId(),
            session.fence(),
            false
        );
    }

    private String requireIdempotencyKey(String value) {
        String key = value == null ? "" : value.trim();
        if (key.isBlank() || key.length() > WeeklyExpenseRequestLimits.MAX_IDEMPOTENCY_KEY_LENGTH) {
            throw new IllegalArgumentException("idempotencyKey is required and must be at most 120 characters.");
        }
        return key;
    }

    private void requireVarianceContent(CashflowVarianceRequest request) {
        if (request.expectedRevision() == null) {
            throw new IllegalArgumentException("expectedRevision is required.");
        }
        if (request.sheetId().isBlank()
            || request.sheetId().equals(".")
            || request.sheetId().equals("..")
            || request.sheetId().contains("/")
            || request.sheetId().getBytes(StandardCharsets.UTF_8).length > 512) {
            throw new IllegalArgumentException("sheetId is invalid.");
        }
        if (!Set.of("FLAG", "REPLY", "RESOLVE").contains(request.action())) {
            throw new IllegalArgumentException("Variance action must be FLAG, REPLY, or RESOLVE.");
        }
        if (("FLAG".equals(request.action()) || "REPLY".equals(request.action()))
            && request.content().isBlank()) {
            throw new IllegalArgumentException("Variance content is required for FLAG and REPLY.");
        }
        if (request.content().getBytes(StandardCharsets.UTF_8).length > 2_000) {
            throw new IllegalArgumentException("Variance content must be at most 2,000 UTF-8 bytes.");
        }
    }

    private void requireVarianceActionRole(String role, String action) {
        String normalizedRole = normalizeRole(role);
        if ("REPLY".equals(action)) {
            if (!"pm".equals(normalizedRole)) {
                throw new WeeklyExpenseForbiddenException("Project manager role is required to reply to a cashflow variance.");
            }
            return;
        }
        if (!CASHFLOW_VARIANCE_REVIEW_ROLES.contains(normalizedRole)) {
            throw new WeeklyExpenseForbiddenException("Finance review role is required to flag or resolve a cashflow variance.");
        }
    }

    private String varianceAuditMetadataJson(
        TrustedActorContext actor,
        WeeklyExpensePersistence.CashflowVarianceRecord variance,
        String action
    ) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("entityType", "cashflow_week");
        metadata.put("entityId", variance.sheetId());
        metadata.put("action", "CASHFLOW_VARIANCE_" + action);
        metadata.put("yearMonth", variance.yearMonth());
        metadata.put("revision", variance.varianceRevision());
        putActorMetadata(metadata, actor);
        return writeJson(metadata);
    }

    private WeeklyExpenseAuditEventEntity saveMonthCloseAudit(
        TrustedActorContext actor,
        String projectId,
        String commandName,
        String idempotencyKey,
        CashflowMonthCloseState close
    ) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("yearMonth", close.yearMonth());
        metadata.put("status", close.status());
        metadata.put("revision", close.revision());
        metadata.put("reopenCount", close.reopenCount());
        metadata.put("projectWarningCount", close.projectWarningCount());
        metadata.put("snapshotHash", close.snapshotHash());
        metadata.put("previousSnapshotHash", close.previousSnapshotHash());
        metadata.put("late", close.late());
        metadata.put("closedAt", close.closedAt());
        metadata.put("reopenReason", close.reopenReason());
        metadata.put("reopenDecision", close.reopenDecision());
        metadata.put("reopenDecisionReason", close.reopenDecisionReason());
        metadata.put("requestId", close.snapshot().getOrDefault("requestId", ""));
        metadata.put("requestRevision", close.snapshot().getOrDefault("requestRevision", 0));
        metadata.put("manifestHash", close.snapshot().getOrDefault("manifestHash", ""));
        metadata.put("approvalId", close.snapshot().getOrDefault("approvalId", ""));
        metadata.put("operationId", close.snapshot().getOrDefault("operationId", ""));
        metadata.put(
            "previousAuthorityExists",
            close.snapshot().getOrDefault("previousAuthorityExists", false)
        );
        metadata.put("affectedFromMonth", close.snapshot().getOrDefault("affectedFromMonth", ""));
        metadata.put("affectedThroughMonth", close.snapshot().getOrDefault("affectedThroughMonth", ""));
        metadata.put("approvalVersionId", close.snapshot().getOrDefault("approvalVersionId", ""));
        putActorMetadata(metadata, actor);
        return persistence.saveAuditEvent(new WeeklyExpenseAuditEventEntity(
            actor.tenantId(),
            projectId,
            "month-close",
            commandName,
            actor.id(),
            normalizeRole(actor.role()),
            idempotencyKey,
            writeJson(metadata)
        ));
    }

    private CashflowMonthCloseResponse monthCloseResponse(
        String commandName,
        CashflowMonthCloseState close,
        String auditId
    ) {
        return CashflowMonthCloseResponse.fromState(commandName, close, auditId, close.status());
    }

    private long longMetadata(Object value) {
        return value instanceof Number number ? number.longValue() : 0;
    }

    private CashflowWeeklyUpdateCompletionResponse weeklyCompletionResponse(
        String commandName,
        WeeklyExpensePersistence.CashflowWeeklyUpdateCompletionRecord saved
    ) {
        return new CashflowWeeklyUpdateCompletionResponse(
            true,
            commandName,
            saved.projectId(),
            saved.yearMonth(),
            saved.weekNo(),
            saved.completedAt(),
            saved.completedBy(),
            saved.alreadyCompleted(),
            saved.status(),
            saved.revision(),
            saved.reopenCount(),
            saved.snapshotHash(),
            saved.sourceRevision(),
            saved.targetRevision(),
            saved.reopenedAt(),
            saved.reopenedBy(),
            saved.reopenReason(),
            saved.deadline(),
            saved.complianceStatus(),
            saved.operationId(),
            saved.auditId(),
            saved.updateResult()
        );
    }

    private String text(String value) {
        return value == null ? "" : value;
    }

    private TrustedActorContext requireWeeklyExpenseWriteLease(
        String commandName,
        TrustedActorContext actor,
        String projectId,
        CashflowEditSession editSession
    ) {
        if (!cashflowEditLeasesEnabled) {
            throw new WeeklyExpenseEditLeaseException(
                503,
                "weekly_expense_edit_leases_disabled",
                "Weekly expense writes require the configured edit-lease runtime."
            );
        }
        String storedRole = persistence.requireCashflowWriteLease(actor, projectId, editSession);
        TrustedActorContext storedActor = new TrustedActorContext(
            actor.tenantId(),
            actor.id(),
            actor.email(),
            storedRole,
            actor.name()
        );
        authorizationService.requireAllowed(commandName, storedActor);
        return storedActor;
    }

    private TrustedActorContext requireCashflowWritePermission(
        String commandName,
        TrustedActorContext actor,
        String projectId
    ) {
        return requireCashflowWritePermissionWithoutLeaseRuntime(commandName, actor, projectId);
    }

    private TrustedActorContext requireCashflowWritePermissionWithoutLeaseRuntime(
        String commandName,
        TrustedActorContext actor,
        String projectId
    ) {
        String storedRole = persistence.requireCashflowWritePermission(actor, projectId);
        TrustedActorContext storedActor = new TrustedActorContext(
            actor.tenantId(),
            actor.id(),
            actor.email(),
            storedRole,
            actor.name()
        );
        authorizationService.requireAllowed(commandName, storedActor);
        return storedActor;
    }

    private TrustedActorContext requireCashflowMonthClosePermission(
        String commandName,
        TrustedActorContext actor,
        String projectId
    ) {
        String storedRole = persistence.requireCashflowMonthClosePermission(actor, projectId);
        TrustedActorContext storedActor = new TrustedActorContext(
            actor.tenantId(), actor.id(), actor.email(), storedRole, actor.name()
        );
        authorizationService.requireAllowed(commandName, storedActor);
        return storedActor;
    }

    private TrustedActorContext requireCashflowMonthReopenDecisionPermission(
        TrustedActorContext actor,
        String projectId
    ) {
        CashflowMonthReopenPolicy.DecisionAuthority authority =
            readCashflowMonthReopenDecisionAuthority(reopenActor(actor), projectId);
        cashflowMonthReopenPort.bindCashflowMonthReopenDecisionAuthority(authority);
        return new TrustedActorContext(
            actor.tenantId(), actor.id(), actor.email(), authority.storedRole(), actor.name()
        );
    }

    private CashflowMonthReopenPolicy.DecisionAuthority readCashflowMonthReopenDecisionAuthority(
        CashflowMonthReopenPort.Actor actor,
        String projectId
    ) {
        return CashflowMonthReopenPolicy.requireDecisionAuthority(
            cashflowMonthReopenPort.findCashflowMonthReopenDecisionAuthorityFacts(
                actor,
                projectId
            )
        );
    }

    private CashflowMonthReopenPort.Actor reopenActor(TrustedActorContext actor) {
        return new CashflowMonthReopenPort.Actor(actor.tenantId(), actor.id(), actor.name());
    }

    private CashflowMonthReopenPort.SettlementCycleContext settlementCycleContext(
        CashflowMonthReopenCommands.RequestReopen request
    ) {
        return new CashflowMonthReopenPort.SettlementCycleContext(
            request.idempotencyKey(), request.requestId(), request.cycleYearMonth(), request.monthCloseTargetYearMonth(),
            request.evidenceRevision(), request.manifestHash(), request.expectedWorkflowRevision()
        );
    }

    private CashflowMonthReopenPort.SettlementCycleContext settlementCycleContext(
        CashflowMonthReopenCommands.DecideReopen request
    ) {
        return new CashflowMonthReopenPort.SettlementCycleContext(
            request.idempotencyKey(), request.requestId(), request.cycleYearMonth(), request.monthCloseTargetYearMonth(),
            request.evidenceRevision(), request.manifestHash(), request.expectedWorkflowRevision()
        );
    }

    private List<CashflowSheetLabApplyRequest.Cell> requireCompleteCashflowSheetMonth(
        CashflowSheetLabApplyRequest request
    ) {
        return CashflowSheetLabApplyRequest.requireCompleteMonth(request.cells());
    }

    private String requireKnownCashflowLine(String value) {
        String line = CashflowLineCatalog.canonicalize(value);
        if (line.isBlank() || !CashflowLineCatalog.ALL_LINES.contains(line)) {
            throw new IllegalArgumentException("Unsupported cashflow line.");
        }
        return line;
    }

    private void assertAtomicWriteBudget(int inputCount, int fixedWriteCount, String command) {
        int expectedWriteCount = inputCount + fixedWriteCount;
        if (expectedWriteCount > WeeklyExpenseRequestLimits.FIRESTORE_ATOMIC_WRITE_LIMIT) {
            throw new WeeklyExpenseAtomicWriteLimitException(command, expectedWriteCount);
        }
    }

    private int finalizeWriteCount(CashflowEditSession editSession) {
        return editSession != null && editSession.finalizeLease() ? 1 : 0;
    }

    private String legacyCloseCashflowMonthRequestHash(CloseCashflowMonthRequest request) {
        if (!request.cycleYearMonth().isBlank()
            || !request.monthCloseTargetYearMonth().isBlank()
            || request.expectedWorkflowRevision() != 0
            || !request.decisionReason().isBlank()) {
            return null;
        }
        return hashJson(new LegacyCloseCashflowMonthRequest(
            request.idempotencyKey(),
            request.sourceRevision(),
            request.targetRevision(),
            request.yearMonth(),
            request.expectedRevision(),
            request.expectedDraftRevision(),
            request.humanReviewed(),
            request.depositScheduleRows(),
            request.cells(),
            request.confirmations(),
            request.managementChecks(),
            request.managementConfirmations(),
            request.openingBalances(),
            request.deadlineSummary(),
            request.requestId(),
            request.requestRevision(),
            request.manifestHash()
        ));
    }

    private String legacyRequestReopenHash(CashflowMonthReopenCommands.RequestReopen request) {
        if (!request.requestId().isBlank()
            || !request.cycleYearMonth().isBlank()
            || !request.monthCloseTargetYearMonth().isBlank()
            || request.evidenceRevision() != 0
            || !request.manifestHash().isBlank()
            || request.expectedWorkflowRevision() != 0) {
            return null;
        }
        return hashJson(new LegacyRequestReopen(
            request.idempotencyKey(), request.yearMonth(), request.expectedRevision(), request.reason()
        ));
    }

    private String legacyDecideReopenHash(CashflowMonthReopenCommands.DecideReopen request) {
        if (!request.requestId().isBlank()
            || !request.cycleYearMonth().isBlank()
            || !request.monthCloseTargetYearMonth().isBlank()
            || request.evidenceRevision() != 0
            || !request.manifestHash().isBlank()
            || request.expectedWorkflowRevision() != 0) {
            return null;
        }
        return hashJson(new LegacyDecideReopen(
            request.idempotencyKey(), request.yearMonth(), request.expectedRevision(),
            request.decision(), request.reason()
        ));
    }

    private String hashJson(Object request) {
        return sha256(writeJson(request));
    }

    private <T> Optional<T> readIdempotentResponse(
        String tenantId,
        String projectId,
        String commandName,
        String idempotencyKey,
        String requestHash,
        Class<T> responseType
    ) {
        return readCompatibleIdempotentResponse(
            tenantId,
            projectId,
            commandName,
            idempotencyKey,
            requestHash,
            List.of(),
            responseType
        );
    }

    private <T> Optional<T> readCompatibleIdempotentResponse(
        String tenantId,
        String projectId,
        String commandName,
        String idempotencyKey,
        String requestHash,
        List<String> compatibleRequestHashes,
        Class<T> responseType
    ) {
        Optional<WeeklyExpenseIdempotencyEntity> existing = persistence.findIdempotency(
            tenantId,
            projectId,
            commandName,
            idempotencyKey
        );
        if (existing.isEmpty()) return Optional.empty();

        WeeklyExpenseIdempotencyEntity idempotency = existing.get();
        boolean exactRequest = idempotency.getRequestHash().equals(requestHash);
        boolean exactCompatibleRequest = compatibleRequestHashes.contains(idempotency.getRequestHash());
        if (!exactRequest && !exactCompatibleRequest) {
            throw new WeeklyExpenseConflictException("Idempotency key already exists with a different request body.");
        }
        return Optional.of(readJson(idempotency.getResponseJson(), responseType));
    }

    private boolean matchesOperationIdentity(
        WeeklyExpenseIdempotencyEntity entity,
        TrustedActorContext actor,
        String projectId,
        String idempotencyKey
    ) {
        return actor.tenantId().equals(entity.getTenantId())
            && projectId.equals(entity.getProjectId())
            && CASHFLOW_SHEET_LAB_APPLY_COMMAND.equals(entity.getCommandName())
            && idempotencyKey.equals(entity.getIdempotencyKey());
    }

    private CashflowSheetOperationStatusResponse missingOperation(
        String projectId,
        CashflowSheetOperation operation,
        String keyHash
    ) {
        return new CashflowSheetOperationStatusResponse(
            "1", projectId, operation.name(), keyHash, "NOT_FOUND", null, null, null,
            List.of(), List.of(), List.of(), null, null
        );
    }

    private void requireOperationLookupKey(String idempotencyKey) {
        if (idempotencyKey == null
            || idempotencyKey.isBlank()
            || idempotencyKey.length() > WeeklyExpenseRequestLimits.MAX_IDEMPOTENCY_KEY_LENGTH
            || idempotencyKey.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException("idempotencyKey must contain 1 to 160 non-control characters.");
        }
    }

    private String requiredResultText(JsonNode result, String... fields) {
        for (String field : fields) {
            String value = result.path(field).asText("");
            if (!value.isBlank()) return value;
        }
        throw new IllegalStateException("Stored cashflow operation result is missing " + fields[0] + ".");
    }

    private String requiredYearMonth(String value) {
        if (value == null || !value.matches("20\\d{2}-(0[1-9]|1[0-2])")) {
            throw new IllegalStateException("Stored cashflow operation month is invalid.");
        }
        return value;
    }

    private List<String> appliedMonths(JsonNode months) {
        if (!months.isArray() || months.isEmpty() || months.size() > CashflowSheetBatchApplyRequest.MAX_MONTH_COUNT) {
            throw new IllegalStateException("Stored cashflow batch operation months are invalid.");
        }
        LinkedHashSet<String> result = new LinkedHashSet<>();
        months.forEach(month -> result.add(requiredYearMonth(month.path("yearMonth").asText())));
        if (result.size() != months.size()) {
            throw new IllegalStateException("Stored cashflow batch operation months contain duplicates.");
        }
        return List.copyOf(result);
    }

    private JsonNode readJsonNode(String json) {
        try {
            JsonNode result = objectMapper.readTree(json);
            if (result == null || !result.isObject()) {
                throw new IllegalStateException("Stored idempotent response must be a JSON object.");
            }
            return result;
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Stored idempotent response is invalid JSON", error);
        }
    }

    private enum CashflowSheetOperation {
        MONTH_APPLY,
        BATCH_APPLY,
        ANNUAL_APPLY;

        private static CashflowSheetOperation parse(String value) {
            try {
                return valueOf(value == null ? "" : value);
            } catch (IllegalArgumentException error) {
                throw new IllegalArgumentException(
                    "operationType must be MONTH_APPLY, BATCH_APPLY, or ANNUAL_APPLY."
                );
            }
        }

        private static CashflowSheetOperation detect(JsonNode result) {
            if (result.path("months").isArray()) return BATCH_APPLY;
            if (result.path("year").isIntegralNumber() && result.path("revision").isIntegralNumber()) {
                return ANNUAL_APPLY;
            }
            return result.path("yearMonth").isTextual() ? MONTH_APPLY : null;
        }
    }

    private String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashed = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder();
            for (byte b : hashed) out.append(String.format("%02x", b));
            return out.toString();
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is not available", error);
        }
    }

    private <T> T readJson(String json, Class<T> type) {
        try {
            return objectMapper.readValue(json, type);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Stored idempotent response is invalid JSON", error);
        }
    }

    private String writeJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Could not serialize weekly expense command payload", error);
        }
    }

    private List<String> readStringList(String json) {
        try {
            return objectMapper.readerForListOf(String.class).readValue(json == null || json.isBlank() ? "[]" : json);
        } catch (Exception error) {
            return List.of();
        }
    }

    private static String normalizeImportLineStatus(String status) {
        if (status == null || status.isBlank()) {
            return "staged";
        }
        String normalized = status.trim().toLowerCase(Locale.ROOT);
        return "all".equals(normalized) ? null : normalized;
    }

    private record LegacyCloseCashflowMonthRequest(
        String idempotencyKey,
        String sourceRevision,
        String targetRevision,
        String yearMonth,
        long expectedRevision,
        long expectedDraftRevision,
        boolean humanReviewed,
        List<CloseCashflowMonthRequest.DepositScheduleRow> depositScheduleRows,
        List<CashflowSheetLabApplyRequest.Cell> cells,
        List<CloseCashflowMonthRequest.Confirmation> confirmations,
        List<CloseCashflowMonthRequest.ManagementCheck> managementChecks,
        List<CloseCashflowMonthRequest.ManagementConfirmation> managementConfirmations,
        dev.merryai.innerplatform.weekly.api.CashflowOpeningBalancesResponse openingBalances,
        CloseCashflowMonthRequest.DeadlineSummary deadlineSummary,
        String requestId,
        long requestRevision,
        String manifestHash
    ) {
    }

    private record ActorBoundIdempotencyRequest(String actorUid, Object request) {
    }

    private record RequestFirstActorBoundIdempotencyRequest(Object request, String actorUid) {
    }

    private record LegacyRequestReopen(
        String idempotencyKey,
        String yearMonth,
        long expectedRevision,
        String reason
    ) {
    }

    private record LegacyDecideReopen(
        String idempotencyKey,
        String yearMonth,
        long expectedRevision,
        String decision,
        String reason
    ) {
    }

    private record WeekKey(String yearMonth, int weekNo) {
    }

    private record BankImportAmount(BigDecimal signedAmount) {
    }

    private record CanonicalBankImportLine(
        int lineIndex,
        String sourceLineKey,
        String transactionDate,
        String counterparty,
        String memo,
        BigDecimal signedAmount,
        BigDecimal balanceAfter,
        List<String> rawCells
    ) {
    }

    private static final class ProjectionLineAccumulator {
        private final String yearMonth;
        private final int weekNo;
        private final String cashflowLine;
        private BigDecimal amount;

        private ProjectionLineAccumulator(String yearMonth, int weekNo, String cashflowLine, BigDecimal amount) {
            this.yearMonth = yearMonth;
            this.weekNo = weekNo;
            this.cashflowLine = cashflowLine;
            this.amount = amount;
        }

        private void add(BigDecimal nextAmount) {
            this.amount = this.amount.add(nextAmount);
        }
    }

    private record ExistingRowIdentity(String id, long rowVersion, String sourceTxId) {
    }
}
