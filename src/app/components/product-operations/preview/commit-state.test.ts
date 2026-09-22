import { describe, it, expect } from 'vitest';
import { PreviewCommitState } from './commit-state';
import { compilePreviewDocument } from './document';
describe('preview commits', () => {
  it('cannot commit failed or superseded candidate and retains the last good frame', () => {
    const state = new PreviewCommitState(); state.start('a'); expect(state.ready('a')).toBe(true);
    state.start('b'); state.start('c'); expect(state.ready('b')).toBe(false);
    state.fail('c'); expect(state.ready('c')).toBe(false); expect(state.active).toBe('a');
    state.start('d'); expect(state.ready('d')).toBe(true); expect(state.active).toBe('d');
    state.fail('d'); expect(state.active).toBe('a');
  });
  it('does not restore a previous frame that failed while the candidate was pending', () => {
    const state = new PreviewCommitState(); state.start('a'); state.ready('a'); state.start('b');
    state.fail('a'); state.fail('b'); expect(state.active).toBe(''); expect(state.ready('b')).toBe(false);
  });
  it('escapes data instead of executing injected markup and denies network and forms', () => {
    const doc = compilePreviewDocument({ title: '</script><script>bad()</script>', description: '', widgets: [] }, 'var MYSCubePreview={render(){}};', 'nonce');
    expect(doc).not.toContain('<script>bad()'); expect(doc).toContain("connect-src 'none'"); expect(doc).toContain("form-action 'none'");
  });
});
