package dev.merryai.innerplatform.weekly.api;

import java.util.Map;

/** 주차 기록이 표준 형태가 아닐 때. 어느 기록의 무엇이 문제인지 담아 화면까지 전달한다. */
public class CashflowWeekDocumentInvalidException extends WeeklyExpenseConflictException {
    private final Map<String, Object> details;

    public CashflowWeekDocumentInvalidException(String documentId, String yearMonth, int weekNo, String problem) {
        super("Cashflow month contains malformed or non-canonical week documents; migration is required before applying.");
        this.details = Map.of(
            "documentId", documentId == null ? "" : documentId,
            "yearMonth", yearMonth == null ? "" : yearMonth,
            "weekNo", weekNo,
            "problem", problem == null ? "" : problem
        );
    }

    public Map<String, Object> details() {
        return details;
    }
}
