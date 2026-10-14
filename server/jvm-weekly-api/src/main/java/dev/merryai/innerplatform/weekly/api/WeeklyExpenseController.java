package dev.merryai.innerplatform.weekly.api;

import dev.merryai.innerplatform.weekly.domain.CashflowLedgerSource;
import dev.merryai.innerplatform.weekly.domain.CashflowMonthReopenPolicy;
import dev.merryai.innerplatform.weekly.domain.CashflowOpeningBalance;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import dev.merryai.innerplatform.weekly.domain.CashflowLineCatalog;
import dev.merryai.innerplatform.weekly.service.WeeklyExpenseCommandService;
import jakarta.validation.Valid;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;
import dev.merryai.innerplatform.weekly.domain.CashflowWeekTotals;
import dev.merryai.innerplatform.weekly.service.CashflowReadService;
import dev.merryai.innerplatform.weekly.service.command.CashflowMonthReopenCommands;
import dev.merryai.innerplatform.weekly.service.command.CashflowSheetAnnualApplyCommand;
import dev.merryai.innerplatform.weekly.service.port.CashflowMonthReopenPort;
import dev.merryai.innerplatform.weekly.service.query.CashflowMonthDashboardQueryService;
import dev.merryai.innerplatform.weekly.domain.CashflowAnnualCellSet;
import dev.merryai.innerplatform.weekly.domain.ApproverDeadlineCalculator;
import dev.merryai.innerplatform.weekly.domain.CashflowCloseDeadline;
import org.springframework.beans.factory.annotation.Autowired;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

@RestController
@RequestMapping("/api/v1")
public class WeeklyExpenseController {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final System.Logger LOGGER = System.getLogger(WeeklyExpenseController.class.getName());
    private final WeeklyExpenseCommandService commandService;
    private final CashflowReadService readService;
    private final CashflowMonthDashboardQueryService dashboardQueryService;
    private final boolean legacyWeekCloseEnabled;

    @Autowired
    public WeeklyExpenseController(
        WeeklyExpenseCommandService commandService,
        CashflowReadService readService,
        CashflowMonthDashboardQueryService dashboardQueryService,
        @Value("${weekly.legacy-week-close-enabled:false}") boolean legacyWeekCloseEnabled
    ) {
        this.commandService = commandService;
        this.readService = readService;
        this.dashboardQueryService = dashboardQueryService;
        this.legacyWeekCloseEnabled = legacyWeekCloseEnabled;
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        return Map.of(
            "ok", true,
            "service", "jvm-weekly-api",
            "runtime", "spring-boot",
            "capabilities", List.of("settlement-cycle-v1")
        );
    }

    @PostMapping("/weekly-expenses/{projectId}/sheets/{sheetKey}/save-draft")
    public SaveDraftResponse saveDraft(
        @PathVariable String projectId,
        @PathVariable String sheetKey,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody SaveDraftRequest request
    ) {
        return commandService.saveDraft(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            sheetKey,
            editSession(httpRequest),
            request
        );
    }

    @GetMapping("/weekly-expenses/{projectId}/sheets/{sheetKey}")
    public WeeklyExpenseSheetResponse readSheet(
        @PathVariable String projectId,
        @PathVariable String sheetKey,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail
    ) {
        return commandService.readSheet(actorContext(tenantId, actorId, actorRole, actorEmail), projectId, sheetKey);
    }

    @GetMapping("/weekly-expenses/{projectId}/sheets")
    public WeeklyExpenseSheetsResponse listSheets(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail
    ) {
        return commandService.listSheets(actorContext(tenantId, actorId, actorRole, actorEmail), projectId);
    }

    @PostMapping("/weekly-expenses/{projectId}/bank-statements/import-batch")
    public ImportBankStatementBatchResponse importBankStatementBatch(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody ImportBankStatementBatchRequest request
    ) {
        return commandService.importBankStatementBatch(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            editSession(httpRequest),
            request
        );
    }

    @GetMapping("/weekly-expenses/{projectId}/bank-statements/import-lines")
    public BankStatementImportLinesResponse listBankStatementImportLines(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @RequestParam(value = "status", required = false) String status
    ) {
        return commandService.listBankStatementImportLines(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            status
        );
    }

    @PostMapping("/weekly-expenses/{projectId}/bank-statements/apply-items")
    public ApplyBankStatementItemsResponse applyBankStatementItems(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody ApplyBankStatementItemsRequest request
    ) {
        return commandService.applyBankStatementItems(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            editSession(httpRequest),
            request
        );
    }

    @PostMapping("/weekly-expenses/{projectId}/sheets/{sheetKey}/commands/cell-patch")
    public CellCommandResponse patchCells(
        @PathVariable String projectId,
        @PathVariable String sheetKey,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody CellPatchCommandRequest request
    ) {
        return commandService.patchCells(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            sheetKey,
            editSession(httpRequest),
            request
        );
    }

    @PostMapping("/weekly-expenses/{projectId}/sheets/{sheetKey}/commands/paste")
    public CellCommandResponse pasteCells(
        @PathVariable String projectId,
        @PathVariable String sheetKey,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody PasteCellsRequest request
    ) {
        return commandService.pasteCells(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            sheetKey,
            editSession(httpRequest),
            request
        );
    }

    @PostMapping("/weekly-expenses/{projectId}/sheets/{sheetKey}/commands/copy")
    public CellCommandResponse copyCells(
        @PathVariable String projectId,
        @PathVariable String sheetKey,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody CopyCellsRequest request
    ) {
        return commandService.copyCells(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            sheetKey,
            editSession(httpRequest),
            request
        );
    }

    @PostMapping("/weekly-expenses/{projectId}/sheets/{sheetKey}/commands/cut")
    public CellCommandResponse cutCells(
        @PathVariable String projectId,
        @PathVariable String sheetKey,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody CutCellsRequest request
    ) {
        return commandService.cutCells(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            sheetKey,
            editSession(httpRequest),
            request
        );
    }

    @PostMapping("/weekly-expenses/{projectId}/sheets/{sheetKey}/commands/row-insert")
    public RowCommandResponse insertRows(
        @PathVariable String projectId,
        @PathVariable String sheetKey,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody RowInsertRequest request
    ) {
        return commandService.insertRows(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            sheetKey,
            editSession(httpRequest),
            request
        );
    }

