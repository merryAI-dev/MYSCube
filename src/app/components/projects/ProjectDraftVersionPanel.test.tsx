import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { compareProjectDraftVersions, draftVersionValue, ProjectDraftVersionPanel } from './ProjectDraftVersionPanel';
import { parseProjectDraftHistory } from '../../lib/project-draft-history';

describe('private draft history comparison', () => {
  it('distinguishes absent, explicit zero, false, null, and empty text', () => {
    expect(compareProjectDraftVersions({}, { totalActualCost: 0, note: '', contractDocument: null, quoteSubmissionDeferred: false })).toEqual([
      { key: 'totalActualCost', label: '총실비(원가)', previous: '기록 없음', current: '0' },
      { key: 'note', label: '등록 메모', previous: '기록 없음', current: '빈 입력' },
      { key: 'contractDocument', label: '계약서', previous: '기록 없음', current: '비워 둠' },
      { key: 'quoteSubmissionDeferred', label: '견적서 추후 제출', previous: '기록 없음', current: '아니오' },
    ]);
    expect(draftVersionValue('  ', true)).toBe('  ');
  });
  it('ignores object property ordering but detects nested value changes', () => {
    expect(compareProjectDraftVersions({ paymentPlan: { contract: 0, final: 1 } }, { paymentPlan: { final: 1, contract: 0 } })).toEqual([]);
    expect(compareProjectDraftVersions({ paymentPlan: { contract: 0 } }, { paymentPlan: { contract: 1 } })).toHaveLength(1);
  });
  it('shows only acknowledged draft metadata, separate from submitted version', () => {
    const html = renderToStaticMarkup(<ProjectDraftVersionPanel editorRevision={3} serverDraft={{ draftRevision: 4, payload: {}, attachmentRefs: [], baseCanonicalVersion: 7 }} submittedVersion={2} submittedStatus="PENDING" loadHistory={async () => ({ items: [], historyAvailableFromRevision: null })} />);
    expect(html).toContain('버전 3');
    expect(html).toContain('버전 4');
    expect(html).toContain('요청 버전 2');
    expect(html).toContain('조직장 검토 대기');
    expect(html).toContain('초안 작성 기준 프로젝트');
    expect(html).not.toContain('비교할 저장 버전');
  });
  it('does not manufacture histories for malformed or empty API responses', () => {
    expect(parseProjectDraftHistory({ items: [], historyAvailableFromRevision: null })).toEqual({ items: [], historyAvailableFromRevision: null });
    expect(() => parseProjectDraftHistory({ items: [{ draftRevision: 2 }] })).toThrow('형식');
  });
});
