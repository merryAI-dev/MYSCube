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

  it('exempts only the MCP protocol paths, not the browser login page', () => {
    expect(MCP_SCOPE).toContain('"/mcp"');
    expect(MCP_SCOPE).toContain('"/api/v1/mcp/oauth/token"');
    expect(MCP_SCOPE).not.toContain('authorize');
  });

  it('refuses to apply when the live rule drifted from review', () => {
    expect(() => withMcpException('(http.user_agent eq "")')).toThrow();
  });
});
