package dev.merryai.innerplatform.weekly.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.management.ThreadMXBean;
import dev.merryai.innerplatform.weekly.api.CashflowWeeklyOverviewRequest;
import dev.merryai.innerplatform.weekly.api.TrustedActorContext;
import dev.merryai.innerplatform.weekly.domain.CashflowLedgerSource;
import dev.merryai.innerplatform.weekly.domain.WeeklyExpenseProjectionEntity;
import dev.merryai.innerplatform.weekly.storage.WeeklyExpensePersistence;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import java.lang.management.ManagementFactory;
import java.math.BigDecimal;
import java.util.*;
import java.util.stream.IntStream;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

/** Synthetic service/allocation benchmark; excludes Firestore, HTTP, and provenance I/O. */
@EnabledIfSystemProperty(named = "cashflow.benchmark", matches = "true")
class CashflowOverviewReadBenchmarkTest {
    @Test
    void compareDiscardedLedgerWork() {
        var bean = (ThreadMXBean) ManagementFactory.getThreadMXBean();
        bean.setThreadAllocatedMemoryEnabled(true);
        var actor = new TrustedActorContext("demo-bench", "viewer", "viewer@example.com", "viewer", "Viewer");
        for (int count : List.of(10, 50, 100)) {
            var ids = IntStream.range(0, count).mapToObj(i -> "synthetic-" + i).toList();
            var persistence = mock(WeeklyExpensePersistence.class);
            when(persistence.findCashflowLedgerSources(anyString(), anyList(), anyString(), anyString()))
                .thenAnswer(invocation -> {
                    Map<String, CashflowLedgerSource> sources = new HashMap<>();
                    for (String id : ids) {
                        List<WeeklyExpenseProjectionEntity> lines = new ArrayList<>();
                        for (int month = 1; month <= 12; month++) {
                            for (int week = 1; week <= 5; week++) {
                                for (String line : List.of("SALES_IN", "DIRECT_COST_OUT", "VAT_OUT")) {
                                    var entity = new WeeklyExpenseProjectionEntity("demo-bench", id,
                                        "2026-" + (month < 10 ? "0" : "") + month, week, line);
                                    entity.setAmount(BigDecimal.valueOf(1000L + week));
                                    lines.add(entity);
                                }
                            }
                        }
                        sources.put(id, new CashflowLedgerSource(lines, List.of()));
                    }
                    return sources;
                });
            // Identical status path, no remote I/O. Synthetic empty statuses are sufficient for allocation isolation.
            when(persistence.findCashflowSettlementStatusesBatch(anyString(), anyList(), anyString()))
                .thenReturn(ids.stream().collect(java.util.stream.Collectors.toMap(id -> id, id -> List.of())));
            var service = new WeeklyExpenseCommandService(persistence,
                mock(WeeklyExpenseAuthorizationService.class), new ObjectMapper(), false, "live");
            for (boolean omit : List.of(false, true)) {
                var request = new CashflowWeeklyOverviewRequest(ids, "2026-10", false);
                for (int i = 0; i < 10; i++) service.readCashflowWeeklyOverview(actor, request, omit);
                double[] times = new double[15];
                long[] allocations = new long[15];
                for (int i = 0; i < times.length; i++) {
                    long allocated = bean.getTotalThreadAllocatedBytes();
                    long started = System.nanoTime();
                    var response = service.readCashflowWeeklyOverview(actor, request, omit);
                    times[i] = (System.nanoTime() - started) / 1_000_000.0;
                    allocations[i] = bean.getTotalThreadAllocatedBytes() - allocated;
                    org.assertj.core.api.Assertions.assertThat(response.items()).hasSize(count);
                }
                Arrays.sort(times); Arrays.sort(allocations);
                System.out.printf(Locale.ROOT, "CASHFLOW_BENCH projects=%d weeks=%d omit=%s median_ms=%.3f allocated_bytes=%d%n",
                    count, count * 60, omit, times[7], allocations[7]);
            }
        }
    }
}
