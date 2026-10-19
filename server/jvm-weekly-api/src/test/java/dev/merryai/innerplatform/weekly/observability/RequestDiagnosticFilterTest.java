package dev.merryai.innerplatform.weekly.observability;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.merryai.innerplatform.weekly.api.WeeklyExpenseController;
import dev.merryai.innerplatform.weekly.api.InternalServiceTokenFilter;
import dev.merryai.innerplatform.weekly.api.FirebaseBearerTokenVerifier;
import dev.merryai.innerplatform.weekly.service.WeeklyExpenseCommandService;
import dev.merryai.innerplatform.weekly.service.CashflowReadService;
import dev.merryai.innerplatform.weekly.service.query.CashflowMonthDashboardQueryService;
import jakarta.servlet.DispatcherType;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.any;

class RequestDiagnosticFilterTest {
    private static final String ID = "req_1791793250998_771bcc3564ab4f4a";
    private final ObjectMapper json = new ObjectMapper();
    private final List<String> lines = new ArrayList<>();
    private RequestDiagnosticFilter filter() { return new RequestDiagnosticFilter(json, lines::add); }
    private JsonNode last() throws Exception { return json.readTree(lines.getLast()); }
    private WeeklyExpenseController controller(WeeklyExpenseCommandService commands) {
        return new WeeklyExpenseController(commands, mock(CashflowReadService.class),
            mock(CashflowMonthDashboardQueryService.class), false);
    }

    @Test
    void actualOverviewControllerRecordsTemplateAndCorrelatesWithoutReadingBody() throws Exception {
        var commands = mock(WeeklyExpenseCommandService.class);
        var mvc = MockMvcBuilders.standaloneSetup(controller(commands)).addFilters(filter()).build();
        mvc.perform(post("/api/v1/cashflow/weekly-overview?secret=QUERY_CANARY")
            .header("x-request-id", ID).header("x-tenant-id", "mysc")
            .header("x-actor-id", "ACTOR_CANARY").header("x-actor-role", "admin")
            .contentType("application/json")
            .content("{\"projectIds\":[\"BODY_CANARY\"],\"yearMonth\":\"2026-10\"}"))
            .andExpect(status().isOk());
        verify(commands).readCashflowWeeklyOverview(any(), any());
        assertThat(lines).hasSize(2);
        assertThat(json.readTree(lines.getFirst()).get("request_id").asText()).isEqualTo(ID);
        assertThat(last().get("request_id").asText()).isEqualTo(ID);
        assertThat(last().get("invocation_id")).isEqualTo(json.readTree(lines.getFirst()).get("invocation_id"));
        assertThat(last().get("route_template").asText()).isEqualTo("/api/v1/cashflow/weekly-overview");
        assertThat(last().get("http_status").asInt()).isEqualTo(200);
        assertThat(last().get("status_final").asBoolean()).isTrue();
        assertThat(String.join("", lines)).doesNotContain("CANARY");
    }

    @Test
    void reusedCorrelationIdsStillHaveDistinctServerInvocations() throws Exception {
        var filter = filter();
        for (int i = 0; i < 2; i++) {
            var request = new MockHttpServletRequest();request.setMethod("POST");request.addHeader("x-request-id", ID);
            filter.doFilter(request, new MockHttpServletResponse(), (req,res) -> {});
        }
        assertThat(lines).hasSize(4);
        assertThat(json.readTree(lines.get(1)).get("invocation_id")).isNotEqualTo(last().get("invocation_id"));
        assertThat(json.readTree(lines.get(1)).get("request_id")).isEqualTo(last().get("request_id"));
    }

    @Test
    void existingMcpUuidRequestIdentifiersRemainCorrelatable() throws Exception {
        String id = "1088140f-994d-445c-8f72-50de1c76f4ee";
        var request = new MockHttpServletRequest();request.setMethod("POST");request.addHeader("x-request-id", id);
        filter().doFilter(request, new MockHttpServletResponse(), (req,res) -> {});
        assertThat(last().get("request_id").asText()).isEqualTo(id);
        assertThat(last().get("request_id_source").asText()).isEqualTo("supplied_header");
        assertThat(last().get("correlation_scope").asText()).isEqualTo("request_id_only_not_actor_authorization");
    }