    @PostMapping("/weekly-expenses/{projectId}/sheets/{sheetKey}/commands/row-delete")
    public RowCommandResponse deleteRows(
        @PathVariable String projectId,
        @PathVariable String sheetKey,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody RowDeleteRequest request
    ) {
        return commandService.deleteRows(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            sheetKey,
            editSession(httpRequest),
            request
        );
    }

    @GetMapping("/cashflow/{projectId}")
    public CashflowSnapshotResponse cashflowSnapshot(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail
    ) {
        commandService.requireProjectAllowed(WeeklyExpenseCommandService.CASHFLOW_READ_COMMAND, actorContext(tenantId, actorId, actorRole, actorEmail), projectId);
        Integer weeklyYear = readService.declaredWeeklyYear(tenantId, projectId);
        CashflowLedgerSource source = weeklyYear == null
            ? new CashflowLedgerSource(List.of(), List.of())
            : readCashflowSource(tenantId, projectId, weeklyYear);
        return buildCashflowSnapshot(projectId, source);
    }

    @PostMapping("/cashflow/projection-actual-summary/batch")
    public CashflowProjectionActualSummaryBatchResponse readCashflowProjectionActualSummaries(
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @Valid @RequestBody CashflowProjectionActualSummaryBatchRequest request
    ) {
        return commandService.readCashflowProjectionActualSummaries(
            actorContext(tenantId, actorId, actorRole, actorEmail), request
        );
    }

    @PostMapping("/cashflow/weekly-overview")
    public CashflowWeeklyOverviewResponse readCashflowWeeklyOverview(
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @Valid @RequestBody CashflowWeeklyOverviewRequest request
    ) {
        return commandService.readCashflowWeeklyOverview(
            actorContext(tenantId, actorId, actorRole, actorEmail), request
        );
    }

    private CashflowLedgerSource readCashflowSource(
        String tenantId,
        String projectId,
        int weeklyYear
    ) {
        return readService.ledgerSource(tenantId, projectId, weeklyYear);
    }

    private CashflowSnapshotResponse buildCashflowSnapshot(
        String projectId,
        CashflowLedgerSource source
    ) {
        List<CashflowSnapshotResponse.ProjectionLine> projection = source.projection().stream()
            .map(line -> new CashflowSnapshotResponse.ProjectionLine(
                line.getYearMonth(),
                line.getWeekNo(),
                line.getCashflowLine(),
                line.getAmount()
            ))
            .toList();
        List<CashflowSnapshotResponse.ActualLine> actual = source.actual().stream()
            .map(line -> new CashflowSnapshotResponse.ActualLine(
                line.getSheetKey(),
                line.getYearMonth(),
                line.getWeekNo(),
                line.getCashflowLine(),
                line.getAmount()
            ))
            .toList();
        return new CashflowSnapshotResponse(
            projectId,
            source.targetRevision(),
            projection,
            actual,
            buildCashflowReadModel(projection, actual)
        );
    }

    @PostMapping("/cashflow/{projectId}/projection")
    public UpsertProjectionResponse upsertProjection(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody UpsertProjectionRequest request
    ) {
        return commandService.upsertProjection(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            editSession(httpRequest),
            request
        );
    }

    @PostMapping("/cashflow/{projectId}/variance")
    public CashflowVarianceResponse updateCashflowVariance(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody CashflowVarianceRequest request
    ) {
        return commandService.updateCashflowVariance(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            editSession(httpRequest),
            request
        );
    }

    @GetMapping("/cashflow/{projectId}/month-close")
    public CashflowMonthCloseResponse readCashflowMonthClose(
        @PathVariable String projectId,
        @RequestParam("yearMonth") String yearMonth,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail
    ) {
        return commandService.readCashflowMonthClose(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            yearMonth
        );
    }

    @GetMapping("/cashflow/{projectId}/month-close/reopen-authority")
    public CashflowMonthReopenAuthorityResponse readCashflowMonthReopenAuthority(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail
    ) {
        TrustedActorContext actor = actorContext(tenantId, actorId, actorRole, actorEmail);
        return CashflowMonthReopenAuthorityResponse.from(
            commandService.readCashflowMonthReopenAuthority(
                new CashflowMonthReopenPort.Actor(actor.tenantId(), actor.id(), actor.name()),
                projectId
            )
        );
    }

    @GetMapping("/cashflow/{projectId}/settlement-statuses")
    public CashflowSettlementStatusesResponse readCashflowSettlementStatuses(
        @PathVariable String projectId,
        @RequestParam("yearMonth") String yearMonth,
        @RequestParam(value = "settlementCycle", defaultValue = "false") boolean settlementCycle,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail
    ) {
        return commandService.readCashflowSettlementStatuses(
            actorContext(tenantId, actorId, actorRole, actorEmail), projectId, yearMonth, settlementCycle
        );
    }

    @PostMapping("/cashflow/settlement-statuses/batch")
    public CashflowSettlementStatusesBatchResponse readCashflowSettlementStatusesBatch(
        @RequestParam(value = "settlementCycle", defaultValue = "false") boolean settlementCycle,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @Valid @RequestBody CashflowSettlementStatusesBatchRequest request
    ) {
        return commandService.readCashflowSettlementStatusesBatch(
            actorContext(tenantId, actorId, actorRole, actorEmail), request, settlementCycle
        );
    }

    @PostMapping("/cashflow/{projectId}/settlement-statuses/transition")
    public CashflowSettlementStatusesResponse transitionCashflowSettlementStatus(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @Valid @RequestBody TransitionCashflowSettlementStatusRequest request
    ) {
        return commandService.transitionCashflowSettlementStatus(
            actorContext(tenantId, actorId, actorRole, actorEmail), projectId, request
        );
    }

    @PostMapping("/cashflow/{projectId}/settlement-cycle/submit")
    public CashflowSettlementCycleCommandResponse submitCashflowSettlementCycle(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @Valid @RequestBody SubmitCashflowSettlementCycleRequest request
    ) {
        return commandService.submitCashflowSettlementCycle(
            actorContext(tenantId, actorId, actorRole, actorEmail), projectId, request
        );
    }

