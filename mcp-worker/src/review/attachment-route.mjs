const ROUTE = /^\/api\/v1\/(projects|project-requests|project-registration-drafts|project-info-drafts)\/([A-Za-z0-9_-]{1,128})\/attachments\/(contract|customer_business_registration|quote|proposal|rfp_request_evidence|performance_certificate|tax_invoice|final_settlement_report|final_report)\/text$/u;

export function attachmentRoute(path) {
  const match = ROUTE.exec(path);
  return match ? { kind: match[3], downloadPath: path.slice(0, -5) } : null;
}