    @Test
    void authenticationRejectionAndUnmatchedUriNeverExposeRequestMaterial() throws Exception {
        var verifier = mock(FirebaseBearerTokenVerifier.class);
        when(verifier.verify("")).thenThrow(new IllegalArgumentException("AUTH_CANARY"));
        var auth = new InternalServiceTokenFilter(false, "", "", "strict", "mysc.co.kr", verifier, null);
        var mvc = MockMvcBuilders.standaloneSetup(controller(mock(WeeklyExpenseCommandService.class)))
            .addFilters(filter(), auth).build();
        mvc.perform(get("/api/v1/PRIVATE_URI_CANARY")).andExpect(status().isUnauthorized());
        assertThat(last().get("http_status").asInt()).isEqualTo(401);
        assertThat(last().get("route_template").isNull()).isTrue();
        lines.clear();
        MockMvcBuilders.standaloneSetup(controller(mock(WeeklyExpenseCommandService.class)))
            .addFilters(filter()).build().perform(get("/PRIVATE_URI_CANARY")).andExpect(status().isNotFound());
        assertThat(last().get("http_status").asInt()).isEqualTo(404);
        assertThat(last().get("route_template").isNull()).isTrue();
        assertThat(String.join("", lines)).doesNotContain("CANARY");
    }

    @Test
    void duplicateAndInvalidHeadersGenerateIdentifiersAndPreserveForbiddenResponse() throws Exception {
        for (String invalid : List.of("invalid\nHEADER_CANARY", ID)) {
            lines.clear();var request = new MockHttpServletRequest();request.setMethod("POST");
            request.addHeader("x-request-id", invalid);
            if (invalid.equals(ID)) request.addHeader("x-request-id", ID);
            var response = new MockHttpServletResponse();
            filter().doFilter(request, response, (req, res) -> {response.setStatus(403);response.getWriter().write("unchanged");});
            assertThat(last().get("request_id").asText()).startsWith("jvm_");
            assertThat(last().get("http_status").asInt()).isEqualTo(403);
            assertThat(response.getContentAsString()).isEqualTo("unchanged");
            assertThat(String.join("", lines)).doesNotContain("HEADER_CANARY");
        }
    }

    @Test
    void escapedExceptionCannotBeReportedAs200AndRedispatchDoesNotDuplicateCompletion() throws Exception {
        var request = new MockHttpServletRequest();request.setMethod("POST");
        var response = new MockHttpServletResponse();var failure = new IOException("ERROR_CANARY");
        var filter = filter();
        assertThatThrownBy(() -> filter.doFilter(request, response, (req,res) -> {throw failure;})).isSameAs(failure);
        assertThat(last().get("http_status").isNull()).isTrue();
        assertThat(last().get("status_final").asBoolean()).isFalse();
        assertThat(last().get("outcome").asText()).isEqualTo("escaped_exception");
        request.setDispatcherType(DispatcherType.ERROR);
        filter.doFilter(request, response, (req,res) -> {});
        assertThat(lines).hasSize(2);
        assertThat(String.join("", lines)).doesNotContain("ERROR_CANARY");
    }

    @Test
    void asyncHandoffIsNotTerminalSuccess() throws Exception {
        var request = new MockHttpServletRequest();request.setMethod("GET");request.setAsyncSupported(true);
        filter().doFilter(request, new MockHttpServletResponse(), (req,res) -> request.startAsync());
        assertThat(last().get("phase").asText()).isEqualTo("completion_unobserved");
        assertThat(last().get("http_status").isNull()).isTrue();
        assertThat(last().get("status_final").asBoolean()).isFalse();
    }

    @Test
    void emitterAndSerializationFailuresCannotReplaceBusinessResultsOrExceptions() throws Exception {
        var brokenMapper = mock(ObjectMapper.class);
        when(brokenMapper.writeValueAsString(any())).thenThrow(new com.fasterxml.jackson.core.JsonProcessingException("JSON_CANARY") {});
        for (var filter : List.of(new RequestDiagnosticFilter(json, ignored -> {throw new IllegalStateException("SINK_CANARY");}),
                                  new RequestDiagnosticFilter(brokenMapper, lines::add))) {
            var response = new MockHttpServletResponse();
            filter.doFilter(new MockHttpServletRequest(), response, (req,res) -> {response.setStatus(422);response.getWriter().write("original");});
            assertThat(response.getStatus()).isEqualTo(422);
            assertThat(response.getContentAsString()).isEqualTo("original");
            var failure = new IOException("original");
            assertThatThrownBy(() -> filter.doFilter(new MockHttpServletRequest(), new MockHttpServletResponse(), (req,res) -> {throw failure;})).isSameAs(failure);
        }
        assertThat(lines).isEmpty();
    }
}
