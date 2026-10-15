package dev.merryai.innerplatform.weekly.observability;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerMapping;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 20)
public class RequestDiagnosticFilter extends OncePerRequestFilter {
    private static final String OBSERVED = RequestDiagnosticFilter.class.getName() + ".observed";
    private static final Set<String> METHODS = Set.of("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS");
    private final ObjectMapper json;
    private final Consumer<String> emitter;

    public RequestDiagnosticFilter() {
        this(new ObjectMapper(), System.out::println);
    }

    RequestDiagnosticFilter(ObjectMapper json, Consumer<String> emitter) {
        this.json = json;
        this.emitter = emitter;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
        throws ServletException, IOException {
        if (Boolean.TRUE.equals(request.getAttribute(OBSERVED))) {
            chain.doFilter(request, response);
            return;
        }
        request.setAttribute(OBSERVED, true);
        var enumeration = request.getHeaders("x-request-id");
        var headers = enumeration == null ? java.util.List.<String>of() : Collections.list(enumeration);
        boolean supplied = headers.size() == 1 && headers.getFirst().matches(
            "(?:req_[0-9]{13}_[a-f0-9]{16,64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})");
        String invocationId = UUID.randomUUID().toString();
        String requestId = supplied ? headers.getFirst() : "jvm_" + invocationId;
        long started = System.nanoTime();
        emit(request, requestId, invocationId, supplied, "started", null, false, "pending", 0);
        boolean escaped = true;
        try {
            chain.doFilter(request, response);
            escaped = false;
        } finally {
            boolean async = request.isAsyncStarted();
            // No terminal HTTP status is known when an exception escapes or async work continues.
            emit(request, requestId, invocationId, supplied, async ? "completion_unobserved" : "completed",
                escaped || async ? null : response.getStatus(), !escaped && !async,
                escaped ? "escaped_exception" : async ? "async_started" : "response_returned",
                Math.max(0, (System.nanoTime() - started) / 1_000_000));
        }
    }

    private void emit(HttpServletRequest request, String requestId, String invocationId, boolean supplied, String phase,
                      Integer status, boolean statusFinal, String outcome, long durationMs) {
        try {
            Object mapped = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
            String route = mapped instanceof String value && value.length() <= 300
                && value.matches("/[A-Za-z0-9_./{}:*\\-]*") ? value : null;
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("message", "jvm.request.diagnostic");
            event.put("schema_version", 1);
            event.put("timestamp", Instant.now().toString());
            event.put("request_id", requestId);
            event.put("invocation_id", invocationId);
            event.put("request_id_source", supplied ? "supplied_header" : "server_generated");
            event.put("correlation_scope", "request_id_only_not_actor_authorization");
            event.put("phase", phase);
            event.put("method", METHODS.contains(request.getMethod()) ? request.getMethod() : "OTHER");
            event.put("route_template", route);
            event.put("http_status", status);
            event.put("status_final", statusFinal);
            event.put("outcome", outcome);
            event.put("duration_ms", durationMs);
            event.put("service", runtimeName("K_SERVICE"));
            event.put("revision", runtimeName("K_REVISION"));
            emitter.accept(json.writeValueAsString(event));
        } catch (JsonProcessingException | RuntimeException ignored) {
            // Diagnostics must never replace a business response or its original exception.
        }
    }

    private static String runtimeName(String key) {
        String value = System.getenv(key);
        return value != null && value.matches("[a-z][a-z0-9-]{0,99}") ? value : null;
    }
}