    @PostMapping("/cashflow/{projectId}/settlement-cycle/transition")
    public CashflowSettlementCycleCommandResponse transitionCashflowSettlementCycle(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @Valid @RequestBody TransitionCashflowSettlementCycleRequest request
    ) {
        return commandService.transitionCashflowSettlementCycle(
            actorContext(tenantId, actorId, actorRole, actorEmail), projectId, request
        );
    }

    @PostMapping("/cashflow/{projectId}/settlement-cycle/cancel-active")
    public CashflowSettlementCycleCommandResponse cancelCashflowSettlementCycle(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @Valid @RequestBody CancelCashflowSettlementCycleRequest request
    ) {
        return commandService.cancelCashflowSettlementCycle(
            actorContext(tenantId, actorId, actorRole, actorEmail), projectId, request
        );
    }

    @PostMapping("/cashflow/{projectId}/settlement-cycle/migrate-head-v2")
    public CashflowSettlementCycleHeadMigrationResponse migrateCashflowSettlementCycleHeadV2(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @Valid @RequestBody MigrateCashflowSettlementCycleHeadV2Request request
    ) {
        return commandService.migrateCashflowSettlementCycleHeadV2(
            actorContext(tenantId, actorId, actorRole, actorEmail), projectId, request
        );
    }

    @PostMapping("/cashflow/{projectId}/settlement-cycle/normalize-legacy-active-request")
    public CashflowSettlementCycleLegacyRequestNormalizationResponse normalizeLegacyCashflowSettlementCycleRequest(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @Valid @RequestBody NormalizeLegacyCashflowSettlementCycleRequest request
    ) {
        return commandService.normalizeLegacyCashflowSettlementCycleRequest(
            actorContext(tenantId, actorId, actorRole, actorEmail), projectId, request
        );
    }

    @GetMapping("/cashflow/{projectId}/month-close/dashboard-source")
    public CashflowMonthDashboardSourceResponse readCashflowMonthDashboardSource(
        @PathVariable String projectId,
        @RequestParam("yearMonth") String yearMonth,
        @RequestParam(value = "settlementCycle", defaultValue = "false") boolean settlementCycle,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest
    ) {
        TrustedActorContext actor = actorContext(tenantId, actorId, actorRole, actorEmail);
        commandService.requireProjectAllowed(
            WeeklyExpenseCommandService.CASHFLOW_MONTH_CLOSE_READ_COMMAND,
            actor,
            projectId
        );
        String requestId = httpRequest == null ? "" : httpRequest.getHeader("x-request-id");
        requestId = requestId == null ? "" : requestId.trim();
        CashflowMonthDashboardQueryService.Result result;
        try {
            result = settlementCycle
                ? dashboardQueryService.readSettlementCycle(tenantId, projectId, yearMonth, requestId)
                : dashboardQueryService.read(tenantId, projectId, yearMonth, requestId);
        } catch (CashflowMonthDashboardQueryService.UnstableRead error) {
            throw new WeeklyExpenseConflictException(
                "현금흐름 원장이 조회 중 변경되었습니다. 화면을 새로고침한 뒤 다시 시도해 주세요."
            );
        }
        String dashboardYearMonth = settlementCycle
            ? YearMonth.parse(yearMonth).minusMonths(1).toString()
            : yearMonth;
        return dashboardSourceResponse(
            result, yearMonth, dashboardYearMonth, actor, settlementCycle
        );
    }

    public CashflowMonthDashboardSourceResponse readCashflowMonthDashboardSource(
        String projectId,
        String yearMonth,
        String tenantId,
        String actorId,
        String actorRole,
        String actorEmail
    ) {
        return readCashflowMonthDashboardSource(
            projectId, yearMonth, false, tenantId, actorId, actorRole, actorEmail, null
        );
    }

    CashflowMonthDashboardSourceResponse readCashflowMonthDashboardSource(
        String projectId,
        String yearMonth,
        boolean settlementCycle,
        String tenantId,
        String actorId,
        String actorRole,
        String actorEmail
    ) {
        return readCashflowMonthDashboardSource(
            projectId, yearMonth, settlementCycle, tenantId, actorId, actorRole, actorEmail, null
        );
    }

    private CashflowMonthDashboardSourceResponse dashboardSourceResponse(
        CashflowMonthDashboardQueryService.Result result,
        String yearMonth,
        String dashboardYearMonth,
        TrustedActorContext actor,
        boolean settlementCycle
    ) {
        String operationalStatus = result.operationalStatus();
        CashflowMonthCloseResponse latestRun = CashflowMonthCloseResponse.fromState(
            WeeklyExpenseCommandService.CASHFLOW_MONTH_CLOSE_READ_COMMAND,
            result.latestRun(),
            "",
            result.latestRun().status()
        );
        CashflowMonthCloseResponse monthClose = CashflowMonthCloseResponse.fromState(
            WeeklyExpenseCommandService.CASHFLOW_MONTH_CLOSE_READ_COMMAND,
            result.latestRun(),
            "",
            operationalStatus == null ? "UNAVAILABLE" : operationalStatus
        );
        CashflowMonthDashboardQueryService.Authority authority = result.authority();
        CashflowMonthDashboardSourceResponse.CumulativeClose cumulativeClose = authority.isAvailable()
            ? new CashflowMonthDashboardSourceResponse.CumulativeClose(
                "AVAILABLE",
                authority.head().status(),
                authority.head().fromMonth(),
                authority.head().settlementMonth(),
                authority.head().closedThrough(),
                authority.head().rootHash(),
                authority.head().headRevision()
            )
            : CashflowMonthDashboardSourceResponse.CumulativeClose.unavailable(authority.availability());
        CashflowMonthDashboardSourceResponse.OperationalCycle cycle = operationalCycle(
            yearMonth, operationalStatus, latestRun
        );
        CashflowWeeklyOverviewResponse.Item settlementCycleItem = settlementCycle
            ? commandService.readCashflowSettlementCycleDashboardItem(
                actor, result.latestRun().projectId(), yearMonth
            )
            : null;
        CashflowSettlementStatusesResponse settlementStatuses = settlementCycle
            ? settlementCycleItem.settlementStatuses()
            : commandService.readCashflowSettlementStatuses(
                actor, result.latestRun().projectId(), cycle.targetYearMonth()
            );
        return new CashflowMonthDashboardSourceResponse(
            monthClose,
            latestRun,
            new CashflowMonthDashboardSourceResponse.MonthStatusEvidence(
                "CUMULATIVE_CLOSE_HEAD",
                authority.availability(),
                operationalStatus,
                latestRun.status(),
                authority.isAvailable() ? authority.head().closedThrough() : null,
                result.monthStatusIssueCode()
            ),
            result.source() == null ? null : buildCashflowSnapshot(result.latestRun().projectId(), result.source()),
            openingBalancesResponse(result.openingBalances(), dashboardYearMonth),
            new CashflowMonthDashboardSourceResponse.SnapshotCompatibility(
                result.snapshotCompatibility().status(),
                result.snapshotCompatibility().missingEvidence()
            ),
            cumulativeClose,
            projectionActualSummaryResponse(result.projectionActualSummary()),
            result.blockers().stream()
                .map(blocker -> new CashflowMonthDashboardSourceResponse.Blocker(
                    blocker.code(), blockerGuide(blocker.code())
                ))
                .toList(),
            result.sectionErrors().stream()
                .map(error -> new CashflowMonthDashboardSourceResponse.SectionError(
                    error.section(), error.code()
                ))
                .toList(),
            new CashflowMonthDashboardSourceResponse.ActionCapability(
                result.reopenRequest().enabled(),
                result.reopenRequest().reasonCode()
            ),
            cycle,
            settlementStatuses,
            monthCloseCalendar(dashboardYearMonth),
            settlementCycle ? settlementCycleItem.settlementCycle() : null
        );
    }

