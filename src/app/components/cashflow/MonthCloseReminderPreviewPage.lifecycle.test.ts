import { describe, expect, it, vi } from 'vitest';
import { invalidateMonthClosePreviewSession } from './MonthCloseReminderPreviewPage';

describe('month-close preview request lifecycle', () => {
  it('aborts the active request and clears stale output when inputs or identity change', () => {
    const abort = vi.fn();
    const sequence = { current: 7 };
    const setLoading = vi.fn();
    const setError = vi.fn();
    const setResult = vi.fn();

    invalidateMonthClosePreviewSession({
      sequence,
      controller: { current: { abort } as unknown as AbortController },
      setLoading,
      setError,
      setResult,
    });

    expect(sequence.current).toBe(8);
    expect(abort).toHaveBeenCalledOnce();
    expect(setLoading).toHaveBeenCalledWith(false);
    expect(setError).toHaveBeenCalledWith('');
    expect(setResult).toHaveBeenCalledWith(null);
  });
});
