import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, 'LoginPage.tsx'), 'utf8');

describe('LoginPage post-login transition contract', () => {
  it('keeps login first, then shows a smooth transition before the feature search entry', () => {
    expect(source).toContain('resolveLoginSuccessPath');
    expect(source).toContain('POST_LOGIN_TRANSITION_MS');
    expect(source).toContain('PostLoginTransition');
    expect(source).toContain('시작 화면을 준비하고 있습니다');
    expect(source).not.toContain('viewportWidth');
    expect(source).toContain('animate-in fade-in-0 zoom-in-95');
    expect(source).not.toContain('if (isAuthenticated && user) return null;');
  });
});
