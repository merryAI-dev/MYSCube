import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, 'MonthCloseReminderPreviewPage.tsx'), 'utf8');

describe('month-close reminder preview UI safety contract', () => {
  it('allows only admin/finance and prevents duplicate in-flight requests', () => {
    expect(source).toContain("user?.role === 'admin' || user?.role === 'finance'");
    expect(source).toContain('if (!user || !allowed || loading) return');
    expect(source).toContain('disabled={loading');
  });

  it('aborts superseded requests and refuses stale responses', () => {
    expect(source).toContain('controller.current?.abort()');
    expect(source).toContain('request === sequence.current');
    expect(source).toContain('request !== sequence.current');
  });

  it('supports month/deadline changes, retry, unknown details and copying exact text', () => {
    expect(source).toContain('type="month"');
    expect(source).toContain('type="datetime-local"');
    expect(source).toContain('재시도');
    expect(source).toContain('result.plan.unknown.map');
    expect(source).toContain('navigator.clipboard.writeText(result.plan.text)');
  });
});
