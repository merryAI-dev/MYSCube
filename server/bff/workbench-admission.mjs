import { createHash, randomUUID } from 'node:crypto';
import { createHttpError } from './bff-utils.mjs';

const READ_ROUTES = new Set([
  'GET /api/v1/cashflow-evidence', 'GET /api/v1/cashflow-evidence/diagnostics',
  'GET /api/v1/insight-cashflow-report', 'POST /api/v1/qa-evidence/query',
]);
const MODEL_ROUTES = new Set(['page-proposal', 'cashflow', 'qa'].map((name) => `POST /api/v1/workbench-assistant/${name}`));

export function workbenchAdmissionKind(method, path) {
  const key = `${method} ${path}`;
  return READ_ROUTES.has(key) ? 'read' : MODEL_ROUTES.has(key) ? 'model' : null;
}

export function createWorkbenchAdmission({ db, clock = Date.now, actorLimit = 12, leaseMs = 90000 }) {
  return {
    async acquire(context) {
      const at = clock();
      const token = randomUUID();
      const base = `orgs/${context.tenantId}/personal_work_pages/_admission`;
      const slots = db.doc(`${base}/leases/active`);
      const actorHash = createHash('sha256').update(context.actorId).digest('hex');
      const usage = db.doc(`${base}/actors/${actorHash}`);
      await db.runTransaction(async (tx) => {
        const [slotDoc, usageDoc] = await Promise.all([tx.get(slots), tx.get(usage)]);
        const active = (slotDoc.data()?.active || []).filter((item) => item.expiresAt > at);
        if (active.length >= 2) throw createHttpError(429, '조회 요청이 많습니다. 잠시 후 다시 확인해 주세요. 기존 업무는 계속 이용할 수 있습니다.', 'workbench_busy');
        const previous = usageDoc.data();
        const withinWindow = previous && previous.windowStartedAt + 60000 > at;
        const count = withinWindow ? previous.count : 0;
        if (count >= actorLimit) throw createHttpError(429, '조회 요청 한도에 도달했습니다. 1분 후 다시 확인해 주세요.', 'workbench_rate_limited');
        tx.set(slots, { active: [...active, { token, expiresAt: at + leaseMs }] });
        tx.set(usage, { count: count + 1, windowStartedAt: withinWindow ? previous.windowStartedAt : at });
      });
      return { async release() {
        await db.runTransaction(async (tx) => {
          const current = (await tx.get(slots)).data()?.active || [];
          if (current.some((item) => item.token === token)) tx.set(slots, { active: current.filter((item) => item.token !== token) });
        });
      } };
    },
  };
}

async function bounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('admission_timeout')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export function workbenchAdmissionMiddleware({ service, readsEnabled = true, admissionMs = 1500, releaseMs = 300 }) {
  return async (req, res, next) => {
    const kind = workbenchAdmissionKind(req.method, (req.originalUrl || req.path).split('?')[0]);
    if (!kind) return next();
    if (kind === 'read' && !readsEnabled) return res.status(503).json({ error: 'workbench_reads_disabled', message: '추가 조회 기능을 잠시 중지했습니다. 기존 업무 화면을 이용해 주세요.' });
    let lease;
    try { lease = await bounded(service.acquire(req.context), admissionMs); }
    catch (error) {
      if (error.statusCode === 429) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: error.code, message: error.message }); }
      return res.status(503).json({ error: 'workbench_admission_unavailable', message: '추가 조회의 이용 상태를 확인하지 못했습니다. 기존 업무 화면은 계속 이용할 수 있습니다.' });
    }
    const original = res.json.bind(res);
    let releasing = false;
    res.json = (body) => {
      if (releasing) return res;
      releasing = true;
      // Release before responding: serverless execution may stop after response completion.
      void bounded(lease.release(), releaseMs).catch(() => {
        console.warn(JSON.stringify({ message: 'workbench.admission_release_unconfirmed', requestId: req.context.requestId }));
      }).then(() => original(body)).catch(next);
      return res;
    };
    // A disconnected client does not prove the underlying read stopped; keep the lease until expiry.
    next();
  };
}
