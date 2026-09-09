package dev.merryai.innerplatform.weekly.domain;

import org.junit.jupiter.api.Test;
import java.util.HashMap;
import java.util.Map;
import static org.assertj.core.api.Assertions.assertThat;

class ProjectSettlementEligibilityTest {
    @Test
    void onlyAnApprovedClosureRemovesEverySettlementEligibility() {
        assertThat(ProjectSettlementEligibility.fromProject(Map.of("status", "COMPLETED")))
            .isEqualTo(new ProjectSettlementEligibility("ACTIVE", true, true, true));
        assertThat(ProjectSettlementEligibility.fromProject(Map.of("closure", Map.of(
            "contractVersion", "project-closure-v1", "requestId", "closure-1",
            "approvedAt", "2026-09-09T03:00:00Z", "approvedBy", "head-1"
        )))).isEqualTo(new ProjectSettlementEligibility("CLOSED", false, false, false));
    }

    @Test
    void malformedPresentClosureAndMissingProjectFailClosed() {
        for (Object closure : new Object[]{"CLOSED", Map.of(), Map.of(
            "contractVersion", "project-closure-v1", "requestId", "closure-1",
            "approvedAt", "yesterday", "approvedBy", "head-1"
        )}) {
            assertThat(ProjectSettlementEligibility.fromProject(Map.of("closure", closure)))
                .isEqualTo(ProjectSettlementEligibility.unavailable());
        }
        Map<String, Object> project = new HashMap<>();
        project.put("closure", null);
        assertThat(ProjectSettlementEligibility.fromProject(project)).isEqualTo(ProjectSettlementEligibility.unavailable());
        assertThat(ProjectSettlementEligibility.fromProject(null)).isEqualTo(ProjectSettlementEligibility.unavailable());
    }
}