    private static CashflowMonthDashboardSourceResponse.OperationalCycle operationalCycle(
        String yearMonth,
        String operationalStatus,
        CashflowMonthCloseResponse latestRun
    ) {
        YearMonth cycleMonth = YearMonth.parse(yearMonth);
        YearMonth targetMonth = cycleMonth.minusMonths(1);
        LocalDate evaluatedBusinessDate = LocalDate.parse(latestRun.evaluatedBusinessDate());
        LocalDate closeDeadline = CashflowCloseDeadline.forCumulativeCycle(cycleMonth);
        boolean open = "OPEN".equals(operationalStatus);
        return new CashflowMonthDashboardSourceResponse.OperationalCycle(
            cycleMonth.toString(), targetMonth.toString(), closeDeadline.toString(),
            open && targetMonth.isBefore(YearMonth.from(evaluatedBusinessDate)),
            open ? evaluatedBusinessDate.isAfter(closeDeadline) : latestRun.late()
        );
    }

    private static List<CashflowMonthDashboardSourceResponse.MonthSettlementCalendarItem> monthCloseCalendar(
        String dashboardYearMonth
    ) {
        YearMonth selectedYear = YearMonth.parse(dashboardYearMonth).withMonth(1);
        return java.util.stream.IntStream.range(0, 12)
            .mapToObj(selectedYear::plusMonths)
            .map(targetMonth -> new CashflowMonthDashboardSourceResponse.MonthSettlementCalendarItem(
                targetMonth.toString(),
                CashflowCloseDeadline.forTargetMonth(targetMonth).toString(),
                CashflowCloseDeadline.settlementDeadlineAt(targetMonth).toString(),
                ApproverDeadlineCalculator.monthly(targetMonth.toString()).toString()
            ))
            .toList();
    }

    private String blockerGuide(String code) {
        return switch (code) {
            case "SHEET_SOURCE_REQUIRED" -> "먼저 시트값을 불러와 주세요.";
            case "CUMULATIVE_CLOSE_AUTHORITY_MISSING" ->
                "누적 월 결산 기준이 아직 없습니다. AXR 현금흐름 기간·마감 정책에서 상태를 확인해 주세요.";
            case "CUMULATIVE_CLOSE_AUTHORITY_INVALID" ->
                "누적 월 결산 기준이 손상되었습니다. AXR 관리자에게 복구를 요청해 주세요.";
            case "CUMULATIVE_CLOSE_AUTHORITY_UNAVAILABLE" ->
                "누적 월 결산 기준을 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.";
            case "CASHFLOW_SOURCE_UNAVAILABLE" ->
                "현금흐름 원장을 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.";
            case "OPENING_BALANCES_UNAVAILABLE" ->
                "이월 잔액을 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.";
            case "PROJECTION_ACTUAL_SUMMARY_UNAVAILABLE" ->
                "Projection–Actual 요약을 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.";
            default -> "현금흐름 자료 일부를 확인할 수 없습니다. 잠시 후 다시 불러와 주세요.";
        };
    }

    private CashflowOpeningBalancesResponse openingBalancesResponse(
        CashflowMonthDashboardQueryService.OpeningBalances openingBalances,
        String yearMonth
    ) {
        if (openingBalances == null) return null;
        if (openingBalances.live() != null) {
            return CloseCashflowMonthRequest.requireOpeningBalances(
                toOpeningBalancesResponse(openingBalances.live()),
                yearMonth
            );
        }
        try {
            return CloseCashflowMonthRequest.requireOpeningBalances(
                JSON.convertValue(openingBalances.frozen(), CashflowOpeningBalancesResponse.class),
                yearMonth
            );
        } catch (RuntimeException error) {
            throw new WeeklyExpenseConflictException(
                "마감된 현금흐름의 이월 잔액 근거를 확인할 수 없습니다. AXR 관리자에게 복구를 요청해 주세요."
            );
        }
    }

    private CashflowProjectionActualSummaryBatchResponse.Item projectionActualSummaryResponse(
        dev.merryai.innerplatform.weekly.domain.CashflowProjectionActualSummaryCalculator.Summary summary
    ) {
        if (summary == null) return null;
        return new CashflowProjectionActualSummaryBatchResponse.Item(
            summary.projectId(),
            summary.fromMonth(),
            new CashflowProjectionActualSummaryBatchResponse.ComparisonAsOfWeek(
                summary.comparisonAsOfWeek().yearMonth(),
                summary.comparisonAsOfWeek().weekNo()
            ),
            summary.projectionAmount(),
            summary.actualAmount(),
            summary.projectionActualDifferenceAmount(),
            summary.settlementDifferenceAmount(),
            summary.settlementMatches(),
            summary.periods().stream()
                .map(period -> new CashflowProjectionActualSummaryBatchResponse.PeriodSummary(
                    period.period(),
                    period.projectionAmount(),
                    period.actualAmount(),
                    period.projectionActualDifferenceAmount()
                ))
                .toList()
        );
    }

