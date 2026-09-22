import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, 'ProjectListPage.tsx'), 'utf8');

describe('ProjectListPage mobile lifecycle tabs', () => {
  // Regression: ISSUE-001 — 375px에서 생애주기 탭이 잘림
  // Found by /qa on 2026-07-14
  // Report: .gstack/qa-reports/qa-report-project-navigation-2026-07-14.md
  it('fits all lifecycle tabs, including trash, in one responsive grid', () => {
    expect(source).toMatch(/<TabsList[\s\S]*?className="[^"]*\bgrid-cols-4\b[^"]*"/);
    expect(source).toContain('data-testid="projects-tab-contract-pending"');
    expect(source).toContain('data-testid="projects-tab-in-progress"');
    expect(source).toContain('data-testid="projects-tab-completed"');
    expect(source).toContain('data-testid="projects-tab-trash"');
  });
});
