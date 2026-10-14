import { decodeFields } from './pipeline-context.mjs';
import { deliverReviewedIssue } from './issue-delivery.mjs';
const root = 'https://firestore.googleapis.com/v1/projects/inner-platform-qa-20260310/databases/qa-assistant/documents/orgs/mysc';
const casePattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

// Grants select work; delivery re-reads them transactionally before any publication.
export async function runPublicationSweep({ client, createDelivery, onResult, now = Date.now }) {
  const seen = new Set();
  let pageToken;
  const pageTokens = new Set();
  let failed = false;
  do {
    const url = new URL(`${root}/qa_github_publication_grants`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('orderBy', '__name__');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const { data } = await client.request({ url: url.href, method: 'GET' });
    for (const document of data.documents || []) {
      const grant = decodeFields(document.fields);
      const caseId = document.name?.split('/').at(-1);
      if (grant.status !== 'ACTIVE') continue;
      if (!Number.isFinite(Date.parse(grant.expires_at)) || !casePattern.test(caseId || '') || grant.case_id !== caseId || grant.repository !== 'merryAI-dev/MYSCube') {
        failed = true;
        await onResult({ status: 'failed', error_code: 'issue_grant_invalid' });
        continue;
      }
      if (Date.parse(grant.expires_at) <= now()) continue;
      if (seen.has(caseId)) continue;
      seen.add(caseId);
      try {
        const result = await deliverReviewedIssue({ caseId, ...await createDelivery(caseId) });
        if (['publication_outcome_unknown', 'receipt_persistence_conflict'].includes(result.status)) failed = true;
        await onResult({ case_id: caseId, status: result.status, ...(result.receipt ? { issue_url: result.receipt.url } : {}) });
      } catch (error) {
        failed = true;
        await onResult({ case_id: caseId, status: 'failed', error_code: /^(?:issue|investigation_authority)_[a-z_]+$/.test(error.code || '') ? error.code : 'issue_publication_failed' });
      }
    }
    const next = data.nextPageToken;
    if (next && pageTokens.has(next)) throw new Error('issue_grant_pagination_stalled');
    if (next) pageTokens.add(next);
    pageToken = next;
  } while (pageToken);
  return { failed, visited: seen.size };
}
