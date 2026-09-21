import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MigrationAuditDetailPanel } from './MigrationAuditDetailPanel';
import type { MigrationAuditConsoleRecord } from '../../../platform/project-migration-console';

describe('submitted finance detail', () => {
  it('renders the actual panel with status, currency and mismatch warning', () => {
    const project = { id: 'read-only-test', name: '대조', status: 'IN_PROGRESS', currency: 'USD', contractAmount: 120000000, salesVatAmount: 0, totalRevenueAmount: 48000000, totalActualCost: 0, supportAmount: 0 };
    const record = { id: project.id, project, request: null, status: 'PENDING', title: project.name } as unknown as MigrationAuditConsoleRecord;
    const before = JSON.stringify(record);
    const html = renderToStaticMarkup(createElement(MigrationAuditDetailPanel, { record, acting: false, onApprove() {}, onReject() {}, onDiscard() {} }));
    expect(html).toContain('진행 중');
    expect(html).toContain('120,000,000 USD과 항목 합계 48,000,000 USD');
    expect(html).toContain('작성자와 계약금액');
    expect(JSON.stringify(record)).toBe(before);
  });
});
