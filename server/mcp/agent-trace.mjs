import { createHash } from 'node:crypto';

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function createAgentTrace({ db, jobId, leaseId }) {
  let sequence = 0;
  let previousHash = '';
  return async (event) => {
    const payload = { version: 1, sequence, previousHash, recordedAt: new Date().toISOString(), event };
    const digest = hash(payload);
    await db.runTransaction(async (tx) => {
      const jobRef = db.doc(`settlement_agent_jobs/${jobId}`);
      const job = (await tx.get(jobRef)).data();
      if (job?.leaseId !== leaseId || job.leaseUntil <= Date.now()) throw new Error('trace_lease_expired');
      tx.create(db.doc(`${jobRef.path}/trace/${leaseId}-${String(sequence).padStart(6, '0')}`), { ...payload, hash: digest });
      tx.set(db.doc(`${jobRef.path}/trace_runs/${leaseId}`), { count: sequence + 1, hash: digest });
      tx.update(jobRef, { traceAnchor: { leaseId, count: sequence + 1, hash: digest } });
    });
    sequence++;
    previousHash = digest;
    return { sequence: payload.sequence, hash: digest };
  };
}

export function verifyAgentTrace(records, anchor) {
  if (!anchor || records.length !== anchor.count || records.at(-1)?.hash !== anchor.hash) return false;
  let previousHash = '';
  return records.every(({ hash: digest, ...payload }, index) => {
    if (payload.sequence !== index || payload.previousHash !== previousHash || hash(payload) !== digest) return false;
    previousHash = digest;
    return true;
  });
}