    @PostMapping("/cashflow/{projectId}/month-close")
    public CashflowMonthCloseResponse closeCashflowMonth(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody CloseCashflowMonthRequest request
    ) {
        return commandService.closeCashflowMonth(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            editSession(httpRequest),
            request
        );
    }

    @GetMapping("/cashflow/{projectId}/weekly-update-complete")
    public CashflowWeeklyUpdateCompletionResponse readCashflowWeeklyUpdate(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @RequestParam String yearMonth,
        @RequestParam int weekNo
    ) {
        requireCashflowWeeklyUpdateScope(yearMonth, weekNo);
        return commandService.readCashflowWeeklyUpdate(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            yearMonth,
            weekNo
        );
    }

    @PostMapping("/cashflow/{projectId}/weekly-update-complete")
    public CashflowWeeklyUpdateCompletionResponse completeCashflowWeeklyUpdate(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @Valid @RequestBody CompleteCashflowWeeklyUpdateRequest request
    ) {
        return commandService.completeCashflowWeeklyUpdate(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            request
        );
    }

    @GetMapping("/cashflow/{projectId}/weekly-update-compliance")
    public CashflowWeeklyComplianceHistoryResponse readCashflowWeeklyComplianceHistory(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @RequestParam(defaultValue = "50") int limit,
        @RequestParam(defaultValue = "") String cursor
    ) {
        return commandService.readCashflowWeeklyComplianceHistory(
            actorContext(tenantId, actorId, actorRole, actorEmail), projectId, limit, cursor
        );
    }

    @GetMapping("/cashflow/{projectId}/applied-cell-changes")
    public CashflowAppliedCellChangesResponse readCashflowAppliedCellChanges(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @RequestParam(defaultValue = "50") int limit,
        @RequestParam(defaultValue = "") String cursor
    ) {
        return commandService.readCashflowAppliedCellChanges(
            actorContext(tenantId, actorId, actorRole, actorEmail), projectId, limit, cursor
        );
    }

    @PostMapping("/cashflow/{projectId}/weekly-update-complete/confirm")
    public CashflowWeeklyUpdateCompletionResponse confirmCashflowWeeklyUpdate(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @Valid @RequestBody ConfirmCashflowWeeklyUpdateRequest request
    ) {
        return commandService.confirmCashflowWeeklyUpdate(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            request
        );
    }

    @PostMapping("/cashflow/{projectId}/weekly-update-complete/reopen")
    public CashflowWeeklyUpdateCompletionResponse reopenCashflowWeeklyUpdate(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @Valid @RequestBody ReopenCashflowWeeklyUpdateRequest request
    ) {
        return commandService.reopenCashflowWeeklyUpdate(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            request
        );
    }

    @PostMapping("/cashflow/{projectId}/month-close/reopen-request")
    public CashflowMonthCloseResponse requestCashflowMonthReopen(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody RequestCashflowMonthReopenRequest request
    ) {
        return commandService.requestCashflowMonthReopen(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            httpRequest.getHeader("x-data-project-id"),
            new CashflowMonthReopenCommands.RequestReopen(
                request.idempotencyKey(), request.yearMonth(), request.expectedRevision(), request.reason(),
                request.requestId(), request.cycleYearMonth(), request.monthCloseTargetYearMonth(),
                request.evidenceRevision(), request.manifestHash(), request.expectedWorkflowRevision()
            )
        );
    }

    @PostMapping("/cashflow/{projectId}/month-close/reopen-decision")
    public CashflowMonthCloseResponse decideCashflowMonthReopen(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody DecideCashflowMonthReopenRequest request
    ) {
        return commandService.decideCashflowMonthReopen(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            httpRequest.getHeader("x-data-project-id"),
            new CashflowMonthReopenCommands.DecideReopen(
                request.idempotencyKey(), request.yearMonth(), request.expectedRevision(),
                request.decision(), request.reason(), request.requestId(), request.cycleYearMonth(),
                request.monthCloseTargetYearMonth(), request.evidenceRevision(), request.manifestHash(),
                request.expectedWorkflowRevision()
            )
        );
    }

    @PostMapping("/cashflow/{projectId}/sheet-lab/apply")
    public CashflowSheetLabApplyResponse applyCashflowSheetLab(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody CashflowSheetLabApplyRequest request
    ) {
        return commandService.applyCashflowSheetLab(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            editSession(httpRequest),
            request
        );
    }

    @GetMapping("/cashflow/{projectId}/sheet-lab/operations")
    public CashflowSheetOperationStatusResponse readCashflowSheetOperationStatus(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @RequestParam String operationType,
        @RequestParam String idempotencyKey
    ) {
        return commandService.readCashflowSheetOperationStatus(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            operationType,
            idempotencyKey
        );
    }

    @PostMapping("/cashflow/{projectId}/sheet-lab/formulas/preflight")
    public CashflowSheetFormulaPreflightResponse validateCashflowSheetFormulas(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @Valid @RequestBody CashflowSheetFormulaPreflightRequest request
    ) {
        return commandService.validateCashflowSheetFormulas(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            request
        );
    }

    @PostMapping("/cashflow/{projectId}/sheet-lab/batch/apply")
    public CashflowSheetBatchApplyResponse applyCashflowSheetBatch(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody CashflowSheetBatchApplyRequest request
    ) {
        return commandService.applyCashflowSheetBatch(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            editSession(httpRequest),
            request
        );
    }

    @PostMapping("/cashflow/{projectId}/sheet-lab/annual/apply")
    public CashflowSheetAnnualApplyResponse applyCashflowSheetAnnualTotal(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody CashflowSheetAnnualApplyRequest request
    ) {
        // HTTP 표현은 여기까지다. 서비스에는 런타임 중립 커맨드와 도메인 셀만 넘긴다.
        return commandService.applyCashflowSheetAnnualTotal(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            editSession(httpRequest),
            new CashflowSheetAnnualApplyCommand(
                request.idempotencyKey(),
                request.sourceRevision(),
                request.year(),
                request.expectedRevision(),
                request.cells().stream()
                    .map(cell -> new CashflowAnnualCellSet.Cell(
                        cell.mode(), cell.cashflowLine(), cell.cellState(),
                        cell.amount(), cell.sourceCell(), cell.sourceLabel()
                    ))
                    .toList(),
                request.amendmentReason(),
                request.replaceAllActualSources()
            )
        );
    }

