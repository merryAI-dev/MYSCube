import { createHash } from 'node:crypto';

const VERSION = 'binary-scope-l2-v1';
const sigmoid = (weight) => 1 / (1 + Math.exp(-weight));

export function feedbackLoss(weight, mean) {
  if (!Number.isFinite(weight) || !Number.isFinite(mean) || mean < 0 || mean > 1) throw new Error('Invalid loss input');
  return Math.max(weight, 0) + Math.log1p(Math.exp(-Math.abs(weight))) - mean * weight + weight ** 2 / 2;
}

// Host supplies reviewed scope-correctness labels, not arbitrary reactions or model output.
export function fitFeedback(samples) {
  if (!Array.isArray(samples) || samples.length > 10_000) throw new Error('Invalid feedback dataset');
  const unique = new Map();
  for (const sample of samples) {
    if (typeof sample?.id !== 'string' || !sample.id || sample.id.length > 200 || ![0, 1].includes(sample.value)) throw new Error('Invalid feedback');
    if (unique.has(sample.id) && unique.get(sample.id) !== sample.value) throw new Error('Conflicting feedback revision');
    unique.set(sample.id, sample.value);
  }
  const data = [...unique].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const mean = data.length ? data.reduce((sum, [, value]) => sum + value, 0) / data.length : 0.5;
  // lambda=1: J'=sigmoid(w)-mean+w, J''>=1. Unique root is in [-1,1].
  let low = -1;
  let high = 1;
  for (let step = 0; step < 60; step += 1) {
    const middle = (low + high) / 2;
    if (sigmoid(middle) - mean + middle < 0) low = middle;
    else high = middle;
  }
  const weight = mean === 0.5 ? 0 : (low + high) / 2;
  const probability = sigmoid(weight);
  return {
    version: VERSION, datasetHash: createHash('sha256').update(JSON.stringify([VERSION, data])).digest('hex'),
    count: data.length, weight, probability, loss: feedbackLoss(weight, mean),
    gradient: probability - mean + weight,
    needsClarification: mean < 0.5,
  };
}
