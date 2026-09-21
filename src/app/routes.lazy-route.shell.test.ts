import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const routesSource = readFileSync(resolve(import.meta.dirname, 'routes.tsx'), 'utf8');

describe('route lazy loading safety', () => {
  it('keeps the retired portal project settings screen off the route table', () => {
    expect(routesSource).not.toContain('const PortalProjectSettings = lazy(');
    expect(routesSource).toContain("{ path: 'project-settings', element: <S C={PortalProjectSelectPage} /> }");
  });

  it('registers the mobile PWA entry route separately from the desktop root', () => {
    expect(routesSource).toContain("const MobileEntryPage = lazyRoute(() => import('./components/pwa/MobileEntryPage'), 'MobileEntryPage')");
    expect(routesSource).toContain("{ path: '/mobile-entry', element: <S C={MobileEntryPage} /> }");
    expect(routesSource).toContain('{ index: true, element: <S C={FeatureSearchPage} /> }');
    expect(routesSource).not.toContain('shouldUseBusinessCardMobileEntry');
    expect(routesSource).not.toContain('MobileAwareAdminHome');
  });

  it('keeps /portal on the project selection surface without a route-level redirect', () => {
    expect(routesSource).toContain('{ index: true, element: <S C={PortalProjectSelectPage} /> }');
    expect(routesSource).not.toContain('{ index: true, element: <Navigate to="/portal/project-select" replace /> }');
    expect(routesSource).not.toContain('{ index: true, element: <S C={PortalDashboard} /> }');
  });
});
