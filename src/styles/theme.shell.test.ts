import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const themeCss = readFileSync(resolve(import.meta.dirname, 'theme.css'), 'utf8');

describe('global theme polish', () => {
  it('keeps app-wide UI polish in CSS without changing page markup', () => {
    expect(themeCss).toContain("[data-slot='card']");
    expect(themeCss).toContain("[data-slot='button']");
    expect(themeCss).toContain("[data-slot='input']");
    expect(themeCss).toContain("[data-slot='table-container']");
    expect(themeCss).toContain("[data-slot='dialog-content']");
    expect(themeCss).toContain('@keyframes cashflow-ready-bob');
    expect(themeCss).toContain('prefers-reduced-motion: reduce');
  });

  it('adapts common utility surfaces through global CSS tokens', () => {
    expect(themeCss).toContain('--surface-panel-muted');
    expect(themeCss).toContain("[class~='bg-slate-50']");
    expect(themeCss).toContain("[class~='border-slate-200']");
    expect(themeCss).toContain("[class~='shadow-sm']");
    expect(themeCss).toContain("main :where(section, article, aside, div)[class*='bg-white'][class*='border'][class*='rounded']");
  });

  it('keeps typography stable without negative base heading letter spacing', () => {
    expect(themeCss).toContain('letter-spacing: 0;');
    expect(themeCss).toContain("[class*='tracking-[-']");
    expect(themeCss).not.toContain('letter-spacing: -0.');
  });

  it('defines required, optional, neutral and error field colors in both themes', () => {
    for (const token of ['--field-required-background', '--field-optional-background', '--field-neutral-background', '--field-active-border', '--field-error-border']) {
      expect(themeCss.match(new RegExp(`${token}:`, 'g'))).toHaveLength(2);
    }
    expect(themeCss).toContain('--field-required-background: #fff1f2;');
    expect(themeCss).toContain('--field-optional-background: #eff6ff;');
  });

  it('colors fields through declared semantics and permits explicit optional overrides', () => {
    expect(themeCss).toMatch(/\[data-field-required='true'\][\s\S]*?--field-background: var\(--field-required-background\)/);
    expect(themeCss).toMatch(/\[data-field-required='false'\][\s\S]*?--field-background: var\(--field-optional-background\)/);
    expect(themeCss).toContain("[aria-required='true']");
    expect(themeCss).toContain("[aria-required='false']");
    expect(themeCss).toContain('background-color: var(--field-background, var(--field-optional-background)) !important;');
    for (const type of ['hidden', 'range', 'color', 'checkbox', 'radio', 'button', 'submit', 'reset']) {
      expect(themeCss).toContain(`[type='${type}']`);
    }
    expect(themeCss).toContain("[aria-readonly='true']");
    expect(themeCss).toContain("[aria-disabled='true']");
    expect(themeCss).toContain('background-color: var(--field-neutral-background) !important;');
  });

  it('uses a layout-stable thick outline for focus and selected controls with distinct errors', () => {
    expect(themeCss).toContain('outline: 3px solid var(--field-active-border) !important;');
    expect(themeCss).toContain('outline-offset: -3px !important;');
    expect(themeCss).toContain("[aria-selected='true']");
    expect(themeCss).toContain("[aria-pressed='true']");
    expect(themeCss).toContain("[aria-checked='true']");
    expect(themeCss).toContain("[data-slot='tabs-trigger'][data-state='active']");
    expect(themeCss).toContain('border-color: var(--field-error-border) !important;');
    expect(themeCss).toContain('outline-color: var(--field-error-border) !important;');
    expect(themeCss).not.toContain('border-width: 3px');
  });
});
