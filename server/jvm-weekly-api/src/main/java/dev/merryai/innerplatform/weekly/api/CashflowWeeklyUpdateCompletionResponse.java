package dev.merryai.innerplatform.weekly.api;

public record CashflowWeeklyUpdateCompletionResponse(
    boolean ok,
    String commandName,
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
    String updateResult
) {
    public CashflowWeeklyUpdateCompletionResponse(
        boolean ok, String commandName, String projectId, String yearMonth, int weekNo, String completedAt,
        String completedBy, boolean alreadyCompleted, String status, long revision, long reopenCount,
        String snapshotHash, String sourceRevision, String targetRevision, String reopenedAt, String reopenedBy,
        String reopenReason
    ) {
        this(ok, commandName, projectId, yearMonth, weekNo, completedAt, completedBy, alreadyCompleted, status,
            revision, reopenCount, snapshotHash, sourceRevision, targetRevision, reopenedAt, reopenedBy,
            reopenReason, "", "", "", "", "");
    }
}
