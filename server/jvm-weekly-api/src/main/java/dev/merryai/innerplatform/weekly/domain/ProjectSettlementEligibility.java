package dev.merryai.innerplatform.weekly.domain;

import java.time.Instant;
import java.util.Map;

public record ProjectSettlementEligibility(String status, boolean weekly, boolean monthly, boolean writable) {
    public static ProjectSettlementEligibility unavailable() {
        return new ProjectSettlementEligibility("UNAVAILABLE", false, false, false);
    }

    public static ProjectSettlementEligibility fromProject(Map<String, Object> project) {
        if (project == null) return unavailable();
        if (!project.containsKey("closure")) return new ProjectSettlementEligibility("ACTIVE", true, true, true);
        if (!(project.get("closure") instanceof Map<?, ?> closure)
            || !"project-closure-v1".equals(closure.get("contractVersion"))
            || !(closure.get("requestId") instanceof String requestId) || requestId.isBlank()
            || !(closure.get("approvedBy") instanceof String approvedBy) || approvedBy.isBlank()
            || !(closure.get("approvedAt") instanceof String approvedAt)) return unavailable();
        try {
            Instant.parse(approvedAt);
            return new ProjectSettlementEligibility("CLOSED", false, false, false);
        } catch (RuntimeException invalid) {
            return unavailable();
        }
    }
}
