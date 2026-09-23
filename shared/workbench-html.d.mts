export const HTML_RUNTIME_VERSION: 'static-html-tailwind-v1';
export const HTML_DATA_CONTRACT_VERSION: 'no-data-v1';
export const MAX_HTML_LENGTH: number;
export const HTML_PREVIEW_CSP: string;
export type HtmlPageSource = { title: string; html: string };
export type HtmlSourceIssue = { code: string; message: string };
export function validateHtmlSource(source: unknown): { ok: true; issues: HtmlSourceIssue[]; document: string } | { ok: false; issues: HtmlSourceIssue[] };
export function validateHtmlPreviewArtifact(html: unknown): { ok: true; issues: HtmlSourceIssue[]; document: string } | { ok: false; issues: HtmlSourceIssue[] };
