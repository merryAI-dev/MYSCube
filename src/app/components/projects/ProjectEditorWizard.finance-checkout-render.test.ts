import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProjectEditorWizard } from './ProjectEditorWizard';
import { MigrationAuditDocumentDialog } from './migration-audit/MigrationAuditDocumentDialog';
import { createProjectEditorDraft } from '../../platform/project-editor';
import type { ProjectStatus } from '../../data/types';
import type { MigrationAuditConsoleRecord } from '../../platform/project-migration-console';

vi.mock('../../data/auth-store', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../../lib/firebase-context', () => ({ useFirebase: () => ({ orgId: 'synthetic-test', db: null }) }));
vi.mock('react-router', async (original) => ({
  ...await original<typeof import('react-router')>(),
  useBlocker: () => ({ state: 'unblocked' }),
}));
// SSR has no document portal; keep every document child while replacing only its modal shell.
vi.mock('../ui/dialog', () => {
  const shell = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return { Dialog: shell, DialogContent: shell, DialogDescription: shell, DialogHeader: shell, DialogTitle: shell };
});

const statuses: ProjectStatus[] = ['CONTRACT_PENDING', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED_PENDING_PAYMENT'];
const versions = [undefined, 1, 2] as const;
const periods = [{ label: '단년', end: '2026-12-31', years: [2026] }, { label: '다년', end: '2027-12-31', years: [2026, 2027] }];

function fixture(version: typeof versions[number], status: ProjectStatus, end: string) {
  const draft = createProjectEditorDraft({
    name: '합성 QA 프로젝트', status, contractStart: '2026-01-01', contractEnd: end,
    financialYears: [], contractAmount: 100, totalRevenueAmount: 40,
    totalActualCost: 60, salesVatAmount: 0, supportAmount: 0,
  });
  if (version === undefined) delete (draft as Partial<typeof draft>).registrationRequirementsVersion;
  else draft.registrationRequirementsVersion = version;
  return draft;
}

for (const version of versions) for (const period of periods) for (const status of statuses) {
  describe(`실제 렌더링: 형식 ${version ?? '미기록'} / ${period.label} / ${status}`, () => {
    it('shows all missing years on both screens, one checkout only when complete, and preserves the source', () => {
      const draft = fixture(version, status, period.end);
      const before = JSON.stringify(draft);
      const onSubmit = vi.fn();
      const html = renderToStaticMarkup(createElement(ProjectEditorWizard, {
        mode: 'portal-edit', initialDraft: draft, initialStepIndex: 1,
        members: [], roster: [], actions: [], readOnly: true, showCheckoutEntry: true,
        title: '합성 QA', draftKey: 'synthetic-render-only', onSubmit,
      }));
      const record = { id: 'synthetic', project: { ...draft, id: 'synthetic' }, request: {
        id: 'synthetic-request', requestKind: 'REGISTRATION', payload: draft,
      }, title: draft.name, status: 'PENDING' } as unknown as MigrationAuditConsoleRecord;
      const recordBefore = JSON.stringify(record);
      const admin = renderToStaticMarkup(createElement(MigrationAuditDocumentDialog, {
        open: true, record, acting: false, canFinalize: false,
        onOpenChange: vi.fn(), onApprove: vi.fn(), onReject: vi.fn(),
      }));
      for (const year of period.years) {
        const notice = `${year}년 계약금액, 매출 부가세, 수익, 실비(원가), 지원금 입력 확인이 필요합니다.`;
        expect(html).toContain(notice);
        expect(admin).toContain(notice);
      }
      const expected = status.startsWith('COMPLETED') ? 1 : 0;
      expect((html.match(/>종료사업 체크아웃</g) || []).length).toBe(expected);
      expect((admin.match(/>종료사업 체크아웃</g) || []).length).toBe(expected);
      expect(JSON.stringify(draft)).toBe(before);
      expect(JSON.stringify(record)).toBe(recordBefore);
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });
}
