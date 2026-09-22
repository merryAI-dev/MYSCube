import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { createHttpError } from './bff-utils.mjs';
import { insightPageConfig } from '../../shared/insight-page.mjs';

const uuid = z.string().uuid();
const legacyWorkPageConfig = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  source: z.enum(['cashflow-evidence', 'service-guidance']),
  presentation: z.enum(['table', 'cards']),
  yearMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
  search: z.string().trim().max(100),
}).strict();
export const workPageConfig = z.union([legacyWorkPageConfig, insightPageConfig]);
const saveInput = z.object({ expectedVersion: z.number().int().min(0), config: workPageConfig }).strict();
const versionInput = z.object({ expectedVersion: z.number().int().min(1) }).strict();
const restoreInput = versionInput.extend({ version: z.number().int().min(1) }).strict();
const parse = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) throw createHttpError(400, '페이지 제목·조회 기간과 지원되는 구성인지 확인해 주세요.', 'work_page_invalid');
  return result.data;
};

export function createPersonalWorkPageService({ db, now = () => new Date().toISOString() }) {
  const ownerKey = (context) => createHash('sha256').update(context.actorId).digest('hex');
  const pages = (context) => db.collection(`orgs/${context.tenantId}/personal_work_pages/${ownerKey(context)}/pages`);
  const refFor = (context, id) => pages(context).doc(parse(uuid, id));
  const assertVersion = (old, expectedVersion) => {
    if (!old || old.deletedAt) throw createHttpError(404, '내 업무 페이지를 찾을 수 없습니다.', 'work_page_not_found');
    if (old.version !== expectedVersion) throw createHttpError(409, '다른 창에서 저장한 버전이 있습니다. 내 입력을 복사한 뒤 최신 버전을 열어 비교해 주세요.', 'work_page_conflict');
  };
  const revision = (context, id, old, config, restoredFrom = null) => ({ id, config, version: (old?.version || 0) + 1,
    createdAt: old?.createdAt || now(), updatedAt: now(), updatedBy: context.actorId, restoredFrom, deletedAt: null });
  return {
    async list(context) {
      const result = await pages(context).where('deletedAt', '==', null).limit(101).get();
      return { items: result.docs.slice(0, 100).map((doc) => doc.data()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), truncated: result.size > 100 };
    },
    async get(context, id) {
      const value = (await refFor(context, id).get()).data();
      assertVersion(value, value?.version);
      return value;
    },
    async history(context, id) {
      await this.get(context, id);
      const result = await refFor(context, id).collection('versions').orderBy('version', 'desc').limit(101).get();
      return { items: result.docs.slice(0, 100).map((doc) => doc.data()), truncated: result.size > 100 };
    },
    async save(context, id, input) {
      const { expectedVersion, config } = parse(saveInput, input);
      if (!id && expectedVersion !== 0) throw createHttpError(400, '새 페이지의 시작 버전을 확인해 주세요.', 'work_page_invalid');
      const pageId = id || randomUUID();
      const ref = refFor(context, pageId);
      return db.runTransaction(async (tx) => {
        const old = (await tx.get(ref)).data();
        if (id) assertVersion(old, expectedVersion);
        else if (old) throw createHttpError(409, '페이지를 다시 저장해 주세요.', 'work_page_conflict');
        const value = revision(context, pageId, old, config);
        tx.set(ref, value);
        tx.create(ref.collection('versions').doc(String(value.version)), value);
        return value;
      });
    },
    async restore(context, id, input) {
      const { expectedVersion, version } = parse(restoreInput, input);
      const ref = refFor(context, id);
      return db.runTransaction(async (tx) => {
        const [current, previous] = await Promise.all([tx.get(ref), tx.get(ref.collection('versions').doc(String(version)))]);
        const old = current.data();
        assertVersion(old, expectedVersion);
        if (!previous.exists) throw createHttpError(404, '저장 버전을 찾을 수 없습니다.', 'work_page_version_not_found');
        const config = parse(workPageConfig, previous.data().config);
        const value = revision(context, id, old, config, version);
        tx.set(ref, value);
        tx.create(ref.collection('versions').doc(String(value.version)), value);
        return value;
      });
    },
    async remove(context, id, input) {
      const { expectedVersion } = parse(versionInput, input);
      const ref = refFor(context, id);
      return db.runTransaction(async (tx) => {
        const old = (await tx.get(ref)).data();
        assertVersion(old, expectedVersion);
        const value = { ...old, version: old.version + 1, updatedAt: now(), updatedBy: context.actorId, deletedAt: now() };
        tx.set(ref, value);
        tx.create(ref.collection('versions').doc(String(value.version)), value);
        return { ok: true };
      });
    },
  };
}

export function mountPersonalWorkPageRoutes(app, { db, now, asyncHandler, createMutatingRoute, idempotencyService }) {
  const service = createPersonalWorkPageService({ db, now });
  const prefix = '/api/v1/personal-work-pages';
  app.get(prefix, asyncHandler(async (req, res) => res.json(await service.list(req.context))));
  app.get(`${prefix}/:id`, asyncHandler(async (req, res) => res.json(await service.get(req.context, req.params.id))));
  app.get(`${prefix}/:id/versions`, asyncHandler(async (req, res) => res.json(await service.history(req.context, req.params.id))));
  app.post(prefix, createMutatingRoute(idempotencyService, async (req) => ({ status: 201, body: await service.save(req.context, null, req.body) })));
  app.put(`${prefix}/:id`, createMutatingRoute(idempotencyService, async (req) => ({ status: 200, body: await service.save(req.context, req.params.id, req.body) })));
  app.post(`${prefix}/:id/restore`, createMutatingRoute(idempotencyService, async (req) => ({ status: 200, body: await service.restore(req.context, req.params.id, req.body) })));
  app.delete(`${prefix}/:id`, createMutatingRoute(idempotencyService, async (req) => ({ status: 200, body: await service.remove(req.context, req.params.id, req.body) })));
}
