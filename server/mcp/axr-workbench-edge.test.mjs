import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AXR_WORKBENCH_RULE, axrWorkbenchScopeExpression } from '../../scripts/configure-axr-workbench-edge.mjs';

const terraform = readFileSync(new URL('../../infra/cloudflare/main.tf', import.meta.url), 'utf8');
// Sent by server/workbench/myscube-live-api.mjs on the AXR branch.
const WORKBENCH_USER_AGENT = 'MYSCube-AXR-Workbench/1.0';

describe('AXR workbench edge identity scope', () => {
  it('renders one IP, one host, GET only and the two reviewed read paths', () => {
    expect(axrWorkbenchScopeExpression(['34.64.247.190'])).toBe('((lower(http.user_agent) contains "myscube-axr-workbench") and not (ip.src in {34.64.247.190} and http.host eq "myscube.myscguard.app" and http.request.method eq "GET" and http.request.uri.path in {"/api/v1/projects" "/api/v1/cashflow-evidence"}))');
  });

  it('refuses to render an open scope', () => {
    for (const ips of [[], [''], ['34.64.247.0/24'], ['2600::1'], ['300.1.1.1'], undefined]) expect(() => axrWorkbenchScopeExpression(ips)).toThrow();
  });

  it('matches the workbench identity and the Terraform record', () => {
    expect(WORKBENCH_USER_AGENT.toLowerCase()).toContain('myscube-axr-workbench');
    expect(terraform).toContain('contains \\"myscube-axr-workbench\\"');
    expect(terraform).toContain('http.request.uri.path in {\\"/api/v1/projects\\" \\"/api/v1/cashflow-evidence\\"}');
    expect(terraform).toContain(`ref         = "${AXR_WORKBENCH_RULE.ref}"`);
  });
});
