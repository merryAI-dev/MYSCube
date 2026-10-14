import { createHash } from "node:crypto";

function canonical(value) {
  return Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
}

// Content binding only. Authorization and server-owned storage establish trust.
export const candidateHash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

export function verificationMatchesCandidate(record, candidate) {
  if (!record || !candidate) return false;
  const { record_hash, ...body } = record;
  return (
    record_hash === candidateHash(body) &&
    record.candidate_hash === candidateHash(candidate) &&
    record.candidate_id === candidate.candidate_id &&
    record.verification?.candidate_id === candidate.candidate_id &&
    record.verification?.verdict === candidate.proposed_verdict
  );
}
