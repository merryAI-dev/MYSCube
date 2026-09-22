import { z } from 'zod';
import { reliabilityRequestContext } from './reliability-request-context.mjs';
import { OPERATION_KEYS, OPERATION_MODES, serverOutcome } from './reliability-model.mjs';

export function reliabilityResponseMiddleware({ service, environment, releaseSha, budgetMs = 250 }) {
  return (req, res, next) => {
    const context = reliabilityRequestContext({ method: req.method, path: req.originalUrl?.split('?')[0] || req.path, statusCode: 0 });
    const operationKey = context.operationKey;
    const operationId = req.header('x-operation-id');
    if (!OPERATION_KEYS.includes(operationKey) || !z.string().uuid().safeParse(operationId).success) return next();
    const mode = OPERATION_MODES.includes(req.header('x-operation-mode')) ? req.header('x-operation-mode') : 'unknown';
    const original = res.json.bind(res);
    let handled = false;
    res.json = (body) => {
      if (handled) return original(body);
      handled = true;
      let timer;
      let collectionFailed = false;
      const fail = () => {
        if (collectionFailed) return;
        collectionFailed = true;
        service.collectionFailed(req.context.tenantId);
        console.warn(JSON.stringify({ message: 'reliability.collection_unconfirmed', requestId: req.context.requestId, operationKey, environment }));
      };
      const collection = Promise.resolve().then(() => service.observe(req.context, {
        authority: 'server', operationId, operationKey, mode, environment,
        releaseSha: /^[a-f0-9]{40}$/i.test(releaseSha || '') ? releaseSha : null,
        requestId: req.context.requestId, ...serverOutcome(operationKey, res.statusCode, body),
      })).catch(fail);
      const deadline = new Promise((resolve) => { timer = setTimeout(() => { fail(); resolve(); }, budgetMs); });
      // Persist before releasing the response; an optional collector may add only a bounded delay.
      void Promise.race([collection, deadline]).then(() => {
        clearTimeout(timer);
        res.setHeader('x-observation-status', collectionFailed ? 'unconfirmed' : 'recorded');
        original(body);
      }).catch((error) => {
        clearTimeout(timer);
        next(error);
      });
      return res;
    };
    next();
  };
}
