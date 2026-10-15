package dev.merryai.innerplatform.weekly.api;

import dev.merryai.innerplatform.weekly.domain.CashflowCumulativeCloseHead;
import dev.merryai.innerplatform.weekly.domain.CashflowLedgerSource;
import dev.merryai.innerplatform.weekly.domain.CashflowMonthCloseState;
import dev.merryai.innerplatform.weekly.domain.CashflowMonthReopenPolicy;
import dev.merryai.innerplatform.weekly.domain.CashflowOpeningBalance;
import dev.merryai.innerplatform.weekly.domain.CashflowSettlementCyclePolicy;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.merryai.innerplatform.weekly.domain.CashflowLineCatalog;
import dev.merryai.innerplatform.weekly.repository.WeeklyExpenseActualRepository;
import dev.merryai.innerplatform.weekly.repository.WeeklyExpenseAuditEventRepository;
import dev.merryai.innerplatform.weekly.repository.WeeklyExpenseAuditExportRepository;
import dev.merryai.innerplatform.weekly.repository.WeeklyExpenseBankImportLineRepository;
import dev.merryai.innerplatform.weekly.repository.WeeklyExpenseIdempotencyRepository;
import dev.merryai.innerplatform.weekly.repository.WeeklyExpenseProjectionRepository;
import dev.merryai.innerplatform.weekly.repository.WeeklyExpenseSheetRepository;
import dev.merryai.innerplatform.weekly.service.CashflowReadService;
import dev.merryai.innerplatform.weekly.service.WeeklyExpenseCommandService;
import dev.merryai.innerplatform.weekly.service.WeeklyExpenseAuthorizationService;
import dev.merryai.innerplatform.weekly.service.port.CashflowMonthReopenPort;
import dev.merryai.innerplatform.weekly.service.port.CashflowReadPort;
import dev.merryai.innerplatform.weekly.service.query.CashflowDashboardSectionQueryService;
import dev.merryai.innerplatform.weekly.service.query.CashflowMonthDashboardQueryService;
import dev.merryai.innerplatform.weekly.storage.JpaWeeklyExpensePersistence;
import dev.merryai.innerplatform.weekly.storage.WeeklyExpensePersistence;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.boot.test.mock.mockito.SpyBean;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import java.util.ArrayList;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.same;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class WeeklyExpenseControllerTest {
    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private WeeklyExpenseController controller;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private WeeklyExpenseSheetRepository sheetRepository;

    @Autowired
    private WeeklyExpenseActualRepository actualRepository;

    @Autowired
    private WeeklyExpenseProjectionRepository projectionRepository;

    @Autowired
    private WeeklyExpenseAuditEventRepository auditEventRepository;

    @Autowired
    private WeeklyExpenseIdempotencyRepository idempotencyRepository;

    @Autowired
    private WeeklyExpenseAuditExportRepository auditExportRepository;

    @Autowired
    private WeeklyExpenseBankImportLineRepository bankImportLineRepository;

    @SpyBean
    private JpaWeeklyExpensePersistence weeklyExpensePersistence;

    @MockBean
    private CanonicalMemberResolver canonicalMemberResolver;

    @BeforeEach
    void allowLegacyJpaFixtureWritesWithoutFirestoreLeaseBackend() {
        when(canonicalMemberResolver.resolve(any(), any())).thenAnswer(invocation -> Optional.of(
            new CanonicalMemberResolver.CanonicalMember(
                true,
                "ACTIVE",
                canonicalRoleForTestActor(invocation.getArgument(1))
            )
        ));
        doReturn(2026).when(weeklyExpensePersistence).findCashflowDeclaredWeeklyYear(any(), any());
        doAnswer(invocation -> ((TrustedActorContext) invocation.getArgument(0)).role())
            .when(weeklyExpensePersistence).requireCashflowWriteLease(any(), any(), any());
        doAnswer(invocation -> ((TrustedActorContext) invocation.getArgument(0)).role())
            .when(weeklyExpensePersistence).requireCashflowWritePermission(any(), any());
        doAnswer(invocation -> ((TrustedActorContext) invocation.getArgument(0)).role())
            .when(weeklyExpensePersistence).requireCashflowMonthClosePermission(any(), any());
        doAnswer(invocation -> {
            CashflowMonthReopenPort.Actor actor = invocation.getArgument(0);
            String projectId = invocation.getArgument(1);
            return new CashflowMonthReopenPolicy.DecisionAuthorityFacts(
                actor.tenantId(), actor.id(), projectId, true, actor.tenantId(), projectId,
                actor.id(), "ACTIVE", "organization_head", actor.id(), 1
            );
        }).when(weeklyExpensePersistence).findCashflowMonthReopenDecisionAuthorityFacts(any(), any());
        doNothing().when(weeklyExpensePersistence).bindCashflowMonthReopenDecisionAuthority(any());
        doNothing().when(weeklyExpensePersistence).requireCashflowMonthsOpen(any(), any(), any());
        doNothing().when(weeklyExpensePersistence).requireCashflowWeeksOpen(any(), any(), any());
    }

    @Test
    void healthPublishesTheSettlementCycleCapabilityForRollingDeploymentFences() throws Exception {
        mockMvc.perform(get("/api/v1/health"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.ok").value(true))
            .andExpect(jsonPath("$.capabilities[0]").value("settlement-cycle-v1"));
    }

    @Test
    void adminRecoveryCanCancelAnActiveSettlementCycle() throws Exception {
        doReturn(new WeeklyExpensePersistence.CashflowSettlementCycleCommandState(
            "project-a",
            "2026-08",
            "2026-07",
            "project-a-2026-08",
            "WITHDRAWN",
            2,
            1,
            "sha256:" + "a".repeat(64),
            "2026-08-20T02:51:00Z",
            "pm-1",
            "head-1",
            "2026-08-27T03:00:00Z",
            "admin-recovery",
            "퇴사자 요청 정리"
        )).when(weeklyExpensePersistence).cancelCashflowSettlementCycle(
            any(), eq("project-a"), any()
        );
        doAnswer(invocation -> invocation.getArgument(0))
            .when(weeklyExpensePersistence).saveAuditEvent(any());

        mockMvc.perform(asActor(
                post("/api/v1/cashflow/project-a/settlement-cycle/cancel-active")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("""
                        {
                          "idempotencyKey": "cancel-active-cycle-001",
                          "cycleYearMonth": "2026-08",
                          "monthCloseTargetYearMonth": "2026-07",
                          "requestId": "project-a-2026-08",
                          "expectedWorkflowRevision": 1,
                          "reason": "퇴사자 요청 정리"
                        }
                        """),
                "tenant-a",
                "admin-recovery",
                "admin"
            ))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.businessState").value("WITHDRAWN"))
            .andExpect(jsonPath("$.workflowRevision").value(2));
    }

    @Test
    void settlementCycleCancellationIsRestrictedToActiveAdmins() throws Exception {
        mockMvc.perform(asActor(
                post("/api/v1/cashflow/project-a/settlement-cycle/cancel-active")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("""
                        {
                          "idempotencyKey": "cancel-active-cycle-forbidden",
                          "cycleYearMonth": "2026-08",
                          "monthCloseTargetYearMonth": "2026-07",
                          "requestId": "project-a-2026-08",
                          "expectedWorkflowRevision": 1,
                          "reason": "권한 검증"
                        }
                        """),
                "tenant-a",
                "finance-1",
                "finance"
            ))
            .andExpect(status().isForbidden());
    }

    @Test
    void settlementCycleHeadMigrationRequiresANonBlankBoundedReason() throws Exception {
        for (String reason : List.of("", "x".repeat(1_001))) {
            mockMvc.perform(asActor(
                    post("/api/v1/cashflow/project-a/settlement-cycle/migrate-head-v2")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                            "idempotencyKey", "migration-reason-validation",
                            "expectedHeadRevision", 4,
                            "expectedHeadRootHash", "sha256:" + "a".repeat(64),
                            "reason", reason
                        ))),
                    "tenant-a",
                    "admin-1",
                    "admin"
                ))
                .andExpect(status().isBadRequest());
        }
    }

    @Test
    void legacySettlementCycleRequestNormalizationIsCutoffBound() throws Exception {
        mockMvc.perform(asActor(
                post("/api/v1/cashflow/project-a/settlement-cycle/normalize-legacy-active-request")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(objectMapper.writeValueAsString(Map.ofEntries(
                        Map.entry("idempotencyKey", "normalize-outside-cutoff"),
                        Map.entry("cycleYearMonth", "2027-01"),
                        Map.entry("expectedRequestRevision", 1),
                        Map.entry("expectedManifestHash", "sha256:" + "a".repeat(64)),
                        Map.entry("reason", "cutoff validation"),
                        Map.entry("dryRun", true),
                        Map.entry("expectedMigrationFingerprint", "")
                    ))),
                "tenant-a",
                "admin-1",
                "admin"
            ))
            .andExpect(status().isBadRequest());
    }

    private static MockHttpServletRequestBuilder asActor(
        MockHttpServletRequestBuilder request,
        String tenantId,
        String actorId,
        String role
    ) {
        return asFirebaseActor(request, tenantId, actorId, role, actorId + "@example.com");
    }

    private static MockHttpServletRequestBuilder asFirebaseActor(
        MockHttpServletRequestBuilder request,
        String tenantId,
        String actorId,
        String role,
        String email
    ) {
        return withEditLease(request)
            .header("authorization", "Bearer " + firebaseTestToken(tenantId, actorId, role, email))
            .header("x-tenant-id", tenantId);
    }

    private static MockHttpServletRequestBuilder withEditLease(MockHttpServletRequestBuilder request) {
        return request
            .header("x-data-project-id", "test-data-project")
            .header("x-edit-session-id", "test-session")
            .header("x-edit-lease-id", "test-lease")
            .header("x-edit-fence", "1");
    }

    private static String firebaseTestToken(String tenantId, String actorId, String role, String email) {
        String claims = "uid=%s;tenantId=%s;role=%s;email=%s".formatted(actorId, tenantId, role, email);
        return "test-firebase:" + Base64.getUrlEncoder().encodeToString(claims.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void javaApiRejectsActorHeadersWithoutBearerOrServiceToken() throws Exception {
        String body = """
            {
              "idempotencyKey": "missing-service-token",
              "sheetName": "기본 탭",
              "rows": []
            }
            """;

        mockMvc.perform(post("/api/v1/weekly-expenses/project-header-auth/sheets/default/save-draft")
                .header("origin", "https://myscube.myscguard.app")
                .header("x-tenant-id", "tenant-auth")
                .header("x-actor-id", "spoofed-admin")
                .header("x-actor-role", "admin")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("weekly_expense_firebase_auth_required"));
    }

    @Test
    void internalServiceTokenAuthorizesBffTrustedWeeklyUserRoutes() throws Exception {
        String body = """
            {
              "idempotencyKey": "service-token-user-route",
              "sheetName": "기본 탭",
              "rows": []
            }
            """;

        mockMvc.perform(withEditLease(post("/api/v1/weekly-expenses/project-auth/sheets/default/save-draft"))
                .header(InternalServiceTokenFilter.HEADER_NAME, "test-weekly-api-token")
                .header("x-tenant-id", "tenant-auth")
                .header("x-actor-id", "spoofed-admin")
                .header("x-actor-role", "admin")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.saveDraft"))
            .andExpect(jsonPath("$.projectId").value("project-auth"));
    }

    @Test
    void browserDirectFirebaseTokenCanRunJavaCommandWithoutBffServiceToken() throws Exception {
        String body = """
            {
              "idempotencyKey": "direct-firebase-save-001",
              "sheetName": "direct",
              "rows": [
                {
                  "rowIndex": 0,
                  "entryKind": "manual",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true},
                    {"columnIndex": 8, "rawValue": "사업비", "userEdited": true},
                    {"columnIndex": 13, "rawValue": "7000", "userEdited": true}
                  ]
                }
              ]
            }
            """;

        mockMvc.perform(asFirebaseActor(
                post("/api/v1/weekly-expenses/project-direct/sheets/default/save-draft"),
                "tenant-direct",
                "firebase-pm-1",
                "pm",
                "pm@mysc.co.kr"
            )
                .header("x-actor-id", "firebase-pm-1")
                .header("x-actor-role", "admin")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.saveDraft"))
            .andExpect(jsonPath("$.actualDelta[0].amount").value(7000));

        assertThat(auditEventRepository.findByTenantIdAndProjectIdOrderByCreatedAtAsc("tenant-direct", "project-direct"))
            .singleElement()
            .extracting("actorRole")
            .isEqualTo("pm");
    }

    @Test
    void firebaseStalePrivilegedClaimWithoutCanonicalMembershipIsDeniedBeforeCommandEffects() throws Exception {
        long sheetsBefore = sheetRepository.count();
        when(canonicalMemberResolver.resolve("tenant-membership-gate", "former-finance"))
            .thenReturn(Optional.empty());

        mockMvc.perform(asFirebaseActor(
                post("/api/v1/weekly-expenses/project-membership-gate/sheets/default/save-draft"),
                "tenant-membership-gate",
                "former-finance",
                "finance",
                "former-finance@mysc.co.kr"
            )
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"idempotencyKey\":\"stale-finance-denied\",\"rows\":[]}"))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("member_inactive"));

        assertThat(sheetRepository.count()).isEqualTo(sheetsBefore);
        assertThat(auditEventRepository.findByTenantIdAndProjectIdOrderByCreatedAtAsc(
            "tenant-membership-gate",
            "project-membership-gate"
        )).isEmpty();
    }

    @Test
    void authSessionEndpointIsNotPartOfBrowserDirectBearerFlow() throws Exception {
        String idToken = firebaseTestToken("tenant-session", "firebase-pm-session", "pm", "pm-session@mysc.co.kr");
        mockMvc.perform(post("/api/v1/auth/session")
                .header("authorization", "Bearer " + idToken)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"idToken\":\"" + idToken + "\"}"))
            .andExpect(status().isNotFound());
    }

    @Test
    void malformedAuthSessionRequestUsesBearerAuthGate() throws Exception {
        mockMvc.perform(post("/api/v1/auth/session")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"idToken\":\"test-firebase:not-base64\"}"))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("weekly_expense_firebase_auth_required"));
    }

    @Test
    void firebaseSessionCookieDoesNotAuthorizeJavaCommand() throws Exception {
        mockMvc.perform(post("/api/v1/weekly-expenses/project-session/sheets/default/save-draft")
                .header("cookie", "__Host-innerplatform_weekly_session=legacy-session")
                .header("x-tenant-id", "tenant-session")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"idempotencyKey\":\"legacy-cookie-denied\",\"rows\":[]}"))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("weekly_expense_firebase_auth_required"));
    }

    @Test
    void bearerTokenMustMatchActorHeadersForWeeklyCommands() throws Exception {
        String body = """
            {
              "idempotencyKey": "direct-firebase-spoof-001",
              "sheetName": "기본 탭",
              "rows": []
            }
            """;

        mockMvc.perform(withEditLease(post("/api/v1/weekly-expenses/project-missing-claims/sheets/default/save-draft"))
                .header("authorization", "Bearer " + firebaseTestToken("tenant-direct", "firebase-pm-1", "pm", "pm@mysc.co.kr"))
                .header("x-tenant-id", "tenant-other")
                .header("x-actor-id", "spoofed-admin")
                .header("x-actor-role", "admin")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("actor_mismatch"));
    }

    @Test
    void browserDirectFirebaseTokenCanUseRequestContextWhenClaimsAreMissing() throws Exception {
        String body = """
            {
              "idempotencyKey": "direct-firebase-missing-claims-001",
              "rows": [
                {
                  "rowIndex": 0,
                  "entryKind": "manual",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true},
                    {"columnIndex": 8, "rawValue": "사업비", "userEdited": true},
                    {"columnIndex": 13, "rawValue": "9000", "userEdited": true}
                  ]
                }
              ]
            }
            """;
        String missingClaimsToken = "test-firebase:" + Base64.getUrlEncoder()
            .encodeToString("uid=firebase-pm-claims;email=pm-claims@mysc.co.kr".getBytes(StandardCharsets.UTF_8));

        mockMvc.perform(withEditLease(post("/api/v1/weekly-expenses/project-missing-claims/sheets/default/save-draft"))
                .header("authorization", "Bearer " + missingClaimsToken)
                .header("x-tenant-id", "tenant-direct")
                .header("x-actor-id", "firebase-pm-claims")
                .header("x-actor-role", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.actualDelta[0].amount").value(9000));

        assertThat(auditEventRepository.findByTenantIdAndProjectIdOrderByCreatedAtAsc("tenant-direct", "project-missing-claims"))
            .extracting("actorId")
            .contains("firebase-pm-claims");
    }

    @Test
    void blankCanonicalRoleDoesNotUsePrivilegedTokenOrRequestHeader() throws Exception {
        String missingClaimsToken = "test-firebase:" + Base64.getUrlEncoder()
            .encodeToString("uid=firebase-admin-claims;email=admin-claims@mysc.co.kr".getBytes(StandardCharsets.UTF_8));
        when(canonicalMemberResolver.resolve("tenant-direct", "firebase-admin-claims"))
            .thenReturn(Optional.of(new CanonicalMemberResolver.CanonicalMember(true, "ACTIVE", "")));
        long sheetsBefore = sheetRepository.count();

        mockMvc.perform(post("/api/v1/weekly-expenses/project-missing-role/sheets/default/save-draft")
                .header("authorization", "Bearer " + missingClaimsToken)
                .header("x-tenant-id", "tenant-direct")
                .header("x-actor-id", "firebase-admin-claims")
                .header("x-actor-role", "admin")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""
                    {
                      "idempotencyKey": "missing-role-claim-privileged",
                      "rows": []
                    }
                    """))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("weekly_expense_forbidden"));

        assertThat(sheetRepository.count()).isEqualTo(sheetsBefore);
        assertThat(auditEventRepository.findByTenantIdAndProjectIdOrderByCreatedAtAsc(
            "tenant-direct",
            "project-missing-role"
        )).isEmpty();
    }

    @Test
    void browserDirectFirebaseTokenRequiresTenantButUsesCanonicalRoleWhenClaimsAreMissing() throws Exception {
        String missingClaimsToken = "test-firebase:" + Base64.getUrlEncoder()
            .encodeToString("uid=firebase-pm-missing-context;email=pm-missing@mysc.co.kr".getBytes(StandardCharsets.UTF_8));

        mockMvc.perform(post("/api/v1/weekly-expenses/project-direct-missing-role/sheets/default/save-draft")
                .header("authorization", "Bearer " + missingClaimsToken)
                .header("x-actor-id", "firebase-pm-missing-context")
                .header("x-actor-role", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"idempotencyKey\":\"missing-context-denied\",\"rows\":[]}"))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("tenant_required"));

        mockMvc.perform(withEditLease(post("/api/v1/weekly-expenses/project-direct-missing-role/sheets/default/save-draft"))
                .header("authorization", "Bearer " + missingClaimsToken)
                .header("x-tenant-id", "tenant-direct")
                .header("x-actor-id", "firebase-pm-missing-context")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"idempotencyKey\":\"missing-role-denied\",\"rows\":[]}"))
            .andExpect(status().isOk());
    }

    private static String canonicalRoleForTestActor(String actorId) {
        if (actorId == null) return "";
        if (actorId.startsWith("admin")) return "admin";
        if (actorId.startsWith("auditor")) return "auditor";
        if (actorId.startsWith("contractor")) return "contractor";
        if (actorId.startsWith("finance")) return "finance";
        if (actorId.startsWith("unknown")) return "unknown";
        if (actorId.startsWith("viewer")) return "viewer";
        if (actorId.startsWith("former-finance")) return "finance";
        if (actorId.startsWith("firebase-admin")) return "admin";
        return "pm";
    }

    @Test
    void cashflowReadRequiresJavaAuthorization() throws Exception {
        mockMvc.perform(asActor(get("/api/v1/cashflow/project-auth"), "tenant-auth", "unknown-1", "unknown"))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("weekly_expense_forbidden"));

        mockMvc.perform(asActor(get("/api/v1/cashflow/project-auth"), "tenant-auth", "auditor-1", "auditor"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.projectId").value("project-auth"));
    }

    @Test
    void cashflowSnapshotWithoutDeclaredWeeklyYearDoesNotReadGlobalLedger() {
        WeeklyExpenseCommandService snapshotCommandService = mock(WeeklyExpenseCommandService.class);
        WeeklyExpensePersistence snapshotPersistence = mock(WeeklyExpensePersistence.class);
        when(snapshotPersistence.findCashflowDeclaredWeeklyYear("tenant-no-year", "project-no-year"))
            .thenReturn(null);
        WeeklyExpenseController snapshotController = testController(
            snapshotCommandService, new CashflowReadService(snapshotPersistence), false
        );

        CashflowSnapshotResponse response = snapshotController.cashflowSnapshot(
            "project-no-year", "tenant-no-year", "viewer-no-year", "viewer", "viewer@example.com"
        );

        assertThat(response.projection()).isEmpty();
        assertThat(response.actual()).isEmpty();
        assertThat(response.readModel().months()).isEmpty();
        verify(snapshotPersistence).findCashflowDeclaredWeeklyYear("tenant-no-year", "project-no-year");
        verify(snapshotPersistence, never()).findCashflowLedgerSource(any(), any(), anyInt());
        verify(snapshotPersistence, never()).findCashflowGlobalLedgerSource(any(), any());
    }

    @Test
    void saveDraftPersistsRowsActualsAuditAndIdempotentResponse() throws Exception {
        String body = """
            {
              "idempotencyKey": "idem-001",
              "sheetName": "기본 탭",
              "rows": [
                {
                  "rowIndex": 0,
                  "entryKind": "manual",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true},
                    {"columnIndex": 8, "rawValue": "사업비", "userEdited": true},
                    {"columnIndex": 13, "rawValue": "1,200,000", "userEdited": true}
                  ]
                }
              ]
            }
            """;

        String firstResponse = mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-a/sheets/default/save-draft"), "tenant-a", "pm-1", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.ok").value(true))
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.saveDraft"))
            .andExpect(jsonPath("$.savedRowCount").value(1))
            .andExpect(jsonPath("$.savedCellCount").value(5))
            .andExpect(jsonPath("$.actualDelta[0].amount").value(1200000))
            .andReturn()
            .getResponse()
            .getContentAsString();

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-a/sheets/default/save-draft"), "tenant-a", "pm-1", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.auditId").value(objectMapper.readTree(firstResponse).get("auditId").asText()));

        assertThat(sheetRepository.findByTenantIdAndProjectIdAndSheetKey("tenant-a", "project-a", "default")).isPresent();
        assertThat(actualRepository.findByTenantIdAndProjectId("tenant-a", "project-a")).hasSize(1);
        assertThat(auditEventRepository.findByTenantIdAndProjectIdOrderByCreatedAtAsc("tenant-a", "project-a")).hasSize(1);
        assertThat(idempotencyRepository.findByTenantIdAndProjectIdAndCommandNameAndIdempotencyKey(
            "tenant-a",
            "project-a",
            "weeklyExpense.saveDraft",
            "idem-001"
        )).isPresent();

        mockMvc.perform(asActor(get("/api/v1/cashflow/project-a"), "tenant-a", "viewer-a", "viewer"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.targetRevision").isString())
            .andExpect(jsonPath("$.actual[0].sheetKey").value("default"))
            .andExpect(jsonPath("$.actual[0].amount").value(1200000))
            .andExpect(jsonPath("$.readModel.months[0].yearMonth").value("2026-06"))
            .andExpect(jsonPath("$.readModel.months[0].actual.rowTotals.DIRECT_COST_OUT").value(1200000))
            .andExpect(jsonPath("$.readModel.months[0].actual.weeks[0].totalOut").value(1200000))
            .andExpect(jsonPath("$.readModel.months[0].actual.weeks[0].net").value(-1200000))
            .andExpect(jsonPath("$.readModel.months[0].actual.monthTotals.totalOut").value(1200000));
    }

    @Test
    void readSheetsReturnsPersistedRowsCellsAndSheetVersionForServerHydration() throws Exception {
        String body = """
            {
              "idempotencyKey": "sheet-read-001",
              "sheetName": "기본 탭",
              "rows": [
                {
                  "rowIndex": 0,
                  "sourceTxId": "bank:sheet-read-001",
                  "entryKind": "bank_import",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true},
                    {"columnIndex": 8, "rawValue": "사업비", "userEdited": true},
                    {"columnIndex": 13, "rawValue": "45,000", "userEdited": true}
                  ]
                }
              ]
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-sheet-read/sheets/default/save-draft"), "tenant-sheet-read", "pm-sheet-read", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.sheetVersion").value(0));

        String listResponse = mockMvc.perform(asActor(get("/api/v1/weekly-expenses/project-sheet-read/sheets"), "tenant-sheet-read", "viewer-sheet-read", "viewer"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.ok").value(true))
            .andExpect(jsonPath("$.projectId").value("project-sheet-read"))
            .andExpect(jsonPath("$.sheets.length()").value(1))
            .andReturn()
            .getResponse()
            .getContentAsString();

        JsonNode sheet = objectMapper.readTree(listResponse).path("sheets").get(0);
        assertThat(sheet.path("sheetKey").asText()).isEqualTo("default");
        assertThat(sheet.path("sheetVersion").asLong()).isEqualTo(0);
        assertThat(sheet.path("rows").get(0).path("sourceTxId").asText()).isEqualTo("bank:sheet-read-001");
        assertThat(sheet.path("rows").get(0).path("entryKind").asText()).isEqualTo("bank_import");
        JsonNode cells = sheet.path("rows").get(0).path("cells");
        assertThat(cellValue(cells, 1)).isEqualTo("1");
        assertThat(cellValue(cells, 3)).isEqualTo("2026-06-W1");
        assertThat(cellValue(cells, 13)).isEqualTo("45000");

        mockMvc.perform(asActor(get("/api/v1/weekly-expenses/project-sheet-read/sheets/default"), "tenant-sheet-read", "viewer-sheet-read", "viewer"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.sheetKey").value("default"))
            .andExpect(jsonPath("$.sheetVersion").value(0))
            .andExpect(jsonPath("$.rows[0].cells[0].columnIndex").value(1));
    }

    @Test
    void projectionActualSummaryBatchReturnsPerProjectErrorsWithoutDeclaredWeeklyYears() throws Exception {
        doReturn(null).when(weeklyExpensePersistence)
            .findCashflowDeclaredWeeklyYear(eq("tenant-summary"), any());

        mockMvc.perform(asActor(post("/api/v1/cashflow/projection-actual-summary/batch"),
                "tenant-summary", "viewer-summary", "viewer")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"projectIds\":[\"project-b\",\"project-a\"]}"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.version").value("1"))
            .andExpect(jsonPath("$.items").isEmpty())
            .andExpect(jsonPath("$.errors[0].projectId").value("project-a"))
            .andExpect(jsonPath("$.errors[0].code").value("SUMMARY_UNAVAILABLE"))
            .andExpect(jsonPath("$.errors[1].projectId").value("project-b"))
            .andExpect(jsonPath("$.errors[1].code").value("SUMMARY_UNAVAILABLE"));

        mockMvc.perform(asActor(post("/api/v1/cashflow/projection-actual-summary/batch"),
                "tenant-summary", "viewer-summary", "viewer")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"projectIds\":[\"project-a\",\"project-a\"]}"))
            .andExpect(status().isBadRequest());
    }

    @Test
    void saveDraftDoesNotUseNewClientTempIdAsJpaRowPrimaryKey() throws Exception {
        String body = """
            {
              "idempotencyKey": "save-temp-id-001",
              "sheetName": "default",
              "rows": [
                {
                  "rowIndex": 0,
                  "tempId": "client-temp-row-001",
                  "entryKind": "manual",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true},
                    {"columnIndex": 8, "rawValue": "사업비", "userEdited": true},
                    {"columnIndex": 13, "rawValue": "1000", "userEdited": true}
                  ]
                }
              ]
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-temp-id/sheets/default/save-draft"), "tenant-temp-id", "pm-temp", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk());

        var sheet = sheetRepository.findWithRowsByTenantIdAndProjectIdAndSheetKey("tenant-temp-id", "project-temp-id", "default")
            .orElseThrow();
        assertThat(sheet.getRows()).singleElement()
            .extracting("id")
            .isNotEqualTo("client-temp-row-001");
    }

    @Test
    void saveDraftRejectsDuplicateRowIdentities() throws Exception {
        String body = """
            {
              "idempotencyKey": "save-duplicate-source-001",
              "sheetName": "default",
              "rows": [
                {
                  "rowIndex": 0,
                  "sourceTxId": "bank:dup-001",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true}
                  ]
                },
                {
                  "rowIndex": 1,
                  "sourceTxId": "bank:dup-001",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W2", "userEdited": true}
                  ]
                }
              ]
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-dup/sheets/default/save-draft"), "tenant-dup", "pm-dup", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.message").value("Duplicate source transaction in save draft request."));
    }

    @Test
    void sameIdempotencyKeyWithDifferentBodyReturnsConflict() throws Exception {
        String first = """
            {
              "idempotencyKey": "idem-conflict",
              "rows": []
            }
            """;
        String second = first.replace("\"rows\": []", "\"rows\": [{\"rowIndex\": 0, \"cells\": []}]");

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-b/sheets/default/save-draft"), "tenant-b", "pm-1", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(first))
            .andExpect(status().isOk());

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-b/sheets/default/save-draft"), "tenant-b", "pm-1", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(second))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("weekly_expense_conflict"));
    }

    @Test
    void sameIdempotencyKeyAcrossProjectsUsesSeparateIdempotencyScope() throws Exception {
        String body = """
            {
              "idempotencyKey": "idem-cross-project",
              "rows": []
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-idem-a/sheets/default/save-draft"), "tenant-idem", "pm-idem", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.projectId").value("project-idem-a"));

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-idem-b/sheets/default/save-draft"), "tenant-idem", "pm-idem", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.projectId").value("project-idem-b"));
    }

    @Test
    void sameIdempotencyKeyAcrossCommandsUsesSeparateIdempotencyScope() throws Exception {
        String saveBody = """
            {
              "idempotencyKey": "idem-cross-command",
              "rows": []
            }
            """;
        String submitBody = """
            {
              "idempotencyKey": "idem-cross-command",
              "yearMonth": "2026-06",
              "weekNo": 1
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-idem-command/sheets/default/save-draft"), "tenant-idem-command", "pm-idem", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(saveBody))
            .andExpect(status().isOk());

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-idem-command/submit"), "tenant-idem-command", "pm-idem", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(submitBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.submitWeek"));
    }

    @Test
    void auditExportIdempotencyUsesSeparateProjectScope() throws Exception {
        String exportBody = """
            {
              "idempotencyKey": "audit-export-cross-project",
              "format": "CSV",
              "includeAuditSummary": true
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-export-a/audit-export"), "tenant-export-replay", "finance-export", "finance")
                .contentType(MediaType.APPLICATION_JSON)
                .content(exportBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.projectId").value("project-export-a"));

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-export-b/audit-export"), "tenant-export-replay", "finance-export", "finance")
                .contentType(MediaType.APPLICATION_JSON)
                .content(exportBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.projectId").value("project-export-b"));
    }

    @Test
    void saveDraftDoesNotPersistActualsForRowsRequiringReview() throws Exception {
        String body = """
            {
              "idempotencyKey": "review-required-actual-001",
              "sheetName": "기본 탭",
              "rows": [
                {
                  "rowIndex": 0,
                  "entryKind": "manual",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true},
                    {"columnIndex": 8, "rawValue": "", "userEdited": true},
                    {"columnIndex": 13, "rawValue": "1,200,000", "userEdited": true}
                  ]
                }
              ]
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-review/sheets/default/save-draft"), "tenant-review", "pm-1", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.cellIssues[0].code").value("review_required"))
            .andExpect(jsonPath("$.actualDelta").isEmpty());

        assertThat(actualRepository.findByTenantIdAndProjectId("tenant-review", "project-review")).isEmpty();
    }

    @Test
    void saveDraftActualFormulaUsesManualDepositAmountWithoutBankAmountFallback() throws Exception {
        String body = """
            {
              "idempotencyKey": "manual-deposit-actual-001",
              "sheetName": "기본 탭",
              "rows": [
                {
                  "rowIndex": 0,
                  "entryKind": "manual",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W2", "userEdited": true},
                    {"columnIndex": 8, "rawValue": "매출액", "userEdited": true},
                    {"columnIndex": 11, "rawValue": "500,000", "userEdited": true}
                  ]
                }
              ]
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-manual-deposit/sheets/default/save-draft"), "tenant-manual-deposit", "pm-1", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.actualDelta[0].yearMonth").value("2026-06"))
            .andExpect(jsonPath("$.actualDelta[0].weekNo").value(2))
            .andExpect(jsonPath("$.actualDelta[0].cashflowLine").value("SALES_IN"))
            .andExpect(jsonPath("$.actualDelta[0].amount").value(500000));

        mockMvc.perform(asActor(get("/api/v1/cashflow/project-manual-deposit"), "tenant-manual-deposit", "viewer-manual-deposit", "viewer"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.readModel.months[0].actual.rowTotals.SALES_IN").value(500000))
            .andExpect(jsonPath("$.readModel.months[0].actual.weeks[0].totalIn").value(500000))
            .andExpect(jsonPath("$.readModel.months[0].actual.weeks[0].net").value(500000));
    }

    @Test
    void upsertProjectionPersistsBackendProjectionLines() throws Exception {
        String body = """
            {
              "idempotencyKey": "projection-001",
              "lines": [
                {"yearMonth": "2026-06", "weekNo": 1, "cashflowLine": "사업비", "amount": 3000000}
              ]
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/cashflow/project-projection/projection"), "tenant-projection", "finance-1", "finance")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.projection.upsert"))
            .andExpect(jsonPath("$.savedLineCount").value(1))
            .andExpect(jsonPath("$.projection[0].amount").value(3000000));

        mockMvc.perform(asActor(get("/api/v1/cashflow/project-projection"), "tenant-projection", "viewer-projection", "viewer"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.projection[0].cashflowLine").value("DIRECT_COST_OUT"))
            .andExpect(jsonPath("$.projection[0].amount").value(3000000))
            .andExpect(jsonPath("$.readModel.months[0].projection.rowTotals.DIRECT_COST_OUT").value(3000000))
            .andExpect(jsonPath("$.readModel.months[0].projection.weeks[0].weekOut").value(3000000))
            .andExpect(jsonPath("$.readModel.months[0].projection.monthTotals.net").value(-3000000));
    }

    @Test
    void emptyProjectionIsRejectedEvenWhenLegacyFinalizationHeaderIsPresent() throws Exception {
        String body = """
            {
              "idempotencyKey": "projection-final-no-change-controller",
              "lines": []
            }
            """;

        mockMvc.perform(asActor(
                post("/api/v1/cashflow/project-final-no-change/projection"),
                "tenant-final-no-change",
                "pm-final-no-change",
                "pm"
            )
                .header("x-edit-finalize", "true")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_bad_request"));

        assertThat(projectionRepository.findByTenantIdAndProjectId(
            "tenant-final-no-change",
            "project-final-no-change"
        )).isEmpty();
        assertThat(auditEventRepository.findByTenantIdAndProjectIdOrderByCreatedAtAsc(
            "tenant-final-no-change",
            "project-final-no-change"
        )).isEmpty();
        assertThat(idempotencyRepository.findByTenantIdAndProjectIdAndCommandNameAndIdempotencyKey(
            "tenant-final-no-change",
            "project-final-no-change",
            "weeklyExpense.projection.upsert",
            "projection-final-no-change-controller"
        )).isEmpty();
    }

    @Test
    void emptyProjectionWithoutFinalizationIsRejected() throws Exception {
        String body = """
            {
              "idempotencyKey": "projection-empty-non-final-controller",
              "lines": []
            }
            """;

        mockMvc.perform(asActor(
                post("/api/v1/cashflow/project-empty-non-final/projection"),
                "tenant-empty-non-final",
                "pm-empty-non-final",
                "pm"
            )
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isBadRequest());

        assertThat(projectionRepository.findByTenantIdAndProjectId(
            "tenant-empty-non-final",
            "project-empty-non-final"
        )).isEmpty();
        assertThat(auditEventRepository.findByTenantIdAndProjectIdOrderByCreatedAtAsc(
            "tenant-empty-non-final",
            "project-empty-non-final"
        )).isEmpty();
    }

    @Test
    void projectionAtomicLimitReturnsStable422BeforePersistence() throws Exception {
        List<Map<String, Object>> lines = new ArrayList<>();
        for (int index = 0; index < 499; index += 1) {
            lines.add(Map.of(
                "yearMonth", "2026-06",
                "weekNo", 1,
                "cashflowLine", "SALES_IN",
                "amount", index + 1
            ));
        }
        String body = objectMapper.writeValueAsString(Map.of(
            "idempotencyKey", "projection-atomic-limit",
            "lines", lines
        ));

        mockMvc.perform(asActor(
                post("/api/v1/cashflow/project-projection-limit/projection"),
                "tenant-projection-limit",
                "pm-limit",
                "pm"
            )
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isUnprocessableEntity())
            .andExpect(jsonPath("$.code").value("atomic_write_limit_exceeded"))
            .andExpect(jsonPath("$.expectedWriteCount").value(501));

        assertThat(projectionRepository.findByTenantIdAndProjectId(
            "tenant-projection-limit",
            "project-projection-limit"
        )).isEmpty();
    }

    @Test
    void cashflowSheetLabApplyFailsClosedWithoutFirestoreAtomicPlanner() throws Exception {
        List<Map<String, Object>> cells = new ArrayList<>();
        for (int weekNo = 1; weekNo <= 5; weekNo += 1) {
            for (String mode : List.of("projection", "actual")) {
                for (String lineId : CashflowLineCatalog.ALL_LINES) {
                    cells.add(Map.of(
                        "mode", mode,
                        "weekNo", weekNo,
                        "cashflowLine", lineId,
                        "cellState", "VALUE",
                        "amount", 1000
                    ));
                }
            }
        }
        List<Map<String, Object>> calculationChecks = new ArrayList<>();
        for (int weekNo = 1; weekNo <= 5; weekNo += 1) {
            for (String mode : List.of("projection", "actual")) {
                calculationChecks.add(Map.of(
                    "yearMonth", "2026-06",
                    "mode", mode,
                    "weekNo", weekNo,
                    "reported", Map.of(
                        "openingBalance", 0,
                        "depositTotal", 0,
                        "withdrawalTotal", 0,
                        "balance", 0
                    )
                ));
            }
        }
        Map<String, Object> pendingChange = new LinkedHashMap<>();
        pendingChange.put("mode", "projection");
        pendingChange.put("weekNo", 1);
        pendingChange.put("lineId", "SALES_IN");
        pendingChange.put("beforeHadValue", false);
        pendingChange.put("beforeState", "EMPTY");
        pendingChange.put("beforeAmount", null);
        pendingChange.put("afterHadValue", true);
        pendingChange.put("afterState", "VALUE");
        pendingChange.put("afterAmount", 1000);
        Map<String, Object> pendingDifference = Map.ofEntries(
            Map.entry("requestId", "request-a"), Map.entry("requestRevision", 1),
            Map.entry("requestStatus", "PENDING"),
            Map.entry("requestManifestHash", "sha256:" + "c".repeat(64)),
            Map.entry("yearMonth", "2026-06"), Map.entry("differenceCount", 1),
            Map.entry("weeks", List.of(1)), Map.entry("changes", List.of(pendingChange)),
            Map.entry("truncatedChangeCount", 0)
        );
        String body = objectMapper.writeValueAsString(Map.ofEntries(
            Map.entry("idempotencyKey", "sheet-lab-apply-001"),
            Map.entry("sourceRevision", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            Map.entry("targetRevision", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
            Map.entry("yearMonth", "2026-06"),
            Map.entry("calculationChecks", calculationChecks),
            Map.entry("cells", cells),
            Map.entry("pendingApprovalAffectedMonths", List.of(Map.of(
                "yearMonth", "2026-06", "warningCountIncrement", 1, "differenceCount", 1,
                "approvalDifferences", List.of(pendingDifference)
            )))
        ));

        mockMvc.perform(asActor(post("/api/v1/cashflow/project-sheet-lab/sheet-lab/apply"), "tenant-sheet-lab", "pm-sheet-lab", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("cashflow_month_amendment_backend_unavailable"));

        String batchBody = objectMapper.writeValueAsString(Map.ofEntries(
            Map.entry("idempotencyKey", "sheet-lab-batch-001"),
            Map.entry("sourceRevision", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            Map.entry("targetRevision", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
            Map.entry("months", List.of(Map.of(
                "yearMonth", "2026-06", "calculationChecks", calculationChecks, "cells", cells
            ))),
            Map.entry("pendingApprovalAffectedMonths", List.of(Map.of(
                "yearMonth", "2026-06", "warningCountIncrement", 1, "differenceCount", 1,
                "approvalDifferences", List.of(pendingDifference)
            )))
        ));
        mockMvc.perform(asActor(post("/api/v1/cashflow/project-sheet-lab/sheet-lab/batch/apply"), "tenant-sheet-lab", "pm-sheet-lab", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(batchBody))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("cashflow_month_amendment_backend_unavailable"));

        verify(weeklyExpensePersistence, times(2)).runCommandTransaction(any());
        assertThat(projectionRepository.findByTenantIdAndProjectId("tenant-sheet-lab", "project-sheet-lab")).isEmpty();
        assertThat(actualRepository.findByTenantIdAndProjectId("tenant-sheet-lab", "project-sheet-lab")).isEmpty();
    }

    @Test
    void cashflowSnapshotReadModelCanonicalizesAliasesAndMatchesRawProjectionActualTotals() throws Exception {
        String projection = """
            {
              "idempotencyKey": "read-model-projection-alias-001",
              "lines": [
                {"yearMonth": "2026-06", "weekNo": 1, "cashflowLine": "사업비", "amount": 3000000},
                {"yearMonth": "2026-06", "weekNo": 1, "cashflowLine": "DIRECT_COST_OUT", "amount": 700000},
                {"yearMonth": "2026-06", "weekNo": 1, "cashflowLine": "매출액(입금)", "amount": 5000000},
                {"yearMonth": "2026-07", "weekNo": 1, "cashflowLine": "팀지원금(출금)", "amount": 400000}
              ]
            }
            """;
        mockMvc.perform(asActor(post("/api/v1/cashflow/project-read-model/projection"), "tenant-read-model", "finance-read", "finance")
                .contentType(MediaType.APPLICATION_JSON)
                .content(projection))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.savedLineCount").value(3));

        String actual = """
            {
              "idempotencyKey": "read-model-actual-alias-001",
              "sheetName": "기본 탭",
              "rows": [
                {
                  "rowIndex": 0,
                  "entryKind": "manual",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true},
                    {"columnIndex": 8, "rawValue": "직접사업비(공급가액)+매입부가세", "userEdited": true},
                    {"columnIndex": 13, "rawValue": "1200000", "userEdited": true}
                  ]
                },
                {
                  "rowIndex": 1,
                  "entryKind": "manual",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true},
                    {"columnIndex": 8, "rawValue": "SALES_IN", "userEdited": true},
                    {"columnIndex": 10, "rawValue": "2500000", "userEdited": true}
                  ]
                },
                {
                  "rowIndex": 2,
                  "entryKind": "manual",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-07-W1", "userEdited": true},
                    {"columnIndex": 8, "rawValue": "은행이자(입금)", "userEdited": true},
                    {"columnIndex": 10, "rawValue": "9000", "userEdited": true}
                  ]
                }
              ]
            }
            """;
        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-read-model/sheets/default/save-draft"), "tenant-read-model", "pm-read", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(actual))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.actualDelta.length()").value(3));

        assertThat(projectionRepository.findByTenantIdAndProjectId("tenant-read-model", "project-read-model"))
            .hasSize(3);
        assertThat(actualRepository.findByTenantIdAndProjectId("tenant-read-model", "project-read-model"))
            .hasSize(3);

        mockMvc.perform(asActor(get("/api/v1/cashflow/project-read-model"), "tenant-read-model", "viewer-read", "viewer"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.projection.length()").value(3))
            .andExpect(jsonPath("$.actual.length()").value(3))
            .andExpect(jsonPath("$.readModel.months[0].yearMonth").value("2026-06"))
            .andExpect(jsonPath("$.readModel.months[0].projection.rowTotals.DIRECT_COST_OUT").value(3700000))
            .andExpect(jsonPath("$.readModel.months[0].projection.rowTotals.SALES_IN").value(5000000))
            .andExpect(jsonPath("$.readModel.months[0].projection.weeks[0].amounts.DIRECT_COST_OUT").value(3700000))
            .andExpect(jsonPath("$.readModel.months[0].projection.weeks[0].weekIn").value(5000000))
            .andExpect(jsonPath("$.readModel.months[0].projection.weeks[0].weekOut").value(3700000))
            .andExpect(jsonPath("$.readModel.months[0].projection.weeks[0].net").value(1300000))
            .andExpect(jsonPath("$.readModel.months[0].projection.monthTotals.totalIn").value(5000000))
            .andExpect(jsonPath("$.readModel.months[0].projection.monthTotals.totalOut").value(3700000))
            .andExpect(jsonPath("$.readModel.months[0].projection.monthTotals.net").value(1300000))
            .andExpect(jsonPath("$.readModel.months[0].actual.rowTotals.DIRECT_COST_OUT").value(1200000))
            .andExpect(jsonPath("$.readModel.months[0].actual.rowTotals.SALES_IN").value(2500000))
            .andExpect(jsonPath("$.readModel.months[0].actual.monthTotals.totalIn").value(2500000))
            .andExpect(jsonPath("$.readModel.months[0].actual.monthTotals.totalOut").value(1200000))
            .andExpect(jsonPath("$.readModel.months[0].actual.monthTotals.net").value(1300000))
            .andExpect(jsonPath("$.readModel.months[1].yearMonth").value("2026-07"))
            .andExpect(jsonPath("$.readModel.months[1].projection.monthTotals.totalOut").value(400000))
            .andExpect(jsonPath("$.readModel.months[1].projection.monthTotals.net").value(900000))
            .andExpect(jsonPath("$.readModel.months[1].actual.monthTotals.totalIn").value(9000))
            .andExpect(jsonPath("$.readModel.months[1].actual.monthTotals.net").value(1309000));
    }

    @Test
    void bankStatementUploadStagesLinesAndSelectedApplyCreatesWeeklyRowsActualAndAudit() throws Exception {
        String importBody = """
            {
              "idempotencyKey": "bank-import-001",
              "uploadName": "june-bank.xlsx",
              "columns": ["거래일시", "지급처", "적요", "금액", "잔액"],
              "lines": [
                {
                  "lineIndex": 0,
                  "sourceLineKey": "bank-line-20260601-001",
                  "transactionDate": "2026-06-01",
                  "counterparty": "테스트 지급처",
                  "memo": "시제품 제작비",
                  "signedAmount": -120000,
                  "balanceAfter": 880000,
                  "rawCells": ["2026-06-01", "테스트 지급처", "시제품 제작비", "-120000", "880000"]
                }
              ]
            }
            """;

        String importResponse = mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-bank/bank-statements/import-batch"), "tenant-bank", "pm-bank", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(importBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.bankStatement.importBatch"))
            .andExpect(jsonPath("$.stagedLineCount").value(1))
            .andExpect(jsonPath("$.duplicateLineCount").value(0))
            .andReturn()
            .getResponse()
            .getContentAsString();

        assertThat(actualRepository.findByTenantIdAndProjectId("tenant-bank", "project-bank")).isEmpty();

        JsonNode importedLine = objectMapper.readTree(importResponse).get("lines").get(0);
        String lineId = importedLine.get("id").asText();
        String sourceLineKey = importedLine.get("sourceLineKey").asText();
        String applyBody = """
            {
              "idempotencyKey": "bank-apply-001",
              "sheetKey": "default",
              "sheetName": "기본 탭",
              "items": [
                {
                  "importLineId": "%s",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true},
                    {"columnIndex": 5, "rawValue": "운영비", "userEdited": true},
                    {"columnIndex": 6, "rawValue": "제작비", "userEdited": true},
                    {"columnIndex": 8, "rawValue": "사업비", "userEdited": true}
                  ]
                }
              ]
            }
            """.formatted(lineId);

        String applyResponse = mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-bank/bank-statements/apply-items"), "tenant-bank", "pm-bank", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(applyBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.bankStatement.applyItems"))
            .andExpect(jsonPath("$.appliedLineCount").value(1))
            .andExpect(jsonPath("$.actualDelta[0].amount").value(120000))
            .andReturn()
            .getResponse()
            .getContentAsString();

        String sheetResponse = mockMvc.perform(asActor(get("/api/v1/weekly-expenses/project-bank/sheets/default"), "tenant-bank", "pm-bank", "pm"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.rows[0].sourceTxId").value("bank:" + sourceLineKey))
            .andReturn()
            .getResponse()
            .getContentAsString();
        JsonNode rowCells = objectMapper.readTree(sheetResponse).get("rows").get(0).get("cells");
        assertThat(cellValue(rowCells, 1)).isEqualTo("1");
        assertThat(cellValue(rowCells, 3)).isEqualTo("26-5-5");
        assertThat(actualRepository.findByTenantIdAndProjectId("tenant-bank", "project-bank")).hasSize(1);

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-bank/bank-statements/apply-items"), "tenant-bank", "pm-bank", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(applyBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.auditId").value(objectMapper.readTree(applyResponse).get("auditId").asText()));
    }

    @Test
    void bankStatementImportStoresRaggedRawCellsAndListDefaultsToStagedCandidates() throws Exception {
        String importBody = """
            {
              "idempotencyKey": "bank-import-ragged-columns-001",
              "uploadName": "ragged-columns-bank.xlsx",
              "columns": ["거래일자", "적요", "출금금액", "잔액"],
              "lines": [
                {
                  "lineIndex": 0,
                  "sourceLineKey": "ragged-bank-line-short",
                  "transactionDate": "2026-06-05",
                  "counterparty": "짧은 행 지급처",
                  "memo": "rawCells가 columns보다 짧음",
                  "signedAmount": -10000,
                  "balanceAfter": 90000,
                  "rawCells": ["2026-06-05", "짧은 행 지급처", "10000"]
                },
                {
                  "lineIndex": 1,
                  "sourceLineKey": "ragged-bank-line-long",
                  "transactionDate": "2026-06-06",
                  "counterparty": "긴 행 지급처",
                  "memo": "rawCells가 columns보다 김",
                  "signedAmount": -20000,
                  "balanceAfter": 70000,
                  "rawCells": ["2026-06-06", "긴 행", "20,000", "70,000", "추가 은행 컬럼"]
                }
              ]
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-bank-ragged/bank-statements/import-batch"), "tenant-bank-ragged", "pm-bank", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(importBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.stagedLineCount").value(2))
            .andExpect(jsonPath("$.duplicateLineCount").value(0));

        mockMvc.perform(asActor(get("/api/v1/weekly-expenses/project-bank-ragged/bank-statements/import-lines"), "tenant-bank-ragged", "viewer-bank", "viewer"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("staged"))
            .andExpect(jsonPath("$.lines.length()").value(2))
            .andExpect(jsonPath("$.lines[0].columns[0]").value("거래일자"))
            .andExpect(jsonPath("$.lines[0].rawCells.length()").value(4))
            .andExpect(jsonPath("$.lines[0].rawCells[3]").value(""))
            .andExpect(jsonPath("$.lines[1].columns[2]").value("출금금액"))
            .andExpect(jsonPath("$.lines[1].rawCells.length()").value(4))
            .andExpect(jsonPath("$.lines[1].rawCells[3]").value("70,000"));
    }

    @Test
    void bankStatementImportRejectsOversizedColumnsRawCellsAndLineCountsBeforePersistence() throws Exception {
        List<String> tooManyColumns = new ArrayList<>();
        for (int i = 0; i < 81; i++) {
            tooManyColumns.add("은행컬럼" + i);
        }

        String tooManyColumnsBody = objectMapper.writeValueAsString(Map.of(
            "idempotencyKey", "bank-import-too-many-columns",
            "uploadName", "oversized-columns.xlsx",
            "columns", tooManyColumns,
            "lines", List.of(bankImportLine(0, "too-many-columns-line", List.of("2026-06-01", "-1")))
        ));

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-bank-size/bank-statements/import-batch"), "tenant-bank-size", "pm-bank", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(tooManyColumnsBody))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_validation_failed"));

        List<String> tooManyRawCells = new ArrayList<>();
        for (int i = 0; i < 121; i++) {
            tooManyRawCells.add("cell-" + i);
        }
        String tooManyRawCellsBody = objectMapper.writeValueAsString(Map.of(
            "idempotencyKey", "bank-import-too-many-raw-cells",
            "uploadName", "oversized-raw-cells.xlsx",
            "columns", List.of("거래일자", "금액"),
            "lines", List.of(bankImportLine(0, "too-many-raw-cells-line", tooManyRawCells))
        ));

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-bank-size/bank-statements/import-batch"), "tenant-bank-size", "pm-bank", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(tooManyRawCellsBody))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_validation_failed"));

        List<Map<String, Object>> tooManyLines = new ArrayList<>();
        for (int i = 0; i < 2001; i++) {
            tooManyLines.add(bankImportLine(i, "too-many-lines-" + i, List.of("2026-06-01", "-1")));
        }
        String tooManyLinesBody = objectMapper.writeValueAsString(Map.of(
            "idempotencyKey", "bank-import-too-many-lines",
            "uploadName", "oversized-lines.xlsx",
            "columns", List.of("거래일자", "금액"),
            "lines", tooManyLines
        ));

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-bank-size/bank-statements/import-batch"), "tenant-bank-size", "pm-bank", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(tooManyLinesBody))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_validation_failed"));

        assertThat(bankImportLineRepository.findByTenantIdAndProjectIdAndOptionalStatus("tenant-bank-size", "project-bank-size", null))
            .isEmpty();
    }

    @Test
    void bankStatementImportDeduplicatesAndApplyRejectsAlreadyAppliedLinesWithNewIdempotencyKey() throws Exception {
        String importBody = """
            {
              "idempotencyKey": "bank-import-dedupe-001",
              "uploadName": "dedupe-bank.xlsx",
              "columns": ["거래일시", "지급처", "적요", "금액", "잔액"],
              "lines": [
                {
                  "lineIndex": 0,
                  "sourceLineKey": "dup-bank-line-001",
                  "transactionDate": "2026-06-03",
                  "counterparty": "선택 지급처",
                  "memo": "선택 적용",
                  "signedAmount": -100000,
                  "balanceAfter": 900000,
                  "rawCells": ["2026-06-03", "선택 지급처", "선택 적용", "-100000", "900000"]
                },
                {
                  "lineIndex": 1,
                  "sourceLineKey": "client-sent-key-must-be-ignored",
                  "transactionDate": "2026-06-03",
                  "counterparty": "클라이언트 조작 지급처",
                  "memo": "같은 업로드 내 중복",
                  "signedAmount": -100000,
                  "balanceAfter": 700000,
                  "rawCells": ["2026-06-03", "선택 지급처", "같은 업로드 내 중복", "-100000", "700000"]
                },
                {
                  "lineIndex": 2,
                  "sourceLineKey": "dup-bank-line-002",
                  "transactionDate": "2026-06-04",
                  "counterparty": "보류 지급처",
                  "memo": "아직 적용하지 않음",
                  "signedAmount": -300000,
                  "balanceAfter": 400000,
                  "rawCells": ["2026-06-04", "보류 지급처", "아직 적용하지 않음", "-300000", "400000"]
                }
              ]
            }
            """;

        String importResponse = mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-bank-dedupe/bank-statements/import-batch"), "tenant-bank-dedupe", "pm-bank", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(importBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.stagedLineCount").value(2))
            .andExpect(jsonPath("$.duplicateLineCount").value(1))
            .andExpect(jsonPath("$.lines.length()").value(3))
            .andReturn()
            .getResponse()
            .getContentAsString();

        assertThat(actualRepository.findByTenantIdAndProjectId("tenant-bank-dedupe", "project-bank-dedupe"))
            .isEmpty();

        String existingDuplicateBody = """
            {
              "idempotencyKey": "bank-import-dedupe-002",
              "uploadName": "dedupe-bank-retry.xlsx",
              "columns": ["거래일시", "지급처", "적요", "금액", "잔액"],
              "lines": [
                {
                  "lineIndex": 0,
                  "sourceLineKey": "client-duplicate-key-is-ignored",
                  "transactionDate": "2026-06-03",
                  "counterparty": "선택 지급처",
                  "memo": "이미 staged",
                  "signedAmount": -100000,
                  "balanceAfter": 900000,
                  "rawCells": ["2026-06-03", "선택 지급처", "이미 staged", "-100000", "900000"]
                }
              ]
            }
            """;
        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-bank-dedupe/bank-statements/import-batch"), "tenant-bank-dedupe", "pm-bank", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(existingDuplicateBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.stagedLineCount").value(0))
            .andExpect(jsonPath("$.duplicateLineCount").value(1));

        JsonNode lines = objectMapper.readTree(importResponse).get("lines");
        String selectedLineId = null;
        String unselectedLineId = null;
        for (JsonNode line : lines) {
            if (line.get("lineIndex").asInt() == 0 && !line.get("id").isNull()) {
                selectedLineId = line.get("id").asText();
            }
            if (line.get("lineIndex").asInt() == 2 && !line.get("id").isNull()) {
                unselectedLineId = line.get("id").asText();
            }
        }
        assertThat(selectedLineId).isNotBlank();
        assertThat(unselectedLineId).isNotBlank();

        String applySelected = """
            {
              "idempotencyKey": "bank-apply-dedupe-001",
              "sheetKey": "default",
              "sheetName": "기본 탭",
              "items": [
                {
                  "importLineId": "%s",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true},
                    {"columnIndex": 8, "rawValue": "사업비", "userEdited": true}
                  ]
                }
              ]
            }
            """.formatted(selectedLineId);

        String duplicateApplySelected = """
            {
              "idempotencyKey": "bank-apply-duplicate-items-001",
              "sheetKey": "default",
              "sheetName": "기본 탭",
              "items": [
                {
                  "importLineId": "%s",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true}
                  ]
                },
                {
                  "importLineId": "%s",
                  "cells": [
                    {"columnIndex": 8, "rawValue": "사업비", "userEdited": true}
                  ]
                }
              ]
            }
            """.formatted(selectedLineId, selectedLineId);

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-bank-dedupe/bank-statements/apply-items"), "tenant-bank-dedupe", "pm-bank", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(duplicateApplySelected))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_bad_request"));

        assertThat(actualRepository.findByTenantIdAndProjectId("tenant-bank-dedupe", "project-bank-dedupe"))
            .isEmpty();

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-bank-dedupe/bank-statements/apply-items"), "tenant-bank-dedupe", "pm-bank", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(applySelected))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.appliedLineCount").value(1))
            .andExpect(jsonPath("$.actualDelta[0].amount").value(100000));

        assertThat(actualRepository.findByTenantIdAndProjectId("tenant-bank-dedupe", "project-bank-dedupe"))
            .hasSize(1);
        assertThat(bankImportLineRepository.findById(selectedLineId).orElseThrow().getStatus())
            .isEqualTo("applied");
        assertThat(bankImportLineRepository.findById(unselectedLineId).orElseThrow().getStatus())
            .isEqualTo("staged");

        mockMvc.perform(asActor(get("/api/v1/weekly-expenses/project-bank-dedupe/bank-statements/import-lines"), "tenant-bank-dedupe", "viewer-bank", "viewer"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("staged"))
            .andExpect(jsonPath("$.lines.length()").value(1))
            .andExpect(jsonPath("$.lines[0].id").value(unselectedLineId))
            .andExpect(jsonPath("$.lines[0].status").value("staged"))
            .andExpect(jsonPath("$.lines[0].rawCells[0]").value("2026-06-04"));

        mockMvc.perform(asActor(get("/api/v1/weekly-expenses/project-bank-dedupe/bank-statements/import-lines?status=all"), "tenant-bank-dedupe", "finance-bank", "finance"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("all"))
            .andExpect(jsonPath("$.lines.length()").value(2))
            .andExpect(jsonPath("$.lines[0].batchId").isNotEmpty())
            .andExpect(jsonPath("$.lines[0].uploadName").value("dedupe-bank.xlsx"));

        String reapplySelected = applySelected.replace("bank-apply-dedupe-001", "bank-apply-dedupe-002");
        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-bank-dedupe/bank-statements/apply-items"), "tenant-bank-dedupe", "pm-bank", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(reapplySelected))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("weekly_expense_conflict"))
            .andExpect(jsonPath("$.message").value("Bank import line is already applied: " + selectedLineId));

        assertThat(actualRepository.findByTenantIdAndProjectId("tenant-bank-dedupe", "project-bank-dedupe"))
            .hasSize(1);
    }

    @Test
    void submitWeekPersistsStateAuditAndIdempotency() throws Exception {
        String body = """
            {
              "idempotencyKey": "submit-001",
              "yearMonth": "2026-06",
              "weekNo": 2
            }
            """;

        String firstResponse = mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-submit/submit"), "tenant-submit", "pm-submit", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.submitWeek"))
            .andExpect(jsonPath("$.state").value("submitted"))
            .andReturn()
            .getResponse()
            .getContentAsString();

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-submit/submit"), "tenant-submit", "pm-submit", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.auditId").value(objectMapper.readTree(firstResponse).get("auditId").asText()));
    }

    @Test
    void closeWeekPersistsStateAuditAndRequiresSubmittedWeek() throws Exception {
        String closeBeforeSubmitBody = """
            {
              "idempotencyKey": "close-before-submit-001",
              "yearMonth": "2026-06",
              "weekNo": 3
            }
            """;
        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-close/close"), "tenant-close", "admin-close", "admin")
                .contentType(MediaType.APPLICATION_JSON)
                .content(closeBeforeSubmitBody))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("weekly_expense_conflict"));

        String submitBody = """
            {
              "idempotencyKey": "submit-before-close-001",
              "yearMonth": "2026-06",
              "weekNo": 3
            }
            """;
        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-close/submit"), "tenant-close", "pm-close", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(submitBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.state").value("submitted"));

        String closeBody = """
            {
              "idempotencyKey": "close-001",
              "yearMonth": "2026-06",
              "weekNo": 3
            }
            """;
        String firstResponse = mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-close/close"), "tenant-close", "admin-close", "admin")
                .contentType(MediaType.APPLICATION_JSON)
                .content(closeBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.closeWeek"))
            .andExpect(jsonPath("$.state").value("closed"))
            .andReturn()
            .getResponse()
            .getContentAsString();

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-close/close"), "tenant-close", "admin-close", "admin")
                .contentType(MediaType.APPLICATION_JSON)
                .content(closeBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.auditId").value(objectMapper.readTree(firstResponse).get("auditId").asText()));

        mockMvc.perform(asActor(get("/api/v1/weekly-expenses/project-close/statuses"), "tenant-close", "viewer-close", "viewer"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.projectId").value("project-close"))
            .andExpect(jsonPath("$.statuses.length()").value(1))
            .andExpect(jsonPath("$.statuses[0].id").value("project-close-2026-06-w3"))
            .andExpect(jsonPath("$.statuses[0].state").value("closed"))
            .andExpect(jsonPath("$.statuses[0].pmSubmitted").value(true))
            .andExpect(jsonPath("$.statuses[0].submittedBy").value("pm-close"))
            .andExpect(jsonPath("$.statuses[0].adminClosed").value(true))
            .andExpect(jsonPath("$.statuses[0].closedBy").value("admin-close"));

        mockMvc.perform(asActor(get("/api/v1/weekly-expenses/project-close/statuses"), "tenant-close", "contractor-close", "contractor"))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("weekly_expense_forbidden"));
    }

    @Test
    void cashflowMonthCloseReadRequiresYearMonthQueryAndCanonicalValue() throws Exception {
        mockMvc.perform(asActor(
                get("/api/v1/cashflow/project-month-close/month-close"),
                "tenant-month-close",
                "viewer-month-close",
                "viewer"
            ))
            .andExpect(status().isBadRequest());

        mockMvc.perform(asActor(
                get("/api/v1/cashflow/project-month-close/month-close")
                    .queryParam("yearMonth", "2026-13"),
                "tenant-month-close",
                "viewer-month-close",
                "viewer"
            ))
            .andExpect(status().isBadRequest());
    }

    @Test
    void cashflowMonthDashboardSourceReturnsCloseAndCashflowInOneResponse() {
        WeeklyExpenseCommandService dashboardCommandService = mock(WeeklyExpenseCommandService.class);
        WeeklyExpensePersistence dashboardPersistence = mock(WeeklyExpensePersistence.class);
        when(dashboardPersistence.findCashflowMonthClose(
            "tenant-month-dashboard", "project-month-dashboard", "2026-06"
        )).thenReturn(monthCloseState(new CashflowMonthCloseResponse(
            true, "cashflowMonth.read", "project-month-dashboard", "2026-06", "OPEN",
            0, 0, 0,
            0, 0, null, null, null, null, null, false,
            Map.of(),
            null, null, Map.of(), Map.of(), false,
            "2026-07-20", "2026-07-10", true,
            null, null, null, null, null, null, null, null, null, null, null
        )));
        when(dashboardPersistence.findCashflowDeclaredWeeklyYear("tenant-month-dashboard", "project-month-dashboard"))
            .thenReturn(2026);
        CashflowLedgerSource dashboardSource =
            new CashflowLedgerSource(List.of(), List.of());
        when(dashboardPersistence.findCashflowLedgerSource("tenant-month-dashboard", "project-month-dashboard", 2026))
            .thenReturn(dashboardSource);
        when(dashboardPersistence.findCashflowLedgerSource(
            eq("tenant-month-dashboard"), eq("project-month-dashboard"), eq(2026), eq("2023-01"), anyString()
        )).thenReturn(dashboardSource);
        Map<String, String> completeAnnualStates = new LinkedHashMap<>();
        CashflowLineCatalog.ALL_LINES.forEach(line -> completeAnnualStates.put(line, "EMPTY"));
        completeAnnualStates.put("SALES_IN", "VALUE");
        when(dashboardPersistence.findCashflowOpeningBalance(
            "tenant-month-dashboard",
            "project-month-dashboard",
            2026
        )).thenReturn(new CashflowOpeningBalance(
            2026,
            new CashflowOpeningBalance.Mode(
                new java.math.BigDecimal("2000000"),
                Map.of("SALES_IN", new java.math.BigDecimal("2000000")),
                List.of(new CashflowOpeningBalance.YearSource(
                    2025,
                    Map.of("SALES_IN", new java.math.BigDecimal("2000000")),
                    completeAnnualStates
                )),
                List.of(2025),
                List.of()
            ),
            new CashflowOpeningBalance.Mode(
                new java.math.BigDecimal("1800000"),
                Map.of("SALES_IN", new java.math.BigDecimal("1800000")),
                List.of(new CashflowOpeningBalance.YearSource(
                    2025,
                    Map.of("SALES_IN", new java.math.BigDecimal("1800000")),
                    completeAnnualStates
                )),
                List.of(2025),
                List.of()
            )
        ));

        CashflowMonthDashboardSourceResponse response = testController(
            dashboardCommandService, new CashflowReadService(dashboardPersistence), false
        ).readCashflowMonthDashboardSource(
            "project-month-dashboard",
            "2026-06",
            "tenant-month-dashboard",
            "viewer-month-dashboard",
            "viewer",
            "viewer@example.com"
        );

        assertThat(response.monthClose().status()).isEqualTo("OPEN");
        assertThat(response.cashflow().projectId()).isEqualTo("project-month-dashboard");
        assertThat(response.cashflow().readModel().months()).isEmpty();
        assertThat(response.openingBalances().selectedYear()).isEqualTo(2026);
        assertThat(response.openingBalances().projection().amount()).isEqualByComparingTo("2000000");
        assertThat(response.openingBalances().actual().amount()).isEqualByComparingTo("1800000");
        assertThat(response.openingBalances().projection().includedYears()).containsExactly(2025);
        assertThat(response.openingBalances().projection().excludedWeeklyYears()).isEmpty();
        assertThat(response.openingBalances().projection().lineAmounts()).containsEntry("SALES_IN", new java.math.BigDecimal("2000000"));
        assertThat(response.openingBalances().projection().sources()).singleElement().satisfies(source -> {
            assertThat(source.year()).isEqualTo(2025);
            assertThat(source.lineStates()).containsEntry("SALES_IN", "VALUE");
        });
        assertThat(response.projectionActualSummary().settlementDifferenceAmount())
            .isEqualByComparingTo("0");
        assertThat(response.cumulativeClose().availability()).isEqualTo("MISSING");
        assertThat(response.cumulativeClose().status()).isNull();
        assertThat(response.cumulativeClose().fromMonth()).isNull();
        assertThat(response.cumulativeClose().headRevision()).isNull();
        verify(dashboardPersistence)
            .findCashflowLedgerSource("tenant-month-dashboard", "project-month-dashboard", 2026);
        verify(dashboardPersistence).findCashflowLedgerSource(
            eq("tenant-month-dashboard"), eq("project-month-dashboard"), eq(2026), eq("2023-01"), anyString()
        );
    }

    @Test
    void settlementCycleDashboardPublishesTheCanonicalCycleProjection() {
        WeeklyExpensePersistence dashboardPersistence = mock(WeeklyExpensePersistence.class);
        WeeklyExpenseAuthorizationService authorization = mock(WeeklyExpenseAuthorizationService.class);
        WeeklyExpenseCommandService dashboardCommandService = new WeeklyExpenseCommandService(
            dashboardPersistence, authorization, objectMapper, false, "live"
        );
        when(dashboardPersistence.findCashflowMonthClose(
            "tenant-cycle-dashboard", "project-cycle-dashboard", "2026-08"
        )).thenReturn(monthCloseState(new CashflowMonthCloseResponse(
            true, "cashflowMonth.read", "project-cycle-dashboard", "2026-08", "OPEN",
            0, 0, 0, 0, 0, null, null, null, null, null, false,
            Map.of(), null, null, Map.of(), Map.of(), false,
            "2026-08-27", "2026-08-10", true,
            null, null, null, null, null, null, null, null, null, null, null
        )));
        when(dashboardPersistence.findCashflowDeclaredWeeklyYear(
            "tenant-cycle-dashboard", "project-cycle-dashboard"
        )).thenReturn(2026);
        CashflowLedgerSource source = new CashflowLedgerSource(List.of(), List.of());
        when(dashboardPersistence.findCashflowLedgerSource(
            "tenant-cycle-dashboard", "project-cycle-dashboard", 2026
        )).thenReturn(source);
        when(dashboardPersistence.findCashflowLedgerSource(
            "tenant-cycle-dashboard", "project-cycle-dashboard", 2026, "2023-01", "2026-08"
        )).thenReturn(source);
        when(dashboardPersistence.findCashflowOpeningBalance(
            "tenant-cycle-dashboard", "project-cycle-dashboard", 2026
        )).thenReturn(new CashflowOpeningBalance(
            2026,
            new CashflowOpeningBalance.Mode(java.math.BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of()),
            new CashflowOpeningBalance.Mode(java.math.BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of())
        ));
        WeeklyExpensePersistence.CashflowSettlementStatusRecord legacyTargetMonth =
            new WeeklyExpensePersistence.CashflowSettlementStatusRecord(
                "MONTH", "COMPLETED", "2026-08-20T02:51:00Z", "pm-1",
                "2026-08-25T06:45:00Z", "head-1", 2
            );
        WeeklyExpensePersistence.CashflowSettlementStatusRecord legacyTargetWeek =
            new WeeklyExpensePersistence.CashflowSettlementStatusRecord(
                "WEEK_1", "COMPLETED", "", "", "", "", 1
            );
        WeeklyExpensePersistence.CashflowSettlementStatusRecord canonicalMonth =
            new WeeklyExpensePersistence.CashflowSettlementStatusRecord(
                "MONTH", "LOCKED", "2026-08-20T02:51:00Z", "pm-1",
                "2026-08-25T06:45:00Z", "head-1", 2
            );
        WeeklyExpensePersistence.CashflowSettlementStatusRecord canonicalWeek =
            new WeeklyExpensePersistence.CashflowSettlementStatusRecord(
                "WEEK_1", "PENDING_APPROVAL", "", "", "", "", 0
            );
        when(dashboardPersistence.findCashflowSettlementStatuses(
            "tenant-cycle-dashboard", "project-cycle-dashboard", "2026-07"
        )).thenReturn(List.of(legacyTargetMonth, legacyTargetWeek));
        when(dashboardPersistence.findCashflowSettlementCyclesBatch(
            any(TrustedActorContext.class), eq(List.of("project-cycle-dashboard")), eq("2026-08"), eq("2026-07")
        )).thenReturn(Map.of(
            "project-cycle-dashboard", new WeeklyExpensePersistence.CashflowSettlementCycleRecord(
                "project-cycle-dashboard", "2026-08", "2026-07",
                List.of(canonicalMonth, canonicalWeek), canonicalMonth,
                new CashflowSettlementCyclePolicy.Projection(
                    CashflowSettlementCyclePolicy.BusinessState.LOCKED,
                    CashflowSettlementCyclePolicy.Health.OK,
                    2,
                    new CashflowSettlementCyclePolicy.ApprovalProvenance(
                        "2023-01", "2026-07", "2026-08", "project-cycle-dashboard-2026-08-r1",
                        "project-cycle-dashboard-2026-08", 1, "sha256:" + "a".repeat(64)
                    ),
                    ""
                )
            )
        ));

        CashflowMonthDashboardSourceResponse response = testController(
            dashboardCommandService, new CashflowReadService(dashboardPersistence), false
        ).readCashflowMonthDashboardSource(
            "project-cycle-dashboard", "2026-08", true,
            "tenant-cycle-dashboard", "viewer-cycle-dashboard", "viewer", "viewer@example.com"
        );

        JsonNode json = objectMapper.valueToTree(response);
        assertThat(json.path("settlementCycle").path("businessState").asText())
            .isEqualTo("LOCKED");
        assertThat(json.path("settlementCycle").path("provenance").path("requestId").asText())
            .isEqualTo("project-cycle-dashboard-2026-08");
        assertThat(json.path("settlementStatuses").path("yearMonth").asText())
            .isEqualTo("2026-08");
        assertThat(json.path("settlementStatuses").path("items").get(0).path("status").asText())
            .isEqualTo("LOCKED");
        assertThat(json.path("settlementStatuses").path("items").get(0).path("deadlineAt").asText())
            .isEqualTo("2026-08-10T15:00:00Z");
        assertThat(json.path("settlementStatuses").path("items").get(0).path("approverDeadlineAt").asText())
            .isEqualTo("2026-08-31T15:00:00Z");
        assertThat(json.path("settlementStatuses").path("items").get(1).path("status").asText())
            .isEqualTo("PENDING_APPROVAL");
        assertThat(json.path("settlementStatuses").path("items").get(1).path("deadlineAt").asText())
            .isEqualTo("2026-08-02T15:00:00Z");
        assertThat(json.path("monthCloseCalendar").get(6).path("yearMonth").asText())
            .isEqualTo("2026-07");
        assertThat(json.path("monthCloseCalendar").get(6).path("closeDeadline").asText())
            .isEqualTo(json.path("operationalCycle").path("closeDeadline").asText());
        assertThat(json.path("monthCloseCalendar").get(6).path("approverDeadlineAt").asText())
            .isEqualTo("2026-08-31T15:00:00Z");
        verify(dashboardPersistence).findCashflowSettlementCyclesBatch(
            any(TrustedActorContext.class), eq(List.of("project-cycle-dashboard")), eq("2026-08"), eq("2026-07")
        );
        verify(dashboardPersistence, never()).findCashflowSettlementStatuses(
            "tenant-cycle-dashboard", "project-cycle-dashboard", "2026-07"
        );
    }

    @Test
    void dashboardUsesCumulativeHeadForOperationalStatusAndKeepsStaleCloseAsEvidence() {
        WeeklyExpenseCommandService dashboardCommandService = mock(WeeklyExpenseCommandService.class);
        WeeklyExpensePersistence dashboardPersistence = mock(WeeklyExpensePersistence.class);
        CashflowMonthCloseResponse staleLatestRun = new CashflowMonthCloseResponse(
            true, "cashflowMonth.read", "project-stale-close", "2026-08", "CLOSED",
            1, 0, 0, 0, 0, null, null, null, null, null, false,
            Map.of(), "sha256:" + "b".repeat(64), null, Map.of("ledgerWeeks", List.of()), Map.of(), true,
            "2026-09-01", "2026-09-10", false,
            "2026-08-31T15:00:00Z", "finance-1", "재무",
            null, null, null, null, null, null, null, "audit-stale-close"
        );
        when(dashboardPersistence.findCashflowMonthClose(
            "tenant-stale-close", "project-stale-close", "2026-08"
        )).thenReturn(monthCloseState(staleLatestRun));
        when(dashboardPersistence.findCashflowCumulativeCloseHead(
            "tenant-stale-close", "project-stale-close"
        )).thenReturn(new CashflowCumulativeCloseHead(
            "CLOSED", "2023-01", "2026-08", "2026-07", "sha256:" + "a".repeat(64), 4
        ));
        when(dashboardPersistence.findCashflowDeclaredWeeklyYear(
            "tenant-stale-close", "project-stale-close"
        )).thenReturn(2026);
        CashflowLedgerSource liveSource = new CashflowLedgerSource(List.of(), List.of());
        when(dashboardPersistence.findCashflowLedgerSource(
            "tenant-stale-close", "project-stale-close", 2026
        )).thenReturn(liveSource);
        when(dashboardPersistence.findCashflowOpeningBalance(
            "tenant-stale-close", "project-stale-close", 2026
        )).thenReturn(new CashflowOpeningBalance(
            2026,
            new CashflowOpeningBalance.Mode(
                java.math.BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of()
            ),
            new CashflowOpeningBalance.Mode(
                java.math.BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of()
            )
        ));
        when(dashboardCommandService.readCashflowProjectionActualSummary(
            any(), eq("project-stale-close"), same(liveSource)
        )).thenReturn(new CashflowProjectionActualSummaryBatchResponse.Item(
            "project-stale-close", "2023-01",
            new CashflowProjectionActualSummaryBatchResponse.ComparisonAsOfWeek("2026-08", 3),
            java.math.BigDecimal.ZERO, true
        ));
        when(dashboardCommandService.readCashflowSettlementStatuses(
            any(), eq("project-stale-close"), eq("2026-07")
        )).thenReturn(new CashflowSettlementStatusesResponse(
            "project-stale-close",
            "2026-07",
            List.of(new CashflowSettlementStatusesResponse.Item(
                "MONTH", "COMPLETED", "2026-08-20T02:51:00Z", "pm-1",
                "2026-08-25T06:45:00Z", "finance-1", 2, null, null
            ))
        ));

        CashflowMonthDashboardSourceResponse response = testController(
            dashboardCommandService,
            new CashflowReadService(dashboardPersistence),
            false
        ).readCashflowMonthDashboardSource(
            "project-stale-close", "2026-08", "tenant-stale-close",
            "viewer-stale-close", "viewer", "viewer@example.com"
        );

        assertThat(response.monthClose().status()).isEqualTo("OPEN");
        assertThat(response.snapshotCompatibility().status()).isEqualTo("LIVE_CURRENT");
        assertThat(response.cashflow()).isNotNull();
        JsonNode json = objectMapper.valueToTree(response);
        assertThat(json.path("latestRun").path("status").asText()).isEqualTo("CLOSED");
        assertThat(json.path("monthStatusEvidence").path("issueCode").asText())
            .isEqualTo("MONTH_CLOSE_HISTORY_STATUS_DIFFERS_FROM_CUMULATIVE_AUTHORITY");
        assertThat(json.path("monthStatusEvidence").path("closedThrough").asText())
            .isEqualTo("2026-07");
        assertThat(json.path("cumulativeClose").path("settlementMonth").asText())
            .isEqualTo("2026-08");
        assertThat(json.path("operationalCycle")).isNotNull();
        assertThat(json.path("operationalCycle").path("cycleYearMonth").asText()).isEqualTo("2026-08");
        assertThat(json.path("operationalCycle").path("targetYearMonth").asText()).isEqualTo("2026-07");
        assertThat(json.path("operationalCycle").path("closeDeadline").asText()).isEqualTo("2026-08-10");
        assertThat(json.path("operationalCycle").path("closeEligible").asBoolean()).isTrue();
        assertThat(json.path("operationalCycle").path("late").asBoolean()).isTrue();
        assertThat(json.path("settlementStatuses").path("yearMonth").asText()).isEqualTo("2026-07");
        assertThat(json.path("settlementStatuses").path("items").get(0).path("period").asText())
            .isEqualTo("MONTH");
        assertThat(json.path("settlementStatuses").path("items").get(0).path("status").asText())
            .isEqualTo("COMPLETED");
        assertThat(json.path("settlementStatuses").path("items").get(0).path("approvedAt").asText())
            .isEqualTo("2026-08-25T06:45:00Z");
        assertThat(json.path("monthCloseCalendar")).hasSize(12);
        assertThat(json.path("monthCloseCalendar").get(0).path("yearMonth").asText()).isEqualTo("2026-01");
        assertThat(json.path("monthCloseCalendar").get(7).path("yearMonth").asText()).isEqualTo("2026-08");
        assertThat(json.path("monthCloseCalendar").get(7).path("closeDeadline").asText())
            .isEqualTo("2026-09-10");
        assertThat(json.path("monthCloseCalendar").get(7).path("closeDeadlineAt").asText())
            .isEqualTo("2026-09-10T15:00:00Z");
        assertThat(json.path("monthCloseCalendar").get(7).path("approverDeadlineAt").asText())
            .isEqualTo("2026-09-30T15:00:00Z");
        assertThat(json.path("reopenRequest").path("enabled").asBoolean()).isTrue();
    }

    @Test
    void missingCumulativeHeadNeverExposesStaleClosedHistoryAsOperationalAuthority() {
        WeeklyExpenseCommandService dashboardCommandService = mock(WeeklyExpenseCommandService.class);
        WeeklyExpensePersistence dashboardPersistence = mock(WeeklyExpensePersistence.class);
        when(dashboardPersistence.findCashflowMonthClose(
            "tenant-missing-head", "project-missing-head", "2026-08"
        )).thenReturn(monthCloseState(new CashflowMonthCloseResponse(
            true, "cashflowMonth.read", "project-missing-head", "2026-08", "CLOSED",
            1, 0, 0, 0, 0, null, null, null, null, null, false,
            Map.of(), "sha256:" + "c".repeat(64), null, Map.of("ledgerWeeks", List.of()),
            Map.of(), true, "2026-09-01", "2026-09-10", false,
            "2026-08-31T15:00:00Z", "finance-1", "재무",
            null, null, null, null, null, null, null, "audit-missing-head"
        )));

        CashflowMonthDashboardSourceResponse response = testController(
            dashboardCommandService,
            new CashflowReadService(dashboardPersistence),
            false
        ).readCashflowMonthDashboardSource(
            "project-missing-head", "2026-08", "tenant-missing-head",
            "viewer-missing-head", "viewer", "viewer@example.com"
        );

        assertThat(response.monthClose().status()).isEqualTo("UNAVAILABLE");
        assertThat(response.latestRun().status()).isEqualTo("CLOSED");
        assertThat(response.monthStatusEvidence().authorityAvailability()).isEqualTo("MISSING");
        assertThat(response.monthStatusEvidence().operationalStatus()).isNull();
        assertThat(response.monthStatusEvidence().issueCode())
            .isEqualTo("CUMULATIVE_CLOSE_AUTHORITY_MISSING");
        assertThat(response.snapshotCompatibility().status()).isEqualTo("AUTHORITY_UNAVAILABLE");
        assertThat(response.cashflow()).isNull();
        assertThat(response.openingBalances()).isNull();
        assertThat(response.blockers()).contains(new CashflowMonthDashboardSourceResponse.Blocker(
            "CUMULATIVE_CLOSE_AUTHORITY_MISSING",
            "누적 월 결산 기준이 아직 없습니다. AXR 현금흐름 기간·마감 정책에서 상태를 확인해 주세요."
        ));
        verify(dashboardPersistence, never()).findCashflowLedgerSource(
            "tenant-missing-head", "project-missing-head", 2026
        );
        verify(dashboardPersistence, never()).findCashflowGlobalLedgerSource(
            "tenant-missing-head", "project-missing-head"
        );
        verify(dashboardPersistence, never()).findCashflowOpeningBalance(
            "tenant-missing-head", "project-missing-head", 2026
        );
    }

    @Test
    void openDashboardWithoutDeclaredWeeklyYearReturnsSourceBlockerAndKeepsOtherData() {
        WeeklyExpenseCommandService dashboardCommandService = mock(WeeklyExpenseCommandService.class);
        WeeklyExpensePersistence dashboardPersistence = mock(WeeklyExpensePersistence.class);
        when(dashboardPersistence.findCashflowDeclaredWeeklyYear("tenant-no-year", "project-no-year"))
            .thenReturn(null);
        when(dashboardPersistence.findCashflowMonthClose(
            "tenant-no-year", "project-no-year", "2026-06"
        )).thenReturn(monthCloseState(new CashflowMonthCloseResponse(
                true, "cashflowMonth.read", "project-no-year", "2026-06", "OPEN",
                0, 0, 0, 0, 0, null, null, null, null, null, false,
                Map.of(), null, null, Map.of(), Map.of(), false,
                "2026-07-20", "2026-07-10", true,
                null, null, null, null, null, null, null, null, null, null, null
            )));
        when(dashboardPersistence.findCashflowOpeningBalance("tenant-no-year", "project-no-year", 2026))
            .thenReturn(new CashflowOpeningBalance(
                2026,
                new CashflowOpeningBalance.Mode(
                    java.math.BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of()
                ),
                new CashflowOpeningBalance.Mode(
                    java.math.BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of()
                )
            ));
        when(dashboardCommandService.readCashflowProjectionActualSummary(
            any(), eq("project-no-year"), any(CashflowLedgerSource.class)
        )).thenReturn(new CashflowProjectionActualSummaryBatchResponse.Item(
            "project-no-year", "2023-01",
            new CashflowProjectionActualSummaryBatchResponse.ComparisonAsOfWeek("2026-07", 4),
            java.math.BigDecimal.ZERO, true
        ));

        CashflowMonthDashboardSourceResponse response = testController(
            dashboardCommandService, new CashflowReadService(dashboardPersistence), false
        ).readCashflowMonthDashboardSource(
            "project-no-year", "2026-06", "tenant-no-year", "viewer-no-year", "viewer", "viewer@example.com"
        );

        assertThat(response.monthClose().status()).isEqualTo("OPEN");
        assertThat(response.cashflow()).isNull();
        assertThat(response.openingBalances().selectedYear()).isEqualTo(2026);
        assertThat(response.projectionActualSummary()).isNull();
        assertThat(response.blockers()).extracting(CashflowMonthDashboardSourceResponse.Blocker::code)
            .containsExactlyInAnyOrder(
                "SHEET_SOURCE_REQUIRED",
                "CASHFLOW_SOURCE_UNAVAILABLE",
                "PROJECTION_ACTUAL_SUMMARY_UNAVAILABLE"
            );
        assertThat(response.sectionErrors()).extracting(
            CashflowMonthDashboardSourceResponse.SectionError::section,
            CashflowMonthDashboardSourceResponse.SectionError::code
        ).containsExactlyInAnyOrder(
            org.assertj.core.groups.Tuple.tuple("cashflow", "cashflow_declared_weekly_year_missing"),
            org.assertj.core.groups.Tuple.tuple(
                "projectionActualSummary", "cashflow_projection_actual_summary_unavailable"
            )
        );
        verify(dashboardPersistence, times(2))
            .findCashflowDeclaredWeeklyYear("tenant-no-year", "project-no-year");
        verify(dashboardPersistence, never()).findCashflowLedgerSource(any(), any(), anyInt());
    }

    @Test
    void cumulativeAuthorityFailuresBlockOnlyThatDashboardSection() {
        Map<String, RuntimeException> failures = Map.of(
            "INVALID", new CashflowReadPort.InvalidCumulativeCloseAuthority(),
            "UNAVAILABLE", new CashflowReadPort.Unavailable(
                new RuntimeException("firestore read unavailable")
            )
        );

        failures.forEach((availability, failure) -> {
            WeeklyExpenseCommandService dashboardCommandService = mock(WeeklyExpenseCommandService.class);
            WeeklyExpensePersistence dashboardPersistence = mock(WeeklyExpensePersistence.class);
            when(dashboardPersistence.findCashflowMonthClose(
                "tenant-authority-read", "project-authority-read", "2026-06"
            )).thenReturn(monthCloseState(new CashflowMonthCloseResponse(
                    true, "cashflowMonth.read", "project-authority-read", "2026-06", "OPEN",
                    0, 0, 0, 0, 0, null, null, null, null, null, false,
                    Map.of(), null, null, Map.of(), Map.of(), false,
                    "2026-07-20", "2026-07-10", true,
                    null, null, null, null, null, null, null, null, null, null, null
                )));
            when(dashboardPersistence.findCashflowDeclaredWeeklyYear("tenant-authority-read", "project-authority-read"))
                .thenReturn(2026);
            CashflowLedgerSource ledgerSource = new CashflowLedgerSource(List.of(), List.of());
            when(dashboardPersistence.findCashflowLedgerSource(
                eq("tenant-authority-read"), eq("project-authority-read"), eq(2026), eq("2023-01"), anyString()
            )).thenReturn(ledgerSource);
            when(dashboardPersistence.findCashflowOpeningBalance("tenant-authority-read", "project-authority-read", 2026))
                .thenReturn(new CashflowOpeningBalance(
                    2026,
                    new CashflowOpeningBalance.Mode(
                        java.math.BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of()
                    ),
                    new CashflowOpeningBalance.Mode(
                        java.math.BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of()
                    )
                ));
            when(dashboardPersistence.findCashflowCumulativeCloseHead("tenant-authority-read", "project-authority-read"))
                .thenThrow(failure);
            when(dashboardCommandService.readCashflowProjectionActualSummary(
                any(), eq("project-authority-read"), any(CashflowLedgerSource.class)
            )).thenReturn(new CashflowProjectionActualSummaryBatchResponse.Item(
                "project-authority-read", "2023-01",
                new CashflowProjectionActualSummaryBatchResponse.ComparisonAsOfWeek("2026-07", 4),
                java.math.BigDecimal.ZERO, true
            ));

            CashflowMonthDashboardSourceResponse response = testController(
                dashboardCommandService,
                new CashflowReadService(dashboardPersistence),
                false
            ).readCashflowMonthDashboardSource(
                "project-authority-read",
                "2026-06",
                "tenant-authority-read",
                "viewer-authority-read",
                "viewer",
                "viewer@example.com"
            );

            assertThat(response.monthClose().status()).isEqualTo("UNAVAILABLE");
            assertThat(response.monthStatusEvidence().operationalStatus()).isNull();
            assertThat(response.cashflow()).isNull();
            assertThat(response.openingBalances()).isNull();
            assertThat(response.projectionActualSummary().settlementMatches()).isTrue();
            assertThat(response.cumulativeClose().availability()).isEqualTo(availability);
            assertThat(response.cumulativeClose().status()).isNull();
            assertThat(response.blockers()).anySatisfy(blocker -> {
                assertThat(blocker.code()).isEqualTo("CUMULATIVE_CLOSE_AUTHORITY_" + availability);
                assertThat(blocker.message()).doesNotContain("firestore", "Stored authority");
            });
        });
    }

    @Test
    void independentDashboardSectionFailuresReturnPartialResultsWithoutTechnicalMessages() {
        Map<String, String> expectedSectionCodes = Map.of(
            "weeklyYear", "cashflow_declared_weekly_year_unavailable",
            "ledger", "cashflow_ledger_source_unavailable",
            "openingBalances", "cashflow_opening_balances_unavailable",
            "projectionActualSummary", "cashflow_projection_actual_summary_unavailable"
        );

        expectedSectionCodes.forEach((failedSection, expectedCode) -> {
            String projectId = "project-partial-" + failedSection;
            String tenantId = "tenant-partial";
            CashflowReadPort.Unavailable technicalFailure = new CashflowReadPort.Unavailable(
                new IllegalStateException(
                    "Firestore adapter exploded at internal line 917 for " + failedSection
                )
            );
            WeeklyExpenseCommandService dashboardCommandService = mock(WeeklyExpenseCommandService.class);
            WeeklyExpensePersistence dashboardPersistence = mock(WeeklyExpensePersistence.class);
            when(dashboardPersistence.findCashflowMonthClose(
                tenantId, projectId, "2026-06"
            )).thenReturn(monthCloseState(new CashflowMonthCloseResponse(
                    true, "cashflowMonth.read", projectId, "2026-06", "OPEN",
                    0, 0, 0, 0, 0, null, null, null, null, null, false,
                    Map.of(), null, null, Map.of(), Map.of(), false,
                    "2026-07-20", "2026-07-10", true,
                    null, null, null, null, null, null, null, null, null, null, null
                )));
            CashflowLedgerSource ledgerSource = new CashflowLedgerSource(List.of(), List.of());
            when(dashboardPersistence.findCashflowDeclaredWeeklyYear(tenantId, projectId))
                .thenReturn(2026);
            when(dashboardPersistence.findCashflowLedgerSource(tenantId, projectId, 2026))
                .thenReturn(ledgerSource);
            when(dashboardPersistence.findCashflowLedgerSource(
                eq(tenantId), eq(projectId), eq(2026), eq("2023-01"), anyString()
            )).thenReturn(ledgerSource);
            when(dashboardPersistence.findCashflowOpeningBalance(tenantId, projectId, 2026))
                .thenReturn(new CashflowOpeningBalance(
                    2026,
                    new CashflowOpeningBalance.Mode(
                        java.math.BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of()
                    ),
                    new CashflowOpeningBalance.Mode(
                        java.math.BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of()
                    )
                ));
            CashflowProjectionActualSummaryBatchResponse.Item summary =
                new CashflowProjectionActualSummaryBatchResponse.Item(
                    projectId, "2023-01",
                    new CashflowProjectionActualSummaryBatchResponse.ComparisonAsOfWeek("2026-07", 4),
                    java.math.BigDecimal.ZERO, true
                );
            when(dashboardCommandService.readCashflowProjectionActualSummary(
                any(), eq(projectId), same(ledgerSource)
            )).thenReturn(summary);
            when(dashboardCommandService.readCashflowProjectionActualSummaries(
                any(), any(CashflowProjectionActualSummaryBatchRequest.class)
            )).thenReturn(new CashflowProjectionActualSummaryBatchResponse("1", List.of(summary)));

            switch (failedSection) {
                case "weeklyYear" -> when(dashboardPersistence.findCashflowDeclaredWeeklyYear(tenantId, projectId))
                    .thenThrow(technicalFailure).thenReturn(2026);
                case "ledger" -> when(dashboardPersistence.findCashflowLedgerSource(tenantId, projectId, 2026))
                    .thenThrow(technicalFailure);
                case "openingBalances" -> when(dashboardPersistence.findCashflowOpeningBalance(tenantId, projectId, 2026))
                    .thenThrow(technicalFailure);
                case "projectionActualSummary" -> when(dashboardPersistence.findCashflowLedgerSource(
                    eq(tenantId), eq(projectId), eq(2026), eq("2023-01"), anyString()
                )).thenThrow(technicalFailure);
                default -> throw new IllegalStateException("Unexpected fixture section " + failedSection);
            }

            CashflowMonthDashboardSourceResponse response = testController(
                dashboardCommandService,
                new CashflowReadService(dashboardPersistence),
                false
            ).readCashflowMonthDashboardSource(
                projectId, "2026-06", tenantId, "viewer-partial", "viewer", "viewer@example.com"
            );

            assertThat(response.monthClose().status()).isEqualTo("OPEN");
            assertThat(response.cumulativeClose().availability()).isEqualTo("MISSING");
            assertThat(response.sectionErrors()).containsExactly(
                new CashflowMonthDashboardSourceResponse.SectionError(
                    failedSection.equals("weeklyYear") || failedSection.equals("ledger")
                        ? "cashflow"
                        : failedSection,
                    expectedCode
                )
            );
            assertThat(response.blockers()).singleElement().satisfies(blocker -> {
                assertThat(blocker.code()).endsWith("_UNAVAILABLE");
                assertThat(blocker.message())
                    .doesNotContain("Firestore", "adapter", "internal", "917", failedSection);
            });
            if (failedSection.equals("weeklyYear") || failedSection.equals("ledger")) {
                assertThat(response.cashflow()).isNull();
                assertThat(response.openingBalances()).isNotNull();
                assertThat(response.projectionActualSummary()).isNotNull();
            } else if (failedSection.equals("openingBalances")) {
                assertThat(response.cashflow()).isNotNull();
                assertThat(response.openingBalances()).isNull();
                assertThat(response.projectionActualSummary()).isNotNull();
            } else {
                assertThat(response.cashflow()).isNotNull();
                assertThat(response.openingBalances()).isNotNull();
                assertThat(response.projectionActualSummary()).isNull();
            }
        });
    }

    @Test
    void closedCashflowDashboardUsesFrozenOpeningRowsWithoutReadingLiveLedger() {
        WeeklyExpenseCommandService dashboardCommandService = mock(WeeklyExpenseCommandService.class);
        WeeklyExpensePersistence dashboardPersistence = mock(WeeklyExpensePersistence.class);
        stubProjectionActualSummary(dashboardCommandService, "project-frozen");
        Map<String, Object> emptyMode = Map.of(
            "amount", 0,
            "lineAmounts", Map.of(),
            "sources", List.of(),
            "includedYears", List.of(),
            "excludedWeeklyYears", List.of()
        );
        when(dashboardPersistence.findCashflowCumulativeCloseHead("tenant-frozen", "project-frozen"))
            .thenReturn(closedHead("2026-06"));
        when(dashboardPersistence.findCashflowMonthClose(
            "tenant-frozen", "project-frozen", "2026-06"
        )).thenReturn(monthCloseState(new CashflowMonthCloseResponse(
                true, "cashflowMonth.read", "project-frozen", "2026-06", "CLOSED",
                1, 0, 0,
                0, 0, null, null, null, null, null, false,
                Map.of(),
                "sha256:" + "a".repeat(64), null,
                Map.of("openingBalances", Map.of(
                    "selectedYear", 2026,
                    "projection", emptyMode,
                    "actual", emptyMode
                )),
                Map.of(), true,
                "2026-07-20", "2026-07-10", true,
                "2026-07-10T00:00:00Z", "finance-1", "재무",
                null, null, null, null, null, null, null, "audit-1"
            )));

        CashflowMonthDashboardSourceResponse response = testController(
            dashboardCommandService, new CashflowReadService(dashboardPersistence), false
        ).readCashflowMonthDashboardSource(
            "project-frozen",
            "2026-06",
            "tenant-frozen",
            "viewer-frozen",
            "viewer",
            "viewer@example.com"
        );

        assertThat(response.monthClose().status()).isEqualTo("CLOSED");
        assertThat(response.cashflow()).isNull();
        assertThat(response.openingBalances().selectedYear()).isEqualTo(2026);
        verify(dashboardPersistence, never()).findCashflowLedgerSource(any(), any(), anyInt());
        verify(dashboardPersistence, never()).findCashflowOpeningBalance(any(), any(), anyInt());
    }

    @Test
    void amendedClosedCashflowDashboardUsesCurrentLedgerWithoutReplacingFrozenSnapshot() {
        WeeklyExpenseCommandService dashboardCommandService = mock(WeeklyExpenseCommandService.class);
        WeeklyExpensePersistence dashboardPersistence = mock(WeeklyExpensePersistence.class);
        stubProjectionActualSummary(dashboardCommandService, "project-amended");
        String snapshotHash = "sha256:" + "a".repeat(64);
        String targetRevision = "sha256:" + "c".repeat(64);
        Map<String, Object> emptyMode = Map.of(
            "amount", 0,
            "lineAmounts", Map.of(),
            "sources", List.of(),
            "includedYears", List.of(),
            "excludedWeeklyYears", List.of()
        );
        Map<String, Object> frozenSnapshot = Map.of(
            "openingBalances", Map.of(
                "selectedYear", 2026,
                "projection", emptyMode,
                "actual", emptyMode
            ),
            "ledgerWeeks", List.of()
        );
        when(dashboardPersistence.findCashflowCumulativeCloseHead("tenant-amended", "project-amended"))
            .thenReturn(closedHead("2026-06"));
        when(dashboardPersistence.findCashflowMonthClose(
            "tenant-amended", "project-amended", "2026-06"
        )).thenReturn(monthCloseState(new CashflowMonthCloseResponse(
                true, "cashflowMonth.read", "project-amended", "2026-06", "CLOSED",
                2, 0, 1,
                1, 0, "2026-07-09T00:00:00Z", "finance-2", "보람", "시트 정정", "2026-07-10", false,
                Map.of(
                    "closeRevision", 1,
                    "closeSnapshotHash", snapshotHash,
                    "resultingTargetRevision", targetRevision
                ),
                snapshotHash, null,
                frozenSnapshot,
                Map.of(), true,
                "2026-07-09", "2026-07-10", false,
                "2026-07-08T00:00:00Z", "finance-1", "재무",
                null, null, null, null, null, null, null, "audit-amended"
            )));
        CashflowLedgerSource liveSource =
            new CashflowLedgerSource(
                List.of(),
                List.of(),
                targetRevision
            );
        when(dashboardPersistence.findCashflowGlobalLedgerSource("tenant-amended", "project-amended"))
            .thenReturn(liveSource);
        when(dashboardPersistence.findCashflowOpeningBalance(
            "tenant-amended",
            "project-amended",
            2026
        )).thenReturn(new CashflowOpeningBalance(
            2026,
            new CashflowOpeningBalance.Mode(
                java.math.BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of()
            ),
            new CashflowOpeningBalance.Mode(
                java.math.BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of()
            )
        ));

        CashflowMonthDashboardSourceResponse response = testController(
            dashboardCommandService, new CashflowReadService(dashboardPersistence), false
        ).readCashflowMonthDashboardSource(
            "project-amended",
            "2026-06",
            "tenant-amended",
            "viewer-amended",
            "viewer",
            "viewer@example.com"
        );

        assertThat(response.monthClose().snapshot()).isEqualTo(frozenSnapshot);
        assertThat(response.cashflow()).isNotNull();
        assertThat(response.openingBalances().selectedYear()).isEqualTo(2026);
        assertThat(response.snapshotCompatibility().status()).isEqualTo("LIVE_AMENDED");
        verify(dashboardPersistence, times(2)).findCashflowMonthClose(
            "tenant-amended", "project-amended", "2026-06"
        );
        verify(dashboardPersistence).findCashflowGlobalLedgerSource("tenant-amended", "project-amended");
        verify(dashboardPersistence).findCashflowOpeningBalance(
            "tenant-amended",
            "project-amended",
            2026
        );
    }

    @Test
    void amendedClosedCashflowDashboardFailsAfterTwoEvidenceDrifts() {
        WeeklyExpenseCommandService dashboardCommandService = mock(WeeklyExpenseCommandService.class);
        WeeklyExpensePersistence dashboardPersistence = mock(WeeklyExpensePersistence.class);
        stubProjectionActualSummary(dashboardCommandService, "project-drift");
        String snapshotHash = "sha256:" + "a".repeat(64);
        String targetRevision = "sha256:" + "c".repeat(64);
        Map<String, Object> openingBalances = Map.of(
            "openingBalances", Map.of(
                "selectedYear", 2026,
                "projection", Map.of("amount", 0, "lineAmounts", Map.of(), "sources", List.of(),
                    "includedYears", List.of(), "excludedWeeklyYears", List.of()),
                "actual", Map.of("amount", 0, "lineAmounts", Map.of(), "sources", List.of(),
                    "includedYears", List.of(), "excludedWeeklyYears", List.of())
            ),
            "ledgerWeeks", List.of()
        );
        Map<String, Object> firstEvidence = Map.of(
            "closeRevision", 1,
            "closeSnapshotHash", snapshotHash,
            "resultingTargetRevision", targetRevision
        );
        Map<String, Object> driftedEvidence = Map.of(
            "closeRevision", 2,
            "closeSnapshotHash", snapshotHash,
            "resultingTargetRevision", targetRevision
        );
        CashflowMonthCloseResponse first = new CashflowMonthCloseResponse(
            true, "cashflowMonth.read", "project-drift", "2026-06", "CLOSED",
            2, 0, 1, 1, 0, null, null, null, null, null, false,
            firstEvidence, snapshotHash, null, openingBalances, Map.of(), true,
            "2026-07-09", "2026-07-10", false, null, null, null,
            null, null, null, null, null, null, null, "audit-drift"
        );
        CashflowMonthCloseResponse drifted = new CashflowMonthCloseResponse(
            true, "cashflowMonth.read", "project-drift", "2026-06", "CLOSED",
            2, 0, 1, 1, 0, null, null, null, null, null, false,
            driftedEvidence, snapshotHash, null, openingBalances, Map.of(), true,
            "2026-07-09", "2026-07-10", false, null, null, null,
            null, null, null, null, null, null, null, "audit-drift"
        );
        when(dashboardPersistence.findCashflowCumulativeCloseHead("tenant-drift", "project-drift"))
            .thenReturn(closedHead("2026-06"));
        when(dashboardPersistence.findCashflowMonthClose(
            "tenant-drift", "project-drift", "2026-06"
        )).thenReturn(
            monthCloseState(first), monthCloseState(drifted),
            monthCloseState(first), monthCloseState(drifted)
        );
        when(dashboardPersistence.findCashflowGlobalLedgerSource("tenant-drift", "project-drift"))
            .thenReturn(new CashflowLedgerSource(
                List.of(), List.of(), targetRevision
            ));
        when(dashboardPersistence.findCashflowOpeningBalance(
            "tenant-drift", "project-drift", 2026
        )).thenReturn(new CashflowOpeningBalance(
            2026,
            new CashflowOpeningBalance.Mode(
                java.math.BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of()
            ),
            new CashflowOpeningBalance.Mode(
                java.math.BigDecimal.ZERO, Map.of(), List.of(), List.of(), List.of()
            )
        ));

        WeeklyExpenseController controller = testController(
            dashboardCommandService, new CashflowReadService(dashboardPersistence), false
        );
        assertThatThrownBy(() -> controller.readCashflowMonthDashboardSource(
            "project-drift",
            "2026-06",
            "tenant-drift",
            "viewer-drift",
            "viewer",
            "viewer@example.com"
        )).isInstanceOf(WeeklyExpenseConflictException.class);
        verify(dashboardPersistence, times(4)).findCashflowMonthClose(
            "tenant-drift", "project-drift", "2026-06"
        );
    }

    @Test
    void legacyClosedCashflowDashboardReturnsAvailableEvidenceWithoutReadingLiveLedger() {
        WeeklyExpenseCommandService dashboardCommandService = mock(WeeklyExpenseCommandService.class);
        WeeklyExpensePersistence dashboardPersistence = mock(WeeklyExpensePersistence.class);
        stubProjectionActualSummary(dashboardCommandService, "project-legacy-frozen");
        when(dashboardPersistence.findCashflowCumulativeCloseHead(
            "tenant-frozen", "project-legacy-frozen"
        )).thenReturn(closedHead("2026-06"));
        when(dashboardPersistence.findCashflowMonthClose(
            "tenant-frozen", "project-legacy-frozen", "2026-06"
        )).thenReturn(monthCloseState(new CashflowMonthCloseResponse(
                true, "cashflowMonth.read", "project-legacy-frozen", "2026-06", "CLOSED",
                1, 0, 0,
                0, 0, null, null, null, null, null, false,
                Map.of(),
                "sha256:" + "b".repeat(64), null,
                Map.of("weeklyTotals", List.of()),
                Map.of(), true,
                "2026-07-20", "2026-07-10", true,
                "2026-07-10T00:00:00Z", "finance-1", "재무",
                null, null, null, null, null, null, null, "audit-legacy"
            )));

        CashflowMonthDashboardSourceResponse response = testController(
            dashboardCommandService, new CashflowReadService(dashboardPersistence), false
        ).readCashflowMonthDashboardSource(
            "project-legacy-frozen",
            "2026-06",
            "tenant-frozen",
            "viewer-frozen",
            "viewer",
            "viewer@example.com"
        );

        assertThat(response.monthClose().status()).isEqualTo("CLOSED");
        assertThat(response.cashflow()).isNull();
        assertThat(response.openingBalances()).isNull();
        assertThat(response.snapshotCompatibility().status()).isEqualTo("LEGACY_EVIDENCE_ONLY");
        assertThat(response.snapshotCompatibility().missingEvidence())
            .containsExactly("OPENING_BALANCES", "LEDGER_WEEKS");
        verify(dashboardPersistence, never()).findCashflowLedgerSource(any(), any(), anyInt());
        verify(dashboardPersistence, never()).findCashflowOpeningBalance(any(), any(), anyInt());
    }

    @Test
    void cashflowVarianceRequiresIdempotencyRevisionAndFlagContent() throws Exception {
        String missingRevision = """
            {
              "idempotencyKey": "variance-missing-revision",
              "sheetId": "week-a",
              "action": "FLAG",
              "content": "입금 편차 확인"
            }
            """;
        mockMvc.perform(asActor(
                post("/api/v1/cashflow/project-variance/variance"),
                "tenant-variance",
                "admin-variance",
                "admin"
            )
                .contentType(MediaType.APPLICATION_JSON)
                .content(missingRevision))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_validation_failed"));

        String missingIdempotency = """
            {
              "sheetId": "week-a",
              "expectedRevision": 0,
              "action": "FLAG",
              "content": "입금 편차 확인"
            }
            """;
        mockMvc.perform(asActor(
                post("/api/v1/cashflow/project-variance/variance"),
                "tenant-variance",
                "admin-variance",
                "admin"
            )
                .contentType(MediaType.APPLICATION_JSON)
                .content(missingIdempotency))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_validation_failed"));

        String missingContent = """
            {
              "idempotencyKey": "variance-missing-content",
              "sheetId": "week-a",
              "expectedRevision": 0,
              "action": "FLAG"
            }
            """;
        mockMvc.perform(asActor(
                post("/api/v1/cashflow/project-variance/variance"),
                "tenant-variance",
                "admin-variance",
                "admin"
            )
                .contentType(MediaType.APPLICATION_JSON)
                .content(missingContent))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_bad_request"));
    }

    @Test
    void cashflowMonthCloseRejectsIncompletePayloadBeforePersistence() throws Exception {
        String body = """
            {
              "idempotencyKey": "month-close-incomplete-001",
              "yearMonth": "2026-06",
              "expectedRevision": 0,
              "expectedDraftRevision": 0
            }
            """;

        mockMvc.perform(asActor(
                post("/api/v1/cashflow/project-month-close/month-close"),
                "tenant-month-close",
                "pm-month-close",
                "pm"
            )
                .header("x-edit-finalize", "true")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_validation_failed"));
    }

    @Test
    void cashflowMonthCloseAllowsEveryActiveProjectAccessRole() throws Exception {
        String body = validCashflowMonthCloseBody("month-close-role-001");

        for (String role : List.of("admin", "finance", "pm", "viewer")) {
            mockMvc.perform(asActor(
                    post("/api/v1/cashflow/project-month-close-role/month-close"),
                    "tenant-month-close-role",
                    role + "-month-close",
                    role
                )
                    .header("x-edit-finalize", "true")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(body))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("cashflow_month_close_backend_unavailable"));
        }

    }

    @Test
    void cashflowMonthReopenRequestRequiresReason() throws Exception {
        String body = """
            {
              "idempotencyKey": "month-reopen-request-invalid-001",
              "yearMonth": "2026-06",
              "expectedRevision": 1
            }
            """;

        mockMvc.perform(asActor(
                post("/api/v1/cashflow/project-month-close/month-close/reopen-request"),
                "tenant-month-close",
                "pm-month-close",
                "pm"
            )
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_validation_failed"));
    }

    @Test
    void cashflowMonthReopenRequestCallsTheCanonicalCommandService() throws Exception {
        String body = """
            {
              "idempotencyKey": "month-reopen-request-valid-001",
              "yearMonth": "2026-06",
              "expectedRevision": 1,
              "reason": "증빙 정정 필요"
            }
            """;

        mockMvc.perform(asActor(
                post("/api/v1/cashflow/project-month-close/month-close/reopen-request"),
                "tenant-month-close",
                "pm-month-close",
                "pm"
            )
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("cashflow_data_project_backend_unavailable"));
    }

    @Test
    void cashflowMonthReopenDecisionDelegatesRoleAuthorityToTheCanonicalPermissionGate() throws Exception {
        String invalidDecision = """
            {
              "idempotencyKey": "month-reopen-decision-invalid-001",
              "yearMonth": "2026-06",
              "expectedRevision": 2,
              "decision": "REOPEN"
            }
            """;
        mockMvc.perform(asActor(
                post("/api/v1/cashflow/project-month-close/month-close/reopen-decision"),
                "tenant-month-close",
                "finance-month-close",
                "finance"
            )
                .contentType(MediaType.APPLICATION_JSON)
                .content(invalidDecision))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_validation_failed"));

        String validDecision = """
            {
              "idempotencyKey": "month-reopen-decision-role-001",
              "yearMonth": "2026-06",
              "expectedRevision": 2,
              "decision": "APPROVE",
              "reason": "증빙 확인 완료"
            }
            """;
        mockMvc.perform(asActor(
                post("/api/v1/cashflow/project-month-close/month-close/reopen-decision"),
                "tenant-month-close",
                "finance-month-close",
                "finance"
            )
                .contentType(MediaType.APPLICATION_JSON)
                .content(validDecision))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("cashflow_data_project_backend_unavailable"));

        for (String role : List.of("pm", "viewer", "auditor")) {
            mockMvc.perform(asActor(
                    post("/api/v1/cashflow/project-month-close/month-close/reopen-decision"),
                    "tenant-month-close",
                    role + "-month-close",
                    role
                )
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(validDecision))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("cashflow_data_project_backend_unavailable"));
        }
    }

    @Test
    void cashflowMonthReopenDecisionDoesNotReapplyAGenericRoleListAfterTheCanonicalGate() throws Exception {
        String body = """
            {
              "idempotencyKey": "month-reopen-decision-custom-role-001",
              "yearMonth": "2026-06",
              "expectedRevision": 2,
              "decision": "APPROVE",
              "reason": "조직장 확인 완료"
            }
            """;

        mockMvc.perform(asActor(
                post("/api/v1/cashflow/project-month-close/month-close/reopen-decision"),
                "tenant-month-close",
                "organization-head-month-close",
                "viewer"
            )
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("cashflow_data_project_backend_unavailable"));
    }

    @Test
    void cashflowMonthReopenConflictsExposeAStableOperationCodeAndKoreanActionGuide() {
        ResponseEntity<Map<String, String>> response = controller.cashflowMonthReopenConflict(
            new CashflowMonthReopenPolicy.Violation(
                CashflowMonthReopenPolicy.ViolationReason.REVISION_CHANGED
            )
        );

        assertThat(response.getStatusCode().value()).isEqualTo(409);
        assertThat(response.getBody()).containsEntry(
            "code",
            "cashflow_month_reopen_revision_changed"
        );
        assertThat(response.getBody().get("message"))
            .contains("최신 상태")
            .doesNotContain("revision");
    }

    @Test
    void cashflowMonthReopenDecisionAuthorityRejectsWithAStableForbiddenGuide() {
        ResponseEntity<Map<String, String>> response = controller.cashflowMonthReopenConflict(
            new CashflowMonthReopenPolicy.Violation(
                CashflowMonthReopenPolicy.ViolationReason.DECISION_FORBIDDEN
            )
        );

        assertThat(response.getStatusCode().value()).isEqualTo(403);
        assertThat(response.getBody())
            .containsEntry("code", "cashflow_month_reopen_decision_forbidden")
            .hasEntrySatisfying("message", message -> assertThat(message)
                .asString()
                .contains("활성 조직장", "담당 조직장을 확인"));
    }

    @Test
    void cashflowMonthReopenAuthorityReadUsesTheCanonicalDomainPolicy() throws Exception {
        doAnswer(invocation -> {
            CashflowMonthReopenPort.Actor actor = invocation.getArgument(0);
            String projectId = invocation.getArgument(1);
            boolean runtimeAdmin = actor.id().equals("admin-month-close");
            return new CashflowMonthReopenPolicy.DecisionAuthorityFacts(
                actor.tenantId(), actor.id(), projectId, true, actor.tenantId(), projectId,
                actor.id(), "ACTIVE", runtimeAdmin ? "admin" : "viewer",
                runtimeAdmin ? "another-head" : actor.id(), 1
            );
        }).when(weeklyExpensePersistence).findCashflowMonthReopenDecisionAuthorityFacts(any(), any());

        for (String actorId : List.of("organization-head-month-close", "admin-month-close")) {
            mockMvc.perform(asActor(
                    get("/api/v1/cashflow/project-month-close/month-close/reopen-authority"),
                    "tenant-month-close",
                    actorId,
                    "viewer"
                ))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true))
                .andExpect(jsonPath("$.commandName").value("cashflowMonth.readReopenAuthority"))
                .andExpect(jsonPath("$.projectId").value("project-month-close"))
                .andExpect(jsonPath("$.availability").value("ALLOWED"))
                .andExpect(jsonPath("$.canDecideReopen").value(true));
        }
    }

    @Test
    void cashflowMonthReopenAuthorityReadReturnsStableForbiddenForEveryDomainRejection() throws Exception {
        List<CashflowMonthReopenPolicy.DecisionAuthorityFacts> denied = List.of(
            new CashflowMonthReopenPolicy.DecisionAuthorityFacts(
                "tenant-month-close", "head-month-close", "project-month-close",
                true, "tenant-month-close", "project-month-close",
                "head-month-close", "INACTIVE", "viewer", "head-month-close", 1
            ),
            new CashflowMonthReopenPolicy.DecisionAuthorityFacts(
                "tenant-month-close", "head-month-close", "project-month-close",
                true, "tenant-month-close", "project-month-close",
                "head-month-close", "ACTIVE", "viewer", "another-head", 1
            ),
            new CashflowMonthReopenPolicy.DecisionAuthorityFacts(
                "tenant-month-close", "head-month-close", "project-month-close",
                true, "tenant-month-close", "another-project",
                "head-month-close", "ACTIVE", "viewer", "head-month-close", 1
            )
        );

        for (CashflowMonthReopenPolicy.DecisionAuthorityFacts facts : denied) {
            doReturn(facts).when(weeklyExpensePersistence)
                .findCashflowMonthReopenDecisionAuthorityFacts(any(), any());

            mockMvc.perform(asActor(
                    get("/api/v1/cashflow/project-month-close/month-close/reopen-authority"),
                    "tenant-month-close",
                    "head-month-close",
                    "viewer"
                ))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.availability").value("FORBIDDEN"))
                .andExpect(jsonPath("$.canDecideReopen").value(false))
                .andExpect(jsonPath("$.guide").value(org.hamcrest.Matchers.containsString("활성 조직장")));
        }
    }

    @Test
    void cashflowMonthReopenAuthorityReadDegradesToUnavailableWithoutLeakingStorageErrors() throws Exception {
        doThrow(new CashflowMonthReopenPort.DecisionAuthorityUnavailable(
            new IllegalStateException("Firestore socket credentials raw detail")
        )).when(weeklyExpensePersistence).findCashflowMonthReopenDecisionAuthorityFacts(any(), any());

        mockMvc.perform(asActor(
                get("/api/v1/cashflow/project-month-close/month-close/reopen-authority"),
                "tenant-month-close",
                "head-month-close",
                "viewer"
            ))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.availability").value("UNAVAILABLE"))
            .andExpect(jsonPath("$.canDecideReopen").value(false))
            .andExpect(jsonPath("$.guide").value(org.hamcrest.Matchers.containsString("잠시 후")))
            .andExpect(jsonPath("$.guide").value(org.hamcrest.Matchers.not(
                org.hamcrest.Matchers.containsString("Firestore")
            )));
    }

    @Test
    void cashflowMonthReopenMutationAuthorityUnavailableHasAStableKoreanGuide() {
        ResponseEntity<Map<String, Object>> response = controller.cashflowMonthReopenAuthorityUnavailable();

        assertThat(response.getStatusCode().value()).isEqualTo(503);
        assertThat(response.getBody())
            .containsEntry("code", "cashflow_month_reopen_authority_unavailable")
            .hasEntrySatisfying("message", message -> assertThat(message)
                .asString()
                .contains("잠시 후")
                .doesNotContain("Firestore", "transaction"));
    }

    @Test
    void projectionWriteRejectsViewerRole() throws Exception {
        String body = """
            {
              "idempotencyKey": "projection-viewer",
              "lines": [
                {"yearMonth": "2026-06", "weekNo": 1, "cashflowLine": "사업비", "amount": 3000000}
              ]
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/cashflow/project-auth/projection"), "tenant-auth", "viewer-1", "viewer")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("weekly_expense_forbidden"));
    }

    @Test
    void projectionWriteRejectsMalformedLineBeforePersistence() throws Exception {
        String body = """
            {
              "idempotencyKey": "projection-malformed-001",
              "lines": [
                {"yearMonth": "2026-0X", "weekNo": 1, "cashflowLine": "사업비", "amount": 3000000}
              ]
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/cashflow/project-projection-bounds/projection"), "tenant-projection-bounds", "finance-1", "finance")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_validation_failed"));

        assertThat(projectionRepository.findByTenantIdAndProjectId("tenant-projection-bounds", "project-projection-bounds"))
            .isEmpty();
    }

    @Test
    void projectionWriteRejectsMalformedEditFenceWithStableJsonError() throws Exception {
        String body = """
            {
              "idempotencyKey": "projection-invalid-fence",
              "lines": [
                {"yearMonth": "2026-06", "weekNo": 1, "cashflowLine": "SALES_IN", "amount": 1000}
              ]
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/cashflow/project-projection-fence/projection"), "tenant-projection-fence", "finance-1", "finance")
                .with(request -> {
                    request.removeHeader("x-edit-fence");
                    request.addHeader("x-edit-fence", "not-an-integer");
                    return request;
                })
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_bad_request"))
            .andExpect(jsonPath("$.message").value("x-edit-fence must be a positive integer."));

        mockMvc.perform(asActor(post("/api/v1/cashflow/project-projection-fence/projection"), "tenant-projection-fence", "finance-1", "finance")
                .with(request -> {
                    request.removeHeader("x-edit-fence");
                    request.addHeader("x-edit-fence", "9007199254740992");
                    return request;
                })
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_bad_request"))
            .andExpect(jsonPath("$.message").value("x-edit-fence must be a positive integer."));
    }

    @Test
    void projectionWriteIgnoresCanonicalLegacyFinalizationHeaderAndRejectsInvalidValue() throws Exception {
        String body = """
            {
              "idempotencyKey": "projection-finalize-header",
              "lines": [
                {"yearMonth": "2026-06", "weekNo": 1, "cashflowLine": "SALES_IN", "amount": 1000}
              ]
            }
            """;
        clearInvocations(weeklyExpensePersistence);

        mockMvc.perform(asActor(post("/api/v1/cashflow/project-finalize-header/projection"), "tenant-finalize-header", "finance-1", "finance")
                .header("x-edit-finalize", "true")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk());

        verify(weeklyExpensePersistence).requireCashflowWritePermission(any(), eq("project-finalize-header"));

        mockMvc.perform(asActor(post("/api/v1/cashflow/project-finalize-header-invalid/projection"), "tenant-finalize-header", "finance-1", "finance")
                .header("x-edit-finalize", "yes")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body.replace("projection-finalize-header", "projection-finalize-header-invalid")))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.message").value("x-edit-finalize must be true when present."));
    }

    @Test
    void legacyFinalizationHeaderDoesNotConsumeAnExtraAtomicWrite() throws Exception {
        List<Map<String, Object>> lines = new ArrayList<>();
        for (int index = 0; index < 498; index += 1) {
            lines.add(Map.of(
                "yearMonth", "2026-06",
                "weekNo", 1,
                "cashflowLine", "SALES_IN",
                "amount", index + 1
            ));
        }
        String body = objectMapper.writeValueAsString(Map.of(
            "idempotencyKey", "projection-final-atomic-budget",
            "lines", lines
        ));

        mockMvc.perform(asActor(post("/api/v1/cashflow/project-projection-final-budget/projection"), "tenant-projection-final-budget", "finance-1", "finance")
                .header("x-edit-finalize", "true")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.savedLineCount").value(1));
    }

    @Test
    void projectionWriteRejectsCommandsThatCanExceedFirestoreAtomicWriteBudget() throws Exception {
        List<Map<String, Object>> lines = new ArrayList<>();
        for (int index = 0; index < 499; index += 1) {
            lines.add(Map.of(
                "yearMonth", "2026-06",
                "weekNo", 1,
                "cashflowLine", "SALES_IN",
                "amount", index + 1
            ));
        }
        String body = objectMapper.writeValueAsString(Map.of(
            "idempotencyKey", "projection-over-atomic-budget",
            "lines", lines
        ));

        mockMvc.perform(asActor(post("/api/v1/cashflow/project-projection-budget/projection"), "tenant-projection-budget", "finance-1", "finance")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isUnprocessableEntity())
            .andExpect(jsonPath("$.code").value("atomic_write_limit_exceeded"))
            .andExpect(jsonPath("$.expectedWriteCount").value(501));

        assertThat(projectionRepository.findByTenantIdAndProjectId("tenant-projection-budget", "project-projection-budget"))
            .isEmpty();
    }

    @Test
    void submitAndCloseRejectMalformedYearMonthBeforePersistence() throws Exception {
        String submitBody = """
            {
              "idempotencyKey": "submit-malformed-month-001",
              "yearMonth": "2026-0X",
              "weekNo": 1
            }
            """;
        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-status-bounds/submit"), "tenant-status-bounds", "pm-1", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(submitBody))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_validation_failed"));

        String closeBody = """
            {
              "idempotencyKey": "close-malformed-month-001",
              "yearMonth": "2026-0X",
              "weekNo": 1
            }
            """;
        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-status-bounds/close"), "tenant-status-bounds", "finance-1", "finance")
                .contentType(MediaType.APPLICATION_JSON)
                .content(closeBody))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_validation_failed"));
    }

    @Test
    void auditExportRejectsOversizedIdempotencyKeyBeforePersistence() throws Exception {
        String oversizedKey = "x".repeat(WeeklyExpenseRequestLimits.MAX_IDEMPOTENCY_KEY_LENGTH + 1);
        String body = """
            {
              "idempotencyKey": "%s",
              "format": "CSV",
              "includeAuditSummary": true
            }
            """.formatted(oversizedKey);

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-export-bounds/audit-export"), "tenant-export-bounds", "finance-1", "finance")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_validation_failed"));
    }

    @Test
    void commandBodyRejectsClientSuppliedActorAndTenantFields() throws Exception {
        String body = """
            {
              "tenantId": "spoofed-tenant",
              "idempotencyKey": "spoofed-body-001",
              "actor": {"id": "spoofed-admin", "role": "admin"},
              "rows": []
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-spoof/sheets/default/save-draft"), "tenant-spoof", "pm-1", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_invalid_json"));
    }

    @Test
    void writeCommandsRejectOffSchemaCellsAndNonRectangularPasteBeforeOrmPersistence() throws Exception {
        String offSchemaSave = """
            {
              "idempotencyKey": "off-schema-save-001",
              "sheetName": "기본 탭",
              "rows": [
                {
                  "rowIndex": 0,
                  "entryKind": "manual",
                  "cells": [
                    {"columnIndex": 20, "rawValue": "outside schema", "userEdited": true}
                  ]
                }
              ]
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-bounds/sheets/default/save-draft"), "tenant-bounds", "pm-bounds", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(offSchemaSave))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_validation_failed"));

        String sparsePaste = """
            {
              "idempotencyKey": "sparse-paste-001",
              "anchorRow": 0,
              "anchorColumn": 0,
              "rowCount": 1,
              "columnCount": 2,
              "depth": "SHALLOW",
              "cells": [
                {"relativeRow": 0, "relativeColumn": 0, "rawValue": "2026-06-W1"}
              ]
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-bounds/sheets/default/commands/paste"), "tenant-bounds", "pm-bounds", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(sparsePaste))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_bad_request"));

        String overflowInsert = """
            {
              "idempotencyKey": "overflow-insert-001",
              "startRow": 1999,
              "rowCount": 2
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-bounds/sheets/default/commands/row-insert"), "tenant-bounds", "pm-bounds", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(overflowInsert))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_bad_request"));

        assertThat(sheetRepository.findByTenantIdAndProjectIdAndSheetKey("tenant-bounds", "project-bounds", "default"))
            .isEmpty();

        String sparseHighRow = """
            {
              "idempotencyKey": "sparse-high-row-001",
              "sheetName": "기본 탭",
              "rows": [
                {
                  "rowIndex": 1999,
                  "entryKind": "manual",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true}
                  ]
                }
              ]
            }
            """;
        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-row-overflow/sheets/default/save-draft"), "tenant-row-overflow", "pm-bounds", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(sparseHighRow))
            .andExpect(status().isOk());

        long sparseVersion = sheetRepository
            .findByTenantIdAndProjectIdAndSheetKey("tenant-row-overflow", "project-row-overflow", "default")
            .orElseThrow()
            .getSheetVersion();
        String sparseOverflowInsert = """
            {
              "idempotencyKey": "sparse-overflow-insert-001",
              "expectedSheetVersion": %d,
              "startRow": 1990,
              "rowCount": 10
            }
            """.formatted(sparseVersion);

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-row-overflow/sheets/default/commands/row-insert"), "tenant-row-overflow", "pm-bounds", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(sparseOverflowInsert))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("weekly_expense_bad_request"));
    }

    private static Map<String, Object> bankImportLine(int lineIndex, String sourceLineKey, List<String> rawCells) {
        return Map.of(
            "lineIndex", lineIndex,
            "sourceLineKey", sourceLineKey,
            "transactionDate", "2026-06-01",
            "counterparty", "validation-target",
            "memo", "oversized boundary test",
            "signedAmount", -1,
            "balanceAfter", 0,
            "rawCells", rawCells
        );
    }

    private String validCashflowMonthCloseBody(String idempotencyKey) throws Exception {
        List<Map<String, Object>> cells = new ArrayList<>();
        List<Map<String, Object>> confirmations = new ArrayList<>();
        List<Map<String, Object>> depositScheduleRows = new ArrayList<>();
        for (int weekNo = 1; weekNo <= CashflowSheetLabApplyRequest.FINANCE_WEEK_COUNT; weekNo += 1) {
            depositScheduleRows.add(Map.of(
                "weekNo", weekNo,
                "taxInvoiceIssuedDate", "",
                "expectedDepositDate", "",
                "actualDepositDate", "",
                "actualSource", "NOT_APPLICABLE",
                "decision", "NOT_APPLICABLE"
            ));
        }
        for (int weekNo = 1; weekNo <= CashflowSheetLabApplyRequest.FINANCE_WEEK_COUNT; weekNo += 1) {
            for (String mode : List.of("projection", "actual")) {
                for (String cashflowLine : CashflowLineCatalog.ALL_LINES) {
                    cells.add(Map.of(
                        "mode", mode,
                        "weekNo", weekNo,
                        "cashflowLine", cashflowLine,
                        "cellState", "EMPTY"
                    ));
                    confirmations.add(Map.of(
                        "mode", mode,
                        "weekNo", weekNo,
                        "cashflowLine", cashflowLine,
                        "decision", "NOT_APPLICABLE"
                    ));
                }
            }
        }
        List<Map<String, Object>> managementChecks = List.of(
            Map.of("id", "labor-transfer", "status", "OK", "title", "인건비", "detail", "확인"),
            Map.of("id", "profit-vat-after-deposit", "status", "OK", "title", "수익·부가세", "detail", "확인"),
            Map.of("id", "negative-projection-balance", "status", "OK", "title", "Projection 잔액", "detail", "확인"),
            Map.of("id", "future-prepay-over-million", "status", "OK", "title", "선입금", "detail", "확인")
        );
        List<Map<String, Object>> managementConfirmations = managementChecks.stream()
            .map(check -> Map.<String, Object>of("checkId", check.get("id"), "decision", "CONFIRMED"))
            .toList();
        return objectMapper.writeValueAsString(Map.ofEntries(
            Map.entry("idempotencyKey", idempotencyKey),
            Map.entry("sourceRevision", "sha256:" + "a".repeat(64)),
            Map.entry("targetRevision", "sha256:" + "b".repeat(64)),
            Map.entry("yearMonth", "2026-06"),
            Map.entry("expectedRevision", 0),
            Map.entry("expectedDraftRevision", 0),
            Map.entry("depositScheduleRows", depositScheduleRows),
            Map.entry("cells", cells),
            Map.entry("confirmations", confirmations),
            Map.entry("managementChecks", managementChecks),
            Map.entry("managementConfirmations", managementConfirmations),
            Map.entry("openingBalances", Map.of(
                "selectedYear", 2026,
                "projection", Map.of("amount", 0, "lineAmounts", Map.of(), "sources", List.of(), "includedYears", List.of(), "excludedWeeklyYears", List.of()),
                "actual", Map.of("amount", 0, "lineAmounts", Map.of(), "sources", List.of(), "includedYears", List.of(), "excludedWeeklyYears", List.of())
            )),
            Map.entry("deadlineSummary", Map.of("trackingStartedAt", "", "missedCount", 0, "completedCount", 0))
        ));
    }

    @Test
    void patchPasteAndCutCellsAreAuditedBackendCommands() throws Exception {
        String patch = """
            {
              "idempotencyKey": "patch-001",
              "sheetName": "기본 탭",
              "cells": [
                {"rowIndex": 0, "columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true},
                {"rowIndex": 0, "columnIndex": 8, "rawValue": "사업비", "userEdited": true},
                {"rowIndex": 0, "columnIndex": 13, "rawValue": "1000", "userEdited": true}
              ]
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-cells/sheets/default/commands/cell-patch"), "tenant-cells", "pm-cells", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(patch))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.cell.patch"))
            .andExpect(jsonPath("$.touchedCellCount").value(3))
            .andExpect(jsonPath("$.actualDelta[0].amount").value(1000));

        long versionAfterPatch = sheetRepository
            .findByTenantIdAndProjectIdAndSheetKey("tenant-cells", "project-cells", "default")
            .orElseThrow()
            .getSheetVersion();

        String copy = """
            {
              "idempotencyKey": "copy-001",
              "expectedSheetVersion": %d,
              "startRow": 0,
              "startColumn": 3,
              "endRow": 0,
              "endColumn": 13,
              "depth": "DEEP"
            }
            """.formatted(versionAfterPatch);

        String copyResponse = mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-cells/sheets/default/commands/copy"), "tenant-cells", "pm-cells", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(copy))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.cells.copy"))
            .andExpect(jsonPath("$.touchedCellCount").value(11))
            .andExpect(jsonPath("$.actualDelta").isEmpty())
            .andExpect(jsonPath("$.clipboard.operationType").value("COPY"))
            .andExpect(jsonPath("$.clipboard.depth").value("DEEP"))
            .andExpect(jsonPath("$.clipboard.rowCount").value(1))
            .andExpect(jsonPath("$.clipboard.columnCount").value(11))
            .andExpect(jsonPath("$.clipboard.cells[0].relativeRow").value(0))
            .andExpect(jsonPath("$.clipboard.cells[0].relativeColumn").value(0))
            .andReturn()
            .getResponse()
            .getContentAsString();

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-cells/sheets/default/commands/copy"), "tenant-cells", "pm-cells", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(copy))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.auditId").value(objectMapper.readTree(copyResponse).get("auditId").asText()));

        long versionAfterCopy = sheetRepository
            .findByTenantIdAndProjectIdAndSheetKey("tenant-cells", "project-cells", "default")
            .orElseThrow()
            .getSheetVersion();
        assertThat(versionAfterCopy).isEqualTo(versionAfterPatch);

        String paste = """
            {
              "idempotencyKey": "paste-001",
              "expectedSheetVersion": %d,
              "anchorRow": 1,
              "anchorColumn": 3,
              "rowCount": 1,
              "columnCount": 11,
              "depth": "SHALLOW",
              "cells": [
                {"relativeRow": 0, "relativeColumn": 0, "rawValue": "2026-06-W1"},
                {"relativeRow": 0, "relativeColumn": 1, "rawValue": ""},
                {"relativeRow": 0, "relativeColumn": 2, "rawValue": ""},
                {"relativeRow": 0, "relativeColumn": 3, "rawValue": ""},
                {"relativeRow": 0, "relativeColumn": 4, "rawValue": ""},
                {"relativeRow": 0, "relativeColumn": 5, "rawValue": "사업비"},
                {"relativeRow": 0, "relativeColumn": 6, "rawValue": ""},
                {"relativeRow": 0, "relativeColumn": 7, "rawValue": ""},
                {"relativeRow": 0, "relativeColumn": 8, "rawValue": ""},
                {"relativeRow": 0, "relativeColumn": 9, "rawValue": ""},
                {"relativeRow": 0, "relativeColumn": 10, "rawValue": "2000"}
              ]
            }
            """.formatted(versionAfterCopy);

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-cells/sheets/default/commands/paste"), "tenant-cells", "pm-cells", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(paste))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.cells.paste"))
            .andExpect(jsonPath("$.touchedCellCount").value(11))
            .andExpect(jsonPath("$.actualDelta[0].amount").value(3000));

        long versionAfterPaste = sheetRepository
            .findByTenantIdAndProjectIdAndSheetKey("tenant-cells", "project-cells", "default")
            .orElseThrow()
            .getSheetVersion();

        String cut = """
            {
              "idempotencyKey": "cut-001",
              "expectedSheetVersion": %d,
              "startRow": 1,
              "startColumn": 13,
              "endRow": 1,
              "endColumn": 13,
              "depth": "SHALLOW"
            }
            """.formatted(versionAfterPaste);

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-cells/sheets/default/commands/cut"), "tenant-cells", "pm-cells", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(cut))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.cells.cut"))
            .andExpect(jsonPath("$.clipboard.operationType").value("CUT"))
            .andExpect(jsonPath("$.actualDelta[0].amount").value(1000));
    }

    @Test
    void rowInsertAndDeleteAreAuditedBackendCommandsWithVersionChecks() throws Exception {
        String patch = """
            {
              "idempotencyKey": "rows-patch-001",
              "sheetName": "기본 탭",
              "cells": [
                {"rowIndex": 0, "columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true},
                {"rowIndex": 0, "columnIndex": 8, "rawValue": "사업비", "userEdited": true},
                {"rowIndex": 0, "columnIndex": 13, "rawValue": "1000", "userEdited": true}
              ]
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-rows/sheets/default/commands/cell-patch"), "tenant-rows", "pm-rows", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(patch))
            .andExpect(status().isOk());

        long versionAfterPatch = sheetRepository
            .findByTenantIdAndProjectIdAndSheetKey("tenant-rows", "project-rows", "default")
            .orElseThrow()
            .getSheetVersion();

        String insert = """
            {
              "idempotencyKey": "row-insert-001",
              "expectedSheetVersion": %d,
              "sheetName": "기본 탭",
              "startRow": 0,
              "rowCount": 1
            }
            """.formatted(versionAfterPatch);

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-rows/sheets/default/commands/row-insert"), "tenant-rows", "pm-rows", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(insert))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.row.insert"))
            .andExpect(jsonPath("$.affectedRowCount").value(1))
            .andExpect(jsonPath("$.rowVersions[0].rowIndex").value(0))
            .andExpect(jsonPath("$.rowVersions[0].rowVersion").isNumber())
            .andExpect(jsonPath("$.actualDelta[0].amount").value(1000));

        var sheet = sheetRepository.findWithRowsByTenantIdAndProjectIdAndSheetKey("tenant-rows", "project-rows", "default")
            .orElseThrow();
        long shiftedRowVersion = sheet.findRow(1).orElseThrow().getRowVersion();

        String deleteWithoutVersion = """
            {
              "idempotencyKey": "row-delete-missing-version",
              "startRow": 1,
              "rowCount": 1
            }
            """;

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-rows/sheets/default/commands/row-delete"), "tenant-rows", "pm-rows", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(deleteWithoutVersion))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("weekly_expense_conflict"));

        String delete = """
            {
              "idempotencyKey": "row-delete-001",
              "expectedSheetVersion": %d,
              "startRow": 1,
              "rowCount": 1,
              "expectedRowVersions": [
                {"rowIndex": 1, "rowVersion": %d}
              ]
            }
            """.formatted(sheet.getSheetVersion(), shiftedRowVersion);

        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-rows/sheets/default/commands/row-delete"), "tenant-rows", "pm-rows", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(delete))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.row.delete"))
            .andExpect(jsonPath("$.affectedRowCount").value(1));
    }

    @Test
    void auditExportCreatesHashAddressedCsvFromProjectionActualAndAuditSummary() throws Exception {
        String projection = """
            {
              "idempotencyKey": "export-projection-001",
              "lines": [
                {"yearMonth": "2026-06", "weekNo": 1, "cashflowLine": "사업비", "amount": 3000000}
              ]
            }
            """;
        mockMvc.perform(asActor(post("/api/v1/cashflow/project-export/projection"), "tenant-export", "finance-export", "finance")
                .contentType(MediaType.APPLICATION_JSON)
                .content(projection))
            .andExpect(status().isOk());

        String actual = """
            {
              "idempotencyKey": "export-actual-001",
              "sheetName": "기본 탭",
              "rows": [
                {
                  "rowIndex": 0,
                  "entryKind": "manual",
                  "cells": [
                    {"columnIndex": 3, "rawValue": "2026-06-W1", "userEdited": true},
                    {"columnIndex": 8, "rawValue": "사업비", "userEdited": true},
                    {"columnIndex": 13, "rawValue": "1200000", "userEdited": true}
                  ]
                }
              ]
            }
            """;
        mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-export/sheets/default/save-draft"), "tenant-export", "pm-export", "pm")
                .contentType(MediaType.APPLICATION_JSON)
                .content(actual))
            .andExpect(status().isOk());

        String exportBody = """
            {
              "idempotencyKey": "audit-export-001",
              "format": "CSV",
              "includeAuditSummary": true
            }
            """;

        String response = mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-export/audit-export"), "tenant-export", "finance-export", "finance")
                .contentType(MediaType.APPLICATION_JSON)
                .content(exportBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.commandName").value("weeklyExpense.auditExport.create"))
            .andExpect(jsonPath("$.artifactType").value("CSV"))
            .andExpect(jsonPath("$.fileName").value("project-export-weekly-expense-audit.csv"))
            .andExpect(jsonPath("$.projectionLineCount").value(1))
            .andExpect(jsonPath("$.actualLineCount").value(1))
            .andExpect(jsonPath("$.auditEventCount").value(2))
            .andReturn()
            .getResponse()
            .getContentAsString();

        JsonNode json = objectMapper.readTree(response);
        assertThat(json.get("sha256").asText()).hasSize(64);
        assertThat(json.get("content").asText())
            .contains("PROJECTION,project-export,2026-06,1,,DIRECT_COST_OUT,3000000")
            .contains("ACTUAL,project-export,2026-06,1,default,DIRECT_COST_OUT,1200000")
            .contains("AUDIT_SUMMARY,project-export")
            .doesNotContain("사업비,3000000")
            .doesNotContain("사업비,1200000");
        assertThat(auditExportRepository.findById(json.get("artifactId").asText())).isPresent();
        assertThat(auditEventRepository.findAll().stream()
            .anyMatch(event -> "weeklyExpense.auditExport.create".equals(event.getCommandName()))).isTrue();
    }

    @Test
    void auditExportPrefixesFormulaLikeCsvCellsBeforeExternalOutput() throws Exception {
        String projection = """
            {
              "idempotencyKey": "formula-projection-001",
              "lines": [
                {"yearMonth": "2026-06", "weekNo": 1, "cashflowLine": "SALES_IN", "amount": 1000}
              ]
            }
            """;
        mockMvc.perform(asActor(post("/api/v1/cashflow/project-formula-export/projection"), "tenant-formula-export", "finance-formula", "finance")
                .header("x-actor-name", "=HYPERLINK(\"https://example.com\")")
                .contentType(MediaType.APPLICATION_JSON)
                .content(projection))
            .andExpect(status().isOk());

        String exportBody = """
            {
              "idempotencyKey": "formula-audit-export-001",
              "format": "CSV",
              "includeAuditSummary": true
            }
            """;

        String response = mockMvc.perform(asActor(post("/api/v1/weekly-expenses/project-formula-export/audit-export"), "tenant-formula-export", "finance-formula", "finance")
                .contentType(MediaType.APPLICATION_JSON)
                .content(exportBody))
            .andExpect(status().isOk())
            .andReturn()
            .getResponse()
            .getContentAsString();

        String content = objectMapper.readTree(response).get("content").asText();
        assertThat(content).contains(",\"'=HYPERLINK(\"\"https://example.com\"\")\"");
        assertThat(content).doesNotContain(",=HYPERLINK(");
    }

    private static String cellValue(JsonNode cells, int columnIndex) {
        for (JsonNode cell : cells) {
            if (cell.get("columnIndex").asInt() == columnIndex) {
                return cell.get("normalizedValue").asText();
            }
        }
        return "";
    }

    private static void stubProjectionActualSummary(
        WeeklyExpenseCommandService service,
        String projectId
    ) {
        when(service.readCashflowProjectionActualSummaries(
            any(), any(CashflowProjectionActualSummaryBatchRequest.class)
        )).thenReturn(new CashflowProjectionActualSummaryBatchResponse("1", List.of(
            new CashflowProjectionActualSummaryBatchResponse.Item(
                projectId, "2023-01",
                new CashflowProjectionActualSummaryBatchResponse.ComparisonAsOfWeek("2026-07", 5),
                java.math.BigDecimal.ZERO, true
            )
        )));
    }

    private static WeeklyExpenseController testController(
        WeeklyExpenseCommandService commandService,
        CashflowReadService readService,
        boolean legacyWeekCloseEnabled
    ) {
        return new WeeklyExpenseController(
            commandService,
            readService,
            new CashflowMonthDashboardQueryService(
                readService,
                new CashflowDashboardSectionQueryService()
            ),
            legacyWeekCloseEnabled
        );
    }

    private static CashflowMonthCloseState monthCloseState(CashflowMonthCloseResponse response) {
        return new CashflowMonthCloseState(
            response.projectId(), response.yearMonth(), response.status(), response.revision(),
            response.reopenCount(), response.projectWarningCount(), response.amendmentCount(),
            response.postDeadlineAmendmentWarningCount(), response.lastAmendmentAt(),
            response.lastAmendmentByUid(), response.lastAmendmentByName(), response.lastAmendmentReason(),
            response.lastAmendmentDeadline(), response.lastAmendmentPostDeadline(),
            response.lastAmendmentEvidence(), response.snapshotHash(), response.previousSnapshotHash(),
            response.snapshot(), response.previousSnapshot(), response.closeEligible(),
            response.evaluatedBusinessDate(), response.closeDeadline(), response.late(),
            response.closedAt(), response.closedByUid(), response.closedByName(), response.reopenReason(),
            response.reopenRequestedAt(), response.reopenRequestedByUid(), response.reopenDecision(),
            response.reopenDecisionReason(), response.reopenDecidedAt(), response.reopenDecidedByUid(), false
        );
    }

    private static CashflowCumulativeCloseHead closedHead(String closedThrough) {
        return new CashflowCumulativeCloseHead(
            "CLOSED", "2023-01", java.time.YearMonth.parse(closedThrough).plusMonths(1).toString(),
            closedThrough, "sha256:" + "f".repeat(64), 1
        );
    }
}
