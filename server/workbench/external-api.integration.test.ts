import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { createRegisteredApiService } from './registered-apis.mjs';
import { createExternalApiAdapter } from './external-api.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('external API registry with durable immutable receipts', () => {
  const db = new Firestore({ projectId: 'demo-external-registry' });
  const context = { tenantId: 'external-qa', actorId: 'admin', actorRole: 'admin', idempotencyKey: 'stable-request-key', analyticsScope: { datasetIds: [], fingerprint: 'scope-1' } };
  const root = db.doc(`orgs/${context.tenantId}`);
  const parameters = { month: { type: 'string', required: true, label: '조회 월', example: '2026-09' } };
  const endpoint = { id: 'approved-receipts', version: 1, name: '승인된 입금 API', description: '입금 조회', url: 'https://approved.example/receipts', allowedTenants: [context.tenantId], parameters,
    responseSchema: { type: 'object', additionalProperties: false, required: ['amount'], properties: { amount: { type: 'string', maxLength: 30, nullable: true } } }, auth: { type: 'header', header: 'X-Api-Key', secretEnv: 'WORKBENCH_EXTERNAL_SECRET_TEST' } };
  const env = { WORKBENCH_EXTERNAL_ENDPOINTS: JSON.stringify([endpoint]), WORKBENCH_EXTERNAL_SECRET_TEST: 'not-exported-secret' };
  const input = { expectedVersion: 0, definition: { kind: 'external-read', name: '내 입금 연결', description: '승인된 외부 연결 테스트', enabled: true, endpointId: endpoint.id, endpointVersion: 1, parameters } };
  let authorized = true; let response: any = { amount: null };
  const authorize = async () => { if (!authorized) throw Object.assign(new Error('revoked'), { statusCode: 403 }); };
  const adapter = createExternalApiAdapter({ env, resolveDns: async () => [{ address: '8.8.8.8', family: 4 }], transport: async () => response });
  const service = () => createRegisteredApiService({ db, authorize, analytics: { queryPlan: () => { throw new Error('must not reach analytics'); } }, externalAdapter: adapter });
  beforeEach(async () => { await db.recursiveDelete(root); authorized = true; response = { amount: null }; env.WORKBENCH_EXTERNAL_ENDPOINTS = JSON.stringify([endpoint]); });
  afterAll(async () => { await db.recursiveDelete(root); await db.terminate(); });
  it('atomically saves a definition and operation receipt, then replays the exact version without another API', async () => {
    const first = await service().save(context, null, input);
    const repeat = await service().save(context, null, input);
    expect(repeat).toEqual(first);
    expect((await service().list(context)).items).toHaveLength(1);
    const key = createHash('sha256').update(context.idempotencyKey).digest('hex');
    const receipt = (await root.collection('workbench_mutation_results').doc(key).get()).data();
    expect(receipt).toMatchObject({ kind: 'registered-api', apiId: first.id, version: 1, actorId: 'admin', scopeFingerprint: 'scope-1' });
    expect(await service().mutationResult(context)).toEqual(first);
    await expect(service().save(context, null, { ...input, definition: { ...input.definition, name: 'changed' } })).rejects.toMatchObject({ code: 'registered_api_operation_conflict' });
    await expect(service().mutationResult({ ...context, actorId: 'another' })).rejects.toMatchObject({ code: 'registered_api_operation_forbidden' });
  });
  it('returns schema-checked null/zero results, records outcomes without secrets/data and honors disable', async () => {
    const api = await service().save(context, null, input);
    expect(api.responseKind).toBe('external-read'); expect(api.responseSchema).toEqual(endpoint.responseSchema);
    expect((await service().invoke(context, api.id, 1, { month: '2026-09' })).data).toEqual({ amount: null });
    response = { amount: '0' };
    expect((await service().invoke(context, api.id, 1, { month: '2026-09' })).data).toEqual({ amount: '0' });
    const owner = createHash('sha256').update(JSON.stringify(context.actorId)).digest('hex');
    const calls = await root.collection('workbench_api_owners').doc(owner).collection('apis').doc(api.id).collection('calls').get();
    expect(calls.size).toBe(2);
    expect(calls.docs.every(doc => doc.data().state === 'completed')).toBe(true);
    expect(JSON.stringify(calls.docs.map(doc => doc.data()))).not.toContain('not-exported-secret');
    expect(calls.docs[0].data()).not.toHaveProperty('data');
    await service().save({ ...context, idempotencyKey: 'disable-request' }, api.id, { expectedVersion: 1, definition: { ...input.definition, enabled: false } });
    await expect(service().invoke(context, api.id, 1, { month: '2026-09' })).rejects.toMatchObject({ code: 'registered_api_disabled' });
    expect((await service().mutationResult({ ...context, idempotencyKey: 'disable-request' })).version).toBe(2);
  });
  it('refuses altered server endpoint versions and never returns a response after revoked authorization', async () => {
    const api = await service().save(context, null, input);
    env.WORKBENCH_EXTERNAL_ENDPOINTS = JSON.stringify([{ ...endpoint, description: 'changed without version bump' }]);
    await expect(service().get(context, api.id, 1)).rejects.toMatchObject({ code: 'registered_api_endpoint_changed' });
    env.WORKBENCH_EXTERNAL_ENDPOINTS = JSON.stringify([endpoint]);
    const revoking = createExternalApiAdapter({ env, resolveDns: async () => [{ address: '8.8.8.8', family: 4 }], transport: async () => { authorized = false; return { amount: '100' }; } });
    const boundary = createRegisteredApiService({ db, authorize, analytics: {}, externalAdapter: revoking });
    await expect(boundary.invoke(context, api.id, 1, { month: '2026-09' })).rejects.toMatchObject({ statusCode: 403 });
  });
  it('does not allow users to introduce endpoints, URLs, secrets or different parameter schemas', async () => {
    await expect(service().save(context, null, { ...input, definition: { ...input.definition, url: 'https://elsewhere.example/' } })).rejects.toMatchObject({ code: 'registered_api_invalid' });
    await expect(service().save(context, null, { ...input, definition: { ...input.definition, endpointId: 'not-approved' } })).rejects.toMatchObject({ code: 'external_endpoint_forbidden' });
    await expect(service().save(context, null, { ...input, definition: { ...input.definition, parameters: {} } })).rejects.toMatchObject({ code: 'registered_api_parameters_mismatch' });
    expect((await service().listEndpoints({ ...context, tenantId: 'unapproved' })).items).toEqual([]);
  });
});
