package dev.merryai.innerplatform.weekly.api;

import java.util.Map;

/** 월결산 승인을 막은 사유. 사유 코드를 화면까지 전달해 무엇이 막았는지 보이게 한다. */
public class CashflowMonthCloseApprovalBlockedException extends WeeklyExpenseConflictException {
    public enum Reason {
        REQUEST_MISSING,
        REQUEST_CHANGED,
        EVIDENCE_MISSING,
        SETTLEMENT_STATUS_MISSING,
        ALREADY_CLOSED
    }

    private final Reason reason;

    public CashflowMonthCloseApprovalBlockedException(Reason reason, String message) {
        super(message);
        this.reason = reason;
    }

    public Reason reason() {
        return reason;
    }

    public Map<String, Object> details() {
        return Map.of("reason", reason.name());
    }
}
