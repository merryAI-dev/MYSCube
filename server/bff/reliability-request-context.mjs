import { classifyProjectOperation } from '../../shared/product-operations.mjs';

export function reliabilityRequestContext({ method, path, statusCode, deployEnvironment, release }) {
  const operation = classifyProjectOperation(method, path);
  if (!operation) return {};
  // HTTP acknowledgement is not proof of a completed user task or downstream work.
  const requestOutcome = statusCode === 202 ? 'accepted_pending'
    : statusCode >= 200 && statusCode < 300 ? 'http_acknowledged'
      : statusCode >= 500 ? 'server_error'
        : statusCode >= 400 ? 'request_rejected' : 'unclassified';
  return {
    observationSchemaVersion: 1,
    operationKey: operation,
    measurementScope: 'http_request',
    requestOutcome,
    deployEnvironment: ['live', 'preview', 'local'].includes(deployEnvironment) ? deployEnvironment : 'unknown',
    releaseSha: typeof release === 'string' && /^[a-f0-9]{40}$/i.test(release) ? release : null,
  };
}
