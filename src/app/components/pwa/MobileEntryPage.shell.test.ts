import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MobileEntryPage } from './MobileEntryPage';
const auth = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../../data/auth-store', () => ({ useAuth: () => auth.current }));
vi.mock('react-router', () => ({ Navigate: ({ to, replace, state }: { to: string; replace: boolean; state?: { from: string } }) => createElement('span', { 'data-to': to, 'data-replace': replace, 'data-from': state?.from }) }));

describe('installed mobile app home entry', () => {
  it('waits for auth without navigating or rendering business cards', () => {
    auth.current = { isLoading: true, isAuthenticated: false };
    const html = renderToStaticMarkup(createElement(MobileEntryPage));
    expect(html).toContain('홈 화면을 불러오는 중');
    expect(html).not.toContain('data-to');
  });
  it('returns unauthenticated users through login to home', () => {
    auth.current = { isLoading: false, isAuthenticated: false };
    const html = renderToStaticMarkup(createElement(MobileEntryPage));
    expect(html).toContain('data-to="/login"');
    expect(html).toContain('data-from="/"');
    expect(html).toContain('data-replace="true"');
  });
  for (const [role, lastWorkspace, defaultWorkspace, expected] of [
    ['admin', 'admin', 'portal', '/'], ['finance', undefined, undefined, '/'],
    ['admin', 'portal', 'admin', '/portal/project-select'],
    ['admin', undefined, 'portal', '/portal/project-select'],
    ['pm', undefined, undefined, '/portal/project-select'], ['viewer', undefined, undefined, '/portal/project-select'],
  ]) it(`opens ${role}/${lastWorkspace}/${defaultWorkspace} home`, () => {
    auth.current = { isLoading: false, isAuthenticated: true, user: { role, lastWorkspace, defaultWorkspace } };
    const html = renderToStaticMarkup(createElement(MobileEntryPage));
    expect(html).toContain(`data-to="${expected}"`);
    expect(html).not.toContain('business-cards');
  });
});
