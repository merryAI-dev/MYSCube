import { describe, expect, it, vi } from 'vitest';
import { selectRemoteApiBudgets, mountRemotePreview } from './remote-preview-routes.mjs';
import { checkApiBudgets } from './remote-runtime/contract.mjs';

const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const record = { id, version: 4, definition: { enabled: true, kind: 'external-read', endpointId: 'myscube-company-cashflow-summary', endpointVersion: 1 } };
const env = { WORKBENCH_MYSCUBE_COMPANY_SUMMARY_ENABLED: 'true' };
describe('server-selected remote API budgets', () => {
  it('issues 55 seconds only for the exact enabled company endpoint and explicit server switch', () => {
    expect(selectRemoteApiBudgets([record], env)).toEqual({ [id]: 55000 });
    for (const override of [{ enabled: false }, { kind: 'analytics-copy' }, { endpointId: 'myscube-cashflow-evidence' }, { endpointId: 'myscube-company-cashflow-summary-extra' }, { endpointVersion: 2 }]) {
      expect(selectRemoteApiBudgets([{ ...record, definition: { ...record.definition, ...override } }], env)).toEqual({ [id]: 10000 });
    }
    for (const flag of [undefined, 'false', true, 'TRUE']) expect(selectRemoteApiBudgets([record], { WORKBENCH_MYSCUBE_COMPANY_SUMMARY_ENABLED: flag })).toEqual({ [id]: 10000 });
    expect(selectRemoteApiBudgets([{ id, version: 1, endpointId: record.definition.endpointId, apiMs: 55000 }], env)).toEqual({ [id]: 10000 });
  });
  it('requires the whole exact selected API set and rejects arbitrary budgets, prototypes and keys', () => {
    for (const value of [null, [], { [id]: 55001 }, { [id]: '55000' }, { [id]: Infinity }, {}, { [id]: 55000, [other]: 10000 }, Object.create({ [id]: 55000 })]) expect(() => checkApiBudgets(value, [id])).toThrow(/조회 시간/);
    for (const ids of [[id, id], ['../api'], Array(13).fill(id)]) expect(() => checkApiBudgets(undefined, ids)).toThrow();
    expect(() => checkApiBudgets({ [id]: 55000 }, [])).toThrow();
  });
  it('copies and freezes issued budgets and defaults legacy bindings to 10 seconds', () => {
    const raw = { [id]: 55000 }; const checked = checkApiBudgets(raw, [id]); raw[id] = 10000;
    expect(checked[id]).toBe(55000); expect(Object.isFrozen(checked)).toBe(true);
    expect(checkApiBudgets(undefined, [id])).toEqual({ [id]: 10000 });
  });
});


it('does not attach late evidence to a closed or timed-out remote session', async () => {
  let callApi, finish;
  const app = { post: vi.fn(), get: vi.fn(), delete: vi.fn() };
  const broker = mountRemotePreview(app, { db: {}, env: { WORKBENCH_REMOTE_RUNTIME_ENABLED: 'true' }, core: { authorize: async () => {} }, pages: {},
    apis: { invoke: async () => new Promise(resolve => { finish = resolve; }) }, asyncHandler: value => value,
    brokerFactory: options => { callApi = options.callApi; return { closeAll() {} }; },
  });
  try {
    const context = { remoteEvidence: {} }, controller = new AbortController();
    const result = callApi(context, { apiId: id, apiVersion: 1, input: {}, signal: controller.signal });
    controller.abort(); finish({ evidenceId: 'late-private-evidence' });
    await expect(result).rejects.toMatchObject({ code: 'remote_api_timeout' }); expect(context.remoteEvidence).toEqual({});
  } finally { broker.shutdown(); }
});
