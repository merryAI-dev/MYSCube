import { candidateHash } from '../qa-shared/candidate-integrity.mjs';
const fail = code => { throw Object.assign(new Error(code), {code}); };
const REPO = 'merryAI-dev/MYSCube';
const reviewedHash = (source, caseId) => {
  if (source?.run?.case_id !== caseId || source?.case?.case_id !== caseId || source.run.case_aggregate_version !== source.case.aggregate_version
    || source.run.case_actor_id !== source.case.actor_id || source.run.case_input_hash !== candidateHash({actor_id:source.case.actor_id,aggregate_version:source.case.aggregate_version,title:source.case.title,description:source.case.description,investigation_scope:source.case.investigation_scope})) fail('issue_source_binding_invalid');
  if (source?.run?.status !== 'completed' || source.run.review?.accepted !== true) fail('issue_source_not_reviewed');
  return candidateHash({case_id:caseId,case_input_hash:source.run.case_input_hash,run_id:source.run.run_id,answer:source.run.answer,review:source.run.review});
};
export function validateIssueDraft(draft) {
  if (!draft || Object.keys(draft).sort().join(',') !== 'body,title' || typeof draft.title !== 'string' || typeof draft.body !== 'string'
    || draft.title.length < 5 || draft.title.length > 180 || draft.body.length < 40 || draft.body.length > 20000) fail('issue_draft_invalid');
  const text = `${draft.title}\n${draft.body}`;
  if (/\]\s*\(|^\s{0,3}\[[^\]]+\]:|<[^>]*>|(?:^|\s)\/\//m.test(text)) fail('issue_draft_link_markup');
  // Public issues contain technical findings, never internal identities or raw records.
  if (/Bearer\s|BEGIN .*PRIVATE KEY|(?:sk|ghp|gho)_[A-Za-z0-9]|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\bp\d{10,20}\b|\bev_[a-f0-9]{64}\b|\breq_\d{13}_|\bdpl_[A-Za-z0-9]+|<!--|!\[|<script|@(?:all|here|everyone)\b/i.test(text)) fail('issue_draft_private_data');
  for (const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s)\]>]+/gi)) {
    let url;
    try { url = new URL(match[0]); } catch { fail('issue_draft_external_link'); }
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search
      || (url.hash && !/^#L\d+(?:-L\d+)?$/.test(url.hash))
      || /%|\\|(?:^|\/)\.{1,2}(?:\/|$)/.test(match[0])
      || !/^\/merryAI-dev\/MYSCube\/(?:blob\/[a-f0-9]{40}\/[A-Za-z0-9_./-]+|issues\/[1-9]\d*)$/.test(url.pathname)) fail('issue_draft_external_link');
  }
  return {title:draft.title,body:draft.body};
}
export function issueMarker(caseId) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(caseId)) fail('issue_case_invalid');
  return `<!-- mysc-qa:${candidateHash({case_id:caseId,repository:REPO})} -->`;
}
function receipt(issue, draft, marker) {
  if (!issue || !Number.isSafeInteger(issue.number) || issue.number < 1 || issue.html_url !== `https://github.com/${REPO}/issues/${issue.number}`
    || issue.title !== draft.title || issue.body !== `${draft.body}\n\n${marker}` || issue.pull_request) fail('issue_readback_mismatch');
  return {number:issue.number,url:issue.html_url,body_hash:candidateHash(issue.body),verified_at:new Date().toISOString()};
}
/** Store CAS is authoritative. Once posting begins, an uncertain outcome may only be reconciled, never blindly re-posted. */
export async function deliverReviewedIssue({caseId,store,authorize,generateDraft,reviewDraft,github}) {
  const marker=issueMarker(caseId);
  let source=await authorize();
  if (source.run.status !== 'completed' || source.run.review?.accepted !== true) return {status:'waiting_for_reviewed_result'};
  const sourceHash=reviewedHash(source,caseId);
  let saved=await store.read();
  if (!saved) {
    const draft=validateIssueDraft(await generateDraft(source));
    source=await authorize();
    if (sourceHash !== reviewedHash(source,caseId)) fail('issue_source_changed');
    const review=await reviewDraft({source,draft});
    if (review?.accepted !== true || review?.public_safe !== true || !Array.isArray(review.findings) || review.findings.length) fail('issue_publication_review_rejected');
    source=await authorize();
    if (sourceHash !== reviewedHash(source,caseId)) fail('issue_source_changed');
    await store.compareAndSet(null,{status:'prepared',case_id:caseId,run_id:source.run.run_id,repository:REPO,source_hash:sourceHash,draft,draft_hash:candidateHash(draft),review,marker});
    saved=await store.read();
  }
  const record=saved.value;
  if (record.case_id!==caseId || record.repository!==REPO || record.source_hash!==sourceHash || record.marker!==marker || record.draft_hash!==candidateHash(record.draft)
    || record.review?.accepted!==true || record.review?.public_safe!==true || record.review.findings?.length!==0) fail('issue_delivery_binding_invalid');
  validateIssueDraft(record.draft);
  if (record.status==='published') {
    const verified=receipt(await github.get(record.receipt.number),record.draft,marker);
    return {status:'published',receipt:verified};
  }
  if (record.status==='posting') {
    const found=await github.find(marker);
    if (!found) return {status:'publication_outcome_unknown'};
    const verified=receipt(await github.get(found.number),record.draft,marker);
    if (!await store.compareAndSet(saved.version,{...record,status:'published',receipt:verified})) return {status:'receipt_persistence_conflict'};
    return {status:'published',receipt:verified};
  }
  if(record.status!=='prepared') fail('issue_delivery_state_invalid');
  if (sourceHash !== reviewedHash(await authorize(),caseId)) fail('issue_source_changed');
  const posting={...record,status:'posting',attempt_started_at:new Date().toISOString()};
  if(!await store.compareAndSet(saved.version,posting)) return {status:'owned_by_other_worker'};
  const owned=await store.read();
  // No retries of this mutation. A lost response is handled by the posting branch.
  const created=await github.create({title:record.draft.title,body:`${record.draft.body}\n\n${marker}`});
  const verified=receipt(await github.get(created.number),record.draft,marker);
  if (!await store.compareAndSet(owned.version,{...posting,status:'published',receipt:verified})) return {status:'receipt_persistence_conflict'};
  return {status:'published',receipt:verified};
}