    @PostMapping("/weekly-expenses/{projectId}/submit")
    public SubmitWeekResponse submitWeek(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody SubmitWeekRequest request
    ) {
        if (!legacyWeekCloseEnabled) {
            throw new ResponseStatusException(HttpStatus.GONE, "Weekly submit is disabled; use cashflow month close.");
        }
        return commandService.submitWeek(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            editSession(httpRequest),
            request
        );
    }

    @PostMapping("/weekly-expenses/{projectId}/close")
    public CloseWeekResponse closeWeek(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        HttpServletRequest httpRequest,
        @Valid @RequestBody CloseWeekRequest request
    ) {
        if (!legacyWeekCloseEnabled) {
            throw new ResponseStatusException(HttpStatus.GONE, "Weekly close is disabled; use cashflow month close.");
        }
        return commandService.closeWeek(
            actorContext(tenantId, actorId, actorRole, actorEmail),
            projectId,
            editSession(httpRequest),
            request
        );
    }

    @GetMapping("/weekly-expenses/{projectId}/statuses")
    public WeeklyExpenseStatusesResponse weeklyStatuses(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail
    ) {
        commandService.requireProjectAllowed(WeeklyExpenseCommandService.WEEKLY_STATUS_READ_COMMAND, actorContext(tenantId, actorId, actorRole, actorEmail), projectId);
        return new WeeklyExpenseStatusesResponse(
            projectId,
            readService.weeklyStatuses(tenantId, projectId).stream()
                .map(status -> new WeeklyExpenseStatusesResponse.WeeklyStatusLine(
                    status.getProjectId() + "-" + status.getYearMonth() + "-w" + status.getWeekNo(),
                    status.getProjectId(),
                    status.getYearMonth(),
                    status.getWeekNo(),
                    status.getState(),
                    status.getSubmittedAt() != null,
                    status.getSubmittedBy(),
                    status.getSubmittedAt(),
                    "closed".equals(status.getState()),
                    status.getClosedBy(),
                    status.getClosedAt(),
                    status.getUpdatedAt()
                ))
                .toList()
        );
    }

    @PostMapping("/weekly-expenses/{projectId}/audit-export")
    public CreateAuditExportResponse createAuditExport(
        @PathVariable String projectId,
        @RequestHeader("x-tenant-id") String tenantId,
        @RequestHeader("x-actor-id") String actorId,
        @RequestHeader("x-actor-role") String actorRole,
        @RequestHeader(value = "x-actor-email", required = false) String actorEmail,
        @Valid @RequestBody CreateAuditExportRequest request
    ) {
        return commandService.createAuditExport(actorContext(tenantId, actorId, actorRole, actorEmail), projectId, request);
    }

    private CashflowSnapshotResponse.ReadModel buildCashflowReadModel(
        List<CashflowSnapshotResponse.ProjectionLine> projection,
        List<CashflowSnapshotResponse.ActualLine> actual
    ) {
        Map<String, CashflowSnapshotResponse.ModeReadModel> projectionByMonth = buildModeReadModel(
            projection.stream()
                .map(line -> new CashflowAmountLine(line.yearMonth(), line.weekNo(), line.cashflowLine(), line.amount()))
                .toList()
        );
        Map<String, CashflowSnapshotResponse.ModeReadModel> actualByMonth = buildModeReadModel(
            actual.stream()
                .map(line -> new CashflowAmountLine(line.yearMonth(), line.weekNo(), line.cashflowLine(), line.amount()))
                .toList()
        );
        LinkedHashSet<String> yearMonths = new LinkedHashSet<>();
        yearMonths.addAll(projectionByMonth.keySet());
        yearMonths.addAll(actualByMonth.keySet());
        return new CashflowSnapshotResponse.ReadModel(
            yearMonths.stream()
                .sorted()
                .map(yearMonth -> new CashflowSnapshotResponse.MonthReadModel(
                    yearMonth,
                    projectionByMonth.getOrDefault(yearMonth, emptyModeReadModel()),
                    actualByMonth.getOrDefault(yearMonth, emptyModeReadModel())
                ))
                .toList()
        );
    }

    private CashflowOpeningBalancesResponse toOpeningBalancesResponse(
        CashflowOpeningBalance opening
    ) {
        return new CashflowOpeningBalancesResponse(
            opening.selectedYear(),
            toOpeningBalanceMode(opening.projection()),
            toOpeningBalanceMode(opening.actual())
        );
    }

    private CashflowOpeningBalancesResponse.Mode toOpeningBalanceMode(
        CashflowOpeningBalance.Mode mode
    ) {
        return new CashflowOpeningBalancesResponse.Mode(
            mode.amount(),
            mode.lineAmounts(),
            mode.sources().stream()
                .map(source -> new CashflowOpeningBalancesResponse.YearSource(
                    source.year(),
                    source.lineAmounts(),
                    source.lineStates()
                ))
                .toList(),
            mode.includedYears(),
            mode.excludedWeeklyYears()
        );
    }

