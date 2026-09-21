import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MigrationAuditRecordList } from './MigrationAuditRecordList';
import { MigrationAuditDocumentDialog } from './MigrationAuditDocumentDialog';
import type { MigrationAuditConsoleRecord } from '../../../platform/project-migration-console';

vi.mock('../ContractDocumentPreview', () => ({ ContractDocumentPreview: () => null }));
vi.mock('../../ui/dialog', () => {
  const shell = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return { Dialog: shell, DialogContent: shell, DialogDescription: shell, DialogHeader: shell, DialogTitle: shell };
});

function record(payload: Record<string, unknown> | null, requestVersion = 99): MigrationAuditConsoleRecord {
  return {
    id: 'synthetic', title: '합성 프로젝트', status: 'PENDING', requestedAt: '', cic: 'CIC1',
    project: { id: 'synthetic', name: '현재 원장 이름', registrationRequirementsVersion: 2, status: 'IN_PROGRESS', legacyDetail: 'CANONICAL_ONLY_SECRET_SENTINEL' },
    request: payload === null ? null : { id: 'synthetic-request', requestKind: 'REGISTRATION', status: 'PENDING', requestVersion, payload },
  } as unknown as MigrationAuditConsoleRecord;
}

const listCases = [
  { payload: { registrationRequirementsVersion: 1 }, label: '이전 양식' },
  { payload: {}, label: '양식 버전 미기록' },
  { payload: { registrationRequirementsVersion: 87 }, label: '양식 버전 인식 불가' },
  { payload: { registrationRequirementsVersion: 2 }, label: null },
  { payload: null, label: '제출 문서 연결 없음' },
];

describe('actual approval list format labels', () => {
  for (const testCase of listCases) for (const requestVersion of [1, 99]) {
    it(`${JSON.stringify(testCase.payload)} at request version ${requestVersion}`, () => {
      const input = record(testCase.payload, requestVersion);
      const before = JSON.stringify(input);
      const html = renderToStaticMarkup(createElement(MigrationAuditRecordList, { records: [input], onOpen: vi.fn() }));
      const labels = ['이전 양식', '양식 버전 미기록', '양식 버전 인식 불가', '제출 문서 연결 없음'];
      for (const label of labels) expect(html.includes(`>${label}</span>`)).toBe(label === testCase.label);
      expect(html).not.toContain('현재 등록 양식');
      expect(html).toContain('문서 열기');
      expect(JSON.stringify(input)).toBe(before);
    });
  }
});

describe('actual document original submission disclosure', () => {
  for (const blocking of [false, true]) it(`preserves historical fields with blocking=${blocking}`, () => {
    const input = record({
      registrationRequirementsVersion: 1, name: '제출 당시 이름', status: 'IN_PROGRESS',
      legacyDetail: '제출 당시의 알 수 없는 항목', oldZero: 0, oldFalse: false,
      oldEmpty: '', oldNested: { text: '중첩 원문', zero: 0, no: false },
      fundInputMode: 'HIDDEN_FUND_INPUT_SENTINEL',
    });
    const before = JSON.stringify(input);
    const onApprove = vi.fn();
    const html = renderToStaticMarkup(createElement(MigrationAuditDocumentDialog, {
      open: true, record: input, acting: false, canFinalize: true,
      readiness: { legacy: true, issues: blocking ? [{ code: 'SYNTHETIC_BLOCK', severity: 'blocking', title: '입력 확인', detail: '원문은 계속 볼 수 있습니다.', action: '작성자가 확인합니다.' }] : [] },
      onOpenChange: vi.fn(), onApprove, onReject: vi.fn(),
    }));
    const original = html.split('data-testid="original-submitted-fields"')[1]?.split('</details>')[0] || '';
    expect(original).toContain('제출한 내용 모두 보기');
    expect(original).toContain('제출 당시 이름');
    expect(original).toContain('legacyDetail');
    expect(original).toContain('제출 당시의 알 수 없는 항목');
    expect(original).toMatch(/oldZero<\/dt><dd[^>]*>0<\/dd>/);
    expect(original).toMatch(/oldFalse<\/dt><dd[^>]*>아니오<\/dd>/);
    expect(original).toMatch(/oldEmpty<\/dt><dd[^>]*>제출 당시 입력되지 않은 항목입니다\.<\/dd>/);
    expect(original).toContain('중첩 원문');
    expect(original).toContain('zero: 0');
    expect(original).toContain('no: 아니오');
    expect(html).not.toContain('CANONICAL_ONLY_SECRET_SENTINEL');
    expect(html).not.toContain('HIDDEN_FUND_INPUT_SENTINEL');
    expect(original).not.toContain('fundInputMode');
    if (blocking) {
      expect(html).toContain('승인 전 해결 필요');
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>승인<\/button>/);
    }
    expect(JSON.stringify(input)).toBe(before);
    expect(onApprove).not.toHaveBeenCalled();
  });
});
