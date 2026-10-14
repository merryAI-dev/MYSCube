import { candidateHash } from './candidate-integrity.mjs';

export function projectIssueReceipt(record, qa, run) {
  if (!record || !qa || !run || record.status !== 'published' || run.status !== 'completed'
    || run.review?.accepted !== true || record.case_id !== qa.case_id || record.run_id !== run.run_id
    || record.repository !== 'merryAI-dev/MYSCube' || record.review?.accepted !== true
    || record.review?.public_safe !== true || record.review?.findings?.length !== 0) return null;
  const inputHash = candidateHash({ actor_id: qa.actor_id, aggregate_version: qa.aggregate_version,
    title: qa.title, description: qa.description, investigation_scope: qa.investigation_scope });
  if (run.case_id !== qa.case_id || run.case_actor_id !== qa.actor_id
    || run.case_aggregate_version !== qa.aggregate_version || run.case_input_hash !== inputHash) return null;
  const sourceHash = candidateHash({ case_id: qa.case_id, case_input_hash: inputHash,
    run_id: run.run_id, answer: run.answer, review: run.review });
  if (record.source_hash !== sourceHash || !record.draft || typeof record.draft.title !== 'string'
    || typeof record.draft.body !== 'string' || record.draft_hash !== candidateHash(record.draft)) return null;
  const marker = `<!-- mysc-qa:${candidateHash({ case_id: qa.case_id, repository: record.repository })} -->`;
  const receipt = record.receipt;
  if (record.marker !== marker || !Number.isSafeInteger(receipt?.number) || receipt.number < 1
    || receipt.url !== `https://github.com/merryAI-dev/MYSCube/issues/${receipt.number}`
    || receipt.body_hash !== candidateHash(`${record.draft.body}\n\n${marker}`)
    || !Number.isFinite(Date.parse(receipt.verified_at))) return null;
  return { number: receipt.number, url: receipt.url, verified_at: receipt.verified_at };
}