    private Map<String, CashflowSnapshotResponse.ModeReadModel> buildModeReadModel(List<CashflowAmountLine> lines) {
        Map<String, Map<Integer, Map<String, BigDecimal>>> amountsByMonth = new TreeMap<>();
        for (CashflowAmountLine line : lines) {
            String lineId = canonicalCashflowLine(line.cashflowLine());
            if (lineId.isBlank()) continue;
            amountsByMonth
                .computeIfAbsent(line.yearMonth(), ignored -> new TreeMap<>())
                .computeIfAbsent(line.weekNo(), ignored -> new LinkedHashMap<>())
                .merge(lineId, CashflowWeekTotals.safeAmount(line.amount()), BigDecimal::add);
        }

        Map<String, CashflowSnapshotResponse.ModeReadModel> readModels = new LinkedHashMap<>();
        BigDecimal runningIn = BigDecimal.ZERO;
        BigDecimal runningOut = BigDecimal.ZERO;
        for (Map.Entry<String, Map<Integer, Map<String, BigDecimal>>> monthEntry : amountsByMonth.entrySet()) {
            Map<String, BigDecimal> rowTotals = new LinkedHashMap<>();
            List<CashflowSnapshotResponse.WeekReadModel> weekModels = new ArrayList<>();
            BigDecimal monthIn = BigDecimal.ZERO;
            BigDecimal monthOut = BigDecimal.ZERO;
            for (Map.Entry<Integer, Map<String, BigDecimal>> weekEntry : monthEntry.getValue().entrySet()) {
                Map<String, BigDecimal> weekAmounts = sortedAmounts(weekEntry.getValue());
                for (Map.Entry<String, BigDecimal> amountEntry : weekAmounts.entrySet()) {
                    rowTotals.merge(amountEntry.getKey(), amountEntry.getValue(), BigDecimal::add);
                }
                BigDecimal weekIn = CashflowWeekTotals.sumLines(weekAmounts, CashflowLineCatalog.IN_LINES);
                BigDecimal weekOut = CashflowWeekTotals.sumLines(weekAmounts, CashflowLineCatalog.OUT_LINES);
                monthIn = monthIn.add(weekIn);
                monthOut = monthOut.add(weekOut);
                runningIn = runningIn.add(weekIn);
                runningOut = runningOut.add(weekOut);
                weekModels.add(new CashflowSnapshotResponse.WeekReadModel(
                    weekEntry.getKey(),
                    weekAmounts,
                    weekIn,
                    weekOut,
                    runningIn.subtract(runningOut),
                    weekIn,
                    weekOut
                ));
            }
            readModels.put(monthEntry.getKey(), new CashflowSnapshotResponse.ModeReadModel(
                sortedAmounts(rowTotals),
                weekModels,
                new CashflowSnapshotResponse.CashflowTotals(
                    monthIn,
                    monthOut,
                    runningIn.subtract(runningOut)
                )
            ));
        }
        return readModels;
    }

    private CashflowSnapshotResponse.ModeReadModel emptyModeReadModel() {
        return new CashflowSnapshotResponse.ModeReadModel(
            Map.of(),
            List.of(),
            new CashflowSnapshotResponse.CashflowTotals(BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO)
        );
    }

    private String canonicalCashflowLine(String raw) {
        return CashflowLineCatalog.canonicalize(raw);
    }

    private Map<String, BigDecimal> sortedAmounts(Map<String, BigDecimal> amounts) {
        return amounts.entrySet().stream()
            .sorted(Comparator.comparing(Map.Entry::getKey))
            .collect(
                LinkedHashMap::new,
                (target, entry) -> target.put(entry.getKey(), CashflowWeekTotals.safeAmount(entry.getValue())),
                LinkedHashMap::putAll
            );
    }


    private void requireCashflowWeeklyUpdateScope(String yearMonth, int weekNo) {
        if (
            yearMonth == null
            || !yearMonth.matches("20\\d{2}-(0[1-9]|1[0-2])")
            || weekNo < 1
            || weekNo > CashflowSheetLabApplyRequest.FINANCE_WEEK_COUNT
        ) {
            throw new IllegalArgumentException("yearMonth must be YYYY-MM and weekNo must be between 1 and 5.");
        }
    }

