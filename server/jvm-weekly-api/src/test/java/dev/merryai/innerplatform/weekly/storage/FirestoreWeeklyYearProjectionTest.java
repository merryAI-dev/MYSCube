package dev.merryai.innerplatform.weekly.storage;

import com.google.api.core.ApiFutures;
import com.google.cloud.firestore.DocumentReference;
import com.google.cloud.firestore.DocumentSnapshot;
import com.google.cloud.firestore.FieldMask;
import com.google.cloud.firestore.Firestore;
import com.google.cloud.firestore.Transaction;
import com.google.firestore.v1.DocumentMask;
import dev.merryai.innerplatform.weekly.service.port.CashflowReadPort;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

class FirestoreWeeklyYearProjectionTest {
    private final Firestore db = mock(Firestore.class);
    private final DocumentReference ref = mock(DocumentReference.class);
    private final FirestoreInheritedWeeklyExpensePersistence persistence =
        new FirestoreInheritedWeeklyExpensePersistence(db, "demo-weekly-year", Clock.systemUTC());

    @Test
    void singleYearReadMasksTheMirrorAndNeverDecodesItsCellPayload() throws Exception {
        DocumentSnapshot projected = projected("project-a", 2026L);
        when(db.document("orgs/tenant-a/cashflow_sheet_mirrors/project-a")).thenReturn(ref);
        when(db.getAll(any(DocumentReference[].class), any(FieldMask.class))).thenAnswer(invocation -> {
            FieldMask requestedMask = invocation.getArgument(1);
            DocumentMask mask = ReflectionTestUtils.invokeMethod((Object) requestedMask, "toPb");
            assertThat(mask.getFieldPathsList()).containsExactly("weeklyYear");
            assertThat((DocumentReference[]) invocation.getArgument(0)).containsExactly(ref);
            return ApiFutures.immediateFuture(List.of(projected));
        });

        assertThat(persistence.findCashflowDeclaredWeeklyYear("tenant-a", "project-a")).isEqualTo(2026);
        verify(ref, never()).get();
        verify(projected, never()).getData();
    }

    @Test
    void batchReadPreservesValidationAndDoesNotFetchFullMirrors() throws Exception {
        when(db.document(anyString())).thenReturn(ref);
        List<DocumentSnapshot> snapshots = List.of(
                projected("valid", 2026L), projected("fractional", 2026.5),
                projected("old", 1999L), projected("future", 2100L),
                projected("text", "2026"), projected("absent", null),
                projected("not-finite", Double.NaN), projected("valid", 2026L)
            );
        when(db.getAll(any(DocumentReference[].class), any(FieldMask.class)))
            .thenReturn(ApiFutures.immediateFuture(snapshots));

        assertThat(persistence.findCashflowDeclaredWeeklyYears(
            "tenant-a", List.of("valid", "fractional", "old", "future", "text", "absent", "not-finite", "valid")
        )).containsExactlyEntriesOf(Map.of("valid", 2026));
        verify(db, never()).getAll(any(DocumentReference[].class));
    }

    @Test
    void missingMirrorReturnsNullAndFirestoreFailureRetainsUnavailableContract() throws Exception {
        when(db.document(anyString())).thenReturn(ref);
        DocumentSnapshot absent = mock(DocumentSnapshot.class);
        when(db.getAll(any(DocumentReference[].class), any(FieldMask.class)))
            .thenReturn(ApiFutures.immediateFuture(List.of(absent)))
            .thenReturn(ApiFutures.immediateFailedFuture(new IllegalStateException("read failed")));

        assertThat(persistence.findCashflowDeclaredWeeklyYear("tenant-a", "project-a")).isNull();
        assertThatThrownBy(() -> persistence.findCashflowDeclaredWeeklyYear("tenant-a", "project-a"))
            .isInstanceOf(CashflowReadPort.Unavailable.class);
    }

    @Test
    @SuppressWarnings("unchecked")
    void transactionalProjectionUsesTheTransactionAndCannotPoisonItsFullDocumentCache() throws Exception {
        Transaction tx = mock(Transaction.class);
        when(db.document(anyString())).thenReturn(ref);
        when(ref.getPath()).thenReturn("orgs/tenant-a/cashflow_sheet_mirrors/project-a");
        DocumentSnapshot projected = projected("project-a", 2026L);
        when(tx.getAll(any(DocumentReference[].class), any(FieldMask.class)))
            .thenReturn(ApiFutures.immediateFuture(List.of(projected)));
        ThreadLocal<Transaction> current = (ThreadLocal<Transaction>) ReflectionTestUtils.getField(persistence, "currentTransaction");
        ThreadLocal<Map<String, Map<String, Object>>> cache =
            (ThreadLocal<Map<String, Map<String, Object>>>) ReflectionTestUtils.getField(persistence, "transactionDocumentCache");
        current.set(tx);
        cache.set(new LinkedHashMap<>());
        try {
            assertThat(persistence.findCashflowDeclaredWeeklyYear("tenant-a", "project-a")).isEqualTo(2026);
            assertThat(cache.get()).isEmpty();
            DocumentSnapshot full = mock(DocumentSnapshot.class);
            Map<String, Object> fullData = Map.of("weeklyYear", 2026L, "cells", List.of("preserved"));
            when(full.exists()).thenReturn(true);
            when(full.getData()).thenReturn(fullData);
            when(tx.get(ref)).thenReturn(ApiFutures.immediateFuture(full));

            assertThat((DocumentSnapshot) ReflectionTestUtils.invokeMethod(persistence, "get", ref)).isSameAs(full);
            assertThat(cache.get().get(ref.getPath())).containsEntry("cells", List.of("preserved"));
            verify(db, never()).getAll(any(DocumentReference[].class), any(FieldMask.class));
        } finally {
            current.remove();
            cache.remove();
        }
    }

    private DocumentSnapshot projected(String projectId, Object year) {
        DocumentSnapshot snapshot = mock(DocumentSnapshot.class);
        when(snapshot.exists()).thenReturn(true);
        when(snapshot.getId()).thenReturn(projectId);
        when(snapshot.get("weeklyYear")).thenReturn(year);
        when(snapshot.getData()).thenThrow(new AssertionError("Full mirror cell decoding is forbidden for a year lookup"));
        return snapshot;
    }
}
