import { describe, expect, it } from 'vitest';
import { PlatformApiError } from './api-client';
import { resolveProjectSaveErrorMessage } from './project-save-error';

describe('project save error messages', () => {
  it('shows the annual field reported by the server', () => {
    const error = new PlatformApiError('Request failed', 422, 'request-test', {
      error: 'project_registration_invalid',
      details: { issues: [{ message: '2027년 잔금 입금 예상월을 입력해 주세요.' }] },
    });
    expect(resolveProjectSaveErrorMessage(error, '저장 실패')).toBe('2027년 잔금 입금 예상월을 입력해 주세요.');
  });

  it('preserves recovery guidance for a conflicting draft revision', () => {
    const error = new PlatformApiError('Request failed', 409, undefined, { error: 'draft_version_conflict' });
    expect(resolveProjectSaveErrorMessage(error, '저장 실패')).toContain('현재 입력은 보관됩니다');
  });

  it('does not expose an internal failure or promise that an uncertain save failed', () => {
    const error = new PlatformApiError('internal details', 503, undefined, { message: 'internal details' });
    expect(resolveProjectSaveErrorMessage(error, '저장 결과를 확인하지 못했습니다.'))
      .toBe('저장 결과를 확인하지 못했습니다. 저장 결과를 다시 확인한 뒤 재시도해 주세요.');
  });
});