    private TrustedActorContext actorContext(String tenantId, String actorId, String actorRole, String actorEmail) {
        ServletRequestAttributes attrs = (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
        String actorName = attrs == null ? "" : attrs.getRequest().getHeader("x-actor-name");
        return new TrustedActorContext(tenantId, actorId, actorEmail, actorRole, actorName);
    }

    private CashflowEditSession editSession(
        String dataProjectId,
        String sessionId,
        String leaseId,
        String fenceValue,
        String finalizeValue
    ) {
        long fence = 0;
        if (fenceValue != null && !fenceValue.isBlank()) {
            String normalizedFence = fenceValue.trim();
            if (!normalizedFence.matches("^[1-9]\\d*$")) {
                throw new IllegalArgumentException("x-edit-fence must be a positive integer.");
            }
            try {
                fence = Long.parseLong(normalizedFence);
            } catch (NumberFormatException error) {
                throw new IllegalArgumentException("x-edit-fence must be a positive integer.");
            }
            if (fence > MAX_SAFE_INTEGER) {
                throw new IllegalArgumentException("x-edit-fence must be a positive integer.");
            }
        }
        String normalizedFinalize = finalizeValue == null ? "" : finalizeValue.trim();
        if (!normalizedFinalize.isEmpty() && !"true".equals(normalizedFinalize)) {
            throw new IllegalArgumentException("x-edit-finalize must be true when present.");
        }
        return new CashflowEditSession(dataProjectId, sessionId, leaseId, fence, "true".equals(normalizedFinalize));
    }

    private CashflowEditSession editSession(HttpServletRequest request) {
        return editSession(
            request.getHeader("x-data-project-id"),
            request.getHeader("x-edit-session-id"),
            request.getHeader("x-edit-lease-id"),
            request.getHeader("x-edit-fence"),
            request.getHeader("x-edit-finalize")
        );
    }

    private record CashflowAmountLine(
        String yearMonth,
        int weekNo,
        String cashflowLine,
        BigDecimal amount
    ) {
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(CashflowMonthReopenPolicy.Violation.class)
    public ResponseEntity<Map<String, String>> cashflowMonthReopenConflict(
        CashflowMonthReopenPolicy.Violation error
    ) {
        int status = error.reason() == CashflowMonthReopenPolicy.ViolationReason.DECISION_FORBIDDEN
            ? 403
            : 409;
        return ResponseEntity.status(status).body(Map.of(
            "ok", "false",
            "code", cashflowMonthReopenConflictCode(error.reason()),
            "message", cashflowMonthReopenConflictGuide(error.reason())
        ));
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(
        CashflowMonthReopenPort.DecisionAuthorityUnavailable.class
    )
    public ResponseEntity<Map<String, Object>> cashflowMonthReopenAuthorityUnavailable() {
        return ResponseEntity.status(503).body(Map.of(
            "ok", false,
            "code", "cashflow_month_reopen_authority_unavailable",
            "message", "재오픈 권한을 확인하지 못했어요. 잠시 후 다시 시도해 주세요."
        ));
    }

    private String cashflowMonthReopenConflictCode(CashflowMonthReopenPolicy.ViolationReason reason) {
        return switch (reason) {
            case DECISION_FORBIDDEN -> "cashflow_month_reopen_decision_forbidden";
            case LATEST_HORIZON_ONLY -> "cashflow_month_reopen_latest_horizon_only";
            case MONTH_NOT_CLOSED -> "cashflow_month_reopen_month_not_closed";
            case REVISION_CHANGED -> "cashflow_month_reopen_revision_changed";
            case LATEST_REQUEST_REQUIRED -> "cashflow_month_reopen_latest_request_required";
            case REQUEST_MISSING -> "cashflow_month_reopen_request_missing";
            case NOT_AWAITING_DECISION -> "cashflow_month_reopen_not_awaiting_decision";
            case COUNTER_OUT_OF_RANGE -> "cashflow_month_reopen_counter_invalid";
            case DECISION_INVALID -> "cashflow_month_reopen_decision_invalid";
            case PERIOD_INVALID -> "cashflow_month_reopen_period_invalid";
        };
    }

    private String cashflowMonthReopenConflictGuide(CashflowMonthReopenPolicy.ViolationReason reason) {
        return switch (reason) {
            case DECISION_FORBIDDEN ->
                "현재 프로젝트의 활성 조직장 또는 Runtime 관리자만 재오픈을 결정할 수 있어요. 담당 조직장을 확인해 주세요.";
            case LATEST_HORIZON_ONLY ->
                "가장 최근 누적 결산 월만 재오픈할 수 있어요. 최신 결산 상태를 다시 불러온 뒤 해당 월에서 요청해 주세요.";
            case MONTH_NOT_CLOSED ->
                "닫힌 월 결산만 재오픈할 수 있어요. 최신 결산 상태를 확인해 주세요.";
            case REVISION_CHANGED ->
                "검토하는 동안 월 결산 상태가 변경됐어요. 최신 상태를 다시 불러온 뒤 재시도해 주세요.";
            case LATEST_REQUEST_REQUIRED ->
                "가장 최근 누적 결산의 재오픈 요청만 결정할 수 있어요. 최신 요청을 다시 확인해 주세요.";
            case REQUEST_MISSING ->
                "재오픈 요청을 찾을 수 없어요. 최신 월 결산 상태를 다시 불러와 주세요.";
            case NOT_AWAITING_DECISION ->
                "이미 처리됐거나 결정 대기 중이 아닌 재오픈 요청이에요. 최신 상태를 다시 확인해 주세요.";
            case COUNTER_OUT_OF_RANGE ->
                "월 결산 이력 값에 복구가 필요해요. AXR 관리자에게 문의해 주세요.";
            case DECISION_INVALID ->
                "재오픈 결정값을 확인할 수 없어요. 승인 또는 반려를 다시 선택해 주세요.";
            case PERIOD_INVALID ->
                "재오픈 대상 월을 확인할 수 없어요. 월을 다시 선택해 주세요.";
        };
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(WeeklyExpenseConflictException.class)
    public ResponseEntity<Map<String, String>> conflict(WeeklyExpenseConflictException error) {
        return ResponseEntity.status(409).body(Map.of(
            "ok", "false",
            "code", "weekly_expense_conflict",
            "message", error.getMessage()
        ));
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(CashflowSettledWeekChangeConfirmationRequiredException.class)
    public ResponseEntity<Map<String, Object>> settledWeekChangeConfirmationRequired(
        CashflowSettledWeekChangeConfirmationRequiredException error
    ) {
        return ResponseEntity.status(409).body(Map.of(
            "ok", false,
            "code", "cashflow_settled_week_change_confirmation_required",
            "message", error.getMessage(),
            "details", Map.of(
                "confirmationId", error.confirmationId(),
                "targetRevision", error.targetRevision(),
                "weeks", error.weeks()
            )
        ));
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(CashflowSettledWeekChangeConfirmationExpiredException.class)
    public ResponseEntity<Map<String, Object>> settledWeekChangeConfirmationExpired(
        CashflowSettledWeekChangeConfirmationExpiredException error
    ) {
        return ResponseEntity.status(409).body(Map.of(
            "ok", false,
            "code", "cashflow_settled_week_change_confirmation_expired",
            "message", error.getMessage()
        ));
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(WeeklyExpenseAtomicWriteLimitException.class)
    public ResponseEntity<Map<String, Object>> atomicWriteLimit(WeeklyExpenseAtomicWriteLimitException error) {
        return ResponseEntity.status(error.statusCode()).body(Map.of(
            "ok", false,
            "code", error.code(),
            "message", error.getMessage(),
            "expectedWriteCount", error.expectedWriteCount()
        ));
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(WeeklyExpenseEditLeaseException.class)
    public ResponseEntity<Map<String, Object>> editLease(WeeklyExpenseEditLeaseException error) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("ok", false);
        response.put("code", error.code());
        response.put("message", error.getMessage());
        if (!error.details().isEmpty()) response.put("details", error.details());
        return ResponseEntity.status(error.statusCode()).body(response);
    }

    @org.springframework.web.bind.annotation.ExceptionHandler({
        DataIntegrityViolationException.class,
        ObjectOptimisticLockingFailureException.class
    })
    public ResponseEntity<Map<String, String>> persistenceConflict(Exception error) {
        return ResponseEntity.status(409).body(Map.of(
            "ok", "false",
            "code", "weekly_expense_persistence_conflict",
            "message", "The weekly expense sheet changed while this command was running. Reload and retry."
        ));
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, String>> badRequest(IllegalArgumentException error) {
        return ResponseEntity.status(400).body(Map.of(
            "ok", "false",
            "code", "weekly_expense_bad_request",
            "message", error.getMessage()
        ));
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, String>> invalidJson(HttpMessageNotReadableException error) {
        return ResponseEntity.status(400).body(Map.of(
            "ok", "false",
            "code", "weekly_expense_invalid_json",
            "message", "Request body contains invalid or unsupported fields."
        ));
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, String>> validationFailed(MethodArgumentNotValidException error) {
        String field = error.getBindingResult().getFieldErrors().stream()
            .findFirst()
            .map(fieldError -> fieldError.getField())
            .orElse("request");
        return ResponseEntity.status(400).body(Map.of(
            "ok", "false",
            "code", "weekly_expense_validation_failed",
            "message", "Invalid weekly expense request field: " + field
        ));
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(WeeklyExpenseForbiddenException.class)
    public ResponseEntity<Map<String, String>> forbidden(WeeklyExpenseForbiddenException error) {
        return ResponseEntity.status(403).body(Map.of(
            "ok", "false",
            "code", error.code(),
            "message", error.getMessage()
        ));
    }
}
