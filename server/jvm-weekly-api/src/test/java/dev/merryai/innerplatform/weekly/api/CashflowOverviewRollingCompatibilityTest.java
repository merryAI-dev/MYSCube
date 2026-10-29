package dev.merryai.innerplatform.weekly.api;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.merryai.innerplatform.weekly.domain.CashflowLedgerSource;
import dev.merryai.innerplatform.weekly.domain.CashflowSettlementCyclePolicy;
import dev.merryai.innerplatform.weekly.service.WeeklyExpenseAuthorizationService;
import dev.merryai.innerplatform.weekly.service.WeeklyExpenseCommandService;
import dev.merryai.innerplatform.weekly.storage.WeeklyExpensePersistence;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.validation.beanvalidation.LocalValidatorFactoryBean;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Also run unchanged against aa1b2a058 with -Dcashflow.oldJvm=true (real old controller/service sources). */
class CashflowOverviewRollingCompatibilityTest {
    private static final boolean OLD_JVM = Boolean.getBoolean("cashflow.oldJvm");
    private static final String PATH = "/api/v1/cashflow/weekly-overview";
    private final ObjectMapper mapper = new ObjectMapper().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    private WeeklyExpensePersistence persistence;
    private WeeklyExpenseAuthorizationService authorization;
    private MockMvc http;

    @BeforeEach
    void setup() {
        persistence = mock(WeeklyExpensePersistence.class);
        authorization = mock(WeeklyExpenseAuthorizationService.class);
        var service = new WeeklyExpenseCommandService(persistence, authorization, mapper, false, "live");
        var validator = new LocalValidatorFactoryBean();
        validator.afterPropertiesSet();
        http = MockMvcBuilders.standaloneSetup(new WeeklyExpenseController(service, null, null, false))
            .setMessageConverters(new MappingJackson2HttpMessageConverter(mapper))
            .setValidator(validator).build();
        when(persistence.findCashflowLedgerSources(anyString(), anyList(), anyString(), anyString()))
            .thenReturn(Map.of("project-a", new CashflowLedgerSource(List.of(), List.of())));
        when(persistence.findCashflowSettlementStatusesBatch(anyString(), anyList(), anyString()))
            .thenReturn(Map.of("project-a", List.of()));
        when(persistence.findCashflowSettlementCyclesBatch(any(), anyList(), anyString(), anyString()))
            .thenReturn(Map.of("project-a", new WeeklyExpensePersistence.CashflowSettlementCycleRecord(
                "project-a", "2026-09", "2026-08", List.of(), null,
                new CashflowSettlementCyclePolicy.Projection(CashflowSettlementCyclePolicy.BusinessState.NOT_REQUESTED,
                    CashflowSettlementCyclePolicy.Health.OK, 0, null, ""),
                new WeeklyExpensePersistence.CashflowSettlementCycleAuthority(false, false, false, false, false)
            )));
    }

    private String body(boolean canonical) throws Exception {
        return mapper.writeValueAsString(Map.of("projectIds", List.of("project-a"),
            "yearMonth", "2026-09", "settlementCycle", canonical));
    }

    private JsonNode read(String query, String body, int expectedStatus) throws Exception {
        String json = http.perform(post(PATH + query)
                .header("x-tenant-id", "demo-compat")
                .header("x-actor-id", "viewer")
                .header("x-actor-role", "viewer")
                .header("x-actor-email", "viewer@example.com")
                .contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().is(expectedStatus)).andReturn().getResponse().getContentAsString();
        return json.isEmpty() ? mapper.nullNode() : mapper.readTree(json);
    }

    @Test
    void oldAndNewBffRequestsAndRollbackKeepStatusesAndOnlyOptionallySkipLedger() throws Exception {
        for (boolean canonical : List.of(false, true)) {
            clearInvocations(persistence, authorization);
            JsonNode original = read("", body(canonical), 200);
            assertThat(original.path("items").get(0).path("projectionActualSummary").isObject()).isTrue();
            verify(persistence).findCashflowLedgerSources(anyString(), anyList(), anyString(), anyString());
            clearInvocations(persistence, authorization);

            JsonNode optimized = read("?omitProjectionActualSummary=true", body(canonical), 200);
            assertThat(optimized.path("items").get(0).path("projectionActualSummary").isNull()).isEqualTo(!OLD_JVM);
            verify(persistence, times(OLD_JVM ? 1 : 0))
                .findCashflowLedgerSources(anyString(), anyList(), anyString(), anyString());
            verify(authorization).requireProjectsAllowedForCommands(anyList(), any(), eq(List.of("project-a")));
            ObjectNode comparable = optimized.deepCopy();
            ((ObjectNode) comparable.path("items").get(0)).set("projectionActualSummary",
                original.path("items").get(0).path("projectionActualSummary"));
            assertThat(comparable).isEqualTo(original);

            clearInvocations(persistence);
            assertThat(read("?omitProjectionActualSummary=false", body(canonical), 200)).isEqualTo(original);
            assertThat(read("", body(canonical), 200)).isEqualTo(original);
            verify(persistence, times(2)).findCashflowLedgerSources(anyString(), anyList(), anyString(), anyString());
        }
    }

    @Test
    void rejectsUnknownJsonWithOrWithoutTheCompatibleQuery() throws Exception {
        for (String query : List.of("", "?omitProjectionActualSummary=true")) {
            ObjectNode invalid = (ObjectNode) mapper.readTree(body(true));
            invalid.put("omitProjectionActualSummary", true);
            read(query, mapper.writeValueAsString(invalid), 400);
        }
        verifyNoInteractions(persistence, authorization);
    }

    @Test
    void validatesTheOriginalBodyBeforeAnyReads() throws Exception {
        read("?omitProjectionActualSummary=true", "{\"projectIds\":[],\"yearMonth\":\"bad\"}", 400);
        verifyNoInteractions(persistence, authorization);
    }

    @Test
    void newServerRejectsMalformedBooleanAndOldServerIgnoresUnknownQuery() throws Exception {
        read("?omitProjectionActualSummary=invalid", body(true), OLD_JVM ? 200 : 400);
        if (!OLD_JVM) verifyNoInteractions(persistence, authorization);
    }

    @Test
    void queryDoesNotBypassServiceAuthorization() throws Exception {
        doThrow(new WeeklyExpenseForbiddenException("denied"))
            .when(authorization).requireProjectsAllowedForCommands(anyList(), any(), anyList());
        for (String query : List.of("", "?omitProjectionActualSummary=true")) {
            read(query, body(true), 403);
        }
        verifyNoInteractions(persistence);
    }
}
