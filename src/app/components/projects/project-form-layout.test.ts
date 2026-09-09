import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ProjectFormRow } from './project-form-layout';

describe('project field requirement semantics', () => {
  it.each([true, false])('exposes required=%s before validation without inventing an error', (required) => {
    const html = renderToStaticMarkup(createElement(ProjectFormRow, { label: '프로젝트명', required, children: createElement('input') }));
    expect(html).toContain(`data-field-required="${required}"`);
    expect(html).not.toContain('aria-invalid="true"');
    if (required) expect(html).toContain('필수');
  });
});
