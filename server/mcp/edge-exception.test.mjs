import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MCP_SCOPE, withMcpException } from '../../scripts/configure-mcp-edge.mjs';

function terraformAutomationRule() {
  const line = readFileSync(new URL('../../infra/cloudflare/main.tf', import.meta.url), 'utf8').split('\n')
    .find((candidate) => candidate.includes('contains \\"mcp-client\\"'));
  return JSON.parse(line.trim().replace(/^expression\s*=\s*/, ''));
}

describe('MCP edge exception', () => {
  it('keeps Terraform and the live-apply script on the same reviewed expression', () => {
    const expression = terraformAutomationRule();
    expect(expression.endsWith(` and not ${MCP_SCOPE}`)).toBe(true);
    expect(withMcpException(expression)).toBe(expression);
  });

  it('exempts the MCP host and only the MCP protocol paths on the app host, not the browser login page', () => {
    expect(MCP_SCOPE).toContain('"mcp.myscguard.app"');
    expect(MCP_SCOPE).toContain('"ema-mcp.myscguard.app"');
    expect(MCP_SCOPE).toContain('"/mcp"');
    expect(MCP_SCOPE).toContain('"/api/v1/mcp/oauth/token"');
    expect(MCP_SCOPE).not.toContain('authorize');
  });

  it('refuses to apply when the live rule drifted from review', () => {
    expect(() => withMcpException('(http.user_agent eq "")')).toThrow();
  });

  it('upgrades a rule that already carries the earlier app-host-only exception', () => {
    const expression = terraformAutomationRule();
    const legacy = expression.slice(0, -` and not ${MCP_SCOPE}`.length)
      + ' and not (http.host eq "myscube.myscguard.app" and http.request.uri.path in {"/mcp" "/.well-known/oauth-authorization-server" "/.well-known/oauth-protected-resource" "/.well-known/oauth-protected-resource/mcp" "/api/v1/mcp/oauth/register" "/api/v1/mcp/oauth/token"})';
    expect(withMcpException(legacy)).toBe(expression);
  });

  it('upgrades a rule that carries the single-host exception from the first MCP release', () => {
    const expression = terraformAutomationRule();
    const earlier = expression.slice(0, -` and not ${MCP_SCOPE}`.length)
      + ' and not (http.host eq "mcp.myscguard.app" or (http.host eq "myscube.myscguard.app" and http.request.uri.path in {"/mcp" "/.well-known/oauth-authorization-server" "/.well-known/oauth-protected-resource" "/.well-known/oauth-protected-resource/mcp" "/api/v1/mcp/oauth/register" "/api/v1/mcp/oauth/token"}))';
    expect(withMcpException(earlier)).toBe(expression);
  });
});
